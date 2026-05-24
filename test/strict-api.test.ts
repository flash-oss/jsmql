import { describe, it, expect } from "vitest";
import { jsmql } from "../src/index.ts";

// Strict-shape entry points: `jsmql.filter()`, `jsmql.pipeline()`,
// `jsmql.update()`. These wrap the same parser/lowering pipeline as
// `jsmql()` but each enforces a single output shape at compile time and
// throws an actionable error otherwise. The polymorphic `jsmql()` stays the
// "guess from input shape" entry point; these three exist for call sites
// where the desired shape is fixed and a silent mis-dispatch would be a
// footgun.
//
// The AST type for an update-op chain is still `UpdateFilter` (mirroring the
// MongoDB driver's `UpdateFilter<T>`); only the public function name is
// `update`, to avoid the "filter ≠ query doc" confusion at the call site.

describe("jsmql.filter() — strict Filter shape", () => {
  it("returns a Filter document for an indexable predicate", () => {
    expect(jsmql.filter("$.age > 18 && $.status === 'active'")).toEqual({ age: { $gt: 18 }, status: "active" });
  });

  it("wraps a non-translatable expression in $expr (same as jsmql())", () => {
    expect(jsmql.filter("$.name.trim() === 'alice'")).toEqual({
      $expr: { $eq: [{ $trim: { input: "$name" } }, "alice"] },
    });
  });

  it("accepts the arrow form", () => {
    expect(jsmql.filter(($) => $.age > 18)).toEqual({ age: { $gt: 18 } });
  });

  it("accepts the template-tag form with an interpolated literal", () => {
    const minAge = 21;
    expect(jsmql.filter`$.age >= ${minAge}`).toEqual({ age: { $gte: 21 } });
  });

  it("throws on a `;`-separated Pipeline", () => {
    expect(() => jsmql.filter("$match($.x > 0); $sort({ x: 1 })")).toThrow(
      /jsmql\.filter\(\) expects a Filter.*`;`-separated Pipeline.*jsmql\.pipeline\(\)/s,
    );
  });

  it("throws on an update-op chain and points at jsmql.update()", () => {
    expect(() => jsmql.filter("$.x = 1")).toThrow(
      /jsmql\.filter\(\) expects a Filter.*update-op chain.*jsmql\.update\(\)/s,
    );
  });

  it("throws on a top-level stage call with the offending stage name", () => {
    expect(() => jsmql.filter("$match($.age > 18)")).toThrow(
      /jsmql\.filter\(\) expects a Filter.*top-level '\$match' stage call/s,
    );
  });

  it("suggests dropping $match for the most common mistake", () => {
    // The $match-specific hint nudges users who wrapped a predicate by reflex.
    expect(() => jsmql.filter("$match($.age > 18)")).toThrow(/drop the `\$match\(\.\.\.\)` wrapper/);
  });

  it("throws on a stage-object literal (Compass copy-paste shape)", () => {
    expect(() => jsmql.filter("{ $match: $.x > 0 }")).toThrow(/top-level '\$match' stage call/);
  });

  it("throws on an array-literal Pipeline", () => {
    expect(() => jsmql.filter("[{ $match: $.x > 0 }]")).toThrow(/Pipeline array/);
  });

  it("rejects non-string / non-function / non-template inputs by name", () => {
    expect(() => (jsmql.filter as (n: unknown) => unknown)(42)).toThrow(
      /jsmql\.filter\(\) expects a string, an arrow function, or a template literal — got number/,
    );
  });
});

describe("jsmql.pipeline() — strict Pipeline shape", () => {
  it("auto-wraps a single top-level stage call (same as jsmql())", () => {
    expect(jsmql.pipeline("$match($.age > 18)")).toEqual([{ $match: { age: { $gt: 18 } } }]);
  });

  it("compiles a `;`-separated multi-stage pipeline", () => {
    expect(jsmql.pipeline("$match($.age > 18); $sort({ age: 1 })")).toEqual([
      { $match: { age: { $gt: 18 } } },
      { $sort: { age: 1 } },
    ]);
  });

  it("compiles an update-op chain to a $set / $unset pipeline", () => {
    expect(jsmql.pipeline("$.x = 1; delete $.y")).toEqual([{ $set: { x: 1 } }, { $unset: "y" }]);
  });

  it("accepts an array-literal Pipeline", () => {
    expect(jsmql.pipeline("[{ $match: $.x > 0 }, { $sort: { x: 1 } }]")).toEqual([
      { $match: { x: { $gt: 0 } } },
      { $sort: { x: 1 } },
    ]);
  });

  it("accepts the template-tag form with an interpolated literal", () => {
    const cutoff = 100;
    expect(jsmql.pipeline`$match($.score > ${cutoff})`).toEqual([{ $match: { score: { $gt: 100 } } }]);
  });

  it("accepts the block-body arrow form", () => {
    expect(
      jsmql.pipeline(($, { $match, $sort }) => {
        $match($.age > 18);
        $sort({ age: 1 });
      }),
    ).toEqual([{ $match: { age: { $gt: 18 } } }, { $sort: { age: 1 } }]);
  });

  it("throws on a bare predicate that would lower to a Filter", () => {
    expect(() => jsmql.pipeline("$.age > 18")).toThrow(
      /jsmql\.pipeline\(\) expects a Pipeline.*bare expression that would lower to a Filter.*jsmql\.filter\(\).*wrap the predicate as `\$match/s,
    );
  });

  it("throws on a bare non-predicate expression", () => {
    expect(() => jsmql.pipeline("$.a + $.b")).toThrow(/jsmql\.pipeline\(\) expects a Pipeline/);
  });
});

describe("jsmql.update() — strict aggregation-pipeline update", () => {
  it("compiles an assignment to a one-element $set pipeline", () => {
    expect(jsmql.update("$.name = $.name.toUpperCase()")).toEqual([{ $set: { name: { $toUpper: "$name" } } }]);
  });

  it("compiles a chained assignment plus delete to two stages", () => {
    expect(jsmql.update("$.x = 1; delete $.y")).toEqual([{ $set: { x: 1 } }, { $unset: "y" }]);
  });

  it("accepts an explicit $set stage call", () => {
    expect(jsmql.update("$set({ x: $.x + 1 })")).toEqual([{ $set: { x: { $add: ["$x", 1] } } }]);
  });

  it("accepts $addFields / $project / $unset / $replaceRoot / $replaceWith", () => {
    expect(jsmql.update("$addFields({ y: $.x + 1 }); $project({ y: 1 })")).toEqual([
      { $addFields: { y: { $add: ["$x", 1] } } },
      { $project: { y: 1 } },
    ]);
    expect(jsmql.update("$replaceRoot({ newRoot: $.nested })")).toEqual([{ $replaceRoot: { newRoot: "$nested" } }]);
    expect(jsmql.update("$replaceWith($.nested)")).toEqual([{ $replaceWith: "$nested" }]);
  });

  it("rejects $match with the offending stage name and the allowed list", () => {
    // Allowed-stage list is alphabetical so the message stays deterministic.
    expect(() => jsmql.update("$match($.age > 18); $set({ x: 1 })")).toThrow(
      /jsmql\.update\(\) rejected '\$match' \(stage 0\).*aggregation-pipeline update form only accepts \$addFields, \$project, \$replaceRoot, \$replaceWith, \$set, \$unset/s,
    );
  });

  it("rejects $sort even when it follows valid stages", () => {
    expect(() => jsmql.update("$set({ x: 1 }); $sort({ x: 1 })")).toThrow(
      /jsmql\.update\(\) rejected '\$sort' \(stage 1\)/,
    );
  });

  it("throws on a bare predicate (same error as jsmql.pipeline)", () => {
    expect(() => jsmql.update("$.age > 18")).toThrow(/jsmql\.update\(\) expects a Pipeline.*bare expression/);
  });

  it("accepts the template-tag form with an interpolated literal", () => {
    const bump = 5;
    expect(jsmql.update`$.score += ${bump}`).toEqual([{ $set: { score: { $add: ["$score", 5] } } }]);
  });

  it("accepts the arrow form", () => {
    expect(jsmql.update(($) => ($.name = $.name.toUpperCase()))).toEqual([{ $set: { name: { $toUpper: "$name" } } }]);
  });

  it("allows `let` bindings (they lower to whitelisted $set / $unset stages)", () => {
    // `let` bindings desugar to a `$set: { "__jsmql.foo": ... }` stage plus a
    // trailing `$unset: "__jsmql"` cleanup — both stages are in the
    // update-pipeline whitelist, so the chain composes cleanly.
    expect(jsmql.update("let upper = $.name.toUpperCase(); $.name = upper")).toEqual([
      { $set: { "__jsmql.upper": { $toUpper: "$name" } } },
      { $set: { name: "$__jsmql.upper" } },
      { $unset: "__jsmql" },
    ]);
  });
});
