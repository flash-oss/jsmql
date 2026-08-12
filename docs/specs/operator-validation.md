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

### a pipeline stage name in value position

`rejectStageInValuePosition(name, pos)` runs first, ahead of the unknown-operator
passthrough, because it is the one check that fires for a name the operator registry
does not hold. A **stage** is a statement, so `{ $limit: … }` in an expression slot
has no reading a server accepts — mongod answers `Unrecognized expression '$limit'`.
That universality is what keeps it inside this module's remit (see
[`src/CLAUDE.md`](../../src/CLAUDE.md) § "Never guard raw MQL"): it can never reject a
shape some deployment accepts, the way a cross-database `$lookup` namespace would be.

The test is the registry intersection, so nothing here is a hand-maintained list: a
name throws only when it is in `STAGES` **and** not in `OPERATORS`. Three things
therefore keep working, each for its own reason — `$count` (a stage *and* an
accumulator, so it is in both), an unknown name (HR2 forward-compat, in neither), and
a raw `{ $limit: 5 }` object literal (the developer's own document, not a call jsmql
minted). `EXPRESSION_ANALOGUE` adds the value-position counterpart to the message for
the handful of stages that have one (`$sort` → `$sortArray`, `$match` → `$filter`, …);
most stages reshape a document *stream*, which no expression can do, and for those the
message stops at "write it as a statement" rather than inventing an alternative.

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

### comparison operators — aggregation-only arity
`$eq` / `$ne` / `$gt` / `$gte` / `$lt` / `$lte` are `flex` and dual-purpose: in an
aggregation expression they take **exactly two** operands (`{ $gt: [a, b] }`), but
as a **query predicate** under a field (`{ field: { $gt: v } }`) a single value —
or even an array (`{ field: { $gt: [1, 2, 3] } }`, comparing against the array) —
is valid. So their `exact: 2` arity carries `aggOnly: true` and is enforced
**only** when `ctx.aggExpr` is set.

`aggExpr` is set in aggregation-expression position — `jsmql.expr`, and every
non-`$match` stage body (pipeline.ts) — and is **unset** in query field-value
position (a raw filter / `$match` object). Default-off is the HR3-safe direction:
a missed agg position merely under-validates (the server still rejects the bad
shape), and it never false-positives on valid query code. The accumulator-dual
flex ops (`$max`/`$min`/`$sum`/`$avg`/`$stdDev*`) get **no** arity rule — their
single-argument form is the legitimate accumulator form.

```
$project({ r: $gt($.a) })   → ✗ "$gt(expr1, expr2) requires exactly 2 arguments, got 1"  (agg)
jsmql.expr("$gt($.a, $.b, $.c)")  → ✗ requires exactly 2, got 3                           (agg)
{ age: $gt($.x) }           → { age: { $gt: "$x" } }   (query predicate — valid)
$max($.scores)              → { $max: "$scores" }      (accumulator dual — valid)
```

### object-shape — enum slots
An operator's `enums` rule (`{ key: EnumRef }`) checks a literal-string slot
value against a closed set; a non-literal value no-ops (gate). Runs in both call
forms. The named sets (in operator-validation.ts):

| EnumRef | Set | Matching |
|---|---|---|
| `timeUnit` | year…millisecond | case-sensitive lowercase (mongod rejects `Day`) |
| `weekday` | monday…sunday | **case-insensitive** (mongod accepts `Monday`) |
| `bsonTypeName` | the full `$type`/`$convert` alias set | case-sensitive; a numeric type code is a non-string → skipped |
| `regexFlags` | charset `i`,`m`,`x`,`s` | per-character (a JS `g`/`y` flag throws) |
| inline `string[]` | e.g. `["approximate"]`, `["js"]` | case-sensitive |

Wired on: `$dateAdd`/`$dateSubtract`/`$dateDiff`/`$dateTrunc` `unit`; `$dateDiff`/
`$dateTrunc` `startOfWeek`; `$convert` `to`; `$regex*` `options`; `$median`/
`$percentile` `method`; `$function`/`$accumulator` `lang`. All verified on `mongod`.
(`$meta`'s keyword set is single-shape + version-dependent — deferred.)

```
$dateAdd({ …, unit: "fortnight" })   → ✗ "unit must be one of: year, …, millisecond — got 'fortnight'"
$dateTrunc({ …, startOfWeek: "Monday" })  → valid (weekday case-insensitive)
$convert({ input: $.s, to: "intt" })  → ✗ "Did you mean 'int'?"   ($convert to: 16 → valid, numeric)
$regexMatch({ …, options: "gi" })    → ✗ "invalid regex flag 'g'"
```

### literal-type slots (`singleType` / `elementType` / `positionalTypes` / `keyTypes`)
A literal of a type the slot can never accept (no MongoDB coercion) throws.
`ArgType` is one of `number` / `integer` / `int-or-long` / `string` / `bool` /
`object` / `array` / `date` / `timestamp` / `number-or-date`. The gate is strict:
only a **certain-wrong literal** throws —

- A **`$`-prefixed string** (`"$createdAt"`) is a field reference (HR1), not a
  string value, so it no-ops (it may resolve to any type) — `$year("$createdAt")`
  is valid.
- **`new Date(…)`** lowers to `{ $toDate: … }` (an op call, non-literal) → no-op,
  so it's valid in a `date` slot. `null` is accepted by MongoDB (yields null) → no-op.
- `date` / `timestamp` have **no literal form**, so *any* literal in such a slot is
  wrong (this is the DEF-029 date check); `number`/`int-or-long` reject a literal
  string/bool/array/object (and `int-or-long` a non-integer number).
- **string slots are NOT type-checked** — MongoDB coerces inconsistently
  (`$toUpper(5)` is accepted but `$strLenBytes(5)` is rejected), so a `string`
  rule would risk false positives; it's used only on slots verified to reject a
  non-string (e.g. date-operator `timezone`).

Wired (all verified on `mongod`): date accessors (`$year`/`$month`/…) `singleType:
"date"`; date operators' `keyTypes` (`startDate`/`date`/`endDate` → date, `amount`
and every `$dateFromParts` part → int-or-long, `timezone` → string, `binSize` →
number); numeric ops `number`;
bitwise `int-or-long`; `$mergeObjects`/`$objectToArray` `object`; `$size`/
`$reverseArray` `array`; `$tsSecond`/`$tsIncrement` `timestamp`.

```
$year("2020-01-01")     → ✗ "expects a date, but got a string. Use a field path or new Date(…)."
$dateAdd({ …, amount: "3" })  → ✗ "amount expects an integer, but got a string"
$dateFromParts({ year: 2030.5 }) → ✗ "year expects an integer, but got a number"
$abs("x")               → ✗ "expects a number, but got a string"
$year("$createdAt")     → { $year: "$createdAt" }    ($-string = field ref → valid)
$year(new Date("…"))    → { $year: { $toDate: "…" } }  (non-literal → valid)
```

Operators whose rules can't be exercised on a local mongod (Queryable-Encryption
`$encStr*`, server-8.1+ `$hash`/`$hexHash`) and the version-dependent single-shape
`$meta` keyword set are not type/enum-checked (HR3: jsmql throws only what it can
confirm).
