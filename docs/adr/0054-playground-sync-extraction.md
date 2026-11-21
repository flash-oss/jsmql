# 0054. How the playground sync loads, formats and stamps the examples

Status: Accepted
Applies to: `scripts/sync-playground.mjs`, `playground_skeleton.html`

## Context

`scripts/sync-playground.mjs` loads `test/realistic.test.ts` through a Node loader hook. The hook maps the bare `vitest` specifier to `scripts/sync-playground-vitest-shim.mjs`. The script then shows each query in the playground.

## Decision

- The script calls `register(LOADER_URL)` before any `import()` that resolves `vitest`, so before the import of the test file. A loader that registers later does not see that import.
- The script reads `playground_skeleton.html` and writes only `playground.html`. It never writes the skeleton. So a change to `src/` or to `test/realistic.test.ts` cannot destroy work on the playground UI.
- The script writes a `data-stamp` on the examples island, a short hash of the manifest. The first visit writes a session, and a restored session takes priority over the default example. Without the stamp, a returning visitor never sees a new example. The playground discards a stale session only when it holds nothing but an example, so a query that the visitor wrote stays.
- The `dedent` step handles a pipeline template that starts with a lone `[`, `{` or `(` at column 0. That line pulls the shared minimum indent down to zero. The step then treats the first line as an anchor and dedents the body lines against their own minimum. So the playground shows a 2-space pipeline, not the 6-space indent of the test file.

## Consequences

Keep the registration at the top of the module. A change to the dedent rule must keep a template with a lone opening bracket readable in the playground.
