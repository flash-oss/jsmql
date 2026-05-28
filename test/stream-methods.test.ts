// Tests for the chainable stream-method vocabulary on `$$` / `$$$.<coll>`.
// One describe block per method. See docs/specs/stream-methods.md for the
// per-method shape, lowering, and error wording.
//
// All tests use trailing `;` to flip the dispatcher into Pipeline mode —
// `$$ = …` is a stream-mutating statement only meaningful in a pipeline.

import { describe, it, expect } from "vitest";
import { jsmql } from "../src/index.ts";

describe(".slice(start, end?) — on $$ (top-level stream)", () => {
  it("two-arg slice lowers to $skip + $limit", () => {
    expect(jsmql("$$ = $$.slice(5, 15);")).toEqual([{ $skip: 5 }, { $limit: 10 }]);
  });

  it("zero start omits $skip (no-op skip)", () => {
    expect(jsmql("$$ = $$.slice(0, 10);")).toEqual([{ $limit: 10 }]);
  });

  it("one-arg slice (no end) emits $skip only", () => {
    expect(jsmql("$$ = $$.slice(5);")).toEqual([{ $skip: 5 }]);
  });

  it("slice(0) is a no-op — emits zero stages", () => {
    expect(jsmql("$$ = $$.slice(0);")).toEqual([]);
  });

  it("chains after .filter(<predicate>) — $match + $limit", () => {
    expect(jsmql("$$ = $$.filter(o => o.active).slice(0, 10);")).toEqual([
      { $match: { $expr: "$active" } },
      { $limit: 10 },
    ]);
  });

  it("query-form predicate then slice", () => {
    expect(jsmql("$$ = $$.filter(o => o.tier === 'gold').slice(0, 5);")).toEqual([
      { $match: { tier: "gold" } },
      { $limit: 5 },
    ]);
  });

  it("chains multiple .slice calls (compose)", () => {
    expect(jsmql("$$ = $$.slice(5, 20).slice(0, 5);")).toEqual([{ $skip: 5 }, { $limit: 15 }, { $limit: 5 }]);
  });
});

describe(".slice — on $$$.<coll> (source switch)", () => {
  it("bare .slice on $$$.<coll> emits $limit:0 + $unionWith with inner $limit", () => {
    expect(jsmql("$$ = $$$.archive.slice(0, 5);")).toEqual([
      { $limit: 0 },
      { $unionWith: { coll: "archive", pipeline: [{ $limit: 5 }] } },
    ]);
  });

  it(".filter then .slice runs both stages inside the $unionWith body", () => {
    expect(jsmql("$$ = $$$.archive.filter(o => o.tier === 'gold').slice(0, 10);")).toEqual([
      { $limit: 0 },
      { $unionWith: { coll: "archive", pipeline: [{ $match: { tier: "gold" } }, { $limit: 10 }] } },
    ]);
  });

  it("cross-database $$$$.<db>.<coll>.filter(...).slice(...)", () => {
    expect(jsmql("$$ = $$$$.archive.users.filter(u => u.tier === 'gold').slice(0, 5);")).toEqual([
      { $limit: 0 },
      {
        $unionWith: { coll: { db: "archive", coll: "users" }, pipeline: [{ $match: { tier: "gold" } }, { $limit: 5 }] },
      },
    ]);
  });
});

describe(".slice — preserves existing $$.filter(...) behaviour", () => {
  it("$$ = $$.filter(...) alone still emits a single $match (no regression)", () => {
    expect(jsmql("$$ = $$.filter(o => o.tier === 'gold');")).toEqual([{ $match: { tier: "gold" } }]);
  });

  it("$$ = $$$.coll.filter(o => true) keeps the existing $expr-residual shape", () => {
    expect(jsmql("$$ = $$$.archive.filter(o => true);")).toEqual([
      { $limit: 0 },
      { $unionWith: { coll: "archive", pipeline: [{ $match: { $expr: true } }] } },
    ]);
  });
});

describe(".slice — rejection branches", () => {
  it("zero args → 1-or-2 args error", () => {
    expect(() => jsmql("$$ = $$.slice();")).toThrow(/takes 1 or 2 arguments/);
  });

  it("three args → 1-or-2 args error", () => {
    expect(() => jsmql("$$ = $$.slice(0, 5, 10);")).toThrow(/takes 1 or 2 arguments/);
  });

  it("negative start → non-negative integer error", () => {
    expect(() => jsmql("$$ = $$.slice(-1, 5);")).toThrow(/non-negative integer literals/);
  });

  it("negative end → non-negative integer error", () => {
    expect(() => jsmql("$$ = $$.slice(0, -3);")).toThrow(/non-negative integer literals/);
  });

  it("fractional start → non-negative integer error", () => {
    expect(() => jsmql("$$ = $$.slice(1.5, 5);")).toThrow(/non-negative integer literals/);
  });

  it("end < start → ordered-bounds error", () => {
    expect(() => jsmql("$$ = $$.slice(10, 5);")).toThrow(/end >= start/);
  });

  it("non-literal argument → unsupported on streams error", () => {
    expect(() => jsmql("$$ = $$.slice($.offset, 5);")).toThrow(/requires non-negative integer literals/);
  });

  it("spread argument is rejected", () => {
    expect(() => jsmql("$$ = $$.slice(...[0, 5]);")).toThrow(/does not accept spread arguments/);
  });
});

describe(".concat(...others) — JS-idiomatic alias for $$.push", () => {
  it("spread of $$$.<coll> emits short-form $unionWith", () => {
    expect(jsmql("$$ = $$.concat(...$$$.archive);")).toEqual([{ $unionWith: "archive" }]);
  });

  it("inline doc batches into $documents", () => {
    expect(jsmql("$$ = $$.concat({ _id: 1, name: 'Alice' });")).toEqual([
      { $unionWith: { pipeline: [{ $documents: [{ _id: 1, name: "Alice" }] }] } },
    ]);
  });

  it(".find without spread emits $unionWith with $match + $limit:1", () => {
    expect(jsmql("$$ = $$.concat($$$.archive.find(u => u._id === 'X'));")).toEqual([
      { $unionWith: { coll: "archive", pipeline: [{ $match: { _id: "X" } }, { $limit: 1 }] } },
    ]);
  });

  it("chains after .filter — $match + $unionWith", () => {
    expect(jsmql("$$ = $$.filter(o => o.active === true).concat(...$$$.archive);")).toEqual([
      { $match: { active: true } },
      { $unionWith: "archive" },
    ]);
  });

  it("multi-arg concat emits one $unionWith per arg, source order preserved", () => {
    expect(jsmql("$$ = $$.concat({ a: 1 }, ...$$$.coll, { b: 2 });")).toEqual([
      { $unionWith: { pipeline: [{ $documents: [{ a: 1 }] }] } },
      { $unionWith: "coll" },
      { $unionWith: { pipeline: [{ $documents: [{ b: 2 }] }] } },
    ]);
  });

  it("zero args is rejected with an actionable message", () => {
    expect(() => jsmql("$$ = $$.concat();")).toThrow(/at least one argument/);
  });

  it("spread of a scalar `.find` is rejected", () => {
    expect(() => jsmql("$$ = $$.concat(...$$$.archive.find(u => u._id === 'X'));")).toThrow(
      /spreading isn't meaningful/,
    );
  });
});

describe(".map(d => <expr>) — chain-form per-doc reshape", () => {
  it("inline object body lowers to $replaceWith", () => {
    expect(jsmql("$$ = $$.map(d => ({ id: d._id, n: d.name }));")).toEqual([
      { $replaceWith: { id: "$_id", n: "$name" } },
    ]);
  });

  it("scalar arithmetic expression body lowers to $replaceWith", () => {
    expect(jsmql("$$ = $$.map(d => ({ total: d.price * d.qty }));")).toEqual([
      { $replaceWith: { total: { $multiply: ["$price", "$qty"] } } },
    ]);
  });

  it("composes after .filter — $match + $replaceWith", () => {
    expect(jsmql("$$ = $$.filter(o => o.tier === 'gold').map(d => ({ id: d._id }));")).toEqual([
      { $match: { tier: "gold" } },
      { $replaceWith: { id: "$_id" } },
    ]);
  });

  it("composes before .slice — $replaceWith + $limit", () => {
    expect(jsmql("$$ = $$.map(d => ({ n: d.name })).slice(0, 5);")).toEqual([
      { $replaceWith: { n: "$name" } },
      { $limit: 5 },
    ]);
  });

  it("works inside $$$.<coll> lookup body", () => {
    expect(jsmql("$$ = $$$.archive.filter(o => o.tier === 'gold').map(d => ({ n: d.name }));")).toEqual([
      { $limit: 0 },
      { $unionWith: { coll: "archive", pipeline: [{ $match: { tier: "gold" } }, { $replaceWith: { n: "$name" } }] } },
    ]);
  });

  it("zero args is rejected", () => {
    expect(() => jsmql("$$ = $$.map();")).toThrow(/takes exactly one argument/);
  });

  it("two-arg arrow `(d, i) => …` is rejected with a no-index hint", () => {
    expect(() => jsmql("$$ = $$.map((d, i) => ({ id: d._id, idx: i }));")).toThrow(
      /single-parameter arrow.*no per-doc index/,
    );
  });

  // (Block-body arrows like `d => { … }` are caught by the parser before .map's
  // validator runs in expression contexts, so a dedicated codegen-level test
  // isn't reachable from the public surface; the rejection branch in .map's
  // validator stays as a defence-in-depth guard.)

  it("`$.<field>` inside .map body is rejected — must use the lambda param", () => {
    expect(() => jsmql("$$ = $$.map(d => ({ n: $.name }));")).toThrow(/'\$\.<field>'.*use the lambda parameter/);
  });

  it("lookup inside .map body is rejected for v1", () => {
    expect(() => jsmql("$$ = $$.map(d => ({ a: $$$.archive.find(x => x._id === d._id) }));")).toThrow(
      /inside a '\.map.*hoist/,
    );
  });
});

describe(".toSorted((a, b) => …) — comparator → $sort", () => {
  it("ascending: a.x - b.x → { x: 1 }", () => {
    expect(jsmql("$$ = $$.toSorted((a, b) => a.age - b.age);")).toEqual([{ $sort: { age: 1 } }]);
  });

  it("descending: b.x - a.x → { x: -1 }", () => {
    expect(jsmql("$$ = $$.toSorted((a, b) => b.score - a.score);")).toEqual([{ $sort: { score: -1 } }]);
  });

  it("compound: a.x - b.x || b.y - a.y → { x: 1, y: -1 }", () => {
    expect(jsmql("$$ = $$.toSorted((a, b) => a.x - b.x || b.y - a.y);")).toEqual([{ $sort: { x: 1, y: -1 } }]);
  });

  it("three-term compound sort preserves source order", () => {
    expect(jsmql("$$ = $$.toSorted((a, b) => a.x - b.x || a.y - b.y || b.z - a.z);")).toEqual([
      { $sort: { x: 1, y: 1, z: -1 } },
    ]);
  });

  it("nested field path: a.profile.age - b.profile.age", () => {
    expect(jsmql("$$ = $$.toSorted((a, b) => a.profile.age - b.profile.age);")).toEqual([
      { $sort: { "profile.age": 1 } },
    ]);
  });

  it("composes after .filter — $match + $sort", () => {
    expect(jsmql("$$ = $$.filter(o => o.active === true).toSorted((a, b) => a.age - b.age);")).toEqual([
      { $match: { active: true } },
      { $sort: { age: 1 } },
    ]);
  });

  it("composes with .slice — $sort + $skip + $limit (a top-N pattern)", () => {
    expect(jsmql("$$ = $$.toSorted((a, b) => b.score - a.score).slice(0, 10);")).toEqual([
      { $sort: { score: -1 } },
      { $limit: 10 },
    ]);
  });

  it("zero-arg .toSorted() is rejected with a 'no natural ordering' hint", () => {
    expect(() => jsmql("$$ = $$.toSorted();")).toThrow(/no natural document ordering/);
  });

  it("one-param arrow is rejected with a 'two-parameter' hint", () => {
    expect(() => jsmql("$$ = $$.toSorted(x => x.age);")).toThrow(/two-parameter arrow/);
  });

  it("non-comparator body is rejected", () => {
    expect(() => jsmql("$$ = $$.toSorted((a, b) => a.x + b.x);")).toThrow(
      /accepts only.*ascending.*descending.*compound/s,
    );
  });

  it("mismatched paths in subtraction are rejected", () => {
    expect(() => jsmql("$$ = $$.toSorted((a, b) => a.x - b.y);")).toThrow(/accepts only/);
  });
});

describe(".toReversed() — flips the preceding $sort", () => {
  it("after ascending .toSorted → descending $sort", () => {
    expect(jsmql("$$ = $$.toSorted((a, b) => a.age - b.age).toReversed();")).toEqual([{ $sort: { age: -1 } }]);
  });

  it("after descending .toSorted → ascending $sort", () => {
    expect(jsmql("$$ = $$.toSorted((a, b) => b.score - a.score).toReversed();")).toEqual([{ $sort: { score: 1 } }]);
  });

  it("compound sort: every key flips", () => {
    expect(jsmql("$$ = $$.toSorted((a, b) => a.x - b.x || b.y - a.y).toReversed();")).toEqual([
      { $sort: { x: -1, y: 1 } },
    ]);
  });

  it("composes with .slice — $sort + $limit (top-N bottom-first)", () => {
    expect(jsmql("$$ = $$.toSorted((a, b) => a.score - b.score).toReversed().slice(0, 3);")).toEqual([
      { $sort: { score: -1 } },
      { $limit: 3 },
    ]);
  });

  it("works inside the $$$.<coll> lookup body", () => {
    expect(
      jsmql("$$ = $$$.archive.filter(o => o.active === true).toSorted((a, b) => a.x - b.x).toReversed();"),
    ).toEqual([
      { $limit: 0 },
      { $unionWith: { coll: "archive", pipeline: [{ $match: { active: true } }, { $sort: { x: -1 } }] } },
    ]);
  });

  it("without a preceding .toSorted is rejected", () => {
    expect(() => jsmql("$$ = $$.toReversed();")).toThrow(/needs a preceding \.toSorted/);
  });

  it("after a non-$sort stage (e.g. .slice) is rejected", () => {
    expect(() => jsmql("$$ = $$.slice(0, 10).toReversed();")).toThrow(/needs a preceding \.toSorted/);
  });

  it("rejects positional args", () => {
    expect(() => jsmql("$$ = $$.toSorted((a, b) => a.x - b.x).toReversed(1);")).toThrow(/takes no arguments/);
  });
});

describe(".flatMap(d => d.<path>) — chain-form $unwind", () => {
  it("bare field path lowers to $unwind", () => {
    expect(jsmql("$$ = $$.flatMap(d => d.items);")).toEqual([{ $unwind: "$items" }]);
  });

  it("nested field path lowers to $unwind on the dotted path", () => {
    expect(jsmql("$$ = $$.flatMap(d => d.profile.tags);")).toEqual([{ $unwind: "$profile.tags" }]);
  });

  it("composes after .filter and before .map (the JS-faithful unwind+project pattern)", () => {
    expect(
      jsmql("$$ = $$.filter(o => o.active === true).flatMap(d => d.items).map(d => ({ item: d.items }));"),
    ).toEqual([{ $match: { active: true } }, { $unwind: "$items" }, { $replaceWith: { item: "$items" } }]);
  });

  it("works inside $$$.<coll> lookup body", () => {
    expect(jsmql("$$ = $$$.orders.filter(o => o.shipped === true).flatMap(d => d.items);")).toEqual([
      { $limit: 0 },
      { $unionWith: { coll: "orders", pipeline: [{ $match: { shipped: true } }, { $unwind: "$items" }] } },
    ]);
  });

  it("non-path body is rejected with a 'hoist to a separate stage' hint", () => {
    expect(() => jsmql("$$ = $$.flatMap(d => d.items.map(x => x * 2));")).toThrow(/bare field-path body.*hoist/);
  });

  it("zero-arg body is rejected (no path → not derivable)", () => {
    expect(() => jsmql("$$ = $$.flatMap(d => 5);")).toThrow(/bare field-path body/);
  });

  it("two-param arrow is rejected", () => {
    expect(() => jsmql("$$ = $$.flatMap((d, i) => d.items);")).toThrow(/single-parameter arrow/);
  });
});

describe(".reduce((acc, d) => …, <init>) on $$ — fold-to-aggregate via $group", () => {
  it("acc + d.<field> → $sum on the field", () => {
    expect(jsmql("$$ = $$.reduce((acc, d) => acc + d.amount, 0);")).toEqual([
      { $group: { _id: null, value: { $sum: "$amount" } } },
    ]);
  });

  it("acc + 1 → $sum: 1 (count documents)", () => {
    expect(jsmql("$$ = $$.reduce((acc, d) => acc + 1, 0);")).toEqual([{ $group: { _id: null, value: { $sum: 1 } } }]);
  });

  it("Math.max(acc, d.<field>) → $max", () => {
    expect(jsmql("$$ = $$.reduce((acc, d) => Math.max(acc, d.score), 0);")).toEqual([
      { $group: { _id: null, value: { $max: "$score" } } },
    ]);
  });

  it("Math.min(acc, d.<field>) → $min", () => {
    expect(jsmql("$$ = $$.reduce((acc, d) => Math.min(acc, d.score), 0);")).toEqual([
      { $group: { _id: null, value: { $min: "$score" } } },
    ]);
  });

  it("commutative order: d.<field> + acc → $sum", () => {
    expect(jsmql("$$ = $$.reduce((acc, d) => d.amount + acc, 0);")).toEqual([
      { $group: { _id: null, value: { $sum: "$amount" } } },
    ]);
  });

  it("composes after .filter — $match + $group", () => {
    expect(jsmql("$$ = $$.filter(o => o.tier === 'gold').reduce((acc, d) => acc + d.amount, 0);")).toEqual([
      { $match: { tier: "gold" } },
      { $group: { _id: null, value: { $sum: "$amount" } } },
    ]);
  });

  it("works inside $$$.<coll> lookup body", () => {
    expect(jsmql("$$ = $$$.archive.filter(o => o.active === true).reduce((acc, d) => acc + 1, 0);")).toEqual([
      { $limit: 0 },
      {
        $unionWith: {
          coll: "archive",
          pipeline: [{ $match: { active: true } }, { $group: { _id: null, value: { $sum: 1 } } }],
        },
      },
    ]);
  });

  it("zero args is rejected", () => {
    expect(() => jsmql("$$ = $$.reduce();")).toThrow(/takes exactly two arguments/);
  });

  it("one arg is rejected (init is mandatory)", () => {
    expect(() => jsmql("$$ = $$.reduce((acc, d) => acc + d.x);")).toThrow(/takes exactly two arguments/);
  });

  it("one-param arrow is rejected", () => {
    expect(() => jsmql("$$ = $$.reduce(acc => acc + 1, 0);")).toThrow(/two-parameter arrow/);
  });

  it("non-literal init is rejected", () => {
    expect(() => jsmql("$$ = $$.reduce((acc, d) => acc + d.x, $.seed);")).toThrow(/initial value must be a literal/);
  });

  it("unrecognised body shape is rejected with a v1-supported-shapes list", () => {
    expect(() => jsmql("$$ = $$.reduce((acc, d) => acc * d.x, 1);")).toThrow(
      /v1 supports only these reducer shapes.*\$sum.*\$max.*\$min/s,
    );
  });
});

describe("unknown chain method on $$ → registry error with hint", () => {
  it("typo like .slise is corrected via 'did you mean .slice?'", () => {
    expect(() => jsmql("$$ = $$.slise(0, 5);")).toThrow(/Did you mean '\.slice'/);
  });

  it("unknown method after a valid .filter still surfaces the registry list", () => {
    expect(() => jsmql("$$ = $$.filter(o => o.active).bogus();")).toThrow(/is not a chainable stream method on '\$\$'/);
  });
});
