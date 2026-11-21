# 0068. Filter, stream and value forms of the array method rows

Status: Accepted
Applies to: `src/registry/names.ts`

## Context

An array method can stand in a filter, in a stream chain and in a value. Each position has its own server constraints, and the query form is the only form that an index reads.

## Decision

Filter forms:
- `.has()`: `$.tags.has("x")` gives `{ tags: "x" }`, MongoDB's "equals, or is an array that contains", which is what `.has` means on an array. `["a", "b"].has($.s)` gives `{ s: { $in: […] } }`. Anything else keeps the expression fallback. A dot reads a missing array as `[]`, which holds no null, but `{ f: null }` also matches a missing or null field. So a null needle tests the elements alone. MEASURED: `{ f: { $elemMatch: { $eq: null } } }` selects `[null]`, and does not select `null` or `{}`.
- `.some()`: `$.items.some(i => i.q > 2)` gives `{ items: { $elemMatch: { q: { $gt: 2 } } } }` when the whole body has a native form against the element. `$elemMatch` asks about the field, so it takes no leaf exclusion; a prefix array is still absent, where JavaScript `.some` throws and selects nothing. MEASURED: a body that tests the element itself is one operator document (`{ $elemMatch: { $gt: 1, $lt: 5 } }`), and the server refuses `$and`, `$or` and `$nor` over such tests. A body over the fields of the element may hold them. The server refuses `$expr` in any body, and a mix of a field and an element test. Those bodies take the expression road.
Value forms:
- `.has()` as a value: MEASURED, `$in` aborts on a null list, so `nullOr` tests a receiver that can be missing first.
- `.findIndex()` and `.findLastIndex()`: `indexedPairs` counts the array with `$size`, which aborts on a missing array, so the cells use `nullOr`.
- `.concat()`: each argument takes the shape its proof allows (`concatOperand`, `concatSpread`). MEASURED: the server folds a run of adjacent constant operands during optimisation and raises on a wrong type there. So a constant without the `[x]` wrap stops the pipeline before any branch runs. A call with a spread reaches the cell as one list, packed by the desugar pass; its elements are the call's own arguments.
- `.toSpliced()`: JavaScript reads a negative `deleteCount` as 0, but `.toSpliced(1, -1)` is more often a typo than an intent. So the count slot stays closed to negatives, and the start slot accepts them. MEASURED: a `$let` variable cannot see a sibling in its own `vars` block. A start counted from the end reads the receiver length, so each binding sits one level inside the last. MEASURED: a three-argument `$slice` refuses a count of 0, so the emitter writes the empty tail with a `$cond`.
Stream forms:
- `.flatMap()` and `.map()` take only a property path as a stream iteratee. `$unwind` needs a field path, `$replaceWith` needs a document, and a matcher is provably a boolean. The `.map()` stream cell replaces the document, so its body must be a document. A `.map` to a value on another collection reads the joined array as a value.
- `.filter()`: MEASURED, three parameters as a value (value, index, receiver), exactly one as a chain link. The compiler refuses a read of `i` in `$$ = $$.filter((d, i) => …)`. A bare callable takes a value, and a stream element is a document, so the stream slot does not take a bare callable.
- `.reverse()` on a stream: the row refuses its twin for the same reason (a stream has no order until it is sorted), so the message names `.orderBy()` and not the twin.
- `.sortBy()` takes an object as a lodash matcher, and the cell's own refusal names `.orderBy()`. In the sort readers of the immutable sort rows, an object is a lodash matcher, not a set of directions, so the reader refuses it.

## Consequences

A new array filter form must handle a null needle and the HR5 empty array. A stream iteratee slot must accept only the shapes that its stage can take.
