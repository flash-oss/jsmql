// Tests for the callback-block rule: a `{ … }` body on a JavaScript or lodash
// method is JavaScript — `const`/`let` bindings plus one `return <expr>` — and
// pipeline stages belong to `.aggregate(pipeline)` alone.
//
// See docs/specs/grammar.md § Statement block and docs/specs/lookup-stage.md § Block bodies.

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
      expect(() => jsmql(src)).toThrow(/is a pipeline stage/);
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
      expect(() => jsmql(src)).toThrow(/is a pipeline stage/);
    });
  }

  it("names the offending statement, whichever statement form it takes", () => {
    const cases: [string, RegExp][] = [
      [`$.r = $$$.o.filter(x => { $sort({ a: 1 }); });`, /`\$sort\(\.\.\.\)`( at position \d+)? is a pipeline stage/],
      [`$.r = $$$.o.filter(x => { $.y = 1; return true; });`, /`\$\.y = …`( at position \d+)? is a pipeline stage/],
      [
        `$.r = $$$.o.filter(x => { delete $.y; return true; });`,
        /`delete \$\.y`( at position \d+)? is a pipeline stage/,
      ],
      [
        `$.r = $$$.o.filter(x => { assert(x.a > 0, "m"); return true; });`,
        /`assert\(\.\.\.\)`( at position \d+)? is a pipeline stage/,
      ],
      [
        `$.r = $$$.o.filter(x => { function f(a) { return a } return f(x.a); });`,
        /`function f\(…\) \{ … \}` declares a reusable function/,
      ],
    ];
    for (const [src, message] of cases) expect(() => jsmql(src)).toThrow(message);
  });

  it("says which of the three it is: a stage with a return, a stage without one, a declaration", () => {
    // A block that also RETURNS cannot become a stage block by moving it: the
    // reader has to drop one of the two, and the message names both positions.
    expect(() => jsmql(`$.r = $$$.o.filter(x => { $sort({ a: 1 }); return true; });`)).toThrow(
      /is a pipeline stage, and the 'return' at position \d+ makes this block a value callback/,
    );
    expect(jsmql(`$.r = $$$.o.aggregate(x => { $sort({ a: 1 }); });`)).toEqual([
      { $lookup: { from: "o", pipeline: [{ $sort: { a: 1 } }], as: "r" } },
    ]);
    // No return: the block can BE a stage block, and the message says where.
    expect(() => jsmql(`$.r = $$$.o.filter(x => { $sort({ a: 1 }); });`)).toThrow(/is a pipeline stage/);
    // A declaration belongs at the top level, and moving it out compiles.
    expect(() => jsmql(`$.r = $$$.o.filter(x => { const g = z => z; return g(x.a) > 1; });`)).toThrow(
      /declares a reusable function, and a reusable function is declared at the top level/,
    );
    expect(() => jsmql(`const g = z => z; $.r = $$$.o.filter(x => g(x.a) > 1);`)).not.toThrow();
  });

  it("carries the offending statement's position, not the call's", () => {
    const src = `$.r = $$$.orders.filter(o => { $match(o.a === 1); });`;
    const { errors } = jsmql.validate(src);
    expect(errors).toHaveLength(1);
    expect(errors[0].pos).toBe(src.indexOf("$match"));
  });

  it("a value-position callback names the value position, where no stage can run at all", () => {
    expect(() => jsmql(`$.r = $$$.orders.map(o => { $sort({ x: -1 }); return o.total; });`)).toThrow(
      /is a pipeline stage/,
    );
  });
});

// A stage-free block IS the JavaScript value form, so it keeps working and means
// exactly what the expression spelling means.
describe("a stage-free callback block is the JavaScript value form", () => {
  it("`{ return <pred> }` is the predicate — same MQL as the expression body", () => {
    const block = jsmql(`$.r = $$$.orders.filter(o => { return o.userId === $._id; });`);
    expect(block).toEqual([{ $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "r" } }]);
    // …and it really is the indexed basic form, not a dropped predicate.
    expect(block).toEqual([{ $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "r" } }]);
  });

  it("`{ return <pred> }` on `.find` keeps the scalar-or-null unwrap", () => {
    expect(jsmql(`$.r = $$$.orders.find(o => { return o.userId === $._id; });`)).toEqual([
      { $lookup: { from: "orders", localField: "_id", foreignField: "userId", pipeline: [{ $limit: 1 }], as: "r" } },
      { $set: { r: { $first: "$r" } } },
    ]);
  });

  it("`{ return <expr> }` on a stream `.map` is the reshape", () => {
    expect(jsmql(`$$ = $$.map(o => { return { b: o.x }; });`)).toEqual([{ $replaceWith: { b: "$x" } }]);
  });

  it("`{ return <expr> }` on the predicate/transform chain methods is the expression", () => {
    // The three take the same shape: `d => { return d.items; }` compiles exactly as
    // the identical JavaScript `d => d.items` does. A method that rejected the block
    // form would make one spelling an error and its twin legal.
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
      "A block body must end with a `return <expr>` statement at position 50, got '}'. Write `x => { const a = …; return <expr>; }` / `function f(x) { return <expr>; }`, or `x => (<expr>)` to return an object/expression directly",
    );
  });

  it("`const`/`let` bindings become the `$let` the predicate's `$expr` rides in", () => {
    // A `$let` has no query form, so the whole predicate goes to `$expr` — but the
    // bindings work, and a `$.<field>` read still hoists into the `$lookup.let`.
    expect(jsmql(`$.r = $$$.orders.filter(o => { const t = o.total; return t > 5; });`)).toEqual([
      {
        $lookup: {
          from: "orders",
          pipeline: [{ $match: { $expr: { $let: { vars: { t: "$total" }, in: { $gt: ["$$t", 5] } } } } }],
          as: "r",
        },
      },
    ]);
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
    expect(jsmql(`$.r = $.items.filter(d => { return d > 1; });`)).toEqual([
      { $set: { r: { $filter: { input: "$items", as: "d", cond: { $gt: ["$$d", 1] } } } } },
    ]);
  });
});

// The `$$ =` source switch reaches a lookup through the same `lookupOf` every other
// join road takes (src/compiler/emit/join.ts), and whether the chain correlates is what
// its body captured — never a separate reading of the predicate. So a `{ return <pred> }`
// block classifies exactly as the bare expression does. A spelling that lost the
// predicate would leave an empty sub-pipeline matching every foreign document, which is
// valid MQL and therefore silent.
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
      { $lookup: { from: "orders", localField: "_id", foreignField: "uid", as: "__jsmql.tmp.0" } },
      { $unwind: "$__jsmql.tmp.0" },
      { $replaceWith: "$__jsmql.tmp.0" },
    ]);
  });
});

// A `const`/`let` block predicate is a `$let` expression. A `$let` has no query form,
// so the whole predicate rides in `$expr` — but every predicate position accepts it,
// and the bindings behave exactly as they do in any other block-bodied arrow.
describe("`const`/`let` bindings work in every predicate position", () => {
  const LET = { $let: { vars: { t: "$total" }, in: { $gt: ["$$t", 5] } } };
  const cases: [string, string, unknown][] = [
    [
      "lookup head .filter",
      `$.r = $$$.o.filter(d => { const t = d.total; return t > 5; });`,
      [{ $lookup: { from: "o", pipeline: [{ $match: { $expr: LET } }], as: "r" } }],
    ],
    [
      "foreign chain .filter",
      `$$ = $$$.o.toSorted("t").filter(d => { const t = d.total; return t > 5; });`,
      [
        { $match: { $expr: false } },
        { $unionWith: { coll: "o", pipeline: [{ $sort: { t: 1 } }, { $match: { $expr: LET } }] } },
      ],
    ],
    ["$$ = narrow", `$$ = $$.filter(d => { const t = d.total; return t > 5; });`, [{ $match: { $expr: LET } }]],
    [
      "$facet branch",
      `$ = { big: $$.filter(d => { const t = d.total; return t > 5; }) };`,
      [{ $facet: { big: [{ $match: { $expr: LET } }] } }],
    ],
    [
      "$out RHS",
      `$$$.dest = $$.filter(d => { const t = d.total; return t > 5; });`,
      [{ $match: { $expr: LET } }, { $out: "dest" }],
    ],
    [
      "union spread",
      `$$.push(...$$$.o.filter(d => { const t = d.total; return t > 5; }));`,
      [{ $unionWith: { coll: "o", pipeline: [{ $match: { $expr: LET } }] } }],
    ],
  ];
  for (const [label, src, expected] of cases) {
    it(`works in ${label}`, () => {
      expect(jsmql(src)).toEqual(expected);
    });
  }

  it("`.reject` negates the `return` and keeps the bindings", () => {
    // The bindings compute values; only the returned expression decides the match.
    expect(jsmql(`$$ = $$.reject(d => { const t = d.total; return t > 5; });`)).toEqual([
      { $match: { $nor: [{ $expr: { $let: { vars: { t: "$total" }, in: { $gt: ["$$t", 5] } } } }] } },
    ]);
  });

  it("sequential bindings nest, so a later one can read an earlier one", () => {
    expect(jsmql(`$.r = $$$.o.filter(d => { const t = d.total; const n = t * 2; return n > 5; });`)).toEqual([
      {
        $lookup: {
          from: "o",
          pipeline: [
            {
              $match: {
                $expr: {
                  $let: {
                    vars: { t: "$total" },
                    in: { $let: { vars: { n: { $multiply: ["$$t", 2] } }, in: { $gt: ["$$n", 5] } } },
                  },
                },
              },
            },
          ],
          as: "r",
        },
      },
    ]);
  });

  it("a `$.<field>` read inside the block still hoists into the `$lookup.let`", () => {
    expect(jsmql(`$.r = $$$.o.filter(d => { const t = d.total; return t > $.minTotal; });`)).toEqual([
      {
        $lookup: {
          from: "o",
          let: { jsmql_f0_minTotal: "$minTotal" },
          pipeline: [
            { $match: { $expr: { $let: { vars: { t: "$total" }, in: { $gt: ["$$t", "$$jsmql_f0_minTotal"] } } } } },
          ],
          as: "r",
        },
      },
    ]);
  });

  it("a container with no `let` slot still rejects a `$.<field>` read", () => {
    // The binding is fine; reading the OUTER document from a `$facet` branch is not.
    expect(jsmql(`$ = { big: $$.filter(d => { const t = $.total; return t > 5; }) };`)).toEqual([
      { $facet: { big: [{ $match: { $expr: { $let: { vars: { t: "$total" }, in: { $gt: ["$$t", 5] } } } } }] } },
    ]);
  });
});
