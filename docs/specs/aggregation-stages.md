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
2. **Bracketed `[…]`** — the parser returns an `ArrayLiteral`. The shape rule ([filter-mode.md § The decision](filter-mode.md)) reads it as a pipeline, whatever it holds, and `subPipeline` lowers the elements as the statements they are. Adjacent writes coalesce as a `,`-run does ([update-filter.md](update-filter.md)).

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
- **Name** — any row with a `statement` cell. `$count` resolves as the *stage*, matching statement position. An unknown `$`-name is the developer's own MQL, so it passes through as a stage (`$$.$mtach({ a: 1 })` → `[{ $mtach: { a: 1 } }]`), with no suggestion. An unknown name without a `$` names the nearest name of its own kind, as value position does: a method (`$.tags.popp();` names `.pop()`), a static (`Object.assignn(…);` names `Object.assign`), or a global (`assertt(…);` names `assert(...)`).
- **Arity** — one argument, the stage body. A `$`-named link is the developer's own MQL, so any other count takes HR2's plain form: `$$.$limit(5, 6)` → `{ $limit: [5, 6] }`.
- **Not a stage link** — a bare `.$name` with no call, and `?.$name(…)`. Both are parse errors; see [grammar.md](grammar.md).
- Once the chain produces a **value** (`.map("<field>")`, `.uniq()`, a value terminal), the compiler refuses a following stage link, because a value has no stream for a stage to run over (`streamStages` in `src/compiler/emit/statement.ts`).
- **Placement reads a chain link as a stage.** A link carries the same `position` fact as the statement it stands for, and `place` checks it per link against what the chain has emitted. This is what makes `.$out("a").$limit(1)` fail exactly like `$out("a"); $limit(1);` does.

**Lowering — one equivalence, by construction.** A stage link has no lowering of its own. `streamLink` (and `refStatement`, for a link spelled directly on `$$`) hands it to the same `statement` cell that its statement form uses, in whichever chain it stands in: the root stream, a `$facet` branch, a `$lookup` body (`$$$.<coll>.$match(…)` and `.aggregate((o) => { $match(…); })` are the same program), a `$unionWith` body, or the stages before a `$out`. The two spellings cannot drift.

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

The shape rule in [src/compiler/passes/shape.ts](../../src/compiler/passes/shape.ts) decides once, for the whole program ([filter-mode.md § The decision](filter-mode.md)). A stage call or stage document is a pipeline, with or without a `;`. A bracketed literal is a pipeline, whatever it holds, so every element of `[$match(…), …]` must be a statement, and `jsmql("[1, 2, 3]")` refuses element 0. `jsmql.expr("[1, 2, 3]")` is the array value. The compiler refuses a bare predicate with a `;` (`$.age > 18;`), and it names the `$match(…)` wrapper.

## Lowering

`stageStatement` in [src/compiler/emit/statement.ts](../../src/compiler/emit/statement.ts) lowers a stage call or stage document through its row. The body lowers through the row's `body` rule ([emit-pass.md § stage bodies](emit-pass.md)). A stage that the developer names is the developer's own MQL (HR2), and HR3 does not apply to it. So the compiler checks no key, count or value of its body, and the server checks it: `$limit(0)` → `[{ $limit: 0 }]`. The compiler checks the place of every stage through the row's `position` fact.

The server limits a sort spec to `SORT_KEY_LIMIT` keys ([src/registry/mql.ts](../../src/registry/mql.ts), where the measured slots are listed). A JavaScript sort spelling is the compiler's lowering, so the stream sort methods refuse a longer sort through `streamSortAsk` in `src/compiler/emit/sort-spec.ts`; see [stream-methods.md](stream-methods.md). A `$sort` stage that the developer writes passes through, and the server checks its keys.

The one stage-aware body rule is `$match`'s. An object literal is a query document, and it passes through verbatim (the escape hatch: `$match({ $expr: … })` forces the aggregation form). Anything else lowers through the filter road ([filter-mode.md § The filter road](filter-mode.md)), so `find()` and `$match` produce the same document for the same input. Other bodies lower through the value road, where accumulators, operators, field references and method chains compose.

### `$`-string pass-through (HR1)

Under **HR1** (see [docs/LANG_RULES.md](../LANG_RULES.md)), a `$`-prefixed string literal typed in source passes through verbatim in **every** context: a stage path (`$unwind("$items")`), a stage-spec value (`$project({ x: "$y" })`), an array body (`$documents([{ a: "$x" }])`), a nested operator argument (`$project({ t: $concat("$a", "$b") })`). So pasted raw MQL (`[{ $unwind: "$items" }]`) round-trips, and the compiler never mangles it into the un-runnable `{ $unwind: { $literal: "$items" } }`. The `StringLiteral` case of the value road ([src/compiler/emit/lower.ts](../../src/compiler/emit/lower.ts)) emits the value unchanged.

The one `$literal` the compiler adds is HR1's gate for a value that arrives at RUN TIME — a `jsmql.compile` parameter, a template `${…}`. Such a value is a value, never syntax. The two forms share the `inject` pass, so they give one answer. A value that reads as MQL — a string that starts with `$`, a document with a `$` key — stays an `Injected` node, and `injectedPlacement` in [src/compiler/emit/env.ts](../../src/compiler/emit/env.ts) gives one of three answers:

- **`$literal`** — a slot that the server evaluates as an expression. In a stage body, the stage row's `evaluates` names these paths: `$set`'s and `$project`'s values, `$group`'s `_id`, `$lookup`'s and `$merge`'s `let`, `$replaceWith` and `$documents` as a whole, and the others the row states. MEASURED: each one takes `{ $literal: … }` and gives the literal value.
- **as written** — a place that evaluates nothing: a query slot, an update document, and the inside of a `$literal(…)` that the developer writes. That `$literal` sets the Env's `envelope`, and under the envelope nothing is an operator or a field reference.
- **refused** — every other slot, because there the value becomes part of the MQL. This covers a stage slot that the server reads as written (`$unwind`'s path, `$count`'s name, `$lookup`'s `from`, `$sort`'s order: MEASURED, each one refuses `{ $literal: … }`), an accumulator, a window function, and a statement. The message names the spelling to write in the source, with `…` in place of each value to pass.

The position pass carries the stage and the path to such a slot as `written` on the value's `Where`, and every node below the slot carries it too. See [position-pass.md](position-pass.md).

The query road applies the same rule to a raw query document ([filter.ts](../../src/compiler/emit/filter.ts), `injectedInQuery`). A field compares the value (`{ a: v }` becomes `{ a: { $eq: v } }` when `v` holds an operator). The operand of a comparison operator, one whose row states `liftsTo`, is the value as written. Every other operator reads its operand as a query or as MQL syntax (`$and`, `$not`, `$elemMatch`, `$near`), so the value is refused there. The same refusal applies to a whole predicate: `$match(${q})` and the whole filter `${q}`.

The compiler accepts `$ = "$sub"`, a field path that resolves to a document at run time, the same as `$ = $.sub` does, and it lowers to `{ $replaceWith: "$sub" }`. The compiler refuses `$ = "sub"`, because a string is not a document.

## Sub-pipelines

`pipelineBody` lowers a stage body with a pipeline slot — `$lookup.pipeline`, `$unionWith.pipeline`, every value of `$facet` — as the statements it holds, in an Env that has crossed the stage's boundary (`Env.enter`). The row's `pipelineOver` fact says whether the body runs over the SAME documents (`$facet`: outer bindings readable, `$$.size()` the stamped field) or over ANOTHER collection (`$lookup`: the outer document reaches the body through `let`, which the row states as `takesLet`; `$unionWith`: nothing reaches it). A slot whose value is not a pipeline (`pipeline: $.someVar`) lowers as a value. Nested sub-pipelines nest the boundaries.

## Accumulator / window operator positions

An operator's row says where it may stand (`where`), and it states the lowering for each of those positions. A `$op(…)` call is the developer's own MQL, so a call in a position that the row does not list takes HR2's plain form, and the server judges it:

- A **window** operator (`$rank`, `$derivative`, …) stands in a `$setWindowFields` output slot. Elsewhere it passes through: `jsmql.expr("$rank()")` → `{ $rank: {} }`, and mongod answers "Unrecognized expression '$rank'".
- An **accumulator-only** operator (`$push`, `$addToSet`, `$top`, …) stands in a `$group` field slot, a `$setWindowFields` output slot, or as an update operator in `jsmql.update`. Elsewhere it passes through the same way.

The positions are the rows' facts, and the generated globals read them too. See [globals-generation.md](globals-generation.md).

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
- An unknown stage that passes through, a mid-pipeline non-stage element, and a multi-key stage object.
- Regression: plain value array `[1, 2, 3]` stays expression-mode.
- `validate()` surfaces pipeline errors as `CODEGEN_ERROR`.
- The template-tag form of `jsmql` composes naturally.
- Function-input form (`jsmql(({ $ }) => [ ... ])`).

A realistic, multi-stage example that uses the canonical `;`-separated form lives in [test/realistic.test.ts](../../test/realistic.test.ts) under "pipeline: top-orders report by department".

## Related

- [Update filters](update-filter.md) — how `$.x = ...` / `delete $.x` lower to `$set` / `$unset` stages and coalesce.
- [Let bindings](let-bindings.md) — pipeline-scoped local variables (`let x = ...`) that materialise under a single namespace field and auto-clean up.
