# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

`jsmql` is a JavaScript-subset language for writing MongoDB aggregation expressions — like SQL but for MongoDB, using JS syntax developers already know. It compiles to MQL JSON.

The primary syntax is JS: `$.age > 18`, `$.name.trim().toLowerCase()`, `$.items.map(x => x * 1.1)`. The `$op(args...)` escape hatch (direct operator form) reaches MongoDB operators that have no JavaScript equivalent (e.g. `$sampleRate(0.1)`, `$stdDevPop($.measurements)`, `$dateTrunc({ date: $.t, unit: "week" })`).

The public API is the `jsmql` callable from `src/index.ts`, carrying six properties (`jsmql.compile`, `jsmql.validate`, `jsmql.expr`, `jsmql.filter`, `jsmql.pipeline`, `jsmql.update`). The callable/properties shape (built with `Object.assign`, not a `namespace`) lives at [src/index.ts:271-284](src/index.ts:271) — see [src/CLAUDE.md](src/CLAUDE.md) for why. All entry points are polymorphic over the same three call shapes: **string** (`jsmql("…")`), **arrow** (`jsmql(({ $ }) => …)`), and **template tag** (`` jsmql`… ${value} …` ``). One line per entry; the linked doc owns the detail:

- `jsmql(input)` — parse + transpile, throws on error. → [LANGUAGE.md](docs/LANGUAGE.md)
- `jsmql.compile(fn)` — pre-compile a parameterised arrow `(params, { $, … })` → `(params) → MQL`. → [LANGUAGE.md](docs/LANGUAGE.md#parameterised-queries-jsmqlcompile), [docs/specs/function-form-params.md](docs/specs/function-form-params.md)
- `jsmql.validate(input)` — returns `{ valid, errors: ValidationError[] }` (each with a `.pos`) instead of throwing. → the `.validate()` rule in the DX section below
- `jsmql.expr(input)` — raw aggregation-expression form (no `$expr` wrap, no query translation) for a stage body or `updateOne` update doc. → [LANGUAGE.md](docs/LANGUAGE.md)
- `jsmql.filter` / `jsmql.pipeline` / `jsmql.update` — strict-shape variants that throw if the input would lower to the *other* shape (`update` also enforces the update-pipeline whitelist); each carries a `.compile` parameterised builder (`jsmql.filter.compile`, …) narrowed to its shape. → [docs/specs/strict-shape-entries.md](docs/specs/strict-shape-entries.md)
- `require("@koresar/jsmql/mongoose")(mongoose)` — mongoose plugin: patches `find` / `updateOne` / `aggregate` / … to accept jsmql source at the filter/update/pipeline slots. → [docs/specs/mongoose-plugin.md](docs/specs/mongoose-plugin.md)
- `jsmql` **CLI** — `jq`-style bin: source in (positional / `--file` / stdin), MQL JSON out; shape flags route to the matching entry. → [docs/specs/cli.md](docs/specs/cli.md)

jsmql targets both **Filters** (`db.coll.find(filter)`) and **Pipelines** (`db.coll.aggregate(pipeline)`), using the Node.js MongoDB driver's own terminology. Output shape is dispatched on the presence of a top-level `;` (no `;` → Filter, any `;` → Pipeline). → [docs/specs/filter-mode.md](docs/specs/filter-mode.md). Open roadmap items (e.g. query-only predicate operators with no aggregation counterpart) live in [docs/DEFERRED.md](docs/DEFERRED.md).

## #0 priority: the language axioms

[docs/LANG_RULES.md](docs/LANG_RULES.md) holds the foundational language invariants — the HARD RULES (HR1–HR4) and SOFT RULES. The HARD RULES outrank every other doc, spec, and `CLAUDE.md` here and the compiler upholds them **at all times** (a build that breaks one is a bug, never a feature). Read them before any change to lexing, parsing, codegen, the operator registry, or stage lowering. On conflict, **LANG_RULES wins**: fix the conformance bug; don't weaken the rule. When you can't fix it in the same change, leave the rule stated as law and flag the divergence as tracked work.

### Verify MQL against a running MongoDB

HR3 says jsmql never knowingly emits invalid MQL — and the only way to *know* a shape is valid is to run it. A local `mongod` is the authority: **whenever there is the slightest doubt that an emitted document would actually run, execute it against the background `mongod` before trusting it** — drive the server with the `mongodb` driver (a `devDependency`), not `mongosh`: `coll.aggregate([…])` / `coll.find(filter)` / `coll.updateMany({}, update)`, or `coll.aggregate([{ $addFields: { __v: <expr> } }])` for a bare `jsmql.expr` fragment. A passing `toEqual(...)` only proves what jsmql *emits*, never that the server *accepts* it (the `$arrayToObject` and constant-only-slot bugs both hid behind green `toEqual`s for exactly this reason). If `mongod` is **not installed or not running, stop and ask the developer to install and start it** — point them at the official [MongoDB Community installation guide](https://www.mongodb.com/docs/manual/administration/install-community/) — rather than guessing whether a shape is valid. The how-to (spin-up, the `$addFields`-not-`$project` caveat, the known server-rejection traps) lives in [test/CLAUDE.md](test/CLAUDE.md). The [`verify-mql`](.claude/skills/verify-mql/SKILL.md) project skill walks this exact ritual end-to-end — pipe the `jsmql` CLI into `test/probe` (or use the MongoDB MCP) — and is the fastest way to run one.

### The MongoDB MCP plugin (`plugin:mongodb:mongodb`)

When the MongoDB MCP plugin is connected, two of its tools speed up the work here — but neither displaces the existing authorities (the pinned `vendor/mql-specifications` YAML is the SSOT for operator shapes; a running `mongod` is the only proof a shape is valid):

- **`search-knowledge`** — queries MongoDB's official documentation corpus (version-pinned to a server release; no cluster connection required). Use it as a **reference cross-check** when adding/auditing operators and stages — confirm a field table, a valid enum, or a version difference against the manual. It is *secondary* to the vendor YAML: better than memory, but the registry's source of truth is still the spec YAML and the `mongod` is still what proves validity. Most relevant sources: `docs` (server manual), `node` (driver terminology jsmql mirrors), `mongoose` (the plugin), `practical-aggregations-book`.
- **`aggregate` / `find` / `aggregate-db` / `explain`** — once connected to a `mongod`, these run an emitted pipeline/filter directly against the server, a faster path for the HR3 verification above than a one-off `tmp/probe.mjs` driver script. Same caveats apply: use `$addFields` (not `$project`) for a bare `jsmql.expr` fragment; the `:27018` fixture is read-only.

The data tools (`find`/`aggregate`/`explain`/schema/write) need a connection string and are **not** connected by default — call `connect` with one the developer provides (the local `mongod`, or the read-only fixture on `:27018` after `npm run fixture:up`). Never invent a connection string. `search-knowledge` works without any connection. The plugin is a convenience layer, not a dependency: every workflow it supports still has its driver-/CLI-based fallback, so nothing breaks when it is absent.

## #1 priority: developer experience

Every decision should be evaluated through the lens of DX for the people **using** jsmql (not building it). There is no point shipping a feature if it is confusing or hard to use correctly. Concretely:

- **Error messages must be actionable.** Every error should tell the user what went wrong and, where possible, what to write instead. Vague errors like "syntax error" are not acceptable.
- **If something is not supported we throw — but the error message must guide toward an alternative solution.** A rejection is only acceptable when it tells the user what to write instead. When a JS construct has no MQL meaning in the form they used, point at the JS-idiomatic alternative that *does* work — e.g. spread in the `$op(...)` escape hatch is rejected, so the message names the JS form (`Math.min(...)` / `Math.max(...)` / `Object.assign(...)` / array spread `[...a, ...b]` / `.concat()`) or the single-array form. Never leave the user at a dead end.
- **Errors stay consistent and helpful across the surface.** When you add a new throw site, match the patterns the existing ones already use — don't invent a one-off phrasing for one error category that's worded differently from its siblings. Concretely:
  - Whenever you reject a name from a closed set (a method, a stage, a static call, an operator), build the suggestion tail with `didYouMean(name, candidates[, format])` from [src/levenshtein.ts](src/levenshtein.ts) and interpolate it into the message: `` `Unknown method '.${m}()'.${didYouMean(m, KNOWN_METHODS)}` ``. It returns `""` when nothing is close enough, so you never branch on it. The optional `format` callback spells the suggestion to match the surrounding message — default is `.foo()`; pass `(s) => \`Class.${s}\`` for statics or `(s) => s` for bare names (stages). `format` receives the matched candidate, so a scope-dependent prefix can be looked up inside it. Don't hand-roll the `closestNameTo(...) ? \` Did you mean …\` : ""` pattern — that's exactly what `didYouMean` wraps. Don't dump the whole list into the message — the suggestion is the value-add, the full list is doc material.
  - Arg-count errors name the missing/extra parameter (`.charAt(index)`, `.slice(start[, end])`, …). A bare `requires 1 argument` is not enough; the user shouldn't have to context-switch to MDN to find out what that argument is supposed to be.
  - Position-bearing errors (lexer, parser) say `at position N` in the message *and* set `.pos` for tooling. Both, not one or the other — humans read messages, tools read `.pos`.
  - `.validate()` errors must always carry a meaningful `.pos`. The `ValidationError` shape declares `.pos: number` as part of the public contract — tooling (editor integrations, the playground) uses it to underline the offending region, and `.pos = 0` as a placeholder defeats that contract. When you add a new throw site that can reach `.validate()`, thread real position information through to the error. AST nodes in [src/ast.ts](src/ast.ts) all carry `pos: number` (populated by the parser from the leading token of each construct), and `CodegenError` / `UnknownIdentifierError` / `FunctionInputError` accept a `pos` constructor parameter — pass the relevant node's `.pos` (or the surrounding `callPos`/`pos` parameter threaded into the helper). The one documented exception is `JsmqlInterpolationError` (`.pos = 0`): the template-tag form has no single source offset because text lives across the `strings`/`values` arrays. Use `.slot` / `.key` on that error class to locate the failing interpolation.
  - The lexer's friendly token names come from `TOKEN_DISPLAY` in [src/lexer.ts](src/lexer.ts). Never let an internal `TokenType` enum value leak into a user-facing string (no `Expected LParen` — say `Expected '('`).
  - Invariant violations the parser is supposed to uphold use `internalError(detail)` from [src/codegen.ts](src/codegen.ts), which prefixes the message with `jsmql internal error (please report …)`. Don't use raw `throw new CodegenError("Internal: …")` — the helper exists so unreachable-in-valid-programs errors are trivially greppable and visibly distinct from user errors.
- **Surprise should be minimised.** Behaviour that would surprise a JavaScript developer — even if technically valid — should be flagged in the docs.
- **Proactively suggest DX improvements.** If you notice a rough edge while working in this codebase, flag it as a suggestion even if it is out of scope for the current task.
- **More code = bad DX. Less code = good DX.** Output the smallest MQL document that says what the user meant. Don't add `{ $expr: … }` wrappers, `{ $literal: … }` envelopes, redundant `$cond`s, or boilerplate stages when a leaner shape works. If you find yourself wrapping the same node in tests over and over to make a feature "fit," that's the signal to add a smaller, dedicated API (`jsmql.expr` is the canonical example — `db.coll.find(jsmql(...))` returns a Filter, `db.coll.updateOne(filter, jsmql.expr(...))` returns the bare update doc, no `$expr` wrap in either site). This applies equally to the codebase itself: prefer one parametric helper over two copies that differ in one branch.

## #2 priority: strict subset of JavaScript

Every expression jsmql accepts must be valid JavaScript syntax. The pitch is "JS you already know" — a developer should be able to copy any jsmql expression into a JS file and have it parse. Different runtime meaning is fine; syntax errors are not.

**When extending the language:** if a construct you want to add would be rejected by `node --check`, do not add it. Either find a JS-syntax-equivalent way to express the feature (e.g. bracket access `$.items[0]` instead of numeric dotted segments `$.items.0`), or expose it as a `$op(...)` call — `$op` is always valid JS because it's a function name.

**Verification:** the lexer, parser, and grammar were audited against this rule when it was introduced. The one prior violation (numeric segments after `.`) was removed in favour of bracket access. If you're unsure whether a new construct violates the rule, write the construct to a file and run `node --check` on it.

## Commands

```sh
npm install        # install pinned versions from package.json (do this once)
npm test           # run all tests (vitest), including the strippable-TS smoke
npm run format     # format all files with oxfmt (always run before committing)
npm run build      # tsc → dist/
npm run smoke:dist # build, then run the dist-import smoke test

# Live-MongoDB integration suite (test/integration.test.ts) — runs jsmql's MQL
# against a dedicated, read-only mongod on :27018. See test/fixtures/CLAUDE.md.
npm run fixture:up # start + seed the fixture instance, then `npm test` exercises it
                   # (the suite self-skips when the instance is down)

# Run a single test file or a named test during development:
node_modules/.bin/vitest run test/codegen.test.ts
node_modules/.bin/vitest run -t "string context"
```

**Before every commit:** run `npm run format` then `npm test`. Both must succeed.

**Never use `npx`.** It silently downloads ad-hoc package versions on first run, which masks version drift between contributors. Always use the locally-installed binaries — `npm run <script>` (which prepends `node_modules/.bin` to PATH) or `node_modules/.bin/<binary>` directly. If a tool isn't in `devDependencies`, add it there first.

## File map

One line per file: what it owns + where the detail lives. The spec named in each row is the
single source of truth for that module's behaviour — don't restate lowering rules here (see the
SSOT rule under `## Rules`). For implementation conventions and "where do I add X", see
[src/CLAUDE.md](src/CLAUDE.md); for the spec index, [docs/CLAUDE.md](docs/CLAUDE.md).

```
src/
  ast.ts          AST node unions + the single source of truth for JS-builtin static name-sets (MATH_METHODS / OBJECT_METHODS / NUMBER_STATICS / SET_METHODS, `as const` with derived types).
  lexer.ts        Tokeniser.
  operators.ts    MongoDB operator registry — single source of truth for operator shapes.
  stages.ts       Aggregation pipeline stage registry.
  parser.ts       Recursive-descent parser → AST.
  codegen.ts      AST → MQL JSON.
  index.ts        Public API: the `jsmql` callable + its properties, polymorphic over string / arrow / template tag.
  cli.ts          The `jsmql` command-line bin (thin `jq`-style wrapper over index.ts). See docs/specs/cli.md.
  mongoose.ts     `@koresar/jsmql/mongoose` plugin. See docs/specs/mongoose-plugin.md.
  pipeline.ts     Pipeline detection + lowering (`;`-separated / bracketed / sub-pipeline forms) and the sugar-dispatch hub. See docs/specs/aggregation-stages.md (and the per-sugar specs below); src/CLAUDE.md for the dispatch-helper extension points.
  lookup-translation.ts        `$$$.<coll>.find/filter(pred)` → `$lookup`; also the shared predicate-lowering hub. See docs/specs/lookup-stage.md.
  union-translation.ts         `$$.push(args…)` → `$unionWith`. See docs/specs/union-stage.md.
  facet-translation.ts         `$ = { k: $$.filter(p), … }` → `$facet`. See docs/specs/replace-root-stage.md.
  out-translation.ts           `$$$.<coll> = …` / `$$$$.<db>.<coll> = …` → `$out`. See docs/specs/out-stage.md.
  system-stage-translation.ts  `$$.indexStats()` / `$$$$.currentOp(…)` / … → diagnostic / system source stages. See docs/specs/system-stages.md.
  stream-methods.ts            Registry of chainable array-shaped methods on a `$$ = …` RHS (plus the `.reduce` wrap forms). See docs/specs/stream-methods.md.
  callback-block.ts            The callback-block rule: a `{ … }` body on a JavaScript/lodash method is JavaScript; pipeline stages belong to `.aggregate(pipeline)` alone. See docs/specs/method-dispatch.md § Callback block bodies.
  stage-link.ts                Chained stage calls (`<stream>.$match(…)`): name/arity resolution + sub-pipeline placement rules, shared by pipeline.ts and lookup-translation.ts. See docs/specs/aggregation-stages.md.
  stage-validation.ts          Per-stage body-shape validation (literal-gated) + `$match` placement rules. See docs/specs/pipeline-validation.md.
  literal-gate.ts              Shared literal-gating helpers (litNumber/objectInfo/requireObjectBody/checkEnum/checkIntBound/…) used by both validators. See docs/specs/pipeline-validation.md § literal-gating invariant.
  operator-validation.ts       Per-operator `$op(...)` argument validation (literal-gated): arity, object keys, enums, literal types. See docs/specs/operator-validation.md.
  ops.ts          GENERATED ambient `declare global` types (`@koresar/jsmql/ops`). See docs/specs/ops-generation.md.
docs/
  LANGUAGE.md     User-facing language reference (canonical for user-visible behaviour + examples).
  specs/          Implementation specs — canonical for per-feature internals (see docs/CLAUDE.md for the index).
test/
  codegen.test.ts      Unit tests, one case per feature.
  realistic.test.ts    Full-feature compile-time examples (assert emitted MQL; referenced from README).
  integration.test.ts  Runs jsmql's MQL against a live mongod and asserts returned data (self-skips if down). See test/fixtures/CLAUDE.md.
  smoke.test.ts        Strippable-TS and built-dist invariants (spawn-based).
  fixtures/            Deterministic dataset + dedicated read-only mongod (:27018) for integration.test.ts. See test/fixtures/CLAUDE.md.
scripts/
  generate-ops.mjs              Generates src/ops.ts; runs on prebuild / pretest.
  build-cjs.mjs                 Bundles dist/cjs/*.cjs via esbuild for the `require` condition.
  merge-devlog.mjs              Auto-resolve a docs/DEVLOG.md merge conflict.
  sync-playground.mjs           Build the committed pure-ESM bundle dist/jsmql.js + generate playground.html (skeleton + realistic examples).
  hook-post-edit-realistic.sh   PostToolUse dispatcher that runs sync-playground.
```
(See [scripts/CLAUDE.md](scripts/CLAUDE.md) for build-script detail.)

## Rules

### Plans must include worked examples
Every implementation plan that touches the language surface MUST include both a
**simple** and a **complex** JSMQL input example together with its exact emitted
MQL output. Derive the MQL from the real lowering (read the code, or for existing
surface confirm it with `node src/cli.ts`), never guess it. Input→output examples
are how the developer assesses DX and feasibility — a plan without them is
incomplete.

### Single source of truth — link, don't restate
Every fact has **one** canonical home. Everywhere else is a one-line pointer (`See docs/specs/<f>.md`), never a second copy. This is what keeps doc/spec drift from happening: a behaviour change then touches the owner + the code, not six prose paragraphs that silently diverge.

| Fact type | Canonical home |
|---|---|
| Language axioms (HR1–HR4, SOFT rules) | `docs/LANG_RULES.md` |
| User-facing behaviour + examples | `docs/LANGUAGE.md` |
| Per-feature implementation detail / lowering rules | `docs/specs/<feature>.md` |
| Module invariants, "where do I add X" | `src/CLAUDE.md` |
| Operator / stage shapes | `src/operators.ts` / `src/stages.ts` |
| "Which doc to update when" governance | `docs/CLAUDE.md` |
| Historical record of changes | `docs/DEVLOG.md` (append-only — duplication there is fine) |

The rule when writing anywhere else: **if you're about to copy a paragraph that already lives in a canonical home, write one sentence and a link instead.** State each fact in exactly one place; everywhere else is a one-line pointer. **The only two surfaces where restating is allowed are `docs/DEVLOG.md` and `README.md`** — everything else (this file, `src/CLAUDE.md`, specs, code comments) links rather than copies. This file's "What this project is" and "File map" sections, and the `docs/CLAUDE.md` spec table, are **indexes** — one line + a pointer per item, not restatements. Code comments follow the same rule: a short intent header + `See docs/specs/<f>.md` (`src/stream-methods.ts` is the model); keep only inline `// why` notes that have no other home.

**Write prose future-proof — describe the invariant, not the current inventory.** Restating isn't only copying a *paragraph*; restating the *current membership of an evolving set* is the same drift, and rots faster. jsmql is pre-1.0 and its sets (recognised methods, operators, stages) change constantly, so any prose that pins down what a set holds *right now* — an inline list of supported methods/operators/stages, a count (`all N operators`), a "currently supports X, Y, Z", a version/status snapshot — is both a second copy of the code/registry SSOT and stale on the next change. Instead, state the stable **rule** and name the SSOT for the live list: write "a JavaScript method jsmql recognises (the `METHODS` registry in `src/codegen.ts`)", not "a method (`.map`, `.filter`, `.trim`)". One **illustrative** example — including an exact-output one, as the HARD RULES use — is still encouraged; a parenthetical that reads as "these are the members" is not. Cut it, or mark the single example open-ended (`e.g. .trim()`). Keep counts, versions, and "as of today" status out of prose entirely (outside `docs/DEVLOG.md` / `README.md`): a count belongs in the test that asserts it, status in `docs/DEFERRED.md`.

### No development history outside DEVLOG
**The project must read as a finished product at all times** — pre-1.0 and under active initial development, but never *visibly mid-construction*. Every file describes **what jsmql is**; only [docs/DEVLOG.md](docs/DEVLOG.md) describes **how it got here**. That file is the single historical record and the *only* place history may appear.

This binds everything else: source, code comments, specs, `docs/LANGUAGE.md`, `README.md`, test names and test comments, config, and generated artifacts. Keep out:

- **Internal planning references** — work-batch / phase / "wave" names, sprint labels, ticket or issue numbers.
- **Session or authorship narration** — "a parallel session is implementing…", "this work added…", "we then changed…", "in this pass".
- **Changelog framing** — `## Landed` sections, "*landed*", "shipped in…", "new in…", "previously rejected", "used to…", "no longer…".
- **Phantom release markers** — `v1` / `v2`, "in this release", "not in v1". Pre-1.0 there are no releases to point at; see the pre-1.0 versioning rule below.

**Rewrite, don't just delete.** When the sentence carries real information, restate it as current behaviour or as the rule — "`.reject` negates the predicate", not "`.reject` was added alongside…". When the only content *was* history, move it to `docs/DEVLOG.md` (or drop it — the git log already has it).

Two things this does **not** forbid. `docs/DEFERRED.md` and the deferral markers it tracks are forward-looking statements about the product ("this isn't supported", "we decided against this"), not history — they stay. And a `// why` comment explaining a *current* constraint is fine; it becomes history only when it narrates the change rather than the reason ("guard against X" ✅, "added this guard after X broke" ❌).

### Maintain CLAUDE.md files
Create and keep up to date a `CLAUDE.md` in every directory that contains non-trivial logic: `src/`, `docs/`, `test/`. Each one should explain the purpose of that directory and the conventions specific to it. When you add a new directory, add a `CLAUDE.md` immediately.

### Maintain specs
Every code change that affects observable behaviour must also update the relevant file in `docs/specs/`. The specs are the implementation-facing companion to the user-facing `docs/LANGUAGE.md`. See `docs/CLAUDE.md` for what each spec covers.

### Maintain README.md
Every change to library behaviour visible at the call site — new entry point, changed output shape, new operator surface, new error wording, dropped/renamed feature — must update [README.md](README.md) in the same commit. Cross-check the headline example block, the Tour section, and the Highlights bullets; if a feature you touched would no longer match what those three sections claim, fix them. The README is the first thing a new user reads and is part of the public contract, not optional reference material. **For ad-hoc output probing, reach for the `jsmql` CLI first** — `echo '<jsmql>' | node src/cli.ts [--pipeline|--expr|--update|--validate|-c]` (Node 22.18+ / 24.3+ strips TS natively — no build, no flag) is the fastest way to confirm what the library emits for a given input. Fall back to a short probe script that imports from `src/index.ts` (`node tmp/probe.mjs`) only when the CLI can't express the case — template-tag interpolation, inspecting an intermediate value, or anything that needs the JS API directly — or test against the built dist.

### Maintain docs/DEFERRED.md
[docs/DEFERRED.md](docs/DEFERRED.md) is the single source of truth for every open "not yet" / "future work" / "deferred" / "out of scope" item plus every "won't implement" decision.

**Always ask the developer's permission before adding a new DEFERRED item** — any new §A row, §B decision, or `[DEF-NNN]` tag. Deferring is a product decision (it parks work or rules it out), so it is the developer's call, not yours. Surface the proposed rejection / future-work item, explain why, and wait for an explicit yes before writing it. (Editing, splitting, or *closing* existing items as you ship them does not need permission — that's just keeping the file honest.)

Four triggers, in the order they typically arise:

**1. Before designing or planning a feature / change — read DEFERRED.md first.**
Open [docs/DEFERRED.md](docs/DEFERRED.md) and scan §A (open items) and §B (won't-implement decisions) for anything the proposed work touches. Four outcomes:
  - **Exact match in §A**: you're implementing this row. Plan the work as "ship DEF-NNN"; the row's *Why blocked* / *Success criteria* / *Effort* fields are your starting brief. Re-read the linked spec section.
  - **Adjacent match in §A**: your work overlaps with a known row but isn't exactly it. Decide whether to (a) expand scope and close the row, (b) keep them separate, or (c) split the row. Say so in the plan.
  - **Match in §B**: this was considered and decided against. Re-read the rationale before proceeding — if you still want to do the work, the plan must address why the §B reasoning no longer applies, otherwise drop the idea.
  - **No match**: you're net-new. Continue, and if the design includes any "not yet" wording (rejection sites, spec future-work bullets), allocate a fresh `DEF-NNN` ID for it in the same plan.

**2. When you add a "not yet" rejection or spec future-work bullet** — add a row to §A in the same commit. Tag every site with `[DEF-NNN]`. New phrases without a tag (and without an explicit entry in `test/deferred-allowlist.txt` with a one-line reason) make `npm test` fail.

**3. After each feature implementation — update DEFERRED.md.** This is non-optional. Before committing the feature work, walk DEFERRED.md and do whichever apply:
  - **Shipped a deferred item.** Delete the row from §A AND strip every `[DEF-NNN]` tag in the codebase in the same commit. The REVERSE / STALE-ALLOWLIST drift gates will fire if you miss either side.
  - **Partial progress on a deferred item.** Update the row's *Status* / *Attempted approaches* / *Success criteria* to reflect the new state. If you split off a sub-feature into a new row, allocate a fresh ID and reference the parent.
  - **Discovered a new rejection while implementing.** Add a new §A row with the next free `DEF-NNN` ID and tag the rejection site, same commit.
  - **Decided against a related idea during implementation.** Add a §B row capturing the rationale so future-us doesn't reconsider it blindly.
  - **Cleaned up stale doc wording.** Drop the corresponding allowlist entry from `test/deferred-allowlist.txt` in the same commit (the STALE gate forces this).

**4. When you reject a feature as "won't implement"** — add a row to §B with the rationale. No `[DEF-NNN]` tag in the codebase — §B rows are decisions, not deferred work.

Tag format: `[DEF-NNN]` — literal three-digit ID. Optional human label inside: `[DEF-005: merge]`. The drift test ([test/deferred-coverage.test.ts](test/deferred-coverage.test.ts)) enforces forward (tag→row), reverse (row→tag), untagged-marker (phrase→tag-or-allowlist), and stale-allowlist (allowlist entry must match at least one phrase) gates on every `npm test`.

### Commit conventions
Use [Conventional Commits](https://www.conventionalcommits.org/):
- `feat:` — new behaviour visible to users
- `fix:` — bug fix
- `test:` — test changes only
- `docs:` — documentation only
- `chore:` — tooling, deps, config
- `refactor:` — internal restructuring, no behaviour change

Breaking API changes must use `feat!:` or `fix!:` and must bump the major version.

**Commit hygiene — one logical change per commit.** Split unrelated changes into separate commits; keep each commit minimal and limited in scope. Don't let a governance/doc tweak ride along with a code fix, or bundle two independent fixes together. When a single behaviour change does span code + its spec + its DEVLOG entry + its tests, those belong in *one* commit (they're the same logical change); two different behaviour changes are two commits.

### Adding a new MongoDB operator
1. Verify the operator exists in `vendor/mql-specifications/definitions/expression/<name>.yaml` (or `definitions/accumulator/`). If it isn't, bump the pinned commit in `vendor/fetch-mql-specs.mjs` or add the operator to `REGISTRY_ONLY` in `test/operator-spec-coverage.test.ts` with a comment.
2. Add an entry to `OPERATORS` in `src/operators.ts` with the correct shape, a `category` from `OPERATOR_CATEGORIES`, and a one-sentence `description` lifted from the spec YAML. If the operator is accumulator-only (no expression form — valid only inside `$group` / `$setWindowFields.output`), wrap the shape factory with `acc(...)` so codegen gates it; that flag is the single source of truth, there is no separate set to update.
3. Add at least one test case in `test/codegen.test.ts`.
4. If the operator has user-visible syntax (e.g. a named convenience form), update `docs/LANGUAGE.md`.
5. Update `docs/specs/operator-registry.md` if shape semantics change. The drift-protection test (`test/operator-spec-coverage.test.ts`) will catch missing categories or descriptions.

### Adding a JS-method alias (`.foo()`)
1. Add a `case "foo"` in `generateMethodCall` (`src/codegen.ts`) with the lowering. Validate the argument count with `checkArity("foo", { sig: "...", exact|allowed|atLeast|none }, count, callPos)` — never hand-roll the `if (length …) throw` (the central formatter keeps the message wording consistent: `.foo(<sig>) <quantity>, got <N>`).
2. Add a `foo: { returns?, optional? }` entry to the `METHODS` registry (`src/codegen.ts`). Set `returns` when the result type is invariant (drives string/array/bool inference), `optional` to the receiver type for `?.`-chain neutrals. This single entry also adds `foo` to the `didYouMean` suggestion list — there are no separate Sets to update.
3. Add a test in `test/codegen.test.ts`; update `docs/specs/method-dispatch.md` and `docs/LANGUAGE.md` for user-visible syntax.

### Formatting
`oxfmt` is the only formatter. Config is in `.oxfmtrc.json` (excludes `*.md`, `dist/`, `package*.json`). Never make manual style decisions — just run `npm run format`.

### TypeScript
Strict mode stays on. No `any` without a comment explaining why it is unavoidable.

## Things the user did not explicitly ask for but matter

- **README.md** — must exist and link to `docs/LANGUAGE.md` and `test/realistic.test.ts` as the two main entry points for new users.
- **DEVLOG** — every observable change (feature, refactor, naming, doc decision) gets an entry in `docs/DEVLOG.md` in the same commit. Newest entries on top. There is no separate CHANGELOG or ROADMAP — DEVLOG is the single historical record. See the file's own header for format. Parallel sessions on different branches frequently collide on this file; when `git merge` reports a conflict on `docs/DEVLOG.md`, run `./scripts/merge-devlog.mjs` to auto-resolve (split on `---`, dedupe by `## YYYY-MM-DD — Title` heading, sort newest-first). The script stages the result; carry on with `git merge --continue`. Falls back to a normal manual conflict only when a past entry was edited differently on both sides. The [`devlog`](.claude/skills/devlog/SKILL.md) project skill captures this entry format and the merge-resolver step.
- **Pre-1.0 versioning** — the project is at `0.1.0` and the public API is not yet committed to. Do **not** introduce `v1`/`v2`/`v3`/`v4` markers in test names, spec headers, or anywhere else; those imply released versions that don't exist. When the API stabilises and we cut `1.0`, that becomes the first real version.
- **Semver** — `jsmql()`, `jsmql.compile()`, and `jsmql.validate()` input/output shapes (across all three call forms — string, arrow, template tag) are the public contract. Once we are at `1.0`, any change to those shapes is a breaking change.
- **The template-tag form of `jsmql` is first-class**, not a fallback. DX around it (good errors, correct interpolation, polymorphic detection) matters as much as the string and function forms.
- **The operator registry is the single source of truth.** Never add special-case operator handling inside the parser or codegen — it all goes through `src/operators.ts`. (Detail: [src/CLAUDE.md](src/CLAUDE.md).)
- **jsmql never invents its own `$`-prefixed operators.** Every `$`-named callable jsmql accepts maps to something that already exists in MongoDB: a real operator (reached through the `$op(...)` / direct-operator escape hatch backed by `src/operators.ts`) or a real pipeline stage (`$match(...)`, `$project(...)`, …). We do **not** mint convenience operators/pseudo-stages of our own — e.g. a `$drop(pred)` that lowered to `$match(!(pred))` will **never** be added, however handy it looks. Two reasons: (1) it fabricates a `$name` that isn't a MongoDB operator, breaking the "every `$op` is a real MongoDB op" mental model and the paste-raw-MQL-and-it-round-trips property; (2) it's a second spelling for a capability that already has one, which is exactly the "which spelling does my codebase use?" friction we reject (see `feedback_no_silent_output_drift.md`). New ergonomics belong in JS-idiomatic surface instead — a JS method (`.foo()`), or destination-visible sugar over a real stage (`$$.push(…)` → `$unionWith`, `$$$.<coll> = …` → `$out`) — never a brand-new `$foo()`.
- **`$ =` is reserved for root-replacing sugar.** When adding new sugar: if it replaces the document root it starts with `$ =` (the bare `$` *is* the replaced doc); otherwise pick a prefix that makes the destination visible (`$out` → `$$$.<coll> = …`, `$lookup` → `$$$.<coll>.find(…)`, `$unionWith` → `$$.push(…)`). Rationale + full convention: [docs/specs/replace-root-stage.md](docs/specs/replace-root-stage.md).
- **`src/` stays in TypeScript's strippable subset** so the source runs as-is on Node 22.18+ / 24.3+ (native type-stripping, no flag — unflagged in 22.18.0 LTS and in 24.3.0; stable in 25.2.0), Deno, and Bun. The full list of banned constructs and the rationale live in [`src/CLAUDE.md`](src/CLAUDE.md). The invariant is locked down by `test/smoke.test.ts`, which `npm test` runs on every change. Pair with `npm run smoke:dist` after a build to verify the published bundle still imports.
- **`playground.html` is a generated artifact — never hand-edit it.** Its hand-authored source is **`playground_skeleton.html`** (markup, CSS, behaviour — the entire UI). `scripts/sync-playground.mjs` produces two committed artifacts: (1) **`dist/jsmql.js`** — an unminified **pure-ESM** esbuild bundle of `src/index.ts` (`export { jsmql, … }`, library only, no UI/harness code), git-tracked and the one build output GitHub Pages publishes alongside the page (see `.gitignore` / `_config.yml`); and (2) **`playground.html`** — the skeleton with one region injected, the examples region (`<!-- jsmql-examples:start -->` / `<!-- jsmql-examples:end -->`), a JSON island extracted from the first `jsmql(...)` call in each top-level `describe` of `test/realistic.test.ts`. The page imports the bundle with `<script type="module"> import { jsmql } from "./dist/jsmql.js"` — so it must be served over **http(s)** (local static server / GitHub Pages); a module import won't load over `file://`. External deps: the CodeMirror CDN + the sibling `dist/jsmql.js`. **The skeleton split is deliberate:** because the script only ever writes `playground.html` (never the skeleton), changes to `src/` or `test/realistic.test.ts` can never clobber playground UI work — do UI development in the skeleton. A PostToolUse hook in `.claude/settings.json` runs the script (and `git add`s the outputs) whenever Claude Code edits `test/realistic.test.ts` **or** `playground_skeleton.html`; the script also runs as `prebuild`. `src/` edits don't trigger the hook — run `npm run sync:playground` manually after them (deliberately watcher-free). A `playground.html` merge conflict is resolved by re-running the sync against the merged skeleton.
