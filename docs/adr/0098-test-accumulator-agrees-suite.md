# 0098. The accumulator-agreement suite excludes data-type errors, and reduces an array literal per document

Status: Accepted
Applies to: `test/compiler-accumulator-agrees.test.ts`

## Context

`test/compiler-accumulator-agrees.test.ts` runs every JavaScript accumulator spelling in the `group` and `window` slots on a live mongod, over three receivers: a number field `$.n`, an array field `$.a` and an array literal `[$.n, $.m]`. The suite must find a slot-shape error. It must not report an error that comes from the type of the data.

## Decision

- `TYPED_OUT` lists each pair of spelling, slot and receiver that fails because of the data, not the slot shape. `.sumBy(fn)` and `.meanBy(fn)` map their receiver, and `$map` refuses a number, because its input must be an array. The list names each pair, so it cannot hide a shape error.
- An array literal receiver holds one array on each document. The aggregate reads that array as JavaScript does on that document, and then the slot accumulates the results. Over `{ n: 1, m: 2 }` and `{ n: 3, m: 4 }`, `.sum()` is `(1 + 2) + (3 + 4)`, which is 10. The `EXPECTED` table in the suite states each answer.

## Consequences

A new exclusion goes into `TYPED_OUT` by name, never as a broad filter. The expected values for the array literal must stay per-document reductions followed by the accumulation.
