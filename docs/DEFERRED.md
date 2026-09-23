# DEFERRED — open work items

This file lists every feature that JSMQL refuses, defers, or does not yet build. §A rows stay in ID order. A row leaves the file when the item ships.

This file exists so the project does not forget an open item. Every "not yet supported" / "future work" / "deferred" / "out of scope" marker in the live surface of JSMQL (except historical `DEVLOG.md` entries) must carry a `[DEF-NNN]` tag and have a row below. The drift-protection test in [`test/deferred-coverage.test.ts`](../test/deferred-coverage.test.ts) enforces this in both directions:

- Forward gate: every `[DEF-NNN]` tag must have a matching row here.
- Reverse gate: every row here must have at least one `[DEF-NNN]` tag in the live surface, or the row's status must be `design-only`.
- Untagged-marker gate: every deferral phrase in the live surface must carry a tag, or `test/deferred-allowlist.txt` must list it with a one-line reason. When an allowlist entry no longer matches any phrase, the test fails. So the allowlist shrinks over time and never grows stale.

**Conventions.**
- Tag format: `[DEF-NNN]`, written literally. It may carry a label: `[DEF-013: schema]`. The match regex is `\[DEF-\d{3}\]`.
- When you ship an item, delete its row and strip every `[DEF-NNN]` tag in the same commit.
- When you reject a feature with a "not yet" error, add the row and a tag in the same commit.
- When a decision is "will not implement," add a row to the §B Decisions section. Do not add a `[DEF-NNN]` tag. The codebase explanation lives in the spec; this file records only that the project considered the idea and rejected it.
- **Per-row schema.** Every §A row carries nine fields, in this order:
  - *What is blocked* — the surface the user cannot reach.
  - *Target lowering* — the MQL the feature would emit.
  - *Why blocked* — what makes the feature hard.
  - *Attempted approaches* — earlier tries.
  - *Success criteria* — the test that proves the item shipped.
  - *Rejection site(s)* — where the refusal lives, by file and symbol. Never a line number, because the file is append-only.
  - *Spec* — the owning document.
  - *Status* — `open` or `design-only`.
  - *Effort* — S, M, or L.
- **Counts** live in [`test/deferred-coverage.test.ts`](../test/deferred-coverage.test.ts), not here. A count in prose goes stale at the next row change.

---

## §A. Open — to implement

### DEF-012 — Index-pitfall warning channel via `validate()`

- **What is blocked.** A `let` binding before an indexable `$match` blocks the match from using the index. The compiler could show a warning, but `validate()` has only an error channel, not a warning channel.
- **Target lowering.** No change to the MQL output. `validate()` gains a `warnings` array next to `errors`. Each warning carries `.pos`, `.severity: "warning"`, and a message that names the binding and the index it blocks.
- **Why blocked.** The `ValidationResult` shape needs a new `warnings` array. The project is pre-1.0, so the API is not fixed, and the change is safe. But the project must also decide which other warnings it needs. Candidates include unused bindings, unreachable stages, and deprecated patterns.
- **Attempted approaches.** None.
- **Success criteria.** `jsmql.validate("let id = $.userId; $match($.x > 5);")` returns `{ valid: true, errors: [], warnings: [{ severity: "warning", pos: …, message: "let 'id' before $match blocks index usage on …" }] }`.
- **Rejection site(s).** Design only.
- **Spec.** `docs/specs/let-bindings.md` § Deferred bullet 4.
- **Status.** design-only
- **Effort.** M

### DEF-013 — Schema / metadata threading (`jsmql.bind({ db, collection })`)

- **What is blocked.** JSMQL compiles statelessly. It does not know the name of the current collection, so a self-join (`$$.find()` / `$$.filter()`) cannot resolve its `$lookup.from`.
- **Target lowering.** A new entry point, `jsmql.bind({ collection, db })`, returns a new callable shaped like `jsmql` (callable plus `.compile`, `.validate`, `.expr`, `.filter`, `.pipeline`, `.update`). It threads `boundCollection` / `boundDb` into `GenerateCtx`. The mongoose plugin uses it automatically, with the model's `collection.name`.
- **Why blocked.** The feature needs a new public API entry point, a new `GenerateCtx` slot, and a resolution rule in the `$$.find` / `$$.filter` lowering.
- **Attempted approaches.** None.
- **Success criteria.** `const bound = jsmql.bind({ collection: "users" }); bound("$$.find(u => u.parentId === $._id);")` lowers to `$lookup` with `from: "users"`.
- **Rejection site(s).** None. The API does not exist yet. The live `[DEF-013]` tags sit in [`docs/LANGUAGE.md`](LANGUAGE.md), at each place where the text says a read needs schema binding.
- **Spec.** `docs/specs/context-references.md` § Future work, bullets 1 and 2. The item will need its own spec, `docs/specs/bind.md`.
- **Status.** design-only
- **Effort.** L

### DEF-014 — Optimised chained terminals on lookups

- **What is blocked.** A chain that reads a lookup's array as a VALUE materialises the `$lookup` in a scratch slot. It leaves a `$set` stage plus the `$unset` stage that clears the slot. The result is two stages where a specialised recogniser could emit one.
- **Target lowering.** A recogniser on the join road (`joinValue` in `src/compiler/emit/join.ts`) folds the slot read into the `$lookup`, for the shapes where it can.
- **Why blocked.** This is a performance optimisation, not a correctness fix. It needs careful pattern enumeration, so the change does not break the generic path.
- **Attempted approaches.** None.
- **Success criteria.** `$.n = $$$.users.filter(u => …).map(u => u.name).at(0);` emits one `$lookup` and nothing else. Today it emits the `$lookup`, a `$set` that reads the slot, and the `$unset`.
- **Rejection site(s).** None. The compiler emits correct MQL, only larger than needed.
- **Spec.** [`docs/specs/lookup-stage.md`](specs/lookup-stage.md) § The join road.
- **Status.** design-only
- **Effort.** M

### DEF-016 — Per-operator return-type narrowing in `globals.ts`

- **What is blocked.** Every generated operator in `src/globals.ts` returns `any`. `$abs($.x)` could return `number` instead, but that return type would break method chain inference on field refs. `$.foo` is `any`, so `$abs($.foo)` must not suddenly become `number` and reject `.toString()`.
- **Target lowering.** No change to the MQL. Only the types change. The design must set a careful boundary between a field ref and a concrete value.
- **Why blocked.** The interaction with `$.foo : any` is the open problem. The project is pre-1.0, so the types still change often. The fix should land once, not in steps.
- **Attempted approaches.** None.
- **Success criteria.** `$abs($.foo)` is `number` in TypeScript, and field-ref chains still work.
- **Rejection site(s).** The deferral prose in [`docs/specs/globals-generation.md`](specs/globals-generation.md) § The generated shapes. The `[DEF-016]` tag is in the same file.
- **Spec.** `docs/specs/globals-generation.md`.
- **Status.** design-only
- **Effort.** M

### DEF-022 — `Number.isFinite($.x)` (Infinity / NaN comparison)

- **What is blocked.** `Number.isFinite($.x)` is rejected. JSMQL has no syntax for an `Infinity` or `NaN` literal to compare against.
- **Target lowering.** The fix needs both a literal-Infinity and a literal-NaN escape hatch in the parser, plus a translation table for the resulting comparisons.
- **Why blocked.** JSMQL source has no `Infinity` or `NaN` literal, and the lowering would touch every numeric comparison helper. JSMQL's output must stay JSON-serialisable, so an emitted literal cannot be a real BSON `NaN` or `±Infinity`. `JSON.stringify(NaN)` is `null`, and that would silently change the comparison. The server must synthesise the value instead.
- **Attempted approaches.** The project verified the comparison half on a live mongod. `{$toDouble: "NaN"}` gives a genuine double NaN. MongoDB's `$eq` treats `NaN == NaN` as true, unlike JavaScript. So `{$eq: [x, {$toDouble: "NaN"}]}` is an exact NaN test. It is true for a `double` or `decimal` NaN, and false for ±Infinity, ±0, the string `"NaN"`, null, a missing field, `[]`, and `{}`. `{$toDouble: "-Infinity"}` gives the other bound, because NaN sorts below it, so `{$gt: [x, -Infinity]}` also isolates NaN among numbers.

  What remains open is the source-syntax half, and the cost. The project measured the same clause at +41% on a `$match` when added to `jsBool`. This is why the truthiness rule does not carry it (see the NaN note in `docs/LANGUAGE.md`). A one-off `Number.isFinite` call should not pay that whole-language price. The current error message names three workarounds: `$type`, a `$convert` sentinel, and a range guard.
- **Success criteria.** The success criteria depend on the literal-escape design, and are not yet decided.
- **Rejection site(s).** The `Number.isFinite` row in `src/registry/names.ts`. Its refusal cells carry the tag.
- **Spec.** None yet. The project would need a new spec, for example `docs/specs/numeric-edges.md`.
- **Status.** open
- **Effort.** M

### DEF-031 — Function-aware Filters via textual inline

- **What is blocked.** A reusable function cannot run inside a **bare Filter** (no `;`, for example `db.coll.find(jsmql("isAdult($)"))`). A function declaration needs a `;`, and that flips the source into Pipeline mode. So a Filter cannot declare or call a function today.
- **Target lowering.** A function used in a Filter would need **textual inline** into the predicate. The Filter has no pipeline scope and no `$let` stage to host the binding. The compiler would translate the body into the query language, as if the developer wrote it in place.
- **Why blocked.** A Filter is a single expression with no statement list. Threading a declaration into it needs a separate declaration channel, or a textual-inline pass apart from the pipeline `$let` expansion. The output shape differs from the pipeline form — an inlined body instead of a `$let` — so the design stays separate on purpose.
- **Attempted approaches.** None. The developer asked to record this as the likely next step for Filters.
- **Success criteria.** Not yet decided; it depends on the inline design. `db.coll.find(jsmql("const adult = (p) => p.age >= 18; adult($)"))`, or a Filter-specific syntax, would produce a query document with the body inlined.
- **Rejection site(s).** None. There is no dedicated throw. The parser's general rule covers it: it refuses a declaration outside a pipeline with the message "declares a reusable function, and a reusable function is declared at the top level of a pipeline".
- **Spec.** `docs/specs/reusable-functions.md` § Deferred.
- **Status.** design-only
- **Effort.** M

### DEF-032 — Higher-order functions (function passed as a value)

- **What is blocked.** A reusable function cannot act as a **value** instead of a call. Examples are `$ = { fn: double }`, and passing a function reference to another function, such as `arr.map(double)` for higher-order composition.
- **Target lowering.** There is no direct MQL analogue, because MongoDB has no first-class functions. Support would have to inline the function at its eventual call site, which needs the compiler to track the function value through the expression tree.
- **Why blocked.** An MQL expression cannot carry a function value. The common `arr.map(double)` case is already served by `arr.map(x => double(x))`, an explicit lambda whose body calls the function. A clear rejection message already points to that form.
- **Attempted approaches.** None. The developer's decision left this out of the first cut.
- **Success criteria.** Not yet decided. At minimum, `arr.map(double)` would lower the same way as `arr.map(x => double(x))`.
- **Rejection site(s).** `functionAsValue` in `src/compiler/emit/errors.ts`, tagged `[DEF-032]`, for a DECLARED function read as a value. An arrow read as a value takes a separate, untagged refusal, `lambdaAsValue`.
- **Spec.** `docs/specs/reusable-functions.md` § Deferred.
- **Status.** open
- **Effort.** M

### DEF-038 — A `document` layout for the stages whose output fields are not their body's keys

- **What is blocked.** After `$bucket`, `$bucketAuto` or `$sortByCount` the compiler knows nothing about the document: the three rows state `document: "unknown"`. Their output fields — `_id` and the `output` keys of a bucket, `_id` and `count` of `$sortByCount` — are real and typed, but they are not the keys of the stage's body, so `documentAfter` (`src/compiler/emit/prove.ts`) cannot read them the way it reads a `$group` body. A read after one of them takes the runtime dispatch and the null guard it would take on a field nothing wrote.
- **Target lowering.** A `document` effect that names WHERE the output fields come from, stated on the row: for a bucket, `_id` plus the keys under `output` (each typed by its accumulator, the way `$group` keys are); for `$sortByCount`, `_id` typed by the body expression and `count` as a number. `documentAfter` then builds the closed object from that layout. `$sortByCount($.k); $.n = $.count + 1;` proves `count` a number.
- **Why blocked.** The `DocumentEffect` vocabulary is a closed set of words. A layout is a small structure, and the right shape — one word per stage, or a `{ fields: … }` object — deserves a decision of its own rather than a special case per name.
- **Attempted approaches.** None.
- **Success criteria.** The three rows state a layout; `$sortByCount($.k); $.t = $.count ? 1 : 2;` emits `{ $cond: { if: "$count", … } }`; [test/compiler-types.test.ts](../test/compiler-types.test.ts) runs each stage on the fixture and asserts the typed read.
- **Rejection site(s).** None. The compiler emits valid MQL after each stage. The live `[DEF-038]` tags are on the three rows in [src/registry/names.ts](../src/registry/names.ts), on the `DocumentEffect` comment in [src/registry/vocabulary.ts](../src/registry/vocabulary.ts), and in [docs/specs/types.md](specs/types.md) § The document after a stage.
- **Spec.** [docs/specs/types.md](specs/types.md) § The document after a stage.
- **Status.** design-only
- **Effort.** S

---

## §B. Decisions — will not implement (rejected as bad DX or unnecessary)

This section records features the project considered and **rejected**. Each entry keeps the rationale, so the project does not reconsider the idea blindly in the future.

### Projection-aware translation in `$project` body (`.slice` / `.some` → projection-form operators)

This was DEF-007. The idea was to make `.slice()` / `.some()` lower to the *projection-form* `$slice` (single argument) and `$elemMatch`, inside `$project({ … })`. The premise is wrong. JSMQL's `$project` is the **aggregation pipeline stage**, not a `find()` projection. The projection-form operators work only in a `find()` projection, and the aggregation stage rejects them. Verified against a running mongod (2026-06-11):

- `{ $slice: N }` (single argument) fails with `Expression $slice takes at least 2 arguments, … but 1 were passed`. In an aggregation `$project`, `$slice` is always the expression operator.
- `{ $elemMatch: { … } }` fails with `Cannot use $elemMatch in this context`. `$elemMatch` is not an aggregation operator at all. Even where it is valid, in a `find()` projection, it returns the *matched element*, not a boolean, so it would break the JavaScript meaning of `.some()`.

The expression forms that JSMQL already emits run correctly in `$project`: `$.items.slice(0, 3)` becomes `{ $slice: ["$items", 3] }`, and `$.items.some(i => i.x > 5)` becomes `{ $anyElementTrue: { $map: … } }`. The third proposed switch, `$meta`, already ships as a row in `src/registry/names.ts`. It is a normal aggregation expression, reachable through `$op($meta("textScore"))`. So there was nothing valid left to build. Building it would have made JSMQL knowingly emit invalid MQL, an HR3 violation.

### "From the end" array methods on a document STREAM (`.takeRight` / `.dropRight` / `.initial` / `.toReversed`)

The developer rejected this. MongoDB has no stage that reverses a stream. `$reverseArray` is an *expression*, for an array inside a document, not for a stream. A stream carries no order except the order a `$sort` gives it, so "the last n" has nothing to count back from.

The only possible design is also the argument against the feature. All four methods would need to reach back and rewrite the **preceding** `$sort`. That rewrite:

- makes the method **position-dependent**, in a way the JavaScript method of the same name never is. `.takeRight(3)` would mean a different thing depending on which stage came before it.
- **silently orders by `_id`** when no `$sort` comes before it, instead of raising an error. This gives a wrong answer with no diagnostic: `$$.shuffle().takeRight(3)` would return the last 3 documents by `_id` and discard the shuffle entirely.
- makes `.toSorted(c).toReversed()` a second, longer spelling for a descending comparator. This is the "which spelling does my codebase use?" problem this section rejects elsewhere (see `feedback_no_silent_output_drift.md` in user memory).

**Not** rejected in value position. `$.items.takeRight(3)` becomes `$slice`, `$.items.toReversed()` becomes `$reverseArray`, and the rest of that family still ships. A stored array carries its own order, so there each method means exactly what it means in JavaScript. The distinction is the receiver, not the method.

The stream rewrite is to state the order and take from the front: `$$.toSorted({ createdAt: -1 }).take(3)`. Each row's own stream refusal in `src/registry/names.ts` names this rewrite. The refusal reaches every chain-assembly site, including a foreign chain, so a developer cannot fall back quietly to value mode and slice the tail of an array whose order came from the foreign scan.

Reconsider this only if MongoDB adds a stream-reversing stage. A new implementation over the existing `$sort` machinery would land back on the same two defects.

### CLI `-S` / `--sort-keys`

A key-sorting flag has no safe use here. MQL is order-sensitive in places: a `$project` or `$addFields` computed field can reference an earlier sibling, and stage-body key order can matter. So sorting object keys could silently change the meaning. The `jsmql` CLI prints keys in the order the compiler emits them. This follows the same "no silent output drift" principle behind the §A/§B negation and `$let`-peephole decisions (see `feedback_no_silent_output_drift.md` in user memory). See `docs/specs/cli.md`.

### `!expr` via De Morgan in `$match`

Negation has subtle null/missing interactions in MongoDB. A silent flip between an index and no index, driven only by data shape, is exactly the surprise JSMQL exists to prevent. `!expr` itself lowers to the query language's own negation, `$nor`. What is rejected is DISTRIBUTING the negation into each clause. `$op($not, …)` stays as the explicit escape. See [`docs/specs/emit-pass.md`](specs/emit-pass.md) § The filter target, and `feedback_no_silent_output_drift.md` in user memory for the broader principle.

### Spreading a STRING into its characters (`[..."abc"]`)

JavaScript spreads a string into one element per character. `[..."abc"]` is `["a","b","c"]`, and `{ ..."ab" }` is `{ 0: "a", 1: "b" }`. MongoDB has no operator that does this. `$concatArrays` takes only arrays, and `$mergeObjects` takes only documents, so there is nothing to lower the spread to.

Emitting the string unchanged is worse than a refusal. `[..."abc"]` would silently answer the bare string `"abc"`, with no error at compile time or run time. Where a sibling element follows, the server instead refuses the emitted `{ "$concatArrays": ["abc", ["d"]] }`. This is the same wrong shape, found later.

So the compiler refuses the spread wherever the operand is PROVABLY a string: a string literal, or an expression whose row measures a string return. A field path proves nothing, so `[...$.s]` still compiles. The compiler cannot know the type there, so the server answers instead. The refusal names the spelling that does produce the characters: `$range(0, <string>.length()).map(i => <string>.charAt(i))`. This reads one code point at a time, so it agrees with JavaScript on a multi-byte character.

Reconsider only if MongoDB gains a string-to-array operator.

### `$let`-as-optimisation (peephole)

When a downstream expression reads a `let` exactly once, with no reshape between, the compiler *could* emit a single `$let` instead of `$set` / `$unset`. Rejected: the same input would produce a different stage shape, driven by a downstream-reshape heuristic. That is exactly the surprise JSMQL avoids. A user who needs `$let` writes `$op($let, …)` explicitly.

### Compile-time validation of runtime-dependent pipeline constraints

The pre-flight validator (`docs/specs/emit-pass.md`) throws only on a violation that is 100% certain from the source. A whole class of server-enforced constraint depends on runtime state the compiler cannot know:

- sharding (`$out` to a sharded collection, `$unionWith` inside `$lookup` on a sharded `coll`)
- transactions
- view definitions
- memory limits (`$group` / `$sort` / `$bucket` past 100 MB without `allowDiskUse`, or a document past the 16 MB BSON limit)
- collection type (`$out` needs a non-capped collection, `$merge` needs a non-time-series collection)
- read concern
- Atlas availability of `$search`, `$searchMeta`, `$vectorSearch`, and `$listSearchIndexes`

JSMQL emits the MQL unchanged for all of these, and lets the server decide. Validating them at compile time would need a model of deployment and data state, and would force a throw on a pipeline that is perfectly valid in another context. Rule #1 forbids exactly this: a throw on the *probable*, not the *certain*. Position rules that happen to involve an Atlas-only stage still apply — for example, `$search` must come first. Only the availability check is skipped.

### `$replaceRoot` verbose-form knob on `$ = …`

The lean `$replaceWith` shape is correct for the `$ = …` sugar. A knob that opts into the verbose, 4.0-compatible `$replaceRoot({ newRoot: … })` form would add API surface for no gain. A user who needs that shape writes the stage call directly.

### Wrapping nested-operator `$`-strings ("Model A")

When a stage value is itself an operator call, for example `$project({ t: $concat("$a", "$b") })`, the `$`-string arguments pass through verbatim: `{ $concat: ["$a", "$b"] }`. They are NOT `$literal`-wrapped. The project considered an alternative, "Model A": an operator call wraps its `$`-string arguments, so only *direct* stage-spec values pass through. Rejected: it makes the same `$op("$x")` call mean a different thing at each nesting depth, and it breaks the "paste raw MQL and it round-trips" property. **HR1 (added later) settled this globally**: a source-typed `$`-string passes through in *every* context — pipeline, stage, and `jsmql.expr` alike. So there is no nesting-dependent or surface-dependent wrap at all. Only a runtime-injected value wraps. See [docs/LANG_RULES.md](LANG_RULES.md) (HR1).

### lodash Array / Collection methods with no clean MQL form

Value mode covers the lodash Array and Collection vocabulary that maps cleanly to MQL: the positional, set-op / `By`, transpose, predicate-run, random, and `sortBy` / `orderBy` families. The project **considered and rejected** the methods below (developer-approved 2026-07-18). Each one gets the standard unknown-method error, except `unzipWith`, which carries a tailored hint (see below). `didYouMean` supplies a suggestion when a supported name is close enough, so none of these needs a rejection site or a `[DEF-NNN]` tag:

- **Mutating** — `pull`, `pullAll`, `pullAllBy`, `pullAllWith`, `pullAt`, `remove`. JSMQL values are immutable expressions, so there is no array to mutate in place. `.without(...)`, `.reject(pred)`, and `.difference(other)` express the same intent, in a functional style.
- **Custom-comparator `*With`** — `differenceWith`, `intersectionWith`, `unionWith`, `uniqWith`, `xorWith`. An arbitrary `(a, b) => bool` comparator has no MQL equivalent, because MongoDB compares by value or key, not by a user callback. The `*By` iteratee variants (`differenceBy`, `uniqBy`, and others) cover the realistic need to compare by a derived key.
- **Deep / recursive** — `flattenDeep`, `flattenDepth`, `flatMapDeep`, `flatMapDepth`, `zipObjectDeep`. A single aggregation expression cannot express unbounded-depth recursion, and a fixed-depth unroll gives poor DX. `.flatten()` handles the one-level case. A property-path key (`zipObjectDeep`) is a pitfall that MQL cannot honour.
- **Binary-search sorted-index** — `sortedIndex`, `sortedIndexBy`, `sortedIndexOf`, `sortedLastIndex`, `sortedLastIndexBy`, `sortedLastIndexOf`. MQL has no binary-search primitive. `$indexOfArray` already scans linearly and backs `.indexOf`, so a "sorted" fast path buys nothing.
- **No MQL meaning** — `forEachRight` (side-effect iteration has no value in a pure expression) and `invokeMap` (it invokes a method by path, per element, but MQL has no runtime method dispatch).
- **`unzipWith`** — its iteratee receives a group whose arity equals the receiver's row count, a value the compiler knows only at run time. A fixed-parameter arrow cannot express this. It carries a tailored error that points at the idiomatic form, `.unzip().map(group => …)`.

### Ambient completion for object-receiver value methods (`.mapValues` / `.pick` / `.omit` / `.invert` / …)

The `@koresar/jsmql/globals` value-method augmentations (developer-approved 2026-07-21) type the lodash value methods onto the built-in `Array<T>` / `String` / `Number` interfaces, so they autocomplete on a concretely-typed receiver. The project deliberately **leaves the object-receiver methods without completion**: `.mapValues`, `.mapKeys`, `.pick`, `.omit`, `.pickBy`, `.omitBy`, `.invert`, `.toPairs`. The only interface to hang them on is `Object`, the base of *every* type, and augmenting it would advertise them, misleadingly, on numbers, strings, arrays, and every other value in a file that imports the module. They stay in `VALUE_METHOD_SKIP.object` in `scripts/generate-globals.mjs`. The methods themselves work in JSMQL exactly as documented; they simply do not surface in IDE completion. Revisit this only if a narrower "plain object" carrier type emerges. For example, once schema threading (DEF-013) can type a document field as a specific object shape, `.pick` / `.omit` on *that* field could complete without the global-`Object` blast radius. See `docs/LANGUAGE.md` § Operator autocomplete and `docs/specs/globals-generation.md` § Value-method augmentations.
