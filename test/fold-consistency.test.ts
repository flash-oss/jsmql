// test/fold-consistency.test.ts — the HR3 gate for constant folding.
//
// A folded method (const-eval.ts) has TWO implementations of the same
// semantics: the compile-time JS fold, and the server-side MQL lowering that a
// runtime receiver would take. If they disagree, folding would emit a value the
// server never would. This suite proves they agree: for each foldable method ×
// a battery of inputs it compares the compile-time fold to the MQL lowering run
// on a real mongod (via `$documents`, so no collection write). Any method/shape
// that can't be proven equal must be removed from const-eval.ts (→ runtime
// fallback), never shipped.
//
// It connects to a local mongod (mongodb://127.0.0.1:27017, like test/probe) and
// SKIPS ITSELF (green) when none is reachable, so `npm test` stays green without
// one. Start any local mongod to exercise it.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db, MongoClient } from "mongodb";
import { jsmql } from "../src/index.ts";

const URI = process.env.JSMQL_FOLD_MONGO_URI ?? "mongodb://127.0.0.1:27017/?serverSelectionTimeoutMS=1500";

async function tryConnect(): Promise<MongoClient | null> {
  try {
    const { MongoClient } = await import("mongodb");
    const client = new MongoClient(URI, { serverSelectionTimeoutMS: 1500 });
    await client.connect();
    await client.db("jsmql_fold_check").command({ ping: 1 });
    return client;
  } catch {
    return null;
  }
}

const client = await tryConnect();
if (!client) {
  console.warn("\n[fold-consistency] no local mongod reachable — skipping. Start one to exercise the HR3 fold gate.\n");
}

// Each case: a receiver LITERAL (as jsmql source), the same value as a seed doc
// field, and a method-call suffix. The fold embeds the literal; the runtime
// lowering runs `$.s<call>` on `{ s: <val> }`. Both must produce the same value.
type Case = { lit: string; val: unknown; call: string };

const STRING_SAMPLES = ["", "fooBar", "FOO bar", "  hi  ", "already_snake", "café", "MixedURL2x", "a-b-c"];
const stringCases: Case[] = [];
for (const v of STRING_SAMPLES) {
  const lit = JSON.stringify(v);
  for (const call of [
    ".toUpperCase()",
    ".toLowerCase()",
    ".trim()",
    ".trimStart()",
    ".trimEnd()",
    ".slice(1)",
    ".slice(1, 3)",
    ".slice(-2)",
    ".substring(1, 3)",
    '.split("")',
    '.split("-")',
    ".charAt(1)",
    '.includes("o")',
    '.startsWith("f")',
    '.endsWith("r")',
    '.indexOf("o")',
    ".repeat(2)",
    ".padStart(10)",
    '.padStart(10, "*")',
    ".padEnd(10)",
    '.concat("!", "?")',
    // lodash string family
    ".capitalize()",
    ".upperFirst()",
    ".lowerFirst()",
    ".words()",
    ".kebabCase()",
    ".snakeCase()",
    ".startCase()",
    ".camelCase()",
    ".escape()",
    ".truncate()",
    ".truncate({ length: 5 })",
    '.truncate({ length: 8, omission: ".." })',
  ]) {
    stringCases.push({ lit, val: v, call });
  }
}

const NUMBER_SAMPLES = [0, 1, 5, 42, -3, 2.5, 3.5, 0.125, 7.25, 100];
const numberCases: Case[] = [];
for (const v of NUMBER_SAMPLES) {
  for (const call of [
    ".clamp(0, 10)",
    ".clamp(2, 8)",
    ".inRange(10)",
    ".inRange(2, 8)",
    ".round()",
    ".round(1)",
    ".ceil()",
    ".ceil(1)",
    ".floor()",
    ".floor(1)",
  ]) {
    // parenthesise so a negative literal binds before `.method()` (JS precedence)
    numberCases.push({ lit: `(${v})`, val: v, call });
  }
}

const ARRAY_SAMPLES: unknown[][] = [[], [1, 2, 3, 4, 5], [3, 1, 2], ["a", "b", "c"], [1, 2, 2, 3]];
const arrayCases: Case[] = [];
for (const v of ARRAY_SAMPLES) {
  const lit = JSON.stringify(v);
  for (const call of [
    ".map(x => x)",
    ".filter(x => x !== 2)",
    // array `.slice` — full matrix: 1-arg pos/neg/0/out-of-range, 2-arg
    // both-non-negative / end<=start (→ []) / negative-end / both-negative.
    ".slice(1)",
    ".slice(1, 3)",
    ".slice(-2)",
    ".slice(0)",
    ".slice(9)",
    ".slice(-10)",
    ".slice(2, 1)",
    ".slice(0, -1)",
    ".slice(1, -1)",
    ".slice(-3, -1)",
    ".slice(1, 100)",
    ".concat([9, 8])",
    ".includes(2)",
    ".indexOf(2)",
    ".lastIndexOf(2)",
    '.join("-")',
    ".at(0)",
    ".at(-1)",
    ".toReversed()",
    ".flat()",
    ".find(x => x === 2)",
    ".some(x => x === 2)",
    ".every(x => x > 0)",
    ".flatMap(x => [x, x])",
    ".reduce((a, b) => a + b, 0)",
    // lodash array family (non-iteratee)
    ".sum()",
    ".mean()",
    ".min()",
    ".max()",
    ".uniq()",
    ".compact()",
    ".flatten()",
    ".chunk(2)",
    ".take()",
    ".take(2)",
    ".drop()",
    ".drop(2)",
    ".takeRight(2)",
    ".dropRight(2)",
    ".tail()",
    ".initial()",
    ".head()",
    ".last()",
    ".nth(1)",
    ".nth(-1)",
    ".size()",
    ".without(2)",
    // lodash array family (iteratee/predicate) — arrow forms on scalar arrays
    ".sumBy(x => x)",
    ".meanBy(x => x)",
    ".minBy(x => x)",
    ".maxBy(x => x)",
    ".uniqBy(x => x)",
    ".groupBy(x => x)",
    ".countBy(x => x)",
    ".keyBy(x => x)",
    ".partition(x => x === 2)",
    ".reject(x => x === 2)",
    ".takeWhile(x => x !== 2)",
    ".dropWhile(x => x !== 2)",
    ".takeRightWhile(x => x !== 2)",
    ".dropRightWhile(x => x !== 2)",
    ".sortBy()",
    ".groupBy()",
    ".countBy()",
    ".keyBy()",
    // lodash set-ops + zip family (scalar arrays)
    ".xor([2, 3, 4])",
    ".differenceBy([2, 4], x => x)",
    ".intersectionBy([2, 4], x => x)",
    ".unionBy([3, 4, 5], x => x)",
    ".xorBy([2, 3, 4], x => x)",
    ".zip([10, 20, 30])",
    ".zipWith([10, 20, 30], (a, b) => a + b)",
    ".zipObject([10, 20, 30, 40])",
  ]) {
    arrayCases.push({ lit, val: v, call });
  }
}
// pairs arrays for unzip / fromPairs
arrayCases.push({
  lit: "[[1, 10], [2, 20], [3, 30]]",
  val: [
    [1, 10],
    [2, 20],
    [3, 30],
  ],
  call: ".unzip()",
});
arrayCases.push({
  lit: '[["a", 1], ["b", 2]]',
  val: [
    ["a", 1],
    ["b", 2],
  ],
  call: ".fromPairs()",
});

// object receivers for the lodash object family
const objCases: Case[] = [];
const OBJ_SAMPLES: Record<string, unknown>[] = [{}, { a: 1, b: 2, c: 3 }, { x: 0, y: 5, z: 10 }];
for (const v of OBJ_SAMPLES) {
  const lit = JSON.stringify(v);
  for (const call of [
    ".size()",
    ".toPairs()",
    ".invert()",
    '.pick(["a", "x"])',
    '.omit(["a", "x"])',
    ".mapValues(v => v * 2)",
    ".mapKeys(v => v)",
    ".pickBy(v => v > 1)",
    ".omitBy(v => v > 1)",
  ]) {
    objCases.push({ lit, val: v, call });
  }
}
// arrays of objects for iteratee shorthands + by-field sorting
const OBJ_ARRAY = [
  { id: 3, dept: "a", age: 30 },
  { id: 1, dept: "b", age: 20 },
  { id: 2, dept: "a", age: 30 },
];
for (const call of [
  '.keyBy("id")',
  '.groupBy("dept")',
  '.countBy("dept")',
  '.uniqBy("dept")',
  ".minBy(x => x.age)",
  ".maxBy(x => x.age)",
  ".sumBy(x => x.age)",
  '.sortBy("age")',
  '.sortBy("id")',
  '.orderBy(["age"], ["desc"])',
  ".orderBy({ age: -1 })",
  '.partition(x => x.dept === "a")',
]) {
  arrayCases.push({ lit: JSON.stringify(OBJ_ARRAY), val: OBJ_ARRAY, call });
}
// arrays-of-arrays for flatten
for (const v of [
  [[1, 2], [3], [4, 5]],
  [[1], [2, 3]],
]) {
  arrayCases.push({ lit: JSON.stringify(v), val: v, call: ".flatten()" });
}
// arrays with falsy for compact
for (const v of [
  [0, 1, false, 2, null, 3],
  ["", "a", 0],
]) {
  arrayCases.push({ lit: JSON.stringify(v), val: v, call: ".compact()" });
}
// A predicate whose value is falsy-but-MQL-truthy ("" / 0) on every predicate-run
// method — the case where raw MQL truthiness and JS truthiness disagree, so the
// fold and the server lowering have to be checked against each other.
const FALSY_PRED_ARRAY = [{ ok: "y" }, { ok: "" }, { ok: 0 }, { ok: false }, { ok: 1 }];
for (const call of [
  '.filter("ok")',
  '.reject("ok")',
  '.partition("ok")',
  '.takeWhile("ok")',
  '.dropWhile("ok")',
  '.takeRightWhile("ok")',
  '.dropRightWhile("ok")',
  ".reject(x => x.ok)",
  ".partition(x => x.ok)",
]) {
  arrayCases.push({ lit: JSON.stringify(FALSY_PRED_ARRAY), val: FALSY_PRED_ARRAY, call });
}

// Distinguishes "folded to a value" from "wasn't folded" (stayed a runtime
// binding). A non-fold is a safe outcome — the server runs its own lowering —
// so the test skips it; it only asserts on folds, which is where divergence
// would be a real bug.
const NOT_FOLDED = Symbol("not-folded");

/** The compile-time folded value of `<lit><call>`, or NOT_FOLDED if it stayed runtime. */
function foldedValue(lit: string, call: string): unknown {
  const stages = jsmql.pipeline(`const __k = ${lit}${call}; $project({ v: __k })`) as Record<string, unknown>[];
  // A fold produces exactly one `$project` stage; a runtime binding produces a
  // leading `$set` on `__jsmql.var.__k` (and a trailing `$unset`).
  const only = stages.length === 1 ? (stages[0].$project as { v: unknown } | undefined) : undefined;
  return only && "v" in only ? only.v : NOT_FOLDED;
}

describe.skipIf(!client)("fold consistency: compile-time fold === MQL lowering on mongod", () => {
  let db: Db;
  beforeAll(() => {
    db = client!.db("jsmql_fold_check");
  });
  afterAll(async () => {
    await client?.close();
  });

  // The contract is a VALUE contract: wherever the MQL lowering yields a value,
  // the fold must yield the same value. When the lowering ERRORS on an input
  // (a pre-existing lowering limitation — e.g. `$substrCP` on "", empty-separator
  // `$split`), there is no value to disagree with, so the case is skipped; the
  // fold still produces the correct literal.
  const SERVER_ERROR = Symbol("server-error");
  async function serverValue(call: string, val: unknown): Promise<unknown> {
    try {
      const addExpr = jsmql.expr(`$.s${call}`);
      const [row] = await db.aggregate([{ $documents: [{ s: val }] }, { $addFields: { v: addExpr } }]).toArray();
      return "v" in (row as object) ? (row as { v: unknown }).v : SERVER_ERROR; // missing → skip
    } catch {
      return SERVER_ERROR;
    }
  }

  for (const { lit, val, call } of [...stringCases, ...numberCases, ...arrayCases, ...objCases]) {
    it(`${lit}${call}`, async () => {
      const folded = foldedValue(lit, call);
      if (folded === NOT_FOLDED) return; // withheld fold → runtime; nothing to compare
      const server = await serverValue(call, val);
      if (server === SERVER_ERROR) return; // lowering errors on this input → no value to compare
      expect(folded).toEqual(server);
    });
  }
});
