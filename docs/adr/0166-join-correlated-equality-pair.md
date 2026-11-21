# 0166. A join that opens with a correlated equality is the `localField` / `foreignField` pair

Status: Accepted
Applies to: `src/compiler/emit/join.ts`, docs/specs/emit-pass.md § The join road

## Context

A `$$$.<coll>` body whose first predicate compares a foreign field with an outer field can lower to the `localField` / `foreignField` pair, or to `let` + `pipeline` + `$expr`.

## Decision

The compiler emits the pair, and the links that follow go into `pipeline` beside it.

- The pair is the join that every MongoDB developer reads and writes. The planner reads it from the foreign index, and from a multikey index when either side is an array.
- The developer wrote one equality, and the pair is the join that reads it. MEASURED on 5000 orders with a multikey index: the pair examines one key per matched row. The `$expr` form scans the collection, and it matches nothing for two arrays, because `$expr: { $eq: [array, array] }` compares whole arrays.
- `.find` is the pair with `pipeline: [{ $limit: 1 }]`. The server takes one matched document per outer document and stops. MEASURED: one key and one document examined per outer document. The pair alone materialises every match first, and 110 matching documents of 1 MB each fail with Location4568.

## Consequences

The server's own rules apply to the pair: a missing field counts as null, and two arrays join when they share one element. That is the boundary that a query document has.
