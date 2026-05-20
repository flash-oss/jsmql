# scripts/ — build and developer scripts

Node scripts that run outside the published library. Each is invoked by an npm script in `package.json`, a Claude Code hook in `.claude/settings.json`, or manually by a contributor.

## Files

### `generate-ops.mjs`

Generates [`src/ops.ts`](../src/ops.ts) — the ambient-global types shipped at the `@koresar/jsmql/ops` subpath — from [`src/operators.ts`](../src/operators.ts), [`src/stages.ts`](../src/stages.ts), and the vendored MongoDB MQL spec in [`vendor/mql-specifications/`](../vendor/fetch-mql-specs.mjs).

Runs as `prebuild` and `pretest`, so the committed `src/ops.ts` is always rebuilt before any tsc or vitest invocation. Also exposed as `npm run generate:ops` for ad-hoc regeneration after editing the registries.

Exports `generateOpsSource()` for the drift test in [`test/operator-spec-coverage.test.ts`](../test/operator-spec-coverage.test.ts). The CLI form writes the file and pipes it through `oxfmt`; the drift test mirrors the pipe so the comparison is whitespace-agnostic.

See [`docs/specs/ops-generation.md`](../docs/specs/ops-generation.md) for the generator's contract, input/output shape, type-mapping rules, and stable-ordering invariants.

### `sync-playground.mjs`

Regenerates the two managed regions inside `playground.html`: a minified esbuild IIFE bundle of `src/index.ts` (exposed as `globalThis.JSMQL`) and a JSON island of realistic examples extracted from `test/realistic.test.ts`. Output is the same self-sufficient file users can ship on its own — the only external dependency is the CodeMirror CDN. Runs as `prebuild`, so `npm run build` always produces a synced playground. Also hook-driven: a PostToolUse hook in `.claude/settings.json` runs this script whenever Claude Code edits the test file, staging the updated playground for the next commit. Outside Claude Code, run `npm run sync:playground` after editing src/ or the test file. Idempotent — exits 0 without writing if the file is already in sync.

### `build-cjs.mjs`

Bundles `src/index.ts` and `src/ops.ts` into `dist/cjs/{index,ops}.cjs` via esbuild, targeting `node14`, so the package's `require` condition resolves to a working CommonJS module. Also copies the ESM `.d.ts` files to sibling `.d.cts` files for `moduleResolution: nodenext` consumers, and drops a `dist/cjs/package.json` with `"type": "commonjs"` so Node treats the `.cjs` files as CJS regardless of the parent `"type": "module"`. Runs as the second half of `npm run build` (after `tsc`). The CJS bundle is covered by the `dist/cjs/index.cjs loads via require()` case in [`test/smoke.test.ts`](../test/smoke.test.ts).

### `merge-devlog.mjs`

Auto-resolves `git merge` conflicts on `docs/DEVLOG.md`. Splits both sides on `---`, dedupes by date+title heading, sorts newest-first, and stages the result. Run when `git merge` reports a conflict on the devlog; falls back to a manual conflict only when a past entry was edited differently on both sides.

### `hook-post-edit-realistic.sh`

PostToolUse hook dispatcher. Wired up in `.claude/settings.json` to call `sync-playground.mjs` when Claude Code's Edit/Write tool touches `test/realistic.test.ts`. Keeps the example list in `playground.html` in sync within a single commit.

## Conventions

- Scripts are `.mjs` (ESM) and may import directly from `src/*.ts` files; Node 22.18+ / 24.3+'s native type-stripping handles the TS syntax without a flag (unflagged in 22.18.0 LTS and 24.3.0; stable in 25.2.0).
- Each script's first paragraph (in a top-of-file comment) explains its purpose, when it runs, and how to invoke it manually.
- Scripts never use `npx` — always `node_modules/.bin/<tool>` or an npm script (the rationale lives in the root `CLAUDE.md`).
- A script that emits files into `src/` (like `generate-ops.mjs`) must produce **byte-stable output** for the drift test to compare cleanly. Sort inputs by name, avoid timestamps, and feed the result through `oxfmt` so the formatter doesn't introduce churn.
