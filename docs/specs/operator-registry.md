# Operator Registry

`src/operators.ts` is the single source of truth for how MongoDB operators are mapped to MQL output shapes.

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

A single object-literal arg is treated as a value (the object itself), since flex is not the same as object-shape:

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

1. Choose the correct shape.
2. For `object` shape, list the positional key names in argument order. Optional trailing keys are fine — users can simply omit them.
3. Add the entry to `OPERATORS` in `src/operators.ts`.
4. Add a test case in `test/codegen.test.ts`.
5. Update `docs/LANGUAGE.md` if the operator is user-facing.

## Current operator counts (v1)

| Category | Count |
|---|---|
| Arithmetic | 16 |
| Trigonometry | 15 |
| Comparison | 7 |
| Boolean | 3 |
| Conditional | 3 |
| String | 18 |
| Array | 17 |
| Set | 7 |
| Object | 5 |
| Date | 17 |
| Type | 10 |
| Variable | 1 |
| Miscellaneous | 4 |
| Accumulators | 11 |
| **Total** | **~134** |
