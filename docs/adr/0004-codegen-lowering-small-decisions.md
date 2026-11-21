# 0004. Small lowering decisions that the codegen suite records

Status: Accepted
Applies to: `test/codegen.test.ts`

## Context

`test/codegen.test.ts` asserts many lowerings. Some expected shapes follow a decision or a server measurement that no spec states. Each item below is one such decision.

## Decision

- `%` states its value form on the `remainder` production in `src/registry/productions.ts`. It states its query form through the equality cells that compose it. A test checks that the declared value cell and the emitted MQL agree, because a cell that no test checks can drift from the code.
- Measured on a live mongod: the enum slot of an operator evaluates an expression, so `$dateTrunc({ date: $.d, unit: $.u })` reads the unit at run time. The enum slot of a stage reads its value literally. Both are the developer's own MQL, so both pass through as written.
- The compiler keeps a timezone that the developer typed, even when it names the default, and the object form carries it. Only the implicit UTC that a `.getUTCxxx()` name states collapses to the single-argument form.
- In a block predicate, the JavaScript truth wrap goes around the `return` inside the `$let`, not around the whole `$let`. A wrap outside would repeat the whole `$let` once per falsy-value clause and evaluate every binding that many times. The boolean is the same.
- `.sortBy(x => -x)` lowers through `$sortArray`. MEASURED on mongod: over `[3, 1, 2]` it gives `[3, 2, 1]`.
- `.keyBy`, `.groupBy` and `.countBy` wrap each key as `$ifNull: [{ $toString: <key> }, "null"]`. `$toString` of a missing value is null, and `$arrayToObject` refuses a null key. The wrap gives `"null"`, the same as JavaScript's `String(null)`. Measured on mongod.
- With no iteratee, `.countBy()`, `.groupBy()` and `.keyBy()` key by the element itself (`$$x`), not by a field. `.countBy()` and `.groupBy()` dedupe the keys first, then count or bucket per key. MEASURED: `[1,2,3,4,5,2,3].countBy()` gives `{1:1,2:2,3:2,4:1,5:1}`, `[1,2,2].groupBy()` gives `{1:[1],2:[2,2]}`, and `[1,2,3].keyBy()` gives `{1:1,2:2,3:3}`.
- `.xorBy(other, key)` guards the other list with `$ifNull`. Its keys feed an `$in`, and `$in` aborts the command on a null operand.

## Consequences

A change to one of these lowerings must keep the stated reason true. Measure a changed shape on mongod before the expected value changes.
