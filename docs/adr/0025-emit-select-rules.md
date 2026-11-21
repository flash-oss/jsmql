# 0025. Small rule-selection decisions in select.ts

Status: Accepted
Applies to: `src/compiler/emit/select.ts`

## Context

`select` in `src/compiler/emit/select.ts` gives one closed answer for a row, a receiver and an argument list. Some answers depend on facts that a row cannot state.

## Decision

- `shapeOf` puts the arguments in one class, so that no two classes claim one call. It tests the classes in a fixed order. See `src/compiler/emit/select.ts` for the order. A constant is a literal that the fold left. A `jsmql.compile` parameter is a runtime value, so it lands in `dynamic`.
- `receiverGate`: a row with `on: "any"` accepts every VALUE. A namespace such as `Array` is not a value. So `Array.isArray(x)` is not the method `.isArray()` with an argument, and the gate refuses it.
- An `inCode` verdict has no rule to read, because a pass owns the cell. The receiver gate still runs, so `$$.pop()` reports that the receiver is a stream where the row states an array. The developer must hear that fact, not that a pass declined the node. The row can still state the kind of each operand, and `kindFault` judges them (HR7).

## Consequences

A new verdict kind must decide whether the receiver gate runs before it answers.
