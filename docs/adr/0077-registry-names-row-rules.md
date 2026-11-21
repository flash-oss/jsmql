# 0077. Per-row server facts for conversions, BSON values, dates and accumulators

Status: Accepted
Applies to: `src/registry/names.ts`

## Context

Many rows state an argument rule, a binding scope or a null fact that comes from one server measurement. The reason for each fact is not visible in the row.

## Decision

Conversions and type tests:
- MEASURED: each `$to…` operator gives null for null, so the `conversion` rows state `passesNull`. `$toString` gives null for null. lodash `_.toString(null)` is `""`, so `.toString()` states `nullReceiverAs: ""`.
- `.toString()` on a regex literal writes the text that `$toString` gives for the BSON regex, because a regex literal has no value of its own. MEASURED: `$toString` of `/a+/is` is `"/a+/is"`.
- `.toBool()` follows MongoDB `$toBool`, not JavaScript truthiness: `$toBool("")` is true.
- The filter form of a type test is the form that `typeof x === "<alias>"` gives, so an index can serve it.
BSON values (`bsonValue`, `bsonSentinel`, `dateRow`):
- `spelling` is the name the row answers to, so every message names what the user typed. `method` is the conversion method that a document value takes instead, and the refusal names it. `refuseConstant` is the message for a constant that the type cannot hold. The `constant` cell builds the value with `construct` and throws this message. The message names the type that fits.
- `takes`: the kinds that the `$to…` operator reads. MEASURED: a string or a number converts. Absent means both.
- `MinKey()` and `MaxKey()` compare with every type and compute with none. MEASURED: the server refuses `$add: [MinKey, 1]`, and refuses `{ $minKey: 1 }`. No MQL expression produces the value, so the cell puts the live value into the MQL as itself.
- A `Date(…)` with literal parts never reaches the date row, because the constant engine reads it first (src/compiler/passes/date-literal.ts). The constant slot states its kinds, so a constant of another kind gets the wrong-kind refusal. The cell refuses a date and a string that no date parser reads, because a type name is no conversion (`convertsWith`). A number is a count of milliseconds and must be an integer. MEASURED: `$toDate` cuts a fraction toward zero (2020.5 gives 2020 ms, -2020.5 gives -2020 ms). JSMQL does not cut a value silently, so the compiler refuses a fraction.
- `Date($.y, $.m, $.d)` lowers to `$dateFromParts`; the compiler refuses an eighth argument. Months are 1-based here, unlike JavaScript. MEASURED: `$dateFromParts` refuses a fractional double or Decimal128 in each part, and reads a whole double. So the compiler refuses a fraction.
Date units:
- `TIME_UNIT`: MEASURED, the server refuses `"days"` and `"Day"`, so the list is exact and case-sensitive. One constant serves every row, so no stale copy can refuse a valid unit or accept an invalid one.
- `WINDOW_TIME_UNIT` (`$derivative`, `$integral`): MEASURED, the server refuses `unit: "month"`; the largest unit is `"week"`. It is a different set, so it has a different name.
- `WEEKDAY` (`startOfWeek`): the seven day names and their three-letter forms. The server compares them case-insensitively (`"Monday"` and `"mon"` run, `"funday"` fails). A list of the long names alone would refuse valid MQL, which is the dangerous direction.
Stream and accumulator rows:
- `sortStages`: a sort by a name is one `$sort`. MongoDB cannot sort by a key that the pipeline computes. So the cell writes such a key to a scratch field and sorts by that field. The cleanup of the chain then drops the field.
- `n()` reads a literal count. The row's `args` refuses any other operand first, so its fallback is never reached.
- `$filter`: MEASURED, `limit` cannot see `$$this`, so `binds.visibleIn` is `["cond"]`. `$reduce`: MEASURED, `initialValue` cannot see `$$this`, so `visibleIn` is `["in"]`.
- `$sampleRate`: the server requires a constant, and a query document holds values. A rate known only at run time has no query form in the filter cell, so the call takes HR2's plain form.
- The array accumulators state `neverNull: true`, because MEASURED the accumulated array over a missing field is `[]`. `$sum` states `"always"`, because MEASURED `{ $sum: null }` and a `$group` sum over a missing field both give 0.
- `$covariancePop` and `$covarianceSamp`: MEASURED, one and three operands run and answer null. The server refuses none of 1, 2 or 3, so the row allows all three.

## Consequences

Each fact here must change only after a new measurement on the project's mongod. Keep one shared constant per unit set.
