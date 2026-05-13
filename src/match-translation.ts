// $match expression-body → query-language translator.
//
// Translates the subset of expression bodies that MongoDB's query language
// can represent directly, so $match emits an index-friendly shape instead of
// always wrapping in $expr (which disables index usage). Untranslatable parts
// of the expression are returned as a `residual` that the caller wraps in
// $expr — yielding `{ $match: { <translated>, $expr: <residual> } }`, which
// keeps the planner using indexes on the translatable half.
//
// Known semantic divergences between query-language and aggregation $eq are
// documented in `docs/specs/match-query-translation.md`. Users who need
// strict aggregation semantics opt out via the existing object-literal
// passthrough: `$match({ $expr: <expr> })`.
//
// This module is pure — no MQL knowledge beyond what's encoded here, no
// reach-into-codegen for leaves. Residual sub-expressions get handed back
// as Expr nodes; the caller re-enters `generate()` on them.

import type { Expr, BinaryOp } from "./ast.ts";

export type MatchTranslation = {
  /** The translated query-language fragment. Empty when nothing translated. */
  query: Record<string, unknown>;
  /** Remaining expression that couldn't be translated. Null when fully translated. */
  residual: Expr | null;
};

/**
 * Optional context passed in by the pipeline lowerer. `bindings` lets the
 * translator treat function-form parameter references as literals — the
 * `ParamRef` node still says "param x", but its value at this codegen call
 * is a compile-time constant from `jsmql.compile(fn)(params)`. Without this
 * hook the index-friendly path can't see across the binding and would emit
 * `$expr` for every comparison that touches a parameter.
 */
export type TranslateCtx = {
  bindings?: ReadonlyMap<string, unknown>;
};

export function translateMatchBody(body: Expr, ctx: TranslateCtx = {}): MatchTranslation {
  return translate(body, ctx);
}

function translate(expr: Expr, ctx: TranslateCtx): MatchTranslation {
  if (expr.type === "BinaryExpr" && expr.op === "&&") {
    return combineAnd(translate(expr.left, ctx), translate(expr.right, ctx));
  }
  if (expr.type === "BinaryExpr" && expr.op === "||") {
    return combineOr(translate(expr.left, ctx), translate(expr.right, ctx), expr);
  }
  const leaf = translateLeaf(expr, ctx);
  if (leaf === null) return { query: {}, residual: expr };
  return { query: leaf, residual: null };
}

function combineAnd(left: MatchTranslation, right: MatchTranslation): MatchTranslation {
  return {
    query: mergeQuery(left.query, right.query),
    residual: combineResidualsAnd(left.residual, right.residual),
  };
}

function combineOr(
  left: MatchTranslation,
  right: MatchTranslation,
  original: Expr,
): MatchTranslation {
  // $or can't carry a residual — mixing index-using $or branches with a
  // disjoint $expr would lose the disjunction guarantee. If either branch
  // has anything residual or empty, the whole `||` becomes residual.
  if (left.residual !== null || right.residual !== null) {
    return { query: {}, residual: original };
  }
  if (isEmpty(left.query) || isEmpty(right.query)) {
    return { query: {}, residual: original };
  }
  return { query: { $or: [left.query, right.query] }, residual: null };
}

function mergeQuery(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  if (isEmpty(a)) return b;
  if (isEmpty(b)) return a;
  const collision = Object.keys(b).some((k) => k in a);
  if (!collision) return { ...a, ...b };
  // Key collision (e.g. `$.a > 1 && $.a < 5`): fall back to $and. Flatten when
  // one side is already an $and-only doc so we don't nest $ands unnecessarily.
  const leftItems = isAndOnly(a) ? (a.$and as unknown[]) : [a];
  const rightItems = isAndOnly(b) ? (b.$and as unknown[]) : [b];
  return { $and: [...leftItems, ...rightItems] };
}

function isAndOnly(q: Record<string, unknown>): boolean {
  const keys = Object.keys(q);
  return keys.length === 1 && keys[0] === "$and" && Array.isArray(q.$and);
}

function isEmpty(q: Record<string, unknown>): boolean {
  return Object.keys(q).length === 0;
}

function combineResidualsAnd(a: Expr | null, b: Expr | null): Expr | null {
  if (a === null) return b;
  if (b === null) return a;
  return { type: "BinaryExpr", op: "&&", left: a, right: b };
}

function translateLeaf(expr: Expr, ctx: TranslateCtx): Record<string, unknown> | null {
  if (expr.type !== "BinaryExpr") return null;
  const op = expr.op;
  if (isEqualityOp(op)) {
    return translateEquality(expr.left, expr.right, op, ctx);
  }
  if (isOrderedOp(op)) {
    return translateOrderedCompare(expr.left, expr.right, op, ctx);
  }
  return null;
}

function translateEquality(
  left: Expr,
  right: Expr,
  op: "===" | "==" | "!==" | "!=",
  ctx: TranslateCtx,
): Record<string, unknown> | null {
  // `==` / `!=` are restricted to comparisons against null (loose null check).
  // Validation lives in codegen — here we just don't translate them so the
  // body falls through to $expr, which then surfaces the codegen error.
  if (op === "==" || op === "!=") {
    if (left.type !== "NullLiteral" && right.type !== "NullLiteral") return null;
    return translateLooseNull(left, right, op);
  }
  // Strict equality (`===` / `!==`) against null gets `$type: "null"` so the
  // match excludes missing-field docs, matching JS semantics.
  if (left.type === "NullLiteral" || right.type === "NullLiteral") {
    return translateStrictNull(left, right, op);
  }
  const oriented = orientFieldLiteral(left, right, (e) => anyEqualityLiteral(e, ctx));
  if (oriented === null) return null;
  const { field, value } = oriented;
  if (op === "===") return { [field]: value };
  return { [field]: { $ne: value } };
}

function translateLooseNull(
  left: Expr,
  right: Expr,
  op: "==" | "!=",
): Record<string, unknown> | null {
  const fieldExpr = left.type === "NullLiteral" ? right : left;
  const field = asFieldPath(fieldExpr);
  if (field === null) return null;
  // Query language `{ field: null }` already matches null OR missing, which is
  // exactly the loose semantics. Keep the index-friendly shape unchanged.
  if (op === "==") return { [field]: null };
  return { [field]: { $ne: null } };
}

function translateStrictNull(
  left: Expr,
  right: Expr,
  op: "===" | "!==",
): Record<string, unknown> | null {
  const fieldExpr = left.type === "NullLiteral" ? right : left;
  const field = asFieldPath(fieldExpr);
  if (field === null) return null;
  // `$type: "null"` matches only docs where the field is the BSON null type —
  // missing fields are excluded, matching JS strict equality.
  if (op === "===") return { [field]: { $type: "null" } };
  return { [field]: { $not: { $type: "null" } } };
}

function translateOrderedCompare(
  left: Expr,
  right: Expr,
  op: ">" | ">=" | "<" | "<=",
  ctx: TranslateCtx,
): Record<string, unknown> | null {
  const leftField = asFieldPath(left);
  const rightField = asFieldPath(right);
  let field: string;
  let value: unknown;
  let effectiveOp: ">" | ">=" | "<" | "<=" = op;
  if (leftField !== null && rightField === null) {
    const lit = anyOrderedLiteral(right, ctx);
    if (lit === null) return null;
    field = leftField;
    value = lit.value;
  } else if (leftField === null && rightField !== null) {
    const lit = anyOrderedLiteral(left, ctx);
    if (lit === null) return null;
    field = rightField;
    value = lit.value;
    effectiveOp = flipOrderedOp(op);
  } else {
    return null;
  }
  return { [field]: { [orderedOpToMql(effectiveOp)]: value } };
}

function orientFieldLiteral(
  left: Expr,
  right: Expr,
  getLit: (e: Expr) => { value: unknown } | null,
): { field: string; value: unknown } | null {
  const leftField = asFieldPath(left);
  if (leftField !== null) {
    const rightLit = getLit(right);
    if (rightLit !== null) return { field: leftField, value: rightLit.value };
  }
  const rightField = asFieldPath(right);
  if (rightField !== null) {
    const leftLit = getLit(left);
    if (leftLit !== null) return { field: rightField, value: leftLit.value };
  }
  return null;
}

function isEqualityOp(op: BinaryOp): op is "===" | "==" | "!==" | "!=" {
  return op === "===" || op === "==" || op === "!==" || op === "!=";
}

function isOrderedOp(op: BinaryOp): op is ">" | ">=" | "<" | "<=" {
  return op === ">" || op === ">=" || op === "<" || op === "<=";
}

function orderedOpToMql(op: ">" | ">=" | "<" | "<="): string {
  if (op === ">") return "$gt";
  if (op === ">=") return "$gte";
  if (op === "<") return "$lt";
  return "$lte";
}

function flipOrderedOp(op: ">" | ">=" | "<" | "<="): ">" | ">=" | "<" | "<=" {
  if (op === ">") return "<";
  if (op === ">=") return "<=";
  if (op === "<") return ">";
  return ">=";
}

/**
 * Accept any primitive literal jsmql can compare with `===` / `!==`. Arrays,
 * regexes, and BigInts are deliberately excluded:
 *   - Array literals would trigger query-language array-element matching, a
 *     semantic divergence too sharp to apply silently.
 *   - Regex literals belong in `.match()` / `.test()`; raw regex equality
 *     isn't a thing in jsmql today.
 *   - BigInt literals compile to `{ $toLong: "..." }` in aggregation form,
 *     which the query language doesn't recognise as a value.
 */
function anyEqualityLiteral(expr: Expr, ctx: TranslateCtx): { value: unknown } | null {
  switch (expr.type) {
    case "NumberLiteral":
      return { value: expr.value };
    case "StringLiteral":
      return { value: expr.value };
    case "BooleanLiteral":
      return { value: expr.value };
    case "NullLiteral":
      return { value: null };
    case "ParamRef":
      return paramRefAsLiteral(expr, ctx, /*orderedOnly*/ false);
    default:
      return null;
  }
}

/**
 * Ordered comparisons (`>`, `<`, `>=`, `<=`) only make sense against numbers
 * and strings. Booleans and nulls are almost certainly user bugs in this
 * position — let them fall through to $expr so the (rare) intentional case
 * still works.
 */
function anyOrderedLiteral(expr: Expr, ctx: TranslateCtx): { value: unknown } | null {
  switch (expr.type) {
    case "NumberLiteral":
      return { value: expr.value };
    case "StringLiteral":
      return { value: expr.value };
    case "ParamRef":
      return paramRefAsLiteral(expr, ctx, /*orderedOnly*/ true);
    default:
      return null;
  }
}

/**
 * If a `ParamRef` resolves to a function-form parameter binding, return its
 * substituted value as if it were a literal. The `orderedOnly` flag keeps the
 * type-divergence rules from `anyOrderedLiteral` honest: booleans and nulls
 * are almost certainly user bugs when used as `>` / `<` operands, so we let
 * them fall through to `$expr` instead of silently translating.
 */
function paramRefAsLiteral(
  expr: Expr & { type: "ParamRef" },
  ctx: TranslateCtx,
  orderedOnly: boolean,
): { value: unknown } | null {
  if (!ctx.bindings?.has(expr.name)) return null;
  const value = ctx.bindings.get(expr.name);
  if (orderedOnly) {
    if (typeof value !== "number" && typeof value !== "string") return null;
  } else {
    // Equality-side: accept the same primitives the literal-AST path accepts,
    // and refuse arrays/objects (their `==` semantics in MQL query language
    // diverge sharply from JS).
    const ok =
      value === null ||
      typeof value === "number" ||
      typeof value === "string" ||
      typeof value === "boolean";
    if (!ok) return null;
  }
  return { value };
}

/**
 * Reconstruct a MongoDB field path string from `$.a.b.c`-style AST chains.
 * Matches the (private) logic in codegen.ts:asFieldPath, but returns the bare
 * dotted path without the leading `$` — query-document keys use field names,
 * not aggregation field references.
 *
 * Returns null for anything that isn't a static field path: index access,
 * method calls, lambda param refs, operator calls, etc.
 */
function asFieldPath(expr: Expr): string | null {
  if (expr.type === "FieldRef") return expr.path;
  if (expr.type === "MemberAccess") {
    const base = asFieldPath(expr.object);
    if (base !== null) return `${base}.${expr.member}`;
  }
  return null;
}
