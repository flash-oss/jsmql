# System / diagnostic stages (`$$.indexStats()`, `$$$.currentOp()`, …)

Scope-encoding method-call sugar for MongoDB's *diagnostic / system* source
stages. Implementation: [`src/system-stage-translation.ts`](../../src/system-stage-translation.ts);
scope metadata: the `diagnostic` field on entries in [`src/stages.ts`](../../src/stages.ts);
wiring: [`src/pipeline.ts`](../../src/pipeline.ts) and the dispatch auto-wrap in
[`src/index.ts`](../../src/index.ts). User-facing reference:
[LANGUAGE.md → System / diagnostic stages](../LANGUAGE.md#system--diagnostic-stages-indexstats-currentop-).

## What and why

A handful of aggregation stages don't transform an incoming stream — they
*produce* one (index metadata, collection stats, running ops, …). MongoDB calls
these `inputStage`s: they must be the **first** stage of a pipeline. They also
differ by *where* they legally run, and that scope is exactly what jsmql's
context-ref prefixes already encode:

| Prefix | Scope | Driver | Stages |
| --- | --- | --- | --- |
| `$$` | current collection | `db.coll.aggregate()` | `$indexStats`, `$collStats`, `$planCacheStats`, `$listSearchIndexes` |
| `$$$` | current database | `db.aggregate()` | `$currentOp`, `$listSessions`, `$listLocalSessions`, `$listSampledQueries` |
| `$$$$` | current cluster | admin | `$shardedDataDistribution` |

So `$$.indexStats()` reads "this collection's index stats", `$$$.currentOp()`
reads "this database's current ops". The method name is the stage name minus the
leading `$`. Each lowers to `{ $<stage>: <options-or-{}> }`. Because the prefix
*is* the scope, a stage used at the wrong scope is a **compile-time** error —
the classic "ran `$indexStats` through `db.aggregate()`" / "ran `$currentOp`
through `db.coll.aggregate()`" mistake is caught before it reaches the driver.

This fits the **"source visible after the prefix"** convention (CLAUDE.md): a
diagnostic is a *read* from a source, like `$$$.<coll>.find(...)` is — the prefix
names what you're reading from. These stages already compiled via the generic
stage dispatch (`{ $indexStats: {} }` / `$indexStats({})`); this is added
discoverability and scope-checking, not new compile capability.

## Lowering

```
$$.indexStats()                          → [{ $indexStats: {} }]
$$.collStats({ storageStats: {} })       → [{ $collStats: { storageStats: {} } }]
$$.planCacheStats()                      → [{ $planCacheStats: {} }]
$$.listSearchIndexes({ name: "idx" })    → [{ $listSearchIndexes: { name: "idx" } }]
$$$.currentOp({ allUsers: true })        → [{ $currentOp: { allUsers: true } }]
$$$.listSessions({ allUsers: true })     → [{ $listSessions: { allUsers: true } }]
$$$.listLocalSessions({ users: [...] })  → [{ $listLocalSessions: { users: [...] } }]
$$$.listSampledQueries({ namespace:"x" })→ [{ $listSampledQueries: { namespace: "x" } }]
$$$$.shardedDataDistribution()           → [{ $shardedDataDistribution: {} }]
```

The optional options-object argument lowers through the same `generateStageBody`
path every other stage body uses — all nine declare `subPipelineFields: []`, so
it's a plain recursive object codegen. No argument → an empty `{}` body. The
options are literal config (booleans, strings, `{user, db}` arrays); no `$.field`
translation is involved.

`options: false` in the `diagnostic` metadata marks the three stages that take
*no* options (`$indexStats`, `$planCacheStats`, `$shardedDataDistribution`) — an
argument to one of those is rejected.

## Detection and disambiguation

A diagnostic call is a **direct** `MethodCall` whose `object` is a *bare* ref
node:

```
$$$.currentOp()   → MethodCall { object: DatabaseRef,                       method: "currentOp" }
$$$.orders.find() → MethodCall { object: MemberAccess { object: DatabaseRef }, method: "find" }   // a $lookup
```

The lookup form's receiver is a `MemberAccess`/`IndexAccess` *wrapping* the ref,
so the two never collide — even for a collection literally named `currentOp`, the
lookup still ends in `.find`/`.filter` on a member access.

- On `$$`, the method namespace is **shared** with `.push` (union) and `.filter`
  (facet). `isSystemStageCall` only claims a `$$` method that is an actual
  diagnostic *or a near-typo of one* (so `$$.indexStat()` → "did you mean
  indexStats", but `$$.pop()` falls through to the union validator's
  `.push`/`.filter` guidance untouched).
- On `$$$` / `$$$$`, a direct call is a **diagnostic-only** namespace, so every
  direct call routes through the resolver to get a precise error.

`detectSystemStageCall` work is split the same way the union/lookup translators
split theirs: `isSystemStageCall(expr)` is the cheap boolean gate (also used by
the `index.ts` auto-wrap so a bare top-level `$$$.currentOp()` flips into
Pipeline mode without a trailing `;`), and `resolveSystemStageCall(expr)` does
the validation and returns the descriptor.

## First-stage-only

A diagnostic produces the stream, so anything emitted before it is a
contradiction. Both `generatePipeline` and `generateImplicitPipeline` enforce
`out.length === 0` at the point the diagnostic is lowered and otherwise throw
`'$$.indexStats(...)' produces the pipeline's source documents (\`$indexStats\`),
so it must be the first stage.` at the call-site position.

## Error catalog

| Input | Error |
| --- | --- |
| `$$.currentOp()` | wrong scope → `'currentOp' is a database-scoped system stage — write '$$$.currentOp(...)' (the '$$$' database reference, run on db.aggregate()), not '$$'.` |
| `$$$.indexStats()` | wrong scope → points at `$$.indexStats(...)` |
| `$$.indexStat()` | `Did you mean 'indexStats'?` (nearest diagnostic at that scope) |
| `$$$.foobar()` | `'$$$.foobar(...)' is not a known diagnostic stage. '$$$' (database reference) supports the database-scoped system stages: .currentOp(), .listLocalSessions(), .listSampledQueries(), .listSessions().` |
| `$$.indexStats({})` | `'$$.indexStats()' takes no options — call it with no arguments.` |
| `$$.collStats(true)` | `'$$.collStats(...)' expects an options object literal …, not a boolean literal.` |
| `$$.collStats({}, {})` | `'$$.collStats(...)' takes at most one options object, but got 2 arguments.` |
| `$match($.x>1); $$.indexStats()` | `… must be the first stage. Move it to the front of the pipeline.` |

All errors carry a real `.pos` (the ref prefix for scope/unknown-method errors,
the call site for arg-count and first-stage errors) so `jsmql.validate()` returns
a usable offset.

## Mode gates

Pipeline-only, like the other source/sugar shapes. `jsmql.pipeline()` accepts a
diagnostic source stage (auto-wrapped as a one-stage Pipeline). `jsmql.filter()`,
`jsmql.expr()`, and `jsmql.update()` reach the bare-ref codegen error, which now
lists the diagnostic forms among the supported shapes for each prefix.

## Out of scope

- **Arrow-form / TS types.** `$$`/`$$$`/`$$$$` are not yet ambient globals (see
  [context-references.md → Future work](./context-references.md#future-work)), so
  `jsmql(($) => $$.indexStats())` won't type-check. String form works fully. When
  the ambient globals land, the diagnostic methods are declared alongside the
  existing `.push`/`.find` sugar.
- `$documents` and `$sample` are **not** diagnostics — they're source/regular
  stages with their own natural forms — and are not part of this surface.
