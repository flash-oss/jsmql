# 0102. The CLI tests evaluate the printed JavaScript instead of a JSON parse

Status: Accepted
Applies to: `test/cli.test.ts`

## Context

The CLI writes JavaScript, not JSON. A developer pastes it where the driver's BSON classes are in scope.

## Decision

`test/cli.test.ts` evaluates the output with the driver's BSON classes (`BSON_GLOBALS`) in scope. The evaluation is the assertion that the printer exists for: text that the driver would refuse fails in the test first.

## Consequences

Make sure that `BSON_GLOBALS` holds the classes that `src/stringify.ts` writes. Do not replace the evaluation with a parse.
