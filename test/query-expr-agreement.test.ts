// test/query-expr-agreement.test.ts — the two targets must select the same documents.
//
// A predicate can reach MQL by two different roads. In Filter position (or a `$match` body)
// it becomes the QUERY language: `{ age: { $gt: 18 } }`. Anywhere else it becomes the
// aggregation-EXPRESSION language: `{ $gt: ["$age", 18] }`. Those are two lowerings of one
// source, written in two files, sharing no code — which is precisely the shape that lets
// them drift apart without anyone noticing.
//
// They already had: `typeof $.a === "boolean"` selected documents as a filter and matched
// NOTHING as an expression, for months, because the query side carried a BSON alias table
// and the expression side compared `$type` against JavaScript's own spelling. No unit test
// could see it, because each side was individually self-consistent.
//
// So this suite asks the only question that catches that class: run BOTH lowerings of the
// same source over the SAME documents on a real mongod, and compare which documents come
// back. It is the query/expr analogue of `parity.test.ts`, which asks the same question of
// the value and stream forms.
//
// Where the two legitimately differ, the row says so and says WHY — see
// docs/specs/emit-pass.md § The filter target for the documented divergences. A
// divergence without a row fails the suite.
//
// Self-skips (green) when no mongod is reachable, like the other server-backed suites, and
// carries the coverage guard that goes with that: a suite that quietly stops comparing is
// worse than no suite.

import { MongoClient, type Collection } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jsmql } from "../src/index.ts";

const URI = process.env.JSMQL_MONGO_URI ?? "mongodb://127.0.0.1:27017";

/**
 * Deliberately mixed: a missing field, an empty string, a false, an explicit null, a
 * negative, a float. Every one of those is a place the two languages are known to reason
 * differently about absence and truthiness.
 */
const DOCS = [
  { _id: 1, a: 5, s: "hello", t: true, n: null, d: new Date("2024-05-17T00:00:00Z") },
  { _id: 2, a: 0, s: "", t: false, n: 1, d: new Date("2020-01-01T00:00:00Z") },
  { _id: 3, a: -2, s: "Hi", t: true, d: new Date("2024-05-17T00:00:00Z") }, // n missing
  { _id: 4, s: "hello world", n: null }, // a, t, d missing
  { _id: 5, a: 5.5, s: "HELLO", t: false, n: "x", d: new Date("2030-01-01T00:00:00Z") },
  // Only this one carries `items` — the other four exercise the missing-receiver path.
  { _id: 6, s: "hey", items: [{ q: 5 }, { q: 1 }] },
];

/** A predicate whose two lowerings must select the same documents. */
const AGREE: readonly string[] = [
  // Cmp — equality, ordered, and the two null modes.
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
  "$.d > new Date('2024-01-01')",
  // `typeof` — one alias table in src/registry/vocabulary.ts read by both the query and
  // the expression cells, and the reason this suite exists.
  'typeof $.a === "number"',
  'typeof $.s === "string"',
  // Mod
  "$.a % 2 === 0",
  "$.a % 2 !== 0",
  // Contains, anchored — an INDEXED prefix/suffix regex as a query, `$indexOfCP` /
  // `$substrCP` as an expression. Both must select the same documents.
  '$.s.startsWith("he")',
  '$.s.endsWith("lo")',
  '$.s.startsWith("H")',
  '$.s.endsWith("o")',
  // A needle carrying regex metacharacters must be escaped, not interpreted.
  '$.s.startsWith("h.")',
  // RegexMatch
  "$.s.match(/^he/)",
  "/^he/.test($.s)",
  "$.s.match(/HE/i)",
  // JS-only regex flags. The expression side strips them (`mongoRegexOptions`); the query
  // side hands the pattern to `new RegExp` and lets the driver serialise it. MongoDB itself
  // refuses a `g`, so this pair asserts the driver normalises rather than forwarding it —
  // if that ever changed, the query side would start being rejected and this would catch it.
  "$.s.match(/^he/g)",
  "$.s.match(/^HE/gi)",
  // Membership
  '["hello", "Hi"].includes($.s)',
  // Exists — `=== undefined` is an existence test in BOTH targets: `$exists` in the query
  // language, `$type` against "missing" in the expression language. Note it must NOT treat an
  // explicit null as absent, which is why the doc set carries both.
  "$.a === undefined",
  "$.a !== undefined",
  "$.n === undefined",
  "$.n !== undefined",
  // `.length` — the runtime three-way dispatch. Its receiver is unknown here, so both
  // targets take the same `$cond`; the doc set has strings and a missing field.
  "$.s.length === 5",
  "$.s.length > 2",
  // Quantify — `$elemMatch` as a query, `$anyElementTrue`/`$allElementsTrue` as an
  // expression. The doc set has no `items` field at all, which is the case that used to
  // abort the expression form while the query form answered correctly.
  "$.items.some(i => i.q > 3)",
  "$.items.every(i => i.q > 3)",
  // Logical
  "$.a > 0 && $.s === 'hello'",
  "$.a > 0 || $.t === false",
  "!($.a > 0)",
];

/**
 * A predicate whose two lowerings legitimately differ, with the reason. Each is a
 * MongoDB-semantics fact, not a jsmql choice — but jsmql picks which one the user gets, so
 * the difference is contracted here rather than discovered.
 */
const DIVERGE: readonly { src: string; why: string }[] = [
  {
    src: "$.a < 0",
    why:
      "Ordered comparison against a MISSING field. The query form `{a:{$lt:0}}` requires the " +
      "field to exist; the expression form compares `$a` as missing, which sorts BEFORE every " +
      "number in BSON order, so `missing < 0` is true. Documented in emit-pass.md § The filter target.",
  },
  { src: "$.a <= 0", why: "Same as `<` — ordered comparison against a missing field." },
  {
    src: '$.s.includes("ell")',
    why:
      "A query document is what an INDEX is read through, so the query form is the indexable one: " +
      '`{ s: "ell" }`, MongoDB\'s "equals, or is an array containing". The expression form has no index ' +
      "at stake, so it keeps both readings a JavaScript `.includes` has and answers true for a string " +
      "that merely CONTAINS the needle. `.match(/ell/)` is the query spelling that asks for the substring.",
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
    coll = c.db("jsmql_query_expr_agreement").collection("t");
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

const ids = (rows: { _id: unknown }[]): number[] => rows.map((r) => r._id as number).sort((x, y) => x - y);

/** The documents each lowering selects, or null when this run has no server. */
async function bothSides(src: string): Promise<{ query: number[]; expr: number[] } | null> {
  if (coll === null) return null;
  const query = ids(await coll.find(jsmql(src) as Record<string, unknown>).toArray());
  const rows = await coll.aggregate([{ $addFields: { __v: jsmql.expr(src) } }, { $match: { __v: true } }]).toArray();
  return { query, expr: ids(rows) };
}

describe("the Query and Expr targets select the same documents", () => {
  let compared = 0;

  for (const src of AGREE) {
    it(src, async () => {
      const r = await bothSides(src);
      if (r === null) return; // no server — self-skip, guarded below
      compared++;
      expect(r.expr, `${src}\n  query selected ${JSON.stringify(r.query)}`).toEqual(r.query);
    });
  }

  it("compared every case, or none at all", () => {
    // A suite that silently degrades to zero comparisons looks exactly like one that passed.
    expect(compared === AGREE.length || compared === 0).toBe(true);
  });
});

describe("the documented divergences still diverge", () => {
  for (const { src, why } of DIVERGE) {
    it(src, async () => {
      const r = await bothSides(src);
      if (r === null) return;
      // Asserted in BOTH directions on purpose. If a divergence is ever repaired, this fails
      // and the row must be moved to AGREE — a fix should not be able to land silently.
      expect(r.expr, `${src} no longer diverges — move it to AGREE.\n  ${why}`).not.toEqual(r.query);
    });
  }
});
