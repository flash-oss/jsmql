# `$$.length` → stream-cardinality value

## Overview

`$$.length` is the number of documents in the current stream **at the point it
is used** — the JS array-length idiom on the stream (`$$` is the current
collection/stream). It's a **value**, usable anywhere an expression is allowed:
a field RHS (`$.n = $$.length`), arithmetic (`$.share = 1 / $$.length`), an
`assert` condition (`assert($$.length <= 1, …)`), a stage body (`$project`,
`$group`), a top-level `$match` `$expr`.

See [`docs/LANGUAGE.md#length`](../LANGUAGE.md#length-count-the-current-stream) for the user-facing
reference.

## Mechanism

MQL has no inline "count of the current stream" operator — cardinality is a
stream aggregate, not a per-document value. So `$$.length` is **materialised**:
a `$setWindowFields` with a full-partition `$count` stamps the count onto every
document under the reserved system slot `__jsmql.length` (see
[`src/namespace.ts`](../../src/namespace.ts)), after which the read is the field
path `"$__jsmql.length"`. The `length` row's cell in [`src/registry/names.ts`](../../src/registry/names.ts)
places the stamp through the `hoist` service — ahead of the STAGE that holds the
read, on the ROOT chain — and answers with the path the Env renders for it.

```json
{ "$setWindowFields": { "output": { "__jsmql.length": { "$count": {} } } } }
```

`$setWindowFields` adds a field without collapsing the stream, so the documents
flow on unchanged. Requires **MongoDB 5.0+**. The materialise stage (and the
trailing `{ $unset: "__jsmql" }`) are emitted by the pipeline lowerers in
[`src/compiler/emit/statement.ts`](../../src/compiler/emit/statement.ts).

## Compute-once / reuse / recompute

The materialiser is hoisted **lazily** and cached:

- On the first read of `$$.length`, a `$setWindowFields` is emitted directly ahead
  of the stage that reads it — the stage the read's own lowering makes, not the
  first stage of the statement. So `$$.$match(p).map(d => $$.length)` counts the
  MATCHED documents, exactly as the two-statement spelling `$match(p); $.n =
  $$.length;` does ([lookup-stage.md § Where a hoisted stage lands](lookup-stage.md)).
- Subsequent uses **reuse** the stamped field — no new stage — as long as it
  stays *fresh*.
- After any stage that is **not** count-and-field preserving, the next use
  **recomputes** (emits a fresh `$setWindowFields`).

**Freshness-preserving stages** are the ones whose row states `preservesCount`
(`src/registry/names.ts`): the stage leaves the stream's COUNT and its documents'
FIELDS both untouched, so a count already stamped into a field is still the
count afterwards. A stage that states nothing invalidates. The rule is
**conservative**: recomputing is always correct and reusing a stale count is a
bug, so freshness is kept only where a row proves it safe.

Inside a callback the third parameter is refused altogether in a body that runs
any stage without `preservesCount`. The count is a FIELD stamped onto the body's
documents, and such a stage drops it (`$group`) or changes how many documents
there are (`$unwind`, `$match`, `$limit`) — so whether a read still means what it
says depends on where in the block it sits, and a stage body reads the documents
its own stage receives. `staleCountStage` asks the question of the SOURCE and
answers it once for the whole body, which is the conservative answer; its message
names the stage.

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
its document count — the same `$setWindowFields` `$count` → `__jsmql.length` stamp
(the single shape in [`src/namespace.ts`](../../src/namespace.ts)), placed on the
chain of the body that BOUND the handle, ahead of the stage that reads it.

**The binding carries that chain**, not the read: `Ref.streamHandle` in
[`src/compiler/emit/names.ts`](../../src/compiler/emit/names.ts) holds the `Chain` the
body assembles, and `Binding.level` its document level. Both are read back by
`streamHandleOf` in [`src/compiler/emit/inputs.ts`](../../src/compiler/emit/inputs.ts)
when the `hoist` service places the stamp. A DEEPER body reading an ANCESTOR's handle
therefore stamps the ancestor's own pipeline and reads the value back down through
each `$lookup.let` on the way — `jsmql_s<level>_length`, the same hop an outer field
takes. Taking the level from the READ instead collapses the two counts onto one
`$__jsmql.length` field, so `shpmntsColl.length < ordersColl.length` compared a value
with itself; nothing about that document is invalid MQL, so the server answers it
without a word. A `$facet` branch is the same trap by another route: it assembles a
chain of its own at the SAME level, so the chain and not the level is what decides. The parameter is
a `streamHandle` binding in the body's Env, and its `.length` is that inner count.
Placement is automatic: the chain appends each link's stages in order, so the count
reflects the sub-stream *at that chain point* (post-filter, post-`.slice`, …), and the
body's own trailing `{ $unset: "__jsmql" }` keeps the scratch field out of the `as`
array. Verified on mongod.

Only `.length` and a chain are available on the handle — a stream has no
materialised array to index — and the **index** (2nd) param is never available
(MongoDB streams have no per-document index; it may be present-but-unused only to
reach the 3rd param). Neither has an HR3-safe lowering.

## `$$.length` (ROOT count) inside a `$lookup` — captured into `$lookup.let`

`$$` is **always the ROOT stream**, regardless of nesting depth (mirroring `$` =
root document); an inner sub-stream count uses the 3rd-arg handle above, never the
`$$` sigil. So `$$.length` *inside* a `$lookup` body means the root count: the
`hoist` service places the stamp on the ROOT chain, and the Env renders the read
through the body's `let` capture — `let: { jsmql_s0_length: "$__jsmql.length" }`,
read as `$$jsmql_s0_length` — one hop per lookup level, exactly as an outer field
read is carried ([lookup-stage.md § The join road](lookup-stage.md)). Verified on
mongod (counts correct, no leak).

Distinct paths, no collision: a count read from a SHALLOWER level rides a
`$$`-**variable** (`jsmql_s<level>_length`) and the count of the body doing the reading
rides the `$__jsmql.length` **field**, so one body can read its own and every ancestor's
at once (`totalUsers: $$.length`, `ordersForUser: ordersColl.length`, `shipmentsHere:
shpmntsColl.length`) — each its own name, each taken from the right documents. The root
stream is level 0 by the same rule: `$$` is the ROOT stream wherever it is written (HR4)
and belongs to the top-most chain, which is not the chain of whatever body reads it.

**Every depth.** `$$` is the root stream wherever it is written (see
[LANG_RULES.md](../LANG_RULES.md)). A `$facet` branch and a declared function body
run over the stamped documents, so they read the field directly; a `$lookup` body
reads it through the `let` capture, one hop per lookup level.

**Empty sub-stream + `assert`.** An in-block `assert(coll.length > 0, …)` is a
per-document `$match` *inside* the `$lookup.pipeline`; on a foreign sub-stream
with zero matches there are no documents to evaluate, so the assert can't fire —
the `as` array is simply `[]`. This is inherent to `$lookup` (not a jsmql choice):
to *guarantee* a non-empty result, assert on the materialised array at the outer
level instead — `$.orders = $$$.orders.filter(p); assert($.orders.length > 0, "…")`
(verified to fire on mongod).

## Scope & rejections

`$$.length` resolves in every pipeline position: a top-level statement, a
`$lookup` body (through the `let` capture above), a `$facet` branch, a declared
function body. Rejected:

| Context | Why |
|---|---|
| Filter / `jsmql.expr` (no pipeline) | there is no stream to count — needs Pipeline mode |
| a `$$.push(…)` (`$unionWith`) body | the stage has no `let`, so no outer value reaches it — the refusal names the join form (`$.<field> = $$$.<coll>.filter(…)`) whose `$lookup` carries the value |

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

