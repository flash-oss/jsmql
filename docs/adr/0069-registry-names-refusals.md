# 0069. Refusals of JavaScript spellings that have a JSMQL equivalent

Status: Accepted
Applies to: `src/registry/names.ts`

## Context

JSMQL gives one spelling to one capability. Some JavaScript spellings parse but have a shorter or safer JSMQL form, and the refusal must lead the developer there.

## Decision

- `Array.from(…)` is refused in every position, because `.range()` does the same job. MEASURED: `Array.from({ length: 3 }, (_, i) => i * 2)` emitted a `$let` that binds an unused element, and `(3).range().map(i => i * 2)` does not.
- A type name used as a conversion function (`String(x)`, `Number(x)`) is refused, because the value's own method does the same job.
- `afterStringMethod` adds a hint to a conversion refusal. A dot reads a missing string as `""` (HR5), so the `?.` must stop the chain at the field, before the string method runs. MEASURED: `$toDouble`, `$toInt`, `$toLong`, `$toDecimal`, `$toDate`, `$toObjectId` and `$toUUID` stop the command on `""`; `$toString` and `$toBool` accept it.
- `MILLIS_TO_DATE`: the date refusal names two steps for a number of milliseconds. MEASURED: `$toDate` refuses an int, and a driver sends a whole JavaScript number below 2^31 as an int. `$toLong` reads every number and cuts a fraction toward zero, as `new Date(x)` does. So the hint names `.toLong().toDate()`.

## Consequences

A new refusal of this kind must name the one JSMQL spelling. Measure any server claim that the hint makes.
