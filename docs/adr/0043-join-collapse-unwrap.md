# 0043. A collapsing terminal on a join unwraps the one-element lookup result

Status: Accepted
Applies to: `test/pipeline.test.ts`, `test/realistic.test.ts`

## Context

`$.f = $$$.<coll>.filter(p).countBy(k)` (and `.keyBy`, the bare-key `.groupBy`) collapses the sub-pipeline to one object document. `$lookup.as` always holds an array, so the slot holds that object inside a one-element array.

## Decision

The join road emits a trailing `$set` that writes `{ $ifNull: [{ $first: "<slot>" }, {}] }`. `$first` unwraps the object. `$ifNull` gives `{}` when no foreign document matches, which is what lodash gives for an empty input. A live `mongod` accepts this shape.

## Consequences

A new collapsing terminal on the join road needs the same unwrap. Keep the `{}` default for the empty match.
