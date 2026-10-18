// A set operator gives each value once, in an order that MongoDB does not specify
// (SR2). So a suite that compares a fold with the server compares a set answer by
// its values. It compares all other answers by their sequence. The MQL that the
// server runs selects the comparison, not the name of the method. So a set method
// that gets a fold needs no change here.
//
// An operator that builds a value from the elements of a set, one by one, gives a
// value with the same unspecified order: a list that `$map` or `$filter` makes, a
// document that `$arrayToObject` makes, and the join of such values. So the answer of
// those operators is a set answer too, when the operand that carries the order is one.

/** The operators whose answer is a set. */
const SET_OPERATOR = /^\$set(Union|Intersection|Difference)$/;

type Operand = unknown;

const isDocument = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const listOf = (operand: Operand): unknown[] => (Array.isArray(operand) ? operand : [operand]);

/**
 * For each operator that keeps the order of its operand: the sub-expressions through which
 * the order flows to the answer. A sort removes the order, so `$sortArray` is not here.
 */
const CARRIES: Readonly<Record<string, (operand: Operand) => unknown[]>> = {
  $let: (o) => (isDocument(o) ? [o.in, ...(isDocument(o.vars) ? Object.values(o.vars) : [])] : []),
  $map: (o) => (isDocument(o) ? [o.input] : []),
  $filter: (o) => (isDocument(o) ? [o.input] : []),
  $arrayToObject: (o) => [o],
  $objectToArray: (o) => [o],
  $mergeObjects: (o) => listOf(o).flatMap((x) => (Array.isArray(x) ? x : [x])),
  $concatArrays: (o) => listOf(o),
  $ifNull: (o) => listOf(o),
  $cond: (o) => (isDocument(o) ? [o.then, o.else] : listOf(o).slice(1)),
  $switch: (o) =>
    isDocument(o)
      ? [...(Array.isArray(o.branches) ? o.branches.map((b) => (b as { then: unknown }).then) : []), o.default]
      : [],
};

/**
 * Does the server answer with a value of unspecified order? The operators from the top of the
 * MQL down to a set operator decide it. A `$let` gives the answer of its `in`, and `in` may read a
 * variable, so the check examines both. For example, `.symmetricDifference()` puts `$setDifference` in a `$let`.
 */
export function answersSet(mql: unknown): boolean {
  if (Array.isArray(mql)) return mql.some(answersSet);
  if (!isDocument(mql)) return false;
  return Object.entries(mql).some(
    ([key, operand]) => SET_OPERATOR.test(key) || (key in CARRIES && CARRIES[key](operand).some(answersSet)),
  );
}

/**
 * It gives the elements of a list in sorted order, so two orders of the same elements compare equal.
 * A duplicate still counts, so `[3, 3]` and `[3]` stay different. A document gives its entries in
 * the same way, so two orders of the same keys compare equal.
 */
export const inAnyOrder = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map((x) => JSON.stringify(x)).sort();
  if (isDocument(v) && !(v instanceof Date) && (v as { _bsontype?: unknown })._bsontype === undefined) {
    return Object.entries(v)
      .map((entry) => JSON.stringify(entry))
      .sort();
  }
  return v;
};
