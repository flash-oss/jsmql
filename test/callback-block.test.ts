// Tests for the callback-block rule: a `{ … }` body on a JavaScript or lodash
// method is JavaScript — `const`/`let` bindings plus one `return <expr>` — and
// pipeline stages belong to `.aggregate(pipeline)` alone.
//
// See src/callback-block.ts and docs/specs/method-dispatch.md § Callback block bodies.

import { describe, it, expect } from "vitest";
import { jsmql } from "../src/index.ts";

// Every position a stream-rooted callback reaches, so the rule can't hold in one
// container and leak in another. `$$$.<coll>` receivers are pointed at `.aggregate`;
// `$$` (current-stream) receivers at the chained-stage spelling, which is what works
// in all of ITS containers.
describe("a pipeline stage in a JavaScript callback is rejected", () => {
  const foreign: [string, string][] = [
    ["lookup head .filter", `$.r = $$$.orders.filter(o => { $match(o.userId === $._id); $limit(5); });`],
    ["lookup head .find", `$.r = $$$.orders.find(o => { $match(o.a === 1); });`],
    ["foreign chain .filter", `$.r = $$$.orders.toSorted("t").filter(o => { $match(o.a === 1); });`],
    ["foreign chain .reject", `$.r = $$$.orders.toSorted("t").reject(o => { $match(o.a === 1); });`],
    [
      "foreign chain .map",
      `$.r = $$$.orders.filter(o => o.a === 1).map(o => { $sort({ t: -1 }); return { a: o.t }; });`,
    ],
    ["$$ = foreign pivot .filter", `$$ = $$$.orders.filter(o => { $match(o.a === 1); });`],
    ["union spread", `$$.push(...$$$.other.filter(o => { $match(o.x === 1); }));`],
    ["foreign chain .takeWhile", `$.r = $$$.orders.toSorted("t").takeWhile(o => { $match(o.a === 1); });`],
    ["foreign chain .dropWhile", `$.r = $$$.orders.toSorted("t").dropWhile(o => { $match(o.a === 1); });`],
    ["foreign chain .flatMap", `$.r = $$$.orders.filter(o => o.a === 1).flatMap(o => { $match(o.a === 1); });`],
  ];
  for (const [label, src] of foreign) {
    it(`${label} → points at .aggregate on the same collection`, () => {
      expect(() => jsmql(src)).toThrow(/is a pipeline stage, not part of a callback — write `\$\$\$\.\w+\.aggregate\(/);
    });
  }

  const stream: [string, string][] = [
    ["$$ = narrow .filter", `$$ = $$.filter(o => { $match(o.a === 1); $limit(3); });`],
    ["$$ = narrow .reject", `$$ = $$.reject(o => { $match(o.a === 1); });`],
    ["$$ = reshape .map", `$$ = $$.map(o => { $sort({ a: 1 }); return { b: o.x }; });`],
    ["$facet branch", `$ = { a: $$.filter(o => { $match(o.x === 1); $count("n"); }) };`],
    ["$out RHS", `$$$.dest = $$.filter(o => { $match(o.x === 1); });`],
    ["$$ = .takeWhile", `$$ = $$.toSorted("t").takeWhile(o => { $match(o.a === 1); });`],
    ["$$ = .dropWhile", `$$ = $$.toSorted("t").dropWhile(o => { $match(o.a === 1); });`],
    ["$$ = .flatMap", `$$ = $$.flatMap(o => { $match(o.a === 1); });`],
  ];
  for (const [label, src] of stream) {
    it(`${label} → points at the chained-stage spelling`, () => {
      expect(() => jsmql(src)).toThrow(
        /is a pipeline stage, not part of a callback — chain them as stage calls instead/,
      );
    });
  }

  it("names the offending statement, whichever statement form it takes", () => {
    const cases: [string, RegExp][] = [
      [`$.r = $$$.o.filter(x => { $sort({ a: 1 }); });`, /`\$sort\(\.\.\.\)` is a pipeline stage/],
      [`$.r = $$$.o.filter(x => { $.y = 1; return true; });`, /`\$\.y = …` is a pipeline stage/],
      [`$.r = $$$.o.filter(x => { delete $.y; return true; });`, /`delete \$\.y` is a pipeline stage/],
      [`$.r = $$$.o.filter(x => { assert(x.a > 0, "m"); return true; });`, /`assert\(\.\.\.\)` is a pipeline stage/],
      [
        `$.r = $$$.o.filter(x => { function f(a) { return a } return f(x.a); });`,
        /`function f\(…\) \{ … \}` is a pipeline stage/,
      ],
    ];
    for (const [src, message] of cases) expect(() => jsmql(src)).toThrow(message);
  });

  it("carries the offending statement's position, not the call's", () => {
    const src = `$.r = $$$.orders.filter(o => { $match(o.a === 1); });`;
    const { errors } = jsmql.validate(src);
    expect(errors).toHaveLength(1);
    expect(errors[0].pos).toBe(src.indexOf("$match"));
  });

  it("a value-position callback names the value position, where no stage can run at all", () => {
    expect(() => jsmql(`$.r = $$$.orders.map(o => { $sort({ x: -1 }); return o.total; });`)).toThrow(
      /the chain is consumed as a value here, so it lowers to an array operator with nowhere to run stages/,
    );
  });
});

// A stage-free block IS the JavaScript value form, so it keeps working and means
// exactly what the expression spelling means.
describe("a stage-free callback block is the JavaScript value form", () => {
  it("`{ return <pred> }` is the predicate — same MQL as the expression body", () => {
    const block = jsmql(`$.r = $$$.orders.filter(o => { return o.userId === $._id; });`);
    expect(block).toEqual(jsmql(`$.r = $$$.orders.filter(o => o.userId === $._id);`));
    // …and it really is the indexed basic form, not a dropped predicate.
    expect(block).toEqual([{ $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "r" } }]);
  });

  it("`{ return <pred> }` on `.find` keeps the scalar-or-null unwrap", () => {
    expect(jsmql(`$.r = $$$.orders.find(o => { return o.userId === $._id; });`)).toEqual(
      jsmql(`$.r = $$$.orders.find(o => o.userId === $._id);`),
    );
  });

  it("`{ return <expr> }` on a stream `.map` is the reshape", () => {
    expect(jsmql(`$$ = $$.map(o => { return { b: o.x }; });`)).toEqual([{ $replaceWith: { b: "$x" } }]);
  });

  it("`{ return <expr> }` on the predicate/transform chain methods is the expression", () => {
    // `.takeWhile`/`.dropWhile` already accepted this shape; `.flatMap` used to
    // reject any block, which made `d => { return d.items; }` an error while the
    // identical JavaScript `d => d.items` compiled.
    for (const [block, expr] of [
      [`$$ = $$.toSorted("t").takeWhile(d => { return d.a > 1; });`, `$$ = $$.toSorted("t").takeWhile(d => d.a > 1);`],
      [`$$ = $$.toSorted("t").dropWhile(d => { return d.a > 1; });`, `$$ = $$.toSorted("t").dropWhile(d => d.a > 1);`],
      [`$$ = $$.flatMap(d => { return d.items; });`, `$$ = $$.flatMap(d => d.items);`],
    ]) {
      expect(jsmql(block)).toEqual(jsmql(expr));
    }
  });

  it("a block with no `return` has no value to use", () => {
    expect(() => jsmql(`$.r = $$$.orders.filter(o => { const t = o.total; });`)).toThrow(
      /must end with `return <expr>` — a block body that returns nothing has no value to use/,
    );
  });

  it("`const`/`let` bindings in a predicate block still need folding into the expression", () => {
    // A predicate position lowers one expression, so the `$let` an `ExprBlock`
    // needs has nowhere to go — the same limitation `function (x) { const … }` hits.
    expect(() => jsmql(`$.r = $$$.orders.filter(o => { const t = o.total; return t > 5; });`)).toThrow(
      /predicate has local `const`\/`let` bindings, which isn't supported in this position/,
    );
  });
});

// The rule is about STREAM callbacks. An in-document array method never had the
// sub-pipeline grammar, so its `=> { … }` keeps its plain expression-block meaning.
describe("in-document array callbacks are untouched", () => {
  it("an expression block still lowers to `$let`", () => {
    expect(jsmql(`$.r = $.items.map(d => { const a = d * 2; return a; });`)).toEqual([
      {
        $set: {
          r: {
            $map: { input: "$items", as: "d", in: { $let: { vars: { a: { $multiply: ["$$d", 2] } }, in: "$$a" } } },
          },
        },
      },
    ]);
  });

  it("`{ return <expr> }` collapses to the bare expression", () => {
    expect(jsmql(`$.r = $.items.filter(d => { return d > 1; });`)).toEqual(jsmql(`$.r = $.items.filter(d => d > 1);`));
  });
});

// The `$$ =` source switch reaches a lookup by two steps that both classify the
// predicate before the lowering folds it: `chainHasCorrelatingFilter` decides whether
// the chain correlates, and `lowerLookupPivot` builds its own `LookupCall` instead of
// taking one from `detectLookupCall`. Both must apply the fold, or a `{ return <pred> }`
// block picks the wrong lowering and then loses the predicate — an empty sub-pipeline
// that matches every foreign document, which is valid MQL and therefore silent.
describe("the `$$ =` source switch folds a callback block before it classifies", () => {
  const PAIRS: [string, string, string][] = [
    [
      "a correlated predicate still reaches the indexed lookup",
      "$$ = $$$.orders.filter(o => { return o.uid === $._id; });",
      "$$ = $$$.orders.filter(o => o.uid === $._id);",
    ],
    [
      "an uncorrelated predicate still reaches the flat union",
      "$$ = $$$.orders.filter(o => { return o.a > 1; });",
      "$$ = $$$.orders.filter(o => o.a > 1);",
    ],
    [
      "a correlated predicate behind a stream head still pivots",
      '$$ = $$$.orders.toSorted("x").filter(o => { return o.a === $.b; });',
      '$$ = $$$.orders.toSorted("x").filter(o => o.a === $.b);',
    ],
  ];
  for (const [label, blockForm, exprForm] of PAIRS) {
    it(label, () => {
      expect(jsmql(blockForm)).toEqual(jsmql(exprForm));
    });
  }

  // The predicate must survive, not just the routing: an empty `pipeline` here would
  // pass an equality check against another broken form but match every document.
  it("keeps the predicate in the emitted sub-pipeline", () => {
    expect(jsmql("$$ = $$$.orders.filter(o => { return o.uid === $._id; });")).toEqual([
      { $lookup: { from: "orders", localField: "_id", foreignField: "uid", as: "__jsmql.tmp.1" } },
      { $unwind: "$__jsmql.tmp.1" },
      { $replaceWith: "$__jsmql.tmp.1" },
    ]);
  });
});
