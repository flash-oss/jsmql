// A set operator gives each value once, in an order that MongoDB does not specify
// (SR2). So a suite that compares a fold with the server compares a set answer by
// its values. It compares all other answers by their sequence. The MQL that the
// server runs selects the comparison, not the name of the method. So a set method
// that gets a fold needs no change here.

/** The operators whose answer is a set. */
const SET_OPERATOR = /^\$set(Union|Intersection|Difference)$/;

/**
 * Does the server answer with the output of a set operator? The operator at the top
 * of the MQL gives the answer. A `$let` gives the answer of its `in`, so the check
 * examines that `in`. For example, `.symmetricDifference()` puts `$setDifference` in a `$let`.
 */
export function answersSet(mql: unknown): boolean {
  if (typeof mql !== "object" || mql === null) return false;
  if ("$let" in mql) return answersSet((mql as { $let: { in: unknown } }).$let.in);
  return Object.keys(mql).some((k) => SET_OPERATOR.test(k));
}

/**
 * It gives the elements of a list in sorted order, so two orders of the same elements compare equal.
 * A duplicate still counts, so `[3, 3]` and `[3]` stay different.
 */
export const inAnyOrder = (v: unknown): unknown => (Array.isArray(v) ? v.map((x) => JSON.stringify(x)).sort() : v);
