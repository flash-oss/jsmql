export type SingleShape = { kind: "single" };
export type ArrayShape = { kind: "array" };
export type ObjectShape = { kind: "object"; keys: string[] };
export type NoneShape = { kind: "none" };
// Flex: operator accepts either a single expression OR an array of expressions.
// Used for MQL operators that legitimately have two shapes (e.g. accumulator vs
// expression context). 1 arg → `{ $op: expr }`, 2+ args → `{ $op: [a, b, ...] }`.
export type FlexShape = { kind: "flex" };

export type OperatorShape = SingleShape | ArrayShape | ObjectShape | NoneShape | FlexShape;

export type OperatorDef = {
  shape: OperatorShape;
};

const single: OperatorDef = { shape: { kind: "single" } };
const array: OperatorDef = { shape: { kind: "array" } };
const none: OperatorDef = { shape: { kind: "none" } };
const flex: OperatorDef = { shape: { kind: "flex" } };

function obj(...keys: string[]): OperatorDef {
  return { shape: { kind: "object", keys } };
}

export const OPERATORS: Record<string, OperatorDef> = {
  // ── Arithmetic ─────────────────────────────────────────────────────────────
  $abs: single,
  $add: array,
  $ceil: single,
  $divide: array,
  $exp: single,
  $floor: single,
  $ln: single,
  $log: array,
  $log10: single,
  $mod: array,
  $multiply: array,
  $pow: array,
  $round: flex,
  $sqrt: single,
  $subtract: array,
  $trunc: flex,

  // ── Trigonometry ───────────────────────────────────────────────────────────
  $sin: single,
  $cos: single,
  $tan: single,
  $asin: single,
  $acos: single,
  $atan: single,
  $atan2: array,
  $sinh: single,
  $cosh: single,
  $tanh: single,
  $asinh: single,
  $acosh: single,
  $atanh: single,
  $degreesToRadians: single,
  $radiansToDegrees: single,

  // ── Comparison ─────────────────────────────────────────────────────────────
  $cmp: array,
  $eq: array,
  $ne: array,
  $gt: array,
  $gte: array,
  $lt: array,
  $lte: array,

  // ── Boolean ────────────────────────────────────────────────────────────────
  $and: array,
  $or: array,
  $not: single,

  // ── Conditional ────────────────────────────────────────────────────────────
  // $cond has two forms: positional [if, then, else] (array) and object {if, then, else}
  // We handle both via the object-style detection in codegen; here we register the object keys
  $cond: obj("if", "then", "else"),
  $ifNull: array,
  $switch: obj("branches", "default"),

  // ── String ─────────────────────────────────────────────────────────────────
  $concat: array,
  $indexOfBytes: array,
  $indexOfCP: array,
  $ltrim: obj("input", "chars"),
  $rtrim: obj("input", "chars"),
  $trim: obj("input", "chars"),
  $regexFind: obj("input", "regex", "options"),
  $regexFindAll: obj("input", "regex", "options"),
  $regexMatch: obj("input", "regex", "options"),
  $replaceAll: obj("input", "find", "replacement"),
  $replaceOne: obj("input", "find", "replacement"),
  $split: array,
  $strLenBytes: single,
  $strLenCP: single,
  $strcasecmp: array,
  $substr: array,
  $substrBytes: array,
  $substrCP: array,
  $toLower: single,
  $toUpper: single,

  // ── Array ──────────────────────────────────────────────────────────────────
  $arrayElemAt: array,
  $arrayToObject: single,
  $concatArrays: array,
  $filter: obj("input", "as", "cond", "limit"),
  $first: single,
  $in: array,
  $indexOfArray: array,
  $isArray: single,
  $last: single,
  $map: obj("input", "as", "in"),
  $maxN: obj("input", "n"),
  $minN: obj("input", "n"),
  $objectToArray: single,
  $range: array,
  $reduce: obj("input", "initialValue", "in"),
  $reverseArray: single,
  $size: single,
  $slice: array,
  $sortArray: obj("input", "sortBy"),
  $zip: obj("inputs", "useLongestLength", "defaults"),

  // ── Set ────────────────────────────────────────────────────────────────────
  $allElementsTrue: single,
  $anyElementTrue: single,
  $setDifference: array,
  $setEquals: array,
  $setIntersection: array,
  $setIsSubset: array,
  $setUnion: array,

  // ── Object ─────────────────────────────────────────────────────────────────
  $getField: obj("field", "input"),
  $mergeObjects: flex,
  $objectToArray2: single, // alias already listed above
  $setField: obj("field", "input", "value"),
  $unsetField: obj("field", "input"),

  // ── Date ───────────────────────────────────────────────────────────────────
  $dateAdd: obj("startDate", "unit", "amount", "timezone"),
  $dateDiff: obj("startDate", "endDate", "unit", "startOfWeek", "timezone"),
  $dateFromParts: obj(
    "year",
    "month",
    "day",
    "hour",
    "minute",
    "second",
    "millisecond",
    "timezone",
  ),
  $dateFromString: obj("dateString", "format", "timezone", "locale", "onError", "onNull"),
  $dateSubtract: obj("startDate", "unit", "amount", "timezone"),
  $dateToString: obj("date", "format", "timezone", "onNull"),
  $dateTrunc: obj("date", "unit", "binSize", "timezone", "startOfWeek"),
  $dayOfMonth: single,
  $dayOfWeek: single,
  $dayOfYear: single,
  $hour: single,
  $isoDayOfWeek: single,
  $isoWeek: single,
  $isoWeekYear: single,
  $millisecond: single,
  $minute: single,
  $month: single,
  $second: single,
  $toDate: single,
  $week: single,
  $year: single,

  // ── Type ───────────────────────────────────────────────────────────────────
  $convert: obj("input", "to", "onError", "onNull"),
  $isNumber: single,
  $toBool: single,
  $toDecimal: single,
  $toDouble: single,
  $toInt: single,
  $toLong: single,
  $toObjectId: single,
  $toString: single,
  $type: single,

  // ── Variable ───────────────────────────────────────────────────────────────
  $let: obj("vars", "in"),

  // ── Miscellaneous ──────────────────────────────────────────────────────────
  $rand: none,
  $sampleRate: single,
  $binarySize: single,
  $bsonSize: single,

  // ── Accumulators (also valid as expression operators in some stages) ────────
  $addToSet: single,
  $avg: flex,
  $count: none,
  $max: flex,
  $min: flex,
  $push: single,
  $stdDevPop: flex,
  $stdDevSamp: flex,
  $sum: flex,
  $bottom: obj("output", "sortBy"),
  $bottomN: obj("output", "sortBy", "n"),
  $firstN: obj("input", "n"),
  $lastN: obj("input", "n"),
  $top: obj("output", "sortBy"),
  $topN: obj("output", "sortBy", "n"),
};

export function lookupOperator(name: string): OperatorDef | undefined {
  // name already includes leading $
  return OPERATORS[name];
}
