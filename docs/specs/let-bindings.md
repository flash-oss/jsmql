# Pipeline-scoped `let` bindings

**Status:** implemented.

How `let <name> = <expr>;` lowers from JavaScript-syntax pipeline statements
to MongoDB `$set` / `$unset` stages, and how downstream identifier references
are rewritten to the materialised field paths.

User-facing reference is in [LANGUAGE.md](../LANGUAGE.md) § Pipelines.

> **Scope note.** This spec covers `let`/`const` at the **top level of a pipeline**, which materialise as `__jsmql.<name>` document fields (`$set` stages). The *same keywords* inside a **block-body arrow** (`x => { const a = …; return … }`) are a different construct with a different lowering — in-expression `$let` variables (`$$name`), not document fields. That is owned by [method-dispatch.md → Block-body arrows](method-dispatch.md#block-body-arrows--nested-let).

## Why it exists

The construct sits above the existing [update ops](update-filter.md) machinery (`$.x = …`)
and adds three things on top of plain update ops:

1. **Auto-cleanup** — one trailing `{ $unset: "__jsmql" }` stage per pipeline,
   emitted by the compiler whenever at least one `let` was declared.
2. **Collision-safe storage** — all lets materialise under a single nested field
   `__jsmql.<name>`. A user's real document field named `name` is never touched.
3. **Bare-identifier reference** — `total` (not `$.total`) at call sites, so
   "scratch helper" reads visually distinct from "real document field". Naturally
   provides a one-line spot for an intent comment per derivation.

Mechanically, the lowering is a thin layer on top of the existing primitives;
no MongoDB-side feature is being added.

## AST

One new node type in [src/ast.ts](../../src/ast.ts):

```ts
type LetDecl = { type: "LetDecl"; name: string; value: Expr; kind: "let" | "const" };
```

`kind` records the surface keyword and only affects reassignment (see
§ Reassignment): a `let` binding is reassignable, a `const` binding is not.

> **Fork note.** When the initialiser is an **arrow function**
> (`const f = (a) => …`), the parser produces a `FuncDecl` instead — a reusable
> named function, not a value binding. The two are distinguished purely by the
> initialiser. See [reusable-functions.md](reusable-functions.md).

`PipelineStmt` is widened to `UpdateFilter | Expr | LetDecl`; `ArrayElement`
is widened to include `LetDecl` (parallel to `AssignExpr` / `DeleteStmt`), so a
let can appear either as a `;`-separated statement or as an element in a
bracketed `[…]` pipeline.

## Lexer

Two keywords in [src/lexer.ts](../../src/lexer.ts):

| Token | Source | Notes |
|-------|--------|-------|
| `Let` | `let`  | Reserved keyword. Added to `isIdentOrKeyword` so `$let(...)` (the MongoDB operator) and `{ let: … }` (object keys in `$lookup`, `$graphLookup`, top-level `aggregate({ let })`) still parse. The shorthand-property form `{ let }` is intentionally rejected — there's no useful meaning for it and it would collide with `let x = …` statements. |
| `Const` | `const` | Read-only sibling of `let` (see § `let` vs `const`). Also added to `isIdentOrKeyword` so `$.const` field paths and `{ const: … }` object keys keep parsing — `const` is a valid JS property name. Shorthand `{ const }` is rejected, same as `{ let }`. |

## Parser

Three production-level changes in [src/parser.ts](../../src/parser.ts):

1. **`collectStatement()`** dispatches on a leading `Let` token to
   `parseLetDecl()` before the existing `Delete` / `++` / `--` checks.
2. **`parseArrayLiteral()`** mirrors that: a leading `Let` inside `[…]` produces
   a `LetDecl` element.
3. **`parse()`, `parseBlockBody()`, `parseExpressionBody()`** each post-check
   that, when the single returned statement is a `LetDecl` and no `;` flipped
   the input into pipeline mode, a precise `ParseError` is thrown: `\`let X = …\`
   is only valid inside a pipeline. Add a trailing \`;\`, or use the bracketed
   form \`[ let X = …, … ]\`.`

`parseLetDecl()` consumes `let <Ident> = <Expression>` (or the `const` alias).
Missing identifier or missing `=` produces a position-marked `ParseError` that
echoes the keyword the user actually wrote (`Expected '=' after \`const x\``).
Re-declaration is **not** caught at the parser — it needs a pipeline-level view
and lives in codegen. The constructed `LetDecl` node records the keyword's source
offset in its `pos` field; codegen forwards that offset into every `CodegenError`
it raises about the binding (re-declaration, binding/parameter name collision,
dropped-let read after a reshape stage), so `.validate()` callers see the original
keyword in `errors[0].pos`.

### `let` vs `const`

Both keywords declare a pipeline-scoped binding; they differ only in **reassignment**.
The three dispatch sites (`collectStatement()`, `parseArrayLiteral()`, and the
object-key branch in `parseObjectEntry()`) accept either keyword. `parseLetDecl()`
records which one was written in `LetDecl.kind` (`"let" | "const"`); declaration,
read, scope-tracking, and cleanup are otherwise keyword-agnostic. The keyword is
echoed in the re-declaration / shadow / parser error wording.

### Reassignment

A later `<name> = <expr>` statement (a bare-identifier assignment) reassigns an
in-scope `let`. Because the name has no `$.` prefix, the parser cannot tell at
parse time whether it's an assignable `let`, a read-only `const`, or undeclared —
so `validateUpdateTarget()` **accepts any bare-identifier (`ParamRef`) target**
and defers the decision to codegen. `tryLowerAssignSugar()`
([src/pipeline.ts](../../src/pipeline.ts)) — the shared `AssignExpr` chokepoint
for every top-level pipeline form — dispatches on a `ParamRef` target first:

- **in-scope `let`** → flush the pending update-op buffer, then emit one
  `{ $set: { "__jsmql.<name>": <rewritten RHS> } }` stage. The RHS resolves the
  binding's own reads through `ctx.pipelineLets` as usual, so `p = p * 0.9`
  lowers to `{ $set: { "__jsmql.p": { $multiply: ["$__jsmql.p", 0.9] } } }`.
  Each reassignment is its own `$set` (a read-after-write needs separate stages),
  matching how a re-declaring `let` already lowers. `+=` / `++` desugar to a
  `BinaryExpr` RHS in the parser, so they flow through this same path for free.
- **in-scope `const`** (`ctx.pipelineConstNames`) → `CodegenError`: *Cannot
  reassign `x` — it is a `const` binding. Declare it with `let x = …` …*.
- **dropped by a reshape stage** (`ctx.droppedLets`) → the post-reshape error,
  reassignment flavour.
- **undeclared** → *Cannot assign to bare identifier 'x' — it isn't a `let`
  binding in scope …*.

Outside a pipeline (Filter / `jsmql.expr` / update-doc mode) there is no let
scope, so a bare-identifier assignment never reaches `tryLowerAssignSugar`;
`targetToPath()` in codegen rejects it with the same "bare identifier" guidance.

### `Object.assign` mutation

`Object.assign(<name>, ...sources)` at statement position is JS's *mutating*
merge of a binding — the value twin is `<name> = { ...<name>, ...sources }`.
`classifyObjectAssignStmt` (in `src/pipeline.ts`) detects it before the generic
statement path and emits one `{ $set: { "__jsmql.<name>": <gen(ObjectCall)> } }`
stage; because the call's first argument *is* `<name>`, that generates
`$mergeObjects["$__jsmql.<name>", ...sources]`. Unlike `=` reassignment it is
**allowed on a `const` binding** — mutating a const-bound object is legal JS,
only rebinding isn't — so it bypasses the `pipelineConstNames` guard. An
out-of-scope name is rejected with a "declare it with `let …` first, or write
`$.<name>`" hint. The field-path sibling (`Object.assign($.x, …)`) and the full
dispatch table live in [update-filter.md § `Object.assign` at statement
position](update-filter.md).

`const`-ness rides on `LetDecl.kind` and is tracked on `GenerateCtx` as
`pipelineConstNames` (a subset of `pipelineLets`); `clearCtxLets()` resets it
alongside the lets, and `extendCtxLets(ctx, name, path, kind)` records it on
declaration.

## Codegen

The let scope lives on `GenerateCtx` ([src/codegen.ts](../../src/codegen.ts)):

```ts
type GenerateCtx = {
  lambdaParams: ReadonlySet<string>;
  reduceRemap?: ReadonlyMap<string, string>;
  pipelineLets?: ReadonlyMap<string, string>;  // ident → field path, e.g. "__jsmql.total"
  droppedLets?: ReadonlyMap<string, string>;   // ident → stage that dropped it
};
```

Helpers (`extendCtxLets`, `clearCtxLets`, `ctxHasLets`, `freshSubPipelineCtx`)
are pure — they return new ctx objects. Lambda-extending ctx constructions
(`extendCtx`, the inline reduce/groupBy ctxs in `codegen.ts`) preserve
`pipelineLets`/`droppedLets`, so a let bound at pipeline scope is visible inside
nested method-call lambda bodies.

### Identifier resolution

In the `ParamRef` codegen branch and inside `asFieldPath`, the lookup order is:

1. `reduceRemap` (innermost — `.reduce()` accumulator/element bindings)
2. `lambdaParams` (any enclosing `.map(x => …)` etc.)
3. `pipelineLets` (let bindings in scope)
4. `droppedLets` → precise "let X can't be read after $Y" error
5. Otherwise → `UnknownIdentifierError`

Lambda parameters intentionally shadow let bindings of the same name *inside
the lambda body*. Outside the lambda, the let is still visible. This matches
standard JS lexical-scoping intuition.

## Pipeline lowering

[src/pipeline.ts](../../src/pipeline.ts) is the orchestrator. Both pipeline
forms (`[...]` and `;`-separated) walk their statements left-to-right with a
threaded `GenerateCtx`:

- **LetDecl** → emit `{ $set: { "__jsmql.<name>": <gen value with current ctx> } }`,
  extend ctx via `extendCtxLets`. Re-declaration check happens here.
- **Update op** (in bracketed form) → buffer for coalescing; flushed through
  `generateUpdateOpGroups(buf, ctx)` so RHS expressions can read lets.
- **Update op chain** (in `;`-separated form) → `generateUpdateFilter(stmt, ctx)`.
- **Stage element** → `stageFromElement(el, i, ctx)`. Stage body is generated
  with the current ctx. If the stage is in `RESHAPE_CLEARING_STAGES`, the ctx
  is updated via `clearCtxLets(ctx, stageName)` *after* lowering — so the body
  can still read lets, but the next stage cannot.

After the last element, if any let was declared (or, more precisely, if either
the in-scope or dropped maps are non-empty — tracked via an `everHadLet` flag),
append exactly one `{ $unset: "__jsmql" }`.

### Reshape-clearing stages

```ts
const RESHAPE_CLEARING_STAGES = new Set([
  "$group", "$bucket", "$bucketAuto", "$replaceRoot", "$replaceWith",
]);
```

These stages either drop the document entirely (`$group`, `$bucket`,
`$bucketAuto`) or replace its root (`$replaceRoot`, `$replaceWith`). After any
of them, the `__jsmql` field is gone, so any later reference to a let from
before the stage would silently coerce to `null` at runtime. The compiler
prevents that footgun by clearing the let scope and remembering the dropper
in `droppedLets`, so a later reference produces a precise error instead of a
silent null.

`$project` is intentionally **not** in this set: inclusion mode would drop
`__jsmql`, but expression-mode (`{ x: $.y + 1 }`) and exclusion-mode
(`{ a: 0 }`) leave the rest of the document — including `__jsmql` — intact.
The compiler conservatively assumes lets survive `$project` and trusts the
user to know whether their `$project` happens to drop the namespace. (If a
user references a let after an inclusion-mode `$project` that dropped
`__jsmql`, they get `null` at runtime — same behaviour as today's manual
`$.tmp = …` + `delete` pattern.)

### Sub-pipeline boundaries

Stages with sub-pipeline slots (`$lookup.pipeline`, `$unionWith.pipeline`,
`$facet.*` — declared via `subPipelineFields` in [src/stages.ts](../../src/stages.ts))
recurse via `generatePipelineWithCtx(value, freshSubPipelineCtx())`. The
fresh-empty ctx means:

- Outer lets are **not** visible inside a sub-pipeline. A reference to an outer
  let from inside `$lookup.pipeline` raises `UnknownIdentifierError` — the
  natural, generic error that already covers "undeclared identifier" cases.
- A sub-pipeline can declare its own `let`s independently. Its trailing
  `$unset: "__jsmql"` lives inside the sub-pipeline.

This is conservative — a future version may relax the rule for non-`$facet`
sub-pipelines where the outer document is in scope — but v1 keeps the
semantics predictable and the error path well-defined.

## Output stability

Pipelines with no `let` declarations produce **byte-identical** MQL output to
pre-feature jsmql. The `__jsmql` field name and the trailing `$unset` only
appear when at least one `let` is in scope at some point during lowering — or
at least one `$$$.<coll>.find/filter(...)` chained terminal materialises into
an internal `__jsmql.__lookup<N>` slot (see [`lookup-stage.md`](./lookup-stage.md)).
The two features share the `__jsmql` namespace and the single trailing `$unset`
cleanup, so a pipeline that uses both still emits exactly one `$unset` stage at
the end.

## Lookup as a `let` RHS

`let x = $$$.coll.find/filter(...)` is recognised in `lowerImplicitPipeline`
and `lowerPipeline`: instead of materialising the value through the usual
`$set { __jsmql.<name>: <value> }` shape, the `$lookup.as` slot is set
directly to `__jsmql.<name>` and the binding is registered in the same way.
For chained-on-lookup RHSes (`let n = $$$.coll.filter(p).length`,
`let s = $$$.tx.filter(p).reduce(fn, init)`), the chained terminal materialises
into an internal `__jsmql.__lookup<N>` slot first; the let machinery then
materialises `__jsmql.<name>` from that slot in the standard way. See
[`lookup-stage.md`](./lookup-stage.md) for the chained-terminal lowering table.

## Deferred (not in v1)

- **`$let`-as-optimisation.** When a let is read in exactly one downstream
  expression and no reshape stage intervenes, the compiler could emit a
  single MongoDB `$let` wrapping that expression instead of `$addFields`/
  `$unset`. Worthwhile for index-preserving `$match`es; not v1.
- **Multi-binding `let a = …, b = …;` [DEF-010].** Comma-separated bindings inside one
  `let`. Doesn't compose well with the existing `,`-as-update op-separator
  rule; punt to a follow-up that picks a clear disambiguation.
- **Index-pitfall warning [DEF-012].** A `let` before an indexable `$match` blocks the
  match from using the index. The compiler could surface a warning through
  `validate()`, but that requires a warning channel which doesn't exist yet.
  Documented in `LANGUAGE.md` instead.
- **Outer lets cross into `$lookup.pipeline` / `$unionWith.pipeline`.** These
  sub-pipelines run on a *different* document (the foreign collection), so
  the materialised `__jsmql.<name>` field doesn't exist there — outer lets
  legitimately don't cross. (The `$lookup.let` clause is the mechanism to
  thread per-doc values into those sub-pipelines; jsmql already auto-extracts
  `$.x` refs into it.)

## Landed

- **Outer lets visible inside `$facet` sub-pipelines** (Wave 5 #28). Each
  facet branch operates on the same input documents that arrived at the
  outer `$facet` stage — they still carry the `__jsmql.<name>` fields the
  outer lets materialised into. A new `freshFacetCtx` helper (in
  `src/codegen.ts`, sibling to `freshSubPipelineCtx`) constructs a fresh
  sub-pipeline ctx that PRESERVES `pipelineLets`; the facet branch lowering
  in `src/facet-translation.ts` uses it. Tests in
  `test/let-bindings.test.ts` cover the let-into-facet shape.

## Tests

[test/let-bindings.test.ts](../../test/let-bindings.test.ts) covers basic
shape, the canonical multi-let example, `$match` `$expr` wrap, `$sort` keys,
method-lambda interaction, lambda-vs-let shadowing, bracketed form,
template-tag form, all five reshape-clearing stages, rebind-after-reshape,
re-declaration, top-level-without-pipeline rejection, single-let-with-`;`
edge case, value-array rejection, sub-pipeline isolation, outer-lets-not-
visible-in-sub-pipeline, and `validate()` round-trip for both error classes.

[test/realistic.test.ts](../../test/realistic.test.ts) carries the canonical
order-pricing example under `pipeline: order pricing with let bindings +
commentary`, which doubles as the playground example via the post-edit hook.
