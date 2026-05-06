# Update Operators

**Status:** not yet implemented.

This spec is a placeholder for future work. It will describe how mjsql will compile JS-syntax expressions to MongoDB update operators — the constructs used inside `updateOne()` / `updateMany()` / `findAndModify()` to mutate documents.

## Sources

- **MongoDB docs:** https://www.mongodb.com/docs/manual/reference/mql/update/
- **Spec YAML:** `vendor/mql-specifications/definitions/update/`

## Scope

The full set from the spec:

- **Field operators:** `$set`, `$unset`, `$inc`, `$mul`, `$min`, `$max`, `$rename`, `$setOnInsert`, `$currentDate`
- **Array operators:** `$push`, `$pull`, `$pullAll`, `$addToSet`, `$pop` (plus the `$each`, `$slice`, `$sort`, `$position` modifiers and the `$` / `$[]` / `$[<identifier>]` array-position operators)
- **Bitwise operator:** `$bit`

These overlap by name with several expression and accumulator operators (`$set`, `$min`, `$max`, `$push`, `$addToSet`) but have completely different shapes in update context.

## Open design questions

- A separate API surface (e.g. `mql.update\`...\``) or a builder.
- How to express positional operators (`$`, `$[]`, `$[<id>]`) in JS-friendly syntax.
- Whether to support pipeline-style updates (a separate, recently-added MongoDB feature) and how to disambiguate from operator-style updates.

## Pre-1.0 note

No timeline. Tracked here so the structure exists when implementation starts.
