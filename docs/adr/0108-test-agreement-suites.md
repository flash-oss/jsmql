# 0108. How the agreement suites sort a source into AGREE, DIVERGE and SAME_QUERY

Status: Accepted
Applies to: `test/compiler-js-agreement.test.ts`, `test/compiler-query-expr-agreement.test.ts`

## Context

`test/compiler-js-agreement.test.ts` compares the filter target with JavaScript. `test/compiler-query-expr-agreement.test.ts` compares the query road with the expression road. Each suite sorts its sources into tables. A row is in a table for a reason that the code does not show.

## Decision

- `.includes(x)` on a string is a substring test, and the query road emits a regex for it. The regex reads an array element-wise, as JavaScript's `.includes` reads an array. So both sides select the string that holds the needle and the array that holds it. The `$.tags.includes(…)` rows are in AGREE.
- A JavaScript spelling reads the own value of the field on both roads, through `queryOwnValue` in `src/registry/vocabulary.ts`. So an array element never divides the two roads.
- `.has()` tests membership as `===` does. A missing field is not null for it.
- An `$elemMatch` body keeps `$or` and `$nor` over the fields of an element. The rows over `$.it.some(…)` prove this.
- `SAME_QUERY` holds the sources that have no query clause. For them, the query road wraps the document of the expression road in `$expr`. The two roads then run one query, so a server comparison proves nothing. The test asserts that identity instead. A source that gets a query form fails this test, and its row moves to AGREE or DIVERGE.

## Consequences

A change to a query cell can move a row between tables. Move the row; do not delete it. Keep `SAME_QUERY` disjoint from AGREE and DIVERGE, because a separate test asserts it.
