# Aggregation Pipeline Stages

**Status:** not yet implemented.

This spec is a placeholder for future work. It will describe how mjsql will compile to full aggregation pipeline stages — the top-level objects that appear as elements of an aggregation pipeline array (`$match`, `$project`, `$lookup`, `$group`, `$unionWith`, …).

Today, mjsql compiles individual *expressions* — the values that sit inside stage spec objects. Stages themselves are constructed by users in plain JS object literals. The eventual goal is a higher-level surface that lets users author entire pipelines in mjsql syntax.

## Sources

- **MongoDB docs:** https://www.mongodb.com/docs/manual/reference/mql/aggregation-stages/
- **Spec YAML:** `vendor/mql-specifications/definitions/stage/`

## Scope

The spec lists ~45 stages:

`$addFields`, `$bucket`, `$bucketAuto`, `$changeStream`, `$changeStreamSplitLargeEvent`, `$collStats`, `$count`, `$currentOp`, `$densify`, `$documents`, `$facet`, `$fill`, `$geoNear`, `$graphLookup`, `$group`, `$indexStats`, `$limit`, `$listLocalSessions`, `$listSampledQueries`, `$listSearchIndexes`, `$listSessions`, `$lookup`, `$match`, `$merge`, `$out`, `$planCacheStats`, `$project`, `$rankFusion`, `$redact`, `$replaceRoot`, `$replaceWith`, `$sample`, `$scoreFusion`, `$search`, `$searchMeta`, `$set`, `$setWindowFields`, `$shardedDataDistribution`, `$skip`, `$sort`, `$sortByCount`, `$unionWith`, `$unset`, `$unwind`, `$vectorSearch`.

## Open design questions

- A pipeline DSL (e.g. `mql.pipeline(stage1, stage2, ...)` or template-tagged builder).
- How `$lookup`'s `pipeline` sub-pipeline is expressed.
- Whether `$setWindowFields` becomes a first-class construct that statically validates window-only operator usage.
- How `$search` (Atlas Search, see also `vendor/mql-specifications/definitions/search/`) integrates — separate spec eventually.

## Pre-1.0 note

No timeline. Tracked here so the structure exists when implementation starts. The `search/` and `types/` directories in the spec repo cover Atlas Search operators and BSON type definitions respectively; both are out of scope here and would get their own specs if/when they are tackled.
