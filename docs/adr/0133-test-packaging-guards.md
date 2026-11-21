# 0133. Packaging, site and runner guards check the published artifacts

Status: Accepted
Applies to: `test/site.test.ts`, `test/smoke.test.ts`, `vitest.config.ts`

## Context

Vitest resolves `src/` and transforms TypeScript itself. So a green `npm test` does not prove other facts. Node's own type stripper can still refuse the source, the built bundles can fail to load, and the landing page markup can fail to parse. Some guards depend on facts that the code does not show.

## Decision

- `distProblem` in `test/smoke.test.ts` compares the mtime of each `src/<x>.ts` with its `dist/<x>.js`, and the `dist/cjs/` bundles with the newest source. It skips `src/globals.ts`, because `pretest` writes that file on every run. The registry files that `globals.ts` comes from carry the mtime rule instead.
- `src/mongoose.ts` is a separate published entry, so it gets the same strippable-TS check as `src/index.ts`. Its `import type {} from "mongoose"` anchor and its `declare module "mongoose"` block are type-only, and the Node stripper drops them.
- The CLI source must also run under the stripper. The test runs `node src/cli.ts --help`, which loads every module, parses the arguments and exits with status 0.
- The CLI bundle case spawns `node dist/cjs/cli.cjs`, not the bare path, so the test does not depend on the exec bit of the file.
- The CLI writes JavaScript, not JSON. So the test reads the output as a developer reads it: it compares the printed JavaScript text.
- The `tsc` cases over mongoose types take seconds, and more when the whole suite runs beside them. The test sets a 60 s timeout, because the default budget is 5 s.
- `require()` is the primary documented call shape for the mongoose plugin. `scripts/build-cjs.mjs` promotes esbuild's default export to `module.exports = fn`. The CJS case fails when that fixup is missing, because the export is then not a function.
- `decodeEntities` in `test/site.test.ts` decodes `&amp;` last. In the other order, `&amp;gt;` becomes `>`.
- `vitest.config.ts` includes `test/**/*.test.ts` only. A copy of a suite is not the suite: a type-stripped `.js` twin, a file under `tmp/`, or a file in another worktree under `.claude/`. The pattern starts at the repository root, so it matches none of them.

## Consequences

Keep the `globals.ts` exception while `pretest` regenerates the file. Keep the mongoose default-export fixup and its test together. Keep the include pattern anchored at `test/`. Keep the entity decode order.
