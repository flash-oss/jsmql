# Strict-shape entry points

## What this covers

The three strict-shape variants of `jsmql()` exported from [src/index.ts](../../src/index.ts):

- `jsmql.filter(input)` — returns a Filter document; throws on any Pipeline-shaped input.
- `jsmql.pipeline(input)` — returns a Pipeline stage array; throws on a bare expression that would lower to a Filter.
- `jsmql.update(input)` — returns a Pipeline stage array, additionally restricted to MongoDB's aggregation-pipeline update stage whitelist. (The AST node type is still `UpdateFilter`, matching the Node MongoDB driver's `UpdateFilter<T>`; only the function name is shortened to `update`, because "filter" in the driver type routinely trips developers into reaching for it when they meant the query document.)

User-facing reference: [docs/LANGUAGE.md → Strict-shape entry points](../LANGUAGE.md#strict-shape-entry-points-jsmqlfilter-jsmqlpipeline-jsmqlupdate).

## Why they exist

`jsmql()` is polymorphic — it dispatches Filter or Pipeline from the top-level shape of the parsed program (see [filter-mode.md](filter-mode.md) and [aggregation-stages.md](aggregation-stages.md)). The polymorphic surface is the right default when the same source string might legitimately produce either shape. At most real call sites, however, the expected shape is fixed by the driver method being called: `find()` wants a Filter, `aggregate()` wants a Pipeline, `updateOne()` / `updateMany()` want the pipeline form of an update document. When the shape is fixed and the input is wrong (a typoed `$.x = 1` where a filter was meant, an off-by-one stage list, a misplaced `$match` inside an update pipeline), the polymorphic surface silently lowers to the *other* shape — which the driver then sends to MongoDB with a footgun-shaped result. The strict entry points turn each of those into a compile-time error with an actionable message.

## Dispatch

Each entry point is a thin wrapper over the shared `dispatchInput` helper (used by `jsmql()` and `jsmql.expr()` too), parameterised on a `lower` callback that enforces the shape contract:

| Entry point | `lower` callback | Return type |
|---|---|---|
| `jsmql.filter` | `lowerFilterStrict` | `object` |
| `jsmql.pipeline` | `lowerPipelineStrict` | `object[]` |
| `jsmql.update` | `lowerUpdateStrict` | `object[]` |

`dispatchInput` itself stays parametric on the polymorphic `JsmqlOutput = object | object[]` union; the narrow return type is asserted in the per-API wrapper (`as object` / `as object[]`), keeping the shared helper from leaking caller-specific shape knowledge.

## `lowerFilterStrict`

Refuses every Pipeline-shaped AST root and routes the rest through the same `generateFilter` lowerer that `jsmql()`'s no-`;` branch uses:

| AST shape | Action |
|---|---|
| `Pipeline` | throw — name the `;`-Pipeline case, point at `jsmql.pipeline()` / `jsmql()` |
| `UpdateFilter` | throw — name the update-op chain, point at `jsmql.update()` / `jsmql()` |
| `ArrayLiteral` whose first element is a stage shape (`isPipelineAst`) | throw — name the Pipeline array case |
| Bare expression with `detectStageIntent !== null` (top-level `$match(...)` / `{ $match: ... }` / …) | throw — name the stage; for `$match` add a hint to drop the wrapper |
| Anything else | lower via `generateFilter` — same translation as the no-`;` branch of `jsmql()` |

The accepted branch is identical to `jsmql()`'s — index-friendly conjuncts go to a query document, the untranslatable residual rides in a top-level `$expr`. The strict entry point adds zero new lowering paths; it only narrows what it accepts.

## `lowerPipelineStrict` / `lowerUpdateStrict`

Both delegate to a single shared helper, `lowerToPipelineStages(ast, ctx, apiName)`:

| AST shape | Action |
|---|---|
| `Pipeline` | `generateImplicitPipeline(ast, ctx)` |
| `UpdateFilter` | `generateUpdateFilter(ast, ctx)` — wrap the bare-doc result in `[…]` if it's a single stage |
| `ArrayLiteral` matching `isPipelineAst` | `generatePipeline(ast, ctx)` |
| Bare expression with `detectStageIntent !== null` | wrap as a single-element `Pipeline` and lower via `generateImplicitPipeline` — same auto-wrap rule `jsmql()` uses |
| Anything else (bare expression that would have lowered to a Filter) | throw, naming `apiName` and pointing at `jsmql.filter()` |

`lowerPipelineStrict` returns the stages directly. `lowerUpdateStrict` runs one extra pass over the resulting array, comparing each stage's top-level key against `UPDATE_PIPELINE_STAGES`:

```ts
const UPDATE_PIPELINE_STAGES = new Set<string>([
  "$addFields",
  "$project",
  "$replaceRoot",
  "$replaceWith",
  "$set",
  "$unset",
]);
```

The set is alphabetically ordered in the source so the error message it renders stays deterministic — tests can pin the exact ordering of the allowed-stage list. Any stage not in the set produces a `CodegenError` naming the offending stage and its index in the pipeline:

```text
jsmql.update() rejected '$sort' (stage 1): MongoDB's aggregation-pipeline update form only accepts $addFields, $project, $replaceRoot, $replaceWith, $set, $unset. Use jsmql.pipeline() if you need other stages.
```

`let` bindings compose cleanly: they lower to `$set: { "__jsmql.<name>": ... }` plus a trailing `$unset: "__jsmql"` (see [let-bindings.md](let-bindings.md)), both of which are in the whitelist.

**Lookup syntax is pre-rejected.** `$$$.<coll>.find/filter(...)` lowers to `$lookup` (+ follow-up) stages — MongoDB does not permit `$lookup` in the aggregation-pipeline update form (cross-checked against the [`db.collection.updateOne`](https://www.mongodb.com/docs/manual/reference/method/db.collection.updateOne/#update-with-aggregation-pipeline) documentation). `lowerUpdateStrict` runs `containsLookupCall` before codegen and throws a targeted message that names the right entry point (`jsmql.pipeline()`) instead of the generic post-codegen "rejected `$lookup`" whitelist error. The whitelist itself stays as-is and is the second line of defence. See [lookup-stage.md](lookup-stage.md).

**`$out` sugar is pre-rejected outside Pipeline mode.** `$$$.<coll> = …` / `$$$$.<db>.<coll> = …` lowers to a `$out` write. `$out` isn't in the update-pipeline whitelist (it's a stream write, not a per-document update), so the post-codegen whitelist still rejects it as a second line of defence. But `lowerFilterStrict` and `lowerExprWithCtx` also run `containsOutAssign` up front and surface an "use Pipeline mode" hint that names the right entry point — without the pre-check, the user would see the bare-`DatabaseRef` / bare-`ClusterRef` codegen error, which mentions `$lookup` and `$out` but doesn't tell them which mode to switch to. Additionally, `lowerWithCtx` and `lowerToPipelineStages` reroute an `UpdateFilter`-shaped input that contains `$out` sugar through the pipeline lowerer (the bare `generateUpdateFilter` path doesn't know about `$out`). See [out-stage.md](out-stage.md).

## Error messages

Every rejection error carries the offending position from the AST root (`ast.pos`) so editor tooling can underline the source region. The messages follow the DX rules in the root `CLAUDE.md`:

- **Name the API.** Every error starts with `jsmql.filter()` / `jsmql.pipeline()` / `jsmql.update()` — the user knows which call to look at.
- **Name the shape that was found.** `;`-separated Pipeline / update-op chain / Pipeline array / top-level '$match' stage call — not a generic "wrong shape" complaint.
- **Suggest the right call.** Each error names an alternative: the other strict entry point, the polymorphic `jsmql()`, or — when the user almost certainly wrote a $match by reflex — drop the wrapper and call `jsmql.filter()` on the predicate directly.

## When to update this spec

- A new top-level Program shape (beyond `Expr`, `UpdateFilter`, `Pipeline`) — extend the dispatch tables.
- A change to the set of stages allowed inside an aggregation-pipeline update — keep `UPDATE_PIPELINE_STAGES` aligned with the MongoDB documentation linked in the source comment.
- A change to the polymorphic `jsmql()` dispatch (in [filter-mode.md](filter-mode.md) / [aggregation-stages.md](aggregation-stages.md)) — make sure the strict entry points still mirror the same accept/reject decisions, just with `throw` in place of the auto-route.
