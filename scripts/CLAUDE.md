# scripts/ — build and developer scripts

Node scripts that run outside the published library. Each is invoked by an npm script in `package.json`, a Claude Code hook in `.claude/settings.json`, or manually by a contributor.

## Files

### `generate-globals.mjs`

Generates [`src/globals.ts`](../src/globals.ts) — the ambient-global types shipped at the `@koresar/jsmql/globals` subpath — from [`src/operators.ts`](../src/operators.ts), [`src/stages.ts`](../src/stages.ts), and the vendored MongoDB MQL spec in [`vendor/mql-specifications/`](../vendor/fetch-mql-specs.mjs).

Runs as `prebuild` and `pretest`, so the committed `src/globals.ts` is always rebuilt before any tsc or vitest invocation. Also exposed as `npm run generate:globals` for ad-hoc regeneration after editing the registries.

Exports `generateGlobalsSource()` for the drift test in [`test/operator-spec-coverage.test.ts`](../test/operator-spec-coverage.test.ts). The CLI form writes the file and pipes it through `oxfmt`; the drift test mirrors the pipe so the comparison is whitespace-agnostic.

See [`docs/specs/globals-generation.md`](../docs/specs/globals-generation.md) for the generator's contract, input/output shape, type-mapping rules, and stable-ordering invariants.

### `sync-playground.mjs`

Produces two committed artifacts. (1) **`dist/jsmql.js`** — an unminified **pure-ESM** esbuild bundle of `src/index.ts` (`export { jsmql, … }`, library only, no UI/harness code), so it's `import`-able by Node/Deno/Bun/browsers. It's the only file checked in under `dist/` (see `.gitignore`) and the only build output GitHub Pages publishes (see `_config.yml`). (2) **`playground.html`** — generated from `playground_skeleton.html` by injecting one region, a JSON island of realistic examples extracted from `test/realistic.test.ts`. The page imports the bundle via `<script type="module"> import { jsmql } from "./dist/jsmql.js"`, so it must be **served over http(s)** (local static server / GitHub Pages) — a module import won't load over `file://`. External deps: the CodeMirror CDN + the sibling `dist/jsmql.js`.

The injected `<script id="examples-data">` carries a `data-stamp` attribute — a short sha256 of the manifest, so it changes when and only when an example's slug, title, query or metadata does. The playground stores it with each saved session and discards a session written against a different stamp **only when that session holds nothing but an example**; a query the visitor wrote is always kept. Without it a returning visitor never sees a newly shipped example, because the very first visit writes a session and a restored session outranks the default example. The rule lives beside `staleExampleSession` in the skeleton.

`playground_skeleton.html` is the hand-authored UI source (markup, CSS, behaviour); the examples region sits empty between its markers there, with no stamp — so `EXAMPLES_STAMP` reads `""` until generation. `playground.html` is a **pure build artifact** — never hand-edit it; edit the skeleton and re-run the sync. Because the script reads the skeleton and only ever writes `playground.html` (never the skeleton), changes to `src/` or `test/realistic.test.ts` can never clobber playground UI work. A `playground.html` merge conflict is therefore always resolvable by re-running the sync against the merged skeleton.

Runs as `prebuild`, so `npm run build` always refreshes both artifacts. Also hook-driven: a PostToolUse hook in `.claude/settings.json` runs this script whenever Claude Code edits `test/realistic.test.ts` **or** `playground_skeleton.html`, staging the updated outputs for the next commit. `src/` edits do **not** trigger the hook (deliberately watcher-free) — run `npm run sync:playground` manually after them. Idempotent per file: each artifact is (re)written and staged only when its contents change.

### `build-cjs.mjs`

Bundles `src/index.ts`, `src/globals.ts`, `src/mongoose.ts`, and `src/cli.ts` into `dist/cjs/{index,globals,mongoose,cli}.cjs` via esbuild, targeting `node14`, so the package's `require` condition resolves to a working CommonJS module. Also copies the ESM `.d.ts` files to sibling `.d.cts` files for `moduleResolution: nodenext` consumers (the `cli` entry is an executable, not an importable type, so it's excluded from that mirror loop), and drops a `dist/cjs/package.json` with `"type": "commonjs"` so Node treats the `.cjs` files as CJS regardless of the parent `"type": "module"`. The `cli` entry is the `jsmql` bin: esbuild preserves its `#!/usr/bin/env node` shebang, the build passes `define: { __JSMQL_VERSION__: <package.json version> }` to inline the version, and the script `chmod`s `dist/cjs/cli.cjs` to `0o755`. Runs as the second half of `npm run build` (after `tsc`). The CJS bundle is covered by the `dist/cjs/index.cjs loads via require()` and `dist/cjs/cli.cjs runs as the jsmql bin` cases in [`test/smoke.test.ts`](../test/smoke.test.ts).

### `merge-devlog.mjs`

Auto-resolves `git merge` conflicts on `docs/DEVLOG.md`. Splits both sides on `---`, dedupes by date+title heading, sorts newest-first, and stages the result. Run when `git merge` reports a conflict on the devlog; falls back to a manual conflict only when a past entry was edited differently on both sides.

### `hook-post-edit-realistic.sh`

PostToolUse hook dispatcher. Wired up in `.claude/settings.json` to call `sync-playground.mjs` when Claude Code's Edit/Write tool touches `test/realistic.test.ts` (the example source) or `playground_skeleton.html` (the playground UI source). Keeps the generated `playground.html` (and, since it re-runs the bundle, `dist/jsmql.js`) in sync within a single commit. (Despite the name, it dispatches on both files — kept for the stable settings.json reference.) It does **not** fire on `src/` edits — those need a manual `npm run sync:playground` to refresh `dist/jsmql.js`.

## Conventions

- Scripts are `.mjs` (ESM) and may import directly from `src/*.ts` files; Node 22.18+ / 24.3+'s native type-stripping handles the TS syntax without a flag (unflagged in 22.18.0 LTS and 24.3.0; stable in 25.2.0).
- Each script's first paragraph (in a top-of-file comment) explains its purpose, when it runs, and how to invoke it manually.
- Scripts never use `npx` — always `node_modules/.bin/<tool>` or an npm script (the rationale lives in the root `CLAUDE.md`).
- A script that emits files into `src/` (like `generate-globals.mjs`) must produce **byte-stable output** for the drift test to compare cleanly. Sort inputs by name, avoid timestamps, and feed the result through `oxfmt` so the formatter doesn't introduce churn.
