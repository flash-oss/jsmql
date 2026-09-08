# Stream methods — chainable array vocabulary on `$$` / `$$$.<coll>`

## Overview

The `stream` cells of the rows in [src/registry/names.ts](../../src/registry/names.ts) are the
single source of truth for the chainable JS-array-shaped methods that may follow a
stream receiver — `$$`, `$$$.<coll>`, a callback's third parameter. One cell per
method, stating the stages a link means; the argument rule (`args`) on the same row
is the arity check.

The stream road in [src/compiler/emit/statement.ts](../../src/compiler/emit/statement.ts)
(`streamStages` / `streamLink`) and the join road in
[src/compiler/emit/join.ts](../../src/compiler/emit/join.ts) (`lookupOf`) read the
cells — adding a cell makes the method usable on every head.

This spec is the implementation-facing companion to the user-facing chain
documentation in [docs/LANGUAGE.md](../LANGUAGE.md#stream-methods-chained-after-the-rhs). The
sister specs that handle individual statement-level sugars
([replace-stream-stage.md](./replace-stream-stage.md),
[union-stage.md](./union-stage.md), [lookup-stage.md](./lookup-stage.md))
predate this registry and continue to live where they are; the registry
only governs **chained** methods after one of those sugars has identified
the receiver.

## Where a chain runs

A stream chain is lowered link by link by `streamStages` / `streamLink` in [src/compiler/emit/statement.ts](../../src/compiler/emit/statement.ts): each link asks its row's `stream` cell for the stages it means, base first, and a stage link (`.$match(…)`) goes through the same cell its statement form uses. Three heads reach the same cells:

| Head | Meaning | Where the stages go |
|---|---|---|
| `$$.<chain>;` (`$$ = $$.<chain>;` is the same program with an explicit head) | the ROOT stream, at every depth | the enclosing pipeline |
| `$$$.<coll>.<chain>` | another collection's stream | the `$lookup` body the join road assembles ([lookup-stage.md](lookup-stage.md)); `$$ = $$$.<coll>.<chain>` then unwinds it into the stream, or unions it in when nothing correlates |
| `coll.<chain>` — a callback's third parameter | the inner stream of a body over another collection | that body |

A link whose row has no `stream` cell is refused with the nearest name that has one, and a value terminal (`.length`, `.sum()`, `.map(o => o.total)`) ends the chain: on the root stream a value has no destination and is refused ("… gives it no destination"), on a join it makes the rest of the chain a value over the joined slot. `.filter(p)` / `.reject(p)` may sit at any position, and lower through the filter road ([filter-mode.md](filter-mode.md)) as a `$match` over the stream's own documents, with the parameter as the document.

## The cell

A `stream` cell is a rule on the row, `(in: StageIn) => Stage[]`: it receives the link's arguments and the services a stage lowering may need — `value` (an argument as an expression), `condition` (a callback as a `$match` body), `sortedBy` (the `$sort` the chain emitted last, for `.takeWhile` / `.dropWhile`), `sortSpec`, the group services — and answers with the stages. It states what it emits and refuses nothing the argument rule (`args`) already refuses. A method with no meaning on a stream (`.at(n)`, `.find(p)` on `$$`) states an `unsupported(reason)` cell whose reason names the spelling that works (`.filter(p).take(1)`, `$ = $$$.<coll>.find(…)`).

## Callback spellings — one meaning, one output

**Spelling never changes the emitted MQL.** jsmql accepts the lodash shorthands in value position, so the stream forms accept exactly the same set; a spelling that compiles against `$.arr` but errors against `$$$.<coll>` is a bug. Two equivalence classes, each with a single resolver so no method can drift from the others:

| Slot | Spellings that mean the same thing |
|---|---|
| **Sort key** — `.sortBy` / `.orderBy` | the property string `"cat"`, the equivalent bare-path arrow `d => d.cat`, or a **computed** arrow `d => d.cat.toLowerCase()` (materialised — see below) |
| **Unwind path** — `.flatMap` | the property string `"items"`, or the equivalent bare-path arrow `d => d.items`. No computed form |
| **Group key** — `.groupBy` / `.countBy` / `.keyBy` / `.uniqBy` | the above, **plus** any computed iteratee: `d => d.cat.toLowerCase()`, or a matches shorthand (`{ cat: "a" }` / `["cat", "a"]`, keying on the match boolean, as lodash `_.matches` does) |
| **Predicate** — `.find` / `.filter` / `.reject` (and the `.map` iteratee) | an arrow `o => o.cat === "a"`, a matches-object `{ cat: "a" }`, a property string `"active"`, a `["cat", "a"]` pair |

The shorthands are one desugar rule — `iterateeShorthand` in [src/compiler/passes/desugar.ts](../../src/compiler/passes/desugar.ts) rewrites every shorthand to the arrow it means before any cell runs ([desugar-pass.md](desugar-pass.md)) — and the sort spellings are one service, `sortSpec` / `orderBy` ([src/compiler/emit/sort-spec.ts](../../src/compiler/emit/sort-spec.ts)). Everything downstream asks what an argument **means**, never what type it is: keying on `StringLiteral` is the recurring trap, because it makes `.groupBy(d => d.cat)` and `.groupBy("cat")` two different programs.

**The split is the SLOT, not the method.** `$group._id` is an expression the server evaluates per document, so a computed group key lowers straight into `_id` with **no extra stages**. A `$sort` key has to be a literal field path, so a computed sort key is materialised: the value goes into a scratch slot (`slot()`), the `$sort` names the slot, and the chain's cleanup clears it when the chain closes — never next to the `$sort`, where a following `.takeWhile` reads the sort it follows.

`.flatMap` cannot be materialised the same way, and that is a *semantic* limit rather than a mechanical one: `$unwind` returns each element to a **named** field, so the field name is part of what the user means. Auto-naming it into a scratch slot and clearing it afterwards would silently decide the shape of every downstream document.

Where the object spelling is already claimed it keeps its richer meaning: `.orderBy({ field: dir })` and `.sort`/`.toSorted({ field: dir })` are direction specs, `.groupBy({ _id, … })` is the `$group` body (so `.groupBy` is the one group-keyed method without a matches-object shorthand).

**A collapsing terminal is a key FORM, never a spelling.** `.groupBy(<key>)` collapses to one object and `.groupBy({ _id, … })` does not, so the test is "not an object literal": a recognised-key narrowing broke twice, once on a string key and once on an arrow.

## Registered methods

Per-method rows below describe *lowering*; for which callback spellings a slot accepts, the section above is canonical.

| Method | Args | Lowering | Stages emitted |
|---|---|---|---|
| `.slice(start, end?)` | 1-2 non-negative integer literals; `end >= start` if both present | `$skip` + `$limit` | `$skip: start` (omitted when `start === 0`) + `$limit: end - start` (omitted when `end` is absent) |
| `.concat(...others)` | 1+ args matching the `$$.push(...)` shapes (spread of `$$$.<coll>[.filter(p)]`, inline `{...}` doc, `$$$.<coll>.find(p)`) | `src/compiler/emit/union.ts` (shared with `$$.push`) | One `$unionWith` per arg; consecutive inline docs batch into one `$documents`-form stage |
| `.map(d => <expr>)` / `.map(d => { … ; return <ret> })` | An **expression body** (`d => <expr>`, or a single-`return` block from the `function` form) **or** a stage-free **block body** (`d => { …; return <ret> }`, a pipeline `block` + `ret`; a *stage* inside it is refused by the callback-block rule, which points at `.aggregate`), with **1–3 params** `(element[, index[, collection]])`; `$.<field>` rejected ("use the lambda param"). The **index** (2nd) param may not be *referenced* (no per-doc stream index — `someExpr` over the whole lambda); the **collection** (3rd) param is the sub-stream and only `<coll>.length` is available on it (any other use rejected with a materialised-form redirect). Embedded `$$$.<coll>.find/filter(...)` lookups are supported in both stream contexts. A block with no `return` is rejected; for the full sub-pipeline statement vocabulary (`assert(...)`, `$match(...)`, …) use `.aggregate` and write the reshape as its root-replace `$ = <expr>` | **Expression body:** the callback parameter IS the body's document, so `d.<path>` reads a bare field path; an embedded `$$$.<coll>` read is materialised into a `__jsmql.tmp.<N>` slot ahead of the stage that reads it, and `coll.length` prepends the `$setWindowFields` `$count` the `$$.length` row states. **Inside a correlated `$lookup`** (the `$$ =` pivot / a nested chain / a `$.field = $$$.<coll>…` assign, NOT a flat `$unionWith`): both an expression body and a stage-free block take the SAME road `.aggregate` takes, because an expression body `d => X` is `d => { return X }`. The `return <ret>` becomes the body's own root replacement, the one difference from the `.aggregate` form, and cross-level reads — `$.field` / `$$.length` (root), an enclosing foreign param, an ancestor `<coll>.length` handle, **and an outer-pipeline `let`** declared before the pivot — are captured into the enclosing `$lookup.let` (`jsmql_f0_…` / `jsmql_s0_…` / `jsmql_v0_…`) and merged into that stage's `let` by the join road (see [lookup-stage.md](lookup-stage.md) § Nested reads). The chain's slot allocator is the same one, so a block-internal lookup gets slots distinct from the enclosing lookup's `as`. **On the top-level `$$` stream / a flat `$unionWith`** (no enclosing `$lookup.let` to correlate into) the block + synthetic `$ = ret` lower directly and `$.field` is rejected (use the param) | Expression body: prologue `$lookup` + `$set` pairs for each embedded foreign read, then one `{ $replaceWith: <expr> }`; a leading `$setWindowFields` `$count` when `coll.length` is read. Block body: the block's `let` bindings and nested `$lookup`s, followed by one `{ $replaceWith: <ret> }`. In the `$$$.<coll>.<chain>` context the stages land inside the outer sub-pipeline — inner `$lookup`s correlate against the sub-pipeline's local doc, not any outer-pipeline `let` binding. Clears the let scope (reshape stage) |
| `.sort(<sort>)` / `.toSorted(<sort>)` | A field name (ascending), an array of field names (all ascending), a `{ field: 1 \| -1 \| "asc" \| "desc" }` spec, or a two-param comparator arrow `a.<path> - b.<path>` / `b.<path> - a.<path>` (`\|\|` for compound). `.sort` and `.toSorted` are **equivalent on a stream** — nothing to mutate, both reorder the flow | The one sort reading every row with a sort argument shares (`emit/sort-spec.ts`): a comparator is read as one key per subtraction, and a name / list / spec as one key each, with `1` / `-1` / `"asc"` / `"desc"` all accepted as the direction | One `{ $sort: { … } }` stage; key order preserved from source |
| `.sortBy(<field> \| [fields])` | The lodash ascending-sort alias — one field key, or an array of them. An object arg is rejected (in lodash it's a matches-shorthand, not a direction; the error points at `.orderBy({…})` / `.sort({…})`) | the `sortSpec` service (ascending) | One `{ $sort: { … } }` stage |
| `.orderBy(keys[, orders])` / `.orderBy({ field: dir })` | The lodash multi-key sort. Parallel form: `keys` is a field name or `[fields]`, `orders` a `1 \| -1 \| "asc" \| "desc"` (or an array of them, parallel to the keys; fewer orders than keys ⇒ the rest ascending). Object form: a `{ field: 1 \| -1 \| "asc" \| "desc" }` spec with the directions inline (mirrors `.sort({…})`) — a second `orders` arg is then rejected | `buildOrderByStreamSpec`: an object `keys` → `buildKeySortSpec` (shared with `.sort`/`.toSorted`); otherwise it zips the two parallel args (`fieldNameLiteral` + `sortDirection`) | One `{ $sort: { … } }` stage |
| `.reject(<predicate>)` | `.filter` negated — an arrow (`o => …`), a matches-object, a field name, or a `["field", value]` pair. The `reject` cell: the predicate lambda (an arrow as-is, or the shorthand's desugared arrow), negated — `o => !(<body>)`, lowered through the filter road | One `$match` stage — `{ $nor: [<the predicate's own clause>] }`, the complement of what the predicate means alone. A predicate with no query form keeps its `$expr` INSIDE the `$nor`; the negation is never distributed into the clauses |
| `.takeWhile(<pred>)` / `.dropWhile(<pred>)` | One predicate — the same spellings `.filter` takes (arrow, matches-object, field name, `["field", value]`), a `{ return <expr>; }` block among them (folded by the callback-block rule; a stage inside it is rejected). **Requires a preceding `$sort`** in the chain, from any sort spelling; with none, rejects (never defaults to `_id`) | the cell reads `sortedBy()` — the chain's last `$sort` — for `$setWindowFields.sortBy`; the predicate lowers through `condition` and becomes a running `$max` of `{ $cond: [<pred>, 0, 1] }` over an unbounded-preceding window. The two differ only in `$match` polarity, so they are exact complements | `$setWindowFields` (flag into a `__jsmql.tmp` slot) + `$match: { <slot>: 0 }` for `takeWhile` / `1` for `dropWhile`; slot cleared at chain end |
| `.tail()` | Zero args | — | `$skip: 1` (the stream `.drop(1)`) |
| `.shuffle()` | Zero args | `slot()` for a `__jsmql.tmp.<N>` key; the trailing `$unset: "__jsmql"` clears the residue | `[{ $addFields: { <slot>: { $rand: {} } } }, { $sort: { <slot>: 1 } }, { $unset: <slot> }]` — non-deterministic |
| `.aggregate((o[, i[, coll]]) => { … })` / `.aggregate([{ … }])` | A **block-body arrow** (`(o) => { $stage(...); ... }`, its statements are pipeline stages, NO `return`) or a **stage-array literal** (`[{ $sort: … }, …]`, read as a zero-param block). Params mirror `.map`/`.filter`: 1–3 `(element, index, collection)`; the index is positional-only, the 3rd exposes only `<coll>.length` (the row's `args` rule and its callback-parameter check, one for every head). Foreign fields via `o.<field>` (or raw `"$field"`); `$.<field>` = the outer doc. **This is the only method whose `{ … }` body keeps its stages** — see [lookup-stage.md](lookup-stage.md) § Grammar. On the CURRENT stream (`$$.aggregate(...)`) the block's statements are simply the chain's stages, in every container a `$$` chain reaches — a `$facet` branch (where a branch IS a sub-pipeline, so there is no "write them directly" alternative), the `$$ =` stream, an `$out` RHS, and the bare-statement form. An **uncorrelated** aggregate may be a `$$.push`/`.concat` union source; a correlated one is rejected (`$unionWith` has no `let` slot) | The same block lowering `.map` uses, minus the terminal `return` (no `$replaceWith`). Inside a correlated `$lookup`, a cross-level `$.field` read captures into that stage's `let`; on a flat `$$` chain (no `let` slot to correlate into) a `$.field` ref is rejected in favour of the lambda param, naming `.aggregate` | The block's stages, appended to the surrounding `$lookup.pipeline` (correlated chain), `$unionWith.pipeline` (source-switch), `$facet` branch, or the outer pipeline. Clears the let scope |
| `.flatMap(<key>)` | One field key — the array field to flatten, as a string or an arrow (`d => d.<path>`, including the `{ return d.<path>; }` block, folded by the callback-block rule; a stage inside it is rejected) | the sort-key service resolves either spelling to the dotted path | One `{ $unwind: "$<path>" }` stage. Surrounding fields are preserved (MQL-natural). For JS-faithful "just the elements", chain `.map(d => d.<path>)` after |
| `.take(n)` / `.drop(n)` | One non-negative integer literal | `take` → `$limit` (`take(0)` → an always-false `$match`, since `$limit: 0` is invalid MQL); `drop` → `$skip` (`drop(0)` emits nothing — identity) | One `{ $limit: n }` / `{ $skip: n }` |
| `.sampleSize(n)` | One integer literal ≥ 1 | `$sample` | One `{ $sample: { size: n } }` |
| `.sample()` | Zero args | `$sample` with size 1 (lodash `_.sample`; a pipeline stays a stream, so this is `.sampleSize(1)`) | One `{ $sample: { size: 1 } }` |
| `.groupBy(spec \| "<key>")` | A `$group` body object (**must contain `_id`**; every non-`_id` slot lowers in the group position, so `$addToSet`/`$push`/… take their accumulator form — same as the direct `$group(...)` stage) **or** a bare field name | **Bare-key form** collapses the stream to the lodash object `{ <keyValue>: [docs] }` (`$group` with `$push: "$$ROOT"` → second `$group` gathering `{k, v}` pairs into a scratch slot → `$replaceWith: { $arrayToObject }`); **body form** lowers the object to one `$group` stage, every slot in the group position | Bare key: the three-stage collapse (one output doc). Body: one `{ $group: … }` (a stream of group docs — no lodash analogue for the accumulator form). Both clear the let scope (reshape). *This mirrors value-mode `$.arr.groupBy(...)`, which also returns the object* |
| `.countBy(<key>)` | One field key | Collapses the stream to the lodash object `{ <keyValue>: <count> }` (mirroring value-mode `$.arr.countBy(...)`) — `$group` with `$sum: 1` → second `$group` gathering `{k, v}` pairs into a scratch slot → `$replaceWith: { $arrayToObject }` | The three-stage collapse (one output doc). Clears the let scope. For MongoDB's count-descending `{ _id, count }` stream, write the `$sortByCount("$<field>")` stage directly |
| `.keyBy(<key>)` | One field key | Collapses the stream to the lodash object `{ <keyValue>: <last doc> }` (mirroring value-mode `$.arr.keyBy(...)`) — `$group` with `$last: "$$ROOT"` (last wins) → second `$group` gathering `{k, v}` pairs into a scratch slot → `$replaceWith: { $arrayToObject }` | The three-stage collapse (one output doc). "Last" follows the stream's current order — precede with `.sort(...)` when which-duplicate-wins matters. Clears the let scope |
| `.uniqBy(<key>)` | One field key | `$group` keeping `$first` per key into the reserved `__jsmqlTmp` group slot, then `$replaceWith` to restore it. "First" follows the stream's current order — precede with `.sort(...)` when which-duplicate-wins matters | `{ $group: { _id: "$<field>", __jsmqlTmp: { $first: "$$ROOT" } } }` + `{ $replaceWith: "$__jsmqlTmp" }`. Clears the let scope |
| `.pick([fields])` | One array of field-name strings | The lodash object method, per document. Keeps ONLY the named fields — `_id` is dropped unless named (matching lodash `_.pick` + the value-mode `.pick`) | `{ $project: { <f>: 1, …, _id: 0 } }` (inclusion). Clears the let scope (the `__jsmql` scratch is dropped too) |
| `.omit([fields])` | One array of field-name strings | Drops the named fields, keeps everything else including `_id` (matching lodash `_.omit`) | `{ $project: { <f>: 0, … } }` (exclusion). Keeps the let scope |

Note: the `.map(d => <expr>)` row above also accepts the lodash property
shorthand `.map("<field>")` (≡ `.map(d => d.<field>)`), lowering to
`{ $replaceWith: "$<field>" }`.

Note: `.keyBy` / `.groupBy` / `.countBy` build their object keys through the shared
`stringKeyExpr` helper (`src/compiler/emit/lower.ts`) — `{ $ifNull: [{ $toString: <key> }, "null"] }`
— so a missing/null grouping field coerces to the string `"null"` (matching
`String(null)`) instead of feeding `$arrayToObject` a null key, which the server
rejects. The identical helper is used by the value-mode forms, so both modes agree.
`$toString` still errors on an object/array key — a separate, documented footgun.
Because the key is a string, code that reads it back (`Object.keys(...)`) and joins
on it must cast it to the field's own type first — see the `keyBy`/`groupBy`/`countBy`
footgun in [LANGUAGE.md](../LANGUAGE.md#lodash-array-methods) for the `ObjectId` case.

**`.map` body must be a document.** `.map` lowers to `$replaceWith: <body>`, which
MongoDB requires to be an object root. the `map` row's `streamBody: "document"` fact gates the
body exactly like the `$ = <expr>` guard in
[src/compiler/emit/statement.ts](../../src/compiler/emit/statement.ts): a **provably** non-document body — a `Number`/`String`/`Boolean`/
`Null`/`RegExp`/`Array` literal — is rejected at compile time (parity with `$ = 5`),
applied to both the top-level expression path and the correlated-lookup expression
path (the block paths route through the shared `$ = <expr>` guard). A field ref
/ member access / operator call is **data-dependent** (the field could be a
sub-document) and passes — so `.map("userId")` / `.map(d => d.userId)` emit
`$replaceWith: "$userId"` and, if `userId` is a scalar at runtime, error on the server,
identically to `$ = $.userId`. Arithmetic bodies (`d.a + d.b`) share the same
pre-existing gap as `$ = <expr>` and are not caught (would need type inference jsmql
doesn't do for `$replaceWith`).

A chain link may also be a **pipeline stage** (`$$.$match({…}).$limit(5)`) — stage links interleave with these methods in every container; they are not registry entries and are owned by [aggregation-stages.md](aggregation-stages.md#chained-stage-calls).

`.filter` is handled outside this registry (its predicate translation is shared
with `$unionWith`/`$facet`). It takes any predicate spelling (see § Callback
spellings) and may appear **anywhere** in the chain — as the head or after a
reshaping method (`.flatMap(...).filter(...)`), not only first. `.filter({ userId: $._id })`
lowers to exactly what `.filter(o => o.userId === $._id)` does, indexed basic-form
`$lookup` included.

Future methods (per the planning notes) extend this table — see
[docs/DEVLOG.md](../DEVLOG.md) for the per-commit chronology.

### `.reduce` is intentionally NOT in the registry

In JS, `arr.reduce(...)` returns a single value — scalar, object, or array
depending on the reducer. So `.reduce` is rejected as a chain method (with an
actionable wrap-pattern hint), and what the reducer
returns decides how it's assigned:

- **scalar / object reducer** (one value) — must be **wrapped** into a
  stream-shaped RHS; both wrap forms lower to the same `$group` +
  `$replaceWith` pair through `lowerReduceWrap`.
- **array-returning reducer** (`acc.concat(...)`, seed `[]`) — already an
  array, i.e. a stream, so it's assigned **directly** (unbracketed); see the
  next section. Wrapping it in `[ ]` is rejected.

**Scalar wrap** — one `$$.reduce(...)` per named field:

```js
$$ = [{ <key>: $$.reduce((acc, d) => <scalar-expr>, <literal-init>), … }];
```

**Object reducer** — one `$$.reduce(...)` whose body returns an object literal
naming every accumulator:

```js
$$ = [$$.reduce((acc, d) => ({ ...acc, <key>: <expr>, … }), { <key>: <init>, … })];
```

Both forms are recognised by `detectReduceWrap` (exported from
[src/registry/names.ts](../../src/registry/names.ts)) and produce:

```js
[
  { $group: { _id: null, <key>: { $<op>: <expr> }, … } },
  { $replaceWith: { <key>: "$<key>", … } },  // drops _id
]
```

A small helper `classifyAccumulatorExpr` pattern-matches every per-key body
expression to a MongoDB accumulator. The same supported shapes apply to both
forms — only what counts as "the accumulator reference" differs:

- **Scalar form:** the bare `acc` ParamRef.
- **Object reducer:** `acc.<key>` (MemberAccess on the param), one per
  named entry.

Supported per-key bodies:

| Shape | Lowers to |
|---|---|
| `acc + d.<field>` / `acc.<key> + d.<field>` | `$sum: "$<field>"` |
| `acc + 1` / `acc.<key> + 1` | `$sum: 1` (count documents) |
| `Math.max(acc, d.<field>)` / `Math.max(acc.<key>, d.<field>)` | `$max: "$<field>"` |
| `Math.min(acc, d.<field>)` / `Math.min(acc.<key>, d.<field>)` | `$min: "$<field>"` |
| `acc ?? d.<field>` / `acc.<key> ?? d.<field>` | `$first: "$<field>"` (first non-null value seen) |
| `d.<field>` (body ignores acc — every doc overwrites) | `$last: "$<field>"` |
| `[...acc, d.<field>]` / `[...acc.<key>, d.<field>]` | `$push: "$<field>"` |
| `acc.concat(d.<field>)` / `acc.<key>.concat(d.<field>)` | `$push: "$<field>"` (alt spelling) |

**Object-reducer specifics.** An optional leading `...acc` spread is allowed
as the first body entry (mirrors the JS-idiomatic carry pattern); subsequent
entries must be static `<key>: <expr>` pairs. The init object must declare
the same key set as the body — extra or missing keys on either side throw an
actionable error (in JS this would silently work but mean something
different). Each entry's body must reference `acc.<sameKey>` as the
accumulator side (`total: acc.count + d.amount` is rejected with a
`'Each entry must reference acc.total'` hint, because that's the
constraint that keeps the per-key lowering local).

The `init` value is required for JS-faithfulness but unused in the MQL
lowering (MongoDB accumulators have their own neutral elements). In the
scalar form it must be a literal so a stray `$.<field>` can't sneak through;
in the object-reducer form it's a literal object whose keys define the
accumulator namespace.

Multiple aggregates in either form share **one** `$group` stage. Shapes that
are still not recognised: `$avg` (would need a two-key sum/count dance with
cross-key references), multiplicative accumulators (no MQL counterpart),
`$stdDevPop`/`$stdDevSamp` (no idiomatic JS shape). Write the `$group` stage
by hand for those.

### Dictionary-build reducer wrap → `$group` + `$arrayToObject`

`$$ = [$$.reduce((acc, d) => ({ ...acc, [d.<keyPath>]: <d.<valPath>|d> }), {})];`

The single-computed-key form of the object-returning reducer. Distinct from
the static-key object-reducer above (where the user names every accumulator at
compile time) because here the **keys come from runtime data** — one input
doc, one output entry, both key and value read off the doc. Lowers to:

```js
[
  { $group: { _id: null, __jsmqlTmp: { $push: { k: "$<keyPath>", v: "$<valPath>"|"$$ROOT" } } } },
  { $replaceWith: { $arrayToObject: "$__jsmqlTmp" } }
]
```

Supported body shapes:

| jsmql | MQL output |
|---|---|
| `(acc, d) => ({ ...acc, [d.id]: d.name })` | `{ k: "$id", v: "$name" }` |
| `(acc, d) => ({ ...acc, [d.user.email]: d.score })` | `{ k: "$user.email", v: "$score" }` (nested paths) |
| `(acc, d) => ({ ...acc, [d.id]: d })` | `{ k: "$id", v: "$$ROOT" }` (bare-doc value) |
| `(acc, d) => ({ [d.id]: d.name })` | same as the spread form (the `...acc` is optional, JS-faithful boilerplate) |

The init MUST be `{}` (empty object). Mixed shapes (computed key + static keys
in the same body) fall through to the static-key object-reducer detector,
which surfaces the precise "computed keys aren't supported" error pointing
at the offending entry. Multiple computed-key entries are not supported.

Detection: `detectDictBuildWrap(value)` runs **before** `detectReduceWrap` in
one road because the two detectors' inputs overlap — the dict-build shape
would otherwise hit the static-key error first.

### Array-returning reducer (unbracketed) → `$match` + `$replaceWith`

The third reduce form handles reducers that build a flat array of projected
docs. The reducer is seeded with `[]` and returns an array — a stream — so it
is assigned **directly**, with no surrounding `[ ]`:

```js
$$.reduce((acc, d) => (<cond> ? acc.concat(d.<field>) : acc), []);
//   → [{ $match: <cond translated> }, { $replaceWith: "$<field>" }]

$$.reduce((acc, d) => acc.concat(d.<field>), []);
//   → [{ $replaceWith: "$<field>" }]                     // unconditional map

$$.reduce((acc, d) => (<cond> ? acc.concat(d) : acc), []);
//   → [{ $match: <cond translated> }]                    // filter-only (bare `d`)
```

This form is recognised by `arrayReduceStages` in [src/compiler/emit/statement.ts](../../src/compiler/emit/statement.ts)
(the reducer's shape by `arrayReduceParts` in [src/compiler/emit/reduce-wrap.ts](../../src/compiler/emit/reduce-wrap.ts));
the condition lowers through the filter road — the same road `.filter` uses — with the
parameter as the document, so a `$.<field>` read inside it is the outer document (HR4).

## Error wording

Every rejection branch is co-located with the method's `validate` function so
the wording stays consistent across methods. Two general principles:

- **Name the method explicitly.** `.slice(start[, end]) requires …` beats
  `argument must be a number`.
- **Suggest the actionable alternative.** Negative indices on `.slice` get
  the "non-negative integer literals" message; computed args get the
  "write the literal in source" hint.

A link whose row has no `stream` cell is refused by the stream road with the nearest
name that has one (`didYouMean`); a row that states an `unsupported(reason)` cell
answers with its reason — for the single-element methods (`.find`, `.findLast`, `.at`)
the reason names `.filter(p).take(1)` / `.slice(n, n + 1)`, and for `.find` on
`$$$.<coll>` the join form `$ = $$$.<coll>.find(<pred>)`.

## Adding a method

1. Add the `stream` cell to the method's row in [src/registry/names.ts](../../src/registry/names.ts), stating the stages it emits (`// MEASURED:` where a shape's validity was proved on `mongod`) — or `unsupported(reason)` with the spelling that works.
2. Add a row to the table above with the args / lowering.
3. Add a case to [test/compiler-statement.test.ts](../../test/compiler-statement.test.ts) (the root stream) and [test/compiler-join.test.ts](../../test/compiler-join.test.ts) (a `$$$.<coll>` head), run on `mongod` and compared with JavaScript's answer.
4. Document the method in [docs/LANGUAGE.md](../LANGUAGE.md) and add a [DEVLOG.md](../DEVLOG.md) entry.

A cell that needs what the chain emitted before it reads `sortedBy()` — the last `$sort`'s spec — and never rewrites an earlier stage. `.takeWhile` / `.dropWhile` are the readers, and they show the safe shape: they **read** the sort (never rewrite it) and **refuse** when there is none (never guess one). The contrast is the "from the end" family (§ below), which rewrote the preceding stage AND fell back to `_id` when it was absent — a wrong answer with no diagnostic. Read, don't rewrite; refuse, don't guess.

## Bare-statement stream chains

A `$$`-rooted chain is a statement — this is the spelling to write:

```js
$$.filter(o => o.tier === "gold");
$$.map(d => ({ id: d._id }));
$$.toSorted((a, b) => b.age - a.age).take(10);
```

The assignment form `$$ = $$.<chain>;` is the same program with an explicit head, and lowers identically; it is never the default spelling.
A bare `$$.<chain>;` statement is the stream road (`streamStages` in
[src/compiler/emit/statement.ts](../../src/compiler/emit/statement.ts)): each link's
`stream` cell appends its stages to the enclosing pipeline, in order. `$$.push(…)` and
the diagnostic sources (`$$.indexStats()`) are statement cells of their own rows, so
they keep their meaning. A bare `$$$.<coll>.<chain>;` is refused — a read of another
collection is a value, and the statement gives it no destination.

**The composition guarantee.** Splitting a chain across statements produces the
same MQL as chaining it, which in turn matches the assignment form:

```js
$$.filter(p).map(f);        // ≡
$$.filter(p); $$.map(f);    // ≡
$$ = $$.filter(p).map(f);
```

This holds for *every* method, because a cell reads only its own link and — for
`.takeWhile` / `.dropWhile` — the `$sort` the chain emitted before it, which is the
same stage whether it came from this statement or the one before.

## Deliberately absent: the "from the end" methods

`.takeRight(n)`, `.dropRight(n)`, `.initial()` and `.toReversed()` are **not** stream
methods. MongoDB has no stage that reverses a stream (`$reverseArray` is an
expression, for an array inside a document) and a stream has no order but the one a
`$sort` gives it, so "the last n" has nothing to count back from. The only way to fake
them is to rewrite the preceding `$sort`, which makes them position-dependent in a way
the JS methods are not and, with no `$sort` in front, silently orders by `_id` rather
than erroring. `.toSorted(c).toReversed()` is in any case a longer spelling of writing
the comparator descending.

Each of the four rows states an `unsupported` stream cell, which every head reads —
the root stream, a `$$$.<coll>` chain, a callback's third parameter — so a foreign
chain cannot quietly fall back to slicing the tail of the materialised array, whose
order is whatever the foreign scan produced. The reason names the take-from-the-front
rewrite (`.toSorted({ <field>: -1 }).take(n)`).

All four remain in **value position** on a real array (`$.items.takeRight(3)` →
`$slice`, `$.items.toReversed()` → `$reverseArray`): an array carries its own order,
so there they mean exactly what JS means.

**JS-faithfulness note.** In plain JS `arr.filter(...)` as a statement discards
its result. The bare form gives it "transform the running stream" meaning —
syntactically valid JS (different runtime meaning is allowed; only syntax
errors are not) and consistent with the existing `$$.push(...)` statement sugar.

## The Stage cell is answered for every array-receiver method

A method whose receiver is an array **can** have a stream form, so the grid says it must
carry an answer. There are four, and no fifth:

| Answer | Where |
|---|---|
| a lowering | the row's `stream` cell — the stages the link means |
| a value terminal | a row with a value cell and no stream cell (`.sum()`, `.head()`, `.length`) — the chain ends in a value, which a join reads over its slot and the root stream refuses for want of a destination |
| a written reason | an `unsupported(reason)` stream cell — why this one cannot work on a stream, and what to write instead |

`test/stream-methods.test.ts` fails when an array-receiver method has none of the four, when
a name appears in two of them, or when a reason is too short to be useful.

The reason matters more than the rejection. A generic "not a chainable stream method" list
tells the developer what else exists but never why *this* one is absent, which is the
difference between a rejection and a dead end. A reason that cannot be written convincingly
is a gap announcing itself — that is how `.uniq`, `.sortedUniq` and `.sortedUniqBy` were
found and given lowerings.

The generic list still exists, and is still correct, for a name jsmql does not recognise at
all — a typo has no reason to give, so it gets the vocabulary and a `didYouMean` suggestion.

