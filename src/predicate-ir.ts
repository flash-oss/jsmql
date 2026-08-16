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
