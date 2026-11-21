# 0125. A live gate checks the `$merge.whenMatched` stage set against the server

Status: Accepted
Applies to: `test/compiler-statement.test.ts`

## Context

`$merge.whenMatched` takes an UPDATE, not a pipeline. The server runs a closed set of stages there, and refuses the rest outright. The compiler reads that set from the `statementBody` fact of the `$merge` row. A row that disagrees with the server makes the compiler refuse a valid stage, or pass an invalid one.

## Decision

`test/compiler-statement.test.ts` asks the server, one stage per run, and compares two sets. `SERVER_ALLOWS` lists the stages that the server runs in `whenMatched`, measured with the `BODIES` table. The list is independent of the row, so the compile-time test compares the compiler with the server, not with the row that the compiler reads. `BODIES` holds a body that each stage accepts, so a refusal concerns the update and not the shape. A refusal for any other reason means that the probe body was wrong, and the test fails. A silent miscount is the one failure that this gate must not have. The test also checks that every name in `SERVER_ALLOWS` has a body in `BODIES`, so the probe runs every name that the list states. A stage in the set passes through unchanged. The compiler refuses every other stage at compile time.

## Consequences

A new server version can change the set. Measure it again with the probe, and update `SERVER_ALLOWS` and the row together.
