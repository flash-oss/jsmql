import { describe, it, expect } from "vitest";
import { mjsql, validate, mql } from "../src/index.js";

describe("basic literals", () => {
  it("passes number through", () => {
    expect(mjsql("$abs(42)")).toEqual({ $abs: 42 });
  });

  it("passes string through", () => {
    expect(mjsql('$toLower("Hello")')).toEqual({ $toLower: "Hello" });
  });

  it("handles boolean", () => {
    expect(mjsql("$not(true)")).toEqual({ $not: true });
  });

  it("handles null", () => {
    expect(mjsql("$not(null)")).toEqual({ $not: null });
  });
});

describe("field refs", () => {
  it("simple field", () => {
    expect(mjsql("$abs($.delta)")).toEqual({ $abs: "$delta" });
  });

  it("nested field", () => {
    expect(mjsql("$year($.createdAt)")).toEqual({ $year: "$createdAt" });
  });

  it("deep nested field", () => {
    expect(mjsql("$abs($.address.city)")).toEqual({ $abs: "$address.city" });
  });
});

describe("single-shape operators", () => {
  it("$abs", () => {
    expect(mjsql("$abs($.delta)")).toEqual({ $abs: "$delta" });
  });

  it("$not", () => {
    expect(mjsql("$not($.active)")).toEqual({ $not: "$active" });
  });

  it("$size", () => {
    expect(mjsql("$size($.items)")).toEqual({ $size: "$items" });
  });

  it("$toLower", () => {
    expect(mjsql("$toLower($.name)")).toEqual({ $toLower: "$name" });
  });
});

describe("array-shape operators", () => {
  it("$eq two args", () => {
    expect(mjsql("$eq($.age, 18)")).toEqual({ $eq: ["$age", 18] });
  });

  it("$gt comparison", () => {
    expect(mjsql("$gt($.age, 18)")).toEqual({ $gt: ["$age", 18] });
  });

  it("$add multiple args", () => {
    expect(mjsql("$add($.a, $.b, $.c)")).toEqual({ $add: ["$a", "$b", "$c"] });
  });

  it("$and logical", () => {
    expect(mjsql('$and($gt($.age, 18), $eq($.status, "active"))')).toEqual({
      $and: [{ $gt: ["$age", 18] }, { $eq: ["$status", "active"] }],
    });
  });

  it("$or logical", () => {
    expect(mjsql("$or($eq($.a, 1), $eq($.b, 2))")).toEqual({
      $or: [{ $eq: ["$a", 1] }, { $eq: ["$b", 2] }],
    });
  });

  it("$in with array literal", () => {
    expect(mjsql('$in($.status, ["active", "pending"])')).toEqual({
      $in: ["$status", ["active", "pending"]],
    });
  });

  it("$ifNull varargs", () => {
    expect(mjsql('$ifNull($.nickname, $.firstName, "Unknown")')).toEqual({
      $ifNull: ["$nickname", "$firstName", "Unknown"],
    });
  });
});

describe("nested operators", () => {
  it("deeply nested", () => {
    expect(mjsql('$and($gt($.age, 18), $eq($.status, "active"))')).toEqual({
      $and: [{ $gt: ["$age", 18] }, { $eq: ["$status", "active"] }],
    });
  });

  it("operator as argument", () => {
    expect(mjsql("$multiply($add($.a, $.b), 2)")).toEqual({
      $multiply: [{ $add: ["$a", "$b"] }, 2],
    });
  });
});

describe("object-style operators (object arg)", () => {
  it("$trim with named args", () => {
    expect(mjsql("$trim({ input: $.name, chars: ' ' })")).toEqual({
      $trim: { input: "$name", chars: " " },
    });
  });

  it("$replaceOne named", () => {
    expect(mjsql('$replaceOne({ input: $.text, find: "old", replacement: "new" })')).toEqual({
      $replaceOne: { input: "$text", find: "old", replacement: "new" },
    });
  });

  it("$dateAdd named", () => {
    expect(mjsql('$dateAdd({ startDate: $.date, unit: "day", amount: 7 })')).toEqual({
      $dateAdd: { startDate: "$date", unit: "day", amount: 7 },
    });
  });
});

describe("object-shape operators (positional → object mapping)", () => {
  it("$trim positional", () => {
    expect(mjsql("$trim($.name, ' ')")).toEqual({
      $trim: { input: "$name", chars: " " },
    });
  });

  it("$trim positional single arg", () => {
    expect(mjsql("$trim($.name)")).toEqual({
      $trim: { input: "$name" },
    });
  });

  it("$replaceOne positional", () => {
    expect(mjsql('$replaceOne($.text, "old", "new")')).toEqual({
      $replaceOne: { input: "$text", find: "old", replacement: "new" },
    });
  });

  it("$getField positional", () => {
    expect(mjsql('$getField("fieldName", $.doc)')).toEqual({
      $getField: { field: "fieldName", input: "$doc" },
    });
  });
});

describe("zero-arg operators", () => {
  it("$rand", () => {
    expect(mjsql("$rand()")).toEqual({ $rand: {} });
  });
});

describe("unknown operators (fallthrough)", () => {
  it("zero args → {}", () => {
    expect(mjsql("$someNewOp()")).toEqual({ $someNewOp: {} });
  });

  it("single non-object arg → bare value", () => {
    expect(mjsql("$someOp($.a)")).toEqual({ $someOp: "$a" });
  });

  it("single object arg → pass object", () => {
    expect(mjsql('$someOp({ key: "val" })')).toEqual({ $someOp: { key: "val" } });
  });

  it("multiple args → array", () => {
    expect(mjsql("$someNewOp($.a, $.b)")).toEqual({ $someNewOp: ["$a", "$b"] });
  });
});

describe("array literals", () => {
  it("simple array", () => {
    expect(mjsql("$in($.x, [1, 2, 3])")).toEqual({ $in: ["$x", [1, 2, 3]] });
  });

  it("nested array", () => {
    expect(mjsql("$abs([1, 2])")).toEqual({ $abs: [1, 2] });
  });
});

describe("object literals as args", () => {
  it("object as second positional arg for unknown op", () => {
    expect(mjsql("$foo({ a: 1 }, $.b)")).toEqual({ $foo: [{ a: 1 }, "$b"] });
  });
});

describe("$cond", () => {
  it("positional 3-arg cond (object-shape, maps to if/then/else)", () => {
    expect(mjsql('$cond($.age, "adult", "minor")')).toEqual({
      $cond: { if: "$age", then: "adult", else: "minor" },
    });
  });

  it("object-style cond", () => {
    expect(mjsql('$cond({ if: $.active, then: "yes", else: "no" })')).toEqual({
      $cond: { if: "$active", then: "yes", else: "no" },
    });
  });
});

describe("mql template tag", () => {
  it("interpolates number", () => {
    const age = 21;
    expect(mql`$gt($.age, ${age})`).toEqual({ $gt: ["$age", 21] });
  });

  it("interpolates array", () => {
    const statuses = ["active", "pending"];
    expect(mql`$in($.status, ${statuses})`).toEqual({
      $in: ["$status", ["active", "pending"]],
    });
  });

  it("interpolates string", () => {
    const prefix = "admin";
    expect(mql`$eq($.role, ${prefix})`).toEqual({ $eq: ["$role", "admin"] });
  });
});

describe("validate()", () => {
  it("returns valid for correct expression", () => {
    const result = validate("$eq($.age, 18)");
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("returns error for unknown identifier", () => {
    const result = validate("$eq(age, 18)");
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/Unexpected token/);
  });

  it("returns error for unclosed paren", () => {
    const result = validate("$eq($.age, 18");
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
  });

  it("returns error for trailing junk", () => {
    const result = validate("$eq($.age, 18) garbage");
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/Unexpected token/);
  });
});

describe("single-char negative numbers", () => {
  it("negative number literal", () => {
    expect(mjsql("$abs(-5)")).toEqual({ $abs: -5 });
  });
});

// ── v2: JS infix operators ────────────────────────────────────────────────────

describe("v2: arithmetic operators", () => {
  it("+ numeric", () => {
    expect(mjsql("$.a + $.b")).toEqual({ $add: ["$a", "$b"] });
  });
  it("- binary", () => {
    expect(mjsql("$.a - $.b")).toEqual({ $subtract: ["$a", "$b"] });
  });
  it("* multiply", () => {
    expect(mjsql("$.a * 1.1")).toEqual({ $multiply: ["$a", 1.1] });
  });
  it("/ divide", () => {
    expect(mjsql("$.a / $.b")).toEqual({ $divide: ["$a", "$b"] });
  });
  it("% modulo", () => {
    expect(mjsql("$.a % 2")).toEqual({ $mod: ["$a", 2] });
  });
  it("** power", () => {
    expect(mjsql("$.base ** 2")).toEqual({ $pow: ["$base", 2] });
  });
  it("** is right-associative", () => {
    expect(mjsql("2 ** 3 ** 2")).toEqual({ $pow: [2, { $pow: [3, 2] }] });
  });
});

describe("v2: comparison operators", () => {
  it("==", () => {
    expect(mjsql("$.status == 'active'")).toEqual({ $eq: ["$status", "active"] });
  });
  it("===", () => {
    expect(mjsql("$.status === 'active'")).toEqual({ $eq: ["$status", "active"] });
  });
  it("!=", () => {
    expect(mjsql("$.status != null")).toEqual({ $ne: ["$status", null] });
  });
  it("!==", () => {
    expect(mjsql("$.status !== null")).toEqual({ $ne: ["$status", null] });
  });
  it(">", () => {
    expect(mjsql("$.age > 18")).toEqual({ $gt: ["$age", 18] });
  });
  it(">=", () => {
    expect(mjsql("$.age >= 21")).toEqual({ $gte: ["$age", 21] });
  });
  it("<", () => {
    expect(mjsql("$.score < 50")).toEqual({ $lt: ["$score", 50] });
  });
  it("<=", () => {
    expect(mjsql("$.score <= 100")).toEqual({ $lte: ["$score", 100] });
  });
  it("in", () => {
    expect(mjsql('$.status in ["active", "pending"]')).toEqual({
      $in: ["$status", ["active", "pending"]],
    });
  });
});

describe("v2: logical operators", () => {
  it("&&", () => {
    expect(mjsql("$.a && $.b")).toEqual({ $and: ["$a", "$b"] });
  });
  it("||", () => {
    expect(mjsql("$.a || $.b")).toEqual({ $or: ["$a", "$b"] });
  });
  it("! unary", () => {
    expect(mjsql("!$.active")).toEqual({ $not: "$active" });
  });
  it("!! double negation", () => {
    expect(mjsql("!!$.active")).toEqual({ $not: { $not: "$active" } });
  });
});

describe("v2: ternary", () => {
  it("basic ternary", () => {
    expect(mjsql("$.age >= 18 ? 'adult' : 'minor'")).toEqual({
      $cond: [{ $gte: ["$age", 18] }, "adult", "minor"],
    });
  });
  it("nested ternary (right-associative)", () => {
    expect(mjsql("$.a ? 'x' : $.b ? 'y' : 'z'")).toEqual({
      $cond: ["$a", "x", { $cond: ["$b", "y", "z"] }],
    });
  });
});

describe("v2: nullish coalescing", () => {
  it("??", () => {
    expect(mjsql("$.nickname ?? $.name")).toEqual({ $ifNull: ["$nickname", "$name"] });
  });
  it("?? flattened chain", () => {
    expect(mjsql("$.a ?? $.b ?? 'unknown'")).toEqual({
      $ifNull: ["$a", "$b", "unknown"],
    });
  });
});

describe("v2: unary minus", () => {
  it("unary - on field", () => {
    expect(mjsql("-$.amount")).toEqual({ $multiply: ["$amount", -1] });
  });
  it("unary - on number literal optimised to negative number", () => {
    expect(mjsql("-5")).toEqual(-5);
  });
  it("unary - on number inside operator", () => {
    expect(mjsql("$abs(-5)")).toEqual({ $abs: -5 });
  });
  it("unary - on expression", () => {
    expect(mjsql("-($.a + $.b)")).toEqual({ $multiply: [{ $add: ["$a", "$b"] }, -1] });
  });
});

describe("v2: operator flattening", () => {
  it("+ flattened to $add", () => {
    expect(mjsql("$.a + $.b + $.c")).toEqual({ $add: ["$a", "$b", "$c"] });
  });
  it("* flattened to $multiply", () => {
    expect(mjsql("$.a * $.b * $.c")).toEqual({ $multiply: ["$a", "$b", "$c"] });
  });
  it("&& flattened to $and", () => {
    expect(mjsql("$.a && $.b && $.c")).toEqual({ $and: ["$a", "$b", "$c"] });
  });
  it("|| flattened to $or", () => {
    expect(mjsql("$.a || $.b || $.c")).toEqual({ $or: ["$a", "$b", "$c"] });
  });
  it("?? flattened to $ifNull (4 operands)", () => {
    expect(mjsql("$.a ?? $.b ?? $.c ?? 0")).toEqual({ $ifNull: ["$a", "$b", "$c", 0] });
  });
  it("- is NOT flattened (left-assoc, not same operator)", () => {
    expect(mjsql("$.a - $.b - $.c")).toEqual({
      $subtract: [{ $subtract: ["$a", "$b"] }, "$c"],
    });
  });
});

describe("v2: string-context +", () => {
  it("string literal in chain → $concat", () => {
    expect(mjsql('$.first + " " + $.last')).toEqual({
      $concat: ["$first", " ", "$last"],
    });
  });
  it("empty string → $concat", () => {
    expect(mjsql('$.a + ""')).toEqual({ $concat: ["$a", ""] });
  });
  it("no string literal → $add", () => {
    expect(mjsql("$.a + $.b")).toEqual({ $add: ["$a", "$b"] });
  });
  it("string-output operator → $concat", () => {
    expect(mjsql("$toString($.n) + $.s")).toEqual({
      $concat: [{ $toString: "$n" }, "$s"],
    });
  });
  it("$toLower result in chain → $concat", () => {
    expect(mjsql("$.prefix + $toLower($.name)")).toEqual({
      $concat: ["$prefix", { $toLower: "$name" }],
    });
  });
  it("mixed numeric + string-output op → $concat", () => {
    expect(mjsql('$.count + " items"')).toEqual({ $concat: ["$count", " items"] });
  });
});

describe("v2: bracket access", () => {
  it("constant index", () => {
    expect(mjsql("$.items[0]")).toEqual({ $arrayElemAt: ["$items", 0] });
  });
  it("field index", () => {
    expect(mjsql("$.items[$.idx]")).toEqual({ $arrayElemAt: ["$items", "$idx"] });
  });
  it("chained bracket access", () => {
    expect(mjsql("$.m[$.r][$.c]")).toEqual({
      $arrayElemAt: [{ $arrayElemAt: ["$m", "$r"] }, "$c"],
    });
  });
  it("bracket access on operator result", () => {
    expect(mjsql("$reverseArray($.items)[0]")).toEqual({
      $arrayElemAt: [{ $reverseArray: "$items" }, 0],
    });
  });
});

describe("v2: grouped expressions", () => {
  it("grouping changes precedence", () => {
    expect(mjsql("($.a + $.b) * 2")).toEqual({
      $multiply: [{ $add: ["$a", "$b"] }, 2],
    });
  });
  it("without grouping * binds tighter", () => {
    expect(mjsql("$.a + $.b * 2")).toEqual({
      $add: ["$a", { $multiply: ["$b", 2] }],
    });
  });
});

describe("v2: operator precedence", () => {
  it("* before +", () => {
    expect(mjsql("$.a + $.b * $.c")).toEqual({
      $add: ["$a", { $multiply: ["$b", "$c"] }],
    });
  });
  it("comparison before &&", () => {
    expect(mjsql("$.age > 18 && $.active")).toEqual({
      $and: [{ $gt: ["$age", 18] }, "$active"],
    });
  });
  it("&& before ||", () => {
    expect(mjsql("$.a || $.b && $.c")).toEqual({
      $or: ["$a", { $and: ["$b", "$c"] }],
    });
  });
  it("! before &&", () => {
    expect(mjsql("!$.a && $.b")).toEqual({
      $and: [{ $not: "$a" }, "$b"],
    });
  });
});

describe("v2: mixed v1 $operator() and v2 infix", () => {
  it("infix inside $operator args", () => {
    expect(mjsql("$and($.age > 18, $.status == 'active')")).toEqual({
      $and: [{ $gt: ["$age", 18] }, { $eq: ["$status", "active"] }],
    });
  });
  it("$operator wrapping infix", () => {
    expect(mjsql("$abs($.a - $.b)")).toEqual({
      $abs: { $subtract: ["$a", "$b"] },
    });
  });
  it("$round on arithmetic", () => {
    expect(mjsql("$round($.price * 1.1, 2)")).toEqual({
      $round: [{ $multiply: ["$price", 1.1] }, 2],
    });
  });
});

describe("v2: $.in field ref still works", () => {
  it("field named 'in'", () => {
    expect(mjsql("$.in == 'test'")).toEqual({ $eq: ["$in", "test"] });
  });
  it("nested field with 'in' segment", () => {
    expect(mjsql("$size($.in)")).toEqual({ $size: "$in" });
  });
});
