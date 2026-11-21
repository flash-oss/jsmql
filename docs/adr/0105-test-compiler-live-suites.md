# 0105. How the compiler live suites account for every source they run

Status: Accepted
Applies to: `test/compiler-statement.test.ts`, `test/compiler-sugars.test.ts`

## Context

`test/compiler-statement.test.ts` and `test/compiler-sugars.test.ts` run every asserted pipeline on the project's mongod (HR3). Some valid shapes cannot run on the fixture deployment. A silent skip of such a source hides a gap.

## Decision

`test/compiler-statement.test.ts` keeps two tables of allowances:
- `NEEDS_MORE_THAN_A_SERVER` names a source whose pipeline is valid MQL that this deployment cannot run. A sort by `$meta("textScore")` needs a text index and a `$text` query to make the score. The run skips these sources.
- `REFUSED_BY_ENVIRONMENT` names a source that the server refuses because of the deployment, not the shape. A collection-level aggregate cannot start from `$documents`. `$geoNear` needs a 2d or 2dsphere index, and the fixture has no reason to carry one. The server must refuse each entry with its own message, which the table matches by a regex.

Two gates keep the tables honest. An allowance has an effect only when a case in the file asserts its source, so a test checks that `RUNS` holds each one. The run then checks two facts. Each environment refusal is one that the table names. The sum of runs, environment refusals and allowances equals the number of sources. So the suite skips no source without a name.

The fixture documents carry `sub.deep` as a document in every document, because the server refuses a reshape to a value that is not a document. `$$ = $$.map(d => d.sub.deep)` runs on the server for this reason.

`test/compiler-sugars.test.ts` compares results through `shrink`. A fixture document becomes its `_id` and each field that differs from the fixture: a field the pipeline added or wrote. It becomes its `_id` alone when no field differs. A facet branch becomes a list of such values. The mutator cases compute each expectation as JavaScript's own answer over the fixture.

## Consequences

A new source that cannot run on the fixture must go into one of the two tables, with its reason. An entry that no case asserts fails the build. A change to the fixture documents must keep `sub.deep` a document in every document.
