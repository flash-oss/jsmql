import type { Rule } from "./values.ts";
import { NO, isInt32, kindOf, ok } from "./values.ts";
import { positional } from "./operand.ts";
import { ObjectId, bsonTagOf, isRegExp } from "../../bson.ts";

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
