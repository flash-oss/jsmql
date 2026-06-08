export type SingleShape = { kind: "single" };
export type ArrayShape = { kind: "array" };
export type ObjectShape = { kind: "object"; keys: string[] };
export type NoneShape = { kind: "none" };
// Flex: operator accepts either a single expression OR an array of expressions.
// Used for MQL operators that legitimately have two shapes (e.g. accumulator vs
// expression context). 1 arg → `{ $op: expr }`, 2+ args → `{ $op: [a, b, ...] }`.
export type FlexShape = { kind: "flex" };

export type OperatorShape = SingleShape | ArrayShape | ObjectShape | NoneShape | FlexShape;

export const OPERATOR_CATEGORIES = [
  "arithmetic",
  "array",
  "bitwise",
  "boolean",
  "comparison",
  "conditional",
  "custom-aggregation",
  "data-size",
  "date",
  "encrypted-string",
  "literal",
  "miscellaneous",
  "object",
  "set",
  "string",
  "text",
  "timestamp",
  "trigonometry",
  "type",
  "variable",
  "window",
] as const;
export type OperatorCategory = (typeof OPERATOR_CATEGORIES)[number];

export type OperatorDef = {
  shape: OperatorShape;
  category: OperatorCategory;
  description: string;
  // Accumulator-only operators (`$push`, `$addToSet`, `$top`, …) are valid only
  // inside `$group` field-value slots or `$setWindowFields` output slots. Codegen
  // gates them on this flag — it is the single source of truth, so adding an
  // accumulator-only operator is one edit here (no shadow set in codegen). Ops
  // that have *both* expression and accumulator forms ($sum, $avg, $max, …) are
  // unrestricted and leave this unset.
  accumulatorOnly?: boolean;
};

const SINGLE: SingleShape = { kind: "single" };
const ARRAY: ArrayShape = { kind: "array" };
const NONE: NoneShape = { kind: "none" };
const FLEX: FlexShape = { kind: "flex" };

function single(category: OperatorCategory, description: string): OperatorDef {
  return { shape: SINGLE, category, description };
}
function array(category: OperatorCategory, description: string): OperatorDef {
  return { shape: ARRAY, category, description };
}
function none(category: OperatorCategory, description: string): OperatorDef {
  return { shape: NONE, category, description };
}
function flex(category: OperatorCategory, description: string): OperatorDef {
  return { shape: FLEX, category, description };
}
function obj(category: OperatorCategory, description: string, ...keys: string[]): OperatorDef {
  return { shape: { kind: "object", keys }, category, description };
}
// Mark a built operator def as accumulator-only (valid only inside `$group` /
// `$setWindowFields` output). Wraps any of the shape factories: `acc(single(...))`.
function acc(def: OperatorDef): OperatorDef {
  return { ...def, accumulatorOnly: true };
}

export const OPERATORS: Record<string, OperatorDef> = {
  // ── Arithmetic ─────────────────────────────────────────────────────────────
  $abs: single("arithmetic", "Returns the absolute value of a number."),
  $add: array("arithmetic", "Adds numbers to return the sum, or adds numbers and a date to return a new date."),
  $ceil: single("arithmetic", "Returns the smallest integer greater than or equal to the specified number."),
  $divide: array("arithmetic", "Returns the result of dividing the first number by the second."),
  $exp: single("arithmetic", "Raises e to the specified exponent."),
  $floor: single("arithmetic", "Returns the largest integer less than or equal to the specified number."),
  $ln: single("arithmetic", "Calculates the natural log of a number."),
  $log: array("arithmetic", "Calculates the log of a number in the specified base."),
  $log10: single("arithmetic", "Calculates the log base 10 of a number."),
  $mod: array("arithmetic", "Returns the remainder of the first number divided by the second."),
  $multiply: array("arithmetic", "Multiplies numbers to return the product."),
  $pow: array("arithmetic", "Raises a number to the specified exponent."),
  $round: flex("arithmetic", "Rounds a number to a whole integer or to a specified decimal place."),
  $sigmoid: single(
    "arithmetic",
    "Returns the sigmoid of a value, defined as 1 / (1 + e^(-x)). The result is between 0 and 1.",
  ),
  $sqrt: single("arithmetic", "Calculates the square root."),
  $subtract: array("arithmetic", "Returns the result of subtracting the second value from the first."),
  $trunc: flex("arithmetic", "Truncates a number to a whole integer or to a specified decimal place."),

  // ── Bitwise ────────────────────────────────────────────────────────────────
  $bitAnd: array("bitwise", "Returns the result of a bitwise AND operation on an array of int or long values."),
  $bitNot: single("bitwise", "Returns the result of a bitwise NOT operation on a single int or long value."),
  $bitOr: array("bitwise", "Returns the result of a bitwise OR operation on an array of int or long values."),
  $bitXor: array(
    "bitwise",
    "Returns the result of a bitwise XOR (exclusive or) operation on an array of int and long values.",
  ),

  // ── Trigonometry ───────────────────────────────────────────────────────────
  $sin: single("trigonometry", "Returns the sine of a value that is measured in radians."),
  $cos: single("trigonometry", "Returns the cosine of a value that is measured in radians."),
  $tan: single("trigonometry", "Returns the tangent of a value that is measured in radians."),
  $asin: single("trigonometry", "Returns the inverse sine (arc sine) of a value in radians."),
  $acos: single("trigonometry", "Returns the inverse cosine (arc cosine) of a value in radians."),
  $atan: single("trigonometry", "Returns the inverse tangent (arc tangent) of a value in radians."),
  $atan2: array(
    "trigonometry",
    "Returns the inverse tangent of y / x in radians, where y and x are the first and second arguments.",
  ),
  $sinh: single("trigonometry", "Returns the hyperbolic sine of a value measured in radians."),
  $cosh: single("trigonometry", "Returns the hyperbolic cosine of a value measured in radians."),
  $tanh: single("trigonometry", "Returns the hyperbolic tangent of a value measured in radians."),
  $asinh: single("trigonometry", "Returns the inverse hyperbolic sine of a value in radians."),
  $acosh: single("trigonometry", "Returns the inverse hyperbolic cosine of a value in radians."),
  $atanh: single("trigonometry", "Returns the inverse hyperbolic tangent of a value in radians."),
  $degreesToRadians: single("trigonometry", "Converts a value from degrees to radians."),
  $radiansToDegrees: single("trigonometry", "Converts a value from radians to degrees."),

  // ── Comparison ─────────────────────────────────────────────────────────────
  // $eq/$ne/$gt/$gte/$lt/$lte are `flex` (dual-form): a single value is the valid
  // *query* comparison `{ field: { $gt: v } }`; two args are the *aggregation*
  // operands `{ $gt: [a, b] }` (HR2). $cmp has no single-value form → `array`.
  $cmp: array("comparison", "Returns 0 if the two values are equivalent, 1 if the first is greater, and -1 if less."),
  $eq: flex("comparison", "Returns true if the values are equivalent."),
  $ne: flex("comparison", "Returns true if the values are not equivalent."),
  $gt: flex("comparison", "Returns true if the first value is greater than the second."),
  $gte: flex("comparison", "Returns true if the first value is greater than or equal to the second."),
  $lt: flex("comparison", "Returns true if the first value is less than the second."),
  $lte: flex("comparison", "Returns true if the first value is less than or equal to the second."),

  // ── Boolean ────────────────────────────────────────────────────────────────
  $and: array("boolean", "Returns true only when all its expressions evaluate to true."),
  $or: array("boolean", "Returns true when any of its expressions evaluates to true."),
  $not: single("boolean", "Returns the boolean value that is the opposite of its argument expression."),

  // ── Conditional ────────────────────────────────────────────────────────────
  $cond: obj(
    "conditional",
    "A ternary operator that evaluates one expression and returns one of two other expressions based on the result.",
    "if",
    "then",
    "else",
  ),
  $ifNull: array(
    "conditional",
    "Returns either the non-null result of the first expression or the result of the second expression.",
  ),
  $switch: obj(
    "conditional",
    "Evaluates a series of case expressions; executes the matching case's expression and breaks out of the control flow.",
    "branches",
    "default",
  ),

  // ── String ─────────────────────────────────────────────────────────────────
  $concat: array("string", "Concatenates any number of strings."),
  $indexOfBytes: array(
    "string",
    "Searches a string for a substring and returns the UTF-8 byte index of the first occurrence, or -1.",
  ),
  $indexOfCP: array(
    "string",
    "Searches a string for a substring and returns the UTF-8 code point index of the first occurrence, or -1.",
  ),
  $ltrim: obj(
    "string",
    "Removes whitespace or the specified characters from the beginning of a string.",
    "input",
    "chars",
  ),
  $rtrim: obj("string", "Removes whitespace or the specified characters from the end of a string.", "input", "chars"),
  $trim: obj(
    "string",
    "Removes whitespace or the specified characters from the beginning and end of a string.",
    "input",
    "chars",
  ),
  $regexFind: obj(
    "string",
    "Applies a regular expression to a string and returns information on the first matched substring.",
    "input",
    "regex",
    "options",
  ),
  $regexFindAll: obj(
    "string",
    "Applies a regular expression to a string and returns information on all matched substrings.",
    "input",
    "regex",
    "options",
  ),
  $regexMatch: obj(
    "string",
    "Applies a regular expression to a string and returns a boolean indicating whether a match is found.",
    "input",
    "regex",
    "options",
  ),
  $replaceAll: obj(
    "string",
    "Replaces all instances of a search string in an input string with a replacement string.",
    "input",
    "find",
    "replacement",
  ),
  $replaceOne: obj(
    "string",
    "Replaces the first instance of a matched string in a given input.",
    "input",
    "find",
    "replacement",
  ),
  $split: array("string", "Splits a string into substrings based on a delimiter and returns an array of substrings."),
  $strLenBytes: single("string", "Returns the number of UTF-8 encoded bytes in a string."),
  $strLenCP: single("string", "Returns the number of UTF-8 code points in a string."),
  $strcasecmp: array("string", "Performs case-insensitive string comparison."),
  $substr: array("string", "Deprecated. Use $substrBytes or $substrCP."),
  $substrBytes: array("string", "Returns the substring of a string starting at the specified UTF-8 byte index."),
  $substrCP: array("string", "Returns the substring of a string starting at the specified UTF-8 code point index."),
  $toLower: single("string", "Converts a string to lowercase."),
  $toUpper: single("string", "Converts a string to uppercase."),

  // ── Encrypted String (Queryable Encryption) ───────────────────────────────
  // Not in mongodb/mql-specifications as of pinned commit; allowlisted in the
  // drift test. Shapes inferred from the MongoDB documentation.
  $encStrContains: obj(
    "encrypted-string",
    "Returns true if a substring exists within the encrypted string.",
    "input",
    "substring",
  ),
  $encStrEndsWith: obj(
    "encrypted-string",
    "Returns true if the encrypted string ends with the specified suffix.",
    "input",
    "suffix",
  ),
  $encStrNormalizedEq: obj(
    "encrypted-string",
    "Returns true if the normalized encrypted string equals the specified string.",
    "input",
    "string",
  ),
  $encStrStartsWith: obj(
    "encrypted-string",
    "Returns true if the encrypted string starts with the specified prefix.",
    "input",
    "prefix",
  ),

  // ── Array ──────────────────────────────────────────────────────────────────
  $arrayElemAt: array("array", "Returns the element at the specified array index."),
  // [DEF-026] A literal multi-pair arg (`$arrayToObject([["a",1],["b",2]])`) emits
  // `{ $arrayToObject: [[…],[…]] }`, which MongoDB reads as two arguments and
  // rejects ("takes exactly 1 argument"). The single-pair form is fine. See DEFERRED.
  $arrayToObject: single("array", "Converts an array of key-value pairs to a document."),
  $concatArrays: array("array", "Concatenates arrays to return the concatenated array."),
  $filter: obj(
    "array",
    "Selects a subset of the array, returning only elements that match the filter condition.",
    "input",
    "as",
    "cond",
    "limit",
  ),
  $first: single("array", "Returns the result of an expression for the first document in an array."),
  $firstN: obj("array", "Returns a specified number of elements from the beginning of an array.", "input", "n"),
  // `flex` (dual-form): query `{ field: { $in: [v1, v2] } }` takes a single array;
  // aggregation `{ $in: [needle, haystack] }` takes two operands.
  $in: flex("array", "Returns a boolean indicating whether a specified value is in an array."),
  $indexOfArray: array("array", "Searches an array for a value and returns the index of the first occurrence, or -1."),
  $isArray: single("array", "Determines if the operand is an array."),
  $last: single("array", "Returns the result of an expression for the last document in an array."),
  $lastN: obj("array", "Returns a specified number of elements from the end of an array.", "input", "n"),
  $map: obj(
    "array",
    "Applies a subexpression to each element of an array and returns the array of resulting values.",
    "input",
    "as",
    "in",
  ),
  $maxN: obj("array", "Returns the n largest values in an array.", "input", "n"),
  $minN: obj("array", "Returns the n smallest values in an array.", "input", "n"),
  $objectToArray: single("array", "Converts a document to an array of documents representing key-value pairs."),
  $range: array("array", "Outputs an array containing a sequence of integers according to user-defined inputs."),
  $reduce: obj(
    "array",
    "Applies an expression to each element in an array and combines them into a single value.",
    "input",
    "initialValue",
    "in",
  ),
  $reverseArray: single("array", "Returns an array with the elements in reverse order."),
  $size: single("array", "Returns the number of elements in the array."),
  $slice: array("array", "Returns a subset of an array."),
  $sortArray: obj("array", "Sorts the elements of an array.", "input", "sortBy"),
  $zip: obj(
    "array",
    "Merges two or more arrays element-wise into a single array of arrays.",
    "inputs",
    "useLongestLength",
    "defaults",
  ),

  // ── Set ────────────────────────────────────────────────────────────────────
  $allElementsTrue: single("set", "Returns true if no element of a set evaluates to false."),
  $anyElementTrue: single("set", "Returns true if any elements of a set evaluate to true."),
  $setDifference: array("set", "Returns a set with elements that appear in the first set but not in the second set."),
  $setEquals: array("set", "Returns true if the input sets have the same distinct elements."),
  $setIntersection: array("set", "Returns a set with elements that appear in all of the input sets."),
  $setIsSubset: array("set", "Returns true if all elements of the first set appear in the second set."),
  $setUnion: array("set", "Returns a set with elements that appear in any of the input sets."),

  // ── Object ─────────────────────────────────────────────────────────────────
  $getField: obj(
    "object",
    "Returns the value of a specified field from a document, including fields whose names contain periods or start with $.",
    "field",
    "input",
  ),
  $mergeObjects: flex("object", "Combines multiple documents into a single document."),
  $setField: obj("object", "Adds, updates, or removes a specified field in a document.", "field", "input", "value"),
  $unsetField: obj(
    "object",
    "Removes a specified field from a document. Alias for $setField using $$REMOVE.",
    "field",
    "input",
  ),

  // ── Date ───────────────────────────────────────────────────────────────────
  $dateAdd: obj("date", "Adds a number of time units to a date object.", "startDate", "unit", "amount", "timezone"),
  $dateDiff: obj(
    "date",
    "Returns the difference between two dates.",
    "startDate",
    "endDate",
    "unit",
    "startOfWeek",
    "timezone",
  ),
  $dateFromParts: obj(
    "date",
    "Constructs a BSON Date object given the date's constituent parts.",
    "year",
    "month",
    "day",
    "hour",
    "minute",
    "second",
    "millisecond",
    "timezone",
  ),
  $dateFromString: obj(
    "date",
    "Converts a date/time string to a date object.",
    "dateString",
    "format",
    "timezone",
    "onError",
    "onNull",
  ),
  $dateSubtract: obj(
    "date",
    "Subtracts a number of time units from a date object.",
    "startDate",
    "unit",
    "amount",
    "timezone",
  ),
  $dateToParts: obj(
    "date",
    "Returns a document containing the constituent parts of a date.",
    "date",
    "timezone",
    "iso8601",
  ),
  $dateToString: obj("date", "Returns the date as a formatted string.", "date", "format", "timezone", "onNull"),
  $dateTrunc: obj("date", "Truncates a date.", "date", "unit", "binSize", "timezone", "startOfWeek"),
  $dayOfMonth: single("date", "Returns the day of the month for a date as a number between 1 and 31."),
  $dayOfWeek: single("date", "Returns the day of the week for a date as a number between 1 (Sunday) and 7 (Saturday)."),
  $dayOfYear: single("date", "Returns the day of the year for a date as a number between 1 and 366."),
  $hour: single("date", "Returns the hour for a date as a number between 0 and 23."),
  $isoDayOfWeek: single(
    "date",
    "Returns the weekday number in ISO 8601 format, ranging from 1 (Monday) to 7 (Sunday).",
  ),
  $isoWeek: single("date", "Returns the week number in ISO 8601 format, ranging from 1 to 53."),
  $isoWeekYear: single("date", "Returns the year number in ISO 8601 format."),
  $millisecond: single("date", "Returns the milliseconds of a date as a number between 0 and 999."),
  $minute: single("date", "Returns the minute for a date as a number between 0 and 59."),
  $month: single("date", "Returns the month for a date as a number between 1 (January) and 12 (December)."),
  $second: single("date", "Returns the seconds for a date as a number between 0 and 60 (leap seconds)."),
  $toDate: single("date", "Converts a value to a Date."),
  $week: single("date", "Returns the week number for a date as a number between 0 and 53."),
  $year: single("date", "Returns the year for a date as a number."),

  // ── Timestamp ──────────────────────────────────────────────────────────────
  $tsIncrement: single("timestamp", "Returns the incrementing ordinal from a timestamp as a long."),
  $tsSecond: single("timestamp", "Returns the seconds from a timestamp as a long."),

  // ── Type ───────────────────────────────────────────────────────────────────
  $convert: obj("type", "Converts a value to a specified type.", "input", "to", "onError", "onNull"),
  $isNumber: single("type", "Returns true if the expression resolves to an integer, decimal, double, or long."),
  $toArray: single("type", "Converts a value to an array."),
  $toBool: single("type", "Converts a value to a boolean."),
  $toDecimal: single("type", "Converts a value to a Decimal128."),
  $toDouble: single("type", "Converts a value to a double."),
  $toInt: single("type", "Converts a value to an integer."),
  $toLong: single("type", "Converts a value to a long."),
  $toObject: single("type", "Converts a string to an object."),
  $toObjectId: single("type", "Converts a value to an ObjectId."),
  $toString: single("type", "Converts a value to a string."),
  $toUUID: single("type", "Converts a string to a UUID."),
  $type: single("type", "Returns the BSON data type of the field."),

  // ── Literal ────────────────────────────────────────────────────────────────
  $literal: single(
    "literal",
    "Returns a value without parsing. Use to keep values that the pipeline would otherwise interpret as expressions (e.g. strings starting with $).",
  ),

  // ── Variable ───────────────────────────────────────────────────────────────
  $let: obj(
    "variable",
    "Defines variables for use within the scope of a subexpression and returns the result.",
    "vars",
    "in",
  ),

  // ── Custom Aggregation ─────────────────────────────────────────────────────
  $accumulator: acc(
    obj(
      "custom-aggregation",
      "Defines a custom accumulator function. Body fields hold JavaScript source executed by the server.",
      "init",
      "initArgs",
      "accumulate",
      "accumulateArgs",
      "merge",
      "finalize",
      "lang",
    ),
  ),
  $function: obj(
    "custom-aggregation",
    "Defines a custom function. The body field is JavaScript source executed by the server.",
    "body",
    "args",
    "lang",
  ),

  // ── Data Size ──────────────────────────────────────────────────────────────
  $binarySize: single("data-size", "Returns the size of a string or binary data value's content in bytes."),
  $bsonSize: single("data-size", "Returns the size in bytes of a document when encoded as BSON."),

  // ── Text ───────────────────────────────────────────────────────────────────
  $meta: single(
    "text",
    'Accesses per-document metadata related to the aggregation operation. Argument is a keyword string (e.g. "textScore"), not an arbitrary expression.',
  ),

  // ── Miscellaneous ──────────────────────────────────────────────────────────
  $createObjectId: none("miscellaneous", "Returns a random ObjectId."),
  $hash: obj(
    "miscellaneous",
    "Generates a binary hash value (BinData) from a UTF-8 string or binary data.",
    "input",
    "algorithm",
  ),
  $hexHash: obj(
    "miscellaneous",
    "Generates an uppercase hexadecimal hash string from a UTF-8 string or binary data.",
    "input",
    "algorithm",
  ),
  $rand: none("miscellaneous", "Returns a random float between 0 and 1."),
  $sampleRate: single("miscellaneous", "Randomly selects documents at a given rate. Used inside $match."),
  $toHashedIndexKey: single(
    "miscellaneous",
    "Computes the hash of the input expression using MongoDB's hashed-index hash function.",
  ),

  // ── Accumulators (also valid as expression operators in some stages) ──────
  $addToSet: acc(single("array", "Returns an array of unique expression values for each group.")),
  $avg: flex("arithmetic", "Returns the average for the specified expression."),
  $count: none("array", "Returns the number of documents in the group or window."),
  $max: flex("comparison", "Returns the maximum value that results from applying an expression."),
  $median: acc(
    obj("arithmetic", "Returns an approximation of the median (50th percentile) as a scalar value.", "input", "method"),
  ),
  $min: flex("comparison", "Returns the minimum value that results from applying an expression."),
  $percentile: acc(
    obj(
      "arithmetic",
      "Returns an array of scalar values that correspond to specified percentile values.",
      "input",
      "p",
      "method",
    ),
  ),
  $push: acc(single("array", "Returns an array of values that result from applying an expression.")),
  $stdDevPop: flex("arithmetic", "Calculates the population standard deviation of the input values."),
  $stdDevSamp: flex("arithmetic", "Calculates the sample standard deviation of the input values."),
  $sum: flex("arithmetic", "Returns a sum of numerical values, ignoring non-numeric values."),
  $bottom: acc(
    obj(
      "array",
      "Returns the bottom element within a group according to the specified sort order.",
      "output",
      "sortBy",
    ),
  ),
  $bottomN: acc(
    obj(
      "array",
      "Returns an aggregation of the bottom n elements within a group, according to the specified sort order.",
      "output",
      "sortBy",
      "n",
    ),
  ),
  $top: acc(
    obj("array", "Returns the top element within a group according to the specified sort order.", "output", "sortBy"),
  ),
  $topN: acc(
    obj(
      "array",
      "Returns an aggregation of the top n fields within a group, according to the specified sort order.",
      "output",
      "sortBy",
      "n",
    ),
  ),

  // ── Window (only valid inside $setWindowFields) ───────────────────────────
  $covariancePop: array("window", "Returns the population covariance of two numeric expressions."),
  $covarianceSamp: array("window", "Returns the sample covariance of two numeric expressions."),
  $denseRank: none(
    "window",
    "Returns the document position (rank) within the partition. There are no gaps; ties receive the same rank.",
  ),
  $derivative: obj("window", "Returns the average rate of change within the specified window.", "input", "unit"),
  $documentNumber: none(
    "window",
    "Returns the position of a document in the $setWindowFields partition. Ties produce different adjacent numbers.",
  ),
  $expMovingAvg: obj(
    "window",
    "Returns the exponential moving average for the numeric expression.",
    "input",
    "N",
    "alpha",
  ),
  $integral: obj("window", "Returns the approximation of the area under a curve.", "input", "unit"),
  $linearFill: single(
    "window",
    "Fills null and missing fields in a window using linear interpolation based on surrounding field values.",
  ),
  $locf: single(
    "window",
    "Last observation carried forward — sets null/missing fields in a window to the last non-null value.",
  ),
  $rank: none("window", "Returns the document position (rank) within the $setWindowFields partition."),
  $shift: obj(
    "window",
    "Returns the value from an expression applied to a document in a specified position relative to the current document.",
    "output",
    "by",
    "default",
  ),
};

export function lookupOperator(name: string): OperatorDef | undefined {
  // name already includes leading $
  return OPERATORS[name];
}
