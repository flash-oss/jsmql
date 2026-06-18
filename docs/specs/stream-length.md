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

## Scope & rejections

`$$.length` is **top-level pipeline only**, gated by the `topLevelStream` ctx
flag (set by the two pipeline lowerers, preserved by `extendCtx` for
same-document lambdas, dropped by `freshSubPipelineCtx`). Rejected:

| Context | Why |
|---|---|
| Filter / `jsmql.expr` (no pipeline) | there is no stream to count — needs Pipeline mode |
| inside a `$lookup`/`$facet`/`$unionWith` sub-pipeline | would mean the sub-stream's length — not supported yet, **[DEF-033]** |
| inside a reusable function body (`const f = () => $$.length`) | the body inlines at the call site but isn't in the per-statement scan's AST — **[DEF-033]** |

A top-level `.map`/`.filter` lambda (same document) **is** allowed — the stamped
field is on the document and accessible inside `$map`/`$filter`.

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
