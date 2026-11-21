import type { Rule } from "./values.ts";
import { NO, compareValues, inert, isWellFormed, kindOf, losesPrecision, ok, spellable } from "./values.ts";
import { positional } from "./operand.ts";

const valuesOf = (xs: readonly unknown[]): readonly unknown[] => (xs.length === 1 && Array.isArray(xs[0]) ? xs[0] : xs);

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
