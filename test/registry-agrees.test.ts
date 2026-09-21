// The cross-references inside the registry that no type-level audit can hold.
//
// names.ts holds seven audits at its foot, each a type that goes `never` when a
// reference dangles. Four references escape that form: they relate one field's
// PRESENCE to another's CONTENT (`only` to `where`, `params` to `iterateeSlots`),
// or they relate a vocabulary member to the rows that use it. Those are runtime
// facts over the whole table, so they live here — and each one was made to fail
// before it was trusted.

import { describe, expect, it } from "vitest";
import { NAMES } from "../src/registry/names.ts";
import type { Only, Position } from "../src/registry/vocabulary.ts";
import { GROUP_SLOT, LENGTH_SLOT } from "../src/registry/vocabulary.ts";
import { GROUP_TMP, LENGTH_SLOT as NS_LENGTH_SLOT } from "../src/namespace.ts";

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
  body?: unknown;
};

const rows = Object.entries(NAMES) as [string, Row][];

/** The families a row's `on` names, or none for `"any"` — a namespace family included. */
const familiesOf = (row: Row): readonly string[] =>
  row.on === undefined || row.on === "any" ? [] : Array.isArray(row.on) ? row.on : [row.on as string];

/**
 * Is this family REFUSED in value position? A refused family takes no callback, so it
 * states no iteratee layout — `groupBy` is spelled on `Object` only to give
 * `Object.groupBy(…)` a message that names the receiver form.
 */
const refusedFamily = (row: { expr?: unknown }, family: string): boolean => {
  const cell = row.expr as { perFamily?: Record<string, unknown> } | undefined;
  const branch = cell?.perFamily?.[family];
  return (
    typeof branch === "object" &&
    branch !== null &&
    typeof (branch as { unsupported?: unknown }).unsupported === "string"
  );
};
describe("registry — every callback-taking name states its slot layout", () => {
  it("states iterateeSlots for every family in `on`: a layout, arrowOnly, or sortSpec", () => {
    // A row with `params` takes a callback. Without a layout the desugar pass
    // cannot tell `$.o.mapValues("name")` (refused — a two-parameter arrow only)
    // from `$.rows.uniqBy("id")` (a property-path shorthand), and phase 5 receives
    // a string where an arrow belongs with no row text to quote. `arrowOnly` is
    // the stated form of "nothing stands in for the arrow here" — an omission
    // and a decision look alike, so the decision has to be written.
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

describe("registry — the reserved names it spells for itself", () => {
  it("every slot the registry spells is the one src/namespace.ts reserves", () => {
    // The registry imports nothing outside itself, so a reserved name it needs is
    // written twice. Nothing else holds the two spellings together: a rename on one
    // side alone would give a stage that writes one field and a read of another.
    expect(GROUP_SLOT).toBe(GROUP_TMP);
    expect(LENGTH_SLOT).toBe(NS_LENGTH_SLOT);
  });
});

describe("registry — `only` and the positions it qualifies", () => {
  const ONLY: readonly Only[] = ["stageFirst", "stageLast", "update", "afterSort"];

  it("uses every member of the Only vocabulary on at least one row", () => {
    // `afterSort` was declared, documented with an example, and stated by no row
    // — so `$$ = $$.takeWhile(p)` would have emitted the $setWindowFields mongod
    // refuses (Location5339901) instead of the "needs a preceding sort" refusal.
    const unused = ONLY.filter((o) => !rows.some(([, row]) => row.only?.includes(o) === true));
    expect(unused).toEqual([]);
  });

  it("states `only` on a row that can stand as a stage, a chain link, or in a stage's body", () => {
    // Every Only member qualifies a stage or a link — "first stage", "last stage",
    // "an update-pipeline stage", "a link after a sort" — and the placement may
    // belong to an OPERATOR the stage carries rather than to the stage itself:
    // MEASURED, "$match with $text is only allowed as the first pipeline stage", so
    // the rule is `$text`'s and the stage it qualifies is whichever `$match` holds it.
    // A row that stands in none of those three positions has nothing to qualify.
    const stray: string[] = [];
    for (const [name, row] of rows) {
      if (row.only === undefined || row.only.length === 0) continue;
      const w = row.where ?? [];
      if (!w.includes("stream") && !w.includes("statement") && !w.includes("filter")) stray.push(name);
    }
    expect(stray).toEqual([]);
  });

  it("states `document` on every stage row, and on no other", () => {
    // The document `Type` changes at a STAGE — `$group`, `$replaceRoot`, `$set` —
    // and a stage is the row with a `body`. On a value row the fact would tell the
    // scope tracker to drop bindings after an expression; on a stage row without
    // it the tracker would have to guess. So the two fields come as a pair.
    const wrong: string[] = [];
    for (const [name, row] of rows) {
      const isStage = row.body !== undefined;
      if (isStage !== (row.document !== undefined)) wrong.push(`${name}: body=${isStage} document=${row.document}`);
      if (row.document !== undefined && row.where?.includes("stream") !== true)
        wrong.push(`${name}: not a stream link`);
    }
    expect(wrong).toEqual([]);
  });
});

describe("registry — a `statement` body slot says WHAT it holds", () => {
  /** Every row with a body key it files as `statement`, at any depth of the layout. */
  const withStatementSlot = Object.entries(NAMES as Record<string, Row>).filter(([, r]) =>
    Object.values(r.bodyPositions ?? {}).some(
      (v) => v === "statement" || (typeof v === "object" && v !== null && Object.values(v).includes("statement")),
    ),
  );

  // A `statement` slot holds one of two things, and they are not alike: a pipeline of
  // its own (`$lookup.pipeline`) has a FIRST position and its own placement rules; an
  // update spec (`$merge.whenMatched`) has neither and runs a closed set of stages.
  // No other field tells them apart, so the row states it — and this fails the build
  // for a row that forgets, which is how the distinction stays honest as rows are added.
  it("every row with one states `statementBody`", () => {
    expect(withStatementSlot.length).toBeGreaterThan(0);
    const silent = withStatementSlot.filter(([, r]) => r.statementBody === undefined).map(([n]) => n);
    expect(silent, `${silent.length} row(s) file a 'statement' body slot without saying what it holds`).toEqual([]);
  });

  it("no row states it without having one", () => {
    const have = new Set(withStatementSlot.map(([n]) => n));
    const spurious = Object.entries(NAMES as Record<string, Row>)
      .filter(([n, r]) => r.statementBody !== undefined && !have.has(n))
      .map(([n]) => n);
    expect(spurious).toEqual([]);
  });

  // An update spec's list is a set of STAGE names: a name that is not one could never
  // match the stage `place` asks about, so the allowance would silently never apply.
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
