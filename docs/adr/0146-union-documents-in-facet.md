# 0146. A written document list is refused anywhere inside a $facet

Status: Accepted
Applies to: `test/union.test.ts`

## Context

`$$.push({ … })` lowers to a `$unionWith` whose body is a `$documents` stage. MEASURED: the server refuses `$documents` inside a `$unionWith` inside a `$facet`, at any depth. A branch that appends a collection runs.

## Decision

The compiler refuses `.push(<document>)` inside a `$facet` branch, at any depth. The message names the collection append (`$$.push(...$$$.<coll>)`) and an append outside the branch. Inside a `$facet` branch there is no statement position, so the message does not offer the statement form there.

## Consequences

Keep the depth-independent check. Add the fact to docs/specs/union-stage.md when that spec next changes.
