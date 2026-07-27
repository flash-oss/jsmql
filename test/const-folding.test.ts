import { describe, it, expect } from "vitest";
import { jsmql, ObjectId } from "../src/index.ts";

// Compile-time constant folding of `const`/`let` (see docs/specs/const-folding.md).
// A foldable RHS is evaluated at compile time and inlined at every reference;
// the declaration emits no stage, and when only one expression survives the
// program collapses to a Filter. Non-constant RHS keeps the runtime `$set`
// binding (covered in let-bindings.test.ts). This suite is commit-1 scope:
// literals, arithmetic, value construction, ObjectId, new Date, index/length,
// const-chains, and the fold/collapse/edge-case mechanics.

describe("const folding — collapse to Filter", () => {
  it("ObjectId const folds and collapses to a Filter", () => {
    expect(jsmql("const userId = 0x507f1f77bcf86cd799439011; $.userId === userId")).toEqual({
      userId: new ObjectId("507f1f77bcf86cd799439011"),
    });
  });

  it("arithmetic const folds and collapses to a Filter", () => {
    expect(jsmql("const msInDay = 24*60*60*1000; $.elapsedMs > msInDay")).toEqual({ elapsedMs: { $gt: 86400000 } });
  });

  it("exponentiation folds", () => {
    expect(jsmql("const limit = 2**32; $.n < limit")).toEqual({ n: { $lt: 4294967296 } });
  });

  it("string const folds", () => {
    expect(jsmql('const status = "active"; $.status === status')).toEqual({ status: "active" });
  });

  it("new Date(literal) folds to a BSON Date", () => {
    expect(jsmql('let date = new Date("2020-01-01"); $.createdAt < date')).toEqual({
      createdAt: { $lt: new Date("2020-01-01T00:00:00.000Z") },
    });
  });

  it("a const chain folds (a const built from an earlier const)", () => {
    expect(jsmql("const base = 10; const doubled = base * 2; $.n < doubled")).toEqual({ n: { $lt: 20 } });
  });

  it("array literal const folds (membership → $expr $in)", () => {
    expect(jsmql('const bad = ["cancelled", "rejected"]; $.status in bad')).toEqual({
      $expr: { $in: ["$status", ["cancelled", "rejected"]] },
    });
  });

  it("object literal + spread folds", () => {
    expect(jsmql("const base = { a: 1 }; const cfg = { ...base, b: 2 }; $.cfg === cfg")).toEqual({
      $expr: { $eq: ["$cfg", { a: 1, b: 2 }] },
    });
  });

  it("string template with string interpolation folds", () => {
    expect(jsmql("const region = `us-east`; const key = `region:${region}`; $.key === key")).toEqual({
      key: "region:us-east",
    });
  });

  it(".length and index fold inside a const RHS (folding applies to the RHS, not query exprs)", () => {
    // Folding evaluates the const's RHS; a `.length`/index there collapses to a
    // literal. (In a query expression like `$.count === items.length`, `items`
    // inlines but `.length` stays `$size` — the server computes it.)
    expect(jsmql("const n = [10, 20, 30].length; $.count === n")).toEqual({ count: 3 });
    expect(jsmql("const first = [10, 20, 30][0]; $.first === first")).toEqual({ first: 10 });
  });
});

describe("const folding — pipeline interaction", () => {
  it("a folded const in a multi-stage pipeline emits no $set / $unset", () => {
    expect(jsmql("const minAge = 18; $match($.age > minAge); $sort({ age: -1 })")).toEqual([
      { $match: { age: { $gt: 18 } } },
      { $sort: { age: -1 } },
    ]);
  });

  it("mixed fold + runtime binding stays a Pipeline", () => {
    expect(jsmql("const x = 5; const t = new Date(); $match($.a === x && $.b >= t)")).toEqual([
      { $set: { "__jsmql.var.t": { $toDate: "$$NOW" } } },
      { $match: { a: 5, $expr: { $gte: ["$b", "$__jsmql.var.t"] } } },
      { $unset: "__jsmql" },
    ]);
  });

  it("a folded const crosses into a $lookup sub-pipeline (compile-time constants are position-independent)", () => {
    expect(
      jsmql(`
        const cutoff = "2026-01-01";
        $lookup({ from: "orders", pipeline: [ $match($.createdAt > cutoff) ], as: "recent" });
      `),
    ).toEqual([
      { $lookup: { from: "orders", pipeline: [{ $match: { createdAt: { $gt: "2026-01-01" } } }], as: "recent" } },
    ]);
  });
});

describe("const folding — fallback to runtime binding", () => {
  it("a non-constant RHS (reads $) keeps the runtime $set binding", () => {
    expect(jsmql("const y = $.a; $match($.b === y)")).toEqual([
      { $set: { "__jsmql.var.y": "$a" } },
      { $match: { $expr: { $eq: ["$b", "$__jsmql.var.y"] } } },
      { $unset: "__jsmql" },
    ]);
  });

  it("new Date() (reads the clock) stays runtime", () => {
    expect(jsmql("const now = new Date(); $match($.createdAt < now)")).toEqual([
      { $set: { "__jsmql.var.now": { $toDate: "$$NOW" } } },
      { $match: { $expr: { $lt: ["$createdAt", "$__jsmql.var.now"] } } },
      { $unset: "__jsmql" },
    ]);
  });

  it("a reassigned let is excluded from folding (stays runtime)", () => {
    expect(jsmql("let x = 1; x = 2; $match($.a === x)")).toEqual([
      { $set: { "__jsmql.var.x": 1 } },
      { $set: { "__jsmql.var.x": 2 } },
      { $match: { $expr: { $eq: ["$a", "$__jsmql.var.x"] } } },
      { $unset: "__jsmql" },
    ]);
  });

  it("a BigInt RHS stays runtime ($toLong)", () => {
    expect(jsmql("const big = 123n; $match($.n === big)")).toEqual([
      { $set: { "__jsmql.var.big": { $toLong: "123" } } },
      { $match: { $expr: { $eq: ["$n", "$__jsmql.var.big"] } } },
      { $unset: "__jsmql" },
    ]);
  });
});

describe("const folding — errors", () => {
  it("a declaration with nothing reading it errors", () => {
    expect(() => jsmql("const x = 5;")).toThrow(/on its own produces no query/);
  });

  it("a non-finite folded result is a hard error (HR3)", () => {
    expect(() => jsmql("const x = 1/0; $.n < x")).toThrow(/Infinity.*no MongoDB literal/);
    expect(() => jsmql("const x = 0/0; $.n < x")).toThrow(/NaN.*no MongoDB literal/);
  });

  it("an invalid constant date is rejected", () => {
    expect(() => jsmql('const d = new Date("nope"); $.t < d')).toThrow(/not a valid date string/);
  });
});

describe("const folding — parameterised (jsmql.compile) per-call folding", () => {
  it("a const built from a compile param folds per call", () => {
    const q = jsmql.compile(({ max }, { $ }) => {
      const cutoff = max * 2;
      $match($.n < cutoff);
    });
    expect(q({ max: 10 })).toEqual([{ $match: { n: { $lt: 20 } } }]);
    expect(q({ max: 50 })).toEqual([{ $match: { n: { $lt: 100 } } }]);
  });
});

describe("const folding — output stability", () => {
  it("a pipeline with no foldable consts is byte-identical to before", () => {
    expect(jsmql("$match($.x > 0); $sort({ x: 1 })")).toEqual([{ $match: { x: { $gt: 0 } } }, { $sort: { x: 1 } }]);
  });
});
