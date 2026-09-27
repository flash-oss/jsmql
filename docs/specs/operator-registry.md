# Operator Registry

One file carries what JSMQL knows about MongoDB's expression, accumulator, and query operators.

- [`src/registry/names.ts`](../../src/registry/names.ts) — **this row states how an operator lowers, and what it is.** Every `$op` is a `$op: mongo({ … })` row. The row states where the operator may stand (`where`), and one rule cell per position that `where` lists (`expr`, `filter`, `group`, `window`, `stream`, `statement`, `updateDoc`). A position that `where` omits states no cell, except the filter's `viaFallback`. It states the argument rule (`args`: a signature and the counts it takes, or `byArgs` for a call whose shape follows its arguments), and the keys of an object-form operator, in the order that its positional form fills them (`keys`). It states `returns` — the kind of its result, measured on a running `mongod`. A cell states a lowering. Where a cell states none for a `$op(…)` call, the call takes HR2's plain form. The row also states what the operator IS: its `category` (from `OPERATOR_CATEGORIES` in [`src/registry/vocabulary.ts`](../../src/registry/vocabulary.ts)) and the one-sentence `doc` lifted from the vendored spec. The globals generator and the playground sync read these two facts, through the accessors in [`src/compiler/rows.ts`](../../src/compiler/rows.ts). The compiler reads nothing else to lower a call. [emit-pass.md](emit-pass.md) is the spec of that reading.

A test checks that the rows and the vendored spec agree: `test/registry-agrees.test.ts` checks the cross-references inside the registry, and `test/operator-spec-coverage.test.ts` checks the rows against `mongodb/mql-specifications`.

## Call shapes

A `$op(…)` call is the developer's own MQL (HR2). HR3 does not apply to it (see [LANG_RULES.md](../LANG_RULES.md)), so the compiler checks no count, key, enum or literal there. The row's lowering runs where the arguments fit it. Every other call takes HR2's plain form: `$op()` is `{ $op: {} }`, `$op(x)` is `{ $op: x }`, and `$op(a, b)` is `{ $op: [a, b] }`. The server checks the result. The shapes below are what the rows say, with an example for each.

**A list operator** (`$add`, `$setUnion`, `$concat`, …) takes its operands one by one, or ONE array literal that IS the operand list (HR2's round-trip of `{ $op: [ … ] }`). One operand that is not an array literal is ONE operand, as the server reads it. The raw document and the call take one lowering, so they agree. `test/compiler-lower.test.ts` holds this for every list-only row:

```
$add($.a, $.b, $.c)     →  { $add: ["$a", "$b", "$c"] }
$setUnion([$.a, $.b])   →  { $setUnion: ["$a", "$b"] }
$add($.x)               →  { $add: "$x" }
({ $setUnion: $.x })    →  { $setUnion: "$x" }          raw MQL passes unchanged (HR1)
$divide(10)             →  { $divide: 10 }              the server refuses one operand
({ $divide: 10 })       →  { $divide: 10 }              the same document
```

**A comparison operator** takes two operands in an expression, and has a query form in a filter:

```
$gt($.a, $.b)           →  { $gt: ["$a", "$b"] }              (expression)
$gt($.a, 1)             →  { a: { $gt: 1 } }                  (filter: MongoDB's reading, no array exclusion)
$gt($.x)                →  { $gt: "$x" }                      (expression: the server refuses one operand)
```

**An object-form operator** (`$trim`, `$dateAdd`, `$regexMatch`, …) takes its keys positionally, or as one object literal. The row's `keys` give the positional order. A call with more arguments than keys takes the plain form. The compiler does not check the keys of an object literal:

```
$trim($.name, " ")                     →  { $trim: { input: "$name", chars: " " } }
$trim({ input: $.name, chars: " " })   →  { $trim: { input: "$name", chars: " " } }
$trim($.name, " ", "x")                →  { $trim: ["$name", " ", "x"] }
$dateAdd({ startdate: $.t, unit: "day", amount: 1 })
  →  { $dateAdd: { startdate: "$t", unit: "day", amount: 1 } }      the server names the right key
```

**A query operator** has a call form in a filter, where its arguments fit that form. A call whose arguments do not fit takes the plain form:

```
$exists($.a)            →  { a: { $exists: true } }
$exists(1)              →  { $exists: 1 }                     the server refuses it at the top level
```

On an operator that is NOT object-form, a lone object literal is a value (`$mergeObjects({ a: 1 })` → `{ $mergeObjects: { a: 1 } }`). A no-argument call emits `{ $op: {} }` (`$rand()` → `{ $rand: {} }`). For an operator with both a single and a list form (`$min`, `$round`, …), the argument count decides which form applies.

The compiler refuses JSMQL code that has no MQL inside a `$op(…)` call. A JavaScript spread is one example: the refusal names the JS form that takes it (`Math.min(...xs)`), or the single-array form. A spread or a computed key in the object body of an object-form operator is another one. An arrow gets the checks of its own lowering, for example the element predicate of `$elemMatch`.

## `$literal`

`$literal(x)` emits `{ $literal: <x> }`. The compiler lowers `x` under the Env's `$literal` envelope, where nothing is an operator or a field reference. A `"$…"` string typed in source is otherwise MongoDB's own field path, and it passes through (HR1). The compiler adds one `$literal` on its own: the gate for a value that arrives at run time. See [aggregation-stages.md § `$`-string pass-through](aggregation-stages.md).

## Unknown operators

A `$name` with no row passes through by its argument count, in every position. So JSMQL runs a MongoDB operator or stage it has no row for yet. The position gives the name its role: a stage in a statement or a stream link, an expression in a value, and `{ $expr: { $foo: … } }` in a filter, with MongoDB's own truthiness. The compiler gives no spelling suggestion for a `$name`, because a suggestion refuses each new MongoDB name that is near a known one (docs/DEFERRED.md § B):

| Args | Output |
|---|---|
| zero | `{ $op: {} }` |
| one non-object | `{ $op: expr }` |
| one object literal | `{ $op: { key: val, … } }` |
| two or more | `{ $op: [a, b, …] }` |

## Query-position-only operators

`$sampleRate` has no expression form on the server. Its row lists `filter` alone: `$match($sampleRate(0.1))` → `[{ $match: { $sampleRate: 0.1 } }]`. It composes with other clauses (`$.age > 18 && $sampleRate(0.1)`). In an expression position the call is still the developer's own MQL, so it passes through: `jsmql.expr("$sampleRate(0.1)")` → `{ $sampleRate: 0.1 }`, and the server refuses it. The catalog carries the same fact as `matchOnly: true`, for the generated types.

## Return kinds

A row's `returns` states the kind of the operator's result — `string`, `number`, `bool`, `array`, `object`, `date` — or `"unknown"` where the kind follows the operands. For example, `$add` gives a number or a date, and `$first` gives whatever the array holds. The chain type-check reads this fact. It refuses `$.s.trim().foo()` when `foo` is not a string method, and it lowers an `.indexOf()` on an unknown kind as the dual-receiver `$switch`. The compiler measures `returns` on a running `mongod` (`{ $type: { <op>: <args> } }`). It never reads the vendored YAML's `type:` field, which is wrong for `$trunc`.

## Adding an operator

The recipe lives in [CLAUDE.md § Adding a new MongoDB operator](../../CLAUDE.md): a row in `names.ts`, a test on `mongod`, the reference.

## Spec drift protection

`test/operator-spec-coverage.test.ts` runs on every `npm test`. It asserts that the rows stay in sync with `mongodb/mql-specifications`:

- Every operator in `definitions/expression/`, `definitions/accumulator/`, and `definitions/query/` has a row. A name that JSMQL has no lowering for still needs a row — a row with an empty `where` states no cell, and a call of it takes HR2's plain form.
- Every operator row is a name the spec defines, except the names documented in `REGISTRY_ONLY` (for example, the update-document operators, which the pinned spec commit has no folder for).
- Every stage row is a name `definitions/stage/` defines, and every one of those has a stage row.
- Every callable operator states a non-empty description and a known `category`.

When the test fails, the message names the specific operator and the specific drift. Fix it before you merge.

## Generated user-facing types (`src/globals.ts`)

The operator rows, the stage rows, the rows' method facts, and the vendored spec are the input to the build-time generator. This generator emits the ambient-globals module shipped at `@koresar/jsmql/globals`. See [globals-generation.md](globals-generation.md).
