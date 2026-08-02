# DEFERRED — open work items

The single source of truth for everything jsmql currently **refuses, defers, or hasn't built**. Newest-thinking on top; rows deleted when the item ships.

This file is the antidote to "I keep forgetting about them". Every "not yet supported" / "future work" / "deferred" / "out of scope" marker in the live surface of jsmql (excluding historical `DEVLOG.md` entries) MUST carry a `[DEF-NNN]` tag and have a row below. The drift-protection test in [`test/deferred-coverage.test.ts`](../test/deferred-coverage.test.ts) enforces this both ways:

- Forward gate: every `[DEF-NNN]` tag → must have a matching row here.
- Reverse gate: every row here → must be referenced by at least one `[DEF-NNN]` tag in the live surface OR have `status: design-only`.
- Untagged-marker gate: every occurrence of a deferral phrase in the live surface → must carry a tag, OR be listed in `test/deferred-allowlist.txt` (with a one-line reason). Allowlist entries that no longer match any phrase fail the test — so the allowlist shrinks over time and cannot grow stale.

**Conventions.**
- Tag format: `[DEF-NNN]` — literal. Optional human label inside: `[DEF-005: merge]`. Match regex is `\[DEF-\d{3}\]`.
- When you ship an item: delete its row AND strip every `[DEF-NNN]` tag in the same commit.
- When you reject a feature with a "not yet" error: add the row AND a tag in the same commit.
- When a decision is "won't implement": add a row to the §B Decisions section. Don't add a `[DEF-NNN]` tag — the codebase explanation lives in the spec; this file just records that we considered and decided against.
- Per-row schema is in [`docs/CLAUDE.md`](CLAUDE.md#maintain-docs-deferred-md).

**Counts.** Open: 29. Decided-against: 9. As of 2026-07-10.

---

## §A. Open — to implement

### DEF-005 — `$merge` sugar (`$$$.coll += $$;`)

- **What's blocked.** Writing the result of a pipeline to a collection with merge semantics (upsert / merge into existing docs) rather than `$out`'s full replace.
- **Target lowering.** Default: `$$$.metrics += $$;` → `[{ $merge: "metrics" }]`. With pre-filter: `$$$.metrics += $$.filter(d => d.active);` → `[{ $match: { active: true } }, { $merge: "metrics" }]`.
- **Why blocked.** Default semantics are easy (whole-doc merge into `_id`). The four merge-control fields (`on`, `whenMatched`, `whenNotMatched`, `let`) need a syntax-design pass — should they be a config-bearing assignment (`$$$.metrics += { source: $$, on: "_id" }`), method chains (`$$.mergeInto($$$.metrics, { on: … })`), or stay only available via `$op($merge, …)`?
- **Attempted approaches.** Surveyed in fork plan §B2: rejected `$$$.coll <<= $$` (opaque sigil), `$$.mergeInto($$$.coll)` (reverses destination-on-left), `$$$.coll += { source: $$, on: … }` (overloads `+=` with config object).
- **Success criteria.** `$$$.metrics += $$;` lowers to `[{ $merge: "metrics" }]`. `$op($merge, {…})` remains the recommended path for non-default options.
- **Rejection site(s).** Spec only.
- **Spec.** `docs/specs/out-stage.md` § Deferred bullet 2.
- **Status.** design-only
- **Effort.** M

### DEF-006 — `jsmql.updateDoc()` — classic-form update operators

- **What's blocked.** The classic-form update operators (`$inc`, `$push`, `$rename`, `$pull`, `$pullAll`, `$pop`, `$min`, `$max`, `$mul`, `$currentDate`). `jsmql.update()` already emits the pipeline-form (`$set`/`$unset` array) — this is the *other* update shape.
- **Target lowering.** New entry point `jsmql.updateDoc(input)` returns a single object: `{ $inc: { count: 1 } }`, `{ $push: { tags: "vip" } }`, etc. Pattern table in fork plan §B3.
- **Why blocked.** Whole new entry point + ~10 operator pattern matchers + the decision about `$bit` / `$addToSet` (no idiomatic JS shape — keep as `$op($bit, …)`).
- **Attempted approaches.** None — full design in fork plan §B3 but no code.
- **Success criteria.** `jsmql.updateDoc("$.count += 1")` → `{ $inc: { count: 1 } }`. Multi-statement combinations work: `"$.count += 1, $.tags.push('vip'), delete $.tmp"` → `{ $inc: …, $push: …, $unset: { tmp: "" } }`. Same target with conflicting operators throws.
- **Rejection site(s).** No code — the API just doesn't exist. `docs/CLAUDE.md` "Future work areas" paragraph mentions update operators.
- **Spec.** Will need `docs/specs/update-doc.md` when work begins.
- **Status.** design-only
- **Effort.** L (full new entry point + 10 pattern matchers + tests)

### DEF-010 — Multi-binding `let a = …, b = …;`

- **What's blocked.** Comma-separated bindings inside one `let` statement.
- **Target lowering.** Single `$set` stage with both bindings: `let a = $.x, b = a + 1;` → `{ $set: { "__jsmql.var.a": "$x", "__jsmql.var.b": { $add: ["$__jsmql.var.a", 1] } } }`. Left-to-right evaluation order matches JS.
- **Why blocked.** Comma disambiguation against the update-filter `,` separator (`$.a = 1, $.b = 2`). The two are syntactically distinguishable (let-binding follows `let <Ident>`, update follows `=`/`+=`/etc.) but the parser doesn't currently route on that.
- **Attempted approaches.** None.
- **Success criteria.** `let userId = $.userId, total = $.amount * 1.1; $match(...);` lowers to one combined `$set` + `$match`. `let a = …; let b = …;` continues to work and produces equivalent (two `$set` stages, slightly worse).
- **Rejection site(s).** `docs/specs/let-bindings.md:199`.
- **Spec.** `docs/specs/let-bindings.md` § Deferred bullet 3.
- **Status.** open
- **Effort.** S

### DEF-011 — Partial extraction under `||` in `$match`

- **What's blocked.** `($.status === "active" && cond) || ($.status === "trial" && cond)` — if both `||` branches have a translatable factor that shares a field, we could lift the OR over the field-equality match, but today any residual under `||` makes the whole `||` fall through to `$expr`.
- **Target lowering.** Lift shared-prefix translatable conjuncts. Narrow safe rewrites only; correctness over partial gain.
- **Why blocked.** The disjunction translator currently prefers correctness — if any branch has a residual or empty query, the whole `||` becomes residual. Adding partial extraction needs a careful set of safe-rewrite rules.
- **Attempted approaches.** None.
- **Success criteria.** Narrow test cases land cleanly; the index-using guarantee of the `$or` translation is preserved.
- **Rejection site(s).** `docs/specs/match-query-translation.md:102, 169`.
- **Spec.** `docs/specs/match-query-translation.md` § Out of scope — future work bullet 2.
- **Status.** open
- **Effort.** M

### DEF-012 — Index-pitfall warning channel via `validate()`

- **What's blocked.** A `let` binding before an indexable `$match` blocks the match from using the index. The compiler could surface a warning, but `validate()` has no warning channel — only errors.
- **Target lowering.** No MQL output change. `validate()` gains a `warnings` array alongside `errors`; each warning carries `.pos`, `.severity: "warning"`, and a message naming the binding and the index that would otherwise be hit.
- **Why blocked.** Needs a new `warnings` array on the `ValidationResult` shape. Pre-1.0 the API isn't committed, so it's safe to add — but the wider question of "what other warnings do we want?" should be answered alongside (unused bindings? unreachable stages? deprecated patterns?).
- **Attempted approaches.** None.
- **Success criteria.** `jsmql.validate("let id = $.userId; $match($.x > 5);")` returns `{ valid: true, errors: [], warnings: [{ severity: "warning", pos: …, message: "let 'id' before $match blocks index usage on …" }] }`.
- **Rejection site(s).** Design only.
- **Spec.** `docs/specs/let-bindings.md` § Deferred bullet 4.
- **Status.** design-only
- **Effort.** M

### DEF-013 — Schema / metadata threading (`jsmql.bind({ db, collection })`)

- **What's blocked.** jsmql compiles statelessly — it doesn't know the current collection's name, so a self-join (`$$.find()` / `$$.filter()`) can't resolve its `$lookup.from`.
- **Target lowering.** New entry point `jsmql.bind({ collection, db })` returns a new callable shaped like `jsmql` (callable + `.compile` + `.validate` + `.expr` + `.filter` + `.pipeline` + `.update` + `.updateDoc`), with `boundCollection` / `boundDb` threaded into `GenerateCtx`. Mongoose plugin uses it automatically with the model's `collection.name`.
- **Why blocked.** Needs a new public-API entry point + a new `GenerateCtx` slot + the resolution rule in `$$.find`/`$$.filter` lowering.
- **Attempted approaches.** None — design in fork plan §B8.
- **Success criteria.** `const bound = jsmql.bind({ collection: "users" }); bound("$$.find(u => u.parentId === $._id);")` lowers to `$lookup` with `from: "users"`.
- **Rejection site(s).** `docs/specs/context-references.md:131-132` (allowlisted as a spec future-work bullet).
- **Spec.** `docs/specs/context-references.md` § Future work bullet 1–2. Will need its own `docs/specs/bind.md`.
- **Status.** design-only
- **Effort.** L

### DEF-014 — Optimised chained terminals on lookups

- **What's blocked.** Chains like `.map`, `.at`, second `.filter` after a lookup terminal currently fall through the generic path and emit one extra `$set` stage. Could be collapsed to a single specialised stage.
- **Target lowering.** Pattern recogniser in `extractLookupCalls` that emits single-stage variants for specific chain shapes.
- **Why blocked.** Performance optimisation, not correctness. Needs careful pattern enumeration so we don't break the generic path.
- **Attempted approaches.** None.
- **Success criteria.** `$$$.users.filter(u => …).map(u => u.name).at(0)` emits one `$lookup` + one `$set` (combined), not `$lookup` + `$set` + `$set` + `$set`.
- **Rejection site(s).** `docs/specs/lookup-stage.md:168`.
- **Spec.** `docs/specs/lookup-stage.md` § Future work bullet 5.
- **Status.** design-only
- **Effort.** M

### DEF-015 — Ambient TS types for `$$` / `$$$` / `$$$$`

- **What's blocked.** **Partially shipped.** All three prefixes are now declared as ambient `const`s in `src/ops.ts`, so arrow-form context-ref code (`({ $ }) => $$$.coll.find(...)`, `({ $ }) => $$.indexStats()`) type-checks instead of erroring on an undeclared identifier. The collection-/cluster-scoped diagnostic source stages (`$$.collStats(...)`, `$$$$.currentOp(...)`, …) are typed precisely with annotated option objects + JSDoc. **Still open:** every non-diagnostic ref form (`.push`, `.filter`, `.coll.find(...)`, `$out`, stream methods, member access) rides a permissive `[key: string]: any` tail and is therefore `any` — narrowing it to real collection/document types is the remaining work.
- **Target lowering.** No MQL change. The remaining work narrows the permissive `[key: string]: any` tail to schema-aware types.
- **Why blocked.** Precise typing of the lookup/out/find chains needs collection-name + document-schema threading, which is DEF-013. The diagnostic-ops typing (independently shippable) is done.
- **Attempted approaches.** Shipped the ambient-globals scaffold + diagnostic-op completion via `contextRefBlock()` in `scripts/generate-ops.mjs`, deriving methods from the `STAGES[…].diagnostic` field and a hardcoded option-shape map. Prototyped typing the `$$$` index as a chainable collection ref (so `$$$.orders.filter(...).sortBy(...)` gets stream-method completion) and reverted it: with a real-typed receiver the canonical `.find(pred)` callback trips `noImplicitAny`, and adding explicit `.find`/`.aggregate` signatures to fix that makes a bare `$$` stream no longer assignable to the `$out` write target (`$$$.coll = $$…`). `$$$.<coll>` is both a read head and a write target, so one index type can't serve both — it needs the document/collection typing this row + DEF-013 track.
- **Success criteria.** ~~`jsmql(({ $ }) => $$$.users.find(u => u.id === $._id))` type-checks without `any`.~~ Now type-checks, but the `find` chain is `any` pending DEF-013. Remaining criterion: that chain resolves to the joined collection's document type.
- **Rejection site(s).** `docs/specs/context-references.md` (Future-work bullet — now "partially shipped"), `lookup-stage.md`, `system-stages.md`.
- **Spec.** `docs/specs/ops-generation.md` § Context references (hosts the shipped generation); remaining narrowing tracked under DEF-013.
- **Status.** partial — diagnostic ops typed; lookup/out/find chains permissive `any`, gated on DEF-013.
- **Effort.** M (remaining)

### DEF-016 — Per-operator return-type narrowing in `ops.ts`

- **What's blocked.** Every generated operator in `src/ops.ts` returns `any`. `$abs($.x)` could return `number`, but doing so interferes with method-chain inference on field refs (`$.foo` is `any`, but `$abs($.foo)` shouldn't suddenly become `number` and reject `.toString()`).
- **Target lowering.** No MQL change. Types only. Need to design the field-ref vs concrete-value boundary carefully.
- **Why blocked.** The interaction with `$.foo : any` is the open problem. Pre-1.0 the types churn freely, so we'd want to land this once.
- **Attempted approaches.** None.
- **Success criteria.** `$abs($.foo)` is `number` in TS but field-ref chains still work.
- **Rejection site(s).** `docs/specs/ops-generation.md:73`.
- **Spec.** `docs/specs/ops-generation.md`.
- **Status.** design-only
- **Effort.** M

### DEF-017 — Drift-protection test for `STAGES` vs vendor MQL spec

- **What's blocked.** `OPERATORS` has a drift-protection test (`test/operator-spec-coverage.test.ts`) against `vendor/mql-specifications/`. `STAGES` has none — new MongoDB stages would be silently missed.
- **Target lowering.** No MQL change. New `test/stage-spec-coverage.test.ts` mirroring the existing operator one.
- **Why blocked.** Just hasn't been built. Copy-paste of the operator test with a path change.
- **Attempted approaches.** None.
- **Success criteria.** Test passes today; fails when a new stage is added to the vendor spec without a `STAGES` entry.
- **Rejection site(s).** `docs/specs/aggregation-stages.md:100` (allowlisted as a categorical "Out of scope (future work)" header).
- **Spec.** `docs/specs/aggregation-stages.md` § Out of scope bullet 1.
- **Status.** design-only — small win
- **Effort.** S

### DEF-018 — Type-level overloads of `jsmql()` for literal pipeline input

- **What's blocked.** `jsmql([{ $match: ... }])` returns the widened union of all output shapes. With overloads, a literal pipeline array input could narrow the return to `object[]`.
- **Target lowering.** No MQL change. TS overload signatures only.
- **Why blocked.** Pre-1.0 churn; not pulling its weight yet.
- **Attempted approaches.** None.
- **Success criteria.** `jsmql([{ $match: ... }])` is `object[]` in TS.
- **Rejection site(s).** `docs/specs/aggregation-stages.md:100`.
- **Spec.** `docs/specs/aggregation-stages.md` § Out of scope bullet 4.
- **Status.** design-only
- **Effort.** S

### DEF-019 — `.toSorted(comparator)` two-param arrow recognition

- **What's blocked.** `.toSorted()` accepts a key-function arrow today (`e => e.distance`) but rejects a comparator-style two-param arrow (`(a, b) => a - b`).
- **Target lowering.** `(a, b) => a - b` → `sortBy: 1`; `(a, b) => b - a` → `sortBy: -1`; `(a, b) => a.x - b.x` → `sortBy: { x: 1 }`. Everything else continues to throw with the `$op($sortArray, …)` hint.
- **Why blocked.** Pattern recogniser for the three shapes. Easy.
- **Attempted approaches.** None.
- **Success criteria.** The three shapes lower as above; non-matching shapes throw the existing hint.
- **Rejection site(s).** `DEVLOG.md:1428` (historical, no live throw — the runtime rejection happens in codegen with a generic comparator-not-supported message that doesn't carry the tag).
- **Spec.** `docs/specs/method-dispatch.md` (`.toSorted` section, no spec line today).
- **Status.** design-only — small win
- **Effort.** S

### DEF-022 — `Number.isFinite($.x)` (Infinity / NaN comparison)

- **What's blocked.** `Number.isFinite($.x)` is rejected because jsmql has no syntax for `Infinity` / `NaN` literals to compare against.
- **Target lowering.** Would need both literal-Infinity / literal-NaN escape hatches in the parser and a translation table for the resulting comparisons.
- **Why blocked.** Three-way blocker: no Infinity/NaN literal in jsmql source; MongoDB's `$eq` treats `NaN == NaN` as true (unlike JS); the lowering would touch every numeric comparison helper.
- **Attempted approaches.** None — the existing error message names three workarounds (`$type`, `$convert` sentinel, range guard).
- **Success criteria.** TBD with the literal-escape design.
- **Rejection site(s).** `src/codegen.ts:3309`.
- **Spec.** None — would need `docs/specs/numeric-edges.md` or similar.
- **Status.** open
- **Effort.** M

### DEF-024 — Forbidden-in-context inside sugar predicate block-bodies

- **What's blocked.** A literal *source/diagnostic* stage written inside a *sugar predicate block-body* lambda — `$$$.c.filter(o => { { $merge: 'm' }; })` (lookup) or `$ = { k: $$.filter(d => { … }) }` (facet) — gets must-first / must-last validation but NOT the forbidden-in-`$lookup`/`$facet`/`$unionWith` ban. Literal sub-pipeline arrays (`{ $lookup: { pipeline: [...] } }`) ARE fully covered via `generatePipelineWithCtx(container)`.
- **Target lowering.** No MQL change. Thread the container kind into `generateImplicitPipeline` when it runs as a block-body lowerer (`lowerBlock`), so block-body sub-pipelines enforce `forbiddenIn`.
- **Why blocked.** `lowerBlock` is the shared `SubPipelineLowerer`, used pervasively for predicate→`$match` translation (which produces top-level `$match` stages, not a sub-pipeline) as well as true sub-pipeline bodies. Binding a fixed container to it would mislabel the predicate-translation cases. A clean fix needs per-call-site container threading across `lookup-translation.ts` / `union-translation.ts` / `facet-translation.ts` — the same shape of change that the nested-block-body lookup work solved with a ctx carrier (`GenerateCtx.enclosingLookup`), so a `GenerateCtx.subPipelineContainer` carrier would close this analogously. Reachability of a literal write/source stage inside a predicate block-body is very low, and the gap never produces a false positive (at worst an imprecise must-last message or benign under-coverage).
- **Attempted approaches.** Considered binding the container into a `lowerBlock` factory at each pipeline.ts call site; deferred because several sites (`lowerReplaceStream`, `lowerOut`, the chain lowerers) have no single unambiguous container and a wrong label is worse DX than the gap.
- **Partial progress (2026-08-01).** Two of the three pieces are done. (1) Chained stage calls (`$$$.<coll>.$out(…)`) get the forbidden-in check directly: at each stage-link site the container is unambiguous, so `checkStageLinkPlacement` in `src/stage-link.ts` applies `forbiddenIn` / `position` without solving the general threading problem. (2) **Write stages are now blocked in every sub-pipeline, block bodies included** — a stage the registry forbids in *all three* containers (`stageForbiddenInAnySubPipeline`) needs no container label, so `generateStageBody` rejects it on the `GenerateCtx.inSubPipeline` flag alone. That closes the HR3 hole (mongod rejects `$out`/`$merge` in a sub-pipeline with Location51047). What remains is only the **imprecise wording** for the stages forbidden in *one* container (the diagnostics, `forbiddenIn: ["facet"]`) inside a block body: they still emit rather than naming their container.
- **Success criteria.** `$.x = $$$.c.filter(o => { { $merge: 'm' }; })` throws the forbidden-in-`$lookup` error with a meaningful `.pos`. Tests in `test/stage-validation.test.ts` / `test/pipeline.test.ts`.
- **Rejection site(s).** `docs/specs/pipeline-validation.md` § Known gap (tagged). `src/pipeline.ts` `generateImplicitPipeline` `container` param (forward-compatible hook, defaults `"top"`).
- **Spec.** `docs/specs/pipeline-validation.md` § Known gap.
- **Status.** open
- **Effort.** M (container threading through `lowerBlock` + tests)

### DEF-031 — Function-aware Filters via textual inline

- **What's blocked.** Using a reusable function inside a **bare Filter** (no `;`, e.g. `db.coll.find(jsmql("isAdult($)"))`). A function declaration needs a `;`, which flips the source into Pipeline mode, so a Filter can't currently declare or call one.
- **Target lowering.** A function used in a Filter would have to be **textually inlined** into the predicate (the Filter has no pipeline scope / `$let` stage to host the binding), then translated to the query language as if the body were written in place.
- **Why blocked.** Filters are a single expression with no statement list; threading a declaration in needs either a separate declaration channel or a textual-inline pass distinct from the pipeline `$let` expansion. Output shape differs from the pipeline form (inlined body vs `$let`), so it's a deliberate separate design.
- **Attempted approaches.** None — recorded at the developer's request as the likely next step for Filters.
- **Success criteria.** TBD with the inline design; `db.coll.find(jsmql("const adult = (p) => p.age >= 18; adult($)"))` (or a Filter-specific syntax) produces a query document with the body inlined.
- **Rejection site(s).** None — no bespoke throw; the existing pipeline-only requirement (`throwFuncDeclOutsidePipeline` in `src/parser.ts`) covers it generically.
- **Spec.** `docs/specs/reusable-functions.md` § Deferred.
- **Status.** design-only
- **Effort.** M

### DEF-032 — Higher-order functions (function passed as a value)

- **What's blocked.** Using a reusable function as a **value** rather than calling it — `$ = { fn: double }`, or passing it to another function (`arr.map(double)` as a function reference, higher-order composition).
- **Target lowering.** No direct MQL analogue — MongoDB has no first-class functions. Any support would have to inline at the eventual call site, which requires tracking the function value through the expression tree.
- **Why blocked.** MQL expressions can't carry a function value; the common `arr.map(double)` desire is already served by `arr.map(x => double(x))` (an explicit lambda whose body calls the function). A clear rejection already guides toward that.
- **Attempted approaches.** None — scoped out of the first cut per the developer's call.
- **Success criteria.** TBD; at minimum `arr.map(double)` would lower like `arr.map(x => double(x))`.
- **Rejection site(s).** `src/codegen.ts` `ParamRef` case (function-as-value error, tagged `[DEF-032]`).
- **Spec.** `docs/specs/reusable-functions.md` § Deferred.
- **Status.** open
- **Effort.** M

---

### DEF-033 — `$$.length` in a `$facet`/`$unionWith` sub-pipeline, a deep nested lookup, or a function body

- **What's blocked (narrowed).** `$$.length` (= the ROOT stream count) is now supported **inside a top-level `$lookup`** — its predicate (`$$$.coll.filter(o => o.n === $$.length)`), block body, and `.map` chain — by capturing the top-materialised `$__jsmql.length` into the `$lookup.let` as `jsmql_s0_length` and reading it back as `$$jsmql_s0_length`. Inner *sub-stream* counts ship too, via the named 3rd-arg handle (`.map((o, _i, coll) => coll.length)`). **Still blocked:** `$$.length` inside a `$facet` / `$unionWith` sub-pipeline; `$$.length` *deeper* than one `$lookup` level (capture is gated to `depth === 0`); and `$$.length` inside a **reusable function body** (`const f = () => $$.length`).
- **Target lowering.** `$facet`/`$unionWith`: their sub-pipeline lowerers would need the same `captureRootStreamLength` hook (`$facet` branches see the same docs, so the field is reachable; `$unionWith` has no `let` slot so it needs another route). Deep nesting: let-chain `v<d-1>_len → v<d>_len` at each level instead of binding only `depth === 0`. Function body: the function inlines at each call site, so the materialiser would need to hoist a `$setWindowFields` ahead of every calling stage — the body isn't in the inline AST where the per-statement scan runs.
- **Why blocked.** The shipped capture reaches one `$lookup.let` hop from the top; the remaining contexts need either a different carrier (`$unionWith`) or let-chaining (depth > 1) / call-site hoisting (functions). Scoped out of this cut.
- **Attempted approaches.** Shipped the top-level `$lookup` capture (`captureRootStreamLength`, `rootStreamLengthVar`) + the named sub-stream handle (`substreamLengthHandles`). Remaining contexts deferred.
- **Success criteria.** `$ = { k: $$.filter(o => o.x === $$.length) }` ($facet) captures the root count; a 2-levels-deep `$$.length` let-chains correctly; `const f = () => $$.length; $.n = f()` materialises ahead of the call site.
- **Rejection site(s).** `src/codegen.ts` `generateStreamLength` (the `topLevelStream`/`rootStreamLengthVar` gate — fires for `$facet`/`$unionWith`/deep nesting) and `src/pipeline.ts` `lowerFuncDecl` (reusable function body) — both tagged `[DEF-033]`.
- **Spec.** `docs/specs/stream-length.md` § Scope & rejections.
- **Status.** open (narrowed — top-level `$lookup` + sub-stream handle now ship)
- **Effort.** M

### DEF-034 — `.aggregate()` result as a `$$.push(...)` / `.concat(...)` union source

- **What's blocked.** Unioning the result of a foreign-collection `.aggregate(...)` into the stream — `$$.push(...$$$.<coll>.aggregate((o) => { … }))` (and the `.concat(...)` chain analogue).
- **Target lowering.** A `$unionWith` whose sub-pipeline is the aggregate body. Uncorrelated aggregates map cleanly (`{ $unionWith: { coll, pipeline: [<stages>] } }`); the correlated case has no home — `$unionWith` has no `let` slot, so a `$.<field>` correlation can't thread the outer document in.
- **Why blocked.** The no-`let`-slot limitation means a correlated aggregate can't be expressed as a union at all, and the uncorrelated case needs a deliberate decision on how it composes with the existing inline-doc / spread-collection batching in `$$.push`. Scoped out of the first `.aggregate` cut; the field-assignment form (`$.<field> = $$$.<coll>.aggregate(...)`) covers the correlated case.
- **Attempted approaches.** None — rejected at the union entry points with an actionable redirect to the field-assignment form.
- **Success criteria.** `$$.push(...$$$.metrics.aggregate((o) => { $group(...) }))` lowers to a `$unionWith` with the aggregate sub-pipeline (uncorrelated); a correlated aggregate stays rejected with the field-assignment redirect.
- **Rejection site(s).** `src/union-translation.ts` (`aggregateInUnionError`, tagged `[DEF-034]`).
- **Spec.** `docs/specs/lookup-stage.md` § `.aggregate` (Deferred bullet).
- **Status.** open
- **Effort.** M

---

## §B. Decisions — won't implement (rejected as bad DX or unnecessary)

This section records features we considered and **decided against**. Recording them prevents future-us from blindly reconsidering — the rationale is preserved.

### Projection-aware translation in `$project` body (`.slice` / `.some` → projection-form operators)

Was DEF-007. The idea was to make `.slice()` / `.some()` lower to *projection-form* `$slice` (single-arg) and `$elemMatch` inside `$project({ … })`. The premise is wrong: jsmql's `$project` is the **aggregation pipeline stage**, not a `find()` projection, and the projection-form operators are `find()`-projection-only features the aggregation stage rejects. Verified against a running mongod (2026-06-11):

- `{ $slice: N }` (single-arg) → `Expression $slice takes at least 2 arguments, … but 1 were passed` — in aggregation `$project`, `$slice` is always the expression operator.
- `{ $elemMatch: { … } }` → `Cannot use $elemMatch in this context` — `$elemMatch` is not an aggregation operator at all. Even where it is valid (`find()` projection), it returns the *matched element*, not a boolean — which would break `.some()`'s JS semantics.

The expression forms jsmql already emits run correctly in `$project`: `$.items.slice(0, 3)` → `{ $slice: ["$items", 3] }` and `$.items.some(i => i.x > 5)` → `{ $anyElementTrue: { $map: … } }`. The third proposed switch, `$meta`, already ships in `src/operators.ts` as a normal aggregation expression reachable via `$op($meta("textScore"))`. So there was nothing valid left to build — implementing it would have made jsmql knowingly emit invalid MQL, an HR3 violation.

### "From the end" array methods on a document STREAM (`.takeRight` / `.dropRight` / `.initial` / `.toReversed`)

Shipped 2026-07-19, **removed 2026-08-01** by developer decision. MongoDB has no stage that reverses a stream — `$reverseArray` is an *expression*, for an array inside a document — and a stream carries no order except the one a `$sort` gives it, so "the last n" has nothing to count back from.

The implementation was the argument against the feature. All four worked by reaching back and rewriting the **preceding** `$sort` (`reverseSortTrick`, now deleted), which:

- made them **position-dependent** in a way the JS methods they are named after never are — `.takeRight(3)` meant different things depending on which stage happened to precede it;
- **silently ordered by `_id`** when no `$sort` preceded, rather than erroring — a wrong answer with no diagnostic. This is what made `$$.shuffle().takeRight(3)` return the last 3 by `_id` and discard the shuffle entirely;
- made `.toSorted(c).toReversed()` a second, longer spelling of writing the comparator descending — the "which spelling does my codebase use?" friction rejected elsewhere in this section (see `feedback_no_silent_output_drift.md` in user memory).

**Not** rejected in value position: `$.items.takeRight(3)` → `$slice`, `$.items.toReversed()` → `$reverseArray` and friends all still ship. A stored array carries its own order, so there the methods mean exactly what they mean in JS. The distinction is the receiver, not the method.

The stream rewrite is to state the order and take from the front — `$$.toSorted({ createdAt: -1 }).take(3)` — which `fromTheEndRejection` (`src/stream-methods.ts`) names in the error. It is wired into all three chain-assembly sites: `unknownStreamMethod`, `validateLookupShape`, and the peel loop in `tryExtractChainedLookup` (that last one so a foreign chain can't quietly fall back to value-mode and slice the tail of an array whose order is whatever the foreign scan produced).

Reconsider only if MongoDB adds a stream-reversing stage. A re-implementation over the existing `$sort` machinery would land back on the same two defects.

### CLI `-S` / `--sort-keys`

`jq`'s key-sorting flag has no safe analogue here: MQL is order-sensitive in places (`$project` / `$addFields` computed fields can reference earlier siblings; stage-body key order can matter), so sorting object keys could silently change meaning. The `jsmql` CLI prints keys in the order the compiler emits them. This is the same "no silent output drift" principle behind the §A/§B negation and `$let`-peephole decisions — see `feedback_no_silent_output_drift.md` in user memory. Documented in `docs/specs/cli.md`.

### `!expr` via De Morgan in `$match`

Negation has subtle null/missing interactions in MongoDB. A silent index/non-index flip driven by data shape is exactly the surprise jsmql exists to prevent. `$op($not, …)` stays as the explicit escape. Documented in `docs/specs/match-query-translation.md:162-164`. See `feedback_no_silent_output_drift.md` in user memory for the broader principle.

### `$let`-as-optimisation (peephole)

When a `let` is read in exactly one downstream expression with no reshape between, the compiler *could* emit a single `$let` instead of `$set`/`$unset`. Rejected: the same input producing a different stage shape because of a downstream-reshape heuristic is the surprise jsmql avoids. Users who need `$let` write `$op($let, …)` explicitly.

### `in` operator query translation

JS `in` checks **property existence**; reusing it for array-membership would be a semantic mismatch. `.includes()` covers the common case and translates to `$in` cleanly. Documented in `docs/specs/match-query-translation.md:168`.

### Bare foreign-param ref (`o` alone) in a `$lookup` predicate

Not enough signal to choose between "all foreign docs" and "use foreign doc as key". User must write `o.<field>` or `o => true` explicitly. Rejected in `src/lookup-translation.ts:799-802`; tested in `test/lookup.test.ts:228-230`.

### Compile-time validation of runtime-dependent pipeline constraints

The pre-flight validator (`docs/specs/pipeline-validation.md`) throws only on violations that are 100% certain from the source. A whole class of server-enforced constraints depends on runtime state the compiler cannot know — sharding (`$out` to a sharded collection, `$unionWith`-in-`$lookup` on a sharded `coll`), transactions, view definitions, memory limits (`$group`/`$sort`/`$bucket` 100 MB without `allowDiskUse`, BSON 16 MB), collection type (`$out`→capped, `$merge`→time-series), read concern, and Atlas availability of `$search`/`$searchMeta`/`$vectorSearch`/`$listSearchIndexes`. jsmql emits the MQL unchanged for all of these and lets the server decide. Validating them at compile time would require modelling deployment/data state and would force throws on pipelines that are perfectly valid in another context — exactly the *probable*-not-*certain* throw rule #1 forbids. (Position rules that happen to involve an Atlas-only stage — e.g. `$search` must be first — still apply; only the availability check is skipped.)

### `$replaceRoot` verbose-form knob on `$ = …`

The lean `$replaceWith` shape is correct for the `$ = …` sugar. Adding a knob to opt into the verbose 4.0-compatible `$replaceRoot({ newRoot: … })` form adds API surface for no gain — users who need that shape write the stage call directly.

### Wrapping nested-operator `$`-strings ("Model A")

When a stage value is itself an operator call — `$project({ t: $concat("$a", "$b") })` — the `$`-string args pass through verbatim (`{ $concat: ["$a", "$b"] }`); they are NOT `$literal`-wrapped. We considered the alternative ("Model A": an operator call wraps its `$`-string args, so only *direct* stage-spec values pass through). Rejected: it makes the same `$op("$x")` call mean different things at different nesting depths, and breaks the "paste raw MQL and it round-trips" property. **HR1 (added later) settled this globally**: a source-typed `$`-string passes through in *every* context — pipeline, stage, and `jsmql.expr` alike — so there is no nesting- or surface-dependent wrap at all. Only runtime-injected values wrap. See [docs/LANG_RULES.md](LANG_RULES.md) (HR1).

### lodash Array / Collection methods with no clean MQL form

Value-mode covers the lodash Array + Collection vocabulary that maps cleanly to MQL (the positional, set-op/`By`, transpose, predicate-run, random, and `sortBy`/`orderBy` families). The methods below were **considered and rejected** (developer-approved 2026-07-18). Except for `unzipWith` (which carries a tailored hint, see below), each gets the standard unknown-method error — `didYouMean` supplies a suggestion when a supported name is close enough — so no rejection site or `[DEF-NNN]` tag is needed:

- **Mutating** — `pull`, `pullAll`, `pullAllBy`, `pullAllWith`, `pullAt`, `remove`. jsmql values are immutable expressions; there is no array to mutate in place. `.without(...)` / `.reject(pred)` / `.difference(other)` express the same intent functionally.
- **Custom-comparator `*With`** — `differenceWith`, `intersectionWith`, `unionWith`, `uniqWith`, `xorWith`. An arbitrary `(a, b) => bool` comparator has no MQL equivalent (MongoDB compares by value/key, not a user callback). The `*By`-iteratee variants (`differenceBy`, `uniqBy`, …) cover the realistic "compare by a derived key" need.
- **Deep / recursive** — `flattenDeep`, `flattenDepth`, `flatMapDeep`, `flatMapDepth`, `zipObjectDeep`. Unbounded-depth recursion isn't expressible in a single aggregation expression, and a fixed-depth unroll is poor DX. `.flatten()` handles the one-level case; property-path keys (`zipObjectDeep`) are a footgun MQL can't honour.
- **Binary-search sorted-index** — `sortedIndex`, `sortedIndexBy`, `sortedIndexOf`, `sortedLastIndex`, `sortedLastIndexBy`, `sortedLastIndexOf`. MQL has no binary-search primitive; `$indexOfArray` already linear-scans and backs `.indexOf`, so a "sorted" fast-path buys nothing.
- **No MQL meaning** — `forEachRight` (side-effect iteration, no value in a pure expression), `invokeMap` (invoke a method by path per element — no runtime method dispatch in MQL), `shuffle` (no permutation primitive; `.sampleSize(size)` gives a random reorder when one is genuinely needed).
- **`unzipWith`** — its iteratee receives a group whose arity equals the receiver's row count (runtime-dynamic), which a fixed-parameter arrow can't express. Carries a tailored error pointing at `.unzip().map(group => …)`, the idiomatic form.

### Ambient completion for object-receiver value methods (`.mapValues` / `.pick` / `.omit` / `.invert` / …)

The `@koresar/jsmql/ops` value-method augmentations (developer-approved 2026-07-21) type the lodash value methods onto the built-in `Array<T>` / `String` / `Number` interfaces so they autocomplete on concretely-typed receivers. The **object-receiver** methods (`.mapValues`, `.mapKeys`, `.pick`, `.omit`, `.pickBy`, `.omitBy`, `.invert`, `.toPairs`) are deliberately **left without completion**: the only interface to hang them on is `Object`, the base of *every* type, so augmenting it would advertise them (misleadingly) on numbers, strings, arrays, and every other value in files that import the module. They stay in `VALUE_METHOD_SKIP.object` in `scripts/generate-ops.mjs`. The methods themselves work in jsmql exactly as before — they simply don't surface in IDE completion. Revisit only if a narrower "plain object" carrier type emerges (e.g. once schema threading — DEF-013 — can type a document field as a specific object shape, `.pick`/`.omit` on *that* field could complete without the global-`Object` blast radius). Documented in `docs/LANGUAGE.md` § Operator autocomplete and `docs/specs/ops-generation.md` § Value-method augmentations.
