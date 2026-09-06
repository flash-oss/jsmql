# `$ = <expr>` → `$replaceWith` / `$facet` / fan-out stage(s)

## Overview

`$ = <expr>` is the jsmql surface for MongoDB's `$replaceRoot` / `$replaceWith`
stage. The LHS is the bare `$` token — the document itself, the same role
MQL's `$$ROOT` plays — and the assignment reads as "replace the current
document with this expression."

When the RHS is **provably an array** (an array literal, or an array-typed
expression like `.map()` / `.filter()` / `Object.entries()`), the same surface
instead *fans out*: one input document becomes one output document **per array
element**. See [Fan-out variant](#fan-out-variant).

We lower to `$replaceWith` (the shorter MQL spelling) rather than
`$replaceRoot: { newRoot: <expr> }` (the legacy spelling). They are exact
runtime equivalents on MongoDB 4.2+, and `$replaceWith: <expr>` is
substantially fewer characters than `$replaceRoot: { newRoot: <expr> }` — the
cost is the 4.0 / 4.1 line of server versions, which the rest of the
language already excludes by relying on 4.2+ features (`$function`, `let` on
`$lookup`, etc.).

Statement-only: `$ = <expr>` appears as a top-level pipeline statement —
either inside `[ ... ]` array-form or as a `;`-separated implicit-pipeline
statement (including inside a comma-separated update-filter chain like
`$.a = 1, $ = $.profile, $.b = 2`). Using it inside a Filter / `jsmql.expr`
goes through the normal pipeline-mode-required gate.

**No `;` required.** A write is a pipeline wherever it stands ([filter-mode.md § The decision](filter-mode.md)), so a bare `$ = <expr>` with no `;` emits the same `$replaceWith` the `;`-terminated form does, through `jsmql()` and `jsmql.pipeline()` alike. `jsmql.update()` refuses it: an update document holds writes to fields, and the server's document-form update has no root replacement.

The two entry points that cannot hold stages reject it instead, each with a
root-replace-specific message: `jsmql.filter()` returns a Filter, and
`jsmql.expr()` returns one aggregation expression. The rejection names both ways
out — drop the `$ = ` to build the expression alone, or move to a Pipeline
entry. A literal sub-pipeline array rejects it too, and names `$replaceWith({ … })`
— see [aggregation-stages.md](aggregation-stages.md).

See [`docs/LANGUAGE.md#replace-root`](../LANGUAGE.md#replace-root) for the
user-facing reference.

## Convention: all root-replacing sugar starts with `$ =`

**`$ = …` is reserved for *root-replacing* sugar in jsmql.** The bare `$`
LHS is the visual signal that the document itself is being replaced.
Today that means `$replaceWith` and the `$facet` variant of the same
surface; future root-replacing sugar must follow the same shape.

Stages that do *not* replace root use **different** LHS prefixes so the
asymmetry is visible to readers at a glance:

- `$$$.<coll> = …` / `$$$$.<db>.<coll> = …` → [`$out`](out-stage.md) (write to a destination).
- `$$$.<coll>.find(…)` / `.filter(…)` → [`$lookup`](lookup-stage.md) (read from a source).
- `$$.push(…)` → [`$unionWith`](union-stage.md) (append a stream).

When adding new sugar, follow this rule: if the stage replaces the
document root, it starts with `$ =`. If it writes elsewhere, reads from
elsewhere, or composes a derived stream, it gets a destination-bearing
LHS prefix. Don't blur the asymmetry — the LHS is the user's first cue
about what the statement does to the document.

## Lowering table

| Input | Output stage(s) |
|---|---|
| `$ = $.profile` | `{ $replaceWith: "$profile" }` |
| `$ = $` | `{ $replaceWith: "$$ROOT" }` (identity — bare `$` lowers to `"$$ROOT"`) |
| `$ = $mergeObjects($.a, $.b)` | `{ $replaceWith: { $mergeObjects: ["$a", "$b"] } }` |
| `$ = { ...$, x: 1 }` | `{ $replaceWith: { $mergeObjects: ["$$ROOT", { x: 1 }] } }` |
| `$ = $$$.coll.find(pred)` (direct lookup) | `{ $lookup: { …, pipeline: [ …, { $limit: 1 }], as: "__jsmql.tmp.N" } }`, `{ $unwind: "$__jsmql.tmp.N" }`, `{ $replaceWith: "$__jsmql.tmp.N" }` — a document whose `.find` matched nothing leaves the stream (by design) |
| `$ = { n: $.foo + $$$.coll.find(pred).count }` (buried lookup) | the `$lookup` hoisted ahead into a scratch slot, `{ $set: { slot: { $first: "$slot" } } }`, then `{ $replaceWith: { n: { $add: ["$foo", "$slot.count"] } } }` |
| `$ = [{…}, {…}]` / `$ = $.items.map(…)` / `$ = Object.entries($.x)` (provably array) | `{ $set: { "__jsmql.tmp.N": <array> } }`, `{ $unwind: "$__jsmql.tmp.N" }`, `{ $replaceWith: "$__jsmql.tmp.N" }` — see [Fan-out variant](#fan-out-variant) |

The direct-lookup form unwinds the slot instead of reading `$first`: `$replaceWith: { $first: … }` fails on the server for every document whose match is empty (measured), while `$unwind` drops it — the one document it found is what the document becomes, and a document that found nothing has nothing to become ([lookup-stage.md § The join road](lookup-stage.md)). No cleanup follows a `$replaceWith`: the scratch namespace is gone with the old root.

## Bare `$` is `$$ROOT`

Bare `$` (no `.<field>` suffix, no following identifier for `$op(...)`) is a
new primary expression. The AST representation is `FieldRef { path: "" }`
— reusing the existing node rather than minting a `RootRef` variant — and
codegen lowers any empty-path `FieldRef` to the string `"$$ROOT"` (the MQL
spelling for the current document). The rule is universal: anywhere a
field path is valid, bare `$` produces `"$$ROOT"`, e.g.

```
jsmql.expr("$mergeObjects($, { x: 1 })")
// → { $mergeObjects: ["$$ROOT", { x: 1 }] }
```

This is why `$ = { ...$, … }` needs no spread-specific code: the spread lowers
to `$mergeObjects` operands, and the operand for a bare `$` is `"$$ROOT"`.

## Facet variant

When the RHS of `$ = …` is an object literal where every value is a
`$$.filter(<lambda>)` call, the same `$ = { … }` surface lowers to a
`$facet` stage instead of `$replaceWith`. The detection lives in
`src/compiler/emit/statement.ts` and runs *before* the `$replaceWith` emission
ahead of the `$replaceWith` emission in the write road:

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

**Detection — all-or-nothing.** `isFacet` in [src/compiler/emit/statement.ts](../../src/compiler/emit/statement.ts) reads the object literal: no entry is a chain on `$$` → an ordinary `$replaceWith` body; at least one is → every entry must be one, and a mixed object is refused naming the entry — "'$ = { … }' with a '$$' chain is a '$facet', and every entry must be one: 'b' is not a chain on '$$'. Make it one ('b: $$.filter(…)'), or move it out of the object." Spread entries and computed keys are refused in that mode too.

**Each entry is one sub-pipeline.** `facetStages` lowers each chain through the stream road ([stream-methods.md § Where a chain runs](stream-methods.md)) in an Env that has crossed the `$facet` boundary over the SAME documents: a predicate lowers through the filter road with the parameter as the document, a stage link is the stage, and the outer bindings and `$$.length` are readable inside the branch ([let-bindings.md § Blocks and sub-pipelines](let-bindings.md)). `$facet` replaces the document — its output is `{ <branch>: […], … }` — so every field-carried binding is dropped after it, and a later read is refused precisely.

**Statement-position `$$.filter(...)`.** A bare `$$.filter(...)` at a statement position is valid — it lowers to `$match` as the stream road's own spelling (see [stream-methods.md § Bare-statement stream chains](./stream-methods.md)); only inside `$ = { … }` does the same call name a facet branch.

## Fan-out variant

When the RHS of `$ = …` is **provably an array**, the statement fans out: one
input document produces one output document per array element. `$unwind` needs
a materialised field path (it can't unwind an inline array expression), so the
array is first parked in a fresh compiler slot via `$set`, unwound, then each
element becomes the new root via `$replaceWith`:

```
$ = [{ a: 1 }, { b: 2 }];
// → [
//   { $set:         { "__jsmql.tmp.1": [{ a: 1 }, { b: 2 }] } },
//   { $unwind:      "$__jsmql.tmp.1" },
//   { $replaceWith: "$__jsmql.tmp.1" },
// ]
```

The write road (`writeStages`) fans out when the value's kind is provably an array (`kindOf` in [src/compiler/emit/types.ts](../../src/compiler/emit/types.ts)): an array literal, an array-returning method on any receiver (`.map`, `.filter`, `.uniq`, `.slice` of an array, …), an array operator, `Object.entries` / `keys` / `values`. A bare field ref `$ = $.items` is **not** provably an array (a field path carries no compile-time kind), so it stays a single-document `$replaceWith`; to fan out a field, spread it into a literal: `$ = [...$.items]`. A join in the value is hoisted ahead into its own slot first ([lookup-stage.md](lookup-stage.md)). No cleanup follows: the closing `$replaceWith` discards the `__jsmql` namespace with the old root.

**Per-document drop is emergent, not a special case.** Default `$unwind` emits
no document for an empty/missing array, so fanning out a possibly-empty array
drops exactly the documents whose array came out empty and fans out the rest:

```
$ = $.items.filter(x => x.qty > 0);   // docs with no qualifying item are dropped
```

This is the idiomatic conditional-drop. There is deliberately **no** "drop"
lowering for `$ = []` or `$ = undefined` — both are rejected/unchanged (see
[Validation](#validation)); the "empty the whole stream" intent is already
spelled `$$ = []` (see [replace-stream](#)/`$$ = <expr>`), and one behaviour with
two spellings is a footgun we avoid.

## Lowering and refusals

`$ = <expr>` is an `AssignExpr` whose target is the bare `$` (a `FieldRef` with an empty path); `writeStages` in [src/compiler/emit/statement.ts](../../src/compiler/emit/statement.ts) reads the target and emits `{ $replaceWith: <value> }` — or, for a value that is an array, the fan-out (`$set` a scratch slot, `$unwind`, `$replaceWith`), and for a join, the join road's `joinRoot` ([lookup-stage.md](lookup-stage.md)). A write before it is its own stage (`$.a = 1; $ = $.profile;` → `[{ $set: { a: 1 } }, { $replaceWith: "$profile" }]`), and every field-carried binding is dropped after it, so a later `let` read is refused precisely ([let-bindings.md § Stages that replace the document](let-bindings.md)).

Each refusal names a concrete fix:

| Trigger | Message |
|---|---|
| a value that is not a document (`$ = 1`, `$ = "x"`, `$ = null`, `$ = true`) | "'$ = …' replaces the document, so the value has to BE a document — a number is not one. Put it under a field ('$ = { value: … };'), or write to a field instead ('$.value = …;')." |
| `$ = $$$.<coll>.filter(p)` (an array of documents) | "The document can only become ONE document, and this chain gives an array. Write '$ = $$$.<coll>.find(pred)' for the first match, or keep the array in a field: '$.<field> = $$$.<coll>.…'." |
| `$++`, `$ += 5`, `$--`, `$ *= 2` | "Cannot use '++' on bare '$' — it is the whole document, not a scalar. Write the field: '$.<field> ++ …'" |
| `delete $` | "'delete $' would delete the document itself. To replace it, write '$ = { … };'; to drop every field but one, write '$ = { keep: $.keep };'." |

A field path that resolves to a document at run time passes (`$ = $.profile`, `$ = "$sub"`), and so does any expression the compiler cannot prove is not a document (`$ = $.points * 1.1` is refused by the server, not at compile time). An array literal fans out whatever its elements are (`$ = [1, 2]` unwinds two scalars, which the server refuses as roots) — see [Fan-out variant](#fan-out-variant).

## Deferred

- **Trailing `$unset` after a final `$ = …`.** When the pipeline's last stage
  is `$replaceWith` and no later stage uses the namespace, the trailing
  `$unset: "__jsmql"` is harmless but unnecessary (the field doesn't exist
  on the post-replace document). Folding it away would be a small win; out
  of scope for now.
- **`$replaceRoot` as an alternative target.** If a user explicitly wants
  the verbose 4.0-compatible shape, they can still write
  `$replaceRoot({ newRoot: <expr> })` directly — the stage-call form is
  unchanged. We don't currently offer a knob to make `$ = …` lower to the
  verbose form.
- **Type-aware non-document rejection.** Beyond the literal-type rejections
  above, we could in principle detect `$ = <BinaryExpr with arithmetic ops>`
  as obviously-not-a-doc. Skipped: the MongoDB runtime error names the
  offending stage and is precise enough; the extra rules would risk
  false positives on legitimate `{ $cond: … }` and `$let`-style expressions.
