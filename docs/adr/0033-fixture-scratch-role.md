# 0033. The scratch user holds one custom role with readWrite, dbAdmin and indexStats

Status: Accepted
Applies to: `test/fixtures/config.ts`, `test/fixtures/instance.ts`

## Context

Every live suite that seeds its own documents connects as `SCRATCH_USER`. A suite needs more than `readWrite` on its own database.

## Decision

`ensureScratchUser` in `test/fixtures/instance.ts` builds the custom role `SCRATCH_ROLE` (`jsmqlScratch`). The role names what a suite does to its own database, and nothing more:
- `readWrite` lets a suite insert the documents that it asserts against, and read them back.
- `dbAdmin` lets a suite drop its database first. `readWrite` alone cannot drop a database. Without it, the drop throws, a suite reads that as no server, and it reports green with only its compile-only half.
- The `indexStats` privilege lets `test/compiler-sugars.test.ts` run the `$indexStats` stage. No built-in role carries it per database, so the role names it as a privilege.

`SCRATCH_USER` holds `SCRATCH_ROLE` and nothing else. The script creates the role and the user, or updates both when they exist, so the grants follow `SCRATCH_DBS`.

## Consequences

A new action that a live suite needs goes into this role. `test/no-default-port.test.ts` checks that the identity holds `readWrite`, `dbAdmin` and `indexStats` on every scratch database.
