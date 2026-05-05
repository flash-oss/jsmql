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
