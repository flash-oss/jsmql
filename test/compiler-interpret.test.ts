// The interpreter for MQL expressions, with no server: the value of each rule, each
// refusal, the NaN and infinity that make a result unspellable, and the scope of a variable.
//
// An answer here is a value that a rule computes. Whether the server computes the same
// value is checked by compiler-interpret-agrees.test.ts. The rows in each table
// are the cases where the rule says something that a reader can verify by hand.

import { describe, expect, it } from "vitest";
import { BSONRegExp, Decimal128, Int32, Long, MaxKey, MinKey, ObjectId, Timestamp } from "bson";
import { interpret } from "../src/compiler/interpret/index.ts";
import { MAX_DEPTH, MAX_SIZE } from "../src/compiler/interpret/values.ts";

/** The value of the expression. A refusal fails the test. */
function value(mql: unknown): unknown {
  const answer = interpret(mql);
  if (!answer.ok) throw new Error(`no value for ${JSON.stringify(mql)}: ${JSON.stringify(answer)}`);
  return answer.value;
}

/** Each of these has no value, and the reason is not a NaN or an infinity. */
const refused = (mql: unknown): void => expect(interpret(mql)).toEqual({ ok: false });

const OID = "507f1f77bcf86cd799439011";

describe("the walk", () => {
  it.each<[string, unknown]>([
    ["a number", 5],
    ["a string", "abc"],
    ["a boolean", true],
    ["null", null],
    ["an array", [1, "a", null, [2]]],
    ["a document", { a: 1, b: { c: [1] } }],
    ["a Date", new Date(5000)],
    ["an ObjectId", new ObjectId(OID)],
    ["a Long", new Long(5)],
    ["a Decimal128", new Decimal128("1.5")],
  ])("%s is its own value", (_, literal) => {
    expect(value(literal)).toEqual(literal);
  });

  it("walks the elements of an array and the values of a document", () => {
    expect(value([{ $add: [1, 2] }, "x"])).toEqual([3, "x"]);
    expect(value({ a: { $add: [1, 2] }, b: [{ $concat: ["x", "y"] }] })).toEqual({ a: 3, b: ["xy"] });
  });

  it("keeps the key order of a document", () => {
    expect(Object.keys(value({ b: 1, a: 2, c: 3 }) as object)).toEqual(["b", "a", "c"]);
  });

  it.each<[string, unknown]>([
    ["a field path", "$a"],
    ["a field path in an operand", { $abs: "$a" }],
    ["the whole document", "$$ROOT"],
    ["the current document", "$$CURRENT"],
    ["the clock", "$$NOW"],
    ["a variable that nothing bound", "$$x"],
    ["a dollar on its own", "$"],
    ["an unknown operator", { $nope: 1 }],
    ["an operator that the interpreter refuses", { $sin: 1 }],
    ["an operator with a second key", { $abs: 1, extra: 2 }],
    ["two operators", { $abs: 1, $ceil: 1 }],
    ["a key with a dot", { "a.b": 1 }],
    ["an empty key", { "": 1 }],
    ["undefined", undefined],
    ["a BigInt", 5n],
    ["a function", () => 1],
    ["a string with a lone surrogate", "a" + String.fromCharCode(0xd83d)],
    ["an invalid Date", new Date(Number.NaN)],
  ])("has no value for %s", (_, mql) => {
    refused(mql);
  });

  it("answers a Binary, a regex and a MinKey as the opaque values that they are", () => {
    const regex = /ab+/i;
    expect(value({ $literal: regex })).toBe(regex);
    expect(value([regex])).toEqual([regex]);
  });

  it("reads a key that looks like an array index only in a document of one key", () => {
    expect(value({ "1": "x" })).toEqual({ "1": "x" });
    // A JavaScript object lists "1" before "b", so the BSON order would be lost.
    refused({ b: 1, "1": 2 });
    refused({ $mergeObjects: [{ b: 1 }, { "1": 2 }] });
  });

  it("is a refusal, not an exception, for a tree that is too deep", () => {
    let deep: unknown = 1;
    for (let i = 0; i < MAX_DEPTH + 10; i++) deep = { $add: [deep, 1] };
    refused(deep);
    let fine: unknown = 1;
    for (let i = 0; i < 100; i++) fine = { $add: [fine, 1] };
    expect(value(fine)).toBe(101);
  });

  it("is a refusal for a value that is too large", () => {
    refused({ $range: [0, MAX_SIZE + 1] });
    expect(value({ $size: [{ $range: [0, 1000] }] })).toBe(1000);
    refused({
      $concat: [
        { $reduce: { input: { $range: [0, 20] }, initialValue: "x", in: { $concat: ["$$value", "$$value"] } } },
      ],
    });
  });

  it("stops nested callbacks that would run too long", () => {
    const loop = {
      $map: {
        input: { $range: [0, 5000] },
        as: "i",
        in: { $map: { input: { $range: [0, 5000] }, in: { $add: ["$$i", "$$this"] } } },
      },
    };
    refused(loop);
  });
});

describe("NaN and infinity make a result unspellable", () => {
  it.each<[string, unknown, string]>([
    ["a division by zero", { $divide: [1, 0] }, "Infinity"],
    ["0 over 0", { $divide: [0, 0] }, "NaN"],
    ["a remainder of zero", { $mod: [1, 0] }, "NaN"],
    ["the root of a negative number", { $sqrt: -1 }, "NaN"],
    ["an overflow", { $multiply: [1e200, 1e200] }, "Infinity"],
    ["a huge power", { $pow: [10, 400] }, "Infinity"],
    ["a negative huge power", { $pow: [-10, 401] }, "-Infinity"],
    ["a literal NaN", Number.NaN, "NaN"],
    ["a literal infinity", Number.POSITIVE_INFINITY, "Infinity"],
  ])("%s", (_, mql, name) => {
    expect(interpret(mql)).toEqual({ ok: false, unspellable: name });
  });

  it("carries the unspellable value out of an array, a document and an operator", () => {
    expect(interpret([1, { $divide: [1, 0] }])).toEqual({ ok: false, unspellable: "Infinity" });
    expect(interpret({ a: { $sqrt: -4 } })).toEqual({ ok: false, unspellable: "NaN" });
    expect(interpret({ $gt: [{ $divide: [1, 0] }, 0] })).toEqual({ ok: false, unspellable: "Infinity" });
    expect(interpret({ $add: [1, { $multiply: [{ $divide: [1, 0] }, 2] }] })).toEqual({
      ok: false,
      unspellable: "Infinity",
    });
  });

  it("does not evaluate the branch that the answer does not need", () => {
    expect(value({ $cond: [true, "a", { $divide: [1, 0] }] })).toBe("a");
    expect(value({ $and: [false, { $divide: [1, 0] }] })).toBe(false);
    expect(value({ $ifNull: [1, { $divide: [1, 0] }] })).toBe(1);
  });

  it("treats a -0 as a refusal, not as a NaN or an infinity", () => {
    refused({ $multiply: [0, -7] });
    refused({ $ceil: -0.5 });
    refused({ $round: [-0.4] });
    refused(-0);
    refused({ $trunc: [-0.4, 0] });
  });
});

describe("arithmetic", () => {
  it.each<[unknown, unknown]>([
    [{ $add: [1, 2] }, 3],
    [{ $add: [] }, 0],
    [{ $add: [1, null] }, null],
    [{ $add: [1, 2, 3, 4] }, 10],
    [{ $add: [0.1, 0.2] }, 0.30000000000000004],
    [{ $add: [0.1, 0.2, 0.3] }, 0.6000000000000001],
    [{ $multiply: [1.1, 1.1, 1.1] }, 1.3310000000000004],
    [{ $subtract: [5, 8] }, -3],
    [{ $subtract: [null, 1] }, null],
    [{ $multiply: [] }, 1],
    [{ $multiply: [2, 3, 4] }, 24],
    [{ $divide: [7, 2] }, 3.5],
    [{ $divide: [4, 2] }, 2],
    [{ $mod: [-7, 3] }, -1],
    [{ $mod: [7.5, 2] }, 1.5],
    [{ $pow: [2, 10] }, 1024],
    [{ $pow: [0, 0] }, 1],
    [{ $pow: [-2, 3] }, -8],
    [{ $sqrt: 16 }, 4],
    [{ $abs: -2147483648 }, 2147483648],
    [{ $ceil: 1.2 }, 2],
    [{ $floor: -1.2 }, -2],
    [{ $trunc: [-2.75, 1] }, -2.7],
    [{ $trunc: [1234, -2] }, 1200],
    [{ $round: 2.5 }, 2],
    [{ $round: 3.5 }, 4],
    [{ $round: [2.675, 2] }, 2.67],
    [{ $round: [1250, -2] }, 1200],
    [{ $bitAnd: [12, 10] }, 8],
    [{ $bitOr: [12, 10] }, 14],
    [{ $bitXor: [12, 10] }, 6],
    [{ $bitNot: 5 }, -6],
  ])("%j is %j", (mql, expected) => {
    expect(value(mql)).toEqual(expected);
  });

  it.each<[string, unknown]>([
    ["a string operand", { $add: [1, "a"] }],
    ["a Date operand", { $add: [1, new Date(0)] }],
    ["a Long operand", { $add: [1, new Long(1)] }],
    ["an integer result above 2^53", { $multiply: [123456789, 987654321] }],
    ["a sum of integers above 2^53", { $add: [9007199254740991, 1] }],
    ["a negative exponent", { $pow: [2, -1] }],
    ["a fractional exponent", { $pow: [2, 0.5] }],
    ["a place beyond 100", { $round: [1.5, 101] }],
    ["a place below -20", { $trunc: [1.5, -21] }],
    ["a fractional place", { $round: [1.5, 1.5] }],
    ["a 32-bit integer that rounds past 32 bits", { $round: [-2147483648, -1] }],
    ["a bitwise operand above 32 bits", { $bitAnd: [4294967296, 1] }],
    ["a fractional bitwise operand", { $bitOr: [1.5, 1] }],
    ["no operand of $subtract", { $subtract: [] }],
    ["three operands of $divide", { $divide: [1, 2, 3] }],
  ])("has no value for %s", (_, mql) => {
    refused(mql);
  });

  it("is exact where the arguments are doubles above 2^53", () => {
    expect(value({ $add: [1e16, 1] })).toBe(1e16 + 1);
    expect(value({ $multiply: [1e20, 10] })).toBe(1e21);
  });
});

describe("comparison", () => {
  it.each<[unknown, unknown]>([
    [{ $eq: [1, 1] }, true],
    [
      {
        $eq: [
          { a: 1, b: 2 },
          { b: 2, a: 1 },
        ],
      },
      false,
    ],
    [{ $eq: [null, 1] }, false],
    [
      {
        $eq: [
          [1, [2]],
          [1, [2]],
        ],
      },
      true,
    ],
    [{ $eq: [new Date(5), new Date(5)] }, true],
    [{ $eq: [new ObjectId(OID), new ObjectId(OID)] }, true],
    [{ $ne: [1, 2] }, true],
    [{ $gt: ["😀", "ﬁ"] }, true],
    [{ $lt: ["ﬁ", "😀"] }, true],
    [{ $gt: [null, null] }, false],
    [{ $gte: [null, null] }, true],
    [{ $lt: [null, 1] }, true],
    [{ $gt: [1, null] }, true],
    [
      {
        $gt: [
          [1, 3],
          [1, 2],
        ],
      },
      true,
    ],
    [{ $lt: [[1], [1, 0]] }, true],
    [{ $gt: [true, false] }, true],
    [{ $cmp: [2, 1] }, 1],
    [{ $cmp: ["a", "a"] }, 0],
    [{ $cmp: [null, 1] }, -1],
    // Two kinds: equality is false, and an order follows the place of each kind in the BSON order.
    [{ $eq: [1, "a"] }, false],
    [{ $ne: [1, "a"] }, true],
    [{ $eq: [new Long(1), "a"] }, false],
    [{ $lt: [1, "a"] }, true],
    [{ $cmp: ["a", 1] }, 1],
    [{ $cmp: [{}, []] }, -1],
    [{ $cmp: [[], new Date(0)] }, -1],
    [{ $cmp: [new Date(0), new ObjectId(OID)] }, 1],
    [{ $cmp: [true, new ObjectId(OID)] }, 1],
    [{ $cmp: [new MinKey(), null] }, -1],
    [{ $cmp: [new MaxKey(), new Date(0)] }, 1],
    [{ $lt: [[1], ["a"]] }, true],
    [{ $gt: [{ a: 1 }, { a: 2 }] }, false],
    // A document compares each field by its place, then its name, then its value.
    [{ $cmp: [{ b: 1 }, { a: "x" }] }, -1],
    [{ $cmp: [{ a: 1 }, { b: 0 }] }, -1],
    [{ $cmp: [{ a: 1 }, { a: 1, b: 0 }] }, -1],
    [{ $cmp: [{ a: 2 }, { a: 1 }] }, 1],
  ])("%j is %j", (mql, expected) => {
    expect(value(mql)).toEqual(expected);
  });

  it.each<[string, unknown]>([
    ["an opaque value beside a number", { $eq: [new Long(1), 1] }],
    ["an opaque value in an order", { $lt: [new Long(1), 1] }],
    ["an array that holds an opaque value", { $eq: [[new Int32(1)], [1]] }],
    ["an opaque value inside an array in an order", { $lt: [[new Long(1)], [2]] }],
    ["two regular expressions", { $eq: [new BSONRegExp("a"), new BSONRegExp("a")] }],
    ["one operand", { $eq: [1] }],
  ])("has no value for %s", (_, mql) => {
    refused(mql);
  });
});

describe("logic", () => {
  it.each<[unknown, unknown]>([
    [{ $and: [] }, true],
    [{ $and: [1, "a", [], "", {}] }, true],
    [{ $and: [true, 0] }, false],
    [{ $or: [] }, false],
    [{ $or: [0, null, false] }, false],
    [{ $or: [0, ""] }, true],
    [{ $not: [""] }, false],
    [{ $not: null }, true],
    [{ $cond: [[], "yes", "no"] }, "yes"],
    [{ $cond: [0, "yes", "no"] }, "no"],
    [{ $cond: { if: null, then: 1, else: 2 } }, 2],
    [{ $ifNull: [null, null, 7] }, 7],
    [{ $ifNull: [0, 5] }, 0],
    [
      {
        $switch: {
          branches: [
            { case: false, then: 1 },
            { case: 1, then: 2 },
          ],
          default: 3,
        },
      },
      2,
    ],
    [{ $switch: { branches: [{ case: false, then: 1 }], default: 3 } }, 3],
    [{ $literal: "$a" }, "$a"],
    [{ $literal: { $add: [1, 2] } }, { $add: [1, 2] }],
    [{ $literal: { "a.b": 1 } }, { "a.b": 1 }],
  ])("%j is %j", (mql, expected) => {
    expect(value(mql)).toEqual(expected);
  });

  it.each<[string, unknown]>([
    ["a condition with an opaque value", { $cond: [new Int32(0), 1, 2] }],
    ["a $cond with two branches", { $cond: [true, 1] }],
    ["a $cond with an extra key", { $cond: { if: true, then: 1, else: 2, x: 3 } }],
    ["a $switch with no default and no true case", { $switch: { branches: [{ case: false, then: 1 }] } }],
    ["a $switch with no branch", { $switch: { branches: [], default: 1 } }],
    ["a $switch branch with an extra key", { $switch: { branches: [{ case: true, then: 1, x: 1 }] } }],
    ["a $ifNull with one operand", { $ifNull: [1] }],
    ["a field in the branch that the answer needs", { $cond: [true, "$a", 2] }],
    ["a $literal of a BigInt", { $literal: 5n }],
  ])("has no value for %s", (_, mql) => {
    refused(mql);
  });
});

describe("variables", () => {
  it("binds a $let variable, and `in` sees it", () => {
    expect(value({ $let: { vars: { x: 2 }, in: { $add: ["$$x", 1] } } })).toBe(3);
  });

  it("evaluates every variable of a $let in the scope around it", () => {
    expect(value({ $let: { vars: { x: 1 }, in: { $let: { vars: { x: { $add: ["$$x", 1] } }, in: "$$x" } } } })).toBe(2);
    refused({ $let: { vars: { x: 1, y: { $add: ["$$x", 1] } }, in: "$$y" } });
  });

  it("fails only the expression that reads a variable with no value", () => {
    expect(value({ $let: { vars: { v: { $divide: [1, 0] } }, in: 3 } })).toBe(3);
    expect(interpret({ $let: { vars: { v: { $divide: [1, 0] } }, in: { $add: ["$$v", 1] } } })).toEqual({
      ok: false,
      unspellable: "Infinity",
    });
    refused({ $let: { vars: { v: "$field" }, in: { $abs: "$$v" } } });
    expect(value({ $let: { vars: { v: "$field" }, in: 4 } })).toBe(4);
  });

  it("reads a path inside a variable", () => {
    expect(value({ $let: { vars: { doc: { a: { b: 7 } } }, in: "$$doc.a.b" } })).toBe(7);
    refused({ $let: { vars: { doc: { a: 1 } }, in: "$$doc.b" } });
    refused({ $let: { vars: { list: [{ a: 1 }] }, in: "$$list.a" } });
  });

  it("refuses a variable name that the server refuses", () => {
    refused({ $let: { vars: { X: 1 }, in: "$$X" } });
    refused({ $let: { vars: { _a: 1 }, in: 1 } });
    refused({ $let: { vars: { "a-b": 1 }, in: 1 } });
  });

  it("gives `$$this` to $map, and `as` renames it", () => {
    expect(value({ $map: { input: [1, 2], in: { $add: ["$$this", 1] } } })).toEqual([2, 3]);
    expect(value({ $map: { input: [1, 2], as: "n", in: { $add: ["$$n", 1] } } })).toEqual([2, 3]);
    refused({ $map: { input: [1, 2], as: "n", in: "$$this" } });
  });

  it("scopes a $let inside a $map, and a $map inside a $map", () => {
    expect(
      value({
        $map: {
          input: [1, 2],
          in: { $let: { vars: { y: { $add: ["$$this", 1] } }, in: { $multiply: ["$$y", "$$y"] } } },
        },
      }),
    ).toEqual([4, 9]);
    expect(
      value({
        $map: { input: [[1, 2], [3]], as: "row", in: { $map: { input: "$$row", in: { $add: ["$$this", 10] } } } },
      }),
    ).toEqual([[11, 12], [13]]);
    // After the $map, the variable is gone.
    refused({ $concatArrays: [{ $map: { input: [1], in: "$$this" } }, ["$$this"]] });
  });

  it("gives `$$value` and `$$this` to $reduce", () => {
    expect(value({ $reduce: { input: [1, 2, 3], initialValue: 0, in: { $add: ["$$value", "$$this"] } } })).toBe(6);
    expect(
      value({ $reduce: { input: [1, 2, 3], initialValue: { n: 0 }, in: { n: { $add: ["$$value.n", "$$this"] } } } }),
    ).toEqual({ n: 6 });
  });

  it("gives `$$this` to $filter, and `limit` stops the answer", () => {
    expect(value({ $filter: { input: [1, 2, 3, 4], cond: { $gt: ["$$this", 2] } } })).toEqual([3, 4]);
    expect(value({ $filter: { input: [1, 2, 3, 4], cond: { $gt: ["$$this", 1] }, limit: 2 } })).toEqual([2, 3]);
    expect(value({ $filter: { input: [1, 2], cond: true, limit: null } })).toEqual([1, 2]);
  });

  it("refuses an element whose body reads the document", () => {
    refused({ $map: { input: [1, 2], in: { $add: ["$$this", "$n"] } } });
  });
});

describe("arrays", () => {
  it.each<[unknown, unknown]>([
    [{ $size: [[1, 2]] }, 2],
    [{ $arrayElemAt: [[1, 2, 3], -1] }, 3],
    [{ $arrayElemAt: [null, 0] }, null],
    [{ $first: [[7, 8]] }, 7],
    [{ $last: [null] }, null],
    [{ $firstN: { n: 2, input: [1, 2, 3] } }, [1, 2]],
    [{ $lastN: { n: 5, input: [1, 2, 3] } }, [1, 2, 3]],
    [{ $slice: [[1, 2, 3, 4], -2] }, [3, 4]],
    [{ $slice: [[1, 2, 3, 4], -3, 2] }, [2, 3]],
    [{ $slice: [[1, 2, 3, 4], -10, 2] }, [1, 2]],
    [{ $concatArrays: [[1], [2, 3]] }, [1, 2, 3]],
    [{ $concatArrays: [[1], null] }, null],
    [{ $concatArrays: [[[1]]] }, [[1]]],
    [{ $reverseArray: [[1, [2, 3]]] }, [[2, 3], 1]],
    [{ $range: [0, 10, 3] }, [0, 3, 6, 9]],
    [{ $range: [5, 0, -2] }, [5, 3, 1]],
    [{ $range: [5, 0] }, []],
    [{ $in: [[1], [[1]]] }, true],
    [{ $in: [1, []] }, false],
    [{ $indexOfArray: [[1, 2, 1], 1, 1] }, 2],
    [{ $indexOfArray: [[1, 2, 1], 1, 1, 2] }, -1],
    [{ $isArray: [[]] }, true],
    [{ $isArray: ["a"] }, false],
    [{ $allElementsTrue: [[]] }, true],
    [{ $anyElementTrue: [[0, null]] }, false],
    [
      { $zip: { inputs: [[1, 2, 3], ["a"]], useLongestLength: true, defaults: [0, "z"] } },
      [
        [1, "a"],
        [2, "z"],
        [3, "z"],
      ],
    ],
    [{ $zip: { inputs: [[1, 2, 3], ["a"]] } }, [[1, "a"]]],
    [{ $zip: { inputs: [[1], null] } }, null],
    [{ $sortArray: { input: ["b", "😀", "ﬁ", "a"], sortBy: 1 } }, ["a", "b", "ﬁ", "😀"]],
    [
      {
        $sortArray: {
          input: [
            { a: 2, i: 0 },
            { a: 1, i: 1 },
            { a: 2, i: 2 },
          ],
          sortBy: { a: -1 },
        },
      },
      [
        { a: 2, i: 0 },
        { a: 2, i: 2 },
        { a: 1, i: 1 },
      ],
    ],
    [{ $maxN: { input: [1, null, 3, 2], n: 2 } }, [3, 2]],
    [{ $minN: { input: ["b", "a", "c"], n: 2 } }, ["a", "b"]],
  ])("%j is %j", (mql, expected) => {
    expect(value(mql)).toEqual(expected);
  });

  it.each<[string, unknown]>([
    ["an element that is not there", { $arrayElemAt: [[1, 2, 3], 3] }],
    ["an index above 32 bits", { $arrayElemAt: [[1], 4294967296] }],
    ["a fractional index", { $arrayElemAt: [[1], 1.5] }],
    ["$first of an empty array", { $first: [[]] }],
    ["$last of an empty array", { $last: [[]] }],
    ["a two-argument $size", { $size: [1, 2] }],
    ["the size of a number", { $size: [1] }],
    ["the size of null", { $size: null }],
    ["a $firstN count of 0", { $firstN: { n: 0, input: [1] } }],
    ["a $firstN of null", { $firstN: { n: 1, input: null } }],
    ["a $slice of length 0", { $slice: [[1, 2], 1, 0] }],
    ["a $concatArrays of a number", { $concatArrays: [[1], 2] }],
    ["a $range with step 0", { $range: [0, 5, 0] }],
    ["a fractional $range bound", { $range: [0, 1.5] }],
    ["a $in over a string", { $in: [1, "a"] }],
    ["a negative $indexOfArray start", { $indexOfArray: [[1], 1, -1] }],
    ["a $map of a number", { $map: { input: 5, in: 1 } }],
    ["a $filter with a limit of 0", { $filter: { input: [1], cond: true, limit: 0 } }],
    ["a $reduce with no initial value", { $reduce: { input: [1], in: 1 } }],
    ["a $zip of no input", { $zip: { inputs: [] } }],
    ["$zip defaults without a longest length", { $zip: { inputs: [[1]], defaults: [0] } }],
    ["a $sortArray over mixed kinds", { $sortArray: { input: [1, "a"], sortBy: 1 } }],
    ["a $sortArray with a missing key", { $sortArray: { input: [{ a: 1 }, { b: 1 }], sortBy: { a: 1 } } }],
    ["a $sortArray sort of scalars by a field", { $sortArray: { input: [3, 1], sortBy: { a: 1 } } }],
    ["a $maxN of mixed kinds", { $maxN: { input: [1, "a"], n: 1 } }],
    ["a $maxN count of 0", { $maxN: { input: [1], n: 0 } }],
    ["an $allElementsTrue of null", { $allElementsTrue: [null] }],
  ])("has no value for %s", (_, mql) => {
    refused(mql);
  });
});

describe("set operators", () => {
  it.each<[unknown, unknown]>([
    [{ $setUnion: [] }, []],
    [
      {
        $setUnion: [
          [3, 1],
          [2, 1, 3, 3],
        ],
      },
      [3, 1, 2],
    ],
    [{ $setUnion: [[1], null] }, null],
    [
      {
        $setIntersection: [
          [3, 1, 2],
          [2, 3, 4],
        ],
      },
      [3, 2],
    ],
    [{ $setIntersection: [] }, []],
    [{ $setDifference: [[1, 1, 2], [3]] }, [1, 2]],
    [
      {
        $setEquals: [
          [1, 2],
          [2, 1, 1],
        ],
      },
      true,
    ],
    [{ $setEquals: [[1], [2]] }, false],
    [{ $setIsSubset: [[1, 1], [1]] }, true],
  ])("%j is %j (the order of first occurrence)", (mql, expected) => {
    expect(value(mql)).toEqual(expected);
  });

  it("answers a set in an order that the server does not specify, so no rule may read that order", () => {
    const set = { $setUnion: [[3, 1], [2]] };
    expect(value({ $size: [set] })).toBe(3);
    expect(value({ $in: [2, set] })).toBe(true);
    expect(value({ $setEquals: [set, [1, 2, 3]] })).toBe(true);
    expect(value({ $let: { vars: { s: set }, in: { $size: ["$$s"] } } })).toBe(3);
    refused({ $first: [set] });
    refused({ $arrayElemAt: [set, 0] });
    refused({ $slice: [set, 1] });
    refused({ $concatArrays: [set, [4]] });
    refused({ $reverseArray: [set] });
    refused({ $eq: [set, [3, 1, 2]] });
    refused({ $indexOfArray: [set, 3] });
    refused({ $let: { vars: { s: set }, in: { $first: ["$$s"] } } });
    refused({ $eq: [[set], [[3, 1, 2]]] });
    refused({ $setUnion: [[set], [[1]]] });
  });

  const set = { $setUnion: [[3, 1], [2]] };

  it("passes the order of a set through the operators that build a value one element at a time", () => {
    // `$map` and `$filter` give a list in the order of the set, so a rule that reads a position still refuses it.
    expect(value({ $size: { $map: { input: set, in: { $add: ["$$this", 1] } } } })).toBe(3);
    expect(value({ $in: [4, { $map: { input: set, in: { $add: ["$$this", 1] } } }] })).toBe(true);
    expect(value({ $size: { $filter: { input: set, cond: { $gt: ["$$this", 1] } } } })).toBe(2);
    refused({ $first: { $map: { input: set, in: "$$this" } } });
    refused({ $first: { $filter: { input: set, cond: true } } });
    refused({ $arrayElemAt: [{ $map: { input: set, in: "$$this" } }, 0] });
    refused({ $reduce: { input: set, initialValue: 0, in: { $add: ["$$value", "$$this"] } } });
    refused({ $zip: { inputs: [set, [1, 2, 3]] } });
    refused({ $indexOfArray: [{ $map: { input: set, in: "$$this" } }, 3] });
    // A limit keeps the first elements of the set, which the server does not specify.
    refused({ $filter: { input: set, cond: true, limit: 2 } });
    expect(value({ $filter: { input: set, cond: true, limit: null } })).toEqual([3, 1, 2]);
  });

  it("gives a document the key order of the set, and a list the order of the document", () => {
    const pairs = { $map: { input: set, as: "n", in: { k: { $toString: "$$n" }, v: "$$n" } } };
    expect(value({ $arrayToObject: pairs })).toEqual({ 3: 3, 1: 1, 2: 2 });
    expect(value({ $size: { $objectToArray: { $arrayToObject: pairs } } })).toBe(3);
    expect(value({ $size: { $objectToArray: { $mergeObjects: [{ $arrayToObject: pairs }, { z: 1 }] } } })).toBe(4);
    refused({ $first: { $objectToArray: { $arrayToObject: pairs } } });
    refused({ $getField: { field: "1", input: { $arrayToObject: pairs } } });
    // A key that two pairs share keeps the value of the last pair, and the set has no last pair.
    refused({ $arrayToObject: { $map: { input: set, in: { k: "a", v: "$$this" } } } });
    // The same holds for documents that one list holds.
    refused({ $mergeObjects: { $map: { input: set, in: { a: "$$this" } } } });
    const keyed = { $map: { input: set, in: { $arrayToObject: [[[{ $toString: "$$this" }, 1]]] } } };
    expect(value({ $size: { $objectToArray: { $mergeObjects: keyed } } })).toBe(3);
  });

  it("joins sets, and a join of a set with a list that holds elements has no order to give", () => {
    expect(value({ $size: { $concatArrays: [set, { $setUnion: [[7]] }, []] } })).toBe(4);
    expect(value({ $size: { $concatArrays: [[], []] } })).toBe(0);
    refused({ $first: { $concatArrays: [set, { $setUnion: [[7]] }] } });
    refused({ $concatArrays: [set, [4]] });
  });

  it("gives a list in a specified order when it sorts a set, and refuses a tie that shows the order", () => {
    expect(value({ $sortArray: { input: set, sortBy: 1 } })).toEqual([1, 2, 3]);
    expect(value({ $first: { $sortArray: { input: set, sortBy: -1 } } })).toBe(3);
    const docs = {
      $setUnion: [
        [{ a: 1, b: 1 }],
        [
          { a: 1, b: 2 },
          { a: 0, b: 1 },
        ],
      ],
    };
    expect(value({ $sortArray: { input: docs, sortBy: { a: 1, b: 1 } } })).toEqual([
      { a: 0, b: 1 },
      { a: 1, b: 1 },
      { a: 1, b: 2 },
    ]);
    refused({ $sortArray: { input: docs, sortBy: { a: 1 } } });
  });

  it("passes a set through the operators that read no order", () => {
    expect(value({ $max: [set] })).toBe(3);
    expect(value({ $sum: [set] })).toBe(6);
    expect(value({ $avg: [set] })).toBe(2);
    expect(value({ $allElementsTrue: [set] })).toBe(true);
    expect(value({ $anyElementTrue: [{ $map: { input: set, in: { $gt: ["$$this", 5] } } }] })).toBe(false);
    expect(value({ $cond: [true, { $map: { input: set, in: "$$this" } }, []] })).toEqual([3, 1, 2]);
    expect(value({ $size: { $let: { vars: { s: set }, in: { $map: { input: "$$s", in: "$$this" } } } } })).toBe(3);
    refused({ $first: { $ifNull: [{ $map: { input: set, in: "$$this" } }, []] } });
  });

  it("still passes a set on to a caller that does not read its order", () => {
    expect(value({ $cond: [true, { $setUnion: [[1], [2]] }, []] })).toEqual([1, 2]);
    expect(value({ $ifNull: [{ $setUnion: [[1], [1]] }, []] })).toEqual([1]);
  });

  it("refuses a set operand of the wrong kind", () => {
    refused({ $setUnion: [[1], 2] });
    refused({ $setDifference: [[1]] });
    refused({ $setEquals: [[1], null] });
    refused({ $setIsSubset: [[1], null] });
    refused({ $setUnion: [[new Long(1)], [1]] });
  });
});

describe("documents", () => {
  it.each<[unknown, unknown]>([
    [
      { $objectToArray: { a: 1, b: 2 } },
      [
        { k: "a", v: 1 },
        { k: "b", v: 2 },
      ],
    ],
    [{ $objectToArray: null }, null],
    [
      {
        $arrayToObject: [
          [
            ["a", 1],
            ["b", 2],
            ["a", 3],
          ],
        ],
      },
      { a: 3, b: 2 },
    ],
    [{ $arrayToObject: [[{ k: "a", v: 1 }]] }, { a: 1 }],
    [{ $arrayToObject: [[["a.b", 1]]] }, { "a.b": 1 }],
    [{ $arrayToObject: [[]] }, {}],
    [{ $mergeObjects: [] }, {}],
    [{ $mergeObjects: [{ a: 1, b: 1 }, null, { b: 2, c: 3 }] }, { a: 1, b: 2, c: 3 }],
    [{ $mergeObjects: [[{ a: 1 }, { b: 2 }]] }, { a: 1, b: 2 }],
    [{ $mergeObjects: [{ a: { x: 1 } }, { a: { y: 2 } }] }, { a: { y: 2 } }],
    [{ $getField: { field: "a", input: { a: 1 } } }, 1],
    [{ $getField: { field: "a", input: null } }, null],
    [{ $getField: { field: { $literal: "a.b" }, input: { $literal: { "a.b": 7, a: { b: 8 } } } } }, 7],
    [{ $setField: { field: "a", input: { a: 1, b: 2 }, value: 5 } }, { a: 5, b: 2 }],
    [{ $setField: { field: "c", input: { a: 1 }, value: null } }, { a: 1, c: null }],
    [{ $unsetField: { field: "a", input: { a: 1, b: 2 } } }, { b: 2 }],
    [{ $unsetField: { field: "z", input: { a: 1 } } }, { a: 1 }],
  ])("%j is %j", (mql, expected) => {
    expect(value(mql)).toEqual(expected);
  });

  it("keeps the position of a key that a write replaces", () => {
    const merged = value({ $mergeObjects: [{ a: 1, b: 2 }, { a: 3 }] }) as object;
    expect(Object.keys(merged)).toEqual(["a", "b"]);
    const set = value({ $setField: { field: "a", input: { a: 1, b: 2 }, value: 9 } }) as object;
    expect(Object.keys(set)).toEqual(["a", "b"]);
  });

  it.each<[string, unknown]>([
    ["a field that is not there", { $getField: { field: "b", input: { a: 1 } } }],
    ["the shorthand of $getField, which reads the document", { $getField: "a" }],
    ["a $getField with no input", { $getField: { field: "a" } }],
    ["a field name with a dollar", { $setField: { field: "$a", input: {}, value: 1 } }],
    ["a field that is not a string", { $getField: { field: 1, input: { a: 1 } } }],
    ["$objectToArray of an array", { $objectToArray: [[1]] }],
    ["a key with a null byte", { $arrayToObject: [[["a\u0000b", 1]]] }],
    ["a key with a dollar", { $arrayToObject: [[["$a", 1]]] }],
    ["a pair of three", { $arrayToObject: [[["a", 1, 2]]] }],
    ["both forms of a pair", { $arrayToObject: [[["a", 1], { k: "b", v: 2 }]] }],
    ["a pair with a number for a key", { $arrayToObject: [[[1, 1]]] }],
    ["$mergeObjects of a number", { $mergeObjects: [{ a: 1 }, 5] }],
    ["a $setField of a number", { $setField: { field: "a", input: 5, value: 1 } }],
  ])("has no value for %s", (_, mql) => {
    refused(mql);
  });
});

describe("strings", () => {
  const SPACES = [0, 9, 10, 11, 12, 13, 32, 0xa0, 0x1680, 0x2000, 0x2005, 0x200a]
    .map((c) => String.fromCodePoint(c))
    .join("");

  it.each<[unknown, unknown]>([
    [{ $concat: ["😀", "é"] }, "😀é"],
    [{ $concat: [] }, ""],
    [{ $concat: ["a", null] }, null],
    [{ $toUpper: "éa😀ß" }, "éA😀ß"],
    [{ $toLower: "ABC É" }, "abc É"],
    [{ $toUpper: null }, ""],
    [{ $trim: { input: "  a  " } }, "a"],
    [{ $ltrim: { input: "  a  " } }, "a  "],
    [{ $rtrim: { input: "  a  " } }, "  a"],
    [{ $trim: { input: "xyaxy", chars: "xy" } }, "a"],
    [{ $trim: { input: "😀a😀", chars: "😀" } }, "a"],
    [{ $trim: { input: "abc", chars: "" } }, "abc"],
    [{ $trim: { input: `${SPACES}x${SPACES}` } }, "x"],
    [{ $strLenCP: "😀é" }, 2],
    [{ $strLenBytes: "😀é" }, 6],
    [{ $substrCP: ["😀é😀", 1, 1] }, "é"],
    [{ $substrCP: ["abcd", 1, 100] }, "bcd"],
    [{ $substrCP: ["abc", 3, 1] }, ""],
    [{ $substrBytes: ["aé", 1, 2] }, "é"],
    [{ $substrBytes: ["abc", 1, -1] }, "bc"],
    [{ $substrBytes: ["abc", 10, 1] }, ""],
    [{ $substr: ["abcd", 1, 2] }, "bc"],
    [{ $indexOfCP: ["😀a😀", "a"] }, 1],
    [{ $indexOfCP: [null, "a"] }, null],
    // an empty search string: the start, or -1 at or past the end unless the start is 0
    [{ $indexOfCP: ["abc", "", 1] }, 1],
    [{ $indexOfCP: ["abc", "", 3] }, -1],
    [{ $indexOfCP: ["", ""] }, 0],
    [{ $indexOfBytes: ["é😀a", "a"] }, 6],
    [{ $indexOfBytes: ["abc", "bc", 0, 2] }, -1],
    [{ $indexOfBytes: ["abc", "c", 2, 3] }, 2],
    [{ $split: ["a,,b", ","] }, ["a", "", "b"]],
    [{ $split: ["aaa", "aa"] }, ["", "a"]],
    [{ $replaceOne: { input: "abcabc", find: "b", replacement: "X" } }, "aXcabc"],
    [{ $replaceAll: { input: "aaa", find: "aa", replacement: "b" } }, "ba"],
    [{ $replaceAll: { input: "a$b", find: { $literal: "$" }, replacement: { $literal: "$&" } } }, "a$&b"],
    [{ $strcasecmp: ["_", "a"] }, 1],
    [{ $strcasecmp: ["a", "A"] }, 0],
    [{ $toString: -5 }, "-5"],
    [{ $toString: true }, "true"],
    [{ $toString: null }, null],
    [{ $toString: 9007199254740991 }, "9007199254740991"],
    [{ $toString: new ObjectId(OID) }, OID],
    [{ $toString: new Decimal128("1.50") }, "1.50"],
    [{ $toString: new Long(5) }, "5"],
    [{ $toString: new Int32(-7) }, "-7"],
    // The text of a fraction is not known, but it is never the text of NaN or an infinity.
    [{ $in: [{ $toString: 4.5 }, ["NaN", "Infinity", "-Infinity"]] }, false],
    [{ $eq: [{ $toString: 1e-7 }, "NaN"] }, false],
    [{ $ne: ["Infinity", { $toString: 2.5 }] }, true],
  ])("%j is %j", (mql, expected) => {
    expect(value(mql)).toEqual(expected);
  });

  it.each<[string, unknown]>([
    ["$concat of a number", { $concat: ["a", 1] }],
    ["$toUpper of a number", { $toUpper: 1 }],
    ["$strLenCP of null", { $strLenCP: null }],
    ["a negative $substrCP start", { $substrCP: ["abc", -1, 1] }],
    ["a negative $substrCP length", { $substrCP: ["abc", 1, -1] }],
    ["a $substrBytes cut inside a character", { $substrBytes: ["é", 0, 1] }],
    ["a $substrBytes start inside a character", { $substrBytes: ["aé", 2, 1] }],
    ["a negative $substrBytes start", { $substrBytes: ["abc", -1, 1] }],
    ["an empty $split separator", { $split: ["abc", ""] }],
    ["an empty `find`", { $replaceAll: { input: "abc", find: "", replacement: "X" } }],
    ["an end bound of $indexOfCP", { $indexOfCP: ["abc", "bc", 0, 2] }],
    ["a negative $indexOfCP start", { $indexOfCP: ["abc", "a", -1] }],
    ["a $trim of null", { $trim: { input: null } }],
    ["a $trim with a null `chars`", { $trim: { input: "a", chars: null } }],
    ["a $trim of a number", { $trim: { input: 1 } }],
    ["a space that the documentation lists and the server does not trim", { $trim: { input: "\u0085a\u0085" } }],
    ["an unsigned Long above the signed range", { $toString: Long.fromString("10000000000000000000", true) }],
    ["a fractional $toString", { $toString: 1.5 }],
    ["a $toString that is read as text", { $concat: [{ $toString: 1.5 }, "a"] }],
    ["a $toString that is compared with a number text", { $eq: [{ $toString: 1.5 }, "1.5"] }],
    ["a $toString in a list of number texts", { $in: [{ $toString: 1.5 }, ["1.5", "NaN"]] }],
    ["a $toString inside the answer", { $map: { input: [1.5], in: { $toString: "$$this" } } }],
    ["a large $toString", { $toString: 1e16 }],
    ["the $toString of an array", { $toString: [[1]] }],
    ["a $strcasecmp of a number", { $strcasecmp: ["a", 1] }],
  ])("has no value for %s", (_, mql) => {
    refused(mql);
  });
});

describe("types", () => {
  it.each<[unknown, unknown]>([
    [{ $type: 1 }, "int"],
    [{ $type: 1.5 }, "double"],
    [{ $type: 3000000000 }, "double"],
    [{ $type: -2147483648 }, "int"],
    [{ $type: "a" }, "string"],
    [{ $type: [[1]] }, "array"],
    [{ $type: { a: 1 } }, "object"],
    [{ $type: null }, "null"],
    [{ $type: new Date(0) }, "date"],
    [{ $type: new ObjectId(OID) }, "objectId"],
    [{ $type: new Long(5) }, "long"],
    [{ $type: new Decimal128("1") }, "decimal"],
    [{ $type: /a/ }, "regex"],
    [{ $isNumber: new Int32(1) }, true],
    [{ $isNumber: "1" }, false],
    [{ $toBool: 0 }, false],
    [{ $toBool: "" }, true],
    [{ $toBool: null }, null],
    [{ $toObjectId: OID }, new ObjectId(OID)],
    [{ $toObjectId: OID.toUpperCase() }, new ObjectId(OID)],
    [{ $toObjectId: null }, null],
    [{ $toInt: 4.5 }, 4],
    [{ $toInt: -4.5 }, -4],
    [{ $toInt: -0.5 }, 0],
    [{ $toInt: 2147483647 }, 2147483647],
    [{ $toInt: -2147483648 }, -2147483648],
    [{ $toInt: true }, 1],
    [{ $toInt: false }, 0],
    [{ $toInt: null }, null],
    [{ $toInt: "5" }, 5],
    [{ $toInt: "-0" }, 0],
    [{ $toInt: "+007" }, 7],
  ])("%j is %j", (mql, expected) => {
    expect(value(mql)).toEqual(expected);
  });

  it("refuses the type of a number that an operator computes, because int and double are not in the value", () => {
    refused({ $type: { $divide: [4, 2] } });
    refused({ $type: { $add: [2147483647, 1] } });
    refused({ $type: { $add: [1, 2] } });
  });

  it.each<[string, unknown]>([
    ["$toObjectId of a short string", { $toObjectId: "507f" }],
    ["$toObjectId of a number", { $toObjectId: 1 }],
    ["$toBool of an empty list of arguments", { $toBool: [] }],
    ["$toBool of an opaque value", { $toBool: new Long(0) }],
    ["$toInt of a number beyond 32 bits", { $toInt: 2147483648 }],
    ["$toInt of a fraction that rounds to the top of the range", { $toInt: 2147483647.5 }],
    ["$toInt of a fraction below the range", { $toInt: -2147483648.5 }],
    ["$toInt of a string with a space", { $toInt: " 5" }],
    ["$toInt of a string with a fraction", { $toInt: "5.5" }],
    ["$toInt of an empty string", { $toInt: "" }],
    ["$toInt of a string beyond 32 bits", { $toInt: "2147483648" }],
    ["$toInt of a non-ASCII digit", { $toInt: "٣" }],
    ["$toInt of a date", { $toInt: new Date(0) }],
    ["$toInt of a Long", { $toInt: new Long(5) }],
    ["$toLong", { $toLong: 5 }],
    ["$toDouble", { $toDouble: "5" }],
    ["$toDecimal", { $toDecimal: 5 }],
    ["$convert", { $convert: { input: 5, to: "int" } }],
  ])("has no value for %s", (_, mql) => {
    refused(mql);
  });
});

describe("accumulators in their expression form", () => {
  it.each<[unknown, unknown]>([
    [{ $sum: [1, 2, 3] }, 6],
    [{ $sum: [[1, 2, 3]] }, 6],
    [{ $sum: [] }, 0],
    [{ $sum: [1, "a", null, 2] }, 3],
    [{ $sum: [[1, [2, 3]]] }, 1],
    [{ $sum: 5 }, 5],
    [{ $sum: "a" }, 0],
    [{ $sum: [0.1, 0.2] }, 0.30000000000000004],
    [{ $avg: [[1, 2, 4]] }, 2.3333333333333335],
    [{ $avg: [[]] }, null],
    [{ $avg: [1, "a"] }, 1],
    [{ $max: [1, null] }, 1],
    [{ $max: [[]] }, null],
    [{ $max: [["😀", "ﬁ"]] }, "😀"],
    [{ $min: [["😀", "ﬁ"]] }, "ﬁ"],
    [{ $min: [[new Date(9), new Date(5)]] }, new Date(5)],
    [{ $max: [[true, false]] }, true],
  ])("%j is %j", (mql, expected) => {
    expect(value(mql)).toEqual(expected);
  });

  it.each<[string, unknown]>([
    ["a sum of three fractions, whose order the server does not specify", { $sum: [0.1, 0.2, 0.3] }],
    ["an average of three fractions", { $avg: [[0.1, 0.2, 0.3]] }],
    ["a sum above 2^53", { $sum: [9007199254740991, 1] }],
    ["a sum that holds an opaque value", { $sum: [new Long(1), 1] }],
    ["a $max of two kinds", { $max: [1, "a"] }],
    ["a $max of arrays", { $max: [[[1], [2]]] }],
    ["a $max of documents", { $max: [[{ a: 1 }, { a: 2 }]] }],
  ])("has no value for %s", (_, mql) => {
    refused(mql);
  });
});

describe("dates", () => {
  const WHEN = new Date("2024-03-10T13:45:30.123Z"); // a Sunday
  const at = (iso: string): Date => new Date(iso);

  it.each<[unknown, unknown]>([
    [{ $year: WHEN }, 2024],
    [{ $month: WHEN }, 3],
    [{ $dayOfMonth: WHEN }, 10],
    [{ $hour: WHEN }, 13],
    [{ $minute: WHEN }, 45],
    [{ $second: WHEN }, 30],
    [{ $millisecond: WHEN }, 123],
    [{ $dayOfWeek: WHEN }, 1],
    [{ $dayOfYear: WHEN }, 70],
    [{ $week: WHEN }, 10],
    [{ $isoWeek: WHEN }, 10],
    [{ $isoWeekYear: WHEN }, 2024],
    [{ $isoDayOfWeek: WHEN }, 7],
    [{ $isoWeek: at("2021-01-03T00:00:00Z") }, 53],
    [{ $isoWeekYear: at("2021-01-03T00:00:00Z") }, 2020],
    [{ $isoWeek: at("2024-12-30T00:00:00Z") }, 1],
    [{ $isoWeekYear: at("2024-12-30T00:00:00Z") }, 2025],
    [{ $week: at("2023-01-01T00:00:00Z") }, 1],
    [{ $week: at("2024-01-06T00:00:00Z") }, 0],
    [{ $year: [WHEN] }, 2024],
    [{ $year: { date: WHEN, timezone: "+00:00" } }, 2024],
    [{ $year: null }, null],
    [{ $year: { date: null, timezone: "UTC" } }, null],
    [{ $year: new ObjectId(OID) }, 2012],
    [{ $year: at("-000044-03-15T00:00:00Z") }, -44],
    [
      { $dateToParts: { date: WHEN } },
      { year: 2024, month: 3, day: 10, hour: 13, minute: 45, second: 30, millisecond: 123 },
    ],
    [
      { $dateToParts: { date: WHEN, iso8601: true } },
      { isoWeekYear: 2024, isoWeek: 10, isoDayOfWeek: 7, hour: 13, minute: 45, second: 30, millisecond: 123 },
    ],
    [{ $dateToParts: { date: null } }, null],
    [{ $dateFromParts: { year: 2024 } }, at("2024-01-01T00:00:00Z")],
    [{ $dateFromParts: { year: 2024, month: 13 } }, at("2025-01-01T00:00:00Z")],
    [{ $dateFromParts: { year: 2024, month: 1, day: 0 } }, at("2023-12-31T00:00:00Z")],
    [{ $dateFromParts: { year: 2024, month: 2, day: 30, hour: 25 } }, at("2024-03-02T01:00:00Z")],
    [{ $dateFromParts: { isoWeekYear: 2020, isoWeek: 53, isoDayOfWeek: 7 } }, at("2021-01-03T00:00:00Z")],
    [{ $dateFromParts: { isoWeekYear: 2021 } }, at("2021-01-04T00:00:00Z")],
    [{ $dateFromParts: { year: null } }, null],
    [{ $dateAdd: { startDate: at("2024-01-31T10:00:00Z"), unit: "month", amount: 1 } }, at("2024-02-29T10:00:00Z")],
    [{ $dateAdd: { startDate: at("2024-02-29T10:00:00Z"), unit: "year", amount: 1 } }, at("2025-02-28T10:00:00Z")],
    [{ $dateAdd: { startDate: WHEN, unit: "day", amount: 2 } }, at("2024-03-12T13:45:30.123Z")],
    [
      { $dateSubtract: { startDate: at("2024-03-31T10:00:00Z"), unit: "month", amount: 1 } },
      at("2024-02-29T10:00:00Z"),
    ],
    [{ $dateSubtract: { startDate: WHEN, unit: "week", amount: 1 } }, at("2024-03-03T13:45:30.123Z")],
    [{ $dateAdd: { startDate: WHEN, unit: "day", amount: null } }, null],
    [{ $dateDiff: { startDate: at("2024-01-31T23:59:59Z"), endDate: at("2024-02-01T00:00:01Z"), unit: "month" } }, 1],
    [{ $dateDiff: { startDate: at("2024-03-09T10:00:00Z"), endDate: at("2024-03-11T10:00:00Z"), unit: "week" } }, 1],
    [
      {
        $dateDiff: {
          startDate: at("2024-03-09T10:00:00Z"),
          endDate: at("2024-03-11T10:00:00Z"),
          unit: "week",
          startOfWeek: "tuesday",
        },
      },
      0,
    ],
    [{ $dateDiff: { startDate: WHEN, endDate: at("2024-03-09T00:00:00Z"), unit: "day" } }, -1],
    [{ $dateTrunc: { date: at("2024-03-13T13:45:30.123Z"), unit: "week" } }, at("2024-03-10T00:00:00Z")],
    [
      { $dateTrunc: { date: at("2024-03-13T13:45:30.123Z"), unit: "week", startOfWeek: "monday" } },
      at("2024-03-11T00:00:00Z"),
    ],
    [{ $dateTrunc: { date: WHEN, unit: "quarter" } }, at("2024-01-01T00:00:00Z")],
    [{ $dateTrunc: { date: at("2024-03-13T13:45:30.123Z"), unit: "day", binSize: 7 } }, at("2024-03-09T00:00:00Z")],
    [{ $dateTrunc: { date: at("2024-03-13T13:45:30.123Z"), unit: "year", binSize: 7 } }, at("2021-01-01T00:00:00Z")],
    [{ $dateToString: { date: WHEN } }, "2024-03-10T13:45:30.123Z"],
    [
      { $dateToString: { date: WHEN, format: "%b %B %j %w %u %U %V %G %z %Z %%" } },
      "Mar March 070 1 7 10 10 2024 +0000 0 %",
    ],
    [{ $dateToString: { date: null } }, null],
    [{ $dateToString: { date: null, onNull: "none" } }, "none"],
    [{ $dateToString: { date: at("+010000-06-01T00:00:00Z"), format: "%m-%d" } }, "06-01"],
    [{ $dateFromString: { dateString: "2024-03-10" } }, at("2024-03-10T00:00:00Z")],
    [{ $dateFromString: { dateString: "2024-03-10T13:45:30.1Z" } }, at("2024-03-10T13:45:30.100Z")],
    [{ $dateFromString: { dateString: "2024-03-10T13:45" } }, at("2024-03-10T13:45:00Z")],
    [{ $dateFromString: { dateString: "2024-03-10T13:45:30+01:00" } }, at("2024-03-10T12:45:30Z")],
    [{ $dateFromString: { dateString: null, onNull: "none" } }, "none"],
    [{ $dateFromString: { dateString: "2024-02-30", onError: "bad" } }, "bad"],
    [{ $dateFromString: { dateString: 5, onError: null } }, null],
    [{ $toDate: 4294967296 }, at("1970-02-19T17:02:47.296Z")],
    [{ $toDate: -1.5 }, at("1969-12-31T23:59:59.999Z")],
    [{ $toDate: "2024-03-10" }, at("2024-03-10T00:00:00Z")],
    [{ $toDate: new ObjectId(OID) }, at("2012-10-17T21:13:27Z")],
    [{ $toDate: WHEN }, WHEN],
    [{ $toDate: null }, null],
    [{ $tsSecond: new Timestamp({ t: 1710000000, i: 7 }) }, 1710000000],
    [{ $tsIncrement: new Timestamp({ t: 1710000000, i: 7 }) }, 7],
    [{ $tsSecond: new Timestamp({ t: 4294967295, i: 1 }) }, 4294967295],
    [{ $tsIncrement: null }, null],
  ])("%j is %j", (mql, expected) => {
    expect(value(mql)).toEqual(expected);
  });

  it.each<[string, unknown]>([
    ["a named time zone", { $year: { date: WHEN, timezone: "America/New_York" } }],
    ["the zone Z, which the server refuses", { $year: { date: WHEN, timezone: "Z" } }],
    ["an offset that is not zero", { $dateAdd: { startDate: WHEN, unit: "day", amount: 1, timezone: "+01:00" } }],
    ["a time zone of $dateToString", { $dateToString: { date: WHEN, timezone: "Europe/Paris" } }],
    ["a time zone of $dateFromParts", { $dateFromParts: { year: 2024, timezone: "+01:00" } }],
    ["a string as a date", { $year: "2024-03-10" }],
    ["a number as a date", { $month: 5 }],
    ["a document with an unknown key", { $year: { date: WHEN, zone: "UTC" } }],
    ["two arguments of $year", { $year: [WHEN, WHEN] }],
    ["a unit that the server does not know", { $dateAdd: { startDate: WHEN, unit: "decade", amount: 1 } }],
    ["a fractional amount", { $dateAdd: { startDate: WHEN, unit: "day", amount: 1.5 } }],
    ["a date beyond the range of a Date", { $dateAdd: { startDate: WHEN, unit: "year", amount: 300000 } }],
    ["a bin size of zero", { $dateTrunc: { date: WHEN, unit: "day", binSize: 0 } }],
    ["a fractional bin size", { $dateTrunc: { date: WHEN, unit: "day", binSize: 1.5 } }],
    ["a week start that is not a name", { $dateTrunc: { date: WHEN, unit: "week", startOfWeek: "mon" } }],
    [
      "a null week start for a unit that is not a week",
      { $dateDiff: { startDate: WHEN, endDate: WHEN, unit: "day", startOfWeek: null } },
    ],
    [
      "a difference beyond 2^53",
      {
        $dateDiff: {
          startDate: at("-271821-04-20T00:00:00Z"),
          endDate: at("+275760-09-13T00:00:00Z"),
          unit: "millisecond",
        },
      },
    ],
    ["a year of 0 in $dateFromParts", { $dateFromParts: { year: 0 } }],
    ["a month beyond 16 bits", { $dateFromParts: { year: 2024, month: 32768 } }],
    ["a fractional part", { $dateFromParts: { year: 2024, month: 1.5 } }],
    ["a calendar part beside an ISO part", { $dateFromParts: { year: 2024, isoWeek: 1 } }],
    ["no year", { $dateFromParts: { month: 1 } }],
    ["a specifier that the server does not know", { $dateToString: { date: WHEN, format: "%a" } }],
    ["a percent sign at the end", { $dateToString: { date: WHEN, format: "100%" } }],
    ["a year that %Y cannot write", { $dateToString: { date: at("+010000-06-01T00:00:00Z"), format: "%Y" } }],
    ["a format operand of $dateFromString", { $dateFromString: { dateString: "2024-03-10", format: "%Y-%m-%d" } }],
    ["a string that the rule does not read: no separators", { $dateFromString: { dateString: "20240310" } }],
    ["a string that the rule does not read: one digit", { $dateFromString: { dateString: "2024-3-5" } }],
    ["a string that the rule does not read: a week date", { $toDate: "2024-W10-2" }],
    ["a string that the rule does not read: a year", { $dateFromString: { dateString: "2024" } }],
    [
      "a string that no ISO form reads, with an onError",
      { $dateFromString: { dateString: "garbage", onError: "bad" } },
    ],
    ["a string that fails, with no onError", { $dateFromString: { dateString: "2024-02-30" } }],
    ["an int in $toDate, which the server refuses", { $toDate: 0 }],
    ["an integer inside 32 bits in $toDate, whose kind is not known", { $toDate: { $add: [1, 1] } }],
    ["a Long in $toDate", { $toDate: new Long(5) }],
    ["a boolean in $toDate", { $toDate: true }],
    ["a number beyond the range of a Date in $toDate", { $toDate: 9e15 }],
    ["a number as a timestamp", { $tsSecond: 5 }],
    ["a Date as a timestamp", { $tsIncrement: WHEN }],
  ])("has no value for %s", (_, mql) => {
    refused(mql);
  });

  it("reads a date a second time, so the answer feeds another operator", () => {
    expect(value({ $year: { $dateAdd: { startDate: WHEN, unit: "year", amount: 1 } } })).toBe(2025);
    expect(value({ $dateToString: { date: { $toDate: "2024-03-10" }, format: "%d/%m" } })).toBe("10/03");
  });
});

describe("regular expressions", () => {
  const match = (input: unknown, regex: unknown, options?: string): unknown =>
    value({ $regexMatch: { input, regex, ...(options === undefined ? {} : { options }) } });
  const find = (input: unknown, regex: unknown, options?: string): unknown =>
    value({ $regexFind: { input, regex, ...(options === undefined ? {} : { options }) } });
  const findAll = (input: unknown, regex: unknown, options?: string): unknown =>
    value({ $regexFindAll: { input, regex, ...(options === undefined ? {} : { options }) } });

  it("matches the syntax that PCRE2 and JavaScript share", () => {
    expect(match("abc", "^a[a-c]+$")).toBe(true);
    expect(match("ABC", "^[a-c]+$", "i")).toBe(true);
    expect(match("x1", "^\\w\\d$")).toBe(true);
    expect(match("é", "\\w")).toBe(false);
    expect(match("a\u00a0", "a\\s")).toBe(false);
    expect(match("a\u000b", "a\\s")).toBe(true);
    expect(match("abc\n", "c$")).toBe(true);
    expect(match("abc\n\n", "c$")).toBe(false);
    expect(match("a.b", "a\\.b")).toBe(true);
    expect(match("axb", "a\\.b")).toBe(false);
    expect(match("ab", "a(?=b)")).toBe(true);
    expect(match("ab", "a(?!b)")).toBe(false);
    expect(match("abab", "^(?:ab)+$")).toBe(true);
    expect(match("b", "^(?:a|b)$")).toBe(true);
    expect(match("a-", "^[a-]{2}$")).toBe(true);
    expect(match(null, "a")).toBe(false);
  });

  it("finds a match with its position in code points", () => {
    expect(find("é😀z", "z")).toEqual({ match: "z", idx: 2, captures: [] });
    expect(find("xyz", "(a)|(y)")).toEqual({ match: "y", idx: 1, captures: [null, "y"] });
    expect(find("xy", "(a)?y(z)?")).toEqual({ match: "y", idx: 1, captures: [null, null] });
    expect(find("abc", "x")).toBe(null);
    expect(find(null, "a")).toBe(null);
  });

  it("finds every match, and no empty match at the end that the server does not report", () => {
    expect(findAll("aaa", "a").length).toBe(3);
    expect(findAll("aaaa", "aa|a")).toEqual([
      { match: "aa", idx: 0, captures: [] },
      { match: "aa", idx: 2, captures: [] },
    ]);
    expect(findAll("baaa", "a*")).toEqual([
      { match: "", idx: 0, captures: [] },
      { match: "aaa", idx: 1, captures: [] },
    ]);
    expect(findAll("abc", "").length).toBe(3);
    expect(findAll("", "")).toEqual([{ match: "", idx: 0, captures: [] }]);
    expect(findAll("ab", "(?=$)")).toEqual([{ match: "", idx: 2, captures: [] }]);
    expect(findAll(null, "a")).toEqual([]);
  });

  it("splits the words of a string with the pattern that the lowerings write", () => {
    const words = (input: string): unknown =>
      (findAll(input, "[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[A-Z]|[0-9]+") as { match: string }[]).map((m) => m.match);
    expect(words("fooBar-baz 9")).toEqual(["foo", "Bar", "baz", "9"]);
    expect(words("XMLHttpRequest")).toEqual(["XML", "Http", "Request"]);
    expect(words("")).toEqual([]);
  });

  it.each<[string, unknown]>([
    ["a dot", { $regexMatch: { input: "a", regex: "." } }],
    ["a lazy quantifier", { $regexMatch: { input: "a", regex: "a+?" } }],
    ["a possessive quantifier", { $regexMatch: { input: "a", regex: "a*+" } }],
    ["a quantifier with no minimum", { $regexMatch: { input: "a", regex: "a{,2}" } }],
    ["a quantifier after a quantifier", { $regexMatch: { input: "a", regex: "a{2}{3}" } }],
    ["a quantifier after an anchor", { $regexMatch: { input: "a", regex: "^*a" } }],
    ["a quantifier after a lookahead", { $regexMatch: { input: "a", regex: "(?=a)*a" } }],
    ["a word boundary", { $regexMatch: { input: "a", regex: "\\ba" } }],
    ["a negated shorthand", { $regexMatch: { input: "a", regex: "\\D" } }],
    ["a backreference", { $regexMatch: { input: "aa", regex: "(a)\\1" } }],
    ["a property class", { $regexMatch: { input: "a", regex: "\\p{L}" } }],
    ["a POSIX class", { $regexMatch: { input: "a", regex: "[[:alpha:]]" } }],
    ["a named group", { $regexMatch: { input: "a", regex: "(?<n>a)" } }],
    ["an inline option", { $regexMatch: { input: "a", regex: "(?i)A" } }],
    ["a lookbehind", { $regexMatch: { input: "ab", regex: "(?<=a)b" } }],
    ["a non-ASCII pattern", { $regexMatch: { input: "é", regex: "é" } }],
    ["a bare brace", { $regexMatch: { input: "a{", regex: "a{" } }],
    ["a bare bracket", { $regexMatch: { input: "]", regex: "]" } }],
    ["an unclosed group", { $regexMatch: { input: "a", regex: "(a" } }],
    ["an unmatched parenthesis", { $regexMatch: { input: "a", regex: "a)" } }],
    ["an empty class", { $regexMatch: { input: "a", regex: "[]" } }],
    ["a range out of order", { $regexMatch: { input: "a", regex: "[c-a]" } }],
    ["a capture inside a repeated group", { $regexFind: { input: "ab", regex: "(?:(a)|b)+" } }],
    ["a capture inside a lookahead", { $regexFind: { input: "ab", regex: "a(?=(b))" } }],
    ["a repeated group with an alternation", { $regexMatch: { input: "a", regex: "(?:a|b)+" } }],
    ["a repeated group with a quantifier", { $regexMatch: { input: "a", regex: "(?:a+)+" } }],
    ["a repeated group that can be empty", { $regexMatch: { input: "a", regex: "(?:a?)*" } }],
    ["a count above the limit", { $regexMatch: { input: "a", regex: "a{101}" } }],
    ["an option of m", { $regexMatch: { input: "a", regex: "a", options: "m" } }],
    ["an option of x", { $regexMatch: { input: "a", regex: "a", options: "x" } }],
    ["a null pattern", { $regexMatch: { input: "a", regex: null } }],
    ["a field path as the pattern", { $regexMatch: { input: "a", regex: "$a" } }],
    ["a number as the input", { $regexMatch: { input: 1, regex: "a" } }],
    ["a string with a null byte", { $regexMatch: { input: "a\u0000", regex: "a" } }],
    ["a letter that folds to an ASCII letter", { $regexMatch: { input: "\u017f", regex: "s", options: "i" } }],
    ["a string too long for its pattern", { $regexMatch: { input: "a".repeat(30000), regex: "a" } }],
    ["a pattern too long", { $regexMatch: { input: "a", regex: "a".repeat(201) } }],
    ["an unknown key", { $regexMatch: { input: "a", regex: "a", extra: 1 } }],
  ])("has no value for %s", (_, mql) => {
    refused(mql);
  });
});
