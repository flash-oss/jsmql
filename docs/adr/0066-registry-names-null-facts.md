# 0066. The null and missing facts on a row, and how each is measured

Status: Accepted
Applies to: `src/registry/names.ts`

## Context

HR5 reads a null or missing receiver as a safe value under a dot. The emitter must not add an `$ifNull` or `$cond` guard where the server already gives the right answer. The meaning of each fact, and the guard that it removes, is in [types.md § Presence](../specs/types.md#presence).

## Decision

A row states `neverNull`, `readsNullAsEmpty`, `nullReceiverAs` and `passesNull` only from a measurement on mongod, never from a guess. The measurements:

- `neverNull: true`: `.map` states it. `.find` does not, because the element can be missing. On a `mongo` row, `$range` of two numbers is an array.
- `neverNull: "always"`: `$.a.intersection($.b)` with no `b` is `[]`, and `$.a.has($.x)` with no `x` is `false`. `{ $eq: ["$nope", 1] }` is false, `{ $toUpper: "$nope" }` is `""`, and `{ $sum: "$nope" }` is 0.
- `readsNullAsEmpty`: `{ $sum: null }` and `{ $sum: [] }` are both 0. `$avg`, `$max` and `$min` answer null for both. `.join()` guards its own answer, so a null receiver and `[]` both give `""`.
- `nullReceiverAs`: `{ $ln: 0 }` stops the command, so `.log()` reads a missing receiver as 1. `$.nope.log()` is 0, as `(1).log()` is.
- `passesNull`: `{ $max: null }` and `{ $objectToArray: null }` are null, so `$.o?.keys()` is the `$map` alone.

## Consequences

A wrong fact removes a guard that the server needs, so measure before you state one. The tests that hold each measurement are named in `src/registry/CLAUDE.md` § Rules.
