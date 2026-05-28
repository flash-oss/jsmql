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
| `.map(d => <expr>)` | One single-param expression-body arrow; `$.<field>` and lookups in body rejected | `extractLetsFromExpr` (param rewrite) + `generateWithCtx` | One `{ $replaceWith: <expr> }` stage; clears the let scope (reshape stage) |
| `.toSorted((a, b) => <cmp>)` | Two-param expression-body arrow; body built from `a.<path> - b.<path>` / `b.<path> - a.<path>` terms combined with `\|\|` | `parseComparatorBody` walks the expression, classifies each subtraction's paths, emits a `$sort` spec | One `{ $sort: { … } }` stage; key order preserved from source for compound sorts |
| `.toReversed()` | Zero args; must immediately follow a `.toSorted(...)` (or any preceding stage whose `$sort` has 1/-1 directions) in the same chain | Reads `prevStages`, flips every direction (1 ↔ -1), returns `replacesPreviousStage: true` so the caller drops the old `$sort` | One `{ $sort: { … } }` stage replacing the previous one — net stage count unchanged vs. writing `.toSorted` descending directly |
| `.flatMap(d => d.<path>)` | Single-param arrow whose expression body is a bare field-path on the param (v1) | `paramFieldPath` resolves the dotted path | One `{ $unwind: "$<path>" }` stage. Surrounding fields are preserved (MQL-natural). For JS-faithful "just the elements", chain `.map(d => d.<path>)` after |
| `.reduce((acc, d) => …, <init>)` | Two-param expression-body arrow + literal init. Body shape pattern-matched to MongoDB accumulators (`+ d.<f>` / `+ 1` → `$sum`; `Math.max(acc, d.<f>)` → `$max`; `Math.min` → `$min`) | `classifyReduceBody` returns the accumulator kind + operand; init is unused in MQL but JS-required | One `{ $group: { _id: null, value: { $<op>: … } } }` stage; output stream is a single `{_id: null, value: …}` doc. Clears the let scope (reshape stage) |

Future methods (per the planning notes) extend this table — see
[docs/DEVLOG.md](../DEVLOG.md) for the per-commit chronology.

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
