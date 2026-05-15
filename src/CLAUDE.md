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

- `src/operators.ts` is the **only** place that knows about individual operator shapes. If you find yourself writing `if (name === '$trim')` in the parser or codegen, that logic belongs in the registry instead. Each entry carries `shape`, `category` (from `OPERATOR_CATEGORIES`), and `description` (lifted from `vendor/mql-specifications/definitions/`). The drift-protection test in `test/operator-spec-coverage.test.ts` keeps the registry aligned with the official spec on every `npm test`.
- `src/ops.ts` is **generated** by `scripts/generate-ops.mjs` from `OPERATORS` + `STAGES` + the vendored MQL spec, and emits ambient `declare global` types shipped at the `@koresar/jsmql/ops` subpath. Do not edit it by hand — the drift test in `test/operator-spec-coverage.test.ts` byte-compares the committed file against fresh generator output and will fail. Run `npm run generate:ops` (or just `npm test` / `npm run build`) to refresh. See [`docs/specs/ops-generation.md`](../docs/specs/ops-generation.md).
- `src/stages.ts` is the parallel single source of truth for **aggregation pipeline stages** (the elements of a top-level pipeline array, distinct from value-position expression operators). Detection and lowering live in `src/pipeline.ts`, which `src/index.ts:compile()` invokes when the parsed root AST is a pipeline-shaped array. Stage-specific behaviour (currently only the `$match` `$expr`-wrap rule and per-stage sub-pipeline fields) lives there too — never branch on stage names from `codegen.ts`. See `docs/specs/aggregation-stages.md`.
- The parser's object-style detection rule: if an operator call has **exactly one argument and that argument is an object literal**, it is `style: 'object'`. If there are multiple args (even if the first is an object), it is `style: 'positional'`. Do not change this rule without updating `docs/specs/grammar.md`.
- Field refs (`$.field`) always serialise to the string `"$field"` in MQL output. Nested paths (`$.a.b`) become `"$a.b"`.
- Unknown operators (not in the registry) fall through gracefully — see `codegen.ts:generateUnknownOperator`. This is intentional: it future-proofs the tool against new MongoDB operators.
- **jsmql is a strict subset of JavaScript syntax.** Every expression the parser accepts must also parse as JS (`node --check`). Before adding a new lexer token or parser production, write a representative input and run it through `node --check`; if JS rejects it, the construct is off-limits — find a JS-syntax-equivalent surface or expose the feature via `$op(...)`. See root `CLAUDE.md` for the full rule; the dropped numeric-segment case (`$.items.0`) is the canonical example of what this excludes.
- **`src/` stays in TypeScript's strippable subset** — the source must run on Node 24+ via native type-stripping (no flag, no transpiler), and on Deno and Bun. Concretely: no `enum` (use `as const` objects + derived unions like `TokenType`), no `namespace`, no parameter properties in constructors (declare fields explicitly and assign in the body — see `LexError` for the canonical pattern), no decorators, no `<T>x` casts (use `x as T`), no `import =` / `export =`. Internal imports use `.ts` extensions. To smoke-check: `node src/index.ts` must execute without errors.
- **Public-API shape: a callable with attached properties, built via `Object.assign`.** `src/index.ts` exports a single `jsmql` value that is both callable (`jsmql(input)`) and carries `jsmql.compile` and `jsmql.validate` as methods. The shape is intentionally not a `namespace` — that's banned by the strippable-TS rule above. The pattern lives at [src/index.ts:271-284](index.ts): declare an explicit intersection type (`typeof dispatch & { compile: …; validate: … }`) and assemble the value with `Object.assign(dispatch, { compile, validate })`. When you add a new top-level entry point, extend it the same way; don't add a top-level named `export` for what should be a property on `jsmql`.

## Extending the lexer

New token types go in the `TokenType` `as const` object (and the derived `TokenType` type union picks them up automatically). The tokeniser is a single-pass character scanner — keep it that way. Do not add backtracking.

## Extending the parser

New syntax forms add a branch in `parseExpression()` and a dedicated `parseXxx()` method. Keep each method focused on a single grammar rule.

## Extending the codegen

New AST node types add a case in the `_generate(expr, ctx)` switch. The public export is `generate(expr)` which calls `_generate` with `EMPTY_CTX`. All recursive calls must pass `ctx` through — never call `_generate` without it. Helper functions for specific shapes stay private and file-local.

`GenerateCtx` carries two things: `lambdaParams` (set of in-scope lambda parameter names) and `reduceRemap` (maps user param names to MongoDB's fixed `$$value`/`$$this` names inside `.reduce()` bodies). Use `extendCtx(ctx, params)` to add lambda params; never mutate ctx directly.

## Error classes

| Class          | Where thrown | Has `.pos`                                                              |
| -------------- | ------------ | ----------------------------------------------------------------------- |
| `LexError`     | `lexer.ts`   | yes (offending character)                                               |
| `ParseError`   | `parser.ts`  | yes (offending token)                                                   |
| `CodegenError` | `codegen.ts` | yes (forwarded from the AST node that triggered the error — every node carries `pos` populated by the parser) |
| `FunctionInputError` | `parser.ts` | yes (offset in the stringified arrow source)                       |
| `JsmqlInterpolationError` | `index.ts` | no (use `.slot` / `.key` — the template-tag source is split across the `strings`/`values` arrays) |

`src/index.ts` catches all these and maps them to `ValidationError` objects for `validate()`. See [docs/specs/architecture.md](../docs/specs/architecture.md#error-types) for the full mapping table.
