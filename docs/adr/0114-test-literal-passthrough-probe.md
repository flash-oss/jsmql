# 0114. The literal pass-through probe builds a minimal call for each operator

Status: Accepted
Applies to: `test/literal-passthrough.test.ts`

## Context

`test/literal-passthrough.test.ts` loops over each operator and each stage. It checks that a `$`-string sentinel passes through with no added `$literal`. The probe builds a synthetic call from the registry shape of each operator, so the call must reach codegen.

## Decision

- `arrayArgCount` gives an arity-valid operand count. A variadic list operator states `atLeast: 1`, but one operand is legal only as a single array literal. The probe writes the positional form, so it gives at least two operands.
- A `flex` operator takes one operand by default. An arity rule sets the count instead: a comparison operator needs exactly two operands in the value position that the probe builds.
- An operator that has a query position only has no expression form on the server. So it cannot stand in the expression contexts of the loop, and the `$match` query-form tests cover it.
- The accumulator `$count` takes no operand, and `$expMovingAvg` needs `N` or `alpha`. The synthetic call is not a call that the server takes, so the loop skips both.

## Consequences

The loop asserts the emitted shape only. Its calls are not runnable MQL, so they stay out of every live "ran each one" list.
