// Tests for the chainable stream-method vocabulary on `$$` / `$$$.<coll>`.
// One describe block per method. See docs/specs/stream-methods.md for the
// per-method shape, lowering, and error wording.
//
// All tests use trailing `;` to flip the dispatcher into Pipeline mode —
// `$$ = …` is a stream-mutating statement only meaningful in a pipeline.

import { describe, it, expect } from "vitest";
import { jsmql } from "../src/index.ts";
import { truthy, truthyAnd } from "./truthy.ts";

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
      { $match: { $expr: truthy("$active") } },
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
  // (A cross-database source-switch — `$$ = $$$$.<db>.<coll>.filter(...)` — is
  // rejected; covered once in pipeline.test.ts, not re-tested per chain method.)
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

describe(".take(n) → $limit — lodash first-n", () => {
  it("lowers to $limit", () => {
    expect(jsmql("$$ = $$.take(10);")).toEqual([{ $limit: 10 }]);
  });

  it("take(0) → always-false $match (lodash empty; $limit:0 is invalid MQL)", () => {
    expect(jsmql("$$ = $$.take(0);")).toEqual([{ $match: { $expr: false } }]);
  });

  it("chains after a sort", () => {
    expect(jsmql("$$ = $$.sort({ createdAt: -1 }).take(10);")).toEqual([{ $sort: { createdAt: -1 } }, { $limit: 10 }]);
  });

  it("bare-statement form is equivalent", () => {
    expect(jsmql("$$.take(10);")).toEqual([{ $limit: 10 }]);
  });

  it("rejects a non-integer / negative / computed / extra-arg / spread", () => {
    expect(() => jsmql("$$ = $$.take(1.5);")).toThrow(/integer >= 0/);
    expect(() => jsmql("$$ = $$.take(-1);")).toThrow(/requires an integer literal/);
    expect(() => jsmql('$$ = $$.take("x");')).toThrow(/requires an integer literal/);
    expect(() => jsmql("$$ = $$.take($.n);")).toThrow(/requires an integer literal/);
    expect(() => jsmql("$$ = $$.take(1, 2);")).toThrow(/takes exactly 1 argument/);
    expect(() => jsmql("$$ = $$.take(...[1]);")).toThrow(/does not accept a spread argument/);
  });
});

describe(".drop(n) → $skip — lodash all-but-first-n", () => {
  it("lowers to $skip", () => {
    expect(jsmql("$$ = $$.drop(5);")).toEqual([{ $skip: 5 }]);
  });

  it("drop(0) is identity — emits zero stages", () => {
    expect(jsmql("$$ = $$.drop(0);")).toEqual([]);
  });

  it("composes with .take (skip + limit)", () => {
    expect(jsmql("$$ = $$.drop(5).take(10);")).toEqual([{ $skip: 5 }, { $limit: 10 }]);
  });
});

describe(".tail() → $skip: 1 — lodash all-but-first", () => {
  it("lowers to $skip: 1 (the stream analogue of .drop(1))", () => {
    expect(jsmql("$$ = $$.tail();")).toEqual([{ $skip: 1 }]);
    expect(jsmql("$$ = $$.tail();")).toEqual(jsmql("$$ = $$.drop(1);"));
  });
  it("rejects arguments", () => {
    expect(() => jsmql("$$ = $$.tail(2);")).toThrow(/takes no arguments/);
  });
});

describe("'from the end' array methods are NOT on the stream surface", () => {
  // MongoDB has no stage that reverses a stream (`$reverseArray` is an EXPRESSION,
  // for an array inside a document), and a stream has no order except the one a
  // `$sort` gives it. Faking them means rewriting the preceding `$sort`, which makes
  // them position-dependent in a way the JS methods never are — and with no `$sort` in
  // front they would silently order by `_id` instead of erroring.
  const REMOVED = ["takeRight(3)", "dropRight(2)", "initial()", "toReversed()"];
  const CONTEXTS = [
    ["$$ = pivot", (c: string) => `$$ = $$.${c};`],
    ["bare statement", (c: string) => `$$.${c};`],
    ["after a sort", (c: string) => `$$ = $$.toSorted({ age: 1 }).${c};`],
    ["foreign pivot", (c: string) => `$$ = $$$.orders.${c};`],
    ["foreign value position", (c: string) => `$.x = $$$.orders.${c};`],
    ["foreign after filter", (c: string) => `$.x = $$$.orders.filter({ a: 1 }).${c};`],
  ] as const;
  for (const call of REMOVED) {
    for (const [label, build] of CONTEXTS) {
      it(`.${call} is rejected in the ${label} context`, () => {
        expect(() => jsmql(build(call)), build(call)).toThrow(/isn't available on a stream/);
      });
    }
  }

  it("the rejection names the take-from-the-front rewrite", () => {
    expect(() => jsmql("$$ = $$.takeRight(3);")).toThrow(/\.toSorted\({ <field>: -1 }\)\.take\(n\)/);
    expect(() => jsmql("$$ = $$.toReversed();")).toThrow(/\.toSorted\({ <field>: -1 }\)/);
  });

  it("all four still work in VALUE position on a real array", () => {
    // A stored array carries its own order, so there they mean what JS means.
    expect(jsmql("$.x = $.items.takeRight(3);")).toEqual([{ $set: { x: { $slice: ["$items", -3] } } }]);
    expect(jsmql("$.x = $.items.toReversed();")).toEqual([{ $set: { x: { $reverseArray: "$items" } } }]);
    expect(jsmql("$.x = $.items.initial();")).toBeDefined();
    expect(jsmql("$.x = $.items.dropRight(2);")).toBeDefined();
  });
});

describe(".shuffle() → $rand sort", () => {
  it("stamps a $rand key and sorts by it; the trailing $unset clears the residue", () => {
    // No per-slot `$unset` at the top level — the pipeline's own trailing
    // `{ $unset: "__jsmql" }` already sweeps it, so emitting both was noise.
    expect(jsmql("$$.shuffle();")).toEqual([
      { $addFields: { "__jsmql.tmp.1": { $rand: {} } } },
      { $sort: { "__jsmql.tmp.1": 1 } },
      { $unset: "__jsmql" },
    ]);
  });

  it("inside a $lookup.pipeline the whole __jsmql namespace is unset, not the leaf slot", () => {
    // The outer sweep can't reach documents nested in the `as` array, so the
    // sub-pipeline cleans up itself — and it must drop the NAMESPACE ROOT.
    // `$unset` of a dotted path removes only the leaf, so unsetting
    // `__jsmql.tmp.1` left every foreign doc carrying `__jsmql: { tmp: {} }`.
    // Verified against a live mongod, where the residue showed up in the results.
    const inner = ((jsmql("$.x = $$$.orders.shuffle();") as object[])[0] as { $lookup: { pipeline: object[] } }).$lookup
      .pipeline;
    expect(inner).toEqual([
      { $addFields: { "__jsmql.tmp.1": { $rand: {} } } },
      { $sort: { "__jsmql.tmp.1": 1 } },
      { $unset: "__jsmql" },
    ]);
  });

  it("the scratch $unset is held to the end, never wedged between the $sort and the next stage", () => {
    // The `$sort` must stay adjacent to whatever follows it. When the slot `$unset`
    // sat in between, `.takeRight` (since removed) silently reversed by `_id`
    // instead of by the shuffle. The ordering rule outlives that method.
    expect(jsmql("$$ = $$.shuffle().take(3);")).toEqual([
      { $addFields: { "__jsmql.tmp.1": { $rand: {} } } },
      { $sort: { "__jsmql.tmp.1": 1 } },
      { $limit: 3 },
      { $unset: "__jsmql" },
    ]);
  });
});

describe("stream .takeWhile / .dropWhile → $setWindowFields running flag", () => {
  // One `$setWindowFields` computes "has the predicate failed at or before this
  // document?"; the two methods are exact complements, differing only in the
  // `$match` polarity. Verified on a live mongod with data where the predicate
  // FAILS then RECOVERS — the case where `.filter()` would give a different answer.
  const FLAG = {
    $setWindowFields: {
      sortBy: { t: 1 },
      output: { "__jsmql.tmp.1": { $max: { $cond: ["$ok", 0, 1] }, window: { documents: ["unbounded", "current"] } } },
    },
  };

  it("takeWhile keeps the leading run; dropWhile keeps the complement", () => {
    expect(jsmql("$$.toSorted({ t: 1 }).takeWhile(o => o.ok);")).toEqual([
      { $sort: { t: 1 } },
      FLAG,
      { $match: { "__jsmql.tmp.1": 0 } },
      { $unset: "__jsmql" },
    ]);
    expect(jsmql("$$.toSorted({ t: 1 }).dropWhile(o => o.ok);")).toEqual([
      { $sort: { t: 1 } },
      FLAG,
      { $match: { "__jsmql.tmp.1": 1 } },
      { $unset: "__jsmql" },
    ]);
  });

  it("lifts sortBy from ANY sort spelling", () => {
    const sortBy = (src: string) =>
      ((jsmql(src) as object[]).find((x) => "$setWindowFields" in x) as { $setWindowFields: { sortBy: unknown } })
        .$setWindowFields.sortBy;
    expect(sortBy("$$.sort({ t: 1 }).takeWhile(o => o.ok);")).toEqual({ t: 1 });
    expect(sortBy("$$.toSorted({ t: 1 }).takeWhile(o => o.ok);")).toEqual({ t: 1 });
    expect(sortBy('$$.sortBy("t").takeWhile(o => o.ok);')).toEqual({ t: 1 });
    expect(sortBy('$$.orderBy("t", -1).takeWhile(o => o.ok);')).toEqual({ t: -1 });
    expect(sortBy("$$.$sort({ t: 1 }).takeWhile(o => o.ok);")).toEqual({ t: 1 });
    // A computed sort key lives in a scratch field — the window sorts by that.
    expect(sortBy("$$.sortBy(d => d.cat.toLowerCase()).takeWhile(o => o.ok);")).toEqual({ "__jsmql.tmp.1": 1 });
  });

  it("takes the same predicate spellings .filter does", () => {
    const arrow = jsmql('$$.sortBy("t").takeWhile(o => o.ok === true);');
    expect(jsmql('$$.sortBy("t").takeWhile({ ok: true });')).toEqual(arrow);
    expect(jsmql('$$.sortBy("t").takeWhile(["ok", true]);')).toEqual(arrow);
  });

  it("with no preceding sort it REJECTS — never defaults to _id", () => {
    // Silently substituting an order nobody asked for is what got the
    // "from the end" family removed; this slot must not repeat it.
    for (const m of ["takeWhile", "dropWhile"]) {
      expect(() => jsmql(`$$.${m}(o => o.ok);`), m).toThrow(/needs a preceding sort/);
      expect(() => jsmql(`$$.${m}(o => o.ok);`), m).toThrow(/\.toSorted\({ t: 1 }\)/);
    }
    // A non-sort stage in between is fine — the last $sort still defines the order.
    expect(() => jsmql('$$.sortBy("t").take(9).takeWhile(o => o.ok);')).not.toThrow();
  });

  it("value-mode on a real array is unaffected", () => {
    expect(jsmql("$.x = $.rows.takeWhile(o => o.ok);")).toBeDefined();
    expect(jsmql("$.x = $.rows.dropWhile(o => o.ok);")).toBeDefined();
  });
});

describe(".sampleSize(n) → $sample", () => {
  it("lowers to $sample", () => {
    expect(jsmql("$$ = $$.sampleSize(3);")).toEqual([{ $sample: { size: 3 } }]);
  });

  it("rejects size < 1", () => {
    expect(() => jsmql("$$ = $$.sampleSize(0);")).toThrow(/integer >= 1/);
  });
});

describe(".sample() → $sample: { size: 1 } — one random document", () => {
  it("zero-arg → sampleSize(1)", () => {
    expect(jsmql("$$ = $$.sample();")).toEqual([{ $sample: { size: 1 } }]);
    expect(jsmql("$$ = $$.sample();")).toEqual(jsmql("$$ = $$.sampleSize(1);"));
  });

  it("chains after .filter", () => {
    expect(jsmql('$$ = $$.filter({ tier: "gold" }).sample();')).toEqual([
      { $match: { tier: "gold" } },
      { $sample: { size: 1 } },
    ]);
  });

  it("rejects an argument (→ .sampleSize)", () => {
    expect(() => jsmql("$$ = $$.sample(3);")).toThrow(/takes no arguments.*\.sampleSize\(n\)/);
  });
});

describe(".sort(<sort>) / .toSorted(<sort>) → $sort — flexible sort args", () => {
  it("field-name string → ascending $sort", () => {
    expect(jsmql('$$ = $$.sort("createdAt");')).toEqual([{ $sort: { createdAt: 1 } }]);
  });

  it("array of field names → multi-key ascending $sort", () => {
    expect(jsmql('$$ = $$.sort(["age", "name"]);')).toEqual([{ $sort: { age: 1, name: 1 } }]);
  });

  it("{ field: 1 | -1 } spec", () => {
    expect(jsmql("$$ = $$.sort({ score: -1, productId: 1 });")).toEqual([{ $sort: { score: -1, productId: 1 } }]);
  });

  it('{ field: "asc" | "desc" } spec', () => {
    expect(jsmql('$$ = $$.sort({ createdAt: "desc" });')).toEqual([{ $sort: { createdAt: -1 } }]);
    expect(jsmql('$$ = $$.sort({ a: "asc", b: "desc" });')).toEqual([{ $sort: { a: 1, b: -1 } }]);
  });

  it("comparator arrow still works", () => {
    expect(jsmql("$$ = $$.sort((a, b) => a.age - b.age);")).toEqual([{ $sort: { age: 1 } }]);
    expect(jsmql("$$ = $$.sort((a, b) => b.age - a.age);")).toEqual([{ $sort: { age: -1 } }]);
  });

  it(".toSorted is equivalent to .sort on a stream", () => {
    expect(jsmql('$$ = $$.toSorted("createdAt");')).toEqual(jsmql('$$ = $$.sort("createdAt");'));
    expect(jsmql("$$ = $$.toSorted({ n: -1 });")).toEqual([{ $sort: { n: -1 } }]);
  });

  it(".sortBy(field | [fields]) → ascending $sort (lodash alias); object arg is rejected", () => {
    expect(jsmql('$$ = $$.sortBy("age");')).toEqual([{ $sort: { age: 1 } }]);
    expect(jsmql('$$ = $$.sortBy(["age", "name"]);')).toEqual([{ $sort: { age: 1, name: 1 } }]);
    expect(() => jsmql("$$ = $$.sortBy({ age: -1 });")).toThrow(/matches-shorthand.*orderBy/s);
  });

  it(".orderBy(keys, orders) → $sort with per-key directions (fewer orders default asc)", () => {
    expect(jsmql('$$ = $$.orderBy("age", "desc");')).toEqual([{ $sort: { age: -1 } }]);
    expect(jsmql('$$ = $$.orderBy(["age", "name"], ["desc", "asc"]);')).toEqual([{ $sort: { age: -1, name: 1 } }]);
    expect(jsmql('$$ = $$.orderBy(["a", "b"]);')).toEqual([{ $sort: { a: 1, b: 1 } }]);
    expect(() => jsmql('$$ = $$.orderBy("age", "up");')).toThrow(/directions must be 1 \/ -1/);
  });

  it(".orderBy({ field: dir }) → $sort with inline directions (like .sort); no orders arg", () => {
    expect(jsmql("$$ = $$.orderBy({ score: -1 });")).toEqual([{ $sort: { score: -1 } }]);
    expect(jsmql('$$ = $$.orderBy({ score: -1, name: "asc" });')).toEqual([{ $sort: { score: -1, name: 1 } }]);
    expect(() => jsmql('$$ = $$.orderBy({ score: -1 }, ["asc"]);')).toThrow(
      /already carries a direction per field.*drop the second 'orders'/s,
    );
    // arity error advertises the object form too (parity with value-mode .orderBy)
    expect(() => jsmql("$$ = $$.orderBy();")).toThrow(/\{ field: dir \}/);
  });

  it("runs inside a $$$.<coll> source-switch sub-pipeline", () => {
    expect(jsmql("$$ = $$$.archive.sort({ createdAt: -1 }).take(5);")).toEqual([
      { $match: { $expr: false } },
      { $unionWith: { coll: "archive", pipeline: [{ $sort: { createdAt: -1 } }, { $limit: 5 }] } },
    ]);
  });

  it("rejects a bad direction, a $-prefixed field, and no args", () => {
    expect(() => jsmql("$$ = $$.sort({ a: 2 });")).toThrow(/must be 1 \/ -1 \/ "asc" \/ "desc"/);
    expect(() => jsmql('$$ = $$.sort("$x");')).toThrow(/no leading '\$'/);
    expect(() => jsmql("$$ = $$.sort();")).toThrow(/needs a sort key/);
  });
});

describe(".reject(pred) → $match (filter negated)", () => {
  it("arrow predicate → $match with $expr $not (no query-form De Morgan)", () => {
    expect(jsmql("$$.reject(o => o.archived === true);")).toEqual([
      { $match: { $expr: { $not: { $eq: ["$archived", true] } } } },
    ]);
  });
  it("matches-object shorthand negates each key", () => {
    expect(jsmql("$$.reject({ archived: true });")).toEqual([
      { $match: { $expr: { $not: { $eq: ["$archived", true] } } } },
    ]);
  });
  it("chains after .filter and before other stream methods", () => {
    expect(jsmql("$$.filter(o => o.active === true).reject(o => o.hidden === true).take(5);")).toEqual([
      { $match: { active: true } },
      { $match: { $expr: { $not: { $eq: ["$hidden", true] } } } },
      { $limit: 5 },
    ]);
  });
  it("rejects a spread / multi-arg", () => {
    expect(() => jsmql("$$.reject(o => o.a, o => o.b);")).toThrow(/takes exactly one predicate argument, got 2/);
    expect(() => jsmql("$$.reject(...preds);")).toThrow(/takes a single arrow predicate/);
  });
});

describe(".pick([fields]) / .omit([fields]) → $project (per-document field selection)", () => {
  it(".pick keeps ONLY the named fields — inclusion $project, drops _id unless named", () => {
    expect(jsmql('$$.pick(["name", "email"]);')).toEqual([{ $project: { name: 1, email: 1, _id: 0 } }]);
    expect(jsmql('$$.pick(["_id", "name"]);')).toEqual([{ $project: { _id: 1, name: 1 } }]);
  });
  it(".omit drops the named fields — exclusion $project, keeps everything else", () => {
    expect(jsmql('$$.omit(["password", "ssn"]);')).toEqual([{ $project: { password: 0, ssn: 0 } }]);
  });
  it("run inside a $$$.<coll> lookup sub-pipeline (projects each foreign doc)", () => {
    expect(jsmql('$.slim = $$$.orders.filter(o => o.userId === $._id).pick(["total", "placedAt"]);')).toEqual([
      {
        $lookup: {
          from: "orders",
          let: { jsmql_f0__id: "$_id" },
          pipeline: [
            { $match: { $expr: { $eq: ["$userId", "$$jsmql_f0__id"] } } },
            { $project: { total: 1, placedAt: 1, _id: 0 } },
          ],
          as: "__jsmql.tmp.1",
        },
      },
      { $set: { slim: "$__jsmql.tmp.1" } },
      { $unset: "__jsmql" },
    ]);
  });
  it("reject a non-array arg / non-string entries", () => {
    expect(() => jsmql('$$.pick("name");')).toThrow(/takes an array of field-name strings/);
    expect(() => jsmql("$$.omit([1, 2]);")).toThrow(/plain field-name strings/);
  });
});

describe(".groupBy(spec | key) → object collapse / $group", () => {
  it("raw $group body lowers verbatim (accumulators pass the group gate)", () => {
    expect(jsmql('$$ = $$.groupBy({ _id: "$dept", n: $sum(1), total: $sum("$amount") });')).toEqual([
      { $group: { _id: "$dept", n: { $sum: 1 }, total: { $sum: "$amount" } } },
    ]);
  });

  it("accumulator-only ops ($addToSet) are allowed in a group field slot", () => {
    expect(jsmql('$$ = $$.groupBy({ _id: null, ids: $addToSet("$productId") });')).toEqual([
      { $group: { _id: null, ids: { $addToSet: "$productId" } } },
    ]);
  });

  // lodash `_.groupBy(coll, "dept")` → the OBJECT `{ <dept>: [docs] }`; the stream
  // form collapses to that single object (mirroring value-mode `$.arr.groupBy(...)`),
  // NOT a stream of group docs. Verified on mongod.
  it("bare field name → collapse to the lodash object { <key>: [docs] }", () => {
    expect(jsmql('$$ = $$.groupBy("dept");')).toEqual([
      { $group: { _id: "$dept", __jsmqlTmp: { $push: "$$ROOT" } } },
      {
        $group: {
          _id: null,
          __jsmqlTmp: { $push: { k: { $ifNull: [{ $toString: "$_id" }, "null"] }, v: "$__jsmqlTmp" } },
        },
      },
      { $replaceWith: { $arrayToObject: "$__jsmqlTmp" } },
    ]);
  });

  it("rejects a body without _id and a non-string/non-object arg", () => {
    expect(() => jsmql("$$ = $$.groupBy({ n: $sum(1) });")).toThrow(/requires an '_id' key/);
    expect(() => jsmql("$$ = $$.groupBy(5);")).toThrow(/takes a field name .* or a '\$group' body/);
  });
});

describe(".countBy(field) → object collapse", () => {
  // lodash `_.countBy(coll, "dept")` → the OBJECT `{ <dept>: <count> }`; the stream
  // form collapses to that single object (mirroring value-mode `$.arr.countBy(...)`),
  // NOT MongoDB's `$sortByCount` stream of `{ _id, count }` docs. Verified on mongod.
  it("collapses to the lodash object { <key>: <count> }", () => {
    expect(jsmql('$$ = $$.countBy("dept");')).toEqual([
      { $group: { _id: "$dept", __jsmqlTmp: { $sum: 1 } } },
      {
        $group: {
          _id: null,
          __jsmqlTmp: { $push: { k: { $ifNull: [{ $toString: "$_id" }, "null"] }, v: "$__jsmqlTmp" } },
        },
      },
      { $replaceWith: { $arrayToObject: "$__jsmqlTmp" } },
    ]);
  });
});

describe(".keyBy(field) → object collapse", () => {
  // lodash `_.keyBy(coll, "email")` → the OBJECT `{ <email>: <last doc> }`; the stream
  // form collapses to that single object (mirroring value-mode `$.arr.keyBy(...)`),
  // last-wins via `$last`. Works over the whole `$$` stream, unlike before (it used to
  // be value-position-only). Verified on mongod.
  it("collapses to the lodash object { <key>: <last doc> } (last wins)", () => {
    expect(jsmql('$$ = $$.keyBy("email");')).toEqual([
      { $group: { _id: "$email", __jsmqlTmp: { $last: "$$ROOT" } } },
      {
        $group: {
          _id: null,
          __jsmqlTmp: { $push: { k: { $ifNull: [{ $toString: "$_id" }, "null"] }, v: "$__jsmqlTmp" } },
        },
      },
      { $replaceWith: { $arrayToObject: "$__jsmqlTmp" } },
    ]);
  });
});

describe(".uniqBy(field) → $group + $replaceWith", () => {
  it("keeps the first document per distinct key", () => {
    expect(jsmql('$$ = $$.uniqBy("email");')).toEqual([
      { $group: { _id: "$email", __jsmqlTmp: { $first: "$$ROOT" } } },
      { $replaceWith: "$__jsmqlTmp" },
    ]);
  });
});

describe("lodash iteratee shorthands on stream methods", () => {
  it('.map("field") promotes a subdocument field to the root → $replaceWith', () => {
    // `.map("field")` ≡ `.map(d => d.field)` — the field becomes the new root, so it
    // must be a DOCUMENT ($replaceWith needs an object root). Using a subdocument
    // field here; a scalar field (e.g. an ObjectId `userId`) is accepted at compile
    // time (its type is unknown) but errors at runtime — verified against mongod.
    expect(jsmql('$$ = $$.map("address");')).toEqual([{ $replaceWith: "$address" }]);
    expect(jsmql('$$ = $$.map("address");')).toEqual(jsmql("$$ = $$.map(d => d.address);"));
  });

  it("rejects a .map body that provably isn't a document ($replaceWith needs an object root)", () => {
    // Universally-invalid MQL — mongod rejects a scalar/array `$replaceWith` root on
    // every deployment, so jsmql rejects it at compile time (parity with `$ = 5`).
    expect(() => jsmql("$$ = $$.map(d => 5);")).toThrow(/must return a document/);
    expect(() => jsmql('$$ = $$.map(d => "x");')).toThrow(/must return a document/);
    expect(() => jsmql("$$ = $$.map(d => true);")).toThrow(/must return a document/);
    expect(() => jsmql("$$ = $$.map(d => [1, 2]);")).toThrow(/must return a document/);
    // A field ref / `$`-string stays allowed — data-dependent, could be a subdocument.
    expect(jsmql('$$ = $$.map(d => "$sub");')).toEqual([{ $replaceWith: "$sub" }]);
  });

  it('.flatMap("field") unwinds by field name → $unwind', () => {
    expect(jsmql('$$ = $$.flatMap("productIds");')).toEqual([{ $unwind: "$productIds" }]);
  });

  it(".filter({ matches }) → equality $match query", () => {
    expect(jsmql('$$ = $$.filter({ status: "CLOSED", tier: "gold" });')).toEqual([
      { $match: { status: "CLOSED", tier: "gold" } },
    ]);
  });

  it(".filter works mid-chain (not only as the head)", () => {
    expect(jsmql("$$ = $$.take(5).filter(o => o.active);")).toEqual([
      { $limit: 5 },
      { $match: { $expr: truthy("$active") } },
    ]);
  });
});

// A recommendation-engine pipeline built entirely from lodash-named stream
// methods — the composed-vocabulary end-to-end case. Verified against a live mongod.
describe("composed lodash stream vocabulary — full pipeline", () => {
  it("$$.filter({...}).sort({...}).take(...).flatMap(...).groupBy({...})", () => {
    expect(
      jsmql(
        '$$ = $$.filter({ status: "CLOSED" }).sort({ createdAt: -1 }).take(10)' +
          '.flatMap("productIds").groupBy({ _id: null, boughtProductIds: $addToSet("$productIds") });',
      ),
    ).toEqual([
      { $match: { status: "CLOSED" } },
      { $sort: { createdAt: -1 } },
      { $limit: 10 },
      { $unwind: "$productIds" },
      { $group: { _id: null, boughtProductIds: { $addToSet: "$productIds" } } },
    ]);
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

  it("two-arg arrow `(d, i) => …` that USES the index is rejected with a no-index hint", () => {
    expect(() => jsmql("$$ = $$.map((d, i) => ({ id: d._id, idx: i }));")).toThrow(
      /can't use the index parameter 'i'.*no per-doc index/,
    );
  });

  it("an UNUSED index param is allowed (positional, to reach the 3rd 'collection' param)", () => {
    // `i` is present but never referenced — accepted, no $zip/index machinery.
    expect(jsmql("$$ = $$.map((d, _i) => ({ id: d._id }));")).toEqual([{ $replaceWith: { id: "$_id" } }]);
  });

  // ── 3rd 'collection' param → sub-stream length ──────────────────────────────
  // `coll.length` (the post-filter sub-stream's document count) materialises a
  // `$setWindowFields` `$count` (`__jsmql.length`) ahead of the `$replaceWith`.
  // Verified end-to-end on a live mongod (counts correct, no `__jsmql` leak).
  describe(".map((d, _i, coll) => …) — 3rd 'collection' param sub-stream length", () => {
    it("top-level `$$` stream chain: coll.length → $setWindowFields + read-back", () => {
      expect(jsmql("$$ = $$.map((d, _i, coll) => ({ id: d._id, n: coll.length }));")).toEqual([
        { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
        { $replaceWith: { id: "$_id", n: "$__jsmql.length" } },
      ]);
    });

    it("lookup chain: $setWindowFields lands after the filter's $match, inside $lookup.pipeline", () => {
      expect(
        jsmql("$$ = $$$.orders.filter(o => o.userId === $._id).map((o, _i, coll) => ({ id: o._id, n: coll.length }));"),
      ).toEqual([
        {
          $lookup: {
            from: "orders",
            let: { jsmql_f0__id: "$_id" },
            pipeline: [
              { $match: { $expr: { $eq: ["$userId", "$$jsmql_f0__id"] } } },
              { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
              { $replaceWith: { id: "$_id", n: "$__jsmql.length" } },
            ],
            as: "__jsmql.tmp.1",
          },
        },
        { $unwind: "$__jsmql.tmp.1" },
        { $replaceWith: "$__jsmql.tmp.1" },
      ]);
    });

    it("coll.length composes inside an operator ($divide)", () => {
      expect(jsmql("$$ = $$.map((o, _i, coll) => ({ share: o.total / coll.length }));")).toEqual([
        { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
        { $replaceWith: { share: { $divide: ["$total", "$__jsmql.length"] } } },
      ]);
    });

    it("only `.length` is available on the handle — other uses are rejected with a redirect", () => {
      expect(() => jsmql("$$ = $$.map((o, _i, coll) => ({ first: coll[0] }));")).toThrow(
        /only 'coll\.length'.*no materialised array to index or iterate/,
      );
      expect(() => jsmql("$$ = $$.map((o, _i, coll) => ({ all: coll }));")).toThrow(/only 'coll\.length'/);
    });

    it("a USED index is still rejected even with a 3rd param present", () => {
      expect(() => jsmql("$$ = $$.map((o, i, coll) => ({ x: i, n: coll.length }));")).toThrow(
        /can't use the index parameter 'i'/,
      );
    });
  });

  // `.map` is a per-document reshape, so its `{ … }` body is JavaScript: bindings
  // plus the `return` whose value becomes each output document. Pipeline stages —
  // `assert(...)`, `$match(...)`, `<coll>.length` — belong to `.aggregate((o) => { … })`
  // against a foreign collection, or to statements on the current stream, with the
  // reshape written as the root-replace `$ = <expr>`. That is the same lowering the
  // block form had, so each pair below emits identical MQL (all verified on a live
  // mongod); the `.map` half of each pair is now rejected.
  describe("a pipeline stage in a `.map` block is rejected, and where it goes instead", () => {
    it("foreign chain: `.aggregate` runs the guard + reshape inside $lookup.pipeline", () => {
      expect(() =>
        jsmql(`$$ = $$$.orders.filter(o => o.userId === $._id).map(o => {
          assert(o.total > 0, "bad order");
          return { id: o._id, t: o.total };
        });`),
      ).toThrow(/`assert\(\.\.\.\)` is a pipeline stage, not part of a callback/);
      expect(
        jsmql(`$$ = $$$.orders.filter(o => o.userId === $._id).aggregate(o => {
          assert(o.total > 0, "bad order");
          $ = { id: o._id, t: o.total };
        });`),
      ).toEqual([
        {
          $lookup: {
            from: "orders",
            let: { jsmql_f0__id: "$_id" },
            pipeline: [
              { $match: { $expr: { $eq: ["$userId", "$$jsmql_f0__id"] } } },
              {
                $match: {
                  $expr: {
                    $convert: {
                      input: true,
                      to: { $cond: [{ $gt: ["$total", 0] }, "bool", "jsmql assertion failed: bad order"] },
                    },
                  },
                },
              },
              { $replaceWith: { id: "$_id", t: "$total" } },
            ],
            as: "__jsmql.tmp.1",
          },
        },
        { $unwind: "$__jsmql.tmp.1" },
        { $replaceWith: "$__jsmql.tmp.1" },
      ]);
    });

    it("current stream: the stage is a statement and the reshape is `$ = <expr>`", () => {
      expect(() => jsmql(`$$ = $$.map(d => { $match(d.active === true); return { id: d._id }; });`)).toThrow(
        /`\$match\(\.\.\.\)` is a pipeline stage, not part of a callback — chain them as stage calls/,
      );
      expect(jsmql(`$match($.active === true); $ = { id: $._id };`)).toEqual([
        { $match: { active: true } },
        { $replaceWith: { id: "$_id" } },
      ]);
    });

    it("current stream: the sub-stream count is `$$.length`", () => {
      expect(() =>
        jsmql(`$$ = $$.map((d, _i, coll) => { assert(coll.length > 0, "empty"); return { id: d._id }; });`),
      ).toThrow(/`assert\(\.\.\.\)` is a pipeline stage, not part of a callback/);
      expect(jsmql(`assert($$.length > 0, "empty"); $ = { id: $._id };`)).toEqual([
        { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
        {
          $match: {
            $expr: {
              $convert: {
                input: true,
                to: { $cond: [{ $gt: ["$__jsmql.length", 0] }, "bool", "jsmql assertion failed: empty"] },
              },
            },
          },
        },
        { $replaceWith: { id: "$_id" } },
      ]);
    });

    it("a stage-free `.map` block still has to end with `return`", () => {
      expect(() => jsmql(`$$ = $$.map(d => { const t = d.total; });`)).toThrow(/must end with 'return <expr>'/);
    });

    it("`$.<field>` inside a TOP-LEVEL `$$` block `.map` body is rejected — must use the lambda param", () => {
      // No enclosing `$lookup.let` to correlate into, so `$.field` ≡ the current
      // doc; the rejection nudges toward the lambda param (`d.field`).
      expect(() => jsmql(`$$ = $$.map(d => { return { n: $.name }; });`)).toThrow(
        /'\$\.<field>'.*use the lambda parameter/,
      );
    });

    it("inside a lookup pivot, a `$.<field>` (root) read in an `.aggregate` block IS captured into the $lookup.let", () => {
      // The orders lookup correlates on `$._id`; the `.aggregate` block's `$.minTotal`
      // (the root user doc) is hoisted into the SAME `$lookup.let` as `jsmql_f0_minTotal`.
      expect(
        jsmql(`$$ = $$$.orders.filter(o => o.userId === $._id).aggregate(o => {
          assert(o.total > $.minTotal, "below min");
          $ = { id: o._id };
        });`),
      ).toEqual([
        {
          $lookup: {
            from: "orders",
            let: { jsmql_f0__id: "$_id", jsmql_f0_minTotal: "$minTotal" },
            pipeline: [
              { $match: { $expr: { $eq: ["$userId", "$$jsmql_f0__id"] } } },
              {
                $match: {
                  $expr: {
                    $convert: {
                      input: true,
                      to: {
                        $cond: [
                          { $gt: ["$total", "$$jsmql_f0_minTotal"] },
                          "bool",
                          "jsmql assertion failed: below min",
                        ],
                      },
                    },
                  },
                },
              },
              { $replaceWith: { id: "$_id" } },
            ],
            as: "__jsmql.tmp.1",
          },
        },
        { $unwind: "$__jsmql.tmp.1" },
        { $replaceWith: "$__jsmql.tmp.1" },
      ]);
    });
  });

  it("`$.<field>` inside .map body is rejected — must use the lambda param", () => {
    expect(() => jsmql("$$ = $$.map(d => ({ n: $.name }));")).toThrow(/'\$\.<field>'.*use the lambda parameter/);
  });

  it("lookup inside .map body materialises into prologue $lookup + $set, $replaceWith reads the slot", () => {
    expect(jsmql("$$ = $$.map(d => ({ a: $$$.archive.find(x => x._id === d._id) }));")).toEqual([
      { $lookup: { from: "archive", localField: "_id", foreignField: "_id", as: "__jsmql.tmp.1" } },
      { $set: { "__jsmql.tmp.1": { $first: "$__jsmql.tmp.1" } } },
      { $replaceWith: { a: "$__jsmql.tmp.1" } },
    ]);
  });

  it(".filter + .map with internal lookup composes — $match, $lookup, $set, $replaceWith", () => {
    expect(
      jsmql(
        "$$ = $$.filter(o => o.active === true).map(d => ({ id: d._id, archived: $$$.archive.find(x => x._id === d._id) }));",
      ),
    ).toEqual([
      { $match: { active: true } },
      { $lookup: { from: "archive", localField: "_id", foreignField: "_id", as: "__jsmql.tmp.1" } },
      { $set: { "__jsmql.tmp.1": { $first: "$__jsmql.tmp.1" } } },
      { $replaceWith: { id: "$_id", archived: "$__jsmql.tmp.1" } },
    ]);
  });

  it("array-valued .filter lookup inside .map body uses the pipeline-form $lookup (no $first wrap)", () => {
    expect(jsmql("$$ = $$.map(d => ({ id: d._id, items: $$$.archive.filter(x => x.userId === d._id) }));")).toEqual([
      { $lookup: { from: "archive", localField: "_id", foreignField: "userId", as: "__jsmql.tmp.1" } },
      { $replaceWith: { id: "$_id", items: "$__jsmql.tmp.1" } },
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
            { $lookup: { from: "archive", localField: "_id", foreignField: "_id", as: "__jsmql.tmp.1" } },
            { $set: { "__jsmql.tmp.1": { $first: "$__jsmql.tmp.1" } } },
            { $replaceWith: { a: "$__jsmql.tmp.1" } },
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
                let: { jsmql_f0__id: "$_id", jsmql_f0_tier: "$tier" },
                pipeline: [
                  {
                    $match: {
                      $expr: { $and: [{ $eq: ["$userId", "$$jsmql_f0__id"] }, { $eq: ["$tier", "$$jsmql_f0_tier"] }] },
                    },
                  },
                ],
                as: "__jsmql.tmp.1",
              },
            },
            { $replaceWith: { archives: "$__jsmql.tmp.1" } },
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
    expect(() => jsmql("$$ = $$.flatMap(d => d.items.map(x => x * 2));")).toThrow(
      /needs a field path.*Build the array into a field first/s,
    );
  });

  it("zero-arg body is rejected (no path → not derivable)", () => {
    expect(() => jsmql("$$ = $$.flatMap(d => 5);")).toThrow(/needs a field path/);
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

  it("unrecognised reducer body inside the wrap is rejected with the supported-shapes list", () => {
    expect(() => jsmql("$$ = [{ total: $$.reduce((acc, d) => acc * d.x, 1) }];")).toThrow(
      /supports these reducer shapes.*\$sum.*\$max.*\$min/s,
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

  it("spread after named entries is rejected (position matters)", () => {
    expect(() => jsmql("$$ = [$$.reduce((acc, d) => ({ count: acc.count + 1, ...acc }), { count: 0 })];")).toThrow(
      /spread must be the first entry/,
    );
  });

  it("entry referencing acc.<otherKey> instead of acc.<sameKey> is rejected", () => {
    // `total: acc.count + d.amount` references acc.count, not acc.total — a
    // semantic mismatch that JS would silently accept but mean something
    // different from the user's intent. The supported-shapes message names the
    // expected accumulator side.
    expect(() =>
      jsmql(
        "$$ = [$$.reduce((acc, d) => ({ count: acc.count + 1, total: acc.count + d.amount }), { count: 0, total: 0 })];",
      ),
    ).toThrow(/Each entry must reference 'acc\.total' as the accumulator side/);
  });

  it("unrecognised body-entry shape is rejected with the supported-shapes list", () => {
    expect(() => jsmql("$$ = [$$.reduce((acc, d) => ({ total: acc.total * d.x }), { total: 1 })];")).toThrow(
      /supported shapes:.*\$sum.*\$max.*\$min/s,
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
      { $group: { _id: null, __jsmqlTmp: { $push: { k: "$id", v: "$name" } } } },
      { $replaceWith: { $arrayToObject: "$__jsmqlTmp" } },
    ]);
  });

  it("nested key path: `{...acc, [d.user.email]: d.score}`", () => {
    expect(jsmql("$$ = [$$.reduce((acc, d) => ({ ...acc, [d.user.email]: d.score }), {})];")).toEqual([
      { $group: { _id: null, __jsmqlTmp: { $push: { k: "$user.email", v: "$score" } } } },
      { $replaceWith: { $arrayToObject: "$__jsmqlTmp" } },
    ]);
  });

  it("bare-doc value (`[d.id]: d`) uses $$ROOT", () => {
    expect(jsmql("$$ = [$$.reduce((acc, d) => ({ ...acc, [d.id]: d }), {})];")).toEqual([
      { $group: { _id: null, __jsmqlTmp: { $push: { k: "$id", v: "$$ROOT" } } } },
      { $replaceWith: { $arrayToObject: "$__jsmqlTmp" } },
    ]);
  });

  it("optional leading `...acc` spread", () => {
    // The user might write `{ [d.id]: d.name }` without the spread — same
    // shape, same lowering. (In JS this would discard prior keys per
    // iteration, which is fine because the $group accumulator does the
    // accumulation; the spread is JS-faithful boilerplate.)
    expect(jsmql("$$ = [$$.reduce((acc, d) => ({ [d.id]: d.name }), {})];")).toEqual([
      { $group: { _id: null, __jsmqlTmp: { $push: { k: "$id", v: "$name" } } } },
      { $replaceWith: { $arrayToObject: "$__jsmqlTmp" } },
    ]);
  });

  it("composes with a preceding $match", () => {
    expect(jsmql("$match($.active === true); $$ = [$$.reduce((acc, d) => ({ ...acc, [d.id]: d.name }), {})]")).toEqual([
      { $match: { active: true } },
      { $group: { _id: null, __jsmqlTmp: { $push: { k: "$id", v: "$name" } } } },
      { $replaceWith: { $arrayToObject: "$__jsmqlTmp" } },
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
      // `a && b` in a $match reads as a boolean, so it is `$and` of the two boolified
      // operands — not the operand-preserving `$cond`, whose returned operand nothing
      // here can observe.
      { $match: { $expr: truthyAnd("$active", "$contactDetails.email") } },
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
      /Array-returning reducer body.*supported shapes/s,
    );
  });

  it("non-concat body is rejected with the supported-shapes list", () => {
    expect(() => jsmql("$$ = $$.reduce((acc, d) => acc.push(d.contactDetails), []);")).toThrow(
      /Array-returning reducer body.*\.concat\(/s,
    );
  });

  it("concat with multi-element wrapper is rejected (a bare path or `d` is what is supported)", () => {
    expect(() => jsmql("$$ = $$.reduce((acc, d) => acc.concat([d.x, d.y]), []);")).toThrow(
      /Array-returning reducer body.*supported shapes/s,
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

  it("a descending sort is written directly, not as sort-then-reverse", () => {
    // `.toReversed()` is gone from streams, so the descending comparator IS the
    // spelling — and it was always the shorter one for the same single `$sort`.
    const expected = [{ $sort: { age: -1 } }];
    expect(jsmql("$$.toSorted((a, b) => b.age - a.age);")).toEqual(expected);
    expect(jsmql("$$ = $$.toSorted({ age: -1 });")).toEqual(expected);
    expect(jsmql('$$.orderBy("age", -1);')).toEqual(expected);
  });

  it("unknown bare chain method surfaces the registry hint", () => {
    expect(() => jsmql("$$.slise(0, 5);")).toThrow(/Did you mean '\.slice'/);
  });
});

// Callback SPELLING must never change what is emitted. jsmql accepts the lodash
// shorthands in value position, so the stream forms have to accept exactly the same
// set — a spelling that compiles against `$.arr` but errors against `$$$.coll` is a
// bug, not a restriction. Two spellings that mean one thing:
//   • a field key   — `"cat"`  ≡  `d => d.cat`   (both name the same plan-time path)
//   • a predicate   — `o => o.cat === "a"`  ≡  `{ cat: "a" }`  ≡  `["cat", "a"]`
// Each pair below is asserted BYTE-IDENTICAL rather than merely "both compile", which
// is what catches a divergence that still produces valid-but-different MQL (the
// `.groupBy(d => d.cat)` case did: it silently skipped the `$first` unwrap that
// `.groupBy("cat")` gets, leaving the caller the raw `[obj]` slot). Verified on a
// live mongod: every pair returns the same documents.
describe("stream callbacks — spelling never changes the emitted MQL", () => {
  const FIELD_KEY_METHODS = ["sortBy", "orderBy", "groupBy", "countBy", "keyBy", "uniqBy", "flatMap"];
  for (const m of FIELD_KEY_METHODS) {
    it(`.${m}: the bare-path arrow emits exactly what the field-name string does`, () => {
      expect(jsmql(`$.o = $$$.orders.${m}(d => d.cat);`)).toEqual(jsmql(`$.o = $$$.orders.${m}("cat");`));
      // …and in a chained position, where a different assembler builds the stage.
      expect(jsmql(`$.o = $$$.orders.take(3).${m}(d => d.cat);`)).toEqual(
        jsmql(`$.o = $$$.orders.take(3).${m}("cat");`),
      );
    });
  }

  it(".groupBy(<arrow>) still gets the collapsing $first unwrap the string form gets", () => {
    // The regression this guards: `isCollapsingTerminal` keyed on `StringLiteral`, so
    // only the string spelling was recognised as collapsing to a single object.
    const stages = jsmql(`$.o = $$$.orders.groupBy(d => d.cat);`) as object[];
    expect(JSON.stringify(stages)).toContain("$first");
  });

  it(".groupBy({ _id, … }) stays the $group-body form, NOT a matches-shorthand key", () => {
    expect(jsmql(`$$ = $$.groupBy({ _id: "$dept", n: $sum(1) });`)).toEqual([
      { $group: { _id: "$dept", n: { $sum: 1 } } },
    ]);
  });

  const PREDICATE_SPELLINGS = [`{ cat: "a" }`, `["cat", "a"]`];
  for (const spelling of PREDICATE_SPELLINGS) {
    it(`.find(${spelling}) emits exactly what the equivalent arrow does`, () => {
      expect(jsmql(`$.o = $$$.orders.find(${spelling});`)).toEqual(jsmql(`$.o = $$$.orders.find(o => o.cat === "a");`));
    });
    it(`.map(${spelling}) emits exactly what the equivalent arrow does`, () => {
      // The twin spells its param `jsmqlEl` — the synthetic name a shorthand desugars
      // to. A user arrow names its own param, so `$map.as` differs there and nowhere
      // else; that is the bound variable's name, not a difference in meaning.
      expect(jsmql(`$.o = $$$.orders.map(${spelling});`)).toEqual(
        jsmql(`$.o = $$$.orders.map(jsmqlEl => jsmqlEl.cat === "a");`),
      );
    });
  }

  // Whether a computed key works is decided by the SLOT it lands in, not by the
  // method's spelling rules: `$group._id` is an expression the server evaluates per
  // document, so it takes one; a `$sort` key / `$unwind` path must be a literal field
  // path, so it can't. The split below is that line, and nothing else.
  it("a computed key lowers straight into $group._id — no extra stages", () => {
    expect(jsmql(`$$ = $$.countBy(d => d.cat.toLowerCase());`)).toEqual([
      { $group: { _id: { $toLower: "$cat" }, __jsmqlTmp: { $sum: 1 } } },
      {
        $group: {
          _id: null,
          __jsmqlTmp: { $push: { k: { $ifNull: [{ $toString: "$_id" }, "null"] }, v: "$__jsmqlTmp" } },
        },
      },
      { $replaceWith: { $arrayToObject: "$__jsmqlTmp" } },
    ]);
    expect(jsmql(`$$ = $$.uniqBy(d => d.a + d.b);`)).toEqual([
      { $group: { _id: { $add: ["$a", "$b"] }, __jsmqlTmp: { $first: "$$ROOT" } } },
      { $replaceWith: "$__jsmqlTmp" },
    ]);
    // A lodash matches shorthand keys on the match BOOLEAN, same as `_.matches`.
    expect(jsmql(`$$ = $$.keyBy({ active: true });`)).toEqual(jsmql(`$$ = $$.keyBy(d => d.active === true);`));
    expect(jsmql(`$$ = $$.countBy(["status", "open"]);`)).toEqual(jsmql(`$$ = $$.countBy(d => d.status === "open");`));
  });

  it("a plain field key still emits byte-identically after the computed-key change", () => {
    // The `fieldKeyArg` fast path in `keyExpr` exists so adding expression support
    // couldn't perturb the overwhelmingly common spelling.
    for (const m of ["groupBy", "countBy", "keyBy", "uniqBy"]) {
      expect(JSON.stringify(jsmql(`$$ = $$.${m}("cat");`)), m).toContain(`"_id":"$cat"`);
    }
  });

  it(".groupBy(<computed>) still collapses — the unwrap follows the key FORM, not its spelling", () => {
    // Each time the key surface grew, `isCollapsingTerminal` stopped recognising the
    // new spelling and silently returned the raw `[obj]` slot. It now tests "not the
    // $group-body form", so it can't fall behind again.
    for (const key of [`"cat"`, `d => d.cat`, `d => d.cat.toLowerCase()`]) {
      expect(JSON.stringify(jsmql(`$.o = $$$.orders.groupBy(${key});`)), key).toContain("$first");
    }
    expect(jsmql(`$$ = $$.groupBy({ _id: "$cat" });`)).toEqual([{ $group: { _id: "$cat" } }]);
  });

  it("a computed sort key materialises into a scratch field ahead of the $sort", () => {
    // `$sort` needs a literal field path, so unlike `$group._id` the expression can't
    // go inline — one `$addFields` puts it in a `__jsmql.tmp` slot first.
    expect(jsmql(`$$ = $$.sortBy(d => d.cat.toLowerCase());`)).toEqual([
      { $addFields: { "__jsmql.tmp.1": { $toLower: "$cat" } } },
      { $sort: { "__jsmql.tmp.1": 1 } },
      { $unset: "__jsmql" },
    ]);
    expect(jsmql(`$$ = $$.orderBy(d => d.cat.toLowerCase(), -1);`)).toEqual([
      { $addFields: { "__jsmql.tmp.1": { $toLower: "$cat" } } },
      { $sort: { "__jsmql.tmp.1": -1 } },
      { $unset: "__jsmql" },
    ]);
    // A plain field key is untouched — still the single `$sort` it always was.
    expect(jsmql(`$$ = $$.sortBy("cat");`)).toEqual([{ $sort: { cat: 1 } }]);
  });

  it("a computed sort key's scratch $unset stays out of the way of later stages", () => {
    // The `$sort` must remain adjacent to whatever follows, so the cleanup is held to
    // the end of the chain rather than emitted right after the `$sort`.
    expect(jsmql(`$$ = $$.sortBy(d => d.cat.toLowerCase()).take(3);`)).toEqual([
      { $addFields: { "__jsmql.tmp.1": { $toLower: "$cat" } } },
      { $sort: { "__jsmql.tmp.1": 1 } },
      { $limit: 3 },
      { $unset: "__jsmql" },
    ]);
    // Descending is written directly — there is no reverse-a-previous-sort form.
    expect(jsmql(`$$ = $$.orderBy(d => d.cat.toLowerCase(), -1);`)).toEqual([
      { $addFields: { "__jsmql.tmp.1": { $toLower: "$cat" } } },
      { $sort: { "__jsmql.tmp.1": -1 } },
      { $unset: "__jsmql" },
    ]);
  });

  it("`.flatMap` is the one key slot that still can't take a computed value", () => {
    // `$unwind` returns each element to a NAMED field, so the name is part of what the
    // user means — auto-materialising into a scratch slot would discard the elements.
    expect(() => jsmql(`$.o = $$$.orders.flatMap({ cat: 1 });`)).toThrow(/Materialise the array into a field first/);
    expect(() => jsmql(`$.o = $$$.orders.flatMap(d => d.a.concat(d.b));`)).toThrow(/needs a field path/);
  });

  it("an object on a sort method still means directions, not a matcher", () => {
    expect(jsmql(`$.o = $$$.orders.orderBy({ cat: -1 });`)).toEqual(jsmql(`$.o = $$$.orders.orderBy(["cat"], [-1]);`));
    expect(() => jsmql(`$.o = $$$.orders.sortBy({ cat: 1 });`)).toThrow(/Use '\.orderBy\({ field: -1 }\)'/);
  });

  it("a computed-key iteratee's own errors name the calling method, not `.map`", () => {
    // The `$group`-keyed methods reuse `.map`'s body/param helpers to lower a computed
    // key, so their errors have to be re-pointed — otherwise `.countBy(d => …)` fails
    // talking about `.map`, the same wrong-method trap as `.keyBy` citing `.countBy`.
    expect(() => jsmql(`$$ = $$.countBy(d => $.other);`)).toThrow(/inside '\.countBy\(d => …\)'/);
    expect(() => jsmql(`$$ = $$.uniqBy(function (d) { const y = d.x; return y; });`)).toThrow(
      /^\.uniqBy\(d => \{ … \}\) with 'let'\/'const' bindings/,
    );
    expect(() => jsmql(`$$ = $$.countBy((d, i) => d.x);`)).toThrow(/single-parameter iteratee/);
  });

  it("each key-slot error names the method it was called on, not a sibling", () => {
    // `.keyBy`/`.uniqBy` used to demonstrate `.countBy("status")` in their own errors.
    expect(() => jsmql(`$.o = $$$.orders.keyBy(5);`)).toThrow(/'\.keyBy\("status"\)'/);
    expect(() => jsmql(`$.o = $$$.orders.uniqBy(5);`)).toThrow(/'\.uniqBy\("status"\)'/);
    expect(() => jsmql(`$.o = $$$.orders.sortBy([5]);`)).toThrow(/'\.sortBy\("status"\)'/);
  });
});
