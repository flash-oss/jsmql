# 0184. The truth test catches a missing value, and a boolean position drops the operand-preserving `$cond`

Status: Accepted
Applies to: `src/compiler/emit/mode.ts`, `lowerTruth` in `src/compiler/emit/lower.ts`

## Context

JavaScript reads a value for truth in a `?:` test, a `!`, a predicate callback and the other boolean positions. MQL has no such test. `docs/specs/grammar.md § JS truthy/falsy semantics` states the lowering.

## Decision

- The null clause of the truth test reads `{ $ifNull: [v, null] }`, not `v`. MongoDB's `$eq` and `$ne` treat a missing value as different from null: `{ $eq: ["$absent", null] }` is false. So a bare `{ $ne: [v, null] }` does not match a missing value. Without the wrap, `arr.filter(x => x.f)` keeps an element where `f` is absent. `$ifNull` makes a missing value null first. This matches JavaScript, where a missing value (`undefined`) is falsy.
- The other three clauses compare the raw value, because `false`, `""` and `0` are never missing. The type-bracketed comparison of MongoDB answers each comparison across kinds, for example `{ $ne: ["abc", 0] }` is true.
- In a boolean position, a `&&` or `||` chain becomes `$and` or `$or` of the operands read for truth. It does not take the operand-preserving `$cond` of a value position. The answer is the same, because nothing reads the operand that the chain returns. A `$cond` wrap repeats the whole chain once for each clause of the falsy test.

## Consequences

A change to the null clause must keep a missing value falsy, or a predicate keeps an element that JavaScript drops. A new boolean position must read its operand through `lowerTruth`, so that it gets the cheap `$and` and `$or` form.
