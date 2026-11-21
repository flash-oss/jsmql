# 0072. The null and missing facts on a row, and how each is measured

Status: Accepted
Applies to: `src/registry/names.ts`

## Context

HR5 reads a null or missing receiver as a safe value under a dot. The emitter must not add an `$ifNull` or `$cond` guard where the server already gives the right answer. Each such fact must come from a measurement.

## Decision

- `neverNull: true` (NameSpec): the value cell answers null only when its receiver or an argument is null or missing. For example, `.map` states it. `.find` does not, because the element can be missing. `isPresent` in src/compiler/emit/prove.ts reads it, so a `$size` or `$in` over such a chain needs no `$ifNull` guard when the chain starts from a present value.
- `neverNull: "always"`: the cell answers a value whatever its arguments are. It reads a missing argument as the empty value of its slot, or its operator answers for any operand. The receiver still counts (HR5 wraps it, or the proof shows it). MEASURED: `$.a.intersection($.b)` with no `b` is `[]`, and `$.a.has($.x)` with no `x` is `false`.
- `neverNull` on a `mongo` row has the same meaning: `$range` of two numbers is an array. A literal object operand is a body (`$map: { input, … }`, `$hour: { date, timezone }`), and it proves nothing, because the proof cannot tell which key is the input. So `true` gives presence only over a list or one value. MEASURED for `"always"`: `{ $eq: ["$nope", 1] }` is false, `{ $toUpper: "$nope" }` is `""`, and `{ $sum: "$nope" }` is 0.
- `readsNullAsEmpty`: the operator gives the same answer for a null or missing receiver as for the empty value of its family, so HR5 needs no wrap. MEASURED: `{ $sum: null }` and `{ $sum: [] }` are both 0. `$avg`, `$max` and `$min` answer null for both. `.join()` guards its own answer, so a null receiver and `[]` both give `""`.
- `nullReceiverAs`: under a dot, the row reads a null or missing receiver as this value. A row states it only where it differs from the safe value of its family. The logarithm of 0 stops the command, so `.log()` reads a missing receiver as 1. A method that works on every kind reads the safe value of the kind it gives: `.toString()` reads `""`, and `.toBool()` reads false. MEASURED: `{ $ln: 0 }` stops the command, and `$.nope.log()` is 0, as `(1).log()` is.
- `passesNull`: the operator answers null for a null or missing receiver on its own. So a `?.` before the call needs no `$cond` null test. MEASURED: `{ $max: null }` and `{ $objectToArray: null }` are null, so `$.o?.keys()` is the `$map` alone.
test/compiler-methods.test.ts measures each claim on a JavaScript row. test/compiler-returns-agrees.test.ts measures each claim on an operator row.

## Consequences

A row that states one of these facts must have a measurement in those tests. A wrong fact removes a guard that the server needs, so measure before you state one.
