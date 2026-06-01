import { describe, it, expect } from "vitest";
import { jsmql } from "../src/index.ts";

describe("pipeline detection", () => {
  it("compiles a single-stage pipeline as an array", () => {
    expect(jsmql("[ { $limit: 10 } ]")).toEqual([{ $limit: 10 }]);
  });

  it("non-stage array still compiles as expression-mode array literal", () => {
    // `jsmql.expr()` reveals the expression-mode lowering directly; calling `jsmql()`
    // here would route through the top-level Filter dispatch, which wraps
    // any non-predicate expression in `$expr`.
    expect(jsmql.expr("[1, 2, 3]")).toEqual([1, 2, 3]);
  });

  it("array of mixed scalars and unrelated objects stays expression-mode", () => {
    // First element isn't a stage shape, so the whole array is treated as a
    // value array. We get whatever the codegen would normally produce.
    expect(jsmql.expr("[1, { $limit: 10 }]")).toEqual([1, { $limit: 10 }]);
  });

  it("empty array is not a pipeline", () => {
    expect(jsmql.expr("[]")).toEqual([]);
  });
});

describe("pipeline — stage-object form", () => {
  it("$match with translatable expression body emits an index-friendly query doc", () => {
    // See `docs/specs/match-query-translation.md` for the full rules; cases
    // that fall outside the translatable subset are exercised in
    // `test/match-translation.test.ts`.
    expect(jsmql("[{ $match: $.age > 18 }]")).toEqual([{ $match: { age: { $gt: 18 } } }]);
  });

  it("$match with object-literal body passes through as raw query doc", () => {
    expect(jsmql("[{ $match: { age: { $gt: 18 } } }]")).toEqual([{ $match: { age: { $gt: 18 } } }]);
  });

  it("$project with mixed include flags and computed fields", () => {
    expect(jsmql("[{ $project: { name: 1, total: $.price * $.qty } }]")).toEqual([
      { $project: { name: 1, total: { $multiply: ["$price", "$qty"] } } },
    ]);
  });

  it("$group with accumulator", () => {
    expect(jsmql("[{ $group: { _id: $.dept, total: $sum($.salary) } }]")).toEqual([
      { $group: { _id: "$dept", total: { $sum: "$salary" } } },
    ]);
  });

  it("$sort and $limit", () => {
    expect(jsmql("[{ $sort: { total: -1 } }, { $limit: 10 }]")).toEqual([{ $sort: { total: -1 } }, { $limit: 10 }]);
  });

  it("$skip with a numeric scalar body", () => {
    expect(jsmql("[{ $skip: 50 }]")).toEqual([{ $skip: 50 }]);
  });

  it("$count with a string scalar body", () => {
    expect(jsmql('[{ $count: "totalDocs" }]')).toEqual([{ $count: "totalDocs" }]);
  });

  it("$unwind with a field-ref body", () => {
    expect(jsmql("[{ $unwind: $.items }]")).toEqual([{ $unwind: "$items" }]);
  });

  it("$set / $addFields are first-class stages", () => {
    expect(jsmql("[{ $set: { fullName: $.firstName + ' ' + $.lastName } }]")).toEqual([
      { $set: { fullName: { $concat: ["$firstName", " ", "$lastName"] } } },
    ]);
    expect(jsmql("[{ $addFields: { ratio: $.a / $.b } }]")).toEqual([
      { $addFields: { ratio: { $divide: ["$a", "$b"] } } },
    ]);
  });

  it("$replaceRoot and $replaceWith", () => {
    expect(jsmql("[{ $replaceRoot: { newRoot: $.user } }]")).toEqual([{ $replaceRoot: { newRoot: "$user" } }]);
    expect(jsmql("[{ $replaceWith: $.user }]")).toEqual([{ $replaceWith: "$user" }]);
  });
});

describe("pipeline — stage-call form", () => {
  it("$match expression body translates to a query doc", () => {
    expect(jsmql("[$match($.age > 18)]")).toEqual([{ $match: { age: { $gt: 18 } } }]);
  });

  it("$match object-literal body is raw query doc", () => {
    expect(jsmql("[$match({ age: { $gt: 18 } })]")).toEqual([{ $match: { age: { $gt: 18 } } }]);
  });

  it("$project, $group, $sort, $limit", () => {
    expect(
      jsmql(`[
        $project({ name: 1, total: $.price * $.qty }),
        $group({ _id: $.dept, total: $sum($.salary) }),
        $sort({ total: -1 }),
        $limit(10)
      ]`),
    ).toEqual([
      { $project: { name: 1, total: { $multiply: ["$price", "$qty"] } } },
      { $group: { _id: "$dept", total: { $sum: "$salary" } } },
      { $sort: { total: -1 } },
      { $limit: 10 },
    ]);
  });

  it("$limit and $skip with scalar args", () => {
    expect(jsmql("[$limit(5)]")).toEqual([{ $limit: 5 }]);
    expect(jsmql("[$skip(50)]")).toEqual([{ $skip: 50 }]);
  });

  it("$unwind with field-ref arg", () => {
    expect(jsmql("[$unwind($.items)]")).toEqual([{ $unwind: "$items" }]);
  });

  it("$count with string arg", () => {
    expect(jsmql('[$count("totalDocs")]')).toEqual([{ $count: "totalDocs" }]);
  });
});

describe("pipeline — mixed forms", () => {
  it("stage-object and stage-call elements compose in one pipeline", () => {
    expect(
      jsmql(`[
        { $match: $.active === true },
        $sort({ created: -1 }),
        { $limit: 25 }
      ]`),
    ).toEqual([{ $match: { active: true } }, { $sort: { created: -1 } }, { $limit: 25 }]);
  });

  it("the two forms produce identical output for the same stage", () => {
    const a = jsmql("[$match($.age > 18)]");
    const b = jsmql("[{ $match: $.age > 18 }]");
    expect(a).toEqual(b);
  });
});

describe("pipeline — sub-pipelines", () => {
  it("$lookup recurses into the pipeline: field", () => {
    expect(
      jsmql(`[{
        $lookup: {
          from: "orders",
          let: { uid: $._id },
          pipeline: [
            { $match: $.userId === 42 },
            { $project: { total: 1 } }
          ],
          as: "userOrders"
        }
      }]`),
    ).toEqual([
      {
        $lookup: {
          from: "orders",
          let: { uid: "$_id" },
          pipeline: [{ $match: { userId: 42 } }, { $project: { total: 1 } }],
          as: "userOrders",
        },
      },
    ]);
  });

  it("$lookup pipeline: field that is not a stage array stays as expression", () => {
    // If the value isn't pipeline-shaped, generate it normally — no error.
    expect(jsmql('[{ $lookup: { from: "x", pipeline: $.someVar, as: "y" } }]')).toEqual([
      { $lookup: { from: "x", pipeline: "$someVar", as: "y" } },
    ]);
  });

  it("$facet recurses into every value", () => {
    expect(
      jsmql(`[{
        $facet: {
          byCount: [{ $count: "n" }],
          topThree: [{ $sort: { score: -1 } }, { $limit: 3 }]
        }
      }]`),
    ).toEqual([{ $facet: { byCount: [{ $count: "n" }], topThree: [{ $sort: { score: -1 } }, { $limit: 3 }] } }]);
  });

  it("$unionWith recurses into pipeline:", () => {
    expect(jsmql(`[{ $unionWith: { coll: "archive", pipeline: [{ $match: $.year < 2020 }] } }]`)).toEqual([
      { $unionWith: { coll: "archive", pipeline: [{ $match: { year: { $lt: 2020 } } }] } },
    ]);
  });
});

describe("pipeline — error cases", () => {
  it("rejects unknown stage name with did-you-mean suggestion", () => {
    expect(() => jsmql("[{ $macth: $.age > 18 }]")).toThrow(/'\$match'/);
  });

  it("rejects unknown stage name in stage-call form", () => {
    expect(() => jsmql("[$prject({ name: 1 })]")).toThrow(/'\$project'/);
  });

  it("once first element is a stage, every element must be a stage", () => {
    expect(() => jsmql("[{ $match: $.a > 1 }, 42]")).toThrow(/Element 1/);
  });

  it("multi-key object cannot be a stage element", () => {
    expect(() => jsmql("[{ $match: { age: 1 }, $sort: { age: 1 } }]")).toThrow(/single-key stage object/);
  });

  it("jsmql.validate() surfaces pipeline errors as CODEGEN_ERROR", () => {
    const r = jsmql.validate("[{ $macth: $.age > 18 }]");
    expect(r.valid).toBe(false);
    expect(r.errors[0].code).toBe("CODEGEN_ERROR");
    expect(r.errors[0].message).toMatch(/\$match/);
  });
});

describe("pipeline — jsmql template-tag form", () => {
  it("interpolates a value into a stage body", () => {
    const minAge = 18;
    const limit = 25;
    expect(jsmql`[ { $match: $.age > ${minAge} }, { $limit: ${limit} } ]`).toEqual([
      { $match: { age: { $gt: 18 } } },
      { $limit: 25 },
    ]);
  });
});

describe("pipeline — function input", () => {
  it("compiles an arrow returning a pipeline", () => {
    expect(jsmql(($) => [{ $match: $.active === true }, { $sort: { created: -1 } }, { $limit: 10 }])).toEqual([
      { $match: { active: true } },
      { $sort: { created: -1 } },
      { $limit: 10 },
    ]);
  });
});

describe("pipeline — replace root (`$ = <expr>`)", () => {
  it("bare field-ref RHS lowers to `$replaceWith: <path>`", () => {
    expect(jsmql("[ $ = $.profile ]")).toEqual([{ $replaceWith: "$profile" }]);
  });

  it("identity (`$ = $`) round-trips through `$$ROOT`", () => {
    // No-op semantically; we still emit the stage rather than dropping it.
    expect(jsmql("[ $ = $ ]")).toEqual([{ $replaceWith: "$$ROOT" }]);
  });

  it("spread-merge over `$` emits a `$mergeObjects` newRoot", () => {
    expect(jsmql("[ $ = { ...$, computedScore: $.points * 1.1 } ]")).toEqual([
      { $replaceWith: { $mergeObjects: ["$$ROOT", { computedScore: { $multiply: ["$points", 1.1] } }] } },
    ]);
  });

  it("nested field path RHS lowers verbatim", () => {
    expect(jsmql("[ $ = $.user.address ]")).toEqual([{ $replaceWith: "$user.address" }]);
  });

  it("wraps the current doc under a key (`$ = { summary: $ }`)", () => {
    // Bare `$` in a value position is the whole current document — the same
    // role MQL spells as `$$ROOT`. This is the natural way to demote the
    // current root into a sub-document of a fresh wrapper.
    expect(jsmql("[ $ = { summary: $ } ]")).toEqual([{ $replaceWith: { summary: "$$ROOT" } }]);
  });

  it("operator-call RHS lowers verbatim (object form)", () => {
    expect(jsmql("[ $ = $mergeObjects($.a, $.b) ]")).toEqual([{ $replaceWith: { $mergeObjects: ["$a", "$b"] } }]);
  });

  it("direct lookup `.find` lowers to $lookup + $replaceWith {$first}", () => {
    expect(jsmql("[ $ = $$$.users.find(u => u._id === $.userId) ]")).toEqual([
      { $lookup: { from: "users", localField: "userId", foreignField: "_id", as: "__jsmql.__lookup1" } },
      { $replaceWith: { $first: "$__jsmql.__lookup1" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("adjacent update ops flush correctly around `$ = ...`", () => {
    expect(jsmql("$.a = 1; $ = $.profile; $.b = 2")).toEqual([
      { $set: { a: 1 } },
      { $replaceWith: "$profile" },
      { $set: { b: 2 } },
    ]);
  });

  it("`;`-form mirrors `[…]`-form for the bare-field-ref RHS", () => {
    expect(jsmql("$ = $.profile;")).toEqual([{ $replaceWith: "$profile" }]);
  });

  it("bare `$` in expression position lowers to `$$ROOT`", () => {
    expect(jsmql.expr("$mergeObjects($, { x: 1 })")).toEqual({ $mergeObjects: ["$$ROOT", { x: 1 }] });
  });

  it("rejects array RHS with an actionable error", () => {
    expect(() => jsmql("[ $ = [1, 2] ]")).toThrow(/Cannot replace root with an array.*\$ = \{ items: \[\.\.\.\] \}/);
  });

  it("rejects scalar number RHS with an actionable error", () => {
    expect(() => jsmql("[ $ = 5 ]")).toThrow(/Cannot replace root with a number.*\$ = \{ value: \.\.\. \}/);
  });

  it("rejects string RHS with an actionable error", () => {
    expect(() => jsmql('[ $ = "foo" ]')).toThrow(/Cannot replace root with a string/);
  });

  it("rejects `.filter()` lookup RHS, suggesting `.find()`", () => {
    expect(() => jsmql("[ $ = $$$.users.filter(u => u.active) ]")).toThrow(
      /Cannot replace root with an array.*\.filter\(\.\.\.\).*\.find\(\.\.\.\)/,
    );
  });

  it("rejects `delete $` with a hint pointing at `$ = …`", () => {
    expect(() => jsmql("delete $;")).toThrow(/Cannot 'delete \$'.*'\$ = <newDoc>'/);
  });

  it("rejects compound increment on bare `$`", () => {
    expect(() => jsmql("$++;")).toThrow(/compound assignment \/ increment on bare '\$'/);
  });

  it("rejects compound assignment on bare `$`", () => {
    expect(() => jsmql("$ += 5;")).toThrow(/compound assignment \/ increment on bare '\$'/);
  });

  it("validate() surfaces the rejection with a real .pos (not 0)", () => {
    const r = jsmql.validate("[ $ = [1, 2] ]");
    expect(r.valid).toBe(false);
    expect(r.errors[0].code).toBe("CODEGEN_ERROR");
    expect(r.errors[0].pos).toBeGreaterThan(0);
    expect(r.errors[0].message).toMatch(/Cannot replace root with an array/);
  });

  it("clears `let` scope after `$ = …` (subsequent reference errors precisely)", () => {
    // `$replaceWith` is reshape-clearing: any `let` declared before is gone.
    // The next statement's reference to `$$.x` must surface a precise error
    // rather than silently resolve against a slot that no longer exists.
    expect(() => jsmql("let x = $.a; $ = $.profile; $.b = x;")).toThrow(/can't be read after.*\$replaceWith/);
  });
});

describe("pipeline — facet (`$ = { k: $$.filter(...) }`)", () => {
  it("expression-body predicate becomes a `$match` sub-pipeline", () => {
    expect(jsmql(`$ = { recent: $$.filter(o => o.createdAt >= "2026-01-01") };`)).toEqual([
      { $facet: { recent: [{ $match: { createdAt: { $gte: "2026-01-01" } } }] } },
    ]);
  });

  it("block-body predicate becomes the block's stages", () => {
    expect(jsmql(`$ = { topByScore: $$.filter(o => { $sort({ score: -1 }); $limit(10); }) };`)).toEqual([
      { $facet: { topByScore: [{ $sort: { score: -1 } }, { $limit: 10 }] } },
    ]);
  });

  it("multi-facet pipeline with mixed predicate shapes", () => {
    expect(
      jsmql(`$ = {
        topByScore: $$.filter(o => { $sort({ score: -1 }); $limit(10); }),
        recent:     $$.filter(o => o.createdAt >= "2026-01-01"),
        byStatus:   $$.filter(o => { $group({ _id: o.status, n: $sum(1) }); })
      };`),
    ).toEqual([
      {
        $facet: {
          topByScore: [{ $sort: { score: -1 } }, { $limit: 10 }],
          recent: [{ $match: { createdAt: { $gte: "2026-01-01" } } }],
          byStatus: [{ $group: { _id: "$status", n: { $sum: 1 } } }],
        },
      },
    ]);
  });

  it("non-translatable predicate residual rides in `$expr`", () => {
    expect(jsmql(`$ = { active: $$.filter(o => o.active) };`)).toEqual([
      { $facet: { active: [{ $match: { $expr: "$active" } }] } },
    ]);
  });

  it("uses lambda-param references for foreign fields (basic shape)", () => {
    expect(jsmql(`$ = { byCat: $$.filter(o => { $group({ _id: o.category }); }) };`)).toEqual([
      { $facet: { byCat: [{ $group: { _id: "$category" } }] } },
    ]);
  });

  it("vacuous predicate (literal `true`) emits a trivial `$match`", () => {
    expect(jsmql(`$ = { all: $$.filter(o => true) };`)).toEqual([{ $facet: { all: [{ $match: { $expr: true } }] } }]);
  });

  it("rejects `$.<field>` inside the predicate with a 'use lambda param' hint", () => {
    expect(() => jsmql(`$ = { recent: $$.filter(o => $.x > 5) };`)).toThrow(
      /\$\.<field>.*use the lambda parameter.*\bo\.x\b/,
    );
  });

  it("rejects zero-argument lambda — the doc must be named", () => {
    expect(() => jsmql(`$ = { a: $$.filter(() => true) };`)).toThrow(/must take exactly one parameter/);
  });

  it("rejects two-argument lambda", () => {
    expect(() => jsmql(`$ = { a: $$.filter((a, b) => a.x > 5) };`)).toThrow(/must take exactly one parameter/);
  });

  it("rejects mixed-shape RHS where some values aren't `$$.filter(...)`", () => {
    expect(() => jsmql(`$ = { a: $$.filter(o => o.x > 0), b: 1 };`)).toThrow(
      /every value must be `\$\$\.filter\(<predicate>\)`.*Entry 'b'/,
    );
  });

  it("rejects spread entries inside the facet object", () => {
    expect(() => jsmql(`$ = { a: $$.filter(o => true), ...rest };`)).toThrow(
      /\$facet pattern: spread entries are not allowed/,
    );
  });

  it("rejects duplicate facet keys", () => {
    expect(() => jsmql(`$ = { a: $$.filter(o => o.x > 0), a: $$.filter(o => o.y > 0) };`)).toThrow(/duplicate key 'a'/);
  });

  it("statement-position `$$.filter(...)` (not in facet) suggests `$match` or facet shape", () => {
    expect(() => jsmql(`$$.filter(o => o.x > 0);`)).toThrow(
      /'\$\$\.filter\(<predicate>\)' is only valid as the RHS of `\$\$ = \$\$\.filter\(<predicate>\)` or as a value inside.*`\$match\(<predicate>\)` instead/,
    );
  });

  it("$facet is reshape-clearing: prior lets can't be read after", () => {
    expect(() => jsmql(`let n = $.threshold; $ = { hot: $$.filter(o => o.score > 0) }; $.copy = n;`)).toThrow(
      /can't be read after.*\$facet/,
    );
  });
});

describe("pipeline — replace stream (`$$ = <expr>`)", () => {
  it("`$$ = $$.filter(p)` lowers to a single `$match` stage", () => {
    expect(jsmql(`$$ = $$.filter(t => t.client === 156 && t.createdAt >= "2026-01-01");`)).toEqual([
      { $match: { client: 156, createdAt: { $gte: "2026-01-01" } } },
    ]);
  });

  it("`$$ = $$$.<coll>.filter(p)` lowers to `$limit: 0` + `$unionWith`", () => {
    expect(jsmql(`$$ = $$$.transactions.filter(t => t.client === 156);`)).toEqual([
      { $limit: 0 },
      { $unionWith: { coll: "transactions", pipeline: [{ $match: { client: 156 } }] } },
    ]);
  });

  it("source switch translates Date literal in the predicate", () => {
    const out = jsmql(`$$ = $$$.transactions.filter(t => t.createdAt >= new Date("2026-01-01"));`) as object[];
    // Date folds to a JS `Date` instance, so deep-equal needs the same shape.
    expect(out).toEqual([
      { $limit: 0 },
      { $unionWith: { coll: "transactions", pipeline: [{ $match: { createdAt: { $gte: new Date("2026-01-01") } } }] } },
    ]);
  });

  it("bracketed `[...]` form works for both shapes", () => {
    expect(jsmql(`[ $$ = $$.filter(t => t.x > 0) ]`)).toEqual([{ $match: { x: { $gt: 0 } } }]);
    expect(jsmql(`[ $$ = $$$.users.filter(u => u.active) ]`)).toEqual([
      { $limit: 0 },
      { $unionWith: { coll: "users", pipeline: [{ $match: { $expr: "$active" } }] } },
    ]);
  });

  it("block-body predicate in source-switch becomes the block's stages", () => {
    expect(
      jsmql(`$$ = $$$.transactions.filter(t => { $match(t.amount > 100); $sort({ amount: -1 }); $limit(5); });`),
    ).toEqual([
      { $limit: 0 },
      {
        $unionWith: {
          coll: "transactions",
          pipeline: [{ $match: { amount: { $gt: 100 } } }, { $sort: { amount: -1 } }, { $limit: 5 }],
        },
      },
    ]);
  });

  it("cross-DB source switch emits the `{ db, coll }` shape", () => {
    expect(jsmql(`$$ = $$$$.analytics.events.filter(e => e.type === "purchase");`)).toEqual([
      { $limit: 0 },
      { $unionWith: { coll: { db: "analytics", coll: "events" }, pipeline: [{ $match: { type: "purchase" } }] } },
    ]);
  });

  it("`$$ = $$.filter(...)` preserves the outer let scope", () => {
    // The narrow form is just a $match — outer lets stay visible inside its
    // predicate AND in subsequent stages.
    expect(jsmql(`let cutoff = 10; $$ = $$.filter(t => t.score > cutoff); $.flagged = true;`)).toEqual([
      { $set: { "__jsmql.cutoff": 10 } },
      { $match: { $expr: { $gt: ["$score", "$__jsmql.cutoff"] } } },
      { $set: { flagged: true } },
      { $unset: "__jsmql" },
    ]);
  });

  it("source switch (`$$ = $$$.<coll>.filter(...)`) clears the let scope", () => {
    // The outer collection's docs are gone after `$limit: 0`, so any prior
    // `let` binding is unreadable. Subsequent references must error precisely.
    expect(() => jsmql(`let cutoff = 10; $$ = $$$.t.filter(o => true); $.flagged = cutoff;`)).toThrow(
      /can't be read after.*\$unionWith/,
    );
  });

  it("`$$ = []` lowers to `$limit(0)` (drop all docs)", () => {
    // Previously rejected; landed in the deferred-features Wave 5 push as
    // the natural sugar for "empty the stream".
    expect(jsmql(`$$ = [];`)).toEqual([{ $limit: 0 }]);
  });

  it("`$$ = [{...}, {...}]` at stage 0 lowers to `$documents`", () => {
    expect(jsmql(`$$ = [{ _id: 1 }, { _id: 2 }];`)).toEqual([{ $documents: [{ _id: 1 }, { _id: 2 }] }]);
  });

  it("rejects `$$ = [docs]` mid-pipeline — `$documents` must be at stage 0", () => {
    expect(() => jsmql(`$match($.active === true); $$ = [{ _id: 1 }];`)).toThrow(
      /\$\$ = \[<docs>\]'.*first stage.*\$documents.*\$\$\.push/s,
    );
  });

  it("rejects `$$ = <ternary>` as 'not yet supported'", () => {
    expect(() => jsmql(`$$ = true ? $$.filter(o => o.x) : $$.filter(o => o.y);`)).toThrow(
      /'\$\$ = <ternary>'.*not yet supported/,
    );
  });

  it("rejects `$$ = $$$.<coll>.find(...)` and points at the `.slice(0, 1)` / `$ = $$$.<coll>.find` alternatives", () => {
    expect(() => jsmql(`$$ = $$$.users.find(u => u.active);`)).toThrow(
      /'\.find\(\.\.\.\)' is not allowed.*pipelines are arrays.*\.slice\(0, 1\).*\$ = \$\$\$\.<coll>\.find/s,
    );
  });

  it("`$$ = $$.map(d => <expr>)` lowers to `$replaceWith` via the stream-method registry", () => {
    expect(jsmql(`$$ = $$.map(t => ({ x: t.x }));`)).toEqual([{ $replaceWith: { x: "$x" } }]);
  });

  it("rejects `$.<field>` inside the predicate with a 'use lambda param' hint", () => {
    expect(() => jsmql(`$$ = $$.filter(t => $.x > 5);`)).toThrow(/\$\.<field>.*use the lambda parameter.*\bt\.x\b/);
  });

  it("rejects bare `$$$.<coll>` on the RHS (no `.filter`)", () => {
    // The user named a collection but didn't call `.filter` — the catch-all
    // path names both supported forms.
    expect(() => jsmql(`$$ = $$$.transactions;`)).toThrow(
      /'\$\$ = …' RHS must be.*\$\$\.filter.*or.*\$\$\$\.<coll>\.filter/,
    );
  });

  it("validate() reports `$$ = []` as valid (now lowers cleanly to $limit:0)", () => {
    const r = jsmql.validate(`$$ = [];`);
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });
});

describe("$$ = $$$.<coll>.filter(<correlatedPred>).<chain> — $lookup-pivot dispatch", () => {
  it("predicate referencing $.<field> + single === → basic-form $lookup + $unwind + $replaceWith", () => {
    // The simplest correlated-source-switch shape. Predicate
    // `u._id === $.userId` is a single `===` between a foreign-path and a
    // local-path, so the lookup goes basic-form (`localField` /
    // `foreignField`). `$unwind` + `$replaceWith` turn the per-outer-doc
    // array of matches into the new stream.
    expect(jsmql(`$$ = $$$.users.filter(u => u._id === $.userId);`)).toEqual([
      { $lookup: { from: "users", localField: "userId", foreignField: "_id", as: "__jsmql.__lookup1" } },
      { $unwind: "$__jsmql.__lookup1" },
      { $replaceWith: "$__jsmql.__lookup1" },
      { $unset: "__jsmql" },
    ]);
  });

  it("predicate with chain methods → pipeline-form $lookup with chain extending the body", () => {
    // The chain methods (.slice here) need a pipeline-form lookup so they
    // can extend the sub-pipeline body. The $.<field> ref gets hoisted to
    // a `$lookup.let` var.
    expect(jsmql(`$$ = $$$.users.filter(u => u._id === $.userId).slice(0, 1);`)).toEqual([
      {
        $lookup: {
          from: "users",
          let: { userId: "$userId" },
          pipeline: [{ $match: { $expr: { $eq: ["$_id", "$$userId"] } } }, { $limit: 1 }],
          as: "__jsmql.__lookup1",
        },
      },
      { $unwind: "$__jsmql.__lookup1" },
      { $replaceWith: "$__jsmql.__lookup1" },
      { $unset: "__jsmql" },
    ]);
  });

  it(".toSorted + .slice top-N pivot — chain extends the pipeline body, then $unwind/$replaceWith", () => {
    // The killer DX case: "for each outer doc, give me the foreign coll
    // filtered + sorted + top-N as the new stream root". One JS chain.
    expect(
      jsmql(`$$ = $$$.orders.filter(o => o.userId === $._id).toSorted((a, b) => b.placedAt - a.placedAt).slice(0, 5);`),
    ).toEqual([
      {
        $lookup: {
          from: "orders",
          let: { _id: "$_id" },
          pipeline: [{ $match: { $expr: { $eq: ["$userId", "$$_id"] } } }, { $sort: { placedAt: -1 } }, { $limit: 5 }],
          as: "__jsmql.__lookup1",
        },
      },
      { $unwind: "$__jsmql.__lookup1" },
      { $replaceWith: "$__jsmql.__lookup1" },
      { $unset: "__jsmql" },
    ]);
  });

  it("multi-field correlated predicate → pipeline-form $lookup with multiple let vars", () => {
    expect(jsmql(`$$ = $$$.events.filter(e => e.userId === $._id && e.region === $.region);`)).toEqual([
      {
        $lookup: {
          from: "events",
          let: { _id: "$_id", region: "$region" },
          pipeline: [
            { $match: { $expr: { $and: [{ $eq: ["$userId", "$$_id"] }, { $eq: ["$region", "$$region"] }] } } },
          ],
          as: "__jsmql.__lookup1",
        },
      },
      { $unwind: "$__jsmql.__lookup1" },
      { $replaceWith: "$__jsmql.__lookup1" },
      { $unset: "__jsmql" },
    ]);
  });

  it("cross-database pivot ($$$$.<db>.<coll>) emits `from: { db, coll }`", () => {
    expect(jsmql(`$$ = $$$$.analytics.events.filter(e => e.userId === $._id);`)).toEqual([
      {
        $lookup: {
          from: { db: "analytics", coll: "events" },
          localField: "_id",
          foreignField: "userId",
          as: "__jsmql.__lookup1",
        },
      },
      { $unwind: "$__jsmql.__lookup1" },
      { $replaceWith: "$__jsmql.__lookup1" },
      { $unset: "__jsmql" },
    ]);
  });

  it("non-correlated predicate keeps using $unionWith (no regression)", () => {
    // No `$.<field>` ref — the predicate is a flat scan, so the existing
    // `$limit:0 + $unionWith` lowering is correct.
    expect(jsmql(`$$ = $$$.users.filter(u => u.active === true);`)).toEqual([
      { $limit: 0 },
      { $unionWith: { coll: "users", pipeline: [{ $match: { active: true } }] } },
    ]);
  });

  it("non-correlated predicate + chain keeps using $unionWith", () => {
    expect(jsmql(`$$ = $$$.users.filter(u => u.active === true).slice(0, 10);`)).toEqual([
      { $limit: 0 },
      { $unionWith: { coll: "users", pipeline: [{ $match: { active: true } }, { $limit: 10 }] } },
    ]);
  });

  it("chain without a .filter head keeps using $unionWith", () => {
    // No `.filter` head means no predicate, so no per-outer-doc correlation
    // to detect. The chain just runs against the foreign collection as a
    // standalone source.
    expect(jsmql(`$$ = $$$.users.slice(0, 5);`)).toEqual([
      { $limit: 0 },
      { $unionWith: { coll: "users", pipeline: [{ $limit: 5 }] } },
    ]);
  });

  it("outer `let` binding referenced in the predicate triggers basic-form pivot", () => {
    // `uid` is a let binding stored at `__jsmql.uid` on each outer doc.
    // `u._id === uid` is a single ===, so basic form fires — `localField`
    // uses the materialised `__jsmql.uid` path directly. Index-friendly.
    expect(jsmql(`let uid = $.userId; $$ = $$$.users.filter(u => u._id === uid);`)).toEqual([
      { $set: { "__jsmql.uid": "$userId" } },
      { $lookup: { from: "users", localField: "__jsmql.uid", foreignField: "_id", as: "__jsmql.__lookup1" } },
      { $unwind: "$__jsmql.__lookup1" },
      { $replaceWith: "$__jsmql.__lookup1" },
      { $unset: "__jsmql" },
    ]);
  });

  it("outer `let` binding works in expression-position lookup too", () => {
    expect(jsmql(`let uid = $.userId; $.matched = $$$.users.filter(u => u._id === uid);`)).toEqual([
      { $set: { "__jsmql.uid": "$userId" } },
      { $lookup: { from: "users", localField: "__jsmql.uid", foreignField: "_id", as: "matched" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("member access on an outer `let` binding (`user._id`) still picks basic form", () => {
    // `user` is a let-binding (the whole user object). `user._id` resolves
    // to the materialised path `__jsmql.user._id`. Still a single ===, so
    // basic form fires.
    expect(jsmql(`let user = $.user; $$ = $$$.events.filter(e => e.userId === user._id);`)).toEqual([
      { $set: { "__jsmql.user": "$user" } },
      { $lookup: { from: "events", localField: "__jsmql.user._id", foreignField: "userId", as: "__jsmql.__lookup1" } },
      { $unwind: "$__jsmql.__lookup1" },
      { $replaceWith: "$__jsmql.__lookup1" },
      { $unset: "__jsmql" },
    ]);
  });

  it("mixed `$.<field>` + outer-let predicate → pipeline-form with both hoisted as $lookup.let vars", () => {
    expect(
      jsmql(`let region = $.region; $$ = $$$.events.filter(e => e.userId === $._id && e.region === region);`),
    ).toEqual([
      { $set: { "__jsmql.region": "$region" } },
      {
        $lookup: {
          from: "events",
          let: { _id: "$_id", region: "$__jsmql.region" },
          pipeline: [
            { $match: { $expr: { $and: [{ $eq: ["$userId", "$$_id"] }, { $eq: ["$region", "$$region"] }] } } },
          ],
          as: "__jsmql.__lookup1",
        },
      },
      { $unwind: "$__jsmql.__lookup1" },
      { $replaceWith: "$__jsmql.__lookup1" },
      { $unset: "__jsmql" },
    ]);
  });

  it("outer let + chain methods → pipeline-form $lookup with chain in the body", () => {
    expect(
      jsmql(
        `let uid = $.userId; $$ = $$$.orders.filter(o => o.userId === uid).toSorted((a, b) => b.placedAt - a.placedAt).slice(0, 5);`,
      ),
    ).toEqual([
      { $set: { "__jsmql.uid": "$userId" } },
      {
        $lookup: {
          from: "orders",
          let: { uid: "$__jsmql.uid" },
          pipeline: [{ $match: { $expr: { $eq: ["$userId", "$$uid"] } } }, { $sort: { placedAt: -1 } }, { $limit: 5 }],
          as: "__jsmql.__lookup1",
        },
      },
      { $unwind: "$__jsmql.__lookup1" },
      { $replaceWith: "$__jsmql.__lookup1" },
      { $unset: "__jsmql" },
    ]);
  });
});
