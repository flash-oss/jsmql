# 0056. The realistic examples drive the playground through test metadata

Status: Accepted
Applies to: `test/realistic.test.ts`, `scripts/sync-playground.mjs`

## Context

`test/realistic.test.ts` is the usage showcase that README.md links to. The playground shows the same examples. `scripts/sync-playground.mjs` reads the test file to build `playground.html`, and it needs a group, a label and a usage line for each example.

## Decision

- The test file is the one source of the playground examples. Each example carries its playground data as test options on its `describe()` and `it()`. So every example that the playground shows is also a test that asserts its MQL. test/CLAUDE.md § `realistic.test.ts` states the option keys.
- A `declare module "@vitest/runner"` block adds these keys to `TestOptions`. Vitest ignores unknown options at run time, so the block only stops editor warnings.
- A refusal example shows a frequent mistake that JSMQL refuses at compile time, for example a stage where the server refuses it. The test uses the throwing-call form, so the test checks the refusal and the sync script can extract the `jsmql(...)` call. The playground shows the refusal in an error panel.
- The monthly rollup example groups on `.startOf("month", tz)`, which lowers to `$dateTrunc`. A date is the bucket key MongoDB wants in `$group._id`. A `{ year, month }` pair sorts wrong and the server cannot compare it to a date. The timezone decides the bucket of an order near a boundary: 02:10 UTC on 1 August is 22:10 on 31 July in New York, so that order counts toward July.

## Consequences

A new example must carry the playground options. A refusal example must use the throwing-call form.
