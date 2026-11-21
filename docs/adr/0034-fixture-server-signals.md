# 0034. How the fixture code reads the server's answer to a shutdown and to a failed connection

Status: Accepted
Applies to: `test/fixtures/instance.ts`, `test/fixtures/live.ts`

## Context

The fixture code must tell a stopped server from a refused request. A wrong reading either hides a failure or reports one that did not happen.

## Decision

- `shutdown` in `test/fixtures/instance.ts` sends the `shutdown` command. The server drops the connection, so the command rejects. That rejection means success, and the code ignores it.
- `isUnreachable` in `test/fixtures/live.ts` decides when a live suite may skip. Measured against the project's instance, a dead port answers `MongoServerSelectionError`, because the port refuses the connection. A wrong password answers `MongoServerError` with code 18. A missing grant answers `MongoServerError`, because the user has no grant for the command. Only a failure to reach the server is a reason to skip. The function accepts `MongoServerSelectionError` and `MongoNetworkError`.

## Consequences

A new driver version can rename these errors. Measure the names again before a change to `isUnreachable`. Every other error must stay a failure.
