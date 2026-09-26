// Phase 5 of src/compiler/ — the value target, end to end.
//
// Each case is a JSMQL input and the MQL the compiler emits for it. The expectation
// is the shape the registry states — the `$switch` dispatch a receiver of unprovable
// family takes, and the `jsmql`-prefixed mint every expression variable carries.

import { describe, expect, it } from "vitest";
import { expr } from "../src/compiler/index.ts";
import { Long } from "../src/bson.ts";

const TRUTHY = (v: unknown) => ({
  $and: [{ $ne: [{ $ifNull: [v, null] }, null] }, { $ne: [v, false] }, { $ne: [v, ""] }, { $ne: [v, 0] }],
});

describe("compiler/emit/lower — literals and references", () => {
  it("lowers each literal to its BSON value", () => {
    expect(expr("42")).toBe(42);
    expect(expr('"x"')).toBe("x");
    expect(expr("true")).toBe(true);
    expect(expr("null")).toBe(null);
    expect(expr("123n")).toEqual(Long.fromString("123"));
    expect(String(expr("0x507f1f77bcf86cd799439011"))).toBe("507f1f77bcf86cd799439011");
    expect(expr("`n=${$.n}`")).toEqual({ $concat: ["n=", { $toString: "$n" }] });
    // a row that states `returns: "string"` needs no $toString; an unknown one does
    expect(expr("`a${$toUpper($.s)}`")).toEqual({ $concat: ["a", { $toUpper: "$s" }] });
    expect(expr("`a${$abs($.n)}`")).toEqual({ $concat: ["a", { $toString: { $abs: "$n" } }] });
  });

  it("refuses the literals that have no value", () => {
    expect(() => expr("undefined")).toThrow(/only meaningful in a comparison/);
    expect(() => expr("/x/i")).toThrow(/Regex literals are only valid/);
    expect(() => expr("x => x")).toThrow();
  });

  it("spells a field path, the root, and a bracketed field", () => {
    expect(expr("$.a.b")).toBe("$a.b");
    expect(expr("$")).toBe("$$ROOT");
    expect(expr('$["a.b"]')).toBe("$a.b");
    // a `?.` read is JavaScript's `undefined` when the path is not there, and a document written
    // with it holds the key — so it is null, never missing
    expect(expr("$.a?.b.c")).toEqual({ $ifNull: ["$a.b.c", null] });
  });

  it("groups literal elements around a spread", () => {
    expect(expr("[1, ...$.a]")).toEqual({ $concatArrays: [[1], { $ifNull: ["$a", []] }] });
    expect(expr("[...$.a, ...$.b]")).toEqual({ $concatArrays: [{ $ifNull: ["$a", []] }, { $ifNull: ["$b", []] }] });
    expect(expr("{ a: 1, ...$.o }")).toEqual({ $mergeObjects: [{ a: 1 }, "$o"] });
    expect(expr("{ [$.k]: 1, b: 2 }")).toEqual({
      $arrayToObject: [
        [
          { k: "$k", v: 1 },
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

  it("lowers the unary operators", () => {
    expect(expr("-$.a")).toEqual({ $multiply: ["$a", -1] });
    expect(expr("~$.a")).toEqual({ $bitNot: "$a" });
    expect(expr("typeof $.a")).toEqual({ $type: "$a" });
    expect(expr("!$.a")).toEqual({ $not: TRUTHY("$a") });
    expect(expr("!!$.a")).toEqual(TRUTHY("$a"));
    expect(expr("!($.a > 1)")).toEqual({ $not: { $gt: ["$a", 1] } });
  });

  it("checks truthiness on a value and not on a boolean", () => {
    expect(expr("$.a ? 1 : 2")).toEqual({ $cond: { if: TRUTHY("$a"), then: 1, else: 2 } });
    expect(expr("$.a > 1 ? 1 : 2")).toEqual({ $cond: { if: { $gt: ["$a", 1] }, then: 1, else: 2 } });
    expect(expr("$.a > 1 && $.b < 2")).toEqual({ $and: [{ $gt: ["$a", 1] }, { $lt: ["$b", 2] }] });
    expect(expr("$.a && $.b")).toEqual({ $cond: { if: TRUTHY("$a"), then: "$b", else: "$a" } });
    expect(expr("$.a || $.b")).toEqual({ $cond: { if: TRUTHY("$a"), then: "$a", else: "$b" } });
  });

  it("binds a computed left side once, under a namespaced mint", () => {
    const out = expr("$.a && $.b || $.c") as { $let: { vars: Record<string, unknown>; in: unknown } };
    expect(Object.keys(out.$let.vars)).toEqual(["jsmqlV"]);
    expect(out.$let.in).toEqual({ $cond: { if: TRUTHY("$$jsmqlV"), then: "$$jsmqlV", else: "$c" } });
  });

  it("lowers the presence and type tests through the predicate vocabulary", () => {
    expect(expr("$.a !== undefined")).toEqual({ $ne: [{ $type: "$a" }, "missing"] });
    expect(expr('typeof $.a === "bool"')).toEqual({ $eq: [{ $type: "$a" }, "bool"] });
    expect(() => expr('typeof $.a === "boolean"')).toThrow(/Did you mean 'bool'\?/);
    expect(expr("$.a == null")).toEqual({ $in: [{ $type: "$a" }, ["null", "missing"]] });
    expect(() => expr("$.a == 1")).toThrow(/only allowed against null/);
  });
});

describe("compiler/emit/lower — access", () => {
  it("reads an index by what the receiver is proven to be", () => {
    // a constant settles in the fold; the runtime shapes are for what the fold cannot see
    expect(expr("[1, 2][0]")).toBe(1);
    expect(expr("[$.a, 2][0]")).toEqual({ $arrayElemAt: [["$a", 2], 0] });
    // The dispatch is a `$switch`, never a nested `$cond`. The server optimises `$cond`
    // branches before it reads the test. A receiver it holds as a constant causes the
    // server to fold a branch that does not apply and refuse the pipeline.
    expect(expr("$.a[0]")).toEqual({
      $switch: {
        branches: [
          { case: { $isArray: "$a" }, then: { $arrayElemAt: ["$a", 0] } },
          { case: { $eq: [{ $type: "$a" }, "string"] }, then: { $substrCP: ["$a", 0, 1] } },
        ],
        default: { $getField: { field: "0", input: "$a" } },
      },
    });
    expect(expr('$.o["k-1"]')).toEqual({ $getField: { field: "k-1", input: "$o" } });
    expect(expr("$.a[$.i]")).toEqual({
      $switch: {
        branches: [{ case: { $isArray: "$a" }, then: { $arrayElemAt: ["$a", "$i"] } }],
        default: { $getField: { field: { $toString: { $ifNull: ["$i", ""] } }, input: "$a" } },
      },
    });
    expect(() => expr("$.a[-1]")).toThrow(/Negative bracket index/);
  });

  it("reads a count from the method's one family, and proves a literal's count", () => {
    expect(expr("[1, 2].size()")).toBe(2);
    expect(expr('"abc".length()')).toBe(3);
    // an array LITERAL receiver is the value, wrapped once — `{ $size: ["$a", 2] }` would be two operands
    expect(expr("[$.a, 2].size()")).toEqual({ $size: [["$a", 2]] });
    // an unproven receiver takes the method's one family, and the server judges the value:
    // `.length()` reads a string under a null guard, `.size()` reads a missing array as empty
    expect(expr("$.x.length()")).toEqual({
      $cond: { if: { $eq: [{ $ifNull: ["$x", null] }, null] }, then: null, else: { $strLenCP: "$x" } },
    });
    expect(expr("$.x.size()")).toEqual({ $size: { $ifNull: ["$x", []] } });
    // a proven array refuses `.length()`, and the refusal names `.size()`
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
    // HR2: one array literal is the operand list as written, counted by its elements
    expect(expr("$eq([$.n, 4])")).toEqual({ $eq: ["$n", 4] });
    expect(expr("$size([$.a])")).toEqual({ $size: ["$a"] });
    // a 1-operand operator given two elements can only mean the array VALUE: wrapped once
    expect(expr("$size([$.a, 1])")).toEqual({ $size: [["$a", 1]] });
    expect(expr('$arrayToObject([["a", 1], ["b", 2]])')).toEqual({
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

  it("binds a `$let` arrow's parameters to its vars, and refuses one that names something else", () => {
    expect(expr("$let({ x: 1 }, (x) => x + 1)")).toEqual({ $let: { vars: { x: 1 }, in: { $add: ["$$x", 1] } } });
    expect(() => expr("$let({ x: 1 }, (y) => y + 1)")).toThrow(/must name its variables/);
  });

  it("lowers the globals by their argument class", () => {
    expect(expr("Number($.s)")).toEqual({ $toDouble: "$s" });
    expect(expr("new Date($.ms)")).toEqual({ $toDate: "$ms" });
    expect(expr("ObjectId($.id)")).toEqual({ $toObjectId: "$id" });
    // never folded: `$toDouble("3")` is a double; the server judges a string it cannot parse
    expect(expr('Number("3")')).toEqual({ $toDouble: "3" });
    expect(expr('Number("abc")')).toEqual({ $toDouble: "abc" });
  });

  it("inlines a declared function and refuses recursion", () => {
    // a call with no parameters binds nothing, so no `$let` wraps the body
    expect(expr("(() => { const y = $.a * 2; return y + 1 })()")).toEqual({
      $let: { vars: { y: { $multiply: ["$a", 2] } }, in: { $add: ["$$y", 1] } },
    });
    expect(expr("(() => $.a * 2)()")).toEqual({ $multiply: ["$a", 2] });
    expect(expr("((x) => x * $.a)(2)")).toEqual({ $let: { vars: { x: 2 }, in: { $multiply: ["$$x", "$a"] } } });
  });

  it("refuses a name from a closed set with a suggestion", () => {
    expect(() => expr("$.s.trimm()")).toThrow(/Unknown method '.trimm\(\)' at position 3. Did you mean '.trim\(\)'/);
    expect(() => expr("Math.flor($.x)")).toThrow(
      /Unknown method 'Math.flor\(\)' at position 4. Did you mean 'Math.floor'/,
    );
  });
});

describe("compiler/emit/lower — a path segment that starts with `$`", () => {
  it("reads it through $getField with the name as a literal, and every segment after it too", () => {
    // "FieldPath field names may not start with '$'" — measured on mongod
    expect(expr("$.qty.$gt")).toEqual({ $getField: { field: { $literal: "$gt" }, input: "$qty" } });
    expect(expr("$.a.$b.c")).toEqual({
      $getField: { field: "c", input: { $getField: { field: { $literal: "$b" }, input: "$a" } } },
    });
    expect(expr("$.items.filter({ qty: { $gt: 5 } })")).toEqual({
      $filter: {
        input: { $ifNull: ["$items", []] },
        as: "x",
        cond: { $eq: [{ $getField: { field: { $literal: "$gt" }, input: "$$x.qty" } }, 5] },
      },
    });
  });
});
