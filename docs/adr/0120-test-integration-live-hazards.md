# 0120. The integration suite runs the shapes that only a live server can prove

Status: Accepted
Applies to: `test/integration.test.ts`

## Context

A `toEqual` on emitted MQL proves only what JSMQL emits. Some lowerings look correct and still fail on the server: the server aborts the whole command, rejects the pipeline, or returns wrong data with no error. `test/integration.test.ts` runs such shapes on the fixture dataset (`test/fixtures/`) and asserts the returned data.

## Decision

The suite keeps one case per known hazard. Each expected value comes from a live run.
- `$substrCP` aborts the command on a negative start, and `$strLenCP` aborts on a null or missing input. A lowering that reaches either one returns no rows at all. The fixture holds an email shorter than the `.endsWith` needle, a null email (`u5`), and a user with no email field. A needle longer than every value takes the negative-index path on every document: the correct answer is an empty result, not an abort.
- Under a dot, a null or missing string reads as `""` (HR5). Each value-mode string method then gives its answer on `""`.
- The date methods compose more than one operator. `.endOf` is `$dateTrunc`, then `$dateAdd`, then minus one millisecond, so it gives the inclusive end. `.set` reads the parts back through a `$let`, and its month is 1-based, unlike the JavaScript `Date` month. `.quarter` needs `$toInt`, because the plain arithmetic gives a double. In a date difference, the receiver is the later date.
- Array `.slice` follows `Array.prototype.slice`: start and end are indexes, the end is exclusive, and a negative value counts from the end. MQL `$slice` takes a position and a count. A count-based lowering reads `.slice(1)` and `.slice(1, -1)` wrongly and emits a negative count, which the server rejects.
- Statement `.pop()` and `.shift()` lower to a `$slice` whose count can be 0 for an empty or one-element array. The server rejects a count of 0 in the three-argument form at run time. The fixture `tags` mix empty, one-element and two-element arrays.
- An `.aggregate` head with a lodash tail must stay on the stream road. A fall back to value mode reads `$getField` off the result array, so `.pick` gives `{}` for every row, and `.omit` makes the server refuse the pipeline.
- A bracket index has three receiver kinds: an array element, one character of a string, and a document field. `.at()` reads an array element, `.charAt(i)` one character, and `.substr(-n)` the tail. A missing receiver stays missing through the index and through `.at()`, so `??` gives its fallback.
- `$getField.field` must evaluate to a string, or the server aborts the command. A missing key field reaches it as null, which is ordinary data. So the compiler coerces a computed key. A numeric object key names the field `"0"`, as in JavaScript.
- A method chained onto a lookup slot reads a slot that JSMQL itself fills with the `$lookup.as` array. The compiler knows the slot is an array, so the MQL carries no run-time type guard.
- `.countBy()` gives a MongoDB object, and an object key is a string. So `.keys()` gives hex strings, and `id.toObjectId()` (`$toObjectId`) casts each one back before it meets an ObjectId `_id`. Without the cast the server still returns rows, but `_id` never equals a string, the joins find nothing, and each `name` is missing. The expected rows hold ObjectId values, so a string fails the assert.
- A method on a missing array runs on the empty array (HR5): `.size()` counts 0, and `.has()` and `.some()` give false. An unguarded `$size`, `$in` or `$map` input aborts the command. The compiler adds no guard where the array is certainly present, for example the keys of the root document.

## Consequences

When a lowering in one of these areas changes, run this suite against the fixture instance. When a new hazard of this class appears, add a case here with a fixture document that triggers it. A green `toEqual` elsewhere is not a substitute.
