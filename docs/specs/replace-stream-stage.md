# `$$ = <expr>` → `$match` / `$match + $unionWith` stage

## Overview

`$$ = <expr>` is the jsmql surface for replacing the pipeline's document
stream. The LHS is the bare `$$` token — the current collection / stream,
the same role MQL's `$$ROOT` plays for a single document. Sister shape to
`$ = <expr>` (which replaces *one* doc → `$replaceWith`); `$$ = <expr>`
replaces the *stream* and lowers to either a `$match` (narrow) or
`$match` + `$unionWith` (switch source).

Statement-only: `$$ = <expr>` appears as a top-level pipeline statement —
either inside `[ ... ]` array-form or as a `;`-separated implicit-pipeline
statement (including inside a comma-separated update-filter chain). Using
it inside a Filter / `jsmql.expr` goes through the normal
pipeline-mode-required gate.

The trailing `;` is optional: a lone `$$ = <expr>` is Pipeline evidence on its
own, so it emits the same stages either way. See § Single statement with no
trailing `;`.

See [`docs/LANGUAGE.md#replace-stream`](../LANGUAGE.md#replace-stream-via---expr)
for the user-facing reference.

The bare statement `$$.<chain>;` is the usual spelling of a chain on the stream; the assignment form this spec covers is its explicit alternative — see
[stream-methods.md § Bare-statement stream chains](./stream-methods.md#bare-statement-stream-chains).
[stream-methods.md § Bare-statement stream chains](./stream-methods.md#bare-statement-stream-chains).

## Lowering table

| Input | Output stage(s) |
|---|---|
| `$$ = []` (drop all documents) | `[{ $match: { $expr: false } }]` |
| `$$ = [{ a: 1 }, { a: 2 }]` (as the first statement) | `[{ $documents: [{ a: 1 }, { a: 2 }] }]` |
| `$$ = $$.filter(t => t.x > 5)` | `[{ $match: { x: { $gt: 5 } } }]` — the same as the bare chain `$$.filter(t => t.x > 5);` |
| `$$ = $$.filter(t => true)` (vacuous) | `[{ $match: { $expr: true } }]` |
| `$$ = $$$.t.filter(t => t.x > 5)` (uncorrelated) | `[{ $match: { $expr: false } }, { $unionWith: { coll: "t", pipeline: [{ $match: { x: { $gt: 5 } } }] } }]` |
| `$$ = $$$.t.aggregate(t => { $match(t.x > 5); $sort({ x: -1 }); $limit(3); })` | `[{ $match: { $expr: false } }, { $unionWith: { coll: "t", pipeline: [{ $match: … }, { $sort: { x: -1 } }, { $limit: 3 }] } }]` |
| `$$ = $$$.users.filter(u => u._id === $.userId)` (correlated — the body reads the outer document) | `[{ $lookup: { from: "users", let: { jsmql_f0_userId: "$userId" }, pipeline: [{ $match: { $expr: { $eq: ["$_id", "$$jsmql_f0_userId"] } } }], as: "__jsmql.tmp.0" } }, { $unwind: "$__jsmql.tmp.0" }, { $replaceWith: "$__jsmql.tmp.0" }]` |
| `$$ = $$$$.db.coll.filter(p)` | **refused** — a cross-database source would need a `{ db, coll }` namespace, which a MongoDB server refuses; the message says to drop the `$$$$.<db>.` prefix ([lookup-stage.md](lookup-stage.md)) |

`.filter` / `.reject` take their argument through the iteratee-shorthand desugar first, so an arrow and its matches-object / field-name / `["field", value]` equivalents all lower identically here and in every other container ([desugar-pass.md](desugar-pass.md)).

## Bare `$$` as an assignment target

The parser's write check — `requirePlace` / `requireWriteTarget` in
`src/compiler/parse/parser.ts` — counts a context ref as a PLACE alongside a
`FieldRef`, a binding and a `MemberAccess` chain, so `$$ = X` parses like any
other assignment. WHICH target then means something is the emit phase's
question: `$$` is the stream, `$$$.<coll>` and `$$$$.<db>.<coll>` are `$out`
destinations ([out-stage.md](out-stage.md)), and a bare `$$$` / `$$$$` is
refused there, naming the segment that is missing.

No tokens or AST nodes of its own. The shape is `AssignExpr { target: CollectionRef, value: <expr>, pos }`.

## Lowering

`$$ = <expr>` is an `AssignExpr` whose target is the `CollectionRef`, and it is a statement wherever it stands — a lone `$$ = …` with no `;` is a pipeline by the shape rule ([filter-mode.md § The decision](filter-mode.md)), so the polymorphic and the strict entries agree; `jsmql.filter()` refuses it as it refuses every pipeline. `writeStages` in [src/compiler/emit/statement.ts](../../src/compiler/emit/statement.ts) reads the target and hands the value to one of three roads:

- **A chain on `$$`** → the stream road, `streamStages`: the same link-by-link lowering the bare statement `$$.<chain>;` gets, so the two spellings are one program ([stream-methods.md § Where a chain runs](stream-methods.md)). A predicate lowers through the filter road with the parameter as the document.
- **A chain on `$$$.<coll>`** → the join road, `joinStream` ([lookup-stage.md § The join road](lookup-stage.md)): the chain's links become the sub-pipeline; when the body read the outer document the stream is replaced per outer document (`$lookup` + `$unwind` + `$replaceWith`), else the current stream is dropped (`$match: { $expr: false }`) and the other collection's pipeline unioned in. `.find` is refused here — one document is not a stream.
- **An array literal** → `$documents`, valid only as the first statement (MongoDB places `$documents` at the head); later, `$$.push(…)` appends documents.

**Bindings after a source switch.** A `$unionWith` body has no `let`, so an outer `let` or a `$.<field>` read inside the switched-in chain is refused with the correlated form (`.filter(u => u.x === $.y)`), which lowers to `$lookup` and does carry the outer document. After the switch the documents are the other collection's, and a `let` bound before it is dropped: a later read is refused precisely (`… can't be read after \`$unionWith\` …`, [let-bindings.md](let-bindings.md)).

## Rejections

An unsupported RHS is refused with the forms that work:

| Trigger | Message excerpt |
|---|---|
| `ArrayLiteral` RHS of docs mid-pipeline (e.g. `$match(...); $$ = [{...}]`) | `'$$ = [<docs>]' is only valid as the first stage of a pipeline ('$documents' must be at the head per MongoDB). To append documents to an existing stream, use '$$.push({...}, {...}, …)' instead, which lowers to '$unionWith'.` (Note: `$$ = []` is supported — it empties the stream; `$$ = [<docs>]` at stage 0 lowers to `$documents`.) |
| `TernaryExpr` RHS (e.g. `$$ = a ? b : c`) | `'$$ = <ternary>' (conditional stream branching) is not a supported form — a stream has no single condition that swaps the whole stream for A or B. The RHS of '$$ = …' must be '$$.filter(<predicate>)' (narrow the current stream) or '$$$.<coll>.filter(<predicate>)' (switch source to another collection).` |
| `MethodCall` on `$$` / `$$$.<coll>` with method other than `filter` | `'$$ = …' RHS supports only '<recv>.filter(<predicate>)' — '.<method>(...)' is not allowed here.[ Did you mean '.filter'?] Use '<recv>.filter(<predicate>)' to <intent>, or write '$ = $$$.<coll>.find(<predicate>)' if you meant to replace each document with a single matching foreign doc.` |
| Bare `CollectionRef` / `DatabaseRef` RHS (e.g. `$$ = $$$.t`) | `'$$ = …' RHS must call a stream method. … Any lodash stream method may head the chain (e.g. '$$$.<coll>.toSorted(...).take(...)'), not only '.filter'.` |
| Anything else | `'$$ = …' RHS must be '$$.<streamMethod>…' … or '$$$.<coll>.<streamMethod>…' …; a '.filter'/'.reject' correlating on '$.<field>' promotes a source switch to a per-outer-doc '$lookup'.` |

Compound assignment (`$$ += 5`, `$$++`) is refused at parse time: the token
after `$$` has to be `.`, `[` or `=`, and the message names the expected
followers.

A predicate's parameter is the document; `$.<field>` inside it is the OUTER
document (HR4), which a `$unionWith` body cannot reach — the refusal names the
correlated `.filter`, which lowers to `$lookup` and carries it.

`$$ = [<docs>]` lowers its documents under that same `$unionWith` boundary, so the
list holds only what the program spells out — the rule and its two refusals live with
the other spelling of it in [union-stage.md § A written list of documents](union-stage.md).

## Interaction with `$set` / `$unset`

The update buffer flushes before `$$ = …`, so
`$.a = 1; $$ = $$.filter(t => t.x > 0); $.b = 2;` emits

```
[{ $set: { a: 1 } }, { $match: { x: { $gt: 0 } } }, { $set: { b: 2 } }]
```

— never one merged `$set` straddling the assignment.

For the source-switch form, subsequent `$.x = …` ops operate on the *new*
docs (from the foreign collection), not the pre-switch docs. Any prior
`let` becomes unreadable: `let cutoff = 10; $$ = $$$.t.filter(o => true); $.flagged = cutoff;`
produces `` `cutoff` is a `let` binding and can't be read after `$unionWith` … ``.

## Not supported (by design)

These RHS forms are rejected on purpose — they have no coherent JS semantics, so
they are not on the roadmap:

- **`$$ = cond ? A : B`** (stream-level ternary). A stream is many documents; there
  is no single condition that swaps the *whole* stream for A or B, so "replace the
  stream with A or B" has no JS meaning. Narrow the stream with `$$.filter(p)`, or
  switch source with `$$$.<coll>.filter(p)`.
- **`$$.find(<predicate>)`** (self-lookup on the current collection). Finding one
  document within the very stream of documents produces a value with nothing to do
  in JS expression semantics; jsmql also compiles statelessly (it doesn't know the
  current collection's name). Use an explicit `$$$.<coll>.find(...)` lookup against
  a named collection instead.
