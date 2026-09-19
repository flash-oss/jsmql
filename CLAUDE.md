# CLAUDE.md

This file gives guidance to Claude Code (claude.ai/code) for work on code in this repository.

## What this project is

JSMQL is a language for MongoDB aggregation expressions. It is a subset of JavaScript, like SQL for MongoDB, and it uses JS syntax that developers already know. It compiles to MQL JSON.

The primary syntax is JS: `$.age > 18`, `$.name.trim().toLowerCase()`, `$.items.map(x => x * 1.1)`. The `$op(args...)` escape hatch (direct operator form) reaches MongoDB operators that have no JavaScript equivalent (e.g. `$sampleRate(0.1)`, `$stdDevPop($.measurements)`, `$dateTrunc({ date: $.t, unit: "week" })`).

The public API is the `jsmql` callable from `src/index.ts`. It carries its other entry points as properties (`jsmql.compile`, `jsmql.validate`, `jsmql.expr`, `jsmql.filter`, `jsmql.pipeline`, `jsmql.update`, `jsmql.stringify`). The build uses `Object.assign` for the callable/properties shape, not a `namespace` — see the `jsmql` assembly at the foot of [src/index.ts](src/index.ts), and see [src/CLAUDE.md](src/CLAUDE.md) for the reason. Each entry point accepts the same three call shapes: **string** (`jsmql("…")`), **arrow** (`jsmql(({ $ }) => …)`), and **template tag** (`` jsmql`… ${value} …` ``). Each line below names one entry; the linked doc holds the detail:

- `jsmql(input)` — parses and transpiles the input. It throws on an error. → [LANGUAGE.md](docs/LANGUAGE.md)
- `jsmql.compile(fn)` — pre-compiles a parameterised arrow `(params, { $, … })` into `(params) → MQL`. → [LANGUAGE.md](docs/LANGUAGE.md#parameterised-queries-jsmqlcompile), [docs/specs/function-form-params.md](docs/specs/function-form-params.md)
- `jsmql.validate(input)` — returns `{ valid, errors: ValidationError[] }` (each error has a `.pos`) instead of throwing. → the `.validate()` rule in the DX section below
- `jsmql.expr(input)` — gives the raw aggregation-expression form (no `$expr` wrap, no query translation) for a stage body or an `updateOne` update document. → [LANGUAGE.md](docs/LANGUAGE.md)
- `jsmql.stringify(value[, { indent, width }])` — turns a compiled document into the JavaScript that rebuilds it, so the text pastes into mongosh or a driver script. → [docs/specs/mql-stringify.md](docs/specs/mql-stringify.md)
- `jsmql.filter` / `jsmql.pipeline` — strict-shape variants; each throws when the input would lower to the *other* shape. `jsmql.update` gives the update DOCUMENT (`{ $set, $inc, … }`, constants only) that `updateOne(filter, update)` takes. Each of the three carries a `.compile` parameterised builder (`jsmql.filter.compile`, …), narrowed to its own shape. → [docs/specs/strict-shape-entries.md](docs/specs/strict-shape-entries.md)
- `require("@koresar/jsmql/mongoose")(mongoose)` — the mongoose plugin. It patches `find` / `updateOne` / `aggregate` / … to accept JSMQL source at the filter, update, and pipeline slots. → [docs/specs/mongoose-plugin.md](docs/specs/mongoose-plugin.md)
- `jsmql` **CLI** — takes source in (positional argument, `--file`, or stdin) and gives MQL out as pasteable JavaScript. A shape flag routes the input to the matching entry. → [docs/specs/cli.md](docs/specs/cli.md)

JSMQL targets both **Filters** (`db.coll.find(filter)`) and **Pipelines** (`db.coll.aggregate(pipeline)`). It uses the terms of the Node.js MongoDB driver itself. The compiler picks the output shape by the presence of a top-level `;`: no `;` gives a Filter, any `;` gives a Pipeline. → [docs/specs/filter-mode.md](docs/specs/filter-mode.md). Open roadmap items, for example query-only predicate operators with no match in aggregation, live in [docs/DEFERRED.md](docs/DEFERRED.md).

## #0 priority: the language axioms

[docs/LANG_RULES.md](docs/LANG_RULES.md) holds the language axioms: the HARD RULES (HR1–HR4) and the SOFT RULES. The HARD RULES outrank every other document, spec, and `CLAUDE.md` file here. The compiler upholds them **at all times**; a build that breaks one has a bug, never a new feature. Read them before any change to lexing, parsing, codegen, the operator registry, or stage lowering. On a conflict, **LANG_RULES wins**: fix the conformance bug, and do not weaken the rule. When you cannot fix the bug in the same change, keep the rule stated as law and flag the gap as open work.

### Verify MQL against a running MongoDB

HR3 says JSMQL never knowingly emits invalid MQL. The only way to *know* a shape is valid is to run it. **The project's own `mongod` on `:27018` is the authority, and it is the ONLY server this project ever connects to.** MongoDB's default port carries the developer's own instance and their real work. Never read it, never write to it, and never probe it. `npm run fixture:up` starts the project's instance, and [test/no-default-port.test.ts](test/no-default-port.test.ts) fails the build when a file names the default port. Keep that instance up. **Whenever there is the slightest doubt that an emitted document would run, execute it there before you trust it.** Drive the server with the `mongodb` driver (a `devDependency`), not with `mongosh`: use `coll.aggregate([…])`, `coll.find(filter)`, `coll.updateMany({}, update)`, or, for a bare `jsmql.expr` fragment, `coll.aggregate([{ $addFields: { __v: <expr> } }])`. A passing `toEqual(...)` proves only what JSMQL *emits*; it never proves that the server *accepts* it. The `$arrayToObject` bug and the constant-only-slot bug both hid behind a green `toEqual` for this exact reason. If `mongod` is **not installed, stop and ask the developer to install it.** Point them at the official [MongoDB Community installation guide](https://www.mongodb.com/docs/manual/administration/install-community/). Do not guess whether a shape is valid, and never fall back to the developer's own instance. The how-to — the spin-up steps, the `$addFields`-not-`$project` caveat, and the known server-rejection traps — lives in [test/CLAUDE.md](test/CLAUDE.md). The [`verify-mql`](.claude/skills/verify-mql/SKILL.md) project skill walks through this exact task from start to end. It pipes the `jsmql` CLI into `test/probe`, or uses the MongoDB MCP, and is the fastest way to run one check.

### The MongoDB MCP plugin (`plugin:mongodb:mongodb`)

The MongoDB MCP plugin, when connected, speeds up the work here with two tools. Neither tool replaces the existing authorities: the pinned `vendor/mql-specifications` YAML stays the single source of truth for operator shapes, and a running `mongod` stays the only proof that a shape is valid.

- **`search-knowledge`** — queries MongoDB's official documentation set. The set is pinned to one server version, so it needs no cluster connection. Use it as a **reference cross-check** when you add or audit an operator or a stage: confirm a field table, a valid enum, or a version difference against the manual. It ranks below the vendor YAML: it beats memory, but the registry's source of truth stays the spec YAML, and `mongod` still proves validity. The most relevant sources are `docs` (the server manual), `node` (the driver terms JSMQL mirrors), `mongoose` (the plugin), and `practical-aggregations-book`.
- **`aggregate` / `find` / `aggregate-db` / `explain`** — once connected to a `mongod`, these tools run an emitted pipeline or filter directly against the server. This is a faster path for the HR3 check above than a one-off `tmp/probe.mjs` driver script. The same caveats apply: use `$addFields`, not `$project`, for a bare `jsmql.expr` fragment, and treat the `:27018` fixture as read-only.

The data tools (`find` / `aggregate` / `explain` / schema / write) need a connection string, and none connects by default. Call `connect` with the project's `:27018` instance after `npm run fixture:up`. Use the read-only identity to read the fixture data set, and the scratch identity to write; both live in [test/fixtures/config.ts](test/fixtures/config.ts). Never invent a connection string, and never connect to another server. `search-knowledge` works with no connection at all. The plugin is a convenience layer, not a dependency: every workflow it supports also has a driver-based or CLI-based path, so nothing breaks when the plugin is absent.

## #1 priority: developer experience

Judge every decision by its effect on the developer experience of the people who **use** JSMQL, not the people who build it. A feature that is confusing or hard to use correctly is not worth shipping. This is what that means in practice:

- **An error message must guide the user to a fix.** Every error must say what went wrong and, where possible, what to write instead. A vague error like "syntax error" is not acceptable.
- **A rejection must name the alternative.** When something has no support, the compiler throws, but the message must point to a way forward. When a JS construct has no meaning in MQL in the form the user wrote, name the JS-idiomatic form that does work. For example, spread in the `$op(...)` escape hatch is rejected, so the message names the working JS form: `Math.min(...)`, `Math.max(...)`, `Object.assign(...)`, array spread `[...a, ...b]`, `.concat()`, or the single-array form. Never leave the user with no next step.
- **Keep error wording consistent across the compiler.** When you add a new throw site, match the pattern of the existing ones. Do not invent a one-off phrasing for one error category that reads differently from its siblings.
  - When you reject a name from a closed set — a method, a stage, a static call, an operator — build the suggestion with `didYouMean(name, candidates[, format])` from [src/levenshtein.ts](src/levenshtein.ts), and place it in the message: `` `Unknown method '.${m}()'.${didYouMean(m, KNOWN_METHODS)}` ``. It returns `""` when no candidate is close, so the call site never needs a branch. The optional `format` callback shapes the suggestion to match the message: the default is `.foo()`; pass `(s) => \`Class.${s}\`` for a static call, or `(s) => s` for a bare name such as a stage. `format` receives the matched candidate, so a scope-dependent prefix can look itself up inside the callback. Do not hand-roll the pattern `closestNameTo(...) ? \` Did you mean …\` : ""` — `didYouMean` already wraps it. Do not list every candidate in the message; the suggestion is the useful part, and the full list belongs in a doc.
  - An arg-count error must name the missing or extra parameter, for example `.charAt(index)` or `.slice(start[, end])`. A bare `requires 1 argument` is not enough; the user should not need to check MDN to learn what the argument means.
  - A position-bearing error, from the lexer or the parser, must say `at position N` in the message AND set `.pos` for tooling. Both, not one or the other: a person reads the message, and a tool reads `.pos`.
  - A `.validate()` error must always carry a meaningful `.pos`. The `ValidationError` shape declares `.pos: number` as part of the public contract. Tooling, such as an editor integration or the playground, uses `.pos` to underline the offending region, and a placeholder `.pos = 0` breaks that contract. When you add a throw site that can reach `.validate()`, pass real position data through to the error. Each AST node in [src/registry/ast.ts](src/registry/ast.ts) carries a `pos: number`, set by the parser from the leading token of the construct. `CodegenError`, `UnknownIdentifierError`, and `FunctionInputError` each accept a `pos` constructor parameter; pass the relevant node's `.pos`, or the surrounding `pos` parameter threaded into the helper. The one documented exception is `JsmqlInterpolationError` (`.pos = 0`): the template-tag form has no single source offset, because its text spans the `strings` and `values` arrays. Use `.slot` and `.key` on that error class to find the failing interpolation instead.
  - The lexer's friendly token names come from the token table in [src/registry/tokens.ts](src/registry/tokens.ts); the parser's messages read that table. Never let an internal `TokenType` enum value reach a user-facing string. Write `Expected '('`, never `Expected LParen`.
  - For an invariant the parser must hold, use `internalError(detail)` from [src/errors.ts](src/errors.ts). It prefixes the message with `jsmql internal error (please report …)`. Do not write a raw `throw new CodegenError("Internal: …")`; the helper exists so an error unreachable from a valid program is easy to find by search, and visibly distinct from a user error.
- **Flag behaviour that would surprise a JavaScript developer.** State it in the docs, even when the behaviour is technically valid.
- **Suggest a developer-experience fix when you see one.** When you notice a rough edge in this codebase, name it as a suggestion, even when it falls outside the current task.
- **More code means worse developer experience; less code means better developer experience.** Output the smallest MQL document that carries the user's meaning. Do not add an `{ $expr: … }` wrapper, an `{ $literal: … }` envelope, a redundant `$cond`, or an extra stage when a leaner shape works. When you find yourself wrapping the same node in test after test to make a feature "fit", that is a sign to add a smaller, dedicated API instead. `jsmql.expr` is the model case: `db.coll.find(jsmql(...))` returns a Filter, and `db.coll.updateOne(filter, jsmql.expr(...))` returns the bare update document, with no `$expr` wrap at either site. The same rule applies to this codebase's own code: prefer one helper with a parameter over two copies that differ in one branch.

## #2 priority: strict subset of JavaScript

Every expression JSMQL accepts must also be valid JavaScript syntax. The pitch is "JS you already know": a developer must be able to copy any JSMQL expression into a JS file, and the file must parse. A different runtime meaning is fine; a syntax error is not.

**When you extend the language:** if `node --check` would reject a construct you want to add, do not add it. Instead, find a JS-syntax-equivalent way to write the feature — for example, bracket access `$.items[0]` in place of a numeric dotted segment `$.items.0` — or expose the feature as a `$op(...)` call. `$op` is always valid JS, because it is a function name.

**Verification:** an audit of the lexer, the parser, and the grammar checked this rule when the project adopted it. The audit found one earlier violation, a numeric segment after a dot, and the project replaced it with bracket access. When you are unsure whether a new construct breaks the rule, write the construct to a file and run `node --check` on it.

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

**Before every commit:** run `npm run format`, then run `npm test`. Both commands must pass.

**Never use `npx`.** On its first run it downloads an ad-hoc package version with no warning, and this hides a version gap between contributors. Always use a locally-installed binary instead: `npm run <script>` (which puts `node_modules/.bin` at the front of `PATH`), or `node_modules/.bin/<binary>` directly. When a tool is not in `devDependencies`, add it there first.

## File map

Each line names one file: what it owns, and where the detail lives. The spec named in each row is the
single source of truth for that module's behaviour; do not restate a lowering rule here (see the
single-source-of-truth rule under `## Rules`). For implementation conventions and "where do I add X", see
[src/CLAUDE.md](src/CLAUDE.md); for the spec index, see [docs/CLAUDE.md](docs/CLAUDE.md).

```
src/
  index.ts        The public API: the `jsmql` callable and its properties. Each one accepts a string, an arrow or a template tag. It turns the input into source and values, and the compiler's errors into `validate()` results.
  cli.ts          The `jsmql` command-line bin, a thin wrapper over index.ts. See docs/specs/cli.md.
  mongoose.ts     The `@koresar/jsmql/mongoose` plugin. See docs/specs/mongoose-plugin.md.
  errors.ts       CodegenError / UnknownIdentifierError / internalError. This module is a leaf, so a refusal needs no compiler.
  namespace.ts    The three compiler namespaces (`__jsmql` document fields, `jsmql_` correlation vars, `jsmqlXxx` expression vars).
  bson.ts         The one module that names `bson`, a peer dependency. It holds the classes jsmql builds with, and the recognition that every phase shares. See docs/specs/bson-types.md.
  stringify.ts    `jsmql.stringify` gives a compiled document as the JavaScript that rebuilds it. This is the one MQL printer. See docs/specs/mql-stringify.md.
  levenshtein.ts  `didYouMean` for every closed-set refusal.
  globals.ts      GENERATED ambient `declare global` types (`@koresar/jsmql/globals`). See docs/specs/globals-generation.md.
  registry/       THE SINGLE SOURCE OF TRUTH that the compiler reads: one row per name (names.ts), per construct (productions.ts), per lexeme (tokens.ts, keywords.ts), in one vocabulary (vocabulary.ts); pure MQL builders (mql.ts); the AST node shapes (ast.ts). See src/registry/CLAUDE.md.
  compiler/       The five phases over the registry: lex/ → parse/ → passes/ → emit/. It holds one module per pass or road, and rows.ts, the registry readers that every phase shares. The directory map is src/compiler/CLAUDE.md.
docs/
  LANGUAGE.md     The user-facing language reference. It is canonical for user-visible behaviour and for examples.
  specs/          The implementation specs. Each one is canonical for its own feature's internals. See docs/CLAUDE.md for the index.
test/
  compiler-*.test.ts   The compiler's suites, one per phase or road. Several of them compare every construct with JavaScript's own answer on a live mongod.
  codegen / pipeline / lookup / stream-methods / match-translation / …  The feature suites: JSMQL inputs with the MQL that each one emits. scripts/regen-expectations.mjs regenerates them after a shape change. See test/CLAUDE.md.
  registry-*.test.ts   The registry's audits: the type contracts, and the cross-references that no type can hold.
  realistic.test.ts    Full-feature compile-time examples. They assert the emitted MQL, the README points at them, and they are the playground's source.
  strict-api / security / error-pos / cli / mongoose / site / cross-realm   The public API's contracts. For cross-realm: a parameter value from another realm compiles to the same document.
  integration.test.ts  Runs jsmql's MQL against a live mongod and asserts the data it returns. The suite self-skips when the server is down. See test/fixtures/CLAUDE.md.
  smoke.test.ts        The strippable-TS and built-dist invariants. Each test spawns a process.
  fixtures/            A deterministic dataset and a dedicated read-only mongod (:27018) for integration.test.ts. See test/fixtures/CLAUDE.md.
scripts/
  generate-globals.mjs          Generates src/globals.ts from the registry (through src/compiler/rows.ts) and from the spec YAML. It runs on prebuild and on pretest.
  build-cjs.mjs                 Bundles dist/cjs/*.cjs with esbuild for the `require` condition.
  merge-devlog.mjs              Resolves a docs/DEVLOG.md merge conflict without help.
  regen-expectations.mjs        Rewrites a suite's expected MQL with the compiler's answers, and you review the result as a diff. convert-expectations.mjs flips the polarity of the cases it lists.
  check-doc-claims.mjs          Re-derives every `<jsmql>  // → <MQL>` pair in the prose from the compiler, and prints the pairs that disagree.
  sync-playground.mjs           Builds the committed pure-ESM bundle dist/jsmql.js, and generates playground.html from the skeleton and the realistic examples. sync-playground-loader.mjs and -vitest-shim.mjs let it read the examples without a test run.
  hook-post-edit-realistic.sh   A PostToolUse dispatcher that runs sync-playground.
```
(See [scripts/CLAUDE.md](scripts/CLAUDE.md) for build-script detail.)

## Rules

### Write in Simplified Technical English
All prose follows **ASD-STE100** — documents, code comments, test titles, error
messages, commit messages, PR text, and replies in chat. The full digest, the
official links and the banned-word table live in [docs/STE.md](docs/STE.md). The
rules that bite here:

- One idea per sentence. At most 20 words in an instruction, 25 in a description.
- Active voice. Simple present, past or future — never a continuous or perfect tense.
- No `-ing` as a verb. Write "the pass lowers X", never "lowering X" or "is responsible for lowering X".
- One word, one meaning, one part of speech. Write "because", not "since"; "use", not "utilize".
- Keep the article: "the emitter reads the row", not "emitter reads row".
- No idiom and no metaphor. "out of the box" → "immediately".
- At most three words in a noun cluster.
- A term from MQL, JavaScript, MongoDB or this compiler is a Technical Name or
  Technical Verb, and the dictionary does not restrict it.

Excluded: [docs/DEVLOG.md](docs/DEVLOG.md) history (new entries still follow the
rule), generated files, and code itself — a code block, an inline code span and a
`// →` claim pair stay exact.

### Plans must include worked examples
Every implementation plan that touches the language surface MUST give both a
**simple** and a **complex** JSMQL input example, each with its exact emitted
MQL output. Derive the MQL from the real lowering: read the code, or, for
existing surface, confirm it with `node src/cli.ts`. Never guess the MQL.
An input-to-output example is how the developer judges the design and its
feasibility. A plan with no example is incomplete.

### Single source of truth — link, do not restate
Every fact has **one** true home. Everywhere else, write a one-line pointer (`See docs/specs/<f>.md`), never a second copy. This is what stops a doc and a spec from drifting apart: a behaviour change then touches the owner and the code, not six prose paragraphs that silently disagree.

| Fact type | Canonical home |
|---|---|
| Language axioms (HR1–HR4, SOFT rules) | `docs/LANG_RULES.md` |
| User-facing behaviour + examples | `docs/LANGUAGE.md` |
| Per-feature implementation detail / lowering rules | `docs/specs/<feature>.md` |
| Module invariants, "where do I add X" | `src/CLAUDE.md` |
| Operator / stage shapes | `src/registry/names.ts` |
| "Which doc to update when" governance | `docs/CLAUDE.md` |
| Historical record of changes | `docs/DEVLOG.md` (append-only — duplication there is fine) |

The rule for every other place: **before you copy a paragraph that already has a canonical home, write one sentence and a link instead.** State each fact in exactly one place; write a one-line pointer everywhere else. **`docs/DEVLOG.md` and `README.md` are the only two surfaces where restating is allowed.** Everywhere else — this file, `src/CLAUDE.md`, a spec, a code comment — links instead of copies. This file's "What this project is" and "File map" sections, and the spec table in `docs/CLAUDE.md`, are **indexes**: one line and a pointer per item, not a restatement. A code comment follows the same rule: write a short intent header, then `See docs/specs/<f>.md` (`src/compiler/emit/statement.ts` is the model). Keep only an inline `// why` note that has no other home.

**Write prose that stays true over time; describe the rule, not today's list.** Copying a paragraph is one kind of restating; pinning down the *current members of a set that changes* is the same drift, and it goes stale faster. JSMQL is pre-1.0, so a set such as its recognised methods, operators, or stages changes often. Prose that names what a set holds *right now* — an inline list of the supported methods, operators, or stages; a count such as "all N operators"; a phrase such as "currently supports X, Y, Z"; a version or status snapshot — copies the code or the registry a second time, and goes stale at the next change. State the stable **rule** instead, and name the single source of truth for the live list. Write "a JavaScript method JSMQL recognises (the rows of `src/registry/names.ts`)", not "a method (`.map`, `.filter`, `.trim`)". One **illustrative** example stays welcome, including an exact-output example as the HARD RULES use; a parenthetical that reads as a full member list does not. Cut such a list, or mark the one example open-ended (`e.g. .trim()`). Keep a count, a version, or an "as of today" status out of prose everywhere except `docs/DEVLOG.md` and `README.md`. A count belongs in the test that checks it; a status belongs in `docs/DEFERRED.md`.

### No development history outside DEVLOG
**The project must read as a finished product at all times.** It is pre-1.0 and under active work, but it must never look *unfinished*. Every file describes **what JSMQL is**; only [docs/DEVLOG.md](docs/DEVLOG.md) describes **how it got here**. That file is the single historical record, and the *only* place history may appear.

This rule binds every other file: source, code comments, specs, `docs/LANGUAGE.md`, `README.md`, a test name or test comment, config, and a generated artifact. Keep these out:

- **An internal planning reference** — a work-batch name, a phase or "wave" name, a sprint label, a ticket or issue number.
- **Session or authorship narration** — "a parallel session implements…", "this work added…", "we then changed…", "in this pass".
- **Changelog framing** — a `## Landed` section, "*landed*", "shipped in…", "new in…", "previously rejected", "used to…", "no longer…".
- **A phantom release marker** — `v1` or `v2`, "in this release", "not in v1". Pre-1.0 has no release to point at; see the pre-1.0 versioning rule below.

**Rewrite the sentence; do not just delete it.** When the sentence carries real information, restate it as current behaviour or as a rule — write "`.reject` negates the predicate", not "`.reject` was added alongside…". When the only content was history, move it to `docs/DEVLOG.md`, or drop it, because the git log already holds it.

This rule does **not** forbid two things. `docs/DEFERRED.md` and the deferral markers it tracks state a forward-looking fact about the product, such as "this has no support yet" or "we decided against this"; that is not history, so it stays. A `// why` comment that explains a *current* constraint is also fine; it becomes history only when it narrates the change instead of the reason. Write "guard against X", not "added this guard after X broke".

### Maintain a CLAUDE.md file in each directory
Create a `CLAUDE.md` file in every directory that holds non-trivial logic — `src/`, `docs/`, `test/` — and keep each one current. Each file must explain the purpose of its directory and that directory's own conventions. When you add a new directory, add its `CLAUDE.md` file at once.

### Maintain the specs
Every code change that affects observable behaviour must also update the matching file in `docs/specs/`. Each spec is the implementation-facing companion to the user-facing `docs/LANGUAGE.md`. See `docs/CLAUDE.md` for what each spec covers.

### Maintain README.md
Every change to a behaviour a caller can see — a new entry point, a changed output shape, a new operator, new error wording, or a dropped or renamed feature — must update [README.md](README.md) in the same commit. Check the headline example block, the Tour section, and the Highlights list against the change; when a feature you touched no longer matches what those three sections claim, fix them. The README is the first thing a new user reads, and it is part of the public contract, not optional reference material. **For an ad-hoc check of what the library emits, reach for the `jsmql` CLI first.** Node 22.18+ and 24.3+ strip TypeScript on their own, with no build step and no flag, so `echo '<jsmql>' | node src/cli.ts [--pipeline|--expr|--update|--validate|-c]` is the fastest way to confirm what the library emits for a given input. Fall back to a short probe script that imports from `src/index.ts` (`node tmp/probe.mjs`) only when the CLI cannot express the case — template-tag interpolation, an intermediate value, or a case that needs the JS API directly — or when you must test against the built `dist`.

### Maintain docs/DEFERRED.md
[docs/DEFERRED.md](docs/DEFERRED.md) is the single source of truth for every open item marked "not yet", "future work", "deferred", or "out of scope", and for every "will not implement" decision.

**Always ask the developer for permission before you add a new DEFERRED item** — a new row in §A, a new decision in §B, or a new `[DEF-NNN]` tag. A deferral is a product decision: it parks work, or it rules work out. So it is the developer's call, not yours. Show the proposed rejection or future-work item, explain the reason, and wait for a clear yes before you write it. Editing, splitting, or *closing* an existing item as you ship it needs no permission; that only keeps the file honest.

Four triggers cause a DEFERRED.md update, usually in this order:

**1. Before you design or plan a feature or a change, read DEFERRED.md first.**
Open [docs/DEFERRED.md](docs/DEFERRED.md) and scan §A (open items) and §B (will-not-implement decisions) for anything the proposed work touches. There are four outcomes:
  - **An exact match in §A.** You are implementing this row. Plan the work as "ship DEF-NNN"; use the row's *Why blocked*, *Success criteria*, and *Effort* fields as your starting brief. Re-read the linked spec section.
  - **A near match in §A.** Your work overlaps a known row, but is not the same row. Decide whether to (a) widen the scope and close the row, (b) keep the two separate, or (c) split the row. State your choice in the plan.
  - **A match in §B.** The team considered this and decided against it. Re-read the rationale before you proceed. If you still want to do the work, the plan must explain why the §B reasoning no longer applies; otherwise, drop the idea.
  - **No match.** The work is new. Continue, and, if the design carries any "not yet" wording — a rejection site, a spec future-work note — assign it a fresh `DEF-NNN` ID in the same plan.

**2. When you add a "not yet" rejection or a spec future-work note, add a row to §A in the same commit.** Tag every site with `[DEF-NNN]`. `npm test` fails when a new phrase carries no tag and has no matching entry, with a one-line reason, in `test/deferred-allowlist.txt`.

**3. After each feature implementation, update DEFERRED.md. This step is not optional.** Before you commit the feature work, walk through DEFERRED.md and apply whichever of these fits:
  - **You shipped a deferred item.** Delete the row from §A, AND strip every `[DEF-NNN]` tag from the codebase, in the same commit. Miss either side, and the REVERSE or STALE-ALLOWLIST drift gate fails the build.
  - **You made partial progress on a deferred item.** Update the row's *Status*, *Attempted approaches*, or *Success criteria* fields to match the new state. When you split off a sub-feature into its own row, assign it a fresh ID and reference the parent row.
  - **You found a new rejection while you implemented the feature.** Add a new §A row with the next free `DEF-NNN` ID, and tag the rejection site, in the same commit.
  - **You decided against a related idea during implementation.** Add a §B row with the rationale, so a later session does not reconsider the idea with no context.
  - **You cleaned up stale doc wording.** Drop the matching entry from `test/deferred-allowlist.txt` in the same commit; the STALE gate requires this.

**4. When you reject a feature as "will not implement", add a row to §B with the rationale.** Do not add a `[DEF-NNN]` tag to the codebase for it; a §B row is a decision, not deferred work.

Tag format: `[DEF-NNN]`, a literal three-digit ID. It may carry an optional human label inside, such as `[DEF-005: merge]`. On every `npm test` run, the drift test ([test/deferred-coverage.test.ts](test/deferred-coverage.test.ts)) checks four gates: forward (a tag must have a row), reverse (a row must have a tag), untagged-marker (a phrase must have a tag or an allowlist entry), and stale-allowlist (an allowlist entry must match at least one phrase).

### Commit conventions
Use [Conventional Commits](https://www.conventionalcommits.org/):
- `feat:` — a new behaviour visible to users
- `fix:` — a bug fix
- `test:` — a test change only
- `docs:` — a documentation change only
- `chore:` — tooling, a dependency, or config
- `refactor:` — internal restructuring, with no behaviour change

A breaking API change must use `feat!:` or `fix!:`, and must bump the major version.

**Commit hygiene: one logical change per commit.** Split unrelated changes into separate commits, and keep each commit small and narrow in scope. Do not let a governance or doc tweak ride along with a code fix, and do not bundle two independent fixes together. When one behaviour change spans code, its spec, its DEVLOG entry, and its tests, all four belong in *one* commit, because they are one logical change. Two different behaviour changes are two commits.

### Adding a new MongoDB operator
1. Check that the operator exists in `vendor/mql-specifications/definitions/expression/<name>.yaml`, or in `definitions/accumulator/` or `definitions/query/`. When it does not exist there, bump the pinned commit in `vendor/fetch-mql-specs.mjs`, or add the operator to `REGISTRY_ONLY` in `test/operator-spec-coverage.test.ts` with a comment.
2. Add a `$name: mongo({ … })` row to `src/registry/names.ts`: its `where`, one cell per position (a rule, or a refusal that names the alternative), a `returns` value measured on a running `mongod`, and the one-sentence description taken from the spec YAML. Every fact the emitter needs must sit on the row; see src/registry/CLAUDE.md.
3. Add a case to the matching `test/compiler-*.test.ts` suite. Run the case on `mongod` when a shape's validity is in doubt.
4. When the operator has user-visible syntax, update `docs/LANGUAGE.md`. The drift tests (`test/operator-spec-coverage.test.ts`, `test/registry-agrees.test.ts`) catch a missing description or category.

### Adding a JS-method alias (`.foo()`)
1. Write ONE row in `src/registry/names.ts` through the `name({ … })` constructor. The row states its receiver family (`on`), its arguments rule (`args`, the arity check — never hand-write this check), its value lowering (`expr`, under `perFamily` when the method lives on more than one prototype), and every other position's cell (a rule, or a refusal that names the alternative). Give the lowering what it needs from the compiler through `ExprIn`, as a service, never as an import. See src/registry/CLAUDE.md and docs/specs/emit-pass.md § The method cells.
2. Add a test in `test/compiler-methods.test.ts` that compares the server's answer with JavaScript's own answer, and update `docs/LANGUAGE.md` for the user-visible syntax.

### Formatting
`oxfmt` is the only formatter. Its config sits in `.oxfmtrc.json`, which excludes `*.md`, `dist/`, and `package*.json`. Never make a manual style choice; just run `npm run format`.

### TypeScript
Keep strict mode on. Do not write `any` without a comment that explains why you cannot avoid it.

## Facts the developer did not state, but that still matter

- **README.md** must exist, and it must link to `docs/LANGUAGE.md` and `test/realistic.test.ts` as the two main entry points for a new user.
- **DEVLOG.** Every observable change — a feature, a refactor, a rename, a doc decision — gets an entry in `docs/DEVLOG.md` in the same commit. Keep the newest entry on top. There is no separate CHANGELOG file or ROADMAP file; DEVLOG is the single historical record. See the file's own header for the entry format. A parallel session on a different branch often collides with this file. When `git merge` reports a conflict on `docs/DEVLOG.md`, run `./scripts/merge-devlog.mjs` to resolve it. The script splits the file on `---`, removes a duplicate by its `## YYYY-MM-DD — Title` heading, and sorts the result newest-first. The script stages the result; continue with `git merge --continue`. It falls back to a plain manual conflict only when both sides edited the same past entry in different ways. The [`devlog`](.claude/skills/devlog/SKILL.md) project skill holds this entry format and the merge-resolver step.
- **Pre-1.0 versioning.** The project is pre-1.0, and the public API carries no commitment yet. Do **not** put a `v1`, `v2`, `v3`, or `v4` marker in a test name, a spec header, or anywhere else; each one implies a release that does not exist. When the API stabilises and the project cuts `1.0`, that becomes the first real version.
- **Semver.** The input and output shapes of `jsmql()`, `jsmql.compile()`, and `jsmql.validate()`, across all three call forms (string, arrow, template tag), form the public contract. Once the project reaches `1.0`, any change to those shapes is a breaking change.
- **The template-tag form of `jsmql` is first-class**, not a fallback. Its developer experience — correct errors, correct interpolation, correct shape detection — matters as much as the string form's and the function form's.
- **The registry is the single source of truth.** Never add special-case handling for a name inside the parser or the emitter; every fact must be a row in `src/registry/` that the compiler reads. (Detail: [src/registry/CLAUDE.md](src/registry/CLAUDE.md).)
- **JSMQL never invents its own `$`-prefixed operator.** Every `$`-named callable that JSMQL accepts maps to something that already exists in MongoDB: a real operator, reached through the `$op(...)` direct-operator escape hatch (one row per name in `src/registry/names.ts`), or a real pipeline stage (`$match(...)`, `$project(...)`, …). The project does **not** mint a convenience operator or a pseudo-stage of its own. For example, a `$drop(pred)` that lowers to `$match(!(pred))` will **never** be added, however useful it looks. Two reasons apply. First, it invents a `$name` that is not a real MongoDB operator, and this breaks the rule that every `$op` is a real MongoDB operator, and breaks the property that raw MQL pastes in and round-trips. Second, it gives a second spelling to a capability that already has one, and this is exactly the "which spelling does my codebase use?" friction the project rejects. New ergonomics belong in a JS-idiomatic surface instead: a JS method (`.foo()`), or destination-visible sugar over a real stage, such as `$$.push(…)` for `$unionWith` or `$$$.<coll> = …` for `$out`. Never add a brand-new `$foo()`.
- **`$ =` is reserved for root-replacing sugar.** When you add new sugar: when it replaces the document root, start it with `$ =` (the bare `$` *is* the replaced document). Otherwise, pick a prefix that shows the destination — `$out` becomes `$$$.<coll> = …`, `$lookup` becomes `$$$.<coll>.find(…)`, `$unionWith` becomes `$$.push(…)`. For the rationale and the full convention, see [docs/specs/replace-root-stage.md](docs/specs/replace-root-stage.md).
- **`src/` stays inside TypeScript's strippable subset**, so the source runs with no change on Node 22.18+ and 24.3+ (native type-stripping, with no flag — unflagged since 22.18.0 LTS and since 24.3.0, and stable since 25.2.0), on Deno, and on Bun. The full list of banned constructs, and the reason for each, lives in [`src/CLAUDE.md`](src/CLAUDE.md). `test/smoke.test.ts` locks this invariant down, and `npm test` runs it on every change. After a build, also run `npm run smoke:dist` to check that the published bundle still imports.
- **The site is https://jsmql.js.org.** GitHub Pages serves three root files: the hand-authored landing page `index.html`, the generated `playground.html`, and the `dist/jsmql.js` bundle both files import. `CNAME` binds the domain, and the JS.ORG subdomain entry lives in that service's own repository. None of the three files carries YAML front matter, so Jekyll copies each one as-is and never runs Liquid over its brace blocks; adding front matter would break the page. The landing page states no MQL of its own; it compiles every example in the reader's own browser, so it cannot drift from the compiler. For the full detail — the published files, the example markup contract, the share-link format, the drift guards, and the JS.ORG entry — see [docs/specs/site.md](docs/specs/site.md).
- **`playground.html` is a generated artifact; never hand-edit it.** Its hand-authored source is **`playground_skeleton.html`**, which holds the markup, the CSS, and the behaviour: the entire UI. `scripts/sync-playground.mjs` produces two committed artifacts. The first, **`dist/jsmql.js`**, is an unminified **pure-ESM** esbuild bundle of `src/index.ts` (`export { jsmql, … }`, the library only, with no UI or harness code). It is git-tracked, and it is the one build output that GitHub Pages publishes alongside the page (see `.gitignore` and `_config.yml`). The second, **`playground.html`**, is the skeleton with one region filled in: the examples region (`<!-- jsmql-examples:start -->` to `<!-- jsmql-examples:end -->`) gets a JSON island that holds every playground-eligible `it()` from `test/realistic.test.ts`, grouped under its top-level `describe`. The page imports the bundle with `<script type="module"> import { jsmql } from "./dist/jsmql.js"`, so it must be served over **http or https** (a local static server, or GitHub Pages); a module import will not load over `file://`. Its external dependencies are the CodeMirror CDN and the sibling `dist/jsmql.js`. **The split between the skeleton and the generated file is deliberate.** Because the script only ever writes `playground.html`, and never the skeleton, a change to `src/` or to `test/realistic.test.ts` can never overwrite playground UI work; do UI development in the skeleton instead. A `PostToolUse` hook in `.claude/settings.json` runs the script, and runs `git add` on its outputs, whenever Claude Code edits `test/realistic.test.ts` **or** `playground_skeleton.html`; the script also runs as `prebuild`. An edit under `src/` does not trigger the hook; run `npm run sync:playground` by hand after such an edit (the hook skips `src/` on purpose, with no watcher). Resolve a `playground.html` merge conflict by re-running the sync against the merged skeleton.
