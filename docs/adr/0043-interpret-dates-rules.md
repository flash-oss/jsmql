# 0043. The measured rules of the date interpreter

Status: Accepted
Applies to: `src/compiler/interpret/dates.ts`

## Context

The date operators in `src/compiler/interpret/dates.ts` must give the server's exact answer, or refuse. The server has rules that its documentation does not state. src/compiler/interpret/CLAUDE.md § The measured facts that look arbitrary states the UTC rule, the `$dateTrunc` anchor, the ISO string forms and the `$toDate` rule. This record keeps the other measured rules.

## Decision

- A date is a number of milliseconds since the epoch, and every rule works in UTC. `utcOnly` is the one place that states which `timezone` values run.
- The calendar arithmetic uses integers only (`daysFromCivil`, `civilFromDays`), so it is exact for every year that a JavaScript Date holds. A result outside the range of a JavaScript Date is a refusal (`dateAt`).
- `$dateAdd` clamps the day of month to the last day of the target month (`shift`). A fixed unit moves the instant. A calendar shift whose month count is above 4_000_000 is a refusal: it leaves the range of a Date, and the bound keeps the product exact.
- `$dateDiff` counts the unit BOUNDARIES crossed, not the elapsed units (`unitIndex`). For a week, the index is the first day of the week, less the days that the epoch week starts after it, divided by 7.
- `$dateFromParts` carries a part out of range into the next part: a month into the year, a day into the month. It refuses a part outside the range that the server accepts.
- `$dateToString` knows a fixed list of format specifiers (`SPECIFIERS`). The server fails on another specifier, on a `%` at the end, and on a year specifier for a year outside 0 to 9999. The server writes a year in that range with four digits.
- A `timezone` of null in `$dateToString` is a refusal, because the server answers it in a way that the rule does not state.
- In `$dateFromString`, an input that is a number, a boolean or a date fails on the server, and `onError` then gives the answer. Any other non-string input is a refusal.
- `startOfWeek` matters to the week unit only. MEASURED: the server ignores it for any other unit, even when it is null (`nullWeekStart`).
- A keyed date operator (`dated`) evaluates every operand, and the first operand with no value stops the walk. A null operand makes the answer null only when every other operand is valid. The server fails on an invalid operand beside a null one in some cases and not in others, so the rule refuses where it cannot tell. `shape` judges the written keys before the rule reads an operand.
- `$year` and the operators like it take a date, `[date]`, or `{ date, timezone }`. A document with a dollar key is an expression, so it is one argument.

## Consequences

A new date rule must measure the server on each edge before it answers. A change to a bound or a clamp must keep the result inside the range of a JavaScript Date and keep the arithmetic exact.
