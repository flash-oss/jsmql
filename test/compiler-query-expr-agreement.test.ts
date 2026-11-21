import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoClient, type Collection } from "mongodb";
import { expr, filter } from "../src/compiler/index.ts";
import { SCRATCH_URI } from "./fixtures/config.ts";
import { liveClient } from "./fixtures/live.ts";

const URI = SCRATCH_URI;

const DOCS = [
  {
    _id: 1,
    a: "hello",
    s: "Abc",
    tags: ["red", "blue"],
    n: 7,
    o: { k: 1 },
    d: new Date("2024-06-01"),
    b: 2,
    h: [null, 1],
  },
  { _id: 2, a: 1, s: "az", tags: "red", n: 3, o: { k: 2 }, d: new Date("2023-01-01"), b: 0, it: [{ n: 5 }] },
  { _id: 3, a: 1.5, s: "", tags: [], n: 5, t: "5", b: 2, h: [], it: [{ m: 1 }] },
  { _id: 4, a: true, s: "hello", tags: ["blue"], n: 10, b: 1, h: [[null]] },
  { _id: 5, a: null, s: "Hello ", tags: ["red"], t: "abc", b: 1, h: null },
  { _id: 6, a: [1, 2, 3], s: "x", tags: ["green"], b: 2, h: [1], it: [{ n: 20 }] },
  { _id: 7, a: [{ q: 1 }], s: " x ", d: new Date("2025-01-01"), it: [] },
  { _id: 8, a: { k: 1 }, s: "abz", b: 1, it: [{ n: null }] },
  { _id: 9, a: new Date("2024-06-01"), s: "A" },
  { _id: 10 },
  { _id: 11, a: 0, s: "", tags: ["red", "blue"], b: 1 },
  { _id: 12, a: 2, s: "1", b: 2 },
  { _id: 13, a: "1", s: "Ab", b: 1 },
  { _id: 14, a: false, s: "x ", b: 1 },
];

const AGREE: readonly string[] = [
  "$.a.q == null",
  "$.a === 0",
  "$.o.k === 2",
  "$.o.k === 1 || $.n * 2 > 10",
  "$.o.k === 1 && $.b === 2",
  '$.a === "1"',
  "$.a === false",
  "$.a === null",
  "$.a !== null",
  "$.a == null",
  "$.a != null",
  "$.a === undefined",
  "$.a !== undefined",
  '$.s === ""',
  '$.s !== ""',
  "$.o.k === 1",
  '$.d > Date("2024-01-01")',
  '$.d >= Date("2024-06-01")',
  'typeof $.a === "string"',
  'typeof $.a !== "bool"',
  "$.a.isString()",
  "!$.a.isBool()",
  "$.a.isDate() || $.a.isBool()",
  "$.a.isArray()",
  "!$.a.isArray()",
  "$.a === 1 || $.b === 2",
  "$.b === 2 && $.n > 1",
  "$.a",
  "$.a && $.b",
  "$.a || $.b",
  '$.s.includes("")',
  '$.s.startsWith("")',
  '$.s.endsWith("")',
  "$.s.match(/^$/)",
  "!$.s.match(/^$/)",
  "$.s?.match(/^$/)",
  '$.s.includes("b")',
  "$.h.has(null)",
  "!$.h.has(null)",
  "$.h?.has(null)",
  "$.h.has(null) && $.h.has(1)",
  '[null, "x"].has($.s)',
  '![null, "x"].has($.s)',
  '$.s in [null, "x"]',
  "$.it.some(i => [null, 5].has(i.n))",
  "$.it.some(i => i.n.inRange(10))",
  "$.it.some(i => i.n > 2 || i.m === 1)",
  "$.it.some(i => !(i.n === 5))",
];

const SAME_QUERY: readonly string[] = [
  "!$.a",
  "$.a ? $.b === 1 : $.b === 2",
  "$.n > $.b",
  "$.n + 1 > 5",
  "$.n.abs() > 5",
  "$.a.isUUID()",
];

const ARRAY_ELEMENT_WISE =
  "The query road emits the plain query document, and MongoDB satisfies a field comparison when any ELEMENT of an array value satisfies it. The expression road compares the whole value, so an array document is selected by one road and not the other.";

const DIVERGE: readonly { src: string; why: string }[] = [
  { src: "$.a === 1", why: ARRAY_ELEMENT_WISE },
  { src: 'typeof $.a === "object"', why: ARRAY_ELEMENT_WISE },
  { src: "$.a === 1 || $.n * 2 > 10", why: ARRAY_ELEMENT_WISE },
  { src: "$.a !== 1", why: ARRAY_ELEMENT_WISE },
  { src: '$.tags === "red"', why: ARRAY_ELEMENT_WISE },
  { src: 'typeof $.a === "int"', why: ARRAY_ELEMENT_WISE },
  { src: "$.a.isNumber()", why: ARRAY_ELEMENT_WISE },
  { src: "$.a.isObject()", why: ARRAY_ELEMENT_WISE },
  { src: "$.a === 1 && $.a === 2", why: ARRAY_ELEMENT_WISE },
  { src: "!($.a === 1)", why: ARRAY_ELEMENT_WISE },
  { src: "$.a.q === undefined", why: "The same prefix array, through the presence spelling." },
  {
    src: "$.a > 1",
    why: "Ordered comparison is type-bracketed in the query language and element-wise on an array; the expression form orders across BSON types and compares the whole array (divergences 1 and 3).",
  },
  {
    src: "$.a < 1",
    why: "The query form skips missing and null; in the expression form both sort below every number (divergence 3).",
  },
];

let client: MongoClient | null = null;
let coll: Collection | null = null;

beforeAll(async () => {
  client = await liveClient();
  if (client === null) return;
  const c = client;
  coll = c.db("jsmql_compiler_query_expr_agreement").collection("t");
  await coll.deleteMany({});
  await coll.insertMany(DOCS.map((d) => ({ ...d })));
});

afterAll(async () => {
  await client?.close();
});

const ids = async (q: Record<string, unknown>): Promise<number[]> =>
  (await coll!.find(q).toArray()).map((d) => d._id as number).sort((x, y) => x - y);

async function bothRoads(src: string): Promise<{ query: number[]; expr: number[] } | null> {
  if (coll === null) return null;
  return { query: await ids(filter(src)), expr: await ids({ $expr: expr(src) }) };
}

let ran = 0;
let skipped = 0;

const sameQuery = (src: string): boolean => JSON.stringify(filter(src)) === JSON.stringify({ $expr: expr(src) });

describe("compiler — every compared source has two different queries", () => {
  it("no AGREE or DIVERGE row emits the same query on both roads", () => {
    const same = [...AGREE, ...DIVERGE.map((d) => d.src)].filter(sameQuery);
    expect(same, "move these rows to SAME_QUERY").toEqual([]);
  });

  it.each(SAME_QUERY)("%s emits one query on both roads", (src) => {
    expect(filter(src)).toEqual({ $expr: expr(src) });
  });
});

describe("compiler — the query and the expression road select the same documents", () => {
  for (const src of AGREE) {
    it(src, async () => {
      const r = await bothRoads(src);
      if (r === null) {
        skipped++;
        return;
      }
      ran++;
      expect(r.expr, src).toEqual(r.query);
    });
  }
});

describe("compiler — the documented divergences still diverge, in both directions", () => {
  for (const { src, why } of DIVERGE) {
    it(src, async () => {
      const r = await bothRoads(src);
      if (r === null) {
        skipped++;
        return;
      }
      ran++;
      expect(r.expr, `${src} no longer diverges — move it to AGREE.\n  ${why}`).not.toEqual(r.query);
    });
  }
});

describe("compiler — the agreement suite says whether it ran", () => {
  it("compared every source, or none", () => {
    expect(ran === 0 || skipped === 0).toBe(true);
    if (ran === 0)
      console.warn(`\n[agreement] no mongod on ${URI} — the query/expression agreement was NOT compared.\n`);
  });
});
