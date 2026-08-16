// The Predicate IR — the one vocabulary the Query and Expr targets share.
//
// MongoDB's query language is a predicate language and nothing else: it is reached only from
// predicate position (a Filter, a `$match` body, `$elemMatch`, a `$lookup` predicate).
// Everywhere else jsmql emits the aggregation-expression language. So the two targets
// overlap on exactly one thing — predicates — and that overlap is what lives here.
//
// A predicate feature declares ONE node. The node carries both cells, and the two cannot
// disagree because they read the same vocabulary. That is not a tidiness argument: `typeof`
// used to carry two alias tables, and the expression side compared `$type` against
// JavaScript's own spelling. `typeof $.a === "boolean"` was false for EVERY document,
// including one where the field really was a boolean, while the identical source in Filter
// position was correct.
//
// **The operand-kind gate.** Each node states the operand kinds its Query cell accepts. When
// the operands do not match, the Query cell is unavailable BY CONSTRUCTION and the caller
// falls back to `{ $expr: <the Expr cell> }`. A missing query rule is therefore never a
// wrong answer and never a silent one — it is a larger, correct document.
//
// A LEAF: it imports only AST types and other leaves.
//
// See docs/specs/predicate-ir.md.

import type { Expr } from "./ast.ts";

/**
 * BSON type aliases MongoDB's `$type` QUERY operator accepts. Restricting the peephole to
 * this set avoids emitting a query the server rejects at parse time.
 *
 * `"number"` is here because the query form accepts it as a synonym for the
 * int/long/double/decimal group — even though the aggregation `$type` expression never
 * RETURNS it. That asymmetry is precisely what the two cells below have to absorb.
 */
export const BSON_TYPE_ALIASES: ReadonlySet<string> = new Set([
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
 * JavaScript's `typeof` spelling → the BSON alias. `typeof` yields `"boolean"`; MongoDB
 * spells it `"bool"`. Other JS-only results (`"function"`, `"symbol"`, `"bigint"`) have no
 * clean BSON analogue and are left un-mapped, so the gate below rejects them and the caller
 * falls back.
 */
const JS_TYPEOF_TO_BSON: ReadonlyMap<string, string> = new Map([["boolean", "bool"]]);

/**
 * The concrete types the aggregation `$type` expression can RETURN for an alias that names a
 * group rather than a single type.
 *
 * The query form takes the umbrella alias directly; the expression form cannot, because it
 * compares against what `$type` actually returned — and `$type` returns `"int"` or
 * `"double"`, never `"number"`. Comparing against the umbrella is how the expression cell
 * came to be unsatisfiable.
 */
const EXPR_TYPE_GROUPS: ReadonlyMap<string, readonly string[]> = new Map([
  ["number", ["double", "int", "long", "decimal"]],
]);

/** `TypeIs` — the node behind `typeof x === "…"` / `!== "…"`. */
export type TypeIs = {
  readonly kind: "TypeIs";
  /** The operand whose type is tested. The Query cell additionally needs it to be a path. */
  readonly operand: Expr;
  /** The BSON alias, already normalised from JavaScript's spelling. */
  readonly alias: string;
  readonly negated: boolean;
};

/**
 * Build a `TypeIs` from a `typeof <x> === "<alias>"` comparison, or null when this is not
 * one — an unrecognised alias included, which is what routes `typeof x === "function"` to
 * the expression fallback rather than to a query MongoDB would refuse.
 */
export function typeIsFrom(operand: Expr, rawAlias: string, negated: boolean): TypeIs | null {
  const alias = JS_TYPEOF_TO_BSON.get(rawAlias) ?? rawAlias;
  if (!BSON_TYPE_ALIASES.has(alias)) return null;
  return { kind: "TypeIs", operand, alias, negated };
}

/**
 * The Query cell. Gated on the operand being a static field PATH — the caller resolves that
 * and passes the path, so a computed operand simply never reaches here.
 */
export function typeIsQuery(node: TypeIs, path: string): Record<string, unknown> {
  const test = { $type: node.alias };
  return { [path]: node.negated ? { $not: test } : test };
}

/**
 * The Expr cell. Takes the ALREADY-LOWERED operand.
 *
 * A group alias becomes an `$in` over the concrete types `$type` can return, because the
 * expression form compares against what `$type` actually yielded. Everything else is a
 * direct comparison.
 */
export function typeIsExpr(node: TypeIs, loweredOperand: unknown): unknown {
  const actual = { $type: loweredOperand };
  const group = EXPR_TYPE_GROUPS.get(node.alias);
  if (group !== undefined) {
    const member = { $in: [actual, group] };
    return node.negated ? { $not: [member] } : member;
  }
  return { [node.negated ? "$ne" : "$eq"]: [actual, node.alias] };
}

/** `Exists` — the node behind `x === undefined` / `x !== undefined`. */
export type Exists = {
  readonly kind: "Exists";
  readonly operand: Expr;
  /** True for `!== undefined` (the field must be present). */
  readonly present: boolean;
};

/**
 * The type `$type` reports for a field the document does not carry.
 *
 * This is what gives the Expr cell exact `$exists` semantics. The aggregation language was
 * long assumed unable to tell "missing" from "present and null" — it can: `$type` answers
 * `"missing"` for an absent field and `"null"` for an explicit null, which is precisely the
 * distinction `$exists` draws.
 */
const MISSING = "missing";

/**
 * The non-`undefined` side of an `x === undefined` comparison, either way round — shared, so
 * both cells agree on what counts as one. `undefined === undefined` is not a predicate.
 */
export function orientUndefined(left: Expr, right: Expr): Expr | null {
  if (left.type === "UndefinedLiteral") return right.type === "UndefinedLiteral" ? null : right;
  if (right.type === "UndefinedLiteral") return left;
  return null;
}

export function existsFrom(operand: Expr, present: boolean): Exists {
  return { kind: "Exists", operand, present };
}

/** The Query cell. Gated on a static field path, which the caller resolves. */
export function existsQuery(node: Exists, path: string): Record<string, unknown> {
  return { [path]: { $exists: node.present } };
}

/**
 * The Expr cell. Takes the ALREADY-LOWERED operand.
 *
 * `$exists: false` is "the field is absent", NOT "the field is absent or null" — and
 * `$type` draws the same line, so the two cells agree on a document carrying an explicit
 * null. Verified on a live mongod.
 */
export function existsExpr(node: Exists, loweredOperand: unknown): unknown {
  const actual = { $type: loweredOperand };
  return { [node.present ? "$ne" : "$eq"]: [actual, MISSING] };
}

/** `Contains` — the node behind `.includes` / `.startsWith` / `.endsWith`. */
export type Contains = {
  readonly kind: "Contains";
  readonly operand: Expr;
  /** The literal needle. Only a literal can be baked into an anchored pattern. */
  readonly needle: string;
  readonly anchor: "start" | "end";
};

/**
 * Escape a literal needle for use inside a regex, using a REPLACER FUNCTION.
 *
 * A replacement STRING would be wrong here: `String.replace` reads `$&`, `$1` and `$$` as
 * substitution patterns, so a needle containing `$` would corrupt itself.
 */
function escapeRegexLiteral(needle: string): string {
  return needle.replace(/[.*+?^${}()|[\]\\]/g, (m) => `\\${m}`);
}

export function containsFrom(operand: Expr, needle: string, anchor: "start" | "end"): Contains {
  return { kind: "Contains", operand, needle, anchor };
}

/**
 * The Query cell for an ANCHORED contains — an indexable prefix/suffix regex.
 *
 * This is the cell the spec anticipated: `.startsWith` and `.endsWith` used to have no query
 * form at all and fell through to `{ $expr: … }`, which is TWO problems. `$expr` cannot use
 * an index — measured: `{ s: /^he/ }` plans an IXSCAN where the `$expr` form plans a
 * COLLSCAN. And the expression form calls `$indexOfCP`, which ERRORS on a non-string, so one
 * numeric value anywhere in the collection aborted the whole query. The regex simply does
 * not match those documents.
 *
 * Gated on a literal needle and a static path; anything else keeps the expression fallback.
 */
export function containsQuery(node: Contains, path: string): Record<string, unknown> {
  const body = escapeRegexLiteral(node.needle);
  // A real RegExp, not a `$regex` document: the driver serialises it as a BSON regex, which
  // is what the index reads.
  return { [path]: new RegExp(node.anchor === "start" ? `^${body}` : `${body}$`) };
}

/** `Mod` — the node behind `x % d === m` / `!== m`. */
export type Mod = {
  readonly kind: "Mod";
  readonly divisor: number;
  readonly remainder: number;
  readonly negated: boolean;
};

export function modFrom(divisor: number, remainder: number, negated: boolean): Mod {
  return { kind: "Mod", divisor, remainder, negated };
}

/**
 * The Query cell. `$mod` takes `[divisor, remainder]` IN THAT ORDER — the single most
 * swappable pair in the whole surface, which is why it is written once here rather than at
 * each site that builds one.
 */
export function modQuery(node: Mod, path: string): Record<string, unknown> {
  const test = { $mod: [node.divisor, node.remainder] };
  return { [path]: node.negated ? { $not: test } : test };
}

/**
 * The Expr cell. Takes the ALREADY-LOWERED operand.
 *
 * The expression form keeps the comparison the user wrote — `(x % d) === m` — because there
 * is no single operator for it; only the query language folds the whole shape into `$mod`.
 */
export function modExpr(node: Mod, loweredOperand: unknown): unknown {
  const rem = { $mod: [loweredOperand, node.divisor] };
  return { [node.negated ? "$ne" : "$eq"]: [rem, node.remainder] };
}

/** `RegexMatch` — the node behind `.match(/re/)` and `regex.test(x)`. */
export type RegexMatch = { readonly kind: "RegexMatch"; readonly pattern: string; readonly flags: string };

export function regexMatchFrom(pattern: string, flags: string): RegexMatch {
  return { kind: "RegexMatch", pattern, flags };
}

/**
 * The Query cell — a live `RegExp`, not a `$regex` document.
 *
 * The driver serialises a RegExp instance to a BSON regex, which is the form an index reads
 * and the form the server expects; a plain object would arrive as a document. The JS-only
 * flags ride along untouched because the driver normalises them — asserted live in
 * `test/query-expr-agreement.test.ts`, since MongoDB itself refuses a `g` option.
 */
export function regexMatchQuery(node: RegexMatch, path: string): Record<string, unknown> {
  return { [path]: new RegExp(node.pattern, node.flags) };
}

// ── The remaining nodes ────────────────────────────────────────────────────────
// Their two cells already AGREE — `test/query-expr-agreement.test.ts` proves it on a live
// server — so what follows moves shapes into one place rather than repairing them. The value
// is that a shape stated once cannot drift, which is exactly how `typeof` broke.

/** The comparison operators `Cmp` covers, in jsmql's spelling. */
export type CmpOp = "eq" | "ne" | "gt" | "gte" | "lt" | "lte";

/** How a comparison against `null` is meant: JS `===` excludes missing, `==` includes it. */
export type NullMode = "strict" | "loose";

const CMP_QUERY_OP: Readonly<Record<CmpOp, string>> = {
  eq: "$eq",
  ne: "$ne",
  gt: "$gt",
  gte: "$gte",
  lt: "$lt",
  lte: "$lte",
};

/** Reading a comparison right-to-left flips its direction; equality is symmetric. */
export const FLIPPED_CMP: Readonly<Record<CmpOp, CmpOp>> = {
  eq: "eq",
  ne: "ne",
  gt: "lt",
  gte: "lte",
  lt: "gt",
  lte: "gte",
};

/**
 * The Query cell for an ORDERED comparison — `{ p: { $gt: v } }`.
 *
 * Equality is deliberately not routed here: `{ p: v }` is the indexed spelling and also the
 * one that matches an array containing `v`, which `{ p: { $eq: v } }` does not.
 */
export function cmpOrderedQuery(
  op: "gt" | "gte" | "lt" | "lte",
  path: string,
  value: unknown,
): Record<string, unknown> {
  return { [path]: { [CMP_QUERY_OP[op]]: value } };
}

/** The Query cell for equality — the bare form, which is what an index reads. */
export function cmpEqualityQuery(op: "eq" | "ne", path: string, value: unknown): Record<string, unknown> {
  return { [path]: op === "eq" ? value : { $ne: value } };
}

/**
 * The Query cell for a comparison against NULL, where the two modes genuinely differ.
 *
 * `strict` (JS `===`) must EXCLUDE a missing field, and `{ p: { $type: "null" } }` is the
 * only query shape that does — `{ p: null }` matches missing too. `loose` (JS `==`) wants
 * exactly that looser shape, so it gets the plain one. Writing both here is what stops one
 * being quietly used for the other.
 */
export function cmpNullQuery(mode: NullMode, negated: boolean, path: string): Record<string, unknown> {
  if (mode === "loose") return { [path]: negated ? { $ne: null } : null };
  const isNull = { $type: "null" };
  return { [path]: negated ? { $not: isNull } : isNull };
}

/** `Membership` — the node behind `[a, b].includes($.x)`. */
export function membershipQuery(path: string, values: readonly unknown[]): Record<string, unknown> {
  return { [path]: { $in: [...values] } };
}

/**
 * The Query cell for an UNANCHORED contains — the array-membership form.
 *
 * `{ p: v }` means "equals v, OR is an array containing v", which is what `.includes` means
 * on an array. It is NOT a substring test, so on a string receiver this reads differently
 * from the expression form — divergence 4 in match-query-translation.md, and the reason the
 * caller only reaches here for a receiver whose type it cannot prove.
 */
export function containsAnyQuery(path: string, value: unknown): Record<string, unknown> {
  return { [path]: value };
}

/**
 * The Query cell for `Quantify(some)` — `{ p: { $elemMatch: <inner query> } }`.
 *
 * Only reachable when the inner predicate translates ENTIRELY. A partial translation would
 * mix index-friendly and `$expr` semantics inside one `$elemMatch`, which is not the same
 * predicate. `every` has no query cell: it needs De Morgan, and negating flips index usage
 * with the data's shape.
 */
export function quantifySomeQuery(path: string, inner: Record<string, unknown>): Record<string, unknown> {
  return { [path]: { $elemMatch: inner } };
}

/** The Query cell for `Logical(or)` — all-or-nothing, since a branch cannot carry a residual. */
export function logicalOrQuery(branches: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { $or: [...branches] };
}
