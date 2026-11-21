import { describe, it, expect } from "vitest";
import { jsmql } from "../src/index.ts";

const WAYS =
  "Write a chain that starts from '$$' ('$$ = $$.filter(d => d.x > 1).take(10);'), a list of documents ('$$ = [{ a: 1 }, { a: 2 }];'), or an array whose elements are the documents ('$$ = $.items;').";
const CHAIN = `'$$ = …' replaces the STREAM, so the right side has to be MANY documents. ${WAYS}`;
const MSG = `'$$ = …' replaces the STREAM, so the right side has to be MANY documents — a number is one value. ${WAYS}`;

describe("pipeline detection", () => {
  it("compiles a single-stage pipeline as an array", () => {
    expect(jsmql("[ { $limit: 10 } ]")).toEqual([{ $limit: 10 }]);
  });

  it("non-stage array still compiles as expression-mode array literal", () => {
    expect(jsmql.expr("[1, 2, 3]")).toEqual([1, 2, 3]);
  });

  it("array of mixed scalars and unrelated objects stays expression-mode", () => {
    expect(jsmql.expr("[1, { $limit: 10 }]")).toEqual([1, { $limit: 10 }]);
  });

  it("empty array is not a pipeline", () => {
    expect(jsmql.expr("[]")).toEqual([]);
  });
});

describe("pipeline — stage-object form", () => {
  it("$match with translatable expression body emits an index-friendly query doc", () => {
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
        $project({ dept: 1, total: $.price * $.qty }),
        $group({ _id: $.dept, total: $sum($.total) }),
        $sort({ total: -1 }),
        $limit(10)
      ]`),
    ).toEqual([
      { $project: { dept: 1, total: { $multiply: ["$price", "$qty"] } } },
      { $group: { _id: "$dept", total: { $sum: "$total" } } },
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
    expect(a).toEqual([{ $match: { age: { $gt: 18 } } }]);
    expect(b).toEqual(a);
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
          let: { uid: "$_id", jsmql_f0_userId: "$userId" },
          pipeline: [{ $match: { $expr: { $eq: ["$$jsmql_f0_userId", 42] } } }, { $project: { total: 1 } }],
          as: "userOrders",
        },
      },
    ]);
  });

  it("$lookup pipeline: a field ref passes through as written (HR1 — your own MQL)", () => {
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

  it("a `$.<field>` read in a raw $unionWith pipeline is refused: the stage has no 'let'", () => {
    expect(() => jsmql(`[{ $unionWith: { coll: "archive", pipeline: [{ $match: $.year < 2020 }] } }]`)).toThrow(
      "'$unionWith' has no 'let': its body cannot read the outer document or a binding declared outside it. Filter or reshape the outer stream in a statement before it, or read the other collection through a join ('$.<field> = $$$.<coll>.filter(…)'), whose '$lookup' carries the value.",
    );
  });
});

describe("raw MQL stage bodies pass through UNGUARDED (escape hatch — see src/CLAUDE.md)", () => {
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
  it("passes an unknown stage name through, in both spellings", () => {
    expect(jsmql("[{ $macth: $.age > 18 }]")).toEqual([{ $macth: { $gt: ["$age", 18] } }]);
    expect(jsmql("[$prject({ name: 1 })]")).toEqual([{ $prject: { name: 1 } }]);
  });

  it("once first element is a stage, every element must be a stage", () => {
    expect(() => jsmql("[{ $match: $.a > 1 }, 42]")).toThrow(
      "A pipeline statement writes something: a field ('$.total = …;'), the document ('$ = { … };'), a deletion ('delete $.x;'), or a stage ('$match(…);'). This expression only computes a value — assign it to a field, or wrap a predicate as '$match(…)'.",
    );
  });

  it("multi-key object cannot be a stage element", () => {
    expect(() => jsmql("[{ $match: { age: 1 }, $sort: { age: 1 } }]")).toThrow(
      "A raw stage document holds exactly one stage, and this one holds 2 keys. Write '{ $match: … }' on its own, and the next stage as its own statement.",
    );
  });

  it("jsmql.validate() surfaces pipeline errors as CODEGEN_ERROR", () => {
    const r = jsmql.validate("[{ $match: { age: 1 }, $sort: { age: 1 } }]");
    expect(r.valid).toBe(false);
    expect(r.errors[0].code).toBe("CODEGEN_ERROR");
    expect(r.errors[0].message).toMatch(/holds exactly one stage/);
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
    expect(jsmql("[ $ = { summary: $ } ]")).toEqual([{ $replaceWith: { summary: "$$ROOT" } }]);
  });

  it("operator-call RHS lowers verbatim (object form)", () => {
    expect(jsmql("[ $ = $mergeObjects($.a, $.b) ]")).toEqual([{ $replaceWith: { $mergeObjects: ["$a", "$b"] } }]);
  });

  it("direct lookup `.find` lowers to $lookup + $replaceWith {$first}", () => {
    expect(jsmql("[ $ = $$$.users.find(u => u._id === $.userId) ]")).toEqual([
      {
        $lookup: {
          from: "users",
          localField: "userId",
          foreignField: "_id",
          pipeline: [{ $limit: 1 }],
          as: "__jsmql.tmp.0",
        },
      },
      { $unwind: "$__jsmql.tmp.0" },
      { $replaceWith: "$__jsmql.tmp.0" },
    ]);
  });

  it("cross-database replace-root `$ = $$$$.<db>.<coll>.find(...)` is rejected", () => {
    expect(() => jsmql("[ $ = $$$$.analytics.users.find(u => u._id === $.userId) ]")).toThrow(
      "A read of another DATABASE is not supported. '$lookup' and '$unionWith' reach the current database only (the '{ db, coll }' form is Atlas Data Federation's). Drop the '$$$$.<db>.' prefix — '$$$.<coll>' — and run the pipeline against that database. Cross-database WRITES work: '$$$$.<db>.<coll> = $$'.",
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

  it("single-statement `$ = { … }` (no `;`) lowers to `$replaceWith`, not `$set: { '': … }`", () => {
    expect(jsmql("$ = { a: 1 }")).toEqual([{ $replaceWith: { a: 1 } }]);
    expect(jsmql("$ = { a: 1 };")).toEqual([{ $replaceWith: { a: 1 } }]);
    expect(jsmql("[ $ = { a: 1 } ]")).toEqual([{ $replaceWith: { a: 1 } }]);
  });

  it("single-statement `$ = <expr>` (no `;`) reroutes across every Pipeline entry", () => {
    expect(jsmql("$ = $.profile")).toEqual([{ $replaceWith: "$profile" }]);
    expect(jsmql.pipeline("$ = $.profile")).toEqual([{ $replaceWith: "$profile" }]);
  });

  it("`$ = <expr>` is refused by the expression entry, which returns no stages", () => {
    expect(() => jsmql.expr("$ = $.profile")).toThrow(
      "jsmql.expr() expects an aggregation expression (the value of a stage field, `jsmql.expr`). It received a root-replace `$ = <expr>` (a `$replaceWith` stage) instead. Use jsmql.pipeline().",
    );
    expect(() => jsmql.expr("$ = { a: $.b }")).toThrow(
      "jsmql.expr() expects an aggregation expression (the value of a stage field, `jsmql.expr`). It received a root-replace `$ = <expr>` (a `$replaceWith` stage) instead. Use jsmql.pipeline().",
    );
    expect(() => jsmql.expr("$$ = $$.filter(d => d.x === 1)")).toThrow(/stream-replace/);
    expect(() => jsmql.expr("$ = { a: $$.filter(d => d.x === 1) }")).toThrow(/root-replace/);
    expect(() => jsmql.expr("$.a = 1")).toThrow(
      "jsmql.expr() expects an aggregation expression (the value of a stage field, `jsmql.expr`). It received a write (`$.x = …`, `delete $.x`) instead. Use jsmql.update() for an update document, or jsmql.pipeline() for a `$set` / `$unset` pipeline.",
    );
  });

  it("single-statement `$ = <expr>` still reuses the full replace-root machinery (non-document reject)", () => {
    expect(() => jsmql("$ = 5")).toThrow(
      "'$ = …' takes a document, but got a number. Put the value under a field ('$ = { value: … };'), or write to a field instead ('$.value = …;').",
    );
    expect(() => jsmql("$ = [1, 2]")).toThrow(/takes a document, but got an array\./);
    expect(() => jsmql("$ = [1, 2]")).toThrow(
      "'$ = …' takes a document, but got an array. Name the destination that takes an array: '$$ = <array>;' makes the stream from its elements, one document per element. To keep the array as a field of this document, write '$.<field> = <array>;'.",
    );
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
    expect(jsmql("[ $$ = [{ a: 1 }, { b: 2 }] ]")).toEqual([
      { $match: { $expr: false } },
      { $unionWith: { pipeline: [{ $documents: [{ a: 1 }, { b: 2 }] }] } },
    ]);
  });

  it("fans out a spread field (`$$ = [...$.items]`)", () => {
    expect(jsmql("[ $$ = [...$.items] ]")).toEqual([
      { $set: { "__jsmql.tmp.0": { $ifNull: ["$items", []] } } },
      { $unwind: "$__jsmql.tmp.0" },
      { $replaceWith: "$__jsmql.tmp.0" },
    ]);
  });

  it("fans out a provably-array expression (`.map`)", () => {
    expect(jsmql("[ $$ = $.items.map(x => ({ sku: x.sku })) ]")).toEqual([
      { $set: { "__jsmql.tmp.0": { $map: { input: { $ifNull: ["$items", []] }, as: "x", in: { sku: "$$x.sku" } } } } },
      { $unwind: "$__jsmql.tmp.0" },
      { $replaceWith: "$__jsmql.tmp.0" },
    ]);
  });

  it("refuses a fan-out whose elements the registry proves are not documents", () => {
    expect(() => jsmql("[ $$ = $.scores.entries() ]")).toThrow(
      /makes documents from the array's ELEMENTS, one each, and these elements are arrays/,
    );
    expect(jsmql("[ $$ = $.scores.entries().map((v) => ({ value: v })) ]")).toEqual([
      {
        $set: {
          "__jsmql.tmp.0": {
            $map: {
              input: {
                $map: { input: { $objectToArray: { $ifNull: ["$scores", {}] } }, in: ["$$this.k", "$$this.v"] },
              },
              as: "v",
              in: { value: "$$v" },
            },
          },
        },
      },
      { $unwind: "$__jsmql.tmp.0" },
      { $replaceWith: "$__jsmql.tmp.0" },
    ]);
    expect(jsmql("[ $$ = $objectToArray($.scores) ]")).toEqual([
      { $set: { "__jsmql.tmp.0": { $objectToArray: "$scores" } } },
      { $unwind: "$__jsmql.tmp.0" },
      { $replaceWith: "$__jsmql.tmp.0" },
    ]);
  });

  it("a possibly-empty filter fan-out drops docs whose array is empty (per-document drop)", () => {
    expect(jsmql("[ $$ = $.items.filter(x => x.qty > 0) ]")).toEqual([
      {
        $set: {
          "__jsmql.tmp.0": { $filter: { input: { $ifNull: ["$items", []] }, as: "x", cond: { $gt: ["$$x.qty", 0] } } },
        },
      },
      { $unwind: "$__jsmql.tmp.0" },
      { $replaceWith: "$__jsmql.tmp.0" },
    ]);
  });

  it("a bare field-ref RHS stays a single-doc `$replaceWith` (not provably an array)", () => {
    expect(jsmql("[ $ = $.items ]")).toEqual([{ $replaceWith: "$items" }]);
  });

  it("rejects an array RHS, naming the destination that takes one", () => {
    expect(() => jsmql("[ $ = [] ]")).toThrow(
      "'$ = …' takes a document, but got an array. Name the destination that takes an array: '$$ = <array>;' makes the stream from its elements, one document per element. To keep the array as a field of this document, write '$.<field> = <array>;'.",
    );
  });

  it("rejects an array of scalar literals with the same message — the destination decides first", () => {
    expect(() => jsmql("[ $ = [1, 2] ]")).toThrow(
      "'$ = …' takes a document, but got an array. Name the destination that takes an array: '$$ = <array>;' makes the stream from its elements, one document per element. To keep the array as a field of this document, write '$.<field> = <array>;'.",
    );
  });

  it("rejects scalar number RHS with an actionable error", () => {
    expect(() => jsmql("[ $ = 5 ]")).toThrow(
      "'$ = …' takes a document, but got a number. Put the value under a field ('$ = { value: … };'), or write to a field instead ('$.value = …;').",
    );
  });

  it("rejects string RHS with an actionable error", () => {
    expect(() => jsmql('[ $ = "foo" ]')).toThrow(
      "'$ = …' takes a document, but got a string. Put the value under a field ('$ = { value: … };'), or write to a field instead ('$.value = …;').",
    );
  });

  it("rejects `.filter()` lookup RHS, and suggests `.find()`", () => {
    expect(() => jsmql("[ $ = $$$.users.filter(u => u.active) ]")).toThrow(
      "The document can only become ONE document, and this chain gives an array. Write '$ = $$$.<coll>.find(pred)' for the first match, or keep the array in a field: '$.<field> = $$$.<coll>.…'.",
    );
  });

  it("rejects `delete $` with a hint that points at `$ = …`", () => {
    expect(() => jsmql("delete $;")).toThrow(
      "'delete $' would delete the document itself. To replace it, write '$ = { … };'; to drop every field but one, write '$ = { keep: $.keep };'.",
    );
  });

  it("rejects `delete $$` with the two forms that empty or narrow the stream", () => {
    expect(() => jsmql("delete $$;")).toThrow(
      "'delete $$' would delete the root stream itself. To keep no documents, write '$$ = [];'; to keep some, write '$$.filter(d => …);'.",
    );
    expect(jsmql("$$ = [];")).toEqual([{ $match: { $expr: false } }]);
    expect(jsmql("$$.filter(d => d.a > 1);")).toEqual([{ $match: { a: { $gt: 1 } } }]);
  });

  it("rejects compound increment on bare `$`", () => {
    expect(() => jsmql("$++;")).toThrow(
      "Cannot use '++' on '$' at position 1. '$' is the whole document, not a field. Write to a field: '$.<field>++'.",
    );
  });

  it("rejects compound assignment on bare `$`", () => {
    expect(() => jsmql("$ += 5;")).toThrow(
      "Cannot use '+=' on '$' at position 2. '$' is the whole document, not a field. Write to a field: '$.<field> += …'.",
    );
  });

  it("validate() surfaces the rejection with a real .pos (not 0)", () => {
    const r = jsmql.validate("[ $ = [1, 2] ]");
    expect(r.valid).toBe(false);
    expect(r.errors[0].code).toBe("CODEGEN_ERROR");
    expect(r.errors[0].pos).toBeGreaterThan(0);
    expect(r.errors[0].message).toMatch(
      "'$ = …' takes a document, but got an array. Name the destination that takes an array: '$$ = <array>;' makes the stream from its elements, one document per element. To keep the array as a field of this document, write '$.<field> = <array>;'.",
    );
  });

  it("clears `let` scope after `$ = …` (a later reference gives a precise error)", () => {
    expect(() => jsmql("let x = $.a; $ = $.profile; $.b = x;")).toThrow(/cannot be read after `\$replaceWith`/);
  });
});

describe("pipeline — facet (`$ = { k: $$.filter(...) }`)", () => {
  it("expression-body predicate becomes a `$match` sub-pipeline", () => {
    expect(jsmql(`$ = { recent: $$.filter(o => o.createdAt >= "2026-01-01") };`)).toEqual([
      { $facet: { recent: [{ $match: { createdAt: { $gte: "2026-01-01" } } }] } },
    ]);
  });

  it("a chained-stage branch becomes the branch's stages", () => {
    expect(jsmql(`$ = { topByScore: $$.$sort({ score: -1 }).$limit(10) };`)).toEqual([
      { $facet: { topByScore: [{ $sort: { score: -1 } }, { $limit: 10 }] } },
    ]);
  });

  it("a `.filter` branch takes a JavaScript predicate — a stage in its block is rejected", () => {
    expect(() => jsmql(`$ = { topByScore: $$.filter(o => { $sort({ score: -1 }); $limit(10); }) };`)).toThrow(
      "`$sort(...)` at position 35 is a pipeline stage, not part of a callback. A callback's block holds declarations and a 'return'. Move the stages to '.aggregate((o) => { $sort(...); … })'. It is the one method whose block is a list of stages. Over the stream a stage is also a chain link: '$$.$sort(…)'.",
    );
  });

  it("multi-facet pipeline with mixed predicate shapes", () => {
    expect(
      jsmql(`$ = {
        topByScore: $$.$sort({ score: -1 }).$limit(10),
        recent:     $$.filter(o => o.createdAt >= "2026-01-01"),
        byStatus:   $$.$group({ _id: $.status, n: $sum(1) })
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
      {
        $facet: {
          active: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $gt: ["$active", null] },
                    { $ne: ["$active", false] },
                    { $ne: ["$active", ""] },
                    { $ne: ["$active", 0] },
                  ],
                },
              },
            },
          ],
        },
      },
    ]);
  });

  it("a chained `$group` branch reads the branch document with `$.<field>`", () => {
    expect(jsmql(`$ = { byCat: $$.$group({ _id: $.category }) };`)).toEqual([
      { $facet: { byCat: [{ $group: { _id: "$category" } }] } },
    ]);
  });

  it("vacuous predicate (literal `true`) emits a trivial `$match`", () => {
    expect(jsmql(`$ = { all: $$.filter(o => true) };`)).toEqual([{ $facet: { all: [{ $match: { $expr: true } }] } }]);
  });

  it("reads `$.<field>` inside a facet predicate as the branch document", () => {
    expect(jsmql(`$ = { recent: $$.filter(o => $.x > 5) };`)).toEqual([
      { $facet: { recent: [{ $match: { x: { $gt: 5 } } }] } },
    ]);
  });

  it("rejects zero-argument lambda — the doc must be named", () => {
    expect(jsmql(`$ = { a: $$.filter(() => true) };`)).toEqual([{ $facet: { a: [{ $match: { $expr: true } }] } }]);
  });

  it("rejects two-argument lambda", () => {
    expect(jsmql(`$ = { a: $$.filter((a, b) => a.x > 5) };`)).toEqual([
      { $facet: { a: [{ $match: { x: { $gt: 5 } } }] } },
    ]);
  });

  it("rejects mixed-shape RHS where some values are not `$$.filter(...)`", () => {
    expect(() => jsmql(`$ = { a: $$.filter(o => o.x > 0), b: 1 };`)).toThrow(
      "'$ = { … }' with a '$$' chain is a '$facet', and every entry must be one: 'b' is not a chain on '$$'. Make it one ('b: $$.filter(…)'), or move it out of the object.",
    );
  });

  it("rejects spread entries inside the facet object", () => {
    expect(() => jsmql(`$ = { a: $$.filter(o => true), ...rest };`)).toThrow(
      "A '$facet' is written branch by branch; '...' cannot spread branches in. Name each one: '$ = { k: $$.filter(…) }'.",
    );
  });

  it("rejects duplicate facet keys", () => {
    expect(() => jsmql(`$ = { a: $$.filter(o => o.x > 0), a: $$.filter(o => o.y > 0) };`)).toThrow(
      "'a' names two '$facet' branches, and JavaScript would keep only the last. Give each branch its own name.",
    );
  });

  it("statement-position `$$.filter(...)` (not in facet) lowers to `$match` — bare-statement stream sugar", () => {
    expect(jsmql(`$$.filter(o => o.x > 0);`)).toEqual([{ $match: { x: { $gt: 0 } } }]);
  });

  it("$facet is reshape-clearing: prior lets cannot be read after", () => {
    expect(() => jsmql(`let n = $.threshold; $ = { hot: $$.filter(o => o.score > 0) }; $.copy = n;`)).toThrow(
      /cannot be read after `\$facet`/,
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
    const out = jsmql(`$$ = $$$.transactions.filter(t => t.createdAt >= Date("2026-01-01"));`) as object[];
    expect(out).toEqual([
      { $match: { $expr: false } },
      {
        $unionWith: {
          coll: "transactions",
          pipeline: [{ $match: { createdAt: { $gte: new Date("2026-01-01T00:00:00.000Z") } } }],
        },
      },
    ]);
  });

  it("bracketed `[...]` form works for both shapes", () => {
    expect(jsmql(`[ $$ = $$.filter(t => t.x > 0) ]`)).toEqual([{ $match: { x: { $gt: 0 } } }]);
    expect(jsmql(`[ $$ = $$$.users.filter(u => u.active) ]`)).toEqual([
      { $match: { $expr: false } },
      {
        $unionWith: {
          coll: "users",
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $gt: ["$active", null] },
                    { $ne: ["$active", false] },
                    { $ne: ["$active", ""] },
                    { $ne: ["$active", 0] },
                  ],
                },
              },
            },
          ],
        },
      },
    ]);
  });

  it("block-body predicate in source-switch becomes the block's stages", () => {
    expect(
      jsmql(`$$ = $$$.transactions.aggregate(t => { $match(t.amount > 100); $sort({ amount: -1 }); $limit(5); });`),
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
      "A read of another DATABASE is not supported. '$lookup' and '$unionWith' reach the current database only (the '{ db, coll }' form is Atlas Data Federation's). Drop the '$$$$.<db>.' prefix — '$$$.<coll>' — and run the pipeline against that database. Cross-database WRITES work: '$$$$.<db>.<coll> = $$'.",
    );
  });

  it("`$$ = $$.filter(...)` preserves the outer let scope", () => {
    expect(jsmql(`let cutoff = $.min; $$ = $$.filter(t => t.score > cutoff); $.flagged = true;`)).toEqual([
      { $set: { "__jsmql.var.cutoff": "$min" } },
      { $match: { $expr: { $gt: ["$score", "$__jsmql.var.cutoff"] } } },
      { $set: { flagged: true } },
      { $unset: "__jsmql" },
    ]);
  });

  it("source switch (`$$ = $$$.<coll>.filter(...)`) clears the let scope", () => {
    expect(() => jsmql(`let cutoff = $.min; $$ = $$$.t.filter(o => true); $.flagged = cutoff;`)).toThrow(
      /cannot be read after `\$unionWith`/,
    );
  });

  it("an outer `let` read inside a source-switch `.map` body joins through `$lookup.let`", () => {
    expect(jsmql(`const k = $.min + 1; $$ = $$$.orders.map(o => ({ v: k }));`)).toEqual([
      { $set: { "__jsmql.var.k": { $add: ["$min", 1] } } },
      {
        $lookup: {
          from: "orders",
          let: { jsmql_v0_k: "$__jsmql.var.k" },
          pipeline: [{ $replaceWith: { v: "$$jsmql_v0_k" } }],
          as: "__jsmql.tmp.0",
        },
      },
      { $unwind: "$__jsmql.tmp.0" },
      { $replaceWith: "$__jsmql.tmp.0" },
    ]);
  });

  it("a root `$.<field>` read inside a source-switch `.map` body joins through `$lookup.let`", () => {
    expect(jsmql(`$$ = $$$.orders.map(o => ({ v: $.length }));`)).toEqual([
      {
        $lookup: {
          from: "orders",
          let: { jsmql_f0_length: "$length" },
          pipeline: [{ $replaceWith: { v: "$$jsmql_f0_length" } }],
          as: "__jsmql.tmp.0",
        },
      },
      { $unwind: "$__jsmql.tmp.0" },
      { $replaceWith: "$__jsmql.tmp.0" },
    ]);
  });

  it("a top-level `$$.map` reads `$.<field>` as the stream document (not a source-switch)", () => {
    expect(jsmql(`$$ = $$.map(o => ({ v: $.x }));`)).toEqual([{ $replaceWith: { v: "$x" } }]);
  });

  it("`$$ = []` lowers to `$match: { $expr: false }` (drop all docs)", () => {
    expect(jsmql(`$$ = [];`)).toEqual([{ $match: { $expr: false } }]);
  });

  it("`$$ = [{...}, {...}]` at stage 0 lowers to `$documents`", () => {
    expect(jsmql(`$$ = [{ _id: 1 }, { _id: 2 }];`)).toEqual([
      { $match: { $expr: false } },
      { $unionWith: { pipeline: [{ $documents: [{ _id: 1 }, { _id: 2 }] }] } },
    ]);
  });

  it("`$$ = [docs]` mid-pipeline drops what came before and starts again", () => {
    expect(jsmql(`$match($.active === true); $$ = [{ _id: 1 }];`)).toEqual([
      { $match: { active: true } },
      { $match: { $expr: false } },
      { $unionWith: { pipeline: [{ $documents: [{ _id: 1 }] }] } },
    ]);
  });

  it("rejects `$$ = <ternary>` (a conditional branch of the stream is not a supported form)", () => {
    expect(() => jsmql(`$$ = true ? $$.filter(o => o.x) : $$.filter(o => o.y);`)).toThrow(CHAIN);
  });

  it("rejects `$$ = $$$.<coll>.find(...)` and points at the `.slice(0, 1)` / `$ = $$$.<coll>.find` alternatives", () => {
    expect(() => jsmql(`$$ = $$$.users.find(u => u.active);`)).toThrow(
      "'.find(…)' gives ONE document, and the stream is many. Write '$$ = $$$.<coll>.filter(pred).take(1)' for a stream of the first match, or '$ = $$$.<coll>.find(pred)' to make each document the one it finds.",
    );
  });

  it("`$$ = $$.map(d => <expr>)` lowers to `$replaceWith` through the stream-method registry", () => {
    expect(jsmql(`$$ = $$.map(t => ({ x: t.x }));`)).toEqual([{ $replaceWith: { x: "$x" } }]);
  });

  it("`$.<field>` inside a `$$.filter` predicate reads the stream document (HR4), as the parameter does", () => {
    expect(jsmql(`$$ = $$.filter(t => $.x > 5);`)).toEqual([{ $match: { x: { $gt: 5 } } }]);
  });

  it("rejects bare `$$$.<coll>` on the RHS (no stream method)", () => {
    expect(jsmql(`$$ = $$$.transactions;`)).toEqual([{ $match: { $expr: false } }, { $unionWith: "transactions" }]);
  });

  it("validate() reports `$$ = []` as valid (now lowers cleanly to $match: { $expr: false })", () => {
    const r = jsmql.validate(`$$ = [];`);
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });
});

describe("replace stream (`$$ = <expr>`) — single statement without a trailing `;`", () => {
  it("`$$ = $$.filter(p)` lowers to `$match`, same as the `;` form", () => {
    expect(jsmql(`$$ = $$.filter({ a: 1 })`)).toEqual([{ $match: { a: 1 } }]);
    expect(jsmql(`$$ = $$.filter({ a: 1 });`)).toEqual([{ $match: { a: 1 } }]);
  });

  it("every stream-method head reaches its stage — not just `.filter`", () => {
    expect(jsmql(`$$ = $$.map(t => ({ x: t.x }))`)).toEqual([{ $replaceWith: { x: "$x" } }]);
    expect(jsmql(`$$ = $$.take(3)`)).toEqual([{ $limit: 3 }]);
    expect(jsmql(`$$ = []`)).toEqual([{ $match: { $expr: false } }]);
  });

  it("`$$ = $$$.<coll>.filter(<correlatedPred>)` lowers to the `$lookup` pivot", () => {
    expect(jsmql(`$$ = $$$.orders.filter(o => o.userId === $._id)`)).toEqual([
      { $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "__jsmql.tmp.0" } },
      { $unwind: "$__jsmql.tmp.0" },
      { $replaceWith: "$__jsmql.tmp.0" },
    ]);
  });

  it("a comma-grouped chain around the assignment keeps update-op flush order", () => {
    expect(jsmql(`$.a = 1, $$ = $$.filter({ b: 2 })`)).toEqual([{ $set: { a: 1 } }, { $match: { b: 2 } }]);
    expect(jsmql(`$$ = $$.filter({ b: 2 }), $.a = 1`)).toEqual([{ $match: { b: 2 } }, { $set: { a: 1 } }]);
  });

  it("an unsupported RHS reaches its actionable rejection with a real `.pos`", () => {
    const noSemi = jsmql.validate(`$$ = 5`);
    expect(noSemi.valid).toBe(false);
    expect(noSemi.errors[0].message).toMatch(MSG);
    expect(noSemi.errors[0].pos).toBe(5);
    expect(noSemi.errors).toEqual([
      {
        message:
          "'$$ = …' replaces the STREAM, so the right side has to be MANY documents — a number is one value. Write a chain that starts from '$$' ('$$ = $$.filter(d => d.x > 1).take(10);'), a list of documents ('$$ = [{ a: 1 }, { a: 2 }];'), or an array whose elements are the documents ('$$ = $.items;').",
        pos: 5,
        code: "CODEGEN_ERROR",
      },
    ]);
  });

  it("never reaches the internal-error path", () => {
    const sources = [`$$ = $$.filter({ a: 1 })`, `$$ = $$.map(x => x.a)`, `$$ = []`, `$$ = 5`, `$$ = $$$.t`];
    const errors = sources.flatMap((src) => jsmql.validate(src).errors);
    expect(errors).toHaveLength(1);
    for (const e of errors) expect(e.message).not.toMatch(/internal error/);
  });
});

describe("$$ = $$$.<coll>.filter(<correlatedPred>).<chain> — $lookup-pivot dispatch", () => {
  it("predicate that reads $.<field> + single === → basic-form $lookup + $unwind + $replaceWith", () => {
    expect(jsmql(`$$ = $$$.users.filter(u => u._id === $.userId);`)).toEqual([
      { $lookup: { from: "users", localField: "userId", foreignField: "_id", as: "__jsmql.tmp.0" } },
      { $unwind: "$__jsmql.tmp.0" },
      { $replaceWith: "$__jsmql.tmp.0" },
    ]);
  });

  it("predicate with chain methods → pipeline-form $lookup with chain that extends the body", () => {
    expect(jsmql(`$$ = $$$.users.filter(u => u._id === $.userId).slice(0, 1);`)).toEqual([
      {
        $lookup: {
          from: "users",
          localField: "userId",
          foreignField: "_id",
          pipeline: [{ $limit: 1 }],
          as: "__jsmql.tmp.0",
        },
      },
      { $unwind: "$__jsmql.tmp.0" },
      { $replaceWith: "$__jsmql.tmp.0" },
    ]);
  });

  it(".toSorted + .slice top-N pivot — chain extends the pipeline body, then $unwind/$replaceWith", () => {
    expect(
      jsmql(`$$ = $$$.orders.filter(o => o.userId === $._id).toSorted((a, b) => b.placedAt - a.placedAt).slice(0, 5);`),
    ).toEqual([
      {
        $lookup: {
          from: "orders",
          localField: "_id",
          foreignField: "userId",
          pipeline: [{ $sort: { placedAt: -1 } }, { $limit: 5 }],
          as: "__jsmql.tmp.0",
        },
      },
      { $unwind: "$__jsmql.tmp.0" },
      { $replaceWith: "$__jsmql.tmp.0" },
    ]);
  });

  it("two correlated equalities → the first is the pair, the second a let var matched beside it", () => {
    expect(jsmql(`$$ = $$$.events.filter(e => e.userId === $._id && e.region === $.region);`)).toEqual([
      {
        $lookup: {
          from: "events",
          localField: "_id",
          foreignField: "userId",
          let: { jsmql_f0_region: "$region" },
          pipeline: [{ $match: { $expr: { $eq: ["$region", "$$jsmql_f0_region"] } } }],
          as: "__jsmql.tmp.0",
        },
      },
      { $unwind: "$__jsmql.tmp.0" },
      { $replaceWith: "$__jsmql.tmp.0" },
    ]);
  });

  it("an object-returning .map reshapes each source doc into the new stream root", () => {
    expect(jsmql(`$$ = $$$.orders.filter(o => o.userId === $._id).map(o => ({ pid: o.productId }));`)).toEqual([
      {
        $lookup: {
          from: "orders",
          localField: "_id",
          foreignField: "userId",
          pipeline: [{ $replaceWith: { pid: "$productId" } }],
          as: "__jsmql.tmp.0",
        },
      },
      { $unwind: "$__jsmql.tmp.0" },
      { $replaceWith: "$__jsmql.tmp.0" },
    ]);
  });

  it("a value-collapsing .map (scalar field / non-object arrow) is rejected — a stream cannot hold scalars", () => {
    expect(() => jsmql(`$$ = $$$.orders.filter(o => o.userId === $._id).map("productId");`)).toThrow(
      "'.map()' makes a value, and the stream must stay documents. Assign the value to a field instead: '$.<field> = $$$.<coll>.….map()'.",
    );
    expect(() => jsmql(`$$ = $$$.orders.filter(o => o.userId === $._id).map(o => o.productId);`)).toThrow(
      "'.map()' makes a value, and the stream must stay documents. Assign the value to a field instead: '$.<field> = $$$.<coll>.….map()'.",
    );
    expect(() => jsmql(`$$ = $$$.orders.filter(o => o.userId === $._id).map("productId").take(5);`)).toThrow(
      "'.map()' makes a value, and the stream must stay documents. Assign the value to a field instead: '$.<field> = $$$.<coll>.….map()'.",
    );
  });

  it("cross-database correlated pivot ($$$$.<db>.<coll>) is rejected", () => {
    expect(() => jsmql(`$$ = $$$$.analytics.events.filter(e => e.userId === $._id);`)).toThrow(
      "A read of another DATABASE is not supported. '$lookup' and '$unionWith' reach the current database only (the '{ db, coll }' form is Atlas Data Federation's). Drop the '$$$$.<db>.' prefix — '$$$.<coll>' — and run the pipeline against that database. Cross-database WRITES work: '$$$$.<db>.<coll> = $$'.",
    );
  });

  it("a value-collapsing terminal (.head/.size/…) is value-position-only — pivot & bare-statement throw, assignment is OK", () => {
    expect(() => jsmql("$$ = $$$.orders.head();")).toThrow(
      "'.head()' makes a value, and the stream must stay documents. Assign the value to a field instead: '$.<field> = $$$.<coll>.….head()'.",
    );
    expect(jsmql("$$ = $$$.orders.take(1);")).toEqual([
      { $match: { $expr: false } },
      { $unionWith: { coll: "orders", pipeline: [{ $limit: 1 }] } },
    ]);
    expect(() => jsmql("$$$.orders.head();")).toThrow(
      "Reading another collection produces a value, and this statement gives it no destination. Assign it to a field ('$.<field> = $$$.<coll>.…'), bind it ('let x = $$$.<coll>.…'), or make it the stream ('$$ = $$$.<coll>.…').",
    );
    expect(jsmql("$.field = $$$.orders.head();")).toEqual([
      { $lookup: { from: "orders", pipeline: [], as: "__jsmql.tmp.0" } },
      { $set: { field: { $first: "$__jsmql.tmp.0" } } },
      { $unset: "__jsmql" },
    ]);
  });

  it("the value-position rule covers every value terminal (head/last/nth/size/every/some/partition + aggregates)", () => {
    const TERMINALS: [string, string, unknown][] = [
      [
        "head()",
        "'.head()' makes a value, and the stream must stay documents. Assign the value to a field instead: '$.<field> = $$$.<coll>.….head()'.",
        [
          { $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "__jsmql.tmp.0" } },
          { $set: { f: { $first: "$__jsmql.tmp.0" } } },
          { $unset: "__jsmql" },
        ],
      ],
      [
        "last()",
        "'.last()' makes a value, and the stream must stay documents. Assign the value to a field instead: '$.<field> = $$$.<coll>.….last()'.",
        [
          { $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "__jsmql.tmp.0" } },
          { $set: { f: { $last: "$__jsmql.tmp.0" } } },
          { $unset: "__jsmql" },
        ],
      ],
      [
        "nth(1)",
        "'.nth()' makes a value, and the stream must stay documents. Assign the value to a field instead: '$.<field> = $$$.<coll>.….nth()'.",
        [
          { $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "__jsmql.tmp.0" } },
          { $set: { f: { $arrayElemAt: ["$__jsmql.tmp.0", 1] } } },
          { $unset: "__jsmql" },
        ],
      ],
      [
        "size()",
        "'.size()' makes a value, and the stream must stay documents. Assign the value to a field instead: '$.<field> = $$$.<coll>.….size()'.",
        [
          { $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "__jsmql.tmp.0" } },
          { $set: { f: { $size: "$__jsmql.tmp.0" } } },
          { $unset: "__jsmql" },
        ],
      ],
      [
        "every(o => o.paid)",
        "'.every()' makes a value, and the stream must stay documents. Assign the value to a field instead: '$.<field> = $$$.<coll>.….every()'.",
        [
          { $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "__jsmql.tmp.0" } },
          {
            $set: {
              f: {
                $allElementsTrue: {
                  $map: {
                    input: "$__jsmql.tmp.0",
                    as: "o",
                    in: {
                      $and: [
                        { $gt: ["$$o.paid", null] },
                        { $ne: ["$$o.paid", false] },
                        { $ne: ["$$o.paid", ""] },
                        { $ne: ["$$o.paid", 0] },
                      ],
                    },
                  },
                },
              },
            },
          },
          { $unset: "__jsmql" },
        ],
      ],
      [
        "partition(o => o.vip)",
        "'.partition()' makes a value, and the stream must stay documents. Assign the value to a field instead: '$.<field> = $$$.<coll>.….partition()'.",
        [
          { $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "__jsmql.tmp.0" } },
          {
            $set: {
              f: [
                {
                  $filter: {
                    input: "$__jsmql.tmp.0",
                    as: "o",
                    cond: {
                      $and: [
                        { $gt: ["$$o.vip", null] },
                        { $ne: ["$$o.vip", false] },
                        { $ne: ["$$o.vip", ""] },
                        { $ne: ["$$o.vip", 0] },
                      ],
                    },
                  },
                },
                {
                  $filter: {
                    input: "$__jsmql.tmp.0",
                    as: "o",
                    cond: {
                      $not: [
                        {
                          $and: [
                            { $gt: ["$$o.vip", null] },
                            { $ne: ["$$o.vip", false] },
                            { $ne: ["$$o.vip", ""] },
                            { $ne: ["$$o.vip", 0] },
                          ],
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
          { $unset: "__jsmql" },
        ],
      ],
      [
        'sumBy("total")',
        "'.sumBy()' makes a value, and the stream must stay documents. Assign the value to a field instead: '$.<field> = $$$.<coll>.….sumBy()'.",
        [
          { $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "__jsmql.tmp.0" } },
          { $set: { f: { $sum: { $map: { input: "$__jsmql.tmp.0", as: "x", in: "$$x.total" } } } } },
          { $unset: "__jsmql" },
        ],
      ],
      [
        'minBy("total")',
        "'.minBy()' makes a value, and the stream must stay documents. Assign the value to a field instead: '$.<field> = $$$.<coll>.….minBy()'.",
        [
          { $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "__jsmql.tmp.0" } },
          {
            $set: {
              f: {
                $let: {
                  vars: {
                    jsmqlSorted: {
                      $sortArray: {
                        input: { $map: { input: "$__jsmql.tmp.0", as: "x", in: { k: "$$x.total", v: "$$x" } } },
                        sortBy: { k: 1 },
                      },
                    },
                  },
                  in: { $getField: { field: "v", input: { $arrayElemAt: ["$$jsmqlSorted", 0] } } },
                },
              },
            },
          },
          { $unset: "__jsmql" },
        ],
      ],
    ];
    for (const [term, refusal, valueMql] of TERMINALS) {
      expect(() => jsmql(`$$ = $$$.orders.filter(o => o.userId === $._id).${term};`), term).toThrow(refusal);
      expect(jsmql(`$.f = $$$.orders.filter(o => o.userId === $._id).${term};`), term).toEqual(valueMql);
    }
  });

  it("keyBy/countBy/groupBy collapse to a lodash object and are valid as a `$$ =` pivot", () => {
    expect(jsmql('$$ = $$.keyBy("sku");')).toEqual([
      { $group: { _id: "$sku", __jsmqlTmp: { $last: "$$ROOT" } } },
      {
        $group: {
          _id: null,
          __jsmqlTmp: { $push: { k: { $ifNull: [{ $toString: "$_id" }, "null"] }, v: "$__jsmqlTmp" } },
        },
      },
      { $replaceWith: { $arrayToObject: "$__jsmqlTmp" } },
    ]);
    expect(jsmql('$$ = $$.countBy("sku");')).toEqual([
      { $group: { _id: "$sku", __jsmqlTmp: { $sum: 1 } } },
      {
        $group: {
          _id: null,
          __jsmqlTmp: { $push: { k: { $ifNull: [{ $toString: "$_id" }, "null"] }, v: "$__jsmqlTmp" } },
        },
      },
      { $replaceWith: { $arrayToObject: "$__jsmqlTmp" } },
    ]);
    expect(jsmql('$$ = $$.groupBy("sku");')).toEqual([
      { $group: { _id: "$sku", __jsmqlTmp: { $push: "$$ROOT" } } },
      {
        $group: {
          _id: null,
          __jsmqlTmp: { $push: { k: { $ifNull: [{ $toString: "$_id" }, "null"] }, v: "$__jsmqlTmp" } },
        },
      },
      { $replaceWith: { $arrayToObject: "$__jsmqlTmp" } },
    ]);
  });

  it("value-position .filter(pred).countBy(...) unwraps the collapsed one-doc result with $first", () => {
    expect(jsmql(`$.byStatus = $$$.orders.filter(o => o.userId === $._id).countBy("status");`)).toEqual([
      {
        $lookup: {
          from: "orders",
          localField: "_id",
          foreignField: "userId",
          pipeline: [
            { $group: { _id: "$status", __jsmqlTmp: { $sum: 1 } } },
            {
              $group: {
                _id: null,
                __jsmqlTmp: { $push: { k: { $ifNull: [{ $toString: "$_id" }, "null"] }, v: "$__jsmqlTmp" } },
              },
            },
            { $replaceWith: { $arrayToObject: "$__jsmqlTmp" } },
          ],
          as: "byStatus",
        },
      },
      { $set: { byStatus: { $ifNull: [{ $first: "$byStatus" }, {}] } } },
    ]);
    expect(jsmql(`$.g = $$$.orders.filter(o => o.userId === $._id).keyBy("status");`)).toEqual([
      {
        $lookup: {
          from: "orders",
          localField: "_id",
          foreignField: "userId",
          pipeline: [
            { $group: { _id: "$status", __jsmqlTmp: { $last: "$$ROOT" } } },
            {
              $group: {
                _id: null,
                __jsmqlTmp: { $push: { k: { $ifNull: [{ $toString: "$_id" }, "null"] }, v: "$__jsmqlTmp" } },
              },
            },
            { $replaceWith: { $arrayToObject: "$__jsmqlTmp" } },
          ],
          as: "g",
        },
      },
      { $set: { g: { $ifNull: [{ $first: "$g" }, {}] } } },
    ]);
    expect(jsmql(`$.g = $$$.orders.filter(o => o.userId === $._id).groupBy("status");`)).toEqual([
      {
        $lookup: {
          from: "orders",
          localField: "_id",
          foreignField: "userId",
          pipeline: [
            { $group: { _id: "$status", __jsmqlTmp: { $push: "$$ROOT" } } },
            {
              $group: {
                _id: null,
                __jsmqlTmp: { $push: { k: { $ifNull: [{ $toString: "$_id" }, "null"] }, v: "$__jsmqlTmp" } },
              },
            },
            { $replaceWith: { $arrayToObject: "$__jsmqlTmp" } },
          ],
          as: "g",
        },
      },
      { $set: { g: { $ifNull: [{ $first: "$g" }, {}] } } },
    ]);
  });

  it("rejects an array/string/number method chained on a `.find()` lookup (a single document)", () => {
    expect(() => jsmql(`$.out = $$$.orders.find(o => o.userId === $._id).take(5);`)).toThrow(
      "'.take()' is not available on an 'object' — it is defined on 'array', 'stream'.",
    );
    expect(() => jsmql(`$.out = $$$.orders.find(o => o.userId === $._id).map(o => o.total);`)).toThrow(
      "'.map()' is not available on an 'object' — it is defined on 'array', 'stream'.",
    );
    expect(jsmql(`$.out = $$$.orders.find(o => o.userId === $._id).pick(["total"]);`)).toEqual([
      {
        $lookup: {
          from: "orders",
          localField: "_id",
          foreignField: "userId",
          pipeline: [{ $limit: 1 }],
          as: "__jsmql.tmp.0",
        },
      },
      { $set: { "__jsmql.tmp.0": { $first: "$__jsmql.tmp.0" } } },
      {
        $set: {
          out: {
            $let: {
              vars: { jsmqlObj: { $ifNull: ["$__jsmql.tmp.0", {}] } },
              in: { total: { $getField: { field: "total", input: "$$jsmqlObj" } } },
            },
          },
        },
      },
      { $unset: "__jsmql" },
    ]);
    expect(jsmql(`$.out = $$$.orders.find(o => o.userId === $._id).total;`)).toEqual([
      {
        $lookup: {
          from: "orders",
          localField: "_id",
          foreignField: "userId",
          pipeline: [{ $limit: 1 }],
          as: "__jsmql.tmp.0",
        },
      },
      { $set: { "__jsmql.tmp.0": { $first: "$__jsmql.tmp.0" } } },
      { $set: { out: "$__jsmql.tmp.0.total" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("non-correlated predicate still uses $unionWith (no regression)", () => {
    expect(jsmql(`$$ = $$$.users.filter(u => u.active === true);`)).toEqual([
      { $match: { $expr: false } },
      { $unionWith: { coll: "users", pipeline: [{ $match: { active: true } }] } },
    ]);
  });

  it("non-correlated predicate + chain still uses $unionWith", () => {
    expect(jsmql(`$$ = $$$.users.filter(u => u.active === true).slice(0, 10);`)).toEqual([
      { $match: { $expr: false } },
      { $unionWith: { coll: "users", pipeline: [{ $match: { active: true } }, { $limit: 10 }] } },
    ]);
  });

  it("chain without a .filter head still uses $unionWith", () => {
    expect(jsmql(`$$ = $$$.users.slice(0, 5);`)).toEqual([
      { $match: { $expr: false } },
      { $unionWith: { coll: "users", pipeline: [{ $limit: 5 }] } },
    ]);
  });

  it("outer `let` binding referenced in the predicate triggers basic-form pivot", () => {
    expect(jsmql(`let uid = $.userId; $$ = $$$.users.filter(u => u._id === uid);`)).toEqual([
      { $set: { "__jsmql.var.uid": "$userId" } },
      { $lookup: { from: "users", localField: "__jsmql.var.uid", foreignField: "_id", as: "__jsmql.tmp.0" } },
      { $unwind: "$__jsmql.tmp.0" },
      { $replaceWith: "$__jsmql.tmp.0" },
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
    expect(jsmql(`let user = $.user; $$ = $$$.events.filter(e => e.userId === user._id);`)).toEqual([
      { $set: { "__jsmql.var.user": "$user" } },
      { $lookup: { from: "events", localField: "__jsmql.var.user._id", foreignField: "userId", as: "__jsmql.tmp.0" } },
      { $unwind: "$__jsmql.tmp.0" },
      { $replaceWith: "$__jsmql.tmp.0" },
    ]);
  });

  it("mixed `$.<field>` + outer-let predicate → the field equality is the pair, the binding a let var", () => {
    expect(
      jsmql(`let region = $.region; $$ = $$$.events.filter(e => e.userId === $._id && e.region === region);`),
    ).toEqual([
      { $set: { "__jsmql.var.region": "$region" } },
      {
        $lookup: {
          from: "events",
          localField: "_id",
          foreignField: "userId",
          let: { jsmql_v0_region: "$__jsmql.var.region" },
          pipeline: [{ $match: { $expr: { $eq: ["$region", "$$jsmql_v0_region"] } } }],
          as: "__jsmql.tmp.0",
        },
      },
      { $unwind: "$__jsmql.tmp.0" },
      { $replaceWith: "$__jsmql.tmp.0" },
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
          localField: "__jsmql.var.uid",
          foreignField: "userId",
          pipeline: [{ $sort: { placedAt: -1 } }, { $limit: 5 }],
          as: "__jsmql.tmp.0",
        },
      },
      { $unwind: "$__jsmql.tmp.0" },
      { $replaceWith: "$__jsmql.tmp.0" },
    ]);
  });
});

describe("$$ = $$$.<coll>.<streamMethod>… — any lodash method may start the chain (source-switch / pivot parity)", () => {
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
          as: "__jsmql.tmp.0",
        },
      },
      { $unwind: "$__jsmql.tmp.0" },
      { $replaceWith: "$__jsmql.tmp.0" },
    ]);
  });

  it("a non-filter stream head still throws for a value-terminal (single value is not a stream) in a pivot", () => {
    expect(() => jsmql("$$ = $$$.orders.toSorted({ createdAt: -1 }).filter(o => o.userId === $._id).size();")).toThrow(
      "'.size()' makes a value, and the stream must stay documents. Assign the value to a field instead: '$.<field> = $$$.<coll>.….size()'.",
    );
  });

  it("a non-filter method that reads the outer document joins through `$lookup.let`", () => {
    expect(jsmql("$$ = $$$.orders.map(o => ({ v: $.length }));")).toEqual([
      {
        $lookup: {
          from: "orders",
          let: { jsmql_f0_length: "$length" },
          pipeline: [{ $replaceWith: { v: "$$jsmql_f0_length" } }],
          as: "__jsmql.tmp.0",
        },
      },
      { $unwind: "$__jsmql.tmp.0" },
      { $replaceWith: "$__jsmql.tmp.0" },
    ]);
  });

  it("a CORRELATED matches-object filter routes to the pivot (not a query-literal $unionWith)", () => {
    expect(jsmql("$$ = $$$.orders.filter({ userId: $._id });")).toEqual([
      { $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "__jsmql.tmp.0" } },
      { $unwind: "$__jsmql.tmp.0" },
      { $replaceWith: "$__jsmql.tmp.0" },
    ]);
  });

  it("a value-collapsing .map in the uncorrelated source-switch is rejected (not an invalid $replaceWith)", () => {
    expect(() => jsmql("$$ = $$$.orders.map(o => o.total);")).toThrow(
      "'.map()' makes a value, and the stream must stay documents. Assign the value to a field instead: '$.<field> = $$$.<coll>.….map()'.",
    );
  });
});

describe("pipeline — structural stage placement (pre-flight validation)", () => {
  it("rejects a diagnostic source stage that is not first", () => {
    expect(() => jsmql("[ $match($.x > 1), { $collStats: {} } ]")).toThrow(
      "'$collStats' produces the pipeline's source documents, so it has to be the FIRST stage. The server refuses it anywhere else. Move it to the top of the program.",
    );
  });
  it("rejects $geoNear that is not first", () => {
    expect(() => jsmql("[ $sort({ x: 1 }), { $geoNear: { near: [0, 0], distanceField: 'd' } } ]")).toThrow(
      "'$geoNear' produces the pipeline's source documents, so it has to be the FIRST stage. The server refuses it anywhere else. Move it to the top of the program.",
    );
  });
  it("rejects $changeStream that is not first (;-form)", () => {
    expect(() => jsmql("$match($.x > 1); { $changeStream: {} }")).toThrow(
      "'$changeStream' produces the pipeline's source documents, so it has to be the FIRST stage. The server refuses it anywhere else. Move it to the top of the program.",
    );
  });
  it("accepts a source stage as the first stage", () => {
    expect(jsmql("[ { $collStats: {} }, $sort({ x: 1 }) ]")).toEqual([{ $collStats: {} }, { $sort: { x: 1 } }]);
    expect(jsmql("[ { $documents: [{ a: 1 }] }, $sort({ a: 1 }) ]")).toEqual([
      { $documents: [{ a: 1 }] },
      { $sort: { a: 1 } },
    ]);
  });

  it("rejects $merge that is not last (the headline case)", () => {
    expect(() => jsmql("[ { $merge: 'archive' }, $sort({ x: 1 }) ]")).toThrow(
      "Nothing can follow '$merge': it writes the pipeline's output and the server requires it last. Move this statement above it.",
    );
  });
  it("rejects $out (literal) that is not last", () => {
    expect(() => jsmql("[ { $out: 'c' }, $count('n') ]")).toThrow(
      "Nothing can follow '$out': it writes the pipeline's output and the server requires it last. Move this statement above it.",
    );
  });
  it("rejects $changeStreamSplitLargeEvent that is not last", () => {
    expect(() => jsmql("[ { $changeStreamSplitLargeEvent: {} }, $sort({ x: 1 }) ]")).toThrow(
      "Nothing can follow '$changeStreamSplitLargeEvent': it writes the pipeline's output and the server requires it last. Move this statement above it.",
    );
  });
  it("accepts $merge as the last stage", () => {
    expect(jsmql("[ $sort({ x: 1 }), { $merge: 'archive' } ]")).toEqual([{ $sort: { x: 1 } }, { $merge: "archive" }]);
  });

  it("rejects a stage link after a terminal stage in the same chain", () => {
    expect(() => jsmql("$$.filter(d => d.a).$out('archive').$limit(1);")).toThrow(
      "Nothing can follow '$out': it writes the pipeline's output and the server requires it last. Move this statement above it.",
    );
  });
  it("rejects a stream method after a terminal stage in the same chain", () => {
    expect(() => jsmql("$$.filter(d => d.a).$merge({ into: 't' }).take(1);")).toThrow(
      "Nothing can follow '$merge': it writes the pipeline's output and the server requires it last. Move this statement above it.",
    );
  });
  it("accepts a terminal stage that ends the chain", () => {
    expect(jsmql("$$.$sort({ x: 1 }).$out('archive');")).toEqual([{ $sort: { x: 1 } }, { $out: "archive" }]);
  });

  it("rejects two terminal stages (the first is not last)", () => {
    expect(() => jsmql("[ { $out: 'a' }, { $merge: 'b' } ]")).toThrow(
      "Nothing can follow '$out': it writes the pipeline's output and the server requires it last. Move this statement above it.",
    );
  });
  it("rejects two source stages (the second is not first)", () => {
    expect(() => jsmql("[ { $collStats: {} }, { $indexStats: {} } ]")).toThrow(
      "'$indexStats' produces the pipeline's source documents, so it has to be the FIRST stage. The server refuses it anywhere else. Move it to the top of the program.",
    );
  });

  it("rejects $out inside a $facet sub-pipeline", () => {
    expect(() => jsmql("[ { $facet: { a: [ { $out: 'x' } ] } } ]")).toThrow(
      "'$out' cannot stand inside '$facet' — the server refuses it in that body. Run it as a stage of the outer pipeline instead.",
    );
  });
  it("rejects $merge inside a $lookup sub-pipeline", () => {
    expect(() => jsmql("[ { $lookup: { from: 'c', as: 'r', pipeline: [ { $merge: 'x' } ] } } ]")).toThrow(
      "'$merge' cannot stand inside '$lookup' — the server refuses it in that body. Run it as a stage of the outer pipeline instead.",
    );
  });
  it("rejects $merge inside a $unionWith sub-pipeline", () => {
    expect(() => jsmql("[ { $unionWith: { coll: 'c', pipeline: [ { $merge: 'x' } ] } } ]")).toThrow(
      "'$merge' cannot stand inside '$unionWith' — the server refuses it in that body. Run it as a stage of the outer pipeline instead.",
    );
  });
  it("rejects a nested $facet", () => {
    expect(() => jsmql("[ { $facet: { a: [ { $facet: { b: [ $count('n') ] } } ] } } ]")).toThrow(
      "'$facet' cannot stand inside '$facet' — the server refuses it in that body. Run it as a stage of the outer pipeline instead.",
    );
  });
  it("rejects $geoNear inside a $facet sub-pipeline", () => {
    expect(() => jsmql("[ { $facet: { a: [ { $geoNear: { near: [0, 0], distanceField: 'd' } } ] } } ]")).toThrow(
      "'$geoNear' cannot stand inside '$facet' — the server refuses it in that body. Run it as a stage of the outer pipeline instead.",
    );
  });
  it("accepts $geoNear as the FIRST stage of a $lookup sub-pipeline (not over-forbidden)", () => {
    expect(
      jsmql(
        "[ { $lookup: { from: 'c', as: 'r', pipeline: [ { $geoNear: { near: [0, 0], distanceField: 'd' } } ] } } ]",
      ),
    ).toEqual([{ $lookup: { from: "c", as: "r", pipeline: [{ $geoNear: { near: [0, 0], distanceField: "d" } }] } }]);
  });
  it("rejects $geoNear that is not first WITHIN a $lookup sub-pipeline", () => {
    expect(() =>
      jsmql(
        "[ { $lookup: { from: 'c', as: 'r', pipeline: [ $match($.a > 0), { $geoNear: { near: [0, 0], distanceField: 'd' } } ] } } ]",
      ),
    ).toThrow(
      "'$geoNear' produces the pipeline's source documents, so it has to be the FIRST stage. The server refuses it anywhere else. Move it to the top of the program.",
    );
  });

  it("rejects a first-only stage whose body needs a stage of its own ahead of it", () => {
    expect(() => jsmql('$geoNear({ near: [1, 2], distanceField: "d", query: { n: $$.size() } });')).toThrow(
      /'\$geoNear' has to be the FIRST stage of the pipeline\. A value in its body needs a '\$setWindowFields' stage of its own to run BEFORE it\..*\$geoNear\(\{ … \}\); \$match\(\$\.<field> === \$\$\.size\(\)\);/s,
    );
    expect(() =>
      jsmql('$geoNear({ near: [1, 2], distanceField: "d", query: { n: $$$.p.find({ _id: $.pid }).n } });'),
    ).toThrow(/needs a '\$lookup' stage of its own.*\$\$\$\.<coll>\.find\(\{ … \}\)\.<field>/s);
    expect(() => jsmql('$geoNear({ near: [1, 2], distanceField: "d", maxDistance: $$.size() });')).toThrow(
      /give it a constant or a 'jsmql\.compile' parameter/,
    );
    expect(() => jsmql("$documents([{ n: $$.size() }]);")).toThrow(/'\$documents' has to be the FIRST stage/);
    expect(() =>
      jsmql('$$.reduce((acc, d) => $text({ $search: "x" }) && d.n === $$.size() ? acc.concat(d) : acc, []);'),
    ).toThrow("'$text(…)' is raw MQL, and raw MQL cannot be an operand of '&&'.");
  });

  it("rejects a first-only OPERATOR whose $match body needs a stage of its own", () => {
    expect(() => jsmql('$match({ $text: { $search: "x" }, n: $$.size() });')).toThrow(
      /'\$text' only runs in the pipeline's FIRST '\$match'.*\$match\(\$text\(…\)\); \$match\(\$\.<field> === \$\$\.size\(\)\);/s,
    );
    expect(jsmql('$match($text({ $search: "x" })); $match($.n === $$.size());')).toEqual([
      { $match: { $text: { $search: "x" } } },
      { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
      { $match: { $expr: { $eq: ["$n", "$__jsmql.size"] } } },
      { $unset: "__jsmql" },
    ]);
  });

  it("keeps a first-only stage in a sub-pipeline when the OUTER chain hoists", () => {
    expect(
      jsmql(
        '$lookup({ from: "p", as: "o", pipeline: [$geoNear({ near: [1, 2], distanceField: "d", query: { n: $$.size() } })] });',
      ),
    ).toEqual([
      { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
      {
        $lookup: {
          from: "p",
          as: "o",
          pipeline: [
            { $geoNear: { near: [1, 2], distanceField: "d", query: { $expr: { $eq: ["$n", "$$jsmql_s0_size"] } } } },
          ],
          let: { jsmql_s0_size: "$__jsmql.size" },
        },
      },
      { $unset: "__jsmql" },
    ]);
    expect(jsmql('$.o = $$$.p.$geoNear({ near: [1, 2], distanceField: "d", query: { n: $$.size() } });')).toEqual([
      { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
      {
        $lookup: {
          from: "p",
          let: { jsmql_s0_size: "$__jsmql.size" },
          pipeline: [
            { $geoNear: { near: [1, 2], distanceField: "d", query: { $expr: { $eq: ["$n", "$$jsmql_s0_size"] } } } },
          ],
          as: "o",
        },
      },
      { $unset: "__jsmql" },
    ]);
  });

  it("rejects a terminal stage whose body reads a materialised value", () => {
    expect(() => jsmql('$merge({ into: "c", let: { v: $$.size() }, whenMatched: [$set({ z: "$$v" })] });')).toThrow(
      /'\$merge' writes the pipeline's output and has to be its LAST stage.*\$\.n = \$\$\.size\(\); \$merge\(/s,
    );
    expect(
      jsmql('$.n = $$.size(); $merge({ into: "c", let: { v: $.n }, whenMatched: [$set({ z: "$$v" })] });'),
    ).toEqual([
      { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
      { $set: { n: "$__jsmql.size" } },
      { $unset: "__jsmql" },
      { $merge: { into: "c", let: { v: "$n" }, whenMatched: [{ $set: { z: "$$v" } }] } },
    ]);
    expect(jsmql('$$$["__jsmqlArchive"] = $$;')).toEqual([{ $out: "__jsmqlArchive" }]);
    expect(jsmql('$merge({ into: "c", let: { v: $.n }, whenMatched: [$set({ z: "$$v" })] });')).toEqual([
      { $merge: { into: "c", let: { v: "$n" }, whenMatched: [{ $set: { z: "$$v" } }] } },
    ]);
  });

  it("keeps a first-only stage in a sub-pipeline, whatever stands ahead of the container", () => {
    expect(
      jsmql('$.b = 2; $lookup({ from: "c", as: "o", pipeline: [$geoNear({ near: [0, 0], distanceField: "d" })] });'),
    ).toEqual([
      { $set: { b: 2 } },
      { $lookup: { from: "c", as: "o", pipeline: [{ $geoNear: { near: [0, 0], distanceField: "d" } }] } },
    ]);
    expect(
      jsmql('$.b = 2; $unionWith({ coll: "c", pipeline: [$geoNear({ near: [0, 0], distanceField: "d" })] });'),
    ).toEqual([
      { $set: { b: 2 } },
      { $unionWith: { coll: "c", pipeline: [{ $geoNear: { near: [0, 0], distanceField: "d" } }] } },
    ]);
    expect(() =>
      jsmql(
        '$lookup({ from: "c", as: "o", pipeline: [$sort({ a: 1 }), $geoNear({ near: [0, 0], distanceField: "d" })] });',
      ),
    ).toThrow(/'\$geoNear' produces the pipeline's source documents/);
  });

  it("refuses a stage an update spec does not run, wherever the $merge stands", () => {
    const refused = /cannot stand inside '\$merge'\. That body is an UPDATE, not a pipeline/;
    expect(() => jsmql('$merge({ into: "c", whenMatched: [$sort({ a: 1 })] });')).toThrow(refused);
    expect(() => jsmql('$.b = 2; $merge({ into: "c", whenMatched: [$sort({ a: 1 })] });')).toThrow(refused);
    expect(() =>
      jsmql('$merge({ into: "c", whenMatched: [$geoNear({ near: [0, 0], distanceField: "d" })] });'),
    ).toThrow(refused);
    expect(() => jsmql('$merge({ into: "c", whenMatched: [$match($.a > 1)] });')).toThrow(
      /'\$addFields', '\$set', '\$project', '\$unset', '\$replaceRoot', '\$replaceWith' and '\$fill'/,
    );
    expect(jsmql('$merge({ into: "c", whenMatched: [$set({ z: 9 })] });')).toEqual([
      { $merge: { into: "c", whenMatched: [{ $set: { z: 9 } }] } },
    ]);
    expect(jsmql('$merge({ into: "c", whenMatched: [$fill({ output: { a: { value: 0 } } })] });')).toEqual([
      { $merge: { into: "c", whenMatched: [{ $fill: { output: { a: { value: 0 } } } }] } },
    ]);
  });

  it("surfaces a structural violation through validate() with a meaningful pos", () => {
    const src = "[ { $facet: { a: [ { $out: 'x' } ] } } ]";
    const result = jsmql.validate(src);
    expect(result.valid).toBe(false);
    expect(result.errors[0].code).toBe("CODEGEN_ERROR");
    expect(result.errors[0].pos).toBe(src.indexOf("{ $out"));
  });
});

describe("chained stage calls on the current stream", () => {
  it("lowers a chain of stage links to the same stages as the statement form", () => {
    expect(jsmql("$$.$match({ status: 'shipped' }).$sort({ total: -1 }).$limit(5);")).toEqual([
      { $match: { status: "shipped" } },
      { $sort: { total: -1 } },
      { $limit: 5 },
    ]);
  });

  it("is byte-identical to the `;`-separated statement spelling", () => {
    const chained = jsmql("$$.$match({ status: 'shipped' }).$sort({ total: -1 }).$limit(5);");
    const statements = jsmql("$match({ status: 'shipped' }); $sort({ total: -1 }); $limit(5);");
    expect(chained).toEqual([{ $match: { status: "shipped" } }, { $sort: { total: -1 } }, { $limit: 5 }]);
    expect(statements).toEqual(chained);
  });

  it("reaches stages that have no JavaScript spelling", () => {
    expect(jsmql("$$.$match({ status: 'shipped' }).$group({ _id: '$dept', n: $sum(1) }).$sort({ n: -1 });")).toEqual([
      { $match: { status: "shipped" } },
      { $group: { _id: "$dept", n: { $sum: 1 } } },
      { $sort: { n: -1 } },
    ]);
  });

  it("interleaves freely with lodash chain methods", () => {
    expect(jsmql("$$.filter(p => p.a > 1).$sort({ b: -1 }).take(2);")).toEqual([
      { $match: { a: { $gt: 1 } } },
      { $sort: { b: -1 } },
      { $limit: 2 },
    ]);
  });

  it("shares the stage buffer with registry chain methods", () => {
    expect(jsmql("$$.$sort({ a: -1 }).take(3);")).toEqual([{ $sort: { a: -1 } }, { $limit: 3 }]);
    expect(jsmql("$$.take(3).$sort({ a: -1 });")).toEqual([{ $limit: 3 }, { $sort: { a: -1 } }]);
  });

  it("a stage-link $sort satisfies .takeWhile's preceding-sort requirement", () => {
    const stages = jsmql("$$.$sort({ t: 1 }).takeWhile(o => o.ok);") as object[];
    expect((stages[1] as { $setWindowFields: { sortBy: unknown } }).$setWindowFields.sortBy).toEqual({ t: 1 });
  });

  it("a removed 'from the end' method is rejected after a stage link too", () => {
    expect(() => jsmql("$$.$sort({ a: 1 }).toReversed();")).toThrow(
      "'.toReversed()' isn't available on '$$' — reverses the stream, and a stream has no defined order to reverse until it is sorted. Use '.orderBy({ <field>: -1 })' with the direction you want.",
    );
  });

  it("works as a whole program with no trailing semicolon", () => {
    expect(jsmql("$$.$match({ a: 1 }).$limit(5)")).toEqual([{ $match: { a: 1 } }, { $limit: 5 }]);
  });

  it("a reshaping stage link clears the let scope, naming itself", () => {
    expect(() => jsmql("let n = $.qty * 2; $$.$group({ _id: '$a' }); $set({ x: n });")).toThrow(
      /`n` is a `let` binding\. It cannot be read after `\$group`/,
    );
  });

  describe("errors", () => {
    it("passes an unknown stage name through, and suggests for a JavaScript name", () => {
      expect(jsmql("$$.$prject({ a: 1 });")).toEqual([{ $prject: { a: 1 } }]);
      expect(() => jsmql("$$.prject({ a: 1 });")).toThrow(
        "'.prject()' is not a method of the stream '$$'. Did you mean '.$project()'? A stage is a link too: '$$.$match(…)'.",
      );
    });

    it("passes an expression operator chained as a stage through as written", () => {
      expect(jsmql("$$.$abs(1);")).toEqual([{ $abs: 1 }]);
    });

    it("passes a stage link with any argument count through, in HR2's plain form", () => {
      expect(jsmql("$$.$limit();")).toEqual([{ $limit: {} }]);
      expect(jsmql("$$.$limit(5, 6);")).toEqual([{ $limit: [5, 6] }]);
    });

    it("rejects a bare `.$stage` with no call", () => {
      expect(() => jsmql("$$.$match")).toThrow(
        "A pipeline statement writes something: a field ('$.total = …;'), the document ('$ = { … };'), a deletion ('delete $.x;'), or a stage ('$match(…);'). This expression only computes a value — assign it to a field, or wrap a predicate as '$match(…)'.",
      );
    });

    it("rejects optional chaining on a stage link", () => {
      expect(() => jsmql("$$?.$match({ a: 1 });")).toThrow(
        "'$$' is the stream of documents and is never null, so '?.' has nothing to guard. Write '$$.' instead.",
      );
    });

    it("rejects a stage link whose receiver is a value, not a stream", () => {
      expect(() => jsmql("$.out = $.items.$match({ a: 1 });")).toThrow(
        "'.$match()' is a pipeline stage, and a stage runs on a stream, not on a value. Write it as a chain link ('$$.$match(…)') or as a pipeline statement ('$match(…);'). For the value form, use '$filter(…)'.",
      );
      expect(() => jsmql("$.out = $.items.$bucket({ groupBy: 1 });")).toThrow(
        "'.$bucket()' is a pipeline stage, and a stage runs on a stream, not on a value. Write it as a chain link ('$$.$bucket(…)') or as a pipeline statement ('$bucket(…);').",
      );
    });

    it("rejects a stage link after the chain collapses to a value", () => {
      expect(() => jsmql("$.out = $$$.orders.filter({ a: 1 }).map('x').uniq().$limit(5);")).toThrow(
        "'.$limit()' is a pipeline stage, and a stage runs on a stream, not on a value. Write it as a chain link ('$$.$limit(…)') or as a pipeline statement ('$limit(…);'). For the value form, use '$slice(…)'.",
      );
    });
  });
});

describe("a bare `$$$.<coll>.<chain>;` statement names its missing destination", () => {
  it("points at the three destinations", () => {
    expect(() => jsmql("$$$.orders.$match({ a: 1 });")).toThrow(
      "Reading another collection produces a value, and this statement gives it no destination. Assign it to a field ('$.<field> = $$$.<coll>.…'), bind it ('let x = $$$.<coll>.…'), or make it the stream ('$$ = $$$.<coll>.…').",
    );
    expect(() => jsmql("$$$.orders.filter({ a: 1 }).take(2);")).toThrow(
      "Reading another collection produces a value, and this statement gives it no destination. Assign it to a field ('$.<field> = $$$.<coll>.…'), bind it ('let x = $$$.<coll>.…'), or make it the stream ('$$ = $$$.<coll>.…').",
    );
  });

  it("names the cross-database ref when there is one", () => {
    expect(() => jsmql("$$$$.other.orders.$match({ a: 1 });")).toThrow(
      "Reading another collection produces a value, and this statement gives it no destination. Assign it to a field ('$.<field> = $$$.<coll>.…'), bind it ('let x = $$$.<coll>.…'), or make it the stream ('$$ = $$$.<coll>.…').",
    );
  });

  it("leaves the value-terminal message alone", () => {
    expect(() => jsmql("$$$.orders.head();")).toThrow(
      "Reading another collection produces a value, and this statement gives it no destination. Assign it to a field ('$.<field> = $$$.<coll>.…'), bind it ('let x = $$$.<coll>.…'), or make it the stream ('$$ = $$$.<coll>.…').",
    );
  });

  it("a bare `$$` chain still works — it transforms the current stream", () => {
    expect(jsmql("$$.$match({ a: 1 });")).toEqual([{ $match: { a: 1 } }]);
  });
});

describe("$facet branches accept any `$$` chain", () => {
  it("accepts a bare stage link", () => {
    expect(jsmql("$ = { k: $$.$match({ a: 1 }) };")).toEqual([{ $facet: { k: [{ $match: { a: 1 } }] } }]);
  });

  it("accepts a stage link after a .filter", () => {
    expect(jsmql("$ = { k: $$.filter(d => d.a === 1).$limit(3) };")).toEqual([
      { $facet: { k: [{ $match: { a: 1 } }, { $limit: 3 }] } },
    ]);
  });

  it("mixes chain branches with the classic .filter(<arrow>) branch", () => {
    expect(jsmql('$ = { hi: $$.$match({ s: "a" }).$limit(2), lo: $$.filter(d => d.n < 5) };')).toEqual([
      { $facet: { hi: [{ $match: { s: "a" } }, { $limit: 2 }], lo: [{ $match: { n: { $lt: 5 } } }] } },
    ]);
  });

  it("rejects a write stage in a branch, naming $facet", () => {
    expect(() => jsmql('$ = { k: $$.$out("x") };')).toThrow(
      "'$out' cannot stand inside '$facet' — the server refuses it in that body. Run it as a stage of the outer pipeline instead.",
    );
  });

  it("leaves a non-chain object RHS as $replaceWith", () => {
    expect(jsmql("$ = { a: 1, b: 2 };")).toEqual([{ $replaceWith: { a: 1, b: 2 } }]);
  });
});

describe("`$$` predicate spellings are interchangeable in every container", () => {
  const SPELLINGS = [
    ["arrow", "$$.filter(o => o.a === 1)"],
    ["block body returning the predicate", "$$.filter(o => { return o.a === 1; })"],
    ["matches-object", "$$.filter({ a: 1 })"],
    ['["field", value] pair', '$$.filter(["a", 1])'],
  ] as const;
  const CONTAINERS = [
    ["`$$ =` stream", (p: string) => `$$ = ${p};`, (m: object) => [m]],
    ["`$facet` branch", (p: string) => `$ = { k: ${p} };`, (m: object) => [{ $facet: { k: [m] } }]],
    ["`$out` write chain", (p: string) => `$$$.c = ${p};`, (m: object) => [m, { $out: "c" }]],
  ] as const;

  for (const [container, source, expected] of CONTAINERS) {
    for (const [spelling, predicate] of SPELLINGS) {
      it(`${container} accepts the ${spelling} spelling`, () => {
        expect(jsmql(source(predicate))).toEqual(expected({ $match: { a: 1 } }));
      });
    }
  }

  it("a non-constant matcher value lowers to $expr, not an invalid query operator", () => {
    for (const [container, source, expected] of CONTAINERS) {
      expect(jsmql(source("$$.filter({ a: 2 + 3 })")), container).toEqual(expected({ $match: { a: 5 } }));
    }
  });

  it("reads a `$.<field>` matcher value as a field of the same document, in every container", () => {
    for (const [container, source, expected] of CONTAINERS) {
      expect(jsmql(source("$$.filter({ a: $.b })")), container).toEqual(
        expected({ $match: { $expr: { $eq: ["$a", "$b"] } } }),
      );
    }
  });
});

describe("a predicate error never advises a different receiver", () => {
  const VOCABULARY = (m: string) =>
    `'.${m}()' takes a predicate here — an arrow ('d => …'), a field name ('"status"'), an index ('0'), a matcher object ('{ status: "paid" }'), or a '[field, value]' pair ('["status", "paid"]'). Got a boolean.`;
  const INDEX = "`b` has no value inside `.filter()` — a stream has no per-document index; leave the parameter unused.";
  for (const receiver of ["$$", "$$$.orders"]) {
    it(`${receiver}: the vocabulary message names the method only`, () => {
      expect(() => jsmql(`$$ = ${receiver}.filter(true);`)).toThrow(VOCABULARY("filter"));
    });

    it(`${receiver}: the index-parameter message names the method only`, () => {
      expect(() => jsmql(`$$ = ${receiver}.filter((a, b) => a > b);`)).toThrow(INDEX);
    });

    it(`${receiver}: .reject keeps step with .filter`, () => {
      expect(() => jsmql(`$$ = ${receiver}.reject(true);`)).toThrow(VOCABULARY("reject"));
    });
  }

  it("$$$$.shop.orders: the cross-database refusal comes first, for each predicate error", () => {
    const CROSS_DB =
      "A read of another DATABASE is not supported. '$lookup' and '$unionWith' reach the current database only (the '{ db, coll }' form is Atlas Data Federation's). Drop the '$$$$.<db>.' prefix — '$$$.<coll>' — and run the pipeline against that database. Cross-database WRITES work: '$$$$.<db>.<coll> = $$'.";
    expect(() => jsmql("$$ = $$$$.shop.orders.filter(123);")).toThrow(CROSS_DB);
    expect(() => jsmql("$$ = $$$$.shop.orders.filter((a, b) => a > b);")).toThrow(CROSS_DB);
    expect(() => jsmql("$$ = $$$$.shop.orders.reject(123);")).toThrow(CROSS_DB);
  });

  it("the argument-count message names the method only", () => {
    expect(() => jsmql("$$ = $$$.orders.take(2).filter(o => o.a, 2);")).toThrow(
      "'.filter(predicate)' requires exactly 1 argument, got 2 — JavaScript's trailing 'thisArg' has no meaning in MQL; drop it",
    );
  });
});

describe("assignment sugar inside a literal sub-pipeline array", () => {
  const wrap = (el: string) => `$lookup({ from: "o", pipeline: [${el}], as: "o" });`;

  it("rejects `$ = …` and names $replaceWith", () => {
    expect(() => jsmql(wrap("$ = { t: $.total }"))).toThrow(
      "The outer document cannot be written from inside a body over another collection — only read. Write the body's own document through its callback parameter ('o.x = …', 'delete o.x', 'o = { … }'), or as a stage ('$set({ x: … })'). Write the outer field after the join.",
    );
  });

  it("rejects `$$ = …` and names $match", () => {
    expect(() => jsmql(wrap("$$ = $$.filter(d => d.a > 1)"))).toThrow(
      "'$$' is the root stream, and a body over another collection cannot reach it. Name the body's own stream through the callback's third parameter — '(o, _i, stream) => { stream.filter(…); }' — or write the stage: '$match(…)', '$sort(…)'.",
    );
  });

  it("rejects a collection write without an internal error", () => {
    expect(() => jsmql(wrap("$$$.arch = $$"))).toThrow(
      "'$out' cannot stand inside '$lookup' — the server refuses it in that body. Run it as a stage of the outer pipeline instead.",
    );
  });

  it("refuses an ordinary field assignment: the outer document is read-only there (HR4)", () => {
    expect(() => jsmql(wrap("$.a = 1"))).toThrow(
      "The outer document cannot be written from inside a body over another collection — only read. Write the body's own document through its callback parameter ('o.x = …', 'delete o.x', 'o = { … }'), or as a stage ('$set({ x: … })'). Write the outer field after the join.",
    );
  });
});

describe("a lookup inside a literal sub-pipeline array", () => {
  const OUTER_WRITE =
    "The outer document cannot be written from inside a body over another collection — only read. Write the body's own document through its callback parameter ('o.x = …', 'delete o.x', 'o = { … }'), or as a stage ('$set({ x: … })'). Write the outer field after the join.";
  it("is refused in a $unionWith or $lookup body (an outer write), and runs inside a $facet branch", () => {
    expect(() => jsmql('$unionWith({ coll: "c", pipeline: [$.o = $$$.orders.find(o => o.uid === 1)] });')).toThrow(
      OUTER_WRITE,
    );
    expect(() => jsmql('$lookup({ from: "o", pipeline: [$.x = $$$.items.find(i => i.k === 1)], as: "o" });')).toThrow(
      OUTER_WRITE,
    );
    expect(jsmql("$facet({ a: [$.o = $$$.orders.find(o => o.uid === 1)] });")).toEqual([
      {
        $facet: {
          a: [
            { $lookup: { from: "orders", pipeline: [{ $match: { uid: 1 } }, { $limit: 1 }], as: "o" } },
            { $set: { o: { $first: "$o" } } },
          ],
        },
      },
    ]);
  });

  it("hoists out of an ORDINARY stage body", () => {
    expect(jsmql("$project({ o: $$$.orders.find(o => o.uid === 1) });")).toEqual([
      { $lookup: { from: "orders", pipeline: [{ $match: { uid: 1 } }, { $limit: 1 }], as: "__jsmql.tmp.0" } },
      { $set: { "__jsmql.tmp.0": { $first: "$__jsmql.tmp.0" } } },
      { $project: { o: "$__jsmql.tmp.0" } },
      { $unset: "__jsmql" },
    ]);
  });
});

describe("jsmql() and jsmql.pipeline() agree on the lookup form", () => {
  const SRC = "$.o = $$$.orders.find(o => o.uid === 1)";
  it("compiles identically through both entries", () => {
    expect(jsmql(SRC)).toEqual([
      { $lookup: { from: "orders", pipeline: [{ $match: { uid: 1 } }, { $limit: 1 }], as: "o" } },
      { $set: { o: { $first: "$o" } } },
    ]);
    expect(jsmql.pipeline(SRC)).toEqual([
      { $lookup: { from: "orders", pipeline: [{ $match: { uid: 1 } }, { $limit: 1 }], as: "o" } },
      { $set: { o: { $first: "$o" } } },
    ]);
  });

  it("jsmql.update() still refuses it — $lookup is not in the update whitelist", () => {
    expect(() => jsmql.update(SRC)).toThrow(
      "'$$$.<coll>' (a read of another collection) needs Pipeline mode — it materialises a '$lookup' stage. Use it inside a pipeline — for example, `({ $ }) => { $.n = $$$.<coll>.filter(…).size(); }`. It has no meaning in a Filter or in 'jsmql.expr'.",
    );
  });
});
