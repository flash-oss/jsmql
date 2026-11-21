# 0156. Strict-shape entries beside the polymorphic jsmql()

Status: Accepted
Applies to: `jsmql.filter`, `jsmql.pipeline`, `jsmql.update`, `jsmql.expr` and their `.compile` builders in `src/index.ts`

## Context

`jsmql()` is polymorphic. It gives a Filter or a Pipeline from the shape of the parsed program (see `docs/specs/filter-mode.md`). This is the right default when one source can be either shape. But a driver call takes exactly one shape at each argument. At such a call, a dispatch to the wrong shape gives a document that the driver accepts and that does the wrong thing.

## Decision

Each entry that takes one shape refuses a program of another shape, with an error that names the entry that takes it. The strict entries add no lowering of their own. They only narrow what the entry accepts, and run the same `lowerMode` as `jsmql()`.

## Consequences

A wrong shape fails at the call site, not on the server. The CLI shape flags and the mongoose plugin route through the strict entries, so they get the same refusal. A change to the dispatch of `jsmql()` must keep the strict entries in step with it.
