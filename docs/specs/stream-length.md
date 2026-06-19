# `$$.length` → stream-cardinality value

## Overview

`$$.length` is the number of documents in the current stream **at the point it
is used** — the JS array-length idiom on the stream (`$$` is the current
collection/stream). It's a **value**, usable anywhere an expression is allowed:
a field RHS (`$.n = $$.length`), arithmetic (`$.share = 1 / $$.length`), an
`assert` condition (`assert($$.length <= 1, …)`), a stage body (`$project`,
`$group`), a top-level `$match` `$expr`.

See [`docs/LANGUAGE.md#length`](../LANGUAGE.md#length) for the user-facing
reference.

## Mechanism

MQL has no inline "count of the current stream" operator — cardinality is a
stream aggregate, not a per-document value. So `$$.length` is **materialised**:
a `$setWindowFields` with a full-partition `$count` stamps the count onto every
document under the reserved system slot `__jsmql.length` (see
[`src/namespace.ts`](../../src/namespace.ts)), after which codegen reads it back
as the field path `"$__jsmql.length"` (`generateStreamLength` in
[`src/codegen.ts`](../../src/codegen.ts)).

```json
{ "$setWindowFields": { "output": { "__jsmql.length": { "$count": {} } } } }
```

`$setWindowFields` adds a field without collapsing the stream, so the documents
flow on unchanged. Requires **MongoDB 5.0+**. The materialise stage (and the
trailing `{ $unset: "__jsmql" }`) are emitted by the pipeline lowerers in
[`src/pipeline.ts`](../../src/pipeline.ts).

## Compute-once / reuse / recompute

The materialiser is hoisted **lazily** and cached:

- On the first statement that reads `$$.length`, a `$setWindowFields` is emitted
  ahead of that statement's stage(s).
- Subsequent uses **reuse** the stamped field — no new stage — as long as it
  stays *fresh*.
- After any stage that is **not** count-and-field preserving, the next use
  **recomputes** (emits a fresh `$setWindowFields`).

**Freshness-preserving stages** (allowlist — `STREAM_LENGTH_PRESERVING`):
`$set`, `$addFields`, `$sort`, `$lookup`, `$setWindowFields`. Everything else
(`$match`, `$group`, `$bucket*`, `$unwind`, `$limit`, `$skip`, `$sample`,
`$project`, `$unset`, `$replaceWith`/`$replaceRoot`, `$unionWith`, `$facet`,
the sugar forms, …) invalidates. The rule is **conservative**: recomputing is
always correct, reusing a stale count is a bug — so freshness is kept only
across provably-safe stages.

Detection is a **complete** AST walk (`someExpr` / `containsStreamLength` in
`pipeline.ts`, covering every child-bearing `Expr` node), because a missed node
would let `$$.length` slip through un-materialised and emit a dangling
`$__jsmql.length`.

## Worked examples

**Simple** — annotate each document with the stream count:
```js
$.total = $$.length;
```
```json
[
  { "$setWindowFields": { "output": { "__jsmql.length": { "$count": {} } } } },
  { "$set": { "total": "$__jsmql.length" } },
  { "$unset": "__jsmql" }
]
```

**Complex** — reuse, then recompute after an invalidating `$match`:
```js
$.before = $$.length;          // materialise
$match($.keep === true);       // invalidates
$.after = $$.length;           // recompute (post-match count)
```
```json
[
  { "$setWindowFields": { "output": { "__jsmql.length": { "$count": {} } } } },
  { "$set": { "before": "$__jsmql.length" } },
  { "$match": { "keep": true } },
  { "$setWindowFields": { "output": { "__jsmql.length": { "$count": {} } } } },
  { "$set": { "after": "$__jsmql.length" } },
  { "$unset": "__jsmql" }
]
```
Verified on a live mongod 8.2: `before` = pre-match count, `after` = post-match
count.

## Sub-stream length: the lookup-chain `.map` 3rd-arg handle

A `$$$.<coll>.filter(p).map((o, _i, coll) => …)` chain runs its `.map` as a
per-foreign-doc transform *inside* the `$lookup.pipeline`. There, `coll` (the 3rd
callback param) names the **filtered foreign sub-stream**, and `coll.length` is
its document count — materialised by the *same* `streamLengthStage()`
(`$setWindowFields` `$count` → `__jsmql.length`, the single shape in
[`src/namespace.ts`](../../src/namespace.ts)) one level down, stamped immediately
before the `.map`'s `$replaceWith`. `MAP.lower` (stream-methods.ts) prepends it
when `coll.length` is read, and binds the handle via
`GenerateCtx.substreamLengthHandles` (`coll → "$__jsmql.length"`), which
`generateLengthAccess` resolves directly (no `$size` — the count field is always
present). Placement is automatic: the chain assembler appends each method's
stages in order, so the count reflects the sub-stream *at that chain point*
(post-filter, post-`.slice`, …). The object `$replaceWith` drops the scratch
field, so no inner `$unset` is needed for `.map`. Verified on live mongod.

Only `.length` is available on the handle — a stream has no materialised array to
index or iterate — and the **index** (2nd) param is never available (MongoDB
streams have no per-doc index; it may be present-but-unused only to reach the 3rd
param). Both rejections are permanent (no DEF row): there is no HR3-safe stream
index, and the array-form is reached via the materialised path instead.

**Block-body `.filter`.** The same 3rd-arg handle works in a block-body lookup
filter — `$.orders = $$$.orders.filter((o, _i, coll) => { $match(o.userId === $._id); assert(coll.length > 0, "…"); })`.
There the block lowers to the `$lookup.pipeline` (via `lowerBlock` →
`generateImplicitPipeline`, which already runs the materialiser since `lowerBlock`
uses `container: "top"`), `buildBlockBodyPredicate` binds `coll` via
`substreamLengthHandles`, and the materialiser stamps the `$setWindowFields`
ahead of the statement that reads `coll.length` (here the `assert` `$match`).
Because the block keeps the foreign documents (a filter doesn't reshape), the
trailing `{ $unset: "__jsmql" }` fires *inside* the sub-pipeline so the count
field doesn't leak into the `as` array. The same index / non-`.length`
rejections apply (checked in `buildBlockBodyPredicate`).

## `$$.length` (ROOT count) inside a `$lookup` — captured into `$lookup.let`

`$$` is **always the ROOT/top-level stream**, regardless of nesting depth
(mirroring `$` = root document); an inner sub-stream count uses the 3rd-arg
handle above, never the `$$` sigil. So `$$.length` *inside* a top-level `$lookup`
means the root count: jsmql materialises it at the top (`isStreamLengthNode` /
`containsStreamLength` detect the `$$.length` *anywhere* in the statement,
including inside the sub-pipeline, so the top-level materialiser fires), then the
lookup **captures** the root field into its `$lookup.let` as a depth-stamped
`v0_len: "$__jsmql.length"`, and codegen reads `$$.length` back as `$$v0_len`
(via `GenerateCtx.rootStreamLengthVar`, set by `captureRootStreamLength` in
lookup-translation.ts). This is wired into every top-level lookup body — the
expression-body predicate (`translatePredicate`), the `$.x =` chained pivot
(`tryExtractChainedLookup`), and the `$$ =` replace-stream pivot (pipeline.ts) —
so `$$.length` works in all three. Verified on mongod (counts correct, no leak).

Distinct paths, no collision: the root count rides a `$$`-**variable**
(`v0_len`), an inner sub-stream count rides the `$__jsmql.length` **field**, so a
`.map` body can read both at once (`totalUsers: $$.length`, `totalOrders:
coll.length`). The detection keys on node type — `$$.length` is a
`CollectionRef.length`, a handle is a `ParamRef.length` — so the outer scan only
ever fires for the root sigil, never for a handle.

**Depth limit (`[DEF-033]`).** Capture is gated to `depth === 0` (the top-level
lookup, where `$__jsmql.length` lives on the input docs). A `$$.length` *deeper*
than one lookup level, or inside a `$facet`/`$unionWith` sub-pipeline or a
reusable function body, is not captured and stays rejected — there the root field
isn't reachable by a single `let` hop.

**Empty sub-stream + `assert`.** An in-block `assert(coll.length > 0, …)` is a
per-document `$match` *inside* the `$lookup.pipeline`; on a foreign sub-stream
with zero matches there are no documents to evaluate, so the assert can't fire —
the `as` array is simply `[]`. This is inherent to `$lookup` (not a jsmql choice):
to *guarantee* a non-empty result, assert on the materialised array at the outer
level instead — `$.orders = $$$.orders.filter(p); assert($.orders.length > 0, "…")`
(verified to fire on mongod).

## Scope & rejections

`$$.length` resolves at the top level (the `topLevelStream` ctx flag, set by the
two pipeline lowerers) and, via the `$lookup.let` capture above, inside a
top-level `$lookup` (`rootStreamLengthVar`). Rejected:

| Context | Why |
|---|---|
| Filter / `jsmql.expr` (no pipeline) | there is no stream to count — needs Pipeline mode |
| inside a `$facet` / `$unionWith` sub-pipeline | the root field isn't reachable by a `$lookup.let` hop there — not supported yet, **[DEF-033]** |
| a `$$.length` *deeper* than one `$lookup` level | capture is gated to `depth === 0`; deeper nesting needs let-chaining — **[DEF-033]** |
| inside a reusable function body (`const f = () => $$.length`) | the body inlines at the call site but isn't in the per-statement scan's AST — **[DEF-033]** |

A top-level `$lookup` body (predicate, block, `.map` chain) **is** supported — the
root count is captured into `$lookup.let` (see the section above). A top-level
`.map`/`.filter` lambda over the same document is likewise fine (the stamped field
is on the document).

## Empty stream

`$setWindowFields` over 0 input documents produces 0 output, so a using
statement on an empty stream yields an empty result (no rows, no count to
report). Note for the `assert` use: an upper-bound assertion (`<= n`) holds
vacuously on an empty stream, while a lower-bound one (`>= n`) can't fire there —
that semantics belongs to the assertion, not to `$$.length` itself.

## Cleanup & namespace

`__jsmql.length` lives under the `__jsmql` namespace object (see
[`src/CLAUDE.md`](../../src/CLAUDE.md) § the `__jsmql` namespace), so the single
trailing `{ $unset: "__jsmql" }` that already cleans `let` bindings and lookup
slots removes it too — no separate cleanup. The trailing `$unset` is emitted
whenever `$$.length` was materialised (peephole-skipped after a reshape stage).

## Deferred

Sub-pipeline and reusable-function-body uses are tracked as **[DEF-033]** in
[`docs/DEFERRED.md`](../DEFERRED.md).
