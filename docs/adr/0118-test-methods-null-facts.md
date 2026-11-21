# 0118. How the tests prove the null facts that let the compiler drop an $ifNull

Status: Accepted
Applies to: `test/compiler-methods.test.ts`

## Context

A row of `src/registry/names.ts` can state `neverNull`, `readsNullAsEmpty` or `passesNull`. A production can state `passesNull`. The presence proof reads these facts to leave out an `$ifNull` or a `$cond` null test. A wrong claim gives a wrong answer, and no `toEqual` shows it.

## Decision

- `NEVER_NULL` measures each claim. A row that states `neverNull` answers a value, never null or missing, over inputs that are there. A row that states `"always"` also answers a value when each argument is missing. A row that states `readsNullAsEmpty` answers a missing receiver exactly as it answers the empty value of its family. The test also asserts that the compiler leaves the `$ifNull` out for such a row, because that is the reason for the fact.
- `PASSES_NULL` gives each row two cases: a call after `?.` on a missing receiver, and the same call on a receiver that holds null. Each answers null with no `$cond` test. The `?.` null test stands at the top of the chain. A `$cond` inside the body belongs to the row.
- `.trim()` answers null for null on its own, so `?.` adds no test. `.size()` does not, so the test stays. Its second branch reads the proven parameter with no `$ifNull`.
- `PRODUCTION_PASSES_NULL` puts a `?.` read in each operand of a production, over a document with no `b`. The read takes no `$ifNull`, and the answer equals the answer of the wrapped read.
- `GUARD_FREE` checks that each emitted `$ifNull` changes an answer on some document. The test drops one guard at a time and keeps the value that it guarded. It runs over fields that are missing, null, empty, set or of another type. When no answer changes, the guard was dead. Then the presence proof, a `neverNull` or a `readsNullAsEmpty` did not know that the value is there.
- A null test is `$lte` or `$gt`, not an `$ifNull`. So a source can hold no guard at all, and the floor on checked guards allows for that.

## Consequences

A new fact on a row needs a row in the matching table. Never state a null fact that the server does not confirm.
