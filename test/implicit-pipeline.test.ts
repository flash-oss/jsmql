import { describe, it, expect } from "vitest";
import { mjsql, validate } from "../src/index.ts";

// `;` at top level is the implicit pipeline-stage separator. Each `;`-separated
// chunk becomes its own stage(s) with no cross-coalescing — in contrast to the
// explicit `[…]` form, where adjacent mutation elements coalesce. `,` remains
// the in-stage separator and keeps its existing coalescing behaviour.

describe("implicit pipeline — `;` triggers pipeline mode", () => {
  it("single trailing `;` after assignment wraps as a one-stage pipeline", () => {
    expect(mjsql("$.a = 1;")).toEqual([{ $set: { a: 1 } }]);
  });

  it("single trailing `;` after a stage call wraps as a one-stage pipeline", () => {
    expect(mjsql("$match($.a == 0);")).toEqual([{ $match: { $expr: { $eq: ["$a", 0] } } }]);
  });

  it("single trailing `;` after a stage-object wraps as a one-stage pipeline", () => {
    expect(mjsql("({ $limit: 10 });")).toEqual([{ $limit: 10 }]);
  });

  it("two `;`-separated assignments produce two separate $set stages (no coalesce)", () => {
    expect(mjsql("$.a = 1; $.b = 2")).toEqual([{ $set: { a: 1 } }, { $set: { b: 2 } }]);
  });

  it("two `;`-separated deletes produce two separate $unset stages (no coalesce)", () => {
    expect(mjsql("delete $.a; delete $.b")).toEqual([{ $unset: "a" }, { $unset: "b" }]);
  });

  it("comma-grouped mutations inside one `;` chunk still coalesce", () => {
    expect(mjsql("$.a = 1, $.b = 2; $match($.x)")).toEqual([
      { $set: { a: 1, b: 2 } },
      { $match: { $expr: "$x" } },
    ]);
  });

  it("stage call followed by mutation", () => {
    expect(mjsql("$match($.a == 0); $.b = 1")).toEqual([
      { $match: { $expr: { $eq: ["$a", 0] } } },
      { $set: { b: 1 } },
    ]);
  });

  it("two stage calls produce two stages", () => {
    expect(mjsql("$match($.active); $sort({ score: -1 })")).toEqual([
      { $match: { $expr: "$active" } },
      { $sort: { score: -1 } },
    ]);
  });

  it("`,`-grouped chain that RAW-splits inside one `;` chunk emits all its stages, then continues", () => {
    expect(mjsql("$.a = 1, $.b = $.a; $.c = 3")).toEqual([
      { $set: { a: 1 } },
      { $set: { b: "$a" } },
      { $set: { c: 3 } },
    ]);
  });

  it("trailing `;` on a multi-statement input is a no-op", () => {
    expect(mjsql("$.a = 1; $.b = 2;")).toEqual([{ $set: { a: 1 } }, { $set: { b: 2 } }]);
  });

  it("inc/dec across `;` stay separate (no coalesce)", () => {
    expect(mjsql("$.a++; $.b--")).toEqual([
      { $set: { a: { $add: ["$a", 1] } } },
      { $set: { b: { $subtract: ["$b", 1] } } },
    ]);
  });

  it("kind change across `;` (delete then assign) gives two stages", () => {
    expect(mjsql("delete $.tmp; $.status = 'done'")).toEqual([
      { $unset: "tmp" },
      { $set: { status: "done" } },
    ]);
  });

  it("$match-led pipeline ending in mutations", () => {
    expect(mjsql("$match($.active); $.score += 1; $.touched = true")).toEqual([
      { $match: { $expr: "$active" } },
      { $set: { score: { $add: ["$score", 1] } } },
      { $set: { touched: true } },
    ]);
  });
});

describe("implicit pipeline — single-statement inputs unchanged", () => {
  it("bare assignment without `;` stays a single $set object", () => {
    expect(mjsql("$.a = 1")).toEqual({ $set: { a: 1 } });
  });

  it("bare delete without `;` stays a single $unset object", () => {
    expect(mjsql("delete $.tmp")).toEqual({ $unset: "tmp" });
  });

  it("bare stage call without `;` stays expression-mode (no $expr wrap on $match body)", () => {
    // No `;` means expression mode, so `$match(…)` is just a generic operator
    // call — the $match-body $expr-wrap rule only fires inside pipeline mode.
    expect(mjsql("$match($.a == 0)")).toEqual({ $match: { $eq: ["$a", 0] } });
  });

  it("comma-grouped chain without `;` stays a single coalesced $set object", () => {
    expect(mjsql("$.a = 1, $.b = 2")).toEqual({ $set: { a: 1, b: 2 } });
  });

  it("trailing `,` (no `;`) stays a single $set object", () => {
    expect(mjsql("$.a = 1,")).toEqual({ $set: { a: 1 } });
  });
});

describe("implicit pipeline — error handling", () => {
  it("non-stage expression between `;`s reports a precise stage error", () => {
    const r = validate("1 + 1; $.a = 2");
    expect(r.valid).toBe(false);
    expect(r.errors[0].message).toMatch(/not a recognised stage|not a known aggregation stage/);
  });

  it("typo in stage name suggests the closest match", () => {
    const r = validate("$macth($.a); $.b = 1");
    expect(r.valid).toBe(false);
    expect(r.errors[0].message).toMatch(/\$match/);
  });

  it("explicit `[…]` pipeline still uses `[]`-coalescing semantics (regression)", () => {
    expect(mjsql("[$.a = 1, $.b = 2]")).toEqual([{ $set: { a: 1, b: 2 } }]);
  });
});
