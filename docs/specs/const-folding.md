# Constant folding (`const` / `let`)

Single source of truth for how jsmql folds compile-time-constant `const`/`let`
declarations. User-facing behaviour lives in [../LANGUAGE.md](../LANGUAGE.md);
the sibling runtime-binding lowering (a non-constant RHS) lives in
[let-bindings.md](let-bindings.md).

## What it does

When a `const`/`let` declaration's right-hand side is a **compile-time
constant**, jsmql evaluates it at compile time to a single BSON value and
**inlines that value at every reference**; the declaration itself emits no
stage. Two consequences:

- The value is inlined through the exact machinery a `jsmql.compile` parameter
  uses — `ctx.bindings` → `safeBoundValue` in the `ParamRef` codegen case
  ([../../src/codegen.ts](../../src/codegen.ts)). A folded constant and a
  compile-time parameter are indistinguishable to codegen.
- Because a folded declaration emits no stage, a preamble of declarations no
  longer forces Pipeline mode. When the survivors collapse to a single
  expression, the program re-dispatches as a **Filter**:
  `const userId = 0x…; $.userId === userId` → `{ userId: ObjectId("…") }`.

When the RHS is **not** a compile-time constant — it reads `$`, the clock
(`new Date()`, `Date.now()`), the RNG (`Math.random()`), a runtime `let`, or any
form the evaluator doesn't fold — the declaration keeps its existing **runtime**
lowering: a `$set` into `__jsmql.var.<name>` (see [let-bindings.md](let-bindings.md)).
Folding is therefore purely additive; a pipeline with no foldable declaration is
byte-identical to before.

## The two modules

- **[../../src/const-eval.ts](../../src/const-eval.ts)** — `evalConst(node, env, ctx)`,
  a recursive interpreter that reduces an expression AST to a JS/BSON value.
  Returns `{ ok: true, value }` when the node is a compile-time constant,
  `{ ok: false }` when it isn't (any non-constant leaf makes the whole
  expression non-constant), and **throws `CodegenError`** when the node folds
  but the result has no MQL literal (a non-finite arithmetic result — HR3).
  `env` is the map of already-folded names (so later declarations see earlier
  ones); `ctx.bindings` supplies compile-time parameter values.
- **[../../src/const-fold.ts](../../src/const-fold.ts)** — `foldProgram(ast, ctx)`,
  the pre-pass. Runs first in every lowering entry (`lowerWithCtx`,
  `lowerExprWithCtx`, `lowerFilterStrict`, `lowerToPipelineStages` in
  [../../src/index.ts](../../src/index.ts)), so folding is uniform across every
  entry point (`jsmql`, `.expr`, `.filter`, `.pipeline`, `.update`) and runs
  **per call** for `jsmql.compile` (with that call's params in `ctx.bindings`).
- **[../../src/lodash-fold.ts](../../src/lodash-fold.ts)** — MQL-faithful JS
  implementations of the lodash string methods (`snakeCase`, `camelCase`, …),
  which have no native JS equivalent. The word regex and HTML-entity table are
  imported from **[../../src/lodash-shared.ts](../../src/lodash-shared.ts)**,
  which codegen.ts imports too, so the fold and the MQL lowering can't drift.

### The fidelity gate

Native and lodash methods each have two implementations — the compile-time JS
fold and the server-side MQL lowering. [../../test/fold-consistency.test.ts](../../test/fold-consistency.test.ts)
proves they agree: for every foldable method × an input battery it compares the
fold to the lowering evaluated on a real mongod (via `$documents`), skipping
inputs where the lowering itself errors. It self-skips when no local mongod is
reachable. A method/shape it can't prove equal is removed from the evaluator
(→ runtime), never shipped. Divergences it has already forced out: array
`.slice`/`.flat` (`$slice` semantics, no faithful `.flat` lowering), `.find`
not-found (server MISSING ≠ null), empty-separator `.split`, multi-arg string
`.concat`.

## The fold pass

`foldProgram` no-ops unless the program is a `;`-separated `Pipeline`. Then:

1. **Exclusion scan.** A declared name is excluded from folding (kept as its
   runtime binding, preserving today's semantics/errors) when it is: reassigned
   (`x = …`), object-mutated (`Object.assign(x, …)`, `x.push(…)`), declared more
   than once (redeclaration / reshape-rebind), or shadows a compile-time
   parameter.
2. **Walk + fold.** For each non-excluded `LetDecl`, run `evalConst`. On success,
   record `name → value` and drop the declaration; otherwise keep it as a
   survivor (runtime binding).
3. **Thread values.** Folded values are merged into `ctx.bindings`; their static
   compound type (string/array/object) is merged into `ctx.bindingTypes` so
   type-directed codegen (notably `IndexAccess` on a `ParamRef` key) keeps
   emitting the precise `$getField` shape a runtime `const` produced — never the
   `$isArray`-guarded form whose dead `$arrayElemAt[array, "<string>"]` branch
   some servers reject.
4. **Re-dispatch.** Zero survivors → hard error (a declaration with nothing
   reading it). Exactly one surviving expression → return it as a bare `Expr` so
   the entry re-dispatches it (predicate → Filter, stage call → one-stage
   Pipeline). Otherwise → a `Pipeline` of the survivors, which now contains only
   runtime declarations, so `generateImplicitPipeline` is unchanged.

## Inside lambda expr-blocks

Folding also applies inside a lambda expression-block (`x => { const a = …; return … }`,
lowered by `generateExprBlock` in codegen.ts). A declaration whose initialiser
is a compile-time constant is inlined (via `ctx.bindings`) and emits no `$let`;
a declaration that reads the lambda parameter (or is otherwise non-constant)
keeps the nested-`$let` lowering. One guard: a declaration whose name shadows an
in-scope **lambda parameter** is never folded — `ParamRef` resolves lambda
params before bindings, so folding would mis-resolve the shadow; the `$let`
shadows the parameter correctly instead. This makes a constant `const` vanish
wherever it appears, top-level or nested.

## Foldable surface

`evalConst` folds any pure, deterministic subtree over literals and earlier
constants. The membership grows commit-by-commit (each addition gated by the
mongod consistency test, [../../test/fold-consistency.test.ts](../../test/fold-consistency.test.ts))
— the evaluator source is the live inventory. A fold is added only when its JS
result is provably identical to the equivalent MQL lowering (HR3); where the two
could diverge — MQL vs JS truthiness, banker's rounding, collation, int-vs-long
typing — the fold is withheld and the declaration stays a runtime binding.

Correctly **not** folded (stay runtime): anything reading `$`, `new Date()`,
`Date.now()`, `Math.random()`, `.sample()`, a `BigInt` literal.

## Edge cases

| Case | Behaviour |
|---|---|
| Non-constant env RHS (`new Date()`, `Math.random()`, reads `$`) | runtime `$set` binding, no error |
| Declaration with nothing reading it (`const x = 5;` alone) | hard `CodegenError` |
| Non-finite folded result (`1/0`, `0/0`) | hard `CodegenError` (HR3) |
| Invalid constant date (`new Date("nope")`) | rejected (via `generateNewDate` on the runtime fallback) |
| `> MAX_SAFE_INTEGER` | folded as a JS number, matching the `NumberLiteral` policy |
| Folded value used N times | inlined N times (the query planner dedups) |
| Reassigned / mutated / redeclared / param-shadowing name | excluded — stays a runtime binding with its existing error |

## Relationship to the parser

The parser is unchanged: `const`/`let` already produce `LetDecl` nodes, and a
declaration preamble already parses to a `Pipeline` (any top-level `;`). Folding
is a post-parse transform; a lone leading declaration with no following
statement is still rejected by the parser as before.
