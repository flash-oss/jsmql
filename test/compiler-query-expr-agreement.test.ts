// The two NEW targets must select the same documents — where the language says they do.
//
// A predicate reaches MQL by two roads: the QUERY language (`filter`) and the
// aggregation EXPRESSION language (`expr`, under `$expr`). Two lowerings of one
// source, in two files. This suite runs both over the same documents on a real
// mongod and compares the ids that come back. The divergences the language
// documents (docs/specs/match-query-translation.md § divergences) live in a
// table with a reason each, and are asserted to STILL differ — a repair cannot
// land silently; it moves the row.
//
// Self-skips (green) when no mongod is reachable, with an all-or-nothing guard.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoClient, type Collection } from "mongodb";
import { expr, filter } from "../src/compiler/index.ts";

const URI = "mongodb://127.0.0.1:27017";

const DOCS = [
  { _id: 1, a: "hello", s: "Abc", tags: ["red", "blue"], n: 7, o: { k: 1 }, d: new Date("2024-06-01"), b: 2 },
  { _id: 2, a: 1, s: "az", tags: "red", n: 3, o: { k: 2 }, d: new Date("2023-01-01"), b: 0 },
  { _id: 3, a: 1.5, s: "", tags: [], n: 5, t: "5", b: 2 },
  { _id: 4, a: true, s: "hello", tags: ["blue"], n: 10, b: 1 },
  { _id: 5, a: null, s: "Hello ", tags: ["red"], t: "abc", b: 1 },
  { _id: 6, a: [1, 2, 3], s: "x", tags: ["green"], b: 2 },
  { _id: 7, a: [{ q: 1 }], s: " x ", d: new Date("2025-01-01") },
  { _id: 8, a: { k: 1 }, s: "abz", b: 1 },
  { _id: 9, a: new Date("2024-06-01"), s: "A" },
  { _id: 10 },
  { _id: 11, a: 0, s: "", tags: ["red", "blue"], b: 1 },
  { _id: 12, a: 2, s: "1", b: 2 },
  { _id: 13, a: "1", s: "Ab", b: 1 },
  { _id: 14, a: false, s: "x ", b: 1 },
];

/** Sources whose two roads must select the SAME documents. */
const AGREE: readonly string[] = [
  "$.a === 0",
  // A JavaScript spelling reads the field's OWN value on BOTH roads now, so the
  // array-element match that used to divide them is gone (src/registry/vocabulary.ts § queryOwnValue).
  "$.a === 1",
  'typeof $.a === "object"',
  "$.a === 1 || $.n * 2 > 10",
  "$.a !== 1",
  '$.tags === "red"',
  'typeof $.a === "number"',
  "$.a === 1 && $.a === 2",
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
  '$.d > new Date("2024-01-01")',
  '$.d >= new Date("2024-06-01")',
  'typeof $.a === "string"',
  'typeof $.a !== "boolean"',
  "$.a === 1 || $.b === 2",
  "$.b === 2 && $.n > 1",
  "!($.a === 1)",
  "$.a",
  "!$.a",
  "$.a && $.b",
  "$.a || $.b",
  "$.a ? $.b === 1 : $.b === 2",
  "$.n > $.b",
  "$.n + 1 > 5",
  "$abs($.n) > 5",
];

/** Sources the language DOCUMENTS as selecting different documents, and why. */
const DIVERGE: readonly { src: string; why: string }[] = [
  {
    src: "$.a.q == null",
    why: 'An array at a path PREFIX. The query road reads it as an absent field, which is JavaScript\'s answer (`({a:[{q:1}]}).a.q` is `undefined`, so `== null` is true). The expression road keeps MongoDB\'s path semantics, where `"$a.q"` MAPS over the array and gives `[1]`, so the comparison is false. A value IS a MongoDB path — HR1 round-trips `$.a.q` with `"$a.q"` — so the two roads read the same source two ways here, and the query road is the one JavaScript agrees with.',
  },
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
  try {
    const c = new MongoClient(URI, { serverSelectionTimeoutMS: 800 });
    await c.connect();
    await c.db("admin").command({ ping: 1 });
    client = c;
    coll = c.db("jsmql_compiler_query_expr_agreement").collection("t");
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

const ids = async (q: Record<string, unknown>): Promise<number[]> =>
  (await coll!.find(q).toArray()).map((d) => d._id as number).sort((x, y) => x - y);

/** Both roads' ids, or null when no server is up. */
async function bothRoads(src: string): Promise<{ query: number[]; expr: number[] } | null> {
  if (coll === null) return null;
  return { query: await ids(filter(src)), expr: await ids({ $expr: expr(src) }) };
}

let ran = 0;
let skipped = 0;

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
    // A suite that silently degrades to compile-only looks exactly like one that passed.
    expect(ran === 0 || skipped === 0).toBe(true);
    if (ran === 0)
      console.warn(`\n[agreement] no mongod on ${URI} — the query/expression agreement was NOT compared.\n`);
  });
});
