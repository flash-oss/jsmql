# 0032. Two writes to the same path in one `,` run take two `$set` stages

Status: Accepted
Applies to: `test/compiler-statement.test.ts`

## Context

Inside a `,`-joined run, the statement target groups writes into as few `$set` stages as it can. docs/specs/emit-pass.md § The statement target lists the facts that end a group. A run that writes the same path twice, for example `$.a = 1, $.a = 2`, is not in that table.

## Decision

The statement target ends the group at a second write to a path that the group already writes. `$.a = 1, $.a = 2` lowers to `[{ $set: { a: 1 } }, { $set: { a: 2 } }]`. The source says two things about one path, so the output keeps both writes in order. One `$set` cannot hold a key twice.

## Consequences

The last write wins, as in JavaScript. A change to the grouping logic in `src/compiler/emit/statement.ts` must keep this split. The spec table of group breaks can take this row.
