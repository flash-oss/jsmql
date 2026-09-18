# DEFERRED — open work items

The single source of truth for everything jsmql currently **refuses, defers, or hasn't built**. §A rows are in id order; a row is deleted when the item ships.

This file is the antidote to "I keep forgetting about them". Every "not yet supported" / "future work" / "deferred" / "out of scope" marker in the live surface of jsmql (excluding historical `DEVLOG.md` entries) MUST carry a `[DEF-NNN]` tag and have a row below. The drift-protection test in [`test/deferred-coverage.test.ts`](../test/deferred-coverage.test.ts) enforces this both ways:

- Forward gate: every `[DEF-NNN]` tag → must have a matching row here.
- Reverse gate: every row here → must be referenced by at least one `[DEF-NNN]` tag in the live surface OR have `status: design-only`.
- Untagged-marker gate: every occurrence of a deferral phrase in the live surface → must carry a tag, OR be listed in `test/deferred-allowlist.txt` (with a one-line reason). Allowlist entries that no longer match any phrase fail the test — so the allowlist shrinks over time and cannot grow stale.

**Conventions.**
- Tag format: `[DEF-NNN]` — literal. Optional human label inside: `[DEF-013: schema]`. Match regex is `\[DEF-\d{3}\]`.
- When you ship an item: delete its row AND strip every `[DEF-NNN]` tag in the same commit.
- When you reject a feature with a "not yet" error: add the row AND a tag in the same commit.
- When a decision is "won't implement": add a row to the §B Decisions section. Don't add a `[DEF-NNN]` tag — the codebase explanation lives in the spec; this file just records that we considered and decided against.
- **Per-row schema.** Every §A row carries these nine fields, in this order: *What's blocked* (the surface the user cannot reach), *Target lowering* (the MQL it would emit), *Why blocked* (what makes it hard), *Attempted approaches*, *Success criteria* (how we know it shipped), *Rejection site(s)* (where the refusal lives, by file and symbol — never a line number in an append-only file), *Spec* (the owning document), *Status* (`open` or `design-only`), *Effort* (S / M / L).
- **Counts** live in [`test/deferred-coverage.test.ts`](../test/deferred-coverage.test.ts), not here — a number in prose is stale on the next row.

---

## §A. Open — to implement

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
- **Target lowering.** New entry point `jsmql.bind({ collection, db })` returns a new callable shaped like `jsmql` (callable + `.compile` + `.validate` + `.expr` + `.filter` + `.pipeline` + `.update`), with `boundCollection` / `boundDb` threaded into `GenerateCtx`. Mongoose plugin uses it automatically with the model's `collection.name`.
- **Why blocked.** Needs a new public-API entry point + a new `GenerateCtx` slot + the resolution rule in `$$.find`/`$$.filter` lowering.
- **Attempted approaches.** None.
- **Success criteria.** `const bound = jsmql.bind({ collection: "users" }); bound("$$.find(u => u.parentId === $._id);")` lowers to `$lookup` with `from: "users"`.
- **Rejection site(s).** None — the API simply does not exist. The one live `[DEF-013]` tag is in [`docs/LANGUAGE.md`](LANGUAGE.md), on the `$$.find(…)` self-join bullet.
- **Spec.** `docs/specs/context-references.md` § Future work bullet 1–2. Will need its own `docs/specs/bind.md`.
- **Status.** design-only
- **Effort.** L

### DEF-014 — Optimised chained terminals on lookups

- **What's blocked.** A chain that reads a lookup's array as a VALUE materialises the `$lookup` into a scratch slot and leaves a `$set` plus the `$unset` that clears the slot. The residue is two stages where a specialised recogniser could emit one.
- **Target lowering.** A recogniser on the join road (`joinValue` in `src/compiler/emit/join.ts`) that folds the slot read into the `$lookup` for the shapes where it can.
- **Why blocked.** Performance optimisation, not correctness. Needs careful pattern enumeration so we don't break the generic path.
- **Attempted approaches.** None.
- **Success criteria.** `$.n = $$$.users.filter(u => …).map(u => u.name).at(0);` emits one `$lookup` and nothing else — today it emits the `$lookup`, a `$set` reading the slot, and the `$unset`.
- **Rejection site(s).** None — the compiler emits correct, larger MQL.
- **Spec.** [`docs/specs/lookup-stage.md`](specs/lookup-stage.md) § The join road.
- **Status.** design-only
- **Effort.** M

### DEF-016 — Per-operator return-type narrowing in `globals.ts`

- **What's blocked.** Every generated operator in `src/globals.ts` returns `any`. `$abs($.x)` could return `number`, but doing so interferes with method-chain inference on field refs (`$.foo` is `any`, but `$abs($.foo)` shouldn't suddenly become `number` and reject `.toString()`).
- **Target lowering.** No MQL change. Types only. Need to design the field-ref vs concrete-value boundary carefully.
- **Why blocked.** The interaction with `$.foo : any` is the open problem. Pre-1.0 the types churn freely, so we'd want to land this once.
- **Attempted approaches.** None.
- **Success criteria.** `$abs($.foo)` is `number` in TS but field-ref chains still work.
- **Rejection site(s).** The deferral prose in [`docs/specs/globals-generation.md`](specs/globals-generation.md) § the generated shapes; the `[DEF-016]` tag is in the same file.
- **Spec.** `docs/specs/globals-generation.md`.
- **Status.** design-only
- **Effort.** M

### DEF-022 — `Number.isFinite($.x)` (Infinity / NaN comparison)

- **What's blocked.** `Number.isFinite($.x)` is rejected because jsmql has no syntax for `Infinity` / `NaN` literals to compare against.
- **Target lowering.** Would need both literal-Infinity / literal-NaN escape hatches in the parser and a translation table for the resulting comparisons.
- **Why blocked.** No Infinity/NaN literal in jsmql source, and the lowering would touch every numeric comparison helper. jsmql's output must stay JSON-serialisable, so an emitted literal cannot be a real BSON `NaN` / `±Infinity` (`JSON.stringify(NaN)` is `null`, which would silently become a different comparison) — it has to be synthesised server-side.
- **Attempted approaches.** The comparison half is solved and verified on a live mongod: `{$toDouble: "NaN"}` yields a genuine double NaN, and because MongoDB's `$eq` treats `NaN == NaN` as true (unlike JS), `{$eq: [x, {$toDouble: "NaN"}]}` is an exact NaN test — true for `double` and `decimal` NaN, false for ±Infinity, ±0, the string `"NaN"`, null, missing, `[]`, `{}`. `{$toDouble: "-Infinity"}` gives the other bound (NaN sorts below it, so `{$gt: [x, -Infinity]}` also isolates NaN among numbers). What remains is the source-syntax half and the cost: the same clause measured at +41% on a `$match` when added to `jsBool`, which is why the truthiness rule does not carry it (see the NaN note in `docs/LANGUAGE.md`) — a one-off `Number.isFinite` call would not pay that whole-language price. The existing error message names three workarounds (`$type`, `$convert` sentinel, range guard).
- **Success criteria.** TBD with the literal-escape design.
- **Rejection site(s).** The `Number.isFinite` row in `src/registry/names.ts` — its refusal cells carry the tag.
- **Spec.** None — would need `docs/specs/numeric-edges.md` or similar.
- **Status.** open
- **Effort.** M

### DEF-031 — Function-aware Filters via textual inline

- **What's blocked.** Using a reusable function inside a **bare Filter** (no `;`, e.g. `db.coll.find(jsmql("isAdult($)"))`). A function declaration needs a `;`, which flips the source into Pipeline mode, so a Filter can't currently declare or call one.
- **Target lowering.** A function used in a Filter would have to be **textually inlined** into the predicate (the Filter has no pipeline scope / `$let` stage to host the binding), then translated to the query language as if the body were written in place.
- **Why blocked.** Filters are a single expression with no statement list; threading a declaration in needs either a separate declaration channel or a textual-inline pass distinct from the pipeline `$let` expansion. Output shape differs from the pipeline form (inlined body vs `$let`), so it's a deliberate separate design.
- **Attempted approaches.** None — recorded at the developer's request as the likely next step for Filters.
- **Success criteria.** TBD with the inline design; `db.coll.find(jsmql("const adult = (p) => p.age >= 18; adult($)"))` (or a Filter-specific syntax) produces a query document with the body inlined.
- **Rejection site(s).** None — no bespoke throw. The parser's generic requirement covers it: a declaration outside a pipeline is refused with "declares a reusable function, and a reusable function is declared at the top level of a pipeline".
- **Spec.** `docs/specs/reusable-functions.md` § Deferred.
- **Status.** design-only
- **Effort.** M

### DEF-032 — Higher-order functions (function passed as a value)

- **What's blocked.** Using a reusable function as a **value** rather than calling it — `$ = { fn: double }`, or passing it to another function (`arr.map(double)` as a function reference, higher-order composition).
- **Target lowering.** No direct MQL analogue — MongoDB has no first-class functions. Any support would have to inline at the eventual call site, which requires tracking the function value through the expression tree.
- **Why blocked.** MQL expressions can't carry a function value; the common `arr.map(double)` desire is already served by `arr.map(x => double(x))` (an explicit lambda whose body calls the function). A clear rejection already guides toward that.
- **Attempted approaches.** None — scoped out of the first cut per the developer's call.
- **Success criteria.** TBD; at minimum `arr.map(double)` would lower like `arr.map(x => double(x))`.
- **Rejection site(s).** `functionAsValue` in `src/compiler/emit/errors.ts`, tagged `[DEF-032]` — a DECLARED function read as a value. An arrow read as a value takes `lambdaAsValue`, a separate and untagged refusal.
- **Spec.** `docs/specs/reusable-functions.md` § Deferred.
- **Status.** open
- **Effort.** M

### DEF-036 — `?.` stops the chain

- **What's blocked.** JavaScript stops a full chain at a `?.`. A *chain* is one sequence of reads and calls from a single base: `$.user?.name.trim().length` is one chain of four links. jsmql does not stop. It puts an empty value in place of the missing field at the link that carries the `?.`, and the links after it read that empty value and continue. MEASURED, over a document that holds none of the fields:

  | source | jsmql | JavaScript |
  |---|---|---|
  | `$.o?.keys()` | `[]` | `undefined` |
  | `$.o?.keys().length` | `0` | `undefined` |
  | `$.o?.entries().length` | `0` | `undefined` |
  | `$.a?.map(x => x).length` | `0` | `undefined` |
  | `$.s?.trim().length` | `0` | `undefined` |

  The gap is not about objects. Every receiver family shows it.
- **Target lowering.** A `?.` makes every link AFTER it not run, and the chain answers null. MongoDB has no `undefined` inside an expression, so null stands for it. The developer chose this rule on 2026-09-18, over a wider rule that also nullifies the enclosing expression — a template must keep the text it prints, so `` `hi ${$.user?.name}` `` stays `"hi "` and does not become null. MEASURED on the fixture, each shape gives null for a document without the field and the right value for one with it:
  ```js
  $.o?.keys()          → { $cond: [{ $in: [{ $type: "$o" }, ["missing", "null"]] }, null,
                                    { $map: { input: { $objectToArray: "$o" }, as: "jsmqlKv", in: "$$jsmqlKv.k" } }] }
  $.s?.trim().length   → { $cond: [{ $in: [{ $type: "$s" }, ["missing", "null"]] }, null,
                                    { $strLenCP: { $trim: { input: "$s" } } }] }
  ```
  The `$cond` runs its second branch only when the field is there, so **every inner `$ifNull` on that field goes away**. Today `$.s?.trim().length` guards twice; the target guards once.

  A `?.` with NO link after it does not change. There is nothing to stop, the chain's value is the field itself, and null is what a missing field already gives. So `` `hi ${$.user?.name}` `` and `$.first + " " + $.user?.last` keep the documents and the answers they have today, and the consumer table in `docs/LANGUAGE.md` § Optional Chaining stays as it is.
- **Why blocked.** Each link of a chain lowers on its own, and the compiler builds a chain from the inside out. No link knows that an earlier link carries a `?.`. `chainHasOptional` (`src/compiler/emit/types.ts`) walks `MemberAccess` and `IndexAccess` only — it STOPS at a `MethodCall`, so it answers false for `$.o?.keys().length`. The work needs a walk that goes through a method call's receiver, and a test placed at the top of the chain rather than at the link.
- **Attempted approaches.** None.
- **Success criteria.** Each row of the table above answers `null` on a live mongod. `$.o.keys()` and every lodash method keep the answers they have. `` `hi ${$.user?.name}` `` keeps `"hi "` and its document does not grow. No row emits a `$switch` it did not emit before. [test/compiler-methods.test.ts](../test/compiler-methods.test.ts) holds one case per spelling and compares the server's answer with JavaScript's.
- **Rejection site(s).** None — jsmql emits valid MQL for every spelling. The one live `[DEF-036]` tag is in [docs/LANGUAGE.md](LANGUAGE.md), on the optional-chain rule for a reader of a whole object.
- **Spec.** [docs/specs/emit-pass.md](specs/emit-pass.md) § the optional chain's neutral; `docs/LANGUAGE.md` § Optional Chaining.
- **Status.** design-only
- **Effort.** L

---

## §B. Decisions — won't implement (rejected as bad DX or unnecessary)

This section records features we considered and **decided against**. Recording them prevents future-us from blindly reconsidering — the rationale is preserved.

### Projection-aware translation in `$project` body (`.slice` / `.some` → projection-form operators)

Was DEF-007. The idea was to make `.slice()` / `.some()` lower to *projection-form* `$slice` (single-arg) and `$elemMatch` inside `$project({ … })`. The premise is wrong: jsmql's `$project` is the **aggregation pipeline stage**, not a `find()` projection, and the projection-form operators are `find()`-projection-only features the aggregation stage rejects. Verified against a running mongod (2026-06-11):

- `{ $slice: N }` (single-arg) → `Expression $slice takes at least 2 arguments, … but 1 were passed` — in aggregation `$project`, `$slice` is always the expression operator.
- `{ $elemMatch: { … } }` → `Cannot use $elemMatch in this context` — `$elemMatch` is not an aggregation operator at all. Even where it is valid (`find()` projection), it returns the *matched element*, not a boolean — which would break `.some()`'s JS semantics.

The expression forms jsmql already emits run correctly in `$project`: `$.items.slice(0, 3)` → `{ $slice: ["$items", 3] }` and `$.items.some(i => i.x > 5)` → `{ $anyElementTrue: { $map: … } }`. The third proposed switch, `$meta`, already ships as a row in `src/registry/names.ts` — a normal aggregation expression reachable via `$op($meta("textScore"))`. So there was nothing valid left to build — implementing it would have made jsmql knowingly emit invalid MQL, an HR3 violation.

### "From the end" array methods on a document STREAM (`.takeRight` / `.dropRight` / `.initial` / `.toReversed`)

Rejected by developer decision. MongoDB has no stage that reverses a stream — `$reverseArray` is an *expression*, for an array inside a document — and a stream carries no order except the one a `$sort` gives it, so "the last n" has nothing to count back from.

The only possible implementation is the argument against the feature. All four would have to reach back and rewrite the **preceding** `$sort`, which:

- makes them **position-dependent** in a way the JS methods they are named after never are — `.takeRight(3)` would mean different things depending on which stage happened to precede it;
- **silently orders by `_id`** when no `$sort` precedes, rather than erroring — a wrong answer with no diagnostic: `$$.shuffle().takeRight(3)` would return the last 3 by `_id` and discard the shuffle entirely;
- made `.toSorted(c).toReversed()` a second, longer spelling of writing the comparator descending — the "which spelling does my codebase use?" friction rejected elsewhere in this section (see `feedback_no_silent_output_drift.md` in user memory).

**Not** rejected in value position: `$.items.takeRight(3)` → `$slice`, `$.items.toReversed()` → `$reverseArray` and friends all still ship. A stored array carries its own order, so there the methods mean exactly what they mean in JS. The distinction is the receiver, not the method.

The stream rewrite is to state the order and take from the front — `$$.toSorted({ createdAt: -1 }).take(3)` — which each row's own stream refusal in `src/registry/names.ts` names. It reaches every chain-assembly site, a foreign chain included, so one cannot quietly fall back to value-mode and slice the tail of an array whose order is whatever the foreign scan produced.

Reconsider only if MongoDB adds a stream-reversing stage. A re-implementation over the existing `$sort` machinery would land back on the same two defects.

### CLI `-S` / `--sort-keys`

A key-sorting flag has no safe analogue here: MQL is order-sensitive in places (`$project` / `$addFields` computed fields can reference earlier siblings; stage-body key order can matter), so sorting object keys could silently change meaning. The `jsmql` CLI prints keys in the order the compiler emits them. This is the same "no silent output drift" principle behind the §A/§B negation and `$let`-peephole decisions — see `feedback_no_silent_output_drift.md` in user memory. Documented in `docs/specs/cli.md`.

### `!expr` via De Morgan in `$match`

Negation has subtle null/missing interactions in MongoDB. A silent index/non-index flip driven by data shape is exactly the surprise jsmql exists to prevent. `!expr` itself lowers to the query language's own negation, `$nor`; what is rejected is DISTRIBUTING the negation into each clause. `$op($not, …)` stays as the explicit escape. Documented in [`docs/specs/emit-pass.md`](specs/emit-pass.md) § The filter target. See `feedback_no_silent_output_drift.md` in user memory for the broader principle.

### Spreading a STRING into its characters (`[..."abc"]`)

JavaScript spreads a string into one element per character — `[..."abc"]` is `["a","b","c"]`, and `{ ..."ab" }` is `{ 0: "a", 1: "b" }`. MongoDB has no operator that does it. `$concatArrays` takes arrays only and `$mergeObjects` takes documents only, so there is nothing to lower the spread to.

Emitting the string unchanged is worse than refusing: `[..."abc"]` would answer the bare string `"abc"`, silently, with no error at compile time or run time. Where a sibling element follows, the emitted `{ "$concatArrays": ["abc", ["d"]] }` is refused by the server instead — the same shape, found later.

The spread is therefore refused wherever the operand is PROVABLY a string: a string literal, or an expression whose row measures a string return. A field path proves nothing, so `[...$.s]` still compiles — the compiler cannot know, and the server answers. The refusal names the spelling that does produce the characters, `$range(0, <string>.length).map(i => <string>.charAt(i))`, which reads per code point and so agrees with JavaScript on a multi-byte character.

Reconsider only if MongoDB gains a string-to-array operator.

### `$let`-as-optimisation (peephole)

When a `let` is read in exactly one downstream expression with no reshape between, the compiler *could* emit a single `$let` instead of `$set`/`$unset`. Rejected: the same input producing a different stage shape because of a downstream-reshape heuristic is the surprise jsmql avoids. Users who need `$let` write `$op($let, …)` explicitly.

### Compile-time validation of runtime-dependent pipeline constraints

The pre-flight validator (`docs/specs/emit-pass.md`) throws only on violations that are 100% certain from the source. A whole class of server-enforced constraints depends on runtime state the compiler cannot know — sharding (`$out` to a sharded collection, `$unionWith`-in-`$lookup` on a sharded `coll`), transactions, view definitions, memory limits (`$group`/`$sort`/`$bucket` 100 MB without `allowDiskUse`, BSON 16 MB), collection type (`$out`→capped, `$merge`→time-series), read concern, and Atlas availability of `$search`/`$searchMeta`/`$vectorSearch`/`$listSearchIndexes`. jsmql emits the MQL unchanged for all of these and lets the server decide. Validating them at compile time would require modelling deployment/data state and would force throws on pipelines that are perfectly valid in another context — exactly the *probable*-not-*certain* throw rule #1 forbids. (Position rules that happen to involve an Atlas-only stage — e.g. `$search` must be first — still apply; only the availability check is skipped.)

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
- **No MQL meaning** — `forEachRight` (side-effect iteration, no value in a pure expression) and `invokeMap` (invoke a method by path per element — no runtime method dispatch in MQL).
- **`unzipWith`** — its iteratee receives a group whose arity equals the receiver's row count (runtime-dynamic), which a fixed-parameter arrow can't express. Carries a tailored error pointing at `.unzip().map(group => …)`, the idiomatic form.

### Ambient completion for object-receiver value methods (`.mapValues` / `.pick` / `.omit` / `.invert` / …)

The `@koresar/jsmql/globals` value-method augmentations (developer-approved 2026-07-21) type the lodash value methods onto the built-in `Array<T>` / `String` / `Number` interfaces so they autocomplete on concretely-typed receivers. The **object-receiver** methods (`.mapValues`, `.mapKeys`, `.pick`, `.omit`, `.pickBy`, `.omitBy`, `.invert`, `.toPairs`) are deliberately **left without completion**: the only interface to hang them on is `Object`, the base of *every* type, so augmenting it would advertise them (misleadingly) on numbers, strings, arrays, and every other value in files that import the module. They stay in `VALUE_METHOD_SKIP.object` in `scripts/generate-globals.mjs`. The methods themselves work in jsmql exactly as documented — they simply don't surface in IDE completion. Revisit only if a narrower "plain object" carrier type emerges (e.g. once schema threading — DEF-013 — can type a document field as a specific object shape, `.pick`/`.omit` on *that* field could complete without the global-`Object` blast radius). Documented in `docs/LANGUAGE.md` § Operator autocomplete and `docs/specs/globals-generation.md` § Value-method augmentations.
