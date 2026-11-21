# 0068. Server constraints on $nor, $text and $where

Status: Accepted
Applies to: `src/registry/names.ts`

## Context

Some query operators have no expression form, and the server limits where they can appear.

## Decision

- `$nor`: MEASURED, the server refuses `find({ $nor: [] })`, and `$nor` has no expression form to fall back to. So the row requires at least one predicate and refuses the empty list.
- `$text`: MEASURED, the server refuses a `$match` with `$text` anywhere in its body, at the top or under an `$and`. The one exception is a `$match` that is the FIRST stage of the pipeline. Inside a `$facet` branch the server refuses the stage outright, because the branch gets no text score. The row states `only: ["stageFirst"]` and `forbiddenIn: ["$facet"]`. Both facts belong to the stage, so `place` reads them off the keys of the body, not off the row of the stage name.
- `$where`: MEASURED, `find({ $where: … })` runs where server-side JavaScript is on, and an aggregation `$match` refuses it at any depth. So a raw `{ $where: … }` filter passes through (HR1), and the row refuses the same document inside a `$match` (`forbiddenIn: ["$match"]`).

## Consequences

A new placement rule for a query operator goes on its row, and `place` reads it from the keys of the stage body.
