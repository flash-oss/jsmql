# 0131. A test enforces the single-server rule and the scratch database grant

Status: Accepted
Applies to: `test/no-default-port.test.ts`

## Context

This project connects to one `mongod`: the instance on port 27018 that `npm run fixture:up` starts. MongoDB's default port belongs to the developer's own instance, which holds their real work. A rule in prose alone breaks when someone copies a connection string from a tutorial. A live suite that writes to a database outside the scratch grant gets an authentication error. A suite that skips itself can turn that error into a green run.

## Decision

`test/no-default-port.test.ts` checks two things. First, no file in the repository names the default port in a connection string. Second, `SCRATCH_DBS` in `test/fixtures/config.ts` lists every database that a suite names, and that list is the grant the scratch user holds.
The port scan skips `SKIP_DIRS`: directories that hold no source of this project, and `DEVLOG`. `docs/DEVLOG/` is the historical record and states what was once true, so it is exempt. The test file itself is in `EXEMPT` for the same kind of reason.
The scan also skips a nested git worktree (`isOwnCheckout`). A worktree root carries `.git` as a file that points at the parent repository. A worktree under `.claude/worktrees/` is another branch at another commit, and its content is true of that branch, not of this checkout.
The test builds the banned port literal from two halves, so that the file does not match its own search.
The database check allows `admin` in addition to `SCRATCH_DBS`. A suite names `admin` only to send `ping`, which needs no role, and `admin` holds no data.

## Consequences

A new live suite must add its database to `SCRATCH_DBS` and re-run `npm run fixture:up`. A new directory of vendored or generated content goes into `SKIP_DIRS`. Never write the default port as one literal in this test.
