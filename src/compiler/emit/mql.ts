// Phase 5 — EMIT. The MQL shapes that READ a condition, typed to take a Truth.
//
// A lowering builds most of its document freely: `{ $add: [a, b] }` needs no
// help. The exceptions are the truth-reading slots the COMPILER builds —
// `$cond.if`, `$filter.cond`, `$switch.branches[].case`, `$match.$expr`. Each
// takes a `Truth`, so the one bug that class of slot invites — a value dropped
// in unread, where "" or a missing field then means true — is a type error
// naming the missing `truth()` call. A registry row builds its own document
// (the registry imports nothing outside itself) and its cell takes the reading
// it needs as a service, which is the same guarantee by another route.

import type { QueryDoc, Truth } from "../../registry/vocabulary.ts";
import type { MongoVar } from "./names.ts";

/** `{ $cond: { if, then, else } }`. */
export const cond = (test: Truth, then: unknown, otherwise: unknown): unknown => ({
  $cond: { if: test, then, else: otherwise },
});

/** `{ $filter: { input, as, cond[, limit] } }`. */
export const filter = (input: unknown, as: MongoVar, test: Truth, limit?: unknown): unknown => ({
  $filter: limit === undefined ? { input, as, cond: test } : { input, as, cond: test, limit },
});

/**
 * `{ $switch: { branches: [{ case, then }…], default } }`.
 *
 * A test whose every answer is the SAME document decides nothing, so the answer
 * stands on its own: `$.o.keys()` reads an object either way, and the `$type`
 * test around it would only cost bytes.
 */
export const switchOn = (
  branches: readonly { readonly case: Truth; readonly then: unknown }[],
  fallback: unknown,
): unknown => {
  const one = JSON.stringify(fallback);
  if (branches.every((b) => JSON.stringify(b.then) === one)) return fallback;
  return { $switch: { branches: branches.map((b) => ({ case: b.case, then: b.then })), default: fallback } };
};

/** A condition as a query document: `{ $expr: <truth> }`. */
export const matchExpr = (test: Truth): QueryDoc => ({ $expr: test });

/** `{ $let: { vars: { <as>: value }, in } }` — a value bound once for a body that reads it more than once. */
export const letOne = (as: MongoVar, value: unknown, body: unknown): unknown => ({
  $let: { vars: { [as]: value }, in: body },
});
