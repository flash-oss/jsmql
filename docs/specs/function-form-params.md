# Function-form parameter bindings (`jsmql.compile`)

## Purpose

How `jsmql.compile(fn)` lowers a parameterised arrow function to a reusable MQL builder. The companion user-facing reference is [`docs/LANGUAGE.md` § Parameterised Queries](../LANGUAGE.md#parameterised-queries-jsmqlcompile).

`jsmql.compile` exists so a query whose values are dynamic — minimum age, region filter, allowed-status list — can be parsed once and re-bound on every call. It is the function-form counterpart to template-tag interpolation, with the same value-inlining semantics but a typed surface: bindings are named in the arrow's destructure pattern, and TypeScript can flow types from the params object straight through to each identifier in the body.

## Arrow signature

```
(paramsObj?, $?, { $opsHint }?) => body
```

All three slots are optional. The parser classifies each slot by **shape**, not by position name, so users may name the doc-context slot anything they want and still get the right disambiguation:

| Slot shape | Interpretation |
|------------|----------------|
| Plain identifier | Doc context (the canonical `$`; discarded after parsing). |
| Destructure with all `$`-prefixed keys | Ops-hint (types-only IDE autocomplete; the keys are discarded). See note below. |
| Destructure with at least one non-`$` key | Params slot — names become bindings. |

> The ops-hint slot remains supported, but the **preferred alternative** is `import type "jsmql/ops"` (see [`ops-generation.md`](ops-generation.md)). The subpath module surfaces every stage and operator as an ambient global with a spec-derived signature, so users get IDE autocomplete without listing names per call site. The slot stays in the grammar for back-compat with existing code.

When all three appear, the only legal order is `(params, doc, ops)`. Shorter combinations preserve that relative order: `(params, doc)`, `(params, ops)`, `(doc, ops)`, `(params)`, `(doc)`, `(ops)`, and `()`. Anything else throws `FunctionInputError` with the actual and expected orderings.

## Parser

[`src/parser.ts`](../../src/parser.ts) — `parseFunctionInput` returns `{ program, bindings }` (type `FunctionInputResult`). The body is parsed exactly as today; the new work happens in `parseParameterList` (replacing the old `skipParameterList`).

`parseParameterList` walks each top-level slot inside the parens, calling `parseParameterSlot` for each:

- A plain `Ident` or `$` token → `{ kind: "doc" }`. The name is discarded.
- An `LBrace` token → `parseDestructureSlot`. Returns either `{ kind: "ops" }` or `{ kind: "params", bindings: ParamBinding[] }`.
- An `LBracket` → immediate `FunctionInputError` (array destructure rejected).

`parseDestructureSlot` walks the `{ … }` body. Each key is either `Ident` (params key) or `Dollar` + `Ident` (ops key). For each entry it also handles:

- `key: alias` — sets the binding's `name` field to the alias (params keys only; aliases are stripped on ops keys because they only matter for autocomplete, which the original key already provides).
- `key = expr` — rejected with the explanatory message, regardless of what `expr` is. See [§ Why defaults are rejected](#why-defaults-are-rejected).
- `...rest`, nested patterns, array patterns — each rejected with its own targeted message.
- Mixed `$`-and-non-`$` keys in the same destructure → rejected; user must split into two slots.

A `ParamBinding` is `{ key: string; name: string }`:
- `key` is the property looked up on the params object at call time (the *outer* destructure key).
- `name` is the identifier used inside the function body (the *inner* alias, or the same as `key` when there's no rename).

The slot-ordering validator runs after the slots are collected. Slot count > 3 throws immediately. Each slot kind may appear at most once; the order must match `(params, doc, ops)`.

### Why defaults are rejected

Two alternatives were considered and rejected:

- **Allow only literal defaults** (`{ a = 1 }`, but not `{ a = config.x }`). Surface looks like normal JS, but silently fails on any non-literal default. The failure mode is arbitrary from a user's perspective — destructure defaults usually accept any expression. A user who writes `{ minAge = 18 }` and later refactors to `{ minAge = config.defaults.minAge }` would suddenly hit `FunctionInputError`. CLAUDE.md priority #1 forbids that kind of "subset surprise".
- **Evaluate defaults by stringify-then-`Function`-eval.** Lets arbitrary expressions through but reintroduces eval-style semantics into a compile-time API, and forces jsmql to take a position on how unrelated closure references resolve.

Rejecting defaults entirely keeps the rule simple and the surface honest: **the only way values reach a compiled query is through the params object at call time.** For a runtime fallback the user writes `q({ minAge: input ?? 18 })`; for a hardcoded value the template tag already inlines literals (`` jsmql`$.age > ${18}` ``).

## Codegen

[`src/codegen.ts`](../../src/codegen.ts) — `GenerateCtx` gains an optional `bindings` field: `ReadonlyMap<string, unknown>`. Helpers:

- `extendCtx(ctx, params)` preserves `bindings` alongside `reduceRemap`, `pipelineLets`, `droppedLets`.
- `freshSubPipelineCtx(outer)` — **carries `bindings` across the sub-pipeline boundary**, unlike `pipelineLets`. Sub-pipelines run against a different document, so `let` bindings (per-document state) can't follow them; function-form bindings (compile-time constants) can and should.
- `withBindings(ctx, bindings)` returns a new ctx with the bindings map set. Called once from `src/index.ts` at the top of each compiled invocation.

`ParamRef` resolution gains a new tier (innermost-wins ordering):

1. `ctx.reduceRemap` → `$$<remapped>` (`.reduce()` parameter rename).
2. `ctx.lambdaParams` → `$$name` (lambda scope).
3. `ctx.pipelineLets` → `$<fieldPath>` (pipeline-let binding; stored under `__jsmql.<name>`).
4. **NEW** `ctx.bindings` → emit the value directly as a JSON literal.
5. `ctx.droppedLets` → precise "let X can't be read after $stage" error.
6. → `UnknownIdentifierError`.

Bindings and `pipelineLets` are name-disjoint by construction (see [§ Name-collision rule](#name-collision-rule)), so the relative position of (3) and (4) only affects code clarity, not behaviour for valid programs.

### Lambda-param shadowing

A lambda parameter inside the body legitimately shadows a binding of the same name. `.map(x => x * 2)` inside a body with `{ x }` binding resolves `x` to the lambda's `$$x`, not the outer literal. This falls out of the ordering above without special handling.

### Name-collision rule

[`src/pipeline.ts`](../../src/pipeline.ts) — `lowerLetDecl` rejects a `let <name> = …` declaration whose `name` is already in `ctx.bindings`. Two strict-mode rules in JS already prevent the case from arising through legitimate arrow source (parameter and `let` cannot share a name in the same scope), so the check is defensive — but it produces a clear error if the function ever reaches codegen through any other path:

> `let <name>` shadows a function-form parameter binding of the same name. Rename one — parameter bindings are compile-time constants supplied at call time, `let` bindings are per-document values derived from a stage expression; mixing them under one name would be ambiguous.

### `$match` index-friendly translation

[`src/match-translation.ts`](../../src/match-translation.ts) — `translateMatchBody` accepts an optional `TranslateCtx` with the same `bindings` map. The literal-detecting helpers (`anyEqualityLiteral`, `anyOrderedLiteral`) recognise a `ParamRef` whose name is in `ctx.bindings` as if it were a literal AST node, looking the value up at translation time.

This lets `$match($.age >= minAge)` with `{ minAge: 21 }` emit the index-friendly `{ $match: { age: { $gte: 21 } } }` instead of falling back to `{ $match: { $expr: { $gte: ["$age", 21] } } }`. The same type-divergence rules apply as for plain literals — booleans/null are accepted for equality but not for `<`/`>` (where they'd produce silent surprises). See [match-query-translation.md](match-query-translation.md) for the broader translator.

## index.ts — entry points

[`src/index.ts`](../../src/index.ts) — `jsmql` is exposed as a callable with attached properties built via `Object.assign` (since the strippable-TS rule in [src/CLAUDE.md](../../src/CLAUDE.md) forbids `namespace`):

```
jsmql                     // existing one-shot: string / function / template tag
jsmql.compile(fn)         // NEW: parameterised, reusable
jsmql.validate(input)     // MOVED: was top-level export
```

There is intentionally no `jsmql.validate.compile`. The structured-result surface stays scoped to the one-shot `jsmql.validate(input)` call — compile-form errors come back as plain throws on the returned callable, which the caller handles directly. Adding a second total-error surface would duplicate the contract without a real use case until one emerges.

`compileFunction` extracts the arrow source via `Function.prototype.toString.call`, parses once via `parseFunctionInput`, and returns a closure that:

1. Loops over each `ParamBinding`, looking up `b.key` on the params object. Missing keys throw `UnknownIdentifierError` whose message names both `b.key` and `b.name` (when aliased) so the user can find either side.
2. Validates each present value via `validateInterpolatable` (factored out of `stringifyInterpolation` so the template-tag and compile paths share the same JSON-safety guarantee). Failures throw `JsmqlInterpolationError` with the binding key.
3. Builds a `ctx.bindings` map keyed by the *body* identifier name (`b.name`) and lowers the AST through `lowerWithCtx`.

`fnBodyCache` (the LRU for one-shot `jsmql(fn)`) is intentionally bypassed by `compile` — each compiled callable already captures the parsed AST in its closure, which is a stronger form of caching scoped to the user's variable.

### Error mapping

`errorToValidationResult` keeps the per-error-class branch table in one place behind `jsmql.validate()`. The compile-form path doesn't go through it — `jsmql.compile(fn)(params)` is throw-style, by design.

`augmentForFunctionInput` appends two pointers to any `UnknownIdentifierError` raised through the function-form path: the `jsmql.compile(fn)({ x: … })` form for compile-time bindings, and the `` jsmql`… ${x} …` `` form for one-shot template-tag interpolation. The original "Unknown identifier 'X'" message is preserved verbatim.

## Validation rules summary

| When | Failure mode | Error class |
|------|--------------|-------------|
| `jsmql.compile(fn)` (parse time) | Default in destructure | `FunctionInputError` |
| `jsmql.compile(fn)` (parse time) | Nested / rest / array destructure | `FunctionInputError` |
| `jsmql.compile(fn)` (parse time) | Mixed `$`/non-`$` keys | `FunctionInputError` |
| `jsmql.compile(fn)` (parse time) | > 3 params or wrong slot ordering | `FunctionInputError` |
| Compiled callable (bind time) | Body references binding not in params | `UnknownIdentifierError` |
| Compiled callable (bind time) | Param value not JSON-safe | `JsmqlInterpolationError` |
| Compiled callable (bind time) | `let <name>` shadows binding (defensive) | `CodegenError` |

Extra keys on the params object that aren't referenced in the body are silently allowed — partial-coverage refactors don't need to keep the params type in sync with the body manually.

## Test coverage

[`test/codegen.test.ts`](../../test/codegen.test.ts) carries the `describe("jsmql.compile()")` block: simple, array, and object bindings; aliased destructure; lambda-param shadow; `$match` index-friendly path with bindings; pipeline integration; sub-pipeline boundary; missing-binding errors; defaults rejection; malformed destructure; slot orderings; unsafe param values.

[`test/realistic.test.ts`](../../test/realistic.test.ts) carries the `eligibleUsersQuery` example — a real e-commerce-style two-stage pipeline reused across calls.
