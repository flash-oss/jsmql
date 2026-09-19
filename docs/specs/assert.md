# `assert(condition[, message])` → conditional-error guard

## Overview

`assert(condition[, message])` is the JSMQL surface that raises a **conditional
runtime error** from inside an aggregation pipeline — the MongoDB equivalent of
a guard clause. When `condition` holds, the document passes through untouched.
When it fails, the whole operation aborts, and the server returns an error whose
text carries `message`.

Statement-only: `assert(...)` emits one pipeline stage and has **no value**.
The compiler rejects it on a RHS, as an expression operand, inside a ternary
branch, or in a Filter / `jsmql.expr` (see *Rejections* below).

See [`docs/LANGUAGE.md#assert`](../LANGUAGE.md#assert-fail-the-pipeline-when-an-invariant-breaks) for the user-facing
reference.

## Why this mechanism (and not `$function`)

MongoDB has **no** dedicated error, assert, or throw aggregation operator
(confirmed against the v8.x operator reference and the long-open JIRA
SERVER-27190). The only mechanism with a fully custom message is `$function`
(server-side JS `throw`). But server-side JS is **deprecated as of MongoDB
8.0**. The Stable API (`apiStrict:true`) excludes it, and Atlas Flex and the
free tiers do not offer it. JSMQL therefore does **not** use it.

Instead JSMQL uses a portable runtime failure that is not deprecated: it feeds
an unrecognised **type name** to `$convert`. `{ $convert: { input: …, to: "<not a
type>" } }` fails at runtime with `BadValue (2): Unknown type name: <not a
type>`. The custom message rides in as the bad type name.

## Lowering

`assert(<cond>, <msg>)` lowers to exactly one stage:

```json
{ "$match": { "$expr": { "$convert": {
    "input": true,
    "to": { "$cond": [ <cond>, "bool", <failType> ] }
} } } }
```

- **Holds** → `to` resolves to `"bool"`. `$convert(true → bool)` equals `true`,
  so the `$match` keeps the document. A `$match` adds no field and drops no
  field, so a holding assertion is **invisible** in the output (no throwaway
  field).
- **Fails** → `to` resolves to `<failType>` (a string that is never a valid
  bson type name), so `$convert` throws `Unknown type name: <failType>`.

The `assert` row's `statement` cell in
[`src/registry/names.ts`](../../src/registry/names.ts) builds this: the `$convert`
guard and the `$match` around it. The statement road emits it like any other
stage.

### `<cond>`

The `truth` service lowers the condition, exactly like every other boolean
position: a comparison passes bare, and a value gets the JavaScript test. So
`assert($.active)` treats `0`, `""`, `null`, and a missing field as failing —
the JS meaning, not MongoDB's.

### `<failType>` and the prefix invariant

| `message` argument | `<failType>` |
|---|---|
| absent | `"jsmql assertion failed"` (constant) |
| string literal `"m"` | `"jsmql assertion failed: m"` (constant) |
| any other expression `e` | `{ $concat: ["jsmql assertion failed: ", { $toString: <e> }] }` |

The `jsmql assertion failed` prefix is **load-bearing, not cosmetic**. A raw
message that happens to be a valid type name (for example `assert($.ok,
"int")`) would make `$convert` **succeed** and skip the assertion silently.
The prefix (the spaces and the leading words) guarantees that the
failing-branch string is never a real type name, so the assertion always
fires. It also reuses the inevitable `Unknown type name:` boilerplate — the
user's text reads as the tail of the sentence.

The dynamic branch wraps the message in `$toString`, so a non-string
expression (`assert($.ok, $.count)`) is coerced instead of crashing
`$concat`.

## Why the gating is robust

The server always evaluates the `$convert`. The gating lives only in its
runtime `to` value, computed per document. This design does **not** rely on
`$cond` or `$and` to short-circuit an untaken branch, because MongoDB does
**not** document or guarantee that behaviour (the `$and`/`$or` reference warns
that a later operand "may cause an error even if the first expression
evaluates to false"). Placing the failing-branch *expression* directly in a
`$cond` branch would also risk the optimiser folding a constant message at
planning time, which would fire the error unconditionally. Routing it through
`$convert.to` avoids that risk too.

## Dispatch (call forms)

`assert(...)` is a bare-identifier `CallExpression`. Its row lists a
`statement` form and no value form, so it is a statement wherever it stands.
A lone `assert(…)` with no `;` is a pipeline by the shape rule
([filter-mode.md § The decision](filter-mode.md)). All of these work:

- `({ $ }) => { assert($.q >= 0, "m"); $.fee = … }` — multi-statement pipeline
- `({ $ }) => { assert($.q >= 0, "m") }` — single-statement block
- `"assert($.q >= 0, 'm'); …"` / `"assert($.q >= 0, 'm')"` — string forms
- `"[assert($.q >= 0, 'm'), $sort({ q: 1 })]"` — bracketed array
- `jsmql.pipeline(…)` — strict pipeline entry

A user-declared `const assert = …` takes precedence. The built-in yields when
`assert` is a reusable function in scope, so the name is not hard-reserved.

## Rejections

| Input | Error |
|---|---|
| expression position (ternary branch, field RHS, nested call) | `'assert(...)' is a pipeline statement, not a value …` (the row's refusal for the value position) |
| `jsmql.filter(...)` / `jsmql.expr(...)` | same statement-form hint |
| `assert()` / `assert(a, b, c)` | `assert(condition[, message]) requires 1 or 2 arguments, got N` |
| `assert(...x)` (spread) | `Spread (...) is not supported as an argument to 'assert(...)'.` |

## `jsmql.update()`

`assert(...)` lowers to a `$match`. MongoDB's update-pipeline stage whitelist
does **not** include `$match`, so `jsmql.update(...)` rejects it through the
existing whitelist check (naming `$match`). Assertions belong in a read
pipeline, not in an update.

## Error shape at runtime

A failing assertion surfaces as a driver error with `code: 2`,
`codeName: "BadValue"`, and an `errmsg` that ends in
`Unknown type name: jsmql assertion failed: <message>`. The numeric code is
fixed, because it is MongoDB's code, not JSMQL's. Only the message text is
under the user's control.
