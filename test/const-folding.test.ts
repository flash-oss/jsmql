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
      userId: { $eq: new ObjectId("507f1f77bcf86cd799439011"), $not: { $type: "array" } },
    });
  });

  it("arithmetic const folds and collapses to a Filter", () => {
    expect(jsmql("const msInDay = 24*60*60*1000; $.elapsedMs > msInDay")).toEqual({
      elapsedMs: { $gt: 86400000, $not: { $type: "array" } },
    });
  });

  it("exponentiation folds", () => {
    expect(jsmql("const limit = 2**32; $.n < limit")).toEqual({ n: { $lt: 4294967296, $not: { $type: "array" } } });
  });

  it("string const folds", () => {
    expect(jsmql('const status = "active"; $.status === status')).toEqual({
      status: { $eq: "active", $not: { $type: "array" } },
    });
  });

  it("new Date(literal) folds to a BSON Date", () => {
    expect(() => jsmql('let date = new Date("2020-01-01"); $.createdAt < date')).toThrow(
      "A Filter or an expression takes a 'const' prelude; a 'let' needs the pipeline form, where it becomes a field.",
    );
  });

  it("a const chain folds (a const built from an earlier const)", () => {
    expect(jsmql("const base = 10; const doubled = base * 2; $.n < doubled")).toEqual({
      n: { $lt: 20, $not: { $type: "array" } },
    });
  });

  it("array literal const folds (membership → $expr $in)", () => {
    expect(jsmql('const bad = ["cancelled", "rejected"]; $.status in bad')).toEqual({
      status: { $in: ["cancelled", "rejected"], $not: { $type: "array" } },
    });
  });

  it("object literal + spread folds", () => {
    expect(jsmql("const base = { a: 1 }; const cfg = { ...base, b: 2 }; $.cfg === cfg")).toEqual({
      $expr: { $eq: ["$cfg", { a: 1, b: 2 }] },
    });
  });

  it("string template with string interpolation folds", () => {
    expect(jsmql("const region = `us-east`; const key = `region:${region}`; $.key === key")).toEqual({
      key: { $eq: "region:us-east", $not: { $type: "array" } },
    });
  });

  it(".length and index fold inside a const RHS (folding applies to the RHS, not query exprs)", () => {
    // Folding evaluates the const's RHS; a `.length`/index there collapses to a
    // literal. (In a query expression like `$.count === items.length`, `items`
    // inlines but `.length` stays `$size` — the server computes it.)
    expect(jsmql("const n = [10, 20, 30].length; $.count === n")).toEqual({
      count: { $eq: 3, $not: { $type: "array" } },
    });
    expect(jsmql("const first = [10, 20, 30][0]; $.first === first")).toEqual({
      first: { $eq: 10, $not: { $type: "array" } },
    });
  });
});

describe("const folding — pipeline interaction", () => {
  it("a folded const in a multi-stage pipeline emits no $set / $unset", () => {
    expect(jsmql("const minAge = 18; $match($.age > minAge); $sort({ age: -1 })")).toEqual([
      { $match: { age: { $gt: 18, $not: { $type: "array" } } } },
      { $sort: { age: -1 } },
    ]);
  });

  it("mixed fold + runtime binding stays a Pipeline", () => {
    expect(jsmql("const x = 5; const t = new Date(); $match($.a === x && $.b >= t)")).toEqual([
      { $set: { "__jsmql.var.t": { $toDate: "$$NOW" } } },
      { $match: { a: { $eq: 5, $not: { $type: "array" } }, $expr: { $gte: ["$b", "$__jsmql.var.t"] } } },
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
      {
        $lookup: {
          from: "orders",
          pipeline: [{ $match: { $expr: { $gt: ["$$jsmql_f0_createdAt", "2026-01-01"] } } }],
          as: "recent",
          let: { jsmql_f0_createdAt: "$createdAt" },
        },
      },
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
      { $match: { $expr: { $eq: ["$n", { $toLong: "123" }] } } },
    ]);
  });
});

describe("const folding — errors", () => {
  it("a declaration with nothing reading it errors", () => {
    expect(() => jsmql("const x = 5;")).toThrow(
      "This program produces no stages, so it would leave the documents untouched. Write at least one statement that reads or changes them.",
    );
  });

  it("a non-finite folded result is a hard error (HR3)", () => {
    expect(() => jsmql("const x = 1/0; $.n < x")).toThrow(/Infinity.*no MongoDB literal/);
    expect(() => jsmql("const x = 0/0; $.n < x")).toThrow(/NaN.*no MongoDB literal/);
  });

  it("an invalid constant date is rejected", () => {
    expect(() => jsmql('const d = new Date("nope"); $.t < d')).toThrow(
      'new Date(<constant>) — only an ISO 8601 string or a millisecond count is a date constant, and this one is neither a valid date string nor a number. Write new Date("2026-01-01") or new Date(0).',
    );
  });
});

describe("const folding — parameterised (jsmql.compile) per-call folding", () => {
  it("a const built from a compile param folds per call", () => {
    const q = jsmql.compile(({ max }, { $ }) => {
      const cutoff = max * 2;
      $match($.n < cutoff);
    });
    expect(q({ max: 10 })).toEqual([{ $match: { n: { $lt: 20, $not: { $type: "array" } } } }]);
    expect(q({ max: 50 })).toEqual([{ $match: { n: { $lt: 100, $not: { $type: "array" } } } }]);
  });
});

describe("const folding — native method calls", () => {
  it("array .map with an arrow callback folds (example 5)", () => {
    expect(
      jsmql('const bad = ["cancelled", "rejected", "returned"].map(s => s.toUpperCase()); $.status in bad'),
    ).toEqual({ status: { $in: ["CANCELLED", "REJECTED", "RETURNED"], $not: { $type: "array" } } });
  });

  it("array .filter with an arrow callback folds", () => {
    expect(jsmql("const evens = [1, 2, 3, 4, 5, 6].filter(n => n % 2 === 0); $.k in evens")).toEqual({
      k: { $in: [2, 4, 6], $not: { $type: "array" } },
    });
  });

  it("array .reduce folds to a scalar", () => {
    expect(jsmql("const total = [1, 2, 3, 4].reduce((a, b) => a + b, 0); $.n === total")).toEqual({
      n: { $eq: 10, $not: { $type: "array" } },
    });
  });

  it("nested method chain folds (map → filter)", () => {
    expect(jsmql("const xs = [1, 2, 3, 4].map(x => x * 10).filter(x => x > 15); $.v in xs")).toEqual({
      v: { $in: [20, 30, 40], $not: { $type: "array" } },
    });
  });

  it("string methods fold (ASCII case, split)", () => {
    expect(jsmql('const up = "active".toUpperCase(); $.s === up')).toEqual({
      s: { $eq: "ACTIVE", $not: { $type: "array" } },
    });
    expect(jsmql('const parts = "a,b,c".split(","); $.x in parts')).toEqual({
      x: { $in: ["a", "b", "c"], $not: { $type: "array" } },
    });
  });

  it("array .slice folds (const receiver + const args) with JS start/end semantics", () => {
    expect(jsmql("const recent = [1, 2, 3, 4, 5].slice(-3); $.k in recent")).toEqual({
      k: { $in: [3, 4, 5], $not: { $type: "array" } },
    });
    expect(jsmql("const page = [1, 2, 3, 4, 5, 6].slice(1, 3); $.k in page")).toEqual({
      k: { $in: [2, 3], $not: { $type: "array" } },
    });
    expect(jsmql("const empty = [1, 2, 3].slice(2, 1); $.k in empty")).toEqual({
      k: { $in: [], $not: { $type: "array" } },
    });
  });

  it("array .slice with a runtime index does NOT fold — falls through to the $slice lowering", () => {
    const out = jsmql("const arr = [1, 2, 3]; $.out = arr.slice($.start)");
    // `arr` inlines (it's constant), but the runtime `$.start` index keeps the
    // `.slice` itself un-folded → the general $slice lowering, not a literal.
    expect(JSON.stringify(out)).toContain("$slice");
  });

  it("a callback that reads $ makes the whole call non-constant → runtime binding", () => {
    expect(jsmql("const m = [1, 2, 3].map(x => x + $.offset); $match($.v in m)")).toEqual([
      { $set: { "__jsmql.var.m": { $map: { input: [1, 2, 3], as: "x", in: { $add: ["$$x", "$offset"] } } } } },
      { $match: { $expr: { $in: ["$v", "$__jsmql.var.m"] } } },
      { $unset: "__jsmql" },
    ]);
  });

  it("a non-finite result inside a folded callback is a hard error", () => {
    expect(() => jsmql("const xs = [1, 2, 0].map(n => 10 / n); $.v in xs")).toThrow(/Infinity.*no MongoDB literal/);
  });
});

describe("const folding — lodash string methods", () => {
  it("a .snakeCase() const-chain folds (example 7)", () => {
    expect(
      jsmql(
        'let webhookMessage = "time elapsed"; let webhookType = webhookMessage.snakeCase(); $.type === webhookType',
      ),
    ).toEqual({ type: { $eq: "time_elapsed", $not: { $type: "array" } } });
  });

  it("camelCase / kebabCase / startCase / capitalize fold", () => {
    expect(jsmql('const k = "order_total".camelCase(); $.f === k')).toEqual({
      f: { $eq: "orderTotal", $not: { $type: "array" } },
    });
    expect(jsmql('const k = "orderTotal".kebabCase(); $.f === k')).toEqual({
      f: { $eq: "order-total", $not: { $type: "array" } },
    });
    expect(jsmql('const k = "hello world".startCase(); $.f === k')).toEqual({
      f: { $eq: "Hello World", $not: { $type: "array" } },
    });
    expect(jsmql('const k = "hELLO".capitalize(); $.f === k')).toEqual({
      f: { $eq: "Hello", $not: { $type: "array" } },
    });
  });

  it(".escape() and .truncate() fold", () => {
    expect(jsmql("const k = '<a href=\"x\">'.escape(); $.f === k")).toEqual({
      f: { $eq: "&lt;a href=&quot;x&quot;&gt;", $not: { $type: "array" } },
    });
    expect(jsmql('const k = "the quick brown fox".truncate({ length: 12 }); $.f === k')).toEqual({
      f: { $eq: "the quick...", $not: { $type: "array" } },
    });
  });

  it(".words() folds to an array", () => {
    expect(jsmql('const w = "fooBar-baz 9".words(); $.tags === w')).toEqual({
      tags: { $eq: ["foo", "Bar", "baz", "9"], $not: { $type: "array" } },
    });
    // the index is part of the const RHS, so it folds too
    expect(jsmql('const first = "fooBar-baz 9".words()[0]; $.f === first')).toEqual({
      f: { $eq: "foo", $not: { $type: "array" } },
    });
  });
});

describe("const folding — inside lambda expr-blocks", () => {
  it("a constant const inside a lambda block folds (no $let)", () => {
    expect(jsmql.expr("$.items.map(x => { const factor = 2; return x * factor })")).toEqual({
      $map: { input: "$items", as: "x", in: { $let: { vars: { factor: 2 }, in: { $multiply: ["$$x", "$$factor"] } } } },
    });
  });

  it("a const that reads the lambda param stays a runtime $let", () => {
    expect(jsmql.expr("$.items.map(x => { const dbl = x * 2; return dbl + 1 })")).toEqual({
      $map: {
        input: "$items",
        as: "x",
        in: { $let: { vars: { dbl: { $multiply: ["$$x", 2] } }, in: { $add: ["$$dbl", 1] } } },
      },
    });
  });

  it("a const shadowing the lambda param keeps its $let (correct shadow)", () => {
    expect(jsmql.expr("$.items.map(x => { const x = 99; return x })")).toEqual({
      $map: { input: "$items", as: "x", in: { $let: { vars: { x: 99 }, in: "$$x" } } },
    });
  });

  it("mixed: the constant inlines into the runtime binding's initialiser", () => {
    expect(jsmql.expr("$.items.map(x => { const bump = 10; const y = x + bump; return y })")).toEqual({
      $map: {
        input: "$items",
        as: "x",
        in: { $let: { vars: { bump: 10 }, in: { $let: { vars: { y: { $add: ["$$x", "$$bump"] } }, in: "$$y" } } } },
      },
    });
  });
});

describe("const folding — output stability", () => {
  it("a pipeline with no foldable consts is byte-identical to before", () => {
    expect(jsmql("$match($.x > 0); $sort({ x: 1 })")).toEqual([
      { $match: { x: { $gt: 0, $not: { $type: "array" } } } },
      { $sort: { x: 1 } },
    ]);
  });
});
