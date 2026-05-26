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
