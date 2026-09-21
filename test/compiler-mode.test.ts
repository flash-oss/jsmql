// Phase 5 of src/compiler/ — value versus truth.
//
// The truthiness check is SUBTRACTIVE over the value's proof: the four-way shape for a
// value nothing is known about, fewer tests as the proof grows. This suite measures the
// truth table the full shape implements on mongod, comparing it to JavaScript's own
// `Boolean(v)` for every value class the language can produce (NaN is not supported),
// and states what each narrower proof leaves of it.

import { describe, expect, it } from "vitest";
import { MongoClient } from "mongodb";
import { FALSE, TRUE, and, asValue, boolTruth, jsTruthy, not, or, truthOf } from "../src/compiler/emit/mode.ts";
import { ANY, arrayOf, maybeAbsent, of } from "../src/compiler/emit/type.ts";
import { cond, filter, letOne, matchExpr, switchOn } from "../src/compiler/emit/mql.ts";
import type { MongoVar } from "../src/compiler/emit/names.ts";
import { liveClientNow, liveUp } from "./fixtures/live.ts";

const up = await liveUp();

const JS_TRUTHY = {
  $and: [{ $ne: [{ $ifNull: ["$a", null] }, null] }, { $ne: ["$a", false] }, { $ne: ["$a", ""] }, { $ne: ["$a", 0] }],
};

describe("compiler/emit/mode — the truthiness check", () => {
  it("is the four-way JavaScript check, exactly", () => {
    expect(jsTruthy("$a")).toEqual(JS_TRUTHY);
  });

  it("passes a boolean-returning value through unchanged", () => {
    expect(boolTruth({ $gt: ["$a", 1] })).toEqual({ $gt: ["$a", 1] });
    expect(truthOf("$a", ANY)).toEqual(JS_TRUTHY);
  });

  it("keeps only the tests some part of the proof can fail", () => {
    // a boolean or a number is its own truth: the server reads 0, false, null and missing as false
    expect(truthOf("$a", of("bool"))).toBe("$a");
    expect(truthOf("$a", maybeAbsent(of("bool")))).toBe("$a");
    expect(truthOf("$a", of("number", true))).toBe("$a");
    // a string owes the "" test, and the null test while it may be absent
    expect(truthOf("$a", of("string"))).toEqual({ $ne: ["$a", ""] });
    expect(truthOf("$a", maybeAbsent(of("string")))).toEqual({
      $and: [{ $ne: [{ $ifNull: ["$a", null] }, null] }, { $ne: ["$a", ""] }],
    });
    // an array, an object or a date owes nothing but presence
    expect(truthOf("$a", maybeAbsent(arrayOf(ANY)))).toEqual({ $ne: [{ $ifNull: ["$a", null] }, null] });
    expect(truthOf("$a", arrayOf(ANY))).toBe(TRUE);
    expect(truthOf("$a", of("date"))).toBe(TRUE);
  });

  it("folds a constant truth through and / or / not and the slots that read one", () => {
    expect(and(TRUE, jsTruthy("$a"))).toEqual(JS_TRUTHY);
    expect(and(FALSE, jsTruthy("$a"))).toBe(FALSE);
    expect(or(TRUE, jsTruthy("$a"))).toBe(TRUE);
    expect(or(FALSE, jsTruthy("$a"))).toEqual(JS_TRUTHY);
    expect(not(TRUE)).toBe(FALSE);
    expect(cond(TRUE, 1, 2)).toBe(1);
    expect(cond(FALSE, 1, 2)).toBe(2);
    expect(filter("$items", "x" as MongoVar, TRUE)).toBe("$items");
    expect(
      switchOn(
        [
          { case: FALSE, then: 1 },
          { case: TRUE, then: 2 },
          { case: jsTruthy("$a"), then: 3 },
        ],
        4,
      ),
    ).toBe(2);
  });

  it("flattens nested $and / $or, so `a && b ? … : …` keeps one level", () => {
    const t = and(jsTruthy("$a"), jsTruthy("$b"));
    expect((t as unknown as { $and: unknown[] }).$and).toHaveLength(8);
    expect(or(or(boolTruth(1), boolTruth(2)), boolTruth(3))).toEqual({ $or: [1, 2, 3] });
    expect(not(boolTruth({ $gt: ["$a", 1] }))).toEqual({ $not: { $gt: ["$a", 1] } });
    expect(asValue(jsTruthy("$a"))).toEqual(JS_TRUTHY);
  });
});

describe("compiler/emit/mql — the slots that read a condition", () => {
  const x = "x" as MongoVar;
  it("builds each shape with the Truth in its slot", () => {
    const t = boolTruth({ $gt: ["$$x.n", 1] });
    expect(cond(t, 1, 2)).toEqual({ $cond: { if: { $gt: ["$$x.n", 1] }, then: 1, else: 2 } });
    expect(filter("$items", x, t)).toEqual({ $filter: { input: "$items", as: "x", cond: { $gt: ["$$x.n", 1] } } });
    expect(filter("$items", x, t, 3)).toEqual({
      $filter: { input: "$items", as: "x", cond: { $gt: ["$$x.n", 1] }, limit: 3 },
    });
    expect(switchOn([{ case: t, then: 1 }], "$$REMOVE")).toEqual({
      $switch: { branches: [{ case: { $gt: ["$$x.n", 1] }, then: 1 }], default: "$$REMOVE" },
    });
    expect(matchExpr(t)).toEqual({ $expr: { $gt: ["$$x.n", 1] } });
    expect(letOne(x, "$a", "$$x")).toEqual({ $let: { vars: { x: "$a" }, in: "$$x" } });
  });
});

describe.skipIf(!up)("compiler/emit/mode — the truth table, measured", () => {
  it("agrees with JavaScript's Boolean(v) for every value class but NaN", async () => {
    const client = await liveClientNow();
    try {
      const coll = client.db("jsmql_mode").collection("t");
      await coll.deleteMany({});
      const cases: [string, unknown][] = [
        ["empty string", ""],
        ["zero", 0],
        ["false", false],
        ["null", null],
        ["array", []],
        ["object", {}],
        ["string", "a"],
        ["one", 1],
        ["negative", -1],
        ["date", new Date(0)],
        ["true", true],
      ];
      await coll.insertMany([...cases.map(([label, a]) => ({ label, a })), { label: "missing" }]);
      const rows = await coll.aggregate([{ $addFields: { t: cond(jsTruthy("$a"), "T", "F") } }]).toArray();
      for (const row of rows) {
        const js = row.label === "missing" ? "F" : Boolean(row.a) ? "T" : "F";
        expect(row.t, row.label).toBe(js);
      }
    } finally {
      await client.close();
    }
  });
});
