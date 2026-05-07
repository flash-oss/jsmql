import { describe, it, expect } from "vitest";
import { mjsql, validate, mql } from "../src/index.ts";

describe("pipeline detection", () => {
  it("compiles a single-stage pipeline as an array", () => {
    expect(mjsql("[ { $limit: 10 } ]")).toEqual([{ $limit: 10 }]);
  });

  it("non-stage array still compiles as expression-mode array literal", () => {
    expect(mjsql("[1, 2, 3]")).toEqual([1, 2, 3]);
  });

  it("array of mixed scalars and unrelated objects stays expression-mode", () => {
    // First element isn't a stage shape, so the whole array is treated as a
    // value array. We get whatever the codegen would normally produce.
    expect(mjsql("[1, { $limit: 10 }]")).toEqual([1, { $limit: 10 }]);
  });

  it("empty array is not a pipeline", () => {
    expect(mjsql("[]")).toEqual([]);
  });
});

describe("pipeline — stage-object form", () => {
  it("$match with expression body wraps in $expr", () => {
    expect(mjsql("[{ $match: $.age > 18 }]")).toEqual([
      { $match: { $expr: { $gt: ["$age", 18] } } },
    ]);
  });

  it("$match with object-literal body passes through as raw query doc", () => {
    expect(mjsql("[{ $match: { age: { $gt: 18 } } }]")).toEqual([{ $match: { age: { $gt: 18 } } }]);
  });

  it("$project with mixed include flags and computed fields", () => {
    expect(mjsql("[{ $project: { name: 1, total: $.price * $.qty } }]")).toEqual([
      { $project: { name: 1, total: { $multiply: ["$price", "$qty"] } } },
    ]);
  });

  it("$group with accumulator", () => {
    expect(mjsql("[{ $group: { _id: $.dept, total: $sum($.salary) } }]")).toEqual([
      { $group: { _id: "$dept", total: { $sum: "$salary" } } },
    ]);
  });

  it("$sort and $limit", () => {
    expect(mjsql("[{ $sort: { total: -1 } }, { $limit: 10 }]")).toEqual([
      { $sort: { total: -1 } },
      { $limit: 10 },
    ]);
  });

  it("$skip with a numeric scalar body", () => {
    expect(mjsql("[{ $skip: 50 }]")).toEqual([{ $skip: 50 }]);
  });

  it("$count with a string scalar body", () => {
    expect(mjsql('[{ $count: "totalDocs" }]')).toEqual([{ $count: "totalDocs" }]);
  });

  it("$unwind with a field-ref body", () => {
    expect(mjsql("[{ $unwind: $.items }]")).toEqual([{ $unwind: "$items" }]);
  });

  it("$set / $addFields are first-class stages", () => {
    expect(mjsql("[{ $set: { fullName: $.firstName + ' ' + $.lastName } }]")).toEqual([
      { $set: { fullName: { $concat: ["$firstName", " ", "$lastName"] } } },
    ]);
    expect(mjsql("[{ $addFields: { ratio: $.a / $.b } }]")).toEqual([
      { $addFields: { ratio: { $divide: ["$a", "$b"] } } },
    ]);
  });

  it("$replaceRoot and $replaceWith", () => {
    expect(mjsql("[{ $replaceRoot: { newRoot: $.user } }]")).toEqual([
      { $replaceRoot: { newRoot: "$user" } },
    ]);
    expect(mjsql("[{ $replaceWith: $.user }]")).toEqual([{ $replaceWith: "$user" }]);
  });
});

describe("pipeline — stage-call form", () => {
  it("$match expression body wraps in $expr", () => {
    expect(mjsql("[$match($.age > 18)]")).toEqual([{ $match: { $expr: { $gt: ["$age", 18] } } }]);
  });

  it("$match object-literal body is raw query doc", () => {
    expect(mjsql("[$match({ age: { $gt: 18 } })]")).toEqual([{ $match: { age: { $gt: 18 } } }]);
  });

  it("$project, $group, $sort, $limit", () => {
    expect(
      mjsql(`[
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
    expect(mjsql("[$limit(5)]")).toEqual([{ $limit: 5 }]);
    expect(mjsql("[$skip(50)]")).toEqual([{ $skip: 50 }]);
  });

  it("$unwind with field-ref arg", () => {
    expect(mjsql("[$unwind($.items)]")).toEqual([{ $unwind: "$items" }]);
  });

  it("$count with string arg", () => {
    expect(mjsql('[$count("totalDocs")]')).toEqual([{ $count: "totalDocs" }]);
  });
});

describe("pipeline — mixed forms", () => {
  it("stage-object and stage-call elements compose in one pipeline", () => {
    expect(
      mjsql(`[
        { $match: $.active === true },
        $sort({ created: -1 }),
        { $limit: 25 }
      ]`),
    ).toEqual([
      { $match: { $expr: { $eq: ["$active", true] } } },
      { $sort: { created: -1 } },
      { $limit: 25 },
    ]);
  });

  it("the two forms produce identical output for the same stage", () => {
    const a = mjsql("[$match($.age > 18)]");
    const b = mjsql("[{ $match: $.age > 18 }]");
    expect(a).toEqual(b);
  });
});

describe("pipeline — sub-pipelines", () => {
  it("$lookup recurses into the pipeline: field", () => {
    expect(
      mjsql(`[{
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
          pipeline: [{ $match: { $expr: { $eq: ["$userId", 42] } } }, { $project: { total: 1 } }],
          as: "userOrders",
        },
      },
    ]);
  });

  it("$lookup pipeline: field that is not a stage array stays as expression", () => {
    // If the value isn't pipeline-shaped, generate it normally — no error.
    expect(mjsql('[{ $lookup: { from: "x", pipeline: $.someVar, as: "y" } }]')).toEqual([
      { $lookup: { from: "x", pipeline: "$someVar", as: "y" } },
    ]);
  });

  it("$facet recurses into every value", () => {
    expect(
      mjsql(`[{
        $facet: {
          byCount: [{ $count: "n" }],
          topThree: [{ $sort: { score: -1 } }, { $limit: 3 }]
        }
      }]`),
    ).toEqual([
      {
        $facet: {
          byCount: [{ $count: "n" }],
          topThree: [{ $sort: { score: -1 } }, { $limit: 3 }],
        },
      },
    ]);
  });

  it("$unionWith recurses into pipeline:", () => {
    expect(
      mjsql(`[{ $unionWith: { coll: "archive", pipeline: [{ $match: $.year < 2020 }] } }]`),
    ).toEqual([
      {
        $unionWith: {
          coll: "archive",
          pipeline: [{ $match: { $expr: { $lt: ["$year", 2020] } } }],
        },
      },
    ]);
  });
});

describe("pipeline — error cases", () => {
  it("rejects unknown stage name with did-you-mean suggestion", () => {
    expect(() => mjsql("[{ $macth: $.age > 18 }]")).toThrow(/'\$match'/);
  });

  it("rejects unknown stage name in stage-call form", () => {
    expect(() => mjsql("[$prject({ name: 1 })]")).toThrow(/'\$project'/);
  });

  it("once first element is a stage, every element must be a stage", () => {
    expect(() => mjsql("[{ $match: $.a > 1 }, 42]")).toThrow(/Element 1/);
  });

  it("multi-key object cannot be a stage element", () => {
    expect(() => mjsql("[{ $match: { age: 1 }, $sort: { age: 1 } }]")).toThrow(
      /single-key stage object/,
    );
  });

  it("validate() surfaces pipeline errors as CODEGEN_ERROR", () => {
    const r = validate("[{ $macth: $.age > 18 }]");
    expect(r.valid).toBe(false);
    expect(r.errors[0].code).toBe("CODEGEN_ERROR");
    expect(r.errors[0].message).toMatch(/\$match/);
  });
});

describe("pipeline — mql template tag", () => {
  it("interpolates a value into a stage body", () => {
    const minAge = 18;
    const limit = 25;
    expect(mql`[ { $match: $.age > ${minAge} }, { $limit: ${limit} } ]`).toEqual([
      { $match: { $expr: { $gt: ["$age", 18] } } },
      { $limit: 25 },
    ]);
  });
});

describe("pipeline — function input", () => {
  it("compiles an arrow returning a pipeline", () => {
    expect(
      mjsql(($) => [{ $match: $.active === true }, { $sort: { created: -1 } }, { $limit: 10 }]),
    ).toEqual([
      { $match: { $expr: { $eq: ["$active", true] } } },
      { $sort: { created: -1 } },
      { $limit: 10 },
    ]);
  });
});
