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

describe("unknown chain method on $$ → registry error with hint", () => {
  it("typo like .slise is corrected via 'did you mean .slice?'", () => {
    expect(() => jsmql("$$ = $$.slise(0, 5);")).toThrow(/Did you mean '\.slice'/);
  });

  it("unknown method after a valid .filter still surfaces the registry list", () => {
    expect(() => jsmql("$$ = $$.filter(o => o.active).bogus();")).toThrow(/is not a chainable stream method on '\$\$'/);
  });
});
