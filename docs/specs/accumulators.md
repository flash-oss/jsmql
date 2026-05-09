# Accumulators (as stage-spec position)

**Status:** the accumulators themselves are already in the operator registry (as expression operators usable inside `$setWindowFields` and `$group` stages). This spec is a placeholder for future work on the **stage-spec** integration — how mjsql will compile entire `$group` / `$bucket` / `$setWindowFields` blocks where accumulators sit at field-binding positions.

## Sources

- **MongoDB docs:** https://www.mongodb.com/docs/manual/reference/mql/accumulators/
- **Spec YAML:** `vendor/mql-specifications/definitions/accumulator/`

## Scope

Every operator listed in `vendor/mql-specifications/definitions/accumulator/` is already in the expression registry as a regular operator entry — see [`src/operators.ts`](../../src/operators.ts), and the drift-protection test (`test/operator-spec-coverage.test.ts`) keeps that set in sync with the spec on every `npm test`. The window-only operators (category `window` in the registry) are also reachable as accumulator-valued bindings inside `$setWindowFields`.

The remaining work: a syntax for the *containing stage* — for example, allowing a JS expression to evaluate to a full `$group` stage with accumulator field bindings.

## Open design questions

- Whether the stage-spec syntax should be JS object-literal-with-mjsql-values (today's behaviour for stage objects, just used directly), or a higher-level builder (`$.group({ _id: ..., total: $sum($.amount) })`).
- How to keep the accumulator-only operators (window functions like `$rank`) from being misused inside expression positions where MongoDB would error at runtime.

## Pre-1.0 note

No timeline. The accumulators are functional via the escape hatch today; this spec is for the higher-level ergonomics layer.
