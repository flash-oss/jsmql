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
const nullOr = (recv: unknown, body: unknown): unknown => ({
  $cond: { if: { $eq: [{ $ifNull: [recv, null] }, null] }, then: null, else: body },
});

describe("compiler/emit — string methods", () => {
  it("lowers each string method to its operator", () => {
    expect(compiled("$.s.trim()", (d) => d.s.trim())).toEqual({ $trim: { input: "$s" } });
    expect(compiled("$.s.trimStart()", (d) => d.s.trimStart())).toEqual({ $ltrim: { input: "$s" } });
    expect(compiled("$.s.trimEnd()", (d) => d.s.trimEnd())).toEqual({ $rtrim: { input: "$s" } });
    expect(compiled("$.s.toLowerCase()", (d) => d.s.toLowerCase())).toEqual(nullOr("$s", { $toLower: "$s" }));
    expect(compiled("$.s.toUpperCase()", (d) => d.s.toUpperCase())).toEqual(nullOr("$s", { $toUpper: "$s" }));
    expect(compiled('$.csv.split(",")', (d) => d.csv.split(","))).toEqual({ $split: ["$csv", ","] });
    expect(compiled("$.csv.charAt(0)", (d) => d.csv.charAt(0))).toEqual(nullOr("$csv", { $substrCP: ["$csv", 0, 1] }));
    expect(compiled("$.csv.charAt(-1)", (d) => d.csv.charAt(-1))).toBe("");
    expect(compiled('$.csv.startsWith("a")', (d) => d.csv.startsWith("a"))).toEqual(
      nullOr("$csv", { $eq: [{ $indexOfCP: ["$csv", "a"] }, 0] }),
    );
    expect(compiled('$.csv.endsWith("c")', (d) => d.csv.endsWith("c"))).toEqual(
      nullOr("$csv", {
        $let: {
          vars: { jsmqlStr: "$csv" },
          in: {
            $eq: [
              { $substrCP: ["$$jsmqlStr", { $max: [0, { $subtract: [{ $strLenCP: "$$jsmqlStr" }, 1] }] }, 1] },
              "c",
            ],
          },
        },
      }),
    );
    expect(compiled("$.csv.search(/b/)", (d) => d.csv.search(/b/))).toEqual(
      nullOr("$csv", {
        $ifNull: [{ $getField: { field: "idx", input: { $regexFind: { input: "$csv", regex: "b" } } } }, -1],
      }),
    );
    expect(compiled('$.csv.padStart(7, "-")', (d) => d.csv.padStart(7, "-"))).toEqual({
      $cond: {
        if: { $eq: [{ $ifNull: ["$csv", null] }, null] },
        then: null,
        else: {
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
      },
    });
    expect(compiled('$.csv.padEnd(6, "xy")', (d) => d.csv.padEnd(6, "xy"))).toEqual({
      $cond: {
        if: { $eq: [{ $ifNull: ["$csv", null] }, null] },
        then: null,
        else: {
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
      },
    });
    expect(compiled("$.csv.repeat(2)", (d) => d.csv.repeat(2))).toEqual({
      $reduce: { input: { $range: [0, 2] }, initialValue: "", in: { $concat: ["$$value", "$csv"] } },
    });
    expect(compiled("$.csv.substr(2, 2)", (d) => d.csv.substr(2, 2))).toEqual(
      nullOr("$csv", { $substrCP: ["$csv", 2, 2] }),
    );
    expect(compiled("$.csv.substring(1, 3)", (d) => d.csv.substring(1, 3))).toEqual(
      nullOr("$csv", { $substrCP: ["$csv", 1, 2] }),
    );
    expect(compiled('$.csv.replace(",", ";")', (d) => d.csv.replace(",", ";"))).toEqual({
      $replaceOne: { input: "$csv", find: ",", replacement: ";" },
    });
    expect(compiled('$.csv.replaceAll(",", ";")', (d) => d.csv.replaceAll(",", ";"))).toEqual({
      $replaceAll: { input: "$csv", find: ",", replacement: ";" },
    });
    expect(compiled("$.csv.match(/B/i)", (d) => /B/i.test(d.csv))).toEqual(
      nullOr("$csv", { $regexMatch: { input: "$csv", regex: "B", options: "i" } }),
    );
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
    expect(() => expr('$.d.plus(1.5, "day")')).toThrow(/expects an integer/);
    expect(() => expr("$.d.isAfter($.e)")).toThrow(/without a unit is just '>'/);
    expect(() => expr('$.d.format("YYYY-MM-DD")')).toThrow(/Moment or Luxon/);
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
                  in: {
                    $cond: { if: { $eq: [{ $ifNull: ["$$k", null] }, null] }, then: null, else: { $toUpper: "$$k" } },
                  },
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
                  in: {
                    $cond: {
                      if: { $eq: [{ $ifNull: ["$$k", null] }, null] },
                      then: null,
                      else: { $eq: [{ $indexOfCP: ["$$k", "_"] }, 0] },
                    },
                  },
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
    ).toEqual({
      $map: { input: { $objectToArray: { $ifNull: ["$o", {}] } }, as: "jsmqlKv", in: ["$$jsmqlKv.k", "$$jsmqlKv.v"] },
    });
    expect(compiled('$.o.pick(["a", "b"])', () => ({ a: 1, b: 2 }))).toEqual({
      $let: {
        vars: { jsmqlObj: "$o" },
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
          cond: { $not: [{ $in: ["$$jsmqlKv.k", others] }] },
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
                  $getField: {
                    field: "o",
                    input: {
                      $let: {
                        vars: { jsmqlObj: "$$ROOT" },
                        in: { o: { $getField: { field: "o", input: "$$jsmqlObj" } } },
                      },
                    },
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
    expect(compiled("$.a.filter((x, i) => i > 0)", (d) => d.a.filter((_x, i) => i > 0))).toEqual({
      $map: {
        input: {
          $filter: {
            input: { $zip: { inputs: [{ $range: [0, { $size: "$a" }] }, "$a"] } },
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
      $arrayElemAt: [{ $filter: { input: "$a", as: "x", cond: { $gt: ["$$x", 1] } } }, 0],
    });
    expect(compiled("$.a.findLast(x => x > 1)", (d) => d.a.findLast((x) => x > 1))).toEqual({
      $arrayElemAt: [{ $filter: { input: "$a", as: "x", cond: { $gt: ["$$x", 1] } } }, -1],
    });
    expect(compiled("$.a.some(x => x > 2)", (d) => d.a.some((x) => x > 2))).toEqual(
      nullOr("$a", { $anyElementTrue: { $map: { input: "$a", as: "x", in: { $gt: ["$$x", 2] } } } }),
    );
    expect(compiled("$.a.every(x => x > 0)", (d) => d.a.every((x) => x > 0))).toEqual({
      $cond: {
        if: { $eq: [{ $ifNull: ["$a", null] }, null] },
        then: null,
        else: { $allElementsTrue: { $map: { input: "$a", as: "x", in: { $gt: ["$$x", 0] } } } },
      },
    });
    expect(compiled("$.nested.flatMap(x => x)", (d) => d.nested.flatMap((x) => x))).toEqual({
      $reduce: {
        input: { $map: { input: "$nested", as: "x", in: "$$x" } },
        initialValue: [],
        in: { $concatArrays: ["$$value", "$$this"] },
      },
    });
    expect(compiled("$.docs.map((x, i, arr) => arr.length)", (d) => d.docs.map((_x, _i, arr) => arr.length))).toEqual({
      $map: {
        input: "$docs",
        as: "x",
        in: {
          $let: {
            vars: { arr: "$docs" },
            in: { $cond: { if: { $eq: [{ $ifNull: ["$$arr", null] }, null] }, then: null, else: { $size: "$$arr" } } },
          },
        },
      },
    });
  });

  it("slices and reshapes", () => {
    expect(compiled("$.a.take(2)", (d) => d.a.slice(0, 2))).toEqual({ $slice: ["$a", 2] });
    expect(compiled("$.a.takeRight(2)", (d) => d.a.slice(-2))).toEqual({ $slice: ["$a", -2] });
    expect(compiled("$.a.drop(1)", (d) => d.a.slice(1))).toEqual({
      $let: { vars: { jsmqlArr: "$a" }, in: { $slice: ["$$jsmqlArr", 1, { $max: [1, { $size: "$$jsmqlArr" }] }] } },
    });
    expect(compiled("$.a.dropRight(1)", (d) => d.a.slice(0, -1))).toEqual({
      $let: {
        vars: { jsmqlArr: "$a" },
        in: { $slice: ["$$jsmqlArr", { $max: [0, { $subtract: [{ $size: { $ifNull: ["$$jsmqlArr", []] } }, 1] }] }] },
      },
    });
    expect(compiled("$.a.tail()", (d) => d.a.slice(1))).toEqual({
      $let: { vars: { jsmqlArr: "$a" }, in: { $slice: ["$$jsmqlArr", 1, { $max: [1, { $size: "$$jsmqlArr" }] }] } },
    });
    expect(compiled("$.a.initial()", (d) => d.a.slice(0, -1))).toEqual({
      $let: {
        vars: { jsmqlArr: "$a" },
        in: { $slice: ["$$jsmqlArr", { $max: [0, { $subtract: [{ $size: { $ifNull: ["$$jsmqlArr", []] } }, 1] }] }] },
      },
    });
    expect(compiled("$.a.head()", (d) => d.a[0])).toEqual({ $first: "$a" });
    expect(compiled("$.a.last()", (d) => d.a[2])).toEqual({ $last: "$a" });
    expect(compiled("$.a.chunk(2)", () => [[3, 1], [2]])).toEqual({
      $map: {
        input: { $range: [0, { $size: { $ifNull: ["$a", []] } }, 2] },
        as: "jsmqlI",
        in: { $slice: ["$a", "$$jsmqlI", 2] },
      },
    });
    expect(compiled("$.nested.flat()", (d) => d.nested.flat())).toEqual({
      $reduce: { input: "$nested", initialValue: [], in: { $concatArrays: ["$$value", "$$this"] } },
    });
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
    ).toEqual({
      $let: {
        vars: { jsmqlT: "$nested" },
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
          input: { $range: [0, { $size: [["k1", "k2"]] }] },
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
          input: "$pairs",
          as: "jsmqlP",
          in: [{ $toString: { $arrayElemAt: ["$$jsmqlP", 0] } }, { $arrayElemAt: ["$$jsmqlP", 1] }],
        },
      },
    });
    expect(compiled("$.a.toReversed()", (d) => d.a.toReversed())).toEqual({ $reverseArray: "$a" });
    expect(compiled("$.a.toSorted()", (d) => d.a.toSorted())).toEqual({ $sortArray: { input: "$a", sortBy: 1 } });
    // `(a, b) => a - b` names no field, so the elements themselves are the key
    expect(compiled("$.a.toSorted((a, b) => a - b)", (d) => d.a.toSorted((a, b) => a - b))).toEqual({
      $sortArray: { input: "$a", sortBy: 1 },
    });
    expect(compiled("$.a.toSorted((a, b) => b - a)", (d) => d.a.toSorted((a, b) => b - a))).toEqual({
      $sortArray: { input: "$a", sortBy: -1 },
    });
    expect(compiled("$.a.sortBy((a, b) => a - b)", (d) => d.a.toSorted((a, b) => a - b))).toEqual({
      $sortArray: { input: "$a", sortBy: 1 },
    });
    expect(compiled("$.a.orderBy((a, b) => a - b, -1)", (d) => d.a.toSorted((a, b) => b - a))).toEqual({
      $sortArray: { input: "$a", sortBy: -1 },
    });
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
    ).toEqual({
      $map: {
        input: {
          $sortArray: {
            input: { $map: { input: "$docs", as: "x", in: { k: { $mod: ["$$x.v", 2] }, v: "$$x" } } },
            sortBy: { k: 1 },
          },
        },
        as: "jsmqlP",
        in: "$$jsmqlP.v",
      },
    });
    expect(compiled('$.docs.orderBy(["v"], [-1])', (d) => d.docs.toSorted((p, q) => q.v - p.v))).toEqual({
      $sortArray: { input: "$docs", sortBy: { v: -1 } },
    });
    expect(compiled("$.a.toSpliced(1, 1, 9)", (d) => d.a.toSpliced(1, 1, 9))).toEqual({
      $let: {
        vars: { jsmqlArr: "$a" },
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
        vars: { jsmqlArr: "$a", jsmqlIdx: 0, jsmqlVal: 9 },
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
        vars: { jsmqlArr: "$a", jsmqlIdx: 2, jsmqlVal: 9 },
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
        vars: { jsmqlArr: "$a" },
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
        vars: { jsmqlArr: "$a" },
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
        vars: { jsmqlArr: "$a" },
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
        vars: { jsmqlArr: "$a" },
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
        vars: { jsmqlArr: "$a" },
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
        vars: { jsmqlArr: "$a" },
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
        vars: { jsmqlArr: "$a" },
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
        vars: { jsmqlArr: "$a" },
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
        vars: { jsmqlArr: "$a" },
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
        vars: { jsmqlArr: "$a" },
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
        vars: { jsmqlArr: "$a" },
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

  it("dispatches a method two prototypes share on the receiver's type at run time", () => {
    expect(compiled("$.a.indexOf(1)", (d) => d.a.indexOf(1))).toEqual({
      $switch: {
        branches: [
          { case: { $in: [{ $type: "$a" }, ["array"]] }, then: { $indexOfArray: ["$a", 1] } },
          { case: { $in: [{ $type: "$a" }, ["string"]] }, then: { $indexOfCP: ["$a", 1] } },
        ],
        default: null,
      },
    });
    expect(compiled('$.csv.indexOf("b")', (d) => d.csv.indexOf("b"))).toEqual({
      $switch: {
        branches: [
          { case: { $in: [{ $type: "$csv" }, ["array"]] }, then: { $indexOfArray: ["$csv", "b"] } },
          { case: { $in: [{ $type: "$csv" }, ["string"]] }, then: { $indexOfCP: ["$csv", "b"] } },
        ],
        default: null,
      },
    });
    expect(compiled("$.a.includes(2)", (d) => d.a.includes(2))).toEqual({
      $switch: {
        branches: [
          { case: { $in: [{ $type: "$a" }, ["array"]] }, then: { $in: [2, "$a"] } },
          { case: { $in: [{ $type: "$a" }, ["string"]] }, then: { $gte: [{ $indexOfCP: ["$a", 2] }, 0] } },
        ],
        default: null,
      },
    });
    expect(compiled('$.csv.includes("b")', (d) => d.csv.includes("b"))).toEqual({
      $switch: {
        branches: [
          { case: { $in: [{ $type: "$csv" }, ["array"]] }, then: { $in: ["b", "$csv"] } },
          { case: { $in: [{ $type: "$csv" }, ["string"]] }, then: { $gte: [{ $indexOfCP: ["$csv", "b"] }, 0] } },
        ],
        default: null,
      },
    });
    expect(compiled("$.a.at(-1)", (d) => d.a.at(-1))).toEqual({
      $switch: {
        branches: [
          {
            case: { $in: [{ $type: "$a" }, ["string"]] },
            then: { $substrCP: ["$a", { $max: [0, { $subtract: [{ $strLenCP: { $ifNull: ["$a", ""] } }, 1] }] }, 1] },
          },
          { case: { $in: [{ $type: "$a" }, ["array"]] }, then: { $arrayElemAt: ["$a", -1] } },
        ],
        default: null,
      },
    });
    expect(compiled("$.csv.at(0)", (d) => d.csv.at(0))).toEqual({
      $switch: {
        branches: [
          { case: { $in: [{ $type: "$csv" }, ["string"]] }, then: { $substrCP: ["$csv", 0, 1] } },
          { case: { $in: [{ $type: "$csv" }, ["array"]] }, then: { $arrayElemAt: ["$csv", 0] } },
        ],
        default: null,
      },
    });
    expect(compiled("$.a.slice(1, 3)", (d) => d.a.slice(1, 3))).toEqual({
      $switch: {
        branches: [
          { case: { $in: [{ $type: "$a" }, ["string"]] }, then: { $substrCP: ["$a", 1, 2] } },
          { case: { $in: [{ $type: "$a" }, ["array"]] }, then: { $slice: ["$a", 1, 2] } },
        ],
        default: null,
      },
    });
    expect(compiled("$.csv.slice(2)", (d) => d.csv.slice(2))).toEqual({
      $switch: {
        branches: [
          {
            case: { $in: [{ $type: "$csv" }, ["string"]] },
            then: {
              $substrCP: ["$csv", 2, { $max: [0, { $subtract: [{ $strLenCP: { $ifNull: ["$csv", ""] } }, 2] }] }],
            },
          },
          {
            case: { $in: [{ $type: "$csv" }, ["array"]] },
            then: {
              $let: {
                vars: { jsmqlArr: "$csv" },
                in: { $slice: ["$$jsmqlArr", 2, { $max: [1, { $size: "$$jsmqlArr" }] }] },
              },
            },
          },
        ],
        default: null,
      },
    });
    expect(compiled("$.a.concat($.b)", (d) => d.a.concat(d.b))).toEqual({
      $switch: {
        branches: [
          { case: { $in: [{ $type: "$a" }, ["array"]] }, then: { $concatArrays: ["$a", "$b"] } },
          { case: { $in: [{ $type: "$a" }, ["string"]] }, then: { $concat: ["$a", "$b"] } },
        ],
        default: null,
      },
    });
    // Several arguments, and each rendered the way JavaScript renders it for the family
    // that runs: `$concatArrays` takes arrays only, `$concat` takes strings only, and the
    // server folds a run of ADJACENT constant operands while it optimises — so a proven
    // scalar becomes the one-element array it stands for, and a proven array is joined.
    expect(compiled('$.csv.concat("!", "?")', (d) => d.csv.concat("!", "?"))).toEqual({
      $switch: {
        branches: [
          { case: { $in: [{ $type: "$csv" }, ["array"]] }, then: { $concatArrays: ["$csv", ["!"], ["?"]] } },
          { case: { $in: [{ $type: "$csv" }, ["string"]] }, then: { $concat: ["$csv", "!", "?"] } },
        ],
        default: null,
      },
    });
    expect(compiled('$.a.concat("!", "?")', (d) => d.a.concat("!", "?"))).toEqual({
      $switch: {
        branches: [
          { case: { $in: [{ $type: "$a" }, ["array"]] }, then: { $concatArrays: ["$a", ["!"], ["?"]] } },
          { case: { $in: [{ $type: "$a" }, ["string"]] }, then: { $concat: ["$a", "!", "?"] } },
        ],
        default: null,
      },
    });
    expect(compiled("$.a.concat([9], [8])", (d) => d.a.concat([9], [8]))).toEqual({
      $switch: {
        branches: [
          { case: { $in: [{ $type: "$a" }, ["array"]] }, then: { $concatArrays: ["$a", [9], [8]] } },
          {
            case: { $in: [{ $type: "$a" }, ["string"]] },
            then: {
              $concat: [
                "$a",
                {
                  $ifNull: [
                    {
                      $reduce: {
                        input: [9],
                        initialValue: null,
                        in: {
                          $cond: {
                            if: { $eq: ["$$value", null] },
                            then: {
                              $cond: {
                                if: { $in: [{ $type: "$$this" }, ["null", "missing"]] },
                                then: "",
                                else: { $toString: "$$this" },
                              },
                            },
                            else: {
                              $concat: [
                                "$$value",
                                ",",
                                {
                                  $cond: {
                                    if: { $in: [{ $type: "$$this" }, ["null", "missing"]] },
                                    then: "",
                                    else: { $toString: "$$this" },
                                  },
                                },
                              ],
                            },
                          },
                        },
                      },
                    },
                    "",
                  ],
                },
                {
                  $ifNull: [
                    {
                      $reduce: {
                        input: [8],
                        initialValue: null,
                        in: {
                          $cond: {
                            if: { $eq: ["$$value", null] },
                            then: {
                              $cond: {
                                if: { $in: [{ $type: "$$this" }, ["null", "missing"]] },
                                then: "",
                                else: { $toString: "$$this" },
                              },
                            },
                            else: {
                              $concat: [
                                "$$value",
                                ",",
                                {
                                  $cond: {
                                    if: { $in: [{ $type: "$$this" }, ["null", "missing"]] },
                                    then: "",
                                    else: { $toString: "$$this" },
                                  },
                                },
                              ],
                            },
                          },
                        },
                      },
                    },
                    "",
                  ],
                },
              ],
            },
          },
        ],
        default: null,
      },
    });
    expect(compiled("$.a.concat(2, 3)", (d) => d.a.concat(2, 3))).toEqual({
      $switch: {
        branches: [
          { case: { $in: [{ $type: "$a" }, ["array"]] }, then: { $concatArrays: ["$a", [2], [3]] } },
          {
            case: { $in: [{ $type: "$a" }, ["string"]] },
            then: { $concat: ["$a", { $toString: 2 }, { $toString: 3 }] },
          },
        ],
        default: null,
      },
    });
    expect(compiled("$.csv.concat(1, 2)", (d) => d.csv.concat(1, 2))).toEqual({
      $switch: {
        branches: [
          { case: { $in: [{ $type: "$csv" }, ["array"]] }, then: { $concatArrays: ["$csv", [1], [2]] } },
          {
            case: { $in: [{ $type: "$csv" }, ["string"]] },
            then: { $concat: ["$csv", { $toString: 1 }, { $toString: 2 }] },
          },
        ],
        default: null,
      },
    });
    expect(compiled('$.a.concat($.b, "!", "?")', (d) => d.a.concat(d.b, "!", "?"))).toEqual({
      $switch: {
        branches: [
          { case: { $in: [{ $type: "$a" }, ["array"]] }, then: { $concatArrays: ["$a", "$b", ["!"], ["?"]] } },
          { case: { $in: [{ $type: "$a" }, ["string"]] }, then: { $concat: ["$a", "$b", "!", "?"] } },
        ],
        default: null,
      },
    });
    // a receiver the row PROVES, so one family and no test at run time
    expect(compiled("$.s.trim().concat(1, 2)", (d) => d.s.trim().concat(1, 2))).toEqual({
      $concat: [{ $trim: { input: "$s" } }, { $toString: 1 }, { $toString: 2 }],
    });
    expect(compiled('$.csv.split(",").concat("!", "?")', (d) => d.csv.split(",").concat("!", "?"))).toEqual({
      $concatArrays: [{ $split: ["$csv", ","] }, ["!"], ["?"]],
    });
    expect(compiled("$.a.size()", (d) => d.a.length)).toEqual({
      $switch: {
        branches: [
          { case: { $in: [{ $type: "$a" }, ["array"]] }, then: { $size: "$a" } },
          { case: { $in: [{ $type: "$a" }, ["object"]] }, then: { $size: { $objectToArray: "$a" } } },
        ],
        default: "$$REMOVE",
      },
    });
    expect(compiled("$.o.size()", (d) => Object.keys(d.o).length)).toEqual({
      $switch: {
        branches: [
          { case: { $in: [{ $type: "$o" }, ["array"]] }, then: { $size: "$o" } },
          { case: { $in: [{ $type: "$o" }, ["object"]] }, then: { $size: { $objectToArray: "$o" } } },
        ],
        default: "$$REMOVE",
      },
    });
    // `.lastIndexOf` states one emitting family — the string form is refused — so it
    // answers the array reading outright rather than testing the receiver's type.
    expect(compiled("$.a.lastIndexOf(2)", (d) => d.a.lastIndexOf(2))).toEqual({
      $let: {
        vars: { jsmqlArr: "$a" },
        in: {
          $let: {
            vars: { jsmqlRevIdx: { $indexOfArray: [{ $reverseArray: "$$jsmqlArr" }, 2] } },
            in: {
              $cond: {
                if: { $eq: ["$$jsmqlRevIdx", -1] },
                then: -1,
                else: { $subtract: [{ $subtract: [{ $size: { $ifNull: ["$$jsmqlArr", []] } }, 1] }, "$$jsmqlRevIdx"] },
              },
            },
          },
        },
      },
    });
    expect(compiled("$.a.toString()", (d) => d.a.toString())).toEqual({
      $let: {
        vars: { jsmqlV: "$a" },
        in: {
          $cond: {
            if: { $isArray: "$$jsmqlV" },
            then: {
              $ifNull: [
                {
                  $reduce: {
                    input: "$$jsmqlV",
                    initialValue: null,
                    in: {
                      $cond: {
                        if: { $eq: ["$$value", null] },
                        then: {
                          $cond: {
                            if: { $in: [{ $type: "$$this" }, ["null", "missing"]] },
                            then: "",
                            else: { $toString: "$$this" },
                          },
                        },
                        else: {
                          $concat: [
                            "$$value",
                            ",",
                            {
                              $cond: {
                                if: { $in: [{ $type: "$$this" }, ["null", "missing"]] },
                                then: "",
                                else: { $toString: "$$this" },
                              },
                            },
                          ],
                        },
                      },
                    },
                  },
                },
                "",
              ],
            },
            else: { $toString: "$$jsmqlV" },
          },
        },
      },
    });
    expect(compiled("$.n.toString()", (d) => d.n.toString())).toEqual({
      $let: {
        vars: { jsmqlV: "$n" },
        in: {
          $cond: {
            if: { $isArray: "$$jsmqlV" },
            then: {
              $ifNull: [
                {
                  $reduce: {
                    input: "$$jsmqlV",
                    initialValue: null,
                    in: {
                      $cond: {
                        if: { $eq: ["$$value", null] },
                        then: {
                          $cond: {
                            if: { $in: [{ $type: "$$this" }, ["null", "missing"]] },
                            then: "",
                            else: { $toString: "$$this" },
                          },
                        },
                        else: {
                          $concat: [
                            "$$value",
                            ",",
                            {
                              $cond: {
                                if: { $in: [{ $type: "$$this" }, ["null", "missing"]] },
                                then: "",
                                else: { $toString: "$$this" },
                              },
                            },
                          ],
                        },
                      },
                    },
                  },
                },
                "",
              ],
            },
            else: { $toString: "$$jsmqlV" },
          },
        },
      },
    });
    // Inside the null test, `$ifNull` wraps the reduce so an EMPTY array answers "" rather
    // than the reduce's own `null` seed — the seed is `null` so a leading "" element keeps its separator.
    expect(compiled('$.a.join("-")', (d) => d.a.join("-"))).toEqual({
      $cond: {
        if: { $eq: [{ $ifNull: ["$a", null] }, null] },
        then: null,
        else: {
          $ifNull: [
            {
              $reduce: {
                input: "$a",
                initialValue: null,
                in: {
                  $cond: {
                    if: { $eq: ["$$value", null] },
                    then: {
                      $cond: {
                        if: { $in: [{ $type: "$$this" }, ["null", "missing"]] },
                        then: "",
                        else: { $toString: "$$this" },
                      },
                    },
                    else: {
                      $concat: [
                        "$$value",
                        "-",
                        {
                          $cond: {
                            if: { $in: [{ $type: "$$this" }, ["null", "missing"]] },
                            then: "",
                            else: { $toString: "$$this" },
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
            "",
          ],
        },
      },
    });
    expect(compiled('$.mixed.join(",")', (d) => d.mixed.join(","))).toEqual({
      $cond: {
        if: { $eq: [{ $ifNull: ["$mixed", null] }, null] },
        then: null,
        else: {
          $ifNull: [
            {
              $reduce: {
                input: "$mixed",
                initialValue: null,
                in: {
                  $cond: {
                    if: { $eq: ["$$value", null] },
                    then: {
                      $cond: {
                        if: { $in: [{ $type: "$$this" }, ["null", "missing"]] },
                        then: "",
                        else: { $toString: "$$this" },
                      },
                    },
                    else: {
                      $concat: [
                        "$$value",
                        ",",
                        {
                          $cond: {
                            if: { $in: [{ $type: "$$this" }, ["null", "missing"]] },
                            then: "",
                            else: { $toString: "$$this" },
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
            "",
          ],
        },
      },
    });
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
    expect(compiled('$.docs.maxBy("v")', () => ({ k: "x", v: 3 }))).toEqual({
      $let: {
        vars: {
          jsmqlSorted: {
            $sortArray: {
              input: { $map: { input: "$docs", as: "x", in: { k: "$$x.v", v: "$$x" } } },
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
              input: { $map: { input: "$docs", as: "x", in: { k: "$$x.v", v: "$$x" } } },
              sortBy: { k: 1 },
            },
          },
        },
        in: { $getField: { field: "v", input: { $arrayElemAt: ["$$jsmqlSorted", 0] } } },
      },
    });
    expect(unordered("$.mixed.uniq()", () => [0, 1, "", "a", null, false, true])).toEqual({ $setUnion: "$mixed" });
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
            input: "$docs",
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
        input: "$mixed",
        as: "jsmqlItem",
        cond: {
          $and: [
            { $ne: [{ $ifNull: ["$$jsmqlItem", null] }, null] },
            { $ne: ["$$jsmqlItem", false] },
            { $ne: ["$$jsmqlItem", ""] },
            { $ne: ["$$jsmqlItem", 0] },
          ],
        },
      },
    });
    expect(compiled("$.nested.flatten()", (d) => d.nested.flat())).toEqual({
      $reduce: {
        input: "$nested",
        initialValue: [],
        in: { $concatArrays: ["$$value", { $cond: [{ $isArray: "$$this" }, "$$this", ["$$this"]] }] },
      },
    });
    expect(unordered("$.a.intersection($.b)", () => [2])).toEqual({ $setIntersection: ["$a", "$b"] });
    expect(compiled("$.a.difference($.b)", () => [3, 1])).toEqual({
      $filter: { input: "$a", as: "jsmqlItem", cond: { $not: [{ $in: ["$$jsmqlItem", { $ifNull: ["$b", []] }] }] } },
    });
    expect(unordered("$.a.union($.b)", () => [3, 1, 2, 5])).toEqual({ $setUnion: ["$a", "$b"] });
    expect(compiled("$.a.without(1)", () => [3, 2])).toEqual({
      $filter: { input: "$a", as: "jsmqlItem", cond: { $not: [{ $in: ["$$jsmqlItem", [1]] }] } },
    });
    expect(unordered("$.a.xor($.b)", () => [3, 1, 5])).toEqual({
      $setUnion: [{ $setDifference: ["$a", "$b"] }, { $setDifference: ["$b", "$a"] }],
    });
    expect(compiled('$.docs.keyBy("k")', () => ({ x: { k: "x", v: 3 }, y: { k: "y", v: 1 } }))).toEqual({
      $arrayToObject: {
        $map: { input: "$docs", as: "x", in: { k: { $ifNull: [{ $toString: "$$x.k" }, "null"] }, v: "$$x" } },
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
            $setUnion: [{ $map: { input: "$docs", as: "x", in: { $ifNull: [{ $toString: "$$x.k" }, "null"] } } }, []],
          },
          as: "jsmqlKey",
          in: {
            k: "$$jsmqlKey",
            v: {
              $filter: {
                input: "$docs",
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
            $setUnion: [{ $map: { input: "$docs", as: "x", in: { $ifNull: [{ $toString: "$$x.k" }, "null"] } } }, []],
          },
          as: "jsmqlKey",
          in: {
            k: "$$jsmqlKey",
            v: {
              $size: {
                $filter: {
                  input: "$docs",
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
      { $filter: { input: "$a", as: "x", cond: { $gt: ["$$x", 1] } } },
      { $filter: { input: "$a", as: "x", cond: { $not: [{ $gt: ["$$x", 1] }] } } },
    ]);
    expect(compiled("$.a.reject(x => x > 1)", () => [1])).toEqual({
      $filter: { input: "$a", as: "x", cond: { $not: [{ $gt: ["$$x", 1] }] } },
    });
    expect(compiled("$.a.takeWhile(x => x > 1)", () => [3])).toEqual({
      $let: {
        vars: { jsmqlArr: "$a" },
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
        vars: { jsmqlArr: "$a" },
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
    expect(() => expr("$.a.includes(x => x > 1)")).toThrow(/searches for a VALUE/);
    expect(() => expr("$.a.map(5)")).toThrow(/takes an arrow/);
    expect(() => expr("$.a.map((a, b, c, d) => a)")).toThrow(/at most 3 parameters/);
  });
});

// ── the server ───────────────────────────────────────────────────────────────

describe("compiler/emit — the JavaScript globals, Math, regex methods and the reducers", () => {
  it("lowers each Math function to its operator", () => {
    expect(compiled("Math.abs($.neg)", () => Math.abs(DOC.neg))).toEqual({ $abs: "$neg" });
    expect(compiled("Math.sqrt($.n)", () => Math.sqrt(DOC.n))).toEqual({ $sqrt: "$n" });
    expect(compiled("Math.cbrt($.neg)", () => Math.cbrt(DOC.neg))).toEqual({
      $multiply: [{ $cmp: ["$neg", 0] }, { $pow: [{ $abs: "$neg" }, { $divide: [1, 3] }] }],
    });
    expect(compiled("Math.sign($.neg)", () => Math.sign(DOC.neg))).toEqual({ $cmp: ["$neg", 0] });
    expect(compiled("Math.trunc($.n)", () => Math.trunc(DOC.n))).toEqual({ $trunc: "$n" });
    expect(compiled("Math.round($.n)", () => Math.round(DOC.n))).toEqual({ $round: ["$n", 0] });
    expect(compiled("Math.ceil($.n)", () => Math.ceil(DOC.n))).toEqual({ $ceil: "$n" });
    expect(compiled("Math.floor($.n)", () => Math.floor(DOC.n))).toEqual({ $floor: "$n" });
    expect(compiled("Math.log($.n)", () => Math.log(DOC.n))).toEqual({ $ln: "$n" });
    expect(compiled("Math.log2($.n)", () => Math.log2(DOC.n))).toEqual({ $log: ["$n", 2] });
    expect(compiled("Math.log10($.n)", () => Math.log10(DOC.n))).toEqual({ $log10: "$n" });
    expect(compiled("Math.exp($.neg)", () => Math.exp(DOC.neg))).toEqual({ $exp: "$neg" });
    expect(compiled("Math.pow($.neg, 3)", () => Math.pow(DOC.neg, 3))).toEqual({ $pow: ["$neg", 3] });
    expect(compiled("Math.hypot($.neg, 4)", () => Math.hypot(DOC.neg, 4))).toEqual({
      $sqrt: { $add: [{ $pow: ["$neg", 2] }, { $pow: [4, 2] }] },
    });
    expect(compiled("Math.atan2($.neg, 4)", () => Math.atan2(DOC.neg, 4))).toEqual({ $atan2: ["$neg", 4] });
    expect(compiled("Math.sin($.n)", () => Math.sin(DOC.n))).toEqual({ $sin: "$n" });
    expect(compiled("Math.acos($.n / 10)", () => Math.acos(DOC.n / 10))).toEqual({ $acos: { $divide: ["$n", 10] } });
    expect(compiled("Math.tanh($.n)", () => Math.tanh(DOC.n))).toEqual({ $tanh: "$n" });
    expect(compiled("Math.asinh($.n)", () => Math.asinh(DOC.n))).toEqual({ $asinh: "$n" });
    expect(compiled("Math.min($.neg, $.n)", () => Math.min(DOC.neg, DOC.n))).toEqual({ $min: ["$neg", "$n"] });
    expect(compiled("Math.max(...$.a)", () => Math.max(...DOC.a))).toEqual({ $max: "$a" });
    expect(compiled("Math.max(...$.a, 9)", () => Math.max(...DOC.a, 9))).toEqual({
      $max: { $concatArrays: ["$a", [9]] },
    });
    expect(expr("Math.random()")).toEqual({ $rand: {} });
  });

  it("lowers the global constructors and the Number, Array and Object statics", () => {
    expect(compiled("String($.n)", () => String(DOC.n))).toEqual({ $toString: "$n" });
    expect(compiled("Boolean($.neg)", () => Boolean(DOC.neg))).toEqual({
      $and: [
        { $ne: [{ $ifNull: ["$neg", null] }, null] },
        { $ne: ["$neg", false] },
        { $ne: ["$neg", ""] },
        { $ne: ["$neg", 0] },
      ],
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
    expect(compiled("Object.assign($.o, { z: 1 })", () => Object.assign({}, DOC.o, { z: 1 }))).toEqual({
      $mergeObjects: ["$o", { z: 1 }],
    });
    expect(compiled("Object.assign({}, ...$.docs)", () => Object.assign({}, ...DOC.docs))).toEqual({
      $mergeObjects: { $concatArrays: [[{}], "$docs"] },
    });
    expect(compiled("Object.fromEntries($.pairs)", () => Object.fromEntries(DOC.pairs as [string, number][]))).toEqual({
      $arrayToObject: {
        $map: {
          input: "$pairs",
          as: "jsmqlP",
          in: [{ $toString: { $arrayElemAt: ["$$jsmqlP", 0] } }, { $arrayElemAt: ["$$jsmqlP", 1] }],
        },
      },
    });
  });

  it("applies a bare callable global to each element", () => {
    expect(compiled("$.a.map(String)", () => DOC.a.map(String))).toEqual({
      $map: { input: "$a", as: "x", in: { $toString: "$$x" } },
    });
    expect(compiled("$.mixed.filter(Boolean)", () => DOC.mixed.filter(Boolean))).toEqual({
      $filter: {
        input: "$mixed",
        as: "x",
        cond: {
          $and: [
            { $ne: [{ $ifNull: ["$$x", null] }, null] },
            { $ne: ["$$x", false] },
            { $ne: ["$$x", ""] },
            { $ne: ["$$x", 0] },
          ],
        },
      },
    });
    expect(compiled("[$.neg, $.n].map(Math.abs)", () => [DOC.neg, DOC.n].map(Math.abs))).toEqual({
      $map: { input: ["$neg", "$n"], as: "x", in: { $abs: "$$x" } },
    });
    expect(compiled("$.a.some(Number.isInteger)", () => DOC.a.some(Number.isInteger))).toEqual({
      $cond: {
        if: { $eq: [{ $ifNull: ["$a", null] }, null] },
        then: null,
        else: {
          $anyElementTrue: {
            $map: {
              input: "$a",
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
    expect(compiled("$.a.findIndex(x => x < 3)", () => DOC.a.findIndex((x) => x < 3))).toEqual(
      nullOr("$a", {
        $reduce: {
          input: { $zip: { inputs: [{ $range: [0, { $size: "$a" }] }, "$a"] } },
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
      }),
    );
    expect(compiled("$.a.findIndex((x, i) => x + i > 3)", () => DOC.a.findIndex((x, i) => x + i > 3))).toEqual({
      $cond: {
        if: { $eq: [{ $ifNull: ["$a", null] }, null] },
        then: null,
        else: {
          $reduce: {
            input: { $zip: { inputs: [{ $range: [0, { $size: "$a" }] }, "$a"] } },
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
        },
      },
    });
    expect(compiled("$.a.findIndex(x => x > 9)", () => DOC.a.findIndex((x) => x > 9))).toEqual({
      $cond: {
        if: { $eq: [{ $ifNull: ["$a", null] }, null] },
        then: null,
        else: {
          $reduce: {
            input: { $zip: { inputs: [{ $range: [0, { $size: "$a" }] }, "$a"] } },
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
        },
      },
    });
    expect(compiled("$.a.findLastIndex(x => x > 1)", () => DOC.a.findLastIndex((x) => x > 1))).toEqual({
      $cond: {
        if: { $eq: [{ $ifNull: ["$a", null] }, null] },
        then: null,
        else: {
          $reduce: {
            input: { $zip: { inputs: [{ $range: [0, { $size: "$a" }] }, "$a"] } },
            initialValue: -1,
            in: {
              $cond: [
                { $let: { vars: { x: { $arrayElemAt: ["$$this", 1] } }, in: { $gt: ["$$x", 1] } } },
                { $arrayElemAt: ["$$this", 0] },
                "$$value",
              ],
            },
          },
        },
      },
    });
    expect(compiled("$.a.reduce((acc, x) => acc + x, 0)", () => DOC.a.reduce((acc, x) => acc + x, 0))).toEqual({
      $reduce: { input: "$a", initialValue: 0, in: { $add: ["$$value", "$$this"] } },
    });
    expect(
      compiled("$.a.reduce((acc, x, i) => acc + x * i, 0)", () => DOC.a.reduce((acc, x, i) => acc + x * i, 0)),
    ).toEqual({
      $reduce: {
        input: { $zip: { inputs: [{ $range: [0, { $size: "$a" }] }, "$a"] } },
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
        input: { $reverseArray: "$a" },
        initialValue: [],
        in: { $let: { vars: { acc: "$$value", x: "$$this" }, in: { $concatArrays: ["$$acc", ["$$x"]] } } },
      },
    });
    expect(
      compiled("$.docs.reduce((acc, d) => acc + d.v, 0)", () => DOC.docs.reduce((acc, d) => acc + d.v, 0)),
    ).toEqual({ $reduce: { input: "$docs", initialValue: 0, in: { $add: ["$$value", "$$this.v"] } } });
    expect(compiled("$.a.zipWith($.a, (x, y) => x * y)", () => DOC.a.map((x, i) => x * DOC.a[i]))).toEqual({
      $map: {
        input: { $zip: { inputs: ["$a", "$a"], useLongestLength: true } },
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

  it("lowers the Set relations on a Set or an array", () => {
    // MEASURED: $setIsSubset and $size ABORT the command on an operand that is not an
    // array, where every $setUnion/$setDifference sibling answers null. The RECEIVER is a
    // JavaScript method's and answers null when it is not there; a missing ARGUMENT list
    // reads as the empty set. A literal is already an array and takes neither.
    expect(compiled("new Set($.a).isSubsetOf(new Set($.b))", () => new Set(DOC.a).isSubsetOf(new Set(DOC.b)))).toEqual(
      nullOr("$a", { $setIsSubset: ["$a", { $ifNull: ["$b", []] }] }),
    );
    expect(compiled("new Set([2]).isSubsetOf(new Set($.b))", () => new Set([2]).isSubsetOf(new Set(DOC.b)))).toEqual({
      $setIsSubset: [[2], { $ifNull: ["$b", []] }],
    });
    expect(
      compiled("new Set($.b).isSupersetOf(new Set([5]))", () => new Set(DOC.b).isSupersetOf(new Set([5]))),
    ).toEqual(nullOr("$b", { $setIsSubset: [[5], "$b"] }));
    expect(
      compiled("new Set($.a).isDisjointFrom(new Set($.b))", () => new Set(DOC.a).isDisjointFrom(new Set(DOC.b))),
    ).toEqual(nullOr("$a", { $eq: [{ $size: { $setIntersection: ["$a", { $ifNull: ["$b", []] }] } }, 0] }));
    expect(
      unordered("new Set($.a).symmetricDifference(new Set($.b))", () => [
        ...new Set(DOC.a).symmetricDifference(new Set(DOC.b)),
      ]),
    ).toEqual({
      $let: {
        vars: { jsmqlA: "$a", jsmqlB: "$b" },
        in: {
          $setDifference: [{ $setUnion: ["$$jsmqlA", "$$jsmqlB"] }, { $setIntersection: ["$$jsmqlA", "$$jsmqlB"] }],
        },
      },
    });
    expect(unordered("new Set($.a).union(new Set($.b))", () => [...new Set(DOC.a).union(new Set(DOC.b))])).toEqual({
      $setUnion: ["$a", "$b"],
    });
  });

  it("packs a spread into the one list a variadic method reads", () => {
    expect(compiled("$.a.concat(...$.b, 1)", () => DOC.a.concat(...DOC.b, 1))).toEqual({
      $switch: {
        branches: [
          {
            case: { $in: [{ $type: "$a" }, ["array"]] },
            then: { $concatArrays: ["$a", { $concatArrays: ["$b", [1]] }] },
          },
          {
            case: { $in: [{ $type: "$a" }, ["string"]] },
            then: {
              $concat: [
                "$a",
                {
                  $ifNull: [
                    {
                      $reduce: {
                        input: { $concatArrays: ["$b", [1]] },
                        initialValue: null,
                        in: {
                          $cond: {
                            if: { $eq: ["$$value", null] },
                            then: {
                              $cond: {
                                if: { $in: [{ $type: "$$this" }, ["null", "missing"]] },
                                then: "",
                                else: { $toString: "$$this" },
                              },
                            },
                            else: {
                              $concat: [
                                "$$value",
                                "",
                                {
                                  $cond: {
                                    if: { $in: [{ $type: "$$this" }, ["null", "missing"]] },
                                    then: "",
                                    else: { $toString: "$$this" },
                                  },
                                },
                              ],
                            },
                          },
                        },
                      },
                    },
                    "",
                  ],
                },
              ],
            },
          },
        ],
        default: null,
      },
    });
    expect(compiled("$.csv.concat(...$.a)", () => DOC.csv.concat(...DOC.a))).toEqual({
      $switch: {
        branches: [
          { case: { $in: [{ $type: "$csv" }, ["array"]] }, then: { $concatArrays: ["$csv", "$a"] } },
          {
            case: { $in: [{ $type: "$csv" }, ["string"]] },
            then: {
              $concat: [
                "$csv",
                {
                  $ifNull: [
                    {
                      $reduce: {
                        input: "$a",
                        initialValue: null,
                        in: {
                          $cond: {
                            if: { $eq: ["$$value", null] },
                            then: {
                              $cond: {
                                if: { $in: [{ $type: "$$this" }, ["null", "missing"]] },
                                then: "",
                                else: { $toString: "$$this" },
                              },
                            },
                            else: {
                              $concat: [
                                "$$value",
                                "",
                                {
                                  $cond: {
                                    if: { $in: [{ $type: "$$this" }, ["null", "missing"]] },
                                    then: "",
                                    else: { $toString: "$$this" },
                                  },
                                },
                              ],
                            },
                          },
                        },
                      },
                    },
                    "",
                  ],
                },
              ],
            },
          },
        ],
        default: null,
      },
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
 * MEASURED, and the reason these rows guard with `$ifNull` where their siblings do
 * not: `$in`'s second operand, both of `$setIsSubset`'s and `$size`'s one refuse a
 * null or missing value, where `$map`, `$filter`, `$slice`, `$setUnion` and the rest
 * answer null in turn. A document that simply lacks the field would take the query
 * down with it, so each of these reads its list as the empty list — lodash's reading
 * of a missing list, and the empty set for the three predicates.
 *
 * Each row: the source, what it answers over an EMPTY document, and what it answers
 * when only the LIST is missing. `undefined` means the row wrote no field at all.
 */
const GUARDED: readonly (readonly [string, unknown, unknown])[] = [
  ["$.a.difference($.b)", null, [1, 2]],
  ['$.a.differenceBy($.b, "id")', null, [1, 2]],
  ['$.a.intersectionBy($.b, "id")', null, []],
  ['$.a.xorBy($.b, "id")', null, [1, 2]],
  // the RECEIVER is a JavaScript method's: null when it is not there
  ["$.a.isSubsetOf($.b)", null, false],
  ["$.a.isSupersetOf($.b)", null, true],
  ["$.a.isDisjointFrom($.b)", null, true],
  ["$.a.chunk(2)", [], [[1, 2]]],
  ["$.a.zipObject($.b)", {}, { 1: null, 2: null }],
  ["$.a.lastIndexOf(1)", null, 0],
  ["$.a.dropRight(1)", null, [1]],
  ["$.a.initial()", null, [1]],
  ["$.o.pick($.b)", {}, {}],
  ["$.o.omit($.b)", {}, { x: 1 }],
];

/**
 * Every reader of an object, over a document that lacks the field.
 *
 * `$objectToArray` answers null for a missing field and `$arrayToObject` passes that
 * null on. Two answers come out of that, and which one a spelling gets is the source's
 * own choice, never a guess:
 *
 *   - a LODASH method answers `{}`, or `[]` where it answers an array, because
 *     `_.pick(undefined, …)` does. Nothing else is on offer: lodash has no other reading.
 *   - a JAVASCRIPT reader answers null, because `Object.keys(undefined)` is a TypeError
 *     and null is the nearest thing MongoDB has to raising one. A `?.` answers null too,
 *     and for a second reason: a `?.` with a call after it STOPS the chain.
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
  // JavaScript — null on a plain read
  ["$.o.keys()", null],
  ["$.o.values()", null],
  ["$.o.entries()", null],
  ["Object.keys($.o)", null],
  ["Object.values($.o)", null],
  ["Object.entries($.o)", null],
  // a `?.` with a call after it stops the chain, so the chain answers null
  ["$.o?.keys()", null],
  ["$.o?.values()", null],
  ["$.o?.entries()", null],
  ["$.o?.keys().length", null],
  ["$.s?.trim().length", null],
  ["$.a?.map(x => x).length", null],
  // a NAMESPACE call has no receiver to carry the `?.`, so the row reads it off the
  // argument — and there is no call AFTER the `?.` to stop, so `{}` still applies
  ["Object.keys($.o?.sub)", []],
  // nothing runs after this `?.`, so the document and the answer are what they were
  ['$.first + " " + $.user?.last', "An "],
  // the root document is there, so it takes no neutral
  ["Object.keys($).length", 2],
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
    // `.sample()` picks at random, so it is the one row whose answer is a membership.
    const picked = await guarded
      .aggregate([{ $addFields: { __v: expr("$.a.sample()") } }, { $sort: { _id: 1 } }])
      .toArray();
    expect(picked[0].__v).toBeNull();
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
