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

Two contexts share the same registry. Both currently live in
`lowerReplaceStream` in [src/pipeline.ts](../../src/pipeline.ts):

| Context | Chain head | Lowering site |
|---|---|---|
| **`$$ = $$.<chain>;`** | Bare `$$` (or `$$.filter(<pred>)` as the first method) | Each registry method appends one or more stages to the outer pipeline. |
| **`$$ = $$$.<coll>.<chain>;`** | `$$$.<coll>` (or with `.filter(<pred>)` as the first method) | Each registry method appends stages inside the `$unionWith.pipeline` body of the emitted `$limit: 0` + `$unionWith` pair. |

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
| `.map(d => <expr>)` | One single-param expression-body arrow; `$.<field>` rejected ("use the lambda param") and `$$.push(...)` in body rejected. Embedded `$$$.<coll>.find/filter(...)` lookups are supported in both stream contexts | `extractLetsFromExpr` (rewrites `d.<path>` → bare field paths) + `extractLookupCalls` (materialises embedded lookups into `__jsmql.__lookup<N>` slots) + `generateWithCtx` | Prologue stages from `extractLookupCalls` (zero or more `$lookup` + `$set`-with-`$first` pairs) followed by one `{ $replaceWith: <expr> }`. In the `$$$.<coll>.<chain>` context the prologue lands inside the outer `$unionWith.pipeline` — the inner `$lookup` correlates against the sub-pipeline's local doc (the foreign collection), not any outer-pipeline `let` binding, so let-coordination across the nesting doesn't apply. Clears the let scope (reshape stage) |
| `.toSorted((a, b) => <cmp>)` | Two-param expression-body arrow; body built from `a.<path> - b.<path>` / `b.<path> - a.<path>` terms combined with `\|\|` | `parseComparatorBody` walks the expression, classifies each subtraction's paths, emits a `$sort` spec | One `{ $sort: { … } }` stage; key order preserved from source for compound sorts |
| `.toReversed()` | Zero args; must immediately follow a `.toSorted(...)` (or any preceding stage whose `$sort` has 1/-1 directions) in the same chain | Reads `prevStages`, flips every direction (1 ↔ -1), returns `replacesPreviousStage: true` so the caller drops the old `$sort` | One `{ $sort: { … } }` stage replacing the previous one — net stage count unchanged vs. writing `.toSorted` descending directly |
| `.flatMap(d => d.<path>)` | Single-param arrow whose expression body is a bare field-path on the param (v1) | `paramFieldPath` resolves the dotted path | One `{ $unwind: "$<path>" }` stage. Surrounding fields are preserved (MQL-natural). For JS-faithful "just the elements", chain `.map(d => d.<path>)` after |

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

Multiple aggregates in either form share **one** `$group` stage. Richer
per-key body shapes (`$avg` paired with a running count, cross-key references,
multiplicative accumulators) are not yet recognised — write the `$group` stage
by hand for those.

### Dictionary-build reducer wrap → `$group` + `$arrayToObject`

`$$ = [$$.reduce((acc, d) => ({ ...acc, [d.<keyPath>]: <d.<valPath>|d> }), {})];`

The single-computed-key form of the object-returning reducer. Distinct from
the static-key object-reducer above (where the user names every accumulator at
compile time) because here the **keys come from runtime data** — one input
doc, one output entry, both key and value read off the doc. Lowers to:

```js
[
  { $group: { _id: null, __jsmqlDict: { $push: { k: "$<keyPath>", v: "$<valPath>"|"$$ROOT" } } } },
  { $replaceWith: { $arrayToObject: "$__jsmqlDict" } }
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

## Out of scope (v1)

- **Statement-level chain head as a bare statement.** Inputs still require
  the explicit `$$ = $$.<chain>;` form; a bare `$$.<chain>;` top-level
  statement is rejected as "not a recognised stage" exactly as before.
- **Lookup-body chain extension after `.find/.filter` on `$$$.<coll>` as
  an expression (not a `$$ = …` RHS).** The existing chained-terminal
  walker in [src/lookup-translation.ts](../../src/lookup-translation.ts) handles
  `.length` and `.reduce` as terminals on a materialised slot; integrating
  the stream-methods registry into that walker (so `$$$.coll.filter(p).slice(0, 5)`
  works in expression position) is a follow-up.
- **`$$.length` terminal.** Intentionally deferred — see
  [DEVLOG.md](../DEVLOG.md) for the rationale.
