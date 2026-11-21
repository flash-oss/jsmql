# 0041. Measured server rules and limits in the interpreter value model and rule helpers

Status: Accepted
Applies to: `src/compiler/interpret/operand.ts`, `src/compiler/interpret/string.ts`, `src/compiler/interpret/type.ts`, `src/compiler/interpret/values.ts`

## Context

The interpreter in `src/compiler/interpret/` must give the same answer as the server for the same MQL. Where the server answer is not exactly specified, a rule refuses. Some server facts are not in src/compiler/interpret/CLAUDE.md. Some helpers also make choices that a reader cannot see from the code alone. This record holds those facts and choices.

## Decision

Operand readers (`operand.ts`):
- `keyed` gives the rule the parts as written, not as values. A part such as `in` or `cond` runs once for each element, so the rule must evaluate it itself.

String rules (`string.ts`, `values.ts`), each one measured on the server:
- `$toUpper` and `$toLower` change the ASCII letters only. `asciiUpper` and `asciiLower` hold this rule. A null operand gives the empty string.
- `$strcasecmp` upper-cases the ASCII letters, then compares by code point.
- `$substrBytes` cuts at byte offsets. A negative length means the rest of the string. The server fails when a cut starts or ends on a UTF-8 continuation byte (the `10xxxxxx` part of a multi-byte character). So `isContinuation` makes the rule refuse such a cut.
- `$indexOfBytes` counts bytes. A match must lie wholly inside the range that the start and end bounds give.
- `$replaceOne` and `$replaceAll` with an empty `find` have a server answer that the rule does not model. The rule refuses that operand.

Type rules (`type.ts`):
- `$toBool` gives false for 0 and null for null. Every other value that the interpreter reads is true, the empty string included.

Numbers (`values.ts`):
- `isInt32`: an index or a count must be a 32-bit integer. The server refuses every other value in that slot.
- A `-0` is a refusal. The driver sends `-0` as a double, but the same arithmetic on the server gives an int 0. The two answers differ in kind.
- `reduceToPlaces` reduces a double to a number of decimal places in its exact decimal value (`exactDecimal`). It uses integer (BigInt) arithmetic. A scale by `10 ** places` decides on a perturbed number and can drift: `(2.675).round(2)` is 2.68 that way and 2.67 on the server, because 2.675 is really 2.67499999999999982. `$round` takes the even neighbour on an exact half. The function reads the result back through its decimal spelling, which is one correctly rounded step.

Strings and equality (`values.ts`):
- `compareCodePoints` gives the order by code point, which is also the UTF-8 byte order. JavaScript compares UTF-16 units. The two orders differ for a surrogate against a unit from U+E000 up. So the function moves a surrogate above those units before it compares.
- `keyOf` gives a string that two values share exactly when `sameValue` holds for them. A set operator then finds a repeated value in one pass, not with one comparison for each pair. Each part of the key ends where the next part starts, so no two different values share a key.

Limits (`values.ts`):
- `MAX_DEPTH` stops the walk before a deep tree overflows the JavaScript stack.
- `MAX_SIZE` caps the length of a string or an array. A larger value does not belong in a query.
- `MAX_STEPS` caps the nodes that one call visits. It stops a nested `$map` over a `$range` from an endless run.

## Consequences

A change to one of these rules must start with a new server measurement. A new string rule must count code points or UTF-8 bytes, never UTF-16 units. A new rule that cuts bytes must refuse a cut on a continuation byte. The limits must stay below the point where the host stack or the host time fails. `keyOf` must stay prefix-free, or the set operators merge two different values.
