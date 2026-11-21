# 0002. How bsonConstant reads a constant

Status: Accepted
Applies to: `src/bson.ts`

## Context

`bsonConstant` in `src/bson.ts` builds the live BSON value of a call such as `Decimal128("1.50")`. The caller is the constant fold. `docs/specs/bson-types.md` states the general contract.

## Decision

- `bsonConstant` returns null, not an error, for a malformed constant or for one that the type cannot hold. The fold then leaves the call in place. The row of the name refuses it at its source position, with the message of the row.
- `finiteNumber` accepts a numeric string, because mongosh's `Double("1.5")` accepts one too.
- `Decimal128` of a number uses `String(value)`. The shortest round-trip spelling of a number is the decimal that the source wrote. So `Decimal128(0.1)` is the decimal 0.1, not the double 0.1000000000000000055.
- `Long` uses `Long.fromString`, not `Long.fromBigInt`. `fromString` exists in every supported major of `bson`.

## Consequences

Keep null as the answer for a value that does not build, so that the refusal keeps the wording of the row. Do not move `Long` to `fromBigInt` while the peer range includes a major that lacks it.
