# System / diagnostic stages (`$$.indexStats()`, `$$$$.currentOp()`, …)

This sugar encodes scope in a method call, for MongoDB's *diagnostic / system*
source stages. Implementation: [`src/compiler/emit/statement.ts`](../../src/compiler/emit/statement.ts).
Scope metadata: the `diagnostic` fact on the stage's row in [`src/registry/names.ts`](../../src/registry/names.ts).
Wiring: [`src/compiler/emit/statement.ts`](../../src/compiler/emit/statement.ts) and the dispatch auto-wrap in
[`src/index.ts`](../../src/index.ts). User-facing reference:
[LANGUAGE.md → System / diagnostic stages](../LANGUAGE.md#system--diagnostic-stages-indexstats-currentop-).

## What and why

Some aggregation stages do not transform an incoming stream. They *produce*
one (index metadata, collection stats, running ops, …). MongoDB calls these
`inputStage`s. Each one must be the **first** stage of a pipeline. They also
differ by *where* they can run. This scope is what JSMQL's context-ref
prefixes already encode:

| Prefix | Scope | Driver | Stages |
| --- | --- | --- | --- |
| `$$` | current collection | `db.coll.aggregate()` | `$indexStats`, `$collStats`, `$planCacheStats`, `$listSearchIndexes` |
| `$$$` | current database | — | *(none)* |
| `$$$$` | cluster / server | admin (or `config`) DB | `$currentOp`, `$listSessions`, `$listLocalSessions`, `$listSampledQueries`, `$shardedDataDistribution` |

So `$$.indexStats()` reads as "this collection's index stats". `$$$$.currentOp()`
reads as "the deployment's current ops". The method name is the stage name
minus the leading `$`. Each one lowers to `{ $<stage>: <options-or-{}> }`. The
prefix *is* the scope, so a stage at the wrong scope causes a **compile-time**
error. This catches classic mistakes early, for example "ran `$indexStats`
through `db.aggregate()`" or "ran `$currentOp` through `db.coll.aggregate()`".
The compiler finds the mistake before it reaches the driver.

**Two tiers, not three.** An earlier draft put `$currentOp` and related stages
under `$$$` (current database). That draft was wrong. MongoDB requires these
stages to run on the **admin** database. For example, `$listSessions` reads the
cluster-wide `config.system.sessions`, never your current application database.
These stages report deployment-wide state. `$$$` means "current database" (the
database that `$$$.<coll>.find()` joins into), so `$$$.currentOp()` would read
as "ops in *this* database" — you cannot run this. These stages are server- or
cluster-level, so they live on `$$$$`. `$$$` therefore carries **no**
diagnostics; it keeps the `$$$.<coll>.find()` lookups and the
`$$$.<coll> = …` `$out` write. The real split is collection (`$$`) and
deployment (`$$$$`).

This fits the **"source visible after the prefix"** convention (CLAUDE.md). A
diagnostic is a *read* from a source, like `$$$.<coll>.find(...)`. The prefix
names what you read from. The generic stage dispatch already compiled these
stages (`{ $indexStats: {} }` / `$indexStats({})`). This sugar adds
discoverability and scope-checking. It adds no new compile capability.

## Lowering

```
$$.indexStats()                          → [{ $indexStats: {} }]
$$.collStats({ storageStats: {} })       → [{ $collStats: { storageStats: {} } }]
$$.planCacheStats()                      → [{ $planCacheStats: {} }]
$$.listSearchIndexes({ name: "idx" })    → [{ $listSearchIndexes: { name: "idx" } }]
$$$$.currentOp({ allUsers: true })       → [{ $currentOp: { allUsers: true } }]
$$$$.listSessions({ allUsers: true })    → [{ $listSessions: { allUsers: true } }]
$$$$.listLocalSessions({ users: [...] }) → [{ $listLocalSessions: { users: [...] } }]
$$$$.listSampledQueries({ namespace:"x" })→ [{ $listSampledQueries: { namespace: "x" } }]
$$$$.shardedDataDistribution()           → [{ $shardedDataDistribution: {} }]
```

The options-object argument is optional. It lowers through the stage's own
`body` rule, like every other stage body. With no argument, the body is an
empty `{}`. The options are literal config — booleans, strings, `{user, db}`
arrays. The compiler does not translate a `$.field` reference here.

`options: false` in the `diagnostic` metadata marks the three stages that take
*no* options: `$indexStats`, `$planCacheStats`, and `$shardedDataDistribution`.
An argument to one of these stages is rejected.

## Detection and disambiguation

A diagnostic call is a **direct** `MethodCall` whose `object` is a *bare* ref
node:

```
$$$$.currentOp()  → MethodCall { object: ClusterRef,                        method: "currentOp" }
$$$.orders.find() → MethodCall { object: MemberAccess { object: DatabaseRef }, method: "find" }   // a $lookup
```

The lookup form's receiver is a `MemberAccess` or `IndexAccess` node that
*wraps* the ref. So the two forms never collide. Even for a collection
literally named `currentOp`, the lookup still ends in `.find` or `.filter` on
a member access.

- On `$$`, the method namespace is **shared** with `.push` (union) and
  `.filter` (facet). `isSystemStageCall` claims a `$$` method only when it is
  an actual diagnostic, or a near-typo of one. So `$$.indexStat()` gives "did
  you mean `$$.indexStats(...)`". `$$.pop()` falls through to the union
  validator's `.push`/`.filter` guidance untouched.
- On `$$$` or `$$$$`, a direct call is a **diagnostic-only** namespace. So
  every direct call routes through the resolver, to get a precise error. This
  includes `$$$`, which has no diagnostics of its own: `$$$.currentOp()`
  resolves to the wrong-scope hint that points at `$$$$`. `$$$.foobar()`
  resolves to a "no diagnostics here, they're on `$$` / `$$$$`" message.

`detectSystemStageCall` splits its work the same way the union and lookup
translators split theirs. `isSystemStageCall(expr)` is the cheap boolean gate.
The `index.ts` auto-wrap also uses this gate, so a bare top-level
`$$$$.currentOp()` flips into Pipeline mode without a trailing `;`.
`resolveSystemStageCall(expr)` does the validation and returns the descriptor.

## First-stage-only

A diagnostic produces the stream. So any stage emitted before it is a
contradiction. The stage's row states the placement. The statement road checks
this against what the chain has emitted so far. A diagnostic that is not the
first statement is refused at the call-site position: "'$indexStats' produces
the pipeline's source documents, so it has to be the FIRST stage — the server
refuses it anywhere else. Move it to the top of the program."

## Error catalog

| Input | Error |
| --- | --- |
| `$$.currentOp()` | wrong scope → `'currentOp' is a cluster-scoped system stage — write '$$$$.currentOp(...)' (the '$$$$' cluster reference, run on the admin database), not '$$'.` |
| `$$$.currentOp()` | wrong scope → same, points at `$$$$.currentOp(...)` |
| `$$$$.indexStats()` | wrong scope → points at `$$.indexStats(...)` |
| `$$.indexStat()` | `Did you mean '$$.indexStats(...)'?` (nearest diagnostic, with its correct prefix) |
| `$$$.foobar()` | `'$$$.foobar(...)' is not a known diagnostic stage. '$$$' (database reference) has no diagnostic source stages — collection diagnostics use '$$', server/cluster diagnostics use '$$$$'.` |
| `$$.indexStats({})` | `'$$.indexStats()' takes no options — call it with no arguments.` |
| `$$.collStats(true)` | `'$$.collStats(...)' expects an options object literal …, not a boolean literal.` |
| `$$.collStats({}, {})` | `'$$.collStats(...)' takes at most one options object, but got 2 arguments.` |
| `$match($.x>1); $$.indexStats()` | `… must be the first stage. Move it to the front of the pipeline.` |

Every error carries a real `.pos`. This is the ref prefix for a scope or
unknown-method error, and the call site for an arg-count or first-stage error.
So `jsmql.validate()` returns a usable offset.

## Mode gates

This sugar works in Pipeline mode only, like the other source and sugar
shapes. `jsmql.pipeline()` accepts a diagnostic source stage. It auto-wraps
the stage as a one-stage Pipeline. `jsmql.filter()`, `jsmql.expr()`, and
`jsmql.update()` reach the bare-ref codegen error. This error now lists the
diagnostic forms among the supported shapes for each prefix. The arrow form
type-checks too: `$$` and `$$$$` are ambient globals with the diagnostic
methods declared ([globals-generation.md](globals-generation.md)).

