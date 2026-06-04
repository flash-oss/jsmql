# test/ — testing notes

## Test files and their purposes

### `codegen.test.ts` — unit tests

One `describe` block per feature area, one `it` per case. When you add or change anything in `src/`, add a corresponding case here. Keep cases small and focused — a failing test should immediately tell you which feature broke.

### `realistic.test.ts` — full-feature integration tests

Referenced from `README.md` as the best place for new users to see real usage. Tests here should:

- Use **realistic MongoDB aggregation scenarios** (e-commerce, analytics, content pipelines, etc.) — not toy examples.
- Exercise **as many language features as possible in a single expression**. The goal is to validate that complex, composed expressions produce correct MQL end-to-end.
- Include a comment above each test explaining the real-world intent (e.g. "// Compute discounted price based on loyalty tier").
- Cover the template-tag form of `jsmql` in at least one case.
- Cover `validate()` with a realistic invalid expression.

When a new feature ships, add at least one case to `realistic.test.ts` that uses it in a plausible real-world context.

### `smoke.test.ts` — runtime invariants vitest itself can't catch

Three cases, each spawning a real `node` process:

1. **Strippable-TS invariant.** `node src/index.ts` must run without errors. Vitest transforms TS through Vite's loader, which silently accepts `enum`, `namespace`, parameter properties, decorators, and other constructs the strippable-subset rule bans. Only the real Node stripper is authoritative — see `src/CLAUDE.md` for the full ban list.
2. **Built-dist ESM import.** When `dist/` exists (after `npm run build`), `import { jsmql } from './dist/index.js'` must resolve and produce the expected MQL for a few canonical expressions across all three call shapes (string, arrow, template tag). Skipped when `dist/` is absent so local `npm test` stays fast; run `npm run smoke:dist` to build and exercise it on demand.
3. **Built-dist CJS require.** Same expectations as the ESM case, but exercises `require('./dist/cjs/index.cjs')` — the bundle produced by `scripts/build-cjs.mjs` under the `require` condition of `package.json#exports`. The bundling step is easy to break without tsc noticing, so this is the guard that the CJS half of the dual package keeps working on Node 14+.

Smoke also has a strippable-TS check for the CLI bin (`node src/cli.ts --help`) and a dist-gated case that drives the built `dist/cjs/cli.cjs` (stdin → MQL, `--version`, shebang assertion). Do not add per-feature spot-checks here — those belong in `codegen.test.ts` or `realistic.test.ts`. Smoke covers only the runtime/packaging invariants.

### `cli.test.ts` — the `jsmql` command-line bin

Spawns `node src/cli.ts` directly (native type-stripping, no build step) and asserts on `{ status, stdout, stderr }`. Covers input sources (stdin / positional / `--file`), every output-shape flag, formatting (`-c` / `--tab` / `--indent`), `--validate` valid+invalid, jq-style params (`--arg` / `--argjson`), the `[DEF-028]` params+mode usage error, compiler-style caret rendering, and usage errors (unknown/conflicting flags). The built-bin invariants (shebang, exec bit, version `define`) live in `smoke.test.ts`, not here. See [`docs/specs/cli.md`](../docs/specs/cli.md).

### `update-filter.test.ts`, `pipeline.test.ts`, `security.test.ts`, `operator-spec-coverage.test.ts`

Topic-scoped suites: pipeline-stage handling, update-filter desugaring (the `$set`/`$unset` shape MongoDB's `db.coll.updateOne(filter, update)` takes), template-tag interpolation safety, and drift protection between `src/operators.ts` and the vendored MongoDB spec. Add to the matching file when extending those areas; create a new topic file only when an area outgrows `codegen.test.ts`.

### `literal-passthrough.test.ts`

The comprehensive guard for the `$`-string rule (`GenerateCtx.pipelineContext`): in pipeline context a `$`-prefixed string literal passes through verbatim; in `jsmql.expr` it is wrapped in `$literal`. Loops **every** operator in `OPERATORS` and **every** stage in `STAGES` so no `$op` can regress, plus a coverage meta-assertion that each op/stage is either tested or explicitly skipped-with-reason. When you add an operator or stage, this file picks it up automatically (the loops are registry-driven); add a `STAGE_CASES` row for a new stage that carries a `$`-string body, or a `STAGE_SKIP` reason otherwise.

## Never assert MQL the MongoDB server would reject

A passing `toEqual(...)` only proves jsmql *emits* a given document — **not** that MongoDB would *accept* it. The whole point of jsmql is to produce runnable MQL, so an expected value that the server rejects is a latent bug the suite is actively endorsing. When you add or change an expected MQL output, make sure the real server would run it.

**The rule:** every expected MQL in a test (the right-hand side of `toEqual`, and the output of any `jsmql(...)` you assert on) must be something `db.coll.aggregate(...)` / `find(...)` / `updateMany(...)` would accept on a real MongoDB. If you're knowingly asserting a *deliberately* invalid shape (e.g. an unknown-operator passthrough fixture, or a synthetic probe like `literal-passthrough.test.ts`'s sentinel calls), say so in a comment so it isn't mistaken for an endorsed-valid shape.

**How to check when unsure.** A local server is the authority (`mongod` + the `mongodb` driver are available in this repo's toolchain). Spin up a throwaway `mongod`, then for each output run `coll.aggregate(pipeline)`, `coll.find(filter)`, `coll.updateMany({}, update)`, or — for a bare `jsmql.expr` fragment — `coll.aggregate([{ $addFields: { __v: <expr> } }])` (use `$addFields`, **not** `$project`: `$project` reinterprets `{}`/`0`/`true` values as projection flags and yields false positives). Treat Atlas-only stages (`$search`, `$vectorSearch`, …), admin/cluster diagnostics (`$currentOp`, …), and index/topology-dependent rejections as environment limitations, not jsmql bugs.

**Known server-rejection traps to watch for** (a `toEqual` that produces any of these is a red flag):
- **`$$` variable names that don't start with a lowercase ASCII letter.** MongoDB rejects user-variable names beginning with `_`, `$`, or an uppercase letter ("starts with an invalid character for a user variable name"). Watch `$let`/`$map`/`$reduce` `as`/`vars` and `$lookup.let` keys — especially auto-derived ones (a lookup `let` named after an `_id` field, internal gensyms).
- **`$limit: 0`** — "the limit must be positive"; `$limit`/`$skip` need a positive constant integer, never `0` and never an expression/field path (`{$limit:"$n"}` is rejected).
- **Regex `options` carrying JS-only flags** — MongoDB allows only `imxs`; a `g` or `y` flag from a JS regex (`/x/g`) is rejected.
- **A literal array where an operator expects a single array argument** — e.g. `{$arrayToObject:[[k,v],[k,v]]}` is read as two args; such values need a `$literal` wrap.
- **A field/expression where the server requires a compile-time constant** — `$bucket.boundaries`, `$limit`, `$sample.size`, `$lookup.pipeline`, date-typed operator inputs, etc.

When you fix a bug in this class, add the offending shape to `literal-passthrough.test.ts` (or the relevant topic suite) as a guard so it can't regress.

## Running tests

```sh
npm test           # run once
npm run test:watch # watch mode during development
```

Tests must pass on every commit. Never disable or skip a test to make CI green — fix the underlying issue.
