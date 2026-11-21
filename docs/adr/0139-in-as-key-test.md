# 0139. `in` as JavaScript's key test

Status: Rejected
Applies to: the `in` operator production in `src/registry/productions.ts`, `docs/LANGUAGE.md`

## Context

The idea: give `in` JavaScript's meaning, a key test, for example `"k" in $.o` and `$.x in { a: 1 }`.

## Decision

The developer rejected this. In JSMQL, `x in [ … ]` is MongoDB's own `$in`, an element test, and that is the meaning that a query reads. JavaScript's `in` tests a key. The operator would then have two meanings. It would test an element for a list on the right and a key for an object on the right.

## Consequences

- The compiler accepts one right side: a list that the source spells. It refuses every other right side, and the message names the spelling for the intent.
- For an element of an array value, write `.has(x)`.
- For a key of an object, write `.key !== undefined` or `.keys().has(k)`. Both spellings emit the MQL that the key test would emit: `{ "o.k": { $exists: true } }` in a filter, and `$objectToArray` over the keys for a computed key.
- Reconsider only if `in` can have one meaning for every right side.
