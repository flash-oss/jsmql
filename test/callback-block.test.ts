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
    expect(jsmql(`$.r = $.items.filter(d => { return d > 1; });`)).toEqual(jsmql(`$.r = $.items.filter(d => d > 1);`));
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
      { $match: { $expr: { $let: { vars: { t: "$total" }, in: { $not: { $gt: ["$$t", 5] } } } } } },
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
    expect(() => jsmql(`$ = { big: $$.filter(d => { const t = $.total; return t > 5; }) };`)).toThrow(
      /'\$\.<field>' inside '\$\$\.filter\(<predicate>\)'/,
    );
  });
});
