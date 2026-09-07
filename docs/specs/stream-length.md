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
[`src/namespace.ts`](../../src/namespace.ts)), after which the read is the field
path `"$__jsmql.length"`. The `length` row's cell in [`src/registry/names.ts`](../../src/registry/names.ts)
places the stamp through the `hoist` service — ahead of the statement that
holds the read, on the ROOT chain — and answers with the path the Env renders
for it.

```json
{ "$setWindowFields": { "output": { "__jsmql.length": { "$count": {} } } } }
```

`$setWindowFields` adds a field without collapsing the stream, so the documents
flow on unchanged. Requires **MongoDB 5.0+**. The materialise stage (and the
trailing `{ $unset: "__jsmql" }`) are emitted by the pipeline lowerers in
[`src/compiler/emit/statement.ts`](../../src/compiler/emit/statement.ts).

## Compute-once / reuse / recompute

The materialiser is hoisted **lazily** and cached:

- On the first statement that reads `$$.length`, a `$setWindowFields` is emitted
  ahead of that statement's stage(s).
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

Inside a callback the count cannot be recomputed, because the stamp is hoisted
to the FRONT of the body: the callback's third parameter is therefore refused
altogether in a body that runs any stage without `preservesCount`. Its message
names the stage. Reading it after a `$match` answered the collection's size
rather than the filtered stream's, and after a `$group` the field was gone and
every test on it fired.

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
(the single shape in [`src/namespace.ts`](../../src/namespace.ts)), placed one level
down, on the body's own chain, ahead of the stage that reads it. The parameter is
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

Distinct paths, no collision: the root count rides a `$$`-**variable**
(`jsmql_s0_length`), an inner sub-stream count rides the `$__jsmql.length` **field**, so a
`.map` body can read both at once (`totalUsers: $$.length`, `totalOrders:
coll.length`). The two are different source spellings — `$$.length` is the root
stream's `length`, `coll.length` is the callback parameter's — so the root capture
never fires for a handle.

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

