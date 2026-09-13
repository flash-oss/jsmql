import { describe, it, expect } from "vitest";
import { jsmql } from "../src/index.ts";
import { truthy } from "./truthy.ts";

/** `$$ = …` takes many documents; the refusal names every right side that gives them. */
const WAYS =
  "Write a chain that starts from '$$' ('$$ = $$.filter(d => d.x > 1).take(10);'), a list of documents ('$$ = [{ a: 1 }, { a: 2 }];'), or an array whose elements are the documents ('$$ = $.items;').";
const CHAIN = `'$$ = …' replaces the STREAM, so the right side has to be MANY documents. ${WAYS}`;
const MSG = `'$$ = …' replaces the STREAM, so the right side has to be MANY documents — a number is one value. ${WAYS}`;

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
    // See `docs/specs/emit-pass.md` § The filter target for the full rules; cases
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
    expect(a).toEqual([{ $match: { age: { $gt: 18 } } }]);
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

  it("$lookup pipeline: a field ref is rejected (HR3 — pipeline must be a constant array)", () => {
    // The server rejects `{ $lookup: { pipeline: "$someVar" } }` ("A pipeline must
    // be an array of objects"), so a non-array pipeline slot throws at compile time.
    expect(() => jsmql('[{ $lookup: { from: "x", pipeline: $.someVar, as: "y" } }]')).toThrow(
      "'$lookup' pipeline is a sub-pipeline: write it as a bracketed list of stages, 'pipeline: [$match(…), $sort(…)]'.",
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
    expect(() => jsmql(`[{ $unionWith: { coll: "archive", pipeline: [{ $match: $.year < 2020 }] } }]`)).toThrow(
      "'$unionWith' has no 'let': its body cannot read the outer document or a binding declared outside it. Filter or reshape the outer stream in a statement before it, or read the other collection through a join ('$.<field> = $$$.<coll>.filter(…)'), whose '$lookup' carries the value.",
    );
  });
});

describe("raw MQL stage bodies pass through UNGUARDED (escape hatch — see src/CLAUDE.md)", () => {
  // The complement of the cross-database SUGAR rejection (lookup.test.ts /
  // "replace stream"): jsmql rejects `$$$$.<db>.<coll>` reads because it minted
  // that surface (HR3), but it must NEVER guard the RAW operator/stage form — the
  // developer owns hand-written MQL, and a `{ db, coll }` namespace IS valid on
  // Atlas Data Federation. A guard creeping onto these (e.g. extending the
  // cross-database refusal to raw stages) must fail here.
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
    expect(() => jsmql("[{ $match: $.a > 1 }, 42]")).toThrow(
      "A pipeline statement writes something: a field ('$.total = …;'), the document ('$ = { … };'), a deletion ('delete $.x;'), or a stage ('$match(…);'). This expression only computes a value — assign it to a field, or wrap a predicate as '$match(…)'.",
    );
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
    // Distinct lowering path from the field-assign/source-switch/union cases:
    // the root replacement reads the chain through `joinRoot`
    // (src/compiler/emit/join.ts), so it gets its own coverage.
    expect(() => jsmql("[ $ = $$$$.analytics.users.find(u => u._id === $.userId) ]")).toThrow(
      "A read of another DATABASE isn't supported: '$lookup' and '$unionWith' reach the current database only (the '{ db, coll }' form is Atlas Data Federation's). Drop the '$$$$.<db>.' prefix — '$$$.<coll>' — and run the pipeline against that database. Cross-database WRITES work: '$$$$.<db>.<coll> = $$'.",
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

  // A bare `$ = <expr>` as the ONLY statement (no trailing `;`) parses as a one-op
  // UpdateFilter rather than a Pipeline. Without the reroute it would emit a
  // meaningless `$set` on the "" field path (`[{ $set: { "": … } }]`); it must lower
  // to `$replaceWith`, identical to the `;`-terminated form.
  it("single-statement `$ = { … }` (no `;`) lowers to `$replaceWith`, not `$set: { '': … }`", () => {
    expect(jsmql("$ = { a: 1 }")).toEqual([{ $replaceWith: { a: 1 } }]);
    // …byte-identical to the `;`-form and the bracketed form.
    expect(jsmql("$ = { a: 1 }")).toEqual([{ $replaceWith: { a: 1 } }]);
    expect(jsmql("$ = { a: 1 }")).toEqual([{ $replaceWith: { a: 1 } }]);
  });

  it("single-statement `$ = <expr>` (no `;`) reroutes across every Pipeline entry", () => {
    const expected = [{ $replaceWith: "$profile" }];
    expect(jsmql("$ = $.profile")).toEqual([{ $replaceWith: "$profile" }]);
    expect(jsmql.pipeline("$ = $.profile")).toEqual([{ $replaceWith: "$profile" }]);
  });

  it("`$ = <expr>` is refused by the expression entry, which returns no stages", () => {
    // `jsmql.expr()` returns one aggregation expression. Root-replace lowers to a
    // `$replaceWith` STAGE, so it belongs to a Pipeline entry — the rejection names
    // both ways out rather than handing back an array from the expression surface.
    expect(() => jsmql.expr("$ = $.profile")).toThrow(
      "jsmql.expr() expects an aggregation expression (the value of a stage field, `jsmql.expr`), but received a root-replace `$ = <expr>` (a `$replaceWith` stage). Use jsmql.pipeline().",
    );
    expect(() => jsmql.expr("$ = { a: $.b }")).toThrow(
      "jsmql.expr() expects an aggregation expression (the value of a stage field, `jsmql.expr`), but received a root-replace `$ = <expr>` (a `$replaceWith` stage). Use jsmql.pipeline().",
    );
    expect(() => jsmql.expr("$$ = $$.filter(d => d.x === 1)")).toThrow(/stream-replace/);
    // A facet-shaped RHS is still a root replacement, so it takes the same route.
    expect(() => jsmql.expr("$ = { a: $$.filter(d => d.x === 1) }")).toThrow(/root-replace/);
    // The ordinary update-op form is untouched — it IS an expression building block.
    expect(() => jsmql.expr("$.a = 1")).toThrow(
      "jsmql.expr() expects an aggregation expression (the value of a stage field, `jsmql.expr`), but received a write (`$.x = …`, `delete $.x`). Use jsmql.update() for an update document, or jsmql.pipeline() for a `$set` / `$unset` pipeline.",
    );
  });

  it("single-statement `$ = <expr>` still reuses the full replace-root machinery (non-document reject)", () => {
    // Both spellings reach the same `writeStages` (src/compiler/emit/statement.ts),
    // so the no-`;` form gets the same actionable rejection as the `;`-form.
    expect(() => jsmql("$ = 5")).toThrow(
      "'$ = …' replaces the document, so the value has to BE a document — a number is not one. Put it under a field ('$ = { value: … };'), or write to a field instead ('$.value = …;').",
    );
    expect(() => jsmql("$ = [1, 2]")).toThrow(/replaces ONE document, and this value is an array/);
    expect(() => jsmql("$ = [1, 2]")).toThrow(
      "'$ = …' replaces ONE document, and this value is an array. Name the destination that takes an array: '$$ = <array>;' makes the stream from its elements, one document per element. To keep the array as a field of this document, write '$.<field> = <array>;'.",
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
      { $set: { "__jsmql.tmp.0": "$items" } },
      { $unwind: "$__jsmql.tmp.0" },
      { $replaceWith: "$__jsmql.tmp.0" },
    ]);
  });

  it("fans out a provably-array expression (`.map`)", () => {
    expect(jsmql("[ $$ = $.items.map(x => ({ sku: x.sku })) ]")).toEqual([
      { $set: { "__jsmql.tmp.0": { $map: { input: "$items", as: "x", in: { sku: "$$x.sku" } } } } },
      { $unwind: "$__jsmql.tmp.0" },
      { $replaceWith: "$__jsmql.tmp.0" },
    ]);
  });

  it("refuses a fan-out whose elements the registry proves are not documents", () => {
    // JavaScript's `Object.entries` gives `[key, value]` PAIRS, and a stream holds
    // documents — MEASURED, `$replaceWith` of an array answers "'replacement document'
    // must evaluate to an object". The row states the element kind, so the refusal is
    // at compile time and names the two spellings that do work.
    expect(() => jsmql("[ $$ = Object.entries($.scores) ]")).toThrow(
      /makes documents from the array's ELEMENTS, one each, and these elements are arrays/,
    );
    // The way out the message names, taken:
    expect(jsmql("[ $$ = Object.entries($.scores).map((v) => ({ value: v })) ]")).toEqual([
      {
        $set: {
          "__jsmql.tmp.0": {
            $map: {
              input: {
                $map: { input: { $objectToArray: "$scores" }, as: "jsmqlKv", in: ["$$jsmqlKv.k", "$$jsmqlKv.v"] },
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
    // `$objectToArray` gives `{ k, v }` documents outright, so it fans out as it stands.
    expect(jsmql("[ $$ = $objectToArray($.scores) ]")).toEqual([
      { $set: { "__jsmql.tmp.0": { $objectToArray: "$scores" } } },
      { $unwind: "$__jsmql.tmp.0" },
      { $replaceWith: "$__jsmql.tmp.0" },
    ]);
  });

  it("a possibly-empty filter fan-out drops docs whose array is empty (per-document drop)", () => {
    // `$unwind` of an empty array emits no document — so docs with no matching
    // element are dropped, while others fan out. This is how a conditional drop
    // is spelled; a literal list (`$$ = [{ … }]`) is `$documents` and replaces the
    // whole stream instead.
    expect(jsmql("[ $$ = $.items.filter(x => x.qty > 0) ]")).toEqual([
      { $set: { "__jsmql.tmp.0": { $filter: { input: "$items", as: "x", cond: { $gt: ["$$x.qty", 0] } } } } },
      { $unwind: "$__jsmql.tmp.0" },
      { $replaceWith: "$__jsmql.tmp.0" },
    ]);
  });

  it("a bare field-ref RHS stays a single-doc `$replaceWith` (not provably an array)", () => {
    // `$.items` carries no compile-time type, so it is NOT fanned out — to fan
    // out a field the user writes `$$ = [...$.items]`.
    expect(jsmql("[ $ = $.items ]")).toEqual([{ $replaceWith: "$items" }]);
  });

  it("rejects an array RHS, naming the destination that takes one", () => {
    expect(() => jsmql("[ $ = [] ]")).toThrow(
      "'$ = …' replaces ONE document, and this value is an array. Name the destination that takes an array: '$$ = <array>;' makes the stream from its elements, one document per element. To keep the array as a field of this document, write '$.<field> = <array>;'.",
    );
  });

  it("rejects an array of scalar literals with the same message — the destination decides first", () => {
    expect(() => jsmql("[ $ = [1, 2] ]")).toThrow(
      "'$ = …' replaces ONE document, and this value is an array. Name the destination that takes an array: '$$ = <array>;' makes the stream from its elements, one document per element. To keep the array as a field of this document, write '$.<field> = <array>;'.",
    );
  });

  it("rejects scalar number RHS with an actionable error", () => {
    expect(() => jsmql("[ $ = 5 ]")).toThrow(
      "'$ = …' replaces the document, so the value has to BE a document — a number is not one. Put it under a field ('$ = { value: … };'), or write to a field instead ('$.value = …;').",
    );
  });

  it("rejects string RHS with an actionable error", () => {
    expect(() => jsmql('[ $ = "foo" ]')).toThrow(
      "'$ = …' replaces the document, so the value has to BE a document — a string is not one. Put it under a field ('$ = { value: … };'), or write to a field instead ('$.value = …;').",
    );
  });

  it("rejects `.filter()` lookup RHS, suggesting `.find()`", () => {
    expect(() => jsmql("[ $ = $$$.users.filter(u => u.active) ]")).toThrow(
      "The document can only become ONE document, and this chain gives an array. Write '$ = $$$.<coll>.find(pred)' for the first match, or keep the array in a field: '$.<field> = $$$.<coll>.…'.",
    );
  });

  it("rejects `delete $` with a hint pointing at `$ = …`", () => {
    expect(() => jsmql("delete $;")).toThrow(
      "'delete $' would delete the document itself. To replace it, write '$ = { … };'; to drop every field but one, write '$ = { keep: $.keep };'.",
    );
  });

  it("rejects compound increment on bare `$`", () => {
    expect(() => jsmql("$++;")).toThrow(
      "Cannot use '++' on bare '$' — it is the whole document, not a scalar. Write the field: '$.<field> ++ …' at position 0",
    );
  });

  it("rejects compound assignment on bare `$`", () => {
    expect(() => jsmql("$ += 5;")).toThrow(
      "Cannot use '+=' on bare '$' — it is the whole document, not a scalar. Write the field: '$.<field> += …' at position 0",
    );
  });

  it("validate() surfaces the rejection with a real .pos (not 0)", () => {
    const r = jsmql.validate("[ $ = [1, 2] ]");
    expect(r.valid).toBe(false);
    expect(r.errors[0].code).toBe("CODEGEN_ERROR");
    expect(r.errors[0].pos).toBeGreaterThan(0);
    expect(r.errors[0].message).toMatch(
      "'$ = …' replaces ONE document, and this value is an array. Name the destination that takes an array: '$$ = <array>;' makes the stream from its elements, one document per element. To keep the array as a field of this document, write '$.<field> = <array>;'.",
    );
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

  it("a chained-stage branch becomes the branch's stages", () => {
    expect(jsmql(`$ = { topByScore: $$.$sort({ score: -1 }).$limit(10) };`)).toEqual([
      { $facet: { topByScore: [{ $sort: { score: -1 } }, { $limit: 10 }] } },
    ]);
  });

  it("a `.filter` branch takes a JavaScript predicate — a stage in its block is rejected", () => {
    expect(() => jsmql(`$ = { topByScore: $$.filter(o => { $sort({ score: -1 }); $limit(10); }) };`)).toThrow(
      "`$sort(...)` is a pipeline stage, not part of a callback — a callback's block holds declarations and a 'return'. Move the stages to '.aggregate((o) => { $sort(...); … })', the one method whose block is a list of stages. Over the stream a stage is also a chain link: '$$.$sort(…)'. at position 35",
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
                    { $ne: [{ $ifNull: ["$active", null] }, null] },
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

  it("rejects `$.<field>` inside the predicate with a 'use lambda param' hint", () => {
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

  it("rejects mixed-shape RHS where some values aren't `$$.filter(...)`", () => {
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
                    { $ne: [{ $ifNull: ["$active", null] }, null] },
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
      "A read of another DATABASE isn't supported: '$lookup' and '$unionWith' reach the current database only (the '{ db, coll }' form is Atlas Data Federation's). Drop the '$$$$.<db>.' prefix — '$$$.<coll>' — and run the pipeline against that database. Cross-database WRITES work: '$$$$.<db>.<coll> = $$'.",
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

  it("root `$.<field>` read inside a source-switch `.map` body → 'outer document is gone' error", () => {
    // Not the generic "use the param" hint — here `o.length` would be the
    // SWITCHED collection's field, not the original root's, so that hint misleads.
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

  it("a top-level `$$.map` keeps the plain 'use the param' hint (not a source-switch)", () => {
    // No source-switch here, so the source-switch guidance must NOT leak in.
    expect(jsmql(`$$ = $$.map(o => ({ v: $.x }));`)).toEqual([{ $replaceWith: { v: "$x" } }]);
    expect(() => jsmql(`$$ = $$.map(o => ({ v: $.x }));`)).not.toThrow(/source-switch|correlate with/);
  });

  it("`$$ = []` lowers to `$match: { $expr: false }` (drop all docs)", () => {
    // The natural sugar for "empty the stream".
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

  it("rejects `$$ = <ternary>` (conditional stream branching is not a supported form)", () => {
    expect(() => jsmql(`$$ = true ? $$.filter(o => o.x) : $$.filter(o => o.y);`)).toThrow(CHAIN);
  });

  it("rejects `$$ = $$$.<coll>.find(...)` and points at the `.slice(0, 1)` / `$ = $$$.<coll>.find` alternatives", () => {
    expect(() => jsmql(`$$ = $$$.users.find(u => u.active);`)).toThrow(
      "'.find(…)' gives ONE document, and the stream is many. Write '$$ = $$$.<coll>.filter(pred).take(1)' for a stream of the first match, or '$ = $$$.<coll>.find(pred)' to make each document the one it finds.",
    );
  });

  it("`$$ = $$.map(d => <expr>)` lowers to `$replaceWith` via the stream-method registry", () => {
    expect(jsmql(`$$ = $$.map(t => ({ x: t.x }));`)).toEqual([{ $replaceWith: { x: "$x" } }]);
  });

  it("rejects `$.<field>` inside the predicate with a 'use lambda param' hint", () => {
    expect(jsmql(`$$ = $$.filter(t => $.x > 5);`)).toEqual([{ $match: { x: { $gt: 5 } } }]);
  });

  it("rejects bare `$$$.<coll>` on the RHS (no stream method)", () => {
    // The user named a collection but didn't call a stream method — the catch-all
    // path names both supported forms and notes any stream method may head the chain.
    expect(jsmql(`$$ = $$$.transactions;`)).toEqual([{ $match: { $expr: false } }, { $unionWith: "transactions" }]);
  });

  it("validate() reports `$$ = []` as valid (now lowers cleanly to $match: { $expr: false })", () => {
    const r = jsmql.validate(`$$ = [];`);
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });
});

// A lone `$$ = <expr>` with no trailing `;` parses as a one-op UpdateFilter, and
// the stream target is a stage of its own wherever it stands: `writeStages`
// (src/compiler/emit/statement.ts) reads it the same way it reads the `;`-terminated
// run, exactly as the sister `$ = <expr>` sugar is read — so the no-`;` form is
// byte-identical to the `;`-terminated one.
describe("replace stream (`$$ = <expr>`) — single statement without a trailing `;`", () => {
  it("`$$ = $$.filter(p)` lowers to `$match`, same as the `;` form", () => {
    expect(jsmql(`$$ = $$.filter({ a: 1 })`)).toEqual([{ $match: { a: 1 } }]);
    expect(jsmql(`$$ = $$.filter({ a: 1 })`)).toEqual([{ $match: { a: 1 } }]);
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
    // Same `$set`-flush rule the `;` form documents: the buffer flushes on either
    // side of `$$ = …`, never one merged `$set` straddling it.
    expect(jsmql(`$.a = 1, $$ = $$.filter({ b: 2 })`)).toEqual([{ $set: { a: 1 } }, { $match: { b: 2 } }]);
    expect(jsmql(`$$ = $$.filter({ b: 2 }), $.a = 1`)).toEqual([{ $match: { b: 2 } }, { $set: { a: 1 } }]);
  });

  it("an unsupported RHS reaches its actionable rejection with a real `.pos`", () => {
    // An unsupported RHS is a worded refusal carrying the offending node's own
    // position, never an internal error at pos 0 — `.validate()` has to have
    // something to underline. Both spellings land on the same message and offset.
    const noSemi = jsmql.validate(`$$ = 5`);
    expect(noSemi.valid).toBe(false);
    expect(noSemi.errors[0].message).toMatch(MSG);
    expect(noSemi.errors[0].pos).toBe(5);
    expect(noSemi.errors).toEqual([{ message: MSG, pos: 5, code: "CODEGEN_ERROR" }]);
  });

  it("never reaches the internal-error path", () => {
    for (const src of [`$$ = $$.filter({ a: 1 })`, `$$ = $$.map(x => x.a)`, `$$ = []`, `$$ = 5`, `$$ = $$$.t`]) {
      const r = jsmql.validate(src);
      for (const e of r.errors) expect(e.message).not.toMatch(/internal error/);
    }
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
      { $lookup: { from: "users", localField: "userId", foreignField: "_id", as: "__jsmql.tmp.0" } },
      { $unwind: "$__jsmql.tmp.0" },
      { $replaceWith: "$__jsmql.tmp.0" },
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
    // The killer DX case: "for each outer doc, give me the foreign coll
    // filtered + sorted + top-N as the new stream root". One JS chain.
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
    // The mapped result becomes the new document stream, so it must be a document.
    // An object-literal body is fine: $replaceWith the reshaped doc in the sub-pipeline,
    // then $unwind + $replaceWith explode the array into the stream. Verified on mongod.
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

  it("a value-collapsing .map (scalar field / non-object arrow) is rejected — a stream can't hold scalars", () => {
    // A document stream can't be made of scalars; without a value-mode target to peel
    // to (unlike the `$.field = …` assignment form) this must be rejected, not emit the
    // runtime-invalid scalar `$replaceWith` (mongod Location40228).
    expect(() => jsmql(`$$ = $$$.orders.filter(o => o.userId === $._id).map("productId");`)).toThrow(
      "'.map()' makes a value, and the stream must stay documents. Assign the value to a field instead: '$.<field> = $$$.<coll>.….map()'.",
    );
    expect(() => jsmql(`$$ = $$$.orders.filter(o => o.userId === $._id).map(o => o.productId);`)).toThrow(
      "'.map()' makes a value, and the stream must stay documents. Assign the value to a field instead: '$.<field> = $$$.<coll>.….map()'.",
    );
    // Non-terminal collapsing map (followed by a stream method) is rejected too.
    expect(() => jsmql(`$$ = $$$.orders.filter(o => o.userId === $._id).map("productId").take(5);`)).toThrow(
      "'.map()' makes a value, and the stream must stay documents. Assign the value to a field instead: '$.<field> = $$$.<coll>.….map()'.",
    );
  });

  it("cross-database correlated pivot ($$$$.<db>.<coll>) is rejected", () => {
    // A correlated predicate takes the `$lookup` branch of `joinStream`
    // (src/compiler/emit/join.ts) — a different road from the uncorrelated
    // source-switch (the union branch, covered in the "replace stream" describe).
    // Distinct path → own test.
    expect(() => jsmql(`$$ = $$$$.analytics.events.filter(e => e.userId === $._id);`)).toThrow(
      "A read of another DATABASE isn't supported: '$lookup' and '$unionWith' reach the current database only (the '{ db, coll }' form is Atlas Data Federation's). Drop the '$$$$.<db>.' prefix — '$$$.<coll>' — and run the pipeline against that database. Cross-database WRITES work: '$$$$.<db>.<coll> = $$'.",
    );
  });

  it("a value-collapsing terminal (.head/.size/…) is value-position-only — pivot & bare-statement throw, assignment is OK", () => {
    // `.head()` collapses the stream to a single value — like `.map(o => o.x)`, it
    // pivots to value-mode. Valid only where a value is expected.
    // 1. `$$ = …head()` — a value isn't a stream.
    expect(() => jsmql("$$ = $$$.orders.head();")).toThrow(
      "'.head()' makes a value, and the stream must stay documents. Assign the value to a field instead: '$.<field> = $$$.<coll>.….head()'.",
    );
    // 2. `$$ = …take(1)` — take returns a stream, so it's fine (contrast).
    expect(jsmql("$$ = $$$.orders.take(1);")).toEqual([
      { $match: { $expr: false } },
      { $unionWith: { coll: "orders", pipeline: [{ $limit: 1 }] } },
    ]);
    // 3. Bare statement — a value isn't a pipeline stage.
    expect(() => jsmql("$$$.orders.head();")).toThrow(
      "Reading another collection produces a value, and this statement gives it no destination. Assign it to a field ('$.<field> = $$$.<coll>.…'), bind it ('let x = $$$.<coll>.…'), or make it the stream ('$$ = $$$.<coll>.…').",
    );
    // 4. Assignment — value-mode over ALL orders (implicit match-all $lookup + $first).
    expect(jsmql("$.field = $$$.orders.head();")).toEqual([
      { $lookup: { from: "orders", pipeline: [], as: "__jsmql.tmp.0" } },
      { $set: { field: { $first: "$__jsmql.tmp.0" } } },
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
      expect(() => jsmql(`$$ = $$$.orders.filter(o => o.userId === $._id).${term};`)).toThrow(
        /makes a value|returns a single value/,
      );
      // …but the same chain in a value position compiles.
      expect(() => jsmql(`$.f = $$$.orders.filter(o => o.userId === $._id).${term};`)).not.toThrow();
    }
  });

  it("keyBy/countBy/groupBy collapse to a lodash object and are valid as a `$$ =` pivot", () => {
    // All three collapse to the lodash object and work as a stream pivot, matching
    // their value-position meaning. Each ends in `$replaceWith: { $arrayToObject }`.
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
    expect(JSON.stringify(stages)).toContain("$arrayToObject");
    // keyBy and the bare-key groupBy collapse the same way.
    for (const term of ['keyBy("status")', 'groupBy("status")']) {
      const s = jsmql(`$.g = $$$.orders.filter(o => o.userId === $._id).${term};`) as Record<string, unknown>[];
      expect(JSON.stringify(s)).toContain("$arrayToObject");
    }
  });

  it("rejects an array/string/number method chained on a `.find()` lookup (a single document)", () => {
    // `.find` yields ONE document; an array/string/number method on it is impossible.
    expect(() => jsmql(`$.out = $$$.orders.find(o => o.userId === $._id).take(5);`)).toThrow(
      "'.take()' is not available on a 'object' — it is defined on 'array', 'stream'.",
    );
    expect(() => jsmql(`$.out = $$$.orders.find(o => o.userId === $._id).map(o => o.total);`)).toThrow(
      "'.map()' is not available on a 'object' — it is defined on 'array', 'stream'.",
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
    // `user` is a let-binding (the whole user object). `user._id` resolves
    // to the materialised path `__jsmql.var.user._id`. Still a single ===, so
    // basic form fires.
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
          as: "__jsmql.tmp.0",
        },
      },
      { $unwind: "$__jsmql.tmp.0" },
      { $replaceWith: "$__jsmql.tmp.0" },
    ]);
  });

  it("a non-filter stream head still throws for a value-terminal (single value isn't a stream) in a pivot", () => {
    // Correlating filter routes to the pivot; a trailing value-terminal can't lower
    // into a stream — rejected (not silently dropped).
    expect(() => jsmql("$$ = $$$.orders.toSorted({ createdAt: -1 }).filter(o => o.userId === $._id).size();")).toThrow(
      "'.size()' makes a value, and the stream must stay documents. Assign the value to a field instead: '$.<field> = $$$.<coll>.….size()'.",
    );
  });

  it("correlation via a non-filter method only (no correlating .filter) stays a footgun-guarded rejection", () => {
    // A `.map` reading the outer doc with no filter to bound the foreign set is a
    // cross-join footgun — kept rejected with the 'correlate with a .filter' guidance.
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
    // `.filter({ userId: $._id })` — the shorthand's `$.` correlation must be detected
    // and correlated via `let`, never emitted as `$match: { userId: "$_id" }` (which in a
    // query document matches the literal string "$_id"). Verified on a live mongod.
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
  // Must-be-first (literal forms; the sugar forms are covered in system-stages.test.ts).
  it("rejects a diagnostic source stage that isn't first", () => {
    expect(() => jsmql("[ $match($.x > 1), { $collStats: {} } ]")).toThrow(
      "'$collStats' produces the pipeline's source documents, so it has to be the FIRST stage — the server refuses it anywhere else. Move it to the top of the program.",
    );
  });
  it("rejects $geoNear that isn't first", () => {
    expect(() => jsmql("[ $sort({ x: 1 }), { $geoNear: { near: [0, 0], distanceField: 'd' } } ]")).toThrow(
      "'$geoNear' produces the pipeline's source documents, so it has to be the FIRST stage — the server refuses it anywhere else. Move it to the top of the program.",
    );
  });
  it("rejects $changeStream that isn't first (;-form)", () => {
    expect(() => jsmql("$match($.x > 1); { $changeStream: {} }")).toThrow(
      "'$changeStream' produces the pipeline's source documents, so it has to be the FIRST stage — the server refuses it anywhere else. Move it to the top of the program.",
    );
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
    expect(() => jsmql("[ { $merge: 'archive' }, $sort({ x: 1 }) ]")).toThrow(
      "Nothing can follow '$merge': it writes the pipeline's output and the server requires it last. Move this statement above it.",
    );
  });
  it("rejects $out (literal) that isn't last", () => {
    expect(() => jsmql("[ { $out: 'c' }, $count('n') ]")).toThrow(
      "Nothing can follow '$out': it writes the pipeline's output and the server requires it last. Move this statement above it.",
    );
  });
  it("rejects $changeStreamSplitLargeEvent that isn't last", () => {
    expect(() => jsmql("[ { $changeStreamSplitLargeEvent: {} }, $sort({ x: 1 }) ]")).toThrow(
      "Nothing can follow '$changeStreamSplitLargeEvent': it writes the pipeline's output and the server requires it last. Move this statement above it.",
    );
  });
  it("accepts $merge as the last stage", () => {
    expect(jsmql("[ $sort({ x: 1 }), { $merge: 'archive' } ]")).toEqual([{ $sort: { x: 1 } }, { $merge: "archive" }]);
  });

  // A chain link is as much a "next stage" as the next statement is, so the
  // terminal guard has to fire between links too — mongod rejects anything
  // after $out/$merge however the source spelled it.
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

  // Uniqueness falls out of must-first / must-last.
  it("rejects two terminal stages (the first isn't last)", () => {
    expect(() => jsmql("[ { $out: 'a' }, { $merge: 'b' } ]")).toThrow(
      "Nothing can follow '$out': it writes the pipeline's output and the server requires it last. Move this statement above it.",
    );
  });
  it("rejects two source stages (the second isn't first)", () => {
    expect(() => jsmql("[ { $collStats: {} }, { $indexStats: {} } ]")).toThrow(
      "'$indexStats' produces the pipeline's source documents, so it has to be the FIRST stage — the server refuses it anywhere else. Move it to the top of the program.",
    );
  });

  // Forbidden-in-sub-pipeline (literal sub-pipeline arrays).
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
  it("rejects $geoNear that isn't first WITHIN a $lookup sub-pipeline", () => {
    expect(() =>
      jsmql(
        "[ { $lookup: { from: 'c', as: 'r', pipeline: [ $match($.a > 0), { $geoNear: { near: [0, 0], distanceField: 'd' } } ] } } ]",
      ),
    ).toThrow(
      "'$geoNear' produces the pipeline's source documents, so it has to be the FIRST stage — the server refuses it anywhere else. Move it to the top of the program.",
    );
  });

  // A value in the stage's own body may need a STAGE of its own — `$$.length` a
  // `$setWindowFields`, a `$$$.<coll>` read a `$lookup` — and jsmql places that
  // stage directly ahead of the one that reads it. Ahead of a first-only stage
  // there is no room, and the server says so: MEASURED, "$geoNear was not the
  // first stage in the pipeline after optimization".
  it("rejects a first-only stage whose body needs a stage of its own ahead of it", () => {
    expect(() => jsmql('$geoNear({ near: [1, 2], distanceField: "d", query: { n: $$.length } });')).toThrow(
      /'\$geoNear' has to be the FIRST stage of the pipeline, and a value in its body needs a '\$setWindowFields' stage of its own to run BEFORE it\..*\$geoNear\(\{ … \}\); \$match\(\$\.<field> === \$\$\.length\);/s,
    );
    // the message names the stage jsmql actually had to make, and the value that makes it
    expect(() =>
      jsmql('$geoNear({ near: [1, 2], distanceField: "d", query: { n: $$$.p.find({ _id: $.pid }).n } });'),
    ).toThrow(/needs a '\$lookup' stage of its own.*\$\$\$\.<coll>\.find\(\{ … \}\)\.<field>/s);
    // a SETTING has no later-statement form at all, so the message names the other way out
    expect(() => jsmql('$geoNear({ near: [1, 2], distanceField: "d", maxDistance: $$.length });')).toThrow(
      /give it a constant or a 'jsmql\.compile' parameter/,
    );
    // the same for a source stage, and for the array-reducer road, whose `$match` is
    // placed after its predicate is lowered
    expect(() => jsmql("$documents([{ n: $$.length }]);")).toThrow(/'\$documents' has to be the FIRST stage/);
    expect(() =>
      jsmql('$$.reduce((acc, d) => $text({ $search: "x" }) && d.n === $$.length ? acc.concat(d) : acc, []);'),
    ).toThrow(/needs a '\$setWindowFields' stage of its own/);
  });

  // The rule can belong to an OPERATOR the body holds rather than to the stage.
  it("rejects a first-only OPERATOR whose $match body needs a stage of its own", () => {
    expect(() => jsmql('$match({ $text: { $search: "x" }, n: $$.length });')).toThrow(
      /'\$text' only runs in the pipeline's FIRST '\$match'.*\$match\(\$text\(…\)\); \$match\(\$\.<field> === \$\$\.length\);/s,
    );
    // the alternative the message names does compile
    expect(jsmql('$match($text({ $search: "x" })); $match($.n === $$.length);')).toEqual([
      { $match: { $text: { $search: "x" } } },
      { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
      { $match: { $expr: { $eq: ["$n", "$__jsmql.length"] } } },
      { $unset: "__jsmql" },
    ]);
  });

  // A first-only stage inside a SUB-pipeline is first where IT stands, and a hoist
  // on the outer chain leaves that body's order alone — measured, the server runs it.
  it("keeps a first-only stage in a sub-pipeline when the OUTER chain hoists", () => {
    expect(
      jsmql(
        '$lookup({ from: "p", as: "o", pipeline: [$geoNear({ near: [1, 2], distanceField: "d", query: { n: $$.length } })] });',
      ),
    ).toEqual([
      { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
      {
        $lookup: {
          from: "p",
          as: "o",
          pipeline: [
            { $geoNear: { near: [1, 2], distanceField: "d", query: { $expr: { $eq: ["$n", "$$jsmql_s0_length"] } } } },
          ],
          let: { jsmql_s0_length: "$__jsmql.length" },
        },
      },
      { $unset: "__jsmql" },
    ]);
    // the join-chain spelling of the same lowering answers the same document
    expect(jsmql('$.o = $$$.p.$geoNear({ near: [1, 2], distanceField: "d", query: { n: $$.length } });')).toEqual([
      { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
      {
        $lookup: {
          from: "p",
          let: { jsmql_s0_length: "$__jsmql.length" },
          pipeline: [
            { $geoNear: { near: [1, 2], distanceField: "d", query: { $expr: { $eq: ["$n", "$$jsmql_s0_length"] } } } },
          ],
          as: "o",
        },
      },
      { $unset: "__jsmql" },
    ]);
  });

  // The mirror: the `__jsmql` cleanup is the stage before the one that writes the
  // output, and nothing may follow that one — so a body reading a scratch field
  // reads one already gone. MEASURED: "Use of undefined variable: v".
  it("rejects a terminal stage whose body reads a materialised value", () => {
    expect(() => jsmql('$merge({ into: "c", let: { v: $$.length }, whenMatched: [$set({ z: "$$v" })] });')).toThrow(
      /'\$merge' writes the pipeline's output and has to be its LAST stage.*\$\.n = \$\$\.length; \$merge\(/s,
    );
    // the alternative the message names does compile
    expect(
      jsmql('$.n = $$.length; $merge({ into: "c", let: { v: $.n }, whenMatched: [$set({ z: "$$v" })] });'),
    ).toEqual([
      { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
      { $set: { n: "$__jsmql.length" } },
      { $unset: "__jsmql" },
      { $merge: { into: "c", let: { v: "$n" }, whenMatched: [{ $set: { z: "$$v" } }] } },
    ]);
    // The guard reads a field PATH, not the namespace's NAME: a collection called
    // `__jsmqlArchive` is a name `$out` takes as written, and a read carries the `$`.
    expect(jsmql('$$$["__jsmqlArchive"] = $$;')).toEqual([{ $out: "__jsmqlArchive" }]);
    // a `$merge` `let` reading a real field of the document is untouched
    expect(jsmql('$merge({ into: "c", let: { v: $.n }, whenMatched: [$set({ z: "$$v" })] });')).toEqual([
      { $merge: { into: "c", let: { v: "$n" }, whenMatched: [{ $set: { z: "$$v" } }] } },
    ]);
  });

  // A first-only stage inside a body the row files as a PIPELINE of its own is first
  // where IT stands. `first` and the pending hoist are facts about the OUTER pipeline
  // and say nothing about that one — MEASURED, the server runs both of these.
  it("keeps a first-only stage in a sub-pipeline, whatever stands ahead of the container", () => {
    expect(
      jsmql('$.b = 2; $lookup({ from: "c", as: "o", pipeline: [$geoNear({ near: [0, 0], distanceField: "d" })] });'),
    ).toEqual([
      { $set: { b: 2 } },
      { $lookup: { from: "c", as: "o", pipeline: [{ $geoNear: { near: [0, 0], distanceField: "d" } }] } },
    ]);
    // the same for `$unionWith` and a `$facet` branch, the other rows that state it
    expect(
      jsmql('$.b = 2; $unionWith({ coll: "c", pipeline: [$geoNear({ near: [0, 0], distanceField: "d" })] });'),
    ).toEqual([
      { $set: { b: 2 } },
      { $unionWith: { coll: "c", pipeline: [{ $geoNear: { near: [0, 0], distanceField: "d" } }] } },
    ]);
    // and it is still refused where it is NOT first of that pipeline
    expect(() =>
      jsmql(
        '$lookup({ from: "c", as: "o", pipeline: [$sort({ a: 1 }), $geoNear({ near: [0, 0], distanceField: "d" })] });',
      ),
    ).toThrow(/'\$geoNear' produces the pipeline's source documents/);
  });

  // `$merge.whenMatched` is an UPDATE, not a pipeline: no first position, and a
  // closed set of stages. The `$merge` row states the set; the server's own answer
  // is compared against it in compiler-statement.test.ts.
  it("refuses a stage an update spec does not run, wherever the $merge stands", () => {
    const refused = /cannot stand inside '\$merge': that body is an UPDATE, not a pipeline/;
    expect(() => jsmql('$merge({ into: "c", whenMatched: [$sort({ a: 1 })] });')).toThrow(refused);
    expect(() => jsmql('$.b = 2; $merge({ into: "c", whenMatched: [$sort({ a: 1 })] });')).toThrow(refused);
    expect(() =>
      jsmql('$merge({ into: "c", whenMatched: [$geoNear({ near: [0, 0], distanceField: "d" })] });'),
    ).toThrow(refused);
    // the message names every stage the server does run there
    expect(() => jsmql('$merge({ into: "c", whenMatched: [$match($.a > 1)] });')).toThrow(
      /'\$addFields', '\$set', '\$project', '\$unset', '\$replaceRoot', '\$replaceWith' and '\$fill'/,
    );
    // and each of those compiles
    expect(jsmql('$merge({ into: "c", whenMatched: [$set({ z: 9 })] });')).toEqual([
      { $merge: { into: "c", whenMatched: [{ $set: { z: 9 } }] } },
    ]);
    expect(jsmql('$merge({ into: "c", whenMatched: [$fill({ output: { a: { value: 0 } } })] });')).toEqual([
      { $merge: { into: "c", whenMatched: [{ $fill: { output: { a: { value: 0 } } } }] } },
    ]);
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

// ── Chained stage calls: `<stream>.$match(<body>)` ───────────────────────────
// The chain-position spelling of the `$match(<body>);` statement. See
// docs/specs/aggregation-stages.md § chained stage calls.
describe("chained stage calls on the current stream", () => {
  it("lowers a chain of stage links to the same stages as the statement form", () => {
    expect(jsmql("$$.$match({ status: 'shipped' }).$sort({ total: -1 }).$limit(5);")).toEqual([
      { $match: { status: "shipped" } },
      { $sort: { total: -1 } },
      { $limit: 5 },
    ]);
  });

  // THE EQUIVALENCE: a stage link is defined as its statement form, so the two
  // spellings must be byte-identical for every stage. Guarding it here keeps
  // the two paths from drifting apart.
  it("is byte-identical to the `;`-separated statement spelling", () => {
    const chained = jsmql("$$.$match({ status: 'shipped' }).$sort({ total: -1 }).$limit(5);");
    const statements = jsmql("$match({ status: 'shipped' }); $sort({ total: -1 }); $limit(5);");
    expect(chained).toEqual([{ $match: { status: "shipped" } }, { $sort: { total: -1 } }, { $limit: 5 }]);
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

  // A stage link pushes into the SAME buffer the registry methods use, so a
  // stage-coupled method sees it — `.takeWhile` reads the buffer to insist on a
  // preceding sort.
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

  // A reshaping stage link drops in-scope `let`s, and reports the real stage
  // name — registry chain methods have always reported `$unionWith` here.
  it("a reshaping stage link clears the let scope, naming itself", () => {
    expect(() => jsmql("let n = $.qty * 2; $$.$group({ _id: '$a' }); $set({ x: n });")).toThrow(
      /`n` is a `let` binding and can't be read after `\$group`/,
    );
  });

  describe("errors", () => {
    it("rejects an unknown stage name with a suggestion", () => {
      expect(() => jsmql("$$.$prject({ a: 1 });")).toThrow(
        "'.$prject()' is not a method of the stream '$$'. Did you mean '.$project()'? A stage is a link too: '$$.$match(…)'.",
      );
    });

    it("rejects an expression operator chained as a stage", () => {
      expect(() => jsmql("$$.$abs(1);")).toThrow(
        "'$abs' is an expression operator, not a stage. A chain link is a stage ('$$.$match(…)') or a method ('.filter(…)'); to use its value, assign it to a field: '$.<field> = $abs(…);'",
      );
    });

    it("rejects the wrong argument count", () => {
      expect(() => jsmql("$$.$limit();")).toThrow("'.$limit(body)' requires exactly 1 argument, got 0");
      expect(() => jsmql("$$.$limit(5, 6);")).toThrow("'.$limit(body)' requires exactly 1 argument, got 2");
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
        "'$match' is a pipeline stage, not an expression — MongoDB has no '$match' expression operator, so '{ $match: … }' in a value position is rejected by the server. Write it as a pipeline statement ('$match(…);') or as a chain link ('$$.$match(…)'). For the value-position equivalent, use '$filter(…)'.",
      );
    });

    it("rejects a stage link after the chain has collapsed to a value", () => {
      expect(() => jsmql("$.out = $$$.orders.filter({ a: 1 }).map('x').uniq().$limit(5);")).toThrow(
        "'$limit' is a pipeline stage, not an expression — MongoDB has no '$limit' expression operator, so '{ $limit: … }' in a value position is rejected by the server. Write it as a pipeline statement ('$limit(…);') or as a chain link ('$$.$limit(…)'). For the value-position equivalent, use '$slice(…)'.",
      );
    });
  });
});

// HR3: mongod rejects `$out` / `$merge` in ANY sub-pipeline (Location51047), and
// each diagnostic stage in exactly one container. Both come from `forbiddenIn` in the
// registry, judged against the boundaries the Env records on the way into a
// sub-pipeline — so a stage written inside an `.aggregate` block is named as
// precisely as the chained-stage spelling is.
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

  // A value-collapsing terminal keeps its own, more specific message.
  it("leaves the value-terminal message alone", () => {
    expect(() => jsmql("$$$.orders.head();")).toThrow(
      "Reading another collection produces a value, and this statement gives it no destination. Assign it to a field ('$.<field> = $$$.<coll>.…'), bind it ('let x = $$$.<coll>.…'), or make it the stream ('$$ = $$$.<coll>.…').",
    );
  });

  // The contrast the message calls out: a `$$` chain needs no destination.
  it("a bare `$$` chain still works — it transforms the current stream", () => {
    expect(jsmql("$$.$match({ a: 1 });")).toEqual([{ $match: { a: 1 } }]);
  });
});

// A `$facet` branch is a `$$` stream like any other container, so it takes the
// whole chain vocabulary — stage links included, not only `.filter(<arrow>)`.
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

  // Placement is validated against the facet container.
  it("rejects a write stage in a branch, naming $facet", () => {
    expect(() => jsmql('$ = { k: $$.$out("x") };')).toThrow(
      "'$out' cannot stand inside '$facet' — the server refuses it in that body. Run it as a stage of the outer pipeline instead.",
    );
  });

  // A plain object RHS is still a $replaceWith, not a one-branch facet.
  it("leaves a non-chain object RHS as $replaceWith", () => {
    expect(jsmql("$ = { a: 1, b: 2 };")).toEqual([{ $replaceWith: { a: 1, b: 2 } }]);
  });
});

// One predicate position, one vocabulary: every container that lowers a local
// `$$.filter(...)` / `$$.reject(...)` reads the same spellings, because the
// `iterateeShorthand` rule (src/compiler/passes/desugar.ts) rewrites a matches-object,
// a field name and a ["field", value] pair to the arrow they mean before any container
// sees them, and the `predicate` service (src/compiler/emit/inputs.ts) lowers that one
// arrow. So which spelling you write never changes the emitted MQL.
describe("`$$` predicate spellings are interchangeable in every container", () => {
  // Each spelling means exactly `o => o.a === 1`, so each must emit exactly `$match: { a: 1 }`.
  const SPELLINGS = [
    ["arrow", "$$.filter(o => o.a === 1)"],
    // The same JavaScript function as the arrow above, so it must lower identically.
    ["block body returning the predicate", "$$.filter(o => { return o.a === 1; })"],
    ["matches-object", "$$.filter({ a: 1 })"],
    ['["field", value] pair', '$$.filter(["a", 1])'],
  ] as const;
  // Each container, and the stages its predicate is expected to produce.
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

  // The bug that made the spellings observably different rather than merely
  // unevenly supported: a matches-object value that isn't a constant. The raw-query
  // path emitted the aggregation operator into query position, where it is invalid.
  it("a non-constant matcher value lowers to $expr, not an invalid query operator", () => {
    for (const [container, source, expected] of CONTAINERS) {
      expect(jsmql(source("$$.filter({ a: 2 + 3 })")), container).toEqual(
        expected({ $match: { a: 5 } }), // the fold settles 2 + 3
      );
    }
  });

  // `$.<field>` is rejected in a local predicate (the param already IS the document).
  // A shorthand has only the gate's synthetic param, which must never be named back
  // at the user as if it were writable ("use `jsmqlItem.b`" is unwritable advice).
  it("rejects `$.<field>` without leaking the synthetic shorthand param", () => {
    for (const [, source] of CONTAINERS) {
      expect(() => jsmql(source("$$.filter({ a: $.b })"))).not.toThrow();
      expect(() => jsmql(source("$$.filter({ a: $.b })"))).not.toThrow(/jsmqlItem/);
    }
  });
});

// A predicate error names the receiver the developer wrote. The `$$ = $$$.<coll>.…`
// source switch lowers its `.filter`/`.reject` through the same helpers the local
// `$$` chain uses, so the message must not fall back to `$$.filter` for a
// `$$$.<coll>.filter` call. That is not only cosmetic: the arity message tells the
// developer what to write, and `$$.filter(o => …)` reads the CURRENT stream, so
// following the wrong advice changes which collection the query reads.
describe("a predicate error names the receiver as written", () => {
  const RECEIVERS: [string, string][] = [
    ["$$", "$$"],
    ["$$$.orders", "$$$.orders"],
    ["$$$$.shop.orders", "$$$$.shop.orders"],
  ];
  for (const [label, receiver] of RECEIVERS) {
    it(`${label}: the vocabulary message names it`, () => {
      expect(() => jsmql(`$$ = ${receiver}.filter(123);`)).toThrow(/takes a predicate|another DATABASE/);
    });

    it(`${label}: the arity message advises a spelling that keeps the same source`, () => {
      expect(() => jsmql(`$$ = ${receiver}.filter((a, b) => a > b);`)).toThrow(/has no value inside|another DATABASE/);
    });

    it(`${label}: .reject keeps step with .filter`, () => {
      expect(() => jsmql(`$$ = ${receiver}.reject(123);`)).toThrow(/takes a predicate|another DATABASE/);
    });
  }

  // A non-head `.filter` reaches the argument-count message rather than the gate.
  it("names the receiver in the argument-count message too", () => {
    expect(() => jsmql("$$ = $$$.orders.take(2).filter(o => o.a, 2);")).toThrow(
      "'.filter(predicate)' requires exactly 1 argument, got 2 — JavaScript's trailing 'thisArg' has no meaning in MQL; drop it",
    );
  });
});

describe("assignment sugar inside a literal sub-pipeline array", () => {
  // This loop lowers a literal sub-pipeline and has no slot allocator to run the
  // sugar through. It rejects with the spelling that works here rather than
  // buffering the assignment into a `$set` on an empty field path.
  const wrap = (el: string) => `$lookup({ from: "o", pipeline: [${el}], as: "o" });`;

  it("rejects `$ = …` and names $replaceWith", () => {
    expect(() => jsmql(wrap("$ = { t: $.total }"))).toThrow(
      "The outer document can't be written from inside a body over another collection — only read. Write the body's own document through its callback parameter ('o.x = …', 'delete o.x', 'o = { … }'), or as a stage ('$set({ x: … })'); write the outer field after the join.",
    );
  });

  it("rejects `$$ = …` and names $match", () => {
    expect(() => jsmql(wrap("$$ = $$.filter(d => d.a > 1)"))).toThrow(/\$match/);
  });

  it("rejects a collection write without an internal error", () => {
    expect(() => jsmql(wrap("$$$.arch = $$"))).toThrow(
      "'$out' cannot stand inside '$lookup' — the server refuses it in that body. Run it as a stage of the outer pipeline instead.",
    );
    expect(() => jsmql(wrap("$$$.arch = $$"))).not.toThrow(/internal error/);
  });

  it("still lowers an ordinary field assignment", () => {
    expect(() => jsmql(wrap("$.a = 1"))).toThrow(
      "The outer document can't be written from inside a body over another collection — only read. Write the body's own document through its callback parameter ('o.x = …', 'delete o.x', 'o = { … }'), or as a stage ('$set({ x: … })'); write the outer field after the join.",
    );
  });
});

describe("a lookup inside a literal sub-pipeline array", () => {
  // Hoisting is what makes it wrong: the `$lookup` would land in the outer pipeline while
  // the reference to its result stayed inside, where the stream is a different collection
  // whose documents never carry the outer scratch slot. The field would read as missing, on
  // every document, silently.
  const NAMES = /isn't available inside a literal sub-pipeline array|can't be written|no destination|has no 'let'/;
  it("is rejected in every sub-pipeline container", () => {
    expect(() => jsmql('$unionWith({ coll: "c", pipeline: [$.o = $$$.orders.find(o => o.uid === 1)] });')).toThrow(
      NAMES,
    );
    expect(() => jsmql('$lookup({ from: "o", pipeline: [$.x = $$$.items.find(i => i.k === 1)], as: "o" });')).toThrow(
      NAMES,
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

  it("still hoists out of an ORDINARY stage body", () => {
    // The fix is about a sub-pipeline being another pipeline's scope, not about hoisting.
    expect(jsmql("$project({ o: $$$.orders.find(o => o.uid === 1) });")).toEqual([
      { $lookup: { from: "orders", pipeline: [{ $match: { uid: 1 } }, { $limit: 1 }], as: "__jsmql.tmp.0" } },
      { $set: { "__jsmql.tmp.0": { $first: "$__jsmql.tmp.0" } } },
      { $project: { o: "$__jsmql.tmp.0" } },
      { $unset: "__jsmql" },
    ]);
  });
});

describe("jsmql() and jsmql.pipeline() agree on the lookup form", () => {
  // A strict-shape entry rejects input that would lower to the OTHER shape. This input
  // lowers to a Pipeline, which is the shape `jsmql.pipeline` asks for — but the lookup form
  // was missing from its reroute list, so the same source compiled through `jsmql()` and
  // threw through `jsmql.pipeline()`.
  const SRC = "$.o = $$$.orders.find(o => o.uid === 1)";
  const EXPECTED = [
    { $lookup: { from: "orders", pipeline: [{ $match: { uid: 1 } }], as: "o" } },
    { $set: { o: { $first: "$o" } } },
  ];
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
      "'$$$.<coll>' (a read of another collection) needs Pipeline mode — it materialises a '$lookup' stage. Use it inside a pipeline (e.g. `({ $ }) => { $.n = $$$.<coll>.filter(…).length; }`); it has no meaning in a Filter or in 'jsmql.expr'.",
    );
  });
});
