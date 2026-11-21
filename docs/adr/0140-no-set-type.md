# 0140. `Set` in JSMQL

Status: Rejected
Applies to: the `Set` row in `src/registry/names.ts`, `docs/LANGUAGE.md` § Set operations on arrays

## Context

The idea: accept `new Set(…)` and `Set(…)`, as JavaScript does.

## Decision

The developer rejected this. MongoDB has no set type, so `new Set(x)` can only lower to `x` itself, and each duplicate stays. `new Set($.a)` reads back as `[3, 1, 3, 2, 1]`, but JavaScript gives `[3, 1, 2]`. `Set` is also one case of [ADR 0141](0141-one-spelling-per-capability.md): the array methods already say each set operation.

## Consequences

- The compiler refuses both spellings, and the message names the array methods.
- The array methods do each set operation, with the lodash name where lodash has one. `.uniq()` gives the unique values. The two-array methods, for example `.union()`, compare two arrays. The rows in `src/registry/names.ts` hold the live list.
- `.difference()` is the set difference, `$setDifference`, so it gives each value once, as a `Set` does.
- [docs/LANGUAGE.md § Set operations on arrays](../LANGUAGE.md#set-operations-on-arrays) maps each `Set` member to its array method.
- Reconsider only if MongoDB gets a set type.
