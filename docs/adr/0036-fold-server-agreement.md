# 0036. The fold computes only what the server computes, and the fold-agreement suite proves it

Status: Accepted
Applies to: `src/compiler/passes/evaluate.ts`, `src/compiler/interpret/`, `test/compiler-fold-agrees.test.ts`, `test/compiler-fold.test.ts`

## Context

The constant fold replaces an expression with a value at compile time. A fold that answers differently from the server is a second semantics, not an optimisation. A `toEqual` on emitted MQL proves what jsmql writes, never that the server agrees.

## Decision

- **The engine lowers, then interprets.** The constant engine does not compute with a table of JavaScript methods. It lowers a closed subtree with the real emitter, and the interpreter gives the value of that MQL. So one lowering states the meaning of each JavaScript method, and one rule states the meaning of each MQL operator. A method and its value cannot drift apart, because the value is the answer of the MQL that the server would run. One rule for each MongoDB operator replaces a hand-written JavaScript function for each method.
- **The proof.** `test/compiler-fold-agrees.test.ts` takes every expression that the fold can compute. It moves the first constant operand of the top node into a field of a seeded document. That operand is a receiver, a left operand, a first argument or a first entry. `unfolded` then lowers the tree with no fold, so the server computes the SAME operation on the SAME value. The other operands stay written, because an argument read from a field can take a different lowering (a computed index, an options document). `NO_OPERAND` lists the expressions whose top node has no operand to seed, or whose operand takes a constant only (`Math.PI`, a constructor). The server receives their constant, so they prove nothing, and the list keeps that set explicit.
- **Divergences that shaped the rules.** Each rule of the fold that looks arbitrary has its cause in a failure of this suite. For example: `(0.25).atanh()` differs in the last digit; `123456789 * 987654321` differs because the server multiplies integers exactly in 64 bits; `(0.5).round()` is 1 in JavaScript and 0 on the server. [ADR 0041](0041-interpret-measured-rules.md) records the rule for rounding at a place.
- **Measured set and key rules.** A set operation gives a value that one side holds twice only once (`[3, 1, 3].xor([1])`). `xorBy` keeps the first element for a key that one side holds twice.
- **Operators whose two languages disagree do not fold.** `"a" + 1` lowers to `$concat`, which takes strings only. `1 == 1` is loose equality, which coerces. `typeof 1` folds to the `$type` name (`"int"`), because the lowering is `$type`, which answers with its own names.
- **Logic and equality follow the server.** MEASURED: `0 || 5` is 5 and `1 && 2` is 2 on the server, so a boolean-only rule would refuse the shape that people write. Every literal is a fresh object, so JavaScript's identity would answer false for every structural comparison. The fold compares by value, as the server does: `[1, 2] === [1, 2]` is true.
- **Date getters.** A JavaScript spelling gets JavaScript's numbering: `getMonth()` counts from 0, and `getDay()` gives 4 for a Thursday, as the runtime cells do over `$month` and `$dayOfWeek`. The getters whose names say LOCAL read UTC, because `$hour` does. A getter that reads local time would answer differently on every machine. `Date.UTC(2020)` reads one number as a YEAR, not a millisecond count: the server answers `$toLong` of `$dateFromParts { year: 2020 }`, and the fold matches that.
- **A constant in callee position stays a name.** `const g = 3; g(1)` is a TypeError in JavaScript. The value 3 in place of `g` would leave `3(1)` in the tree, which is not a program. So the name stays, and a later phase reports what is wrong.
- **The one divergence: the branch that the answer does not need.** The interpreter never evaluates such a branch. The server folds each constant part first, so it can fail there. The interpreter follows JavaScript here, because a guard such as `d === 0 ? 0 : 1 / d` must work. `DIVERGE` in `test/compiler-interpret-agrees.test.ts` lists each such case.

## Consequences

A new fold rule must pass `test/compiler-fold-agrees.test.ts` on a live mongod. Where the server's answer is not exactly specified, the interpreter refuses and the expression stays a runtime expression (see docs/specs/constant-engine.md). A fold never replaces a name with a value where the value cannot stand. A new divergence from the server needs a `DIVERGE` row with its reason.
