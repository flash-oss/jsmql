// Phase 5 of src/compiler/ — which rule of a row runs.
//
// Two static audits over the whole table, the argument partition, the byArgs
// routing on the five rows that state one, and the runtime guards measured on
// mongod: for every field family, one document per BSON type, the guard is true
// exactly for the types the family covers.

import { describe, expect, it } from "vitest";
import { MongoClient } from "mongodb";
import { consult } from "../src/compiler/emit/consult.ts";
import { guardFor, select, shapeOf, type Receiver } from "../src/compiler/emit/select.ts";
import { parseExpression } from "../src/compiler/parse/parser.ts";
import { NAMES } from "../src/registry/names.ts";
import type { FieldFamily } from "../src/registry/vocabulary.ts";
import { liveClientNow, liveUp } from "./fixtures/live.ts";

const up = await liveUp();

/** The arguments of a parsed call `f(…)`. */
const argsOf = (src: string): readonly never[] => (parseExpression(src) as { args: readonly never[] }).args;
const OPAQUE: Receiver = { kind: "opaque", lowered: "$x" };
const NONE: Receiver = { kind: "none" };
const value = (family: FieldFamily): Receiver => ({ kind: "value", family, lowered: "$x" });

describe("compiler/emit/select — the argument partition", () => {
  it("classes every list in exactly one of six, in the stated order", () => {
    expect(shapeOf(argsOf("f(...$.a)"))).toEqual({ kind: "spread" });
    expect(shapeOf(argsOf("f(1, ...$.a)"))).toEqual({ kind: "spread" });
    expect(shapeOf(argsOf("f()"))).toEqual({ kind: "none" });
    expect(shapeOf(argsOf("f(1, 2)"))).toEqual({ kind: "multiple" });
    expect(shapeOf(argsOf("f($.y, $.m, $.d)"))).toEqual({ kind: "multiple" });
    // an object literal is `object` even when every value is constant
    expect(shapeOf(argsOf("f({ length: 3 })"))).toEqual({ kind: "object", keys: ["length"] });
    expect(shapeOf(argsOf("f({ [k]: 3, n: 1 })"))).toEqual({ kind: "object", keys: ["n"] });
    expect(shapeOf(argsOf('f("abc")'))).toEqual({ kind: "constant", value: "abc" });
    expect(shapeOf(argsOf("f(1 + 2)"))).toEqual({ kind: "constant", value: 3 });
    expect(shapeOf(argsOf("f($.id)"))).toEqual({ kind: "dynamic" });
  });
});

describe("compiler/emit/select — a keyed byArgs routes by class and states its leftover", () => {
  const pick = (name: string, src: string, receiver: Receiver = NONE) =>
    select(consult(name, "value"), receiver, shapeOf(argsOf(src)), argsOf(src).length);

  it("routes each class of `new Date(…)`", () => {
    expect(pick("Date", "f()").kind).toBe("rule");
    expect(pick("Date", "f($.ms)").kind).toBe("rule");
    expect(pick("Date", "f($.y, $.m)").kind).toBe("rule");
    // a constant that reached the row did not fold: refused, in the developer's terms
    expect(pick("Date", 'f("not a date")')).toMatchObject({ kind: "refused" });
    expect((pick("Date", 'f("not a date")') as { message: string }).message).toContain("ISO 8601");
    // the leftover is stated
    expect(pick("Date", "f({ a: 1 })")).toMatchObject({ kind: "refused" });
    expect(pick("Date", "f(1, 2, 3, 4, 5, 6, 7, 8)")).toMatchObject({ kind: "wrongCount", got: 8 });
  });

  it("an object literal falls to the stated leftover — no class claims it", () => {
    // `byArgs` names 'none', 'multiple', 'constant' and 'dynamic'; an object literal
    // belongs to none of them, so the row's own 'otherwise' answers.
    expect(pick("Date", "f({ a: 1 })")).toMatchObject({ kind: "refused" });
    expect(pick("ObjectId", "f({ a: 1 })")).toMatchObject({ kind: "refused" });
  });

  it("converts a constant `Number(…)` on the server, where the type is decided", () => {
    expect(pick("Number", 'f("abc")').kind).toBe("rule");
    expect(pick("Number", "f($.s)").kind).toBe("rule");
    expect(pick("ObjectId", "f($.id)").kind).toBe("rule");
    expect(pick("ObjectId", "f()").kind).toBe("rule");
    expect(pick("Set", "f($.a)").kind).toBe("rule");
  });
});

describe("compiler/emit/select — a per-family cell and the receiver's proof", () => {
  const at = (name: string, receiver: Receiver, n = 0) =>
    select(consult(name, "value"), receiver, n === 0 ? { kind: "none" } : { kind: "dynamic" }, n);

  it("runs the branch a proven receiver names", () => {
    const r = at("length", value("array"));
    expect(r.kind).toBe("rule");
    // a receiver that is not proven `present` is tested first, and answers null when it is not there
    expect((r as { rule: { emit: (i: unknown) => unknown } }).rule.emit({ recv: "$x" })).toEqual({
      $cond: { if: { $eq: [{ $ifNull: ["$x", null] }, null] }, then: null, else: { $size: "$x" } },
    });
  });

  it("dispatches an unprovable receiver over the field families, with the row's `uncertain` as default", () => {
    const r = at("length", OPAQUE);
    expect(r.kind).toBe("dispatch");
    if (r.kind !== "dispatch") return;
    expect(r.branches.map((b) => b.family)).toEqual(["array", "string"]);
    // no branch admits null or missing: they fall to the row's `uncertain`, which answers null
    expect(r.branches[1].guard("$$v")).toEqual({ $in: [{ $type: "$$v" }, ["string"]] });
    expect(r.branches[0].guard("$$v")).toEqual({ $in: [{ $type: "$$v" }, ["array"]] });
    expect(typeof r.otherwise).toBe("function");
  });

  it("takes the one field family as the receiver's family, without a dispatch", () => {
    // `ceil` is on number and Math: an unprovable receiver is a number by the row's claim.
    expect(at("ceil", OPAQUE).kind).toBe("rule");
    expect(at("ceil", { kind: "namespace", name: "Math" }, 1).kind).toBe("rule");
  });

  it("refuses a receiver the row does not list, naming what it accepts", () => {
    expect(at("length", { kind: "namespace", name: "Math" })).toMatchObject({
      kind: "wrongReceiver",
      got: "Math",
      accepts: ["array", "string", "stream"],
    });
    expect(at("length", value("number"))).toMatchObject({ kind: "wrongReceiver", got: "number" });
    expect(at("ceil", value("string"))).toMatchObject({ kind: "wrongReceiver", got: "string" });
  });

  it("checks the count against the branch that will run", () => {
    expect(at("length", value("array"), 1)).toMatchObject({ kind: "wrongCount", got: 1 });
    // `$abs` takes one operand; two is the count no rule states
    expect(select(consult("$abs", "value"), NONE, { kind: "multiple" }, 2)).toMatchObject({
      kind: "wrongCount",
      got: 2,
    });
    expect(select(consult("$abs", "value"), NONE, { kind: "dynamic" }, 1).kind).toBe("rule");
  });

  it("refuses a spread on a rule that reads arguments one by one, quoting the signature", () => {
    expect(select(consult("$abs", "value"), NONE, { kind: "spread" }, 1)).toMatchObject({
      kind: "spreadRefused",
      sig: "operand",
    });
  });
});

describe("compiler/emit/select — the table audits", () => {
  type Row = { kind?: string; on?: string | readonly string[]; expr?: unknown };
  const FIELD: readonly string[] = ["string", "array", "number", "object", "date", "regexp", "set"];
  const fieldFamilies = (row: Row): readonly string[] =>
    row.on === undefined || row.on === "any"
      ? []
      : (Array.isArray(row.on) ? row.on : [row.on as string]).filter((f) => FIELD.includes(f));

  it("dispatches an unprovable receiver exactly on the rows with two or more field families", () => {
    const wrong: string[] = [];
    for (const [name, row] of Object.entries(NAMES) as [string, Row][]) {
      if (row.kind !== "name" || !(typeof row.expr === "object" && row.expr !== null && "perFamily" in row.expr))
        continue;
      const r = select(consult(name, "value"), OPAQUE, { kind: "none" }, 0);
      const expectDispatch = fieldFamilies(row).length >= 2;
      const isDispatch = r.kind === "dispatch";
      // a count refusal is a legitimate non-dispatch answer for a zero-argument probe
      if (expectDispatch !== isDispatch && r.kind !== "wrongCount" && r.kind !== "rejectedCount") {
        wrong.push(`${name}: ${r.kind}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("holds a guard for every field family — the type keeps the table complete", () => {
    for (const f of FIELD as readonly FieldFamily[]) expect(typeof guardFor(f)).toBe("function");
  });
});

describe.skipIf(!up)("compiler/emit/select — the guards, measured on mongod", () => {
  it("is true exactly for the types each family covers, missing included", async () => {
    const client = await liveClientNow();
    try {
      const coll = client.db("jsmql_select").collection("t");
      await coll.deleteMany({});
      // one document per BSON type the guards can meet, plus one with the field missing
      const docs: Record<string, unknown>[] = [
        { t: "string", v: "s" },
        { t: "array", v: [1] },
        { t: "int", v: 1 },
        { t: "double", v: 1.5 },
        { t: "object", v: { a: 1 } },
        { t: "date", v: new Date(0) },
        { t: "regex", v: /x/ },
        { t: "bool", v: true },
        { t: "null", v: null },
        { t: "missing" },
      ];
      await coll.insertMany(docs);
      const EXPECT: Record<FieldFamily, readonly string[]> = {
        string: ["string"],
        array: ["array"],
        number: ["int", "double"],
        object: ["object"],
        date: ["date"],
        regexp: ["regex"],
        set: ["array"],
      };
      for (const family of Object.keys(EXPECT) as FieldFamily[]) {
        const rows = await coll
          .aggregate([{ $addFields: { g: guardFor(family)("$v") } }, { $sort: { t: 1 } }])
          .toArray();
        const trueFor = rows
          .filter((r) => r.g === true)
          .map((r) => r.t as string)
          .sort();
        expect(trueFor, family).toEqual([...EXPECT[family]].sort());
      }
      // the widening: `length.string` admits null and missing
      const rows = await coll
        .aggregate([{ $addFields: { g: guardFor("string", ["null", "missing"])("$v") } }])
        .toArray();
      expect(
        rows
          .filter((r) => r.g === true)
          .map((r) => r.t)
          .sort(),
      ).toEqual(["missing", "null", "string"]);
    } finally {
      await client.close();
    }
  });
});
