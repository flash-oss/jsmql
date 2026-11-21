# 0179. A stage can be a link of a chain on a stream

Status: Accepted
Applies to: `streamLink` and `refStatement` in `src/compiler/emit/statement.ts`, docs/specs/aggregation-stages.md § Chained stage calls

## Context

A stage call stands at statement position. A JavaScript chain method stands in both statement and value position. So a chain in a value position cannot reach a stage. This matters most for a stage with no JavaScript spelling, for example `$group`, `$unwind`, `$setWindowFields`, `$bucket` or `$graphLookup`. In a value position (`const x = $$$.<coll>.…`), a program otherwise reaches it only through a nested `.aggregate((o) => { … })` block.

## Decision

A stage is also a chain link: `<stream>.$match(<body>)`. A link has no lowering of its own. It uses the same `statement` cell as its statement form, so the two spellings cannot drift.

## Consequences

Name resolution, arity and placement of a link are the same as for the statement form.
