# 0096. A message from a shared stream helper names the calling method, and never a receiver

Status: Accepted
Applies to: `test/stream-methods.test.ts`, `test/pipeline.test.ts`

## Context

The `$group`-keyed stream methods (`.countBy`, `.keyBy`, `.uniqBy`, `.groupBy`) reuse the body and parameter helpers of `.map` to lower a computed key. The source switch `$$ = $$$.<coll>.<chain>` lowers its `.filter` and `.reject` through the same helpers as a local `$$` chain. A shared helper can name the wrong method in its error, for example a `.countBy(d => …)` failure that names `.map`. It can also name the wrong receiver. A message that advises `$$.filter(...)` for a `$$$.<coll>.filter(...)` call sends the developer to the current stream, and that changes which collection the query reads.

## Decision

- Each helper takes the name of the calling method and uses it in every message. The example in a message uses the calling method too. The errors of `.keyBy` and `.uniqBy` never show a sibling such as `.countBy("status")`.
- Each predicate refusal names the method alone (for example `.filter()`), with the accepted spellings. It never names a receiver. The messages are then correct for every receiver that shares the helpers.

## Consequences

A new method that reuses these helpers must pass its own name. A new predicate refusal in a shared helper must not name `$$` or another receiver. Tests assert the method name in each message, and `test/pipeline.test.ts` asserts the receiver rule for the argument-kind, index-parameter and argument-count refusals.
