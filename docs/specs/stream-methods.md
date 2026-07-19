# Stream methods — chainable array vocabulary on `$$` / `$$$.<coll>`

## Overview

`STREAM_METHODS` ([src/stream-methods.ts](../../src/stream-methods.ts)) is the
single source of truth for the chainable JS-array-shaped methods that may
appear after a stream / collection receiver inside a `$$ = …` statement. One
entry per method, each declaring its arg-shape validator and its lowering
to MQL stages.

The chain walker in [src/pipeline.ts](../../src/pipeline.ts) (`lowerChainOnStream` /
`lowerChainOnCollection`) reads from the registry — adding a method here
makes it usable in both contexts the walker covers.

This spec is the implementation-facing companion to the user-facing chain
documentation in [docs/LANGUAGE.md](../LANGUAGE.md#stream-methods). The
sister specs that handle individual statement-level sugars
([replace-stream-stage.md](./replace-stream-stage.md),
[union-stage.md](./union-stage.md), [lookup-stage.md](./lookup-stage.md))
predate this registry and continue to live where they are; the registry
only governs **chained** methods after one of those sugars has identified
the receiver.

## Where the chain walker runs

Three contexts share the same registry. The per-method loop is the single
helper `applyStreamMethods` in [src/pipeline.ts](../../src/pipeline.ts); the
first two contexts reach it through `lowerChainOnStream` / `lowerReplaceStream`,
the third through `lowerStatementTail`:

| Context | Chain head | Lowering site |
|---|---|---|
| **`$$ = $$.<chain>;`** | Bare `$$` (or `$$.filter(<pred>)` as the first method) | Each registry method appends one or more stages to the outer pipeline. |
| **`$$ = $$$.<coll>.<chain>;`** | `$$$.<coll>` (or with `.filter(<pred>)` as the first method) | Each registry method appends stages inside the `$unionWith.pipeline` body of the emitted `$match` + `$unionWith` pair. |
| **`$$.<chain>;`** (bare statement, no `$$ =` head) | Bare `$$` | Statement sugar for `$$ = $$.<chain>;` — see [§ Bare-statement stream chains](#bare-statement-stream-chains) below. |

The first method of a chain may be `.filter(<lambda>)` — handled by the
pre-existing `lowerStreamFilterPredicate` (translates the predicate through
the match-translator). This stays outside the registry because the
predicate handling is shared with [union-stage.md](./union-stage.md) /
[facet](./replace-root-stage.md) and is too tightly coupled to the
two-context wiring to belong in a per-method entry.

Every method *after* the first (and any method when the first isn't
`.filter`) is dispatched through the registry. Unknown method names produce
an actionable `CodegenError` (`closestNameTo` suggestion + the list of
registered methods), with explicit special-cased messages for the
"single-element" JS methods (`.find` / `.findLast` / `.at`) that name the
`.slice(0, 1)` / `$ = $$$.<coll>.find(...)` alternatives.

## Registry shape

```ts
export type StreamMethodDef = {
  name: string;
  validate: (args: readonly CallArg[], callPos: number) => void;
  lower: (args: readonly CallArg[], ctx: GenerateCtx, callPos: number) => StreamMethodResult;
};

export type StreamMethodResult = {
  stages: object[];
  clearLets?: boolean;
};
```

- `validate` throws `CodegenError` for any arg-shape rejection. Error messages
  name the method, the offending arg, and the rule that was violated.
- `lower` runs only after `validate` accepted the args; it may cast args to
  the validator-accepted shape without re-checking.
- `clearLets: true` signals that the emitted stages reshape the document and
  drop in-scope `let` bindings (e.g. a future `.reduce` → `$group` entry).
  Threaded back to the caller so the outer pipeline ctx clears the let
  scope. Defaults to false.

## Registered methods

| Method | Args | Lowering | Stages emitted |
|---|---|---|---|
| `.slice(start, end?)` | 1-2 non-negative integer literals; `end >= start` if both present | `$skip` + `$limit` | `$skip: start` (omitted when `start === 0`) + `$limit: end - start` (omitted when `end` is absent) |
| `.concat(...others)` | 1+ args matching the `$$.push(...)` shapes (spread of `$$$.<coll>[.filter(p)]`, inline `{...}` doc, `$$$.<coll>.find(p)`) | `lowerUnionPush` (shared with `$$.push`) | One `$unionWith` per arg; consecutive inline docs batch into one `$documents`-form stage |
| `.map(d => <expr>)` / `.map(d => { … ; return <ret> })` | An **expression body** (`d => <expr>`, or a single-`return` `exprBlock` from the `function` form — `mapBodyExpr`) **or** a **statement-block body** (`d => { stmt; …; return <ret> }`, a pipeline `block` + `ret`), with **1–3 params** `(element[, index[, collection]])`; `$.<field>` rejected ("use the lambda param"). The **index** (2nd) param may not be *referenced* (no per-doc stream index — `someExpr` over the whole lambda); the **collection** (3rd) param is the sub-stream and only `<coll>.length` is available on it (any other use rejected with a materialised-form redirect). Embedded `$$$.<coll>.find/filter(...)` lookups are supported in both stream contexts; the statement block additionally accepts the full sub-pipeline statement vocabulary (`assert(...)`, `$match(...)`, `let`, …). A block with no `return` is rejected | **Expression body:** `extractLetsFromExpr` (rewrites `d.<path>` → bare field paths) + `extractLookupCalls` (materialises embedded lookups into `__jsmql.tmp.<N>` slots) + `generateWithCtx`; when `coll.length` is read, prepends `streamLengthStage()`. **Inside a correlated `$lookup`** (the `$$ =` pivot / a nested chain / a `$.field = $$$.<coll>…` assign — gated on `ctx.enclosingLookup`, NOT a flat `$unionWith`): BOTH an expression body and a statement block route through the SAME `lowerCallbackBlock` engine `.filter` uses (an expression body `d => X` is just `d => { return X }`). Its `return <ret>` is the `terminalRet` (appended as `$ = <ret>`, the *only* difference from `.filter`), and cross-level reads — `$.field` / `$$.length` (root), an enclosing foreign param, an ancestor `<coll>.length` handle, **and an outer-pipeline `let`** declared before the pivot — are captured into the enclosing `$lookup.let` (`jsmql_f0_…` / `jsmql_s0_…` / `jsmql_v0_…`) and returned as `StreamMethodResult.extraLetVars` for the chain assembler to merge (see [lookup-stage.md](lookup-stage.md) § Nested lookups). The chain's slot allocator threads in via `GenerateCtx.slotAllocator` so block-internal lookups get slots distinct from the enclosing lookup's `as`. **On the top-level `$$` stream / a flat `$unionWith`** (no enclosing `$lookup.let` to correlate into) the block + synthetic `$ = ret` lower directly and `$.field` is rejected (use the param) | Expression body: prologue `$lookup`+`$set` pairs from `extractLookupCalls` + one `{ $replaceWith: <expr> }`; a leading `$setWindowFields` `$count` when `coll.length` is read. Statement block: the block's stages (`$match` guards from `assert`, nested `$lookup`s, `$setWindowFields` for `<coll>.length`/`$$.length`) followed by one `{ $replaceWith: <ret> }`. In the `$$$.<coll>.<chain>` context the stages land inside the outer sub-pipeline — inner `$lookup`s correlate against the sub-pipeline's local doc, not any outer-pipeline `let` binding. Clears the let scope (reshape stage) |
| `.sort(<sort>)` / `.toSorted(<sort>)` | A field name (ascending), an array of field names (all ascending), a `{ field: 1 \| -1 \| "asc" \| "desc" }` spec, or a two-param comparator arrow `a.<path> - b.<path>` / `b.<path> - a.<path>` (`\|\|` for compound). `.sort` and `.toSorted` are **equivalent on a stream** — nothing to mutate, both reorder the flow | `buildStreamSortSpec` dispatches: a comparator → `parseComparatorBody`; a string/array/object → `buildKeySortSpec` (directions via `sortDirection`, which accepts 1/-1/"asc"/"desc") | One `{ $sort: { … } }` stage; key order preserved from source |
| `.sortBy(<field> \| [fields])` | The lodash ascending-sort alias — a field name or an array of field names. An object arg is rejected (in lodash it's a matches-shorthand, not a direction; the error points at `.orderBy` / `.sort`) | `buildSortByStreamSpec` → `buildKeySortSpec` (ascending) | One `{ $sort: { … } }` stage |
| `.orderBy(keys[, orders])` | The lodash multi-key sort — `keys` is a field name or `[fields]`, `orders` a `1 \| -1 \| "asc" \| "desc"` (or an array of them, parallel to the keys; fewer orders than keys ⇒ the rest ascending) | `buildOrderByStreamSpec` zips the two parallel args (`fieldNameLiteral` + `sortDirection`) | One `{ $sort: { … } }` stage |
| `.reject(<predicate>)` | `.filter` negated — an arrow (`o => …`), a matches-object, a field name, or a `["field", value]` pair. Special-cased in `applyStreamMethods` (like `.filter`), not the registry | `lowerStreamReject` builds the predicate lambda (arrow as-is, or `shorthandToLambda` for the shorthands), synthesizes `o => !(<body>)`, and reuses `lowerStreamFilterPredicate` | One `$match` stage — `{ $expr: { $not: … } }` (the negated `$expr` form; jsmql never emits a query-form De Morgan) |
| `.tail()` | Zero args | — | `$skip: 1` (the stream `.drop(1)`) |
| `.takeRight(n)` / `.dropRight(n)` / `.initial()` | Count from the END. `reverseSortTrick` reads `prevStages`: a preceding directional `$sort` S is reversed (`replacesPreviousStage`), else it orders by `_id`. `n = 0` → `takeRight` empty (`$match:{$expr:false}`), `dropRight` identity. `.initial()` = `.dropRight(1)` | `[{ $sort: <reversed S> }, { $limit\|$skip: n }, { $sort: <S> }]`. A non-directional preceding `$sort` (text-meta, custom) is rejected — sort by 1/-1 fields first |
| `.shuffle()` | Zero args | `allocSlot()` for a `__jsmql.tmp.<N>` key; the trailing `$unset: "__jsmql"` clears the residue | `[{ $addFields: { <slot>: { $rand: {} } } }, { $sort: { <slot>: 1 } }, { $unset: <slot> }]` — non-deterministic |
| `.toReversed()` | Zero args; the immediately preceding stage must be a `$sort` with 1/-1 directions. In the `$$ = …` forms that means a `.toSorted(...)` earlier in the same chain; in the bare-statement form the preceding `$sort` may also come from a prior statement or a literal `$sort(...)` stage (the chain lowers against the live pipeline) | Reads `prevStages` (the chain's working buffer — the live pipeline for the bare form), flips every direction (1 ↔ -1), returns `replacesPreviousStage: true` so the caller drops the old `$sort` | One `{ $sort: { … } }` stage replacing the previous one — net stage count unchanged vs. writing `.toSorted` descending directly |
| `.flatMap(d => d.<path>)` / `.flatMap("<path>")` | Single-param arrow whose expression body is a bare field-path on the param (v1), **or** a plain field-name string (lodash property shorthand, no leading `$`) | `paramFieldPath` resolves the arrow's dotted path; the string form uses the literal directly | One `{ $unwind: "$<path>" }` stage. Surrounding fields are preserved (MQL-natural). For JS-faithful "just the elements", chain `.map(d => d.<path>)` after |
| `.take(n)` / `.drop(n)` | One non-negative integer literal | `take` → `$limit` (`take(0)` → an always-false `$match`, since `$limit: 0` is invalid MQL); `drop` → `$skip` (`drop(0)` emits nothing — identity) | One `{ $limit: n }` / `{ $skip: n }` |
| `.sampleSize(n)` | One integer literal ≥ 1 | `$sample` | One `{ $sample: { size: n } }` |
| `.sample()` | Zero args | `$sample` with size 1 (lodash `_.sample`; a pipeline stays a stream, so this is `.sampleSize(1)`) | One `{ $sample: { size: 1 } }` |
| `.groupBy(spec \| "<key>")` | A `$group` body object (**must contain `_id`**; every non-`_id` slot generates in `accumulatorContext: "group"` so `$addToSet`/`$push`/… pass the codegen gate — same as the direct `$group(...)` stage) **or** a bare field name | Body form lowers the object verbatim (`generateGroupBody`, per-key scoping mirrors `pipeline.ts`'s `$group` body generation); key form → `{ _id: "$<key>" }` (group by that field, no accumulators — add them via the object form) | One `{ $group: … }`. Clears the let scope (reshape). *Value-mode `$.arr.groupBy(...)` returns an object; stream-mode returns a stream of group docs* |
| `.countBy("<field>")` | One plain field-name string literal | `$sortByCount` | One `{ $sortByCount: "$<field>" }` → `{ _id, count }` per key (count-descending). Clears the let scope |
| `.uniqBy("<field>")` | One plain field-name string literal | `$group` keeping `$first` per key into the reserved `__jsmqlTmp` group slot, then `$replaceWith` to restore it. "First" follows the stream's current order — precede with `.sort(...)` when which-duplicate-wins matters | `{ $group: { _id: "$<field>", __jsmqlTmp: { $first: "$$ROOT" } } }` + `{ $replaceWith: "$__jsmqlTmp" }`. Clears the let scope |
| `.pick([fields])` | One array of field-name strings | The lodash object method, per document. Keeps ONLY the named fields — `_id` is dropped unless named (matching lodash `_.pick` + the value-mode `.pick`) | `{ $project: { <f>: 1, …, _id: 0 } }` (inclusion). Clears the let scope (the `__jsmql` scratch is dropped too) |
| `.omit([fields])` | One array of field-name strings | Drops the named fields, keeps everything else including `_id` (matching lodash `_.omit`) | `{ $project: { <f>: 0, … } }` (exclusion). Keeps the let scope |

Note: the `.map(d => <expr>)` row above also accepts the lodash property
shorthand `.map("<field>")` (≡ `.map(d => d.<field>)`), lowering to
`{ $replaceWith: "$<field>" }`.

**`.map` body must be a document.** `.map` lowers to `$replaceWith: <body>`, which
MongoDB requires to be an object root. `rejectNonDocumentMapBody` literal-gates the
body exactly like the `$ = <expr>` guard (`rejectNonDocumentReplaceRoot` in
pipeline.ts): a **provably** non-document body — a `Number`/`String`/`Boolean`/
`Null`/`RegExp`/`Array` literal — is rejected at compile time (parity with `$ = 5`),
applied to both the top-level expression path and the correlated-lookup expression
path (the block-body paths route through the shared `$ = <expr>` guard). A field ref
/ member access / operator call is **data-dependent** (the field could be a
sub-document) and passes — so `.map("userId")` / `.map(d => d.userId)` emit
`$replaceWith: "$userId"` and, if `userId` is a scalar at runtime, error on the server,
identically to `$ = $.userId`. Arithmetic bodies (`d.a + d.b`) share the same
pre-existing gap as `$ = <expr>` and are not caught (would need type inference jsmql
doesn't do for `$replaceWith`).

`.filter` is handled outside this registry (its predicate translation is shared
with `$unionWith`/`$facet`). It accepts an **arrow predicate** (`o => …`) or the
lodash **matches-object** shorthand (`{ field: value, … }` → an equality
`$match` query), and may appear **anywhere** in the chain — as the head or after
a reshaping method (`.flatMap(...).filter(...)`), not only first.

Future methods (per the planning notes) extend this table — see
[docs/DEVLOG.md](../DEVLOG.md) for the per-commit chronology.

### `.reduce` is intentionally NOT in the registry

In JS, `arr.reduce(...)` returns a single value — scalar, object, or array
depending on the reducer. So `.reduce` is rejected as a chain method (with an
actionable wrap-pattern hint in `unknownStreamMethod`), and what the reducer
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
[src/stream-methods.ts](../../src/stream-methods.ts)) and produce:

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
`'Each entry must reference acc.total'` hint, because that's the v1
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
`pipeline.ts` because the two detectors' inputs overlap — the dict-build shape
would otherwise hit the static-key error first.

### Array-returning reducer (unbracketed) → `$match` + `$replaceWith`

The third reduce form handles reducers that build a flat array of projected
docs. The reducer is seeded with `[]` and returns an array — a stream — so it
is assigned **directly**, with no surrounding `[ ]`:

```js
$$ = $$.reduce((acc, d) => (<cond> ? acc.concat(d.<field>) : acc), []);
//   → [{ $match: <cond translated> }, { $replaceWith: "$<field>" }]

$$ = $$.reduce((acc, d) => acc.concat(d.<field>), []);
//   → [{ $replaceWith: "$<field>" }]                     // unconditional map

$$ = $$.reduce((acc, d) => (<cond> ? acc.concat(d) : acc), []);
//   → [{ $match: <cond translated> }]                    // filter-only (bare `d`)
```

This form is detected by `detectArrayReducerWrap` and lowered by
`lowerArrayReducerWrap` in [src/pipeline.ts](../../src/pipeline.ts). The
lowering lives in pipeline.ts (not in stream-methods.ts) because it reuses
`lowerStreamFilterPredicate` — the same predicate translator `.filter`
uses — to handle the condition. `$.<field>` references inside the condition
are rejected with the standard "use the lambda parameter" hint.

**Supported body shapes:**

| Shape | Lowering |
|---|---|
| `acc.concat(d.<path>)` | `[{$replaceWith: "$<path>"}]` |
| `<cond> ? acc.concat(d.<path>) : acc` | `[{$match: <cond>}, {$replaceWith: "$<path>"}]` |
| `acc.concat(d)` (bare param) | `[]` (identity — surrounding docs flow through unchanged) |
| `<cond> ? acc.concat(d) : acc` | `[{$match: <cond>}]` (filter only, no projection) |

**Constraints.** Init must be `[]` (empty array) — non-empty seeds aren't
representable in MQL accumulator semantics. The ternary's alternate
branch must be bare `acc` (`<cond> ? <concat> : acc`); other alternates
break the "this either adds an element or doesn't" pattern. Spread-form
concat-equivalents (`[...acc, d.<x>]`, `acc.concat([d.<x>, d.<y>]`),
multi-element wrappers) aren't recognised in v1 — write the explicit
single-arg `.concat(d.<x>)` shape.

**Bracketed form is rejected.** `$$ = [$$.reduce(…, [])]` throws — a reducer
seeded with `[]` already produces a stream, so wrapping it in `[ ]` would
yield `[[…]]` (a stream whose single document is an array). `detectArrayReducerWrap`
detects that exact `ArrayLiteral`-of-one-`[]`-seeded-reduce shape and throws a
"drop the `[ ]`" hint. (The scalar/object wraps keep their `[ ]` because those
reducers return a single document — `[ <doc> ]` is a valid one-doc stream
literal, not a wrapped stream.)

Distinct from the two `$group`-shaped wraps above because the output is a
doc-shaped stream of projected fields, not a single summary doc.

## Error wording

Every rejection branch is co-located with the method's `validate` function so
the wording stays consistent across methods. Two general principles:

- **Name the method explicitly.** `.slice(start[, end]) requires …` beats
  `argument must be a number`.
- **Suggest the actionable alternative.** Negative indices on `.slice` get
  the "non-negative integer literals" message; computed args get the
  "write the literal in source" hint.

The chain-walker `unknownStreamMethod` helper produces the catch-all error for
method names not in the registry. Two branches:

- **Single-element methods (`.find`, `.findLast`, `.at`).** Explicitly
  rejected — pipelines are arrays, methods that return a single element in
  JS would mislead. The error names the `.slice(0, 1)` / `.slice(n, n+1)`
  equivalent. For `.find` on `$$$.<coll>`, an extra parenthetical points
  at `$ = $$$.<coll>.find(<pred>)` as the lookup-context alternative.
- **Everything else.** `closestNameTo`-style suggestion (matched against
  `.filter` plus the registered method names) followed by the full
  registered-methods list.

## Extending the registry

To add a new method:

1. Define the `StreamMethodDef` in [src/stream-methods.ts](../../src/stream-methods.ts).
2. Add it to the `STREAM_METHODS` map.
3. Add a row to the table above with the args / lowering.
4. Add tests in [test/stream-methods.test.ts](../../test/stream-methods.test.ts) for
   both contexts (`$$` and `$$$.<coll>` chain heads) plus every rejection
   branch.
5. Document the method in [docs/LANGUAGE.md#stream-methods](../LANGUAGE.md#stream-methods).
6. Add a [DEVLOG.md](../DEVLOG.md) entry.

Methods that need state from earlier in the chain (e.g. `.toReversed()` peeking
at the preceding `$sort` to flip its spec) receive `prevStages: readonly object[]`
— the read-only view of stages emitted so far in the same context. They can
return `replacesPreviousStage: true` to have the caller drop the previous stage
before appending their own.

## Bare-statement stream chains

A `$$`-rooted chain may be written as a bare statement, with no `$$ =` head:

```js
$$.filter(o => o.tier === "gold");
$$.map(d => ({ id: d._id }));
$$.toSorted((a, b) => a.age - b.age).toReversed();
```

This is sugar for the explicit `$$ = $$.<chain>;` form and lowers identically.
The detection lives in `lowerStatementTail` ([src/pipeline.ts](../../src/pipeline.ts)):
after the `$$.push(...)` / diagnostic-source-stage checks, a `collectStreamChain`
rooted at a bare `$$` (`CollectionRef`) with at least one method is handed to
the shared `applyStreamMethods` engine. Because `push` / `indexStats` are not
registered stream methods, they keep their existing meaning and never reach this
branch. Scope is the bare `$$` receiver only; a bare `$$$.<coll>.<chain>;`
statement is not a recognised form — chain on `$$`, or use the
`$$ = $$.concat($$$.<coll>.filter(…))` assignment, instead.

**The composition guarantee.** Splitting a chain across statements produces the
same MQL as chaining it, which in turn matches the assignment form:

```js
$$.filter(p).map(f);        // ≡
$$.filter(p); $$.map(f);    // ≡
$$ = $$.filter(p).map(f);
```

This holds for *every* method — including the one stage-coupled method,
`.toReversed()` — because the bare form passes the **live pipeline `out`** as
`applyStreamMethods`' working buffer, not a throwaway local array. So
`$$.toSorted(c); $$.toReversed();` finds the `$sort` emitted by the previous
statement and flips it, exactly as `$$.toSorted(c).toReversed();` does. (A bare
`$$.toReversed();` will likewise invert a preceding literal `$sort(...)` stage.)

**One documented asymmetry.** The cross-statement `.toReversed()` capability is
unique to the bare form. The assignment equivalent
`$$ = $$.toSorted(c); $$ = $$.toReversed();` still errors, because each `$$ = …`
chain lowers against its own local buffer (which is empty for the second
statement). When both forms succeed they emit identical MQL; only the bare form
reaches across statements. The bare form is the recommended concise spelling.

**JS-faithfulness note.** In plain JS `arr.filter(...)` as a statement discards
its result. The bare form gives it "transform the running stream" meaning —
syntactically valid JS (different runtime meaning is allowed; only syntax
errors are not) and consistent with the existing `$$.push(...)` statement sugar.

## Out of scope (v1)

- **Lookup-body chain extension after `.find/.filter` on `$$$.<coll>` as
  an expression (not a `$$ = …` RHS).** The existing chained-terminal
  walker in [src/lookup-translation.ts](../../src/lookup-translation.ts) handles
  `.length` and `.reduce` as terminals on a materialised slot; integrating
  the stream-methods registry into that walker (so `$$$.coll.filter(p).slice(0, 5)`
  works in expression position) is a follow-up.
- **`$$.length` terminal.** Intentionally deferred — see
  [DEVLOG.md](../DEVLOG.md) for the rationale.
