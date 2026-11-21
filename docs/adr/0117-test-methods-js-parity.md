# 0117. How compiler-methods.test.ts compares each method with JavaScript

Status: Accepted
Applies to: `test/compiler-methods.test.ts`

## Context

`test/compiler-methods.test.ts` holds one spelling per value cell of a method. It asserts the MQL. It also runs each spelling on a live mongod over a fixture, and compares the answer with the answer of JavaScript for the same input. Some cases cannot agree, and some comparisons need a rule.

## Decision

- Suite design: `compiled()` records each source with its JavaScript answer for the server half. Where JavaScript and MongoDB cannot agree, the case carries a note and asserts the MongoDB answer. The suite carries the all-or-nothing guard of [ADR 0188](0188-live-suite-skip-rule.md).
- A set operation, for example `$setUnion`, returns its elements in no promised order. The test compares the elements, not their sequence (SR2). `unordered()` marks such a case.
- `nullOr` is the shape of a JavaScript method on a receiver that can be null or missing: `$cond: [{ $lte: [recv, null] }, null, body]`. It answers null where JavaScript throws. A receiver that is certainly there, for example a literal or the array of a `$lookup`, needs no test.
- The local-time accessors, for example `.getMonth()`, lower to the UTC operators. The server knows no client timezone.
- `""` and `[]` split the two languages. `""` is false in JavaScript and true to a raw MongoDB condition. The answer of `.pickBy()` and `.omitBy()` must be the JavaScript answer. So a predicate reads the JavaScript truth rules: `""` and `0` fail, `[]` passes. A predicate that answers a boolean needs no truth test.
- When no entry passes `.findKey()`, JavaScript answers `undefined`. On the server, `undefined` is a missing value.
- `(a, b) => a - b` names no field. So the elements themselves are the sort key.
- `.indexOf()` and `.has()` are array methods. The receiver is an array by the claim of the row, and the server judges any other value. A string takes `.indexOfSubstring()` and `.includes()`.
- `.toString()` is the bare `$toString`. On an array it gives MongoDB's text, for example `[3,1,2]`. `.join()` gives JavaScript's text, for example `3,1,2`.
- `.difference()` gives each value once, as a JavaScript `Set` holds it. lodash's `_.difference` keeps the duplicates.
- `.invertBy()` spells a missing result of the iteratee as the key `"null"`, as `.groupBy()` does. lodash spells it `"undefined"`. So the test maps a missing result to null.
- The driver writes a whole JavaScript number as a 32-bit integer. So `.isInt()` is true for such a fixture field.
- `.isObject()` is false for an array, unlike lodash's `_.isObject`.
- MongoDB's `$toBool` reads every string as true. JavaScript's `Boolean("")` is false. The case notes this difference.
- `({}).assign(...list)` is the one spelling that merges an array of objects. The empty target means that the call writes nothing into `docs[0]`. With no spread, one argument is one source object. So the `{}` stays, and keeps the operand an object.
- `.concat()` follows JavaScript's `concat`. JavaScript adds the elements of an array argument, and adds any other argument as one element. A spread passes each element of its array as an argument. MongoDB has no `undefined`, so a missing argument adds null, and `canonical` writes JavaScript's `undefined` in an array as null too. JavaScript throws for a spread of a missing or null value. JSMQL spreads nothing there, as `[...$.b]` does. Those rows state the answer instead of a JavaScript function.
- `HINTS` reads the spelling out of each refusal message, fills its placeholder, and runs the result. So a hint that aborts on a missing field fails, and the hint text cannot drift from the spelling that the test proves. JavaScript throws for a missing or null receiver there; the hinted spelling answers the empty list.

## Consequences

A new method row needs a case here with a JavaScript answer, or a note that names the difference. Keep `unordered()` for every set operation.
