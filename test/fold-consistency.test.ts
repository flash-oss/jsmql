import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db, MongoClient } from "mongodb";
import { jsmql } from "../src/index.ts";
import { CodegenError } from "../src/errors.ts";
import { announceSkip, liveClient } from "./fixtures/live.ts";
import { answersSet, inAnyOrder } from "./support/set-answer.ts";

const client = await liveClient();
if (!client) {
  announceSkip("fold-consistency");
}

type Case = { lit: string; val: unknown; call: string };

const STRING_SAMPLES = ["", "fooBar", "FOO bar", "  hi  ", "already_snake", "café", "MixedURL2x", "a-b-c"];
const stringCases: Case[] = [];
for (const v of STRING_SAMPLES) {
  const lit = JSON.stringify(v);
  for (const call of [
    ".toUpper()",
    ".toLower()",
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
    '.indexOfSubstring("o")',
    '.indexOfSubstring("o", 2)',
    ".repeat(2)",
    ".padStart(10)",
    '.padStart(10, "*")',
    ".padEnd(10)",
    '.pad(10, "*")',
    ' + "!" + "?"',
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
    numberCases.push({ lit: `(${v})`, val: v, call });
  }
}

const ARRAY_SAMPLES: unknown[][] = [[], [1, 2, 3, 4, 5], [3, 1, 2], ["a", "b", "c"], [1, 2, 2, 3]];
const arrayCases: Case[] = [];
const NUMBERS_ONLY = new Set([".sum()", ".mean()", ".min()", ".max()"]);
const FOR_STRINGS: Record<string, string> = {
  ".filter(x => x !== 2)": '.filter(x => x !== "b")',
  ".find(x => x === 2)": '.find(x => x === "b")',
  ".some(x => x === 2)": '.some(x => x === "b")',
  ".every(x => x > 0)": '.every(x => x > "a")',
};
for (const v of ARRAY_SAMPLES) {
  const lit = JSON.stringify(v);
  const strings = v.some((x) => typeof x === "string");
  for (const written of [
    ".map(x => x)",
    ".filter(x => x !== 2)",
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
    ".xor([2, 3, 4])",
    ".differenceBy([2, 4], x => x)",
    ".intersectionBy([2, 4], x => x)",
    ".unionBy([3, 4, 5], x => x)",
    ".xorBy([2, 3, 4], x => x)",
    ".zip([10, 20, 30])",
    ".zipWith([10, 20, 30], (a, b) => a + b)",
    ".zipObject([10, 20, 30, 40])",
  ]) {
    if (strings && NUMBERS_ONLY.has(written)) continue;
    arrayCases.push({ lit, val: v, call: strings ? (FOR_STRINGS[written] ?? written) : written });
  }
}
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

const DATE_SAMPLES = [
  "2024-01-31T10:20:30.123Z",
  "2024-02-29T23:59:59.999Z",
  "2026-09-16T13:45:30.123Z",
  "2026-09-13T00:00:00.000Z",
  "2020-12-31T05:00:00.000Z",
  "1999-12-31T23:59:59.999Z",
];
const DATE_UNITS = ["year", "quarter", "month", "week", "day", "hour", "minute", "second", "millisecond"];
const dateCases: Case[] = [];
for (const v of DATE_SAMPLES) {
  const lit = `Date("${v}")`;
  const other = 'Date("2026-01-31T23:59:00Z")';
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
for (const v of [
  [[1, 2], [3], [4, 5]],
  [[1], [2, 3]],
]) {
  arrayCases.push({ lit: JSON.stringify(v), val: v, call: ".flatten()" });
  arrayCases.push({ lit: JSON.stringify(v), val: v, call: ".flat()" });
  arrayCases.push({ lit: JSON.stringify(v), val: v, call: ".flat(1)" });
}
for (const v of [
  [0, 1, false, 2, null, 3],
  ["", "a", 0],
]) {
  arrayCases.push({ lit: JSON.stringify(v), val: v, call: ".compact()" });
}
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

const NOT_FOLDED = Symbol("not-folded");

function foldedValue(lit: string, call: string): unknown {
  let stages: Record<string, unknown>[];
  try {
    stages = jsmql.pipeline(`const __k = ${lit}${call}; $project({ v: __k })`) as Record<string, unknown>[];
  } catch (e) {
    if (e instanceof CodegenError) return NOT_FOLDED;
    throw e;
  }
  const only = stages.length === 1 ? (stages[0].$project as { v: unknown } | undefined) : undefined;
  return only && "v" in only ? only.v : NOT_FOLDED;
}

const isOrderedFold = (v: unknown): boolean =>
  typeof v === "object" && v !== null && Object.keys(v).length === 1 && "$arrayToObject" in v;

describe.skipIf(!client)("fold consistency: compile-time fold === MQL lowering on mongod", () => {
  let db: Db;
  beforeAll(() => {
    db = client!.db("jsmql_fold_check");
  });
  afterAll(async () => {
    await client?.close();
  });

  const SERVER_REFUSES: Readonly<Record<string, string>> = {};
  const SERVER_ERROR = Symbol("server-error");
  async function serverValue(call: string, val: unknown): Promise<{ mql: unknown; value: unknown }> {
    try {
      const mql = jsmql.expr(`$.s${call}`);
      const [row] = await db.aggregate([{ $documents: [{ s: val }] }, { $addFields: { v: mql } }]).toArray();
      return { mql, value: "v" in (row as object) ? (row as { v: unknown }).v : SERVER_ERROR };
    } catch {
      return { mql: null, value: SERVER_ERROR };
    }
  }

  let compared = 0;
  const refused: string[] = [];
  const ALL_CASES = [...stringCases, ...numberCases, ...arrayCases, ...objCases, ...dateCases];

  for (const { lit, val, call } of ALL_CASES) {
    it(`${lit}${call}`, async () => {
      const folded = foldedValue(lit, call);
      if (folded === NOT_FOLDED) return;
      const { mql, value: server } = await serverValue(call, val);
      if (server === SERVER_ERROR) {
        refused.push(lit + call);
        return;
      }
      compared += 1;
      if (isOrderedFold(folded)) {
        const pairs = async (m: unknown): Promise<unknown> => {
          const [row] = await db
            .aggregate([{ $documents: [{ s: val }] }, { $addFields: { v: { $objectToArray: m } } }])
            .toArray();
          return (row as { v: unknown }).v;
        };
        expect(await pairs(folded)).toEqual(await pairs(mql));
        return;
      }
      if (answersSet(mql)) {
        expect(inAnyOrder(folded)).toEqual(inAnyOrder(server));
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
    expect(compared).toBeGreaterThanOrEqual(Math.floor(ALL_CASES.length * 0.95));
  });

  it("every case the server REFUSES is one this suite already knows about", () => {
    if (!db) {
      expect(refused).toEqual([]);
      return;
    }
    expect([...new Set(refused)].sort()).toEqual(Object.keys(SERVER_REFUSES).sort());
  });
});
