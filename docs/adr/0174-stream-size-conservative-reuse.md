# 0174. A stream count is reused only where a row proves it fresh

Status: Accepted
Applies to: the `preservesCount` fact in `src/registry/names.ts`, `staleCountStage`, docs/specs/stream-size.md

## Context

`$$.size()` stamps the count of the stream into a field. A later read can reuse the stamp, or emit a new `$setWindowFields`.

## Decision

The rule is conservative. A recount is always correct, and a reuse of a stale count is a bug. So a read reuses a count only after stages whose rows state `preservesCount`, and a stage that states nothing invalidates the count. A callback body can run a stage without `preservesCount`. There, a read of the third parameter means a different thing at each place in the block. So `staleCountStage` answers once for the whole body, and refuses the third parameter there.

## Consequences

A new stage that keeps the count and the fields must state `preservesCount`, or the compiler recounts after it.
