# 0171. `$ = $.pick([…])` and `$ = $.omit([…])` take the stage of the stream cell

Status: Accepted
Applies to: `elementWiseOnDocument` and `documentStages` in `src/compiler/emit/statement.ts`

## Context

`$ = $.pick([…])` can lower as a value (`$replaceWith` over `$$ROOT`) or through the stream cell of the same row (a `$project` stage).

## Decision

A chain whose every link is a row on both the `object` and the `stream` family takes the stream road. Such a row is element-wise by construction. What it makes of the document is what its stream cell makes of each document of the stream. So "the document becomes `pick(document)`" and "every document is picked" are the same operation, and the `$project` of the stream cell is the smaller MQL. MEASURED: `[{ $project: { a: 1, b: 1, _id: 0 } }]` and the value form `$replaceWith: { $let: { vars: { jsmqlObj: "$$ROOT" }, in: { a: { $getField: … }, … } } }` return the same documents for a present key, a null key and a missing key. Inside a `$lookup` body, the two forms also return the same orders.

## Consequences

The stream road applies only when every argument is a compile-time constant. Any other chain takes the value road.
