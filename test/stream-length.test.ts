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
    expect(jsmql("$.total = $$.length")).toEqual([SWF, { $set: { total: "$__jsmql.length" } }, UNSET]);
  });

  it("computes the count after a preceding $match (count at that point)", () => {
    expect(jsmql('$match($.status === "active"); $.n = $$.length')).toEqual([
      { $match: { status: "active" } },
      SWF,
      { $set: { n: "$__jsmql.length" } },
      UNSET,
    ]);
  });

  it("works inside an expression (arithmetic)", () => {
    expect(jsmql("$.share = 1 / $$.length")).toEqual([
      SWF,
      { $set: { share: { $divide: [1, "$__jsmql.length"] } } },
      UNSET,
    ]);
  });
});

describe("$$.length — compute-once / reuse / recompute", () => {
  it("reuses a single materialisation across uses with no invalidating stage between", () => {
    expect(jsmql("$.a = $$.length; $.b = $$.length + 1")).toEqual([
      SWF,
      { $set: { a: "$__jsmql.length" } },
      { $set: { b: { $add: ["$__jsmql.length", 1] } } },
      UNSET,
    ]);
  });

  it("reuses across a freshness-preserving stage ($sort)", () => {
    expect(jsmql("$.a = $$.length; $sort({ a: 1 }); $.b = $$.length")).toEqual([
      SWF,
      { $set: { a: "$__jsmql.length" } },
      { $sort: { a: 1 } },
      { $set: { b: "$__jsmql.length" } },
      UNSET,
    ]);
  });

  it("recomputes after an invalidating stage ($match)", () => {
    expect(jsmql("$.a = $$.length; $match($.a > 0); $.b = $$.length")).toEqual([
      SWF,
      { $set: { a: "$__jsmql.length" } },
      { $match: { a: { $gt: 0 } } },
      SWF,
      { $set: { b: "$__jsmql.length" } },
      UNSET,
    ]);
  });

  it("recomputes after $unwind (count grows)", () => {
    expect(jsmql("$.a = $$.length; $unwind($.tags); $.b = $$.length")).toEqual([
      SWF,
      { $set: { a: "$__jsmql.length" } },
      { $unwind: "$tags" },
      SWF,
      { $set: { b: "$__jsmql.length" } },
      UNSET,
    ]);
  });
});

describe("$$.length — call forms", () => {
  it("single-statement arrow block (no trailing ;)", () => {
    expect(
      jsmql(($) => {
        $.n = $$.length;
      }),
    ).toEqual([SWF, { $set: { n: "$__jsmql.length" } }, UNSET]);
  });

  it("lone string with no ; (rerouted through pipeline lowering)", () => {
    expect(jsmql("$.n = $$.length")).toEqual([SWF, { $set: { n: "$__jsmql.length" } }, UNSET]);
  });

  it("accepted by jsmql.pipeline()", () => {
    expect(jsmql.pipeline("$.n = $$.length")).toEqual([SWF, { $set: { n: "$__jsmql.length" } }, UNSET]);
  });

  it("auto-wrapped top-level $match($$.length > 1)", () => {
    expect(jsmql("$match($$.length > 1)")).toEqual([
      SWF,
      { $match: { $expr: { $gt: ["$__jsmql.length", 1] } } },
      UNSET,
    ]);
  });

  it("composes with assert() — the conditional-error use", () => {
    expect(jsmql('$match($.email === "x"); assert($$.length <= 1, "must be <= 1")')).toEqual([
      { $match: { email: "x" } },
      SWF,
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
      UNSET,
    ]);
  });

  it("works inside a top-level .map lambda (same document)", () => {
    expect(jsmql("$.scaled = $.items.map(i => i * $$.length)")).toEqual([
      SWF,
      { $set: { scaled: { $map: { input: "$items", as: "i", in: { $multiply: ["$$i", "$__jsmql.length"] } } } } },
      UNSET,
    ]);
  });
});

describe("$$.length — rejections", () => {
  it("rejects in jsmql.expr() (no stream)", () => {
    expect(() => jsmql.expr("$$.length")).toThrow(/'\$\$\.length'.*needs Pipeline mode/);
  });

  it("rejects in a Filter (no stream)", () => {
    expect(() => jsmql.filter("$$.length > 1")).toThrow(/'\$\$\.length'.*needs Pipeline mode/);
  });

  it("rejects inside a $lookup sub-pipeline predicate [DEF-033]", () => {
    expect(() => jsmql("$.peers = $$$.users.filter(u => u.n === $$.length)")).toThrow(
      /'\$\$\.length' isn't supported inside a '\$lookup' \/ '\$facet' \/ '\$unionWith' sub-pipeline yet \[DEF-033\]/,
    );
  });

  it("rejects inside a reusable function body [DEF-033]", () => {
    expect(() => jsmql("const f = () => $$.length; $.n = f()")).toThrow(
      /'\$\$\.length' isn't supported inside a reusable function body yet \[DEF-033\]/,
    );
  });
});

describe("$$.length — cleanup", () => {
  it("emits exactly one trailing $unset even with multiple uses", () => {
    const out = jsmql("$.a = $$.length; $.b = $$.length") as Record<string, unknown>[];
    expect(out.filter((s) => "$unset" in s)).toEqual([UNSET]);
  });

  it("a holding pipeline leaves no __jsmql field in the shape (cleaned by $unset)", () => {
    // The trailing $unset drops the whole namespace object — verified executing
    // on a live mongod in the dev probes; here we assert the cleanup stage is last.
    const out = jsmql("$.n = $$.length") as Record<string, unknown>[];
    expect(out[out.length - 1]).toEqual(UNSET);
  });
});
