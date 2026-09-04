// Phase 5 — EMIT. The MQL shapes that READ a condition, typed to take a Truth.
//
// A lowering builds most of its document freely: `{ $add: [a, b] }` needs no
// help. The exceptions are the slots MongoDB evaluates for truth — `$cond.if`,
// `$filter.cond`, `$switch.branches[].case`, the operand of `$anyElementTrue` /
// `$allElementsTrue`, `$match.$expr`. Each of those is built here and nowhere
// else, and each takes a `Truth`, so the one bug that class of slot invites — a
// value dropped in unread, where "" or a missing field then means true — is a
// type error naming the missing `truth()` call.

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

/** `{ $switch: { branches: [{ case, then }…], default } }`. */
export const switchOn = (
  branches: readonly { readonly case: Truth; readonly then: unknown }[],
  fallback: unknown,
): unknown => ({ $switch: { branches: branches.map((b) => ({ case: b.case, then: b.then })), default: fallback } });

/** `{ $anyElementTrue: <array of truths> }` — `.some(pred)`. */
export const anyElementTrue = (truths: unknown): unknown => ({ $anyElementTrue: truths });

/** `{ $allElementsTrue: <array of truths> }` — `.every(pred)`. */
export const allElementsTrue = (truths: unknown): unknown => ({ $allElementsTrue: truths });

/** `{ $map: { input, as, in } }` whose body is a Truth — the operand `.some` / `.every` read. */
export const mapToTruth = (input: unknown, as: MongoVar, body: Truth): unknown => ({ $map: { input, as, in: body } });

/** A condition as a query document: `{ $expr: <truth> }`. */
export const matchExpr = (test: Truth): QueryDoc => ({ $expr: test });

/** `{ $let: { vars: { <as>: value }, in } }` — a value bound once for a body that reads it more than once. */
export const letOne = (as: MongoVar, value: unknown, body: unknown): unknown => ({
  $let: { vars: { [as]: value }, in: body },
});
