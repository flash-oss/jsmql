# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

`mjsql` is a JavaScript-subset language for writing MongoDB aggregation expressions — like SQL but for MongoDB, using JS syntax developers already know. It compiles to MQL JSON.

The primary syntax is JS: `$.age > 18`, `$.name.trim().toLowerCase()`, `$.items.map(x => x * 1.1)`. The `$op(args...)` utility form is a fallback for MongoDB operators that have no JavaScript equivalent (e.g. `$sampleRate(0.1)`, `$stdDevPop($.measurements)`, `$dateTrunc({ date: $.t, unit: "week" })`).

The public API is three exports from `src/index.ts`:
- `mjsql(str)` — parse and transpile, throws on error
- `validate(str)` — parse and transpile, returns structured errors instead of throwing
- `mql` — template tag that JSON-serialises interpolated JS values before calling `mjsql`

## #1 priority: developer experience

Every decision should be evaluated through the lens of DX for the people **using** mjsql (not building it). There is no point shipping a feature if it is confusing or hard to use correctly. Concretely:

- **Error messages must be actionable.** Every error should tell the user what went wrong and, where possible, what to write instead. Vague errors like "syntax error" are not acceptable.
- **Surprise should be minimised.** Behaviour that would surprise a JavaScript developer — even if technically valid — should be flagged in the docs.
- **Proactively suggest DX improvements.** If you notice a rough edge while working in this codebase, flag it as a suggestion even if it is out of scope for the current task.

## Commands

```sh
npm test          # run all tests (vitest)
npm run format    # format all files with oxfmt (always run before committing)
npm run build     # tsc → dist/

# Run a single test file or a named test during development:
npx vitest run test/codegen.test.ts
npx vitest run -t "string context"
```

**Before every commit:** run `npm run format` then `npm test`. Both must succeed.

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
1. Add an entry to `OPERATORS` in `src/operators.ts` with the correct shape.
2. Add at least one test case in `test/codegen.test.ts`.
3. If the operator has user-visible syntax (e.g. a named convenience form), update `docs/LANGUAGE.md`.
4. Update `docs/specs/operator-registry.md`.

### Formatting
`oxfmt` is the only formatter. Config is in `.oxfmtrc.json` (excludes `*.md`, `dist/`, `package*.json`). Never make manual style decisions — just run `npm run format`.

### TypeScript
Strict mode stays on. No `any` without a comment explaining why it is unavoidable.

## Things the user did not explicitly ask for but matter

- **README.md** — must exist and link to `docs/LANGUAGE.md` and `test/realistic.test.ts` as the two main entry points for new users.
- **Changelog** — when the public API changes, add an entry to `CHANGELOG.md` (create it if absent).
- **Semver** — `mjsql()` and `validate()` return shapes and `mql` behaviour are the public contract. Any change to those shapes is a breaking change.
- **The `mql` template tag is first-class**, not a convenience wrapper. DX around it (good errors, correct interpolation) matters as much as `mjsql()` itself.
- **The operator registry is the single source of truth.** Never add special-case operator handling inside the parser or codegen — it all goes through `src/operators.ts`.
