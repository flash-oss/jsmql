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

import type { Position } from "../../registry/vocabulary.ts";
import type { BodyPath, BodySlot } from "../rows.ts";
import { bodySlotAt } from "../rows.ts";

/**
 * Where a node stands: one of the seven positions, or one of the two answers
 * that are not positions at all.
 *
 * `{ at: Position }` rather than nine spelled-out members, so a new position in
 * the registry's `Position` is a position here on the same day.
 */
export type Where =
  | { at: Position }
  | { at: "target" }
  /** Inside a stage body, part-way down a path the stage's row still owns. */
  | { at: "stageBody"; stage: string; path: BodyPath };

export const STATEMENT: Where = { at: "statement" };
export const VALUE: Where = { at: "value" };
export const STREAM: Where = { at: "stream" };
export const FILTER: Where = { at: "filter" };
export const GROUP: Where = { at: "group" };
export const WINDOW: Where = { at: "window" };
export const UPDATE_DOC: Where = { at: "updateDoc" };
/**
 * The left of `=`, or the operand of `delete`. Named apart from `value` because
 * it is not evaluated: it names a place to write. Calling it a value would let a
 * rule meant for expressions fire on the destination of a write.
 */
export const TARGET: Where = { at: "target" };

type Any = { type: string } & Record<string, unknown>;

/** The static key an object entry was written with, or null if computed. */
function staticKey(entry: Any): string | null {
  const key = entry.key as { kind?: string; name?: string } | undefined;
  return key?.kind === "static" && typeof key.name === "string" ? key.name : null;
}

/** A resolved slot, or the waypoint that says "one more step down". */
function reached(stage: string, path: BodyPath, slot: BodySlot): Where {
  return "deeper" in slot ? { at: "stageBody", stage, path } : { at: slot.at };
}

/**
 * What the position becomes on the step from `node` along its property `key`.
 *
 * Every clause is a statement about the LANGUAGE, and the clauses that need to
 * know how a stage's body is laid out ask the stage's own row.
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

  // A stage's argument is its BODY. `$match($.a > 1)` is a query predicate,
  // `$group({ … })` mixes an expression with accumulators, and only the row can
  // say which is which — so ask it, and keep asking as the walk descends.
  if (n.type === "OperatorCall" && key === "args" && typeof n.name === "string") {
    const slot = bodySlotAt(n.name, []);
    if (slot !== undefined) return reached(n.name, [], slot);
  }
  // The body's own object literal and its entry list are still the body; only
  // stepping into an entry's VALUE moves one key deeper.
  if (here.at === "stageBody") {
    if (n.type === "ObjectLiteral") return here;
    if (n.type === "KeyValueEntry") {
      if (key !== "value") return here;
      const path: BodyPath = [...here.path, staticKey(n)];
      const slot = bodySlotAt(here.stage, path);
      return slot === undefined ? VALUE : reached(here.stage, path, slot);
    }
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
