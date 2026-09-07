# Operator Registry

One file carries what jsmql knows about MongoDB's expression, accumulator and query operators.

- [`src/registry/names.ts`](../../src/registry/names.ts) — **how an operator lowers, and what it is.** Every `$op` is a `$op: mongo({ … })` row: where it may stand (`where`), one cell per position (`expr`, `filter`, `group`, `window`, `stream`, `statement`, `updateDoc`, `body`), its argument rule (`args`: a signature and the counts it takes, or `byArgs` for a call whose shape follows its arguments), the keys of an object-form operator, and `returns` — the kind of its result, measured on a running `mongod`. A cell either states a lowering or refuses with the alternative. The row also states what the operator IS — its `category` (from `OPERATOR_CATEGORIES` in [`src/registry/vocabulary.ts`](../../src/registry/vocabulary.ts)) and the one-sentence `doc` lifted from the vendored spec — which is what the globals generator and the playground sync read, through the accessors in [`src/compiler/rows.ts`](../../src/compiler/rows.ts). The compiler reads nothing else to lower a call; [emit-pass.md](emit-pass.md) is the spec of that reading.

The rows and the vendored spec agree by test: `test/registry-agrees.test.ts` checks the cross-references inside the registry, and `test/operator-spec-coverage.test.ts` checks the rows against `mongodb/mql-specifications`.

## Call shapes

A row's `args` states what the call takes; the shapes below are what the rows say, illustrated. Every refusal names the way out.

**A list operator** (`$add`, `$setUnion`, `$concat`, …) takes two or more operands, or ONE array literal that IS the operand list (HR2's round-trip of `{ $op: [ … ] }`). A lone scalar is refused:

```
$add($.a, $.b, $.c)     →  { $add: ["$a", "$b", "$c"] }
$setUnion([$.a, $.b])   →  { $setUnion: ["$a", "$b"] }
$add($.x)               →  ✗ "$add operates on a list of operands — pass two or more ($add(a, b)) or a single array ($add([a, b]))."
({ $setUnion: $.x })    →  ✗ the same sentence: HR3 governs raw MQL too
```

**A comparison operator** takes exactly two operands in an expression and has a query form in a filter:

```
$gt($.a, $.b)           →  { $gt: ["$a", "$b"] }              (expression)
$gt($.a, 1)             →  { a: { $gt: 1 } }                  (filter: MongoDB's reading, no array exclusion)
$gt($.x)                →  ✗ "'$gt(expr1, expr2)' requires exactly 2 arguments, got 1"
```

**An object-form operator** (`$trim`, `$dateAdd`, `$regexMatch`, …) takes its keys positionally or as one object literal; an object literal's keys are checked against the row, and a wrong one is refused with the nearest right one:

```
$trim($.name, " ")                     →  { $trim: { input: "$name", chars: " " } }
$trim({ input: $.name, chars: " " })   →  { $trim: { input: "$name", chars: " " } }
$dateAdd({ startdate: $.t, unit: "day", amount: 1 })
  →  ✗ "'$dateAdd' has no parameter 'startdate'. Did you mean 'startDate'? Valid keys: startDate, unit, amount, timezone."
```

A lone object literal on an operator that is NOT object-form is a value (`$mergeObjects({ a: 1 })` → `{ $mergeObjects: { a: 1 } }`). A no-argument operator emits `{ $op: {} }` (`$rand()` → `{ $rand: {} }`). An operator with both a single and a list form (`$min`, `$round`, …) is decided by its argument count. The JavaScript spread is refused in every `$op(…)` call; the refusal names the JS form that takes it (`Math.min(...xs)`) or the single-array form.

## `$literal`

`$literal(x)` emits `{ $literal: <x> }` with `x` lowered under the Env's `$literal` envelope, where nothing is an operator or a field reference. A `"$…"` string typed in source is otherwise MongoDB's own field path and passes through (HR1); the one `$literal` the compiler adds on its own is the gate for a value that arrives at run time — see [aggregation-stages.md § `$`-string pass-through](aggregation-stages.md).

## Unknown operators

A `$name` with no row passes through by its argument count, so jsmql runs a MongoDB operator it has no row for yet:

| Args | Output |
|---|---|
| zero | `{ $op: {} }` |
| one non-object | `{ $op: expr }` |
| one object literal | `{ $op: { key: val, … } }` |
| two or more | `{ $op: [a, b, …] }` |

## Query-position-only operators

`$sampleRate` has no expression form on the server. Its row lists `filter` alone: `$match($sampleRate(0.1))` → `[{ $match: { $sampleRate: 0.1 } }]`, and it composes with other clauses (`$.age > 18 && $sampleRate(0.1)`), while an expression position refuses it — "$sampleRate is a query operator — it only works as a '$match' condition … Write it as a predicate: '$match($sampleRate(<value>))'". The catalog carries the same fact as `matchOnly: true`, for the generated types.

## Return kinds

A row's `returns` states the kind of the operator's result — `string`, `number`, `bool`, `array`, `object`, `date` — or `"unknown"` where the kind follows the operands (`$add` is a number or a date; `$first` is whatever the array holds). The chain type-check reads it: `$.s.trim().foo()` is refused when `foo` is not a string method, and a `.length` on an unknown kind is the dual-receiver `$switch`. It is measured on a running `mongod` (`{ $type: { <op>: <args> } }`), never read from the vendored YAML's `type:` field, which is wrong for `$trunc`.

## Adding an operator

The recipe lives in [CLAUDE.md § Adding a new MongoDB operator](../../CLAUDE.md): a row in `names.ts`, a test on `mongod`, the reference.

## Spec drift protection

`test/operator-spec-coverage.test.ts` runs on every `npm test` and asserts that the rows stay in sync with `mongodb/mql-specifications`:

- Every operator in `definitions/expression/`, `definitions/accumulator/` and `definitions/query/` has a row. A name jsmql does not support still needs one — an empty `where` and a refusal that names the alternative is a row.
- Every operator row is a name the spec defines, except those documented in `REGISTRY_ONLY` (e.g. the update-document operators, which the pinned spec commit has no folder for).
- Every stage row is a name `definitions/stage/` defines, and every one of those has a stage row.
- Every callable operator states a non-empty description and a known `category`.

When the test fails, the message names the specific operator and the specific drift; act on it before merging.

## Generated user-facing types (`src/globals.ts`)

The operator rows, the stage rows, the rows' method facts and the vendored spec are the input to the build-time generator that emits the ambient-globals module shipped at `@koresar/jsmql/globals`. See [globals-generation.md](globals-generation.md).
