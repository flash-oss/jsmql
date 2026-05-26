# `$$.push(...)` → `$unionWith` stage

## Overview

`$$.push(args...)` is the jsmql surface for MongoDB's `$unionWith` stage. The
receiver `$$` is the current-collection context-reference (`CollectionRef`).
`.push(...)` is the JS array-mutation idiom — append items to the end — which
is the semantic of `$unionWith` itself: take documents from another source
and append them to the current stream.

Statement-only: `$$.push(...)` emits one or more `$unionWith` pipeline stages
and has no value. Using it on a RHS, as an expression operand, inside a
Filter / `jsmql.expr` / `jsmql.update`, or inside another lookup's sub-pipeline
is rejected at compile time.

See [`docs/LANGUAGE.md#collection-union-push`](../LANGUAGE.md#collection-union-push)
for the user-facing reference.

## Lowering table

| Argument shape inside `$$.push(...)` | Output stage |
|---|---|
| `...$$$.<coll>` (bare collection spread) | `{ $unionWith: "<coll>" }` (short form) |
| `...$$$.<coll>.filter(pred)` | `{ $unionWith: { coll: "<coll>", pipeline: [<translated pred>] } }` |
| `$$$.<coll>.find(pred)` (no spread) | `{ $unionWith: { coll: "<coll>", pipeline: [<translated pred>, { $limit: 1 }] } }` |
| `{ inline document }` (one or more, consecutive) | `{ $unionWith: { pipeline: [{ $documents: [<docs>] }] } }` (consecutive inline docs batch into one stage) |
| `...$$$$.<db>.<coll>[.filter(pred)]` | `{ $unionWith: { coll: { db, coll }, pipeline?: [...] } }` (Atlas Data Federation; community server rejects at runtime) |
| `$$$$.<db>.<coll>.find(pred)` | Cross-DB variant of the `.find` line, same `$match` + `$limit: 1` body |

Source order across the argument list is preserved exactly. A `{...}` between
two non-inline args produces three stages — the implementation flushes the
inline batch whenever a collection-sourced argument arrives.

### Predicate translation

For expression-body predicates, the body is rewritten via
`extractLetsFromExpr` (the same helper `$lookup`'s pipeline-form uses) and
then run through `translateMatchBody` — the same engine `$match` uses. The
result is an index-friendly `{ field: value }` query document inside the
inner `$match`, not a blanket `{ $expr: … }` wrap. Untranslatable residuals
still ride in `$expr`, side-by-side with the translated portion:

| Predicate body | Inner stage |
|---|---|
| `o._id === "X"` | `{ $match: { _id: "X" } }` |
| `o.tier === "gold"` | `{ $match: { tier: "gold" } }` |
| `o.active` (truthiness) | `{ $match: { $expr: "$active" } }` (no query-form equivalent) |
| `o.active && o.tier === "gold"` | `{ $match: { tier: "gold", $expr: "$active" } }` |

Block-body predicates pass through verbatim — each statement is lowered to a
stage exactly as it would be at the top level. The same `lowerBlock`
`SubPipelineLowerer` callback that `lookup-translation` uses is shared with
`union-translation`.

### `$unionWith` has no `let`

`$lookup` has a correlation slot (`let`) — `$unionWith` does not. The union
translator detects any local-document (`$.x`) reference in the predicate and
throws a precise error pointing the user at the documented fix: move the
local filter to a `$match(...)` stage *before* `$$.push(...)`.

Concretely, the union predicate translator (`translateUnionPredicate` in
[`src/union-translation.ts`](../../src/union-translation.ts)):

1. Calls `extractLetsFromExpr` / `extractLetsFromPipeline` to get the
   rewritten body and the let-variable map.
2. If `Object.keys(letVars).length > 0` → throw `correlatedPushPredicateMessage`.
3. Otherwise run `translateMatchBody` and emit a single `$match` stage (or
   pass the block stages through unchanged).

## AST and parser

No AST changes. `$$.push(...)` parses as a `MethodCall` whose `object` is a
`CollectionRef`. Spread arguments (`...$$$.coll`) use the existing
`SpreadElement` in `CallArg`. Block-body lambdas inside spreads
(`...$$$.coll.filter(o => { ... })`) work because `parsePostfix` already
threads `allowBlockBody` when the method receiver chain is rooted at
`DatabaseRef` / `ClusterRef`.

No `parseContextRef` changes were needed. The sanity guard that requires `.`
or `[` after `$$` already accommodates `.push(...)`.

## Module layout

```
src/
  union-translation.ts     New. Detects $$.push, validates shape,
                           lowers args to $unionWith stages with
                           inline-doc batching, source-order-preserving,
                           and JS-faithful spread rules.
  lookup-translation.ts    Existing. `extractLookupTarget`,
                           `extractLetsFromExpr`, `extractLetsFromPipeline`,
                           `validateLookupShape` are exported and reused by
                           union-translation.
  pipeline.ts              Updated. `generatePipeline` and
                           `generateImplicitPipeline` both detect a top-level
                           $$.push and lower via `lowerUnionPush` before
                           falling through to the generic stage-element path.
                           `isStageCandidate` recognises $$.push so an
                           array starting with one (or a sub-pipeline carrying
                           one) flips into pipeline mode. `generatePipelineWithCtx`
                           rejects nested $$.push with a hoist hint, mirroring
                           the nested-lookup rule. The `lowerBlock`
                           SubPipelineLowerer rejects $$.push inside a
                           block-body lookup callback.
  codegen.ts               Updated. `CollectionRef` case message updated to
                           name the supported `.push(...)` shapes and the
                           statement-only constraint.
  index.ts                 Updated. Top-level `$$.<method>(...)` (any method)
                           auto-wraps as a single-statement Pipeline so the
                           pipeline-level validators (validateUnionPushShape,
                           the union lowerer) surface their precise errors
                           instead of the generic CollectionRef one. Mode
                           gates (`jsmql.filter`, `jsmql.expr`, `jsmql.update`)
                           pre-reject lookup-bearing inputs via
                           `containsUnionPush` with apiName-specific messages.
```

## Error catalog

All errors below set `.pos` to the offending node (the receiver, the spread
argument, the inline doc, or the entire push call as appropriate).

| Trigger | Message excerpt |
|---|---|
| `$$.foo`, `$$["x"]` (member / index access — no `.push`) | `'$$' (current collection) is statement-only and only supports '.push(...)'. Write $$.push({...}), $$.push(...$$$.<coll>[.filter(pred)]), or $$.push($$$.<coll>.find(pred)) as a top-level Pipeline statement…` |
| `$$.pop(...)` (wrong method) | `'$$' (current collection) only supports .push(...) — .pop() is not defined. Use $$.push({...}) to append a single document, $$.push(...$$$.<coll>) or $$.push(...$$$.<coll>.filter(pred)) to union with another collection, or $$.push($$$.<coll>.find(pred)) to append a single matching document.` |
| `$.x = $$.push(...)` (RHS / value position) | `'$$' (current collection) is statement-only … '$$.push(...)' cannot appear on a RHS or inside another expression.` |
| `$$.push()` (no args) | `$$.push() requires at least one argument — a document literal ({…}), a spread of $$$.<coll>[.filter(pred)], or $$$.<coll>.find(pred).` |
| `$$.push($$$.coll.filter(p))` (forgot `...`) | `$$.push(...) was given $$$.<coll>.filter(pred) without ... — that would push the whole array as a single document. Use $$.push(...$$$.<coll>.filter(pred)) to append every matching document, or switch to .find(pred) if you meant the first match.` |
| `$$.push(...$$$.coll.find(p))` (spurious `...`) | `$$.push(...arg) was given ...$$$.<coll>.find(pred) — .find returns a single document, not an array, so spreading isn't meaningful (JS would TypeError). Drop the ... to append the matched document, or switch to ...$$$.<coll>.filter(pred) to append every match.` |
| `$$.push(42)` / `$$.push("x")` / `$$.push(null)` | `$$.push(...) argument must be a document literal ({…}), a $$$.<coll>.find(pred) scalar, or a spread of $$$.<coll>[.filter(pred)]. Got a number/string/null literal — collections only hold documents.` |
| `$$.push(...$$$.coll.filter(o => o.x === $.y))` (correlated) | `$$.push(...$$$.<coll>.filter(pred)) — predicate references the local document ($.<field>), but MongoDB's $unionWith has no let slot. The union sub-pipeline can only reference foreign-document fields. Move the local-doc filter to a $match(...) stage before $$.push(...).` |
| `$$.push(...)` inside a lookup block-body | `'$$.push(...)' inside a lookup's block-body lambda is not supported — $$.push appends documents to the outer collection's stream via '$unionWith', but the stages would land inside '$lookup.pipeline'. Hoist the push to a sibling stage in the outer pipeline.` |
| `$$.push(...)` inside a `$facet.*` / `$lookup.pipeline` / `$unionWith.pipeline` sub-pipeline | `'$$.push(...)' inside a sub-pipeline (…) is not supported — $$.push emits '$unionWith' stages against the current (outer) collection. Hoist the push to a sibling stage in the outer pipeline.` |
| `jsmql.filter("$$.push(...)")` / `jsmql.expr(...)` | `<apiName>() does not allow '$$.push(...)' — collection unions are Pipeline-only. Use jsmql() (in Pipeline mode) or jsmql.pipeline() to compose '$unionWith' stages.` |
| `jsmql.update("$$.push(...)")` | `jsmql.update() does not allow '$$.push(...)' (collection union): MongoDB's aggregation-pipeline update form only accepts $addFields, $project, $replaceRoot, $replaceWith, $set, $unset. Run the union in a regular aggregation pipeline (jsmql.pipeline()) — '$unionWith' isn't allowed inside an update.` |

## Server-version note

The `coll`-less `$unionWith` shape that wraps a `$documents` stage requires
**MongoDB 6.0+**. Inline-doc pushes lower to that shape. Spread-of-collection
pushes work on every version that supports `$unionWith` (4.4+).

## Deferred

- **Custom let-substitution.** Atlas's `$lookup.let` doesn't apply to
  `$unionWith`, but a future jsmql release could synthesise the same effect
  via a `$set` stage *before* the push and a `$match` against that captured
  value inside the sub-pipeline. Out of scope for v1 — the explicit "no
  correlation" error is the documented contract.
- **Negative tests against community server.** A live-server smoke test for
  the cross-DB `from: { db, coll }` rejection is filed in
  [`docs/specs/lookup-stage.md`](./lookup-stage.md) and applies here too.
- **Auto-`$documents`-only `$unionWith` server-version guard.** No compile-time
  check that the deployment is 6.0+ — the runtime error is precise enough.
