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

_Further checks (object-form required/unknown keys, array arity, enums, literal
types) are added per the rollout in [the plan]; this section grows with them._
