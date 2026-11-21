# 0128. The measured server limits that shape the guards of the method lowerings

Status: Accepted
Applies to: `test/compiler-methods.test.ts`

## Context

Many method lowerings in `src/registry/names.ts` carry a guard, an extra branch or a binding. `test/compiler-methods.test.ts` asserts these shapes and runs them on mongod. The reason for each shape is a server limit, measured on mongod.

## Decision

- `.indexOfSubstring()` is JavaScript's `String.prototype.indexOf`. `$indexOfCP` refuses a negative start, so a negative position reads as 0, as in JavaScript. `$indexOfCP` also refuses a fractional start, so the position takes an integer (HR7).
- MEASURED: `$month` of March is 3, and `$dayOfWeek` of a Sunday is 1. The date accessors adjust to JavaScript's numbers.
- A key list that the source does not spell, for example a field path or an element read at run time, is known only to the server. So `.pick()` and `.omit()` read the own keys of the object instead.
- A missing key list picks nothing and omits nothing. Without the guard, `$in` aborts the command on a second operand that is not an array.
- An index read in a `.map((x, i) => …)` callback makes the input the `[i, x]` pairs, through `$zip` and `$range`.
- MEASURED: a three-argument `$slice` refuses a count of 0, and the first and the last index reach it. `.with()` avoids that form.
- `$concatArrays` takes arrays only. So a scalar argument of `.concat()` becomes the one-element array that it stands for, as in JavaScript. An argument that the proof cannot place tests `$isArray` at run time. When the proof shows that each element of a spread is an array, the `$reduce` splices it with no test.
- `.join(sep)`: `$ifNull` wraps the `$reduce`, so an empty array answers `""` and not the `null` seed. That guard also reads a missing receiver as `""`, so HR5 adds no second `$ifNull`. The seed is `null`, so a leading `""` element keeps its separator.
- `$sum`, `$avg` and `$max` answer null as they answer `[]`. So HR5 adds no `$ifNull` to them.
- `$type` names every binData `"binData"`. So `.isUUID()` also asks for subtype 4, through `$convert` to a UUID string.
- An ObjectId and a UUID have no safe value. So the dot and `?.` emit one document for `.toObjectId()` and `.toUUID()`.
- `[1, 2].toDouble()` is deliberately invalid. The literal goes one level deeper, so the server reads it as one argument and gives its conversion error.
- A reducer body that calls anything reads the two variables of the reducer through a `$let`. The call can own a `$reduce` of its own, which rebinds `$$this` and `$$value`.
- MEASURED: the second operand of `$in`, both operands of `$setIsSubset` and the operand of `$size` abort the whole command on a null or missing value. `$map`, `$filter`, `$slice`, `$setUnion` and their kin answer null instead. A document that lacks the field would stop the query. So each of these reads its list as the empty list. A list argument reads it through the guard of its cell. A receiver reads it through HR5, which runs an array method on `[]`. `GUARDED` holds, per row, the source, the answer over an empty document, and the answer when only the list is missing.
- `$objectToArray` answers null for a missing field, and `$arrayToObject` passes that null on. HR5 decides the answer by the accessor. A method under a dot runs on `{}`, so it answers `{}`, or `[]` where it answers an array. A `?.` with a call after it stops the chain, so the chain answers null. The root document is always there, so `$.keys()` takes no neutral value.
- `.sample()` picks at random, so its answer is a membership. An element of `[]` is missing on the server, so a missing `a` writes no field.
- A dot reads a missing string as `""`, and a conversion such as `.toDouble()` stops on it. The server refuses that document deliberately. The `?.` spelling answers null.
- A millisecond count converts with `.toLong().toDate()`. MEASURED: `$toDate` refuses an int, and the driver sends a whole JavaScript number below 2^31 as an int. `$toLong` reads every number and cuts a fraction toward zero.

## Consequences

Keep each guard while the server limit holds. A guard that the server does not need is a dead guard, and the guard test of `test-methods-null-facts` finds it. Run a changed shape on the `:27018` mongod before you trust it.
