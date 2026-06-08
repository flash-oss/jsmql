# Filter mode (no-semicolon dispatch)

## What this covers

The top-level dispatch rule that turns a no-semicolon input into a MongoDB **Filter** (the document `db.coll.find(filter)` takes as its first argument), and the integration with the existing Pipeline dispatch.

Terminology follows the Node.js MongoDB driver: **Filter** for `find()`, **Pipeline** for `aggregate()`.

User-facing reference: [docs/LANGUAGE.md → Output dispatch](../LANGUAGE.md#output-dispatch-filter-vs-pipeline).

## Rule

`lowerWithCtx` in [src/index.ts](../../src/index.ts) dispatches on the parsed `Program` shape:

| AST shape | Lowering | Output |
|---|---|---|
| `Pipeline` (input contains `;`) | `generateImplicitPipeline` | `object[]` — Pipeline (stage array) |
| `UpdateFilter` (top-level `$.x = …` / `delete $.x`) | `generateUpdateFilter` | `object` — `$set` / `$unset` (update document) |
| `ArrayLiteral` whose first element is a stage shape | `generatePipeline` | `object[]` — legacy bracketed Pipeline |
| **anything else (a bare expression)** | **`generateFilter`** | `object` — a Filter document |

The previous default for the last bucket was `generateWithCtx(ast)`, which emitted an aggregation expression (`{ $gt: ["$x", 1] }`). The new default emits a Filter document instead.

## `generateFilter`

Lives in [src/index.ts](../../src/index.ts). Reuses [`translateMatchBody`](../../src/match-translation.ts) — the same translator the `$match` stage already runs — so the Filter and `$match` paths produce the same shapes for the same input.

```ts
function generateFilter(ast: Expr, ctx: GenerateCtx): object {
  const t = translateMatchBody(ast, { bindings: ctx.bindings });
  if (t.residual === null) return t.query;
  const exprPart = { $expr: generateWithCtx(t.residual, ctx) };
  if (Object.keys(t.query).length === 0) return exprPart;
  return { ...t.query, ...exprPart };
}
```

Three cases:

1. **Fully translatable** (residual is `null`) → return the query document directly. Indexable on every conjunct.
2. **Fully untranslatable** (query is empty) → return `{ $expr: <aggExpr> }`. `$expr` is a legal top-level Filter operator, so the output is a valid Filter for any non-predicate expression too.
3. **Mixed** (both have content) → emit a query document with the translatable conjuncts plus an `$expr` for the residual. The query-doc conjuncts stay indexable; the residual evaluates in expression form.

## Stage-call auto-wrap (no `;` required)

Before falling into Filter dispatch, `lowerWithCtx` checks `detectStageIntent(ast)` for two shapes that are almost always Pipeline intent rather than a legitimate Filter:

1. A top-level `OperatorCall` whose name is a registered stage (`$match(...)`, `$project(...)`, `$sort(...)`, …).
2. A top-level single-key `ObjectLiteral` whose key is a registered stage name (`{ $match: ... }` — the form a copy-paste from MongoDB Compass produces).

When matched, `lowerWithCtx` wraps the bare `Expr` into a synthetic `Pipeline` AST node (`{ type: "Pipeline", stmts: [ast], pos: ast.pos }`) and routes it through `generateImplicitPipeline`. So `jsmql("$match($.age > 18)")` produces `[{ $match: { age: { $gt: 18 } } }]` — the same output as the explicit `;` form (`jsmql("$match($.age > 18);")`) — without any `;` discipline at the call site.

| Input | AST after parse | Output |
|---|---|---|
| `$match($.age > 18)` (no `;`) | `OperatorCall { $match }` (bare `Expr`) | `[{ $match: { age: { $gt: 18 } } }]` — auto-wrap |
| `$match($.age > 18);` | `Pipeline { stmts: [OperatorCall] }` | `[{ $match: { age: { $gt: 18 } } }]` — explicit |
| `{ $match: $.age > 18 }` (no `;`) | `ObjectLiteral` (bare `Expr`) | `[{ $match: { age: { $gt: 18 } } }]` — auto-wrap |

Re-using `generateImplicitPipeline` means stage-specific behaviour (the `$match` index-friendly query-translator; sub-pipeline recursion for `$lookup` / `$unionWith` / `$facet`; the let-binding scope rules) runs identically to the explicit `;` path. Auto-wrap is purely a surface-syntax accommodation — the lowering machinery is unchanged.

Without this auto-wrap, the bare expression would silently produce `{ $expr: { $match: { $eq: ["$age", 18] } } }` — a syntactically valid Filter, but `$match` isn't an aggregation expression, so the document is useless at query time. Earlier revisions of this spec threw a `CodegenError("$match is a Pipeline stage, … add a trailing ;")` from `generateFilter` to catch the same footgun, but a throw is a worse DX than a silent right-thing: the user's straightforward expression now compiles to the right MQL instead of failing with an error message they'd then have to act on.

`jsmql.expr()` deliberately does **not** auto-wrap. A stage call passed to `jsmql.expr()` is unusual enough that silently routing through Pipeline mode there would mask a real mistake — `jsmql.expr()`'s contract is "raw aggregation expression," and stages aren't aggregation expressions.

## Function form

[`Parser.parseFunctionInput`](../../src/parser.ts) already classifies the arrow's body shape:

- **Expression-body arrow** (`($) => <expr>`) → returns a single `Expr` program → routes to `generateFilter`.
- **Block-body arrow** (`($) => { stmt; stmt; }`) → returns a `Pipeline` program → routes to `generateImplicitPipeline`.

No additional wiring in this module — the body-shape split already mirrored the string form's `;` split before this change; only the no-`;` codepath needed updating.

## Pipeline-mode stage-call requirement

Pipeline mode rejects bare expressions as statements with an actionable error. Owned by [src/pipeline.ts](../../src/pipeline.ts) `formatNotAStageError` + the `looksLikePredicate` heuristic: when the offending element is a comparison/logical/unary-`!` `Expr`, the error names `$match` as the wrapper:

```text
Element <i> of Pipeline is not a stage call. To filter documents on a
predicate, wrap it as `$match(...)` — e.g. `$match($.age > 18)`.
Pipeline statements must be stage calls; available stages: …
```

The error carries the offending node's `.pos`, so `.validate()` consumers can underline the span (per the [`.pos` invariant](../../CLAUDE.md#1-priority-developer-experience)).

## Edge cases

- **`$expr` in Filters is legal.** MongoDB accepts `{ $expr: <aggExpr> }` at the top level of a Filter, so the residual wrapping is always safe; no separate "strict Filter" mode is needed.
- **Source `$`-strings pass through; no auto-`$literal` (HR1).** A `"$x"` typed in source is the field ref `$x` everywhere — query-doc slot (`$.x === "$y"` → `{ x: "$y" }`) **and** the `$expr` residual (`$concat($.a, "$b") === $.c` → `{ $expr: { $eq: [{ $concat: ["$a", "$b"] }, "$c"] } }`) alike. The only wrap is HR1's runtime-injected exception (`jsmql.compile` params / template-tag `${…}`), applied by `safeBoundValue` in expression position. See [docs/LANG_RULES.md](../LANG_RULES.md) (HR1).
- **`new Date(<static-args>)` is compile-time folded** in query-doc position. `$.createdAt >= new Date("2026-01-01")` lowers to `{ createdAt: { $gte: <Date instance> } }`, not `{ createdAt: { $gte: { $toDate: "2026-01-01" } } }`. The latter would NOT work — MongoDB's query language treats `{ $toDate: "..." }` as a literal subdocument, never matching anything. The fold only fires when all `new Date(...)` (and any nested `Date.UTC(...)`) arguments are themselves compile-time literals; otherwise the comparison falls back to `$expr` (which DOES evaluate `$toDate`). The full rule lives in [match-query-translation.md](match-query-translation.md).
- **`$.field.length`-style "method-as-property" access** is currently treated as a static field path by the match translator's `asFieldPath()` walk, so `$.tags.length < 5` translates to `{ "tags.length": { $lt: 5 } }`. That's a pre-existing edge case in the match translator (it predates this change) and is documented in [match-query-translation.md](match-query-translation.md).
- **Update filters stay update ops.** Top-level `$.x = …` and `delete $.x` still route to `generateUpdateFilter`. They aren't Filters or Pipeline stages; the dispatch leaves them untouched.

## Compile and validate

- `jsmql.compile(fn)(params)` runs through the same `lowerWithCtx`, so parameterised queries automatically get the new dispatch. The function-input shape (expression vs block body) drives the choice exactly as the one-shot call does.
- `jsmql.validate(input)` likewise shares the dispatch path — no extra wiring.
