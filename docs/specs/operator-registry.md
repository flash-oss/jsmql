# Operator Registry

`src/operators.ts` is the single source of truth for how MongoDB operators are mapped to MQL output shapes, and the canonical catalog of every MongoDB expression and accumulator operator mjsql knows about.

Each entry has three fields:

| Field | Purpose |
|---|---|
| `shape` | One of five [shapes](#shapes); decides how the operator's MQL value is structured. |
| `category` | A label from `OPERATOR_CATEGORIES` (see below). Used for documentation grouping; not consumed by codegen. |
| `description` | One-sentence summary, lifted verbatim from the official MongoDB spec where possible. Surfaced in editor tooltips and future docs generation. |

The full list of categories: `arithmetic`, `array`, `bitwise`, `boolean`, `comparison`, `conditional`, `custom-aggregation`, `data-size`, `date`, `encrypted-string`, `literal`, `miscellaneous`, `object`, `set`, `string`, `text`, `timestamp`, `trigonometry`, `type`, `variable`, `window`.

## Shapes

Every operator has one of five shapes:

### `single` → `{ $op: expr }`
The operator takes exactly one expression argument. If more or fewer are given, codegen throws.

```
$abs($.delta)     →  { $abs: "$delta" }
$not($.active)    →  { $not: "$active" }
```

### `array` → `{ $op: [a, b, ...] }`
The operator takes one or more positional arguments collected into an array. Single-argument calls still produce an array.

```
$eq($.age, 18)          →  { $eq: ["$age", 18] }
$add($.a, $.b, $.c)     →  { $add: ["$a", "$b", "$c"] }
$ifNull($.x, $.y, 0)    →  { $ifNull: ["$x", "$y", 0] }
```

### `object` → `{ $op: { k1: a, k2: b } }`
The operator's MQL form takes an object. The registry entry stores an ordered `keys` array that maps positional argument positions to named keys.

Two calling styles are accepted:

**Positional** — args are mapped to keys in order:
```
$trim($.name, " ")    →  { $trim: { input: "$name", chars: " " } }
```
Trailing optional keys may be omitted:
```
$trim($.name)         →  { $trim: { input: "$name" } }
```

**Object-style** — a single object literal is passed through as-is:
```
$trim({ input: $.name, chars: " " })   →  { $trim: { input: "$name", chars: " " } }
```
The keys in the object literal are not validated against the registry — they are passed through verbatim. This allows passing optional or undocumented keys.

### `none` → `{ $op: {} }`
The operator takes no arguments (e.g. `$rand`).

```
$rand()    →  { $rand: {} }
```

### `flex` → `{ $op: expr }` _or_ `{ $op: [a, b, ...] }`
The operator legitimately accepts both a single expression (typically in accumulator context, e.g. `$min` inside `$group`) and an array of expressions (in expression context, e.g. `$min` inside `$project`). The output shape is decided by argument count:

```
$min($.scores)            →  { $min: "$scores" }            (1 arg → single)
$min($.a, $.b, $.c)       →  { $min: ["$a", "$b", "$c"] }   (2+ args → array)
$round($.price)           →  { $round: "$price" }
$round($.price, 2)        →  { $round: ["$price", 2] }
```

Spread handling matches `array`-shape operators:

```
$min(...$.scores)         →  { $min: "$scores" }                          (single spread → bare)
$max($.first, ...$.rest)  →  { $max: { $concatArrays: [["$first"], "$rest"] } }  (mixed)
```

A single object-literal arg is treated as a **value** (the object itself), not as a shape signal. `flex` is not the same as `object`-shape: with `object`-shape, a lone object literal is the operator's structured argument with named keys; with `flex`, it's just one value among potentially many.

```
$mergeObjects({ a: 1 })   →  { $mergeObjects: { a: 1 } }
```

Current flex operators: `$round`, `$trunc`, `$min`, `$max`, `$avg`, `$sum`, `$stdDevPop`, `$stdDevSamp`, `$mergeObjects`.

## Unknown operators

If an operator name is not found in the registry, the codegen falls through using these heuristics:

| Args | Output |
|---|---|
| zero | `{ $op: {} }` |
| one non-object | `{ $op: expr }` |
| one object literal | `{ $op: { key: val, … } }` |
| two or more | `{ $op: [a, b, …] }` |

This makes mjsql forward-compatible with new MongoDB operators that are not yet in the registry.

## Adding an operator

1. Verify the operator exists in `vendor/mql-specifications/definitions/expression/<name>.yaml` (or `definitions/accumulator/`). The spec is vendored on `npm install` via `vendor/fetch-mql-specs.mjs` at a pinned commit; the directory is gitignored. If a new operator isn't there, either bump the pinned commit (in the script) or add it to `REGISTRY_ONLY` in `test/operator-spec-coverage.test.ts` with a documenting comment.
2. Choose the correct shape (see above).
3. For `object` shape, list the positional key names in argument order. Optional trailing keys are fine — users can simply omit them.
4. Lift the `description` from the YAML's `description` field. Trim to one sentence.
5. Pick a `category` from `OPERATOR_CATEGORIES`.
6. Add the entry to `OPERATORS` in `src/operators.ts`.
7. Add a test case in `test/codegen.test.ts`.
8. Update `docs/LANGUAGE.md` if the operator is user-facing.

## Spec drift protection

`test/operator-spec-coverage.test.ts` runs on every `npm test` and asserts that the registry stays in sync with `mongodb/mql-specifications`. Specifically:

- Every operator in `definitions/expression/` and `definitions/accumulator/` exists in `OPERATORS`.
- Every `OPERATORS` entry exists in the spec, except those documented in `REGISTRY_ONLY` (e.g. `$encStr*` Queryable Encryption ops, `$sampleRate` query predicate, `$toUUID/$toObject/$toArray` post-spec converters).
- For object-shape entries, every positional key name is recognised by the spec for that operator. Set membership only — order may differ to preserve mjsql's API surface.
- Every entry has a non-empty `description` and a known `category`.

When the test fails, the message names the specific operator and the specific drift; act on it before merging.

## Current operator counts

| Category | Count |
|---|---|
| Arithmetic | 23 |
| Array | 29 |
| Bitwise | 4 |
| Boolean | 3 |
| Comparison | 9 |
| Conditional | 3 |
| Custom-aggregation | 2 |
| Data-size | 2 |
| Date | 22 |
| Encrypted-string | 4 |
| Literal | 1 |
| Miscellaneous | 6 |
| Object | 4 |
| Set | 7 |
| String | 20 |
| Text | 1 |
| Timestamp | 2 |
| Trigonometry | 15 |
| Type | 13 |
| Variable | 1 |
| Window | 11 |
| **Total** | **182** |

Counts may drift as MongoDB adds operators; the drift-protection test will surface any divergence between the registry and the spec.
