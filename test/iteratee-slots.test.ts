// `iterateeSlots` says which argument slots stand in for an arrow, on which
// receiver, and with which spellings. The claim is only worth making if it is
// checked, so this re-measures every declared form against the arrow it means —
// and every form a slot leaves out, to confirm it is refused.
//
// The comparison erases binding names first: two spellings of one meaning differ
// only in what the compiler called its own `$let` vars and `$map` `as`, which is
// not a difference in meaning. See support/canon.ts.

import { describe, expect, it } from "vitest";
import { jsmql } from "../src/index.ts";
import { NAMES } from "../src/registry/names.ts";
import type { Family, SlotForm } from "../src/registry/vocabulary.ts";
import { canon } from "./support/canon.ts";

/** Each form, and the arrow that spells the same meaning. `null` = no arrow does. */
const SPELLINGS: Readonly<Record<SlotForm, readonly [string, string | null]>> = {
  propertyPath: ['"name"', "x => x.name"],
  matchesObject: ["{ active: true }", "x => x.active === true"],
  matchesPropertyPair: ['["active", true]', "x => x.active === true"],
  bareCallable: ["Number", "x => Number(x)"],
  omitted: ["", null],
};
const EVERY_FORM = Object.keys(SPELLINGS) as SlotForm[];

type Layout = Readonly<Record<number, readonly SlotForm[]>> | { arrowOnly: string };
type Row = { on?: Family | readonly Family[] | "any"; iterateeSlots?: Readonly<Partial<Record<Family, Layout>>> };

const rows = (): [string, Row][] =>
  (Object.entries(NAMES) as [string, Row][]).filter(([, r]) => r.iterateeSlots !== undefined);

const familiesOf = (r: Row): readonly Family[] =>
  r.on === undefined || r.on === "any" ? [] : Array.isArray(r.on) ? r.on : [r.on as Family];

/**
 * The source that calls `name` on `family` with `arg` in slot `slot`.
 *
 * One receiver per family, and the family fixes the position too: an array
 * receiver is a value, a stream receiver is a chain link.
 */
function source(name: string, family: Family, slot: number, arg: string): { src: string; expr: boolean } {
  const withLead = (a: string): string => (slot === 0 ? a : `$.other${a === "" ? "" : ", " + a}`);
  if (family === "stream") {
    // Two names keep only a leading or trailing run, so they need an order first.
    const head = name === "takeWhile" || name === "dropWhile" ? '$$.toSorted("n")' : "$$";
    return { src: `$$ = ${head}.${name}(${withLead(arg)});`, expr: false };
  }
  if (family === "Object") return { src: `Object.${name}($.items${arg === "" ? "" : ", " + arg})`, expr: true };
  return { src: `$.items.${name}(${withLead(arg)})`, expr: true };
}

const compile = (src: string, expr: boolean): string => canon(expr ? jsmql.expr(src) : jsmql(src));

describe("registry — iterateeSlots covers exactly the receivers the row lists", () => {
  it("has one entry per family in `on`, and no entry outside it", () => {
    const wrong: string[] = [];
    for (const [name, row] of rows()) {
      const listed = new Set<string>(familiesOf(row));
      const declared = new Set(Object.keys(row.iterateeSlots as object));
      for (const f of listed) if (!declared.has(f)) wrong.push(`${name}: '${f}' is in \`on\` with no layout`);
      for (const f of declared) if (!listed.has(f)) wrong.push(`${name}: layout for '${f}', which \`on\` omits`);
    }
    expect(wrong).toEqual([]);
  });
});

describe("registry — every declared spelling compiles and means its arrow", () => {
  /** Every (name, family, slot, form) with a layout that names a slot. */
  const declared = (): { name: string; family: Family; slot: number; form: SlotForm }[] => {
    const out: { name: string; family: Family; slot: number; form: SlotForm }[] = [];
    for (const [name, row] of rows()) {
      for (const [family, layout] of Object.entries(row.iterateeSlots as object) as [Family, Layout][]) {
        if ("arrowOnly" in layout) continue;
        for (const [slot, forms] of Object.entries(layout)) {
          for (const form of forms) out.push({ name, family, slot: Number(slot), form });
        }
      }
    }
    return out;
  };

  it("is not a vacuous table", () => {
    expect(declared().length).toBeGreaterThan(100);
  });

  it("accepts every spelling it declares", () => {
    const broken: string[] = [];
    for (const c of declared()) {
      const { src, expr } = source(c.name, c.family, c.slot, SPELLINGS[c.form][0]);
      try {
        compile(src, expr);
      } catch (e) {
        broken.push(`${c.name} <${c.family}> slot ${c.slot} as ${c.form}: ${(e as Error).message.slice(0, 70)}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("emits for a spelling exactly what it emits for the arrow that means it", () => {
    const differ: string[] = [];
    for (const c of declared()) {
      const [short, long] = SPELLINGS[c.form];
      if (long === null) continue; // `omitted` is identity; no arrow spells it
      const a = source(c.name, c.family, c.slot, short);
      const b = source(c.name, c.family, c.slot, long);
      let got: string;
      try {
        got = compile(a.src, a.expr);
      } catch {
        continue; // covered by the test above
      }
      let want: string;
      try {
        want = compile(b.src, b.expr);
      } catch {
        continue; // the arrow itself is refused here, which is a separate fact
      }
      if (got !== want) differ.push(`${c.name} <${c.family}> as ${c.form}`);
    }
    expect(differ).toEqual([]);
  });
});

describe("registry — a spelling a slot leaves out is refused", () => {
  it("refuses the forms a declared slot omits", () => {
    const accepted: string[] = [];
    for (const [name, row] of rows()) {
      for (const [family, layout] of Object.entries(row.iterateeSlots as object) as [Family, Layout][]) {
        if ("arrowOnly" in layout) continue;
        for (const [slot, forms] of Object.entries(layout)) {
          for (const form of EVERY_FORM) {
            if ((forms as readonly SlotForm[]).includes(form)) continue;
            const { src, expr } = source(name, family, Number(slot), SPELLINGS[form][0]);
            try {
              compile(src, expr);
              accepted.push(`${name} <${family}> accepts undeclared ${form}`);
            } catch {
              // refused, as declared
            }
          }
        }
      }
    }
    expect(accepted).toEqual([]);
  });

  it("refuses every spelling on a receiver declared arrow-only", () => {
    const accepted: string[] = [];
    for (const [name, row] of rows()) {
      for (const [family, layout] of Object.entries(row.iterateeSlots as object) as [Family, Layout][]) {
        if (!("arrowOnly" in layout)) continue;
        for (const form of EVERY_FORM) {
          for (const slot of [0, 1]) {
            const { src, expr } = source(name, family, slot, SPELLINGS[form][0]);
            try {
              compile(src, expr);
              accepted.push(`${name} <${family}> accepts ${form} in slot ${slot}, declared arrow-only`);
            } catch {
              // refused, as declared
            }
          }
        }
      }
    }
    expect(accepted).toEqual([]);
  });
});
