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
| `$unset` | non-empty string / non-empty array of strings |
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

## Known gap

Forbidden-in-context is enforced for **literal** sub-pipeline arrays
(`{ $facet: { … } }`, `{ $lookup: { pipeline: […] } }`,
`{ $unionWith: { pipeline: […] } }`) via `generatePipelineWithCtx(container)`.
A literal write/source stage written inside a **sugar predicate block-body**
lambda (`$$$.c.filter(o => { … })`) still gets must-first / must-last validation
but not the container ban, because the shared `lowerBlock` lowerer runs
`generateImplicitPipeline` with `container: "top"`. Threading the container
through `lowerBlock` is deferred to a follow-up `[DEF-024]` — `lowerBlock` is
used pervasively for predicate→`$match` translation where a fixed container
would mislabel messages; the literal-array path covers the common case and this
gap never produces a false positive.
