const SET_OPERATOR = /^\$set(Union|Intersection|Difference)$/;

type Operand = unknown;

const isDocument = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const listOf = (operand: Operand): unknown[] => (Array.isArray(operand) ? operand : [operand]);

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

export function answersSet(mql: unknown): boolean {
  if (Array.isArray(mql)) return mql.some(answersSet);
  if (!isDocument(mql)) return false;
  return Object.entries(mql).some(
    ([key, operand]) => SET_OPERATOR.test(key) || (key in CARRIES && CARRIES[key](operand).some(answersSet)),
  );
}

export const inAnyOrder = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map((x) => JSON.stringify(x)).sort();
  if (isDocument(v) && !(v instanceof Date) && (v as { _bsontype?: unknown })._bsontype === undefined) {
    return Object.entries(v)
      .map((entry) => JSON.stringify(entry))
      .sort();
  }
  return v;
};
