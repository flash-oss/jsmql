// A DATE LITERAL: a date that the source spells with literal parts. The constant engine
// reads it before any lowering, because the server cannot compute some of these:
// `{ $toDate: 0 }` fails there (the driver sends an integer as an int), so the lowering of
// `new Date(0)` has no value that the interpreter can give.
//
//   new Date(0)                          the instant at millisecond 0
//   new Date("2026-01-01")               the instant that the string names
//   new Date(2026, 1, 1)                 the parts, in UTC
//   Date(…)                              the same instants, with no `new`
//   Date.UTC(2026, 1, 1)                 the same instant, as a number of milliseconds
//
// The calendar-parts form counts months from ZERO and rolls an out-of-range part over,
// exactly as JavaScript does: `new Date(2020, 1, 1)` is February, and `new Date(2024, 12, 1)`
// is January 2025. The runtime cell adds one for `$dateFromParts`, which counts from one
// and rolls over the same way. See docs/specs/constant-engine.md.

import type { Expr } from "../../registry/ast.ts";
import { canonicalBsonName } from "../../bson.ts";
import { namespaceNames } from "../rows.ts";
import { readLiteral } from "./literal.ts";

/** What the reader answers: the date, the number of milliseconds, or that the node is no date literal. */
export type DateReading = { ok: true; value: Date | number } | { ok: false };

const NO: DateReading = { ok: false };

/** The values of literal arguments, or null when one argument is not a literal. */
function literalsOf(args: readonly { type: string }[]): unknown[] | null {
  const out: unknown[] = [];
  for (const a of args) {
    if (a.type === "SpreadElement") return null;
    const r = readLiteral(a as Expr);
    if (!r.ok) return null;
    out.push(r.value);
  }
  return out;
}

/** The instant of `new Date(…)` with literal arguments, or null where the call has no date constant. */
function instantOf(args: readonly unknown[]): Date | null {
  // `new Date()` reads the clock, so it is never a constant.
  if (args.length === 0) return null;
  if (args.length === 1) {
    const [a] = args;
    // A count of milliseconds is an integer. The row refuses a fraction with a position.
    if (typeof a === "number") return Number.isInteger(a) && !Number.isNaN(new Date(a).getTime()) ? new Date(a) : null;
    if (typeof a !== "string") return null;
    const parsed = new Date(a);
    // An unparsable string is an error that the row raises with a position.
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (args.length > 7 || !args.every((v) => typeof v === "number" && Number.isInteger(v))) return null;
  const [year, month, day = 1, hour = 0, minute = 0, second = 0, ms = 0] = args as number[];
  const date = new Date(Date.UTC(year, month, day, hour, minute, second, ms));
  return Number.isNaN(date.getTime()) ? null : date;
}

const isDateName = (name: string): boolean => canonicalBsonName(name) === "Date";

/**
 * The date or the number of milliseconds that `node` spells, or `{ ok: false }`.
 * `isBound` says whether the program binds a name, which then is no global.
 */
export function readDateLiteral(node: Expr, isBound: (name: string) => boolean): DateReading {
  if ((node.type === "NewExpression" || node.type === "CallExpression") && node.callee.type === "Ident") {
    const name = node.callee.name;
    if (!isDateName(name) || isBound(name)) return NO;
    const args = literalsOf(node.args);
    const date = args === null ? null : instantOf(args);
    return date === null ? NO : { ok: true, value: date };
  }
  // `Date.UTC(…)`: ONE number is a YEAR here, where `new Date(n)` reads it as milliseconds.
  // The call goes through the parts form, so the two spellings cannot disagree.
  if (node.type === "MethodCall" && node.name === "UTC" && node.object.type === "Ident") {
    const on = node.object.name;
    if (!isDateName(on) || !namespaceNames().has(on) || isBound(on)) return NO;
    const args = literalsOf(node.args);
    if (args === null) return NO;
    const parts = args.length === 1 && typeof args[0] === "number" ? [args[0], 0] : args;
    const date = parts.length < 2 ? null : instantOf(parts);
    return date === null ? NO : { ok: true, value: date.getTime() };
  }
  return NO;
}
