# Aggregation Pipeline Stages

**Status:** implemented.

This spec covers how `mjsql()` recognises a top-level aggregation pipeline and compiles it to an MQL stage array. The user-facing surface lives in [LANGUAGE.md](../LANGUAGE.md) under "Pipelines"; this file documents the implementation contract for future contributors.

## Sources

- **MongoDB docs:** https://www.mongodb.com/docs/manual/reference/mql/aggregation-stages/
- **Spec YAML:** `vendor/mql-specifications/definitions/stage/`
- **Registry:** [src/stages.ts](../../src/stages.ts) — `STAGES` is the single source of truth for stage names, descriptions, and per-stage sub-pipeline fields.
- **Detection + lowering:** [src/pipeline.ts](../../src/pipeline.ts).

## Detection

`mjsql()` runs in **pipeline mode** when the parsed root AST satisfies `isPipelineAst(ast)`:

1. Root must be an `ArrayLiteral` with at least one element.
2. The *first* element must be a **stage candidate**:
   - `ObjectLiteral` whose first entry is a static `$<name>:` key (correct or misspelled), or
   - `OperatorCall` of any name (any `$<name>(...)` form).

Once pipeline mode is active, every element is validated against the strict shape:

- Stage-object form: `ObjectLiteral` with exactly one static `$<name>:` entry where `<name>` is a registered stage in `STAGES`.
- Stage-call form: `OperatorCall` with `name` registered in `STAGES` and exactly one positional or object-style argument.

A failure at any element throws a `CodegenError` pinpointing the offending index. The error message includes a Levenshtein-based "Did you mean `$<closest>`?" suggestion when the unknown name is within edit distance 2 of a registered stage.

When detection trigger 1 + 2 do not fire, the array is left to the existing expression-mode codegen — so `mjsql("[1, 2, 3]")` still compiles as an array literal expression. The detection rule is intentionally aggressive on `OperatorCall`-typed first elements (`$abs(1)` triggers pipeline mode and fails strictly) because top-level arrays of value-position operator calls are vanishingly rare in practice; copy-pasted MongoDB pipelines are the common case.

## Lowering

`generatePipeline(ast)` walks the array and emits a stage object per element via `generateStageBody(stageName, body)`. The single stage-aware transform is the **`$match` `$expr` wrap rule**:

- `{ $match: <ObjectLiteral> }` → raw passthrough (interpreted as a MongoDB query document; the existing object-literal codegen produces the right shape verbatim).
- `{ $match: <anything else> }` → `{ $match: { $expr: <generated body> } }`.

For other stages, the body is generated with the existing `generate()` infrastructure, so accumulators (`$sum`, `$avg`, …), expression operators, field refs, and method chains all compose naturally inside stage bodies.

## Sub-pipeline recursion

Stages whose body objects carry nested pipelines declare which keys via `subPipelineFields`:

- `$lookup` and `$unionWith`: `["pipeline"]` — the value at that key, when array-shaped and pipeline-detected, is recursively lowered.
- `$facet`: `["*"]` — every value in the body object is treated as a sub-pipeline slot.

For sub-pipeline slots, lowering checks whether the value is itself `isPipelineAst`-positive. If yes, recurse via `generatePipeline`; if no, fall back to `generate` (covering cases like `pipeline: $.someVar` — a field reference rather than a literal array).

## Object-key syntax for `$<name>`

The parser accepts `Dollar` + identifier tokens as a static object key in `parseObjectEntry` ([src/parser.ts](../../src/parser.ts)). Without this, `{ $match: ... }` would fail to parse. The synthesised key name is `$<ident>` exactly — matching how operator names appear elsewhere. This is JS-syntax-valid (`$match` is a legal JS identifier), so the [strict-subset-of-JavaScript](grammar.md#strict-js-subset-rule) invariant holds.

## Public API impact

`mjsql()`'s return type is widened from `object` to `object | object[]` (`MjsqlOutput`). Pipeline mode returns the array; expression mode returns the single object. Both runtime values satisfy `object`, so existing code keeps type-checking. Pre-1.0; semver-tracked when 1.0 cuts.

`validate()` reports pipeline errors as `CODEGEN_ERROR` (not `SYNTAX_ERROR`) — they are caught at the codegen stage after the AST parses cleanly.

## Tests

Coverage lives in [test/pipeline.test.ts](../../test/pipeline.test.ts):

- Each stage in stage-object and stage-call form, with assertions on exact MQL output.
- Mixed-form pipelines.
- `$match` auto-`$expr` wrap (expression body) and raw passthrough (object-literal body).
- Sub-pipeline recursion in `$lookup.pipeline`, `$unionWith.pipeline`, `$facet`.
- Negatives: unknown stage with did-you-mean, mid-pipeline non-stage element, multi-key stage object.
- Regression: plain value array `[1, 2, 3]` stays expression-mode.
- `validate()` surfaces pipeline errors as `CODEGEN_ERROR`.
- The `mql` template tag composes naturally.
- Function-input form (`mjsql(($) => [ ... ])`).

A realistic, multi-stage example also lives in [test/realistic.test.ts](../../test/realistic.test.ts) under "pipeline: top-orders report by department".

## Out of scope (future work)

- **Drift-protection test for `STAGES`** against `vendor/mql-specifications/definitions/stage/`, parallel to `test/operator-spec-coverage.test.ts`. New stages added to MongoDB would be silently missed today.
- **Query-predicate operators inside `$match` object-literal bodies.** Today the body is passed through verbatim; we don't validate `$gt`, `$in`, etc. at the query layer. Tracked in [query-predicates.md](query-predicates.md).
- **`$setWindowFields` static validation** — the stage compiles but window-only operators (`$rank`, `$denseRank`, `$documentNumber`, …) are not gated to that stage's body.
- **Type-level overloads** of `mjsql()` so a literal pipeline input narrows the return to `object[]`. The widened union is enough for now.
- **Stage-call typo detection.** `$abs(1)` as the first array element triggers pipeline mode and fails strictly, but typos like `$prject({...})` are caught for the same reason — a mistyped stage name still produces a clear error. Object-form typos are caught with did-you-mean.
