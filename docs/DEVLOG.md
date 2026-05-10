# DEVLOG

A chronological log of decisions, changes, and the reasoning behind them. Every observable change to mjsql gets an entry here — this is the answer to future "why is X this way?" questions, the closest thing this project has to a ticket tracker.

**Conventions.**
- Newest entry on top.
- Each entry: short title, date (UTC), 1–3 paragraphs answering *what* and *why*. Include file refs where relevant.
- If a decision is later reversed or superseded, do not delete — add a follow-up entry that links back.
- Pre-1.0: no version numbers in entries. We are still finding the shape of the language; the package version stays at `0.1.0` until the public API is ready to commit to.

---

## 2026-05-10 — Smoke checks codified in `test/smoke.test.ts`

Two invariants that I'd been verifying by hand at the end of every session — `node src/index.ts` (strippable-TS rule) and a post-build ESM import of `dist/index.js` — are now part of the vitest suite. The strippable check spawns the real Node stripper because vitest's Vite-based loader silently accepts the very constructs the rule bans (`enum`, `namespace`, parameter properties, decorators, …); a regex/AST walker would drift from "what Node actually does", so the test runs the canonical command. The dist case uses `it.skipIf(!existsSync(...))` so local `npm test` stays fast and silent; `npm run smoke:dist` builds first and exercises it on demand.

The motivation is straightforward: relying on muscle memory to enforce a documented invariant means it survives only as long as the human remembers. The real failure mode is silent — a contributor lands a `class` with a parameter property, every vitest case still passes, and the package breaks for Deno/Bun users at import time. `npm test` now catches it on the same commit.

`test/CLAUDE.md` and the root `CLAUDE.md` "Things that matter" list now point at `test/smoke.test.ts` instead of the manual `node src/index.ts` ritual. Per-feature spot-checks (`node -e "console.log(mjsql('…'))"`) are explicitly *not* added — they duplicate `codegen.test.ts` / `realistic.test.ts` cases.

---

## 2026-05-10 — Increment / decrement: `x++`, `++x`, `x--`, `--x`

Follow-up to yesterday's mutations feature. JS's increment/decrement operators now compile to the same `$set` stage as `x += 1` / `x -= 1`. All four forms produce identical output — the prefix/postfix distinction (return-then-mutate vs mutate-then-return) is irrelevant in MongoDB pipeline context because stage-level mutations don't carry a "value of expression". Treating them as four spellings of the same statement keeps the surface JS-faithful without inventing semantics MQL can't represent.

**Lexer.** Two new tokens (`PlusPlus`, `MinusMinus`) with strict longest-match ordering: `++` checked before `+=` before `+`; same for `-`. The whitespace boundary stays sane — `1 - -2` still lexes as two `Minus` tokens (parses as `1 - (-2)`); `1--2` lexes as `1`, `--`, `2` and is rejected at target validation because `1` isn't a field path.

**Parser.** Prefix `++x`/`--x` joins `delete` as a leading-token signal that triggers `parseMutationProgram`. Postfix `x++`/`x--` joins assignment operators as a post-target signal — same dispatch as `$.x = …`, `$.x += …`. All four mutation positions accept both forms (top-level, `parseMutation`, `parseArrayLiteral` pipeline element, `parseGrouped` parens). Both prefix and postfix desugar via `makeIncDecMutation(target, op)` into the standard `AssignExpr { target, value: BinaryExpr(+/-, target, 1) }` — codegen sees nothing new.

Targets validate identically to compound assignments (field paths only). Misuse as a value (`1 + $.x++`) bubbles through to the existing codegen-level "Assignment is a statement, not a value" error.

**Tests.** 18 new cases in `test/mutations.test.ts` covering all four forms across all four positions (top-level, mixed coalescing, pipeline element, parens), plus the `5 - -3` whitespace regression. Total now 644.

---

## 2026-05-09 — Mutations: `=`, `+=`, `-=`, `*=`, `/=`, and `delete` compile to `$set`/`$unset` stages

Closes the longest-standing item in `Invalid Constructs` (assignments) and adds `delete` alongside it. Users now write document updates in JS-natural form — `$.score += 1`, `delete $.tmp`, `$.user.name = "alice"` — and the compiler emits the correct MongoDB pipeline-stage shapes. Multiple mutations separated by `;` or `,` coalesce into the smallest correct stage sequence.

**Wire format.** `$set` and `$unset` were already registered pipeline stages in `src/stages.ts`; the new code only synthesises the stage objects, no operator-registry changes. Single `$unset` deletes use the string form (`{ $unset: "tmp" }`); two-or-more deletes coalesce to the array form (`{ $unset: ["a", "b"] }`). One assignment yields a bare `{$set:{…}}` object, multiple stages yield an array — same convention as existing pipeline-vs-expression output.

**Coalescing.** Adjacent same-kind mutations (all assignments, or all deletes) merge into one stage *unless* a path collision (parent/child) or a read-after-write would change the semantics. `$.a = 1; $.b = 2` is one `$set`; `$.a = 1; $.b = $.a` is two `$set`s because the second reads what the first wrote — preserves JS sequential semantics. Same algorithm runs at the top level and between adjacent mutation elements inside a pipeline.

**Parser shape.** `parse()` now returns `Program = Expr | MutationProgram`. Top-level dispatch: a leading `delete` keyword, or any expression followed by an assignment operator, triggers mutation-program parsing. Inside `parseArrayLiteral`, the same per-element heuristic runs so `[$match(...), $.a = 1, delete $.tmp, $sort(...)]` works. `=` is right-associative and chainable; `+=`/`-=`/`*=`/`/=` are not — `a += b += 1` is rejected because it's too easy to misread. Compound operators are desugared at parse time into `=` plus a `BinaryExpr`, so codegen sees only plain assignments and inherits the existing type-aware `+` (numeric `$add` vs string `$concat`) for free.

**Parenthesized assignments accepted.** Formatters wrap assignment expressions in parens when they sit in array element position, and Vite/Vitest's transform silently strips them — so without parser support, `mjsql(($) => [($.a = 5)])` would fail in production runtimes even though it passed in tests. `parseGrouped` now recognises an assignment operator after the inner expression, parses the assignment inside the parens, and returns the resulting `AssignExpr`. Misuse as a value (`1 + ($.a = 5)`) is rejected at codegen with a clear message.

**Targets.** Restricted to static field paths (`$.x` / `$.x.y.z`). Bare identifiers, index access, and computed paths are rejected with operator-specific error messages. Mutations are statement-only — invalid inside expressions, lambda bodies, or as values. The `delete` keyword does not return a boolean (unlike JS).

**Both `;` and `,` work as separators**, freely interchangeable. `,` was already a list separator inside arrays/calls; the parser disambiguates by position. `;` is a new lexer token. Trailing separator allowed.

**Spec.** `docs/specs/mutations.md` covers the AST, lexer additions, parser dispatch, codegen coalescer, pipeline integration, and the parens-handling. User-facing reference is `docs/LANGUAGE.md` § Mutations. Tests in `test/mutations.test.ts` (62 cases) plus a paired-form realistic case (`mjsql(string)` ≡ `mjsql(func)`) in `test/realistic.test.ts`.

---

## 2026-05-09 — Two follow-ups to the simplification sweep

Two course-corrections on the same day's sweep, both based on user feedback that the cuts were too aggressive on the wrong dimension.

**README \$accumulator example restored.** The earlier compression collapsed the migration section to a single \$where → \$expr example plus a link. That undersold the project — the \$accumulator-replacement case (count orders by status per shop, six string-encoded JS fields collapsing to one `.reduce()` with a computed key) is the strongest motivator we have. \$where → \$expr is real but small; \$accumulator is the "look how much shorter your code gets" pitch. Both examples now sit on the README front page; \$function gets a one-sentence mention since it follows the same pattern. Full guide stays in LANGUAGE.md.

**`in` with an object-literal RHS now compiles to property existence (JS-faithful).** The earlier commit rejected `\$.x in { a: 1 }` outright with a "use Object.keys().includes()" hint, on the grounds that JS's `key in object` semantic had no useful MongoDB equivalent. Wrong call — the JS semantic *does* have a clean MQL mapping for object literals: extract the keys at compile time and reduce to `\$in` against a literal array. `\$.x in { a: 1, b: 2 }` now emits `{ \$in: ["\$x", ["a", "b"]] }`. Computed keys evaluate at runtime; spread entries lower to `\$objectToArray(expr).k` and splice in via `\$concatArrays`. The semantic divergence is now documented explicitly in LANGUAGE.md: array on the right is value-membership (deliberate divergence from JS, matches MongoDB query intent), object on the right is property-existence (JS-faithful), scalar on the right still errors. Five new tests cover the static, computed-key, mixed-spread, and spread-only cases.

The principle: the project's #2 priority is *strict subset of JavaScript syntax*, but the per-construct semantic decisions are case-by-case. For `in`, MongoDB users typing `value in array` overwhelmingly want value-membership and we keep that even though JS does index-existence; but `value in object` already maps cleanly to property-existence and we should match JS there. Refusing to compile is the wrong default when a clean mapping exists.

---

## 2026-05-09 — Project-wide simplification sweep

A whole-tree audit followed by 14 small commits, ranked by impact-to-risk and committed individually so any one is easy to revert. Every change kept the test suite green and preserved (or improved) user-facing DX. Three correctness bugs, six internal cleanups, three test-suite trims, two contributor-tooling wins, three DX-improving error messages.

**Correctness bugs.** The `package.json` description still said "LISP-style MongoDB aggregation expression transpiler" — the framing the project pivoted away from; npm/registry searches show this first, fixed. The DEVLOG entry from 2026-05-06 still linked to four spec stub files that were deleted on 2026-05-09; converted to plain text with a back-pointer to the deletion entry. `docs/LANGUAGE.md` showed `$.items.0.name` as a valid field-path example — the 2026-05-06 strict-JS-subset commit removed that syntax; replaced with the bracket form.

**Internal cleanups.** `parser.ts` had two character-for-character identical predicates (`isIdentOrKeyword` + `isFieldSegmentToken`) used in different contexts but checking the same Ident-or-keyword set; collapsed to one. `requireLambda` in `codegen.ts` took a `_minParams` argument every call site passed and the body ignored — arity is checked manually after the call, so the parameter was just ceremony. The codegen module-level `_genDepth` recursion guard mirrored the parser's own depth cap; since codegen only ever sees parser-produced ASTs, the parser cap trips first — removing the codegen guard takes module-level mutable state out of the file.

**Test suite trims.** Five exact-duplicate codegen test cases removed (5/557 → 552, zero behaviour coverage lost — every cut has a sibling assertion in another describe). Then four documented operators that lacked any codegen test got coverage: `$switch`, `$dateTrunc`, `$dateFromString`, `$sampleRate`. Net: 552 → 556 → 559 by the end of the session.

**Contributor-tooling wins.** The `vendor/fetch-mql-specs.mjs` script was full-cloning the upstream MongoDB spec repo (~30 MB) on every `npm install` for two folders we read. Switched to `--filter=blob:none` + cone-mode sparse-checkout limited to `definitions/{expression,accumulator,stage}` — vendor footprint drops to 1.5 MB. Then moved the script from `prepare` to `pretest` so downstream consumers of the published package don't pay the clone cost; contributors and CI still get the fetch automatically because `npm test` triggers it. Replaced a `cat`-via-`execSync` sentinel read with a plain `readFileSync` while we were in there.

**DX-improving errors.** Three silent-surprise paths now error with a clear message instead. (1) Regex literals in standalone position (`$.x == /foo/`, `$regexMatch({ regex: /foo/ })`) used to silently return the bare pattern string, dropping any flags — now throws with a list of supported method-call forms. (2) `$.x in {a: 1}` used to compile to `{ $in: ["$x", {a:1}] }` and produce a confusing Mongo-runtime error — now throws at codegen with a hint pointing at `Object.keys(obj).includes(key)` or `$getField`. (3) Unknown method names used to surface a wall-of-text "here are all 40+ supported methods" error; now they get a Levenshtein-driven "Did you mean '.toLowerCase()'?" hint, sharing a tiny new `src/levenshtein.ts` with the existing pipeline-stage suggester.

**Two suggestions deliberately rejected.** The audit also flagged the operator-shape factory helpers (`single`/`array`/`obj`/`flex`/`none` in `src/operators.ts`) and the public `FunctionInputError` / `MqlInterpolationError` classes as candidates for inlining. Both were the wrong call. The factories make the 170-entry registry an order of magnitude shorter than inlined `{ shape: { kind: "..." }, category: "...", description: "..." }` literals — that's not over-abstraction, it's the file's main readability lever. The error classes are the routing keys `validate()` uses to map `FunctionInputError` → `SYNTAX_ERROR` instead of the catch-all `CODEGEN_ERROR` bucket; dropping them either regresses error codes or requires a worse alternative (sentinel properties, message-string matching). Pre-1.0 we *could* break the public API for marginal LOC, but the routing logic is what keeps `validate()`'s contract clean.

**Net.** Across the 14 commits: ~140 LOC of cleanly-removed code, ~85 LOC of new tests + the new Levenshtein helper, README is ~70 lines shorter, vendor on-disk drops 28.5 MB. No source change exposed an existing test bug or required a coverage trade-off.

---

## 2026-05-09 — Restructure `docs/specs/` to make drift impossible by construction

Follow-up to the morning's spec drift sweep. That commit fixed eleven concrete drift points one by one. This commit takes the next step and removes most of the surface that *can* drift in the first place.

**Deleted four future-work stubs.** `accumulators.md`, `projection.md`, `query-predicates.md`, `update.md` were placeholders describing work that hasn't started — each duplicated its one-line description from `docs/CLAUDE.md`'s spec-coverage table without adding anything. Replaced the four table rows with a single "future work areas" paragraph that lists the same scope inline; new stub files can be created when the corresponding implementation actually starts. Net: ~70 lines of doc surface gone.

**Replaced static enumerations with source pointers.** Where a spec listed names that already live in source — and the spec wasn't itself the canonical definition — the list is gone and the prose now points at the source const/type. Concrete swaps:

- `architecture.md` pipeline diagram: `Expr` node enumeration → "see the `Expr` union in src/ast.ts"; lexer token enumeration → "see `TokenType` in src/lexer.ts".
- `grammar.md`: the string-context-`+` method bullet list → one sentence pointing at `STRING_RETURNING_METHODS` and `STRING_OUTPUT_OPS` in `src/codegen.ts`. EBNF productions for `MATH_METHOD`, `MATH_CONST`, `OBJECT_METHOD`, `TYPE_CAST_NAME`, `NUMBER_STATIC` now have inline comments pointing at `MathMethod` / `MathConstant` / `ObjectMethod` / `TypeCastOp` / `NumberStaticMethod` in `src/ast.ts`.
- `operator-registry.md`: the categories list → "see `OPERATOR_CATEGORIES` in `src/operators.ts`"; the "current flex operators" list → "see entries with `shape: FLEX` in `src/operators.ts`"; the per-category operator-counts table → deleted entirely. `test/operator-spec-coverage.test.ts` already enforces every category/shape claim, so the counts table was a drift trap with no readership value.

**Method-dispatch.md is unchanged.** Its tables are the canonical spec for method-name → MQL-output mapping; codegen implements them, not the other way round. The two real bugs from the morning sweep (`.flatMap` mis-categorised, no Set-method names) had already landed in the previous commit.

**Pass C — sentinel-based drift test — was skipped on purpose.** The plan allowed for a small `test/spec-pointers.test.ts` that would parse `<!-- mirrors X:Y -->` comments and assert spec/source set equality. After the deletions and pointer-replacements, no spec contains a duplicated source enumeration that "reads better as a list", so there is nothing for the sentinel test to guard. The test itself becomes load-bearing as soon as a future spec re-introduces a concrete enumeration that mirrors source — at that point we add the test along with the sentinel comment, instead of carrying it now for hypothetical use.

**Why this shape over the morning's one-edit-per-drift-point approach.** Each spec line that names something that also lives in source is a future-drift commitment; the drift sweep paid that cost once but the cost recurs on every subsequent feature. Replacing the names with pointers means the next person extending the AST or the operator registry doesn't have a spec line to remember to update — the pointer keeps reading correctly because it's deferring to the canonical home. Same goes for the deleted stubs: an empty stub adds nothing to grep-discoverability that the `docs/CLAUDE.md` index doesn't already provide, and removes one of the recurring "this stub is technically out of date" footnotes.

---

## 2026-05-09 — Spec drift sweep across `docs/specs/`

A full audit of every file in `docs/specs/` against the actual implementation in `src/`. Found 11 concrete drift points and fixed all of them; no source or test changes (the implementation was right, the specs had fallen behind).

**`architecture.md` — biggest cluster.** The `Expr` AST node list was missing five node types added since the spec was last touched (`BigIntLiteral`, `NewSet`, `CallExpression`, `ArrayFrom`, `NumberStatic`). The pipeline diagram terminated at `generate()` and the module-responsibilities table didn't list `pipeline.ts` or `stages.ts` — both load-bearing modules for the pipeline-mode path that runs from `compile()` in `src/index.ts`. The public `mjsql()` signature still claimed `: object` rather than the widened `: MjsqlOutput = object | object[]` that pipeline mode needs. The error-types table was missing `MqlInterpolationError` (public class, raised by the `mql` template tag) and `validate()`'s `RangeError` defensive arm. The lexer one-line summary listed only six of the twelve+ token shapes the lexer actually produces. And the cache section still described the `fnBodyCache` as "unbounded but safely so" — it has been a 256-entry LRU since the security-hardening pass on 2026-05-08.

**`grammar.md`.** The `$let` lambda paragraph said the lambda parameters "become the `vars` binding names" — direction reversed. The keys come from the object literal (the first arg); the lambda's params are added to scope so the body can reference them as `$$paramName`. The spec wording made it sound like the lambda was load-bearing for the binding step, which would mislead anyone trying to extend or debug the `$let` intercept. Also expanded the string-context-`+` method list from ten methods to the full sixteen the codegen actually checks (`STRING_RETURNING_METHODS` in `src/codegen.ts`); the old list silently understated when a `+` chain becomes `$concat`.

**`method-dispatch.md`.** `.flatMap(x => body)` was filed under "Array methods (no lambda)" — clearly wrong since it requires a lambda to do anything useful. Moved to the lambda section. The Set-receiver section described the dispatch route to `$setIntersection` / `$setUnion` / `$setDifference` / `$setIsSubset` but never listed the actual JS method names (`.intersection`, `.union`, `.difference`, `.isSubsetOf`, `.isSupersetOf`); added a small mapping table including the `isSupersetOf`-as-swapped-`$setIsSubset` trick.

**Smaller items.** `aggregation-stages.md` had a dead `[strict-subset-of-JavaScript](#)` link → repointed to `grammar.md#strict-js-subset-rule`. `accumulators.md` listed all 35 accumulators inline — replaced the static list with a pointer to the registry plus `vendor/mql-specifications/definitions/accumulator/`, since the drift-protection test in `test/operator-spec-coverage.test.ts` already keeps that set authoritative. `query-predicates.md` listed `$sampleRate` as a query-predicate scope item without acknowledging it's already in the expression registry as a `miscellaneous` operator — added a callout flagging the dual-context disambiguation as part of the spec's open design work. `operator-registry.md`'s `flex`-vs-`object` distinction got an explicit "object-literal arg is a value, not a shape signal" callout.

Operator counts in `operator-registry.md` (182 total, broken down by category) were verified against `src/operators.ts` by manual tally — accurate. The `test/operator-spec-coverage.test.ts` drift test continues to be the strongest defence here; the gap is that nothing automated catches AST-node-list drift or module-list drift, so those will need re-reading periodically.

---

## 2026-05-08 — Array spread compiles to `$concatArrays`

`[1, 2, ...$.arr, 3]` now compiles. Previously the codegen threw `CodegenError: Spread elements in array literals are not supported in MQL output` — same docs/code drift the object-spread change just closed. `docs/LANGUAGE.md:180-181` already listed `[...$.tags, "extra"]` and `[...$.a, ...$.b]` as valid syntax, but only the parser honoured it; codegen rejected. This entry closes the parity with the object-spread implementation that landed earlier today.

The lowering is the array equivalent of object spread: walk elements left-to-right, group consecutive non-spread elements into one `$concatArrays` operand (a literal MQL array), and emit each `...expr` as its own operand. So `[1, 2, ...$.arr, 3]` becomes `{ $concatArrays: [[1, 2], "$arr", [3]] }`. A lone `[...x]` returns `x` directly to avoid a redundant `{ $concatArrays: [x] }` wrapper. Each spread argument must evaluate to an array at runtime, the same constraint MongoDB's `$concatArrays` itself imposes.

The new helper `generateArrayLiteral` in `src/codegen.ts` sits next to `generateObjectLiteral` so the parallel structure is visible. Eleven new test cases in `test/codegen.test.ts` under `describe("array spread", …)` cover grouping, single-spread unwrap, multiple spreads, lambda-param threading, the empty-array fast path, and a nested `[[...$.a]]` regression. A realistic case in `test/realistic.test.ts` shows the natural use: building a combined moderator list and checking membership with `.includes()`. The call-arg variadic helper (`generateVariadicArgs`) is intentionally left alone — its per-arg wrapping reads more cleanly for short call lists, and it is documented as a separate concept in `docs/specs/method-dispatch.md`.

---

## 2026-05-08 — Object spread compiles to `$mergeObjects`

`{ ...a, x: 1, ...b }` now compiles. Previously the codegen threw `CodegenError: Spread elements in object literals are not supported in MQL output`, which was both a real DX gap and a docs/code drift — `docs/LANGUAGE.md` already listed object spread as valid syntax with `{ ...$.defaults, priority: 1 }` examples.

The mapping is unambiguous: walk entries left-to-right, group consecutive non-spread entries into one `$mergeObjects` operand each, and emit each `...expr` as its own operand. JS spread's "later wins" matches `$mergeObjects`'s "rightmost value wins on key collision", so order is preserved without rearranging. Computed keys still produce `$arrayToObject`, but per-block — `{ ...$.base, [$.k]: $.v }` becomes `{ $mergeObjects: ["$base", { $arrayToObject: [["$k", "$v"]] }] }`. A lone `{ ...x }` returns `x` directly so the common no-op case doesn't get a redundant wrapper.

This unlocks the cleaner version of the histogram replacement in the README's `$accumulator` migration example. The reduce body went from `(acc, s) => $mergeObjects(acc, { [s]: (acc[s] ?? 0) + 1 })` to the more JS-natural `(acc, s) => ({ ...acc, [s]: (acc[s] ?? 0) + 1 })`. Same MQL output, less mjsql-specific syntax. Eight new test cases in `test/codegen.test.ts` under `describe("object spread", …)` cover the grouping rules, computed-key interaction, and the README's exact reduce expression.

The drop-in support also works inside operator argument objects — but those still reject spread, since an operator's argument keys are part of MongoDB's wire format and can't be runtime-merged. That restriction is tested too.

---

## 2026-05-08 — Position mjsql as the migration path for deprecated server-side JS

MongoDB 8.0 deprecates `$function`, `$accumulator`, and `$where` — the three operators that execute user-supplied JavaScript on the server. mjsql's authoring model ("write JavaScript expressions, get native aggregation operators") is exactly what MongoDB's own deprecation guidance points users toward, so we are explicit about it: the README now leads with the deprecation context, and `docs/LANGUAGE.md` has a new "Replacing server-side JavaScript" section with side-by-side migration examples in both the string form (`mjsql("…")`) and the function form (`mjsql(($) => …)`).

**Deliberate non-decisions.** No `function` keyword sugar in the grammar (an earlier-explored direction is now retired); no error or warning when the deprecated operators are emitted via the existing registry passthrough; no removal of the `$function` / `$accumulator` registry entries. The DX bar is clear: existing code that calls these operators continues to work without ceremony. The whole pivot lives in three files — `README.md`, `docs/LANGUAGE.md`, `docs/DEVLOG.md` (this entry) — and zero source or tests change.

**Why this shape.** Throwing an error or printing a warning would degrade users who already use these operators on older MongoDB versions, where they remain supported. Documentation does the work instead: anyone landing here from a "MongoDB $function deprecated" search query gets a direct migration table and a reason to adopt mjsql, while existing call sites continue to compile silently. The decision aligns with priority #1 (developer experience) and turns the deprecation into mjsql's strongest positioning lever to date.

---

## 2026-05-08 — Defensive hardening from the security audit

A pass over the four issues a security review of the `mql` template tag and the surrounding APIs flagged as worth fixing. None of the findings were exploitable on the documented use case, but each one was a footgun or a contract gap the library could close cheaply. New `test/security.test.ts` covers all four.

**`mql` interpolation now rejects values that `JSON.stringify` mishandles.** Previously, `mql\`$.x == ${undefined}\`` silently produced the literal text `undefined` in the parsed source (interpreted as an unknown identifier two layers deeper); `mql\`$.x == ${NaN}\`` silently coerced to `null`; `BigInt` and circular structures threw a raw `TypeError` from inside `JSON.stringify`. New `MqlInterpolationError` (exported) is raised at interpolation time with a slot-pointing message (`mql interpolation slot 2 has type 'undefined'…`). Strings, finite numbers, booleans, `null`, arrays, and plain objects continue to round-trip unchanged. See `stringifyInterpolation()` in [src/index.ts](../src/index.ts).

**Parser and codegen now cap recursion depth at 200 levels.** Previously, deeply nested input (e.g. `'('.repeat(2000) + …`) blew the V8 call stack and threw an uncaught `RangeError` that bypassed `validate()`'s structured-error contract entirely. Both the recursive-descent parser ([src/parser.ts](../src/parser.ts) — instance counter on `parseExpression`) and the codegen ([src/codegen.ts](../src/codegen.ts) — module-level counter reset at each public `generate()` entry) now throw normal `ParseError` / `CodegenError` past the cap, with a `nests too deeply (max 200 levels)` message. 200 was chosen with margin: each parser level burns ~17 stack frames in the precedence cascade, so 200 levels ≈ 3400 frames, well under any platform's default. Real expressions never approach this depth.

**`validate()` is now total.** It used to throw any error class it didn't recognise (including `RangeError` and now `MqlInterpolationError`); a function named `validate` should never throw. New catch arms map `MqlInterpolationError` and `RangeError` into `SYNTAX_ERROR`, and a final fallback wraps anything else as a generic `CODEGEN_ERROR` with `internal error: …` so the structured-result contract holds for arbitrary input. No new error code introduced — `INTERNAL_ERROR` would have widened the public API; `CODEGEN_ERROR` is the existing non-positional bucket and matches the taxonomy.

**Compiled-body cache is now a bounded LRU (cap 256).** [src/index.ts](../src/index.ts)'s `fnBodyCache` was a plain `Map` whose growth was bounded only by the count of distinct arrow-function source strings in the host program — fine today, since `Function.prototype.toString()` returns static text. The bound is defence-in-depth against a future change that lets dynamic strings reach this map (e.g. accepting `new Function(...)` as input). LRU is implemented in-file as `cacheGet` / `cacheSet` via `Map` insertion-order.

**Deferred from this pass.** Server-side-JavaScript operators (`$function`, `$accumulator`, and `$where` via the unknown-operator passthrough at `codegen.ts:602`) remain emittable. The chosen direction is to surface them via the JS `function` keyword as first-class mjsql syntax — the same model as the `in` keyword — rather than a denylist or `{ allowServerJs: true }` flag. Substantial design work; tracked for a separate session. No `SECURITY.md` written yet either; will add once the threat model stabilises post-deferred-work.

---

## 2026-05-07 — Aggregation pipelines through `mjsql()`

`mjsql()` now compiles entire MongoDB aggregation pipelines, not just single expressions. No new exports — detection happens at the input boundary inside `compile()`. A top-level array enters pipeline mode when its first element looks like a stage attempt; the function returns `object[]` instead of the historical single `object`. Both forms work and may be mixed:

```js
mjsql(`[
  { $match: $.age > 18 },
  $sort({ created: -1 }),
  { $limit: 10 }
]`);
```

**Why both forms.** The stage-object shape `{ $match: ... }` mirrors what users copy out of Compass and the MongoDB docs; the stage-call shape `$match(...)` parallels the existing `$op()` escape hatch and is terser. They compile identically; users pick what reads better at the call site.

**`$match` auto-`$expr` wrap.** `$match` is the one stage with two body modes in real MQL — query document or aggregation expression (the latter must be wrapped in `$expr`). When a `$match` body parses as an object literal, mjsql treats it as a raw query document and passes it through; anything else is auto-wrapped, so `{ $match: $.age > 18 }` becomes `{ $match: { $expr: { $gt: ["$age", 18] } } }`. This is the only stage-aware transform; everything else is the existing object-literal codegen.

**Architecture.** New `src/stages.ts` registers all 45 stages from `vendor/mql-specifications/definitions/stage/` (description + per-stage `subPipelineFields`). New `src/pipeline.ts` owns detection (`isPipelineAst`), lowering (`generatePipeline`), and sub-pipeline recursion for `$lookup.pipeline`, `$unionWith.pipeline`, and `$facet.*`. `src/codegen.ts` is unchanged — pipeline lowering composes on top of `generate()`. The same registry-as-truth invariant we apply to operators (no `if (name === ...)` outside the registry) applies to stages.

**Parser change.** `parseObjectEntry` now accepts `Dollar IDENT` as a static object key, so `{ $match: ... }` and `{ $gt: 18 }` parse. This is JS-syntax-valid (`$match` is a legal JS identifier) and preserves the strict-subset-of-JavaScript invariant.

**Detection trigger is intentionally aggressive on `OperatorCall` first elements.** `[ $abs(1), $abs(2) ]` enters pipeline mode and fails strictly — top-level value arrays of expression-operator results are vanishingly rare in aggregation use, while typos like `[$prject({...})]` benefit hugely from a clear "not a known stage" error instead of silent compile-as-array.

**Public API.** `mjsql()` and `mql` return type widens from `object` to `object | object[]` (`MjsqlOutput`). Pre-1.0 it's a non-breaking change at runtime (arrays are objects); semver-tracked when 1.0 cuts.

**What's deliberately deferred.** Drift-protection test for `STAGES` (parallel to `test/operator-spec-coverage.test.ts`); query-predicate validation inside `$match` object-literal bodies (today they passthrough verbatim, see `docs/specs/query-predicates.md`); `$setWindowFields` static validation of window-only operators. Spec details in `docs/specs/aggregation-stages.md`.

---

## 2026-05-06 — ES2024/2025 set & object surface, regex helpers, BigInt, padding

A grab-bag of JS-syntax additions all aimed at cutting more `$op(...)` escape-hatch usage. Each addition is independent; grouped here because they were designed and shipped together.

**ES2025 Set methods.** `new Set(arr).intersection(new Set(other))` (and `.union`, `.difference`, `.isSubsetOf`, `.isSupersetOf`) compile to `$setIntersection`/`$setUnion`/`$setDifference`/`$setIsSubset`. The `new Set(...)` wrapper is a JS-syntax tag — MQL has no Set type, so codegen unwraps it on both receiver and argument. `symmetricDifference` and `isDisjointFrom` have no MongoDB equivalent and are rejected with actionable errors. `parseNewDate` was generalised to handle `new Set(...)` alongside `new Date(...)`; method dispatch in `generateMethodCall` intercepts `NewSet` receivers and routes to `generateSetMethodCall`.

**Regex method variants.** `/re/.test(str)` and `/re/.exec(str)` (regex-as-receiver) and `str.matchAll(/re/g)` and `str.search(/re/)` (regex-as-argument) compile to `$regexMatch`, `$regexFind`, `$regexFindAll`. `.matchAll` requires the `g` flag (matching JS's TypeError). `.search` returns the first match's `.idx` with `$ifNull` fallback to `-1`. The lexer's existing context-sensitive `/`-vs-divide logic already produces `RegexLiteral` tokens at the right positions — no lexer changes needed.

**`Object.groupBy()` (ES2024).** Synthesises a `$reduce` building a grouped object: discriminator runs against `$$this`, the result is wrapped with `$toString` if not statically a string, then `$mergeObjects` extends the accumulator under that key with the current element appended. Implementation in `generateObjectCall`'s new `groupBy` arm. `Map.groupBy` is rejected — JSON output target has no Map type.

**`Number.isInteger` / `Number.isNaN`.** New `parseNumberStaticCall` handles `Number.isInteger`/`isNaN` in parsing (avoiding collision with the existing `Number(x)` type-cast form). `isInteger` checks BSON type via `$type` and falls back to `$eq([x, $trunc(x)])` for double/decimal. `isNaN` uses the `x !== x` trick. `isFinite` is **explicitly rejected** with a clear error pointing at domain-bound checks — MQL has no Infinity literal that compiles cleanly.

**`Array.from({length: n}, (_, i) => f(i))`.** The {length} form is the only supported one — pattern-matched at codegen and synthesised as `$map($range(0, n), (i) => $let({ _: null }, body))`. Since `$map` only binds one variable, the lambda's first (element) parameter is rebound to `null` via `$let` — matches JS's "element is always undefined" semantics for the {length} form. Other `Array.from` invocations are rejected.

**String `.padStart(n[, ch])`, `.padEnd(n[, ch])`, `.repeat(n)`.** Synthesised via `$reduce` over `$range` concatenating the pad/repeat string. Verbose MQL output but a tiny JS surface. `padStart` defaults the pad char to space, matching JS.

**BigInt literals.** Lexer recognises the `n` suffix on integer literals (rejected on fractions/exponents, matching JS). New `BigIntLiteral` AST node compiles to `{ $toLong: <decimal-string> }`. Useful for 64-bit timestamp arithmetic where `Number` would lose precision.

**Optional method call `?.()`.** Already worked — `parsePostfix` already handled `?.` followed by a member, and the method-call branch was reached for both `.method(args)` and `?.method(args)`. Added a regression test to lock the behaviour in.

**Why now.** Each item closes a real DX gap. ~85 of the 187 MongoDB operators are still escape-hatch only after this PR; another ~30 are now reachable through standard JS syntax that previously required `$op(...)`. The biggest qualitative wins: Set algebra (every "deduplicate / overlap / membership" use case), `Object.groupBy` (the canonical analytics aggregation idiom), and BigInt literals (correctness for 64-bit timestamps).

**What this PR rejects with actionable errors instead of silent failure.**
- `Number.isFinite()` — no clean Infinity literal in MQL
- `Set.symmetricDifference()` / `.isDisjointFrom()` — no direct operator
- `Map.groupBy()` — no Map type in MQL
- `Array.from(iterable)` — no general iterable-to-array primitive
- `.toSorted(comparator)` — comparator translation deferred
- `.matchAll(/re/)` without `g` flag — matches JS's TypeError

**Verification.** 32 new test cases across all eight features. `npm test` passes 482/482. Documentation updated in [docs/LANGUAGE.md](LANGUAGE.md), [docs/specs/grammar.md](specs/grammar.md), and [docs/specs/method-dispatch.md](specs/method-dispatch.md).

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

**Verification.** 14 new test cases cover `toSorted`/`toReversed`/`findLast`/`findLastIndex` plus 8 covering the IIFE form (single-param paren and unparen, multi-param, zero-param, body referencing outer fields, mismatched arity, non-lambda callee, spread). `npm test` passes 416/416.

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

**Five spec stubs in `docs/specs/`** for the rest of MQL: query-predicates, projection, accumulators-as-stage-spec, update operators, and [aggregation pipeline stages](specs/aggregation-stages.md). Each stub points at its corresponding `vendor/mql-specifications/definitions/<folder>/` so future implementation has a clear precedent. Atlas Search (`definitions/search/`) and BSON types (`definitions/types/`) are noted but not stubbed. *(The four future-work stubs were deleted on 2026-05-09 — see that day's "restructure" entry.)*

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
