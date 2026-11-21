# 0099. The agreement suites compare two readings of one source on a live server, and sort each source into AGREE, DIVERGE or SAME_QUERY

Status: Accepted
Applies to: `test/parity.test.ts`, `test/query-expr-agreement.test.ts`, `test/compiler-query-expr-agreement.test.ts`, `test/compiler-js-agreement.test.ts`

## Context

Some sources have two lowerings that live in different files and share no code. A method name in both the value and the stream rows has a value form (`$.rows.take(2)`) and a stream form (`$$ = $$.take(2)`). A predicate has a query form (`{ age: { $gt: 18 } }`) and an expression form (`{ $gt: ["$age", 18] }`). Each side can be consistent with itself and still select different documents. A unit test of one side cannot see that drift. JavaScript gives a third reading of a filter, over the same documents.

Each agreement suite sorts its sources into tables. A row is in a table for a reason that the code does not show.

## Decision

All four suites:
- Each suite runs both readings over the same documents on the live `mongod`, and compares the results.
- `DIVERGE` holds the sources whose two readings differ because of a semantics fact. Each row states its reason. The test asserts the difference in both directions. So a change that repairs a divergence fails the test, and the row moves to `AGREE`. A divergence never passes silently.
- `SAME_QUERY` holds the predicates with no query clause, for example `.every`, because `$elemMatch` tests some element. For these, the query road wraps the document of the expression road in `$expr`. The two roads then run one query, so a server comparison compares the server with itself. The test asserts that identity instead (`sameQuery`). A source that gets a query form fails this test, and its row moves to `AGREE` or `DIVERGE`.
- A test fails when an `AGREE` or `DIVERGE` row emits one query on both sides. A separate test keeps `SAME_QUERY` disjoint from `AGREE` and `DIVERGE`.
- Each suite carries the ran-guard of [ADR 0188](0188-live-suite-skip-rule.md).

`test/parity.test.ts` (the value form against the stream form):
- The contract is which elements survive, and the shape they come back in. `bag()` compares without order, because parity is about membership.
- A sort case also contracts the order, because the developer wrote that order. It states the `_id` order that JavaScript gives, so a lowering that drops the sort on both sides still fails.
- The order of the result of any other method is not contracted. JSMQL takes MongoDB's behaviour and the smaller MQL (SR2 in docs/LANG_RULES.md). For example, the value form of `.uniqBy` keeps the input order through `$reduce`, and the stream form uses `$group` and does not.
- Each case names a method in both the stream and the value rows. The cases cover at least a third of that shared set.

`test/query-expr-agreement.test.ts` (the query road against the expression road):
- Each source runs as a filter through `find`, and as an expression through `$addFields` and `$match`. Both must select the same `_id`s.
- The fixture `DOCS` mixes a missing field, an empty string, `false`, an explicit `null`, a negative number and a float. The two languages reason differently about absence and truthiness for these values. Only one document carries `items`, so the other documents test the missing-receiver path.
- The rows of `AGREE` target known risks:
  - `typeof` reads one alias table in `src/registry/vocabulary.ts` from both the query cell and the expression cell.
  - A needle with a regex metacharacter (`"h."`, `"l."`) The test must escape a needle with a regex metacharacter. An unescaped needle selects different documents on the two roads.
  - A JavaScript-only regex flag such as `g`: the expression side strips it (`mongoRegexOptions`), and the query side gives the pattern to `new RegExp` for the driver to serialise. The server refuses `g`, so the row proves that the driver drops the flag. If the driver changes, the query side fails here.
  - `=== undefined` is an existence test on both roads (`$exists`, and `$type` against `"missing"`), and an explicit `null` is not absent.
  - `.some` on a missing `items` must not abort the expression road, and the query form must answer correctly.

`test/compiler-query-expr-agreement.test.ts` and `test/compiler-js-agreement.test.ts`:
- `.includes(x)` on a string is a substring test, and the query road emits a regex for it. The regex reads an array element-wise, as JavaScript's `.includes` reads an array. So both sides select the string that holds the needle and the array that holds it. The `$.tags.includes(…)` rows are in `AGREE`.
- A JavaScript spelling reads the own value of the field on both roads, through `queryOwnValue` in `src/registry/vocabulary.ts`. So an array element never divides the two roads.
- `.has()` tests membership as `===` does. A missing field is not null for it.
- An `$elemMatch` body keeps `$or` and `$nor` over the fields of an element. The rows over `$.it.some(…)` prove this.
- In `test/compiler-js-agreement.test.ts`, two reasons cover almost every `DIVERGE` row, and neither is an array bug. JavaScript coerces a value under a relational operator (`[2] > 1` is true). JavaScript throws when a path walks through a missing intermediate field.

## Consequences

A new method with both a value and a stream form needs a parity case when the floor demands it. A new query cell needs an `AGREE`, `SAME_QUERY` or `DIVERGE` row. A change to a query cell can move a row between tables. Move the row; do not delete it.
