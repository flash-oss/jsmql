# Pipeline-scoped `let` bindings

**Status:** implemented.

How `let <name> = <expr>;` lowers from JavaScript-syntax pipeline statements
to MongoDB `$set` / `$unset` stages, and how downstream identifier references
are rewritten to the materialised field paths.

User-facing reference is in [LANGUAGE.md](../LANGUAGE.md) § Pipelines.

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
type LetDecl = { type: "LetDecl"; name: string; value: Expr };
```

`PipelineStmt` is widened to `UpdateFilter | Expr | LetDecl`; `ArrayElement`
is widened to include `LetDecl` (parallel to `AssignExpr` / `DeleteStmt`), so a
let can appear either as a `;`-separated statement or as an element in a
bracketed `[…]` pipeline.

## Lexer

One new keyword in [src/lexer.ts](../../src/lexer.ts):

| Token | Source | Notes |
|-------|--------|-------|
| `Let` | `let`  | Reserved keyword. Added to `isIdentOrKeyword` so `$let(...)` (the MongoDB operator) and `{ let: … }` (object keys in `$lookup`, `$graphLookup`, top-level `aggregate({ let })`) still parse. The shorthand-property form `{ let }` is intentionally rejected — there's no useful meaning for it and it would collide with `let x = …` statements. |

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

`parseLetDecl()` consumes `let <Ident> = <Expression>`. Missing identifier or
missing `=` produces a position-marked `ParseError`. Re-declaration is **not**
caught at the parser — it needs a pipeline-level view and lives in codegen.
The constructed `LetDecl` node records the `let` keyword's source offset in its
`pos` field; codegen forwards that offset into every `CodegenError` it raises
about the binding (re-declaration, binding/parameter name collision, dropped-let
read after a reshape stage), so `.validate()` callers see the original `let`
keyword in `errors[0].pos`.

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
- **`const` keyword.** Pre-1.0 there is no semantic difference from `let`,
  so adding the keyword is pure surface-area cost.
- **Multi-binding `let a = …, b = …;`.** Comma-separated bindings inside one
  `let`. Doesn't compose well with the existing `,`-as-update op-separator
  rule; punt to a follow-up that picks a clear disambiguation.
- **Index-pitfall warning.** A `let` before an indexable `$match` blocks the
  match from using the index. The compiler could surface a warning through
  `validate()`, but that requires a warning channel which doesn't exist yet.
  Documented in `LANGUAGE.md` instead.
- **Looser `$facet` semantics.** Right now outer lets do not cross any
  sub-pipeline boundary. A future version could let `$lookup.pipeline` /
  `$unionWith.pipeline` see outer lets (they typically run with the outer
  document still in context); `$facet` is harder because each branch is
  evaluated against the same input.

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
