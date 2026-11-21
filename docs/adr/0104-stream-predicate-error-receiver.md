# 0104. A predicate error names the method only, never another receiver

Status: Accepted
Applies to: `test/pipeline.test.ts`

## Context

The source switch `$$ = $$$.<coll>.<chain>` lowers its `.filter` and `.reject` through the same helpers as a local `$$` chain. An error message that advises `$$.filter(...)` for a `$$$.<coll>.filter(...)` call sends the developer to the current stream. That changes which collection the query reads.

## Decision

Each predicate refusal names the method alone (for example `.filter()`), with the accepted spellings. It never names a receiver. The messages are then correct for every receiver that shares the helpers. `test/pipeline.test.ts` asserts this for the argument-kind, index-parameter and argument-count refusals.

## Consequences

A new predicate refusal in a shared helper must not name `$$` or another receiver.
