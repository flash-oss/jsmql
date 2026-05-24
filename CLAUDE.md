# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

`jsmql` is a JavaScript-subset language for writing MongoDB aggregation expressions — like SQL but for MongoDB, using JS syntax developers already know. It compiles to MQL JSON.

The primary syntax is JS: `$.age > 18`, `$.name.trim().toLowerCase()`, `$.items.map(x => x * 1.1)`. The `$op(args...)` escape hatch (direct operator form) reaches MongoDB operators that have no JavaScript equivalent (e.g. `$sampleRate(0.1)`, `$stdDevPop($.measurements)`, `$dateTrunc({ date: $.t, unit: "week" })`).

The public API is the `jsmql` callable from `src/index.ts`, which carries six properties (`jsmql.compile`, `jsmql.validate`, `jsmql.expr`, `jsmql.filter`, `jsmql.pipeline`, `jsmql.update`). The shape is built with `Object.assign` rather than a `namespace` declaration because `src/` stays in TypeScript's strippable subset — see [src/index.ts:271-284](src/index.ts:271).

- `jsmql(input)` — parse and transpile, throws on error. Accepts three call shapes: a **string** (`jsmql("…")`), an **arrow function** (`jsmql(($) => …)`), or a **template tag** (`` jsmql`… ${value} …` ``) which JSON-serialises interpolated JS values before parsing.
- `jsmql.compile(fn)` — pre-compile a parameterised arrow so the parse cost is paid once. The arrow uses up to a three-slot signature `(params, $, $$)`; parse-time slot classification and the binding/let name-collision rule live in [docs/specs/function-form-params.md](docs/specs/function-form-params.md). Returns a function `(params) → MQL`. See [docs/LANGUAGE.md](docs/LANGUAGE.md#parameterised-queries-jsmqlcompile) for the user-facing reference.
- `jsmql.validate(input)` — same three call shapes as `jsmql()`, returns `{ valid: boolean, errors: ValidationError[] }` instead of throwing. Each error carries a `.pos` (see the `.validate()` rule in the DX section below).
- `jsmql.expr(input)` — compile a partial / "unfinished" expression in raw aggregation-expression form. Same three input shapes as `jsmql()`. Use this when the output goes inside a Pipeline stage body (`$project`, `$addFields`, `$group`, …) or as the update document in `db.coll.updateOne(filter, update)` — anywhere a Filter wrapper would be noise. Differs from `jsmql()` only in the bare-expression branch: no `$expr` wrap, no query-document translation.
- `jsmql.filter(input)` / `jsmql.pipeline(input)` / `jsmql.update(input)` — strict-shape variants of `jsmql()` for call sites where the expected shape is fixed by the driver method. Each accepts the same three input shapes and throws an actionable error if the input would lower to the *other* shape. `jsmql.update()` additionally restricts the output to MongoDB's [aggregation-pipeline update whitelist](https://www.mongodb.com/docs/manual/reference/method/db.collection.updateOne/#update-with-aggregation-pipeline) so a misplaced `$match` / `$sort` is caught at compile time. (The function is named `update`, not `updateFilter`, even though the Node MongoDB driver types the slot as `UpdateFilter<TSchema>` — "filter" in that type name routinely tricks developers into reaching for it when they meant the *query* document. The AST node type stays `UpdateFilter`.) See [docs/specs/strict-shape-entries.md](docs/specs/strict-shape-entries.md).

jsmql targets both **Filters** (`db.coll.find(filter)`) and **Pipelines** (`db.coll.aggregate(pipeline)`), using the Node.js MongoDB driver's own terminology. The output shape is dispatched on the presence of `;` at the top level. No-`;` inputs lower to a Filter (via [src/match-translation.ts](src/match-translation.ts) — the same translator the `$match` stage uses), with anything not query-translatable riding in a top-level `$expr` residual. Any `;` flips to Pipeline mode (one stage per statement). See [docs/specs/filter-mode.md](docs/specs/filter-mode.md) for the dispatch implementation. Query-only predicate operators that have no MQL aggregation counterpart (`$elemMatch`, `$exists`, `$jsonSchema`, …) are still future work — flagged in `docs/CLAUDE.md`.

## #1 priority: developer experience

Every decision should be evaluated through the lens of DX for the people **using** jsmql (not building it). There is no point shipping a feature if it is confusing or hard to use correctly. Concretely:

- **Error messages must be actionable.** Every error should tell the user what went wrong and, where possible, what to write instead. Vague errors like "syntax error" are not acceptable.
- **Errors stay consistent and helpful across the surface.** When you add a new throw site, match the patterns the existing ones already use — don't invent a one-off phrasing for one error category that's worded differently from its siblings. Concretely:
  - Whenever you reject a name from a closed set (a method, a stage, a static call, an operator), run it through `closestNameTo` from [src/levenshtein.ts](src/levenshtein.ts) and suggest the nearest match with `Did you mean '…'?`. Don't dump the whole list into the message — the suggestion is the value-add, the full list is doc material.
  - Arg-count errors name the missing/extra parameter (`.charAt(index)`, `.slice(start[, end])`, …). A bare `requires 1 argument` is not enough; the user shouldn't have to context-switch to MDN to find out what that argument is supposed to be.
  - Position-bearing errors (lexer, parser) say `at position N` in the message *and* set `.pos` for tooling. Both, not one or the other — humans read messages, tools read `.pos`.
  - `.validate()` errors must always carry a meaningful `.pos`. The `ValidationError` shape declares `.pos: number` as part of the public contract — tooling (editor integrations, the playground) uses it to underline the offending region, and `.pos = 0` as a placeholder defeats that contract. When you add a new throw site that can reach `.validate()`, thread real position information through to the error. AST nodes in [src/ast.ts](src/ast.ts) all carry `pos: number` (populated by the parser from the leading token of each construct), and `CodegenError` / `UnknownIdentifierError` / `FunctionInputError` accept a `pos` constructor parameter — pass the relevant node's `.pos` (or the surrounding `callPos`/`pos` parameter threaded into the helper). The one documented exception is `JsmqlInterpolationError` (`.pos = 0`): the template-tag form has no single source offset because text lives across the `strings`/`values` arrays. Use `.slot` / `.key` on that error class to locate the failing interpolation.
  - The lexer's friendly token names come from `TOKEN_DISPLAY` in [src/lexer.ts](src/lexer.ts). Never let an internal `TokenType` enum value leak into a user-facing string (no `Expected LParen` — say `Expected '('`).
  - Invariant violations the parser is supposed to uphold use `internalError(detail)` from [src/codegen.ts](src/codegen.ts), which prefixes the message with `jsmql internal error (please report …)`. Don't use raw `throw new CodegenError("Internal: …")` — the helper exists so unreachable-in-valid-programs errors are trivially greppable and visibly distinct from user errors.
- **Surprise should be minimised.** Behaviour that would surprise a JavaScript developer — even if technically valid — should be flagged in the docs.
- **Proactively suggest DX improvements.** If you notice a rough edge while working in this codebase, flag it as a suggestion even if it is out of scope for the current task.
- **More code = bad DX. Less code = good DX.** Output the smallest MQL document that says what the user meant. Don't add `{ $expr: … }` wrappers, `{ $literal: … }` envelopes, redundant `$cond`s, or boilerplate stages when a leaner shape works. If you find yourself wrapping the same node in tests over and over to make a feature "fit," that's the signal to add a smaller, dedicated API (`jsmql.expr` is the canonical example — `db.coll.find(jsmql(...))` returns a Filter, `db.coll.updateOne(filter, jsmql.expr(...))` returns the bare update doc, no `$expr` wrap in either site). This applies equally to the codebase itself: prefer one parametric helper over two copies that differ in one branch.

## #2 priority: strict subset of JavaScript

Every expression jsmql accepts must be valid JavaScript syntax. The pitch is "JS you already know" — a developer should be able to copy any jsmql expression into a JS file and have it parse. Different runtime meaning is fine; syntax errors are not.

**When extending the language:** if a construct you want to add would be rejected by `node --check`, do not add it. Either find a JS-syntax-equivalent way to express the feature (e.g. bracket access `$.items[0]` instead of numeric dotted segments `$.items.0`), or expose it as a `$op(...)` call — `$op` is always valid JS because it's a function name.

**Verification:** the lexer, parser, and grammar were audited against this rule when it was introduced. The one prior violation (numeric segments after `.`) was removed in favour of bracket access. If you're unsure whether a new construct violates the rule, write the construct to a file and run `node --check` on it.

## Commands

```sh
npm install        # install pinned versions from package.json (do this once)
npm test           # run all tests (vitest), including the strippable-TS smoke
npm run format     # format all files with oxfmt (always run before committing)
npm run build      # tsc → dist/
npm run smoke:dist # build, then run the dist-import smoke test

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
  stages.ts       Aggregation pipeline stage registry
  parser.ts       Recursive-descent parser → AST
  codegen.ts      AST → MQL JSON
  index.ts        Public API: `jsmql` callable with `.compile` and `.validate` properties; all three are polymorphic over string / arrow / template tag
  ops.ts          GENERATED. Ambient `declare global` types for every stage + operator, shipped at the `@koresar/jsmql/ops` subpath. Regenerated by scripts/generate-ops.mjs on prebuild / pretest.
docs/
  LANGUAGE.md     User-facing language reference
  specs/          Implementation specs (see docs/CLAUDE.md)
test/
  codegen.test.ts    Unit tests, one case per feature
  realistic.test.ts  Full-feature integration tests (referenced from README)
  smoke.test.ts      Strippable-TS and built-dist invariants (spawn-based)
scripts/
  generate-ops.mjs              Generates src/ops.ts from OPERATORS + STAGES + vendor MQL spec; runs on prebuild / pretest
  build-cjs.mjs                 Bundles dist/cjs/{index,ops}.cjs via esbuild (Node 14 target) for the `require` condition; runs after `tsc` in `npm run build`
  merge-devlog.mjs              Auto-resolve a docs/DEVLOG.md merge conflict
  sync-playground.mjs           Bundle src/index.ts with esbuild and embed it + the realistic examples into playground.html
  hook-post-edit-realistic.sh   PostToolUse dispatcher that runs sync-playground when Claude edits realistic.test.ts
```

## Rules

### Maintain CLAUDE.md files
Create and keep up to date a `CLAUDE.md` in every directory that contains non-trivial logic: `src/`, `docs/`, `test/`. Each one should explain the purpose of that directory and the conventions specific to it. When you add a new directory, add a `CLAUDE.md` immediately.

### Maintain specs
Every code change that affects observable behaviour must also update the relevant file in `docs/specs/`. The specs are the implementation-facing companion to the user-facing `docs/LANGUAGE.md`. See `docs/CLAUDE.md` for what each spec covers.

### Maintain README.md
Every change to library behaviour visible at the call site — new entry point, changed output shape, new operator surface, new error wording, dropped/renamed feature — must update [README.md](README.md) in the same commit. Cross-check the headline example block, the Tour section, and the Highlights bullets; if a feature you touched would no longer match what those three sections claim, fix them. The README is the first thing a new user reads and is part of the public contract, not optional reference material. When in doubt, write a short probe script that imports from `src/index.ts` and run it with `node tmp/probe.mjs` (Node 22.18+ / 24.3+ strips TS natively — no flag) — or test against the built dist — to confirm the shown output still matches what the library produces.

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
- **DEVLOG** — every observable change (feature, refactor, naming, doc decision) gets an entry in `docs/DEVLOG.md` in the same commit. Newest entries on top. There is no separate CHANGELOG or ROADMAP — DEVLOG is the single historical record. See the file's own header for format. Parallel sessions on different branches frequently collide on this file; when `git merge` reports a conflict on `docs/DEVLOG.md`, run `./scripts/merge-devlog.mjs` to auto-resolve (split on `---`, dedupe by `## YYYY-MM-DD — Title` heading, sort newest-first). The script stages the result; carry on with `git merge --continue`. Falls back to a normal manual conflict only when a past entry was edited differently on both sides.
- **Pre-1.0 versioning** — the project is at `0.1.0` and the public API is not yet committed to. Do **not** introduce `v1`/`v2`/`v3`/`v4` markers in test names, spec headers, or anywhere else; those imply released versions that don't exist. When the API stabilises and we cut `1.0`, that becomes the first real version.
- **Semver** — `jsmql()`, `jsmql.compile()`, and `jsmql.validate()` input/output shapes (across all three call forms — string, arrow, template tag) are the public contract. Once we are at `1.0`, any change to those shapes is a breaking change.
- **The template-tag form of `jsmql` is first-class**, not a fallback. DX around it (good errors, correct interpolation, polymorphic detection) matters as much as the string and function forms.
- **The operator registry is the single source of truth.** Never add special-case operator handling inside the parser or codegen — it all goes through `src/operators.ts`.
- **`src/` stays in TypeScript's strippable subset** so the source runs as-is on Node 22.18+ / 24.3+ (native type-stripping, no flag — unflagged in 22.18.0 LTS and in 24.3.0; stable in 25.2.0), Deno, and Bun. The full list of banned constructs and the rationale live in [`src/CLAUDE.md`](src/CLAUDE.md). The invariant is locked down by `test/smoke.test.ts`, which `npm test` runs on every change. Pair with `npm run smoke:dist` after a build to verify the published bundle still imports.
- **`playground.html` is a self-sufficient single-file artifact.** Two regions inside it — delimited by `<!-- jsmql-bundle:start -->` / `<!-- jsmql-bundle:end -->` and `<!-- jsmql-examples:start -->` / `<!-- jsmql-examples:end -->` — are regenerated by `scripts/sync-playground.mjs`. The bundle region holds an esbuild IIFE of `src/index.ts` (exposed as `globalThis.JSMQL`); the examples region holds a JSON island extracted from the first `jsmql(...)` call in each top-level `describe` of `test/realistic.test.ts`. The only external dependency is the CodeMirror CDN. A PostToolUse hook in `.claude/settings.json` runs the script (and `git add`s the HTML) whenever Claude Code edits `test/realistic.test.ts`; the script also runs as `prebuild`. Outside Claude Code, run `npm run sync:playground` after editing src/ or the test file. Edit the file by hand only outside the two generated regions — anything inside them gets overwritten on the next sync.
