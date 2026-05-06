# Accumulators (as stage-spec position)

**Status:** the accumulators themselves are already in the operator registry (as expression operators usable inside `$setWindowFields` and `$group` stages). This spec is a placeholder for future work on the **stage-spec** integration — how mjsql will compile entire `$group` / `$bucket` / `$setWindowFields` blocks where accumulators sit at field-binding positions.

## Sources

- **MongoDB docs:** https://www.mongodb.com/docs/manual/reference/mql/accumulators/
- **Spec YAML:** `vendor/mql-specifications/definitions/accumulator/`

## Scope

The accumulators in the spec — already covered by the expression registry: `$accumulator`, `$addToSet`, `$avg`, `$bottom`, `$bottomN`, `$concatArrays`, `$count`, `$covariancePop`, `$covarianceSamp`, `$denseRank`, `$derivative`, `$documentNumber`, `$expMovingAvg`, `$first`, `$firstN`, `$integral`, `$last`, `$lastN`, `$linearFill`, `$locf`, `$max`, `$maxN`, `$median`, `$mergeObjects`, `$min`, `$minN`, `$percentile`, `$push`, `$rank`, `$setUnion`, `$shift`, `$stdDevPop`, `$stdDevSamp`, `$sum`, `$top`, `$topN`.

The remaining work: a syntax for the *containing stage* — for example, allowing a JS expression to evaluate to a full `$group` stage with accumulator field bindings.

## Open design questions

- Whether the stage-spec syntax should be JS object-literal-with-mjsql-values (today's behaviour for stage objects, just used directly), or a higher-level builder (`$.group({ _id: ..., total: $sum($.amount) })`).
- How to keep the accumulator-only operators (window functions like `$rank`) from being misused inside expression positions where MongoDB would error at runtime.

## Pre-1.0 note

No timeline. The accumulators are functional via the escape hatch today; this spec is for the higher-level ergonomics layer.
