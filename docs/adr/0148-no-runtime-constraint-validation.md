# 0148. Compile-time validation of runtime-dependent pipeline constraints

Status: Rejected
Applies to: the stage checks in `src/compiler/`, HR3 in `docs/LANG_RULES.md`

## Context

The compiler checks the MQL that it makes from JSMQL code, and the place of each stage (HR3 in [docs/LANG_RULES.md](../LANG_RULES.md)). It throws only on a violation that is certain from the source. The server also enforces a class of constraint that depends on runtime state, which the compiler cannot know:

- sharding (`$out` to a sharded collection, `$unionWith` inside `$lookup` on a sharded `coll`)
- transactions
- view definitions
- memory limits (`$group` / `$sort` / `$bucket` past 100 MB without `allowDiskUse`, or a document past the 16 MB BSON limit)
- collection type (`$out` needs a non-capped collection, `$merge` needs a non-time-series collection)
- read concern
- Atlas availability of `$search`, `$searchMeta`, `$vectorSearch` and `$listSearchIndexes`

The idea: check these constraints at compile time.

## Decision

JSMQL does not check them. A check needs a model of the deployment and the data state. It also forces a throw on a pipeline that is valid in another context. Rule #1 forbids exactly this: a throw on the probable, not the certain.

## Consequences

- JSMQL emits the MQL unchanged for all of these constraints, and the server decides.
- A position rule that involves an Atlas-only stage still applies. For example, `$search` must come first. The compiler skips only the availability check.
- Reconsider only if the compiler gets the deployment state as input, for example through schema binding (DEF-013).
