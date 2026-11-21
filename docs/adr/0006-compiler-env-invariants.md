# 0006. The environment record holds three invariants, and a boundary keeps the chain it came from

Status: Accepted
Applies to: `test/compiler-env.test.ts`

## Context

The Env in `src/compiler/emit/env.ts` is the one record that a lowering runs under. Each invariant below is the negative of a context bug.

## Decision

- A lambda body inherits EVERYTHING from its surroundings. A transition changes one thing.
- The HR1 gate is one predicate, `injectedPlacement`, with a stated truth table (see docs/specs/aggregation-stages.md § `$`-string pass-through (HR1)).
- A chain closes in one order: the stages, then the cleanup, then the terminal stage. Nothing follows `$out`.
- `Env.enter` records a boundary that keeps the SAME `Chain` it came FROM, by reference. This is how `$$` reaches the root stream from inside a `$lookup` body.
`test/compiler-env.test.ts` holds the runtime half. The type-level half (no optional field, no literal, no spread) is in `test/types/registry-contracts.ts`.

## Consequences

A change to `Env` must keep the boundary's reference to the outer chain. A new transition changes one field and copies the rest.
