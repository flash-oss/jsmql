# 0106. A stream sort names a field, and set-method answers follow the server

Status: Accepted
Applies to: `test/stream-methods.test.ts`

## Context

`$sortArray` takes a bare direction for an array of scalars. The `$sort` stage does not: it needs a document of keys. A stream carries documents, and MongoDB sorts a document by field name.

## Decision

On a stream, the compiler refuses a comparator that sorts by the whole element (for example `.toSorted((a, b) => a - b)`) and names a field form. The server refuses `{ $sort: 1 }` (measured), so no lowering exists. The set-method expectations in `test/stream-methods.test.ts` follow the project's `mongod` over the ids `[3, 1, 2, null, 0, 2]`: `.difference([1, 2])` keeps 3, null and 0; `.intersection([1, 2, 9])` keeps one 1 and one 2; `.compact().sortBy()` gives 1, 2, 2, 3.

## Consequences

Keep the whole-element refusal on streams. Re-measure the set answers on `mongod` when a set-method lowering changes.
