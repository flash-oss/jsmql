import { describe, expect, it } from "vitest";
import { expr, filter, pipeline } from "../src/compiler/index.ts";
import { Long } from "../src/bson.ts";
import { NAMES } from "../src/registry/names.ts";
import { operandShapeOf } from "../src/compiler/rows.ts";

const TRUTHY = (v: unknown) => ({ $and: [{ $gt: [v, null] }, { $ne: [v, false] }, { $ne: [v, ""] }, { $ne: [v, 0] }] });

describe("compiler/emit/lower — literals and references", () => {
  it("lowers each literal to its BSON value", () => {
    expect(expr("42")).toBe(42);
    expect(expr('"x"')).toBe("x");
    expect(expr("true")).toBe(true);
    expect(expr("null")).toBe(null);
    expect(expr("123n")).toEqual(Long.fromString("123"));
    expect(String(expr("0x507f1f77bcf86cd799439011"))).toBe("507f1f77bcf86cd799439011");
    expect(expr("`n=${$.n}`")).toEqual({ $concat: ["n=", { $toString: "$n" }] });
    expect(expr("`a${$.s.trim()}`")).toEqual({ $concat: ["a", { $trim: { input: { $ifNull: ["$s", ""] } } }] });
    expect(expr("`a${$.n.abs()}`")).toEqual({ $concat: ["a", { $toString: { $abs: { $ifNull: ["$n", 0] } } }] });
  });

  it("refuses the literals that have no value", () => {
    expect(() => expr("undefined")).toThrow(/only meaningful in a comparison/);
    expect(() => expr("/x/i")).toThrow(/In JavaScript code, a regex literal is valid only as an argument of/);
    expect(() => expr("x => x")).toThrow(
      "A function (=>) is only valid as the callback to an array method that iterates (.map, .filter, .some, .every, .find, .reduce, …), or as the second argument to $let.",
    );
  });

  it("spells a field path, the root, and a bracketed field", () => {
    expect(expr("$.a.b")).toBe("$a.b");
    expect(expr("$")).toBe("$$ROOT");
    expect(expr('$["a.b"]')).toBe("$a.b");
    expect(expr("$.a?.b.c")).toEqual({ $ifNull: ["$a.b.c", null] });
  });

  it("groups literal elements around a spread", () => {
    expect(expr("[1, ...$.a]")).toEqual({ $concatArrays: [[1], { $ifNull: ["$a", []] }] });
    expect(expr("[...$.a, ...$.b]")).toEqual({ $concatArrays: [{ $ifNull: ["$a", []] }, { $ifNull: ["$b", []] }] });
    expect(expr("{ a: 1, ...$.o }")).toEqual({ $mergeObjects: [{ a: 1 }, "$o"] });
    expect(expr("{ [$.k]: 1, b: 2 }")).toEqual({
      $arrayToObject: [
        [
          { k: { $toString: { $ifNull: ["$k", ""] } }, v: 1 },
          { k: "b", v: 2 },
        ],
      ],
    });
  });
});

describe("compiler/emit/lower — operators", () => {
  it("lowers each binary operator by its production's renderer", () => {
    expect(expr("$.qty * $.price")).toEqual({ $multiply: ["$qty", "$price"] });
    expect(expr("$.a * 2 * 3")).toEqual({ $multiply: ["$a", 2, 3] });
    expect(expr("$.a - 1")).toEqual({ $subtract: ["$a", 1] });
    expect(expr("$.a ** 2")).toEqual({ $pow: ["$a", 2] });
    expect(expr("$.a ?? $.b ?? 1")).toEqual({ $ifNull: ["$a", "$b", 1] });
    expect(expr("$.a === 1")).toEqual({ $eq: ["$a", 1] });
    expect(expr("$.a >= 1")).toEqual({ $gte: ["$a", 1] });
    expect(expr("$.a in [1, 2]")).toEqual({ $in: ["$a", [1, 2]] });
  });

  it("reads `+` as $concat when an operand is a string, $add otherwise", () => {
    expect(expr("$.a + $.b")).toEqual({ $add: ["$a", "$b"] });
    expect(expr('$.s + "x"')).toEqual({ $concat: ["$s", "x"] });
  });

  it("refuses a proven date in an arithmetic operator, and names the date methods", () => {
    const methods =
      " To add time to a date or subtract time from it, use '.plus(n, unit)' or '.minus(n, unit)'. For the time between two dates, use '.diff(other, unit)'.";
    const day = '$.d.startOf("day")';
    expect(() => expr(`${day} + 1`)).toThrow(`'+' argument 1 takes a number or a string, but got a date.${methods}`);
    expect(() => expr(`1 + ${day}`)).toThrow(`'+' argument 2 takes a number or a string, but got a date.${methods}`);
    expect(() => expr(`${day} - 1`)).toThrow(`'-' argument 1 takes a number, but got a date.${methods}`);
    expect(() => expr(`${day} - $.e`)).toThrow(`'-' argument 1 takes a number, but got a date.${methods}`);
    expect(() => expr(`$.e - ${day}`)).toThrow(`'-' argument 2 takes a number, but got a date.${methods}`);
    for (const op of ["*", "/", "%", "**"]) {
      expect(() => expr(`${day} ${op} 2`)).toThrow(`'${op}' argument 1 takes a number, but got a date.${methods}`);
    }
    expect(expr("$.d - 1")).toEqual({ $subtract: ["$d", 1] });
    expect(expr(`${day} > $.e`)).toEqual({
      $gt: [{ $dateTrunc: { date: { $ifNull: ["$d", new Date(0)] }, unit: "day" } }, "$e"],
    });
  });

  it("lowers the unary operators", () => {
    expect(expr("-$.a")).toEqual({ $multiply: ["$a", -1] });
    expect(expr("~$.a")).toEqual({ $bitNot: "$a" });
    expect(expr("typeof $.a")).toEqual({ $type: "$a" });
    expect(expr("!$.a")).toEqual({ $not: TRUTHY("$a") });
    expect(expr("!!$.a")).toEqual(TRUTHY("$a"));
    expect(expr("!($.a > 1)")).toEqual({ $not: { $gt: ["$a", 1] } });
  });

  it("checks truthiness on a value and not on a boolean", () => {
    expect(expr("$.a ? 1 : 2")).toEqual({ $cond: [TRUTHY("$a"), 1, 2] });
    expect(expr("$.a > 1 ? 1 : 2")).toEqual({ $cond: [{ $gt: ["$a", 1] }, 1, 2] });
    expect(expr("$.a > 1 && $.b < 2")).toEqual({ $and: [{ $gt: ["$a", 1] }, { $lt: ["$b", 2] }] });
    expect(expr("$.a && $.b")).toEqual({ $cond: [TRUTHY("$a"), "$b", "$a"] });
    expect(expr("$.a || $.b")).toEqual({ $cond: [TRUTHY("$a"), "$a", "$b"] });
  });

  it("binds a computed left side once, under a namespaced mint", () => {
    const out = expr("$.a && $.b || $.c") as { $let: { vars: Record<string, unknown>; in: unknown } };
    expect(Object.keys(out.$let.vars)).toEqual(["jsmqlV"]);
    expect(out.$let.in).toEqual({ $cond: [TRUTHY("$$jsmqlV"), "$$jsmqlV", "$c"] });
  });

  it("lowers the presence and type tests through the predicate vocabulary", () => {
    expect(expr("$.a !== undefined")).toEqual({ $ne: [{ $type: "$a" }, "missing"] });
    expect(expr('typeof $.a === "bool"')).toEqual({ $eq: [{ $type: "$a" }, "bool"] });
    expect(() => expr('typeof $.a === "boolean"')).toThrow(/Did you mean 'bool'\?/);
    expect(expr("$.a == null")).toEqual({ $lte: ["$a", null] });
    expect(() => expr("$.a == 1")).toThrow(/only allowed against null/);
  });
});

describe("compiler/emit/lower — access", () => {
  it("reads an index by what the receiver is proven to be", () => {
    expect(expr("[1, 2][0]")).toBe(1);
    expect(expr("[$.a, 2][0]")).toEqual({ $arrayElemAt: [["$a", 2], 0] });
    expect(expr("$.a[0]")).toEqual({
      $switch: {
        branches: [
          { case: { $isArray: "$a" }, then: { $arrayElemAt: ["$a", 0] } },
          { case: { $eq: [{ $type: "$a" }, "string"] }, then: { $substrCP: ["$a", 0, 1] } },
        ],
        default: { $getField: { field: "0", input: { $ifNull: ["$a", {}] } } },
      },
    });
    expect(expr('$.o["k-1"]')).toEqual({ $getField: { field: "k-1", input: { $ifNull: ["$o", {}] } } });
    expect(expr("$.a[$.i]")).toEqual({
      $switch: {
        branches: [{ case: { $and: [{ $isArray: "$a" }, { $isNumber: "$i" }] }, then: { $arrayElemAt: ["$a", "$i"] } }],
        default: { $getField: { field: { $toString: { $ifNull: ["$i", ""] } }, input: { $ifNull: ["$a", {}] } } },
      },
    });
    expect(() => expr("$.a[-1]")).toThrow(/Negative bracket index/);
  });

  it("reads a count from the method's one family, and proves a literal's count", () => {
    expect(expr("[1, 2].size()")).toBe(2);
    expect(expr('"abc".length()')).toBe(3);
    expect(expr("[$.a, 2].size()")).toBe(2);
    expect(expr("$.x.length()")).toEqual({ $strLenCP: { $ifNull: ["$x", ""] } });
    expect(expr("$.x.size()")).toEqual({ $size: { $ifNull: ["$x", []] } });
    expect(() => expr("[$.a, 2].length()")).toThrow(
      "'.length()' is not available on an 'array' — it is defined on 'string'. For the number of elements, write '.size()'.",
    );
  });

  it("reads a namespace member from its row", () => {
    expect(expr("Math.PI")).toBe(3.141592653589793);
  });
});

describe("compiler/emit/lower — calls", () => {
  it("runs a MongoDB operator's row, positional or object-shaped", () => {
    expect(expr("$abs($.a)")).toEqual({ $abs: "$a" });
    expect(expr("$sum($.a, $.b)")).toEqual({ $sum: ["$a", "$b"] });
    expect(expr("$eq([$.n, 4])")).toEqual({ $eq: ["$n", 4] });
    expect(expr("$size([$.a])")).toEqual({ $size: ["$a"] });
    expect(expr("$size([$.a, 1])")).toEqual({ $size: ["$a", 1] });
    expect(expr('$arrayToObject([[["a", 1], ["b", 2]]])')).toEqual({
      $arrayToObject: [
        [
          ["a", 1],
          ["b", 2],
        ],
      ],
    });
    expect(expr('$literal(["$a", "$b"])')).toEqual({ $literal: ["$a", "$b"] });
    expect(expr("$concatArrays([...$.a, [1]])")).toEqual({
      $concatArrays: { $concatArrays: [{ $ifNull: ["$a", []] }, [[1]]] },
    });
    expect(expr("$let({ v_x: 1 }, (v_x) => v_x)")).toEqual({ $let: { vars: { v_v_5fx: 1 }, in: "$$v_v_5fx" } });
    expect(expr('$dateTrunc($.t, "day")')).toEqual({ $dateTrunc: { date: "$t", unit: "day" } });
    expect(expr("$cond($.a, 1, 2)")).toEqual({ $cond: { if: "$a", then: 1, else: 2 } });
    expect(expr('$literal("$x")')).toEqual({ $literal: "$x" });
    expect(expr("$foo($.a)")).toEqual({ $foo: "$a" });
  });

  it("passes ONE operand of a list operator through as written, in both spellings (HR1, HR2)", () => {
    const disagree: string[] = [];
    let checked = 0;
    for (const [name, row] of Object.entries(NAMES)) {
      if (row.kind !== "mongo" || operandShapeOf(name) !== "array" || !row.where?.includes("value")) continue;
      checked++;
      const raw = { [name]: "$nope" };
      const written = expr(`{ ${name}: "$nope" }`);
      const called = expr(`${name}($.nope)`);
      if (JSON.stringify(written) !== JSON.stringify(raw)) disagree.push(`${name}: written ${JSON.stringify(written)}`);
      if (JSON.stringify(called) !== JSON.stringify(raw)) disagree.push(`${name}: called ${JSON.stringify(called)}`);
    }
    expect(disagree).toEqual([]);
    expect(checked).toBeGreaterThanOrEqual(30);
  });

  it("binds a `$let` arrow's parameters to its vars, and refuses one that names something else", () => {
    expect(expr("$let({ x: 1 }, (x) => x + 1)")).toEqual({ $let: { vars: { x: 1 }, in: { $add: ["$$x", 1] } } });
    expect(() => expr("$let({ x: 1 }, (y) => y + 1)")).toThrow(/must name its variables/);
  });

  it("lowers a constructor by its argument class, and refuses a value of the document", () => {
    expect(expr("Date()")).toBe("$$NOW");
    expect(expr("ObjectId()")).toEqual({ $createObjectId: {} });
    expect(() => expr("Date($.ms)")).toThrow(/Write '<value>\.toDate\(\)': '\$\.x\.toDate\(\)'/);
    expect(() => expr("ObjectId($.id)")).toThrow(/Write '<value>\.toObjectId\(\)'/);
    expect(() => expr("Number($.s)")).toThrow(/^'Number\(x\)' is not part of JSMQL.*'\$\.x\?\.toDouble\(\)'/);
    expect(() => expr('Number("3")')).toThrow(/^'Number\(x\)' is not part of JSMQL/);
  });

  it("inlines a declared function and refuses recursion", () => {
    expect(expr("(() => { const y = $.a * 2; return y + 1 })()")).toEqual({
      $let: { vars: { y: { $multiply: ["$a", 2] } }, in: { $add: ["$$y", 1] } },
    });
    expect(expr("(() => $.a * 2)()")).toEqual({ $multiply: ["$a", 2] });
    expect(expr("((x) => x * $.a)(2)")).toEqual({ $let: { vars: { x: 2 }, in: { $multiply: ["$$x", "$a"] } } });
  });

  it("refuses a MongoDB operator or a global function on a receiver, because neither one reads it", () => {
    const sizeOnValue =
      "'.$size()' takes no receiver. A '$' name is a MongoDB operator or stage, and each one is a call: write '$size(…)' with every operand inside the parentheses.";
    expect(() => expr("$.a.$size($.b)")).toThrow(sizeOnValue);
    expect(() => expr("$.a.$size()")).toThrow(sizeOnValue);
    expect(() => filter("$.tags.$size(2)")).toThrow(sizeOnValue);
    expect(() => filter("$.a.$size($.b) > 1")).toThrow(sizeOnValue);
    expect(() => pipeline("$.n = $.a.$size($.b);")).toThrow(sizeOnValue);
    expect(() => expr("$.a.$foo()")).toThrow(/^'\.\$foo\(\)' takes no receiver\./);
    expect(() => expr("$.a.Long(7)")).toThrow(
      "'.Long()' takes no receiver. 'Long' is a global function: write 'Long(…)' with the value inside the parentheses.",
    );
    expect(() => expr('$.a.Number("7")')).toThrow(/^'Number\(x\)' is not part of JSMQL/);
    expect(() => expr("$.items.$sort({ a: 1 })")).toThrow(/For the value form, use '\$sortArray\(…\)'/);
    expect(expr("$size($.a)")).toEqual({ $size: "$a" });
    expect(expr("Long(7)")).toEqual(Long.fromNumber(7));
  });

  it("refuses a name from a closed set with a suggestion", () => {
    expect(() => expr("$.s.trimm()")).toThrow(/Unknown method '.trimm\(\)' at position 3. Did you mean '.trim\(\)'/);
    expect(() => expr("$.s.toDoubel()")).toThrow(/Did you mean '.toDouble\(\)'/);
    expect(() => expr("$.s.Numbr()")).toThrow(/^Unknown method '.Numbr\(\)' at position 3.$/);
    expect(() => expr("Math.randon()")).toThrow(
      /Unknown method 'Math.randon\(\)' at position 4. Did you mean 'Math.random'/,
    );
  });
});

describe("compiler/emit/lower — a path segment that starts with `$`", () => {
  it("reads it through $getField with the name as a literal, and every segment after it too", () => {
    expect(expr("$.qty.$gt")).toEqual({ $getField: { field: { $literal: "$gt" }, input: "$qty" } });
    expect(expr("$.a.$b.c")).toEqual({
      $getField: { field: "c", input: { $getField: { field: { $literal: "$b" }, input: "$a" } } },
    });
    expect(() => expr("$.items.filter({ qty: { $gt: 5 } })")).toThrow(
      "'{ $gt: … }' is raw MQL, and raw MQL cannot be an operand of '.filter()'.",
    );
  });
});
