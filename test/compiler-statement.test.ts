// Phase 5 of src/compiler/ — the statement target, end to end.
//
// A JSMQL program and the pipeline the new compiler emits. Two statements never
// merge: the `;` the developer wrote is the stage boundary and the `,` is the
// merge, so one source keeps one output. The wider net is
// scripts/diff-compilers.mjs --cur … --entry pipeline.
//
// The second describe runs every pipeline this file asserts against a live
// mongod, because a green `toEqual` proves what the compiler EMITS and never
// that the server accepts it (HR3). It self-skips (green) when no mongod is
// reachable, with an all-or-nothing guard.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoClient, type Collection } from "mongodb";
import { pipeline } from "../src/compiler/index.ts";
import { PendingLowering } from "../src/compiler/emit/errors.ts";

/** Every source the unit cases below assert, so the server sees all of them too. */
const RUNS: string[] = [];
const compiled = (src: string): unknown[] => {
  RUNS.push(src);
  return pipeline(src);
};

describe("compiler/emit/statement — the writes", () => {
  it("makes one $set per `,`-joined run, and one stage per `;`", () => {
    expect(compiled("$.a = 1;")).toEqual([{ $set: { a: 1 } }]);
    expect(compiled("$.a = 1, $.b = 2;")).toEqual([{ $set: { a: 1, b: 2 } }]);
    // The `;` is the developer's own stage boundary; nothing reads across it.
    expect(compiled("$.a = 1; $.b = 2;")).toEqual([{ $set: { a: 1 } }, { $set: { b: 2 } }]);
    expect(compiled("$.total = $.qty * $.price;")).toEqual([{ $set: { total: { $multiply: ["$qty", "$price"] } } }]);
    // A compound assignment is the operator it names.
    expect(compiled("$.a += 1;")).toEqual([{ $set: { a: { $add: ["$a", 1] } } }]);
    expect(compiled("$.a.b = 1, $.a.c = 2;")).toEqual([{ $set: { "a.b": 1, "a.c": 2 } }]);
  });

  it("ends a group where one $set would say something else", () => {
    // A later write that READS what an earlier one wrote must read the NEW value.
    expect(compiled("$.x = 1, $.z = $.x;")).toEqual([{ $set: { x: 1 } }, { $set: { z: "$x" } }]);
    expect(compiled("$.a = 1, $.b = $.a.c;")).toEqual([{ $set: { a: 1 } }, { $set: { b: "$a.c" } }]);
    // Writing what an earlier value READ needs no split: one `$set` evaluates
    // every value against the document it received.
    expect(compiled("$.a = $.b, $.b = 1;")).toEqual([{ $set: { a: "$b", b: 1 } }]);
    // The same path twice is the source saying two things.
    expect(compiled("$.a = 1, $.a = 2;")).toEqual([{ $set: { a: 1 } }, { $set: { a: 2 } }]);
    // A parent beside its own child is refused by the server outright.
    expect(compiled("$.a = 1, $.a.b = 2;")).toEqual([{ $set: { a: 1 } }, { $set: { "a.b": 2 } }]);
    expect(compiled("$.a.b = 1, $.a = 2;")).toEqual([{ $set: { "a.b": 1 } }, { $set: { a: 2 } }]);
  });

  it("unsets a deletion, and the root replacement stands alone", () => {
    expect(compiled("delete $.a;")).toEqual([{ $unset: "a" }]);
    expect(compiled("delete $.a, delete $.b;")).toEqual([{ $unset: ["a", "b"] }]);
    expect(compiled("$.a = 1, delete $.b;")).toEqual([{ $set: { a: 1 } }, { $unset: "b" }]);
    expect(compiled("delete $.a, $.b = 1;")).toEqual([{ $unset: "a" }, { $set: { b: 1 } }]);
    expect(compiled("$ = { x: $.a };")).toEqual([{ $replaceWith: { x: "$a" } }]);
    expect(compiled("$ = $.sub;")).toEqual([{ $replaceWith: "$sub" }]);
  });

  it("places a stage a value needed ahead of the statement that needed it", () => {
    expect(compiled("$.n = $$.length;")).toEqual([
      { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
      { $set: { n: "$__jsmql.length" } },
      { $unset: "__jsmql" },
    ]);
  });
});

describe("compiler/emit/statement — the stage calls", () => {
  it("renders a stage from its own row, in the position the row states for its body", () => {
    // `$match`'s row states `filter` for its body, so the body is a query document.
    expect(compiled("$match($.a > 1);")).toEqual([{ $match: { a: { $gt: 1, $not: { $type: "array" } } } }]);
    expect(compiled("$sort({ a: -1 });")).toEqual([{ $sort: { a: -1 } }]);
    expect(compiled("$limit(2);")).toEqual([{ $limit: 2 }]);
    expect(compiled('$count("n");')).toEqual([{ $count: "n" }]);
    expect(compiled("$project({ a: 1, _id: 0 });")).toEqual([{ $project: { a: 1, _id: 0 } }]);
    // `$group`'s row states `group` for every key but `_id`, so an accumulator lands there.
    expect(compiled("$group({ _id: null, total: $sum($.qty) });")).toEqual([
      { $group: { _id: null, total: { $sum: "$qty" } } },
    ]);
    expect(compiled("$match($.a > 1); $sort({ a: -1 }); $limit(1);")).toEqual([
      { $match: { a: { $gt: 1, $not: { $type: "array" } } } },
      { $sort: { a: -1 } },
      { $limit: 1 },
    ]);
  });

  it("passes a raw stage document through, and reads a bracketed program as the pipeline", () => {
    // HR1: raw MQL is the developer's own and keeps MongoDB's reading.
    expect(compiled("{ $match: { a: 2 } };")).toEqual([{ $match: { a: 2 } }]);
    expect(compiled("[$match($.a > 1), $set({ b: 1 })]")).toEqual([
      { $match: { a: { $gt: 1, $not: { $type: "array" } } } },
      { $set: { b: 1 } },
    ]);
  });
});

describe("compiler/emit/statement — the refusals name the way out", () => {
  it("tells a value what to do instead of standing as a statement", () => {
    expect(() => pipeline("$.a > 1;")).toThrow(/A pipeline statement writes something/);
    expect(() => pipeline("$abs(42);")).toThrow(/computes a value, and a statement writes one/);
    expect(() => pipeline("$.s.trim();")).toThrow(/Assign it to a field/);
    expect(() => pipeline("$not(true);")).toThrow(/'\$not'/);
  });

  it("refuses a destination that is not a field, and the deletion of the document", () => {
    expect(() => pipeline("$.s.trim() = 1;")).toThrow(/A write names a field|only a field/);
    expect(() => pipeline("delete $;")).toThrow(/delete the document itself/);
  });

  it("says which forms this compiler has not built yet, so nothing looks supported", () => {
    expect(() => pipeline("$$ = $$.filter(d => d.x);")).toThrow(PendingLowering);
    expect(() => pipeline("$$.filter(d => d.x).take(2);")).toThrow(PendingLowering);
    expect(() => pipeline("$.r = $$$.orders.find(o => o.id === $._id);")).toThrow(PendingLowering);
    expect(() => pipeline("$$$.dest = $$.aggregate((o) => { $match(o.a === 1); });")).toThrow(PendingLowering);
    expect(() => pipeline("let x = $.a * 2; $.b = x;")).toThrow(PendingLowering);
  });
});

// ── every pipeline above, on a real server ───────────────────────────────────

let client: MongoClient | null = null;
let coll: Collection | null = null;

beforeAll(async () => {
  try {
    const c = new MongoClient("mongodb://127.0.0.1:27017", { serverSelectionTimeoutMS: 800 });
    await c.connect();
    await c.db("admin").command({ ping: 1 });
    client = c;
    coll = c.db("jsmql_compiler_statement").collection("t");
    await coll.deleteMany({});
    await coll.insertMany([
      { _id: 1, a: 2, b: 4, qty: 3, price: 5, sub: { k: 1 }, items: [1, 2] },
      { _id: 2, a: 9, b: 1, qty: 1, price: 2, sub: { k: 2 }, items: [] },
    ]);
  } catch {
    client = null;
    coll = null;
  }
});

afterAll(async () => {
  await client?.close();
});

describe("compiler/emit/statement — the server accepts every pipeline this file asserts", () => {
  it("ran each one, or none", async () => {
    if (coll === null) {
      expect(RUNS.length).toBeGreaterThan(0);
      return;
    }
    const refused: string[] = [];
    for (const src of RUNS) {
      try {
        await coll.aggregate(pipeline(src) as Record<string, unknown>[]).toArray();
      } catch (e) {
        refused.push(`${src}\n  ${JSON.stringify(pipeline(src))}\n  ${(e as Error).message}`);
      }
    }
    expect(refused, `the server refused ${refused.length} of ${RUNS.length}:\n${refused.join("\n")}`).toEqual([]);
  });
});
