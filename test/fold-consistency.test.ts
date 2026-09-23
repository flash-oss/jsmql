// test/fold-consistency.test.ts — the HR3 gate for constant folding.
//
// A folded method (src/compiler/passes/fold-methods.ts) has TWO implementations of the same
// semantics: the compile-time JS fold, and the server-side MQL lowering that a
// runtime receiver would take. If they disagree, folding would emit a value the
// server never would. This suite proves they agree: for each foldable method ×
// a battery of inputs it compares the compile-time fold to the MQL lowering run
// on a real mongod (through `$documents`, so no collection write). Any method/shape
// that cannot be proven equal must be removed from fold-methods.ts (→ runtime
// fallback), never shipped.
//
// It connects to the project's mongod on :27018 (see test/fixtures/config.ts) and
// SKIPS ITSELF (green) when it is not reachable, so `npm test` stays green without
// it. Run `npm run fixture:up` to exercise it.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db, MongoClient } from "mongodb";
import { jsmql } from "../src/index.ts";
import { announceSkip, liveClient } from "./fixtures/live.ts";

const client = await liveClient();
if (!client) {
  announceSkip("fold-consistency");
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
    ".substring(1)",
    ".substring(1, 3)",
    ".substr(-2)",
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
    ' + "!" + "?"',
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
    ".has(2)",
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
// A date receiver: the fold's calendar arithmetic against `$dateAdd`, `$dateTrunc`,
// `$dateDiff`, `$dateToString` and `$dateFromParts` run on the server.
const DATE_SAMPLES = [
  "2024-01-31T10:20:30.123Z", // a leap year's January 31st
  "2024-02-29T23:59:59.999Z",
  "2026-09-16T13:45:30.123Z", // a Wednesday
  "2026-09-13T00:00:00.000Z", // a Sunday at midnight
  "2020-12-31T05:00:00.000Z", // ISO week 53
  "1999-12-31T23:59:59.999Z",
];
const DATE_UNITS = ["year", "quarter", "month", "week", "day", "hour", "minute", "second", "millisecond"];
const dateCases: Case[] = [];
for (const v of DATE_SAMPLES) {
  const lit = `new Date("${v}")`;
  const other = 'new Date("2026-01-31T23:59:00Z")';
  const calls = [
    ".getFullYear()",
    ".getMonth()",
    ".getDate()",
    ".getDay()",
    ".getHours()",
    ".getTime()",
    ".toISOString()",
    ".quarter()",
    ".dayOfYear()",
    ".isoWeekday()",
    ".isoWeekYear()",
    ".isoWeek()",
    ".week()",
    `.diff(${other}, "day")`,
    `.diff(${other}, "month")`,
    `.diff(${other}, "week")`,
    `.isSame(${other}, "year")`,
    `.isBefore(${other}, "month")`,
    `.isAfter(${other}, "day")`,
    '.format("%Y-%m-%d %H:%M:%S.%L")',
    '.format("%j %w %u %U %V %G %z %Z %%")',
    ".set({ day: 1 })",
    ".set({ month: 13, day: 0 })",
    ".set({ hour: 25, minute: -1 })",
    ".set({ isoWeek: 1, isoDayOfWeek: 1 })",
    ".set({ isoWeekYear: 2020, isoWeek: 53, isoDayOfWeek: 4 })",
  ];
  for (const unit of DATE_UNITS) {
    calls.push(`.plus(1, "${unit}")`, `.plus(-1, "${unit}")`, `.plus(25, "${unit}")`);
    calls.push(`.minus(1, "${unit}")`, `.minus(7, "${unit}")`);
    calls.push(`.startOf("${unit}")`, `.endOf("${unit}")`);
  }
  for (const call of calls) dateCases.push({ lit, val: new Date(v), call });
}

const objCases: Case[] = [];
const OBJ_SAMPLES: Record<string, unknown>[] = [{}, { a: 1, b: 2, c: 3 }, { x: 0, y: 5, z: 10 }];
for (const v of OBJ_SAMPLES) {
  const lit = JSON.stringify(v);
  for (const call of [
    ".keys().size()",
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
  // `$concatArrays` takes arrays only, so `.flat()` reads the same receivers
  arrayCases.push({ lit: JSON.stringify(v), val: v, call: ".flat()" });
  arrayCases.push({ lit: JSON.stringify(v), val: v, call: ".flat(1)" });
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

// Distinguishes "folded to a value" from "was not folded" (stayed a runtime
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

  // The contract is a VALUE contract: wherever the MQL lowering yields a value, the
  // fold must yield the same value.
  //
  // A case the server REFUSES has no value to disagree with — but it is also a document
  // jsmql emitted and the server would not run, which HR3 forbids, so it cannot simply
  // be skipped. Eight `.concat("!", "?")` cases hid behind that skip for exactly as long
  // as it was silent. Each refusal is therefore named here, with the reason it is
  // allowed to stand, and a shape that is not on this list turns the suite red.
  const SERVER_REFUSES: Readonly<Record<string, string>> = {
    // lodash pads the shorter list with `undefined`; `$arrayToObject` refuses the pair
    // that has no value ("$arrayToObject requires an array of size 2 arrays"). The same
    // unequal-length reading the `zipWith` fold is withheld for.
    "[1,2,3,4,5].zipObject([10, 20, 30, 40])": "unequal lengths — the missing pair has no value",
  };
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

  // A case that early-returns asserts NOTHING and still reads as green. Counting the
  // ones that actually compared is what stops the suite hollowing out as cases are
  // added — see the floor below.
  // Methods whose MQL lowering is a set operator. MongoDB leaves their result order
  // unspecified (verified: `$setUnion` sorted a string array, `$setDifference` did not),
  // so the fold is compared on membership rather than sequence. See SR2 in LANG_RULES.
  const UNORDERED_RESULT = /\.(uniq|union|intersection|xor)\(/;
  const asBag = (v: unknown): unknown => (Array.isArray(v) ? [...v].map((x) => JSON.stringify(x)).sort() : v);

  let compared = 0;
  const refused: string[] = [];
  const ALL_CASES = [...stringCases, ...numberCases, ...arrayCases, ...objCases, ...dateCases];

  for (const { lit, val, call } of ALL_CASES) {
    it(`${lit}${call}`, async () => {
      const folded = foldedValue(lit, call);
      if (folded === NOT_FOLDED) return; // withheld fold → runtime; nothing to compare
      const server = await serverValue(call, val);
      if (server === SERVER_ERROR) {
        // named above, or the suite says so — an unlisted refusal is MQL that cannot run
        refused.push(lit + call);
        return;
      }
      compared += 1;
      if (UNORDERED_RESULT.test(call)) {
        // MongoDB does not define the order `$setUnion` / `$setIntersection` /
        // `$setDifference` return, so ANY order is a valid server result and comparing
        // sequences would fail on a difference that carries no meaning. The fold must
        // still agree on WHICH values survive — that part is the contract.
        expect(asBag(folded)).toEqual(asBag(server));
        return;
      }
      expect(folded).toEqual(server);
    });
  }

  it("most cases actually compared a fold against the server", () => {
    if (!db) {
      expect(compared).toBe(0);
      return;
    }
    // Some early-returns are legitimate — a method whose fold is deliberately withheld,
    // or an input its lowering rejects. A large share of them is not, and would mean the
    // gate stopped gating without anything going red.
    // Every remaining non-fold is withheld ON PURPOSE, and each one names its reason: a
    // read that can find nothing (.at / .head / .last / .nth / .find), a zipWith or a
    // zipObject over lists of unequal length, a fold whose answer is -0 (which has no
    // literal spelling), and a `.flat()` or a `.min()` over a receiver whose elements are
    // not one comparable type. Measured 2026-09-09: 756 of 785 compare.
    expect(compared).toBeGreaterThanOrEqual(Math.floor(ALL_CASES.length * 0.95));
  });

  it("every case the server REFUSES is one this suite already knows about", () => {
    // A refusal is a document jsmql emitted that mongod will not run. Skipping it
    // quietly is how the multi-argument `.concat()` defect survived eight cases.
    if (!db) {
      expect(refused).toEqual([]);
      return;
    }
    expect([...new Set(refused)].sort()).toEqual(Object.keys(SERVER_REFUSES).sort());
  });
});
