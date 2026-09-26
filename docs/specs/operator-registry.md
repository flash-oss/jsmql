# Operator Registry

One file carries what JSMQL knows about MongoDB's expression, accumulator, and query operators.

- [`src/registry/names.ts`](../../src/registry/names.ts) — **this row states how an operator lowers, and what it is.** Every `$op` is a `$op: mongo({ … })` row. The row states where the operator may stand (`where`), and one cell per position (`expr`, `filter`, `group`, `window`, `stream`, `statement`, `updateDoc`, `body`). It states the argument rule (`args`: a signature and the counts it takes, or `byArgs` for a call whose shape follows its arguments), and the keys of an object-form operator. It states `returns` — the kind of its result, measured on a running `mongod`. A cell either states a lowering or refuses the call and names the alternative. The row also states what the operator IS: its `category` (from `OPERATOR_CATEGORIES` in [`src/registry/vocabulary.ts`](../../src/registry/vocabulary.ts)) and the one-sentence `doc` lifted from the vendored spec. The globals generator and the playground sync read these two facts, through the accessors in [`src/compiler/rows.ts`](../../src/compiler/rows.ts). The compiler reads nothing else to lower a call. [emit-pass.md](emit-pass.md) is the spec of that reading.

A test checks that the rows and the vendored spec agree: `test/registry-agrees.test.ts` checks the cross-references inside the registry, and `test/operator-spec-coverage.test.ts` checks the rows against `mongodb/mql-specifications`.

## Call shapes

A row's `args` states what the call takes. The shapes below are what the rows say, with an example for each. Every refusal names the way out.

**A list operator** (`$add`, `$setUnion`, `$concat`, …) takes its operands one by one, or ONE array literal that IS the operand list (HR2's round-trip of `{ $op: [ … ] }`). One operand that is not an array literal is ONE operand, as the server reads it. The row's count decides if one is enough: `$add` and `$setUnion` state `atLeast: 1`, and `$divide` states `exact: 2`. MEASURED on every list-only row, and `test/compiler-returns-agrees.test.ts` asks the server again for each row. The raw document and the call take one lowering, so they agree:

```
$add($.a, $.b, $.c)     →  { $add: ["$a", "$b", "$c"] }
$setUnion([$.a, $.b])   →  { $setUnion: ["$a", "$b"] }
$add($.x)               →  { $add: "$x" }
({ $setUnion: $.x })    →  { $setUnion: "$x" }          raw MQL passes unchanged (HR1)
$divide(10)             →  ✗ "'$divide(dividend, divisor)' requires exactly 2 arguments, got 1"
({ $divide: 10 })       →  ✗ the same sentence: HR3 governs raw MQL too
```

A query document follows the query language: `$and`, `$or` and `$mod` take a list there. So `{ $and: true }` in a filter is refused. MEASURED: "$and argument must be an array".

**A comparison operator** takes exactly two operands in an expression and has a query form in a filter:

```
$gt($.a, $.b)           →  { $gt: ["$a", "$b"] }              (expression)
$gt($.a, 1)             →  { a: { $gt: 1 } }                  (filter: MongoDB's reading, no array exclusion)
$gt($.x)                →  ✗ "'$gt(expr1, expr2)' requires exactly 2 arguments, got 1"
```

**An object-form operator** (`$trim`, `$dateAdd`, `$regexMatch`, …) takes its keys positionally, or as one object literal. The compiler checks an object literal's keys against the row. It refuses a wrong key and names the nearest right one:

```
$trim($.name, " ")                     →  { $trim: { input: "$name", chars: " " } }
$trim({ input: $.name, chars: " " })   →  { $trim: { input: "$name", chars: " " } }
$dateAdd({ startdate: $.t, unit: "day", amount: 1 })
  →  ✗ "'$dateAdd' has no parameter 'startdate'. Did you mean 'startDate'? Valid keys: startDate, unit, amount, timezone."
```

On an operator that is NOT object-form, a lone object literal is a value (`$mergeObjects({ a: 1 })` → `{ $mergeObjects: { a: 1 } }`). A no-argument operator emits `{ $op: {} }` (`$rand()` → `{ $rand: {} }`). For an operator with both a single and a list form (`$min`, `$round`, …), the argument count decides which form applies. Every `$op(…)` call refuses a JavaScript spread. The refusal names the JS form that takes it (`Math.min(...xs)`), or the single-array form.

## `$literal`

`$literal(x)` emits `{ $literal: <x> }`. The compiler lowers `x` under the Env's `$literal` envelope, where nothing is an operator or a field reference. A `"$…"` string typed in source is otherwise MongoDB's own field path, and it passes through (HR1). The compiler adds one `$literal` on its own: the gate for a value that arrives at run time. See [aggregation-stages.md § `$`-string pass-through](aggregation-stages.md).

## Unknown operators

A `$name` with no row passes through by its argument count. So JSMQL runs a MongoDB operator it has no row for yet:

| Args | Output |
|---|---|
| zero | `{ $op: {} }` |
| one non-object | `{ $op: expr }` |
| one object literal | `{ $op: { key: val, … } }` |
| two or more | `{ $op: [a, b, …] }` |

## Query-position-only operators

`$sampleRate` has no expression form on the server. Its row lists `filter` alone: `$match($sampleRate(0.1))` → `[{ $match: { $sampleRate: 0.1 } }]`. It composes with other clauses (`$.age > 18 && $sampleRate(0.1)`). An expression position refuses it — "$sampleRate is a query operator — it only works as a '$match' condition … Write it as a predicate: '$match($sampleRate(<value>))'". The catalog carries the same fact as `matchOnly: true`, for the generated types.

## Return kinds

A row's `returns` states the kind of the operator's result — `string`, `number`, `bool`, `array`, `object`, `date` — or `"unknown"` where the kind follows the operands. For example, `$add` gives a number or a date, and `$first` gives whatever the array holds. The chain type-check reads this fact. It refuses `$.s.trim().foo()` when `foo` is not a string method, and it lowers an `.indexOf()` on an unknown kind as the dual-receiver `$switch`. The compiler measures `returns` on a running `mongod` (`{ $type: { <op>: <args> } }`). It never reads the vendored YAML's `type:` field, which is wrong for `$trunc`.

## Adding an operator

The recipe lives in [CLAUDE.md § Adding a new MongoDB operator](../../CLAUDE.md): a row in `names.ts`, a test on `mongod`, the reference.

## Spec drift protection

`test/operator-spec-coverage.test.ts` runs on every `npm test`. It asserts that the rows stay in sync with `mongodb/mql-specifications`:

- Every operator in `definitions/expression/`, `definitions/accumulator/`, and `definitions/query/` has a row. A name that JSMQL does not support still needs a row — an empty `where` and a refusal that names the alternative is a row.
- Every operator row is a name the spec defines, except the names documented in `REGISTRY_ONLY` (for example, the update-document operators, which the pinned spec commit has no folder for).
- Every stage row is a name `definitions/stage/` defines, and every one of those has a stage row.
- Every callable operator states a non-empty description and a known `category`.

When the test fails, the message names the specific operator and the specific drift. Fix it before you merge.

## Generated user-facing types (`src/globals.ts`)

The operator rows, the stage rows, the rows' method facts, and the vendored spec are the input to the build-time generator. This generator emits the ambient-globals module shipped at `@koresar/jsmql/globals`. See [globals-generation.md](globals-generation.md).
