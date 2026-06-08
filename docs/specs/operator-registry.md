# Operator Registry

`src/operators.ts` is the single source of truth for how MongoDB operators are mapped to MQL output shapes, and the canonical catalog of every MongoDB expression and accumulator operator jsmql knows about.

Each entry has three required fields plus one optional flag:

| Field | Purpose |
|---|---|
| `shape` | One of five [shapes](#shapes); decides how the operator's MQL value is structured. |
| `category` | A label from `OPERATOR_CATEGORIES` (see below). Used for documentation grouping; not consumed by codegen. |
| `description` | One-sentence summary, lifted verbatim from the official MongoDB spec where possible. Surfaced in editor tooltips and future docs generation. |
| `accumulatorOnly?` | Set `true` for operators that have **no** expression form — they only mean something inside `$group` field-value slots or `$setWindowFields.output` bodies (`$push`, `$addToSet`, `$top`/`$topN`, `$bottom`/`$bottomN`, `$median`, `$percentile`, `$accumulator`). Codegen's `checkOperatorContext` gates on this flag, so it is the single source of truth — there is no separate set to keep in sync. Wrap the shape factory with `acc(...)`: `acc(single("array", "…"))`. Operators with *both* forms ($sum, $avg, $max, $min, $stdDev*) leave it unset and stay unrestricted. (Window-only operators are gated separately, by `category === "window"`.) |

The full list of categories — see `OPERATOR_CATEGORIES` in `src/operators.ts`.

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
The operator legitimately accepts both a single expression and an array of expressions; the output shape is decided by argument count. Two cases use this: (1) accumulator-vs-expression duals (e.g. `$min` — single in `$group`, array in `$project`); (2) **dual-form operators with a single-value query form** — the comparison operators `$eq`/`$ne`/`$gt`/`$gte`/`$lt`/`$lte` and `$in`, where one argument is the valid query shape `{ field: { $gt: v } }` and two-or-more are the aggregation operands (HR2 — see [LANG_RULES.md](../LANG_RULES.md)). This is why a single arg never errors for these (unlike a list-only `array` op such as `$setUnion`, which has no single-value form).

```
$min($.scores)            →  { $min: "$scores" }            (1 arg → single)
$min($.a, $.b, $.c)       →  { $min: ["$a", "$b", "$c"] }   (2+ args → array)
$round($.price)           →  { $round: "$price" }
$round($.price, 2)        →  { $round: ["$price", 2] }
$gt($.x)                  →  { $gt: "$x" }                  (query single-value form)
$gt($.a, $.b)             →  { $gt: ["$a", "$b"] }          (aggregation operands)
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

Current flex operators — see entries with `shape: FLEX` in `src/operators.ts`.

## `$literal` and the auto-wrap policy

`$literal` is the one operator with a fast-path branch in `generateOperatorCall` ([src/codegen.ts](../../src/codegen.ts)). Two things make it special:

1. **Direct codegen.** `$literal(arg)` always emits `{ $literal: <generated arg> }` regardless of registry shape. The fast path sits *ahead* of the `style === "object"` branch because the parser tags `$literal({ x: 1 })` as object-style, but we still want to treat the inner object as `$literal`'s argument rather than as named-key wire format.
2. **`insideLiteral` ctx flag.** The fast path recurses with `{ ...ctx, insideLiteral: true }`. This suppresses the auto-`$literal` safety net described below for the whole subtree, so `$literal({ x: "$foo" })` produces `{ $literal: { x: "$foo" } }` — a literal of a literal would otherwise emit `{ $literal: { x: { $literal: "$foo" } } }`.

The flag is propagated through `extendCtx`, so it survives lambda bodies and other ctx-modifying paths inside `$literal`. `freshSubPipelineCtx` deliberately drops it — a sub-pipeline starts at a fresh scope, no outer `$literal` envelope.

### Auto-`$literal` for `"$..."`-shaped string values

The codegen emits any `StringLiteral` in a value position via `literalSafeString` ([src/codegen.ts](../../src/codegen.ts)): a string starting with `$` is wrapped in `{ $literal: value }` so MongoDB doesn't read it as a field reference at runtime. Plain strings pass through unchanged. The same `safeBoundValue` helper applies the policy recursively to `jsmql.compile()` parameter bindings (so a `"$foo"` value supplied at call time gets the same protection) — template-tag interpolation already routes through the parser and produces `StringLiteral` nodes, picking up the wrap automatically.

Object **keys** are deliberately *not* wrapped. Keys are part of the JSON wire format, never evaluated by MongoDB as expressions, so `{ "$foo": 1 }` stays verbatim — that's how the user names a field `$foo`. The auto-wrap only fires on `StringLiteral` nodes generated through `_generate`, and key paths go through `entry.key.name` rather than `_generate(entry.key.value, ctx)`.

## Unknown operators

If an operator name is not found in the registry, the codegen falls through using these heuristics:

| Args | Output |
|---|---|
| zero | `{ $op: {} }` |
| one non-object | `{ $op: expr }` |
| one object literal | `{ $op: { key: val, … } }` |
| two or more | `{ $op: [a, b, …] }` |

This makes jsmql forward-compatible with new MongoDB operators that are not yet in the registry.

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
- For object-shape entries, every positional key name is recognised by the spec for that operator. Set membership only — order may differ to preserve jsmql's API surface.
- Every entry has a non-empty `description` and a known `category`.

When the test fails, the message names the specific operator and the specific drift; act on it before merging.

## Generated user-facing types (`src/ops.ts`)

The registry, together with `STAGES` in [`src/stages.ts`](../../src/stages.ts) and the vendored spec, is the input to a build-time generator that emits the ambient-globals module shipped at the `@koresar/jsmql/ops` subpath. See [`ops-generation.md`](ops-generation.md) for the generator's contract and type-mapping rules.

When you add a new operator, the generator picks it up automatically on the next `npm test` / `npm run build`. The drift test in `test/operator-spec-coverage.test.ts` will fail if the committed `src/ops.ts` is stale; running `npm run generate:ops` refreshes it.
