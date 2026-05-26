# `$$$.<coll>` / `$$$$.<db>.<coll>` `.find / .filter` → `$lookup`

## What this covers

The implementation-facing companion to the user-facing reference in [LANGUAGE.md → Cross-collection lookups](../LANGUAGE.md#cross-collection-lookups-coll-find--filter). Covers detection (both `$$$.<coll>` same-database and `$$$$.<db>.<coll>` cross-database shapes), predicate translation (basic vs pipeline form, auto-`let` extraction), the chained-terminal materialisation (`.length`, `.reduce`, member access), the slot-allocation contract for internal `__jsmql.__lookup<N>` slots, the mode-gate behaviour, the deployment requirement for the cross-database `from: { db, coll }` shape, and the error catalog.

## Why `$$$` (and not `this.`)

The first attempt at this surface used `this.<coll>.find(pred)` ([reverted commit `1dc2c7b`](../DEVLOG.md)). It read well, but `this` is a JavaScript reserved word that's *parse-rejected* outside class/method bodies, which violates the strict-JS-subset rule in the root [`CLAUDE.md`](../../CLAUDE.md): `($) => this.users.find(...)` would refuse to round-trip through a `.js` file. The reverted spec moved to plain `this.` but the new direction uses the reserved context-reference prefixes (`$$`/`$$$`/`$$$$`) instead — they parse anywhere, never collide with the JS host language, and provide a single uniform vocabulary for the four document-context scopes (`$.`, `$$`, `$$$`, `$$$$`). See [`context-references.md`](./context-references.md) for the prefix grammar and AST nodes.

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

The one parser extension: **block-body lambdas in lookup-callback position**. In `parsePostfix`, when the method being consumed is `find` or `filter` *and* the receiver chain walks back to either a `DatabaseRef` or a `ClusterRef` leaf (checked via the file-local `isLookupReceiverRooted` helper), `parseMethodCallArgs` is invoked with `allowBlockBody = true`. That flag threads through `parseCallArg` → `parseArgOrLambda` → `parseLambdaUnparen` / `parseLambdaParen`; when the lambda's body begins with `{`, those parsers dispatch to a new `parseLambdaBlockBody()` that reuses the same `;`-separated statement collector as the top-level block-body arrow form ([`src/parser.ts:501`](../../src/parser.ts:501)). The result is normalised to a `Pipeline` AST node and assigned to the lambda's new optional `block` field; the regular `body` field remains undefined.

Outside lookup-callback positions, `=> {` retains its existing meaning (an object-literal value when wrapped in parens, ParseError otherwise) — no general extension of block-body lambdas.

## AST extension

`src/ast.ts` — the `Lambda` variant gains an optional sibling field:

```ts
| { type: "Lambda"; params: string[]; body?: Expr; block?: Pipeline; pos: number }
```

Exactly one of `body` / `block` is set. All existing consumers (array methods, IIFE, Object.groupBy, ArrayFrom, `$let`, `collectReadsInto`) check for block-form and either throw an actionable error (the lookup-callback position is the only one that accepts block bodies) or skip gracefully. The codegen helper `requireLambda` returns a type-narrowed `{ body: Expr }` shape after the block-form rejection so call sites stay unchanged.

## Module layout

`src/lookup-translation.ts` owns three responsibilities:

1. **Detection.** `detectLookupCall(expr)` recognises a well-formed `$$$.<coll>.<find|filter>(<Lambda>)` *or* `$$$$.<db>.<coll>.<find|filter>(<Lambda>)` shape, returning a `LookupCall` whose optional `db` field is set in the cross-database case. The receiver-walk helper `extractLookupTarget` handles all six bracket combinations across the two shapes by recursing through up to two `StaticAccess` steps (one dot or string-bracket access each). `containsLookupCall(node)` is the cheap deep walk used by mode-gates and the nested-lookup guard. `validateLookupShape(expr)` surfaces the precise error for *malformed* lookups (wrong method, wrong arity, non-arrow predicate, multi-param lambda); its `classifyLookupReceiver` walker accepts either `DatabaseRef`- or `ClusterRef`-rooted chains and threads the right spelling into the error message (`'$$$.<coll>'` vs `'$$$$.<db>.<coll>'`).

2. **Predicate translation.** `translatePredicate(call, ctx, lowerBlock)` picks between the basic form (`{ from, localField, foreignField, as }`) and the correlated-pipeline form (`{ from, let, pipeline, as }`). The basic-form fast path is taken when the lambda body is exactly one `===` between a foreign-rooted path (`o.x.y`) and a `$.` local-rooted path. Anything richer — including `==` (which jsmql restricts to `null` comparisons project-wide; see LANGUAGE.md's `===` vs `==` table) — falls through to the pipeline form, where the sub-pipeline codegen then surfaces the standard "use `===`" rejection if the user wrote `==` between two field paths. Block-body lambdas always use the pipeline form, with the rewritten block as the `pipeline:` body.

3. **Materialisation.** `lowerLookup(call, as, ctx, lowerBlock)` emits one or two stages (one for `.filter`, two for `.find` — the extra is `$set { <as>: { $first: "$<as>" } }`). `extractLookupCalls(expr, ctx, allocSlot, lowerBlock)` is the top-down expression walker that finds chained-on-lookup patterns and materialises them into internal slots, returning the prologue stages alongside a rewritten expression that uses `FieldRef`s into the materialised slots.

The `SubPipelineLowerer` callback is wired by `src/pipeline.ts` (which provides `generateImplicitPipeline` as the lowerer) so this module stays free of the circular `pipeline.ts` import.

## Auto-`let` extraction

The walker `transformExpr` in `src/lookup-translation.ts` runs over the lambda body (expression-form) or over each statement of the block (block-form). At every visited AST node, `classifyPath` reports whether the sub-tree is a `MemberAccess`/`IndexAccess` chain rooted at:

- a `FieldRef` (`$.userId`, `$.user.profile`) → **local**, segments captured.
- the foreign-doc lambda param (`o`, `o.userId`, `o.user.profile`) → **foreign**, segments captured.
- anything else → unclassified; the walker recurses into children.

For local-rooted sub-trees, the let allocator interns the dotted path under a let-var name (last segment of the path; `_2`, `_3`, … on collision). The sub-tree is replaced with a `ParamRef` whose name is the allocated let-var — the existing codegen lowers `ParamRef` to `"$$<name>"` ([`src/codegen.ts:695-697`](../../src/codegen.ts:695)), which is exactly the `$$letVarName` reference the sub-pipeline needs.

For foreign-rooted sub-trees, the sub-tree is replaced with a bare `FieldRef` whose path is the segment chain (e.g. `o.user.profile` → `FieldRef("user.profile")`). Inside the sub-pipeline, the foreign doc is `$$ROOT`, so a bare `"$user.profile"` resolves correctly.

A bare reference to the foreign param itself (`o` alone, no member access) is **rejected** with a targeted "use `o.<field>`" error — no `$$ROOT` lowering yet.

The MongoDB-native `$lookup.let` is wholly distinct from jsmql's pipeline-scoped `let` (`__jsmql.x`): lookup-pipeline lets live only inside one `$lookup.pipeline` and are read as `$$letVar`, while pipeline-scoped lets are materialised as document fields under `__jsmql.<name>` and read as `"$__jsmql.x"`. See [`let-bindings.md`](./let-bindings.md).

## Chained-terminal materialisation

`extractLookupCalls` recognises three chained patterns explicitly:

| Pattern                                    | Emitted stages (slot = `__jsmql.__lookup<N>`)                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `<lookup>.length`                          | `$lookup as: slot`, then `$set { slot: $size("$slot") }`                                                |
| `<lookup>.reduce(fn, init)`                | `$lookup as: slot`, then `$set { slot: <reduce expression over slot> }` (rejected on `.find` receiver) |
| `<lookup>` (direct, no chain)              | `$lookup as: slot` (plus `$set $first` for `.find`)                                                     |

In each case, the returned `rewritten` expression is a `FieldRef` pointing at the slot, so the surrounding stage's codegen runs over the materialised result. Member access (`<lookup>.find(p).name`) and arithmetic operations fall into the generic "direct lookup" branch — the slot ends up holding either a scalar or an array (per the `.find` / `.filter` distinction), and the existing `MemberAccess` / arithmetic codegen handles it.

Patterns not specifically recognised (`<lookup>.map(fn)`, `<lookup>.at(idx)`, second `.filter`) still work — they go through the direct-lookup branch and the existing array-method codegen runs over the materialised slot. The output is slightly more verbose (one extra stage) than a dedicated optimisation, but correct.

A chained terminal that doesn't carry its own predicate (`<lookup>.length`, `.reduce`, `.map`) **requires** a `.find/.filter(pred)` first — bare `$$$.coll.reduce(...)` cannot be reached because `$$$.coll` alone is not a `MethodCall` and `detectLookupCall` won't match. The bare-reference codegen error then fires with the actionable "must be followed by `.find/.filter`" message.

## Pipeline integration

`src/pipeline.ts` wires lookup-translation into the two top-level lowering entry points:

- **`generateImplicitPipeline`** (the `;`-separated form). For each statement:
  - `LetDecl` with a direct lookup value → use `__jsmql.<name>` as the `$lookup.as` slot directly; one `$lookup` stage (+ optional `$set $first`) replaces the usual `$set { __jsmql.<name>: <value> }`.
  - `UpdateFilter` → run through `lowerUpdateFilterWithLookups`, which iterates the comma-chained ops, splitting the coalesced `$set` buffer at any op whose RHS is a direct lookup (LHS path used as the `as:` slot) or contains chained lookups (extracted into internal slots first).
  - Stage call (`$match(...)`, `$project({...})`, …) → `extractFromStageElement` walks the stage body's expressions and lifts any lookup subtrees into prologue stages emitted *before* the stage itself.

- **`generatePipeline`** (the bracketed-array `[...]` form). Same integration, with the additional invariant that adjacent same-kind update ops still coalesce through `generateUpdateOpGroups` — a lookup-bearing op flushes the buffer first, emits the lookup stages, and resumes buffering.

- **`generatePipelineWithCtx`** (sub-pipelines inside `$lookup.pipeline`, `$unionWith.pipeline`, `$facet.*`). Pre-scans for any lookup call inside its elements via `findFirstLookupInElement`; throws a precise "nested lookup not yet supported" error pointing at the inner `DatabaseRef`'s position.

The slot allocator (`makeSlotTracking`) returns `{ alloc, used }` so the trailing `$unset "__jsmql"` cleanup fires whenever either a `let` was declared **or** at least one internal lookup slot was used — keeping the trailing cleanup symmetric with the existing `let`-only path.

## Cluster-rooted (`$$$$`) cross-database joins

The cluster-rooted surface (`$$$$.<db>.<coll>.find/filter(...)`) is identical to the database-rooted surface in every respect *except* the `$lookup.from` shape:

- **Same-database (`$$$.<coll>`):** `lowerLookup` emits `from: "<coll>"` (bare string) — the only shape standard community MongoDB accepts.
- **Cross-database (`$$$$.<db>.<coll>`):** `lowerLookup` emits `from: { db: "<db>", coll: "<coll>" }` (object) — the [MongoDB Atlas Data Federation form](https://www.mongodb.com/docs/atlas/data-federation/query/sql/aggregation-pipeline-stages/). The community MongoDB server **does not** accept this form (`$lookup.from` is server-validated to be a string), so the lowered MQL only runs on Atlas Data Federation or equivalent federated deployments. jsmql does not gate on deployment — the lowering is the same regardless, and the user sees the runtime error if they target the wrong server. The docs section in [LANGUAGE.md → Cross-database lookups](../LANGUAGE.md#cross-database-lookups-dbcollfind--filter) names this requirement up front.

Detection differences:
- `LookupCall.db` carries the database name when extracted from `$$$$.<db>.<coll>`; undefined for `$$$.<coll>`.
- `extractLookupTarget` walks one or two `StaticAccess` steps. The outer step yields the collection name; the inner (if present) yields the db name. The leaf must be a `DatabaseRef` (one step) or `ClusterRef` (two steps); deeper chains return null and the bare-reference codegen path then surfaces the targeted "must be followed by .find/.filter" error.
- `validateLookupShape`'s `classifyLookupReceiver` returns `'$$$.<coll>'` for DatabaseRef-rooted chains and `'$$$$.<db>.<coll>'` for ClusterRef-rooted chains, so the wrong-method / wrong-arity error messages name the right spelling.
- The parser's `isLookupReceiverRooted` (used to enable block-body lambdas) accepts either leaf kind.

Same in every other respect: same predicate-translation (basic vs pipeline form), same auto-`let` extraction, same chained-terminal materialisation, same nested-lookup rejection, same mode-gate behaviour, same `.find` $first follow-up, same `__jsmql.__lookup<N>` slot scheme.

**Dynamic db / coll names.** `$$$$[someVar].coll` or `$$$$.db[someVar]` with a non-static index breaks `extractLookupTarget` (which requires either a `MemberAccess` or a string-literal `IndexAccess` at every step). `detectLookupCall` returns null; codegen reaches the `ClusterRef` leaf and throws the bare-reference error. Static-name-only is appropriate for v1 — MongoDB's `$lookup.from` field is itself a compile-time constant, so a runtime-resolved name would require synthesizing a separate hand-written stage anyway.

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
| Bare `$$$$.<db>.<coll>` (no `.find/.filter`)            | `'$$$$.<db>.<coll>' must be followed by .find(pred) or .filter(pred) … cross-database lookups are only valid in Pipeline mode …` | codegen `ClusterRef` case          |
| `$$$.<coll>.<other-method>(...)` (e.g. `.fnid(...)`)    | `'$$$.<coll>' supports .find(pred) and .filter(pred), not .<m>(). Did you mean '.find'?`                        | `validateLookupShape`              |
| `$$$$.<db>.<coll>.<other-method>(...)`                  | `'$$$$.<db>.<coll>' supports .find(pred) and .filter(pred), not .<m>(). Did you mean '.find'?`                  | `validateLookupShape`              |
| `$$$.<coll>.find()` (no args)                           | `.find(predicate) takes exactly one argument …`                                                                | `validateLookupShape`              |
| `$$$.<coll>.find(<non-arrow>)`                          | `.find(predicate) requires an arrow predicate …`                                                               | `validateLookupShape`              |
| Multi-param lambda                                      | `.find(predicate) takes a single-parameter arrow (the foreign document), got N`                               | `validateLookupShape`              |
| Bare foreign-param ref (`o` alone)                      | `Bare lambda parameter 'o' in a $lookup predicate is not yet supported — use \`o.<field>\``                    | `transformExpr` foreign branch     |
| Nested lookup inside another lookup's predicate         | `Nested lookup ('$$$.<coll>.find/filter' inside another lookup's predicate or pipeline) is not yet supported …` | `rejectNestedLookup`               |
| `.reduce()` chained on `.find()` (scalar-or-null)       | `.reduce() on a .find() result is not meaningful — .find returns a scalar-or-null …`                          | `extractLookupCalls` reduce branch |
| `.length` chained on `.find()` (scalar-or-null)         | `.length on a .find() result is not meaningful — .find returns scalar-or-null …`                              | `extractLookupCalls` length branch |
| Filter mode / `jsmql.filter()` / `jsmql.expr()` lookup  | `<api>() does not allow lookup syntax ('$$$.<coll>.find/filter(...)') — joins are Pipeline-only …`             | `rejectLookupOutsidePipeline`      |
| `jsmql.update()` lookup                                 | `jsmql.update() does not allow lookup syntax …: MongoDB's aggregation-pipeline update form only accepts …`     | `lowerUpdateStrict`                |
| Bare expression with lookup (no `;`, no stage call)     | `Lookup syntax ('$$$.<coll>.find/filter(...)') requires Pipeline mode. …`                                      | `lowerWithCtx`                     |

## Future work

- **Nested lookups.** Auto-extract two binding sources (outer-doc `$.x` + outer-foreign-doc `u.x`) when an inner `$$$.coll.find/filter(...)` appears inside another lookup's lambda body. Currently rejected with a clear message.
- **`$$.find(...)` self-join.** Needs collection-name binding from a schema/driver — see [`context-references.md`](./context-references.md) future-work list.
- **`$$$.coll.concat(arrow)` → `$unionWith`.** Plausible candidate, but `$unionWith` has no `as` slot — needs a statement form (not an assignment) to lower cleanly.
- **Ambient TS types for `$$$`** so the function-form lookup (`($) => $$$.coll.find(...)`) type-checks under TypeScript. Design separately in [`ops-generation.md`](./ops-generation.md).
- **Optimised chained terminals.** `.map`, `.at`, second `.filter` currently fall through the generic path (one extra `$set` stage); they could emit specialised single-stage transforms.
