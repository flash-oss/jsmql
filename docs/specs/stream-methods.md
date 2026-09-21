# Stream methods — chainable array vocabulary on `$$` / `$$$.<coll>`

## Overview

The `stream` cells of the rows in [src/registry/names.ts](../../src/registry/names.ts) are the
single source of truth for the chainable JS-array methods that may follow a
stream receiver — `$$`, `$$$.<coll>`, or a callback's third parameter. Each row
has one cell per method. The cell states the stages a link means. The argument
rule (`args`) on the same row is the arity check.

The stream road in [src/compiler/emit/statement.ts](../../src/compiler/emit/statement.ts)
(`streamStages` / `streamLink`) and the join road in
[src/compiler/emit/join.ts](../../src/compiler/emit/join.ts) (`lookupOf`) read the
cells. A new cell makes its method usable on every head.

This spec is the implementation-facing companion to the user-facing chain
documentation in [docs/LANGUAGE.md](../LANGUAGE.md#stream-methods-chained-after-the-rhs). The
sister specs that handle individual statement-level sugars
([replace-stream-stage.md](./replace-stream-stage.md),
[union-stage.md](./union-stage.md), [lookup-stage.md](./lookup-stage.md))
predate this registry and stay where they are. The registry
governs only **chained** methods, after one of those sugars has identified
the receiver.

## Where a chain runs

`streamStages` / `streamLink` in [src/compiler/emit/statement.ts](../../src/compiler/emit/statement.ts) lower a stream chain link by link. Each link asks its row's `stream` cell for the stages it means, base first. A stage link (`.$match(…)`) goes through the same cell its statement form uses. Three heads reach the same cells:

| Head | Meaning | Where the stages go |
|---|---|---|
| `$$.<chain>;` (`$$ = $$.<chain>;` is the same program with an explicit head) | the ROOT stream, at every depth | the enclosing pipeline |
| `$$$.<coll>.<chain>` | another collection's stream | the `$lookup` body the join road assembles ([lookup-stage.md](lookup-stage.md)); `$$ = $$$.<coll>.<chain>` then unwinds it into the stream, or unions it in when nothing correlates |
| `coll.<chain>` — a callback's third parameter | the inner stream of a body over another collection | that body |

A link whose row has no `stream` cell is refused with the nearest name that has one. A value terminal (`.length`, `.sum()`, `.map(o => o.total)`) ends the chain: on the root stream a value has no destination, so it is refused ("… gives it no destination"); on a join it makes the rest of the chain a value over the joined slot. `.filter(p)` / `.reject(p)` may sit at any position. Both lower through the filter road ([filter-mode.md](filter-mode.md)) as a `$match` over the stream's own documents, with the parameter as the document.

## The cell

A `stream` cell is a rule on the row, `(in: StageIn) => Stage[]`. It receives the link's arguments and the services a stage lowering may need — `value` (an argument as an expression), `condition` (a callback as a `$match` body), `sortedBy` (the `$sort` the chain emitted last, for `.takeWhile` / `.dropWhile`), `sortSpec`, and the group services — and it answers with the stages. It states what it emits and does not refuse anything the argument rule (`args`) already refuses. A method with no meaning on a stream (`.at(n)`, `.find(p)` on `$$`) has an `unsupported(reason)` cell instead. Its reason names the spelling that works (`.filter(p).take(1)`, `$ = $$$.<coll>.find(…)`).

## Callback spellings — one meaning, one output

**Spelling never changes the emitted MQL.** JSMQL accepts the lodash shorthands in value position, so the stream forms accept exactly the same set. A spelling that compiles against `$.arr` but errors against `$$$.<coll>` is a bug. There are two equivalence classes. Each has a single resolver, so no method can drift from the others:

| Slot | Spellings that mean the same thing |
|---|---|
| **Sort key** — `.sortBy` / `.orderBy` | the property string `"cat"`, the equivalent bare-path arrow `d => d.cat`, or a **computed** arrow `d => d.cat.toLowerCase()` (materialised — see below) |
| **Unwind path** — `.flatMap` | the property string `"items"`, or the equivalent bare-path arrow `d => d.items`. No computed form |
| **Group key** — `.groupBy` / `.countBy` / `.keyBy` / `.uniqBy` | the above, **plus** any computed iteratee: `d => d.cat.toLowerCase()`, or a matches shorthand (`{ cat: "a" }` / `["cat", "a"]`, keying on the match boolean, as lodash `_.matches` does) |
| **Predicate** — `.find` / `.filter` / `.reject` (and the `.map` iteratee) | an arrow `o => o.cat === "a"`, a matches-object `{ cat: "a" }`, a property string `"active"`, a `["cat", "a"]` pair |

The shorthands are one desugar rule. `iterateeShorthand` in [src/compiler/passes/desugar.ts](../../src/compiler/passes/desugar.ts) rewrites every shorthand to the arrow it means, before any cell runs ([desugar-pass.md](desugar-pass.md)). The sort spellings are one service, `sortSpec` / `orderBy` ([src/compiler/emit/sort-spec.ts](../../src/compiler/emit/sort-spec.ts)). Everything downstream asks what an argument **means**, never what type it is. Keying on `StringLiteral` is the recurring trap, because it makes `.groupBy(d => d.cat)` and `.groupBy("cat")` two different programs.

**The split is the SLOT, not the method.** `$group._id` is an expression the server evaluates per document, so a computed group key lowers straight into `_id`, with **no extra stages**. A `$sort` key must be a literal field path, so the compiler materialises a computed sort key: the value goes into a scratch slot (`slot()`), the `$sort` names the slot, and the chain's cleanup clears the slot when the chain closes. The cleanup never sits next to the `$sort`, because a following `.takeWhile` reads the sort it follows.

`.flatMap` cannot be materialised the same way. This is a *semantic* limit, not a mechanical one: `$unwind` returns each element to a **named** field, so the field name is part of what the user means. Auto-naming it into a scratch slot, then clearing the slot afterwards, would silently decide the shape of every downstream document.

Where the object spelling is already claimed, it keeps its richer meaning: `.orderBy({ field: dir })` and `.sort`/`.toSorted({ field: dir })` are direction specs, and `.groupBy({ _id, … })` is the `$group` body. So `.groupBy` is the one group-keyed method with no matches-object shorthand.

**A collapsing terminal is a key FORM, never a spelling.** `.groupBy(<key>)` collapses to one object, and `.groupBy({ _id, … })` does not. So the test is "not an object literal". A narrowing that instead recognises key spellings misses a string key and an arrow, both of which are keys.

## Registered methods

Each row below describes *lowering*. For the callback spellings a slot accepts, the section above is canonical.

| Method | Args | Lowering | Stages emitted |
|---|---|---|---|
| `.slice(start, end?)` | 1-2 non-negative integer literals; `end >= start` if both present | `$skip` + `$limit` | `$skip: start` (omitted when `start === 0`) + `$limit: end - start` (omitted when `end` is absent) |
| `.concat(...others)` | 1+ args matching the `$$.push(...)` shapes (spread of `$$$.<coll>[.filter(p)]`, inline `{...}` doc, `$$$.<coll>.find(p)`) | `src/compiler/emit/union.ts` (shared with `$$.push`) | One `$unionWith` per arg; consecutive inline docs batch into one `$documents`-form stage |
| `.map(d => <expr>)` / `.map(d => { … ; return <ret> })` | An **expression body** (`d => <expr>`, or a single-`return` block from the `function` form) **or** a stage-free **block body** (`d => { …; return <ret> }`, a pipeline `block` + `ret`; the callback-block rule refuses a *stage* inside it and points to `.aggregate`), with **1–3 params** `(element[, index[, collection]])`; `$.<field>` rejected ("use the lambda param"). The **index** (2nd) param cannot be referenced (no per-doc stream index — `someExpr` acts over the whole lambda); the **collection** (3rd) param is the sub-stream, and only `<coll>.length` is available on it (any other use rejected with a materialised-form redirect). Both stream contexts support embedded `$$$.<coll>.find/filter(...)` lookups. JSMQL rejects a block with no `return`; for the full sub-pipeline statement vocabulary (`assert(...)`, `$match(...)`, …) use `.aggregate` and write the reshape as its root-replace `$ = <expr>` | **Expression body:** the callback parameter IS the body's document, so `d.<path>` reads a bare field path; an embedded `$$$.<coll>` read is materialised into a `__jsmql.tmp.<N>` slot ahead of the stage that reads it, and `coll.length` prepends the `$setWindowFields` `$count` the `$$.length` row states. **Inside a correlated `$lookup`** (the `$$ =` pivot / a nested chain / a `$.field = $$$.<coll>…` assign, NOT a flat `$unionWith`): both an expression body and a stage-free block take the SAME road `.aggregate` takes, because an expression body `d => X` is `d => { return X }`. The `return <ret>` becomes the body's own root replacement, the one difference from the `.aggregate` form, and cross-level reads — `$.field` / `$$.length` (root), an enclosing foreign param, an ancestor `<coll>.length` handle, **and an outer-pipeline `let`** declared before the pivot — are captured into the enclosing `$lookup.let` (`jsmql_f0_…` / `jsmql_s0_…` / `jsmql_v0_…`) and merged into that stage's `let` by the join road (see [lookup-stage.md](lookup-stage.md) § Nested reads). The chain's slot allocator is the same one, so a block-internal lookup gets slots distinct from the enclosing lookup's `as`. **On the top-level `$$` stream / a flat `$unionWith`** (no enclosing `$lookup.let` to correlate into) the block + synthetic `$ = ret` lower directly and `$.field` is rejected (use the param) | Expression body: prologue `$lookup` + `$set` pairs for each embedded foreign read, then one `{ $replaceWith: <expr> }`; a leading `$setWindowFields` `$count` when the code reads `coll.length`. Block body: the block's `let` bindings and nested `$lookup`s, followed by one `{ $replaceWith: <ret> }`. In the `$$$.<coll>.<chain>` context the stages land inside the outer sub-pipeline — inner `$lookup`s correlate against the sub-pipeline's local doc, not any outer-pipeline `let` binding. Clears the let scope (reshape stage) |
| `.sort(<sort>)` / `.toSorted(<sort>)` | A field name (ascending), an array of field names (all ascending), a `{ field: 1 \| -1 \| "asc" \| "desc" }` spec, or a two-param comparator arrow `a.<path> - b.<path>` / `b.<path> - a.<path>` (`\|\|` for compound). `.sort` and `.toSorted` are **equivalent on a stream** — nothing to mutate, both reorder the flow | The one sort reading every row with a sort argument shares (`emit/sort-spec.ts`): a comparator is read as one key per subtraction, and a name / list / spec as one key each, with `1` / `-1` / `"asc"` / `"desc"` all accepted as the direction | One `{ $sort: { … } }` stage; the stage keeps the key order from the source |
| `.sortBy(<field> \| [fields])` | The lodash ascending-sort alias — one field key, or an array of them. JSMQL rejects an object argument (in lodash it is a matches-shorthand, not a direction; the error points at `.orderBy({…})` / `.sort({…})`) | the `sortSpec` service (ascending) | One `{ $sort: { … } }` stage |
| `.orderBy(keys[, orders])` / `.orderBy({ field: dir })` | The lodash multi-key sort. Parallel form: `keys` is a field name or `[fields]`, `orders` a `1 \| -1 \| "asc" \| "desc"` (or an array of them, parallel to the keys; fewer orders than keys ⇒ the rest ascending). Object form: a `{ field: 1 \| -1 \| "asc" \| "desc" }` spec with the directions inline (mirrors `.sort({…})`) — JSMQL then rejects a second `orders` argument | `buildOrderByStreamSpec`: an object `keys` → `buildKeySortSpec` (shared with `.sort`/`.toSorted`); otherwise it zips the two parallel args (`fieldNameLiteral` + `sortDirection`) | One `{ $sort: { … } }` stage |
| `.reject(<predicate>)` | `.filter` negated — an arrow (`o => …`), a matches-object, a field name, or a `["field", value]` pair. The `reject` cell: the predicate lambda (an arrow as-is, or the shorthand's desugared arrow), negated — `o => !(<body>)`, lowered through the filter road | One `$match` stage — `{ $nor: [<the predicate's own clause>] }`, the complement of what the predicate means alone. A predicate with no query form keeps its `$expr` INSIDE the `$nor`; JSMQL never distributes the negation into the clauses |
| `.takeWhile(<pred>)` / `.dropWhile(<pred>)` | One predicate — the same spellings `.filter` takes (arrow, matches-object, field name, `["field", value]`), a `{ return <expr>; }` block among them (the callback-block rule folds it; JSMQL rejects a stage inside it). **Requires a preceding `$sort`** in the chain, from any sort spelling; with none, rejects (never defaults to `_id`) | the cell reads `sortedBy()` — the chain's last `$sort` — for `$setWindowFields.sortBy`; the predicate lowers through `condition` and becomes a running `$max` of `{ $cond: [<pred>, 0, 1] }` over an unbounded-preceding window. The two differ only in `$match` polarity, so they are exact complements | `$setWindowFields` (flag into a `__jsmql.tmp` slot) + `$match: { <slot>: 0 }` for `takeWhile` / `1` for `dropWhile`; slot cleared at chain end |
| `.tail()` | Zero args | — | `$skip: 1` (the stream `.drop(1)`) |
| `.shuffle()` | Zero args | `slot()` for a `__jsmql.tmp.<N>` key; the trailing `$unset: "__jsmql"` clears the residue | `[{ $addFields: { <slot>: { $rand: {} } } }, { $sort: { <slot>: 1 } }, { $unset: <slot> }]` — non-deterministic |
| `.aggregate((o[, i[, coll]]) => { … })` / `.aggregate([{ … }])` | A **block-body arrow** (`(o) => { $stage(...); ... }`, its statements are pipeline stages, NO `return`) or a **stage-array literal** (`[{ $sort: … }, …]`, read as a zero-param block). Params mirror `.map`/`.filter`: 1–3 `(element, index, collection)`; the index is positional-only, the 3rd exposes only `<coll>.length` (the row's `args` rule and its callback-parameter check, one for every head). Foreign fields via `o.<field>` (or raw `"$field"`); `$.<field>` = the outer doc. **This is the only method whose `{ … }` body keeps its stages** — see [lookup-stage.md](lookup-stage.md) § Grammar. On the CURRENT stream (`$$.aggregate(...)`) the block's statements are simply the chain's stages, in every container a `$$` chain reaches — a `$facet` branch (where a branch IS a sub-pipeline, so there is no "write them directly" alternative), the `$$ =` stream, an `$out` RHS, and the bare-statement form. An **uncorrelated** aggregate may be a `$$.push`/`.concat` union source; JSMQL rejects a correlated one (`$unionWith` has no `let` slot) | The same block lowering `.map` uses, minus the terminal `return` (no `$replaceWith`). Inside a correlated `$lookup`, a cross-level `$.field` read captures into that stage's `let`; on a flat `$$` chain (no `let` slot to correlate into) a `$.field` ref is rejected in favour of the lambda param, naming `.aggregate` | The block's stages, appended to the surrounding `$lookup.pipeline` (correlated chain), `$unionWith.pipeline` (source-switch), `$facet` branch, or the outer pipeline. Clears the let scope |
| `.flatMap(<key>)` | One field key — the array field to flatten, as a string or an arrow (`d => d.<path>`, including the `{ return d.<path>; }` block; the callback-block rule folds it, and JSMQL rejects a stage inside it) | `fieldPath(cb)` resolves either spelling to the dotted path; the cell then calls `unwound(path)` so the chain's element moves to that field — see [The element after `.flatMap`](#the-element-after-flatmap) | One `{ $unwind: "$<path>" }` stage. The stage preserves surrounding fields (MQL-natural); every later callback receives the ELEMENT. For "the elements as the documents", chain `.map(item => item)` after |
| `.take(n)` / `.drop(n)` | One non-negative integer literal | `take` → `$limit` (`take(0)` → an always-false `$match`, because `$limit: 0` is invalid MQL); `drop` → `$skip` (`drop(0)` emits nothing — identity) | One `{ $limit: n }` / `{ $skip: n }` |
| `.sampleSize(n)` | One integer literal ≥ 1 | `$sample` | One `{ $sample: { size: n } }` |
| `.sample()` | Zero args | `$sample` with size 1 (lodash `_.sample`; a pipeline stays a stream, so this is `.sampleSize(1)`) | One `{ $sample: { size: 1 } }` |
| `.groupBy(spec \| "<key>")` | A `$group` body object (**must contain `_id`**; every non-`_id` slot lowers in the group position, so `$addToSet`/`$push`/… take their accumulator form — same as the direct `$group(...)` stage) **or** a bare field name, or none (the identity key, as `.countBy`) | **Bare-key form** collapses the stream to the lodash object `{ <keyValue>: [docs] }` (`$group` with `$push: "$$ROOT"` → second `$group` gathering `{k, v}` pairs into a scratch slot → `$replaceWith: { $arrayToObject }`); **body form** lowers the object to one `$group` stage, every slot in the group position | Bare key: the three-stage collapse (one output doc). Body: one `{ $group: … }` (a stream of group docs — no lodash analogue for the accumulator form). Both clear the let scope (reshape). *This mirrors value-mode `$.arr.groupBy(...)`, which also returns the object* |
| `.countBy(<key>)` | One field key, or none — the `omitted` slot form: the desugar pass rewrites the missing argument to the identity arrow `x => x`, so the key is the element (`$$ROOT`, or the unwound field after `.flatMap`) | Collapses the stream to the lodash object `{ <keyValue>: <count> }` (mirroring value-mode `$.arr.countBy(...)`) — `$group` with `$sum: 1` → second `$group` gathering `{k, v}` pairs into a scratch slot → `$replaceWith: { $arrayToObject }` | The three-stage collapse (one output doc). Clears the let scope. For MongoDB's count-descending `{ _id, count }` stream, write the `$sortByCount("$<field>")` stage directly |
| `.keyBy(<key>)` | One field key, or none (the identity key, as `.countBy`) | Collapses the stream to the lodash object `{ <keyValue>: <last doc> }` (mirroring value-mode `$.arr.keyBy(...)`) — `$group` with `$last: "$$ROOT"` (last wins) → second `$group` gathering `{k, v}` pairs into a scratch slot → `$replaceWith: { $arrayToObject }` | The three-stage collapse (one output doc). "Last" follows the stream's current order — precede with `.sort(...)` when which-duplicate-wins matters. Clears the let scope |
| `.uniqBy(<key>)` | One field key | `$group` keeping `$first` per key into the reserved `__jsmqlTmp` group slot, then `$replaceWith` to restore it. "First" follows the stream's current order — precede with `.sort(...)` when which-duplicate-wins matters | `{ $group: { _id: "$<field>", __jsmqlTmp: { $first: "$$ROOT" } } }` + `{ $replaceWith: "$__jsmqlTmp" }`. Clears the let scope |
| `.difference(list)` / `.without(...values)` | One list (or the values) — the row states `elementOnly: { when: "always" }`: a stream link only while the chain's element is an unwound field | The predicate `x => ![...(list ?? [])].includes(x)` built as SOURCE (`listOf` pins the argument as an array that is there; a missing list is empty, as lodash reads it) and handed to `predicate`, so the filter road picks the query form or `$expr` exactly as the `.filter` spelling would | One `$match` — `{ $nor: [{ <el>: { $in: [...] } }] }` for a constant list, `{ $expr: { $not: { $in: ["$<el>", { $ifNull: [<list>, []] }] } } }` otherwise |
| `.intersection(list)` | One list — `elementOnly` | The predicate `x => [...(list ?? [])].includes(x)` through `predicate`, then `keepFirstPer(element().ref)` — lodash keeps each value once | `$match` + `{ $group: { _id: "$<el>", __jsmqlTmp: { $first: "$$ROOT" } } }` + `{ $replaceWith: "$__jsmqlTmp" }` |
| `.differenceBy(list, iteratee)` / `.intersectionBy(list, iteratee)` | A list and an iteratee (the stream slot takes a property path, a matcher object, a pair — no bare callable) — `elementOnly` | `reshape(iteratee)` is the element's key (the parameter bound as the element); `value([...(list ?? [])].map(iteratee))` the list's keys | `{ $match: { $expr: { $not: { $in: [<key>, <keys>] } } } }`; intersection: `$in` then `keepFirstPer(<key>)` |
| `.compact()` | Zero args — `elementOnly` | JavaScript's falsy values as a `$nin` list (no NaN — JSMQL has none); MEASURED, `null` in `$nin` drops a missing field too | `{ $match: { <el>: { $nin: [null, 0, false, ""] } } }` |
| `.flat()` | Zero args — `elementOnly` | The element is itself an array: one more unwind, in place; the element's path does not change | `{ $unwind: "$<el>" }` |
| `.sortBy()` / `.sort()` / `.toSorted()` with no argument | Zero args — `elementOnly: { when: "bare" }`: the keyed call is a stream link on any stream, the bare call only after `.flatMap` | The natural order of the values | `{ $sort: { <el>: 1 } }` |
| `.pick([fields])` | One array of field-name strings | The lodash object method, per document. Keeps ONLY the named fields — `_id` is dropped unless named (matching lodash `_.pick` + the value-mode `.pick`) | `{ $project: { <f>: 1, …, _id: 0 } }` (inclusion). Clears the let scope (this also drops the `__jsmql` scratch) |
| `.omit([fields])` | One array of field-name strings | Drops the named fields, keeps everything else including `_id` (matching lodash `_.omit`) | `{ $project: { <f>: 0, … } }` (exclusion). Keeps the let scope |

`$ = $.pick([…])` and `$ = $.omit([…])` — the same methods on the document itself — reach these
two cells too, and emit the same stage: see [replace-root-stage.md § Element-wise object methods on the root](replace-root-stage.md#element-wise-object-methods-on-the-root).

Note: the `.map(d => <expr>)` row above also accepts the lodash property
shorthand `.map("<field>")` (≡ `.map(d => d.<field>)`). It lowers to
`{ $replaceWith: "$<field>" }`.

Note: `.keyBy` / `.groupBy` / `.countBy` build their object keys through the shared
`stringKeyExpr` helper (`src/compiler/emit/lower.ts`) — `{ $ifNull: [{ $toString: <key> }, "null"] }`.
A missing or null grouping field then coerces to the string `"null"` (matching
`String(null)`), instead of giving `$arrayToObject` a null key, which the server
rejects. The value-mode forms use the identical helper, so both modes agree.
`$toString` still errors on an object or array key — a separate, documented pitfall.
Because the key is a string, code that reads it back (`Object.keys(...)`) and joins
on it must first cast it to the field's own type — see the `keyBy`/`groupBy`/`countBy`
pitfall in [LANGUAGE.md](../LANGUAGE.md#lodash-array-methods) for the `ObjectId` case.

**A `.map` body must be a document.** `.map` lowers to `$replaceWith: <body>`, and
MongoDB requires this to be an object root. The `map` row's `streamBody: "document"` fact gates the
body in the same way as the `$ = <expr>` guard in
[src/compiler/emit/statement.ts](../../src/compiler/emit/statement.ts). A **provably** non-document body — a `Number`/`String`/`Boolean`/
`Null`/`RegExp`/`Array` literal — is rejected at compile time (parity with `$ = 5`).
This applies to both the top-level expression path and the correlated-lookup expression
path (the block paths route through the shared `$ = <expr>` guard). A field ref,
a member access, or an operator call is **data-dependent** (the field could be a
sub-document), and it passes. So `.map("userId")` / `.map(d => d.userId)` emit
`$replaceWith: "$userId"`, and, if `userId` is a scalar at runtime, they error on the server,
exactly as `$ = $.userId` does. Arithmetic bodies (`d.a + d.b`) share the same
pre-existing gap as `$ = <expr>` and are not caught (this would need type inference JSMQL
does not do for `$replaceWith`).

A chain link may also be a **pipeline stage** (`$$.$match({…}).$limit(5)`). Stage links interleave with these methods in every container. They are not registry entries, and [aggregation-stages.md](aggregation-stages.md#chained-stage-calls) owns them.

`.filter` is handled outside this registry (its predicate translation is shared
with `$unionWith`/`$facet`). It takes any predicate spelling (see § Callback
spellings) and may appear **anywhere** in the chain — as the head, or after a
reshaping method (`.flatMap(...).filter(...)`), not only first. `.filter({ userId: $._id })`
lowers to exactly what `.filter(o => o.userId === $._id)` does, including the indexed basic-form
`$lookup`.

Future methods extend this table — see
[docs/DEVLOG.md](../DEVLOG.md) for the per-commit chronology.

## The element after `.flatMap`

In JavaScript, `orders.flatMap(o => o.items)` returns a list of items, and every method
after it works on an item. `$unwind` keeps the whole document, with the unwound
field holding one element. So the stream has two things to track, and the
compiler keeps them apart:

- **The documents** are MongoDB's — one carrier per element, with every other field
  kept. Nothing about them changes. A terminal stream still returns the carriers,
  and `$$.flatMap("tags")` on an array of strings runs (a string cannot be a
  document, so there is no JS-faithful document form to fall into).
- **The element** is where a callback's parameter points. `Chain.element`
  ([src/compiler/emit/env.ts](../../src/compiler/emit/env.ts)) is the dotted path
  of the unwound field, or `""` when the element IS the document. The `.flatMap`
  cell sets it through the `unwound(path)` service. A callback bound by
  `stageInputs` ([src/compiler/emit/inputs.ts](../../src/compiler/emit/inputs.ts))
  carries the path in its binding (`{ kind: "document", path }`), so `i.qty` locates
  `items.qty` on the value road ([lower.ts](../../src/compiler/emit/lower.ts)
  `locate`) and on the query road ([filter.ts](../../src/compiler/emit/filter.ts)
  `pathOfIn`) alike. The sort readings prefix their keys, and a whole-element
  comparator names the field (`streamSortAsk` in
  [sort-spec.ts](../../src/compiler/emit/sort-spec.ts)); `.pick` / `.omit`
  prefix their field lists; `.uniq()` groups on `element().ref`.
- **A cell that reads the element and nothing else** states `elementOnly` on its
  row (`.difference`, `.compact`, `.flat`, the bare sorts, …). On a stream whose
  element is the document, such a link is not a stream link: `streamLink` refuses it
  with the row's `why` at the top of a pipeline, and `peels` answers false in a join,
  so the link reads the joined array as a value, like any method without a cell.
- **A stage that replaces the document** (a `document` effect on the stage's row that replaces the document — see docs/specs/types.md —
  `$replaceWith`, `$group`, an inclusion `$project`, …) makes the document the
  element again, whether it comes from a link (`streamLink`) or a statement
  (`afterStages`). A link whose row states `restoresDocuments` (`.uniq`, `.uniqBy`,
  and their `sorted` twins — a `$group` that keeps `$first: "$$ROOT"` and
  restores it with `$replaceWith`) changes nothing. The raw stage `$$.$unwind("$items")`
  is MQL (HR2), and it moves the element nowhere.

The element persists across statements on one chain (`$$.flatMap("items");
$$.filter(i => …);` reads `items.qty`). Each sub-pipeline has its own chain,
so a `$lookup` body's `.flatMap` is invisible outside it, except through the
value it yields. `Lookup.element` ([join.ts](../../src/compiler/emit/join.ts))
carries the body's final element, and a chain in a value position reads the
elements off the joined documents (`<slot>.map(x => x.<element>)`; the slot itself
under a bare `.length` / `.size()`, because one document holds one element;
`<slot>.<element>` after `.find`; `$replaceWith: "$<slot>.<element>"` on the `$ =` road). The
direct-to-`as` shortcut declines such a chain, so the value road runs. See
[emit-pass.md § The join road](emit-pass.md#the-join-road).

```js
$$$.orders.filter({ userId: $._id }).flatMap("productIds").filter(p => !$.owned.includes(p)).countBy();
// → the $lookup body: [{ $unwind: "$productIds" }, { $match: { $expr: { $not: { $in: ["$productIds", …] } } } },
//                      { $group: { _id: "$productIds", __jsmqlTmp: { $sum: 1 } } }, …the collapse ]
```

### `.reduce` is intentionally NOT in the registry

In JS, `arr.reduce(...)` returns a single value — a scalar, an object, or an array,
depending on the reducer. So `.reduce` is rejected as a chain method, with an
actionable wrap-pattern hint. What the reducer
returns decides how the result is assigned:

- **scalar / object reducer** (one value) — the code must **wrap** it into a
  stream-shaped RHS. Both wrap forms lower to the same `$group` +
  `$replaceWith` pair, through `lowerReduceWrap`.
- **array-returning reducer** (`acc.concat(...)`, seed `[]`) — this is already an
  array, that is, a stream, so the code assigns it **directly** (unbracketed); see the
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
as the first body entry, and mirrors the JS-idiomatic carry pattern. Later
entries must be static `<key>: <expr>` pairs. The init object must declare
the same key set as the body. Extra or missing keys on either side throw an
actionable error (in JS this would silently work, but mean something
different). Each entry's body must reference `acc.<sameKey>` as the
accumulator side (`total: acc.count + d.amount` is rejected with a
`'Each entry must reference acc.total'` hint, because this is the
constraint that keeps the per-key lowering local).

JSMQL requires the `init` value for JS-faithfulness, but the MQL
lowering does not use it (MongoDB accumulators have their own neutral elements). In the
scalar form it must be a literal, so a stray `$.<field>` cannot sneak through.
In the object-reducer form it is a literal object whose keys define the
accumulator namespace.

Multiple aggregates in either form share **one** `$group` stage. Some shapes stay
unrecognised: `$avg` (this would need a two-key sum/count dance with
cross-key references), multiplicative accumulators (no MQL counterpart),
and `$stdDevPop`/`$stdDevSamp` (no idiomatic JS shape). Write the `$group` stage
by hand for those.

### Dictionary-build reducer wrap → `$group` + `$arrayToObject`

`$$ = [$$.reduce((acc, d) => ({ ...acc, [d.<keyPath>]: <d.<valPath>|d> }), {})];`

This is the single-computed-key form of the object-returning reducer. It differs from
the static-key object-reducer above, where the user names every accumulator at
compile time, because here the **keys come from runtime data**: one input
document gives one output entry, and both the key and the value come from the doc. It lowers to:

```js
[
  { $group: { _id: null, __jsmqlTmp: { $push: { k: "$<keyPath>", v: "$<valPath>"|"$$ROOT" } } } },
  { $replaceWith: { $arrayToObject: "$__jsmqlTmp" } }
]
```

Supported body shapes:

| JSMQL | MQL output |
|---|---|
| `(acc, d) => ({ ...acc, [d.id]: d.name })` | `{ k: "$id", v: "$name" }` |
| `(acc, d) => ({ ...acc, [d.user.email]: d.score })` | `{ k: "$user.email", v: "$score" }` (nested paths) |
| `(acc, d) => ({ ...acc, [d.id]: d })` | `{ k: "$id", v: "$$ROOT" }` (bare-doc value) |
| `(acc, d) => ({ [d.id]: d.name })` | same as the spread form (the `...acc` is optional, JS-faithful boilerplate) |

The init MUST be `{}` (empty object). Mixed shapes (a computed key with static keys
in the same body) fall through to the static-key object-reducer detector,
which raises the precise "computed keys aren't supported" error and points
at the offending entry. Multiple computed-key entries are not supported.

Detection: `detectDictBuildWrap(value)` runs **before** `detectReduceWrap` in
one road, because the two detectors' inputs overlap — otherwise the dict-build shape
would hit the static-key error first.

### Array-returning reducer (unbracketed) → `$match` + `$replaceWith`

The third reduce form handles reducers that build a flat array of projected
documents. The reducer is seeded with `[]` and returns an array, that is, a stream, so the code
assigns it **directly**, with no surrounding `[ ]`:

```js
$$.reduce((acc, d) => (<cond> ? acc.concat(d.<field>) : acc), []);
//   → [{ $match: <cond translated> }, { $replaceWith: "$<field>" }]

$$.reduce((acc, d) => acc.concat(d.<field>), []);
//   → [{ $replaceWith: "$<field>" }]                     // unconditional map

$$.reduce((acc, d) => (<cond> ? acc.concat(d) : acc), []);
//   → [{ $match: <cond translated> }]                    // filter-only (bare `d`)
```

`arrayReduceStages` in [src/compiler/emit/statement.ts](../../src/compiler/emit/statement.ts)
recognises this form (`arrayReduceParts` in [src/compiler/emit/reduce-wrap.ts](../../src/compiler/emit/reduce-wrap.ts)
recognises the reducer's shape). The condition lowers through the filter road — the same road `.filter` uses — with the
parameter as the document, so a `$.<field>` read inside it is the outer document (HR4).

## Error wording

Every rejection branch sits next to the method's `validate` function, so
the wording stays consistent across methods. Two general principles:

- **Name the method explicitly.** `.slice(start[, end]) requires …` beats
  `argument must be a number`.
- **Suggest the actionable alternative.** Negative indices on `.slice` get
  the "non-negative integer literals" message; computed args get the
  "write the literal in source" hint.

The stream road refuses a link whose row has no `stream` cell, with the nearest
name that has one (`didYouMean`). A row that states an `unsupported(reason)` cell
answers with its reason. For the single-element methods (`.find`, `.findLast`, `.at`)
the reason names `.filter(p).take(1)` / `.slice(n, n + 1)`, and for `.find` on
`$$$.<coll>` it names the join form `$ = $$$.<coll>.find(<pred>)`.

## Adding a method

1. Add the `stream` cell to the method's row in [src/registry/names.ts](../../src/registry/names.ts). State the stages it emits (`// MEASURED:` where a shape's validity was proved on `mongod`), or state `unsupported(reason)` with the spelling that works.
2. Add a row to the table above with the args and lowering.
3. Add a case to [test/compiler-statement.test.ts](../../test/compiler-statement.test.ts) (the root stream) and [test/compiler-join.test.ts](../../test/compiler-join.test.ts) (a `$$$.<coll>` head). Run each case on `mongod` and compare it with JavaScript's answer.
4. Document the method in [docs/LANGUAGE.md](../LANGUAGE.md) and add a [DEVLOG.md](../DEVLOG.md) entry.

A cell that needs what the chain emitted before it reads `sortedBy()` — the last `$sort`'s spec — and never rewrites an earlier stage. `.takeWhile` / `.dropWhile` are the readers, and they show the safe shape: they **read** the sort (never rewrite it), and **refuse** when there is none (never guess one). The contrast is the "from the end" family (§ below), which could work only by rewriting the preceding stage AND falling back to `_id` when it is absent — a wrong answer with no diagnostic. Read; do not rewrite. Refuse; do not guess.

## Bare-statement stream chains

A `$$`-rooted chain is a statement — this is the spelling to write:

```js
$$.filter(o => o.tier === "gold");
$$.map(d => ({ id: d._id }));
$$.toSorted((a, b) => b.age - a.age).take(10);
```

The assignment form `$$ = $$.<chain>;` is the same program with an explicit head, and it lowers identically. It is never the default spelling.
A bare `$$.<chain>;` statement runs the stream road (`streamStages` in
[src/compiler/emit/statement.ts](../../src/compiler/emit/statement.ts)): each link's
`stream` cell appends its stages to the enclosing pipeline, in order. `$$.push(…)` and
the diagnostic sources (`$$.indexStats()`) are statement cells of their own rows, so
they keep their meaning. The compiler refuses a bare `$$$.<coll>.<chain>;` — a read of another
collection is a value, and the statement gives it no destination.

**The composition guarantee.** Splitting a chain across statements produces the
same MQL as chaining it, which in turn matches the assignment form:

```js
$$.filter(p).map(f);        // ≡
$$.filter(p); $$.map(f);    // ≡
$$ = $$.filter(p).map(f);
```

This holds for *every* method, because a cell reads only its own link and, for
`.takeWhile` / `.dropWhile`, the `$sort` the chain emitted before it. That stage is the
same one, whether it came from this statement or the one before.

## Deliberately absent: the "from the end" methods

`.takeRight(n)`, `.dropRight(n)`, `.initial()` and `.toReversed()` are **not** stream
methods. MongoDB has no stage that reverses a stream (`$reverseArray` is an
expression, for an array inside a document), and a stream has no order except the one a
`$sort` gives it. So "the last n" has nothing to count back from. The only way to fake
them is to rewrite the preceding `$sort`. This makes them position-dependent in a way
the JS methods are not, and, with no `$sort` in front, it silently orders by `_id` rather
than raising an error. `.toSorted(c).toReversed()` is in any case a longer spelling of writing
the comparator descending.

Each of the four rows states an `unsupported` stream cell, which every head reads — the root stream, a `$$$.<coll>` chain, and a callback's third parameter. So
a foreign chain cannot quietly fall back to slicing the tail of the materialised array, whose
order is whatever the foreign scan produced. The reason names the take-from-the-front
rewrite (`.toSorted({ <field>: -1 }).take(n)`).

All four remain in **value position** on a real array (`$.items.takeRight(3)` →
`$slice`, `$.items.toReversed()` → `$reverseArray`). An array carries its own order,
so there they mean exactly what JS means.

**JS-faithfulness note.** In plain JS, `arr.filter(...)` as a statement discards
its result. The bare form gives it the meaning "transform the running stream" —
syntactically valid JS (a different runtime meaning is allowed; only a syntax
error is not) and consistent with the existing `$$.push(...)` statement sugar.

## The Stage cell is answered for every array-receiver method

A method whose receiver is an array **can** have a stream form, so the grid requires it to
carry an answer. There are four answers, and no fifth:

| Answer | Where |
|---|---|
| a lowering | the row's `stream` cell — the stages the link means |
| a value terminal | a row with a value cell and no stream cell (`.sum()`, `.head()`, `.length`) — the chain ends in a value, which a join reads over its slot and the root stream refuses for want of a destination |
| a written reason | an `unsupported(reason)` stream cell — why this one cannot work on a stream, and what to write instead |

`test/stream-methods.test.ts` fails when an array-receiver method has none of the four, when
a name appears in two of them, or when a reason is too short to be useful.

The reason matters more than the rejection. A generic "not a chainable stream method" list
tells the developer what else exists, but never why *this* one is absent, and that is the
difference between a rejection and a dead end. A reason that cannot be written convincingly
announces a gap — that is how `.uniq`, `.sortedUniq` and `.sortedUniqBy` were
found and given lowerings.

The generic list still exists, and is still correct, for a name JSMQL does not recognise at
all. A typo has no reason to give, so it gets the vocabulary list and a `didYouMean` suggestion.

