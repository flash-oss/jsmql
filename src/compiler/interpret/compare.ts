import type { Rule } from "./values.ts";
import { NO, NumberText, compareValues, inert, ok, rankOf, sameValue, startsLikeNumber } from "./values.ts";
import { positional } from "./operand.ts";

function equal(a: unknown, b: unknown): boolean | undefined {
  if (a instanceof NumberText || b instanceof NumberText) {
    const other = a instanceof NumberText ? b : a;
    return typeof other === "string" && !startsLikeNumber(other) ? false : undefined;
  }
  const ra = rankOf(a);
  const rb = rankOf(b);
  if (ra === undefined || rb === undefined) return undefined;
  if (ra !== rb) return false;
  if (inert(a) && inert(b)) return sameValue(a, b);
  const order = compareValues(a, b);
  return order === undefined ? undefined : order === 0;
}

const ordered = (test: (sign: -1 | 0 | 1) => unknown): Rule =>
  positional(2, 2, ([a, b]) => {
    const sign = compareValues(a, b);
    return sign === undefined ? NO : ok(test(sign));
  });

const equality = (want: boolean): Rule =>
  positional(2, 2, ([a, b]) => {
    const same = equal(a, b);
    return same === undefined ? NO : ok(same === want);
  });

export const COMPARE: Record<string, Rule> = {
  $eq: equality(true),
  $ne: equality(false),
  $gt: ordered((s) => s > 0),
  $gte: ordered((s) => s >= 0),
  $lt: ordered((s) => s < 0),
  $lte: ordered((s) => s <= 0),
  $cmp: ordered((s) => s),
};
