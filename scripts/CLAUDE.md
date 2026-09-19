# scripts/ — build and developer scripts

Node scripts that run outside the published library. You start each script from an npm script in `package.json`, from a Claude Code hook in `.claude/settings.json`, or by hand.

## Files

### `generate-globals.mjs`

This script generates [`src/globals.ts`](../src/globals.ts). This file holds the ambient-global types shipped at the `@koresar/jsmql/globals` subpath. The script reads the registry rows in [`src/registry/names.ts`](../src/registry/names.ts) through the accessors in [`src/compiler/rows.ts`](../src/compiler/rows.ts). It also reads the vendored MongoDB MQL spec in [`vendor/mql-specifications/`](../vendor/fetch-mql-specs.mjs).

The script runs as `prebuild` and as `pretest`. So it rebuilds the committed `src/globals.ts` before every `tsc` or `vitest` run. You can also run it by hand, with `npm run generate:globals`, after you edit the registries.

The script exports `generateGlobalsSource()` for the drift test in [`test/operator-spec-coverage.test.ts`](../test/operator-spec-coverage.test.ts). The CLI form writes the file and pipes it through `oxfmt`. The drift test copies this pipe, so the comparison ignores white space differences.

See [`docs/specs/globals-generation.md`](../docs/specs/globals-generation.md) for the contract of the generator: the input and output shape, the type-mapping rules, and the stable-ordering invariants.

### `sync-playground.mjs`

This script produces two committed artifacts.

(1) **`dist/jsmql.js`** is an unminified, pure-ESM esbuild bundle of `src/index.ts` (`export { jsmql, … }`, library code only, with no UI or harness code). Node, Deno, Bun, and browsers can `import` it. It is the only file checked in under `dist/` (see `.gitignore`). It is also the only build output that GitHub Pages publishes (see `_config.yml`).

(2) **`playground.html`** comes from `playground_skeleton.html`. The script injects one region into it: a JSON island of realistic examples taken from `test/realistic.test.ts`. The page imports the bundle with `<script type="module"> import { jsmql } from "./dist/jsmql.js"`. So you must serve it over http or https, from a local static server or from GitHub Pages — a module import does not load over `file://`. Its external dependencies are the CodeMirror CDN and the sibling `dist/jsmql.js`.

The injected `<script id="examples-data">` carries a `data-stamp` attribute. This is a short sha256 hash of the manifest. It changes only when an example's slug, title, query, or metadata changes.

The playground stores this stamp with each saved session. It discards a session written against a different stamp, but only when that session holds nothing but an example. It always keeps a query that the visitor wrote.

Without this stamp, a returning visitor never sees a newly shipped example. This happens because the first visit writes a session, and a restored session outranks the default example. The rule sits next to `staleExampleSession` in the skeleton.

`playground_skeleton.html` is the hand-authored source of the UI: markup, CSS, and behaviour. The examples region sits empty between its markers there, with no stamp, so `EXAMPLES_STAMP` reads `""` until generation runs.

`playground.html` is a **pure build artifact**. Do not hand-edit it. Edit the skeleton, then re-run the sync.

The script reads the skeleton and writes only `playground.html`; it never writes the skeleton. So a change to `src/` or to `test/realistic.test.ts` can never destroy playground UI work. This means you can always resolve a `playground.html` merge conflict: re-run the sync against the merged skeleton.

Two sibling scripts make this extraction possible without running any test. `sync-playground-loader.mjs` is a Node module loader that remaps the bare `"vitest"` specifier. `sync-playground-vitest-shim.mjs` is the target of that remap: it records each `describe` call and each `it` call, and it captures the SOURCE of the `it` body instead of running it. So no assertion runs, and no mongod is needed.

The script runs as `prebuild`, so `npm run build` always refreshes both artifacts. A PostToolUse hook in `.claude/settings.json` also runs this script whenever Claude Code edits `test/realistic.test.ts` **or** `playground_skeleton.html`, and it stages the updated outputs for the next commit. A `src/` edit does **not** trigger the hook; this is deliberate, because the hook does not watch `src/`. Run `npm run sync:playground` by hand after such an edit. The script is idempotent per file: it writes and stages each artifact only when its contents change.

### `build-cjs.mjs`

This script bundles `src/index.ts`, `src/globals.ts`, `src/mongoose.ts`, and `src/cli.ts` into `dist/cjs/{index,globals,mongoose,cli}.cjs`. It uses esbuild and targets `node14`, so the package's `require` condition resolves to a working CommonJS module.

It also copies the ESM `.d.ts` files to sibling `.d.cts` files, for consumers with `moduleResolution: nodenext`. The `cli` entry is an executable, not an importable type, so the script excludes it from that mirror loop. The script also drops a `dist/cjs/package.json` with `"type": "commonjs"`, so Node treats the `.cjs` files as CJS even though the parent has `"type": "module"`.

The `cli` entry is the `jsmql` bin. esbuild preserves its `#!/usr/bin/env node` shebang. The build passes `define: { __JSMQL_VERSION__: <package.json version> }` to inline the version. The script also `chmod`s `dist/cjs/cli.cjs` to `0o755`.

The script runs as the second half of `npm run build`, after `tsc`. The [`test/smoke.test.ts`](../test/smoke.test.ts) suite covers the CJS bundle, in the `dist/cjs/index.cjs loads via require()` case and the `dist/cjs/cli.cjs runs as the jsmql bin` case.

### `merge-devlog.mjs`

This script resolves `git merge` conflicts on `docs/DEVLOG.md` automatically. It splits both sides on `---`. It removes duplicates by date and title heading. It sorts the entries newest first. Then it stages the result.

Run this script when `git merge` reports a conflict on the devlog. It falls back to a manual conflict only when both sides edited one past entry in different ways.

### `hook-post-edit-realistic.sh`

This is the PostToolUse hook dispatcher. `.claude/settings.json` wires it up to call `sync-playground.mjs` when the Edit tool or the Write tool of Claude Code touches `test/realistic.test.ts` (the example source) or `playground_skeleton.html` (the playground UI source). It keeps the generated `playground.html` in sync within a single commit, and it keeps `dist/jsmql.js` in sync too, because it re-runs the bundle step. Despite its name, it dispatches on both files; the name stays for a stable reference in `settings.json`. It does **not** fire on a `src/` edit. After such an edit, run `npm run sync:playground` by hand to refresh `dist/jsmql.js`.

### `regen-expectations.mjs` / `convert-expectations.mjs` / `expectations.mjs`

These two tools help reviewers work on the test suites. You run each one by hand; neither runs on a hook. They share code in `expectations.mjs`.

`regen-expectations.mjs test/<suite>.test.ts` rewrites every `expect(<call>).toEqual(<literal>)` call (and every `toStrictEqual`, `toBe`, or `toThrow(<matcher>)` call) with the answer that the working-tree compiler gives for the same call. It reads and writes through the TypeScript AST. Use it after a deliberate change to the emitted shape, where a hand edit would otherwise touch a hundred identical lines. It lists, but does not touch, any call whose polarity changed — for example, a call that now throws where it once asserted a value, or the reverse.

`convert-expectations.mjs test/<suite>.test.ts ['<keep regex>' …]` does the mechanical half of that judgment. It flips the polarity of every listed case, except a case whose source matches a KEEP pattern. A KEEP pattern marks a refusal that the suite must keep asserting.

Review both outputs as a diff before you commit them. A wrong answer regenerates just as cleanly as a right one, so the script proves only that the output matches the compiler; it never proves correctness. A running `mongod` proves correctness — see [test/CLAUDE.md](../test/CLAUDE.md).

`expectations.mjs` holds what both scripts need. This includes the suite file read as a TypeScript AST; an expression evaluated in the scope that the suite itself builds (its own top-level constants, plus the constants declared above the call in every enclosing block); `expectCall` and `literalSubject`, which recognise an assertion; and `spell`, which calls `jsmql.stringify`, so a regenerated expectation reads exactly as the CLI prints it.

`undefined` is the one value that the printer refuses, but a suite may still assert it — for example, `expect(doc.let).toEqual(undefined)` states that a key is absent. `spell` writes this value as a special case.

After the edits land, the file goes through `oxfmt`. So the formatter owns the layout, and the diff holds only the answers that changed, with no re-wrapped line that did not change.

### `check-doc-claims.mjs`

Run `node scripts/check-doc-claims.mjs [file …]`. By default it checks `README.md`, `docs/LANGUAGE.md`, `docs/LANG_RULES.md`, and every file in `docs/specs/`. It re-derives every `<jsmql source>  // → <MQL>` pair in the prose from the compiler, and it prints the pairs that disagree.

A doc example is a promise about what JSMQL emits, and prose has no test to keep it honest. This script catches a promise that the compiler stopped keeping.

This is an AUDIT tool, not a gate. It parses markdown, so it can report a false positive: a template tag that interpolates a value, a claim that shows one stage of a longer pipeline, or host code around a `jsmql(…)` call. A human must classify each report.

A claim may share its source's line (`$.a + $.b   // → { $add: … }`), or it may follow the source line. The script ignores a trailing `// note` on a claim line, a trailing comma before a closing bracket, and prose after the shape.

The source may be a quoted string, a template tag without `${…}`, or a `jsmql.stringify(<call>)` call around either form. The script holds a `jsmql.validate(…)` claim to what `validate` returns.

The script skips a claim that elides anything (`…`, `/* … */`, `<…>`), because such a claim is illustrative by design. It also skips a claim that opens on a key rather than a bracket (`let: { … }`), for the same reason.

The script prints the compiler's answer with `jsmql.stringify`, the same printer that the docs' examples use. So a claim that spells a Date or an ObjectId compares as written. On both sides, the script normalises away quoting and spacing differences.

## Conventions

- Each script is `.mjs` (ESM) and may import directly from a `src/*.ts` file. Node 22.18+ and 24.3+ strip TS syntax natively, without a flag (unflagged in 22.18.0 LTS and in 24.3.0; stable in 25.2.0).
- Each script's first paragraph (in a top-of-file comment) explains its purpose, when it runs, and how to invoke it by hand.
- No script uses `npx`. Each one uses `node_modules/.bin/<tool>` or an npm script instead. The rationale lives in the root `CLAUDE.md`.
- A script that writes files into `src/` (for example `generate-globals.mjs`) must produce **byte-stable output**, so the drift test can compare it cleanly. Sort the inputs by name. Avoid timestamps. Pass the result through `oxfmt`, so the formatter does not add churn.
