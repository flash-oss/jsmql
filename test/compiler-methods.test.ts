// Phase 5 of src/compiler/ — the METHOD cells of the value target, family by family.
//
// A method's row carries its value cell (`expr: { args, emit }`); this suite holds
// one spelling per cell, asserts the MQL, and runs every spelling on a live mongod
// over a fixture, comparing the value the server answers with what JavaScript
// answers for the same input — the JavaScript-behaviour ruling made measurable.
// Where JavaScript and MongoDB cannot agree (a local-time accessor on a server that
// knows no client timezone), the case says so and asserts the MongoDB answer.
//
// The wider net is `scripts/diff-compilers.mjs --entry expr`, which compares every
// harvested expression with the shipped compiler. Self-skips (green) when no mongod
// is reachable, with the all-or-nothing guard.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoClient, type Collection } from "mongodb";
import { expr } from "../src/compiler/index.ts";

const URI = "mongodb://127.0.0.1:27017";

/** One document, every field a method below reads. */
const DOC = {
  _id: 1,
  s: "  Hello World  ",
  w: "fooBar baz-qux",
  csv: "a,b,c",
  n: 7.256,
  neg: -3,
  d: new Date("2026-03-15T13:45:30.250Z"),
  e: new Date("2026-03-01T00:00:00.000Z"),
  o: { a: 1, b: 2, _c: 3 },
  h: "<a & b>",
  a: [3, 1, 2],
  b: [2, 5],
  docs: [
    { k: "x", v: 2 },
    { k: "y", v: 1 },
    { k: "x", v: 3 },
  ],
  nested: [[1, 2], [3]],
  pairs: [["k", 1]],
  mixed: [0, 1, "", "a", null, false, true],
};

type Case = { src: string; js: (d: typeof DOC) => unknown; note?: string; unordered?: true };
const RUNS: Case[] = [];
/** Assert the shape, and remember the source for the server half with the JavaScript answer. */
const compiled = (src: string, js: (d: typeof DOC) => unknown, note?: string): unknown => {
  RUNS.push({ src, js, note });
  return expr(src);
};
/**
 * The same, for a SET operation: MongoDB's `$setUnion` and its kin answer in no
 * promised order, and an ordering the developer never wrote gives way to
 * MongoDB's (SR2) — so the elements are compared, not their sequence.
 */
const unordered = (src: string, js: (d: typeof DOC) => unknown): unknown => {
  RUNS.push({ src, js, unordered: true });
  return expr(src);
};

describe("compiler/emit — string methods", () => {
  it("lowers each string method to its operator", () => {
    expect(compiled("$.s.trim()", (d) => d.s.trim())).toEqual({ $trim: { input: "$s" } });
    expect(compiled("$.s.trimStart()", (d) => d.s.trimStart())).toEqual({ $ltrim: { input: "$s" } });
    expect(compiled("$.s.trimEnd()", (d) => d.s.trimEnd())).toEqual({ $rtrim: { input: "$s" } });
    expect(compiled("$.s.toLowerCase()", (d) => d.s.toLowerCase())).toEqual({ $toLower: "$s" });
    expect(compiled("$.s.toUpperCase()", (d) => d.s.toUpperCase())).toEqual({ $toUpper: "$s" });
    expect(compiled('$.csv.split(",")', (d) => d.csv.split(","))).toEqual({ $split: ["$csv", ","] });
    expect(compiled("$.csv.charAt(0)", (d) => d.csv.charAt(0))).toEqual({ $substrCP: ["$csv", 0, 1] });
    expect(compiled("$.csv.charAt(-1)", (d) => d.csv.charAt(-1))).toBe("");
    expect(compiled('$.csv.startsWith("a")', (d) => d.csv.startsWith("a"))).toEqual({
      $eq: [{ $indexOfCP: ["$csv", "a"] }, 0],
    });
    expect(compiled('$.csv.endsWith("c")', (d) => d.csv.endsWith("c"))).toEqual({
      $let: {
        vars: { jsmqlStr: { $ifNull: ["$csv", ""] } },
        in: {
          $eq: [{ $substrCP: ["$$jsmqlStr", { $max: [0, { $subtract: [{ $strLenCP: "$$jsmqlStr" }, 1] }] }, 1] }, "c"],
        },
      },
    });
    expect(compiled("$.csv.search(/b/)", (d) => d.csv.search(/b/))).toEqual({
      $ifNull: [{ $getField: { field: "idx", input: { $regexFind: { input: "$csv", regex: "b" } } } }, -1],
    });
    expect(compiled('$.csv.padStart(7, "-")', (d) => d.csv.padStart(7, "-"))).toMatchObject({ $let: {} });
    expect(compiled('$.csv.padEnd(6, "xy")', (d) => d.csv.padEnd(6, "xy"))).toMatchObject({ $let: {} });
    expect(compiled("$.csv.repeat(2)", (d) => d.csv.repeat(2))).toEqual({
      $reduce: { input: { $range: [0, 2] }, initialValue: "", in: { $concat: ["$$value", "$csv"] } },
    });
    expect(compiled("$.csv.substr(2, 2)", (d) => d.csv.substr(2, 2))).toEqual({ $substrCP: ["$csv", 2, 2] });
    expect(compiled("$.csv.substring(1, 3)", (d) => d.csv.substring(1, 3))).toEqual({ $substrCP: ["$csv", 1, 2] });
    expect(compiled('$.csv.replace(",", ";")', (d) => d.csv.replace(",", ";"))).toEqual({
      $replaceOne: { input: "$csv", find: ",", replacement: ";" },
    });
    expect(compiled('$.csv.replaceAll(",", ";")', (d) => d.csv.replaceAll(",", ";"))).toEqual({
      $replaceAll: { input: "$csv", find: ",", replacement: ";" },
    });
    expect(compiled("$.csv.match(/B/i)", (d) => /B/i.test(d.csv))).toEqual({
      $regexMatch: { input: "$csv", regex: "B", options: "i" },
    });
    expect(compiled("$.csv.truncate({ length: 3 })", () => "...")).toMatchObject({ $let: {} });
    // lodash
    expect(compiled("$.w.capitalize()", () => "Foobar baz-qux")).toMatchObject({ $concat: [{ $toUpper: {} }, {}] });
    expect(compiled("$.w.upperFirst()", () => "FooBar baz-qux")).toHaveProperty("$concat");
    expect(compiled("$.w.words()", () => ["foo", "Bar", "baz", "qux"])).toMatchObject({ $map: {} });
    expect(compiled("$.w.kebabCase()", () => "foo-bar-baz-qux")).toMatchObject({ $toLower: {} });
    expect(compiled("$.w.snakeCase()", () => "foo_bar_baz_qux")).toMatchObject({ $toLower: {} });
    expect(compiled("$.w.startCase()", () => "Foo Bar Baz Qux")).toMatchObject({ $reduce: {} });
    expect(compiled("$.w.camelCase()", () => "fooBarBazQux")).toMatchObject({ $let: {} });
    expect(compiled("$.h.escape()", () => "&lt;a &amp; b&gt;")).toMatchObject({ $replaceAll: {} });
    expect(compiled("$.n.inRange(2, 10)", (d) => d.n >= 2 && d.n < 10)).toHaveProperty("$and");
  });

  it("refuses what JavaScript refuses, and names the type the method takes", () => {
    expect(() => expr("$.s.matchAll(/a/)")).toThrow(/needs the 'g' flag/);
    expect(() => expr('$.s.truncate({ separator: " " })')).toThrow(/has no parameter 'separator'/);
    expect(() => expr("$abs($.n).trim()")).toThrow(/not available on a 'number'.*toString/);
    expect(() => expr('$.s.startsWith("A").trim()')).toThrow(/not available on a 'bool'/);
    expect(() => expr("$.csv.split(',').toUpperCase()")).toThrow(/Map over the array first/);
  });
});

describe("compiler/emit — date methods", () => {
  it("counts months and weekdays from 0, as JavaScript does", () => {
    // measured: `$month` of March is 3, `$dayOfWeek` of a Sunday is 1
    expect(compiled("$.d.getUTCFullYear()", (d) => d.d.getUTCFullYear())).toEqual({ $year: "$d" });
    expect(compiled("$.d.getUTCMonth()", (d) => d.d.getUTCMonth())).toEqual({ $subtract: [{ $month: "$d" }, 1] });
    expect(compiled("$.d.getUTCDate()", (d) => d.d.getUTCDate())).toEqual({ $dayOfMonth: "$d" });
    expect(compiled("$.d.getUTCDay()", (d) => d.d.getUTCDay())).toEqual({ $subtract: [{ $dayOfWeek: "$d" }, 1] });
    expect(compiled("$.d.getUTCHours()", (d) => d.d.getUTCHours())).toEqual({ $hour: "$d" });
    expect(compiled("$.d.getUTCMinutes()", (d) => d.d.getUTCMinutes())).toEqual({ $minute: "$d" });
    expect(compiled("$.d.getUTCSeconds()", (d) => d.d.getUTCSeconds())).toEqual({ $second: "$d" });
    expect(compiled("$.d.getUTCMilliseconds()", (d) => d.d.getUTCMilliseconds())).toEqual({ $millisecond: "$d" });
    // the local-time accessors are the same operators: the server knows no client timezone, so they read UTC
    expect(compiled("$.d.getMonth()", (d) => d.d.getUTCMonth(), "local time is UTC on the server")).toEqual({
      $subtract: [{ $month: "$d" }, 1],
    });
    expect(compiled("$.d.getTime()", (d) => d.d.getTime())).toEqual({ $toLong: "$d" });
    expect(compiled("$.d.toISOString()", (d) => d.d.toISOString())).toEqual({ $dateToString: { date: "$d" } });
  });

  it("lowers the date arithmetic with its options", () => {
    expect(compiled('$.d.plus(1, "day")', (d) => new Date(d.d.getTime() + 86400000))).toEqual({
      $dateAdd: { startDate: "$d", unit: "day", amount: 1 },
    });
    expect(compiled('$.d.minus(30, "minute", "UTC")', (d) => new Date(d.d.getTime() - 1800000))).toEqual({
      $dateSubtract: { startDate: "$d", unit: "minute", amount: 30, timezone: "UTC" },
    });
    expect(compiled('$.d.isSame($.e, "month")', () => true)).toEqual({
      $eq: [{ $dateTrunc: { date: "$d", unit: "month" } }, { $dateTrunc: { date: "$e", unit: "month" } }],
    });
    expect(compiled('$.d.isAfter($.e, "day", { timezone: "UTC", startOfWeek: "mon" })', () => true)).toEqual({
      $gt: [
        { $dateTrunc: { date: "$d", unit: "day", timezone: "UTC", startOfWeek: "mon" } },
        { $dateTrunc: { date: "$e", unit: "day", timezone: "UTC", startOfWeek: "mon" } },
      ],
    });
    expect(compiled("$.d.quarter()", () => 1)).toEqual({ $toInt: { $ceil: { $divide: [{ $month: "$d" }, 3] } } });
    expect(compiled('$.d.isoWeek("UTC")', () => 11)).toEqual({ $isoWeek: { date: "$d", timezone: "UTC" } });
    expect(compiled('$.d.format("%Y-%m-%d")', () => "2026-03-15")).toEqual({
      $dateToString: { date: "$d", format: "%Y-%m-%d" },
    });
    expect(compiled('$.d.startOf("month")', (d) => d.e)).toEqual({ $dateTrunc: { date: "$d", unit: "month" } });
    expect(compiled('$.d.endOf("day")', () => new Date("2026-03-15T23:59:59.999Z"))).toEqual({
      $dateSubtract: {
        startDate: { $dateAdd: { startDate: { $dateTrunc: { date: "$d", unit: "day" } }, unit: "day", amount: 1 } },
        unit: "millisecond",
        amount: 1,
      },
    });
    expect(compiled('$.d.diff($.e, "day")', () => 14)).toEqual({
      $dateDiff: { startDate: "$e", endDate: "$d", unit: "day" },
    });
    expect(
      compiled(
        "$.d.set({ hour: 0, minute: 0, second: 0, millisecond: 0 })",
        () => new Date("2026-03-15T00:00:00.000Z"),
      ),
    ).toMatchObject({ $let: { vars: { jsmqlParts: { $dateToParts: { date: "$d" } } } } });
  });

  it("refuses a unit, a format or a part the server refuses", () => {
    expect(() => expr('$.d.plus(1, "fortnight")')).toThrow(/must be one of/);
    expect(() => expr('$.d.plus(1.5, "day")')).toThrow(/expects an integer/);
    expect(() => expr("$.d.isAfter($.e)")).toThrow(/without a unit is just '>'/);
    expect(() => expr('$.d.format("YYYY-MM-DD")')).toThrow(/Moment\/Luxon/);
    expect(() => expr('$.d.format("%Q")')).toThrow(/invalid specifier '%Q'/);
    expect(() => expr("$.d.set({ year: 2020, isoWeek: 2 })")).toThrow(/two families that never mix/);
    expect(() => expr("$.d.set({ foo: 1 })")).toThrow(/has no parameter 'foo'/);
    expect(() => expr('$.d.startOf("day", { bogus: 1 })')).toThrow(/has no parameter 'bogus'/);
  });
});

describe("compiler/emit — object methods", () => {
  it("maps, filters and reshapes a document's pairs", () => {
    expect(compiled("$.o.mapValues(v => v * 2)", (d) => ({ a: 2, b: 4, _c: 6 }))).toEqual({
      $arrayToObject: {
        $map: {
          input: { $objectToArray: "$o" },
          as: "jsmqlKv",
          in: { k: "$$jsmqlKv.k", v: { $let: { vars: { v: "$$jsmqlKv.v" }, in: { $multiply: ["$$v", 2] } } } },
        },
      },
    });
    expect(compiled("$.o.mapKeys((v, k) => k.toUpperCase())", () => ({ A: 1, B: 2, _C: 3 }))).toMatchObject({
      $arrayToObject: { $map: { as: "jsmqlKv" } },
    });
    expect(compiled("$.o.pickBy(v => v > 1)", () => ({ b: 2, _c: 3 }))).toMatchObject({
      $arrayToObject: { $filter: {} },
    });
    expect(compiled('$.o.omitBy((v, k) => k.startsWith("_"))', () => ({ a: 1, b: 2 }))).toMatchObject({
      $arrayToObject: { $filter: {} },
    });
    expect(compiled("$.o.invert()", () => ({ "1": "a", "2": "b", "3": "_c" }))).toMatchObject({
      $arrayToObject: { $map: {} },
    });
    expect(
      compiled("$.o.toPairs()", () => [
        ["a", 1],
        ["b", 2],
        ["_c", 3],
      ]),
    ).toMatchObject({ $map: {} });
    expect(compiled('$.o.pick(["a", "b"])', () => ({ a: 1, b: 2 }))).toEqual({
      $let: {
        vars: { jsmqlObj: "$o" },
        in: {
          a: { $getField: { field: "a", input: "$$jsmqlObj" } },
          b: { $getField: { field: "b", input: "$$jsmqlObj" } },
        },
      },
    });
    expect(compiled('$.o.omit(["_c"])', () => ({ a: 1, b: 2 }))).toMatchObject({ $arrayToObject: { $filter: {} } });
    expect(() => expr('$.o.pick(["$a"])')).toThrow(/starts with '\$'/);
    expect(() => expr("$.o.mapValues(5)")).toThrow(/one- or two-parameter arrow/);
  });
});

describe("compiler/emit — array methods", () => {
  it("iterates with a callback, with or without its index", () => {
    expect(compiled("$.a.map(x => x * 2)", (d) => d.a.map((x) => x * 2))).toEqual({
      $map: { input: "$a", as: "x", in: { $multiply: ["$$x", 2] } },
    });
    // an index READ makes the input the `[i, x]` pairs
    expect(compiled("$.a.map((x, i) => x + i)", (d) => d.a.map((x, i) => x + i))).toEqual({
      $map: {
        input: { $zip: { inputs: [{ $range: [0, { $size: "$a" }] }, "$a"] } },
        as: "jsmqlPair",
        in: {
          $let: {
            vars: { x: { $arrayElemAt: ["$$jsmqlPair", 1] }, i: { $arrayElemAt: ["$$jsmqlPair", 0] } },
            in: { $add: ["$$x", "$$i"] },
          },
        },
      },
    });
    expect(compiled("$.a.filter(x => x > 1)", (d) => d.a.filter((x) => x > 1))).toEqual({
      $filter: { input: "$a", as: "x", cond: { $gt: ["$$x", 1] } },
    });
    expect(compiled("$.a.filter((x, i) => i > 0)", (d) => d.a.filter((_x, i) => i > 0))).toMatchObject({
      $map: { as: "jsmqlPair" },
    });
    expect(compiled("$.a.find(x => x > 1)", (d) => d.a.find((x) => x > 1))).toEqual({
      $arrayElemAt: [{ $filter: { input: "$a", as: "x", cond: { $gt: ["$$x", 1] } } }, 0],
    });
    expect(compiled("$.a.findLast(x => x > 1)", (d) => d.a.findLast((x) => x > 1))).toMatchObject({
      $arrayElemAt: [{}, -1],
    });
    expect(compiled("$.a.some(x => x > 2)", (d) => d.a.some((x) => x > 2))).toEqual({
      $anyElementTrue: { $map: { input: { $ifNull: ["$a", []] }, as: "x", in: { $gt: ["$$x", 2] } } },
    });
    expect(compiled("$.a.every(x => x > 0)", (d) => d.a.every((x) => x > 0))).toMatchObject({ $allElementsTrue: {} });
    expect(compiled("$.nested.flatMap(x => x)", (d) => d.nested.flatMap((x) => x))).toMatchObject({ $reduce: {} });
    expect(
      compiled("$.docs.map((x, i, arr) => arr.length)", (d) => d.docs.map((_x, _i, arr) => arr.length)),
    ).toMatchObject({ $map: { in: { $let: { vars: { arr: "$docs" } } } } });
  });

  it("slices and reshapes", () => {
    expect(compiled("$.a.take(2)", (d) => d.a.slice(0, 2))).toEqual({ $slice: ["$a", 2] });
    expect(compiled("$.a.takeRight(2)", (d) => d.a.slice(-2))).toEqual({ $slice: ["$a", -2] });
    expect(compiled("$.a.drop(1)", (d) => d.a.slice(1))).toMatchObject({ $let: {} });
    expect(compiled("$.a.dropRight(1)", (d) => d.a.slice(0, -1))).toMatchObject({ $let: {} });
    expect(compiled("$.a.tail()", (d) => d.a.slice(1))).toMatchObject({ $let: {} });
    expect(compiled("$.a.initial()", (d) => d.a.slice(0, -1))).toMatchObject({ $let: {} });
    expect(compiled("$.a.head()", (d) => d.a[0])).toEqual({ $first: "$a" });
    expect(compiled("$.a.last()", (d) => d.a[2])).toEqual({ $last: "$a" });
    expect(compiled("$.a.chunk(2)", () => [[3, 1], [2]])).toMatchObject({ $map: {} });
    expect(compiled("$.nested.flat()", (d) => d.nested.flat())).toMatchObject({ $reduce: {} });
    expect(
      compiled("$.a.zip($.b)", () => [
        [3, 2],
        [1, 5],
        [2, null],
      ]),
    ).toEqual({ $zip: { inputs: ["$a", "$b"], useLongestLength: true } });
    expect(
      compiled("$.nested.unzip()", () => [
        [1, 3],
        [2, null],
      ]),
    ).toMatchObject({ $let: {} });
    expect(compiled('["k1", "k2"].zipObject($.b)', () => ({ k1: 2, k2: 5 }))).toMatchObject({ $arrayToObject: {} });
    expect(compiled("$.pairs.fromPairs()", () => ({ k: 1 }))).toMatchObject({ $arrayToObject: {} });
    expect(compiled("$.a.toReversed()", (d) => d.a.toReversed())).toEqual({ $reverseArray: "$a" });
    expect(compiled("$.a.toSorted()", (d) => d.a.toSorted())).toEqual({ $sortArray: { input: "$a", sortBy: 1 } });
    expect(compiled("$.docs.toSorted({ v: -1 })", (d) => d.docs.toSorted((p, q) => q.v - p.v))).toEqual({
      $sortArray: { input: "$docs", sortBy: { v: -1 } },
    });
    expect(compiled("$.docs.sortBy(x => x.v)", (d) => d.docs.toSorted((p, q) => p.v - q.v))).toEqual({
      $sortArray: { input: "$docs", sortBy: { v: 1 } },
    });
    // a computed key sorts `{ k, v }` pairs and takes the values back
    expect(
      compiled("$.docs.sortBy(x => x.v % 2)", () => [
        { k: "x", v: 2 },
        { k: "y", v: 1 },
        { k: "x", v: 3 },
      ]),
    ).toMatchObject({ $map: { input: { $sortArray: { sortBy: { k: 1 } } } } });
    expect(compiled('$.docs.orderBy(["v"], [-1])', (d) => d.docs.toSorted((p, q) => q.v - p.v))).toEqual({
      $sortArray: { input: "$docs", sortBy: { v: -1 } },
    });
    expect(compiled("$.a.toSpliced(1, 1, 9)", (d) => d.a.toSpliced(1, 1, 9))).toMatchObject({ $let: {} });
    expect(compiled("$.a.with(0, 9)", (d) => d.a.with(0, 9))).toMatchObject({ $let: {} });
    // measured: a three-argument `$slice` refuses a count of 0, which the first and last index reach
    expect(compiled("$.a.with(2, 9)", (d) => d.a.with(2, 9))).toMatchObject({ $let: {} });
    expect(compiled("$.a.toSpliced(3, 0, 4)", (d) => d.a.toSpliced(3, 0, 4))).toMatchObject({ $let: {} });
    expect(compiled("$.a.toSpliced(0, 3)", (d) => d.a.toSpliced(0, 3))).toMatchObject({ $let: {} });
  });

  it("dispatches a method two prototypes share on the receiver's type at run time", () => {
    expect(compiled("$.a.indexOf(1)", (d) => d.a.indexOf(1))).toMatchObject({ $switch: {} });
    expect(compiled('$.csv.indexOf("b")', (d) => d.csv.indexOf("b"))).toMatchObject({ $switch: {} });
    expect(compiled("$.a.includes(2)", (d) => d.a.includes(2))).toMatchObject({ $switch: {} });
    expect(compiled('$.csv.includes("b")', (d) => d.csv.includes("b"))).toMatchObject({ $switch: {} });
    expect(compiled("$.a.lastIndexOf(2)", (d) => d.a.lastIndexOf(2))).toMatchObject({ $switch: {} });
    expect(compiled("$.a.at(-1)", (d) => d.a.at(-1))).toMatchObject({ $switch: {} });
    expect(compiled("$.csv.at(0)", (d) => d.csv.at(0))).toMatchObject({ $switch: {} });
    expect(compiled("$.a.slice(1, 3)", (d) => d.a.slice(1, 3))).toMatchObject({ $switch: {} });
    expect(compiled("$.csv.slice(2)", (d) => d.csv.slice(2))).toMatchObject({ $switch: {} });
    expect(compiled("$.a.concat($.b)", (d) => d.a.concat(d.b))).toMatchObject({ $switch: {} });
    expect(compiled("$.a.size()", (d) => d.a.length)).toMatchObject({ $switch: {} });
    expect(compiled("$.o.size()", (d) => Object.keys(d.o).length)).toMatchObject({ $switch: {} });
    expect(compiled("$.a.toString()", (d) => d.a.toString())).toMatchObject({ $let: {} });
    expect(compiled("$.n.toString()", (d) => d.n.toString())).toMatchObject({ $let: {} });
    expect(compiled('$.a.join("-")', (d) => d.a.join("-"))).toMatchObject({ $reduce: {} });
    expect(compiled("$.n.clamp(0, 5)", () => 5)).toEqual({ $min: [{ $max: ["$n", 0] }, 5] });
    // a receiver PROVEN to be one family runs that cell alone
    expect(compiled('$.csv.split(",").indexOf("b")', (d) => d.csv.split(",").indexOf("b"))).toEqual({
      $indexOfArray: [{ $split: ["$csv", ","] }, "b"],
    });
  });

  it("folds, sets and groups as lodash does", () => {
    expect(compiled("$.a.sum()", (d) => 6)).toEqual({ $sum: "$a" });
    expect(compiled("$.a.mean()", (d) => 2)).toEqual({ $avg: "$a" });
    expect(compiled("$.a.max()", (d) => 3)).toEqual({ $max: "$a" });
    expect(compiled("$.docs.sumBy(x => x.v)", () => 6)).toEqual({
      $sum: { $map: { input: "$docs", as: "x", in: "$$x.v" } },
    });
    expect(compiled('$.docs.maxBy("v")', () => ({ k: "x", v: 3 }))).toMatchObject({ $let: {} });
    expect(compiled("$.docs.minBy(x => x.v)", () => ({ k: "y", v: 1 }))).toMatchObject({ $let: {} });
    expect(unordered("$.mixed.uniq()", () => [0, 1, "", "a", null, false, true])).toEqual({ $setUnion: "$mixed" });
    expect(
      compiled('$.docs.uniqBy("k")', () => [
        { k: "x", v: 2 },
        { k: "y", v: 1 },
      ]),
    ).toMatchObject({ $getField: { field: "out" } });
    expect(compiled("$.mixed.compact()", (d) => d.mixed.filter(Boolean))).toMatchObject({ $filter: {} });
    expect(compiled("$.nested.flatten()", (d) => d.nested.flat())).toMatchObject({ $reduce: {} });
    expect(unordered("$.a.intersection($.b)", () => [2])).toEqual({ $setIntersection: ["$a", "$b"] });
    expect(compiled("$.a.difference($.b)", () => [3, 1])).toMatchObject({ $filter: {} });
    expect(unordered("$.a.union($.b)", () => [3, 1, 2, 5])).toEqual({ $setUnion: ["$a", "$b"] });
    expect(compiled("$.a.without(1)", () => [3, 2])).toMatchObject({ $filter: {} });
    expect(unordered("$.a.xor($.b)", () => [3, 1, 5])).toHaveProperty("$setUnion");
    expect(compiled('$.docs.keyBy("k")', () => ({ x: { k: "x", v: 3 }, y: { k: "y", v: 1 } }))).toMatchObject({
      $arrayToObject: {},
    });
    expect(
      compiled('$.docs.groupBy("k")', () => ({
        x: [
          { k: "x", v: 2 },
          { k: "x", v: 3 },
        ],
        y: [{ k: "y", v: 1 }],
      })),
    ).toMatchObject({ $arrayToObject: {} });
    expect(compiled('$.docs.countBy("k")', () => ({ x: 2, y: 1 }))).toMatchObject({ $arrayToObject: {} });
    expect(compiled("$.a.partition(x => x > 1)", () => [[3, 2], [1]])).toHaveLength(2);
    expect(compiled("$.a.reject(x => x > 1)", () => [1])).toMatchObject({ $filter: {} });
    expect(compiled("$.a.takeWhile(x => x > 1)", () => [3])).toMatchObject({ $let: {} });
    expect(compiled("$.a.dropWhile(x => x > 1)", () => [1, 2])).toMatchObject({ $let: {} });
  });

  it("refuses what the server or JavaScript would", () => {
    expect(() => expr("$.a.take(-1)")).toThrow(/from 0 to Infinity/);
    expect(() => expr("$.a.chunk($.n)")).toThrow(/compile-time constant/);
    expect(() => expr("$.a.flat(2)")).toThrow(/from 1 to 1/);
    expect(() => expr("$.a.includes(x => x > 1)")).toThrow(/searches for a VALUE/);
    expect(() => expr("$.a.map(5)")).toThrow(/takes an arrow/);
    expect(() => expr("$.a.map((a, b, c, d) => a)")).toThrow(/at most 3 parameters/);
  });
});

// ── the server ───────────────────────────────────────────────────────────────

let client: MongoClient | null = null;
let coll: Collection | null = null;

beforeAll(async () => {
  try {
    const c = new MongoClient(URI, { serverSelectionTimeoutMS: 800 });
    await c.connect();
    await c.db("admin").command({ ping: 1 });
    client = c;
    coll = c.db("jsmql_compiler_methods").collection("t");
    await coll.deleteMany({});
    await coll.insertOne({ ...DOC });
  } catch {
    client = null;
    coll = null;
  }
});

afterAll(async () => {
  await client?.close();
});

const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => {
    if (x instanceof Date) return x.toISOString();
    if (typeof x === "number" && !Number.isInteger(x)) return Number(x.toFixed(9));
    if (x !== null && typeof x === "object" && !Array.isArray(x))
      return Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)));
    return x;
  });

describe("compiler/emit — the server answers each method as JavaScript would", () => {
  it("ran each one, or none", async () => {
    if (coll === null) {
      expect(RUNS.length).toBeGreaterThan(0);
      return;
    }
    const problems: string[] = [];
    for (const { src, js, note, unordered: anyOrder } of RUNS) {
      let got: unknown;
      try {
        const [doc] = await coll.aggregate([{ $addFields: { __v: expr(src) } }]).toArray();
        got = doc.__v;
      } catch (e) {
        problems.push(`${src}\n  ${JSON.stringify(expr(src))}\n  ${(e as Error).message}`);
        continue;
      }
      const want = js(DOC);
      // a set operation answers in no promised order (SR2): its elements are compared, not their sequence
      const sorted = (v: unknown): unknown =>
        anyOrder && Array.isArray(v) ? [...v].map((x) => canonical(x)).sort() : v;
      if (canonical(sorted(got)) !== canonical(sorted(want)))
        problems.push(`${src}${note ? ` (${note})` : ""}\n  server ${canonical(got)}\n  js     ${canonical(want)}`);
    }
    expect(problems, `${problems.length} of ${RUNS.length}:\n${problems.join("\n")}`).toEqual([]);
  });
});
