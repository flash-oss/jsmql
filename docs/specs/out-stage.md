# `$$$.<coll> = …` / `$$$$.<db>.<coll> = …` → `$out` stage

## Overview

`$out` writes the current aggregation pipeline's documents to a destination
collection — MongoDB's canonical "save the result" stage. jsmql exposes
this as an assignment-shaped sugar so the destination is visible at a
glance:

```
$$$.warehouse_orders = $$;
// → [{ $out: "warehouse_orders" }]

$$$$.dw.archive = $$.filter(u => !u.active);
// → [{ $match: <translated u => !u.active> }, { $out: { db: "dw", coll: "archive" } }]
```

The LHS names *where* documents are written using the existing context-ref
prefixes (`$$$` = same-database, `$$$$` = cross-database / cluster). The
RHS is a chain rooted at `$$` (the current pipeline): bare `$$` writes the
stream unchanged; chained methods — `.filter(<predicate>)`, any method with a
`stream` cell ([stream-methods.md](stream-methods.md)), or a stage link
(`$$.$sort({ … })`) — contribute their stages before the trailing `$out`.

Statement-only and last-stage-only: nothing may follow the `$out` sugar in a
pipeline. The stage is FILED as the chain's terminal rather than emitted, so the
`__jsmql` cleanup precedes it and it is still written last; a later statement is
refused with a position-bearing error ("Nothing can follow '$out': it writes the
pipeline's output and the server requires it last. Move this statement above it.").

## Convention: why a distinct LHS prefix?

jsmql reserves `$ = <expr>` exclusively for *root-replacing* sugar —
`$replaceWith` and the `$facet` variant. The bare `$` LHS is the visual
signal that the document itself is being replaced. `$out` does **not**
replace root; it writes the (filtered) stream elsewhere. To keep the
asymmetry visible to readers, `$out` uses a different LHS prefix — the
destination is on the left, the source on the right. Cross-cuts:

- `$ = …` → `$replaceWith` / `$facet` (root replacement).
- `$$$.<coll> = …` / `$$$$.<db>.<coll> = …` → `$out` (write destination).
- `$$$.<coll>.find(…)` / `.filter(…)` → `$lookup` (read source).
- `$$.push(…)` → `$unionWith` (stream union).

See [`docs/specs/replace-root-stage.md`](replace-root-stage.md#convention-all-root-replacing-sugar-starts-with--) for the convention statement.

See [`docs/LANGUAGE.md#out-write-the-pipeline-to-a-collection`](../LANGUAGE.md#out-write-the-pipeline-to-a-collection) for the user-facing reference.

## Lowering table

| Input | Output stage(s) |
|---|---|
| `$$$.warehouse_orders = $$;` | `[{ $out: "warehouse_orders" }]` |
| `$$$["warehouse_orders"] = $$;` | `[{ $out: "warehouse_orders" }]` (bracket equivalent) |
| `$$$["my-coll.v2"] = $$;` | `[{ $out: "my-coll.v2" }]` (bracket is required for non-identifier names) |
| `$$$$.dw.archive = $$;` | `[{ $out: { db: "dw", coll: "archive" } }]` |
| `$$$$["dw"]["archive"] = $$;` | `[{ $out: { db: "dw", coll: "archive" } }]` |
| `$$$$.dw.archive = $$.filter(u => !u.active);` | `[{ $match: <translated body> }, { $out: { db: "dw", coll: "archive" } }]` |
| `$$$.top10 = $$.$sort({ score: -1 }).$limit(10);` | `[{ $sort: { score: -1 } }, { $limit: 10 }, { $out: "top10" }]` (chained stages) |
| `$match(<pred>); $$$.coll = $$;` | `[{ $match: <pred> }, { $out: "coll" }]` (preceding stages compose normally) |

## The target

`outTarget` in [src/compiler/emit/statement.ts](../../src/compiler/emit/statement.ts) reads an `AssignExpr` whose target is rooted at `$$$` (the current database) or `$$$$` (the cluster) through dot or string-literal-bracket steps:

- `$$$.<coll>` / `$$$["<coll>"]` — exactly one step: the collection in the current database.
- `$$$$.<db>.<coll>` (any bracket combination) — exactly two steps: a database and a collection.
- A name may also be a `jsmql.compile` parameter or template slot holding a string (`$$$[coll] = $$`), because the value is known when the pipeline is built.

Everything else is refused, each with the form that works: a computed bracket (`$$$[$.x] = $$` — "The collection is named when the pipeline is written: '$$$.<coll>' or '$$$["<coll>"]'. To choose it at run time, build the pipeline with 'jsmql.compile' and pass the name in."), too many segments (`$$$.a.b = $$` — "Too many segments for a collection to write: one name for the current database ('$$$.<coll> = $$'), a database and a name for another ('$$$$.<db>.<coll> = $$')."), a database alone (`$$$$.db = $$` — "'$$$$.<db>' names a database; write the collection too …").

The target's shape is unambiguous against its neighbours: `$ = …` has the bare-`$` target, a field write a `$.`-rooted one, and a join (`$$$.<coll>.find(…)`) is a value, never a target.

## Validation

| Trigger | Message (excerpt) |
|---|---|
| `$$$.<a>.<b> = …` (three `$`, two LHS segments) | `'$$$.<a>.<b>' has too many segments for a same-database \$out target — use '$$$$.<db>.<coll>' (four $) for a cross-database write, or '$$$.<coll>' (three $) for the local database.` |
| `$$$$.<x> = …` (four `$`, one LHS segment) | `'$$$$.<x>' is missing the collection — write '$$$$.<db>.<coll>' (db, then collection), or use '$$$.<coll>' (three $) for the local database.` |
| `$$$$.<a>.<b>.<c> = …` (three or more segments) | `Too many segments for a collection to write: one name for the current database ('$$$.<coll> = $$'), a database and a name for another ('$$$$.<db>.<coll> = $$').` |
| `$$$[<non-literal>] = …` (computed bracket on the LHS) | `The collection is named when the pipeline is written: '$$$.<coll>' or '$$$["<coll>"]'. To choose it at run time, build the pipeline with 'jsmql.compile' and pass the name in.` |
| RHS not rooted at `$$` (e.g. `$$$.coll = $.x`) | `The right-hand side of '$$$.<coll> = …' must start with '$$' (the current pipeline). Write '$$$.<coll> = $$' to write the current stream as-is, or '$$$.<coll> = $$.filter(<predicate>)' to pre-filter before writing.` |
| A link whose row has no `stream` cell | the stream road's refusal, with the nearest name that has one ([stream-methods.md](stream-methods.md)) |
| `$$.filter(<predicate>)` arity wrong | `'$$.filter(<predicate>)' takes exactly one predicate argument, got N.` |
| `$$.filter(<not-a-predicate>)` | `'$$.filter(<predicate>)' in a '\$out' write chain takes a single arrow predicate ('o => …'), a matches-object ('{ active: true }'), a field name ('"active"'), or a ["field", value] pair.` (shared gate — see [emit-pass.md](emit-pass.md)) |
| `$.x` inside the `$$.filter` predicate | `$.` is the document the predicate runs over (HR4), so it lowers like the parameter — no refusal; the two spellings mean the same field |
| A statement after the `$out` sugar in the same pipeline | `Nothing can follow '$out': it writes the pipeline's output and the server requires it last. Move this statement above it.` |
| Two `$$$.<coll> = …` statements in one pipeline | The same refusal — the second follows the first. |
| `$$$.<coll> = …` inside `jsmql.filter(…)` / `jsmql.expr(…)` | Refused as a write: `… but received a write (\`$.x = …\`, \`delete $.x\`). Use jsmql.update() for an update document, or jsmql.pipeline() for a \`$set\` / \`$unset\` pipeline.` |
| `$$$.<coll> = …` inside `jsmql.update(…)` | `A document-form update writes a field of the document: '$.a = …', '$.a.b += 1', 'delete $.a'.` |

All errors carry a meaningful `.pos` (target node's `pos` for LHS shape
errors, RHS node's `pos` for chain errors, offending later statement's
`pos` for the trailing-stage guard).

## The chain

The RHS is lowered by the stream road (`streamStages` in [src/compiler/emit/statement.ts](../../src/compiler/emit/statement.ts)): each link's `stream` cell appends its stages to the pipeline, in source order, and the `$out` is filed as the terminal. So a `$out` chain accepts exactly the links a bare `$$.<chain>;` accepts, and lowers each to the same MQL — a stage link (`$$.$sort({ … })`) is the stage, `.filter(p)` / `.reject(p)` lower through the filter road with the parameter as the document (`$$$.live = $$.reject(p)` emits the same negated `$match` that `$$.reject(p);` does), `.take(n)` is `$limit`, and a second write stage in the chain is refused because the `$out` always follows.

Adding a chain method is not a `$out`-specific change: give the method's row a `stream` cell ([stream-methods.md § Adding a method](stream-methods.md)) and every head — the bare stream, a join, a `$out` chain — reads it.

## Mode gates

`$out` sugar is **Pipeline-mode only**:

| Entry point | Behaviour |
|---|---|
| `jsmql("…")`, with or without `;` | Allowed — a write is a pipeline by the shape rule ([filter-mode.md § The decision](filter-mode.md)). |
| `jsmql.pipeline("…")` | Allowed. |
| `jsmql.filter("…")` / `jsmql.expr("…")` | Refused as a write, with `jsmql.pipeline()` named. |
| `jsmql.update("…")` | Refused: "A document-form update writes a field of the document: '$.a = …', '$.a.b += 1', 'delete $.a'." |

## Parser interaction

The parser ([`src/compiler/parse/parser.ts`](../../src/compiler/parse/parser.ts)) accepts a write target rooted at `$$$` / `$$$$` through `MemberAccess` / `IndexAccess` steps — a shape check only; the segment-count and computed-bracket refusals are the emit phase's — and a bare `$$` as a value, so `$$$.coll = $$` has its RHS. The typo `$$foo` (no separator, an identifier next) is still refused at parse time, and bare `$$$` / `$$$$` have no meaning anywhere.

No new tokens, no new AST nodes.

## Deferred

- **`$merge` sugar.** MongoDB has both `$out` (full replace) and
  `$merge` (upsert / merge into existing docs). The corresponding sugar
  might look like `$$$.coll += $$;` (compound assign — "merge into") to
  preserve the destination-on-the-left mental model, but the four merge-
  control fields (`on`, `whenMatched`, `whenNotMatched`, `let`) need a
  more careful design pass. Out of scope for now.

## Design notes

- **Multi-method RHS chains.** The stream road lowers every link through its row's
  `stream` cell, so methods compose freely before the trailing `$out` — see
  [The chain](#the-chain).
- **Bound destination via `jsmql.compile`.** `$$$[boundColl] = $$` resolves the
  bracket index when the pipeline is built, from a string-valued parameter; any other
  value is refused as a collection name.
- **No scope-clearing after `$out`.** `$out` is the chain's terminal, so the
  in-pipeline binding scope is irrelevant after it; a later statement is refused
  before it could read anything.
