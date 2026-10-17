// THE proof that the interpreter is safe: for every operator that it runs, the value
// that it computes equals the value that the server computes for the SAME MQL.
//
// Nothing else can establish this. A `toEqual` on the interpreter's answer proves
// what the interpreter says, never that the server agrees. Every rule that looks like
// an arbitrary restriction in src/compiler/interpret/ is there because a case in this
// file once failed. See src/compiler/interpret/CLAUDE.md.
//
// There is one table of cases for each operator in RULES. A row is one MQL expression.
// The server runs `[{ $documents: [{}] }, { $addFields: { v: <mql> } }]`. A row holds an
// expression that the interpreter answers. A test of a refusal is in
// compiler-interpret.test.ts, because the server gives no answer for it.
//
// The suite skips itself, and reports green, when no mongod is reachable. The guards at
// the foot of the file check that every case ran, or that none did.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db, MongoClient } from "mongodb";
import { Binary, BSONRegExp, Decimal128, Double, Int32, Long, MaxKey, MinKey, ObjectId, Timestamp } from "bson";
import { interpret } from "../src/compiler/interpret/index.ts";
import { RULES } from "../src/compiler/interpret/rules.ts";
import { rankOf, sameValue } from "../src/compiler/interpret/values.ts";
import { announceSkip, liveClientNow, liveUp } from "./fixtures/live.ts";
import { answersSet, inAnyOrder } from "./support/set-answer.ts";

const up = await liveUp();
if (!up) announceSkip("interpret-agrees");

// Characters that a string operator must count in code points or in bytes, not in UTF-16 units.
const ASTRAL = "😀";
const LIGATURE = "ﬁ"; // U+FB01 sorts below U+1F600 in code points and above it in UTF-16 units
const ACCENT = "é";

/** The code points that `$trim` removes by default, as one string. */
const SPACES = [0, 9, 10, 11, 12, 13, 32, 0xa0, 0x1680, ...Array.from({ length: 11 }, (_, i) => 0x2000 + i)]
  .map((cp) => String.fromCodePoint(cp))
  .join("");

const OID = "507f1f77bcf86cd799439011";

/** A Sunday in ISO week 10, with every field of the time set. */
const WHEN = new Date("2024-03-10T13:45:30.123Z");
/** The dates where the week rules, the year rules and the calendar differ. */
const EDGE_DATES = [
  WHEN,
  new Date("2021-01-03T00:00:00Z"), // a Sunday that belongs to ISO week 53 of 2020
  new Date("2024-12-30T08:00:00Z"), // a Monday that belongs to ISO week 1 of 2025
  new Date("2023-01-01T00:00:00Z"), // a Sunday: week 1 by Sunday, week 52 by ISO
  new Date("2020-12-31T23:59:59.999Z"),
  new Date("0001-01-01T00:00:00Z"),
  new Date("-000001-12-31T12:00:00Z"),
  new Date(0),
];
const DATE_PARTS = [
  "$year",
  "$month",
  "$dayOfMonth",
  "$hour",
  "$minute",
  "$second",
  "$millisecond",
  "$dayOfWeek",
  "$dayOfYear",
  "$week",
  "$isoWeek",
  "$isoWeekYear",
  "$isoDayOfWeek",
] as const;

/**
 * The cases, one table for each operator. A new operator adds one table, and the guard
 * at the foot of the file fails until it does. Each table holds four to twelve rows.
 */
export const BATTERIES: Readonly<Record<string, readonly unknown[]>> = {
  // ── arithmetic ─────────────────────────────────────────────────────────────
  $add: [
    { $add: [1, 2] },
    { $add: [] },
    { $add: [5] },
    { $add: [-3, 3] },
    { $add: [0.1, 0.2] },
    { $add: [1, 2, 3, 4] },
    { $add: [2147483647, 1] },
    { $add: [1, null] },
    { $add: [4503599627370496, 4503599627370495] },
    { $add: [1.5, -0.25] },
    { $add: [0.1, 0.2, 0.3, 0.4, 0.5] },
    { $add: [1e16, 1.5, -1e16, 0.25] },
  ],
  $subtract: [
    { $subtract: [5, 2] },
    { $subtract: [2, 5] },
    { $subtract: [0.3, 0.1] },
    { $subtract: [null, 1] },
    { $subtract: [-2147483648, 1] },
    { $subtract: [1e15, 1] },
  ],
  $multiply: [
    { $multiply: [3, 4] },
    { $multiply: [] },
    { $multiply: [2, 3, 4] },
    { $multiply: [-2, 5] },
    { $multiply: [0.1, 3] },
    { $multiply: [3, null] },
    { $multiply: [65536, 65536] },
    { $multiply: [94906265, 94906265] },
    { $multiply: [1e200, 1e200] },
    { $multiply: [1.1, 1.1, 1.1] },
    { $multiply: [0.1, 3, 0.7, 11] },
    { $multiply: [1e150, 1e-150, 3.3, 7] },
  ],
  $divide: [
    { $divide: [7, 2] },
    { $divide: [4, 2] },
    { $divide: [-9, 3] },
    { $divide: [1, 3] },
    { $divide: [null, 2] },
    { $divide: [1, 0] },
    { $divide: [0, 5] },
  ],
  $mod: [
    { $mod: [7, 3] },
    { $mod: [-7, 3] },
    { $mod: [7, -3] },
    { $mod: [7.5, 2] },
    { $mod: [null, 2] },
    { $mod: [10, 5] },
    { $mod: [1, 0] },
  ],
  $pow: [
    { $pow: [2, 10] },
    { $pow: [0, 0] },
    { $pow: [-2, 3] },
    { $pow: [-2, 4] },
    { $pow: [1, 1000] },
    { $pow: [null, 2] },
    { $pow: [3, 33] },
    { $pow: [10, 400] },
  ],
  $sqrt: [{ $sqrt: 16 }, { $sqrt: 2 }, { $sqrt: 0 }, { $sqrt: 0.25 }, { $sqrt: null }, { $sqrt: -1 }, { $sqrt: 1e300 }],
  $abs: [{ $abs: -5 }, { $abs: 5 }, { $abs: -0.5 }, { $abs: -2147483648 }, { $abs: null }, { $abs: 0 }],
  $ceil: [{ $ceil: 1.2 }, { $ceil: -1.2 }, { $ceil: 5 }, { $ceil: 0.5 }, { $ceil: null }, { $ceil: -2147483648.5 }],
  $floor: [{ $floor: 1.8 }, { $floor: -1.2 }, { $floor: 5 }, { $floor: 0.5 }, { $floor: null }, { $floor: -0.5 }],
  $trunc: [
    { $trunc: 2.7 },
    { $trunc: -2.7 },
    { $trunc: [2.75, 1] },
    { $trunc: [-2.75, 1] },
    { $trunc: [1234, -2] },
    { $trunc: [2.675, 2] },
    { $trunc: [0.1, 20] },
    { $trunc: null },
    { $trunc: [12345.6789, -3] },
    { $trunc: [5.5, 100] },
  ],
  $round: [
    { $round: 2.5 },
    { $round: 3.5 },
    { $round: -2.5 },
    { $round: [2.675, 2] },
    { $round: [1.005, 2] },
    { $round: [1250, -2] },
    { $round: [1350, -2] },
    { $round: [5] },
    { $round: null },
    { $round: [123.456, 1] },
    { $round: [0.5, 0] },
    { $round: [8.345, 2] },
  ],
  $bitAnd: [
    { $bitAnd: [12, 10] },
    { $bitAnd: [-1, 5] },
    { $bitAnd: [7] },
    { $bitAnd: [255, 15, 3] },
    { $bitAnd: [-8, -3] },
  ],
  $bitOr: [
    { $bitOr: [12, 10] },
    { $bitOr: [-1, 5] },
    { $bitOr: [0, 0] },
    { $bitOr: [1, 2, 4] },
    { $bitOr: [-2147483648, 1] },
  ],
  $bitXor: [
    { $bitXor: [12, 10] },
    { $bitXor: [-1, 5] },
    { $bitXor: [5, 5] },
    { $bitXor: [1, 2, 4] },
    { $bitXor: [2147483647, -2147483648] },
  ],
  $bitNot: [{ $bitNot: 5 }, { $bitNot: -1 }, { $bitNot: 0 }, { $bitNot: 2147483647 }, { $bitNot: -2147483648 }],

  // ── comparison ─────────────────────────────────────────────────────────────
  $eq: [
    { $eq: [1, 1] },
    { $eq: [1, 1.5] },
    { $eq: ["a", "a"] },
    { $eq: [null, null] },
    { $eq: [null, 1] },
    {
      $eq: [
        [1, [2]],
        [1, [2]],
      ],
    },
    {
      $eq: [
        { a: 1, b: 2 },
        { b: 2, a: 1 },
      ],
    },
    {
      $eq: [
        { a: 1, b: 2 },
        { a: 1, b: 2 },
      ],
    },
    { $eq: [new Date(5000), new Date(5000)] },
    { $eq: [new ObjectId(OID), new ObjectId(OID)] },
    { $eq: [ASTRAL, ASTRAL] },
  ],
  $ne: [{ $ne: [1, 2] }, { $ne: ["a", "a"] }, { $ne: [[1], [1]] }, { $ne: [null, 0] }, { $ne: [{ a: 1 }, { a: 2 }] }],
  $gt: [
    { $gt: [2, 1] },
    { $gt: ["b", "a"] },
    { $gt: [ASTRAL, LIGATURE] },
    { $gt: [true, false] },
    { $gt: [null, null] },
    { $gt: [1, null] },
    {
      $gt: [
        [1, 3],
        [1, 2],
      ],
    },
    { $gt: [new Date(9000), new Date(5000)] },
  ],
  $gte: [
    { $gte: [2, 2] },
    { $gte: ["a", "b"] },
    { $gte: [null, null] },
    { $gte: [[1], [1, 0]] },
    { $gte: [new ObjectId(OID), new ObjectId(OID)] },
  ],
  $lt: [
    { $lt: [1, 2] },
    { $lt: [LIGATURE, ASTRAL] },
    { $lt: ["a", "B"] },
    { $lt: [false, true] },
    { $lt: [null, 1] },
    { $lt: [[], [null]] },
    { $lt: [[null], [1]] },
    { $lt: ["", "a"] },
  ],
  $lte: [
    { $lte: [1, 1] },
    { $lte: ["b", "a"] },
    { $lte: [-5, -4.5] },
    { $lte: [null, null] },
    {
      $lte: [
        [1, 2],
        [1, 2, 0],
      ],
    },
  ],
  $cmp: [
    { $cmp: [1, 2] },
    { $cmp: ["b", "a"] },
    { $cmp: [null, 1] },
    { $cmp: [null, null] },
    { $cmp: [[2], [1, 5]] },
    { $cmp: [true, false] },
    { $cmp: [ASTRAL, LIGATURE] },
    { $cmp: [1e300, 1e-300] },
  ],

  // ── logic, scope and constants ─────────────────────────────────────────────
  $and: [{ $and: [] }, { $and: [1, "a", [], ""] }, { $and: [true, 0] }, { $and: [null] }, { $and: [{}] }],
  $or: [{ $or: [] }, { $or: [0, null, false] }, { $or: [0, ""] }, { $or: [0, 2] }],
  $not: [{ $not: [0] }, { $not: [""] }, { $not: null }, { $not: [[]] }, { $not: [true] }, { $not: [{ a: 1 }] }],
  $cond: [
    { $cond: [true, 1, 2] },
    { $cond: [0, 1, 2] },
    { $cond: [null, 1, 2] },
    { $cond: [[], "yes", "no"] },
    { $cond: { if: "", then: 1, else: 2 } },
    { $cond: [{ $gt: [3, 2] }, { $add: [1, 1] }, 0] },
  ],
  $switch: [
    {
      $switch: {
        branches: [
          { case: false, then: 1 },
          { case: 1, then: 2 },
        ],
        default: 3,
      },
    },
    { $switch: { branches: [{ case: false, then: 1 }], default: 3 } },
    {
      $switch: {
        branches: [
          { case: { $gt: [5, 1] }, then: "big" },
          { case: true, then: { $divide: [1, 0] } },
        ],
      },
    },
    {
      $switch: {
        branches: [
          { case: null, then: 1 },
          { case: 0, then: 2 },
          { case: "", then: 3 },
        ],
      },
    },
  ],
  $ifNull: [
    { $ifNull: [null, 5] },
    { $ifNull: [0, 5] },
    { $ifNull: [null, null, 7] },
    { $ifNull: [null, null] },
    { $ifNull: ["", 1] },
  ],
  $let: [
    { $let: { vars: { x: 2 }, in: { $add: ["$$x", 1] } } },
    { $let: { vars: { x: 2, y: { $add: [1, 1] } }, in: { $multiply: ["$$x", "$$y"] } } },
    { $let: { vars: { x: 1 }, in: { $let: { vars: { x: { $add: ["$$x", 1] } }, in: "$$x" } } } },
    { $let: { vars: {}, in: 5 } },
    { $let: { vars: { doc: { a: { b: 7 } } }, in: "$$doc.a.b" } },
    { $let: { vars: { a1_B: "z" }, in: { $concat: ["$$a1_B", "y"] } } },
  ],
  $literal: [
    { $literal: 1 },
    { $literal: "$a" },
    { $literal: { $add: [1, 2] } },
    { $literal: [1, "$b", { $c: 1 }] },
    { $literal: { "a.b": 1 } },
    { $literal: null },
  ],

  // ── arrays ─────────────────────────────────────────────────────────────────
  $size: [
    { $size: [[1, 2]] },
    { $size: [[]] },
    { $size: [[null]] },
    { $size: [[[1, 2], [3]]] },
    { $size: [[ASTRAL, "a"]] },
  ],
  $arrayElemAt: [
    { $arrayElemAt: [[1, 2, 3], 0] },
    { $arrayElemAt: [[1, 2, 3], -1] },
    { $arrayElemAt: [[1, 2, 3], 2] },
    { $arrayElemAt: [null, 0] },
    { $arrayElemAt: [[1, 2], null] },
    { $arrayElemAt: [[[1], [2]], 1] },
    { $arrayElemAt: [[null], 0] },
  ],
  $first: [
    { $first: [[1, 2]] },
    { $first: [[null]] },
    { $first: [null] },
    { $first: [[[1], 2]] },
    { $first: [[{ a: 1 }]] },
  ],
  $last: [{ $last: [[1, 2]] }, { $last: [[null]] }, { $last: [null] }, { $last: [[1, [2]]] }, { $last: [["a"]] }],
  $firstN: [
    { $firstN: { n: 2, input: [1, 2, 3] } },
    { $firstN: { n: 5, input: [1, 2, 3] } },
    { $firstN: { n: 1, input: [] } },
    { $firstN: { n: 2, input: [[1], null, "a"] } },
  ],
  $lastN: [
    { $lastN: { n: 2, input: [1, 2, 3] } },
    { $lastN: { n: 5, input: [1, 2, 3] } },
    { $lastN: { n: 2, input: [] } },
    { $lastN: { n: 1, input: [[1], null, "a"] } },
  ],
  $slice: [
    { $slice: [[1, 2, 3, 4], 2] },
    { $slice: [[1, 2, 3, 4], -2] },
    { $slice: [[1, 2, 3, 4], 0] },
    { $slice: [[1, 2, 3, 4], -10] },
    { $slice: [[1, 2, 3, 4], 1, 2] },
    { $slice: [[1, 2, 3, 4], -3, 2] },
    { $slice: [[1, 2, 3, 4], -10, 2] },
    { $slice: [[1, 2, 3, 4], 10, 2] },
    { $slice: [null, 1] },
    { $slice: [[], 1, 1] },
  ],
  $concatArrays: [
    { $concatArrays: [] },
    { $concatArrays: [[1], [2, 3]] },
    { $concatArrays: [[1], null] },
    { $concatArrays: [[[1]]] },
    { $concatArrays: [[], []] },
    { $concatArrays: [[[1]], [[2]]] },
  ],
  $reverseArray: [
    { $reverseArray: [[1, 2, 3]] },
    { $reverseArray: [[]] },
    { $reverseArray: [null] },
    { $reverseArray: [[1, [2, 3]]] },
  ],
  $range: [
    { $range: [0, 5] },
    { $range: [0, 10, 3] },
    { $range: [5, 0, -2] },
    { $range: [5, 0] },
    { $range: [0, 0] },
    { $range: [-3, 3, 2] },
    { $range: [-2147483648, -2147483645] },
    { $range: [2147483645, 2147483647] },
  ],
  $in: [
    { $in: [1, [1, 2]] },
    { $in: [3, [1, 2]] },
    { $in: [[1], [[1]]] },
    { $in: [null, [null]] },
    { $in: [{ a: 1 }, [{ a: 1 }]] },
    { $in: [1, []] },
    { $in: ["a", [1, "a"]] },
    { $in: [ASTRAL, ["a", ASTRAL]] },
  ],
  $indexOfArray: [
    { $indexOfArray: [[1, 2, 3], 3] },
    { $indexOfArray: [[1, 2, 3], 9] },
    { $indexOfArray: [null, 1] },
    { $indexOfArray: [[1, 2, 1], 1, 1] },
    { $indexOfArray: [[1, 2, 1], 1, 1, 2] },
    { $indexOfArray: [[1, 2, 1], 1, 0, 100] },
    { $indexOfArray: [[[1]], [1]] },
    { $indexOfArray: [[1, 2, 1], 1, 10] },
  ],
  $isArray: [
    { $isArray: [[1]] },
    { $isArray: [1] },
    { $isArray: [null] },
    { $isArray: ["a"] },
    { $isArray: [{}] },
    { $isArray: [[]] },
  ],
  $map: [
    { $map: { input: [1, 2, 3], in: { $multiply: ["$$this", 2] } } },
    { $map: { input: [1, 2], as: "x", in: { $add: ["$$x", 1] } } },
    { $map: { input: null, in: 1 } },
    { $map: { input: [], in: 1 } },
    { $map: { input: [[1, 2], [3]], as: "r", in: { $map: { input: "$$r", in: { $add: ["$$this", 10] } } } } },
    {
      $map: {
        input: [1, 2],
        in: { $let: { vars: { y: { $add: ["$$this", 1] } }, in: { $multiply: ["$$y", "$$y"] } } },
      },
    },
    { $map: { input: ["a", ASTRAL], in: { $strLenCP: "$$this" } } },
  ],
  $filter: [
    { $filter: { input: [1, 2, 3, 4], cond: { $gt: ["$$this", 2] } } },
    { $filter: { input: [1, 2, 3, 4], as: "n", cond: { $gt: ["$$n", 2] }, limit: 1 } },
    { $filter: { input: [0, 1, "", null, "a", [], false], cond: "$$this" } },
    { $filter: { input: null, cond: true } },
    { $filter: { input: [1, 2], cond: true, limit: null } },
    { $filter: { input: [1, 2, 3], cond: true, limit: 10 } },
    { $filter: { input: [], cond: true } },
  ],
  $reduce: [
    { $reduce: { input: [1, 2, 3], initialValue: 0, in: { $add: ["$$value", "$$this"] } } },
    { $reduce: { input: [], initialValue: 7, in: 1 } },
    { $reduce: { input: null, initialValue: 0, in: 1 } },
    { $reduce: { input: ["a", "b"], initialValue: "", in: { $concat: ["$$value", "$$this"] } } },
    { $reduce: { input: [1, 2], initialValue: [], in: { $concatArrays: ["$$value", [["$$this"]]] } } },
    { $reduce: { input: [1, 2, 3], initialValue: { n: 0 }, in: { n: { $add: ["$$value.n", "$$this"] } } } },
  ],
  $zip: [
    {
      $zip: {
        inputs: [
          [1, 2],
          ["a", "b"],
        ],
      },
    },
    { $zip: { inputs: [[1, 2, 3], ["a"]] } },
    { $zip: { inputs: [[1, 2, 3], ["a"]], useLongestLength: true } },
    { $zip: { inputs: [[1, 2, 3], ["a"]], useLongestLength: true, defaults: [0, "z"] } },
    { $zip: { inputs: [[1], null] } },
    { $zip: { inputs: [[1, 2]] } },
    { $zip: { inputs: [[], []] } },
  ],
  $sortArray: [
    { $sortArray: { input: [3, 1, 2], sortBy: 1 } },
    { $sortArray: { input: [3, 1, 2], sortBy: -1 } },
    { $sortArray: { input: ["b", "a", ASTRAL, LIGATURE], sortBy: 1 } },
    {
      $sortArray: {
        input: [
          { a: 2, i: 0 },
          { a: 1, i: 1 },
          { a: 2, i: 2 },
          { a: 1, i: 3 },
        ],
        sortBy: { a: 1 },
      },
    },
    {
      $sortArray: {
        input: [
          { a: 2, i: 0 },
          { a: 1, i: 1 },
          { a: 2, i: 2 },
          { a: 1, i: 3 },
        ],
        sortBy: { a: -1 },
      },
    },
    {
      $sortArray: {
        input: [
          { a: 2, b: 1 },
          { a: 1, b: 2 },
          { a: 2, b: 0 },
        ],
        sortBy: { a: 1, b: -1 },
      },
    },
    { $sortArray: { input: [{ a: { c: 2 } }, { a: { c: 1 } }], sortBy: { "a.c": 1 } } },
    { $sortArray: { input: null, sortBy: 1 } },
    { $sortArray: { input: [], sortBy: 1 } },
    { $sortArray: { input: [true, false], sortBy: 1 } },
    { $sortArray: { input: [1.5, 1, -2, 1e10], sortBy: -1 } },
  ],
  $maxN: [
    { $maxN: { input: [3, 1, 2], n: 2 } },
    { $maxN: { input: [1, null, 3], n: 5 } },
    { $maxN: { input: [], n: 2 } },
    { $maxN: { input: ["b", "a", ASTRAL], n: 2 } },
    { $maxN: { input: [3, 3, 1], n: 2 } },
    { $maxN: { input: [-1.5, -2], n: 1 } },
  ],
  $minN: [
    { $minN: { input: [3, 1, 2], n: 2 } },
    { $minN: { input: [3, 1, 2, 1], n: 3 } },
    { $minN: { input: [], n: 2 } },
    { $minN: { input: ["b", "a", LIGATURE, ASTRAL], n: 3 } },
    { $minN: { input: [null, 5, null], n: 2 } },
  ],
  $allElementsTrue: [
    { $allElementsTrue: [[]] },
    { $allElementsTrue: [[1, true, "a"]] },
    { $allElementsTrue: [[1, 0]] },
    { $allElementsTrue: [[null]] },
    { $allElementsTrue: [[[], {}, ""]] },
  ],
  $anyElementTrue: [
    { $anyElementTrue: [[]] },
    { $anyElementTrue: [[0, null, false]] },
    { $anyElementTrue: [[0, 1]] },
    { $anyElementTrue: [[""]] },
    { $anyElementTrue: [[[]]] },
  ],
  $setUnion: [
    { $setUnion: [] },
    { $setUnion: [[1, 2, 2]] },
    {
      $setUnion: [
        [3, 1],
        [2, 1, 3, 3],
      ],
    },
    { $setUnion: [[1], null] },
    { $setUnion: [[[1]], [[1], [2]]] },
    { $setUnion: [[{ a: 1 }], [{ a: 1 }]] },
    {
      $setUnion: [
        [1, "a"],
        ["a", null],
      ],
    },
    { $setUnion: [[ASTRAL], [ASTRAL, LIGATURE]] },
  ],
  $setIntersection: [
    { $setIntersection: [] },
    {
      $setIntersection: [
        [3, 1, 2],
        [2, 3, 4],
      ],
    },
    { $setIntersection: [[1, 1, 2], [1]] },
    { $setIntersection: [[1], null] },
    { $setIntersection: [[1, 2], [2], [2, 3]] },
    { $setIntersection: [[1, 2]] },
  ],
  $setDifference: [
    { $setDifference: [[1, 2, 3], [2]] },
    { $setDifference: [[1, 1, 2], [3]] },
    { $setDifference: [[1], null] },
    { $setDifference: [null, [1]] },
    { $setDifference: [[], [1]] },
    { $setDifference: [[[1], [2]], [[2]]] },
  ],
  $setEquals: [
    {
      $setEquals: [
        [1, 2],
        [2, 1, 1],
      ],
    },
    { $setEquals: [[1], [2]] },
    { $setEquals: [[1], [1], [1]] },
    { $setEquals: [[], []] },
    { $setEquals: [[1, 2], [1]] },
  ],
  $setIsSubset: [
    { $setIsSubset: [[1], [1, 2]] },
    {
      $setIsSubset: [
        [1, 3],
        [1, 2],
      ],
    },
    { $setIsSubset: [[], [1]] },
    { $setIsSubset: [[1, 1], [1]] },
    { $setIsSubset: [[[1]], [[1], 2]] },
  ],

  // ── documents ──────────────────────────────────────────────────────────────
  $objectToArray: [
    { $objectToArray: { a: 1, b: 2 } },
    { $objectToArray: {} },
    { $objectToArray: null },
    { $objectToArray: { a: { b: 1 } } },
    { $objectToArray: { b: 1, a: [1, 2] } },
  ],
  $arrayToObject: [
    {
      $arrayToObject: [
        [
          ["a", 1],
          ["b", 2],
        ],
      ],
    },
    {
      $arrayToObject: [
        [
          { k: "a", v: 1 },
          { k: "b", v: 2 },
        ],
      ],
    },
    { $arrayToObject: [[]] },
    { $arrayToObject: [null] },
    {
      $arrayToObject: [
        [
          ["a", 1],
          ["b", 2],
          ["a", 3],
        ],
      ],
    },
    { $arrayToObject: [[["a.b", 1]]] },
    { $arrayToObject: [[["", 1]]] },
    {
      $arrayToObject: [
        [
          ["a", null],
          [ASTRAL, [1]],
        ],
      ],
    },
  ],
  $mergeObjects: [
    { $mergeObjects: [] },
    { $mergeObjects: [{ a: 1 }, { b: 2 }] },
    {
      $mergeObjects: [
        { a: 1, b: 1 },
        { b: 2, c: 3 },
      ],
    },
    { $mergeObjects: [{ a: 1 }, null] },
    { $mergeObjects: [null, null] },
    { $mergeObjects: [[{ a: 1 }, { b: 2 }]] },
    { $mergeObjects: [{ a: { x: 1 } }, { a: { y: 2 } }] },
    { $mergeObjects: { a: 1 } },
  ],
  $getField: [
    { $getField: { field: "a", input: { a: 1 } } },
    { $getField: { field: "a", input: null } },
    { $getField: { field: "a", input: { a: null } } },
    { $getField: { field: "a", input: { b: 0, a: [1, { c: 2 }] } } },
    { $getField: { field: { $literal: "a.b" }, input: { $literal: { "a.b": 7, a: { b: 8 } } } } },
    { $getField: { field: ASTRAL, input: { [ASTRAL]: "x" } } },
  ],
  $setField: [
    { $setField: { field: "a", input: { a: 1, b: 2 }, value: 5 } },
    { $setField: { field: "c", input: { a: 1 }, value: 5 } },
    { $setField: { field: "a", input: null, value: 5 } },
    { $setField: { field: "a", input: { a: 1, b: 2 }, value: { x: 1 } } },
    { $setField: { field: "a", input: {}, value: null } },
    { $setField: { field: { $literal: "a.b" }, input: {}, value: 1 } },
  ],
  $unsetField: [
    { $unsetField: { field: "a", input: { a: 1, b: 2 } } },
    { $unsetField: { field: "c", input: { a: 1 } } },
    { $unsetField: { field: "a", input: null } },
    { $unsetField: { field: "a", input: { a: 1 } } },
    { $unsetField: { field: "b", input: { a: 1, b: { c: 2 }, d: 3 } } },
  ],

  // ── strings ────────────────────────────────────────────────────────────────
  $concat: [
    { $concat: ["a", "b"] },
    { $concat: [] },
    { $concat: ["a", null] },
    { $concat: [ASTRAL, ACCENT] },
    { $concat: "a" },
    { $concat: ["", ""] },
  ],
  $toUpper: [
    { $toUpper: "aBc" },
    { $toUpper: `${ACCENT}a${ASTRAL}ß` },
    { $toUpper: null },
    { $toUpper: "" },
    { $toUpper: "ǆ" },
  ],
  $toLower: [
    { $toLower: "ABC É" },
    { $toLower: "İΣ" },
    { $toLower: null },
    { $toLower: "" },
    { $toLower: `A${ASTRAL}B` },
  ],
  $trim: [
    { $trim: { input: "  a  " } },
    { $trim: { input: SPACES + "x" + SPACES } },
    { $trim: { input: "xxaxx", chars: "x" } },
    { $trim: { input: "xyaxy", chars: "xy" } },
    { $trim: { input: `${ASTRAL}a${ASTRAL}`, chars: ASTRAL } },
    { $trim: { input: `${ACCENT}a${ACCENT}`, chars: ACCENT } },
    { $trim: { input: "abc", chars: "" } },
    { $trim: { input: "ab", chars: "ab" } },
    { $trim: { input: " a ", chars: "." } },
    { $trim: { input: "" } },
  ],
  $ltrim: [
    { $ltrim: { input: "  a  " } },
    { $ltrim: { input: "xxa", chars: "x" } },
    { $ltrim: { input: SPACES + "x" + SPACES } },
    { $ltrim: { input: `${ASTRAL}${ASTRAL}a`, chars: ASTRAL } },
  ],
  $rtrim: [
    { $rtrim: { input: "  a  " } },
    { $rtrim: { input: "axx", chars: "x" } },
    { $rtrim: { input: SPACES + "x" + SPACES } },
    { $rtrim: { input: `a${ASTRAL}${ASTRAL}`, chars: ASTRAL } },
  ],
  $strLenCP: [
    { $strLenCP: "abc" },
    { $strLenCP: `${ASTRAL}${ACCENT}` },
    { $strLenCP: "" },
    { $strLenCP: `a${ASTRAL}b${ASTRAL}` },
  ],
  $strLenBytes: [
    { $strLenBytes: `${ASTRAL}${ACCENT}` },
    { $strLenBytes: "abc" },
    { $strLenBytes: "" },
    { $strLenBytes: LIGATURE },
  ],
  $substrCP: [
    { $substrCP: ["abcd", 1, 2] },
    { $substrCP: ["abcd", 1, 100] },
    { $substrCP: ["abcd", 10, 2] },
    { $substrCP: [`${ASTRAL}${ACCENT}${ASTRAL}`, 1, 1] },
    { $substrCP: ["abcd", 0, 0] },
    { $substrCP: ["abc", 3, 1] },
    { $substrCP: [`${ASTRAL}${ASTRAL}`, 0, 1] },
  ],
  $substrBytes: [
    { $substrBytes: ["abcd", 1, 2] },
    { $substrBytes: [ACCENT, 0, 2] },
    { $substrBytes: [`a${ACCENT}`, 1, 2] },
    { $substrBytes: ["abc", 1, -1] },
    { $substrBytes: ["abc", 1, 100] },
    { $substrBytes: ["abc", 10, 1] },
    { $substrBytes: [ASTRAL, 0, 4] },
    { $substrBytes: [`${ASTRAL}a`, 4, 1] },
  ],
  $substr: [
    { $substr: ["abcd", 1, 2] },
    { $substr: ["abcd", 1, -1] },
    { $substr: [`a${ACCENT}`, 1, 2] },
    { $substr: ["abc", 5, 1] },
  ],
  $indexOfCP: [
    { $indexOfCP: ["abcabc", "c"] },
    { $indexOfCP: ["abcabc", "c", 3] },
    { $indexOfCP: ["abc", "d"] },
    { $indexOfCP: [`${ASTRAL}a${ASTRAL}`, "a"] },
    { $indexOfCP: [`${ASTRAL}a${ASTRAL}`, ASTRAL, 1] },
    { $indexOfCP: [null, "a"] },
    { $indexOfCP: ["abc", "a", 10] },
    { $indexOfCP: ["abcabc", "bc", 2] },
  ],
  $indexOfBytes: [
    { $indexOfBytes: ["abcabc", "c"] },
    { $indexOfBytes: [`${ACCENT}${ASTRAL}a`, "a"] },
    { $indexOfBytes: [`${ACCENT}${ASTRAL}a`, ASTRAL] },
    { $indexOfBytes: [`${ACCENT}a`, "a", 1] },
    { $indexOfBytes: ["abc", "bc", 0, 2] },
    { $indexOfBytes: ["abc", "c", 2, 3] },
    { $indexOfBytes: ["abc", "a", 2, 1] },
    { $indexOfBytes: [null, "a"] },
  ],
  $split: [
    { $split: ["a,b,c", ","] },
    { $split: ["", ","] },
    { $split: ["a,,b", ","] },
    { $split: ["a--b--c", "--"] },
    { $split: [`a${ASTRAL}b`, ASTRAL] },
    { $split: ["aaa", "aa"] },
    { $split: ["a", "a"] },
  ],
  $replaceOne: [
    { $replaceOne: { input: "abcabc", find: "b", replacement: "X" } },
    { $replaceOne: { input: "abc", find: "z", replacement: "X" } },
    { $replaceOne: { input: `a${ASTRAL}b${ASTRAL}`, find: ASTRAL, replacement: ACCENT } },
    { $replaceOne: { input: "abc", find: "b", replacement: "" } },
    { $replaceOne: { input: "a.b", find: ".", replacement: { $literal: "$&" } } },
  ],
  $replaceAll: [
    { $replaceAll: { input: "abcabc", find: "b", replacement: "X" } },
    { $replaceAll: { input: "aaa", find: "aa", replacement: "b" } },
    { $replaceAll: { input: `a${ASTRAL}b${ASTRAL}`, find: ASTRAL, replacement: ACCENT } },
    { $replaceAll: { input: "abab", find: "ab", replacement: "abab" } },
    { $replaceAll: { input: "abc", find: "b", replacement: "" } },
    { $replaceAll: { input: "", find: "a", replacement: "b" } },
  ],
  $strcasecmp: [
    { $strcasecmp: ["a", "B"] },
    { $strcasecmp: ["B", "a"] },
    { $strcasecmp: ["a", "A"] },
    { $strcasecmp: ["_", "a"] },
    { $strcasecmp: [ACCENT, "É"] },
    { $strcasecmp: ["abc", "abcd"] },
    { $strcasecmp: ["", "a"] },
    { $strcasecmp: [ASTRAL, LIGATURE] },
  ],
  $toString: [
    { $toString: 1 },
    { $toString: -5 },
    { $toString: "a" },
    { $toString: true },
    { $toString: null },
    { $toString: 123456789012345 },
    { $toString: 9007199254740991 },
    { $toString: ASTRAL },
  ],

  // ── types ──────────────────────────────────────────────────────────────────
  $type: [
    { $type: 1 },
    { $type: 1.5 },
    { $type: 3000000000 },
    { $type: -2147483648 },
    { $type: "a" },
    { $type: true },
    { $type: null },
    { $type: [[1]] },
    { $type: { a: 1 } },
    { $type: new Date(0) },
    { $type: new ObjectId(OID) },
    { $type: new Long(5) },
  ],
  $isNumber: [
    { $isNumber: 1 },
    { $isNumber: "1" },
    { $isNumber: null },
    { $isNumber: true },
    { $isNumber: new Int32(1) },
    { $isNumber: new Long(1) },
    { $isNumber: new Double(1) },
    { $isNumber: new Decimal128("1") },
    { $isNumber: new Date(0) },
  ],
  $toBool: [
    { $toBool: 0 },
    { $toBool: 1 },
    { $toBool: "" },
    { $toBool: "false" },
    { $toBool: null },
    { $toBool: {} },
    { $toBool: [[]] },
    { $toBool: false },
    { $toBool: 0.5 },
    { $toBool: new Date(0) },
  ],
  $toObjectId: [
    { $toObjectId: OID },
    { $toObjectId: OID.toUpperCase() },
    { $toObjectId: null },
    { $toObjectId: new ObjectId(OID) },
  ],

  $toInt: [
    { $toInt: 4.5 },
    { $toInt: -4.5 },
    { $toInt: -0.5 },
    { $toInt: 2147483647 },
    { $toInt: -2147483648 },
    { $toInt: true },
    { $toInt: false },
    { $toInt: null },
    { $toInt: "5" },
    { $toInt: "+5" },
    { $toInt: "007" },
    { $toInt: "-0" },
  ],

  // ── regular expressions ────────────────────────────────────────────────────
  $regexMatch: [
    { $regexMatch: { input: "abc", regex: "^ab?c$" } },
    { $regexMatch: { input: "Abc", regex: "^[a-c]+$", options: "i" } },
    { $regexMatch: { input: "abc\n", regex: "c$" } },
    { $regexMatch: { input: "é", regex: "\\w" } },
    { $regexMatch: { input: "x1", regex: "^\\w\\d$" } },
    { $regexMatch: { input: "", regex: "^$" } },
    { $regexMatch: { input: null, regex: "a" } },
    { $regexMatch: { input: "ab", regex: "a(?=b)" } },
    { $regexMatch: { input: "ab", regex: "a(?!b)" } },
    { $regexMatch: { input: "a-b", regex: "^[a\\-b]+$" } },
    { $regexMatch: { input: "😀", regex: "^[^a]$" } },
    { $regexMatch: { input: "ſ", regex: "s", options: "" } },
  ],
  $regexFind: [
    { $regexFind: { input: "xyz", regex: "y" } },
    { $regexFind: { input: "xyz", regex: "(a)|(y)" } },
    { $regexFind: { input: "é😀z", regex: "z" } },
    { $regexFind: { input: "é😀z", regex: "(?=z)" } },
    { $regexFind: { input: "", regex: "" } },
    { $regexFind: { input: "abc", regex: "x" } },
    { $regexFind: { input: null, regex: "a" } },
    { $regexFind: { input: "aBc", regex: "b", options: "i" } },
    { $regexFind: { input: "ab12", regex: "[0-9]+" } },
    { $regexFind: { input: "xy", regex: "(a)?y(z)?" } },
    { $regexFind: { input: "a\n", regex: "(a)$" } },
    { $regexFind: { input: "aaa", regex: "a{2}" } },
  ],
  $regexFindAll: [
    { $regexFindAll: { input: "aaa", regex: "a" } },
    { $regexFindAll: { input: "aaaa", regex: "aa|a" } },
    { $regexFindAll: { input: "baaa", regex: "a*" } },
    { $regexFindAll: { input: "abc", regex: "" } },
    { $regexFindAll: { input: "aaa", regex: "(?=aa)" } },
    { $regexFindAll: { input: "a😀b", regex: "a*|x" } },
    { $regexFindAll: { input: "😀😀", regex: "x*" } },
    { $regexFindAll: { input: null, regex: "a" } },
    { $regexFindAll: { input: "", regex: "" } },
    { $regexFindAll: { input: "aXXb", regex: "X*" } },
    { $regexFindAll: { input: "abc", regex: "[A-Z]?[a-z]+|[0-9]+", options: "i" } },
    { $regexFindAll: { input: "fooBar-baz 9", regex: "[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[A-Z]|[0-9]+" } },
  ],

  // ── accumulators, in their expression form ─────────────────────────────────
  $sum: [
    { $sum: [1, 2, 3] },
    { $sum: [[1, 2, 3]] },
    { $sum: [] },
    { $sum: [[]] },
    { $sum: [1, "a", null, 2] },
    { $sum: [[1, "a", null, 2]] },
    { $sum: 5 },
    { $sum: "a" },
    { $sum: [[1, [2, 3]]] },
    { $sum: [0.1, 0.2] },
    { $sum: [1.5] },
    { $sum: [2147483647, 1] },
  ],
  $avg: [
    { $avg: [1, 2] },
    { $avg: [[1, 2, 4]] },
    { $avg: [] },
    { $avg: [[]] },
    { $avg: [1, "a"] },
    { $avg: [null] },
    { $avg: [[7, 8]] },
    { $avg: [[1, 1, 1, 2]] },
    { $avg: 5 },
    { $avg: [0.1, 0.2] },
  ],
  $max: [
    { $max: [1, 2] },
    { $max: [[1, 2]] },
    { $max: [] },
    { $max: [1, null] },
    { $max: [[null, null]] },
    { $max: [["a", "b"]] },
    { $max: [[ASTRAL, LIGATURE]] },
    { $max: [[true, false]] },
    { $max: [[new Date(5), new Date(9)]] },
    { $max: [[1.5, 1, -2]] },
    { $max: [[new ObjectId(OID), new ObjectId("507f1f77bcf86cd799439012")]] },
  ],
  $min: [
    { $min: [3, 1, 2] },
    { $min: [[3, 1, 2]] },
    { $min: [[]] },
    { $min: [[null, 2]] },
    { $min: [[ASTRAL, LIGATURE]] },
    { $min: [["b", "a"]] },
    { $min: [[new Date(5), new Date(9)]] },
    { $min: [[1.5, 1, -2]] },
    { $min: [[false, true]] },
  ],

  // ── dates ──────────────────────────────────────────────────────────────────
  ...Object.fromEntries(
    DATE_PARTS.map((op) => [
      op,
      [
        ...EDGE_DATES.map((d) => ({ [op]: d })),
        { [op]: [WHEN] },
        { [op]: { date: WHEN, timezone: "UTC" } },
        { [op]: null },
        { [op]: new ObjectId(OID) },
      ].slice(0, 12),
    ]),
  ),
  $dateToParts: [
    { $dateToParts: { date: WHEN } },
    { $dateToParts: { date: WHEN, iso8601: true } },
    { $dateToParts: { date: WHEN, iso8601: false, timezone: "UTC" } },
    { $dateToParts: { date: null } },
    { $dateToParts: { date: new Date("2021-01-03T00:00:00Z"), iso8601: true } },
    { $dateToParts: { date: new Date("2024-12-30T00:00:00Z"), iso8601: true } },
    { $dateToParts: { date: new Date("-000001-12-31T23:59:59.999Z") } },
    { $dateToParts: { date: new ObjectId(OID) } },
    { $dateToParts: { date: WHEN, timezone: "+0000" } },
    { $dateToParts: { date: WHEN, iso8601: null } },
  ],
  $dateFromParts: [
    { $dateFromParts: { year: 2024 } },
    { $dateFromParts: { year: 2024, month: 3, day: 10, hour: 13, minute: 45, second: 30, millisecond: 123 } },
    { $dateFromParts: { year: 2024, month: 13 } },
    { $dateFromParts: { year: 2024, month: 0, day: 0 } },
    { $dateFromParts: { year: 2024, month: 1, day: 32, hour: 24, minute: -1 } },
    { $dateFromParts: { year: 9999, month: 12, day: 31, hour: 24 } },
    { $dateFromParts: { year: 2024, month: 2, day: 30, timezone: "UTC" } },
    { $dateFromParts: { isoWeekYear: 2024 } },
    { $dateFromParts: { isoWeekYear: 2020, isoWeek: 53, isoDayOfWeek: 7 } },
    { $dateFromParts: { isoWeekYear: 2024, isoWeek: 0, isoDayOfWeek: 0, hour: 25 } },
    { $dateFromParts: { year: null, month: 1 } },
    { $dateFromParts: { year: { $divide: [4048, 2] }, month: { $divide: [6, 2] } } },
  ],
  $dateAdd: [
    { $dateAdd: { startDate: new Date("2024-01-31T10:00:00Z"), unit: "month", amount: 1 } },
    { $dateAdd: { startDate: new Date("2024-02-29T10:00:00Z"), unit: "year", amount: 1 } },
    { $dateAdd: { startDate: new Date("2024-08-31T10:00:00Z"), unit: "quarter", amount: 1 } },
    { $dateAdd: { startDate: new Date("2024-12-31T10:00:00Z"), unit: "month", amount: -14 } },
    { $dateAdd: { startDate: WHEN, unit: "week", amount: 2 } },
    { $dateAdd: { startDate: WHEN, unit: "day", amount: -400 } },
    { $dateAdd: { startDate: WHEN, unit: "hour", amount: 25 } },
    { $dateAdd: { startDate: WHEN, unit: "millisecond", amount: 1e12 } },
    { $dateAdd: { startDate: WHEN, unit: "second", amount: { $divide: [4, 2] }, timezone: "UTC" } },
    { $dateAdd: { startDate: new ObjectId(OID), unit: "minute", amount: 0 } },
    { $dateAdd: { startDate: WHEN, unit: "day", amount: null } },
    { $dateAdd: { startDate: null, unit: "day", amount: 1 } },
  ],
  $dateSubtract: [
    { $dateSubtract: { startDate: new Date("2024-03-31T10:00:00Z"), unit: "month", amount: 1 } },
    { $dateSubtract: { startDate: new Date("2024-02-29T10:00:00Z"), unit: "year", amount: 4 } },
    { $dateSubtract: { startDate: WHEN, unit: "quarter", amount: 5 } },
    { $dateSubtract: { startDate: WHEN, unit: "week", amount: -3 } },
    { $dateSubtract: { startDate: WHEN, unit: "day", amount: 0 } },
    { $dateSubtract: { startDate: WHEN, unit: "second", amount: 90, timezone: "+00:00" } },
    { $dateSubtract: { startDate: null, unit: "day", amount: 1 } },
    { $dateSubtract: { startDate: WHEN, unit: null, amount: 1 } },
  ],
  $dateDiff: [
    {
      $dateDiff: {
        startDate: new Date("2024-01-31T23:59:59.999Z"),
        endDate: new Date("2024-03-01T00:00:00.001Z"),
        unit: "month",
      },
    },
    {
      $dateDiff: {
        startDate: new Date("2024-03-01T00:00:00.001Z"),
        endDate: new Date("2024-01-31T23:59:59.999Z"),
        unit: "day",
      },
    },
    {
      $dateDiff: {
        startDate: new Date("2023-12-31T23:59:59Z"),
        endDate: new Date("2024-01-01T00:00:00Z"),
        unit: "year",
      },
    },
    {
      $dateDiff: {
        startDate: new Date("2024-03-31T00:00:00Z"),
        endDate: new Date("2024-04-01T00:00:00Z"),
        unit: "quarter",
      },
    },
    {
      $dateDiff: {
        startDate: new Date("2024-03-09T10:00:00Z"),
        endDate: new Date("2024-03-11T10:00:00Z"),
        unit: "week",
      },
    },
    {
      $dateDiff: {
        startDate: new Date("2024-03-09T10:00:00Z"),
        endDate: new Date("2024-03-11T10:00:00Z"),
        unit: "week",
        startOfWeek: "tuesday",
      },
    },
    { $dateDiff: { startDate: new Date(-1), endDate: new Date(0), unit: "second" } },
    { $dateDiff: { startDate: new Date(0), endDate: WHEN, unit: "millisecond", timezone: "UTC" } },
    { $dateDiff: { startDate: new Date(0), endDate: WHEN, unit: "hour" } },
    { $dateDiff: { startDate: new ObjectId(OID), endDate: WHEN, unit: "minute" } },
    { $dateDiff: { startDate: null, endDate: WHEN, unit: "day" } },
    { $dateDiff: { startDate: WHEN, endDate: WHEN, unit: "week", startOfWeek: null } },
  ],
  $dateTrunc: [
    { $dateTrunc: { date: WHEN, unit: "year" } },
    { $dateTrunc: { date: WHEN, unit: "quarter" } },
    { $dateTrunc: { date: WHEN, unit: "week" } },
    { $dateTrunc: { date: WHEN, unit: "week", startOfWeek: "wednesday" } },
    { $dateTrunc: { date: WHEN, unit: "day", binSize: 7 } },
    { $dateTrunc: { date: WHEN, unit: "hour", binSize: 5, timezone: "UTC" } },
    { $dateTrunc: { date: WHEN, unit: "millisecond", binSize: 7 } },
    { $dateTrunc: { date: WHEN, unit: "month", binSize: 5 } },
    { $dateTrunc: { date: new Date("1960-07-04T10:00:00Z"), unit: "year", binSize: 7 } },
    { $dateTrunc: { date: new Date("1960-07-04T10:00:00Z"), unit: "week", binSize: 5, startOfWeek: "saturday" } },
    { $dateTrunc: { date: null, unit: "day" } },
    { $dateTrunc: { date: WHEN, unit: "day", binSize: null } },
  ],
  $dateToString: [
    { $dateToString: { date: WHEN } },
    { $dateToString: { date: WHEN, format: "%Y-%m-%d %H:%M:%S.%L" } },
    { $dateToString: { date: WHEN, format: "%b %B %j %w %u %U %V %G %z %Z %%" } },
    { $dateToString: { date: new Date("2021-01-03T00:00:00Z"), format: "%G-W%V-%u %U" } },
    { $dateToString: { date: WHEN, format: "plain é 😀", timezone: "UTC" } },
    { $dateToString: { date: new Date("+010000-06-01T00:00:00Z"), format: "%m-%d" } },
    { $dateToString: { date: new Date("0005-01-01T00:00:00Z"), format: "%Y %G" } },
    { $dateToString: { date: null } },
    { $dateToString: { date: null, onNull: "none" } },
    { $dateToString: { date: WHEN, format: null } },
    { $dateToString: { date: WHEN, onNull: "none" } },
    { $dateToString: { date: new ObjectId(OID), format: "%Y-%m-%d" } },
  ],
  $dateFromString: [
    { $dateFromString: { dateString: "2024-03-10" } },
    { $dateFromString: { dateString: "2024-03-10T13:45:30.123Z" } },
    { $dateFromString: { dateString: "2024-03-10T13:45" } },
    { $dateFromString: { dateString: "2024-03-10T13:45:30.1" } },
    { $dateFromString: { dateString: "2024-03-10T13:45:30+01:00" } },
    { $dateFromString: { dateString: "2024-03-10T13:45:30-05:30", timezone: "UTC" } },
    { $dateFromString: { dateString: null } },
    { $dateFromString: { dateString: null, onNull: "none" } },
    { $dateFromString: { dateString: "2024-02-30", onError: "bad" } },
    { $dateFromString: { dateString: "2024-03-10T24:00:00Z", onError: null } },
    { $dateFromString: { dateString: 5, onError: "bad" } },
    { $dateFromString: { dateString: "2024-03-10", onError: "unused", onNull: "unused" } },
  ],
  $toDate: [
    { $toDate: 1710000000000.5 },
    { $toDate: -1.5 },
    { $toDate: 4294967296 },
    { $toDate: "2024-03-10T13:45:30.123Z" },
    { $toDate: "2024-03-10" },
    { $toDate: WHEN },
    { $toDate: new ObjectId(OID) },
    { $toDate: null },
    { $toDate: [4294967296] },
    { $toDate: { $divide: [10, 4] } },
  ],
  $tsSecond: [
    { $tsSecond: new Timestamp({ t: 1710000000, i: 7 }) },
    { $tsSecond: new Timestamp({ t: 0, i: 0 }) },
    { $tsSecond: new Timestamp({ t: 4294967295, i: 4294967295 }) },
    { $tsSecond: null },
    { $tsSecond: [new Timestamp({ t: 2147483648, i: 1 })] },
  ],
  $tsIncrement: [
    { $tsIncrement: new Timestamp({ t: 1710000000, i: 7 }) },
    { $tsIncrement: new Timestamp({ t: 0, i: 0 }) },
    { $tsIncrement: new Timestamp({ t: 4294967295, i: 4294967295 }) },
    { $tsIncrement: null },
    { $tsIncrement: new Timestamp({ t: 1, i: 2147483648 }) },
  ],
};

// ── the widened rules ─────────────────────────────────────────────────────────

/** One value of each kind that the server orders, for the pairs of kinds. A Long and a Decimal128 are numbers. */
const KINDS: readonly [string, unknown][] = [
  ["null", null],
  ["number", 5],
  ["fraction", -1.5],
  ["string", "a"],
  ["empty string", ""],
  ["document", { a: 1 }],
  ["empty document", {}],
  ["array", [1]],
  ["empty array", []],
  ["binData", new Binary(Buffer.from("a"))],
  ["ObjectId", new ObjectId(OID)],
  ["bool", true],
  ["false", false],
  ["date", new Date(5)],
  ["timestamp", new Timestamp({ t: 1, i: 1 })],
  ["regex", new BSONRegExp("a")],
  ["MinKey", new MinKey()],
  ["MaxKey", new MaxKey()],
  ["long", Long.fromNumber(7)],
  ["decimal", Decimal128.fromString("7.5")],
];

/** Two opaque values of one place: the interpreter refuses to order those, as the unit tests state. */
const opaque = (v: unknown): boolean =>
  rankOf(v) !== undefined &&
  !["null", "number", "fraction", "string", "empty string", "document", "empty document"].includes(
    KINDS.find(([, x]) => x === v)?.[0] ?? "",
  ) &&
  !(v instanceof Date) &&
  !(v instanceof ObjectId) &&
  typeof v !== "boolean" &&
  !Array.isArray(v);
const comparable = (a: unknown, b: unknown): boolean => rankOf(a) !== rankOf(b) || !(opaque(a) || opaque(b));

const pairsOf = (op: string): unknown[] =>
  KINDS.flatMap(([, a]) => KINDS.map(([, b]) => [a, b] as const))
    .filter(([a, b]) => comparable(a, b))
    .map(([a, b]) => ({ [op]: [a, b] }));

/** Documents and arrays that hold values of two kinds, and the field names that order a document. */
const NESTED: readonly [unknown, unknown][] = [
  [{ a: 1 }, { b: 0 }],
  [{ a: 1 }, { a: "x" }],
  [{ b: 1 }, { a: "x" }],
  [{ a: 1 }, { a: 1, b: 0 }],
  [{ a: null }, { b: null }],
  [{ ab: 1 }, { a: 1 }],
  [{ aé: 1 }, { "a😀": 1 }],
  [{ a: { b: 1 } }, { a: { b: 2 } }],
  [
    { a: 1, b: 2 },
    { b: 2, a: 1 },
  ],
  [{ a: [1] }, { a: [1, 0] }],
  [{}, { a: 1 }],
  [
    [1, "a"],
    [1, 2],
  ],
  [[1], [1, null]],
  [[], [null]],
  [[[]], [[null]]],
  [
    [1, 2],
    [1, [0]],
  ],
  [[{ a: 1 }], [{ a: 2 }]],
  [
    [new Date(1), 1],
    [new Date(1), "a"],
  ],
  [
    [Long.fromNumber(1), "a"],
    ["b", 1],
  ],
];

const NESTED_PAIRS = (op: string): unknown[] => NESTED.flatMap(([a, b]) => [{ [op]: [a, b] }, { [op]: [b, a] }]);

const SET = {
  $setUnion: [
    [3, 1],
    [2, 3],
  ],
};
const SET_OF_DOCS = {
  $setUnion: [
    [{ a: 1, b: 1 }],
    [
      { a: 1, b: 2 },
      { a: 0, b: 1 },
    ],
  ],
};
const PAIRS_OF_SET = { $map: { input: SET, as: "n", in: { k: { $toString: "$$n" }, v: { $multiply: ["$$n", 10] } } } };
const KEY_OF = (x: string) => ({ $ifNull: [{ $toString: { $mod: [x, 2] } }, "null"] });
const GROUPED = (value: unknown) => ({
  $arrayToObject: {
    $map: {
      input: { $setUnion: [{ $map: { input: [1, 2, 3, 4], as: "x", in: KEY_OF("$$x") } }, []] },
      as: "jsmqlKey",
      in: { k: "$$jsmqlKey", v: value },
    },
  },
});
const FILTERED = { $filter: { input: [1, 2, 3, 4], as: "x", cond: { $eq: [KEY_OF("$$x"), "$$jsmqlKey"] } } };
const FINITE = (x: number) => ({
  $and: [
    { $and: [{ $isNumber: x }, { $not: [{ $in: [{ $toString: x }, ["NaN", "Infinity", "-Infinity"]] }] }] },
    { $eq: [x, { $trunc: x }] },
  ],
});

/**
 * The cases of the rules that the interpreter runs on more than the battery of the operator
 * holds. A table here may hold more than twelve cases. Each case is a value that the interpreter answers.
 */
export const WIDENED: Readonly<Record<string, readonly unknown[]>> = {
  // Two kinds: equality is false, and an order follows the place of each kind in the BSON order.
  "$eq of every pair of kinds": pairsOf("$eq"),
  "$ne of every pair of kinds": pairsOf("$ne"),
  "$cmp of every pair of kinds": pairsOf("$cmp"),
  "$lt of every pair of kinds": pairsOf("$lt"),
  "$lte of every pair of kinds": pairsOf("$lte"),
  "$gt of every pair of kinds": pairsOf("$gt"),
  "$gte of every pair of kinds": pairsOf("$gte"),
  "$cmp of documents and arrays": NESTED_PAIRS("$cmp"),
  "$eq of documents and arrays": NESTED_PAIRS("$eq"),
  "$lt of documents and arrays": NESTED_PAIRS("$lt"),
  // The comparisons that the lowerings of HR5 write on any value.
  "$lte with null": [null, 0, "", "a", [], {}, false, new Date(0), new ObjectId(OID)].map((x) => ({ $lte: [x, null] })),
  "$ne with the empty string": [null, 0, "", "a", [], {}, false, new Date(0), new ObjectId(OID)].map((x) => ({
    $ne: [x, ""],
  })),

  // The text of a value of a BSON type, and the finite-number test that a lowering writes.
  $toString: [
    { $toString: new ObjectId(OID) },
    { $toString: new ObjectId("000000000000000000000000") },
    { $toString: Decimal128.fromString("1.50") },
    { $toString: Decimal128.fromString("-0") },
    { $toString: Decimal128.fromString("1E+3") },
    { $toString: Decimal128.fromString("1E-7") },
    { $toString: Decimal128.fromString("NaN") },
    { $toString: Decimal128.fromString("Infinity") },
    { $toString: Decimal128.fromString("123456789012345678901234567890.12") },
    { $toString: Long.fromString("9223372036854775807") },
    { $toString: Long.fromString("-9223372036854775808") },
    { $toString: new Int32(-7) },
    { $not: [{ $in: [{ $toString: 4.5 }, ["NaN", "Infinity", "-Infinity"]] }] },
    { $in: [{ $toString: 1e-7 }, ["NaN", "Infinity", "-Infinity"]] },
    { $eq: [{ $toString: 2.5 }, "NaN"] },
  ],
  "$and of the finite-number test": [4.5, 5, 0.1, -2.5, 1e300, 1e-7, 123456789.5, 1e21, 2147483648].map(FINITE),

  $toInt: [
    { $toInt: 0.5 },
    { $toInt: 2147483647.0 },
    { $toInt: -2147483647.5 },
    { $toInt: 2147483646.9999 },
    { $toInt: 1e-320 },
    { $toInt: "-2147483648" },
    { $toInt: "0000000000000000000000000005" },
    { $toInt: "+0" },
    { $toInt: "00" },
    { $toInt: { $ceil: { $divide: [{ $month: new Date("2020-03-05T20:30:40.123Z") }, 3] } } },
    { $toInt: { $ceil: { $divide: [{ $month: new Date("2020-12-05T20:30:40.123Z") }, 3] } } },
  ],

  // The patterns that the lowerings write, a non-ASCII subject, and each edge that the server measured.
  $regexFindAll: [
    ...["fooBar-baz 9", "XMLHttpRequest", "", "héllo wörld 😀 AbC", "user_name-2 HTTPServer", "__x__", "a1B2"].map(
      (input) => ({ $regexFindAll: { input, regex: "[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[A-Z]|[0-9]+" } }),
    ),
    { $regexFindAll: { input: "ab", regex: "b*" } },
    { $regexFindAll: { input: "ab", regex: "(?=$)".replace("(?=$)", "(?=$)") } },
    { $regexFindAll: { input: "ab", regex: "x*|b" } },
    { $regexFindAll: { input: "abab", regex: "(?=a)|b" } },
    { $regexFindAll: { input: "a😀", regex: "x*" } },
    { $regexFindAll: { input: "a😀", regex: "(?:😀)*".replace("😀", "x") } },
    { $regexFindAll: { input: "abc", regex: "(?!b)" } },
    { $regexFindAll: { input: "ab", regex: "(?=b)" } },
    { $regexFindAll: { input: "AbaB", regex: "b", options: "i" } },
    { $regexFindAll: { input: "a😀a", regex: "[^b]" } },
    { $regexFindAll: { input: "aaa", regex: "(a)" } },
    { $regexFindAll: { input: "abab", regex: "(a)(b)?" } },
  ],
  $regexFind: [
    { $regexFind: { input: "ab", regex: "(a)(?=(b))".replace("(?=(b))", "(?=b)") } },
    { $regexFind: { input: "b", regex: "(a)|b" } },
    { $regexFind: { input: "ab", regex: "(a)|b" } },
    { $regexFind: { input: "a\nb", regex: "^b" } },
    { $regexFind: { input: "a\nb", regex: "a$" } },
    { $regexFind: { input: "é😀z", regex: "[^a]z" } },
    { $regexFind: { input: "É", regex: "[a-z]", options: "i" } },
    { $regexFind: { input: "xé", regex: "\\w+" } },
    { $regexFind: { input: "a\u000bb", regex: "\\s" } },
    { $regexFind: { input: "a b", regex: "\\s" } },
    { $regexFind: { input: "٣", regex: "\\d" } },
    { $regexFind: { input: "ab-9", regex: "\\-[0-9]{1,2}" } },
    { $regexFind: { input: "aaaa", regex: "a{2,3}" } },
    { $regexFind: { input: "aaaa", regex: "a{2,}" } },
    { $regexFind: { input: "ab", regex: "(?:a|b)(?:a|b)" } },
    { $regexFind: { input: "a.b", regex: "a\\.b" } },
    { $regexFind: { input: "a/b", regex: "a\\/b" } },
    { $regexFind: { input: "a_b", regex: "a\\_b" } },
    { $regexFind: { input: "abc", regex: "" } },
  ],
  $regexMatch: [
    { $regexMatch: { input: "abc\n\n", regex: "c$" } },
    { $regexMatch: { input: "abc\r\n", regex: "c$" } },
    { $regexMatch: { input: "\n", regex: "^$" } },
    { $regexMatch: { input: "É", regex: "[a-z]", options: "i" } },
    { $regexMatch: { input: "İ", regex: "i", options: "i" } },
    { $regexMatch: { input: "ß", regex: "ss", options: "i" } },
    { $regexMatch: { input: "xyz", regex: "(x)(y)(z)" } },
    { $regexMatch: { input: "a", regex: "(?=a)a" } },
    { $regexMatch: { input: "a", regex: "(?!a)a" } },
    { $regexMatch: { input: "a-", regex: "[a-]{2}" } },
    { $regexMatch: { input: "-", regex: "[-a]" } },
    { $regexMatch: { input: "9", regex: "[^a-c\\d]" } },
    { $regexMatch: { input: "aB", regex: "A[b]", options: "i" } },
  ],

  // A set answer flows through the operators that read no order.
  "$map over a set": [
    PAIRS_OF_SET,
    { $map: { input: SET, in: { $add: ["$$this", 1] } } },
    { $size: { $map: { input: SET, in: "$$this" } } },
    { $sum: [{ $map: { input: SET, in: { $multiply: ["$$this", 2] } } }] },
    { $max: [{ $map: { input: SET, in: { $multiply: ["$$this", 2] } } }] },
    { $in: [4, { $map: { input: SET, in: { $add: ["$$this", 1] } } }] },
    { $allElementsTrue: [{ $map: { input: SET, in: { $gt: ["$$this", 0] } } }] },
    { $anyElementTrue: [{ $map: { input: SET, in: { $gt: ["$$this", 5] } } }] },
  ],
  "$filter over a set": [
    { $filter: { input: SET, cond: { $gt: ["$$this", 1] } } },
    { $filter: { input: SET, cond: true, limit: null } },
    { $size: { $filter: { input: SET, cond: { $gt: ["$$this", 1] } } } },
    { $filter: { input: { $map: { input: SET, in: { $multiply: ["$$this", 3] } } }, cond: { $lt: ["$$this", 8] } } },
  ],
  "$arrayToObject over a set": [
    { $arrayToObject: PAIRS_OF_SET },
    { $arrayToObject: { $map: { input: SET, as: "n", in: [{ $toString: "$$n" }, "$$n"] } } },
    { $objectToArray: { $arrayToObject: PAIRS_OF_SET } },
    { $size: { $objectToArray: { $arrayToObject: PAIRS_OF_SET } } },
    { $mergeObjects: [{ $arrayToObject: PAIRS_OF_SET }, { z: 1 }] },
    { $mergeObjects: [{ z: 1 }, { $arrayToObject: PAIRS_OF_SET }] },
    { $mergeObjects: { $map: { input: SET, in: { $arrayToObject: [[[{ $toString: "$$this" }, 1]]] } } } },
    GROUPED(FILTERED),
    GROUPED({ $size: FILTERED }),
    { $size: { $objectToArray: GROUPED(FILTERED) } },
  ],
  "$concatArrays of sets": [
    { $concatArrays: [SET, { $setUnion: [[7, 8]] }] },
    { $concatArrays: [SET, []] },
    { $concatArrays: [[], SET, []] },
    { $size: { $concatArrays: [SET, { $setUnion: [[7, 8]] }] } },
    { $concatArrays: [{ $map: { input: SET, in: "$$this" } }, SET] },
  ],
  "$sortArray over a set": [
    { $sortArray: { input: SET, sortBy: 1 } },
    { $sortArray: { input: SET, sortBy: -1 } },
    { $sortArray: { input: { $map: { input: SET, in: { $toString: "$$this" } } }, sortBy: 1 } },
    { $sortArray: { input: SET_OF_DOCS, sortBy: { a: 1, b: 1 } } },
    { $sortArray: { input: SET_OF_DOCS, sortBy: { b: -1, a: -1 } } },
    { $first: { $sortArray: { input: SET, sortBy: -1 } } },
  ],
  "a set through the operators that pass a value on": [
    { $cond: [true, { $map: { input: SET, in: "$$this" } }, []] },
    { $ifNull: [{ $filter: { input: SET, cond: true } }, []] },
    { $let: { vars: { s: SET }, in: { $map: { input: "$$s", in: { $add: ["$$this", 1] } } } } },
    { $switch: { branches: [{ case: true, then: { $filter: { input: SET, cond: true } } }], default: [] } },
  ],
};

/**
 * The one place where the interpreter answers and the server fails. The server folds
 * every constant part of an expression before it runs the whole, so a division by
 * zero in a branch that is not taken fails the whole. The interpreter evaluates
 * only the branch that the answer needs, as JavaScript does: a guard such as
 * `d === 0 ? 0 : 1 / d` is the idiom that every JavaScript developer writes. A case
 * stays here with its reason, and the test asserts that the server still fails, so a
 * change of the server moves the row to BATTERIES.
 */
const FAILS_ON_THE_SERVER = "the server folds the constant part that the answer does not need";
const NOT_TAKEN = { $divide: [1, 0] };
export const DIVERGE: readonly { mql: unknown; value: unknown; why: string }[] = [
  { mql: { $and: [false, NOT_TAKEN] }, value: false, why: FAILS_ON_THE_SERVER },
  { mql: { $or: [true, NOT_TAKEN] }, value: true, why: FAILS_ON_THE_SERVER },
  { mql: { $cond: [true, "a", NOT_TAKEN] }, value: "a", why: FAILS_ON_THE_SERVER },
  { mql: { $cond: [false, NOT_TAKEN, "b"] }, value: "b", why: FAILS_ON_THE_SERVER },
  { mql: { $ifNull: [1, NOT_TAKEN] }, value: 1, why: FAILS_ON_THE_SERVER },
  { mql: { $switch: { branches: [{ case: true, then: 1 }], default: NOT_TAKEN } }, value: 1, why: FAILS_ON_THE_SERVER },
  { mql: { $let: { vars: { v: NOT_TAKEN }, in: 3 } }, value: 3, why: FAILS_ON_THE_SERVER },
  { mql: { $map: { input: [], in: NOT_TAKEN } }, value: [], why: FAILS_ON_THE_SERVER },
  { mql: { $filter: { input: [], cond: NOT_TAKEN } }, value: [], why: FAILS_ON_THE_SERVER },
];

/** One case of the run: the operator, its MQL and what happened. */
type Outcome = "compared" | "both-refused";

const tallies = { cases: 0, ran: 0, compared: 0 };

/** The value of a field that the server did not write. */
const MISSING = Symbol("missing");

async function serverValue(db: Db, mql: unknown): Promise<{ value: unknown } | { error: string }> {
  try {
    const [row] = await db.aggregate([{ $documents: [{}] }, { $addFields: { v: mql } }]).toArray();
    return { value: "v" in row ? row.v : MISSING };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

const show = (v: unknown): string =>
  typeof v === "symbol" ? "<missing>" : JSON.stringify(v, (_, x) => (typeof x === "bigint" ? `${x}n` : x));

async function check(db: Db, mql: unknown): Promise<Outcome | string> {
  const answer = interpret(mql);
  const server = await serverValue(db, mql);
  tallies.ran++;
  if (!answer.ok) {
    return answer.unspellable === undefined
      ? `the interpreter refused a case of the battery: ${show(mql)}`
      : "error" in server || (typeof server.value === "number" && !Number.isFinite(server.value))
        ? "both-refused"
        : `the interpreter says ${answer.unspellable}, and the server answers ${show(server.value)} for ${show(mql)}`;
  }
  if ("error" in server)
    return `the interpreter answers ${show(answer.value)}, and the server fails (${server.error}) for ${show(mql)}`;
  const same = answersSet(mql)
    ? JSON.stringify(inAnyOrder(answer.value)) === JSON.stringify(inAnyOrder(server.value))
    : sameValue(answer.value, server.value);
  return same
    ? "compared"
    : `the interpreter answers ${show(answer.value)}, and the server answers ${show(server.value)} for ${show(mql)}`;
}

describe.skipIf(!up)("the interpreter agrees with the server", () => {
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    client = await liveClientNow();
    db = client.db("jsmql_compiler_interpret");
    await db.dropDatabase();
  });

  afterAll(async () => {
    await client.close();
  });

  for (const [operator, cases] of Object.entries(BATTERIES)) {
    it(`${operator}: every case answers what the server answers`, async () => {
      expect(cases.length, `the battery of ${operator} holds four to twelve cases`).toBeGreaterThanOrEqual(4);
      expect(cases.length).toBeLessThanOrEqual(12);
      const failures: string[] = [];
      for (const mql of cases) {
        tallies.cases++;
        const outcome = await check(db, mql);
        if (outcome === "compared") tallies.compared++;
        else if (outcome !== "both-refused") failures.push(outcome);
      }
      expect(failures).toEqual([]);
    });
  }

  for (const [name, cases] of Object.entries(WIDENED)) {
    it(`${name}: every case answers what the server answers`, async () => {
      const failures: string[] = [];
      for (const mql of cases) {
        tallies.cases++;
        const outcome = await check(db, mql);
        if (outcome === "compared") tallies.compared++;
        else if (outcome !== "both-refused") failures.push(outcome);
      }
      expect(failures).toEqual([]);
    });
  }

  it("answers a case that the server fails on, and the server still fails", async () => {
    for (const { mql, value } of DIVERGE) {
      const answer = interpret(mql);
      expect(answer.ok && sameValue(answer.value, value), show(mql)).toBe(true);
      expect(await serverValue(db, mql), `${show(mql)} no longer fails on the server`).toHaveProperty("error");
    }
  });

  it("every operator that the interpreter runs has a battery", () => {
    expect(Object.keys(RULES).filter((name) => !(name in BATTERIES))).toEqual([]);
    expect(Object.keys(BATTERIES).filter((name) => !(name in RULES))).toEqual([]);
  });

  // A case that returns early asserts nothing, so the run states how much of it ran.
  it("ran each case, or none", () => {
    const total = [...Object.values(BATTERIES), ...Object.values(WIDENED)].reduce((n, cases) => n + cases.length, 0);
    expect(tallies.cases).toBe(total);
    expect(tallies.ran === total || tallies.ran === 0).toBe(true);
  });

  it("compared a value in at least 95% of the cases", () => {
    expect(tallies.compared / tallies.cases).toBeGreaterThanOrEqual(0.95);
  });
});
