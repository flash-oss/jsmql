# 0132. A test that needs a trailing comma in an arrow uses the string entry

Status: Accepted
Applies to: `test/codegen.test.ts`

## Context

`npm run format` runs oxfmt over the test files. The formatter removes a trailing comma inside a params destructure (`{ min, }`) and after the `{ $ }` toolbox slot (`{ $ },`). A test that writes the arrow as a real function loses the commas that it means to test.

## Decision

The trailing-comma test for the `jsmql.compile` signature in `test/codegen.test.ts` passes the arrow as a string: `jsmql.compile("({ min, }, { $ },) => $.age > min")`. The formatter does not touch the text of a string.

## Consequences

A test whose subject is a spelling that the formatter normalises must pass the source as a string. A real arrow is the wrong tool for such a test, because the formatter changes the source before the test runs.
