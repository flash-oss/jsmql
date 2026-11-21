# 0089. The query-document helpers and the typeof vocabulary

Status: Accepted
Applies to: `src/registry/vocabulary.ts`

## Context

JSMQL emits the query document that a MongoDB developer writes by hand. The query language reads arrays, nulls and `$elemMatch` bodies in its own way.

## Decision

- `shorthand`: a query document writes `{ $eq: v }` as `v`, except where a reader takes `v` as something else. An operator document (`{ $gt: 1 }`) and a regular expression both mean a test at that position.
- `queryOwnValue(path, test)`: a field comparison holds when any ELEMENT of an array value satisfies it, and it goes through an array in the middle of a path. JSMQL accepts the server rules, so `$.age > 18` is `{ age: { $gt: 18 } }`. A comparison that must read one value has its own spelling: `.includes(x)` for containment and `.some(e => …)` for an element test. The path `""` is the ELEMENT inside an `$elemMatch` body, and there the test stands alone in operator form, because `{ $elemMatch: "red" }` is not a query and `{ $elemMatch: { $eq: "red" } }` is.
- `queryAmong(path, values)`: the native `$in`. A membership test compares as `===`, so a missing field is not null. `$in` reads a null entry loosely, so the helper adds `$exists: true` when the list holds null. MEASURED: `{ s: { $in: [null], $exists: true } }` selects `{ s: null }` and not `{}`. An `$elemMatch` element is never missing.
- `queryOrMissing(path, test)`: the test, or the field missing or null. A regex test and the null test share one `$in`: `{ s: { $in: [/^$/, null] } }`, which an `$elemMatch` body can contain. Any other test takes an `$or` beside the null test. An `$elemMatch` body over a value cannot contain an `$or`, so the answer is null for the path `""`. MEASURED: the server refuses `{ n: { $elemMatch: { $or: [{ $gte: 0 }, { $eq: null }] } } }`.
- `BSON_TYPE_ALIASES` holds the names that the aggregation `$type` can return; the `$type` query operator accepts each one. `typeAliasOf` takes only these names (`"bool"`, not `"boolean"`), because any other spelling makes a test that matches nothing. `TYPEOF_HINTS` gives the fix: a `name` entry for the MongoDB type name, or a `write` entry for the JSMQL form and a `test` text. The refusal reads this table first and the closest type name second.

## Consequences

A new query cell uses these helpers, so the `$elemMatch` and null rules stay in one place.
