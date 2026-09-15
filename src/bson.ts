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

import { Binary, ObjectId as ObjectIdClass, UUID } from "bson";

/** The BSON type tag a value carries, or undefined for anything else. Every `bson` class sets one. */
export function bsonTagOf(v: unknown): string | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const tag = (v as { _bsontype?: unknown })._bsontype;
  // bson 1.x spelled ObjectId's tag with an uppercase D, and jsmql reads both.
  return typeof tag === "string" ? (tag === "ObjectID" ? "ObjectId" : tag) : undefined;
}

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
