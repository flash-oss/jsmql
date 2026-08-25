// `iterateeSlots` says which argument slots stand in for an arrow, and with which
// spellings. The claim is only worth making if it is checked, so this re-measures
// every declared form against the arrow it means.
//
// The comparison erases binding names first: two spellings of one meaning differ
// only in what the compiler called its own `$let` vars and `$map` `as`, and a
// difference there is not a difference in meaning. See support/canon.ts.

import { describe, expect, it } from "vitest";
import { jsmql } from "../src/index.ts";
import { NAMES } from "../src/registry/names.ts";
import type { IterateeSlots, Position, SlotForm } from "../src/registry/vocabulary.ts";
import { canon } from "./support/canon.ts";

/** The receiver each position is measured on. */
const RECEIVER: Readonly<Record<string, string>> = { value: "$.items", stream: "$$", statement: "$.items" };

/** An array to compare against, for a name whose iteratee is not the first slot. */
const LEADING_ARRAY = "$.other";

/** Each form, and the arrow that spells the same meaning. */
const SPELLINGS: Readonly<Record<SlotForm, readonly [string, string | null]>> = {
  propertyPath: ['"name"', "x => x.name"],
  matchesObject: ["{ active: true }", "x => x.active === true"],
  matchesPropertyPair: ['["active", true]', "x => x.active === true"],
  bareCallable: ["Number", "x => Number(x)"],
  omitted: ["", null],
};

type Case = { name: string; position: Position; slot: number; form: SlotForm };

/** Every (row, position, slot, form) the registry declares. */
function declared(): Case[] {
  const out: Case[] = [];
  for (const [name, row] of Object.entries(NAMES) as [string, { iterateeSlots?: unknown }][]) {
    const decl = row.iterateeSlots;
    if (decl === undefined) continue;
    const perPosition = Object.keys(decl as object).some((k) => Number.isNaN(Number(k)));
    const byPosition = perPosition
      ? (decl as Readonly<Record<string, IterateeSlots>>)
      : { value: decl as IterateeSlots };
    for (const [position, slots] of Object.entries(byPosition)) {
      for (const [slot, forms] of Object.entries(slots)) {
        for (const form of forms) out.push({ name, position: position as Position, slot: Number(slot), form });
      }
    }
  }
  return out;
}

/** The source that calls `name` with `arg` in the declared slot. */
function source(c: Case, arg: string): string {
  const recv = RECEIVER[c.position];
  const args = c.slot === 0 ? arg : `${LEADING_ARRAY}${arg === "" ? "" : ", " + arg}`;
  if (c.position === "stream") {
    // Two names keep only a leading or trailing run, so they need an order first.
    const ordered = c.name === "takeWhile" || c.name === "dropWhile" ? '$$.toSorted("n")' : "$$";
    return `$$ = ${ordered}.${c.name}(${args});`;
  }
  if (c.position === "statement") return `${recv}.${c.name}(${args});`;
  return `${recv}.${c.name}(${args})`;
}

const compile = (src: string, position: Position): string => canon(position === "value" ? jsmql.expr(src) : jsmql(src));

describe("registry — every declared iteratee spelling compiles", () => {
  const cases = declared();

  it("declares a slot only at a position the row lists", () => {
    const wrong = cases
      .filter(({ name, position }) => {
        const where = (NAMES as Record<string, { where: readonly Position[] }>)[name].where;
        return !where.includes(position);
      })
      .map(({ name, position }) => `${name} @ ${position}`);
    expect([...new Set(wrong)]).toEqual([]);
  });

  it("accepts every spelling it declares", () => {
    const broken: string[] = [];
    for (const c of cases) {
      const [short] = SPELLINGS[c.form];
      try {
        compile(source(c, short), c.position);
      } catch (e) {
        broken.push(`${c.name} @ ${c.position} slot ${c.slot} as ${c.form}: ${(e as Error).message.slice(0, 80)}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("emits for a spelling exactly what it emits for the arrow that means it", () => {
    const differ: string[] = [];
    for (const c of cases) {
      const [short, long] = SPELLINGS[c.form];
      if (long === null) continue; // `omitted` is identity; no arrow spells it
      let a: string, b: string;
      try {
        a = compile(source(c, short), c.position);
      } catch {
        continue; // covered by the test above
      }
      try {
        b = compile(source(c, long), c.position);
      } catch {
        continue; // the arrow itself is refused here — a separate fact
      }
      if (a !== b) differ.push(`${c.name} @ ${c.position} as ${c.form}`);
    }
    expect(differ).toEqual([]);
  });
});

describe("registry — a spelling a slot does NOT declare is refused", () => {
  it("refuses what it leaves out", () => {
    const cases = declared();
    const has = new Set(cases.map((c) => `${c.name}/${c.position}/${c.slot}/${c.form}`));
    const slots = new Set(cases.map((c) => `${c.name}/${c.position}/${c.slot}`));
    const accepted: string[] = [];
    for (const key of slots) {
      const [name, position, slot] = key.split("/");
      for (const form of Object.keys(SPELLINGS) as SlotForm[]) {
        if (has.has(`${name}/${position}/${slot}/${form}`)) continue;
        const c: Case = { name, position: position as Position, slot: Number(slot), form };
        try {
          compile(source(c, SPELLINGS[form][0]), c.position);
          accepted.push(`${name} @ ${position} accepts undeclared ${form}`);
        } catch {
          // refused, as declared
        }
      }
    }
    expect(accepted).toEqual([]);
  });
});
