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
      { $match: { $expr: false } },
      { $unionWith: { coll: "archive", pipeline: [{ $limit: 5 }] } },
    ]);
  });

  it(".filter then .slice runs both stages inside the $unionWith body", () => {
    expect(jsmql("$$ = $$$.archive.filter(o => o.tier === 'gold').slice(0, 10);")).toEqual([
      { $match: { $expr: false } },
      { $unionWith: { coll: "archive", pipeline: [{ $match: { tier: "gold" } }, { $limit: 10 }] } },
    ]);
  });

  it("cross-database $$$$.<db>.<coll>.filter(...).slice(...)", () => {
    expect(jsmql("$$ = $$$$.archive.users.filter(u => u.tier === 'gold').slice(0, 5);")).toEqual([
      { $match: { $expr: false } },
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
      { $match: { $expr: false } },
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
      { $match: { $expr: false } },
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

  it("lookup inside .map body materialises into prologue $lookup + $set, $replaceWith reads the slot", () => {
    expect(jsmql("$$ = $$.map(d => ({ a: $$$.archive.find(x => x._id === d._id) }));")).toEqual([
      { $lookup: { from: "archive", localField: "_id", foreignField: "_id", as: "__jsmql.__lookup1" } },
      { $set: { "__jsmql.__lookup1": { $first: "$__jsmql.__lookup1" } } },
      { $replaceWith: { a: "$__jsmql.__lookup1" } },
    ]);
  });

  it(".filter + .map with internal lookup composes — $match, $lookup, $set, $replaceWith", () => {
    expect(
      jsmql(
        "$$ = $$.filter(o => o.active === true).map(d => ({ id: d._id, archived: $$$.archive.find(x => x._id === d._id) }));",
      ),
    ).toEqual([
      { $match: { active: true } },
      { $lookup: { from: "archive", localField: "_id", foreignField: "_id", as: "__jsmql.__lookup1" } },
      { $set: { "__jsmql.__lookup1": { $first: "$__jsmql.__lookup1" } } },
      { $replaceWith: { id: "$_id", archived: "$__jsmql.__lookup1" } },
    ]);
  });

  it("array-valued .filter lookup inside .map body uses the pipeline-form $lookup (no $first wrap)", () => {
    expect(jsmql("$$ = $$.map(d => ({ id: d._id, items: $$$.archive.filter(x => x.userId === d._id) }));")).toEqual([
      { $lookup: { from: "archive", localField: "_id", foreignField: "userId", as: "__jsmql.__lookup1" } },
      { $replaceWith: { id: "$_id", items: "$__jsmql.__lookup1" } },
    ]);
  });

  it("lookup inside .map body of a `$$$.<coll>.<chain>` RHS lands as a nested $lookup inside the $unionWith.pipeline", () => {
    expect(
      jsmql("$$ = $$$.users.filter(u => u.active === true).map(d => ({ a: $$$.archive.find(x => x._id === d._id) }));"),
    ).toEqual([
      { $match: { $expr: false } },
      {
        $unionWith: {
          coll: "users",
          pipeline: [
            { $match: { active: true } },
            { $lookup: { from: "archive", localField: "_id", foreignField: "_id", as: "__jsmql.__lookup1" } },
            { $set: { "__jsmql.__lookup1": { $first: "$__jsmql.__lookup1" } } },
            { $replaceWith: { a: "$__jsmql.__lookup1" } },
          ],
        },
      },
      { $unset: "__jsmql" },
    ]);
  });

  it("pipeline-form predicate (correlates against outer-doc fields via $lookup.let) works nested inside $unionWith.pipeline", () => {
    expect(
      jsmql(
        "$$ = $$$.users.filter(u => u.active === true).map(d => ({ archives: $$$.archive.filter(x => x.userId === d._id && x.tier === d.tier) }));",
      ),
    ).toEqual([
      { $match: { $expr: false } },
      {
        $unionWith: {
          coll: "users",
          pipeline: [
            { $match: { active: true } },
            {
              $lookup: {
                from: "archive",
                let: { v_id: "$_id", tier: "$tier" },
                pipeline: [
                  { $match: { $expr: { $and: [{ $eq: ["$userId", "$$v_id"] }, { $eq: ["$tier", "$$tier"] }] } } },
                ],
                as: "__jsmql.__lookup1",
              },
            },
            { $replaceWith: { archives: "$__jsmql.__lookup1" } },
          ],
        },
      },
      { $unset: "__jsmql" },
    ]);
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
      { $match: { $expr: false } },
      { $unionWith: { coll: "archive", pipeline: [{ $match: { active: true } }, { $sort: { x: -1 } }] } },
    ]);
  });

  it("without a preceding .toSorted is rejected", () => {
    expect(() => jsmql("$$ = $$.toReversed();")).toThrow(/needs a preceding \$sort/);
  });

  it("after a non-$sort stage (e.g. .slice) is rejected", () => {
    expect(() => jsmql("$$ = $$.slice(0, 10).toReversed();")).toThrow(/needs a preceding \$sort/);
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
      { $match: { $expr: false } },
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

describe("$$ = [{ key: $$.reduce(…) }] wrap — JS-faithful fold-to-summary via $group + $replaceWith", () => {
  it("single $sum accumulator → $group + $replaceWith dropping _id", () => {
    expect(jsmql("$$ = [{ total: $$.reduce((acc, d) => acc + d.amount, 0) }];")).toEqual([
      { $group: { _id: null, total: { $sum: "$amount" } } },
      { $replaceWith: { total: "$total" } },
    ]);
  });

  it("count: acc + 1 → $sum: 1", () => {
    expect(jsmql("$$ = [{ count: $$.reduce((acc, d) => acc + 1, 0) }];")).toEqual([
      { $group: { _id: null, count: { $sum: 1 } } },
      { $replaceWith: { count: "$count" } },
    ]);
  });

  it("Math.max → $max accumulator", () => {
    expect(jsmql("$$ = [{ best: $$.reduce((acc, d) => Math.max(acc, d.score), 0) }];")).toEqual([
      { $group: { _id: null, best: { $max: "$score" } } },
      { $replaceWith: { best: "$best" } },
    ]);
  });

  it("Math.min → $min accumulator", () => {
    expect(jsmql("$$ = [{ worst: $$.reduce((acc, d) => Math.min(acc, d.score), 0) }];")).toEqual([
      { $group: { _id: null, worst: { $min: "$score" } } },
      { $replaceWith: { worst: "$worst" } },
    ]);
  });

  it("multiple keyed accumulators share one $group", () => {
    expect(
      jsmql(
        "$$ = [{ count: $$.reduce((acc, d) => acc + 1, 0), total: $$.reduce((acc, d) => acc + d.amount, 0), best: $$.reduce((acc, d) => Math.max(acc, d.score), 0) }];",
      ),
    ).toEqual([
      { $group: { _id: null, count: { $sum: 1 }, total: { $sum: "$amount" }, best: { $max: "$score" } } },
      { $replaceWith: { count: "$count", total: "$total", best: "$best" } },
    ]);
  });

  it("commutative reducer order: d.<field> + acc → $sum", () => {
    expect(jsmql("$$ = [{ total: $$.reduce((acc, d) => d.amount + acc, 0) }];")).toEqual([
      { $group: { _id: null, total: { $sum: "$amount" } } },
      { $replaceWith: { total: "$total" } },
    ]);
  });

  it("zero args inside the wrap is rejected with the reduce-arity error", () => {
    expect(() => jsmql("$$ = [{ total: $$.reduce() }];")).toThrow(/takes exactly two arguments/);
  });

  it("one-param reducer arrow inside the wrap is rejected", () => {
    expect(() => jsmql("$$ = [{ total: $$.reduce(acc => acc + 1, 0) }];")).toThrow(/two-parameter arrow/);
  });

  it("non-literal init inside the wrap is rejected", () => {
    expect(() => jsmql("$$ = [{ total: $$.reduce((acc, d) => acc + d.x, $.seed) }];")).toThrow(
      /initial value must be a literal/,
    );
  });

  it("unrecognised reducer body inside the wrap is rejected with the v1-shapes list", () => {
    expect(() => jsmql("$$ = [{ total: $$.reduce((acc, d) => acc * d.x, 1) }];")).toThrow(
      /v1 supports only these reducer shapes.*\$sum.*\$max.*\$min/s,
    );
  });
});

describe("$$ = [$$.reduce((acc, d) => ({...acc, …}), {…})] — object-returning reducer wrap", () => {
  it("single keyed accumulator with spread of acc → $group + $replaceWith", () => {
    expect(jsmql("$$ = [$$.reduce((acc, d) => ({ ...acc, count: acc.count + 1 }), { count: 0 })];")).toEqual([
      { $group: { _id: null, count: { $sum: 1 } } },
      { $replaceWith: { count: "$count" } },
    ]);
  });

  it("multiple keyed accumulators in one reducer → one $group across all keys", () => {
    expect(
      jsmql(
        "$$ = [$$.reduce((acc, d) => ({ ...acc, count: acc.count + 1, total: acc.total + d.amount, best: Math.max(acc.best, d.score) }), { count: 0, total: 0, best: 0 })];",
      ),
    ).toEqual([
      { $group: { _id: null, count: { $sum: 1 }, total: { $sum: "$amount" }, best: { $max: "$score" } } },
      { $replaceWith: { count: "$count", total: "$total", best: "$best" } },
    ]);
  });

  it("body without spread of acc is accepted (init keys still must match body keys)", () => {
    expect(jsmql("$$ = [$$.reduce((acc, d) => ({ total: acc.total + d.amount }), { total: 0 })];")).toEqual([
      { $group: { _id: null, total: { $sum: "$amount" } } },
      { $replaceWith: { total: "$total" } },
    ]);
  });

  it("Math.min on a keyed accumulator → $min", () => {
    expect(jsmql("$$ = [$$.reduce((acc, d) => ({ ...acc, low: Math.min(acc.low, d.score) }), { low: 0 })];")).toEqual([
      { $group: { _id: null, low: { $min: "$score" } } },
      { $replaceWith: { low: "$low" } },
    ]);
  });

  it("non-object reducer body is rejected with a pointer at the scalar wrap", () => {
    expect(() => jsmql("$$ = [$$.reduce((acc, d) => acc + d.amount, 0)];")).toThrow(
      /requires the reducer to return an object literal.*\$\$ = \[\{ <key>: \$\$\.reduce/s,
    );
  });

  it("non-object init is rejected with a hint", () => {
    expect(() => jsmql("$$ = [$$.reduce((acc, d) => ({ ...acc, count: acc.count + 1 }), 0)];")).toThrow(
      /requires an object init that names each accumulator key/,
    );
  });

  it("body and init keys must match — extra body key is rejected", () => {
    expect(() =>
      jsmql("$$ = [$$.reduce((acc, d) => ({ count: acc.count + 1, total: acc.total + d.amount }), { count: 0 })];"),
    ).toThrow(/body and init must declare the same keys.*init is missing keys.*total/s);
  });

  it("body and init keys must match — extra init key is rejected", () => {
    expect(() => jsmql("$$ = [$$.reduce((acc, d) => ({ count: acc.count + 1 }), { count: 0, total: 0 })];")).toThrow(
      /body and init must declare the same keys.*body is missing keys.*total/s,
    );
  });

  it("spread of something other than acc is rejected", () => {
    expect(() => jsmql("$$ = [$$.reduce((acc, d) => ({ ...d, count: acc.count + 1 }), { count: 0 })];")).toThrow(
      /may only spread the accumulator parameter/,
    );
  });

  it("spread after named entries is rejected (position matters in v1)", () => {
    expect(() => jsmql("$$ = [$$.reduce((acc, d) => ({ count: acc.count + 1, ...acc }), { count: 0 })];")).toThrow(
      /spread must be the first entry/,
    );
  });

  it("entry referencing acc.<otherKey> instead of acc.<sameKey> is rejected", () => {
    // `total: acc.count + d.amount` references acc.count, not acc.total — a
    // semantic mismatch that JS would silently accept but mean something
    // different from the user's intent. The v1-shapes message names the
    // expected accumulator side.
    expect(() =>
      jsmql(
        "$$ = [$$.reduce((acc, d) => ({ count: acc.count + 1, total: acc.count + d.amount }), { count: 0, total: 0 })];",
      ),
    ).toThrow(/Each entry must reference 'acc\.total' as the accumulator side/);
  });

  it("unrecognised body-entry shape is rejected with the v1-shapes list", () => {
    expect(() => jsmql("$$ = [$$.reduce((acc, d) => ({ total: acc.total * d.x }), { total: 1 })];")).toThrow(
      /v1 supports only.*\$sum.*\$max.*\$min/s,
    );
  });
});

describe("reducer body shapes — $first / $last / $push", () => {
  // Three additional accumulator shapes beyond the original $sum / $max / $min:
  //   - `<acc> ?? d.<path>`  → $first  (JS nullish-coalesce picks first non-null)
  //   - `d.<path>`           → $last   (body ignores acc, every doc overwrites)
  //   - `[...<acc>, d.<path>]` or `<acc>.concat(d.<path>)` → $push

  it("scalar wrap: acc ?? d.<path> → $first", () => {
    expect(jsmql("$$ = [{ firstName: $$.reduce((acc, d) => acc ?? d.name, null) }];")).toEqual([
      { $group: { _id: null, firstName: { $first: "$name" } } },
      { $replaceWith: { firstName: "$firstName" } },
    ]);
  });

  it("scalar wrap: bare d.<path> body → $last", () => {
    expect(jsmql("$$ = [{ latestName: $$.reduce((acc, d) => d.name, null) }];")).toEqual([
      { $group: { _id: null, latestName: { $last: "$name" } } },
      { $replaceWith: { latestName: "$latestName" } },
    ]);
  });

  it("object-reducer: mix of $first, $last, $push in one body", () => {
    expect(
      jsmql(
        "$$ = [$$.reduce((acc, d) => ({ ...acc, firstName: acc.firstName ?? d.name, latestTs: d.timestamp, allIds: [...acc.allIds, d.id] }), { firstName: null, latestTs: null, allIds: [] })];",
      ),
    ).toEqual([
      {
        $group: {
          _id: null,
          firstName: { $first: "$name" },
          latestTs: { $last: "$timestamp" },
          allIds: { $push: "$id" },
        },
      },
      { $replaceWith: { firstName: "$firstName", latestTs: "$latestTs", allIds: "$allIds" } },
    ]);
  });

  it("$push via .concat spelling — acc.<key>.concat(d.<path>)", () => {
    expect(
      jsmql("$$ = [$$.reduce((acc, d) => ({ ...acc, items: acc.items.concat(d.label) }), { items: [] })];"),
    ).toEqual([{ $group: { _id: null, items: { $push: "$label" } } }, { $replaceWith: { items: "$items" } }]);
  });

  it("$first works on a nested doc path", () => {
    expect(jsmql("$$ = [{ firstEmail: $$.reduce((acc, d) => acc ?? d.user.email, null) }];")).toEqual([
      { $group: { _id: null, firstEmail: { $first: "$user.email" } } },
      { $replaceWith: { firstEmail: "$firstEmail" } },
    ]);
  });
});

describe("$$ = [$$.reduce((acc, d) => ({...acc, [d.<k>]: <v>}), {})] — dict-build reducer wrap", () => {
  // The single-computed-key form of the object-returning reducer. Lowers to
  // $group + $arrayToObject — the runtime keys come from `d.<keyPath>`, the
  // values from `d.<valPath>` or `d` itself.

  it("basic shape: `{...acc, [d.id]: d.name}` → $arrayToObject", () => {
    expect(jsmql("$$ = [$$.reduce((acc, d) => ({ ...acc, [d.id]: d.name }), {})];")).toEqual([
      { $group: { _id: null, __jsmqlDict: { $push: { k: "$id", v: "$name" } } } },
      { $replaceWith: { $arrayToObject: "$__jsmqlDict" } },
    ]);
  });

  it("nested key path: `{...acc, [d.user.email]: d.score}`", () => {
    expect(jsmql("$$ = [$$.reduce((acc, d) => ({ ...acc, [d.user.email]: d.score }), {})];")).toEqual([
      { $group: { _id: null, __jsmqlDict: { $push: { k: "$user.email", v: "$score" } } } },
      { $replaceWith: { $arrayToObject: "$__jsmqlDict" } },
    ]);
  });

  it("bare-doc value (`[d.id]: d`) uses $$ROOT", () => {
    expect(jsmql("$$ = [$$.reduce((acc, d) => ({ ...acc, [d.id]: d }), {})];")).toEqual([
      { $group: { _id: null, __jsmqlDict: { $push: { k: "$id", v: "$$ROOT" } } } },
      { $replaceWith: { $arrayToObject: "$__jsmqlDict" } },
    ]);
  });

  it("optional leading `...acc` spread", () => {
    // The user might write `{ [d.id]: d.name }` without the spread — same
    // shape, same lowering. (In JS this would discard prior keys per
    // iteration, which is fine because the $group accumulator does the
    // accumulation; the spread is JS-faithful boilerplate.)
    expect(jsmql("$$ = [$$.reduce((acc, d) => ({ [d.id]: d.name }), {})];")).toEqual([
      { $group: { _id: null, __jsmqlDict: { $push: { k: "$id", v: "$name" } } } },
      { $replaceWith: { $arrayToObject: "$__jsmqlDict" } },
    ]);
  });

  it("composes with a preceding $match", () => {
    expect(jsmql("$match($.active === true); $$ = [$$.reduce((acc, d) => ({ ...acc, [d.id]: d.name }), {})]")).toEqual([
      { $match: { active: true } },
      { $group: { _id: null, __jsmqlDict: { $push: { k: "$id", v: "$name" } } } },
      { $replaceWith: { $arrayToObject: "$__jsmqlDict" } },
    ]);
  });

  it("falls through to the static-key object-reducer when keys mix computed + static (existing error path)", () => {
    // `({ ...acc, [d.id]: d.name, count: acc.count + 1 })` is no longer pure
    // dict-build; the existing object-reducer path picks it up and reports
    // "computed keys aren't supported" with the precise error.
    expect(() =>
      jsmql("$$ = [$$.reduce((acc, d) => ({ ...acc, [d.id]: d.name, count: acc.count + 1 }), { count: 0 })];"),
    ).toThrow(/Object-reducer body entry must have a static key/);
  });

  it("rejects non-empty init via the object-reducer's missing-keys check", () => {
    // Non-empty init falls through to the object-reducer detector, which
    // expects body and init to declare the same keys.
    expect(() => jsmql("$$ = [$$.reduce((acc, d) => ({ ...acc, [d.id]: d.name }), { fallback: null })];")).toThrow(
      /Object-reducer body entry must have a static key/,
    );
  });
});

describe("$$ = $$.reduce((acc, d) => (cond ? acc.concat(d.<path>) : acc), []) — array-returning reducer (unbracketed)", () => {
  it("filter + map (the user's example): truthy-and-truthy ternary → $match($expr) + $replaceWith", () => {
    // The condition `d.active && d.contactDetails.email` goes through the
    // same JS-faithful `&&` short-circuit translation `.filter` uses — `a &&
    // b` returns `b` when `a` is truthy, else `a`, encoded as `$cond` with
    // the four-way truthy guard on `a`.
    expect(
      jsmql(
        "$$ = $$.reduce((acc, d) => (d.active && d.contactDetails.email ? acc.concat(d.contactDetails) : acc), []);",
      ),
    ).toEqual([
      {
        $match: {
          $expr: {
            $cond: {
              if: {
                $and: [
                  { $ne: ["$active", null] },
                  { $ne: ["$active", false] },
                  { $ne: ["$active", ""] },
                  { $ne: ["$active", 0] },
                ],
              },
              then: "$contactDetails.email",
              else: "$active",
            },
          },
        },
      },
      { $replaceWith: "$contactDetails" },
    ]);
  });

  it("query-form predicate (translatable to query doc) → $match + $replaceWith", () => {
    expect(jsmql("$$ = $$.reduce((acc, d) => (d.tier === 'gold' ? acc.concat(d.profile) : acc), []);")).toEqual([
      { $match: { tier: "gold" } },
      { $replaceWith: "$profile" },
    ]);
  });

  it("unconditional map (no ternary): just $replaceWith", () => {
    expect(jsmql("$$ = $$.reduce((acc, d) => acc.concat(d.contactDetails), []);")).toEqual([
      { $replaceWith: "$contactDetails" },
    ]);
  });

  it("filter-only via bare `d` projection (identity): just $match, no $replaceWith", () => {
    expect(jsmql("$$ = $$.reduce((acc, d) => (d.active === true ? acc.concat(d) : acc), []);")).toEqual([
      { $match: { active: true } },
    ]);
  });

  it("unconditional identity: zero stages (no-op)", () => {
    expect(jsmql("$$ = $$.reduce((acc, d) => acc.concat(d), []);")).toEqual([]);
  });

  it("the legacy bracketed form is rejected — a stream needn't be wrapped in `[ ]`", () => {
    expect(() => jsmql("$$ = [$$.reduce((acc, d) => acc.concat(d.contactDetails), [])];")).toThrow(
      /already produces a stream.*don't wrap it in '\[ \]'.*\$\$ = \$\$\.reduce/s,
    );
  });

  it("non-empty init array is rejected", () => {
    expect(() => jsmql("$$ = $$.reduce((acc, d) => acc.concat(d.contactDetails), [1, 2]);")).toThrow(
      /init to be '\[\]'.*no MQL accumulator preserves/,
    );
  });

  it("body alternate must be bare `acc` — `cond ? concat : <other>` is rejected", () => {
    expect(() => jsmql("$$ = $$.reduce((acc, d) => (d.active ? acc.concat(d.contactDetails) : []), []);")).toThrow(
      /Array-returning reducer body.*v1 supports only/s,
    );
  });

  it("non-concat body is rejected with the v1-shapes list", () => {
    expect(() => jsmql("$$ = $$.reduce((acc, d) => acc.push(d.contactDetails), []);")).toThrow(
      /Array-returning reducer body.*\.concat\(/s,
    );
  });

  it("concat with multi-element wrapper is rejected (v1 wants a bare path or `d`)", () => {
    expect(() => jsmql("$$ = $$.reduce((acc, d) => acc.concat([d.x, d.y]), []);")).toThrow(
      /Array-returning reducer body.*v1 supports only/s,
    );
  });

  it("`$.<field>` inside the condition is rejected — must use the lambda parameter", () => {
    expect(() => jsmql("$$ = $$.reduce((acc, d) => ($.active ? acc.concat(d.contactDetails) : acc), []);")).toThrow(
      /'\$\.<field>'.*use the lambda parameter/,
    );
  });
});

describe(".reduce as a chain method on $$ — rejected with wrap-pattern hint", () => {
  it("bare $$ = $$.reduce(...) is rejected (would collapse the stream to a scalar)", () => {
    expect(() => jsmql("$$ = $$.reduce((acc, d) => acc + d.amount, 0);")).toThrow(
      /'\.reduce\(\.\.\.\)' is not a chain method.*Wrap the reduce result.*\$\$ = \[\{ <key>: \$\$\.reduce/s,
    );
  });

  it("$$ = $$.filter(p).reduce(...) is rejected (same reason)", () => {
    expect(() => jsmql("$$ = $$.filter(o => o.tier === 'gold').reduce((acc, d) => acc + d.amount, 0);")).toThrow(
      /'\.reduce\(\.\.\.\)' is not a chain method.*Wrap the reduce result/s,
    );
  });

  it("single-doc ArrayLiteral at stage 0 lowers to `$documents` (seeder sugar)", () => {
    expect(jsmql("$$ = [{ x: 1 }];")).toEqual([{ $documents: [{ x: 1 }] }]);
  });

  it("multi-element ArrayLiteral at stage 0 lowers to `$documents`", () => {
    expect(jsmql("$$ = [{ a: 1 }, { b: 2 }];")).toEqual([{ $documents: [{ a: 1 }, { b: 2 }] }]);
  });

  it("multi-element ArrayLiteral mid-pipeline points at `$$.push` as the seeder alternative", () => {
    expect(() => jsmql("$match($.active === true); $$ = [{ a: 1 }, { b: 2 }];")).toThrow(/\$\$\.push\(\{\.\.\.\}/);
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

describe("bare-statement stream chain (no `$$ =` head) — sugar for `$$ = $$.<chain>`", () => {
  // Each registered array→array method works as a standalone statement,
  // lowering identically to the explicit-assignment form.
  it(".filter → $match", () => {
    expect(jsmql("$$.filter(o => o.tier === 'gold');")).toEqual([{ $match: { tier: "gold" } }]);
  });

  it(".map → $replaceWith", () => {
    expect(jsmql("$$.map(d => ({ id: d._id }));")).toEqual([{ $replaceWith: { id: "$_id" } }]);
  });

  it(".slice → $skip + $limit", () => {
    expect(jsmql("$$.slice(2, 5);")).toEqual([{ $skip: 2 }, { $limit: 3 }]);
  });

  it(".concat → $unionWith", () => {
    expect(jsmql("$$.concat(...$$$.archive);")).toEqual([{ $unionWith: "archive" }]);
  });

  it(".toSorted → $sort", () => {
    expect(jsmql("$$.toSorted((a, b) => a.age - b.age);")).toEqual([{ $sort: { age: 1 } }]);
  });

  it(".flatMap → $unwind", () => {
    expect(jsmql("$$.flatMap(d => d.items);")).toEqual([{ $unwind: "$items" }]);
  });

  it("chained .filter(p).map(f) → $match + $replaceWith", () => {
    expect(jsmql("$$.filter(o => o.tier === 'gold').map(d => ({ id: d._id }));")).toEqual([
      { $match: { tier: "gold" } },
      { $replaceWith: { id: "$_id" } },
    ]);
  });

  // The core equivalence the feature promises: chained ≡ split ≡ assignment.
  it("filter().map(): chained ≡ split ≡ assignment", () => {
    const chained = jsmql("$$.filter(o => o.tier === 'gold').map(d => ({ id: d._id }));");
    const split = jsmql("$$.filter(o => o.tier === 'gold'); $$.map(d => ({ id: d._id }));");
    const assigned = jsmql("$$ = $$.filter(o => o.tier === 'gold').map(d => ({ id: d._id }));");
    const expected = [{ $match: { tier: "gold" } }, { $replaceWith: { id: "$_id" } }];
    expect(chained).toEqual(expected);
    expect(split).toEqual(expected);
    expect(assigned).toEqual(expected);
  });

  // The crux: .toReversed() composes against the live pipeline, so splitting
  // it from its .toSorted() into a separate statement still flips the $sort.
  it("toSorted().toReversed(): chained ≡ split (cross-statement) ≡ assignment", () => {
    const chained = jsmql("$$.toSorted((a, b) => a.age - b.age).toReversed();");
    const split = jsmql("$$.toSorted((a, b) => a.age - b.age); $$.toReversed();");
    const assigned = jsmql("$$ = $$.toSorted((a, b) => a.age - b.age).toReversed();");
    const expected = [{ $sort: { age: -1 } }];
    expect(chained).toEqual(expected);
    expect(split).toEqual(expected);
    expect(assigned).toEqual(expected);
  });

  it("bare .toReversed() inverts a preceding literal $sort stage", () => {
    expect(jsmql("$sort({ age: 1 }); $$.toReversed();")).toEqual([{ $sort: { age: -1 } }]);
  });

  it("bare .toReversed() with no preceding sort is rejected with the new wording", () => {
    expect(() => jsmql("$$.toReversed();")).toThrow(/needs a preceding \$sort/);
  });

  it("unknown bare chain method surfaces the registry hint", () => {
    expect(() => jsmql("$$.slise(0, 5);")).toThrow(/Did you mean '\.slice'/);
  });
});
