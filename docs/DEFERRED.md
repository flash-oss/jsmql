# DEFERRED — open work items

This file lists open work only: every feature that JSMQL defers or does not yet build. §A rows stay in ID order. A row leaves the file when the item ships. A rejected idea is not open work, so it is an ADR with `Status: Rejected` in [docs/adr/](adr/CLAUDE.md).

This file exists so the project does not forget an open item. Every "not yet supported" / "future work" / "deferred" / "out of scope" marker in the live surface of JSMQL (except historical entries under `docs/DEVLOG/`) must carry a `[DEF-NNN]` tag and have a row below. The drift-protection test in [`test/deferred-coverage.test.ts`](../test/deferred-coverage.test.ts) enforces this in both directions:

- Forward gate: every `[DEF-NNN]` tag must have a matching row here.
- Reverse gate: every row here must have at least one `[DEF-NNN]` tag in the live surface, or the row's status must be `design-only`.
- Untagged-marker gate: every deferral phrase in the live surface must carry a tag, or `test/deferred-allowlist.txt` must list it with a one-line reason. When an allowlist entry no longer matches any phrase, the test fails. So the allowlist shrinks over time and never grows stale.

**Conventions.**
- Tag format: `[DEF-NNN]`, written literally. It may carry a label: `[DEF-013: schema]`. The match regex is `\[DEF-\d{3}\]`.
- When you ship an item, delete its row and strip every `[DEF-NNN]` tag in the same commit.
- When you reject a feature with a "not yet" error, add the row and a tag in the same commit.
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

- **What is blocked.** A `let` binding before an indexable `$match` stops the match from using the index. The compiler could show a warning, but `validate()` has only an error channel, not a warning channel.
- **Target lowering.** No change to the MQL output. `validate()` gains a `warnings` array next to `errors`. Each warning carries `.pos`, `.severity: "warning"`, and a message that names the binding and the index it blocks.
- **Why blocked.** The `ValidationResult` shape needs a new `warnings` array. The project is pre-1.0, so the API is not fixed, and the change is safe. But the project must also decide which other warnings it needs. Candidates include unused bindings, unreachable stages, and deprecated patterns.
- **Attempted approaches.** None.
- **Success criteria.** `jsmql.validate("let id = $.userId; $match($.x > 5);")` returns `{ valid: true, errors: [], warnings: [{ severity: "warning", pos: …, message: "…" }] }`.
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

- **What is blocked.** A chain that reads a lookup's array as a VALUE materialises the `$lookup` in a scratch slot. It leaves a `$set` stage plus the `$unset` stage that clears the slot. The result is two stages. A specialised recogniser could emit one.
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

- **What is blocked.** The compiler rejects `Number.isFinite($.x)`. JSMQL has no syntax for an `Infinity` or `NaN` literal to compare against.
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

- **What is blocked.** A reusable function cannot run inside a **bare Filter** (no `;`, for example `db.coll.find(jsmql("isAdult($)"))`). A function declaration needs a `;`, and that flips the source into Pipeline mode. So a Filter cannot declare or call a function.
- **Target lowering.** A function used in a Filter would need **textual inline** into the predicate. The Filter has no pipeline scope and no `$let` stage to host the binding. The compiler would translate the body into the query language, as if the developer wrote it in place.
- **Why blocked.** A Filter is a single expression with no statement list. To thread a declaration into it, JSMQL needs a separate declaration channel, or a textual-inline pass apart from the pipeline `$let` expansion. The output shape differs from the pipeline form — an inlined body instead of a `$let` — so the design stays separate on purpose.
- **Attempted approaches.** None. The developer asked to record this as the likely next step for Filters.
- **Success criteria.** Not yet decided; it depends on the inline design. `db.coll.find(jsmql("const adult = (p) => p.age >= 18; adult($)"))`, or a Filter-specific syntax, would produce a query document with the body inlined.
- **Rejection site(s).** None. There is no dedicated throw. The parser's general rule covers it: it refuses a declaration outside a pipeline. Only the top level of a pipeline can declare a reusable function.
- **Spec.** `docs/specs/reusable-functions.md` § Deferred.
- **Status.** design-only
- **Effort.** M

### DEF-032 — Higher-order functions (function passed as a value)

- **What is blocked.** A reusable function cannot act as a **value** instead of a call. Examples are `$ = { fn: double }`, and a function reference that you pass to another function, such as `arr.map(double)` for higher-order composition.
- **Target lowering.** There is no direct MQL analogue, because MongoDB has no first-class functions. Support would have to inline the function at its eventual call site, which needs the compiler to track the function value through the expression tree.
- **Why blocked.** An MQL expression cannot carry a function value. The common `arr.map(double)` case is already served by `arr.map(x => double(x))`, an explicit lambda whose body calls the function. A clear rejection message already points to that form.
- **Attempted approaches.** None. The developer's decision left this out of the first cut.
- **Success criteria.** Not yet decided. At minimum, `arr.map(double)` would lower the same way as `arr.map(x => double(x))`.
- **Rejection site(s).** `functionAsValue` in `src/compiler/emit/errors.ts`, tagged `[DEF-032]`, for a DECLARED function read as a value. An arrow read as a value takes a separate, untagged refusal, `lambdaAsValue`.
- **Spec.** `docs/specs/reusable-functions.md` § Deferred.
- **Status.** open
- **Effort.** M

### DEF-038 — A `document` layout for the stages whose output fields are not their body's keys

- **What is blocked.** After `$bucket`, `$bucketAuto` or `$sortByCount` the compiler knows nothing about the document: the three rows state `document: "unknown"`. Their output fields — `_id` and the `output` keys of a bucket, `_id` and `count` of `$sortByCount` — are real and typed. They are not the keys of the stage's body, so `documentAfter` (`src/compiler/emit/prove.ts`) cannot read them the way it reads a `$group` body. A read after one of them takes the runtime dispatch and the null guard it would take on a field nothing wrote.
- **Target lowering.** A `document` effect that names WHERE the output fields come from, stated on the row: for a bucket, `_id` plus the keys under `output` (each typed by its accumulator, the way `$group` keys are); for `$sortByCount`, `_id` typed by the body expression and `count` as a number. `documentAfter` then builds the closed object from that layout. `$sortByCount($.k); $.n = $.count + 1;` proves `count` a number.
- **Why blocked.** The `DocumentEffect` vocabulary is a closed set of words. A layout is a small structure. The right shape, one word per stage or a `{ fields: … }` object, deserves a decision of its own instead of a special case per name.
- **Attempted approaches.** None.
- **Success criteria.** The three rows state a layout; `$sortByCount($.k); $.t = $.count ? 1 : 2;` emits `{ $cond: { if: "$count", … } }`; [test/compiler-types.test.ts](../test/compiler-types.test.ts) runs each stage on the fixture and asserts the typed read.
- **Rejection site(s).** None. The compiler emits valid MQL after each stage. The live `[DEF-038]` tags are on the three rows in [src/registry/names.ts](../src/registry/names.ts), on the `DocumentEffect` comment in [src/registry/vocabulary.ts](../src/registry/vocabulary.ts), and in [docs/specs/types.md](specs/types.md) § The document after a stage.
- **Spec.** [docs/specs/types.md](specs/types.md) § The document after a stage.
- **Status.** design-only
- **Effort.** S

### DEF-039 — `.shuffle()` on an ARRAY value

- **What is blocked.** `.shuffle()` is a stream link: `$$.shuffle();` stamps a `$rand` key, sorts on it and drops it. On an array value — `$.a.shuffle()`, lodash's `_.shuffle(array)` — the row states no value cell, so the compiler refuses the call. The message names `.sampleSize(n)`, which shuffles and then takes `n`.
- **Target lowering.** The `.sampleSize()` cell without the `$slice`: `{ $map: { input: { $sortArray: { input: { $map: { input: <arr>, as: "x", in: { k: { $rand: {} }, v: "$$x" } } }, sortBy: { k: 1 } } }, as: "x", in: "$$x.v" } }`. HR5 reads a missing array as `[]`.
- **Why blocked.** The value form is a small cell, and the developer wants it. No program has asked for it yet; the stream form covers the sampled read through `.sampleSize(n)`.
- **Attempted approaches.** None.
- **Success criteria.** `$.a.shuffle()` compiles to the lowering above; a case in [test/compiler-methods.test.ts](../test/compiler-methods.test.ts) runs it on the fixture and checks that the answer holds the same elements.
- **Rejection site(s).** The `expr` cell of the `shuffle` row in [src/registry/names.ts](../src/registry/names.ts), tagged `[DEF-039]`.
- **Spec.** [docs/specs/emit-pass.md](specs/emit-pass.md) § The method cells.
- **Status.** design-only
- **Effort.** S
