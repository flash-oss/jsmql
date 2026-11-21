# 0187. One comparison against "" as the truth test of a string

Status: Rejected
Applies to: `truthOf` in `src/compiler/emit/mode.ts`

## Context

The truth test of a value that may be a string and may be absent keeps two tests: `{ $gt: [v, null] }` and `{ $ne: [v, ""] }`. The idea: one `{ $gt: [v, ""] }` covers a string of any presence in one operator, because null sorts below every string.

## Decision

The developer rejected the idea. The one operator reads as a comparison, not as a truth test. A reader must know the BSON sort order to see why it is right. Each of the two tests states one falsy value.

## Consequences

`truthOf` keeps one test per falsy part of the proof.
