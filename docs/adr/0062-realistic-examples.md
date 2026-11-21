# 0062. The realistic examples drive the playground through test metadata

Status: Accepted
Applies to: `test/realistic.test.ts`

## Context

`test/realistic.test.ts` is the source of the playground examples and the usage showcase that README.md links to. `scripts/sync-playground.mjs` reads the file to build `playground.html`. It needs a group, an entry point and a usage line for each example.

## Decision

Each top-level `describe()` is one playground example. Its second argument, `{ features: [...] }`, sets the sidebar group. Each `it()` takes `{ kind, usage }` as its second argument. `kind` selects the entry point (`jsmql` for a filter or pipeline, `jsmql.expr` for a raw expression, `err` for a refusal). `usage` is the literal `db.<collection>.<method>(...)` call that the playground shows. A `declare module "@vitest/runner"` block adds these keys to `TestOptions`; Vitest ignores unknown options at run time, so the block only stops editor warnings.
A `kind: "err"` example shows a frequent mistake that JSMQL refuses at compile time, for example a stage where the server refuses it. The test uses the throwing-call form, so the test checks the refusal and the sync script can extract the `jsmql(...)` call. The playground shows the refusal in an error panel.
The monthly rollup example groups on `.startOf("month", tz)`, which lowers to `$dateTrunc`. A date is the bucket key MongoDB wants in `$group._id`. A `{ year, month }` pair sorts wrong and cannot be compared to a date. The timezone decides the bucket of an order near a boundary: 02:10 UTC on 1 August is 22:10 on 31 July in New York, so that order counts toward July.

## Consequences

A new example must carry `features` on its `describe()` and `kind` and `usage` on its `it()`. A refusal example must use the throwing-call form.
