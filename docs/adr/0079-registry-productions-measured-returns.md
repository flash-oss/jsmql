# 0079. Measured result kinds of the arithmetic and bitwise productions

Status: Accepted
Applies to: `src/registry/productions.ts`

## Context

Each production states its `returns` from a measurement on mongod over each pair of operand kinds.

## Decision

- `$bitOr`, `$bitXor`, `$bitAnd` (binary) and `$bitNot` (unary) give an int, a long, null or an error. The rows state `returns: "number"`.
- `$multiply`, `$divide`, `$mod`, `$pow` and the unary minus (`{ $multiply: [x, -1] }`) give a number, null or an error. The rows state `returns: "number"` and `passesNull`.
- `$subtract` gives a number, a date, null or an error. A date minus a date is a long, the milliseconds between them (86400000 for one day). A date minus 1000 is the date one second earlier. A number minus a date is an error. The compiler refuses a proven date as an operand, because a date takes `.minus()` and `.diff()`. A field of unknown kind can still hold a date, so the row states `{ oneOf: ["number", "date"] }`.

## Consequences

A change of `returns` needs a new measurement. The test that holds each measurement is in [types.md § A row's `returns`](../specs/types.md#a-rows-returns).
