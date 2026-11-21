# 0055. The constant engine reads a date literal from its source parts before any lowering

Status: Accepted
Applies to: `src/compiler/passes/date-literal.ts`

## Context

A date literal is a date that the source spells with literal parts: `Date(0)`, `Date("2026-01-01")`, `Date(2026, 1, 1)` and `Date.UTC(2026, 1, 1)`. The server cannot compute some of these. `{ $toDate: 0 }` fails there, because the driver sends a small integer as an int. So the lowering of `Date(0)` has no value that the interpreter can give.

## Decision

- `readDateLiteral` in `src/compiler/passes/date-literal.ts` reads the date before any lowering, in the constant engine.
- `Date()` with no argument reads the clock, so it is never a constant.
- The reader declines a fraction of milliseconds and an unparsable string. It does not refuse them itself. The row of `Date` raises those errors with a position.
- A name that the program binds is no global, so the reader declines it (`isBound`).
- `Date.UTC(…)` reads ONE number as a year, where `Date(n)` reads it as milliseconds. The reader sends `Date.UTC` through the parts form, so the two spellings cannot disagree.
- The parts form counts months from zero, as JavaScript does, and rolls an out-of-range part over. The runtime cell adds one for `$dateFromParts`, which counts from one and rolls over in the same way.

## Consequences

A new date spelling must reach the reader through the parts form or the millisecond form. Each refusal of a bad literal stays on the row, so it keeps a position. See docs/specs/constant-engine.md and docs/LANGUAGE.md for the user-facing date rules.
