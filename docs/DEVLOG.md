# DEVLOG

A chronological log of decisions, changes, and the reasoning behind them. Every observable change to jsmql gets an entry here — this is the answer to future "why is X this way?" questions, the closest thing this project has to a ticket tracker.

**Conventions.**
- Newest entry on top.
- Each entry: short title, date (UTC), 1–3 paragraphs answering *what* and *why*. Include file refs where relevant.
- If a decision is later reversed or superseded, do not delete — add a follow-up entry that links back.
- Pre-1.0: no version numbers in entries. We are still finding the shape of the language; the package version stays at `0.1.0` until the public API is ready to commit to.

---

## 2026-05-21 — Widen the strippable-TS floor: Node 22.18+ / 24.3+ run `src/` natively, no flag

The "Node 24+ for native type-stripping (no flag)" claim sprinkled across the docs was conservative. Type stripping was unflagged in **Node 22.18.0** (LTS, August 2025) and in **Node 24.3.0** — and marked stable in 25.2.0 (November 2025). So a user on the current Node 22 LTS line can run `node src/index.ts` directly without any flag, not just users on the 24 line. Doc-only change to widen the documented floor; no source or test code changes.

The change also caught one stale instruction I'd just added in the 2026-05-21 "Maintain README.md" rule — the example command read `node --experimental-strip-types src/index.ts`, which is wrong on every Node version where the new "no flag" claim holds. The new wording suggests writing a small probe script and running it with `node tmp/probe.mjs` instead, which is closer to how I actually verified README examples in practice.

Files updated (all docs, no source):

- Root [CLAUDE.md](../CLAUDE.md) — the "Maintain README.md" rule's example command and the strippable-subset bullet in "Things the user did not explicitly ask for but matter".
- [README.md](../README.md) — the Highlights bullet for the strippable-source claim.
- [src/CLAUDE.md](../src/CLAUDE.md) — the strippable-subset invariant bullet.
- [scripts/CLAUDE.md](../scripts/CLAUDE.md) — the `Conventions` bullet about `.mjs` scripts importing from `src/*.ts`.
- [test/smoke.test.ts](../test/smoke.test.ts) — the file-header comment describing the strippable-TS smoke test.

No DEVLOG entries were edited — historical entries describing "Node 24+ native type-stripping" remain accurate as a description of the state at write time (the convention from the file header: never delete or rewrite past entries; add follow-ups). Verified by running `node src/index.ts` on the user's Node 25.2.1; smoke test stays green.

`package.json#engines` is unchanged (`>=14`) — that's the **dist** consumer floor (the transpiled `dist/cjs/index.cjs` runs on Node 14+), which is independent of the source-running invariant this entry covers.

---

## 2026-05-21 — Bare stage call auto-wraps as a one-stage Pipeline (no `;` required)

`jsmql("$match($.age > 18)")` now returns `[{ $match: { age: { $gt: 18 } } }]` instead of throwing `CodegenError("$match is a Pipeline stage, … add a trailing ;")`. Same auto-wrap applies to every registered stage (`$project`, `$sort`, `$limit`, `$group`, …) and to the Compass copy-paste form `{ $match: ... }`. The `;`-suffixed form keeps working and produces identical output. `jsmql.expr()` is **not** changed — passing a stage call to it stays a misuse case, since `jsmql.expr`'s contract is "raw aggregation expression" and stages are not aggregation expressions.

Motivation: a user wrote `$match(...)` at the top level and got an error telling them what they did wrong instead of the right MQL. The `;` was bookkeeping the surface didn't need. The original guard (DEVLOG 2026-05-19, "Filter dispatch: reject bare stage calls with a `;` suggestion") existed to prevent the silent footgun where the same input would otherwise produce `{ $expr: { $match: ... } }` — a syntactically valid Filter that MongoDB can't execute. But "throw with a fix-it message" was the second-cleanest option; "just do the right thing" is the cleanest. **More code = bad DX, less code = good DX** (from root [CLAUDE.md](../CLAUDE.md)) — applied to the keystrokes users have to type, not just to the MQL output.

Implementation in [src/index.ts](../src/index.ts): a four-condition check at the top of `lowerWithCtx` (not Pipeline, not UpdateFilter, not array-literal Pipeline, but **is** stage intent) constructs a synthetic `Pipeline` AST node (`{ type: "Pipeline", stmts: [ast], pos: ast.pos }`) and routes it through `generateImplicitPipeline`. So stage-specific behaviour (the `$match` index-friendly query translator; `$lookup` / `$unionWith` / `$facet` sub-pipeline recursion; let-binding scope rules) runs through exactly the same path it would in an explicit `;`-separated pipeline. The throw in `generateFilter` is gone; the function's contract is now "lower a Filter document" rather than "lower a Filter document or throw if Pipeline-intent is detected". `detectStageIntent` stays as a helper.

Test impact: the five existing tests asserting `toThrow(/Pipeline stage/)` — three in `test/codegen.test.ts`'s `stage-call-without-\`;\` guard` describe and two in `test/implicit-pipeline.test.ts` — were rewritten to expect the wrapped Pipeline output. The describes were renamed (`"stage-call-without-\`;\` guard"` → `"bare stage call auto-wraps as a one-stage Pipeline"`) and surrounding comments updated to reflect the new behaviour. All 1025 tests pass.

Doc updates: [docs/LANGUAGE.md](LANGUAGE.md) § Output dispatch was restructured — the rule table now reads "stage call / update filter / `;` / anything else" instead of the binary `;` vs no-`;`. The new "Stage call → Pipeline (no `;` required)" subsection sits between the Filter and multi-stage Pipeline sections. The function-form subsection now shows an expression-body arrow with a stage-call body as the third example. [README.md](../README.md)'s Highlights bullet was rephrased from "Filter vs Pipeline by the semicolon" to "Filter vs Pipeline picked automatically" with the new dispatch table embedded in prose. [docs/specs/filter-mode.md](specs/filter-mode.md) replaced the "Stage-call-without-`;` guard" section with a "Stage-call auto-wrap" section. Also added a new rule to root [CLAUDE.md](../CLAUDE.md) — **Maintain README.md** — so every observable library change must update the README in the same commit.

Pre-1.0 breaking output-shape change for one input shape (`jsmql("$match(...)")` used to throw, now returns an array). No grammar, AST, or runtime semantics change beyond the dispatch routing.

---

## 2026-05-20 — `jsmql()` always returns a pipeline for update-filter inputs

Single-statement update filters through `jsmql()` now lower to a **one-element pipeline array** (`[{ $set: { …RHS… } }]`) instead of the bare update document (`{ $set: { …RHS… } }`). Multi-statement update filters were already arrays; this change makes the single-statement case match. `jsmql.expr()` is **not** changed — it still produces the bare-doc shape for callers that want a building block to embed elsewhere.

The motivation is a silent footgun at the `db.coll.updateOne(filter, update)` call site. MongoDB only evaluates aggregation expressions on the RHS when the second `updateOne` argument is an **array** (pipeline form). The bare-doc form treats every value as a literal. So `db.users.updateOne({…}, jsmql("$.name = $.name.toUpperCase()"))` produced `db.users.updateOne({…}, { $set: { name: { $toUpper: "$name" } } })` — which compiled cleanly, looked correct in a logging line, and stored the literal object `{ $toUpper: "$name" }` in the `name` field at query time. Pure-literal update filters (`$.status = "done"`) happened to work in both modes, so the trap was invisible until a user wrote a real expression on the RHS. The README, LANGUAGE.md, and the realistic-test `usage` strings were all documenting the broken pattern. The user spotted it via the README example I'd just added.

The fix is a four-line addition to `lowerWithCtx` in [src/index.ts](../src/index.ts) — after the program lowers, if the AST is an `UpdateFilter` and the result is not already an array, wrap it once. `lowerExprWithCtx` (which `jsmql.expr` goes through) is left untouched, with a comment pinning the contrast in place. The split lives at the entry-point boundary, not inside `generateUpdateFilter` itself — the spec ([docs/specs/update-filter.md](specs/update-filter.md)) was updated to spell out which API wraps and which doesn't.

Test impact: 38 assertions in [test/update-filter.test.ts](../test/update-filter.test.ts), 5 in [test/implicit-pipeline.test.ts](../test/implicit-pipeline.test.ts), and 2 in [test/realistic.test.ts](../test/realistic.test.ts) updated to expect the wrapped array form. The implicit-pipeline `describe` that used to assert "single-statement inputs unchanged" was retitled and its comment rewritten — the new contract is "single-statement update-filter inputs always wrap as pipelines". The realistic-test `usage` strings for the two update-filter cases were repointed from `db.users.updateOne({…}, jsmql.expr(…))` to `db.users.updateOne({…}, jsmql(…))`, since that is the correct call shape now.

Doc updates: [README.md](../README.md)'s update-filter Tour comment and the headline `updateOne` example switched from `jsmql.expr(…)` to `jsmql(…)` with the wrapped output. [docs/LANGUAGE.md](LANGUAGE.md)'s § Update filters opens with the new pipeline-array contract, every code block in that section uses the wrapped form, and a new "Bare-document form via `jsmql.expr`" subsection documents the escape hatch with an explicit "do not pass this to `updateOne()`" warning. The § Partial expressions section gained a second differentiator bullet (update-filter input) and a matching ⚠️ warning. Breaking output-shape change to one branch of `jsmql()`; pre-1.0, so acceptable. No grammar or AST change.

---

## 2026-05-19 — Rename "Mutation" → "Update filter" (match the MongoDB driver)

"Mutation" was a jsmql-only invention. The MongoDB Node.js driver and the official docs call the second argument to `db.coll.updateOne(filter, update)` an **Update Filter** (TypeScript type `UpdateFilter<TSchema>`) — a document of update operators like `{ $set: …, $unset: … }`. We were quietly using our own word for it; now we use theirs.

Renamed across the repo:

- AST: `MutationProgram` → `UpdateFilter` (the `type: "UpdateFilter"` AST node), `Mutation` → `UpdateOp` (the `AssignExpr | DeleteStmt` union), and the `mutations: Mutation[]` field is now `ops: UpdateOp[]`.
- Codegen: `generateMutationProgram` → `generateUpdateFilter`, `generateMutationGroups` → `generateUpdateOpGroups`, `groupMutations` → `groupUpdateOps`, `collectMutationReads` → `collectUpdateOpReads`, `mutationWritePath` → `updateOpWritePath`, `mutationBuffer` → `updateBuffer`.
- Parser: `parseMutationProgram*` → `parseUpdateFilter*`, `parseMutation` → `parseUpdateOp`, `validateMutationTarget` → `validateUpdateTarget`, `describeMutationTarget` → `describeUpdateTarget`, `peekMutationSeparator` → `peekUpdateOpSeparator`, `makeIncDecMutation` → `makeIncDecUpdateOp`.
- Files: `test/mutations.test.ts` → `test/update-filter.test.ts`, `docs/specs/mutations.md` → `docs/specs/update-filter.md`. Describe titles in `test/realistic.test.ts` like `"Mutations: ..."` became `"Update filters: ..."`.
- Prose throughout `docs/LANGUAGE.md`, the specs, and the codebase comments swapped "mutation" / "Mutations" for "update op" / "Update filters". No behaviour change — `$.field = expr` still lowers to `$set` and `delete $.field` still lowers to `$unset`; the dispatch routing is identical.

Why this matters: the playground, tests, and docs are now greppable with one term that newcomers can also find in the MongoDB driver's own type declarations. No more guessing whether `Mutation` is a jsmql-specific concept or a thing they should look up in the MongoDB docs.

---

## 2026-05-19 — `jsmql.expr()` for partial / "unfinished" expressions

Added a third entry point alongside `jsmql()` / `jsmql.compile()` / `jsmql.validate()`: **`jsmql.expr(input)`** lowers a bare expression directly to its aggregation-expression form, with no Filter wrapper and no `$expr` envelope. Same three input shapes (string / arrow / template tag). Only the bare-expression branch differs from `jsmql()` — `;`-separated input still produces a Pipeline, update op chains still produce `$set`/`$unset`, array-literal Pipelines still pass through.

Why this exists: when the previous session shipped Filter dispatch as the no-`;` default, every test that wanted to assert a raw aggregation-expression shape (the vast majority of operator-codegen tests, and most realistic demos that compute a derived value) had to either wrap the expected in `{ $expr: … }` or wrap the source in a stage. That's noise. The user's complaint surfaced a real DX principle now memorialised in [CLAUDE.md](../CLAUDE.md): **more code = bad DX; less code = good DX** — applied to the user-facing MQL output, to the test corpus, and to the codebase itself. `jsmql.expr()` is the canonical example: `db.coll.find(jsmql(filter))` produces a Filter, `db.coll.updateOne(filter, jsmql.expr(update))` produces a bare update doc, and inside a hand-written `$project` / `$addFields` body `jsmql.expr(...)` drops in the raw expression. No `$expr` wrap at any of the three call sites.

Implementation in [src/index.ts](../src/index.ts): a new `lowerExpr` path mirrors the existing `lower` path, parametric on a single `ExprLowering` callback so the four-way AST dispatch (Pipeline / UpdateFilter / array-literal Pipeline / Expr) stays in one `lowerProgram` helper. The three input-shape branches (string / arrow / template tag) are now also factored into a single `dispatchInput` so adding `jsmql.expr` was ~30 lines of net addition — and a future `jsmql.update(...)` or similar would be trivially the same. `augmentForFunctionInput` continues to wrap the function-input lowering call so closure-ref errors keep their `jsmql.compile`/template-tag hint regardless of which entry point throws.

Test impact: the prior session's `test/helpers.ts` `agg()` adapter is gone — its callers (`test/codegen.test.ts`, `test/pipeline.test.ts`, `test/update-filter.test.ts`, `test/let-bindings.test.ts`) now call `jsmql.expr(...)` directly. Realistic-test playground examples that compute a value or run a non-predicate expression switched to `jsmql.expr(...)`; the four partial-translation predicate examples (order eligibility, file upload validation, insurance underwriting, parameterised threshold) stay on `jsmql(...)` and assert the partial Filter shape (`{ field: ..., $expr: { ... } }`) because that *is* the interesting output for those cases. New section [docs/LANGUAGE.md → Partial expressions](LANGUAGE.md#partial-expressions-jsmqlexpr) documents the API with the three side-by-side call sites (`find`, `aggregate`, `updateOne`) so users see the natural mapping at a glance.

---

## 2026-05-19 — Filter dispatch: reject bare stage calls with a `;` suggestion

`generateFilter` now runs a `detectStageIntent` guard before the translator. A top-level `$match(...)` / `$project(...)` / etc. (or the equivalent stage-object form `{ $match: ... }`) without a `;` is rejected with a precise error:

```
`$match` is a Pipeline stage, but the input has no `;` so jsmql would
lower it as a Filter — almost certainly not what you want.
Add a trailing `;` to make this a Pipeline: `$match(…);`.
```

Without the guard, `jsmql("$match($.age > 18)")` silently produced `{ $expr: { $match: { $eq: ["$age", 18] } } }` — a syntactically valid Filter, but `$match` isn't an aggregation expression, so the output is useless. The guard converts the silent footgun into an actionable error pointing at the one keystroke that fixes it. Non-stage operator calls (`$add(...)`, `$toLower(...)`) and predicates (`$.age > 18`) still flow through the regular Filter dispatch unaffected.

Implementation in [src/index.ts](../src/index.ts) via a new `detectStageIntent(ast)` helper that imports `lookupStage` from [src/stages.ts](../src/stages.ts). Six new test cases in [test/codegen.test.ts](../test/codegen.test.ts) cover both Pipeline-intent shapes, every registered stage, the `;`-recovery path, and the negative case (non-stage operator calls still work). The matching case in [test/implicit-pipeline.test.ts](../test/implicit-pipeline.test.ts) — which previously documented the silent `$expr` wrap — was rewritten to assert the new error. Spec update: [docs/specs/filter-mode.md](specs/filter-mode.md) gained a "Stage-call-without-`;` guard" section between the translator description and the function-form section.

---

## 2026-05-19 — Semicolon-driven dispatch: Filter vs Pipeline

`jsmql(input)` now picks its output shape from the presence (or absence) of a top-level `;`, using the Node.js MongoDB driver's own terminology. Inputs with **no `;`** lower to a **Filter** (the document `db.coll.find(filter)` takes); inputs with **any `;`** stay in **Pipeline** mode (the existing implicit-pipeline path, the array `db.coll.aggregate(pipeline)` takes). The function form mirrors the rule: an expression-body arrow `($) => …` lowers as a Filter; a block-body arrow `($) => { …; … }` lowers as a Pipeline. Breaking change to the no-`;` default — acceptable pre-1.0.

The Filter lowering reuses [src/match-translation.ts](../src/match-translation.ts) — the same translator the `$match` stage has used since 2026-03 to produce indexable query documents. Translatable conjuncts (field-vs-literal comparisons combined with `&&`/`||`) emit `{ field: { $op: lit } }` pairs; the residual rides in a top-level `$expr` (a legal Filter operator). So `jsmql("$.age > 18")` is now `{ age: { $gt: 18 } }` (indexable) and `jsmql("$add($.a, $.b)")` is `{ $expr: { $add: ["$a", "$b"] } }` (legal Filter for any expression). One translator, two callers.

Why this DX win: developers using `db.coll.find(…)` were the missing audience. Before this change `jsmql("$.age > 18")` returned `{ $gt: ["$age", 18] }`, which is wrong for `find()` and silently disables indexes when wrapped in `$expr`. After: the natural JS expression produces the natural Filter.

Naming follows the Node.js MongoDB driver's `Filter<TSchema>` type and the `pipeline` parameter on `Collection.aggregate(pipeline)` — so users reading our docs see the same words they see on mongodb.com. We deliberately do not invent jsmql-specific terms.

A new helper `generateFilter(ast, ctx)` ([src/index.ts](../src/index.ts)) composes `translateMatchBody` + the `$expr` residual. Pipeline-mode statement errors got a small upgrade too: `looksLikePredicate()` in [src/pipeline.ts](../src/pipeline.ts) detects comparison/logical/unary-`!` shapes used as bare statements and steers the wording to "wrap as `$match(...)`" — e.g. `$.age > 18;` throws with a concrete `$match($.age > 18)` suggestion and the offending statement's `.pos`. New spec [docs/specs/filter-mode.md](specs/filter-mode.md); user-facing reference [docs/LANGUAGE.md](LANGUAGE.md) gained an "Output dispatch: Filter vs Pipeline" section near the top, and the Quick Start now leads with the dispatch rule.

Test impact: the existing operator-codegen tests in [test/codegen.test.ts](../test/codegen.test.ts) — written against the old aggregation-expression default — were re-pointed at a new `agg()` adapter in [test/helpers.ts](../test/helpers.ts) that lowers through `generate()` directly, bypassing the Filter wrap. The operator codegen is independent of the top-level dispatch, so the same shapes are asserted without churn. New cases cover pure query-doc predicates, the `$expr` fallback, partial translation, compile-form parameter substitution, template-tag interpolation, Pipeline-mode bare-expression errors (message text + `.pos`), and the function-form expression-body / block-body parity. Realistic-test playground examples updated to demonstrate the new dispatch.

---

## 2026-05-18 — Playground: deep-linkable examples via URL hash

Selecting an example in [playground.html](../playground.html) now writes `#<slug>` to the address bar, and loading the page with a hash auto-selects that example. Slugs are the same kebab-case identifiers `scripts/sync-playground.mjs` already generates from each example's title — no schema change to the JSON island. A `hashchange` listener honours manual address-bar edits and back/forward; unknown slugs silently fall back to the first example. When the user freely edits the editor and the active highlight clears, the hash is cleared too so the URL never lies. History writes go through `history.replaceState` so stepping through the sidebar with arrow keys doesn't pollute browser history.

All changes are confined to the inline script in `playground.html` — outside the regenerated bundle/examples regions — so `sync-playground.mjs` won't overwrite them.

---

## 2026-05-17 — Doc fix: spread examples in Valid Constructs use field refs

The "Valid Constructs" bullet for spread in [docs/LANGUAGE.md](LANGUAGE.md) showed `[...arr]` and `{ ...obj }` — bareword identifiers that don't resolve in string-form jsmql and would have produced an `UnknownIdentifierError` if a reader copy-pasted them. Replaced with `[...$.arr]` and `{ ...$.obj }` so the examples actually compile, matching the field-ref shape used everywhere else in the bullet list and in the deeper Arrays/Objects subsections (lines 181-182, 194-195).

---

## 2026-05-17 — Array methods: fill the MDN list, bind `(element, index)`, shim mutators

A single pass over MDN's `Array.prototype.*` list to close the gap between "JS you already know" and what jsmql actually accepts. Three buckets:

**Six new method lowerings** ([src/codegen.ts](../src/codegen.ts:1915)). `.findIndex(p)` — the missing twin of `findLastIndex`, lowered to the same `$reduce`+`$zip` shape but with a `$$value == -1` guard so only the first match wins. `.lastIndexOf(x)` — `$let { revIdx: $indexOfArray($reverseArray(arr), x) }` then normalises back to the original index (or `-1`); strings rejected because MongoDB's `$indexOfCP` is forward-only. `.reduceRight(fn, init)` — `.reduce` with the input wrapped in `$reverseArray`. `.toSpliced(start[, dc, ...items])` and `.with(index, value)` — both build a 3-piece `$concatArrays` of `$slice` / literal / `$slice` inside a `$let` so the receiver and indices are evaluated once; negative literals are rejected at compile time because `$slice`'s position/length args are non-negative. `.toString()` — joins arrays with `","`, no-ops on strings, falls back to `$toString` on unknown receivers.

**`(element, index)` callback support across all 9 lambda-takers.** Prior to this pass, `requireLambda` didn't enforce arity, so `$.items.find((x, i) => x > i)` parsed and codegened but produced `$$i`-as-undefined-variable errors at query time. A new `arrayIterInput()` helper ([src/codegen.ts](../src/codegen.ts:2236)) returns the right input shape per param count: 1-param keeps the status quo (`as` = user name); 2-param zips the input with `$range(0, $size)` under a synthetic `as: "jsmqlPair"` and `$let`-wraps the body so the user's names resolve via the standard `lambdaParams` path; 3+ throws a tailored error. `.map`, `.filter`, `.find`, `.findLast`, `.some`, `.every`, `.flatMap` all run through it; `.findIndex` and `.findLastIndex` extend their existing `$let.vars` to optionally bind the second param; `.reduce` and `.reduceRight` accept `(acc, x, i)` with the input zipped and the body `$let`-wrapped around the existing `reduceRemap`-for-`acc`. The third `array` arg from MDN's signature is deliberately not supported — the receiver is already in scope at the call site, so re-binding it into every iteration would double cost for no expressive gain.

**13 DX shims** ([src/codegen.ts](../src/codegen.ts:2247)). The in-place mutators (`.sort`, `.splice`, `.push`, `.pop`, `.shift`, `.unshift`, `.fill`, `.copyWithin`) used to surface a generic "Unknown method, did you mean…" error; now each throws a tailored "mutates in JS; expressions are immutable. Use '.toSorted()' / '.toSpliced(start, deleteCount, ...items)' / `[...arr, x]` / `.at(-1)` / etc. instead." Iterator-returning (`.entries`, `.keys`, `.values`), void-returning (`.forEach`), and locale-dependent (`.toLocaleString`) methods get the same treatment with workaround hints (e.g. `.entries()` points at `.map((v, i) => [i, v])`). All shimmed names live in `KNOWN_METHODS` so typo suggestions still surface them when relevant.

37 new test cases in [test/codegen.test.ts](../test/codegen.test.ts) cover each new method, each shim, the 2-param happy path for every lambda-taker, and the 3-param rejection. One new realistic case in [test/realistic.test.ts](../test/realistic.test.ts) exercises `.with()` and indexed `.map((p, i) => …)` together. Tally: jsmql now implements 24 of MDN's 38 instance methods (everything that has a sensible MQL lowering) and produces actionable errors for the other 14.

Specs updated: [docs/specs/method-dispatch.md](specs/method-dispatch.md) (new rows, callback-parameters subsection, mutator-shim subsection). User-facing docs updated: [docs/LANGUAGE.md](LANGUAGE.md) (new methods in Simple/Lambda Methods, "Callback parameters" subsection, mutator-error table, optional-chaining neutral-value table).

---

## 2026-05-16 — Auto-`$literal` wrap for `"$..."` string values

User-supplied string literals (and `jsmql.compile()` bindings, and template-tag interpolations) whose value starts with `$` are now auto-wrapped in `{ $literal: value }` so MongoDB does not read them as field references at query time. The wrap fires on any `"$..."` shape in a *value* position — top-level, array element, object value, operator argument, method argument. Object **keys** are deliberately unaffected (MongoDB doesn't auto-evaluate keys, so `{ "$foo": 1 }` is how you intentionally name a field `$foo`).

Why this matters for DX: the existing behaviour quietly produced `{ $eq: ["$x", "$dangerous"] }` for `jsmql.compile(({ name }, $) => $.x === name)({ name: "$dangerous" })`. At query time MongoDB would compare `$x` against the value of field `dangerous` — a silent footgun if `name` ever came from user input. The wrap closes the gap so any `"$..."` string reaches the server as a literal.

Implementation: a new `insideLiteral?: boolean` field on `GenerateCtx` ([src/codegen.ts](../src/codegen.ts)). The `$literal(...)` operator codegen recurses on its argument with that flag set, suppressing the wrap inside the envelope so a literal-of-a-literal doesn't emit. `literalSafeString` is the single point where string literals are emitted; `safeBoundValue` walks `jsmql.compile()` param values recursively, applying the same policy to nested arrays and objects. `extendCtx` propagates the flag through lambda bodies; `freshSubPipelineCtx` drops it (a sub-pipeline starts fresh).

`$literal(...)` keeps working when called explicitly — the operator's fast-path codegen sits ahead of the `style === "object"` branch in `generateOperatorCall` so `$literal({ x: 1 })` is treated as a value to wrap, not as object-style named-key wire format. 14 new test cases in `test/codegen.test.ts` cover the auto-wrap shapes, the suppression inside `$literal`, the key vs. value distinction, the template-tag path, and the `jsmql.compile()` binding path with nested arrays and objects. Spec updated in [docs/specs/operator-registry.md](specs/operator-registry.md).

---

## 2026-05-16 — Parser: accept comma-chained parenthesized assignments

Prettier and oxfmt rewrite a top-level assignment chain like `$.a = 1, $.b = 2` to `($.a = 1), ($.b = 2)` when each assignment could otherwise be read as a destructuring assignment. The parser already accepted a single parenthesized assignment (`($.x = 5)`), but the comma-chained form failed with `Cannot assign to this expression …` because `parseUpdateFilterRest` called `parseUpdateOp()`, which called `parsePostfix()`, which returned a parenthesized `AssignExpr`, and then `validateUpdateTarget` rejected the `AssignExpr` as a non-field-path target.

`parseUpdateOp()` ([src/parser.ts](../src/parser.ts)) now short-circuits: if `parsePostfix()` returns something whose `type` is already `"AssignExpr"`, it's surfaced as a complete update op rather than running through `validateUpdateTarget` + `parseAssignmentChainFrom`. The paren-form `parseGrouped` path already builds the `AssignExpr` correctly — it just had no consumer at the comma-tail position. Three new cases in `test/update-filter.test.ts` cover the bare statement form, the function-body form (exactly the example LANGUAGE.md was claiming worked), and the mixed paren-assignment + paren-postfix-inc/dec form. The spec update lives in [docs/specs/update-filter.md](specs/update-filter.md).

---

## 2026-05-16 — LANGUAGE.md sync: five stale claims fixed

Audit pass over [docs/LANGUAGE.md](LANGUAGE.md) against the current implementation surfaced five claims that no longer matched what the compiler emits or rejects. All five are doc-only fixes; no source under `src/` changed.

1. **FAQ vs. type-aware dispatch contradiction.** The FAQ at the bottom of the file claimed `.includes()` / `.indexOf()` / `.concat()` on a bare `$.field` "defaults to string semantics," contradicting the canonical Array Methods section a few hundred lines above (which describes the runtime `$cond` on `$isArray`). The implementation matches the canonical section — see [src/codegen.ts:1597-1617](../src/codegen.ts). FAQ rewritten to describe the runtime dispatch and point at the type-hint workarounds.
2. **`$literal` "argument not evaluated" claim.** jsmql evaluates `$literal`'s argument like every other operator (`$literal($.a + $.b)` → `{ $literal: { $add: ["$a", "$b"] } }`). What's special about `$literal` is that *MongoDB* doesn't re-evaluate its contents at query time. Heading and prose rewritten to make the distinction.
3. **Unknown-method error format.** Docs claimed the error appends `String methods: trim, trimStart, …`; the actual message ends after the method name, with an optional `Did you mean '.trim()'?` when [closestNameTo](../src/levenshtein.ts) finds a near match ([src/codegen.ts:2021-2023](../src/codegen.ts)). Example updated to reflect the real format and to also show the suggestion case.
4. **`in` RHS error wording.** Doc copy was missing `object literal` from the accepted shapes — added by the `in` against object-literal RHS work and never backported here ([src/codegen.ts:951](../src/codegen.ts)).
5. **`$$NOW` in a update op example.** A pipeline example used `$.lastSeenAt = $$NOW` in source position, but jsmql has no JS-syntax surface for `$$NOW` — the lexer rejects `$$` at the start of an identifier. The example now uses `new Date()` (which lowers to `{ $toDate: "$$NOW" }` via [src/codegen.ts:593](../src/codegen.ts)), with the expected output updated to match.

---

## 2026-05-15 — Dual ESM + CJS distribution, Node 14+ as the floor

The package now ships a CommonJS build alongside the existing ESM one so `require('@koresar/jsmql')` works on Node 14+ CJS consumers without forcing them onto ESM. `package.json#exports` gained `import` / `require` conditions for both `.` and `./ops`; `main` is repointed at `dist/cjs/index.cjs` so older resolvers (or any tool that still ignores `exports`) get a working entry point. `module` is added for bundlers that key off it. Engines stays at `>=14` — that has been our claimed floor, but until now `"type": "module"` made a CJS-only Node app fail at `require()`.

The CJS bundles are produced by [scripts/build-cjs.mjs](../scripts/build-cjs.mjs): esbuild bundles each entry into a single `.cjs` file targeting `node14`, copies the matching `.d.ts` to `.d.cts` for `moduleResolution: nodenext` consumers, and writes a `dist/cjs/package.json` with `"type": "commonjs"` so Node treats the `.cjs` files as CJS regardless of the parent `"type": "module"`. Bundling — rather than per-file CJS emit — avoids the dual-package hazard where ESM and CJS would each carry their own copy of the parser/codegen and diverge on singleton state. The script runs as the second half of `npm run build` (after `tsc`).

A third smoke case in [test/smoke.test.ts](../test/smoke.test.ts) spawns `node --input-type=commonjs -e 'require("./dist/cjs/index.cjs")'` and exercises all three call shapes (string, arrow, template tag) plus `.validate()`. It's `skipIf(!exists(dist/cjs/index.cjs))` so local `npm test` stays fast, and active in `npm run smoke:dist` after a build. No source under `src/` changed; this is a packaging-and-publish-shape change only.

---

## 2026-05-15 — Package renamed to `@koresar/jsmql` on npm

The bare `jsmql` name was unavailable on npm — already taken — so the package now ships as the scoped `@koresar/jsmql` (with the `@koresar/jsmql/ops` subpath for ambient operator types). The "hopefully temporary" qualifier in commit 953520d's message reflects that we may still claim the unscoped name later if it becomes available; until then, every user-facing example, install instruction, and import snippet uses the scoped specifier.

Updated every doc, comment, and test description that suggested `require("jsmql")` / `import { jsmql } from "jsmql"` / `import "jsmql/ops"`: [README.md](../README.md), [docs/LANGUAGE.md](LANGUAGE.md) (Quick Start, Function Form, `jsmql.compile`, Template-Tag, Validation sections + the Operator-autocomplete heading and tsconfig note), [docs/specs/ops-generation.md](specs/ops-generation.md), [docs/specs/operator-registry.md](specs/operator-registry.md), [docs/specs/function-form-params.md](specs/function-form-params.md), [docs/specs/architecture.md](specs/architecture.md), the four CLAUDE.md files (root, `src/`, `docs/`, `scripts/`), [test/realistic.test.ts](../test/realistic.test.ts) (top-of-file comment + the `Compile form: ambient ops via …` describe), [test/smoke.test.ts](../test/smoke.test.ts), [src/index.ts](../src/index.ts) (`FunctionInputError` re-export comment), and the generator [scripts/generate-ops.mjs](../scripts/generate-ops.mjs) (header comments and the `// User-facing import shape` block embedded in the generated `src/ops.ts`). Earlier DEVLOG entries that reference the bare name are left as-is — they describe state at write time. The runtime contract (input shapes, output shapes, error types) is unchanged; this is a documentation-and-published-name change only.

Verification: `npm run generate:ops` refreshes `src/ops.ts` (which carries the user-facing `import "@koresar/jsmql/ops"` comment block), the drift check in `test/operator-spec-coverage.test.ts` stays green, and `npm test` passes. `package.json` already shipped as `@koresar/jsmql` in commit 953520d; this entry brings the in-repo documentation in line with the published name.

---

## 2026-05-15 — `.reduce()` accumulator type narrowing trims the dead `$isArray` cond

`acc[k]` inside `reduce((acc, x) => ({ … }), {})` (and the array-symmetric `reduce(…, [])`) now compiles to a bare `$getField` / `$arrayElemAt` instead of the 3-branch `$cond` on `$isArray` that the bracket-access codegen used to emit for every non-structurally-known receiver. The codegen ctx gains a `bindingTypes` field ([src/codegen.ts:80](../src/codegen.ts)); reduce-codegen ([src/codegen.ts:1936-1991](../src/codegen.ts)) pins `params[0]` to `"object"` or `"array"` when **both** `initialValue` and the lambda body are statically the same compound type. The IndexAccess case ([src/codegen.ts:444-484](../src/codegen.ts)) reads it to short-circuit the dispatch, and flips the optional-chain `$ifNull` fallback to `{}` on the known-object branch so a null receiver doesn't feed `$getField` an array.

The both-sides-must-agree rule exists because `$$value` after iteration `i ≥ 1` is the body's return from `i-1`, not the initialValue — narrowing on the initial alone is unsound the moment the body returns a different shape (`reduce((a,x) => x.foo, {})` legitimately keeps the cond). When both agree, the type is invariant across iterations. Nested reduces that reuse the accumulator name explicitly shadow the outer narrowing (the inner's `bindingTypes` entry overwrites or deletes the outer's), so `outer-object → inner-array` doesn't miscompile inner `acc[0]` as `$getField`. `isObjectProducing` is the minimum-viable `expr.type === "ObjectLiteral"` check; broadening it to `$mergeObjects` / `$arrayToObject` operator calls is left for when a real case shows up.

This cleans up the README's headline histogram example ([test/realistic.test.ts:75-148](../test/realistic.test.ts)) — the 3-branch `$cond` block disappears from the demo MQL panel in the playground. The new `describe("reduce accumulator type narrowing", …)` block in [test/codegen.test.ts](../test/codegen.test.ts) covers positive object + array cases, three negatives (body diverges, non-literal initial, element param not narrowed), the nested-reduce shadow, and the optional-chain fallback flip. [docs/specs/method-dispatch.md](specs/method-dispatch.md) documents the new field and the three-way IndexAccess dispatch.

---

## 2026-05-15 — Sync CLAUDE.md to the actual public-API shape

Root [CLAUDE.md](../CLAUDE.md) used to describe the public API as "two exports from `src/index.ts`: `jsmql(input)`, `validate(input)`". That hadn't been accurate for a while — `validate` is a property on `jsmql` ([src/index.ts:281-284](../src/index.ts)), not a top-level named export, and `jsmql.compile()` (the parameterised, pre-compile path) wasn't mentioned at all despite being a first-class feature with its own [spec](specs/function-form-params.md) and [LANGUAGE.md section](LANGUAGE.md#parameterised-queries-jsmqlcompile). The framing leaked into the file-map, the semver note, and into `docs/CLAUDE.md`'s LANGUAGE.md guidance.

Replaced the "two exports" paragraph with the actual shape: `jsmql` is a callable that carries `.compile` and `.validate` as properties, built via `Object.assign` because the strippable-TS rule forbids `namespace`. The shape rationale is now also surfaced in [src/CLAUDE.md](../src/CLAUDE.md) so future-Claude (and future-anyone) extends the surface the same way next time. Added an explicit scope line: jsmql targets aggregation expressions and pipeline stages, not `db.collection.find()` filter documents — preventing the article-style framing from creeping in. The corresponding line in [docs/CLAUDE.md](CLAUDE.md) was updated to name `jsmql.compile()` and `jsmql.validate()` instead of a free-standing `validate()`.

Docs-only change. No code under `src/` touched, no tests changed.

---

## 2026-05-15 — Widen the dist support floor to Node 14

`package.json` `"engines"` drops from `>=24` to `>=14`, and [tsconfig.json](../tsconfig.json) gains `"target": "es2020"` so the emitted JS pins to a syntax level v14 actually supports. The previous `"engines"` floor was tied to the source-tree invariant (`src/` runs as-is on Node 24+ via native type-stripping), but that constraint never applied to the dist — `dist/index.js` is plain JS and runs anywhere the syntax does. With no `target` set, `tsc` was preserving modern syntax verbatim, which left `?.` and `??` in the dist and shut out anything below v14 unnecessarily.

A sweep across the user's installed Node versions confirmed the floor: v12.18.3 fails on `??` (and on `?.` before that), v14.21.2 through v24.15.0 all pass the smoke script (string / arrow / template-tag forms plus `validate()`). v12 reaches end-of-life territory and v14 is the lowest LTS anyone realistically still runs, so that's where the new floor sits. The strippable-TS invariant is unchanged — `src/` still requires Node 24+ for native type-stripping, that's a source-running-as-script concern that's orthogonal to the dist.

No code under `src/` changed and no tests changed; the existing dist-import smoke in [test/smoke.test.ts](../test/smoke.test.ts) is the in-repo regression test. The full suite (899 tests across 12 files) is green on the rebuilt dist.

---

## 2026-05-15 — `;`-separated pipelines are the canonical surface form

The user-facing docs and realistic-test examples now position the `;`-separated pipeline form as canonical, with the bracketed `[…]` form demoted to an alternative for verbatim MQL copy-paste and "I need an actual array literal" cases. The runtime accepts both forms unchanged — this is an editorial reshuffle, not a language change.

[docs/LANGUAGE.md](LANGUAGE.md)'s `## Pipelines` section was rewritten: the canonical-form heading is now "Canonical form: `;` between stages", with a block-body-arrow example up front and the string template-literal form right after it. The `[…]` form lives under "Alternative: bracketed array literal" with both stage-call and stage-object variants, framed as "for porting MQL you've copied verbatim". The "Detection and typos" subsection now describes how both forms enter pipeline mode. [docs/specs/aggregation-stages.md](specs/aggregation-stages.md) was updated to mirror the new ordering and to name the `;`-separated form as canonical in the spec text itself.

[test/realistic.test.ts](../test/realistic.test.ts) lost its array-shaped jsmql input: the `pipeline: top-orders report by department` and `pipeline: count orders by status per shop` describes were converted from bracketed templates to `;`-separated templates plus block-body-arrow function-form equivalents. The invoice-finalisation pair was reordered and renamed — the canonical describe is now `e-commerce: invoice finalisation pipeline` (`;` form), with `e-commerce: invoice finalisation pipeline (alternative bracketed array form)` immediately after as the equivalence demonstration. The three array→`;` and three `;`→array equivalence assertions across the test file stay green, so we still prove behavioural identity between the forms. Test count drops by one — the block-body arrow case that previously lived as a separate `it` got merged into the canonical describe's main test because they now demonstrate the same thing.

The playground re-syncs from these test changes via the existing PostToolUse hook, so the example list users see at [playground.html](../playground.html) now showcases the `;` form for those three pipelines too. The bundled examples include one explicit array-form holdout (the new "alternative bracketed array form" describe) so users can still discover the form when they need it.

Out of scope (intentional): no code under `src/` changed, and `test/pipeline.test.ts` still exercises both forms — the parser, codegen, and `isPipelineAst` detection logic continue to treat the two surface forms as peers. The change is purely about what we recommend and what the realistic examples demonstrate, not what the language accepts.

---

## 2026-05-15 — `?.` is now a real safety annotation, not a comforting lie

Optional chaining used to be sugar — both `$.a.b` and `$.a?.b` produced the same `MemberAccess` AST node and the same compiled MQL. The docs justified this with "MongoDB's dotted-path semantics already null-pass through missing fields", which is true at the field-read site but false at every downstream operator that null-poisons or hard-errors on null input. A user reported the textbook case: `[...$.moderators, ...$.room?.mods, "root"].includes($.userId)` compiles to a `$concatArrays` that returns null when `$.room` is missing, which then crashes the wrapping `$in` with *"requires an array as a second argument"*. The `?.` looked safe but produced a query that crashed on exactly the input shape it claimed to guard against.

The parser now preserves the `?.` distinction by setting `optional: true` on the `MemberAccess` / `IndexAccess` / `MethodCall` node it consumes (see [src/ast.ts](../src/ast.ts), [src/parser.ts](../src/parser.ts)'s `parsePostfix`). Codegen ([src/codegen.ts](../src/codegen.ts)) adds two small helpers — `chainHasOptional(expr)` and `wrapIfNull(value, fallback)` — and consults them at every null-unsafe consumer slot to wrap the chain's result with `$ifNull(v, neutral)` where `neutral` is the empty value matching the consumer: `[]` for array consumers (spread, `.map` / `.filter` / `.reduce` / `.includes` / `.length` / `Object.fromEntries` / `new Set` / array index), `""` for string consumers (`.trim` / `.toUpperCase` / `.split` / string `+` / template literals), and `{}` for object consumers (non-foldable `MemberAccess` → `$getField`, `Object.keys` / `.values` / `.entries`). The chain walker stops at `MethodCall` boundaries — once a method has run (and applied its own wrap if its receiver chain was optional), the value is the method's return, not the original chain. Deliberately *not* wrapped: object spread (`$mergeObjects` ignores null operands), comparisons, `$cond` / `&&` / `||` condition, `$in` first arg, and numeric arithmetic (matching JS's `1 + undefined === NaN` semantics with honest null instead of silently substituting 0).

This is a behavioural change, not a bug fix in the strict sense — any user with `?.` in their existing jsmql and a snapshot of the literal compiled MQL will see different output. The MQL is *more* correct (matches the JS semantics they reasonably expected), but the shape differs. Pre-1.0 makes this fair game. The five existing optional-chaining cases in [test/codegen.test.ts](../test/codegen.test.ts) had their assertions updated to reflect the wrap, plus ~20 new cases cover every consumer family and the "deliberately not wrapped" set (object spread, comparisons, `==` null, numeric `+`, `?.` inside a lambda body). New [test/realistic.test.ts](../test/realistic.test.ts) cases use the original chat-moderation example and a user-display-name template literal. Docs in [docs/LANGUAGE.md](LANGUAGE.md) and [docs/specs/method-dispatch.md](specs/method-dispatch.md) gained consumer tables and the "stop at MethodCall" rule.

---

## 2026-05-14 — `jsmql.validate` accepts compile-form arrows (same shape as `jsmql.compile`)

`jsmql.validate` now accepts the parameterised arrow shape that `jsmql.compile` accepts — `({ minAge }, $) => …` and friends — in addition to the one-shot string / function / template-tag inputs it has always taken. Motivation: when the user writes `jsmql.validate(({ age }, $) => …)`, TypeScript was contextually typing the second parameter as `JsmqlOps` (because the existing `JsmqlInput` overload's `JsmqlFn` is `($: any, ops: JsmqlOps) => unknown`), which made `$.dob` fail in the IDE even though the runtime accepted the expression. The new overload `validate<P>(fn: JsmqlCompileFn<P>)` is listed first in source order so TS picks `(params: P, $: any, ops: JsmqlOps)` for any two-or-three-parameter arrow, leaving `$: any` and `$.dob` typing cleanly.

Runtime change at the same time: `validateInput` no longer routes function inputs through `jsmqlDispatch` (which rejected compile-form arrows with an unhelpful "use `jsmql.compile`" message). It now parses the arrow directly via `parseFunctionInput`, resolves each `ParamBinding` to a `null` placeholder before `lowerWithCtx` runs, and surfaces any errors through the existing `errorToValidationResult` mapping. Values don't affect syntactic validity — only that bound names resolve as `ParamRef` rather than unknown identifiers. The compile *invocation* path (`jsmql.compile(fn)(params)`) stays throw-style, since per-call binding errors carry the caller's runtime values and belong in normal error handling.

Files: [src/index.ts](../src/index.ts) (new overload, inline function-input branch in `validateInput`); [docs/specs/architecture.md](specs/architecture.md), [docs/specs/function-form-params.md](specs/function-form-params.md) (signature listing + rationale). The existing "accepts an arrow function" case in [test/realistic.test.ts](../test/realistic.test.ts) is the regression test — it already failed in the IDE under the old types even though its assertions passed at runtime.

---

## 2026-05-14 — Thread `.pos` through codegen and adapter errors so `.validate()` honours its contract

Every AST node in [src/ast.ts](../src/ast.ts) now carries a required `pos: number` field, populated by the parser at every construction site from the leading token of each construct (literal token for literals, opening delimiter for collections, operator for binary/unary/ternary, `let`/`delete`/`$`/`$.` keyword for statements and refs). `CodegenError`, `UnknownIdentifierError`, and `FunctionInputError` all gained `readonly pos: number` fields and a constructor parameter, and every throw site forwards the appropriate node or token offset. `errorToValidationResult` in [src/index.ts](../src/index.ts) now passes `err.pos` through for codegen and function-input errors instead of the previous `0` placeholder, closing the gap the [CLAUDE.md](../CLAUDE.md) DX rule called out in the prior commit.

`JsmqlInterpolationError` stays at `.pos = 0` for the documented reason: the template-tag form's source text lives across the `strings` and `values` arrays, and there is no single byte offset to report. Callers needing to locate a failing interpolation read `.slot` (1-based index) or `.key` (parameter name) on the underlying error class. `RangeError` / `TypeError` / generic catch-all also stay at `0` — they come from outside our control.

[test/error-pos.test.ts](../test/error-pos.test.ts) is new — focused assertions that `.pos` lands on the right region for every error class (lexer, parser, codegen, function-input, interpolation). The four cases in `test/realistic.test.ts`'s `describe("jsmql.validate(): realistic error cases", …)` block grew `.pos` range assertions so the contract is exercised at the integration level too. Specs in [docs/specs/architecture.md](specs/architecture.md), [docs/specs/let-bindings.md](specs/let-bindings.md), [docs/specs/update-filter.md](specs/update-filter.md), and [docs/specs/function-form-params.md](specs/function-form-params.md) were updated to describe the new invariant.

Out of scope for this change (intentional, called out in the plan): sub-node positions on individual `KeyValueEntry` / `SpreadElement` / array-element members beyond what the AST already carries, and a synthesised offset for interpolation errors. The parent-node `pos` already covers ~60 of the ~70 codegen throw sites; sub-node precision is a follow-up if a real user hits it.

---

## 2026-05-14 — DX rule: `.validate()` errors must always carry a meaningful `.pos`

Added a new sub-bullet under "#1 priority: developer experience" → "Errors stay consistent and helpful across the surface" in [CLAUDE.md](../CLAUDE.md). The rule states that every `ValidationError` returned by `validate()` must have a real source offset in `.pos`, not the `0` placeholder. Tooling consumers (editor integrations, the playground) rely on `.pos` to underline the offending region, and the public `ValidationError` shape already declares `.pos: number` as required — returning `0` silently breaks that contract while still type-checking.

An audit of every throw site reachable from `validate()` found that only `LexError` and `ParseError` set `.pos` to a real byte offset. `CodegenError`, `UnknownIdentifierError`, `FunctionInputError`, `JsmqlInterpolationError`, and the catch-all in [src/index.ts](../src/index.ts) all fall back to `.pos = 0`. Root cause: AST node types in [src/ast.ts](../src/ast.ts) carry no position field — the parser discards token offsets when it builds nodes, so codegen has nothing to forward even when it knows which node is at fault. No test currently asserts `.pos > 0`, so the gap is invisible to CI.

The rule is recorded as a forward-looking principle; the implementation gap (threading positions through the AST + codegen + adapter throws + adding test coverage) is a separate task to be planned and landed next.

---

## 2026-05-14 — Drop the implicit LRU cache from one-shot `jsmql(fn)`

The 256-entry `fnBodyCache` in [src/index.ts](../src/index.ts) is gone. The function-input branch of `jsmqlDispatch` now extracts the body, parses, and lowers without consulting or populating a cache. `cacheGet`, `cacheSet`, the cap constant, and the surrounding rationale comment were all deleted along with the `describe("function-body cache is bounded", …)` block in [test/security.test.ts](../test/security.test.ts) that asserted LRU eviction correctness over 300 distinct bodies.

The trigger was user feedback that one-shot queries — those parsed once at process startup and never re-executed — occupy cache slots indefinitely (well, until 256 newer entries push them out). A literal `Map` → `WeakMap` swap was the proposed fix but isn't possible: `WeakMap` requires *object* keys and the current key is the body string (a primitive), and `WeakMap` exposes neither `.size` nor iteration, so the cap can't be preserved on top of it. The two alternatives — keying on the `Function` object (which loses inline-hot-loop dedup, since each iteration creates a fresh function instance) or running a hybrid Map + WeakMap — both kept the implicit-cache footgun without much to show for it.

`jsmql.compile(fn)` is the right answer for repeated execution: it parses once, returns a closure that captures the AST, and walks that AST with fresh `params` substitutions on every call. The migration is one line — `const q = jsmql.compile(fn); q(params)` instead of `jsmql(fn)` — and the caller's intent is now explicit at the call site rather than buried in an implicit LRU. The string-input and template-tag paths were never cached and stay that way.

Files: [src/index.ts](../src/index.ts) (delete cache helpers + simplify function-input branch); [test/security.test.ts](../test/security.test.ts) (remove LRU-eviction smoke test); [test/codegen.test.ts](../test/codegen.test.ts) (rename "(cache correctness)" test — the consistency-across-calls property still holds, it just no longer depends on caching); [README.md](../README.md) (point users to `jsmql.compile(fn)` for repeated execution); [docs/specs/architecture.md](specs/architecture.md), [docs/specs/function-form-params.md](specs/function-form-params.md) (spec updates to match).

---

## 2026-05-14 — Playground pipeline examples dedent past the lone-opener `[`

The three pipeline examples that came in through `jsmql\`[\n  $match(...)\n  ...\n]\`` tagged templates — `top-orders-report-by-department`, `count-orders-by-status-per-shop-accumulator-replacement`, `invoice-finalisation-pipeline-update ops-match` — were rendering in the playground with the raw test-file indent (6-space body, 4-space closer) instead of the canonical 2-space pipeline shape. Root cause: the `dedent()` helper in [scripts/sync-playground.mjs](../scripts/sync-playground.mjs) computes the global minimum indent across all non-empty lines, but a template that starts with `[` directly after the backtick puts that opener on line 1 at column 0, dragging the minimum to zero and short-circuiting the strip. The simple-expression cases sidestep this because they either fit on one line or start with `\n` (so the first content line is itself indented).

Added a small fallback: when the global min is zero *and* the first line is a lone opener (`[`, `{`, or `(`), measure the minimum indent of the body lines and strip that instead. The opener stays at column 0, the body lines drop to a canonical depth (typically 2 spaces because the test-file closer was 4 spaces in), and nested structure is preserved at relative depth. Verified by hand against all three pipeline examples in the live playground — they still parse and produce the same MQL, just with readable indentation.

Also extended [`.oxfmtrc.json`](../.oxfmtrc.json) to ignore `playground.html`. The two managed regions inside the file (the minified jsmql IIFE bundle, the JSON-island manifest) are both generator output that needs to stay byte-stable; oxfmt's pretty-printer was unfolding the bundle from one line to ~5000 between syncs, which created huge spurious diffs and forced contributors to remember to re-run `sync:playground` after every `format`. The file is regenerated by `sync-playground.mjs` and doesn't need oxfmt's attention.

---

## 2026-05-14 — `playground.html` becomes a self-sufficient single-file artifact

[playground.html](../playground.html) used to need two sibling assets at runtime — `./dist/index.js` (the tsc output) and `./playground-examples.json` (the example manifest written by `sync-playground.mjs`). That made it impossible to ship on its own: you couldn't email it, drop it on a static host, or just double-click it from disk, because Chrome blocks `fetch()` from `file://` URLs and the dist import obviously can't resolve without the rest of the build.

Now the file is fully self-contained. [scripts/sync-playground.mjs](../scripts/sync-playground.mjs) was extended to also bundle [src/index.ts](../src/index.ts) via esbuild as an IIFE — `format: "iife"`, `globalName: "JSMQL"`, `minify: true`, `target: "es2022"`, `platform: "browser"` — and inject the result into a managed region in `playground.html` between `<!-- jsmql-bundle:start -->` / `<!-- jsmql-bundle:end -->` comments. The examples manifest is no longer a sibling JSON; it lives inside a second managed region as a `<script type="application/json" id="examples-data">` JSON island. The module script then reads `const { jsmql } = globalThis.JSMQL;` and parses the JSON island synchronously instead of fetching. The only external dependency remaining is the CodeMirror CDN — explicitly kept out of the bundle, the user wanted the syntax highlighter to stay external.

The script is now also wired into `prebuild`, so `npm run build` keeps the playground in sync with both the test file and the library source. `playground-examples.json` was deleted (its data lives inside the HTML now). The output file is ~130 kB and the script is idempotent — running `npm run sync:playground` a second time exits 0 without writing if nothing changed. Verified end-to-end against a local static server: example selection populates, prettify works, and the syntax-error marker still highlights the offending position with no fetches to `./dist/` or `./playground-examples.json` in the network log.

Adds `esbuild` to `devDependencies`. The one DX trade-off worth noting: edits to `src/*.ts` outside Claude Code now need a manual `npm run sync:playground` (or `npm run build`) to re-embed the bundle — the existing PostToolUse hook only fires on `test/realistic.test.ts` edits. A src-watching hook is a possible follow-up.

---

## 2026-05-14 — Error-message sweep: friendlier wording, "Did you mean?" everywhere, lexer stops leaking enum names

A pass over every `throw` site in `src/` to tighten messages that had drifted or were just unhelpful. DX is the project's #1 priority and error text is the user's tightest feedback loop, so the bar is high. Changes are wording + a few small structural fixes; no behaviour change beyond the inevitable shift in what `err.message` contains.

The biggest single fix is in [src/lexer.ts](../src/lexer.ts): `Lexer.expect()` used to interpolate the internal `TokenType` enum name into the message, so a user-facing error read `Expected LParen but got Ident ('foo') at position 12`. The new `TOKEN_DISPLAY` map produces `Expected '(' but got an identifier 'foo' at position 12`, and the `formatActualToken` helper drops the redundant `('${value}')` suffix for punctuation where the display already *is* the lexeme. The change ripples through every `lexer.expect(...)` call, which is roughly thirty parser productions; the two tests in [test/codegen.test.ts](../test/codegen.test.ts) that had accidentally locked the old wording in (`/Expected LParen/`) were updated.

The other systematic fix is consistency around "Did you mean?" suggestions. Pipeline-stage lowering and instance-method dispatch already used `closestNameTo` from [src/levenshtein.ts](../src/levenshtein.ts); the five static-method gates (Math, Date, Array.X, Number.X, Object.X) and the Set / regex method dispatchers in codegen now do too. The Math member error used to dump all 26 supported method names into the message; the new version shows only the closest match plus a doc pointer. Smaller polish: every method-arg-count error in [src/codegen.ts](../src/codegen.ts) now names the missing parameter (`charAt(index)`, `startsWith(searchString)`, `at(index)`, `slice(start[, end])`, …) so the user can self-correct without leaving the error. The `validateUpdateTarget` fallback in [src/parser.ts](../src/parser.ts) now names the *kind* of expression the user wrote (`Cannot assign to a method-call result ('.trim()') at position 11 — only field paths …`) via a new `describeUpdateTarget` helper.

Internal-invariant throws — the seven `Internal: …` / `generatePipeline expects an ArrayLiteral AST` sites that should be unreachable in valid programs — are now routed through a single `internalError(detail)` helper in [src/codegen.ts](../src/codegen.ts) that produces `jsmql internal error (please report to the jsmql maintainers): <detail>`. Easier to grep, and the prefix tells anyone who sees it that this is a bug rather than something they wrote wrong.

One drift candidate worth flagging: `Number.isFinite()` rejection. The old message said "MQL has no Infinity literal" and pointed at `$convert`. Tightened to spell out three concrete workarounds. Lifting the restriction needs a JS-syntax surface for `Infinity` / `NaN` literals so we can emit comparisons in MQL — that's its own design problem, tracked separately.

---

## 2026-05-14 — Playground "Prettify" uses fit-or-break layout

The Prettify checkbox in [playground.html](../playground.html) used to be a flat `JSON.stringify(out, null, 2)`. That expanded every nested array and object onto its own line, so trivial MQL like `{ "$gte": ["$cart.total", 50] }` ballooned to seven lines and the output panel was mostly whitespace and brackets. The compact form (`indent: 0`) had the opposite problem — one long unreadable line.

Replaced with a small `pretty()` function: build the compact single-line form (`{ "k": v, ... }` with spaces inside braces, `[a, b]` without spaces inside brackets), and only break the node if its compact form wouldn't fit before column 80 at its actual starting column. Recursion descends into children with their real starting column (`indent + 2 + len('"key": ')` for object values), so the 80-col budget is respected exactly rather than approximated. The unprettified branch is now a plain `JSON.stringify(out)` — no indent argument at all — since the only reason to set indent before was the prettify path.

UI-only change, no behaviour change in the library. Verified by hand against the playground examples: short comparisons stay on one line, long pipelines wrap, and the cart/premium example now renders as the four-line target shape from the request that prompted the change.

---

## 2026-05-14 — `jsmql.compile()` accepts a string source

`jsmql.compile()` now accepts a string containing the arrow source in addition to a real arrow function — `jsmql.compile("({ minAge }, $) => $.age > minAge")` is equivalent to passing the function value. This brings `compile()` in line with `jsmql()` and `jsmql.validate()`, both of which already polymorph over string / arrow / template tag. The motivating use case is queries stored externally (config files, database rows, admin tooling): callers who only have the text can still benefit from the parse-once-bind-many semantics that make `compile()` more than a wrapper around `jsmql()`.

The implementation is small: [src/index.ts](../src/index.ts) gains an overload on `compileFunction` and a `typeof input === "string"` branch that uses the string directly as `src`. Everything downstream — `parseFunctionInput`, the bindings map, the closure shape — is unchanged. A string without an arrow shape inherits the existing `FunctionInputError` ("jsmql expects an arrow function `($) => …`"); a value that is neither a function nor a string throws `TypeError` from the entry point.

We explicitly **did not** add a `${name}`-placeholder syntax inside compile strings, even though it would superficially look like template-tag syntax that users already know. Two reasons. First, the strict-JS-subset rule (root [CLAUDE.md](../CLAUDE.md)) requires that every expression jsmql accepts be valid JS — `${id}` outside a template literal isn't, so the string contents would no longer "copy-paste into a JS file and parse." Second, plain-string `${name}` placeholders are a footgun next to real template literals: a user who writes `` jsmql.compile(`… ${id} …`) `` with backticks (easy, especially for multi-line queries) gets JS-time interpolation, not deferred binding — silently breaking the `compile()` contract. Keeping the destructure as the single parameter-declaration mechanism preserves the invariant in both directions: anything `jsmql.compile()` accepts is valid JS, and the only way values reach the MQL output is through the params object at call time. The tagged-template form of `compile()` was rejected on the same reasoning — interpolation happens at tag-evaluation time, which is the wrong time for a "compile once, bind many" surface.

Test coverage in [test/codegen.test.ts](../test/codegen.test.ts) under the new `describe("string input")` block; spec updates in [docs/specs/function-form-params.md](specs/function-form-params.md) and the user-facing reference in [docs/LANGUAGE.md](LANGUAGE.md#string-input).

---

## 2026-05-14 — `tsconfig.test.json` so the IDE stops flagging `node:` imports in test files

The root [tsconfig.json](../tsconfig.json) has `rootDir: "src"` and `include: ["src"]` because that's what the published build needs. Side effect: when the IDE opens a file under `test/`, the TypeScript language service decides the file doesn't belong to any project, falls back to inferred-project mode, and never auto-picks `@types/node`. Result is `TS2591: Cannot find name node:child_process` on every `import { spawnSync } from "node:child_process"` in `test/smoke.test.ts`, `test/operator-spec-coverage.test.ts`, etc. The IDE's own JS/TS resolver still finds the symbols, so hovers and completions work — but the module specifier sits there permanently red.

Fix is a dedicated [tsconfig.test.json](../tsconfig.test.json) that extends the root config, covers `test/`, sets `noEmit: true`, and explicitly opts back out of TS 6's strict-by-default (`strict: false`, `noImplicitAny: false`, plus `types: ["node"]` since auto-include of `@types/*` doesn't always fire under `moduleResolution: "bundler"` when `types` is unset). Kept lenient on purpose — the goal is to scope test files into a project so `@types/node` resolves, not to start type-checking the test corpus, which has long-standing intentional patterns (e.g. `jsmql(() => $.age > 18)` references a `$` that only exists in the source-text view, not the JS scope) that wouldn't survive strict mode and aren't a real bug.

`npm test` is unaffected — vitest does its own transpilation and doesn't look at this file. The only consumer is the IDE/editor TypeScript service. `scripts/*.mjs` weren't included because they're plain JS, not TS, so the original error never reached them.

---

## 2026-05-13 — `$match` emits index-friendly query docs by default

A naïve `$match($.email === "alice")` used to compile to `{ $match: { $expr: { $eq: ["$email", "alice"] } } }`. The wrapping was correct MQL — and a silent performance cliff. MongoDB's planner won't use indexes inside `$expr`, so what looks like a one-field lookup becomes a collection scan. Users who hadn't read the MongoDB internals couldn't tell from the jsmql expression that anything was wrong.

The new behaviour: when the `$match` body is a translatable predicate — field-vs-literal comparisons (`===`/`==`/`!==`/`!=`/`>`/`>=`/`<`/`<=`) combined with `&&` and `||` — it lowers to the query-document form (`{ email: "alice" }`, `{ age: { $gt: 18 } }`, `{ $or: [...] }`). Indexes work; the developer didn't have to know. When part of the predicate is translatable and part isn't, the translator extracts what it can and emits both: `{ status: "active", $expr: <residual> }`. The planner uses the `status` index, then evaluates the residual on the narrowed set. The fully-untranslatable path still wraps in `$expr` — methods, ternaries, field-to-field comparisons, computed values.

Implementation in [src/match-translation.ts](../src/match-translation.ts); wired into the existing `$match` lowering in [src/pipeline.ts](../src/pipeline.ts). The query-language semantics differ from aggregation `$eq` in four ways (array-element matching, `$ne` and missing fields, field-to-field comparison, `=== null` matching missing) — these are documented and accepted as the right defaults; users who need strict aggregation `$eq` opt out via the existing object-literal body path (`$match({ $expr: <expr> })`). Full translation rules and rationale: [docs/specs/match-query-translation.md](specs/match-query-translation.md).

Breaking output-shape change, locked in by tests in [test/pipeline.test.ts](../test/pipeline.test.ts), [test/realistic.test.ts](../test/realistic.test.ts), and the new [test/match-translation.test.ts](../test/match-translation.test.ts). Pre-1.0; the public API contract still cycles freely until the package commits to a 1.0.

---

## 2026-05-13 — `jsmql.compile(fn)` for reusable parameterised queries; `validate` moves under `jsmql.validate`

The function form's headline restriction has always been **no outer-scope variables**. `Function.prototype.toString()` returns source text without a closure, so `const minAge = 21; jsmql(($) => $.age > minAge)` could never resolve `minAge` and threw `Unknown identifier`. Users who wanted typed bindings had to fall back to the template-tag form or hand-build strings — both worse DX than what the template tag already provides for one-shot interpolation. The new `jsmql.compile(fn)` closes that gap: the arrow takes a destructure pattern in its first slot, and the returned callable inlines fresh values from a params object on every call. The output shape matches the template tag (values appear as JSON literals), but the surface is typed, named, and reusable.

The signature is `(paramsObj?, $?, { $opsHint }?) => body`, with each slot disambiguated by shape (plain identifier = doc context, destructure with all `$`-prefixed keys = ops hint, destructure with non-`$` keys = params). All three slots are optional, so the existing `($) => …` and `($, { $dateDiff }) => …` forms keep working unchanged. Inside the body, a bare identifier looks like a lambda param to the parser but resolves at codegen against a new `bindings` tier on `GenerateCtx`, slotted between `pipelineLets` and `droppedLets`. The `$match` index-friendly translator (added in the previous merge) was extended to treat a `ParamRef`-to-binding as a literal, so `$match($.age >= minAge)` with `{ minAge: 21 }` emits `{ $match: { age: { $gte: 21 } } }` — indexes keep working even with dynamic values. Function-form bindings cross sub-pipeline boundaries (unlike pipeline `let` bindings) because they're compile-time constants, not document state.

**Defaults in the params destructure are rejected**, with a long-form error explaining why. Allowing arbitrary defaults (`{ x = config.minAge }`) is impossible because jsmql can't evaluate JS at the call site; allowing only literal defaults (`{ x = 18 }`) would create a confusing JS-subset rule where refactoring `18` into `config.minAge` silently breaks the surface. The error points users at JS's `??` at the call site (`q({ minAge: input ?? 18 })`) for runtime fallbacks and the template tag for hardcoded values. Other destructure rejections (nested, rest, array, mixed `$`/non-`$` keys, > 3 params, wrong slot ordering) each get their own targeted message — the parser tells the user exactly what to write instead.

**Breaking import surface change**: `validate` is no longer a top-level export. It moves under `jsmql` as `jsmql.validate(input)`, mirroring the new `jsmql.compile`. Both properties are attached to `jsmql` via `Object.assign` because the strippable-TS rule in [src/CLAUDE.md](../src/CLAUDE.md) forbids `namespace`. The public surface is exactly two attached entries — `jsmql.compile` and `jsmql.validate` — by deliberate choice; the compile-form path is throw-style only (no `jsmql.validate.compile`), since the only realistic structured-error use case is the one-shot validate, and adding a second surface would have duplicated the contract without a real need. Tests, README, and the smoke test were updated mechanically (`validate(…)` → `jsmql.validate(…)`); the change is acceptable pre-1.0 since `package.json` still pins `0.1.0`.

Implementation: `parseFunctionInput` in [src/parser.ts](../src/parser.ts) now returns `{ program, bindings }` (replacing the discard-everything `skipParameterList`); `GenerateCtx.bindings` and `withBindings`/`freshSubPipelineCtx(outer)` in [src/codegen.ts](../src/codegen.ts) (sub-pipeline ctx carries bindings); `lowerLetDecl` in [src/pipeline.ts](../src/pipeline.ts) gains a defensive shadow-rejection check; [src/match-translation.ts](../src/match-translation.ts) accepts an optional `TranslateCtx` carrying the bindings map; [src/index.ts](../src/index.ts) factors `validateInterpolatable` and `errorToValidationResult` out of their original sites and wires the three entry points. Spec at [docs/specs/function-form-params.md](specs/function-form-params.md); test coverage in [test/codegen.test.ts](../test/codegen.test.ts) under `describe("jsmql.compile()")`, with a realistic two-stage eligible-users pipeline in [test/realistic.test.ts](../test/realistic.test.ts).

Deferred: `$let`-wrapped output mode (rejected — it breaks pipelines and collides with lambda `$$name`); a one-shot `jsmql(fn, params)` shortcut (rejected — keeps one canonical path); strict-mode rejection of unused param keys; type-level enforcement that every binding referenced in the body appears as a key on the params type (not reachable through plain TS without a custom transformer).

---

## 2026-05-13 — `jsmql/ops` subpath: spec-generated ambient types replace per-callsite ops-hint destructures

`jsmql.compile()` shipped with an ops-hint slot — `(params, $, { $match, $project, $sort, $skip, $limit, … })` — that exists purely so TypeScript stops underlining stage and operator names. The slot is parser-stripped, types-only, and lists *every name a user wants to call in the body*. With 46 stage ops and ~182 expression ops, real pipelines spelled out 5–15 names per call site; the `JsmqlOps` type was a wildcard `Record` so there was no autocomplete, no typo-check, and no per-op arg shape. Maintaining the destructure was bookkeeping the user shouldn't have to do.

The new `jsmql/ops` subpath is a **pure-types** module published alongside the main entry. Users add `import "jsmql/ops"` once per file (the side-effect form — `import type "x"` for a side-effect-only path isn't valid TS syntax), drop the ops-hint destructure entirely, and bare `$match(…)` / `$dateAdd(…)` calls Just Work in IDEs. The compiled `dist/ops.js` is `export {};` with no exported values, so runtime cost is one empty module load that bundlers tree-shake away; for fully zero-runtime use, projects can add `"jsmql/ops"` to their tsconfig `compilerOptions.types` instead of importing it. Names are global because once any file in the project loads the module, the `declare global` declarations take effect project-wide; they all start with `$`, so collision risk is essentially nil. The runtime path is unchanged — the parser already recognises bare `$stage(…)` calls against the `STAGES` / `OPERATORS` registries.

Crucially, the types are **generated at build time from the official MongoDB MQL spec** ([`mongodb/mql-specifications`](https://github.com/mongodb/mql-specifications)), not hand-maintained. [`scripts/generate-ops.mjs`](../scripts/generate-ops.mjs) reads `OPERATORS` + `STAGES` + the vendored YAMLs and emits [`src/ops.ts`](../src/ops.ts) with one `function` declaration per name, full JSDoc descriptions, `@minVersion`, and `@see` doc links. Object-form ops (`$dateAdd`, `$lookup`, `$reduce`, …) get typed-key args objects with required vs optional fields lifted straight from the spec; `flex`-shape ops emit two function overloads; `timeUnit` arguments get the literal-union type. The result: autocomplete shows arg names the moment the user types `$dateAdd(`, typos like `$mathc` are flagged, hover surfaces the official description. The same `.d.ts` is what AI coding tools like Claude and Copilot see when reasoning about types — precise per-operator types make AI-generated jsmql code dramatically more accurate, which was an explicit DX goal.

The generator runs on every `prebuild` and `pretest`, so the committed `src/ops.ts` is always current. A drift test in [`test/operator-spec-coverage.test.ts`](../test/operator-spec-coverage.test.ts) imports `generateOpsSource()` and byte-compares the committed file against fresh output (whitespace-normalised via `oxfmt --stdin-filepath`), so editing the registries without re-running the generator — or editing `ops.ts` by hand — fails CI. Smoke tests in [`test/smoke.test.ts`](../test/smoke.test.ts) verify `dist/ops.{js,d.ts}` are emitted with intact declarations after `npm run build`.

The original ops-hint destructure stays supported — `jsmql/ops` is the preferred alternative, but existing code keeps working unchanged. Per-operator return-type narrowing (e.g. `$abs(): number`) is deferred: it interferes with method-chain inference on field refs and isn't worth the complexity for v1 when arg-name and option-arg autocomplete already deliver most of the DX gain. Spec at [docs/specs/ops-generation.md](specs/ops-generation.md).

---

## 2026-05-13 — Pipeline-scoped `let` bindings

Added `let <name> = <expr>;` as a new pipeline statement that materialises the value under a single compiler-owned namespace field (`__jsmql.<name>`) and gets auto-`$unset` at the end of the pipeline. The construct sits on top of the existing update ops machinery — every primitive needed was already in `src/pipeline.ts` and `src/codegen.ts` — and adds three things plain update ops don't give you: auto-cleanup (no manual `delete`), collision-safe storage (a real document field named `subtotal` is never clobbered), and bare-identifier reference at call sites (`subtotal` not `$.subtotal`, so scratch helpers read visually distinct from real fields). The motivating DX win turned out to be **comments**: `let x = $.a + $.b; // why this matters` puts each derived value on its own line with a natural one-liner intent comment, which the alternative `$.tmp = ...` form doesn't, because temps interleave with real-field writes.

Scope is the rest of the pipeline, with the obvious exception: stages that *replace* the document (`$group`, `$bucket`, `$bucketAuto`, `$replaceRoot`, `$replaceWith`) clear the let scope. A reference to a let from before any of these is a precise compile-time error ("`total` is a `let` binding and can't be read after `$group`"), not a silent runtime `null`. `$project` is deliberately *not* in the reshape-clearing set, since expression-mode and exclusion-mode projections preserve the namespace; users running an inclusion-mode `$project` that drops `__jsmql` will hit the same runtime-null trap as today's manual `$.tmp = …` + `delete` pattern (documented in `docs/LANGUAGE.md`). Sub-pipelines (`$lookup.pipeline`, `$unionWith.pipeline`, `$facet.*`) get a fresh empty let scope — outer lets do not cross sub-pipeline boundaries in v1.

Implementation spreads across the usual five files: `Let` token in [src/lexer.ts](../src/lexer.ts) plus accepted as an identifier/keyword and as a special-cased object-key name (the MongoDB `$lookup.let` and `$let` operator both keep parsing), `LetDecl` AST node in [src/ast.ts](../src/ast.ts), `parseLetDecl()` plus top-level-context check in [src/parser.ts](../src/parser.ts), `GenerateCtx.pipelineLets` + `droppedLets` + helper functions in [src/codegen.ts](../src/codegen.ts) (with `extendCtx` and the reduce/groupBy inner ctxs updated to preserve them, so lets are visible inside lambda bodies), and the actual stage-walking ctx threading + reshape-clearing + sub-pipeline isolation in [src/pipeline.ts](../src/pipeline.ts). Update filters machinery picked up an optional ctx parameter so RHS expressions in `[$.x = subtotal + 1]`-style pipelines can read lets too. Pipelines with no `let` declarations produce byte-identical MQL output to pre-feature jsmql. Spec at [docs/specs/let-bindings.md](specs/let-bindings.md); test coverage in [test/let-bindings.test.ts](../test/let-bindings.test.ts) plus a realistic order-pricing example in [test/realistic.test.ts](../test/realistic.test.ts) that gets picked up by the playground sync hook.

Deferred for now: `$let`-as-optimisation (when a let is read in exactly one downstream expression with no reshape between, the compiler could emit a single `$let` instead of `$set`/`$unset` to preserve `$match` index usage), `const` keyword (pre-1.0 there's no semantic difference), multi-binding `let a = …, b = …`, and a warning channel for index-breaking lets before `$match` stages. The current surface is intentionally small; we'll grow it from usage.

---

## 2026-05-13 — Playground examples move to a JSON manifest (dedup)

`scripts/sync-playground.mjs` used to inline every realistic-test query into [playground.html](../playground.html) between `<!-- BEGIN/END GENERATED EXAMPLES -->` markers, plus a parallel `<!-- BEGIN/END GENERATED OPTIONS -->` block for the `<select>`. Each test case therefore appeared in two places (its `it()` body in `test/realistic.test.ts` and a `<script type="text/plain" data-ex>` in the HTML); the script's job was to keep them in sync. The HTML got long, every test-file edit produced a noisy `playground.html` diff alongside the test diff, and the duplication was load-bearing — the playground page read its examples from the inline `<script>` blocks rather than from the canonical test source.

Replaced the inline copies with a sidecar JSON manifest. `sync-playground.mjs` now writes [playground-examples.json](../playground-examples.json) (an array of `{ slug, title, query }` objects) next to `playground.html`. The page fetches the manifest on load and populates the `<select>` and example map at runtime. The generated regions in `playground.html` are gone (file shrank from ~648 lines to ~387); a `git diff` after a test-file rename now touches the JSON manifest only. Same hook wiring as before — `scripts/hook-post-edit-realistic.sh` regenerates the manifest whenever Claude Code edits `test/realistic.test.ts`, and `git add`s the new file so it commits alongside the test change.

Manual smoke after the move: `npm run sync:playground` produces a JSON manifest, `python3 -m http.server` then `playground.html` populates the dropdown and renders the selected example. The HTTP requirement is unchanged — the README already calls for a static server, and `fetch()` from `file://` was never going to work for the dist module either.

---

## 2026-05-13 — Split `==` / `===` semantics around `null`

Lexer and parser have always distinguished `==`/`===` and `!=`/`!==`, but codegen collapsed them — both pairs emitted `$eq`/`$ne`. That left jsmql doing the same thing for two operators that JS developers reach for with different intent, which is exactly the "silent surprise" CLAUDE.md says to avoid. JS itself has a clean null/missing distinction (loose `== null` matches null or undefined; strict `=== null` matches only null), and MongoDB's query language and aggregation `$eq` happen to encode the same two semantics — so we can make the operators mean what JS developers already think they mean, with no loss of expressive power.

The new rule: `===`/`!==` are strict (JS-faithful); `==`/`!=` are restricted to comparisons against `null` and produce loose null-or-missing checks. Any other use of `==`/`!=` is a compile error pointing at `===`. In expression context, `$.x == null` emits `{ $in: [{ $type: "$x" }, ["null", "missing"]] }` and `$.x === null` keeps the strict `{ $eq: ["$x", null] }`. In `$match` query context, `$.x == null` stays the index-friendly `{ x: null }` (already loose in MongoDB) and `$.x === null` becomes `{ x: { $type: "null" } }` so missing-field docs are excluded. Both code paths agree on semantics, so the `$expr` fallback never disagrees with the translated form.

Breaking change to the public output. Pipelines written with `==` or `!=` against non-null values (`$.status == "active"`) now throw; the fix is a mechanical `==` → `===` find-and-replace, and the error message is the migration guide. Implementation: a new `generateLooseEquality` branch in [src/codegen.ts](../src/codegen.ts) and a three-way split in `translateEquality` in [src/match-translation.ts](../src/match-translation.ts) plus two new helpers (`translateLooseNull`, `translateStrictNull`). Updated specs: [docs/specs/match-query-translation.md](specs/match-query-translation.md); updated user-facing docs: [docs/LANGUAGE.md](LANGUAGE.md) ("`===` / `!==` vs `==` / `!=`" subsection under Comparison).

---

## 2026-05-11 — Playground examples auto-synced from `test/realistic.test.ts`

The playground's `<select>` examples were hand-curated from `test/realistic.test.ts` when the page was first added, but the test file kept growing and the playground drifted to a stale subset of 13 of the now-41 realistic cases. `scripts/sync-playground.mjs` closes the loop: it walks every top-level `describe` in `test/realistic.test.ts` via the TypeScript compiler API, extracts the first query inside each describe (string literal, template literal, tagged-template `mql`, or arrow-body — `mql` template interpolations are resolved against `const` declarations in the same `it()`), and rewrites two delimited regions in [playground.html](../playground.html) (`<!-- BEGIN/END GENERATED OPTIONS -->` and `<!-- BEGIN/END GENERATED EXAMPLES -->`). The `validate(): realistic error cases` block is skipped since those queries don't compile and have no MQL output to show.

The script is wired into a PostToolUse hook in [.claude/settings.json](../.claude/settings.json) via [scripts/hook-post-edit-realistic.sh](../scripts/hook-post-edit-realistic.sh): whenever Claude Code's `Edit`/`Write`/`MultiEdit` touches `test/realistic.test.ts`, the script reruns and `git add`s the regenerated `playground.html` so it rides along with the test edit in a single commit. For non-Claude edits, run `npm run sync:playground` by hand. Idempotent: re-running with everything in sync is a no-op. Fails loudly (non-zero exit, clear message) when the markers are missing or a query can't be extracted — silent drift was the failure mode this change is trying to prevent.

---

## 2026-05-10 — `scripts/merge-devlog.mjs`: auto-resolve DEVLOG merge conflicts

Parallel-session work on this project hits the same papercut on every merge: each branch prepends a new entry to `docs/DEVLOG.md`, git can't pick a winner, and a human (or the agent) has to read both sides and stitch them back together. That manual stitch was costing minutes per merge — a tax that scales linearly with the number of in-flight branches.

`scripts/merge-devlog.mjs` is a one-shot resolver. Run it when `git merge` stops on `docs/DEVLOG.md`; it reads the three index stages (base/ours/theirs) that git keeps during an unresolved conflict, splits each on the `---` separator, dedupes by `## YYYY-MM-DD — Title` heading, takes the union, sorts newest-first (alphabetical tiebreak inside a date), writes the result, and `git add`s it. Measured wall-clock on a real two-side conflict: 158 ms.

Deliberately *not* wired as a custom git merge driver via `.gitattributes` + `git config`. Reasons: the postinstall machinery to install the driver across clones/worktrees adds a moving part to setup; a manually-invoked script is one less thing to break, leaves the default git behaviour unchanged for everyone who hasn't opted in, and is honest about *when* the smart merge is happening. The cost is one extra command (`./scripts/merge-devlog.mjs`) per conflict — well below the threshold where automation is worth its setup overhead.

Falls back to a normal manual conflict in the rare cases the structural merge can't decide: diverging edits to the same past entry, deletion of a past entry on one side (the convention is append-only — corrections go in a follow-up entry that links back), or diverging edits to the file header. Unit tests in `test/merge-devlog.test.ts` cover both the auto-merge path and the fall-back conditions.

---

## 2026-05-10 — Bare type-cast callbacks: `arr.filter(Boolean)` etc.

`Boolean`, `Number`, and `String` can now appear bare (without `(...)`) as the callback to any single-param higher-order array method — `.filter()`, `.map()`, `.find()`, `.findLast()`, `.findLastIndex()`, `.some()`, `.every()`, `.flatMap()`. This is the standard JS shorthand for `x => Boolean(x)` (etc.), and it was the kind of expression any JS developer expects to "just work" — failing it with `Expected LParen` was a violation of both project priorities (strict-JS subset, actionable errors).

Mechanics: the parser distinguishes the call form (`Boolean(x)`) from the bare form by 1-token lookahead in `parsePrimary()` ([src/parser.ts](../src/parser.ts)) and emits a new AST node `TypeCastRef` for the bare case. `requireLambda()` in [src/codegen.ts](../src/codegen.ts) desugars `TypeCastRef { cast }` into a synthetic `Lambda { params: ["v"], body: TypeCast(cast, ParamRef("v")) }` before per-method handlers run, so all eight callback-taking methods support the shorthand from a single change site. Outside callback position the bare form throws an actionable `CodegenError` pointing the user at the call form.

`parseInt` and `parseFloat` are deliberately *not* in the bare-callable set. In real JS, `['1', '2', '3'].map(parseInt)` returns `[1, NaN, NaN]` because `parseInt` receives the array index as its radix argument — an infamous footgun. jsmql could either replicate the bug or diverge silently from JS runtime semantics; rejecting the bare form forces users to write `x => parseInt(x)` and surfaces the choice. The call form `parseInt(x)` continues to work as before.

`.reduce(Boolean)` falls out automatically: the synthetic lambda has 1 parameter and the existing "exactly 2 parameters" check in `.reduce()` rejects it. Future work: `Math.floor` / `Math.round` etc. as bare callbacks (different AST shape — member access rather than bare ident — so larger change), and a possible parser-level "did you mean `x => parseInt(x)`?" hint when the user writes `parseInt` bare.

---

## 2026-05-10 — Block-body arrows for the function-input form

The `jsmql(($) => …)` adapter now accepts block-body arrows alongside expression bodies. The body inside `{ … }` is a sequence of jsmql statements separated by `;` — the function-form mirror of the implicit-pipeline string syntax shipped earlier today. This lets users author multi-stage pipelines as plain JS that prettier and oxfmt indent and line-break for free, without any `[…]` ceremony:

```js
jsmql(($, { $match }) => {
  $match($.status === "pending" && $.paidAt != null);
  ($.lineTotal = $.qty * $.unitPrice), ($.invoiceCount += 1);
  delete $.tempToken, delete $._processingState;
  $.status = "complete";
});
```

`extractArrowBody` in `src/index.ts` strips the outer braces and passes the inner content unchanged. `;`s are preserved (they are the pipeline-stage separator); the existing trailing-`;` strip is now scoped to expression bodies only — single-statement expression arrows still produce object output.

`return` inside a block body throws a precise `FunctionInputError` rather than the parser's "unknown identifier" message, pointing the user at the `;`-separated form or an expression-body arrow.

**Tests.** Five new cases in `test/implicit-pipeline.test.ts` covering block-body arrows (multi-statement, comma-grouped chunks, single-statement, `return` rejection, and the expression-body trailing-`;` regression). One new realistic case in `test/realistic.test.ts` showing the block-body form compiling identically to the string form for the invoice-finalisation pipeline. Total 663 → 669.

---

## 2026-05-10 — Browser playground (`playground.html`)

A single-file static playground at the repo root: vertical split with an jsmql input on the left and the compiled MQL JSON live-rendering on the right. Loads the local `dist/index.js` directly via `<script type="module">`, so there is no build step beyond `npm run build` and no bundler. Default expression is the README quick-start (`$.price >= 100 && $.stock > 0`) so first paint shows recognisable output.

The render path uses `validate()` for the structured-error guarantee and only calls `jsmql()` once validation passes — that keeps the textarea handler `try/catch`-free and lets us show the error `code` and `pos` plainly. No debouncing: the parser/codegen run in microseconds and recompiling on every keystroke gives the most responsive feel.

Browsers refuse to load ESM from `file://`, so the page must be served over HTTP — the README pointer mentions `python3 -m http.server` (the project bans `npx`, and that one-liner ships with macOS). Not added to `package.json` `files`: the playground is a contributor/demo tool, not part of the published npm artifact.

---

## 2026-05-10 — Consolidated `mql` template tag into `jsmql`

The public API had three exports — `jsmql()`, `validate()`, and `mql` — and forced two micro-decisions on every use: import which one, then call which one. `mql` and `jsmql` answered effectively the same question ("compile this to MQL"), and the only material difference was whether the source needed `${value}` interpolation. The DX cost showed up in three places: every doc had to teach two entry points, the function-form's outer-scope-identifier hint had to point users at the *other* export, and `validate(mql\`…\`)` was structurally impossible because `mql` threw synchronously before `validate` ever saw anything (the security suite carried a workaround comment for it).

`jsmql` is now polymorphic over three call shapes — string, arrow function, and template tag — dispatched by a `TemplateStringsArray` discriminator (`Array.isArray(arg) && Array.isArray(arg.raw)`, the standard "tag vs. function call" pattern from chalk / styled-components / lit-html). `validate` got the same treatment, so `` validate`$.x == ${val}` `` works as the non-throwing counterpart and the security-test workaround collapsed to a one-liner. Two exports, one mental model. The interpolation safety net (`stringifyInterpolation`) is unchanged — it just runs from inside the `jsmql` dispatcher now instead of from a separate `mql` function. See [src/index.ts](../src/index.ts).

Bundled into the same `feat!:` because they're all parts of one shape change: `MqlInterpolationError` was renamed to `JsmqlInterpolationError` (the "Mql" prefix referenced the going-away `mql` export and would have left an orphan name in the public API), and `jsmql()` got a top-level `TypeError` guard so wrong-shape inputs (`jsmql(42)`, `jsmql({})`, `jsmql(null)`) produce a one-sentence "expects a string, an arrow function, or a template literal — got X" instead of crashing deep inside the parser. `validate()` routes that `TypeError` to a structured `SYNTAX_ERROR`, parallel to the existing `RangeError` arm. Pre-1.0 with no published artifact, so the breaking-change cost is the import-line update and one test/doc sweep — paid once, in this commit.

---

## 2026-05-10 — Implicit pipelines: `;` is a pipeline-stage separator, `,` is in-stage

`;` and `,` were interchangeable update op-chain separators. They are not anymore. The new rule:

- `;` is **the** pipeline-stage separator. Any `;` at the top level — including a single trailing `;` — flips `jsmql()` into pipeline mode and returns an array. Each `;`-separated chunk becomes its own stage(s); adjacent update op statements **never** coalesce across `;`.
- `,` is the in-stage update op separator. It still groups update ops into one `$set`/`$unset` stage, with the existing kind / read-after-write splits.

The motivation is DX: short pipelines no longer need `[…]` brackets, and the role of each separator is now unambiguous. `$match($.active); $.score += 1; $sort({score: -1})` reads naturally as three stages and compiles directly without ceremony.

**Breaking change.** Two existing inputs change shape: `$.a = 1;` (trailing `;`) was `{ $set: { a: 1 } }` and is now `[{ $set: { a: 1 } }]`; `$.a = 1; $.b = 2` was `{ $set: { a: 1, b: 2 } }` and is now `[{ $set: { a: 1 } }, { $set: { b: 2 } }]` (two stages, no merge across `;`). Migration is mechanical: replace `;` with `,` to keep the old single-stage shape.

**Implementation.** New `Pipeline` AST node; `Parser.parse()` rewritten as a `;`-separated statement loop calling a factored-out `collectStatement()`; `peekUpdateOpSeparator` no longer recognises `;`; new `generateImplicitPipeline` in `src/pipeline.ts` lowers each `;`-separated statement in isolation (update op chunks via `generateUpdateFilter`, stage expressions via single-element `generatePipeline`). The bracketed `[…]` form is unchanged and still coalesces adjacent update op elements via `generateUpdateOpGroups` — that is the documented difference between the two pipeline forms.

**Tests.** 21 new cases in `test/implicit-pipeline.test.ts` covering trailing `;`, multi-statement, mixed `;`+`,`, RAW splits inside one chunk, and stage-call errors. One new realistic test in `test/realistic.test.ts` showing the implicit form compiling identically to a hand-written `[…]` pipeline. Existing `test/update-filter.test.ts` cases that used `;` as a update op separator now use `,`. Total goes from 644 to 663.

---

## 2026-05-10 — Increment / decrement: `x++`, `++x`, `x--`, `--x`

Follow-up to yesterday's update ops feature. JS's increment/decrement operators now compile to the same `$set` stage as `x += 1` / `x -= 1`. All four forms produce identical output — the prefix/postfix distinction (return-then-mutate vs mutate-then-return) is irrelevant in MongoDB pipeline context because stage-level update ops don't carry a "value of expression". Treating them as four spellings of the same statement keeps the surface JS-faithful without inventing semantics MQL can't represent.

**Lexer.** Two new tokens (`PlusPlus`, `MinusMinus`) with strict longest-match ordering: `++` checked before `+=` before `+`; same for `-`. The whitespace boundary stays sane — `1 - -2` still lexes as two `Minus` tokens (parses as `1 - (-2)`); `1--2` lexes as `1`, `--`, `2` and is rejected at target validation because `1` isn't a field path.

**Parser.** Prefix `++x`/`--x` joins `delete` as a leading-token signal that triggers `parseUpdateFilter`. Postfix `x++`/`x--` joins assignment operators as a post-target signal — same dispatch as `$.x = …`, `$.x += …`. All four update op positions accept both forms (top-level, `parseUpdateOp`, `parseArrayLiteral` pipeline element, `parseGrouped` parens). Both prefix and postfix desugar via `makeIncDecUpdateOp(target, op)` into the standard `AssignExpr { target, value: BinaryExpr(+/-, target, 1) }` — codegen sees nothing new.

Targets validate identically to compound assignments (field paths only). Misuse as a value (`1 + $.x++`) bubbles through to the existing codegen-level "Assignment is a statement, not a value" error.

**Tests.** 18 new cases in `test/update-filter.test.ts` covering all four forms across all four positions (top-level, mixed coalescing, pipeline element, parens), plus the `5 - -3` whitespace regression. Total now 644.

---

## 2026-05-10 — JS truthy/falsy semantics for `&&`, `||`, `!`, `?:`, `Boolean()`, predicate methods

Until now, `&&`/`||` compiled to `$and`/`$or` (which return *booleans*, not the operand value as JavaScript does), `!` compiled to `$not` over the raw value (using MQL truthiness), and `Boolean(x)` compiled to `$toBool` (where `""` is **truthy** in MongoDB). The result was a stealth gotcha: `$.building && $.building + ","` returned `true` instead of `"Acme,"`, and `[…].filter(Boolean)` kept empty strings. Both contradict the project's #1 pitch ("JS you already know"), so they had to go.

The new codegen routes all of `&&`, `||`, `!`, `?:`, `Boolean()`, and the predicate-method bodies (`.filter`, `.find`, `.findLast`, `.findLastIndex`, `.some`, `.every`) through two helpers in [src/codegen.ts](../src/codegen.ts): `jsBool(value)` emits the JS-truthy check `{ $and: [{$ne:[v,null]}, {$ne:[v,false]}, {$ne:[v,""]}, {$ne:[v,0]}] }` (relying on type-bracketed `$ne` to handle cross-type comparisons safely), and `isProvablyBool(expr)` lets the codegen *elide* the wrap when the operand is already known to be a boolean (comparisons, `$and`/`$or` chains, `!x`, `BOOL_OUTPUT_OPS`-listed operators, `BOOL_RETURNING_METHODS`). All-bool chains keep emitting the cheap `$and: […]` / `$or: […]`; mixed chains fold right into operand-preserving `$cond` chains, with `$let` introduced only when the LHS is non-pure-ref non-bool (gensym'd against in-scope lambda params to avoid shadowing).

Out of scope and deliberately deferred: NaN handling (MongoDB's `$eq` treats `NaN == NaN` as true, so the cheap `$ne:[x,x]` self-comparison doesn't work; the only portable detection is per-value `$convert`-to-string, which would bloat every emitted wrapper — NaN is vanishingly rare in MongoDB data, so we accept the divergence and document it). Also out of scope: `$match: $expr` predicate position in [src/pipeline.ts](../src/pipeline.ts) — query-language semantics may want their own treatment, separate PR. Users who need MongoDB's raw semantics can call the operators directly: `$toBool($.x)`, `$op($and, …)` — those escapes are unaffected. Pre-1.0, so the breaking-change bar is "is the new behaviour the right one?" — and operand-preserving `&&`/`||` plus JS-faithful `Boolean` is unambiguously closer to the language we're claiming to ship.

---

## 2026-05-10 — Playground polish: examples, prettify, syntax highlighting

Three additive enhancements to `playground.html` (initial entry below):

- **Examples dropdown** in the left-panel label with 13 curated cases lifted from `test/realistic.test.ts`, spanning expression, template-literal, and pipeline forms. Default selection is the dynamic-keyed-histogram pipeline (the `$accumulator` replacement), which is the most distinctive showcase of what jsmql buys you over hand-written MQL. Sources live in `<script type="text/plain">` blocks so backticks, `${…}`, `<`, and `&&` need no escaping; `loadExample()` strips the common leading-whitespace prefix that the HTML formatter adds.
- **Prettify checkbox** on the right-panel label (default On) toggles the `JSON.stringify` indent argument between `2` and `0`. Off is the right call for copy-pasting compact MQL into a `db.aggregate(...)` call.
- **Syntax highlighting on both panes** via CodeMirror 5 from cdnjs (`codemirror.min.{js,css}`, `mode/javascript/javascript.min.js`, `theme/neo.min.css`). Picked CodeMirror over Prism/highlight.js because it gives real editing on the editable left pane (no textarea-overlay trick) and a read-only mode for the right pane via the same library — single dependency, consistent look. The `javascript` mode handles both JS and JSON (`{ json: true }`). Errors switch the right pane's mode to `null` (plain text) and add a `.error` class on the panel for the red tint.

---

## 2026-05-10 — Playground: copy-to-clipboard button on the MQL output

A small "Copy" button next to the Prettify checkbox writes the current MQL JSON to the clipboard via `navigator.clipboard.writeText`. Disabled (no-ops) when the output is empty or showing an error message — copying an error string would be a footgun. Brief inline feedback ("Copied!" / "Copy failed") replaces the label for 1.2 s after a click; a single shared timer is reset on each click so rapid presses don't leave the label stuck.

---

## 2026-05-10 — Playground: highlight error position in the input editor

When `validate()` returns a `SYNTAX_ERROR`, the playground now underlines the offending character in the input via `cm.markText`. The flat `pos` offset is converted with `cm.posFromIndex`; positions past end-of-input (the common case for unterminated expressions like `$.x &&`) are clamped back to the last character so the marker is always visible. `CODEGEN_ERROR` carries `pos: 0` as a placeholder rather than a real location, so the marker is suppressed in that branch — underlining the first character would be misleading.

---

## 2026-05-10 — refactor: function-input parsing lives in `parser.ts`

Same observable behaviour as the previous block-body-arrow entry; this is a code-organization fix. The earlier landing did the arrow-source work as string slicing + a regex `return` check inside `extractArrowBody` in `src/index.ts`. That belongs in the parser: arrow function syntax is grammar, not a runtime adapter concern, and the regex was fragile (it false-matched `return` inside string literals).

`src/parser.ts` now owns it:

- `Parser.parseFunctionInput()` — public entry called by `jsmql()` for the function-form input. Consumes the parameter list (balance-counted, discarded — params are types-only), the `=>`, then dispatches to a block-body or expression-body parser.
- `parseBlockBody()` — structurally identical to the top-level `;`-loop in `parse()`, terminated by `}` instead of EOF. Same coalescing rules as the implicit `;`-separated pipeline.
- `parseExpressionBody()` — single statement with one optional trailing `;`, which is consumed silently (formatter artifact) and does NOT flip into pipeline mode. Single-statement expression-body arrows preserve their object-shaped output as before.
- `rejectReturn()` — token-aware check at every statement-start position inside a block body. Throws a precise `FunctionInputError` when it sees the bare identifier `return`, so a `return` token *inside* a string or as `obj.return` no longer false-fires.

`FunctionInputError` moved from `src/index.ts` to `src/parser.ts` (re-exported from `index.ts` so the public import path is unchanged). `extractArrowBody` and the regex are gone; `src/index.ts` is now a thin wrapper that calls the right `Parser` entry point and lowers the resulting `Program` through a shared `lower()` helper.

No test count change (still 669) — error messages match the prior shape, the `expression-body arrow` test in `codegen.test.ts` was renamed to "rejects `return` inside a block-body arrow" to match what it actually checks now.

---

## 2026-05-10 — Renamed project from `mjsql` to `jsmql`

The old name read phonetically as "MySQL" — a relational database the project has nothing to do with. That's a DX trap on first contact: the name should help a reader place the tool, not mislead them. `jsmql` reads as "JS → MQL", which is exactly what the compiler does (JavaScript-subset syntax in, MongoDB MQL JSON out), and grounds the name in MongoDB's actual term for its query language.

Mechanical rename across all 27 tracked files containing the old name: package identity (`package.json`, `package-lock.json`), the exported `jsmql()` function in [src/index.ts](../src/index.ts), the `JsmqlInput` / `JsmqlOutput` / `JsmqlOps` / `JsmqlFn` type names, parser error messages in [src/parser.ts](../src/parser.ts), every test, every doc, every CLAUDE.md, and the historical entries in this DEVLOG. The `mql` template tag is unchanged — it always referred to MongoDB's MQL output, not the project name. Pre-1.0 with no published npm artifact and no GitHub remote configured, so the rename is purely an in-repo change today; the containing folder `~/code/mjsql` and any future remote will be moved as a follow-up using `git worktree repair` (18 sibling worktrees share the parent directory).

Marked `feat!:` because the import-path identity changed: anyone with `import { mjsql } from "mjsql"` in their code needs `import { jsmql } from "jsmql"`. The runtime contract (input shapes, output shapes, error types) is otherwise unchanged.

---

## 2026-05-10 — Smoke checks codified in `test/smoke.test.ts`

Two invariants that I'd been verifying by hand at the end of every session — `node src/index.ts` (strippable-TS rule) and a post-build ESM import of `dist/index.js` — are now part of the vitest suite. The strippable check spawns the real Node stripper because vitest's Vite-based loader silently accepts the very constructs the rule bans (`enum`, `namespace`, parameter properties, decorators, …); a regex/AST walker would drift from "what Node actually does", so the test runs the canonical command. The dist case uses `it.skipIf(!existsSync(...))` so local `npm test` stays fast and silent; `npm run smoke:dist` builds first and exercises it on demand.

The motivation is straightforward: relying on muscle memory to enforce a documented invariant means it survives only as long as the human remembers. The real failure mode is silent — a contributor lands a `class` with a parameter property, every vitest case still passes, and the package breaks for Deno/Bun users at import time. `npm test` now catches it on the same commit.

`test/CLAUDE.md` and the root `CLAUDE.md` "Things that matter" list now point at `test/smoke.test.ts` instead of the manual `node src/index.ts` ritual. Per-feature spot-checks (`node -e "console.log(jsmql('…'))"`) are explicitly *not* added — they duplicate `codegen.test.ts` / `realistic.test.ts` cases.

---

## 2026-05-09 — Update filters: `=`, `+=`, `-=`, `*=`, `/=`, and `delete` compile to `$set`/`$unset` stages

Closes the longest-standing item in `Invalid Constructs` (assignments) and adds `delete` alongside it. Users now write document updates in JS-natural form — `$.score += 1`, `delete $.tmp`, `$.user.name = "alice"` — and the compiler emits the correct MongoDB pipeline-stage shapes. Multiple update ops separated by `;` or `,` coalesce into the smallest correct stage sequence.

**Wire format.** `$set` and `$unset` were already registered pipeline stages in `src/stages.ts`; the new code only synthesises the stage objects, no operator-registry changes. Single `$unset` deletes use the string form (`{ $unset: "tmp" }`); two-or-more deletes coalesce to the array form (`{ $unset: ["a", "b"] }`). One assignment yields a bare `{$set:{…}}` object, multiple stages yield an array — same convention as existing pipeline-vs-expression output.

**Coalescing.** Adjacent same-kind update ops (all assignments, or all deletes) merge into one stage *unless* a path collision (parent/child) or a read-after-write would change the semantics. `$.a = 1; $.b = 2` is one `$set`; `$.a = 1; $.b = $.a` is two `$set`s because the second reads what the first wrote — preserves JS sequential semantics. Same algorithm runs at the top level and between adjacent update op elements inside a pipeline.

**Parser shape.** `parse()` now returns `Program = Expr | UpdateFilter`. Top-level dispatch: a leading `delete` keyword, or any expression followed by an assignment operator, triggers update op-program parsing. Inside `parseArrayLiteral`, the same per-element heuristic runs so `[$match(...), $.a = 1, delete $.tmp, $sort(...)]` works. `=` is right-associative and chainable; `+=`/`-=`/`*=`/`/=` are not — `a += b += 1` is rejected because it's too easy to misread. Compound operators are desugared at parse time into `=` plus a `BinaryExpr`, so codegen sees only plain assignments and inherits the existing type-aware `+` (numeric `$add` vs string `$concat`) for free.

**Parenthesized assignments accepted.** Formatters wrap assignment expressions in parens when they sit in array element position, and Vite/Vitest's transform silently strips them — so without parser support, `jsmql(($) => [($.a = 5)])` would fail in production runtimes even though it passed in tests. `parseGrouped` now recognises an assignment operator after the inner expression, parses the assignment inside the parens, and returns the resulting `AssignExpr`. Misuse as a value (`1 + ($.a = 5)`) is rejected at codegen with a clear message.

**Targets.** Restricted to static field paths (`$.x` / `$.x.y.z`). Bare identifiers, index access, and computed paths are rejected with operator-specific error messages. Update filters are statement-only — invalid inside expressions, lambda bodies, or as values. The `delete` keyword does not return a boolean (unlike JS).

**Both `;` and `,` work as separators**, freely interchangeable. `,` was already a list separator inside arrays/calls; the parser disambiguates by position. `;` is a new lexer token. Trailing separator allowed.

**Spec.** `docs/specs/update-filter.md` covers the AST, lexer additions, parser dispatch, codegen coalescer, pipeline integration, and the parens-handling. User-facing reference is `docs/LANGUAGE.md` § Update filters. Tests in `test/update-filter.test.ts` (62 cases) plus a paired-form realistic case (`jsmql(string)` ≡ `jsmql(func)`) in `test/realistic.test.ts`.

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

**`architecture.md` — biggest cluster.** The `Expr` AST node list was missing five node types added since the spec was last touched (`BigIntLiteral`, `NewSet`, `CallExpression`, `ArrayFrom`, `NumberStatic`). The pipeline diagram terminated at `generate()` and the module-responsibilities table didn't list `pipeline.ts` or `stages.ts` — both load-bearing modules for the pipeline-mode path that runs from `compile()` in `src/index.ts`. The public `jsmql()` signature still claimed `: object` rather than the widened `: JsmqlOutput = object | object[]` that pipeline mode needs. The error-types table was missing `MqlInterpolationError` (public class, raised by the `mql` template tag) and `validate()`'s `RangeError` defensive arm. The lexer one-line summary listed only six of the twelve+ token shapes the lexer actually produces. And the cache section still described the `fnBodyCache` as "unbounded but safely so" — it has been a 256-entry LRU since the security-hardening pass on 2026-05-08.

**`grammar.md`.** The `$let` lambda paragraph said the lambda parameters "become the `vars` binding names" — direction reversed. The keys come from the object literal (the first arg); the lambda's params are added to scope so the body can reference them as `$$paramName`. The spec wording made it sound like the lambda was load-bearing for the binding step, which would mislead anyone trying to extend or debug the `$let` intercept. Also expanded the string-context-`+` method list from ten methods to the full sixteen the codegen actually checks (`STRING_RETURNING_METHODS` in `src/codegen.ts`); the old list silently understated when a `+` chain becomes `$concat`.

**`method-dispatch.md`.** `.flatMap(x => body)` was filed under "Array methods (no lambda)" — clearly wrong since it requires a lambda to do anything useful. Moved to the lambda section. The Set-receiver section described the dispatch route to `$setIntersection` / `$setUnion` / `$setDifference` / `$setIsSubset` but never listed the actual JS method names (`.intersection`, `.union`, `.difference`, `.isSubsetOf`, `.isSupersetOf`); added a small mapping table including the `isSupersetOf`-as-swapped-`$setIsSubset` trick.

**Smaller items.** `aggregation-stages.md` had a dead `[strict-subset-of-JavaScript](#)` link → repointed to `grammar.md#strict-js-subset-rule`. `accumulators.md` listed all 35 accumulators inline — replaced the static list with a pointer to the registry plus `vendor/mql-specifications/definitions/accumulator/`, since the drift-protection test in `test/operator-spec-coverage.test.ts` already keeps that set authoritative. `query-predicates.md` listed `$sampleRate` as a query-predicate scope item without acknowledging it's already in the expression registry as a `miscellaneous` operator — added a callout flagging the dual-context disambiguation as part of the spec's open design work. `operator-registry.md`'s `flex`-vs-`object` distinction got an explicit "object-literal arg is a value, not a shape signal" callout.

Operator counts in `operator-registry.md` (182 total, broken down by category) were verified against `src/operators.ts` by manual tally — accurate. The `test/operator-spec-coverage.test.ts` drift test continues to be the strongest defence here; the gap is that nothing automated catches AST-node-list drift or module-list drift, so those will need re-reading periodically.

---

## 2026-05-09 — Two follow-ups to the simplification sweep

Two course-corrections on the same day's sweep, both based on user feedback that the cuts were too aggressive on the wrong dimension.

**README \$accumulator example restored.** The earlier compression collapsed the migration section to a single \$where → \$expr example plus a link. That undersold the project — the \$accumulator-replacement case (count orders by status per shop, six string-encoded JS fields collapsing to one `.reduce()` with a computed key) is the strongest motivator we have. \$where → \$expr is real but small; \$accumulator is the "look how much shorter your code gets" pitch. Both examples now sit on the README front page; \$function gets a one-sentence mention since it follows the same pattern. Full guide stays in LANGUAGE.md.

**`in` with an object-literal RHS now compiles to property existence (JS-faithful).** The earlier commit rejected `\$.x in { a: 1 }` outright with a "use Object.keys().includes()" hint, on the grounds that JS's `key in object` semantic had no useful MongoDB equivalent. Wrong call — the JS semantic *does* have a clean MQL mapping for object literals: extract the keys at compile time and reduce to `\$in` against a literal array. `\$.x in { a: 1, b: 2 }` now emits `{ \$in: ["\$x", ["a", "b"]] }`. Computed keys evaluate at runtime; spread entries lower to `\$objectToArray(expr).k` and splice in via `\$concatArrays`. The semantic divergence is now documented explicitly in LANGUAGE.md: array on the right is value-membership (deliberate divergence from JS, matches MongoDB query intent), object on the right is property-existence (JS-faithful), scalar on the right still errors. Five new tests cover the static, computed-key, mixed-spread, and spread-only cases.

The principle: the project's #2 priority is *strict subset of JavaScript syntax*, but the per-construct semantic decisions are case-by-case. For `in`, MongoDB users typing `value in array` overwhelmingly want value-membership and we keep that even though JS does index-existence; but `value in object` already maps cleanly to property-existence and we should match JS there. Refusing to compile is the wrong default when a clean mapping exists.

---

## 2026-05-08 — Array spread compiles to `$concatArrays`

`[1, 2, ...$.arr, 3]` now compiles. Previously the codegen threw `CodegenError: Spread elements in array literals are not supported in MQL output` — same docs/code drift the object-spread change just closed. `docs/LANGUAGE.md:180-181` already listed `[...$.tags, "extra"]` and `[...$.a, ...$.b]` as valid syntax, but only the parser honoured it; codegen rejected. This entry closes the parity with the object-spread implementation that landed earlier today.

The lowering is the array equivalent of object spread: walk elements left-to-right, group consecutive non-spread elements into one `$concatArrays` operand (a literal MQL array), and emit each `...expr` as its own operand. So `[1, 2, ...$.arr, 3]` becomes `{ $concatArrays: [[1, 2], "$arr", [3]] }`. A lone `[...x]` returns `x` directly to avoid a redundant `{ $concatArrays: [x] }` wrapper. Each spread argument must evaluate to an array at runtime, the same constraint MongoDB's `$concatArrays` itself imposes.

The new helper `generateArrayLiteral` in `src/codegen.ts` sits next to `generateObjectLiteral` so the parallel structure is visible. Eleven new test cases in `test/codegen.test.ts` under `describe("array spread", …)` cover grouping, single-spread unwrap, multiple spreads, lambda-param threading, the empty-array fast path, and a nested `[[...$.a]]` regression. A realistic case in `test/realistic.test.ts` shows the natural use: building a combined moderator list and checking membership with `.includes()`. The call-arg variadic helper (`generateVariadicArgs`) is intentionally left alone — its per-arg wrapping reads more cleanly for short call lists, and it is documented as a separate concept in `docs/specs/method-dispatch.md`.

---

## 2026-05-08 — Defensive hardening from the security audit

A pass over the four issues a security review of the `mql` template tag and the surrounding APIs flagged as worth fixing. None of the findings were exploitable on the documented use case, but each one was a footgun or a contract gap the library could close cheaply. New `test/security.test.ts` covers all four.

**`mql` interpolation now rejects values that `JSON.stringify` mishandles.** Previously, `mql\`$.x == ${undefined}\`` silently produced the literal text `undefined` in the parsed source (interpreted as an unknown identifier two layers deeper); `mql\`$.x == ${NaN}\`` silently coerced to `null`; `BigInt` and circular structures threw a raw `TypeError` from inside `JSON.stringify`. New `MqlInterpolationError` (exported) is raised at interpolation time with a slot-pointing message (`mql interpolation slot 2 has type 'undefined'…`). Strings, finite numbers, booleans, `null`, arrays, and plain objects continue to round-trip unchanged. See `stringifyInterpolation()` in [src/index.ts](../src/index.ts).

**Parser and codegen now cap recursion depth at 200 levels.** Previously, deeply nested input (e.g. `'('.repeat(2000) + …`) blew the V8 call stack and threw an uncaught `RangeError` that bypassed `validate()`'s structured-error contract entirely. Both the recursive-descent parser ([src/parser.ts](../src/parser.ts) — instance counter on `parseExpression`) and the codegen ([src/codegen.ts](../src/codegen.ts) — module-level counter reset at each public `generate()` entry) now throw normal `ParseError` / `CodegenError` past the cap, with a `nests too deeply (max 200 levels)` message. 200 was chosen with margin: each parser level burns ~17 stack frames in the precedence cascade, so 200 levels ≈ 3400 frames, well under any platform's default. Real expressions never approach this depth.

**`validate()` is now total.** It used to throw any error class it didn't recognise (including `RangeError` and now `MqlInterpolationError`); a function named `validate` should never throw. New catch arms map `MqlInterpolationError` and `RangeError` into `SYNTAX_ERROR`, and a final fallback wraps anything else as a generic `CODEGEN_ERROR` with `internal error: …` so the structured-result contract holds for arbitrary input. No new error code introduced — `INTERNAL_ERROR` would have widened the public API; `CODEGEN_ERROR` is the existing non-positional bucket and matches the taxonomy.

**Compiled-body cache is now a bounded LRU (cap 256).** [src/index.ts](../src/index.ts)'s `fnBodyCache` was a plain `Map` whose growth was bounded only by the count of distinct arrow-function source strings in the host program — fine today, since `Function.prototype.toString()` returns static text. The bound is defence-in-depth against a future change that lets dynamic strings reach this map (e.g. accepting `new Function(...)` as input). LRU is implemented in-file as `cacheGet` / `cacheSet` via `Map` insertion-order.

**Deferred from this pass.** Server-side-JavaScript operators (`$function`, `$accumulator`, and `$where` via the unknown-operator passthrough at `codegen.ts:602`) remain emittable. The chosen direction is to surface them via the JS `function` keyword as first-class jsmql syntax — the same model as the `in` keyword — rather than a denylist or `{ allowServerJs: true }` flag. Substantial design work; tracked for a separate session. No `SECURITY.md` written yet either; will add once the threat model stabilises post-deferred-work.

---

## 2026-05-08 — Object spread compiles to `$mergeObjects`

`{ ...a, x: 1, ...b }` now compiles. Previously the codegen threw `CodegenError: Spread elements in object literals are not supported in MQL output`, which was both a real DX gap and a docs/code drift — `docs/LANGUAGE.md` already listed object spread as valid syntax with `{ ...$.defaults, priority: 1 }` examples.

The mapping is unambiguous: walk entries left-to-right, group consecutive non-spread entries into one `$mergeObjects` operand each, and emit each `...expr` as its own operand. JS spread's "later wins" matches `$mergeObjects`'s "rightmost value wins on key collision", so order is preserved without rearranging. Computed keys still produce `$arrayToObject`, but per-block — `{ ...$.base, [$.k]: $.v }` becomes `{ $mergeObjects: ["$base", { $arrayToObject: [["$k", "$v"]] }] }`. A lone `{ ...x }` returns `x` directly so the common no-op case doesn't get a redundant wrapper.

This unlocks the cleaner version of the histogram replacement in the README's `$accumulator` migration example. The reduce body went from `(acc, s) => $mergeObjects(acc, { [s]: (acc[s] ?? 0) + 1 })` to the more JS-natural `(acc, s) => ({ ...acc, [s]: (acc[s] ?? 0) + 1 })`. Same MQL output, less jsmql-specific syntax. Eight new test cases in `test/codegen.test.ts` under `describe("object spread", …)` cover the grouping rules, computed-key interaction, and the README's exact reduce expression.

The drop-in support also works inside operator argument objects — but those still reject spread, since an operator's argument keys are part of MongoDB's wire format and can't be runtime-merged. That restriction is tested too.

---

## 2026-05-08 — Position jsmql as the migration path for deprecated server-side JS

MongoDB 8.0 deprecates `$function`, `$accumulator`, and `$where` — the three operators that execute user-supplied JavaScript on the server. jsmql's authoring model ("write JavaScript expressions, get native aggregation operators") is exactly what MongoDB's own deprecation guidance points users toward, so we are explicit about it: the README now leads with the deprecation context, and `docs/LANGUAGE.md` has a new "Replacing server-side JavaScript" section with side-by-side migration examples in both the string form (`jsmql("…")`) and the function form (`jsmql(($) => …)`).

**Deliberate non-decisions.** No `function` keyword sugar in the grammar (an earlier-explored direction is now retired); no error or warning when the deprecated operators are emitted via the existing registry passthrough; no removal of the `$function` / `$accumulator` registry entries. The DX bar is clear: existing code that calls these operators continues to work without ceremony. The whole pivot lives in three files — `README.md`, `docs/LANGUAGE.md`, `docs/DEVLOG.md` (this entry) — and zero source or tests change.

**Why this shape.** Throwing an error or printing a warning would degrade users who already use these operators on older MongoDB versions, where they remain supported. Documentation does the work instead: anyone landing here from a "MongoDB $function deprecated" search query gets a direct migration table and a reason to adopt jsmql, while existing call sites continue to compile silently. The decision aligns with priority #1 (developer experience) and turns the deprecation into jsmql's strongest positioning lever to date.

---

## 2026-05-07 — Aggregation pipelines through `jsmql()`

`jsmql()` now compiles entire MongoDB aggregation pipelines, not just single expressions. No new exports — detection happens at the input boundary inside `compile()`. A top-level array enters pipeline mode when its first element looks like a stage attempt; the function returns `object[]` instead of the historical single `object`. Both forms work and may be mixed:

```js
jsmql(`[
  { $match: $.age > 18 },
  $sort({ created: -1 }),
  { $limit: 10 }
]`);
```

**Why both forms.** The stage-object shape `{ $match: ... }` mirrors what users copy out of Compass and the MongoDB docs; the stage-call shape `$match(...)` parallels the existing `$op()` escape hatch and is terser. They compile identically; users pick what reads better at the call site.

**`$match` auto-`$expr` wrap.** `$match` is the one stage with two body modes in real MQL — query document or aggregation expression (the latter must be wrapped in `$expr`). When a `$match` body parses as an object literal, jsmql treats it as a raw query document and passes it through; anything else is auto-wrapped, so `{ $match: $.age > 18 }` becomes `{ $match: { $expr: { $gt: ["$age", 18] } } }`. This is the only stage-aware transform; everything else is the existing object-literal codegen.

**Architecture.** New `src/stages.ts` registers all 45 stages from `vendor/mql-specifications/definitions/stage/` (description + per-stage `subPipelineFields`). New `src/pipeline.ts` owns detection (`isPipelineAst`), lowering (`generatePipeline`), and sub-pipeline recursion for `$lookup.pipeline`, `$unionWith.pipeline`, and `$facet.*`. `src/codegen.ts` is unchanged — pipeline lowering composes on top of `generate()`. The same registry-as-truth invariant we apply to operators (no `if (name === ...)` outside the registry) applies to stages.

**Parser change.** `parseObjectEntry` now accepts `Dollar IDENT` as a static object key, so `{ $match: ... }` and `{ $gt: 18 }` parse. This is JS-syntax-valid (`$match` is a legal JS identifier) and preserves the strict-subset-of-JavaScript invariant.

**Detection trigger is intentionally aggressive on `OperatorCall` first elements.** `[ $abs(1), $abs(2) ]` enters pipeline mode and fails strictly — top-level value arrays of expression-operator results are vanishingly rare in aggregation use, while typos like `[$prject({...})]` benefit hugely from a clear "not a known stage" error instead of silent compile-as-array.

**Public API.** `jsmql()` and `mql` return type widens from `object` to `object | object[]` (`JsmqlOutput`). Pre-1.0 it's a non-breaking change at runtime (arrays are objects); semver-tracked when 1.0 cuts.

**What's deliberately deferred.** Drift-protection test for `STAGES` (parallel to `test/operator-spec-coverage.test.ts`); query-predicate validation inside `$match` object-literal bodies (today they passthrough verbatim, see `docs/specs/query-predicates.md`); `$setWindowFields` static validation of window-only operators. Spec details in `docs/specs/aggregation-stages.md`.

---

## 2026-05-06 — `$op()` example operators replaced with operators that genuinely lack a JS equivalent

The example block under "no JavaScript equivalent" prose previously showed `$cmp`, `$in`, `$or`, `$size`, `$cond` — all of which *do* have JS counterparts (`<=>`-style comparison, the `in` keyword, `||`, `.length`, `?:`). Replaced with `$zip`, `$sampleRate`, `$stdDevPop`, `$dateTrunc`, `$topN` — operators with no JS analogue.

**Why.** The original examples undermined the framing of the whole section. A reader could reasonably conclude that jsmql's `$op()` form is just a stylistic alternative to JS syntax, when in fact its purpose is to reach MQL operators that don't have a JS surface at all. Picking the right exemplars makes the section's value obvious at a glance.

**Affected.** [`README.md`](../README.md), [`CLAUDE.md`](../CLAUDE.md), [`docs/LANGUAGE.md`](LANGUAGE.md), [`test/realistic.test.ts`](../test/realistic.test.ts) (header comment).

---

## 2026-05-06 — `$op()` renamed from "utility / fallback form" to "Escape Hatch (direct operator form)"

`$op()` was previously called "utility functions" / "fallback form" in user-facing docs. Renamed everywhere to "Escape Hatch", with "(direct operator form)" as the parenthetical explainer in headings and prose. EBNF grammar production renamed from `utility_call` → `operator_call` to match the spec.

**Why.** "Utility" implied auxiliary / second-class. "Fallback" implied the primary mechanism failed. Neither was true: `$op()` is the first-class way to invoke any MQL operator that doesn't have a JS surface in jsmql. "Escape hatch" carries the right "you are stepping outside the JS subset on purpose" connotation, which is the actual mental model.

**Affected.** [`README.md`](../README.md), [`CLAUDE.md`](../CLAUDE.md), [`docs/LANGUAGE.md`](LANGUAGE.md) (TOC, intro, Math notes, Date subsection, dedicated section, FAQ, EBNF), [`test/realistic.test.ts`](../test/realistic.test.ts) (header + 5 test names).

---

## 2026-05-06 — `flex` operator shape

Added a `flex` variant to `OperatorShape` in [`src/operators.ts`](../src/operators.ts) for MongoDB operators that genuinely accept either a single expression or an array of expressions. Migrated `$round`, `$trunc`, `$min`, `$max`, `$avg`, `$sum`, `$stdDevPop`, `$stdDevSamp`, `$mergeObjects`.

Behaviour: 1 arg → `{ $op: <expr> }`; 2+ args → `{ $op: [a, b, ...] }`; single spread (`...arr`) collapses to the single form; mixed spread + scalars use `$concatArrays` like the existing `array` shape.

**Why.** Several MQL operators have two valid shapes depending on the stage they appear in (accumulator-style in `$group` takes a single expression; expression-style in `$project` takes an array). The previous registry forced one fixed shape per operator, so one of the two valid forms was rejected at compile time. `flex` lets a single registry entry cover both forms naturally — argument count picks the output shape.

**Behaviour change.** Single-arg calls to migrated operators previously emitted either an unwrapped value or a one-element array depending on the operator's old shape; they now consistently emit the unwrapped form. Multi-arg behaviour is unchanged. `$first` / `$last` were considered but skipped — both contexts already take a single argument, so they are correctly modelled by `single`.

---

## 2026-05-06 — Adopt DEVLOG.md as the single historical record

Replaced `CHANGELOG.md` and `docs/ROADMAP.md` with this file. Stripped all `v1`/`v2`/`v3`/`v4` prefixes from `describe()` blocks, section dividers, spec headers, and grammar production names. Renamed `docs/specs/v3-method-dispatch.md` → `docs/specs/method-dispatch.md`.

**Why.** The `v1..v4` labels were development phases, not released versions. Carrying them in test names, spec titles, and changelog entries made the project look matured-out-of-the-oven when in fact it is still pre-`0.1.0` and the public API is not yet committed to. A single `DEVLOG.md` is also a better fit for the way changes actually happen here: we are not cutting releases; we are making decisions that future-us needs to justify. CHANGELOG-style "Added/Changed/Removed" sections force a release-engineering frame that does not match reality.

**How to apply.** Going forward every change — feature, refactor, naming, doc — gets a DEVLOG entry the same commit. If the entry would just be "renamed X to Y", that's fine; it is still load-bearing context for whoever reads the rename later.

---

## 2026-05-06 — Ban `npx`; keep TypeScript at ^6.0.0

Project rule: **never use `npx`**. It silently downloads ad-hoc package versions on first run, which masks version drift between contributors. Always use `npm run <script>` or `node_modules/.bin/<binary>` directly. Documented in [`CLAUDE.md`](../CLAUDE.md), and the single-test snippets in the Commands section now use `node_modules/.bin/vitest` directly. `npm install` is listed explicitly as the once-per-clone setup step.

I'd briefly downgraded TypeScript from `^6.0.0` to `^5.9.0` and re-added explicit `target` / `module` / `lib` to `tsconfig.json` to get `npm install` and `npm run build` working in this environment — that was reverted on user direction. `package.json` stays at `typescript: ^6.0.0` and `tsconfig.json` stays minimal (only options that differ from TS6 defaults). When the local toolchain catches up to TS6, both `npm install` and `npm run build` should work without further changes; until then, contributors needing a working build can vendor a local TS install or wait for the registry to publish 6.x.

---

## 2026-05-06 — Bump vitest ^1.6 → ^4.0

Bumped the test runner three majors in a single jump. All cases run unchanged on vitest 4.1.5; no test files needed edits. Audit went from 4 moderate vulnerabilities to 0 in the process.

**Why.** Sitting on vitest 1.x was a relic of the original scaffold and was already the loudest source of npm audit noise. Vitest 4 is a well-supported current major and aligns the dev toolchain with the just-landed TS6 / ESM-only direction (the runner is also ESM-first now).

**Behaviour change.** Consumers don't care — vitest is a `devDependency`. For contributors: vitest 4 requires Node ≥ 20, so the local `node` version needs to keep up.

---

## 2026-05-06 — Complete MongoDB expression operator coverage, anchored to the official spec

The operator registry now covers every MongoDB aggregation expression and accumulator operator the official `mongodb/mql-specifications` repo defines — 182 operators total, up from 147. Carriers of the gap: the entire **Bitwise** category (`$bitAnd`, `$bitOr`, `$bitXor`, `$bitNot`), the entire **Window** category (`$rank`, `$denseRank`, `$documentNumber`, `$derivative`, `$integral`, `$expMovingAvg`, `$shift`, `$linearFill`, `$locf`, `$covariancePop`, `$covarianceSamp`), Custom Aggregation (`$accumulator`, `$function`), Encrypted-String (`$encStr*` — for Queryable Encryption), Literal (`$literal`), `$meta`, `$tsIncrement`/`$tsSecond`, `$createObjectId`, `$hash`/`$hexHash`/`$toHashedIndexKey`, statistical accumulators `$median`/`$percentile`, BSON converters `$toUUID`/`$toObject`/`$toArray`, and `$sigmoid`. A duplicate typo (`$objectToArray2`) was removed.

`OperatorDef` gained two required fields, `category` and `description`. Both are surfaced in editor tooltips today and reserved for future docs generation. The new `OPERATOR_CATEGORIES` constant gives exhaustiveness checking with no runtime weight (string-literal union, not a TS enum).

**Spec as ground truth.** The official spec lives at `mongodb/mql-specifications` (Apache 2.0). It has no `package.json`, so it can't be installed as a normal npm devDependency — instead, [`vendor/fetch-mql-specs.mjs`](../vendor/fetch-mql-specs.mjs) clones it into `vendor/mql-specifications/` (gitignored) at a pinned commit, run as the package's `prepare` lifecycle hook. The new [`test/operator-spec-coverage.test.ts`](../test/operator-spec-coverage.test.ts) reads the YAML on every `npm test` and asserts the registry covers every spec operator and uses keys recognised by the spec for object-shape entries. Acceptable gaps (e.g. `$encStr*` not yet in spec, `$sampleRate` is a query predicate exposed for ergonomics) are documented in a `REGISTRY_ONLY` allowlist with comments.

**DX warnings added to [LANGUAGE.md](LANGUAGE.md)** for operators where the registry shape under-specifies real-world correctness: `$literal` bypasses field-ref evaluation; `$meta` takes a keyword string not an arbitrary expression; `$accumulator`/`$function` body fields are server-side V8 source not jsmql syntax; window operators are valid only inside `$setWindowFields`; `$substr` is deprecated.

**Five spec stubs in `docs/specs/`** for the rest of MQL: query-predicates, projection, accumulators-as-stage-spec, update operators, and [aggregation pipeline stages](specs/aggregation-stages.md). Each stub points at its corresponding `vendor/mql-specifications/definitions/<folder>/` so future implementation has a clear precedent. Atlas Search (`definitions/search/`) and BSON types (`definitions/types/`) are noted but not stubbed. *(The four future-work stubs were deleted on 2026-05-09 — see that day's "restructure" entry.)*

**Pinned spec commit:** `671c69579f9852c12ff89834ac73239f27005f81`. Bump in [`vendor/fetch-mql-specs.mjs`](../vendor/fetch-mql-specs.mjs) when MongoDB adds operators; the drift-protection test will surface what needs registering.

**Why.** The project's #1 priority is DX — every MongoDB expression a user might reasonably write should compile to correct MQL with verified shapes, not heuristically via `generateUnknownOperator`. Anchoring to the official YAML spec means descriptions, argument names, and existence are no longer lifted from doc pages by hand (drift risk) but pulled from the source MongoDB itself uses to drive their downstream tooling.

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

## 2026-05-06 — Function-form input for `jsmql()` and `validate()`

`jsmql()` and `validate()` now accept an arrow function as input, not just a string. The runtime calls `Function.prototype.toString()` on the function, strips the arrow prefix, and feeds the body to the existing parser. Identical MQL output to the equivalent string form, but the expression now lives inside real JS syntax — which means **prettier and oxfmt format it for free**, no plugin, no config.

That formatter-friendliness is the entire motivation. Template literal contents are opaque to JS formatters; long jsmql expressions in `mql\`…\`` sit as one un-broken line. Wrapped in an arrow, the same expression breaks and indents like any other JS. The `test/realistic.test.ts` "full address formatter" case was rewritten to the function form as the proof — same `$reduce` MQL output, dramatically more readable source.

**Restrictions in this release** (kept narrow on purpose, all surfaceable later if needed): arrow functions only (no `function` keyword); expression body only (no `() => { return …; }`); no `async`, no generators. The wrapper's parameter list is ignored — `($)`, `()`, `(doc)` all work — but the parameter is **not** bound inside the body. The recommended idiom is `($) => …` because `$` doubles as the document context. Outer-scope variables don't survive `toString()` (it's text, not a closure); when an unknown identifier is encountered via the function path, the existing `Unknown identifier 'X'. Did you mean '$.X'?` error is augmented to also point at `` mql`…` `` as the canonical interpolation tool.

**Caching.** Compiled bodies are cached in a `Map<string, object>` keyed on the **extracted body string** (not the function reference). Inline arrows in hot paths like `collection.find(jsmql(($) => $.status == "active"))` evaluate to a fresh function object on every call, so a `WeakMap<Function, …>` would never hit. The body string is stable across every evaluation of the same source location, so the cache works correctly for the common case. Cache size is bounded by source-code (no way to inject dynamic content into a function body), so no eviction is needed. The string-input path is intentionally **not** cached, because raw strings are often built via dynamic concatenation and would leak memory.

**Build-time path was explicitly rejected.** A babel/swc/unplugin transform would solve the closure problem cleanly and run the cache at compile time, but build-time tooling worsens DX in JS — particularly server-side — so this is runtime-only. A future prettier plugin (to format inside `` mql`…` `` string contents) and an eslint plugin for jsmql expressions remain on the table as separate, additive work.

Files: [src/index.ts](../src/index.ts) (overload, extraction adapter, body-string cache, `FunctionInputError`); [src/codegen.ts](../src/codegen.ts) (new `UnknownIdentifierError extends CodegenError` carrying the offending identifier so the index-layer can append the `mql` hint without string-matching). Specs updated: [docs/specs/architecture.md](specs/architecture.md), [docs/specs/grammar.md](specs/grammar.md). User-facing docs: new "Function Form" section in [docs/LANGUAGE.md](LANGUAGE.md).

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

## 2026-05-06 — JavaScript-style comments

Added `// …` line and `/* … */` block comments to the lexer, with semantics identical to ECMAScript. Both forms are pure trivia: discarded during tokenisation, never reach the parser or AST.

Implementation lives entirely in [src/lexer.ts](../src/lexer.ts): renamed `skipWhitespace()` → `skipTrivia()` and made it loop between whitespace and comment passes until neither makes progress. New helpers `skipLineComment()`, `skipBlockComment()`, plus a `LINE_TERMINATORS = /[\n\r\u2028\u2029]/` regex for the four ECMAScript LineTerminator characters. The divide-vs-regex `/` handler is untouched — by the time it runs, any leading `//` or `/*` has already been eaten, so the existing `lastTokenType` decision continues to work unchanged.

**Why.** jsmql is a "JS subset" language and the absence of comments was conspicuous, especially for multi-line expressions that already exist in `test/realistic.test.ts`. The divide-vs-regex disambiguation also makes raw `/` ambiguous to humans without comment context. Picking native-JS semantics (rather than inventing our own) means anyone who knows JS already knows how jsmql comments work — including the edge cases (LSEP/PSEP terminators, unclosed block error, atomic string/regex/template-quasi treatment, no nesting).

**Out of scope.** The legacy HTML-like `<!--` / `-->` (Annex B Script-mode-only in JS), nested block comments, and preserving comments in the AST. Those are not part of the "JS comments" mental model we're adopting.

**Pre-existing build issue noted but not fixed in this commit.** `npm run build` errors with `tsconfig.json(3,25): error TS5095: Option 'bundler' can only be used when 'module' is set to 'preserve' or to 'es2015' or later.` This is a regression introduced by the earlier "TypeScript 6, ESM-only publish" entry — the tsconfig was trimmed too aggressively (it relies on TS6 defaults that aren't in the locally-resolved TS 5.9.3, and `typescript@^6.0.0` isn't on npm yet). Tests are unaffected (Vitest doesn't use `tsc`). Tracked as the first item to address next; called out here so future-us doesn't re-bisect it.

---

## 2026-05-06 — JS-syntax surface for trigonometry and bitwise operators

Thirteen trigonometry operators and four bitwise operators that previously required the `$op(...)` escape hatch are now reachable through standard JS. All seventeen MongoDB operators were already in the registry — this is purely about routing JS surface to existing definitions, not new MQL semantics.

**Trigonometry via `Math.*`** — `Math.sin/cos/tan/asin/acos/atan(x)`, `Math.atan2(y, x)`, plus the hyperbolic family `Math.sinh/cosh/tanh/asinh/acosh/atanh(x)`. Each maps 1:1 to the matching `$sin` / `$cos` / `$atan2` etc. operator. The dispatch table in [`src/codegen.ts`](../src/codegen.ts) `generateMathCall` and the `MATH_METHODS` allowlist in [`src/parser.ts`](../src/parser.ts) gained matching entries; no AST changes. `$degreesToRadians` / `$radiansToDegrees` stay as escape-hatch only — JS has no equivalent.

**Bitwise infix operators** — `a & b`, `a | b`, `a ^ b`, and unary `~a` now compile to `$bitAnd`, `$bitOr`, `$bitXor`, `$bitNot`. Chains flatten the same way `+` and `&&` do: `$.a & $.b & $.c` → `{ $bitAnd: ["$a", "$b", "$c"] }`. The lexer no longer rejects bare `&` and `|` (previously errored with "did you mean `&&`?" — left over from when those operators had no in-language form); new tokens `Amp`, `Pipe`, `Caret`, `Tilde` were added in [`src/lexer.ts`](../src/lexer.ts), with three new precedence levels (`bitOr` < `bitXor` < `bitAnd`, sitting between equality and `&&`) and a `~` arm in `parseUnary` in [`src/parser.ts`](../src/parser.ts). Precedence matches JS exactly so `$.a == $.b & $.c` parses as `($.a == $.b) & $.c`.

**Why now.** ~98 of 187 MongoDB operators are escape-hatch only; expanding the JS surface where the JS spelling already matches MongoDB's semantics is pure additive value with no new design questions. Trigonometry and bitwise were the cleanest wins because the JS spellings (`Math.sin`, `&`) and the operator semantics (radians, integer-only) line up exactly. No semantic invention.

**No shift operators.** MongoDB has no `<<` / `>>` / `>>>` and we deliberately did not introduce those tokens — adding JS syntax that compiles to nothing useful would violate the "every accepted construct maps to MQL" implicit contract.

**Verification.** 27 new test cases in [`test/codegen.test.ts`](../test/codegen.test.ts) cover each new mapping plus chain flattening and JS-precedence interactions (`a == b & c`, `a | b && c`, `~$.flags & 255`). [`docs/LANGUAGE.md`](LANGUAGE.md) and [`docs/specs/grammar.md`](specs/grammar.md) updated with the new precedence table and operator tables. `npm test` passes 388/388.

---

## 2026-05-06 — Source kept in TypeScript's strippable subset; runs natively on Node 24+, Deno, Bun

jsmql's `src/` no longer relies on TypeScript constructs that require a compile step. The source runs as-is under Node 24's native type-stripping (stable, no flag), Deno, and Bun.

**Three blockers were removed:**

- The `const enum TokenType` in [`src/lexer.ts`](../src/lexer.ts) became an `as const` object plus a derived string-literal union. Call sites still write `TokenType.LParen`; only the declaration changed. Trades the const-enum's compile-time inlining for a small runtime object (~1 KB of literals — invisible).
- Parameter properties in three error/class constructors (`LexError`, `ParseError`, `Lexer`) were rewritten to explicit field declarations + `this.x = x` assignments. ~12 lines.
- Internal `.js` imports (10 statements across 7 files) became `.ts` imports. Paired with `allowImportingTsExtensions: true` and `rewriteRelativeImportExtensions: true` in [tsconfig.json](../tsconfig.json) so `tsc` still emits `.js` paths in `dist/` for the published package.

**[package.json](../package.json)** now declares `"engines": { "node": ">=24" }` so consumers/CI install on a runtime that supports native TS execution.

**Verification:** `node src/index.ts` (no flags) runs the source directly on Node 24+. A smoke test confirms all three public exports — `jsmql()`, `validate()`, and the `mql` template tag — produce correct MQL via native execution. `npm test` (393 tests) continues to pass under vitest, which already loads `.ts` directly.

**The invariant is now load-bearing:** anything new added to `src/` must remain strippable. No `enum`, no `namespace`, no parameter properties, no decorators, no `<T>x` casts, no `import =`/`export =`. Captured in [`CLAUDE.md`](../CLAUDE.md) and [`src/CLAUDE.md`](../src/CLAUDE.md).

**Why.** Drops the TypeScript-toolchain dependency for development and for downstream consumers who want to vendor the source. Aligns with the project's #1 priority (DX): a contributor can clone, `node src/index.ts`, and iterate without ever running a compiler.

**Out of scope, deliberately:** the long-standing `npm run build` issue with the locally-resolved TS 5.9 / TS6 mismatch (logged in earlier entry). Native Node execution does not need `tsc`; the build remains broken until TS6 ships, but it's no longer on the critical path for using or testing the project.

---

## 2026-05-06 — Strict JS subset rule + drop numeric field segments

Promoted "jsmql is a strict subset of JavaScript syntax" to a top-level invariant — `#2 priority` in the root `CLAUDE.md`, alongside DX. Also surfaced in `src/CLAUDE.md` and `docs/specs/grammar.md`.

**Audit.** The lexer, parser, and grammar were cross-checked against `node --check`. One realistic violation: numeric segments after `.` (`$.0`, `$.items.0`, `obj.0`) — JS rejects all three; you have to write `obj[0]`. Codegen was using this to emit MongoDB's dotted-path-with-array-index string (`"$items.0"`), but the syntax doesn't pass JS. Theoretical edge cases around using reserved words like `class`, `function`, `await` as bare identifiers exist in principle but aren't reachable through any documented or tested construct.

**Fix.** Dropped `Number` from `isFieldSegmentToken` in `src/parser.ts`. `$.items.0` now produces a parse error with the existing "Expected property name after '.'" message. Bracket access (`$.items[0]`) is the supported replacement.

**Codegen follow-on.** `$.items[0]` already worked, but `$.items[0].name` previously threw `CodegenError: Cannot access property 'name' on a non-field expression` because `MemberAccess` codegen only handled foldable field-path chains. Replaced the throw with a `$getField` fallback. Strictly additive: every input that folded into a path before still folds; inputs that threw now produce valid MQL. `$getField` was already used elsewhere in codegen, so no new MongoDB version floor.

**Why.** jsmql's pitch is "JS you already know"; a syntax JS rejects breaks the pitch. Pre-1.0, the breaking change is fine.

---

## 2026-05-06 — Template-literal interpolations auto-stringified

Template-literal interpolations are now wrapped with `$toString` unless the expression is statically known to produce a string. `` `n=${$.n}` `` produces `{ $concat: ["n=", { $toString: "$n" }] }` instead of `{ $concat: ["n=", "$n"] }`.

**Why.** JS coerces non-string interpolations to strings at runtime; the previous output errored at MongoDB runtime when `$.n` was a number or boolean, which failed exactly the cases template literals are most useful for. The wrap matches JS semantics. Expressions that are statically known to be strings (string literals, nested templates, `.toLowerCase()`, `String()` casts, string-context `+`, `typeof`, operators in `STRING_OUTPUT_OPS`) skip the wrap to keep output compact.

---

## 2026-05-06 — Type-aware dispatch for `.includes` / `.indexOf` / `.concat` and bracket access

`.includes()`, `.indexOf()`, `.concat()` and bracket access (`obj[k]`, `obj?.[k]`) now route by receiver type at compile time, with a runtime fallback for unknown receivers:

- Known array → array form (`$in`, `$indexOfArray`, `$concatArrays`, `$arrayElemAt`).
- Known string → string form (`$indexOfCP`, `$gte/$indexOfCP`, `$concat`).
- Unknown receiver (bare `$.field`, ternary, etc.) → runtime `$cond` on `$isArray` between the two forms. For bracket access, the object branch uses `$getField`.

**Why.** Same JS method name, different MQL operators depending on the receiver type. The compile-time check covers the cases where jsmql can prove the type from the AST (array literals, `.split()` results, `.map()` results, etc.). For unknown types, picking either form silently is wrong — the runtime `$cond` is verbose but correct. Users who want compact output can pin the type by chaining a type-fixing method (`.toLowerCase()`, `.slice()`) or by using the operator form (`$in`, `$indexOfArray`).

---

## 2026-05-06 — Typed second parameter for the function form (operator escape hatches)

`JsmqlInput`'s function arm gained an optional second parameter, typed `JsmqlOps = Record<\`$${string}\`, (...args: any[]) => any>`. Users can now destructure operator names from it to silence IDE warnings on direct `$op(...)` calls inside the body:

```ts
jsmql(($, { $dateDiff }) =>
  $dateDiff({ startDate: $.lastLoginAt, endDate: new Date(), unit: "day" }) ?? -1,
);
```

The change is **types-only**. `extractArrowBody()` strips the parameter list at the first `=>` before the parser sees anything, so the destructured names never reach the runtime — the lexer's existing `$<ident>` operator-call branch handles `$dateDiff(...)` exactly as it does in the string form. No runtime, no codegen, no parser changes; ~3 lines added in [`src/index.ts`](../src/index.ts).

**Why open-key (`` `$${string}` ``) and not literal-key autocomplete.** Deriving a literal-key map from `OPERATORS` would require switching the registry from `Record<string, OperatorDef>` to `satisfies`, which propagates through codegen lookup sites. Sizeable refactor for a marginal DX win — the core complaint (red squiggle on `$dateDiff`) is already solved by the open-key form. Trade-off: TypeScript won't catch typos like `{ $datediff }`; the runtime throws at codegen time with the existing "unknown operator" path. Acceptable for now; revisit if anyone asks for autocomplete on the destructure.

**Verification.** The "days since document was created" case in [`test/realistic.test.ts`](../test/realistic.test.ts) was rewritten from the string form to the destructure form — same `$dateDiff` MQL output, formatter-friendly source, IDE no longer flags `$dateDiff`. Documented in [`docs/LANGUAGE.md`](LANGUAGE.md) under the existing Function Form section.

---

## 2026-05-06 — TypeScript 6, ESM-only publish

Cut the toolchain over from TypeScript 5 to TypeScript 6 and leaned on the new defaults. `tsconfig.json` shrank to only the options that differ from TS6 defaults: `moduleResolution: bundler`, `rootDir`, `outDir`, and the `declaration` / `declarationMap` / `sourceMap` triple needed for a library publish. `target`, `module`, `strict`, `esModuleInterop`, and `lib` all inherit TS6 defaults (`es2025`, `esnext`, `true`, always-on, follows-target).

`package.json` is now ESM-only: `"type": "module"`, single `exports` entry pointing at the ESM build. The source has no Node-only APIs, so the emitted `dist/` runs in both Node (any ESM-capable version) and browsers via any modern bundler unchanged.

**Why.** TS6 ships saner defaults that drop a lot of tsconfig boilerplate; keeping the config to only what differs makes intent obvious to future readers. ESM-only is the simpler shape — dual-publish (CJS + ESM) is mostly machinery for older toolchains we don't have a use case for. The bump to ES2025 follows the TS6 default and matches what realistic Node and bundler targets accept today.

**Behaviour change.** Consumers using `const { jsmql } = require("jsmql")` must switch to `import { jsmql } from "jsmql"` (or `await import("jsmql")` from CJS code). No source-level API changes; expression-level output is unchanged.

---

## Earlier — modern JavaScript syntax and built-ins

Pre-DEVLOG history, captured here as a baseline for the current state of the language. See [`docs/LANGUAGE.md`](LANGUAGE.md) for the user-facing reference.

**Syntax.** Template literals (`` `${expr}` ``) compile to `$concat`. Optional chaining (`?.`, `?.[i]`, `?.()`) compiles identically to `.` because MongoDB's dotted-path traversal already null-passes through missing fields. Numeric separators (`1_000_000`). Computed object keys (`{ [$.k]: 1 }`) via `$arrayToObject`. Shorthand object properties (`{ x }` → `{ x: x }`) inside lambda scope. Spread in call arguments (`Math.max(...$.scores)`, `Object.assign(...$.docs)`).

**String methods.** `.trim`, `.trimStart`, `.trimEnd`, `.toLowerCase`, `.toUpperCase`, `.substr`, `.split`, `.replace`, `.replaceAll`, `.startsWith`, `.endsWith`, `.charAt`, `.indexOf`, `.includes`, `.match`, `.length`, `.concat`.

**Array methods.** `.at`, `.slice`, `.reverse`, `.map`, `.filter`, `.find`, `.some`, `.every`, `.reduce`, `.includes`, `.indexOf`, `.concat`, `.join`, `.flat` / `.flat(1)`, `.flatMap`, `.length`.

**Date methods/statics.** `.getFullYear`, `.getMonth` (0-based), `.getDate`, `.getDay` (0-based), `.getHours`, `.getMinutes`, `.getSeconds`, `.getMilliseconds`, `.getTime`, `.toISOString`, `new Date()`, `Date.now()`.

**Math methods/constants.** `Math.abs`, `.ceil`, `.floor`, `.round`, `.trunc`, `.sqrt`, `.exp`, `.log`, `.log2`, `.log10`, `.sign`, `.cbrt`, `.pow`, `.min`, `.max`, `.hypot`, `.random`. `Math.PI`, `Math.E`.

**Statics.** `Array.isArray`, `Object.keys`, `Object.values`, `Object.entries`, `Object.fromEntries`, `Object.assign`.

**Operator and unknown-operator behaviour.** Object-style operator calls route by the operator's registered shape: only operators with `object` shape (e.g. `$trim`, `$dateAdd`) require literal key names. For any other operator (or unknown), a single `{...}` argument is treated as a value and may use computed keys. Unknown operators (not in `OPERATORS`) pass through automatically using a few simple heuristics, making jsmql forward-compatible with new MongoDB releases.
