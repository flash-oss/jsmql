// The two tables of the interpreter: the operators it runs, and the operators it refuses.
//
// RULES holds one rule for each operator that the interpreter runs. Each family file
// exports its part of the table, and this file joins the parts. REFUSED holds every
// other operator that the interpreter knows about, with the one reason that it does not
// run it. An operator in neither table is unknown, and the walk refuses it too. The
// audit in test/compiler-interpret-rows.test.ts holds every row of the registry against
// these two tables.

import { internalError } from "../../errors.ts";
import type { Rule } from "./values.ts";
import { ACCUMULATE } from "./accumulate.ts";
import { ARITHMETIC } from "./arithmetic.ts";
import { ARRAY } from "./array.ts";
import { COMPARE } from "./compare.ts";
import { DATES } from "./dates.ts";
import { LOGIC } from "./logic.ts";
import { OBJECT } from "./object.ts";
import { REGEX } from "./regex.ts";
import { STRING } from "./string.ts";
import { TYPE } from "./type.ts";

const FAMILIES: readonly Record<string, Rule>[] = [
  ARITHMETIC,
  COMPARE,
  LOGIC,
  ARRAY,
  OBJECT,
  STRING,
  REGEX,
  TYPE,
  ACCUMULATE,
  DATES,
];

function join(families: readonly Record<string, Rule>[]): Readonly<Record<string, Rule>> {
  const table: Record<string, Rule> = Object.create(null);
  for (const family of families) {
    for (const [name, rule] of Object.entries(family)) {
      if (name in table) internalError(`two interpreter rules for ${name}`);
      table[name] = rule;
    }
  }
  return table;
}

/** Every operator that the interpreter runs. */
export const RULES: Readonly<Record<string, Rule>> = join(FAMILIES);

const READS_ENVIRONMENT = "It reads the environment of the server, so its value is not a constant.";
const TRANSCENDENTAL =
  "IEEE-754 specifies only the square root and the algebraic operators, so two implementations of a transcendental function can differ in the last digit.";
const CONVERSION =
  "A conversion changes the BSON type of the value, and the server alone rules on the cases that fail.";
const SPELLS_BSON = "Its answer depends on the BSON encoding of the value, which the interpreter does not model.";
const STATISTIC = "The order of summation and the method of approximation are not specified.";

/** The operators that the interpreter does not run, and the reason for each one. */
export const REFUSED: Readonly<Record<string, string>> = {
  $rand: "It returns a different value each time it runs.",
  $function: "It runs JavaScript on the server.",
  $meta: READS_ENVIRONMENT,
  $createObjectId: "It returns a different value each time it runs.",
  $currentDate: READS_ENVIRONMENT,
  $$NOW: READS_ENVIRONMENT,
  $$CLUSTER_TIME: READS_ENVIRONMENT,
  $$USER_ROLES: READS_ENVIRONMENT,
  $$ROOT: READS_ENVIRONMENT,
  $$CURRENT: READS_ENVIRONMENT,
  $$REMOVE: READS_ENVIRONMENT,
  $$DESCEND: READS_ENVIRONMENT,
  $$PRUNE: READS_ENVIRONMENT,
  $$KEEP: READS_ENVIRONMENT,
  $$SEARCH_META: READS_ENVIRONMENT,
  $sin: TRANSCENDENTAL,
  $cos: TRANSCENDENTAL,
  $tan: TRANSCENDENTAL,
  $asin: TRANSCENDENTAL,
  $acos: TRANSCENDENTAL,
  $atan: TRANSCENDENTAL,
  $atan2: TRANSCENDENTAL,
  $sinh: TRANSCENDENTAL,
  $cosh: TRANSCENDENTAL,
  $tanh: TRANSCENDENTAL,
  $asinh: TRANSCENDENTAL,
  $acosh: TRANSCENDENTAL,
  $atanh: TRANSCENDENTAL,
  $exp: TRANSCENDENTAL,
  $ln: TRANSCENDENTAL,
  $log: TRANSCENDENTAL,
  $log10: TRANSCENDENTAL,
  $sigmoid: TRANSCENDENTAL,
  $degreesToRadians: TRANSCENDENTAL,
  $radiansToDegrees: TRANSCENDENTAL,
  $toDouble: CONVERSION,
  $toLong: CONVERSION,
  $toDecimal: CONVERSION,
  $toArray: CONVERSION,
  $toObject: CONVERSION,
  $convert: CONVERSION,
  $stdDevPop: STATISTIC,
  $stdDevSamp: STATISTIC,
  $median: STATISTIC,
  $percentile: STATISTIC,
  $bsonSize: SPELLS_BSON,
  $binarySize: SPELLS_BSON,
  $hash: SPELLS_BSON,
  $hexHash: SPELLS_BSON,
  $toHashedIndexKey: SPELLS_BSON,
  $toUUID: SPELLS_BSON,
  $encStrContains: "It reads an encrypted field, which only the server can decrypt.",
  $encStrEndsWith: "It reads an encrypted field, which only the server can decrypt.",
  $encStrNormalizedEq: "It reads an encrypted field, which only the server can decrypt.",
  $encStrStartsWith: "It reads an encrypted field, which only the server can decrypt.",
  $case: "It has meaning only inside a `$switch` branch, and the rule of `$switch` reads it there.",
};
