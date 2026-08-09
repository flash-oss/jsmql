# `$$$.<coll> = …` / `$$$$.<db>.<coll> = …` → `$out` stage

## Overview

`$out` writes the current aggregation pipeline's documents to a destination
collection — MongoDB's canonical "save the result" stage. jsmql exposes
this as an assignment-shaped sugar so the destination is visible at a
glance:

```
$$$.warehouse_orders = $$;
// → [{ $out: "warehouse_orders" }]

$$$$.dw.archive = $$.filter(u => !u.active);
// → [{ $match: <translated u => !u.active> }, { $out: { db: "dw", coll: "archive" } }]
```

The LHS names *where* documents are written using the existing context-ref
prefixes (`$$$` = same-database, `$$$$` = cross-database / cluster). The
RHS is a chain rooted at `$$` (the current pipeline): bare `$$` writes the
stream unchanged; chained methods — `.filter(<predicate>)`, any method in the
`STREAM_METHODS` registry, or a stage link (`$$.$sort({ … })`) — contribute one
pipeline stage each before the trailing `$out`.

Statement-only and last-stage-only: nothing may follow the `$out` sugar
in a pipeline. A `sawOut` flag in the lowerer trips on emission and
throws on any subsequent statement with a position-bearing error.

## Convention: why a distinct LHS prefix?

jsmql reserves `$ = <expr>` exclusively for *root-replacing* sugar —
`$replaceWith` and the `$facet` variant. The bare `$` LHS is the visual
signal that the document itself is being replaced. `$out` does **not**
replace root; it writes the (filtered) stream elsewhere. To keep the
asymmetry visible to readers, `$out` uses a different LHS prefix — the
destination is on the left, the source on the right. Cross-cuts:

- `$ = …` → `$replaceWith` / `$facet` (root replacement).
- `$$$.<coll> = …` / `$$$$.<db>.<coll> = …` → `$out` (write destination).
- `$$$.<coll>.find(…)` / `.filter(…)` → `$lookup` (read source).
- `$$.push(…)` → `$unionWith` (stream union).

See [`docs/specs/replace-root-stage.md`](replace-root-stage.md#convention-all-root-replacing-sugar-starts-with--) for the convention statement.

See [`docs/LANGUAGE.md#out-write-the-pipeline-to-a-collection`](../LANGUAGE.md#out-write-the-pipeline-to-a-collection) for the user-facing reference.

## Lowering table

| Input | Output stage(s) |
|---|---|
| `$$$.warehouse_orders = $$;` | `[{ $out: "warehouse_orders" }]` |
| `$$$["warehouse_orders"] = $$;` | `[{ $out: "warehouse_orders" }]` (bracket equivalent) |
| `$$$["my-coll.v2"] = $$;` | `[{ $out: "my-coll.v2" }]` (bracket is required for non-identifier names) |
| `$$$$.dw.archive = $$;` | `[{ $out: { db: "dw", coll: "archive" } }]` |
| `$$$$["dw"]["archive"] = $$;` | `[{ $out: { db: "dw", coll: "archive" } }]` |
| `$$$$.dw.archive = $$.filter(u => !u.active);` | `[{ $match: <translated body> }, { $out: { db: "dw", coll: "archive" } }]` |
| `$$$.top10 = $$.filter(o => { $sort({ score: -1 }); $limit(10); });` | `[{ $sort: { score: -1 } }, { $limit: 10 }, { $out: "top10" }]` (block-body sub-pipeline) |
| `$match(<pred>); $$$.coll = $$;` | `[{ $match: <pred> }, { $out: "coll" }]` (preceding stages compose normally) |

## Detection

`detectOutAssign(op)` (in `src/out-translation.ts`) recognises the LHS
shape on an `AssignExpr.target`:

```ts
// One step of static (dot or string-literal-bracket) member access.
// Each step's `name` is statically extracted; computed brackets are
// rejected outright (the destination must be statically known).
type AccessStep =
  | { ok: true; name: string; object: Expr }
  | { ok: false; indexPos: number };
```

The walk:

1. `findContextRefLeaf(target)` — walks through `MemberAccess` /
   `IndexAccess` nesting to a `DatabaseRef` / `ClusterRef` leaf. Returns
   `null` for any chain that isn't `$$$`/`$$$$`-rooted; the surrounding
   pipeline branch then falls through to the existing lookup / update-op
   paths.
2. Leaf is `DatabaseRef` → expect **exactly one** access step:
   `$$$.<coll>` or `$$$["<coll>"]`. Two or more segments throws the
   "too many segments for a same-database $out target" error pointing
   at `$$$$.<db>.<coll>`.
3. Leaf is `ClusterRef` → expect **exactly two** access steps:
   `$$$$.<db>.<coll>` (any bracket combination). One segment is "missing
   the collection"; three or more is "too many segments".
4. Any access step whose index is not a `StringLiteral` (a computed
   bracket) throws the "literal collection name" error with a hint
   pointing at `jsmql.compile` for parameterised destinations.

The detector is called from three sites in `src/pipeline.ts`, mirroring
the `isReplaceRootAssign` pattern:

- `generatePipeline` (the bracketed `[ … ]` form) — line ~228.
- `generateImplicitPipeline` (the `;`-separated form, via
  `lowerUpdateFilterWithLookups`).
- `lowerUpdateFilterWithLookups` (one `,`-chained `UpdateFilter`
  statement) — line ~830.

The interception fires **after** `isReplaceRootAssign` and **before**
`detectLookupCall` in each site: the LHS shape is unambiguous against
both alternatives (`$ = …` has an empty-path FieldRef target, `$out` has
a `DatabaseRef`/`ClusterRef`-rooted target with no method call;
`$$$.<coll>.find/filter(…)` has a method call on the same chain).

`containsOutAssign(node)` is the cheap mode-gate walk used by
`rejectOutOutsidePipeline` in `src/index.ts` to surface a precise
"Pipeline-mode only" error for `jsmql.filter()` / `jsmql.expr()` and
to reroute `jsmql.update()` / `jsmql()`'s bare-UpdateFilter path
through the pipeline lowerer.

## Validation

| Trigger | Message (excerpt) |
|---|---|
| `$$$.<a>.<b> = …` (three `$`, two LHS segments) | `'$$$.<a>.<b>' has too many segments for a same-database \$out target — use '$$$$.<db>.<coll>' (four $) for a cross-database write, or '$$$.<coll>' (three $) for the local database.` |
| `$$$$.<x> = …` (four `$`, one LHS segment) | `'$$$$.<x>' is missing the collection — write '$$$$.<db>.<coll>' (db, then collection), or use '$$$.<coll>' (three $) for the local database.` |
| `$$$$.<a>.<b>.<c> = …` (three or more segments after `$$$$`) | `'$$$$.<a>.<b>.<c>' has too many segments for a \$out target — '\$out' writes to one collection in one database, so '$$$$.<db>.<coll>' is the deepest form.` |
| `$$$[<non-literal>] = …` (computed bracket on the LHS) | `'\$out' target must be a literal collection name — use '$$$.<coll>' or '$$$["<coll>"]', not a runtime expression. If you need a parameterised target, use 'jsmql.compile' and pass the name in.` |
| RHS not rooted at `$$` (e.g. `$$$.coll = $.x`) | `The right-hand side of '$$$.<coll> = …' must start with '$$' (the current pipeline). Write '$$$.<coll> = $$' to write the current stream as-is, or '$$$.<coll> = $$.filter(<predicate>)' to pre-filter before writing.` |
| Chain method in neither the stream-method registry nor the stage-link form | `'$$.<method>(...)' isn't a recognised chain method for a '\$out' RHS.[ Did you mean '.<near-miss>()'?] <workaround>` — the workaround is the method's entry in `STAGE_EQUIVALENT_HINT` when it has one (a JS method a stream chain deliberately lacks, e.g. `.reduce` → `$group({ … })`), else the generic "add the equivalent stage call, chained or as its own statement". A method the registry *does* carry must never be listed in that table: the table is only reached when `lookupStreamMethod` returns null, so an entry for a working method is unreachable. |
| `$$.filter(<predicate>)` arity wrong | `'$$.filter(<predicate>)' takes exactly one predicate argument, got N.` |
| `$$.filter(<not-a-predicate>)` | `'$$.filter(<predicate>)' in a '\$out' write chain takes a single arrow predicate ('o => …'), a matches-object ('{ active: true }'), a field name ('"active"'), or a ["field", value] pair.` (shared gate — see [pipeline-validation.md](pipeline-validation.md)) |
| `$.x` reference inside the `$$.filter` predicate | Shared message from `localRefInPredicateMessage`: names the lambda's own parameter for an arrow spelling, and redirects a shorthand spelling to the arrow form (a shorthand has no parameter the user could write). |
| Statement appears after the `$out` sugar in the same pipeline | `'\$out' must be the last stage in a pipeline. Move this statement before the '$$$.<coll> = …' write (at position N), or remove it.` |
| Two `$$$.<coll> = …` statements in one pipeline | Same as above — caught by the shared `sawOut` guard. |
| `$$$.<coll> = …` inside `jsmql.filter(…)` / `jsmql.expr(…)` | `jsmql.<mode>() does not allow '\$out' sugar ('$$$.<coll> = …' / '$$$$.<db>.<coll> = …') — '\$out' is a pipeline stage. Use jsmql() (in Pipeline mode — add ';' or wrap in a stage array) or jsmql.pipeline() to compose '\$out' stages.` |
| `$$$.<coll> = …` inside `jsmql.update(…)` | Defers to the existing update-pipeline whitelist error: `jsmql.update() rejected '\$out': MongoDB's aggregation-pipeline update form only accepts $addFields, $project, $replaceRoot, $replaceWith, …` |

All errors carry a meaningful `.pos` (target node's `pos` for LHS shape
errors, RHS node's `pos` for chain errors, offending later statement's
`pos` for the trailing-stage guard).

## RHS chain methods

The chain dispatch in `lowerChainMethod` handles `.filter(<predicate>)`
inline (it reuses the index-friendly `$match` translator), and routes every
other method through the shared `STREAM_METHODS` registry from
[`src/stream-methods.ts`](../../src/stream-methods.ts): `.slice`, `.map`,
`.toSorted`, `.flatMap`, `.concat`. The chain walker in `lowerOutChain`
recurses into `MethodCall.object` first, then emits the current layer's
stage, so source order is preserved. Chained pipeline stages
(`$$.$sort({ … })`) compose too: a `$out` chain runs at the OUTER pipeline
level, so a stage link is an ordinary top-level stage placed before the write,
lowered by running its one-statement block through the same `SubPipelineLowerer`
the statement form uses. Placement is checked with `isLastInContainer: false`,
because the `$out` itself always follows — which is what rejects a second write
stage in the chain.

`.filter`'s and `.reject`'s **argument** first goes through `requireStreamPredicate`
— the shared local-`$$` predicate gate — so a `$out` chain accepts exactly the
predicate spellings the `$$ =` stream and a `$facet` branch do, and lowers each to
the same MQL. See [pipeline-validation.md](pipeline-validation.md) § the local-`$$`
predicate gate.

`.reject` is `.filter` negated (via the shared `negateStreamPredicate`), so the two
share one branch in `lowerChainMethod` and stay in lockstep here exactly as they do
in a `$$ =` chain: `$$$.live = $$.reject(p)` emits the same `$match: { $expr: { $not:
… } }` that `$$ = $$.reject(p)` does, then the trailing `$out`.

The normalised lambda then reuses the same predicate translator that `$match`, the
`$facet` variant of `$ = { … }`, and the union-form sub-pipelines all
use (`extractLetsFromExpr` / `extractLetsFromPipeline` from
[`src/lookup-translation.ts`](../src/lookup-translation.ts) +
`translateMatchBody` from
[`src/match-translation.ts`](../src/match-translation.ts)). Two body
shapes:

- **Expression body** (`d => d.active`): translatable conjuncts emit
  index-friendly `{ field: value }` query syntax; the untranslatable
  residual rides in a `$expr` alongside.
- **Block body** (`d => { $sort(…); $limit(…); }`): each statement
  becomes a stage in the prefix, lowered by the shared
  `SubPipelineLowerer` (the same one lookup/union/facet use). A fresh
  sub-pipeline ctx is used so outer let scopes don't cross the lambda
  boundary, matching the facet behaviour.

`$.<field>` references inside the predicate are rejected — the lambda's parameter
IS the current document, so allowing both spellings would invite drift. The message
comes from the shared `localRefInPredicateMessage`, which mirrors the facet-form and
`$$ =` rejections and (crucially) never names the gate's synthetic parameter back at
a user who wrote a shorthand.

### Adding more chain methods

A new chain method is **not** a `$out`-specific branch — it goes in the shared
`STREAM_METHODS` registry ([`src/stream-methods.ts`](../../src/stream-methods.ts),
which owns the vocabulary and its lowering), and `lowerChainMethod` picks it up with
no change here. That is what makes a `$out` chain accept the same methods a `$$ =`
chain does. `lowerChainMethod` keeps its own branch only for the three shapes the
registry does not cover: the stage-link form, and the `.filter` / `.reject` pair
(whose predicate goes through the shared gate — see above).

When a method lands in the registry, remove any entry it has in
`STAGE_EQUIVALENT_HINT`: that table is only consulted after `lookupStreamMethod`
returns null, so an entry for a working method is unreachable and would sit there
advertising a workaround for something that already works. The table is the single
source of truth for the "use this stage instead" hint, and holds only JS methods a
stream chain deliberately lacks.

## Mode gates

`$out` sugar is **Pipeline-mode only**:

| Entry point | Behaviour |
|---|---|
| `jsmql("…")` with `;` (Pipeline) | Allowed. |
| `jsmql.pipeline("…")` | Allowed — UpdateFilter-shaped input is rerouted via `containsOutAssign` so the lookup-aware pipeline integration intercepts the assignment. |
| `jsmql("…")` without `;` (UpdateFilter) | Rerouted to Pipeline lowering via `containsOutAssign` in `lowerWithCtx`. |
| `jsmql.filter("…")` | Rejected with a precise "use Pipeline mode" hint. |
| `jsmql.expr("…")` | Rejected with the same hint. |
| `jsmql.update("…")` | Rejected via the existing update-pipeline whitelist error (`$out` isn't in the list of stages MongoDB accepts inside `db.coll.updateOne(filter, update)`). |

## Parser interaction

Two small changes in [`src/parser.ts`](../src/parser.ts):

1. **`validateUpdateTarget`** now also accepts the `$out` LHS shape via a
   new `isOutTarget(target)` helper — chains of `MemberAccess` /
   `IndexAccess` rooted at `DatabaseRef` / `ClusterRef`. Shape-only check;
   segment-count and computed-bracket diagnostics live in codegen.
2. **`parseContextRef`** now allows bare `$$` (CollectionRef) at the
   parse level so `$$$.coll = $$` can have a bare RHS. The typo case
   `$$foo` (no separator, just an Ident next) is still rejected at parse
   time. `$$$` / `$$$$` keep the strict pre-check — bare uses of those
   have no meaning anywhere.

No new tokens, no new AST nodes.

## Module layout

```
src/
  out-translation.ts  New. detectOutAssign, validateOutShape (via the
                      thrown CodegenErrors inside detectOutAssign),
                      lowerOutChain, lowerOut, containsOutAssign.
                      Reuses extractLetsFromExpr / extractLetsFromPipeline
                      from lookup-translation and translateMatchBody from
                      match-translation.
  parser.ts           Updated. validateUpdateTarget accepts the $out LHS
                      shape via the new isOutTarget helper.
                      parseContextRef allows bare `$$`.
  pipeline.ts         Updated. detectOutAssign branch in generatePipeline
                      and lowerUpdateFilterWithLookups, mirroring the
                      isReplaceRootAssign / detectLookupCall pattern.
                      sawOut/outPos threaded through both top-level
                      pipeline loops + the UpdateFilter inner loop. New
                      makeAfterOutError helper for the trailing-stage
                      diagnostic.
  index.ts            Updated. rejectOutOutsidePipeline gates
                      jsmql.filter / jsmql.expr. containsOutAssign
                      reroute in lowerWithCtx and lowerToPipelineStages
                      so UpdateFilter-shaped input with $out sugar reaches
                      the pipeline lowerer.
  codegen.ts          Updated. Bare-DatabaseRef and bare-ClusterRef errors
                      now mention $out write as an alternative to $lookup
                      read.
  stages.ts           No change. `$out` was already registered.
```

## Deferred

- **`$merge` sugar.** MongoDB has both `$out` (full replace) and
  `$merge` (upsert / merge into existing docs). The corresponding sugar
  might look like `$$$.coll += $$;` (compound assign — "merge into") to
  preserve the destination-on-the-left mental model, but the four merge-
  control fields (`on`, `whenMatched`, `whenNotMatched`, `let`) need a
  more careful design pass. Out of scope for now.

## Landed

- **Multi-method RHS chains.** `lowerChainMethod` routes everything outside its own
  three shapes (stage link, `.filter`, `.reject`) through the shared
  `STREAM_METHODS` registry, so registry methods compose freely before the trailing
  `$out` — see [Adding more chain methods](#adding-more-chain-methods).
- **Bound destination via `jsmql.compile`.** `$$$[boundColl] = $$`
  resolves the bracket-index at compile time when `boundColl` is a string-typed
  parameter binding (via `ctx.bindings`). Non-string bindings surface a
  "parameter binding must be a string" error.
- **Pre-emit "is this a stage-clearing stage?" classification.**
  `$out` is terminal, so the in-pipeline let scope is irrelevant after
  emission. The `sawOut` guard ensures no subsequent statement runs;
  no separate scope-clearing is needed.
