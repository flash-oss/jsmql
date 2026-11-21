# 0008. Array slice lowerings never emit a three-argument $slice with a zero count

Status: Accepted
Applies to: `test/codegen.test.ts`

## Context

JavaScript `slice(start, end)` takes indices, end-exclusive. MQL `$slice` takes either `[arr, n]` (the first n elements) or `[arr, position, n]`. The two-argument form accepts a count of 0. The server refuses a three-argument form with a count of 0. A naive lowering gives the wrong elements or a refused query on an empty array.

## Decision

- `.slice(start)` drops the first `start` elements. It lowers to the three-argument form with a count of `max(1, size)`, not to the two-argument "first start" form. The count of 1, never 0, keeps an empty array valid: `$slice: [[], n, 1]` is `[]`, a position past the end. `.drop(n)` and `.tail()` use the same count, and `.shift()` does too.
- `.slice(1, 3)` gives the elements at index 1 and 2, never `$slice: [arr, 1, 3]`, which MQL reads as three elements from index 1.
- `.slice(0, -n)` resolves to the two-argument form with a count of `max(size - n, 0)`. `.dropRight(n)`, `.initial()` and the mutator `.pop()` also keep the first `max(0, size - n)` elements through the two-argument form. Only that form allows a count of 0, which an empty or single-element array needs.
- The general form resolves both indices k and f as JavaScript does. The count is f − k, and a `$cond` returns `[]` for an empty range. The slice's own count is `max(count, 1)`, so a constant-array input stays foldable and never reaches a refused 0-count `$slice`.
- A proven string receiver of `.slice` is refused, and the refusal names `.substring`.

## Consequences

Every new array method that slices must pick the form by this rule. Verify a new slice shape on mongod with an empty array and a one-element array.
