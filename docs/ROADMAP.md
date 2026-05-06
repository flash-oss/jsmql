# Roadmap

Future / in-progress work for `mjsql`. Items are listed in rough priority order, not by date. Once an item ships, move it to the **Shipped** section at the bottom or remove it.

For the user-facing language reference, see [`LANGUAGE.md`](LANGUAGE.md). For implementation specs, see [`specs/`](specs/).

---

## In progress

_(empty — add items here as they are scoped)_

---

## Shipped

Items below are shipped on the current `main` branch (or staged in a worktree merged into it). For the per-release view of public-API changes, see [`CHANGELOG.md`](../CHANGELOG.md).

### `flex` operator shape

Added a `flex` variant to `OperatorShape` in [`src/operators.ts`](../src/operators.ts) for MongoDB operators that genuinely accept either a single expression or an array of expressions.

Covers `$round`, `$trunc`, `$min`, `$max`, `$avg`, `$sum`, `$stdDevPop`, `$stdDevSamp`, `$mergeObjects`:

- 1 arg → single form: `{ $op: <expr> }`
- 2+ args → array form: `{ $op: [a, b, ...] }`
- `...arr` (single spread) → single form, passing the array through
- mixed spread + scalars → joined via `$concatArrays`, same as existing variadic handling

`$first` / `$last` were considered but skipped — both contexts already take a single argument, so they are correctly modelled by `single`.

### Modern JavaScript syntax

- Template literals with `${expr}` interpolation, nesting, and escape sequences. Non-string interpolations are wrapped with `$toString` to match JS coercion.
- Optional chaining: `?.`, `?.[index]`, `?.()` after method calls.
- Numeric separators: `1_000_000`, `1_2e3`. Leading / trailing / doubled `_` rejected at lex time.
- Computed object keys (`{ [$.k]: 1 }`) — compiled via `$arrayToObject`, mixable with literal keys.
- Shorthand object properties (`{ x }` → `{ x: x }`) inside lambda scope.
- Spread in call arguments: `Math.max(...$.scores)`, `Object.assign(...$.docs)`, `$concatArrays(...$.arrs)`. Mixed spread+scalar args wrap into `$concatArrays`.

### Built-in methods and statics

- **String methods:** `.startsWith`, `.endsWith`, `.charAt`.
- **Array methods:** `.includes`, `.indexOf`, `.concat`, `.join`, `.flat` / `.flat(1)`, `.flatMap`.
- **Date methods/statics:** `.getTime`, `.toISOString`, `Date.now`.
- **Math methods:** `Math.min`, `Math.max`, `Math.sign`, `Math.log2`, `Math.log10`, `Math.cbrt`, `Math.hypot`, `Math.random`.
- **Math constants:** `Math.PI`, `Math.E`.
- **Statics:** `Array.isArray`, `Object.fromEntries`.

### Type-aware dispatch

- `.includes()`, `.indexOf()`, `.concat()` now route by receiver type:
  - Known array → array form (`$in`, `$indexOfArray`, `$concatArrays`).
  - Known string → string form (`$indexOfCP`, etc.).
  - Unknown receiver → runtime `$cond` on `$isArray` that picks the right form at query time.
- Bracket access (`obj[k]`, `obj?.[k]`) is type-aware. Known array → `$arrayElemAt`; unknown receiver → runtime `$cond` between `$arrayElemAt` and `$getField`, so `$.config["host"]` works whether `$.config` is a string-keyed object or an array.
- `.length` recognises `Object.keys()` / `Object.values()` outputs as arrays.
- Object-style operator calls now route by the operator's registered shape: only `object`-shape operators (e.g. `$trim`, `$dateAdd`) require literal key names. For any other operator, a single `{...}` argument is treated as a value and may use computed keys, spread, etc.
