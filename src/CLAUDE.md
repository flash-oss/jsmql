# src/ — implementation notes

## Pipeline

```
string  →  Lexer  →  Token[]  →  Parser  →  AST  →  generate()  →  MQL JSON
```

Each stage has a single responsibility. Do not leak concerns across boundaries:

- The **lexer** only produces tokens — no meaning, no structure.
- The **parser** only builds the AST — no MQL knowledge, no operator lookup.
- The **codegen** calls the operator registry and produces output — no parsing logic.

## Key invariants

- `src/operators.ts` is the **only** place that knows about individual operator shapes. If you find yourself writing `if (name === '$trim')` in the parser or codegen, that logic belongs in the registry instead. Each entry carries `shape`, `category` (from `OPERATOR_CATEGORIES`), and `description` (lifted from `vendor/mql-specifications/definitions/`). The drift-protection test in `test/operator-spec-coverage.test.ts` keeps the registry aligned with the official spec on every `npm test`. Registry entries mirror **real** MongoDB operators only — jsmql never invents its own `$`-prefixed operators or pseudo-stages (e.g. a convenience `$drop()` will never be added); see the rule in the root [`CLAUDE.md`](../CLAUDE.md) § "Things the user did not explicitly ask for but matter".
- `src/ops.ts` is **generated** by `scripts/generate-ops.mjs` from `OPERATORS` + `STAGES` + the vendored MQL spec, and emits ambient `declare global` types shipped at the `@koresar/jsmql/ops` subpath. Do not edit it by hand — the drift test in `test/operator-spec-coverage.test.ts` byte-compares the committed file against fresh generator output and will fail. Run `npm run generate:ops` (or just `npm test` / `npm run build`) to refresh. See [`docs/specs/ops-generation.md`](../docs/specs/ops-generation.md).
- `src/stages.ts` is the parallel single source of truth for **aggregation pipeline stages** (the elements of a top-level pipeline array, distinct from value-position expression operators). Detection and lowering live in `src/pipeline.ts`, which `src/index.ts:compile()` invokes when the parsed root AST is a pipeline-shaped array. Stage-specific behaviour (currently only the `$match` `$expr`-wrap rule and per-stage sub-pipeline fields) lives there too — never branch on stage names from `codegen.ts`. See `docs/specs/aggregation-stages.md`.
- **Pre-flight validation** rejects pipeline mistakes the server would reject. Two kinds, two homes: *structural placement* (must-be-first / must-be-last / forbidden-in-sub-pipeline) is declared in `stages.ts` (`position` / `forbiddenIn`) and applied by the `makePipelineValidator` closure in `pipeline.ts` (it needs the assembly-loop position); *body shape* (types, bounds, enums, required/exclusive keys) lives in `src/stage-validation.ts`, invoked from `generateStageBody`. **The literal-gating invariant:** body validators inspect only fully-static literal shapes and no-op on any field/expression/spread/computed-key slot, so only 100%-certain violations throw and probable ones still emit MQL. See `docs/specs/pipeline-validation.md`.
- The parser's object-style detection rule: if an operator call has **exactly one argument and that argument is an object literal**, it is `style: 'object'`. If there are multiple args (even if the first is an object), it is `style: 'positional'`. Do not change this rule without updating `docs/specs/grammar.md`.
- Field refs (`$.field`) always serialise to the string `"$field"` in MQL output. Nested paths (`$.a.b`) become `"$a.b"`.
- **`$`-string literals: source passes through, injected wraps (HR1 — see [docs/LANG_RULES.md](../docs/LANG_RULES.md)).** A `"$items"` typed in *source* IS the field ref `$items` and passes through verbatim in **every** context (pipeline, stage, `jsmql.expr`, Filter `$expr` residual) — the `StringLiteral` codegen case emits it unchanged; jsmql adds no `$literal` of its own. The only auto-wrap is HR1's runtime-injected exception: a `"$x"` arriving via `jsmql.compile` params or a template-tag `${…}` is wrapped by `literalSafeInjectedString` (via `safeBoundValue`) in expression position so untrusted input can't silently become a field ref. `GenerateCtx.pipelineContext` (seeded at the pipeline entrypoints) now gates only that injected-value wrap — injected values pass through in a pipeline. Injected `$`-strings reach `safeBoundValue` because the template-tag path routes them through a synthesized `ParamRef` binding (`needsBindingRoute` / `substituteRoutedValues` in `index.ts`), not source-text inlining. `$literal(...)` (which sets `insideLiteral`) forces a literal anywhere.
- Unknown operators (not in the registry) fall through gracefully — see `codegen.ts:generateUnknownOperator`. This is intentional: it future-proofs the tool against new MongoDB operators.
- **jsmql is a strict subset of JavaScript syntax.** Every expression the parser accepts must also parse as JS (`node --check`). Before adding a new lexer token or parser production, write a representative input and run it through `node --check`; if JS rejects it, the construct is off-limits — find a JS-syntax-equivalent surface or expose the feature via `$op(...)`. See root `CLAUDE.md` for the full rule; the dropped numeric-segment case (`$.items.0`) is the canonical example of what this excludes.
- **`src/` stays in TypeScript's strippable subset** — the source must run on Node 22.18+ / 24.3+ via native type-stripping (no flag, no transpiler — unflagged in Node 22.18.0 LTS and in 24.3.0; stable in 25.2.0), and on Deno and Bun. Concretely: no `enum` (use `as const` objects + derived unions like `TokenType`), no `namespace`, no parameter properties in constructors (declare fields explicitly and assign in the body — see `LexError` for the canonical pattern), no decorators, no `<T>x` casts (use `x as T`), no `import =` / `export =`. Internal imports use `.ts` extensions. To smoke-check: `node src/index.ts` must execute without errors. `cli.ts` follows the same rule (it ships as the `jsmql` bin) and additionally carries a `#!/usr/bin/env node` shebang as its first line — TS and esbuild both preserve it — so `node src/cli.ts` (the strippable smoke check) and the bundled `dist/cjs/cli.cjs` both run directly. See `docs/specs/cli.md`.
- **Public-API shape: a callable with attached properties, built via `Object.assign`.** `src/index.ts` exports a single `jsmql` value that is both callable (`jsmql(input)`) and carries `jsmql.compile` and `jsmql.validate` as methods. The shape is intentionally not a `namespace` — that's banned by the strippable-TS rule above. The pattern lives at [src/index.ts:271-284](index.ts): declare an explicit intersection type (`typeof dispatch & { compile: …; validate: … }`) and assemble the value with `Object.assign(dispatch, { compile, validate })`. When you add a new top-level entry point, extend it the same way; don't add a top-level named `export` for what should be a property on `jsmql`.

## Extending the lexer

New token types go in the `TokenType` `as const` object (and the derived `TokenType` type union picks them up automatically). The tokeniser is a single-pass character scanner — keep it that way. Do not add backtracking.

## Extending the parser

New syntax forms add a branch in `parseExpression()` and a dedicated `parseXxx()` method. Keep each method focused on a single grammar rule.

## Extending the codegen

New AST node types add a case in the `_generate(expr, ctx)` switch. The public export is `generate(expr)` which calls `_generate` with `EMPTY_CTX`. All recursive calls must pass `ctx` through — never call `_generate` without it. Helper functions for specific shapes stay private and file-local.

`GenerateCtx` carries two things: `lambdaParams` (set of in-scope lambda parameter names) and `reduceRemap` (maps user param names to MongoDB's fixed `$$value`/`$$this` names inside `.reduce()` bodies). Use `extendCtx(ctx, params)` to add lambda params; never mutate ctx directly.

## Extending the pipeline sugar

`pipeline.ts` is the sugar-dispatch hub: per-element lowering is shared across all pipeline forms (`[ … ]`, `;`-separated, and the `,`-grouped update-filter op chain) through two helpers. Add a new `$ =`-rooted / lookup sugar in `tryLowerAssignSugar` (replace-stream, `$facet`, `$replaceWith`, `$out`, `$lookup`); add a new statement-style sugar (`$$.push` → `$unionWith`, system source stages, `assert(...)` → conditional-error `$match`, the generic stage-call path) in `lowerStatementTail`. Touch either helper and both pipeline forms pick it up at once. Each sugar's behaviour is owned by its spec in `docs/specs/` — keep the lowering rules there, not in comments here. A statement-style sugar that should also work without a trailing `;` (as a lone top-level call) needs a clause in `isStageCandidate` (`pipeline.ts`) **and** the auto-wrap sites in `index.ts` (`lowerWithCtx` / `lowerToPipelineStages`) — `assert` is the worked example.

## Error classes

| Class          | Where thrown | Has `.pos`                                                              |
| -------------- | ------------ | ----------------------------------------------------------------------- |
| `LexError`     | `lexer.ts`   | yes (offending character)                                               |
| `ParseError`   | `parser.ts`  | yes (offending token)                                                   |
| `CodegenError` | `codegen.ts` | yes (forwarded from the AST node that triggered the error — every node carries `pos` populated by the parser) |
| `FunctionInputError` | `parser.ts` | yes (offset in the stringified arrow source)                       |
| `JsmqlInterpolationError` | `index.ts` | no (use `.slot` / `.key` — the template-tag source is split across the `strings`/`values` arrays) |

`src/index.ts` catches all these and maps them to `ValidationError` objects for `validate()`. See [docs/specs/architecture.md](../docs/specs/architecture.md#error-types) for the full mapping table.
