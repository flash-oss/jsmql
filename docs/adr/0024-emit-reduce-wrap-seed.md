# 0024. The reducer wrap folds a constant seed into the result

Status: Accepted
Applies to: `src/compiler/emit/reduce-wrap.ts`, `test/compiler-sugars.test.ts`

## Context

`$$ = [{ k: $$.reduce((acc, d) => …, init) }]` lowers to one `$group` with one accumulator per key, and a `$replaceWith` after it. JavaScript starts `.reduce` from its seed. A MongoDB accumulator starts from its own neutral element and reads no seed. For example, `[acc, d.a].max()` from `0` is the maximum of the values and `0` in JavaScript, but `$max` alone ignores the `0`.

## Decision

`seeded` in `src/compiler/emit/reduce-wrap.ts` folds the seed into the `$replaceWith` value, as JavaScript folds it. So the answer matches JavaScript for a seed that is not the neutral element. A neutral seed adds nothing to the output. The compiler refuses a seed that is not a constant, because the seed cannot start a MongoDB accumulator. The fold for each accumulator is in docs/specs/stream-methods.md § The `.reduce` wrap forms.

## Consequences

A change to the wrap must keep the seed fold for each accumulator. It must also keep the refusal of a seed that is not a constant.
