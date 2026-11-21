# 0086. The spellings that stand in for an arrow in an iteratee slot

Status: Accepted
Applies to: `src/registry/vocabulary.ts`

## Context

lodash lets a string, an index, an object or a pair stand in for a callback. JSMQL accepts these spellings, and the desugar pass rewrites them to arrows.

## Decision

- `SlotForm`: `propertyPath` (`$.rows.uniqBy("id")` means `r => r.id`); `propertyIndex` (`keyBy(5)` means `r => r[5]`, a whole number); `matchesObject` (`filter({ active: true })` means `r => r.active === true`); `matchesPropertyPair` (`filter(["a.b", 1])` means `r => r.a.b === 1`); `bareCallable` (`map(String)` means `x => String(x)`); `omitted` (`countBy()`, the identity). The list holds no entry for the arrow, because every iteratee slot takes one.
- `IterateeSlots` is keyed by slot index, because the iteratee is not always first (`$.a.differenceBy($.b, "id")`). The receiver decides the index, so the layout is per family: `$.items.groupBy(fn)` and `Object.groupBy($.items, fn)` are one row.
- `{ arrowOnly: string }`: the receiver accepts ONLY an arrow, and the cell says why. The row states it, because an empty layout and a decision look alike, and a rewrite pass must not guess.
- `{ sortSpec: string }`: the non-arrow spellings are a SORT SPECIFICATION. `$.a.toSorted("k")` means `{ k: 1 }`, `toSorted({ k: -1 })` is descending, and `toSorted()` is the natural order. `src/compiler/emit/sort-spec.ts` reads them, and no pass rewrites them to a callback. This fact differs from `arrowOnly` and from a layout, so it has its own name. `isSlotLayout` tells the one variant from which a rewrite pass can read slots.

## Consequences

A new shorthand goes into `SlotForm` and into the rows that accept it. The desugar pass reads the layout and guesses nothing.
