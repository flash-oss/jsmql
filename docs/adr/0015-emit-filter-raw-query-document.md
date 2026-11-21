# 0015. A raw query document keeps its keys and lifts run-time reads into $expr

Status: Accepted
Applies to: `src/compiler/emit/filter.ts`

## Context

A developer can write a raw query document in a Filter, for example `{ status: "a", $expr: … }`. HR1 and HR2 say that this document is the developer's own MQL. The query language compares a field with a constant only. A field read such as `$.other` in a query slot is the plain string `"$other"`, so the server compares with that string.

## Decision

`rawQuery` in `src/compiler/emit/filter.ts` keeps each key as written and lowers each value in value position.
- The value either applies operators to the field (`{ $gte: … }`, `$gte(…)`) or is the value that the field is compared with. The two shapes take different lifts, so the shape decides which lift applies.
- An operator with a run-time operand, for example `{ createdAt: { $gte: $.since } }`, takes its expression twin from the row (`liftsTo`). The operators with a constant operand stay native beside it. The compiler refuses an operator with no twin.
- A compared value stays native only when nothing inside it reads at run time. `{ a: [1, $.b] }` would compare the field with the string `"$b"`. So the compiler moves the whole comparison into `$expr`, as `{ $eq: ["$a", …] }`.
- `operatorEntries` answers for the document spelling and the call spelling alike, because HR2 says the two are one thing. A document whose keys are not all `$`-named is a value.
- `readsAtRunTime` descends into arrays and documents. `{ a: $.b }`, `{ a: [1, $.b] }`, `{ a: [{ x: $.b }] }` and `{ a: { x: { y: $.b } } }` are one case.
- `injectedInQuery` applies HR1. A field compares an injected value that looks like MQL with `$eq`. The operand of an operator with `liftsTo` is a value too. The operand of `$expr` is an expression, and the value road wraps it in `$literal`. Every other operator reads its operand as a query or as MQL syntax, so the compiler refuses an injected value there.
- `rawDocument` reads a key whose row states another position for its operand in that position. The operand of `$expr` is an expression. `$near` and `$nearSphere` query only a `find()`, and the server refuses them in an aggregation `$match`.
- `rawValue` reads a one-operand `$`-named call as the query operator, for example `{ x: $gt($.y) }`. HR2 passes it through, so the count rule of the expression form does not apply. The operand is raw too, so `{ a: $not($gt(1)) }` nests one query operator in another.
- A regex literal in a raw query document is a BSON regex, as HR1 says.
- `rawValue` refuses a computed expression, for example `{ a: $.b > 1 }`. It would become `{ a: { $gt: ["$b", 1] } }`, which the server accepts and which matches nothing. A constant written as an expression, for example `-1`, is already a value, so it passes.
- `rawValue` refuses an aggregation operator in a value that the developer wrote as JavaScript. Measured: the server refuses `{ a: { $trim: … } }`. The check does not run on the keys of a raw document, because a document that the developer typed is their own MQL. So a query operator that is newer than this build still passes through. A `$`-named call is the developer's own MQL too.

## Consequences

A change to the raw query road must keep the keys as written. It must keep the per-entry lift, and it must keep the native entries beside `$expr`. A new value check must run only on JavaScript code, never on the keys or on a `$`-named call.
