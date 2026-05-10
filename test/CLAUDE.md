# test/ — testing notes

## Test files and their purposes

### `codegen.test.ts` — unit tests

One `describe` block per feature area, one `it` per case. When you add or change anything in `src/`, add a corresponding case here. Keep cases small and focused — a failing test should immediately tell you which feature broke.

### `realistic.test.ts` — full-feature integration tests

Referenced from `README.md` as the best place for new users to see real usage. Tests here should:

- Use **realistic MongoDB aggregation scenarios** (e-commerce, analytics, content pipelines, etc.) — not toy examples.
- Exercise **as many language features as possible in a single expression**. The goal is to validate that complex, composed expressions produce correct MQL end-to-end.
- Include a comment above each test explaining the real-world intent (e.g. "// Compute discounted price based on loyalty tier").
- Cover the `mql` template tag in at least one case.
- Cover `validate()` with a realistic invalid expression.

When a new feature ships, add at least one case to `realistic.test.ts` that uses it in a plausible real-world context.

### `smoke.test.ts` — runtime invariants vitest itself can't catch

Two cases, both spawning a real `node` process:

1. **Strippable-TS invariant.** `node src/index.ts` must run without errors. Vitest transforms TS through Vite's loader, which silently accepts `enum`, `namespace`, parameter properties, decorators, and other constructs the strippable-subset rule bans. Only the real Node stripper is authoritative — see `src/CLAUDE.md` for the full ban list.
2. **Built-dist import.** When `dist/` exists (after `npm run build`), `import { jsmql, validate, mql } from './dist/index.js'` must resolve and produce the expected MQL for a few canonical expressions. Skipped when `dist/` is absent so local `npm test` stays fast; run `npm run smoke:dist` to build and exercise it on demand.

Do not add per-feature spot-checks here — those belong in `codegen.test.ts` or `realistic.test.ts`. Smoke covers only the runtime/packaging invariants.

### `mutations.test.ts`, `pipeline.test.ts`, `security.test.ts`, `operator-spec-coverage.test.ts`

Topic-scoped suites: pipeline-stage handling, mutation desugaring, `mql` interpolation safety, and drift protection between `src/operators.ts` and the vendored MongoDB spec. Add to the matching file when extending those areas; create a new topic file only when an area outgrows `codegen.test.ts`.

## Running tests

```sh
npm test           # run once
npm run test:watch # watch mode during development
```

Tests must pass on every commit. Never disable or skip a test to make CI green — fix the underlying issue.
