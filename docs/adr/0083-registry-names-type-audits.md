# 0083. Type-level tricks that keep the names.ts audits honest

Status: Accepted
Applies to: `src/registry/names.ts`

## Context

The audits at the foot of names.ts run in the type checker. A type-level audit can pass silently when a generic widens.

## Decision

- `ListedCells` maps each listed position to `unknown`. It gives no contextual type to a cell. It only makes the key required (`-?`), and `MongoSpec` types the cell.
- Every generic of the row constructors (`root`, `name`, `mongo`, `global_`) defaults to the empty type (`never`), never to its constraint. Otherwise a row with no `forbiddenIn` widens `F` to `readonly string[]`, and the audit passes and checks nothing.
- The `T` parameter of `name` carries the `immutableTwin` literal out to the audit. On the spec alone it widens to `string`. The audit would then read `string` from every row and could never name the row at fault.

## Consequences

A new generic on a constructor must default to `never`. Add a `@ts-expect-error` pair in test/types/registry-contracts.ts to prove that each audit can fail.
