# 0173. `$$ = cond ? A : B` and `$$.find(p)` have no lowering

Status: Rejected
Applies to: `writeStages` in `src/compiler/emit/statement.ts`, docs/specs/replace-stream-stage.md

## Context

Two right sides look possible for a stream: a ternary that picks one of two streams, and `.find(p)` on the current collection.

## Decision

The developer rejected both ideas, because they have no coherent JavaScript meaning.
- A stream is many documents. No single condition swaps the whole stream for A or B, so "replace the stream with A or B" has no JavaScript meaning.
- One document found in the same stream is a value with no use in expression semantics. JSMQL also compiles with no state, so it does not know the name of the current collection, and a `$lookup` needs that name.

## Consequences

The compiler refuses both forms, and names `$$.filter(p)`, `$$$.<coll>.filter(p)` and `$$$.<coll>.find(p)`.
