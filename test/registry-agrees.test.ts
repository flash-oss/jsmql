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

type Row = {
  kind?: string;
  on?: string | readonly string[];
  where?: readonly Position[];
  only?: readonly Only[];
  params?: unknown;
  iterateeSlots?: Readonly<Record<string, unknown>>;
  replacesDocument?: true;
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

describe("registry — `only` and the positions it qualifies", () => {
  const ONLY: readonly Only[] = ["stageFirst", "stageLast", "update", "afterSort"];

  it("uses every member of the Only vocabulary on at least one row", () => {
    // `afterSort` was declared, documented with an example, and stated by no row
    // — so `$$ = $$.takeWhile(p)` would have emitted the $setWindowFields mongod
    // refuses (Location5339901) instead of the "needs a preceding sort" refusal.
    const unused = ONLY.filter((o) => !rows.some(([, row]) => row.only?.includes(o) === true));
    expect(unused).toEqual([]);
  });

  it("states `only` on rows that can stand as a stage or a chain link", () => {
    // Every Only member qualifies a stage or a link — "first stage", "last
    // stage", "an update-pipeline stage", "a link after a sort". A row that lists
    // neither position has nothing for the rule to qualify.
    const stray: string[] = [];
    for (const [name, row] of rows) {
      if (row.only === undefined || row.only.length === 0) continue;
      const w = row.where ?? [];
      if (!w.includes("stream") && !w.includes("statement")) stray.push(name);
    }
    expect(stray).toEqual([]);
  });

  it("marks `replacesDocument` only on a stage", () => {
    // A document is replaced by a STAGE — `$group`, `$replaceRoot`. On a value row
    // the flag would tell the scope tracker to drop bindings after an expression.
    const stray: string[] = [];
    for (const [name, row] of rows) {
      if (row.replacesDocument !== true) continue;
      if (row.where?.includes("stream") !== true) stray.push(name);
    }
    expect(stray).toEqual([]);
  });
});
