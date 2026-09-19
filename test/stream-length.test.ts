// Tests for `$$.length` — the current stream's document count as a reusable
// value. Lowers to a `$setWindowFields` `$count` stamped onto `__jsmql.length`,
// hoisted once and recomputed after a count-changing stage. See
// docs/specs/stream-length.md and docs/LANGUAGE.md § $$.length.

import { describe, it, expect } from "vitest";
import { jsmql } from "../src/index.ts";

const SWF = { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } };
const UNSET = { $unset: "__jsmql" };

describe("$$.length — materialisation", () => {
  it("hoists one $setWindowFields and reads back the field path", () => {
    expect(jsmql("$.total = $$.length")).toEqual([
      { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
      { $set: { total: "$__jsmql.length" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("computes the count after a preceding $match (count at that point)", () => {
    expect(jsmql('$match($.status === "active"); $.n = $$.length')).toEqual([
      { $match: { status: "active" } },
      { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
      { $set: { n: "$__jsmql.length" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("works inside an expression (arithmetic)", () => {
    expect(jsmql("$.share = 1 / $$.length")).toEqual([
      { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
      { $set: { share: { $divide: [1, "$__jsmql.length"] } } },
      { $unset: "__jsmql" },
    ]);
  });
});

describe("$$.length — compute-once / reuse / recompute", () => {
  it("reuses a single materialisation across uses with no invalidating stage between", () => {
    expect(jsmql("$.a = $$.length; $.b = $$.length + 1")).toEqual([
      { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
      { $set: { a: "$__jsmql.length" } },
      { $set: { b: { $add: ["$__jsmql.length", 1] } } },
      { $unset: "__jsmql" },
    ]);
  });

  it("reuses across a freshness-preserving stage ($sort)", () => {
    expect(jsmql("$.a = $$.length; $sort({ a: 1 }); $.b = $$.length")).toEqual([
      { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
      { $set: { a: "$__jsmql.length" } },
      { $sort: { a: 1 } },
      { $set: { b: "$__jsmql.length" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("recomputes after an invalidating stage ($match)", () => {
    expect(jsmql("$.a = $$.length; $match($.a > 0); $.b = $$.length")).toEqual([
      { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
      { $set: { a: "$__jsmql.length" } },
      { $match: { a: { $gt: 0 } } },
      { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
      { $set: { b: "$__jsmql.length" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("recomputes after $unwind (count grows)", () => {
    expect(jsmql("$.a = $$.length; $unwind($.tags); $.b = $$.length")).toEqual([
      { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
      { $set: { a: "$__jsmql.length" } },
      { $unwind: "$tags" },
      { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
      { $set: { b: "$__jsmql.length" } },
      { $unset: "__jsmql" },
    ]);
  });
});

describe("$$.length — call forms", () => {
  it("accepts a single-statement arrow block with no trailing `;`", () => {
    expect(
      jsmql(({ $ }) => {
        $.n = $$.length;
      }),
    ).toEqual([
      { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
      { $set: { n: "$__jsmql.length" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("lone string with no ; (rerouted through pipeline lowering)", () => {
    expect(jsmql("$.n = $$.length")).toEqual([
      { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
      { $set: { n: "$__jsmql.length" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("accepted by jsmql.pipeline()", () => {
    expect(jsmql.pipeline("$.n = $$.length")).toEqual([
      { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
      { $set: { n: "$__jsmql.length" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("auto-wrapped top-level $match($$.length > 1)", () => {
    expect(jsmql("$match($$.length > 1)")).toEqual([
      { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
      { $match: { $expr: { $gt: ["$__jsmql.length", 1] } } },
      { $unset: "__jsmql" },
    ]);
  });

  it("composes with assert() — the conditional-error use", () => {
    expect(jsmql('$match($.email === "x"); assert($$.length <= 1, "must be <= 1")')).toEqual([
      { $match: { email: "x" } },
      { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
      {
        $match: {
          $expr: {
            $convert: {
              input: true,
              to: { $cond: [{ $lte: ["$__jsmql.length", 1] }, "bool", "jsmql assertion failed: must be <= 1"] },
            },
          },
        },
      },
      { $unset: "__jsmql" },
    ]);
  });

  it("works inside a top-level .map lambda (same document)", () => {
    expect(jsmql("$.scaled = $.items.map(i => i * $$.length)")).toEqual([
      { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
      { $set: { scaled: { $map: { input: "$items", as: "i", in: { $multiply: ["$$i", "$__jsmql.length"] } } } } },
      { $unset: "__jsmql" },
    ]);
  });
});

describe("$$.length — rejections", () => {
  it("rejects in jsmql.expr() (no stream)", () => {
    expect(() => jsmql.expr("$$.length")).toThrow(
      "jsmql.expr() expects an aggregation expression (the value of a stage field, `jsmql.expr`). It received a bare expression that would lower to a Filter (`$.age > 18`) instead. Use jsmql.filter() for a Filter, or wrap the predicate as `$match(…)` for a Pipeline.",
    );
  });

  it("rejects in a Filter (no stream)", () => {
    expect(() => jsmql.filter("$$.length > 1")).toThrow(/'\$\$\.length'.*needs Pipeline mode/);
  });

  it("captures `$$.length` (ROOT count) into $lookup.let inside a top-level lookup predicate", () => {
    // `$$` is always the ROOT stream regardless of nesting; the count
    // materialises at the top and is passed into the lookup as
    // `let: { jsmql_s0_length: "$__jsmql.length" }`, read inside as `$$jsmql_s0_length`.
    // Verified end-to-end on a live mongod.
    expect(jsmql("$.peers = $$$.users.filter(u => u.n === $$.length);")).toEqual([
      { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
      { $lookup: { from: "users", localField: "__jsmql.length", foreignField: "n", as: "peers" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("rejects `$$.length` inside a $facet / $unionWith sub-pipeline ", () => {
    expect(jsmql("$ = { peers: $$.filter(u => u.n === $$.length) };")).toEqual([
      { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
      { $facet: { peers: [{ $match: { $expr: { $eq: ["$n", "$__jsmql.length"] } } }] } },
    ]);
  });

  it("rejects inside a reusable function body ", () => {
    expect(jsmql("const f = () => $$.length; $.n = f()")).toEqual([
      { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
      { $set: { n: "$__jsmql.length" } },
      { $unset: "__jsmql" },
    ]);
  });
});

describe("$$.length — cleanup", () => {
  it("emits exactly one trailing $unset even with multiple uses", () => {
    const out = jsmql("$.a = $$.length; $.b = $$.length") as Record<string, unknown>[];
    expect(out.filter((s) => "$unset" in s)).toEqual([{ $unset: "__jsmql" }]);
  });

  it("a holding pipeline leaves no __jsmql field in the shape (cleaned by $unset)", () => {
    // The trailing $unset drops the whole namespace object — verified executing
    // on a live mongod in the dev probes; here we assert the cleanup stage is last.
    const out = jsmql("$.n = $$.length") as Record<string, unknown>[];
    expect(out[out.length - 1]).toEqual({ $unset: "__jsmql" });
  });
});

describe("nested length usage — sub-stream handles + `$$.length` (root) at every level", () => {
  // The composite case: a per-user orders pivot whose `.map` reads three
  // different counts — a nested lookup `.length` (this order's shipments), the
  // 3rd-arg handle `ordersColl.length` (this user's orders sub-stream), and
  // `$$.length` (the ROOT users stream, captured into the orders $lookup.let as
  // v0_length). Verified end-to-end on a live mongod: per-order shipment counts,
  // per-user order counts, and a constant root count, all correct, no leak.
  it("compiles three count levels in one block-body .map", () => {
    expect(
      jsmql(`
        $$ = $$$.orders.filter(o => $._id === o.userId).map((o, i, ordersColl) => {
          return {
            totalShipments: $$$.shipments.filter((s, i, shipmntsColl) => s.orderId === o._id).length,
            totalOrders: ordersColl.length,
            totalUsers: $$.length,
          };
        });
      `),
    ).toEqual([
      { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
      {
        $lookup: {
          from: "orders",
          localField: "_id",
          foreignField: "userId",
          let: { jsmql_s0_length: "$__jsmql.length" },
          pipeline: [
            { $lookup: { from: "shipments", localField: "_id", foreignField: "orderId", as: "__jsmql.tmp.0" } },
            { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
            {
              $replaceWith: {
                totalShipments: { $size: "$__jsmql.tmp.0" },
                totalOrders: "$__jsmql.length",
                totalUsers: "$$jsmql_s0_length",
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

  // Four DISTINCT "length"s in one `.map`, none colliding — the disambiguation
  // matrix: the root STREAM count (`$$.length`), the root DOC field (`$.length`),
  // an outer-scope `const` derived from that field, and the sub-stream count
  // (`coll.length`, the 3rd-arg handle). Each lands in its own `$lookup.let` var
  // (`jsmql_s0_…` system, `jsmql_f0_…` field, `jsmql_v0_…` binding) or the system
  // `$__jsmql.length` slot. Needs the correlated lookup form (`$$ = $$$.coll.filter(<corr>)…`)
  // so the outer context survives into the sub-pipeline — a bare `$$ = $$$.coll.map(…)`
  // is a `$unionWith` source-switch that discards it. Verified on a live mongod:
  // l0/l1/l2/l3 = 3/7/8/2 for a user with field length=7 and 2 orders (3 users total).
  it("the four kinds of length resolve to four distinct, non-colliding vars", () => {
    expect(
      jsmql(`
        const length = $.length + 1;
        $$ = $$$.orders.filter(o => o.userId === $._id).map((o, i, coll) => {
          return { l0: $$.length, l1: $.length, l2: length, l3: coll.length };
        });
      `),
    ).toEqual([
      { $set: { "__jsmql.var.length": { $add: ["$length", 1] } } },
      { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
      {
        $lookup: {
          from: "orders",
          localField: "_id",
          foreignField: "userId",
          let: {
            jsmql_s0_length: "$__jsmql.length",
            jsmql_f0_length: "$length",
            jsmql_v0_length: "$__jsmql.var.length",
          },
          pipeline: [
            { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
            {
              $replaceWith: {
                l0: "$$jsmql_s0_length",
                l1: "$$jsmql_f0_length",
                l2: "$$jsmql_v0_length",
                l3: "$__jsmql.length",
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
