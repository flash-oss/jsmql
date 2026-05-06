# DEVLOG

A chronological log of decisions, changes, and the reasoning behind them. Every observable change to mjsql gets an entry here — this is the answer to future "why is X this way?" questions, the closest thing this project has to a ticket tracker.

**Conventions.**
- Newest entry on top.
- Each entry: short title, date (UTC), 1–3 paragraphs answering *what* and *why*. Include file refs where relevant.
- If a decision is later reversed or superseded, do not delete — add a follow-up entry that links back.
- Pre-1.0: no version numbers in entries. We are still finding the shape of the language; the package version stays at `0.1.0` until the public API is ready to commit to.

---

## 2026-05-06 — Immutable array methods (ES2023) and IIFE → `$let`

Two related additions to the JS surface, both expression-level idioms users already know.

**Immutable array methods.** `.toSorted()`, `.toReversed()`, `.findLast(p)`, and `.findLastIndex(p)` from ES2023 now compile. `.toReversed()` is an alias for the existing `.reverse()` mapping (`$reverseArray`); preferred in pure-functional style. `.toSorted()` with no comparator emits `{ $sortArray: { input, sortBy: 1 } }` — ascending; passing a comparator throws with a clear pointer to `$op($sortArray, { input, sortBy })` for custom sort criteria. `.findLast(p)` reuses the existing `.filter()` codegen and wraps it with `$arrayElemAt(_, -1)`. `.findLastIndex(p)` is the only non-trivial synthesis: a `$reduce` over `$zip` of `[$range(0, $size(arr)), arr]` keeps the largest index where the predicate matches, or `-1` when nothing matches (matching JS's return contract). The reduce body uses `$let` to rebind the user-named lambda parameter to `$$this[1]` so the predicate body's `$$<param>` references resolve to the element. Implementation in [`src/codegen.ts`](../src/codegen.ts).

**IIFE → `$let`.** A `CallExpression` whose callee is an arrow-function literal compiles to MongoDB's `$let`. This is the JS-natural way to bind a name and avoid recomputing a sub-expression:

```js
((maxAge, minAge) => $.age >= minAge && $.age <= maxAge)(65, 18)
// → { $let: { vars: { maxAge: 65, minAge: 18 }, in: { ... } } }
```

Two parser surfaces produce a Lambda usable here: the existing `((x) => body)` form via `isLambdaStart()`, and a new check inside `parseGrouped()` that recognises the unparen-single-param `(x => body)` shape. A new `LParen` arm in `parsePostfix()` produces `CallExpression { callee, args }` AST nodes for any `expr(args)` shape. Codegen accepts the IIFE form and rejects every other callee with an actionable message ("use `$opName(...)` for operators or `receiver.method(...)` for methods"). Spread args and arity mismatches are codegen errors.

**Why now.** `$let` is by far the most useful escape-hatch operator — saving recomputation, clarifying intent — but its current `$let({ vars }, (x) => body)` shape requires switching mental modes. The IIFE form is *the* JS idiom for "bind these names and use them"; mapping it directly removes a friction point users hit constantly. The immutable array methods complete the pure-functional story (the language is expression-only; mutating `.sort()`/`.reverse()` were inherited only because they were what JS had at the time).

**Tradeoff in `findLastIndex`.** The synthesis is verbose — `$zip` + `$range` + `$let` inside `$reduce` — but the JS surface stays minimal. Users who want compact output can drop into the equivalent `$reduce` directly via the escape hatch. Documented in [docs/LANGUAGE.md](LANGUAGE.md) and [docs/specs/method-dispatch.md](specs/method-dispatch.md).

**Verification.** 14 new test cases cover `toSorted`/`toReversed`/`findLast`/`findLastIndex` plus 8 covering the IIFE form (single-param paren and unparen, multi-param, zero-param, body referencing outer fields, mismatched arity, non-lambda callee, spread). `npm test` passes 456/456.

---

## 2026-05-06 — JS-syntax surface for trigonometry and bitwise operators

Thirteen trigonometry operators and four bitwise operators that previously required the `$op(...)` escape hatch are now reachable through standard JS. All seventeen MongoDB operators were already in the registry — this is purely about routing JS surface to existing definitions, not new MQL semantics.

**Trigonometry via `Math.*`** — `Math.sin/cos/tan/asin/acos/atan(x)`, `Math.atan2(y, x)`, plus the hyperbolic family `Math.sinh/cosh/tanh/asinh/acosh/atanh(x)`. Each maps 1:1 to the matching `$sin` / `$cos` / `$atan2` etc. operator. The dispatch table in [`src/codegen.ts`](../src/codegen.ts) `generateMathCall` and the `MATH_METHODS` allowlist in [`src/parser.ts`](../src/parser.ts) gained matching entries; no AST changes. `$degreesToRadians` / `$radiansToDegrees` stay as escape-hatch only — JS has no equivalent.

**Bitwise infix operators** — `a & b`, `a | b`, `a ^ b`, and unary `~a` now compile to `$bitAnd`, `$bitOr`, `$bitXor`, `$bitNot`. Chains flatten the same way `+` and `&&` do: `$.a & $.b & $.c` → `{ $bitAnd: ["$a", "$b", "$c"] }`. The lexer no longer rejects bare `&` and `|` (previously errored with "did you mean `&&`?" — left over from when those operators had no in-language form); new tokens `Amp`, `Pipe`, `Caret`, `Tilde` were added in [`src/lexer.ts`](../src/lexer.ts), with three new precedence levels (`bitOr` < `bitXor` < `bitAnd`, sitting between equality and `&&`) and a `~` arm in `parseUnary` in [`src/parser.ts`](../src/parser.ts). Precedence matches JS exactly so `$.a == $.b & $.c` parses as `($.a == $.b) & $.c`.

**Why now.** ~98 of 187 MongoDB operators are escape-hatch only; expanding the JS surface where the JS spelling already matches MongoDB's semantics is pure additive value with no new design questions. Trigonometry and bitwise were the cleanest wins because the JS spellings (`Math.sin`, `&`) and the operator semantics (radians, integer-only) line up exactly. No semantic invention.

**No shift operators.** MongoDB has no `<<` / `>>` / `>>>` and we deliberately did not introduce those tokens — adding JS syntax that compiles to nothing useful would violate the "every accepted construct maps to MQL" implicit contract.

**Verification.** 27 new test cases in [`test/codegen.test.ts`](../test/codegen.test.ts) cover each new mapping plus chain flattening and JS-precedence interactions (`a == b & c`, `a | b && c`, `~$.flags & 255`). [`docs/LANGUAGE.md`](LANGUAGE.md) and [`docs/specs/grammar.md`](specs/grammar.md) updated with the new precedence table and operator tables. `npm test` passes 388/388.

---

## 2026-05-06 — Typed second parameter for the function form (operator escape hatches)

`MjsqlInput`'s function arm gained an optional second parameter, typed `MjsqlOps = Record<\`$${string}\`, (...args: any[]) => any>`. Users can now destructure operator names from it to silence IDE warnings on direct `$op(...)` calls inside the body:

```ts
mjsql(($, { $dateDiff }) =>
  $dateDiff({ startDate: $.lastLoginAt, endDate: new Date(), unit: "day" }) ?? -1,
);
```

The change is **types-only**. `extractArrowBody()` strips the parameter list at the first `=>` before the parser sees anything, so the destructured names never reach the runtime — the lexer's existing `$<ident>` operator-call branch handles `$dateDiff(...)` exactly as it does in the string form. No runtime, no codegen, no parser changes; ~3 lines added in [`src/index.ts`](../src/index.ts).

**Why open-key (`` `$${string}` ``) and not literal-key autocomplete.** Deriving a literal-key map from `OPERATORS` would require switching the registry from `Record<string, OperatorDef>` to `satisfies`, which propagates through codegen lookup sites. Sizeable refactor for a marginal DX win — the core complaint (red squiggle on `$dateDiff`) is already solved by the open-key form. Trade-off: TypeScript won't catch typos like `{ $datediff }`; the runtime throws at codegen time with the existing "unknown operator" path. Acceptable for now; revisit if anyone asks for autocomplete on the destructure.

**Verification.** The "days since document was created" case in [`test/realistic.test.ts`](../test/realistic.test.ts) was rewritten from the string form to the destructure form — same `$dateDiff` MQL output, formatter-friendly source, IDE no longer flags `$dateDiff`. Documented in [`docs/LANGUAGE.md`](LANGUAGE.md) under the existing Function Form section.

---

## 2026-05-06 — Source kept in TypeScript's strippable subset; runs natively on Node 24+, Deno, Bun

mjsql's `src/` no longer relies on TypeScript constructs that require a compile step. The source runs as-is under Node 24's native type-stripping (stable, no flag), Deno, and Bun.

**Three blockers were removed:**

- The `const enum TokenType` in [`src/lexer.ts`](../src/lexer.ts) became an `as const` object plus a derived string-literal union. Call sites still write `TokenType.LParen`; only the declaration changed. Trades the const-enum's compile-time inlining for a small runtime object (~1 KB of literals — invisible).
- Parameter properties in three error/class constructors (`LexError`, `ParseError`, `Lexer`) were rewritten to explicit field declarations + `this.x = x` assignments. ~12 lines.
- Internal `.js` imports (10 statements across 7 files) became `.ts` imports. Paired with `allowImportingTsExtensions: true` and `rewriteRelativeImportExtensions: true` in [tsconfig.json](../tsconfig.json) so `tsc` still emits `.js` paths in `dist/` for the published package.

**[package.json](../package.json)** now declares `"engines": { "node": ">=24" }` so consumers/CI install on a runtime that supports native TS execution.

**Verification:** `node src/index.ts` (no flags) runs the source directly on Node 24+. A smoke test confirms all three public exports — `mjsql()`, `validate()`, and the `mql` template tag — produce correct MQL via native execution. `npm test` (393 tests) continues to pass under vitest, which already loads `.ts` directly.

**The invariant is now load-bearing:** anything new added to `src/` must remain strippable. No `enum`, no `namespace`, no parameter properties, no decorators, no `<T>x` casts, no `import =`/`export =`. Captured in [`CLAUDE.md`](../CLAUDE.md) and [`src/CLAUDE.md`](../src/CLAUDE.md).

**Why.** Drops the TypeScript-toolchain dependency for development and for downstream consumers who want to vendor the source. Aligns with the project's #1 priority (DX): a contributor can clone, `node src/index.ts`, and iterate without ever running a compiler.

**Out of scope, deliberately:** the long-standing `npm run build` issue with the locally-resolved TS 5.9 / TS6 mismatch (logged in earlier entry). Native Node execution does not need `tsc`; the build remains broken until TS6 ships, but it's no longer on the critical path for using or testing the project.

---

## 2026-05-06 — Function-form input for `mjsql()` and `validate()`

`mjsql()` and `validate()` now accept an arrow function as input, not just a string. The runtime calls `Function.prototype.toString()` on the function, strips the arrow prefix, and feeds the body to the existing parser. Identical MQL output to the equivalent string form, but the expression now lives inside real JS syntax — which means **prettier and oxfmt format it for free**, no plugin, no config.

That formatter-friendliness is the entire motivation. Template literal contents are opaque to JS formatters; long mjsql expressions in `mql\`…\`` sit as one un-broken line. Wrapped in an arrow, the same expression breaks and indents like any other JS. The `test/realistic.test.ts` "full address formatter" case was rewritten to the function form as the proof — same `$reduce` MQL output, dramatically more readable source.

**Restrictions in this release** (kept narrow on purpose, all surfaceable later if needed): arrow functions only (no `function` keyword); expression body only (no `() => { return …; }`); no `async`, no generators. The wrapper's parameter list is ignored — `($)`, `()`, `(doc)` all work — but the parameter is **not** bound inside the body. The recommended idiom is `($) => …` because `$` doubles as the document context. Outer-scope variables don't survive `toString()` (it's text, not a closure); when an unknown identifier is encountered via the function path, the existing `Unknown identifier 'X'. Did you mean '$.X'?` error is augmented to also point at `` mql`…` `` as the canonical interpolation tool.

**Caching.** Compiled bodies are cached in a `Map<string, object>` keyed on the **extracted body string** (not the function reference). Inline arrows in hot paths like `collection.find(mjsql(($) => $.status == "active"))` evaluate to a fresh function object on every call, so a `WeakMap<Function, …>` would never hit. The body string is stable across every evaluation of the same source location, so the cache works correctly for the common case. Cache size is bounded by source-code (no way to inject dynamic content into a function body), so no eviction is needed. The string-input path is intentionally **not** cached, because raw strings are often built via dynamic concatenation and would leak memory.

**Build-time path was explicitly rejected.** A babel/swc/unplugin transform would solve the closure problem cleanly and run the cache at compile time, but build-time tooling worsens DX in JS — particularly server-side — so this is runtime-only. A future prettier plugin (to format inside `` mql`…` `` string contents) and an eslint plugin for mjsql expressions remain on the table as separate, additive work.

Files: [src/index.ts](../src/index.ts) (overload, extraction adapter, body-string cache, `FunctionInputError`); [src/codegen.ts](../src/codegen.ts) (new `UnknownIdentifierError extends CodegenError` carrying the offending identifier so the index-layer can append the `mql` hint without string-matching). Specs updated: [docs/specs/architecture.md](specs/architecture.md), [docs/specs/grammar.md](specs/grammar.md). User-facing docs: new "Function Form" section in [docs/LANGUAGE.md](LANGUAGE.md).

---

## 2026-05-06 — Complete MongoDB expression operator coverage, anchored to the official spec

The operator registry now covers every MongoDB aggregation expression and accumulator operator the official `mongodb/mql-specifications` repo defines — 182 operators total, up from 147. Carriers of the gap: the entire **Bitwise** category (`$bitAnd`, `$bitOr`, `$bitXor`, `$bitNot`), the entire **Window** category (`$rank`, `$denseRank`, `$documentNumber`, `$derivative`, `$integral`, `$expMovingAvg`, `$shift`, `$linearFill`, `$locf`, `$covariancePop`, `$covarianceSamp`), Custom Aggregation (`$accumulator`, `$function`), Encrypted-String (`$encStr*` — for Queryable Encryption), Literal (`$literal`), `$meta`, `$tsIncrement`/`$tsSecond`, `$createObjectId`, `$hash`/`$hexHash`/`$toHashedIndexKey`, statistical accumulators `$median`/`$percentile`, BSON converters `$toUUID`/`$toObject`/`$toArray`, and `$sigmoid`. A duplicate typo (`$objectToArray2`) was removed.

`OperatorDef` gained two required fields, `category` and `description`. Both are surfaced in editor tooltips today and reserved for future docs generation. The new `OPERATOR_CATEGORIES` constant gives exhaustiveness checking with no runtime weight (string-literal union, not a TS enum).

**Spec as ground truth.** The official spec lives at `mongodb/mql-specifications` (Apache 2.0). It has no `package.json`, so it can't be installed as a normal npm devDependency — instead, [`vendor/fetch-mql-specs.mjs`](../vendor/fetch-mql-specs.mjs) clones it into `vendor/mql-specifications/` (gitignored) at a pinned commit, run as the package's `prepare` lifecycle hook. The new [`test/operator-spec-coverage.test.ts`](../test/operator-spec-coverage.test.ts) reads the YAML on every `npm test` and asserts the registry covers every spec operator and uses keys recognised by the spec for object-shape entries. Acceptable gaps (e.g. `$encStr*` not yet in spec, `$sampleRate` is a query predicate exposed for ergonomics) are documented in a `REGISTRY_ONLY` allowlist with comments.

**DX warnings added to [LANGUAGE.md](LANGUAGE.md)** for operators where the registry shape under-specifies real-world correctness: `$literal` bypasses field-ref evaluation; `$meta` takes a keyword string not an arbitrary expression; `$accumulator`/`$function` body fields are server-side V8 source not mjsql syntax; window operators are valid only inside `$setWindowFields`; `$substr` is deprecated.

**Five spec stubs in `docs/specs/`** for the rest of MQL: [query-predicates](specs/query-predicates.md), [projection](specs/projection.md), [accumulators-as-stage-spec](specs/accumulators.md), [update operators](specs/update.md), [aggregation pipeline stages](specs/aggregation-stages.md). Each stub points at its corresponding `vendor/mql-specifications/definitions/<folder>/` so future implementation has a clear precedent. Atlas Search (`definitions/search/`) and BSON types (`definitions/types/`) are noted but not stubbed.

**Pinned spec commit:** `671c69579f9852c12ff89834ac73239f27005f81`. Bump in [`vendor/fetch-mql-specs.mjs`](../vendor/fetch-mql-specs.mjs) when MongoDB adds operators; the drift-protection test will surface what needs registering.

**Why.** The project's #1 priority is DX — every MongoDB expression a user might reasonably write should compile to correct MQL with verified shapes, not heuristically via `generateUnknownOperator`. Anchoring to the official YAML spec means descriptions, argument names, and existence are no longer lifted from doc pages by hand (drift risk) but pulled from the source MongoDB itself uses to drive their downstream tooling.

---

## 2026-05-06 — Strict JS subset rule + drop numeric field segments

Promoted "mjsql is a strict subset of JavaScript syntax" to a top-level invariant — `#2 priority` in the root `CLAUDE.md`, alongside DX. Also surfaced in `src/CLAUDE.md` and `docs/specs/grammar.md`.

**Audit.** The lexer, parser, and grammar were cross-checked against `node --check`. One realistic violation: numeric segments after `.` (`$.0`, `$.items.0`, `obj.0`) — JS rejects all three; you have to write `obj[0]`. Codegen was using this to emit MongoDB's dotted-path-with-array-index string (`"$items.0"`), but the syntax doesn't pass JS. Theoretical edge cases around using reserved words like `class`, `function`, `await` as bare identifiers exist in principle but aren't reachable through any documented or tested construct.

**Fix.** Dropped `Number` from `isFieldSegmentToken` in `src/parser.ts`. `$.items.0` now produces a parse error with the existing "Expected property name after '.'" message. Bracket access (`$.items[0]`) is the supported replacement.

**Codegen follow-on.** `$.items[0]` already worked, but `$.items[0].name` previously threw `CodegenError: Cannot access property 'name' on a non-field expression` because `MemberAccess` codegen only handled foldable field-path chains. Replaced the throw with a `$getField` fallback. Strictly additive: every input that folded into a path before still folds; inputs that threw now produce valid MQL. `$getField` was already used elsewhere in codegen, so no new MongoDB version floor.

**Why.** mjsql's pitch is "JS you already know"; a syntax JS rejects breaks the pitch. Pre-1.0, the breaking change is fine.

---

## 2026-05-06 — Ban `npx`; keep TypeScript at ^6.0.0

Project rule: **never use `npx`**. It silently downloads ad-hoc package versions on first run, which masks version drift between contributors. Always use `npm run <script>` or `node_modules/.bin/<binary>` directly. Documented in [`CLAUDE.md`](../CLAUDE.md), and the single-test snippets in the Commands section now use `node_modules/.bin/vitest` directly. `npm install` is listed explicitly as the once-per-clone setup step.

I'd briefly downgraded TypeScript from `^6.0.0` to `^5.9.0` and re-added explicit `target` / `module` / `lib` to `tsconfig.json` to get `npm install` and `npm run build` working in this environment — that was reverted on user direction. `package.json` stays at `typescript: ^6.0.0` and `tsconfig.json` stays minimal (only options that differ from TS6 defaults). When the local toolchain catches up to TS6, both `npm install` and `npm run build` should work without further changes; until then, contributors needing a working build can vendor a local TS install or wait for the registry to publish 6.x.

---

## 2026-05-06 — JavaScript-style comments

Added `// …` line and `/* … */` block comments to the lexer, with semantics identical to ECMAScript. Both forms are pure trivia: discarded during tokenisation, never reach the parser or AST.

Implementation lives entirely in [src/lexer.ts](../src/lexer.ts): renamed `skipWhitespace()` → `skipTrivia()` and made it loop between whitespace and comment passes until neither makes progress. New helpers `skipLineComment()`, `skipBlockComment()`, plus a `LINE_TERMINATORS = /[\n\r\u2028\u2029]/` regex for the four ECMAScript LineTerminator characters. The divide-vs-regex `/` handler is untouched — by the time it runs, any leading `//` or `/*` has already been eaten, so the existing `lastTokenType` decision continues to work unchanged.

**Why.** mjsql is a "JS subset" language and the absence of comments was conspicuous, especially for multi-line expressions that already exist in `test/realistic.test.ts`. The divide-vs-regex disambiguation also makes raw `/` ambiguous to humans without comment context. Picking native-JS semantics (rather than inventing our own) means anyone who knows JS already knows how mjsql comments work — including the edge cases (LSEP/PSEP terminators, unclosed block error, atomic string/regex/template-quasi treatment, no nesting).

**Out of scope.** The legacy HTML-like `<!--` / `-->` (Annex B Script-mode-only in JS), nested block comments, and preserving comments in the AST. Those are not part of the "JS comments" mental model we're adopting.

**Pre-existing build issue noted but not fixed in this commit.** `npm run build` errors with `tsconfig.json(3,25): error TS5095: Option 'bundler' can only be used when 'module' is set to 'preserve' or to 'es2015' or later.` This is a regression introduced by the earlier "TypeScript 6, ESM-only publish" entry — the tsconfig was trimmed too aggressively (it relies on TS6 defaults that aren't in the locally-resolved TS 5.9.3, and `typescript@^6.0.0` isn't on npm yet). Tests are unaffected (Vitest doesn't use `tsc`). Tracked as the first item to address next; called out here so future-us doesn't re-bisect it.

---

## 2026-05-06 — Bump vitest ^1.6 → ^4.0

Bumped the test runner three majors in a single jump. All cases run unchanged on vitest 4.1.5; no test files needed edits. Audit went from 4 moderate vulnerabilities to 0 in the process.

**Why.** Sitting on vitest 1.x was a relic of the original scaffold and was already the loudest source of npm audit noise. Vitest 4 is a well-supported current major and aligns the dev toolchain with the just-landed TS6 / ESM-only direction (the runner is also ESM-first now).

**Behaviour change.** Consumers don't care — vitest is a `devDependency`. For contributors: vitest 4 requires Node ≥ 20, so the local `node` version needs to keep up.

---

## 2026-05-06 — TypeScript 6, ESM-only publish

Cut the toolchain over from TypeScript 5 to TypeScript 6 and leaned on the new defaults. `tsconfig.json` shrank to only the options that differ from TS6 defaults: `moduleResolution: bundler`, `rootDir`, `outDir`, and the `declaration` / `declarationMap` / `sourceMap` triple needed for a library publish. `target`, `module`, `strict`, `esModuleInterop`, and `lib` all inherit TS6 defaults (`es2025`, `esnext`, `true`, always-on, follows-target).

`package.json` is now ESM-only: `"type": "module"`, single `exports` entry pointing at the ESM build. The source has no Node-only APIs, so the emitted `dist/` runs in both Node (any ESM-capable version) and browsers via any modern bundler unchanged.

**Why.** TS6 ships saner defaults that drop a lot of tsconfig boilerplate; keeping the config to only what differs makes intent obvious to future readers. ESM-only is the simpler shape — dual-publish (CJS + ESM) is mostly machinery for older toolchains we don't have a use case for. The bump to ES2025 follows the TS6 default and matches what realistic Node and bundler targets accept today.

**Behaviour change.** Consumers using `const { mjsql } = require("mjsql")` must switch to `import { mjsql } from "mjsql"` (or `await import("mjsql")` from CJS code). No source-level API changes; expression-level output is unchanged.

---

## 2026-05-06 — Adopt DEVLOG.md as the single historical record

Replaced `CHANGELOG.md` and `docs/ROADMAP.md` with this file. Stripped all `v1`/`v2`/`v3`/`v4` prefixes from `describe()` blocks, section dividers, spec headers, and grammar production names. Renamed `docs/specs/v3-method-dispatch.md` → `docs/specs/method-dispatch.md`.

**Why.** The `v1..v4` labels were development phases, not released versions. Carrying them in test names, spec titles, and changelog entries made the project look matured-out-of-the-oven when in fact it is still pre-`0.1.0` and the public API is not yet committed to. A single `DEVLOG.md` is also a better fit for the way changes actually happen here: we are not cutting releases; we are making decisions that future-us needs to justify. CHANGELOG-style "Added/Changed/Removed" sections force a release-engineering frame that does not match reality.

**How to apply.** Going forward every change — feature, refactor, naming, doc — gets a DEVLOG entry the same commit. If the entry would just be "renamed X to Y", that's fine; it is still load-bearing context for whoever reads the rename later.

---

## 2026-05-06 — `$op()` renamed from "utility / fallback form" to "Escape Hatch (direct operator form)"

`$op()` was previously called "utility functions" / "fallback form" in user-facing docs. Renamed everywhere to "Escape Hatch", with "(direct operator form)" as the parenthetical explainer in headings and prose. EBNF grammar production renamed from `utility_call` → `operator_call` to match the spec.

**Why.** "Utility" implied auxiliary / second-class. "Fallback" implied the primary mechanism failed. Neither was true: `$op()` is the first-class way to invoke any MQL operator that doesn't have a JS surface in mjsql. "Escape hatch" carries the right "you are stepping outside the JS subset on purpose" connotation, which is the actual mental model.

**Affected.** [`README.md`](../README.md), [`CLAUDE.md`](../CLAUDE.md), [`docs/LANGUAGE.md`](LANGUAGE.md) (TOC, intro, Math notes, Date subsection, dedicated section, FAQ, EBNF), [`test/realistic.test.ts`](../test/realistic.test.ts) (header + 5 test names).

---

## 2026-05-06 — `$op()` example operators replaced with operators that genuinely lack a JS equivalent

The example block under "no JavaScript equivalent" prose previously showed `$cmp`, `$in`, `$or`, `$size`, `$cond` — all of which *do* have JS counterparts (`<=>`-style comparison, the `in` keyword, `||`, `.length`, `?:`). Replaced with `$zip`, `$sampleRate`, `$stdDevPop`, `$dateTrunc`, `$topN` — operators with no JS analogue.

**Why.** The original examples undermined the framing of the whole section. A reader could reasonably conclude that mjsql's `$op()` form is just a stylistic alternative to JS syntax, when in fact its purpose is to reach MQL operators that don't have a JS surface at all. Picking the right exemplars makes the section's value obvious at a glance.

**Affected.** [`README.md`](../README.md), [`CLAUDE.md`](../CLAUDE.md), [`docs/LANGUAGE.md`](LANGUAGE.md), [`test/realistic.test.ts`](../test/realistic.test.ts) (header comment).

---

## 2026-05-06 — `flex` operator shape

Added a `flex` variant to `OperatorShape` in [`src/operators.ts`](../src/operators.ts) for MongoDB operators that genuinely accept either a single expression or an array of expressions. Migrated `$round`, `$trunc`, `$min`, `$max`, `$avg`, `$sum`, `$stdDevPop`, `$stdDevSamp`, `$mergeObjects`.

Behaviour: 1 arg → `{ $op: <expr> }`; 2+ args → `{ $op: [a, b, ...] }`; single spread (`...arr`) collapses to the single form; mixed spread + scalars use `$concatArrays` like the existing `array` shape.

**Why.** Several MQL operators have two valid shapes depending on the stage they appear in (accumulator-style in `$group` takes a single expression; expression-style in `$project` takes an array). The previous registry forced one fixed shape per operator, so one of the two valid forms was rejected at compile time. `flex` lets a single registry entry cover both forms naturally — argument count picks the output shape.

**Behaviour change.** Single-arg calls to migrated operators previously emitted either an unwrapped value or a one-element array depending on the operator's old shape; they now consistently emit the unwrapped form. Multi-arg behaviour is unchanged. `$first` / `$last` were considered but skipped — both contexts already take a single argument, so they are correctly modelled by `single`.

---

## 2026-05-06 — Type-aware dispatch for `.includes` / `.indexOf` / `.concat` and bracket access

`.includes()`, `.indexOf()`, `.concat()` and bracket access (`obj[k]`, `obj?.[k]`) now route by receiver type at compile time, with a runtime fallback for unknown receivers:

- Known array → array form (`$in`, `$indexOfArray`, `$concatArrays`, `$arrayElemAt`).
- Known string → string form (`$indexOfCP`, `$gte/$indexOfCP`, `$concat`).
- Unknown receiver (bare `$.field`, ternary, etc.) → runtime `$cond` on `$isArray` between the two forms. For bracket access, the object branch uses `$getField`.

**Why.** Same JS method name, different MQL operators depending on the receiver type. The compile-time check covers the cases where mjsql can prove the type from the AST (array literals, `.split()` results, `.map()` results, etc.). For unknown types, picking either form silently is wrong — the runtime `$cond` is verbose but correct. Users who want compact output can pin the type by chaining a type-fixing method (`.toLowerCase()`, `.slice()`) or by using the operator form (`$in`, `$indexOfArray`).

---

## 2026-05-06 — Template-literal interpolations auto-stringified

Template-literal interpolations are now wrapped with `$toString` unless the expression is statically known to produce a string. `` `n=${$.n}` `` produces `{ $concat: ["n=", { $toString: "$n" }] }` instead of `{ $concat: ["n=", "$n"] }`.

**Why.** JS coerces non-string interpolations to strings at runtime; the previous output errored at MongoDB runtime when `$.n` was a number or boolean, which failed exactly the cases template literals are most useful for. The wrap matches JS semantics. Expressions that are statically known to be strings (string literals, nested templates, `.toLowerCase()`, `String()` casts, string-context `+`, `typeof`, operators in `STRING_OUTPUT_OPS`) skip the wrap to keep output compact.

---

## Earlier — modern JavaScript syntax and built-ins

Pre-DEVLOG history, captured here as a baseline for the current state of the language. See [`docs/LANGUAGE.md`](LANGUAGE.md) for the user-facing reference.

**Syntax.** Template literals (`` `${expr}` ``) compile to `$concat`. Optional chaining (`?.`, `?.[i]`, `?.()`) compiles identically to `.` because MongoDB's dotted-path traversal already null-passes through missing fields. Numeric separators (`1_000_000`). Computed object keys (`{ [$.k]: 1 }`) via `$arrayToObject`. Shorthand object properties (`{ x }` → `{ x: x }`) inside lambda scope. Spread in call arguments (`Math.max(...$.scores)`, `Object.assign(...$.docs)`).

**String methods.** `.trim`, `.trimStart`, `.trimEnd`, `.toLowerCase`, `.toUpperCase`, `.substr`, `.split`, `.replace`, `.replaceAll`, `.startsWith`, `.endsWith`, `.charAt`, `.indexOf`, `.includes`, `.match`, `.length`, `.concat`.

**Array methods.** `.at`, `.slice`, `.reverse`, `.map`, `.filter`, `.find`, `.some`, `.every`, `.reduce`, `.includes`, `.indexOf`, `.concat`, `.join`, `.flat` / `.flat(1)`, `.flatMap`, `.length`.

**Date methods/statics.** `.getFullYear`, `.getMonth` (0-based), `.getDate`, `.getDay` (0-based), `.getHours`, `.getMinutes`, `.getSeconds`, `.getMilliseconds`, `.getTime`, `.toISOString`, `new Date()`, `Date.now()`.

**Math methods/constants.** `Math.abs`, `.ceil`, `.floor`, `.round`, `.trunc`, `.sqrt`, `.exp`, `.log`, `.log2`, `.log10`, `.sign`, `.cbrt`, `.pow`, `.min`, `.max`, `.hypot`, `.random`. `Math.PI`, `Math.E`.

**Statics.** `Array.isArray`, `Object.keys`, `Object.values`, `Object.entries`, `Object.fromEntries`, `Object.assign`.

**Operator and unknown-operator behaviour.** Object-style operator calls route by the operator's registered shape: only operators with `object` shape (e.g. `$trim`, `$dateAdd`) require literal key names. For any other operator (or unknown), a single `{...}` argument is treated as a value and may use computed keys. Unknown operators (not in `OPERATORS`) pass through automatically using a few simple heuristics, making mjsql forward-compatible with new MongoDB releases.
