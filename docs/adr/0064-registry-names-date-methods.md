# 0064. Date method offsets and part families

Status: Accepted
Applies to: `src/registry/names.ts`

## Context

JavaScript counts months and weekdays from 0. MongoDB counts them from 1. MEASURED: `$month` of January is 1. Date parts also come in two families that the server does not mix.

## Decision

- `getMonth`, `getUTCMonth`: `{ $subtract: [{ $month: recv }, 1] }`. `getDay`, `getUTCDay`: `{ $subtract: [{ $dayOfWeek: recv }, 1] }`.
- `Date.UTC(year, month, …)`: the month counts from 0, as in JavaScript. The cell adds one for `$dateFromParts`.
- `.set({ … })`: the parts that the call names decide the family. An ISO-week marker selects `DATE_PARTS_ISO`, and any other set selects `DATE_PARTS_CALENDAR`. The other parts of the family come from the date itself, through `$dateToParts`. A key outside the family can come only from a document that the call supplies as a value. The cell passes that key through, and the server judges it.
- `.endOf(unit)`: the cell computes the start of the NEXT bucket (`$dateTrunc`, then `$dateAdd` of one bucket) and subtracts one millisecond.

## Consequences

A new date getter must apply the same offset when JavaScript counts from 0. A new date setter must keep one family per call.
