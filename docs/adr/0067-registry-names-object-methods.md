# 0067. Measured results of the object methods

Status: Accepted
Applies to: `src/registry/names.ts`

## Context

The object methods follow lodash. Their `returns` and `neverNull` facts come from measurements on mongod.

## Decision

- `.pick(keys)`: the value form builds a document literal, so the result IS an object. MEASURED: `$.o.pick(["a"])` gives `{ a: 1 }` for `o: { a: 1, b: 2 }`, `{}` for a missing `o`, and `{ a: null }` for `o: null`.
- `.pick` on a stream keeps ONLY the named fields of the ELEMENT, and it drops `_id` unless the list names it. With no field to keep, the element becomes `{}` where it lives on the document, through `$replaceWith`. An inclusion `$project` needs a field to include, and `{ _id: 0 }` alone EXCLUDES. MEASURED on `{ _id: 1, a: 1, b: 2 }`: `{ $project: { _id: 0 } }` gives `{ a: 1, b: 2 }`, and `{ $replaceWith: {} }` gives `{}`.
- `.omit(keys)`: the result IS an object. MEASURED: `$.o.omit(["a"])` gives `{ b: 2 }` for `o: { a: 1, b: 2 }`, and `{}` for a missing or null `o`.
- `.omit` on a stream drops the named fields of the ELEMENT. With no field to drop, the cell emits no stage. MEASURED: the server refuses `{ $project: {} }`.
- `.findKey(p)`: MEASURED, `$getField` over a `$first` of `$objectToArray: null` is null, for a missing `o` and for `o: null`. So the row states `passesNull`. The row takes the shorthands of lodash's `_.findKey`, and each shorthand reads the VALUE, as `.find()` reads the element. MEASURED: the answer is the key of the first entry that passes, and it is MISSING when no entry passes, as the answer of `.find()` is.
- `.toPairs()`: the `$map` body reads `$$this`, as `.entries()` does. The body is fixed text, so no user name can collide.
- `.assign(...sources)`: MEASURED, `$.o.assign({ z: 1 })` gives `{ a: 1, b: 2, z: 1 }` for `o: { a: 1, b: 2 }`, and `{ z: 1 }` for a missing or null `o`. `({}).assign($.o)` gives `{}` there. The answer is an object every time.

## Consequences

A change to one of these cells must measure the missing, null and empty-list cases again.
