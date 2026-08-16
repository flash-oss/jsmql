// The array methods jsmql answers with a REJECTION, and the answer is the message.
//
// `unsupported(reason)` is not a gap in the grid — it is the recorded answer to a cell,
// carrying the text the user reads. That is the whole point: a reason nobody can write
// convincingly is a missing feature announcing itself, so these declarations are where a
// "we can't do that" has to justify itself in public.
//
// Two kinds live here. The MUTATORS (`.sort`, `.push`, …) mutate their receiver in
// JavaScript, and jsmql expressions are values; every message names the immutable
// spelling that does work, plus the statement position where the mutating form IS
// available. The ITERATOR / VOID methods (`.forEach`, `.keys`, …) return an iterator or
// nothing, neither of which is an MQL expression.
//
// All of them declare the array family even though the lowering only throws, so that a
// chain type-check on a non-array receiver fires FIRST — "use '.toSorted()'" is the wrong
// advice for a string. `.toLocaleString` is the one exception and is not here: it is
// genuinely universal in JavaScript (Number, Date and Array all carry it), so it has no
// family to declare.
//
// See docs/specs/lowering-grid.md.

import { NO_ARITY, type MethodDef, unsupported } from "./types.ts";

/** An array method that only ever rejects, with the message the user reads. */
function rejects(reason: string): MethodDef {
  return { receiver: "array", args: NO_ARITY, value: unsupported(reason) };
}

/** The statement position every mutator message points at. */
const AT_STATEMENT = "or call it at statement position (top-level on a '$.<field>' receiver)";

export const ARRAY_SHIM_METHODS: Record<string, MethodDef> = {
  sort: rejects(
    `.sort() mutates the array in JavaScript. In expression position, use '.toSorted()' — ${AT_STATEMENT} to mutate the field.`,
  ),
  reverse: rejects(
    `.reverse() mutates the array in JavaScript. In expression position, use '.toReversed()' — ${AT_STATEMENT} to mutate the field.`,
  ),
  splice: rejects(
    `.splice() mutates the array in JavaScript. In expression position, use '.toSpliced(start, deleteCount, ...items)' — ${AT_STATEMENT} to mutate the field.`,
  ),
  push: rejects(
    `.push() mutates the array in JavaScript. In expression position, use '.concat(x)' or spread '[...arr, x]' — ${AT_STATEMENT} to mutate the field.`,
  ),
  pop: rejects(
    `.pop() mutates the array in JavaScript. In expression position, use '.at(-1)' to read the last element or '.slice(0, -1)' for everything-but-last — ${AT_STATEMENT} to drop the last element.`,
  ),
  shift: rejects(
    `.shift() mutates the array in JavaScript. In expression position, use '.at(0)' to read the first element or '.slice(1)' for everything-but-first — ${AT_STATEMENT} to drop the first element.`,
  ),
  unshift: rejects(
    `.unshift() mutates the array in JavaScript. In expression position, use '.concat()' with the new items first or spread '[...newItems, ...arr]' — ${AT_STATEMENT} to prepend in place.`,
  ),
  fill: rejects(
    `.fill() mutates the array in JavaScript. In expression position there is no direct immutable replacement (build from a $range or pass a pre-filled array as a parameter) — ${AT_STATEMENT} to fill the field in place.`,
  ),
  copyWithin: rejects(
    `.copyWithin() mutates the array in JavaScript; jsmql expressions are immutable. Call it at statement position (top-level on a '$.<field>' receiver) to copy-within the field in place, or compose '.slice()' calls with '$concatArrays' for an inline expression.`,
  ),

  // lodash's iteratee gets each group spread as separate args — its arity is the
  // receiver's (runtime) row count, which a fixed-parameter arrow cannot express.
  unzipWith: rejects(
    `.unzipWith(fn) isn't supported — its iteratee's argument count depends on the array's length at runtime. Write '.unzip().map(group => …)' instead, where 'group' is one unzipped column.`,
  ),

  forEach: rejects(
    `.forEach() returns undefined in JavaScript; jsmql expressions must produce a value. Use '.map(...)' to transform, or move side-effecting work outside the query.`,
  ),
  entries: rejects(
    `.entries() returns an iterator in JavaScript and has no MongoDB equivalent. Use '.map((v, i) => [i, v])' if you want [index, value] pairs as an array.`,
  ),
  keys: rejects(
    `.keys() returns an iterator in JavaScript and has no MongoDB equivalent. Use '$op($range, 0, $op($size, arr))' if you want the index array.`,
  ),
  values: rejects(
    `.values() returns an iterator in JavaScript and has no MongoDB equivalent. The array itself is already the value sequence — use it directly.`,
  ),
};
