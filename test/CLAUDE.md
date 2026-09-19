# test/ — testing notes

## Test files and their purposes

Two directories hold no `*.test.ts` of their own:

- **`test/types/`** — the type-level audits. `tsc` compiles each fixture; it does not run it. A `@ts-expect-error` marks a call that the types must refuse. The compile fails if the compiler accepts that call. `registry-contracts.test.ts` and `smoke.test.ts` run these fixtures, and each names its own `tsconfig`. The contracts fixture holds the other half of each type rule in [`src/registry/CLAUDE.md`](../src/registry/CLAUDE.md).
- **`test/support/`** — helpers that the suites share. Nothing here makes an assertion.


### `realistic.test.ts` — full-feature integration tests

`README.md` points new users here as the best place to see real use. Tests here should:

- Use a realistic MongoDB aggregation scenario, for example e-commerce, analytics or a content pipeline. Do not use a toy example.
- Use as many language features as possible in one expression. This proves that a complex, composed expression produces correct MQL end to end.
- Add a comment above each test that explains the real-world intent, for example `// Compute discounted price based on loyalty tier`.
- Cover the template-tag form of `jsmql` in at least one case.
- Cover `validate()` with a realistic invalid expression.

When a new feature ships, add at least one case to `realistic.test.ts` that uses it in a plausible real-world context.

### `smoke.test.ts` — runtime invariants that vitest cannot catch

This suite has two families. Each family spawns a real `node` process:

1. **Strippable-TS invariants.** Every `src/` entry point (`src/index.ts`, `src/mongoose.ts`, `src/cli.ts`) must run under Node's own type stripper with no error. Vitest transforms TS through Vite's loader. That loader silently accepts `enum`, `namespace`, a parameter property, a decorator, and other constructs that the strippable-subset rule bans. Only the real Node stripper proves the rule. See `src/CLAUDE.md` for the full ban list.
2. **Built-dist ESM import.** When `dist/` exists (after `npm run build`), `import { jsmql } from './dist/index.js'` must resolve. It must produce the expected MQL for a few canonical expressions, across all three call shapes: string, arrow and template tag. This test skips when `dist/` is absent, so local `npm test` stays fast. Run `npm run smoke:dist` to build and to run this test on demand.
3. **Built-dist CJS require.** This test has the same expectations as the ESM case, but it uses `require('./dist/cjs/index.cjs')`. This is the bundle that `scripts/build-cjs.mjs` produces under the `require` condition of `package.json#exports`. A change can break the bundling step without a `tsc` error, so this test guards that the CJS half of the dual package still works on Node 14 and later.

Smoke also has a strippable-TS check for the CLI bin (`node src/cli.ts --help`). It has a dist-gated case that drives the built `dist/cjs/cli.cjs`: stdin to MQL, `--version`, and a shebang assertion. Do not add a per-feature spot-check here. Add it to `codegen.test.ts` or to `realistic.test.ts` instead. Smoke covers only the runtime and packaging invariants.

### `cli.test.ts` — the `jsmql` command-line bin

This suite spawns `node src/cli.ts` directly, with native type-stripping and no build step. It asserts on `{ status, stdout, stderr }`. It covers each input source (stdin, a positional argument, `--file`), every output-shape flag, and formatting (`-c`, `--tab`, `--indent`). It covers `--validate` with a valid and an invalid input. It covers a param (`--arg`, `--argjson`) combined with each output-shape flag or the `--validate` flag; each combination routes through the matching `*.compile()` builder. It covers compiler-style caret rendering and a usage error from an unknown or a conflicting flag. The built-bin invariants — the shebang, the exec bit, the version `define` — live in `smoke.test.ts`, not here. See [`docs/specs/cli.md`](../docs/specs/cli.md).

### Suites that connect to a server must report whether they connected

A live suite may report green for exactly one reason: the server is not running. This keeps `npm test` green for a contributor who has not run `npm run fixture:up`. Any other cause — a wrong password, a missing grant, a refused command — must turn the suite red.

[`test/fixtures/live.ts`](fixtures/live.ts) is the only place that holds this distinction. `liveClient()` returns null when the driver cannot reach a server at all, and it throws on every other failure. `liveUp()` answers the same question for a `describe.skipIf(!up)`. `liveClientNow()` is the non-null form, for code that already runs inside such a block. Connect through these functions. Then run the suite's own setup outside any `try`/`catch`:

```ts
beforeAll(async () => {
  client = await liveClient();
  if (client === null) return;
  const db = client.db("jsmql_my_suite");   // a name listed in SCRATCH_DBS
  await db.dropDatabase();                  // a failure here FAILS the suite
  await db.collection("t").insertMany(DOCS);
});
```

Here is why this matters. Four suites reported green for weeks while their server half never ran. The reason: `readWrite` alone cannot drop a database, and each suite read the refusal as "no server". [`test/live-suites.test.ts`](live-suites.test.ts) blocks this class of bug. It fails when a suite builds its own `MongoClient`, keeps its own reachability probe, or sets a client to null inside a `catch`.

Also state how much of the server half ran. `permutations.test.ts` asserts that every generated chain reached the server, or that none did. `fold-consistency.test.ts` asserts that at least 90% of its cases compared a fold against a server value, because a case that returns early asserts nothing. Several `compiler-*` suites carry a "ran each one, or none" case. Add the matching guard when you add a new suite. Check that the guard works: tighten it until it fails.

**Never gate a server half behind an environment variable.** A suite that reaches the server only when someone remembers to export a variable stays compile-only in every normal run. The half that catches a server rejection is the half that finds a real bug. There is one URI, in `test/fixtures/config.ts`, and no override.



### `site.test.ts` — the published site

This suite guards the landing page (`index.html`), the `CNAME` file that binds it to jsmql.js.org, and the `_config.yml` file that tells GitHub Pages what to publish. The page compiles its own examples in the reader's browser, so it can never show stale MQL. Only the JSMQL **input** can go stale. This suite extracts every example from the markup, compiles each one through the entry that its `data-mode` names, and asserts that the output shape matches the label the page shows. It also holds the Jekyll-passthrough invariant: `index.html` must have no YAML front matter and no Liquid delimiter, or the Pages build corrupts the page. See [`docs/specs/site.md`](../docs/specs/site.md). Add a landing-page example, and this suite picks it up on its own.



### `compiler-query-expr-agreement.test.ts` — the query road and the expression road

This test applies the same gate as `query-expr-agreement.test.ts`, for `src/compiler/`. `filter(src)` and `expr(src)` (under `$expr`) run over one fixture on a live `mongod`, and both must select the same document. An exception is a divergence that the language documents. Each such case lives in a `DIVERGE` table with a reason, and the test asserts that the two sides still differ. This way, a repair moves a row instead of passing silently. The suite skips itself, and reports green, when no `mongod` is reachable; the all-or-nothing coverage guard checks this. Add a row here whenever you give a name or a production a query cell.

### `compiler-js-agreement.test.ts` — the filter target against JavaScript itself

The other agreement suites compare two of jsmql's own lowerings. This suite compares one lowering with the language that JSMQL borrows its syntax from. This suite evaluates each source as JavaScript over the fixture, with `$.` read as the document. It then compares the ids that come back with the ids that the emitted query selects on a live `mongod`. It is the acceptance harness for SR2's array reading: MongoDB's query language satisfies a comparison when any element of an array satisfies it, and JavaScript never does. So a wrong shape shows here as a wrong document, not as a shape that nobody can check by eye.

Each source where JavaScript answers differently lives in a `DIVERGE` table with a reason, and the test asserts that the two sides still differ. This way, a repair moves a row instead of passing silently. Two reasons cover almost every row, and neither is an array bug. JavaScript coerces a value under a relational operator (`[2] > 1` is true), and it throws when a path walks through a missing intermediate field. The suite skips itself, and reports green, when no `mongod` is reachable; the all-or-nothing coverage guard checks this. Add a row whenever you give a name or a production a query cell.

### `compiler-update.test.ts` — the update-document target

This suite asserts each update document as MQL: a write (`$.n += 2`, `$.tags.push(x)`, `delete $.a`) and each update operator. On a live `mongod`, it applies the update with `updateMany` to one fixture document, and compares the result with what JavaScript leaves behind. The suite skips itself, and reports green, without a server; the all-or-nothing guard checks this. Add a case whenever you change `src/compiler/emit/update.ts`.

### `compiler-join.test.ts` — the join road, against the server's answers

This suite asserts every `$$$.<coll>.<chain>` shape the road emits, as MQL, and runs each one on a live `mongod` over one fixture. It compares the documents that come back with what JavaScript would answer: the ids, and the fields the pipeline added. A join hides a wrong shape best of all — the basic `localField` form and the `let`/`$expr` form both run, and they return different documents for a null value or an array. So the data comparison, not the `toEqual` check, is the gate here. The suite skips itself, and reports green, when no `mongod` is reachable; the all-or-nothing guard checks this. Add a case whenever you change `src/compiler/emit/join.ts` or the capture in `env.ts`.

### `integration.test.ts` — jsmql MQL run against a live MongoDB

This is the only suite that runs jsmql's emitted MQL on a **real** server, and asserts on the documents that come back. This closes a gap that `toEqual(<MQL>)` cannot close: that check proves what jsmql *emits*, not that `mongod` *runs* it correctly. Each case compiles a jsmql source, runs it read-only against a deterministic fixture dataset, and checks the result. Each expected value comes from a live run; nobody guesses it. This suite runs against the project's **auth-enabled `mongod` on `:27018`** — the only server this project connects to — through a server-enforced read-only user, so a test run cannot change the data. The dataset, the instance lifecycle, and the read-only design all live in [`test/fixtures/`](fixtures/CLAUDE.md). The suite **skips itself** and reports green, not a failure, when that instance is not up or not seeded, so `npm test` stays green without it. Run `npm run fixture:up` first to run this suite. This is the natural home for the "verify that it actually runs" discipline below. When in doubt about a shape, add a case here instead of trusting a green `toEqual`.

### The feature suites — `codegen`, `pipeline`, `lookup`, `stream-methods`, `match-translation`, …

There is one suite per language feature. Each suite is a corpus of JSMQL inputs, paired with the MQL the compiler emits for each one, or with the refusal the compiler raises. The **inputs** are the contract, and they rarely change. The expected MQL follows the compiler's lowering, so a deliberate change of shape is applied to a whole suite with `scripts/regen-expectations.mjs`, and reviewed as a diff (see [scripts/CLAUDE.md](../scripts/CLAUDE.md)). Do not keep a test that asserts an internal of a compiler module that no longer exists, for example an AST walker's node count or a method table's row count. A black-box test in the same suite, or the `compiler-*` and `registry-*` suites, asserts the behaviour that test guarded instead. A polarity change — an input that is now refused, or now accepted — is a behaviour change. Name it in the DEVLOG entry for the change.

## Never assert MQL that the MongoDB server rejects

A passing `toEqual(...)` proves only that jsmql *emits* a given document. It does **not** prove that MongoDB *accepts* it. The whole point of jsmql is to produce MQL that runs, so an expected value that the server rejects is a hidden bug, and the suite then endorses that bug. When you add or change an expected MQL output, check that a real server runs it.

**The rule:** a real MongoDB must accept every expected MQL in a test as `db.coll.aggregate(...)`, `find(...)` or `updateMany(...)`. This covers the right-hand side of `toEqual`, and the output of any `jsmql(...)` call you assert on. When you knowingly assert a shape that is *deliberately* invalid, for example an unknown-operator passthrough fixture, or a synthetic probe like the sentinel calls in `literal-passthrough.test.ts`, say so in a comment. This stops a reader from mistaking it for a shape the suite endorses as valid.

**How to check when unsure — `test/probe`.** The project's `:27018` server is the authority. Never use MongoDB's default port; that port carries the developer's own instance and their real work ([test/no-default-port.test.ts](no-default-port.test.ts) enforces this rule). Use the driver, **not `mongosh`**, to run MQL against it. The official Node `mongodb` driver, a `devDependency`, is what a jsmql user actually feeds MQL to. It is the faithful authority, and it returns a live BSON value rather than a JSON shadow of one. Do not hand-write a fresh `tmp/*.mjs` script for each check. Instead, pipe the MQL through the reusable runner [`test/probe`](probe). It connects to `:27018`, seeds sample documents into a scratch database, and runs the MQL. It prints what the server returned through `jsmql.stringify`, so a `Date` or an `ObjectId` in the result reads as the value it is. When the server rejects the MQL, probe prints the rejection verbatim and exits with a non-zero code. That rejection is the signal you probe for. Probe detects the MQL shape on its own: an array runs as `aggregate`; an object whose keys all start with `$` runs wrapped as `{ $addFields: { __v: … } }`; any other shape runs as `find`. Override this with `--pipeline`, `--filter`, `--expr` or `--update`. Seed data with `--doc '<json>'`. Probe composes directly with the jsmql CLI:

```sh
echo '$.age > 18'        | node src/cli.ts            | ./test/probe --doc '[{"age":20},{"age":5}]'   # filter
echo '$match($.x > 0)'   | node src/cli.ts --pipeline | ./test/probe --doc '{"x":1}'                  # pipeline
echo '$.name.trim()'     | node src/cli.ts --expr     | ./test/probe --doc '{"name":"  a  "}'         # expr fragment
./test/probe --help                                                                                  # full usage
```

Probe uses `$addFields`, **not** `$project`, for `--expr`. `$project` reads a `{}`, `0` or `true` value as a projection flag, and this gives a false positive. Write a bespoke `tmp/*.mjs` script against the driver only when probe cannot express the case, for example multi-stage seeding or a check on an intermediate value. Keep such a script **inside the repository**, so `import … from "mongodb"` resolves; a script outside the project tree fails with `ERR_MODULE_NOT_FOUND`. Treat an Atlas-only stage (`$search`, `$vectorSearch`, …), an admin or cluster diagnostic (`$currentOp`, …), and an index- or topology-dependent rejection as a limit of the environment, not a jsmql bug. The [`verify-mql`](../.claude/skills/verify-mql/SKILL.md) project skill automates this probe procedure, and the MongoDB MCP alternative.

**Known server-rejection traps** (a `toEqual` that produces one of these is a warning sign):
- **A `$$` variable name outside the `[A-Za-z0-9_]` grammar, at the start or in the body.** MongoDB rejects a user-variable name that starts with `_`, `$`, or an uppercase letter ("starts with an invalid character for a user variable name"). It also rejects a name that contains any character outside `[A-Za-z0-9_]` anywhere in the name ("contains an invalid character for a variable name: '…'"). A field name allows far more characters, for example a hyphen. So the trap is an auto-derived variable **named after a field segment**: a `$lookup.let` key derived from an outer field such as `meta["sub-id"]`, or an `as`/`vars` name in `$let`, `$map` or `$reduce`. jsmql sanitizes such a segment to `[A-Za-z0-9_]` (`sanitizeVarSegment` in `src/namespace.ts`). The value side keeps the raw field path.
- **`$limit: 0`.** The server rejects this with "the limit must be positive". `$limit` and `$skip` need a positive constant integer. Never use `0`, and never use an expression or a field path; the server rejects `{$limit:"$n"}`.
- **A regex `options` value that carries a JS-only flag.** MongoDB allows only `imxs`. It rejects a `g` or `y` flag from a JS regex, for example `/x/g`.
- **A literal array, where an operator expects one single array argument.** For example, MongoDB reads `{$arrayToObject:[[k,v],[k,v]]}` as two arguments. It also unwraps `{$arrayToObject:[[k,v]]}` to `[k,v]` and rejects it. jsmql wraps such a pairs array one level deeper, as `{$arrayToObject:[pairs]}`, so MongoDB reads it as the one argument (the row's `shape: "single"` fact, read by `operatorCall` in `src/compiler/emit/lower.ts`). The same trap hits every **positional** operator that takes one single array argument, when the operand is a literal. `{$size:[1,2]}` reads as two arguments, and `{$size:[1]}` unwraps to the scalar `1`. So `[1,2].length` needs `{$size:[[1,2]]}`. Use the `singleArrayArg` helper and the `sizeOf`, `firstOf`, `lastOf` and `reverseArrayOf` constructors in `src/registry/mql.ts`. Never write a bare `{ $size: … }` object literal; this way, a new call site cannot forget the wrap.
- **A field or an expression, where the server requires a compile-time constant.** This applies to `$bucket.boundaries`, `$limit`, `$sample.size`, `$lookup.pipeline`, and a date-typed operator input, among others.

When you fix a bug in this class, add the offending shape to `literal-passthrough.test.ts`, or to the relevant topic suite, as a guard against a regression.

## Running tests

```sh
npm test           # run once
npm run test:watch # watch mode during development

npm run fixture:up && npm test   # also run the live-MongoDB integration suite
```

Every test must pass on every commit. Never disable or skip a test to make CI green; fix the underlying problem instead. The `integration.test.ts` suite is the one exception. By design, it *self*-skips when its dedicated `mongod` is not running. See its entry above.
