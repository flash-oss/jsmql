// Phase 5 — EMIT. The MQL shapes that READ a condition, typed to take a Truth.
//
// A lowering builds most of its document freely: `{ $add: [a, b] }` needs no
// help. The exceptions are the truth-reading slots the COMPILER builds —
// `$cond.if`, `$filter.cond`, `$switch.branches[].case`, `$match.$expr`. Each
// slot takes a `Truth`. This class of slot invites one bug: a value that
// lands in unread, where "" or a missing field then means true. The type
// system reports this bug as a type error, and names the missing `truth()`
// call. A row of the registry builds its own document; the registry imports
// nothing outside itself. Its cell takes the reading it needs as a service.
// This gives the same guarantee by another route.

import type { QueryDoc, Truth } from "../../registry/vocabulary.ts";
import type { MongoVar } from "./names.ts";
import { constantOf } from "./mode.ts";

/** `{ $cond: { if, then, else } }`. A constant test picks its branch at compile time. */
export const cond = (test: Truth, then: unknown, otherwise: unknown): unknown => {
  const c = constantOf(test);
  if (c !== null) return c ? then : otherwise;
  return { $cond: { if: test, then, else: otherwise } };
};

/** `{ $filter: { input, as, cond[, limit] } }`. A test that is always true keeps the whole input; one that is always false keeps nothing. */
export const filter = (input: unknown, as: MongoVar, test: Truth, limit?: unknown): unknown => {
  const c = constantOf(test);
  if (c === false) return [];
  if (c === true && limit === undefined) return input;
  return { $filter: limit === undefined ? { input, as, cond: test } : { input, as, cond: test, limit } };
};

/** The branches a `$switch` keeps: a case that is always false goes; a case that is always true ends the list and becomes the default. */
const liveBranches = (
  branches: readonly { readonly case: Truth; readonly then: unknown }[],
): { readonly kept: { readonly case: Truth; readonly then: unknown }[]; readonly decided: unknown | undefined } => {
  const kept: { readonly case: Truth; readonly then: unknown }[] = [];
  for (const b of branches) {
    const c = constantOf(b.case);
    if (c === false) continue;
    if (c === true) return { kept, decided: b.then };
    kept.push(b);
  }
  return { kept, decided: undefined };
};

/**
 * `{ $switch: { branches: [{ case, then }…], default } }`.
 *
 * A test whose every answer is the SAME document decides nothing. So the
 * answer stands on its own: `$.o.keys()` reads an object either way, and a
 * `$type` test around it would only cost bytes.
 */
export const switchOn = (
  candidates: readonly { readonly case: Truth; readonly then: unknown }[],
  otherwise: unknown,
): unknown => {
  const { kept: branches, decided } = liveBranches(candidates);
  const fallback = decided === undefined ? otherwise : decided;
  const one = JSON.stringify(fallback);
  if (branches.every((b) => JSON.stringify(b.then) === one)) return fallback;
  return { $switch: { branches: branches.map((b) => ({ case: b.case, then: b.then })), default: fallback } };
};

/**
 * A `$switch` whose branches cover every value that can reach it, so it states no
 * default. Never a `$cond`: MEASURED, the server optimises a `$cond`'s branches
 * BEFORE it reads the test, so `{ $cond: [<is array>, { $size: v }, { $strLenCP: v }] }`
 * over a constant `v` — a `$let` variable, a `$literal` — fails with "Failed to
 * optimize pipeline", while the same branches under `$switch` run on every receiver.
 */
export const switchOver = (candidates: readonly { readonly case: Truth; readonly then: unknown }[]): unknown => {
  const { kept: branches, decided } = liveBranches(candidates);
  if (decided !== undefined) return switchOn(branches, decided);
  return { $switch: { branches: branches.map((b) => ({ case: b.case, then: b.then })) } };
};

/** A condition as a query document: `{ $expr: <truth> }`. */
export const matchExpr = (test: Truth): QueryDoc => ({ $expr: test });

/** `{ $let: { vars: { <as>: value }, in } }` — a value bound once for a body that reads it more than once. */
export const letOne = (as: MongoVar, value: unknown, body: unknown): unknown => ({
  $let: { vars: { [as]: value }, in: body },
});

/**
 * Does this lowered MQL read `ref` — a field path (`"$__jsmql.var.a"`) or a
 * variable (`"$$a"`)? A declarator may share a stage with the ones beside it
 * ONLY when it reads none of them. A `$set` evaluates every field against the
 * stage's INPUT document. A `$let` evaluates every var in the ENCLOSING scope,
 * so a sibling bound alongside is not there yet. The function matches the
 * whole reference or a field under it, never a longer name that merely
 * starts the same way.
 */
export const readsRef = (mql: unknown, ref: string): boolean => {
  if (typeof mql === "string") return mql === ref || mql.startsWith(`${ref}.`);
  if (Array.isArray(mql)) return mql.some((m) => readsRef(m, ref));
  if (mql !== null && typeof mql === "object") return Object.values(mql).some((m) => readsRef(m, ref));
  return false;
};
