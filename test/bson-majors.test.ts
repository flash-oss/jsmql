import { describe, expect, it } from "vitest";
import * as bson6 from "bson6";
import * as bson7 from "bson";
import { createRequire } from "node:module";
import { jsmql } from "../src/index.ts";
import * as jsmqlExports from "../src/index.ts";
import { bsonTagOf, isBsonType, isObjectId, isUUID, objectIdHex } from "../src/bson.ts";

const HEX = "507f1f77bcf86cd799439011";
const UUID_TEXT = "6ac24965-7917-4323-8d44-920ad1d69b94";
const MAJORS = [["bson 6", bson6] as const, ["bson 7", bson7] as const];

const BSON_VERSION = Symbol.for("@@mdb.bson.version");

describe("bson majors — both are installed, and they are different copies", () => {
  it("shares no prototype, which is the whole point of the second lane", () => {
    expect(new bson6.ObjectId(HEX) instanceof bson7.ObjectId).toBe(false);
    expect(new bson7.ObjectId(HEX) instanceof bson6.ObjectId).toBe(false);
    expect((new bson6.ObjectId(HEX) as unknown as Record<symbol, number>)[BSON_VERSION]).toBe(6);
    expect((new bson7.ObjectId(HEX) as unknown as Record<symbol, number>)[BSON_VERSION]).toBe(7);
  });

  it("refuses to serialize a value from the other major", () => {
    expect(() => bson7.serialize({ v: new bson6.ObjectId(HEX) })).toThrow(/BSONVersionError|version/i);
  });
});

describe("bson majors — what the peer dependency does and does not buy", () => {
  it("re-exports the very classes the resolved `bson` holds", () => {
    for (const name of ["Decimal128", "Double", "Int32", "Long", "MaxKey", "MinKey", "ObjectId", "UUID"] as const) {
      expect(jsmqlExports[name], name).toBe(bson7[name]);
    }
  });

  it("serializes across the ESM/CJS split, where `instanceof` cannot", () => {
    const cjsBson = createRequire(import.meta.url)("bson") as typeof bson7;
    expect(new bson7.ObjectId(HEX) instanceof cjsBson.ObjectId).toBe(false);
    expect((new bson7.ObjectId(HEX) as unknown as Record<symbol, number>)[BSON_VERSION]).toBe(
      (new cjsBson.ObjectId(HEX) as unknown as Record<symbol, number>)[BSON_VERSION],
    );
    expect(() => cjsBson.serialize({ _id: new bson7.ObjectId(HEX) })).not.toThrow();
  });
});

describe.each(MAJORS)("%s — the behaviour src/bson.ts is built on", (_label, B) => {
  it("silently wraps what it cannot hold", () => {
    expect(new B.Int32(3.7).valueOf()).toBe(3);
    expect(new B.Int32(5000000000).valueOf()).toBe(705032704);
    expect(B.Long.fromString("1.5").toString()).toBe("1");
    expect(Number.isNaN(new B.Double("x" as unknown as number).valueOf())).toBe(true);
  });

  it("throws where jsmql lets the throw stand in for its own check", () => {
    expect(() => B.Decimal128.fromString("abc")).toThrow();
    expect(() => B.Decimal128.fromString("1.2345678901234567890123456789012345678")).toThrow();
    expect(() => new B.UUID("nothex")).toThrow();
    expect(() => new B.ObjectId("nothex")).toThrow();
  });

  it("offers the constructors src/bson.ts calls", () => {
    expect(typeof B.Decimal128.fromString).toBe("function");
    expect(typeof B.Long.fromString).toBe("function");
    expect(B.Long.fromString("9223372036854775807").toString()).toBe("9223372036854775807");
    expect(new B.ObjectId(HEX).toHexString()).toBe(HEX);
    expect(new B.UUID(UUID_TEXT).toString()).toBe(UUID_TEXT);
  });
});

describe.each(MAJORS)("%s — a value from this copy flows through the compiler", (_label, B) => {
  it("is recognised by its tag, whichever copy built it", () => {
    expect(bsonTagOf(new B.ObjectId(HEX))).toBe("ObjectId");
    expect(bsonTagOf(B.Decimal128.fromString("1.5"))).toBe("Decimal128");
    expect(bsonTagOf(new B.MinKey())).toBe("MinKey");
    expect(isObjectId(new B.ObjectId(HEX))).toBe(true);
    expect(isBsonType(B.Long.fromString("5"), bson7.Long, "Long")).toBe(true);
    expect(isUUID(new B.UUID(UUID_TEXT))).toBe(true);
    expect(objectIdHex(new B.ObjectId(HEX))).toBe(HEX);
  });

  it("reaches the query road, not $expr", () => {
    expect(jsmql.filter`$._id === ${new B.ObjectId(HEX)}`).toEqual({ _id: new bson7.ObjectId(HEX) });
    expect(jsmql.filter`$.price > ${B.Decimal128.fromString("9.99")}`).toEqual({
      price: { $gt: bson7.Decimal128.fromString("9.99") },
    });
    expect(jsmql.filter`$.grade === ${new B.MinKey()}`).toEqual({ grade: new bson7.MinKey() });
    const grade = (jsmql.filter`$.grade === ${new B.MinKey()}` as { grade: { _bsontype?: string } }).grade;
    expect(grade._bsontype).toBe("MinKey");
  });

  it("prints as the constructor call that rebuilds it", () => {
    expect(jsmql.stringify({ v: new B.ObjectId(HEX) })).toBe(`{ v: new ObjectId("${HEX}") }`);
    expect(jsmql.stringify({ v: B.Decimal128.fromString("1.50") })).toBe('{ v: new Decimal128("1.50") }');
    expect(jsmql.stringify({ v: B.Long.fromString("5") })).toBe('{ v: new Long("5") }');
    for (const text of ["9007199254740993", "9223372036854775807", "-9223372036854775808"]) {
      expect(new B.Long(text).toString()).toBe(text);
    }
    expect(jsmql.stringify({ v: new B.UUID(UUID_TEXT) })).toBe(`{ v: new UUID("${UUID_TEXT}") }`);
    expect(jsmql.stringify({ v: new B.MinKey() })).toBe("{ v: new MinKey() }");
  });
});
