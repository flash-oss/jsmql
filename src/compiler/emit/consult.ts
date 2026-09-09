// Phase 5 — EMIT. What a row says about one name in one position.
//
// Every phase that touches a name asks this first, and it answers from the row
// alone. That is the whole of the arrangement described in ../CLAUDE.md: the
// registry says what the language HAS, so an ANSWER lives in a row and a
// DOCUMENT is built by code. Nothing here builds a document.
//
// The answer is one of six things, and five of them are already final — a
// refusal, a fallback, a compose-only, an unknown name, a position a row has no
// cell for. Only the sixth needs a lowering to run, which is why the refusal
// surface of the whole language works before any lowering is written.

import type { Family, Position } from "../../registry/vocabulary.ts";
import { NAMES } from "../../registry/names.ts";
import { PRODUCTIONS } from "../../registry/productions.ts";
import type { Where } from "../passes/position.ts";

// Two registries answer this question, because the language has two kinds of
// thing that need answering for. A NAME is an identifier the source writes —
// `sort`, `Math`, `$inc`. A PRODUCTION is a construct — `%`, `===`, `?:`. Both
// carry the same cells, so both are read here and a caller never has to know
// which registry its name came from.
//
// The keys cannot collide: a production is named descriptively (`remainder`,
// never `"%"`) and no row of names.ts uses one of those names.
const ROWS: Readonly<Record<string, Row | undefined>> = Object.assign(Object.create(null), NAMES, PRODUCTIONS);

/** The one cell shape this module reads. Deliberately structural — see below. */
type Cell =
  | { unsupported: string }
  | { fallback: "expr" }
  | { composedInto: readonly string[] }
  | { perFamily: Record<string, Cell> }
  | { byArgs: Readonly<Record<string, unknown>> }
  | Record<string, unknown>;

type Row = { kind: string; where: readonly Position[]; on?: Family | readonly Family[] | "any" } & Record<
  string,
  unknown
>;

/**
 * Which cell of a row answers which position.
 *
 * `expr` and `value` are the same thing under two names — the row spells the
 * cell `expr` and the position is called `value`. The other five match.
 */
const CELL_OF: Readonly<Record<Position, string>> = {
  value: "expr",
  filter: "filter",
  stream: "stream",
  statement: "statement",
  group: "group",
  window: "window",
  updateDoc: "updateDoc",
};

/**
 * The position a `Where` names, or null when it names none.
 *
 * `target`, `stageBody` and `stageEntry` are waypoints, not positions: nothing
 * is evaluated on the left of `=`, and the inside of a stage body is on the way
 * to a position rather than one itself. Answered from `CELL_OF`, so every
 * position the registry has is a position here — a hand-written switch answers
 * for the positions it lists and silently drops every one added after it.
 */
export function positionOf(where: Where): Position | null {
  return where.at in CELL_OF ? (where.at as Position) : null;
}

/** What the row says. Five of the six need no lowering to be final. */
export type Verdict =
  /** No row at all. The caller suggests a near name; the row cannot. */
  | { kind: "unknown"; name: string }
  /**
   * The row's own text. Nothing here writes prose a row could have carried.
   *
   * `needsSubject` means the row carried the REASON only, because one reason
   * serves every spelling that reaches it. `refusalSentence` puts the two
   * together; a caller that prints `message` on its own drops the subject.
   */
  | { kind: "refused"; name: string; position: Position; message: string; needsSubject: boolean }
  /** Legal, with no native form here: wrap the value form (`$expr` in a filter). */
  | { kind: "fallback"; name: string; position: Position }
  /** Legal only folded into another construct, which is named. */
  | { kind: "composedOnly"; name: string; position: Position; owners: readonly string[] }
  /** A lowering must run. `cell` is handed on untouched; only emit/ reads it. */
  | { kind: "lower"; name: string; position: Position; cell: unknown }
  /**
   * The row answers PER FAMILY and the receiver's family was not supplied, or was
   * not one the row lists. Not an error on its own: a caller that cannot prove
   * the family builds a runtime dispatch from the branches, with the row's own
   * `uncertain` as its default — handed on untouched, as `cell` is for `lower`.
   */
  | {
      kind: "perFamily";
      name: string;
      position: Position;
      branches: Readonly<Record<string, unknown>>;
      uncertain: unknown;
    }
  /**
   * The row has no cell for this position, which is not the same as refusing it.
   * Only a MongoDB row has an `updateDoc` cell, because only a MongoDB operator
   * is ever specific to an update document: `$.views++` is a STATEMENT, and
   * whether the program lowers to `{$inc:…}` or to `{$set:…}` is a property of
   * the whole program, not of that node.
   */
  | { kind: "noCell"; name: string; position: Position }
  /**
   * A cell the row hands to a PASS — `inCode(<file>)`. There is nothing here to
   * lower: the pass either rewrote the node already or left it, and a caller that
   * meets this verdict must read the node the way its other cells describe.
   */
  | { kind: "inCode"; name: string; position: Position; file: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** The families a row lists, widened so a caller never checks the shape. */
function familiesOf(row: Row): readonly Family[] | "any" | undefined {
  const on = row.on;
  if (on === undefined) return undefined;
  if (on === "any") return "any";
  return Array.isArray(on) ? on : [on as Family];
}

function readCell(name: string, position: Position, cell: unknown): Verdict {
  if (!isObj(cell)) return { kind: "lower", name, position, cell };
  if (typeof cell.unsupported === "string") {
    return {
      kind: "refused",
      name,
      position,
      message: cell.unsupported,
      needsSubject: cell.subjectFromCaller === true,
    };
  }
  if (typeof cell.inCode === "string") return { kind: "inCode", name, position, file: cell.inCode };
  if (cell.fallback === "expr") return { kind: "fallback", name, position };
  if (Array.isArray(cell.composedInto)) {
    return { kind: "composedOnly", name, position, owners: cell.composedInto as readonly string[] };
  }
  return { kind: "lower", name, position, cell };
}

/**
 * What the row for `name` says about `position`.
 *
 * `family` resolves a `perFamily` cell. Omit it when the receiver's family is
 * not provable, and the branches come back for the caller to dispatch on.
 */
export function consult(name: string, position: Position, family?: Family): Verdict {
  const row = ROWS[name];
  if (row === undefined) return { kind: "unknown", name };

  const key = CELL_OF[position];
  if (!(key in row)) return { kind: "noCell", name, position };
  const cell = row[key];

  if (isObj(cell) && isObj(cell.perFamily)) {
    const branches = cell.perFamily as Record<string, unknown>;
    if (family !== undefined && family in branches) return readCell(name, position, branches[family]);
    return { kind: "perFamily", name, position, branches, uncertain: cell.uncertain };
  }
  return readCell(name, position, cell);
}

/**
 * The refusal to show the user: the row's reason, with the subject the caller
 * supplies when the row left one out.
 *
 * `subject` is how the source SPELLED it — `'.toReversed(...)'`, `'$$.length'`.
 * The caller knows the spelling; the row cannot, because one row answers for
 * every spelling that reaches it.
 */
export function refusalSentence(
  verdict: Extract<Verdict, { kind: "refused" }>,
  subject: string,
  container: string,
): string {
  if (!verdict.needsSubject) return verdict.message;
  return `${subject} isn't available on ${container} — ${verdict.message}`;
}

/** Does the row list this position at all? The claim `where` makes, unresolved. */
export function listedIn(name: string, position: Position): boolean {
  return ROWS[name]?.where.includes(position) === true;
}

/** The receiver families a name applies to, for a caller building a dispatch. */
export function familiesFor(name: string): readonly Family[] | "any" | undefined {
  const row = ROWS[name];
  return row === undefined ? undefined : familiesOf(row);
}

/**
 * Every NAME the registry holds, for a `didYouMean` over a real closed set.
 *
 * Names only. A production is a construct, not something a user can misspell.
 */
export function everyName(): readonly string[] {
  return Object.keys(NAMES);
}
