# `assert(condition[, message])` → conditional-error guard

## Overview

`assert(condition[, message])` is the jsmql surface for raising a **conditional
runtime error** from inside an aggregation pipeline — the MongoDB equivalent of
a guard clause. When `condition` holds the document passes through untouched;
when it fails the whole operation aborts and the server returns an error whose
text carries `message`.

Statement-only: `assert(...)` emits one pipeline stage and has **no value**.
Using it on a RHS, as an expression operand, inside a ternary branch, or in a
Filter / `jsmql.expr` is rejected at compile time (see *Rejections* below).

See [`docs/LANGUAGE.md#assert`](../LANGUAGE.md#assert) for the user-facing
reference.

## Why this mechanism (and not `$function`)

MongoDB has **no** dedicated error/assert/throw aggregation operator (confirmed
against the v8.x operator reference and the long-open JIRA SERVER-27190). The
only mechanism that carries a fully custom message is `$function` (server-side
JS `throw`) — but server-side JS is **deprecated as of MongoDB 8.0**, excluded
from the Stable API (`apiStrict:true`), and unavailable on Atlas Flex / free
tiers. jsmql therefore does **not** use it.

Instead jsmql abuses a portable, non-deprecated runtime failure: feeding an
unrecognised **type name** to `$convert`. `{ $convert: { input: …, to: "<not a
type>" } }` fails at runtime with `BadValue (2): Unknown type name: <not a
type>`. The custom message rides in as the bogus type name.

## Lowering

`assert(<cond>, <msg>)` lowers to exactly one stage:

```json
{ "$match": { "$expr": { "$convert": {
    "input": true,
    "to": { "$cond": [ <cond>, "bool", <failType> ] }
} } } }
```

- **Holds** → `to` resolves to `"bool"`; `$convert(true → bool)` = `true`; the
  `$match` keeps the document. A `$match` neither adds nor drops fields, so a
  holding assertion is **invisible** in the output (no throwaway field).
- **Fails** → `to` resolves to `<failType>` (a string that is never a valid
  bson type name); `$convert` throws `Unknown type name: <failType>`.

Built by `generateAssertGuardExpr` (the `$convert` expression) in
[`src/codegen.ts`](../../src/codegen.ts); the `$match` wrap is applied in
[`src/pipeline.ts`](../../src/pipeline.ts) (`lowerStatementTail`).

### `<cond>`

`generate`d from the condition expression and wrapped in JS-truthiness
(`jsBoolIfNeeded`) exactly like every other boolean context, so
`assert($.active)` treats `0` / `""` / `null` / missing as failing — the JS
meaning, not MongoDB's.

### `<failType>` and the prefix invariant

| `message` argument | `<failType>` |
|---|---|
| absent | `"jsmql assertion failed"` (constant) |
| string literal `"m"` | `"jsmql assertion failed: m"` (constant) |
| any other expression `e` | `{ $concat: ["jsmql assertion failed: ", { $toString: <e> }] }` |

The `jsmql assertion failed` prefix is **load-bearing, not cosmetic**: a raw
message that happened to be a valid type name (e.g. `assert($.ok, "int")`)
would make `$convert` **succeed** and silently skip the assertion. The prefix
(spaces + the leading words) guarantees the failing-branch string is never a
real type name, so the assertion always fires. It also reclaims the inevitable
`Unknown type name:` boilerplate — the user's text reads as the tail of the
sentence.

The dynamic branch wraps the message in `$toString` so a non-string expression
(`assert($.ok, $.count)`) is coerced rather than crashing `$concat`.

## Why the gating is robust

The `$convert` is **always evaluated** — the gating lives entirely in its
runtime `to` value, computed per-document. This deliberately does **not** rely
on `$cond`/`$and` short-circuiting an untaken branch, which MongoDB does **not**
document or guarantee (the `$and`/`$or` reference explicitly warns a later
operand "may cause an error even if the first expression evaluates to false").
Placing the failing-branch *expression* directly in a `$cond` branch would also
risk the optimizer constant-folding a constant message at planning time, firing
the error unconditionally; routing it through `$convert.to` avoids that too.

## Dispatch (call forms)

`assert(...)` is a bare-identifier `CallExpression`. It is recognised as a
pipeline statement in `lowerStatementTail`, flips array/single-statement input
into pipeline mode via `isStageCandidate`, and is auto-wrapped into a one-stage
pipeline by the `jsmql()` / `jsmql.pipeline()` entry points (so no trailing `;`
is needed). All of these work:

- `({ $ }) => { assert($.q >= 0, "m"); $.fee = … }` — multi-statement pipeline
- `({ $ }) => { assert($.q >= 0, "m") }` — single-statement block
- `"assert($.q >= 0, 'm'); …"` / `"assert($.q >= 0, 'm')"` — string forms
- `"[assert($.q >= 0, 'm'), $sort({ q: 1 })]"` — bracketed array
- `jsmql.pipeline(…)` — strict pipeline entry

A user-declared `const assert = …` takes precedence (the built-in yields when
`assert` is a reusable function in scope), so the name is not hard-reserved.

## Rejections

| Input | Error |
|---|---|
| expression position (ternary branch, field RHS, nested call) | `'assert(...)' is a pipeline statement, not a value …` (thrown in `generateCallExpression`) |
| `jsmql.filter(...)` / `jsmql.expr(...)` | same statement-form hint |
| `assert()` / `assert(a, b, c)` | `assert(condition[, message]) requires 1 or 2 arguments, got N` |
| `assert(...x)` (spread) | `Spread (...) is not supported as an argument to 'assert(...)'.` |

## `jsmql.update()`

`assert(...)` lowers to a `$match`, which is **not** in MongoDB's
update-pipeline stage whitelist, so `jsmql.update(...)` rejects it through the
existing whitelist check (naming `$match`). Assertions belong in a read
pipeline, not an update.

## Error shape at runtime

A failing assertion surfaces as a driver error with `code: 2`,
`codeName: "BadValue"`, and `errmsg` ending in
`Unknown type name: jsmql assertion failed: <message>`. The numeric code is
fixed (it is MongoDB's, not jsmql's) — only the message text is controllable.
