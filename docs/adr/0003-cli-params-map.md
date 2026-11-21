# 0003. The CLI keeps parameters in a Map

Status: Accepted
Applies to: `src/cli.ts`

## Context

`src/cli.ts` collects `--arg` and `--argjson` values. A user names each parameter on the command line.

## Decision

The `params` option is a `Map`, not a plain object. On a plain object, `--arg __proto__ x` writes the prototype slot and stores nothing. The query then reports the parameter as not supplied.

## Consequences

Keep the `Map` until the CLI builds the params record. A change to a plain object brings back the `__proto__` defect.
