import type { Arity, Family, Position } from "../../registry/vocabulary.ts";
import { NAMES } from "../../registry/names.ts";
import { suggestedAs } from "../rows.ts";
import { PRODUCTIONS } from "../../registry/productions.ts";
import type { Where } from "../passes/position.ts";

const ROWS: Readonly<Record<string, Row | undefined>> = Object.assign(Object.create(null), NAMES, PRODUCTIONS);

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

const CELL_OF: Readonly<Record<Position, string>> = {
  value: "expr",
  filter: "filter",
  stream: "stream",
  statement: "statement",
  group: "group",
  window: "window",
  updateDoc: "updateDoc",
};

export function positionOf(where: Where): Position | null {
  return where.at in CELL_OF ? (where.at as Position) : null;
}

export type Verdict =
  | { kind: "unknown"; name: string }
  | { kind: "refused"; name: string; position: Position; message: string; needsSubject: boolean }
  | { kind: "fallback"; name: string; position: Position }
  | { kind: "composedOnly"; name: string; position: Position; owners: readonly string[] }
  | { kind: "lower"; name: string; position: Position; cell: unknown }
  | { kind: "perFamily"; name: string; position: Position; branches: Readonly<Record<string, unknown>> }
  | { kind: "noCell"; name: string; position: Position }
  | { kind: "inCode"; name: string; position: Position; file: string; args: Arity | undefined };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

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
  if (typeof cell.inCode === "string") {
    return { kind: "inCode", name, position, file: cell.inCode, args: cell.args as Arity | undefined };
  }
  if (cell.fallback === "expr") return { kind: "fallback", name, position };
  if (Array.isArray(cell.composedInto)) {
    return { kind: "composedOnly", name, position, owners: cell.composedInto as readonly string[] };
  }
  return { kind: "lower", name, position, cell };
}

export function consult(name: string, position: Position, family?: Family): Verdict {
  const row = ROWS[name];
  if (row === undefined) return { kind: "unknown", name };

  const key = CELL_OF[position];
  if (!(key in row)) return { kind: "noCell", name, position };
  const cell = row[key];

  if (isObj(cell) && isObj(cell.perFamily)) {
    const branches = cell.perFamily as Record<string, unknown>;
    if (family !== undefined && family in branches) return readCell(name, position, branches[family]);
    return { kind: "perFamily", name, position, branches };
  }
  return readCell(name, position, cell);
}

export function refusalSentence(
  verdict: Extract<Verdict, { kind: "refused" }>,
  subject: string,
  container: string,
): string {
  if (!verdict.needsSubject) return verdict.message;
  return `${subject} isn't available on ${container} — ${verdict.message}`;
}

export function listedIn(name: string, position: Position): boolean {
  return ROWS[name]?.where.includes(position) === true;
}

export function familiesFor(name: string): readonly Family[] | "any" | undefined {
  const row = ROWS[name];
  return row === undefined ? undefined : familiesOf(row);
}

export function everyName(): readonly string[] {
  return Object.keys(NAMES);
}

export function everyMethodName(): readonly string[] {
  const namespaces = new Set(
    Object.entries(NAMES)
      .filter(([, r]) => (r as { provides?: unknown }).provides !== undefined)
      .map(([n]) => n),
  );
  return everyName().filter((n) => {
    if (n.startsWith("$") || suggestedAs(n) === undefined) return false;
    const on = familiesFor(n);
    return on === "any" || (on !== undefined && on.some((f) => !namespaces.has(f)));
  });
}
