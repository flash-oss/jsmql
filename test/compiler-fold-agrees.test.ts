// THE proof that constant folding is safe: for every expression the fold can
// compute, the value it computes equals the value MongoDB computes for the SAME
// expression left alone.
//
// Nothing else can establish this. A `toEqual` on emitted MQL proves what jsmql
// writes down, never that the server agrees — and "agrees" is the entire claim a
// fold makes. Every rule the fold has that LOOKS like an arbitrary restriction
// was put there by a failure of this suite:
//   Math.atanh(0.25)         JavaScript 0.25541281188299536   server …3
//   123456789 * 987654321    JavaScript …260                  server …269
//   Math.round(0.5)          JavaScript 1                     server 0
//
// It skips itself when no mongod is listening, so `npm test` stays green.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoClient } from "mongodb";
import { jsmql } from "../src/index.ts";
import { parseExpression } from "../src/compiler/parse/parser.ts";
import { evaluate } from "../src/compiler/passes/evaluate.ts";
import { SCRATCH_URI } from "./fixtures/config.ts";
import { liveClientNow, liveUp } from "./fixtures/live.ts";

const URI = SCRATCH_URI;

const up = await liveUp();
if (!up) {
  console.warn(
    `\n[fold] no mongod on ${URI} — skipping the fold-agrees-with-the-server suite.` +
      "\n[fold] Start one to run it; see CLAUDE.md § Verify MQL against a running MongoDB.\n",
  );
}

/** Every expression that must fold to exactly what the server computes. */
const EXPRESSIONS: readonly string[] = [
  // arithmetic, comparison, logic
  "1 + 2",
  "5 - 2",
  "3 * 4",
  "7 / 2",
  "7 % 3",
  "2 ** 10",
  "0.1 + 0.2",
  "-7",
  '"a" + "b"',
  "1 === 1",
  "1 !== 2",
  "1 < 2",
  "2 >= 3",
  '"a" < "b"',
  "!true",
  "true && false",
  "false || true",
  "null ?? 5",
  '"a" ?? 5',
  "1 in [1, 2]",
  "3 in [1, 2]",
  "true ? 1 : 2",
  "false ? 1 : 2",
  "123456 * 654321",
  // structures and reads
  "[1, 2, 3]",
  "[1, ...[2, 3]]",
  "({ a: 1, b: 2 })",
  "({ ...{ a: 1 }, b: 2 })",
  "[10, 20, 30][1]",
  '"abc"[1]',
  "({ a: 5 }).a",
  '"abcd".length',
  // Math — only the exactly-specified ones fold, and those must agree
  "Math.sqrt(16)",
  "Math.abs(-5)",
  "Math.floor(1.5)",
  "Math.ceil(1.2)",
  "Math.trunc(2.7)",
  "Math.sign(-3)",
  "Math.min(3, 7)",
  "Math.max(3, 7)",
  "Math.PI",
  "Math.E",
  "Math.round(0.5)",
  // statics
  "Number.isInteger(4)",
  "Number.isInteger(4.5)",
  "Object.keys({ a: 1, b: 2 })",
  "Object.values({ a: 1, b: 2 })",
  "Object.entries({ a: 1 })",
  "Object.assign({ a: 1 }, { b: 2 })",
  // string methods
  '"aBc".toUpperCase()',
  '"AbC".toLowerCase()',
  '"  hi  ".trim()',
  '"  hi  ".trimStart()',
  '"  hi  ".trimEnd()',
  '"hello".startsWith("he")',
  '"hello".endsWith("lo")',
  '"hello".includes("ell")',
  '"hello".indexOf("l")',
  '"hello".charAt(1)',
  '"hello".substring(1, 3)',
  '"hello".substring(2)',
  '"ab".repeat(3)',
  '"5".padStart(3, "0")',
  '"5".padEnd(3, "-")',
  '"a,b,c".split(",")',
  '"hello".charAt(4)',
  '"hello" + "!"',
  // the lodash string family
  '"a&b<c>\'d".escape()',
  '"Foo Bar-baz".camelCase()',
  '"Foo Bar_baz".kebabCase()',
  '"Foo Bar-baz".snakeCase()',
  '"foo_bar baz".startCase()',
  '"HELLO wORLD".capitalize()',
  '"hello world".upperFirst()',
  '"HELLO".lowerFirst()',
  '"fooBar-baz qux".words()',
  '"XMLHttpRequest".words()',
  '"user_name-2 HTTPServer".camelCase()',
  '"abcdefghij".truncate({ length: 5 })',
  '"abcdefghij".truncate({ length: 5, omission: "…" })',
  // array methods
  "0 || 5",
  "1 && 2",
  "[1, 2] === [1, 2]",
  "[[1]].has([1])",
  "[1, 2, 3].map(x => x * 2)",
  "[1, 2, 3, 4].filter(x => x > 2)",
  "[1, 2, 3].reduce((a, b) => a + b, 0)",
  "[1, 2, 3].some(x => x > 2)",
  "[1, 2, 3].every(x => x > 0)",
  "[1, 2, 3].find(x => x > 1)",
  "[1, 2, 3, 4].slice(1, 3)",
  "[3, 1, 2].toReversed()",
  "[1, 2].concat([3, 4])",
  "[1, 2, 3].has(2)",
  "[1, 2, 3].indexOf(3)",
  "[1, 2, 1].lastIndexOf(1)",
  '[1, 2, 3].join("-")',
  "[1, 2, 3].at(-1)",
  "[[1], [2, 3]].flatMap(x => x)",
  "[1, 2, 3].findIndex(x => x > 1)",
  "[1, 2, 3].reject(x => x > 1)",
  "[1, 2, 3].partition(x => x > 1)",
  "[1, 2, 3].size()",
  // number methods
  "(2.5).round()",
  "(3.5).round()",
  "(2.9).floor()",
  "(2.1).ceil()",
  "(5).clamp(1, 3)",
  "(2).inRange(1, 3)",
  // the array aggregate, set, slicing and reshaping families
  "[1, 2, 3].sum()",
  "[].sum()",
  "[1, 'a', 3].sum()",
  "[1, 2, 3, 4].mean()",
  "[].mean()",
  "[3, 1, 2].min()",
  "[3, 1, 2].max()",
  "[].min()",
  "[{ n: 1 }, { n: 2 }].sumBy(o => o.n)",
  "[{ n: 1 }, { n: 2 }].meanBy(o => o.n)",
  "[{ n: 5 }, { n: 2 }].minBy(o => o.n)",
  "[{ n: 5 }, { n: 2 }].maxBy(o => o.n)",
  "[1, 1, 2, 2].uniq()",
  "[{ a: 1 }, { a: 1 }].uniq()",
  "[{ n: 1 }, { n: 1 }, { n: 2 }].uniqBy(o => o.n)",
  "[1, 2, 3, 2].without(2)",
  "[1, 2, 3, 2].without(2, 3)",
  "[1, 2].xor([2, 3])",
  "[0, 1, '', null, 2, false].compact()",
  "[1, [2, [3]]].flatten()",
  "[1, 2, 3, 4, 5].chunk(2)",
  "[1, 2, 3, 4].take(2)",
  "[1, 2, 3, 4].drop(2)",
  "[1, 2, 3, 4].takeRight(2)",
  "[1, 2, 3, 4].dropRight(2)",
  "[1, 2, 3].tail()",
  "[1, 2, 3].initial()",
  "[1, 2, 3].head()",
  "[1, 2, 3].first()",
  "[1, 2, 3].last()",
  "[1, 2, 3].nth(1)",
  "[1, 2, 3].nth(-1)",
  "[1, 2, 3, 1].takeWhile(x => x < 3)",
  "[1, 2, 3, 1].dropWhile(x => x < 3)",
  "[1, 2, 3, 1].takeRightWhile(x => x < 3)",
  "[1, 2, 3, 1].dropRightWhile(x => x < 3)",
  "[3, 1, 2].sortBy()",
  "[{ n: 3 }, { n: 1 }].sortBy(o => o.n)",
  "[{ n: 3 }, { n: 1 }].orderBy(o => o.n, 'desc')",
  "[1, 2].zip(['a', 'b'])",
  "[[1, 'a'], [2, 'b']].unzip()",
  "['a', 'b'].zipObject([1, 2])",
  "[['a', 1], ['b', 2]].fromPairs()",
  "[1, 2].zipWith([10, 20], (a, b) => a + b)",
  "[{ id: 'a' }, { id: 'b' }].keyBy(o => o.id)",
  "[1, 2, 3, 4].groupBy(x => x % 2)",
  "[1, 2, 3, 4].countBy(x => x % 2)",
  "[{ n: 1 }, { n: 2 }].differenceBy([{ n: 2 }], o => o.n)",
  "[{ n: 1 }, { n: 2 }].intersectionBy([{ n: 2 }], o => o.n)",
  "[{ n: 1 }].unionBy([{ n: 1 }, { n: 2 }], o => o.n)",
  // named conversions and constructors
  'String("a")',
  "String(true)",
  "String(null)",
  "Boolean(1)",
  "Boolean(0)",
  'Boolean("")',
  'Boolean("x")',
  "Boolean(null)",
  'ObjectId("507f1f77bcf86cd799439011")',
  'new ObjectId("507f1f77bcf86cd799439011")',
  "Date.UTC(2020, 1, 1)",
  "new Set([1, 2, 2, 3])",
  "new Set([])",
  // dates: UTC, and MongoDB's own numbering
  'new Date("2020-03-05T20:30:40.123Z").getFullYear()',
  'new Date("2020-03-05T20:30:40.123Z").getMonth()',
  'new Date("2020-03-05T20:30:40.123Z").getDate()',
  'new Date("2020-03-05T20:30:40.123Z").getDay()',
  'new Date("2020-03-05T20:30:40.123Z").getHours()',
  'new Date("2020-03-05T20:30:40.123Z").getMinutes()',
  'new Date("2020-03-05T20:30:40.123Z").getSeconds()',
  'new Date("2020-03-05T20:30:40.123Z").getMilliseconds()',
  'new Date("2020-03-05T20:30:40.123Z").getUTCMonth()',
  'new Date("2020-03-05T20:30:40.123Z").getUTCDay()',
  'new Date("2020-03-05T20:30:40.123Z").toISOString()',
  'new Date("2020-03-05T20:30:40.123Z").quarter()',
  'new Date("2020-03-05T20:30:40.123Z").dayOfYear()',
  'new Date("2020-03-05T20:30:40.123Z").week()',
  'new Date("2020-03-05T20:30:40.123Z").isoWeek()',
  'new Date("2020-03-05T20:30:40.123Z").isoWeekYear()',
  'new Date("2020-03-05T20:30:40.123Z").isoWeekday()',
  "new Date(0).getFullYear()",
  "new Date(2020, 1, 1).getMonth()",
  // the week arithmetic, across the year boundaries where it is hardest
  'new Date("2021-01-01").week()',
  'new Date("2021-01-01").isoWeek()',
  'new Date("2021-01-03").week()',
  'new Date("2019-12-30").isoWeek()',
  'new Date("2019-12-30").isoWeekYear()',
  'new Date("2020-12-31").dayOfYear()',
  // object methods
  "Object.keys({ a: 1, b: 2 }).size()",
  "({ a: 1, b: 2 }).pick(['a'])",
  "({ a: 1, b: 2 }).omit(['a'])",
  "({ a: 1, b: 2 }).mapValues(v => v * 10)",
  "({ a: 'x', b: 'y' }).invert()",
  "({ a: 1, b: 2 }).toPairs()",
  "({ a: 1, b: 2 }).pickBy(v => v > 1)",
  "({ a: 1, b: 2 }).mapKeys((v, k) => k + '!')",
  // the strings `$toString` writes as JavaScript does
  "String(42)",
  "String(-7)",
  "String(9999999999999998)",
  "String(true)",
  "`id-${42}`",
  "`${1}-${2}`",
  "0x507f1f77bcf86cd799439011.toString()",
  // a constant date's arithmetic, measured against the server's calendar rules
  'new Date("2024-01-31T10:20:30.123Z").plus(1, "month")',
  'new Date("2024-02-29T10:20:30.123Z").plus(1, "year")',
  'new Date("2024-11-30T10:20:30.123Z").plus(1, "quarter")',
  'new Date("2024-01-31T10:20:30.123Z").plus(25, "month")',
  'new Date("2024-03-31T10:20:30.123Z").plus(-1, "month")',
  'new Date("2026-09-01T00:00:00Z").plus(1, "week")',
  'new Date("2026-09-01T00:00:00Z").plus(36, "hour")',
  'new Date("2026-09-01T00:00:00Z").plus(90, "minute")',
  'new Date("2026-09-01T00:00:00Z").plus(-1, "second")',
  'new Date("2026-09-01T00:00:00Z").plus(1500, "millisecond")',
  'new Date("2024-03-31T10:20:30.123Z").minus(1, "month")',
  'new Date("2026-05-31T00:00:00Z").minus(2, "quarter")',
  'new Date("2026-09-01T00:00:00Z").minus(3, "day")',
  'new Date("2026-09-16T13:45:30.123Z").startOf("year")',
  'new Date("2026-09-16T13:45:30.123Z").startOf("quarter")',
  'new Date("2026-11-16T13:45:30.123Z").startOf("quarter")',
  'new Date("2026-09-16T13:45:30.123Z").startOf("month")',
  'new Date("2026-09-16T13:45:30.123Z").startOf("week")',
  'new Date("2026-09-13T12:00:00Z").startOf("week")',
  'new Date("2026-09-12T23:00:00Z").startOf("week")',
  'new Date("2026-09-16T13:45:30.123Z").startOf("day")',
  'new Date("2026-09-16T13:45:30.123Z").startOf("hour")',
  'new Date("2026-09-16T13:45:30.123Z").startOf("minute")',
  'new Date("2026-09-16T13:45:30.123Z").startOf("second")',
  'new Date("2026-09-16T13:45:30.123Z").startOf("millisecond")',
  'new Date("2026-09-16T13:45:30.123Z").endOf("year")',
  'new Date("2026-09-16T13:45:30.123Z").endOf("quarter")',
  'new Date("2026-09-16T13:45:30.123Z").endOf("month")',
  'new Date("2024-02-10T13:45:30.123Z").endOf("month")',
  'new Date("2026-09-16T13:45:30.123Z").endOf("week")',
  'new Date("2026-09-16T13:45:30.123Z").endOf("day")',
  'new Date("2026-09-16T13:45:30.123Z").endOf("hour")',
  'new Date("2026-02-01T00:01:00Z").diff(new Date("2026-01-31T23:59:00Z"), "day")',
  'new Date("2026-01-31T23:59:00Z").diff(new Date("2026-02-01T00:01:00Z"), "day")',
  'new Date("2026-02-01T00:00:00Z").diff(new Date("2026-01-31T00:00:00Z"), "month")',
  'new Date("2026-01-31T00:00:00Z").diff(new Date("2026-01-01T00:00:00Z"), "month")',
  'new Date("2026-04-01T00:00:00Z").diff(new Date("2026-03-31T00:00:00Z"), "quarter")',
  'new Date("2026-09-15T00:00:00Z").diff(new Date("2025-01-01T00:00:00Z"), "quarter")',
  'new Date("2026-01-01T01:00:00Z").diff(new Date("2025-12-31T23:00:00Z"), "year")',
  'new Date("2025-12-31T23:59:59Z").diff(new Date("2026-01-01T00:00:00Z"), "year")',
  'new Date("2026-09-13T01:00:00Z").diff(new Date("2026-09-12T23:00:00Z"), "week")',
  'new Date("2026-09-19T23:00:00Z").diff(new Date("2026-09-13T01:00:00Z"), "week")',
  'new Date("2026-09-01T11:01:00Z").diff(new Date("2026-09-01T10:59:00Z"), "hour")',
  'new Date("2026-09-13T11:00:00Z").diff(new Date("2026-09-13T10:59:59.999Z"), "minute")',
  'new Date("2026-09-01T10:59:00.005Z").diff(new Date("2026-09-01T10:59:00Z"), "millisecond")',
  'new Date("2026-09-15T00:00:00Z").diff(new Date("2026-01-01T00:00:00Z"), "day")',
  'new Date("2026-09-15T00:00:00Z").isSame(new Date("2026-09-01T00:00:00Z"), "month")',
  'new Date("2026-09-15T00:00:00Z").isSame(new Date("2026-10-01T00:00:00Z"), "month")',
  'new Date("2026-09-12T23:00:00Z").isBefore(new Date("2026-09-13T01:00:00Z"), "week")',
  'new Date("2026-09-12T23:00:00Z").isBefore(new Date("2026-09-13T01:00:00Z"), "month")',
  'new Date("2026-09-13T01:00:00Z").isAfter(new Date("2026-09-12T23:00:00Z"), "day")',
  'new Date("2026-09-13T01:00:00Z").isAfter(new Date("2026-09-12T23:00:00Z"), "year")',
  'new Date("2026-09-16T13:45:30.123Z").format("%Y-%m-%d %H:%M:%S.%L")',
  'new Date("2026-09-16T13:45:30.123Z").format("j=%j w=%w u=%u U=%U V=%V G=%G z=%z Z=%Z %%")',
  'new Date("2026-01-01T00:00:00Z").format("%j %w %u %U %V %G")',
  'new Date("2027-01-03T00:00:00Z").format("%j %w %u %U %V %G")',
  'new Date("2021-01-03T00:00:00Z").format("%U %V %G")',
  'new Date("2024-12-30T00:00:00Z").format("%j %w %u %U %V %G")',
  'new Date("2023-12-31T00:00:00Z").format("%U %V %G")',
  'new Date("2023-12-31T00:00:00.007Z").format("%L %S %M %H")',
  'new Date("2026-09-16T13:45:30.123Z").format("%%Y")',
  'new Date("2026-09-16T13:45:30.123Z").format("plain text")',
  'new Date("2026-09-16T13:45:30.123Z").set({ day: 1 })',
  'new Date("2026-09-16T13:45:30.123Z").set({ month: 13, day: 0 })',
  'new Date("2026-01-01T00:00:00Z").set({ hour: 25, minute: -1 })',
  'new Date("2026-09-16T13:45:30.123Z").set({ year: 2020 })',
  'new Date("2026-09-16T13:45:30.123Z").set({ isoWeek: 1, isoDayOfWeek: 1 })',
  'new Date("2026-09-16T13:45:30.123Z").set({ isoWeekYear: 2020, isoWeek: 53, isoDayOfWeek: 4, hour: 5 })',
  'new Date("2026-09-16T13:45:30.123Z").set({ isoWeek: 53, isoDayOfWeek: 7 })',
  'new Date("2026-09-16T13:45:30.123Z").set({ isoWeekYear: 2026 })',
  'new Date("2026-09-16T13:45:30.123Z").set({ year: 9999, month: 13 })',
];

describe.skipIf(!up)("compiler/passes/fold — the value it computes is the value the server computes", () => {
  let client: MongoClient;
  let run: (src: string) => Promise<unknown>;

  beforeAll(async () => {
    client = await liveClientNow();
    const coll = client.db("jsmql_fold_agrees").collection("probe");
    await coll.deleteMany({});
    await coll.insertOne({ _id: 1 });
    run = async (src: string): Promise<unknown> => {
      const out = await coll.aggregate([{ $addFields: { v: jsmql.expr(src) } }]).toArray();
      return out[0].v;
    };
  }, 20_000);

  afterAll(async () => {
    await client
      ?.db("jsmql_fold_agrees")
      .dropDatabase()
      .catch(() => {});
    await client?.close().catch(() => {});
  });

  it("is not a vacuous table", () => {
    expect(EXPRESSIONS.length).toBeGreaterThan(100);
  });

  it("folds every expression in the table", () => {
    const refused = EXPRESSIONS.filter((src) => !evaluate(parseExpression(src), new Map()).ok);
    expect(refused).toEqual([]);
  });

  it("agrees with the server on every one of them", async () => {
    const disagree: string[] = [];
    for (const src of EXPRESSIONS) {
      const folded = evaluate(parseExpression(src), new Map());
      if (!folded.ok) continue;
      const server = await run(src);
      // A Date compares by the instant it names; the driver hands back its own.
      const mine = folded.value instanceof Date ? folded.value.toISOString() : folded.value;
      const theirs = server instanceof Date ? server.toISOString() : server;
      if (JSON.stringify(mine) !== JSON.stringify(theirs)) {
        disagree.push(`${src}  fold=${JSON.stringify(mine)}  server=${JSON.stringify(theirs)}`);
      }
    }
    expect(disagree).toEqual([]);
  }, 60_000);
});
