// The type operators.
//
// A number has two BSON kinds, int and double, and a JavaScript number holds
// neither. A number that the query WRITES has the kind that the driver gives it: an
// integer that a 32-bit integer holds is an int, and every other number is a double. A
// number that an operator COMPUTES has the kind that the server gives it: a
// `$divide` is always a double, and a sum that overflows 32 bits is a long. So `$type`
// answers for a written number only, and refuses a computed one.

import type { Rule } from "./values.ts";
import { NO, isInt32, kindOf, ok } from "./values.ts";
import { positional } from "./operand.ts";
import { ObjectId, bsonTagOf, isRegExp } from "../../bson.ts";

/** The `$type` name of every tagged BSON value that the interpreter carries and never reads. */
const TAGGED: Readonly<Record<string, string>> = {
  Int32: "int",
  Long: "long",
  Double: "double",
  Decimal128: "decimal",
  Binary: "binData",
  MinKey: "minKey",
  MaxKey: "maxKey",
  BSONRegExp: "regex",
};

const NUMERIC_TAGS = new Set(["Int32", "Long", "Double", "Decimal128"]);

const type = positional(
  1,
  1,
  ([v], written) => {
    switch (kindOf(v)) {
      case "null":
        return ok("null");
      case "string":
        return ok("string");
      case "boolean":
        return ok("bool");
      case "array":
        return ok("array");
      case "object":
        return ok("object");
      case "date":
        return ok("date");
      case "objectId":
        return ok("objectId");
      case "number":
        if (typeof written[0] !== "number") return NO;
        return ok(isInt32(v) ? "int" : "double");
      default: {
        const name = isRegExp(v) ? "regex" : TAGGED[bsonTagOf(v) ?? ""];
        return name === undefined ? NO : ok(name);
      }
    }
  },
  true,
);

const isNumber = positional(1, 1, ([v]) => ok(kindOf(v) === "number" || NUMERIC_TAGS.has(bsonTagOf(v) ?? "")), true);

/** `$toBool` is false for 0, and null for null. Every other value that the interpreter reads is true. */
const toBool = positional(
  1,
  1,
  ([v]) => {
    switch (kindOf(v)) {
      case "null":
        return ok(null);
      case "number":
        return ok(v !== 0);
      case "boolean":
        return ok(v);
      case "string":
      case "array":
      case "object":
      case "date":
      case "objectId":
        return ok(true);
      default:
        return NO;
    }
  },
  true,
);

const toObjectId = positional(1, 1, ([v]) => {
  if (v === null || kindOf(v) === "objectId") return ok(v);
  return typeof v === "string" && /^[0-9a-fA-F]{24}$/.test(v) ? ok(new ObjectId(v)) : NO;
});

/**
 * `$toInt` of a number cuts the fraction, and fails when the number itself is beyond 32 bits: the
 * server fails on 2147483647.5. A boolean is 1 or 0. A string is a run of ASCII digits with an optional
 * sign and no space, and it fails beyond 32 bits too. Every other value, a Long and a Decimal128 included, is a refusal.
 */
const toInt = positional(1, 1, ([v]) => {
  if (v === null) return ok(null);
  if (typeof v === "boolean") return ok(v ? 1 : 0);
  if (typeof v === "number") return v >= -0x80000000 && v <= 0x7fffffff ? ok(Math.trunc(v) + 0) : NO;
  if (typeof v !== "string" || !/^[+-]?[0-9]+$/.test(v)) return NO;
  const n = Number(v);
  return isInt32(n) ? ok(n + 0) : NO;
});

export const TYPE: Record<string, Rule> = {
  $type: type,
  $isNumber: isNumber,
  $toBool: toBool,
  $toObjectId: toObjectId,
  $toInt: toInt,
};
