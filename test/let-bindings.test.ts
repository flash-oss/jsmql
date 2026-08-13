import { describe, it, expect } from "vitest";
import { jsmql } from "../src/index.ts";
import { truthy } from "./truthy.ts";

describe("let bindings — basic shape", () => {
  it("a single let materialises under __jsmql, with a trailing $unset", () => {
    expect(jsmql("let total = $.price * $.qty; $project({ total })")).toEqual([
      { $set: { "__jsmql.var.total": { $multiply: ["$price", "$qty"] } } },
      { $project: { total: "$__jsmql.var.total" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("multiple lets that build on each other emit one $set stage each", () => {
    // Canonical example from the plan + realistic test. Read-after-write splits
    // each let into its own $set stage — that's required for the inner refs to
    // see the outer writes.
    expect(
      jsmql(`
        let subtotal = $.price * $.qty;
        let withTax  = subtotal * 1.2;
        let withShip = withTax + $.shipping;
        $project({ sku: 1, subtotal, withTax, final: withShip });
      `),
    ).toEqual([
      { $set: { "__jsmql.var.subtotal": { $multiply: ["$price", "$qty"] } } },
      { $set: { "__jsmql.var.withTax": { $multiply: ["$__jsmql.var.subtotal", 1.2] } } },
      { $set: { "__jsmql.var.withShip": { $add: ["$__jsmql.var.withTax", "$shipping"] } } },
      {
        $project: {
          sku: 1,
          subtotal: "$__jsmql.var.subtotal",
          withTax: "$__jsmql.var.withTax",
          final: "$__jsmql.var.withShip",
        },
      },
      { $unset: "__jsmql" },
    ]);
  });

  it("a let referenced inside $match wraps in $expr automatically", () => {
    expect(jsmql("let big = $.x > 100; $match(big)")).toEqual([
      { $set: { "__jsmql.var.big": { $gt: ["$x", 100] } } },
      { $match: { $expr: truthy("$__jsmql.var.big") } },
      { $unset: "__jsmql" },
    ]);
  });

  it("a let referenced as a $sort value resolves to its field path", () => {
    expect(jsmql("let score = $.views + $.likes; $sort({ score: -1 })")).toEqual([
      { $set: { "__jsmql.var.score": { $add: ["$views", "$likes"] } } },
      { $sort: { score: -1 } },
      { $unset: "__jsmql" },
    ]);
  });

  it("a let used inside a method-call lambda body resolves correctly", () => {
    // The lambda parameter shadows nothing in this case — `tax` is the let.
    // (Runtime RHS `$.rate` so it stays a `$set` binding; a constant RHS would
    // fold — see the const-folding suite.)
    expect(jsmql("let tax = $.rate; $project({ totals: $.items.map(x => x.price * (1 + tax)) })")).toEqual([
      { $set: { "__jsmql.var.tax": "$rate" } },
      {
        $project: {
          totals: {
            $map: { input: "$items", as: "x", in: { $multiply: ["$$x.price", { $add: [1, "$__jsmql.var.tax"] }] } },
          },
        },
      },
      { $unset: "__jsmql" },
    ]);
  });

  it("lambda parameter shadows a let with the same name inside the lambda body", () => {
    // `total` is bound by `let` at pipeline scope and by the lambda inside it.
    // The lambda wins inside its body (lexical: closer scope wins). Outside the
    // lambda, the let is still visible.
    expect(jsmql("let total = $.grand; $project({ doubled: $.items.map(total => total * 2), grand: total })")).toEqual([
      { $set: { "__jsmql.var.total": "$grand" } },
      {
        $project: {
          doubled: { $map: { input: "$items", as: "total", in: { $multiply: ["$$total", 2] } } },
          grand: "$__jsmql.var.total",
        },
      },
      { $unset: "__jsmql" },
    ]);
  });
});

describe("let bindings — bracketed pipeline form", () => {
  it("works as the first element of a [...] pipeline", () => {
    expect(jsmql("[let x = $.a + 1, $match(x > 5)]")).toEqual([
      { $set: { "__jsmql.var.x": { $add: ["$a", 1] } } },
      { $match: { $expr: { $gt: ["$__jsmql.var.x", 5] } } },
      { $unset: "__jsmql" },
    ]);
  });

  it("works interleaved with update ops and stages", () => {
    // The update op buffer flushes around the let, so `$.a = 1` and the let
    // each contribute their own stage. The trailing `$unset` is for the let,
    // not the update op.
    expect(jsmql("[$match($.x > 0), let y = $.x * 2, $.flag = true, $sort({ y: 1 })]")).toEqual([
      { $match: { x: { $gt: 0 } } },
      { $set: { "__jsmql.var.y": { $multiply: ["$x", 2] } } },
      { $set: { flag: true } },
      { $sort: { y: 1 } },
      { $unset: "__jsmql" },
    ]);
  });
});

describe("let bindings — template-tag form", () => {
  it("composes with `${...}` interpolation", () => {
    const threshold = 42;
    expect(jsmql`let big = $.score > ${threshold}; $match(big)`).toEqual([
      { $set: { "__jsmql.var.big": { $gt: ["$score", 42] } } },
      { $match: { $expr: truthy("$__jsmql.var.big") } },
      { $unset: "__jsmql" },
    ]);
  });
});

describe("let bindings — scope-reshaping stages clear the binding", () => {
  it("errors when a let is read after $group", () => {
    expect(() => jsmql("let total = $.price * $.qty; $group({ _id: $.cat }); $match(total > 0)")).toThrow(
      /`total` is a `let` binding and can't be read after `\$group`/,
    );
  });

  it("errors when a let is read after $replaceRoot", () => {
    expect(() => jsmql("let total = $.x; $replaceRoot({ newRoot: $.sub }); $match(total > 0)")).toThrow(
      /`total` is a `let` binding and can't be read after `\$replaceRoot`/,
    );
  });

  it("errors when a let is read after $replaceWith", () => {
    expect(() => jsmql("let total = $.x; $replaceWith($.sub); $match(total > 0)")).toThrow(
      /`total` is a `let` binding and can't be read after `\$replaceWith`/,
    );
  });

  it("errors when a let is read after $bucket", () => {
    expect(() => jsmql("let v = $.x; $bucket({ groupBy: $.y, boundaries: [0, 10, 20] }); $match(v > 0)")).toThrow(
      /`v` is a `let` binding and can't be read after `\$bucket`/,
    );
  });

  it("allows rebinding after the reshape stage", () => {
    expect(
      jsmql("let v = $.x; $group({ _id: $.cat, sum: $sum($.amount) }); let v2 = $.sum * 2; $project({ v2 })"),
    ).toEqual([
      { $set: { "__jsmql.var.v": "$x" } },
      { $group: { _id: "$cat", sum: { $sum: "$amount" } } },
      { $set: { "__jsmql.var.v2": { $multiply: ["$sum", 2] } } },
      { $project: { v2: "$__jsmql.var.v2" } },
      { $unset: "__jsmql" },
    ]);
  });
});

describe("let bindings — duplicate declaration", () => {
  it("errors on re-declaring the same name in the same scope", () => {
    expect(() => jsmql("let x = 1; let x = 2; $project({ x })")).toThrow(
      /`let x` is already declared earlier in this pipeline/,
    );
  });
});

describe("let bindings — context rules", () => {
  it("errors when `let` appears at top-level without a pipeline boundary", () => {
    // Expression-mode input: a single `let` with no `;` is meaningless.
    expect(() => jsmql("let x = 5")).toThrow(/only valid inside a pipeline/);
  });

  it("a single runtime let with trailing `;` is valid (pipeline of one binding + auto-unset)", () => {
    // Useless but legal — the parser flips to pipeline mode at the `;`. Runtime
    // RHS (`$.a`) so it stays a `$set`; a constant `const x = 5;` on its own
    // instead errors (nothing reads it — see the const-folding suite).
    expect(jsmql("let x = $.a;")).toEqual([{ $set: { "__jsmql.var.x": "$a" } }, { $unset: "__jsmql" }]);
  });

  it("`let` is rejected as a value-array element", () => {
    // A non-pipeline array (no stage-leading element) with a `let` is malformed.
    // First element is a number, so isPipelineAst returns false and we fall
    // through to expression-mode array-literal codegen, which rejects.
    expect(() => jsmql("[1, let x = 5]")).toThrow(/`let` is a pipeline statement/);
  });
});

describe("let bindings — sub-pipeline boundaries", () => {
  it("a sub-pipeline inside $lookup can declare its own lets independently", () => {
    expect(
      jsmql(`[
        $lookup({
          from: "orders",
          let: { uid: $._id },
          pipeline: [
            let recent = $.createdAt > "2026-01-01",
            $match(recent)
          ],
          as: "userOrders"
        })
      ]`),
    ).toEqual([
      {
        $lookup: {
          from: "orders",
          let: { uid: "$_id" },
          pipeline: [
            { $set: { "__jsmql.var.recent": { $gt: ["$createdAt", "2026-01-01"] } } },
            { $match: { $expr: truthy("$__jsmql.var.recent") } },
            { $unset: "__jsmql" },
          ],
          as: "userOrders",
        },
      },
    ]);
  });

  it("outer lets are NOT visible inside a sub-pipeline", () => {
    // The outer `cutoff` doesn't reach into the $lookup pipeline. (Runtime RHS
    // `$.start`, so it's a per-document `$set` binding — those don't cross a
    // sub-pipeline boundary; a compile-time constant would inline everywhere.)
    expect(() =>
      jsmql(`
        let cutoff = $.start;
        $lookup({
          from: "orders",
          pipeline: [ $match($.createdAt > cutoff) ],
          as: "recent"
        });
      `),
    ).toThrow(/Unknown identifier 'cutoff'/);
  });
});

describe("let bindings — jsmql.validate() integration", () => {
  it("a duplicate-let error surfaces as CODEGEN_ERROR through jsmql.validate()", () => {
    const result = jsmql.validate("let x = 1; let x = 2; $project({ x })");
    expect(result.valid).toBe(false);
    expect(result.errors[0].code).toBe("CODEGEN_ERROR");
    expect(result.errors[0].message).toMatch(/already declared earlier in this pipeline/);
  });

  it("a post-$group let-read error surfaces as CODEGEN_ERROR through jsmql.validate()", () => {
    const result = jsmql.validate("let total = $.price; $group({ _id: $.cat }); $match(total > 0)");
    expect(result.valid).toBe(false);
    expect(result.errors[0].code).toBe("CODEGEN_ERROR");
    expect(result.errors[0].message).toMatch(/can't be read after `\$group`/);
  });
});

describe("let bindings — does not affect pipelines without `let`", () => {
  it("a pipeline with no lets produces no __jsmql trace and no trailing $unset", () => {
    expect(jsmql("$match($.x > 0); $sort({ x: 1 })")).toEqual([{ $match: { x: { $gt: 0 } } }, { $sort: { x: 1 } }]);
  });
});

// ── Parser-level errors ───────────────────────────────────────────────────────

describe("let bindings — parser errors", () => {
  it("rejects `let` with no identifier", () => {
    expect(() => jsmql("let = 5;")).toThrow(/Expected an identifier after `let`/);
  });

  it("rejects `let x` with no `=`", () => {
    expect(() => jsmql("let x 5;")).toThrow(/Expected '=' after `let x`.*requires an initialiser/s);
  });

  it("rejects `let x =` with no expression", () => {
    expect(() => jsmql("let x = ; $match($.a > 0)")).toThrow(/Unexpected token ';'/);
  });

  it("rejects keyword (`in`) as a let name", () => {
    expect(() => jsmql("let in = 5;")).toThrow(/Expected an identifier after `let`.*got 'in'/s);
  });

  it("rejects `$`-prefixed names (which would tokenise as Dollar + Ident, not an identifier)", () => {
    expect(() => jsmql("let $foo = 5;")).toThrow(/Expected an identifier after `let`.*got '\$'/s);
  });

  it("rejects bare-identifier references to a let that hasn't been declared yet", () => {
    expect(() => jsmql("$match(future > 0); let future = $.x;")).toThrow(/Unknown identifier 'future'/);
  });

  it("rejects unknown bare identifiers in pipelines with no lets", () => {
    // Smoke check that the normal "unknown identifier" path still fires for
    // unbound bare identifiers when no let machinery is in play. The trailing
    // `;` puts the input in Pipeline mode so the stage-call-without-`;` guard
    // doesn't intercept.
    expect(() => jsmql("$match(zzz > 5);")).toThrow(/Unknown identifier 'zzz'/);
  });
});

// ── Various RHS expression types ──────────────────────────────────────────────

describe("let bindings — RHS expression coverage", () => {
  // A pure-literal RHS is a compile-time constant, so it folds and inlines
  // (no `$set`/`$unset`) instead of materialising a runtime binding. See the
  // const-folding suite for the full surface.
  it("number literal RHS folds and inlines", () => {
    expect(jsmql("let n = 42; $project({ n })")).toEqual([{ $project: { n: 42 } }]);
  });

  it("string literal RHS folds and inlines", () => {
    expect(jsmql('let s = "active"; $project({ s })')).toEqual([{ $project: { s: "active" } }]);
  });

  it("boolean literal RHS folds and inlines", () => {
    expect(jsmql("let flag = true; $project({ flag })")).toEqual([{ $project: { flag: true } }]);
  });

  it("null literal RHS folds and inlines", () => {
    expect(jsmql("let nothing = null; $project({ nothing })")).toEqual([{ $project: { nothing: null } }]);
  });

  it("BigInt literal RHS — coerced through $toLong like elsewhere", () => {
    expect(jsmql("let big = 123n; $project({ big })")).toEqual([
      { $set: { "__jsmql.var.big": { $toLong: "123" } } },
      { $project: { big: "$__jsmql.var.big" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("template-literal RHS with field interpolation", () => {
    expect(jsmql("let g = `hello ${$.name}`; $project({ greeting: g })")).toEqual([
      { $set: { "__jsmql.var.g": { $concat: ["hello ", { $toString: "$name" }] } } },
      { $project: { greeting: "$__jsmql.var.g" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("ternary RHS", () => {
    expect(jsmql('let cat = $.age > 18 ? "adult" : "minor"; $project({ cat })')).toEqual([
      { $set: { "__jsmql.var.cat": { $cond: { if: { $gt: ["$age", 18] }, then: "adult", else: "minor" } } } },
      { $project: { cat: "$__jsmql.var.cat" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("$op-call RHS — accumulator inside a let value is fine syntactically", () => {
    // The accumulator runs at the surrounding stage's context; the $set wrapper
    // is what's actually emitted, and Mongo evaluates accumulators per-document
    // in normal $set context (effectively as the first element of an array).
    expect(jsmql("let avg = $avg($.scores); $project({ avg })")).toEqual([
      { $set: { "__jsmql.var.avg": { $avg: "$scores" } } },
      { $project: { avg: "$__jsmql.var.avg" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("array-literal RHS", () => {
    expect(jsmql("let tags = [$.a, $.b, $.c]; $project({ tags })")).toEqual([
      { $set: { "__jsmql.var.tags": ["$a", "$b", "$c"] } },
      { $project: { tags: "$__jsmql.var.tags" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("object-literal RHS", () => {
    expect(jsmql("let obj = { a: $.x, b: $.y }; $project({ obj })")).toEqual([
      { $set: { "__jsmql.var.obj": { a: "$x", b: "$y" } } },
      { $project: { obj: "$__jsmql.var.obj" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("nullish-coalescing RHS", () => {
    expect(jsmql('let v = $.maybe ?? "default"; $project({ v })')).toEqual([
      { $set: { "__jsmql.var.v": { $ifNull: ["$maybe", "default"] } } },
      { $project: { v: "$__jsmql.var.v" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("`new Date()` RHS", () => {
    expect(jsmql("let now = new Date(); $project({ now })")).toEqual([
      { $set: { "__jsmql.var.now": { $toDate: "$$NOW" } } },
      { $project: { now: "$__jsmql.var.now" } },
      { $unset: "__jsmql" },
    ]);
  });
});

// ── Member / method / index access on let-bound identifiers ───────────────────

describe("let bindings — member / method / index access", () => {
  it("member access on a let folds to a dotted field path", () => {
    expect(jsmql("let user = $.user; $project({ name: user.name })")).toEqual([
      { $set: { "__jsmql.var.user": "$user" } },
      { $project: { name: "$__jsmql.var.user.name" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("nested member access on a let", () => {
    expect(jsmql("let u = $.user; $project({ city: u.address.city })")).toEqual([
      { $set: { "__jsmql.var.u": "$user" } },
      { $project: { city: "$__jsmql.var.u.address.city" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("method call on a let resolves the receiver to its field path", () => {
    expect(jsmql("let name = $.name; $project({ upper: name.toUpperCase() })")).toEqual([
      { $set: { "__jsmql.var.name": "$name" } },
      { $project: { upper: { $toUpper: "$__jsmql.var.name" } } },
      { $unset: "__jsmql" },
    ]);
  });

  it("index access on a let resolves the receiver to its field path", () => {
    // A `let` is never statically typed (it can be reassigned), and `$.items`
    // isn't provable anyway, so `xs[0]` emits the runtime three-way dispatch for
    // an integer key: array position, string character, field named "0".
    expect(jsmql("let xs = $.items; $project({ first: xs[0] })")).toEqual([
      { $set: { "__jsmql.var.xs": "$items" } },
      {
        $project: {
          first: {
            $cond: {
              if: { $isArray: "$__jsmql.var.xs" },
              then: { $arrayElemAt: ["$__jsmql.var.xs", 0] },
              else: {
                $cond: {
                  if: { $eq: [{ $type: "$__jsmql.var.xs" }, "string"] },
                  then: { $substrCP: ["$__jsmql.var.xs", 0, 1] },
                  // The STRING "0" — mongod refuses `field: 0` outright.
                  else: { $getField: { field: "0", input: "$__jsmql.var.xs" } },
                },
              },
            },
          },
        },
      },
      { $unset: "__jsmql" },
    ]);
  });
});

// ── Update op interaction ──────────────────────────────────────────────────────

describe("let bindings — interaction with update ops", () => {
  it("a update op's RHS can read a let from the enclosing pipeline scope", () => {
    expect(jsmql("let big = $.x > 100; $.flag = big; $match($.flag)")).toEqual([
      { $set: { "__jsmql.var.big": { $gt: ["$x", 100] } } },
      { $set: { flag: "$__jsmql.var.big" } },
      { $match: { $expr: truthy("$flag") } },
      { $unset: "__jsmql" },
    ]);
  });

  it("compound update op can use a let on the RHS", () => {
    expect(jsmql("let bump = $.b * 0.1; $.a += bump")).toEqual([
      { $set: { "__jsmql.var.bump": { $multiply: ["$b", 0.1] } } },
      { $set: { a: { $add: ["$a", "$__jsmql.var.bump"] } } },
      { $unset: "__jsmql" },
    ]);
  });

  it("`delete` on a real field doesn't affect let scope", () => {
    expect(jsmql("let keep = $.a; delete $.b; $project({ keep })")).toEqual([
      { $set: { "__jsmql.var.keep": "$a" } },
      { $unset: "b" },
      { $project: { keep: "$__jsmql.var.keep" } },
      { $unset: "__jsmql" },
    ]);
  });
});

// ── Re-declaration across scope boundaries ────────────────────────────────────

describe("let bindings — re-declaration across boundaries", () => {
  it("re-declaring the same name after $group is allowed (scope was cleared)", () => {
    expect(jsmql("let v = $.x; $group({ _id: $.c, sum: $sum($.a) }); let v = $.sum * 2; $project({ v })")).toEqual([
      { $set: { "__jsmql.var.v": "$x" } },
      { $group: { _id: "$c", sum: { $sum: "$a" } } },
      { $set: { "__jsmql.var.v": { $multiply: ["$sum", 2] } } },
      { $project: { v: "$__jsmql.var.v" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("re-declaring after $sort (NOT a reshape stage) is still rejected", () => {
    expect(() => jsmql("let v = $.x; $sort({ x: 1 }); let v = $.y;")).toThrow(
      /`let v` is already declared earlier in this pipeline/,
    );
  });
});

// ── Multi-stage visibility ────────────────────────────────────────────────────

describe("let bindings — multi-stage visibility", () => {
  it("one let is visible in many downstream stages", () => {
    expect(jsmql("let s = $.a + $.b; $match(s > 0); $sort({ x: 1 }); $project({ value: s, doubled: s * 2 })")).toEqual([
      { $set: { "__jsmql.var.s": { $add: ["$a", "$b"] } } },
      { $match: { $expr: { $gt: ["$__jsmql.var.s", 0] } } },
      { $sort: { x: 1 } },
      { $project: { value: "$__jsmql.var.s", doubled: { $multiply: ["$__jsmql.var.s", 2] } } },
      { $unset: "__jsmql" },
    ]);
  });

  it("ten independent lets produce ten $set stages and one trailing $unset", () => {
    // Runtime RHS (`$.f<i>`) so each stays a `$set`; constant RHS would fold.
    const src = Array.from({ length: 10 }, (_, i) => `let v${i} = $.f${i};`).join(" ") + " $match($.a > 0)";
    const result = jsmql(src) as object[];
    expect(result).toHaveLength(12); // 10 $set + 1 $match + 1 $unset
    expect(result[0]).toEqual({ $set: { "__jsmql.var.v0": "$f0" } });
    expect(result[9]).toEqual({ $set: { "__jsmql.var.v9": "$f9" } });
    expect(result[10]).toEqual({ $match: { a: { $gt: 0 } } });
    expect(result[11]).toEqual({ $unset: "__jsmql" });
  });

  it("a let between two real stages is bound in the right place", () => {
    expect(jsmql("$match($.x > 0); let s = $.a + $.b; $sort({ x: 1 }); $project({ s })")).toEqual([
      { $match: { x: { $gt: 0 } } },
      { $set: { "__jsmql.var.s": { $add: ["$a", "$b"] } } },
      { $sort: { x: 1 } },
      { $project: { s: "$__jsmql.var.s" } },
      { $unset: "__jsmql" },
    ]);
  });
});

// ── Lambda interaction nuances ────────────────────────────────────────────────

describe("let bindings — lambda interaction", () => {
  it("a let is visible inside a .map() lambda body and resolves to a field path", () => {
    // Runtime RHS keeps it a `$set` binding (a constant would fold).
    expect(jsmql("let mult = $.rate; $project({ adj: $.items.map(x => x * mult) })")).toEqual([
      { $set: { "__jsmql.var.mult": "$rate" } },
      { $project: { adj: { $map: { input: "$items", as: "x", in: { $multiply: ["$$x", "$__jsmql.var.mult"] } } } } },
      { $unset: "__jsmql" },
    ]);
  });

  it("a let is visible inside .filter() and .reduce() lambdas", () => {
    expect(
      jsmql("let cutoff = $.min; $project({ big: $.scores.filter(s => s > cutoff).reduce((acc, s) => acc + s, 0) })"),
    ).toEqual([
      { $set: { "__jsmql.var.cutoff": "$min" } },
      {
        $project: {
          big: {
            $reduce: {
              input: { $filter: { input: "$scores", as: "s", cond: { $gt: ["$$s", "$__jsmql.var.cutoff"] } } },
              initialValue: 0,
              in: { $add: ["$$value", "$$this"] },
            },
          },
        },
      },
      { $unset: "__jsmql" },
    ]);
  });

  it("a lambda param of the same name shadows the let inside the lambda body only", () => {
    // Runtime RHS keeps it a `$set` binding (a constant would fold).
    expect(jsmql("let i = $.start; $project({ a: $.xs.map(i => i + 1), b: i })")).toEqual([
      { $set: { "__jsmql.var.i": "$start" } },
      { $project: { a: { $map: { input: "$xs", as: "i", in: { $add: ["$$i", 1] } } }, b: "$__jsmql.var.i" } },
      { $unset: "__jsmql" },
    ]);
  });
});

// ── Sub-pipeline depth ────────────────────────────────────────────────────────

describe("let bindings — sub-pipeline depth", () => {
  it("a sub-pipeline let with the same name as an outer let is independent", () => {
    expect(
      jsmql(`[
        let x = $.a,
        $lookup({
          from: "orders",
          pipeline: [
            let x = $.b,
            $match(x > 0)
          ],
          as: "matched"
        }),
        $match(x < 100)
      ]`),
    ).toEqual([
      { $set: { "__jsmql.var.x": "$a" } },
      {
        $lookup: {
          from: "orders",
          pipeline: [
            { $set: { "__jsmql.var.x": "$b" } },
            { $match: { $expr: { $gt: ["$__jsmql.var.x", 0] } } },
            { $unset: "__jsmql" },
          ],
          as: "matched",
        },
      },
      { $match: { $expr: { $lt: ["$__jsmql.var.x", 100] } } },
      { $unset: "__jsmql" },
    ]);
  });

  it("a $facet branch can have its own let — outer lets are not visible inside", () => {
    expect(
      jsmql(`[
        $facet({
          summary: [
            let avg = $avg($.score),
            $project({ avg })
          ]
        })
      ]`),
    ).toEqual([
      {
        $facet: {
          summary: [
            { $set: { "__jsmql.var.avg": { $avg: "$score" } } },
            { $project: { avg: "$__jsmql.var.avg" } },
            { $unset: "__jsmql" },
          ],
        },
      },
    ]);
  });
});

// ── Field-named `let` regression coverage ─────────────────────────────────────

describe("let bindings — `let` is still usable as a field name and operator name", () => {
  it("`$.let` reads a document field literally named `let`", () => {
    expect(jsmql.expr("$.let > 5")).toEqual({ $gt: ["$let", 5] });
  });

  it("`$.user.let` reads a nested field whose final segment is `let`", () => {
    expect(jsmql.expr("$.user.let")).toEqual("$user.let");
  });

  it("`$let(...)` (the MongoDB expression operator) still parses", () => {
    expect(jsmql.expr("$let({ x: 10 }, x => x * 2)")).toEqual({
      $let: { vars: { x: 10 }, in: { $multiply: ["$$x", 2] } },
    });
  });

  it("`{ let: ... }` is a valid object key (e.g. inside $lookup body)", () => {
    expect(jsmql('[$lookup({ from: "x", let: { uid: $._id }, pipeline: [], as: "y" })]')).toEqual([
      { $lookup: { from: "x", let: { uid: "$_id" }, pipeline: [], as: "y" } },
    ]);
  });

  it("the pipeline-level `let` and a deeper $let-operator with same var name coexist", () => {
    // Pipeline let `x` materialises as `__jsmql.var.x`; the MongoDB $let var `x`
    // is a user-variable `$$x` — different namespaces, no collision. (Runtime
    // RHS so the pipeline `let` stays a `$set` binding; a constant would fold.)
    expect(jsmql("let x = $.n; $project({ y: $let({ x: 10 }, x => x * 2), z: x })")).toEqual([
      { $set: { "__jsmql.var.x": "$n" } },
      { $project: { y: { $let: { vars: { x: 10 }, in: { $multiply: ["$$x", 2] } } }, z: "$__jsmql.var.x" } },
      { $unset: "__jsmql" },
    ]);
  });
});

// ── Function-form input ───────────────────────────────────────────────────────

describe("let bindings — function-form input", () => {
  it("block-body arrow with let works the same as the string form", () => {
    const result = jsmql(({ $, $match, $project }) => {
      let x = $.a + 1;
      $match(x > 0);
      $project({ x });
    });
    expect(result).toEqual([
      { $set: { "__jsmql.var.x": { $add: ["$a", 1] } } },
      { $match: { $expr: { $gt: ["$__jsmql.var.x", 0] } } },
      { $project: { x: "$__jsmql.var.x" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("expression-body arrow rejects a top-level let with the precise error", () => {
    // `({ $ }) => let x = 5` would be a single-statement expression body — no
    // pipeline context, so the parser raises the "only valid inside a pipeline"
    // error. (The block-body form above is the way to get pipeline-mode here.)
    expect(() => jsmql(({ $ }) => (eval as any)("let x = 5"))).toThrow(); // any throw is acceptable
  });
});

// ── Stage-clearing matrix (each clearing stage) ───────────────────────────────

describe("let bindings — all reshape-clearing stages drop the scope", () => {
  it("$bucketAuto clears the let scope", () => {
    expect(() => jsmql("let v = $.x; $bucketAuto({ groupBy: $.y, buckets: 4 }); $match(v > 0)")).toThrow(
      /`v` is a `let` binding and can't be read after `\$bucketAuto`/,
    );
  });

  it("the stage body itself can still read the let — only later stages cannot", () => {
    // $group is the canonical reshape stage; its body runs *with* the scope
    // intact (so accumulators can reference the let), and only the *next*
    // stage sees the cleared scope.
    expect(jsmql("let weighted = $.x * $.weight; $group({ _id: $.cat, total: $sum(weighted) })")).toEqual([
      { $set: { "__jsmql.var.weighted": { $multiply: ["$x", "$weight"] } } },
      { $group: { _id: "$cat", total: { $sum: "$__jsmql.var.weighted" } } },
    ]);
  });
});

// ── $project subtlety (NOT a reshape-clearing stage) ──────────────────────────

describe("let bindings — $project keeps the let scope (documented trade-off)", () => {
  it("a let stays visible after $project even if inclusion mode drops __jsmql at runtime", () => {
    // The compiler does not statically prevent this — it's documented in
    // LANGUAGE.md as a footgun parallel to today's `$.tmp = ...` + `delete`
    // pattern. The point of the test is to lock in the *compile-time*
    // behaviour: scope is preserved, no error is raised, codegen produces
    // a reference to `$__jsmql.var.x` even though the user's pipeline will see
    // null at runtime if their cluster runs it. The user is responsible for
    // putting inclusion-mode $projects last.
    expect(jsmql("let x = $.a; $project({ x: 1 }); $match(x > 0)")).toEqual([
      { $set: { "__jsmql.var.x": "$a" } },
      { $project: { x: 1 } },
      { $match: { $expr: { $gt: ["$__jsmql.var.x", 0] } } },
      { $unset: "__jsmql" },
    ]);
  });
});

// ── `let` reassignment (DEF-009) ──────────────────────────────────────────────

describe("let bindings — reassignment", () => {
  it("reassigning a `let` re-`$set`s its materialised slot", () => {
    // The second statement reads the binding's current value and writes back to
    // the same `__jsmql.var.<name>` slot — exactly how `let x = 1; x = x + 1` reads
    // in JavaScript.
    expect(
      jsmql(`
        let basePrice = $.price * $.qty;
        basePrice = basePrice * 0.9;
        $project({ total: basePrice });
      `),
    ).toEqual([
      { $set: { "__jsmql.var.basePrice": { $multiply: ["$price", "$qty"] } } },
      { $set: { "__jsmql.var.basePrice": { $multiply: ["$__jsmql.var.basePrice", 0.9] } } },
      { $project: { total: "$__jsmql.var.basePrice" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("compound assignment and increment desugar against the slot", () => {
    expect(jsmql("let n = $.start; n += 5; $project({ n })")).toEqual([
      { $set: { "__jsmql.var.n": "$start" } },
      { $set: { "__jsmql.var.n": { $add: ["$__jsmql.var.n", 5] } } },
      { $project: { n: "$__jsmql.var.n" } },
      { $unset: "__jsmql" },
    ]);
    expect(jsmql("let n = $.start; n++; $project({ n })")).toEqual([
      { $set: { "__jsmql.var.n": "$start" } },
      { $set: { "__jsmql.var.n": { $add: ["$__jsmql.var.n", 1] } } },
      { $project: { n: "$__jsmql.var.n" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("reassignment works in the bracketed pipeline form", () => {
    expect(jsmql("[ let x = $.a, x = x + 1, $project({ x }) ]")).toEqual([
      { $set: { "__jsmql.var.x": "$a" } },
      { $set: { "__jsmql.var.x": { $add: ["$__jsmql.var.x", 1] } } },
      { $project: { x: "$__jsmql.var.x" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("reassigning a `const`-bound name throws a `const` error", () => {
    expect(() => jsmql("const x = $.foo; x = 5; $project({ x });")).toThrow(
      /Cannot reassign `x` — it is a `const` binding\. Declare it with `let x = …`/,
    );
  });

  it("assigning to an undeclared bare identifier throws an actionable error", () => {
    expect(() => jsmql("$match($.a > 0); zzz = 5; $project({ a: 1 });")).toThrow(
      /Cannot assign to bare identifier 'zzz' — it isn't a `let` binding in scope/,
    );
  });

  it("reassigning a `let` after a reshape stage drops it (precise error)", () => {
    expect(() => jsmql("let v = $.x; $group({ _id: $.cat }); v = 5; $match(v > 0)")).toThrow(
      /`v` is a `let` binding and can't be reassigned after `\$group`/,
    );
  });

  it("a bare-identifier assignment outside a pipeline is rejected (no let scope)", () => {
    const result = jsmql.validate("x = 5");
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/Cannot assign to bare identifier 'x'/);
    expect(result.errors[0].pos).toBeGreaterThanOrEqual(0);
  });
});

// ── `Object.assign(binding, …)` — JS's mutating merge on a binding ─────────────

describe("let bindings — Object.assign mutation", () => {
  it("`Object.assign(result, …)` re-`$set`s the binding's slot via $mergeObjects", () => {
    // The JS-faithful mutating form of `result = { ...result, … }`.
    expect(jsmql("let result = {}; Object.assign(result, { a: $.foo }); $ = result;")).toEqual([
      { $set: { "__jsmql.var.result": {} } },
      { $set: { "__jsmql.var.result": { $mergeObjects: ["$__jsmql.var.result", { a: "$foo" }] } } },
      { $replaceWith: "$__jsmql.var.result" },
    ]);
  });

  it("allowed on a `const` binding — mutating a const-bound object is legal JS (only rebinding isn't)", () => {
    // This is the reported bug: `const result = {}; Object.assign(result, …)`
    // must NOT throw, even though `result = …` on a const would.
    expect(jsmql("const result = {}; Object.assign(result, { a: $.foo });")).toEqual([
      { $set: { "__jsmql.var.result": {} } },
      { $set: { "__jsmql.var.result": { $mergeObjects: ["$__jsmql.var.result", { a: "$foo" }] } } },
      { $unset: "__jsmql" },
    ]);
  });

  it("multiple sources keep the slot as the first $mergeObjects operand", () => {
    expect(jsmql("let r = {}; Object.assign(r, { a: 1 }, { b: 2 }); $ = r;")).toEqual([
      { $set: { "__jsmql.var.r": {} } },
      { $set: { "__jsmql.var.r": { $mergeObjects: ["$__jsmql.var.r", { a: 1 }, { b: 2 }] } } },
      { $replaceWith: "$__jsmql.var.r" },
    ]);
  });

  it("works in the bracketed pipeline form", () => {
    expect(jsmql("[ let r = {}, Object.assign(r, { a: $.foo }), $ = r ]")).toEqual([
      { $set: { "__jsmql.var.r": {} } },
      { $set: { "__jsmql.var.r": { $mergeObjects: ["$__jsmql.var.r", { a: "$foo" }] } } },
      { $replaceWith: "$__jsmql.var.r" },
    ]);
  });

  it("Object.assign on an out-of-scope identifier throws an actionable error with a meaningful .pos", () => {
    const result = jsmql.validate("Object.assign(zzz, { a: 1 });");
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/'zzz' isn't a 'let'\/'const' binding in scope/);
    expect(result.errors[0].pos).toBeGreaterThanOrEqual(0);
  });
});

// ── `const` keyword (DEF-009) ─────────────────────────────────────────────────

describe("let bindings — `const` is a read-only alias for `let`", () => {
  it("`const` lowers identically to `let` for declaration + read", () => {
    // Declaration and reads are identical; only reassignment differs.
    const fromConst = jsmql("const x = $.foo; $match($.parent === x);");
    const fromLet = jsmql("let x = $.foo; $match($.parent === x);");
    expect(fromConst).toEqual(fromLet);
    expect(fromConst).toEqual([
      { $set: { "__jsmql.var.x": "$foo" } },
      { $match: { $expr: { $eq: ["$parent", "$__jsmql.var.x"] } } },
      { $unset: "__jsmql" },
    ]);
  });

  it("`const` works in the bracketed pipeline form", () => {
    expect(jsmql("[ const x = $.foo, $match($.parent === x) ]")).toEqual([
      { $set: { "__jsmql.var.x": "$foo" } },
      { $match: { $expr: { $eq: ["$parent", "$__jsmql.var.x"] } } },
      { $unset: "__jsmql" },
    ]);
  });

  it("parser errors echo the `const` keyword the user actually wrote", () => {
    expect(() => jsmql("const = 5;")).toThrow(/Expected an identifier after `const`/);
    expect(() => jsmql("const x 5;")).toThrow(/Expected '=' after `const x`.*`const` requires an initialiser/s);
  });

  it("`const` is still usable as a field name and object key", () => {
    // Adding the keyword token must not regress `const` as a plain identifier in
    // field paths / object keys (it's a valid JS property name).
    expect(jsmql.expr("$.const > 5")).toEqual({ $gt: ["$const", 5] });
    expect(jsmql.expr("$.user.const")).toEqual("$user.const");
    expect(jsmql("$project({ const: 1 }); $match($.x > 1);")).toEqual([
      { $project: { const: 1 } },
      { $match: { x: { $gt: 1 } } },
    ]);
  });
});
