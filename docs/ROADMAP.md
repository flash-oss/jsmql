# Roadmap

Future / in-progress work for `mjsql`. Items are listed in rough priority order, not by date. Once an item ships, move it to the **Shipped** section at the bottom or remove it.

For the user-facing language reference, see [`LANGUAGE.md`](LANGUAGE.md). For implementation specs, see [`specs/`](specs/).

---

## In progress

### `flex` operator shape

Add a `flex` variant to `OperatorShape` in [`src/operators.ts`](../src/operators.ts) for MongoDB operators that genuinely accept either a single expression or an array of expressions.

**Why.** Several MQL operators have two valid shapes depending on the stage they are used in:

| Operator | Single form (accumulator-style) | Array form (expression-style) |
|---|---|---|
| `$min`, `$max`, `$avg`, `$sum`, `$stdDevPop`, `$stdDevSamp` | `{ $min: "$field" }` | `{ $min: ["$a", "$b", "$c"] }` |
| `$round`, `$trunc` | `{ $round: "$value" }` (place defaults to 0) | `{ $round: ["$value", 2] }` |
| `$mergeObjects` | `{ $mergeObjects: "$doc" }` | `{ $mergeObjects: ["$a", "$b"] }` |

Today every operator is registered as a single fixed shape, so one of the two valid forms is rejected. The `flex` shape lets a single registry entry cover both:

- 1 arg → single form: `{ $op: <expr> }`
- 2+ args → array form: `{ $op: [a, b, ...] }`
- `...arr` (single spread) → single form, passing the array through
- mixed spread + scalars → joined via `$concatArrays`, same as existing variadic handling

**Scope.** ~9 operators total: `$round`, `$trunc`, `$min`, `$max`, `$avg`, `$sum`, `$stdDevPop`, `$stdDevSamp`, `$mergeObjects`.

`$first` / `$last` were considered but skipped — both contexts already take a single argument, so they are correctly modelled by `single`.

**Status.** Implemented in this worktree.

---

## Shipped

_(empty — populate as items land in `main`)_
