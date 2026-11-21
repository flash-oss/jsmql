import { readFileSync, readdirSync } from "node:fs";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { NAMES } from "../src/registry/names.ts";
import type { Only, Position } from "../src/registry/vocabulary.ts";
import { GROUP_SLOT, SIZE_SLOT } from "../src/registry/vocabulary.ts";
import { GROUP_TMP, SIZE_SLOT as NS_SIZE_SLOT } from "../src/namespace.ts";

type Row = {
  kind?: string;
  on?: string | readonly string[];
  where?: readonly Position[];
  only?: readonly Only[];
  bodyPositions?: Readonly<Record<string, unknown>>;
  statementBody?: "pipeline" | readonly string[];
  params?: unknown;
  iterateeSlots?: Readonly<Record<string, unknown>>;
  document?: string;
  readsNullAsEmpty?: true;
};

const rows = Object.entries(NAMES) as [string, Row][];

const familiesOf = (row: Row): readonly string[] =>
  row.on === undefined || row.on === "any" ? [] : Array.isArray(row.on) ? row.on : [row.on as string];

const refusedFamily = (row: { expr?: unknown }, family: string): boolean => {
  const cell = row.expr as { perFamily?: Record<string, unknown> } | undefined;
  const branch = cell?.perFamily?.[family];
  return (
    typeof branch === "object" &&
    branch !== null &&
    typeof (branch as { unsupported?: unknown }).unsupported === "string"
  );
};
describe("registry — every name that takes a callback states its slot layout", () => {
  it("states iterateeSlots for every family in `on`: a layout, arrowOnly, or sortSpec", () => {
    const missing: string[] = [];
    for (const [name, row] of rows) {
      if (row.kind !== "name" || row.params === undefined) continue;
      for (const family of familiesOf(row)) {
        if (refusedFamily(row, family)) continue;
        if (row.iterateeSlots?.[family] === undefined) missing.push(`${name}.${family}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("registry — a row that reads null as the empty value", () => {
  it("states it only where the receiver has an empty value: an array or an object", () => {
    const stray = rows
      .filter(([, row]) => row.readsNullAsEmpty === true)
      .filter(([, row]) => !familiesOf(row).some((f) => f === "array" || f === "object"))
      .map(([name]) => name);
    expect(rows.some(([, row]) => row.readsNullAsEmpty === true)).toBe(true);
    expect(stray).toEqual([]);
  });
});

describe("registry — the reserved names it spells for itself", () => {
  it("every slot the registry spells is the one src/namespace.ts reserves", () => {
    expect(GROUP_SLOT).toBe(GROUP_TMP);
    expect(SIZE_SLOT).toBe(NS_SIZE_SLOT);
  });
});

describe("registry — `only` and the positions it qualifies", () => {
  const ONLY: readonly Only[] = ["stageFirst", "stageLast", "update", "afterSort"];

  it("uses every member of the Only vocabulary on at least one row", () => {
    const unused = ONLY.filter((o) => !rows.some(([, row]) => row.only?.includes(o) === true));
    expect(unused).toEqual([]);
  });

  it("states `only` on a row that can stand as a stage, a chain link, or in a stage's body", () => {
    const stray: string[] = [];
    for (const [name, row] of rows) {
      if (row.only === undefined || row.only.length === 0) continue;
      const w = row.where ?? [];
      if (!w.includes("stream") && !w.includes("statement") && !w.includes("filter")) stray.push(name);
    }
    expect(stray).toEqual([]);
  });

  it("states `document` on every stage row, and on no other", () => {
    const wrong: string[] = [];
    for (const [name, row] of rows) {
      const isStage = row.bodyPositions !== undefined;
      if (isStage !== (row.document !== undefined)) wrong.push(`${name}: stage=${isStage} document=${row.document}`);
      if (row.document !== undefined && row.where?.includes("stream") !== true)
        wrong.push(`${name}: not a stream link`);
    }
    expect(wrong).toEqual([]);
  });
});

describe("registry — a `statement` body slot says WHAT it holds", () => {
  const withStatementSlot = Object.entries(NAMES as Record<string, Row>).filter(([, r]) =>
    Object.values(r.bodyPositions ?? {}).some(
      (v) => v === "statement" || (typeof v === "object" && v !== null && Object.values(v).includes("statement")),
    ),
  );

  it("every row with one states `statementBody`", () => {
    expect(withStatementSlot.length).toBeGreaterThan(0);
    const silent = withStatementSlot.filter(([, r]) => r.statementBody === undefined).map(([n]) => n);
    expect(silent, `${silent.length} row(s) file a 'statement' body slot and do not say what it holds`).toEqual([]);
  });

  it("no row states it unless it has one", () => {
    const have = new Set(withStatementSlot.map(([n]) => n));
    const spurious = Object.entries(NAMES as Record<string, Row>)
      .filter(([n, r]) => r.statementBody !== undefined && !have.has(n))
      .map(([n]) => n);
    expect(spurious).toEqual([]);
  });

  it("every name an update spec allows is a stage this registry has", () => {
    const stages = new Set(
      Object.entries(NAMES as Record<string, Row>)
        .filter(([, r]) => (r.where ?? []).includes("statement" as Position))
        .map(([n]) => n),
    );
    for (const [name, r] of withStatementSlot) {
      if (r.statementBody === undefined || r.statementBody === "pipeline") continue;
      for (const allowed of r.statementBody) {
        expect(stages.has(allowed), `'${name}' allows '${allowed}', which is not a stage`).toBe(true);
      }
    }
  });
});

describe("registry — each `valueTwin` names an operator with a value form", () => {
  it("states `valueTwin` on a stage, naming an operator whose row lists `value`", () => {
    const wrong: string[] = [];
    let stated = 0;
    for (const [name, row] of Object.entries(NAMES) as [string, { valueTwin?: string; bodyPositions?: unknown }][]) {
      if (row.valueTwin === undefined) continue;
      stated++;
      if (row.bodyPositions === undefined) wrong.push(`${name}: valueTwin on a row that is not a stage`);
      const twin = (NAMES as Record<string, { kind?: string; where?: readonly string[] }>)[row.valueTwin];
      if (twin?.kind !== "mongo" || twin.where?.includes("value") !== true)
        wrong.push(`${name}: valueTwin '${row.valueTwin}' is not an operator with a value form`);
    }
    expect(wrong).toEqual([]);
    expect(stated).toBeGreaterThan(0);
  });
});

describe("registry — each `renamedTo` names a method that runs", () => {
  it("states `renamedTo` only on a row that refuses in every position, and its target lists a position", () => {
    const wrong: string[] = [];
    let stated = 0;
    for (const [name, row] of Object.entries(NAMES) as [string, { renamedTo?: string; where: readonly string[] }][]) {
      if (row.renamedTo === undefined) continue;
      stated++;
      if (row.where.length !== 0) wrong.push(`${name}: renamedTo on a row that lists a position`);
      const to = (NAMES as Record<string, { where?: readonly string[]; renamedTo?: string }>)[row.renamedTo];
      if (to === undefined || (to.where?.length ?? 0) === 0 || to.renamedTo !== undefined)
        wrong.push(`${name}: renamedTo '${row.renamedTo}' is not a method that runs`);
    }
    expect(wrong).toEqual([]);
    expect(stated).toBeGreaterThan(0);
  });
});

describe("registry — `keys` and `takesLet` sit on the rows they describe", () => {
  type Facts = { kind?: string; keys?: readonly string[]; takesLet?: true; shape?: unknown; bodyPositions?: unknown };
  const facts = Object.entries(NAMES) as [string, Facts][];

  it("states `keys` on an operator whose body is a document of named keys, and never on a stage", () => {
    const wrong: string[] = [];
    for (const [name, row] of facts) {
      if (row.keys === undefined) continue;
      if (row.kind !== "mongo" || row.bodyPositions !== undefined)
        wrong.push(`${name}: keys on a stage or a non-MongoDB row`);
      if (row.keys.length === 0 || new Set(row.keys).size !== row.keys.length)
        wrong.push(`${name}: keys must be non-empty and distinct`);
    }
    expect(wrong).toEqual([]);
  });

  it("states `takesLet` on a stage exactly when its vendored spec has a `let` argument", () => {
    const dir = new URL("../vendor/mql-specifications/definitions/stage/", import.meta.url);
    const withLet = new Set<string>();
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".yaml")) continue;
      let txt = readFileSync(new URL(file, dir), "utf8");
      const cut = txt.indexOf("\ntests:");
      if (cut >= 0) txt = txt.slice(0, cut);
      const doc = yaml.load(txt) as { name?: string; arguments?: readonly { name: string }[] } | undefined;
      if (doc?.name !== undefined && (doc.arguments ?? []).some((a) => a.name === "let")) withLet.add(doc.name);
    }
    const wrong: string[] = [];
    for (const [name, row] of facts) {
      if (row.bodyPositions === undefined) {
        if (row.takesLet !== undefined) wrong.push(`${name}: takesLet on a row that is not a stage`);
        continue;
      }
      if (withLet.has(name) !== (row.takesLet === true))
        wrong.push(`${name}: spec let=${withLet.has(name)} takesLet=${row.takesLet === true}`);
    }
    expect(wrong).toEqual([]);
    expect(withLet.size).toBeGreaterThan(0);
  });
});
