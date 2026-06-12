# Operator-argument validation (pre-flight)

The value-position counterpart to [pipeline-validation.md](pipeline-validation.md):
where that spec validates **stage bodies** (the elements of a pipeline), this one
validates the **arguments of an operator call** (`$op(...)` / `{ $op: … }`). Both
catch mistakes the MongoDB server always rejects, *before* the query is sent, and
both obey the same hard rule — **only 100%-certain violations throw** — using the
same gate helpers in [`src/literal-gate.ts`](../../src/literal-gate.ts).

Implemented in [`src/operator-validation.ts`](../../src/operator-validation.ts);
`validateOperatorArgs(name, style, args, pos)` is called once from
`generateOperatorCall` ([src/codegen.ts](../../src/codegen.ts)) after the spread
guard, before shape dispatch.

## The literal-gating invariant — and the one difference

Every check inspects **only fully-static literal shapes**; the moment a slot holds
a field reference, an operator call, a template literal, a computed key, or a
spread, the check no-ops and the MQL is emitted unchanged (see the gate helpers,
canonically described in [pipeline-validation.md](pipeline-validation.md#the-literal-gating-invariant)).

**Unlike the stage validator, there is NO constant-only inversion here.** Operator
argument slots legitimately accept runtime expressions (`$dateAdd({ startDate:
$.t, … })`, `$abs($.delta)`), so a non-literal is *never* a certain violation — it
always passes. The stage validator inverts the gate for a few constant-only slots
(`$limit`, `$lookup.pipeline`, …); no operator slot does.

## The `args` dimension (`ArgRules`)

Validation is driven by an optional `args?: ArgRules` field on each `OperatorDef`
([`src/operators.ts`](../../src/operators.ts)), attached with the `withArgs(def,
rules)` wrapper (the sibling of `acc(...)`). Every field is optional; an operator
with no `args` is validated by **shape alone**. The full surface — `arity`,
`singleType` / `elementType` / `positionalTypes`, `required` / `optional` /
`closedKeys`, `enums`, `keyTypes` / `keyIntBounds`, `exactlyOneOf` /
`atLeastOneOf` / `mutuallyExclusive`, `branches` — is declared on the `ArgRules`
type and filled in per operator. Named enum sets (`timeUnit` / `weekday` /
`bsonTypeName` / `regexFlags` / `metaKeyword`) are resolved in
`operator-validation.ts`, so registry rows stay one-liners.

Arity errors route through the shared `checkArity` formatter (exported from
`codegen.ts`) so `$op(...)` arity messages read identically to the `.foo()`
JS-method family. Unknown-key suggestions use `didYouMean` from
[`src/levenshtein.ts`](../../src/levenshtein.ts).

## Checks (by operator shape / rule)

### `none`-shape arity — takes no arguments
Shape-driven (no `args` rule needed). `$rand` / `$createObjectId` / `$count` /
`$rank` / `$denseRank` / `$documentNumber` take zero arguments; codegen used to
silently drop any it was given (emitting a valid-but-unintended `{ $op: {} }`),
hiding the user's misconception that the argument mattered. Now any argument
throws. The window ranking ops (`$rank` / `$denseRank` / `$documentNumber`)
redirect to the `$setWindowFields` sortBy, where their order actually comes from.

```
$rand(1, 2)                          → ✗ "$rand() takes no arguments, got 2"
$setWindowFields({ …, output: { r: $rank($.x) } })
                                     → ✗ "$rank() takes no arguments, got 1. Its value is
                                          computed from the '$setWindowFields' sortBy ordering …"
$rand()                              → { $rand: {} }   (unchanged)
```

### object-shape — required & unknown keys
Applies to `shape === "object"` operators that declare `args` rules (a `flex` /
`single` operator given a lone object treats it as a *value*, so this never
fires for them). The rules table is `OPERATOR_ARG_RULES` in
[`src/operators.ts`](../../src/operators.ts); `required ∪ optional` is the closed
key set.

- **Unknown-key (object form only), checked first** — a key outside the closed
  set throws with a `didYouMean` suggestion. Checking before required means a
  typo of a required key (`iff` for `if`) is reported as the unknown key with the
  suggestion, not as a confusing "requires 'if'".
- **Required-key** — a declared `required` key that is absent throws
  `'$op' requires the 'k' field, but it is missing.`. For the **positional** call
  form the present keys are `shape.keys.slice(0, argCount)` (codegen maps args to
  keys in order), so a too-short positional call is caught too; positional calls
  can't carry unknown keys.
- **Gate** — a spread in the object body suppresses both checks; a computed key
  makes the body un-inspectable and no-ops.

```
$dateAdd({ startDate: $.t, amount: 5 })      → ✗ requires the 'unit' field
$cond({ iff: $.a, then: 1, else: 2 })        → ✗ has no parameter 'iff'. Did you mean 'if'?
$dateAdd({ startDate: $.t, unit: "day", amount: 1 })   → { $dateAdd: { … } }   (valid)
$mergeObjects({ a: 1, bogus: 2 })            → { $mergeObjects: { a: 1, bogus: 2 } }  (flex → value, no key check)
```

### array / flex — fixed & bounded arity
For `array`- and `flex`-shape operators that declare `arity` (in
`OPERATOR_ARG_RULES`), the **effective operand count** is checked: the positional
arg count, OR — for the `$op([a, b, …])` single-array-literal form (HR2) — the
array's element count. Routed through the shared `checkArity` formatter so the
message matches the `.foo()` method family. Degenerate cases defer to codegen: an
array op given a lone non-array scalar keeps its `listOperandError` ("operates on
a list — write `$op(a, b)` or `$op([a, b])`"), and 0 args its "at least 1".

Only **exact** counts (`$divide`/`$cmp`/`$substrCP`/`$arrayElemAt`/…) and
**bounded ranges** (`$indexOf*` 2–4, `$range`/`$slice` 2–3, `$round`/`$trunc`
1–2) are declared, plus `$ifNull`'s verified min-2. Open-ended variadic operators
(`$add`/`$multiply`/`$concat`/`$setUnion`/…) get **no** rule — they accept any
count, so a min-arity check would be a false positive (locked by coverage-proof
tests).

```
$divide(6, 2, 1)   → ✗ "$divide(dividend, divisor) requires exactly 2 arguments, got 3"
$cmp([1, 2, 3])    → ✗ (single-array form counted: 3 ≠ 2)
$divide(10)        → ✗ list-operand error (codegen) — not the arity message
$divide([6, 2])    → { $divide: [6, 2] }   (valid)
$add(1, 2, 3, 4)   → { $add: [1, 2, 3, 4] }  (variadic — unconstrained)
```

_Further checks (flex-comparison arity, enums, literal types) are added per the
rollout; this section grows with them._
