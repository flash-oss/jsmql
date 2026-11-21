import type { Expr } from "../../registry/ast.ts";
import { canonicalBsonName } from "../../bson.ts";
import { namespaceNames } from "../rows.ts";
import { readLiteral } from "./literal.ts";

export type DateReading = { ok: true; value: Date | number } | { ok: false };

const NO: DateReading = { ok: false };

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

function instantOf(args: readonly unknown[]): Date | null {
  if (args.length === 0) return null;
  if (args.length === 1) {
    const [a] = args;
    if (typeof a === "number") return Number.isInteger(a) && !Number.isNaN(new Date(a).getTime()) ? new Date(a) : null;
    if (typeof a !== "string") return null;
    const parsed = new Date(a);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (args.length > 7 || !args.every((v) => typeof v === "number" && Number.isInteger(v))) return null;
  const [year, month, day = 1, hour = 0, minute = 0, second = 0, ms = 0] = args as number[];
  const date = new Date(Date.UTC(year, month, day, hour, minute, second, ms));
  return Number.isNaN(date.getTime()) ? null : date;
}

const isDateName = (name: string): boolean => canonicalBsonName(name) === "Date";

export function readDateLiteral(node: Expr, isBound: (name: string) => boolean): DateReading {
  if (node.type === "CallExpression" && node.callee.type === "Ident") {
    const name = node.callee.name;
    if (!isDateName(name) || isBound(name)) return NO;
    const args = literalsOf(node.args);
    const date = args === null ? null : instantOf(args);
    return date === null ? NO : { ok: true, value: date };
  }
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
