# 0084. Server constraints behind the value cells of the type-test rows

Status: Accepted
Applies to: `src/registry/names.ts`

## Context

The type-test rows in `src/registry/names.ts` (`isArray`, `isInteger`, `isNaN`, `isUUID`) must give the JavaScript answer. Some server operators do not give that answer directly.

## Decision

- `isArray`: the value cell emits `{ $isArray: singleArrayArg(recv) }`. A plain operand goes in as it is. An array literal goes one level deeper, as `$size` takes it, because the server reads a bare array as the operand list.
- `isInteger`: the test is `$and` of a finite-number test and `{ $eq: [v, { $trunc: v }] }`. NaN and the infinities are numbers that `$trunc` gives back unchanged, so the finite test comes first.
- `isNaN`: MEASURED, the server holds NaN equal to itself. So the JavaScript self-compare does not work. The cell tests `$isNumber` and then compares `$toString` of the value with the text `"NaN"`.
- `isUUID`: `$type` names every binary subtype `"binData"`. MEASURED, `$convert` to a string with the format `"uuid"` gives the text of a subtype-4 value, and it fails on any other subtype. `$convert` gives a value of another type back unchanged. So the `$type` test for `"binData"` comes first, and the `$convert` test comes second.
- Each cell tests a field path directly, and binds a computed receiver once in a `$let`.

## Consequences

A change to these cells must keep the order of each test. A test that compares NaN with itself, or that calls `$convert` before the `$type` test, gives a wrong answer or stops the command.
