import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jsmql } from "../src/index.ts";
import { liveClient } from "./fixtures/live.ts";

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
  "has(3)",
  "sample()",
  "chunk(2)",
];
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
  "slice(0, 3)",
  "uniqBy('type')",
  "pick(['id', 'val'])",
  "omit(['items'])",
  "sample()",
  "sampleSize(2)",
  "shuffle()",
  "flatMap('items')",
];
const STREAM_LOOKUP_RESHAPERS = [
  "filter(o => o.total > 5)",
  "sort('total')",
  "sortBy('total')",
  "orderBy(['total'], ['desc'])",
  "take(3)",
  "drop(1)",
  "tail()",
  "slice(0, 2)",
  "uniqBy('userId')",
  "sample()",
  "sampleSize(2)",
  "shuffle()",
];
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
  "sumBy('total')",
  "meanBy('total')",
  "maxBy('total')",
  "minBy('total')",
  "map('total')",
];

const STREAM_READS: Readonly<Record<string, readonly string[]>> = {
  "filter(o => o.val > 2)": ["val"],
  "filter({ type: 'a' })": ["type"],
  "reject(o => o.val > 8)": ["val"],
  "map(o => ({ id: o.id, v: o.val }))": ["id", "val"],
  "sort('val')": ["val"],
  "toSorted('val')": ["val"],
  "sortBy('val')": ["val"],
  "orderBy(['val'], ['desc'])": ["val"],
  "take(3)": [],
  "drop(1)": [],
  "tail()": [],
  "slice(0, 3)": [],
  "uniqBy('type')": ["type"],
  "pick(['id', 'val'])": [],
  "omit(['items'])": [],
  "sample()": [],
  "sampleSize(2)": [],
  "shuffle()": [],
  "flatMap('items')": ["items"],
};
const STREAM_KEEPS: Readonly<Record<string, readonly string[]>> = {
  "map(o => ({ id: o.id, v: o.val }))": ["id", "v"],
  "pick(['id', 'val'])": ["id", "val"],
};
const readsWhatWasDropped = (a: string, b: string): boolean =>
  STREAM_KEEPS[a] !== undefined && STREAM_READS[b].some((f) => !STREAM_KEEPS[a].includes(f));

type Chain = { kind: "expr" | "pipe"; src: string; refused?: true };
const chains: Chain[] = [];
for (const a of NUM_RESHAPERS)
  for (const b of NUM_RESHAPERS) chains.push({ kind: "expr", src: `$.nums.${a}.${b}.size()` });
for (const r of NUM_RESHAPERS) for (const t of NUM_TERMINALS) chains.push({ kind: "expr", src: `$.nums.${r}.${t}` });
for (const a of OBJ_RESHAPERS)
  for (const b of OBJ_RESHAPERS) chains.push({ kind: "expr", src: `$.objs.${a}.${b}.size()` });
for (const r of OBJ_RESHAPERS) for (const t of OBJ_TERMINALS) chains.push({ kind: "expr", src: `$.objs.${r}.${t}` });
for (const a of STREAM_RESHAPERS) {
  for (const b of STREAM_RESHAPERS) {
    chains.push({ kind: "pipe", src: `$$.${a}.${b};`, ...(readsWhatWasDropped(a, b) ? { refused: true } : {}) });
  }
}
for (const r of STREAM_LOOKUP_RESHAPERS) {
  for (const t of STREAM_TERMINALS) {
    chains.push({ kind: "pipe", src: `$.out = $$$.orders.filter(o => o.userId === $._id).${r}.${t};` });
  }
}

let mainColl: any = null;
let client: any = null;

beforeAll(async () => {
  client = await liveClient(2500);
  if (client !== null) {
    const db = client.db("jsmql_permutations");
    await db.dropDatabase();
    const t = db.collection("t");
    await t.insertMany([
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
  }
});
afterAll(async () => {
  await client?.close();
});

const holdsNamespace = (v: unknown): boolean =>
  Array.isArray(v)
    ? v.some(holdsNamespace)
    : typeof v === "object" && v !== null && v.constructor === Object
      ? Object.entries(v).some(([k, x]) => k.startsWith("__jsmql") || holdsNamespace(x))
      : false;

async function checkAll(subset: Chain[]) {
  const compileFails: string[] = [];
  const runFails: string[] = [];
  let ran = 0;
  for (const { kind, src, refused } of subset) {
    let mql: unknown;
    try {
      mql = kind === "expr" ? jsmql.expr(src) : jsmql(src);
    } catch (e) {
      const message = (e as Error).message.split("\n")[0];
      if (refused !== true || !/reads a field that .* does not have\. It holds /.test(message)) {
        compileFails.push(`${src}  ::  ${message}`);
      }
      continue;
    }
    if (refused === true) {
      compileFails.push(`${src}  ::  compiled, but a link reads a field that the link before it did not keep`);
      continue;
    }
    if (mainColl !== null) {
      ran += 1;
      try {
        if (kind === "expr") {
          await mainColl.aggregate([{ $addFields: { __v: mql } }, { $project: { _id: 0, __v: 1 } }]).toArray();
        } else {
          const docs = await mainColl.aggregate(mql as Record<string, unknown>[]).toArray();
          if (holdsNamespace(docs)) runFails.push(`${src}  ::  a document holds a field under __jsmql`);
        }
      } catch (e) {
        const err = e as { codeName?: string; message: string };
        runFails.push(`${src}  ::  ${err.codeName ?? ""} ${err.message.split("\n")[0]}`);
      }
    }
  }
  expect(compileFails, `compile failures:\n  ${compileFails.join("\n  ")}`).toEqual([]);
  expect(runFails, `mongod runtime failures:\n  ${runFails.join("\n  ")}`).toEqual([]);
  served += ran;
}

let served = 0;

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

  it("states what each stream reshaper reads, and refuses the pairs that read a dropped field", () => {
    expect(Object.keys(STREAM_READS).sort()).toEqual([...STREAM_RESHAPERS].sort());
    expect(chains.filter((c) => c.refused === true).map((c) => c.src)).toContain(
      "$$.map(o => ({ id: o.id, v: o.val })).filter(o => o.val > 2);",
    );
  });

  it("reports whether the server half ran, so a green run cannot hide a skip", () => {
    if (mainColl === null) {
      console.warn("\n[permutations] no mongod reachable — compile-only. Start one to exercise the runtime half.\n");
      expect(served).toBe(0);
      return;
    }
    expect(served).toBe(chains.filter((c) => c.refused !== true).length);
  });
});
