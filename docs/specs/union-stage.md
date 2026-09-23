# `$$.push(...)` → `$unionWith` stage

## Overview

`$$.push(args...)` is the JSMQL surface for MongoDB's `$unionWith` stage. The
receiver `$$` is the current-collection context-reference (`CollectionRef`).
`.push(...)` is the JS array-mutation idiom — append items to the end. This
is also the semantic of `$unionWith` itself: take documents from another source
and append them to the current stream.

Statement-only: `$$.push(...)` emits one or more `$unionWith` pipeline stages
and has no value. JSMQL rejects it at compile time on a RHS, as an expression
operand, inside a Filter / `jsmql.expr` / `jsmql.update`, or inside another
lookup's sub-pipeline.

See [`docs/LANGUAGE.md#collection-union-push`](../LANGUAGE.md#collection-union-push)
for the user-facing reference.

## Lowering table

| Argument shape inside `$$.push(...)` | Output stage |
|---|---|
| `...$$$.<coll>` (bare collection spread) | `{ $unionWith: "<coll>" }` (short form) |
| `...$$$.<coll>.filter(pred)` | `{ $unionWith: { coll: "<coll>", pipeline: [<translated pred>] } }` |
| `$$$.<coll>.find(pred)` (no spread) | `{ $unionWith: { coll: "<coll>", pipeline: [<translated pred>, { $limit: 1 }] } }` |
| `{ inline document }` (one or more, consecutive) | `{ $unionWith: { pipeline: [{ $documents: [<docs>] }] } }` (consecutive inline docs batch into one stage) |
| `...$$$$.<db>.<coll>[.filter(pred)]` | **rejected** — a `{ db, coll }` `$unionWith` namespace works only on Atlas Data Federation; the join road refuses it ("A read of another DATABASE isn't supported …") and redirects the reader to `...$$$.<coll>` |
| `$$$$.<db>.<coll>.find(pred)` | **rejected** — same cross-database read rejection as the line above |

Source order across the argument list stays exactly as written. A `{...}` between
two non-inline args produces three stages, because the implementation flushes the
inline batch whenever a collection-sourced argument arrives.

### Predicate translation

An expression-body predicate lowers through the filter road ([filter-mode.md § The filter road](filter-mode.md)) with the parameter as the document, so the inner `$match` is the same index-friendly query document `$match` gets everywhere; a clause with no native form rides in `$expr` beside the translated ones:

| Predicate body | Inner stage |
|---|---|
| `o._id === "X"` | `{ $match: { _id: "X" } }` |
| `o.tier === "gold"` | `{ $match: { tier: "gold" } }` |
| `o.active` (truthiness) | `{ $match: { $expr: { $and: [{ $ne: [{ $ifNull: ["$active", null] }, null] }, { $ne: ["$active", false] }, { $ne: ["$active", ""] }, { $ne: ["$active", 0] }] } } }` — the JavaScript truthiness test |
| `o.active && o.tier === "gold"` | `{ $match: { tier: "gold", $expr: { … } } }` |

Block-body predicates pass through verbatim — JSMQL lowers each statement to a
stage exactly as it would at the top level. The join road lowers the body
(`lookupOf` in `src/compiler/emit/join.ts`, entered over `$unionWith`), so a
union body and a lookup body read the same rows; `src/compiler/emit/union.ts` owns
only what differs — the stage's shape and its missing `let`.

### A written list of documents, and only a written one

`$documents` takes a list the program spells out. MEASURED on the server, a field path
there is refused ("an array is expected"), and `{ coll, pipeline: [{ $documents }] }`
is refused too ("\$documents can only be run with database or cluster-level
aggregation"). So the appendable forms are: another collection (`coll`, with or without
a sub-pipeline), one written document, and a written list of them — `$$.push({ … })`,
`$$.push(...[{ … }, { … }])` and `$$.concat([{ … }])` all batch into one `$documents`,
consecutive arguments together, kept in source order. An array the data decides has no
append form at all; `$$ = <array>` makes the stream from it instead.

JSMQL lowers the list inside the `$unionWith` body, where the server evaluates it —
`noStageInDocuments` in [src/compiler/emit/union.ts](../../src/compiler/emit/union.ts)
holds the other half of that. Nothing there can read the outer document (the body has
no `let`, below), and `$documents` is the FIRST stage of that body, so nothing can
stand ahead of it to produce a value either: JSMQL refuses a field whose value would need
a stage of its own — a `$$$.<coll>` read's `$lookup`, the root count's `$setWindowFields` —
and names the collection append (`$$.push(...$$$.<coll>.filter(…))`) and the
constant / `jsmql.compile` parameter as the two ways out. Both spellings of the list
go through the same gate, so `$$.push({ n: <value> })` and `$$ = [{ n: <value> }]`
answer alike; lowered outside the boundary the second one emitted a field path the
server answered `{}` for, in silence.

### `$unionWith` has no `let`

`$lookup` has a correlation slot (`let`) — `$unionWith` does not. The body is entered with a null capture ([src/compiler/emit/env.ts](../../src/compiler/emit/env.ts) `Boundary.capture`), so JSMQL refuses a read of the outer document, or of an outer binding, inside it rather than silently misreading it: "'$unionWith' has no 'let': its body cannot read the outer document or a binding declared outside it. Filter or reshape the outer stream in a statement before it, or read the other collection through a join ('$.<field> = $$$.<coll>.filter(…)'), whose '$lookup' carries the value." The same holds for `$$.size()` there ([stream-size.md](stream-size.md)).

## AST and parser

No AST changes. `$$.push(...)` parses as a `MethodCall` whose `object` is a
`CollectionRef`. Spread arguments (`...$$$.coll`) use the existing
`SpreadElement` in `CallArg`. Block-body lambdas inside spreads
(`...$$$.coll.filter(o => { ... })`) work because `parsePostfix` already
threads `allowBlockBody` when the method receiver chain is rooted at
`DatabaseRef` / `ClusterRef`.

No `parseContextRef` changes were needed. The sanity guard that requires `.`
or `[` after `$$` already accommodates `.push(...)`.

## Error catalog

| Trigger | Message |
|---|---|
| `$$.push($$$.coll.filter(p))` (forgot `...`) | "'$$.push($$$.<coll>.filter(pred))' would push the whole array as one document. Spread it — '$$.push(...$$$.<coll>.filter(pred))' — to push every match, or write '.find(pred)' for the first one." |
| `$$.push(...$$$.coll.find(p))` (spurious `...`) | "'.find(pred)' gives ONE document, which JavaScript would not spread. Drop the '...' to push the match, or write '...$$$.<coll>.filter(pred)' to push every match." |
| `$$.push(42)` / `$$.push("x")` / `$$.push(null)` | "A stream holds documents, and this is a number. Push a document ('$$.push({ … })') or another collection ('$$.push(...$$$.<coll>)')." |
| `$$.push(...$$$.coll.filter(o => o.x === $.y))` (an outer read) | the no-`let` refusal above |
| `$$.push(...$$$$.<db>.<coll>…)` (cross-database) | the cross-database refusal ([lookup-stage.md](lookup-stage.md)) |
| `$$.push({ n: $$$.<coll>.find(p).<field> })` / `$$ = [{ n: … }]` — a value needing a stage | "'.push({ … })' writes the documents out as the program spells them, and this value needs a '$lookup' stage of its own to produce it … Append the other collection's documents themselves … or give the field a value the program already holds: a constant, or a 'jsmql.compile' parameter." |
| `$$.push(...)` inside a `$lookup` body | "'$$' is the root stream, and a body over another collection cannot reach it. Name the body's own stream through the callback's third parameter — '(o, _i, coll) => { coll.filter(…); }' — or write the stage: '$match(…)', '$sort(…)'." |
| `jsmql.filter("$$.push(...)")` | "jsmql.filter() expects a Filter (the document \`db.coll.find(filter)\` takes), but received a top-level 'push' stage call. Use jsmql.pipeline()." |
| `jsmql.update("$$.push(...)")` | "An update document is made of writes … This is neither." |

## Server-version note

The `coll`-less `$unionWith` shape that wraps a `$documents` stage needs
**MongoDB 6.0+**. Inline-doc pushes lower to that shape. Spread-of-collection
pushes work on every version that supports `$unionWith` (4.4+).

## Deferred

- **Custom let-substitution.** Atlas's `$lookup.let` does not apply to
  `$unionWith`, but a future JSMQL release could synthesise the same effect
  through a `$set` stage *before* the push and a `$match` against that captured
  value inside the sub-pipeline. Out of scope — the explicit "no
  correlation" error is the documented contract.
- **Cross-database unions are rejected at compile time.** A cross-database
  `$$.push(...$$$$.<db>.<coll>...)` / `$$.push($$$$.<db>.<coll>.find(...))`
  does not emit a `{ db, coll }` `$unionWith` namespace (that shape works only
  on Atlas Data Federation, and a regular server rejects it at runtime);
  the join road refuses it — see
  [`docs/specs/lookup-stage.md`](./lookup-stage.md) § Cross-database reads
  are rejected. The cross-database `$out` write is unaffected.
- **Auto-`$documents`-only `$unionWith` server-version guard.** There is no compile-time
  check that the deployment is 6.0+ — the runtime error is precise enough.
