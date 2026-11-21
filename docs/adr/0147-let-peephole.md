# 0147. `$let` as an optimisation (peephole)

Status: Rejected
Applies to: the `let` binding lowering, `docs/specs/let-bindings.md`

## Context

A `let` binding lowers to `$set` and `$unset` stages. The idea: when a downstream expression reads a `let` exactly once, with no reshape between, emit a single `$let` instead.

## Decision

JSMQL does not do this. The same input would give a different stage shape, and a heuristic about a downstream reshape would decide it. That is exactly the surprise that JSMQL avoids: the "no silent output drift" principle of [ADR 0153](0153-no-silent-output-drift.md).

## Consequences

- A `let` always lowers to `$set` and `$unset`.
- A developer who needs `$let` writes `$op($let, …)` explicitly.
- Reconsider only if the `$let` form becomes the one shape for every `let`, with no heuristic.
