# Pipeline validation (pre-flight)

jsmql is a compiler, so it can catch the pipeline mistakes the MongoDB server
would otherwise reject — *before* the query is sent. This spec covers the
compile-time validation layer: structural stage placement, per-stage body
shape, and `$match` query-operator placement.

## The two hard rules

1. **Only 100%-certain violations throw.** A merely *probable* violation must
   still emit MQL — never throw on it.
2. The dividing line is **certainty from the source**, not "is it documented" or
   "is the syntax first-class". jsmql reaches every MQL operator via `$op(...)`
   and raw object passthrough, so reachability is never a reason to skip a check.
   We throw on anything the server **always** rejects regardless of data or
   deployment; we emit MQL for anything that depends on runtime state (sharding,
   transactions, views, memory limits, collection type, read concern, Atlas
   availability) or on a value we can't pin down statically.

### The literal-gating invariant

Every value-level validator inspects **only fully-static literal shapes**. The
moment the checked slot holds a field reference, an expression, an operator call,
a template literal, a computed key, or a spread, the check becomes a no-op and
the MQL is emitted unchanged. This is how comprehensive coverage coexists with
rule #1: we never throw on a value we cannot statically pin down. (See the
helper gate — `litNumber` / `litString` / `litBool` / `describeLiteral` /
`objectInfo` / `arrayElements` — in `src/literal-gate.ts`, shared with the
operator-argument validator; see [operator-validation.md](operator-validation.md).)

**The constant-only-slot exception (HR3).** A few slots MUST hold a compile-time
constant — `$limit` / `$skip` / `$sample.size` / `$bucketAuto.buckets` /
`$graphLookup.maxDepth` (a constant integer) and `$bucket.boundaries` /
`$lookup.pipeline` (a constant array). There the gate is **inverted**: a field
reference or runtime expression is *itself* the 100%-certain violation (the
server rejects `{ $limit: "$n" }`, `{ $lookup: { pipeline: "$x" } }`, …), so it
throws. A compile-bound `ParamRef` is exempt — it inlines to a literal at codegen,
so it may be a valid constant. Implemented by `checkIntBound` (numeric slots) and
`requireConstantArray` (array slots) in `src/literal-gate.ts`.

## Part 1 — Structural stage placement (`src/pipeline.ts`)

Rules are declared in the STAGES registry (`src/stages.ts`) and applied by a
per-pipeline validator closure (`makePipelineValidator`) wired into the three
assembly functions (`generatePipeline`, `generateImplicitPipeline`,
`generatePipelineWithCtx`) and `lowerUpdateFilterWithLookups`.

- `position: "first"` / `stageMustBeFirst(def)` — must sit at index 0 of its
  pipeline. Set on the source stages: `$changeStream`, `$documents`, `$geoNear`,
  `$search`, `$searchMeta`, `$vectorSearch`, **plus all 9 `diagnostic` stages**
  (`stageMustBeFirst` derives those from the `diagnostic` field, so they don't
  repeat `position`).
- `position: "last"` / `stageMustBeLast(def)` — must be the final stage. Set on
  `$out`, `$merge`, `$changeStreamSplitLargeEvent`.
- `forbiddenIn: [...]` / `stageForbiddenIn(def, container)` — banned inside a
  sub-pipeline container. `$out`/`$merge` are banned in `facet`/`lookup`/`unionWith`;
  the `$facet`-forbidden source/search/write stages (`$collStats`, `$indexStats`,
  `$planCacheStats`, `$geoNear`, `$search`, `$searchMeta`, `$vectorSearch`, `$facet`)
  carry `forbiddenIn: ["facet"]`.

Uniqueness (at-most-once) is **not** a separate pass — it falls out: two
must-be-last stages mean the first isn't last; two must-be-first stages mean the
second has a predecessor.

### The source-stage decision

MongoDB's reference pages for `$listSearchIndexes`, `$listSampledQueries`, and
`$shardedDataDistribution` don't *state* a first-stage rule (verified by reading
each page). We still enforce must-be-first for them: each is a pure **source**
stage — it produces documents and ignores any incoming stream — so a non-first
placement has no valid runtime context. This is a structural certainty, and it
keeps the literal stage forms consistent with the sugar forms (which already
enforce must-be-first for every diagnostic via `system-stage-translation.ts`).

### Why the must-be-first check keys on the element index, not `out.length`

`checkStage` receives the **user-authored element index** (`i`), not the length
of the lowered output. Prologue stages — a `$lookup`/`$set` emitted by a prior
`let`/lookup statement, or by a buried lookup inside the stage's own body — make
`out.length` larger than the user's stage position. Because every prior *user*
element emits at least one stage, `i > 0` is equivalent to "a real preceding
stage exists", which is exactly the must-be-first violation. Keying on `i` also
means a source stage written first never false-throws because of compiler-injected
prologue.

### Sugar vs literal

The sugar forms keep their own dedicated, sugar-aware messages: `$out`
(`$$$.<coll> = …`) via `markSugarOut`, and the diagnostic source stages
(`$$.indexStats()`, …) via `notFirstStageMessage`. The new checks cover the
**literal** stage forms (`{ $merge: … }`, `{ $collStats: {} }`, `$geoNear({…})`)
that previously slipped past the sugar-only checks, plus `$merge` /
`$changeStreamSplitLargeEvent`, which had no enforcement at all.

## Part 2 — Per-stage body shape (`src/stage-validation.ts`)

`validateStageBody(stageName, body)` runs at the top of `generateStageBody` for
every user-written stage body (sugar-generated stages build their objects
directly and never pass through it). The `STAGE_BODY_VALIDATORS` map holds one
small, literal-gated validator per stage:

| Stage | Checks |
|---|---|
| `$limit` / `$skip` | literal non-number → type; non-integer → integer; out of bound (`$limit` ≥ 1, `$skip` ≥ 0) |
| `$sample` | required `size`; literal `size` non-negative integer |
| `$count` | literal field name: non-empty, no `$` prefix, no `.` |
| `$sort` | ≤ 32 keys; literal direction ∈ {1, -1} — a literal string (`"desc"`) or boolean direction is also rejected (a `{ $meta: … }` object is not a literal, so it passes the gate) |
| `$project` | non-empty; no inclusion/exclusion mixing (except `_id`) |
| `$addFields` / `$set` | object body (a scalar/array literal body is rejected) |
| `$densify` | object body; required `field`+`range` |
| `$unset` | non-empty string / non-empty array of strings (a non-string/non-array literal is rejected) |
| `$unwind` | string-form path starts with `$`; `includeArrayIndex` not `$`-prefixed; `preserveNullAndEmptyArrays` boolean |
| `$bucket` | required `groupBy`+`boundaries`; literal boundaries ≥ 2, strictly ascending, same type |
| `$bucketAuto` | required `groupBy`+`buckets`; literal `buckets` positive integer; `granularity` enum |
| `$setWindowFields` | required `output`; a window may not set both `documents` and `range` |
| `$fill` | required `output`; per field not both `value`+`method`; `method` enum; `sortBy` required with linear/locf |
| `$group` | required `_id` |
| `$lookup` | required `from`+`as` |
| `$unionWith` | object form needs `coll` and/or `pipeline` |
| `$graphLookup` | required `from`/`startWith`/`connectFromField`/`connectToField`/`as`; `maxDepth` ≥ 0 |
| `$merge` | required `into`; `whenMatched` / `whenNotMatched` enums (string form) |
| `$replaceRoot` / `$replaceWith` | new root must be a document (literal scalar/array rejected) |
| `$geoNear` | required `near` |
| `$documents` | literal must be an array |

Enum checks (`$merge.whenMatched`, `$fill.method`, `$bucketAuto.granularity`) run
the value through `closestNameTo` for a `Did you mean '…'?` suggestion. Required-key
checks skip when the body carries a spread (the key might be in it).

**Object-body guard (`requireObjectStageBody`).** Every object-bodied stage
(`$group`, `$project`, `$sort`, `$sample`, `$addFields`/`$set`, `$bucket*`,
`$setWindowFields`, `$fill`, `$densify`, `$graphLookup`, `$replaceRoot`,
`$geoNear`, `$lookup`) rejects a body that is a literal of a non-object kind
(`$group("externalId")` → `{ $group: "externalId" }`, which the server rejects)
with an actionable "expects an object body … e.g. …" message. Per the gate, a
field-ref / runtime-expression body still compiles. This guard is **not** applied
to `$merge` / `$unionWith` (a bare string is a valid collection name) or to the
expression-bodied stages (`$replaceWith`, `$sortByCount`, `$unwind`, `$count`,
`$limit`/`$skip`), which have their own type rules above.

## Part 3 — `$match` query-operator placement (`validateMatchPlacement`)

A raw `$match` object body passes through verbatim, so query operators are
reachable. `validateMatchPlacement(body, { isTopLevel, isFirstStage })` walks the
static body (recursing through nested field objects and `$and`/`$or` arrays):

- `$text` — the `$match` must be the pipeline's first stage.
- `$near` / `$nearSphere` / `$where` — not allowed in an aggregation `$match`;
  the error names the replacement (`$geoNear` / `$geoWithin` / `$expr`).

Only static object bodies are inspected — an expression body (`$match($.x > 1)`)
can't carry these operators.

## Emitted as MQL — not validated at compile time

The following depend on runtime state the compiler can't know, so the MQL is
emitted unchanged and the server decides (recorded as a decision in
`docs/DEFERRED.md` §B):

- Sharding constraints (`$out` to a sharded collection, `$unionWith`-in-`$lookup`
  on a sharded `coll`).
- Transaction restrictions, view-definition restrictions.
- Memory limits (`$group`/`$sort`/`$bucket` 100 MB without `allowDiskUse`), BSON 16 MB.
- Collection-type rules (`$out`→capped, `$merge`→time-series), read concern.
- Atlas availability of `$search` / `$searchMeta` / `$vectorSearch` /
  `$listSearchIndexes` (the *position* rule still applies; availability does not).

A few value-level rules are also left to the server because the value is
typically a runtime expression, not a literal: `$redact` resolving to
`$$DESCEND`/`$$PRUNE`/`$$KEEP`, `$densify` numeric-vs-date `range.unit`
selection (depends on the field's runtime type), and deep `$geoNear.near`
GeoJSON shape (only presence of `near` is required).

## Write stages: forbidden in every sub-pipeline

`$out` and `$merge` are the only stages the registry forbids in **all three** containers,
which makes them decidable without a container label. Membership comes from `forbiddenIn`
via `stageForbiddenInAnySubPipeline`, so a future all-container stage is picked up with no
code change. mongod rejects these with Location51047; HR3 says jsmql must not emit them.

Two checks enforce the rule, on opposite sides of lowering:

1. **Source side — `generateStageBody`** rejects such a stage whenever
   `GenerateCtx.inSubPipeline` is set. That covers a block-body lambda
   (`.aggregate((o) => { $out(…); })`, a `.filter` predicate block, a `$facet` branch block)
   even though the loop-position validator cannot label its container. This check knows the
   offending stage's own position, so it is the one users normally see.
2. **Output side — `assertNoWriteStageInSubPipeline`** walks the assembled stage array at
   each pipeline entry point and rejects a forbidden stage in any sub-pipeline slot
   (`subPipelineFields`, plus the `"*"` sentinel for `$facet`). It reads the emitted
   document, not a ctx flag, so a path that reaches a sub-pipeline slot without the flag is
   still rejected — and a container added later inherits the rule.

Check 1 stays because check 2 can only name the enclosing pipeline. `test/error-pos.test.ts`
pins the finer position, so a lowering path that drops the flag fails the suite even though
the rejection itself survives. `GenerateCtx.inSubPipeline` is a **required** field for the
same reason: a ctx built from scratch must declare which side of the boundary it starts on.
Where the container *is* known, the named message ("inside a '$lookup' sub-pipeline") wins —
it runs first, in the loop validator.

## The local-`$$` predicate gate

`requireStreamPredicate` (in [`src/lookup-translation.ts`](../../src/lookup-translation.ts),
beside the predicate lowering it feeds) is the **single** entry point for the argument of a
local `$$.filter(…)` / `$$.reject(…)`. It normalises every predicate spelling — arrow,
block body returning the predicate, matches-object, field name, `["field", value]` pair —
into the single-parameter arrow the lowering consumes, and enforces that arity. (A block body
is folded to its value form by `callbackBlockToValue`; see
[method-dispatch.md](method-dispatch.md) § Callback block bodies.) It is the local-stream counterpart to what
`detectLookupCall` + `validateLookupShape` already do for the foreign `$$$.<coll>.filter(…)`
side.

**The invariant: one predicate position, one vocabulary, one lowering — which spelling you
write never changes the emitted MQL.** Every container routes through the gate: the `$$ =`
stream ([replace-stream-stage.md](replace-stream-stage.md)), a `$facet` branch
([replace-root-stage.md](replace-root-stage.md)), and an `$out` write chain
([out-stage.md](out-stage.md)). A new container calls the gate and lowers the `Lambda` it
returns; it must not read the raw argument itself.

Why the gate exists rather than a convention: each container used to hand-roll its own
argument handling, and the three drifted. `$out` accepted only an arrow; the `$$ =` stream
accepted a matches-object but lowered it down a *raw-query* path (`{ $match: <object as
query> }`), so a non-constant matcher value emitted an aggregation operator into query
position — `$$ = $$.filter({ a: 2 + 3 })` produced `{ $match: { a: { $add: [2, 3] } } }`,
which mongod rejects with "unknown operator: $add" (an HR3 violation), and
`{ a: $.b }` silently matched the *string* `"$b"`; the field-name and `["field", value]`
spellings worked in neither. The paired `localRefInPredicateMessage` is shared for the same
reason — after normalisation the "lambda parameter" of a shorthand is the gate's *synthetic*
name, which must never be named back at the user as if it were writable.

## Known gap

Forbidden-in-context is enforced for **literal** sub-pipeline arrays
(`{ $facet: { … } }`, `{ $lookup: { pipeline: […] } }`,
`{ $unionWith: { pipeline: […] } }`) via `generatePipelineWithCtx(container)`, and the
all-container write stages are enforced everywhere (previous section). What remains is the
stage that just **one** container forbids — a diagnostic, `forbiddenIn: ["facet"]` — inside an
**`.aggregate` block** (`$$$.c.aggregate(o => { … })`). Such a stage still gets must-first /
must-last validation but not the container ban, because the shared `lowerBlock` lowerer runs
`generateImplicitPipeline` with `container: "top"`. A container label there needs
per-call-site threading, deferred to `[DEF-024]` — `lowerBlock` also serves
predicate→`$match` translation, which emits top-level stages, so one fixed label would
mislabel those. The literal-array path covers the common case and this gap never produces a
false positive.
