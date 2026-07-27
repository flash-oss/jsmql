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

Spawns `node src/cli.ts` directly (native type-stripping, no build step) and asserts on `{ status, stdout, stderr }`. Covers input sources (stdin / positional / `--file`), every output-shape flag, formatting (`-c` / `--tab` / `--indent`), `--validate` valid+invalid, jq-style params (`--arg` / `--argjson`) combined with each output-shape / `--validate` flag (routed through the matching `*.compile()` builder), compiler-style caret rendering, and usage errors (unknown/conflicting flags). The built-bin invariants (shebang, exec bit, version `define`) live in `smoke.test.ts`, not here. See [`docs/specs/cli.md`](../docs/specs/cli.md).

### `update-filter.test.ts`, `pipeline.test.ts`, `security.test.ts`, `operator-spec-coverage.test.ts`

Topic-scoped suites: pipeline-stage handling, update-filter desugaring (the `$set`/`$unset` shape MongoDB's `db.coll.updateOne(filter, update)` takes), template-tag interpolation safety, and drift protection between `src/operators.ts` and the vendored MongoDB spec. Add to the matching file when extending those areas; create a new topic file only when an area outgrows `codegen.test.ts`.

### `literal-passthrough.test.ts`

The comprehensive guard for the `$`-string rule (`GenerateCtx.pipelineContext`): in pipeline context a `$`-prefixed string literal passes through verbatim; in `jsmql.expr` it is wrapped in `$literal`. Loops **every** operator in `OPERATORS` and **every** stage in `STAGES` so no `$op` can regress, plus a coverage meta-assertion that each op/stage is either tested or explicitly skipped-with-reason. When you add an operator or stage, this file picks it up automatically (the loops are registry-driven); add a `STAGE_CASES` row for a new stage that carries a `$`-string body, or a `STAGE_SKIP` reason otherwise.

### `integration.test.ts` — jsmql MQL run against a live MongoDB

The only suite that runs jsmql's emitted MQL on a **real** server and asserts on the documents that come back — closing the gap a `toEqual(<MQL>)` can't (it proves what jsmql *emits*, not that mongod *runs* it correctly). Each case compiles a jsmql source, runs it read-only against a deterministic fixture dataset, and checks the result; expected values are derived from a live run, never guessed. It runs against a **dedicated, auth-enabled mongod on `:27018`** (separate from your primary instance), with a server-enforced read-only user so a test run can't mutate the data. The dataset, the instance lifecycle, and the read-only design all live in [`test/fixtures/`](fixtures/CLAUDE.md). The suite **skips itself** (green, not failing) when that instance isn't up/seeded, so `npm test` stays green without it; run `npm run fixture:up` first to exercise it. This is the natural home for the "verify it actually runs" discipline below — when in doubt about a shape, add a case here instead of trusting a green `toEqual`.

## Never assert MQL the MongoDB server would reject

A passing `toEqual(...)` only proves jsmql *emits* a given document — **not** that MongoDB would *accept* it. The whole point of jsmql is to produce runnable MQL, so an expected value that the server rejects is a latent bug the suite is actively endorsing. When you add or change an expected MQL output, make sure the real server would run it.

**The rule:** every expected MQL in a test (the right-hand side of `toEqual`, and the output of any `jsmql(...)` you assert on) must be something `db.coll.aggregate(...)` / `find(...)` / `updateMany(...)` would accept on a real MongoDB. If you're knowingly asserting a *deliberately* invalid shape (e.g. an unknown-operator passthrough fixture, or a synthetic probe like `literal-passthrough.test.ts`'s sentinel calls), say so in a comment so it isn't mistaken for an endorsed-valid shape.

**How to check when unsure — `test/probe`.** A local server is the authority, and the driver, **not `mongosh`**, is how we drive it (the official Node `mongodb` driver — a `devDependency` — is what jsmql's users actually feed MQL to, so it's the faithful authority and round-trips JSON cleanly). Rather than hand-write a fresh `tmp/*.mjs` per check, pipe MQL through the reusable runner [`test/probe`](probe): it connects to a local `mongod`, seeds sample docs, runs the MQL, and prints the server's JSON result (a server *rejection* is printed verbatim and exits non-zero — that refusal is the signal you're probing for). The MQL shape is auto-detected (array → `aggregate`; object whose keys all start with `$` → wrapped as `{ $addFields: { __v: … } }`; otherwise → `find`); override with `--pipeline` / `--filter` / `--expr` / `--update`, seed with `--doc '<json>'`. It composes directly with the jsmql CLI:

```sh
echo '$.age > 18'        | node src/cli.ts            | ./test/probe --doc '[{"age":20},{"age":5}]'   # filter
echo '$match($.x > 0)'   | node src/cli.ts --pipeline | ./test/probe --doc '{"x":1}'                  # pipeline
echo '$.name.trim()'     | node src/cli.ts --expr     | ./test/probe --doc '{"name":"  a  "}'         # expr fragment
./test/probe --help                                                                                  # full usage
```

(Probe uses `$addFields`, **not** `$project`, for `--expr`: `$project` reinterprets `{}`/`0`/`true` values as projection flags and yields false positives.) Reach for a bespoke `tmp/*.mjs` against the driver only when probe can't express the case — multi-stage seeding, inspecting an intermediate value, etc.; keep such scripts **inside the repo** so `import … from "mongodb"` resolves (a script outside the project tree fails with `ERR_MODULE_NOT_FOUND`). Treat Atlas-only stages (`$search`, `$vectorSearch`, …), admin/cluster diagnostics (`$currentOp`, …), and index/topology-dependent rejections as environment limitations, not jsmql bugs. The [`verify-mql`](../.claude/skills/verify-mql/SKILL.md) project skill automates this probe workflow (and the MongoDB MCP alternative).

**Known server-rejection traps to watch for** (a `toEqual` that produces any of these is a red flag):
- **`$$` variable names outside the `[A-Za-z0-9_]` grammar (start OR body).** MongoDB rejects user-variable names beginning with `_`, `$`, or an uppercase letter ("starts with an invalid character for a user variable name"), AND names containing any char outside `[A-Za-z0-9_]` anywhere ("contains an invalid character for a variable name: '…'"). Field names are far more permissive (a hyphen, etc.), so an auto-derived var **named after a field segment** is the trap: `$lookup.let` keys derived from an outer field like `meta["sub-id"]`, plus `$let`/`$map`/`$reduce` `as`/`vars`. jsmql sanitizes such segments to `[A-Za-z0-9_]` (`sanitizeVarSegment` in `src/namespace.ts`); the value side keeps the raw field path.
- **`$limit: 0`** — "the limit must be positive"; `$limit`/`$skip` need a positive constant integer, never `0` and never an expression/field path (`{$limit:"$n"}` is rejected).
- **Regex `options` carrying JS-only flags** — MongoDB allows only `imxs`; a `g` or `y` flag from a JS regex (`/x/g`) is rejected.
- **A literal array where an operator expects a single array argument** — e.g. `{$arrayToObject:[[k,v],[k,v]]}` is read as two args (and even `{$arrayToObject:[[k,v]]}` is unwrapped to `[k,v]` and rejected). jsmql wraps such a pairs array one level deeper — `{$arrayToObject:[pairs]}` — so MongoDB reads it as the single argument (`arrayToObjectOfLiteralPairs` in codegen.ts).
- **A field/expression where the server requires a compile-time constant** — `$bucket.boundaries`, `$limit`, `$sample.size`, `$lookup.pipeline`, date-typed operator inputs, etc.

When you fix a bug in this class, add the offending shape to `literal-passthrough.test.ts` (or the relevant topic suite) as a guard so it can't regress.

## Running tests

```sh
npm test           # run once
npm run test:watch # watch mode during development

npm run fixture:up && npm test   # also run the live-MongoDB integration suite
```

Tests must pass on every commit. Never disable or skip a test to make CI green — fix the underlying issue. (The `integration.test.ts` suite is the one exception that *self*-skips, by design, when its dedicated mongod isn't running — see its entry above.)
