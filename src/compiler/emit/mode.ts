// Phase 5 — EMIT. The two ways an expression is read: for its VALUE, or for its
// TRUTH.
//
// JavaScript and MongoDB disagree on what is false. MEASURED with
// `{ $cond: [{ $literal: v }, "T", "F"] }` on mongod:
//     v            JavaScript   MongoDB
//     ""           false        TRUE
//     0            false        false
//     Long 0       false        false
//     Decimal 0    false        false
//     -0           false        false
//     null         false        false
//     missing      false        false
//     []           true         true
//     {}           true         true
// So a JavaScript spelling that READS a condition — `? :`, `&&`, `||`, `!`, a
// predicate body — checks missing, null, false, "" and 0 itself. This is the
// developer's own ruling. NaN is not checked: JSMQL does not support NaN. The
// `$op(...)` escape hatch is the developer's own MQL. It is not read here at
// all — MongoExprIn has no `truth` service.
//
// The check is SUBTRACTIVE. Each of the four tests belongs to one part of the
// value's proof, and the check keeps only the tests some part of the proof can
// fail: `$ne null` only while the value may be absent, `$ne false` only while it
// may be a boolean, `$ne ""` only while it may be a string, `$ne 0` only while it
// may be a number. An array, an object, a date or an ObjectId owes no test. A
// value that can only be a boolean or a number is its own truth, because
// MongoDB already reads 0, false, null and missing as false there (the table).
// No test left is the constant `true`, and the slot that reads it folds.
// See docs/specs/types.md § The truthiness rule.
//
// `Truth` is a brand. The vocabulary declares it, and this module alone mints
// it. Every slot that reads a boolean is typed to take a `Truth` (see mql.ts).
// So a value cannot land in `$cond.if` without passing through here.

import type { Truth, Type } from "../../registry/vocabulary.ts";
import { ANY, isNothing, mayBe } from "./type.ts";

const mint = (doc: unknown): Truth => doc as Truth;

/** The constant truths. A slot that reads one folds to the branch it picks. */
export const TRUE: Truth = mint(true);
export const FALSE: Truth = mint(false);

/** Is this Truth a constant, and which? */
export const constantOf = (t: Truth): boolean | null => (t === TRUE ? true : t === FALSE ? false : null);

/** A document that IS a boolean expression — a comparison, a `$type` test, a dispatch guard — read as its own truth. */
export const boolTruth = (doc: unknown): Truth => mint(doc);

/**
 * A lowered value read as a condition, under what the compiler proves of it.
 *
 *   $.a ? 1 : 2      a: unknown         → { $and: [{ $ne: [{ $ifNull: ["$a", null] }, null] }, { $ne: ["$a", false] }, { $ne: ["$a", ""] }, { $ne: ["$a", 0] }] }
 *   $.s ? 1 : 2      s: string, absent  → { $and: [{ $ne: [{ $ifNull: ["$s", null] }, null] }, { $ne: ["$s", ""] }] }
 *   $.s ? 1 : 2      s: string, present → { $ne: ["$s", ""] }
 *   $.n ? 1 : 2      n: number          → "$n"
 *   $.b ? 1 : 2      b: bool            → "$b"
 *   $.o ? 1 : 2      o: object, absent  → { $ne: [{ $ifNull: ["$o", null] }, null] }
 *   $.o ? 1 : 2      o: object, present → true — and the `$cond` folds to its `then`
 *
 * The `$ifNull` folds missing into null, so one comparison covers both.
 */
export function truthOf(value: unknown, type: Type): Truth {
  if (isNothing(type)) return FALSE;
  const kinds = type.kinds;
  // A boolean or a number is its own truth on the server, whether or not it is there.
  if (kinds !== "any" && [...kinds].every((k) => k === "bool" || k === "number")) return mint(value);
  const tests: unknown[] = [];
  if (type.absent) tests.push({ $ne: [{ $ifNull: [value, null] }, null] });
  if (mayBe(type, "bool")) tests.push({ $ne: [value, false] });
  if (mayBe(type, "string")) tests.push({ $ne: [value, ""] });
  if (mayBe(type, "number")) tests.push({ $ne: [value, 0] });
  if (tests.length === 0) return TRUE;
  if (tests.length === 1) return mint(tests[0]);
  return mint({ $and: tests });
}

/** JavaScript's truthiness of a value nothing is known about: all four tests. */
export const jsTruthy = (value: unknown): Truth => truthOf(value, ANY);

/** A Truth used as a VALUE — `Boolean(x)`, `!!x`. It already is one; the type is what changes. */
export const asValue = (t: Truth): unknown => t;

const operandsOf = (op: "$and" | "$or", t: Truth): readonly Truth[] => {
  const doc = t as unknown as Record<string, unknown>;
  const inner = typeof doc === "object" && doc !== null ? doc[op] : undefined;
  return Array.isArray(inner) ? (inner as Truth[]) : [t];
};

/** `a && b` read for truth. This flattens a nested `$and` into one, and a constant operand folds. */
export function and(...ts: readonly Truth[]): Truth {
  if (ts.some((t) => t === FALSE)) return FALSE;
  const live = ts.filter((t) => t !== TRUE);
  if (live.length === 0) return TRUE;
  if (live.length === 1) return live[0];
  return mint({ $and: live.flatMap((t) => operandsOf("$and", t)) });
}

/** `a || b` read for truth. This flattens a nested `$or` into one, and a constant operand folds. */
export function or(...ts: readonly Truth[]): Truth {
  if (ts.some((t) => t === TRUE)) return TRUE;
  const live = ts.filter((t) => t !== FALSE);
  if (live.length === 0) return FALSE;
  if (live.length === 1) return live[0];
  return mint({ $or: live.flatMap((t) => operandsOf("$or", t)) });
}

/** `!a`. */
export const not = (t: Truth): Truth => (t === TRUE ? FALSE : t === FALSE ? TRUE : mint({ $not: t }));
