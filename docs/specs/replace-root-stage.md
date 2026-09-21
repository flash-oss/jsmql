# `$ = <expr>` → `$replaceWith` / `$facet`

## Overview

`$ = <expr>` is the JSMQL surface for MongoDB's `$replaceRoot` / `$replaceWith`
stage. The left-hand side is the bare `$` token — the document itself, the
same role MQL's `$$ROOT` plays — and the assignment reads as "replace the
current document with this expression."

The compiler refuses an ARRAY on the right, whatever its shape: the root
takes ONE document, and the message names the destination that takes many.
See [Fan-out belongs to the stream, not the root](#fan-out-belongs-to-the-stream-not-the-root).

The compiler lowers to `$replaceWith` (the shorter MQL spelling) rather
than `$replaceRoot: { newRoot: <expr> }` (the legacy spelling). The two are
exact runtime equivalents on MongoDB 4.2+, and `$replaceWith: <expr>` uses
far fewer characters than `$replaceRoot: { newRoot: <expr> }`. The cost is
the 4.0 / 4.1 line of server versions, which the rest of the language
already excludes by relying on 4.2+ features (`$function`, `let` on
`$lookup`, and others).

`$ = <expr>` is statement-only: it appears as a top-level pipeline
statement, either inside `[ ... ]` array form or as a `;`-separated
implicit-pipeline statement — including inside a comma-separated
update-filter chain like `$.a = 1, $ = $.profile, $.b = 2`. Using it inside
a Filter or `jsmql.expr` goes through the normal pipeline-mode-required
gate.

**No `;` required.** A write is a pipeline wherever it stands ([filter-mode.md § The decision](filter-mode.md)), so a bare `$ = <expr>` with no `;` emits the same `$replaceWith` that the `;`-terminated form does, through `jsmql()` and `jsmql.pipeline()` alike. `jsmql.update()` refuses it: an update document holds writes to fields, and the server's document-form update has no root replacement.

The two entry points that cannot hold a stage reject it instead, each with a
root-replace-specific message: `jsmql.filter()` returns a Filter, and
`jsmql.expr()` returns one aggregation expression. The rejection names both
ways out — drop the `$ = ` to build the expression alone, or move to a
Pipeline entry. A literal sub-pipeline array rejects it too, and names
`$replaceWith({ … })` — see [aggregation-stages.md](aggregation-stages.md).

See [`docs/LANGUAGE.md#replace-root`](../LANGUAGE.md#replace-root-via---expr) for the
user-facing reference.

## Convention: all root-replacing sugar starts with `$ =`

**`$ = …` is reserved for *root-replacing* sugar in JSMQL.** The bare `$`
on the left-hand side is the visual signal that the document itself gets
replaced. Today that means `$replaceWith` and the `$facet` variant of the
same surface. Future root-replacing sugar must follow the same shape.

A stage that does *not* replace the root uses a **different** left-hand-side
prefix, so the asymmetry stays visible to a reader at a glance:

- `$$$.<coll> = …` / `$$$$.<db>.<coll> = …` → [`$out`](out-stage.md) (write to a destination).
- `$$$.<coll>.find(…)` / `.filter(…)` → [`$lookup`](lookup-stage.md) (read from a source).
- `$$.push(…)` → [`$unionWith`](union-stage.md) (append a stream).

Follow this rule when you add new sugar: if the stage replaces the
document root, it starts with `$ =`. If it writes elsewhere, reads from
elsewhere, or composes a derived stream, it takes a destination-bearing
left-hand-side prefix. Never blur this asymmetry — the left-hand side is
the user's first cue to what the statement does to the document.

## Lowering table

| Input | Output stage(s) |
|---|---|
| `$ = $.profile` | `{ $replaceWith: "$profile" }` |
| `$ = $` | `{ $replaceWith: "$$ROOT" }` (identity — bare `$` lowers to `"$$ROOT"`) |
| `$ = $mergeObjects($.a, $.b)` | `{ $replaceWith: { $mergeObjects: ["$a", "$b"] } }` |
| `$ = { ...$, x: 1 }` | `{ $replaceWith: { $mergeObjects: ["$$ROOT", { x: 1 }] } }` |
| `$ = $.pick(["a", "b"])` / `$ = $.omit(["a"])` | `{ $project: { a: 1, b: 1, _id: 0 } }` / `{ $project: { a: 0 } }` — the stream cell's stage, see [Element-wise object methods on the root](#element-wise-object-methods-on-the-root) |
| `$ = $.mapValues(v => v + 1)` | `{ $replaceWith: { $arrayToObject: { $map: { input: { $objectToArray: "$$ROOT" }, … } } } }` — a method on the bare `$` reads the document |
| `$ = $$$.coll.find(pred)` (direct lookup) | `{ $lookup: { …, pipeline: [ …, { $limit: 1 }], as: "__jsmql.tmp.N" } }`, `{ $unwind: "$__jsmql.tmp.N" }`, `{ $replaceWith: "$__jsmql.tmp.N" }` — a document whose `.find` matched nothing leaves the stream (by design) |
| `$ = { n: $.foo + $$$.coll.find(pred).count }` (buried lookup) | the `$lookup` hoisted ahead into a scratch slot, `{ $set: { slot: { $first: "$slot" } } }`, then `{ $replaceWith: { n: { $add: ["$foo", "$slot.count"] } } }` |
| `$ = [{…}, {…}]` / `$ = $.items.map(…)` / `$ = Object.entries($.x)` (any array) | refused — "'$ = …' replaces ONE document, and this value is an array. Name the destination that takes an array: '$$ = <array>;' …" |
| `$$ = [{…}, {…}]` / `$$ = $.items.map(…)` (the same array, on the STREAM) | `{ $set: { "__jsmql.tmp.N": <array> } }`, `{ $unwind: "$__jsmql.tmp.N" }`, `{ $replaceWith: "$__jsmql.tmp.N" }` — see [Fan-out belongs to the stream, not the root](#fan-out-belongs-to-the-stream-not-the-root) |

The direct-lookup form unwinds the slot instead of reading `$first`:
`$replaceWith: { $first: … }` fails on the server for every document
whose match is empty (measured), while `$unwind` drops that document.
The one document it found becomes the new document, and a document that
found nothing has nothing to become
([lookup-stage.md § The join road](lookup-stage.md)). No cleanup follows
a `$replaceWith`: the scratch namespace goes away with the old root.

## Element-wise object methods on the root

`$ = $.pick([…])`, `$ = $.omit([…])`, and a chain of such links
(`$ = $.pick([…]).omit([…])`) take the stream road.
`elementWiseOnDocument` in
[src/compiler/emit/statement.ts](../../src/compiler/emit/statement.ts) accepts a `MethodCall`
chain whose base is the bare `$`, with no `?.`, and whose every link is a row spelled on BOTH
the `object` and the `stream` family (`on` in [src/registry/names.ts](../../src/registry/names.ts)).
`documentStages` then runs the links through the same loop `$$.pick(…)` runs through
([stream-methods.md](stream-methods.md)), with the DOCUMENT as the chain's element. An earlier
bare `$$.flatMap("items")` leaves `items` as the element, and `$` names the document, not that
field; the element comes back afterwards unless a link replaced the document.

Why one lowering: a row on both families is element-wise by construction. What it makes of the
document is what its stream cell makes of each document of the stream. So "the document becomes
`pick(document)`" and "every document is picked" are the same operation, and the stream cell's
`$project` is the smaller MQL. MEASURED: `[{ $project: { a: 1, b: 1, _id: 0 } }]` and the value
form `$replaceWith: { $let: { vars: { jsmqlObj: "$$ROOT" }, in: { a: { $getField: … }, … } } }`
return the same documents for a present key, a null key, and a missing key. The compiler takes
the stream road only when every argument is a compile-time constant, because a stage reads its
field list before any document. `$ = $.pick($.keys)` names a list only the server knows, so it
takes the value road — one `$replaceWith` whose `.pick` reads the document's own keys at query
time — and so does any chain with such a link. The dispatch keys on what the developer wrote, so
one input has one output.

A chain with a link on the object family only (`$ = $.pick([…]).mapValues(…)`), or with a `?.`
(`$ = $?.pick([…])`), takes the value road: one `$replaceWith` over `$$ROOT`, as for every other
method on the bare `$`.

## Bare `$` is `$$ROOT`

A bare `$` (no `.<field>` suffix, no following identifier for `$op(...)`) is a
new primary expression. Its AST representation is `FieldRef { path: "" }` —
this reuses the existing node rather than minting a `RootRef` variant — and
codegen lowers any empty-path `FieldRef` to the string `"$$ROOT"` (the MQL
spelling for the current document). The rule holds everywhere: wherever a
field path is valid, a bare `$` produces `"$$ROOT"`, for example

```
jsmql.expr("$mergeObjects($, { x: 1 })")
// → { $mergeObjects: ["$$ROOT", { x: 1 }] }
```

This is why `$ = { ...$, … }` needs no spread-specific code: the spread
lowers to `$mergeObjects` operands, and the operand for a bare `$` is
`"$$ROOT"`.

## Facet variant

When the right-hand side of `$ = …` is an object literal where every value
is a `$$.filter(<lambda>)` call, the same `$ = { … }` surface lowers to a
`$facet` stage instead of `$replaceWith`. The detection lives in
`src/compiler/emit/statement.ts` and runs *before* the `$replaceWith`
emission in the write road:

```
$ = {
  topByScore: $$.$sort({ score: -1 }).$limit(10),
  recent:     $$.filter(o => o.createdAt >= "2026-01-01"),
  byStatus:   $$.$group({ _id: $.status, n: $sum(1) }),
};
// → [{ $facet: {
//       topByScore: [{ $sort: { score: -1 } }, { $limit: 10 }],
//       recent:     [{ $match: { createdAt: { $gte: "2026-01-01" } } }],
//       byStatus:   [{ $group: { _id: "$status", n: { $sum: 1 } } }]
//   } }]
```

**Detection is all-or-nothing.** `isFacet` in [src/compiler/emit/statement.ts](../../src/compiler/emit/statement.ts) reads the object literal. When no entry is a chain on `$$`, it is an ordinary `$replaceWith` body. When at least one is, every entry must be one, and the compiler refuses a mixed object and names the entry — "'$ = { … }' with a '$$' chain is a '$facet', and every entry must be one: 'b' is not a chain on '$$'. Make it one ('b: $$.filter(…)'), or move it out of the object." It refuses a spread entry or a computed key in that mode too.

**Each entry is one sub-pipeline.** `facetStages` lowers each chain through the stream road ([stream-methods.md § Where a chain runs](stream-methods.md)) in an Env that has crossed the `$facet` boundary over the SAME documents: a predicate lowers through the filter road with the parameter as the document, a stage link becomes the stage, and the outer bindings and `$$.length` stay readable inside the branch ([let-bindings.md § Blocks and sub-pipelines](let-bindings.md)). `$facet` replaces the document — its output is `{ <branch>: […], … }` — so every field-carried binding is dropped after it, and a later read is refused, with a precise message.

**Statement-position `$$.filter(...)`.** A bare `$$.filter(...)` at a statement position is valid: it lowers to `$match`, as the stream road's own spelling (see [stream-methods.md § Bare-statement stream chains](./stream-methods.md)). Only inside `$ = { … }` does the same call name a facet branch.

## Fan-out belongs to the stream, not the root

`$` names ONE document, and `$$` names the stream, so an array names the
destination that takes many. `rootIsArray` refuses `$ = <array>`; `$$ = <array>`
fans out.

When the right side of `$$ = …` is **provably an array** and is not a chain
on a stream (`kindOf` in [src/compiler/emit/prove.ts](../../src/compiler/emit/prove.ts)),
one input document produces one output document per element. `$unwind`
needs a materialised field path — it cannot unwind an inline array
expression — so the compiler parks the array in a fresh compiler slot with
`$set`, unwinds it, then makes each element the new root:

```
$$ = $.lineItems.map(li => ({ sku: li.sku }));
// → [
//   { $set:         { "__jsmql.tmp.1": { $map: { input: "$lineItems", … } } } },
//   { $unwind:      "$__jsmql.tmp.1" },
//   { $replaceWith: "$__jsmql.tmp.1" },
// ]
```

A chain on the stream, on the callback's own stream, or on another
collection takes the STREAM road, whatever kind its last link returns — a
`$lookup` yields an array, and `$$ = $$$.orders.filter(p)` is still a
source switch. The array road applies only when none of those holds.

An array LITERAL of documents is a third reading: `$$ = [{ … }, { … }]`
names the stream's documents outright. `$documents` is the stage that
makes them, and MEASURED it runs only on a database-level aggregation. So
a collection's pipeline takes the same pair a source switch already
takes: every document dropped, the new ones unioned in:

```
$$ = [{ a: 1 }, { a: 2 }];
→ [{ $match: { $expr: false } },
   { $unionWith: { pipeline: [{ $documents: [{ a: 1 }, { a: 2 }] }] } }]
```

Nothing in that pair depends on position, so the list reads the same
anywhere in the program: written after other statements, it drops what
they produced and starts again. The empty list is the first half on its
own. The element check is the `$documents` row's own rule, applied under
the name the source wrote. A list holding a `...` spread is not this
reading, because its elements are not the documents, and neither is an
array the data decides, which gives one answer per input document.

**A stream holds DOCUMENTS.** When a row states the kind of ONE element of
what it returns (`elementKind` — `.split()` gives strings, `Object.entries()`
gives `[key, value]` arrays, `$objectToArray` gives `{ k, v }` documents),
the compiler refuses an element that is not a document here, rather than
letting the server do it. MEASURED,
`[{ $set: { s: <the array> } }, { $unwind: "$s" }, { $replaceWith: "$s" }]`
answers "'replacement document' must evaluate to an object". A row that
states nothing — and a field path states nothing by construction — leaves
the elements unproven, and the fan-out stands.

**Per-document drop is emergent, not a special case.** The default
`$unwind` emits no document for an empty or missing array, so fanning out
a possibly-empty array drops exactly the documents whose array came out
empty, and fans out the rest:

```
$$ = $.items.filter(x => x.qty > 0);   // docs with no qualifying item are dropped
```

## Lowering and refusals

`$ = <expr>` is an `AssignExpr` whose target is the bare `$` (a `FieldRef` with an empty path). `writeStages` in [src/compiler/emit/statement.ts](../../src/compiler/emit/statement.ts) reads the target and emits `{ $replaceWith: <value> }` — or, for a value that is an array, the fan-out (`$set` a scratch slot, `$unwind`, `$replaceWith`), and for a join, the join road's `joinRoot` ([lookup-stage.md](lookup-stage.md)). A write before it takes its own stage (`$.a = 1; $ = $.profile;` → `[{ $set: { a: 1 } }, { $replaceWith: "$profile" }]`), and every field-carried binding is dropped after it, so a later `let` read is refused, with a precise message ([let-bindings.md § Stages that replace the document](let-bindings.md)).

Each refusal names a concrete fix:

| Trigger | Message |
|---|---|
| a value that is not a document (`$ = 1`, `$ = "x"`, `$ = null`, `$ = true`) | "'$ = …' replaces the document, so the value has to BE a document — a number is not one. Put it under a field ('$ = { value: … };'), or write to a field instead ('$.value = …;')." |
| `$ = $$$.<coll>.filter(p)` (an array of documents) | "The document can only become ONE document, and this chain gives an array. Write '$ = $$$.<coll>.find(pred)' for the first match, or keep the array in a field: '$.<field> = $$$.<coll>.…'." |
| any array (`$ = []`, `$ = [1, 2]`, `$ = [{…}]`, `$ = $.items.map(…)`) | "'$ = …' replaces ONE document, and this value is an array. Name the destination that takes an array: '$$ = <array>;' makes the stream from its elements, one document per element. To keep the array as a field of this document, write '$.<field> = <array>;'." |
| `$++`, `$ += 5`, `$--`, `$ *= 2` | "Cannot use '++' on bare '$' — it is the whole document, not a scalar. Write the field: '$.<field> ++ …'" |
| `delete $` | "'delete $' would delete the document itself. To replace it, write '$ = { … };'; to drop every field but one, write '$ = { keep: $.keep };'." |

A field path that resolves to a document at run time passes (`$ = $.profile`, `$ = "$sub"`), and so does any expression the compiler cannot prove is not a document — the server, not the compiler, refuses `$ = $.points * 1.1`. An ARRAY never passes, whatever its elements — see [Fan-out belongs to the stream, not the root](#fan-out-belongs-to-the-stream-not-the-root).

## Deferred

- **Trailing `$unset` after a final `$ = …`.** When the pipeline's last
  stage is `$replaceWith` and no later stage uses the namespace, the
  trailing `$unset: "__jsmql"` is harmless but unnecessary — the field
  does not exist on the post-replace document. Folding it away would be a
  small win, and the project has not done this work.
- **`$replaceRoot` as an alternative target.** A user who explicitly wants
  the verbose 4.0-compatible shape can still write
  `$replaceRoot({ newRoot: <expr> })` directly — the stage-call form stays
  unchanged. The project offers no knob that makes `$ = …` lower to the
  verbose form.
- **Type-aware non-document rejection.** Beyond the literal-type
  rejections above, the compiler could in principle detect
  `$ = <BinaryExpr with arithmetic ops>` as obviously not a document. The
  project skips this: the MongoDB runtime error names the offending stage
  and is precise enough, and the extra rule would risk a false positive on
  a legitimate `{ $cond: … }` or `$let`-style expression.
