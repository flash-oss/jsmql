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
  // Every comparison reads the field's OWN value: MongoDB would satisfy `{ a: 1 }`
  // with `a: [1, 2]`, and JavaScript's `===` never does. A path of more than one
  // segment excludes an array at each prefix too, because MongoDB traverses it.
  it("lowers a field against a constant to the query language", () => {
    expect(filter("$.a === 1")).toEqual({ a: { $eq: 1, $not: { $type: "array" } } });
    expect(filter("$.a !== 1")).toEqual({ $or: [{ a: { $ne: 1 } }, { a: { $type: "array" } }] });
    expect(filter("1 === $.a")).toEqual({ a: { $eq: 1, $not: { $type: "array" } } });
    expect(filter("$.a > 1")).toEqual({ a: { $gt: 1, $not: { $type: "array" } } });
    expect(filter("1 < $.a")).toEqual({ a: { $gt: 1, $not: { $type: "array" } } });
    expect(filter("$.a.b.c > 5")).toEqual({
      "a.b.c": { $gt: 5, $not: { $type: "array" } },
      a: { $not: { $type: "array" } },
      "a.b": { $not: { $type: "array" } },
    });
    expect(filter('$.d > new Date("2024-01-01")')).toEqual({
      d: { $gt: new Date("2024-01-01"), $not: { $type: "array" } },
    });
    expect(String((filter("$._id === 0x507f1f77bcf86cd799439011") as { _id: { $eq: unknown } })._id.$eq)).toBe(
      "507f1f77bcf86cd799439011",
    );
  });

  it("keeps the null, presence and type tests as the query language spells them", () => {
    expect(filter("$.a == null")).toEqual({ a: { $eq: null, $not: { $type: "array" } } });
    expect(filter("$.a != null")).toEqual({ $or: [{ a: { $ne: null } }, { a: { $type: "array" } }] });
    expect(filter("$.a === null")).toEqual({ a: { $type: "null", $not: { $type: "array" } } });
    expect(filter("$.a !== null")).toEqual({ $or: [{ a: { $not: { $type: "null" } } }, { a: { $type: "array" } }] });
    expect(filter("$.a === undefined")).toEqual({ a: { $exists: false } });
    // `typeof` speaks MongoDB's type names: "undefined" IS one, the deprecated BSON
    // type. Absence has its own spelling, `x === undefined`.
    expect(filter('typeof $.a === "undefined"')).toEqual({ a: { $type: "undefined", $not: { $type: "array" } } });
    expect(filter("$.a !== undefined")).toEqual({ a: { $exists: true } });
    expect(filter('typeof $.a === "string"')).toEqual({ a: { $type: "string", $not: { $type: "array" } } });
    expect(filter('typeof $.a === "bool"')).toEqual({ a: { $type: "bool", $not: { $type: "array" } } });
    // A name MongoDB does not know is refused with the nearest one, never lowered
    // to a test that quietly matches nothing.
    expect(() => filter('typeof $.a === "boolean"')).toThrow(/not one\. Did you mean 'bool'\?/);
    expect(() => filter('typeof $.a === "function"')).toThrow(/MongoDB's type names/);
    expect(filter('typeof $.a !== "number"')).toEqual({
      $or: [{ a: { $not: { $type: "number" } } }, { a: { $type: "array" } }],
    });
    // The `array` spelling asks whether the value IS an array, so it excludes none.
    expect(filter('typeof $.a === "array"')).toEqual({ a: { $type: "array" } });
    expect(filter('typeof $.a !== "array"')).toEqual({ a: { $not: { $type: "array" } } });
    expect(filter("$.a % 2 === 0")).toEqual({ a: { $mod: [2, 0], $not: { $type: "array" } } });
    expect(filter("$.a % 2 !== 0")).toEqual({ $or: [{ a: { $not: { $mod: [2, 0] } } }, { a: { $type: "array" } }] });
  });

  it("falls back to $expr where the query language has no form", () => {
    expect(filter("$.a > $.b")).toEqual({ $expr: { $gt: ["$a", "$b"] } });
    expect(filter("$.a + 1 === 2")).toEqual({ $expr: { $eq: [{ $add: ["$a", 1] }, 2] } });
    expect(filter("$abs($.a) === 2")).toEqual({ $expr: { $eq: [{ $abs: "$a" }, 2] } });
    expect(filter("$.a")).toEqual({ $expr: TRUTHY("$a") });
    expect(filter("$.a in [1, 2]")).toEqual({ $expr: { $in: ["$a", [1, 2]] } });
    // `.length` is a LENGTH, which `$size` (arrays only) cannot say for a string
    expect(filter("$.arr.length > 2")).toMatchObject({ $expr: { $gt: [expect.anything(), 2] } });
  });
});

describe("compiler/emit/filter — && and ||", () => {
  it("merges conjuncts, colliding keys into one $and, residuals into one $expr", () => {
    expect(filter("$.a > 1 && $.b <= 2")).toEqual({
      a: { $gt: 1, $not: { $type: "array" } },
      b: { $lte: 2, $not: { $type: "array" } },
    });
    // Two operator documents on one field that agree wherever they overlap are ONE
    // document: the server reads every operator in it as a conjunction.
    expect(filter("$.a >= 1 && $.a <= 9")).toEqual({ a: { $gte: 1, $not: { $type: "array" }, $lte: 9 } });
    // The same operator named twice stays in the `$and`.
    expect(filter("$.a === 1 && $.a === 2 && $.b === 3")).toEqual({
      $and: [{ a: { $eq: 1, $not: { $type: "array" } } }, { a: { $eq: 2, $not: { $type: "array" } } }],
      b: { $eq: 3, $not: { $type: "array" } },
    });
    expect(filter('$.status === "active" && $.a > $.b && $.c < $.d')).toEqual({
      status: { $eq: "active", $not: { $type: "array" } },
      $expr: { $and: [{ $gt: ["$a", "$b"] }, { $lt: ["$c", "$d"] }] },
    });
    expect(filter("$.x === 1 && ($.y === 2 || $.z === 3)")).toEqual({
      x: { $eq: 1, $not: { $type: "array" } },
      $or: [{ y: { $eq: 2, $not: { $type: "array" } } }, { z: { $eq: 3, $not: { $type: "array" } } }],
    });
  });

  // `!p` is the complement of p's own clause. `$expr` orders across BSON types, so
  // `{ $not: { $gt: ["$v", 1] } }` is false for `v: [0, 20]`, where JavaScript says true.
  it("complements a native clause under !, and keeps the truth road otherwise", () => {
    expect(filter("!($.a > 1)")).toEqual({ $nor: [{ a: { $gt: 1, $not: { $type: "array" } } }] });
    expect(filter("!($.a === 1 && $.b === 2)")).toEqual({
      $nor: [{ a: { $eq: 1, $not: { $type: "array" } }, b: { $eq: 2, $not: { $type: "array" } } }],
    });
    // no native form inside: the truth road's own `$not` is already JavaScript's answer
    expect(filter("!$.a")).toEqual({ $expr: { $not: TRUTHY("$a") } });
    expect(filter("!($.a > $.b)")).toEqual({ $expr: { $not: { $gt: ["$a", "$b"] } } });
  });

  it("lowers || per branch — a leaf's meaning never depends on its sibling", () => {
    expect(filter("$.a === 1 || $.b === 2")).toEqual({
      $or: [{ a: { $eq: 1, $not: { $type: "array" } } }, { b: { $eq: 2, $not: { $type: "array" } } }],
    });
    expect(filter('$.tags === "red" || $.qty * $.price > 100')).toEqual({
      $or: [
        { tags: { $eq: "red", $not: { $type: "array" } } },
        { $expr: { $gt: [{ $multiply: ["$qty", "$price"] }, 100] } },
      ],
    });
    expect(filter("$.a === 1 || $.b === 2 || $.c === 3")).toEqual({
      $or: [
        { a: { $eq: 1, $not: { $type: "array" } } },
        { b: { $eq: 2, $not: { $type: "array" } } },
        { c: { $eq: 3, $not: { $type: "array" } } },
      ],
    });
  });

  // `.includes` reads two ways — containment in an array, substring in a string —
  // and the fold keeps both, one on each side of the `$or`.
  it("folds a chain of .includes on one field into $all", () => {
    expect(filter('$.tags.includes("a") && $.tags.includes("b")')).toEqual({
      $or: [
        { tags: { $all: ["a", "b"], $type: "array" } },
        { $and: [{ tags: { $regex: "a", $not: { $type: "array" } } }, { tags: { $regex: "b" } }] },
      ],
    });
    expect(filter('$.tags.includes("a") && $.other.includes("b")')).toEqual({
      $and: [
        { $or: [{ tags: { $eq: "a", $type: "array" } }, { tags: { $regex: "a", $not: { $type: "array" } } }] },
        { $or: [{ other: { $eq: "b", $type: "array" } }, { other: { $regex: "b", $not: { $type: "array" } } }] },
      ],
    });
  });
});

describe("compiler/emit/filter — a raw query document", () => {
  it("keeps the developer's own MQL, and refuses JavaScript the query language cannot read", () => {
    // Raw MQL passes through, keys as written (HR1) — including a name this build
    // does not list in filter position, because a newer query operator must round-trip.
    expect(filter("{ a: 1 }")).toEqual({ a: 1 });
    expect(filter("{ a: { $gt: 1 } }")).toEqual({ a: { $gt: 1 } });
    expect(filter("{ a: { $size: 2 } }")).toEqual({ a: { $size: 2 } });
    expect(filter("{ a: -1 }")).toEqual({ a: -1 });
    expect(filter("{ a: $gt(1) }")).toEqual({ a: { $gt: 1 } });
    // `$expr`'s row states that its operand is an aggregation EXPRESSION, so the
    // query-value rules do not apply inside it.
    expect(filter("{ $expr: $multiply($.a, 2) }")).toEqual({ $expr: { $multiply: ["$a", 2] } });
    // A computed expression in a value slot is neither a value nor a query operator:
    // it becomes `{ a: { $gt: ["$b", 1] } }`, which the server accepts and matches nothing.
    expect(() => filter("{ a: $.b > 1 }")).toThrow(/computed expression/);
  });
});

describe("compiler/emit/filter — methods and operators", () => {
  it("lowers the boolean methods to their indexable forms", () => {
    // Containment for an array value, substring for a string one — JavaScript reads
    // `.includes` both ways, and a bare field path proves neither.
    expect(filter('$.tags.includes("x")')).toEqual({
      $or: [{ tags: { $eq: "x", $type: "array" } }, { tags: { $regex: "x", $not: { $type: "array" } } }],
    });
    expect(filter('["a", "b"].includes($.s)')).toEqual({ s: { $in: ["a", "b"], $not: { $type: "array" } } });
    expect(filter('$.s.startsWith("A")')).toEqual({ s: { $regex: /^A/, $not: { $type: "array" } } });
    expect(filter('$.s.endsWith("z.")')).toEqual({ s: { $regex: /z\.$/, $not: { $type: "array" } } });
    expect(filter("$.s.match(/^a/i)")).toEqual({ s: { $regex: /^a/i, $not: { $type: "array" } } });
    // `.some` IS the element test, so `$elemMatch` is its own reading; the element's
    // own fields take the rule again.
    expect(filter("$.items.some(i => i.q > 2)")).toEqual({
      items: { $elemMatch: { q: { $gt: 2, $not: { $type: "array" } } } },
    });
    expect(filter("$.items.some(i => i.q > 2 && i.name === 'x')")).toEqual({
      items: { $elemMatch: { q: { $gt: 2, $not: { $type: "array" } }, name: { $eq: "x", $not: { $type: "array" } } } },
    });
  });

  it("keeps the expression form where the receiver or the argument is not a path and a constant", () => {
    // The query cell answers null, and the fallback asks the VALUE lowering, which
    // arrives under `$expr`.
    // A receiver PROVEN to be no string is refused before either: `$abs` returns a number.
    expect(() => filter('$abs($.n).startsWith("A")')).toThrow(/not available on a 'number'/);
    expect(filter("$.items.every(i => i.q > 2)")).toHaveProperty("$expr");
    expect(filter("$.items.some(i => i.q > $.min)")).toHaveProperty("$expr");
    // inside $elemMatch the OUTER document has no path: `$.flag` must not become the element's `flag`
    expect(filter("$.items.some(i => i.q > 2 && $.flag === true)")).toHaveProperty("$expr");
    // and an OUTER element's fields are not the inner element's
    expect(filter("$.a.some(i => i.b.some(j => i.c === 1))")).toHaveProperty("$expr");
    expect(filter("$.a.some(i => i.b.some(j => j.c === 1))")).toEqual({
      a: { $elemMatch: { b: { $elemMatch: { c: { $eq: 1, $not: { $type: "array" } } } } } },
    });
    // a field against a field has no query form: the value cell's shape under `$expr`
    expect(filter("$.s.startsWith($.prefix)")).toEqual({ $expr: { $eq: [{ $indexOfCP: ["$s", "$prefix"] }, 0] } });
  });

  it("lowers a query-only operator to its query form and refuses a non-constant", () => {
    expect(filter("$.a === 1 && $sampleRate(0.5)")).toEqual({
      a: { $eq: 1, $not: { $type: "array" } },
      $sampleRate: 0.5,
    });
    expect(() => filter("$sampleRate($.r)")).toThrow(/must be a compile-time constant/);
    expect(() => filter("$sampleRate(2)")).toThrow(/from 0 to 1/);
    expect(() => filter('$sampleRate("0.5")')).toThrow(/expects a number/);
    expect(() => filter("$.items.some(i => $sampleRate(0.5))")).toThrow(/top-level document only/);
    expect(() => filter("$.a % 0 === 1")).toThrow(/divide by zero/);
    expect(() => filter("$divide($.a, 0) > 1")).toThrow(/divide by zero/);
    expect(filter("$log10($.a) > 1")).toEqual({ $expr: { $gt: [{ $log10: "$a" }, 1] } });
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
    expect(filter("$.a === 1 || false")).toEqual({ a: { $eq: 1, $not: { $type: "array" } } });
    expect(filter("$.a === 1 && true")).toEqual({ a: { $eq: 1, $not: { $type: "array" } } });
    expect(filter("$.a === 1 || true")).toEqual({});
    expect(filter("$.a === 1 && false")).toEqual({ $expr: false });
    expect(filter("1 === 1")).toEqual({ $expr: true });
    expect(filter("$.a > -1")).toEqual({ a: { $gt: -1, $not: { $type: "array" } } });
  });
});
