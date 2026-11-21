# 0167. Every runtime type dispatch is a `$switch`

Status: Accepted
Applies to: `indexAccess` in `src/compiler/emit/lower.ts`, the family dispatch in `src/compiler/emit/select.ts`

## Context

`$lookup` evaluates its `let` against the outer document. Then it optimises the sub-pipeline with the result in place. So an expression that dispatches on type there folds against one constant value, branch by branch. A nested `$cond` folds the branch that does not apply, and the server can refuse the whole pipeline before it reads a document. MEASURED: the server refused `$.o = $$$.products.find({ _id: $.arr[0] })` for an array key, and again for a string key. Each time, the refusal came from the branch for the other type.

## Decision

Every runtime type dispatch that JSMQL writes is a `$switch`. A `$switch` drops a branch whose case folds to false, and needs no optimiser for it. The same hazard reaches a plain expression through any value that the server holds as a constant, for example a `jsmql.compile` parameter inside `$literal`. So the shape is one shape everywhere, and no rule picks it by position.

## Consequences

A new type dispatch must use `$switch`, never a nested `$cond`.
