import { describe, expect, it } from "vitest";
import { jsmql } from "../src/index.ts";
import { elementOnlyOf } from "../src/compiler/rows.ts";
import { NAMES } from "../src/registry/names.ts";
import type { Family, IterateeSlots, SlotForm } from "../src/registry/vocabulary.ts";
import { isSlotLayout } from "../src/registry/vocabulary.ts";
import { canon } from "./support/canon.ts";

const SPELLINGS: Readonly<Record<SlotForm, readonly [string, string | null]>> = {
  propertyPath: ['"name"', "x => x.name"],
  propertyIndex: ["0", "x => x[0]"],
  matchesObject: ["{ active: true }", "x => x.active === true"],
  matchesPropertyPair: ['["active", true]', "x => x.active === true"],
  bareCallable: ["Number.isInteger", "x => Number.isInteger(x)"],
  omitted: ["", null],
};
const EVERY_FORM = Object.keys(SPELLINGS) as SlotForm[];

type Layout = IterateeSlots;
type Row = { on?: Family | readonly Family[] | "any"; iterateeSlots?: Readonly<Partial<Record<Family, Layout>>> };

const rows = (): [string, Row][] =>
  (Object.entries(NAMES) as [string, Row][]).filter(([, r]) => r.iterateeSlots !== undefined);

const familiesOf = (r: Row): readonly Family[] =>
  r.on === undefined || r.on === "any" ? [] : Array.isArray(r.on) ? r.on : [r.on as Family];

function source(name: string, family: Family, slot: number, arg: string): { src: string; expr: boolean } {
  const withLead = (a: string): string => (slot === 0 ? a : `$.other${a === "" ? "" : ", " + a}`);
  if (family === "stream") {
    const head =
      name === "takeWhile" || name === "dropWhile"
        ? '$$.toSorted("n")'
        : elementOnlyOf(name) !== null
          ? '$$.flatMap("items")'
          : "$$";
    return { src: `$$ = ${head}.${name}(${withLead(arg)});`, expr: false };
  }
  if (family === "Object") return { src: `Object.${name}($.items${arg === "" ? "" : ", " + arg})`, expr: true };
  return { src: `$.items.${name}(${withLead(arg)})`, expr: true };
}

const compile = (src: string, expr: boolean): string => canon(expr ? jsmql.expr(src) : jsmql(src));

const refusedFamily = (row: { expr?: unknown }, family: string): boolean => {
  const cell = row.expr as { perFamily?: Record<string, unknown> } | undefined;
  const branch = cell?.perFamily?.[family];
  return (
    typeof branch === "object" &&
    branch !== null &&
    typeof (branch as { unsupported?: unknown }).unsupported === "string"
  );
};
describe("registry — iterateeSlots covers exactly the receivers the row lists", () => {
  it("has one entry per family in `on`, and no entry outside it", () => {
    const wrong: string[] = [];
    for (const [name, row] of rows()) {
      const listed = new Set<string>(familiesOf(row));
      const declared = new Set(Object.keys(row.iterateeSlots as object));
      for (const f of listed) {
        if (refusedFamily(row, f)) continue;
        if (!declared.has(f)) wrong.push(`${name}: '${f}' is in \`on\` with no layout`);
      }
      for (const f of declared) if (!listed.has(f)) wrong.push(`${name}: layout for '${f}', which \`on\` omits`);
    }
    expect(wrong).toEqual([]);
  });
});

describe("registry — every declared spelling compiles and means its arrow", () => {
  const declared = (): { name: string; family: Family; slot: number; form: SlotForm }[] => {
    const out: { name: string; family: Family; slot: number; form: SlotForm }[] = [];
    for (const [name, row] of rows()) {
      for (const [family, layout] of Object.entries(row.iterateeSlots as object) as [Family, Layout][]) {
        if (!isSlotLayout(layout)) continue;
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
        if (c.form === "bareCallable") broken.push(`${c.name} <${c.family}> slot ${c.slot} accepts a bare static`);
      } catch (e) {
        const message = (e as Error).message;
        if (c.form === "bareCallable" && message.includes("'x => x.isInteger()'")) continue;
        broken.push(`${c.name} <${c.family}> slot ${c.slot} as ${c.form}: ${message.slice(0, 70)}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("emits for a spelling exactly what it emits for the arrow that means it", () => {
    const differ: string[] = [];
    for (const c of declared()) {
      const [short, long] = SPELLINGS[c.form];
      if (long === null) continue;
      const a = source(c.name, c.family, c.slot, short);
      const b = source(c.name, c.family, c.slot, long);
      let got: string;
      try {
        got = compile(a.src, a.expr);
      } catch {
        continue;
      }
      let want: string;
      try {
        want = compile(b.src, b.expr);
      } catch {
        continue;
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
        if (!isSlotLayout(layout)) continue;
        for (const [slot, forms] of Object.entries(layout)) {
          for (const form of EVERY_FORM) {
            if ((forms as readonly SlotForm[]).includes(form)) continue;
            const { src, expr } = source(name, family, Number(slot), SPELLINGS[form][0]);
            try {
              compile(src, expr);
              accepted.push(`${name} <${family}> accepts undeclared ${form}`);
            } catch {}
          }
        }
      }
    }
    expect(accepted).toEqual([]);
  });

  it("accepts a sort specification where the row says the argument is one", () => {
    const orders: string[] = [];
    for (const [name, row] of rows()) {
      for (const [family, layout] of Object.entries(row.iterateeSlots as object) as [Family, Layout][]) {
        if (!("sortSpec" in layout)) continue;
        const asStatement = !(row as { where?: readonly string[] }).where?.includes("value") && family === "array";
        const { src, expr } = asStatement
          ? { src: `$.items.${name}("k");`, expr: false }
          : source(name, family, 0, '"k"');
        try {
          compile(src, expr);
        } catch (e) {
          orders.push(`${name} <${family}> refuses "k": ${(e as Error).message.slice(0, 60)}`);
        }
      }
    }
    expect(orders).toEqual([]);
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
            } catch {}
          }
        }
      }
    }
    expect(accepted).toEqual([]);
  });
});
