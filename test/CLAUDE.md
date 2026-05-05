# test/ — testing notes

## Two test files, two purposes

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

## Running tests

```sh
npm test           # run once
npm run test:watch # watch mode during development
```

Tests must pass on every commit. Never disable or skip a test to make CI green — fix the underlying issue.
