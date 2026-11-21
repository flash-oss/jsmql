# 0014. Which values the query language compares as written

Status: Accepted
Applies to: `src/compiler/emit/filter.ts`

## Context

The filter target keeps a clause in the query language when its operand is a constant. A value that the query language would read differently from the expression language must take the `$expr` road. The merge of `&&` clauses must also compare two values without loss.

## Decision

`src/compiler/emit/filter.ts` applies these rules:
- `literalIn` accepts a constant, or a list or document of literals, for the raw query operators. It differs from `constantIn` on purpose. A JavaScript spelling reads an array or document literal by reference, so `$.tags === [1, 2]` is never true in JavaScript. That spelling takes the expression road, where `$eq` compares the whole value.
- `constantIn` takes a RegExp that the call supplied as the developer's own MongoDB regex. A regex typed in the source is a pattern for the regex methods, and it is no constant to compare a field with.
- `constantIn` converts a BigInt to an int64 (`longsWithin`). So `$.n === 5n` stays a query that an index serves. Without the conversion it would take the `$expr` road.
- `isQueryConstant` accepts every BSON value for correctness, not for output size. Measured on mongod, for `{ tags: [Long(5), Long(7)] }`, the clause `{ tags: Long(5) }` matches, because an element equals the value. The form `{ $expr: { $eq: ["$tags", Long(5)] } }` does not match, because it compares the whole array with a scalar. A BSON value left off the list would take the `$expr` road and give the second answer on every array field.
- `spell` writes a value so that two spellings are equal only when the values are equal. `JSON.stringify` writes every RegExp as `{}`, so `/^a/` and `/z$/` would read as one value, and a merge would drop a condition. A BSON value such as an ObjectId or a Decimal128 spells as a whole through `String(v)`. The function reads only a plain object key by key.

## Consequences

A new BSON type must stay on the query road. A change to `spell` must keep it injective over every value that a clause can hold. A change to `constantIn` must keep the BigInt conversion, or a BigInt comparison loses its index.
