# Strict-shape entry points

## What this covers

The three strict-shape variants of `jsmql()` exported from [src/index.ts](../../src/index.ts):

- `jsmql.filter(input)` — returns a Filter document; throws on any Pipeline-shaped input.
- `jsmql.pipeline(input)` — returns a Pipeline stage array; throws on a bare expression that would lower to a Filter.
- `jsmql.update(input)` — returns the update DOCUMENT that `db.coll.updateOne(filter, update)` takes: the object form (`{ $set: …, $inc: …, $push: … }`), where every value is a compile-time constant. Writes become their operators (`$.n += 2` → `$inc`, `$.tags.push(x)` → `$push`, `delete $.a` → `$unset`, …). The document form refuses a value computed from the document; use the pipeline form instead — see [update-filter.md § The update document](update-filter.md).

`jsmql.expr(input)` is the fourth shape. It returns one aggregation expression, with no Filter wrapper and no `$expr` envelope. It refuses a stage, a write, and a stream chain. Each refusal names the entry that takes that construct.

User-facing reference: [docs/LANGUAGE.md → Strict-shape entry points](../LANGUAGE.md#strict-shape-entry-points-jsmqlfilter-jsmqlpipeline-jsmqlupdate).

## Why they exist

`jsmql()` is polymorphic. It dispatches a Filter or a Pipeline from the shape of the parsed program (see [filter-mode.md](filter-mode.md)). The polymorphic surface is the right default when the same source can legitimately be either shape. A driver call site that takes exactly one shape wants a silent wrong dispatch to become an error instead. The strict entries add no lowering of their own; they only narrow what the entry accepts.

## Dispatch

Every entry runs the same passes: lex, parse, inject the call's values, fold, desugar, and position. One function, `lowerMode(mode, api, program, values)` in [src/index.ts](../../src/index.ts), picks the road by `mode`:

| Mode | Entry | Accepts | Lowers through |
|---|---|---|---|
| `auto` | `jsmql()`, `jsmql.compile` | anything | the shape rule ([shape.ts](../../src/compiler/passes/shape.ts)): a filter program to the filter road, a pipeline program to the statement road |
| `filter` | `jsmql.filter` | a filter-shaped program | the filter road ([filter.ts](../../src/compiler/emit/filter.ts)) |
| `pipeline` | `jsmql.pipeline` | a pipeline-shaped program | the statement road ([statement.ts](../../src/compiler/emit/statement.ts)) |
| `update` | `jsmql.update` | a `,`-run of writes and update operators | the update document ([update.ts](../../src/compiler/emit/update.ts)) |
| `expr` | `jsmql.expr` | one expression, or a `const` prelude and one expression | the value road ([lower.ts](../../src/compiler/emit/lower.ts)) |

The function `wrongShape(api, received)` refuses a program of the other shape. Its message names the entry, what it expects, what it received, and the entry that takes it. The message stays the same for the one-shot call, the `.compile` builder (spelled as the builder, `jsmql.filter.compile()`), and the CLI shape flags.

```
jsmql.filter("$match($.age > 18)")
// ✗ jsmql.filter() expects a Filter (the document `db.coll.find(filter)` takes), but received a top-level '$match' stage call. Use jsmql.pipeline().

jsmql.pipeline("$.age > 18")
// ✗ jsmql.pipeline() expects a Pipeline (the stage array `db.coll.aggregate(pipeline)` takes), but received a bare expression that would lower to a Filter (`$.age > 18`). Use jsmql.filter() for a Filter, or wrap the predicate as `$match(…)` for a Pipeline.

jsmql.expr("$.score = 100")
// ✗ jsmql.expr() expects an aggregation expression (the value of a stage field, `jsmql.expr`), but received a write (`$.x = …`, `delete $.x`). Use jsmql.update() for an update document, or jsmql.pipeline() for a `$set` / `$unset` pipeline.
```

The update road refuses on its own terms, because the shape rule does not know an update document as a shape. It refuses three cases: a value computed from the document ("A document-form update takes constants: the server reads '$b' there as the string, not the field. To compute from the document, use the pipeline form …"); a stage ("'$match' is not valid in an update document — see its 'where'."); and anything that is neither a write nor an update operator, such as `assert`, a join, `$$.push`, or a stream chain ("An update document is made of writes — '$.a = 1', '$.n += 2', 'delete $.b', '$.tags.push(x)' — or of update operators ('$inc({ n: 2 })', '{ $set: { a: 1 } }'). This is neither.").

## Parameterised form: `*.compile`

Each strict entry carries a `.compile` builder: `jsmql.filter.compile`, `jsmql.pipeline.compile`, `jsmql.update.compile`, and `jsmql.expr.compile`. Each is the parse-once, bind-many form of that entry, narrowed to the same output type. The compiler parses the arrow once, eagerly. The returned closure injects the per-call values as `Injected` nodes ([inject.ts](../../src/compiler/passes/inject.ts)) and runs the same `lowerMode`, so the shape contract applies again on every call, with the identical message. The binding mechanics come from `jsmql.compile`: the destructure pattern, the refused values (`undefined`, a function, a symbol, a non-finite number, a circular structure), and values as literals, never as syntax; see [function-form-params.md](function-form-params.md). The one difference per builder is the wrong-input-type `TypeError`, which names the builder (`jsmql.filter.compile() expects an arrow function …`).

The CLI uses these builders for `--arg` / `--argjson`, combined with a shape flag — see [cli.md § Parameters](cli.md). `jsmql.validate` accepts a parameterised-arrow string directly. It validates the shape with the bound values stubbed to `null`, so `--validate` with params needs no separate `validate.compile`.

## Error messages

Every rejection carries the offending node's position, so editor tooling can underline the source region. The messages follow the DX rules in the root `CLAUDE.md`:

- **Name the API.** Every error starts with `jsmql.filter()` / `jsmql.pipeline()` / `jsmql.update()` / `jsmql.expr()` — the user knows which call to look at.
- **Name the shape that was found.** A `;`-separated Pipeline, a write, a stream chain, a top-level '$match' stage call — not a generic "wrong shape" complaint.
- **Suggest the right call.** Each error names an alternative: the other strict entry, the polymorphic `jsmql()`, or, when the user almost certainly wrote a `$match` by reflex, a direct call to `jsmql.filter()` on the predicate without the wrapper.

## When to update this spec

- A new program shape (beyond expression, write, `Pipeline`) — extend the mode table and the shape rule in [filter-mode.md](filter-mode.md).
- A change to what an update document takes — the table in [update-filter.md](update-filter.md) and the refusals above.
- A change to the polymorphic `jsmql()` dispatch — make sure the strict entries still mirror the same accept/reject decisions, with `throw` in place of the other road.
