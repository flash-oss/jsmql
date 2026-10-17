// Phase 5 of src/compiler/ — the METHOD cells of the value target, family by family.
//
// A method's row carries its value cell (`expr: { args, emit }`). This suite holds
// one spelling per cell, asserts the MQL, and runs every spelling on a live mongod
// over a fixture. It compares the value the server returns with the value JavaScript
// returns for the same input. Where JavaScript and MongoDB cannot agree (a local-time
// accessor on a server that knows no client timezone), the case says so and asserts
// the MongoDB answer.
//
// This suite self-skips (reports green) when no mongod is reachable, with the all-or-nothing
// guard: a suite that quietly degrades to compile-only looks exactly like one that passed.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoClient, type Collection } from "mongodb";
import { expr } from "../src/compiler/index.ts";
import { PRODUCTIONS } from "../src/registry/productions.ts";
import { NAMES } from "../src/registry/names.ts";
import { jsmql } from "../src/index.ts";
import { liveClient, liveUp } from "./fixtures/live.ts";

/** Is the project's mongod running? Settled once, for the blocks that need it. */
const up = await liveUp();

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
  keys: ["a", "_c"],
  kname: "_c",
  h: "<a & b>",
  // separator runs around the words, for lodash's word-case methods
  dashed: "--Foo-Bar--",
  under: "__FOO_BAR__",
  a: [3, 1, 2],
  b: [2, 5],
  // an array that holds a value more than once, for the set operations
  dup: [3, 1, 3, 2, 1],
  docs: [
    { k: "x", v: 2 },
    { k: "y", v: 1 },
    { k: "x", v: 3 },
  ],
  nested: [[1, 2], [3]],
  pairs: [["k", 1]],
  mixed: [0, 1, "", "a", null, false, true],
  // a document whose values are falsy in JavaScript, and truthy on the server but for `false`, `null` and `0`
  mo: { a: "", b: 1, c: 0, d: null, e: "x", f: false, g: [] },
};

type Case = { src: string; js: (d: typeof DOC) => unknown; note?: string; unordered?: true };
const RUNS: Case[] = [];
/** Assert the shape, and remember the source for the server half with the JavaScript answer. */
const compiled = (src: string, js: (d: typeof DOC) => unknown, note?: string): unknown => {
  RUNS.push({ src, js, note });
  return expr(src);
};
/**
 * For a SET operation: MongoDB's `$setUnion` and its kin return elements in no promised
 * order. A developer never writes an order, so we compare the elements, not their
 * sequence. This reflects MongoDB behaviour (SR2).
 */
const unordered = (src: string, js: (d: typeof DOC) => unknown): unknown => {
  RUNS.push({ src, js, unordered: true });
  return expr(src);
};
/**
 * The shape a JavaScript method takes on a receiver that may be null or missing. This
 * shape tests the receiver first, then runs the method inside. It answers null where
 * JavaScript would throw. A receiver that is certainly there (a literal, a `$lookup`'s
 * array) does not need a test.
 */
const nullOr = (recv: unknown, body: unknown): unknown => ({ $cond: [{ $lte: [recv, null] }, null, body] });

describe("compiler/emit — string methods", () => {
  it("lowers each string method to its operator", () => {
    expect(compiled("$.s.trim()", (d) => d.s.trim())).toEqual({ $trim: { input: "$s" } });
    expect(compiled("$.s.trimStart()", (d) => d.s.trimStart())).toEqual({ $ltrim: { input: "$s" } });
    expect(compiled("$.s.trimEnd()", (d) => d.s.trimEnd())).toEqual({ $rtrim: { input: "$s" } });
    expect(compiled("$.s.toLowerCase()", (d) => d.s.toLowerCase())).toEqual({
      $cond: [{ $lte: ["$s", null] }, null, { $toLower: "$s" }],
    });
    expect(compiled("$.s.toUpperCase()", (d) => d.s.toUpperCase())).toEqual({
      $cond: [{ $lte: ["$s", null] }, null, { $toUpper: "$s" }],
    });
    expect(compiled('$.csv.split(",")', (d) => d.csv.split(","))).toEqual({ $split: ["$csv", ","] });
    expect(compiled("$.csv.charAt(0)", (d) => d.csv.charAt(0))).toEqual({
      $cond: [{ $lte: ["$csv", null] }, null, { $substrCP: ["$csv", 0, 1] }],
    });
    expect(compiled("$.csv.charAt(-1)", (d) => d.csv.charAt(-1))).toBe("");
    expect(compiled('$.csv.startsWith("a")', (d) => d.csv.startsWith("a"))).toEqual({
      $cond: [{ $lte: ["$csv", null] }, null, { $eq: [{ $indexOfCP: ["$csv", "a"] }, 0] }],
    });
    expect(compiled('$.csv.endsWith("c")', (d) => d.csv.endsWith("c"))).toEqual({
      $cond: [
        { $lte: ["$csv", null] },
        null,
        {
          $let: {
            vars: { jsmqlStr: "$csv" },
            in: {
              $eq: [
                { $substrCP: ["$$jsmqlStr", { $max: [0, { $subtract: [{ $strLenCP: "$$jsmqlStr" }, 1] }] }, 1] },
                "c",
              ],
            },
          },
        },
      ],
    });
    expect(compiled("$.csv.search(/b/)", (d) => d.csv.search(/b/))).toEqual({
      $cond: [
        { $lte: ["$csv", null] },
        null,
        { $ifNull: [{ $getField: { field: "idx", input: { $regexFind: { input: "$csv", regex: "b" } } } }, -1] },
      ],
    });
    expect(compiled('$.csv.padStart(7, "-")', (d) => d.csv.padStart(7, "-"))).toEqual({
      $cond: [
        { $lte: ["$csv", null] },
        null,
        {
          $let: {
            vars: { jsmqlPad: "$csv" },
            in: {
              $concat: [
                {
                  $reduce: {
                    input: { $range: [0, { $subtract: [7, { $strLenCP: "$$jsmqlPad" }] }] },
                    initialValue: "",
                    in: { $concat: ["$$value", "-"] },
                  },
                },
                "$$jsmqlPad",
              ],
            },
          },
        },
      ],
    });
    expect(compiled('$.csv.padEnd(6, "xy")', (d) => d.csv.padEnd(6, "xy"))).toEqual({
      $cond: [
        { $lte: ["$csv", null] },
        null,
        {
          $let: {
            vars: { jsmqlPad: "$csv" },
            in: {
              $concat: [
                "$$jsmqlPad",
                {
                  $substrCP: [
                    {
                      $reduce: {
                        input: { $range: [0, { $subtract: [6, { $strLenCP: "$$jsmqlPad" }] }] },
                        initialValue: "",
                        in: { $concat: ["$$value", "xy"] },
                      },
                    },
                    0,
                    { $max: [0, { $subtract: [6, { $strLenCP: "$$jsmqlPad" }] }] },
                  ],
                },
              ],
            },
          },
        },
      ],
    });
    expect(compiled("$.csv.repeat(2)", (d) => d.csv.repeat(2))).toEqual({
      $reduce: { input: { $range: [0, 2] }, initialValue: "", in: { $concat: ["$$value", "$csv"] } },
    });
    expect(compiled("$.csv.substr(2, 2)", (d) => d.csv.substr(2, 2))).toEqual({
      $cond: [{ $lte: ["$csv", null] }, null, { $substrCP: ["$csv", 2, 2] }],
    });
    expect(compiled("$.csv.substring(1, 3)", (d) => d.csv.substring(1, 3))).toEqual({
      $cond: [{ $lte: ["$csv", null] }, null, { $substrCP: ["$csv", 1, 2] }],
    });
    // `.indexOfSubstring()` is JavaScript's `String.prototype.indexOf`. A negative position
    // reads as 0, as in JavaScript, because `$indexOfCP` refuses a negative start.
    expect(compiled('$.csv.indexOfSubstring("b")', (d) => d.csv.indexOf("b"))).toEqual({ $indexOfCP: ["$csv", "b"] });
    expect(compiled('$.csv.indexOfSubstring(",", 2)', (d) => d.csv.indexOf(",", 2))).toEqual({
      $indexOfCP: ["$csv", ",", 2],
    });
    expect(compiled('$.csv.indexOfSubstring("a", -2)', (d) => d.csv.indexOf("a", -2))).toEqual({
      $indexOfCP: ["$csv", "a"],
    });
    expect(compiled('$.csv.indexOfSubstring("a", $.neg)', (d) => d.csv.indexOf("a", d.neg))).toEqual({
      $indexOfCP: ["$csv", "a", { $max: [0, "$neg"] }],
    });
    expect(compiled('$.csv.replace(",", ";")', (d) => d.csv.replace(",", ";"))).toEqual({
      $replaceOne: { input: "$csv", find: ",", replacement: ";" },
    });
    expect(compiled('$.csv.replaceAll(",", ";")', (d) => d.csv.replaceAll(",", ";"))).toEqual({
      $replaceAll: { input: "$csv", find: ",", replacement: ";" },
    });
    expect(compiled("$.csv.match(/B/i)", (d) => /B/i.test(d.csv))).toEqual({
      $cond: [{ $lte: ["$csv", null] }, null, { $regexMatch: { input: "$csv", regex: "B", options: "i" } }],
    });
    expect(compiled("$.csv.truncate({ length: 3 })", () => "...")).toEqual({
      $let: {
        vars: { jsmqlStr: { $ifNull: ["$csv", ""] } },
        in: {
          $cond: [
            { $gt: [{ $strLenCP: "$$jsmqlStr" }, 3] },
            { $concat: [{ $substrCP: ["$$jsmqlStr", 0, 0] }, "..."] },
            "$$jsmqlStr",
          ],
        },
      },
    });
    // lodash
    expect(compiled("$.w.capitalize()", () => "Foobar baz-qux")).toEqual({
      $concat: [
        { $toUpper: { $substrCP: ["$w", 0, 1] } },
        { $toLower: { $substrCP: ["$w", 1, { $strLenCP: { $ifNull: ["$w", ""] } }] } },
      ],
    });
    expect(compiled("$.w.upperFirst()", () => "FooBar baz-qux")).toEqual({
      $concat: [
        { $toUpper: { $substrCP: ["$w", 0, 1] } },
        { $substrCP: ["$w", 1, { $strLenCP: { $ifNull: ["$w", ""] } }] },
      ],
    });
    expect(compiled("$.w.words()", () => ["foo", "Bar", "baz", "qux"])).toEqual({
      $map: {
        input: { $regexFindAll: { input: "$w", regex: "[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[A-Z]|[0-9]+" } },
        as: "jsmqlWord",
        in: "$$jsmqlWord.match",
      },
    });
    expect(compiled("$.w.kebabCase()", () => "foo-bar-baz-qux")).toEqual({
      $toLower: {
        $reduce: {
          input: {
            $map: {
              input: { $regexFindAll: { input: "$w", regex: "[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[A-Z]|[0-9]+" } },
              as: "jsmqlWord",
              in: "$$jsmqlWord.match",
            },
          },
          initialValue: "",
          in: { $cond: [{ $eq: ["$$value", ""] }, "$$this", { $concat: ["$$value", "-", "$$this"] }] },
        },
      },
    });
    // lodash's answers: _.lowerCase and _.upperCase over the same fields
    expect(compiled("$.w.lowerCase()", () => "foo bar baz qux")).toEqual({
      $toLower: {
        $reduce: {
          input: {
            $map: {
              input: { $regexFindAll: { input: "$w", regex: "[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[A-Z]|[0-9]+" } },
              as: "jsmqlWord",
              in: "$$jsmqlWord.match",
            },
          },
          initialValue: "",
          in: { $cond: [{ $eq: ["$$value", ""] }, "$$this", { $concat: ["$$value", " ", "$$this"] }] },
        },
      },
    });
    expect(compiled("$.dashed.lowerCase()", () => "foo bar")).toEqual({
      $toLower: {
        $reduce: {
          input: {
            $map: {
              input: { $regexFindAll: { input: "$dashed", regex: "[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[A-Z]|[0-9]+" } },
              as: "jsmqlWord",
              in: "$$jsmqlWord.match",
            },
          },
          initialValue: "",
          in: { $cond: [{ $eq: ["$$value", ""] }, "$$this", { $concat: ["$$value", " ", "$$this"] }] },
        },
      },
    });
    expect(compiled("$.under.lowerCase()", () => "foo bar")).toEqual({
      $toLower: {
        $reduce: {
          input: {
            $map: {
              input: { $regexFindAll: { input: "$under", regex: "[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[A-Z]|[0-9]+" } },
              as: "jsmqlWord",
              in: "$$jsmqlWord.match",
            },
          },
          initialValue: "",
          in: { $cond: [{ $eq: ["$$value", ""] }, "$$this", { $concat: ["$$value", " ", "$$this"] }] },
        },
      },
    });
    expect(compiled("$.w.upperCase()", () => "FOO BAR BAZ QUX")).toEqual({
      $toUpper: {
        $reduce: {
          input: {
            $map: {
              input: { $regexFindAll: { input: "$w", regex: "[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[A-Z]|[0-9]+" } },
              as: "jsmqlWord",
              in: "$$jsmqlWord.match",
            },
          },
          initialValue: "",
          in: { $cond: [{ $eq: ["$$value", ""] }, "$$this", { $concat: ["$$value", " ", "$$this"] }] },
        },
      },
    });
    expect(compiled("$.dashed.upperCase()", () => "FOO BAR")).toEqual({
      $toUpper: {
        $reduce: {
          input: {
            $map: {
              input: { $regexFindAll: { input: "$dashed", regex: "[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[A-Z]|[0-9]+" } },
              as: "jsmqlWord",
              in: "$$jsmqlWord.match",
            },
          },
          initialValue: "",
          in: { $cond: [{ $eq: ["$$value", ""] }, "$$this", { $concat: ["$$value", " ", "$$this"] }] },
        },
      },
    });
    expect(compiled("$.under.upperCase()", () => "FOO BAR")).toEqual({
      $toUpper: {
        $reduce: {
          input: {
            $map: {
              input: { $regexFindAll: { input: "$under", regex: "[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[A-Z]|[0-9]+" } },
              as: "jsmqlWord",
              in: "$$jsmqlWord.match",
            },
          },
          initialValue: "",
          in: { $cond: [{ $eq: ["$$value", ""] }, "$$this", { $concat: ["$$value", " ", "$$this"] }] },
        },
      },
    });
    // a missing field: the dot form answers "" as lodash does, and `?.` answers null
    expect(compiled("$.nope.lowerCase()", () => "")).toHaveProperty("$toLower");
    expect(compiled("$.nope?.upperCase()", () => null)).toEqual(nullOr("$nope", expr("$.nope.upperCase()")));
    expect(compiled("$.w.snakeCase()", () => "foo_bar_baz_qux")).toEqual({
      $toLower: {
        $reduce: {
          input: {
            $map: {
              input: { $regexFindAll: { input: "$w", regex: "[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[A-Z]|[0-9]+" } },
              as: "jsmqlWord",
              in: "$$jsmqlWord.match",
            },
          },
          initialValue: "",
          in: { $cond: [{ $eq: ["$$value", ""] }, "$$this", { $concat: ["$$value", "_", "$$this"] }] },
        },
      },
    });
    expect(compiled("$.w.startCase()", () => "Foo Bar Baz Qux")).toEqual({
      $reduce: {
        input: {
          $map: {
            input: {
              $map: {
                input: { $regexFindAll: { input: "$w", regex: "[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[A-Z]|[0-9]+" } },
                as: "jsmqlWord",
                in: "$$jsmqlWord.match",
              },
            },
            as: "jsmqlW",
            in: {
              $concat: [
                { $toUpper: { $substrCP: ["$$jsmqlW", 0, 1] } },
                { $toLower: { $substrCP: ["$$jsmqlW", 1, { $strLenCP: { $ifNull: ["$$jsmqlW", ""] } }] } },
              ],
            },
          },
        },
        initialValue: "",
        in: { $cond: [{ $eq: ["$$value", ""] }, "$$this", { $concat: ["$$value", " ", "$$this"] }] },
      },
    });
    expect(compiled("$.w.camelCase()", () => "fooBarBazQux")).toEqual({
      $let: {
        vars: {
          jsmqlPascal: {
            $reduce: {
              input: {
                $map: {
                  input: {
                    $map: {
                      input: { $regexFindAll: { input: "$w", regex: "[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[A-Z]|[0-9]+" } },
                      as: "jsmqlWord",
                      in: "$$jsmqlWord.match",
                    },
                  },
                  as: "jsmqlW",
                  in: {
                    $concat: [
                      { $toUpper: { $substrCP: ["$$jsmqlW", 0, 1] } },
                      { $toLower: { $substrCP: ["$$jsmqlW", 1, { $strLenCP: { $ifNull: ["$$jsmqlW", ""] } }] } },
                    ],
                  },
                },
              },
              initialValue: "",
              in: { $cond: [{ $eq: ["$$value", ""] }, "$$this", { $concat: ["$$value", "", "$$this"] }] },
            },
          },
        },
        in: {
          $concat: [
            { $toLower: { $substrCP: ["$$jsmqlPascal", 0, 1] } },
            { $substrCP: ["$$jsmqlPascal", 1, { $strLenCP: { $ifNull: ["$$jsmqlPascal", ""] } }] },
          ],
        },
      },
    });
    expect(compiled("$.h.escape()", () => "&lt;a &amp; b&gt;")).toEqual({
      $replaceAll: {
        input: {
          $replaceAll: {
            input: {
              $replaceAll: {
                input: {
                  $replaceAll: {
                    input: { $replaceAll: { input: "$h", find: "&", replacement: "&amp;" } },
                    find: "<",
                    replacement: "&lt;",
                  },
                },
                find: ">",
                replacement: "&gt;",
              },
            },
            find: '"',
            replacement: "&quot;",
          },
        },
        find: "'",
        replacement: "&#39;",
      },
    });
    expect(compiled("$.n.inRange(2, 10)", (d) => d.n >= 2 && d.n < 10)).toEqual({
      $and: [{ $gte: ["$n", { $min: [2, 10] }] }, { $lt: ["$n", { $max: [2, 10] }] }],
    });
  });

  it("refuses what JavaScript refuses, and names the type the method takes", () => {
    expect(() => expr("$.s.matchAll(/a/)")).toThrow(/needs the 'g' flag/);
    expect(() => expr('$.s.truncate({ separator: " " })')).toThrow(/has no parameter 'separator'/);
    expect(() => expr("$.n.abs().trim()")).toThrow(/not available on a 'number'.*toString/);
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
    ).toEqual({
      $let: {
        vars: { jsmqlParts: { $dateToParts: { date: "$d" } } },
        in: {
          $dateFromParts: {
            year: "$$jsmqlParts.year",
            month: "$$jsmqlParts.month",
            day: "$$jsmqlParts.day",
            hour: 0,
            minute: 0,
            second: 0,
            millisecond: 0,
          },
        },
      },
    });
  });

  it("refuses a unit, a format or a part the server refuses", () => {
    expect(() => expr('$.d.plus(1, "fortnight")')).toThrow(/must be one of/);
    expect(() => expr('$.d.plus(1.5, "day")')).toThrow(/takes an integer, but got a fraction/);
    expect(() => expr("$.d.isAfter($.e)")).toThrow(/without a unit is just '>'/);
    expect(() => expr('$.d.format("YYYY-MM-DD")')).toThrow(/Moment or Luxon/);
    expect(() => expr('$.d.format("%Q")')).toThrow(/invalid specifier '%Q'/);
    expect(() => expr("$.d.set({ year: 2020, isoWeek: 2 })")).toThrow(/two families that never mix/);
    expect(() => expr("$.d.set({ foo: 1 })")).toThrow(/has no parameter 'foo'/);
    expect(() => expr('$.d.startOf("day", { bogus: 1 })')).toThrow(/has no parameter 'bogus'/);
  });
});

describe("compiler/emit — object methods", () => {
  it("reads a .pickBy / .omitBy predicate with the JavaScript truth rules", () => {
    // `""` and `[]` split the two languages: `""` is false in JavaScript and true to a
    // raw MongoDB condition. The server answer must be JavaScript's for both methods.
    const truth = {
      $and: [{ $gt: ["$$v", null] }, { $ne: ["$$v", false] }, { $ne: ["$$v", ""] }, { $ne: ["$$v", 0] }],
    };
    const pairs = { $objectToArray: { $ifNull: ["$mo", {}] } };
    expect(
      compiled("$.mo.pickBy(v => v)", (d) => Object.fromEntries(Object.entries(d.mo).filter(([, v]) => v))),
    ).toEqual({
      $arrayToObject: {
        $filter: { input: pairs, as: "jsmqlKv", cond: { $let: { vars: { v: "$$jsmqlKv.v" }, in: truth } } },
      },
    });
    expect(
      compiled("$.mo.omitBy(v => v)", (d) => Object.fromEntries(Object.entries(d.mo).filter(([, v]) => !v))),
    ).toEqual({
      $arrayToObject: {
        $filter: { input: pairs, as: "jsmqlKv", cond: { $not: [{ $let: { vars: { v: "$$jsmqlKv.v" }, in: truth } }] } },
      },
    });
    // A predicate that answers a boolean needs no test.
    expect(
      compiled("$.mo.pickBy(v => v === 0)", (d) => Object.fromEntries(Object.entries(d.mo).filter(([, v]) => v === 0))),
    ).toEqual({
      $arrayToObject: {
        $filter: {
          input: pairs,
          as: "jsmqlKv",
          cond: { $let: { vars: { v: "$$jsmqlKv.v" }, in: { $eq: ["$$v", 0] } } },
        },
      },
    });
  });

  it("maps, filters and reshapes a document's pairs", () => {
    expect(compiled("$.o.mapValues(v => v * 2)", (d) => ({ a: 2, b: 4, _c: 6 }))).toEqual({
      $arrayToObject: {
        $map: {
          input: { $objectToArray: { $ifNull: ["$o", {}] } },
          as: "jsmqlKv",
          in: { k: "$$jsmqlKv.k", v: { $let: { vars: { v: "$$jsmqlKv.v" }, in: { $multiply: ["$$v", 2] } } } },
        },
      },
    });
    expect(compiled("$.o.mapKeys((v, k) => k.toUpperCase())", () => ({ A: 1, B: 2, _C: 3 }))).toEqual({
      $arrayToObject: {
        $map: {
          input: { $objectToArray: { $ifNull: ["$o", {}] } },
          as: "jsmqlKv",
          in: {
            k: {
              $toString: {
                $let: {
                  vars: { v: "$$jsmqlKv.v", k: "$$jsmqlKv.k" },
                  in: { $cond: [{ $lte: ["$$k", null] }, null, { $toUpper: "$$k" }] },
                },
              },
            },
            v: "$$jsmqlKv.v",
          },
        },
      },
    });
    expect(compiled("$.o.pickBy(v => v > 1)", () => ({ b: 2, _c: 3 }))).toEqual({
      $arrayToObject: {
        $filter: {
          input: { $objectToArray: { $ifNull: ["$o", {}] } },
          as: "jsmqlKv",
          cond: { $let: { vars: { v: "$$jsmqlKv.v" }, in: { $gt: ["$$v", 1] } } },
        },
      },
    });
    expect(compiled('$.o.omitBy((v, k) => k.startsWith("_"))', () => ({ a: 1, b: 2 }))).toEqual({
      $arrayToObject: {
        $filter: {
          input: { $objectToArray: { $ifNull: ["$o", {}] } },
          as: "jsmqlKv",
          cond: {
            $not: [
              {
                $let: {
                  vars: { v: "$$jsmqlKv.v", k: "$$jsmqlKv.k" },
                  in: { $cond: [{ $lte: ["$$k", null] }, null, { $eq: [{ $indexOfCP: ["$$k", "_"] }, 0] }] },
                },
              },
            ],
          },
        },
      },
    });
    expect(compiled("$.o.invert()", () => ({ "1": "a", "2": "b", "3": "_c" }))).toEqual({
      $arrayToObject: {
        $map: {
          input: { $objectToArray: { $ifNull: ["$o", {}] } },
          as: "jsmqlKv",
          in: { k: { $toString: "$$jsmqlKv.v" }, v: "$$jsmqlKv.k" },
        },
      },
    });
    expect(
      compiled("$.o.toPairs()", () => [
        ["a", 1],
        ["b", 2],
        ["_c", 3],
      ]),
    ).toEqual({ $map: { input: { $objectToArray: { $ifNull: ["$o", {}] } }, in: ["$$this.k", "$$this.v"] } });
    expect(compiled('$.o.pick(["a", "b"])', () => ({ a: 1, b: 2 }))).toEqual({
      $let: {
        vars: { jsmqlObj: { $ifNull: ["$o", {}] } },
        in: {
          a: { $getField: { field: "a", input: "$$jsmqlObj" } },
          b: { $getField: { field: "b", input: "$$jsmqlObj" } },
        },
      },
    });
    expect(compiled('$.o.omit(["_c"])', () => ({ a: 1, b: 2 }))).toEqual({
      $arrayToObject: {
        $filter: {
          input: { $objectToArray: { $ifNull: ["$o", {}] } },
          as: "jsmqlKv",
          cond: { $not: [{ $in: ["$$jsmqlKv.k", ["_c"]] }] },
        },
      },
    });
    // A key list the source does not SPELL — a field path, or an element read at run
    // time — is one only the server knows, so both read the object's own keys instead.
    expect(
      compiled("$.o.pick($.keys)", (d) => Object.fromEntries(Object.entries(d.o).filter(([k]) => d.keys.includes(k)))),
    ).toEqual({
      $arrayToObject: {
        $filter: {
          input: { $objectToArray: { $ifNull: ["$o", {}] } },
          as: "jsmqlKv",
          cond: { $in: ["$$jsmqlKv.k", { $ifNull: ["$keys", []] }] },
        },
      },
    });
    expect(
      compiled("$.o.omit($.keys)", (d) => Object.fromEntries(Object.entries(d.o).filter(([k]) => !d.keys.includes(k)))),
    ).toEqual({
      $arrayToObject: {
        $filter: {
          input: { $objectToArray: { $ifNull: ["$o", {}] } },
          as: "jsmqlKv",
          cond: { $not: [{ $in: ["$$jsmqlKv.k", { $ifNull: ["$keys", []] }] }] },
        },
      },
    });
    expect(
      compiled('$.o.pick([$.kname, "b"])', (d) =>
        Object.fromEntries(Object.entries(d.o).filter(([k]) => [d.kname, "b"].includes(k))),
      ),
    ).toEqual({
      $arrayToObject: {
        $filter: {
          input: { $objectToArray: { $ifNull: ["$o", {}] } },
          as: "jsmqlKv",
          cond: { $in: ["$$jsmqlKv.k", ["$kname", "b"]] },
        },
      },
    });
    // A missing key list picks nothing and omits nothing, as lodash does — `$in` would
    // otherwise ABORT the command on a second operand that is not an array.
    expect(compiled("$.o.pick($.nope)", () => ({}))).toEqual({
      $arrayToObject: {
        $filter: {
          input: { $objectToArray: { $ifNull: ["$o", {}] } },
          as: "jsmqlKv",
          cond: { $in: ["$$jsmqlKv.k", { $ifNull: ["$nope", []] }] },
        },
      },
    });
    expect(() => expr('$.o.pick(["$a"])')).toThrow(/starts with '\$'/);
  });

  it("takes the document itself as the receiver — bare `$` is `$$ROOT`", () => {
    expect(compiled('$.pick(["s", "n"])', (d) => ({ s: d.s, n: d.n }))).toEqual({
      $let: {
        vars: { jsmqlObj: "$$ROOT" },
        in: {
          s: { $getField: { field: "s", input: "$$jsmqlObj" } },
          n: { $getField: { field: "n", input: "$$jsmqlObj" } },
        },
      },
    });
    const others = Object.keys(DOC).filter((k) => k !== "s" && k !== "w");
    expect(compiled(`$.omit(${JSON.stringify(others)})`, (d) => ({ s: d.s, w: d.w }))).toEqual({
      $arrayToObject: {
        $filter: {
          input: { $objectToArray: "$$ROOT" },
          as: "jsmqlKv",
          cond: {
            $not: [
              {
                $in: [
                  "$$jsmqlKv.k",
                  [
                    "_id",
                    "csv",
                    "n",
                    "neg",
                    "d",
                    "e",
                    "o",
                    "keys",
                    "kname",
                    "h",
                    "dashed",
                    "under",
                    "a",
                    "b",
                    "dup",
                    "docs",
                    "nested",
                    "pairs",
                    "mixed",
                    "mo",
                  ],
                ],
              },
            ],
          },
        },
      },
    });
    expect(compiled('$.pick(["o"]).o.mapValues(v => v * 2)', () => ({ a: 2, b: 4, _c: 6 }))).toEqual({
      $arrayToObject: {
        $map: {
          input: {
            $objectToArray: {
              $ifNull: [
                {
                  $let: {
                    vars: {
                      jsmqlV: {
                        $let: {
                          vars: { jsmqlObj: "$$ROOT" },
                          in: { o: { $getField: { field: "o", input: "$$jsmqlObj" } } },
                        },
                      },
                    },
                    in: "$$jsmqlV.o",
                  },
                },
                {},
              ],
            },
          },
          as: "jsmqlKv",
          in: { k: "$$jsmqlKv.k", v: { $let: { vars: { v: "$$jsmqlKv.v" }, in: { $multiply: ["$$v", 2] } } } },
        },
      },
    });
    // A method of another family is refused as it is on any document.
    expect(() => expr("$.trim()")).toThrow(/'\.trim\(\)' is not available on an 'object' — it is defined on 'string'/);
    expect(() => expr("$.map(x => x)")).toThrow(/A document is not a list/);
    expect(() => expr("$.o.mapValues(5)")).toThrow(/one- or two-parameter arrow/);
  });
});

describe("compiler/emit — array methods", () => {
  it("iterates with a callback, with or without its index", () => {
    expect(compiled("$.a.map(x => x * 2)", (d) => d.a.map((x) => x * 2))).toEqual({
      $map: { input: { $ifNull: ["$a", []] }, as: "x", in: { $multiply: ["$$x", 2] } },
    });
    // an index READ makes the input the `[i, x]` pairs
    expect(compiled("$.a.map((x, i) => x + i)", (d) => d.a.map((x, i) => x + i))).toEqual({
      $map: {
        input: { $zip: { inputs: [{ $range: [0, { $size: { $ifNull: ["$a", []] } }] }, { $ifNull: ["$a", []] }] } },
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
      $filter: { input: { $ifNull: ["$a", []] }, as: "x", cond: { $gt: ["$$x", 1] } },
    });
    expect(compiled("$.a.filter((x, i) => i > 0)", (d) => d.a.filter((_x, i) => i > 0))).toEqual({
      $map: {
        input: {
          $filter: {
            input: { $zip: { inputs: [{ $range: [0, { $size: { $ifNull: ["$a", []] } }] }, { $ifNull: ["$a", []] }] } },
            as: "jsmqlPair",
            cond: {
              $let: {
                vars: { x: { $arrayElemAt: ["$$jsmqlPair", 1] }, i: { $arrayElemAt: ["$$jsmqlPair", 0] } },
                in: { $gt: ["$$i", 0] },
              },
            },
          },
        },
        as: "jsmqlPair",
        in: { $arrayElemAt: ["$$jsmqlPair", 1] },
      },
    });
    expect(compiled("$.a.find(x => x > 1)", (d) => d.a.find((x) => x > 1))).toEqual({
      $arrayElemAt: [{ $filter: { input: { $ifNull: ["$a", []] }, as: "x", cond: { $gt: ["$$x", 1] } } }, 0],
    });
    expect(compiled("$.a.findLast(x => x > 1)", (d) => d.a.findLast((x) => x > 1))).toEqual({
      $arrayElemAt: [{ $filter: { input: { $ifNull: ["$a", []] }, as: "x", cond: { $gt: ["$$x", 1] } } }, -1],
    });
    expect(compiled("$.a.some(x => x > 2)", (d) => d.a.some((x) => x > 2))).toEqual({
      $anyElementTrue: { $map: { input: { $ifNull: ["$a", []] }, as: "x", in: { $gt: ["$$x", 2] } } },
    });
    expect(compiled("$.a.every(x => x > 0)", (d) => d.a.every((x) => x > 0))).toEqual({
      $allElementsTrue: { $map: { input: { $ifNull: ["$a", []] }, as: "x", in: { $gt: ["$$x", 0] } } },
    });
    expect(compiled("$.nested.flatMap(x => x)", (d) => d.nested.flatMap((x) => x))).toEqual({
      $reduce: {
        input: { $map: { input: { $ifNull: ["$nested", []] }, as: "x", in: "$$x" } },
        initialValue: [],
        in: { $concatArrays: ["$$value", "$$this"] },
      },
    });
    expect(compiled("$.docs.map((x, i, arr) => arr.size())", (d) => d.docs.map((_x, _i, arr) => arr.length))).toEqual({
      $map: {
        input: { $ifNull: ["$docs", []] },
        as: "x",
        in: { $let: { vars: { arr: { $ifNull: ["$docs", []] } }, in: { $size: "$$arr" } } },
      },
    });
  });

  it("slices and reshapes", () => {
    expect(compiled("$.a.take(2)", (d) => d.a.slice(0, 2))).toEqual({ $slice: [{ $ifNull: ["$a", []] }, 2] });
    expect(compiled("$.a.takeRight(2)", (d) => d.a.slice(-2))).toEqual({ $slice: [{ $ifNull: ["$a", []] }, -2] });
    expect(compiled("$.a.drop(1)", (d) => d.a.slice(1))).toEqual({
      $let: {
        vars: { jsmqlArr: { $ifNull: ["$a", []] } },
        in: { $slice: ["$$jsmqlArr", 1, { $max: [1, { $size: "$$jsmqlArr" }] }] },
      },
    });
    expect(compiled("$.a.dropRight(1)", (d) => d.a.slice(0, -1))).toEqual({
      $let: {
        vars: { jsmqlArr: { $ifNull: ["$a", []] } },
        in: { $slice: ["$$jsmqlArr", { $max: [0, { $subtract: [{ $size: "$$jsmqlArr" }, 1] }] }] },
      },
    });
    expect(compiled("$.a.tail()", (d) => d.a.slice(1))).toEqual({
      $let: {
        vars: { jsmqlArr: { $ifNull: ["$a", []] } },
        in: { $slice: ["$$jsmqlArr", 1, { $max: [1, { $size: "$$jsmqlArr" }] }] },
      },
    });
    expect(compiled("$.a.initial()", (d) => d.a.slice(0, -1))).toEqual({
      $let: {
        vars: { jsmqlArr: { $ifNull: ["$a", []] } },
        in: { $slice: ["$$jsmqlArr", { $max: [0, { $subtract: [{ $size: "$$jsmqlArr" }, 1] }] }] },
      },
    });
    expect(compiled("$.a.head()", (d) => d.a[0])).toEqual({ $first: { $ifNull: ["$a", []] } });
    expect(compiled("$.a.last()", (d) => d.a[2])).toEqual({ $last: { $ifNull: ["$a", []] } });
    expect(compiled("$.a.chunk(2)", () => [[3, 1], [2]])).toEqual({
      $map: {
        input: { $range: [0, { $size: { $ifNull: ["$a", []] } }, 2] },
        as: "jsmqlI",
        in: { $slice: [{ $ifNull: ["$a", []] }, "$$jsmqlI", 2] },
      },
    });
    expect(compiled("$.nested.flat()", (d) => d.nested.flat())).toEqual({
      $reduce: { input: { $ifNull: ["$nested", []] }, initialValue: [], in: { $concatArrays: ["$$value", "$$this"] } },
    });
    expect(
      compiled("$.a.zip($.b)", () => [
        [3, 2],
        [1, 5],
        [2, null],
      ]),
    ).toEqual({ $zip: { inputs: [{ $ifNull: ["$a", []] }, "$b"], useLongestLength: true } });
    expect(
      compiled("$.nested.unzip()", () => [
        [1, 3],
        [2, null],
      ]),
    ).toEqual({
      $let: {
        vars: { jsmqlT: { $ifNull: ["$nested", []] } },
        in: {
          $map: {
            input: { $range: [0, { $size: { $ifNull: [{ $arrayElemAt: ["$$jsmqlT", 0] }, []] } }] },
            as: "jsmqlJ",
            in: { $map: { input: "$$jsmqlT", as: "jsmqlRow", in: { $arrayElemAt: ["$$jsmqlRow", "$$jsmqlJ"] } } },
          },
        },
      },
    });
    expect(compiled('["k1", "k2"].zipObject($.b)', () => ({ k1: 2, k2: 5 }))).toEqual({
      $arrayToObject: {
        $map: {
          input: { $range: [0, 2] },
          as: "jsmqlI",
          in: {
            k: { $toString: { $arrayElemAt: [["k1", "k2"], "$$jsmqlI"] } },
            v: { $arrayElemAt: ["$b", "$$jsmqlI"] },
          },
        },
      },
    });
    expect(compiled("$.pairs.fromPairs()", () => ({ k: 1 }))).toEqual({
      $arrayToObject: {
        $map: {
          input: { $ifNull: ["$pairs", []] },
          in: [{ $toString: { $first: "$$this" } }, { $arrayElemAt: ["$$this", 1] }],
        },
      },
    });
    expect(compiled("$.a.toReversed()", (d) => d.a.toReversed())).toEqual({ $reverseArray: { $ifNull: ["$a", []] } });
    expect(compiled("$.a.toSorted()", (d) => d.a.toSorted())).toEqual({
      $sortArray: { input: { $ifNull: ["$a", []] }, sortBy: 1 },
    });
    // `(a, b) => a - b` names no field, so the elements themselves are the key
    expect(compiled("$.a.toSorted((a, b) => a - b)", (d) => d.a.toSorted((a, b) => a - b))).toEqual({
      $sortArray: { input: { $ifNull: ["$a", []] }, sortBy: 1 },
    });
    expect(compiled("$.a.toSorted((a, b) => b - a)", (d) => d.a.toSorted((a, b) => b - a))).toEqual({
      $sortArray: { input: { $ifNull: ["$a", []] }, sortBy: -1 },
    });
    expect(compiled("$.a.sortBy((a, b) => a - b)", (d) => d.a.toSorted((a, b) => a - b))).toEqual({
      $sortArray: { input: { $ifNull: ["$a", []] }, sortBy: 1 },
    });
    expect(compiled("$.a.orderBy((a, b) => a - b, -1)", (d) => d.a.toSorted((a, b) => b - a))).toEqual({
      $sortArray: { input: { $ifNull: ["$a", []] }, sortBy: -1 },
    });
    expect(compiled("$.docs.toSorted({ v: -1 })", (d) => d.docs.toSorted((p, q) => q.v - p.v))).toEqual({
      $sortArray: { input: { $ifNull: ["$docs", []] }, sortBy: { v: -1 } },
    });
    expect(compiled("$.docs.sortBy(x => x.v)", (d) => d.docs.toSorted((p, q) => p.v - q.v))).toEqual({
      $sortArray: { input: { $ifNull: ["$docs", []] }, sortBy: { v: 1 } },
    });
    // a computed key sorts `{ k, v }` pairs and takes the values back
    expect(
      compiled("$.docs.sortBy(x => x.v % 2)", () => [
        { k: "x", v: 2 },
        { k: "y", v: 1 },
        { k: "x", v: 3 },
      ]),
    ).toEqual({
      $map: {
        input: {
          $sortArray: {
            input: {
              $map: { input: { $ifNull: ["$docs", []] }, as: "x", in: { k: { $mod: ["$$x.v", 2] }, v: "$$x" } },
            },
            sortBy: { k: 1 },
          },
        },
        as: "jsmqlP",
        in: "$$jsmqlP.v",
      },
    });
    expect(compiled('$.docs.orderBy(["v"], [-1])', (d) => d.docs.toSorted((p, q) => q.v - p.v))).toEqual({
      $sortArray: { input: { $ifNull: ["$docs", []] }, sortBy: { v: -1 } },
    });
    expect(compiled("$.a.toSpliced(1, 1, 9)", (d) => d.a.toSpliced(1, 1, 9))).toEqual({
      $let: {
        vars: { jsmqlArr: { $ifNull: ["$a", []] } },
        in: {
          $let: {
            vars: { jsmqlStart: { $min: [1, { $size: "$$jsmqlArr" }] } },
            in: {
              $let: {
                vars: { jsmqlTailStart: { $add: ["$$jsmqlStart", 1] } },
                in: {
                  $concatArrays: [
                    { $slice: ["$$jsmqlArr", "$$jsmqlStart"] },
                    [9],
                    {
                      $cond: [
                        { $gt: [{ $subtract: [{ $size: "$$jsmqlArr" }, "$$jsmqlTailStart"] }, 0] },
                        {
                          $slice: [
                            "$$jsmqlArr",
                            "$$jsmqlTailStart",
                            { $subtract: [{ $size: "$$jsmqlArr" }, "$$jsmqlTailStart"] },
                          ],
                        },
                        [],
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
      },
    });
    expect(compiled("$.a.with(0, 9)", (d) => d.a.with(0, 9))).toEqual({
      $let: {
        vars: { jsmqlArr: { $ifNull: ["$a", []] }, jsmqlIdx: 0, jsmqlVal: 9 },
        in: {
          $concatArrays: [
            { $slice: ["$$jsmqlArr", "$$jsmqlIdx"] },
            ["$$jsmqlVal"],
            {
              $cond: [
                { $gt: [{ $subtract: [{ $size: "$$jsmqlArr" }, { $add: ["$$jsmqlIdx", 1] }] }, 0] },
                {
                  $slice: [
                    "$$jsmqlArr",
                    { $add: ["$$jsmqlIdx", 1] },
                    { $subtract: [{ $size: "$$jsmqlArr" }, { $add: ["$$jsmqlIdx", 1] }] },
                  ],
                },
                [],
              ],
            },
          ],
        },
      },
    });
    // measured: a three-argument `$slice` refuses a count of 0, which the first and last index reach
    expect(compiled("$.a.with(2, 9)", (d) => d.a.with(2, 9))).toEqual({
      $let: {
        vars: { jsmqlArr: { $ifNull: ["$a", []] }, jsmqlIdx: 2, jsmqlVal: 9 },
        in: {
          $concatArrays: [
            { $slice: ["$$jsmqlArr", "$$jsmqlIdx"] },
            ["$$jsmqlVal"],
            {
              $cond: [
                { $gt: [{ $subtract: [{ $size: "$$jsmqlArr" }, { $add: ["$$jsmqlIdx", 1] }] }, 0] },
                {
                  $slice: [
                    "$$jsmqlArr",
                    { $add: ["$$jsmqlIdx", 1] },
                    { $subtract: [{ $size: "$$jsmqlArr" }, { $add: ["$$jsmqlIdx", 1] }] },
                  ],
                },
                [],
              ],
            },
          ],
        },
      },
    });
    expect(compiled("$.a.toSpliced(3, 0, 4)", (d) => d.a.toSpliced(3, 0, 4))).toEqual({
      $let: {
        vars: { jsmqlArr: { $ifNull: ["$a", []] } },
        in: {
          $let: {
            vars: { jsmqlStart: { $min: [3, { $size: "$$jsmqlArr" }] } },
            in: {
              $let: {
                vars: { jsmqlTailStart: { $add: ["$$jsmqlStart", 0] } },
                in: {
                  $concatArrays: [
                    { $slice: ["$$jsmqlArr", "$$jsmqlStart"] },
                    [4],
                    {
                      $cond: [
                        { $gt: [{ $subtract: [{ $size: "$$jsmqlArr" }, "$$jsmqlTailStart"] }, 0] },
                        {
                          $slice: [
                            "$$jsmqlArr",
                            "$$jsmqlTailStart",
                            { $subtract: [{ $size: "$$jsmqlArr" }, "$$jsmqlTailStart"] },
                          ],
                        },
                        [],
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
      },
    });
    expect(compiled("$.a.toSpliced(0, 3)", (d) => d.a.toSpliced(0, 3))).toEqual({
      $let: {
        vars: { jsmqlArr: { $ifNull: ["$a", []] } },
        in: {
          $let: {
            vars: { jsmqlStart: 0 },
            in: {
              $let: {
                vars: { jsmqlTailStart: { $add: ["$$jsmqlStart", 3] } },
                in: {
                  $concatArrays: [
                    { $slice: ["$$jsmqlArr", "$$jsmqlStart"] },
                    [],
                    {
                      $cond: [
                        { $gt: [{ $subtract: [{ $size: "$$jsmqlArr" }, "$$jsmqlTailStart"] }, 0] },
                        {
                          $slice: [
                            "$$jsmqlArr",
                            "$$jsmqlTailStart",
                            { $subtract: [{ $size: "$$jsmqlArr" }, "$$jsmqlTailStart"] },
                          ],
                        },
                        [],
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
      },
    });
    // a start counted from the end, and the two ends JavaScript clamps
    expect(compiled("$.a.toSpliced(-1, 1)", (d) => d.a.toSpliced(-1, 1))).toEqual({
      $let: {
        vars: { jsmqlArr: { $ifNull: ["$a", []] } },
        in: {
          $let: {
            vars: { jsmqlStart: { $max: [{ $subtract: [{ $size: "$$jsmqlArr" }, 1] }, 0] } },
            in: {
              $let: {
                vars: { jsmqlTailStart: { $add: ["$$jsmqlStart", 1] } },
                in: {
                  $concatArrays: [
                    { $slice: ["$$jsmqlArr", "$$jsmqlStart"] },
                    [],
                    {
                      $cond: [
                        { $gt: [{ $subtract: [{ $size: "$$jsmqlArr" }, "$$jsmqlTailStart"] }, 0] },
                        {
                          $slice: [
                            "$$jsmqlArr",
                            "$$jsmqlTailStart",
                            { $subtract: [{ $size: "$$jsmqlArr" }, "$$jsmqlTailStart"] },
                          ],
                        },
                        [],
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
      },
    });
    expect(compiled("$.a.toSpliced(-2, 1, 9)", (d) => d.a.toSpliced(-2, 1, 9))).toEqual({
      $let: {
        vars: { jsmqlArr: { $ifNull: ["$a", []] } },
        in: {
          $let: {
            vars: { jsmqlStart: { $max: [{ $subtract: [{ $size: "$$jsmqlArr" }, 2] }, 0] } },
            in: {
              $let: {
                vars: { jsmqlTailStart: { $add: ["$$jsmqlStart", 1] } },
                in: {
                  $concatArrays: [
                    { $slice: ["$$jsmqlArr", "$$jsmqlStart"] },
                    [9],
                    {
                      $cond: [
                        { $gt: [{ $subtract: [{ $size: "$$jsmqlArr" }, "$$jsmqlTailStart"] }, 0] },
                        {
                          $slice: [
                            "$$jsmqlArr",
                            "$$jsmqlTailStart",
                            { $subtract: [{ $size: "$$jsmqlArr" }, "$$jsmqlTailStart"] },
                          ],
                        },
                        [],
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
      },
    });
    expect(compiled("$.a.toSpliced(-10, 1)", (d) => d.a.toSpliced(-10, 1))).toEqual({
      $let: {
        vars: { jsmqlArr: { $ifNull: ["$a", []] } },
        in: {
          $let: {
            vars: { jsmqlStart: { $max: [{ $subtract: [{ $size: "$$jsmqlArr" }, 10] }, 0] } },
            in: {
              $let: {
                vars: { jsmqlTailStart: { $add: ["$$jsmqlStart", 1] } },
                in: {
                  $concatArrays: [
                    { $slice: ["$$jsmqlArr", "$$jsmqlStart"] },
                    [],
                    {
                      $cond: [
                        { $gt: [{ $subtract: [{ $size: "$$jsmqlArr" }, "$$jsmqlTailStart"] }, 0] },
                        {
                          $slice: [
                            "$$jsmqlArr",
                            "$$jsmqlTailStart",
                            { $subtract: [{ $size: "$$jsmqlArr" }, "$$jsmqlTailStart"] },
                          ],
                        },
                        [],
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
      },
    });
    expect(compiled("$.a.toSpliced(-1, 0)", (d) => d.a.toSpliced(-1, 0))).toEqual({
      $let: {
        vars: { jsmqlArr: { $ifNull: ["$a", []] } },
        in: {
          $let: {
            vars: { jsmqlStart: { $max: [{ $subtract: [{ $size: "$$jsmqlArr" }, 1] }, 0] } },
            in: {
              $let: {
                vars: { jsmqlTailStart: { $add: ["$$jsmqlStart", 0] } },
                in: {
                  $concatArrays: [
                    { $slice: ["$$jsmqlArr", "$$jsmqlStart"] },
                    [],
                    {
                      $cond: [
                        { $gt: [{ $subtract: [{ $size: "$$jsmqlArr" }, "$$jsmqlTailStart"] }, 0] },
                        {
                          $slice: [
                            "$$jsmqlArr",
                            "$$jsmqlTailStart",
                            { $subtract: [{ $size: "$$jsmqlArr" }, "$$jsmqlTailStart"] },
                          ],
                        },
                        [],
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
      },
    });
    expect(compiled("$.a.toSpliced(10, 1)", (d) => d.a.toSpliced(10, 1))).toEqual({
      $let: {
        vars: { jsmqlArr: { $ifNull: ["$a", []] } },
        in: {
          $let: {
            vars: { jsmqlStart: { $min: [10, { $size: "$$jsmqlArr" }] } },
            in: {
              $let: {
                vars: { jsmqlTailStart: { $add: ["$$jsmqlStart", 1] } },
                in: {
                  $concatArrays: [
                    { $slice: ["$$jsmqlArr", "$$jsmqlStart"] },
                    [],
                    {
                      $cond: [
                        { $gt: [{ $subtract: [{ $size: "$$jsmqlArr" }, "$$jsmqlTailStart"] }, 0] },
                        {
                          $slice: [
                            "$$jsmqlArr",
                            "$$jsmqlTailStart",
                            { $subtract: [{ $size: "$$jsmqlArr" }, "$$jsmqlTailStart"] },
                          ],
                        },
                        [],
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
      },
    });
    // the count left out removes everything from the start on
    expect(compiled("$.a.toSpliced(2)", (d) => d.a.toSpliced(2))).toEqual({
      $let: {
        vars: { jsmqlArr: { $ifNull: ["$a", []] } },
        in: {
          $let: {
            vars: { jsmqlStart: { $min: [2, { $size: "$$jsmqlArr" }] } },
            in: {
              $let: {
                vars: { jsmqlTailStart: { $size: "$$jsmqlArr" } },
                in: {
                  $concatArrays: [
                    { $slice: ["$$jsmqlArr", "$$jsmqlStart"] },
                    [],
                    {
                      $cond: [
                        { $gt: [{ $subtract: [{ $size: "$$jsmqlArr" }, "$$jsmqlTailStart"] }, 0] },
                        {
                          $slice: [
                            "$$jsmqlArr",
                            "$$jsmqlTailStart",
                            { $subtract: [{ $size: "$$jsmqlArr" }, "$$jsmqlTailStart"] },
                          ],
                        },
                        [],
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
      },
    });
    expect(compiled("$.a.toSpliced(0)", (d) => d.a.toSpliced(0))).toEqual({
      $let: {
        vars: { jsmqlArr: { $ifNull: ["$a", []] } },
        in: {
          $let: {
            vars: { jsmqlStart: 0 },
            in: {
              $let: {
                vars: { jsmqlTailStart: { $size: "$$jsmqlArr" } },
                in: {
                  $concatArrays: [
                    { $slice: ["$$jsmqlArr", "$$jsmqlStart"] },
                    [],
                    {
                      $cond: [
                        { $gt: [{ $subtract: [{ $size: "$$jsmqlArr" }, "$$jsmqlTailStart"] }, 0] },
                        {
                          $slice: [
                            "$$jsmqlArr",
                            "$$jsmqlTailStart",
                            { $subtract: [{ $size: "$$jsmqlArr" }, "$$jsmqlTailStart"] },
                          ],
                        },
                        [],
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
      },
    });
    expect(compiled("$.a.toSpliced(-1)", (d) => d.a.toSpliced(-1))).toEqual({
      $let: {
        vars: { jsmqlArr: { $ifNull: ["$a", []] } },
        in: {
          $let: {
            vars: { jsmqlStart: { $max: [{ $subtract: [{ $size: "$$jsmqlArr" }, 1] }, 0] } },
            in: {
              $let: {
                vars: { jsmqlTailStart: { $size: "$$jsmqlArr" } },
                in: {
                  $concatArrays: [
                    { $slice: ["$$jsmqlArr", "$$jsmqlStart"] },
                    [],
                    {
                      $cond: [
                        { $gt: [{ $subtract: [{ $size: "$$jsmqlArr" }, "$$jsmqlTailStart"] }, 0] },
                        {
                          $slice: [
                            "$$jsmqlArr",
                            "$$jsmqlTailStart",
                            { $subtract: [{ $size: "$$jsmqlArr" }, "$$jsmqlTailStart"] },
                          ],
                        },
                        [],
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
      },
    });
    // a start read at run time: the sign is not known until the server sees it
    expect(compiled("$.a.toSpliced($.neg, 1)", (d) => d.a.toSpliced(d.neg, 1))).toEqual({
      $let: {
        vars: { jsmqlArr: { $ifNull: ["$a", []] } },
        in: {
          $let: {
            vars: {
              jsmqlStart: {
                $cond: [
                  { $lt: ["$neg", 0] },
                  { $max: [{ $add: ["$neg", { $size: "$$jsmqlArr" }] }, 0] },
                  { $min: ["$neg", { $size: "$$jsmqlArr" }] },
                ],
              },
            },
            in: {
              $let: {
                vars: { jsmqlTailStart: { $add: ["$$jsmqlStart", 1] } },
                in: {
                  $concatArrays: [
                    { $slice: ["$$jsmqlArr", "$$jsmqlStart"] },
                    [],
                    {
                      $cond: [
                        { $gt: [{ $subtract: [{ $size: "$$jsmqlArr" }, "$$jsmqlTailStart"] }, 0] },
                        {
                          $slice: [
                            "$$jsmqlArr",
                            "$$jsmqlTailStart",
                            { $subtract: [{ $size: "$$jsmqlArr" }, "$$jsmqlTailStart"] },
                          ],
                        },
                        [],
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
      },
    });
  });

  it("lowers `.indexOf` and `.lastIndexOf` to the array form on a bare receiver", () => {
    // Both are array methods: the receiver is an array by the row's claim, and the
    // server judges any other value. A string takes `.indexOfSubstring`.
    expect(compiled("$.a.indexOf(1)", (d) => d.a.indexOf(1))).toEqual({ $indexOfArray: [{ $ifNull: ["$a", []] }, 1] });
    expect(compiled('$.csv.split(",").indexOf("b")', (d) => d.csv.split(",").indexOf("b"))).toEqual({
      $indexOfArray: [{ $ifNull: [{ $split: ["$csv", ","] }, []] }, "b"],
    });
    expect(compiled("$.a.lastIndexOf(2)", (d) => d.a.lastIndexOf(2))).toEqual({
      $let: {
        vars: { jsmqlArr: { $ifNull: ["$a", []] } },
        in: {
          $let: {
            vars: { jsmqlRevIdx: { $indexOfArray: [{ $reverseArray: "$$jsmqlArr" }, 2] } },
            in: {
              $cond: [
                { $eq: ["$$jsmqlRevIdx", -1] },
                -1,
                { $subtract: [{ $subtract: [{ $size: { $ifNull: ["$$jsmqlArr", []] } }, 1] }, "$$jsmqlRevIdx"] },
              ],
            },
          },
        },
      },
    });
  });

  it("lowers each method of one family to that family's operator on a bare receiver", () => {
    // Membership is `.has` on an array; the substring test is `.includes` on a string.
    expect(compiled("$.a.has(2)", (d) => d.a.includes(2))).toEqual({ $in: [2, { $ifNull: ["$a", []] }] });
    expect(compiled('$.csv.includes("b")', (d) => d.csv.includes("b"))).toEqual({
      $cond: [{ $lte: ["$csv", null] }, null, { $gte: [{ $indexOfCP: ["$csv", "b"] }, 0] }],
    });
    expect(compiled("$.a.at(-1)", (d) => d.a.at(-1))).toEqual({ $arrayElemAt: [{ $ifNull: ["$a", []] }, -1] });
    expect(compiled("$.a.slice(1, 3)", (d) => d.a.slice(1, 3))).toEqual({ $slice: [{ $ifNull: ["$a", []] }, 1, 2] });
    expect(compiled("$.csv.substring(2)", (d) => d.csv.substring(2))).toEqual({
      $cond: [
        { $lte: ["$csv", null] },
        null,
        { $substrCP: ["$csv", 2, { $max: [0, { $subtract: [{ $strLenCP: "$csv" }, 2] }] }] },
      ],
    });
    // `$concatArrays` takes arrays only, so a scalar argument becomes the one-element
    // array it stands for, as JavaScript's `Array.prototype.concat` reads it. An argument
    // the proof cannot place tests `$isArray` when it runs.
    expect(compiled("$.a.concat($.b)", (d) => d.a.concat(d.b))).toEqual({
      $concatArrays: [{ $ifNull: ["$a", []] }, { $cond: [{ $isArray: "$b" }, "$b", ["$b"]] }],
    });
    expect(compiled("$.a.concat($.n)", (d) => d.a.concat(d.n))).toEqual({
      $concatArrays: [{ $ifNull: ["$a", []] }, { $cond: [{ $isArray: "$n" }, "$n", ["$n"]] }],
    });
    expect(compiled('$.a.concat("!", "?")', (d) => d.a.concat("!", "?"))).toEqual({
      $concatArrays: [{ $ifNull: ["$a", []] }, ["!"], ["?"]],
    });
    expect(compiled("$.a.concat([9], [8])", (d) => d.a.concat([9], [8]))).toEqual({
      $concatArrays: [{ $ifNull: ["$a", []] }, [9], [8]],
    });
    expect(compiled("$.a.concat(2, 3)", (d) => d.a.concat(2, 3))).toEqual({
      $concatArrays: [{ $ifNull: ["$a", []] }, [2], [3]],
    });
    expect(compiled('$.a.concat($.b, "!", "?")', (d) => d.a.concat(d.b, "!", "?"))).toEqual({
      $concatArrays: [{ $ifNull: ["$a", []] }, { $cond: [{ $isArray: "$b" }, "$b", ["$b"]] }, ["!"], ["?"]],
    });
    expect(compiled('$.csv.split(",").concat("!", "?")', (d) => d.csv.split(",").concat("!", "?"))).toEqual({
      $concatArrays: [{ $ifNull: [{ $split: ["$csv", ","] }, []] }, ["!"], ["?"]],
    });
    // Strings join with `+`.
    expect(compiled('$.csv + "!" + "?"', (d) => d.csv + "!" + "?")).toEqual({ $concat: ["$csv", "!", "?"] });
    // `.size()` counts the elements of an array, and a missing array counts as empty; the
    // number of fields of an object is the size of its keys.
    expect(compiled("$.a.size()", (d) => d.a.length)).toEqual({ $size: { $ifNull: ["$a", []] } });
    expect(compiled("$.o.keys().size()", (d) => Object.keys(d.o).length)).toEqual({
      $size: { $map: { input: { $objectToArray: { $ifNull: ["$o", {}] } }, in: "$$this.k" } },
    });
    // `.toString()` is the bare `$toString`. On an array it gives MongoDB's text ("[3,1,2]"),
    // and `.join()` gives JavaScript's text ("3,1,2").
    expect(compiled("$.n.toString()", (d) => d.n.toString())).toEqual({ $toString: { $ifNull: ["$n", ""] } });
    expect(expr("$.a.toString()")).toEqual({ $toString: { $ifNull: ["$a", ""] } });
    expect(compiled("$.a.join()", (d) => d.a.toString())).toEqual(expr("$.a.join()"));
    // `$ifNull` wraps the reduce so an EMPTY array answers "" rather than the reduce's own
    // `null` seed; that guard also reads a missing receiver as "", so HR5 adds no `$ifNull` to it.
    // The seed is `null` so a leading "" element keeps its separator.
    expect(compiled('$.a.join("-")', (d) => d.a.join("-"))).toEqual({
      $ifNull: [
        {
          $reduce: {
            input: "$a",
            initialValue: null,
            in: {
              $cond: [
                { $eq: ["$$value", null] },
                { $cond: [{ $lte: ["$$this", null] }, "", { $toString: "$$this" }] },
                { $concat: ["$$value", "-", { $cond: [{ $lte: ["$$this", null] }, "", { $toString: "$$this" }] }] },
              ],
            },
          },
        },
        "",
      ],
    });
    expect(compiled('$.mixed.join(",")', (d) => d.mixed.join(","))).toEqual({
      $ifNull: [
        {
          $reduce: {
            input: "$mixed",
            initialValue: null,
            in: {
              $cond: [
                { $eq: ["$$value", null] },
                { $cond: [{ $lte: ["$$this", null] }, "", { $toString: "$$this" }] },
                { $concat: ["$$value", ",", { $cond: [{ $lte: ["$$this", null] }, "", { $toString: "$$this" }] }] },
              ],
            },
          },
        },
        "",
      ],
    });
    expect(compiled("$.n.clamp(0, 5)", () => 5)).toEqual({ $min: [{ $max: ["$n", 0] }, 5] });
  });

  it("folds, sets and groups as lodash does", () => {
    // `$sum`, `$avg` and `$max` answer null as they answer `[]`, so HR5 adds no `$ifNull`.
    expect(compiled("$.a.sum()", (d) => 6)).toEqual({ $sum: "$a" });
    expect(compiled("$.a.mean()", (d) => 2)).toEqual({ $avg: "$a" });
    expect(compiled("$.a.max()", (d) => 3)).toEqual({ $max: "$a" });
    expect(compiled("$.docs.sumBy(x => x.v)", () => 6)).toEqual({
      $sum: { $map: { input: "$docs", as: "x", in: "$$x.v" } },
    });
    expect(compiled('$.docs.maxBy("v")', () => ({ k: "x", v: 3 }))).toEqual({
      $let: {
        vars: {
          jsmqlSorted: {
            $sortArray: {
              input: { $map: { input: { $ifNull: ["$docs", []] }, as: "x", in: { k: "$$x.v", v: "$$x" } } },
              sortBy: { k: -1 },
            },
          },
        },
        in: { $getField: { field: "v", input: { $arrayElemAt: ["$$jsmqlSorted", 0] } } },
      },
    });
    expect(compiled("$.docs.minBy(x => x.v)", () => ({ k: "y", v: 1 }))).toEqual({
      $let: {
        vars: {
          jsmqlSorted: {
            $sortArray: {
              input: { $map: { input: { $ifNull: ["$docs", []] }, as: "x", in: { k: "$$x.v", v: "$$x" } } },
              sortBy: { k: 1 },
            },
          },
        },
        in: { $getField: { field: "v", input: { $arrayElemAt: ["$$jsmqlSorted", 0] } } },
      },
    });
    expect(unordered("$.mixed.uniq()", () => [0, 1, "", "a", null, false, true])).toEqual({
      $setUnion: { $ifNull: ["$mixed", []] },
    });
    expect(
      compiled('$.docs.uniqBy("k")', () => [
        { k: "x", v: 2 },
        { k: "y", v: 1 },
      ]),
    ).toEqual({
      $getField: {
        field: "out",
        input: {
          $reduce: {
            input: { $ifNull: ["$docs", []] },
            initialValue: { seen: [], out: [] },
            in: {
              $let: {
                vars: { jsmqlKey: { $let: { vars: { x: "$$this" }, in: "$$x.k" } } },
                in: {
                  $cond: [
                    { $in: ["$$jsmqlKey", "$$value.seen"] },
                    "$$value",
                    {
                      seen: { $concatArrays: ["$$value.seen", ["$$jsmqlKey"]] },
                      out: { $concatArrays: ["$$value.out", ["$$this"]] },
                    },
                  ],
                },
              },
            },
          },
        },
      },
    });
    expect(compiled("$.mixed.compact()", (d) => d.mixed.filter(Boolean))).toEqual({
      $filter: {
        input: { $ifNull: ["$mixed", []] },
        as: "jsmqlItem",
        cond: {
          $and: [
            { $gt: ["$$jsmqlItem", null] },
            { $ne: ["$$jsmqlItem", false] },
            { $ne: ["$$jsmqlItem", ""] },
            { $ne: ["$$jsmqlItem", 0] },
          ],
        },
      },
    });
    expect(compiled("$.nested.flatten()", (d) => d.nested.flat())).toEqual({
      $reduce: {
        input: { $ifNull: ["$nested", []] },
        initialValue: [],
        in: { $concatArrays: ["$$value", { $cond: [{ $isArray: "$$this" }, "$$this", ["$$this"]] }] },
      },
    });
    expect(unordered("$.a.intersection($.b)", () => [2])).toEqual({
      $setIntersection: [{ $ifNull: ["$a", []] }, { $ifNull: ["$b", []] }],
    });
    // The set difference: each value once, as a JavaScript Set holds it. lodash's
    // `_.difference([3, 1, 3, 2, 1], [2, 5])` keeps the duplicates, [3, 1, 3, 1].
    expect(unordered("$.a.difference($.b)", (d) => [...new Set(d.a).difference(new Set(d.b))])).toEqual({
      $setDifference: [{ $ifNull: ["$a", []] }, { $ifNull: ["$b", []] }],
    });
    expect(
      unordered("[3, 1, 3, 2, 1].difference($.b)", (d) => [...new Set([3, 1, 3, 2, 1]).difference(new Set(d.b))]),
    ).toEqual({ $setDifference: [[3, 1, 3, 2, 1], { $ifNull: ["$b", []] }] });
    expect(unordered("$.a.union($.b)", () => [3, 1, 2, 5])).toEqual({
      $setUnion: [{ $ifNull: ["$a", []] }, { $ifNull: ["$b", []] }],
    });
    expect(compiled("$.a.without(1)", () => [3, 2])).toEqual({
      $filter: { input: { $ifNull: ["$a", []] }, as: "jsmqlItem", cond: { $not: [{ $in: ["$$jsmqlItem", [1]] }] } },
    });
    expect(unordered("$.a.xor($.b)", () => [3, 1, 5])).toEqual({
      $setUnion: [
        { $setDifference: [{ $ifNull: ["$a", []] }, { $ifNull: ["$b", []] }] },
        { $setDifference: [{ $ifNull: ["$b", []] }, { $ifNull: ["$a", []] }] },
      ],
    });
    expect(compiled('$.docs.keyBy("k")', () => ({ x: { k: "x", v: 3 }, y: { k: "y", v: 1 } }))).toEqual({
      $arrayToObject: {
        $map: {
          input: { $ifNull: ["$docs", []] },
          as: "x",
          in: { k: { $ifNull: [{ $toString: "$$x.k" }, "null"] }, v: "$$x" },
        },
      },
    });
    expect(
      compiled('$.docs.groupBy("k")', () => ({
        x: [
          { k: "x", v: 2 },
          { k: "x", v: 3 },
        ],
        y: [{ k: "y", v: 1 }],
      })),
    ).toEqual({
      $arrayToObject: {
        $map: {
          input: {
            $setUnion: [
              {
                $map: { input: { $ifNull: ["$docs", []] }, as: "x", in: { $ifNull: [{ $toString: "$$x.k" }, "null"] } },
              },
              [],
            ],
          },
          as: "jsmqlKey",
          in: {
            k: "$$jsmqlKey",
            v: {
              $filter: {
                input: { $ifNull: ["$docs", []] },
                as: "x",
                cond: { $eq: [{ $ifNull: [{ $toString: "$$x.k" }, "null"] }, "$$jsmqlKey"] },
              },
            },
          },
        },
      },
    });
    expect(compiled('$.docs.countBy("k")', () => ({ x: 2, y: 1 }))).toEqual({
      $arrayToObject: {
        $map: {
          input: {
            $setUnion: [
              {
                $map: { input: { $ifNull: ["$docs", []] }, as: "x", in: { $ifNull: [{ $toString: "$$x.k" }, "null"] } },
              },
              [],
            ],
          },
          as: "jsmqlKey",
          in: {
            k: "$$jsmqlKey",
            v: {
              $size: {
                $filter: {
                  input: { $ifNull: ["$docs", []] },
                  as: "x",
                  cond: { $eq: [{ $ifNull: [{ $toString: "$$x.k" }, "null"] }, "$$jsmqlKey"] },
                },
              },
            },
          },
        },
      },
    });
    expect(compiled("$.a.partition(x => x > 1)", () => [[3, 2], [1]])).toEqual([
      { $filter: { input: { $ifNull: ["$a", []] }, as: "x", cond: { $gt: ["$$x", 1] } } },
      { $filter: { input: { $ifNull: ["$a", []] }, as: "x", cond: { $not: [{ $gt: ["$$x", 1] }] } } },
    ]);
    expect(compiled("$.a.reject(x => x > 1)", () => [1])).toEqual({
      $filter: { input: { $ifNull: ["$a", []] }, as: "x", cond: { $not: [{ $gt: ["$$x", 1] }] } },
    });
    expect(compiled("$.a.takeWhile(x => x > 1)", () => [3])).toEqual({
      $let: {
        vars: { jsmqlArr: { $ifNull: ["$a", []] } },
        in: {
          $let: {
            vars: {
              jsmqlFi: {
                $indexOfArray: [
                  { $map: { input: "$$jsmqlArr", as: "x", in: { $cond: [{ $gt: ["$$x", 1] }, true, false] } } },
                  false,
                ],
              },
            },
            in: { $cond: [{ $eq: ["$$jsmqlFi", -1] }, "$$jsmqlArr", { $slice: ["$$jsmqlArr", "$$jsmqlFi"] }] },
          },
        },
      },
    });
    expect(compiled("$.a.dropWhile(x => x > 1)", () => [1, 2])).toEqual({
      $let: {
        vars: { jsmqlArr: { $ifNull: ["$a", []] } },
        in: {
          $let: {
            vars: {
              jsmqlFi: {
                $indexOfArray: [
                  { $map: { input: "$$jsmqlArr", as: "x", in: { $cond: [{ $gt: ["$$x", 1] }, true, false] } } },
                  false,
                ],
              },
            },
            in: {
              $cond: [{ $eq: ["$$jsmqlFi", -1] }, [], { $slice: ["$$jsmqlArr", "$$jsmqlFi", { $size: "$$jsmqlArr" }] }],
            },
          },
        },
      },
    });
  });

  it("refuses what the server or JavaScript would", () => {
    expect(() => expr("$.a.take(-1)")).toThrow(/from 0 to Infinity/);
    expect(() => expr("$.a.chunk($.n)")).toThrow(/compile-time constant/);
    expect(() => expr("$.a.flat(2)")).toThrow(/from 1 to 1/);
    expect(() => expr("$.a.has(x => x > 1)")).toThrow(/searches for a VALUE/);
    expect(() => expr("$.csv.includes(x => x > 1)")).toThrow(/searches for a STRING/);
    // a receiver proven to be the other family: the refusal names that family's spelling
    expect(() => expr('$.csv.split(",").includes("b")')).toThrow("For membership in an array, write '.has(x)'.");
    expect(() => expr('$.s.trim().has("x")')).toThrow("For a substring test, write '.includes(x)'.");
    expect(() => expr('$.csv.split(",").length()')).toThrow("For the number of elements, write '.size()'.");
    expect(() => expr("$.s.trim().size()")).toThrow("For the number of characters, write '.length()'.");
    expect(() => expr('$.o.pick(["a"]).size()')).toThrow("For the number of fields, write '.keys().size()'.");
    expect(() => expr("$.s.trim().at(0)")).toThrow("For one character, write '.charAt(index)'.");
    expect(() => expr("$.s.trim().slice(1)")).toThrow("For a part of a string, write '.substring(start, end)'.");
    expect(() => expr('$.s.trim().concat("x")')).toThrow("To join strings, write '+' between them: 'a + b'.");
    expect(() => expr('$.s.trim().indexOf("b")')).toThrow(
      "For the position of a substring, write '.indexOfSubstring(searchString)'.",
    );
    expect(() => expr('$.s.trim().lastIndexOf("b")')).toThrow(
      "For the first match, write '.indexOfSubstring(searchString)'.",
    );
    expect(() => expr('$.a.uniq().indexOfSubstring("b")')).toThrow(
      "For the position of a value in an array, write '.indexOf(value)'.",
    );
    expect(() => expr("$.s.indexOfSubstring(1)")).toThrow(
      "'.indexOfSubstring()' argument 1 takes a string, but got a number.",
    );
    // Each argument of a string method takes one kind (HR7). The server refuses a fractional
    // index or count, and a number where it reads a string.
    expect(() => expr("$.s.substring(1.5)")).toThrow("'.substring()' argument 1 takes an integer, but got a fraction.");
    expect(() => expr("$.s.substring(0, 2.5)")).toThrow(
      "'.substring()' argument 2 takes an integer, but got a fraction.",
    );
    expect(() => expr("$.s.substr(1.5)")).toThrow("'.substr()' argument 1 takes an integer, but got a fraction.");
    expect(() => expr('$.s.charAt("1")')).toThrow("'.charAt()' argument 1 takes an integer, but got a string.");
    expect(() => expr("$.s.repeat(2.5)")).toThrow("'.repeat()' argument 1 takes an integer, but got a fraction.");
    expect(() => expr('$.s.padStart("3")')).toThrow("'.padStart()' argument 1 takes an integer, but got a string.");
    expect(() => expr("$.s.padEnd(3, 0)")).toThrow("'.padEnd()' argument 2 takes a string, but got a number.");
    expect(() => expr("$.s.split(1)")).toThrow("'.split()' argument 1 takes a string, but got a number.");
    expect(() => expr("$.s.startsWith(1)")).toThrow("'.startsWith()' argument 1 takes a string, but got a number.");
    expect(() => expr("$.s.endsWith(1)")).toThrow("'.endsWith()' argument 1 takes a string, but got a number.");
    expect(() => expr("$.s.includes(1)")).toThrow("'.includes()' argument 1 takes a string, but got a number.");
    expect(() => expr('$.s.replace(1, "x")')).toThrow("'.replace()' argument 1 takes a string, but got a number.");
    expect(() => expr('$.s.replaceAll(",", 1)')).toThrow(
      "'.replaceAll()' argument 2 takes a string, but got a number.",
    );
    expect(() => expr("$.s.includes($.s.length())")).toThrow(
      "'.includes()' argument 1 takes a string, but got a number.",
    );
    // The query road falls back to the value cell. Both cells state the kind.
    expect(() => jsmql("$.s.startsWith(1)")).toThrow("'.startsWith()' argument 1 takes a string, but got a number.");
    // the position is an integer: `$indexOfCP` refuses a fractional start (HR7)
    expect(() => expr('$.s.indexOfSubstring("b", 1.9)')).toThrow(
      "'.indexOfSubstring()' argument 2 takes an integer, but got a fraction.",
    );
    expect(() => expr('$.s.indexOfSubstring("b", "2")')).toThrow(
      "'.indexOfSubstring()' argument 2 takes an integer, but got a string.",
    );
    expect(() => expr("$.a.map(5)")).toThrow(/takes an arrow/);
    expect(() => expr("$.a.map((a, b, c, d) => a)")).toThrow(/at most 3 parameters/);
  });

  it("refuses a null argument where the slot states a kind (HR7)", () => {
    // `null` is not the kind a slot states, whatever the server answers for it.
    expect(() => expr("$.a.slice(null)")).toThrow("'.slice()' argument 1 takes an integer, but got null.");
    expect(() => expr("$.s.split(null)")).toThrow("'.split()' argument 1 takes a string, but got null.");
    expect(() => expr("$.o.pick(null)")).toThrow("'.pick()' argument 1 takes an array, but got null.");
    expect(() => expr("$.s.truncate(null)")).toThrow("'.truncate()' argument 1 takes a document, but got null.");
    expect(() => expr('$.d.diff(null, "day")')).toThrow("'.diff()' argument 1 takes a date, but got null.");
    // a body key and an element of a list
    expect(() => expr("$.d.set({ year: null })")).toThrow("'.set()' year takes an integer, but got null.");
    expect(() => expr("$.o.pick([null])")).toThrow(/'\.pick\(\)' element 1 takes a field NAME .*, but got null\./);
    // a value the proof shows is null: a binding, and a `?.` read of a key that no stage wrote
    expect(() => jsmql("let x = null; $.r = $.a.slice(x);")).toThrow(
      "'.slice()' argument 1 takes an integer, but got null.",
    );
    expect(() => jsmql("$.o = {}; $.r = $.a.slice($.o?.b);")).toThrow(
      "'.slice()' argument 1 takes an integer, but got null.",
    );
    // a slot that states no kind takes `null` as a value
    expect(expr("$.a.has(null)")).toEqual({ $in: [null, { $ifNull: ["$a", []] }] });
    expect(expr("$.a.indexOf(null)")).toEqual({ $indexOfArray: [{ $ifNull: ["$a", []] }, null] });
  });
});

// ── the server ───────────────────────────────────────────────────────────────

/** lodash's `_.range` (its `baseRange`), the answer each `.range()` case compares with. */
const lodashRange = (start: number, end?: number, step?: number): number[] => {
  if (end === undefined) [start, end] = [0, start];
  const by = step === undefined ? (start < end ? 1 : -1) : step;
  const out: number[] = [];
  for (let n = Math.max(Math.ceil((end - start) / (by || 1)), 0), v = start; n > 0; n--, v += by) out.push(v);
  return out;
};

describe("compiler/emit — number ranges", () => {
  it("folds the direction when both bounds are constants", () => {
    expect(compiled("(0).range(4)", () => lodashRange(0, 4))).toEqual({ $range: [0, 4] });
    expect(compiled("(0).range(-4)", () => lodashRange(0, -4))).toEqual({ $range: [0, -4, -1] });
    expect(compiled("(1).range(5)", () => lodashRange(1, 5))).toEqual({ $range: [1, 5] });
    expect(compiled("(5).range(1)", () => lodashRange(5, 1))).toEqual({ $range: [5, 1, -1] });
    expect(compiled("(3).range(3)", () => lodashRange(3, 3))).toEqual({ $range: [3, 3] });
    expect(compiled("(4).range()", () => lodashRange(4))).toEqual({ $range: [0, 4] });
    expect(compiled("(0).range(20, 5)", () => lodashRange(0, 20, 5))).toEqual({ $range: [0, 20, 5] });
  });

  it("reads the receiver as lodash's end alone, and as its start with more arguments", () => {
    const neg = { $ifNull: ["$neg", 0] };
    const id = { $ifNull: ["$_id", 0] };
    expect(compiled("$._id.range()", (d) => lodashRange(d._id))).toEqual({
      $range: [0, id, { $cond: [{ $lt: [0, id] }, 1, -1] }],
    });
    expect(compiled("$.neg.range()", (d) => lodashRange(d.neg))).toEqual({
      $range: [0, neg, { $cond: [{ $lt: [0, neg] }, 1, -1] }],
    });
    expect(compiled("$._id.range($.neg)", (d) => lodashRange(d._id, d.neg))).toEqual({
      $range: [id, neg, { $cond: [{ $lt: [id, neg] }, 1, -1] }],
    });
    expect(compiled("$.neg.range($._id)", (d) => lodashRange(d.neg, d._id))).toEqual({
      $range: [neg, id, { $cond: [{ $lt: [neg, id] }, 1, -1] }],
    });
    expect(compiled("$._id.range($.neg, -2)", (d) => lodashRange(d._id, d.neg, -2))).toEqual({ $range: [id, neg, -2] });
  });

  it("reads a missing bound as 0, and binds a computed bound once", () => {
    expect(compiled("$.nope.range()", () => lodashRange(0))).toEqual({
      $range: [0, { $ifNull: ["$nope", 0] }, { $cond: [{ $lt: [0, { $ifNull: ["$nope", 0] }] }, 1, -1] }],
    });
    expect(compiled("(1).range($.neg + 1)", (d) => lodashRange(1, d.neg + 1))).toEqual({
      $let: {
        vars: { jsmqlEnd: { $ifNull: [{ $add: ["$neg", 1] }, 0] } },
        in: { $range: [1, "$$jsmqlEnd", { $cond: [{ $lt: [1, "$$jsmqlEnd"] }, 1, -1] }] },
      },
    });
    // the answer is never null, so a chain after it pays no guard
    expect(compiled("$.neg.range().size()", (d) => lodashRange(d.neg).length)).toEqual({
      $size: { $range: [0, { $ifNull: ["$neg", 0] }, { $cond: [{ $lt: [0, { $ifNull: ["$neg", 0] }] }, 1, -1] }] },
    });
    expect(compiled("$.nope?.range()", () => null)).toEqual({
      $cond: [{ $lte: ["$nope", null] }, null, { $range: [0, "$nope", { $cond: [{ $lt: [0, "$nope"] }, 1, -1] }] }],
    });
  });

  it("gives .rangeRight() as the same range, reversed", () => {
    expect(compiled("(1).rangeRight(5)", () => lodashRange(1, 5).reverse())).toEqual({
      $reverseArray: { $range: [1, 5] },
    });
    expect(compiled("$._id.rangeRight($.neg, -2)", (d) => lodashRange(d._id, d.neg, -2).reverse())).toEqual({
      $reverseArray: { $range: [{ $ifNull: ["$_id", 0] }, { $ifNull: ["$neg", 0] }, -2] },
    });
  });

  it("refuses a zero step and a fractional bound, and names the alternative", () => {
    expect(() => expr("(0).range(5, 0)")).toThrow(/cannot be 0.*n\.range\(\)\.map/);
    expect(() => expr("(0.5).range(3)")).toThrow(/receiver takes an integer, but got a fraction.*\.ceil\(\)/);
    expect(() => expr("(0).range(2.5)")).toThrow(/argument 1 takes an integer/);
    expect(() => expr("$.n.rangeRight($.m, 1.5)")).toThrow(/argument 2 takes an integer/);
    expect(() => expr("$.n.range(1, 2, 3)")).toThrow(/\.range\(\[end\[, step\]\]\)/);
  });

  it("leaves the $range escape hatch as raw MQL", () => {
    expect(expr("$range(5)")).toEqual({ $range: 5 });
  });
});

describe("compiler/emit — the JavaScript globals, Math, regex methods and the reducers", () => {
  it("lowers each number method that a Math member names to its operator", () => {
    expect(compiled("$.neg.abs()", () => Math.abs(DOC.neg))).toEqual({ $abs: "$neg" });
    expect(compiled("$.n.sqrt()", () => Math.sqrt(DOC.n))).toEqual({ $sqrt: "$n" });
    expect(compiled("$.neg.cbrt()", () => Math.cbrt(DOC.neg))).toEqual({
      $multiply: [{ $cmp: ["$neg", 0] }, { $pow: [{ $abs: "$neg" }, 0.3333333333333333] }],
    });
    expect(compiled("$.neg.sign()", () => Math.sign(DOC.neg))).toEqual({ $cmp: [{ $ifNull: ["$neg", 0] }, 0] });
    // HR5: a missing number reads as 0, the safe value, so its sign is 0
    expect(compiled("$.nope.sign()", () => 0)).toEqual({ $cmp: [{ $ifNull: ["$nope", 0] }, 0] });
    expect(compiled("$.n.trunc()", () => Math.trunc(DOC.n))).toEqual({ $trunc: "$n" });
    expect(compiled("$.n.trunc(2)", () => Math.trunc(DOC.n * 100) / 100)).toEqual({ $trunc: ["$n", 2] });
    expect(compiled("$.n.round()", () => Math.round(DOC.n))).toEqual({ $round: "$n" });
    expect(compiled("$.n.ceil()", () => Math.ceil(DOC.n))).toEqual({ $ceil: "$n" });
    expect(compiled("$.n.floor()", () => Math.floor(DOC.n))).toEqual({ $floor: "$n" });
    expect(compiled("$.n.log()", () => Math.log(DOC.n))).toEqual({ $ln: "$n" });
    expect(compiled("$.n.log2()", () => Math.log2(DOC.n))).toEqual({ $log: ["$n", 2] });
    expect(compiled("$.n.log10()", () => Math.log10(DOC.n))).toEqual({ $log10: "$n" });
    // `.log(base)` takes a base, and the constant 10 has an operator of its own
    expect(compiled("$.n.log(10)", () => Math.log10(DOC.n))).toEqual({ $log10: "$n" });
    expect(expr("$.n.log($.b)")).toEqual({ $log: ["$n", "$b"] });
    expect(compiled("$.n.floor(1)", () => Math.floor(DOC.n * 10) / 10)).toEqual({
      $divide: [{ $floor: { $multiply: ["$n", 10] } }, 10],
    });
    expect(compiled("$.neg.exp()", () => Math.exp(DOC.neg))).toEqual({ $exp: "$neg" });
    expect(compiled("$.neg ** 3", () => Math.pow(DOC.neg, 3))).toEqual({ $pow: ["$neg", 3] });
    expect(compiled("$.neg.hypot(4)", () => Math.hypot(DOC.neg, 4))).toEqual({
      $sqrt: { $add: [{ $pow: ["$neg", 2] }, { $pow: [4, 2] }] },
    });
    expect(compiled("$.neg.atan2(4)", () => Math.atan2(DOC.neg, 4))).toEqual({ $atan2: ["$neg", 4] });
    expect(compiled("$.n.sin()", () => Math.sin(DOC.n))).toEqual({ $sin: "$n" });
    expect(compiled("($.n / 10).acos()", () => Math.acos(DOC.n / 10))).toEqual({ $acos: { $divide: ["$n", 10] } });
    expect(compiled("$.n.tanh()", () => Math.tanh(DOC.n))).toEqual({ $tanh: "$n" });
    expect(compiled("$.n.asinh()", () => Math.asinh(DOC.n))).toEqual({ $asinh: "$n" });
    expect(compiled("[$.neg, $.n].min()", () => Math.min(DOC.neg, DOC.n))).toEqual({ $min: ["$neg", "$n"] });
    expect(compiled("$.a.max()", () => Math.max(...DOC.a))).toEqual({ $max: "$a" });
    expect(compiled("[...$.a, 9].max()", () => Math.max(...DOC.a, 9))).toEqual({
      $max: { $concatArrays: [{ $ifNull: ["$a", []] }, [9]] },
    });
    expect(expr("Math.random()")).toEqual({ $rand: {} });
  });

  it("lowers the global constructors and the Number, Array and Object statics", () => {
    expect(compiled("String($.n)", () => String(DOC.n))).toEqual({ $toString: "$n" });
    expect(compiled("Boolean($.neg)", () => Boolean(DOC.neg))).toEqual({
      $and: [{ $gt: ["$neg", null] }, { $ne: ["$neg", false] }, { $ne: ["$neg", ""] }, { $ne: ["$neg", 0] }],
    });
    expect(compiled("Number($.n)", () => Number(DOC.n))).toEqual({ $toDouble: "$n" });
    expect(compiled("Number.isInteger($.n)", () => Number.isInteger(DOC.n))).toEqual({
      $and: [
        { $and: [{ $isNumber: "$n" }, { $not: [{ $in: [{ $toString: "$n" }, ["NaN", "Infinity", "-Infinity"]] }] }] },
        { $eq: ["$n", { $trunc: "$n" }] },
      ],
    });
    expect(compiled("Number.isInteger($.neg)", () => Number.isInteger(DOC.neg))).toEqual({
      $and: [
        {
          $and: [{ $isNumber: "$neg" }, { $not: [{ $in: [{ $toString: "$neg" }, ["NaN", "Infinity", "-Infinity"]] }] }],
        },
        { $eq: ["$neg", { $trunc: "$neg" }] },
      ],
    });
    expect(compiled("Number.isNaN($.n)", () => Number.isNaN(DOC.n))).toEqual({
      $and: [{ $isNumber: "$n" }, { $eq: [{ $toString: "$n" }, "NaN"] }],
    });
    expect(compiled("Array.isArray($.a)", () => Array.isArray(DOC.a))).toEqual({ $isArray: ["$a"] });
    expect(compiled("Array.isArray($.n)", () => Array.isArray(DOC.n))).toEqual({ $isArray: ["$n"] });
    expect(compiled("$.o.assign({ z: 1 })", () => Object.assign({}, DOC.o, { z: 1 }))).toEqual({
      $mergeObjects: ["$o", { z: 1 }],
    });
    // A spread argument is a list of sources, a plain argument is one source, and an
    // empty receiver adds nothing to the merge.
    expect(compiled("({}).assign(...$.docs)", () => Object.assign({}, ...DOC.docs))).toEqual({
      $mergeObjects: "$docs",
    });
    expect(compiled("({}).assign($.o)", () => Object.assign({}, DOC.o))).toEqual({ $mergeObjects: ["$o"] });
    expect(compiled("({}).assign($.o, { z: 1 })", () => Object.assign({}, DOC.o, { z: 1 }))).toEqual({
      $mergeObjects: ["$o", { z: 1 }],
    });
    expect(compiled("$.o.assign(...$.docs)", () => Object.assign({}, DOC.o, ...DOC.docs))).toEqual({
      $mergeObjects: { $concatArrays: [["$o"], { $ifNull: ["$docs", []] }] },
    });
    // One plain argument is one source. The server refuses an array there, so this
    // shape stays out of the server run.
    expect(expr("$.o.assign($.docs)")).toEqual({ $mergeObjects: ["$o", "$docs"] });
    expect(compiled("$.pairs.fromEntries()", () => Object.fromEntries(DOC.pairs as [string, number][]))).toEqual({
      $arrayToObject: {
        $map: {
          input: { $ifNull: ["$pairs", []] },
          in: [{ $toString: { $first: "$$this" } }, { $arrayElemAt: ["$$this", 1] }],
        },
      },
    });
    // A list of pairs written in the source is the `$map` input itself, with no extra array level.
    expect(
      compiled('[["a", 1], ["b", $.n]].fromEntries()', (d) =>
        Object.fromEntries([
          ["a", 1],
          ["b", d.n],
        ]),
      ),
    ).toEqual({
      $arrayToObject: {
        $map: {
          input: [
            ["a", 1],
            ["b", "$n"],
          ],
          in: [{ $toString: { $first: "$$this" } }, { $arrayElemAt: ["$$this", 1] }],
        },
      },
    });
    // A number key becomes a string key, as in JavaScript.
    expect(
      compiled('[[7, $.neg], ["b", 1]].fromEntries()', (d) =>
        Object.fromEntries([
          [7, d.neg],
          ["b", 1],
        ]),
      ),
    ).toEqual({
      $arrayToObject: {
        $map: {
          input: [
            [7, "$neg"],
            ["b", 1],
          ],
          in: [{ $toString: { $first: "$$this" } }, { $arrayElemAt: ["$$this", 1] }],
        },
      },
    });
  });

  it("applies a bare callable global to each element", () => {
    expect(compiled("$.a.map(String)", () => DOC.a.map(String))).toEqual({
      $map: { input: { $ifNull: ["$a", []] }, as: "x", in: { $toString: "$$x" } },
    });
    expect(compiled("$.mixed.filter(Boolean)", () => DOC.mixed.filter(Boolean))).toEqual({
      $filter: {
        input: { $ifNull: ["$mixed", []] },
        as: "x",
        cond: { $and: [{ $gt: ["$$x", null] }, { $ne: ["$$x", false] }, { $ne: ["$$x", ""] }, { $ne: ["$$x", 0] }] },
      },
    });
    expect(compiled("$.a.some(Number.isInteger)", () => DOC.a.some(Number.isInteger))).toEqual({
      $anyElementTrue: {
        $map: {
          input: { $ifNull: ["$a", []] },
          as: "x",
          in: {
            $and: [
              {
                $and: [
                  { $isNumber: "$$x" },
                  { $not: [{ $in: [{ $toString: "$$x" }, ["NaN", "Infinity", "-Infinity"]] }] },
                ],
              },
              { $eq: ["$$x", { $trunc: "$$x" }] },
            ],
          },
        },
      },
    });
    // A BSON constructor applies point-free too, but not HERE: this suite asks the
    // server to agree with JavaScript, and a BSON conversion has no JavaScript
    // counterpart to agree with — `$toDecimal` answers a Decimal128 where JavaScript
    // answers a number. test/codegen.test.ts asserts those shapes without running.
    // `Set` demands `new`, so no bare spelling of it applies to an element.
    expect(() => expr("$.a.map(Set)")).toThrow(/takes an arrow/);
  });

  it("lowers a regex literal's own methods", () => {
    expect(compiled("/hello/i.test($.s)", () => /hello/i.test(DOC.s))).toEqual({
      $regexMatch: { input: "$s", regex: "hello", options: "i" },
    });
    expect(expr("/o/.exec($.s)")).toEqual({ $regexFind: { input: "$s", regex: "o" } });
  });

  it("lowers the index searches, the reducers and zipWith", () => {
    expect(compiled("$.a.findIndex(x => x < 3)", () => DOC.a.findIndex((x) => x < 3))).toEqual({
      $reduce: {
        input: { $zip: { inputs: [{ $range: [0, { $size: { $ifNull: ["$a", []] } }] }, { $ifNull: ["$a", []] }] } },
        initialValue: -1,
        in: {
          $cond: [
            {
              $and: [
                { $eq: ["$$value", -1] },
                { $let: { vars: { x: { $arrayElemAt: ["$$this", 1] } }, in: { $lt: ["$$x", 3] } } },
              ],
            },
            { $arrayElemAt: ["$$this", 0] },
            "$$value",
          ],
        },
      },
    });
    expect(compiled("$.a.findIndex((x, i) => x + i > 3)", () => DOC.a.findIndex((x, i) => x + i > 3))).toEqual({
      $reduce: {
        input: { $zip: { inputs: [{ $range: [0, { $size: { $ifNull: ["$a", []] } }] }, { $ifNull: ["$a", []] }] } },
        initialValue: -1,
        in: {
          $cond: [
            {
              $and: [
                { $eq: ["$$value", -1] },
                {
                  $let: {
                    vars: { jsmqlPair: "$$this" },
                    in: {
                      $let: {
                        vars: { x: { $arrayElemAt: ["$$jsmqlPair", 1] }, i: { $arrayElemAt: ["$$jsmqlPair", 0] } },
                        in: { $gt: [{ $add: ["$$x", "$$i"] }, 3] },
                      },
                    },
                  },
                },
              ],
            },
            { $arrayElemAt: ["$$this", 0] },
            "$$value",
          ],
        },
      },
    });
    expect(compiled("$.a.findIndex(x => x > 9)", () => DOC.a.findIndex((x) => x > 9))).toEqual({
      $reduce: {
        input: { $zip: { inputs: [{ $range: [0, { $size: { $ifNull: ["$a", []] } }] }, { $ifNull: ["$a", []] }] } },
        initialValue: -1,
        in: {
          $cond: [
            {
              $and: [
                { $eq: ["$$value", -1] },
                { $let: { vars: { x: { $arrayElemAt: ["$$this", 1] } }, in: { $gt: ["$$x", 9] } } },
              ],
            },
            { $arrayElemAt: ["$$this", 0] },
            "$$value",
          ],
        },
      },
    });
    expect(compiled("$.a.findLastIndex(x => x > 1)", () => DOC.a.findLastIndex((x) => x > 1))).toEqual({
      $reduce: {
        input: { $zip: { inputs: [{ $range: [0, { $size: { $ifNull: ["$a", []] } }] }, { $ifNull: ["$a", []] }] } },
        initialValue: -1,
        in: {
          $cond: [
            { $let: { vars: { x: { $arrayElemAt: ["$$this", 1] } }, in: { $gt: ["$$x", 1] } } },
            { $arrayElemAt: ["$$this", 0] },
            "$$value",
          ],
        },
      },
    });
    expect(compiled("$.a.reduce((acc, x) => acc + x, 0)", () => DOC.a.reduce((acc, x) => acc + x, 0))).toEqual({
      $reduce: { input: { $ifNull: ["$a", []] }, initialValue: 0, in: { $add: ["$$value", "$$this"] } },
    });
    expect(
      compiled("$.a.reduce((acc, x, i) => acc + x * i, 0)", () => DOC.a.reduce((acc, x, i) => acc + x * i, 0)),
    ).toEqual({
      $reduce: {
        input: { $zip: { inputs: [{ $range: [0, { $size: { $ifNull: ["$a", []] } }] }, { $ifNull: ["$a", []] }] } },
        initialValue: 0,
        in: {
          $let: {
            vars: { x: { $arrayElemAt: ["$$this", 1] }, i: { $arrayElemAt: ["$$this", 0] } },
            in: { $add: ["$$value", { $multiply: ["$$x", "$$i"] }] },
          },
        },
      },
    });
    // a body that calls anything reads the reducer's two variables through a `$let`: the call may own a `$reduce`
    expect(
      compiled("$.a.reduceRight((acc, x) => acc.concat([x]), [])", () =>
        DOC.a.reduceRight((acc: number[], x) => acc.concat([x]), []),
      ),
    ).toEqual({
      $reduce: {
        input: { $reverseArray: { $ifNull: ["$a", []] } },
        initialValue: [],
        in: {
          $let: { vars: { acc: "$$value", x: "$$this" }, in: { $concatArrays: [{ $ifNull: ["$$acc", []] }, ["$$x"]] } },
        },
      },
    });
    expect(
      compiled("$.docs.reduce((acc, d) => acc + d.v, 0)", () => DOC.docs.reduce((acc, d) => acc + d.v, 0)),
    ).toEqual({
      $reduce: { input: { $ifNull: ["$docs", []] }, initialValue: 0, in: { $add: ["$$value", "$$this.v"] } },
    });
    expect(compiled("$.a.zipWith($.a, (x, y) => x * y)", () => DOC.a.map((x, i) => x * DOC.a[i]))).toEqual({
      $map: {
        input: { $zip: { inputs: [{ $ifNull: ["$a", []] }, "$a"], useLongestLength: true } },
        as: "jsmqlPair",
        in: {
          $let: {
            vars: { x: { $arrayElemAt: ["$$jsmqlPair", 0] }, y: { $arrayElemAt: ["$$jsmqlPair", 1] } },
            in: { $multiply: ["$$x", "$$y"] },
          },
        },
      },
    });
    expect(() => expr("$.a.reduce(5, 0)")).toThrow(/two- or three-parameter arrow/);
    expect(() => expr("$.a.zipWith($.b, x => x)")).toThrow(/one parameter per zipped array/);
  });

  it("does each JavaScript Set operation with an array method", () => {
    // MongoDB has no set type. Each case is the array form of one Set operation, and
    // JavaScript's own Set gives the answer that the server must agree with. A set
    // operator promises no order, so the elements are compared, not their sequence.
    // MEASURED: $setIsSubset and $size ABORT the command on an operand that is not an
    // array, so a missing receiver runs on `[]` (HR5) and a missing list argument is `[]`.
    expect(unordered("$.dup.uniq()", (d) => [...new Set(d.dup)])).toEqual({ $setUnion: { $ifNull: ["$dup", []] } });
    expect(compiled("$.dup.uniq().size()", (d) => new Set(d.dup).size)).toEqual({
      $size: { $setUnion: { $ifNull: ["$dup", []] } },
    });
    expect(compiled("$.dup.has(3)", (d) => new Set(d.dup).has(3))).toEqual({ $in: [3, { $ifNull: ["$dup", []] }] });
    expect(unordered("$.dup.union([9])", (d) => [...new Set(d.dup).add(9)])).toEqual({
      $setUnion: [{ $ifNull: ["$dup", []] }, [9]],
    });
    expect(
      unordered("$.dup.uniq().without(3)", (d) => {
        const s = new Set(d.dup);
        s.delete(3);
        return [...s];
      }),
    ).toEqual({
      $filter: {
        input: { $setUnion: { $ifNull: ["$dup", []] } },
        as: "jsmqlItem",
        cond: { $not: [{ $in: ["$$jsmqlItem", [3]] }] },
      },
    });
    expect(unordered("$.dup.union($.b)", (d) => [...new Set(d.dup).union(new Set(d.b))])).toEqual({
      $setUnion: [{ $ifNull: ["$dup", []] }, { $ifNull: ["$b", []] }],
    });
    expect(unordered("$.dup.intersection($.b)", (d) => [...new Set(d.dup).intersection(new Set(d.b))])).toEqual({
      $setIntersection: [{ $ifNull: ["$dup", []] }, { $ifNull: ["$b", []] }],
    });
    expect(unordered("$.dup.difference($.b)", (d) => [...new Set(d.dup).difference(new Set(d.b))])).toEqual({
      $setDifference: [{ $ifNull: ["$dup", []] }, { $ifNull: ["$b", []] }],
    });
    // Two spellings of one answer: the Set name binds each list once, lodash's name reads each twice.
    expect(
      unordered("$.dup.symmetricDifference($.b)", (d) => [...new Set(d.dup).symmetricDifference(new Set(d.b))]),
    ).toEqual({
      $let: {
        vars: { jsmqlA: { $ifNull: ["$dup", []] }, jsmqlB: { $ifNull: ["$b", []] } },
        in: {
          $setDifference: [{ $setUnion: ["$$jsmqlA", "$$jsmqlB"] }, { $setIntersection: ["$$jsmqlA", "$$jsmqlB"] }],
        },
      },
    });
    expect(unordered("$.dup.xor($.b)", (d) => [...new Set(d.dup).symmetricDifference(new Set(d.b))])).toEqual({
      $setUnion: [
        { $setDifference: [{ $ifNull: ["$dup", []] }, { $ifNull: ["$b", []] }] },
        { $setDifference: [{ $ifNull: ["$b", []] }, { $ifNull: ["$dup", []] }] },
      ],
    });
    expect(compiled("$.dup.isSubsetOf($.b)", (d) => new Set(d.dup).isSubsetOf(new Set(d.b)))).toEqual({
      $setIsSubset: [{ $ifNull: ["$dup", []] }, { $ifNull: ["$b", []] }],
    });
    expect(compiled("[1, 3].isSubsetOf($.dup)", (d) => new Set([1, 3]).isSubsetOf(new Set(d.dup)))).toEqual({
      $setIsSubset: [[1, 3], { $ifNull: ["$dup", []] }],
    });
    expect(compiled("$.dup.isSupersetOf([1, 3])", (d) => new Set(d.dup).isSupersetOf(new Set([1, 3])))).toEqual({
      $setIsSubset: [[1, 3], { $ifNull: ["$dup", []] }],
    });
    expect(compiled("$.dup.isDisjointFrom($.b)", (d) => new Set(d.dup).isDisjointFrom(new Set(d.b)))).toEqual({
      $eq: [{ $size: { $setIntersection: [{ $ifNull: ["$dup", []] }, { $ifNull: ["$b", []] }] } }, 0],
    });
    expect(compiled("$.dup.isDisjointFrom([9])", (d) => new Set(d.dup).isDisjointFrom(new Set([9])))).toEqual({
      $eq: [{ $size: { $setIntersection: [{ $ifNull: ["$dup", []] }, [9]] } }, 0],
    });
  });

  it("packs a spread into the one list a variadic method reads", () => {
    // a constant spread folds to the call JavaScript makes: one argument per element
    expect(expr("[1].concat(...[[2], 3])")).toEqual([1, 2, 3]);
    expect(expr("[...[1, 5], 7].max()")).toBe(7);
    // each element of a spread is an argument of its own, and follows concat's rule
    expect(compiled("$.a.concat(...$.b, 1)", () => DOC.a.concat(...DOC.b, 1))).toEqual({
      $concatArrays: [
        { $ifNull: ["$a", []] },
        {
          $reduce: {
            input: { $ifNull: ["$b", []] },
            initialValue: [],
            in: { $concatArrays: ["$$value", { $cond: [{ $isArray: "$$this" }, "$$this", ["$$this"]] }] },
          },
        },
        [1],
      ],
    });
    expect(compiled("$.a.concat(...$.nested)", () => DOC.a.concat(...DOC.nested))).toEqual({
      $concatArrays: [
        { $ifNull: ["$a", []] },
        {
          $reduce: {
            input: { $ifNull: ["$nested", []] },
            initialValue: [],
            in: { $concatArrays: ["$$value", { $cond: [{ $isArray: "$$this" }, "$$this", ["$$this"]] }] },
          },
        },
      ],
    });
    // the proof shows each element is an array, so the `$reduce` splices it with no test
    expect(compiled("$.a.concat(...$.b.map(x => [x]))", () => DOC.a.concat(...DOC.b.map((x) => [x])))).toEqual({
      $concatArrays: [
        { $ifNull: ["$a", []] },
        {
          $reduce: {
            input: { $map: { input: { $ifNull: ["$b", []] }, as: "x", in: ["$$x"] } },
            initialValue: [],
            in: { $concatArrays: ["$$value", "$$this"] },
          },
        },
      ],
    });
    expect(compiled('$.csv.split(",").concat(...$.a)', () => DOC.csv.split(",").concat(...DOC.a))).toEqual({
      $concatArrays: [
        { $ifNull: [{ $split: ["$csv", ","] }, []] },
        {
          $reduce: {
            input: { $ifNull: ["$a", []] },
            initialValue: [],
            in: { $concatArrays: ["$$value", { $cond: [{ $isArray: "$$this" }, "$$this", ["$$this"]] }] },
          },
        },
      ],
    });
    expect(() => expr("$.a.indexOf(...$.b)")).toThrow(/Spread \(\.\.\.\) is not supported/);
  });

  it("lowers a $switch written with $case branches, and the date constructors from parts", () => {
    expect(expr('$switch([$case($.n > 1, "big")], "small")')).toEqual({
      $switch: { branches: [{ case: { $gt: ["$n", 1] }, then: "big" }], default: "small" },
    });
    // a constant constructor folds; its month counts from 0, as JavaScript's does
    expect(expr("new Date(2026, 0, 15)")).toEqual(new Date("2026-01-15T00:00:00.000Z"));
    expect(expr("new Date($.n, $.neg)")).toEqual({ $dateFromParts: { year: "$n", month: { $add: ["$neg", 1] } } });
    expect(compiled("Date.UTC($.d.getFullYear(), 0, 1)", () => Date.UTC(DOC.d.getUTCFullYear(), 0, 1))).toEqual({
      $toLong: { $dateFromParts: { year: { $year: "$d" }, month: 1, day: 1, timezone: "UTC" } },
    });
  });
});

let client: MongoClient | null = null;
let coll: Collection | null = null;

beforeAll(async () => {
  client = await liveClient();
  // Null means the instance is not running, and only that: liveClient throws on any
  // other refusal rather than letting this suite skip itself green.
  if (client === null) return;
  const c = client;
  coll = c.db("jsmql_compiler_methods").collection("t");
  await coll.deleteMany({});
  await coll.insertOne({ ...DOC });
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

/**
 * The list operands that ABORT the whole command when they are not an array.
 *
 * MEASURED: `$in`'s second operand, both of `$setIsSubset`'s and `$size`'s one refuse a
 * null or missing value, where `$map`, `$filter`, `$slice`, `$setUnion` and the rest
 * answer null in turn. A document that lacks the field would take the query down with
 * it, so each of these reads its list as the empty list — the list ARGUMENT through
 * the cell's own guard, the RECEIVER through HR5, which runs an array method on `[]`.
 *
 * Each row: the source, what it answers over an EMPTY document, and what it answers
 * when only the LIST is missing. `undefined` means the row wrote no field at all.
 */
const GUARDED: readonly (readonly [string, unknown, unknown])[] = [
  ["$.a.difference($.b)", [], [1, 2]],
  ['$.a.differenceBy($.b, "id")', [], [1, 2]],
  ['$.a.intersectionBy($.b, "id")', [], []],
  ['$.a.xorBy($.b, "id")', [], [1, 2]],
  // a missing RECEIVER runs on `[]` (HR5), the reading lodash gives it
  ["$.a.isSubsetOf($.b)", true, false],
  ["$.a.isSupersetOf($.b)", true, true],
  ["$.a.isDisjointFrom($.b)", true, true],
  ["$.a.chunk(2)", [], [[1, 2]]],
  ["$.a.zipObject($.b)", {}, { 1: null, 2: null }],
  ["$.a.lastIndexOf(1)", -1, 0],
  ["$.a.dropRight(1)", [], [1]],
  ["$.a.initial()", [], [1]],
  ["$.o.pick($.b)", {}, {}],
  ["$.o.omit($.b)", {}, { x: 1 }],
  // a missing list ARGUMENT of a set operation is the empty list, as lodash reads it
  ["$.a.union($.b)", [], [1, 2]],
  ["$.a.intersection($.b)", [], []],
  ["$.a.symmetricDifference($.b)", [], [1, 2]],
  ["$.a.xor($.b)", [], [1, 2]],
  ["$.a.unionBy($.b, x => x)", [], [1, 2]],
];

/**
 * Every reader of an object, over a document that lacks the field.
 *
 * `$objectToArray` answers null for a missing field and `$arrayToObject` passes that
 * null on. HR5 decides the answer by the accessor the source spells:
 *
 *   - a method under a DOT runs on `{}`, so it answers `{}`, or `[]` where it answers an
 *     array — `_.pick(undefined, …)` is `{}`, `({}).keys()` is `[]`.
 *   - a `?.` with a call after it STOPS the chain, so the chain answers null.
 *
 * Each row: the source, and what it answers when the receiver is missing.
 */
const OBJECT_EMPTY: readonly (readonly [string, unknown])[] = [
  // lodash — the empty value, whatever the source spells
  ["$.o.mapValues(v => v * 2)", {}],
  ["$.o.mapKeys((v, k) => k)", {}],
  ['$.o.pick(["a"])', {}],
  ["$.o.pick($.keys)", {}],
  ['$.o.omit(["a"])', {}],
  ["$.o.pickBy(v => v != null)", {}],
  ["$.o.omitBy(v => v == null)", {}],
  ["$.o.invert()", {}],
  ["$.o.toPairs()", []],
  // an object method under a dot runs on `{}` (HR5)
  ["$.o.keys()", []],
  ["$.o.values()", []],
  ["$.o.entries()", []],
  // a `?.` with a call after it stops the chain, so the chain answers null
  ["$.o?.keys()", null],
  ["$.o?.values()", null],
  ["$.o?.entries()", null],
  ["$.o?.keys().size()", null],
  ["$.s?.trim().length()", null],
  ["$.a?.map(x => x).size()", null],
  // the `?.` tests `o`, and a call after it stops the chain
  ["$.o?.sub.keys()", null],
  // nothing runs after this `?.`, so the document and the answer are what they were
  ['$.first + " " + $.user?.last', "An "],
  // the root document is there, so it takes no neutral
  ["$.keys().size()", 2],
];

describe.skipIf(!up)("compiler/emit — a missing list is the empty list, never an aborted command", () => {
  let guarded: Collection;
  beforeAll(async () => {
    guarded = client!.db("jsmql_compiler_methods").collection("guarded");
    await guarded.deleteMany({});
    await guarded.insertMany([
      { _id: 1, first: "An" },
      { _id: 2, a: [1, 2], o: { x: 1 }, first: "An" },
    ]);
  });

  it("answers over a document that holds neither operand", async () => {
    const problems: string[] = [];
    let compared = 0;
    for (const [src, empty, listMissing] of GUARDED) {
      try {
        const docs = await guarded.aggregate([{ $addFields: { __v: expr(src) } }, { $sort: { _id: 1 } }]).toArray();
        expect([src, docs[0].__v], src).toEqual([src, empty]);
        expect([src, docs[1].__v], src).toEqual([src, listMissing]);
        compared++;
      } catch (e) {
        problems.push(`${src}\n  ${JSON.stringify(expr(src))}\n  ${(e as Error).message}`);
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
    expect(compared).toBe(GUARDED.length);
    // `.sample()` picks at random, so it is the one row whose answer is a membership. An
    // element of `[]` is MISSING on the server, so a missing `a` writes no field at all.
    const picked = await guarded
      .aggregate([{ $addFields: { __v: expr("$.a.sample()") } }, { $sort: { _id: 1 } }])
      .toArray();
    expect(picked[0]).not.toHaveProperty("__v");
    expect([1, 2]).toContain(picked[1].__v);
  });

  it("answers null or the empty value for a reader of an object, as the source spells it", async () => {
    const problems: string[] = [];
    let compared = 0;
    for (const [src, missing] of OBJECT_EMPTY) {
      try {
        const [doc] = await guarded.aggregate([{ $match: { _id: 1 } }, { $addFields: { __v: expr(src) } }]).toArray();
        expect([src, doc.__v], src).toEqual([src, missing]);
        compared++;
      } catch (e) {
        problems.push(`${src}\n  ${JSON.stringify(expr(src))}\n  ${(e as Error).message}`);
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
    expect(compared).toBe(OBJECT_EMPTY.length);
  });

  it("a `?.` guards the value before it alone, however many members follow it", async () => {
    // Document 1 has no `o`, so the chain stops with null. Document 2 holds `o` and no
    // `o.z`: the `?.` passes, and the dot rule runs `.uniq()` on `[]` (HR5).
    for (const src of ["$.o?.z.uniq()", "$.o?.z.w.uniq()"]) {
      const out = await guarded
        .aggregate([{ $addFields: { __v: expr(src) } }, { $project: { __v: 1 } }, { $sort: { _id: 1 } }])
        .toArray();
      expect([src, out]).toEqual([
        src,
        [
          { _id: 1, __v: null },
          { _id: 2, __v: [] },
        ],
      ]);
    }
  });
});

/**
 * `.concat()` against JavaScript's own `concat`, one document per kind of argument.
 *
 * JavaScript adds the elements of an array argument, and adds any other argument as one
 * element. A spread passes each element of its array as an argument of its own. MongoDB
 * has no `undefined`, so a missing argument adds null — `canonical` writes JavaScript's
 * `undefined` in an array as null too. JavaScript throws for a spread of a missing or a
 * null value; JSMQL spreads nothing there, as `[...$.b]` does. Those rows state the
 * answer instead of a JavaScript function.
 */
const CONCAT_DOCS = [
  { _id: 1, a: [1], b: [2] },
  { _id: 2, a: [1], b: 5 },
  { _id: 3, a: [1] },
  { _id: 4, a: [1], b: null },
  { _id: 5, a: [1], b: "xy" },
  { _id: 6, a: [1], b: [[2], 3] },
];
type ConcatDoc = { _id: number; a: number[]; b?: unknown };
const CONCAT: readonly (readonly [string, readonly number[], (d: ConcatDoc) => unknown])[] = [
  ["$.a.concat($.b, 1)", [1, 2, 3, 4, 5, 6], (d) => d.a.concat(d.b as number, 1)],
  ["$.a.concat(1, $.b)", [1, 2, 3, 4, 5, 6], (d) => d.a.concat(1, d.b as number)],
  [
    "$.a.concat($.b?.filter(x => true))",
    [1, 3, 4, 6],
    (d) => d.a.concat((d.b as number[] | undefined)?.filter(() => true) as number[]),
  ],
  ["$.a.concat(...$.b, 1)", [1, 6], (d) => d.a.concat(...(d.b as number[]), 1)],
  ["$.a.concat(...$.b, 1)", [3, 4], () => [1, 1]],
  ["$.a.concat(...$.b.map(x => [x]))", [1, 6], (d) => d.a.concat(...(d.b as number[]).map((x) => [x]))],
  ["$.a.concat(...[[2], 3])", [3], (d) => d.a.concat(...[[2], 3])],
];

describe.skipIf(!up)("compiler/emit — .concat() adds each argument as JavaScript does", () => {
  let docs: Collection;
  beforeAll(async () => {
    docs = client!.db("jsmql_compiler_methods").collection("concat");
    await docs.deleteMany({});
    await docs.insertMany(CONCAT_DOCS.map((d) => ({ ...d })));
  });

  it("answers what JavaScript answers for an array, a number, a string, null and a missing field", async () => {
    let compared = 0;
    for (const [src, ids, js] of CONCAT) {
      const got = await docs
        .aggregate([{ $match: { _id: { $in: ids } } }, { $addFields: { __v: expr(src) } }, { $sort: { _id: 1 } }])
        .toArray();
      const want = CONCAT_DOCS.filter((d) => ids.includes(d._id)).map((d) => js(d));
      expect([src, canonical(got.map((d) => d.__v))]).toEqual([src, canonical(want)]);
      compared++;
    }
    expect(compared).toBe(CONCAT.length);
  });
});

/**
 * The refusals that name a spelling to write instead of the refused one.
 *
 * The test reads the spelling out of the message itself, fills in its placeholder, and
 * runs the result. So a hint that aborts on a missing field fails here, and the hint
 * text cannot drift from the spelling this test proves.
 *
 * Each row: the refused source, the placeholder in its hint, and the text that fills it.
 */
const HINTS: readonly (readonly [string, string, string])[] = [
  ['$.s.split("")', "$.<field>", "$.s"],
  ["[...$.s.trim()]", "<string>", "$.s.trim()"],
  ["$.s.trim().uniq()", "<string>", "$.s.trim()"],
];

describe.skipIf(!up)("compiler/emit — the spelling a refusal names runs on every document", () => {
  let hinted: Collection;
  beforeAll(async () => {
    hinted = client!.db("jsmql_compiler_methods").collection("hinted");
    await hinted.deleteMany({});
    await hinted.insertMany([{ _id: 1 }, { _id: 2, s: null }, { _id: 3, s: "" }, { _id: 4, s: "abc" }]);
  });

  it("gives the characters of a string, and [] for an empty, a null or a missing field", async () => {
    for (const [refused, placeholder, fill] of HINTS) {
      let message = "";
      try {
        expr(refused);
      } catch (e) {
        message = (e as Error).message;
      }
      const hint = /write '([^']+)'/.exec(message)?.[1];
      expect(hint, `${refused} names no spelling: ${message}`).toBeDefined();
      const src = hint!.split(placeholder).join(fill);
      const docs = await hinted.aggregate([{ $addFields: { __v: expr(src) } }, { $sort: { _id: 1 } }]).toArray();
      // JavaScript throws for a missing or a null receiver; the spelling answers the empty list
      expect([src, docs.map((d) => d.__v)]).toEqual([src, [[], [], "".split(""), "abc".split("")]]);
    }
  });
});

describe("compiler/emit — the server answers each method as JavaScript would", () => {
  it("ran each one, or none", async () => {
    // The cases above register their sources whether a server runs or not.
    expect(RUNS.length).toBeGreaterThan(0);
    if (coll === null) return;
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

/**
 * The `neverNull` and `readsNullAsEmpty` facts of the JavaScript rows, measured.
 *
 * The presence proof reads these facts to leave out an `$ifNull`, so a wrong claim gives
 * a wrong answer. A row that states `neverNull` answers a value, never null or missing,
 * over inputs that are there. A row that states `"always"` also answers a value when each
 * ARGUMENT is missing. A row that states `readsNullAsEmpty` answers a missing receiver
 * exactly as it answers the empty value of its family.
 *
 * Each row: a source over inputs that are there, and for `"always"` the same call with
 * each argument missing.
 */
const NEVER_NULL: Readonly<Record<string, readonly [string, string?]>> = {
  // strings
  trim: ["$.s.trim()"],
  trimStart: ["$.s.trimStart()"],
  trimLeft: ["$.s.trimLeft()"],
  trimEnd: ["$.s.trimEnd()"],
  trimRight: ["$.s.trimRight()"],
  toLowerCase: ["$.s.toLowerCase()"],
  toUpperCase: ["$.s.toUpperCase()"],
  substr: ["$.csv.substr(1)"],
  substring: ["$.csv.substring(1)"],
  charAt: ["$.csv.charAt(0)"],
  split: ['$.csv.split(",")'],
  startsWith: ['$.csv.startsWith("a")'],
  endsWith: ['$.csv.endsWith("c")'],
  replace: ['$.csv.replace("a", "x")'],
  replaceAll: ['$.csv.replaceAll(",", ";")'],
  matchAll: ["$.csv.matchAll(/[a-c]/g)"],
  search: ["$.csv.search(/z/)"],
  padStart: ["$.csv.padStart(9)"],
  padEnd: ["$.csv.padEnd(9)"],
  repeat: ["$.csv.repeat(2)"],
  indexOf: ["$.a.indexOf(9)"],
  indexOfSubstring: ['$.csv.indexOfSubstring("b")'],
  includes: ['$.csv.includes("b")'],
  lastIndexOf: ["$.a.lastIndexOf(9)"],
  length: ["$.csv.length()"],
  toString: ["$.n.toString()"],
  capitalize: ["$.w.capitalize()"],
  upperFirst: ["$.w.upperFirst()"],
  lowerFirst: ["$.w.lowerFirst()"],
  words: ["$.w.words()"],
  kebabCase: ["$.w.kebabCase()"],
  snakeCase: ["$.w.snakeCase()"],
  lowerCase: ["$.w.lowerCase()"],
  upperCase: ["$.w.upperCase()"],
  startCase: ["$.w.startCase()"],
  camelCase: ["$.w.camelCase()"],
  escape: ["$.h.escape()"],
  truncate: ["$.w.truncate({ length: 5 })"],
  test: ["/l/.test($.s)", "/l/.test($.nope)"],
  // arrays
  has: ["$.a.has(3)", "$.a.has($.nope)"],
  slice: ["$.a.slice(1)"],
  concat: ["$.a.concat($.b)", "$.a.concat($.nope)"],
  toReversed: ["$.a.toReversed()"],
  toSorted: ["$.a.toSorted()"],
  sortBy: ["$.a.sortBy()"],
  orderBy: ['$.docs.orderBy(["v"], ["desc"])'],
  toSpliced: ["$.a.toSpliced(0, 1)"],
  with: ["$.a.with(0, 9)"],
  flat: ["$.nested.flat()"],
  flatMap: ["$.a.flatMap(x => [x, x])"],
  map: ["$.a.map(x => x * 2)"],
  filter: ["$.a.filter(x => x > 1)"],
  findIndex: ["$.a.findIndex(x => x > 9)"],
  findLastIndex: ["$.a.findLastIndex(x => x > 9)"],
  some: ["$.a.some(x => x > 2)"],
  every: ["$.a.every(x => x > 2)"],
  join: ['$.a.join("-")'],
  size: ["$.a.size()"],
  sum: ["$.a.sum()"],
  sumBy: ['$.docs.sumBy("v")'],
  uniq: ["$.dup.uniq()"],
  uniqBy: ["$.dup.uniqBy(x => x)"],
  sortedUniq: ["$.dup.sortedUniq()"],
  sortedUniqBy: ["$.dup.sortedUniqBy(x => x)"],
  without: ["$.a.without(3)", "$.a.without($.nope)"],
  xor: ["$.a.xor($.b)", "$.a.xor($.nope)"],
  union: ["$.a.union($.b)", "$.a.union($.nope)"],
  intersection: ["$.a.intersection($.b)", "$.a.intersection($.nope)"],
  difference: ["$.a.difference($.b)", "$.a.difference($.nope)"],
  symmetricDifference: ["$.a.symmetricDifference($.b)", "$.a.symmetricDifference($.nope)"],
  unionBy: ["$.a.unionBy($.b, x => x)", "$.a.unionBy($.nope, x => x)"],
  intersectionBy: ["$.a.intersectionBy($.b, x => x)", "$.a.intersectionBy($.nope, x => x)"],
  differenceBy: ["$.a.differenceBy($.b, x => x)", "$.a.differenceBy($.nope, x => x)"],
  xorBy: ["$.a.xorBy($.b, x => x)", "$.a.xorBy($.nope, x => x)"],
  isSubsetOf: ["$.a.isSubsetOf($.b)", "$.a.isSubsetOf($.nope)"],
  isSupersetOf: ["$.a.isSupersetOf($.b)", "$.a.isSupersetOf($.nope)"],
  isDisjointFrom: ["$.a.isDisjointFrom($.b)", "$.a.isDisjointFrom($.nope)"],
  compact: ["$.mixed.compact()"],
  flatten: ["$.nested.flatten()"],
  chunk: ["$.a.chunk(2)"],
  take: ["$.a.take(2)"],
  drop: ["$.a.drop(1)"],
  takeRight: ["$.a.takeRight(2)"],
  dropRight: ["$.a.dropRight(1)"],
  tail: ["$.a.tail()"],
  initial: ["$.a.initial()"],
  takeWhile: ["$.a.takeWhile(x => x > 2)"],
  dropWhile: ["$.a.dropWhile(x => x > 2)"],
  takeRightWhile: ["$.a.takeRightWhile(x => x > 1)"],
  dropRightWhile: ["$.a.dropRightWhile(x => x > 1)"],
  sampleSize: ["$.a.sampleSize(2)"],
  zipObject: ["$.keys.zipObject($.a)", "$.keys.zipObject($.nope)"],
  zip: ["$.a.zip($.b)"],
  unzip: ["$.nested.unzip()"],
  zipWith: ["$.a.zipWith($.b, (x, y) => x + y)"],
  keyBy: ['$.docs.keyBy("k")'],
  groupBy: ['$.docs.groupBy("k")'],
  countBy: ['$.docs.countBy("k")'],
  partition: ["$.a.partition(x => x > 1)"],
  reject: ["$.a.reject(x => x > 1)"],
  fromPairs: ["$.pairs.fromPairs()"],
  fromEntries: ["$.pairs.fromEntries()"],
  // objects
  entries: ["$.o.entries()"],
  keys: ["$.o.keys()"],
  values: ["$.o.values()"],
  mapValues: ["$.o.mapValues(v => v * 2)"],
  mapKeys: ["$.o.mapKeys((v, k) => k)"],
  pick: ['$.o.pick(["a"])'],
  omit: ['$.o.omit(["a"])'],
  pickBy: ["$.o.pickBy(v => v > 1)"],
  omitBy: ["$.o.omitBy(v => v > 1)"],
  invert: ["$.o.invert()"],
  toPairs: ["$.o.toPairs()"],
  assign: ["$.o.assign({ z: 1 })", "$.o.assign($.nope)"],
  // numbers and Math
  clamp: ["$.n.clamp(0, 5)"],
  inRange: ["$.n.inRange(0, 10)"],
  range: ["$.neg.range()", "$.neg.range($.nope)"],
  rangeRight: ["$.neg.rangeRight()", "$.neg.rangeRight($.nope)"],
  round: ["$.n.round(1)"],
  ceil: ["$.n.ceil()"],
  floor: ["$.n.floor()"],
  abs: ["$.neg.abs()"],
  sqrt: ["$.n.sqrt()"],
  exp: ["$.neg.exp()"],
  log: ["$.n.log()"],
  log2: ["$.n.log2()"],
  log10: ["$.n.log10()"],
  trunc: ["$.n.trunc()"],
  sign: ["$.neg.sign()", "$.nope.sign()"],
  cbrt: ["$.neg.cbrt()"],
  sin: ["$.n.sin()"],
  cos: ["$.n.cos()"],
  tan: ["$.n.tan()"],
  asin: ["(0.5).asin()"],
  acos: ["(0.5).acos()"],
  atan: ["$.n.atan()"],
  sinh: ["(1).sinh()"],
  cosh: ["(1).cosh()"],
  tanh: ["$.n.tanh()"],
  asinh: ["$.n.asinh()"],
  acosh: ["$.n.acosh()"],
  atanh: ["(0.5).atanh()"],
  atan2: ["$.n.atan2(1)"],
  hypot: ["$.n.hypot(1)"],
  random: ["(1).random(6)", "$.nope.random($.nope)"],
  PI: ["Math.PI"],
  E: ["Math.E"],
  isInteger: ["Number.isInteger($.n)", "Number.isInteger($.nope)"],
  isNaN: ["Number.isNaN($.n)", "Number.isNaN($.nope)"],
  isArray: ["Array.isArray($.a)", "Array.isArray($.nope)"],
  // dates
  getFullYear: ["$.d.getFullYear()"],
  getMonth: ["$.d.getMonth()"],
  getDate: ["$.d.getDate()"],
  getDay: ["$.d.getDay()"],
  getHours: ["$.d.getHours()"],
  getMinutes: ["$.d.getMinutes()"],
  getSeconds: ["$.d.getSeconds()"],
  getMilliseconds: ["$.d.getMilliseconds()"],
  getUTCFullYear: ["$.d.getUTCFullYear()"],
  getUTCMonth: ["$.d.getUTCMonth()"],
  getUTCDate: ["$.d.getUTCDate()"],
  getUTCDay: ["$.d.getUTCDay()"],
  getUTCHours: ["$.d.getUTCHours()"],
  getUTCMinutes: ["$.d.getUTCMinutes()"],
  getUTCSeconds: ["$.d.getUTCSeconds()"],
  getUTCMilliseconds: ["$.d.getUTCMilliseconds()"],
  getTime: ["$.d.getTime()"],
  toISOString: ["$.d.toISOString()"],
  plus: ['$.d.plus(1, "day")'],
  minus: ['$.d.minus(1, "day")'],
  diff: ['$.d.diff($.e, "day")'],
  startOf: ['$.d.startOf("month")'],
  endOf: ['$.d.endOf("month")'],
  format: ['$.d.format("%Y")'],
  week: ["$.d.week()"],
  isoWeek: ["$.d.isoWeek()"],
  isoWeekYear: ["$.d.isoWeekYear()"],
  isoWeekday: ["$.d.isoWeekday()"],
  dayOfYear: ["$.d.dayOfYear()"],
  quarter: ["$.d.quarter()"],
  isSame: ['$.d.isSame($.e, "month")'],
  isBefore: ['$.d.isBefore($.e, "month")'],
  isAfter: ['$.d.isAfter($.e, "month")'],
  set: ["$.d.set({ year: 2030 })"],
  now: ["Date.now()"],
  UTC: ["Date.UTC(2020, 1, 1)"],
  // the globals
  String: ["String($.n)"],
  Boolean: ["Boolean($.n)", "Boolean($.nope)"],
  Number: ["Number($.n)"],
  ObjectId: ["ObjectId()"],
  Date: ["Date($.d)"],
  ISODate: ["ISODate($.d)"],
  Decimal128: ["Decimal128($.n)"],
  Long: ["Long($.neg)"],
  Int32: ["Int32($.neg)"],
  Double: ["Double($.n)"],
  UUID: ['UUID($.csv.replace("a,b,c", "6ac24965-7917-4323-8d44-920ad1d69b94"))'],
  NumberDecimal: ["NumberDecimal($.n)"],
  NumberLong: ["NumberLong($.neg)"],
  NumberInt: ["NumberInt($.neg)"],
  MinKey: ["MinKey()"],
  MaxKey: ["MaxKey()"],
};

/** Each row: the call on a receiver the document lacks, and the same call on the empty value. */
const NULL_AS_EMPTY: Readonly<Record<string, readonly [string, string]>> = {
  sum: ["$.nope.sum()", "[].sum()"],
  mean: ["$.nope.mean()", "[].mean()"],
  max: ["$.nope.max()", "[].max()"],
  min: ["$.nope.min()", "[].min()"],
  join: ['$.nope.join(",")', '[].join(",")'],
  sumBy: ['$.nope.sumBy("v")', '[].sumBy("v")'],
  meanBy: ['$.nope.meanBy("v")', '[].meanBy("v")'],
  assign: ["$.nope.assign({ z: 1 })", "({}).assign({ z: 1 })"],
};

/** Each row that states `nullReceiverAs`: the call on a missing receiver, and the same call on the stated value. */
const NULL_RECEIVER_AS: Readonly<Record<string, readonly [string, string]>> = {
  range: ["$.nope.range($.neg)", "(0).range($.neg)"],
  rangeRight: ["$.nope.rangeRight($.neg)", "(0).rangeRight($.neg)"],
  sign: ["$.nope.sign()", "(0).sign()"],
  toString: ["$.nope.toString()", '"".toString()'],
  random: ["$.nope.random(0)", "(0).random(0)"],
};

/**
 * Each row that states `passesNull` has two cases: a call after a `?.` on a receiver the
 * document lacks, and the same call on a receiver that holds null. Each answers null with
 * no `$cond` test.
 */
const PASSES_NULL: Readonly<Record<string, readonly [string, string]>> = {
  keys: ["$.nope?.keys()", "$.mo.d?.keys()"],
  values: ["$.nope?.values()", "$.mo.d?.values()"],
  entries: ["$.nope?.entries()", "$.mo.d?.entries()"],
  fromEntries: ["$.nope?.fromEntries()", "$.mo.d?.fromEntries()"],
  max: ["$.nope?.max()", "$.mo.d?.max()"],
  min: ["$.nope?.min()", "$.mo.d?.min()"],
  round: ["$.nope?.round(2)", "$.mo.d?.round()"],
  ceil: ["$.nope?.ceil(1)", "$.mo.d?.ceil()"],
  floor: ["$.nope?.floor(1)", "$.mo.d?.floor()"],
  slice: ["$.nope?.slice(1)", "$.mo.d?.slice(1, 2)"],
  concat: ["$.nope?.concat($.b)", "$.mo.d?.concat([1])"],
  toString: ["$.nope?.toString()", "$.mo.d?.toString()"],
  trim: ["$.nope?.trim()", "$.mo.d?.trim()"],
  trimStart: ["$.nope?.trimStart()", "$.mo.d?.trimStart()"],
  trimLeft: ["$.nope?.trimLeft()", "$.mo.d?.trimLeft()"],
  trimEnd: ["$.nope?.trimEnd()", "$.mo.d?.trimEnd()"],
  trimRight: ["$.nope?.trimRight()", "$.mo.d?.trimRight()"],
  split: ['$.nope?.split(",")', '$.mo.d?.split(",")'],
  indexOfSubstring: ['$.nope?.indexOfSubstring("b")', '$.mo.d?.indexOfSubstring("b")'],
  replace: ['$.nope?.replace("a", "x")', '$.mo.d?.replace("a", "x")'],
  replaceAll: ['$.nope?.replaceAll(",", ";")', '$.mo.d?.replaceAll(",", ";")'],
  padEnd: ["$.nope?.padEnd(9)", "$.mo.d?.padEnd(9)"],
  repeat: ["$.nope?.repeat(2)", "$.mo.d?.repeat(2)"],
  escape: ["$.nope?.escape()", "$.mo.d?.escape()"],
  toReversed: ["$.nope?.toReversed()", "$.mo.d?.toReversed()"],
  toSorted: ["$.nope?.toSorted()", "$.mo.d?.toSorted()"],
  sortBy: ["$.nope?.sortBy()", "$.mo.d?.sortBy()"],
  orderBy: ['$.nope?.orderBy(["v"], ["desc"])', '$.mo.d?.orderBy(["v"], ["desc"])'],
  toSpliced: ["$.nope?.toSpliced(0, 1)", "$.mo.d?.toSpliced(0, 1)"],
  with: ["$.nope?.with(0, 9)", "$.mo.d?.with(0, 9)"],
  flat: ["$.nope?.flat()", "$.mo.d?.flat()"],
  flatMap: ["$.nope?.flatMap(x => [x, x])", "$.mo.d?.flatMap(x => [x, x])"],
  map: ["$.nope?.map(x => x * 2)", "$.mo.d?.map(x => x * 2)"],
  filter: ["$.nope?.filter(x => x > 1)", "$.mo.d?.filter(x => x > 1)"],
  uniq: ["$.nope?.uniq()", "$.mo.d?.uniq()"],
  uniqBy: ["$.nope?.uniqBy(x => x)", "$.mo.d?.uniqBy(x => x)"],
  sortedUniq: ["$.nope?.sortedUniq()", "$.mo.d?.sortedUniq()"],
  sortedUniqBy: ["$.nope?.sortedUniqBy(x => x)", "$.mo.d?.sortedUniqBy(x => x)"],
  without: ["$.nope?.without(3)", "$.mo.d?.without(3)"],
  xor: ["$.nope?.xor($.b)", "$.mo.d?.xor($.b)"],
  union: ["$.nope?.union($.b)", "$.mo.d?.union($.b)"],
  intersection: ["$.nope?.intersection($.b)", "$.mo.d?.intersection($.b)"],
  difference: ["$.nope?.difference($.b)", "$.mo.d?.difference($.b)"],
  symmetricDifference: ["$.nope?.symmetricDifference($.b)", "$.mo.d?.symmetricDifference($.b)"],
  unionBy: ["$.nope?.unionBy($.b, x => x)", "$.mo.d?.unionBy($.b, x => x)"],
  intersectionBy: ["$.nope?.intersectionBy($.b, x => x)", "$.mo.d?.intersectionBy($.b, x => x)"],
  differenceBy: ["$.nope?.differenceBy($.b, x => x)", "$.mo.d?.differenceBy($.b, x => x)"],
  xorBy: ["$.nope?.xorBy($.b, x => x)", "$.mo.d?.xorBy($.b, x => x)"],
  compact: ["$.nope?.compact()", "$.mo.d?.compact()"],
  flatten: ["$.nope?.flatten()", "$.mo.d?.flatten()"],
  take: ["$.nope?.take(2)", "$.mo.d?.take(2)"],
  drop: ["$.nope?.drop(1)", "$.mo.d?.drop(1)"],
  takeRight: ["$.nope?.takeRight(2)", "$.mo.d?.takeRight(2)"],
  tail: ["$.nope?.tail()", "$.mo.d?.tail()"],
  takeWhile: ["$.nope?.takeWhile(x => x > 2)", "$.mo.d?.takeWhile(x => x > 2)"],
  dropWhile: ["$.nope?.dropWhile(x => x > 2)", "$.mo.d?.dropWhile(x => x > 2)"],
  takeRightWhile: ["$.nope?.takeRightWhile(x => x > 1)", "$.mo.d?.takeRightWhile(x => x > 1)"],
  dropRightWhile: ["$.nope?.dropRightWhile(x => x > 1)", "$.mo.d?.dropRightWhile(x => x > 1)"],
  sampleSize: ["$.nope?.sampleSize(2)", "$.mo.d?.sampleSize(2)"],
  zip: ["$.nope?.zip($.b)", "$.mo.d?.zip($.b)"],
  zipWith: ["$.nope?.zipWith($.b, (x, y) => x + y)", "$.mo.d?.zipWith($.b, (x, y) => x + y)"],
  keyBy: ['$.nope?.keyBy("k")', '$.mo.d?.keyBy("k")'],
  groupBy: ['$.nope?.groupBy("k")', '$.mo.d?.groupBy("k")'],
  countBy: ['$.nope?.countBy("k")', '$.mo.d?.countBy("k")'],
  reject: ["$.nope?.reject(x => x > 1)", "$.mo.d?.reject(x => x > 1)"],
  fromPairs: ["$.nope?.fromPairs()", "$.mo.d?.fromPairs()"],
  mapValues: ["$.nope?.mapValues(v => v * 2)", "$.mo.d?.mapValues(v => v * 2)"],
  mapKeys: ["$.nope?.mapKeys((v, k) => k)", "$.mo.d?.mapKeys((v, k) => k)"],
  omit: ['$.nope?.omit(["a"])', '$.mo.d?.omit(["a"])'],
  pickBy: ["$.nope?.pickBy(v => v > 1)", "$.mo.d?.pickBy(v => v > 1)"],
  omitBy: ["$.nope?.omitBy(v => v > 1)", "$.mo.d?.omitBy(v => v > 1)"],
  invert: ["$.nope?.invert()", "$.mo.d?.invert()"],
  toPairs: ["$.nope?.toPairs()", "$.mo.d?.toPairs()"],
  getFullYear: ["$.nope?.getFullYear()", "$.mo.d?.getFullYear()"],
  getMonth: ["$.nope?.getMonth()", "$.mo.d?.getMonth()"],
  getDate: ["$.nope?.getDate()", "$.mo.d?.getDate()"],
  getDay: ["$.nope?.getDay()", "$.mo.d?.getDay()"],
  getHours: ["$.nope?.getHours()", "$.mo.d?.getHours()"],
  getMinutes: ["$.nope?.getMinutes()", "$.mo.d?.getMinutes()"],
  getSeconds: ["$.nope?.getSeconds()", "$.mo.d?.getSeconds()"],
  getMilliseconds: ["$.nope?.getMilliseconds()", "$.mo.d?.getMilliseconds()"],
  getUTCFullYear: ["$.nope?.getUTCFullYear()", "$.mo.d?.getUTCFullYear()"],
  getUTCMonth: ["$.nope?.getUTCMonth()", "$.mo.d?.getUTCMonth()"],
  getUTCDate: ["$.nope?.getUTCDate()", "$.mo.d?.getUTCDate()"],
  getUTCDay: ["$.nope?.getUTCDay()", "$.mo.d?.getUTCDay()"],
  getUTCHours: ["$.nope?.getUTCHours()", "$.mo.d?.getUTCHours()"],
  getUTCMinutes: ["$.nope?.getUTCMinutes()", "$.mo.d?.getUTCMinutes()"],
  getUTCSeconds: ["$.nope?.getUTCSeconds()", "$.mo.d?.getUTCSeconds()"],
  getUTCMilliseconds: ["$.nope?.getUTCMilliseconds()", "$.mo.d?.getUTCMilliseconds()"],
  getTime: ["$.nope?.getTime()", "$.mo.d?.getTime()"],
  toISOString: ["$.nope?.toISOString()", "$.mo.d?.toISOString()"],
  plus: ['$.nope?.plus(1, "day")', '$.mo.d?.plus(1, "day")'],
  minus: ['$.nope?.minus(1, "day")', '$.mo.d?.minus(1, "day")'],
  diff: ['$.nope?.diff($.e, "day")', '$.mo.d?.diff($.e, "day")'],
  startOf: ['$.nope?.startOf("month")', '$.mo.d?.startOf("month")'],
  endOf: ['$.nope?.endOf("month")', '$.mo.d?.endOf("month")'],
  format: ['$.nope?.format("%Y")', '$.mo.d?.format("%Y")'],
  week: ["$.nope?.week()", "$.mo.d?.week()"],
  isoWeek: ["$.nope?.isoWeek()", "$.mo.d?.isoWeek()"],
  isoWeekYear: ["$.nope?.isoWeekYear()", "$.mo.d?.isoWeekYear()"],
  isoWeekday: ["$.nope?.isoWeekday()", "$.mo.d?.isoWeekday()"],
  dayOfYear: ["$.nope?.dayOfYear()", "$.mo.d?.dayOfYear()"],
  quarter: ["$.nope?.quarter()", "$.mo.d?.quarter()"],
  set: ["$.nope?.set({ year: 2030 })", "$.mo.d?.set({ year: 2030 })"],
  abs: ["$.nope?.abs()", "$.mo.d?.abs()"],
  sqrt: ["$.nope?.sqrt()", "$.mo.d?.sqrt()"],
  exp: ["$.nope?.exp()", "$.mo.d?.exp()"],
  log: ["$.nope?.log(2)", "$.mo.d?.log(2)"],
  log2: ["$.nope?.log2()", "$.mo.d?.log2()"],
  log10: ["$.nope?.log10()", "$.mo.d?.log10()"],
  trunc: ["$.nope?.trunc()", "$.mo.d?.trunc()"],
  cbrt: ["$.nope?.cbrt()", "$.mo.d?.cbrt()"],
  sin: ["$.nope?.sin()", "$.mo.d?.sin()"],
  cos: ["$.nope?.cos()", "$.mo.d?.cos()"],
  tan: ["$.nope?.tan()", "$.mo.d?.tan()"],
  asin: ["$.nope?.asin()", "$.mo.d?.asin()"],
  acos: ["$.nope?.acos()", "$.mo.d?.acos()"],
  atan: ["$.nope?.atan()", "$.mo.d?.atan()"],
  sinh: ["$.nope?.sinh()", "$.mo.d?.sinh()"],
  cosh: ["$.nope?.cosh()", "$.mo.d?.cosh()"],
  tanh: ["$.nope?.tanh()", "$.mo.d?.tanh()"],
  asinh: ["$.nope?.asinh()", "$.mo.d?.asinh()"],
  acosh: ["$.nope?.acosh()", "$.mo.d?.acosh()"],
  atanh: ["$.nope?.atanh()", "$.mo.d?.atanh()"],
  atan2: ["$.nope?.atan2($.n)", "$.mo.d?.atan2($.n)"],
  hypot: ["$.nope?.hypot(1)", "$.mo.d?.hypot(1)"],
};

describe("registry — every `neverNull` and `readsNullAsEmpty` claim has a measurement", () => {
  type Row = {
    kind?: string;
    neverNull?: true | "always";
    readsNullAsEmpty?: true;
    nullReceiverAs?: 0 | "";
    passesNull?: true;
  };
  const rows = Object.entries(NAMES) as [string, Row][];
  const own = (r: Row) => r.kind === "name" || r.kind === "global";

  it("measures exactly the rows that state `neverNull`, each with its strength", () => {
    const stating = rows.filter(([, r]) => own(r) && r.neverNull !== undefined).map(([n]) => n);
    expect([...stating].sort()).toEqual(Object.keys(NEVER_NULL).sort());
    const wrong = rows
      .filter(([n, r]) => own(r) && r.neverNull !== undefined)
      .filter(([n, r]) => (r.neverNull === "always") !== (NEVER_NULL[n]?.[1] !== undefined))
      .map(([n]) => n);
    expect(wrong, "a row that states `always` takes a second source, and only such a row").toEqual([]);
  });

  it("measures exactly the rows that state `readsNullAsEmpty`", () => {
    const stating = rows.filter(([, r]) => own(r) && r.readsNullAsEmpty === true).map(([n]) => n);
    expect([...stating].sort()).toEqual(Object.keys(NULL_AS_EMPTY).sort());
  });

  it("measures exactly the rows that state `passesNull`", () => {
    const stating = rows.filter(([, r]) => own(r) && r.passesNull === true).map(([n]) => n);
    expect([...stating].sort()).toEqual(Object.keys(PASSES_NULL).sort());
  });

  it("measures exactly the rows that state `nullReceiverAs`", () => {
    const stating = rows.filter(([, r]) => own(r) && r.nullReceiverAs !== undefined).map(([n]) => n);
    expect([...stating].sort()).toEqual(Object.keys(NULL_RECEIVER_AS).sort());
  });
});

describe.skipIf(!up)("registry — every `neverNull` and `readsNullAsEmpty` claim holds on the server", () => {
  /** The `$type` of what `src` answers over the document, or the server's refusal. */
  const typeOf = async (src: string): Promise<string> => {
    const docs = await coll!
      .aggregate([{ $addFields: { __v: expr(src) } }, { $project: { t: { $type: "$__v" } } }])
      .toArray();
    return docs[0].t as string;
  };

  it("answers a value, and for `always` a value over missing arguments too", async () => {
    const wrong: string[] = [];
    for (const [row, [there, missing]] of Object.entries(NEVER_NULL)) {
      for (const src of missing === undefined ? [there] : [there, missing]) {
        const t = await typeOf(src);
        if (t === "null" || t === "missing") wrong.push(`${row}: ${src} → ${t}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("answers a missing receiver as the empty value of its family", async () => {
    const wrong: string[] = [];
    for (const [row, [onMissing, onEmpty]] of Object.entries(NULL_AS_EMPTY)) {
      // `$addFields`, not `$project`: a folded `0` there would read as an exclusion flag
      const answer = async (src: string) =>
        canonical(
          (
            await coll!.aggregate([{ $addFields: { __v: expr(src) } }, { $project: { _id: 0, v: "$__v" } }]).toArray()
          )[0],
        );
      const [a, b] = [await answer(onMissing), await answer(onEmpty)];
      if (a !== b) wrong.push(`${row}: ${onMissing} → ${a}, ${onEmpty} → ${b}`);
      // and the compiler leaves the `$ifNull` out, which is the reason for the fact
      if (JSON.stringify(expr(onMissing)).includes('"$ifNull":["$nope"'))
        wrong.push(`${row}: ${onMissing} still wraps its receiver`);
    }
    expect(wrong).toEqual([]);
  });

  it("answers null after a `?.` with no null test, for each row that states `passesNull`", async () => {
    const wrong: string[] = [];
    for (const [row, sources] of Object.entries(PASSES_NULL)) {
      for (const src of sources) {
        // the `?.` null test stands at the top of the chain; a `$cond` inside the body is the row's own
        if (JSON.stringify(expr(src)).startsWith('{"$cond":[{"$lte":['))
          wrong.push(`${row}: ${src} still tests its receiver`);
        const docs = await coll!
          .aggregate([{ $addFields: { __v: expr(src) } }, { $project: { _id: 0, v: "$__v" } }])
          .toArray();
        if (docs[0].v !== null && docs[0].v !== undefined) wrong.push(`${row}: ${src} → ${canonical(docs[0])}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("answers a missing receiver as the value that `nullReceiverAs` states", async () => {
    const wrong: string[] = [];
    const answer = async (src: string) =>
      canonical(
        (await coll!.aggregate([{ $addFields: { __v: expr(src) } }, { $project: { _id: 0, v: "$__v" } }]).toArray())[0],
      );
    for (const [row, [onMissing, onStated]] of Object.entries(NULL_RECEIVER_AS)) {
      const [a, b] = [await answer(onMissing), await answer(onStated)];
      if (a !== b) wrong.push(`${row}: ${onMissing} → ${a}, ${onStated} → ${b}`);
    }
    expect(wrong).toEqual([]);
  });
});

/**
 * Each production that states `passesNull`: an expression with a `?.` read as its operand,
 * over a document that has no `b`. The read takes no `$ifNull`, and the answer is the one
 * the wrapped read gives.
 */
const PRODUCTION_PASSES_NULL: Readonly<Record<string, readonly [src: string, wrapped: unknown]>> = {
  addition: ["$.nob?.c + 1", { $add: [{ $ifNull: ["$nob.c", null] }, 1] }],
  subtraction: ["$.nob?.c - 1", { $subtract: [{ $ifNull: ["$nob.c", null] }, 1] }],
  multiplication: ["$.nob?.c * 2", { $multiply: [{ $ifNull: ["$nob.c", null] }, 2] }],
  division: ["$.nob?.c / 2", { $divide: [{ $ifNull: ["$nob.c", null] }, 2] }],
  remainder: ["$.nob?.c % 2", { $mod: [{ $ifNull: ["$nob.c", null] }, 2] }],
  exponentiation: ["$.nob?.c ** 2", { $pow: [{ $ifNull: ["$nob.c", null] }, 2] }],
  negation: ["-$.nob?.c", { $multiply: [{ $ifNull: ["$nob.c", null] }, -1] }],
  nullishCoalescing: ["$.nob?.c ?? 0", { $ifNull: [{ $ifNull: ["$nob.c", null] }, 0] }],
};

describe("registry — every production that states `passesNull` has a measurement", () => {
  it("measures exactly the productions that state it", () => {
    const stating = Object.entries(PRODUCTIONS)
      .filter(([, p]) => (p as { passesNull?: true }).passesNull === true)
      .map(([k]) => k);
    expect([...stating].sort()).toEqual(Object.keys(PRODUCTION_PASSES_NULL).sort());
  });
});

describe.skipIf(!up)("registry — a production that states `passesNull` answers as the wrapped read", () => {
  it("emits no `$ifNull` for the `?.` read, and the server gives the same answer", async () => {
    const wrong: string[] = [];
    const answer = async (e: unknown) =>
      canonical(
        (await coll!.aggregate([{ $addFields: { __v: e } }, { $project: { _id: 0, v: "$__v" } }]).toArray())[0],
      );
    for (const [key, [src, wrapped]] of Object.entries(PRODUCTION_PASSES_NULL)) {
      const got = expr(src);
      if (JSON.stringify(got).includes('"$ifNull":["$nob.c",null]')) wrong.push(`${key}: ${src} still wraps the read`);
      const [a, b] = [await answer(got), await answer(wrapped)];
      if (a !== b) wrong.push(`${key}: ${src} → ${a}, wrapped → ${b}`);
    }
    expect(wrong).toEqual([]);
  });
});

/**
 * This test checks `.random()` against lodash's `_.random`. It checks the range, both ends
 * for two whole bounds, and the form of the answer. Each source runs 400 times on the server.
 */
const RANDOMS: readonly (readonly [src: string, lo: number, hi: number, whole: boolean])[] = [
  ["(1).random(6)", 1, 6, true],
  ["(6).random(1)", 1, 6, true],
  ["(5).random()", 0, 5, true],
  ["(1.5).random(2)", 1.5, 2, false],
  ["$.neg.random(3)", -3, 3, true],
  ["$.neg.random($.n)", -3, 7.256, false],
  ["$.nope.random(4)", 0, 4, true],
  ["$.n.random()", 0, 7.256, false],
];

describe.skipIf(!up)("compiler/emit — `.random()` gives lodash's range on the server", () => {
  it("stays in range, reaches each whole end, and is whole only for two whole bounds", async () => {
    const wrong: string[] = [];
    for (const [src, lo, hi, whole] of RANDOMS) {
      const [d] = await coll!
        .aggregate([{ $project: { _id: 0, v: { $map: { input: { $range: [0, 400] }, in: expr(src) } } } }])
        .toArray();
      const v = d.v as number[];
      if (v.some((x) => x < lo || x > hi)) wrong.push(`${src}: a value is out of [${lo}, ${hi}]`);
      if (v.every(Number.isInteger) !== whole) wrong.push(`${src}: whole is ${!whole}`);
      if (whole && (!v.includes(lo) || !v.includes(hi))) wrong.push(`${src}: an end never appears`);
    }
    expect(wrong).toEqual([]);
  });
});

/**
 * Each `$ifNull` the compiler emits changes an answer on some document.
 *
 * The test drops one guard at a time, keeps the value it guarded, and runs both documents
 * over fields that are missing, null, empty, set, or of another type. When no answer
 * changes, the guard was dead: the presence proof, a row's `neverNull` or its
 * `readsNullAsEmpty` did not know that the value is there. Each source is a case where a
 * value is there although a field it reads may be missing.
 */
const GUARD_FREE: readonly string[] = [
  "$.a.intersection($.b).size()",
  "$.a.union($.b).map(x => x * 2)",
  "$.a.symmetricDifference($.b).size()",
  "$.a.concat($.b).size()",
  "$.z.union($.a.uniq())",
  "$.z.union($.a?.b)",
  "$.z.isSubsetOf($.a.map(x => x))",
  "$.a.sum()",
  "$.a.mean()",
  "$.a.max()",
  '$.a.join(",")',
  '$.a.sumBy("v")',
  "$.o.mapValues(v => v).keys()",
  "$.o.assign({ z: 1 }).keys()",
  "({}).assign($.o).keys()",
  "$.s.substring(1)",
  "$.s.substr(-3)",
  "$.x = $.a.intersection($.b); $.y = $.x.size();",
];

describe.skipIf(!up)("compiler/emit — no `$ifNull` guards a value that is there", () => {
  let guards: Collection;
  const DOCS = [
    { _id: 1 },
    { _id: 2, a: null, b: null, z: null, s: null, o: null },
    { _id: 3, a: [3, 1, 3, 2], b: [2, 4], z: [9, 1], s: "a,b c", o: { a: 1, b: "x" } },
    { _id: 4, a: [], b: [], z: [], s: "", o: {} },
    { _id: 5, a: [{ v: 1 }, { v: 2 }], b: [{ v: 2 }], z: [{ v: 3 }], s: "  X  ", o: { a: { b: 1 } } },
    { _id: 6, a: { b: [1] }, s: "abcdef" },
  ];
  beforeAll(async () => {
    guards = client!.db("jsmql_compiler_methods").collection("guards");
    await guards.deleteMany({});
    await guards.insertMany(DOCS.map((d) => ({ ...d })));
  });

  /** Every path to an `{ $ifNull: [x, fallback] }` in an emitted document. */
  const guardPaths = (v: unknown, path: (string | number)[] = []): (string | number)[][] => {
    if (v === null || typeof v !== "object") return [];
    const here = Object.keys(v).length === 1 && "$ifNull" in v ? [path] : [];
    const kids = Object.entries(v).flatMap(([k, x]) => guardPaths(x, [...path, Array.isArray(v) ? Number(k) : k]));
    return [...here, ...kids];
  };
  /** The document with the guard at `path` replaced by the value it guards. */
  const unguarded = (v: unknown, path: (string | number)[]): unknown => {
    const copy = structuredClone(v) as Record<string | number, unknown>;
    if (path.length === 0) return (copy as { $ifNull: unknown[] }).$ifNull[0];
    let parent = copy;
    for (const k of path.slice(0, -1)) parent = parent[k] as Record<string | number, unknown>;
    const last = path[path.length - 1];
    parent[last] = (parent[last] as { $ifNull: unknown[] }).$ifNull[0];
    return copy;
  };
  /** One answer per document, or the code of the server's refusal on it. */
  const answers = async (pipeline: object[]): Promise<string[]> => {
    const out: string[] = [];
    for (const d of DOCS) {
      try {
        out.push(canonical(await guards.aggregate([{ $match: { _id: d._id } }, ...pipeline]).toArray()));
      } catch (e) {
        out.push(`error ${(e as { code?: number }).code}`);
      }
    }
    return out;
  };

  it("drops a guard only to change an answer", async () => {
    const dead: string[] = [];
    let guardsChecked = 0;
    for (const src of GUARD_FREE) {
      const statement = src.includes(";");
      const mql = statement ? jsmql.pipeline(src) : expr(src);
      const run = (m: unknown): object[] => (statement ? (m as object[]) : [{ $addFields: { __v: m } }]);
      const base = (await answers(run(mql))).join("\n");
      for (const path of guardPaths(mql)) {
        guardsChecked++;
        if ((await answers(run(unguarded(mql, path)))).join("\n") === base)
          dead.push(`${src}: the guard at ${path.join(".")} changes nothing`);
      }
    }
    expect(dead).toEqual([]);
    // a null test is `$lte` or `$gt`, not an `$ifNull`, so a source can hold no guard at all
    expect(guardsChecked).toBeGreaterThan(GUARD_FREE.length / 2);
  });
});
