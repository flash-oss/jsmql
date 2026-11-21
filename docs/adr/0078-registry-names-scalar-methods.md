# 0078. Null and boundary rules of the number and string methods

Status: Accepted
Applies to: `src/registry/names.ts`

## Context

HR5 says that a dot reads a missing value as the safe value of its family. Some operators stop the whole command on null or on a boundary value.

## Decision

- `.clamp(lower, upper)`: one cell serves a number and a date. `$max` ignores null. So the safe value gives null's answer when the lower bound has the same kind as the safe value and is not less than it.
- `.inRange(start, end)`: a field against two constant bounds is a range on one field. An index answers this clause, and a MongoDB developer writes the same document by hand. Under HR5 a dot reads a missing number as 0 and a missing date as the epoch. So a range that contains the safe value also matches a missing field (`orMissing`). In the value cell, null and the safe value are both outside a range that does not contain the safe value.
- `.round([precision])`: MEASURED, `{ $round: "$x" }` takes one operand, and 2.5 rounds to 2, as `{ $round: ["$x", 0] }` does. The cell emits the one-operand form when the call gives no precision.
- `.log()`, `.log2()`, `.log10()` and `.acosh()` state `nullReceiverAs: 1`. A logarithm of 0 stops the command, so the row reads a missing receiver as 1, as `_.divide()` reads a missing divisor.
- `.sign()`: `{ $cmp: [recv, 0] }`. Under a dot a missing or null number reads as 0, so the sign is 0 there.
- `.length` on a string: `$strLenCP` stops on null. A receiver that may be missing gives null, as a JavaScript method does. A receiver that is there gets the plain count.
- `.truncate({ length, omission })`: the options are constants, because the body rule says so. Without them the cell uses lodash's defaults.

## Consequences

A new number or string method that wraps an operator which stops on null must state its null rule in the row.
