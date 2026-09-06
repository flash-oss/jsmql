# Strict-shape entry points

## What this covers

The three strict-shape variants of `jsmql()` exported from [src/index.ts](../../src/index.ts):

- `jsmql.filter(input)` — returns a Filter document; throws on any Pipeline-shaped input.
- `jsmql.pipeline(input)` — returns a Pipeline stage array; throws on a bare expression that would lower to a Filter.
- `jsmql.update(input)` — returns the update DOCUMENT `db.coll.updateOne(filter, update)` takes: the object form (`{ $set: …, $inc: …, $push: … }`), every value a compile-time constant. Writes become their operators (`$.n += 2` → `$inc`, `$.tags.push(x)` → `$push`, `delete $.a` → `$unset`, …); a value computed from the document is refused with the pipeline form — see [update-filter.md § The update document](update-filter.md).

`jsmql.expr(input)` is the fourth shape: one aggregation expression, no Filter wrapper and no `$expr` envelope; it refuses a stage, a write and a stream chain, naming the entry that takes each.

User-facing reference: [docs/LANGUAGE.md → Strict-shape entry points](../LANGUAGE.md#strict-shape-entry-points-jsmqlfilter-jsmqlpipeline-jsmqlupdate).

## Why they exist

`jsmql()` is polymorphic — it dispatches Filter or Pipeline from the shape of the parsed program (see [filter-mode.md](filter-mode.md)). The polymorphic surface is the right default when the same source may legitimately be either; a driver call site that takes exactly one shape wants a silent mis-dispatch to be an error instead. The strict entries add no lowering of their own: they narrow what is accepted.

## Dispatch

Every entry runs the same passes — lex, parse, inject the call's values, fold, desugar, position — and one `lowerMode(mode, api, program, values)` in [src/index.ts](../../src/index.ts) picks the road by `mode`:

| Mode | Entry | Accepts | Lowers through |
|---|---|---|---|
| `auto` | `jsmql()`, `jsmql.compile` | anything | the shape rule ([shape.ts](../../src/compiler/passes/shape.ts)): a filter program to the filter road, a pipeline program to the statement road |
| `filter` | `jsmql.filter` | a filter-shaped program | the filter road ([filter.ts](../../src/compiler/emit/filter.ts)) |
| `pipeline` | `jsmql.pipeline` | a pipeline-shaped program | the statement road ([statement.ts](../../src/compiler/emit/statement.ts)) |
| `update` | `jsmql.update` | a `,`-run of writes and update operators | the update document ([update.ts](../../src/compiler/emit/update.ts)) |
| `expr` | `jsmql.expr` | one expression, or a `const` prelude and one expression | the value road ([lower.ts](../../src/compiler/emit/lower.ts)) |

A program of the other shape is refused by `wrongShape(api, received)`, whose message names the entry, what it expects, what it received and the entry that takes it — the same sentence for the one-shot call, the `.compile` builder (spelled as the builder, `jsmql.filter.compile()`) and the CLI shape flags.

```
jsmql.filter("$match($.age > 18)")
// ✗ jsmql.filter() expects a Filter (the document `db.coll.find(filter)` takes), but received a top-level '$match' stage call. Use jsmql.pipeline().

jsmql.pipeline("$.age > 18")
// ✗ jsmql.pipeline() expects a Pipeline (the stage array `db.coll.aggregate(pipeline)` takes), but received a bare expression that would lower to a Filter (`$.age > 18`). Use jsmql.filter() for a Filter, or wrap the predicate as `$match(…)` for a Pipeline.

jsmql.expr("$.score = 100")
// ✗ jsmql.expr() expects an aggregation expression (the value of a stage field, `jsmql.expr`), but received a write (`$.x = …`, `delete $.x`). Use jsmql.update() for an update document, or jsmql.pipeline() for a `$set` / `$unset` pipeline.
```

The update road refuses on its own terms, because an update document is not a shape the shape rule knows: a value computed from the document ("A document-form update takes constants: the server reads '$b' there as the string, not the field. To compute from the document, use the pipeline form …"), a stage ("'$match' is not valid in an update document — see its 'where'."), and anything that is neither a write nor an update operator — `assert`, a join, `$$.push`, a stream chain ("An update document is made of writes — '$.a = 1', '$.n += 2', 'delete $.b', '$.tags.push(x)' — or of update operators ('$inc({ n: 2 })', '{ $set: { a: 1 } }'). This is neither.").

## Parameterised form: `*.compile`

Each strict entry carries a `.compile` builder — `jsmql.filter.compile`, `jsmql.pipeline.compile`, `jsmql.update.compile`, and `jsmql.expr.compile` — the parse-once / bind-many form of that entry, narrowed to the same output type. The arrow is parsed once (eagerly); the returned closure injects the per-call values as `Injected` nodes ([inject.ts](../../src/compiler/passes/inject.ts)) and runs the same `lowerMode`, so the shape contract is re-enforced on every call with the identical message. Binding mechanics — the destructure pattern, the refused values (`undefined`, a function, a symbol, a non-finite number, a circular structure), values as literals never syntax — are those of `jsmql.compile`; see [function-form-params.md](function-form-params.md). The one per-builder difference is the wrong-input-type `TypeError`, which names the builder (`jsmql.filter.compile() expects an arrow function …`).

The CLI uses these for `--arg` / `--argjson` combined with a shape flag — see [cli.md § Parameters](cli.md). `jsmql.validate` accepts a parameterised-arrow string directly (validating its shape with the bound values stubbed to `null`), so `--validate` with params needs no separate `validate.compile`.

## Error messages

Every rejection carries the offending node's position, so editor tooling can underline the source region. The messages follow the DX rules in the root `CLAUDE.md`:

- **Name the API.** Every error starts with `jsmql.filter()` / `jsmql.pipeline()` / `jsmql.update()` / `jsmql.expr()` — the user knows which call to look at.
- **Name the shape that was found.** A `;`-separated Pipeline, a write, a stream chain, a top-level '$match' stage call — not a generic "wrong shape" complaint.
- **Suggest the right call.** Each error names an alternative: the other strict entry, the polymorphic `jsmql()`, or — when the user almost certainly wrote a `$match` by reflex — drop the wrapper and call `jsmql.filter()` on the predicate directly.

## When to update this spec

- A new program shape (beyond expression, write, `Pipeline`) — extend the mode table and the shape rule in [filter-mode.md](filter-mode.md).
- A change to what an update document takes — the table in [update-filter.md](update-filter.md) and the refusals above.
- A change to the polymorphic `jsmql()` dispatch — make sure the strict entries still mirror the same accept/reject decisions, with `throw` in place of the other road.
