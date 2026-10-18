// An in-process interpreter for MQL expressions.
//
// A constant is an expression whose lowered MQL reads nothing from the document and
// nothing from the environment. `interpret` takes such an MQL expression and answers
// with its VALUE, or with "not constant". One rule for each MongoDB operator
// (rules.ts) replaces a hand-written JavaScript function for each method.
//
// THE ONE INVARIANT: a value that the interpreter answers equals the value that the
// server answers for the same MQL. Where the server answer is not exactly specified,
// the operator is refused. A refusal is never a failure: the expression then stays a
// runtime expression. The interpreter runs on MQL that already passed the kind check
// of HR7, so it has no path for a type error: a wrong kind is a refusal.
//
// See src/compiler/interpret/CLAUDE.md.

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

/** The variables in scope. A scope holds the variables of one operator and points at the scope around it. */
type Scope = { readonly vars: ReadonlyMap<string, unknown>; readonly parent: Scope | null };

/** What one call shares: the count of the nodes visited so far, and the values whose order is unspecified. */
type Budget = { steps: number; sets: WeakSet<object> | null };

/** Is the document one whose key order is unspecified? */
type Unordered = (document: object) => boolean;

function lookup(scope: Scope | null, name: string): { found: boolean; value?: unknown } {
  for (let s = scope; s !== null; s = s.parent) if (s.vars.has(name)) return { found: true, value: s.vars.get(name) };
  return { found: false };
}

/** `$$name` or `$$name.path`: a variable that an operator around it bound, and then a path into it. */
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

/** Does the value hold a value of unspecified order, at any depth? */
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
      // A key with a dot, a null byte or no characters is not a name that an expression can hold.
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
    // An array that a rule builds costs one step for each element. A reduce that grows a list
    // with a `$concatArrays` would otherwise copy it again at every step.
    if (Array.isArray(answer.value)) budget.steps += answer.value.length;
    return spellable(answer.value, unordered);
  }

  if (typeof node === "number" && !Number.isFinite(node)) return unspellable(String(node));
  return isValue(node) ? spellable(node) : NO;
}

/**
 * The value of an MQL expression, or the reason that there is none.
 *
 * A literal is its own value. A string that starts with `$` is a field path or a system
 * variable, so it has no value, unless it names a variable that a `$let`,
 * `$map`, `$filter` or `$reduce` bound. `{ $literal: v }` is `v`. An object with one
 * `$` key is an operator call, and an object with a `$` key beside other keys is not an
 * expression. A NaN or an infinity in a part that the answer needs gives `unspellable`, and the caller reports it.
 */
export function interpret(mql: unknown): Result {
  try {
    const answer = step({ steps: 0, sets: null }, null, 0, mql);
    // A `NumberText` has no text to write, so an answer that holds one is a refusal.
    if (answer.ok && holdsNumberText(answer.value)) return NO;
    return answer.ok ? ok(answer.value) : answer;
  } catch (e) {
    // A stack overflow is the one error that a deep tree can raise. It is a refusal.
    if (e instanceof RangeError) return NO;
    throw e;
  }
}
