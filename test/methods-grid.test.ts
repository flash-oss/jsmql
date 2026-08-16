// test/methods-grid.test.ts — the declaration grid holds itself up.
//
// A method migrated to `src/methods/` lowers from ONE declaration: its arity rule, its
// lowering, and (once the generator reads it) its TypeScript signature all come from the
// same object. These tests assert the properties that make that worth doing.
//
// The migration is in progress — most methods still live in the `generateMethodCall`
// switch — so the ratchet below is the honest bookkeeping: the un-migrated set may only
// ever shrink. Delete the ratchet when it reaches zero.
//
// See docs/specs/lowering-grid.md.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { jsmql } from "../src/index.ts";
import { valueMethodNames, requiredReceiverFamily } from "../src/codegen.ts";
import { METHOD_FAMILIES, declaredMethodNames, lookupMethod } from "../src/methods/index.ts";
import { stageCellApplies } from "../src/methods/types.ts";

describe("the registry is assembled from every family file", () => {
  it("imports every family file", () => {
    // A family file nobody imports is silently absent — the class of failure the grid
    // exists to remove. Compare the directory to the assembly rather than trusting it.
    const onDisk = readdirSync(join(import.meta.dirname, "..", "src", "methods"))
      .filter((f) => f.endsWith(".ts") && f !== "index.ts" && f !== "types.ts")
      .map((f) => f.replace(/\.ts$/, ""))
      .sort();
    expect([...METHOD_FAMILIES.keys()].sort()).toEqual(onDisk);
  });

  it("declares no name twice across families", () => {
    const seen = new Set<string>();
    for (const [family, names] of METHOD_FAMILIES) {
      for (const n of names) {
        expect(seen.has(n), `${n} is declared by more than one family (second: ${family})`).toBe(false);
        seen.add(n);
      }
    }
  });

  it("never resolves an inherited Object.prototype member", () => {
    // A plain `{}` registry would hand back `Object.prototype.toLocaleString` — a truthy
    // function with no `args` — and dispatch would pass it to the arity checker.
    for (const name of ["toString", "valueOf", "toLocaleString", "constructor", "hasOwnProperty"]) {
      const found = lookupMethod(name);
      expect(found === undefined || typeof found.value === "function" || "unsupported" in found.value).toBe(true);
    }
  });
});

describe("every declaration is complete", () => {
  for (const name of declaredMethodNames()) {
    it(`${name}: declares a receiver, an arity rule and a value lowering`, () => {
      const def = lookupMethod(name)!;
      expect(def.receiver, `${name} has no receiver family`).toBeDefined();
      expect(def.args, `${name} has no argument rule`).toBeDefined();
      expect(def.args.sig, `${name}'s argument rule has no signature text`).toBeDefined();
      expect(def.value, `${name} has no value lowering`).toBeDefined();
    });
  }

  it("agrees with the codegen receiver-family gate", () => {
    // Two statements of one fact drift. Until `requiredReceiverFamily` reads the grid,
    // this asserts they say the same thing.
    for (const name of declaredMethodNames()) {
      const def = lookupMethod(name)!;
      const gate = requiredReceiverFamily(name);
      if (gate !== null) {
        expect(gate, `${name}: grid says ${def.receiver}, codegen gate says ${gate}`).toBe(def.receiver);
      }
    }
  });

  it("only claims a Stage cell where one can exist", () => {
    for (const name of declaredMethodNames()) {
      const def = lookupMethod(name)!;
      if (!stageCellApplies(def.receiver)) {
        // A non-array receiver cannot have a stream form: the stream is a sequence of
        // documents. This is not an unanswered cell, it is an impossible one.
        expect(def.receiver).not.toBe("array");
      }
    }
  });
});

describe("the migration ratchet", () => {
  // The number of methods still lowering from the switch. It must only ever go DOWN.
  // Lower this line as families migrate; a rise means a method was added to the switch
  // instead of to the grid, which is the habit the grid exists to break.
  const MAX_UNMIGRATED = 140;

  it("never grows the set of methods that bypass the grid", () => {
    const unmigrated = valueMethodNames().filter((n) => lookupMethod(n) === undefined);
    expect(
      unmigrated.length,
      `${unmigrated.length} methods still lower from the switch. If you migrated some, lower MAX_UNMIGRATED.`,
    ).toBeLessThanOrEqual(MAX_UNMIGRATED);
  });

  it("keeps the ratchet honest — it is not already slack", () => {
    // A ratchet nobody tightens is decoration. This fails once the real count drops well
    // below the constant, forcing it down with the migration that earned it.
    const unmigrated = valueMethodNames().filter((n) => lookupMethod(n) === undefined);
    expect(MAX_UNMIGRATED - unmigrated.length).toBeLessThanOrEqual(5);
  });
});

describe("the migrated date accessors behave", () => {
  const CASES: [string, object][] = [
    ["$.s.trim()", { $trim: { input: "$s" } }],
    ["$.s.trimStart()", { $ltrim: { input: "$s" } }],
    ["$.s.toUpperCase()", { $toUpper: "$s" }],
    ['$.s.split(",")', { $split: ["$s", ","] }],
    ["$.d.getFullYear()", { $year: "$d" }],
    ["$.d.getUTCFullYear()", { $year: "$d" }],
    ["$.d.getMonth()", { $month: "$d" }],
    ["$.d.getDay()", { $dayOfWeek: "$d" }],
    ["$.d.getUTCMilliseconds()", { $millisecond: "$d" }],
  ];
  for (const [src, expected] of CASES) {
    it(src, () => {
      expect(jsmql.expr(src)).toEqual(expected);
    });
  }

  it("applies the declaration's arity rule, which the switch arms skipped", () => {
    expect(() => jsmql.expr('$.d.getUTCHours("UTC")')).toThrow(/takes no arguments, got 1/);
    // These two used to COMPILE and silently discard the argument: their switch arms
    // returned without an arity check. A declaration cannot skip its own rule.
    expect(() => jsmql.expr('$.s.trim("x")')).toThrow(/\.trim\(\) takes no arguments, got 1/);
    expect(() => jsmql.expr("$.s.toLowerCase(1)")).toThrow(/\.toLowerCase\(\) takes no arguments, got 1/);
  });

  it("still rejects a receiver that is certainly not a date", () => {
    expect(() => jsmql.expr('"2020-01-01".getFullYear()')).toThrow(/expects a date/);
  });
});
