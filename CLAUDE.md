# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

`mjsql` is a JavaScript-subset language for writing MongoDB aggregation expressions — like SQL but for MongoDB, using JS syntax developers already know. It compiles to MQL JSON.

The primary syntax is JS: `$.age > 18`, `$.name.trim().toLowerCase()`, `$.items.map(x => x * 1.1)`. The `$op(args...)` escape hatch (direct operator form) reaches MongoDB operators that have no JavaScript equivalent (e.g. `$sampleRate(0.1)`, `$stdDevPop($.measurements)`, `$dateTrunc({ date: $.t, unit: "week" })`).

The public API is three exports from `src/index.ts`:
- `mjsql(str)` — parse and transpile, throws on error
- `validate(str)` — parse and transpile, returns structured errors instead of throwing
- `mql` — template tag that JSON-serialises interpolated JS values before calling `mjsql`

## #1 priority: developer experience

Every decision should be evaluated through the lens of DX for the people **using** mjsql (not building it). There is no point shipping a feature if it is confusing or hard to use correctly. Concretely:

- **Error messages must be actionable.** Every error should tell the user what went wrong and, where possible, what to write instead. Vague errors like "syntax error" are not acceptable.
- **Surprise should be minimised.** Behaviour that would surprise a JavaScript developer — even if technically valid — should be flagged in the docs.
- **Proactively suggest DX improvements.** If you notice a rough edge while working in this codebase, flag it as a suggestion even if it is out of scope for the current task.

## #2 priority: strict subset of JavaScript

Every expression mjsql accepts must be valid JavaScript syntax. The pitch is "JS you already know" — a developer should be able to copy any mjsql expression into a JS file and have it parse. Different runtime meaning is fine; syntax errors are not.

**When extending the language:** if a construct you want to add would be rejected by `node --check`, do not add it. Either find a JS-syntax-equivalent way to express the feature (e.g. bracket access `$.items[0]` instead of numeric dotted segments `$.items.0`), or expose it as a `$op(...)` call — `$op` is always valid JS because it's a function name.

**Verification:** the lexer, parser, and grammar were audited against this rule when it was introduced. The one prior violation (numeric segments after `.`) was removed in favour of bracket access. If you're unsure whether a new construct violates the rule, write the construct to a file and run `node --check` on it.

## Commands

```sh
npm install       # install pinned versions from package.json (do this once)
npm test          # run all tests (vitest)
npm run format    # format all files with oxfmt (always run before committing)
npm run build     # tsc → dist/

# Run a single test file or a named test during development:
node_modules/.bin/vitest run test/codegen.test.ts
node_modules/.bin/vitest run -t "string context"
```

**Before every commit:** run `npm run format` then `npm test`. Both must succeed.

**Never use `npx`.** It silently downloads ad-hoc package versions on first run, which masks version drift between contributors. Always use the locally-installed binaries — `npm run <script>` (which prepends `node_modules/.bin` to PATH) or `node_modules/.bin/<binary>` directly. If a tool isn't in `devDependencies`, add it there first.

## File map

```
src/
  ast.ts          AST node union types
  lexer.ts        Tokeniser
  operators.ts    MongoDB operator registry (single source of truth for operator shapes)
  parser.ts       Recursive-descent parser → AST
  codegen.ts      AST → MQL JSON
  index.ts        Public API: mjsql(), validate(), mql
docs/
  LANGUAGE.md     User-facing language reference
  specs/          Implementation specs (see docs/CLAUDE.md)
test/
  codegen.test.ts Unit tests, one case per feature
  realistic.test.ts  Full-feature integration tests (referenced from README)
```

## Rules

### Maintain CLAUDE.md files
Create and keep up to date a `CLAUDE.md` in every directory that contains non-trivial logic: `src/`, `docs/`, `test/`. Each one should explain the purpose of that directory and the conventions specific to it. When you add a new directory, add a `CLAUDE.md` immediately.

### Maintain specs
Every code change that affects observable behaviour must also update the relevant file in `docs/specs/`. The specs are the implementation-facing companion to the user-facing `docs/LANGUAGE.md`. See `docs/CLAUDE.md` for what each spec covers.

### Commit conventions
Use [Conventional Commits](https://www.conventionalcommits.org/):
- `feat:` — new behaviour visible to users
- `fix:` — bug fix
- `test:` — test changes only
- `docs:` — documentation only
- `chore:` — tooling, deps, config
- `refactor:` — internal restructuring, no behaviour change

Breaking API changes must use `feat!:` or `fix!:` and must bump the major version.

### Adding a new MongoDB operator
1. Verify the operator exists in `vendor/mql-specifications/definitions/expression/<name>.yaml` (or `definitions/accumulator/`). If it isn't, bump the pinned commit in `vendor/fetch-mql-specs.mjs` or add the operator to `REGISTRY_ONLY` in `test/operator-spec-coverage.test.ts` with a comment.
2. Add an entry to `OPERATORS` in `src/operators.ts` with the correct shape, a `category` from `OPERATOR_CATEGORIES`, and a one-sentence `description` lifted from the spec YAML.
3. Add at least one test case in `test/codegen.test.ts`.
4. If the operator has user-visible syntax (e.g. a named convenience form), update `docs/LANGUAGE.md`.
5. Update `docs/specs/operator-registry.md` if shape semantics change. The drift-protection test (`test/operator-spec-coverage.test.ts`) will catch missing categories or descriptions.

### Formatting
`oxfmt` is the only formatter. Config is in `.oxfmtrc.json` (excludes `*.md`, `dist/`, `package*.json`). Never make manual style decisions — just run `npm run format`.

### TypeScript
Strict mode stays on. No `any` without a comment explaining why it is unavoidable.

## Things the user did not explicitly ask for but matter

- **README.md** — must exist and link to `docs/LANGUAGE.md` and `test/realistic.test.ts` as the two main entry points for new users.
- **DEVLOG** — every observable change (feature, refactor, naming, doc decision) gets an entry in `docs/DEVLOG.md` in the same commit. Newest entries on top. There is no separate CHANGELOG or ROADMAP — DEVLOG is the single historical record. See the file's own header for format.
- **Pre-1.0 versioning** — the project is at `0.1.0` and the public API is not yet committed to. Do **not** introduce `v1`/`v2`/`v3`/`v4` markers in test names, spec headers, or anywhere else; those imply released versions that don't exist. When the API stabilises and we cut `1.0`, that becomes the first real version.
- **Semver** — `mjsql()` and `validate()` return shapes and `mql` behaviour are the public contract. Once we are at `1.0`, any change to those shapes is a breaking change.
- **The `mql` template tag is first-class**, not a convenience wrapper. DX around it (good errors, correct interpolation) matters as much as `mjsql()` itself.
- **The operator registry is the single source of truth.** Never add special-case operator handling inside the parser or codegen — it all goes through `src/operators.ts`.
- **`src/` stays in TypeScript's strippable subset** so the source runs as-is on Node 24+ (native type-stripping, no flag), Deno, and Bun. The full list of banned constructs and the rationale live in [`src/CLAUDE.md`](src/CLAUDE.md). Test the invariant with `node src/index.ts` — it must run without errors.
