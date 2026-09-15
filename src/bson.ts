// The one place jsmql names the `bson` module.
//
// jsmql emits a *live* BSON value wherever the source spells one, because that is
// the only thing the MongoDB driver accepts in a query document. The Extended JSON
// envelope form is a client-side serialization shape the driver does NOT parse for
// queries — sent verbatim it reaches the server, which rejects it as an unknown
// operator (verified against mongod).
//
// The value comes from the caller's OWN `bson` — a peer dependency, so exactly one
// copy exists in the tree and the value jsmql hands back is interchangeable with
// every other module's. See docs/specs/bson-types.md.
//
// CONSTRUCTION uses these classes. RECOGNITION does not trust them alone: a value
// can arrive from a second copy of `bson` (a monorepo pinning the other major), or
// from a server response, which MongoDB's own shell documentation warns is assigned
// a different base class than a user-supplied value. So `isBsonType` tests the
// prototype AND the `_bsontype` tag, and either one answers yes.
export { Decimal128, Double, Int32, Long, MaxKey, MinKey, ObjectId, UUID } from "bson";

import { bsonTagOf } from "./registry/vocabulary.ts";
import {
  Binary,
  Decimal128 as Decimal128Class,
  Double as DoubleClass,
  Int32 as Int32Class,
  Long as LongClass,
  MaxKey as MaxKeyClass,
  MinKey as MinKeyClass,
  ObjectId as ObjectIdClass,
  UUID,
} from "bson";

// The tag reader needs no `bson` import, so it lives in the registry's vocabulary
// where a ROW can read it as well. Re-exported here so the compiler has one name.
export { bsonTagOf, BSON_KIND } from "./registry/vocabulary.ts";

/**
 * Is `v` the named BSON type? `cls` is the class from THIS copy of `bson`; `tag` is
 * the `_bsontype` any copy sets. Either match answers yes — see the header.
 */
export function isBsonType(v: unknown, cls: abstract new (...args: never[]) => object, tag: string): boolean {
  return v instanceof cls || bsonTagOf(v) === tag;
}

/**
 * Is `v` a UUID? The one type the tag cannot answer alone: a UUID reports
 * `_bsontype: "Binary"`, so a value from another copy is known only by its subtype.
 */
export function isUUID(v: unknown): boolean {
  return v instanceof UUID || (bsonTagOf(v) === "Binary" && (v as Binary).sub_type === 4);
}

/** Is `v` an ObjectId — this copy's class, or any copy's tag? */
export function isObjectId(v: unknown): boolean {
  return isBsonType(v, ObjectIdClass, "ObjectId");
}

/**
 * The 24-hex spelling of an ObjectId-shaped value, or null when the value wears the
 * tag but carries no id behind it.
 *
 * Read DEFENSIVELY, and every caller goes through here. A plain object may wear the
 * tag — the compiler passes an injected `{ _bsontype: "ObjectId", id: "xyz" }` through
 * as the value it is — and calling the class's method on it throws. Three readings,
 * widest first: the method every copy provides, the 12 raw bytes, the printed form.
 */
export function objectIdHex(value: unknown): string | null {
  const v = value as { toHexString?: () => string; id?: unknown; toString?: () => string };
  if (typeof v.toHexString === "function") return v.toHexString().toLowerCase();
  if (v.id instanceof Uint8Array && v.id.length === 12) {
    return [...v.id].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  if (typeof v.toString === "function") {
    const s = v.toString();
    if (/^[0-9a-fA-F]{24}$/.test(s)) return s.toLowerCase();
  }
  return null;
}

// ── building a constant ──────────────────────────────────────────────────────

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/**
 * The exact integer `v` names, or null when it names none.
 *
 * `bson` does NOT refuse what it cannot hold — MEASURED, `new Int32(5000000000)` is
 * 705032704 and `Long.fromString("1.5")` is 1. A wrapped integer in an analytics
 * report is undetectable, so jsmql reads the value itself and lets the row refuse.
 * A JavaScript number past 2^53 has already lost the integer it was written as, so
 * it names none — the same line the fold holds for `(2 ** 60) + 1`.
 */
function exactInteger(v: unknown): bigint | null {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return Number.isSafeInteger(v) ? BigInt(v) : null;
  if (typeof v === "string" && /^[+-]?\d+$/.test(v.trim())) return BigInt(v.trim());
  return null;
}

/** The finite number `v` names, or null. A numeric string counts — mongosh's `Double("1.5")` does too. */
function finiteNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Run a `bson` constructor that throws on bad input, and answer null instead. */
function attempt<T>(build: () => T): T | null {
  try {
    return build();
  } catch {
    return null;
  }
}

/**
 * The live BSON value `name(value)` builds, or null when it builds none — a
 * malformed constant, or one the type cannot hold.
 *
 * Null is not an error: the caller is the FOLD, and a fold that cannot answer
 * leaves the call standing so the name's row refuses it at its source position,
 * with the row's own message. See docs/specs/bson-types.md.
 */
export function bsonConstant(name: string, value: unknown): object | null {
  switch (canonicalBsonName(name)) {
    case "ObjectId":
      return typeof value === "string" && /^[0-9a-fA-F]{24}$/.test(value)
        ? new ObjectIdClass(value.toLowerCase())
        : null;
    case "Decimal128": {
      // A number's shortest round-trip spelling IS the decimal the source wrote:
      // `Decimal128(0.1)` means decimal 0.1, not the double's 0.1000000000000000055.
      const text = typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : null;
      return text === null ? null : attempt(() => Decimal128Class.fromString(text));
    }
    case "Long": {
      const n = exactInteger(value);
      // `fromString` rather than `fromBigInt`: it is present in every supported major.
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

/**
 * The `bson` class name a spelling means. mongosh names four of these types
 * differently, and an analyst arrives with that spelling in hand — both compile, and
 * `jsmql.stringify` writes the `new X(…)` form for either. See docs/LANGUAGE.md.
 */
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

/** The live BSON value `name()` mints with no argument, or null when the name mints none. */
export function bsonNullary(name: string): object | null {
  if (name === "MinKey") return new MinKeyClass();
  if (name === "MaxKey") return new MaxKeyClass();
  return null;
}
