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
- The parser's object-style detection rule: if an operator call has **exactly one argument and that argument is an object literal**, it is `style: 'object'`. If there are multiple args (even if the first is an object), it is `style: 'positional'`. Do not change this rule without updating `docs/specs/grammar.md`.
- Field refs (`$.field`) always serialise to the string `"$field"` in MQL output. Nested paths (`$.a.b`) become `"$a.b"`.
- Unknown operators (not in the registry) fall through gracefully — see `codegen.ts:generateUnknownOperator`. This is intentional: it future-proofs the tool against new MongoDB operators.
- **mjsql is a strict subset of JavaScript syntax.** Every expression the parser accepts must also parse as JS (`node --check`). Before adding a new lexer token or parser production, write a representative input and run it through `node --check`; if JS rejects it, the construct is off-limits — find a JS-syntax-equivalent surface or expose the feature via `$op(...)`. See root `CLAUDE.md` for the full rule; the dropped numeric-segment case (`$.items.0`) is the canonical example of what this excludes.

## Extending the lexer

New token types go in the `TokenType` enum. The tokeniser is a single-pass character scanner — keep it that way. Do not add backtracking.

## Extending the parser

New syntax forms add a branch in `parseExpression()` and a dedicated `parseXxx()` method. Keep each method focused on a single grammar rule.

## Extending the codegen

New AST node types add a case in the `_generate(expr, ctx)` switch. The public export is `generate(expr)` which calls `_generate` with `EMPTY_CTX`. All recursive calls must pass `ctx` through — never call `_generate` without it. Helper functions for specific shapes stay private and file-local.

`GenerateCtx` carries two things: `lambdaParams` (set of in-scope lambda parameter names) and `reduceRemap` (maps user param names to MongoDB's fixed `$$value`/`$$this` names inside `.reduce()` bodies). Use `extendCtx(ctx, params)` to add lambda params; never mutate ctx directly.

## Error classes

| Class          | Where thrown | Has `.pos`                      |
| -------------- | ------------ | ------------------------------- |
| `LexError`     | `lexer.ts`   | yes                             |
| `ParseError`   | `parser.ts`  | yes                             |
| `CodegenError` | `codegen.ts` | no (structural, not positional) |

`src/index.ts` catches all three and maps them to `ValidationError` objects for `validate()`.
