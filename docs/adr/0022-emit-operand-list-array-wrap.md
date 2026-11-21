# 0022. An array literal that is a value goes one level deeper in an operand slot

Status: Accepted
Applies to: `src/registry/vocabulary.ts`, `test/codegen.test.ts`

## Context

MongoDB reads a bare array in a positional operand slot as the list of operands. `{ $size: [1, 2] }` is two arguments, and `$size` takes one. `{ $size: [1] }` unwraps to the scalar `1`, which is not an array. A JavaScript lowering often hands an array literal to such an operator as a VALUE, for example `[1, 2].size()`. Measured on a live mongod: each unwrapped form was refused. The server unwraps one extra level exactly once, back to the intended operand.

## Decision

- `single` in `src/registry/vocabulary.ts` renders `{ $op: <operand> }` with the operand as the developer wrote it, and adds no wrap. This is HR2. `$size([$.a])` is the developer's operand list and round-trips as `{ $size: ["$a"] }`. An accumulator slot renders the same way (see [position-pass.md § An accumulator slot takes one operand](../specs/position-pass.md#an-accumulator-slot-takes-one-operand)).
- A JavaScript lowering that passes an array literal as a value adds the wrap itself, because there the array is the value and not a list. See the `length` row. The rule holds for every method that lowers to a single-operand operator, for example `[1, 2].toString()` → `{ $toString: [[1, 2]] }` and `[$.a, 2].isArray()` → `{ $isArray: [["$a", 2]] }`.
- A field path, a `$$` variable or an operator document is already one operand. An added level would change what the operator reads, so these take no wrap.
- A named value slot such as `$map.input` or `$filter.input` is not an argument list, so a wrap there would break it.
- Computed object keys lower to `$arrayToObject` over `{ k, v }` pairs, wrapped as `{ $arrayToObject: [pairs] }`. The server refuses a bare `{ $arrayToObject: [{ k, v }] }`, because it unwraps the list to the object, which is not an array. Two pairs written bare are two arguments, and `$arrayToObject` takes one. The server accepts the wrapped shapes. The `$arrayToObject([...])` escape hatch keeps the pair shape that the user typed, with the wrap.
- The wrap tests in `test/codegen.test.ts` use a predicate that reads `$.n`, because a constant predicate folds the whole call away. The fold does not carry `$$ROOT` as a value, so the shape stays visible.

## Consequences

A new JavaScript lowering that hands an array literal to a single-array-argument operator must add the extra level. A `$op(…)` call must never add it. Verify each new wrapped shape on mongod, because a `toEqual` assertion cannot show that the server reads one operand.
