import { MongoClient, type Collection } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jsmql } from "../src/index.ts";
import { liveClient } from "./fixtures/live.ts";

const DOCS = [
  { _id: 1, a: 5, s: "hello", t: true, n: null, d: new Date("2024-05-17T00:00:00Z") },
  { _id: 2, a: 0, s: "", t: false, n: 1, d: new Date("2020-01-01T00:00:00Z") },
  { _id: 3, a: -2, s: "Hi", t: true, d: new Date("2024-05-17T00:00:00Z") },
  { _id: 4, s: "hello world", n: null },
  { _id: 5, a: 5.5, s: "HELLO", t: false, n: "x", d: new Date("2030-01-01T00:00:00Z") },
  { _id: 6, s: "hey", items: [{ q: 5 }, { q: 1 }] },
];

const AGREE: readonly string[] = [
  "$.a === 5",
  "$.a !== 5",
  "$.a > 0",
  "$.a >= 5",
  "$.a === null",
  "$.n === null",
  "$.n !== null",
  "$.n == null",
  "$.n != null",
  "$.t === true",
  "$.t === false",
  "$.s === 'hello'",
  "$.d > Date('2024-01-01')",
  'typeof $.a === "int"',
  'typeof $.s === "string"',
  "$.a % 2 === 0",
  "$.a % 2 !== 0",
  '$.s.startsWith("he")',
  '$.s.endsWith("lo")',
  '$.s.startsWith("H")',
  '$.s.endsWith("o")',
  '$.s.startsWith("h.")',
  "$.s.match(/^he/)",
  "$.s.match(/HE/i)",
  "$.s.match(/^he/g)",
  "$.s.match(/^HE/gi)",
  '["hello", "Hi"].has($.s)',
  '$.s.includes("ell")',
  '$.s.includes("l.")',
  "$.a === undefined",
  "$.a !== undefined",
  "$.n === undefined",
  "$.n !== undefined",
  "$.items.some(i => i.q > 3)",
  "$.a > 0 && $.s === 'hello'",
  "$.a > 0 || $.t === false",
  "!($.a > 0)",
];

const SAME_QUERY: readonly string[] = [
  "/^he/.test($.s)",
  "$.s.length() === 5",
  "$.s.length() > 2",
  "$.items.every(i => i.q > 3)",
];

const DIVERGE: readonly { src: string; why: string }[] = [
  {
    src: "$.a < 0",
    why:
      "Ordered comparison against a MISSING field. The query form `{a:{$lt:0}}` requires the " +
      "field to exist; the expression form compares `$a` as missing, which sorts BEFORE every " +
      "number in BSON order, so `missing < 0` is true. Documented in emit-pass.md § The filter target.",
  },
  { src: "$.a <= 0", why: "Same as `<` — ordered comparison against a missing field." },
];

let client: MongoClient | null = null;
let coll: Collection | null = null;

beforeAll(async () => {
  client = await liveClient();
  if (client === null) return;
  const c = client;
  coll = c.db("jsmql_query_expr_agreement").collection("t");
  await coll.deleteMany({});
  await coll.insertMany(DOCS.map((d) => ({ ...d })));
});

afterAll(async () => {
  await client?.close();
});

const ids = (rows: { _id: unknown }[]): number[] => rows.map((r) => r._id as number).sort((x, y) => x - y);

async function bothSides(src: string): Promise<{ query: number[]; expr: number[] } | null> {
  if (coll === null) return null;
  const query = ids(await coll.find(jsmql(src) as Record<string, unknown>).toArray());
  const rows = await coll.aggregate([{ $addFields: { __v: jsmql.expr(src) } }, { $match: { __v: true } }]).toArray();
  return { query, expr: ids(rows) };
}

const sameQuery = (src: string): boolean => JSON.stringify(jsmql(src)) === JSON.stringify({ $expr: jsmql.expr(src) });

describe("every compared predicate has two different queries", () => {
  it("no AGREE or DIVERGE row emits the same query on both sides", () => {
    const same = [...AGREE, ...DIVERGE.map((d) => d.src)].filter(sameQuery);
    expect(same, "move these rows to SAME_QUERY").toEqual([]);
  });

  it.each(SAME_QUERY)("%s emits one query on both sides", (src) => {
    expect(jsmql(src)).toEqual({ $expr: jsmql.expr(src) });
  });
});

describe("the Query and Expr targets select the same documents", () => {
  let compared = 0;

  for (const src of AGREE) {
    it(src, async () => {
      const r = await bothSides(src);
      if (r === null) return;
      compared++;
      expect(r.expr, `${src}\n  query selected ${JSON.stringify(r.query)}`).toEqual(r.query);
    });
  }

  it("compared every case, or none at all", () => {
    expect(compared === AGREE.length || compared === 0).toBe(true);
  });
});

describe("the documented divergences still diverge", () => {
  for (const { src, why } of DIVERGE) {
    it(src, async () => {
      const r = await bothSides(src);
      if (r === null) return;
      expect(r.expr, `${src} no longer diverges — move it to AGREE.\n  ${why}`).not.toEqual(r.query);
    });
  }
});
