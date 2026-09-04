// The filter target must select the documents JAVASCRIPT selects.
//
// A JavaScript spelling gets JavaScript behaviour: `$.a === 1` reads the field's
// own value, where MongoDB's query language would also accept an array holding 1
// (see the rule in src/registry/vocabulary.ts § queryOwnValue). This suite is the
// oracle for that. Each source is EVALUATED as JavaScript over the fixture — the
// source with `$.` read as the document — and the ids that come back are compared
// with the ids the emitted query selects on a live mongod.
//
// The sources JavaScript answers differently sit in a table with a reason each,
// and are asserted to STILL differ, so a repair cannot land silently: it moves
// the row. Two reasons cover almost all of them, and neither is an array bug:
// JavaScript COERCES under a relational operator (`[2] > 1` is true), and
// JavaScript THROWS when a path walks through a missing intermediate.
//
// Self-skips (green) when no mongod is reachable, with an all-or-nothing guard.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoClient, type Collection } from "mongodb";
import { filter } from "../src/compiler/index.ts";

const URI = "mongodb://127.0.0.1:27017";

/** One document per shape a field can take: a scalar, every kind of array, absent, null, the wrong type. */
const DOCS = [
  { _id: 1, a: 1, s: "abyz", tags: ["vip", "x"], n: { v: 1 } },
  { _id: 2, a: 2, s: "zz", tags: "vip", n: { v: 2 } },
  { _id: 3, a: [1, 2], s: ["abyz"], tags: "a vip user", n: [{ v: 1 }] },
  { _id: 4, a: [1], s: 5, tags: [], n: [{ v: [1] }] },
  { _id: 5, a: [], s: null, tags: ["VIP"], n: { v: [1] } },
  { _id: 6, a: null, tags: [["vip"]], n: { v: null } },
  { _id: 7, a: [null], s: "AB", tags: ["a", "b"], n: {} },
  { _id: 8, a: "1", s: "ab", tags: "ab", n: { v: "1" } },
  { _id: 9, a: true, s: "", tags: 5, n: 5 },
  { _id: 10, a: [[1]], s: ["zz", "abyz"], n: { v: { w: 1 } } },
  { _id: 11, a: 1.5, tags: null },
  { _id: 12 },
  { _id: 13, a: { k: 1 }, s: { k: 1 } },
  { _id: 14, a: 4, s: "yz", tags: ["vip"], n: { v: 4 } },
];

/** Sources whose query form must select exactly what JavaScript selects. */
const AGREE: readonly string[] = [
  "$.a === 1",
  "$.a !== 1",
  '$.a === "1"',
  "$.a === true",
  "$.a === null",
  "$.a !== null",
  "$.a == null",
  "$.a != null",
  "$.a === undefined",
  "$.a !== undefined",
  "$.a > 1",
  'typeof $.a === "number"',
  'typeof $.a !== "number"',
  'typeof $.a === "string"',
  'typeof $.a === "boolean"',
  'typeof $.a === "undefined"',
  'typeof $.a !== "undefined"',
  "$.n.v === 1",
  "$.n.v > 1",
  "$.n.v === null",
  "$.n.v !== undefined",
  "$.n.v != null",
  '$.tags.includes("vip")',
  '$.tags.includes("a") && $.tags.includes("b")',
  '$.s.startsWith("ab")',
  '$.s.endsWith("yz")',
  "$.s.match(/^ab/)",
  "$.s.match(/b/)",
  '$.s.startsWith("a") && $.s.endsWith("z")',
  "$.n.some(i => i.v === 1)",
  "$.a === 1 && $.n.v === 1",
  "$.a === 1 || $.a === 2",
];

/** Sources JavaScript answers differently, and why. */
const DIVERGE: readonly { src: string; why: string }[] = [
  {
    src: "$.a >= 1",
    why: 'JavaScript COERCES under a relational operator: `[1] >= 1` is true, `"1" >= 1` is true, `true >= 1` is true. The query language brackets by type instead, and this language does not model the coercion — the same decision that leaves NaN unsupported.',
  },
  {
    src: "$.a < 2",
    why: "Coercion again, and in the other direction: `null < 2`, `[] < 2` and `[null] < 2` are all true in JavaScript, because each coerces to 0.",
  },
  {
    src: "$.a <= 1",
    why: 'Coercion: `[1] <= 1`, `"1" <= 1`, `true <= 1`, `[] <= 1` and `null <= 1` are true in JavaScript.',
  },
  {
    src: "$.a >= 1 && $.a <= 2",
    why: "Coercion, on both clauses. The two clauses merge into one field document, so the array documents JavaScript coerces are excluded once.",
  },
  {
    src: "$.a % 2 === 0",
    why: "Coercion: `null % 2`, `[] % 2` and `[null] % 2` are all 0 in JavaScript. `$mod` compares a number.",
  },
  {
    src: "$.a % 2 !== 0",
    why: "The query `$not` is generous where JavaScript is not: it selects a null, an empty array and a missing field, where JavaScript coerces each to 0 and answers false.",
  },
  {
    src: "$.n.v !== 1",
    why: "JavaScript THROWS reading `n.v` where `n` is absent, so the document is not selected; a path in this language is a path, and an absent path is absent, which `!==` satisfies.",
  },
  {
    src: "$.n.v === undefined",
    why: "The same throw: JavaScript cannot read `n.v` where `n` is absent, where this language answers that the field is absent.",
  },
  { src: "$.n.v == null", why: "The same throw, through the loose spelling." },
];

let client: MongoClient | null = null;
let coll: Collection | null = null;

beforeAll(async () => {
  try {
    const c = new MongoClient(URI, { serverSelectionTimeoutMS: 800 });
    await c.connect();
    await c.db("admin").command({ ping: 1 });
    client = c;
    coll = c.db("jsmql_compiler_js_agreement").collection("t");
    await coll.deleteMany({});
    await coll.insertMany(DOCS.map((d) => ({ ...d })));
  } catch {
    client = null;
    coll = null;
  }
});

afterAll(async () => {
  await client?.close();
});

/**
 * The source as JavaScript over one document: `$.` IS the document. A throw is
 * false — a predicate that throws selects nothing.
 */
function javascriptIds(src: string): number[] {
  const read = new Function("d", `try { return !!(${src.split("$.").join("d.")}) } catch { return false }`) as (
    d: unknown,
  ) => boolean;
  return DOCS.filter((d) => read(d)).map((d) => d._id);
}

const queryIds = async (src: string): Promise<number[]> =>
  (await coll!.find(filter(src)).toArray()).map((d) => d._id as number).sort((x, y) => x - y);

let ran = 0;
let skipped = 0;

describe("compiler — the query road selects what JavaScript selects", () => {
  for (const src of AGREE) {
    it(src, async () => {
      if (coll === null) {
        skipped++;
        return;
      }
      ran++;
      expect(await queryIds(src), `${src}\n  ${JSON.stringify(filter(src))}`).toEqual(javascriptIds(src));
    });
  }
});

describe("compiler — the sources JavaScript answers differently still differ", () => {
  for (const { src, why } of DIVERGE) {
    it(src, async () => {
      if (coll === null) {
        skipped++;
        return;
      }
      ran++;
      expect(await queryIds(src), `${src} now agrees with JavaScript — move it to AGREE.\n  ${why}`).not.toEqual(
        javascriptIds(src),
      );
    });
  }
});

describe("compiler — the JavaScript oracle says whether it ran", () => {
  it("compared every source, or none", () => {
    const total = AGREE.length + DIVERGE.length;
    expect(ran === total || skipped === total, `ran ${ran}, skipped ${skipped}, of ${total}`).toBe(true);
  });
});
