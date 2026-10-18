// The interpreter holds every operator of the registry that a value can contain.
//
// An operator that the interpreter neither runs nor refuses would be a silent gap:
// the walk refuses it as an unknown name, and nothing says that anyone decided.
// This audit reads the rows of the registry through src/compiler/rows.ts, and holds
// each one against the two tables of src/compiler/interpret/rules.ts.

import { describe, expect, it } from "vitest";
import { everyMongoName, lists } from "../src/compiler/rows.ts";
import { SYSTEM_VARS } from "../src/compiler/emit/names.ts";
import { REFUSED, RULES } from "../src/compiler/interpret/rules.ts";

/** Every operator that the registry lets a value hold. */
const valueRows = everyMongoName().filter((name) => lists(name, "value"));

describe("the interpreter tables and the registry", () => {
  it("has a rule or a refusal for every operator that a value can hold", () => {
    const unplaced = valueRows.filter((name) => !(name in RULES) && !(name in REFUSED));
    expect(unplaced).toEqual([]);
  });

  it("runs only operators that a value can hold", () => {
    expect(Object.keys(RULES).filter((name) => !valueRows.includes(name))).toEqual([]);
  });

  it("refuses only an operator of the registry, or a system variable", () => {
    const operators = new Set(everyMongoName());
    const unknown = Object.keys(REFUSED).filter((name) =>
      name.startsWith("$$") ? !(SYSTEM_VARS as readonly string[]).includes(name.slice(2)) : !operators.has(name),
    );
    expect(unknown).toEqual([]);
  });

  it("refuses every system variable, because each one reads the environment", () => {
    expect(SYSTEM_VARS.filter((name) => !(`$$${name}` in REFUSED))).toEqual([]);
  });

  it("puts no operator in both tables", () => {
    expect(Object.keys(RULES).filter((name) => name in REFUSED)).toEqual([]);
  });

  it("states a reason that ends in a full stop for every refusal", () => {
    expect(Object.entries(REFUSED).filter(([, reason]) => !/^[A-Z`].*\.$/.test(reason))).toEqual([]);
  });
});
