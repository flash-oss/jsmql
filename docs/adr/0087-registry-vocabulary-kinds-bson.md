# 0087. BSON kinds that the type tracker uses

Status: Accepted
Applies to: `src/registry/vocabulary.ts`

## Context

The type tracker proves a `Kind` for each value. A live BSON value proves its kind by its tag.

## Decision

- `BSON_KIND`: the four numeric BSON types are `number`, because MongoDB holds them as one. Its `$type: "number"` alias covers int, long, double and decimal, and `$add`, `$gt` and `$sum` take any of them. MEASURED: `$round` on a Decimal128 gives a Decimal128, and `$max: [Long, Int32]` gives the Long.
- A `UUID` reports the tag `Binary`. So the tag keys the table, not the class. From another copy of `bson`, the tag is all that a reader has.
- `bsonTagOf` reads both `ObjectId` and `ObjectID`, because bson 1.x spells the tag with an upper-case D.
- `binData`: MEASURED, `{ $type: { $hash: { input: "$s", algorithm: "sha256" } } }` gives `"binData"`, and `$toUUID` gives the same. No other name makes one.
- `minKey` and `maxKey` are kinds of their own. The sentinels compare against every type and compute with none. MEASURED: the server refuses `$add: [MinKey, 1]`. The separate kind makes that refusal a compile-time refusal: the operand rule of `+` refuses a MinKey.

## Consequences

`docs/specs/bson-types.md` § The sentinels must agree that the compiler refuses arithmetic on a sentinel.
