# 0026. How sort-spec.ts reads directions and whole-element keys

Status: Accepted
Applies to: `src/compiler/emit/sort-spec.ts`, `test/stream-methods.test.ts`

## Context

MongoDB sorts by field NAME. `src/compiler/emit/sort-spec.ts` reads a sort argument into a `{ field: 1 | -1 }` document, or refuses it with the spelling that works.

## Decision

- In a key function, the minus sign is the DIRECTION and nothing else. The key that the caller lowers is the body under the minus sign. Otherwise `x => -x.k` would negate the key AND sort it descending.
- `wholeElementDir` reads `a - b` or `b - a` on the BARE parameters as the whole element. `$sortArray` takes that key as a direction alone. Only a bare body qualifies. Under `||` the term goes to the same-field check, because an element that IS the key has no tiebreaker. For the same reason, the refusal in `comparatorSpec` names the elements-as-key form only when one term is the whole body.
- `streamSortAsk` narrows an ask to what a `$sort` STAGE can carry. `$sortArray` takes a bare direction for an array of scalars. The `$sort` stage needs a document of keys, because MongoDB sorts a document by field name. MEASURED: the server refuses `{ $sort: 1 }`, because the spec is not a document. It refuses `{ $sort: { $literal: 1 } }`, because `$literal` is not a valid field name. So no lowering exists for a comparator that sorts a stream of documents by the whole element (`$$.toSorted((a, b) => a - b)`). The compiler refuses it and names a field form.
- An unwound element has a name. `.flatMap("tags").sort((a, b) => a - b)` sorts by `tags`, and `.flatMap("items").sortBy("qty")` sorts by `items.qty`.

## Consequences

A new sort spelling must keep the direction apart from the key. Keep the whole-element refusal on a stream of documents.
