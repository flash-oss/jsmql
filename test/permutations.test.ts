// test/permutations.test.ts — the lodash "chinese wall".
//
// A generative smoke test that CHAINS the lodash array/collection methods in
// every ordered pair (reshaper × reshaper, reshaper × terminal) and asserts:
//   1. every chain COMPILES (no throw) — always runs, the primary regression net;
//   2. every emitted MQL RUNS on a real mongod without a server error — runs only
//      when `JSMQL_PERM_MONGO` points at a writable mongod (self-skips otherwise).
//
// Why: chaining N methods is a combinatorial surface no hand-written case can
// cover. This is where "method X breaks when chained after Y" gets caught. It has
// already caught two real bugs (a `$slice: [arr, 0, 0]` mongod-rejection in
// `takeWhile`/`*RightWhile` and in `drop`/`dropRight`/`tail`/`initial` on an empty
// array or `n ≥ size`).
//
// Run the mongod half:  JSMQL_PERM_MONGO=mongodb://127.0.0.1:27017 npm test

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jsmql } from "../src/index.ts";

// ── the method vocabulary, by input→output shape ─────────────────────────────

// value-mode: numeric array → numeric array (safe to chain with each other)
const NUM_RESHAPERS = [
  "map(x => x + 1)",
  "filter(x => x > 2)",
  "reject(x => x > 8)",
  "uniq()",
  "sortedUniq()",
  "compact()",
  "take(4)",
  "drop(1)",
  "takeRight(3)",
  "dropRight(1)",
  "tail()",
  "initial()",
  "slice(1, 6)",
  "toSorted()",
  "without(3)",
  "difference([9, 5])",
  "union([5, 99])",
  "intersection([1, 2, 3])",
  "xor([4, 100])",
  "takeWhile(x => x < 9)",
  "dropWhile(x => x < 3)",
  "takeRightWhile(x => x < 9)",
  "dropRightWhile(x => x < 3)",
  "sampleSize(3)",
];
// value-mode: numeric array → single value / object
const NUM_TERMINALS = [
  "sum()",
  "mean()",
  "max()",
  "min()",
  "head()",
  "first()",
  "last()",
  "nth(1)",
  "size()",
  "every(x => x > 0)",
  "some(x => x > 5)",
  "includes(3)",
  "sample()",
  "chunk(2)",
];
// value-mode: object array → object array
const OBJ_RESHAPERS = [
  "filter(o => o.val > 2)",
  "filter({ type: 'a' })",
  "reject(o => o.val > 8)",
  "uniqBy('id')",
  "sortedUniqBy('id')",
  "sortBy('val')",
  "orderBy(['val'], ['desc'])",
  "toSorted('val')",
  "take(3)",
  "drop(1)",
  "takeRight(2)",
  "dropRight(1)",
  "tail()",
  "initial()",
  "slice(0, 3)",
  "sampleSize(2)",
  "takeWhile(o => o.val < 9)",
  "dropWhile(o => o.val < 3)",
  "takeRightWhile(o => o.val < 9)",
  "dropRightWhile(o => o.val < 3)",
];
// value-mode: object array → value / object / grouping
const OBJ_TERMINALS = [
  "map('val')",
  "sumBy('val')",
  "meanBy('val')",
  "maxBy('val')",
  "minBy('val')",
  "keyBy('id')",
  "groupBy('type')",
  "countBy('type')",
  "partition(o => o.val > 5)",
  "head()",
  "last()",
  "nth(0)",
  "size()",
  "every(o => o.val > 0)",
  "some(o => o.val > 5)",
  "sample()",
  "differenceBy([{ id: 1 }], 'id')",
  "intersectionBy($.objs, 'id')",
  "unionBy([{ id: 99, type: 'z', val: 0 }], 'id')",
  "xorBy([{ id: 1 }], 'id')",
];
// stream-mode: document stream → document stream (pipeline stages)
const STREAM_RESHAPERS = [
  "filter(o => o.val > 2)",
  "filter({ type: 'a' })",
  "reject(o => o.val > 8)",
  "map(o => ({ id: o.id, v: o.val }))",
  "sort('val')",
  "toSorted('val')",
  "sortBy('val')",
  "orderBy(['val'], ['desc'])",
  "take(3)",
  "drop(1)",
  "tail()",
  "takeRight(2)",
  "dropRight(1)",
  "initial()",
  "slice(0, 3)",
  "uniqBy('type')",
  "pick(['id', 'val'])",
  "omit(['items'])",
  "sample()",
  "sampleSize(2)",
  "shuffle()",
  "flatMap('items')",
];
// NB `countBy`/`groupBy` are NOT stream reshapers: like lodash they COLLAPSE the
// stream to a single object (`{ <key>: <count> }` / `{ <key>: [docs] }`), so they
// live with the value-collapsing terminals below, not here — pairing them with a
// field-stripping reshaper would feed `$arrayToObject` a null key (mongod-rejected).
// stream-mode reshapers over the `orders` lookup (doc-PRESERVING, on real order
// fields) — so the value-terminals below still see `total`/`userId`. (The doc-
// reshaping ones — map/pick/omit/flatMap — are covered by the reshaper×reshaper
// matrix; pairing them with a field-referencing terminal is a nonsensical chain,
// not a lowering to test.)
const STREAM_LOOKUP_RESHAPERS = [
  "filter(o => o.total > 5)",
  "sort('total')",
  "sortBy('total')",
  "orderBy(['total'], ['desc'])",
  "take(3)",
  "drop(1)",
  "tail()",
  "takeRight(2)",
  "dropRight(1)",
  "initial()",
  "slice(0, 2)",
  "uniqBy('userId')",
  "sample()",
  "sampleSize(2)",
  "shuffle()",
];
// stream-mode: value-collapsing terminals (valid only in a value position)
const STREAM_TERMINALS = [
  "head()",
  "first()",
  "last()",
  "nth(0)",
  "size()",
  "every(o => o.total > 0)",
  "some(o => o.total > 100)",
  "keyBy('total')",
  "groupBy('userId')",
  "countBy('userId')",
  "partition(o => o.total > 10)",
  "sum()",
  "sumBy('total')",
  "meanBy('total')",
  "maxBy('total')",
  "minBy('total')",
  "map('total')",
];

// ── chain builders ───────────────────────────────────────────────────────────
type Chain = { kind: "expr" | "pipe"; src: string };
const chains: Chain[] = [];
// value: reshaper × reshaper → `.size()` (any array → number, so the whole chain
// is a concrete scalar; this exercises every reshaper-after-reshaper pair).
for (const a of NUM_RESHAPERS)
  for (const b of NUM_RESHAPERS) chains.push({ kind: "expr", src: `$.nums.${a}.${b}.size()` });
for (const r of NUM_RESHAPERS) for (const t of NUM_TERMINALS) chains.push({ kind: "expr", src: `$.nums.${r}.${t}` });
for (const a of OBJ_RESHAPERS)
  for (const b of OBJ_RESHAPERS) chains.push({ kind: "expr", src: `$.objs.${a}.${b}.size()` });
for (const r of OBJ_RESHAPERS) for (const t of OBJ_TERMINALS) chains.push({ kind: "expr", src: `$.objs.${r}.${t}` });
// stream: reshaper × reshaper (bare statement chain → pipeline stages).
for (const a of STREAM_RESHAPERS) for (const b of STREAM_RESHAPERS) chains.push({ kind: "pipe", src: `$$.${a}.${b};` });
// stream value-terminals in a VALUE position (assignment RHS over a lookup result):
// reshaper stages build the $lookup sub-pipeline, the terminal peels to value-mode.
for (const r of STREAM_LOOKUP_RESHAPERS) {
  for (const t of STREAM_TERMINALS) {
    chains.push({ kind: "pipe", src: `$.out = $$$.orders.filter(o => o.userId === $._id).${r}.${t};` });
  }
}

// ── optional mongod runtime check ────────────────────────────────────────────
const MONGO = process.env.JSMQL_PERM_MONGO;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the driver types aren't imported unless MONGO is set
let mainColl: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any = null;

beforeAll(async () => {
  if (MONGO === undefined) return;
  const { MongoClient } = await import("mongodb");
  client = new MongoClient(MONGO, { serverSelectionTimeoutMS: 2500 });
  try {
    await client.connect();
    const db = client.db("jsmql_permutations");
    await db.dropDatabase();
    const t = db.collection("t");
    await t.insertMany([
      // Varied array sizes — INCLUDING single-element (row 4) and empty (row 5),
      // which are what surface the count-0 `$slice` edge on drop/tail/takeWhile.
      {
        _id: 1,
        id: 1,
        type: "a",
        val: 5,
        userId: 1,
        items: [1, 2],
        nums: [3, 1, 2, 1, 4, 5],
        objs: [
          { id: 1, type: "a", val: 5 },
          { id: 2, type: "b", val: 2 },
          { id: 1, type: "a", val: 5 },
        ],
        b: [1, 9],
        nested: [[1, 2], [3]],
      },
      {
        _id: 2,
        id: 2,
        type: "b",
        val: 9,
        userId: 2,
        items: [3],
        nums: [7, 7, 8],
        objs: [{ id: 3, type: "c", val: 9 }],
        b: [8],
        nested: [[9]],
      },
      {
        _id: 3,
        id: 3,
        type: "a",
        val: 1,
        userId: 1,
        items: [],
        nums: [2, 6, 2],
        objs: [
          { id: 4, type: "a", val: 1 },
          { id: 5, type: "b", val: 6 },
        ],
        b: [2, 6],
        nested: [[]],
      },
      {
        _id: 4,
        id: 4,
        type: "c",
        val: 3,
        userId: 3,
        items: [9, 9, 9],
        nums: [5],
        objs: [{ id: 6, type: "a", val: 3 }],
        b: [],
        nested: [],
      },
      { _id: 5, id: 5, type: "a", val: 0, userId: 1, items: [1], nums: [], objs: [], b: [7], nested: [] },
    ]);
    await db.collection("orders").insertMany([
      { _id: 11, userId: 1, total: 10, placedAt: 1 },
      { _id: 12, userId: 1, total: 20, placedAt: 2 },
      { _id: 13, userId: 2, total: 5, placedAt: 3 },
    ]);
    mainColl = t;
  } catch {
    mainColl = null; // mongod unreachable → compile-only
  }
});
afterAll(async () => {
  await client?.close();
});

// Compile every chain in `subset`; when a mongod is connected, run each emitted
// MQL and collect any server rejection. Fails with the offending chains listed.
async function checkAll(subset: Chain[]) {
  const compileFails: string[] = [];
  const runFails: string[] = [];
  for (const { kind, src } of subset) {
    let mql: unknown;
    try {
      mql = kind === "expr" ? jsmql.expr(src) : jsmql(src);
    } catch (e) {
      compileFails.push(`${src}  ::  ${(e as Error).message.split("\n")[0]}`);
      continue;
    }
    if (mainColl !== null) {
      try {
        if (kind === "expr") {
          await mainColl.aggregate([{ $addFields: { __v: mql } }, { $project: { _id: 0, __v: 1 } }]).toArray();
        } else {
          await mainColl.aggregate(mql as Record<string, unknown>[]).toArray();
        }
      } catch (e) {
        const err = e as { codeName?: string; message: string };
        runFails.push(`${src}  ::  ${err.codeName ?? ""} ${err.message.split("\n")[0]}`);
      }
    }
  }
  expect(compileFails, `compile failures:\n  ${compileFails.join("\n  ")}`).toEqual([]);
  expect(runFails, `mongod runtime failures:\n  ${runFails.join("\n  ")}`).toEqual([]);
}

const only = (k: Chain["kind"], pred: (s: string) => boolean) => chains.filter((c) => c.kind === k && pred(c.src));

describe("lodash chain permutations (chinese wall)", () => {
  it("value: numeric reshaper × reshaper pairs", () =>
    checkAll(only("expr", (s) => s.startsWith("$.nums") && s.endsWith(".size()"))));
  it("value: numeric reshaper × terminal", () =>
    checkAll(only("expr", (s) => s.startsWith("$.nums") && !s.endsWith(".size()"))));
  it("value: object reshaper × reshaper pairs", () =>
    checkAll(only("expr", (s) => s.startsWith("$.objs") && s.endsWith(".size()"))));
  it("value: object reshaper × terminal", () =>
    checkAll(only("expr", (s) => s.startsWith("$.objs") && !s.endsWith(".size()"))));
  it("stream: reshaper × reshaper pairs → pipeline stages", () => checkAll(only("pipe", (s) => s.startsWith("$$."))));
  it("stream: value-terminals in a lookup value-position", () => checkAll(only("pipe", (s) => s.startsWith("$.out"))));

  it("covers a large matrix (guard against an accidentally-empty generator)", () => {
    expect(chains.length).toBeGreaterThan(1500);
  });
});
