# 0110. A block predicate folds before the join road classifies it, and its bindings ride in $expr

Status: Accepted
Applies to: `test/callback-block.test.ts`

## Context

A stream callback can take a block body: `o => { const t = o.total; return t > 5; }`. The `$$ =` source switch and the lookup chain reach a `$lookup` through `lookupOf` in `src/compiler/emit/join.ts`. If a spelling lost the predicate, the sub-pipeline would be empty and would match every foreign document. That MQL is valid, so the fault would be silent.

## Decision

- The compiler folds a stage-free block to its value before the join road classifies the chain. Whether the chain correlates follows what its body captured, never a separate reading of the predicate. So `{ return <pred> }` classifies exactly as the bare expression does.
- A `const` or `let` block predicate is a `$let` expression. A `$let` has no query form, so the whole predicate goes to `$expr`, also inside the `$nor` of `.reject`. Every predicate position accepts it, and the bindings behave as in any other block-bodied arrow. A `$.<field>` read in the block still goes into the `$lookup.let`.
- The bindings compute values. Only the returned expression decides the match.
- The tests in `test/callback-block.test.ts` assert the emitted sub-pipeline itself, not only the route. An equality check against another broken form could pass while the pipeline matches every document.

## Consequences

A change to the block fold or to `lookupOf` must keep the predicate in the sub-pipeline. Keep the assertions on the full emitted document.
