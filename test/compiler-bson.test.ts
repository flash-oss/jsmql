import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BSONRegExp,
  DBRef,
  Decimal128,
  Double,
  Int32,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  UUID,
  type Collection,
} from "mongodb";
import mongoose from "mongoose";
import { jsmql } from "../src/index.ts";
import { liveClient, liveUp } from "./fixtures/live.ts";

const up = await liveUp();

const HEX = "507f1f77bcf86cd799439011";

const bsonType = (v: unknown): unknown => (v as { _bsontype?: unknown })._bsontype;
const UUID_TEXT = "6ac24965-7917-4323-8d44-920ad1d69b94";

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
    expect(bsonType((jsmql.filter("$.count === Int32(3)") as { count: unknown }).count)).toBe("Int32");
    expect(bsonType((jsmql.filter("$.ratio === Double(1)") as { ratio: unknown }).ratio)).toBe("Double");
    expect(bsonType((jsmql.filter("$.grade === MinKey()") as { grade: unknown }).grade)).toBe("MinKey");
    expect(bsonType((jsmql.filter("$.grade < MaxKey()") as { grade: { $lt: unknown } }).grade.$lt)).toBe("MaxKey");
  });

  it("matches an ELEMENT of an array field", () => {
    expect(filter(`$.tags === Long("5")`)).toEqual({ tags: Long.fromString("5") });
  });

  it("takes the mongosh names, and refuses `new` (HR8)", () => {
    expect(() => jsmql.filter(`$.price === new Decimal128("9.99")`)).toThrow(
      "JSMQL has no 'new' keyword. Write 'Decimal128(…)'.",
    );
    expect(jsmql.filter(`$.price === NumberDecimal("9.99")`)).toEqual(jsmql.filter(`$.price === Decimal128("9.99")`));
    expect(jsmql.filter(`$.n === NumberLong("9007199254740993")`)).toEqual(
      jsmql.filter(`$.n === Long("9007199254740993")`),
    );
    expect(jsmql.filter("$.count === NumberInt(3)")).toEqual(jsmql.filter("$.count === Int32(3)"));
    expect(jsmql.filter(`$.t > ISODate("2020-01-01")`)).toEqual(jsmql.filter(`$.t > Date("2020-01-01")`));
    expect(jsmql.pipeline("$.a = Date();")).toEqual([{ $set: { a: "$$NOW" } }]);
  });

  it("refuses a value of the document, and names the value's own conversion method", () => {
    expect(() => jsmql.pipeline("$.a = Decimal128($.numText);")).toThrow(/Write '<value>\.toDecimal\(\)'/);
    expect(() => jsmql.pipeline("$.a = Long($.numText);")).toThrow(/Write '<value>\.toLong\(\)'/);
    expect(() => jsmql.pipeline("$.a = Int32($.numText);")).toThrow(/Write '<value>\.toInt\(\)'/);
    expect(() => jsmql.pipeline("$.a = Double($.numText);")).toThrow(/Write '<value>\.toDouble\(\)'/);
    expect(() => jsmql.pipeline("$.a = ObjectId($.hexText);")).toThrow(/Write '<value>\.toObjectId\(\)'/);
    expect(pipeline("$.a = $.numText.toDecimal();")).toEqual([
      { $set: { a: { $toDecimal: { $ifNull: ["$numText", 0] } } } },
    ]);
    expect(pipeline("$.a = $.numText.toLong();")).toEqual([{ $set: { a: { $toLong: { $ifNull: ["$numText", 0] } } } }]);
    expect(pipeline("$.a = $.hexText.toObjectId();")).toEqual([{ $set: { a: { $toObjectId: "$hexText" } } }]);
  });
});

describe("compiler — a BSON number is a number to the checker and a value to the fold", () => {
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

  it("folds an exact read", () => {
    expect(jsmql.pipeline(`$.a = Decimal128("1.50").toString();`)).toEqual([{ $set: { a: "1.50" } }]);
    expect(jsmql.pipeline(`$.a = Long("5").toString();`)).toEqual([{ $set: { a: "5" } }]);
    expect(jsmql.pipeline(`$.a = ObjectId("${HEX}").toString();`)).toEqual([{ $set: { a: HEX } }]);
  });
});

describe("compiler — jsmql refuses what bson would silently corrupt", () => {
  it("names the type that holds the value", () => {
    expect(() => jsmql.pipeline("$.a = Int32(5000000000);")).toThrow(/32-bit range.*Write 'Long\(…\)'/s);
    expect(() => jsmql.pipeline("$.a = Int32(3.7);")).toThrow(/not a whole number.*'Double\(…\)'/s);
    expect(() => jsmql.pipeline(`$.a = Long("1.5");`)).toThrow(/64-bit range.*'Decimal128\(…\)'/s);
    expect(() => jsmql.pipeline(`$.a = Long("99999999999999999999");`)).toThrow(/64-bit range/);
    expect(() => jsmql.pipeline(`$.a = Decimal128("abc");`)).toThrow(/not a decimal/);
    expect(() => jsmql.pipeline(`$.a = Double("x");`)).toThrow(/not a finite number/);
    expect(() => jsmql.pipeline(`$.a = UUID("nothex");`)).toThrow(/not a UUID/);
  });

  it("reports the source position of the call's argument list", () => {
    const src = "$.a = Int32(5000000000);";
    const { valid, errors } = jsmql.validate(src);
    expect(valid).toBe(false);
    expect(errors[0].pos).toBe(src.indexOf("(5000000000)"));
  });

  it("points a too-large number literal at the spellings that keep it", () => {
    expect(() => jsmql.pipeline("$.a = Long(9007199254740993);")).toThrow(/spell it as a string.*BigInt/s);
  });
});

const OWN_TYPE: readonly [string, unknown][] = [
  [
    `$.x = 0x${HEX}; $.r = $.x.toObjectId();`,
    [{ $set: { x: new ObjectId(HEX) } }, { $set: { r: { $toObjectId: "$x" } } }],
  ],
  [
    `$.x = Long("9007199254740993"); $.r = $.x.toLong();`,
    [{ $set: { x: Long.fromString("9007199254740993") } }, { $set: { r: { $toLong: "$x" } } }],
  ],
  [
    "$.x = Double(1.5); $.r = $.x.toDouble();",
    [{ $set: { x: new Double(1.5) } }, { $set: { r: { $toDouble: "$x" } } }],
  ],
  [
    `$.x = Decimal128("0.1"); $.r = $.x.toDecimal();`,
    [{ $set: { x: Decimal128.fromString("0.1") } }, { $set: { r: { $toDecimal: "$x" } } }],
  ],
  ["$.x = Int32(3); $.r = $.x.toInt();", [{ $set: { x: new Int32(3) } }, { $set: { r: { $toInt: "$x" } } }]],
  [
    `$.x = UUID("${UUID_TEXT}"); $.r = $.x.toUUID();`,
    [{ $set: { x: new UUID(UUID_TEXT) } }, { $set: { r: { $toUUID: "$x" } } }],
  ],
  [
    `$.x = Date("2024-01-01"); $.r = $.x.toDate();`,
    [{ $set: { x: new Date("2024-01-01") } }, { $set: { r: { $toDate: "$x" } } }],
  ],
  [`$.x = "a"; $.r = $.x.toString();`, [{ $set: { x: "a" } }, { $set: { r: { $toString: "$x" } } }]],
  ["$.x = true; $.r = !!$.x;", [{ $set: { x: true } }, { $set: { r: "$x" } }]],
  ["$.x = 1.5; $.r = $.x.toDouble();", [{ $set: { x: 1.5 } }, { $set: { r: { $toDouble: "$x" } } }]],
];

describe("compiler — a conversion takes a value of its own type", () => {
  it("converts a field that an earlier stage proved to hold the type", () => {
    for (const [src, mql] of OWN_TYPE) expect(pipeline(src), src).toEqual(mql);
  });

  it("refuses a type name over a value of its own type", () => {
    expect(() => jsmql.pipeline(`$.r = Long(Long("5"));`)).toThrow(/'Long\(<constant>\)'/);
    expect(() => jsmql.pipeline(`$.r = UUID(UUID("${UUID_TEXT}"));`)).toThrow(
      /'UUID\(\)' argument 1 takes a string, but got binary data\./,
    );
    expect(() => jsmql.pipeline(`$.x = Date("2024-01-01"); $.r = Long($.x);`)).toThrow(/Write '<value>\.toLong\(\)'/);
    expect(() => jsmql.pipeline(`$.x = UUID("${UUID_TEXT}"); $.r = ObjectId($.x);`)).toThrow(
      /Write '<value>\.toObjectId\(\)'/,
    );
  });
});

describe.skipIf(!up)("compiler — a conversion of a value of its own type gives the value back", () => {
  it("answers the same type and an equal value", async () => {
    for (const [src] of OWN_TYPE) {
      const stages = [...(jsmql.pipeline(src) as Record<string, unknown>[]), { $project: { x: 1, r: 1 } }];
      const [d] = await coll!.aggregate(stages).toArray();
      expect(bsonType(d.r), src).toBe(bsonType(d.x));
      expect(String(d.r), src).toBe(String(d.x));
    }
  });
});

describe.skipIf(!up)("compiler — the server accepts every document above", () => {
  it("runs each filter and pipeline", async () => {
    const problems: string[] = [];
    for (const src of FILTERS) {
      try {
        await coll!.find(jsmql.filter(src) as Record<string, unknown>).toArray();
      } catch (e) {
        problems.push(`${src}\n  ${(e as Error).message}`);
      }
    }
    for (const src of PIPELINES) {
      try {
        await coll!.aggregate(jsmql.pipeline(src) as Record<string, unknown>[]).toArray();
      } catch (e) {
        problems.push(`${src}\n  ${(e as Error).message}`);
      }
    }
    expect(problems, `${problems.length} of ${FILTERS.length + PIPELINES.length}:\n${problems.join("\n")}`).toEqual([]);
  });
});

describe.skipIf(!up)("compiler — each constant finds the stored document", () => {
  it("finds the document by each constant, so the value really is the one stored", async () => {
    expect(coll).not.toBeNull();
    for (const src of [
      `$.price === Decimal128("9.99")`,
      `$.n === Long("9007199254740993")`,
      "$.count === Int32(3)",
      `$.id === UUID("${UUID_TEXT}")`,
      `$.oid === 0x${HEX}`,
      "$.grade === MinKey()",
      `$.tags === Long("5")`,
    ]) {
      const found = await coll!.find(jsmql.filter(src) as Record<string, unknown>).toArray();
      expect(
        found.map((d) => d._id),
        src,
      ).toEqual([1]);
    }
  });
});

describe("compiler — a passed-in DBRef is a value in every slot", () => {
  const ref = new DBRef("users", new ObjectId(HEX));

  it("takes $literal where the server evaluates the slot", () => {
    expect(jsmql.expr`${ref}`).toEqual({ $literal: ref });
    expect(jsmql.expr`$.ref === ${ref}`).toEqual({ $eq: ["$ref", { $literal: ref }] });
    expect(jsmql.pipeline`$set({ x: ${ref} });`).toEqual([{ $set: { x: { $literal: ref } } }]);
    expect(jsmql.pipeline`$.x = ${ref};`).toEqual([{ $set: { x: { $literal: ref } } }]);
    expect(jsmql.pipeline.compile(({ r }: { r: DBRef }, { $ }) => ($.x = r))({ r: ref })).toEqual([
      { $set: { x: { $literal: ref } } },
    ]);
  });

  it("stays as written in a query and in an update document", () => {
    expect(jsmql.filter`$.ref === ${ref}`).toEqual({ ref });
    expect(jsmql.pipeline`$match($.ref === ${ref});`).toEqual([{ $match: { ref } }]);
    expect(jsmql.update`$.x = ${ref}`).toEqual({ $set: { x: ref } });
  });

  it.skipIf(!up)("runs on the server, and finds the stored reference", async () => {
    const refs = client!.db("jsmql_compiler_bson").collection("dbref");
    await refs.deleteMany({});
    await refs.insertMany([
      { _id: 1, ref },
      { _id: 2, ref: new DBRef("users", new ObjectId("507f1f77bcf86cd799439012")) },
    ]);
    const ids = (docs: { _id: unknown }[]) => docs.map((d) => d._id);
    expect(ids(await refs.find(jsmql.filter`$.ref === ${ref}`).toArray())).toEqual([1]);
    expect(ids(await refs.aggregate(jsmql.pipeline`$match($.ref === ${ref});`).toArray())).toEqual([1]);
    expect(
      await refs.aggregate([{ $addFields: { v: jsmql.expr`$.ref === ${ref}` } }, { $project: { v: 1 } }]).toArray(),
    ).toEqual([
      { _id: 1, v: true },
      { _id: 2, v: false },
    ]);
    const set = await refs.aggregate(jsmql.pipeline`$set({ x: ${ref} }); $project({ x: 1 });`).toArray();
    expect(set.map((d) => (d.x as DBRef).oid.toHexString())).toEqual([HEX, HEX]);
    await refs.updateMany({ _id: 2 }, jsmql.update`$.x = ${ref}`);
    expect(((await refs.findOne({ _id: 2 }))!.x as DBRef).oid.toHexString()).toBe(HEX);
  });
});

describe("compiler — a passed-in value finds what the driver stored for it", () => {
  class Money {
    cents = 500;
    toBSON() {
      return { amount: 5 };
    }
  }

  it.skipIf(!up)("finds a stored Map, a toBSON() value and a mongoose array", async () => {
    const M = mongoose.model("CompilerBsonDriverValue", new mongoose.Schema({ tags: [String] }));
    const tags = new M({ tags: ["a", "b"] }).tags;
    const stored = client!.db("jsmql_compiler_bson").collection("driver_value");
    await stored.deleteMany({});
    await stored.insertMany([
      { _id: 1, m: new Map([["a", 1]]), p: new Money(), tags },
      { _id: 2, m: { a: 2 }, p: { amount: 6 }, tags: ["c"] },
    ]);
    const ids = async (filter: unknown) =>
      (await stored.find(filter as Record<string, unknown>).toArray()).map((d) => d._id);
    expect(await ids(jsmql`$.m === ${new Map([["a", 1]])}`)).toEqual([1]);
    expect(await ids(jsmql`$.p === ${new Money()}`)).toEqual([1]);
    expect(await ids(jsmql`$.tags === ${tags}`)).toEqual([1]);
  });
});

describe("compiler — a regex keeps its MongoDB options on the wire", () => {
  it("emits a BSONRegExp for dotAll, and a RegExp otherwise", () => {
    expect(jsmql.filter("$.s.match(/a.b/s)")).toEqual({ s: { $regex: new BSONRegExp("a.b", "s") } });
    expect(jsmql.filter("$.s.match(/a/gi)")).toEqual({ s: { $regex: /a/i } });
    expect(jsmql.filter("{ s: /a.b/s }")).toEqual({ s: new BSONRegExp("a.b", "s") });
    expect(jsmql.expr("$regexMatch({ input: $.s, regex: /a.b/is })")).toEqual({
      $regexMatch: { input: "$s", regex: new BSONRegExp("a.b", "is") },
    });
  });

  it.skipIf(!up)("selects the documents that JavaScript selects", async () => {
    const texts = client!.db("jsmql_compiler_bson").collection("regex");
    await texts.deleteMany({});
    await texts.insertMany([
      { _id: 1, s: "a\nb" },
      { _id: 2, s: "axb" },
    ]);
    for (const [src, re] of [
      ["$.s.match(/a.b/s)", /a.b/s],
      ["$.s.match(/a.b/g)", /a.b/g],
      ["{ s: /a.b/s }", /a.b/s],
    ] as const) {
      const found = await texts.find(jsmql.filter(src) as Record<string, unknown>).toArray();
      const js = ["a\nb", "axb"].flatMap((t, i) =>
        new RegExp(re.source, re.flags.replace("g", "")).test(t) ? [i + 1] : [],
      );
      expect([src, found.map((d) => d._id)]).toEqual([src, js]);
    }
  });
});
