# `$$ = <expr>` → `$match` / `$limit:0 + $unionWith` stage

## Overview

`$$ = <expr>` is the jsmql surface for replacing the pipeline's document
stream. The LHS is the bare `$$` token — the current collection / stream,
the same role MQL's `$$ROOT` plays for a single document. Sister shape to
`$ = <expr>` (which replaces *one* doc → `$replaceWith`); `$$ = <expr>`
replaces the *stream* and lowers to either a `$match` (narrow) or
`$limit:0` + `$unionWith` (switch source).

Statement-only: `$$ = <expr>` appears as a top-level pipeline statement —
either inside `[ ... ]` array-form or as a `;`-separated implicit-pipeline
statement (including inside a comma-separated update-filter chain). Using
it inside a Filter / `jsmql.expr` goes through the normal
pipeline-mode-required gate.

See [`docs/LANGUAGE.md#replace-stream`](../LANGUAGE.md#replace-stream)
for the user-facing reference.

A `$$.<chain>;` bare statement (no `$$ =` head) is statement sugar for
`$$ = $$.<chain>;` and lowers identically — see
[stream-methods.md § Bare-statement stream chains](./stream-methods.md#bare-statement-stream-chains).

## Lowering table

| Input | Output stage(s) |
|---|---|
| `$$ = $$.filter(t => t.x > 5)` | `[{ $match: { x: { $gt: 5 } } }]` |
| `$$ = $$.filter(t => true)` (vacuous) | `[{ $match: { $expr: true } }]` |
| `$$ = $$$.t.filter(t => t.x > 5)` | `[{ $limit: 0 }, { $unionWith: { coll: "t", pipeline: [{ $match: { x: { $gt: 5 } } }] } }]` |
| `$$ = $$$.t.filter(t => true)` (vacuous) | `[{ $limit: 0 }, { $unionWith: "t" }]` (short form) |
| `$$ = $$$$.db.coll.filter(p)` | Same as above but `from: { db, coll }` (Atlas Data Federation form) |
| `$$ = $$$.t.filter(t => { $match(t.x > 5); $sort({x:-1}); $limit(3); })` | `[{ $limit: 0 }, { $unionWith: { coll: "t", pipeline: [{ $match: {x:{$gt:5}} }, { $sort:{x:-1} }, { $limit:3 }] } }]` (block-body) |

The two RHS shapes both reuse `lowerStreamFilterPredicate` for predicate
translation; only the wrapping differs.

## Bare `$$` as an assignment target

`parseContextRef` in `src/parser.ts` was extended so the `CollectionRef`
variant (`$$`) accepts a following `=` token, in addition to `.` and `[`.
The other context prefixes (`$$$`, `$$$$`) keep the strict rule —
`$$$ = X` / `$$$$ = X` are meaningless and stay parse-rejected.

`isFieldPathTarget` in `src/parser.ts` was extended to accept
`CollectionRef` as an assignment target, alongside the existing `FieldRef`
and `MemberAccess` chains.

No new tokens or AST nodes. The shape is `AssignExpr { target: CollectionRef, value: <expr>, pos }`.

## Detection and lowering

`isReplaceStreamAssign(op)` (in `src/pipeline.ts`) recognises the shape:

```ts
op.target.type === "CollectionRef"
```

Different from `$ = …` (`FieldRef { path: "" }`) and from field-path
assignments (`FieldRef { path: <non-empty> }`, `MemberAccess` chains).

The interception fires before the update-op buffer in two places —
matching the two assignment-loop sites used by `isReplaceRootAssign`:

- `generatePipeline` (the `[ … ]` form)
- `lowerUpdateFilterWithLookups` (the `;` form and comma-chained `UpdateFilter` ops)

Stream-replace is checked *before* root-replace at each site — the two
never overlap (different target types), so order doesn't matter for
correctness; placing stream-replace first keeps the structure readable.

`lowerReplaceStream(el, ctx, lowerBlock)` returns `{ stages, clearLets }`.
Form B preserves the let scope; form A clears it via
`clearCtxLets(ctx, "$unionWith")`.

## Predicate translation

`lowerStreamFilterPredicate(lambda, predicateCtx, lowerBlock)` produces
the inner `$match` stage list. Same algorithm as the facet form
(`lowerFacetEntry`) and `$unionWith`'s union-predicate translator:

- **Lambda must take exactly one parameter.** Zero-arg (`() => …`) and
  multi-arg shapes are rejected — naming the doc lets the `$.<field>`
  rejection point at the right replacement.
- **Expression body** runs through `extractLetsFromExpr(body, param)`:
  - `param.x` rewrites to `FieldRef("x")` (lowers to `"$x"` per JS-faithful field-ref codegen).
  - Any path rooted at `$` produces a `letVars` entry; we reject those — the lambda param IS the document, so use the param.
  - The rewritten body runs through `translateMatchBody` (same engine `$match` uses), producing index-friendly query syntax for the translatable half and `$expr` for the residual.
- **Block body** runs through `extractLetsFromPipeline(block, param)` with the same path-rewriting / `$.<field>`-rejection rules, then `lowerBlock(rewritten, predicateCtx)` emits the block's stages verbatim.

### Why the caller picks the ctx

Form B's `$match` is a top-level stage in the outer pipeline — its predicate
must see the outer let scope so `$$ = $$.filter(t => t.x > cutoff)` after a
prior `let cutoff = …` resolves `cutoff` correctly. The caller passes
`outerCtx`.

Form A's `$match` lives inside `$unionWith.pipeline` — a sub-pipeline that
runs in a fresh let scope (per the existing "outer lets don't cross
sub-pipeline boundaries" rule; `$unionWith` has no `let:` slot to thread
them through). The caller passes `freshSubPipelineCtx(outerCtx)`.

That difference lives in `lowerReplaceStream`, not in
`lowerStreamFilterPredicate` — the predicate helper takes whatever ctx the
caller hands it.

## Rejections

`rejectInvalidReplaceStream(value, ctx)` catalogs the unsupported RHS
shapes; each error names the two supported forms and redirects where the
user's intent is recoverable:

| Trigger | Message excerpt |
|---|---|
| `ArrayLiteral` RHS (e.g. `$$ = []`) | `'$$ = []' (drop all documents) is not supported in this release. To empty the stream, use '$match($expr(false))' or a '$limit(0)' stage directly.` |
| `TernaryExpr` RHS (e.g. `$$ = a ? b : c`) | `'$$ = <ternary>' (conditional stream branching) is not yet supported [DEF-001]. The RHS of '$$ = …' must be '$$.filter(<predicate>)' (narrow the current stream) or '$$$.<coll>.filter(<predicate>)' (switch source to another collection). See docs/DEFERRED.md.` |
| `MethodCall` on `$$` / `$$$.<coll>` with method other than `filter` | `'$$ = …' RHS supports only '<recv>.filter(<predicate>)' — '.<method>(...)' is not allowed here.[ Did you mean '.filter'?] Use '<recv>.filter(<predicate>)' to <intent>, or write '$ = $$$.<coll>.find(<predicate>)' if you meant to replace each document with a single matching foreign doc.` |
| Bare `CollectionRef` / `DatabaseRef` RHS (e.g. `$$ = $$$.t`) | `'$$ = …' RHS must call '.filter(<predicate>)'. Write '$$.filter(o => …)' to narrow the current stream or '$$$.<coll>.filter(o => …)' to switch source.` |
| Anything else | `'$$ = …' RHS must be '$$.filter(<predicate>)' (narrow the current stream) or '$$$.<coll>.filter(<predicate>)' (switch source to another collection).` |

Compound assignment (`$$ += 5`, `$$++`) is rejected at parse time by the
`parseContextRef` sanity guard (the next token after `$$` would be `+=` /
`++`, neither of which is `.`, `[`, or `=`). The error message names the
expected followers; users get redirected immediately.

`$.<field>` references inside the predicate body are rejected by
`rejectLocalRefInStreamFilter` with the same "use the lambda parameter"
pattern the facet form uses.

## Interaction with `$set` / `$unset`

The update buffer flushes before `$$ = …`, so
`$.a = 1; $$ = $$.filter(t => t.x > 0); $.b = 2;` emits

```
[{ $set: { a: 1 } }, { $match: { x: { $gt: 0 } } }, { $set: { b: 2 } }]
```

— never one merged `$set` straddling the assignment.

For the source-switch form, subsequent `$.x = …` ops operate on the *new*
docs (from the foreign collection), not the pre-switch docs. Any prior
`let` becomes unreadable: `let cutoff = 10; $$ = $$$.t.filter(o => true); $.flagged = cutoff;`
produces `` `cutoff` is a `let` binding and can't be read after `$unionWith` … ``.

## Module layout

```
src/
  parser.ts        Updated. parseContextRef accepts '=' after $$ (CollectionRef
                   only). isFieldPathTarget accepts CollectionRef as a target.
                   No new tokens, no new AST nodes.
  pipeline.ts      Updated. Adds isReplaceStreamAssign, lowerReplaceStream,
                   lowerStreamFilterPredicate, rejectLocalRefInStreamFilter,
                   rejectInvalidReplaceStream. Wires the interception into
                   generatePipeline and lowerUpdateFilterWithLookups before the
                   existing isReplaceRootAssign branch.
  codegen.ts       Updated. The bare-`$$` CollectionRef rejection message now
                   mentions '$$ = <expr>' alongside '.push(...)' and the facet
                   pattern, for DX consistency with the new surface.
  union-translation.ts  `validateUnionPushShape` was later removed when the
                   bare-statement `$$.<chain>;` form shipped: a statement-position
                   '$$.filter(...)' now lowers to '$match' (sugar for
                   '$$ = $$.filter(p)') rather than emitting a suggestion.
  match-translation.ts  No change. translateMatchBody reused as-is.
  lookup-translation.ts No change. extractLookupTarget, extractLetsFromExpr,
                   extractLetsFromPipeline reused as-is (already exported).
```

## Deferred

- **`$$ = []`** would naturally lower to `{ $limit: 0 }`. Skipped for v1: the
  ergonomic win is tiny (`$limit(0)` is one token longer) and the parser path
  needs a small extension to thread an `ArrayLiteral` RHS through.
- **`$$ = cond ? A : B`** (stream-level ternary). The genuinely hard piece is
  passing the outer `let` scope into `$unionWith.pipeline` (no `let:` slot
  on `$unionWith` in current MongoDB). Without that, the common case
  (`let id = …; $$ = cond ? [] : $$$.<other>.filter(o => o.parent === id)`)
  can't lower cleanly. Deferred until either `$unionWith` gains a `let:` slot
  or jsmql grows a multi-pipeline output shape.
- **`$$.find(<predicate>)`** (self-lookup on the current collection). Already
  noted in [`src/lookup-translation.ts`](../../src/lookup-translation.ts) as
  blocked on collection-name binding — jsmql compiles statelessly. Worth
  revisiting after the lookup work has a slot for `jsmql.compile({ collection })`
  or similar.
- **Non-empty array literal on the RHS** (e.g. `$$ = [{ x: 1 }, { x: 2 }]`).
  Would map to `$documents` but only at the first stage. Skipped — niche
  enough that the existing `$documents` stage call is fine.
