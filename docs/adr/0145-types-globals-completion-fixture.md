# 0145. The globals completion fixture states what TypeScript cannot read itself

Status: Accepted
Applies to: `test/types/globals-completion.ts`

## Context

`test/types/globals-completion.ts` is a `tsc` fixture for `@koresar/jsmql/globals`. The document root `$` is not an ambient global: it reaches the body through the arrow's toolbox destructure (`({ $ }) => …`), typed `any`. Each `$op` declaration ends with a catch-all overload, and `Parameters<>` reads the last overload.

## Decision

The fixture declares `$` as `any`, so the correlated forms read as real source does. The helpers `First2` and `First3` read the first overload, the documented one, so the fixture tests the editor hint and not the catch-all.

## Consequences

If the generator changes the overload order or count, update the helpers. If `$` becomes an ambient global, remove the stand-in declaration.
