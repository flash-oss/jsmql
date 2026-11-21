# 0090. Argument types and arity rules, with their measured refusals

Status: Accepted
Applies to: `src/registry/vocabulary.ts`

## Context

HR7 says that the compiler refuses a value that it PROVES to have the wrong kind. `ArgType` and `Arity` in `src/registry/vocabulary.ts` state each rule on the cell.

## Decision

- `int-or-long` and `number-or-date` are single checks, not unions. A merge of each pair states a rule narrower than the one the compiler applies.
- `fieldName`: a field NAME that a stage writes. MEASURED: the server refuses `{ $count: "$n" }` and `{ $count: "a.b" }`; it refuses an empty name, a `$` prefix and a dot.
- `fieldPath`: a field PATH that a stage reads. MEASURED: the server refuses `{ $unwind: "items" }`, and the `path` key of the object form, without the `$`.
- `orderable`: a number, a string, a date or an ObjectId, and the two sentinels, which compare with every type.
- `any` takes every kind and a literal `null`. A row states it on purpose, so "no limit" and "not yet typed" are different facts. The audit reports a slot with no type as an open item.
- `value` takes every kind but never `null`. A conversion uses it: `String(null)` has no meaning (HR7).
- `element`: a value of the kind of ONE element of the row's element source. The source is the receiver for a method and the last operand for a production (`x in [ … ]`).
- `Arity` lives per renderer, and per family inside one renderer. `spread` splices a spread argument in.
- `nonEmpty`: MEASURED on `$unset`, the server refuses `""` and `[]`. `noun` names one entry, and `instead` ends the message.
- `slotType` can hold a SET of kinds: `$unionWith` takes a collection name or a body document, and the server refuses an int. A value of unknown kind passes. `rest` states the kind of each slot beyond the named ones, because a call can have more operands than a row lists (`atLeast`).
- `homogeneous`: the first operand with a PROVEN kind sets the kind, and a later operand with another proven kind is a refusal. This is the rule of `===` (always false for two kinds) and `+` (a number and a string never add). An operand of unknown or mixed kind sets nothing. A literal `null` is not compared, because `x === null` is the null-or-missing test.
- `arrayOf`: every element of a literal array has one type. `.pick(["name", "email"])` lists names, and `.pick([1, 2])` projects fields `"1"` and `"2"`.
- `slotRange`: `$sampleRate` takes a rate in [0, 1], and the server refuses 2.
- `nonZero`: the server refuses `$divide($.a, 0)` and `$.a % 0`, and JavaScript's NaN answer has no MongoDB value.
- `zeroRefused`: MEASURED, `{ $range: [0, 5, 0] }` is refused, and `_.range(0, 5, 0)` repeats the start value. The text ends the message.
- `oneChar`: `.padStart(5, "0")` repeats one ASCII character, so a pad of two characters, an empty pad and `"é"` are refused.
- `integer`: `-1` names the receiver. MEASURED: `{ $range: [0, 2.5] }` is refused, because `$range` counts in whole numbers.
- `slotEnums`: a closed set per slot index, tested on a literal only. `$.d.plus(1, "day")` passes, and `"days"` is refused. `BodyRule.enums` is the same rule keyed by key name.
- `BodyRule` judges the options document of a JavaScript method. A `$op(…)` or `$stage(…)` body is the developer's own MQL, and no rule judges it (HR3 does not apply).
- Every rule above that reads a literal tests a literal only. A runtime value passes to the server.

## Consequences

A new slot rule needs a measurement on mongod and a pair in `test/types/registry-contracts.ts`.
