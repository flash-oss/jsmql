# 0061. Clauses of the position edge that the spec does not state

Status: Accepted
Applies to: `src/compiler/passes/position.ts`

## Context

`edge` in `src/compiler/passes/position.ts` states the position of each child on one parent-to-property step. `docs/specs/position-pass.md` states most clauses. Some clauses are small and live only in the code.

## Decision

- `Where` uses the generic member `{ at: Position }`, not one spelled-out member per position. So a new position in the registry's `Position` becomes a position here at the same time.
- A stage body slot reads a bracketed list one way, and every other value another way (`slot.at` versus `slot.otherwise`). For example, `whenMatched: [$set(…)]` is a pipeline, and `whenMatched: "replace"` is a word.
- Each element of a `;`-separated program is a statement, whatever it looks like. The statements of an update document keep the `updateDoc` position. A write there is a field of the document, not a pipeline stage, so no statement sugar rewrites it.
- Each write of a `,`-joined run (`UpdateFilter.ops`) is a statement in its own right. The run groups the writes into one stage. It does not make them values. In an update document they keep `updateDoc`.
- `[ $match(…), … ]` is a pipeline only where a statement may stand. The same shape one step further in is an array value.
- Inside a stage body, the body's own object literal and its entry list stay at `stageBody`. Only a step into the value of an entry moves one key deeper.
- Inside an update document, everything below a statement keeps `updateDoc`: the operator arguments, and the documents and lists under them. So the update-document cell of `$push` reads `$each`.

## Consequences

A new position needs no change to `Where`. A change to the update-document clauses changes what `jsmql.update` accepts, so `docs/specs/update-filter.md` must change with it.
