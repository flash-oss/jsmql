# 0026. A reduce accumulator narrows to object or array when seed and body agree

Status: Accepted
Applies to: `test/codegen.test.ts`

## Context

A bracket read on a value of unknown type lowers to a run-time dispatch on `$isArray`. Inside `.reduce`, `$$value` after iteration i ≥ 1 is the body's return from iteration i − 1, not the seed. So the type of the accumulator is safe to fix only when both agree.

## Decision

- The reduce lowering narrows the accumulator parameter to "object" or "array" when the `initialValue` and the body are statically the same compound type. For example, the seed is `{}` and the body returns an `ObjectLiteral`.
- With a narrowed accumulator, the bracket read (`IndexAccess`) emits the type-specific operator directly: `acc[s]` is `$getField`, with no `$cond` on `$isArray`.
- A body that returns a member read of the element does not narrow the accumulator, so a bracket read on it keeps the dispatch.
- The element parameter is never narrowed by this rule. In `(a, x) => ({ ...a, k: x[0] })`, `x[0]` keeps the dispatch.
- An inner `.reduce` that reuses the name `acc` with seed `[]` and an array body narrows its own `acc` to array. The inner `acc[0]` is `$arrayElemAt`, not the `$getField` of the outer one.
- `a?.[k]` on an accumulator known to be an object wraps with `$ifNull(_, {})`, not `$ifNull(_, [])`. An array as the input of `$getField` is a type error in MongoDB.

## Consequences

A change to the reduce lowering must keep the agreement test between seed and body. Narrow only the accumulator, never the element.
