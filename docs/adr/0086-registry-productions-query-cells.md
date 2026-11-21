# 0086. The native query forms of the comparison productions

Status: Accepted
Applies to: `src/registry/productions.ts`

## Context

A comparison in a filter should emit the query document that a MongoDB developer writes by hand, because an index can serve it. The query language has rules that differ from `$expr`.

## Decision

- `strictEqualityQuery` tries its cells in this order: the `typeof` test, the presence test (`=== undefined`), the length check, the modulo test, the null test, and then a field against a constant.
- A `.length` comparison has no query form, because the server has `$size` for an array only, and no query form states a length.
- The `array` alias of `typeof` asks if the value IS an array, so it excludes no value: `{ $type: "array" }` and `{ $not: { $type: "array" } }`.
- `x === undefined` is the presence test (`$exists`). An array at a path PREFIX also reads as absent in JavaScript, so the positive form takes it as an alternative, and the negated form excludes it.
- Modulo: the remainder can be negative. `$.a % 3 === -1` gives `{ $mod: [3, -1] }`. The server takes it, and JavaScript agrees. A divisor of zero never reaches the query cell, because the `nonZero` rule of the `remainder` row refuses it first.
- An ARRAY constant has no own-value query form. The query language reads `{ f: [1, 2] }` as "f equals [1, 2], OR f holds the ELEMENT [1, 2]". An own-value guard that excludes an array then excludes every document that the equality selects. So the comparison takes the expression road, where `$eq` compares the whole value.
- A RegExp that the call supplies becomes the regex query of MongoDB, as the developer gave it: `{ field: /re/ }` matches, and `$eq` would compare a value.
- `==` and `!=` have a query form against null only. `{ $eq: null }` selects a null field AND a missing field, which is the loose meaning. So `== null` holds for an absent field and `!= null` does not. Only the negated form holds for an array, because `[null] == null` is false in JavaScript.
- `orderedQuery`: every BSON value qualifies, because BSON defines a total order across the types, and the two sentinels sit at its ends. MEASURED: `{ g: { $gt: MinKey() } }` returns every document whose `g` is anything else. The operator turns around when the field is on the right. Off this road the comparison becomes `$expr`, which compares a whole ARRAY with a scalar, and that answers a different question on an array field.
- `x in [c, …]`: MEASURED, `{ x: { $in: [1, 2, 3] } }` is the query form that uses an index. A list that is not a constant falls back to `$expr`.

## Consequences

A change to the order of the cells, or to a guard, must keep the query answer equal to the JavaScript answer on array, null and missing fields.
