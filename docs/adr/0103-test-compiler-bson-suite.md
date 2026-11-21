# 0103. The BSON suite checks the BSON type tag, builds live values per insert, and relies on measured conversions

Status: Accepted
Applies to: `test/compiler-bson.test.ts`

## Context

`test/compiler-bson.test.ts` asserts the BSON values that the compiler emits, and runs each document on a live mongod. Vitest equality and the driver have limits that this work must handle.

## Decision

- `toEqual` holds `MinKey` equal to `MaxKey`, and `Int32(3)` equal to `Double(3)`, because neither class has an own property that differs. `toStrictEqual` cannot help, because the driver's classes and jsmql's classes come from two builds of `bson` (CJS and ESM), so their constructors always differ. So the suite reads the `_bsontype` tag through the `bsonType` helper.
- The fixture document `doc()` builds each BSON value fresh for each insert, and never clones it. `structuredClone` drops `_bsontype`. MEASURED: a Decimal128 that arrives as a plain object makes the server refuse `$multiply`, because an object is not a number.
- MEASURED: each `$to…` conversion operator gives a value of its own type back unchanged. So the value's own method (`.toObjectId()`, `.toLong()`, and the others) is the conversion of a value, and the `OWN_TYPE` table asserts it.

## Consequences

A new assertion that must tell two BSON classes apart uses `bsonType`, not `toEqual`. A fixture that holds a BSON value must not pass through `structuredClone`.
