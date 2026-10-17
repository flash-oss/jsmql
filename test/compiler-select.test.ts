// Phase 5 of src/compiler/ — which rule of a row runs.
//
// This suite holds static audits over the whole table. It checks the argument
// partition and the byArgs routing. It also checks that a row lowers on one field
// family at most.

import { describe, expect, it } from "vitest";
import { consult } from "../src/compiler/emit/consult.ts";
import { select, shapeOf, type Receiver, kindFits } from "../src/compiler/emit/select.ts";
import { parseExpression } from "../src/compiler/parse/parser.ts";
import { NAMES } from "../src/registry/names.ts";
import { FIELD_FAMILY_TYPES, type FieldFamily } from "../src/registry/vocabulary.ts";

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
  });
});

describe("compiler/emit/select — a per-family cell and the receiver's proof", () => {
  const at = (name: string, receiver: Receiver, n = 0) =>
    select(consult(name, "value"), receiver, n === 0 ? { kind: "none" } : { kind: "dynamic" }, n);

  it("runs the branch a proven receiver names", () => {
    const r = at("length", value("string"));
    expect(r.kind).toBe("rule");
    // a receiver that is not proven `present` is tested first, and answers null when it is not there
    expect((r as { rule: { emit: (i: unknown) => unknown } }).rule.emit({ recv: "$x" })).toEqual({
      $cond: [{ $lte: ["$x", null] }, null, { $strLenCP: "$x" }],
    });
  });

  it("fits a proven argument kind to a slot type", () => {
    expect(kindFits("number", "string")).toBe(false);
    expect(kindFits("unknown", "string")).toBe(true);
    expect(kindFits("date", "number-or-date")).toBe(true);
  });

  it("takes the one field family as the receiver's family, without a dispatch", () => {
    // `ceil` is on number and Math: an unprovable receiver is a number by the row's claim.
    expect(at("ceil", OPAQUE).kind).toBe("rule");
    // the `Math` cell refuses the static: the receiver's own method is the one spelling
    expect(at("ceil", { kind: "namespace", name: "Math" }, 1).kind).toBe("refused");
  });

  it("refuses a receiver the row does not list, naming what it accepts", () => {
    expect(at("length", { kind: "namespace", name: "Math" })).toMatchObject({
      kind: "wrongReceiver",
      got: "Math",
      accepts: ["string"],
    });
    expect(at("length", value("number"))).toMatchObject({ kind: "wrongReceiver", got: "number" });
    expect(at("ceil", value("string"))).toMatchObject({ kind: "wrongReceiver", got: "string" });
  });

  it("checks the count against the branch that will run", () => {
    expect(at("length", value("string"), 1)).toMatchObject({ kind: "wrongCount", got: 1 });
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

describe("compiler/emit/select — the table audit", () => {
  type Row = { kind?: string; on?: string | readonly string[]; expr?: unknown };
  const FIELD: readonly string[] = Object.keys(FIELD_FAMILY_TYPES);
  const fieldFamilies = (row: Row): readonly string[] =>
    row.on === undefined || row.on === "any"
      ? []
      : (Array.isArray(row.on) ? row.on : [row.on as string]).filter((f) => FIELD.includes(f));

  it("finds no row that lowers on two field families, so no query tests a receiver's type", () => {
    // A family the row refuses does not count: `.keys()` lists array and object, refuses
    // array, and runs on object.
    const lowers = (row: Row, f: string): boolean => {
      const branch = (row.expr as { perFamily: Record<string, unknown> }).perFamily[f];
      return !(typeof branch === "object" && branch !== null && "unsupported" in branch);
    };
    const perFamily = (Object.entries(NAMES) as [string, Row][]).filter(
      ([, row]) => row.kind === "name" && typeof row.expr === "object" && row.expr !== null && "perFamily" in row.expr,
    );
    const two = perFamily.filter(([, row]) => fieldFamilies(row).filter((f) => lowers(row, f)).length >= 2);
    expect(two.map(([name]) => name)).toEqual([]);
    // the audit read the rows that state a cell per family
    expect(perFamily.length).toBeGreaterThanOrEqual(15);
    // and an unproven receiver selects the one lowering family on each of them
    for (const [name] of perFamily) {
      const r = select(consult(name, "value"), OPAQUE, { kind: "dynamic" }, 1);
      expect(r.kind, name).not.toBe("unknown");
    }
  });
});
