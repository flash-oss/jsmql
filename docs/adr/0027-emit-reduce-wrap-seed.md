# 0027. The reducer wrap folds a constant seed into the result

Status: Accepted
Applies to: `src/compiler/emit/reduce-wrap.ts`, `test/compiler-sugars.test.ts`

## Context

JavaScript starts `.reduce` from its seed. A MongoDB accumulator starts from its own neutral element and takes no seed.

`$$ = [{ k: $$.reduce((acc, d) => …, init) }]` lowers to one `$group` with one accumulator per key, and a `$replaceWith` after it. A MongoDB accumulator has its own neutral element, and it reads no seed. JavaScript's `reduce` starts from the seed. For example, `[acc, d.a].max()` from `0` is the maximum of the values and `0`.

## Decision

`seeded` in `src/compiler/emit/reduce-wrap.ts` folds the seed into the `$replaceWith` value, as JavaScript folds it:
- `acc + d.x` from 10 is the sum plus 10 (`$add`). A seed of 0 adds nothing.
- `[acc, d.x].max()` from 5 is the max with 5. A null seed adds nothing. `.min()` is the same.
- `[...acc, d.x]` from `[0]` is `[0, …]` (`$concatArrays`). An empty seed adds nothing.
- `acc ?? d.x` from a non-null seed IS the seed.
- `$last` reads no seed.
The compiler refuses a seed that is not a constant, because the seed cannot start a MongoDB accumulator.

`seeded` in `src/compiler/emit/reduce-wrap.ts` folds the constant seed into the `$replaceWith` value. A `.max()` body from `0` becomes `mx: { $max: [0, "$mx"] }`. A sum from `10` is the sum plus `10`. An `acc ?? d.x` body from a non-null seed is the seed. A `$last` body reads no seed. The compiler refuses a seed that is not a constant, because it cannot start a MongoDB accumulator.

## Consequences

The reducer-wrap paragraph in `docs/specs/emit-pass.md` and the header of `reduce-wrap.ts` say that the init stays unread. The specs must say that a constant seed folds in.

The answer matches JavaScript for a non-neutral seed. docs/specs/emit-pass.md § The facet, union and out roads says that the init stays unread. That sentence disagrees with the code and needs a correction.
