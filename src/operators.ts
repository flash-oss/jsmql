export type SingleShape = { kind: "single" };
export type ArrayShape = { kind: "array" };
export type ObjectShape = { kind: "object"; keys: string[] };
export type NoneShape = { kind: "none" };
// Flex: operator accepts either a single expression OR an array of expressions.
// Used for MQL operators that legitimately have two shapes (e.g. accumulator vs
// expression context). 1 arg → `{ $op: expr }`, 2+ args → `{ $op: [a, b, ...] }`.
export type FlexShape = { kind: "flex" };

export type OperatorShape = SingleShape | ArrayShape | ObjectShape | NoneShape | FlexShape;

// ── Argument-validation metadata (the `args` dimension) ──────────────────────
// Optional per-operator rules that drive the literal-gated operator-argument
// validator in src/operator-validation.ts (the mirror of stage-validation.ts).
// Every field is optional and only consulted for the call shapes it applies to;
// an operator with no `args` is validated by shape alone (arity for none/single/
// array). See docs/specs/operator-validation.md.

/** The BSON type family a literal arg must belong to (a literal of another family is a certain violation). */
export type ArgType =
  | "number"
  | "integer"
  | "int-or-long"
  | "string"
  | "bool"
  | "object"
  | "array"
  | "date"
  | "timestamp"
  | "number-or-date";

/** A named, shared enum set resolved in operator-validation.ts, or an inline literal set.
 *  `weekday` matches case-insensitively; `regexFlags` is a per-character charset check. */
export type EnumRef = readonly string[] | "timeUnit" | "weekday" | "bsonTypeName" | "regexFlags";

export type ArgRules = {
  // ARITY of the effective operand list (positional count when >1, else the
  // single array-literal's element count). For array/flex shapes; none-shape
  // arity (0) is derived from the shape and needs no rule. `sig` is the human
  // signature for the message (e.g. "dividend, divisor").
  // `aggOnly` (the comparison operators): the arity is enforced only in
  // aggregation-expression position — as a query predicate `{ field: { $gt: v } }`
  // a single operand (or an array) is the valid single-value query form.
  arity?: { exact?: number; allowed?: readonly number[]; atLeast?: number; sig?: string; aggOnly?: boolean };
  // Per-operand / per-slot literal TYPE (date slots, numeric ops, …). A field
  // ref / op call / param NO-OPs the check (only literals are judged).
  singleType?: ArgType; // single-shape arg
  elementType?: ArgType; // every literal element of a variadic list
  positionalTypes?: readonly ArgType[]; // fixed positional slots
  // OBJECT-body rules (object form / object-shape positional). `required ∪
  // optional` is the closed key set; an out-of-set key throws didYouMean unless
  // `closedKeys: false`.
  required?: readonly string[];
  optional?: readonly string[];
  closedKeys?: boolean;
  enums?: Record<string, EnumRef>;
  keyTypes?: Record<string, ArgType>;
  keyIntBounds?: Record<string, { min?: number; max?: number }>;
  // Structural key-group rules.
  exactlyOneOf?: readonly string[];
  atLeastOneOf?: readonly string[];
  mutuallyExclusive?: readonly (readonly string[])[];
  branches?: { key: string; required: readonly string[] };
};

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
  // Optional argument-validation rules (see ArgRules). Attached via withArgs(...).
  args?: ArgRules;
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
// Attach argument-validation rules to a built def. Composes with any factory
// and with acc(...): `withArgs(single("arithmetic", "…"), { singleType: "number" })`,
// `acc(withArgs(obj("array", "…", "output", "sortBy"), { required: [...] }))`.
function withArgs(def: OperatorDef, rules: ArgRules): OperatorDef {
  return { ...def, args: rules };
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
  // A literal pairs-array argument is wrapped one level deeper in codegen
  // (`{ $arrayToObject: [pairs] }`) so MongoDB reads it as the single argument
  // rather than an argument list — see `arrayToObjectOfLiteralPairs` in codegen.ts.
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
  // Argument *types* (date slots, integer amounts, …) are validated via the
  // `args` rules below + src/operator-validation.ts — see OPERATOR_ARG_RULES.
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

// ── Argument-validation rules ────────────────────────────────────────────────
// Per-operator ArgRules, attached to the OPERATORS entries above via withArgs at
// module load (one reviewable block beats inline withArgs on 40+ multi-line
// rows). Consumed by src/operator-validation.ts; see docs/specs/operator-validation.md.
//
// `required ∪ optional` is the CLOSED key set used for object-form unknown-key
// detection — list EVERY valid key (incl. ones absent from the positional `keys`
// array, e.g. $dateFromParts' ISO parts), or set `closedKeys: false` to opt out.
// Omitted operators ($encStr* — Queryable-Encryption-gated; $hash/$hexHash —
// server 8.1+) are unverifiable on a local mongod and intentionally left
// unvalidated for now (see docs/DEFERRED.md).
const OPERATOR_ARG_RULES: Record<string, ArgRules> = {
  // ── Arity: fixed / bounded operand counts (array & flex shapes) ──
  // Only EXACT and BOUNDED-RANGE counts are declared — never an open min on a
  // variadic op ($add/$or/$concat/$setUnion accept any count, so they get no
  // rule; see the coverage-proof tests). $ifNull's min-2 is the one verified
  // lower bound. `sig` is the human signature shown in the arity message.
  $divide: { arity: { exact: 2, sig: "dividend, divisor" }, elementType: "number" },
  $mod: { arity: { exact: 2, sig: "dividend, divisor" }, elementType: "number" },
  $pow: { arity: { exact: 2, sig: "base, exponent" }, elementType: "number" },
  $log: { arity: { exact: 2, sig: "number, base" }, elementType: "number" },
  $subtract: { arity: { exact: 2, sig: "minuend, subtrahend" }, elementType: "number-or-date" },
  $atan2: { arity: { exact: 2, sig: "y, x" }, elementType: "number" },
  $cmp: { arity: { exact: 2, sig: "expr1, expr2" } },
  $round: { arity: { allowed: [1, 2], sig: "number[, place]" }, elementType: "number" },
  $trunc: { arity: { allowed: [1, 2], sig: "number[, place]" }, elementType: "number" },
  $split: { arity: { exact: 2, sig: "string, delimiter" } },
  $strcasecmp: { arity: { exact: 2, sig: "expr1, expr2" } },
  $substr: { arity: { exact: 3, sig: "string, start, length" } },
  $substrBytes: { arity: { exact: 3, sig: "string, byteIndex, byteCount" } },
  $substrCP: { arity: { exact: 3, sig: "string, cpIndex, cpCount" } },
  $indexOfBytes: { arity: { allowed: [2, 3, 4], sig: "string, substring[, start[, end]]" } },
  $indexOfCP: { arity: { allowed: [2, 3, 4], sig: "string, substring[, start[, end]]" } },
  $arrayElemAt: { arity: { exact: 2, sig: "array, index" } },
  $indexOfArray: { arity: { allowed: [2, 3, 4], sig: "array, value[, start[, end]]" } },
  $range: { arity: { allowed: [2, 3], sig: "start, end[, step]" } },
  $slice: { arity: { allowed: [2, 3], sig: "array, [position, ]count" } },
  $ifNull: { arity: { atLeast: 2, sig: "expr, replacement[, …]" } },
  $setDifference: { arity: { exact: 2, sig: "set1, set2" } },
  $setIsSubset: { arity: { exact: 2, sig: "set1, set2" } },
  // ── Comparison (agg-only arity: the 1-arg / array form is the valid QUERY form) ──
  $eq: { arity: { exact: 2, sig: "expr1, expr2", aggOnly: true } },
  $ne: { arity: { exact: 2, sig: "expr1, expr2", aggOnly: true } },
  $gt: { arity: { exact: 2, sig: "expr1, expr2", aggOnly: true } },
  $gte: { arity: { exact: 2, sig: "expr1, expr2", aggOnly: true } },
  $lt: { arity: { exact: 2, sig: "expr1, expr2", aggOnly: true } },
  $lte: { arity: { exact: 2, sig: "expr1, expr2", aggOnly: true } },
  // ── Literal types: numeric / bitwise / object / array / timestamp (all mongod-verified) ──
  // Single-shape numeric (a literal string/bool/array/object is rejected).
  $abs: { singleType: "number" },
  $ceil: { singleType: "number" },
  $floor: { singleType: "number" },
  $exp: { singleType: "number" },
  $ln: { singleType: "number" },
  $log10: { singleType: "number" },
  $sqrt: { singleType: "number" },
  $sigmoid: { singleType: "number" },
  $sin: { singleType: "number" },
  $cos: { singleType: "number" },
  $tan: { singleType: "number" },
  $asin: { singleType: "number" },
  $acos: { singleType: "number" },
  $atan: { singleType: "number" },
  $sinh: { singleType: "number" },
  $cosh: { singleType: "number" },
  $tanh: { singleType: "number" },
  $asinh: { singleType: "number" },
  $acosh: { singleType: "number" },
  $atanh: { singleType: "number" },
  $degreesToRadians: { singleType: "number" },
  $radiansToDegrees: { singleType: "number" },
  // Variadic numeric / numeric-or-date (each literal operand).
  $multiply: { elementType: "number" },
  $add: { elementType: "number-or-date" },
  // Bitwise: int or long only (a non-integer number or a string is rejected).
  $bitNot: { singleType: "int-or-long" },
  $bitAnd: { elementType: "int-or-long" },
  $bitOr: { elementType: "int-or-long" },
  $bitXor: { elementType: "int-or-long" },
  // Object / array / timestamp shape requirements.
  $mergeObjects: { elementType: "object" },
  $objectToArray: { singleType: "object" },
  $size: { singleType: "array" },
  $reverseArray: { singleType: "array" },
  $tsSecond: { singleType: "timestamp" },
  $tsIncrement: { singleType: "timestamp" },
  // ── Conditional ──
  $cond: { required: ["if", "then", "else"] },
  $switch: { required: ["branches"], optional: ["default"] },
  // ── String ──
  $ltrim: { required: ["input"], optional: ["chars"] },
  $rtrim: { required: ["input"], optional: ["chars"] },
  $trim: { required: ["input"], optional: ["chars"] },
  $regexFind: { required: ["input", "regex"], optional: ["options"], enums: { options: "regexFlags" } },
  $regexFindAll: { required: ["input", "regex"], optional: ["options"], enums: { options: "regexFlags" } },
  $regexMatch: { required: ["input", "regex"], optional: ["options"], enums: { options: "regexFlags" } },
  $replaceAll: { required: ["input", "find", "replacement"] },
  $replaceOne: { required: ["input", "find", "replacement"] },
  // ── Array ──
  $filter: { required: ["input", "cond"], optional: ["as", "limit"] },
  $firstN: { required: ["input", "n"] },
  $lastN: { required: ["input", "n"] },
  $maxN: { required: ["input", "n"] },
  $minN: { required: ["input", "n"] },
  $map: { required: ["input", "in"], optional: ["as"] },
  $reduce: { required: ["input", "initialValue", "in"] },
  $sortArray: { required: ["input", "sortBy"] },
  $zip: { required: ["inputs"], optional: ["useLongestLength", "defaults"] },
  // ── Object ──
  $getField: { required: ["field"], optional: ["input"] },
  $setField: { required: ["field", "input", "value"] },
  $unsetField: { required: ["field", "input"] },
  // ── Type ──
  $convert: { required: ["input", "to"], optional: ["onError", "onNull"], enums: { to: "bsonTypeName" } },
  // ── Date accessors (single-shape) — a literal non-date is certainly wrong ──
  $year: { singleType: "date" },
  $month: { singleType: "date" },
  $dayOfMonth: { singleType: "date" },
  $dayOfWeek: { singleType: "date" },
  $dayOfYear: { singleType: "date" },
  $hour: { singleType: "date" },
  $minute: { singleType: "date" },
  $second: { singleType: "date" },
  $millisecond: { singleType: "date" },
  $week: { singleType: "date" },
  $isoDayOfWeek: { singleType: "date" },
  $isoWeek: { singleType: "date" },
  $isoWeekYear: { singleType: "date" },
  // ── Date operators (object-shape) ── date / amount / timezone slot types
  $dateAdd: {
    required: ["startDate", "unit", "amount"],
    optional: ["timezone"],
    enums: { unit: "timeUnit" },
    keyTypes: { startDate: "date", amount: "int-or-long", timezone: "string" },
  },
  $dateSubtract: {
    required: ["startDate", "unit", "amount"],
    optional: ["timezone"],
    enums: { unit: "timeUnit" },
    keyTypes: { startDate: "date", amount: "int-or-long", timezone: "string" },
  },
  $dateDiff: {
    required: ["startDate", "endDate", "unit"],
    optional: ["startOfWeek", "timezone"],
    enums: { unit: "timeUnit", startOfWeek: "weekday" },
    keyTypes: { startDate: "date", endDate: "date", timezone: "string" },
  },
  // year-or-isoWeekYear is a structural rule (deferred); list the full key set so unknown-key works.
  $dateFromParts: {
    optional: [
      "year",
      "isoWeekYear",
      "month",
      "isoWeek",
      "day",
      "isoDayOfWeek",
      "hour",
      "minute",
      "second",
      "millisecond",
      "timezone",
    ],
  },
  $dateFromString: { required: ["dateString"], optional: ["format", "timezone", "onError", "onNull"] },
  $dateToParts: {
    required: ["date"],
    optional: ["timezone", "iso8601"],
    keyTypes: { date: "date", timezone: "string" },
  },
  $dateToString: {
    required: ["date"],
    optional: ["format", "timezone", "onNull"],
    keyTypes: { date: "date", timezone: "string" },
  },
  $dateTrunc: {
    required: ["date", "unit"],
    optional: ["binSize", "timezone", "startOfWeek"],
    enums: { unit: "timeUnit", startOfWeek: "weekday" },
    keyTypes: { date: "date", binSize: "number", timezone: "string" },
  },
  // ── Variable ──
  $let: { required: ["vars", "in"] },
  // ── Custom aggregation ──
  $function: { required: ["body", "args", "lang"], enums: { lang: ["js"] } },
  $accumulator: {
    required: ["init", "accumulate", "accumulateArgs", "merge", "lang"],
    optional: ["initArgs", "finalize"],
    enums: { lang: ["js"] },
  },
  // ── Accumulators (object-shape) ──
  $median: { required: ["input", "method"], enums: { method: ["approximate"] } },
  $percentile: { required: ["input", "p", "method"], enums: { method: ["approximate"] } },
  $bottom: { required: ["output", "sortBy"] },
  $bottomN: { required: ["output", "sortBy", "n"] },
  $top: { required: ["output", "sortBy"] },
  $topN: { required: ["output", "sortBy", "n"] },
  // ── Window (object-shape) ──
  $derivative: { required: ["input"], optional: ["unit"], enums: { unit: "timeUnit" } },
  $integral: { required: ["input"], optional: ["unit"], enums: { unit: "timeUnit" } },
  $expMovingAvg: { required: ["input"], optional: ["N", "alpha"] },
  $shift: { required: ["output", "by"], optional: ["default"] },
};

for (const [name, rules] of Object.entries(OPERATOR_ARG_RULES)) {
  if (OPERATORS[name] !== undefined) OPERATORS[name] = withArgs(OPERATORS[name], rules);
}

export function lookupOperator(name: string): OperatorDef | undefined {
  // name already includes leading $
  return OPERATORS[name];
}
