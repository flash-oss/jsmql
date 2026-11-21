# 0040. The fold computes only what the server computes, and the fold-agreement suite proves it

Status: Accepted
Applies to: `test/compiler-fold-agrees.test.ts`, `test/compiler-fold.test.ts`

## Context

The constant fold replaces an expression with a value at compile time. A fold that answers differently from the server is a second semantics, not an optimisation. A `toEqual` on emitted MQL proves what jsmql writes, never that the server agrees.

## Decision

- **The proof.** `test/compiler-fold-agrees.test.ts` takes every expression that the fold can compute. It moves the first constant operand of the top node into a field of a seeded document. That operand is a receiver, a left operand, a first argument or a first entry. `unfolded` then lowers the tree with no fold, so the server computes the SAME operation on the SAME value. The other operands stay written, because an argument read from a field can take a different lowering (a computed index, an options document). `NO_OPERAND` lists the expressions whose top node has no operand to seed, or whose operand takes a constant only (`Math.PI`, a constructor). The server receives their constant, so they prove nothing, and the list keeps that set explicit.
- **Divergences that shaped the rules.** Each rule of the fold that looks like an arbitrary restriction has its cause in a failure of this suite, for example: `(0.25).atanh()` differs in the last digit; `123456789 * 987654321` differs because the server multiplies integers exactly in 64 bits; `(0.5).round()` is 1 in JavaScript and 0 on the server.
- **Measured set and key rules.** A set operation gives a value that one side holds twice only once (`[3, 1, 3].xor([1])`). `xorBy` keeps the first element for a key that one side holds twice.
- **Rounding at a place.** A scale by `10 ** places` decides on a perturbed number: `(2.675).round(2)` is 2.68 that way and 2.67 on the server, because 2.675 is really 2.67499999999999982. The fold follows the server, measured on each case of the test.
- **Operators whose two languages disagree do not fold.** `"a" + 1` lowers to `$concat`, which takes strings only. `1 == 1` is loose equality, which coerces. `typeof 1` folds to the `$type` name (`"int"`), because the lowering is `$type`, which answers with its own names.
- **Logic and equality follow the server.** MEASURED: `0 || 5` is 5 and `1 && 2` is 2 on the server, so a boolean-only rule would refuse the shape that people write. Every literal is a fresh object, so JavaScript's identity would answer false for every structural comparison. The fold compares by value, as the server does: `[1, 2] === [1, 2]` is true.
- **Date getters.** A JavaScript spelling gets JavaScript's numbering: `getMonth()` counts from 0, and `getDay()` gives 4 for a Thursday, as the runtime cells do over `$month` and `$dayOfWeek`. The getters whose names say LOCAL read UTC, because `$hour` does. A getter that reads local time would answer differently on every machine. `Date.UTC(2020)` reads one number as a YEAR, not a millisecond count: the server answers `$toLong` of `$dateFromParts { year: 2020 }`, and the fold matches that.
- **A constant in callee position stays a name.** `const g = 3; g(1)` is a TypeError in JavaScript. The value 3 in place of `g` would leave `3(1)` in the tree, which is not a program. So the name stays, and a later phase reports what is wrong.

## Consequences

A new fold rule must pass `test/compiler-fold-agrees.test.ts` on a live mongod. Where the server's answer is not exactly specified, the interpreter refuses and the expression stays a runtime expression (see docs/specs/constant-engine.md). A fold never replaces a name with a value where the value cannot stand.
