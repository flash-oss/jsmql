# 0097. Scratch slots are cleared once, at the namespace root

Status: Accepted
Applies to: `test/stream-methods.test.ts`

## Context

A stream method such as `.shuffle()` or a computed sort key writes a value to a `__jsmql.tmp.<N>` scratch slot. The pipeline already ends with `{ $unset: "__jsmql" }`. An `$unset` of a dotted path removes only the leaf, so `$unset: "__jsmql.tmp.1"` leaves `__jsmql: { tmp: {} }` on the document.

## Decision

At the top level, the compiler emits no `$unset` per slot. The trailing `{ $unset: "__jsmql" }` already clears every slot, so a second `$unset` adds only noise. Inside a `$lookup` sub-pipeline, the outer cleanup cannot reach the documents in the `as` array. So the sub-pipeline clears its own scratch, and it unsets the namespace root `__jsmql`, not the slot path. A live `mongod` showed the residue when the body unset only the leaf.

## Consequences

A new scratch user must rely on the chain's cleanup, never on its own leaf `$unset`.
