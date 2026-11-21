# 0076. Positions of the root and scope rows, and constant globals

Status: Accepted
Applies to: `src/registry/names.ts`

## Context

The roots `$`, `$$`, `$$$.<coll>` and `$$$$.<db>.<coll>` must list only the positions where they have a real form. A wrong `where` claims a form that does not exist.

## Decision

- `$`: MEASURED both ways. As a value, `$` gives `"$$ROOT"`. As a filter, `$` gives an `$expr` truthiness test, so there is NO native query form. `$ === 1` gives `{ "": 1 }`, which mongod accepts and which matches nothing. So the row states `where: ["value"]` and a `viaFallback` filter. This agrees with `rootReference` in `productions.ts`.
- `$$$.<coll>`: MEASURED, `$$ = $$$.c.filter(…)` switches the source (stream). `$.o = $$$.c.find(…);` gives `$lookup`, and `$$$.c = $$;` gives `$out` (statement).
- `$$$$.<db>.<coll>`: MEASURED, `$$$$.db2.c = $$;` gives `[{ $out: { db: "db2", coll: "c" } }]`, a statement. There is no stream form, because the server refuses a cross-database READ outright.
- `ObjectId("<24 hex>")`: a constant is the live ObjectId. The value goes into the MQL as itself, so the constant engine reads it and a query compares it as written.
- `new Set(…)` in the update document: the general sentence names the pipeline form, which also refuses `Set`. A constant array folds in an update document: `$.x = [1, 2, 2].uniq()` gives `{ $set: { x: [1, 2] } }`.

## Consequences

A new root or scope row must measure each position before it lists it in `where`.
