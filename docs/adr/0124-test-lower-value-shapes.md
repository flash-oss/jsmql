# 0124. The server facts behind the value shapes in compiler-lower.test.ts

Status: Accepted
Applies to: `test/compiler-lower.test.ts`

## Context

`test/compiler-lower.test.ts` asserts the MQL that the value target emits. Some shapes and refusals follow from a server constraint or a language rule that the expectation does not show.

## Decision

- In a template literal, a part whose row states `returns: "string"` gets no `$toString`. A part of unknown kind gets one.
- `$arrayElemAt` refuses a key that is not a number. So for `$.a[$.i]` the array branch of the `$switch` also tests `$isNumber` on the key.
- A receiver of unproven family takes the one family of the method, and the server judges the value. `.length()` reads a string under a null guard. `.size()` reads a missing array as empty.
- MEASURED: the server reads a lone operand that is not an array as one operand. `{ $add: "$x" }` answers `$x`. The server refuses `{ $divide: 10 }`, because `$divide` takes exactly two operands. Both documents are the developer's own MQL. So the compiler passes each one unchanged, and the call spelling gives the same document.
- The audit over the operand shapes asserts a floor on the number of rows that it checked. A check that silently compares nothing is worse than no check.
- HR2's escape hatch is a call, and no MQL holds a receiver for it. So `$.a.$size($.b)` is refused. A document that holds only the arguments computes from the wrong value.
- After a dot, a suggestion names a method, never a global. `Number` is not a method.

## Consequences

Keep the `$isNumber` test while `$arrayElemAt` refuses another key. Make sure that the count floor matches the registry, and never lower it to make a failure pass.
