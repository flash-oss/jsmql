// The BSON value constructors: `ObjectId`, `Decimal128`, `Long`, `Int32`,
// `Double`, `UUID`, `MinKey`, `MaxKey` and `Date`, in both spellings each.
//
// Every document here is asserted as MQL and, when a mongod is reachable, RUN —
// because a `toEqual` proves what jsmql emits and never that the server accepts it
// (HR3). This suite self-skips (green) without a server. See docs/specs/bson-types.md.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Decimal128, Double, Int32, Long, MaxKey, MinKey, ObjectId, UUID, type Collection } from "mongodb";
import { jsmql } from "../src/index.ts";
import { liveClient } from "./fixtures/live.ts";

const HEX = "507f1f77bcf86cd799439011";
const UUID_TEXT = "6ac24965-7917-4323-8d44-920ad1d69b94";

// Built fresh per insert, never cloned: `structuredClone` drops `_bsontype`, and a
// Decimal128 as a plain object makes the server answer
// "$multiply only supports numeric types, not object" — MEASURED.
const doc = () => ({
  _id: 1,
  price: Decimal128.fromString("9.99"),
  n: Long.fromString("9007199254740993"),
  count: new Int32(3),
  ratio: new Double(1),
  id: new UUID(UUID_TEXT),
  grade: new MinKey(),
  oid: new ObjectId(HEX),
  numText: "42",
  hexText: HEX,
  tags: [Long.fromNumber(5), Long.fromNumber(7)],
});

// Each assertion also queues the document, so the live block runs every one.
const FILTERS: string[] = [];
const filter = (src: string): unknown => {
  FILTERS.push(src);
  return jsmql.filter(src);
};
const PIPELINES: string[] = [];
const pipeline = (src: string): unknown => {
  PIPELINES.push(src);
  return jsmql.pipeline(src);
};

let coll: Collection | null = null;
let client: Awaited<ReturnType<typeof liveClient>> = null;
beforeAll(async () => {
  client = await liveClient();
  if (client === null) return;
  coll = client.db("jsmql_compiler_bson").collection("t");
  await coll.deleteMany({});
  await coll.insertOne(doc());
});
afterAll(async () => {
  await client?.close();
});

describe("compiler — a BSON constant is a live value on the query road", () => {
  it("compares each type as written, not through $expr", () => {
    expect(filter(`$.price === Decimal128("9.99")`)).toEqual({ price: Decimal128.fromString("9.99") });
    expect(filter(`$.price > Decimal128("5.00")`)).toEqual({ price: { $gt: Decimal128.fromString("5.00") } });
    expect(filter(`$.n === Long("9007199254740993")`)).toEqual({ n: Long.fromString("9007199254740993") });
    expect(filter("$.count === Int32(3)")).toEqual({ count: new Int32(3) });
    expect(filter("$.ratio === Double(1)")).toEqual({ ratio: new Double(1) });
    expect(filter(`$.id === UUID("${UUID_TEXT}")`)).toEqual({ id: new UUID(UUID_TEXT) });
    expect(filter(`$.oid === 0x${HEX}`)).toEqual({ oid: new ObjectId(HEX) });
    expect(filter("$.grade === MinKey()")).toEqual({ grade: new MinKey() });
    expect(filter("$.grade < MaxKey()")).toEqual({ grade: { $lt: new MaxKey() } });
  });

  // MEASURED: for `tags: [Long(5), Long(7)]` the query road matches and
  // `{ $expr: { $eq: ["$tags", Long(5)] } }` does not — it compares the whole
  // ARRAY to a scalar. A BSON value off this road answers a different question.
  it("matches an ELEMENT of an array field", () => {
    expect(filter(`$.tags === Long("5")`)).toEqual({ tags: Long.fromString("5") });
  });

  it("takes both spellings of `new`, and the mongosh names", () => {
    expect(jsmql.filter(`$.price === new Decimal128("9.99")`)).toEqual(jsmql.filter(`$.price === Decimal128("9.99")`));
    expect(jsmql.filter(`$.price === NumberDecimal("9.99")`)).toEqual(jsmql.filter(`$.price === Decimal128("9.99")`));
    expect(jsmql.filter(`$.n === NumberLong("9007199254740993")`)).toEqual(
      jsmql.filter(`$.n === Long("9007199254740993")`),
    );
    expect(jsmql.filter("$.count === NumberInt(3)")).toEqual(jsmql.filter("$.count === Int32(3)"));
    expect(jsmql.filter(`$.t > ISODate("2020-01-01")`)).toEqual(jsmql.filter(`$.t > new Date("2020-01-01")`));
    // JavaScript's bare `Date()` answers a string; jsmql keeps the syntax, not that meaning.
    expect(jsmql.pipeline("$.a = Date();")).toEqual(jsmql.pipeline("$.a = new Date();"));
  });

  it("converts a runtime value through the type's own operator", () => {
    expect(pipeline("$.a = Decimal128($.numText);")).toEqual([{ $set: { a: { $toDecimal: "$numText" } } }]);
    expect(pipeline("$.a = Long($.numText);")).toEqual([{ $set: { a: { $toLong: "$numText" } } }]);
    expect(pipeline("$.a = Int32($.numText);")).toEqual([{ $set: { a: { $toInt: "$numText" } } }]);
    expect(pipeline("$.a = Double($.numText);")).toEqual([{ $set: { a: { $toDouble: "$numText" } } }]);
    expect(pipeline("$.a = ObjectId($.hexText);")).toEqual([{ $set: { a: { $toObjectId: "$hexText" } } }]);
  });
});

describe("compiler — a BSON number is a number to the checker and a value to the fold", () => {
  // The whole reason Decimal128 exists is that the SERVER answers 0.3 where a
  // double answers 0.30000000000000004 — MEASURED. A fold in JavaScript would
  // destroy exactly the guarantee the source asked for by writing the type.
  it("never evaluates BSON arithmetic", () => {
    expect(pipeline(`$.a = Decimal128("0.1") + Decimal128("0.2");`)).toEqual([
      { $set: { a: { $add: [Decimal128.fromString("0.1"), Decimal128.fromString("0.2")] } } },
    ]);
    expect(pipeline(`$.a = Int32(2) + Int32(3);`)).toEqual([{ $set: { a: { $add: [new Int32(2), new Int32(3)] } } }]);
  });

  it("opens the number methods, because MongoDB counts all four as numbers", () => {
    expect(pipeline(`$.a = Decimal128("1.555").round(2);`)).toEqual([
      { $set: { a: { $round: [Decimal128.fromString("1.555"), 2] } } },
    ]);
    expect(pipeline(`$.a = $.price * Decimal128("1.1");`)).toEqual([
      { $set: { a: { $multiply: ["$price", Decimal128.fromString("1.1")] } } },
    ]);
  });

  // The one fold that cannot lose anything: the text the value prints.
  it("folds an exact read", () => {
    expect(jsmql.pipeline(`$.a = Decimal128("1.50").toString();`)).toEqual([{ $set: { a: "1.50" } }]);
    expect(jsmql.pipeline(`$.a = Long("5").toString();`)).toEqual([{ $set: { a: "5" } }]);
    expect(jsmql.pipeline(`$.a = ObjectId("${HEX}").toString();`)).toEqual([{ $set: { a: HEX } }]);
  });
});

describe("compiler — jsmql refuses what bson would silently corrupt", () => {
  // MEASURED against bson 7.2.0: `new Int32(5000000000)` is 705032704 and
  // `Long.fromString("1.5")` is 1. A wrapped integer in a report is undetectable.
  it("names the type that holds the value", () => {
    expect(() => jsmql.pipeline("$.a = Int32(5000000000);")).toThrow(/32-bit range.*Write 'Long\(…\)'/s);
    expect(() => jsmql.pipeline("$.a = Int32(3.7);")).toThrow(/not a whole number.*'Double\(…\)'/s);
    expect(() => jsmql.pipeline(`$.a = Long("1.5");`)).toThrow(/64-bit range.*'Decimal128\(…\)'/s);
    expect(() => jsmql.pipeline(`$.a = Long("99999999999999999999");`)).toThrow(/64-bit range/);
    expect(() => jsmql.pipeline(`$.a = Decimal128("abc");`)).toThrow(/not a decimal/);
    expect(() => jsmql.pipeline(`$.a = Double("x");`)).toThrow(/not a finite number/);
    expect(() => jsmql.pipeline(`$.a = UUID("nothex");`)).toThrow(/not a UUID/);
  });

  it("reports the source position", () => {
    const { valid, errors } = jsmql.validate("$.a = Int32(5000000000);");
    expect(valid).toBe(false);
    expect(errors[0].pos).toBeGreaterThan(0);
  });

  // A JavaScript number past 2^53 has already lost the integer it was written as.
  it("points a too-large number literal at the spellings that keep it", () => {
    expect(() => jsmql.pipeline("$.a = Long(9007199254740993);")).toThrow(/spell it as a string.*BigInt/s);
  });
});

describe("compiler — the server accepts every document above", () => {
  it("ran each one, or none", async () => {
    if (coll === null) {
      expect(FILTERS.length + PIPELINES.length).toBeGreaterThan(0);
      return;
    }
    const problems: string[] = [];
    for (const src of FILTERS) {
      try {
        await coll.find(jsmql.filter(src) as Record<string, unknown>).toArray();
      } catch (e) {
        problems.push(`${src}\n  ${(e as Error).message}`);
      }
    }
    for (const src of PIPELINES) {
      try {
        await coll.aggregate(jsmql.pipeline(src) as Record<string, unknown>[]).toArray();
      } catch (e) {
        problems.push(`${src}\n  ${(e as Error).message}`);
      }
    }
    expect(problems, `${problems.length} of ${FILTERS.length + PIPELINES.length}:\n${problems.join("\n")}`).toEqual([]);
  });

  it("finds the document by each constant, so the value really is the one stored", async () => {
    if (coll === null) return;
    for (const src of [
      `$.price === Decimal128("9.99")`,
      `$.n === Long("9007199254740993")`,
      "$.count === Int32(3)",
      `$.id === UUID("${UUID_TEXT}")`,
      `$.oid === 0x${HEX}`,
      "$.grade === MinKey()",
      `$.tags === Long("5")`,
    ]) {
      const found = await coll.find(jsmql.filter(src) as Record<string, unknown>).toArray();
      expect(
        found.map((d) => d._id),
        src,
      ).toEqual([1]);
    }
  });
});
