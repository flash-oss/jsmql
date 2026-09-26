// Phase 4 — POSITION. Which of the seven positions does a node sit in?
//
// Phase 3 needs the answer before it can run, because several sugars mean one
// thing as a STATEMENT and are refused everywhere else:
//   $.items.sort();          → [{ "$set": { "items": { "$sortArray": … } } }]
//   $.a = $.items.sort()     → ".sort() mutates the array … use '.toSorted()'"
// One tree shape gives two meanings. A rewrite blind to position would turn
// the second into a nested assignment and drop the message the row carries.
//
// The answer travels DOWN the tree, one parent-to-property step at a time, so
// a pass that rewrites while it descends always has it. See `mapTreeIn`.

import type { Position } from "../../registry/vocabulary.ts";
import type { BodyPath, BodySlot } from "../rows.ts";
import { blockBodyOf, bodySlotAt, isStageName } from "../rows.ts";
import { chainBase, isContextRef, namedRow, namesSomething, readsAContextRef, staticKey } from "./naming.ts";

/**
 * Where a node stands: one of the seven positions, or one of the three answers
 * that are not positions at all.
 *
 * This uses `{ at: Position }` rather than nine spelled-out members. So a new
 * position in the registry's `Position` becomes a position here on the same day.
 */
export type Where =
  | { at: Position }
  /** The left of `=`, the operand of `delete`, or the callee of a call. It is NAMED, not evaluated. */
  | { at: "target" }
  /** Inside a stage body, part-way down a path the stage's row still owns. */
  | { at: "stageBody"; stage: string; path: BodyPath }
  /** The one entry of a raw stage document `{ $match: … }`, whose value is the body. */
  | { at: "stageEntry"; stage: string };

export const STATEMENT: Where = { at: "statement" };
export const VALUE: Where = { at: "value" };
export const STREAM: Where = { at: "stream" };
export const FILTER: Where = { at: "filter" };
export const WINDOW: Where = { at: "window" };
export const UPDATE_DOC: Where = { at: "updateDoc" };
/**
 * The left of `=`, the operand of `delete`, or the callee of `f(…)`. This is
 * named apart from `value` because none of them is evaluated: each one names a
 * place to write or a thing to call. Calling it a value would let a rule meant
 * for expressions fire on the destination of a write, or fold `f` away in
 * `f(1)` to give `3(1)`.
 */
export const TARGET: Where = { at: "target" };

type Any = { type: string } & Record<string, unknown>;

/** Could a STAGE stand here? The two positions a pipeline element occupies. */
const stageMayStand = (here: Where): boolean => here.at === "statement" || here.at === "stream";

/**
 * The position for a node under a stage body path. An OBJECT keeps descending
 * while a longer key still claims something below. Anything else — a string, a
 * number, an array, a computed spelling — takes the path's own position,
 * because it has no keys for a deeper rule to reach.
 */
function reached(stage: string, path: BodyPath, slot: BodySlot, child: unknown): Where {
  const type = typeof child === "object" && child !== null ? (child as Any).type : undefined;
  if (slot.deeper && type === "ObjectLiteral") return { at: "stageBody", stage, path };
  // A slot reads a bracketed list one way, and reads everything else another way:
  // `whenMatched: [$set(…)]` is a pipeline, `whenMatched: "replace"` is a word.
  return { at: type === "ArrayLiteral" ? slot.at : slot.otherwise };
}

/**
 * What the position becomes on the step from `node` along its property `key`.
 *
 * Every clause is a statement about the LANGUAGE. A clause that needs to know
 * how a stage's body is laid out asks the stage's own row.
 */
export function edge(node: object, key: string, here: Where): Where {
  const n = node as Any;

  // In a `;`-separated program, every element is a statement, whatever it looks like.
  // The statements of an UPDATE DOCUMENT stay in its position. A write there is a
  // field of the document, not a pipeline stage, so no statement sugar rewrites it.
  if (n.type === "Pipeline" && key === "stmts") return here.at === "updateDoc" ? here : STATEMENT;

  // The writes of a `,`-joined run. Each one is a statement in its own right.
  // The run groups them into one stage. It does not make them values.
  if (n.type === "UpdateFilter" && key === "ops") return here.at === "updateDoc" ? here : STATEMENT;

  // `[ $match(…), … ]` is a pipeline only where a statement may stand. The
  // same shape one step further in is an array value.
  if (n.type === "ArrayLiteral" && key === "elements" && here.at === "statement") return STATEMENT;

  // A stage's argument is its BODY, the same for `$match($.a > 1)` and
  // `$$.$match($.a > 1)`. The chained spelling is a MethodCall and names the
  // same row. This applies where a stage may stand, or as a link of a chain
  // rooted in a context reference: the link `$$$.orders.filter(p).$group({…})`
  // is a stage wherever the chain lands, because its receiver is a stream. It
  // does not apply otherwise: `$count` is also an accumulator, and inside
  // `$group` its arguments belong to an operator, not to a body.
  if ((n.type === "OperatorCall" || n.type === "MethodCall") && key === "args") {
    const onStream = n.type === "MethodCall" && readsAContextRef(n.object as object);
    if (stageMayStand(here) || onStream) {
      const stage = namedRow(n);
      if (stage !== null && isStageName(stage)) {
        const slot = bodySlotAt(stage, []);
        if (slot !== undefined) return reached(stage, [], slot, (n.args as readonly unknown[] | undefined)?.[0]);
      }
    }
    // A callee whose row takes a block of STAGES also takes them as an array:
    // in `$$.aggregate([$match(…)])`, each element is a statement.
    if (n.type === "MethodCall" && typeof n.name === "string" && blockBodyOf(n.name) === "stages") return STATEMENT;
  }
  // `{ $match: { … } }` is raw MQL pasted where a stage may stand. Its one entry's
  // value is the body.
  if (n.type === "ObjectLiteral" && key === "entries" && stageMayStand(here)) {
    const stage = namedRow(n);
    if (stage !== null && isStageName(stage)) return { at: "stageEntry", stage };
  }
  if (here.at === "stageEntry") {
    if (n.type !== "KeyValueEntry") return here;
    if (key !== "value") return VALUE;
    const slot = bodySlotAt(here.stage, []);
    return slot === undefined ? VALUE : reached(here.stage, [], slot, n.value);
  }
  // The body's own object literal and its entry list are still the body. Only
  // a step into an entry's VALUE moves one key deeper.
  if (here.at === "stageBody") {
    if (n.type === "ObjectLiteral") return here;
    if (n.type === "KeyValueEntry") {
      if (key !== "value") return here;
      const path: BodyPath = [...here.path, staticKey(n)];
      const slot = bodySlotAt(here.stage, path);
      return slot === undefined ? VALUE : reached(here.stage, path, slot, n.value);
    }
  }

  // The destination of a write, or the callee of a call, names something. It
  // is never evaluated.
  if (namesSomething(n, key)) return TARGET;

  // `$$ = <chain>` — the right-hand side REPLACES the stream, so its top link
  // is a stream link: `$$ = $$.$group(…)` consults `$group`'s body layout the
  // same way `$group(…);` does. Every other parent puts a chain's top link
  // where it puts any value (`$.o = $$$.orders.find(p)` is a value read that
  // the join lowering hoists). The links BELOW the top are streams by the
  // clause after this.
  if (n.type === "AssignExpr" && key === "value") {
    const target = n.target as Any;
    if (target.type === "StreamRef") return STREAM;
  }

  // A chain that bottoms out in a context reference is a STREAM: `$$.filter(p)`,
  // `$$$.orders.find(p)`, `$$$["archive"].find(p)`, wherever the chain stands —
  // as the right of `$$ = …`, as a `$facet` branch, as the argument of `$$.push`.
  // Every link back down the chain is a stream too. The context reference itself
  // is not a stream: `$$` IS the stream it names, but `$$$` and `$$$$` are
  // scopes, and a scope is never evaluated. The chain's arguments are not
  // streams either: the lambda in `$$.filter(d => d.x)` is an ordinary
  // expression over one document.
  if ((n.type === "MethodCall" || n.type === "MemberAccess" || n.type === "IndexAccess") && key === "object") {
    const receiver = n.object as Any;
    if (isContextRef(chainBase(receiver))) {
      return receiver.type === "DatabaseRef" || receiver.type === "ClusterRef" ? VALUE : STREAM;
    }
  }

  // Inside an update document, everything below a statement stays in its
  // position: the arguments of the operators, and the documents and lists
  // under them. So `$each` inside `$push` is read by its update-document cell.
  if (here.at === "updateDoc") return here;

  return VALUE;
}
