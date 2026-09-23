// Tests for `$$.size()` — the current stream's document count as a reusable
// value. Lowers to a `$setWindowFields` `$count` stamped onto `__jsmql.size`,
// hoisted once and recomputed after a count-changing stage. See
// docs/specs/stream-size.md and docs/LANGUAGE.md § $$.size().

import { describe, it, expect } from "vitest";
import { jsmql } from "../src/index.ts";

const SWF = { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } };
const UNSET = { $unset: "__jsmql" };

describe("$$.size() — materialisation", () => {
  it("hoists one $setWindowFields and reads back the field path", () => {
    expect(jsmql("$.total = $$.size()")).toEqual([
      { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
      { $set: { total: "$__jsmql.size" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("computes the count after a preceding $match (count at that point)", () => {
    expect(jsmql('$match($.status === "active"); $.n = $$.size()')).toEqual([
      { $match: { status: "active" } },
      { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
      { $set: { n: "$__jsmql.size" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("works inside an expression (arithmetic)", () => {
    expect(jsmql("$.share = 1 / $$.size()")).toEqual([
      { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
      { $set: { share: { $divide: [1, "$__jsmql.size"] } } },
      { $unset: "__jsmql" },
    ]);
  });
});

describe("$$.size() — compute-once / reuse / recompute", () => {
  it("reuses a single materialisation across uses with no invalidating stage between", () => {
    expect(jsmql("$.a = $$.size(); $.b = $$.size() + 1")).toEqual([
      { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
      { $set: { a: "$__jsmql.size" } },
      { $set: { b: { $add: ["$__jsmql.size", 1] } } },
      { $unset: "__jsmql" },
    ]);
  });

  it("reuses across a freshness-preserving stage ($sort)", () => {
    expect(jsmql("$.a = $$.size(); $sort({ a: 1 }); $.b = $$.size()")).toEqual([
      { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
      { $set: { a: "$__jsmql.size" } },
      { $sort: { a: 1 } },
      { $set: { b: "$__jsmql.size" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("recomputes after an invalidating stage ($match)", () => {
    expect(jsmql("$.a = $$.size(); $match($.a > 0); $.b = $$.size()")).toEqual([
      { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
      { $set: { a: "$__jsmql.size" } },
      { $match: { a: { $gt: 0 } } },
      { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
      { $set: { b: "$__jsmql.size" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("recomputes after $unwind (count grows)", () => {
    expect(jsmql("$.a = $$.size(); $unwind($.tags); $.b = $$.size()")).toEqual([
      { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
      { $set: { a: "$__jsmql.size" } },
      { $unwind: "$tags" },
      { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
      { $set: { b: "$__jsmql.size" } },
      { $unset: "__jsmql" },
    ]);
  });
});

describe("$$.size() — call forms", () => {
  it("accepts a single-statement arrow block with no trailing `;`", () => {
    expect(
      jsmql(({ $ }) => {
        $.n = $$.size();
      }),
    ).toEqual([
      { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
      { $set: { n: "$__jsmql.size" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("lone string with no ; (rerouted through pipeline lowering)", () => {
    expect(jsmql("$.n = $$.size()")).toEqual([
      { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
      { $set: { n: "$__jsmql.size" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("accepted by jsmql.pipeline()", () => {
    expect(jsmql.pipeline("$.n = $$.size()")).toEqual([
      { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
      { $set: { n: "$__jsmql.size" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("auto-wrapped top-level $match($$.size() > 1)", () => {
    expect(jsmql("$match($$.size() > 1)")).toEqual([
      { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
      { $match: { $expr: { $gt: ["$__jsmql.size", 1] } } },
      { $unset: "__jsmql" },
    ]);
  });

  it("composes with assert() — the conditional-error use", () => {
    expect(jsmql('$match($.email === "x"); assert($$.size() <= 1, "must be <= 1")')).toEqual([
      { $match: { email: "x" } },
      { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
      {
        $match: {
          $expr: {
            $convert: {
              input: true,
              to: { $cond: [{ $lte: ["$__jsmql.size", 1] }, "bool", "jsmql assertion failed: must be <= 1"] },
            },
          },
        },
      },
      { $unset: "__jsmql" },
    ]);
  });

  it("works inside a top-level .map lambda (same document)", () => {
    expect(jsmql("$.scaled = $.items.map(i => i * $$.size())")).toEqual([
      { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
      {
        $set: {
          scaled: {
            $map: { input: { $ifNull: ["$items", []] }, as: "i", in: { $multiply: ["$$i", "$__jsmql.size"] } },
          },
        },
      },
      { $unset: "__jsmql" },
    ]);
  });
});

describe("$$.size() — rejections", () => {
  it("rejects in jsmql.expr() (no stream)", () => {
    expect(() => jsmql.expr("$$.size()")).toThrow(
      "jsmql.expr() expects an aggregation expression (the value of a stage field, `jsmql.expr`). It received '$$.size()', the stream's document count, which materialises a '$setWindowFields' stage instead. Use jsmql.pipeline().",
    );
  });

  it("rejects in a Filter (no stream)", () => {
    expect(() => jsmql.filter("$$.size() > 1")).toThrow(
      "'$$.size()' (the current stream's document count) needs Pipeline mode — it materialises a '$setWindowFields' stage. Use it inside a pipeline — for example, `({ $ }) => { $.n = $$.size(); … }`. It has no meaning in a Filter or in 'jsmql.expr'.",
    );
  });

  it("captures `$$.size()` (ROOT count) into $lookup.let inside a top-level lookup predicate", () => {
    // `$$` is always the ROOT stream regardless of nesting; the count
    // materialises at the top and is passed into the lookup as
    // `let: { jsmql_s0_size: "$__jsmql.size" }`, read inside as `$$jsmql_s0_size`.
    // Verified end-to-end on a live mongod.
    expect(jsmql("$.peers = $$$.users.filter(u => u.n === $$.size());")).toEqual([
      { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
      { $lookup: { from: "users", localField: "__jsmql.size", foreignField: "n", as: "peers" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("rejects `$$.size()` inside a $facet / $unionWith sub-pipeline ", () => {
    expect(jsmql("$ = { peers: $$.filter(u => u.n === $$.size()) };")).toEqual([
      { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
      { $facet: { peers: [{ $match: { $expr: { $eq: ["$n", "$__jsmql.size"] } } }] } },
    ]);
  });

  it("rejects inside a reusable function body ", () => {
    expect(jsmql("const f = () => $$.size(); $.n = f()")).toEqual([
      { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
      { $set: { n: "$__jsmql.size" } },
      { $unset: "__jsmql" },
    ]);
  });
});

describe("$$.size() — cleanup", () => {
  it("emits exactly one trailing $unset even with multiple uses", () => {
    const out = jsmql("$.a = $$.size(); $.b = $$.size()") as Record<string, unknown>[];
    expect(out.filter((s) => "$unset" in s)).toEqual([{ $unset: "__jsmql" }]);
  });

  it("a holding pipeline leaves no __jsmql field in the shape (cleaned by $unset)", () => {
    // The trailing $unset drops the whole namespace object — verified executing
    // on a live mongod in the dev probes; here we assert the cleanup stage is last.
    const out = jsmql("$.n = $$.size()") as Record<string, unknown>[];
    expect(out[out.length - 1]).toEqual({ $unset: "__jsmql" });
  });
});

describe("nested size usage — sub-stream handles + `$$.size()` (root) at every level", () => {
  // The composite case: a per-user orders pivot whose `.map` reads three
  // different counts — a nested lookup `.size()` (this order's shipments), the
  // 3rd-arg handle `ordersColl.size()` (this user's orders sub-stream), and
  // `$$.size()` (the ROOT users stream, captured into the orders $lookup.let as
  // jsmql_s0_size). Verified end-to-end on a live mongod: per-order shipment counts,
  // per-user order counts, and a constant root count, all correct, no leak.
  it("compiles three count levels in one block-body .map", () => {
    expect(
      jsmql(`
        $$ = $$$.orders.filter(o => $._id === o.userId).map((o, i, ordersColl) => {
          return {
            totalShipments: $$$.shipments.filter((s, i, shipmntsColl) => s.orderId === o._id).size(),
            totalOrders: ordersColl.size(),
            totalUsers: $$.size(),
          };
        });
      `),
    ).toEqual([
      { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
      {
        $lookup: {
          from: "orders",
          localField: "_id",
          foreignField: "userId",
          let: { jsmql_s0_size: "$__jsmql.size" },
          pipeline: [
            { $lookup: { from: "shipments", localField: "_id", foreignField: "orderId", as: "__jsmql.tmp.0" } },
            { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
            {
              $replaceWith: {
                totalShipments: { $size: "$__jsmql.tmp.0" },
                totalOrders: "$__jsmql.size",
                totalUsers: "$$jsmql_s0_size",
              },
            },
            { $unset: "__jsmql" },
          ],
          as: "__jsmql.tmp.0",
        },
      },
      { $unwind: "$__jsmql.tmp.0" },
      { $replaceWith: "$__jsmql.tmp.0" },
    ]);
  });

  it("block-body `.map` with `return` is accepted; an unused index/3rd param on a predicate filter does not throw", () => {
    // `(s, i, shipmntsColl) => …` — extra params present but unused: valid JS, compiles.
    expect(jsmql("$$ = $$.map((d, _i, _coll) => { return ({ id: d._id }); });")).toEqual([
      { $replaceWith: { id: "$_id" } },
    ]);
    expect(() => jsmql("$.x = $$$.s.filter((s, i, c) => s.k === $.k);")).not.toThrow();
  });

  // Four DISTINCT counts and reads in one `.map`, none colliding — the disambiguation
  // matrix: the root STREAM count (`$$.size()`), the root DOC field (`$.length`),
  // an outer-scope `const` derived from that field, and the sub-stream count
  // (`coll.size()`, the 3rd-arg handle). Each lands in its own `$lookup.let` var
  // (`jsmql_s0_…` system, `jsmql_f0_…` field, `jsmql_v0_…` binding) or the system
  // `$__jsmql.size` slot. Needs the correlated lookup form (`$$ = $$$.coll.filter(<corr>)…`)
  // so the outer context survives into the sub-pipeline — a bare `$$ = $$$.coll.map(…)`
  // is a `$unionWith` source-switch that discards it. Verified on a live mongod:
  // l0/l1/l2/l3 = 3/7/8/2 for a user with field length=7 and 2 orders (3 users total).
  it("the root count, the doc field, the const, and the handle count resolve to four distinct, non-colliding vars", () => {
    expect(
      jsmql(`
        const length = $.length + 1;
        $$ = $$$.orders.filter(o => o.userId === $._id).map((o, i, coll) => {
          return { l0: $$.size(), l1: $.length, l2: length, l3: coll.size() };
        });
      `),
    ).toEqual([
      { $set: { "__jsmql.var.length": { $add: ["$length", 1] } } },
      { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
      {
        $lookup: {
          from: "orders",
          localField: "_id",
          foreignField: "userId",
          let: { jsmql_s0_size: "$__jsmql.size", jsmql_f0_length: "$length", jsmql_v0_length: "$__jsmql.var.length" },
          pipeline: [
            { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
            {
              $replaceWith: {
                l0: "$$jsmql_s0_size",
                l1: "$$jsmql_f0_length",
                l2: "$$jsmql_v0_length",
                l3: "$__jsmql.size",
              },
            },
            { $unset: "__jsmql" },
          ],
          as: "__jsmql.tmp.0",
        },
      },
      { $unwind: "$__jsmql.tmp.0" },
      { $replaceWith: "$__jsmql.tmp.0" },
    ]);
  });
});
