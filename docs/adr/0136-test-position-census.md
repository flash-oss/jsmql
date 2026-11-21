# 0136. The measured slot behaviour that the position pass must reproduce

Status: Accepted
Applies to: `test/compiler-position.test.ts`

## Context

A position is not a property of the shape of a node. `$sum($.x, $.y)` is a valid two-operand expression and an invalid accumulator. Only the place where the call stands separates the two readings. `test/compiler-position.test.ts` is a census: it walks a program, records where it reached each node, and asserts the answers against what mongod does with each slot.

## Decision

- Each case in `SLOTS` is a slot that mongod treats differently from an ordinary expression slot. Without the layout of the row, each case reads as `value`, and several become documents that mongod refuses. The measurements:
  - `$group` refuses `{ $sum: ["$x", "$y"] }` in an output, because the `$sum` accumulator takes one operand. `$bucket` and `$bucketAuto` refuse it the same way.
  - `$geoNear.query` and `$graphLookup.restrictSearchWithMatch` refuse `{ $eq: ["$k", "a"] }`, because `$eq` is not a top-level query operator.
  - `$setWindowFields` accepts `{ $sum: ["$x", "$y"] }` and answers 0 where the unary form answers 4. The result is wrong, and nothing reports it.
  - The body of `$match` is a query document, not an expression. `$match` refuses `{ $gt: ["$x", 1] }`.
- `_id` is the one key of a `$group` body that is not an accumulator. mongod accepts `{ $group: { _id: { $sum: ["$x", "$y"] } } }`.
- `sortBy` is a key specification, not an expression slot. mongod refuses every expression there except `$meta`.
- Three spellings of one stage, a call, a chained link and a raw document, name the same row and read the same layout. If the chained spelling bypassed the layout, `$$.$group({ …, s: $sum($.x, $.y) })` would check as a two-operand expression and emit a document that mongod refuses.
- The top link of a chain is a value to its parent, but `$group` on a stream is a stage. Its body must reach the `group` slot.
- `$count` is a stage and an accumulator. Inside `$group`, its arguments belong to the operator, and the stage layout must not claim them.
- The layout of `$merge` names `whenMatched`, so its body is `deeper`. A string body has nothing to descend into, and takes the own position of the body. `bodySlotAt` answers both facts: the position of a leaf, and whether an object must descend.
- The compiler cannot know that a computed key `{ [k]: … }` is a key that a row names. So a literal entry never claims it. The wildcard `"*": "group"` of `$group` covers any key. `$lookup` names `pipeline` literally, so a computed key falls back to the default of the body, and is not a sub-pipeline.
- A fold of `f` in `f(1)` would give `3(1)`. The fold and the position pass share one predicate in `src/compiler/passes/naming.ts`: a callee names something and holds no value.
- The top link of a chain stands where its parent put it, for example a value as an argument of `push`. The links below it are streams, and `$$$` is a scope. The pass reads a chain by its base, through an index as well as a member, so `$$$["archive"]` and `$$$.archive` are one collection.
- No program can tell the entry points apart, so the test passes the seed in. `$.a > 1` is a predicate as a filter and a boolean as an expression. Both are legal MQL, so a wrong seed gives a wrong document, not an error. A `;` makes a `Pipeline`, whose elements are statements, and the seed cannot override that.
- `$match` names no key, so its body is a leaf at once, and everything below it is query.
- `$merge.whenMatched` takes an update pipeline or a word from a fixed set. A bracketed list is stages, and a word is a value.
- The argument of a stage is a body. A row that is not a stage has no body to lay out. So the two facts must agree in both directions. A stage with no layout sends its whole body to `value`, which is the source of slot bugs.
- Some positions are reachable only after a body path resolves. So the test asserts that the seeds and the layouts together reach every `Position`.

## Consequences

A new stage row needs a layout, and a new slot with server-specific behaviour needs a census case with its measurement. Never let a spelling of a stage bypass the layout of its row.
