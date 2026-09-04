// Phase 5 of src/compiler/ — the filter target, end to end.
//
// A JSMQL predicate and the query document the new compiler emits. The shipped
// compiler's outputs where the two agree, and the ruled shape where they differ:
// `||` lowers PER BRANCH, so a leaf's query form never depends on its sibling.
// The wider net is scripts/diff-compilers.mjs --cur … --entry filter.

import { describe, expect, it } from "vitest";
import { filter } from "../src/compiler/index.ts";
import { PendingLowering } from "../src/compiler/emit/errors.ts";

const TRUTHY = (v: unknown) => ({
  $and: [{ $ne: [{ $ifNull: [v, null] }, null] }, { $ne: [v, false] }, { $ne: [v, ""] }, { $ne: [v, 0] }],
});

describe("compiler/emit/filter — comparisons", () => {
  it("lowers a field against a constant to the query language", () => {
    expect(filter("$.a === 1")).toEqual({ a: 1 });
    expect(filter("$.a !== 1")).toEqual({ a: { $ne: 1 } });
    expect(filter("1 === $.a")).toEqual({ a: 1 });
    expect(filter("$.a > 1")).toEqual({ a: { $gt: 1 } });
    expect(filter("1 < $.a")).toEqual({ a: { $gt: 1 } });
    expect(filter("$.a.b.c > 5")).toEqual({ "a.b.c": { $gt: 5 } });
    expect(filter('$.d > new Date("2024-01-01")')).toEqual({ d: { $gt: new Date("2024-01-01") } });
    expect(String((filter("$._id === 0x507f1f77bcf86cd799439011") as { _id: unknown })._id)).toBe(
      "507f1f77bcf86cd799439011",
    );
  });

  it("keeps the null, presence and type tests as the query language spells them", () => {
    expect(filter("$.a == null")).toEqual({ a: null });
    expect(filter("$.a != null")).toEqual({ a: { $ne: null } });
    expect(filter("$.a === null")).toEqual({ a: { $type: "null" } });
    expect(filter("$.a !== null")).toEqual({ a: { $not: { $type: "null" } } });
    expect(filter("$.a === undefined")).toEqual({ a: { $exists: false } });
    expect(filter("$.a !== undefined")).toEqual({ a: { $exists: true } });
    expect(filter('typeof $.a === "string"')).toEqual({ a: { $type: "string" } });
    expect(filter('typeof $.a === "boolean"')).toEqual({ a: { $type: "bool" } });
    expect(filter('typeof $.a !== "number"')).toEqual({ a: { $not: { $type: "number" } } });
    expect(filter("$.a % 2 === 0")).toEqual({ a: { $mod: [2, 0] } });
    expect(filter("$.a % 2 !== 0")).toEqual({ a: { $not: { $mod: [2, 0] } } });
  });

  it("falls back to $expr where the query language has no form", () => {
    expect(filter("$.a > $.b")).toEqual({ $expr: { $gt: ["$a", "$b"] } });
    expect(filter("$.a + 1 === 2")).toEqual({ $expr: { $eq: [{ $add: ["$a", 1] }, 2] } });
    expect(filter("$abs($.a) === 2")).toEqual({ $expr: { $eq: [{ $abs: "$a" }, 2] } });
    expect(filter("!($.a > 1)")).toEqual({ $expr: { $not: { $gt: ["$a", 1] } } });
    expect(filter("$.a")).toEqual({ $expr: TRUTHY("$a") });
    expect(filter("$.a in [1, 2]")).toEqual({ $expr: { $in: ["$a", [1, 2]] } });
    expect(filter('typeof $.a === "function"')).toEqual({ $expr: { $eq: [{ $type: "$a" }, "function"] } });
    // `.length` is a LENGTH, which `$size` (arrays only) cannot say for a string
    expect(filter("$.arr.length > 2")).toMatchObject({ $expr: { $gt: [expect.anything(), 2] } });
  });
});

describe("compiler/emit/filter — && and ||", () => {
  it("merges conjuncts, colliding keys into one $and, residuals into one $expr", () => {
    expect(filter("$.a > 1 && $.b <= 2")).toEqual({ a: { $gt: 1 }, b: { $lte: 2 } });
    expect(filter("$.a >= 1 && $.a <= 9")).toEqual({ $and: [{ a: { $gte: 1 } }, { a: { $lte: 9 } }] });
    expect(filter("$.a === 1 && $.a === 2 && $.b === 3")).toEqual({ $and: [{ a: 1 }, { a: 2 }], b: 3 });
    expect(filter('$.status === "active" && $.a > $.b && $.c < $.d')).toEqual({
      status: "active",
      $expr: { $and: [{ $gt: ["$a", "$b"] }, { $lt: ["$c", "$d"] }] },
    });
    expect(filter("$.x === 1 && ($.y === 2 || $.z === 3)")).toEqual({ x: 1, $or: [{ y: 2 }, { z: 3 }] });
  });

  it("lowers || per branch — a leaf's meaning never depends on its sibling", () => {
    expect(filter("$.a === 1 || $.b === 2")).toEqual({ $or: [{ a: 1 }, { b: 2 }] });
    expect(filter('$.tags === "red" || $.qty * $.price > 100')).toEqual({
      $or: [{ tags: "red" }, { $expr: { $gt: [{ $multiply: ["$qty", "$price"] }, 100] } }],
    });
    expect(filter("$.a === 1 || $.b === 2 || $.c === 3")).toEqual({ $or: [{ a: 1 }, { b: 2 }, { c: 3 }] });
  });

  it("folds a chain of .includes on one field into $all", () => {
    expect(filter('$.tags.includes("a") && $.tags.includes("b")')).toEqual({ tags: { $all: ["a", "b"] } });
    expect(filter('$.tags.includes("a") && $.other.includes("b")')).toEqual({ tags: "a", other: "b" });
  });
});

describe("compiler/emit/filter — methods and operators", () => {
  it("lowers the boolean methods to their indexable forms", () => {
    expect(filter('$.tags.includes("x")')).toEqual({ tags: "x" });
    expect(filter('["a", "b"].includes($.s)')).toEqual({ s: { $in: ["a", "b"] } });
    expect(filter('$.s.startsWith("A")')).toEqual({ s: /^A/ });
    expect(filter('$.s.endsWith("z.")')).toEqual({ s: /z\.$/ });
    expect(filter("$.s.match(/^a/i)")).toEqual({ s: /^a/i });
    expect(filter("$.items.some(i => i.q > 2)")).toEqual({ items: { $elemMatch: { q: { $gt: 2 } } } });
    expect(filter("$.items.some(i => i.q > 2 && i.name === 'x')")).toEqual({
      items: { $elemMatch: { q: { $gt: 2 }, name: "x" } },
    });
  });

  it("keeps the expression form where the receiver or the argument is not a path and a constant", () => {
    // The query cell answers null, and the fallback asks the VALUE lowering — which for
    // these methods is still the registry's `pending`, so that is what arrives.
    expect(() => filter('$abs($.n).startsWith("A")')).toThrow(PendingLowering);
    expect(() => filter("$.items.every(i => i.q > 2)")).toThrow(PendingLowering);
    expect(() => filter("$.items.some(i => i.q > $.min)")).toThrow(PendingLowering);
    // inside $elemMatch the OUTER document has no path: `$.flag` must not become the element's `flag`
    expect(() => filter("$.items.some(i => i.q > 2 && $.flag === true)")).toThrow(PendingLowering);
    expect(() => filter("$.s.startsWith($.prefix)")).toThrow(PendingLowering);
  });

  it("lowers a query-only operator to its query form and refuses a non-constant", () => {
    expect(filter("$.a === 1 && $sampleRate(0.5)")).toEqual({ a: 1, $sampleRate: 0.5 });
    expect(() => filter("$sampleRate($.r)")).toThrow(/must be a compile-time constant/);
  });

  it("passes a raw query document through, values lowered", () => {
    expect(filter('{ status: "active", $expr: $.score > $.threshold }')).toEqual({
      status: "active",
      $expr: { $gt: ["$score", "$threshold"] },
    });
    expect(filter("{ a: { $gt: 1 }, tags: { $all: ['x'] } }")).toEqual({ a: { $gt: 1 }, tags: { $all: ["x"] } });
    // a one-operand $op inside a raw document is the query operator, at any depth
    expect(filter("{ a: $not($gt(1)) }")).toEqual({ a: { $not: { $gt: 1 } } });
    expect(filter("{ a: $size(2) }")).toEqual({ a: { $size: 2 } });
    expect(() => filter("({ $setUnion: $.x })")).toThrow(/operates on a list of operands/);
  });

  it("drops a branch the fold settled, and keeps the rest as written", () => {
    expect(filter("$.a === 1 || false")).toEqual({ a: 1 });
    expect(filter("$.a === 1 && true")).toEqual({ a: 1 });
    expect(filter("$.a === 1 || true")).toEqual({});
    expect(filter("$.a === 1 && false")).toEqual({ $expr: false });
    expect(filter("1 === 1")).toEqual({ $expr: true });
    expect(filter("$.a > -1")).toEqual({ a: { $gt: -1 } });
  });
});
