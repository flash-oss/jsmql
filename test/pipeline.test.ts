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

  it("$unwind with string-literal path is NOT wrapped in $literal", () => {
    // $unwind's body is a field path, not an expression — the leading `$` is
    // the path the user means, so it must pass through raw (no $literal wrap).
    expect(jsmql('[$unwind("$items")]')).toEqual([{ $unwind: "$items" }]);
  });

  it("$unwind object body: path string is a raw field path", () => {
    expect(jsmql('[$unwind({ path: "$items", preserveNullAndEmptyArrays: true })]')).toEqual([
      { $unwind: { path: "$items", preserveNullAndEmptyArrays: true } },
    ]);
    expect(jsmql('[$unwind({ path: "$items", includeArrayIndex: "i" })]')).toEqual([
      { $unwind: { path: "$items", includeArrayIndex: "i" } },
    ]);
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

  it("$lookup pipeline: a field ref is rejected (HR3 — pipeline must be a constant array)", () => {
    // The server rejects `{ $lookup: { pipeline: "$someVar" } }` ("A pipeline must
    // be an array of objects"), so a non-array pipeline slot throws at compile time.
    expect(() => jsmql('[{ $lookup: { from: "x", pipeline: $.someVar, as: "y" } }]')).toThrow(
      /'\$lookup pipeline' must be a constant array/,
    );
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

describe("raw MQL stage bodies pass through UNGUARDED (escape hatch — see src/CLAUDE.md)", () => {
  // The complement of the cross-database SUGAR rejection (lookup.test.ts /
  // "replace stream"): jsmql rejects `$$$$.<db>.<coll>` reads because it minted
  // that surface (HR3), but it must NEVER guard the RAW operator/stage form — the
  // developer owns hand-written MQL, and a `{ db, coll }` namespace IS valid on
  // Atlas Data Federation. A guard creeping onto these (e.g. extending
  // requireSameDbColl to raw stages) must fail here.
  it("a raw cross-database $lookup `{ db, coll }` from is emitted verbatim", () => {
    expect(
      jsmql(`[{ $lookup: { from: { db: "x", coll: "y" }, localField: "a", foreignField: "b", as: "c" } }]`),
    ).toEqual([{ $lookup: { from: { db: "x", coll: "y" }, localField: "a", foreignField: "b", as: "c" } }]);
  });

  it("a raw cross-database $unionWith `coll: { db, coll }` is emitted verbatim", () => {
    expect(jsmql(`[{ $unionWith: { coll: { db: "x", coll: "y" } } }]`)).toEqual([
      { $unionWith: { coll: { db: "x", coll: "y" } } },
    ]);
  });

  it("an Atlas-only operator ($search) passes through (unknown-operator fallthrough)", () => {
    expect(jsmql(`[$search({ text: { query: "x", path: "title" } })]`)).toEqual([
      { $search: { text: { query: "x", path: "title" } } },
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
    expect(jsmql(({ $ }) => [{ $match: $.active === true }, { $sort: { created: -1 } }, { $limit: 10 }])).toEqual([
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
      { $lookup: { from: "users", localField: "userId", foreignField: "_id", as: "__jsmql.tmp.1" } },
      { $replaceWith: { $first: "$__jsmql.tmp.1" } },
    ]);
  });

  it("cross-database replace-root `$ = $$$$.<db>.<coll>.find(...)` is rejected", () => {
    // Distinct lowering path from the field-assign/source-switch/union cases:
    // the cross-DB guard fires from `lowerReplaceRoot` (its own `requireSameDbColl`
    // call site), so it gets its own coverage.
    expect(() => jsmql("[ $ = $$$$.analytics.users.find(u => u._id === $.userId) ]")).toThrow(
      /Cross-database reads aren't supported/,
    );
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

  // Regression: a bare `$ = <expr>` as the ONLY statement (no trailing `;`)
  // parses as a one-op UpdateFilter rather than a Pipeline, and used to emit a
  // meaningless `$set` on the "" field path (`[{ $set: { "": … } }]`). It must
  // lower to `$replaceWith`, identical to the `;`-terminated form.
  it("single-statement `$ = { … }` (no `;`) lowers to `$replaceWith`, not `$set: { '': … }`", () => {
    expect(jsmql("$ = { a: 1 }")).toEqual([{ $replaceWith: { a: 1 } }]);
    // …byte-identical to the `;`-form and the bracketed form.
    expect(jsmql("$ = { a: 1 }")).toEqual(jsmql("$ = { a: 1 };"));
    expect(jsmql("$ = { a: 1 }")).toEqual(jsmql("[ $ = { a: 1 } ]"));
  });

  it("single-statement `$ = <expr>` (no `;`) reroutes across every Pipeline entry", () => {
    const expected = [{ $replaceWith: "$profile" }];
    expect(jsmql("$ = $.profile")).toEqual(expected);
    expect(jsmql.expr("$ = $.profile")).toEqual(expected);
    expect(jsmql.pipeline("$ = $.profile")).toEqual(expected);
  });

  it("single-statement `$ = <expr>` still reuses the full replace-root machinery (non-document reject)", () => {
    // The reroute goes through `lowerReplaceRoot`, so the no-`;` form gets the
    // same actionable rejection as the `;`-form.
    expect(() => jsmql("$ = 5")).toThrow(/Cannot replace root with a number/);
    expect(() => jsmql("$ = [1, 2]")).toThrow(/Cannot fan out an array of number/);
  });

  it("a normal field update (`$.x = 1`, no `;`) is unaffected — stays `$set`", () => {
    expect(jsmql("$.x = 1")).toEqual([{ $set: { x: 1 } }]);
    expect(jsmql("$.x = 1, $.y = 2")).toEqual([{ $set: { x: 1, y: 2 } }]);
  });

  it("`jsmql.filter()` rejects a bare `$ = <expr>` with a root-replace-specific message", () => {
    expect(() => jsmql.filter("$ = { a: 1 }")).toThrow(/root-replace `\$ = <expr>`.*\$replaceWith/);
  });

  it("bare `$` in expression position lowers to `$$ROOT`", () => {
    expect(jsmql.expr("$mergeObjects($, { x: 1 })")).toEqual({ $mergeObjects: ["$$ROOT", { x: 1 }] });
  });

  it("fans out an array-literal of documents (one output doc per element)", () => {
    expect(jsmql("[ $ = [{ a: 1 }, { b: 2 }] ]")).toEqual([
      { $set: { "__jsmql.tmp.1": [{ a: 1 }, { b: 2 }] } },
      { $unwind: "$__jsmql.tmp.1" },
      { $replaceWith: "$__jsmql.tmp.1" },
    ]);
  });

  it("fans out a spread field (`$ = [...$.items]`)", () => {
    expect(jsmql("[ $ = [...$.items] ]")).toEqual([
      { $set: { "__jsmql.tmp.1": "$items" } },
      { $unwind: "$__jsmql.tmp.1" },
      { $replaceWith: "$__jsmql.tmp.1" },
    ]);
  });

  it("fans out a provably-array expression (`.map`)", () => {
    expect(jsmql("[ $ = $.items.map(x => ({ sku: x.sku })) ]")).toEqual([
      { $set: { "__jsmql.tmp.1": { $map: { input: "$items", as: "x", in: { sku: "$$x.sku" } } } } },
      { $unwind: "$__jsmql.tmp.1" },
      { $replaceWith: "$__jsmql.tmp.1" },
    ]);
  });

  it("fans out `Object.entries(...)` into {k, v} documents", () => {
    expect(jsmql("[ $ = Object.entries($.scores) ]")).toEqual([
      { $set: { "__jsmql.tmp.1": { $objectToArray: "$scores" } } },
      { $unwind: "$__jsmql.tmp.1" },
      { $replaceWith: "$__jsmql.tmp.1" },
    ]);
  });

  it("a possibly-empty filter fan-out drops docs whose array is empty (per-document drop)", () => {
    // `$unwind` of an empty array emits no document — so docs with no matching
    // element are dropped, while others fan out. This is how a conditional drop
    // is spelled (rather than a stream-wide `$$ = []`).
    expect(jsmql("[ $ = $.items.filter(x => x.qty > 0) ]")).toEqual([
      { $set: { "__jsmql.tmp.1": { $filter: { input: "$items", as: "x", cond: { $gt: ["$$x.qty", 0] } } } } },
      { $unwind: "$__jsmql.tmp.1" },
      { $replaceWith: "$__jsmql.tmp.1" },
    ]);
  });

  it("a bare field-ref RHS stays a single-doc `$replaceWith` (not provably an array)", () => {
    // `$.items` carries no compile-time type, so it is NOT fanned out — to fan
    // out a field the user writes `$ = [...$.items]`.
    expect(jsmql("[ $ = $.items ]")).toEqual([{ $replaceWith: "$items" }]);
  });

  it("rejects an empty array RHS, pointing at the conditional and stream-drop forms", () => {
    expect(() => jsmql("[ $ = [] ]")).toThrow(
      /Cannot fan out an empty array.*\$ = \$\.items\.filter\(\.\.\.\).*\$\$ = \[\]/,
    );
  });

  it("rejects an array of scalar literals (elements must be documents)", () => {
    expect(() => jsmql("[ $ = [1, 2] ]")).toThrow(/Cannot fan out an array of number.*\$ = \[\{ value: \.\.\. \}\]/);
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
    expect(r.errors[0].message).toMatch(/Cannot fan out an array of number/);
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

  it("statement-position `$$.filter(...)` (not in facet) lowers to `$match` — bare-statement stream sugar", () => {
    // Bare `$$.filter(...)` is sugar for `$$ = $$.filter(...)` (ships DEF-003),
    // so a statement-position filter now narrows the stream rather than erroring.
    expect(jsmql(`$$.filter(o => o.x > 0);`)).toEqual([{ $match: { x: { $gt: 0 } } }]);
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
      { $match: { $expr: false } },
      { $unionWith: { coll: "transactions", pipeline: [{ $match: { client: 156 } }] } },
    ]);
  });

  it("source switch translates Date literal in the predicate", () => {
    const out = jsmql(`$$ = $$$.transactions.filter(t => t.createdAt >= new Date("2026-01-01"));`) as object[];
    // Date folds to a JS `Date` instance, so deep-equal needs the same shape.
    expect(out).toEqual([
      { $match: { $expr: false } },
      { $unionWith: { coll: "transactions", pipeline: [{ $match: { createdAt: { $gte: new Date("2026-01-01") } } }] } },
    ]);
  });

  it("bracketed `[...]` form works for both shapes", () => {
    expect(jsmql(`[ $$ = $$.filter(t => t.x > 0) ]`)).toEqual([{ $match: { x: { $gt: 0 } } }]);
    expect(jsmql(`[ $$ = $$$.users.filter(u => u.active) ]`)).toEqual([
      { $match: { $expr: false } },
      { $unionWith: { coll: "users", pipeline: [{ $match: { $expr: "$active" } }] } },
    ]);
  });

  it("block-body predicate in source-switch becomes the block's stages", () => {
    expect(
      jsmql(`$$ = $$$.transactions.filter(t => { $match(t.amount > 100); $sort({ amount: -1 }); $limit(5); });`),
    ).toEqual([
      { $match: { $expr: false } },
      {
        $unionWith: {
          coll: "transactions",
          pipeline: [{ $match: { amount: { $gt: 100 } } }, { $sort: { amount: -1 } }, { $limit: 5 }],
        },
      },
    ]);
  });

  it("cross-DB source switch is rejected", () => {
    expect(() => jsmql(`$$ = $$$$.analytics.events.filter(e => e.type === "purchase");`)).toThrow(
      /Cross-database reads aren't supported/,
    );
  });

  it("`$$ = $$.filter(...)` preserves the outer let scope", () => {
    // The narrow form is just a $match — outer lets stay visible inside its
    // predicate AND in subsequent stages. (Runtime RHS `$.min` keeps it a `$set`
    // binding; a constant `cutoff` would fold and inline instead.)
    expect(jsmql(`let cutoff = $.min; $$ = $$.filter(t => t.score > cutoff); $.flagged = true;`)).toEqual([
      { $set: { "__jsmql.var.cutoff": "$min" } },
      { $match: { $expr: { $gt: ["$score", "$__jsmql.var.cutoff"] } } },
      { $set: { flagged: true } },
      { $unset: "__jsmql" },
    ]);
  });

  it("source switch (`$$ = $$$.<coll>.filter(...)`) clears the let scope", () => {
    // The outer collection's docs are gone after `$limit: 0`, so any prior
    // `let` binding is unreadable. Subsequent references must error precisely.
    // (Runtime RHS `$.min`; a compile-time constant would inline everywhere and
    // legitimately survive the source switch.)
    expect(() => jsmql(`let cutoff = $.min; $$ = $$$.t.filter(o => true); $.flagged = cutoff;`)).toThrow(
      /can't be read after.*\$unionWith/,
    );
  });

  // Outer context referenced INSIDE a source-switch's chain body (vs the prior
  // test, which references it in a later top-level stage). A bare
  // `$$ = $$$.<coll>.map(…)` is a `$unionWith` that REPLACES the stream, so the
  // outer document / root `$$.length` / outer `let`s aren't carried in — the
  // error must say so and point at the correlated `.filter` form (which DOES
  // thread them; see stream-length.test.ts "four kinds of length").
  it("outer `let` read inside a source-switch `.map` body → 'correlate with a .filter' error", () => {
    expect(() => jsmql(`const k = $.min + 1; $$ = $$$.orders.map(o => ({ v: k }));`)).toThrow(
      /`k` is a `let`\/`const` declared before `\$\$ = \$\$\$\.orders`[\s\S]*correlate with a `\.filter`/,
    );
  });

  it("root `$.<field>` read inside a source-switch `.map` body → 'outer document is gone' error", () => {
    // Not the generic "use the param" hint — here `o.length` would be the
    // SWITCHED collection's field, not the original root's, so that hint misleads.
    expect(() => jsmql(`$$ = $$$.orders.map(o => ({ v: $.length }));`)).toThrow(
      /`\$\.length` \(the outer document\) isn't available inside `\$\$ = \$\$\$\.orders`[\s\S]*correlate with a `\.filter`/,
    );
  });

  it("a top-level `$$.map` keeps the plain 'use the param' hint (not a source-switch)", () => {
    // No source-switch here, so the source-switch guidance must NOT leak in.
    expect(() => jsmql(`$$ = $$.map(o => ({ v: $.x }));`)).toThrow(
      /use the lambda parameter[\s\S]*IS the current document/,
    );
    expect(() => jsmql(`$$ = $$.map(o => ({ v: $.x }));`)).not.toThrow(/source-switch|correlate with/);
  });

  it("`$$ = []` lowers to `$match: { $expr: false }` (drop all docs)", () => {
    // Previously rejected; landed in the deferred-features Wave 5 push as
    // the natural sugar for "empty the stream".
    expect(jsmql(`$$ = [];`)).toEqual([{ $match: { $expr: false } }]);
  });

  it("`$$ = [{...}, {...}]` at stage 0 lowers to `$documents`", () => {
    expect(jsmql(`$$ = [{ _id: 1 }, { _id: 2 }];`)).toEqual([{ $documents: [{ _id: 1 }, { _id: 2 }] }]);
  });

  it("rejects `$$ = [docs]` mid-pipeline — `$documents` must be at stage 0", () => {
    expect(() => jsmql(`$match($.active === true); $$ = [{ _id: 1 }];`)).toThrow(
      /\$\$ = \[<docs>\]'.*first stage.*\$documents.*\$\$\.push/s,
    );
  });

  it("rejects `$$ = <ternary>` (conditional stream branching is not a supported form)", () => {
    expect(() => jsmql(`$$ = true ? $$.filter(o => o.x) : $$.filter(o => o.y);`)).toThrow(
      /'\$\$ = <ternary>'.*not a supported form/,
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

  it("rejects bare `$$$.<coll>` on the RHS (no stream method)", () => {
    // The user named a collection but didn't call a stream method — the catch-all
    // path names both supported forms and notes any stream method may head the chain.
    expect(() => jsmql(`$$ = $$$.transactions;`)).toThrow(
      /'\$\$ = …' RHS must be '\$\$\.<streamMethod>….*'\$\$\$\.<coll>\.<streamMethod>….*Any lodash stream method may head the chain/,
    );
  });

  it("validate() reports `$$ = []` as valid (now lowers cleanly to $match: { $expr: false })", () => {
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
      { $lookup: { from: "users", localField: "userId", foreignField: "_id", as: "__jsmql.tmp.1" } },
      { $unwind: "$__jsmql.tmp.1" },
      { $replaceWith: "$__jsmql.tmp.1" },
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
          let: { jsmql_f0_userId: "$userId" },
          pipeline: [{ $match: { $expr: { $eq: ["$_id", "$$jsmql_f0_userId"] } } }, { $limit: 1 }],
          as: "__jsmql.tmp.1",
        },
      },
      { $unwind: "$__jsmql.tmp.1" },
      { $replaceWith: "$__jsmql.tmp.1" },
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
          let: { jsmql_f0__id: "$_id" },
          pipeline: [
            { $match: { $expr: { $eq: ["$userId", "$$jsmql_f0__id"] } } },
            { $sort: { placedAt: -1 } },
            { $limit: 5 },
          ],
          as: "__jsmql.tmp.1",
        },
      },
      { $unwind: "$__jsmql.tmp.1" },
      { $replaceWith: "$__jsmql.tmp.1" },
    ]);
  });

  it("multi-field correlated predicate → pipeline-form $lookup with multiple let vars", () => {
    expect(jsmql(`$$ = $$$.events.filter(e => e.userId === $._id && e.region === $.region);`)).toEqual([
      {
        $lookup: {
          from: "events",
          let: { jsmql_f0__id: "$_id", jsmql_f0_region: "$region" },
          pipeline: [
            {
              $match: {
                $expr: { $and: [{ $eq: ["$userId", "$$jsmql_f0__id"] }, { $eq: ["$region", "$$jsmql_f0_region"] }] },
              },
            },
          ],
          as: "__jsmql.tmp.1",
        },
      },
      { $unwind: "$__jsmql.tmp.1" },
      { $replaceWith: "$__jsmql.tmp.1" },
    ]);
  });

  it("an object-returning .map reshapes each source doc into the new stream root", () => {
    // The mapped result becomes the new document stream, so it must be a document.
    // An object-literal body is fine: $replaceWith the reshaped doc in the sub-pipeline,
    // then $unwind + $replaceWith explode the array into the stream. Verified on mongod.
    expect(jsmql(`$$ = $$$.orders.filter(o => o.userId === $._id).map(o => ({ pid: o.productId }));`)).toEqual([
      {
        $lookup: {
          from: "orders",
          let: { jsmql_f0__id: "$_id" },
          pipeline: [
            { $match: { $expr: { $eq: ["$userId", "$$jsmql_f0__id"] } } },
            { $replaceWith: { pid: "$productId" } },
          ],
          as: "__jsmql.tmp.1",
        },
      },
      { $unwind: "$__jsmql.tmp.1" },
      { $replaceWith: "$__jsmql.tmp.1" },
    ]);
  });

  it("a value-collapsing .map (scalar field / non-object arrow) is rejected — a stream can't hold scalars", () => {
    // A document stream can't be made of scalars; without a value-mode target to peel
    // to (unlike the `$.field = …` assignment form) this must be rejected, not emit the
    // runtime-invalid scalar `$replaceWith` (mongod Location40228).
    expect(() => jsmql(`$$ = $$$.orders.filter(o => o.userId === $._id).map("productId");`)).toThrow(
      /stream must return a DOCUMENT.*collect the values into a field/s,
    );
    expect(() => jsmql(`$$ = $$$.orders.filter(o => o.userId === $._id).map(o => o.productId);`)).toThrow(
      /stream must return a DOCUMENT/,
    );
    // Non-terminal collapsing map (followed by a stream method) is rejected too.
    expect(() => jsmql(`$$ = $$$.orders.filter(o => o.userId === $._id).map("productId").take(5);`)).toThrow(
      /stream must return a DOCUMENT/,
    );
  });

  it("cross-database correlated pivot ($$$$.<db>.<coll>) is rejected", () => {
    // A correlated predicate dispatches to `lowerLookupPivot` — a DIFFERENT
    // `requireSameDbColl` call site than the flat source-switch (the union branch,
    // covered in the "replace stream" describe). Distinct path → own test.
    expect(() => jsmql(`$$ = $$$$.analytics.events.filter(e => e.userId === $._id);`)).toThrow(
      /Cross-database reads aren't supported/,
    );
  });

  it("a value-collapsing terminal (.head/.size/…) is value-position-only — pivot & bare-statement throw, assignment is OK", () => {
    // `.head()` collapses the stream to a single value — like `.map(o => o.x)`, it
    // pivots to value-mode. Valid only where a value is expected.
    // 1. `$$ = …head()` — a value isn't a stream.
    expect(() => jsmql("$$ = $$$.orders.head();")).toThrow(/returns a single value, not a stream/);
    // 2. `$$ = …take(1)` — take returns a stream, so it's fine (contrast).
    expect(jsmql("$$ = $$$.orders.take(1);")).toEqual([
      { $match: { $expr: false } },
      { $unionWith: { coll: "orders", pipeline: [{ $limit: 1 }] } },
    ]);
    // 3. Bare statement — a value isn't a pipeline stage.
    expect(() => jsmql("$$$.orders.head();")).toThrow(/returns a single value, not a pipeline stage/);
    // 4. Assignment — value-mode over ALL orders (implicit match-all $lookup + $first).
    expect(jsmql("$.field = $$$.orders.head();")).toEqual([
      { $lookup: { from: "orders", let: {}, pipeline: [{ $match: { $expr: true } }], as: "__jsmql.tmp.1" } },
      { $set: { field: { $first: "$__jsmql.tmp.1" } } },
      { $unset: "__jsmql" },
    ]);
  });

  it("the value-position rule covers every value terminal (head/last/nth/size/every/some/partition + aggregates)", () => {
    // NB `keyBy`/`countBy`/`groupBy` are NOT here: they collapse to an object but DO
    // have a stream lowering, so they're valid as a `$$ =` pivot too (asserted below).
    for (const term of [
      "head()",
      "last()",
      "nth(1)",
      "size()",
      "every(o => o.paid)",
      "partition(o => o.vip)",
      // Aggregates collapse the stream to one scalar → same value-position rule.
      "sum()",
      'sumBy("total")',
      "max()",
      'minBy("total")',
    ]) {
      expect(() => jsmql(`$$ = $$$.orders.filter(o => o.userId === $._id).${term};`)).toThrow(/returns a single value/);
      // …but the same chain in a value position compiles.
      expect(() => jsmql(`$.f = $$$.orders.filter(o => o.userId === $._id).${term};`)).not.toThrow();
    }
  });

  it("keyBy/countBy/groupBy collapse to a lodash object and are valid as a `$$ =` pivot", () => {
    // These three used to be value-position-only (keyBy) or emit a `$sortByCount` /
    // `$group` stream (countBy/groupBy); now all collapse to the lodash object and
    // work as a stream pivot too. Each ends in `$replaceWith: { $arrayToObject }`.
    for (const term of ['keyBy("sku")', 'countBy("sku")', 'groupBy("sku")']) {
      const stages = jsmql(`$$ = $$.${term};`) as Record<string, unknown>[];
      expect(stages.at(-1)).toHaveProperty("$replaceWith");
    }
  });

  it("value-position .filter(pred).countBy(...) unwraps the collapsed one-doc result with $first", () => {
    // The sub-pipeline collapses to one object doc, but $lookup.as is always an
    // array → the slot holds [obj]. The trailing $set unwraps it to the object
    // ($ifNull → {} on an empty foreign match, lodash-faithful). Verified on mongod.
    const stages = jsmql(`$.byStatus = $$$.orders.filter(o => o.userId === $._id).countBy("status");`) as Record<
      string,
      unknown
    >[];
    expect(stages).toContainEqual({ $set: { "__jsmql.tmp.1": { $ifNull: [{ $first: "$__jsmql.tmp.1" }, {}] } } });
    // keyBy and the bare-key groupBy collapse the same way.
    for (const term of ['keyBy("status")', 'groupBy("status")']) {
      const s = jsmql(`$.g = $$$.orders.filter(o => o.userId === $._id).${term};`) as Record<string, unknown>[];
      expect(s).toContainEqual({ $set: { "__jsmql.tmp.1": { $ifNull: [{ $first: "$__jsmql.tmp.1" }, {}] } } });
    }
  });

  it("rejects an array/string/number method chained on a `.find()` lookup (a single document)", () => {
    // `.find` yields ONE document; an array/string/number method on it is impossible.
    expect(() => jsmql(`$.out = $$$.orders.find(o => o.userId === $._id).take(5);`)).toThrow(
      /returns a single matched document.*needs an array/,
    );
    expect(() => jsmql(`$.out = $$$.orders.find(o => o.userId === $._id).map(o => o.total);`)).toThrow(
      /returns a single matched document.*needs an array/,
    );
    // …but object methods and field reads ARE valid on the matched document.
    expect(() => jsmql(`$.out = $$$.orders.find(o => o.userId === $._id).pick(["total"]);`)).not.toThrow();
    expect(() => jsmql(`$.out = $$$.orders.find(o => o.userId === $._id).total;`)).not.toThrow();
  });

  it("non-correlated predicate keeps using $unionWith (no regression)", () => {
    // No `$.<field>` ref — the predicate is a flat scan, so the existing
    // `$limit:0 + $unionWith` lowering is correct.
    expect(jsmql(`$$ = $$$.users.filter(u => u.active === true);`)).toEqual([
      { $match: { $expr: false } },
      { $unionWith: { coll: "users", pipeline: [{ $match: { active: true } }] } },
    ]);
  });

  it("non-correlated predicate + chain keeps using $unionWith", () => {
    expect(jsmql(`$$ = $$$.users.filter(u => u.active === true).slice(0, 10);`)).toEqual([
      { $match: { $expr: false } },
      { $unionWith: { coll: "users", pipeline: [{ $match: { active: true } }, { $limit: 10 }] } },
    ]);
  });

  it("chain without a .filter head keeps using $unionWith", () => {
    // No `.filter` head means no predicate, so no per-outer-doc correlation
    // to detect. The chain just runs against the foreign collection as a
    // standalone source.
    expect(jsmql(`$$ = $$$.users.slice(0, 5);`)).toEqual([
      { $match: { $expr: false } },
      { $unionWith: { coll: "users", pipeline: [{ $limit: 5 }] } },
    ]);
  });

  it("outer `let` binding referenced in the predicate triggers basic-form pivot", () => {
    // `uid` is a let binding stored at `__jsmql.var.uid` on each outer doc.
    // `u._id === uid` is a single ===, so basic form fires — `localField`
    // uses the materialised `__jsmql.var.uid` path directly. Index-friendly.
    expect(jsmql(`let uid = $.userId; $$ = $$$.users.filter(u => u._id === uid);`)).toEqual([
      { $set: { "__jsmql.var.uid": "$userId" } },
      { $lookup: { from: "users", localField: "__jsmql.var.uid", foreignField: "_id", as: "__jsmql.tmp.1" } },
      { $unwind: "$__jsmql.tmp.1" },
      { $replaceWith: "$__jsmql.tmp.1" },
    ]);
  });

  it("outer `let` binding works in expression-position lookup too", () => {
    expect(jsmql(`let uid = $.userId; $.matched = $$$.users.filter(u => u._id === uid);`)).toEqual([
      { $set: { "__jsmql.var.uid": "$userId" } },
      { $lookup: { from: "users", localField: "__jsmql.var.uid", foreignField: "_id", as: "matched" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("member access on an outer `let` binding (`user._id`) still picks basic form", () => {
    // `user` is a let-binding (the whole user object). `user._id` resolves
    // to the materialised path `__jsmql.var.user._id`. Still a single ===, so
    // basic form fires.
    expect(jsmql(`let user = $.user; $$ = $$$.events.filter(e => e.userId === user._id);`)).toEqual([
      { $set: { "__jsmql.var.user": "$user" } },
      { $lookup: { from: "events", localField: "__jsmql.var.user._id", foreignField: "userId", as: "__jsmql.tmp.1" } },
      { $unwind: "$__jsmql.tmp.1" },
      { $replaceWith: "$__jsmql.tmp.1" },
    ]);
  });

  it("mixed `$.<field>` + outer-let predicate → pipeline-form with both hoisted as $lookup.let vars", () => {
    expect(
      jsmql(`let region = $.region; $$ = $$$.events.filter(e => e.userId === $._id && e.region === region);`),
    ).toEqual([
      { $set: { "__jsmql.var.region": "$region" } },
      {
        $lookup: {
          from: "events",
          let: { jsmql_f0__id: "$_id", jsmql_v0_region: "$__jsmql.var.region" },
          pipeline: [
            {
              $match: {
                $expr: { $and: [{ $eq: ["$userId", "$$jsmql_f0__id"] }, { $eq: ["$region", "$$jsmql_v0_region"] }] },
              },
            },
          ],
          as: "__jsmql.tmp.1",
        },
      },
      { $unwind: "$__jsmql.tmp.1" },
      { $replaceWith: "$__jsmql.tmp.1" },
    ]);
  });

  it("outer let + chain methods → pipeline-form $lookup with chain in the body", () => {
    expect(
      jsmql(
        `let uid = $.userId; $$ = $$$.orders.filter(o => o.userId === uid).toSorted((a, b) => b.placedAt - a.placedAt).slice(0, 5);`,
      ),
    ).toEqual([
      { $set: { "__jsmql.var.uid": "$userId" } },
      {
        $lookup: {
          from: "orders",
          let: { jsmql_v0_uid: "$__jsmql.var.uid" },
          pipeline: [
            { $match: { $expr: { $eq: ["$userId", "$$jsmql_v0_uid"] } } },
            { $sort: { placedAt: -1 } },
            { $limit: 5 },
          ],
          as: "__jsmql.tmp.1",
        },
      },
      { $unwind: "$__jsmql.tmp.1" },
      { $replaceWith: "$__jsmql.tmp.1" },
    ]);
  });
});

describe("$$ = $$$.<coll>.<streamMethod>… — any lodash method may start the chain (source-switch / pivot parity)", () => {
  // Verified end-to-end on a live mongod (chain-order + correlation) in tmp/verify-lookup.ts.
  it("uncorrelated stream head + trailing .filter → $unionWith source-switch (order preserved)", () => {
    expect(jsmql("$$ = $$$.orders.toSorted({ createdAt: -1 }).take(200).filter(o => o.qty > 1);")).toEqual([
      { $match: { $expr: false } },
      {
        $unionWith: {
          coll: "orders",
          pipeline: [{ $sort: { createdAt: -1 } }, { $limit: 200 }, { $match: { qty: { $gt: 1 } } }],
        },
      },
    ]);
  });

  it("stream head + a CORRELATED trailing .filter → $lookup-pivot (sort BEFORE the correlated $match)", () => {
    expect(jsmql("$$ = $$$.orders.toSorted({ createdAt: -1 }).filter(o => o.userId === $._id);")).toEqual([
      {
        $lookup: {
          from: "orders",
          let: { jsmql_f0__id: "$_id" },
          pipeline: [{ $sort: { createdAt: -1 } }, { $match: { $expr: { $eq: ["$userId", "$$jsmql_f0__id"] } } }],
          as: "__jsmql.tmp.1",
        },
      },
      { $unwind: "$__jsmql.tmp.1" },
      { $replaceWith: "$__jsmql.tmp.1" },
    ]);
  });

  it("a non-filter stream head still throws for a value-terminal (single value isn't a stream) in a pivot", () => {
    // Correlating filter routes to the pivot; a trailing value-terminal can't lower
    // into a stream — rejected (not silently dropped).
    expect(() => jsmql("$$ = $$$.orders.toSorted({ createdAt: -1 }).filter(o => o.userId === $._id).size();")).toThrow(
      /returns a single value, not a stream/,
    );
  });

  it("correlation via a non-filter method only (no correlating .filter) stays a footgun-guarded rejection", () => {
    // A `.map` reading the outer doc with no filter to bound the foreign set is a
    // cross-join footgun — kept rejected with the 'correlate with a .filter' guidance.
    expect(() => jsmql("$$ = $$$.orders.map(o => ({ v: $.length }));")).toThrow(/`\$\.length`/);
  });

  it("a CORRELATED matches-object filter routes to the pivot (not a query-literal $unionWith)", () => {
    // `.filter({ userId: $._id })` — the shorthand's `$.` correlation must be detected
    // and correlated via `let`, never emitted as `$match: { userId: "$_id" }` (which in a
    // query document matches the literal string "$_id"). Verified on a live mongod.
    expect(jsmql("$$ = $$$.orders.filter({ userId: $._id });")).toEqual([
      {
        $lookup: {
          from: "orders",
          let: { jsmql_f0__id: "$_id" },
          pipeline: [{ $match: { $expr: { $eq: ["$userId", "$$jsmql_f0__id"] } } }],
          as: "__jsmql.tmp.1",
        },
      },
      { $unwind: "$__jsmql.tmp.1" },
      { $replaceWith: "$__jsmql.tmp.1" },
    ]);
  });

  it("a value-collapsing .map in the uncorrelated source-switch is rejected (not an invalid $replaceWith)", () => {
    expect(() => jsmql("$$ = $$$.orders.map(o => o.total);")).toThrow(/stream must return a DOCUMENT/);
  });
});

describe("pipeline — structural stage placement (pre-flight validation)", () => {
  // Must-be-first (literal forms; the sugar forms are covered in system-stages.test.ts).
  it("rejects a diagnostic source stage that isn't first", () => {
    expect(() => jsmql("[ $match($.x > 1), { $collStats: {} } ]")).toThrow(/'\$collStats' must be the first stage/);
  });
  it("rejects $geoNear that isn't first", () => {
    expect(() => jsmql("[ $sort({ x: 1 }), { $geoNear: { near: [0, 0], distanceField: 'd' } } ]")).toThrow(
      /'\$geoNear' must be the first stage/,
    );
  });
  it("rejects $changeStream that isn't first (;-form)", () => {
    expect(() => jsmql("$match($.x > 1); { $changeStream: {} }")).toThrow(/'\$changeStream' must be the first stage/);
  });
  it("accepts a source stage as the first stage", () => {
    expect(jsmql("[ { $collStats: {} }, $sort({ x: 1 }) ]")).toEqual([{ $collStats: {} }, { $sort: { x: 1 } }]);
    expect(jsmql("[ { $documents: [{ a: 1 }] }, $sort({ a: 1 }) ]")).toEqual([
      { $documents: [{ a: 1 }] },
      { $sort: { a: 1 } },
    ]);
  });

  // Must-be-last (literal forms; the $out sugar form is covered in out.test.ts).
  it("rejects $merge that isn't last (the headline case)", () => {
    expect(() => jsmql("[ { $merge: 'archive' }, $sort({ x: 1 }) ]")).toThrow(/'\$merge' must be the last stage/);
  });
  it("rejects $out (literal) that isn't last", () => {
    expect(() => jsmql("[ { $out: 'c' }, $count('n') ]")).toThrow(/'\$out' must be the last stage/);
  });
  it("rejects $changeStreamSplitLargeEvent that isn't last", () => {
    expect(() => jsmql("[ { $changeStreamSplitLargeEvent: {} }, $sort({ x: 1 }) ]")).toThrow(
      /'\$changeStreamSplitLargeEvent' must be the last stage/,
    );
  });
  it("accepts $merge as the last stage", () => {
    expect(jsmql("[ $sort({ x: 1 }), { $merge: 'archive' } ]")).toEqual([{ $sort: { x: 1 } }, { $merge: "archive" }]);
  });

  // Uniqueness falls out of must-first / must-last.
  it("rejects two terminal stages (the first isn't last)", () => {
    expect(() => jsmql("[ { $out: 'a' }, { $merge: 'b' } ]")).toThrow(/'\$out' must be the last stage/);
  });
  it("rejects two source stages (the second isn't first)", () => {
    expect(() => jsmql("[ { $collStats: {} }, { $indexStats: {} } ]")).toThrow(
      /'\$indexStats' must be the first stage/,
    );
  });

  // Forbidden-in-sub-pipeline (literal sub-pipeline arrays).
  it("rejects $out inside a $facet sub-pipeline", () => {
    expect(() => jsmql("[ { $facet: { a: [ { $out: 'x' } ] } } ]")).toThrow(
      /'\$out' is not allowed inside a '\$facet' sub-pipeline/,
    );
  });
  it("rejects $merge inside a $lookup sub-pipeline", () => {
    expect(() => jsmql("[ { $lookup: { from: 'c', as: 'r', pipeline: [ { $merge: 'x' } ] } } ]")).toThrow(
      /'\$merge' is not allowed inside a '\$lookup' sub-pipeline/,
    );
  });
  it("rejects $merge inside a $unionWith sub-pipeline", () => {
    expect(() => jsmql("[ { $unionWith: { coll: 'c', pipeline: [ { $merge: 'x' } ] } } ]")).toThrow(
      /'\$merge' is not allowed inside a '\$unionWith' sub-pipeline/,
    );
  });
  it("rejects a nested $facet", () => {
    expect(() => jsmql("[ { $facet: { a: [ { $facet: { b: [ $count('n') ] } } ] } } ]")).toThrow(
      /'\$facet' is not allowed inside a '\$facet' sub-pipeline/,
    );
  });
  it("rejects $geoNear inside a $facet sub-pipeline", () => {
    expect(() => jsmql("[ { $facet: { a: [ { $geoNear: { near: [0, 0], distanceField: 'd' } } ] } } ]")).toThrow(
      /'\$geoNear' is not allowed inside a '\$facet' sub-pipeline/,
    );
  });
  it("accepts $geoNear as the FIRST stage of a $lookup sub-pipeline (not over-forbidden)", () => {
    expect(
      jsmql(
        "[ { $lookup: { from: 'c', as: 'r', pipeline: [ { $geoNear: { near: [0, 0], distanceField: 'd' } } ] } } ]",
      ),
    ).toEqual([{ $lookup: { from: "c", as: "r", pipeline: [{ $geoNear: { near: [0, 0], distanceField: "d" } }] } }]);
  });
  it("rejects $geoNear that isn't first WITHIN a $lookup sub-pipeline", () => {
    expect(() =>
      jsmql(
        "[ { $lookup: { from: 'c', as: 'r', pipeline: [ $match($.a > 0), { $geoNear: { near: [0, 0], distanceField: 'd' } } ] } } ]",
      ),
    ).toThrow(/'\$geoNear' must be the first stage/);
  });

  // .validate() carries a meaningful position.
  it("surfaces a structural violation through validate() with a meaningful pos", () => {
    const src = "[ { $facet: { a: [ { $out: 'x' } ] } } ]";
    const result = jsmql.validate(src);
    expect(result.valid).toBe(false);
    expect(result.errors[0].code).toBe("CODEGEN_ERROR");
    expect(result.errors[0].pos).toBeGreaterThanOrEqual(0);
    expect(result.errors[0].pos).toBeLessThanOrEqual(src.length);
  });
});
