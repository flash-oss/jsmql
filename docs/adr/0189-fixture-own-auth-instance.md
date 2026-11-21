# 0189. The project runs its own auth-enabled mongod for the fixture

Status: Accepted
Applies to: `test/fixtures/config.ts`, `test/fixtures/instance.ts`

## Context

The integration suite needs a read-only user that the server enforces, so that a test run cannot change the dataset. A role has an effect only under `--auth`, and `--auth` applies to a whole instance. MongoDB's default port carries the developer's own instance and their real work ([ADR 0122](0122-test-no-default-port-guard.md)).

## Decision

- The project starts its own `mongod` on port 27018 with `--auth`. If `--auth` were on for the developer's own instance, every other service on their machine would need credentials.
- `test/fixtures/config.ts` holds the credentials in plain text, and they are not secret. The instance is local and disposable. Its only job is to enforce the read-only role.
- The dbpath `~/.jsmql-fixture/` is outside the repository and outside the worktree. So the data survives a worktree cleanup, and all branches share one instance.

## Consequences

Do not reuse the credential pattern for a real deployment. The dbpath holds only throwaway data, so `npm run fixture:reset` may delete it.
