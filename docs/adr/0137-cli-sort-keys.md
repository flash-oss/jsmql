# 0137. A key-sorting flag for the CLI (`-S` / `--sort-keys`)

Status: Rejected
Applies to: `src/cli.ts`, `docs/specs/cli.md`

## Context

The idea: give the `jsmql` CLI a `-S` / `--sort-keys` flag that prints the object keys of the output in sorted order.

## Decision

A key-sorting flag has no safe use here. MQL is order-sensitive in places. A computed field of a `$project` or an `$addFields` can read an earlier sibling, and the key order of a stage body can matter. So a sort of the object keys can silently change the meaning. This follows the "no silent output drift" principle, the same principle as [ADR 0138](0138-match-negation-de-morgan.md) and [ADR 0147](0147-let-peephole.md). [ADR 0153](0153-no-silent-output-drift.md) states the principle.

## Consequences

- The CLI prints the keys in the order that the compiler emits them. See `docs/specs/cli.md`.
- Reconsider only if a sort can prove that it keeps the meaning of every document it touches.
