# Aggregation Pipeline Stages

**Status:** implemented.

This spec covers how `jsmql()` recognises a top-level aggregation pipeline and compiles it to an MQL stage array. The user-facing surface lives in [LANGUAGE.md](../LANGUAGE.md) under "Pipelines". This file documents the implementation contract for future contributors.

## Sources

- **MongoDB docs:** https://www.mongodb.com/docs/manual/reference/mql/aggregation-stages/
- **Spec YAML:** `vendor/mql-specifications/definitions/stage/`
- **Registry:** every stage is a `$name: mongo({ … })` row in [src/registry/names.ts](../../src/registry/names.ts) with a `statement` cell, a `body` rule, a `position` / `pipelineOver` fact, and the description the globals generator reads.
- **Detection + lowering:** [src/compiler/emit/statement.ts](../../src/compiler/emit/statement.ts).

## Two pipeline forms

JSMQL accepts two surface forms, and both lower through the statement road in `src/compiler/emit/statement.ts`. The **`;`-separated form is canonical** for user-facing material. [LANGUAGE.md](../LANGUAGE.md#canonical-form--between-stages) recommends it, the README's tour uses it, and `test/realistic.test.ts` is written in it.

1. **`;`-separated (canonical)** — the parser returns a `Pipeline` whose `stmts` are the `;`-separated statements. `lowerProgram` lowers each in turn, and it threads the scope: a `let` declared in one statement is a name the next one reads, and a stage that replaced the document takes it away again.
2. **Bracketed `[…]`** — the parser returns an `ArrayLiteral`. The shape rule ([filter-mode.md § The decision](filter-mode.md)) reads its FIRST element, and `subPipeline` lowers the elements as the statements they are. Adjacent writes coalesce as a `,`-run does ([update-filter.md](update-filter.md)).

The two forms agree on stage shapes, the `$match` body rule, and sub-pipeline lowering. They differ only in coalescing, which falls out of the separator: `,` is in-stage (and groups writes), `;` is a hard stage boundary.

## Chained stage calls

A stage may also be written as a **chain link** on a stream: `<stream>.$match(<body>)`.
This is the chain-position spelling of the `$match(<body>);` statement — same row
registry, same body lowering, same placement rules.

```js
$$.$match({ status: "shipped" }).$sort({ total: -1 }).$limit(5);
const top = $$$.orders.$match({ status: "shipped" }).$group({ _id: "$region", n: $sum(1) }).$limit(3);
```

Why it exists: stage calls stand at statement position, and JS chain methods
stand in both. That leaves one empty cell: a chain that cannot reach a stage.
This matters most for the stages with **no JavaScript spelling** (`$group`,
`$unwind`, `$setWindowFields`, `$bucket`, `$graphLookup`, …). In a value
position (`const x = $$$.<coll>.…`), a program otherwise reaches them only by
nesting an `.aggregate((o) => { … })` block.

**Surface.**

- **Receiver** — a stream: `$$`, `$$$.<coll>`, a callback's third parameter, or any chain link off one of those. Stage links and the lodash chain methods ([stream-methods.md](stream-methods.md)) interleave freely while the chain is still stream-shaped.
- **Name** — any row with a `statement` cell. `$count` resolves as the *stage*, matching statement position. The compiler refuses an unknown `$`-name and names the nearest stage (`didYouMean`), instead of falling through to value-mode method dispatch.
- **Arity** — exactly one argument, the stage body (the row's `args`).
- **Not a stage link** — a bare `.$name` with no call, and `?.$name(…)`. Both are parse errors; see [grammar.md](grammar.md).
- Once the chain produces a **value** (`.map("<field>")`, `.uniq()`, a value terminal), the compiler refuses a following stage link, because a value has no stream for a stage to run over (`streamStages` in `src/compiler/emit/statement.ts`).
- **Placement reads a chain link as a stage.** A link carries the same `position` fact as the statement it stands for, and `place` checks it per link against what the chain has emitted. This is what makes `.$out("a").$limit(1)` fail exactly like `$out("a"); $limit(1);` does.

**Lowering — one equivalence, by construction.** A stage link has no lowering of its own. `streamLink` hands it to the same `statement` cell its statement form uses, in whichever chain it stands in: the root stream, a `$facet` branch, a `$lookup` body (`$$$.<coll>.$match(…)` and `.aggregate((o) => { $match(…); })` are the same program), a `$unionWith` body, or the stages before a `$out`. The two spellings cannot drift.

```js
$$$.archive = $$.$match({ s: "x" }).$sort({ a: -1 });
// → [{ $match: { s: "x" } }, { $sort: { a: -1 } }, { $out: "archive" }]
//   identical to: $match({ s: "x" }); $sort({ a: -1 }); $$$.archive = $$;
```

Name resolution, arity and placement live in one place, [src/compiler/emit/statement.ts](../../src/compiler/emit/statement.ts), reading the rows' `args` and `position` facts, so every container shares the wording; see [emit-pass.md](emit-pass.md).

**Correlation.** Inside a foreign sub-pipeline, `$.` means the *outer* document,
and it hoists into `$lookup.let`. That works in every aggregation-**expression** slot:

```js
$.t = $$$.orders.$set({ owner: $.tag });
// → { $lookup: { from: "orders", let: { jsmql_f0_tag: "$tag" },
//                pipeline: [{ $set: { owner: "$$jsmql_f0_tag" } }], as: … } }
```

A `$match` whose body is an **object literal** reads through the filter road,
with the outer reads carried. A query document does not evaluate `$$`
variables: mongod *accepts* `{ $match: { userId: "$$jsmql_f0__id" } }` and
silently matches **nothing** (measured). So a correlated clause lowers as
`$expr`, and an uncorrelated document passes through verbatim (HR1):

```js
$.t = $$$.orders.$match({ userId: $._id });
// → { $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "t" } }
//   — one correlated equality and nothing else is the pair, whichever way it is spelled

$.t = $$$.orders.$match({ qty: { $gte: $.min } });
// → { $lookup: { from: "orders", let: { jsmql_f0_min: "$min" },
//                pipeline: [{ $match: { $expr: { $gte: ["$qty", "$$jsmql_f0_min"] } } }], as: "t" } }
```

`$match({ … })`, `.filter({ … })` and the `.aggregate((o) => { $match({ … }); })` block spelling agree.

## Which document a program is

The shape rule in [src/compiler/passes/shape.ts](../../src/compiler/passes/shape.ts) decides once, for the whole program ([filter-mode.md § The decision](filter-mode.md)). A stage call or stage document is a pipeline, with or without a `;`. The first element of a bracketed literal decides its shape, so `jsmql("[1, 2, 3]")` stays an array expression, and `[$match(…), …]` is a pipeline whose every element must then be a statement. The compiler refuses a bare predicate with a `;` (`$.age > 18;`), and it names the `$match(…)` wrapper.

## Lowering

`stageStatement` in [src/compiler/emit/statement.ts](../../src/compiler/emit/statement.ts) lowers a stage call or stage document through its row. The body lowers through the row's `body` rule ([emit-pass.md § stage bodies](emit-pass.md)); the literal-gated checks in `check.ts` refuse what the server would — a `$limit: 0`, an unknown `$group` key, a `$project` that mixes inclusion and exclusion. Placement lowers through its `position` fact.

The one stage-aware body rule is `$match`'s. An object literal is a query document, and it passes through verbatim (the escape hatch: `$match({ $expr: … })` forces the aggregation form). Anything else lowers through the filter road ([filter-mode.md § The filter road](filter-mode.md)), so `find()` and `$match` produce the same document for the same input. Other bodies lower through the value road, where accumulators, operators, field references and method chains compose.

### `$`-string pass-through (HR1)

Under **HR1** (see [docs/LANG_RULES.md](../LANG_RULES.md)), a `$`-prefixed string literal typed in source passes through verbatim in **every** context: a stage path (`$unwind("$items")`), a stage-spec value (`$project({ x: "$y" })`), an array body (`$documents([{ a: "$x" }])`), a nested operator argument (`$project({ t: $concat("$a", "$b") })`). So pasted raw MQL (`[{ $unwind: "$items" }]`) round-trips, and the compiler never mangles it into the un-runnable `{ $unwind: { $literal: "$items" } }`. The `StringLiteral` case of the value road ([src/compiler/emit/lower.ts](../../src/compiler/emit/lower.ts)) emits the value unchanged.

The one `$literal` the compiler adds is HR1's gate for a value that arrives at RUN TIME — a `jsmql.compile` parameter, a template `${…}`. Such a value is a value, never syntax. `injectedNeedsLiteral` in [src/compiler/emit/env.ts](../../src/compiler/emit/env.ts) wraps it wherever the server would evaluate the slot (an expression, a `$set` value, a stage body). It leaves the value as written in a query slot and in an update document, because those evaluate nothing. A `$literal(…)` the developer writes sets the Env's `envelope`, and under that envelope nothing is an operator or a field reference.

The compiler accepts `$ = "$sub"`, a field path that resolves to a document at run time, the same as `$ = $.sub` does, and it lowers to `{ $replaceWith: "$sub" }`. The compiler refuses `$ = "sub"`, because a string is not a document.

## Sub-pipelines

`pipelineBody` lowers a stage body with a pipeline slot — `$lookup.pipeline`, `$unionWith.pipeline`, every value of `$facet` — as the statements it holds, in an Env that has crossed the stage's boundary (`Env.enter`). The row's `pipelineOver` fact says whether the body runs over the SAME documents (`$facet`: outer bindings readable, `$$.size()` the stamped field) or over ANOTHER collection (`$lookup`: the outer document reaches the body through `let`; `$unionWith`: nothing reaches it). A slot whose value is not a pipeline (`pipeline: $.someVar`) lowers as a value. Nested sub-pipelines nest the boundaries.

## Accumulator / window operator positions

An operator's row says where it may stand (`where`), so a position that is not listed is refused at compile time with the position that is:

- A **window** operator (`$rank`, `$derivative`, …) stands only in a `$setWindowFields` output slot: "$rank is a window operator — only valid inside '$setWindowFields' output slots. Use $setWindowFields({ partitionBy: ..., sortBy: ..., output: { <key>: $rank(...) } }) …".
- An **accumulator-only** operator (`$push`, `$addToSet`, `$top`, …) stands in a `$group` field slot, a `$setWindowFields` output slot, or as an update operator in `jsmql.update`: "$push is an accumulator operator — valid inside '$group' field-value slots, '$setWindowFields' output slots, or as an update operator in jsmql.update. …".

The positions are the rows' facts, so a new operator is gated by its row alone.

## Object-key syntax for `$<name>`

The parser accepts `Dollar` + identifier tokens as a static object key in `objectEntry` ([src/compiler/parse/parser.ts](../../src/compiler/parse/parser.ts)). Without this rule, `{ $match: ... }` would fail to parse. The synthesised key name is `$<ident>` exactly, and this matches how operator names appear elsewhere. This is JS-syntax-valid (`$match` is a legal JS identifier), so the [strict-subset-of-JavaScript](grammar.md#strict-js-subset-rule) invariant holds.

## Public API impact

`jsmql()`'s return type is `object | object[]` (`JsmqlOutput`). Pipeline mode returns the array. Expression mode returns the single object. Both runtime values satisfy `object`, so existing code keeps type-checking. This is pre-1.0, and semver tracks it once 1.0 cuts.

One input shape narrows that union. A **block-bodied arrow** (`({ $ }) => { $match(…); $limit(5); }`) is a run of statements, which is always a Pipeline, and its arrow type returns `void`. So `JsmqlArrowOutput<F>` ([src/index.ts](../../src/index.ts)) resolves it to `object[]`. This is the only shape the input's own type settles. The near-misses are worth stating here, so a future change does not "fix" them by mistake:

- An **expression-bodied arrow** may be either. `({ $ }) => $.age > 18` is a Filter; `({ $ }) => $$.filter(d => d.a).take(5)` is a Pipeline, by the lone-chain sugar. Both are just expressions to TypeScript.
- **Returning an array** does not settle it either. `[$match(…)]` is a Pipeline, while `[$.a, $.b]` is an array-valued Filter, and both are `any[]`. The stage-candidate test that separates them is an AST check, not a type-level one.
- A **string** and a **template tag** are opaque by construction.

Those keep the full union. A caller who needs certainty uses `jsmql.pipeline` / `jsmql.filter`, which are typed to their shape outright.

`validate()` reports pipeline errors as `CODEGEN_ERROR` (not `SYNTAX_ERROR`). It catches them at the codegen stage, after the AST parses cleanly.

## Tests

Coverage lives in [test/pipeline.test.ts](../../test/pipeline.test.ts):

- Each stage in stage-object and stage-call form, with assertions on exact MQL output.
- Mixed-form pipelines.
- `$match` body translation (expression body) and raw passthrough (object-literal body). Full coverage in `test/compiler-filter.test.ts` and the two agreement suites.
- Sub-pipeline recursion in `$lookup.pipeline`, `$unionWith.pipeline`, `$facet`.
- Negatives: unknown stage with did-you-mean, mid-pipeline non-stage element, multi-key stage object.
- Regression: plain value array `[1, 2, 3]` stays expression-mode.
- `validate()` surfaces pipeline errors as `CODEGEN_ERROR`.
- The template-tag form of `jsmql` composes naturally.
- Function-input form (`jsmql(({ $ }) => [ ... ])`).

A realistic, multi-stage example that uses the canonical `;`-separated form lives in [test/realistic.test.ts](../../test/realistic.test.ts) under "pipeline: top-orders report by department".

## Related

- [Update filters](update-filter.md) — how `$.x = ...` / `delete $.x` lower to `$set` / `$unset` stages and coalesce.
- [Let bindings](let-bindings.md) — pipeline-scoped local variables (`let x = ...`) that materialise under a single namespace field and auto-clean up.

## Out of scope (future work)

- **Query-predicate operators inside `$match` object-literal bodies.** Today the body passes through verbatim, and the compiler does not validate `$gt`, `$in`, and other query operators, at the query layer. Will get its own spec when work begins; see the "future work areas" note in [docs/CLAUDE.md](../CLAUDE.md#docsspecs).
- **Stage-call typo detection.** `$abs(1)` as the first array element triggers pipeline mode and fails strictly. That same mechanism catches a typo like `$prject({...})`: a mistyped stage name still produces a clear error. did-you-mean catches an object-form typo the same way.
