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

## Chained stage calls

A stage may also be written as a **chain link** on a stream: `<stream>.$match(<body>)`.
This is the chain-position spelling of the `$match(<body>);` statement — same `STAGES`
registry, same body lowering, same placement rules.

```js
$$.$match({ status: "shipped" }).$sort({ total: -1 }).$limit(5);
const top = $$$.orders.$match({ status: "shipped" }).$group({ _id: "$region", n: $sum(1) }).$limit(3);
```

Why it exists: stage calls worked at statement position and JS chain methods worked in
both, leaving one empty cell — a chain could not reach a stage. That matters most for the
stages with **no JavaScript spelling** (`$group`, `$unwind`, `$setWindowFields`,
`$bucket`, `$graphLookup`, …), which in a value position (`const x = $$$.<coll>.…`) were
previously reachable only by nesting an `.aggregate((o) => { … })` block.

**Surface.**

- **Receiver** — a stream: `$$`, `$$$.<coll>`, `$$$$.<db>.<coll>`, or any chain link off
  one of those. Stage links and the lodash chain methods ([stream-methods.md](stream-methods.md))
  interleave freely while the chain is still stream-shaped.
- **Name** — any key in `STAGES`; `$count` resolves as the *stage*, matching statement
  position. Unregistered `$`-names are still claimed by the chain lowerers (mirroring
  `isStageCandidate`) so a typo reports "not a known aggregation stage" rather than
  falling through to value-mode method dispatch.
- **Arity** — exactly one argument, the stage body (same rule as `asStageShape`).
- **Not a stage link** — a bare `.$name` with no call, and `?.$name(…)`. Both are parse
  errors; see [grammar.md](grammar.md).
- Once the chain produces a **value** (`.map("<field>")`, `.uniq()`, a value terminal), a
  following stage link is rejected by the guard at the top of `generateMethodCall`.

**Lowering — two equivalences, by construction.** A stage link has no lowering of its own;
each container delegates to the path that already lowers the equivalent spelling, so the
two can't drift:

| Container | `.$stage(b)` is defined as | Delegates to |
|---|---|---|
| `$$` current stream | the `$stage(b);` statement | `lowerStageLink` → `generateStageBody` |
| `$ = { k: $$.… }` facet branch (`$facet.<k>`) | the `$stage(b);` statement | `applyStreamMethods` with the `"facet"` validator |
| `$$$.<coll>` foreign chain (`$lookup.pipeline`) | `.aggregate((o) => { $stage(b); })` | `lowerCallbackBlock` — the engine `.aggregate` uses, for the bodies rule 1 above doesn't claim |
| `$$ = $$$.<coll>.…` source-switch (`$unionWith.pipeline`) | the `$stage(b);` statement | `lowerStageLink` → `generateStageBody` |
| `$$$.<coll> = $$.…` write chain (stages before `$out`) | the `$stage(b);` statement | the chain's `SubPipelineLowerer`, over `stageLinkBlock` |

```js
$$$.archive = $$.$match({ s: "x" }).$sort({ a: -1 });
// → [{ $match: { s: "x" } }, { $sort: { a: -1 } }, { $out: "archive" }]
//   identical to: $match({ s: "x" }); $sort({ a: -1 }); $$$.archive = $$;
```

Name resolution, arity, and the sub-pipeline placement rules live in one leaf module,
[src/stage-link.ts](../../src/stage-link.ts), so all three containers share the wording.
Placement is validated per container from the same declarative `forbiddenIn` / `position`
data the statement path reads — so `.$out(…)` inside a `$lookup` chain is rejected. (The
`.aggregate((o) => { … })` block still lacks that container check — see DEF-024.)

**Correlation.** Inside a foreign sub-pipeline `$.` means the *outer* document and hoists
into `$lookup.let`. That works in every aggregation-**expression** slot:

```js
$.t = $$$.orders.$set({ owner: $.tag });
// → { $lookup: { from: "orders", let: { jsmql_f0_tag: "$tag" },
//                pipeline: [{ $set: { owner: "$$jsmql_f0_tag" } }], as: … } }
```

and in a `$match` whose body is an **object literal** it takes one extra step, because that
body is a *query document* and the query language does not evaluate `$$` variables. mongod
*accepts* `{ $match: { userId: "$$jsmql_f0__id" } }` and silently matches **nothing**
(verified on a live server). Two mechanisms cover it, in this order:

1. **A plain equality map is a matcher.** `detectLookupCall` normalises
   `.$match({ userId: $._id })` to `filter` and it takes the identical route, indexed
   basic form included. `{ qty: { $gt: 5 } }`, `$and` and `$expr` bodies are *not* lodash
   matchers and are left alone.

   ```js
   $.t = $$$.orders.$match({ userId: $._id });
   // → { $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "t" } }
   ```

2. **Anything else correlated** goes through `correlatedQueryMatchAsPredicate`, which
   re-expresses the query document as a predicate and hands it to the same
   `translateMatchBody` path `.filter(...)` uses. That splits it into an index-friendly
   query part plus a `$expr` residual for the correlated terms.

   ```js
   $.t = $$$.orders.$match({ qty: { $gte: $.min } });
   // → { $lookup: { from: "orders", let: { jsmql_f0_min: "$min" },
   //                pipeline: [{ $match: { $expr: { $gte: ["$qty", "$$jsmql_f0_min"] } } }], as: … } }
   ```

Either way `$match({ … })` and `.filter({ … })` agree, and the
`.aggregate((o) => { $match({ … }); })` block spelling — which emitted the silently-empty
raw form since it shipped — is fixed by the same change. An **uncorrelated** query document
keeps the verbatim path untouched, so raw MQL still round-trips (HR1). A correlated shape
neither mechanism can express (an `$and`/`$or` root, `$regex`) raises an actionable error
naming the arrow-predicate and expression-body alternatives.

**Relationship to `.aggregate(...)`.** Both remain. `.aggregate` keeps the two jobs a
single link can't do: a multi-stage *block* (with a terminal `return`), and the raw
`[{ $stage: … }, …]` stage-array paste that preserves HR1 round-tripping. Chained stage
calls are the flatter spelling when the stages compose inline with other chain methods.

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

### `$`-string pass-through (HR1) and the `pipelineContext` flag

Under **HR1** (see [docs/LANG_RULES.md](../LANG_RULES.md)), a source-typed `$`-prefixed string literal passes through verbatim in **every** context — pipeline, stage body, `jsmql.expr`, and the standalone Filter `$expr` residual alike. The `StringLiteral` codegen case ([src/codegen.ts](../../src/codegen.ts)) emits it unchanged; jsmql adds no `{ $literal: … }` of its own. So a stage path (`$unwind("$items")`), a stage-spec value (`$project({ x: "$y" })`), an array body (`$documents([{ a: "$x" }])`), and a nested operator argument (`$project({ t: $concat("$a", "$b") })`) all round-trip, and pasted raw MQL (`[{ $unwind: "$items" }]` in → identical out) is never mangled into the un-runnable `{ $unwind: { $literal: "$items" } }`.

The only auto-`$literal` wrap is HR1's runtime-injected exception (`jsmql.compile` params / template-tag `${…}`), applied by `literalSafeInjectedString` via `safeBoundValue`. `GenerateCtx.pipelineContext` — seeded once at the pipeline entrypoints (`generatePipeline` / `generateImplicitPipeline` / `generatePipelineWithCtx`) and propagated down (`extendCtx`, `freshSubPipelineCtx`, `freshFacetCtx`; the let/accumulator helpers spread `...ctx`) — now gates **only** that injected-value wrap: injected values pass through inside a pipeline and wrap in `jsmql.expr` position. The `$literal(...)` operator (which sets `insideLiteral`) forces a literal `$`-string anywhere. See [src/codegen.ts](../../src/codegen.ts) `GenerateCtx.pipelineContext`.

One validator consequence: `rejectNonDocumentNewRoot` ([src/stage-validation.ts](../../src/stage-validation.ts)) now allows a `$`-prefixed string for `$replaceWith` / `$replaceRoot.newRoot` (a field path that resolves to a document at runtime — same as the `$.field` form); a non-`$` literal string is still rejected.

Before lowering, every stage body passes through `validateStageBody` ([src/stage-validation.ts](../../src/stage-validation.ts)) and every stage's placement is checked by the per-pipeline validator in [src/pipeline.ts](../../src/pipeline.ts). This pre-flight pass rejects the structural and shape violations the MongoDB server would otherwise reject — see [pipeline-validation.md](pipeline-validation.md).

`generateImplicitPipeline(p)` lowers each `;`-separated statement independently. A `UpdateFilter` chunk goes through `generateUpdateFilter` (which already emits one or more `$set`/`$unset` stages depending on its `,`-grouped coalescing and read-after-write splits); a stage expression goes through `generatePipeline` with a single-element synthesised `ArrayLiteral` so the `$match` translation rule and sub-pipeline recursion still apply. The output of each statement is concatenated onto the pipeline — there is no cross-statement buffering, so update ops on either side of a `;` never combine.

## Sub-pipeline recursion

Stages whose body objects carry nested pipelines declare which keys via `subPipelineFields`:

- `$lookup` and `$unionWith`: `["pipeline"]` — the value at that key, when array-shaped and pipeline-detected, is recursively lowered.
- `$facet`: `["*"]` — every value in the body object is treated as a sub-pipeline slot.

For sub-pipeline slots, lowering checks whether the value is itself `isPipelineAst`-positive. If yes, recurse via `generatePipeline`; if no, fall back to `generate` (covering cases like `pipeline: $.someVar` — a field reference rather than a literal array).

## Accumulator / window operator context

Some operators are only valid in particular stage slots, and `checkOperatorContext`
in [src/codegen.ts](../../src/codegen.ts) enforces that at compile time:

- **Window-only** operators (any with `category: "window"` in the registry) are
  confined to `$setWindowFields.output` slots.
- **Accumulator-only** operators (those the registry marks with `acc(...)` — see
  [operator-registry.md](operator-registry.md), which owns the flag) are confined to
  `$group` field-value slots and `$setWindowFields.output`.

The context is set by `generateBodyObject` in [src/pipeline.ts](../../src/pipeline.ts)
via `GenerateCtx.accumulatorContext`. Both sets are read from the registry rather than
listed here, so a new operator is gated by its registry entry alone.

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
- Function-input form (`jsmql(({ $ }) => [ ... ])`).

A realistic, multi-stage example using the canonical `;`-separated form lives in [test/realistic.test.ts](../../test/realistic.test.ts) under "pipeline: top-orders report by department".

## Related

- [Update filters](update-filter.md) — how `$.x = ...` / `delete $.x` lower to `$set` / `$unset` stages and coalesce.
- [Let bindings](let-bindings.md) — pipeline-scoped local variables (`let x = ...`) that materialise under a single namespace field and auto-clean up.

## Out of scope (future work)

- **Drift-protection test for `STAGES`** against `vendor/mql-specifications/definitions/stage/`, parallel to `test/operator-spec-coverage.test.ts`. New stages added to MongoDB would be silently missed today.
- **Query-predicate operators inside `$match` object-literal bodies.** Today the body is passed through verbatim; we don't validate `$gt`, `$in`, etc. at the query layer. Will get its own spec when work begins; see the "future work areas" note in [docs/CLAUDE.md](../CLAUDE.md#docsspecs).
- **Type-level overloads** of `jsmql()` so a literal pipeline input narrows the return to `object[]`. The widened union is enough for now.
- **Stage-call typo detection.** `$abs(1)` as the first array element triggers pipeline mode and fails strictly, but typos like `$prject({...})` are caught for the same reason — a mistyped stage name still produces a clear error. Object-form typos are caught with did-you-mean.
