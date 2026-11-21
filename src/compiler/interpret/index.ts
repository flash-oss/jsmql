import {
  Failed,
  isPlain,
  isValue,
  holdsNumberText,
  isWellFormed,
  MAX_DEPTH,
  MAX_STEPS,
  NO,
  ok,
  spellable,
  unspellable,
} from "./values.ts";
import type { Answer, Walk } from "./values.ts";
import { RULES } from "./rules.ts";
import { setKey } from "../../registry/mql.ts";

export type Result = { ok: true; value: unknown } | { ok: false; unspellable?: string };

type Scope = { readonly vars: ReadonlyMap<string, unknown>; readonly parent: Scope | null };

type Budget = { steps: number; sets: WeakSet<object> | null };

type Unordered = (document: object) => boolean;

function lookup(scope: Scope | null, name: string): { found: boolean; value?: unknown } {
  for (let s = scope; s !== null; s = s.parent) if (s.vars.has(name)) return { found: true, value: s.vars.get(name) };
  return { found: false };
}

const VARIABLE = /^\$\$([a-z][A-Za-z0-9_]*)((?:\.[^.]+)*)$/;

function variable(text: string, scope: Scope | null, unordered: Unordered): Answer {
  const match = VARIABLE.exec(text);
  if (match === null) return NO;
  const bound = lookup(scope, match[1]);
  if (!bound.found) return NO;
  if (bound.value instanceof Failed) return bound.value.answer;
  let value = bound.value;
  for (const segment of match[2] === "" ? [] : match[2].slice(1).split(".")) {
    if (!isPlain(value) || !Object.prototype.hasOwnProperty.call(value, segment)) return NO;
    value = value[segment];
  }
  return spellable(value, unordered);
}

function holdsSet(budget: Budget, value: unknown): boolean {
  if (budget.sets === null || typeof value !== "object" || value === null) return false;
  if (budget.sets.has(value)) return true;
  if (Array.isArray(value)) return value.some((v) => holdsSet(budget, v));
  return isPlain(value) && Object.values(value).some((v) => holdsSet(budget, v));
}

function step(budget: Budget, scope: Scope | null, depth: number, node: unknown): Answer {
  if (depth > MAX_DEPTH || ++budget.steps > MAX_STEPS) return NO;
  const unordered: Unordered = (v) => budget.sets?.has(v) ?? false;
  const scoped = (bind?: Readonly<Record<string, unknown>>): Scope | null =>
    bind === undefined ? scope : { vars: new Map(Object.entries(bind)), parent: scope };
  const below: Walk = {
    raw: (child, bind) => step(budget, scoped(bind), depth + 1, child),
    at: (child, bind) => {
      const a = step(budget, scoped(bind), depth + 1, child);
      return a.ok && holdsSet(budget, a.value) ? NO : a;
    },
    holdsSet: (value) => holdsSet(budget, value),
    isSet: (value) => typeof value === "object" && value !== null && (budget.sets?.has(value) ?? false),
    markSet: (array) => {
      (budget.sets ??= new WeakSet()).add(array);
      return array;
    },
  };

  if (typeof node === "string") {
    if (node.startsWith("$")) return node.startsWith("$$") ? variable(node, scope, unordered) : NO;
    return isWellFormed(node) ? spellable(node) : NO;
  }

  if (Array.isArray(node)) {
    const out: unknown[] = [];
    for (const element of node) {
      const a = below.raw(element);
      if (!a.ok) return a;
      out.push(a.value);
    }
    return spellable(out, unordered);
  }

  if (isPlain(node)) {
    const keys = Object.keys(node);
    const operators = keys.filter((k) => k.startsWith("$"));
    if (operators.length === 0) {
      if (keys.some((k) => k === "" || k.includes(".") || k.includes("\u0000"))) return NO;
      const out: Record<string, unknown> = {};
      for (const key of keys) {
        const a = below.raw(node[key]);
        if (!a.ok) return a;
        setKey(out, key, a.value);
      }
      return spellable(out, unordered);
    }
    if (keys.length !== 1) return NO;
    const rule = Object.prototype.hasOwnProperty.call(RULES, keys[0]) ? RULES[keys[0]] : undefined;
    if (rule === undefined) return NO;
    const answer = rule(node[keys[0]], below);
    if (!answer.ok) return answer;
    if (Array.isArray(answer.value)) budget.steps += answer.value.length;
    return spellable(answer.value, unordered);
  }

  if (typeof node === "number" && !Number.isFinite(node)) return unspellable(String(node));
  return isValue(node) ? spellable(node) : NO;
}

export function interpret(mql: unknown): Result {
  try {
    const answer = step({ steps: 0, sets: null }, null, 0, mql);
    if (answer.ok && holdsNumberText(answer.value)) return NO;
    return answer.ok ? ok(answer.value) : answer;
  } catch (e) {
    if (e instanceof RangeError) return NO;
    throw e;
  }
}
