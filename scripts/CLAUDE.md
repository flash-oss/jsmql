# scripts/ — build and developer scripts

Node scripts that run outside the published library. Each is invoked by an npm script in `package.json`, a Claude Code hook in `.claude/settings.json`, or manually by a contributor.

## Files

### `generate-ops.mjs`

Generates [`src/ops.ts`](../src/ops.ts) — the ambient-global types shipped at the `jsmql/ops` subpath — from [`src/operators.ts`](../src/operators.ts), [`src/stages.ts`](../src/stages.ts), and the vendored MongoDB MQL spec in [`vendor/mql-specifications/`](../vendor/fetch-mql-specs.mjs).

Runs as `prebuild` and `pretest`, so the committed `src/ops.ts` is always rebuilt before any tsc or vitest invocation. Also exposed as `npm run generate:ops` for ad-hoc regeneration after editing the registries.

Exports `generateOpsSource()` for the drift test in [`test/operator-spec-coverage.test.ts`](../test/operator-spec-coverage.test.ts). The CLI form writes the file and pipes it through `oxfmt`; the drift test mirrors the pipe so the comparison is whitespace-agnostic.

See [`docs/specs/ops-generation.md`](../docs/specs/ops-generation.md) for the generator's contract, input/output shape, type-mapping rules, and stable-ordering invariants.

### `sync-playground.mjs`

Regenerates `playground.html` examples from `test/realistic.test.ts`. Hook-driven: a PostToolUse hook in `.claude/settings.json` runs this script whenever Claude Code edits the test file, staging the updated playground for the next commit. Outside Claude Code, run `npm run sync:playground`.

### `merge-devlog.mjs`

Auto-resolves `git merge` conflicts on `docs/DEVLOG.md`. Splits both sides on `---`, dedupes by date+title heading, sorts newest-first, and stages the result. Run when `git merge` reports a conflict on the devlog; falls back to a manual conflict only when a past entry was edited differently on both sides.

### `hook-post-edit-realistic.sh`

PostToolUse hook dispatcher. Wired up in `.claude/settings.json` to call `sync-playground.mjs` when Claude Code's Edit/Write tool touches `test/realistic.test.ts`. Keeps the example list in `playground.html` in sync within a single commit.

## Conventions

- Scripts are `.mjs` (ESM) and may import directly from `src/*.ts` files; Node 24+'s native type-stripping handles the TS syntax without a flag.
- Each script's first paragraph (in a top-of-file comment) explains its purpose, when it runs, and how to invoke it manually.
- Scripts never use `npx` — always `node_modules/.bin/<tool>` or an npm script (the rationale lives in the root `CLAUDE.md`).
- A script that emits files into `src/` (like `generate-ops.mjs`) must produce **byte-stable output** for the drift test to compare cleanly. Sort inputs by name, avoid timestamps, and feed the result through `oxfmt` so the formatter doesn't introduce churn.
