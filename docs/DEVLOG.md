# DEVLOG

A chronological log of decisions, changes, and the reasoning behind them. Every observable change to jsmql gets an entry here — this is the answer to future "why is X this way?" questions, the closest thing this project has to a ticket tracker.

**Conventions.**
- Newest entry on top.
- Each entry: short title, date (UTC), 1–3 paragraphs answering *what* and *why*. Include file refs where relevant.
- If a decision is later reversed or superseded, do not delete — add a follow-up entry that links back.
- Pre-1.0: no version numbers in entries. We are still finding the shape of the language; the package version stays at `0.1.0` until the public API is ready to commit to.

---

## 2026-08-11 — fix: a forbidden stage inside an `.aggregate` block names its container (closes DEF-024)

```
$ = { k: $$.aggregate(o => { $collStats({}); }) };
// before: [{ $facet: { k: [{ $collStats: {} }] } }]        ← emitted; mongod refuses it
// now:    '$collStats' is not allowed inside a '$facet' sub-pipeline. Move it to the
//         outer (top-level) pipeline.

$.t = $$$.orders.aggregate(o => { $out("archive"); });
// before: '$out' is not allowed inside a sub-pipeline — MongoDB only accepts it as …
// now:    '$out' is not allowed inside a '$lookup' sub-pipeline. Move it to the outer …
```

Two halves, one carrier. A stage forbidden in *every* container (`$out`, `$merge`) needed no label and was already caught by `GenerateCtx.inSubPipeline`. A stage forbidden in a *single* one (`$collStats`, `$facet`, `$geoNear`, `$indexStats`, `$planCacheStats`, `$search`, `$searchMeta`, `$vectorSearch` — all `forbiddenIn: ["facet"]`) cannot be judged without a container name, and inside an `.aggregate` block the assembly-loop validator never sees the stage. So it emitted.

DEF-024's blocker was that `lowerBlock` is one shared lowerer, used both for real sub-pipeline bodies and for lowerings that emit TOP-LEVEL stages, so binding a container to it would mislabel the second kind. The row itself named the answer — the carrier `GenerateCtx.enclosingLookup` already uses — and that is what shipped: `GenerateCtx.subPipelineContainer`, stamped by the ctx builders (`freshSubPipelineCtx(outer, container)`, `freshFacetCtx`) rather than threaded through `generateImplicitPipeline`. Every position that builds a sub-pipeline ctx now labels it, so all four containers report by name in *both* spellings, and `generateStageBody` reuses `forbiddenInContextMessage` — the same wording `checkStageLinkPlacement` produces for a chain link. The unlabelled all-container check stays as the fallback.

Verified against the registry rather than assumed: mongod *does* accept `$collStats` as the first stage of a `$lookup.pipeline`, so `forbiddenIn: ["facet"]` is right and `$.t = $$$.orders.aggregate(o => { $collStats({}); })` still compiles. The check is only as strict as the registry.

Probing the fix surfaced a second, pre-existing hole in the same family, closed here too. `$$$.dest = $$.aggregate(o => { $out("x"); })` emitted `[{ $out: "x" }, { $out: "dest" }]` — two terminal stages, which mongod refuses with "$out can only be the final stage". The `$out` write chain's stages land at the *top* level with its own `$out` appended after them, so the applicable rule is must-be-last, not forbidden-in-sub-pipeline; the stage-link spelling already got it from `checkStageLinkPlacement(…, isLastInContainer: false, "top")` and only the block spelling escaped. `GenerateCtx.beforeTerminalStage`, set for the whole write-chain RHS, carries the same rule with the same `mustBeLastMessage`.

---

## 2026-08-11 — feat: `const`/`let` bindings work in every predicate position

```
$.recent = $$$.orders.filter(o => { const t = o.total; return t > $.minTotal; });
// before: predicate has local `const`/`let` bindings, which isn't supported in this
//         position … fold any bindings into <expr>.
// now:    $match: { $expr: { $let: { vars: { t: "$total" },
//                                   in: { $gt: ["$$t", "$$jsmql_f0_minTotal"] } } } }
```

A block-bodied arrow with bindings worked everywhere a lambda produced a *value* — an in-document array method, `$let(vars, fn)`, an IIFE, `Object.groupBy` — and was refused in every *predicate* position, told to "fold any bindings into `<expr>`". Nothing forced that: `$match: { $expr: { $let: … } }` is ordinary MQL, and every one of the six positions now runs it (verified on a live mongod). An arrow should be as featureful as the language can make it, and a rejection whose only justification is that nobody wired the branch is a limit, not a design.

Three branches, one shape. `translatePredicate` and `buildPipelineFormPredicate` (the `$$$.<coll>` head and chain) and `lowerLambdaPredicate` (the four `$$` containers) each gained an `ExprBlock` case that emits the `$let` as the whole `$expr` — whole, because nothing inside a `$let` has a query-document form to translate, which is the one behaviour worth knowing: a predicate written this way is not the indexable query shape an expression body would produce. `extractLetsFromExprBlock` in [src/lookup-translation.ts](src/lookup-translation.ts) is the third sibling of `extractLetsFromExpr` / `extractLetsFromPipeline` and rewrites each initialiser and the `return`, so foreign paths resolve and a `$.<field>` read still hoists into the `$lookup.let`. Generation goes through a new `generateExprBlockWithCtx` export rather than a re-implementation, so the const-folding, shadowing, and re-declaration rules [generateExprBlock](src/codegen.ts) already owns keep applying.

`negateStreamPredicate` learned the form too: it negates the `return` and keeps the bindings, since bindings compute values while only the returned expression decides the match. That is what makes `.reject` work, and it let the foreign-chain `.reject` normaliser drop its own hand-rolled negation and call the shared helper.

The three `missingBody` hooks that carried the old rejection are now unreachable — a `Lambda` holds exactly one of `body` / `block` / `exprBlock`, and all three have a branch — so they became `internalError` calls, which is what an invariant the parser upholds should read as.

---

## 2026-08-11 — fix: `$$.aggregate(...)` works in every container a `$$` chain reaches

```
$ = { byStatus: $$.aggregate((o) => { $group({ _id: o.status, n: $sum(1) }); }) };
// before: .aggregate(...) runs a sub-pipeline against a FOREIGN collection … To add
//         stages to the CURRENT stream, write them directly.
// now:    [{ $facet: { byStatus: [{ $group: { _id: "$status", n: { $sum: 1 } } }] } }]
```

`applyStreamMethods` rejected `.aggregate` on `$$` as "a redundant spelling of writing the stages directly". That reasoning holds at a statement position and fails in a `$facet` branch, where a branch *is* a sub-pipeline and there is nothing to write directly instead — the error sent the developer to a spelling their container could not use. The rejection was also already inconsistent: an `$out` RHS accepted `$$.aggregate(...)` and always had, because that path dispatches through the stream-method registry rather than through the rejecting branch. Deleting the special case makes all four `$$` positions agree — `$facet` branch, `$$ =` stream, `$out` RHS, bare statement — and costs nothing, since two spellings of one lowering is a trade jsmql already accepts.

Also fixed alongside: a `$.<field>` read inside `$$.aggregate` was rejected by a message naming `.map(d => …)` — the shared `rejectLocalDocRef` defaults its method to `"map"`, and `.aggregate` never passed its own. It now names `.aggregate` and interpolates the developer's parameter, so the example reads `'o.x'` rather than a generic `d`.

---

## 2026-08-11 — fix: a pipeline stage name is rejected where a value is expected

```
$.x = $limit(5);
// before: [{"$set":{"x":{"$limit":5}}}]   →  mongod: Unrecognized expression '$limit'
// now:    '$limit' is a pipeline stage, not an expression — MongoDB has no '$limit'
//         expression operator … Write it as a pipeline statement ('$limit(…);') or as a
//         chain link ('$$.$limit(…)'). For the value-position equivalent, use '$slice(…)'.
```

All 44 stage-only names were accepted in value position and emitted MQL the server refuses. The rule this closes is the other half of the one the callback-block work stated: **stages are statements, operators are expressions — the name decides which, not the position.** That change stopped a statement appearing inside an expression-shaped callback; this one stops a statement *name* being used as an expression, anywhere.

`rejectStageInValuePosition` lives in [src/operator-validation.ts](src/operator-validation.ts) — the value-position pre-flight validator — and runs ahead of the unknown-operator passthrough, since it is the one check that must fire for a name `OPERATORS` does not hold. It belongs there rather than in codegen for two reasons: `stages.ts` is a pure leaf so there is no cycle, and codegen must not branch on stage names. The test is the registry intersection (`name ∈ STAGES && name ∉ OPERATORS`), which is what keeps three things working without a list to maintain — `$count` (a stage *and* an accumulator), an unknown name (HR2), and a raw `{ $limit: 5 }` object literal (the developer's own document, which the never-guard-raw-MQL rule protects).

This is inside the pre-flight validators' narrow exemption, not a violation of it: the exemption covers shapes **universally** invalid on every deployment, and no deployment has a `$limit` expression operator — unlike the cross-database `$lookup` namespace, which Atlas Data Federation does accept and which jsmql must therefore pass through.

One test changed rather than being added to. `jsmql.expr("$match($.a === 0)")` asserted `{ $match: { $eq: ["$a", 0] } }`, described as useful for a hand-written sub-pipeline literal. mongod refuses that document in *both* readings — there is no `$match` expression operator, and as a stage body a bare `$eq` is "unknown top level operator" — so the suite was endorsing an invalid shape, which `test/CLAUDE.md` forbids. `jsmql.pipeline("$match($.a === 0)")` → `[{ $match: { a: 0 } }]` is where a stage document comes from, and `jsmql.expr("$.a === 0")` where the expression does.

---

## 2026-08-11 — fix: the callback-block rule reaches `.takeWhile` / `.dropWhile` / `.flatMap`

```
$$ = $$.toSorted("t").takeWhile(d => { $match(d.a === 1); });
// before: A block body must end with a `return <expr>` statement at position 39, got '$'.
// now:    `.takeWhile(d => { … })` takes a JavaScript callback … `$match(...)` is a pipeline
//         stage, not part of a callback — chain them as stage calls instead — `$$.$match({ … })`.
```

Stages were already rejected in these three — but by the generic expression-block parser, which stops at the first `$` and so can neither name the statement nor point anywhere. They are the direct twins of the methods that got the real message: two predicates alongside `.filter`, one per-document transform alongside `.map`. Consistency in the *message* is what the rule is for, so `STREAM_BLOCK_METHODS` now covers them and [src/callback-block.ts](src/callback-block.ts) does the rejecting. The key-function methods (`.toSorted`, `.uniqBy`, `.groupBy`, …) stay out deliberately: they take a field expression, not a body of work, so a `$match(...)` there is a typo rather than a misplaced pipeline, and widening the grammar for them would be behaviour risk with no reader to serve.

The plumbing is one new seam rather than three edits. `prepareStreamArgs` in [src/stream-methods.ts](src/stream-methods.ts) is what every chain container now calls in place of `def.validate`: it folds a stage-free block back to its value form, then validates. Folding **before** validating is the part that matters — each method keeps its own shape error, so `.flatMap` still says it needs `d => d.<path>` and never learns that a block body exists. `StreamMethodDef.callback: "pipeline"` opts a method out of the fold; only `.map` and `.aggregate` set it, because they read the block themselves. Any future member of `STREAM_BLOCK_METHODS` inherits the rule without touching its validator.

One behaviour change falls out: `.flatMap(d => { return d.items; })` used to be rejected outright ("requires an expression body, not a block") while the identical JavaScript `d => d.items` compiled. It now emits the same `{ $unwind: "$items" }`, verified on a live mongod along with the `.takeWhile` / `.dropWhile` block forms. Every other accepting case is byte-identical to before.

---

## 2026-08-11 — fix(codegen): a literal array reaching a positional single-array-argument operator

`$.r = [1, 2].length;` emitted `{ $size: [1, 2] }`, which MongoDB refuses: the operand
slot of `$size` / `$first` / `$last` / `$reverseArray` is **positional**, so a bare array
there is spliced into an argument list — *"$size takes exactly 1 arguments. 2 were passed
in"*. The one-element `[7].length` was worse: `{ $size: [7] }` unwraps to the scalar and
fails with *"must be an array, but was of type: int"*. A two-token expression emitted MQL
that could not run, and the test suite was endorsing it — one case asserted
`{ $size: ["a", "b"] }` as expected output, exactly the failure mode
[test/CLAUDE.md](../test/CLAUDE.md) warns about. That expectation is corrected here.

This is the trap `arrayToObjectOfLiteralPairs` already documents for `$arrayToObject`,
so the remedy is the same: one extra level, `{ $size: [[1, 2]] }`, which the server unwraps
exactly once back to the intended operand. Rather than patch the twenty-odd emission sites
and rely on future vigilance, the four operators now have constructors — `sizeOf`,
`firstOf`, `lastOf`, `reverseArrayOf` — over a shared `singleArrayArg` that wraps only when
the operand really is a JS array. A field path, a `$$var`, or a nested operator document is
already unambiguous and passes through, so the constructors are safe everywhere and a new
call site can't reintroduce the bug. Object-**form** operators (`$map`/`$filter`/`$reduce`)
keep their receiver unwrapped: `input:` is a named value slot with no argument list to
splice into.

While fixing that, `.join()` / `.toString()` on an array OF arrays turned out to be
unfixable rather than wrong: JS recurses (`[[1,2],[3]].join(",")` is `"1,2,3"`) and MQL
expressions cannot, so the emitted per-element `$toString` fails on an inner array.
`rejectNestedArrayStringify` now rejects it with both ways out (flatten first, or map each
inner array to a string), gated to the two provable shapes — an array literal of arrays,
and `.partition(pred)`. Flattening one level silently would have answered a question the
source never asked. See [docs/specs/method-dispatch.md](specs/method-dispatch.md).

---

## 2026-08-11 — fix(lookup): `.aggregate()` on a collapsed chain says how to fix it

`$$$.orders.head().aggregate((o) => { $limit(1); })` reported `Unknown method
'.aggregate()'.` — a dead end, and a bare one: `didYouMean` had nothing to offer because
`.aggregate` is a stream method, not a JavaScript one, so it isn't in the value-mode
registry the suggestion list comes from. Nineteen spellings reached that message
(`.head`/`.size`/`.sum`/`.every`/… plus `.length` and a plain field read), while the
sibling `.find(pred).aggregate(...)` had a tailored message all along.

`rejectAggregateOnCollapsedChain` walks the receiver chain toward its `$$$.<coll>` head and
rejects when the outermost non-peelable hop already reduced the stream to a value, naming
that hop and the rewrite: *".aggregate() on a .head() result is not meaningful — .head()
returns a single value, not a collection to aggregate. Move .aggregate(...) ahead of it
('$$$.orders.aggregate((o) => { ... }).head()'), or drop .head() to aggregate the whole
stream."* The opening matches the `.find` message so the two read as siblings, but `.find`
keeps its own fix — it takes a *predicate*, so the user wants `.filter(pred).aggregate(...)`
rather than a reordered chain. Testing the lookup target before consuming a hop is what
keeps the collection access itself from being mistaken for a field read, and a receiver that
isn't `$$$.<coll>`-rooted is left to the generic paths, so an in-document
`$.items.head().aggregate(...)` is unaffected. See
[src/lookup-translation.ts](../src/lookup-translation.ts).

---

## 2026-08-11 — fix(lookup): an `.aggregate` head peels its chain instead of falling back to value mode

`$$$.<coll>.aggregate(A).<lodashMethod>(...)` now lowers through the chain assembler,
so it emits the same `$lookup.pipeline` that `$$$.<coll>.<lodashMethod>(...).aggregate(A)`
already did. [tryExtractChainedLookup](../src/lookup-translation.ts) used to bail on any
non-`.filter` head, which lumped `.aggregate` in with `.find` and sent the whole chain to
value mode over the result array. One branch decided the emitted shape, and the head
position — not the meaning — picked it.

Two of the fallbacks produced wrong output rather than merely bulky output, because a
receiver-family method has no meaning on the result *array*: `.pick([…])` read `$getField`
off the array and returned `{}` for every row, and `.omit([…])` emitted an
`$objectToArray` over an array that mongod refuses outright (`$objectToArray requires a
document input, found: array`) — an HR3 breach hiding behind a green suite. The rest drifted
silently: `.take` became `$slice` instead of `$limit`, `.groupBy`/`.uniqBy`/`.flatMap`
became large value-mode expressions instead of `$group`/`$unwind`, and `.sort`, `.$sort`
and a second `.aggregate` were rejected with errors about array mutation and unknown
methods. Adding one preceding `.sort()` fixed all of them, which is the tell. `.aggregate`
is a registered stream method, so routing a head `.aggregate` into the stream-head branch
needs no new seeding path — its own `lower` contributes the block's stages. Only `.find`
keeps dedicated handling; its result is a single document, not a stream.

This is the same rule [pipelineLookupBody](../src/lookup-translation.ts) already enforces
for the `let` clause: the shape is a function of the query, never of which emission site
ran. The surface that prompted the audit — `.aggregate()` *after* a lodash chain — turned
out correct but wholly untested, so [test/lookup.test.ts](../test/lookup.test.ts) gains a
describe block over both chain directions (argument forms, correlation, terminals, and
head-vs-link error parity), and [test/integration.test.ts](../test/integration.test.ts)
gains four cases that assert returned documents on the live fixture. The `.pick` case is
one a `toEqual` could never have caught. See
[docs/specs/lookup-stage.md](specs/lookup-stage.md).

---

## 2026-08-11 — fix(lookup): an array or string method after a document-returning value terminal

`$$$.orders.head().map(x => x)` emitted `{ $map: { input: { $first: … } } }` — `$map` over a
single document, which mongod refuses (*"input to $map must be an array not object"*).
`.take`, `.slice`, `.join`, `.toReversed`, `.toUpperCase` and `.trim` failed the same way,
across every element-returning terminal (`.head`, `.first`, `.last`, `.nth`, `.min`, `.max`,
`.minBy`, `.maxBy`): 67 of a 200-shape probe matrix reached the server and failed.

The generic chain type-check already owns this class, but it could not fire here.
`certainReceiverType` reads the receiver method's invariant `returns`, and these terminals
deliberately have none — `[1, 2].head()` is a number while `[{}, {}].head()` is a document,
so the registry cannot commit. Inside a `$$$.<coll>` chain it *is* known, because a
collection stream is a stream of documents; that is the fact the lookup layer can supply and
the registry cannot. `rejectDocumentTerminalMethod` uses it, deriving the
document-producing set as `VALUE_TERMINAL_METHODS` ∩ `returnsReceiverElement` rather than
listing it — which is what keeps `.sample` and `.groupBy` (same registry shape, but stream
methods) and the reducer-typed `.reduce` out of it automatically.

The violating-method test is the new `documentReceiverViolation`, shared with the existing
`.find(<pred>)` gate. Sharing it closes a gap on that older path too: the dual
`string | array` methods return `null` from `requiredReceiverFamily` — correctly, since
guessing between the two would cause false positives — but a document is *neither*, so
`.find(pred).slice(0, 2)` was a certain error that used to slip through. A receiver that
isn't `$$$.<coll>`-rooted is untouched, so an in-document `$.nums.head()` keeps the generic
paths. See [src/lookup-translation.ts](../src/lookup-translation.ts).

---

## 2026-08-11 — fix(parser): a misplaced stage block reports the real mistake, not a missing `return`

`$$$.orders.aggregat((o) => { $limit(2); })` — one letter short of `.aggregate` — used to
fail with *"A block body must end with a `return <expr>` statement"*. The block grammar is
chosen by name: only a method in `STREAM_BLOCK_METHODS` on a stream-rooted receiver parses
its `=> { … }` as a sub-pipeline, so any other name falls to the expression-block parser,
which duly demanded the `return` the user never wanted. The reported error was three steps
away from the typo that caused it, and the same trap caught `.mapp`, `.filte`, and every
other near-miss.

`parseExprBlockBody` now checks for a `$` token at its missing-`return` position — a `$`
there means the block holds stage calls, so the sub-pipeline was the intent — and
`subPipelineBlockError` names which of two things is actually wrong. A stream-rooted
receiver means the method name is the error, so the message carries a `didYouMean` over the
block methods (`Did you mean '.aggregate'?`). A non-stream receiver means the receiver is
the error, so it says stage calls need `$$` or `$$$.<coll>`, which is also the honest answer
for `$.items.map(d => { $group(…); })` on an in-document array. A block with no stage call
keeps the original message untouched.

Carrying that diagnosis needed the receiver's identity at the point of failure, so the
`blockKind: "pipeline" | "expr"` flag threaded through the five arg-parsing methods becomes
a `BlockArgCtx` object holding the kind plus the `method` name and `streamRooted` flag.
Widening the existing parameter beats adding a second one threaded alongside it. See
[src/parser.ts](../src/parser.ts) and [docs/specs/grammar.md](specs/grammar.md).

---

## 2026-08-11 — fix(parser): the misplaced-stage-block message states the `.aggregate`-only rule

Reconciling [fix(parser): a misplaced stage block reports the real mistake, not a
missing `return`](#2026-08-11--fixparser-a-misplaced-stage-block-reports-the-real-mistake-not-a-missing-return)
with [feat!: pipeline stages belong to `.aggregate(pipeline)` alone](#2026-08-10--feat-pipeline-stages-belong-to-aggregatepipeline-alone),
which landed in parallel. That message's tail read "Only a stream method that accepts
a sub-pipeline runs stage calls in its block" — true when written, false afterwards:
`.find` / `.filter` / `.reject` / `.map` / `.flatMap` / `.takeWhile` / `.dropWhile`
now get the block grammar so their statements *parse*, but a stage inside one is
rejected by [`src/callback-block.ts`](../src/callback-block.ts). Left alone, a
`.filte(o => { $match(…) })` typo would have been answered with "Did you mean
'.filter'?" plus a sentence implying `.filter` would then take the block — the exact
"never recommend syntax that doesn't work where you are" failure.

The suggestion still names the method the developer meant, because that is the
mistake they made; the tail now states the rule instead — pipeline stages belong to
`.aggregate(pipeline)` alone, every other callback's block body is JavaScript. The two
sites stay complementary rather than overlapping: `callback-block.ts` owns a stage in
a callback the parser *did* hand the pipeline grammar, with a container-accurate
rewrite, while `subPipelineBlockError` owns the cases that never reach it — an
unrecognised method name, and a non-stream receiver.

Also dropped a `docs/specs/lookup-stage.md` bullet still listing `$$.aggregate(...)`
as rejected; [stream-methods.md](specs/stream-methods.md) owns that behaviour now that
it works in every container a `$$` chain reaches.

---

## 2026-08-11 — test: an equality narrow is spelled `$$.filter({ field: value })`

Fifteen leading `$match($.field === value)` statements in
[test/realistic.test.ts](../test/realistic.test.ts) — the collaborative-filtering
example at the top of the file among them — are now `$$.filter({ field: value })`.
Same stage out (`{ $match: { field: value } }`, byte-identical; no expected value
in the file moved), fewer things to read: no `$.` prefix on each field and no
`===` to parse, and for a multi-field narrow the object is shorter outright.

It also makes the file speak one dialect. `.filter({ … })` is already how a
predicate is written on a `$lookup` chain, a `$facet` branch, an `$out` write
chain, and a `$$ = $$.filter(…)` narrow, so a reader met a different spelling only
at the top-level statement — the position they read first.

The rule applied, now recorded in the comment on the `$$ = $$.filter(...)` case,
is that this is a **plain-equality** rewrite. A matches-object compares every key
with `$eq`, so a predicate carrying a range or a null test keeps `$match(<expr>)`
— `$match($.placedAt >= a && $.placedAt < b)` reads better than any lambda that
means the same thing, and 13 sites keep it for exactly that reason. Three of those
are inside a lambda block body, where `$$` is the enclosing stream rather than the
sub-pipeline, so the rewrite would not have been equivalent at all.

---

## 2026-08-11 — test: the `$out` write chain gets its showcase examples

The `$out` RHS became a full container — stream methods, stage links, `.reject` —
but [test/realistic.test.ts](../test/realistic.test.ts) still showed only the two
oldest spellings: a bare `$$` write and a single `.filter(...)`. A reader of the
showcase would have concluded the RHS takes a predicate and nothing else. Four
cases close that.

The materialised view is the one worth reading first, because it is the job `$out`
exists for and it needs the whole container at once:
`$$$$.reporting.daily_revenue = $$.filter({…}).$group({…}).$sort({…})` — a lodash
predicate and two stage links, one statement, destination on the left and
transformation on the right. `$group`/`$sort` have no JavaScript spelling, so
before stage links this shape could not be written as a chain at all. The other
three cover `.reject(<matches>)` as the inverse filter, a `.toSorted`/`.take`/`.map`
export that also pins the short `$out: "<coll>"` string form the same-database LHS
emits, and a `kind: "err"` guard for a `.$out(...)` link inside a chain whose LHS is
already the write.

All three write shapes were run against a live mongod, into scratch databases
dropped either side, and the documents that landed were checked — not just the
emitted MQL (HR3). That run also surfaced the footgun now called out in the export
case: a `.map` reshape that omits `_id` makes the server mint a fresh one per
written document, so the export silently stops being joinable back to its source
unless the body carries `_id` through.

---

## 2026-08-11 — test: the showcase reaches for the shortest spelling that still reads

Seven chains in [test/realistic.test.ts](../test/realistic.test.ts) now use the
shorthand spelling, and every one of them emits MQL **byte-identical** to what the
test already asserted — not a single expected value moved. That is the point: the
file is what a new user reads first (README points at it, the playground extracts
its examples), so when two spellings compile to the same document the showcase
should carry the shorter one.

The `$facet` example is the visible change. Its three branches were
`$$.filter(o => { $sort(…); $limit(…); })`-style block bodies because that was the
only thing a branch accepted; a branch now takes any `$$` chain, so they read
`$$.toSorted({ score: -1 }).take(10)` and `$$.$group({ _id: $.status, n: $sum(1) })`
— one lodash chain and one stage link, with `.filter(<arrow>)` kept on the third
because `>=` has no matches-object form. The README's facet block follows, and its
claim that "every value a `$$.filter(...)`" is corrected to "every value a `$$`
chain". The other six are matches-object predicates in the places that only
recently started accepting them — an `$out` write chain, a `$$.push` spread, a
`.find` inside a `.map`, and two `.length` counts — plus one `.takeWhile`.

Two rewrites were tested and **rejected** for making the output worse, both the
same shape: `$.f = $$$.coll.filter(o => { <stages> })` writes straight into
`as: "f"`, while the equivalent lodash/stage-link chain routes through
`__jsmql.tmp.N` and pays a `$set` plus the trailing `$unset`. Until an assignment
whose chain needs no post-lookup value work can claim the `as` slot directly, the
block body is the leaner spelling and the showcase keeps it — at
`$.recentOrders = …` and at the `.aggregate((o) => { … })` customer report.

---

## 2026-08-10 — feat!: pipeline stages belong to `.aggregate(pipeline)` alone

```
$.recentOrders = $$$.orders.filter(o => { $match(o.userId === $._id); $sort({createdAt:-1}); $limit(5); });
// before: a $lookup with that sub-pipeline
// now:    `.filter(o => { … })` takes a JavaScript callback, so its block body holds `const`/`let`
//         bindings and one `return <expr>`. `$match(...)` is a pipeline stage, not part of a callback
//         — write `$$$.orders.aggregate((o) => { $match(...); $sort(...); ... })`, which runs those
//         statements as the sub-pipeline.
```

A `{ … }` body on a JavaScript or lodash method is now **JavaScript**: `const`/`let` bindings plus one `return <expr>`. Stages live in `.aggregate(pipeline)` and nowhere else. Two spellings for one lowering is fine; two *meanings* for one method is not — `.filter` meant "keep matching documents" in the expression form and "run this sub-pipeline" in the block form, so the same method name selected a different language depending on the body shape. The split now follows the method: `.find`/`.filter`/`.reject` are element predicates, `.map` is a per-document reshape, `.aggregate` is the pipeline. Nothing is lost — every rejected form has an exact `.aggregate` equivalent, with a `.map`'s `return <expr>` becoming the root-replace statement `$ = <expr>` (the same `$replaceWith`).

The rule lives in one new leaf module, [src/callback-block.ts](src/callback-block.ts), and every callback position routes through it: `detectLookupCall` / `validateLookupShape` / `translatePredicate` / `buildPipelineFormPredicate` / `chainFilterLambda` (the `$$$.<coll>` family), `requireStreamPredicate` (the four `$$` containers), `MAP.validate`, and `requireLambda` for a callback consumed as a value. The parser keeps handing those methods the sub-pipeline block grammar on purpose — parsing the statements is what lets the rejection name the offending one (`` `$sort(...)` ``, `` `$.x = …` ``, `` `delete $.y` ``, `` `assert(...)` ``) and the rewrite that works in **this** container: `.aggregate((o) => { … })` for a `$$$.<coll>` receiver, the chained-stage spelling (`$$.$match({ … })`) for a `$$` one, and "nowhere at all" in a value position. A grammar that stopped at the first `$` could only say "unexpected token". `StreamMethodDef.validate` and `requireStreamPredicate` gained a `stageRewrite` parameter so each caller supplies its own position-accurate sentence, per the rule that [an error never recommends syntax that doesn't work where you are](#2026-08-02--fix-an-error-never-recommends-syntax-that-doesnt-work-where-you-are).

Two things fall out. **A stage-free block now means what JavaScript means.** `.filter(o => { return o.userId === $._id; })` used to compile to `{ $lookup: { from, pipeline: [], as } }` — the predicate silently dropped, every foreign document matched. It folds back to the expression it returns, so it emits the indexed `localField`/`foreignField` form, identical to `.filter(o => o.userId === $._id)`. **`.aggregate` is now a `$$.push(...)` union source**, closing DEF-034: removing `.filter(block)` would otherwise have left a multi-stage `$unionWith` unspellable, and an uncorrelated aggregate maps onto `$unionWith.pipeline` exactly. A correlated one stays rejected — `$unionWith` has no `let` slot — and the message points at the field-assignment form, which does. Verified on a live mongod ([test/integration.test.ts](test/integration.test.ts)). `.find`/`.filter` also stopped disagreeing about `(element, index, array)`: both accept the JavaScript signature positionally and reject a *read* of either param, since a predicate has no index and no sub-stream yet.

---

## 2026-08-10 — fix: a block-body predicate's `return` is the predicate, not dead code

`$$ = $$.filter(o => { return o.a > 1; })` emitted `[]` — a pipeline that filters
nothing. Every predicate container dropped a block body's terminal `return`: the parser
splits it into `Lambda.ret` (so `.map` can lower it to `$replaceWith`), and the predicate
paths read only `lambda.block`. The failure was silent in the worst way, because `[]` is
valid MQL and a filter that matches everything looks like a working query. Three shapes
were affected — `{ return X; }` lost the predicate outright, `{ const a = …; return X; }`
emitted the binding stage and then ignored it, and `{ $match(q); return X; }` kept `q`
and dropped `X`.

The rule now is the JavaScript one: `o => { return X; }` IS `o => X`, so the two
spellings must emit one shape. [`canonicalPredicateLambda`](src/lookup-translation.ts)
canonicalises a predicate lambda before anything reads it — a stage-less block becomes
the expression lambda (which also earns it the indexed `localField`/`foreignField` route
that only the arrow spelling used to reach), and a block that keeps its statements gets
the return appended as a synthetic `$match(X)` statement. Folding it in as a *statement*
rather than lowering it separately is what keeps the two spellings from drifting again:
the return then rides the same parameter rewrite (an outer `$.<field>` still captures
into `$lookup.let`) and the same `$match` translation the expression body gets, so there
is no second predicate path to maintain. A `const` in the block now works too — it
materialises as its binding stage and the appended `$match` reads it back.

Canonicalisation runs at **every** entry point that receives a predicate lambda, not just
the two gates, because the `$$ =` pivot hand-rolls a `LookupCall` from the raw chain
method and so passes no gate — that bypass was why the correlated source-switch form
still differed after the gates were fixed. `.reject` was the symmetric half: it refused
every block body ("no single expression to negate"), which was right for a block of
statements and wrong for `{ return X; }`, and the foreign side hand-rolled its own copy
of the negation. Both now share `negateStreamPredicate`, and a block that genuinely has
no single expression to invert keeps the actionable error. The new tests compare the
block form against the expression form *outcome for outcome* across all seven containers
rather than against literal MQL, so the pair cannot drift apart; with the fix reverted, 26
of them fail. Emitted shapes were run against a live mongod (a `$match({b:1})` +
`return o.a > 1` block returns only the doc satisfying both).

---

## 2026-08-10 — fix: a predicate error names the receiver the developer wrote

```
$$ = $$$.orders.filter((a, b) => a > b);
// before: '$$.filter(<predicate>)' … must take exactly one parameter — write '$$.filter(o => …)'
// now:    '$$$.orders.filter(<predicate>)' … — write '$$$.orders.filter(o => …)'
```

The `$$ = $$$.<coll>.…` source switch lowers its `.filter` / `.reject` through the same
helpers the local `$$` chain uses, and those helpers spelled the receiver `$$`. The
arity message is the harmful one: it tells the developer what to write, and
`$$.filter(o => …)` reads the CURRENT stream. A developer who followed that advice
changed which collection the query reads and got no warning.

`requireStreamPredicate` and `localRefInPredicateMessage` now take a `receiver` option
(`$$` by default), and the two source-switch call sites pass `formatLookupReceiver(target)`
— the same spelling master already threads into the callback-block rewrite hint. The
cross-database spelling `$$$$.<db>.<coll>` comes through the same path.

`.reject` also never passed the callback-block `rewrite` hint to the gate, so a stage
inside a `$$ = $$$.<coll>.reject(o => { … })` block offered the chained-stage rewrite
that suits a `$$` chain. It now passes both the hint and the receiver, so the pair stays
in step.

---

## 2026-08-10 — fix: the `$$ =` source switch folds a callback block before it classifies

This supersedes "fix: a block-body predicate's `return` is the predicate" below.
That entry describes `canonicalPredicateLambda`, which no longer exists. The
callback-block rule — see "feat!: pipeline stages belong to `.aggregate(pipeline)`
alone" — covers the same ground and covers it better: a stage-free block folds to its
value form in one place, and a stage-bearing predicate block is now rejected outright
instead of lowered as a sub-pipeline.

Two sites still read a predicate before the fold ran, and both are in the `$$ =`
source switch:

- `predicateReferencesOuterDoc`, the probe that chooses between the flat `$unionWith`
  and the correlated `$lookup` pivot. It saw the raw block, found no `$.<field>`, and
  routed a correlated predicate to the uncorrelated lowering. That lowering then
  rejected the predicate with a message naming `$$.filter` — the wrong receiver for a
  `$$$.<coll>.filter` chain.
- `lowerLookupPivot`, which builds its own `LookupCall` rather than take one from
  `detectLookupCall`. It lowered `{ return <pred> }` to an **empty** sub-pipeline.

The second one is the dangerous shape: a `$lookup` with `pipeline: []` matches every
foreign document, so the query runs and returns wrong data. Both sites now call
`tryCallbackBlockToValue`, the non-throwing half of the fold, because a classifier must
stay side-effect-free.

The general rule this adds to the callback-block contract: a site that **classifies** a
predicate folds first, not only a site that lowers it. The regression tests compare each
block spelling against its expression spelling, and one test pins the emitted
sub-pipeline, because two equally broken forms compare equal to each other.

---

## 2026-08-10 — refactor: the sub-pipeline write-stage ban no longer depends on the path that lowered it

HR3 says jsmql never emits a `$out` / `$merge` inside a sub-pipeline, because mongod
rejects one with Location51047. The check read `GenerateCtx.inSubPipeline`, a flag two
factories set ([`freshSubPipelineCtx`](src/codegen.ts) and `freshFacetCtx`). That made
the rule contingent on how a container built its ctx: a sub-pipeline path added later,
or one that reuses the outer ctx instead of a fresh one, would emit the invalid stage
and no test would notice. The invariant is HR3-level, so it must not rest on each
author's memory.

[`assertNoWriteStageInSubPipeline`](src/pipeline.ts) now re-checks the **assembled
output** at every pipeline entry point: it walks the emitted stages, descends into each
sub-pipeline slot the registry declares (`subPipelineFields`, plus the `"*"` sentinel
for `$facet`), and rejects a stage that `forbiddenIn` bans from every container. It
reads the emitted document rather than a ctx flag, so every route into a slot — literal
array, sugar, block body, stage link, or a container written next year — is covered by
construction. The ctx-flag guard stays in front of it because it alone knows the
offending stage's own position; the backstop can only name the enclosing pipeline. That
split is deliberate and testable: with the flag deliberately broken, users still get
the correct message, and [test/error-pos.test.ts](test/error-pos.test.ts) fails on the
coarser position — so a path that drops the flag shows up as a suite failure instead of
silence. The alternative considered was to fold `inSubPipeline` into the existing
`ContainerKind` parameter; rejected because a block body has no container name to give
(DEF-024) and its `container: "top"` value is load-bearing for `topLevelStream` and the
`$match` placement rules, so the two facts are genuinely separate.

`GenerateCtx.inSubPipeline` became a **required** field in the same pass, which is what
makes a new fresh-ctx factory a compile error rather than a silent gap. Making it
required surfaced three ctxs that rebuild their fields one by one and had already
dropped the flag (`extendCtx` and the two `.reduce`-family remap ctxs in
[src/codegen.ts](src/codegen.ts)); none could reach stage lowering, so no emitted MQL
changed, but all three now carry it. DEF-024 stays open, narrowed to what actually
remains: a diagnostic stage that only *one* container forbids, inside a block body. The
row's own `$merge` example was stale — that stage is now blocked everywhere — so it now
names a single-container stage instead.

---

## 2026-08-09 — docs: drop the last phantom-release phrasing, and a `Landed` bullet that had already rotted

Follow-on to the `v1` sweep below. Two specs said work was *"out of scope for this
release"* — the same phantom timeline in different words, since there has been no
release to be out of scope for. Now "out of scope for now", which says the true thing:
nobody is working on it. `test/deferred-allowlist.txt` tracks the reworded phrase.

The more interesting find is [docs/specs/out-stage.md](docs/specs/out-stage.md)'s
`## Landed` section, whose "multi-method RHS chains" bullet claimed `lowerChainMethod`
"routes every non-`.filter` method through the registry" and then listed five method
names. That sentence was **invalidated two commits earlier** by the `$$.reject` work,
which added a second special-cased method — a spec paragraph going stale inside the same
session, which is about as sharp a demonstration of the rule as one could ask for. It now
names the shape of the exception (stage link, `.filter`, `.reject`) instead of the
membership of the set, and links to the section that owns the detail rather than
re-listing methods.

Worth noting what was *not* changed: the `Wave N` markers scattered through specs, test
names, and code comments. They are internal planning references rather than claims about
current state, so they mislead nobody — but a spec's `## Landed` section is duplicated
DEVLOG, and the bullet above shows it rots exactly like any other status snapshot. If
those sections go, this file is where their content already lives.

---

## 2026-08-09 — docs: remove the phantom `v1` marker, including from user-facing errors

The pre-1.0 rule in [CLAUDE.md](CLAUDE.md) bans `v1`/`v2` markers outright — they imply
released versions that don't exist — but twenty-odd had accumulated, and seven of them
were in **error messages users actually read**. `$$.reduce(...)` answered *"v1 supports
only these reducer shapes"* and `.slice(n, 5)` said *"aren't supported on streams in
v1"*, from a package at `0.1.8` where no v1 has ever shipped. A reader can only conclude
they're on some old version and that upgrading would help; there is nothing to upgrade
to. Now: *"supports these reducer shapes"*, *"aren't supported on streams"* — the
constraint stated without the phantom timeline.

The same marker was in [docs/LANGUAGE.md](docs/LANGUAGE.md), four specs, and a batch of
test names and assertions. **Every behavioural claim carried by those sentences was
re-verified against the CLI first and all of them were still true** — spread-form array
reducers (`[...acc, d.x]`), complex `.flatMap` arrow bodies, and bare foreign-param refs
are all still rejected. So this is purely a wording change: nothing about what jsmql
accepts moved. `test/deferred-allowlist.txt` picks up the two reworded "out of scope"
phrases it pins, per the STALE-ALLOWLIST gate.

Found while fixing the same class of rot in the `$out` spec (see the entry below): prose
that pins a *status snapshot* rather than stating the rule. A version marker is the worst
kind, because it rots without anyone touching it — the code moves on and the sentence
keeps asserting a release boundary that never existed. Where a real constraint remains,
the sentence now states the constraint; where it was history, it belongs in this file.

---

## 2026-08-09 — docs: the project reads as a finished product; history lives only here

New standing rule in [CLAUDE.md](CLAUDE.md) § "No development history outside DEVLOG":
**every file says what jsmql *is*; only this file says how it got here.** The repository
is pre-1.0 and under active initial development, but it must never look *visibly
mid-construction* to someone reading the source.

The trigger was `Wave 4 #11`-style internal planning references — a phase-numbering
scheme from a private plan, meaningless to any reader — sitting in `src/` comments, spec
bullets, test names, and the deferred allowlist. All are gone. Sweeping for the rest of
the class turned up more of it than the marker itself: `## Landed` sections (duplicated
changelog), session narration (*"a parallel fork session is implementing 11 of the
original 23-item batch"* in the allowlist header), and past-tense bug stories in test
comments and spec prose (*"the receiver was previously emitted three times"*, *"jsmql
used to fake these by rewriting the preceding `$sort`"*, *"was prototyped and
reverted"*).

Each was **rewritten, not deleted** — that prose was carrying real reasoning, and the
reasoning is what a reader needs. The rule is to state the invariant or the hazard rather
than the incident: "the receiver must be emitted once, not once per use"; "faking them
means rewriting the preceding `$sort`, which makes them position-dependent". Where a
section header narrated an event it now names a state — `## Removed: the "from the end"
methods` became `## Deliberately absent`, and `## Landed` became `## Design notes`.
Content that was *only* history moved here or was dropped, since git already has it.

Two carve-outs, recorded in the rule so they aren't swept later by mistake.
[docs/DEFERRED.md](docs/DEFERRED.md) and its markers are forward-looking statements about
the product, not history. And facts about *external* dependencies' histories stay — the
mongoose plugin's "modern mongoose (7+) no longer accepts callbacks" is a fact about
mongoose that justifies a current heuristic, not a story about jsmql.

---

## 2026-08-09 — feat: `$$.reject(...)` works in a `$out` write chain

`$$$.<coll> = $$.reject(<predicate>)` now lowers, emitting the same negated
`$match: { $expr: { $not: … } }` a `$$ = $$.reject(p)` chain emits, followed by the
`$out`. It was the only container where the `.filter` / `.reject` pair had come apart:
[src/out-translation.ts](src/out-translation.ts) special-cased `.filter` ahead of the
stream-method registry, and `.reject` isn't in that registry (it's a `.filter`
variant), so it fell through to the unknown-method error — while `.filter`,
`.map`, `.take` and the rest all worked.

That is exactly the next thing a user writes after the predicate-gate fix above:
having learned `$$$.archive = $$.filter({ status: "expired" })`, the inverse
("archive everything that ISN'T expired") is the obvious follow-up and hit a dead
end. Now that both the gate and the negation live in shared helpers
(`requireStreamPredicate` / `negateStreamPredicate`), the fix is one branch —
`.filter` and `.reject` share it — rather than a second copy of the lowering.
Verified against a live `mongod`: the emitted pipeline writes exactly the
non-matching documents.

---

## 2026-08-09 — fix: `.padStart()` / `.padEnd()` fill to a width instead of repeating the pad whole

Noted while measuring the `$let`-capture fix below, and fixed here. The lowering built its padding by repeating the *entire* pad string `targetLength - strLen` times, which is only correct when the pad is one character. JS pads to exactly `targetLength` **characters**, cutting a multi-character pad mid-string: `"gold".padStart(9, "US")` is `"USUSUgold"`, but jsmql emitted `"USUSUSUSUSgold"` — 14 characters for a request of 9. An SR2 violation (a native JavaScript API must behave as its JavaScript self), and a silent one: the result is a plausible-looking string, so nothing signalled the error.

MQL has no fill primitive, so the repeat stays and the run is trimmed back with `$substrCP`. Three details, each verified on a live mongod rather than reasoned about: the trim length is floored with `clampNonNegative`, because the `$cond` selects the other branch when the receiver is already long enough but the optimizer may fold this one anyway and `$substrCP` rejects a negative length; an empty pad needs no special case, since repeating `""` yields `""` and the trim leaves the receiver untouched exactly as JS does; and the trim is **skipped** when the pad is a source literal one code point long, so `.padStart(n, "0")` and the default space pad keep their existing, smaller output — the fix is invisible to the overwhelmingly common call.

One divergence remains and is now documented rather than hidden: the width is counted in **code points** (`$strLenCP`), where JS counts UTF-16 units. `"gold".padStart(9, "👍")` pads to 9 code points; JS pads to 9 units and produces a lone surrogate half. jsmql cannot emit that broken string through `$substrCP`, and shouldn't — it is the same code-point model `.length` and `.endsWith()` already use. Checked against real `String.prototype` across 15 call shapes × 7 receivers (multi-char pads, an empty pad, a pad longer than the target, a receiver already past the target, literal receivers that let the optimizer fold, and missing/null), plus a live integration case over the fixture's tier strings.

## 2026-08-08 — refactor: one namespace for compiler-emitted `$let` variable names

The two capture bugs below were each fixed at their own site. This closes the
class: `docs/specs/method-dispatch.md` already stated the law —

> `as` becomes a synthetic name `jsmqlPair` so it never collides with a
> user-named param

— but the code didn't uphold it. The `jsmql` prefix was a convention nothing
enforced, spelled as 33 hardcoded string literals across 164 occurrences in
`codegen.ts` with no single source of truth, so a param that happened to spell one
broke the lowering the same way `s` did:

```js
$.rows.map(jsmqlArr => jsmqlArr.list.slice(jsmqlArr.i))
// was → {"$let":{"vars":{"jsmqlArr":"$$jsmqlArr.list"}, … "$$jsmqlArr.i" …}}
// now → {"$let":{"vars":{"jsmqlArr2":"$$jsmqlArr.list"}, … "$$jsmqlArr.i" …}}
```

[src/namespace.ts](src/namespace.ts) gains `exprVar(base)` as the third namespace
it owns, beside the `__jsmql` document fields and the `jsmql_` `$lookup.let`
correlation vars. It owns the spelling only; `internalVar(ctx, base)` in
[src/codegen.ts](src/codegen.ts) adds `gensymInScope` on top, and every emission
site now routes through it. Per the CLAUDE.md rule that the spec wins on conflict,
the sentence stayed as written and the code was fixed to match.

Renaming is not the mechanism, and that matters: a prefix reservation in
`safeVarName` would have been one line, but it renames the *developer's* param in
the output (`as: "vjsmqlArr"`) and would also mangle jsmql's own synthetic
`jsmqlEl`, which a pure string function can't tell apart. The gensym moves our
binding and leaves theirs alone. It also returns the base untouched whenever
nothing collides, so this is output-neutral for every existing test except the
three deliberate renames below.

Three latent bare names went with it (`key`, `x`, `kv` — reachable only if
someone later spliced user codegen into those bodies), and the sweep turned up one
more live bug. `.fill()` builds its lowering on the AST with synthetic params, and
two of them were bare `x`/`i` — so the fill VALUE, generated inside them, captured
a pipeline binding of the same name:

```js
let x = 5; $.arr.fill(x, 1);
// was → "then": "$$x"   ← filled with each ELEMENT, not 5
// now → "then": 5
```

That rewrite runs before codegen with no ctx to gensym against, and `.fill()` is
reachable only at statement position (in expression position it throws), so no
lambda param can be in scope — the namespace alone is what keeps those four clear.
`wordsExpr`/`joinWords` are the other ctx-less callers; their bodies are fixed MQL
built from the ref itself, so nothing user-written can be captured.

Every lowering that binds an internal var and splices outer codegen into it now
has a hostile case in `test/codegen.test.ts` — the user's param keeps its name, and
the emitted MQL was run against a live `mongod` and matched Node's own semantics.

---

## 2026-08-09 — fix: one gate for every local `$$` predicate, so spelling can't change the MQL

`$$.filter(...)` / `$$.reject(...)` now take their argument through a single shared gate,
[`requireStreamPredicate`](src/lookup-translation.ts), in **every** container that lowers one:
the `$$ =` stream, a `$facet` branch, and an `$out` write chain. It normalises all four
predicate spellings — arrow, matches-object, field name, `["field", value]` pair — to the
single-parameter arrow the lowering consumes. This is the local-stream counterpart to what
`detectLookupCall` + `validateLookupShape` already did for the foreign `$$$.<coll>.filter(...)`
side, which was correct and complete all along.

*Why a gate rather than three fixes.* Each container hand-rolled its own argument handling, and
the three had drifted into a patchwork: `$out` accepted only an arrow (so
`$$$.archive = $$.filter({ status: "expired" })` was rejected outright), and the field-name and
`["field", value]` spellings worked in no local position at all. Worse, the `$$ =` stream *did*
accept a matches-object but lowered it down a separate **raw-query** path
(`{ $match: <the object generated as an expression> }`) instead of desugaring it like every other
spelling. That made the spellings observably different rather than merely unevenly supported:
`$$ = $$.filter({ a: 2 + 3 })` emitted `{ $match: { a: { $add: [2, 3] } } }` — an aggregation
operator in query position, which mongod rejects with `unknown operator: $add` (an HR3 violation
that a green `toEqual` had been endorsing), and `$$ = $$.filter({ a: $.b })` silently matched the
*string* `"$b"` rather than the field, while the identical arrow spelling was explicitly rejected
as ambiguous. Fixing the three sites separately would have left the next container free to invent
a fourth handling; the gate makes "read the raw argument yourself" the thing you have to go out of
your way to do.

The paired `$.<field>` rejection is shared for the same reason, as `localRefInPredicateMessage`.
Once a shorthand is normalised, its "lambda parameter" is the gate's *synthetic* name, so the old
per-site messages would have told a user who wrote `{ a: $.b }` to write `jsmqlItem.b` — advice
that cannot be typed. The shared builder names the parameter back only for a real arrow and
redirects a shorthand to the arrow form instead. Locked down by a table-driven
(position × spelling) equivalence test in [test/pipeline.test.ts](test/pipeline.test.ts), and the
`$add`-in-query-position shape was re-run against a live `mongod` to confirm the emitted `$expr`
form is accepted. Spec: [docs/specs/pipeline-validation.md](docs/specs/pipeline-validation.md)
§ the local-`$$` predicate gate.

While in the `$out` docs: the spec and [docs/LANGUAGE.md](docs/LANGUAGE.md) both still claimed
only `.filter` was wired into a `$out` chain "in v1" and that `.map` / `.sort` / `.slice` were
"not yet wired". The whole stream-method registry and chained stage calls have worked there for a
while — the prose had simply gone stale (and carried a `v1` marker the pre-1.0 rule bans).

---

## 2026-08-09 — refactor: drop the unreachable half of `STAGE_EQUIVALENT_HINT`

`STAGE_EQUIVALENT_HINT` in [src/out-translation.ts](src/out-translation.ts) maps a
chain-method name to the stage call to use instead, and is consulted **only** after
`lookupStreamMethod` returns null. Four of its six keys — `map`, `sort`, `slice`,
`flatMap` — had since been added to the stream-methods registry, so they lower fine in a
`$out` chain and their entries could never fire. Dead weight advertising a workaround for
something that already works. Removed; `reduce` and `flat` stay, being the two that
genuinely have no chain form. The table's doc comment now states the invariant (an entry
here means the registry does *not* carry the method), so the next method to land in the
registry gets its entry pulled at the same time.

Two neighbouring fixes fell out of reading the message this table feeds. The generic
fallback hint offered `$sort({ … })` / `$skip(N)` / `$limit(N)` as its examples — all
three now have working chain spellings, so it was steering users away from the shorter
form; it now points at the stage-call escape hatch generically. And the throw site had no
`didYouMean` tail, though it rejects a name from a closed set, which the root
[CLAUDE.md](CLAUDE.md) requires: `$$$.c = $$.mpa(d => d.x)` now answers *Did you mean
'.map()'?* instead of only naming the workaround.

The spec's "Adding more chain methods" section was stale in the same way — it sketched
per-method branches in `lowerChainMethod` for methods that had already landed via the
registry. It now states the actual rule: a new chain method goes in the shared registry
and `$out` picks it up for free.

---

## 2026-08-08 — fix: `.uniqBy` iteratee no longer shadows the `$reduce` accumulator

Sibling of the capture bug fixed in the entry below, but the shadowed name is
MongoDB's, not ours. `uniqByReduce` bound the user's iteratee param inside the
`$reduce`'s `in:` and then read `$$value.seen` / `$$value.out` **within** that
`$let` — so an iteratee spelling its param `value` shadowed the accumulator:

```js
$.a.uniqBy(value => value.id)
// was → the "have I seen this key" test read `.seen` off the ELEMENT, so nothing
//        ever matched and the dedupe returned every input document
```

`safeVarName` can't help here: `value` is a perfectly legal MongoDB variable name,
it just happens to be the one `$reduce` already uses. Renaming *our* side isn't
possible either — `$$value` is the server's spelling.

The fix moves the user's binding into the `$let` **vars value** position, which
MongoDB evaluates in the *enclosing* scope, so the accumulator reads in `in:` are
never inside it. That also binds the key once instead of re-emitting the iteratee
for both the membership test and the `seen` append, so the emitted document gets
smaller for every non-trivial iteratee; an identity iteratee (`x => x`) skips the
inner `$let` entirely since the key is just `$$this`. Affects `.uniqBy`,
`.sortedUniqBy`, `.unionBy` and `.xorBy`, which all share this lowering
([src/codegen.ts](src/codegen.ts)). Verified against a live `mongod`.

---

## 2026-08-08 — fix: compiler-internal bindings no longer capture user lambda params

`.padStart()`/`.padEnd()` lowered to a `$let` whose variable was literally named
`s`. The `targetLength`/`padString` arguments are generated in the **outer** scope
but spliced **inside** that `$let`, so a lambda param of the same name was
captured and the arguments silently re-resolved against the receiver string:

```js
$.items.map(s => s.code.padStart(s.width, s.pad))
// docs [{code:"7",width:3,pad:"0"},{code:"42",width:5,pad:"*"}]
// was → ["7", "42"]        ← padding silently vanished, no error
// now → ["007", "***42"]   ← matches String.prototype.padStart
```

Wrong data with no error is the worst thing we can emit, so the audit that came
with it covered every `$let`-emitting lowering in [src/codegen.ts](src/codegen.ts).
Three more sites had the same defect, two of them producing MQL the server
**rejects outright** — `.findIndex()`/`.findLastIndex()` and the reusable-function
call site built their `vars` keys from raw param names, skipping `safeVarName`:

```js
$.a.findIndex((_, i) => i > 2)
// was → mongod: "'_' starts with an invalid character for a user variable name"
```

That is an HR3 violation on the *idiomatic* JS throwaway param, and
`safeVarName`'s own doc comment names that exact case as its reason to exist —
the two sites simply forgot to call it. The fourth: a paramless callback's `as`
fell back to a bare `"v"`, so `$.a.map(v => $.b.map(() => v))` had the inner
binding shadow the outer element.

The padding binding is now `gensymInScope(ctx, "jsmqlPad")` rather than a plain
rename. A `jsmql` prefix alone is a convention nothing enforces — a user param
named `jsmqlArr` breaks `.slice()` exactly the same way — whereas the gensym
already shipped for `&&`/`||` short-circuit binding and consults the in-scope
params. It returns the base name untouched when nothing collides, so output is
unchanged for every program that doesn't actually use the name; only the
colliding case moves *our* binding aside (`jsmqlPad2`) and leaves the user's name
alone. Rejecting `jsmql*` user identifiers, or escaping them in `safeVarName`,
would instead have renamed the developer's own param in the output.

All four shapes were run against a live `mongod` and match plain Node's semantics
for the same input.

---
## 2026-08-08 — fix: the same capture class, found from the other end

Fixed in parallel with the two entries below, on a branch that started from the `$substrCP`/`$strLenCP` abort work. Same root cause, same `.padStart(3, s.pad)` reproduction; the mechanism converged on `internalVar` and this branch's own `letBind` helper was dropped in the merge as the narrower of the two.

Worth keeping is what the two sweeps found *separately*, because they searched differently and the union is what the refactor had to cover. That one enumerated every `$let`-emitting lowering and turned up `.findIndex()`/`.findLastIndex()` and the reusable-function call site (raw param names skipping `safeVarName`), the paramless-callback `"v"` fallback, and `.uniqBy`. This one took each internal binding NAME, used it as a lambda param, and passed an argument referencing it — which surfaced array `.slice(start)` (`Second argument to $slice must be a numeric value, but is of type: array`), `.lastIndexOf(needle)` (silently `-1`), `.dropRight(n)` (`can't $subtract array from int`), and `.intersectionBy`/`.differenceBy` (silently `[]`).

One discriminator is worth recording, since it explains why several equally common names were never at risk: only the `in:` **body** is exposed. A `vars` *value* is evaluated in the enclosing scope, before the binding takes effect, so `Object.groupBy`'s `key` binding and `.with(i, v)`'s bound arguments were always safe while `.padStart`'s body-spliced ones were not. It is now in [docs/specs/method-dispatch.md](docs/specs/method-dispatch.md) beside the `internalVar` rule.

## 2026-08-08 — test: the reported `.endsWith()` abort, covered against a live mongod

The two fixes below were both proven with `test/probe`, but neither had a standing regression test that runs on a **server** — and this whole bug class exists precisely because a green `toEqual` proves only what jsmql *emits*. So [test/integration.test.ts](test/integration.test.ts) now carries the reported query end-to-end.

The fixture gained one user ([test/fixtures/dataset.ts](test/fixtures/dataset.ts), u9 "Karen Spärck Jones") whose `email` key is **absent** — u5's is present-but-null, so missing and null are now both represented, which matters because they reach `$strLenCP` by different routes. She is deliberately archived + inactive and has no email at all, so she falls outside every pre-existing active/non-null-email assertion; nothing else in the suite needed re-deriving. The rest of the hazards were already in the data: u4's `"kat@nasa.gov"` is 12 characters, one shorter than the 13-character needle `"@bletchley.uk"`, which is exactly the negative index that started this.

Three cases: the domain filter that must return only Joan Clarke, the user's own `"@flash-payments.com"` predicate (every email is shorter than the 19-char needle, so matching nothing is the right answer and aborting was the bug), and a value-mode case asserting `.slice(-13)` / `.length` results per user so missing and null are pinned to `""` / `0` rather than merely "didn't crash". Checked against the pre-fix compiler: all three fail with `$substrCP: the starting index must be nonnegative integer` — the reported error verbatim.

## 2026-08-08 — fix: string-length lowerings tolerate a missing field

The companion half of the `$substrCP` fix below. `$strLenCP` is the one string primitive that **aborts the query** when its input is missing or null (`Location34471`) — `$indexOfCP` returns `null` and `$substrCP` returns `""`. Every length jsmql derives goes through `$strLenCP`, so ten lowerings took a query down on any document lacking the field: `.endsWith()`, string `.slice`/`.substr`/`.substring`, `.length`, `.padStart`/`.padEnd`, `.truncate`, and the `strTail` family (`.capitalize`/`.upperFirst`/`.lowerFirst`/`.camelCase`). The asymmetry was the tell: `.startsWith("@x")` on an absent field returned `false`, while `.endsWith("@x")` on the *same* field killed the query. Both spellings of one idea, opposite outcomes.

A new `strLenOf` helper in [src/codegen.ts](src/codegen.ts) coerces the receiver with `$ifNull: [_, ""]` (skipping the wrap when an optional chain already applied one) and now backs every `$strLenCP` jsmql emits — the only raw ones left are on `$let` bindings that were coerced at the binding site. That distinction matters: for `.padStart`/`.padEnd`/`.truncate`/`.endsWith` the **binding** is coerced rather than each `$strLenCP` argument, because coercing only the length leaves the trailing `$concat` returning `null` on a missing field instead of the fully-padded string. `.truncate` also moved to a `$let`, which stopped it emitting its receiver three times. The result: on an absent field `.length` is `0`, `.padStart(5, "0")` is `"00000"`, `.capitalize()` is `""`, `.endsWith(…)` is `false` — the same answers as on `""`. A *type* mismatch (an array where a string is expected) still errors, exactly as the already-safe methods do.

`strLenOf` also folds a literal receiver's length at compile time, which shrinks the common case sharply — `"hello".slice(-3)` went from a `$max`/`$subtract`/`$strLenCP` tree to `{ $substrCP: ["hello", 2, 3] }`, and `.endsWith(".pdf")` now emits `4` twice instead of splicing `{ $strLenCP: ".pdf" }` in three times. Two traps the fold has to respect, both verified on the server: `$strLenCP` counts **code points** where JS `.length` counts UTF-16 units (`"a👍b"` is 3, not 4), and per HR1 a source string starting with `$` is a field reference, never a literal to measure. Verified by diffing every touched method against real `String.prototype` results across `"hello"` / `"ab"` / `""` / missing / `null` receivers — all agree, where six previously aborted.

## 2026-08-08 — fix: floor every computed `$substrCP` index and length at zero

A user reported that `$$.filter(u => u.email.value.endsWith("@flash-payments.com"))` killed the whole query on a production `users` collection: `$substrCP: the starting index must be nonnegative integer`. `.endsWith()` lowered its tail index to `strLen - needleLen`, which is **negative** for any document whose string is shorter than the needle — `"a@b.com"` (7) against a 19-char needle gives `-12`. MongoDB's `$substrCP` does not clamp a negative start the way JS does; it aborts the executor (`Location34455`, and `Location34454` for a negative length). One short string anywhere in the collection was enough to take the query down. Note that optional chaining offered no escape: `$.s?.endsWith(…)` wraps the receiver in `$ifNull: [_, ""]`, which makes `strLen` `0` and the index *more* negative.

An audit of every `$substrCP` emission site found the same class in six more places, and three of them emitted MQL that is invalid *independently of the data*: `.substr(-3)` and `.charAt(-1)` passed the negative literal straight through, so the server rejected them for every document. `.substr(-3)` was also semantically wrong per SR2 — JS reads it as "the last 3 characters". The root cause of the `.slice` half is visible in the code: `normaliseSliceIndex` in [src/codegen.ts](src/codegen.ts) is a port of the array-side `resolveSliceIndex` that dropped the `$max`/`$min` flooring, and its own doc comment stated the invariant (*"MQL `$substrCP` rejects negatives"*) that the body then violated.

The fix renames `clampNonNegativeLength` to `clampNonNegative` (it now floors indices as well as lengths) and routes every *derived* index and length through it — literal operands still fold at compile time, so `.substring(2, 7)` stays `{ $substrCP: ["$name", 2, 5] }`. Per-method negative semantics are kept distinct, because SR2 means they really do differ: `.slice`/`.substr` count from the end, `.substring` clamps to 0, and `.charAt` returns `""` — the one index that must **not** be floored, since flooring would wrongly return the *first* character. `.endsWith()` additionally binds its receiver in a `$let`, so a chained receiver like `$.email.trim().toLowerCase()` is evaluated once instead of twice; for a plain field path the output is the same size, and for a chain it shrinks. Verified against a live `mongod` by diffing 17 method/argument shapes against real `String.prototype` results across `"hello"` / `"ab"` / `""` receivers — all 17 now agree, where several previously aborted.

This supersedes the closing claim of the 2026-07-27 value-mode `.slice` entry below, that *"string `.slice` (`$substrCP`) was already correct"*. It was not: `"".slice(1)` produced a negative **length** and `"abc".slice(-5)` a negative **start**. The 2026-07-27 `.pop()`/`.shift()` entry is the closest precedent — same shape of bug (an unclamped count reaching a server that rejects it at runtime), same reason it stayed hidden: a green `toEqual` proves only what jsmql *emits*. Here the masking was doubled, because `const-eval.ts` folds a literal receiver through real JS, so `"ab".endsWith("abcd")` correctly folded to `false` and only a *runtime* receiver ever reached the broken MQL.

## 2026-08-02 — feat: chained stage calls on a `$out` write chain

The fifth and last container. `$$$.archive = $$.$sort({ a: 1 })` was rejected
with "isn't a recognised chain method for a '$out' RHS", which was accurate but
arbitrary once every other container took stage links.

A `$out` chain runs at the OUTER pipeline level, so a stage link there is just a
top-level stage sitting before the write. `lowerChainMethod` already receives the
`SubPipelineLowerer`, so lowering is one line: run the link's one-statement block
(`stageLinkBlock`, factored out of `stageLinkBlockLambda`) through it. No new
plumbing, and the result is the statement lowering by construction:

```js
$$$.archive = $$.$match({ s: "x" }).$sort({ a: -1 });
// → [{ $match: { s: "x" } }, { $sort: { a: -1 } }, { $out: "archive" }]
//   identical to: $match({ s: "x" }); $sort({ a: -1 }); $$$.archive = $$;
```

Placement is checked with `isLastInContainer: false`, since the `$out` always
follows. That is what rejects a second write stage:

```js
$$$.archive = $$.$out("other");
// ✗ '$out' must be the last stage in a pipeline.
$$$.archive = $$.$match({ s: "x" }).$documents([{ x: 1 }]);
// ✗ '$documents' must be the first stage in a pipeline.
```

This reverses the "deliberately not a container" note added to
`docs/specs/out-stage.md` earlier the same day. It was written to describe the
behaviour as it stood, not to argue for it.

---

## 2026-08-02 — chore: drop the dead `replacesPreviousStage` hook and its stale references

Removing the "from the end" stream family left `replacesPreviousStage` set by
nobody and read by four call sites, plus a scatter of comments and specs
describing `.toReversed()` as a live stream method. `docs/specs/stream-methods.md`
had already noticed ("`replacesPreviousStage` has no users at all") without the
code following.

The field and its four pop sites are gone. `prevStages` stays, and is now
read-only in fact as well as in name: a method may read an earlier stage, never
rewrite or drop one. `.takeWhile`/`.dropWhile` are the only readers, and the
comments that used `.toReversed()` to illustrate cross-statement composition now
use them, because the property still holds:

```js
$$.toSorted({a:1}).takeWhile(d => d.a < 5);      // ≡
$$.toSorted({a:1}); $$.takeWhile(d => d.a < 5);
```

Also corrected: `docs/specs/out-stage.md` listed `.toReversed` as a supported
`$out` RHS chain method (it is rejected), and my own
`docs/specs/aggregation-stages.md` credited `correlatedQueryMatchAsPredicate`
with the plain-equality `$match` case, which `detectLookupCall` now claims first
and routes to the indexed basic form. `src/CLAUDE.md` said "three containers" and
named the wrong path for one of them.

---

## 2026-08-02 — feat: `$facet` branches accept any `$$` chain, not only `.filter(<arrow>)`

Stage links shipped into three containers and missed the fourth. A facet branch
took `$$.filter(o => …)` and nothing else, so `$$.$match({ a: 1 })` — the same
thing, differently spelled — fell through to value-mode codegen and produced a
misleading "its receiver here is a value, not a stream".

`detectFacetShape` now classifies each branch as either the dedicated
`.filter(<arrow>)` predicate (which keeps its facet-specific `$.<field>`
rejection) or an ordinary `$$` chain, lowered by `applyStreamMethods` against
`freshFacetCtx` and a `"facet"` validator. So a branch takes the whole
vocabulary, placement rules included:

```js
$ = { hi: $$.$match({ s: "a" }).$limit(2), lo: $$.filter(d => d.n < 5) };
// → [{ $facet: { hi: [{ $match: { s: "a" } }, { $limit: 2 }],
//                lo: [{ $match: { n: { $lt: 5 } } }] } }]

$ = { k: $$.$out("x") };
// ✗ '$out' is not allowed inside a '$facet' sub-pipeline.
```

A plain object RHS still lowers to `$replaceWith`; the mixed-shape error wording
widened from "every value must be `$$.filter(<predicate>)`" to "every value must
be a `$$` chain".

---

## 2026-08-02 — fix: an error never recommends syntax that doesn't work where you are

```
$ = { k: $$.push({a:1}) };
// before: '.push(...)' is not a chainable stream method on '$$'. Did you mean '.push'?
//         … ('.push(...)' appends documents as a statement → $unionWith.)
```

Two separate faults in one line. `closestNameTo` could return the very name it
was given, because a candidate set may legitimately contain a name that is valid
in a *different* position. It now skips an exact match, which fixes every
`didYouMean` call site at once. Second, `.push` was in the chain-error candidate
set at all, so a near-miss like `.pop` was answered with `.push` — also not a
chain method. The set now holds chain methods only, and `.pop` suggests `.drop`.

`.push` gets its own message naming the spelling that actually works mid-chain:

```js
$$ = $$.concat({ a: 1 });   // → [{ $unionWith: { pipeline: [{ $documents: [{ a: 1 }] }] } }]
```

The trailing append note is now position-aware. A `$facet` branch has no
statement position, so offering `$$.push(...)` there was a dead end:

```
$$ = $$.push({a:1});         → … ('$$.push(...)' does work as a top-level statement of its own.)
$ = { k: $$.push({a:1}) };   → … (the statement form isn't available inside a 'facet' sub-pipeline.)
```

`unknownStreamMethod` takes the container to do that, threaded from
`applyStreamMethods`.

---

## 2026-08-02 — fix: errors name the `$$$.<coll>` head, never the methods that may follow it

Nine error messages still spelled the lookup surface `'$$$.<coll>.find/filter(...)'`
or `'$$$.<coll>.find/filter/aggregate(...)'` — an inventory that went stale the day
[any lodash stream method could head the chain](specs/lookup-stage.md), and again
when stage links (`.$match(...)`) joined it. The enumeration is now one exported
constant, `LOOKUP_SYNTAX` in [src/codegen.ts](../src/codegen.ts), spelled
`'$$$.<coll>.<method>(...)'`: it names the **head**, which is what actually makes a
chain a lookup, and says nothing about the open set that follows. When the method
itself is the problem, the unknown-method throw in
[lookup-translation.ts](../src/lookup-translation.ts) still names the categories and
offers a `didYouMean` — that message is the one place the categories belong.

**The same staleness had leaked one layer down, into detection.** `containsLookupCall`
— which backs every mode gate in [index.ts](../src/index.ts) — asked
`detectLookupCall`, i.e. "is the head `.find`/`.filter`/`.aggregate`?", so a
stream-method head was invisible to all four gates. `jsmql.expr("$.x = $$$.c.toSorted({a:1}).take(5)")`
**returned a three-stage `$lookup` pipeline** instead of rejecting; `jsmql.filter()`
and `jsmql.update()` fell back to generic shape errors; and without a trailing `;`
the `$$ =` form reached `jsmql internal error (please report …)`. It now asks the
receiver instead — any `MethodCall` that `extractLookupTarget`s to `$$$.<coll>` /
`$$$$.<db>.<coll>` is lookup syntax. The collection hop that helper requires is also
what keeps the bare-receiver diagnostics (`$$$$.currentOp(…)`) out. Both no-`;`
forms now lower byte-identically to their `;` counterparts.

**One message was not merely stale but wrong.** `.map()`/`.find()` rejecting a
statement block claimed "that form is only for `'$$$.<coll>.find/filter(...)'`" —
while the user was *looking at* a `$$$.<coll>.map(…)`, which does take one. The real
cause is the **position**: a scalar `return` (or a chained `.find`) collapses the
chain into a value, so it lowers to an array operator with nowhere to run stages.
The message says that now, and names the two rewrites that work — `return` a
document, or move the stages into a heading `.filter`/`.aggregate` block — both
asserted as compiling in [test/lookup.test.ts](../test/lookup.test.ts). The four
remaining statement-block rejections (`$let`, IIFE / reusable function,
`Object.groupBy`, `Array.from` — all unreachable-by-parser, defensive) share one
`STREAM_BLOCK_FORM` constant with a single open-ended example.

---

## 2026-08-01 — docs: record the from-the-end removal in §B; fix a duplicate DEF id

Three DEFERRED.md changes, at the developer's request plus one defect found while
making them.

**§B row for the removal.** The from-the-end stream methods (entry below) now have a
won't-implement entry with the full rationale, so the decision isn't re-litigated from
the DEVLOG alone. It states the boundary that matters: rejected on a *stream*, still
shipping on an *array value* — the distinction is the receiver, not the method.

**`DEF-035` (was the second `DEF-034`) — the `_id` fallback is out.** Its success
criterion read "both reject (or default to `_id`) when no order is defined". That
silent substitution is precisely what got the from-the-end family removed, so it now
says a defined order is a **precondition, not a default**: with no preceding
`.sort(...)`, `.takeWhile`/`.dropWhile` must reject and name the sort to add. The
target-lowering line said the same thing and was corrected too.

**The duplicate id.** Two unrelated items both carried `DEF-034` — the `.aggregate()`
union source and stream `.takeWhile`/`.dropWhile` — and `[DEF-034]` tags in
`src/union-translation.ts` and `src/pipeline.ts` pointed at different rows under the
same number. The drift test could not see it: `parseDeferred` collects rows into a
`Map`, so the second row silently overwrote the first and both the forward and reverse
gates still found a match. `.takeWhile`/`.dropWhile` (the fewer tag sites) moved to
`DEF-035`, and a new **UNIQUE-ID gate** collects ids in file order *with* duplicates
and fails on any repeat — verified by reintroducing the collision and watching it fail.

---

## 2026-08-01 — feat: `.sortBy`/`.orderBy` accept a computed key; chain cleanup is held to the end

`$$.sortBy(d => d.category.toLowerCase())` now lowers. `$sort` needs a literal field
path, so unlike a `$group._id` key the expression can't go inline: `SortKeySink`
allocates a `__jsmql.tmp` slot, one `$addFields` computes it ahead of the `$sort`, and
the slot is cleared once the chain ends. A plain `"cat"` key is untouched — still the
single `$sort` it always was.

The blocker recorded in the entry below turned out to be **both worse and easier than
described**. Worse: it was never specific to `.toReversed()`. `.takeRight`/`.dropRight`/
`.initial` read `prevStages[last]` for the live `$sort` too, and `reverseSortTrick`
*silently* falls back to ordering by `_id` when it doesn't find one instead of
erroring. So the bug already existed on master without any computed keys —
`$$.shuffle().takeRight(3)` returned the last 3 by `_id` and threw the shuffle away.
Easier: it needed no change to `replacesPreviousStage` at all. The scratch `$unset`
simply moves to the END of the chain (`StreamMethodResult.cleanupStages`, appended
once by both `applyStreamMethods` and `peelForeignChain`), so the `$sort` stays the
last stage and every downstream method still sees it. `.shuffle` moves onto the same
mechanism, which fixes that pre-existing bug.

Cleanup is emitted only inside a `$lookup.pipeline` — there the sub-pipeline's
documents land in an array field the outer `{ $unset: "__jsmql" }` can't reach, while
at the top level and inside a `$unionWith.pipeline` that sweep already covers them, so
a second `$unset` was pure noise (top-level `.shuffle()` drops from four stages to
three). And when it is emitted it now unsets the **namespace root**: `$unset` of a
dotted path removes only the leaf, so `$unset: "__jsmql.tmp.1"` had been leaving
`__jsmql: { tmp: {} }` on every foreign document. That was live on master too — the
mongod probe caught it; no `toEqual` would have.

`.flatMap` deliberately still takes a path only, and that is semantic rather than
mechanical: `$unwind` returns each element to a **named** field, so the field name is
part of what the user means and jsmql can't invent one. Its message now says so
instead of the old "v1 only supports…" wording (which also violated the project's
no-version-markers rule; the two other `v1` markers in the docs went with it).

This supersedes the "not done here" note in
[feat: `$group`-keyed stream methods accept a computed key](#2026-08-01--feat-group-keyed-stream-methods-accept-a-computed-key).
`.toReversed()` did **not** need to be dropped to get here — it composes with a
computed sort key and is verified doing so against a live mongod, along with
`.takeRight` reversing the computed ordering rather than `_id`.

---

## 2026-08-01 — feat: `$group`-keyed stream methods accept a computed key

`.countBy(d => d.cat.toLowerCase())`, `.groupBy(d => d.email.split("@")[1])`,
`.keyBy({ active: true })`, `.uniqBy(d => d.a + d.b)` — the four grouping methods
now take any iteratee, not just a field key. This was the capability gap left over
from the spelling work below, which had lumped all six keyed methods under one
"a stream key must be a plan-time field path" rule. That rule was too broad:
**`$group._id` is an expression slot the server evaluates per document**, so a
computed key lowers straight into it with **zero extra stages**.

The line is the SLOT, not the method. `keyExpr` resolves a key argument to the MQL
expression it evaluates to, keeping a `fieldKeyArg` fast path first so a plain
`"cat"` still emits the byte-identical `"$cat"` it always did; only when that
declines does it desugar the iteratee, rewrite the lambda param to the document
root (`extractLetsFromExpr`), and generate. A `$sort` key and an `$unwind` path
really are literal field paths, so those keep rejecting — but the message now says
the group-keyed methods accept one, so nobody reads it as "jsmql can't do computed
keys".

Auto-materialising a computed value into a temp field for the other two was
considered and rejected, for different reasons each. For `.flatMap` it would be
wrong: `$unwind` puts each element back into a *named* field, so the field name is
part of what the user means, not an implementation detail — which is why the manual
route is the answer rather than a workaround. For `.sortBy`/`.orderBy` it is merely
blocked: the temp needs an explicit `$unset` (a `$lookup.pipeline` gets no trailing
`{ $unset: "__jsmql" }` to sweep it), that `$unset` lands after the `$sort`, and
`reverseSortTrick` only inspects the immediately preceding stage — so
`.sortBy(<computed>).toReversed()` would break. Lifting it means extending
`StreamMethodResult.replacesPreviousStage` to pop N stages; not done here.

Two traps re-opened by the feature and closed with it. `isCollapsingTerminal` asked
`fieldKeyArg` whether `.groupBy`'s argument was a key — true when that was the whole
key surface, wrong the moment computed keys existed, silently skipping the `$first`
unwrap for `.groupBy(d => d.cat.toLowerCase())` and returning the raw `[obj]` slot.
That is the *second* time this predicate fell behind the key surface (it keyed on
`StringLiteral` before), so it now tests the key FORM — anything but the `$group`
body — which can't go stale again. And because the group methods reuse `.map`'s body
and param helpers, their errors talked about `.map`; `mapBodyExpr` / `rejectLocalDocRef`
now take the calling method's name, the same wrong-method-in-the-message bug as
`.keyBy` citing `.countBy("status")`.

Verified against a live mongod: each computed-key form runs and returns what the
hand-materialised `$.k = <expr>; …("k")` equivalent returns.

---

## 2026-08-01 — feat: a lone `.$match(<plain equality map>)` lookup head takes the `.filter` path

Merge resolution between the chained-stage-call work and this branch's predicate
normalisation. Both had landed a piece of the same invariant and they disagreed:

```js
$.t = $$$.orders.filter({ userId: $._id });   // → indexed basic form, 1 stage
$.t = $$$.orders.$match({ userId: $._id });   // → correlated $lookup.pipeline, 3 stages
```

Same predicate, same meaning, two plans — and the chained-stage-call suite already
asserted the two must be equal, so the merge went red exactly where it should have.
`.$match` is the STAGE spelling of the same filter, so `detectLookupCall` now
normalises it to `filter` and it takes the identical path — indexed basic form
included:

```js
$.t = $$$.orders.$match({ userId: $._id });
// → [ { $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "t" } } ]
```

**Only a plain equality map converts.** A query document carrying operators means
something a lodash matcher cannot, so `isPlainEqualityMap` refuses it and the
sub-pipeline path stands:

```js
$.t = $$$.orders.$match({ qty: { $gt: 5 } });     // query: greater than 5
// → [ { $lookup: { from: "orders", pipeline: [{ $match: { qty: { $gt: 5 } } }], … } }, … ]
$.t = $$$.orders.filter({ qty: { $gt: 5 } });     // matcher: EQUALS the object { $gt: 5 }
// → [ { $lookup: { from: "orders", pipeline: [{ $match: { $expr: { $eq: ["$qty", { $gt: 5 }] } } }], as: "t" } } ]
```

Scope is the **lone head** only. A `.$match(...)` with anything chained after it is
byte-identical to before — checked across seven shapes — because the chain assembler
keeps peeling stage links through `lowerCallbackBlock`. Verified on a live mongod:
correlated, plain, operator-bearing, mixed, and chained forms all return the same
documents as their `.filter` twin where a twin exists.
## 2026-08-01 — docs: `$` is the ROOT document at every depth (HR4 wording)

HR4 said "`$` = the current document", which reads as "whichever document is
nearest" and is wrong inside a sub-pipeline. `$.x` is a **root**-document read
at any depth — jsmql threads it in through `$lookup.let` — while the
sub-pipeline's own document is the callback parameter or a raw `"$x"` MQL path
string. The consequence is sharp enough to deserve the example now in
[docs/LANG_RULES.md](LANG_RULES.md) and [docs/LANGUAGE.md](LANGUAGE.md):
`$$$.orders.$set({ owner: $.tag })` and `$$$.orders.$set({ owner: "$tag" })`
differ by one character and read two different documents.

Also: the §B row rejecting a second spelling on "which one does my codebase
use?" grounds is gone, and the chained-stage docs now show the lodash and
`$stage` spellings side by side without naming a winner. Two spellings of the
same lowering are fine; what jsmql avoids is the *same* input producing
different output.

---

## 2026-08-01 — feat: pipeline stages as chain links (`<stream>.$match(...)`)

A stage can now be written as a dot-chain link on a stream —
`$$.$match({…}).$sort({…}).$limit(5)`, `$$$.orders.$match({…}).$group({…})` — not
only as a `$match(…);` statement. The motivation is a hole in the surface: stage
calls worked at statement position and the lodash chain methods worked in *both*,
so the one thing you couldn't do was reach a stage from a chain. That bit hardest
in a **value** position (`const x = $$$.<coll>.…`), where you can't drop into
statements at all, and where the stages with no JavaScript spelling (`$group`,
`$unwind`, `$setWindowFields`, `$bucket`, …) were reachable only by nesting an
`.aggregate((o) => { … })` block.

The design goal was to add **no new lowering**. A stage link parses to an ordinary
`MethodCall` whose method starts with `$` (no new AST node — that's what lets
`collectStreamChain` and every existing chain walker keep working), and each of
the three containers delegates to the path that already lowers the equivalent
spelling: on `$$` and in a `$unionWith` source-switch it calls the statement
path's own `generateStageBody`; inside `$lookup.pipeline` it calls
`lowerCallbackBlock`, the engine `.aggregate((o) => { <stage>; })` uses. So the
two equivalences — `.$match(b)` ≡ `$match(b);` and, in a foreign chain,
`.$match(b)` ≡ `.aggregate(o => { $match(b); })` — hold by construction rather
than by parallel maintenance, and both are asserted as tests. Name resolution,
arity, and the sub-pipeline placement rules live in one new leaf module,
[src/stage-link.ts](../src/stage-link.ts), because `lookup-translation.ts` sits
below `pipeline.ts` in the dependency graph and can't import back. `.aggregate()`
stays: it still owns the multi-stage block (with a terminal `return`) and the raw
`[{ $stage: … }]` array paste that keeps HR1 round-tripping.

Two smaller things rode along because the feature made them reachable. Stage
links are validated against their container's `forbiddenIn` / `position` data, so
`.$out(…)` inside a `$lookup` chain is now rejected — partial progress on
DEF-024, which still leaves the `.aggregate` *block* body unchecked. And
`isCollectionMethodCall` in [src/index.ts](../src/index.ts) tested only one hop,
so any multi-link `$$` chain without a trailing `;` fell into the generic
"'`$$`' is statement-only" wall of text; it now tests the whole chain root, and
the same clause was added to `lowerToPipelineStages` (the `jsmql.pipeline()`
entry), which had been missing it.

---

## 2026-08-01 — feat: playground Variables panel is a disclosure under the "MongoDB call" bar

The Variables editor no longer occupies the input panel permanently. It now
hangs off the "MongoDB call" bar as a collapsed panel, revealed by a labelled
chevron pinned to the right of that bar
([playground_skeleton.html](../playground_skeleton.html) — `.vars-toggle`,
`setVarsOpen` / `syncVarsDisclosure`). Variables are optional, so the default
view puts the call site directly above the query and gives the editor its
vertical space back; the chevron is what asks for them. To keep the control
pinned while the call site can still be long, the bar itself stopped scrolling —
its label+code moved into an inner `.usage-main` that owns the `overflow-x`.

Open/closed is **derived from the content, not persisted**: on every restore
path (page refresh, and a `#s=` share link, which can carry someone else's
variables) `syncVarsDisclosure()` opens the panel when the box actually holds
bindings or fails to parse. Both cases change the MQL output and the call-site
hint, so hiding their cause would leave the user with a `.compile(...)({ age })`
call site and nothing visible that explains it. Nothing about the panel state
goes into localStorage or the share payload, so the panel can never disagree
with the session it is showing.

The box also stops starting empty: it now opens on a commented-out template
(`runTimeVar1` plus an `ObjectId("507f…")` line). It parses to `{}` — no
bindings, so behaviour is identical to the old empty box — while naming the two
shapes people reach for first, the second of which isn't guessable because JSON
can't express it.

---

## 2026-08-01 — feat: stream `.takeWhile(pred)` / `.dropWhile(pred)` (closes DEF-035)

```js
$$.toSorted({ t: 1 }).takeWhile(o => o.ok);
// → [ { $sort: { t: 1 } },
//     { $setWindowFields: { sortBy: { t: 1 },
//         output: { "__jsmql.tmp.1": { $max: { $cond: ["$ok", 0, 1] },
//                   window: { documents: ["unbounded", "current"] } } } } },
//     { $match: { "__jsmql.tmp.1": 0 } },
//     { $unset: "__jsmql" } ]

$$.toSorted({ t: 1 }).dropWhile(o => o.ok);
// → identical, but  { $match: { "__jsmql.tmp.1": 1 } }
```

One `$setWindowFields` carries a running `$max` of "has the predicate failed at or
before this document?", and the two methods differ **only** in the `$match`
polarity — so they are exact complements by construction, not by two parallel
implementations. On `t: 1 ok, 2 ok, 3 FAIL, 4 ok` a live mongod returns `[1,2]` and
`[3,4]`. That data matters: it is the case where the previously-suggested workaround
`.sort() + .filter()` gives `[1,2,4]`, because `.filter` keeps every match while
`.takeWhile` stops at the first failure.

**The order comes from the preceding sort, and any spelling counts** (developer
decision). `$setWindowFields` *requires* `sortBy` for a document window — the server
rejects it otherwise with "Document-based bounds require a sortBy" — so the spec is
lifted from the last `$sort` the chain emitted. Every sort spelling ends in one, so
all five work uniformly, including a computed `.sortBy(d => …)` whose key is a
`__jsmql.tmp` scratch field:

```js
$$.sort({ t: 1 }).takeWhile(p)                    // sortBy { t: 1 }
$$.toSorted({ t: 1 }).takeWhile(p)                // sortBy { t: 1 }
$$.sortBy("t").takeWhile(p)                       // sortBy { t: 1 }
$$.orderBy("t", -1).takeWhile(p)                  // sortBy { t: -1 }
$$.$sort({ t: 1 }).takeWhile(p)                   // sortBy { t: 1 }   (the chain-link stage)
$$.sortBy(d => d.cat.toLowerCase()).takeWhile(p)  // sortBy { "__jsmql.tmp.1": 1 }
```

With **no** sort it rejects and names the fix. It does not fall back to `_id`:
silently substituting an order nobody asked for is exactly what got the "from the
end" family removed two entries below, and `DEF-035` had already been amended to
forbid it.

These are the only registered methods that read `prevStages`, and they show the safe
shape of that dependency — they **read** the sort spec (never rewrite it) and
**reject** when it is absent (never guess). The removed family did the opposite on
both counts. `replacesPreviousStage` now has no users at all.

The predicate takes the same spellings `.filter` does — arrow, matches-object, field
name, `["field", value]` — all asserted byte-identical to the arrow. `DEF-035` is
deleted from `docs/DEFERRED.md`; the generator's own guard caught the missing
`STREAM_METHOD_SIGNATURES` entries before the tests did.

---

## 2026-08-01 — feat!: the "from the end" array methods are removed from the stream surface

`.takeRight(n)`, `.dropRight(n)`, `.initial()` and `.toReversed()` no longer exist as
stream methods, and `reverseSortTrick` is gone with them. **Developer decision**, on
the grounds that MongoDB has no stage that reverses a stream — `$reverseArray` is an
*expression*, for an array inside a document — and a stream has no order except the
one a `$sort` gives it, so "the last n" has nothing to count back from.

The implementation was the argument against it. These four worked by reaching back and
rewriting the *preceding* `$sort`, which made them position-dependent in a way the JS
methods they are named after never are, and — with no `$sort` in front — silently
ordered by `_id` rather than erroring. `.toSorted(c).toReversed()` was also a longer
spelling of writing the comparator descending, i.e. a second spelling for a capability
that already had one. All four remain in **value position** on a real array
(`$.items.takeRight(3)` → `$slice`, `$.items.toReversed()` → `$reverseArray`), where
the array carries its own order and they mean exactly what JS means.

`fromTheEndRejection` (`src/stream-methods.ts`) owns the message and is wired into all
three places a stream chain is assembled: `unknownStreamMethod` (bare `$$` / `$$ =`),
`validateLookupShape` (a `$$$.<coll>` chain head), and the peel loop in
`tryExtractChainedLookup`. That third site is the one worth calling out — without it a
foreign chain would quietly fall through to value-mode and slice the tail of the
materialised array, whose order is whatever the foreign scan produced. Same
unanswerable question, answered silently; the rejection is the point. The message names
the rewrite: `.toSorted({ <field>: -1 }).take(n)`.

Two things survive the removal. The chain-cleanup ordering rule from the entry below
stays (a method's stages should end with the stage that describes the stream, not its
own housekeeping) — it is general, and the bug that motivated it happened to involve
`.takeRight`. And `prevStages` / `replacesPreviousStage` stay on the
`StreamMethodResult` contract but now have **no users**, deliberately: reaching back at
the preceding stage is the coupling that made these four fragile, so a future method
should reach for it only when nothing else expresses the operation, and error rather
than guess when the expected stage isn't there.

`DEF-034` (stream `.takeWhile`/`.dropWhile`) is unaffected in principle — those run
from the FRONT of an order a preceding `.sort(...)` establishes — but its
"or default to `_id`" success criterion is now explicitly disallowed for the same
reason, and the row says so.

---

## 2026-08-01 — fix: `$out` / `$merge` rejected in every sub-pipeline, block bodies included

HR3 says jsmql never knowingly emits invalid MQL, and mongod rejects a write
stage anywhere but the last position of a top-level pipeline (Location51047).
Four spellings still slipped one through — a foreign `.aggregate((o) => { … })`
block, a `.filter` predicate block-body, and a `$facet` branch block-body all
emitted `{ $out: … }` straight into a sub-pipeline.

The blocker recorded in DEF-024 was that `lowerBlock` has no unambiguous
container to validate against. That is true, but it doesn't apply to *these*
stages: `$out` and `$merge` are the only ones the registry forbids in **all
three** containers, so they are decidable without a container label. A stage
matching `stageForbiddenInAnySubPipeline` is now rejected on a single
`GenerateCtx.inSubPipeline` flag, stamped by both `freshSubPipelineCtx` and
`freshFacetCtx`. Membership is read from `forbiddenIn`, so a future
all-container stage is covered with no code change. Where the container *is*
known the named message still wins — it runs first, in the loop validator.
DEF-024 narrows to what actually remains: imprecise wording for the
single-container diagnostics inside a block body.

---

## 2026-08-01 — fix: a bare `$$$.<coll>.<chain>;` statement names its missing destination

`$$$.orders.$match({ a: 1 });` reported "Element 0 of pipeline is not a
recognised stage" plus the full 45-stage list — technically true, useless in
practice. Reading another collection produces a *value*, so the statement needs
a destination; the error now says which three exist (`$.<field> = …`,
`const <name> = …`, `$$ = …`) and notes the contrast the user is most likely
tripping over: a bare `$$.<chain>;` needs no destination because it transforms
the current stream in place. A value-collapsing terminal (`$$$.orders.head();`)
keeps its own more specific message, which names the method.

---

## 2026-08-01 — fix: a shorthand `.filter(...)` lookup predicate lowers identically to its arrow

`$$$.orders.filter({ userId: $._id })` and `$$$.orders.filter(o => o.userId === $._id)`
mean the same thing, but until now they compiled to different — and unequally
performant — MQL. The arrow got the **basic-form** `$lookup`
(`localField`/`foreignField`, which the server can serve from an index); the
shorthand got the correlated **pipeline form**. Chain `.length` onto each and the
gap widened: the arrow materialised a clean `{ $set: { slot: { $size: … } } }`,
while the shorthand fell all the way through to the generic value-mode
`.length`, emitting an `$isArray`-guarded `$strLenCP` fallback for a value that is
always an array. Even the Filter-mode gate diverged — the shorthand missed the
actionable "requires Pipeline mode" error and got the generic "bare `$$$`
reference" one. Same meaning, three different outputs, strictly worse plan.

All three traced to one line in `detectLookupCall`
([src/lookup-translation.ts](../src/lookup-translation.ts)), which accepted only
`arg.type === "Lambda"` and returned `null` for everything else. A shorthand
therefore wasn't a *detected lookup* at all: it fell through to the chain
assembler, whose `.filter` handling always builds the pipeline form, and the
`.length` / mode-gate paths (which both ask `detectLookupCall`) simply never saw
it. The fix normalises the shorthand to its equivalent arrow **at detection**, via
a new `filterArgToLambda` that mirrors the `aggregateArgToLambda` already sitting
beside it — so `.filter(<shorthand>)` *is* `.filter(<arrow>)` from the first
moment the compiler names it, and every downstream consumer inherits the identical
treatment for free rather than each needing its own shorthand branch. Detection
stays side-effect-free: a malformed shorthand returns `null` (not a throw), leaving
`validateLookupShape` the owner of the targeted message.

Normalising at *detection* rather than teaching the chain assembler about basic
form was the deliberate choice — the alternative would have left a second place
that decides basic-vs-pipeline, i.e. the same divergence class one refactor later.
Two spot-effects worth noting: a lone `$$$.coll.filter({…})` now writes straight to
its destination `as` (no tmp slot, no trailing `$set`/`$unset`), and an
uncorrelated shorthand chain now carries the arrow's `let: {}` — see the follow-up
entry on dropping the empty `let`. Guards live in
[test/lookup.test.ts](../test/lookup.test.ts) (both shorthand spellings asserted
equal to the arrow's MQL, plus the mode-gate and malformed-shorthand cases); all
eight shapes were run against a live mongod and the paired forms return identical
documents.

---

## 2026-08-01 — fix: an uncorrelated `$lookup` never emits an empty `let: {}`

Closes the empty-`let` wart flagged as "tracked separately" in
[test: showcase chains rewritten in the shorter lodash spellings](#2026-08-01--test-showcase-chains-rewritten-in-the-shorter-lodash-spellings).
`$lookup.let` is optional to the server, so emitting `let: {}` when the predicate
correlated nothing is pure noise — the leaner `{ from, pipeline, as }` says the
same thing. jsmql already knew this: `lowerLookup` dropped the empty `let`, but
only for `.aggregate`, and `tryExtractChainedLookup` dropped it only when the
chain had no `.filter` head. So the rule was re-decided at each of the five
emission sites, and `$$$.orders.take(2)` disagreed with
`$$$.orders.filter(p).take(2)` about `let: {}` for no semantic reason.

All five sites now route through one exported `pipelineLookupBody(from, letVars,
pipeline, as)` in [src/lookup-translation.ts](../src/lookup-translation.ts),
which omits `let` iff `letVars` is empty. The emitted shape is now a function of
the *predicate* alone, never of which code path assembled it — which is the same
invariant the sibling entry above establishes for predicate *spelling*, and the
reason both were worth fixing together: a `$lookup` shape that shifts with
anything other than what the query means is the bug, not the specific trigger.

This is why the preceding fix is a strict win rather than a trade: normalising
the shorthand at detection had, on its own, moved uncorrelated shorthand chains
*onto* the arrow's `let: {}` path. Rather than accept the noisier output for the
sake of agreement, both spellings now get the lean shape. Thirteen expectations
across four suites lost exactly one `"let": {}` line each and nothing else.

---

## 2026-08-01 — fix: chain errors caret at the offending call, not the chain root

`parsePostfix` stamped `pos: left.pos` on every `MethodCall` it built, so every
link of a chain shared the chain root's source offset. An error deep in a chain
therefore underlined the wrong thing:

```
$$.filter(p => p.a > 1).uniq().take(2);
^                                          ← before: the caret sat on `$$`
                        ^                  ← after:  it sits on `.uniq`
```

Each link now carries the offset of its own member token — a one-line change in
[src/parser.ts](../src/parser.ts). Two existing assertions moved and both moved
for the better: the incompatible-receiver error in a chain now points at
`.every(...)`, the call its own message names, instead of at the `$.items`
chain root.

One site needed the opposite treatment. The "lookup syntax requires Pipeline
mode" error is about the whole `$$$.<coll>.find(...)` construct, not about
whichever link is outermost, so it now resolves the `$$$` prefix's own offset
via a small `contextRefPos` walk in [src/index.ts](../src/index.ts) rather than
taking `ast.pos`. The general rule: an error about *a call* takes the call's
position; an error about *a construct* resolves the construct's head.

---

## 2026-08-01 — fix: correlate a query-form `$match` inside a foreign sub-pipeline

Found while verifying the chained-stage work against a live `mongod`, and it
turned out to predate it. Inside a `$$$.<coll>` sub-pipeline, `$.` means the
*outer* document and is hoisted into `$lookup.let` as a `$$jsmql_f0_<field>`
reference. That resolves in every aggregation-**expression** slot — `$set`,
`$group`, `$project` — but a `$match` whose body is an object literal is a
**query document**, and the query language does not evaluate `$$` variables.
MongoDB happily *accepts* `{ $match: { userId: "$$jsmql_f0__id" } }` and
silently matches **nothing**, so
`$$$.orders.aggregate((o) => { $match({ userId: $._id }); })` had been returning
empty arrays since it shipped — a green `toEqual` covered the emitted shape and
never caught it.

`correlatedQueryMatchAsPredicate` in [src/pipeline.ts](../src/pipeline.ts) now
re-expresses such a body as the equivalent predicate (`{ userId: $._id }` →
`$.userId === $._id`) and hands it to the same `translateMatchBody` path
`.filter(...)` uses, which splits it into an index-friendly query part plus a
`$expr` residual for the correlated terms. `$match({ … })` and `.filter({ … })`
now emit byte-identical sub-pipelines. Only entries that read the outer document
move into `$expr`; an uncorrelated query document keeps the verbatim path, so
raw MQL still round-trips (HR1).

The first attempt at this shipped as a *rejection* — throw and point the user at
`.filter(o => … === $._id)`. That was wrong twice over: it broke legitimate code
(`$.orders = $$$.orders.aggregate(o => { $match({ userId: $._id }); })`), and
turning a requested capability into a compile error is a product decision that
wasn't mine to make unilaterally. Translating is what the user wanted and is
strictly better — the correlated form works *and* keeps the uncorrelated terms
indexable. A correlated shape the translator can't express (an `$and`/`$or`
root, `$regex`, …) still errors, naming both the arrow-predicate and the
expression-body alternative, because emitting a match that returns nothing is
worse than saying so.

---

## 2026-08-01 — fix: stream callback spelling never changes the emitted MQL

Generalises the two entries below from `.filter` to the whole higher-order stream
surface. Value position accepts the lodash shorthands everywhere, so a spelling
that compiles against `$.arr` but errors against `$$$.<coll>` is a bug, not a
restriction. An acceptance matrix over {`.find` `.filter` `.reject` `.some`
`.every` `.map` `.flatMap` `.sortBy` `.orderBy` `.groupBy` `.countBy` `.keyBy`
`.uniqBy`} × {arrow, property string, matches-object, `["field", value]`} ×
{value, stream head, stream chain} turned up twenty divergent cells. They
collapsed into two equivalence classes, each now behind one resolver:

- **Field key** (`.sortBy` / `.orderBy` / `.groupBy` / `.countBy` / `.keyBy` /
  `.uniqBy` / `.flatMap`) — `"cat"` and `d => d.cat` name the same path, so
  `fieldKeyArg` resolves both. Only `.flatMap` accepted the arrow before.
- **Predicate** (`.find`, plus the `.map` iteratee) — `.find` demanded an arrow
  even though `.filter`, value position, and a chained `.find` all took the
  shorthands; `.map` took the property string but not the other two.

The sharpest find was `.groupBy(d => d.cat)`: once accepted, it emitted *valid but
different* MQL, because `isCollapsingTerminal` asked whether the argument was a
`StringLiteral` rather than whether it named a key — so the arrow spelling silently
skipped the `$first` unwrap and handed back the raw `[obj]` slot. That is the same
`StringLiteral`-as-proxy-for-meaning mistake as the `.find` rejection, and it is
why the guards assert pairs **byte-identical** rather than "both compile".

What a stream genuinely cannot take is a *computed* key — a `$sort` key /
`$group._id` is fixed at plan time. That limit stays, but now speaks with one
voice: the shared `computedKeyError` names the method it was called on and points
at `.map(d => ({ ...d, key: <expr> })).<method>("key")`. Previously `.keyBy` and
`.uniqBy` illustrated their own errors with `.countBy("status")`, sending the
reader to a different method's docs. Three methods keep the object spelling for a
*richer* meaning — `.orderBy({ field: dir })` and `.sort`/`.toSorted({ field: dir })`
are direction specs, `.groupBy({ _id, … })` is the `$group` body — so the matcher
is unavailable there by claim, not by accident.

Verified on a live mongod: every newly-accepted spelling runs and returns what its
established twin returns. Two pairs first looked like mismatches and were not —
`$group` fixes neither output key order nor which duplicate `$first` keeps, and the
emitted MQL for those pairs is byte-identical, so the difference was the server's,
not jsmql's.

---

## 2026-08-01 — test: showcase chains rewritten in the shorter lodash spellings

[test/realistic.test.ts](../test/realistic.test.ts) (and the README / LANGUAGE
copies of the same examples) now use the lodash-flavoured spellings wherever they
say the same thing in fewer characters — `.filter({ userId: $._id })` for the
single-`===` matches shorthand, `.toSorted({ placedAt: -1 })` for a comparator
arrow, `.take(n)` for `.slice(0, n)`, and `.takeRight(n)` for the array-only
`.slice(-n)`. The showcase file is what new users read first (README points at
it, and the playground extracts its examples), so the canonical spelling shown
there should be the shortest one that reads clearly — the four-line
`.filter(o => o.userId === $._id).toSorted((a, b) => a.placedAt - b.placedAt)
.toReversed().slice(0, 5)` chain became a two-line one that says exactly the same
thing to the compiler.

Every rewrite was checked against `node src/cli.ts` first: ten of them are
**byte-identical** to the MQL already asserted, and only two moved — `.takeRight(10)`
drops the `$isArray` string-or-array `$cond` that `.slice(-10)` needs on an
unknown-type receiver (lodash `takeRight` is array-only, so it emits a bare
`$slice`), and the matches-object head of the flagship example omits the dead
`let: {}` the arrow form emits on an uncorrelated `$lookup` (that empty-`let`
emission is an arrow-path wart against what
[docs/LANGUAGE.md](LANGUAGE.md#stream-methods) already documents, tracked
separately). All the changed shapes were run against a live mongod, not just
`toEqual`-diffed (HR3).

Three sites deliberately keep the longer form. The comparator arrow + two-arg
`.slice(25, 50)` pagination case stays as the single home of both features (with
a comment saying so, since a mid-stream offset has no lodash spelling), the
`$.recentOrders = $$$.orders.filter(o => { … })` block body stays because the
chain form is *worse* there (it materialises into `__jsmql.tmp.1` + `$set`
instead of writing straight into `as: "recentOrders"`), and every `.length`
after a correlated filter keeps its arrow — the matches-object form loses the
basic-form indexable `$lookup` and the known-array `$size`. Those last two are
DX gaps in the compiler, not in the tests.

---

## 2026-07-27 — feat: fold array `.slice` in `const`/`let` (lowering is now JS-faithful)

Re-adds array `.slice` to compile-time constant folding. It was deliberately
skipped when folding shipped because the value-mode `.slice` **lowering**
disagreed with `Array.prototype.slice` — it passed the JS args straight into
`$slice` (position+count), so `.slice(1)` meant "first 1" and `.slice(1,3)` meant
"3 from index 1". That lowering is now fixed (the `sliceArray` rewrite merged
from `claude/inspiring-shaw-ac8dcc`: ECMAScript start/exclusive-end, negatives
from the end, and a fold-friendly `max(count,1)` so a constant receiver never
hits a rejected 0-count `$slice`), so the reason to skip is gone. `.slice` now
folds via the real `Array.prototype.slice` in `foldArrayMethod`
([src/const-eval.ts](../src/const-eval.ts)) — exactly like the other native
array methods — but ONLY when the receiver AND every arg are compile-time
constants; a runtime index (`arr.slice($.n)`) still falls through to the
lowering. The fold-consistency battery gained the full `.slice` matrix (1-arg
pos/neg/0/out-of-range, 2-arg both-non-negative/end≤start/negative-end/
both-negative, over empty/short/normal arrays) — the folded literal, the
un-folded lowering, and real JS all agree on mongod (HR3).

## 2026-07-27 — feat: fold lodash set-ops, zip family, and object methods in `const`/`let`

Completes the lodash array/object/number folding surface. Set operations
(`xor`/`xorBy`, `differenceBy`/`intersectionBy`, `unionBy`) use BSON deep
equality on the (iteratee) keys; the zip family (`zip`/`zipWith`/`unzip`/
`zipObject`, plus `fromPairs`) mirrors the "run to the longest, pad short with
null" and `$toString`-key lowerings; the object family (`mapKeys`/`pickBy`/
`omitBy`, joining the earlier `mapValues`/`pick`/`omit`/`invert`/`toPairs`/`size`)
iterates entries with a `(value, key)` iteratee. Object receivers dispatch
through `foldObjectMethod`. With this, the full lodash value vocabulary that has
a clean MQL lowering folds at compile time; anything the mongod consistency gate
can't prove equal stays a runtime binding. The suite now spans 744 cases across
string/number/array/object batteries — all agree with the server.

## 2026-07-27 — feat: fold lodash iteratee/collection array methods in `const`/`let`

Extends constant folding to the iteratee-taking lodash array methods:
`sumBy`/`meanBy`/`minBy`/`maxBy`, `uniqBy`/`sortedUniqBy`, `keyBy`, `groupBy`/
`countBy`, `partition`/`reject`, `takeWhile`/`dropWhile`/`takeRightWhile`/
`dropRightWhile`, and `sortBy`/`orderBy`. The iteratee/predicate arg is resolved
to a JS function by `resolveIterateeFn` in const-eval.ts, which interprets an
arrow directly and desugars a lodash **shorthand** (`"a.b"` / `{ k: v }` /
`["a.b", v]`) via jsmql's own `shorthandToLambda` before interpreting — so a fold
lowers the shorthand exactly as the runtime would. `keyBy`/`groupBy`/`countBy`
stringify keys with `$toString` semantics (`mqlKeyString`); `minBy`/`maxBy`
mirror the stable-sort-then-take-first/last lowering; `sortBy`/`orderBy` use a
scalar BSON-order comparator (`foldSort`) and withhold non-scalar/mixed/null sort
keys (BSON type ordering isn't replicated) → runtime. Validated by the
fold-consistency suite across scalar and object-array batteries (675 cases,
arrows and shorthands) — all agree with mongod.

## 2026-07-27 — feat: fold lodash number + non-iteratee array methods in `const`/`let`

Extends constant folding to the lodash number methods (`clamp`, `inRange`,
`round`, `ceil`, `floor`) and the non-iteratee array family (`sum`, `mean`,
`min`, `max`, `uniq`/`sortedUniq`, `compact`, `flatten`, `chunk`, `take`/`drop`/
`takeRight`/`dropRight`, `tail`/`initial`, `head`/`first`/`last`, `nth`, `size`,
`without`). New JS impls in [src/lodash-fold.ts](../src/lodash-fold.ts) mirror
each method's MQL lowering exactly, not real lodash — `round` is half-to-even
(banker's, matching `$round`); `compact` uses MQL truthiness (drops
`false`/`null`/`0`, keeps `""`/`NaN`); `sum`/`mean` operate on numeric elements
with `$avg`'s empty→null; `uniq`/`without` use BSON deep equality (`bsonEqual`,
matching `$in`). `const`/`let` receivers of number and object type now dispatch
to new `foldNumberMethod`/`foldObjectMethod` in const-eval.ts (object folding so
far: `size`, `toPairs`, `invert`, `pick`, `omit`, `mapValues`). Edge cases that
would disagree withhold the fold → runtime: `min`/`max` over mixed-type arrays
(BSON ordering), `head`/`last`/`nth` out of range (server MISSING). The
fold-consistency suite gained number + array-lodash batteries (573 cases) — all
agree with the server. Iteratee-heavy collection methods land next.

## 2026-07-27 — feat: fold constant declarations inside lambda expr-blocks

Constant folding now applies inside a lambda expression-block too
(`x => { const a = …; return … }`), not just at the top level — so a constant
`const` vanishes wherever it appears. Previously `generateExprBlock`
([src/codegen.ts](../src/codegen.ts)) lowered every block declaration to a
nested `$let`; now a declaration whose initialiser is a compile-time constant
folds (inlined via `ctx.bindings`, no `$let`), while a declaration that reads the
lambda parameter keeps its `$let`. Example: `$.items.map(x => { const factor = 2;
return x * factor })` → `{ $map: { …, in: { $multiply: ["$$x", 2] } } }` (no
`$let`). Guard: a declaration whose name shadows an in-scope lambda parameter is
never folded — `ParamRef` resolves lambda params before bindings, so folding
would mis-resolve the shadow; the `$let` shadows the parameter correctly instead.
This introduces a (runtime-safe) import cycle codegen.ts ⇄ const-eval.ts, used
only inside functions. Removes the top-level-vs-block inconsistency the earlier
core commit left open.

## 2026-07-27 — feat: fold lodash string methods in `const`/`let`

Extends constant folding to the lodash string family (`snakeCase`, `kebabCase`,
`camelCase`, `startCase`, `capitalize`, `upperFirst`, `lowerFirst`, `words`,
`escape`, `truncate`), completing all seven target examples — e.g.
`let m = "time elapsed"; let t = m.snakeCase(); $.type === t` folds to
`{ type: "time_elapsed" }`. These have no native JS equivalent (the project has
zero runtime dependencies; they exist only as MQL lowerings), so
[src/lodash-fold.ts](../src/lodash-fold.ts) hand-rolls each to mirror jsmql's own
lowering (ASCII-only, lodash's word pattern), NOT real lodash. To make the two
implementations physically undriftable, the shared constants (the word regex,
the HTML-entity table) moved to [src/lodash-shared.ts](../src/lodash-shared.ts),
imported by both codegen.ts and lodash-fold.ts. The consistency suite
(fold-consistency.test.ts) validates every one against its `$regexFindAll`/
`$reduce`/`$replaceAll` lowering on mongod across a battery including "café" and
mixed-case inputs — all agree.

## 2026-07-27 — feat: fold native string/array methods in `const`/`let` (arrow interpreter)

Extends constant folding to native String/Array methods, including the
higher-order ones (`.map`/`.filter`/`.reduce`/`.find`/`.some`/`.every`/`.flatMap`)
whose arrow callback is interpreted at compile time (a private `NON_FOLDABLE`
sentinel unwinds the call to a runtime binding when a callback body reads `$`).
Example 5 now folds: `["cancelled","rejected"].map(s => s.toUpperCase())` →
`["CANCELLED","REJECTED"]`, so `$.status in bad` → `{ $expr: { $in: [...] } }`.

New HR3 gate: [test/fold-consistency.test.ts](../test/fold-consistency.test.ts)
compiles each foldable method × an input battery both ways — the compile-time
fold and the MQL lowering run on a real mongod (via `$documents`, no write) —
and asserts they agree wherever the lowering yields a value (skipping inputs the
lowering itself rejects). It self-skips without a local mongod. That gate caught
real divergences, now handled: array `.slice`/`.flat` are NOT folded (jsmql
lowers `.slice` to `$slice` = take-n/skip-take, not JS start/end); `.find`
withholds when not found (server yields MISSING, not null); string case folds
ASCII-only to match `$toUpper`/`$toLower`; empty-separator `.split` and multi-arg
string `.concat` aren't folded (their lowerings reject those shapes).

## 2026-07-27 — feat: compile-time constant folding of `const` / `let` (core)

`const`/`let` already parsed to `LetDecl` nodes that lowered to a **runtime**
`$set` into `__jsmql.var.<name>` ([let-bindings.md](specs/let-bindings.md)). That
meant `const userId = 0x…; $.userId === userId` couldn't compile to a Filter at
all — the `;` forced Pipeline mode and a bare predicate isn't a stage, so it
errored. This adds a compile-time **fold**: when a declaration's RHS is a
compile-time constant, jsmql evaluates it and inlines the value at every
reference, emitting no stage — so the same input now collapses to the clean,
indexable Filter `{ userId: ObjectId("…") }`.

The fold reuses the exact inline-literal path a `jsmql.compile` parameter uses:
folded values go into `ctx.bindings`, and a `ParamRef` resolves them through
`safeBoundValue` (HR1-safe). Two new modules: [src/const-eval.ts](../src/const-eval.ts)
(`evalConst` — a recursive constant interpreter) and
[src/const-fold.ts](../src/const-fold.ts) (`foldProgram` — the pre-pass that
drops folded declarations, threads their values/types into ctx, and re-collapses
the survivors so an all-constants-plus-one-expression program re-dispatches as a
Filter). `foldProgram` runs first in every lowering entry in
[src/index.ts](../src/index.ts), so folding is uniform across `jsmql` / `.expr` /
`.filter` / `.pipeline` / `.update` and runs **per call** for `jsmql.compile`
(a constant built from a parameter folds against each call's arguments).

Design guarantees: a fold is added only when the JS result is provably identical
to the equivalent MQL lowering (HR3) — this core commit covers literals,
arithmetic, `new Date(const)`, ObjectId, arrays/objects/spread, string
templates, index/`.length`, and const-chains; fidelity-sensitive folds (methods,
Math/Number/Object statics, logical/bitwise ops) land in follow-up commits under
a mongod consistency test. A non-constant RHS (reads `$`, `new Date()`,
`Math.random()`), a reassigned/mutated/redeclared/param-shadowing name, or a
BigInt keeps the runtime `$set` binding unchanged — folding is purely additive,
and a pipeline with no foldable declaration is byte-identical to before. A
declaration with nothing reading it, and a non-finite result (`1/0`), are
compile-time errors. Folded values also populate `ctx.bindingTypes`, so a folded
string key `$.x[k]` keeps its direct `$getField` shape instead of the
`$isArray`-guarded form some servers reject. New suite:
[test/const-folding.test.ts](../test/const-folding.test.ts); the runtime
`let`-binding tests were retargeted to runtime RHS (a constant RHS now folds).
Spec: [specs/const-folding.md](specs/const-folding.md).

## 2026-07-27 — feat(lookup): any lodash stream method may start a `$$$.<coll>` chain

A cross-collection chain no longer has to begin with `.find` / `.filter` / `.aggregate`. Any registered
stream method may head a `$$$.<coll>` chain (`$$$.orders.toSorted({ createdAt: -1 }).take(200).filter(o => …)`),
and `.filter` / `.reject` may now appear at **any** position, each lowering to a sub-pipeline `$match`. The whole
chain lowers, in source order, into one `$lookup.pipeline`, so `.toSorted(k).take(n).filter(p)` emits
`[$sort, $limit, $match]` — sort/limit *before* the filter, a result the old filter-first surface simply
couldn't express. This is a **parity fix**: the `$$` current-stream chain already allowed any method (and a
`.filter` anywhere); the foreign-collection paths just hadn't caught up.

**Why this shape.** The value-position assembler ([tryExtractChainedLookup](../src/lookup-translation.ts)) and
the `$$ =` correlated pivot ([lowerLookupPivot](../src/pipeline.ts)) now share one exported peeler,
`peelForeignChain`: `.filter`/`.reject` route through `buildPipelineFormPredicate` (hoisting `$.<field>` into
`$lookup.let`, exactly as a head `.filter` does — so a correlating filter anywhere works), and every other
method dispatches through the existing stream-method registry. A stream-method head with no `$.` correlation
emits the lean `{ from, pipeline, as }` (no empty `let`), matching the `.aggregate` shape; `validateLookupShape`
was relaxed to accept stream-method heads and only reject a genuinely unknown method (`.fnid`). For `$$ =`,
`lowerChainOnCollection` now dispatches source-switch-vs-pivot on `chainHasCorrelatingFilter` — a correlating
`.filter`/`.reject` *anywhere* in the chain — generalising the old head-only `predicateReferencesOuterDoc` check.

**Two footgun guards kept, one behaviour change.** Correlation arriving *only* through a non-filter method (a
`.map`/`.aggregate` reading `$.` with no correlating filter) stays rejected in the `$$ =` source-switch — without
a filter to bound the foreign set it is a cross-join, and the "correlate with a `.filter`" guidance is better DX
than silently emitting a Cartesian product. The pivot pre-validates every method so a value-terminal (`.head`/`.size`)
is rejected, never dropped. The one deliberate output change (developer-approved): a previously-accepted
`$.x = $$$.coll.filter(p1).filter(p2)` moves from `$lookup` + value-mode `$filter` to a single `$lookup` with
`[$match, $match]` — leaner and consistent. All four forms (value binding, field assignment, source-switch,
correlated pivot) were verified end-to-end on a live `mongod` (chain-order + correlation), including the exact
`sort→take→filter ≠ filter-first` distinction. See [docs/specs/lookup-stage.md](specs/lookup-stage.md) §
"Any lodash stream method may head the chain" and [docs/LANGUAGE.md](LANGUAGE.md#cross-collection-lookups-coll-find--filter).

An adversarial review of this change (find inputs → verify each against `mongod`) surfaced eight bugs it fixed in
the same commit — most pre-existing HR3 holes the wider surface now exercises: a correlated matches-object filter
(`$$ = $$$.orders.filter({ userId: $._id })`) silently miscompiled to a query-literal `$unionWith` (the
correlation dispatch now normalises shorthands via `shorthandToLambda`); a block-body value-extracting `.map`
(`o => { return o.total }`) and a value-collapsing `.map` in the source-switch emitted a scalar `$replaceWith`.
The structural "non-`ObjectLiteral` result ⇒ value-collapsing" rule was extended to block bodies in
`isValueCollapsingMap`/`peelableTerminalMap`, and a single `$$ =` value-collapsing guard now covers both
source-switch and pivot. Rather than merely reject the block form, `peelableTerminalMap` **normalises** a
stage-less stream `.map` block back to its value form — `{ return <expr> }` → an expression arrow, a `const`/`let`
-only block → an `ExprBlock` (`$let`) — so `.map(o => { return o.total })` is now byte-identical to
`.map(o => o.total)` and to the same block on an in-document array (closing a JS-subset inconsistency: identical
JS was accepted on `$.items` but rejected on `$$$.orders`). Only a block with real *stages* returning a
non-document stays rejected (a scalar reshape after stages is genuinely invalid). `.slice(a, a)` emitted the
server-rejected `$limit: 0` (now `$match: { $expr: false }`, mirroring `.take(0)`); a `.map` after an
object-collapsing `.countBy`/`.keyBy` mis-assembled (now rejected like value-mode); and a lone shorthand
`.filter({ x: 1 })` head was rejected while the chained form was accepted (now consistent). One further,
orthogonal pre-existing bug — a `$lookup.let` var named after a hyphenated field (`jsmql_f0_sub-id`) is
server-invalid — was left for a separate `fix:` commit (it predates this feature and lives in `namespace.ts`).

---

## 2026-07-27 — feat(playground): label each editor with its language (Variables = run-time JS, Query = JSMQL)

The input panel stacks two editors that render *identically* — both are
JS-highlighted CodeMirror — but they are two different languages: the **Variables**
box is plain JavaScript, evaluated in the user's own run-time (`new Function`) to
build the params object bound via `jsmql.compile()`, while the main editor is the
**JSMQL** language, compiled to MQL and never executed as JS. Nothing on screen said
so, and the panel was even titled "JSMQL input" — which implied the JS Variables box
nested under it was also JSMQL. The result: people (the project owner included)
constantly mixed up which box was which language.

Fix — name each editor's language right where the eye lands
([playground_skeleton.html](../playground_skeleton.html)): the panel title
"JSMQL input" → neutral **"Input"** (the panel holds one JS box + one JSMQL box, so a
language-specific title mislabels half of it); the Variables header gains a `run-time JS`
language chip; and the main editor gains its own header **"QUERY · `JSMQL syntax`"**
mirroring the Variables header (previously it had no adjacent label at all — its only
label was the far-away panel title). Each chip carries a `title` tooltip spelling out
the full distinction. Rejected a one-off info banner (dismissed-and-forgotten, no
persistent contrast) in favour of always-visible per-editor labels. Chip colours stay
off the five semantic *kind* colours (filter/pipeline/expr/update/err) so they read as
language metadata, not a mode indicator — the JSMQL chip reuses the app's primary
`--accent` (which the brand already uses broadly), the JS chip is neutral grey.

Naming convention this reinforces: **JSMQL** (upper-case) is the language / project;
lower-case `jsmql` names the npm module API only (`jsmql.compile()`, the `jsmql`
callable). The UI copy follows that split — hence `run-time JS` / `JSMQL syntax` on the
chips, not `jsmql → MQL`.

Playground-only; no library code touched. The dynamic Variables hint
(`bound via jsmql.compile() — N vars` / error text) is unchanged — the chip is a
sibling of `#vars-hint`, verified still updating. [playground.html](../playground.html)
regenerated via `scripts/sync-playground.mjs`; rendering confirmed in a browser (empty,
populated-Variables, and dynamic-hint states).

---

## 2026-07-27 — fix: sanitize `$lookup.let` correlation-var names derived from outer field segments

A correlated `$$$.<coll>.filter/find(...)` names its `$lookup.let` variable after the outer field's
last path segment. When that segment held a character legal in a MongoDB *field* name but illegal in a
*variable* name — a hyphen being the common case — jsmql emitted server-invalid MQL. Repro:
`$.x = $$$.orders.filter(o => o.ref === $.meta["sub-id"] && o.qty > 0)` emitted
`let: { "jsmql_f0_sub-id": "$meta.sub-id" }`, and mongod rejects it with
`FailedToParse: 'jsmql_f0_sub-id' contains an invalid character for a variable name: '-'` — an HR3
violation (jsmql knowingly-invalid output). The basic single-`===` form dodged it (it emits
`localField`/`foreignField`, no `let`); only the correlated pipeline form was affected. A pre-existing
bug, surfaced by an adversarial review of the lodash-stream-head work — independent of that feature.

Fix: a `sanitizeVarSegment(name)` helper in [src/namespace.ts](../src/namespace.ts) folds every
non-`[A-Za-z0-9_]` char to `_`, applied inside `letFieldVar` / `letBindingVar` / `letSysVar` (the sibling
`letBindingVar` had the same latent bug for a bracket-keyed outer-`let` member, so it's fixed in lock-step).
Only the emitted var **name** is sanitized; the `let` **value** keeps the raw field path (`$meta.sub-id`,
where hyphens are legal). Sanitizing is intentionally non-injective (`sub-id` and `sub_id` both → `sub_id`),
but the `LetAllocator` interns on the **raw** dotted path and appends `_2`/`_3` on same-base collisions, so
two distinct fields stay distinct (`jsmql_f0_sub_id` + `jsmql_f0_sub_id_2`) and the same field always maps
to the same var. Verified end-to-end on a live mongod: the fixed pipeline is accepted and returns the single
correct match, while the old hyphenated var name is rejected (`FailedToParse`) — confirming the hyphen was
the sole defect. Guarded by two unit cases in [test/lookup.test.ts](../test/lookup.test.ts) (hyphenated
field → safe var; the two-distinct-fields collision) and a live-fixture case in
[test/integration.test.ts](../test/integration.test.ts) (the fixture's orders gained a nested hyphenated
`meta["ext-id"]` field to correlate on). The var-name trap in [test/CLAUDE.md](../test/CLAUDE.md) was
broadened from "starts with an invalid char" to "contains an invalid char anywhere".

---

## 2026-07-27 — fix: statement-position `.pop()` / `.shift()` emit a valid `$slice` on empty/short arrays

`$.field.pop()` and `$.field.shift()` (the statement-position array mutators, lowered by `tryRewriteMutatorCall` in [src/codegen.ts](src/codegen.ts)) emitted a 3-arg `$slice` whose count could be 0: `.pop()` → `$slice:[arr, 0, max(0, size-1)]` and `.shift()` → `$slice:[arr, 1, $size(arr)]`. MongoDB rejects a 3-arg `$slice` count of 0 **at runtime**, not only during constant-folding ("Third argument to $slice must be positive: 0") — so both threw on an empty array, and `.pop()` also threw on a single-element array. A comment even claimed the `$max` clamp made `.pop()` safe; it did the opposite (it produced the 0). Pre-existing HR3 violation, found while fixing the value-mode `.slice` lowering (same count-0 class).

The fix reuses shapes already proven correct elsewhere in the file: `.pop()` (= `.slice(0, -1)`) now lowers like `.initial()` — the **2-arg** `$slice:[arr, max(0, size-1)]`, whose count IS allowed to be 0 (→ `[]`) — and `.shift()` (= `.slice(1)`) lowers like `.tail()`/`.drop(1)` with count `max(1, $size(arr))`, never 0 (an empty receiver is `$slice:[[], 1, 1]` → `[]`, position past the end). Verified against a live `mongod` across empty, single-element, and multi-element arrays, and locked in with a new [test/integration.test.ts](test/integration.test.ts) case that runs both over the fixture users' `tags` (which include `[]`, `["vip"]`, and two-element arrays). Docs in [docs/specs/method-dispatch.md](docs/specs/method-dispatch.md) and [docs/LANGUAGE.md](docs/LANGUAGE.md) updated to the corrected shapes.

---

## 2026-07-27 — fix: top-level bracket-accessed outer field in a correlated `$lookup` no longer emits a leading-dot field path

Sibling of the same-day `$lookup.let` var-name sanitization fix, found while verifying it. A correlated
`$$$.<coll>.find/filter(pred)` referencing a **top-level bracket-accessed** outer field —
`$["ext-code"]` — emitted a field path with a spurious leading dot: `localField: ".ext-code"` (basic
single-`===` form) and a `$lookup.let` value of `"$.ext-code"` (pipeline form). MongoDB rejects both
(`Location15998`) — another HR3 violation. Root cause: the bare root `$` parses to a `FieldRef` with an
empty path, and `classifyPath` in [src/lookup-translation.ts](../src/lookup-translation.ts) captured that
as the segment `[""]`, so a bracket access folded to `["", "ext-code"]` → `.ext-code`. The nested form
(`$.meta["sub-id"]`) was unaffected because its base segment is the non-empty `"meta"`.

Fix: `classifyPath`'s `FieldRef` case now maps the empty-path root to **no** segment (`[]`), mirroring
general codegen where `$["x"]` is `$x` and a lone `$` is `$$ROOT` (both keyed on `path === ""`). A bracket
access onto the root then folds cleanly to `["ext-code"]` → `localField: "ext-code"` / value `"$ext-code"`.
The change also surfaced that a bare `$` as a correlation **value** (`o.ref === $`) had been emitting an
invalid empty field path (`localField: ""` / `let` value `"$"`); `transformExpr` now rejects it with an
actionable "reference a specific field with `$.<field>`" error — the local-side mirror of the existing
bare-foreign-param rejection. A bare `$` as a write **target** stays valid (the root-replace destination
`$ = { … }` from an object-body `.map`): `transformTarget` resolves it to the empty-path root `FieldRef`
before the value-side guard applies.

Verified end-to-end on a live mongod: the fixed basic form is accepted and correlates selectively (driver
whose `ext-code` matches an order's `ref` gets that order; a non-matching driver gets none), while the old
`.ext-code` `localField` is rejected (`Location15998`). Guarded by three unit cases in
[test/lookup.test.ts](../test/lookup.test.ts) (basic-form clean `localField`; pipeline-form clean `let`
value + var; bare-`$` rejection) and a live-fixture case in [test/integration.test.ts](../test/integration.test.ts)
(the fixture's orders gained a top-level hyphenated `ext-code` field to correlate on, distinct code path
from the nested `meta["ext-id"]` field added for the var-name fix).

---

## 2026-07-27 — fix: value-mode array `.slice(start, end?)` now matches `Array.prototype.slice`

The value/expression-mode lowering of array `.slice` in [src/codegen.ts](src/codegen.ts) (`sliceArray`) had been passing the JS args straight into MQL `$slice` — but the two operators disagree. JS `.slice(start, end)` takes **indices** with an **exclusive end**; MQL `$slice` is position + **count**. So `[1,2,3,4,5].slice(1)` returned `[1]` on the server (MQL's "first 1") instead of JS's `[2,3,4,5]`, and `.slice(1, 3)` returned three elements from index 1 instead of the two at indices 1–2. `.slice(0)` even lowered to `$slice:[arr,0]` → `[]` (MQL "first 0") rather than a whole-array copy. Only single-arg negative literals (`.slice(-2)`) happened to agree, because MQL's 2-arg negative form *is* "last n". This was a pre-existing bug, surfaced by the const-folding branch's mongod-consistency gate.

The fix resolves both indices the way the ECMAScript algorithm does — negatives count from the end, positives clamp to the length, `end` is exclusive — and translates to `$slice` with a computed count. Common shapes stay lean: `.slice(-n)` → 2-arg `$slice`; `.slice(0)` → the receiver unchanged; `.slice(0, end)` → the count-tolerant 2-arg "first end"; `.slice(a, b)` for non-negative literals → `$slice:[arr, a, b-a]` (or `[]` when `b <= a`). A negative-`end` or runtime index falls to a general `$let` form that resolves both indices against `$size` and guards the empty range with `$cond` (→ `[]`). Two MongoDB constraints shaped the output, both confirmed against a live `mongod`: the 3-arg `$slice` count must be **> 0** even at runtime (so the guard returns a bare `[]`, and the general form's own count is emitted as `max(count, 1)` so a *constant-array* receiver stays foldable by the optimizer instead of hitting a rejected 0-count `$slice`), while the 2-arg form tolerates a 0 count. The **stream-mode** `.slice` (`$$ = $$.slice(a, b)` → `$skip`/`$limit`) was already index-based and is untouched; string `.slice` (`$substrCP`) was already correct. Verified end-to-end with a new [test/integration.test.ts](test/integration.test.ts) case and an exhaustive `Array.prototype.slice`-vs-`mongod` diff over positive/negative/zero/out-of-range/runtime indices across empty and short arrays. Also corrected two now-wrong doc examples: `.slice(0)` and `.reverse()` were listed as type-pinning idioms in [docs/LANGUAGE.md](docs/LANGUAGE.md) but the former is now a no-op (never pinned) and the latter is rejected at expression position — both replaced with `.toReversed()`.

## 2026-07-24 — feat: value-mode `.countBy()` / `.groupBy()` / `.keyBy()` accept no iteratee (identity default)

lodash defaults the iteratee of its `*By` collectors to `_.identity` — `_.countBy([1,2,3,4,5,2,3])`
→ `{ "1": 1, "2": 2, "3": 2, "4": 1, "5": 1 }` (count by the element itself). jsmql's value-mode
`resolveIteratee(undefined, …)` already produced that identity iteratee (`$$jsmqlItem`), but the three
object-collapse methods gated on `checkArity(…, { exact: 1 })`, so the no-arg call was rejected. Relaxed
`.countBy` / `.groupBy` / `.keyBy` to `{ sig: "[iteratee]", allowed: [0, 1] }` in
[src/codegen.ts](../src/codegen.ts) — the only change; the lowering is untouched. All three no-arg shapes
were run on a live mongod: `[1,2,3,4,5,2,3].countBy()` → `{1:1,2:2,3:2,4:1,5:1}`, `[1,2,2].groupBy()` →
`{1:[1],2:[2,2]}`, `[1,2,3].keyBy()` → `{1:1,2:2,3:3}`, `[].countBy()` → `{}`.

Scope is deliberately those three only. `.sumBy`/`.meanBy`/`.minBy`/`.maxBy`/`.uniqBy` stay `exact: 1`:
their lodash no-arg forms are exactly the already-shipped `.sum`/`.mean`/`.min`/`.max`/`.uniq`, and a
second spelling for the same capability is the output drift jsmql rejects (see
`feedback_no_silent_output_drift`). The **stream** forms (`$$.countBy("field")`, …) also stay
field-required: a `$$`/`$$$.<coll>` stream is always a stream of *documents*, which has no scalar identity
to collapse by — a no-arg lowering would group whole documents and emit `$toString`-on-object MQL the
server rejects (HR3). Ambient types (`scripts/generate-ops.mjs` → `src/ops.ts`) mark the value-mode
iteratee optional via a new `OPT_ITER` for the three; the stream signatures are unchanged.

## 2026-07-24 — feat: `.orderBy({ field: dir })` object form (value + stream)

The lodash `.orderBy` sort alias now accepts a `{ field: 1 | -1 | "asc" | "desc" }` object in
addition to the existing parallel `keys` + `orders` form, in both value mode
(`$.items.orderBy({ score: -1 })` → `{ $sortArray: { input: "$items", sortBy: { score: -1 } } }`)
and stream mode (`$$.orderBy({ score: -1, name: 1 })` → `[{ $sort: { score: -1, name: 1 } }]`). The
object carries the directions inline, so passing a second `orders` argument alongside it is rejected
with a "drop the second 'orders' argument" hint. The object branch reuses the same helpers the
`.sort`/`.toSorted` object forms already use (`argToSortBy` in [src/codegen.ts](src/codegen.ts),
`buildKeySortSpec` in [src/stream-methods.ts](src/stream-methods.ts)), so the emitted shape is
identical to those already-verified forms.

*Why:* `{ field: dir }` is the shape MongoDB's own `$sort` takes and the one `.sort`/`.toSorted`
already accept, so making `.orderBy` accept it too removes a papercut — a developer who reaches for
`.orderBy` no longer has to rewrite a natural `{ score: -1 }` into two parallel arrays. The one
consistency wrinkle: in lodash an object first-arg to `_.orderBy` would be a *matches-shorthand*, the
same footgun that keeps `.sortBy({…})` rejected. We keep `.sortBy({…})` rejected (its iteratee has no
direction slot, so an object there is genuinely ambiguous) but treat `.orderBy({…})` as a direction
spec — `.orderBy` is explicitly the "with directions" alias, so a `{ field: dir }` reads unambiguously.
The `.sortBy({…})` rejection messages (both modes) now point at `.orderBy({ field: -1 })` as the
object-form path. See [docs/LANGUAGE.md](docs/LANGUAGE.md), [docs/specs/stream-methods.md](docs/specs/stream-methods.md),
and [docs/specs/method-dispatch.md](docs/specs/method-dispatch.md).

## 2026-07-21 — chore: drift guard tying value-method ambient return types to the `METHODS` registry

After merging master's method-chain type-checking, the `METHODS` registry now carries an invariant
result category (`returns` — now incl. `number`/`object`) for most methods. The value-method ambient
signatures in `scripts/generate-ops.mjs` (`VALUE_METHOD_SIGNATURES`) were hand-authored and only
manually verified to agree. Added a generator drift guard (via a new `valueMethodReturns()` export
from `src/codegen.ts`) that extracts each augmentation's TS return type and asserts it stays in the
registry's declared category — so a future `returns` change that isn't mirrored in the ambient
signature fails the build instead of silently making completion lie. Methods whose result depends on
the receiver/args (`.head` → element `T`, `.groupBy` value-vs-stream, `.max`/`.min`, `.clamp`) declare
no invariant `returns` and are skipped. Complements the existing membership check (every registry
value method needs a signature or a `VALUE_METHOD_SKIP` entry).

## 2026-07-21 — feat: `@koresar/jsmql/ops` completion for the lodash value methods (+ `$$.reject`)

`import "@koresar/jsmql/ops"` now completes the lodash-flavoured **value** methods
(`.uniq`, `.chunk`, `.groupBy`, `.capitalize`, `.clamp`, …), not just the `$`-prefixed
globals and `$$` stream methods. These are methods on *values*, so completion needs the
receiver to have a real type: `valueMethodAugmentationBlock()` in `scripts/generate-ops.mjs`
augments the built-in `Array<T>` / `String` / `Number` interfaces with them, each carrying a
concrete return type so a chain stays completable end to end
(`items.sortBy("total").takeRight(3).map(o => o.sku).uniq()`). Signatures live in a hardcoded
`VALUE_METHOD_SIGNATURES` map (same rationale as `STREAM_METHOD_SIGNATURES`); a completeness
check against `valueMethodNames()` (newly exported from `src/codegen.ts`) + a `VALUE_METHOD_SKIP`
classification (native / date / object / set / regex / shimmed) fails the build if a registry
value method gains neither a signature nor a skip entry — the same drift guard the stream
members have.

Two boundaries are inherent and documented rather than worked around. (1) A bare, un-annotated
`$.field` is `any`, and `any.uniq()` stays `any`, so completion only "activates" on a concretely
typed value (an annotated `$`, a typed static like `Object.values(o)`, a literal, or a
known-return method result mid-chain) — `$.field` *must* stay `any` so `$.age > 18` /
`$.price * 1.1` keep type-checking, and TypeScript can't make one type both an operator operand
and a rich method receiver (three `tsc` probes confirmed the wall). (2) Object-receiver methods
(`.mapValues`/`.pick`/`.omit`/`.invert`/…) are excluded: the only interface to hang them on is
`Object`, the base of every type. Also folded in: `$$.reject(...)` — special-cased like
`$$.filter` and previously missing from the `$$` member list — now completes.

Prototyped and reverted: typing `$$$.<coll>` as a chainable ref for foreign-collection-chain
completion. It regresses either `.find(pred)` callbacks (`noImplicitAny`) or the `$out` write
(`$$$.coll = $$…`); `$$$.<coll>` is both a read head and a write target and one index type
can't serve both. Left under `[DEF-015]` (notes updated), gated on `[DEF-013]` schema threading.
Locked in by the type-level regression test `test/types/ops-completion.ts` (its own
`tsconfig.ops.json`, run through `tsc` by `test/smoke.test.ts`): positive chains plus
`@ts-expect-error` typos proving the surface isn't silently `any`.

## 2026-07-19 — feat: reject method chains that can't type-check; unwrap `.filter(p).countBy(...)` with `$first`

Two related "chaining must make sense" changes, both closing HR3 holes where jsmql
silently emitted server-rejected MQL.

**1 — chain type-check (`certainReceiverType` / `requiredReceiverFamily`, codegen.ts).**
A method chained on a receiver whose type is **100%-certain** to be incompatible now
throws at compile time. Previously `.every(p).map(f)` emitted `$map` over a boolean,
`s.toUpperCase().map(f)` `$map` over a string, `a.size().map(f)` `$map` over a number,
`a.countBy("t").take(3)` `$slice` over an object — all mongod-rejected (verified). The
check reuses the verified-sound `isProvablyBool`/`isArrayProducing` for bool/array
receivers and the method registry's invariant `returns` (widened to add `number`/
`object`) for string/number/object receivers. It is deliberately **not** built on
`isStringProducing` (its `STRING_OUTPUT_OPS` wrongly holds the int-returning
`$strcasecmp`) nor on object literals (a `{$op}` escape hatch can return any type) —
those were the false-positive sources an adversarial design pass surfaced. Literal-
gated like the date-receiver gate: an uncertain receiver (a `.find()`/`.at()` element
of unknown type, a `.clamp(...)` number-or-date result, a dual `.slice`/`.includes`,
a field ref) never throws and still emits. Over a lookup, `$$$.coll.find(p).take(5)`
is caught in `lookup-translation.ts` (a `.find` result is one document; array/string/
number/date methods rejected, object methods + field reads still valid) — the value-
mode arm can't see it (the receiver is a materialised `FieldRef`). Rule set was
adversarially verified (each candidate skeptic-checked for a valid counterexample)
and every enforced rule confirmed a genuine server-rejection on a live mongod.

**2 — `.filter(p).countBy(...)` value-position now unwraps with `$first`.** A collapsing
terminal (`.countBy`/`.keyBy`/`.groupBy("k")`) in a correlated-lookup chain emits its
one object doc into the `$lookup.as` array, so `$.byStatus = …filter(p).countBy("k")`
set `byStatus = [obj]` instead of `obj`. `tryExtractChainedLookup` now appends
`$set { <slot>: { $ifNull: [{ $first: "$<slot>" }, {}] } }` (mirroring `lowerLookup`'s
`.find` `$first`); `$ifNull → {}` makes an empty foreign match yield `{}`, matching
value-mode `_.countBy([]) === {}`. Verified on mongod (`{shipped:2,pending:1}`; `{}`
for a user with no matches). The `.find(...)` materialised path was already single-doc
and is unchanged.

The chain-permutation suite's mongod half (every ordered method pair) passes — the
strongest guard that no *valid* chain is wrongly rejected. Files:
[src/codegen.ts](../src/codegen.ts), [src/lookup-translation.ts](../src/lookup-translation.ts),
[docs/specs/method-dispatch.md](specs/method-dispatch.md), [docs/specs/lookup-stage.md](specs/lookup-stage.md),
[docs/LANGUAGE.md](LANGUAGE.md).

## 2026-07-19 — fix: null/missing group key coerces to `"null"`; stream `.keyBy` now collapses like `.countBy`/`.groupBy`

Two follow-ups to the stream-collapse change below.

**1 — null/missing keys no longer crash `keyBy`/`groupBy`/`countBy`.** All three build
their object keys with `$toString`, which yields *null* for a missing/null grouping
field; `$arrayToObject` then rejects it ("the value of 'k' must be of type string") —
a server error that hit **both** value-mode and stream-mode (a green `toEqual` hid it;
only a live run surfaced it). Introduced `stringKeyExpr` (`src/codegen.ts`):
`{ $ifNull: [{ $toString: <key> }, "null"] }`, so a missing/null key lands under one
`"null"` bucket (matching JS `String(null)`) instead of erroring. Applied at every
object-key site of the trio in both modes (value-mode `keyBy` / `groupBy` / `countBy`
+ `distinctKeysExpr` + the group-filter `$eq`; the stream collapses import the same
helper), so the two paths stay identical. `$toString` still errors on an object/array
key — a narrower, pre-existing footgun left as-is (documented in LANGUAGE.md).

**2 — stream `.keyBy("field")` now works as a `$$ =` pivot.** It was in
`VALUE_TERMINAL_METHODS` (value-position only: `$$ = $$.keyBy(...)` was rejected),
inconsistent with its siblings `.countBy`/`.groupBy`, which the change below made
collapse over the whole `$$` stream. Added a `KEY_BY` stream lowering (`$group` with
`$last: "$$ROOT"` — last wins, matching value-mode + lodash — then the same
`$arrayToObject` collapse) and removed `keyBy` from `VALUE_TERMINAL_METHODS`. Now all
three collapse to the lodash object in every position: `$$ =` pivot, bare statement,
and value-position lookup chains (`.find(...)` materialises clean; `.filter(...)`
correlates). `partition` and the scalar aggregates stay value-terminals (no object to
collapse to). Verified on a live mongod (`{ <key>: <last doc> }`, last-wins) and via
the chain-permutation mongod half. Files: [src/codegen.ts](../src/codegen.ts),
[src/stream-methods.ts](../src/stream-methods.ts), [scripts/generate-ops.mjs](../scripts/generate-ops.mjs),
[docs/specs/stream-methods.md](specs/stream-methods.md), [docs/LANGUAGE.md](LANGUAGE.md).

## 2026-07-19 — fix: stream `.countBy` / `.groupBy("key")` collapse to the lodash object (were `$sortByCount` / `$group` streams)

lodash `_.countBy(coll, key)` and `_.groupBy(coll, key)` return **objects** —
`{ <keyValue>: <count> }` and `{ <keyValue>: [elements] }`. Value-mode
`$.arr.countBy(...)` / `.groupBy(...)` already did (via `$arrayToObject`), but the
**stream** forms (`$$ = $$.countBy("type")`) lowered to MongoDB's `$sortByCount` (a
stream of `{ _id, count }` docs) and `$group: { _id: "$key" }` (a stream of group
docs) — the MongoDB idiom, not the lodash shape. Same method name, two different
result shapes depending on the receiver: a DX wart against the "lodash you already
know" pitch, and inconsistent with `.keyBy`, which was already a value-collapsing
terminal returning `{ <key>: elem }` in both modes.

Now both stream forms collapse the stream to the single lodash object (mirroring
value-mode): `$group` (tally / `$push: "$$ROOT"`) → a second `$group` gathering
`{k, v}` pairs into the flat `GROUP_TMP` slot → `$replaceWith: { $arrayToObject }`
(the same pattern the reduce/dict-build wrap already uses). `.groupBy({ _id, … })` —
the accumulator-body form, which has **no** lodash analogue — is unchanged and still
lowers to one `$group` stage. No capability is lost: the count-descending stream is
still reachable by writing the `$sortByCount("$key")` stage directly, and the grouped
stream by `$group(...)` / `.groupBy({ _id, … })`. Value-position lookup chains
(`.find(...).countBy(...)`) were already object-shaped and are untouched.

Verified on a live mongod (`{ <val>: <count> }`, `{ <val>: [docs] }`, and the
correlated-sub-pipeline case) and via the chain-permutation suite's mongod half.
`.countBy`/`.groupBy("key")` are value-collapsing now, so `.countBy` moved out of
`STREAM_RESHAPERS` in `test/permutations.test.ts` (pairing a collapse with a
field-stripping reshaper would feed `$arrayToObject` a null key — mongod-rejected).
Known shared limitation, unchanged from value-mode: the key is `$toString`'d, so a
missing/null/object key errors on the server — a pre-existing footgun that now
applies identically to both paths (a robustness fix, if wanted, belongs on both at
once). Files: [src/stream-methods.ts](../src/stream-methods.ts),
[docs/specs/stream-methods.md](specs/stream-methods.md), [docs/LANGUAGE.md](LANGUAGE.md).

## 2026-07-19 — test: lodash chain-permutation "chinese wall" (`test/permutations.test.ts`)

A generative smoke test that CHAINS the lodash array/collection methods in every ordered
pair — reshaper × reshaper and reshaper × terminal — across value mode (`$.nums`/`$.objs`
→ `$op`), stream mode (`$$.<chain>` → stages), and stream value-terminals in a lookup
value-position. ~1800 chains. Each is asserted to (1) **compile** (always — the primary
regression net) and (2) **run on a real mongod without a server error** (gated on
`JSMQL_PERM_MONGO` pointing at a writable mongod; self-skips otherwise, like
`integration.test.ts`). A `checkAll` helper collects every offending chain into the failure
message, so a regression names the exact `.a().b()` combination.

It immediately earned its keep — caught the two `$slice`-count-0 bugs fixed in the entry
below (which the hand-written per-method tests missed because they never hit the empty-array
/ `n ≥ size` / first-element-fails boundary). Run the mongod half with
`JSMQL_PERM_MONGO=mongodb://127.0.0.1:27017 npm test`.

## 2026-07-19 — fix: value-mode `.drop`/`.dropRight`/`.tail`/`.initial`/`.takeWhile`/`.*RightWhile` emitted a count-0 `$slice` (mongod-rejected)

MongoDB rejects a 3-argument `$slice` whose count is `0` ("Third argument to $slice must be
positive"). Several value-mode methods hit exactly that at a boundary:

- **`.takeWhile`** (and `.takeRightWhile`/`.dropRightWhile`, which wrap it) → `$slice: [arr, 0,
  0]` when the FIRST element already fails the predicate (`jsmqlFi === 0`). Fixed by using the
  2-arg first-n form `$slice: [arr, jsmqlFi]` (`0` → `[]`, valid).
- **`.dropRight(n)` / `.initial()`** → `$slice: [arr, 0, max(0, size-n)]` = count `0` when
  `n ≥ size`. Fixed with the 2-arg form `$slice: [arr, max(0, size-n)]`.
- **`.drop(n)` / `.tail()`** → `$slice: [arr, n, size]` = count `0` on an EMPTY array. Fixed by
  making the count `max(1, size)`, so an empty array is `$slice: [[], n, 1]` → `[]`.

Surfaced by the chain-permutation test (entry above), which chained these after filters that
can shrink an array to one/zero elements. Verified: all ~1800 permutations run clean on mongod.
The stream forms (`$skip`/`$limit`/reverse-sort) never used `$slice`, so were unaffected. Five
existing per-method assertions updated to the count-safe shapes.

## 2026-07-19 — feat: stream `.pick` / `.omit` → `$project`; aggregates are value-terminals (smoke-test gaps)

A full smoke test of every lodash array/collection method in **both** modes (value: `$.arr.fn(…)`
→ aggregation `$op`; stream: `$$.fn(…)` → pipeline stage) surfaced two gaps, both fixed:

1. **`.pick` / `.omit` had no stream form** (they errored "not a chainable stream method"; in a
   lookup chain they wrongly ran value-mode `$objectToArray` over the *array* of docs). Now stream
   methods lowering per-document to `$project`: `.pick([f…])` → inclusion (`{f:1, …, _id:0}` — keeps
   ONLY the named fields, `_id` dropped unless named, matching lodash `_.pick` and the value-mode
   `.pick`); `.omit([f…])` → exclusion (`{f:0, …}`, keeps everything else incl. `_id`). In a
   `$$$.<coll>.filter(p).pick(…)` chain they land in the `$lookup` sub-pipeline, so each foreign doc
   is projected. Verified on a live mongod. Value-mode `.pick`/`.omit` (on a single object) are
   unchanged — context dispatch keeps them separate.
2. **The aggregates `.sum`/`.mean`/`.max`/`.min`/`.sumBy`/`.meanBy`/`.minBy`/`.maxBy`** gave a
   *generic* "not a stream method" error, but they collapse a stream to one scalar — so they're now
   in `VALUE_TERMINAL_METHODS` alongside `.size`/`.every`/…: they work in a **value position**
   (`$.n = $$$.orders.filter(p).sumBy("total")` → `$sum` over the lookup result) and give the clean
   "returns a single value, use a value position" error as a `$$ =` pivot or bare statement.

The remaining value-array-only methods (set-ops `difference`/`xor`/… + `By`, `zip`/`unzip`,
`compact`/`flatten`/`chunk`, the object transforms `pickBy`/`mapValues`/`invert`/`toPairs`/…) have
no single-stage document-stream form — they operate on an **array value**, so they're reachable in a
lookup value-position (over a materialised array) but not as bare `$$` stages, which is correct.

## 2026-07-19 — feat: stream Tier 3 — `.takeRight` / `.dropRight` / `.initial` / `.shuffle` (reverse-sort trick); `.takeWhile`/`.dropWhile` deferred [DEF-034]

The "from-the-end" and random stream reshapers. A document stream has no inherent order, so
"last n" only means something relative to one — `reverseSortTrick` reverses a preceding
directional `$sort` (via `replacesPreviousStage`), applies `$limit`/`$skip`, then restores it;
with no preceding sort it orders by `_id` (developer's choice):

    $$.takeRight(3)              → [{ $sort:{_id:-1} }, { $limit:3 }, { $sort:{_id:1} }]
    $$.sort("createdAt").takeRight(3) → [{ $sort:{createdAt:-1} }, { $limit:3 }, { $sort:{createdAt:1} }]
    $$.dropRight(2)              → …$skip:2…            $$.initial() = .dropRight(1)
    $$.shuffle()                → [{ $addFields:{ <__jsmql.tmp.N>: {$rand:{}} } }, { $sort:{<slot>:1} }, { $unset:<slot> }]

`takeRight(0)` → empty (`$match:{$expr:false}`); `dropRight(0)` → identity. A non-directional
preceding `$sort` is rejected (sort by 1/-1 first). `.shuffle` stamps a `$rand` key via a
`__jsmql.tmp` slot and `$unset`s it; the trailing `$unset:"__jsmql"` clears the residue
(verified — no `__jsmql` leaks to output). All verified on a live mongod (`takeRight`/`dropRight`/
`initial` with and without a prior sort; `shuffle` randomises with no residual).

Stream `.takeWhile`/`.dropWhile` are **deferred** ([DEF-034], developer decision): a stream
running-flag needs `$setWindowFields` over an ordered stream, which is heavy and rarely needed
(the common intent is `.sort(key)` + `.filter(o => o.key < X)`). They throw an actionable error
pointing at the value-mode forms (which ship) or the sort+filter workaround. Value-mode
`.takeWhile`/`.dropWhile` on arrays are unaffected.

## 2026-07-18 — feat: value-collapsing stream terminals are value-position-only (`.head`/`.size`/`.every`/… pivot to value-mode)

Formalises the rule the developer asked for: a value-collapsing lodash terminal —
`.head` / `.first` / `.last` / `.nth` / `.size` / `.every` / `.some` / `.includes` /
`.partition` / `.keyBy` (`VALUE_TERMINAL_METHODS`) — collapses a document stream to a single
value, so it "pivots to value-mode" like a terminal `.map`. It is valid ONLY in a value
position and rejected as a stream. The four canonical behaviours:

    $$ = $$$.orders.head();       // THROWS — a value isn't a stream (use .take(1) for a 1-doc stream)
    $$ = $$$.orders.take(1);      // ok      — take returns a stream
    $$$.orders.head();            // THROWS — a value isn't a pipeline stage
    $.field = $$$.orders.head();  // ok      — value-mode over the lookup result

Two pieces: (1) `injectImplicitFilterForValueTerminal` in `extractLookupCalls` makes a
value-terminal on a **bare** `$$$.<coll>` (no `.filter`) mean "over ALL documents" —
`$$$.orders.head()` ≡ `$$$.orders.filter(() => true).head()` — so the existing value-mode
peel handles it (verified on mongod: all-orders `head().sku` → the first sku, `size()` → the
count, `every(o => o.paid)` → a bool). It fires only in value position, so the pivot / bare
statement of the same shape still reaches its rejection. (2) `unknownStreamMethod` and the
bare-statement stage validator now give every value terminal a targeted "returns a single
value — use a value position" error instead of a generic one. The value terminals **with** a
`.filter` already worked (the expression fallthrough); this closes the no-filter form and the
wrong-position errors. Applies uniformly to all of them, not just `.head`.

## 2026-07-18 — feat: stream `.tail()` → `$skip: 1`; note that value-returning terminals already work on lookup chains

Added `.tail()` (all but the first document → `$skip: 1`, the stream analogue of `.drop(1)`)
to `STREAM_METHODS`, so it works in every stream context.

Discovery while auditing the rest of Tier 1/2: the **value-returning** stream terminals —
`.head()` / `.first()` / `.last()` / `.nth(n)` / `.size()` / `.every(p)` / `.some(p)` /
`.includes(x)` / `.partition(p)` / `.keyBy(k)` — **already work on a `$$$.<coll>.filter(...)`
lookup/assignment chain** with no new code: they aren't stream methods, so the chain bails to
the expression form, which applies the value-mode method (built earlier this session) over the
lookup result array. This is exactly the "returns a single item, like `find()`" behaviour the
developer asked for. Verified on a live mongod (`.head().sku` → the first order's sku, `.size()`
→ the match count, `.every(o => o.paid)` → a bool). What remains is the **top-level `$$`**
context for these (stage forms — `.size()` → `$count`, `.head()` → `$limit: 1`, …) and Tier 3
(`.last`/`.takeRight`/`.dropRight`/`.initial`/`.takeWhile`/`.dropWhile`/`.shuffle` via the
reverse-sort trick). `.uniq()` needs **no** stream form — a document stream's rows always differ
by `_id`, so whole-doc dedupe is a no-op; `.uniqBy(field)` is the stream dedupe, and value-mode
`.uniq()` already dedupes a lookup result array.

## 2026-07-18 — feat: stream `.reject(pred)` → `$match` (filter negated) — the missing complement

`.filter` was a stream method but `.reject` wasn't (value-mode had both). Added, special-cased
in `applyStreamMethods` next to `.filter` (it shares the predicate machinery). It accepts the
same forms — an arrow, a matches-object, a field string, or a `["field", value]` pair (via the
now-exported `shorthandToLambda`) — synthesizes `o => !(<predicate body>)`, and reuses
`lowerStreamFilterPredicate`:

    $$.reject(o => o.archived === true);  → [{ $match: { $expr: { $not: { $eq: ["$archived", true] } } } }]
    $$.reject({ archived: true });        → same

The negated arrow lowers to `$match: { $expr: { $not: … } }` — never a query-form De Morgan
(jsmql rejects that project-wide; DEFERRED §B). Verified on a live mongod (arrow, matches-object,
chained after `.filter`).

## 2026-07-18 — feat: stream `.sortBy` / `.orderBy` → `$sort` (re-added; lodash sort aliases on the document stream)

First family of the **document-stream** lodash coverage (mirroring the value-mode push). The
lodash sort aliases as stream methods:

    $$.sortBy("age")                       → [{ $sort: { age: 1 } }]
    $$.orderBy(["age", "name"], ["desc", "asc"]) → [{ $sort: { age: -1, name: 1 } }]

Registered in `STREAM_METHODS`, so they work in every stream context (top-level `$$`, the
`$$$.<coll>` lookup sub-pipeline, the `$$ =` source-switch). `.sortBy` is ascending by a
field / `[fields]` (an object arg is rejected — a lodash matches-shorthand, not a direction,
pointing at `.orderBy` / `.sort`); `.orderBy` zips parallel `keys` + `orders` arrays.

Correction: these were dropped from streams in `efce89f` (alongside the genuinely-unwanted
`.toReversedBy`) — that was over-removal. The developer never intended to remove `sortBy`/
`orderBy`; the earlier "sort / sortBy / orderBy" list was a guide to implement them all.
Verified on a live mongod.

## 2026-07-18 — fix: a value-collapsing `.map` in a `$$ =` replace-stream pivot is rejected, not lowered to runtime-invalid MQL

Companion to the assignment-form fix (`8505a01`). `$$ = $$$.orders.filter(...).map("productId")`
emitted a scalar `$replaceWith` (inside the `$lookup.pipeline` AND after the `$unwind`);
mongod rejects it at runtime (Location40228 "'replacement document' must evaluate to an
object" — verified). Unlike the `$.field = …` assignment form, a `$$ =` pivot's result IS
the new **document stream**, so there is no value-mode array target to peel the map onto —
a stream simply can't hold scalars.

Verified on a live mongod: an **object** map (`.map(o => ({ pid: o.productId }))`) and a
**subdocument** field map (`.map("details")`) both lower correctly (`$replaceWith` the
reshaped doc in the sub-pipeline, then `$unwind`/`$replaceWith` explode it) — only a
scalar map fails. Since jsmql can't statically tell a scalar field from a subdocument, and
`.map("field")` means "pluck the value" everywhere else in the lodash vocabulary,
`lowerLookupPivot` now rejects any value-collapsing map (`isValueCollapsingMap`, exported
from `lookup-translation.ts`) at **compile time** with an actionable error: reshape with
`.map(o => ({ … }))`, or collect the values into a field via `$.<field> = $$$.<coll>
.filter(...).map(...)` (the assignment form, which peels to a value-mode `$map`). Spec:
[`lookup-stage.md`](specs/lookup-stage.md § Value-extracting `.map`).

## 2026-07-18 — feat: full lodash iteratee/predicate shorthands across ALL higher-order value methods

The `_.identity`-family shorthands now work on **every** higher-order value method, not just
the `By` family. A single desugarer, `shorthandToLambda(arg, method, param)`, turns each
shorthand into the equivalent one-parameter arrow:

    "a.b"                 → it => it.a.b                     (_.property; dotted paths ok)
    { a: 1, b: 2 }        → it => it.a === 1 && it.b === 2   (_.matches; flat $eq per key)
    ["a.b", v]            → it => it.a.b === v               (_.matchesProperty)

Three insertion points share it: `requireLambda` (the native `.map`/`.filter`/`.find`/
`.findIndex`/`.findLast`/`.some`/`.every`/`.flatMap` funnel), `resolveIteratee` (the `By`
family), and `resolvePredicate` (`.reject`/`.partition`/`.takeWhile`/…, now a thin delegate
to `resolveIteratee`). Because a shorthand becomes an ordinary arrow before lowering, each
method's own value/boolean handling applies unchanged — `.map("name")` plucks, `.filter("active")`
gets full JS truthiness via `jsBoolIfNeeded`, `.filter({role:"admin"})` compares with `$eq`.

Consolidation also fixed an inconsistency: `resolvePredicate`'s matches-object used to always
`$and`-wrap even a single key (`{$and:[{$eq}]}`); it now emits the arrow-equivalent bare `$eq`
for one key, `$and` for several — the same shape a hand-written arrow gives (one reject test
updated). The `_.matches` comparison is **flat `$eq`**, not lodash's deep partial match
(documented). Verified on a live mongod across `.map`/`.filter`/`.find`/`.some`/`.every`/
`.reject`/`.sumBy`/`.countBy` with property / matches / matchesProperty / truthy-property forms.
This is what was asked for at the start of the lodash work (the `_.identity` shorthand family),
now delivered uniformly. Spec: [`method-dispatch.md`](specs/method-dispatch.md).

## 2026-07-18 — feat: lodash `.sortBy` / `.orderBy` value aliases → `$sortArray`

Final family of the lodash value-mode push. The developer chose to add these lodash-named
aliases even though `.sort` / `.toSorted` already cover the capability (a deliberate,
approved exception to the usual anti-dual-spelling stance — they're value-mode only; the
stream `.sortBy`/`.orderBy` removed in efce89f stay removed):

    .sortBy(["field" | keyFn | [fields]])  → $sortArray ascending (reuses argToSortBy);
                                              0 args → natural ascending sort
    .orderBy(keys[, orders])               → $sortArray with parallel key/direction arrays
                                              (fewer orders than keys ⇒ the rest ascending)

`.sortBy` **rejects an object arg**: in lodash `sortBy(a, { age: -1 })` is a
matches-shorthand iteratee (sort by a boolean), NOT a direction — the error points at
`.orderBy(["field"], ["desc"])` / `.toSorted({ field: -1 })` so that footgun can't fire
silently. `orderByKeyNames` / `orderByDirs` normalise the two parallel-array args (each
accepts a scalar or an array; directions are `1`/`-1`/`"asc"`/`"desc"`). Verified on a live
mongod (single-key asc, multi-key mixed directions, defaulted directions).

This completes value-mode lodash Array + Collection coverage (everything doable bar
`shuffle`); the won't-implement decisions are recorded in DEFERRED §B.

## 2026-07-18 — feat: lodash random value methods — `.sample` / `.sampleSize` (`$rand`)

Fifth family — the only non-deterministic value methods (agreed with the developer; only
`shuffle` remains out):

    .sample()        → { $arrayElemAt: [a, { $floor: { $multiply: [{ $rand: {} }, { $size: a }] } }] }
    .sampleSize([n=1]) → decorate each element with a random key ({ k: $rand, v: item }),
                         $sortArray by k, $slice the first n, undecorate → n WITHOUT replacement

`.sample`/`.sampleSize` are value-mode siblings of the existing stream `.sample`/`.sampleSize`
(→ `$sample`); context dispatch keeps them apart (a plain array field vs a `$$`/`$$$` stream).
Deterministic to compile, random at runtime. `.sampleSize` rejects a negative literal and
returns the whole shuffled array when `n` exceeds the length. Verified on a live mongod
(varying single element; distinct-and-subset draws; `n > length` → full shuffle).

## 2026-07-18 — feat: lodash predicate-run value methods — `.takeWhile` / `.dropWhile` / `.takeRightWhile` / `.dropRightWhile`

Fourth family. Boundary-then-slice, no stateful `$reduce`:

    .takeWhile(pred) → find the first FALSY element (`$indexOfArray` of `false` on the
                       strict-boolified predicate array) → slice(0, boundary); -1 ⇒ whole
    .dropWhile(pred) → slice(boundary, end); -1 (all truthy) ⇒ []
    .takeRightWhile / .dropRightWhile → run the left-side scan on `$reverseArray(a)`, then
                       `$reverseArray` the result back (predicate is per-value, so order-safe)

Shared `takeDropWhile(arrExpr, pred, drop)` helper. Predicates use `resolvePredicate`, so
an arrow (`x => x < 3`) or a `_.matches` object (`{ ok: true }`) both work; the predicate
is strict-boolified with `{$cond:[cond,true,false]}` so `$indexOfArray` can find the first
`false` under MQL truthiness (consistent with `.filter`). All eight cases verified on a
live mongod (mid-array stop, all-truthy → whole/`[]`, from-the-end, matches-object).

## 2026-07-18 — feat: lodash transpose value methods — `.zip` / `.unzip` / `.zipWith`

Third family. `$map`-over-`$range` transposition:

    .zip(...arrays)          → [[a0,b0,…], …]   (groups run to the LONGEST; MongoDB pads a
                                                 short array's out-of-range slot with null,
                                                 matching lodash's undefined — verified)
    .zipWith(...arrays, fn)  → [fn(a0,b0,…), …]  (fn is an N-param arrow, one param per array;
                                                 params bound to the group's elements via $let)
    .unzip()                 → inverse of zip; column count = size of the first tuple
                                                 ($ifNull → [] guards an empty receiver)

`.zip`/`.zipWith` bind every operand array once in a `$let` (`jsmqlZip<k>`) and take the
max size across them for the `$range`. `.zipWith` validates the arrow's parameter count
equals the number of zipped arrays. `.unzipWith` is intentionally NOT added — its iteratee
receives a group whose arity equals the receiver's ROW count (runtime-dynamic), which a
fixed-parameter arrow can't express; it carries a tailored error pointing at
`.unzip().map(group => …)`, the idiomatic form. All shapes verified on a live mongod
(2- and 3-way zip, null padding, `zipWith` sum, `unzip` round-trip).

## 2026-07-18 — feat: lodash set-ops & `By`-iteratee value methods — `.without` / `.xor` / `.differenceBy` / `.unionBy` / …

Second family of the lodash value-mode push. Set-shaped array ops, all order-preserving
`$filter` / `$reduce` forms (never `$setDifference`, which reorders):

    .without(...values) → $filter excluding the variadic values
    .xor(other)         → uniq( A∖B ++ B∖A )  (chain .xor(c) for >2 arrays)
    .differenceBy(other, it)  / .intersectionBy(other, it)   → $filter by iteratee KEY membership
    .unionBy(other, it) → concat then keep-first dedupe by key
    .xorBy(other, it)   → symmetric difference by key
    .sortedUniq() / .sortedUniqBy(it) → aliases of .uniq / .uniqBy (MQL has no sorted-array fast path)

Factored `uniqByReduce(input, it)` (the keep-first-by-key `{seen,out}` reduce) out of the
existing `.uniqBy` so `.unionBy`/`.xorBy` reuse it, and `iterateeKeys(arr, it)` for the
`$in`-membership key arrays. `.xor`/`.xorBy` bind their operands once via `$let` (nested,
since `$let` vars can't reference their siblings) to avoid recomputing the receiver.
All six shapes verified on a live mongod (numeric symmetric difference, `differenceBy`/
`unionBy`/`xorBy` over objects keyed by `id`). Docs:
[`LANGUAGE.md`](LANGUAGE.md § lodash array methods).

## 2026-07-18 — feat: lodash positional / slicing value methods — `.take` / `.drop` / `.head` / `.last` / `.nth` / `.size` / …

First family of the broader "value-mode covers all sensible lodash Array + Collection
methods" push (scope agreed with the developer: everything doable except `shuffle`;
the won't-implement set is recorded in DEFERRED §B). Positional / slicing accessors on
an array field, all lowering to `$slice` / `$first` / `$last` / `$arrayElemAt`:

    .take([n=1]) → { $slice: [a, n] }              .takeRight([n=1]) → { $slice: [a, -n] }
    .drop([n=1]) → $slice from n (receiver $let-bound once, count = $size)
    .dropRight([n=1]) → $slice count = max(0, size-n)
    .head()/.first() → { $first: a }               .last() → { $last: a }
    .tail() → drop(1)                              .initial() → dropRight(1)
    .nth([n=0]) → { $arrayElemAt: [a, n] }         (negative index supported)
    .size() → array element count / object key count ($isArray-guarded on an unknown receiver)

`take`/`drop`/`takeRight`/`dropRight` reject a negative literal count, with a hint at the
opposite-end method (`take`↔`takeRight`, `drop`↔`dropRight`). Every shape verified on a
live mongod (16 cases: first/last/skip N, N past length, negative `nth`, object `size`).
Registry `METHODS` entries added for inference + `didYouMean`. Docs:
[`LANGUAGE.md`](LANGUAGE.md § lodash positional / slicing methods).

## 2026-07-18 — fix: a value-extracting `.map` *anywhere* in a `$$$.<coll>.filter(...)` chain lowers value-mode, not just when terminal

The terminal-`.map` peel (entry below) fixed only the *last* method. A value-extracting
`.map` **mid-chain**, followed by another registered stream method, still emitted the
invalid in-pipeline `$replaceWith`:

    $.r = $$$.orders.filter(o => o.userId === $._id).map("productIds").slice(0, 3);
    // was: $lookup.pipeline: [ $match, { $replaceWith: "$productIds" }, { $slice? no — } ]
    //      → { $replaceWith: "$productIds" } takes a non-document root; mongod rejects it (Location40228, verified)

Root cause: `.take`/`.slice`/`.sort`/`.groupBy`/… are registered stream methods, so a
chain of them kept `tryExtractChainedLookup` on the sub-pipeline path, where the
non-terminal `.map("field")` string shorthand lowers straight to `$replaceWith` with no
guard ([stream-methods.ts](../src/stream-methods.ts) MAP `lower`). (Chains whose tail
used a *non*-stream method — `.map("f").flatten().uniq()` — already worked, because
`flatten`/`uniq` aren't registered stream methods, so the chain always fell to the
expression form.) `isValueCollapsingMap` now detects a non-document map (`"field"`
string, or an expr-body arrow that isn't an object literal) in the sub-pipeline portion
and `tryExtractChainedLookup` **bails to the expression form** (`descendAndExtract`),
which lowers the whole tail value-mode over the result array — the same path the
`.flatten().uniq()` case already took. An **object-literal-body** map mid-chain still
stays in the sub-pipeline (its `$replaceWith` root is a valid document; a following
`.take` → `$limit` there). Verified on a live mongod: `.map("productIds").slice(0, 3)`
→ `[["a","b"],["b","c"]]`; `.map("productIds").flatten().uniq()` → `["a","b","c"]`.

Follow-on gap (not yet closed): a value-extracting map followed by a stream-only method
with **no** value-mode counterpart — `.map("f").take(5)` / `.drop(5)` — now errors
cleanly at compile time ("Unknown method '.take()'") instead of emitting invalid MQL,
because value-mode `.take`/`.drop` don't exist yet. Adding them (`$slice`) would let that
tail lower too. Spec:
[`lookup-stage.md`](specs/lookup-stage.md § Value-extracting `.map` → value-mode).

## 2026-07-18 — fix: a terminal `.map` on a `$$$.<coll>.filter(...)` chain lowers to `$set`+`$map`, not an in-pipeline `$replaceWith`

`$.userIds = $$$.orders.filter(o => o.uid === $.id).map("userId")` used to emit a
`{ $replaceWith: "$userId" }` **inside** the `$lookup.pipeline` — invalid MQL when
`userId` is a scalar (mongod rejects a non-document `$replaceWith` root; verified:
Location40228 "'replacement document' must evaluate to an object"). It now lowers to
the shape the user asked for: the sub-pipeline is just the `.filter`'s `$match`, and
the terminal `.map` runs as a value-mode `$map` over the lookup result array in the
`$set`:

    { $lookup: { …, pipeline: [ { $match: … } ], as: "__jsmql.tmp.1" } },
    { $set: { userIds: { $map: { input: "$__jsmql.tmp.1", in: "$$…​.userId" } } } }

Implemented in `tryExtractChainedLookup` (lookup-translation.ts): `peelableTerminalMap`
detects a value-extracting terminal `.map` (a `"field"` string — synthesized to
`el => el.field` — or an expression-body arrow), the sub-pipeline chain loop stops
before it (`chainEnd`), and the returned `rewritten` becomes `<slot>.map(iteratee)`
so codegen emits the value-mode `$map`. Non-terminal chain methods (`.toSorted`/
`.slice`/…) still build the sub-pipeline, and object maps peel the same way (they'd
work in-pipeline, but the value-mode form is consistent and correct). A block-body
terminal `.map` stays in the sub-pipeline (unchanged). One change covers both the
field-assignment and `const`/`let`-binding forms (shared `rewritten`). Verified on a
live mongod (scalar extraction, mixed chains, object maps). The separate `$$ = …`
replace-stream pivot (`lowerLookupPivot`) has the same latent bug but different
semantics ($unwind into the stream) — left for a follow-up. Spec:
[`lookup-stage.md`](specs/lookup-stage.md § Terminal-`.map` peel).

## 2026-07-18 — feat: lodash object methods (Phase 1) — `.mapValues` / `.pick` / `.omit` / `.invert` / …

Per-doc object value methods, completing the Phase 1 value vocabulary:
`.mapValues`, `.mapKeys`, `.pick`, `.omit`, `.pickBy`, `.omitBy`, `.invert`,
`.toPairs`, `.fromPairs`. Built over `$objectToArray` → transform → `$arrayToObject`
(`toPairs` stops at the array; `fromPairs` runs the other way on a `[[k,v]]`
receiver). The `(value[, key])` iteratee (`resolveObjIteratee`) binds the arrow's
1–2 params to `$$jsmqlKv.v`/`.k` via `$let`. `pick` field-selects with `$getField`
so a missing key drops out (lodash parity, verified); `mapKeys`/`invert` stringify
the produced key. Every shape verified on a live mongod (`pick(["a","c"])` on
`{a:1,b:2}` → `{a:1}`, `mapValues`, `invert`, `fromPairs`, …). Spec:
[`method-dispatch.md`](specs/method-dispatch.md).

## 2026-07-18 — feat: lodash array methods (Phase 1) — `.groupBy` / `.keyBy` / `.uniq` / `.chunk` / `.partition` / …

Per-doc array value methods: `.sum`/`.mean`/`.max`/`.min` (→ `$sum`/`$avg`/`$max`/
`$min`), `.sumBy`/`.meanBy`/`.minBy`/`.maxBy`, `.uniq`/`.uniqBy`, `.keyBy`/
`.groupBy`/`.countBy`, `.partition`/`.reject`, `.chunk`, `.flatten`, `.compact`,
`.difference`/`.intersection`/`.union` (order-preserving `$filter`/dedupe on a
plain array receiver — the Set-typed receivers still route to `generateSetMethodCall`),
`.zipObject`. Two shared resolvers in codegen.ts: `resolveIteratee` (a field-name
string, a 1-arg arrow, or omitted-identity → `$map`/`$filter` element binding) and
`resolvePredicate` (arrow or `_.matches` object → `$and` of `$eq`).

Semantics chosen for faithfulness: `uniq` is order-preserving keep-first (not
`$setUnion`, which reorders); `minBy`/`maxBy` decorate-sort-undecorate to return the
element; `groupBy`/`keyBy`/`countBy` stringify keys like lodash (documented
`$toString` hazard on non-scalar keys); `compact` uses MQL truthiness (drops
`false`/`null`/`0`/missing, keeps `""`/`NaN` — the earlier project call). `.max`/
`.min`/`.difference`/… don't collide with `generateMathCall`/`generateSetMethodCall`
(those are separate node types / receiver intercepts). Every shape verified on a live
mongod. Spec: [`method-dispatch.md`](specs/method-dispatch.md).

## 2026-07-18 — feat: lodash string methods (Phase 1, ASCII-only) — `.capitalize` / `.camelCase` / `.kebabCase` / …

Per-doc string value methods: `.capitalize`, `.upperFirst`, `.lowerFirst`,
`.words`, `.camelCase`, `.kebabCase`, `.snakeCase`, `.startCase`, `.escape`,
`.truncate`. Built from shared expression helpers (`capitalizeExpr`, `wordsExpr`,
`joinWords`, `escapeHtmlExpr` in codegen.ts): `$toUpper`/`$toLower` + `$substrCP`
for the case ops, `$regexFindAll` with the ASCII word pattern
`[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[A-Z]|[0-9]+` (lodash's non-Unicode words regex —
the negative lookahead is accepted by `$regexFindAll`, verified) for
words/case-conversions, nested `$replaceAll` for `escape`, and a `$strLenCP`
`$cond` for `truncate`.

ASCII-only per the project decision: accented text passes through `$toUpper`/
`$toLower` unchanged and is treated as word separators. `deburr` is omitted (a
no-op without Unicode); `truncate`'s word-boundary `separator` option is rejected
(no back-search in MQL). `.repeat` already existed (unchanged). Verified on a
live mongod (`fooBarBaz` → `foo-bar-baz`, `camelCase("Foo bar-baz")` →
`fooBarBaz`, `escape`, `truncate`, …). Spec: [`method-dispatch.md`](specs/method-dispatch.md).

## 2026-07-18 — feat: lodash number methods (Phase 1) — `.clamp` / `.inRange` / `.round` / `.ceil` / `.floor`

First slice of the per-doc (value-mode) lodash vocabulary — number methods on a
field, distinct from the stream methods. `$.n.clamp(lo, hi)` → `$min`/`$max`;
`.inRange([start,] end)` → `$and` of `$gte`/`$lt` with the bounds run through
`$min`/`$max` so negative ranges swap like lodash; `.round([p])` → `$round`;
`.ceil([p])` / `.floor([p])` → `$ceil`/`$floor`, scaling by `$pow(10, p)` for a
precision argument. New `case`s in `generateMethodCall` + `METHODS` entries
(`inRange` returns bool). `round` maps to MongoDB's `$round` (half-to-even),
which diverges from lodash's half-away-from-zero — kept per the earlier decision
to emit the native operator, documented as a surprise. Verified on a live mongod
(clamp→100, inRange true/false, round(2.5)→2, ceil/floor precision). Spec:
[`method-dispatch.md`](specs/method-dispatch.md).

## 2026-07-18 — feat!: consolidate stream/array sort onto `.sort` / `.toSorted`; drop `.toReversedBy` / `.sortBy` / `.orderBy`

`.sort(<sort>)` and `.toSorted(<sort>)` now accept a flexible sort argument on
both the document **stream** (`$$`) and an **array value** (`$.field`): a field
name (`"createdAt"` → ascending), an array of field names (all ascending), a
`{ field: 1 | -1 | "asc" | "desc" }` spec, or the existing comparator / key-fn
arrow. On a stream `.sort` and `.toSorted` are equivalent (nothing to mutate —
both emit one `$sort`); on an array value `.sort` mutates at statement position
and `.toSorted` returns a new array (`$sortArray`), as before.

Removed three stream methods added earlier the same day: `.toReversedBy("field")`
(a coinage that read as nonsense — a descending sort is just
`.sort({ field: -1 })`), and the lodash `.sortBy` / `.orderBy`, which were exact
dual spellings of the new `.sort` forms (the no-dual-spelling rule wins over
"lodash everywhere"). The stream unknown-method error already points typos at
`.sort`. Shared helpers: `buildStreamSortSpec` + `buildKeySortSpec` +
`sortDirection` (stream-methods.ts), `argToSortBy` + `sortDirLiteral`
(codegen.ts); `sortDirection`/`sortDirLiteral` accept `"asc"`/`"desc"` as well as
`1`/`-1`. Verified on a live mongod (stream `$sort` direction, array `$sortArray`
ordering). This is pre-1.0 churn on an uncommitted-days-old surface, hence the
`feat!` marker without a version bump.

## 2026-07-18 — fix: stream `.map(d => …)` rejects a provably non-document body

`$$ = $$.map(d => 5)` (and `d => "x"` / `d => true` / `d => [1, 2]`, or the property
shorthand `.map("scalarField")`) lowered to `{ $replaceWith: 5 }` — MQL the server
rejects on **every** deployment ("'replacement document' must evaluate to an object";
verified against mongod for a number, string, ObjectId, and array). The sibling
`$ = 5` was already rejected at compile time via `rejectNonDocumentReplaceRoot`
(pipeline.ts), but the stream `.map` path skipped that gate — an HR3 hole and an
asymmetry. Added `rejectNonDocumentMapBody` (stream-methods.ts), literal-gated the
same way, on the top-level and correlated-lookup expression paths (the block-body
paths already route through the shared `$ = <expr>` guard). It rejects only a
**provably** non-document body; a field ref / member access / `$`-string is
data-dependent (the field could be a sub-document) and still passes, so
`.map("userId")` / `.map(d => d.userId)` emit `$replaceWith: "$userId"` and error at
runtime only when the field is actually scalar — identical to `$ = $.userId`.

*Why surfaced:* a unit test asserted `$$.map("userId")` → `{ $replaceWith: "$userId" }`
as if valid, but `userId` is conventionally an ObjectId, so the emitted MQL fails at
runtime — a `toEqual` endorsing a server-rejected shape. The test now uses a
sub-document field (a shape mongod accepts) and documents the "body must be a
document" rule; the provably-scalar cases became the new rejection tests. Spec:
[`stream-methods.md`](specs/stream-methods.md) § "`.map` body must be a document".

## 2026-07-18 — feat: lodash-named stream methods (Phase 2) → aggregation stages

The `$$` / `$$$.<coll>` stream vocabulary gained a batch of lodash-named chain
methods, so a stream reads like a lodash chain (no `_` token — every collection
is treated as *already* wrapped). New `StreamMethodDef`s in
[`src/stream-methods.ts`](../src/stream-methods.ts): `.take(n)` → `$limit`,
`.drop(n)` → `$skip`, `.sampleSize(n)` → `$sample`, `.sample()` → `$sample: {
size: 1 }` (lodash `_.sample`), `.toReversedBy("f")` →
descending `$sort`, `.sortBy(key | [keys] | { f: 1|-1 })` / `.orderBy(keys,
orders)` → `$sort`, `.groupBy(spec | "key")` → `$group`, `.countBy("f")` →
`$sortByCount`, `.uniqBy("f")` → `$group`+`$replaceWith`. Two edge cases follow
lodash faithfully without emitting invalid MQL: `take(0)` → always-false `$match`
(not `$limit: 0`), `drop(0)` → no stage.

`.groupBy` takes **both** a bare key (`"dept"` → `{ _id: "$dept" }`, group by that
field with no accumulators) and a raw `$group` body (`{ _id: null, ids:
$addToSet("$p") }`, lowered verbatim — non-`_id` slots generate in
`accumulatorContext: "group"` so accumulator-only ops pass the codegen gate,
matching the direct `$group(...)` stage). Value-mode `$.arr.groupBy(...)`
(Phase 1, separate) returns an object; stream-mode returns a stream of group docs.

Lodash **iteratee shorthands** were added where they fit: `.map("field")` →
`$replaceWith: "$field"`, `.flatMap("field")` → `$unwind`, and `.filter({ f: v })`
→ an equality `$match` query. `.filter` also now works **mid-chain**
(`applyStreamMethods` in [`pipeline.ts`](../src/pipeline.ts) handles it at any
position, not only the head) so `.flatMap(...).filter(...)` composes. The
generated `@koresar/jsmql/ops` completion types
([`generate-ops.mjs`](../scripts/generate-ops.mjs) `STREAM_METHOD_SIGNATURES`)
cover every new member.

*Why:* jsmql's audience knows lodash cold; these are the aggregation-shaped ops
native JS has no clean spelling for. Every shape was verified on a live mongod
(HR3) — including the flagship recommendation-engine pipeline
`$$.filter({...}).toReversedBy(...).take(...).flatMap(...).groupBy({...})`.
Not yet covered: the same methods *mid-chain inside a correlated `$$$.<coll>`
`$lookup` sub-pipeline*, and cross-statement state threading — a follow-up.
Spec: [`stream-methods.md`](specs/stream-methods.md).

## 2026-07-17 — fix: date methods reject a literal non-date receiver (parity with the operator form)

The date methods (`.getFullYear()`, `.getMonth()`, …, `.toISOString()`, and the
new `.plus()` / `.minus()`) now type-check their receiver: a literal non-date
like `"2020-01-01".getFullYear()` is rejected at compile time with the same
message the operator form gives (`'.getFullYear' expects a date, but got a
string. Use a field path or new Date(…).`), instead of silently emitting
`{ $year: "2020-01-01" }` — MQL the server rejects at runtime (verified: mongod
`Location16006`). Implemented declaratively: `MethodMeta` gained a
`receiver?: "date"` field, set on every date method whose target operator
declares `singleType: "date"` (or a `date`-typed key), and `generateMethodCall`
runs the shared `checkArgType(…, "date")` before dispatch. Literal-gated as
always — a field ref / `new Date(…)` / param no-ops, and the HR1 `"$ts"`
field-ref string passes through.

`.getTime()` is deliberately **excluded** (the one date method without
`receiver: "date"`): it lowers to `$toLong`, which converts numeric
strings/numbers, so `"2020".getTime()` → `{ $toLong: "2020" }` is valid MQL the
server accepts (verified) — rejecting it would violate the literal-gating
invariant (reject only shapes invalid on *every* deployment).

*Why:* closes the method-vs-operator asymmetry surfaced while implementing
`.plus`/`.minus` — the operator forms already gated their date args, but the
method spellings didn't, so identical mistakes errored in one spelling and
silently produced bad MQL in the other. Applying it uniformly (rather than only
to the new `.plus`/`.minus`) avoids minting a fresh inconsistency. Spec:
[`method-dispatch.md`](specs/method-dispatch.md).

## 2026-07-17 — feat: `.plus` / `.minus` date arithmetic → `$dateAdd` / `$dateSubtract`

Date values gained arithmetic methods: `$.d.plus(amount, unit)` lowers to
`{ $dateAdd: { startDate, unit, amount } }` and `.minus(...)` to
`$dateSubtract`, with an optional third `timezone` argument threaded to the
operator's `timezone` field. The receiver is the `startDate`; `amount` comes
first, `unit` second. Arg count (2 or 3) is validated via `checkArity`, and the
literal slots are gated to the same shapes the `$dateAdd`/`$dateSubtract`
operator path rejects — reusing its own helpers so both spellings error
identically: `checkEnum` against the shared `TIME_UNIT` enum for `unit` (so
`.plus(30, "days")` → *"Did you mean 'day'?"*), and `checkArgType` for `amount`
(`int-or-long`, so `.plus(1.5, "day")` is rejected) and `timezone` (`string`).
All are literal-gated — a field-path/param in any slot passes through. The
`startDate` receiver is left unchecked, matching the other date methods.
Implementation is a
single `case "plus"/"minus"` in `generateMethodCall` plus two `METHODS`
entries ([`src/codegen.ts`](../src/codegen.ts)); `TIME_UNIT` and `checkArgType`
were promoted to `export`s from
[`src/operator-validation.ts`](../src/operator-validation.ts) so the method
path and the `$op` path share one enum and one literal-type checker (no second
copy). Verified on
a live `mongod` (`2020-01-31.plus(30,"day")` → `2020-03-01`, `.minus(1,"month")`
→ `2019-12-31`, tz + dynamic-amount forms).

*Why:* date math was the biggest gap in the JS-API surface — `new Date`,
`Date.now`, and the `.getX()` getters shipped, but there was no way to shift a
date. Temporal/Luxon/Moment all spell this as `.plus`/`.minus` (or `.add`), so
the name reuses vocabulary developers already know; neither is a real
`Date.prototype` method, so there is no JS collision. This maps to real
MongoDB operators (no minted `$foo`) and is the first item shipped from the
"JS API vocabulary we expand" exploration. Spec:
[`method-dispatch.md`](specs/method-dispatch.md); reference:
[`LANGUAGE.md`](LANGUAGE.md).

## 2026-07-17 — feat: `Date.prototype.getUTC*` getters → UTC-anchored date-part operators

Added the eight `getUTC*` component getters (`getUTCFullYear`, `getUTCMonth`,
`getUTCDate`, `getUTCDay`, `getUTCHours`, `getUTCMinutes`, `getUTCSeconds`,
`getUTCMilliseconds`) as the UTC-reading siblings of the local getters that
already shipped. Each lowers to the *same* MongoDB date-part operator as its
local counterpart, but passes the object form `{ date, timezone: "UTC" }` instead
of the bare date — so the extraction is anchored to UTC rather than the server
process's zone, mirroring JavaScript's own `getHours()` (local) vs
`getUTCHours()` (UTC) split. The 0-based shims carry over unchanged
(`getUTCMonth` subtracts 1 from `$month`; `getUTCDay` subtracts 1 from
`$dayOfWeek`, Sunday=0). This finishes a parallel codepath: a developer who
learned `.getMonth()` works would previously hit "Unknown method" on
`.getUTCMonth()`, which is a DX cliff.

Deliberately **not** added: `getUTCTime` (JS has no such method — `getTime()` is
already UTC epoch milliseconds) and `getTimezoneOffset` (MongoDB has no ambient
"local" zone to offset from; left as a plain unknown-method for now rather than
introducing a `won't-implement` rejection without the maintainer's sign-off).
Implementation mirrors the local getters exactly via a small `utcDate()` helper in
[src/codegen.ts](src/codegen.ts); registry entries in the same `METHODS` table auto-feed the
`didYouMean` suggestion list. Emitted shapes were verified against a live `mongod`
(all eight return the JS-correct values for a known instant). See
[docs/LANGUAGE.md](docs/LANGUAGE.md) and [docs/specs/method-dispatch.md](docs/specs/method-dispatch.md).

## 2026-07-10 — feat: `$$$.<coll>.aggregate(pipeline)` — full sub-pipeline joins (SR3)

Shipped the `.aggregate()` convenience API from [SR3](LANG_RULES.md) (jsmql invents
brevity APIs for constructs JS has no spelling for — nested pipelines above all —
borrowing a name developers know, here the driver's own `db.coll.aggregate`).
`$$$.<coll>.aggregate(<pipeline>)` runs an arbitrary sub-pipeline (`$group`,
`$bucket`, `$sort`+`$limit` top-N, window stages, multi-stage reshapes) against a
foreign collection and lowers to `$lookup` — the shapes `.find`/`.filter`'s
per-element predicate can't express. Verified end-to-end against a live MongoDB
(uncorrelated, correlated `let`+`$expr`, source-switch `$unionWith`, chained
`.length`).

**Surface.** Two argument forms — a block-body arrow `(o) => { $stage(...); ... }`
(statements are stages, no `return`) and a stage-array literal `[{ ... }, ...]`,
normalised to one block lambda by `aggregateArgToLambda`. The `(element, index,
collection)` param triplet mirrors `.filter`/`.map` (the developer's call — a named
`o.createdAt` reads far clearer than a bare `"$createdAt"`): `o.<field>` = foreign,
`$.<field>` = the outer doc auto-hoisted into `$lookup.let` via the **existing**
`jsmql_*` correlation system (no new outer-doc sigil). Two positions: a **head**
(`$$$.<coll>.aggregate(...)`, a `detectLookupCall` method alongside find/filter) and
a **chain** after `.filter` (`$$$.<coll>.filter(pred).aggregate(...)`, a registered
stream-method modelled on `.map` minus the terminal `return`). Both reuse the
block-body `.filter` engine (`buildBlockBodyPredicate` / `lowerCallbackBlock`), so
`translatePredicate` needed no aggregate branch. `$$ = $$$.<coll>.aggregate(...)`
(source-switch) composes for free via the stream-method registry. Uncorrelated
lowerings omit the empty `let`.

**Rejections (all actionable).** `$$.aggregate(...)` on the current stream (redundant
— write the stages directly); `$ = $$$.<coll>.aggregate(...)` replace-root (result is
an array, not a document); expression-body arrow; a trailing `return` (that's `.map`'s
reshape terminal, not a stage — silently dropping it would lose intent); `.aggregate()`
chained on a `.find()` result (scalar, not a collection); used index param / non-`.length`
use of the 3rd param; empty pipeline; cross-DB `$$$$.<db>.<coll>.aggregate`;
Filter/`jsmql.expr`/`jsmql.update` modes. `$$.push(...)` / `.concat(...)` union of an
aggregate result is deferred — `$unionWith` has no `let` slot to correlate — see DEF-034.

A 5-lens adversarial review (correctness / HR3 / DX / doc-drift / test-gaps, each finding
verified by a skeptic) shaped the final surface — the `return`-drop, `.find().aggregate()`,
and `coll.length`-in-source-switch (parity with `.map`) fixes above all came from it. It
also surfaced pre-existing, cross-cutting limitations left for a separate change (not
introduced here): `$$.length` inside a block-body top-level `$lookup` reports the foreign
sub-stream count rather than the root count (also in `.filter`/`.map` blocks; narrows
DEF-033's "block body supported" claim), and the block-param index/collection check
(`buildBlockBodyPredicate` / `validateAggregateParams`) matches by name and so
false-rejects a nested lambda param that shadows the index/collection name.

Code: `src/parser.ts` (`STREAM_BLOCK_METHODS` += `aggregate`), `src/lookup-translation.ts`
(`detectLookupCall` + `aggregateArgToLambda` + `validateAggregateArg`/`validateAggregateParams`
+ empty-`let` omission in `lowerLookup`), `src/stream-methods.ts` (`AGGREGATE` def +
registry), `src/pipeline.ts` (`applyStreamMethods` guard + `lowerReplaceRoot` array
reject), `src/union-translation.ts` (`aggregateInUnionError` `[DEF-034]`), `src/index.ts`
(mode-gate wording). Spec: [docs/specs/lookup-stage.md](specs/lookup-stage.md) §
`.aggregate`; user-facing: [docs/LANGUAGE.md → Cross-collection lookups](LANGUAGE.md#cross-collection-lookups-coll-find--filter).

## 2026-07-04 — feat!: arrow entry form is now `({ $ }) => …` (toolbox destructure), old `($) =>` removed

The function-entry arrow shape changed: the bare document parameter `$` is gone,
replaced by a single destructured **toolbox** object. `($) => …` becomes
`({ $ }) => …`; the parameterised compile form `({ email }, $, { $match }) => …`
collapses from three positional slots to two — `({ email }, { $, $match }) => …`
— with `$` merged into the ops destructure (which now also accepts the bare `$`
and the context refs `$$` / `$$$` / `$$$$` as keys). The old spellings
(`($) =>`, `(doc) =>`, `(params, $, ops) =>`, `($, { $op }) =>`, and their
`function` counterparts) are **rejected** at parse time — a bare identifier or
bare `$` is no longer a valid parameter slot. Pre-1.0, no users: removed
outright rather than dual-supported, no migration path.

*Why:* one destructured bag reads as "here's your toolbox — take what you need",
and it kills the positional awkwardness of `(params, $, { $match })` where `$`
was wedged between two destructures. Emitted MQL is byte-identical — only the
input spelling changed. Runtime change is confined to `parseParameterList` /
`parseParameterSlot` / `parseDestructureSlot` in [`src/parser.ts`](../src/parser.ts)
(reject bare-ident/bare-`$` slots; accept `$`/`$$`/`$$$`/`$$$$` as toolbox keys;
2-slot `(params, toolbox)` rule); the params-vs-toolbox "no mixed keys in one
destructure" rule is unchanged. Types live entirely in
[`src/index.ts`](../src/index.ts): `JsmqlFn` / `JsmqlCompileFn` now take a
`JsmqlToolbox` (`{ [K in \`$${string}\`]: any }`) — the ambient
`@koresar/jsmql/ops` globals (unchanged) remain the source of rich signatures, so
listing ops in the toolbox stays optional. Spec: [`function-form-params.md`](specs/function-form-params.md).

## 2026-07-04 — docs: give SR3 a body in LANG_RULES.md (jsmql's own convenience APIs)

[docs/LANG_RULES.md](LANG_RULES.md)'s `## SOFT RULES` section ended on a bodyless
stub (`SR3 — jsmql also adds some APIs of its own for brevity and better DX.`).
Gave it a body, completing the trio started by the
[SR1 + SR2 entry](DEVLOG.md#2026-06-27--docs-complete-the-soft-rules-section-of-lang_rulesmd-sr1-body--sr2).
Where SR2 governs *native* JavaScript APIs (lower to their JS behaviour), SR3
governs the ones jsmql **invents** — for constructs JS has no natural spelling
for, nested pipelines above all (the motivating case for a driver-style
`.aggregate()` on a `$$` stream).

The body codifies three constraints so the invented surface stays DX-friendly and
non-ambiguous: (1) reach for an invented API only where JS has no spelling, rather
than leaving the user in the `$op(…)` escape hatch; (2) borrow a name the developer
already recognises — a MongoDB driver method (`.aggregate()`, `.count()`) or a
widely-known JS date idiom (`.plus` / `.minus` / `.diff`, à la Temporal/Luxon) —
and **never mint a new `$foo()`**, which keeps HR4 and the "every `$op` is a real
MongoDB op" model intact; (3) each lowers to a real MQL operator or stage that
stays reachable by hand, so the sugar is always additive. This is a SOFT rule
because it states design intent for a surface still being built — the examples
(`.aggregate` / `$$.count` / `Date.prototype.plus`/`.minus`/`.diff` / `Date.parse`
with a format) are illustrative proposals, not yet-shipped features, so their
comments name the target operator (`→ $dateAdd`) rather than assert emitted MQL.

## 2026-07-04 — chore: add `verify-mql` and `devlog` Claude Code skills

Added two project-level Claude Code skills under [.claude/skills/](../.claude/skills):
`verify-mql` and `devlog`. Each turns a workflow this repo already mandates in
prose into one the agent reliably *applies* — `verify-mql` encodes the HR3 "run
the emitted MQL against a real `mongod` before trusting it" ritual (pipe the
`jsmql` CLI into [test/probe](../test/probe), or use the MongoDB MCP), and
`devlog` encodes this file's entry format plus the
[scripts/merge-devlog.mjs](../scripts/merge-devlog.mjs) conflict resolver. A
described convention and an *applied* one are not the same thing; skills close
that gap.

Wired one-line pointers into the sections that already own each convention — the
"Verify MQL against a running MongoDB" section and the DEVLOG bullet of the root
[CLAUDE.md](../CLAUDE.md), the `test/probe` how-to in
[test/CLAUDE.md](../test/CLAUDE.md), and the DEVLOG note in
[docs/CLAUDE.md](CLAUDE.md) — per the single-source-of-truth rule (link, don't
restate). The skill files live under `.claude/`, which the deferred-coverage
drift test skips, so they don't touch the DEF gates. No library behaviour changed.

## 2026-06-28 — fix: surface `assert()` in the generated `@koresar/jsmql/ops` types

`assert(condition[, message])` shipped as a recognised pipeline-statement guard
but was never declared in `src/ops.ts`, so arrow-form code that imported
`@koresar/jsmql/ops` (`($) => { assert($.qty >= 0, "…"); … }`) tripped
`noImplicitAny` / "cannot find name 'assert'" under a strict tsconfig. Added a
`statementFormsBlock()` to [`scripts/generate-ops.mjs`](../scripts/generate-ops.mjs)
that emits `function assert(condition: any, message?: any): void` in a new
"Statement-form built-ins" section, mirroring how `ObjectId` is hand-declared
(neither lives in the `OPERATORS`/`STAGES` registries). Typed `void` because
`assert` is statement-only and has no value — using it in expression position is
a compile error in jsmql too, so the type now matches the language. Regenerated
`src/ops.ts`; the drift test keeps the two in lockstep.

## 2026-06-27 — docs: complete the SOFT RULES section of LANG_RULES.md (SR1 body + SR2)

[docs/LANG_RULES.md](LANG_RULES.md)'s `## SOFT RULES` section held a single
bodyless stub (`SR1 — jsmql is trying to guess what you mean.`). Gave SR1 a body
and added **SR2 — a native JavaScript API behaves as its JavaScript self**,
codifying a principle that was already true but unwritten: where jsmql accepts a
JavaScript built-in method/static (`.map`, `.trim`, `Math.max`, …) it lowers to
MQL that reproduces the JS behaviour and never repurposes the name. It is a SOFT
rule, not a HARD one, because fidelity is best-effort — where MQL can't reproduce
JS semantics exactly (null / missing-field handling), the divergence is
documented rather than hidden.

Deliberately scoped to **named** APIs only, not language operators: `+` / `==` /
`===` already diverge from JS (string `+` concatenates in JS but lowers to
`$add`), so promising operator fidelity would make the rule false on day one. The
rule also notes — without saying where — that jsmql adds APIs of its own for
brevity; the "where" is left out on purpose so the rule stays about behaviour,
not surface. No code change: SR2 describes existing behaviour, so README and
LANGUAGE.md need no update.

---

## 2026-06-27 — docs: future-proof-prose rule (no current-state enumerations) + de-list SR2

Added a sub-rule to the "Single source of truth" section of [CLAUDE.md](../CLAUDE.md):
restating the *current membership of an evolving set* (an inline list of
methods/operators/stages, a count, a "currently supports …", a version/status
snapshot) is the same drift as copying a paragraph, and rots faster. Prose must
state the stable rule and point at the registry/code SSOT for the live list; one
illustrative example stays fine, an enumeration-as-membership does not;
counts/versions/status stay out of prose (the asserting test and
`docs/DEFERRED.md` own them).

Applied it to [docs/LANG_RULES.md](LANG_RULES.md): SR2 had named a concrete
method/static list (`.map`, `.filter`, `.trim`, `.slice`, `Math.max`,
`Number.isInteger`) that duplicated the `METHODS` / `MATH_METHODS` registries and
would go stale as they grow. Reworded down to the bare principle — native JS APIs
behave as their JS selves, best-effort with documented divergences — dropping the
method/static enumeration, the operator carve-out (`+` / `==` / `===`), and the
inline divergence example from the prose; the example block still carries the
illustration. "API" already implies named methods/statics, not operators.
Motivated by a recurring stale-prose problem the developer flagged. The trailing
"jsmql adds APIs of its own" clause was also promoted out of SR2 into its own
**SR3 — jsmql also adds some APIs of its own for brevity and better DX.**

---

## 2026-06-27 — docs: showcase "snapshot one user → 5 newest orders" now asserts uniqueness + same-DB pivot

The headline example (README, LANGUAGE.md "narrow, guard, pivot", and the
`realistic.test.ts` describe of the same name — the one the playground surfaces)
was reworked: instead of `.filter(...).slice(0, 1)` + a `let userId = $._id`
snapshot, it now `assert($$.length === 1, …)` (an explicit uniqueness guard) and
correlates the pivot directly on `o.userId === $._id`. It also switches the
source from cross-DB `$$$$.archive.orders` to same-DB `$$$.orders`: MongoDB
rejects cross-DB `$lookup` for regular collections ("$lookup with syntax
{from: {db, coll}} is not supported"), so the old example never actually ran —
verified on a live mongod, the same-DB form does (returns the 5 newest orders;
the assert aborts the run on a duplicate email). The emitted MQL shown in the
docs was also stale (un-depth-stamped `let: { userId }` + a spurious trailing
`$unset`); both now match the compiler — `jsmql_f0__id` correlation var, and no
`$unset` because the final `$replaceWith` drops the whole `__jsmql` namespace.
No `src/` change — example / docs / test only.

---

## 2026-06-27 — fix!: stop lowering cross-database READS (`$$$$.<db>.<coll>` joins/unions) — reject at compile time

Cross-database **reads** are no longer lowered — they're rejected at compile time. The
forms removed: `$$$$.<db>.<coll>.find/filter(...)` (cross-db `$lookup`), the replace-root
`$ = $$$$.<db>.<coll>.find(...)`, the source-switch `$$ = $$$$.<db>.<coll>.filter(...)`, and
the union `$$.push(...$$$$.<db>.<coll>...)`. All of them could only compile to a `$lookup` /
`$unionWith` with a `from`/`coll` = `{ db, coll }` **namespace object**, which is the Atlas
Data Federation form — a standalone / replica-set / sharded MongoDB **rejects** it at runtime
(verified on a live mongod: `$lookup` → "not supported"; `$unionWith.coll` → "wrong type
'object', expected 'string'"). jsmql was knowingly emitting un-runnable MQL (HR3 violation),
so the surface is withdrawn.

**Mechanism — one choke point.** New `requireSameDbColl(db, collection, pos)` in
[`src/lookup-translation.ts`](../src/lookup-translation.ts): same-database (`db === undefined`,
i.e. `$$$.<coll>`) returns the bare collection string; cross-database (`db` set) **throws** a
`CodegenError` (matches `/Cross-database reads aren't supported/`) that redirects to a
same-database `$$$.<coll>` reference. Every read-side `from`/`coll` builder funnels through it —
`lowerLookup`, `tryExtractChainedLookup`, the replace-root + source-switch + lookup-pivot
builders in `pipeline.ts`, and the `$$.push` builders in `union-translation.ts` — so `from`
simplifies to always-`string`. The bare-`$$$$.<db>.<coll>` codegen message was updated to stop
advertising cross-db `$lookup` as valid.

**Kept (verified working on mongod):** cross-database **WRITES** — `$$$$.<db>.<coll> = $$` →
`{ $out: { db, coll } }` (its own builder in `out-translation.ts`, untouched); same-database
(`$$$.<coll>`) reads; and the `$$$$` server/cluster diagnostic stages (`$$$$.currentOp()`, …).

Behaviour change (a `fix!` — pre-1.0, no version bump). Tests: the cross-database output
assertions across lookup/union/pipeline/stream-methods were replaced with rejection tests —
one per distinct `requireSameDbColl` call site (seven: lookup field-assign, chained terminal,
replace-root, flat source-switch, correlated pivot, bare union, `.filter`-spread union), plus
the bare-`$$$$.<db>.<coll>` message (codegen). Each call site is tested so a refactor that
bypasses the guard on any one path is caught; pure syntax variations that reach the *same* call
site (dot vs bracket access, `.find` vs `.filter`, a trailing `.slice`/chain method) aren't
re-tested (suite 2427 → 2405, all green). Docs: [LANGUAGE.md](LANGUAGE.md) § "Cross-database reads: not
supported", [lookup-stage.md](specs/lookup-stage.md) § "Cross-database reads are rejected",
[union-stage.md](specs/union-stage.md), [context-references.md](specs/context-references.md),
[replace-stream-stage.md](specs/replace-stream-stage.md), README, and the generated `ops.ts`
`$$$$` description. (No DEFERRED §B entry, per the developer.)

---

## 2026-06-23 — docs: record the MongoDB MCP plugin as a known dev aid in CLAUDE.md

Added a `### The MongoDB MCP plugin (plugin:mongodb:mongodb)` subsection under
*#0 priority: the language axioms* in [CLAUDE.md](../CLAUDE.md), right after the
HR3 "Verify MQL against a running MongoDB" section, because the plugin's value
to this repo is exactly those two existing jobs: (1) `search-knowledge` as a
*reference cross-check* against MongoDB's version-pinned manual when
adding/auditing operators — explicitly *secondary* to the `vendor/mql-specifications`
YAML SSOT and to `mongod` as the validity authority, so the note can't be read
as relocating either source of truth; (2) `aggregate`/`find`/`explain` against a
connected `mongod` as a faster path for HR3 verification than a one-off
`tmp/probe.mjs` driver script (same `$addFields`-not-`$project` caveat).

Documented the connection boundary: data tools need a developer-provided
connection string and are not connected by default (`search-knowledge` needs
none); never invent a connection string. Framed the plugin as a convenience
layer, not a dependency — every workflow it supports keeps its driver-/CLI-based
fallback, so nothing breaks when the plugin is absent.

---

## 2026-06-21 — feat: actionable error when outer context is read inside a `$$ = $$$.<coll>` source-switch

A bare `$$ = $$$.<coll>.map(…)` (no correlating filter) is a `$unionWith` that
*replaces* the stream, so the outer document (`$.<field>`), the root `$$.length`,
and outer `let`/`const`s aren't carried in. Reading any of them inside the
switched-in chain body used to fail with a bare `Unknown identifier 'k'` (for an
outer `let`) or the generic "use the lambda parameter" hint (for `$.<field>`) —
neither explained *why* or pointed at the fix. Now both name the source-switch
and redirect to the correlated `.filter` form:

- outer `let`: ``\`k\` is a `let`/`const` declared before `$$ = $$$.orders`, which replaces the stream … correlate with a `.filter` instead …``
- root `$.<field>`: ``\`$.length\` (the outer document) isn't available inside `$$ = $$$.orders` … `o.length` here would be the switched collection's field, not the root's … correlate with a `.filter` …``

Mechanism: `lowerChainOnCollection` seeds `ctx.sourceSwitch = { desc, letNames }`
on the union sub-pipeline ctx; codegen's identifier resolver consults it for the
`let` case, and `.map`'s `rejectLocalDocRef` for the `$.<field>` case. A
top-level `$$.map` (no source-switch) keeps the plain "use the param" hint —
the guidance is gated on `ctx.sourceSwitch` so it never leaks where it's wrong.
Distinct from `droppedLets` (an in-place reshape read in a *later* stage):
different site and different fix. See
[replace-stream-stage.md](specs/replace-stream-stage.md) § Source-switch error guidance.

---

## 2026-06-20 — feat: `$$.length` = ROOT stream count at any depth (via `$lookup.let`) + block-body `.map`

Completes the nested stream-length composite. The motivating program now compiles and runs (verified end-to-end on mongod):

```js
$match($.createdAt >= new Date(2026, 1, 1));
$$ = $$$.orders.filter(o => $._id === o.userId).map((o, i, ordersColl) => {
  return {
    totalShipments: $$$.shipments.filter((s, i, shipmntsColl) => s.orderId === o._id).length, // nested lookup .length
    totalOrders: ordersColl.length,  // 3rd-arg handle — the orders sub-stream
    totalUsers: $$.length,           // the ROOT users stream
  };
});
```

Three pieces landed:

**1. `$$.length` is the ROOT stream, at any nesting depth** — mirroring `$` = root document (the developer's design call). Inside a top-level `$lookup`, the root count materialises at the top (`$setWindowFields` → `$__jsmql.length`) and is **captured into the `$lookup.let`** as `v0_length`, read back as `$$v0_length`. New `GenerateCtx.rootStreamLengthVar` + `captureRootStreamLength` (lookup-translation.ts), wired into all three top-level lookup bodies: the expression predicate (`translatePredicate`), the `$.x =` chained pivot (`tryExtractChainedLookup`), and the `$$ =` replace-stream pivot (pipeline.ts). The root count rides a `$$`-variable while a sub-stream count rides the `$__jsmql.length` field, so a `.map` body reads both at once with no collision (detection keys on `CollectionRef.length` vs `ParamRef.length`). `generateStreamLength` returns `$$<var>` when the var is set. This **narrows DEF-033**: top-level `$lookup` `$$.length` ships; `$facet`/`$unionWith`, depth > 1, and reusable-function bodies stay deferred (the message now lists those).

**2. Block-body `.map`** — `(o, i, coll) => { return <expr>; }` (an `exprBlock` with no `let`/`const` decls) is accepted as the expression form (`mapBodyExpr` in stream-methods.ts); decls redirect to the expression / top-level-`let` form.

**3. Unused extra params on an expression-body `.filter` predicate** — `(s, i, shipmntsColl) => …` is valid JS, so it no longer throws; `validateLookupShape` rejects only a *used* index/array param on a predicate (with a block-body redirect), mirroring `.map`.

Docs: [LANGUAGE.md](LANGUAGE.md) § `$$.length` (root semantics) + § Cross-collection lookups; spec [stream-length.md](specs/stream-length.md) §§ ROOT-count-inside-`$lookup` / Scope; [DEFERRED.md](DEFERRED.md) DEF-033 narrowed. Tests: a nested-three-levels unit case in [test/stream-length.test.ts](../test/stream-length.test.ts) and a realistic showcase in [test/realistic.test.ts](../test/realistic.test.ts), both the mongod-verified shape.

---

## 2026-06-20 — feat: cross-level references in nested block-body lookups / `.map` (root, ancestor params, ancestor `.length` handles)

A block-body lookup (`.filter`/`.map`) nested any number of levels deep can now read across scopes **correctly**: the root document (`$.field`), an enclosing foreign param (`outer.field`), and an ancestor sub-stream count (`outerColl.length`, a 3rd `.map`/`.filter` handle) each resolve to the right document instead of being mis-captured as a field of the immediate parent. This closes the developer's hardest "make it work" example — a statement-block `.map` nested inside another, whose asserts compare `shpmntsColl.length < ordersColl.length` and message `order ${o._id} for user ${$._id}`, reaching across three lookup levels at once (verified end-to-end on a live `mongod`; `userId: $._id` resolves to the root user at every order).

The fix builds on MQL's `$$`-variable propagation through nested `$lookup.pipeline` boundaries: an ancestor value is captured **once**, into the `$lookup.let` of the level whose `let` evaluates against the document that holds it (root → outermost lookup `jsmql_f0_…`; a level-K param/handle → the level-(K+1) lookup `jsmql_f<K+1>_…` / `jsmql_s<K+1>_…`), and read at deeper levels by `$$`-name. Implementation: the block-body path no longer pre-rewrites enclosing-param refs to `FieldRef`s; instead `transformExpr` + a depth-aware `LetAllocator` (carrying the enclosing params, the live ancestor allocators, and the ancestor handles) resolve each ref to its correct level via `allocateRootField` / `allocateAncestorForeign` / `allocateAncestorHandle`. Because `letVars()` is a live reference, a deep capture into an ancestor allocator is reflected when that ancestor finalises its `let`; a correlation `ParamRef` captured after the consuming level's `lambdaParams` froze is emitted as `$$<name>` for any `jsmql_[fvs]<d>_…` name (`CORRELATION_VAR_RE` in namespace.ts), since it is in scope by construction. `lowerCallbackBlock` is now the single engine for both `.filter` heads and statement-block `.map` (the latter returns its captures as `StreamMethodResult.extraLetVars`, merged onto the lookup by the chain assembler). This also fixes the pre-existing block-body `.filter` deep-ancestor bug (a 3-level `.filter` reading a grandparent field previously captured the wrong doc). Consequence: a nested lookup inside a statement-block `.map` now lowers in pipeline form (like `.filter` blocks already did) rather than the leaner basic form the old `.map` path emitted — correct + consistent, slightly more verbose. See [lookup-stage.md](specs/lookup-stage.md) § Nested lookups, [LANGUAGE.md](LANGUAGE.md).

---

## 2026-06-20 — feat: outer-pipeline `let`s thread into a lookup-pivot `.map`; expr/block `.map` unified inside `$lookup`

A statement- or expression-block `.map` chained onto a correlated lookup pivot
(`$$ = $$$.coll.filter(o => o.x === $.y).map((o, i, coll) => …)`) can now read
an **outer-pipeline `let`** declared before the pivot — it's captured into the
lookup's `$lookup.let` as `jsmql_v0_<name>`, alongside the root stream count
(`$$.length` → `jsmql_s0_length`), the root doc field (`$.length` → `jsmql_f0_length`),
and the sub-stream count (`coll.length` → `$__jsmql.length`). So the four
distinct "length"s in `const length = $.length + 1; $$ = $$$.orders.filter(o => o.userId === $._id).map((o,i,coll) => ({ l0: $$.length, l1: $.length, l2: length, l3: coll.length }))`
each resolve to their own var, none colliding (verified on a live mongod: 3/7/8/2).

Two changes enabled it: (1) the chain assemblers (`lowerLookupPivot` /
`tryExtractChainedLookup`) now carry the outer pipeline's `pipelineLets` on the
chain ctx, so the chain `.map`'s let-extractor recognises an outer-`let` ref and
hoists it (rewritten to its `$$`-var before codegen, so no raw read leaks as a
sub-pipeline field). (2) Inside a correlated `$lookup` an **expression-body**
`.map` (`d => X`) now lowers through the SAME `lowerCallbackBlock` as a
statement block (`X` becomes the `return`), so it gets identical cross-level +
outer-`let` capture. The route is gated on `ctx.enclosingLookup` being set —
which the lookup assemblers set (the pivot now seeds `EMPTY_ENCLOSING` to mark
"inside a lookup") but a flat `$unionWith` source-switch does **not**, since a
`$unionWith` has no `let` to correlate into. A bare `$$ = $$$.coll.map(…)`
(no filter) is therefore still a source-switch that discards the outer
stream/doc/`let`; only `coll.length` is available inside it. See
[stream-length.md](specs/stream-length.md), [stream-methods.md](specs/stream-methods.md) `.map` row.

---

## 2026-06-20 — feat: statement-block `.map(d => { … ; return <ret> })` on streams (unified `.filter`/`.map` lowering)

A stream `.map` now accepts a full **statement block** ending in `return`, not just an expression body. This closes the gap behind the developer's "make it work" examples — `assert(...)` / `$match(...)` / `let` / `<coll>.length` / nested `$$$.<coll>` lookups inside a `.map`:

```js
$$ = $$$.orders.filter(o => o.userId === $._id).map(o => {
  assert(o.total > 0, "bad order");
  return { id: o._id, t: o.total };
});
```

This realises the developer's requested pre-factoring (item 1): `.filter` and `.map` callback sub-pipelines now share **one parser** ([`parseCallbackBlock`](../src/parser.ts), already unified in the prior Phase-1 commit) **and very similar codegen** — the *only* difference is `return` handling. A statement-block `.map` lowers through the SAME engine `.filter` uses (`extractLetsFromPipeline` → `lowerBlock`); the trailing `return <ret>` is appended as the root-replace statement `$ = <ret>` (a synthetic `UpdateFilter`), which `lowerBlock` turns into `$replaceWith` — so the whole sub-pipeline vocabulary (asserts, `$match`, nested lookups, length materialisation) comes for free, no second copy of the block-lowering logic.

Two enabling changes: (1) the parser's block-kind gate is now `STREAM_BLOCK_METHODS` (`find`/`filter`/`map`) × `isStreamRooted` (walks `MemberAccess`/`IndexAccess`/`MethodCall` back to a `$$`/`$$$`/`$$$$` root) — so a chained `.map`'s `=> { … }` parses as a sub-pipeline block, while an in-document array `.map` (`$.items.map`, rooted at a field) keeps its expression-block meaning (`isLookupReceiverRooted` → `isStreamRooted`). (2) `GenerateCtx.slotAllocator` threads the enclosing chain's `__jsmql.tmp.<N>` counter into the block lowering, so a lookup materialised inside a `.map` block gets a slot distinct from the outer lookup's `as` (no `tmp.1`/`tmp.1` collision). Behaviour-preserving for every prior shape (the 3-level count example re-emits byte-identically); the new shape verified end-to-end on a live mongod. See [stream-methods.md](specs/stream-methods.md) `.map` row, [lookup-stage.md](specs/lookup-stage.md) parser section, [LANGUAGE.md](LANGUAGE.md).

---

## 2026-06-20 — refactor: standard `$lookup.let` correlation-var names — `jsmql_<f|v|s><depth>_<name>`

`$lookup.let` correlation-variable names (the `$$<name>` vars that carry an outer JS scope's value into a nested sub-pipeline) now follow one explicit scheme — single source of truth `letFieldVar` / `letBindingVar` / `letSysVar` in [src/namespace.ts](../src/namespace.ts):

- `jsmql_f<scopeDepth>_<field>` — a document field (`$._id` → `jsmql_f0__id`, `o.createdAt` at depth 1 → `jsmql_f1_createdAt`).
- `jsmql_v<scopeDepth>_<name>` — a `let`/`const` binding (`const startDate = …` at depth 1 → `jsmql_v1_startDate`).
- `jsmql_s<scopeDepth>_<name>` — a system value (`$$.length` → `jsmql_s0_length`).

`scopeDepth` is the nesting level of the JS scope the value comes from (0 = root pipeline, 1 = first lookup body, …); the connector after the depth is always a single `_`, so a field starting with `_` reads doubled (`_id` → `jsmql_f0__id`). This replaces the previous `v<depth>_<field>` names, which (a) didn't distinguish field/binding/system and (b) special-cased a leading `_` away. The earlier captured-root-length var `v0_length` is now `jsmql_s0_length`.

**Why `jsmql_` and not `__jsmql_`** (the document-field namespace prefix): a `$lookup.let` key is a MongoDB **variable** name, and the server **rejects** a `$$` variable whose name starts with `_`/`$`/uppercase (verified live: `'__jsmql_f0__id' starts with an invalid character`). So these correlation vars must start with a letter — distinct from the `__jsmql.*` *document-field* namespace, which keeps its leading underscores. The `f`/`v`/`s` + depth structure is otherwise the developer's proposed scheme. Behaviour-identical (only the internal `$$`-var spelling changed); all emitted shapes re-verified on a live mongod. Tests/specs across the suite updated to the new names; the `letVarName` helper + its connector special-casing are gone.

---

## 2026-06-19 — feat: array-callback 3rd `(…, array)` param + lazy index pairing

Array-method callbacks (`.map`/`.filter`/`.find`/`.findLast`/`.some`/`.every`/`.flatMap`) now accept the JS 3rd parameter — the iterated array. It binds to the method's input and is typed as an array, so `arr.length` lowers to a clean `$size`: `$.items.map((el, i, arr) => el / arr.length)`. Strict-JS semantics fall out of "the input" — in a `.filter(...).map((el,i,arr)=>…)` chain, `arr` is the post-filter result (it's `map`'s input). `generateLengthAccess` gained an array-typed-`ParamRef` → `$size` case for the clean output. (Lookup-chain `$$$.<coll>.filter(...).map(...)` 3rd arg is a separate, larger piece — the sub-stream count — still pending.)

**Lazy index pairing (the motivating fix).** The `$zip`/`$range` index machinery is now emitted **only when the index param is actually referenced** (a complete `someExpr` `Expr`-union walk). When it isn't — including the common `(el, i, arr) => …arr…` where `i` is only positional to reach `arr` — the plain `$map`/`$filter` is used instead. This also tightened the pre-existing 2-param case: `.map((x, i) => x)` (unused `i`) no longer zips. `arrayIterInput` returns a `paired` flag so `.filter`/`.find`/`.findLast` know whether to project elements back out of the `[index, element]` pairs (previously keyed on param *count*, which no longer matches whether pairs were used).

To reuse the complete `Expr`-union walker in both codegen (the index-usage check) and pipeline (`containsStreamLength`) without an import cycle, the `someExpr`/`someElement`/`someStmt` family moved to a new leaf module [src/ast-walk.ts](../src/ast-walk.ts). Implementation in [src/codegen.ts](../src/codegen.ts) (`arrayIterInput`, `generateLengthAccess`); spec [docs/specs/method-dispatch.md](specs/method-dispatch.md) § Callback parameters; user doc [docs/LANGUAGE.md](LANGUAGE.md). Verified on a live mongod 8.2 (`map(el*arr.length)` → `[30,60,90]`; `filter(arr.length>2)` keeps 3 / drops 2); 2340 tests pass, `tsc` clean.

---

## 2026-06-19 — feat: block-body `.filter` 3rd-arg `coll.length` (in-pipeline sub-stream count)

A block-body lookup filter now accepts the 3rd 'collection' param, so the post-filter sub-stream count is usable *inside* the `$lookup.pipeline` — the headline being an in-pipeline guard: `$.orders = $$$.orders.filter((o, _i, ordersColl) => { $match(o.userId === $._id); assert(ordersColl.length > 0, "User without orders is impossible"); })`. Lowers to a `$lookup` whose pipeline is `[$match, $setWindowFields($count→__jsmql.length), $match($convert assert), $unset __jsmql]`. Verified on live mongod: alice (2 orders) → `orders:[…]`; bob (0 orders) → `orders:[]`.

**Mechanism.** `validateLookupShape` relaxes the single-param rule for block-body `.filter` only (expression-body predicates and `.find` keep it — the filtered sub-stream doesn't exist while the predicate runs; that rejection now redirects to the block form). `buildBlockBodyPredicate` takes the whole lambda, rejects a *used* index param and any non-`.length` use of the handle, and binds the 3rd param via `GenerateCtx.substreamLengthHandles`. `generateImplicitPipeline`'s materialiser (already present, gated `container === "top"`, which `lowerBlock` uses) now also fires for a bound handle's `.length`: `isStreamLengthNode`/`containsStreamLength` gained an optional `handleNames` set matching `<handle>.length` (a `ParamRef`) alongside `$$.length` (a `CollectionRef`). Because the block keeps the foreign docs, the inner trailing `{ $unset: "__jsmql" }` clears the count so it doesn't leak into the `as` array.

**Why the named handle, not the `$$.length` sigil.** A `coll.length` is a `ParamRef.length`, which the *outer* pipeline's materialiser scan ignores (it keys on `CollectionRef` for `$$.length`) — so no spurious top-level `$setWindowFields` is emitted (a real bug the `$$.length`-sigil-in-sub-pipeline path still has). **Empty-stream caveat** (documented): an in-block `assert(coll.length > 0)` is a per-doc `$match` inside the lookup pipeline, so on a zero-match sub-stream it can't fire (no doc to reject) — `as` is `[]`; for a hard non-empty guarantee, assert on the materialised array at the outer level. Docs: [LANGUAGE.md](LANGUAGE.md) § Cross-collection lookups, specs [stream-length.md](specs/stream-length.md) § Sub-stream length, [lookup-stage.md](specs/lookup-stage.md). Tests in [test/lookup.test.ts](../test/lookup.test.ts). The `$$.length` sigil in sub-pipelines, cross-level passthrough, and `$facet`/`$unionWith` parity remain (DEF-033).

---

## 2026-06-19 — feat: lookup-chain `.map` 3rd-arg `coll.length` (sub-stream count)

A `$$$.<coll>.filter(p).map((o, _i, coll) => …)` chain — and the top-level `$$ = $$.map(...)` stream chain — now accept the JS 3rd callback param, where `coll` is the **stream** the `.map` transforms (the post-filter foreign sub-stream, or the top-level stream). `coll.length` is its document count: `$.byOrder = $$$.orders.filter(o => o.userId === $._id).map((o, _i, coll) => ({ id: o._id, share: o.total / coll.length }))`. This is the named-handle spelling of "the inner pipeline's stream length" from the `$` = root, 3rd-arg = inner-stream design — the first slice of that work.

**Mechanism.** Unlike the in-document-array 3rd arg (which is a materialised array → `$size`), a lookup-chain `.map` is a per-doc transform *inside* the `$lookup.pipeline`, so `coll` is a stream, not an array. `MAP.lower` (stream-methods.ts) detects `coll.length`, prepends `streamLengthStage()` — the same `$setWindowFields` `$count` → `__jsmql.length` shape the top-level `$$.length` uses, now relocated to the shared leaf module [src/namespace.ts](../src/namespace.ts) to avoid a pipeline↔stream-methods cycle — and binds the handle through the new `GenerateCtx.substreamLengthHandles` map, which `generateLengthAccess` resolves to `"$__jsmql.length"` (checked *before* the array-`$size` branch, since the handle isn't a bound `$$`-variable). Placement is automatic: the chain assembler appends each method's stages in order, so the count is the sub-stream *at that chain point* (post-filter / post-`.slice`). Verified end-to-end on a live mongod (per-user counts correct, no `__jsmql` leak).

**Scope/rejections.** `.map` only takes the 3rd-arg sub-stream handle for now; only `.length` is available on it (other uses redirect to the materialised `.filter` form), and the **index** (2nd) param may not be *referenced* (MongoDB streams have no per-doc index — `someExpr` check; it may be present-but-unused only to reach the 3rd param). Both rejections are permanent. The arity gate relaxed from "exactly 1 param" to "1–3, index-if-used rejected", so an unused index (`.map((d, _i) => …)`) is now accepted. Block-body `.filter` asserts, cross-level (any-depth) passthrough, and `$facet`/`$unionWith` parity are the next slices. Docs: [LANGUAGE.md](LANGUAGE.md) § callback params, specs [stream-length.md](specs/stream-length.md) § Sub-stream length, [method-dispatch.md](specs/method-dispatch.md), [stream-methods.md](specs/stream-methods.md). Tests in [test/stream-methods.test.ts](../test/stream-methods.test.ts).

---

## 2026-06-19 — test: integration coverage for the quirkiest shapes (nested $lookup, assert, $$.length)

Follow-up to the live-MongoDB integration suite (entry below): now that master carries the gnarliest features jsmql has — nested `$lookup` in block-body predicates, `assert(cond, msg)`, and `$$.length` — we run them against the real fixture, because these are exactly the shapes where "compiles to plausible MQL" and "the server actually does the right thing" diverge most. Four new cases in [test/integration.test.ts](../test/integration.test.ts):

- **Nested `$lookup`** (users → recent orders → each order's shipments). The inner predicate correlates on two levels — `s.orderId === o._id` and `s.userId === $._id` — which only resolves correctly because jsmql depth-stamps the `$lookup.let` names (`$$v1_id` vs `$$v0_id`). Live result confirms it: Ada's three orders each carry their one shipment, and Grace's **cancelled** order yields an empty nested `shipments` array (no wrong match). This required a small **dataset expansion** — shipments gained a denormalised `userId` (the owning order's user), with a `validateDataset()` integrity check that it matches the order. The dataset is meant to grow this way (see [test/fixtures/CLAUDE.md](../test/fixtures/CLAUDE.md)); re-seed after any change.
- **`assert` that holds** → the aggregate runs and the next stage computes (20 orders, all `total > 0`).
- **`assert` that fails** → the whole aggregate aborts. This is the load-bearing check: the lowering names the message as a bson type via `$convert`, and the live server really does reject with `Unknown type name: jsmql assertion failed: order total exceeds cap` — verified, not assumed.
- **`$$.length`** materialised once via `$setWindowFields` and reused across two `$set` fields and an `assert` guard (8 in-stock products, `sharePct` 12.5, scratch `__jsmql` field `$unset` from the output).

No `src/` behaviour changed — this is test coverage of merged-in features. The integration suite is now 16 cases.

---

## 2026-06-19 — test: live-MongoDB integration suite + deterministic fixture instance

jsmql can emit MQL that *looks* valid and passes a `toEqual(...)` but that the server doesn't actually run the way the user meant — exactly the failure mode HR3 exists to prevent. We now have [test/integration.test.ts](../test/integration.test.ts): 12 curated cases that compile a jsmql source, run it against a **real MongoDB**, and assert on the documents returned. Expected values were derived from a live run, never guessed. Building it immediately surfaced a real DX trap — the fixture's first deterministic ObjectIds were zero-padded (`0000…a1`), whose embedded timestamp decodes to 1970, so jsmql's `assertPlausibleObjectId` guard (correctly) rejected "find by `_id` via the `0x` literal"; the fix was to give fixture ids a plausible `0x65000000…` (2023) timestamp prefix so the `0x` literal works end-to-end.

The dataset lives in [test/fixtures/](../test/fixtures/CLAUDE.md): five cross-referenced collections (`users`/`products`/`orders`/`shipments`/`reviews`), deterministic by hard rule (fixed ids/dates/numbers — no `Math.random`/`Date.now`), with order line prices and totals **computed** from the catalogue and a `validateDataset()` self-check at seed time. A content hash (`DATASET_HASH`) drives idempotent re-seeding.

The read-only requirement drove the instance design. A server-enforced read-only role needs `authorization: enabled`, which is instance-wide — enabling it on the developer's primary mongod (which serves their real services auth-free) was rejected as too invasive. Instead we run a **dedicated second mongod on `:27018`** with `--auth`, its own dbpath at `~/.jsmql-fixture` (outside the repo), an admin user used only by the seeder, and a `jsmql_ro` user with `read` on `jsmql_fixture` that the tests connect through — so a test run literally cannot write (verified: writes/updates come back `Unauthorized`). Lifecycle is `npm run fixture:{up,seed,status,down,reset}` ([test/fixtures/instance.ts](../test/fixtures/instance.ts); `mongod --fork` is rejected on macOS, so it self-daemonizes detached). The suite **self-skips** (green, not failing) when the instance isn't up, so `npm test` stays green for contributors who haven't run `fixture:up`. This is now the canonical home for "verify it actually runs" — see [test/CLAUDE.md](../test/CLAUDE.md). No `src/` behaviour changed.

---

## 2026-06-18 — feat: `$$.length` — the current stream's document count as a value

`$$.length` is now a usable value: the number of documents in the stream at the point it's read. `$.n = $$.length`, `1 / $$.length`, `assert($$.length <= 1, …)` — anywhere an expression goes. This is the long-deferred stream-`.length` (it supersedes the old "terminal `$count`" sketch from the 2026-05 stream-methods note: that would have collapsed the stream; this keeps it).

**Mechanism.** MQL has no inline stream-count operator, so jsmql materialises one: a `$setWindowFields` with a full-partition `$count` stamps the count onto every document under the reserved system slot `__jsmql.length` (Phase-1 namespace standard), and codegen reads it back as `"$__jsmql.length"`. `$setWindowFields` adds a field without collapsing the stream. Requires MongoDB 5.0+.

**Compute-once / reuse / recompute.** The materialiser is hoisted lazily: emitted once before the first use, reused while it stays *fresh*, and recomputed after any stage that isn't count-and-field preserving. Preserving allowlist (`STREAM_LENGTH_PRESERVING`): `$set`/`$addFields`/`$sort`/`$lookup`/`$setWindowFields`; everything else (`$match`, `$group`, `$unwind`, `$project`, `$unset`, `$replaceWith`, sugar, …) invalidates. Conservative by design — recomputing is always correct, reusing a stale count is a bug. Detection is a complete `Expr`-union walk (`someExpr`/`containsStreamLength` in pipeline.ts); a missed node would emit a dangling `$__jsmql.length`.

**Scope.** Top-level pipeline only, gated by a new `topLevelStream` ctx flag (set by both pipeline lowerers, preserved by `extendCtx` for same-document lambdas, dropped by `freshSubPipelineCtx`). Rejected in Filter/`jsmql.expr` (no stream), inside a `$lookup`/`$facet`/`$unionWith` sub-pipeline, and inside a reusable function body — the latter two tracked as **[DEF-033]**. A top-level `.map`/`.filter` lambda is allowed (the stamped field is on the same document). Single-statement no-`;` forms (`$.n = $$.length`) reroute through the pipeline lowerer the same way lookup/`$out`/replace-root do.

Implementation: `generateStreamLength` + the `topLevelStream` flag in [src/codegen.ts](../src/codegen.ts); the lazy materialiser, freshness allowlist, complete detection walk, sub-pipeline + function-body rejection in [src/pipeline.ts](../src/pipeline.ts); `LENGTH_SLOT` in [src/namespace.ts](../src/namespace.ts); reroutes in [src/index.ts](../src/index.ts). Spec [docs/specs/stream-length.md](specs/stream-length.md); user doc [docs/LANGUAGE.md](LANGUAGE.md) § `$$.length`; tests [test/stream-length.test.ts](../test/stream-length.test.ts) (19 cases) + a realistic case; every shape (compute/reuse/recompute, all call forms, rejections) verified executing against a live mongod 8.2.

---

## 2026-06-18 — feat(lookup): nested lookups inside block-body predicates

A `$$$.<coll>.find/filter(...)` may now appear inside another lookup's **block-body** lambda — as a statement (`$.orders = $$$.orders.filter(o => o.userId === u._id)`), inside a stage-body expression (`$match($$$.orders.filter(...).length > 0)`), or as a block-bodied inner lambda — to any depth. It lowers to the same shape the expression-body path already produced: the inner lookup materialises as a `$lookup` stage inside the outer's `$lookup.pipeline`, with `u.<field>` refs auto-`let`'d into the inner's `$lookup.let`. Previously this threw `Nested lookup inside another lookup's block-body lambda is not yet supported`. Closes the last open nested-lookup item (was DEF-023). All three emitted shapes were run against a live `mongod` and join correctly.

**Why it was blocked, and the fix.** The expression-body path threads `EnclosingLookupContext` (`foreignParams` / `inScopeLetNames`) as an explicit argument through its own recursion. Block lowering instead runs through `generateImplicitPipeline` (the `SubPipelineLowerer`), which has no `enclosing` parameter, so a nested lookup dispatched from inside a block had no way to learn it was nested — and defaulted to top-level translation (wrong: it would pick basic-form and skip let-coordination). The fix adds a **ctx carrier**, `GenerateCtx.enclosingLookup` ([src/codegen.ts](../src/codegen.ts)): the new shared helper `buildBlockBodyPredicate` ([src/lookup-translation.ts](../src/lookup-translation.ts)) sets it on the sub-pipeline ctx, and the four lookup-translation entry points (`translatePredicate` / `buildPipelineFormPredicate` / `lowerLookup` / `extractLookupCalls`) read it back when their explicit `enclosing` argument is omitted — which is exactly how every `pipeline.ts` dispatch path calls them, so no call site changed. `freshSubPipelineCtx` drops the field, so each lookup re-seeds its own. The same helper feeds both `translatePredicate` and `buildPipelineFormPredicate`, replacing the two copied block-body branches.

**Two supporting fixes.** (1) `transformStmt` ran assignment/`delete` **targets** through `transformExpr`, which hoisted a write destination like `$.bs` into a `$lookup.let` var — surfacing as the misleading `Cannot assign to bare identifier 'bs'` error and blocking even a plain `$.x = …` `$set` inside any block-body lookup. New `transformTarget` keeps a target as its field path (the eventual `$set`/`$unset` key). (2) `rewriteEnclosingForeignParamsInPipeline` applies the enclosing-foreign-param rewrite across a block's statements, because `transformExpr` deliberately does not descend into a nested lambda's *block* body — so each nesting level performs its own rewrite as it is dispatched (needed for block-in-block nesting). The pre-existing cross-level same-field-name `let` collision (documented in [docs/specs/lookup-stage.md](specs/lookup-stage.md)) is shared by both paths and unchanged. Tests: [test/lookup.test.ts](../test/lookup.test.ts) gains three block-body success cases mirroring the expression-body block.

---

## 2026-06-18 — fix: constant `new Date(...)` folds to a real BSON Date (HR1/HR3)

`new Date("2026-05-17T...")` inside a query document — a Filter `{ createdAt: { $gte: new Date("...") } }` or the `$match({ ... })` object-literal passthrough — lowered to the aggregation form `{ $toDate: "..." }`. But MongoDB's *query language* doesn't evaluate `{ $toDate }`; it compares against it as a literal subdocument, so the predicate silently matched **nothing**. Verified against a local `mongod`: a real `Date` in a `$gte` slot matches, `{ $toDate: "..." }` matches `[]`, in both `find` and aggregation `$match`. This violated HR1 (a constant `Date` should pass through verbatim) and produced a query that just didn't work — the reported bug.

Fix: a `new Date(...)` with compile-time-constant arguments now folds to a real BSON `Date` in **every** context (codegen-level, not just the query translator), so the same `new Date("...")` emits the same MQL regardless of surrounding syntax and works in both aggregation-expression and query-document positions. The fold logic became a single source of truth — `evalConstDate` / `foldConstantDate` in [codegen.ts](../src/codegen.ts) — that both `generateNewDate` and the `$match`/Filter translator ([match-translation.ts](../src/match-translation.ts)) call; the translator's old private `evaluateStaticDate` (which folded multi-arg `new Date(y, m, d)` in JS **local** time, silently disagreeing with codegen's **UTC** `$dateFromParts`) is gone. Only genuinely-runtime forms (`new Date()` = now, `new Date($.field)`) keep the `{ $toDate }` / `$dateFromParts` lowering.

HR3 follow-up: when the constant arguments evaluate to an *Invalid* Date (`new Date("not-a-date")`), jsmql now **rejects at compile time** with an actionable, position-bearing error (`"not-a-date" is not a valid date string. Use an ISO 8601 date like ...`) instead of emitting `{ $toDate: "not-a-date" }` — which `mongod` rejects at parse time anyway ("Error parsing date string"). A JS-valid-but-non-ISO string (`new Date("Jan 1 2024")`) folds to a real Date, which also fixes a case the old `{ $toDate }` form would have had the server reject.

---

## 2026-06-18 — fix(lookup): correlated-pipeline predicates use index-friendly query form, not blanket `$expr`

The expression-body `$lookup` correlated-pipeline predicate path wrapped the *whole* predicate in `{ $match: { $expr: … } }` — even constant comparisons the query planner could serve from an index. It now routes the let-extracted predicate through `translateMatchBody` + `matchStagesFromTranslation`, the same index-friendly emitter the sibling predicate translators (`$unionWith` / `$facet` / `$out` / the `$$ = $$.filter(…)` replace-stream filter) already used. So `$$$.orders.filter(o => o.userId === $._id && o.status === "shipped")` now lowers the sub-pipeline `$match` to `{ status: "shipped", $expr: { $eq: ["$userId", "$$v0_id"] } }` — `status` is an indexable query field; only the correlated half stays in `$expr`. Previously both were buried in one `$expr: { $and: [...] }`.

Why the correlated half stays `$expr`: MongoDB's query language cannot reference `let` variables — only `$expr` can — so `foreignField === $$letVar` has no query-form equivalent and must remain `$expr` (a constraint, not a missed optimization; it is still index-eligible inside `$lookup`). A materialized count comparison like `$$$.x.filter(…).length > 0` likewise now emits the query form `{ "__jsmql.__lookupN": { $gt: 0 } }` instead of `{ $expr: { $gt: [...] } }`.

This aligns the expression-body and chain-form lookup paths with the block-body path, which already produced the index-friendly shape (each `$match(...)` statement in a block lowers through the same translator via `lowerBlock`). Implemented in `translatePredicate` and `buildPipelineFormPredicate` ([src/lookup-translation.ts](../src/lookup-translation.ts)). Verified against a live `mongod` (mixed query + correlated-`$expr` joins return the correct rows); two nested-lookup test expectations in [test/lookup.test.ts](../test/lookup.test.ts) updated to the query form, plus a new guard case for the constant-vs-correlated split.

---

## 2026-06-18 — fix(lookup): depth-stamped `$lookup.let` names fix the cross-level `$$v_id` collision

A nested lookup that captured the same field name at two enclosing levels produced **wrong-but-running** MQL. Reported case: `$.recentOrders = $$$.orders.filter(o => { $.shipments = $$$.shipments.filter(s => s.orderId === o._id && s.userId === $._id); })` emitted `$$v_id` for *both* `o._id` (the order) and `$._id` (the outermost user) — and since MQL `$$` variables are lexically scoped *through* nested `$lookup.pipeline` boundaries, the inner `let: { v_id: "$_id" }` shadowed the outer one, so `s.userId === $._id` silently compared against the order's `_id`. Confirmed against a live `mongod`: the join returned the wrong shipments before, the right ones after.

Fix: every auto-extracted `$lookup.let` variable name now carries the **nesting depth** of the lookup that declares it — `v<depth>_<field>` (`letVarName` in [src/lookup-translation.ts](../src/lookup-translation.ts)). Depth is `enclosing.foreignParams.length`, threaded via a new `depth` parameter on `extractLetsFromExpr` / `extractLetsFromPipeline` → `createLetAllocator`. The reported case now emits `let: { v0_id: "$_id" }` (outer) and `let: { v1_id: "$_id" }` (inner), with the deepest `$match` reading `$$v1_id` (order) and `$$v0_id` (user) distinctly — verified joining correctly on `mongod`. This is deterministic (same input → same output; no heuristic), in keeping with the no-output-drift rule.

Because the depth must disambiguate *any* shared field name (not just `_id`), the prefix is uniform: a single-level lookup's `let` changes from `v_id` / `userId` to `v0_id` / `v0_userId`, etc. These are internal correlation variables the user never writes by name, so the rename is a non-breaking, MQL-equivalent change. `$let` / `$map` / `$reduce` `vars` (which still use codegen's `safeVarName`) are untouched — this change is scoped to `$lookup.let`. Supersedes the "cross-level field-name collision" known-limitation note in [docs/specs/lookup-stage.md](specs/lookup-stage.md) (now resolved). Expected MQL across `test/lookup.test.ts`, `test/pipeline.test.ts`, `test/realistic.test.ts`, `test/stream-methods.test.ts`, and `test/literal-passthrough.test.ts` updated to the depth-prefixed names.

---

## 2026-06-18 — refactor: standardise the `__jsmql.` temp namespace, bucketed by kind

Compiler-generated temporaries the document carries between stages now live in **kind-bucketed** sub-fields of the single `__jsmql` object, with a new single source of truth at [src/namespace.ts](../src/namespace.ts). Before, `let`/`const` bindings sat flat at `__jsmql.<name>`, lookup/scratch slots at `__jsmql.__lookup<n>`, and the dict-build reducer used a rogue **top-level** `__jsmqlDict` sibling (outside the `__jsmql` object entirely). Now:

- `__jsmql.var.<name>` — `let` **and** `const` bindings (merged: let-vs-const is compile-time, a name is unique per scope, and codegen already tracks const-ness — so the keyword needn't leak into the field path). `bindingSlot()`.
- `__jsmql.tmp.<n>` — anonymous scratch: lookup result slots, fan-out/`$unwind` slots, stream-method intermediates. The per-pipeline counter `createSlotAllocator()` stays in `lookup-translation.ts` (import-cycle reasons) but builds its path via `tmpSlot()`.
- `__jsmql.<reservedName>` — named system values; the first lands with the stream-length feature (`__jsmql.length`).
- Exception: `$group`/`$bucket` accumulator output keys can't be dotted, so group-produced scratch uses the flat reserved `GROUP_TMP` (`__jsmqlTmp`, formerly `__jsmqlDict`) and is consumed by the immediately-following stage.

**Why:** bucketing makes user/compiler collisions structurally impossible — a user `let length` is `__jsmql.var.length`, distinct from the system `__jsmql.length`, so no name needs reserving — and keeps the developer's output clean behind one trailing `{ $unset: "__jsmql" }`. This is the prerequisite for `$$.length` (Phase 2) and any future temp-using feature, and the rule is now codified in [src/CLAUDE.md](../src/CLAUDE.md) § the `__jsmql` namespace.

**Behaviour-identical:** these fields are internal and stripped before output, so final documents are byte-for-byte unchanged — only the intermediate field paths moved. The full suite (2317 tests) passes with no count change; the shipped `assert()` uses no `__jsmql` temp and is untouched. All four shapes (`var`/`tmp`/system/group-exception) plus the single `$unset` cleanup were verified executing against a live `mongod` 8.2. Touched `pipeline.ts` (binding paths + `$unset`), `lookup-translation.ts` (slot allocator), `stream-methods.ts` (dict-build), the new `namespace.ts`, and the path-stating comments + test expectations across the suite.

---

## 2026-06-17 — feat: `assert(condition[, message])` — conditional pipeline errors

Added `assert(...)`, a pipeline-statement guard clause that aborts the whole operation with a custom-message server error when its condition fails — the long-requested "`assert()` / `throw new Error()`" capability. A holding assertion is invisible (the document passes through unchanged); a failing one surfaces as `BadValue (2): Unknown type name: jsmql assertion failed: <message>`.

**Mechanism (deliberately not `$function`).** Research against MongoDB 8.2 (run live against a local `mongod`) confirmed there is no native error/assert/throw operator (JIRA SERVER-27190, open since 2016). The only mechanism carrying a custom message is `$function` (server-side JS `throw`) — but server-side JS is **deprecated in MongoDB 8.0**, excluded from the Stable API, and absent on Atlas Flex/free tiers, so we ruled it out. Instead `assert` lowers to `{ $match: { $expr: { $convert: { input: true, to: { $cond: [<cond>, "bool", <failMsg>] } } } } }`: a holding assertion converts `true`→`bool` (a no-op the `$match` keeps), a failing one feeds the message to `$convert` as a bogus target type, tripping `Unknown type name`. The `$convert` is **always evaluated** (gating lives in its runtime `to`), so it never relies on the undocumented short-circuiting of `$cond`/`$and`, and a constant message can't be constant-folded into firing unconditionally. The `jsmql assertion failed:` prefix is **load-bearing, not cosmetic** — without it a message that is itself a valid type name (e.g. `"int"`) would make the convert *succeed* and silently skip the check; verified against `mongod`.

Surface: `assert(condition[, message])`, message optional (string literal folds to a constant; any other expression is `$concat`+`$toString`-coerced at runtime; omitted → a generic default). Condition is JS-truthiness-wrapped like every boolean context. Statement-only: expression-position uses (`$.x = assert(…)`, `cond ? a : assert(…)`) and `jsmql.filter`/`jsmql.expr` reject with a hint pointing at the statement form (`throw` can't be a ternary branch in JS — HR2 — so `assert` is the surface, not `throw new Error()`). `jsmql.update` rejects it via the existing update-stage whitelist (it lowers to `$match`). Recognised in `lowerStatementTail` + auto-wrapped by the `jsmql()` / `jsmql.pipeline()` entry points, so every call form works without a trailing `;`.

Implementation: `generateAssertGuardExpr` + the expression-position rejection in [src/codegen.ts](../src/codegen.ts); `isAssertCall` + the `$match` wrap + `isStageCandidate` clause in [src/pipeline.ts](../src/pipeline.ts); two auto-wrap sites in [src/index.ts](../src/index.ts). Spec: [docs/specs/assert.md](specs/assert.md); user doc: [docs/LANGUAGE.md](LANGUAGE.md) § assert; tests: [test/assert.test.ts](../test/assert.test.ts) (17 cases, lowering + every call form + rejections), all lowerings verified executing against a live `mongod` 8.2.

---

## 2026-06-17 — feat: ObjectId literals — `0x…`, `ObjectId("…")`, `new ObjectId("…")`

You can now write a constant `_id` inline three ways, all producing the same live BSON `ObjectId`:

- **`0x507f1f77bcf86cd799439011`** — the leanest form: type `0x` and paste the 24-char id, no quotes or wrapper. A `0x` hex literal with **exactly 24 hex digits** is an ObjectId; a shorter one is an ordinary integer (`0xff` → `255`); numeric separators (`0x507f_1f77_…`) are allowed; a non-24-digit hex above `Number.MAX_SAFE_INTEGER` is rejected with guidance (it's neither an ObjectId nor a representable integer). Hex literals didn't lex at all before — the lexer now reads `0x…` (raw lexeme preserved), and the parser classifies it.
- **`ObjectId("…")` / `new ObjectId("…")`** — the shell/driver spelling. The string is validated as 24 hex chars at parse time, so a typo is caught early (`.pos`-bearing error).

Either form lowers to a live `ObjectId` in the query-doc value slot — `{ _id: <ObjectId> }` for equality, `{ _id: { $in: [...] } }` for an `.includes` membership — so the match is index-friendly with no `$expr` wrapper.

**Plausibility floor (typo guard).** An ObjectId's first 4 bytes are a Unix timestamp, and MongoDB didn't exist before 2009 — so any ObjectId whose timestamp predates that can't be real; it's a typo (an all-zeros id, a sequential `0x1234…` placeholder, a dropped leading digit). The parser floors at `0x4a000000…` (2009-05-05) via `assertPlausibleObjectId` and rejects anything below, with a `.pos`-bearing error that decodes and names the offending timestamp's date. A lowercase 24-char hex string compares lexicographically exactly as its 96-bit value, so the check is a single string compare against the floor. (Only a lower bound — future timestamps aren't floored, since "now" is a moving target the user didn't ask to gate.)

The `ObjectId(...)` call also absorbs the non-constant cases instead of throwing: **`ObjectId()`** (no arg) → `{ $createObjectId: {} }` (server-side fresh id), and **`ObjectId(<dynamic>)`** (e.g. `ObjectId($.idStr)`) → `{ $toObjectId: "$idStr" }` (server-side conversion). Both are real registry operators, so this mints nothing new — `ObjectId(...)` is just a JS-shaped front door onto them, alongside the literal form.

**Why a live instance and not a JSON envelope.** The Extended JSON representation of an ObjectId is a *client-side* shape the driver only materialises via an explicit `EJSON.parse` — it is **not** a query or aggregation operator. Sent verbatim (which is what the driver does with the document jsmql emits) the server rejects it — a `BadValue` unknown-operator error in a filter, an unrecognized-expression error in an aggregation expression (both reproduced against a local `mongod`). So the only correct emission is a real ObjectId *value*. jsmql mints one itself — a tiny dependency-free class in [src/objectid.ts](../src/objectid.ts) — rather than importing `bson` (which jsmql deliberately keeps as a devDependency only, and which the browser playground bundle can't `require`). The self-made value serialises **byte-for-byte identically** to a driver `ObjectId` (verified against bson 7.2.0 and end-to-end against a running `mongod` in filter / `$in` / `$expr` / `$match` positions): the driver and serializer duck-type on `_bsontype === "ObjectId"` (never `instanceof`), so a value that also reports the BSON major version via the `@@mdb.bson.version` registry symbol and implements `serializeInto` is fully interchangeable. **Caveat:** that major version is hard-coded (7); an app pinning a different bson major should interpolate its own driver instance instead. Runtime ids are still best passed as a real ObjectId via the template tag or a `jsmql.compile` parameter.

A new `ObjectIdLiteral` AST node carries the validated hex; codegen ([src/codegen.ts](../src/codegen.ts)) and the `$match`/Filter translator ([src/match-translation.ts](../src/match-translation.ts) `anyEqualityLiteral`) both mint the instance, and the lookup-predicate walkers treat it as a leaf. `ObjectId` is re-exported from [src/index.ts](../src/index.ts) so callers can build the same value for a `jsmql.compile` binding without the driver. The arrow form type-checks because `@koresar/jsmql/ops` declares `ObjectId` (an `interface ObjectIdConstructor` with call + construct signatures, emitted by `constructionFormsBlock()` in [scripts/generate-ops.mjs](../scripts/generate-ops.mjs)). **Playground:** the Variables editor accepts `ObjectId("…")` / `new ObjectId("…")` (a newable factory is injected into the eval scope), `0x…` literals work in the query editor through the rebuilt bundle, and the output panel renders ObjectId values as pasteable `ObjectId("…")` source (mirroring how `Date` round-trips). Docs: [LANGUAGE.md](LANGUAGE.md) § ObjectId literals, [specs/match-query-translation.md](specs/match-query-translation.md), [specs/grammar.md](specs/grammar.md), [specs/ops-generation.md](specs/ops-generation.md). Tests: dedicated blocks in [test/codegen.test.ts](../test/codegen.test.ts) plus a realistic case using the `0x` form.

---

## 2026-06-17 — fix: actionable error when a predicate is passed to `.includes()` / `.indexOf()`

`$.senderChain.includes(sc => sc.client === clientId && sc.tier === 2)` failed with a *misleading* message: *"Lambda expression cannot be used here — only valid as array method argument or $let second argument."* That wording is self-contradicting at the call site — `.includes` **is** an array method, so it reads as "this should be fine." The lambda was reaching the generic `case "Lambda"` rejection in `_generate`, which has no method context.

The slip itself is a JS-semantics confusion, not a jsmql limitation: `Array.prototype.includes(value)` searches for a *value*; the predicate form is `.some(predicate)` (which jsmql already lowers to `$anyElementTrue`/`$map`). So rather than accept `.includes(predicate)` — which would diverge from real JS (`[].includes(fn)` checks function identity) and add a second spelling for `.some()` — we keep it rejected but redirect. New `rejectPredicateOnValueSearch(arg, method, sibling)` helper in [src/codegen.ts](../src/codegen.ts) intercepts a lambda arg to `.includes` (→ `.some`, both bool) and its dispatch-sibling `.indexOf` (→ `.findIndex`, both index) and throws `… To test elements against a predicate, use .some(sc => …).`, echoing the user's own param name with the caret on the lambda. The generic `case "Lambda"` message was also corrected to stop falsely implying any array method takes a callback — it now names the iterating methods (`.map`/`.filter`/`.some`/`.every`/`.find`/`.reduce`/…) that actually do.

No behaviour change for valid programs: `.includes(value)` / `.indexOf(value)` and `.some(predicate)` are untouched. Spec: [docs/specs/method-dispatch.md](specs/method-dispatch.md) § Type-aware dispatch. Tests: two cases in `test/codegen.test.ts` (`array .includes()` block).

---

## 2026-06-17 — fix(playground): scope the saved session to the page's full URL

The editor session (query + Variables + compile mode) persisted under a fixed `localStorage` key, `"jsmql-playground:session:v1"`. `localStorage` is scoped by the browser to the *origin* (scheme + host + port) but **not** the path, so every playground served from the same origin shared one slot and clobbered each other: a dev copy deployed alongside the canonical `flash-oss.github.io/jsmql/playground.html` (e.g. under a different path) would overwrite the work the user had open there, and two local copies at `localhost:1234/bla/` vs `localhost:1234/foo/` collided too.

Fix: derive the key from the page URL — `"jsmql-playground:session:v1:" + location.origin + location.pathname` ([playground_skeleton.html](../playground_skeleton.html)). Different paths now keep independent sessions; different ports/hosts already did (browser origin scoping) but the origin is folded in too so the key reads as "state depends on the whole URL". Existing sessions under the bare-`v1` key are not migrated — a one-time reset, acceptable for a best-effort persistence nicety. Playground-only; no library code touched. [playground.html](../playground.html) regenerated via `scripts/sync-playground.mjs`.

---

## 2026-06-16 — fix(ops): `$$` is `var`, not `const`, in the generated ambient types

`@koresar/jsmql/ops` declared the collection context ref as `const $$`. But `$$` is reassigned wholesale by the replace-stream / `$facet` sugar — e.g. `$$ = $$$.transactions.filter(t => t.type === "deposit")` — so TypeScript flagged valid jsmql with `TS2588: Cannot assign to '$$' because it is a constant.`. The fix emits `var $$` instead (verified: `var` accepts the reassignment with zero errors; a forced-`const` control reproduces exactly `TS2588`).

Only `$$` changed. `$$$` / `$$$$` stay `const`: the language never reassigns them wholesale — their only write forms are *property* assignments (`$$$.coll = …`, `$$$$.db.coll = …` → `$out`), which `const` already permits, and keeping them `const` still correctly flags the invalid `$$$ = …` whole-reassignment (no such sugar exists). Loosening all three to `var` would have wrongly accepted a form the parser rejects.

Source of the change is the generator [scripts/generate-ops.mjs](../scripts/generate-ops.mjs) (`contextRefBlock` — the collection branch now emits `var`); [src/ops.ts](../src/ops.ts) was regenerated (the drift test byte-compares it). Spec updated: [docs/specs/ops-generation.md](specs/ops-generation.md) § Context references now documents the per-ref keyword and its rationale.

---

## 2026-06-16 — fix(playground): trailing `// comment` no longer breaks the variables (compile) path

A query ending in a `// line comment` with no trailing newline rendered `Unexpected end of expression` in the playground — but **only** when the Variables editor had at least one key, so `render()` routes through the `.compile(...)` builders. `buildArrow(keys, query)` ([playground_skeleton.html](../playground_skeleton.html)) wraps the query into a compile-form arrow string `({ keys }) => { <query> }`, and it appended the closing ` }` **on the same line** as the query's last line. When that last line was `// some comment`, the brace landed *inside* the comment (`// some comment }`), so the block never closed and jsmql's parser hit EOF mid-block — a correct rejection of genuinely malformed wrapper source, surfaced as the cryptic error. The no-variables path was unaffected (it feeds the raw query straight to `jsmql()`, whose lexer treats the trailing comment as trivia).

Fix: close the block on its own line — `prefix + query + "\n}"` — so the leading newline terminates any trailing line comment before the brace. This mirrors `parseVars`, which already puts a `\n` before its closing `)` in `new Function("return (" + trimmed + "\n)")` for exactly this reason. `prefixLen` is unchanged, so arrow-relative → query-editor error-position mapping (`toQueryPos`) still lines up. Playground-only; no library code touched. [playground.html](../playground.html) regenerated via `scripts/sync-playground.mjs`.

---

## 2026-06-15 — docs: LANGUAGE.md Function Form no longer claims "arrow functions only"

The Function Form section's Restrictions bullet still read "**Arrow functions only.** `function` declarations are rejected. Use `() => …`" — stale since the `function` keyword shipped everywhere arrows are accepted (DEF-030, commit 756e042). The grammar (`function_expr` / `function_decl`) and [reusable-functions.md](specs/reusable-functions.md) § "the JS `function` keyword" already documented it as a second spelling of the same surface; only the user-facing reference lagged.

Corrected [LANGUAGE.md](LANGUAGE.md) § Function Form: the intro now says `jsmql()` / `jsmql.validate()` accept an arrow `($) => …` **or** a `function ($) { … }` (with worked examples, incl. the discarded-name note); the block-body subsection notes the `function` keyword mirrors both the value (`{ return <expr> }` ≡ `($) => <expr>`) and pipeline (`{ stmt; stmt; }` ≡ block-body arrow) shapes; the Restrictions list now states "arrow or `function`, but synchronous and non-generator" (folding the old "no async/generators" bullet in). Also reconciled the `jsmql.compile` section's "arrow-shaped" / "the arrow's shape" phrasing to "function-shaped" since `compile` accepts the `function` keyword too (verified). Fixed a stale MQL output while in the same example block: the Function Form intro showed `jsmql(($) => $.age > 18)` → `{ $gt: ["$age", 18] }` (the raw expression form), but a no-`;` input dispatches to Filter mode → `{ age: { $gt: 18 } }` (consistent with the "Function form mirrors the rule" section and verified against the live build). Docs-only — no code or behaviour change.

---

## 2026-06-15 — feat: trailing commas accepted in every comma-separated list

`Math.max(1, 2,)` and a multi-line `$match(… ,)` (a comma before the closing paren — exactly what prettier/oxfmt emit when they break a list across lines) used to throw. They no longer do. A single trailing comma after the last item of **any** comma-separated list is now accepted everywhere — strengthening the #2 "strict subset of JavaScript" priority: previously a trailing comma was a counterexample to the README's "if `node --check` accepts it, jsmql does too" claim.

Covered sites (all in [src/parser.ts](../src/parser.ts)): method-call args, `$op(...)` positional **and** object-style (a lone trailing comma after a sole object arg stays object-style — `$op({…})` ≡ `$op({…},)`), `Math.*` / `Object.*` / `Date.UTC` / `new Date|Set` arg lists, the fixed-arity built-ins (`Number(x,)`, `Array.isArray(x,)`, `Number.isInteger(x,)`, `Array.from(x,)` / `Array.from(x, fn,)`), arrow & `function` parameter lists (and the parenthesised-lambda lookahead `isLambdaStart`, so `(x,) => …` is recognised), the `jsmql.compile` three-slot signature + its params destructure, and the in-stage update-op chain before a block's closing `}`. Array and object literals and the destructure slot already allowed it. A trailing comma never changes the parse — output is byte-identical to the comma-free form — and it is **not** a way to pass an extra argument: `Number(x, y)` still raises the precise "takes exactly 1 argument" error (only a *lone* trailing comma is swallowed).

Implemented with three shared helpers so the rule is enforced uniformly rather than re-derived per call site: `parseDelimitedList` (empty-or-list with optional trailing comma), `parseCommaTail` (tail after an already-parsed first item — used by the operator-call object/positional paths), and `consumeTrailingComma` (swallow a *lone* trailing comma before a fixed-arity close). Spec: [docs/specs/grammar.md](specs/grammar.md) § Trailing commas (+ `","?` on the core EBNF productions); user doc: [docs/LANGUAGE.md](LANGUAGE.md) § Trailing commas; tests: the `trailing commas (JS syntax)` block in [test/codegen.test.ts](../test/codegen.test.ts).

---

## 2026-06-14 — docs: jsmql never invents its own `$`-operators; `continue` keyword rejected

Recorded a standing language-design axiom in [CLAUDE.md](../CLAUDE.md) § "Things the user did not explicitly ask for but matter" (with a one-line pointer from [src/CLAUDE.md](../src/CLAUDE.md) next to the `src/operators.ts` SSOT bullet): **jsmql never mints its own `$`-prefixed operators or pseudo-stages.** Every `$`-named callable maps to something that already exists in MongoDB — a real operator via the `$op(...)` escape hatch (backed by `src/operators.ts`), or a real pipeline stage (`$match`, `$project`, …). A convenience like `$drop(pred)` that lowered to `$match(!(pred))` will **never** be added, however handy it looks: it fabricates a `$name` that isn't a MongoDB operator (breaking the "every `$op` is a real op" model and the paste-raw-MQL round-trip property), and it's a second spelling for a capability that already has one (the friction in `feedback_no_silent_output_drift.md`). New ergonomics go into JS-idiomatic surface — a JS method, or destination-visible sugar over a real stage (`$$.push(…)` → `$unionWith`) — never a brand-new `$foo()`.

Context: we evaluated adding a JS `continue` keyword (`if (<expr>) continue;` → `$match(!(<expr>))`, the loop-as-pipeline idiom). The lowering intuition was correct and verified on a running `mongod`, **but the surface syntax is a hard JavaScript `SyntaxError`** — `continue` outside a loop fails `node --check` in every framing (bare, arrow block-body, braced), which the #2 "strict subset of JavaScript" priority forbids outright. The `$op(...)`-style escape would have been `$drop(...)` — and that is exactly the invented-operator the new axiom rules out. Net result: no `continue`, no `$drop`; the capability already exists as `$match(!(cond))`. No code or behaviour change in this entry — governance only.

---

## 2026-06-14 — feat: the `function` keyword — usable everywhere arrows are (closes DEF-030)

The JS `function` keyword is now accepted as a **second spelling** of the reusable-function / lambda surface, in every position an arrow works: a declaration (`function double(x) { return x * 2 }`), an inline callback (`.map(function (x) { return x * 2 })`), an IIFE (`(function (x) { return x * 2 })(5)`), and the entry form (`jsmql(function ($) { return $.age >= 18 })` / `jsmql.compile(function (p, $) { … })`). This closes **[DEF-030]** — and goes beyond its original "declaration only" scope to the full surface, at the developer's request ("everywhere"). The keyword form lowers to **byte-identical** MQL to the arrow equivalent; verified end-to-end on a running `mongod` (declaration pipeline, inline `$map`, entry-form Filter).

The whole feature is **front-end only** — it produces the same `Lambda` / `FuncDecl` / `ExprBlock` nodes arrows already produce, so codegen, the IIFE→`$let` machinery, the recursion guard, and pipeline scoping are untouched. `function` is deliberately **not** promoted to a lexer keyword (that would break `{ function: $.x }` object keys and `$.function` field paths — the same pre-existing gap that rejects `{ return: 1 }`); the parser intercepts the identifier *by value* in `parsePrimary` (value position), `collectStatement` / `parseArrayLiteral` (declaration), and `parseFunctionInput` (entry). New parser helpers: `parseFunctionExpr` (+ a shared `parseParenParamNames` factored out of `parseLambdaParen`) and `parseFunctionDeclStatement`. A `FuncDecl` gains a `form: "arrow" | "function"` discriminator (codegen ignores it).

Two deliberate semantics: (1) a `function` declaration is **self-terminating** — its closing `}` ends the statement (no `;` needed before the next), JS-style, and forces Pipeline mode like `$ = …`; driven by `form === "function"` in the three statement loops. (2) A single-`return` body normalises at parse time to a plain expression-body `Lambda` (`function (x) { return E }` ≡ `(x) => E`), so it is identical everywhere — including the query-translation predicate positions (`$$$.coll.find/filter`, `$$.filter`, stream `.filter`) which translate a `body` expression; a body with leading `const`/`let` keeps the `exprBlock` (→ nested `$let`) and is rejected in a predicate position with guidance. As a bonus, the entry block-body grammar was reconciled: a `{ return <expr> }` entry body is now the value form for **both** `function` and arrow inputs, fixing the long-broken `jsmql(($) => { return … })` (the dead `rejectReturn`, which checked `TokenType.Ident` while the lexer emits `TokenType.Return`, is now a live, actionable check for a stray `return` in a pipeline body). `async function` and generator `function*` are rejected with a pointer to the plain form, matching the arrow restrictions. Files: [src/parser.ts](../src/parser.ts), [src/ast.ts](../src/ast.ts) (`FuncDecl.form`), the five predicate translators ([lookup](../src/lookup-translation.ts)/[pipeline](../src/pipeline.ts)/[out](../src/out-translation.ts)/[facet](../src/facet-translation.ts)) (now-reachable "missing body" throws became actionable rejections), [docs/specs/reusable-functions.md](specs/reusable-functions.md), [docs/specs/grammar.md](specs/grammar.md), [docs/LANGUAGE.md](LANGUAGE.md), [README.md](../README.md), [docs/DEFERRED.md](DEFERRED.md) (DEF-030 closed), [test/functions.test.ts](../test/functions.test.ts) (+ updated codegen/error-pos/implicit-pipeline tests).

---

## 2026-06-14 — feat(playground): a "Share" button copies a self-contained link

The playground gained a **Share** button — a share glyph + "Share", right-aligned in the **jsmql input** panel label — that copies a link reproducing the current session for whoever opens it — the Variables editor, the query, **and** the active compile mode (mode is what decides the output shape, so the recipient sees the exact same MQL). The session — the same `{ input, vars, mode }` shape the 2026-06-13 localStorage persistence already uses — is JSON-serialised, UTF-8 → **base64url** encoded (so multi-byte chars and the `+ / =` bytes survive inside a fragment), and carried in a `#s=<payload>` URL hash with a `v:1` tag for forward-compat. The hash, not a query string, keeps the payload off the GitHub-Pages server; it can't collide with example `#slug` links because `makeSlug` only emits `[a-z0-9-]`, so the `s=` marker is unambiguous (`slugFromHash` now returns null for it).

Opening a share link is the new **top rung of the restore ladder**: a `#s=` link wins over a saved localStorage session, an example `#slug`, and the first-example default. `applySharedSession` loads the three editors then normalises the URL (drops the consumed hash via `writeHash(null)`) — the snapshot already lives in the editors and, via the `setValue`→`change`→`saveState` hooks, in localStorage, so the link shouldn't linger and go stale on the next edit. A pasted link in an already-open tab is handled by the same helper from the `hashchange` listener. Malformed payloads decode to `null` and fall through to the normal ladder rather than blanking the page; an unknown mode coerces to `auto`, matching the localStorage path. Clipboard + feedback ("Link copied!" / "Copy failed") reuse the output-panel Copy pattern and its secure-context requirement.

No library code changed — purely playground UX, authored in the hand-written [playground_skeleton.html](../playground_skeleton.html) (`toB64Url`/`fromB64Url`/`encodeSession`/`buildShareUrl`/`parseShareHash`/`applySharedSession`, the Share button + handler, the `slugFromHash` guard, and the restructured init/`hashchange` blocks); `scripts/sync-playground.mjs` regenerated [playground.html](../playground.html). Verified by syntax-checking the generated module and round-tripping the codec through a multiline + `new Date` + Unicode + non-ASCII payload plus the malformed/unknown-mode/non-share-hash cases (13 checks).

---

## 2026-06-14 — feat(playground): examples toggle lives on the panel; hotkey ⌘E

The examples-sidebar toggle moved out of the page header and onto the Examples panel itself. When the panel is open, a compact `Hide ⌘E` button sits to the left of the `EXAMPLES` heading; when collapsed, a `Show examples ⌘E` button appears on the left, inside the input panel's label, so there is always exactly one toggle visible and it reads against the thing it controls. Both share one `.examples-toggle` style (replacing the old header `.header-action` rule), and `#show-sidebar` is gated to `main.sidebar-collapsed` so the open/closed affordances never both show. The header is now just the title + syntax-reference link.

Also dropped the `95 (19 filt · 34 pipe · 42 expr)` count line from the panel header (and the JS that computed it — `countEl`, `itCount`, the per-kind tally) as noise no one reads, and rebound the toggle hotkey from ⌘B to **⌘E** (`key === "e"`, both button hints, the help comment). No library code changed — purely playground UX, authored in [playground_skeleton.html](../playground_skeleton.html) and regenerated into [playground.html](../playground.html) via `scripts/sync-playground.mjs`.

---

## 2026-06-14 — feat(playground): line numbers in the input and output editors

Both CodeMirror panes — the **jsmql input** (left) and the **MQL output** (right) — now show a line-number gutter (`lineNumbers: true`). Purely a readability aid for multi-line pipelines and their emitted MQL; no library code changed.

The gutter is themed to the page: `.CodeMirror-gutters` uses the `--bg` background with a `--border-strong` divider, and an error-panel variant (`.panel.error .CodeMirror-gutters` / `-linenumber`) keeps it consistent when the output pane is in its error state. The line numbers themselves are deliberately prominent — dark (`#1a1a1a`), `font-weight: 600`, full opacity. The selector is `.cm-s-neo .CodeMirror-linenumber` rather than a bare `.CodeMirror-linenumber`: the neo theme ships its own theme-scoped rule that otherwise out-specifies a plain selector and washes the numbers back to grey. The existing sidebar-toggle `refresh()` calls already re-measure the new gutter width, so no layout fix was needed.

Authored in the hand-written [playground_skeleton.html](../playground_skeleton.html); `scripts/sync-playground.mjs` regenerated [playground.html](../playground.html).

---

## 2026-06-14 — feat(playground): LOC + byte-size counters in both panel headers

Each panel header now carries a live size figure: the **jsmql input** label reads `jsmql input  3 LOC, 187 B` and the **MQL output** label reads `MQL output  49 LOC, 728 B`. The side-by-side numbers make the playground's core pitch legible at a glance — how much terser the JSMQL source is than the MQL it expands to. This **replaces** the old `(Node/Deno/Bun)` hint in the output label (the where-it-runs note was low-value next to a concrete size delta).

`statsOf(text)` computes both: `text.split("\n").length` for LOC and `new Blob([text]).size` for an exact UTF-8 byte count, formatted as `<N> B` under 1 KB else `<N.N> KB`. Input stats update from the editor source on every `render()` (so they track typing live); output stats are set only on the success branch from the *rendered* MQL string — so the figure follows the Prettify toggle (a fair LOC comparison wants the pretty-printed shape), and an empty or error panel clears the figure since its text is a message, not MQL. Both clear to `""` so a fresh/empty session reads just `jsmql input` / `MQL output`.

Purely playground UX — no library code changed. Authored in [playground_skeleton.html](../playground_skeleton.html) (new `.label-stats` span in each header, the `statsOf` helper, and the per-branch wiring in `render()`); `scripts/sync-playground.mjs` regenerated [playground.html](../playground.html). Verified by syntax-checking the generated module and confirming the figures on a real 3-stage pipeline (3 LOC/187 B → 49 LOC/728 B).

---

## 2026-06-14 — fix: bare `$ = <expr>` (no `;`) now emits `$replaceWith`, not `$set` on the `""` field path

A root-replace `$ = <expr>` written as the **only** statement (no trailing `;`) was lowering to `[{ $set: { "": <expr> } }]` — a `$set` on an empty-string field path — instead of the `$replaceWith` its `;`-terminated twin produces. The cause: without a `;`, the parser yields a one-op `UpdateFilter` (not a `Pipeline`), so the assignment never reached `tryLowerAssignSugar` / `lowerReplaceRoot`; `generateUpdateFilter` then treated the bare `$` target (`FieldRef { path: "" }`) as an ordinary field update. The empty-key `$set` is meaningless/invalid MQL, so this violated HR3.

Fix: a new `updateFilterHasReplaceRoot` (in [src/pipeline.ts](../src/pipeline.ts), beside `isReplaceRootAssign`) detects a `$ = …` op inside an UpdateFilter, and [src/index.ts](../src/index.ts) reroutes such an UpdateFilter through `generateImplicitPipeline` — wrapping it as a one-statement `Pipeline`, which reproduces the `;`-form exactly (full reuse of `lowerReplaceRoot`: `$replaceWith`, the array fan-out, and the non-document/compound-assign rejections all carry over). This is the **same reroute the `$out` sugar already uses** (`containsOutAssign`), added in the two parallel spots: `lowerProgram` (covers `jsmql()` + `jsmql.expr()`) and `lowerToPipelineStages` (covers `jsmql.pipeline()` + `jsmql.update()`, where `$replaceWith` is whitelisted). `jsmql.filter()` now rejects a bare `$ = <expr>` with a root-replace-specific message instead of the generic "update-op chain" one. Normal field updates (`$.x = 1`, `$.x = 1, $.y = 2`) are untouched (the reroute only fires when a `$ =` op is present). Verified end-to-end on a running `mongod` (`$ = { a: 1, b: $.x }` over `{x:7,junk:1}` → `{a:1,b:7}` — root replaced, extra fields dropped). Files: [src/pipeline.ts](../src/pipeline.ts), [src/index.ts](../src/index.ts), [docs/specs/replace-root-stage.md](specs/replace-root-stage.md), [test/pipeline.test.ts](../test/pipeline.test.ts).

---

## 2026-06-13 — feat: `Object.assign(target, …)` mutates at statement position

A bare `Object.assign(target, ...sources)` statement now lowers as JavaScript's *mutating* merge — it writes the merged object back into `target` — where `target` may be a writable document field (`$.profile`) **or** an in-scope `let`/`const` binding. Before this, a statement-position `Object.assign(...)` fell through to the generic pipeline path and threw "Element N of pipeline is not a recognised stage", even though the expression form (`Object.assign(a, b)` → `$mergeObjects`) already worked everywhere else. Reported as a bug against the JS-idiomatic build-up pattern `const result = {}; Object.assign(result, { … });`.

Lowering: a new `classifyObjectAssignStmt` (in [src/pipeline.ts](../src/pipeline.ts)) runs in both pipeline loops right after the array-mutator rewrite. A **field-path** target becomes a synthetic `AssignExpr { target, value: <the ObjectCall> }` (the call's first arg *is* the target, so it generates `$mergeObjects[<read>, ...sources]`) and rides the same `$set` coalescer as `$.x = …` and `.push`/`.sort`. A **binding** target emits its own `{ $set: { "__jsmql.<name>": <gen> } }` directly — deliberately bypassing the `const`-reassignment guard in `tryLowerAssignSugar`, because mutating a `const`-bound object is legal JS (only *rebinding* via `=` is not), which is exactly what makes the reported `const result` case compile. An unusable target (no first arg, spread, object literal, undeclared identifier) throws an actionable `CodegenError` naming a valid target. Expression-position `Object.assign` is untouched. Verified end-to-end on a running `mongod` (both the field and binding shapes run and return the merged document). Files: [src/pipeline.ts](../src/pipeline.ts) (`classifyObjectAssignStmt` + both forEach loops, imports `isWritableFieldPath`), [docs/specs/update-filter.md](specs/update-filter.md), [docs/specs/let-bindings.md](specs/let-bindings.md), [docs/LANGUAGE.md](LANGUAGE.md), [README.md](../README.md), [test/codegen.test.ts](../test/codegen.test.ts), [test/let-bindings.test.ts](../test/let-bindings.test.ts).

---

## 2026-06-13 — feat: reusable named functions (`const f = (a) => …`) → inline IIFE/`$let` per call

A pipeline can now **name** an arrow function and call it by name — `const addressToString = (a) => …; $ = { senderAddress: addressToString($.sender.address), … }`. Conceptually a **named IIFE**: the declaration emits nothing (it registers `name → lambda` in a compile-time table and is otherwise erased); each call expands the body INLINE at the call site through the existing IIFE → `$let` machinery, **re-lowered per call** (two calls → two independent `$let` blocks, no hoisting/CSE). Same input → same output; no data-dependent shape drift. Verified end-to-end on a running `mongod` — the address formatter, a `money()` helper reused across three fields, free-`$.field` capture, the empty-vars zero-param `$let`, and the `$match`/`$expr` form all run and return correct values.

The whole feature rides on one syntactic fork: a `const`/`let` whose initialiser is an arrow function becomes a `FuncDecl`; any other initialiser stays the existing value-binding `LetDecl`. So it reuses the IIFE codegen verbatim — the only new parts are *naming* a lambda (`GenerateCtx.functions`) and *resolving a call* back to it (a `ParamRef`-callee branch in `generateCallExpression`, sharing the body-lowering with the IIFE path via a new `applyLambda`). A recursion guard (`GenerateCtx.expandingFns`) rejects direct/mutual recursion (MQL expressions can't recurse). Functions are pipeline-scoped like `let`s (need a `;`), declaration-before-use, may close over `$`/in-scope lets, and compose (one may call another declared earlier). Bodies can be expression or block (`{ const …; return … }`, reusing the block-body `$let` fold). A declared-but-uncalled function leaves output byte-identical. The parser also gained unparenthesised single-param arrow-RHS recognition (`const f = x => …`), which `parseExpression` didn't handle.

Scoped to arrows for the first cut, per the developer's call. Deferred with permission: the `function` keyword form ([DEF-030], a friendly redirect fires), function-aware Filters via textual inline ([DEF-031], since a bare Filter has no pipeline scope to host the binding), and higher-order use / function-as-value ([DEF-032], rejected with guidance toward `x => f(x)`). Actionable errors for arity, recursion, unknown name (with `didYouMean`), function-as-value, the `function` keyword, re-declaration, name clashes, nested-in-arrow-body, and declaration-outside-a-pipeline — all carry a real `.pos`. Files: [src/ast.ts](../src/ast.ts) (`FuncDecl`, `Lambda` alias), [src/parser.ts](../src/parser.ts), [src/codegen.ts](../src/codegen.ts), [src/pipeline.ts](../src/pipeline.ts), and the LetDecl-parallel skips in [src/literal-gate.ts](../src/literal-gate.ts) / [src/match-translation.ts](../src/match-translation.ts) / [src/stage-validation.ts](../src/stage-validation.ts) / [src/stream-methods.ts](../src/stream-methods.ts) / [src/out-translation.ts](../src/out-translation.ts) / [src/union-translation.ts](../src/union-translation.ts) / [src/lookup-translation.ts](../src/lookup-translation.ts); [docs/specs/reusable-functions.md](specs/reusable-functions.md) (new), [docs/specs/let-bindings.md](specs/let-bindings.md), [docs/LANGUAGE.md](LANGUAGE.md), [docs/DEFERRED.md](DEFERRED.md), [README.md](../README.md), [test/functions.test.ts](../test/functions.test.ts) (new), [test/realistic.test.ts](../test/realistic.test.ts).

---

## 2026-06-13 — feat(playground): persist the query + Variables across a page refresh

The playground now remembers what you were working on. On every edit it writes the query editor, the Variables editor, and the active compile mode to `localStorage` (`jsmql-playground:session:v1`); on load it restores them, so a refresh no longer snaps you back to the first example and discards your work. Restore priority, in order: (1) a URL hash that targets a real example still wins — a shared/explicit `#slug` link loads that example, and the hash is only present when viewing an *unmodified* example (free editing clears it via `clearActiveOnUserEdit`); (2) otherwise a saved free-form query is restored, together with the compile mode it was last rendered with so the MQL output matches exactly what you left; (3) otherwise the first example loads, as before. The **Variables** editor is independent of which example/query is shown, so it's restored on *every* load path — including when a hash example is loaded — because variables you typed shouldn't vanish just because you followed an example link. A deliberately-cleared editor (saved query blank) falls back to the first example rather than leaving a blank page; an unknown saved mode coerces to `auto`.

Persistence is best-effort: both `localStorage` calls are wrapped, so storage being unavailable (private mode, disabled cookies, a sandboxed iframe) silently degrades to the old no-restore behaviour instead of throwing. No library code changed — this is purely playground UX, authored in the hand-written [playground_skeleton.html](../playground_skeleton.html) (`saveState`/`loadState`, the change-handler save hooks, and the restructured init/restore block); `scripts/sync-playground.mjs` regenerated [playground.html](../playground.html). Verified by syntax-checking the generated module and running the restore-priority decision table (free-form restore, hash-wins, vars-survive-hash, first-visit, cleared-editor, dead-hash, bad-mode) through a stubbed harness.

---

## 2026-06-13 — fix: actionable parser error for a non-key expression in an object literal

Writing an expression where an object key is expected — e.g. a bare ternary `{ ...base, $.flag == null ? {} : { … } }` (invalid JS; a common slip when reaching for a conditional spread) — produced a bare, dead-end "Expected object key at position N". The message now names the offending token (`'$.'`, via `formatActualToken`), states that an object entry must be `` `key: value` ``, a shorthand `` `key` ``, or a spread `` `...expr` ``, and points at the fix: spread a ternary, `{ ...base, ...(cond ? { … } : {}) }` — which is the valid form that already compiles. `.pos` and the position embedded in the message are the same token offset, so editor underlining and the human-readable text never disagree. Honours the strict-JS-subset rule (#2): jsmql still rejects the invalid input — it just explains *why* and *what to write instead*. Files: [src/parser.ts](../src/parser.ts) (`parseObjectEntry`), [test/error-pos.test.ts](../test/error-pos.test.ts).

---

## 2026-06-12 — feat: block-body arrows with local `const`/`let` (`x => { const a = …; return … }` → nested `$let`)

A lambda body may now be an **expression block** — `(x) => { const a = …; const b = f(a); return g(a, b); }` — anywhere a lambda is a value: the array methods (`.map`/`.filter`/`.reduce`/`.flatMap`/`.find`/`.some`/`.every`/…), the `$let(vars, fn)` escape hatch, the IIFE form, `Object.groupBy`, and `Array.from`. Each declaration lowers to one `$let` binding, **right-folded in source order**, so a later `const` can read an earlier one (MongoDB's `$let.vars` are mutually invisible, so a single shared block won't do). This is a faithful 1:1 lowering — every `const`/`let` becomes exactly one `$let`, deterministically; it is **not** the rejected "$let-as-optimisation" (no dependency analysis, no value-preserving rewrite the compiler chose). Motivated by a real query reconciling per-leg risk recommendations (per-party SSTM-vs-CRE comparison) that read awkwardly without local bindings. Verified end-to-end on a running `mongod`: the full reconstructed query fans out one document per qualifying leg with the correct field values.

**Disambiguation is JS-faithful (the deliberate choice): `=> {` always opens a block.** An object return must be parenthesised — `x => ({ k: v })`, never `x => { k: v }` (which is a labeled-statement block in JS, so jsmql rejects it with no `return` and points at the paren form). Previously `=> {` in array-method position was parsed as a bare object-return; a repo-wide survey found **zero** bare-brace object lambdas (all 99 already use `=> ({…})`), so the change broke nothing while removing a standing strict-JS-subset (#2) divergence. New AST node `ExprBlock` on `Lambda` (distinct from the lookup `block: Pipeline`); new `return` keyword token (still usable as a property name / object key, matching JS); parser threads a `blockKind` (`"expr"` default, `"pipeline"` for the lookup `find/filter` positions); codegen `generateExprBlock` + the `genLambdaBody`/`lambdaResult` helpers route every consumer. Re-declaring a name or omitting `return` are actionable errors; `.toSorted`/`.sort` key functions still require a bare expression. The top-level function-form arrow (`jsmql.expr(($) => { … })`) is a separate parse path and is unchanged (still expression-only).

Known, **pre-existing** (not introduced here) fidelity gap surfaced while verifying: a value computed via `$getField` (a dynamic/optional bracket access like `$.cre?.result?.[party]?.rec`) that resolves to *missing* tests as **truthy** under jsmql's `&&`/`||`/ternary coercion — unlike JS `undefined` — because a `$let`-bound (or `$getField`) missing compares `!== null` as true, whereas a missing *field path* coerces to null. The identical discrepancy reproduces inline without any block body, so block-body binding neither introduces nor regresses it; tracked as a separate `$getField`-missing-truthiness fix. Files: [src/lexer.ts](../src/lexer.ts), [src/parser.ts](../src/parser.ts), [src/ast.ts](../src/ast.ts), [src/codegen.ts](../src/codegen.ts), [src/pipeline.ts](../src/pipeline.ts), [src/lookup-translation.ts](../src/lookup-translation.ts), [docs/specs/method-dispatch.md](specs/method-dispatch.md), [docs/specs/grammar.md](specs/grammar.md), [docs/LANGUAGE.md](LANGUAGE.md), [README.md](../README.md), [test/codegen.test.ts](../test/codegen.test.ts), [test/realistic.test.ts](../test/realistic.test.ts).

---

## 2026-06-12 — feat: comparison operators require exactly 2 operands in aggregation position

`$gt($.x)` (one operand) and `$gt($.a, $.b, $.c)` (three) compiled to `{ $gt: … }` shapes the server rejects in an aggregation expression ("$gt takes exactly 2 arguments"). The six comparison operators (`$eq`/`$ne`/`$gt`/`$gte`/`$lt`/`$lte`) now carry an **aggregation-only** exact-2 arity rule. The "aggregation-only" part is the crux: as a **query predicate** under a field, the single-value form `{ field: { $gt: v } }` — and even the array form `{ field: { $gt: [1, 2, 3] } }`, comparing against the array — is valid MQL (verified on `mongod`), so a blanket reject would be a false positive on valid query code (e.g. `jsmql("{ age: $gt($.x) }")`).

The fix threads a new `aggExpr` flag on `GenerateCtx`, set at aggregation-expression positions (`jsmql.expr` and every non-`$match` stage body) and unset in query field-value position; the comparison arity (`aggOnly: true`) fires only when it's set. Default-off is the HR3-safe direction — a missed agg position just under-validates (the server still rejects), and it never false-positives on a query. The accumulator-dual flex ops (`$max`/`$min`/`$sum`/`$avg`/`$stdDev*`) deliberately get **no** arity rule (their 1-arg form is the valid accumulator form). The previously-documented "flex single-value form" tests asserted the now-rejected `jsmql.expr("$gt($.x)") → { $gt: "$x" }` (invalid aggregation MQL); they're reframed to assert the throw in aggregation position and the valid `{ field: $gt(v) }` query form. Files: [src/codegen.ts](../src/codegen.ts) (`GenerateCtx.aggExpr`), [src/operators.ts](../src/operators.ts), [src/operator-validation.ts](../src/operator-validation.ts), [src/index.ts](../src/index.ts), [src/pipeline.ts](../src/pipeline.ts), [docs/specs/operator-validation.md](specs/operator-validation.md), [test/codegen.test.ts](../test/codegen.test.ts), [test/literal-passthrough.test.ts](../test/literal-passthrough.test.ts).

---

## 2026-06-12 — feat: enum validation on operator slots (timeUnit, weekday, BSON type, regex flags, method, lang)

A closed-string-set slot outside its allowed values (`$dateAdd unit: "fortnight"`, `$convert to: "intt"`, regex `options: "g"`, `$median method: "exact"`, `$function lang: "python"`) compiled to MQL the server rejects with an opaque `FailedToParse`. The operator-arg validator now checks these via an `enums` rule per operator. Each enum's exact behaviour was verified on `mongod` and encoded accordingly: **timeUnit** is case-sensitive lowercase (the server rejects `"Day"`); **weekday** (`startOfWeek`) is **case-insensitive** (`"Monday"` is valid, so the check lowercases before comparing — a case-sensitive check would have been a false positive); **bsonTypeName** is the full `$type`/`$convert` alias set (all recognised by `$convert.to`, even `minKey`/`maxKey`), and a numeric type code is a non-string so it's skipped; **regexFlags** is a per-character charset check over `i`,`m`,`x`,`s` (a JS `g`/`y` flag is named in the error); inline sets cover `method: ["approximate"]` and `lang: ["js"]`. Typo'd values get a `didYouMean` suggestion (`"intt"` → `int`, `"funday"` → `sunday`). The gate holds — a runtime/field-ref slot value compiles untouched. `$meta`'s keyword enum is deferred (single-shape + version-dependent set). Files: [src/operators.ts](../src/operators.ts), [src/operator-validation.ts](../src/operator-validation.ts), [docs/specs/operator-validation.md](specs/operator-validation.md), [test/codegen.test.ts](../test/codegen.test.ts), [test/literal-passthrough.test.ts](../test/literal-passthrough.test.ts) (enum slots seeded with valid sample values).

---

## 2026-06-12 — feat: fixed / bounded operand-count validation on array & flex operators

`$divide(6, 2, 1)`, `$arrayElemAt($.a, 0, 1)`, `$substrCP($.s, 0, 2, 3)` compiled to operand lists the server rejects ("takes exactly N arguments, M were passed in"). The operator-arg validator now checks the **effective operand count** for array/flex operators that declare an `arity` rule — the positional count, or the single-array-literal element count for the `$op([a, b])` form (HR2), so `$cmp([1, 2, 3])` is caught the same as `$cmp(1, 2, 3)`. Routed through the shared `checkArity` formatter, so the wording matches the `.foo()` method family. Degenerate cases defer to codegen (a lone non-array scalar keeps the existing `listOperandError`; 0 args keeps "at least 1"). Declared counts: exact-2 (`$divide`/`$mod`/`$pow`/`$log`/`$subtract`/`$atan2`/`$cmp`/`$split`/`$strcasecmp`/`$arrayElemAt`/`$setDifference`/`$setIsSubset`), exact-3 (`$substr`/`$substrBytes`/`$substrCP`), ranges (`$indexOf*` 2–4, `$range`/`$slice` 2–3, `$round`/`$trunc` 1–2), and `$ifNull` min-2. **Open-ended variadic operators get no rule** ($add/$multiply/$concat/$setUnion/…) — a min check there would be a false positive (the server accepts any count). All rejections verified against a running `mongod` (incl. `$ifNull` with 1 operand: "needs at least two arguments"). Files: [src/operators.ts](../src/operators.ts), [src/operator-validation.ts](../src/operator-validation.ts), [docs/specs/operator-validation.md](specs/operator-validation.md), [test/codegen.test.ts](../test/codegen.test.ts), [test/literal-passthrough.test.ts](../test/literal-passthrough.test.ts) (synthetic calls arity-padded).

---

## 2026-06-12 — feat: infer array-method lambda *element* type so `element[key]` lowers precisely

Follow-on to the bare-root bracket fix below. A lambda parameter is a variable, not a literal, so `$.cre.result[party]` inside `["sender","recipient"].map(party => …)` still emitted the runtime `$isArray` guard — even though `party` is *provably* always a string (it iterates an all-string-literal array). jsmql simply never inferred the element type of a lambda parameter: `.map`/`.filter`/etc. added the param to the in-scope `lambdaParams` set but left `bindingTypes` untouched, so the `keyIsString` shortcut (which already fires for string literals, `.toLowerCase()` results, and `const k = "…"`) couldn't see it. The guard is valid and short-circuits correctly on every engine tested, but it carries the same dead `$arrayElemAt`-with-string-index branch that some servers reject — so proving the type is both leaner and removes that latent footgun for the whole map family.

Fix: type the lambda's **element** parameter from the input array's static element type. `arrayElementType(expr)` returns the uniform element type of an array-valued expression (`["a","b"]` → `"string"`, `[{},{}]` → `"object"`, `[[1],[2]]` → `"array"`; `.split(",")` and `Object.keys` → `"string"`; mixed/empty/spread/unknown → `undefined`). `elementTypedCtx(ctx, params, inputExpr)` wraps `extendCtx`, sets `params[0]` to that type, and clears every lambda-param name from `bindingTypes` first so a shadowed outer binding can't leak in (the index param `params[1]` is a number — only ever cleared). Threaded through the shared `arrayIterInput` helper (`.map`/`.filter`/`.find`/`.findLast`/`.some`/`.every`/`.flatMap`), the `.findIndex`/`.findLastIndex` case, and inline in `.reduce`/`.reduceRight` (element is `params[1]` there). The inference only ever *removes* a guard it can prove redundant — a numeric or unknown-typed element keeps the runtime `$isArray` dispatch — so it can't change a genuinely-ambiguous lowering. With it, the SSTM-vs-CRE reconciliation query compiles guard-free (zero `$isArray`/`$arrayElemAt`); verified end-to-end on a running `mongod` (classic + SBE) with correct values. Files: [src/codegen.ts](../src/codegen.ts) (`arrayElementType`, `elementTypedCtx`, `arrayIterInput`, reduce/findIndex cases), [docs/specs/method-dispatch.md](specs/method-dispatch.md), [docs/LANGUAGE.md](LANGUAGE.md), [test/codegen.test.ts](../test/codegen.test.ts), [test/realistic.test.ts](../test/realistic.test.ts).

---

## 2026-06-12 — feat: literal-type validation on date slots; close DEF-029

Closes **DEF-029**. A literal non-date in a date slot (`$year("2020-01-01")`, `$dateAdd({ startDate: "2020-01-01", … })`, `$dateTrunc({ date: "2020", … })`) compiled to MQL the server rejects ("can't convert from BSON type string to Date"). The operator-arg validator now carries a literal-type checker (`literalKind` + `checkArgType`, driven by `singleType` / `elementType` / `positionalTypes` / `keyTypes` on `ArgRules`) and the date accessors get `singleType: "date"`, the date operators `keyTypes` (`startDate`/`endDate`/`date` → date, `amount` → int-or-long, `timezone` → string, `binSize` → number). The §A DEF-029 row is deleted and every `[DEF-029]` tag stripped in this commit (the drift gates require both).

Two subtleties, both verified on `mongod`: (1) a **`$`-prefixed string is a field reference** (HR1), not a string value, so `$year("$createdAt")` is valid and must NOT be rejected — `literalKind` returns null for `"$…"` strings; `new Date(…)` lowers to `{ $toDate: … }` (a non-literal) so it passes the gate too; `null` is accepted by the server (yields null) so it's allowed. (2) **string slots are deliberately not type-checked** — MongoDB coerces inconsistently (`$toUpper(5)` accepted, `$strLenBytes(5)` rejected), so a blanket `string` rule would false-positive; the `string` type is used only on slots verified to reject a non-string (date-operator `timezone`). The numeric/bitwise/object/array/timestamp families land next. Files: [src/operators.ts](../src/operators.ts), [src/operator-validation.ts](../src/operator-validation.ts), [docs/specs/operator-validation.md](specs/operator-validation.md), [docs/DEFERRED.md](DEFERRED.md) (DEF-029 row removed), [test/codegen.test.ts](../test/codegen.test.ts).

---

## 2026-06-12 — feat: literal-type validation on numeric / bitwise / object / array / timestamp slots

Extends the literal-type checker (shipped for date slots alongside the DEF-029 close) to the rest of the verified type families: single-shape numeric ops (`$abs`/`$sqrt`/`$sigmoid`/the trig family — `singleType: "number"`), variadic numeric (`$multiply`) and numeric-or-date (`$add`/`$subtract` — `elementType`), bitwise int-or-long (`$bitNot` single; `$bitAnd`/`$bitOr`/`$bitXor` elements), `$mergeObjects`/`$objectToArray` (object), `$size`/`$reverseArray` (array), and `$tsSecond`/`$tsIncrement` (timestamp). The fixed-binary arithmetic ops ($divide/$mod/$pow/$log/$atan2/$round/$trunc) gained `elementType: "number"` alongside their arity rule. Each reject was verified on a running `mongod` — including that MongoDB does **not** coerce (`$abs("5")` and `$add(1, true)` are both rejected). The gate holds: a field ref / `$`-string field path / `new Date(…)` / `null` compiles untouched. Three pre-existing codegen tests used `$abs([…])`/`$abs({…})` as a generic single-arg wrapper to probe array/object-literal codegen — an invalid-MQL fixture — and were switched to the `$foo` unknown-op shape probe. Files: [src/operators.ts](../src/operators.ts), [docs/specs/operator-validation.md](specs/operator-validation.md), [test/codegen.test.ts](../test/codegen.test.ts).

---

## 2026-06-12 — feat: object-form operators validate required + unknown keys (`$dateAdd({ startdate })` → "Did you mean 'startDate'?")

Object-form `$op({ … })` calls routed through codegen with **zero** key validation — `$dateAdd({ startDate: $.t })` (missing `unit`+`amount`), `$cond({ iff, then, else })` (typo), `$convert({ input })` (missing `to`) all compiled to MQL the server rejects. The operator-arg validator now enforces, for every object-shape operator that declares rules: **required keys** (a missing one throws `'$op' requires the 'k' field, but it is missing.`) and the **closed key set** (`required ∪ optional`; an out-of-set key throws with a `didYouMean` suggestion). Unknown-key is checked *before* required, so a typo of a required key (`iff`) is named with its suggestion rather than reported as a bare "requires 'if'". Rules live in a new `OPERATOR_ARG_RULES` table in [src/operators.ts](../src/operators.ts), attached to the registry via `withArgs` at load; positional calls are covered too (present keys = `keys.slice(0, argCount)`). Every required set was verified against a running `mongod` (e.g. `$accumulator` rejects a missing `accumulateArgs`, `$function` a missing `lang`, `$median` a missing `method`, `$convert` a missing `to`).

**Policy change (DX, approved):** object-style keys were previously documented as passed through verbatim "to allow optional or undocumented keys". They are now validated against the registry's closed set. Forward-compat escape hatches: `closedKeys: false` on an operator's rules, or an unknown (not-in-registry) operator name (still passes through). Updated [docs/specs/operator-registry.md](specs/operator-registry.md) §`object`. The literal-gating invariant holds — a spread body or a `flex`/`single` operator's lone object (a value, not named keys) is left alone. `$encStr*` (Queryable-Encryption-gated) and `$hash`/`$hexHash` (server 8.1+) are intentionally left unvalidated — unverifiable on a local mongod. One pre-existing test asserted a `$accumulator` shape missing the required `accumulateArgs` (a latent invalid-MQL assertion); corrected. Files: [src/operators.ts](../src/operators.ts), [src/operator-validation.ts](../src/operator-validation.ts), [docs/specs/operator-validation.md](specs/operator-validation.md), [docs/specs/operator-registry.md](specs/operator-registry.md), [test/codegen.test.ts](../test/codegen.test.ts).

---

## 2026-06-12 — feat: operator-argument validation subsystem; none-shape ops reject arguments

New compile-time validator for value-position `$op(...)` calls — the mirror of the stage-body validator. [src/operator-validation.ts](../src/operator-validation.ts) exposes `validateOperatorArgs(name, style, args, pos)`, called from `generateOperatorCall` ([src/codegen.ts](../src/codegen.ts)) after the spread guard and before shape dispatch. It is driven by a new optional `args?: ArgRules` dimension on `OperatorDef` ([src/operators.ts](../src/operators.ts)), attached with a `withArgs(def, rules)` wrapper (the sibling of `acc(...)`, so no factory signature changed). It reuses the shared [literal-gate](../src/literal-gate.ts) helpers and routes arity errors through the exported `checkArity`, so `$op(...)` errors read identically to the `.foo()` JS-method family. **Key difference from the stage validator: no constant-only inversion** — operator arg slots accept runtime expressions, so a non-literal is never a certain violation. See [docs/specs/operator-validation.md](specs/operator-validation.md).

First check shipped (this commit): **none-shape operators reject arguments.** `$rand` / `$createObjectId` / `$count` / `$rank` / `$denseRank` / `$documentNumber` take zero arguments, but codegen silently *dropped* any it was given — emitting a valid-but-unintended `{ $op: {} }` and hiding the user's misconception that the argument mattered (`$rand(1, 2)` → `{ $rand: {} }`). Now any argument throws (`$rand() takes no arguments, got 2`); the window ranking ops add a redirect to the `$setWindowFields` sortBy, where their order actually comes from. Arg count is always statically known, so this never produces a false positive. The `ArgRules` type declares the full forward surface (arity / type / object-key / enum / structural rules) that subsequent commits fill in per operator. Files: [src/operators.ts](../src/operators.ts), [src/operator-validation.ts](../src/operator-validation.ts), [src/codegen.ts](../src/codegen.ts), [docs/specs/operator-validation.md](specs/operator-validation.md), [test/codegen.test.ts](../test/codegen.test.ts).

---

## 2026-06-12 — feat(playground): a "Variables" editor demonstrates `jsmql.compile()`

The playground input panel gained an optional **Variables** editor (above the query editor) where a developer types a free-form JS object literal — `{ age: 18, startDate: new Date("2026-07-13") }`, NOT JSON, so `new Date(...)`/unquoted keys work — whose keys become bindings usable in the query (`$.age > age`, `$.createdAt >= startDate`). When ≥1 variable is named, the playground stops dispatching through the plain entry points and routes through their parameterised `.compile(...)` builders instead: it wraps the query into a compile-form arrow `({ age, startDate }) => { <query> }` and runs `COMPILE_FNS[mode](arrowSrc)(paramsObject)`. The "MongoDB call" hint updates to the real call shape — `db.coll.find(jsmql.filter.compile(...)({ age, startDate }))`. Empty (or a bare `{}`) means "no variables" and the playground behaves exactly as before, so every existing example is unaffected.

The block-body wrap reproduces the exact AST the plain entry points parse from the query for every shape (bare predicate, `;`-pipeline, update-op chain, raw filter doc), so output matches what `jsmql.compile` emits at a real call site (verified via node probes against `src/index.ts`). Validation goes through `jsmql.validate(arrowSrc)` (which accepts a compile-form arrow string and resolves bindings to null placeholders); error offsets are arrow-relative, so `render()` maps them back to the query editor by subtracting the generated prefix length before highlighting — an unknown-variable typo underlines the variable in the query, not the wrapper. A malformed variables object (eval failure, non-object, or a non-identifier / `$`-leading key) surfaces a precise inline error and blocks compilation rather than silently dropping the bindings. UI lives in the hand-authored [playground_skeleton.html](../playground_skeleton.html); `scripts/sync-playground.mjs` regenerated [playground.html](../playground.html). No library code changed — `jsmql.compile` and the strict-shape `.compile` builders already existed (see [docs/specs/function-form-params.md](specs/function-form-params.md)).

---

## 2026-06-12 — fix: `jsBool` truthiness now catches *missing*, not just `null` (HR3 — JS `undefined` is falsy)

jsmql's JS-truthiness coercion (`jsBool` in [src/codegen.ts](../src/codegen.ts), behind every `&&`/`||`/`!`/`?:`/`Boolean(x)`/predicate-method body) emitted `{$and:[{$ne:[v,null]}, {$ne:[v,false]}, {$ne:[v,""]}, {$ne:[v,0]}]}` — with a code comment claiming the `$ne:[v,null]` clause "catches null AND missing". **It does not.** MongoDB's aggregation `$eq`/`$ne` treat a *missing* value as distinct from `null` (`{$eq:["$absent",null]}` is `false`, verified on `mongod`), so a missing value tested as **truthy** — the opposite of JavaScript, where `undefined` is falsy. Concretely, `$.items.filter(x => x.name)` *kept* elements whose `name` was absent (it should drop them, exactly as it drops `""`/`0`/`null`). The fix wraps only the null-check operand in `$ifNull(v, null)` so missing collapses to null first: `{$ne:[{$ifNull:[v,null]},null]}`. The other three clauses keep the raw value (false/`""`/`0` are never "missing"), so the value isn't duplicated more than before. Verified on `mongod`: `.filter(x => x.name)` now drops both the missing-`name` and the `name:""` elements, and the block-body reconciliation query's `match: sRec && cRec ? "NO" : "N/A"` now yields `"N/A"` (not `"NO"`) when one side is an absent computed value.

This was pre-existing and orthogonal to block-body arrows — it reproduces inline (`($.cre?.result?.["x"]?.rec && true) ? "NO" : "NA"` returned `"NO"`) — but block-body `$let` bindings of optional-chain values made it easy to hit, so it was found while landing that feature and fixed straight after. The user-facing [LANGUAGE.md](LANGUAGE.md) "Truthy and falsy" table already listed "missing field → falsy", so the docs were *aspirationally* correct; this makes the implementation honest. Files: [src/codegen.ts](../src/codegen.ts), [docs/specs/grammar.md](specs/grammar.md), [test/codegen.test.ts](../test/codegen.test.ts), [test/realistic.test.ts](../test/realistic.test.ts), [test/match-translation.test.ts](../test/match-translation.test.ts), [test/out.test.ts](../test/out.test.ts), [test/stream-methods.test.ts](../test/stream-methods.test.ts) (the `truthy()` test helpers + inline truthy chains were updated to the corrected shape).

---

## 2026-06-12 — fix: computed bracket key on the bare root / object literal → `$getField` (no dead `$arrayElemAt` branch)

`$[k]` where `k` is a **computed** key (anything but a string literal) lowered to the runtime `$isArray` dual guard — `$cond: { if: $isArray($$ROOT), then: $arrayElemAt[$$ROOT, k], else: $getField{k, $$ROOT} }` — even though the bare root document is *always* a BSON object and never an array. The `then` branch is dead, but it carries `k` (a string field name) as an `$arrayElemAt` index, and MongoDB rejects a non-numeric `$arrayElemAt` index **at pipeline-optimization time** ("$arrayElemAt's second argument must be a numeric value, but is string"). The classic engine on some servers prunes the unreachable branch and runs fine; a stricter optimizer/engine (e.g. SBE, or another server version) folds it and throws — so the same input crashed on one `mongod` and worked on another. A clear HR3 violation (jsmql emitted MQL invalid for the known operand type). Surfaced by the per-leg SSTM-vs-CRE reconciliation query from the block-body-arrows work below: `$[SSTM_PROP[party]]` indexes the root by a field name read from a `const` map.

Fix: in the `IndexAccess` codegen, treat a receiver that is **provably never an array** — the bare root (`FieldRef`, `path === ""`) or an object literal (`isObjectProducing`) — as a known-object receiver for *any* key, emitting `$getField` directly and skipping the guard. This generalises the existing string-literal-on-root shortcut (`$["x"]` → `$x`) to computed keys, and the output is leaner (one `$getField`, no `$cond`). Verified end-to-end on a running `mongod`: the reconstructed reconciliation pipeline now optimizes and runs, returning one row per party with the right scores. One-line, single-site change. Files: [src/codegen.ts](../src/codegen.ts) (`IndexAccess` case), [docs/specs/method-dispatch.md](specs/method-dispatch.md), [docs/LANGUAGE.md](LANGUAGE.md), [test/codegen.test.ts](../test/codegen.test.ts).

---

## 2026-06-12 — fix: object-bodied stages reject a non-object literal body (`$group("externalId")` → throw)

`$group("externalId")` compiled to `{ $group: "externalId" }` — which `mongod` rejects ("a group's fields must be specified in an object") — instead of throwing. The per-stage validators bailed silently on a non-object body (`requireObjectBody` → `objectInfo` returns null on a string, so the validator no-oped). Now a new `requireObjectStageBody` guard (in [src/stage-validation.ts](../src/stage-validation.ts)) throws on a body that is a literal of a non-object kind (string / number / array / …) with an actionable "expects an object body … e.g. …" message, for **every** object-bodied stage: `$group`, `$project`, `$sort`, `$sample`, `$addFields`/`$set` (new validators), `$bucket`/`$bucketAuto`, `$setWindowFields`, `$fill`, `$densify` (new), `$graphLookup`, `$replaceRoot`, `$geoNear`, `$lookup`. `$unset` likewise now rejects a non-string/non-array literal body. Verified on `mongod`: the old emitted shapes (`{ $group: "externalId" }`, `{ $addFields: 5 }`, `{ $sample: 5 }`) are all server-rejected; the valid object forms run.

Per the literal-gating invariant the guard is a no-op on a field-ref / runtime-expression body (it could resolve to a value) and on `$merge`/`$unionWith` (a bare string is a valid collection name) — only a certain-wrong literal throws. Files: [src/stage-validation.ts](../src/stage-validation.ts), [docs/specs/pipeline-validation.md](specs/pipeline-validation.md), [test/stage-validation.test.ts](../test/stage-validation.test.ts).

---

## 2026-06-12 — refactor: every emitted `$cond` uses the object form `{ if, then, else }`

All internal `$cond` emissions now use MongoDB's named-key object form (`{ $cond: { if, then, else } }`) instead of the positional array form (`{ $cond: [test, then, else] }`). Both are valid MQL, but the object form is far easier to read when inspecting emitted output — which is the whole point: jsmql is a DX-first tool, and someone debugging a pipeline shouldn't have to remember that `$cond`'s array elements are `[if, then, else]` positionally. This mirrors the user-facing `$cond` operator, which already emits object form (registered with the `obj` shape factory in [src/operators.ts](../src/operators.ts)).

The change is purely the *shape* jsmql writes; behaviour is identical. A single `cond(ifExpr, thenExpr, elseExpr)` helper in [src/codegen.ts](../src/codegen.ts) now owns every emission (ternary, `&&`/`||` operand-preserving logic, the string-or-array runtime dispatches for `.length` / `.includes` / `.indexOf` / `.slice` / `.concat` / index access, `.join` / `.toString` reduce bodies, `.lastIndexOf`, `.findIndex`, `.padStart`, `Number.isInteger`, and negative slice-index normalisation). Two local variables previously named `cond` (the *test* expression) were renamed to `test` to avoid shadowing the helper. Verified on a running `mongod` that the ternary, string-or-array `.includes`, nested `Number.isInteger`, and operand-preserving `&&` shapes all run. Files: [src/codegen.ts](../src/codegen.ts), [docs/LANGUAGE.md](LANGUAGE.md), [docs/specs/grammar.md](specs/grammar.md), [docs/specs/method-dispatch.md](specs/method-dispatch.md), [test/codegen.test.ts](../test/codegen.test.ts), [test/realistic.test.ts](../test/realistic.test.ts), [test/match-translation.test.ts](../test/match-translation.test.ts), [test/let-bindings.test.ts](../test/let-bindings.test.ts), [test/stream-methods.test.ts](../test/stream-methods.test.ts), [test/literal-passthrough.test.ts](../test/literal-passthrough.test.ts).

---

## 2026-06-12 — refactor: extract the literal-gating helpers into `src/literal-gate.ts`

The literal-inspection + shared-check helpers that uphold the literal-gating invariant (`litNumber` / `litString` / `litBool` / `describeLiteral` / `objectInfo` / `arrayElements` / `requireKeys` / `requireObjectBody` / `checkEnum` / `checkIntBound` / `nonConstantDesc` / `requireConstantArray`) were file-local in [src/stage-validation.ts](../src/stage-validation.ts). They are now in a new shared module [src/literal-gate.ts](../src/literal-gate.ts), imported back by `stage-validation.ts` unchanged. Pure move, no behaviour change (2166 tests still pass).

The motivation is the new **operator-argument validator** (`src/operator-validation.ts`, landing next): it must enforce the *same* literal-gating invariant — never throw on a value it can't statically pin down — using the *same* helpers and the *same* error wording (so `$op(...)` arg errors read identically to stage-body errors). Sharing one gate module is what keeps the two validators from drifting; the helpers were always registry-agnostic (each takes a `stage`/`label` string), so no signature changed. Files: [src/literal-gate.ts](../src/literal-gate.ts), [src/stage-validation.ts](../src/stage-validation.ts).

---

## 2026-06-11 — chore: playground imports a committed `dist/jsmql.js` bundle; drop DEF-021 (src-watching hook)

The playground no longer inlines the jsmql bundle into the generated `playground.html`. Instead, `scripts/sync-playground.mjs` emits a committed, git-tracked **pure-ESM** library bundle at **`dist/jsmql.js`** (unminified esbuild bundle of `src/index.ts`, `export { jsmql, … }`, no UI/harness code — `import`-able by Node/Deno/Bun/browsers), and `playground.html` loads it with `<script type="module"> import { jsmql } from "./dist/jsmql.js"`. The script now injects only the examples region into the HTML; it writes/stages each artifact independently (idempotent per file). `.gitignore` un-ignores just `dist/jsmql.js` (`dist/*` + `!dist/jsmql.js`), and `_config.yml` stops excluding `dist` so GitHub Pages publishes the one committed `.js` alongside the page.

Two intended trade-offs: `playground.html` is no longer a self-sufficient single file (it needs its sibling bundle), and — because it's a true ES-module import — it must be **served over http(s)** (local static server / GitHub Pages); double-clicking via `file://` no longer works (browsers block module imports over `file://`). This was the user's chosen alternative to **DEF-021** (a `src/`-watching background watcher), which is dropped: the bundle is a normal build artifact refreshed by `prebuild` / the PostToolUse hook / a manual `npm run sync:playground` after `src/` edits — no background process. DEF-021 was design-only (no live tags); its §A row is removed. Files: [scripts/sync-playground.mjs](../scripts/sync-playground.mjs), [playground_skeleton.html](../playground_skeleton.html), [.gitignore](../.gitignore), [_config.yml](../_config.yml), [docs/DEFERRED.md](DEFERRED.md), [CLAUDE.md](../CLAUDE.md), [scripts/CLAUDE.md](../scripts/CLAUDE.md).

---

## 2026-06-11 — feat: `$ = <array>` fans out to one document per element (`$replaceWith` → `$unwind` splat)

`$ = <expr>` now fans out when the RHS is **provably an array**: array literals (`$ = [{…}, {…}]`), spreads (`$ = [...$.items]`), and array-typed expressions (`$ = $.items.map(…)`, `$ = $.items.filter(…)`, `$ = Object.entries($.x)`) lower to `{ $set: { "__jsmql.__lookupN": <array> } }` → `{ $unwind: "$__jsmql.__lookupN" }` → `{ $replaceWith: "$__jsmql.__lookupN" }`, so one input document becomes one output document per element. `$unwind` needs a materialised field path (it can't unwind an inline array expression), hence the `$set` into a compiler slot; the closing `$replaceWith` discards the namespace so the trailing-`$unset` skip already applies. Verified on a running `mongod`: literal-doc, `.map`, `Object.entries`, spread, and the per-document-drop filter cases all run and yield the expected document counts.

The trigger is exactly `staticBindingType(value) === "array"` ([src/codegen.ts](../src/codegen.ts)) — which deliberately excludes a bare field ref (`$ = $.items` stays a single-doc `$replaceWith`, because field paths carry no compile-time type; spread it as `$ = [...$.items]` to fan out). This also closes a latent **HR3** gap: a provably-array RHS previously emitted `$replaceWith: <array>`, which the server rejects at runtime. **Per-document drop is emergent**, not a special case — default `$unwind` emits nothing for an empty array, so `$ = $.items.filter(p)` drops docs whose filtered array is empty and fans out the rest. There is deliberately **no** "drop" lowering for `$ = []` (rejected, pointing at the conditional form and at `$$ = []`) or `$ = undefined` (unchanged — keeps codegen's `$match`-only rejection): "empty the whole stream" is already spelled `$$ = []`, and one behaviour with two spellings is the footgun we avoid. An array literal of provably-scalar elements (`$ = [1, 2]`) is rejected (each element must be a document). All dispatch + the `lowerFanOut` / `rejectScalarFanOutElements` helpers live in `lowerReplaceRoot` ([src/pipeline.ts](../src/pipeline.ts)); the old `ArrayLiteral` branch of `rejectNonDocumentReplaceRoot` was removed. Files: [src/pipeline.ts](../src/pipeline.ts), [docs/specs/replace-root-stage.md](specs/replace-root-stage.md), [docs/LANGUAGE.md](LANGUAGE.md), [README.md](../README.md), [test/pipeline.test.ts](../test/pipeline.test.ts), [test/realistic.test.ts](../test/realistic.test.ts).

---

## 2026-06-11 — feat: reassignable `let` + read-only `const` bindings (closes DEF-009)

Two changes that ship together. **(1)** `let` bindings are now **reassignable**: a later bare-identifier statement `name = …` re-`$set`s the binding's `__jsmql.<name>` slot, exactly like JavaScript. `let p = $.price; p = p * 0.9;` → two `$set` stages (the RHS `p` resolves to `$__jsmql.p` through `ctx.pipelineLets`, so the read-after-write is correct). `+=`/`-=`/`++`/… desugar to a `BinaryExpr` RHS in the parser and flow through the same path for free. Each reassignment is its own `$set` (read-after-write needs separate stages) — verified on mongod 8.x that the emitted pipeline runs and yields the expected values. **(2)** `const` is the read-only sibling: it declares and reads identically to `let`, but a reassignment throws *Cannot reassign `x` — it is a `const` binding. Declare it with `let x = …` …*.

Mechanically: `LetDecl` gains `kind: "let" | "const"` (set from the keyword). `validateUpdateTarget` (parser) now **accepts** a bare-identifier (`ParamRef`) assignment target — the parser can't see the let-scope, so it defers to codegen. `tryLowerAssignSugar` (pipeline.ts), the shared `AssignExpr` chokepoint for every top-level pipeline form, dispatches on a `ParamRef` target first: in-scope `let` → emit the `$set`; `const` (tracked in the new `ctx.pipelineConstNames`) → reassignment error; dropped-by-reshape → post-reshape error; undeclared → "Cannot assign to bare identifier 'x' …". Outside a pipeline there is no let scope, so `targetToPath` rejects a bare-identifier target with the same guidance.

Also added the `Const` lexer token (alongside `Let`), taught the three dispatch sites + `isIdentOrKeyword` + the object-key branch to accept it (so `$.const` / `{ const: 1 }` keep parsing — `const` is a valid JS property name), and made `parseLetDecl` echo whichever keyword the user typed in its errors. Closes DEF-009 (row + spec Deferred bullet removed). Files: [src/lexer.ts](../src/lexer.ts), [src/parser.ts](../src/parser.ts), [src/ast.ts](../src/ast.ts), [src/codegen.ts](../src/codegen.ts), [src/pipeline.ts](../src/pipeline.ts), [src/lookup-translation.ts](../src/lookup-translation.ts), [docs/specs/let-bindings.md](specs/let-bindings.md), [docs/specs/update-filter.md](specs/update-filter.md), [docs/specs/grammar.md](specs/grammar.md), [docs/LANGUAGE.md](LANGUAGE.md), [docs/DEFERRED.md](DEFERRED.md), [test/let-bindings.test.ts](../test/let-bindings.test.ts), [test/realistic.test.ts](../test/realistic.test.ts).
---

## 2026-06-11 — docs: drop DEF-007 (projection-aware `$project` translation) — won't implement

Moved DEF-007 from §A (open) to §B (won't-implement) in [docs/DEFERRED.md](DEFERRED.md). The row proposed lowering `.slice()` / `.some()` to *projection-form* `$slice` (single-arg) and `$elemMatch` inside `$project({ … })`. The premise was mistaken: jsmql's `$project` is the **aggregation pipeline stage**, not a `find()` projection, and those projection-form operators are `find()`-only features the aggregation stage rejects. Verified on a running mongod: `{ $slice: N }` → "Expression $slice takes at least 2 arguments" (it's always the expression operator in aggregation `$project`), and `{ $elemMatch: { … } }` → "Cannot use $elemMatch in this context". `$elemMatch` also returns the matched element, not a boolean, so it would break `.some()`'s JS semantics. The expression forms jsmql already emits (`{ $slice: ["$items", 3] }`, `$anyElementTrue`/`$map`) run correctly there, and the third proposed switch, `$meta`, already ships in [src/operators.ts](../src/operators.ts) via `$op($meta(...))`. Implementing it would have made jsmql knowingly emit invalid MQL (HR3 violation), so there was nothing valid left to build. DEF-007 was design-only (no live `[DEF-007]` tags); the two format-example mentions in [CLAUDE.md](../CLAUDE.md) and DEFERRED.md were re-pointed at `[DEF-005: merge]`.

---

## 2026-06-11 — fix: a provably-string bracket key emits `$getField` directly (HR3 — no server-rejected `$arrayElemAt`-with-string)

`obj[k]` where `k` is provably a string now lowers to `{ $getField: { field: k, input: obj } }` directly, skipping the runtime `$cond` on `$isArray`/`$arrayElemAt` dual guard — even when the receiver is a known array. Previously a string key took the general dispatch, whose array branch (`$arrayElemAt: [obj, k]`) is **rejected by the server** at runtime ("$arrayElemAt's second argument must be a numeric value, but is string") whenever the value is actually an array. So a valid-JS access (`arr["x"]` is a property lookup in JS, e.g. `[1,2]["length"]`) compiled to MQL that `mongod` refused — an HR3 violation. Surfaced by a real query: `$.cre?.result?.[party]` with `const party = "sender"` against a collection where `cre.result` is an array. `$getField` on an array input is accepted (yields missing), matching JS semantics. Verified on a running `mongod`: the offending pipeline now runs against both object- and array-shaped `cre.result`.

"Provably a string" means `isStringProducing(idx)` (string literal, template literal, `.toLowerCase()`-style string-returning method/op) **or** a `ParamRef` whose binding is typed `"string"`. To cover the `const party = "sender"` case, `bindingTypes` now also carries the static type of pipeline `const` declarations (via a new exported `staticBindingType`; `extendCtxLets` records it only for `const`, since a `let` could be reassigned to a different type). The `keyIsString` check runs **before** the known-array branch in the `IndexAccess` codegen so a string key always wins. Also taught `freshFacetCtx` to forward `bindingTypes` (const slots persist into facet branches). Two existing `["length"]` tests that asserted the old `$arrayElemAt`-with-string / `$cond` shapes were updated — they had been endorsing a server-invalid shape. Files: [src/codegen.ts](../src/codegen.ts), [src/pipeline.ts](../src/pipeline.ts), [docs/specs/method-dispatch.md](specs/method-dispatch.md), [docs/LANGUAGE.md](LANGUAGE.md), [test/codegen.test.ts](../test/codegen.test.ts), [test/match-translation.test.ts](../test/match-translation.test.ts).

---

## 2026-06-10 — feat: parameterised strict-shape builders + closes DEF-028 (CLI params + mode flags)

Added `jsmql.filter.compile` / `jsmql.pipeline.compile` / `jsmql.update.compile` (plus `jsmql.expr.compile` for symmetry) — the parse-once / bind-many form of each strict entry, narrowed to that entry's output type. Extracted the existing `jsmql.compile` body into a single parametric `makeCompile(lower, apiName)` so every builder shares one engine; each is just `makeCompile` over the matching strict lowerer (`lowerFilterStrict`, `lowerPipelineStrict`, …). Because the shape lowerer is the *same* one the one-shot entry uses, the shape contract is re-enforced on every call — a parameterised arrow that lowers to the wrong shape throws the identical actionable error. The entries became callables-carrying-`.compile` via the established `Object.assign` pattern (no `namespace`, strippable-TS rule).

This closes **DEF-028**: the CLI now routes `--arg`/`--argjson` through the matching `*.compile()` for each shape flag (`--filter`/`--pipeline`/`--expr`/`--update`, default `jsmql.compile`) and dropped the params+mode usage-error guard. For `--validate` with params, `jsmql.validate` now accepts a parameterised-arrow *string* directly: `isCompileFormArrow` discriminates it from plain query source by scanning for a top-level `)` followed by `=>` (a parenthesised plain expression like `($.age > 18)` has no top-level arrow), then validates the arrow with bindings stubbed to `null` (values don't affect validity). `[DEF-028]` tags and the DEFERRED.md §A row removed; spec/docs/tests updated. Files: [src/index.ts](../src/index.ts), [src/cli.ts](../src/cli.ts), [docs/specs/strict-shape-entries.md](specs/strict-shape-entries.md), [docs/specs/cli.md](specs/cli.md), [docs/LANGUAGE.md](LANGUAGE.md), [README.md](../README.md), [test/strict-api.test.ts](../test/strict-api.test.ts), [test/cli.test.ts](../test/cli.test.ts).

---

## 2026-06-09 — docs: HR4 verified + HR-conformance sweep (close the LANG_RULES batch)

Closing pass over the LANG_RULES conformance work. **HR4** (four sigils, one scope each) verified conformant: `$` → document, `$$` → collection/stream, `$$$` → database, `$$$$` → server/cluster each map to exactly one ref type by construction (parser → fixed ref node → dedicated lowering), and the 2116-test suite exercises every sigil surface. No code change.

**Sweep** for other "auto-wrap / knowingly-invalid MQL" behaviour beyond the escape hatch: the `$literal` auto-wrap is now injected-values-only (HR1); `$expr` only appears as a legitimate match residual, the deliberate `$$ = []` empty-stream sugar, and lookup sub-pipelines; array auto-wrap is fixed. Two **pre-existing HR3 gaps remain, both already tracked**: DEF-026 (`$arrayToObject` with a literal multi-pair array emits a server-rejected two-argument shape) and DEF-027 (constant-only stage slots like `$limit($.n)` pass a field ref through to server-invalid MQL). Cross-referenced both DEFERRED rows to HR3 — they're deferred because each fix is shape/slot-specific, not because the behaviour is acceptable. No new rejections introduced, so no new DEF rows.

Verification: the full probe matrix from the conformance plan matches the required shapes (errors where required), HR1's injected-value exception still wraps, `npm test` green (2116), `npm run smoke:dist` green (10).

---

## 2026-06-09 — fix: spread-rejection errors point at the JS-idiomatic alternative

The `$op(...)` spread rejection said "pass operands directly or as a single array" — correct but a dead end for the cases that have a real JS form. Made the message operator-aware: `$min(...)`/`$max(...)` → "use the JS form Math.min/Math.max(...arr)", `$concatArrays(...)` → "use array spread ([...a, ...b]) or .concat()", `$mergeObjects(...)` → "use object spread ({ ...a, ...b }) or Object.assign(...docs)"; everything else keeps the single-array/multi-arg hint. Backs the new root-`CLAUDE.md` rule "if something is not supported we throw, but the message must guide toward an alternative." Files: [src/codegen.ts](../src/codegen.ts) (`SPREAD_JS_ALTERNATIVE` + `assertNoSpread`), [test/codegen.test.ts](../test/codegen.test.ts).

---

## 2026-06-09 — fix!: $arrayToObject literal pairs array — server-valid shape (HR3, closes DEF-026)

Shipping DEF-026 — but verifying against a real `mongod` (8.2.3) revealed it was *worse* than the row described: not only the multi-pair escape hatch but **every** computed-key object emitted server-invalid MQL. `{ $arrayToObject: [[k,v]] }` (the single-pair computed-key shape the row called "unaffected") is rejected too — MongoDB reads the literal array as the operator's argument LIST, unwraps the 1-element `[[k,v]]` to `[k,v]`, and fails with "Unrecognised input type"; 2+ pairs fail with "takes exactly 1 argument." So the existing computed-key feature, and `realistic.test.ts`'s asserted shapes, were never runnable.

Fix (`arrayToObjectOfLiteralPairs` in codegen.ts): wrap the pairs array one level deeper — `{ $arrayToObject: [pairs] }` — so MongoDB unwraps exactly once back to `pairs`, the single argument. Chosen over a `$literal` wrap because it works uniformly for expression-valued pairs (`$$this`, `$getField`, …) which `$literal` would freeze, and over `$concatArrays`-of-singletons because it's minimal. Applied in both `generateComputedKeyObject` (covers `{ [k]: v }`) and the `$arrayToObject([…])` escape hatch (a field-ref/expression argument is left as-is). Each new shape verified to run on mongod 8.2; ~9 existing tests that asserted the old invalid shapes updated. Removed DEF-026 (row + tag). Breaking (`fix!`); pre-1.0. Files: [src/codegen.ts](../src/codegen.ts), [src/operators.ts](../src/operators.ts), [docs/LANGUAGE.md](LANGUAGE.md), [docs/specs/method-dispatch.md](specs/method-dispatch.md).

---

## 2026-06-09 — fix!: a top-level object-literal Filter is a raw query doc (HR1 — no `$expr` wrap)

`generateFilter` routed *every* bare expression — including a top-level object literal — through the predicate translator, so a hand-written query document `{ age: { $gt: 18 } }` (and even `{ a: 1 }`) came out as `{ $expr: { age: { $gt: 18 } } }`: `$expr` wrapping a field-keyed object, which doesn't filter on the field at all. With the comparison ops now `flex`, `{ age: $gt($.x) }` was the worst case — `{ $expr: { age: { $gt: ["$x"] } } }`, doubly wrong. HR1 says a pasted/hand-written query document passes through verbatim, and a bare `{ … }` in `find(…)` position *is* the query document. Fix: `generateFilter` short-circuits an `ObjectLiteral` root and emits it via `generateWithCtx` (raw passthrough) — `{ age: { $gt: 18 } }` → itself, `{ age: $gt($.x) }` → `{ age: { $gt: "$x" } }` — mirroring how a `$match` stage body already treats object literals, so the Filter and Pipeline surfaces finally agree. Predicate expressions (`$.age > 18`, `$.name.trim() === 'alice'`) are unchanged: they still translate to indexable query docs or `$expr` residuals. Full suite stayed green (no test pinned the old `$expr`-wrapped object-literal form). Breaking (`fix!`); pre-1.0. Files: [src/index.ts](../src/index.ts), [docs/specs/filter-mode.md](specs/filter-mode.md).

---

## 2026-06-09 — fix!: comparison operators + `$in` are dual-form (`array` → `flex`)

`{ field: { $gt: v } }` is the valid single-value *query* comparison operator; `{ $gt: [a, b] }` is the *aggregation* operands form. The registry had `$eq`/`$ne`/`$gt`/`$gte`/`$lt`/`$lte` (and `$in`) as `array`, so `$gt($.x)` array-wrapped to `{ $gt: ["$x"] }` — wrong, and it contradicted HR2's round-trip (`{ $gt: "$x" }` is valid MQL, so `$gt($.x)` must produce it). Moved those seven operators to `flex` so a single arg passes through as `{ $gt: "$x" }` and two-or-more wrap as `{ $gt: [a, b] }`. `$cmp` stays `array` (aggregation-only, no single-value form). This is the registry half of bringing the escape hatch into HR2/HR3 conformance; the list-only `array` ops (`$setUnion`, `$add`, …) get their strict single-non-array rejection in a following change. Regenerated `src/ops.ts`. Files: [src/operators.ts](../src/operators.ts), [src/ops.ts](../src/ops.ts), [docs/specs/operator-registry.md](specs/operator-registry.md).

---

## 2026-06-09 — fix!: HR1 — source `$`-strings pass through everywhere (only injected values wrap)

New axiom doc `docs/LANG_RULES.md` makes **HR1** law: a `"$x"` typed in *source* IS the MQL field ref `$x` and passes through verbatim in **every** context — jsmql adds no `$literal` of its own. Previously `jsmql.expr('{ a: "$b" }')` emitted `{ a: { $literal: "$b" } }` and the standalone Filter `$expr` residual wrapped `$`-strings too (the latter was tracked as DEF-025). Both violated HR1.

Fix: the `StringLiteral` codegen case now returns the value unchanged in all contexts; `literalSafeString` was renamed `literalSafeInjectedString` and is reached only via `safeBoundValue` (the runtime-injected path). HR1's one exception — a `jsmql.compile` param or template-tag `${…}` that looks like `"$x"` still wraps in expression position so untrusted input can't silently become a field ref — is preserved. The template-tag fast path inlined plain values as source text, which erased the injected-vs-source distinction; so injected `$`-strings are now routed through a synthesized `ParamRef` binding (extended `needsBindingRoute` / `substituteRoutedValues` in `index.ts`, alongside the existing opaque-BSON routing) so `safeBoundValue` applies the context-dependent wrap. `GenerateCtx.pipelineContext` now gates **only** the injected-value wrap.

Resolved **DEF-025** (deleted the §A row, stripped its tags in `src/index.ts` and `docs/specs/filter-mode.md`) and updated the §B "Model A" note — HR1 settles the source-string question globally, so there is no surface- or nesting-dependent wrap. Test churn: `literal-passthrough.test.ts`'s per-operator "wraps in jsmql.expr" assertions inverted to "passes through" (158 cases); `codegen.test.ts`'s source-string cases flipped to pass-through while the injected (template-tag / compile) cases stay wrapped. Breaking output-shape change (`fix!`); pre-1.0 so the package version stays `0.1.0`. Files: [src/codegen.ts](../src/codegen.ts), [src/index.ts](../src/index.ts), [docs/LANGUAGE.md](LANGUAGE.md), [docs/specs/filter-mode.md](specs/filter-mode.md), [docs/specs/aggregation-stages.md](specs/aggregation-stages.md), [src/CLAUDE.md](../src/CLAUDE.md).

---

## 2026-06-09 — fix!: raw `{ $op: <non-array> }` for a list-only operator is rejected (HR3)

HR3 governs raw MQL too, not just MQL jsmql compiles from JS. So `{ $setUnion: $.x }` — a list-only operator keyed to a non-array value — must throw, exactly like the call form `$setUnion($.x)` (it's server-rejected: a set/arithmetic/boolean operator has no single-operand form). Added the check to `generateStaticObjectEntries`: when an object-entry key is a registry `array`-shape operator and the value AST is not an array literal, throw the same `listOperandError`. Gated tightly — fires only on a `$`-prefixed key that resolves to an `array`-shape operator, so `{ $setUnion: [$.a, $.b] }` (and every non-operator object) passes through verbatim (HR1). Full suite + realistic pipelines stayed green (no false positives). Breaking (`fix!`); pre-1.0. Files: [src/codegen.ts](../src/codegen.ts), [docs/specs/operator-registry.md](specs/operator-registry.md).

---

## 2026-06-09 — fix!: reject non-constants in constant-only stage slots (HR3, closes DEF-027 stage half)

The stage-body validator is literal-gated — a field ref / expression in a checked slot is normally a no-op (rule #2: only 100%-certain literal violations throw). But a handful of slots MUST hold a compile-time constant, and there a non-constant is *itself* 100%-certain-invalid (verified on mongod 8.2): `$limit($.n)` → `{ $limit: "$n" }` ("Expected a number"), `$skip`, `$sample.size`, `$bucketAuto.buckets`, `$graphLookup.maxDepth`, `$bucket.boundaries` ("must be an array"), `$lookup.pipeline` ("A pipeline must be an array of objects"). Added the **constant-only-slot exception** to `stage-validation.ts`: `checkIntBound` and a new `requireConstantArray` now reject a field ref / runtime expression with an actionable message ("must be … and a compile-time constant"). A compile-bound `ParamRef` is allowed — it inlines to a literal value at codegen, so `jsmql.compile('({n}) => { $limit(n); }')({ n: 5 })` → `[{ $limit: 5 }]` still works.

Split off the operator-arg *type* half of the old DEF-027 (a literal non-date in a date-typed slot, `$dateDiff({ startDate: "2020-01-01" })`) into **DEF-029**: that needs argument-type metadata in the operator registry (a new dimension) plus an operator-arg validator — a different subsystem, and not yet an HR3 case because the compiler can't currently *know* an arg is date-typed. Three tests that asserted the old (server-invalid) passthrough updated to expect the rejection. Breaking (`fix!`); pre-1.0. Files: [src/stage-validation.ts](../src/stage-validation.ts), [docs/specs/pipeline-validation.md](specs/pipeline-validation.md).

---

## 2026-06-09 — fix!: strict list-only `$op(...)` call form + spread removed from the escape hatch

The `array` shape (now genuinely list-only, after the comparison ops moved to `flex`) blindly array-wrapped via `generateVariadicArgs` regardless of arity or array-ness: `$divide(10)` → `{ $divide: [10] }`, `$setUnion([$.a, $.b])` → `{ $setUnion: [["$a", "$b"]] }` (double-wrapped), and `$setUnion($.a)` silently emitted `{ $setUnion: ["$a"] }`. HR2/HR3 fix in `generateOperatorCall`: **2+ args** → array; **1 array literal** → that array is the operand list (`$setUnion([$.a, $.b])` → `{ $setUnion: ["$a", "$b"] }`, the round-trip of `{ $op: [...] }`); **1 non-array** → actionable HR3 error (`$setUnion operates on a list of operands — write $setUnion(a, b) or $setUnion([a, b])`).

Spread removed from the `$op(...)` escape hatch (user decision): `assertNoSpread` now runs up-front in `generateOperatorCall` for every shape, so `$min(...$.scores)` / `$concatArrays(...$.arrs)` are rejected with a "pass a single array" hint. The JS spread stays supported in JS-method position — `Math.max(...arr)`, `Math.min(...arr)`, `Object.assign(...docs)` route through `generateMathCall`/the `Object.assign` lowering → `generateVariadicArgs` (which keeps its `$concatArrays` handling), never the escape hatch. The split is by surface: a JS builtin the developer already knows vs. the raw direct-operator form where spread "doesn't make sense" (every MQL operator takes its operands directly). Tests: added list-only HR2/HR3 cases; the three `$op(...)`-spread tests now assert the rejection. Breaking (`fix!`); pre-1.0. Files: [src/codegen.ts](../src/codegen.ts), [docs/specs/operator-registry.md](specs/operator-registry.md), [docs/LANGUAGE.md](LANGUAGE.md).

---

## 2026-06-09 — refactor!: computed keys emit `$arrayToObject`'s `{ k, v }` object-pair form

Follow-up to the `$arrayToObject` fix. `generateComputedKeyObject` now builds `{ k, v }` object pairs instead of `[k, v]` array pairs, so `{ [s]: expr }` lowers to `{ $arrayToObject: [[{ k: "$$this", v: expr }]] }` rather than the triple-bracketed `{ $arrayToObject: [[["$$this", expr]]] }`. One less nesting level, self-documenting (`k`/`v` vs positional), and unambiguous when a value is itself an array. The outer `[pairs]` wrap is still required — verified on mongod 8.2 that a bare `{ $arrayToObject: [{k,v}] }` is unwrapped to the object and rejected ("requires an array input, found: object"), exactly like the array-pair form. The `$arrayToObject([...])` escape hatch is unchanged — it keeps whatever pair shape the user typed, just wrapped. New shapes re-verified to run on mongod; ~9 computed-key test assertions updated. Output-shape change (`refactor!`); pre-1.0. Files: [src/codegen.ts](../src/codegen.ts), [docs/LANGUAGE.md](LANGUAGE.md), [docs/specs/method-dispatch.md](specs/method-dispatch.md).

---

## 2026-06-07 — docs: de-duplicate the doc surface to a single-source-of-truth model

The same fact was being written as a full paragraph in three index-like places — root `CLAUDE.md`'s "What this project is" API section, root `CLAUDE.md`'s "File map", and the `docs/CLAUDE.md` spec-table "Covers" column — on top of the spec that actually owns it (plus README + LANGUAGE.md on the user side, plus restating module-header block comments in `src/*.ts`). Every behaviour change therefore needed 4–6 synchronised prose edits, and the misses are exactly the "spec drift" this repo keeps generating.

Fix: established a **single source of truth** model and made every non-canonical location a one-line pointer. Concretely — (1) added a new "### Single source of truth — link, don't restate" rule to root `CLAUDE.md` with the canonical-home table (user behaviour → LANGUAGE.md; per-feature internals → `docs/specs/<f>.md`; module invariants / "where do I add X" → `src/CLAUDE.md`; governance → `docs/CLAUDE.md`; history → DEVLOG); (2) collapsed the three indexes to one line + link each — the file map's multi-line lowering prose and the `docs/CLAUDE.md` "Covers" cells now name *what* each spec is about, not its contents; (3) trimmed the module-header comments in `pipeline.ts` / `lookup-translation.ts` / `union-translation.ts` / `out-translation.ts` to a short intent + `See docs/specs/<f>.md`, matching the `stream-methods.ts` model; (4) relocated CLAUDE-only rationale to its owning spec (the `update`-vs-`updateFilter` naming note was already in `strict-shape-entries.md`; the `Object.assign`-vs-`namespace` note stays in `src/CLAUDE.md`) and moved the `tryLowerAssignSugar` / `lowerStatementTail` "where to add a sugar" hint into `src/CLAUDE.md`; (5) light README Highlights pass — heavy bullets keep a claim + one example + their existing LANGUAGE.md link, dropping the restated lowering mechanics.

Drift-test interaction: trimming the "future work" wording removed three phrases the deferred-coverage allowlist referenced, so the matching entries in `test/deferred-allowlist.txt` were dropped in the same change (STALE-ALLOWLIST gate), and the replacement prose was worded to avoid re-introducing untagged marker phrases (UNTAGGED gate). No behaviour, no public API, no spec *bodies* changed — the specs and LANGUAGE.md remain the canonical content; only the indexes pointing at them shrank.

---

## 2026-06-06 — docs: stop documenting MQL forms that don't run

Pure doc/comment/test-name accuracy pass — **no behaviour change**. After the "server-valid MQL" fix batch and the `$$ = []` sugar landed, several docs still described the pre-fix world and, worse, suggested forms that don't actually run. Fixed:

- **`$$ = []` is supported.** It lowers to `[{ $match: { $expr: false } }]` (drop all documents). Removed the stale "Empty stream not yet supported" rejection rows from [docs/LANGUAGE.md](LANGUAGE.md) and [docs/specs/replace-stream-stage.md](specs/replace-stream-stage.md), deleted the two shipped "Deferred" bullets (`$$ = []` and the non-empty `$documents` array literal) in that spec, and documented the supported form (plus the explicit-stage spelling `$match(false)`). The mid-pipeline `$$ = [<docs>]` rejection message in the spec was corrected to the real one (points at `$$.push(...)`).
- **Dropped the broken suggestions.** Nothing now recommends `$limit(0)` (jsmql's own validator rejects it; the server rejects `$limit: 0`) or `$match($expr(false))` (double-wraps to invalid MQL). The canonical "drop all" spellings are `$$ = []` / `$match(false)`.
- **Stale invalid var names in examples.** The `$lookup` auto-`let` examples in LANGUAGE.md showed `let: { _id: "$_id" }` / `$$_id`, and grammar.md showed the `&&` short-circuit binding as `_v` / `$$_v` — all server-invalid (MongoDB var names must start with a lowercase letter). Corrected to the actual emitted `v_id` / `$$v_id` and `v` / `$$v` (`safeVarName` / `gensymInScope("v")`).
- **Stale example output.** The three `$$ = …` source-switch lookup-pivot examples in LANGUAGE.md showed a trailing `{ $unset: "__jsmql" }` that the compiler no longer emits (redundant after `$replaceWith` replaces root). Removed.
- **`$limit: 0` wording.** README's source-switch lowering said `$limit: 0` + `$unionWith`; corrected to `$match` + `$unionWith`. The `lowerReplaceStream` code comment and two `test/pipeline.test.ts` names that still said `$limit(0)` / `$limit:0` were updated to `$match: { $expr: false }`.

Every edited example was re-verified against `node src/cli.ts`. A separate follow-up (deferred to another session) will make `$match($expr(false))` and other explicit `$op(...)` match bodies emit the operator verbatim.

---

## 2026-06-04 — chore: merge `claude/sleepy-aryabhata-2ced91` into master

Merged the branch carrying the server-valid-MQL fix batch (`fix!: emit server-valid MQL — pipeline $-string pass-through + reject-class fixes`) into master, which had concurrently shipped the CLI, the bare-statement `$$.<chain>;` stream form, and the `$unwind`-path `$literal` fix. Six files conflicted; two non-mechanical decisions:

1. **`fieldPathString` dropped in favour of `pipelineContext`.** Master's `$unwind`-path fix (d1107d1) introduced a narrow `GenerateCtx.fieldPathString` flag to suppress the `$literal` wrap on the `$unwind` path. The merged branch's broader `pipelineContext` flag — seeded at every pipeline entrypoint and propagated through sub-pipeline/facet contexts — already covers that case (a `$unwind` body is always inside a pipeline), so the narrow flag was redundant. Removed `fieldPathString` from `GenerateCtx`, `extendCtx`, and `literalSafeString`; the `$unwind` lowering in `pipeline.ts` now relies on the surrounding ctx's `pipelineContext`. Verified: `$unwind("$items")` still emits `{ $unwind: "$items" }` (no `$literal`).

2. **DEF-025 ID collision → master's CLI item renumbered to DEF-028.** Both branches independently allocated `DEF-025` for different deferred items (master: CLI params + strict/validate flag; merged branch: unify the standalone-Filter `$expr` residual with pipeline pass-through). Kept the merged branch's DEF-025/026/027 contiguous block and renumbered the CLI item to **DEF-028** across `src/cli.ts`, `docs/specs/cli.md`, `test/CLAUDE.md`, and the DEVLOG entry below.

DEVLOG auto-resolved via `scripts/merge-devlog.mjs`; `playground.html` regenerated via `npm run sync:playground`. Full suite green (2108 passed, 1 skipped).

---

## 2026-06-04 — feat: `jsmql` CLI executable (stdin → MQL, jq-style)

Shipped a command-line bin named literally `jsmql`, modelled on `jq`: JSMQL source in (positional arg / `--file` / stdin), MQL JSON out (stdout), errors on stderr with a non-zero exit. It is a thin wrapper over the existing public API — every shape it can emit already exists as an entry point, so there is no new compilation logic. Default output shape is polymorphic (`jsmql(source)`, the `;` rule); opt-in `--filter` / `--pipeline` / `--expr` / `--update` / `--validate` route to the matching strict entry and inherit its actionable wrong-shape errors verbatim. Default formatting is pretty 2-space (jq parity) with `-c`/`--compact`, `--tab`, `--indent N`. jq-style `--arg` / `--argjson` bind params through `jsmql.compile(source)(params)` (the source must then be a parameterised arrow). Source: [src/cli.ts](../src/cli.ts); reference: [docs/specs/cli.md](specs/cli.md).

Three design points worth recording. (1) **Errors render compiler-style** — message, then the offending source line with a `^` caret derived from the error's `.pos` — reusing the position data the library already threads; the resolved source is `trimEnd()`-ed so a shell `echo`'s trailing newline doesn't push the caret onto a blank line. (2) **Version is injected at build** via an esbuild `define` of `__JSMQL_VERSION__` (guarded by `typeof` so the un-bundled `node src/cli.ts` still runs, returning a `0.0.0-dev` fallback) — no runtime `package.json` read. (3) **Params + a strict/validate flag is rejected** (exit 2, tagged `[DEF-028]` — renumbered from `[DEF-025]` during the master merge below to resolve an ID collision): the strict entries have no `compile` overload, so binding there would be silently ignored — better to reject than mislead. `jq`'s `-S`/`--sort-keys` is a deliberate non-goal (§B): reordering MQL object keys can change semantics (`$project` computed-field order), which violates the no-silent-output-drift principle.

Packaging: `src/cli.ts` stays in the strippable-TS subset and carries `#!/usr/bin/env node`; a new `cli` esbuild entry in `scripts/build-cjs.mjs` bundles it to `dist/cjs/cli.cjs` (Node 14 target, shebang preserved, `chmod 0o755`), and `package.json#bin` maps `jsmql` to it. Tests: [test/cli.test.ts](../test/cli.test.ts) spawns `node src/cli.ts` (no build needed) across all flags; [test/smoke.test.ts](../test/smoke.test.ts) adds a strippable check and a dist-gated run of the built bin (stdin→MQL, `--version`, shebang). Worktree only.

---

## 2026-06-04 — feat: ambient TS types for the `$$` / `$$$` / `$$$$` context refs

`src/ops.ts` now declares the three context-reference prefixes as ambient `const`s, so arrow-form code that uses them (`jsmql(($) => $$.indexStats())`, `$$$.orders.find(...)`, `$$$$.currentOp({...})`) type-checks under TypeScript instead of erroring on an undeclared identifier. Previously only the string form was usable in typed code — the prefixes existed in the lexer/parser/AST but had no global declaration. This is the diagnostic-ops half of **DEF-015** (the row is now "partial").

The collection-scoped (`$$`) and cluster-scoped (`$$$$`) **diagnostic source stages** are typed precisely: `$$.{indexStats, collStats, planCacheStats, listSearchIndexes}` and `$$$$.{currentOp, listSessions, listLocalSessions, listSampledQueries, shardedDataDistribution}`, each with full JSDoc (reused from the stage's own block) and an annotated `options?` object where the stage takes one. The method lists are *derived* from the `STAGES[…].diagnostic` field — the same single source of truth `src/system-stage-translation.ts` reads — so a new diagnostic stage surfaces on the right ref automatically. Option *field* shapes (which aren't in the registry or vendored YAML) are a small hardcoded `DIAGNOSTIC_OPTION_SHAPES` map in the generator, transcribed from the MongoDB manual.

Each ref const ends with a permissive `[key: string]: any` tail so the non-diagnostic sugar (`.push`, `.filter`, `.coll.find(...)`, `$out`, stream methods, member access) keeps type-checking — narrowing those to real collection/document types needs schema threading (DEF-013) and stays future work. Trade-off: TS won't flag a typo of a non-diagnostic method, but the jsmql parser still does. Implemented as `contextRefBlock()` in [`scripts/generate-ops.mjs`](../scripts/generate-ops.mjs) (the user chose all-three-refs + permissive index signature); `src/ops.ts` is regenerated. Drift test + a new context-ref assertion in `test/operator-spec-coverage.test.ts` cover it; full suite green, `tsc` clean, dist smoke green. Specs: [`ops-generation.md`](specs/ops-generation.md) § Context references, [`context-references.md`](specs/context-references.md).

---

## 2026-06-04 — feat: bare-statement `$$.<chain>;` stream operations (ship DEF-003)

A `$$`-rooted stream chain can now be written as a bare statement, dropping the `$$ =` head: `$$.filter(o => o.tier === "gold");`, `$$.map(d => ({ id: d._id }));`, `$$.slice(0, 5);`, and the rest of the registry (`.concat`, `.toSorted`, `.toReversed`, `.flatMap`) all work. It's statement sugar for `$$ = $$.<chain>;` and lowers identically. This ships **DEF-003** — the row is deleted and the "Out of scope" bullet 1 in `stream-methods.md` is rewritten into the new § Bare-statement stream chains.

The interesting part was the equivalence guarantee. The user's requirement is that `$$.filter(p).map(f);` (chained), `$$.filter(p); $$.map(f);` (split), and `$$ = $$.filter(p).map(f);` (assignment) all emit the same MQL. For the five independent methods that's trivial. But `.toReversed()` reads `prevStages` and flips the *preceding* `$sort` in place — so lowering each bare statement with a fresh local buffer (the way the assignment form does) would make `$$.toSorted(c); $$.toReversed();` throw while the chained form succeeds. The fix: bare-statement chains lower against the **live pipeline `out`**, so a stage-coupled method sees stages emitted by earlier *statements*, not just earlier methods in its own chain. The per-method loop was extracted from `lowerChainOnStream` into a shared `applyStreamMethods(methods, target, …)` engine — the assignment form passes a fresh local buffer (zero behaviour change), the bare form (in `lowerStatementTail`) passes `out`. One engine, two buffers.

One documented asymmetry: cross-statement `.toReversed()` works in the bare form but the assignment equivalent (`$$ = $$.toSorted(c); $$ = $$.toReversed();`) still errors, because each `$$ = …` chain lowers against its own local buffer. When both forms succeed they emit identical MQL; only the bare form reaches across statements, and it's the recommended concise spelling. `.toReversed()`'s missing-sort error was reworded ("needs a preceding `$sort` …") since it can now invert a `$sort` from a prior statement or a literal `$sort(...)` stage. Files: [`src/pipeline.ts`](../src/pipeline.ts), [`src/stream-methods.ts`](../src/stream-methods.ts). Specs: [`stream-methods.md`](specs/stream-methods.md), [`replace-stream-stage.md`](specs/replace-stream-stage.md). Tests in `test/stream-methods.test.ts`; full suite green.

Follow-up: **`$$.<method>(...)` code-completion types.** Now that the bare form is real, `src/ops.ts` types the stream vocabulary on the `$$` collection ref so arrow-form `jsmql(($) => $$.filter(...).map(...))` gets IDE completion instead of falling through the `[key: string]: any` tail. Built on the context-ref ambient-types commit: the generator (`scripts/generate-ops.mjs`) derives the method *names* from `streamMethodNames()` (the `STREAM_METHODS` registry — single source of truth, asserted at generation time so a new stream method can't silently miss an entry) and pairs each with a hardcoded signature in `STREAM_METHOD_SIGNATURES` (plus `.filter` / `.push`, which aren't in that registry). All return `any` — completion, not real document typing (that's still gated on schema threading, DEF-013/DEF-015). Only `$$` gets them; `$$$` / `$$$$` reach the same methods via member access on the permissive tail. Generator + `src/ops.ts` regenerated; drift test in `test/operator-spec-coverage.test.ts` extended to assert the members + registry coverage. Spec: [`ops-generation.md`](specs/ops-generation.md) § Context references.

---

## 2026-06-04 — feat: playground `err` filter + `$sort` string/bool direction guard

The playground gained a fourth legend filter — **`err`** (red, reusing the
existing `--error: #c0392b`) — next to filter / pipeline / expression. It groups a
small set of *intentionally broken* examples that showcase the pre-flight
validation layer ([pipeline-validation.md](specs/pipeline-validation.md)): clicking
one live-compiles the mistake and renders the actionable compile error in the
existing red output panel, instead of letting a broken query reach the server. No
new render logic was needed — the error path and red panel already existed; the
filtering toggle is generic over `data-kind`, so the button is purely additive (the
only JS touch was adding `"err"` to the input-panel class-reset list).

Six examples were added to [realistic.test.ts](../test/realistic.test.ts) as
`kind: "err"` describes, each a frequent developer slip spanning all three
validation parts: `$group` without `_id`, `$unwind("items")` (path missing `$`),
`$project({ name: 1, note: 0 })` (inclusion/exclusion mix), `$sort({ x: "desc" })`
(SQL-style direction), `$sort` after `$merge` (must-be-last), and `$near` inside an
aggregation `$match`. They're written in throwing-call form
(`expect(() => jsmql(\`…\`)).toThrow(/…/)`) so each both verifies the guard and
exposes an extractable `jsmql(...)` call for the playground sync.

Shipping the `"desc"` example required closing a gap in `validateSort`
([src/stage-validation.ts](../src/stage-validation.ts)): the validator gated only
*numeric* literal directions, so `$sort({ createdAt: "desc" })` and
`$sort({ x: true })` — both textbook SQL/JS habits the server rejects — slipped
through and emitted invalid MQL. A literal string or boolean direction is now
rejected with the same "must be 1 (ascending) or -1 (descending), but got …"
message. Literal-gating still protects `{ $meta: "textScore" }`, field refs, and
expressions (they aren't literals, so they pass the gate) — the "only 100%-certain
violations throw" rule holds.

---

## 2026-06-04 — fix: `$unwind("$items")` no longer wrapped in `$literal`

`$unwind("$items")` compiled to `{ $unwind: { $literal: "$items" } }` — invalid MQL — and the object form `$unwind({ path: "$items" })` to `{ $unwind: { path: { $literal: "$items" } } }`. Both now emit the correct raw path: `{ $unwind: "$items" }` and `{ $unwind: { path: "$items" } }`. The field-ref form `$unwind($.items)` was already correct.

Root cause was a layer mismatch. Codegen's `literalSafeString` ([src/codegen.ts](../src/codegen.ts)) defensively wraps any `"$…"`-shaped string literal in `{ $literal: … }` so that in an *expression* (`$.x == "$items"`) it stays a literal string instead of being read as a field reference. But `$unwind`'s body is a **field-path position**, not an expression — the leading `$` is precisely the path the user means. An earlier pass had hardened `validateUnwind` (the `$`-prefix *validation*, [src/stage-validation.ts](../src/stage-validation.ts)), which made it *look* like `$unwind` was handled, but validation never changes emitted MQL, so the wrap survived. The fix is in codegen, not validation.

Fix: a new `fieldPathString` flag on `GenerateCtx` (sibling to `insideLiteral`; both suppress the wrap, for different reasons), set by `generateStageBody` for the `$unwind` body only via a dedicated branch mirroring the existing `$match` one ([src/pipeline.ts](../src/pipeline.ts)). Deliberately `$unwind`-scoped — stages that take a string in expression position (e.g. `$sortByCount("$items")`) keep the protection, since there `"$x"` vs `$.x` is the user's literal-vs-path choice. No silent output drift, no heuristic: one named stage, one explicit branch. Tests in `test/pipeline.test.ts` (the `$unwind("items")` missing-`$` rejection still throws); spec [`aggregation-stages.md`](specs/aggregation-stages.md) § Lowering.

---

## 2026-06-04 — fix: eliminate three classes of server-rejected MQL (invalid `$$` var names, `$limit:0`, JS regex flags)

Replayed every MQL the test suite generates against a real **MongoDB 8.2** server (instrumented the dispatch to record all outputs, then ran each through `aggregate`/`find`/`updateMany`, classifying genuine rejections vs Atlas/admin/index environment limits). Three classes of *idiomatic* input were producing pipelines the server rejects:

1. **`$$` variable names starting with `_`.** MongoDB requires user-variable names to begin with a lowercase ASCII letter; a leading `_`/`$`/uppercase is rejected. jsmql minted several: the `$lookup` auto-`let` named after the joined field (`_id` — the most common join key! → `let: { _id: … }`, `$$_id`), the `||`/`&&` short-circuit binding (`_v`), `.fill()` internals (`__jsmql_s0`/`__jsmql_e0`/`__jsmql_unused`), and any user throwaway lambda param (`(_ , i) => …`, `Array.from({length}, (_, i) => …)`). Fixed with a pure, deterministic `safeVarName(name)` (`/^[a-z]/.test(name) ? name : "v" + name`) applied at the two `ParamRef` reference sites and every lambda-param emission site (`as`/`vars` keys in the array-method iterator, the 2-param zip form, `reduce` 3-param, `Array.from`), plus the `$lookup` let-allocator (`lookup-translation.ts`); `_v` switched to a `v` gensym base and the `.fill()` literals renamed to valid `jsmqlFill*`. Valid names are returned unchanged, so existing output is untouched except where it was invalid (`_id` → `v_id`, `_` → `v_`, …).

2. **`$limit: 0`.** The `$$ = []` (drop-all) and `$$ = <source>.filter(…)` (source-switch) replace-stream lowerings emitted `{ $limit: 0 }`, which the server rejects ("the limit must be positive"). Both now emit a never-matching `{ $match: { $expr: false } }` (verified equivalent: drops the stream, composes with the trailing `$unionWith`).

3. **JS-only regex flags.** `.match(/x/g)`, `.matchAll(/x/g)`, `/x/gi.test()` passed the raw JS flags as `$regex*` `options`; MongoDB accepts only `imsx`, so `g`/`u`/`y`/`d`/`v` were rejected ("invalid flag"). New `mongoRegexOptions(flags)` keeps only `imsx` (dropping `g` is semantics-preserving — global is implied/irrelevant for these operators).

All three verified gone by re-running the full corpus against mongod. Comprehensive regression guards (a `collectVarNames` walker asserting every emitted `$let`/`$map` var is MongoDB-valid, plus `$limit:0` / regex-option assertions over a corpus of the offending inputs) added to `test/literal-passthrough.test.ts`; ~39 existing tests that asserted the old invalid shapes updated to the corrected ones. Remaining server-rejection cases are out of this fix's scope and tracked as follow-ups (see DEFERRED §A): the `$arrayToObject` literal-multi-pair gotcha, and dynamic values where MongoDB requires a compile-time constant (`$limit($.n)`, `$bucket({boundaries:$.x})`, a string `$dateDiff` date, `$lookup({pipeline:$.x})`). Files: [src/codegen.ts](../src/codegen.ts), [src/pipeline.ts](../src/pipeline.ts), [src/lookup-translation.ts](../src/lookup-translation.ts).

---

## 2026-06-04 — fix: pipeline string literals pass through; `$literal` only in `jsmql.expr`

A user reported `$unwind("$items")` emitting `{ $unwind: { $literal: "$items" } }` — which MongoDB rejects. The root cause was broader than one stage: `literalSafeString` wrapped *every* `$`-prefixed string literal in `{ $literal: … }` by default, suppressed only inside a `$literal(...)` envelope. That default is right for the expression-authoring surface (a JS string `"$y"` means the literal string; `$.y` is the field ref) but wrong for the documents-you-write/paste surface — it broke `$unwind`, `$sortByCount`, `$replaceWith`, `$project({ x: "$y" })`, nested operator args (`$concat`), and made pasted raw MQL fail to round-trip (`[{ $unwind: "$items" }]` → `{ $literal: … }`).

New rule (confirmed with the user, "Model B"): **in pipeline/stage context every `$`-string passes through verbatim, at any depth including inside nested operators; `$literal` auto-wrapping happens only in `jsmql.expr`.** Implemented with a single `GenerateCtx.pipelineContext` flag seeded once at the three pipeline entrypoints (`generatePipeline` / `generateImplicitPipeline` / `generatePipelineWithCtx`) and propagated down (`extendCtx`, `freshSubPipelineCtx`, `freshFacetCtx` carry it); `literalSafeString` / `safeBoundValue` OR it with `insideLiteral`. The context is set by *surface*, never flipped at operator boundaries — so an operator nested in a stage does not re-introduce `$literal` (we explicitly rejected the alternative "Model A" — see DEFERRED §B). The `$literal("$y")` escape hatch still forces a literal inside a pipeline. `rejectNonDocumentNewRoot` was relaxed to accept a `$`-prefixed string (a field path) for `$replaceWith` / `$replaceRoot.newRoot`, so `$replaceWith("$x")` no longer throws.

Standalone Filter `$expr` residuals (`jsmql.filter('…')`) keep wrapping for now (a `find(filter)` is neither a pipeline nor `jsmql.expr`); unifying that with pipeline pass-through is deferred as [DEF-025](DEFERRED.md). New comprehensive guard `test/literal-passthrough.test.ts` loops every operator (181) and every stage (45) asserting pipeline pass-through emits no `$literal`, expr still wraps, and no op/stage is silently uncovered. Existing suite stayed green with zero churn — prior pipeline tests used `$.field` refs, not `"$field"` literals. Breaking output-shape change (`fix!`); pre-1.0 so package version stays `0.1.0`. Files: [src/codegen.ts](../src/codegen.ts), [src/pipeline.ts](../src/pipeline.ts), [src/stage-validation.ts](../src/stage-validation.ts), [docs/LANGUAGE.md](LANGUAGE.md), [docs/specs/aggregation-stages.md](specs/aggregation-stages.md), [docs/specs/filter-mode.md](specs/filter-mode.md).

---

## 2026-06-04 — refactor: `fieldQueryOrNegated` helper for `$not`-negatable peepholes

Prefactoring, round 3. The `===` / `!==` equality-family peepholes in match-translation each pick a positive query and a negated form. Two of them — modulo (`{ $mod }`) and typeof (`{ $type }`) — negate identically: `{ [field]: { $not: <positive> } }`. Extracted that shared shape into `fieldQueryOrNegated(field, positive, op)` so each such translator supplies only the positive operator object; the `!==` `$not`-wrap comes for free, and the next `$not`-negatable query operator is a one-liner. (Equality-shorthand negates with `$ne` and the `undefined` peephole flips an `$exists` boolean, so those two keep their own forms — the helper deliberately covers only the `$not`-wrap family.) Pure dedup, full suite green; worktree only.

---

## 2026-06-04 — refactor: `requireObjectBody` prelude helper for stage validators

Prefactoring, round 4. Fourteen of the object-shaped stage-body validators in `stage-validation.ts` opened with the identical three-line prelude: `const info = objectInfo(body); if (info === null) return; requireKeys("$stage", info, body.pos, [...]);`. Folded that into one `requireObjectBody(stage, body, required?)` helper that returns the key map (or `null` when the body isn't an inspectable object literal — validation is best-effort, so a field-path/expression body is left for the server). Each validator now opens with `const info = requireObjectBody("$stage", body, [...]); if (info === null) return;` (or just the call, when it only needs the required-key side effect, as in `$lookup`/`$group`/`$geoNear`).

The repeated `body.pos` threading and the `objectInfo`+`requireKeys` pairing now live in one place — adding a new object-shaped stage validator starts from a single call instead of copy-pasting the prelude. Behaviour-preserving (same errors, same `.pos`); full suite green. `requireKeys` is now reached only through the helper; `objectInfo` stays directly used for inspecting *nested* sub-objects (`output`, `window`, field specs). Worktree only.

---

## 2026-06-04 — refactor: `withFunctionInput` / `fnSource` for the arrow-input paths

Prefactoring, round 4. Three entry points parse arrow-function input — the one-shot `dispatchInput` (function branch), `compileFunction`, and `validateInput` — and each spelled out `new Parser(src).parseFunctionInput()` inside a `try { … } catch (err) { throw augmentForFunctionInput(err); }`, plus `Function.prototype.toString.call(input).trim()` to get the source. Three copies of the same parse-and-augment scaffold, easy to let drift (e.g. one forgetting to route a codegen error through the augment).

Extracted `withFunctionInput(src, body)` — parse the arrow source and run `body(parsed)`, routing any error (parse or whatever `body` does) through `augmentForFunctionInput` — and the trivial `fnSource(fn)`. The one-shot and `validate` paths pass a `body` that lowers (so codegen errors are augmented too); `compile` passes `(r) => r` to wrap the parse only, since its lowering happens later in the returned closure. `compile`'s string-or-function source handling and its type guard stay put (compile is the one path that also accepts a string). Behaviour-preserving — verified the closure-ref augmentation, the one-shot params-destructure rejection, and `compile`/`validate` all still behave; full suite green. Worktree only.

---

## 2026-06-04 — refactor: accumulator-only gate derives from the operator registry

Prefactoring, behaviour-preserving. Codegen's `checkOperatorContext` gated accumulator-only operators (`$push`, `$addToSet`, `$top`/`$topN`, `$bottom`/`$bottomN`, `$median`, `$percentile`, `$accumulator`) on a hand-maintained `ACCUMULATOR_ONLY_OPERATORS` set that *shadowed* the operator registry. Adding an accumulator operator silently required a second edit there; miss it and the new op would be wrongly accepted in arbitrary expression positions. That violates the project's "operator registry is the single source of truth" rule.

The flag now lives on the registry entry: `OperatorDef` gains an optional `accumulatorOnly?: boolean`, set via a small `acc(...)` wrapper around any shape factory (`acc(single("array", "…"))`), and `checkOperatorContext` reads `lookupOperator(name)?.accumulatorOnly`. The shadow set is deleted. Same nine ops gate, output unchanged, full suite green. The generator doesn't serialize the flag, so `src/ops.ts` is untouched. A new drift assertion in [test/operator-spec-coverage.test.ts](../test/operator-spec-coverage.test.ts) keeps the flag boolean-or-absent, and the "Adding a new MongoDB operator" steps in [CLAUDE.md](../CLAUDE.md) + [operator-registry.md](specs/operator-registry.md) now mention `acc(...)`. (Window-only operators were already registry-derived via `category === "window"`; this brings accumulators to parity.)

---

## 2026-06-04 — refactor: central `checkArity` for JS-method argument-count errors

Prefactoring. Adding a JS-method alias is one of the most frequent changes, and each method hand-rolled its own `if (exprArgs.length !== N) throw new CodegenError(...)` — 27 such checks in the `generateMethodCall` switch alone, with *inconsistently worded* messages. Param names sometimes sat in the call prefix (`.charAt(index) requires exactly 1 argument`), sometimes trailed (`.split() requires exactly 1 argument (separator)`), sometimes were absent (`.concat() requires at least 1 argument`); quantity clauses mixed "requires"/"takes". Getting a new method's error right meant copying a sibling and hoping the wording matched.

Introduced `checkArity(method, spec, count, callPos, prefix?)` in codegen.ts — the single place every arg-count error is worded as `<prefix><method>(<sig>) <quantity-clause>, got <N>`. Each call site supplies an inline `Arity` spec (`{ sig, exact | allowed | atLeast | none }`); the helper renders the message and `formatCountList` produces the "1 or 2" / "0, 1, or 2" lists. The signature now always shows the intended call shape up front (`.slice(start[, end])`, `.concat(...items)`), which is strictly friendlier than the old trailing/absent parentheticals — `.concat` gained a signature it never had — and the trailing `, got <N>` reports exactly what the user passed. The quantity wording is unchanged from the dominant existing style; the standardization is relocating param names into the signature, unifying "takes"→"requires" for the range forms, and adding the `, got <N>` count. This was reviewed against the worst-case before/after messages before landing.

All 27 instance-method checks migrated; output is unchanged (only message text, which was almost entirely unasserted) and the full suite stays green, plus new tests lock in the exact/range/atLeast/none message shapes and the `, got N` count. The static families (`Math.`/`Object.`/`Set.`/`regex.`) keep their current wording for now — `checkArity` takes a `prefix` param so they can adopt it later; `Math` already centralizes its 1-arg check via `oneArg`. Spec: [method-dispatch.md](specs/method-dispatch.md).

A follow-up commit consolidated the *metadata* too. The six hand-maintained method Sets (`STRING_RETURNING_METHODS`, `ARRAY_RETURNING_METHODS`, `BOOL_RETURNING_METHODS`, `OPTIONAL_STRING_METHODS`, `OPTIONAL_ARRAY_METHODS`, `OPTIONAL_EITHER_METHODS`) and `KNOWN_METHODS` are now **derived** from a single `METHODS` registry — `Record<string, { returns?, optional? }>` — so adding a method is one entry there plus its `case` plus a `checkArity` call, instead of editing up to four scattered Sets. The derivation was verified against inline copies of every old literal via a temporary load-time assertion (removed once green): all six type Sets derive *exactly* equal — so the codegen-affecting inference (`isStringProducing` / `isArrayProducing` / optional-chaining neutrals) is provably unchanged. The one intentional difference: `KNOWN_METHODS` now includes `substring`, which was missing from the old hand-written suggestion list — a near-miss like `.substing(1)` now resolves to `.substring()`. The lowering bodies themselves stay in their `case` arms (the switch is a fine name-keyed dispatch); folding those into the registry too offers little over the named switch.

---

## 2026-06-04 — refactor: generate playground.html from a hand-authored skeleton

`sync-playground.mjs` used to read `playground.html`, replace its two managed
regions (the esbuild bundle of `src/index.ts` and the realistic-examples JSON
island) in place, and write the same file back. That made `playground.html`
both the UI source *and* the build output, so a `src/` or `realistic.test.ts`
change that triggered a regen sat in the same file as in-flight playground UI
improvements — a recipe for merge collisions and accidental clobbering across
parallel work.

Split the two roles. **`playground_skeleton.html`** is now the hand-authored
source for the entire UI (markup, CSS, behaviour); the two regions sit empty
between their markers there (the bundle region is empty, the examples region
ships `[]`). **`playground.html`** is a pure build artifact: the script reads
the skeleton, injects the bundle + examples, and only ever *writes*
`playground.html` — it never touches the skeleton. So changes to `src/` or the
test file can no longer overwrite UI work, and a `playground.html` merge
conflict is trivially resolved by re-running the sync against the merged
skeleton. Regenerating from the new skeleton produces a byte-identical
`playground.html` (verified: `sync` reported "already in sync"), so the change
is behaviour-preserving. The PostToolUse hook
([scripts/hook-post-edit-realistic.sh](../scripts/hook-post-edit-realistic.sh))
now also fires on `playground_skeleton.html` edits, so UI changes made through
Claude Code regenerate the artifact within the same commit.

---

## 2026-06-04 — refactor: one `BINARY_OP_TO_MQL` table for the JS-op → MQL-op mapping

Prefactoring, round 3. The JS-binary-operator → MQL-operator mapping was spelled out in two files: codegen's `generateBinaryExpr` (one switch case per op → `{ $gt: [...] }`, etc.) and match-translation's `orderedOpToMql` (`>` → `"$gt"`, … for the query-document form). The comparison operators were mapped in both — a small but real cross-file duplication.

Introduced a single `BINARY_OP_TO_MQL` table in codegen.ts (the module that owns MQL emission — kept out of `ast.ts` so the AST layer stays MQL-agnostic) covering every op with a *direct* single-operator lowering (`-` `/` `%` `**` `===` `!==` `>` `>=` `<` `<=` and the associative chain ops `*` `??` `&` `|` `^`). `generateBinaryExpr` now groups those into two table-driven arms — DIRECT → `{ [op]: [l, r] }`, CHAIN → `{ [op]: flattenChain(...) }` — collapsing ~15 one-line cases to two; the bespoke ops (`+`, `==`/`!=`, `&&`/`||`, `in`) keep their own cases. match-translation imports the lone accessor `mqlForBinaryOp` so `orderedOpToMql` reads from the same table. The switch stays exhaustive over `BinaryOp` (no `default`), so a future operator still forces a compile-time decision. Behaviour-preserving, full suite green; worktree only. (Binary operators are a fixed set, so this is tidiness more than frequent-change leverage — it removes the duplication and documents the canonical mapping in one place.)

---

## 2026-06-04 — refactor: one `didYouMean` helper for every closed-set rejection

Prefactoring, behaviour-preserving. The `closestNameTo(name, set) ? \` Did you mean '…'?\` : ""` snippet had been hand-rolled at 13 throw sites (codegen ×3, parser ×4, pipeline ×3, lookup/system translation), each with its own variable name (`suggestion`, `setSuggestion`, `regexSuggestion`, `near`, …) and its own spelling of the suggestion. Adding a new throw site — something nearly every feature does — meant copying three lines and getting the format right by hand. That is exactly the kind of friction this pass targets: *make the change easy, then make the easy change.*

The fix is `didYouMean(name, candidates, format?)` in [src/levenshtein.ts](../src/levenshtein.ts), next to `closestNameTo`. It returns the whole `" Did you mean 'X'?"` tail (or `""` when nothing is close), so call sites interpolate unconditionally and never branch. The optional `format` callback renders the suggestion to match the surrounding message — default `.foo()`, `(s) => \`Class.${s}\`` for statics, `(s) => s` for bare stage names. Because `format` receives the *matched* candidate, even the scope-aware diagnostic-stage message (`$$$$.currentOp` vs `$$.indexStats`) collapses cleanly: the prefix is looked up from the candidate inside the callback. Every message is byte-identical to before (full suite green); the only `closestNameTo` call left is the boolean gate in `isSystemStageCall`, which wants the name, not a hint. `closestStage` folded away into the one call in `formatUnknownStage`. The DX mandate in [CLAUDE.md](../CLAUDE.md) now points at `didYouMean` as the canonical way to satisfy it.

---

## 2026-06-04 — refactor: one `mergeTranslatedQuery` for the query/$expr emission

Prefactoring, round 3. The "merge a `MatchTranslation` into a query document" logic — index-friendly conjuncts plus an `$expr`-wrapped residual, with the four-way vacuous/query-only/residual-only/both split — was written out three times: `generateFilter` (index.ts, top-level Filter), the `$match` stage body (pipeline.ts), and `matchStagesFromTranslation` (lookup-translation.ts, the sub-pipeline translators). Three subtly-different spellings of the same emission — a place for the shapes to drift (pipeline.ts even regenerated the residual from the original `body` rather than `t.residual`, an equivalent-but-divergent path).

Hoisted it to `mergeTranslatedQuery(t, ctx)` in [match-translation.ts](../src/match-translation.ts), next to `translateMatchBody` and the `MatchTranslation` type. It returns the merged query document, or `null` for a vacuous predicate so callers can skip the `$match`. All three sites now route through it: `generateFilter` and the `$match` body use `mergeTranslatedQuery(t, ctx) ?? {}` (empty = match-everything), and `matchStagesFromTranslation` maps `null → []`, else `[{ $match: merged }]`. Behaviour-preserving — full suite green; the pipeline.ts `body`-vs-`residual` divergence is a no-op because a query-empty translation always carries the whole predicate in the residual, which lowers to identical MQL. `match-translation.ts` already imported from `codegen.ts` (one-way; codegen doesn't import it back), so pulling in `generateWithCtx` adds no cycle.

---

## 2026-06-04 — refactor: one shared `lowerLambdaPredicate` for the sub-pipeline translators

Prefactoring, behaviour-preserving. Four translators lowered a single-parameter predicate lambda into sub-pipeline stages with the *same* body, copy-pasted: `$unionWith` (`translateUnionPredicate`), `$facet` (`lowerFacetEntry`), `$out` (`lowerFilterAsMatch`), and the `$$ = $$.filter(…)` replace-stream filter (`lowerStreamFilterPredicate`). Each one: rewrite foreign paths via `extractLetsFromExpr`/`extractLetsFromPipeline`, reject a local-doc reference (none of these stages has a `let` slot), run an expression body through `translateMatchBody` then the identical six-line `queryEmpty`/`residual` `$match`-emission block, run a block body through the caller's `lowerBlock`, throw on a missing body. The only real variation was the rejection message and which fresh sub-pipeline ctx to build. The fragile part — the index-friendly-vs-`$expr` emission — was the part duplicated, so a fix to one risked drift in the others.

Extracted two exports into `lookup-translation.ts` (the hub the others already depend on): `matchStagesFromTranslation(t, subCtx)` (the `$match`/`$expr` emission, now the single copy) and `lowerLambdaPredicate(lambda, outerCtx, lowerBlock, { freshCtx, onLocalRef, missingBody })` (the whole expr/block/missing skeleton). Each call site collapses to its own param-count validation plus one `lowerLambdaPredicate(...)` call supplying its rejection message and `freshCtx` (identity for the replace-stream filter, which already runs in the right ctx). `grep '$expr: exprBody' src/` now returns exactly one file. The plan named three call sites; the fourth (`lowerStreamFilterPredicate`) surfaced via that grep invariant and folded in cleanly. Output byte-identical, full suite green. Adding the next sub-pipeline translator now means a message + a ctx factory, not re-deriving the emission. Docs: [lookup-stage.md](specs/lookup-stage.md) + the translation-module file-map in [CLAUDE.md](../CLAUDE.md).

---

## 2026-06-04 — refactor: route the static-call families + array mutators through `checkArity`

Prefactoring, round 2. Last round centralized the 27 instance-method arg-count checks but left the static-call families and the statement-position array-mutator rewrites still hand-rolling their own `if (length …) throw` with bespoke wording. That left the surface half-consistent: `.charAt(index) requires exactly 1 argument, got 0` next to `Math.pow() requires exactly 2 arguments` (no signature, no count) and `.copyWithin(target, start[, end]) takes 2 or 3 arguments, got 2.` (trailing period, "takes" not "requires").

Migrated all ~21 remaining codegen-side checks to `checkArity` with its `prefix` param: `generateMathCall` (incl. the shared `oneArg` helper), `generateObjectCall`, `generateSetMethodCall`, `generateRegexMethodCall`, and the `.reverse`/`.pop`/`.shift`/`.copyWithin`/`.fill` mutator rewrites. Every arg-count error across the method + static surface now reads `<prefix><method>(<sig>) <quantity>, got <N>` — `Math.pow(base, exponent) requires exactly 2 arguments, got 1`, `Object.assign(...sources) requires at least 1 argument, got 0`, `regex.test(str) requires exactly 1 argument, got 0`. The static families gained signatures they never had. Output unchanged (message text only, and these were unasserted save one partial `Math.atan2`/`exactly 2 arguments` match that still holds); full suite green, plus new tests covering the static + mutator formats.

The parser-side constructor checks (`new Set` / `new Date` / `Date.UTC`) stay as-is — they throw `ParseError` (a different class, in a different file) and already carry good `, got N` messages; folding them in would mean a parser-side formatter, out of scope here. Spec: [method-dispatch.md](specs/method-dispatch.md).

---

## 2026-06-04 — refactor: share the pipeline-sugar dispatch across both pipeline forms

Prefactoring, round 2. The per-element sugar dispatch — detect `$ =`/lookup `AssignExpr` sugar, flush the update buffer, lower, push stages, update ctx — was written out twice, nearly verbatim: once in `generatePipeline` (the `[ … ]` form, ~45 lines) and once in `lowerUpdateFilterWithLookups` (the `,`-grouped op chain, ~45 lines). The statement-tail dispatch (`$$.push` → `$unionWith`, system source stages, generic stage call) was likewise duplicated between `generatePipeline` and `generateImplicitPipeline` (the `;` form). Adding a new sugar meant editing 3–4 spots across two-to-three functions and keeping the ordering identical by hand — exactly the growth-friction this area sees most (`$lookup`/`$unionWith`/`$facet`/`$out`/`$replaceWith`/system-stages were each such an edit).

Extracted two shared helpers in `pipeline.ts`: `tryLowerAssignSugar(op, ctx, out, flush, allocSlot, lowerBlock, isFirst)` returns either `{ handled, ctx, outPos }` (sugar lowered, stages pushed) or `{ handled: false, bufferOp }` (fall through to the update buffer); and `lowerStatementTail(el, i, ctx, out, validator, allocSlot, lowerBlock)` returns the next ctx. The genuinely per-form bits stay at the call site: first-stage detection (`out.length === 0` vs `globalStageIndex + out.length === 0`), loop control (`return` vs `continue`), the buffer identity, and how an `$out` terminal is recorded (`validator.markSugarOut` vs a `TerminalState`, keyed off the returned `outPos`). Now a new `$ =`-style sugar is one branch in `tryLowerAssignSugar` and a new statement sugar is one branch in `lowerStatementTail`; all forms pick it up at once.

Behaviour-preserving — a pure extraction; the two call sites collapsed sharply, full suite + dist smoke green. No spec'd behaviour changed; the dispatch order within each helper matches the original exactly.

---

## 2026-06-04 — refactor: single-source the JS-builtin static name-sets in `ast.ts`

Prefactoring, round 2. The recognised-name lists for the `Math.` / `Object.` / `Number.` static families were triplicated: a runtime `Set` in `parser.ts` (for validation + `didYouMean` candidates), a hand-kept literal-union `type` in `ast.ts` (for codegen dispatch signatures), and the codegen switch itself. Adding a `Math` method meant editing all three, and forgetting the type let the parser accept a name codegen couldn't type. Worse, the `Set` method list had no parser registry at all — its canonical list lived *only* inside a codegen error string.

Made `ast.ts` the single source: each family is now an `as const` array (`MATH_METHODS`, `MATH_CONSTANTS`, `OBJECT_METHODS`, `NUMBER_STATICS`, `SET_METHODS`) with its `…Method` type *derived* via `(typeof X)[number]`. `parser.ts` builds its lookup `Set`s from the imported arrays and draws `didYouMean` candidates from them; `codegen.ts` keeps its switches but their signatures derive from the same arrays, so the `as const` keeps the switch exhaustiveness-checked — adding a name surfaces a missing-case compile error rather than a silent gap. The `Set` list is now a real exported registry used by both the dispatch and the suggestion message.

Net: adding a static method goes from three edits (set + type + switch) to two (the `as const` array + the switch `case`), with the compiler enforcing they agree. Behaviour-preserving — the derived unions have identical members; full suite green. `as const` arrays + `typeof[number]` type aliases are erasable, so `src/` stays in the strippable-TS subset. (The two-name `Array.`/`Date.` families stay inline — too small to warrant a registry, and not type-backed.)

---

## 2026-06-03 — decision: bracket access is always raw; only dot access is interpreted

A language rule, settling the `["length"]` question that flip-flopped over the previous two entries. **Dot access (`.member`) may carry compiler meaning** — most prominently `.length`, which folds to the string-or-array length operator (`$size`/`$strLenCP`/`$cond`). **Bracket access (`[...]`) never does.** Whatever the user spells inside the brackets is the property they get — `$.x["length"]`, `$.x["anything"]`, `$.x[$.dynamicKey]` are all direct property access, with no interpretation of the key.

This reverses the earlier "`x["length"]` === `x.length`, same as JS" stance (entry below). The new rule deviates from JS — in JS `arr["length"]` *is* the array length — but the user chose teachability and a clean escape hatch over strict JS fidelity: brackets are the unambiguous "give me the raw data at this key" syntax, including for a field literally named `length`. The mental model is one sentence: *dots are interpreted, brackets are raw.*

Implementation: removed the `["length"] → generateLengthAccess` short-circuit from the `IndexAccess` codegen ([src/codegen.ts](../src/codegen.ts)) and the matching `isLengthAccess`/`asFieldPath` bracket handling from [src/match-translation.ts](../src/match-translation.ts). `isLengthAccess` is back to dot-only. The bare-root string-literal → field-reference rule (entry below) stays — it's the canonical raw-access escape (`$["cart.field.length"]` → `"$cart.field.length"`). Consequences: `$.field["length"]` → the runtime array-or-object `$cond` (reads a property "length"); `$.csv.split(",")["length"]` → `$arrayElemAt[…, "length"]` (raw, not `$size`). Tests in [test/codegen.test.ts](../test/codegen.test.ts), [test/match-translation.test.ts](../test/match-translation.test.ts), [test/realistic.test.ts](../test/realistic.test.ts) (rectangle-area + dynamic-key); docs across [LANGUAGE.md](../LANGUAGE.md) (Bracket Access + Property access), [method-dispatch.md](specs/method-dispatch.md), [match-query-translation.md](specs/match-query-translation.md).

---

## 2026-06-03 — feat: `$["any.field"]` on the bare root is a plain field reference

Follow-up to the `.length` change below. Since `$.field.length` now folds to the string-or-array length operator, a doc with a *genuine* nested `length` dimension (`{ field: { length: 10, width: 5 } }`) needed an escape. The answer: spell the whole path inside one bracket key on the root — `$["field.length"]` lowers to a plain field reference `"$field.length"`, not the runtime array/object `$cond`.

The rule is narrow and principled: a **string-literal** key on the **bare root** `$` (parser shape `IndexAccess(FieldRef "", StringLiteral)`). The root document is never an array, so the `$arrayElemAt` branch of the general dispatch is dead weight there. This doubles as the way to name a field that isn't a bare identifier — dots, dashes, spaces: `$["dash-name"]` → `"$dash-name"`. Non-root string-literal bracket access (`$.config["host"]`) is unchanged — that receiver *can* be an array at query time, so it keeps the documented `$isArray` `$cond`. The `["length"]` length-operator special case still runs first, so `$["length"]` on root stays the (admittedly odd) length-of-root form, consistent with the prior turn's `["length"] === .length` rule.

Implementation: one guard in the `IndexAccess` case of [src/codegen.ts](../src/codegen.ts). Realistic test (rectangle area) in [test/realistic.test.ts](../test/realistic.test.ts); unit test in [test/codegen.test.ts](../test/codegen.test.ts); docs in [LANGUAGE.md](../LANGUAGE.md) (Bracket Access) and [method-dispatch.md](specs/method-dispatch.md).

---

## 2026-06-03 — feat: comprehensive pre-flight MQL validation

The big DX wave: catch, at compile time, the pipeline mistakes the MongoDB server would otherwise reject with a terse runtime error. Three layers, all governed by two hard rules from the user — (1) **only 100%-certain violations throw**; (2) the line is *certainty from the source*, not "is it documented" or "is the syntax first-class" (jsmql reaches every operator via `$op(...)` / raw passthrough, so reachability is never an excuse to skip a check). Anything runtime-dependent (sharding, transactions, views, memory limits, collection type, read concern, Atlas availability) or value-dependent (a non-literal slot we can't evaluate) still emits MQL. Full design in [pipeline-validation.md](specs/pipeline-validation.md).

**Layer 1 — structural placement** ([src/pipeline.ts](../src/pipeline.ts) + [src/stages.ts](../src/stages.ts)). Two declarative `StageDef` fields — `position: "first" | "last"` and `forbiddenIn: ("facet"|"lookup"|"unionWith")[]` — plus the readers `stageMustBeFirst` / `stageMustBeLast` / `stageForbiddenIn`, applied by a per-pipeline `makePipelineValidator` closure wired into all three assembly functions and `lowerUpdateFilterWithLookups`. This generalises the two checks that existed only for the sugar forms (system-stage-first, `$out`-last) to the *literal* stage forms (`{ $merge: … }`, `{ $collStats: {} }`) and adds the stages that had no check at all (`$merge`, `$changeStreamSplitLargeEvent`, `$geoNear`, `$search`, …). Two decisions worth recording: (a) the must-be-first check keys on the **user-authored element index**, never `out.length` — prologue `$lookup`/`$set` stages inflate the output length, so a source stage written first must not false-throw; (b) all 9 `diagnostic` stages are treated as must-be-first even though three of their MongoDB doc pages don't *spell out* the rule — each is a pure source stage (produces, never transforms), so a non-first placement is a structural certainty, and this keeps the literal forms consistent with the sugar forms. The old `sawOut`/`makeAfterOutError` was generalised to a single `terminal` state + `makeAfterTerminalError` (sugar keeps its `$$$.<coll> = …` wording via a `viaSugar` flag).

**Layer 2 — body shape** ([src/stage-validation.ts](../src/stage-validation.ts), new). `validateStageBody` runs at the top of `generateStageBody`; `STAGE_BODY_VALIDATORS` holds one small validator per stage covering literal type mismatches, numeric bounds (`$limit(-5)`), string-format rules (`$count('')`/`'$x'`/`'a.b'`), enum typos with `closestNameTo` "Did you mean" (`$merge.whenMatched`, `$fill.method`, `$bucketAuto.granularity`), required keys (`$group._id`, `$lookup` from/as, `$graphLookup`, `$merge.into`, `$geoNear.near`), mutual-exclusivity (`$fill` value+method, `$setWindowFields` documents+range), literal-array shape (`$bucket` boundaries ≥2/ascending/same-type), `$project` include/exclude mixing, and non-document `$replaceRoot`/`$replaceWith` roots. The cross-cutting invariant that makes this safe under rule #1: **the literal-gating invariant** — every validator no-ops the moment the checked slot is a field ref, expression, operator call, template literal, computed key, or spread, so probable violations always compile. (Hand-coded, not generated from the vendor spec: the spec encodes only `type`/`optional`/`variadic`; the valuable rules are prose-only, and a generated layer would risk false-positives on unknown keys, which jsmql intentionally tolerates for forward-compat.)

**Layer 3 — `$match` query-operator placement** (`validateMatchPlacement`). A raw `$match` object body passes through verbatim, so query operators are reachable: a `$match` using `$text` must be the first stage; `$near`/`$nearSphere`/`$where` aren't allowed in an aggregation `$match` at all (the error names `$geoNear`/`$geoWithin`/`$expr`). The walk recurses through nested field objects and `$and`/`$or` arrays and only inspects static object bodies.

No `closestNameTo` on the placement messages — those fire on correctly-named, mis-placed stages (a misspelling already hits the existing "not a known stage" path); the enum body checks DO use it. Sugar-generated stages never reach the body validators (they build their objects directly). Deferred: forbidden-in-context inside sugar *predicate block-body* lambdas (`[DEF-024]`) — the literal sub-pipeline-array path is fully covered, but threading the container through the shared `lowerBlock` would mislabel the predicate-translation cases. Decided against (DEFERRED §B): compile-time validation of runtime-dependent constraints. Tests in [test/stage-validation.test.ts](../test/stage-validation.test.ts) (new), [test/pipeline.test.ts](../test/pipeline.test.ts), [test/error-pos.test.ts](../test/error-pos.test.ts).

---

## 2026-06-03 — fix: `.length` in filters is string-or-array, gated on a natural-number RHS

`$.cart.items.length < 20` in a filter compiled to the literal dotted key `{ "cart.items.length": { $lt: 20 } }` — treating `.length` as a real nested field, which is almost never what the user meant. The `===`/`!==` path already had a guard, but it folded to an array-only `$size` peephole that *silently fails on strings*, and the ordered-comparison path (`<`, `>`, `<=`, `>=`) had no guard at all and leaked the dotted key.

New model (filter context), per the user: `.length` (and the JS-identical `["length"]` — `x["length"] === x.length`) is read against the RHS. **Vs a natural-number literal** (non-negative integer) → it's a string-or-array length; the whole comparison residualises into `$expr` so codegen emits the `$isArray`/`$size`/`$strLenCP` `$cond` (works on both types, unlike the removed `$size` peephole). **Vs anything else** (`3.5`, `"x"`, …) → a length can't equal a non-natural value, so `.length` reads as a literal field path and collapses into `{ "items.length": <value> }`. The natural-number test is the sole discriminator — there is intentionally no separate escape hatch; to read a field literally named `length` against a natural number, use `$getField($.x, "length")`.

Implementation: [src/match-translation.ts](../src/match-translation.ts) — replaced `translateLengthSize`/`orientLengthAndInt`/`asLengthFieldPath` with `isLengthAccess` + `isLengthVsNatural`, intercepting in both the equality and ordered branches of `translateLeaf`; extended `asFieldPath` to collapse `["length"]` like `.length`. [src/codegen.ts](../src/codegen.ts) — extracted `generateLengthAccess` and called it from both the `MemberAccess("length")` and `IndexAccess(StringLiteral "length")` cases so bracket and dot lower identically. Boundary: a `.length` compared against a non-literal residualises to the `$expr` length form (can't express a literal `length` field in `$expr` without `$getField`). Supersedes the old `$size` peephole documented in [match-query-translation.md](specs/match-query-translation.md).

---

## 2026-06-01 — feat: docs/DEFERRED.md + drift-protection test, the "I keep forgetting" antidote

Before this commit, "what's left to do?" had no single answer. Deferred items lived in 106 places — spec "Future work" sections, `## Out of scope` headers, code-comment asides, throw-string parentheticals, DEVLOG entries, and the user's head. Adding a new `// not yet supported` was a single keystroke that no test caught. The user said it plainly: "I keep forgetting about them. We need a system."

The system is a tag (`[DEF-NNN]`) + a row (in [`docs/DEFERRED.md`](DEFERRED.md)) + a test ([`test/deferred-coverage.test.ts`](../test/deferred-coverage.test.ts)) with four gates that run on every `npm test`:

- **FORWARD** — every `[DEF-NNN]` tag in the live surface must have a matching row in `DEFERRED.md`.
- **REVERSE** — every row in `DEFERRED.md` must be referenced by at least one tag (unless `status: design-only` — for unstarted design work that hasn't produced a rejection site yet).
- **UNTAGGED** — every "not yet supported" / "future work" / "deferred" / "out of scope" phrase must carry a `[DEF-NNN]` tag OR appear in [`test/deferred-allowlist.txt`](../test/deferred-allowlist.txt) with a one-line reason.
- **STALE-ALLOWLIST** — every entry in the allowlist must match at least one phrase in the live surface. The allowlist can only shrink — entries cannot accumulate dead weight that masks new untagged additions.

**Outcome.** New deferrals cannot be added silently. Shipping a deferred item requires deleting both the row and the tag in the same commit (REVERSE gate fires otherwise). Decisions to NOT implement go in `DEFERRED.md` §B so future-us doesn't blindly reconsider them — the "I forgot we already decided against this" failure mode in the other direction.

**Initial seeding.** 22 open items in §A and 6 won't-implement decisions in §B, drawn from a re-scan of the live surface on master. Items currently in flight by the parallel fork session (`claude/charming-hofstadter-c6a6a9`, 11 of its original 23 items still pending) are deliberately **not** in `DEFERRED.md` — their rejection sites are in the allowlist instead, with `# Fork-in-flight` annotations. As each fork wave lands, the allowlist entries it makes stale get removed (the STALE-ALLOWLIST gate forces this). Once the fork finishes, the allowlist's fork section is empty; any items the fork didn't ship get rolled into §A.

Tags retrofitted in this commit (low fork-conflict risk): DEF-001 (stream ternary in `pipeline.ts:1063`, `LANGUAGE.md`, `replace-stream-stage.md`), DEF-009 / DEF-010 / DEF-012 (let-bindings spec), DEF-011 (`||` partial extraction in `match-query-translation.md`), DEF-008 (`function` keyword future), DEF-020 (mongoose `Query.prototype` in spec + `mongoose.ts`), DEF-022 (`Number.isFinite` in `codegen.ts`). The other 14 open rows are `status: design-only` (no live rejection site yet — design work tracked here as a TODO before the first code lands).

**Convention rule.** Added [root `CLAUDE.md` § Maintain docs/DEFERRED.md](../CLAUDE.md#maintain-docsdeferredmd). Added a row to `docs/CLAUDE.md`'s file-tree table. One-line pointer at top of `LANGUAGE.md`. `README.md` deliberately untouched (per the user's explicit "Don't touch README" instruction during plan review).

**Coordination caveat.** This intentionally lands while the fork is still running. The user's "I keep forgetting" urgency outweighed the cleaner "wait for fork to settle" sequencing. The allowlist absorbs the in-flight mess; the STALE-ALLOWLIST gate makes the cleanup self-driving.

---

## 2026-06-01 — Wave 4: `$out` multi-method RHS + bound destination + `.copyWithin` (Wave 4 items #11, #12, #13)

Three independent items, all stage-position sugar around an existing surface:

**#11 multi-method `$out` RHS chain.** `$$$.archive = $$.filter(d => d.active).toSorted((a, b) => b.score - a.score).slice(0, 100);` now lowers to `[$match, $sort, $limit, $out]`. The chain dispatch in `lowerChainMethod` (out-translation.ts) routes every non-`.filter` method through the shared `STREAM_METHODS` registry — `.slice`, `.map`, `.toSorted`, `.toReversed`, `.flatMap`, `.concat` all flow through. `.filter` stays inline because it composes with the index-friendly `$match` translator. Methods *outside* the registry still throw an actionable "use a separate stage" error.

**#12 ParamRef bracket-LHS for `$out`.** `jsmql.compile(({ destColl }) => $$$[destColl] = $$)` now resolves the bracket-index at compile time when `destColl` is a string-typed parameter binding. `classifyStep` (out-translation.ts) gained ctx awareness — `ctx.bindings.has(name)` ⇒ resolve to the bound value; non-string bindings surface "parameter binding must be a string"; missing bindings keep the original "not a runtime expression" error.

**#13 `.copyWithin()` statement-position mutator.** `$.tags.copyWithin(2, 0, 2);` now lowers to a `$set` whose body is `$concatArrays: [prefix-slice, copied-slice, suffix-slice]`. Non-negative integer literals only (consistent with `.slice` / `.toSpliced` / `.fill`); the two-arg form treats `end` as the array's `$size` at runtime via `$max(0, $size - start)`. The expression-position rejection message now points at the statement-position alternative.

Files: [src/out-translation.ts](../src/out-translation.ts) (chain dispatch + ctx threading + ParamRef step), [src/pipeline.ts](../src/pipeline.ts) (two `lowerOut` / `detectOutAssign` call sites updated), [src/codegen.ts](../src/codegen.ts) (`.copyWithin` in `MUTATING_ARRAY_METHODS` + `buildCopyWithinRhs`). Specs: [docs/specs/out-stage.md](specs/out-stage.md), [docs/specs/method-dispatch.md](specs/method-dispatch.md). Tests: [test/out.test.ts](../test/out.test.ts) (7 new cases). 1594 tests pass.

---

## 2026-06-01 — Wave 5 (final batch): facet-let propagation + accumulator/window validation + trailing `$unset` peephole

Four items from the deferred-features catalog land together, finishing Wave 5:

**#28 outer `let` reaches `$facet` sub-pipelines.** Each facet branch operates on the same input docs that arrived at the outer `$facet` stage — those docs still carry the `__jsmql.<name>` fields the outer lets materialised into. A new `freshFacetCtx` helper in `src/codegen.ts` (sibling to `freshSubPipelineCtx`) constructs a fresh sub-pipeline ctx that *preserves* `pipelineLets`; `src/facet-translation.ts` uses it for each facet branch.

```js
let cutoff = $.threshold;
$ = { high: $$.filter(d => d.score > cutoff), low: $$.filter(d => d.score <= cutoff) };
// → [{ $set: { "__jsmql.cutoff": "$threshold" } },
//    { $facet: { high: [{ $match: { $expr: { $gt: ["$score", "$__jsmql.cutoff"] } } }],
//                low:  [{ $match: { $expr: { $lte: ["$score", "$__jsmql.cutoff"] } } }] } },
//    { $unset: "__jsmql" }]
```

**#22 accumulator-only operator validation.** `$accumulator`, `$addToSet`, `$bottom`/`$bottomN`/`$top`/`$topN`, `$push`, `$median`, `$percentile` now throw a precise compile-time error when used outside `$group` field-value slots or `$setWindowFields.output` slots. A new `accumulatorContext` field on `GenerateCtx` is set by `pipeline.ts:generateBodyObject` when descending into the right slot; `checkOperatorContext` (`src/codegen.ts`) gates accordingly. Operators that have *both* expression and accumulator forms (`$sum`, `$avg`, `$max`, `$min`, `$first`, `$last`, `$stdDev*`) stay unrestricted.

**#41 window-only operator validation.** Operators tagged `category: "window"` in the registry (`$rank`, `$denseRank`, `$documentNumber`, `$shift`, `$derivative`, `$integral`, `$expMovingAvg`, `$linearFill`, `$locf`, `$covariancePop`, `$covarianceSamp`) throw when used outside `$setWindowFields.output` slots. Same `checkOperatorContext` gate, narrower scope. Pipeline.ts handles the nested-output indirection: `$setWindowFields.output[<key>]` and `$bucket(Auto).output[<key>]` are walked via a new `generateNestedAccumulatorObject` helper that sets the right `accumulatorContext` per inner key.

**#36 trailing `$unset:__jsmql` peephole.** After a reshape-clearing stage (`$replaceWith`, `$replaceRoot`, `$group`, `$bucket`, `$bucketAuto`, `$facet`), the `__jsmql` field doesn't exist on the output doc — cleaning up an absent path is just noise. `shouldSkipTrailingNamespaceUnset` in `pipeline.ts` peeks at the last emitted stage and skips the cleanup when it's reshape-clearing. ~17 existing test snapshots had hardcoded the redundant `$unset` and were updated by a one-shot script (`/tmp/fix-unset-tests.mjs`) that drops the line after any reshape-clearing stage; non-clearing tests still emit the cleanup as before.

Files: [src/codegen.ts](../src/codegen.ts) (`accumulatorContext` field, `ACCUMULATOR_ONLY_OPERATORS`, `checkOperatorContext`, `freshFacetCtx`), [src/facet-translation.ts](../src/facet-translation.ts) (use freshFacetCtx), [src/pipeline.ts](../src/pipeline.ts) (`shouldSkipTrailingNamespaceUnset`, `NESTED_ACCUMULATOR_OUTPUT`, `generateNestedAccumulatorObject`, `accumulatorCtxFor`). Spec updates in [docs/specs/let-bindings.md](specs/let-bindings.md) and [docs/specs/aggregation-stages.md](specs/aggregation-stages.md). 1597 tests pass (8 new across codegen / let-bindings tests).

---

## 2026-05-31 — feat: nested lookups at any depth (the "v2 deferral" lands)

The deferred-features catalog's #1 — nested `$$$.<coll>.find/.filter(...)` inside another lookup's predicate — now works for expression-body lambdas at any depth. The previous `rejectNestedLookup` guards in `lowerLookup` / `tryExtractChainedLookup` and the `findFirstLookupInElement` walker in `pipeline.ts:generatePipelineWithCtx` are gone. Block-body nested lookups stay rejected with a precise message ("…not yet supported. Use an expression-body lambda…") — they need ctx-threading through `lowerBlock` that the expression-body path doesn't.

**How it works.** A new `EnclosingLookupContext` ({`foreignParams`, `inScopeLetNames`}) threads through `lowerLookup` → `translatePredicate` → `buildPipelineFormPredicate` → `extractLookupCalls` → `tryExtractChainedLookup` → `descendAndExtract`. Each recursive level grows `foreignParams` with the current lookup's lambda param, and grows `inScopeLetNames` with the letVar names it allocates. The outer lookup's `extractLetsFromExpr` walks down through nested lookup lambda bodies (via `mapChildren`'s MethodCall case, which the original code already did), rewriting `outerForeign.x` refs to `FieldRef("x")` in the inner body — exactly the shape the inner's classifyPath needs to auto-let them into the inner's `$lookup.let`.

**Worked example:**

```js
$.posts = $$$.posts.filter(p => p.userId === $._id && $$$.tags.filter(t => t.postId === p._id).length > 0);

// →
// [{
//   $lookup: {
//     from: "posts",
//     let: { _id: "$_id" },                       // outermost doc's _id
//     pipeline: [
//       { $lookup: {
//           from: "tags",
//           let: { _id: "$_id" },                 // post's _id (post is the local doc here)
//           pipeline: [{ $match: { $expr: { $eq: ["$postId", "$$_id"] } } }],
//           as: "__jsmql.__lookup1"
//       } },
//       { $set: { "__jsmql.__lookup1": { $size: "$__jsmql.__lookup1" } } },
//       { $match: { $expr: { $and: [{ $eq: ["$userId", "$$_id"] }, { $gt: ["$__jsmql.__lookup1", 0] }] } } }
//     ],
//     as: "posts"
//   }
// }]
```

The outer's `$$_id` resolves to the outer-most doc's `_id`. The inner's `$$_id` shadows that (its `let` declares `_id` again) and resolves to the post's `_id` while inside the inner's pipeline. The codegen ctx threads `inScopeLetNames` into `lambdaParams` so `$$<name>` references at each level resolve without throwing `UnknownIdentifier`.

**3-level (any depth) works the same way** — each level captures its own letVars; deeper levels inherit via lexical `$$` scope. See `test/lookup.test.ts` → "nested lookups (expression body, any depth)".

**Known limitation: cross-level field-name collision.** When the same field name (e.g. `_id`) is referenced at two different enclosing levels in the deepest predicate, both rewrite to `FieldRef("_id")` and the deepest level's let-allocator dedupes them into a single binding — `MQL`-valid but semantically wrong. Workaround: pick distinct field names per level. A future pass could allocate let-scope per enclosing level. Documented in `docs/specs/lookup-stage.md`.

**Removed dead code:** `rejectNestedLookup` and its `findFirstLookupPos`/`findFirstInArgs` helpers (lookup-translation.ts), the pre-walker rejection loop in `pipeline.ts:generatePipelineWithCtx`. Bare lambda-param refs in nested predicates (`o => o` — no member access) still throw the existing "Bare lambda parameter 'o' in a `$lookup` predicate is not yet supported" message during the outer's extraction, before nested materialisation runs — message wording unchanged, just reached via the new path.

Files: [src/lookup-translation.ts](../src/lookup-translation.ts) (`EnclosingLookupContext`, `rewriteEnclosingForeignParams` defensive helper, threaded recursion), [src/pipeline.ts](../src/pipeline.ts) (drop the sub-pipeline rejection loop). Spec: [docs/specs/lookup-stage.md](specs/lookup-stage.md) "Nested lookups" + "Future work". User docs: [docs/LANGUAGE.md](LANGUAGE.md). Tests: [test/lookup.test.ts](../test/lookup.test.ts) (6 new cases — 2-level filter/filter & find/find, outer-outer + outer-foreign refs, 3-level deep, cross-DB outer, compound predicates, bare-param rejection). 1578 tests pass.

---

## 2026-05-31 — feat: reducer body shapes — $first / $last / $push (Wave 2 #32)

`classifyAccumulatorExpr` in `src/stream-methods.ts` recognises three new
per-key body shapes, on top of the existing `$sum` / `$max` / `$min`:

| jsmql body | MQL operator |
|---|---|
| `acc ?? d.<path>` (or `acc.<key> ?? d.<path>`) | `$first: "$<path>"` — JS's `??` returns the LHS when non-null, else the RHS; the accumulator stays at the initial value until the first non-null arrival, exactly `$first`'s semantics across a group |
| `d.<path>` (body ignores acc) | `$last: "$<path>"` — body just returns the per-doc value, so every doc overwrites the accumulator; the final value wins |
| `[...acc, d.<path>]` or `acc.concat(d.<path>)` | `$push: "$<path>"` — single-element spread/concat. Multi-element spreads aren't recognised; the user can fall through to manual `$group`. |

Works in both wrap forms — the scalar `$$ = [{ <key>: $$.reduce(…, init) }]`
and the object-reducer `$$ = [$$.reduce((acc, d) => ({ ...acc, … }), { … })]`.
`lowerReduceWrap` maps the new accumulator kinds to their MQL operators.

`$avg`, multiplicative accumulators, and `$stdDevPop`/`$stdDevSamp` are still
not recognised — see `docs/specs/stream-methods.md`.

5 new cases in `test/stream-methods.test.ts`; 1583 tests pass.

---

## 2026-05-31 — feat: scope-encoding sugar for diagnostic / system source stages

MongoDB's diagnostic stages (`$indexStats`, `$collStats`, `$planCacheStats`, `$listSearchIndexes`, `$currentOp`, `$listSessions`, `$listLocalSessions`, `$listSampledQueries`, `$shardedDataDistribution`) were already in the STAGES registry and already compiled via the generic dispatch (`{ $indexStats: {} }` / `$indexStats({})`). What they lacked was a discoverable, *scope-aware* surface. They're **source** stages (must be first), and they differ by *where* they run, which the context-ref prefix now encodes — call the stage as a method on the ref whose scope matches: `$$.indexStats()`, `$$$$.currentOp({ allUsers: true })`, `$$$$.shardedDataDistribution()`. The method name is the stage name minus the `$`; the optional argument is the options object (omit → `{}`).

**Two tiers — collection (`$$`) and cluster/server (`$$$$`).** An initial draft of this feature put `$currentOp`, `$listSessions`, `$listLocalSessions`, and `$listSampledQueries` under `$$$` (current database), reasoning they run via `db.aggregate()`. That was wrong and was corrected during review: MongoDB requires them on the **admin** database (`$listSessions` reads the cluster-wide `config.system.sessions`), never your current application database, and they report deployment-wide state. `$$$` means "current database" (the DB `$$$.<coll>.find()` joins into), so `$$$.currentOp()` would read as "ops in *this* database" — which you physically cannot run. They're server/cluster-level → `$$$$`. So `$$$` carries **no** diagnostics (it keeps `$$$.<coll>.find()` lookups and the `$$$.<coll> = …` `$out` write); the real split is collection vs deployment — exactly the two-prefix shape originally proposed.

**Why the prefix carries the scope.** The prefix *is* the scope declaration — so a wrong-scope use (`$$.currentOp()` → "write `$$$$.currentOp(...)`") is a compile-time error that names the right prefix, catching the classic "ran `$currentOp` against a collection / against the wrong database" mistake before it reaches the driver. This is the "source visible after the prefix" convention (a diagnostic is a read from a source, like `$$$.<coll>.find()`), so it slots in beside the existing ref sugars without a new LHS marker.

**Disambiguation vs `$lookup`.** A diagnostic is a *direct* `MethodCall` on a bare ref node (`object: ClusterRef`); a lookup is a call on a `MemberAccess` wrapping the ref (`$$$.orders.find()`). The shapes never collide. On `$$`, `.push`/`.filter` stay owned by union/facet; `isSystemStageCall` only claims a `$$` method that is an actual diagnostic or a near-typo of one, so `$$.pop()` still routes to the union validator's `.push`/`.filter` guidance (and the union/codegen error wording is unchanged).

Mechanics: scope metadata lives in a new `diagnostic: { scope, options }` field on the nine STAGES entries (single source of truth); [src/system-stage-translation.ts](../src/system-stage-translation.ts) derives the method↔stage map and the per-scope suggestion lists from it (`isSystemStageCall` / `resolveSystemStageCall` / `notFirstStageMessage`); [src/pipeline.ts](../src/pipeline.ts) detects + first-stage-enforces in both `generatePipeline` and `generateImplicitPipeline` and adds the shape to `isStageCandidate`; [src/index.ts](../src/index.ts) broadens the bare-call auto-wrap (and the `jsmql.pipeline()` strict path) so a top-level `$$$$.currentOp()` flips into Pipeline mode without a trailing `;`; the three bare-ref codegen errors now list the diagnostic forms. New spec [docs/specs/system-stages.md](specs/system-stages.md); status updates in [docs/specs/context-references.md](specs/context-references.md); user reference in [docs/LANGUAGE.md](LANGUAGE.md#system--diagnostic-stages-indexstats-currentop-); 27 cases in [test/system-stages.test.ts](../test/system-stages.test.ts). Arrow-form TS types wait on the ambient-globals work (same as the existing `.push`/`.find` sugar).

---

## 2026-05-31 — Wave 1 of the deferred-features push: eight `$match` query-translator additions

Eight JS shapes that previously fell through to `$expr` (silently disabling MongoDB indexes) now translate to indexable query-document form. From the [deferred-features catalog](/Users/vasyl/.claude/plans/suggest-syntax-for-all-cheerful-meerkat.md) §A, items #15, #16, #19a–f and the `typeof === "boolean"` polish on #19c:

| jsmql source | MQL output (in `$match` position) |
|---|---|
| `$.tags.includes("vip")` | `{ tags: "vip" }` (implicit array-element / scalar-equality match) |
| `["a","b"].includes($.status)` | `{ status: { $in: ["a","b"] } }` |
| `$.name.match(/^a/i)` | `{ name: /^a/i }` (real `RegExp`) |
| `$.items.some(it => it.qty > 5)` | `{ items: { $elemMatch: { qty: { $gt: 5 } } } }` |
| `$.field === undefined` / `!== undefined` | `{ field: { $exists: false } }` / `$exists: true` |
| `typeof $.x === "boolean"` | `{ x: { $type: "bool" } }` (JS-form `"boolean"` mapped to BSON `"bool"`) |
| `$.items.length === 3` | `{ items: { $size: 3 } }` |
| `$.x % 5 === 0` | `{ x: { $mod: [5, 0] } }` |
| `$.tags.includes("a") && $.tags.includes("b")` | `{ tags: { $all: ["a","b"] } }` (folded from `&&`-chain on same field) |

**`undefined` is a new AST node**, parser-recognised keyword, lexer token. In aggregation expression position it throws an actionable `CodegenError` ("'undefined' is only meaningful in '$match' position …") — MongoDB's aggregation `$eq` can't distinguish missing from null cleanly, so we surface the ambiguity instead of silently mapping to `null`. In `$match` position the field-form translation emits `$exists: false` / `$exists: true`, which lines up with JS's "value is undefined / property is missing" semantics (BSON treats missing fields as undefined-like).

**Length-collapse fix.** `$.items.length === 3.5` (non-integer RHS) used to compile to `{ "items.length": 3.5 }` — a literal dotted-key match against a real (but unintended) MongoDB path. The translator now refuses to lower `.length`-bearing equalities except via the `$size` peephole; non-integer RHS falls through to `$expr` instead of producing the misleading dotted key.

**`.includes()` divergence is documented.** Expression-form `.includes()` is type-polymorphic (arrays via `$in`, strings via `$indexOfCP`-substring). Query-form on a field receiver emits the bare `{ field: value }` shape — array-element match or scalar equality, but NOT string substring. The divergence is documented in [docs/specs/match-query-translation.md](specs/match-query-translation.md) and [docs/LANGUAGE.md](LANGUAGE.md); users who want substring match in `$match` reach for `.match(/value/)`.

**`$all` folding is narrow on purpose.** Only when the *entire* `&&`-chain is `.includes(<lit>)` on the *same* field does it fold. Mixed chains (`.includes("a") && .age > 18`) emit each clause separately — the un-folded form has identical semantics on array-valued fields, so users can reorder to trigger the fold if they want it. The implementation walks the `BinaryExpr("&&", …)` tree before the generic `combineAnd` path sees it.

**Items 14 (`!expr` via De Morgan), 24 ($let-as-optimisation), 31 (spread-form concat-equivalent) were rejected as bad DX** and won't be implemented. Memory: `feedback_no_silent_output_drift.md` — "same input must produce same MQL output; an optimiser whose decision the user can't predict from the source is pure surprise".

Files: [src/match-translation.ts](../src/match-translation.ts), [src/lexer.ts](../src/lexer.ts), [src/ast.ts](../src/ast.ts), [src/parser.ts](../src/parser.ts), [src/codegen.ts](../src/codegen.ts), [src/lookup-translation.ts](../src/lookup-translation.ts) (UndefinedLiteral in the leaf-case switch). Tests: [test/match-translation.test.ts](../test/match-translation.test.ts) (38 new cases across 8 describe blocks).

Six more waves remain in the deferred-features push — see the plan file for the full schedule. Wave 2 lands stream-methods extensions (`$$.length`, dict-build reducers, registry integration with the lookup chain walker).

---

## 2026-05-31 — Wave 2 (partial): dict-build reducer wrap → `$group` + `$arrayToObject`

Item #30 from the deferred-features catalog: `$$ = [$$.reduce((acc, d) => ({ ...acc, [d.<k>]: <d.<v>|d> }), {})]` now lowers to the canonical pair `$group: { _id: null, __jsmqlDict: { $push: { k: "$<k>", v: "$<v>"|"$$ROOT" } } }` + `$replaceWith: { $arrayToObject: "$__jsmqlDict" }`.

**Why this is its own detector.** The shape overlaps with the existing object-reducer form (both look like `$$ = [$$.reduce(<2-arg lambda>, {<obj>})]`), but the lowering is different: object-reducer collects N named accumulators per the static keys in the body, dict-build collects ONE pair-array via `$push` and folds it via `$arrayToObject`. They can't share the same classification path because the existing one rejects computed keys outright. The new detector runs **before** `detectReduceWrap` in `pipeline.ts` to pre-empt the static-key error path; if the shape doesn't match (mixed static + computed, multiple computed entries, non-`{}` init, non-`d`-rooted key path), it returns null and the existing object-reducer handler picks up — emitting the same "computed keys aren't supported" error users would have seen before. Same error wording, same DX, just one more shape recognised.

**Supported body shapes.** Spread is optional (`{ ...acc, [d.k]: d.v }` and `{ [d.k]: d.v }` both work — the `...acc` is JS-faithful boilerplate). Keys and values both walk `d.<path>` chains, so nested paths work in both slots. Bare-doc value (`{ ...acc, [d.id]: d }`) lowers to `v: "$$ROOT"`. Anything else (computed key referencing `acc`, multiple computed entries, etc.) doesn't match and surfaces the existing error from the static-key path.

Files: [src/stream-methods.ts](../src/stream-methods.ts) (new `DictBuildWrap` type, `detectDictBuildWrap`, `lowerDictBuildWrap`, `paramFieldOrBareParam` helper), [src/pipeline.ts](../src/pipeline.ts) (one import + one branch in the chain dispatch). Spec: [docs/specs/stream-methods.md](specs/stream-methods.md). Tests: [test/stream-methods.test.ts](../test/stream-methods.test.ts) (6 new cases).

1533 tests pass. The richer-per-key-body-shapes item (#32) and `$$.length` terminal (#6) are queued behind this; they need their own design passes before lowering.

---

## 2026-05-31 — Waves 5 + 6: stream-RHS sugar (`$$ = []`, `$$ = [docs]`) + `Math.<fn>` bare callbacks

Three more items from the deferred-features catalog, all small and isolated:

**#2 `$$ = []` → `[{ $limit: 0 }]`.** Previously rejected with a "use `$match($expr(false))` or `$limit(0)`" hint. The hint was always the wrong thing to type at the call site — empty-array assignment is the natural JS shape for "drop everything". Lowers in `lowerReplaceStream` ([src/pipeline.ts](../src/pipeline.ts)) via a new `ArrayLiteral` branch that runs *after* the reduce-wrap detectors (so the wrap forms still win their shape).

**#5 `$$ = [{...}, {...}]` at stage 0 → `[{ $documents: [...] }]`.** Sibling sugar to #2 for the literal-doc seeder case. Constrained to stage 0 because MongoDB requires `$documents` at the head — mid-pipeline use throws an actionable error that names `$$.push({...})` (`$unionWith`) as the right tool for appending. Stage-index threading: `lowerReplaceStream` now takes an `isFirstStage: boolean`, and `lowerUpdateFilterWithLookups` takes a `globalStageIndex: number` so its inner `out.length` checks reflect the surrounding pipeline's running count.

**#39 `Math.<unary>` as a bare `.map` callback.** `arr.map(Math.floor)` now parses and lowers to `{ $map: { input: "$arr", as: "v", in: { $floor: "$$v" } } }`. Mirrors the existing `Number` / `Boolean` / `String` bare-callable pattern via a new `MathCallRef` AST node. Restricted to the unary Math methods (floor, ceil, round, abs, sqrt, trunc, sign, exp, log/log2/log10, cbrt, all trig methods) so the arity matches the JS callback contract — binary methods (`pow`, `min`, `max`, `hypot`, `atan2`) require explicit parens and surface a precise "Math.X requires '(...)'" error if reached as a bare ref. `Math.floor` used in non-callable value position throws an actionable "use as a callback" error.

**#36 (trailing `$unset:__jsmql` elision) is queued.** The peephole is straightforward — when the previous stage is in `RESHAPE_CLEARING_STAGES`, the trailing `$unset` is redundant — but landing it as-is would invalidate ~18 existing tests that hard-coded the `$unset` stage in their expected output. The optimisation is purely cosmetic (a `$unset` against an already-missing path is a no-op), so deferring it to a dedicated test-snapshot refresh.

Files touched: [src/pipeline.ts](../src/pipeline.ts), [src/parser.ts](../src/parser.ts) (`MathCallRef` parsing, new `UNARY_MATH_CALLABLES` set), [src/ast.ts](../src/ast.ts) (`MathCallRef` node), [src/codegen.ts](../src/codegen.ts) (`MathCallRef` desugar in `requireLambda`, error-case in main switch, scanner entry), [src/lookup-translation.ts](../src/lookup-translation.ts) (leaf-case for `MathCallRef`). Tests: [test/codegen.test.ts](../test/codegen.test.ts) (9 new Math.* bare-callable cases), [test/pipeline.test.ts](../test/pipeline.test.ts) (3 cases for `$$ = []` / `$$ = [docs]` / mid-pipeline rejection), [test/stream-methods.test.ts](../test/stream-methods.test.ts) (3 updated cases swapping the old "use wrap" error for the new `$documents` lowering).

1545 tests pass.

---

## 2026-05-30 — fix: array-returning reducer assigns unbracketed; bracketed wrap now throws

The array-returning reducer form was shipped requiring a bracket wrap — `$$ = [$$.reduce((acc, d) => acc.concat(d.<f>), [])]`. That's backwards: a reducer seeded with `[]` already *returns* an array, i.e. a stream, so wrapping it in `[ ]` yields `[[…]]` — a stream whose single document is itself an array. The correct surface is the **unbracketed** `$$ = $$.reduce((acc, d) => acc.concat(d.<f>), [])`, and that's now what's supported; the bracketed form throws an actionable `CodegenError` ("a reducer seeded with `[]` already produces a stream, so don't wrap it in `[ ]` — assign it directly").

This is **distinct** from the scalar wrap `$$ = [{ total: $$.reduce(…) }]` and the object-returning wrap `$$ = [$$.reduce(…, {})]`, both unchanged: those reducers return a single value/document, so `[ <doc> ]` is a legitimate one-document **stream literal**, not a wrapped stream. Only the array-returning form moved.

Mechanics ([src/stream-methods.ts](../src/stream-methods.ts) `detectArrayReducerWrap`): the detector now accepts the bare `MethodCall` shape (`$$.reduce` on a `CollectionRef` with an `[]` init) via a new `isArrayInitReduce` predicate, runs the same `classifyArrayReducerBody` path, and — when it instead sees the `ArrayLiteral`-of-one-such-reduce — throws the drop-brackets hint at the array literal's `pos`. The dispatch order in [src/pipeline.ts](../src/pipeline.ts) is unchanged: `detectReduceWrap` (scalar/object) still runs first and returns `null` for array-init reduces, then `detectArrayReducerWrap` fires before the chain walker would reject `.reduce` as an unknown method. The `.reduce`-not-a-chain-method hint in `unknownStreamMethod` now points the array case at the unbracketed form.

Updated: [docs/specs/stream-methods.md](specs/stream-methods.md), [docs/LANGUAGE.md](LANGUAGE.md#stream-methods-chained-after-the-rhs), the array-returning `describe` in `test/stream-methods.test.ts` (+ a new bracketed-throws case), and the "export contact details" scenario in `test/realistic.test.ts` (which the playground example island re-syncs from).

## 2026-05-30 — docs(README): replace-stream + stream-method highlights, fix stale Tour comment

The README's Highlights list had no bullet for `$$ = <expr>` (replace stream — narrow / source-switch / correlated `$lookup`-pivot) or for RHS stream-method chains (`.slice` / `.toSorted` / `.toReversed` / `.map` / `.flatMap` / `.concat` + reduce), even though both shipped over the past week and appear in the headline example. Added two bullets covering them. Also extended the "Filter vs Pipeline picked automatically" bullet to note statement-position array mutators (using `$.tags.sort()` / `$.events.reverse()` rather than `.push()`, which is ambiguous with the `$$.push(...)` stream-union form). And fixed a stale comment introduced by `93ad8b3`: it described an export-to-`$out` reduce example over what is actually a top-10-by-revenue `$group`/`$sort`/`$limit` pipeline. The reduce example shown in the new stream-method bullet uses the corrected unbracketed `$$ = $$.reduce(…, [])` form (see the entry above).

## 2026-05-29 — docs: showcase the "narrow + snapshot + `let` + pivot" idiom

The outer-`let`-into-`$lookup.let` work that landed earlier today is more than a one-off feature — composed with `.filter(...).slice(0, 1)` and a correlated source-switch, it gives users the JS-natural way to write "look up one doc, hold onto a scalar, fetch correlated rows from another collection". This is the shape every web app needs ("look up the logged-in user, then fetch their recent orders"), and historically has been a 20-30-line hand-written MQL recipe that even experienced MongoDB users get wrong (the `$unionWith`-has-no-`let:` trap).

The compiler already handled this idiom — but it wasn't called out as a recommended pattern. Three small docs/test additions fix that:

- **`test/realistic.test.ts`** — new `describe` block "snapshot one user, then pivot to their 5 most-recent orders". Three statements (`$$ = $$.filter(...).slice(0, 1)`, `let userId = $._id`, `$$ = $$$.orders.filter(o => o.userId === userId).toSorted(...).toReversed().slice(0, 5)`) compile to the expected `$match` + `$limit:1` + `$set` + `$lookup`-pivot + `$unwind` + `$replaceWith` + `$unset` chain. The playground sync hook surfaces it as an example automatically.
- **`README.md`** — new code block in the Tour with the same example side-by-side with its MQL output, plus a one-line "why $unionWith can't do this" note so readers see the DX value at the contrast point.
- **`docs/LANGUAGE.md`** — extended the "Replace stream via `$$ = <expr>`" section with a "Putting it all together — narrow, snapshot, pivot" subsection that names the idiom and shows the full lowering.

No code changes. This is a documentation-only commit — the underlying support for the idiom shipped in the preceding outer-`let` and chain-extension commits.

---

## 2026-05-29 — feat: `$$ = $$$.<coll>.filter(<correlatedPred>)` auto-rewrites to `$lookup` + `$unwind` + `$replaceWith`

`$$ = $$$.<coll>.filter(p)` previously rejected predicates that referenced the outer document (`$.<field>`) because the lowering used `$unionWith`, and MongoDB's `$unionWith` has no `let:` slot to thread outer-doc context into its sub-pipeline. The user was forced into the explicit `$.matched = $$$.coll.filter(p); $unwind($.matched); $ = $.matched;` chain — which works but reads like manual MQL plumbing.

This commit teaches `lowerChainOnCollection` to detect when the head's `.filter(p)` predicate is *correlated* (i.e. `extractLetsFromExpr` would hoist any `$.<field>` paths into `$lookup.let` vars) and auto-rewrite to a `$lookup` + `$unwind` + `$replaceWith` triple. The result is a stream of foreign docs correlated per outer doc — one output row per (outer × matching-foreign) pair, with the foreign doc as the new root.

```js
// Before: rejected with "$.<field> inside .filter of $$ = … is not supported"
$$ = $$$.users.filter(u => u._id === $.userId);

// After:
[
  { $lookup: { from: "users", localField: "userId", foreignField: "_id", as: "__jsmql.__lookup1" } },
  { $unwind: "$__jsmql.__lookup1" },
  { $replaceWith: "$__jsmql.__lookup1" },
  { $unset: "__jsmql" },
]
```

**Lowering family dispatch.** `predicateReferencesOuterDoc(lambda)` (new export from `lookup-translation.ts`) runs `extractLetsFromExpr` and reports whether any `$.<field>` paths would be hoisted. If yes → `$lookup`-pivot; if no → the existing `$limit:0 + $unionWith` form. Two lowerings, same JS syntax — the predicate's shape decides.

**Form choice within the pivot.** When the predicate is a single `===` between a foreign-path and a `$.<path>` AND there are no chain methods after `.filter`, `translatePredicate`'s basic form fires (`{ localField, foreignField }`) — same index-friendliness as a hand-written `$lookup`. With chain methods (`.toSorted` / `.slice` / `.map` / etc.) or richer predicates, pipeline-form with auto-hoisted `let` vars takes over so the chain stages can extend the sub-pipeline body — for example:

```js
$$ = $$$.orders
  .filter(o => o.userId === $._id)
  .toSorted((a, b) => a.placedAt - b.placedAt)
  .toReversed()
  .slice(0, 5);
// → $lookup { let: { _id: "$_id" }, pipeline: [$match, $sort, $limit], as: … }
//   + $unwind + $replaceWith
```

**Trade-offs.** `$unwind` drops outer docs with no matches by default. Users who need `preserveNullAndEmptyArrays` keep using the explicit `$.matched = $$$.coll.filter(p); $unwind($.matched, true); $ = $.matched;` chain. Outer-doc `let` bindings (a name bound via `let foo = …` then referenced inside the predicate) aren't yet recognised by `predicateReferencesOuterDoc` — that's a follow-up. The pivot always uses an internal `__jsmql.__lookup<N>` slot followed by `$unwind` + `$replaceWith`; a future micro-optimisation could detect when the chain is the entire RHS and skip the cleanup stages.

**Refactor.** Factored `tryExtractChainedLookup`'s pipeline-form predicate translation into a new exported `buildPipelineFormPredicate` helper in `lookup-translation.ts`, so the new pivot path and the existing chain-extension path share one translator (no second copy of the `extractLetsFromExpr` + `makeSubPipelineCtx` + `generateWithCtx` choreography).

User-facing reference: [docs/LANGUAGE.md → Replace stream](LANGUAGE.md#replace-stream-via--expr).

---

## 2026-05-29 — feat: outer `let` bindings cross the source-switch boundary as `$lookup.let` vars

The previous `$lookup`-pivot commit detected `$.<field>` refs in the predicate and routed them through `$lookup.let`, but **outer `let` bindings** weren't recognised — `let uid = $.userId; $$ = $$$.users.filter(u => u._id === uid);` errored with "Unknown identifier 'uid'". The user had to inline the path (`u._id === $.userId`) or pre-stash via `$.x = uid` before the source-switch, defeating the point of the `let` binding.

This commit extends `classifyPath` (in `lookup-translation.ts`) to recognise a `ParamRef` whose name is in `outerCtx.pipelineLets` as a new `outerLet` kind — and threads the outer-lets map through `tryBasicForm`, `extractLetsFromExpr`, `extractLetsFromPipeline`, and the `transformExpr` / `mapChildren` / `transformCallArgs` recursive walkers. `MemberAccess` chains on outer-let refs are also handled (`let user = $.user; … === user._id` resolves to the materialised path `__jsmql.user._id`).

```js
let uid = $.userId;
$$ = $$$.users.filter(u => u._id === uid);
// → [
//   { $set: { "__jsmql.uid": "$userId" } },
//   { $lookup: { from: "users", localField: "__jsmql.uid",
//                foreignField: "_id", as: "__jsmql.__lookup1" } },
//   { $unwind: "$__jsmql.__lookup1" },
//   { $replaceWith: "$__jsmql.__lookup1" },
//   { $unset: "__jsmql" },
// ]
```

**Basic vs pipeline form.** Outer-let refs DO qualify for the basic-form `$lookup` fast path when the predicate is a single `===` between a foreign-path and the outer-let — the `localField` becomes the let's materialised path (`__jsmql.<name>` or `__jsmql.<name>.<member>` for member-access chains). For richer predicates (multi-field correlations, mixed `$.<field>` + outer-let refs), pipeline-form with auto-hoisted `let` vars kicks in. `predicateReferencesOuterDoc` now picks up both kinds, so the source-switch dispatch in `lowerChainOnCollection` routes correlated predicates to `lowerLookupPivot` whether the correlation came from `$.<field>` or an outer `let`.

**Naming.** The `let`-var name in pipeline-form output is `segments[last]` of the access chain — same convention as local-path letVars. For bare `uid` → letVar `uid`; for `user._id` → letVar `_id`; collisions get the `_2` / `_3` / … uniquification suffix.

**Allocator.** `createLetAllocator` gains an `allocateForOuterLet(segments, fieldPath)` method that mirrors `allocateForLocalPath` but takes the materialised field path explicitly. `byPath` deduplication uses the field path as the dedup key so the same outer-let referenced twice in a predicate (e.g. `u.from === uid || u.to === uid`) produces one letVar.

**API.** `predicateReferencesOuterDoc(lambda, outerCtx)` now takes the ctx (was just the lambda). Callers update accordingly — only one in-tree caller (in `pipeline.ts`).

Spec note: the [docs/specs/lookup-stage.md](specs/lookup-stage.md) update is pending. User-facing reference: [docs/LANGUAGE.md → Correlated source-switch](LANGUAGE.md#replace-stream-via--expr).

---

## 2026-05-29 — Playground: GitHub links + compile-mode toggle

Several playground UX changes, all confined to `playground.html` (outside the two generated regions):

1. **"syntax reference" now points to GitHub** — `docs/LANGUAGE.md` (a relative path that 404s on the deployed playground) → `https://github.com/flash-oss/jsmql/blob/master/docs/LANGUAGE.md`.
2. **Classic GitHub corner ribbon**, pinned top-right, linking to the repo home (`https://github.com/flash-oss/jsmql`). Sized at 48px so it matches the header height; the header reserves 60px of right padding so the ribbon never overlaps the "Hide examples" toggle. The octocat fills with the page background colour (white) so it reads against the accent-blue triangle; the arm waves on hover and is stilled under `prefers-reduced-motion`.
3. **The input band's passive kind indicator became an active compile-mode toggle**, sitting in its own bar directly above the "MONGODB CALL" hint. Five mutually-exclusive, equal-width buttons — `filter` / `update` / `expr` / `pipeline` / `auto` — each dispatch the editor source through a different entry point (`jsmql.filter`, `jsmql.update`, `jsmql.expr`, `jsmql.pipeline`, and plain `jsmql()` for AUTO). Each button always carries its kind colour (like the badges); AUTO is deliberately colourless (neutral grey). Selecting an example resets the toggle to the mode it was authored with (`jsmql` → AUTO, `jsmql.expr` → expr); emptying the editor resets to AUTO.
4. **The "MONGODB CALL" hint is always visible and mode-driven**: it shows the exact driver call that produces the MQL in the output panel — `db.<coll>.find(jsmql.filter(...))`, `db.<coll>.aggregate(jsmql.pipeline(...))`, `db.<coll>.updateOne(filter, jsmql.update(...))`, `db.<coll>.aggregate([{ $addFields: { value: jsmql.expr(...) } }])`. For AUTO the method is chosen from the actual output shape (a Pipeline array → `aggregate`, a Filter document → `find`). The collection name is parsed from the active example's call site, falling back to a generic `collection` while typing freely.
5. **The expression-kind input label now gets its gradient** — only `pipeline` and `filter` had `.panel.input-panel.<kind> .label` gradient rules; added the `expression` variant (plus the missing `--expr-strong` border colour).

**Why the error-handling change matters.** `jsmql.validate()` checks source against the shape-detecting `jsmql()` semantics, so a strict-shape entry point can still *throw* at compile time even when validate reports valid — e.g. forcing `pipeline` mode on a bare predicate. `render()` now wraps the `compile(src)` call in try/catch and routes the thrown `CodegenError` (with its actionable "Call jsmql.filter() … or wrap as `$match(...)`" wording) into the error panel instead of stranding stale output.

The previously-passive `#current-kind` pill was removed (the toggle now communicates compile mode, and the sidebar badge + "MONGODB CALL" bar still show the example's kind).

---

## 2026-05-29 — Playground: output panel renders BSON dates as `new Date(...)`

The output panel is meant to be copy-paste source for a Node.js mongodb call, but Filter-mode dates broke that. `$.createdAt > new Date("2000-01-01")` lowers (via the match translator) to a query document holding a **real JS `Date` instance** — `{ createdAt: { $gt: <Date> } }`. The panel then serialised it two different, both-wrong ways depending on the prettify checkbox:

- **prettify off** used `JSON.stringify`, which turns a `Date` into an ISO **string** (`"2000-01-01T00:00:00.000Z"`) — pasteable, but the driver reads it back as a string, not a BSON date.
- **prettify on** used the custom fit-to-80 printer, which hit the `Date` via the generic-object branch and walked its (empty) own-keys into `{}` — pasteable but meaningless.

Fix (all in `playground.html`, outside the two generated regions): both modes now share one date-aware serialiser. Extracted the formerly-nested `compact()` to a sibling of `pretty()`, added an `encodeScalar()` leaf that emits `new Date(<ISO>)` for `Date` instances (and falls back to `JSON.stringify` otherwise), and pointed the prettify-off branch at `compact()` instead of raw `JSON.stringify`. `pretty()`'s recursion also gained a `Date` guard so a deeply-nested date that overflows the column budget can't fall into the object-expand path and re-emit `{}`. Result: both checkbox states emit identical, runnable `new Date("2000-01-01T00:00:00.000Z")` source. Verified in-browser by driving the two CodeMirror editors and `eval`-ing the output back to a real `Date`.

Only `Date` can reach the panel today — regex always lowers to `$regexMatch` strings, and the other opaque BSON values (`ObjectId`, `Uint8Array`) only arrive via template-tag interpolation, which the string-input playground can't produce.

Also relabelled the panel header `MQL output (JSON)` → `MQL output (Node/Deno/Bun)`: now that a `Date` renders as `new Date(...)`, the output is JS source for a driver call, not strict JSON, and the old label was a false promise.

Follow-up: swept `test/realistic.test.ts` for date fields compared against string literals (`$.placedAt >= "2026-01-01"`, `expiresAt`, `lastModifiedAt`, `lastSeen`, `createdAt`) and converted both the source and the expected MQL to `new Date(...)`. Modelling a timestamp as a bare string was a misleading example — MongoDB stores these as BSON dates, and a string comparison would silently never match. The playground examples island re-synced off these edits, so the live examples now show the date-typed form.

---

## 2026-05-28 — `.concat(...others)` chain method on `$$` (alias for `$$.push`)

JS-idiomatic alias for `$$.push(...)` in the chain context. `.concat` accepts the same arg shapes (spread of `$$$.<coll>[.filter(p)]`, inline `{...}` docs, `$$$.<coll>.find(p)`) and routes through `lowerUnionPush` — no second copy of the spread / inline-doc / `.find` validation logic. `$$.push(...)` remains the statement-only form; `.concat` is purely chainable, so `$$ = $$.filter(p).concat(...$$$.archive);` lowers to `[{$match}, {$unionWith: "archive"}]`.

The registry's `lower` signature gained a `lowerBlock: SubPipelineLowerer` parameter so the `.concat` entry can forward to `lowerUnionPush`. Existing `.slice` ignores the new parameter.

Spec: [docs/specs/stream-methods.md](specs/stream-methods.md). User-facing reference: [docs/LANGUAGE.md](LANGUAGE.md#stream-methods-chained-after-the-rhs).

---

## 2026-05-28 — `.flatMap(d => d.<path>)` chain method → `$unwind`

The chain-form way to introduce `$unwind` without reaching for `$op("$unwind", …)`. v1 only supports a bare field-path body (the lambda body must walk back to the param ref through `.member` / `["literal"]` access) — that lowers to a single `{ $unwind: "$<path>" }` stage with surrounding fields preserved.

Note this departs from JS `.flatMap` semantics — JS would yield just the bare elements; MQL `$unwind` preserves the surrounding doc with the array field replaced by one element. Users who want "just the elements" chain `.map(d => d.<path>)` after.

Complex bodies (`.flatMap(d => d.items.map(item => ({...})))`) are rejected — they'd require a slot allocator threaded through the chain walker (to materialise the per-doc array as a temp field before `$unwind`), which is a follow-up.

Spec: [docs/specs/stream-methods.md](specs/stream-methods.md). User-facing reference: [docs/LANGUAGE.md](LANGUAGE.md#stream-methods-chained-after-the-rhs).

---

## 2026-05-28 — `.map(d => <expr>)` chain method → `$replaceWith`

Chain-form of the existing `$ = <expr>` statement sugar. `$$ = $$.filter(p).map(d => ({ id: d._id, n: d.name }));` lowers to `[{$match: …}, {$replaceWith: { id: "$_id", n: "$name" }}]`. The lambda parameter IS the current document — `d.x` rewrites to the bare field path `$x` via `extractLetsFromExpr`, and `$.<field>` references are rejected with the standard "use the lambda parameter" hint.

**Out of scope (v1).** Two-arg arrows (`(d, i) => …`) are rejected — MongoDB streams have no per-doc index. Block-body arrows are rejected; split into separate stages instead. Lookups (`$$$.<coll>.find/filter(...)`) and `$$.push(...)` calls inside the body are also rejected — hoist them above the chain. The first two limitations stay permanently; the lookup-in-body restriction is a v1 simplification (the chain walker doesn't yet thread a slot allocator into per-method `lower` functions; doable in a follow-up).

The lower function emits `clearLets: true` because `$replaceWith` is a reshape stage that drops in-scope `let` bindings.

Spec: [docs/specs/stream-methods.md](specs/stream-methods.md). User-facing reference: [docs/LANGUAGE.md](LANGUAGE.md#stream-methods-chained-after-the-rhs).

---

## 2026-05-28 — `.reduce((acc, d) => …, init)` on `$$` chain → `$group { _id: null, … }`

Last method in the 2026-05 stream-methods batch. Folds the document stream down to a single doc carrying the aggregate. Pattern-matches the reducer body to one of MongoDB's accumulator operators:

- `acc + d.<field>` → `{ $sum: "$<field>" }`
- `acc + 1` → `{ $sum: 1 }` (count documents)
- `Math.max(acc, d.<field>)` → `{ $max: "$<field>" }`
- `Math.min(acc, d.<field>)` → `{ $min: "$<field>" }`

Output stream is a single doc `{ _id: null, value: <aggregate> }`. To get just the scalar, chain a `.map(r => r.value)` after — though most call sites at this point are terminal and the user reads `result[0].value` driver-side.

The `init` argument is required (JS-faithful — `.reduce` without an initial value is a footgun in JS too) but its specific value doesn't affect the MQL output. MongoDB's `$group` accumulators have their own neutral elements (`$sum` starts at 0, `$max` at `null` then takes any value, etc.). The init is validated to be a literal so a stray `$.field` reference can't leak through unnoticed.

This is **distinct** from the existing `$$$.<coll>.find/filter(...).reduce(...)` chained terminal in [`src/lookup-translation.ts`](../src/lookup-translation.ts) — that one builds a `$reduce` expression over a materialised array slot (different surface, different operator). Intentionally kept separate.

**Other reducer shapes (`acc * d.x`, `acc.concat(...)`, etc.) are rejected** with an explicit list of the v1-supported shapes. The pattern is conservative on purpose: a misclassified accumulator (e.g. silently widening `acc + d.x * 2` to `$sum: { $multiply: ["$x", 2] }`) would be hard to debug. Future broadening is a matter of extending `classifyReduceBody`.

Spec: [docs/specs/stream-methods.md](specs/stream-methods.md). User-facing reference: [docs/LANGUAGE.md](LANGUAGE.md#stream-methods-chained-after-the-rhs).

---

## 2026-05-28 — `.toReversed()` chain method → flips the preceding `$sort`

Second ES2023 immutable-array method. Zero-arg, must immediately follow `.toSorted(...)` in the same chain — MongoDB streams of documents have no natural ordering, so reversing requires a sort key. Rather than appending a new stage, the lowering rewrites the previous `$sort` with every direction flipped (1 ↔ -1). Net stage count stays equal to a hand-written descending `.toSorted`.

To make this work, the registry's `lower` signature gained a fifth parameter — `prevStages: readonly object[]` — and the result type a `replacesPreviousStage?: boolean` flag. The chain walkers in [src/pipeline.ts](../src/pipeline.ts) (`lowerChainOnStream` / `lowerChainOnCollection`) pass the accumulator-so-far as `prevStages` and pop the last stage when the flag is set. Existing methods (`.slice`, `.concat`, `.map`, `.toSorted`) ignore the new parameter.

Rejections: `.toReversed()` without a preceding `.toSorted` errors with "needs a sort key" pointing at the descending `.toSorted` alternative; non-numeric sort directions (text-meta etc.) are rejected; positional args are rejected.

Spec: [docs/specs/stream-methods.md](specs/stream-methods.md). User-facing reference: [docs/LANGUAGE.md](LANGUAGE.md#stream-methods-chained-after-the-rhs).

---

## 2026-05-28 — `.toSorted((a, b) => …)` chain method → `$sort`

The first ES2023 immutable-array method to land. Accepts a comparator-shape expression body built from `a.<path> - b.<path>` (ascending), `b.<path> - a.<path>` (descending), and `||` combining multiple terms (compound sort). Source order of `||` branches becomes the key order of the emitted `$sort` document — `(a, b) => a.x - b.x || b.y - a.y` lowers to `{ $sort: { x: 1, y: -1 } }`.

A small recursive parser (`parseComparatorBody` in [src/stream-methods.ts](../src/stream-methods.ts)) walks the body. Each subtraction is classified via `classifyComparatorPath`, which walks `MemberAccess` / string-literal `IndexAccess` back to the originating param ref and reports the dotted path. Mismatched paths (`a.x - b.y`), non-subtraction terms (`a.x + b.x`), and bare `.toSorted()` (default JS string compare — MongoDB has no natural document ordering) all error with actionable messages.

Spec: [docs/specs/stream-methods.md](specs/stream-methods.md). User-facing reference: [docs/LANGUAGE.md](LANGUAGE.md#stream-methods-chained-after-the-rhs).

---

## 2026-05-28 — Array mutators mutate at statement position; `.toSorted(keyFn)` accepts a key function

JavaScript's array mutators — `.sort()`, `.reverse()`, `.push()`, `.pop()`, `.shift()`, `.unshift()`, `.splice()`, `.fill()` — now lower to `$set` stages when called at statement position on a writable field-path receiver (`$.<path>` or `$.a.b.c`). Expression-position calls still throw the existing DX errors, now updated to mention the statement-position option alongside the immutable variant.

The mechanism is a pure AST pre-pass: `tryRewriteMutatorCall` in [`src/codegen.ts`](../src/codegen.ts) returns a synthetic `AssignExpr { target: <receiver>, value: <immutable RHS> }` when both predicates match; the synthesized RHS uses existing AST node types (a `.toSorted` MethodCall for `.sort`, an `$concatArrays` OperatorCall for `.push`, an IIFE for `.fill`) so codegen has no new branches. Both pipeline lowering paths in [`src/pipeline.ts`](../src/pipeline.ts) call the helper before classifying a statement; `index.ts`'s top-level dispatcher also calls it so `jsmql("$.events.push(x)")` (no trailing `;`) routes to Pipeline mode the same way `$.a = 1` already does. The synthesized assignment is indistinguishable from explicit `=` at the coalescer, so chained mutators on the same field split on read-after-write the same way explicit assignments do.

The change also fixed `.reverse()`, which was previously aliased to `.toReversed()` (silently non-mutating). With JS semantics restored, `.reverse()` mutates at statement position and throws at expression position. Two tests that exercised `.reverse()` in expression position were updated to `.toReversed()`. Pre-1.0, so this is allowed to break.

Separately, `.toSorted()` (and the new `.sort()`) now accept an optional 1-parameter key-function lambda — `e => e.distance` lowers to `sortBy: { distance: 1 }`, unary `-` flips direction, nested member paths produce dotted keys. Comparator-style `(a, b) => …` is rejected with a pointer at `$op($sortArray, { input, sortBy })`. The new helper `lambdaToSortBy()` lives next to the `.toSorted` case in `codegen.ts`. `.copyWithin()` was deferred (no clean MQL shape; the existing throw still names the workaround).

Spec: [docs/specs/method-dispatch.md § Mutators at statement position](specs/method-dispatch.md#mutators-at-statement-position) and [docs/specs/update-filter.md § Mutating-method desugar](specs/update-filter.md#mutating-method-desugar). User-facing reference: [docs/LANGUAGE.md § Mutators](LANGUAGE.md#array-methods).

---

## 2026-05-28 — Drop "v2" framing on nested lookups (planned future work, not forbidden)

Three internal comments and one `docs/CLAUDE.md` cell described the nested-lookup rejection as "deferred to v2" — but per the file-header convention there is no v2 ([docs/DEVLOG.md:1357](DEVLOG.md#2026-04-…)), the project is pre-`0.1.0`, and the framing wrongly suggested the feature is forbidden rather than planned. Rewording: "deferred to v2" → "planned future work" everywhere it appeared, with a pointer to the lookup-stage spec's existing "Future work" section.

**Files touched.**
- [src/lookup-translation.ts:1231-1262](../src/lookup-translation.ts) — block comment over `rejectNestedLookup` now says the work is planned and names the blocker (auto-`let` extraction across two binding scopes); the closing reference to "the exact case we explicitly defer to v2" is now "the exact case the nested-lookup future-work item is planned to handle".
- [src/pipeline.ts:991-996](../src/pipeline.ts) — sub-pipeline guard's comment now says "not yet implemented … tracked as planned future work" with a pointer to the spec.
- [src/pipeline.ts:1009](../src/pipeline.ts) — adjacent `$$.push(...)` reject-comment lost its trailing "Reject for v1." → just "Reject."
- [src/stream-methods.ts:226-233](../src/stream-methods.ts) — explanatory comment in `.map` body lowering now references "the let-coordination problem that blocks the general nested-lookup case" instead of "the v2-deferred let-coordination case".
- [docs/CLAUDE.md:41](CLAUDE.md) — spec table cell: "nested-lookup-deferred-to-v2 boundary" → "nested-lookup rejection (planned future work — see the spec's "Future work" section)".
- [docs/LANGUAGE.md:556-557](LANGUAGE.md) — user-facing caveat reworded from "not yet supported in this release" / "deferred" to "planned but not yet implemented" / "also planned (see `$$$` schema-threading work)", and now names the design problem (extracting outer-doc + outer-foreign-doc binding sources).

**Runtime behaviour unchanged.** The two reject sites — `rejectNestedLookup` in `lookup-translation.ts` and the pre-walker in `generatePipelineWithCtx` in `pipeline.ts` — still throw the same error text ("not yet supported in this release. Hoist the inner lookup to a sibling stage in the outer pipeline."). Only internal comments and the doc-facing prose changed.

**Why this matters.** The library is pre-1.0 and the rule from the project-wide CLAUDE.md and from the earlier "drop v1..v4 labels" entry is that phase markers are noise — they read as released-versioning that doesn't exist here. The nested-lookup rejection is the most architecturally weighty item on the deferred list; framing it as "future work, here's why it's hard, here's the spec section" invites someone to pick it up. Framing it as "deferred to v2" invites the wrong question ("when does v2 ship?").

---

## 2026-05-28 — feat: array-returning reducer wrap `$$ = [$$.reduce(... => acc.concat(...), [])]`

Third (and last for this batch) reduce-wrap form. Where the scalar / object wraps both lower to `$group` + `$replaceWith` (single summary doc out), the array-returning form is a filter-and-map flattener:

```js
$$ = [$$.reduce(
  (acc, d) => (d.active && d.contactDetails.email ? acc.concat(d.contactDetails) : acc),
  []
)];
// →
[
  { $match: { $expr: { $cond: [<truthy(d.active)>, "$contactDetails.email", "$active"] } } },
  { $replaceWith: "$contactDetails" }
]
```

Equivalent to `$$.filter(d => cond).map(d => d.contactDetails);` written as a single reducer. The point isn't terseness — the user can already write the explicit filter+map chain — it's keeping the `.reduce` mental model coherent: if the reducer returns an array, the wrap consumes that array as the new stream, just like JS would. The other two wraps reject the wrong return types; this one accepts the JS-faithful "array-out" case.

**Supported body shapes.** v1 recognises just two — both centred on `acc.concat(<arg>)`:

| Shape | Lowering |
|---|---|
| `acc.concat(d.<path>)` (unconditional) | `[{ $replaceWith: "$<path>" }]` |
| `<cond> ? acc.concat(d.<path>) : acc` (ternary) | `[{ $match: <cond translated> }, { $replaceWith: "$<path>" }]` |
| `acc.concat(d)` (bare param) | `[]` (identity) |
| `<cond> ? acc.concat(d) : acc` | `[{ $match: <cond translated> }]` (filter only) |

The condition translates through `lowerStreamFilterPredicate` — the same engine `.filter` uses — so it gets the full match-translator treatment (index-friendly query syntax when possible, `$expr` fallback otherwise) and the same `$.<field>`-is-rejected rule.

**Constraints.** Init must be `[]` (a non-empty seed array isn't expressible in MQL accumulator semantics). The ternary alternate must be bare `acc` (`<cond> ? <concat> : acc`) — other alternates break the "this either adds an element or doesn't" pattern. Spread-form variants (`[...acc, d.<x>]`, multi-element wrappers like `acc.concat([d.<x>, d.<y>])`) aren't recognised in v1 — the JS-equivalent semantics aren't representable as a single `$replaceWith` projection.

**Implementation.** `detectArrayReducerWrap` lives in [src/stream-methods.ts](../src/stream-methods.ts) alongside the other reduce detectors, dispatched at the array-init branch (the scalar/object detector falls through when it sees an `ArrayLiteral` init). `lowerArrayReducerWrap` lives in [src/pipeline.ts](../src/pipeline.ts) so it can reuse `lowerStreamFilterPredicate` for the condition. The `unknownStreamMethod` and `rejectInvalidReplaceStream` error messages now list all three wrap shapes.

Spec: [docs/specs/stream-methods.md](specs/stream-methods.md). User-facing reference: [docs/LANGUAGE.md](LANGUAGE.md#stream-methods-chained-after-the-rhs).

---

## 2026-05-28 — feat: object-returning reducer wrap for `$$ = [$$.reduce(…)]`

Sibling to the scalar wrap added last commit. Where the scalar form puts one `$$.reduce(...)` per named field in an inline object:

```js
$$ = [{ count: $$.reduce((acc, d) => acc + 1, 0),
        total: $$.reduce((acc, d) => acc + d.amount, 0) }];
```

…the object-reducer form names every accumulator inside one reducer body:

```js
$$ = [$$.reduce(
  (acc, d) => ({ ...acc, count: acc.count + 1, total: acc.total + d.amount }),
  { count: 0, total: 0 }
)];
```

Both lower to the same `$group` + `$replaceWith` pair (one `$group` across all keys, then a `$replaceWith` that drops `_id`). The user picks whichever shape reads best at the call site — `classifyAccumulatorExpr` does the per-key body classification for both, parameterised on what counts as "the accumulator reference" (bare `acc` for the scalar form, `acc.<key>` for the object form).

**Object-reducer specifics.** Optional leading `...acc` spread (must be first, must spread the accumulator param specifically); subsequent entries are `<key>: <expr>` pairs. Each entry's body must reference `acc.<sameKey>` — `total: acc.count + d.amount` is rejected with `Each entry must reference 'acc.total'`. The init object must declare the same key set as the body — asymmetric sets throw with `init is missing keys [...]` / `body is missing keys [...]` (in JS this would silently work but produce the wrong shape).

The `unknownStreamMethod` rejection for the bare `.reduce` chain form now lists both wrap shapes.

**Out of scope (v1).** Dictionary-build reducers (`(acc, d) => ({ ...acc, [d.k]: d.v })`) would need `$arrayToObject` + `$push` (push `{ k, v }` pairs in `$group`, convert in `$replaceWith`) — a different lowering family. Richer per-key body shapes (multiplicative accumulators, `$avg`, `$first`/`$last`, …) are also future work.

Spec: [docs/specs/stream-methods.md](specs/stream-methods.md). User-facing reference: [docs/LANGUAGE.md](LANGUAGE.md#stream-methods-chained-after-the-rhs).

---

## 2026-05-28 — feat: stream-method chains push into the `$lookup.pipeline` body

Before this commit, `$.<field> = $$$.<coll>.filter(p).<chain>` in expression position materialised the lookup into an internal slot first and applied each chain method via the **expression-form** of its operator — `$map` for `.map`, `$filter` for `.filter`, `$slice` (wrapped in `$cond` + `$isArray` guards) for `.slice`. That mostly worked but failed for methods without a clean expression form: `.toSorted((a, b) => a.x - b.x)` errored out (no `$sortArray` comparator form), and `.flatMap` had no expression-form equivalent at all.

This commit pushes any chain of registered stream methods after `$$$.<coll>.filter(<pred>)` into the `$lookup.pipeline:` body. The slot then holds the already-transformed array, and methods get their proper stage-form lowering:

```js
$.recentOrders = $$$.orders
  .filter(o => o.userId === $._id)
  .toSorted((a, b) => a.placedAt - b.placedAt)
  .toReversed()
  .slice(0, 5)
  .map(o => ({ id: o._id, total: o.total }));
// →
[
  { $lookup: { from: "orders", let: { _id: "$_id" },
    pipeline: [
      { $match: { $expr: { $eq: ["$userId", "$$_id"] } } },
      { $sort: { placedAt: -1 } },
      { $limit: 5 },
      { $replaceWith: { id: "$_id", total: "$total" } },
    ],
    as: "__jsmql.__lookup1" } },
  { $set: { recentOrders: "$__jsmql.__lookup1" } },
  { $unset: "__jsmql" },
]
```

**Implementation.** A new `tryExtractChainedLookup` in [`src/lookup-translation.ts`](../src/lookup-translation.ts) walks the chain back to its innermost receiver, checks for a `.filter` lookup head + a tail of registered stream methods (via `lookupStreamMethod` from [`src/stream-methods.ts`](../src/stream-methods.ts) — a cycle-safe runtime import), forces pipeline-form predicate translation, and runs the chain methods through the registry's `lower(... inSubPipeline = true)` path. The result substitutes a `FieldRef(slot)` for the entire chain; the surrounding expression's codegen reads the slot as `"$<slot>"`.

The check fires AFTER the existing `.length` / `.reduce` / direct-lookup checks so those terminals keep their precedence — `.filter(p).map(...).length` still emits `$size` against the materialised (and transformed) slot. Non-registered chain methods (`.toLowerCase`, `.padStart`, …) fall through to the existing `descendAndExtract` expression-form path, so unrelated string / array operators on lookup results are unaffected.

`.find` heads are deliberately not eligible — they return scalar-or-null after the `$first` wrap; chain methods don't have a stream-shape to extend in that case.

**Future optimisation.** When the chain is the entire RHS of a `$.<field> = <chain>` assignment, the `as` slot could be the field path directly — collapsing the trailing `$set` + `$unset` cleanup and producing a single-stage lookup. Detection at the AssignExpr level (mirroring the existing direct-lookup branch in `lowerUpdateFilterWithLookups`) is a follow-up.

Spec: [docs/specs/lookup-stage.md](specs/lookup-stage.md) — needs an update. User-facing: [docs/LANGUAGE.md → Cross-collection lookups](LANGUAGE.md#cross-collection-lookups-collfind--filter).

---

## 2026-05-28 — fix: `.reduce` on `$$` — replace the bogus `$group {value: …}` chain method with the explicit wrap pattern

The original `.reduce` chain-method on `$$` (added a few commits ago) was wrong. JS `arr.reduce(...)` returns a scalar / object / array depending on the reducer; my implementation silently produced a single-doc stream `[{_id: null, value: <aggregate>}]` and treated that as "the stream". That violates the project-wide invariant that `$$` is always a stream of documents — assigning a scalar to it doesn't make sense.

**Fix.** `.reduce` is no longer a chain method. Two changes:

1. **Reject `.reduce` as a chain method** with an actionable wrap-pattern hint in `unknownStreamMethod` (so `$$ = $$.reduce(...)` and `$$ = $$.filter(p).reduce(...)` both error and point the user at the wrap).
2. **Add the explicit wrap form**: `$$ = [{ <key>: $$.reduce((acc, d) => …, <init>), … }];` lowers to `[{ $group: { _id: null, <key>: { $<op>: … }, … } }, { $replaceWith: { <key>: "$<key>", … } }]`. Multiple aggregates share one `$group` stage. The wrap is detected in `lowerReplaceStream` via the new `detectReduceWrap` exported from `src/stream-methods.ts`.

The wrap makes the JS-faithful semantic explicit: the user is wrapping a scalar/object into a single-doc stream by hand, exactly as they'd write `[{ count: arr.length }]` in JS. The pattern is also more useful than the old chain method — the user names each aggregate field, and multiple aggregates compose into one `$group`.

**Reducer body shapes** stay the same (`acc + d.<field>` → `$sum`, etc.); `classifyReduceBody` is reused from the old code. `init` must be a literal (was already enforced); object-returning reducers (`$$ = [$$.reduce((acc, d) => ({...acc, ...}), {})]`) are future work.

The lookup-chain `.reduce` terminal in [`src/lookup-translation.ts`](../src/lookup-translation.ts) is unaffected — that one's a `$reduce` *expression* over a materialised array slot, which is its own surface and stays.

Also tightened `rejectInvalidReplaceStream`: a non-empty ArrayLiteral RHS that *isn't* the reduce-wrap now gets a precise "use the wrap pattern, or `$$.push(...)` if you wanted a literal-doc seeder" message instead of the generic "`$$ = []` not supported" one.

Spec: [docs/specs/stream-methods.md](specs/stream-methods.md). User-facing reference: [docs/LANGUAGE.md](LANGUAGE.md#stream-methods-chained-after-the-rhs).

---

## 2026-05-28 — Lookups inside `.map(d => …)` body — supported in lookup-body context too

Removes the `inSubPipeline` rejection branch introduced one commit earlier. `$$ = $$$.users.filter(p).map(d => ({ a: $$$.archive.find(x => x._id === d._id) }));` now lowers to a `$unionWith.pipeline` containing a nested `$lookup`:

```js
[
  { $limit: 0 },
  { $unionWith: { coll: "users", pipeline: [
    { $match: { active: true } },
    { $lookup: { from: "archive", localField: "_id", foreignField: "_id", as: "__jsmql.__lookup1" } },
    { $set: { "__jsmql.__lookup1": { $first: "$__jsmql.__lookup1" } } },
    { $replaceWith: { a: "$__jsmql.__lookup1" } },
  ] } },
  { $unset: "__jsmql" },
]
```

**Why the original rejection was conservative.** The project-wide "nested lookup deferred to v2" rule (still in force for `$lookup.pipeline` and `$facet.*` containing inner lookups) is about *let-binding coordination* — outer-pipeline `let` slots can't be threaded across the sub-pipeline boundary because `$unionWith` has no `let:` slot, and `$lookup.pipeline` does have one but threading the outer scope through it gets complex. For our case the lookup inside `.map` doesn't reference any outer-pipeline let-bindings — it correlates only against the foreign collection's current doc (the user's doc inside the `$unionWith.pipeline`), which is the *local* doc of that sub-pipeline. Both basic-form (`{localField, foreignField}`) and pipeline-form (`{let: {field: "$field"}, pipeline: [...]}`) correlate correctly: the field paths are resolved against the sub-pipeline's stream.

Pipeline-form also works: `.map(d => ({ archives: $$$.archive.filter(x => x.userId === d._id && x.tier === d.tier) }))` hoists `d._id` / `d.tier` to `$lookup.let` slots, and the resulting `$lookup` (with `let: { _id: "$_id", tier: "$tier" }`) sits inside the outer `$unionWith.pipeline` with its `let:` slots correctly referencing the users-doc fields.

Spec: [docs/specs/stream-methods.md](specs/stream-methods.md). User-facing reference: [docs/LANGUAGE.md](LANGUAGE.md#stream-methods-chained-after-the-rhs).

---

## 2026-05-28 — Lookups inside `.map(d => …)` body — supported in top-level `$$` chain

The original `.map` commit deferred lookups in the body (`.map(d => ({ a: $$$.archive.find(x => x._id === d._id) }))`) because the chain walker didn't thread a slot allocator into per-method `lower` functions. This commit threads `allocSlot` (and an `inSubPipeline: boolean` flag) through `lowerReplaceStream` → `lowerChainOnStream` / `lowerChainOnCollection` → `def.lower`, and rewrites `MAP.lower` to run the rewritten body through `extractLookupCalls` after the `extractLetsFromExpr` pass.

The flow: `extractLetsFromExpr(body, "d")` rewrites every `d.<path>` (including ones inside the lookup's predicate lambda — the walker recurses into nested lambdas) to bare `FieldRef`s. The lookup's predicate then sees `x._id === FieldRef("_id")`; `tryBasicForm` recognises the foreign-vs-local split and emits the basic-form `$lookup { localField, foreignField }`. `extractLookupCalls` allocates an `__jsmql.__lookup<N>` slot, emits the prologue `$lookup` (+ `$set { $first }` for `.find`), and rewrites the body to reference the slot. `MAP.lower` then emits `[...prologue, { $replaceWith: <body> }]`.

**Lookup-body context (`$$$.<coll>.filter(p).map(...)`) keeps the rejection.** Materialising a lookup there would land a nested `$lookup` inside the outer `$unionWith.pipeline` — the same nested-lookup case that's deferred to v2 elsewhere in the codebase. The rejection message names the offending shape and points at the "hoist to a sibling stage" fix.

**Registry signature change:** `StreamMethodDef.lower` now takes `allocSlot: SlotAllocator` (the pipeline's tracker) and `inSubPipeline: boolean` (true when the chain is in a `$unionWith.pipeline` body). All other methods (`.slice`, `.concat`, `.toSorted`, `.toReversed`, `.flatMap`, `.reduce`) ignore the new params.

Spec: [docs/specs/stream-methods.md](specs/stream-methods.md). User-facing reference: [docs/LANGUAGE.md](LANGUAGE.md#stream-methods-chained-after-the-rhs).

---

## 2026-05-28 — Stream-method registry + `.slice(start, end?)` on `$$` / `$$$.<coll>` chains

The RHS of `$$ = …` was limited to a single `.filter(<pred>)` call. To make chains like `$$.filter(p).slice(0, 10)` work — and to give the planned ES2023 immutable-array methods (`.toSorted`, `.toReversed`, …) one place to live — this commit introduces a per-method registry at [`src/stream-methods.ts`](../src/stream-methods.ts) and rewires `lowerReplaceStream` to walk arbitrary method chains through it. `.slice(start, end?)` is the first registered entry.

**Registry shape.** One entry per JS method (`StreamMethodDef`), each declaring an `arity` / arg-shape validator and a `lower(args, ctx, callPos) → { stages, clearLets? }` lowering. The chain walker in [`src/pipeline.ts`](../src/pipeline.ts) (`lowerChainOnStream` for the `$$` head, `lowerChainOnCollection` for the `$$$.<coll>` head) collects the chain via `collectStreamChain`, treats `.filter` as the optional first method (still handled by the pre-existing `lowerStreamFilterPredicate`), then dispatches every subsequent call through `lookupStreamMethod`. Adding a new method later is a registry entry + tests — no parser or chain-walker changes.

**`.slice(start, end?)` lowering.** Non-negative integer literals only in v1. `start === 0` skips the `$skip` emission; an absent `end` skips the `$limit`; `slice(0)` produces zero stages. Inside a `$$$.<coll>` chain the same stages land inside the emitted `$unionWith.pipeline` body — same registry entry, two contexts.

**Error wording.** Unknown method names now run through a chain-aware `unknownStreamMethod` helper. `.find` / `.findLast` / `.at` get an explicit message naming pipelines-are-arrays and pointing at the `.slice(0, 1)` / `.slice(n, n+1)` equivalents; for `$$$.<coll>.find(...)` the message also points at `$ = $$$.<coll>.find(<pred>)` as the lookup-context single-doc form. Other unknown names get a `closestNameTo` suggestion against `.filter` plus the registered method list. The previous `'$$ = …' RHS supports only '.filter'` wording was retired — it's no longer accurate now that the chain is open-ended.

**Out of scope (this batch).** Bare-statement `$$.<chain>;` (no `$$ =`) is still rejected; the user opted to keep the explicit assignment form. `$$$.<coll>.find/.filter(p).<chain>` in **expression position** (as a value, not the RHS of `$$ = …`) still uses the existing chained-terminal walker in [`src/lookup-translation.ts`](../src/lookup-translation.ts) for `.length` / `.reduce` only — routing that walker through the registry is a follow-up. Top-level `$$.length` is also intentionally deferred; the mapping (`$count: "<auto-slot>"`) is clear but held back until the surrounding registry shape proves out.

Spec: [docs/specs/stream-methods.md](specs/stream-methods.md). User-facing reference: [docs/LANGUAGE.md](LANGUAGE.md#stream-methods-chained-after-the-rhs).

---

## 2026-05-27 — `$$ = <expr>` → `$match` / `$limit:0 + $unionWith` (replace stream)

Sister to `$ = <expr>` (single-doc replacement) at the stream level: `$$ = …` replaces the pipeline's document stream. Two RHS shapes ship; nothing else is accepted:

- **Narrow** (`$$ = $$.filter(<lambda>)`) lowers to a single `$match` stage. Functionally identical to writing the predicate as a bare statement (`p;` form) — the explicit shape exists for symmetry with the source-switch form below, so the two can be swapped without changing the surrounding pipeline.
- **Source switch** (`$$ = $$$.<coll>.filter(<lambda>)`) lowers to `[{ $limit: 0 }, { $unionWith: { coll, pipeline: [{ $match: <translated> }] } }]`. The `$limit: 0` drops the current stream; the `$unionWith` brings in filtered docs from the foreign collection. After this stage the pipeline operates on `<coll>` filtered by the predicate, but the driver call (`db.<original>.aggregate(...)`) keeps its original collection — useful when you start a query on one collection and decide to pivot.

Cross-DB (`$$ = $$$$.<db>.<coll>.filter(...)`) uses the Atlas Data Federation `from: { db, coll }` shape, same as the lookup-translation does for cross-DB joins.

**Predicate translation.** Both shapes share `lowerStreamFilterPredicate` in [`src/pipeline.ts`](../src/pipeline.ts): expression bodies run through `translateMatchBody` (index-friendly query syntax for the translatable half, `$expr` for the residual); block bodies pass through `lowerBlock`. The lambda param is the document being matched — `param.x` rewrites to a bare `FieldRef("x")` via `extractLetsFromExpr`; `$.<field>` references are rejected with a "use the lambda parameter" hint. Same convention as the facet form — a second spelling for the current doc would only invite drift.

**Let-scope rules.** The narrow form preserves the outer pipeline's `let` scope (the predicate's `$match` is a top-level stage, not a sub-pipeline; outer lets resolve through `ctx.pipelineLets`). The source-switch form clears the let scope via `clearCtxLets(ctx, "$unionWith")` — the outer docs are gone after `$limit: 0`, so any prior `let` binding becomes unreadable. A subsequent reference produces the existing precise error: "`x` is a `let` binding and can't be read after `$unionWith` …".

**Parser changes.** Two small adjustments in [`src/parser.ts`](../src/parser.ts):
- `parseContextRef` previously required `$$` to be followed by `.` or `[` (the sanity guard against bare `$$`). Now the `CollectionRef` variant also accepts `=` so `$$ = X` parses; the other context prefixes (`$$$`, `$$$$`) keep the strict rule because `$$$ = X` / `$$$$ = X` are meaningless.
- `isFieldPathTarget` now accepts `CollectionRef` as an assignment target, alongside `FieldRef` and its `MemberAccess` chains.

**Rejections.** Anything outside the two supported RHS shapes errors with an actionable message: `$$ = []` (empty stream), `$$ = <ternary>` (conditional branching), `$$ = $$$.<coll>.find(...)` (single-doc result, not a stream), `$$ = $$.map(...)` / `$$ = $$.<other>(...)` (wrong method), bare `$$ = $$$.<coll>` (missing `.filter`), `$$ += …` / `$$++` (compound assignment, not a scalar). Each names the supported forms and, where applicable, redirects to `$ = $$$.<coll>.find(...)` for the single-doc case.

**Out of scope.** `$$ = []`, top-level ternaries, and `$$.find(<predicate>)` (self-lookup) all error with "not yet supported" messages. The genuinely hard piece — passing outer `let` bindings into a `$unionWith` sub-pipeline — is deferred; the source-switch form is therefore best paired with `$$$.<other>.find(...)` for the lookup-style "fetch a scalar first" pattern rather than a `let` on the current source.

Spec: [docs/specs/replace-stream-stage.md](specs/replace-stream-stage.md). User-facing reference: [docs/LANGUAGE.md](LANGUAGE.md#replace-stream).

---

## 2026-05-27 — `$$$.<coll> = …` / `$$$$.<db>.<coll> = …` → `$out` sugar

Writing the current pipeline to a destination collection used to require the explicit stage call: `$out("warehouse_orders")` or `$out({ db: "dw", coll: "archive" })`. The new sugar moves the destination to the **left** of `=`, where the JS-equivalent mental model puts it, and lets users compose an inline filter on the right:

```
$$$.warehouse_orders = $$;                                    // → [{ $out: "warehouse_orders" }]
$$$$.dw.archive      = $$.filter(u => !u.active);             // → [{ $match: ... }, { $out: { db: "dw", coll: "archive" } }]
$$$["my-coll.v2"]    = $$;                                    // → [{ $out: "my-coll.v2" }] (bracket — required for non-identifier names)
```

Detection lives in [`src/out-translation.ts`](../src/out-translation.ts) — a new sibling to `lookup-translation.ts`, `union-translation.ts`, and `facet-translation.ts`. The LHS walker accepts one or two static (dot **or** string-literal-bracket) access steps off `DatabaseRef` / `ClusterRef`; computed brackets are rejected outright (the destination must be statically readable). Segment-count diagnostics throw with precise hints pointing at the correct shape — `$$$.<a>.<b> = …` suggests `$$$$.<db>.<coll>`; `$$$$.<x> = …` suggests adding the collection segment. The RHS chain walker supports bare `$$` (no extra stages) and `$$.filter(<predicate>)` (one `$match` before the `$out`); the shape is structured so adding `.sort`, `.slice`, `.map`, etc. is one branch per method — explicitly deferred so each method's semantics can be designed deliberately. The unsupported-method error names the equivalent stage call as a workaround.

**Last-stage enforcement.** `$out` writes downstream, so nothing may follow it in a pipeline. A new `sawOut` / `outPos` pair is threaded through both `generatePipeline` and `generateImplicitPipeline`, and `lowerUpdateFilterWithLookups` now returns `{ stages, ctx, sawOut, outPos }` so the outer loop knows when to throw. A subsequent statement (or a second `$$$.<coll> = …`) hits `makeAfterOutError` with the offending later statement's `.pos`.

**Parser changes.** `validateUpdateTarget` gained a new `isOutTarget` branch — chains of `MemberAccess`/`IndexAccess` rooted at `DatabaseRef`/`ClusterRef` are now valid assignment LHS shapes. `parseContextRef` was relaxed for `CollectionRef` only: bare `$$` is allowed at parse time so `$$$.coll = $$` parses; the typo case `$$foo` (no separator, Ident next) still gets the parse-time hint. `$$$` / `$$$$` keep the strict pre-check — they have no bare meaning anywhere.

**Mode gates.** `$out` joins lookup and union as Pipeline-only sugar. `jsmql.filter()` and `jsmql.expr()` pre-reject with a precise "use Pipeline mode" hint via the new `containsOutAssign` walker; `jsmql.update()` falls through to the existing whitelist error (`$out` isn't in MongoDB's update-pipeline whitelist). `jsmql("$$$.x = $$")` (no `;`, parses as `UpdateFilter`) and `jsmql.pipeline("$$$.x = $$")` reroute through the lookup-aware pipeline lowerer the same way lookups already do — the bare `generateUpdateFilter` path doesn't know about `$out`.

**Convention.** This DEVLOG entry is also where the cross-cutting rule "**all root-replacing sugar in jsmql starts with `$ =`**" lands explicitly. `$replaceWith` and the `$facet` variant use `$ = …` because the LHS *is* the document being replaced. `$out` doesn't replace root — it writes elsewhere — so the LHS bears the destination instead. The asymmetry is visible to readers at a glance: `$out` uses `$$$.<coll> = …`, `$lookup` uses `$$$.<coll>.find(…)`, `$unionWith` uses `$$.push(…)`. Documented in [`docs/specs/replace-root-stage.md`](specs/replace-root-stage.md#convention-all-root-replacing-sugar-starts-with--), [`docs/LANGUAGE.md`](LANGUAGE.md#replace-root-via--expr) (one-line callout above the replace-root section), and the root [`CLAUDE.md`](../CLAUDE.md) ("Things the user did not explicitly ask for but matter").

Spec: [docs/specs/out-stage.md](specs/out-stage.md). User-facing reference: [docs/LANGUAGE.md → `$out`](LANGUAGE.md#out-write-the-pipeline-to-a-collection). Realistic example: [test/realistic.test.ts → "archive inactive users to a warehouse via $out"](../test/realistic.test.ts).

---

## 2026-05-26 — `$ = { k: $$.filter(p), … }` → `$facet`

A second variant of the `$ = <expr>` surface: when every value of the object-literal RHS is a `$$.filter(<lambda>)` call, the same construct lowers to a single `$facet` stage with each entry as a named sub-pipeline. The shape pulled in three things:

- **Detection in [`src/facet-translation.ts`](../src/facet-translation.ts).** `detectFacetShape(value)` returns null when the RHS isn't an object literal, or when no entry is `$$.filter(...)`. When at least one entry is, the function enters strict-shape mode: every entry must be `$$.filter(<lambda>)`, and mixed shapes / spreads / computed keys throw precise errors naming the offending entry. Otherwise the user would fall through to `$replaceWith`, where the inner `$$.filter` would surface a confusing "$$ is statement-only" error from the CollectionRef codegen.
- **Lambda predicate translation.** Each `$$.filter(<lambda>)` body becomes the facet's sub-pipeline. Expression bodies run through `translateMatchBody` (same engine `$match` uses, index-friendly query syntax for the translatable half); block bodies pass through `lowerBlock` (the same `SubPipelineLowerer` lookup and union use). Reuses `extractLetsFromExpr` / `extractLetsFromPipeline` from `lookup-translation` — but flips their letVars output into a rejection: any `$.<field>` reference inside the predicate is rejected with a "use the lambda parameter (e.g. `o.<field>`)" hint. Rationale: inside a facet sub-pipeline, the lambda param IS the current document, so `$.x` and `o.x` would mean the same thing — supporting both spellings would invite drift. (Contrast with `$lookup`, where `$.x` is the outer doc and gets auto-`let`-extracted.)
- **Parser tweak in [`src/parser.ts`](../src/parser.ts).** Block-body lambdas (`o => { stmts; }`) inside method calls were previously gated on the receiver being rooted at `$$$` / `$$$$` (lookup). The facet form needs them for `$$.filter(...)` too, so the gate also accepts `left.type === "CollectionRef"` for `.filter`. No new tokens or AST nodes.

**Parameter shape.** `$$.filter(<predicate>)` must take exactly one lambda parameter. Zero-arg (`() => …`) and multi-arg shapes are rejected. Naming the doc explicitly lets the `$.<field>` rejection message point at the right replacement (`o.<field>`, where `o` is whatever name the user picked).

**`$facet` joined `RESHAPE_CLEARING_STAGES`.** Pre-existing oversight — `$facet`'s output is `{ facetName: [docs], … }`, completely replacing the input doc. The interception in `pipeline.ts` calls `clearCtxLets(ctx, "$facet")` after emission so a subsequent let reference produces the standard "can't be read after `$facet`" error.

**Statement-position `$$.filter(...)`.** `validateUnionPushShape` (now misleadingly named, kept for stability) recognises a standalone `$$.filter(...)` and throws a targeted error pointing at `$match(<predicate>)` for stream-level filtering or the `$ = { ... }` shape for facets. The bare-`$$` CollectionRef codegen message was updated in parallel to mention both `.push` and `.filter`.

Spec: [docs/specs/replace-root-stage.md](specs/replace-root-stage.md) (facet variant section). User-facing reference: [docs/LANGUAGE.md](LANGUAGE.md#facet-via---key-filterp-).

---

## 2026-05-26 — `$ = <expr>` → `$replaceWith` (replace root)

Assigning to bare `$` replaces the whole document. The LHS *is* the document, the RHS is the new value — the JS shape exactly mirrors what the stage does. Three variants land:

- **Bare field-ref RHS.** `$ = $.profile;` → `[{ $replaceWith: "$profile" }]`. Lifts an embedded sub-doc to the top level.
- **Spread-merge.** `$ = { ...$, score: $.points * 1.1 };` → `[{ $replaceWith: { $mergeObjects: ["$$ROOT", { score: { $multiply: ["$points", 1.1] } }] } }]`. The bare `$` inside the spread refers to the current document — same role MQL's `$$ROOT` plays. Works with no spread-specific code because the object-spread codegen already calls `_generate(arg, ctx)` on each operand.
- **Direct lookup RHS.** `$ = $$$.users.find(u => u._id === $.userId);` lowers to `$lookup` (into an internal `__jsmql.__lookup<N>` slot) followed by `$replaceWith: { $first: "$<slot>" }`. We deliberately skip the `$set { slot: $first slot }` step that `lowerLookup` emits for assignment-target form — the slot is discarded by the replace anyway, so `$first` folds into the `$replaceWith` body and the pipeline is one stage shorter.

**`$replaceWith`, not `$replaceRoot`.** Both spellings produce identical runtime behaviour on MongoDB 4.2+. We pick the shorter one — `{ $replaceWith: "$profile" }` is 24 characters; `{ $replaceRoot: { newRoot: "$profile" } }` is 38 — consistent with the rest of the language ("less code = good DX"). The 4.0/4.1 line is already excluded by other features (`$function`, `let` on `$lookup`); no compatibility loss.

**Bare `$` is a new primary expression.** Lowered to `"$$ROOT"` in any expression context, not just on the LHS. `$mergeObjects($, { x: 1 })` works the same way. AST representation: `FieldRef { path: "" }` (reuses the existing node — no new variant). One added branch in `parsePrimary`'s `TokenType.Dollar` case: peek the next token; if it isn't an identifier, return the empty-path field ref instead of falling through to `parseOperatorCall`. Codegen treats empty path → `"$$ROOT"` in both the main `_generate` case and the `asFieldPath` helper used by `isPureRef` and the `MemberAccess` collapser.

**Compile-time RHS rejection.** Four shapes are caught up front, each with an actionable message that names the fix:
- Array literal (`$ = [1, 2]`) → "Use `.find(...)` for a single doc, or wrap: `$ = { items: [...] }`."
- Scalar literal (number / bigint / string / boolean / null / regex) → "the new root must be a document. Did you mean `$ = { value: ... }`?"
- Direct `.filter()` lookup (`$ = $$$.users.filter(pred)`) → "`.filter(...)` returns an array. Use `.find(...)` for a single match, or wrap…"
- Compound-op desugar (`$++`, `$ += 5`, `$ /= 2`, …) → "`$` is the whole document, not a scalar. Use `$ = { ...$, ...overrides }` to merge fields…". Detection is by AST-node referential identity (`el.value.left === el.target`) — the parser reuses the target node when synthesising the compound `BinaryExpr`, so distinct syntactic `$` occurrences in real user code don't false-positive.

`delete $` is rejected separately ("bare `$` is the whole document — use `$ = <newDoc>` to replace it"). All rejections live in the pipeline lowerer rather than `validateUpdateTarget`, so the same parser path serves both `$ = X` (good) and `$++` / `delete $` (bad), and each error message carries the precise `.pos` for the offending construct.

**Let scope clears across `$ = …`.** `$replaceWith` was already in `RESHAPE_CLEARING_STAGES`, but `lowerUpdateFilterWithLookups` (which handles `,`-chained update statements in `;`-form) returned only `stages` — so a `$ = …` inside a comma-chain didn't propagate the cleared `ctx` back to the outer loop. The helper now returns `{ stages, ctx }`; the caller in `generateImplicitPipeline` threads the post-replace ctx. A subsequent `let`-binding reference produces the existing precise "can't be read after `$replaceWith`" error.

Spec: [docs/specs/replace-root-stage.md](specs/replace-root-stage.md). User-facing reference: [docs/LANGUAGE.md](LANGUAGE.md#replace-root-via--expr).

---

## 2026-05-26 — `$$.push(...)` → `$unionWith` (collection union)

`$$` (current collection) lights up its first method: `.push(args...)` lowers to `$unionWith` stages. The receiver–verb pair was chosen because `Array.prototype.push` is the JS idiom for appending items to a stream — exactly the semantics of `$unionWith` (append documents from another source onto the current stream). The JS-faithful spread rule falls out naturally: arrays are spread (`.filter(pred)`, bare collection), scalars are not (`.find(pred)`, inline object). Both rules are enforced at compile time with targeted errors that suggest the fix.

**Why `$$.push` ships before `$$.find`/`$$.filter`.** `$unionWith` only names the *other* collection — the current one is implicit by where the stage sits. That means `$$.push(...)` needs no schema/driver binding for the receiver's name, unlike `$$.find/.filter` which would need to know what the current collection is called. The blocker that holds the rest of `$$` back doesn't apply here, so the feature lands without it.

**Inline-doc batching, source-order preservation.** Consecutive `{...}` arguments collapse into one `$unionWith` whose pipeline uses `$documents` — fewer stages, identical observable behaviour. The moment a non-inline argument arrives, the inline batch flushes and the new argument emits its own stage. Source order across the whole arg list is preserved — `$$.push({a:1}, ...$$$.coll, {b:1})` emits three stages in that order.

**`$unionWith` has no `let` slot — explicit error.** Predicates inside `$$.push(...$$$.coll.filter(pred))` may only reference foreign-doc fields. Local-doc references (`o.x === $.y`) are detected via the let-extraction algorithm shared with `$lookup` predicate translation; any non-empty letVars map throws a precise "move the local filter to `$match` before the push" error. The shared helpers `extractLetsFromExpr` / `extractLetsFromPipeline` from [`src/lookup-translation.ts`](../src/lookup-translation.ts) are now exported and reused by [`src/union-translation.ts`](../src/union-translation.ts).

**Index-friendly inner `$match`.** The predicate body (post let-extraction) is fed through `translateMatchBody` — the same engine `$match` uses at the top level — so the inner `$match` emits the index-friendly `{ field: value }` shape instead of a blanket `{ $expr: … }` wrap. Untranslatable residuals still ride in `$expr`, side-by-side with the translated half. This matters at runtime: the MongoDB query planner can use foreign-collection indexes on the translated portion.

**Cross-database via `$$$$`.** Spread / find against `$$$$.<db>.<coll>` works the same way and emits the Atlas Data Federation `from: { db, coll }` shape. Same caveat as cross-DB `$lookup` — community-server MongoDB rejects the object form at runtime; the lowering is identical regardless of deployment.

**Statement-only; auto-Pipeline-wrap.** `$$.push(...)` has no value and cannot appear on a RHS. A single top-level push expression (no `;`) auto-wraps as a one-statement Pipeline so `jsmql("$$.push(...$$$.archive)")` produces a Pipeline output without forcing the user to append a `;`. Mode gates in [`src/index.ts`](../src/index.ts) reject `$$.push(...)` in Filter / `jsmql.expr` / `jsmql.update` with API-specific messages — `$unionWith` isn't in the update-pipeline whitelist, so `jsmql.update()` calls out the whitelist explicitly. Top-level `$$.<any-method>(...)` (including misspellings like `$$.pop`) all route through Pipeline mode so the targeted "$$ only supports .push" hint surfaces from `validateUnionPushShape` instead of the generic CollectionRef error.

**Nested-push rejection mirrors nested-lookup.** A `$$.push(...)` inside another lookup's block-body, or inside any sub-pipeline (`$facet.*`, `$lookup.pipeline`, `$unionWith.pipeline`), would emit stages that target the *outer* collection but land inside the inner pipeline — semantically broken. Both paths reject with "hoist to a sibling stage in the outer pipeline".

**Server-version note.** Inline-doc pushes use the no-`coll` `$unionWith` shape that wraps `$documents` — requires MongoDB 6.0+. Spread-of-collection pushes work on every server that supports `$unionWith` (4.4+). The constraint is documented in [`docs/specs/union-stage.md`](specs/union-stage.md) and [`docs/LANGUAGE.md`](LANGUAGE.md).

**Deliberate design rejection.** `$$.push(scalar)` (a number, a string, a runtime field-ref) is rejected with "collections only hold documents". The footgun of an accidentally-pushed scalar — which JavaScript itself accepts — would translate into nonsensical MQL; we'd rather catch it.

See [`docs/specs/union-stage.md`](specs/union-stage.md) for the full lowering table, predicate translation rules, error catalog, and module-layout reference.

---

## 2026-05-26 — `$$$.<coll>.find / .filter(pred)` → `$lookup`

The `$$$` context-reference prefix lights up: `$$$.<coll>.find(pred)` and `$$$.<coll>.filter(pred)` now lower to MongoDB's `$lookup` stage, with chained terminal composition (`.length`, `.reduce(fn, init)`, member access on `.find` results), block-body sub-pipeline lambdas (`o => { $match(...); $sort(...); $limit(N); }`), and auto-`let` extraction for outer-doc references. Spec: [docs/specs/lookup-stage.md](specs/lookup-stage.md). User-facing reference: [docs/LANGUAGE.md → Cross-collection lookups](LANGUAGE.md#cross-collection-lookups-coll-find--filter).

**Why `$$$` (and not the reverted `this.`).** The earlier attempt used `this.<coll>.find(pred)` ([reverted in commit `d49be79`](../docs/DEVLOG.md)) — semantically clean but `this` is parse-rejected outside class/method bodies, which breaks the strict-JS-subset rule. `$$$` is a reserved jsmql prefix that parses anywhere as a token, never collides with the JS host language, and ties into the uniform doc-context vocabulary (`$.`, `$$`, `$$$`, `$$$$`) reserved in commit `6053112`.

**Why `$set + $first` (and not `$unwind preserveNullAndEmptyArrays`) for `.find()`.** JS's `Array.prototype.find` returns *one* element or `undefined` — and never multiplies rows. `$unwind preserveNullAndEmptyArrays` does the right thing on zero-match and single-match foreign docs but **fans the outer row out** on multi-match (one outer row per matching foreign doc). That breaks the JS contract AND breaks any chained read like `.find(p).name` (the chained read would multiply unpredictably). `$set { <as>: { $first: "$<as>" } }` keeps the row count stable in every case: zero match → field is null; single match → field is the doc; multi-match → field is the first doc. One extra in-place stage; the user can write the block-body form with `$sort + $limit(1)` if deterministic single-doc selection matters.

**Full chained composition over a dedicated assignment-only surface.** Users predictably want `let n = $$$.orders.filter(p).length` and `let s = $$$.tx.filter(p).reduce(fn, init)` to "just work" — the natural JS shape for "count matching docs" / "sum a field across matching docs". Rather than ship an assignment-only v1 and require users to spell out the materialise-and-read pattern by hand, jsmql interns the lookup into an internal `__jsmql.__lookup<N>` slot, emits the chained transform as a follow-up `$set`, and substitutes a `FieldRef(slot)` into the parent expression. Internal slots ride the same `__jsmql` cleanup pipeline-scoped `let` uses — no per-temp `$unset` stages emitted. A chained terminal without its own predicate (bare `$$$.coll.reduce(...)`) is rejected because it would be a Cartesian product over the foreign collection.

**MongoDB cross-check on the `UpdateFilter` rejection.** MongoDB explicitly forbids `$lookup` in the aggregation-pipeline update form — all three reference pages (`db.collection.updateOne`, `updateMany`, the dedicated tutorial) document the whitelist as exactly `$addFields`/`$set`, `$project`/`$unset`, `$replaceRoot`/`$replaceWith`. The existing `UPDATE_PIPELINE_STAGES` at [src/index.ts:761](../src/index.ts) matches the documented list verbatim, so `jsmql.update()` already rejected lookups via the generic whitelist message; this change adds a pre-codegen gate so the rejection message names the right entry point (`jsmql.pipeline()` or `jsmql()` in Pipeline mode) instead of just naming the offending stage.

**Block-body lambdas — parser surface.** Lambda bodies were expression-only before this change. The lookup-callback position (a `.find/.filter` whose receiver chain walks back to `DatabaseRef`) now opts into a block body: `parsePostfix` checks for the database-rooted receiver, threads `allowBlockBody = true` through `parseMethodCallArgs` → `parseCallArg` → `parseArgOrLambda` → the lambda parsers, and the lambda parsers dispatch to a new `parseLambdaBlockBody()` when they see `=> {`. The block reuses the existing top-level block-body machinery (the same `;`-separated statement collector top-level `($) => { ... }` arrows use). Outside lookup-callback positions, `=> {` keeps its current meaning (object literal via paren-wrap, ParseError otherwise) — no general extension of block lambdas. AST: `Lambda` gains an optional `block?: Pipeline` sibling to `body?: Expr`; existing consumers (array methods, IIFE, `$let`, `Object.groupBy`, `Array.from`) reject block-form with targeted errors.

**Nested lookups deferred to v2.** A `$$$.coll2.find/filter(...)` inside another lookup's predicate or block body is rejected by `rejectNestedLookup` in [src/lookup-translation.ts](../src/lookup-translation.ts) with a clear "hoist to sibling stage" message. The implementation considerations (auto-`let` extraction across nested binding scopes — outer-doc `$.x` AND outer-foreign-doc `u.x`) are non-trivial; the rejection lets us ship the core surface first and re-enter nested support cleanly.

---

## 2026-05-26 — `$$$$.<db>.<coll>.find / .filter(pred)` → cross-database `$lookup`

The `$$$$` (current-cluster) prefix lights up the same lookup surface as `$$$`, with the receiver naming the *database* as well: `$$$$.<db>.<coll>.find(pred)` and `$$$$.<db>.<coll>.filter(pred)` lower to MongoDB's `$lookup` stage using the object form of `from`: `{ db: "<db>", coll: "<coll>" }`. All four bracket combinations (`.db.coll`, `["db"]["coll"]`, `.db["coll"]`, `["db"].coll`) are accepted. Block-body lambdas, chained `.length` / `.reduce`, member access on `.find` results, and intermixing with same-DB `$$$.<coll>` lookups in one pipeline all work identically to the `$$$` surface. Spec: [docs/specs/lookup-stage.md → Cluster-rooted ($$$$) cross-database joins](specs/lookup-stage.md). User-facing reference: [docs/LANGUAGE.md → Cross-database lookups](LANGUAGE.md#cross-database-lookups-dbcollfind--filter).

**Deployment requirement.** MongoDB's `$lookup.from: { db, coll }` is the [MongoDB Atlas Data Federation](https://www.mongodb.com/docs/atlas/data-federation/query/sql/aggregation-pipeline-stages/) form. The community MongoDB server validates `from` as a string and rejects the object shape at runtime. jsmql emits the object form regardless — the lowering is deployment-agnostic, and a user targeting community Mongo will see the server's "`from` must be a string" error. The LANGUAGE.md and DEVLOG entries call this requirement out so a user picking up `$$$$` knows what they're committing to. We chose not to gate at compile time because (a) jsmql has no awareness of the user's runtime deployment, and (b) the surface is genuinely useful on Atlas Data Federation, which is a major MongoDB deployment.

**Implementation reuse.** Everything below `detectLookupCall` is shared with the `$$$` path. `LookupCall` gains an optional `db?: string` field; `extractLookupTarget` walks one or two `StaticAccess` steps (one for `$$$`, two for `$$$$`); `lowerLookup` emits `from: "<coll>"` or `from: { db, coll }` based on whether `db` is set. `validateLookupShape` threads the right spelling (`'$$$.<coll>'` vs `'$$$$.<db>.<coll>'`) into error messages via a small `classifyLookupReceiver` walker. The parser's lookup-receiver helper (formerly `isDatabaseRefRooted`, now `isLookupReceiverRooted`) accepts both `DatabaseRef` and `ClusterRef` leaves so block-body lambdas opt in for both surfaces. The `ClusterRef` codegen case now mirrors `DatabaseRef`'s actionable bare-reference error.

**Static names only.** `$$$$[someVar].coll` (or `$$$$.db[someVar]`) with a non-static index doesn't extract — `$lookup.from` is itself a compile-time constant in MongoDB. Such expressions hit the bare-reference error path with the same message a bare `$$$$` reference would produce. Documented in the LANGUAGE.md "Dynamic db / coll names" caveat.

---

## 2026-05-26 — `jsmql.compile` parameter bindings resolve in lookup bracket-index positions

`$$$[collVar].find(pred)`, `$$$$[dbVar].coll.find(pred)`, `$$$$.db[collVar].find(pred)`, and `$$$$[dbVar][collVar].find(pred)` — the bracket-index positions of lookup receivers — now resolve `jsmql.compile` parameter bindings to strings at compile time and inline the value into `$lookup.from`. This honours the existing promise in [`docs/specs/context-references.md`](specs/context-references.md): *"the inner expression can be any value (a `jsmql.compile` parameter, a string literal, a deeper expression)."* The promise was previously broken — bound bracket indices were rejected as bare references — and a test codified the wrong behaviour.

**Three accepted index kinds.** `staticAccess` in [`src/lookup-translation.ts`](../src/lookup-translation.ts) now recognises: `MemberAccess` (dotted), `IndexAccess` with `StringLiteral` (string-bracket), and `IndexAccess` with `ParamRef` whose name resolves in `ctx.bindings` to a string. The third kind is the new compile-time-binding case; the `jsmql.compile` parameter-binding machinery has already validated the value as a JSON-safe compile-time constant, so reading it here matches the rule MongoDB itself enforces on `$lookup.from` (a plan-time string). Non-string bindings (a number, an array) throw a precise "parameter binding must be a string" error at the `IndexAccess.index` position; runtime field-refs (`$.tenantDb`) fail to classify entirely and reach the bare-reference codegen error.

**Threading `ctx` everywhere it's needed.** `detectLookupCall`, `extractLookupTarget`, and `staticAccess` now take `ctx`. `containsLookupCall` gains an optional `ctx` parameter (default `EMPTY_CTX`) so mode-gates without a meaningful context still work, and callers with one (`lowerWithCtx`, `rejectNestedLookup`) pass it explicitly so bound-bracket lookups detect correctly. The nested-lookup guard now correctly rejects nested-bound lookups instead of silently letting them slip through.

**`UpdateFilter` reroute.** A single-stmt arrow body like `jsmql.compile(({ coll }, $) => ($.x = $$$[coll].find(...)))` parses as an `UpdateFilter` (not a `Pipeline`), and the bare `generateUpdateFilter` lowering doesn't know about lookups. `lowerWithCtx` now checks `containsLookupCall(ast, ctx)` and reroutes the lookup-bearing `UpdateFilter` through a synthetic single-stmt Pipeline → `generateImplicitPipeline` → the lookup-aware pipeline integration. The output shape is identical to the previous explicit array-wrap path for non-lookup `UpdateFilter`s (which `lowerWithCtx` already wraps to `[result]`), so no backward-compat concerns.

---

## 2026-05-26 — Context-reference prefixes: `$$`, `$$$`, `$$$$` (syntax-only)

jsmql gains three new doc-context prefixes parallel to the existing `$.`:

| Prefix | Scope            | Example                  |
| ------ | ---------------- | ------------------------ |
| `$.`   | Current document | `$.age` (existing)       |
| `$$`   | Current collection | `$$.find(…)`           |
| `$$$`  | Current database | `$$$.myColl.find(…)`     |
| `$$$$` | Current cluster  | `$$$$.myDb.myColl.find(…)` |

Both dot-identifier (`$$$.myColl`) and bracket-expression (`$$$[collVar]`) postfix forms work — bracket access uses standard JS semantics, so the inner slot can be any expression. The four dot/bracket combinations at depth 4 (`$$$$.db.coll`, `$$$$[db][coll]`, `$$$$[db].coll`, `$$$$.db[coll]`) all parse the same way and reach the same leaf.

**Scope of this change: syntax only.** Lexer emits three new bare prefix tokens (`DoubleDollar`, `TripleDollar`, `QuadDollar`); the parser builds bare marker AST nodes (`CollectionRef`, `DatabaseRef`, `ClusterRef`); the existing `MemberAccess` / `IndexAccess` postfix machinery wraps them. Codegen currently throws a clear `CodegenError` for each: *"'$$$' (current-database reference) is reserved syntax — not yet lowered to MQL. Coming in a future release."* This intentional stage-gating means future sessions only need to add a codegen branch per level — parser / lexer / AST stay stable. The full design (and what each future codegen branch will do) lives in [docs/specs/context-references.md](specs/context-references.md).

**Why bare prefix tokens (not "prefix-with-dot" like the existing `DollarDot`).** The existing `$.` bakes the dot into a single token, forcing the parser to consume an identifier next. That's a barrier to bracket access — `$.[x]` would be a special case. The new prefixes don't bake the dot in, so the standard `Dot` and `LBracket` tokens follow, and the standard postfix loop handles both `.name` and `[expr]` uniformly. Accepts a small asymmetry with `$.` in exchange for a uniform bracket-form and zero parser churn at depths 2–4.

**Sanity-guard at parse time.** Bare `$$`, `$$foo`, `$$$$,`, etc. throw an actionable `ParseError`: *"Expected '.<name>' or '[<expr>]' after '$$' at position N"* — matching the spirit of `parseFieldRef`'s "expected field name after `$.`" check. Lexer caps at 4 dollars: 5+ throws `LexError` naming the supported levels.

**Motivation.** The reverted `this.<coll>.find/filter(predicate)` attempt at `$lookup` syntax (commit `d49be79`) didn't compose — it conflated method dispatch with cross-collection naming. The four-prefix system separates the "what scope" axis from the "what operation" axis, so future API can grow on each level independently (collection methods on `$$`, collection lookups on `$$$`, multi-DB on `$$$$`). The first level (`$.`) was the only doc-context prefix since the project started; this entry adds the other three.

Touched: [src/lexer.ts](../src/lexer.ts), [src/ast.ts](../src/ast.ts), [src/parser.ts](../src/parser.ts), [src/codegen.ts](../src/codegen.ts), [test/codegen.test.ts](../test/codegen.test.ts), [docs/specs/grammar.md](specs/grammar.md), [docs/LANGUAGE.md](LANGUAGE.md), [docs/CLAUDE.md](CLAUDE.md), and the new [docs/specs/context-references.md](specs/context-references.md).

---

## 2026-05-26 — GitHub Pages publishes only `playground.html`

Added a root `_config.yml` to constrain the GitHub Pages Jekyll build to the single artefact users actually consume — [`playground.html`](../playground.html). Previously the build had no config, so Jekyll defaulted to processing every Markdown file at the repo root and under `docs/` as a Liquid template. JS-syntax `{{ … }}` blocks inside [`docs/LANGUAGE.md`](LANGUAGE.md) and [`docs/DEVLOG.md`](DEVLOG.md) (e.g. `{{ startDate: new Date(...), unit: "day" }}`) tripped Liquid's variable-terminator regex and crashed `actions/jekyll-build-pages@v1` with a `Liquid::SyntaxError`, blocking the deploy.

The config excludes every directory and file pattern that isn't `playground.html` — Markdown, TypeScript sources, build output (`dist/`), tooling configs, `vendor/`, `node_modules/`, dotfiles — and keeps `include: [playground.html]` explicit so a future Jekyll default change can't silently drop it. The site surface is now exactly one file at `https://flash-oss.github.io/jsmql/playground.html`, which is what [README.md](../README.md) already links to.

This is a deploy-pipeline fix, not a language change; no source files were touched.

---

## 2026-05-24 — mongoose pinned at `"*"` in devDependencies

Follow-up to the mongoose plugin entry below. The type-only validation file in [test/types/mongoose-augmentation.ts](../test/types/mongoose-augmentation.ts) needs a real mongoose import for the augmentation merge to actually mean anything; the first cut relied on a local `/tmp/mongoose` symlink, which made the smoke case work on the author's machine but not in CI or on a contributor's fresh clone. mongoose is now a real `devDependency` so `npm install` brings it in.

The version range is deliberately `"*"` rather than `"^9.6.2"` or any other pin. Rationale: the validation file exists to catch our `declare module "mongoose"` augmentation drifting against mongoose's evolving generics. Pinning it means we'd only learn about drift when someone manually bumps the dep — defeating the point. The unpinned range turns every `npm install` into a fresh probe: if mongoose ships a Model-generic change that breaks the augmentation, the type-validation smoke fails on the next CI run, and we fix it there rather than at user-report time. Runtime behaviour of `src/mongoose.ts` itself doesn't depend on a specific mongoose version (it duck-types whatever it gets), so we're not signing up for runtime risk by floating the dep.

---

## 2026-05-24 — Mongoose plugin: `@koresar/jsmql/mongoose`

Hand-rolling `jsmql.filter()` / `jsmql.update()` / `jsmql.pipeline()` at every `User.find(…)` / `User.updateMany(…)` / `User.aggregate(…)` call site gets noisy fast in a real mongoose codebase. The new `@koresar/jsmql/mongoose` subpath is a one-shot registration that monkey-patches `mongoose.Model` so the standard query statics accept jsmql source directly:

```js
const mongoose = require("mongoose");
require("@koresar/jsmql/mongoose")(mongoose);

User.find("$.age > 18");                       // → Model.find({ age: { $gt: 18 } })
User.updateMany({}, ($) => $.score += 1);
User.aggregate(($) => { $match($.status === "active"); $sort({ score: -1 }); });
```

**Detection rule: string-or-function only.** A patched argument is treated as jsmql source iff it's a string or a function. Plain objects/arrays pass through to the original mongoose method unchanged, so every existing MQL-JSON call site keeps working untouched — there's no migration step, and library code that calls mongoose with plain documents is unaffected. Template-tag inputs (`jsmql\`…\``) lower at the user's call site to an object, so they take the pass-through path automatically without needing a separate code path in the plugin.

**Patched methods and slots.** 15 mongoose statics, mirroring the set exported from `mongoose/lib/model.js` in mongoose 9.x: `find`, `findOne`, `findOneAndDelete`, `findOneAndReplace`, `findOneAndUpdate`, `findByIdAndUpdate`, `countDocuments`, `distinct`, `deleteOne`, `deleteMany`, `updateOne`, `updateMany`, `replaceOne`, `exists`, `aggregate`. The filter slots route through `jsmql.filter`, the update slots through `jsmql.update`, and `aggregate`'s pipeline through `jsmql.pipeline` — the three strict-shape entries from earlier today. Wrong-shape source surfaces the strict-mode error at the patched call site instead of silently going wrong server-side. The per-method table lives in [docs/specs/mongoose-plugin.md](specs/mongoose-plugin.md).

**Implementation shape: one explicit wrapper per method, no lookup table.** Each patched method is a four-line block in [src/mongoose.ts](../src/mongoose.ts) that captures the original, redeclares with the same parameter names as `mongoose/lib/model.js`, conditionally lowers each jsmql-eligible slot, and delegates via `original.call(this, …)`. There is no `patchMethod` helper, no `FILTER_AT_0` array, no slot-table indirection. The trade-off: a tiny bit of code repetition for stack traces that point at the named method, signatures that sit next to the code, and a grep-able list of what's actually patched. First attempt at this plugin used a generic `slotsByName` Map + a `patchMethod` factory; that was rolled back in favour of the per-method shape after a review on debuggability.

**Deliberately not patched.** `findOneAndReplace` / `replaceOne` take a *replacement document* (not an update spec) at slot 1, so the slot stays untouched — a jsmql expression there would silently land as a literal object. `findById`, `findByIdAndDelete` (id-only methods) have no jsmql-eligible slot. The `Query.prototype.*` builder methods (`.where()`, `.gt()`, `.sort()`, …) are out of scope: the plugin is a Model-static layer; the Query builder is a separate composition surface that the user reaches *after* a static call.

**Idempotent.** A second `jsmqlMongoose(mongoose)` on the same `Model` is a no-op — the first call sets `Model.__jsmqlPatched = true` and the next call short-circuits. One property check, no `Symbol.for` indirection; matches the minimal-implementation spirit. Without this, a second registration would double-wrap every static and the second wrap would feed `jsmql.filter()` an already-lowered Filter document — quietly weird, no obvious place to look.

**CJS interop.** `require("@koresar/jsmql/mongoose")(mongoose)` is the primary documented call shape. esbuild's CJS bundling of an ES-module default export lands the function at `module.exports.default`, so [scripts/build-cjs.mjs](../scripts/build-cjs.mjs) appends a short footer to `dist/cjs/mongoose.cjs` that promotes the default export to `module.exports = fn` (while preserving `.default = fn` so synthetic-default ESM imports keep working). One source file in `src/`, both call shapes work, no duplicate runtime. [test/smoke.test.ts](../test/smoke.test.ts) gained an ESM and a CJS case against the built artifact so this fixup can't silently regress.

**Subclass propagation.** Subclasses compiled by `mongoose.model(name, schema)` inherit the patched statics through the normal JavaScript class chain. Each wrapper uses `original.call(this, …)` so the subclass receiver reaches the underlying mongoose method untouched — covered by an explicit `class User extends Model {}` case in the mock-based test file.

**TypeScript module augmentation.** The bottom of [src/mongoose.ts](../src/mongoose.ts) carries a `declare module "mongoose" { interface Model<…> { … } }` block that adds JSMQL-shaped overloads (parameter type `string | JsmqlFn`) to every patched static. So `User.find("$.age > 18")`, `User.aggregate(($) => { … })`, and `User.updateMany({}, "$.score += 1")` all type-check after `import "@koresar/jsmql/mongoose"` — no cast required. Return types of the JSMQL overloads are `any`: re-declaring mongoose's schema-aware `QueryWithHelpers<…>` / `Aggregate<…>` machinery from inside the augmentation would be brittle and would drift on every mongoose minor release. Users who need the precise return type either pass a typed value (matching mongoose's own overloads) or cast at the call site. The augmentation merges into mongoose's existing interface, so it activates only when mongoose is on the resolution path; projects without mongoose installed see no spurious errors.

**Testing.** [test/mongoose.test.ts](../test/mongoose.test.ts) drives a hand-rolled mongoose-shaped mock — recording each downstream call and asserting the transformed arguments — across every patched method, both detection paths, the wrong-shape error pass-through, and the subclass-propagation contract. No mongoose devDep needed for runtime tests; the plugin treats its argument as a duck-typed shape with `Model.<method>` callables. For TYPE validation, [test/types/mongoose-augmentation.ts](../test/types/mongoose-augmentation.ts) imports the real mongoose and exercises every augmented overload (JSMQL string, JSMQL arrow, plain MQL JSON pass-through) against a real `mongoose.model<User>(...)`; the smoke suite spawns `tsc --noEmit` against it when mongoose resolves from `node_modules`, otherwise skips so a fresh clone without mongoose installed still passes `npm test`.

---

## 2026-05-24 — Strict-shape entry points: `jsmql.filter`, `jsmql.pipeline`, `jsmql.update`

`jsmql()` is polymorphic — it dispatches Filter or Pipeline from the input's top-level shape, which is exactly what you want when the same source string is allowed to produce either. But at most real call sites the shape is fixed by the driver method being called (`find()` wants a Filter, `aggregate()` wants a Pipeline, `updateOne()` wants the pipeline form of an update). When the shape is fixed, a silent mis-dispatch is a footgun — typing `$.x = 1` where you meant a filter would compile fine and then wipe data. Three new entry points let the call site declare its expected shape and turn that footgun into a compile-time error:

- `jsmql.filter(input)` — returns a Filter document; throws on `;`-Pipeline, update-op chain, array-literal Pipeline, or top-level stage call (`$match(...)` etc. — and for `$match` specifically the error nudges users to drop the wrapper).
- `jsmql.pipeline(input)` — returns a stage array; throws on a bare expression that would lower to a Filter, with the error suggesting `jsmql.filter()` or wrapping in `$match(...)`.
- `jsmql.update(input)` — returns a stage array; same rejection as `jsmql.pipeline()` plus an extra check that every stage is in MongoDB's [aggregation-pipeline update whitelist](https://www.mongodb.com/docs/manual/reference/method/db.collection.updateOne/#update-with-aggregation-pipeline) (`$addFields`, `$project`, `$replaceRoot`, `$replaceWith`, `$set`, `$unset`). A misplaced `$match` is caught at compile time with the offending stage name and position, instead of at the server with a generic error.

**Naming: `update`, not `updateFilter`.** The slot this lowers into is typed `UpdateFilter<TSchema>` by the Node MongoDB driver, and our first draft mirrored that name on the public API. The problem: at the `updateOne(filter, update)` call site the *first* argument is the query "filter" — and developers who scan the autocomplete list see `jsmql.filter()` and `jsmql.updateFilter()` and reach for the one with the word "filter" in it, expecting it to fill that first slot. Wrong by exactly the worst possible amount: it compiles, the driver accepts the document, and the update writes to a different shape than the user intended. So the function is `jsmql.update()` instead — the AST node type stays `UpdateFilter` (matching the driver typings and the existing parser machinery), but the user-facing call site uses the unambiguous verb. The DEVLOG entry "Output dispatch terminology … `UpdateFilter`" below settled the AST/type naming; this entry refines only the *function* name layer on top.

Implementation in [src/index.ts](../src/index.ts) reuses the existing dispatcher: each new entry point is a thin wrapper over `dispatchInput` with its own `lower` callback (`lowerFilterStrict`, `lowerPipelineStrict`, `lowerUpdateStrict`). The pipeline and update lowerings share a single helper (`lowerToPipelineStages`) that routes every Pipeline-shape branch to the existing lowerer and throws on bare expressions — the `apiName` parameter is interpolated into the message so the error names the entry point the user actually called. `lowerUpdateStrict` adds one extra pass over the lowered stage array against the `UPDATE_PIPELINE_STAGES` whitelist. The polymorphic `jsmql()` is unchanged — the strict entry points are additive, not a replacement.

The output type is locked down in the signatures: `filter()` returns `object`, `pipeline()` and `update()` return `object[]`. The cast lives in the dispatch wrapper (`as object` / `as object[]`), since `dispatchInput` itself stays parametric on the polymorphic `JsmqlOutput` union — keeping the shared helper from leaking specifics about which caller wanted what.

Coverage in [test/strict-api.test.ts](../test/strict-api.test.ts) (29 cases): happy paths for each entry point across all three call shapes (string, arrow, template tag), plus every rejection path with a regex against the actionable-error message. The reject-`$match` test pins the alphabetically-sorted allowed-stage list so any future addition to the whitelist will surface in CI.

---

## 2026-05-23 — `new Date(<static-args>)` folds to a `Date` instance in Filter-mode query position

`jsmql('$.method === "x" && $.createdAt >= new Date("2026-01-01")')` previously emitted

```json
{ "method": "x", "$expr": { "$gte": ["$createdAt", { "$toDate": "2026-01-01" }] } }
```

— pushing `createdAt` into `$expr` and disabling the index on that field for MongoDB versions that don't optimise `$expr` index usage (and reducing planner confidence on the versions that do). Reported case had millions of documents on a collection where `createdAt` is the primary read index.

The fix is in [src/match-translation.ts](../src/match-translation.ts): `anyEqualityLiteral` and `anyOrderedLiteral` now accept `NewDate` (and `new Date(Date.UTC(...))`) when every argument is itself a compile-time literal — the new `evaluateStaticDate` helper folds the constructor at translate time and returns a real JS `Date` instance, which the translator places directly in the query-doc value slot. Output for the example above becomes:

```json
{ "method": "x", "createdAt": { "$gte": <Date 2026-01-01> } }
```

— index-friendly, and the shape a user would hand-write. Zero-arg `new Date()` (codegens to `{ $toDate: "$$NOW" }`, must evaluate at query time), `new Date($.field)`, and any constructor that produces `Invalid Date` all fall through to `$expr` unchanged.

**Why we couldn't just emit `{ $gte: { $toDate: "..." } }` in query-doc position.** That was the user's first proposal. MongoDB's query language **does not evaluate aggregation expressions in operator value slots** — `{ $toDate: "..." }` would be treated as a literal subdocument with a key called `"$toDate"`, never matching any `createdAt` value. The aggregation form only evaluates inside `$expr`. The fold to a JS `Date` instance is the only shape that's both index-friendly AND semantically equivalent to the `$expr` version. This is now spelled out in [docs/specs/filter-mode.md](specs/filter-mode.md) and [docs/specs/match-query-translation.md](specs/match-query-translation.md).

Same change extends `paramRefAsLiteral` to accept `Date`, `RegExp` (equality only), `Uint8Array`/`Buffer` (equality only), and duck-typed `ObjectId` (equality only) as query-doc-compatible binding values. So `jsmql.compile(($) => $.createdAt >= params.cutoff)({ cutoff: new Date("2026-01-01") })` now produces field-form for the same reason inline `new Date(...)` does — the value is a query-doc-compatible BSON instance, regardless of whether the source is a literal or a bound parameter. No driver dependency added; ObjectId is recognised via `_bsontype === "ObjectID"` / `"ObjectId"` duck typing.

Tests: nine new cases in [test/match-translation.test.ts](../test/match-translation.test.ts) covering positive folds (`>=`, `>`, `<`, `<=`, `===`, `!==`, order-flipped, parts-form, `Date.UTC`-wrapped), negative folds (zero-arg, field-ref arg, Invalid Date), and merge-into-`$and` for same-key bounds. Two new cases in [test/codegen.test.ts](../test/codegen.test.ts) covering `Date` and `RegExp` parameter bindings. `jsmql.expr('new Date("..."))` codegen is unchanged (still `{ $toDate: "..." }`) — the fold is filter-mode-only.

---

## 2026-05-23 — Template-tag interpolation routes BSON instances through a side channel

Follow-up to the same-day Date-folding entry below. The template-tag form silently mangled non-JSON-serialisable values:

```js
jsmql`$.createdAt >= ${new Date("2026-01-01")}`
// before: { createdAt: { $gte: "2026-01-01T00:00:00.000Z" } }   // ← string, not a Date
// after:  { createdAt: { $gte: <Date 2026-01-01> } }            // ← real Date
```

Before this change, `JSON.stringify(new Date(...))` turned the Date into an ISO string, which BSON compares as a string — the query silently never matches any actual Date field. Same problem for `RegExp` (becomes `"{}"`), `Uint8Array` (becomes `{}`), and ObjectId (becomes `{}` since BSON tags it with a `_bsontype` rather than enumerable fields).

Fix in [src/index.ts](../src/index.ts) `stringifyInterpolation`: when the interpolated value passes `isOpaqueBsonValue` (exported from [src/codegen.ts](../src/codegen.ts) — `instanceof Date | RegExp | Uint8Array`, or duck-typed ObjectId via `_bsontype === "ObjectID" | "ObjectId"`), the dispatcher synthesises a binding name `__jsmql_interp_<slot>`, puts the original instance into a `bindings` map, and concatenates the name into the parsed source. The lower path then resolves the `ParamRef` through the existing function-form binding machinery — `safeBoundValue` returns the BSON instance unchanged (the second part of this fix; see below). The MQL output carries the JS instance verbatim, which is what the Node MongoDB driver consumes in-situ.

The dispatcher's `lower` callback signature widened from `(program) => output` to `(program, ctx) => output`, replacing the thin `lower` / `lowerExpr` wrappers. The string and arrow paths pass `EMPTY_CTX`; only the template-tag path constructs a non-empty binding ctx. Three other call shapes (string, arrow, `jsmql.compile`) are unchanged in behaviour.

**Pre-existing bug fixed in tandem.** `safeBoundValue` in [src/codegen.ts](../src/codegen.ts) walked any non-string non-array object value via `Object.entries`, which silently turned a `Date` / `RegExp` / `Uint8Array` / ObjectId binding into `{}`. So even before the template-tag work, `jsmql.compile(({ at }) => $set({ lastSeenAt: at }))({ at: new Date(...) })` produced `[{ $set: { lastSeenAt: {} } }]`. `safeBoundValue` now short-circuits on `isOpaqueBsonValue` and returns the instance untouched. Same `paramRefAsLiteral` machinery in [src/match-translation.ts](../src/match-translation.ts) already accepted these instances, so the previously-correct query-doc-position behaviour is unchanged.

**Naming.** The synthesised binding uses the `__jsmql_` prefix the project already reserves for its internal namespace (see the `__jsmql` pipeline let-bindings field in [docs/specs/let-bindings.md](specs/let-bindings.md)). Per-slot, per-instance suffixes (`__jsmql_interp_1_1`, `__jsmql_interp_1_2`, …) make the binding name visible in any debug output the user inspects; the chosen prefix means a deliberate user identifier of the same shape would override the binding (consistent with `jsmql.compile`'s own resolution order), but in practice such a collision is vanishingly unlikely.

**Nested instances work too.** Opaque BSON values buried inside an interpolated object or array are detected by a recursive walker (`containsOpaqueBsonAnywhere`) and substituted by `substituteOpaqueValues`. The walker replaces each instance with a marker string (wrapped in U+E000 Private-Use code points so it can't conflict with any natural user data), JSON-stringifies the rewritten tree, and post-replaces the markers with the bare binding identifiers. The surrounding JSON-shaped parts get the exact same serialization the fast path would have produced, so an interpolation like `${{ startDate: new Date(...), unit: "day" }}` round-trips with the JSON keys/strings intact and the Date instance preserved at its position. Pure-JSON interpolations stay on the fast path (`validateInterpolatable` + `JSON.stringify`, no walker overhead). Tests added in the template-tag describe in [test/codegen.test.ts](../test/codegen.test.ts) cover each top-level BSON instance type, the compile-binding path, and nested-in-object / nested-in-array / deeply-nested / cyclic-reference cases.

**`.compile()` bindings get the same treatment for free.** `safeBoundValue` in [src/codegen.ts](../src/codegen.ts) recurses through plain objects and arrays and short-circuits on `isOpaqueBsonValue` at every level, so a `.compile()` parameter binding like `({ cfg }) => $set({ cfg })` invoked with `{ cfg: { startedAt: new Date(...), mode: "fast", retries: 3 } }` keeps the `Date` (and any nested `RegExp`/`Uint8Array`/ObjectId) as live JS instances in the MQL output — the same shapes that work via template-tag interpolation. The behavior is symmetric across both surfaces; tests in the `jsmql.compile — opaque BSON bindings outside query-doc position` describe block cover each instance type and the same nested-in-object / nested-in-array / deeply-nested / mixed-JSON cases the template-tag describe covers.

---

## 2026-05-21 — Bare stage call auto-wraps as a one-stage Pipeline (no `;` required)

`jsmql("$match($.age > 18)")` now returns `[{ $match: { age: { $gt: 18 } } }]` instead of throwing `CodegenError("$match is a Pipeline stage, … add a trailing ;")`. Same auto-wrap applies to every registered stage (`$project`, `$sort`, `$limit`, `$group`, …) and to the Compass copy-paste form `{ $match: ... }`. The `;`-suffixed form keeps working and produces identical output. `jsmql.expr()` is **not** changed — passing a stage call to it stays a misuse case, since `jsmql.expr`'s contract is "raw aggregation expression" and stages are not aggregation expressions.

Motivation: a user wrote `$match(...)` at the top level and got an error telling them what they did wrong instead of the right MQL. The `;` was bookkeeping the surface didn't need. The original guard (DEVLOG 2026-05-19, "Filter dispatch: reject bare stage calls with a `;` suggestion") existed to prevent the silent footgun where the same input would otherwise produce `{ $expr: { $match: ... } }` — a syntactically valid Filter that MongoDB can't execute. But "throw with a fix-it message" was the second-cleanest option; "just do the right thing" is the cleanest. **More code = bad DX, less code = good DX** (from root [CLAUDE.md](../CLAUDE.md)) — applied to the keystrokes users have to type, not just to the MQL output.

Implementation in [src/index.ts](../src/index.ts): a four-condition check at the top of `lowerWithCtx` (not Pipeline, not UpdateFilter, not array-literal Pipeline, but **is** stage intent) constructs a synthetic `Pipeline` AST node (`{ type: "Pipeline", stmts: [ast], pos: ast.pos }`) and routes it through `generateImplicitPipeline`. So stage-specific behaviour (the `$match` index-friendly query translator; `$lookup` / `$unionWith` / `$facet` sub-pipeline recursion; let-binding scope rules) runs through exactly the same path it would in an explicit `;`-separated pipeline. The throw in `generateFilter` is gone; the function's contract is now "lower a Filter document" rather than "lower a Filter document or throw if Pipeline-intent is detected". `detectStageIntent` stays as a helper.

Test impact: the five existing tests asserting `toThrow(/Pipeline stage/)` — three in `test/codegen.test.ts`'s `stage-call-without-\`;\` guard` describe and two in `test/implicit-pipeline.test.ts` — were rewritten to expect the wrapped Pipeline output. The describes were renamed (`"stage-call-without-\`;\` guard"` → `"bare stage call auto-wraps as a one-stage Pipeline"`) and surrounding comments updated to reflect the new behaviour. All 1025 tests pass.

Doc updates: [docs/LANGUAGE.md](LANGUAGE.md) § Output dispatch was restructured — the rule table now reads "stage call / update filter / `;` / anything else" instead of the binary `;` vs no-`;`. The new "Stage call → Pipeline (no `;` required)" subsection sits between the Filter and multi-stage Pipeline sections. The function-form subsection now shows an expression-body arrow with a stage-call body as the third example. [README.md](../README.md)'s Highlights bullet was rephrased from "Filter vs Pipeline by the semicolon" to "Filter vs Pipeline picked automatically" with the new dispatch table embedded in prose. [docs/specs/filter-mode.md](specs/filter-mode.md) replaced the "Stage-call-without-`;` guard" section with a "Stage-call auto-wrap" section. Also added a new rule to root [CLAUDE.md](../CLAUDE.md) — **Maintain README.md** — so every observable library change must update the README in the same commit.

Pre-1.0 breaking output-shape change for one input shape (`jsmql("$match(...)")` used to throw, now returns an array). No grammar, AST, or runtime semantics change beyond the dispatch routing.

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

## 2026-05-20 — `jsmql()` always returns a pipeline for update-filter inputs

Single-statement update filters through `jsmql()` now lower to a **one-element pipeline array** (`[{ $set: { …RHS… } }]`) instead of the bare update document (`{ $set: { …RHS… } }`). Multi-statement update filters were already arrays; this change makes the single-statement case match. `jsmql.expr()` is **not** changed — it still produces the bare-doc shape for callers that want a building block to embed elsewhere.

The motivation is a silent footgun at the `db.coll.updateOne(filter, update)` call site. MongoDB only evaluates aggregation expressions on the RHS when the second `updateOne` argument is an **array** (pipeline form). The bare-doc form treats every value as a literal. So `db.users.updateOne({…}, jsmql("$.name = $.name.toUpperCase()"))` produced `db.users.updateOne({…}, { $set: { name: { $toUpper: "$name" } } })` — which compiled cleanly, looked correct in a logging line, and stored the literal object `{ $toUpper: "$name" }` in the `name` field at query time. Pure-literal update filters (`$.status = "done"`) happened to work in both modes, so the trap was invisible until a user wrote a real expression on the RHS. The README, LANGUAGE.md, and the realistic-test `usage` strings were all documenting the broken pattern. The user spotted it via the README example I'd just added.

The fix is a four-line addition to `lowerWithCtx` in [src/index.ts](../src/index.ts) — after the program lowers, if the AST is an `UpdateFilter` and the result is not already an array, wrap it once. `lowerExprWithCtx` (which `jsmql.expr` goes through) is left untouched, with a comment pinning the contrast in place. The split lives at the entry-point boundary, not inside `generateUpdateFilter` itself — the spec ([docs/specs/update-filter.md](specs/update-filter.md)) was updated to spell out which API wraps and which doesn't.

Test impact: 38 assertions in [test/update-filter.test.ts](../test/update-filter.test.ts), 5 in [test/implicit-pipeline.test.ts](../test/implicit-pipeline.test.ts), and 2 in [test/realistic.test.ts](../test/realistic.test.ts) updated to expect the wrapped array form. The implicit-pipeline `describe` that used to assert "single-statement inputs unchanged" was retitled and its comment rewritten — the new contract is "single-statement update-filter inputs always wrap as pipelines". The realistic-test `usage` strings for the two update-filter cases were repointed from `db.users.updateOne({…}, jsmql.expr(…))` to `db.users.updateOne({…}, jsmql(…))`, since that is the correct call shape now.

Doc updates: [README.md](../README.md)'s update-filter Tour comment and the headline `updateOne` example switched from `jsmql.expr(…)` to `jsmql(…)` with the wrapped output. [docs/LANGUAGE.md](LANGUAGE.md)'s § Update filters opens with the new pipeline-array contract, every code block in that section uses the wrapped form, and a new "Bare-document form via `jsmql.expr`" subsection documents the escape hatch with an explicit "do not pass this to `updateOne()`" warning. The § Partial expressions section gained a second differentiator bullet (update-filter input) and a matching ⚠️ warning. Breaking output-shape change to one branch of `jsmql()`; pre-1.0, so acceptable. No grammar or AST change.

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

## 2026-05-17 — Array methods: fill the MDN list, bind `(element, index)`, shim mutators

A single pass over MDN's `Array.prototype.*` list to close the gap between "JS you already know" and what jsmql actually accepts. Three buckets:

**Six new method lowerings** ([src/codegen.ts](../src/codegen.ts:1915)). `.findIndex(p)` — the missing twin of `findLastIndex`, lowered to the same `$reduce`+`$zip` shape but with a `$$value == -1` guard so only the first match wins. `.lastIndexOf(x)` — `$let { revIdx: $indexOfArray($reverseArray(arr), x) }` then normalises back to the original index (or `-1`); strings rejected because MongoDB's `$indexOfCP` is forward-only. `.reduceRight(fn, init)` — `.reduce` with the input wrapped in `$reverseArray`. `.toSpliced(start[, dc, ...items])` and `.with(index, value)` — both build a 3-piece `$concatArrays` of `$slice` / literal / `$slice` inside a `$let` so the receiver and indices are evaluated once; negative literals are rejected at compile time because `$slice`'s position/length args are non-negative. `.toString()` — joins arrays with `","`, no-ops on strings, falls back to `$toString` on unknown receivers.

**`(element, index)` callback support across all 9 lambda-takers.** Prior to this pass, `requireLambda` didn't enforce arity, so `$.items.find((x, i) => x > i)` parsed and codegened but produced `$$i`-as-undefined-variable errors at query time. A new `arrayIterInput()` helper ([src/codegen.ts](../src/codegen.ts:2236)) returns the right input shape per param count: 1-param keeps the status quo (`as` = user name); 2-param zips the input with `$range(0, $size)` under a synthetic `as: "jsmqlPair"` and `$let`-wraps the body so the user's names resolve via the standard `lambdaParams` path; 3+ throws a tailored error. `.map`, `.filter`, `.find`, `.findLast`, `.some`, `.every`, `.flatMap` all run through it; `.findIndex` and `.findLastIndex` extend their existing `$let.vars` to optionally bind the second param; `.reduce` and `.reduceRight` accept `(acc, x, i)` with the input zipped and the body `$let`-wrapped around the existing `reduceRemap`-for-`acc`. The third `array` arg from MDN's signature is deliberately not supported — the receiver is already in scope at the call site, so re-binding it into every iteration would double cost for no expressive gain.

**13 DX shims** ([src/codegen.ts](../src/codegen.ts:2247)). The in-place mutators (`.sort`, `.splice`, `.push`, `.pop`, `.shift`, `.unshift`, `.fill`, `.copyWithin`) used to surface a generic "Unknown method, did you mean…" error; now each throws a tailored "mutates in JS; expressions are immutable. Use '.toSorted()' / '.toSpliced(start, deleteCount, ...items)' / `[...arr, x]` / `.at(-1)` / etc. instead." Iterator-returning (`.entries`, `.keys`, `.values`), void-returning (`.forEach`), and locale-dependent (`.toLocaleString`) methods get the same treatment with workaround hints (e.g. `.entries()` points at `.map((v, i) => [i, v])`). All shimmed names live in `KNOWN_METHODS` so typo suggestions still surface them when relevant.

37 new test cases in [test/codegen.test.ts](../test/codegen.test.ts) cover each new method, each shim, the 2-param happy path for every lambda-taker, and the 3-param rejection. One new realistic case in [test/realistic.test.ts](../test/realistic.test.ts) exercises `.with()` and indexed `.map((p, i) => …)` together. Tally: jsmql now implements 24 of MDN's 38 instance methods (everything that has a sensible MQL lowering) and produces actionable errors for the other 14.

Specs updated: [docs/specs/method-dispatch.md](specs/method-dispatch.md) (new rows, callback-parameters subsection, mutator-shim subsection). User-facing docs updated: [docs/LANGUAGE.md](LANGUAGE.md) (new methods in Simple/Lambda Methods, "Callback parameters" subsection, mutator-error table, optional-chaining neutral-value table).

---

## 2026-05-17 — Doc fix: spread examples in Valid Constructs use field refs

The "Valid Constructs" bullet for spread in [docs/LANGUAGE.md](LANGUAGE.md) showed `[...arr]` and `{ ...obj }` — bareword identifiers that don't resolve in string-form jsmql and would have produced an `UnknownIdentifierError` if a reader copy-pasted them. Replaced with `[...$.arr]` and `{ ...$.obj }` so the examples actually compile, matching the field-ref shape used everywhere else in the bullet list and in the deeper Arrays/Objects subsections (lines 181-182, 194-195).

---

## 2026-05-16 — Auto-`$literal` wrap for `"$..."` string values

User-supplied string literals (and `jsmql.compile()` bindings, and template-tag interpolations) whose value starts with `$` are now auto-wrapped in `{ $literal: value }` so MongoDB does not read them as field references at query time. The wrap fires on any `"$..."` shape in a *value* position — top-level, array element, object value, operator argument, method argument. Object **keys** are deliberately unaffected (MongoDB doesn't auto-evaluate keys, so `{ "$foo": 1 }` is how you intentionally name a field `$foo`).

Why this matters for DX: the existing behaviour quietly produced `{ $eq: ["$x", "$dangerous"] }` for `jsmql.compile(({ name }, $) => $.x === name)({ name: "$dangerous" })`. At query time MongoDB would compare `$x` against the value of field `dangerous` — a silent footgun if `name` ever came from user input. The wrap closes the gap so any `"$..."` string reaches the server as a literal.

Implementation: a new `insideLiteral?: boolean` field on `GenerateCtx` ([src/codegen.ts](../src/codegen.ts)). The `$literal(...)` operator codegen recurses on its argument with that flag set, suppressing the wrap inside the envelope so a literal-of-a-literal doesn't emit. `literalSafeString` is the single point where string literals are emitted; `safeBoundValue` walks `jsmql.compile()` param values recursively, applying the same policy to nested arrays and objects. `extendCtx` propagates the flag through lambda bodies; `freshSubPipelineCtx` drops it (a sub-pipeline starts fresh).

`$literal(...)` keeps working when called explicitly — the operator's fast-path codegen sits ahead of the `style === "object"` branch in `generateOperatorCall` so `$literal({ x: 1 })` is treated as a value to wrap, not as object-style named-key wire format. 14 new test cases in `test/codegen.test.ts` cover the auto-wrap shapes, the suppression inside `$literal`, the key vs. value distinction, the template-tag path, and the `jsmql.compile()` binding path with nested arrays and objects. Spec updated in [docs/specs/operator-registry.md](specs/operator-registry.md).

---

## 2026-05-16 — LANGUAGE.md sync: five stale claims fixed

Audit pass over [docs/LANGUAGE.md](LANGUAGE.md) against the current implementation surfaced five claims that no longer matched what the compiler emits or rejects. All five are doc-only fixes; no source under `src/` changed.

1. **FAQ vs. type-aware dispatch contradiction.** The FAQ at the bottom of the file claimed `.includes()` / `.indexOf()` / `.concat()` on a bare `$.field` "defaults to string semantics," contradicting the canonical Array Methods section a few hundred lines above (which describes the runtime `$cond` on `$isArray`). The implementation matches the canonical section — see [src/codegen.ts:1597-1617](../src/codegen.ts). FAQ rewritten to describe the runtime dispatch and point at the type-hint workarounds.
2. **`$literal` "argument not evaluated" claim.** jsmql evaluates `$literal`'s argument like every other operator (`$literal($.a + $.b)` → `{ $literal: { $add: ["$a", "$b"] } }`). What's special about `$literal` is that *MongoDB* doesn't re-evaluate its contents at query time. Heading and prose rewritten to make the distinction.
3. **Unknown-method error format.** Docs claimed the error appends `String methods: trim, trimStart, …`; the actual message ends after the method name, with an optional `Did you mean '.trim()'?` when [closestNameTo](../src/levenshtein.ts) finds a near match ([src/codegen.ts:2021-2023](../src/codegen.ts)). Example updated to reflect the real format and to also show the suggestion case.
4. **`in` RHS error wording.** Doc copy was missing `object literal` from the accepted shapes — added by the `in` against object-literal RHS work and never backported here ([src/codegen.ts:951](../src/codegen.ts)).
5. **`$$NOW` in a update op example.** A pipeline example used `$.lastSeenAt = $$NOW` in source position, but jsmql has no JS-syntax surface for `$$NOW` — the lexer rejects `$$` at the start of an identifier. The example now uses `new Date()` (which lowers to `{ $toDate: "$$NOW" }` via [src/codegen.ts:593](../src/codegen.ts)), with the expected output updated to match.

---

## 2026-05-16 — Parser: accept comma-chained parenthesized assignments

Prettier and oxfmt rewrite a top-level assignment chain like `$.a = 1, $.b = 2` to `($.a = 1), ($.b = 2)` when each assignment could otherwise be read as a destructuring assignment. The parser already accepted a single parenthesized assignment (`($.x = 5)`), but the comma-chained form failed with `Cannot assign to this expression …` because `parseUpdateFilterRest` called `parseUpdateOp()`, which called `parsePostfix()`, which returned a parenthesized `AssignExpr`, and then `validateUpdateTarget` rejected the `AssignExpr` as a non-field-path target.

`parseUpdateOp()` ([src/parser.ts](../src/parser.ts)) now short-circuits: if `parsePostfix()` returns something whose `type` is already `"AssignExpr"`, it's surfaced as a complete update op rather than running through `validateUpdateTarget` + `parseAssignmentChainFrom`. The paren-form `parseGrouped` path already builds the `AssignExpr` correctly — it just had no consumer at the comma-tail position. Three new cases in `test/update-filter.test.ts` cover the bare statement form, the function-body form (exactly the example LANGUAGE.md was claiming worked), and the mixed paren-assignment + paren-postfix-inc/dec form. The spec update lives in [docs/specs/update-filter.md](specs/update-filter.md).

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

## 2026-05-15 — `.reduce()` accumulator type narrowing trims the dead `$isArray` cond

`acc[k]` inside `reduce((acc, x) => ({ … }), {})` (and the array-symmetric `reduce(…, [])`) now compiles to a bare `$getField` / `$arrayElemAt` instead of the 3-branch `$cond` on `$isArray` that the bracket-access codegen used to emit for every non-structurally-known receiver. The codegen ctx gains a `bindingTypes` field ([src/codegen.ts:80](../src/codegen.ts)); reduce-codegen ([src/codegen.ts:1936-1991](../src/codegen.ts)) pins `params[0]` to `"object"` or `"array"` when **both** `initialValue` and the lambda body are statically the same compound type. The IndexAccess case ([src/codegen.ts:444-484](../src/codegen.ts)) reads it to short-circuit the dispatch, and flips the optional-chain `$ifNull` fallback to `{}` on the known-object branch so a null receiver doesn't feed `$getField` an array.

The both-sides-must-agree rule exists because `$$value` after iteration `i ≥ 1` is the body's return from `i-1`, not the initialValue — narrowing on the initial alone is unsound the moment the body returns a different shape (`reduce((a,x) => x.foo, {})` legitimately keeps the cond). When both agree, the type is invariant across iterations. Nested reduces that reuse the accumulator name explicitly shadow the outer narrowing (the inner's `bindingTypes` entry overwrites or deletes the outer's), so `outer-object → inner-array` doesn't miscompile inner `acc[0]` as `$getField`. `isObjectProducing` is the minimum-viable `expr.type === "ObjectLiteral"` check; broadening it to `$mergeObjects` / `$arrayToObject` operator calls is left for when a real case shows up.

This cleans up the README's headline histogram example ([test/realistic.test.ts:75-148](../test/realistic.test.ts)) — the 3-branch `$cond` block disappears from the demo MQL panel in the playground. The new `describe("reduce accumulator type narrowing", …)` block in [test/codegen.test.ts](../test/codegen.test.ts) covers positive object + array cases, three negatives (body diverges, non-literal initial, element param not narrowed), the nested-reduce shadow, and the optional-chain fallback flip. [docs/specs/method-dispatch.md](specs/method-dispatch.md) documents the new field and the three-way IndexAccess dispatch.

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

## 2026-05-14 — `jsmql.compile()` accepts a string source

`jsmql.compile()` now accepts a string containing the arrow source in addition to a real arrow function — `jsmql.compile("({ minAge }, $) => $.age > minAge")` is equivalent to passing the function value. This brings `compile()` in line with `jsmql()` and `jsmql.validate()`, both of which already polymorph over string / arrow / template tag. The motivating use case is queries stored externally (config files, database rows, admin tooling): callers who only have the text can still benefit from the parse-once-bind-many semantics that make `compile()` more than a wrapper around `jsmql()`.

The implementation is small: [src/index.ts](../src/index.ts) gains an overload on `compileFunction` and a `typeof input === "string"` branch that uses the string directly as `src`. Everything downstream — `parseFunctionInput`, the bindings map, the closure shape — is unchanged. A string without an arrow shape inherits the existing `FunctionInputError` ("jsmql expects an arrow function `($) => …`"); a value that is neither a function nor a string throws `TypeError` from the entry point.

We explicitly **did not** add a `${name}`-placeholder syntax inside compile strings, even though it would superficially look like template-tag syntax that users already know. Two reasons. First, the strict-JS-subset rule (root [CLAUDE.md](../CLAUDE.md)) requires that every expression jsmql accepts be valid JS — `${id}` outside a template literal isn't, so the string contents would no longer "copy-paste into a JS file and parse." Second, plain-string `${name}` placeholders are a footgun next to real template literals: a user who writes `` jsmql.compile(`… ${id} …`) `` with backticks (easy, especially for multi-line queries) gets JS-time interpolation, not deferred binding — silently breaking the `compile()` contract. Keeping the destructure as the single parameter-declaration mechanism preserves the invariant in both directions: anything `jsmql.compile()` accepts is valid JS, and the only way values reach the MQL output is through the params object at call time. The tagged-template form of `compile()` was rejected on the same reasoning — interpolation happens at tag-evaluation time, which is the wrong time for a "compile once, bind many" surface.

Test coverage in [test/codegen.test.ts](../test/codegen.test.ts) under the new `describe("string input")` block; spec updates in [docs/specs/function-form-params.md](specs/function-form-params.md) and the user-facing reference in [docs/LANGUAGE.md](LANGUAGE.md#string-input).

---

## 2026-05-14 — `jsmql.validate` accepts compile-form arrows (same shape as `jsmql.compile`)

`jsmql.validate` now accepts the parameterised arrow shape that `jsmql.compile` accepts — `({ minAge }, $) => …` and friends — in addition to the one-shot string / function / template-tag inputs it has always taken. Motivation: when the user writes `jsmql.validate(({ age }, $) => …)`, TypeScript was contextually typing the second parameter as `JsmqlOps` (because the existing `JsmqlInput` overload's `JsmqlFn` is `($: any, ops: JsmqlOps) => unknown`), which made `$.dob` fail in the IDE even though the runtime accepted the expression. The new overload `validate<P>(fn: JsmqlCompileFn<P>)` is listed first in source order so TS picks `(params: P, $: any, ops: JsmqlOps)` for any two-or-three-parameter arrow, leaving `$: any` and `$.dob` typing cleanly.

Runtime change at the same time: `validateInput` no longer routes function inputs through `jsmqlDispatch` (which rejected compile-form arrows with an unhelpful "use `jsmql.compile`" message). It now parses the arrow directly via `parseFunctionInput`, resolves each `ParamBinding` to a `null` placeholder before `lowerWithCtx` runs, and surfaces any errors through the existing `errorToValidationResult` mapping. Values don't affect syntactic validity — only that bound names resolve as `ParamRef` rather than unknown identifiers. The compile *invocation* path (`jsmql.compile(fn)(params)`) stays throw-style, since per-call binding errors carry the caller's runtime values and belong in normal error handling.

Files: [src/index.ts](../src/index.ts) (new overload, inline function-input branch in `validateInput`); [docs/specs/architecture.md](specs/architecture.md), [docs/specs/function-form-params.md](specs/function-form-params.md) (signature listing + rationale). The existing "accepts an arrow function" case in [test/realistic.test.ts](../test/realistic.test.ts) is the regression test — it already failed in the IDE under the old types even though its assertions passed at runtime.

---

## 2026-05-14 — `playground.html` becomes a self-sufficient single-file artifact

[playground.html](../playground.html) used to need two sibling assets at runtime — `./dist/index.js` (the tsc output) and `./playground-examples.json` (the example manifest written by `sync-playground.mjs`). That made it impossible to ship on its own: you couldn't email it, drop it on a static host, or just double-click it from disk, because Chrome blocks `fetch()` from `file://` URLs and the dist import obviously can't resolve without the rest of the build.

Now the file is fully self-contained. [scripts/sync-playground.mjs](../scripts/sync-playground.mjs) was extended to also bundle [src/index.ts](../src/index.ts) via esbuild as an IIFE — `format: "iife"`, `globalName: "JSMQL"`, `minify: true`, `target: "es2022"`, `platform: "browser"` — and inject the result into a managed region in `playground.html` between `<!-- jsmql-bundle:start -->` / `<!-- jsmql-bundle:end -->` comments. The examples manifest is no longer a sibling JSON; it lives inside a second managed region as a `<script type="application/json" id="examples-data">` JSON island. The module script then reads `const { jsmql } = globalThis.JSMQL;` and parses the JSON island synchronously instead of fetching. The only external dependency remaining is the CodeMirror CDN — explicitly kept out of the bundle, the user wanted the syntax highlighter to stay external.

The script is now also wired into `prebuild`, so `npm run build` keeps the playground in sync with both the test file and the library source. `playground-examples.json` was deleted (its data lives inside the HTML now). The output file is ~130 kB and the script is idempotent — running `npm run sync:playground` a second time exits 0 without writing if nothing changed. Verified end-to-end against a local static server: example selection populates, prettify works, and the syntax-error marker still highlights the offending position with no fetches to `./dist/` or `./playground-examples.json` in the network log.

Adds `esbuild` to `devDependencies`. The one DX trade-off worth noting: edits to `src/*.ts` outside Claude Code now need a manual `npm run sync:playground` (or `npm run build`) to re-embed the bundle — the existing PostToolUse hook only fires on `test/realistic.test.ts` edits. A src-watching hook is a possible follow-up.

---

## 2026-05-14 — `tsconfig.test.json` so the IDE stops flagging `node:` imports in test files

The root [tsconfig.json](../tsconfig.json) has `rootDir: "src"` and `include: ["src"]` because that's what the published build needs. Side effect: when the IDE opens a file under `test/`, the TypeScript language service decides the file doesn't belong to any project, falls back to inferred-project mode, and never auto-picks `@types/node`. Result is `TS2591: Cannot find name node:child_process` on every `import { spawnSync } from "node:child_process"` in `test/smoke.test.ts`, `test/operator-spec-coverage.test.ts`, etc. The IDE's own JS/TS resolver still finds the symbols, so hovers and completions work — but the module specifier sits there permanently red.

Fix is a dedicated [tsconfig.test.json](../tsconfig.test.json) that extends the root config, covers `test/`, sets `noEmit: true`, and explicitly opts back out of TS 6's strict-by-default (`strict: false`, `noImplicitAny: false`, plus `types: ["node"]` since auto-include of `@types/*` doesn't always fire under `moduleResolution: "bundler"` when `types` is unset). Kept lenient on purpose — the goal is to scope test files into a project so `@types/node` resolves, not to start type-checking the test corpus, which has long-standing intentional patterns (e.g. `jsmql(() => $.age > 18)` references a `$` that only exists in the source-text view, not the JS scope) that wouldn't survive strict mode and aren't a real bug.

`npm test` is unaffected — vitest does its own transpilation and doesn't look at this file. The only consumer is the IDE/editor TypeScript service. `scripts/*.mjs` weren't included because they're plain JS, not TS, so the original error never reached them.

---

## 2026-05-14 — Drop the implicit LRU cache from one-shot `jsmql(fn)`

The 256-entry `fnBodyCache` in [src/index.ts](../src/index.ts) is gone. The function-input branch of `jsmqlDispatch` now extracts the body, parses, and lowers without consulting or populating a cache. `cacheGet`, `cacheSet`, the cap constant, and the surrounding rationale comment were all deleted along with the `describe("function-body cache is bounded", …)` block in [test/security.test.ts](../test/security.test.ts) that asserted LRU eviction correctness over 300 distinct bodies.

The trigger was user feedback that one-shot queries — those parsed once at process startup and never re-executed — occupy cache slots indefinitely (well, until 256 newer entries push them out). A literal `Map` → `WeakMap` swap was the proposed fix but isn't possible: `WeakMap` requires *object* keys and the current key is the body string (a primitive), and `WeakMap` exposes neither `.size` nor iteration, so the cap can't be preserved on top of it. The two alternatives — keying on the `Function` object (which loses inline-hot-loop dedup, since each iteration creates a fresh function instance) or running a hybrid Map + WeakMap — both kept the implicit-cache footgun without much to show for it.

`jsmql.compile(fn)` is the right answer for repeated execution: it parses once, returns a closure that captures the AST, and walks that AST with fresh `params` substitutions on every call. The migration is one line — `const q = jsmql.compile(fn); q(params)` instead of `jsmql(fn)` — and the caller's intent is now explicit at the call site rather than buried in an implicit LRU. The string-input and template-tag paths were never cached and stay that way.

Files: [src/index.ts](../src/index.ts) (delete cache helpers + simplify function-input branch); [test/security.test.ts](../test/security.test.ts) (remove LRU-eviction smoke test); [test/codegen.test.ts](../test/codegen.test.ts) (rename "(cache correctness)" test — the consistency-across-calls property still holds, it just no longer depends on caching); [README.md](../README.md) (point users to `jsmql.compile(fn)` for repeated execution); [docs/specs/architecture.md](specs/architecture.md), [docs/specs/function-form-params.md](specs/function-form-params.md) (spec updates to match).

---

## 2026-05-14 — DX rule: `.validate()` errors must always carry a meaningful `.pos`

Added a new sub-bullet under "#1 priority: developer experience" → "Errors stay consistent and helpful across the surface" in [CLAUDE.md](../CLAUDE.md). The rule states that every `ValidationError` returned by `validate()` must have a real source offset in `.pos`, not the `0` placeholder. Tooling consumers (editor integrations, the playground) rely on `.pos` to underline the offending region, and the public `ValidationError` shape already declares `.pos: number` as required — returning `0` silently breaks that contract while still type-checking.

An audit of every throw site reachable from `validate()` found that only `LexError` and `ParseError` set `.pos` to a real byte offset. `CodegenError`, `UnknownIdentifierError`, `FunctionInputError`, `JsmqlInterpolationError`, and the catch-all in [src/index.ts](../src/index.ts) all fall back to `.pos = 0`. Root cause: AST node types in [src/ast.ts](../src/ast.ts) carry no position field — the parser discards token offsets when it builds nodes, so codegen has nothing to forward even when it knows which node is at fault. No test currently asserts `.pos > 0`, so the gap is invisible to CI.

The rule is recorded as a forward-looking principle; the implementation gap (threading positions through the AST + codegen + adapter throws + adding test coverage) is a separate task to be planned and landed next.

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

## 2026-05-14 — Playground pipeline examples dedent past the lone-opener `[`

The three pipeline examples that came in through `jsmql\`[\n  $match(...)\n  ...\n]\`` tagged templates — `top-orders-report-by-department`, `count-orders-by-status-per-shop-accumulator-replacement`, `invoice-finalisation-pipeline-update ops-match` — were rendering in the playground with the raw test-file indent (6-space body, 4-space closer) instead of the canonical 2-space pipeline shape. Root cause: the `dedent()` helper in [scripts/sync-playground.mjs](../scripts/sync-playground.mjs) computes the global minimum indent across all non-empty lines, but a template that starts with `[` directly after the backtick puts that opener on line 1 at column 0, dragging the minimum to zero and short-circuiting the strip. The simple-expression cases sidestep this because they either fit on one line or start with `\n` (so the first content line is itself indented).

Added a small fallback: when the global min is zero *and* the first line is a lone opener (`[`, `{`, or `(`), measure the minimum indent of the body lines and strip that instead. The opener stays at column 0, the body lines drop to a canonical depth (typically 2 spaces because the test-file closer was 4 spaces in), and nested structure is preserved at relative depth. Verified by hand against all three pipeline examples in the live playground — they still parse and produce the same MQL, just with readable indentation.

Also extended [`.oxfmtrc.json`](../.oxfmtrc.json) to ignore `playground.html`. The two managed regions inside the file (the minified jsmql IIFE bundle, the JSON-island manifest) are both generator output that needs to stay byte-stable; oxfmt's pretty-printer was unfolding the bundle from one line to ~5000 between syncs, which created huge spurious diffs and forced contributors to remember to re-run `sync:playground` after every `format`. The file is regenerated by `sync-playground.mjs` and doesn't need oxfmt's attention.

---

## 2026-05-14 — Thread `.pos` through codegen and adapter errors so `.validate()` honours its contract

Every AST node in [src/ast.ts](../src/ast.ts) now carries a required `pos: number` field, populated by the parser at every construction site from the leading token of each construct (literal token for literals, opening delimiter for collections, operator for binary/unary/ternary, `let`/`delete`/`$`/`$.` keyword for statements and refs). `CodegenError`, `UnknownIdentifierError`, and `FunctionInputError` all gained `readonly pos: number` fields and a constructor parameter, and every throw site forwards the appropriate node or token offset. `errorToValidationResult` in [src/index.ts](../src/index.ts) now passes `err.pos` through for codegen and function-input errors instead of the previous `0` placeholder, closing the gap the [CLAUDE.md](../CLAUDE.md) DX rule called out in the prior commit.

`JsmqlInterpolationError` stays at `.pos = 0` for the documented reason: the template-tag form's source text lives across the `strings` and `values` arrays, and there is no single byte offset to report. Callers needing to locate a failing interpolation read `.slot` (1-based index) or `.key` (parameter name) on the underlying error class. `RangeError` / `TypeError` / generic catch-all also stay at `0` — they come from outside our control.

[test/error-pos.test.ts](../test/error-pos.test.ts) is new — focused assertions that `.pos` lands on the right region for every error class (lexer, parser, codegen, function-input, interpolation). The four cases in `test/realistic.test.ts`'s `describe("jsmql.validate(): realistic error cases", …)` block grew `.pos` range assertions so the contract is exercised at the integration level too. Specs in [docs/specs/architecture.md](specs/architecture.md), [docs/specs/let-bindings.md](specs/let-bindings.md), [docs/specs/update-filter.md](specs/update-filter.md), and [docs/specs/function-form-params.md](specs/function-form-params.md) were updated to describe the new invariant.

Out of scope for this change (intentional, called out in the plan): sub-node positions on individual `KeyValueEntry` / `SpreadElement` / array-element members beyond what the AST already carries, and a synthesised offset for interpolation errors. The parent-node `pos` already covers ~60 of the ~70 codegen throw sites; sub-node precision is a follow-up if a real user hits it.

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
