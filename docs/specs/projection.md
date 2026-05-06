# Projection Operators

**Status:** not yet implemented.

This spec is a placeholder for future work. It will describe how mjsql will compile JS-syntax expressions to MongoDB projection operators — the constructs used to shape the output of `find()` queries (and the leaf positions of `$project` stages outside the aggregation framework).

## Sources

- **MongoDB docs:** https://www.mongodb.com/docs/manual/reference/mql/projection/
- **Spec YAML:** projection operators are not in their own folder in the official spec; relevant entries are scattered between `vendor/mql-specifications/definitions/query/` (e.g. `$elemMatch` projection variant) and the pipeline operators in `vendor/mql-specifications/definitions/pipeline/` and `vendor/mql-specifications/definitions/stage/project.yaml`.

## Scope

The four canonical projection operators:

- `$` — positional, returns the first matching array element
- `$elemMatch` (projection variant) — returns the first array element matching a condition
- `$slice` — returns a subarray
- `$meta` — returns aggregation metadata (already in expression registry as `$meta`)

Plus the truthy/falsy-flag inclusion/exclusion syntax (`{ field: 1 }` / `{ field: 0 }`).

## Open design questions

- Whether projections deserve their own template tag (e.g. `projection\`...\``) or get folded into a query-builder API.
- How to express the positional operator `$` in JS syntax.

## Pre-1.0 note

No timeline. Tracked here so the structure exists when implementation starts.
