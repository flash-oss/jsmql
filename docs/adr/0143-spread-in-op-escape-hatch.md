# 0143. Spread in the `$op(…)` escape hatch

Status: Rejected
Applies to: the `$op(…)` call lowering, HR2 in `docs/LANG_RULES.md`

## Context

The idea: accept a spread in a `$op(…)` call, for example `$setUnion(...$.arrs)`.

## Decision

The developer rejected this. The escape hatch is raw MQL (HR2): `$op(value)` lowers to `{ $op: value }`, and `$op(a, b)` lowers to `{ $op: [a, b] }`. A spread has no MQL to lower to. Two lowerings are possible, and both are wrong:

- `$op(...list)` becomes `{ $op: list }`. That is `$op(list)`, the single-array form that already exists.
- `$op(...list)` becomes `{ $op: { $concatArrays: [...] } }`. That is a second spelling for what `[...a, ...b]` and `.concat()` already say.

## Consequences

- The compiler refuses a spread in every `$op(…)` call, known or unknown. This is one of the few checks on the escape hatch; see [ADR 0144](0144-no-checks-on-escape-hatch.md).
- The message names the forms that work: the operands one by one, the single array, or the JavaScript spelling. Examples of the JavaScript spelling are `[…].max()`, `({}).assign(...arr)`, the object spread `{ ...a, ...b }`, `[...a, ...b]` and `.concat()`.
- Reconsider only if MongoDB gives a spread a meaning in an operator's operand list.
