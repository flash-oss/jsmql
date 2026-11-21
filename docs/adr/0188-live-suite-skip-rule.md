# 0188. A live suite skips only when no server answers, and states how much of its server half ran

Status: Accepted
Applies to: `test/fixtures/live.ts`, `test/live-suites.test.ts`, every suite that connects to the `:27018` instance

## Context

A live suite has two halves. The compile half asserts the emitted MQL. The server half runs that MQL on the project's `mongod`. Only the server half catches a shape that the server refuses, so it is the half that finds a real bug.

A contributor who skips `npm run fixture:up` has no server, and `npm test` must stay green for that contributor. But a suite that reports green while its server half never ran looks the same as a suite that passed. For example, `readWrite` alone cannot drop a database, and a suite can read that refusal as "no server" ([ADR 0033](0033-fixture-scratch-role.md)).

## Decision

- A live suite skips its server half for one reason only: no server answers on the port. Every other failure, for example a wrong password, a missing grant or a refused command, fails the suite. [ADR 0034](0034-fixture-server-signals.md) records how `isUnreachable` tells the two cases apart.
- One module, `test/fixtures/live.ts`, holds this distinction. A suite with its own `MongoClient` or its own reachability probe can make the distinction wrong again. So `test/live-suites.test.ts` refuses such a suite.
- No environment variable gates a server half. A half that runs only when someone exports a variable stays compile-only in every normal run.
- Each live suite asserts how much of its server half ran: every case or none, or a floor on the cases that compared a value. A case that returns early asserts nothing. A green run with zero comparisons looks the same as a pass, so a partial run must fail.

## Consequences

A new live suite connects through `test/fixtures/live.ts` and carries a guard on how much of its server half ran. A new reason to skip needs a change to this record first.
