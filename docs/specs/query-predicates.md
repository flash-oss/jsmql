# Query Predicates

**Status:** not yet implemented.

This spec is a placeholder for future work. It will describe how mjsql will compile JS-syntax expressions to MongoDB query predicates — the operators used inside `$match` filters and `find()` queries (e.g. `$eq`, `$elemMatch`, `$exists`, `$type`, `$expr`, geospatial operators).

## Sources

- **MongoDB docs:** https://www.mongodb.com/docs/manual/reference/mql/query-predicates/
- **Spec YAML:** `vendor/mql-specifications/definitions/query/`

## Scope

Examples from the official spec (not exhaustive):

`$all`, `$and`, `$bitsAllClear`, `$bitsAllSet`, `$bitsAnyClear`, `$bitsAnySet`, `$comment`, `$elemMatch`, `$eq`, `$exists`, `$expr`, `$geoIntersects`, `$geoWithin`, `$gt`, `$gte`, `$in`, `$jsonSchema`, `$lt`, `$lte`, `$mod`, `$ne`, `$near`, `$nearSphere`, `$nin`, `$nor`, `$not`, `$or`, `$regex`, `$sampleRate`, `$size`, `$text`, `$type`, `$where`.

Some of these collide by name with expression operators (`$eq`, `$gt`, etc.) but have a different MQL shape in query-predicate context. `$sampleRate` is a particularly subtle case — it is registered today as a `miscellaneous` expression operator (single-shape, callable as `$sampleRate(0.1)`), and will *also* surface as a query predicate inside `$match` once that context lands. The disambiguation rule is part of this spec's design work.

## Open design questions

- How to differentiate query-predicate context from expression context in mjsql syntax. (Likely: a top-level `mql.match\`...\`` template tag or an explicit pipeline stage helper.)
- Whether to extend the existing operator registry with a `query-predicate` shape variant or have a separate `QUERY_PREDICATES` registry.
- How to surface JS-friendly aliases (e.g. `$.field instanceof RegExp` → `$regex`).

## Pre-1.0 note

No timeline. Tracked here so the structure exists when implementation starts.
