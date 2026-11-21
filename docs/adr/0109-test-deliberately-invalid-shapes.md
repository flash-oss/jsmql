# 0109. Each deliberately invalid pass-through shape in a test records why the server refuses it

Status: Accepted
Applies to: `test/compiler-statement.test.ts`, `test/compiler-update.test.ts`, `test/stage-validation.test.ts`

## Context

A stage, an operator or an update operator that the developer calls by name is the developer's own MQL (HR2). HR3 does not apply to it. The compiler checks no key, count or value in its body, and the server judges it. So `test/compiler-statement.test.ts`, `test/compiler-update.test.ts` and `test/stage-validation.test.ts` assert expected documents that the server refuses. They pin the pass-through. Without a reason for each shape, a reader can think that the suite endorses the shape as valid MQL.

## Decision

The tests assert each shape below as written, and do not run it on the server. The server refuses each shape for the reason that follows. Measurements on the project's mongod gave the answers for the `$densify` to `$geoNear` group.

`$lookup` (`test/compiler-statement.test.ts`):
- `$lookup` joins by the `localField` / `foreignField` pair, by a `pipeline`, or by both. These valid forms pass.
- The server refuses `localField` without `foreignField`, and the reverse. It needs both keys or neither.
- The server refuses a `$lookup` that has no `as` key, because `as` is required.

`$unionWith`:
- The server refuses `$unionWith(5)`. It takes a document or a string.

Stage bodies that are a field path:
- `$unwind` and `$sortByCount` read their body as an expression, so the server takes a field path there.
- Every other stage refuses a field path as its body. For example, `$sort` and `$group` each need a document.

`$sort`:
- The server refuses `"desc"` as a direction.
- The server refuses `0` as a direction. A direction is `1` or `-1`.

`$unwind`:
- The server refuses a path with no `$` prefix, in the string form, the `{ path }` form and the raw document form.

`$bucket` and `$bucketAuto`:
- The server refuses a `$bucket` with no `boundaries` key, because the key is required.
- The server refuses `boundaries` that is not an array, for example a field path.
- The server refuses an unknown `granularity` word, for example `nope`.
- A stage reads a `$`-string in `granularity` as the string itself. So `"$g"` is an unknown word, and the server refuses it.

A `null` body:
- The server refuses `null` as the body of each stage. The document proof reads such a body as an unknown document, so the stage passes as written. The test checks every stage name with a `null` body.

Unknown `$` names:
- An unknown JavaScript link gets a `didYouMean` suggestion. A `$`-named link is the developer's own MQL, so it passes through with no suggestion. The server refuses `$prject` and `$matc`, because neither names a stage.
- An operator that the developer calls as a statement passes through as a stage. The server refuses `$abs(42);` and `$not(true);`, because neither names a stage.

`$count`:
- The server refuses a field name with a `$` prefix.
- The server refuses a field name that holds a `.`.
- The server refuses a field name that is not a non-empty string, for example `5`.

`$limit` and `$skip`:
- The server refuses `$limit: 0`. It needs a number above 0.
- The server refuses `$limit: 1.5`. It needs an integer.
- The server refuses `$limit: "$n"`. It needs a number, and a field path is a string.
- The server refuses `$skip: -1`. It needs a number that is not negative.
- `$skip(0)` and `$unionWith("c")` are valid, and they compile.

`$addFields`, `$replaceWith` and `$replaceRoot`:
- The stage call and the raw stage document are one road, and both are the developer's own MQL.
- The server refuses `$addFields(5)`, because it needs a document.
- The server refuses `$replaceWith(5)`, because it needs a document.
- The server refuses `newRoot: 5`, because it needs a document.
- The server refuses an unknown key of `$replaceRoot`, for example `bogus`.

Other stages:
- The server refuses an unknown key of `$densify`, of `$out` and of `$geoNear`, for example `zzz`.
- The server refuses a `$densify` with no `field` key.
- The server refuses a `$fill` that has both `partitionBy` and `partitionByFields`. It takes one of the two.
- The server refuses a `$setWindowFields` with no `output` key.
- The server refuses an unknown `whenMatched` word in `$merge`, for example `zzz`.
- `$changeStreamSplitLargeEvent` takes only the empty document, so the server refuses `{ zzz: 1 }`.

Update documents (`test/compiler-update.test.ts`):
- Each shape is the developer's own MQL, and the server judges it.
- The server refuses `$each([1])` and `$sort({ a: 1 })` as a whole update, because neither is an update operator.
- The server refuses `$set(5)`, because `$set` takes a document of fields.

Stage validation (`test/stage-validation.test.ts`). The `$limit`, `$skip`, `$count` and `$unwind` facts above hold there too. The suite also records these facts:
- `$group` refuses a body that is not an object, and a body with no `_id`.
- `$sort` refuses a sort with 33 keys.
- `$project` refuses an exclusion inside an inclusion projection.
- A stage name in a value slot passes through, and the server refuses it as an unknown expression operator.
- Two cases are not pass-through. A JavaScript spread inside a stage call is JSMQL code. It lowers to `$mergeObjects`, which no stage takes as its body, so the compiler refuses it (HR3). `$count` is both a stage and an accumulator, so `$count()` in a `$group` value slot is valid, and lowers to `{ $count: {} }`.

## Consequences

A new invalid shape needs its reason in this record, or in the test title. A change that makes the compiler check one of these bodies breaks HR2, because the body is the developer's own MQL. A JavaScript spelling that lowers to the same stage keeps every check of its own row.
