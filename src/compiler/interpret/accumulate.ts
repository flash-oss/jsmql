// The accumulators in their expression form: `{ $sum: [a, b] }` and `{ $sum: <list> }`.
//
// One operand that is a list reads as the list of values. Any other operand list is the
// values themselves. A value that is not a number is ignored by `$sum` and `$avg`, and
// a null is ignored by `$max` and `$min`. A value that the interpreter does not read
// could be a value of another BSON type, so such a list is a refusal.
//
// The server adds a list of fractions in a way that the documentation does not
// specify. Two operands give one addition, and one addition is exact. A list of
// integers adds exactly. So `$sum` and `$avg` refuse a longer list with a fraction.

import type { Rule } from "./values.ts";
import { NO, compareValues, inert, isWellFormed, kindOf, losesPrecision, ok, spellable } from "./values.ts";
import { positional } from "./operand.ts";

/** The values of the operand: the one list, or the operands. */
const valuesOf = (xs: readonly unknown[]): readonly unknown[] => (xs.length === 1 && Array.isArray(xs[0]) ? xs[0] : xs);

/** The sum of the numbers, or undefined where the sum is not exact. */
function sumOf(list: readonly unknown[]): number | undefined {
  if (!list.every(inert)) return undefined;
  const numbers = list.filter((v): v is number => typeof v === "number");
  if (numbers.length > 2 && !numbers.every(Number.isSafeInteger)) return undefined;
  let total = 0;
  for (const n of numbers) {
    const next = total + n;
    if (losesPrecision(next, total, n)) return undefined;
    total = next;
  }
  return total;
}

const sum = positional(
  0,
  Infinity,
  (xs) => {
    const total = sumOf(valuesOf(xs));
    return total === undefined ? NO : spellable(total);
  },
  true,
);

const avg = positional(
  0,
  Infinity,
  (xs) => {
    const list = valuesOf(xs);
    const total = sumOf(list);
    if (total === undefined) return NO;
    const count = list.filter((v) => typeof v === "number").length;
    return count === 0 ? ok(null) : spellable(total / count);
  },
  true,
);

const COMPARABLE = new Set(["number", "string", "boolean", "date", "objectId"]);

/** The greatest or the least value of one kind. Null is ignored, and an empty list gives null. */
const extreme = (greatest: boolean): Rule =>
  positional(
    0,
    Infinity,
    (xs) => {
      const kept = valuesOf(xs).filter((v) => v !== null);
      if (kept.length === 0) return ok(null);
      const kind = kindOf(kept[0]);
      if (!COMPARABLE.has(kind) || !kept.every((v) => kindOf(v) === kind)) return NO;
      if (!kept.every((v) => typeof v !== "string" || isWellFormed(v))) return NO;
      let best = kept[0];
      for (const v of kept.slice(1)) {
        const order = compareValues(v, best) as number;
        if (greatest ? order > 0 : order < 0) best = v;
      }
      return ok(best);
    },
    true,
  );

export const ACCUMULATE: Record<string, Rule> = { $sum: sum, $avg: avg, $max: extreme(true), $min: extreme(false) };
