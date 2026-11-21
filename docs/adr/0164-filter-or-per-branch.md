# 0164. A `||` in a filter lowers each branch on its own

Status: Accepted
Applies to: `src/compiler/emit/filter.ts`, docs/specs/emit-pass.md § The filter target, docs/specs/filter-mode.md § The filter road

## Context

A branch of `||` can have no native query form, for example `$.q * $.p > 100`. The compiler can then put one `$expr` around the whole `||`, or it can give `$expr` only to the branch that needs it.

## Decision

Each branch lowers on its own: `{ $or: [{ tags: "red" }, { $expr: … }] }`.

- One `$expr` around the whole `||` changes what the other branches mean. `{ $expr: { $eq: ["$tags", "red"] } }` does not match `tags: ["red", "blue"]`, where `{ tags: "red" }` does. So the answer of a leaf would depend on its sibling. Per branch, a predicate means the same thing beside a sibling as it means alone.
- Per branch also changes WHEN a branch runs. The server picks the order of the clauses in a query document. So a branch whose expression the server refuses on some document can run on that document. MEASURED over `{a:1,b:1,c:5}`, `{a:2,b:"oops",c:1}` and `{a:2,b:1,c:9}`, the program `($.a === 1 || $.b * 2 === 2) && $.c > 3` gives two results. Per branch, the server refuses it, because `$multiply` gets the string `"oops"`. With one `$expr`, it selects `_id` 1 and 3, because the `c` clause excludes the string `b` first.
- The server does not promise either order. `"oops" * 2` is `NaN` in JavaScript, and JSMQL does not model NaN. So an arithmetic expression over a field of mixed type can fail on either shape, and the per-branch rule stands.

## Consequences

A native branch stays native beside an `$expr` branch, and it keeps its index. An arithmetic branch over a field of mixed type can make the server refuse the query.
