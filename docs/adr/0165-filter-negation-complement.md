# 0165. `!p` in a filter is the `$nor` complement of p's own clause

Status: Accepted
Applies to: `src/compiler/emit/filter.ts`, docs/specs/emit-pass.md § A query document is the plain one

## Context

A negation in a filter can be `$not` over an `$expr`, `$not` around the positive clause, or `{ $nor: [<p>] }`. The three select different documents or plan differently.

## Decision

`!p` is `{ $nor: [<p>] }` whenever p has a clause with no `$expr` inside. This is not a choice for output size.

- `$expr` orders across BSON types. So `{ $not: { $gt: ["$v", 1] } }` is false for `v: [0, 20]` and for `v: "x"`, where JavaScript answers true for both. With `$not` over `$expr`, `$.v > 1 || !($.v > 1)` is not a tautology. With the complement, it is one (measured).
- The exclusion costs no index. MEASURED: `{ a: { $eq: 1 } }` plans an IXSCAN over the bounds `[1, 1]`, exactly as `{ a: 1 }` does. A `$not` around the whole positive clause becomes a collection scan.

A predicate with an `$expr` inside keeps the truth road, because its own `$not` over one expression is already JavaScript's answer.

## Consequences

A new query cell must give a clause whose complement is JavaScript's negation. `test/compiler-js-agreement.test.ts` compares the answers with JavaScript's own.
