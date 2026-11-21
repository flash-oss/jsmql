export { Decimal128, Double, Int32, Long, MaxKey, MinKey, ObjectId, UUID } from "bson";

import { bsonTagOf, isBytes, isPlainObject } from "./registry/vocabulary.ts";
import {
  Binary,
  BSONRegExp,
  Decimal128 as Decimal128Class,
  Double as DoubleClass,
  Int32 as Int32Class,
  Long as LongClass,
  MaxKey as MaxKeyClass,
  MinKey as MinKeyClass,
  ObjectId as ObjectIdClass,
  UUID,
} from "bson";

export { bsonTagOf, BSON_KIND, isBytes, isDate, isMap, isPlainObject, isRegExp } from "./registry/vocabulary.ts";

export function regexValue(pattern: string, options: string): RegExp | BSONRegExp {
  return options.includes("s") ? new BSONRegExp(pattern, options) : new RegExp(pattern, options);
}

export function isBsonType(v: unknown, cls: abstract new (...args: never[]) => object, tag: string): boolean {
  return v instanceof cls || bsonTagOf(v) === tag;
}

export function isUUID(v: unknown): boolean {
  return v instanceof UUID || (bsonTagOf(v) === "Binary" && (v as Binary).sub_type === 4);
}

export function isObjectId(v: unknown): boolean {
  return isBsonType(v, ObjectIdClass, "ObjectId");
}

export function objectIdHex(value: unknown): string | null {
  const v = value as { toHexString?: () => string; id?: unknown; toString?: () => string };
  if (typeof v.toHexString === "function") return v.toHexString().toLowerCase();
  if (isBytes(v.id) && v.id.length === 12) {
    return [...v.id].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  if (typeof v.toString === "function") {
    const s = v.toString();
    if (/^[0-9a-fA-F]{24}$/.test(s)) return s.toLowerCase();
  }
  return null;
}

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

function exactInteger(v: unknown): bigint | null {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return Number.isSafeInteger(v) ? BigInt(v) : null;
  if (typeof v === "string" && /^[+-]?\d+$/.test(v.trim())) return BigInt(v.trim());
  return null;
}

function finiteNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function attempt<T>(build: () => T): T | null {
  try {
    return build();
  } catch {
    return null;
  }
}

export function bsonConstant(name: string, value: unknown): object | null {
  switch (canonicalBsonName(name)) {
    case "ObjectId":
      return typeof value === "string" && /^[0-9a-fA-F]{24}$/.test(value)
        ? new ObjectIdClass(value.toLowerCase())
        : null;
    case "Decimal128": {
      const text = typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : null;
      return text === null ? null : attempt(() => Decimal128Class.fromString(text));
    }
    case "Long": {
      const n = exactInteger(value);
      return n === null || n < INT64_MIN || n > INT64_MAX ? null : attempt(() => LongClass.fromString(n.toString()));
    }
    case "Int32": {
      const n = exactInteger(value);
      return n === null || n < BigInt(INT32_MIN) || n > BigInt(INT32_MAX) ? null : new Int32Class(Number(n));
    }
    case "Double": {
      const n = finiteNumber(value);
      return n === null ? null : new DoubleClass(n);
    }
    case "UUID":
      return typeof value === "string" ? attempt(() => new UUID(value)) : null;
    default:
      return null;
  }
}

export function canonicalBsonName(spelling: string): string {
  switch (spelling) {
    case "NumberDecimal":
      return "Decimal128";
    case "NumberLong":
      return "Long";
    case "NumberInt":
      return "Int32";
    case "ISODate":
      return "Date";
    default:
      return spelling;
  }
}

export function bigIntToLong(v: bigint): object | null {
  return bsonConstant("Long", v);
}

export function longsWithin(value: unknown): { ok: true; value: unknown } | { ok: false; tooBig: bigint } {
  if (typeof value === "bigint") {
    const long = bigIntToLong(value);
    return long === null ? { ok: false, tooBig: value } : { ok: true, value: long };
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const element of value) {
      const converted = longsWithin(element);
      if (!converted.ok) return converted;
      out.push(converted.value);
    }
    return { ok: true, value: out };
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, held] of Object.entries(value)) {
      const converted = longsWithin(held);
      if (!converted.ok) return converted;
      out[key] = converted.value;
    }
    return { ok: true, value: out };
  }
  return { ok: true, value };
}

export function bsonNullary(name: string): object | null {
  if (name === "MinKey") return new MinKeyClass();
  if (name === "MaxKey") return new MaxKeyClass();
  return null;
}
