# 0067. Measured answers of the array aggregate methods

Status: Accepted
Applies to: `src/registry/names.ts`

## Context

The array aggregate methods map to MongoDB operators whose answers on empty or missing input differ from lodash. Some accumulators also read an array operand in a special way.

## Decision

- `.max()` and `.min()`: MEASURED, `[$.a, $.b].max()` emits `{ $max: ["$a", "$b"] }`. `{ $max: [] }` and a missing operand give null. `.min()` is the same with `$min`.
- `.sumBy(f)` and `.meanBy(f)`: the cell emits `$sum` (or `$avg`) over the per-document `$sum` (or `$avg`) of a `$map`. MEASURED: the accumulator ignores an array operand that stands alone, so the inner operator is necessary.
- `.maxBy(f)`: the cell sorts `{ k, v }` pairs with `$sortArray` by `k` descending and takes the first. MEASURED: `$sortArray` is stable, so of two elements with equal keys, the EARLIER element stays first in a descending sort. This matches lodash.
- `.difference(other)` on an array: `$setDifference`, which keeps each value once, as a JavaScript Set does. MEASURED: `{ $setDifference: [[3, 3, 2, 1], [2]] }` gives `[3, 1]`. The stream cell keeps each document.

## Consequences

A change of operator for these rows needs a new measurement of the empty, missing and tie cases.
