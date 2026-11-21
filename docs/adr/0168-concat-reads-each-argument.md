# 0168. `.concat()` tests each argument that the proof cannot place

Status: Accepted
Applies to: the `concat` row in `src/registry/names.ts`, docs/specs/emit-pass.md § The method cells

## Context

JavaScript's `.concat()` adds the elements of an array argument, and adds any other argument as one element. When the proof cannot tell whether an argument is an array, the lowering has two options. It can pass the argument to `$concatArrays` as it is, or it can test the argument at run time.

## Decision

The cell tests the argument at run time. An argument that the proof cannot place grows from `"$b"` to a `$cond` of three reads. Each spread of such a list grows to a `$reduce`. The smaller shape answers null for the whole value on a missing argument, and it aborts the query on a scalar. So correctness decides, not size.

## Consequences

The MQL of `.concat()` is larger for an unproven argument. A proof that places the argument removes the test.
