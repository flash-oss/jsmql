// Phase 5 of src/compiler/ — value versus truth.
//
// The truthiness check is the shipped shape, kept exactly; the truth table it
// implements is measured on mongod against JavaScript's own `Boolean(v)` for
// every value class the language can produce (NaN excepted: not supported).

import { describe, expect, it } from "vitest";
import { MongoClient } from "mongodb";
import { and, asValue, jsTruthy, not, or, truthOf } from "../src/compiler/emit/mode.ts";
import { cond, filter, letOne, matchExpr, switchOn } from "../src/compiler/emit/mql.ts";
import type { MongoVar } from "../src/compiler/emit/names.ts";

const URI = "mongodb://127.0.0.1:27017";
async function reachable(): Promise<boolean> {
  const probe = new MongoClient(URI, { serverSelectionTimeoutMS: 700 });
  try {
    await probe.connect();
    await probe.db("admin").command({ ping: 1 });
    return true;
  } catch {
    return false;
  } finally {
    await probe.close().catch(() => {});
  }
}
const up = await reachable();

const SHIPPED_TRUTHY = {
  $and: [{ $ne: [{ $ifNull: ["$a", null] }, null] }, { $ne: ["$a", false] }, { $ne: ["$a", ""] }, { $ne: ["$a", 0] }],
};

describe("compiler/emit/mode — the truthiness check", () => {
  it("is the shipped shape, exactly", () => {
    expect(jsTruthy("$a")).toEqual(SHIPPED_TRUTHY);
  });

  it("passes a boolean-returning value through unchanged", () => {
    expect(truthOf({ $gt: ["$a", 1] }, true)).toEqual({ $gt: ["$a", 1] });
    expect(truthOf("$a", false)).toEqual(SHIPPED_TRUTHY);
  });

  it("flattens nested $and / $or, as the shipped compiler does for `a && b ? … : …`", () => {
    const t = and(jsTruthy("$a"), jsTruthy("$b"));
    expect((t as unknown as { $and: unknown[] }).$and).toHaveLength(8);
    expect(or(or(truthOf(1, true), truthOf(2, true)), truthOf(3, true))).toEqual({ $or: [1, 2, 3] });
    expect(not(truthOf({ $gt: ["$a", 1] }, true))).toEqual({ $not: { $gt: ["$a", 1] } });
    expect(asValue(jsTruthy("$a"))).toEqual(SHIPPED_TRUTHY);
  });
});

describe("compiler/emit/mql — the slots that read a condition", () => {
  const x = "x" as MongoVar;
  it("builds each shape with the Truth in its slot", () => {
    const t = truthOf({ $gt: ["$$x.n", 1] }, true);
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
    const client = new MongoClient(URI);
    await client.connect();
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
