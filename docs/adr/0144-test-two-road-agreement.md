# 0144. Server gates compare two lowerings of one source on the same documents

Status: Accepted
Applies to: `test/parity.test.ts`, `test/query-expr-agreement.test.ts`

## Context

Some sources have two lowerings that live in different files and share no code. A method name in both the value and the stream rows has a value form (`$.rows.take(2)`) and a stream form (`$$ = $$.take(2)`). A predicate has a query form (`{ age: { $gt: 18 } }`) and an expression form (`{ $gt: ["$age", 18] }`). Each side can be consistent with itself and still select different documents. A unit test of one side cannot see that drift.

## Decision

`test/parity.test.ts` runs each case of `CASES` in both positions over the same documents on the live `mongod`, and compares the results. The contract is which elements survive and the shape they come back in. `bag()` compares without order, because parity is about membership. A sort case also contracts the order, because the developer wrote that order. It states the `_id` order that JavaScript gives, so a lowering that drops the sort on both sides still fails. The order of any other method's result is not contracted. JSMQL takes MongoDB's behaviour and the smaller MQL (SR2 in docs/LANG_RULES.md). For example, the value form of `.uniqBy` keeps the input order through `$reduce`, and the stream form uses `$group` and does not.
`test/query-expr-agreement.test.ts` runs each source in `AGREE` as a filter through `find`. It also runs each source as an expression through `$addFields` + `$match`. Both must select the same `_id`s. The fixture `DOCS` mixes a missing field, an empty string, `false`, an explicit `null`, a negative number and a float. The two languages reason differently about absence and truthiness for these values. Only one document carries `items`, so the other documents test the missing-receiver path.
The rows of `AGREE` target known risks:
- `typeof` reads one alias table in `src/registry/vocabulary.ts` from both the query cell and the expression cell.
- A needle with a regex metacharacter (`"h."`, `"l."`) must be escaped. An unescaped needle selects different documents on the two roads.
- A JavaScript-only regex flag such as `g`: the expression side strips it (`mongoRegexOptions`), and the query side gives the pattern to `new RegExp` for the driver to serialise. The server refuses `g`, so the row proves that the driver drops the flag. If the driver changes, the query side fails here.
- `=== undefined` is an existence test on both roads (`$exists`, and `$type` against `"missing"`), and an explicit `null` is not absent.
- `.some` on a missing `items` must not abort the expression road, and the query form must answer correctly.
`SAME_QUERY` holds predicates with no query clause (for example `.every`, because `$elemMatch` tests some element). For these the filter road wraps the expression road's own document in `$expr`, so a server comparison compares the server with itself. The test asserts that identity instead (`sameQuery`). A test also fails when an `AGREE` or `DIVERGE` row emits one query on both sides.
`DIVERGE` holds sources whose two lowerings differ because of a MongoDB semantics fact. Each row states the reason. The test asserts the difference in both directions: when a change repairs a divergence, the test fails, and the row must move to `AGREE`.
Both suites skip themselves (green) when no server is up. Each carries an all-or-nothing guard: every case ran against the server, or none did. A green run with zero comparisons looks the same as a pass, so a partial run must fail. `test/parity.test.ts` also requires that each case names a method in both the stream and the value rows. It also requires that the cases cover at least a third of that shared set.

## Consequences

A new method with both a value and a stream form needs a parity case when the floor demands it. A new query cell needs an `AGREE`, `SAME_QUERY` or `DIVERGE` row. A divergence never goes in silently: it needs a `DIVERGE` row with a reason.
