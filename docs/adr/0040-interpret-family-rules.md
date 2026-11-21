# 0040. Small measured limits in the interpreter's operator families

Status: Accepted
Applies to: `src/compiler/interpret/accumulate.ts`, `src/compiler/interpret/arithmetic.ts`, `src/compiler/interpret/compare.ts`, `src/compiler/interpret/index.ts`

## Context

The interpreter answers only where its answer equals the server's answer (src/compiler/interpret/CLAUDE.md § The one invariant). Each family file holds limits that keep that invariant. src/compiler/interpret/CLAUDE.md states most of them. This record keeps the limits that it does not state.

## Decision

- `accumulate.ts`: the expression form of an accumulator takes `{ $sum: [a, b] }` or `{ $sum: <list> }`. One operand that is a list is the list of values, and any other operand list is the values themselves (`valuesOf`). `$sum` and `$avg` ignore a value that is not a number, and `$max` and `$min` ignore a null. A list with a value that the rule does not read is a refusal, because that value can be of another BSON type. Two operands give one addition, and one addition is exact. A list of integers adds exactly. A longer list with a fraction is a refusal, because the server adds it with a compensated sum, and the interpreter does not.
- `arithmetic.ts`: `$pow` runs for integers only. A non-integer exponent is a transcendental function, and a negative exponent is not exact. An exponent above 2000 gives an infinity at once, because 2 ** 2000 is far above the largest double, so the rule does not compute the power.
- `arithmetic.ts`: the bitwise operators take only integers that a 32-bit integer holds. JavaScript and MongoDB agree in that range.
- `compare.ts`: `equal` asks `compareValues` even when a list or a document holds an opaque value. The two values can differ before the walk reaches the opaque value, so an answer can exist.
- `index.ts`: a document key that holds a dot, a null byte or no characters is a refusal. An expression cannot hold such a name.
- `index.ts`: an array that a rule builds costs one step for each element. Without this cost, a `$reduce` that grows a list with `$concatArrays` copies it again at every step, and the step budget does not see it.

## Consequences

A new rule in a family must keep these limits or state a measured reason to change them. A change to the step cost must keep the cost per built element, or a growing reduce escapes `MAX_STEPS`.
