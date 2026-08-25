// Phase 4 — POSITION. Which of the seven positions does a node sit in?
//
// Phase 3 needs the answer before it can run, because several sugars mean one
// thing as a STATEMENT and are refused everywhere else:
//   $.items.sort();          → [{ "$set": { "items": { "$sortArray": … } } }]
//   $.a = $.items.sort()     → ".sort() mutates the array … use '.toSorted()'"
// One tree shape, two meanings. A rewrite blind to position would turn the second
// into a nested assignment and throw away the message the row carries.
//
// The answer travels DOWN the tree, one parent-to-property step at a time, so a
// pass that rewrites while it descends always has it. See `mapTreeIn`.

import { subPipelineFieldsOf } from "../rows.ts";

/**
 * Where a node stands.
 *
 * Two of the seven positions so far, plus the one waypoint that is not a position
 * at all: `stageBody` is the inside of `$lookup({ … })`, where the next step
 * decides between a sub-pipeline (statements) and an ordinary field (a value).
 */
export type Where = { at: "statement" } | { at: "value" } | { at: "stageBody"; stage: string };

export const STATEMENT: Where = { at: "statement" };
export const VALUE: Where = { at: "value" };

type Any = { type: string } & Record<string, unknown>;

/** The static key an object entry was written with, or undefined if computed. */
function staticKey(entry: Any): string | undefined {
  const key = entry.key as { kind?: string; name?: string } | undefined;
  return key?.kind === "static" && typeof key.name === "string" ? key.name : undefined;
}

/**
 * What the position becomes on the step from `node` along its property `key`.
 *
 * Every clause is a statement about the LANGUAGE, and the one clause that needs
 * to know which key of a stage holds a pipeline asks the stage's own row.
 */
export function edge(node: object, key: string, here: Where): Where {
  const n = node as Any;

  // A `;`-separated program: every element is a statement, whatever it looks like.
  if (n.type === "Pipeline" && key === "stmts") return STATEMENT;

  // `[ $match(…), … ]` is a pipeline only where a statement may stand. The very
  // same shape one step further in is an array value.
  if (n.type === "ArrayLiteral" && key === "elements" && here.at === "statement") return STATEMENT;

  // `$lookup({ … })` — enter the body, but decide nothing yet.
  if (n.type === "OperatorCall" && key === "args" && typeof n.name === "string") {
    const fields = subPipelineFieldsOf(n.name);
    if (fields !== undefined && fields.length > 0) return { at: "stageBody", stage: n.name };
  }
  // The body's own object literal and its entry list are still the body.
  if (here.at === "stageBody" && (n.type === "ObjectLiteral" || n.type === "KeyValueEntry")) {
    if (n.type === "ObjectLiteral") return here;
    if (key !== "value") return here;
    const name = staticKey(n);
    if (name === undefined) return VALUE;
    const fields = subPipelineFieldsOf(here.stage) ?? [];
    // `["*"]` is `$facet`, where every key holds a pipeline.
    return fields.includes("*") || fields.includes(name) ? STATEMENT : VALUE;
  }

  return VALUE;
}
