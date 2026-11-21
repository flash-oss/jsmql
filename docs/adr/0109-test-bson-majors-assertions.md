# 0109. How the bson-majors suite asserts behaviour that differs between bson majors

Status: Accepted
Applies to: `test/bson-majors.test.ts`

## Context

`test/bson-majors.test.ts` runs the same checks against bson 6 (`bson6` alias) and bson 7. Some facts differ between the majors, and a plain `toEqual` cannot see some differences between BSON values.

## Decision

- The suite asserts a bare `toThrow()` for the constructors that throw. The claim is only that the class throws. The message text is bson's own, and it differs between the two majors. jsmql wraps the throw in its own message, and `test/compiler-bson.test.ts` asserts that text.
- The suite calls `Long.fromString`, not `Long.fromBigInt`, because `fromString` exists in every supported major.
- `toEqual` holds a MinKey equal to a MaxKey, because neither has an own property. So the suite asserts the `_bsontype` tag to tell them apart.

## Consequences

A new assertion in this suite must use only API present in both majors. Assert a BSON sentinel by its tag, never by `toEqual` alone.
