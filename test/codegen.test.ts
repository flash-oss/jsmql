import { describe, it, expect } from "vitest";
import { mjsql, validate, mql } from "../src/index.ts";

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
    expect(result.errors[0].message).toMatch(/Did you mean/);
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

describe("arithmetic operators", () => {
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

describe("comparison operators", () => {
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

describe("logical operators", () => {
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

describe("ternary", () => {
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

describe("nullish coalescing", () => {
  it("??", () => {
    expect(mjsql("$.nickname ?? $.name")).toEqual({ $ifNull: ["$nickname", "$name"] });
  });
  it("?? flattened chain", () => {
    expect(mjsql("$.a ?? $.b ?? 'unknown'")).toEqual({
      $ifNull: ["$a", "$b", "unknown"],
    });
  });
});

describe("unary minus", () => {
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

describe("operator flattening", () => {
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

describe("string-context +", () => {
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

describe("bracket access", () => {
  it("constant index on bare field → runtime $cond on $isArray", () => {
    // Bare $.items receiver — type unknown — dispatch at runtime to handle
    // either array (numeric index) or object (dynamic key) at query time.
    expect(mjsql("$.items[0]")).toEqual({
      $cond: [
        { $isArray: "$items" },
        { $arrayElemAt: ["$items", 0] },
        { $getField: { field: 0, input: "$items" } },
      ],
    });
  });
  it("field index on bare field → runtime $cond", () => {
    expect(mjsql("$.items[$.idx]")).toEqual({
      $cond: [
        { $isArray: "$items" },
        { $arrayElemAt: ["$items", "$idx"] },
        { $getField: { field: "$idx", input: "$items" } },
      ],
    });
  });
  it("string-literal key on bare field → runtime $cond (the $getField branch is the right one for objects)", () => {
    expect(mjsql('$.config["host"]')).toEqual({
      $cond: [
        { $isArray: "$config" },
        { $arrayElemAt: ["$config", "host"] },
        { $getField: { field: "host", input: "$config" } },
      ],
    });
  });
  it("chained bracket access on bare field → nested $cond", () => {
    expect(mjsql("$.m[$.r][$.c]")).toEqual({
      $cond: [
        {
          $isArray: {
            $cond: [
              { $isArray: "$m" },
              { $arrayElemAt: ["$m", "$r"] },
              { $getField: { field: "$r", input: "$m" } },
            ],
          },
        },
        {
          $arrayElemAt: [
            {
              $cond: [
                { $isArray: "$m" },
                { $arrayElemAt: ["$m", "$r"] },
                { $getField: { field: "$r", input: "$m" } },
              ],
            },
            "$c",
          ],
        },
        {
          $getField: {
            field: "$c",
            input: {
              $cond: [
                { $isArray: "$m" },
                { $arrayElemAt: ["$m", "$r"] },
                { $getField: { field: "$r", input: "$m" } },
              ],
            },
          },
        },
      ],
    });
  });
  it("bracket access on known-array operator result stays compact", () => {
    expect(mjsql("$reverseArray($.items)[0]")).toEqual({
      $arrayElemAt: [{ $reverseArray: "$items" }, 0],
    });
  });
  it("bracket access on .map() result stays compact", () => {
    expect(mjsql("$.items.map(x => x.id)[0]")).toEqual({
      $arrayElemAt: [{ $map: { input: "$items", as: "x", in: "$$x.id" } }, 0],
    });
  });
});

describe("grouped expressions", () => {
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

describe("operator precedence", () => {
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

describe("mixed $operator() and infix", () => {
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

describe("$.in field ref still works", () => {
  it("field named 'in'", () => {
    expect(mjsql("$.in == 'test'")).toEqual({ $eq: ["$in", "test"] });
  });
  it("nested field with 'in' segment", () => {
    expect(mjsql("$size($.in)")).toEqual({ $size: "$in" });
  });
});

describe("field path regression (FieldRef stops at first segment)", () => {
  it("$.a.b.c produces $a.b.c", () => {
    expect(mjsql("$.a.b.c")).toEqual("$a.b.c");
  });
  it("$.items[0] (unknown receiver) produces $cond bracket-access shape", () => {
    expect(mjsql("$.items[0]")).toEqual({
      $cond: [
        { $isArray: "$items" },
        { $arrayElemAt: ["$items", 0] },
        { $getField: { field: 0, input: "$items" } },
      ],
    });
  });
  it("$.items[0].name produces $getField on bracket-access result", () => {
    expect(mjsql("$.items[0].name")).toEqual({
      $getField: {
        field: "name",
        input: {
          $cond: [
            { $isArray: "$items" },
            { $arrayElemAt: ["$items", 0] },
            { $getField: { field: 0, input: "$items" } },
          ],
        },
      },
    });
  });
  it("rejects numeric field segments — $.items.0 is not valid JS syntax", () => {
    expect(() => mjsql("$.items.0")).toThrow(/Expected property name after '\.'/);
  });
  it("deep path inside $abs", () => {
    expect(mjsql("$abs($.a.b.c)")).toEqual({ $abs: "$a.b.c" });
  });
  it("dotted path in comparison", () => {
    expect(mjsql("$.loyalty.years >= 2")).toEqual({ $gte: ["$loyalty.years", 2] });
  });
});

describe("string methods", () => {
  it("trim", () => {
    expect(mjsql("$.name.trim()")).toEqual({ $trim: { input: "$name" } });
  });
  it("trimStart", () => {
    expect(mjsql("$.name.trimStart()")).toEqual({ $ltrim: { input: "$name" } });
  });
  it("trimLeft alias", () => {
    expect(mjsql("$.name.trimLeft()")).toEqual({ $ltrim: { input: "$name" } });
  });
  it("trimEnd", () => {
    expect(mjsql("$.name.trimEnd()")).toEqual({ $rtrim: { input: "$name" } });
  });
  it("trimRight alias", () => {
    expect(mjsql("$.name.trimRight()")).toEqual({ $rtrim: { input: "$name" } });
  });
  it("toLowerCase", () => {
    expect(mjsql("$.name.toLowerCase()")).toEqual({ $toLower: "$name" });
  });
  it("toUpperCase", () => {
    expect(mjsql("$.name.toUpperCase()")).toEqual({ $toUpper: "$name" });
  });
  it("substr", () => {
    expect(mjsql("$.name.substr(0, 5)")).toEqual({ $substrCP: ["$name", 0, 5] });
  });
  it("split", () => {
    expect(mjsql('$.csv.split(",")')).toEqual({ $split: ["$csv", ","] });
  });
  it("indexOf on bare field → runtime $cond on $isArray", () => {
    expect(mjsql('$.name.indexOf("@")')).toEqual({
      $cond: [
        { $isArray: "$name" },
        { $indexOfArray: ["$name", "@"] },
        { $indexOfCP: ["$name", "@"] },
      ],
    });
  });
  it("indexOf on known string → $indexOfCP", () => {
    expect(mjsql('$.name.toLowerCase().indexOf("@")')).toEqual({
      $indexOfCP: [{ $toLower: "$name" }, "@"],
    });
  });
  it("replace", () => {
    expect(mjsql('$.name.replace("a", "b")')).toEqual({
      $replaceOne: { input: "$name", find: "a", replacement: "b" },
    });
  });
  it("replaceAll", () => {
    expect(mjsql('$.slug.replaceAll(" ", "-")')).toEqual({
      $replaceAll: { input: "$slug", find: " ", replacement: "-" },
    });
  });
  it("includes on bare field → runtime $cond on $isArray", () => {
    expect(mjsql('$.email.includes("@")')).toEqual({
      $cond: [
        { $isArray: "$email" },
        { $in: ["@", "$email"] },
        { $gte: [{ $indexOfCP: ["$email", "@"] }, 0] },
      ],
    });
  });
  it("includes on known string → string form", () => {
    expect(mjsql('$.email.toLowerCase().includes("@")')).toEqual({
      $gte: [{ $indexOfCP: [{ $toLower: "$email" }, "@"] }, 0],
    });
  });
  it("match with regex literal", () => {
    expect(mjsql("$.str.match(/^[A-Z]/)")).toEqual({
      $regexMatch: { input: "$str", regex: "^[A-Z]" },
    });
  });
  it("match with regex literal and flags", () => {
    expect(mjsql("$.str.match(/^[a-z]/i)")).toEqual({
      $regexMatch: { input: "$str", regex: "^[a-z]", options: "i" },
    });
  });
  it("match with string pattern", () => {
    expect(mjsql('$.str.match("^[a-z]")')).toEqual({
      $regexMatch: { input: "$str", regex: "^[a-z]" },
    });
  });
  it("length on string-producing expression → $strLenCP", () => {
    expect(mjsql("$.name.trim().length")).toEqual({ $strLenCP: { $trim: { input: "$name" } } });
  });
  it("length on array-producing expression → $size", () => {
    expect(mjsql('$.csv.split(",").length')).toEqual({ $size: { $split: ["$csv", ","] } });
  });
  it("length on map result → $size", () => {
    expect(mjsql("$.items.map(x => x).length")).toEqual({
      $size: { $map: { input: "$items", as: "x", in: "$$x" } },
    });
  });
  it("length on unknown field → runtime dispatch", () => {
    expect(mjsql("$.items.length")).toEqual({
      $cond: [{ $isArray: "$items" }, { $size: "$items" }, { $strLenCP: "$items" }],
    });
  });
  it("chained trim then toLowerCase", () => {
    expect(mjsql("$.name.trim().toLowerCase()")).toEqual({
      $toLower: { $trim: { input: "$name" } },
    });
  });
  it("chained toLowerCase then trim", () => {
    expect(mjsql("$.name.toLowerCase().trim()")).toEqual({
      $trim: { input: { $toLower: "$name" } },
    });
  });
});

describe("array methods (no lambda)", () => {
  it("at(n)", () => {
    expect(mjsql("$.items.at(0)")).toEqual({ $arrayElemAt: ["$items", 0] });
  });
  it("at(-1)", () => {
    expect(mjsql("$.items.at(-1)")).toEqual({ $arrayElemAt: ["$items", -1] });
  });
  it("slice(start)", () => {
    expect(mjsql("$.items.slice(2)")).toEqual({ $slice: ["$items", 2] });
  });
  it("slice(start, count)", () => {
    expect(mjsql("$.items.slice(0, 3)")).toEqual({ $slice: ["$items", 0, 3] });
  });
  it("reverse()", () => {
    expect(mjsql("$.items.reverse()")).toEqual({ $reverseArray: "$items" });
  });
});

describe("array methods (with lambda)", () => {
  it("map with single param", () => {
    expect(mjsql("$.prices.map(p => p * 1.1)")).toEqual({
      $map: { input: "$prices", as: "p", in: { $multiply: ["$$p", 1.1] } },
    });
  });
  it("map with parenthesized param", () => {
    expect(mjsql("$.prices.map((p) => p * 1.1)")).toEqual({
      $map: { input: "$prices", as: "p", in: { $multiply: ["$$p", 1.1] } },
    });
  });
  it("filter", () => {
    expect(mjsql("$.items.filter(x => x > 0)")).toEqual({
      $filter: { input: "$items", as: "x", cond: { $gt: ["$$x", 0] } },
    });
  });
  it("find", () => {
    expect(mjsql("$.items.find(x => x > 0)")).toEqual({
      $arrayElemAt: [{ $filter: { input: "$items", as: "x", cond: { $gt: ["$$x", 0] } } }, 0],
    });
  });
  it("some", () => {
    expect(mjsql("$.items.some(x => x > 0)")).toEqual({
      $anyElementTrue: { $map: { input: "$items", as: "x", in: { $gt: ["$$x", 0] } } },
    });
  });
  it("every", () => {
    expect(mjsql("$.items.every(x => x > 0)")).toEqual({
      $allElementsTrue: { $map: { input: "$items", as: "x", in: { $gt: ["$$x", 0] } } },
    });
  });
  it("reduce", () => {
    expect(mjsql("$.ns.reduce((acc, x) => acc + x, 0)")).toEqual({
      $reduce: { input: "$ns", initialValue: 0, in: { $add: ["$$value", "$$this"] } },
    });
  });
  it("lambda accessing doc field via $.", () => {
    expect(mjsql("$.items.map(x => x * $.taxRate)")).toEqual({
      $map: { input: "$items", as: "x", in: { $multiply: ["$$x", "$taxRate"] } },
    });
  });
  it("lambda accessing nested field on element (x.status → $$x.status)", () => {
    expect(mjsql('$.orders.filter(o => o.status == "active")')).toEqual({
      $filter: { input: "$orders", as: "o", cond: { $eq: ["$$o.status", "active"] } },
    });
  });
  it("reduce accessing element field ($$this.price)", () => {
    expect(mjsql("$.orders.reduce((sum, o) => sum + o.price, 0)")).toEqual({
      $reduce: {
        input: "$orders",
        initialValue: 0,
        in: { $add: ["$$value", "$$this.price"] },
      },
    });
  });
});

describe("date methods", () => {
  it("getFullYear", () => {
    expect(mjsql("$.ts.getFullYear()")).toEqual({ $year: "$ts" });
  });
  it("getMonth (0-based)", () => {
    expect(mjsql("$.ts.getMonth()")).toEqual({ $subtract: [{ $month: "$ts" }, 1] });
  });
  it("getDate", () => {
    expect(mjsql("$.ts.getDate()")).toEqual({ $dayOfMonth: "$ts" });
  });
  it("getDay (0-based)", () => {
    expect(mjsql("$.ts.getDay()")).toEqual({ $subtract: [{ $dayOfWeek: "$ts" }, 1] });
  });
  it("getHours", () => {
    expect(mjsql("$.ts.getHours()")).toEqual({ $hour: "$ts" });
  });
  it("getMinutes", () => {
    expect(mjsql("$.ts.getMinutes()")).toEqual({ $minute: "$ts" });
  });
  it("getSeconds", () => {
    expect(mjsql("$.ts.getSeconds()")).toEqual({ $second: "$ts" });
  });
  it("getMilliseconds", () => {
    expect(mjsql("$.ts.getMilliseconds()")).toEqual({ $millisecond: "$ts" });
  });
});

describe("typeof", () => {
  it("typeof fieldref", () => {
    expect(mjsql("typeof $.x")).toEqual({ $type: "$x" });
  });
  it("typeof in comparison", () => {
    expect(mjsql('typeof $.x == "string"')).toEqual({ $eq: [{ $type: "$x" }, "string"] });
  });
});

describe("new Date()", () => {
  it("no-arg maps to $$NOW", () => {
    expect(mjsql("new Date()")).toEqual({ $toDate: "$$NOW" });
  });
  it("with field arg", () => {
    expect(mjsql("new Date($.ts)")).toEqual({ $toDate: "$ts" });
  });
  it("with string literal", () => {
    expect(mjsql('new Date("2024-01-01")')).toEqual({ $toDate: "2024-01-01" });
  });
});

describe("type casts", () => {
  it("Number()", () => {
    expect(mjsql("Number($.str)")).toEqual({ $toDouble: "$str" });
  });
  it("String()", () => {
    expect(mjsql("String($.n)")).toEqual({ $toString: "$n" });
  });
  it("Boolean()", () => {
    expect(mjsql("Boolean($.x)")).toEqual({ $toBool: "$x" });
  });
  it("parseInt()", () => {
    expect(mjsql("parseInt($.s)")).toEqual({ $toInt: "$s" });
  });
  it("parseFloat()", () => {
    expect(mjsql("parseFloat($.s)")).toEqual({ $toDouble: "$s" });
  });
});

describe("Math.*", () => {
  it("Math.abs", () => {
    expect(mjsql("Math.abs($.x)")).toEqual({ $abs: "$x" });
  });
  it("Math.ceil", () => {
    expect(mjsql("Math.ceil($.x)")).toEqual({ $ceil: "$x" });
  });
  it("Math.floor", () => {
    expect(mjsql("Math.floor($.x)")).toEqual({ $floor: "$x" });
  });
  it("Math.round adds 0 precision", () => {
    expect(mjsql("Math.round($.x)")).toEqual({ $round: ["$x", 0] });
  });
  it("Math.pow", () => {
    expect(mjsql("Math.pow(2, $.n)")).toEqual({ $pow: [2, "$n"] });
  });
  it("Math.sqrt", () => {
    expect(mjsql("Math.sqrt($.x)")).toEqual({ $sqrt: "$x" });
  });
  it("Math.exp", () => {
    expect(mjsql("Math.exp($.x)")).toEqual({ $exp: "$x" });
  });
  it("Math.log (natural log → $ln)", () => {
    expect(mjsql("Math.log($.x)")).toEqual({ $ln: "$x" });
  });
  it("Math.trunc", () => {
    expect(mjsql("Math.trunc($.x)")).toEqual({ $trunc: "$x" });
  });
});

describe("Math trigonometry", () => {
  it("Math.sin", () => {
    expect(mjsql("Math.sin($.angle)")).toEqual({ $sin: "$angle" });
  });
  it("Math.cos", () => {
    expect(mjsql("Math.cos($.angle)")).toEqual({ $cos: "$angle" });
  });
  it("Math.tan", () => {
    expect(mjsql("Math.tan($.angle)")).toEqual({ $tan: "$angle" });
  });
  it("Math.asin", () => {
    expect(mjsql("Math.asin($.x)")).toEqual({ $asin: "$x" });
  });
  it("Math.acos", () => {
    expect(mjsql("Math.acos($.x)")).toEqual({ $acos: "$x" });
  });
  it("Math.atan", () => {
    expect(mjsql("Math.atan($.x)")).toEqual({ $atan: "$x" });
  });
  it("Math.atan2", () => {
    expect(mjsql("Math.atan2($.y, $.x)")).toEqual({ $atan2: ["$y", "$x"] });
  });
  it("Math.atan2 wrong arity", () => {
    expect(() => mjsql("Math.atan2($.x)")).toThrow(/exactly 2 arguments/);
  });
  it("Math.sinh", () => {
    expect(mjsql("Math.sinh($.x)")).toEqual({ $sinh: "$x" });
  });
  it("Math.cosh", () => {
    expect(mjsql("Math.cosh($.x)")).toEqual({ $cosh: "$x" });
  });
  it("Math.tanh", () => {
    expect(mjsql("Math.tanh($.x)")).toEqual({ $tanh: "$x" });
  });
  it("Math.asinh", () => {
    expect(mjsql("Math.asinh($.x)")).toEqual({ $asinh: "$x" });
  });
  it("Math.acosh", () => {
    expect(mjsql("Math.acosh($.x)")).toEqual({ $acosh: "$x" });
  });
  it("Math.atanh", () => {
    expect(mjsql("Math.atanh($.x)")).toEqual({ $atanh: "$x" });
  });
});

describe("bitwise infix operators", () => {
  it("a & b", () => {
    expect(mjsql("$.a & $.b")).toEqual({ $bitAnd: ["$a", "$b"] });
  });
  it("a | b", () => {
    expect(mjsql("$.a | $.b")).toEqual({ $bitOr: ["$a", "$b"] });
  });
  it("a ^ b", () => {
    expect(mjsql("$.a ^ $.b")).toEqual({ $bitXor: ["$a", "$b"] });
  });
  it("~a", () => {
    expect(mjsql("~$.a")).toEqual({ $bitNot: "$a" });
  });
  it("a & b & c flattens", () => {
    expect(mjsql("$.a & $.b & $.c")).toEqual({ $bitAnd: ["$a", "$b", "$c"] });
  });
  it("a | b | c flattens", () => {
    expect(mjsql("$.a | $.b | $.c")).toEqual({ $bitOr: ["$a", "$b", "$c"] });
  });
  it("a ^ b ^ c flattens", () => {
    expect(mjsql("$.a ^ $.b ^ $.c")).toEqual({ $bitXor: ["$a", "$b", "$c"] });
  });
  it("(a & b) | c precedence: & binds tighter than |", () => {
    expect(mjsql("$.a & $.b | $.c")).toEqual({
      $bitOr: [{ $bitAnd: ["$a", "$b"] }, "$c"],
    });
  });
  it("(a ^ b) | c precedence: ^ binds tighter than |", () => {
    expect(mjsql("$.a ^ $.b | $.c")).toEqual({
      $bitOr: [{ $bitXor: ["$a", "$b"] }, "$c"],
    });
  });
  it("(a & b) ^ c precedence: & binds tighter than ^", () => {
    expect(mjsql("$.a & $.b ^ $.c")).toEqual({
      $bitXor: [{ $bitAnd: ["$a", "$b"] }, "$c"],
    });
  });
  it("&& binds looser than | (so a | b && c → (a | b) && c)", () => {
    expect(mjsql("$.a | $.b && $.c")).toEqual({
      $and: [{ $bitOr: ["$a", "$b"] }, "$c"],
    });
  });
  it("== binds tighter than & (so a == b & c → (a == b) & c)", () => {
    expect(mjsql("$.a == $.b & $.c")).toEqual({
      $bitAnd: [{ $eq: ["$a", "$b"] }, "$c"],
    });
  });
  it("unary ~ has higher precedence than &", () => {
    expect(mjsql("~$.flags & 255")).toEqual({
      $bitAnd: [{ $bitNot: "$flags" }, 255],
    });
  });
});

describe("Object.*", () => {
  it("Object.keys", () => {
    expect(mjsql("Object.keys($.doc)")).toEqual({
      $map: { input: { $objectToArray: "$doc" }, as: "kv", in: "$$kv.k" },
    });
  });
  it("Object.values", () => {
    expect(mjsql("Object.values($.doc)")).toEqual({
      $map: { input: { $objectToArray: "$doc" }, as: "kv", in: "$$kv.v" },
    });
  });
  it("Object.entries", () => {
    expect(mjsql("Object.entries($.doc)")).toEqual({ $objectToArray: "$doc" });
  });
  it("Object.assign (2 args)", () => {
    expect(mjsql("Object.assign($.a, $.b)")).toEqual({ $mergeObjects: ["$a", "$b"] });
  });
  it("Object.assign (3 args)", () => {
    expect(mjsql("Object.assign($.a, $.b, $.c)")).toEqual({ $mergeObjects: ["$a", "$b", "$c"] });
  });
});

describe("$let with lambda", () => {
  it("single var lambda", () => {
    expect(mjsql("$let({ d: $.price * 0.1 }, (d) => $.price - d)")).toEqual({
      $let: {
        vars: { d: { $multiply: ["$price", 0.1] } },
        in: { $subtract: ["$price", "$$d"] },
      },
    });
  });
});

describe("string-context + with method calls", () => {
  it("trim() in + chain is string-producing", () => {
    expect(mjsql('$.first.trim() + " " + $.last')).toEqual({
      $concat: [{ $trim: { input: "$first" } }, " ", "$last"],
    });
  });
  it("String() cast in + chain is string-producing", () => {
    expect(mjsql('String($.n) + " items"')).toEqual({
      $concat: [{ $toString: "$n" }, " items"],
    });
  });
  it("typeof in + chain is string-producing", () => {
    expect(mjsql('typeof $.x + " type"')).toEqual({
      $concat: [{ $type: "$x" }, " type"],
    });
  });
});

describe("regex literals (context-sensitive /)", () => {
  it("regex after operator is a literal, not divide", () => {
    expect(mjsql("$.str.match(/[a-z]+/)")).toEqual({
      $regexMatch: { input: "$str", regex: "[a-z]+" },
    });
  });
  it("/ after number is divide", () => {
    expect(mjsql("$.x / 2")).toEqual({ $divide: ["$x", 2] });
  });
  it("regex with multiple flags", () => {
    expect(mjsql("$.str.match(/pattern/gi)")).toEqual({
      $regexMatch: { input: "$str", regex: "pattern", options: "gi" },
    });
  });
});

describe("error cases", () => {
  it("bare identifier outside lambda throws Did you mean", () => {
    expect(() => mjsql("x > 0")).toThrow(/Did you mean/);
  });
  it("unknown method throws with helpful message", () => {
    expect(() => mjsql("$.name.frobulate()")).toThrow(/Unknown method/);
  });
  it("lambda in non-method context throws", () => {
    expect(() => mjsql("$abs(x => x)")).toThrow(/Lambda expression/);
  });
});

describe("1-arg substr", () => {
  it("substr(start) slices to end of string", () => {
    expect(mjsql("$.email.substr(1)")).toEqual({
      $substrCP: ["$email", 1, { $strLenCP: "$email" }],
    });
  });
  it("substr(start, count) keeps 2-arg form", () => {
    expect(mjsql("$.name.substr(0, 3)")).toEqual({ $substrCP: ["$name", 0, 3] });
  });
  it("substr with expression start", () => {
    expect(mjsql("$.email.substr($.headerLength + 1)")).toEqual({
      $substrCP: ["$email", { $add: ["$headerLength", 1] }, { $strLenCP: "$email" }],
    });
  });
});

describe("comparison precedence: relational higher than equality", () => {
  it("a < b == true parses as (a < b) == true", () => {
    expect(mjsql("$.a < $.b == true")).toEqual({
      $eq: [{ $lt: ["$a", "$b"] }, true],
    });
  });
  it("a > 0 == b > 0 parses as (a > 0) == (b > 0)", () => {
    expect(mjsql("$.a > 0 == $.b > 0")).toEqual({
      $eq: [{ $gt: ["$a", 0] }, { $gt: ["$b", 0] }],
    });
  });
  it("simple relational still works", () => {
    expect(mjsql("$.x < 5")).toEqual({ $lt: ["$x", 5] });
  });
  it("simple equality still works", () => {
    expect(mjsql("$.x == 5")).toEqual({ $eq: ["$x", 5] });
  });
});

describe("in operator RHS validation", () => {
  it("throws on string RHS", () => {
    expect(() => mjsql('$.x in "abc"')).toThrow(/Right-hand side of 'in'/);
  });
  it("throws on number RHS", () => {
    expect(() => mjsql("$.x in 42")).toThrow(/Right-hand side of 'in'/);
  });
  it("throws on boolean RHS", () => {
    expect(() => mjsql("$.x in true")).toThrow(/Right-hand side of 'in'/);
  });
  it("throws on null RHS", () => {
    expect(() => mjsql("$.x in null")).toThrow(/Right-hand side of 'in'/);
  });
  it("accepts array literal RHS", () => {
    expect(mjsql('$.x in ["a", "b"]')).toEqual({ $in: ["$x", ["a", "b"]] });
  });
  it("accepts field ref RHS", () => {
    expect(mjsql("$.x in $.list")).toEqual({ $in: ["$x", "$list"] });
  });
});

describe("EOF error message", () => {
  it("empty string gives Unexpected end of expression", () => {
    expect(() => mjsql("")).toThrow(/Unexpected end of expression/);
  });
  it("trailing operator gives Unexpected end of expression", () => {
    expect(() => mjsql("$.a &&")).toThrow(/Unexpected end of expression/);
  });
  it("incomplete ternary gives Unexpected end of expression", () => {
    expect(() => mjsql("$.a ? $.b")).toThrow(/Expected ':'/);
  });
});

describe("template literals", () => {
  it("plain string template (no expressions)", () => {
    expect(mjsql("`hello`")).toEqual("hello");
  });
  it("single interpolation", () => {
    // FieldRef has unknown runtime type → wrapped in $toString to match JS coercion semantics.
    expect(mjsql("`hello, ${$.name}!`")).toEqual({
      $concat: ["hello, ", { $toString: "$name" }, "!"],
    });
  });
  it("multiple interpolations", () => {
    expect(mjsql("`${$.first} ${$.last}`")).toEqual({
      $concat: [{ $toString: "$first" }, " ", { $toString: "$last" }],
    });
  });
  it("interpolation at the start", () => {
    expect(mjsql("`${$.x} px`")).toEqual({ $concat: [{ $toString: "$x" }, " px"] });
  });
  it("interpolation at the end", () => {
    expect(mjsql("`prefix-${$.id}`")).toEqual({ $concat: ["prefix-", { $toString: "$id" }] });
  });
  it("expression inside interpolation", () => {
    expect(mjsql("`total: ${$.a + $.b}`")).toEqual({
      $concat: ["total: ", { $toString: { $add: ["$a", "$b"] } }],
    });
  });
  it("interpolation containing object literal (brace tracking)", () => {
    expect(mjsql("`v=${$let({ x: 1 }, x => x)}`")).toEqual({
      $concat: ["v=", { $toString: { $let: { vars: { x: 1 }, in: "$$x" } } }],
    });
  });
  it("nested template literal", () => {
    // Inner template literal is statically string-producing → no $toString wrap.
    expect(mjsql("`outer ${`inner ${$.x}`}`")).toEqual({
      $concat: ["outer ", { $concat: ["inner ", { $toString: "$x" }] }],
    });
  });
  it("escape sequences", () => {
    expect(mjsql("`a\\nb`")).toEqual("a\nb");
  });
  it("escaped backtick and dollar", () => {
    expect(mjsql("`a\\`b\\${c}`")).toEqual("a`b${c}");
  });
  it("template literal participates in string-context +", () => {
    expect(mjsql("`x=${$.x}` + ' done'")).toEqual({
      $concat: [{ $concat: ["x=", { $toString: "$x" }] }, " done"],
    });
  });
  it("string-producing interpolations skip the $toString wrap", () => {
    // .toLowerCase() is statically string-producing — the wrap would be redundant.
    expect(mjsql("`name=${$.name.toLowerCase()}`")).toEqual({
      $concat: ["name=", { $toLower: "$name" }],
    });
  });
  it("number literal interpolation gets $toString wrap", () => {
    expect(mjsql("`n=${42}`")).toEqual({
      $concat: ["n=", { $toString: 42 }],
    });
  });
});

describe("array .includes()", () => {
  it("array literal → $in", () => {
    expect(mjsql('["a", "b"].includes($.x)')).toEqual({ $in: ["$x", ["a", "b"]] });
  });
  it("known array (split result) → $in", () => {
    expect(mjsql('$.csv.split(",").includes("active")')).toEqual({
      $in: ["active", { $split: ["$csv", ","] }],
    });
  });
  it("known string (toLowerCase result) → string form", () => {
    expect(mjsql('$.email.toLowerCase().includes("@")')).toEqual({
      $gte: [{ $indexOfCP: [{ $toLower: "$email" }, "@"] }, 0],
    });
  });
  it("bare $.field → runtime $cond on $isArray (works for either type)", () => {
    expect(mjsql("$.field.includes($.x)")).toEqual({
      $cond: [
        { $isArray: "$field" },
        { $in: ["$x", "$field"] },
        { $gte: [{ $indexOfCP: ["$field", "$x"] }, 0] },
      ],
    });
  });
});

describe("Math.min / Math.max", () => {
  it("Math.min variadic", () => {
    expect(mjsql("Math.min($.a, $.b, $.c)")).toEqual({ $min: ["$a", "$b", "$c"] });
  });
  it("Math.max variadic", () => {
    expect(mjsql("Math.max($.a, $.b)")).toEqual({ $max: ["$a", "$b"] });
  });
  it("Math.max with single array arg", () => {
    expect(mjsql("Math.max($.scores)")).toEqual({ $max: "$scores" });
  });
  it("Math.max with spread arg", () => {
    expect(mjsql("Math.max(...$.scores)")).toEqual({ $max: "$scores" });
  });
  it("Math.min mixed spread + scalar", () => {
    expect(mjsql("Math.min($.a, ...$.others)")).toEqual({
      $min: { $concatArrays: [["$a"], "$others"] },
    });
  });
});

describe("Date.now()", () => {
  it("returns ms since epoch", () => {
    expect(mjsql("Date.now()")).toEqual({ $toLong: "$$NOW" });
  });
});

describe("Object.fromEntries", () => {
  it("from $objectToArray result", () => {
    expect(mjsql("Object.fromEntries(Object.entries($.doc))")).toEqual({
      $arrayToObject: { $objectToArray: "$doc" },
    });
  });
  it("from array literal of pairs", () => {
    expect(mjsql('Object.fromEntries([["a", 1], ["b", 2]])')).toEqual({
      $arrayToObject: [
        ["a", 1],
        ["b", 2],
      ],
    });
  });
});

describe("Array.isArray", () => {
  it("on a field", () => {
    expect(mjsql("Array.isArray($.items)")).toEqual({ $isArray: "$items" });
  });
});

describe("optional chaining (?.)", () => {
  it("simple optional member access", () => {
    expect(mjsql("$.a?.b")).toEqual("$a.b");
  });
  it("chained optional access", () => {
    expect(mjsql("$.a?.b?.c")).toEqual("$a.b.c");
  });
  it("optional method call", () => {
    expect(mjsql("$.name?.trim()")).toEqual({ $trim: { input: "$name" } });
  });
  it("optional bracket access on bare field → runtime $cond", () => {
    // ?.[ ] desugars to the same node as [ ]; receiver type unknown → dispatch at runtime.
    expect(mjsql("$.scoresByLevel?.[$.level]")).toEqual({
      $cond: [
        { $isArray: "$scoresByLevel" },
        { $arrayElemAt: ["$scoresByLevel", "$level"] },
        { $getField: { field: "$level", input: "$scoresByLevel" } },
      ],
    });
  });
  it("optional bracket access on known array stays compact", () => {
    expect(mjsql("$.items.reverse()?.[0]")).toEqual({
      $arrayElemAt: [{ $reverseArray: "$items" }, 0],
    });
  });
});

describe(".startsWith / .endsWith", () => {
  it("startsWith maps to indexOf == 0", () => {
    expect(mjsql('$.email.startsWith("admin")')).toEqual({
      $eq: [{ $indexOfCP: ["$email", "admin"] }, 0],
    });
  });
  it("endsWith maps to substring equality at the tail", () => {
    expect(mjsql('$.file.endsWith(".pdf")')).toEqual({
      $eq: [
        {
          $substrCP: [
            "$file",
            { $subtract: [{ $strLenCP: "$file" }, { $strLenCP: ".pdf" }] },
            { $strLenCP: ".pdf" },
          ],
        },
        ".pdf",
      ],
    });
  });
});

describe(".charAt", () => {
  it("charAt(i)", () => {
    expect(mjsql("$.name.charAt(2)")).toEqual({ $substrCP: ["$name", 2, 1] });
  });
});

describe("array .indexOf", () => {
  it("on array literal → $indexOfArray", () => {
    expect(mjsql('["a", "b", "c"].indexOf($.x)')).toEqual({
      $indexOfArray: [["a", "b", "c"], "$x"],
    });
  });
  it("on known string → $indexOfCP", () => {
    expect(mjsql('$.email.toLowerCase().indexOf("@")')).toEqual({
      $indexOfCP: [{ $toLower: "$email" }, "@"],
    });
  });
  it("on bare field → runtime $cond on $isArray", () => {
    expect(mjsql('$.email.indexOf("@")')).toEqual({
      $cond: [
        { $isArray: "$email" },
        { $indexOfArray: ["$email", "@"] },
        { $indexOfCP: ["$email", "@"] },
      ],
    });
  });
});

describe("array .concat", () => {
  it("on array literal → $concatArrays", () => {
    expect(mjsql("[1, 2].concat([3, 4])")).toEqual({
      $concatArrays: [
        [1, 2],
        [3, 4],
      ],
    });
  });
  it("on known string → $concat", () => {
    expect(mjsql("$.first.trim().concat($.last)")).toEqual({
      $concat: [{ $trim: { input: "$first" } }, "$last"],
    });
  });
  it("on bare field → runtime $cond on $isArray", () => {
    expect(mjsql("$.parts.concat($.tail)")).toEqual({
      $cond: [
        { $isArray: "$parts" },
        { $concatArrays: ["$parts", "$tail"] },
        { $concat: ["$parts", "$tail"] },
      ],
    });
  });
});

describe(".join", () => {
  it("default separator (,)", () => {
    expect(mjsql("$.tags.join()")).toEqual({
      $reduce: {
        input: "$tags",
        initialValue: "",
        in: {
          $cond: [
            { $eq: ["$$value", ""] },
            { $toString: "$$this" },
            { $concat: ["$$value", ",", { $toString: "$$this" }] },
          ],
        },
      },
    });
  });
  it("custom separator", () => {
    expect(mjsql('$.tags.join(" | ")')).toEqual({
      $reduce: {
        input: "$tags",
        initialValue: "",
        in: {
          $cond: [
            { $eq: ["$$value", ""] },
            { $toString: "$$this" },
            { $concat: ["$$value", " | ", { $toString: "$$this" }] },
          ],
        },
      },
    });
  });
});

describe(".flat / .flatMap", () => {
  it("flat() one level", () => {
    expect(mjsql("$.nested.flat()")).toEqual({
      $reduce: {
        input: "$nested",
        initialValue: [],
        in: { $concatArrays: ["$$value", "$$this"] },
      },
    });
  });
  it("flat(1) explicit depth", () => {
    expect(mjsql("$.nested.flat(1)")).toEqual({
      $reduce: {
        input: "$nested",
        initialValue: [],
        in: { $concatArrays: ["$$value", "$$this"] },
      },
    });
  });
  it("flat(2) is rejected", () => {
    expect(() => mjsql("$.nested.flat(2)")).toThrow(/depth=1/);
  });
  it("flatMap with lambda", () => {
    expect(mjsql("$.docs.flatMap(d => d.tags)")).toEqual({
      $reduce: {
        input: { $map: { input: "$docs", as: "d", in: "$$d.tags" } },
        initialValue: [],
        in: { $concatArrays: ["$$value", "$$this"] },
      },
    });
  });
});

describe("date .getTime / .toISOString", () => {
  it("getTime", () => {
    expect(mjsql("$.ts.getTime()")).toEqual({ $toLong: "$ts" });
  });
  it("toISOString", () => {
    expect(mjsql("$.ts.toISOString()")).toEqual({
      $dateToString: { date: "$ts", format: "%Y-%m-%dT%H:%M:%S.%LZ" },
    });
  });
});

describe("Math.sign / log2 / log10 / hypot / cbrt / random / constants", () => {
  it("Math.sign maps to $cmp(x, 0)", () => {
    expect(mjsql("Math.sign($.x)")).toEqual({ $cmp: ["$x", 0] });
  });
  it("Math.log2", () => {
    expect(mjsql("Math.log2($.x)")).toEqual({ $log: ["$x", 2] });
  });
  it("Math.log10", () => {
    expect(mjsql("Math.log10($.x)")).toEqual({ $log10: "$x" });
  });
  it("Math.cbrt", () => {
    expect(mjsql("Math.cbrt($.x)")).toEqual({ $pow: ["$x", { $divide: [1, 3] }] });
  });
  it("Math.hypot 2-arg", () => {
    expect(mjsql("Math.hypot($.a, $.b)")).toEqual({
      $sqrt: { $add: [{ $pow: ["$a", 2] }, { $pow: ["$b", 2] }] },
    });
  });
  it("Math.random", () => {
    expect(mjsql("Math.random()")).toEqual({ $rand: {} });
  });
  it("Math.PI", () => {
    expect(mjsql("Math.PI")).toEqual(Math.PI);
  });
  it("Math.E", () => {
    expect(mjsql("Math.E")).toEqual(Math.E);
  });
});

describe("numeric separators", () => {
  it("integer with separator", () => {
    expect(mjsql("$abs(1_000_000)")).toEqual({ $abs: 1000000 });
  });
  it("float with separator", () => {
    expect(mjsql("$abs(1_234.567_89)")).toEqual({ $abs: 1234.56789 });
  });
  it("exponent with separator", () => {
    expect(mjsql("$abs(1_2e3)")).toEqual({ $abs: 12000 });
  });
  it("trailing _ rejected", () => {
    expect(() => mjsql("1_")).toThrow(/Numeric separator/);
  });
  it("double __ rejected", () => {
    expect(() => mjsql("1__0")).toThrow(/Numeric separator/);
  });
});

describe("comments", () => {
  it("// line comment between expressions", () => {
    expect(mjsql("$.a // tail\n+ $.b")).toEqual({ $add: ["$a", "$b"] });
  });
  it("// line comment at EOF (no terminator)", () => {
    expect(mjsql("$abs($.x) // trailing comment")).toEqual({ $abs: "$x" });
  });
  it("// terminated by CR", () => {
    expect(mjsql("$.a // x\r+ $.b")).toEqual({ $add: ["$a", "$b"] });
  });
  it("// terminated by CRLF", () => {
    expect(mjsql("$.a // x\r\n+ $.b")).toEqual({ $add: ["$a", "$b"] });
  });
  it("// terminated by U+2028 (LSEP)", () => {
    expect(mjsql("$.a // x + $.b")).toEqual({ $add: ["$a", "$b"] });
  });
  it("// terminated by U+2029 (PSEP)", () => {
    expect(mjsql("$.a // x + $.b")).toEqual({ $add: ["$a", "$b"] });
  });
  it("/* block */ inline", () => {
    expect(mjsql("$.a /* mid */ + $.b")).toEqual({ $add: ["$a", "$b"] });
  });
  it("/* multi-line block */", () => {
    expect(mjsql("$.a /*\n  spans\n  lines\n*/ + $.b")).toEqual({
      $add: ["$a", "$b"],
    });
  });
  it("empty /**/ block", () => {
    expect(mjsql("$.a /**/ + $.b")).toEqual({ $add: ["$a", "$b"] });
  });
  it("multiple comments collapse to one boundary", () => {
    expect(mjsql("$.a // one\n  /* two */ \n // three\n + $.b")).toEqual({
      $add: ["$a", "$b"],
    });
  });
  it("comment inside template ${...} interpolation", () => {
    expect(mjsql("`hi ${ $.name /* user */ }`")).toEqual({
      $concat: ["hi ", { $toString: "$name" }],
    });
  });
  it("// inside string literal is preserved as data", () => {
    expect(mjsql('$eq($.url, "https://example.com")')).toEqual({
      $eq: ["$url", "https://example.com"],
    });
  });
  it("// inside regex literal is preserved as pattern", () => {
    // Two literal slashes inside a regex character class — must not be eaten as a comment
    expect(mjsql("$.path.match(/[/\\\\]/)")).toEqual({
      $regexMatch: { input: "$path", regex: "[/\\\\]" },
    });
  });
  it("regex disambiguation works after a comment (non-value-ending)", () => {
    // After `(` (not a value-ending token) a `/` would normally start a regex.
    // A leading comment must not change that.
    expect(mjsql("$.path.match(/* skip */ /foo/i)")).toEqual({
      $regexMatch: { input: "$path", regex: "foo", options: "i" },
    });
  });
  it("divide disambiguation works after a comment (value-ending)", () => {
    // After a Number token, `/` is divide; a leading comment must not change that.
    expect(mjsql("10 /* skip */ / 2")).toEqual({ $divide: [10, 2] });
  });
  it("unclosed /* throws LexError", () => {
    expect(() => mjsql("$.a /* unclosed")).toThrow(/Unclosed block comment/);
  });
});

describe("computed object keys", () => {
  it("single computed key", () => {
    expect(mjsql("$abs({ [$.k]: 1 })")).toEqual({
      $abs: { $arrayToObject: [["$k", 1]] },
    });
  });
  it("mixed static and computed keys", () => {
    expect(mjsql("$abs({ a: 1, [$.k]: 2 })")).toEqual({
      $abs: {
        $arrayToObject: [
          ["a", 1],
          ["$k", 2],
        ],
      },
    });
  });
});

describe("spread in operator args", () => {
  it("$concatArrays with spread", () => {
    expect(mjsql("$concatArrays(...$.arrs)")).toEqual({ $concatArrays: "$arrs" });
  });
  it("Object.assign with spread", () => {
    expect(mjsql("Object.assign(...$.docs)")).toEqual({ $mergeObjects: "$docs" });
  });
});

describe("shorthand object properties", () => {
  it("inside lambda body", () => {
    expect(mjsql("$.items.map(x => ({ x }))")).toEqual({
      $map: { input: "$items", as: "x", in: { x: "$$x" } },
    });
  });
  it("two shorthand props", () => {
    expect(mjsql("$.items.map(x => ({ x, x }))")).toEqual({
      $map: { input: "$items", as: "x", in: { x: "$$x" } },
    });
  });
  it("shorthand outside lambda scope errors", () => {
    expect(() => mjsql("({ foo })")).toThrow(/Unknown identifier/);
  });
});

describe("flex-shape operators", () => {
  // ── $round / $trunc ─────────────────────────────────────────────────────────
  it("$round single arg → bare value", () => {
    expect(mjsql("$round($.price)")).toEqual({ $round: "$price" });
  });
  it("$round two args → array", () => {
    expect(mjsql("$round($.price, 2)")).toEqual({ $round: ["$price", 2] });
  });
  it("$trunc single arg → bare value", () => {
    expect(mjsql("$trunc($.value)")).toEqual({ $trunc: "$value" });
  });
  it("$trunc two args → array", () => {
    expect(mjsql("$trunc($.value, 1)")).toEqual({ $trunc: ["$value", 1] });
  });

  // ── Accumulators ($min / $max / $avg / $sum / $stdDev*) ─────────────────────
  it("$min single arg → bare value (accumulator-style)", () => {
    expect(mjsql("$min($.scores)")).toEqual({ $min: "$scores" });
  });
  it("$min multiple args → array (expression-style)", () => {
    expect(mjsql("$min($.a, $.b, $.c)")).toEqual({ $min: ["$a", "$b", "$c"] });
  });
  it("$max single arg", () => {
    expect(mjsql("$max($.scores)")).toEqual({ $max: "$scores" });
  });
  it("$max multiple args", () => {
    expect(mjsql("$max($.a, $.b)")).toEqual({ $max: ["$a", "$b"] });
  });
  it("$avg single arg", () => {
    expect(mjsql("$avg($.values)")).toEqual({ $avg: "$values" });
  });
  it("$avg multiple args", () => {
    expect(mjsql("$avg($.a, $.b, $.c)")).toEqual({ $avg: ["$a", "$b", "$c"] });
  });
  it("$sum single arg", () => {
    expect(mjsql("$sum($.amounts)")).toEqual({ $sum: "$amounts" });
  });
  it("$sum multiple args", () => {
    expect(mjsql("$sum($.a, $.b)")).toEqual({ $sum: ["$a", "$b"] });
  });
  it("$stdDevPop single arg", () => {
    expect(mjsql("$stdDevPop($.measurements)")).toEqual({ $stdDevPop: "$measurements" });
  });
  it("$stdDevSamp multiple args", () => {
    expect(mjsql("$stdDevSamp($.a, $.b, $.c)")).toEqual({
      $stdDevSamp: ["$a", "$b", "$c"],
    });
  });

  // ── $mergeObjects ───────────────────────────────────────────────────────────
  it("$mergeObjects single arg → bare value", () => {
    expect(mjsql("$mergeObjects($.docs)")).toEqual({ $mergeObjects: "$docs" });
  });
  it("$mergeObjects multiple args → array", () => {
    expect(mjsql("$mergeObjects($.a, $.b)")).toEqual({ $mergeObjects: ["$a", "$b"] });
  });

  // ── Spread handling ─────────────────────────────────────────────────────────
  it("flex op with single spread → bare array", () => {
    expect(mjsql("$min(...$.scores)")).toEqual({ $min: "$scores" });
  });
  it("flex op with mixed spread + scalar → $concatArrays", () => {
    expect(mjsql("$max($.first, ...$.rest)")).toEqual({
      $max: { $concatArrays: [["$first"], "$rest"] },
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────────────
  it("flex op with zero args throws", () => {
    expect(() => mjsql("$min()")).toThrow(/at least 1 argument/);
  });
  it("flex op with object literal arg → object as value (not object-shape)", () => {
    // Single arg that happens to be an object literal — parser flags this as object-style,
    // but $mergeObjects has flex shape (not object), so the literal is passed as a value.
    expect(mjsql("$mergeObjects({ a: 1, b: $.x })")).toEqual({
      $mergeObjects: { a: 1, b: "$x" },
    });
  });
  it("$round with arithmetic still works (regression: existing 2-arg form)", () => {
    expect(mjsql("$round($.price * 1.1, 2)")).toEqual({
      $round: [{ $multiply: ["$price", 1.1] }, 2],
    });
  });
});

describe("function overload", () => {
  it("accepts a no-param arrow", () => {
    expect(mjsql(() => $.age > 18)).toEqual({ $gt: ["$age", 18] });
  });

  it("accepts a $-param arrow (recommended idiom)", () => {
    expect(mjsql(($) => $.age > 18)).toEqual({ $gt: ["$age", 18] });
  });

  it("produces identical MQL to the equivalent string", () => {
    expect(mjsql(($) => $.status == "active")).toEqual(mjsql('$.status == "active"'));
  });

  it("the wrapper parameter is not bound inside the body — references resolve via $", () => {
    // `(doc) =>` is a typing/IDE hook only. Inside the body, `doc.foo` is treated as
    // an unknown identifier (and the user gets pointed at `$.doc` and the mql tag).
    expect(() => mjsql((doc) => doc.foo)).toThrow(/Unknown identifier 'doc'/);
  });

  it("handles nested arrows in the body", () => {
    expect(mjsql(($) => $.items.map((x) => x * 2))).toEqual({
      $map: { input: "$items", as: "x", in: { $multiply: ["$$x", 2] } },
    });
  });

  it("handles a parenthesised object-literal body", () => {
    expect(mjsql(($) => ({ doubled: $.x * 2 }))).toEqual({ doubled: { $multiply: ["$x", 2] } });
  });

  it("rejects a block-body arrow with a clear error", () => {
    expect(() =>
      mjsql(($) => {
        return $.age > 18;
      }),
    ).toThrow(/expression-body arrow/);
  });

  it("rejects a `function` declaration", () => {
    expect(() =>
      mjsql(function () {
        return $.age > 18;
      }),
    ).toThrow(/arrow function/);
  });

  it("rejects an async arrow", () => {
    expect(() => mjsql(async () => $.age > 18)).toThrow(/async/);
  });

  it("appends an mql`` hint when an outer-scope identifier is referenced", () => {
    const minAge = 21; // referenced from the closure on purpose
    expect(() => mjsql(($) => $.age > minAge)).toThrow(/mql`` template tag/);
  });

  it("validate() reports the augmented hint for closure refs", () => {
    const minAge = 21;
    const r = validate(($) => $.age > minAge);
    expect(r.valid).toBe(false);
    expect(r.errors[0]?.code).toBe("CODEGEN_ERROR");
    expect(r.errors[0]?.message).toMatch(/Unknown identifier 'minAge'/);
    expect(r.errors[0]?.message).toMatch(/mql`` template tag/);
  });

  it("validate() reports SYNTAX_ERROR for an unsupported function shape", () => {
    const r = validate(($) => {
      return $.age > 18;
    });
    expect(r.valid).toBe(false);
    expect(r.errors[0]?.code).toBe("SYNTAX_ERROR");
  });

  it("inline arrow in a hot loop produces consistent MQL across calls (cache correctness)", () => {
    const make = () => mjsql(($) => $.status == "active");
    const a = make();
    const b = make();
    expect(a).toEqual(b);
  });

  it("destructured operator in the second parameter compiles to the same MQL as the string form", () => {
    // The second arg is types-only — it gives users a destructure site that
    // silences IDE warnings on `$dateDiff`. The runtime strips the param list,
    // so this produces identical MQL to the string equivalent.
    const fromFn = mjsql(($, { $dateDiff }) =>
      $dateDiff({ startDate: $.a, endDate: $.b, unit: "day" }),
    );
    const fromStr = mjsql('$dateDiff({ startDate: $.a, endDate: $.b, unit: "day" })');
    expect(fromFn).toEqual(fromStr);
  });
});

// ─── Newly-registered operators (pulled from mongodb/mql-specifications) ────

describe("bitwise operators", () => {
  it.each([
    ["$bitAnd", "$bitAnd($.a, $.b, $.c)", { $bitAnd: ["$a", "$b", "$c"] }],
    ["$bitOr", "$bitOr($.a, $.b)", { $bitOr: ["$a", "$b"] }],
    ["$bitXor", "$bitXor($.a, $.b)", { $bitXor: ["$a", "$b"] }],
    ["$bitNot", "$bitNot($.flags)", { $bitNot: "$flags" }],
  ])("%s emits the expected MQL", (_name, src, expected) => {
    expect(mjsql(src)).toEqual(expected);
  });
});

describe("misc / hash / timestamp / sigmoid / type / literal operators", () => {
  it.each([
    ["$sigmoid", "$sigmoid($.x)", { $sigmoid: "$x" }],
    ["$createObjectId", "$createObjectId()", { $createObjectId: {} }],
    ["$toHashedIndexKey", "$toHashedIndexKey($.k)", { $toHashedIndexKey: "$k" }],
    ["$tsIncrement", "$tsIncrement($.t)", { $tsIncrement: "$t" }],
    ["$tsSecond", "$tsSecond($.t)", { $tsSecond: "$t" }],
    [
      "$toUUID",
      '$toUUID("550e8400-e29b-41d4-a716-446655440000")',
      {
        $toUUID: "550e8400-e29b-41d4-a716-446655440000",
      },
    ],
    ["$toObject", "$toObject($.json)", { $toObject: "$json" }],
    ["$toArray", "$toArray($.field)", { $toArray: "$field" }],
    ["$literal field-ref pass-through", '$literal("$foo")', { $literal: "$foo" }],
    ["$meta keyword string", '$meta("textScore")', { $meta: "textScore" }],
  ])("%s emits the expected MQL", (_name, src, expected) => {
    expect(mjsql(src)).toEqual(expected);
  });
});

describe("$hash and $hexHash (object shape)", () => {
  it("$hash positional", () => {
    expect(mjsql('$hash($.password, "sha256")')).toEqual({
      $hash: { input: "$password", algorithm: "sha256" },
    });
  });
  it("$hexHash object-style", () => {
    expect(mjsql('$hexHash({ input: $.token, algorithm: "sha512" })')).toEqual({
      $hexHash: { input: "$token", algorithm: "sha512" },
    });
  });
});

describe("$accumulator and $function (custom aggregation)", () => {
  it("$function object-style", () => {
    expect(
      mjsql('$function({ body: "function(x) { return x * 2; }", args: [$.value], lang: "js" })'),
    ).toEqual({
      $function: {
        body: "function(x) { return x * 2; }",
        args: ["$value"],
        lang: "js",
      },
    });
  });
  it("$accumulator object-style with subset of keys", () => {
    expect(
      mjsql(
        '$accumulator({ init: "function() { return 0; }", accumulate: "function(s, v) { return s + v; }", merge: "function(a, b) { return a + b; }", lang: "js" })',
      ),
    ).toEqual({
      $accumulator: {
        init: "function() { return 0; }",
        accumulate: "function(s, v) { return s + v; }",
        merge: "function(a, b) { return a + b; }",
        lang: "js",
      },
    });
  });
});

describe("$median and $percentile (statistical accumulators)", () => {
  it("$median positional", () => {
    expect(mjsql('$median($.scores, "approximate")')).toEqual({
      $median: { input: "$scores", method: "approximate" },
    });
  });
  it("$percentile positional", () => {
    expect(mjsql('$percentile($.scores, [0.5, 0.95], "approximate")')).toEqual({
      $percentile: {
        input: "$scores",
        p: [0.5, 0.95],
        method: "approximate",
      },
    });
  });
});

describe("encrypted-string operators ($encStr*)", () => {
  it("$encStrContains", () => {
    expect(mjsql('$encStrContains($.encField, "secret")')).toEqual({
      $encStrContains: { input: "$encField", substring: "secret" },
    });
  });
  it("$encStrStartsWith object-style", () => {
    expect(mjsql('$encStrStartsWith({ input: $.encField, prefix: "abc" })')).toEqual({
      $encStrStartsWith: { input: "$encField", prefix: "abc" },
    });
  });
  it("$encStrEndsWith", () => {
    expect(mjsql('$encStrEndsWith($.encField, "xyz")')).toEqual({
      $encStrEndsWith: { input: "$encField", suffix: "xyz" },
    });
  });
  it("$encStrNormalizedEq", () => {
    expect(mjsql('$encStrNormalizedEq($.encField, "compare")')).toEqual({
      $encStrNormalizedEq: { input: "$encField", string: "compare" },
    });
  });
});

describe("window operators ($setWindowFields-only)", () => {
  it.each([
    ["$rank", "$rank()", { $rank: {} }],
    ["$denseRank", "$denseRank()", { $denseRank: {} }],
    ["$documentNumber", "$documentNumber()", { $documentNumber: {} }],
    ["$linearFill", "$linearFill($.value)", { $linearFill: "$value" }],
    ["$locf", "$locf($.value)", { $locf: "$value" }],
    ["$covariancePop", "$covariancePop($.x, $.y)", { $covariancePop: ["$x", "$y"] }],
    ["$covarianceSamp", "$covarianceSamp($.x, $.y)", { $covarianceSamp: ["$x", "$y"] }],
  ])("%s emits the expected MQL", (_name, src, expected) => {
    expect(mjsql(src)).toEqual(expected);
  });

  it("$shift positional", () => {
    expect(mjsql("$shift($.price, -1, 0)")).toEqual({
      $shift: { output: "$price", by: -1, default: 0 },
    });
  });

  it("$shift object-style", () => {
    expect(mjsql("$shift({ output: $.price, by: -1, default: 0 })")).toEqual({
      $shift: { output: "$price", by: -1, default: 0 },
    });
  });

  it("$expMovingAvg with N (positional)", () => {
    expect(mjsql("$expMovingAvg($.price, 5)")).toEqual({
      $expMovingAvg: { input: "$price", N: 5 },
    });
  });

  it("$expMovingAvg with alpha (object-style)", () => {
    expect(mjsql("$expMovingAvg({ input: $.price, alpha: 0.3 })")).toEqual({
      $expMovingAvg: { input: "$price", alpha: 0.3 },
    });
  });

  it("$derivative positional", () => {
    expect(mjsql('$derivative($.value, "hour")')).toEqual({
      $derivative: { input: "$value", unit: "hour" },
    });
  });

  it("$integral positional", () => {
    expect(mjsql('$integral($.value, "hour")')).toEqual({
      $integral: { input: "$value", unit: "hour" },
    });
  });
});
