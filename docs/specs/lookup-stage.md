# `$$$.<coll>` `.find / .filter` → `$lookup` (cross-database `$$$$.<db>.<coll>` reads are rejected)

## What this covers

The implementation-facing companion to the user-facing reference in [LANGUAGE.md → Cross-collection lookups](../LANGUAGE.md#cross-collection-lookups-coll-find--filter). Covers detection of the `$$$.<coll>` same-database shape (a `$$$$.<db>.<coll>` cross-database **read** is detected only to be **rejected** — see § Cross-database reads are rejected), predicate translation (basic vs pipeline form, auto-`let` extraction), the chained-terminal materialisation (`.length`, `.reduce`, member access), the slot-allocation contract for internal `__jsmql.tmp.<N>` slots, the mode-gate behaviour, the cross-database rejection at the `requireSameDbColl` choke point, and the error catalog.

## Why `$$$` (and not `this.`)

The first attempt at this surface used `this.<coll>.find(pred)` ([reverted commit `1dc2c7b`](../DEVLOG.md)). It read well, but `this` is a JavaScript reserved word that's *parse-rejected* outside class/method bodies, which violates the strict-JS-subset rule in the root [`CLAUDE.md`](../../CLAUDE.md): `({ $ }) => this.users.find(...)` would refuse to round-trip through a `.js` file. The reverted spec moved to plain `this.` but the new direction uses the reserved context-reference prefixes (`$$`/`$$$`/`$$$$`) instead — they parse anywhere, never collide with the JS host language, and provide a single uniform vocabulary for the four document-context scopes (`$.`, `$$`, `$$$`, `$$$$`). See [`context-references.md`](./context-references.md) for the prefix grammar and AST nodes.

## Grammar

No new lexer or parser tokens. The receiver chain is one of:

| Source                       | AST shape (outermost first)                                                                        |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| `$$$.<coll>`                 | `MemberAccess { object: DatabaseRef, member: <coll> }`                                              |
| `$$$["<coll>"]`              | `IndexAccess { object: DatabaseRef, index: StringLiteral }`                                         |
| `$$$$.<db>.<coll>`           | `MemberAccess { object: MemberAccess { object: ClusterRef, member: <db> }, member: <coll> }`        |
| `$$$$["db"]["coll"]`         | `IndexAccess { object: IndexAccess { object: ClusterRef, index: StringLiteral }, index: StringLiteral }` |
| `$$$$.db["coll"]` / `$$$$["db"].coll` | mixed `MemberAccess` / `IndexAccess` over `ClusterRef`                                    |

All shapes are built by the standard primary-postfix loop ([`src/parser.ts:1164`](../../src/parser.ts:1164)). The method call `.find(pred)` / `.filter(pred)` parses as the existing `MethodCall` node.

The one parser extension: **sub-pipeline block-body lambdas**. In `parsePostfix`, when the method being consumed is in `STREAM_BLOCK_METHODS` (`find` / `filter` / `map`) *and* the receiver chain walks back to a stream source — a `DatabaseRef`, `ClusterRef`, or `CollectionRef` leaf, reached through any number of `MemberAccess` / `IndexAccess` / `MethodCall` hops (checked via the file-local `isStreamRooted` helper) — the `blockKind` is `"pipeline"`. That kind threads through `parseMethodCallArgs` → `parseCallArg` → `parseArgOrLambda` → `parseLambdaUnparen` / `parseLambdaParen`; when the lambda's body begins with `{`, those parsers dispatch to `parseCallbackBlock()` (shared with array-method callbacks) that reuses the same `;`-separated statement collector as the top-level block-body arrow form, plus an optional trailing `return <expr>`. The statements are normalised to a `Pipeline` AST node assigned to the lambda's `block` field, and the optional return to `ret`; the regular `body` field remains undefined. Walking through `MethodCall` is what lets a chained `.map` block parse (`$$$.orders.filter(p).map(o => { … })`).

Outside these stream-rooted positions — notably an in-document array method (`$.items.map(d => { … })`, rooted at a `FieldRef`) — `=> {` retains its expression-block meaning (`{ const a = …; return <expr>; }` → nested `$let`; an object return needs `=> ({ … })`). No general extension of sub-pipeline block-body lambdas.

## AST extension

`src/ast.ts` — the `Lambda` variant gains an optional sibling field:

```ts
| { type: "Lambda"; params: string[]; body?: Expr; block?: Pipeline; pos: number }
```

Exactly one of `body` / `block` is set. All existing consumers (array methods, IIFE, Object.groupBy, ArrayFrom, `$let`, `collectReadsInto`) check for block-form and either throw an actionable error (the lookup-callback position is the only one that accepts block bodies) or skip gracefully. The codegen helper `requireLambda` returns a type-narrowed `{ body: Expr }` shape after the block-form rejection so call sites stay unchanged.

## Module layout

`src/lookup-translation.ts` owns three responsibilities:

1. **Detection.** `detectLookupCall(expr)` recognises a well-formed `$$$.<coll>.<find|filter>(<Lambda>)` *or* `$$$$.<db>.<coll>.<find|filter>(<Lambda>)` shape, returning a `LookupCall` whose optional `db` field is set in the cross-database case. The receiver-walk helper `extractLookupTarget` handles all six bracket combinations across the two shapes by recursing through up to two `StaticAccess` steps (one dot or string-bracket access each). `containsLookupCall(node)` is the cheap deep walk used by mode-gates and the nested-lookup guard. `validateLookupShape(expr)` surfaces the precise error for *malformed* lookups (wrong method, wrong arity, non-arrow predicate, multi-param lambda); its `classifyLookupReceiver` walker accepts either `DatabaseRef`- or `ClusterRef`-rooted chains and threads the right spelling into the error message (`'$$$.<coll>'` vs `'$$$$.<db>.<coll>'`).

2. **Predicate translation.** `translatePredicate(call, ctx, lowerBlock)` picks between the basic form (`{ from, localField, foreignField, as }`) and the correlated-pipeline form (`{ from, let, pipeline, as }`). The basic-form fast path is taken when the lambda body is exactly one `===` between a foreign-rooted path (`o.x.y`) and a `$.` local-rooted path. Anything richer — including `==` (which jsmql restricts to `null` comparisons project-wide; see LANGUAGE.md's `===` vs `==` table) — falls through to the pipeline form, where the sub-pipeline codegen then surfaces the standard "use `===`" rejection if the user wrote `==` between two field paths. Block-body lambdas always use the pipeline form, with the rewritten block as the `pipeline:` body. The **expression-body** pipeline form routes the let-extracted predicate through `translateMatchBody` + `matchStagesFromTranslation` — the same index-friendly emitter the sibling translators use (see below) — so a constant comparison (`o.status === "x"`) becomes an indexable `{ status: "x" }` query field and only the parts with no query form (a correlated `$$letVar` comparison, a computed expression) fall back to `$expr`. (Previously this path wrapped the *whole* predicate in `$expr`; block-body lambdas already got the index-friendly form because each `$match(...)` statement runs through the same translator via `lowerBlock`.)

3. **Materialisation.** `lowerLookup(call, as, ctx, lowerBlock)` emits one or two stages (one for `.filter`, two for `.find` — the extra is `$set { <as>: { $first: "$<as>" } }`). `extractLookupCalls(expr, ctx, allocSlot, lowerBlock)` is the top-down expression walker that finds chained-on-lookup patterns and materialises them into internal slots, returning the prologue stages alongside a rewritten expression that uses `FieldRef`s into the materialised slots.

The `SubPipelineLowerer` callback is wired by `src/pipeline.ts` (which provides `generateImplicitPipeline` as the lowerer) so this module stays free of the circular `pipeline.ts` import.

**Block-body `.filter` 3rd 'collection' param.** A block-body `.filter` accepts up to 3 params — `(element, index, collection)`. `validateLookupShape` relaxes the single-param rule only for this case (expression-body predicates and `.find` keep it: the filtered sub-stream doesn't exist while the predicate is being evaluated). `buildBlockBodyPredicate` binds the 3rd param as a sub-stream length handle (`GenerateCtx.substreamLengthHandles`) so `<coll>.length` inside the block resolves to the materialised `$setWindowFields` count; it also rejects a *used* index param and any non-`.length` use of the handle. The materialiser stamping happens in `generateImplicitPipeline` (the count field is dropped by the inner trailing `$unset`). Full mechanism: [stream-length.md](stream-length.md) § Sub-stream length.

**Shared predicate lowering (`lowerLambdaPredicate`).** Four sibling translators lower a single-parameter predicate lambda the same way — `$unionWith` (`union-translation.ts`), `$facet` (`facet-translation.ts`), `$out` (`out-translation.ts`), and the `$$ = $$.filter(…)` replace-stream filter (`pipeline.ts`). Each rewrites foreign-doc paths via `extractLetsFromExpr` / `extractLetsFromPipeline`, rejects predicates that reference the *local* doc (none of these stages has a `let` slot), routes an expression body through `translateMatchBody` and a block body through the caller's `lowerBlock`, and emits the `$match` stages. That shared skeleton lives here as the exported `lowerLambdaPredicate(lambda, outerCtx, lowerBlock, { freshCtx, onLocalRef, missingBody })`; the per-stage variation is only the local-ref rejection message (`onLocalRef`) and the fresh sub-pipeline ctx (`freshCtx`, identity for the replace-stream filter, which already runs in the right ctx). The `$match`-emission half — vacuous→no stage, query-only, `$expr`-only, merged — is the separately exported `matchStagesFromTranslation(t, subCtx)`, so the index-friendly/`$expr`-residual shape can't drift between translators.

## Auto-`let` extraction

The walker `transformExpr` in `src/lookup-translation.ts` runs over the lambda body (expression-form) or over each statement of the block (block-form). At every visited AST node, `classifyPath` reports whether the sub-tree is a `MemberAccess`/`IndexAccess` chain rooted at:

- a `FieldRef` (`$.userId`, `$.user.profile`) → **local**, segments captured.
- the foreign-doc lambda param (`o`, `o.userId`, `o.user.profile`) → **foreign**, segments captured.
- anything else → unclassified; the walker recurses into children.

For local-rooted sub-trees, the let allocator interns the dotted path under a correlation-var name from the `jsmql_<kind><depth>_<name>` scheme (single source of truth: `letFieldVar` / `letBindingVar` / `letSysVar` in [`src/namespace.ts`](../../src/namespace.ts); `_2`, `_3`, … appended on same-level same-name collision). The `kind` is `f` for a document field (`allocateForLocalPath`), `v` for a `let`/`const` binding (`allocateForOuterLet`), or `s` for a system value like a stream length; `<depth>` is the **scope nesting level** the value comes from (0 = root pipeline, 1 = one lookup in, …), e.g. `$._id` → `jsmql_f0__id`, `o.userId` (depth 1) → `jsmql_f1_userId`, the root `$$.length` → `jsmql_s0_length`. The connector after the depth is always a single `_`, so a field that itself starts with `_` reads as `jsmql_f0__id` (doubled). The names start with a letter — **not** `_` — because MongoDB rejects a `$$` variable whose name begins with `_`/`$`/uppercase (verified; that's why the `__jsmql` document-field prefix can't be reused here). The depth is load-bearing: MQL `$$` variables are lexically scoped *through* nested `$lookup.pipeline` boundaries, so without it two lookups in the same chain that capture a value of the same name would allocate the same var and the deeper `let` would shadow the shallower one (the cross-level collision — see § Nested lookups). The sub-tree is replaced with a `ParamRef` whose name is the allocated correlation var — the existing codegen lowers `ParamRef` to `"$$<name>"` ([`src/codegen.ts`](../../src/codegen.ts)), which is exactly the `$$<var>` reference the sub-pipeline needs.

For foreign-rooted sub-trees, the sub-tree is replaced with a bare `FieldRef` whose path is the segment chain (e.g. `o.user.profile` → `FieldRef("user.profile")`). Inside the sub-pipeline, the foreign doc is `$$ROOT`, so a bare `"$user.profile"` resolves correctly.

A bare reference to the foreign param itself (`o` alone, no member access) is **rejected** with a targeted "use `o.<field>`" error — no `$$ROOT` lowering yet.

The MongoDB-native `$lookup.let` is wholly distinct from jsmql's pipeline-scoped `let` (`__jsmql.var.x`): lookup-pipeline lets live only inside one `$lookup.pipeline` and are read as `$$letVar`, while pipeline-scoped lets are materialised as document fields under `__jsmql.var.<name>` and read as `"$__jsmql.var.x"`. See [`let-bindings.md`](./let-bindings.md).

## Chained-terminal materialisation

`extractLookupCalls` recognises three chained patterns explicitly:

| Pattern                                    | Emitted stages (slot = `__jsmql.tmp.<N>`)                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `<lookup>.length`                          | `$lookup as: slot`, then `$set { slot: $size("$slot") }`                                                |
| `<lookup>.reduce(fn, init)`                | `$lookup as: slot`, then `$set { slot: <reduce expression over slot> }` (rejected on `.find` receiver) |
| `<lookup>` (direct, no chain)              | `$lookup as: slot` (plus `$set $first` for `.find`)                                                     |

In each case, the returned `rewritten` expression is a `FieldRef` pointing at the slot, so the surrounding stage's codegen runs over the materialised result. Member access (`<lookup>.find(p).name`) and arithmetic operations fall into the generic "direct lookup" branch — the slot ends up holding either a scalar or an array (per the `.find` / `.filter` distinction), and the existing `MemberAccess` / arithmetic codegen handles it.

Patterns not specifically recognised (`<lookup>.map(fn)`, `<lookup>.at(idx)`, second `.filter`) still work — they go through the direct-lookup branch and the existing array-method codegen runs over the materialised slot. The output is slightly more verbose (one extra stage) than a dedicated optimisation, but correct.

A chained terminal that doesn't carry its own predicate (`<lookup>.length`, `.reduce`, `.map`) **requires** a `.find/.filter(pred)` first — bare `$$$.coll.reduce(...)` cannot be reached because `$$$.coll` alone is not a `MethodCall` and `detectLookupCall` won't match. The bare-reference codegen error then fires with the actionable "must be followed by `.find/.filter`" message.

### Terminal-`.map` peel (`tryExtractChainedLookup`)

For a `$$$.<coll>.filter(pred).<stream-chain>` chain, `tryExtractChainedLookup` builds the `$lookup` (pipeline-form) and pushes each subsequent registered stream method into the sub-pipeline. **Exception: a value-extracting terminal `.map`** — the *last* method when it's `.map("field")` or `.map(x => <expr>)` (an expression-body arrow) — is **peeled off** the sub-pipeline (`peelableTerminalMap`) and returned as `<slot>.map(iteratee)` in `rewritten`, so codegen lowers it to a value-mode `$map` over the lookup result array in the surrounding `$set`/binding. Rationale: `.map`'s in-pipeline lowering is a `$replaceWith`, and `$replaceWith: "$scalar"` is **invalid MQL** (mongod: "'replacement document' must evaluate to an object" — verified) whenever the mapped field is a scalar (the `.map("userId")` extraction case). A **block-body** terminal `.map(x => { … ; return <ret> })` is *not* peeled (it stays in the sub-pipeline via `lowerCallbackBlock`'s `terminalRet` → `$replaceWith`, § "block-body `.map`"). The peel is uniform across the field-assignment and `const`/`let`-binding forms because both consume the same returned `rewritten`.

## Pipeline integration

`src/pipeline.ts` wires lookup-translation into the two top-level lowering entry points:

- **`generateImplicitPipeline`** (the `;`-separated form). For each statement:
  - `LetDecl` with a direct lookup value → use `__jsmql.var.<name>` as the `$lookup.as` slot directly; one `$lookup` stage (+ optional `$set $first`) replaces the usual `$set { __jsmql.var.<name>: <value> }`.
  - `UpdateFilter` → run through `lowerUpdateFilterWithLookups`, which iterates the comma-chained ops, splitting the coalesced `$set` buffer at any op whose RHS is a direct lookup (LHS path used as the `as:` slot) or contains chained lookups (extracted into internal slots first).
  - Stage call (`$match(...)`, `$project({...})`, …) → `extractFromStageElement` walks the stage body's expressions and lifts any lookup subtrees into prologue stages emitted *before* the stage itself.

- **`generatePipeline`** (the bracketed-array `[...]` form). Same integration, with the additional invariant that adjacent same-kind update ops still coalesce through `generateUpdateOpGroups` — a lookup-bearing op flushes the buffer first, emits the lookup stages, and resumes buffering.

- **`generatePipelineWithCtx`** (sub-pipelines inside `$lookup.pipeline`, `$unionWith.pipeline`, `$facet.*`). Nested lookups — in either an expression-body or a block-body predicate — flow through the regular `extractLookupCalls` path and materialise as prologue `$lookup` stages within the surrounding pipeline (the block-body path carries its `EnclosingLookupContext` via `GenerateCtx.enclosingLookup`; see § Block-body nested lookups).

The slot allocator (`makeSlotTracking`) returns `{ alloc, used }` so the trailing `$unset "__jsmql"` cleanup fires whenever either a `let` was declared **or** at least one internal lookup slot was used — keeping the trailing cleanup symmetric with the existing `let`-only path.

## Cross-database reads are rejected

A cluster-rooted **read** — `$$$$.<db>.<coll>.find/filter(...)` (a cross-database `$lookup`), and by extension the cross-database `$unionWith` (`$$.push(...$$$$.<db>.<coll>...)`), the replace-root (`$ = $$$$.<db>.<coll>.find(...)`), and the source-switch (`$$ = $$$$.<db>.<coll>.filter(...)`) forms — is **rejected at compile time**.

A cross-database read can only compile to `$lookup` (or `$unionWith`) with `from: { db: "<db>", coll: "<coll>" }` — a `{ db, coll }` *namespace object*. That object form is the [Atlas Data Federation form](https://www.mongodb.com/docs/atlas/data-federation/query/sql/aggregation-pipeline-stages/); every **regular** MongoDB deployment (standalone, replica set, sharded cluster) server-validates `$lookup.from` / `$unionWith` to a bare collection-name *string* and rejects the object at runtime. Per HR3 (never knowingly emit invalid MQL), jsmql rejects these reads at compile time rather than emit a shape that won't run on a non-federated server.

**The choke point: `requireSameDbColl`.** `requireSameDbColl(db, collection, pos)` ([`src/lookup-translation.ts`](../../src/lookup-translation.ts)) is the single gate every lowering path funnels through to resolve the `from` slot. When `db` is set (a `$$$$.<db>.<coll>` source) it throws a `CodegenError` (message matches `/Cross-database reads aren't supported/`) that names the same-database fix — `'$$$.<coll>'` (drop the `$$$$.<db>.` prefix) — and notes that cross-database *writes* (`$$$$.<db>.<coll> = $$` → `$out`) still work. When `db` is undefined it returns the bare collection-name string. Both `lowerLookup` and the union-direct path call it, so `$lookup`, `$unionWith`, replace-root, and source-switch all reject cross-db reads uniformly. The user-facing wording lives in [LANGUAGE.md → Cross-database reads](../LANGUAGE.md#cross-database-reads-not-supported).

**Same-database (`$$$.<coll>`) is unchanged:** `lowerLookup` emits `from: "<coll>"` (bare string) — the only shape a standard MongoDB server accepts — and everything below (predicate translation, auto-`let` extraction, chained terminals, nested-lookup handling, mode gates) applies to it as before.

**A bare `$$$$.<db>.<coll>`** (no `.find/.filter`, no `= …`) hits the codegen `ClusterRef` case, whose message says the form is *only usable as a cross-database `$out` destination* and that cross-database READS aren't supported (redirecting to same-db `$$$.<coll>`). The old "valid cross-database `$lookup`" framing is gone.

**Detection still recognises the cross-db shape** — only to reject it:
- `LookupCall.db` carries the database name when extracted from `$$$$.<db>.<coll>`; undefined for `$$$.<coll>`. A set `db` is what makes `requireSameDbColl` throw.
- `extractLookupTarget` walks one or two `StaticAccess` steps. The outer step yields the collection name; the inner (if present) yields the db name. The leaf must be a `DatabaseRef` (one step) or `ClusterRef` (two steps); deeper chains return null and the bare-reference codegen path then surfaces the targeted error.
- `validateLookupShape`'s `classifyLookupReceiver` returns `'$$$.<coll>'` for DatabaseRef-rooted chains and `'$$$$.<db>.<coll>'` for ClusterRef-rooted chains, so the *shape* errors (wrong method, wrong arity) still name the right spelling before the cross-db rejection fires.
- The parser's `isStreamRooted` (used to enable sub-pipeline block-body lambdas for `find` / `filter` / `map`) accepts a `DatabaseRef`, `ClusterRef`, or `CollectionRef` leaf, walking through `MemberAccess` / `IndexAccess` / `MethodCall` hops. The cluster-rooted chain still *parses*; it's the lowering that rejects.

The cross-database **write** (`$$$$.<db>.<coll> = $$` → `{ $out: { db, coll } }`) is unaffected — `$out` does accept the namespace object and MongoDB runs it. See [out-stage.md](./out-stage.md).

**Compile-time names — three accepted index kinds.** `staticAccess(node, ctx)` resolves one step of a lookup-receiver chain to a compile-time string name. It accepts:

1. **`MemberAccess`** (`$$$.coll` / `$$$$.db.coll`) — the dotted member name.
2. **`IndexAccess` with a `StringLiteral` index** (`$$$["coll"]` / `$$$$["db"]["coll"]`) — the literal value.
3. **`IndexAccess` with a `ParamRef` index whose name resolves in `ctx.bindings` to a string** (`jsmql.compile(({ coll }, { $ }) => $$$[coll].find(...))`) — the bound value. The `jsmql.compile` parameter-binding machinery has already validated the value as a JSON-safe compile-time constant, so reading it here matches the rule MongoDB itself enforces on `$lookup.from` (a plan-time string).

The third kind is the new compile-time-binding case. Non-string bindings (a number, an array, …) throw a precise "parameter binding must be a string" error at the `IndexAccess.index` position; unbound names return null (the codegen path then surfaces `UnknownIdentifierError`); runtime field-refs (`$.tenantDb`) fail to classify entirely and reach the bare-reference codegen error.

The `ctx` threads through `detectLookupCall` → `extractLookupTarget` → `staticAccess`. Three call-site categories pass it:

- **Lowering paths** (`pipeline.ts:lowerUpdateFilterWithLookups`, `generatePipeline`, `generateImplicitPipeline`, and `extractLookupCalls`) — pass the local `ctx` so bindings resolve.
- **Detection helpers without a meaningful ctx** (`walkContainsLookup` called from mode-gates; `findFirstLookupPos`; `findFirstLookupInExpr`) — `containsLookupCall` accepts an optional `ctx` parameter (default `EMPTY_CTX`) so mode-gates that lack one still work, and callers with one (`lowerWithCtx`, `rejectNestedLookup`) pass it explicitly so bound-bracket lookups detect correctly.
- **`UpdateFilter` reroute in `lowerWithCtx`** — a single-stmt arrow body like `jsmql.compile(({ coll }, { $ }) => ($.x = $$$[coll].find(...)))` parses as an `UpdateFilter`, not a `Pipeline`. Bare `generateUpdateFilter` doesn't know about lookups, so `lowerWithCtx` checks `containsLookupCall(ast, ctx)` and reroutes the lookup-bearing `UpdateFilter` through a synthetic single-stmt Pipeline → `generateImplicitPipeline` → the lookup-aware pipeline integration.

## Mode gates

`src/index.ts` adds pre-codegen `containsLookupCall` gates so the user sees the right error before the generic bare-reference fallback fires:

| Entry point        | Gate                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| `jsmql.filter()`   | reject if lookup present — "joins are Pipeline-only"                                                          |
| `jsmql.update()`   | reject before whitelist — "MongoDB's update form whitelists only `$addFields/$set/$project/$unset/$replaceRoot/$replaceWith`" (matches the documented [aggregation-pipeline update](https://www.mongodb.com/docs/manual/reference/method/db.collection.updateOne/#update-with-aggregation-pipeline) list) |
| `jsmql.expr()`     | reject — lookups produce stages, not expressions                                                              |
| `jsmql()` bare expr| reject — "requires Pipeline mode; add a `;` or assignment to flip"                                            |

The existing `UPDATE_PIPELINE_STAGES` whitelist at [`src/index.ts:761`](../../src/index.ts:761) stays as-is — it correctly mirrors MongoDB's documented restrictions and the pre-gate just makes the message more actionable.

## Error catalog

All errors use `CodegenError` with a meaningful `.pos`, so `validate()` returns a usable offset for tooling.

| Trigger                                                | Message (paraphrased)                                                                                          | Where                              |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Bare `$$$.<coll>` (no `.find/.filter`)                  | `'$$$.<coll>' must be followed by .find(pred) or .filter(pred) and consumed as a value …`                       | codegen `DatabaseRef` case         |
| Bare `$$$$.<db>.<coll>` (no `.find/.filter`, no `= …`)  | `'$$$$.<db>.<coll>' is only usable as a cross-database $out destination ('$$$$.<db>.<coll> = $$'). Cross-database READS aren't supported … use a same-database reference '$$$.<coll>' instead …` | codegen `ClusterRef` case          |
| Cross-database read `$$$$.<db>.<coll>.find/filter(...)` (and the `$unionWith` / replace-root / source-switch variants) | `Cross-database reads aren't supported: '$$$$.<db>.<coll>' would emit a $lookup/$unionWith with a '{ db, coll }' namespace, which a standalone / replica-set / sharded MongoDB rejects … write '$$$.<coll>' (drop the '$$$$.<db>.' prefix) … (Cross-database WRITES still work: '$$$$.<db>.<coll> = $$' lowers to $out.)` | `requireSameDbColl`                |
| `$$$.<coll>.<other-method>(...)` (e.g. `.fnid(...)`)    | `'$$$.<coll>' supports .find(pred) and .filter(pred), not .<m>(). Did you mean '.find'?`                        | `validateLookupShape`              |
| `$$$$.<db>.<coll>.<other-method>(...)`                  | `'$$$$.<db>.<coll>' supports .find(pred) and .filter(pred), not .<m>(). Did you mean '.find'?`                  | `validateLookupShape`              |
| `$$$.<coll>.find()` (no args)                           | `.find(predicate) takes exactly one argument …`                                                                | `validateLookupShape`              |
| `$$$.<coll>.find(<non-arrow>)`                          | `.find(predicate) requires an arrow predicate …`                                                               | `validateLookupShape`              |
| Multi-param lambda                                      | `.find(predicate) takes a single-parameter arrow (the foreign document), got N`                               | `validateLookupShape`              |
| Bare foreign-param ref (`o` alone)                      | `Bare lambda parameter 'o' in a $lookup predicate is not yet supported — use \`o.<field>\``                    | `transformExpr` foreign branch     |
| `.reduce()` chained on `.find()` (scalar-or-null)       | `.reduce() on a .find() result is not meaningful — .find returns a scalar-or-null …`                          | `extractLookupCalls` reduce branch |
| `.length` chained on `.find()` (scalar-or-null)         | `.length on a .find() result is not meaningful — .find returns scalar-or-null …`                              | `extractLookupCalls` length branch |
| Non-string `jsmql.compile` binding in `[<param>]` slot  | `'$$$[<param>]' / '$$$$[<param>]' parameter binding must be a string (got <typeof>); collection / database names are compile-time constants in MongoDB's $lookup.from.` | `staticAccess` ParamRef branch     |
| Filter mode / `jsmql.filter()` / `jsmql.expr()` lookup  | `<api>() does not allow lookup syntax ('$$$.<coll>.find/filter(...)') — joins are Pipeline-only …`             | `rejectLookupOutsidePipeline`      |
| `jsmql.update()` lookup                                 | `jsmql.update() does not allow lookup syntax …: MongoDB's aggregation-pipeline update form only accepts …`     | `lowerUpdateStrict`                |
| Bare expression with lookup (no `;`, no stage call)     | `Lookup syntax ('$$$.<coll>.find/filter(...)') requires Pipeline mode. …`                                      | `lowerWithCtx`                     |

## Nested lookups (expression body and block body, any depth)

Nested lookups inside another lookup's **expression-body** predicate (`.find/.filter(o => ... $$$.<coll2>.find/filter(...) ...)`) work to any depth. The inner lookup materialises as a prologue `$lookup` (+ `$set $first` for `.find`) stage inside the outer's `$lookup.pipeline` body, with its result substituted into the surrounding predicate as a `FieldRef(<slot>)`.

**How let-coordination works:**

- Refs to the outer lambda's foreign param (`o.x` inside the inner's predicate) classify as `foreign` of the outer during the outer's let-extraction walk → get rewritten to bare `FieldRef("x")`. The inner's classifyPath later sees these as `local`-kind paths and auto-lets them into `inner.let = { x: "$x" }` (capturing from the outer's pipeline-local doc).
- Refs to the outermost doc (`$.x`) classify as `local` of the outer → extracted into `outer.let = { x: "$x" }`. The inner predicate sees them as `ParamRef("x")` after rewrite; lexical `$$<name>` scoping makes them accessible without re-letting in the inner. The inner's codegen ctx adds the outer's letVar names to `lambdaParams` so `$$x` resolves correctly.
- Refs to the inner's own foreign param (`t.x` for `t => …`) classify as `foreign` of the inner — rewritten to bare `FieldRef("x")` inside the inner's pipeline.

**Threaded state.** `EnclosingLookupContext` (`foreignParams`, `inScopeLetNames`, plus the block-body-only `parentAllocators` and `parentHandles`) flows through `lowerLookup` / `translatePredicate` / `buildPipelineFormPredicate` / `extractLookupCalls` / `tryExtractChainedLookup` / `descendAndExtract` so the recursion knows what's in scope from above. The expression-body path threads it as an explicit argument; the block-body path can't (block lowering runs through `generateImplicitPipeline`, which has no `enclosing` parameter), so it threads the same value through the **ctx carrier** `GenerateCtx.enclosingLookup` — set on the sub-pipeline ctx by `lowerCallbackBlock`, read back by the entry points when their explicit `enclosing` argument is omitted. `freshSubPipelineCtx` drops it, so each lookup re-seeds its own.

**Cross-level capture (block-body path), built on `$$`-variable propagation.** MQL `$$` vars defined in an outer `$lookup.let` are visible in every nested `$lookup.pipeline` (unless shadowed), so an ancestor value is captured **once** — at the shallowest level whose `let` evaluates against the document that holds it — and read at any deeper level by name. A reference to scope level *K* resolves to the level-(*K*+1) lookup's `let`:

- **Root read `$.x`** (level −1) → captured at the OUTERMOST lookup (depth 0) as `jsmql_f0_x: "$x"` (its `let` evaluates against the root doc), read deeper as `$$jsmql_f0_x`.
- **Enclosing foreign param `outer.x`** (level *K*) → captured at the level-(*K*+1) lookup as `jsmql_f<K+1>_x: "$x"`. For the immediate parent (*K* = depth − 1) that target is the current lookup, matching the historical behaviour.
- **Ancestor sub-stream count `outerColl.length`** (a 3rd `.map`/`.filter` handle defined at level *K*) → captured at the level-(*K*+1) lookup as `jsmql_s<K+1>_length: "$__jsmql.length"`; the count is materialised at level *K* by `$setWindowFields` (the enclosing block's length-materialiser fires when it detects the handle read in the nested body).
- **Outer-pipeline `let`** (a `const`/`let` declared before the lookup) referenced in a chain `.map` → captured as `jsmql_v0_<name>: "$__jsmql.var.<name>"` (the chain assemblers thread the outer `pipelineLets` onto the chain ctx so the let-extractor recognises it). This is the same `outerLet` capture the `.filter` head already did; threading it to the chain methods closed the gap where a chain `.map` couldn't see an outer `let`.

This is why every auto-`let` name carries its **declaring** depth (see § Auto-`let` extraction): distinct levels get distinct names, so MQL's lexical `$$` scoping never silently shadows the shallower binding (the historical `$$v_id` collision bug). The level-aware resolution lives in `transformExpr` + `LetAllocator` (`allocateRootField` / `allocateAncestorForeign` / `allocateAncestorHandle`, each targeting `parents[…]`); the allocator's `letVars()` is a **live reference**, so a deeper level's capture into an ancestor allocator is reflected when that ancestor finalises its `$lookup.let`. A correlation `ParamRef` may therefore be captured *after* the consuming level's `lambdaParams` was frozen — codegen emits any `jsmql_[fvs]<d>_…` name (`CORRELATION_VAR_RE`) as `$$<name>` regardless, since it is in scope by construction. Verified end-to-end against a live `mongod`: root + grandparent + parent-handle reads inside a 3-level `.map`/`.filter` nest all resolve correctly.

(Expression-body nested predicates keep the older `rewriteEnclosingForeignParams` pre-rewrite, which is exact for the immediate parent; a pure expression-body chain whose ref skips a level threads through the block-body path instead — write that level as a block-body lambda.)

### Block-body nested lookups

A nested lookup inside a *block-body* lambda works the same as the expression-body form, to any depth and in any of three positions:

- **As a statement** — `o => { $match(...); $.x = $$$.coll2.filter(...); }` — the inner lookup is emitted as its own `$lookup` stage inside the outer's `$lookup.pipeline`, with `as` taken from the assignment LHS field.
- **Inside a stage-body expression** — `o => { $match($$$.coll2.filter(...).length > 0); }` — materialises as a prologue `$lookup` + transform `$set` into an internal `__jsmql.tmp.<N>` slot, exactly like the expression-body path.
- **As a block-bodied inner lambda** — `o => { $.x = $$$.coll2.filter(c => { $match(...); $sort(...); }); }` — the inner's own multi-stage block lowers recursively.

`lowerCallbackBlock` is the shared engine — used by `buildBlockBodyPredicate` (the `.filter` head, called from `translatePredicate` / `buildPipelineFormPredicate`) **and** by a statement-block `.map` chain method (`stream-methods.ts`). The ONLY difference is `.map`'s `terminalRet`: its `return <expr>` is appended as the root-replace statement `$ = <expr>` (a synthetic `UpdateFilter` → `$replaceWith`); `.filter` passes none. It seeds a depth-aware `LetAllocator` (with the enclosing foreign params, the enclosing allocators, and the enclosing handles) so `transformExpr` performs the cross-level capture above directly — there is no separate enclosing-param pre-rewrite for the block path. It then grows `EnclosingLookupContext` (appending this level's allocator + any 3rd-param handle) and threads it through `lowerBlock` via `GenerateCtx.enclosingLookup`. A statement-block `.map` returns its captured `let` vars as `StreamMethodResult.extraLetVars`, which the chain assembler (`tryExtractChainedLookup` / the `$$ =` pivot) merges onto the lookup's `let`. Assignment/`delete` targets inside the block are routed through `transformTarget` (not `transformExpr`) so a write destination like `$.x` lowers to its `$set`/`$unset` field key instead of being hoisted into a `let`.

## Future work

- **Ambient TS types for `$$$`** so the function-form lookup (`({ $ }) => $$$.coll.find(...)`) type-checks under TypeScript. Design separately in [`ops-generation.md`](./ops-generation.md).
- **Optimised chained terminals.** `.map`, `.at`, second `.filter` currently fall through the generic path (one extra `$set` stage); they could emit specialised single-stage transforms.
