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
import { isOpaqueBsonValue } from "./codegen.ts";

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
export type TranslateCtx = { bindings?: ReadonlyMap<string, unknown> };

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
  return { query: mergeQuery(left.query, right.query), residual: combineResidualsAnd(left.residual, right.residual) };
}

function combineOr(left: MatchTranslation, right: MatchTranslation, original: Expr): MatchTranslation {
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

/**
 * Merge two query-document fragments so that **only colliding field names**
 * are pushed into `$and` — non-colliding fields stay at the top level where
 * MongoDB's planner can use indexes on them directly.
 *
 * Worked example: `$.customerId === "cust_42" && $.placedAt >= "2026-01-01"
 * && $.placedAt < "2026-02-01" && $.status === "shipped"` should produce
 *
 *     {
 *       customerId: "cust_42",
 *       $and: [
 *         { placedAt: { $gte: "2026-01-01" } },
 *         { placedAt: { $lt: "2026-02-01" } },
 *       ],
 *       status: "shipped",
 *     }
 *
 * — `customerId` and `status` stay top-level (one occurrence each), the two
 * `placedAt` predicates fold into `$and`. Without this, the planner can't
 * use indexes on the non-colliding fields when they're trapped inside `$and`
 * alongside the collision pair.
 *
 * Algorithm: flatten both inputs into an ordered list of `(key, value)`
 * clauses (expanding any pre-existing `$and` element into its constituent
 * single-key clauses); count occurrences per key; emit a clause at the top
 * level when its key occurs once, or push it into a freshly-created `$and`
 * when its key collides. `$and` is inserted at the position of the FIRST
 * colliding key so the output's key order follows the source order.
 */
function mergeQuery(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  if (isEmpty(a)) return b;
  if (isEmpty(b)) return a;

  type Clause = { key: string; value: unknown };
  const clauses: Clause[] = [];
  const collect = (doc: Record<string, unknown>) => {
    for (const k of Object.keys(doc)) {
      if (k === "$and" && Array.isArray(doc[k])) {
        for (const inner of doc[k] as Record<string, unknown>[]) {
          for (const ik of Object.keys(inner)) {
            clauses.push({ key: ik, value: inner[ik] });
          }
        }
      } else {
        clauses.push({ key: k, value: doc[k] });
      }
    }
  };
  collect(a);
  collect(b);

  const counts = new Map<string, number>();
  for (const c of clauses) counts.set(c.key, (counts.get(c.key) ?? 0) + 1);

  const out: Record<string, unknown> = {};
  let andClauses: Record<string, unknown>[] | null = null;
  for (const c of clauses) {
    if ((counts.get(c.key) ?? 0) > 1) {
      if (andClauses === null) {
        andClauses = [];
        // Inserting `$and` at this position pins it between the surrounding
        // single-key clauses in source order, so the output reads top-to-
        // bottom the way the user wrote the original `&&` chain.
        out.$and = andClauses;
      }
      andClauses.push({ [c.key]: c.value });
    } else {
      out[c.key] = c.value;
    }
  }
  return out;
}

function isEmpty(q: Record<string, unknown>): boolean {
  return Object.keys(q).length === 0;
}

function combineResidualsAnd(a: Expr | null, b: Expr | null): Expr | null {
  if (a === null) return b;
  if (b === null) return a;
  return { type: "BinaryExpr", op: "&&", left: a, right: b, pos: a.pos };
}

function translateLeaf(expr: Expr, ctx: TranslateCtx): Record<string, unknown> | null {
  if (expr.type !== "BinaryExpr") return null;
  const op = expr.op;
  if (isEqualityOp(op)) {
    // Peephole: `typeof $.field === "<alias>"` → `{ field: { $type: "<alias>" } }`.
    // Tried before the generic equality path so the field-path-and-literal
    // orientation logic doesn't see the `typeof` wrapper.
    if (op === "===" || op === "!==") {
      const typed = translateTypeofPredicate(expr.left, expr.right, op);
      if (typed !== null) return typed;
    }
    return translateEquality(expr.left, expr.right, op, ctx);
  }
  if (isOrderedOp(op)) {
    return translateOrderedCompare(expr.left, expr.right, op, ctx);
  }
  return null;
}

/**
 * BSON type aliases accepted by MongoDB's `$type` query operator. Restricting
 * the peephole to this set avoids emitting a query that MongoDB would reject
 * at parse time. "number" is included because MQL accepts it as a synonym for
 * the int/long/double/decimal group in the query-doc form (even though the
 * aggregation `$type` expression never *returns* "number").
 */
const BSON_TYPE_ALIASES: ReadonlySet<string> = new Set([
  "double",
  "string",
  "object",
  "array",
  "binData",
  "undefined",
  "objectId",
  "bool",
  "date",
  "null",
  "regex",
  "dbPointer",
  "javascript",
  "symbol",
  "javascriptWithScope",
  "int",
  "timestamp",
  "long",
  "decimal",
  "minKey",
  "maxKey",
  "number",
]);

function translateTypeofPredicate(left: Expr, right: Expr, op: "===" | "!=="): Record<string, unknown> | null {
  const oriented = orientTypeofAndString(left, right);
  if (oriented === null) return null;
  const { field, alias } = oriented;
  if (!BSON_TYPE_ALIASES.has(alias)) return null;
  if (op === "===") return { [field]: { $type: alias } };
  return { [field]: { $not: { $type: alias } } };
}

function orientTypeofAndString(left: Expr, right: Expr): { field: string; alias: string } | null {
  const lt = asTypeofFieldPath(left);
  if (lt !== null && right.type === "StringLiteral") {
    return { field: lt, alias: right.value };
  }
  const rt = asTypeofFieldPath(right);
  if (rt !== null && left.type === "StringLiteral") {
    return { field: rt, alias: left.value };
  }
  return null;
}

function asTypeofFieldPath(expr: Expr): string | null {
  if (expr.type !== "TypeofExpr") return null;
  return asFieldPath(expr.operand);
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

function translateLooseNull(left: Expr, right: Expr, op: "==" | "!="): Record<string, unknown> | null {
  const fieldExpr = left.type === "NullLiteral" ? right : left;
  const field = asFieldPath(fieldExpr);
  if (field === null) return null;
  // Query language `{ field: null }` already matches null OR missing, which is
  // exactly the loose semantics. Keep the index-friendly shape unchanged.
  if (op === "==") return { [field]: null };
  return { [field]: { $ne: null } };
}

function translateStrictNull(left: Expr, right: Expr, op: "===" | "!=="): Record<string, unknown> | null {
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
 *
 * `NewDate` (and `Date.UTC` inside `new Date(...)`) is accepted *when its
 * arguments are all compile-time literals* — the value is then folded to a
 * real JS `Date` instance. The aggregation form `{ $toDate: "..." }` is NOT
 * accepted as a query-doc value, because MongoDB's query language treats it
 * as a literal subdocument key, not an evaluable expression.
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
    case "NewDate":
      return evaluateStaticDate(expr);
    default:
      return null;
  }
}

/**
 * Ordered comparisons (`>`, `<`, `>=`, `<=`) only make sense against numbers,
 * strings, and dates. Booleans and nulls are almost certainly user bugs in
 * this position — let them fall through to $expr so the (rare) intentional
 * case still works. `NewDate` with all-literal args folds to a `Date` value,
 * which BSON compares as a date — index-friendly form for the common
 * `$.createdAt >= new Date("…")` pattern.
 */
function anyOrderedLiteral(expr: Expr, ctx: TranslateCtx): { value: unknown } | null {
  switch (expr.type) {
    case "NumberLiteral":
      return { value: expr.value };
    case "StringLiteral":
      return { value: expr.value };
    case "ParamRef":
      return paramRefAsLiteral(expr, ctx, /*orderedOnly*/ true);
    case "NewDate":
      return evaluateStaticDate(expr);
    default:
      return null;
  }
}

/**
 * Compile-time-evaluate a `new Date(...)` (or `new Date(Date.UTC(...))`) when
 * all arguments are themselves number/string literals. Returns the resulting
 * `Date` so the translator can place it directly as a query-doc value —
 * MongoDB's driver and shell both accept BSON `Date` instances on the RHS of
 * `$gte` / `$gt` / `$lt` / `$lte` / equality, which is what makes the index
 * usable.
 *
 * Cases that intentionally fall through to `$expr` (return null):
 *   - `new Date()` — codegens to `{ $toDate: "$$NOW" }` and must evaluate at
 *     query time. Folding at compile time would silently freeze the timestamp
 *     the user expected to be "now-when-this-query-runs".
 *   - any non-literal argument (field ref, operator call, method call, …) —
 *     can't be evaluated without runtime data.
 *   - any combination that produces `Invalid Date` — surface as `$expr` so
 *     the failure is visible at query time rather than as a silently bogus
 *     filter that matches nothing.
 */
function evaluateStaticDate(expr: Expr & { type: "NewDate" }): { value: Date } | null {
  const args = expr.args;
  if (args.length === 0) return null;
  if (args.length === 1) {
    const arg = args[0];
    if (arg.type === "DateUTC") {
      const utcArgs = staticNumberArgs(arg.args);
      if (utcArgs === null) return null;
      const ms = (Date.UTC as (...a: number[]) => number)(...utcArgs);
      return finalizeDate(new Date(ms));
    }
    if (arg.type === "NumberLiteral") return finalizeDate(new Date(arg.value));
    if (arg.type === "StringLiteral") return finalizeDate(new Date(arg.value));
    return null;
  }
  const numericArgs = staticNumberArgs(args);
  if (numericArgs === null) return null;
  return finalizeDate(new Date(...(numericArgs as [number, number, ...number[]])));
}

function staticNumberArgs(args: Expr[]): number[] | null {
  const out: number[] = [];
  for (const a of args) {
    if (a.type !== "NumberLiteral") return null;
    out.push(a.value);
  }
  return out;
}

function finalizeDate(d: Date): { value: Date } | null {
  if (Number.isNaN(d.getTime())) return null;
  return { value: d };
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
    // Ordered comparisons accept numbers, strings, and `Date` instances —
    // `Date` so `jsmql.compile(($) => $.createdAt >= params.cutoff)({ cutoff: new Date(…) })`
    // emits index-friendly field-form instead of $expr.
    if (typeof value !== "number" && typeof value !== "string" && !(value instanceof Date)) return null;
  } else {
    // Equality-side: accept the same primitives the literal-AST path accepts,
    // plus BSON-comparable instance values (Date, RegExp, Buffer / Uint8Array,
    // and duck-typed ObjectId). Refuses plain arrays/objects — those would
    // silently switch on query-language array-element matching or be matched
    // as literal subdocs, both surprising.
    if (!isQueryDocLiteralValue(value)) return null;
  }
  return { value };
}

function isQueryDocLiteralValue(value: unknown): boolean {
  if (value === null) return true;
  const t = typeof value;
  if (t === "number" || t === "string" || t === "boolean") return true;
  return isOpaqueBsonValue(value);
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
