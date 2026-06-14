import { describe, it, expect } from "vitest";
import { jsmql } from "../src/index.ts";

// `;` at top level is the implicit pipeline-stage separator. Each `;`-separated
// chunk becomes its own stage(s) with no cross-coalescing — in contrast to the
// explicit `[…]` form, where adjacent update op elements coalesce. `,` remains
// the in-stage separator and keeps its existing coalescing behaviour.

describe("implicit pipeline — `;` triggers pipeline mode", () => {
  it("single trailing `;` after assignment wraps as a one-stage pipeline", () => {
    expect(jsmql("$.a = 1;")).toEqual([{ $set: { a: 1 } }]);
  });

  it("single trailing `;` after a stage call wraps as a one-stage pipeline", () => {
    expect(jsmql("$match($.a === 0);")).toEqual([{ $match: { a: 0 } }]);
  });

  it("single trailing `;` after a stage-object wraps as a one-stage pipeline", () => {
    expect(jsmql("({ $limit: 10 });")).toEqual([{ $limit: 10 }]);
  });

  it("two `;`-separated assignments produce two separate $set stages (no coalesce)", () => {
    expect(jsmql("$.a = 1; $.b = 2")).toEqual([{ $set: { a: 1 } }, { $set: { b: 2 } }]);
  });

  it("two `;`-separated deletes produce two separate $unset stages (no coalesce)", () => {
    expect(jsmql("delete $.a; delete $.b")).toEqual([{ $unset: "a" }, { $unset: "b" }]);
  });

  it("comma-grouped update ops inside one `;` chunk still coalesce", () => {
    expect(jsmql("$.a = 1, $.b = 2; $match($.x)")).toEqual([{ $set: { a: 1, b: 2 } }, { $match: { $expr: "$x" } }]);
  });

  it("stage call followed by update op", () => {
    expect(jsmql("$match($.a === 0); $.b = 1")).toEqual([{ $match: { a: 0 } }, { $set: { b: 1 } }]);
  });

  it("two stage calls produce two stages", () => {
    expect(jsmql("$match($.active); $sort({ score: -1 })")).toEqual([
      { $match: { $expr: "$active" } },
      { $sort: { score: -1 } },
    ]);
  });

  it("`,`-grouped chain that RAW-splits inside one `;` chunk emits all its stages, then continues", () => {
    expect(jsmql("$.a = 1, $.b = $.a; $.c = 3")).toEqual([
      { $set: { a: 1 } },
      { $set: { b: "$a" } },
      { $set: { c: 3 } },
    ]);
  });

  it("trailing `;` on a multi-statement input is a no-op", () => {
    expect(jsmql("$.a = 1; $.b = 2;")).toEqual([{ $set: { a: 1 } }, { $set: { b: 2 } }]);
  });

  it("inc/dec across `;` stay separate (no coalesce)", () => {
    expect(jsmql("$.a++; $.b--")).toEqual([
      { $set: { a: { $add: ["$a", 1] } } },
      { $set: { b: { $subtract: ["$b", 1] } } },
    ]);
  });

  it("kind change across `;` (delete then assign) gives two stages", () => {
    expect(jsmql("delete $.tmp; $.status = 'done'")).toEqual([{ $unset: "tmp" }, { $set: { status: "done" } }]);
  });

  it("$match-led pipeline ending in update ops", () => {
    expect(jsmql("$match($.active); $.score += 1; $.touched = true")).toEqual([
      { $match: { $expr: "$active" } },
      { $set: { score: { $add: ["$score", 1] } } },
      { $set: { touched: true } },
    ]);
  });
});

describe("implicit pipeline — single-statement update-filter inputs always wrap as pipelines", () => {
  // `jsmql()` always returns an aggregation-pipeline array for update-filter
  // inputs — including single-statement ones without a trailing `;` — so the
  // output is safe to pass directly to `db.coll.updateOne(filter, update)`.
  // Bare-document form would silently treat RHS expressions as literals; the
  // pipeline form evaluates them as aggregation expressions. Callers who want
  // the bare-doc shape (e.g. for embedding in a hand-written stage body) use
  // `jsmql.expr()` — see test/update-filter.test.ts's `lex regression checks`.
  it("bare assignment without `;` wraps as a one-stage pipeline", () => {
    expect(jsmql("$.a = 1")).toEqual([{ $set: { a: 1 } }]);
  });

  it("bare delete without `;` wraps as a one-stage pipeline", () => {
    expect(jsmql("delete $.tmp")).toEqual([{ $unset: "tmp" }]);
  });

  it("bare stage call without `;` auto-wraps as a Pipeline", () => {
    // A top-level `$match(...)` is Pipeline intent. Rather than throwing or
    // silently producing `{ $expr: { $match: ... } }` (a useless Filter),
    // jsmql() auto-wraps the stage as a one-element Pipeline — no `;`
    // discipline required at the call site.
    expect(jsmql("$match($.a === 0)")).toEqual([{ $match: { a: 0 } }]);
  });

  it("bare stage-object literal without `;` auto-wraps the same way", () => {
    // The Compass copy-paste form (`{ $match: ... }`) is the other shape we
    // detect as Pipeline intent.
    expect(jsmql("{ $match: $.a === 0 }")).toEqual([{ $match: { a: 0 } }]);
  });

  it("comma-grouped chain without `;` coalesces and wraps as a one-stage pipeline", () => {
    expect(jsmql("$.a = 1, $.b = 2")).toEqual([{ $set: { a: 1, b: 2 } }]);
  });

  it("trailing `,` (no `;`) wraps as a one-stage pipeline", () => {
    expect(jsmql("$.a = 1,")).toEqual([{ $set: { a: 1 } }]);
  });
});

describe("implicit pipeline — block-body arrow input", () => {
  it("block body with `;`-separated statements compiles as a pipeline", () => {
    const result = jsmql(($, { $match }) => {
      $match($.active);
      $.score += 1;
      $.touched = true;
    });
    expect(result).toEqual([
      { $match: { $expr: "$active" } },
      { $set: { score: { $add: ["$score", 1] } } },
      { $set: { touched: true } },
    ]);
  });

  it("block body with `,`-grouped chunk preserves in-stage coalescing", () => {
    const result = jsmql(($, { $match }) => {
      $match($.active);
      (($.lineTotal = $.qty * $.unitPrice), ($.invoiceCount += 1));
      $.status = "complete";
    });
    expect(result).toEqual([
      { $match: { $expr: "$active" } },
      { $set: { lineTotal: { $multiply: ["$qty", "$unitPrice"] }, invoiceCount: { $add: ["$invoiceCount", 1] } } },
      { $set: { status: "complete" } },
    ]);
  });

  it("single statement block body without `;` stays object-shaped", () => {
    const result = jsmql(($) => {
      $.a = 1;
    });
    // One statement with a trailing `;` ⇒ pipeline (one stage).
    expect(result).toEqual([{ $set: { a: 1 } }]);
  });

  it("block body `{ return <expr> }` is the value form (≡ the expression body)", () => {
    // A brace body opening directly with `return` is the value form, identical
    // to `($) => $.a > 18`. (A `;`-separated body of stage statements stays a
    // pipeline; a stray statement-position `return` mixed into one is rejected.)
    expect(
      jsmql(($) => {
        return $.a > 18;
      }),
    ).toEqual({ a: { $gt: 18 } });
  });

  it("a stray `return` in a `;`-separated block body is rejected with guidance", () => {
    expect(() =>
      jsmql(($) => {
        $.a = 1;
        return $.a;
      }),
    ).toThrow(/return/);
  });

  it("expression-body arrow with trailing `;` stripped (back-compat)", () => {
    // The arrow source as toString'd ends with `;` — formatter quirk that the
    // adapter strips so a single-statement expression arrow lowers as an
    // UpdateFilter, which `jsmql()` wraps as a one-stage pipeline.
    const fn = ($: any) => ($.a = 1);
    expect(jsmql(fn)).toEqual([{ $set: { a: 1 } }]);
  });
});

describe("implicit pipeline — error handling", () => {
  it("non-stage expression between `;`s reports a precise stage error", () => {
    const r = jsmql.validate("1 + 1; $.a = 2");
    expect(r.valid).toBe(false);
    expect(r.errors[0].message).toMatch(/not a recognised stage|not a known aggregation stage/);
  });

  it("typo in stage name suggests the closest match", () => {
    const r = jsmql.validate("$macth($.a); $.b = 1");
    expect(r.valid).toBe(false);
    expect(r.errors[0].message).toMatch(/\$match/);
  });

  it("explicit `[…]` pipeline still uses `[]`-coalescing semantics (regression)", () => {
    expect(jsmql("[$.a = 1, $.b = 2]")).toEqual([{ $set: { a: 1, b: 2 } }]);
  });
});
