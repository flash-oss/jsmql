# 0104. Desugar and fold tests compare against the tree of the explicit form, with provenance erased

Status: Accepted
Applies to: `test/compiler-desugar.test.ts`, `test/compiler-fold.test.ts`

## Context

A desugar rule rewrites a sugar into a construct that the language already has. A test that asserts "what tree did the rule build" can pass when the rule produces something merely plausible.

## Decision

`test/compiler-desugar.test.ts` asserts that a sugar gives the SAME tree as the explicit form. The `EQUIVALENT` table holds pairs of the sugar and the source it means, so the table also documents what each sugar MEANS. The `shape` helper serialises the tree and erases provenance: `pos` (two spellings sit at different columns), `mutates` (the emitter's note that a write came from a mutator), `wrote` (the name that the source spelled, so a refusal can name it) and `minted` (a parameter name that no source spells). `test/compiler-fold.test.ts` uses the same `shape` comparison and erases `pos` and `minted`.

## Consequences

A new provenance field on an AST node must join the erased set in both `shape` helpers, or every equivalence test fails. A new sugar adds a row to `EQUIVALENT`, not a tree snapshot.
