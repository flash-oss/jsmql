# 0071. Operator facts on a mongo row

Status: Accepted
Applies to: `src/registry/names.ts`

## Context

A `$op` row must hold every fact that the emitter and the tooling need. Several facts differ from the vendored spec YAML or depend on the position.

## Decision

- `doc` comes from vendor/mql-specifications, and the drift test compares it. A name that is both an operator and a stage (`$count`) has two descriptions, so the row states `{ operator, stage }`.
- `category` comes from `OPERATOR_CATEGORIES`. A name that is only a stage has none, because MongoDB categorises operators, not stages.
- `keys`: for an operator whose body is a document of named keys, the order in which the positional form fills the keys (`$dateTrunc($.t, "day")` gives `{ date: "$t", unit: "day" }`). This order belongs to JSMQL and is a public commitment. It is not the key order of the vendored YAML. The two differ for some operators, for example `$top`. The YAML order gives valid MQL that answers a different question: `$top($.score, { score: -1 })` must give `{ $top: { output: "$score", sortBy: { score: -1 } } }`, not `{ $top: { sortBy: "$score", output: { score: -1 } } }`.
- `valueTwin`: the operator that does the job of a stage on a value, for the refusal of a stage on a value (`$.items.$match(…)` has no MQL; `$filter` filters an array). Stated only where such an operator exists.
- `spreadAlternative`: the JavaScript form that takes a spread and lowers to this operator. The escape hatch reads operands one by one, so the refusal of `$op(...xs)` names this form (`$max(...$.scores)` points to `$.scores.max()`).
- `returns`: absent when the name gives no value (a stage, or a query fragment such as `$box`). It is stated exactly on the rows whose `where` includes `value`, `group` or `window`, and a test holds both directions. MEASURED one operator at a time with `{ $type: <a well-typed call> }` on a live mongod. Never read it from the `type:` field of the vendored spec, which says `resolvesToString` for `$trunc`. `"unknown"` is a fact: the type follows the operands. Each such measurement ran with operands of two families: `{ $subtract: ["$d", 1000] }` is a date and `{ $subtract: ["$d", "$d"] }` is a long; `{ $max: "$n" }` is an int and `{ $max: "$s" }` is a string.
- `operandPosition`: the position of the operand where it differs from the operator's own. The server reads the values of a query document as query values. `$expr` is the exception: `{ $expr: { $multiply: [ … ] } }` runs, but `{ a: { $multiply: [ … ] } }` fails because `$multiply` is not a query operator. Stated only on an operator whose operand changes language.
- `liftsTo`: the expression twin of a query operator, for an operand that the server reads at run time. The twin takes `[<field path>, <operand>]`. A query document compares a field with a constant, so `{ a: { $gte: "$since" } }` compares with the literal text. An operand that the compiler cannot settle therefore moves into `$expr`. MEASURED over `{ a: 5, since: 3 }`: the query form selects nothing, and `{ $expr: { $gte: ["$a", "$since"] } }` selects the document. `$nin` states `$in` with a negation, because the expression language has no `$nin`. An operator with no twin keeps the refusal that names the rewrite.
- `onlyInside`: per position, the operators whose body accepts this name. The name is never valid alone in that position. MEASURED: `{ loc: { $geoWithin: { $box: … } } }` runs, and `{ $addFields: { v: { $box: … } } }` fails because `$box` is not an expression operator. The field is per position because the two uses are independent: `$slice` is a standalone aggregation operator and also sits inside `$push` in an update document (`onlyInside: { updateDoc: ["$push"] }`). The field does not change `where`.
- `window` is a different cell from `group`. Two tests on mongod prove it: `$rank` is a window function and not a group operator, and `$mergeObjects` is the reverse.
- `updateDoc` is the update document (`updateOne(filter, { $inc: … })`). A whole operator family is valid only there: the server refuses the same document in a pipeline, because `$inc` is not a stage.

## Consequences

Take `keys` order from JSMQL's positional form, never from the YAML. Measure `returns` on mongod for each new operator.
