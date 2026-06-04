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
import { isOpaqueBsonValue, generateWithCtx, mqlForBinaryOp } from "./codegen.ts";
import type { GenerateCtx } from "./codegen.ts";

export type MatchTranslation = {
  /** The translated query-language fragment. Empty when nothing translated. */
  query: Record<string, unknown>;
  /** Remaining expression that couldn't be translated. Null when fully translated. */
  residual: Expr | null;
};

/**
 * Merge a `MatchTranslation` into a single query document: the index-friendly
 * `query` conjuncts plus, when present, the untranslatable `residual` lowered
 * through codegen and wrapped in `$expr`. Returns `null` for a vacuous predicate
 * (empty query, no residual) so callers can skip emitting a `$match` entirely.
 *
 * This is the one place the four-way query / `$expr` emission lives — vacuous →
 * `null`; pure query → `query`; pure residual → `{ $expr }`; both → merged. Every
 * consumer of `translateMatchBody` (the top-level Filter in index.ts, the
 * `$match` stage body in pipeline.ts, and `matchStagesFromTranslation` for the
 * sub-pipeline translators) routes through it so the emitted shape can't drift.
 */
export function mergeTranslatedQuery(t: MatchTranslation, ctx: GenerateCtx): Record<string, unknown> | null {
  const queryEmpty = Object.keys(t.query).length === 0;
  if (t.residual === null) return queryEmpty ? null : t.query;
  const exprBody = generateWithCtx(t.residual, ctx);
  if (queryEmpty) return { $expr: exprBody };
  return { ...t.query, $expr: exprBody };
}

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
    // Pre-pass: when the entire &&-chain is `field.includes(<lit>)` calls on
    // the same field, fold to `{ field: { $all: [<lits>] } }`. Strictly a
    // compactness optimisation — `$and: [{ f: a }, { f: b }]` matches the
    // same array-valued docs as `$all: [a, b]` — so it doesn't change
    // semantics; just emits the shorter MQL the user almost certainly meant.
    // Mixed chains (one .includes plus other predicates) fall through to the
    // normal combineAnd path; the user can rearrange to enable the fold.
    const allFold = extractIncludesChain(expr);
    if (allFold !== null) {
      return { query: { [allFold.field]: { $all: allFold.values } }, residual: null };
    }
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
  // Bare boolean method calls — `.includes(x)`, `.match(/re/)`, `.some(p)` —
  // can be the entire predicate body (no `=== true` wrapper), so they're
  // tried before the BinaryExpr machinery.
  if (expr.type === "MethodCall") {
    const m = translateBooleanMethodCall(expr, ctx);
    if (m !== null) return m;
  }
  if (expr.type !== "BinaryExpr") return null;
  const op = expr.op;
  if (isEqualityOp(op)) {
    // Each peephole is tried before the generic equality path so the field-
    // path-and-literal orientation logic doesn't see the wrapping construct
    // (typeof, member access for `.length`, BinaryExpr `%`, …).
    if (op === "===" || op === "!==") {
      const typed = translateTypeofPredicate(expr.left, expr.right, op);
      if (typed !== null) return typed;
      const undef = translateUndefinedPredicate(expr.left, expr.right, op);
      if (undef !== null) return undef;
      // `.length` (or the JS-identical `["length"]`) compared against a natural
      // number is the *length* of a string-or-array, not a field named
      // `length`. Residualise into `$expr` so codegen emits the runtime
      // `$isArray`/`$size`/`$strLenCP` dispatch (which, unlike `$size`, also
      // handles strings). Comparisons against a non-natural value fall through
      // to the generic path, which treats `.length` as a literal field path.
      if (isLengthVsNatural(expr.left, expr.right)) return null;
      const md = translateModulo(expr.left, expr.right, op);
      if (md !== null) return md;
    }
    return translateEquality(expr.left, expr.right, op, ctx);
  }
  if (isOrderedOp(op)) {
    if (isLengthVsNatural(expr.left, expr.right)) return null;
    return translateOrderedCompare(expr.left, expr.right, op, ctx);
  }
  return null;
}

/**
 * Bare boolean method calls in `$match` body — `.includes(lit)`, `.match(/re/)`,
 * `.some(p)`. Each produces an index-friendly query-doc shape when the receiver
 * and the argument are compatible; otherwise returns null and the body falls
 * through to `$expr`.
 */
function translateBooleanMethodCall(
  expr: Expr & { type: "MethodCall" },
  ctx: TranslateCtx,
): Record<string, unknown> | null {
  if (expr.method === "includes") return translateIncludesCall(expr, ctx);
  if (expr.method === "match") return translateMatchCall(expr);
  if (expr.method === "some") return translateSomeCall(expr, ctx);
  return null;
}

/**
 * `.includes()` — two query-position forms:
 *   - `$.tags.includes("vip")` → `{ tags: "vip" }` (implicit array-element /
 *     scalar-equality match — MongoDB's "value or array-containing-value"
 *     semantics line up with JS-on-arrays exactly).
 *   - `["a","b"].includes($.status)` → `{ status: { $in: ["a","b"] } }`
 *     (set membership).
 *
 * Form 1 diverges from jsmql's expression-position `.includes()` translation
 * (which handles both array and string substring via `$cond` + `$indexOfCP`):
 * here we only emit the array-element form. For string-substring queries,
 * users reach for `.match(/.../)` (or the explicit `$op($indexOfCP, …)`).
 * Documented in `docs/specs/match-query-translation.md`.
 */
function translateIncludesCall(expr: Expr & { type: "MethodCall" }, ctx: TranslateCtx): Record<string, unknown> | null {
  if (expr.args.length !== 1) return null;
  const arg = expr.args[0];
  if (arg.type === "SpreadElement") return null;
  // Form 1: field.includes(<literal>)
  const recvField = asFieldPath(expr.object);
  if (recvField !== null) {
    const lit = anyEqualityLiteral(arg, ctx);
    if (lit !== null) return { [recvField]: lit.value };
  }
  // Form 2: <array-literal-of-literals>.includes(<field>)
  if (expr.object.type === "ArrayLiteral") {
    const argField = asFieldPath(arg);
    if (argField === null) return null;
    const values: unknown[] = [];
    for (const el of expr.object.elements) {
      // ArrayElement is wider than Expr — it allows update-op shapes inside
      // pipeline arrays. None of those are valid in an `.includes()`-arg
      // literal, so we reject and fall through to the expression-form
      // translation, which produces the precise error if needed.
      if (el.type === "SpreadElement") return null;
      if (el.type === "AssignExpr" || el.type === "DeleteStmt" || el.type === "LetDecl") return null;
      const lit = anyEqualityLiteral(el, ctx);
      if (lit === null) return null;
      values.push(lit.value);
    }
    return { [argField]: { $in: values } };
  }
  return null;
}

/**
 * Walk a `&&`-tree and, if **every** leaf is `field.includes(<lit>)` on the
 * **same** field, return `{ field, values: [...lits] }`. Returns null on any
 * deviation — a different op, a different field, a non-literal arg, anything.
 *
 * Used by `translate()` to fold the chain into `$all` before the generic
 * `combineAnd` path sees it. Mixed chains (some leaves are `.includes`, others
 * aren't) deliberately fall through; the user can reorder if they want the
 * fold, and the un-folded `$and` of identical-shape clauses is identical
 * in semantics anyway.
 */
function extractIncludesChain(expr: Expr): { field: string; values: unknown[] } | null {
  if (expr.type === "BinaryExpr" && expr.op === "&&") {
    const left = extractIncludesChain(expr.left);
    if (left === null) return null;
    const right = extractIncludesChain(expr.right);
    if (right === null) return null;
    if (left.field !== right.field) return null;
    return { field: left.field, values: [...left.values, ...right.values] };
  }
  if (expr.type !== "MethodCall" || expr.method !== "includes") return null;
  if (expr.args.length !== 1) return null;
  const field = asFieldPath(expr.object);
  if (field === null) return null;
  const arg = expr.args[0];
  if (arg.type === "SpreadElement") return null;
  const lit = anyEqualityLiteral(arg, /*ctx*/ {});
  if (lit === null) return null;
  return { field, values: [lit.value] };
}

/**
 * `$.name.match(/^a/i)` → `{ name: /^a/i }`. Only the field-receiver,
 * regex-literal-arg form translates; anything else (string arg, computed
 * regex, non-field receiver) falls through to `$expr` where the existing
 * `$regexMatch` translation handles it.
 */
function translateMatchCall(expr: Expr & { type: "MethodCall" }): Record<string, unknown> | null {
  if (expr.args.length !== 1) return null;
  const field = asFieldPath(expr.object);
  if (field === null) return null;
  const arg = expr.args[0];
  if (arg.type !== "RegexLiteral") return null;
  // Reconstruct the regex literal as a real JS RegExp so the driver
  // serialises it as BSON regex (rather than a plain object).
  const re = new RegExp(arg.pattern, arg.flags);
  return { [field]: re };
}

/**
 * `$.items.some(item => <predicate>)` → `{ items: { $elemMatch: <translated-body> } }`
 * — but only when the lambda body itself translates entirely (no residual).
 * If the body has anything index-unfriendly, the whole `.some` falls through
 * to the expression-form `$anyElementTrue` path so we don't mix index-friendly
 * and `$expr` semantics inside one `$elemMatch`.
 */
function translateSomeCall(expr: Expr & { type: "MethodCall" }, ctx: TranslateCtx): Record<string, unknown> | null {
  if (expr.args.length !== 1) return null;
  const field = asFieldPath(expr.object);
  if (field === null) return null;
  const lam = expr.args[0];
  if (lam.type !== "Lambda" || lam.params.length !== 1) return null;
  if (lam.body === undefined) return null;
  const param = lam.params[0];
  // Rewrite `<param>.x` → `$.x` in the body so the inner translator (which
  // treats `$.` as the doc-relative field path) gets a recognisable shape.
  // `$elemMatch`'s query document is matched against each array element as if
  // *it* were the root doc, so the rewrite is faithful.
  const rewritten = rewriteParamAsRoot(lam.body, param);
  if (rewritten === null) return null;
  const inner = translate(rewritten, ctx);
  if (inner.residual !== null) return null;
  if (isEmpty(inner.query)) return null;
  return { [field]: { $elemMatch: inner.query } };
}

/**
 * Inside `.some(item => …)` the lambda parameter (`item`) plays the role of
 * the current element. `$elemMatch` evaluates its query doc against the
 * element as if it were the root, so `item.qty` should translate the same
 * way `$.qty` would. This rewriter walks the body, swapping every
 * `MemberAccess { object: ParamRef(<param>) }` chain into the equivalent
 * `FieldRef` / dotted-`FieldRef` shape; bare `ParamRef(<param>)` (no access)
 * isn't representable as a field path, so we bail.
 */
function rewriteParamAsRoot(expr: Expr, param: string): Expr | null {
  if (expr.type === "ParamRef" && expr.name === param) return null;
  if (expr.type === "MemberAccess") {
    const innerField = paramMemberAsField(expr, param);
    if (innerField !== null) return { type: "FieldRef", path: innerField, pos: expr.pos };
    const newObj = rewriteParamAsRoot(expr.object, param);
    if (newObj === null) return null;
    return { ...expr, object: newObj };
  }
  if (expr.type === "BinaryExpr") {
    const left = rewriteParamAsRoot(expr.left, param);
    if (left === null) return null;
    const right = rewriteParamAsRoot(expr.right, param);
    if (right === null) return null;
    return { ...expr, left, right };
  }
  if (expr.type === "UnaryExpr") {
    const operand = rewriteParamAsRoot(expr.operand, param);
    if (operand === null) return null;
    return { ...expr, operand };
  }
  if (expr.type === "MethodCall") {
    const obj = rewriteParamAsRoot(expr.object, param);
    if (obj === null) return null;
    return { ...expr, object: obj };
  }
  if (expr.type === "TypeofExpr") {
    const operand = rewriteParamAsRoot(expr.operand, param);
    if (operand === null) return null;
    return { ...expr, operand };
  }
  // Literals and unrelated FieldRefs pass through unchanged.
  return expr;
}

function paramMemberAsField(expr: Expr & { type: "MemberAccess" }, param: string): string | null {
  if (expr.object.type === "ParamRef" && expr.object.name === param) return expr.member;
  if (expr.object.type === "MemberAccess") {
    const base = paramMemberAsField(expr.object, param);
    if (base !== null) return `${base}.${expr.member}`;
  }
  return null;
}

/**
 * `$.field === undefined` → `{ field: { $exists: false } }`;
 * `$.field !== undefined` → `{ field: { $exists: true } }`. Mirrors JS's
 * "value is undefined / missing" semantics — both branches of MongoDB's
 * `$exists` line up. (Distinct from `=== null`, which lowers to
 * `$type: "null"` — present-and-null only.)
 */
function translateUndefinedPredicate(left: Expr, right: Expr, op: "===" | "!=="): Record<string, unknown> | null {
  const undefSide = left.type === "UndefinedLiteral" ? right : right.type === "UndefinedLiteral" ? left : null;
  if (undefSide === null) return null;
  const field = asFieldPath(undefSide);
  if (field === null) return null;
  if (op === "===") return { [field]: { $exists: false } };
  return { [field]: { $exists: true } };
}

/**
 * A `.length` member access. Only the dot form is interpreted as a length —
 * bracket access (`["length"]`) is raw data access and is never folded here.
 */
function isLengthAccess(expr: Expr): boolean {
  return expr.type === "MemberAccess" && expr.member === "length";
}

/**
 * `<length-access> <cmp> <natural-number-literal>` (either orientation). A
 * length compared against a natural number (`isIntegerLiteral` = non-negative
 * integer) is unambiguously a length; when true the comparison residualises to
 * `$expr` for the string-or-array `$cond`. Against any other RHS (`3.5`,
 * negative, a string, a non-literal) `.length` is read as a literal field path
 * instead — a length can't sensibly equal a non-natural value.
 */
function isLengthVsNatural(left: Expr, right: Expr): boolean {
  return (isLengthAccess(left) && isIntegerLiteral(right)) || (isLengthAccess(right) && isIntegerLiteral(left));
}

function isIntegerLiteral(expr: Expr): boolean {
  return expr.type === "NumberLiteral" && Number.isInteger(expr.value) && expr.value >= 0;
}

/**
 * Emit `{ [field]: positive }` for a `===` predicate, or `{ [field]: { $not:
 * positive } }` for `!==`. The shared shape for any equality-family peephole
 * whose negation is a `$not` wrap of an inner query operator (`$mod`, `$type`,
 * …) — each such translator supplies only the positive operator object and gets
 * the `!==` form for free. (Equality-shorthand and `$exists` negate differently
 * — `$ne` and a flipped boolean — so they don't use this.)
 */
function fieldQueryOrNegated(
  field: string,
  positive: Record<string, unknown>,
  op: "===" | "!==",
): Record<string, unknown> {
  return { [field]: op === "===" ? positive : { $not: positive } };
}

/**
 * `$.x % N === M` → `{ x: { $mod: [N, M] } }`. Both `N` (divisor) and `M`
 * (remainder) must be integer literals; the field path must be a clean
 * `$.<path>` (no method calls, no further arithmetic).
 */
function translateModulo(left: Expr, right: Expr, op: "===" | "!=="): Record<string, unknown> | null {
  const oriented = orientModuloAndInt(left, right);
  if (oriented === null) return null;
  return fieldQueryOrNegated(oriented.field, { $mod: [oriented.divisor, oriented.remainder] }, op);
}

function orientModuloAndInt(left: Expr, right: Expr): { field: string; divisor: number; remainder: number } | null {
  const lm = asModuloFieldAndDivisor(left);
  if (lm !== null && isIntegerLiteral(right)) {
    return {
      field: lm.field,
      divisor: lm.divisor,
      remainder: (right as { type: "NumberLiteral"; value: number }).value,
    };
  }
  const rm = asModuloFieldAndDivisor(right);
  if (rm !== null && isIntegerLiteral(left)) {
    return {
      field: rm.field,
      divisor: rm.divisor,
      remainder: (left as { type: "NumberLiteral"; value: number }).value,
    };
  }
  return null;
}

function asModuloFieldAndDivisor(expr: Expr): { field: string; divisor: number } | null {
  if (expr.type !== "BinaryExpr" || expr.op !== "%") return null;
  const field = asFieldPath(expr.left);
  if (field === null) return null;
  if (!isIntegerLiteral(expr.right)) return null;
  return { field, divisor: (expr.right as { type: "NumberLiteral"; value: number }).value };
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

/**
 * JS's `typeof` returns `"boolean"`, but MongoDB's `$type` query operator uses
 * `"bool"` — so accept either spelling and emit the BSON form. Other JS-only
 * typeof returns (`"function"`, `"symbol"`, `"bigint"`) have no clean BSON
 * analogue and fall through to `$expr`.
 */
const JS_TO_BSON_TYPE: ReadonlyMap<string, string> = new Map([["boolean", "bool"]]);

function translateTypeofPredicate(left: Expr, right: Expr, op: "===" | "!=="): Record<string, unknown> | null {
  const oriented = orientTypeofAndString(left, right);
  if (oriented === null) return null;
  const { field, alias: rawAlias } = oriented;
  const alias = JS_TO_BSON_TYPE.get(rawAlias) ?? rawAlias;
  if (!BSON_TYPE_ALIASES.has(alias)) return null;
  return fieldQueryOrNegated(field, { $type: alias }, op);
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
  return mqlForBinaryOp(op);
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
