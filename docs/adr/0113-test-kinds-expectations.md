# 0113. The kind facts behind the HR7 expectations in compiler-kinds.test.ts

Status: Accepted
Applies to: `test/compiler-kinds.test.ts`

## Context

`test/compiler-kinds.test.ts` asserts where HR7 refuses a value and where a value passes. Some expectations rest on a fact about the registry, the server or vitest.

## Decision

- A regular expression and a `Timestamp` have no kind that the registry names. So the compiler does not judge them as elements of `.has()`, `in` or `.indexOf()`. An element of a kind that the registry names, for example `MinKey`, gets the judgement.
- `tagOf` reads the `_bsontype` of a value, and the test compares that tag, for the reason in [ADR 0103](0103-test-compiler-bson-suite.md).
- The query cell of an operator states the kinds of its value cell. So `<`, `>`, `<=` and `>=` refuse a value alike in `$match` and in a value.
- In `$match($.tags in [["a"]])`, a list that holds an array also tests the whole field. This is MongoDB's `$in` behaviour.
- `x + 1` is a number or a date. So the elements of `$.nums.map(x => x + 1)` are not proven wrong for `.sum()` or `.max()`.
- MEASURED on mongod: `$dateFromParts` refuses a fraction in each calendar part. JavaScript cuts the fraction off. JSMQL refuses a written fraction, because it does not cut a value silently.
- MEASURED on mongod: `$toDate` cuts a fraction toward zero, and JavaScript does the same. JSMQL still refuses a fraction that it can see (written, folded or bound), because it does not cut a value silently.

## Consequences

When the registry gives a kind to a regex or a `Timestamp`, update the element cases. Keep the date refusals while the server and JavaScript cut a fraction.
