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
 * Three of the seven positions so far, plus the one waypoint that is not a
 * position at all: `stageBody` is the inside of `$lookup({ … })`, where the next
 * step decides between a sub-pipeline (statements) and an ordinary field.
 *
 * The four still missing — `filter`, `group`, `window`, `updateDoc` — are not
 * edge decisions in the same way. `filter` and `updateDoc` are properties of the
 * whole PROGRAM, chosen once at the root; the other two sit inside a stage body
 * whose accumulator slots the stage's row has yet to state.
 */
export type Where =
  | { at: "statement" }
  | { at: "value" }
  | { at: "stream" }
  | { at: "target" }
  | { at: "stageBody"; stage: string };

export const STATEMENT: Where = { at: "statement" };
export const VALUE: Where = { at: "value" };
export const STREAM: Where = { at: "stream" };
/**
 * The left of `=`, or the operand of `delete`. Named apart from `value` because
 * it is not evaluated: it names a place to write. Calling it a value would let a
 * rule meant for expressions fire on the destination of a write.
 */
export const TARGET: Where = { at: "target" };

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

  // The writes of a `,`-joined run. Each is a statement in its own right — the
  // run groups them into one stage, it does not make them values.
  if (n.type === "UpdateFilter" && key === "ops") return STATEMENT;

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

  // The destination of a write names a place; it is never evaluated.
  if ((n.type === "AssignExpr" || n.type === "DeleteStmt") && key === "target") return TARGET;

  // `$$ = <chain>` — the right-hand side is a STREAM of documents, and every
  // link back down the chain is one too. Its arguments are not: the lambda in
  // `$$.filter(d => d.x)` is an ordinary expression over one document.
  if (n.type === "AssignExpr" && key === "value") {
    const target = n.target as { type?: string } | undefined;
    if (target?.type === "CollectionRef") return STREAM;
  }
  if (here.at === "stream" && n.type === "MethodCall" && key === "object") return STREAM;

  return VALUE;
}
