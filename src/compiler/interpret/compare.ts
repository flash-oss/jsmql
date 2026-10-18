// The comparison operators.
//
// The server orders two values of different types by the place of their types in one
// fixed order, and orders two values of one type by value (`rankOf` and `compareValues`
// in values.ts). So a comparison across types always has an answer, and so does a
// comparison with null: null sorts above MinKey and below every other value. Strings
// compare by code point, which is also the UTF-8 byte order that the server uses.
// A comparison of two opaque values of one place (a Long beside a number) is a refusal.

import type { Rule } from "./values.ts";
import { NO, NumberText, compareValues, inert, ok, rankOf, sameValue, startsLikeNumber } from "./values.ts";
import { positional } from "./operand.ts";

/** Are the two values equal? Undefined where the order of two values of one place is not read. */
function equal(a: unknown, b: unknown): boolean | undefined {
  // A `NumberText` differs from each string that cannot be the text of a number, and from nothing else that is known.
  if (a instanceof NumberText || b instanceof NumberText) {
    const other = a instanceof NumberText ? b : a;
    return typeof other === "string" && !startsLikeNumber(other) ? false : undefined;
  }
  const ra = rankOf(a);
  const rb = rankOf(b);
  if (ra === undefined || rb === undefined) return undefined;
  if (ra !== rb) return false;
  if (inert(a) && inert(b)) return sameValue(a, b);
  // A list or a document with an opaque value inside can differ before the walk reaches that value.
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
