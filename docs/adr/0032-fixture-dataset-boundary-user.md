# 0032. The fixture holds a user with no email field, beside a user with a null email

Status: Accepted
Applies to: `test/fixtures/dataset.ts`

## Context

User 5 has `email: null`. A missing field and a null field take different paths in the server and in JSMQL's coercion. A string method derives a length through `$strLenCP`, and `$strLenCP` aborts the query on a missing input.

## Decision

`test/fixtures/dataset.ts` holds user 9 with no `email` field at all. This document proves on a real server that the HR5 coercion of a missing string holds. The user is archived and inactive, so it falls outside every assertion on active users or on a non-null email.

## Consequences

A change to user 9 must keep `email` absent, and keep the user outside the active and non-null-email assertions.
