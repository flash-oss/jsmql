// A minimal, dependency-free MongoDB ObjectId value.
//
// jsmql emits a *live* BSON value for an in-source `ObjectId("…")` /
// `new ObjectId("…")` literal, because that is the only thing the MongoDB
// driver accepts in a query document. The Extended JSON envelope form of an
// ObjectId is a client-side serialization shape the driver does NOT parse for
// queries — sent verbatim it reaches the server, which rejects it as an
// unknown operator (verified against mongod). So the value has to arrive as a
// real ObjectId instance, the same shape the template-tag / `.compile()`
// interpolation paths already pass through (see `isOpaqueBsonValue`).
//
// We construct that value ourselves rather than importing `bson`, to preserve
// jsmql's zero-runtime-dependency stance and keep the browser playground bundle
// clean (it cannot `require("bson")`). The driver and the bson serializer accept
// any value that is duck-typed — never `instanceof bson.ObjectId` — so a
// self-made value is byte-for-byte interchangeable with a real one provided it:
//   1. tags itself with `_bsontype === "ObjectId"`,
//   2. reports the BSON major version via the `@@mdb.bson.version` registry
//      symbol (bson 7.x hard-throws `BSONVersionError` otherwise — a bare
//      `_bsontype` no longer suffices), and
//   3. implements `serializeInto(buffer, index)` writing its 12 bytes and
//      returning 12 (the serializer does `index += value.serializeInto(...)`).
//
// CAVEAT — version coupling: `BSON_MAJOR_VERSION` is hard-coded. If a consumer
// app pins a *different* bson major (e.g. a future mongodb shipping bson 8),
// serializing this value throws `BSONVersionError`. Real `ObjectId` instances
// avoid this because they ship with their matching bson. Bump the constant here
// when jsmql's supported driver moves to a new bson major.

const BSON_MAJOR_VERSION = 7;
const BSON_VERSION_SYMBOL = Symbol.for("@@mdb.bson.version");
const HEX24 = /^[0-9a-fA-F]{24}$/;

export class ObjectId {
  _bsontype = "ObjectId";
  buffer: Uint8Array;

  constructor(hex: string) {
    // The parser validates the 24-hex-char shape before constructing; this
    // guard keeps the class honest for any other caller.
    if (!HEX24.test(hex)) {
      throw new TypeError(`Invalid ObjectId hex string: ${JSON.stringify(hex)} (expected 24 hex characters)`);
    }
    const bytes = new Uint8Array(12);
    for (let i = 0; i < 12; i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    this.buffer = bytes;
  }

  // bson 7.x rejects any value whose version symbol !== its BSON_MAJOR_VERSION.
  get [BSON_VERSION_SYMBOL](): number {
    return BSON_MAJOR_VERSION;
  }

  // bson exposes `.id` as the raw 12-byte buffer; mirror it for any driver code
  // that reads bytes directly rather than through `serializeInto`.
  get id(): Uint8Array {
    return this.buffer;
  }

  toHexString(): string {
    let out = "";
    for (let i = 0; i < 12; i++) {
      out += this.buffer[i].toString(16).padStart(2, "0");
    }
    return out;
  }

  toString(): string {
    return this.toHexString();
  }

  // Extended JSON renders an ObjectId as its hex string; matching that keeps
  // `JSON.stringify` output (e.g. from the CLI) readable, even though a JSON
  // string can never round-trip back into a live BSON value.
  toJSON(): string {
    return this.toHexString();
  }

  equals(other: unknown): boolean {
    if (other === null || other === undefined) return false;
    const o = other as { toHexString?: () => string; toString?: () => string };
    const hex =
      typeof o.toHexString === "function" ? o.toHexString() : typeof o.toString === "function" ? o.toString() : null;
    return hex !== null && hex.toLowerCase() === this.toHexString();
  }

  getTimestamp(): Date {
    // First 4 bytes are a big-endian seconds-since-epoch. Use multiplication,
    // not `<<`, so the high bit doesn't make the result negative.
    const seconds = this.buffer[0] * 2 ** 24 + this.buffer[1] * 2 ** 16 + this.buffer[2] * 2 ** 8 + this.buffer[3];
    return new Date(seconds * 1000);
  }

  serializeInto(uint8array: Uint8Array, index: number): number {
    for (let i = 0; i < 12; i++) {
      uint8array[index + i] = this.buffer[i];
    }
    return 12;
  }
}
