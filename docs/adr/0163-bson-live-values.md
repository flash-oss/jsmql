# 0163. JSMQL emits a live BSON value, and the fold does not compute with it

Status: Accepted
Applies to: `src/bson.ts`, `src/compiler/emit/lower.ts`, `src/compiler/passes/evaluate.ts`

## Context

A source can spell a BSON value, for example `ObjectId("…")`, `Decimal128("1.50")` or `5n`. The compiler can put it into MQL in three forms: the Extended JSON envelope (`{ "$oid": "…" }`), a conversion operator such as `$toLong`, or the live value.

## Decision

- JSMQL emits a real BSON instance wherever the source spells one. The Extended JSON envelope is a client-side serialization shape. The driver does not parse it in a query. MEASURED against mongod: the server gets the envelope as written, and refuses it as an unknown operator.
- A BigInt literal is a live `Long`, not `{ $toLong: "5" }`. The server then parses no string for each document. The comparison stays on the query road, so `$.xs === 1n` matches an element of `xs`, where the `$expr` form compares the whole array. A BigInt past 64 bits gets a refusal at its source position. MEASURED: the server refuses `$toLong: "12345678901234567890123"` only at run time.
- The fold does not compute with a BSON value. `bson.Decimal128` has only `toString`, `toJSON` and `toExtendedJSON` on its prototype, so it has no decimal arithmetic. The answer of the server is exact. MEASURED: `$add: ["$p", Decimal128("0.2")]` gives `0.3`, where a double gives `0.30000000000000004`. A fold of `Long` and `Int32` needs the type promotion matrix of MongoDB in the compiler. One wrong cell gives a wrong number in a report. The one exact read, `toString()`, folds.

## Consequences

Each phase that touches a value must accept a live BSON instance. A new arithmetic fold on a BSON value must first match the server on every pair of types.
