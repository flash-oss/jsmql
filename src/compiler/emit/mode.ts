// Phase 5 — EMIT. The two ways an expression is read: for its VALUE, or for its
// TRUTH.
//
// JavaScript and MongoDB disagree on what is false. MEASURED with
// `{ $cond: [{ $literal: v }, "T", "F"] }` on mongod:
//     v      JavaScript   MongoDB
//     ""     false        TRUE
//     0      false        false
//     null   false        false
//     []     true         true
//     {}     true         true
// So a JavaScript spelling that READS a condition — `? :`, `&&`, `||`, `!`, a
// predicate body — checks missing, null, false, "" and 0 itself. This is the
// developer's own ruling. NaN is not checked: JSMQL does not support NaN. The
// `$op(...)` escape hatch is the developer's own MQL. It is not read here at
// all — MongoExprIn has no `truth` service.
//
// `Truth` is a brand. The vocabulary declares it, and this module alone mints
// it. Every slot that reads a boolean is typed to take a `Truth` (see mql.ts).
// So a value cannot land in `$cond.if` without passing through here. A node
// whose row states `returns: "bool"` passes through unchanged, so
// `$.a > 1 ? 1 : 2` carries no check that the comparison already made.

import type { Truth } from "../../registry/vocabulary.ts";

const mint = (doc: unknown): Truth => doc as Truth;

/**
 * JavaScript's truthiness of a lowered value:
 *   $.a ? 1 : 2  →  {$cond:{if:{$and:[{$ne:[{$ifNull:["$a",null]},null]},{$ne:["$a",false]},{$ne:["$a",""]},{$ne:["$a",0]}]},…}}
 * The `$ifNull` folds missing into null, so one comparison covers both.
 */
export const jsTruthy = (value: unknown): Truth =>
  mint({
    $and: [
      { $ne: [{ $ifNull: [value, null] }, null] },
      { $ne: [value, false] },
      { $ne: [value, ""] },
      { $ne: [value, 0] },
    ],
  });

/**
 * A lowered value read as a condition. `isBool` states what the producing
 * row's `returns` field says. A boolean is its own truth; the function
 * checks anything else.
 */
export const truthOf = (value: unknown, isBool: boolean): Truth => (isBool ? mint(value) : jsTruthy(value));

/** A Truth used as a VALUE — `Boolean(x)`, `!!x`. It already is one; the type is what changes. */
export const asValue = (t: Truth): unknown => t;

const operandsOf = (op: "$and" | "$or", t: Truth): readonly Truth[] => {
  const doc = t as unknown as Record<string, unknown>;
  const inner = typeof doc === "object" && doc !== null ? doc[op] : undefined;
  return Array.isArray(inner) ? (inner as Truth[]) : [t];
};

/** `a && b` read for truth. This flattens a nested `$and` into one. */
export const and = (...ts: readonly Truth[]): Truth => mint({ $and: ts.flatMap((t) => operandsOf("$and", t)) });

/** `a || b` read for truth. This flattens a nested `$or` into one. */
export const or = (...ts: readonly Truth[]): Truth => mint({ $or: ts.flatMap((t) => operandsOf("$or", t)) });

/** `!a`. */
export const not = (t: Truth): Truth => mint({ $not: t });
