# Writing a collection — `$out` and `$merge`

## Overview

MongoDB writes a pipeline's documents into a collection with two stages. The
difference is what happens to the documents already there. `$out` REPLACES the
collection: everything it held is gone. `$merge` ADDS to it: the server updates
the documents whose `_id` matches, and inserts the rest. JSMQL spells the
difference as `=` against `+=`, so the destination and the intent are both
visible at a glance:

```
$$$.warehouse_orders = $$;
// → [{ $out: "warehouse_orders" }]

$$$.metrics += $$;
// → [{ $merge: "metrics" }]

$$$$.dw.archive = $$.filter(u => !u.active);
// → [{ $match: <translated u => !u.active> }, { $out: { db: "dw", coll: "archive" } }]
```

`$merge` has a second spelling, in the JavaScript verbs that mean "add to this":

```
$$$.metrics.concat($$.filter(d => d.active));
// → [{ $match: <translated d => d.active> }, { $merge: "metrics" }]
```

The verbs keep their JavaScript meanings. This is what lets them write an ARRAY
of documents where `+=` takes only the stream. `.concat(xs)` splices a list in,
so every element of `xs` becomes a document. `.push(...xs)` says the same, with
the spread. `.push(x)` without the spread appends x itself, so x IS the
document:

```
$$$.metrics.concat($.items);
$$$.metrics.push(...$.items);
// both → [{ $set: { "__jsmql.tmp.0": "$items" } },
//         { $unwind: "$__jsmql.tmp.0" },
//         { $replaceWith: "$__jsmql.tmp.0" },
//         { $merge: "metrics" }]

$$$.metrics.push($.summary);
// → [{ $replaceWith: "$summary" }, { $merge: "metrics" }]
```

Those first three stages are the ones `$$ = <array>;` already emits — one function
builds both, so the two spellings cannot drift apart.

The sugar covers the PLAIN merge only. `$merge`'s four settings — `on`,
`whenMatched`, `whenNotMatched`, `let` — are written as the stage itself, and
that needs no sugar: `$merge({ into: "metrics", on: "_id", whenMatched: "merge" });`.

The LHS names *where* documents are written, using the existing context-ref
prefixes (`$$$` = same-database, `$$$$` = cross-database / cluster). The RHS
is a chain rooted at `$$` (the current pipeline). Bare `$$` writes the stream
unchanged. Chained methods — `.filter(<predicate>)`, any method with a
`stream` cell ([stream-methods.md](stream-methods.md)), or a stage link
(`$$.$sort({ … })`) — contribute their stages before the trailing `$out`.

Statement-only and last-stage-only: nothing may follow the `$out` sugar in a
pipeline. The compiler FILES the stage as the chain's terminal, rather than
emitting it, so the `__jsmql` cleanup precedes it, and it is still written
last. The compiler refuses a later statement with a position-bearing error,
and the message names the fix: move the statement above the write.

## Convention: why a distinct LHS prefix?

JSMQL reserves `$ = <expr>` exclusively for *root-replacing* sugar —
`$replaceWith` and the `$facet` variant. The bare `$` LHS is the visual
signal that the document itself is replaced. `$out` does **not**
replace root; it writes the (filtered) stream elsewhere. To keep the
asymmetry visible to readers, `$out` uses a different LHS prefix: the
destination is on the left, and the source is on the right. Cross-cuts:

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
| `$$$["my-coll.v2"] = $$;` | `[{ $out: "my-coll.v2" }]` (non-identifier names need brackets) |
| `$$$$.dw.archive = $$;` | `[{ $out: { db: "dw", coll: "archive" } }]` |
| `$$$$["dw"]["archive"] = $$;` | `[{ $out: { db: "dw", coll: "archive" } }]` |
| `$$$$.dw.archive = $$.filter(u => !u.active);` | `[{ $match: <translated body> }, { $out: { db: "dw", coll: "archive" } }]` |
| `$$$.top10 = $$.$sort({ score: -1 }).$limit(10);` | `[{ $sort: { score: -1 } }, { $limit: 10 }, { $out: "top10" }]` (chained stages) |
| `$match(<pred>); $$$.coll = $$;` | `[{ $match: <pred> }, { $out: "coll" }]` (preceding stages compose normally) |
| `$$$.metrics += $$;` | `[{ $merge: "metrics" }]` (`+=` ADDS; `=` replaces) |
| `$$$$.dw.metrics += $$;` | `[{ $merge: { db: "dw", coll: "metrics" } }]` |
| `$$$.metrics += $$.filter(d => d.active);` | `[{ $match: <translated body> }, { $merge: "metrics" }]` |
| `$$$.metrics.concat($$);` | `[{ $merge: "metrics" }]` (the verb spelling of `+=`) |
| `$$$.metrics.push(...$$);` | `[{ $merge: "metrics" }]` |
| `$$$.metrics.concat($.items);` | `[{ $set: … }, { $unwind: … }, { $replaceWith: … }, { $merge: "metrics" }]` (an ARRAY, element by element) |
| `$$$.metrics.push(...$.items);` | the same four stages |
| `$$$.metrics.push($.summary);` | `[{ $replaceWith: "$summary" }, { $merge: "metrics" }]` (no spread — ONE document) |

## The target

`outTarget` in [src/compiler/emit/statement.ts](../../src/compiler/emit/statement.ts) reads an `AssignExpr`. Its target is rooted at `$$$` (the current database) or `$$$$` (the cluster), through dot or string-literal-bracket steps:

- `$$$.<coll>` / `$$$["<coll>"]` — exactly one step: the collection in the current database.
- `$$$$.<db>.<coll>` (any bracket combination) — exactly two steps: a database and a collection.
- A name may also be a `jsmql.compile` parameter or template slot holding a string (`$$$[coll] = $$`), because the value is known when the pipeline is built.

The compiler refuses everything else, each with the form that works:

- a computed bracket (`$$$[$.x] = $$`) — the compiler must know the name when it builds the pipeline. The message names the literal forms, and `jsmql.compile` for a name chosen at run time.
- too many segments (`$$$.a.b = $$`) — the message names `$$$.<coll> = $$` for the current database, and `$$$$.<db>.<coll> = $$` for another.
- a database alone (`$$$$.db = $$`) — the message asks for the collection too.

The target's shape is unambiguous against its neighbours. `$ = …` has the bare-`$` target. A field write has a `$.`-rooted target. A join (`$$$.<coll>.find(…)`) is a value, never a target.

## Validation

| Trigger | The refusal |
|---|---|
| `$$$.<a>.<b> = …` (three `$`, two LHS segments) | too many segments; the message names `$$$$.<db>.<coll>` for another database, and `$$$.<coll>` for the current one |
| `$$$$.<x> = …` (four `$`, one LHS segment) | the collection is missing; the message names `$$$$.<db>.<coll>`, and `$$$.<coll>` for the current database |
| `$$$$.<a>.<b>.<c> = …` (three or more segments) | too many segments, with the same two forms |
| `$$$[<non-literal>] = …` (computed bracket on the LHS) | the compiler must know the name when it builds the pipeline; the message names the literal forms and `jsmql.compile` |
| RHS not rooted at `$$` (for example `$$$.coll = $.x`) | the right side must be the stream; the message names the forms that work |
| A link whose row has no `stream` cell | the stream road's refusal, with the nearest name that a `$$` receiver accepts ([stream-methods.md](stream-methods.md)) |
| `$$.filter(<predicate>)` arity wrong | the arity refusal: `.filter` takes one predicate |
| `$$.filter(<not-a-predicate>)` | the message names the predicate spellings that work (shared gate — see [emit-pass.md](emit-pass.md)) |
| `$.x` inside the `$$.filter` predicate | `$.` is the document the predicate runs over (HR4), so it lowers like the parameter — no refusal; the two spellings mean the same field |
| A statement after the `$out` sugar in the same pipeline | the write must be last; the message asks to move the statement above it |
| Two `$$$.<coll> = …` statements in one pipeline | The same refusal — the second follows the first. |
| `$$$.<coll> = …` inside `jsmql.filter(…)` / `jsmql.expr(…)` | Refused as a write; the message names `jsmql.update()` and `jsmql.pipeline()`. |
| `$$$.<coll> = …` inside `jsmql.update(…)` | a document-form update writes only fields of the document |

| `$merge({ into: "c", whenMatched: [$sort({ a: 1 })] })` — a stage an update spec does not run | that body is an update, not a pipeline, and the server runs there only the stages listed below |
| `$merge({ into: "c", let: { v: $$.size() } })` — the stage that writes the output reading a materialised value | the scratch field is gone before the last stage runs; the message names `$.n = $$.size();` first, then a read of `$.n` |

**`whenMatched` is an UPDATE, not a pipeline.** MEASURED on mongod: `$addFields`,
`$set`, `$project`, `$unset`, `$replaceRoot`, `$replaceWith` and `$fill` run
there, one stage per run with a valid body. The server refuses every other stage
there. The `$merge` row states that set
as its `statementBody`. `place` refuses a stage the set does not name.
[test/compiler-statement.test.ts](../../test/compiler-statement.test.ts) asks
the server the same question and compares the two answers, so the row cannot
drift from the deployment.

(`$fill` is on the list because its constant form runs. A `$fill` body that
states `sortBy` desugars server-side to a `$sort`, and the server refuses it
there. JSMQL cannot see that desugar, so it emits the body as written, and the
server names `$sort`.)

A stage the row files as LAST does not emit where it stands. The compiler
files it on the chain, so nothing can land after it, and the `__jsmql` cleanup
always precedes it ([emit-pass.md](emit-pass.md)). That order is what the
last row above enforces: a body that reads a scratch field would read one the
`$unset` has already dropped, and MEASURED, the server refuses the read.

All errors carry a meaningful `.pos` (target node's `pos` for LHS shape
errors, RHS node's `pos` for chain errors, offending later statement's
`pos` for the trailing-stage guard).

## The chain

The stream road lowers the RHS (`streamStages` in [src/compiler/emit/statement.ts](../../src/compiler/emit/statement.ts)). Each link's `stream` cell appends its stages to the pipeline, in source order, and the compiler files the `$out` as the terminal.

So a `$out` chain accepts exactly the links a bare `$$.<chain>;` accepts, and it lowers each to the same MQL: a stage link (`$$.$sort({ … })`) is the stage, `.filter(p)` / `.reject(p)` lower through the filter road with the parameter as the document (`$$$.live = $$.reject(p)` emits the same negated `$match` that `$$.reject(p);` does), and `.take(n)` is `$limit`. The compiler refuses a second write stage in the chain, because the `$out` always follows.

Adding a chain method is not a change specific to `$out`. Give the method's row a `stream` cell ([stream-methods.md § Adding a method](stream-methods.md)), and every head — the bare stream, a join, a `$out` chain — reads it.

## Mode gates

`$out` sugar is **Pipeline-mode only**:

| Entry point | Behaviour |
|---|---|
| `jsmql("…")`, with or without `;` | Allowed — a write is a pipeline by the shape rule ([filter-mode.md § The decision](filter-mode.md)). |
| `jsmql.pipeline("…")` | Allowed. |
| `jsmql.filter("…")` / `jsmql.expr("…")` | Refused as a write; the message names `jsmql.pipeline()` instead. |
| `jsmql.update("…")` | Refused: a document-form update writes only fields of the document, and the message names field writes that work. |

## Parser interaction

The parser ([`src/compiler/parse/parser.ts`](../../src/compiler/parse/parser.ts)) accepts a write target rooted at `$$$` / `$$$$` through `MemberAccess` / `IndexAccess` steps. This is a shape check only; the segment-count and computed-bracket refusals belong to the emit phase. The parser also accepts a bare `$$` as a value, so `$$$.coll = $$` has its RHS.

The parser still refuses the typo `$$foo` (no separator, an identifier next) at parse time, and bare `$$$` / `$$$$` have no meaning anywhere.

No new tokens, no new AST nodes.

## Design notes

- **Multi-method RHS chains.** The stream road lowers every link through its row's
  `stream` cell, so methods compose freely before the trailing `$out` — see
  [The chain](#the-chain).
- **Bound destination by `jsmql.compile`.** `$$$[boundColl] = $$` resolves the
  bracket index when the pipeline is built, from a string-valued parameter. The
  compiler refuses any other value as a collection name.
- **No scope-clearing after `$out`.** `$out` is the chain's terminal, so the
  in-pipeline binding scope is irrelevant after it. The compiler refuses a
  later statement before it could read anything.
