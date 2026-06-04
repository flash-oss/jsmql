# Aggregation Pipeline Stages

**Status:** implemented.

This spec covers how `jsmql()` recognises a top-level aggregation pipeline and compiles it to an MQL stage array. The user-facing surface lives in [LANGUAGE.md](../LANGUAGE.md) under "Pipelines"; this file documents the implementation contract for future contributors.

## Sources

- **MongoDB docs:** https://www.mongodb.com/docs/manual/reference/mql/aggregation-stages/
- **Spec YAML:** `vendor/mql-specifications/definitions/stage/`
- **Registry:** [src/stages.ts](../../src/stages.ts) — `STAGES` is the single source of truth for stage names, descriptions, and per-stage sub-pipeline fields.
- **Detection + lowering:** [src/pipeline.ts](../../src/pipeline.ts).

## Two pipeline forms

jsmql accepts two surface forms that both compile through `src/pipeline.ts`. The **`;`-separated form is canonical** for user-facing material — it's what [LANGUAGE.md](../LANGUAGE.md#canonical-form-;-between-stages) recommends, what the README's tour uses, and what the realistic-test pipelines author. The bracketed form is the alternative for "evaluates to an array literal" cases and verbatim MQL copy-paste.

1. **`;`-separated (canonical)** — any `;` at the top level (including a single trailing `;`) flips parsing to pipeline mode. `Parser.parse()` returns a `Pipeline` whose `stmts` are the `;`-separated statements; `compile()` dispatches to `generateImplicitPipeline`. Each statement is lowered in isolation; adjacent update op statements **never** coalesce across `;`.
2. **Bracketed `[…]`** — `Parser.parse()` returns an `ArrayLiteral`; `compile()` calls `isPipelineAst(ast)` to decide between pipeline and expression mode and dispatches to `generatePipeline`. Adjacent update op elements **coalesce** through `generateUpdateOpGroups`.

The two forms agree on stage shapes, the `$match` body translation rule, and sub-pipeline recursion. They differ only in coalescing behaviour, which falls out of the choice of separator: `,` is in-stage (and groups update ops), `;` is a hard stage boundary.

## Detection (bracketed form)

`jsmql()` runs in **pipeline mode** for an `[…]` literal when the parsed root AST satisfies `isPipelineAst(ast)`:

1. Root must be an `ArrayLiteral` with at least one element.
2. The *first* element must be a **stage candidate**:
   - `ObjectLiteral` whose first entry is a static `$<name>:` key (correct or misspelled), or
   - `OperatorCall` of any name (any `$<name>(...)` form), or
   - `AssignExpr` or `DeleteStmt` — bare update op elements compile to `$set`/`$unset` stages via the coalescer in [docs/specs/update-filter.md](update-filter.md).

Once pipeline mode is active, every element is validated against the strict shape:

- Stage-object form: `ObjectLiteral` with exactly one static `$<name>:` entry where `<name>` is a registered stage in `STAGES`.
- Stage-call form: `OperatorCall` with `name` registered in `STAGES` and exactly one positional or object-style argument.
- Update op form: any `AssignExpr` or `DeleteStmt` element. Adjacent update op elements coalesce through `generateUpdateOpGroups` (see `update-filter.md`).

A failure at any element throws a `CodegenError` pinpointing the offending index. The error message includes a Levenshtein-based "Did you mean `$<closest>`?" suggestion when the unknown name is within edit distance 2 of a registered stage.

When detection trigger 1 + 2 do not fire, the array is left to the existing expression-mode codegen — so `jsmql("[1, 2, 3]")` still compiles as an array literal expression. The detection rule is intentionally aggressive on `OperatorCall`-typed first elements (`$abs(1)` triggers pipeline mode and fails strictly) because top-level arrays of value-position operator calls are vanishingly rare in practice; copy-pasted MongoDB pipelines are the common case.

## Detection (implicit form)

When `Parser.parse()` sees any `;` token at the top level, it returns a `Pipeline` node directly — there is no `isPipelineAst`-style heuristic on the resulting elements. Each statement contributes to the pipeline regardless of whether its first form looks like a stage; non-stage expressions are reported with the usual stage-suggestion error during lowering.

The presence of `;` is also the top-level dispatch signal: any `;` flips `jsmql()` into Pipeline mode, and no `;` routes the input to the [Filter dispatch](filter-mode.md) instead. So a bare predicate like `$.age > 18;` is **rejected** with an actionable `$match(...)` suggestion — Pipeline statements must be stage calls (or update ops / `let` bindings). The error helper `looksLikePredicate` in [src/pipeline.ts](../../src/pipeline.ts) detects comparison / logical / unary-`!` shapes and steers the wording to "wrap as `$match(...)`" so the user doesn't have to look it up.

## Lowering

`generatePipeline(ast)` walks the array and emits a stage object per element via `generateStageBody(stageName, body)`. The single stage-aware transform is the **`$match` body translation rule** ([src/match-translation.ts](../../src/match-translation.ts), full rules in [match-query-translation.md](match-query-translation.md)):

- `{ $match: <ObjectLiteral> }` → raw passthrough (interpreted as a MongoDB query document; the existing object-literal codegen produces the right shape verbatim). This is also the explicit escape hatch: `$match({ $expr: $.foo === 5 })` forces strict aggregation `$eq` semantics.
- `{ $match: <other expression> }` → `translateMatchBody(body)` returns a query-language fragment plus an optional residual. Fully-translatable bodies emit `{ $match: <queryDoc> }` (index-friendly). Partially-translatable bodies emit `{ $match: { ...<queryDoc>, $expr: <residual> } }` so the planner still uses indexes on the translatable half. Fully-untranslatable bodies emit `{ $match: { $expr: <body> } }`.

For other stages, the body is generated with the existing `generate()` infrastructure, so accumulators (`$sum`, `$avg`, …), expression operators, field refs, and method chains all compose naturally inside stage bodies.

### `$`-string pass-through in pipeline context (`pipelineContext`)

`generatePipeline` / `generateImplicitPipeline` / `generatePipelineWithCtx` seed their working ctx with `pipelineContext: true` ([GenerateCtx](../../src/codegen.ts)). That flag is OR-ed into the guard in `literalSafeString` / `safeBoundValue`, so a `$`-prefixed string literal anywhere in a pipeline — a stage path (`$unwind("$items")`), a stage-spec value (`$project({ x: "$y" })`), an array body (`$documents([{ a: "$x" }])`), or a **nested operator argument** (`$project({ t: $concat("$a", "$b") })`) — passes through verbatim instead of being wrapped in `{ $literal: … }`. This makes pasted raw MQL round-trip (`[{ $unwind: "$items" }]` in → identical out) and stops emitting the un-runnable `{ $unwind: { $literal: "$items" } }`.

The flag is set **once at the entrypoint** and propagated down (`extendCtx`, `freshSubPipelineCtx`, `freshFacetCtx` all carry it; `accumulatorCtxFor` and the let-ctx helpers spread `...ctx`); it never flips at operator boundaries — that is the deliberate "Model B" choice (an operator call nested inside a stage does **not** re-introduce `$literal`). The only codegen that keeps wrapping is `jsmql.expr`'s bare-expression branch and the standalone Filter `$expr` residual, neither of which routes through these pipeline entrypoints. The `$literal(...)` operator (which sets `insideLiteral`) is the escape hatch to force a literal `$`-string inside a pipeline. See [src/codegen.ts](../../src/codegen.ts) `GenerateCtx.pipelineContext`.

One validator consequence: `rejectNonDocumentNewRoot` ([src/stage-validation.ts](../../src/stage-validation.ts)) now allows a `$`-prefixed string for `$replaceWith` / `$replaceRoot.newRoot` (a field path that resolves to a document at runtime — same as the `$.field` form); a non-`$` literal string is still rejected.

Before lowering, every stage body passes through `validateStageBody` ([src/stage-validation.ts](../../src/stage-validation.ts)) and every stage's placement is checked by the per-pipeline validator in [src/pipeline.ts](../../src/pipeline.ts). This pre-flight pass rejects the structural and shape violations the MongoDB server would otherwise reject — see [pipeline-validation.md](pipeline-validation.md).

`generateImplicitPipeline(p)` lowers each `;`-separated statement independently. A `UpdateFilter` chunk goes through `generateUpdateFilter` (which already emits one or more `$set`/`$unset` stages depending on its `,`-grouped coalescing and read-after-write splits); a stage expression goes through `generatePipeline` with a single-element synthesised `ArrayLiteral` so the `$match` translation rule and sub-pipeline recursion still apply. The output of each statement is concatenated onto the pipeline — there is no cross-statement buffering, so update ops on either side of a `;` never combine.

## Sub-pipeline recursion

Stages whose body objects carry nested pipelines declare which keys via `subPipelineFields`:

- `$lookup` and `$unionWith`: `["pipeline"]` — the value at that key, when array-shaped and pipeline-detected, is recursively lowered.
- `$facet`: `["*"]` — every value in the body object is treated as a sub-pipeline slot.

For sub-pipeline slots, lowering checks whether the value is itself `isPipelineAst`-positive. If yes, recurse via `generatePipeline`; if no, fall back to `generate` (covering cases like `pipeline: $.someVar` — a field reference rather than a literal array).

## Object-key syntax for `$<name>`

The parser accepts `Dollar` + identifier tokens as a static object key in `parseObjectEntry` ([src/parser.ts](../../src/parser.ts)). Without this, `{ $match: ... }` would fail to parse. The synthesised key name is `$<ident>` exactly — matching how operator names appear elsewhere. This is JS-syntax-valid (`$match` is a legal JS identifier), so the [strict-subset-of-JavaScript](grammar.md#strict-js-subset-rule) invariant holds.

## Public API impact

`jsmql()`'s return type is widened from `object` to `object | object[]` (`JsmqlOutput`). Pipeline mode returns the array; expression mode returns the single object. Both runtime values satisfy `object`, so existing code keeps type-checking. Pre-1.0; semver-tracked when 1.0 cuts.

`validate()` reports pipeline errors as `CODEGEN_ERROR` (not `SYNTAX_ERROR`) — they are caught at the codegen stage after the AST parses cleanly.

## Tests

Coverage lives in [test/pipeline.test.ts](../../test/pipeline.test.ts):

- Each stage in stage-object and stage-call form, with assertions on exact MQL output.
- Mixed-form pipelines.
- `$match` body translation (expression body) and raw passthrough (object-literal body). Full translation-rule coverage in [test/match-translation.test.ts](../../test/match-translation.test.ts).
- Sub-pipeline recursion in `$lookup.pipeline`, `$unionWith.pipeline`, `$facet`.
- Negatives: unknown stage with did-you-mean, mid-pipeline non-stage element, multi-key stage object.
- Regression: plain value array `[1, 2, 3]` stays expression-mode.
- `validate()` surfaces pipeline errors as `CODEGEN_ERROR`.
- The template-tag form of `jsmql` composes naturally.
- Function-input form (`jsmql(($) => [ ... ])`).

A realistic, multi-stage example using the canonical `;`-separated form lives in [test/realistic.test.ts](../../test/realistic.test.ts) under "pipeline: top-orders report by department".

## Related

- [Update filters](update-filter.md) — how `$.x = ...` / `delete $.x` lower to `$set` / `$unset` stages and coalesce.
- [Let bindings](let-bindings.md) — pipeline-scoped local variables (`let x = ...`) that materialise under a single namespace field and auto-clean up.

## Out of scope (future work)

- **Drift-protection test for `STAGES`** against `vendor/mql-specifications/definitions/stage/`, parallel to `test/operator-spec-coverage.test.ts`. New stages added to MongoDB would be silently missed today.
- **Query-predicate operators inside `$match` object-literal bodies.** Today the body is passed through verbatim; we don't validate `$gt`, `$in`, etc. at the query layer. Will get its own spec when work begins; see the "future work areas" note in [docs/CLAUDE.md](../CLAUDE.md#docsspecs).
- **`$setWindowFields` static validation** — *landed* (Wave 5 #41 + #22). `checkOperatorContext` in `src/codegen.ts` gates window-only operators (any with `category: "window"` in the registry) to `$setWindowFields.output` slots, and accumulator-only operators (`$accumulator`, `$addToSet`, `$bottom`/`$bottomN`/`$top`/`$topN`, `$push`, `$median`, `$percentile`) to `$group` field-value slots or `$setWindowFields.output`. Set by `pipeline.ts:generateBodyObject` via the `accumulatorContext` field on `GenerateCtx`.
- **Type-level overloads** of `jsmql()` so a literal pipeline input narrows the return to `object[]`. The widened union is enough for now.
- **Stage-call typo detection.** `$abs(1)` as the first array element triggers pipeline mode and fails strictly, but typos like `$prject({...})` are caught for the same reason — a mistyped stage name still produces a clear error. Object-form typos are caught with did-you-mean.
