# 0030. jsmql.expr refuses a stage call, because the server refuses both readings of the result

Status: Accepted
Applies to: `test/codegen.test.ts`

## Context

A developer can pass a stage call such as `$match($.a === 0)` to `jsmql.expr`. The entry returns one aggregation expression. The only document it could return is `{ $match: { $eq: ["$a", 0] } }`.

## Decision

`jsmql.expr` refuses a top-level stage call, and the message names `jsmql.pipeline` and the bare predicate. MEASURED: mongod refuses that document in both readings. As an expression, `$match` names no expression operator. As a stage body, a bare `$eq` is not a top-level query operator. The stage document comes from `jsmql.pipeline("$match($.a === 0)")`, which gives `[{ $match: { a: 0 } }]`. The expression comes from `jsmql.expr("$.a === 0")`, which gives `{ $eq: ["$a", 0] }`.

## Consequences

A change that lets `jsmql.expr` accept a stage call must not emit `{ $match: <expression> }`. Each refusal of a stage call in `jsmql.expr` must name the two entries that do take the parts.
