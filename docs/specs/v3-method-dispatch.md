# v3 Method Dispatch

This document describes how method calls, property access, and lambdas are implemented in v3.

## Field path reconstruction via `asFieldPath()`

`parseFieldRef()` now stops at the first segment. Subsequent `.x` accesses in postfix position become `MemberAccess` nodes. Codegen uses `asFieldPath(expr, ctx)` to reconstruct MongoDB dotted field paths:

```
FieldRef("a")                          → "$a"
MemberAccess(FieldRef("a"), "b")       → "$a.b"
MemberAccess(MemberAccess(...), "c")   → "$a.b.c"
ParamRef("x") where x ∈ lambdaParams  → "$$x"
MemberAccess(ParamRef("x"), "status")  → "$$x.status"
```

If `asFieldPath()` returns `null` (non-field-chain expression), the `MemberAccess` node either emits `$strLenCP` (for `.length`) or throws a codegen error.

## Method dispatch

Method calls are handled by `generateMethodCall(object, method, args, ctx)` via a large switch statement on `method`. There is no registry — each method is hardcoded. Unknown methods throw `CodegenError`.

### String methods

| Method | MQL output |
|---|---|
| `.trim()` | `{ $trim: { input: expr } }` |
| `.trimStart()` / `.trimLeft()` | `{ $ltrim: { input: expr } }` |
| `.trimEnd()` / `.trimRight()` | `{ $rtrim: { input: expr } }` |
| `.toLowerCase()` | `{ $toLower: expr }` |
| `.toUpperCase()` | `{ $toUpper: expr }` |
| `.substr(start)` | `{ $substrCP: [expr, start, { $strLenCP: expr }] }` |
| `.substr(start, count)` | `{ $substrCP: [expr, start, count] }` |
| `.split(sep)` | `{ $split: [expr, sep] }` |
| `.indexOf(str)` | `{ $indexOfCP: [expr, str] }` |
| `.replace(find, rep)` | `{ $replaceOne: { input, find, replacement } }` |
| `.replaceAll(find, rep)` | `{ $replaceAll: { input, find, replacement } }` |
| `.includes(str)` | `{ $gte: [{ $indexOfCP: [expr, str] }, 0] }` |
| `.match(/pat/flags)` | `{ $regexMatch: { input, regex: "pat", options: "flags" } }` |
| `.match("pat")` | `{ $regexMatch: { input, regex: "pat" } }` |
| `.length` (property) | `{ $strLenCP: expr }` if string-producing, `{ $size: expr }` if array-producing, `{ $cond: [{ $isArray: expr }, { $size: expr }, { $strLenCP: expr }] }` otherwise |

### Array methods (no lambda)

| Method | MQL output |
|---|---|
| `.at(n)` | `{ $arrayElemAt: [expr, n] }` |
| `.slice(start)` | `{ $slice: [expr, start] }` |
| `.slice(start, count)` | `{ $slice: [expr, start, count] }` |
| `.reverse()` | `{ $reverseArray: expr }` |

### Array methods (with lambda)

| Method | MQL output |
|---|---|
| `.map(x => body)` | `{ $map: { input, as: "x", in: body } }` |
| `.filter(x => cond)` | `{ $filter: { input, as: "x", cond } }` |
| `.find(x => cond)` | `{ $arrayElemAt: [{ $filter: {...} }, 0] }` |
| `.some(x => body)` | `{ $anyElementTrue: { $map: {...} } }` |
| `.every(x => body)` | `{ $allElementsTrue: { $map: {...} } }` |
| `.reduce((acc, x) => body, init)` | `{ $reduce: { input, initialValue: init, in: body } }` |

### Date methods

| Method | MQL output | Note |
|---|---|---|
| `.getFullYear()` | `{ $year: expr }` | |
| `.getMonth()` | `{ $subtract: [{ $month: expr }, 1] }` | 0-based |
| `.getDate()` | `{ $dayOfMonth: expr }` | |
| `.getDay()` | `{ $subtract: [{ $dayOfWeek: expr }, 1] }` | 0-based, Sunday=0 |
| `.getHours()` | `{ $hour: expr }` | |
| `.getMinutes()` | `{ $minute: expr }` | |
| `.getSeconds()` | `{ $second: expr }` | |
| `.getMilliseconds()` | `{ $millisecond: expr }` | |

## Lambda scoping (`GenerateCtx`)

All codegen functions accept a `GenerateCtx`:

```ts
type GenerateCtx = {
  lambdaParams: ReadonlySet<string>;
  reduceRemap?: ReadonlyMap<string, string>;
};
```

When a lambda is processed, its parameters are added to `lambdaParams` via `extendCtx(ctx, params)`. Inside the lambda body:
- `ParamRef("x")` → `"$$x"` (if `x ∈ lambdaParams`)
- `MemberAccess(ParamRef("x"), "status")` → `"$$x.status"` via `asFieldPath()`

## `reduce` parameter remapping

MongoDB's `$reduce` uses fixed variable names `$$value` (accumulator) and `$$this` (current element). The user's parameter names are remapped via `ctx.reduceRemap`:

```
.reduce((acc, x) => acc + x, 0)
→ reduceRemap: { acc → "value", x → "this" }
→ body generates: { $add: ["$$value", "$$this"] }
```

The remap is applied in both `_generate(ParamRef, ctx)` and `asFieldPath(ParamRef, ctx)` — so `o.price` in a reduce body generates `"$$this.price"` when `o` is the element parameter.

## `$let` with lambda — special intercept

`$let(varsObject, lambda)` is intercepted in `generateOperatorCall` before the registry shape dispatch. This is necessary because the registry shape for `$let` is `obj("vars", "in")`, which doesn't know how to handle a `Lambda` node as the second positional argument.

The intercept:
1. Validates that args[0] is an `ObjectLiteral`
2. Extracts the lambda params and body
3. Generates `vars` in the current ctx (vars are bound, not yet in scope)
4. Generates `in` in an extended ctx with the lambda params added

## Regex literals — context-sensitive lexing

The lexer tracks `lastTokenType`. When `/` is encountered:
- If `lastTokenType ∈ { Number, String, True, False, Null, Ident, RParen, RBracket }` → emit `Slash` (divide)
- Otherwise → call `readRegex()` → emit `RegexLiteral` with `.value = pattern` and `.flags`

`readRegex()` handles:
- `\/` escape sequences (escaped slash inside pattern)
- `[...]` character classes (where unescaped `/` does not terminate the regex)
- Optional trailing flags (`gimsuy`)

In codegen, when `.match(pattern)` receives a `RegexLiteral` arg, the pattern and flags are emitted directly into `{ $regexMatch: { input, regex, options } }`. When the arg is any other expression, it is generated normally as the `regex` value.

## `.length` — always string length

`.length` is always mapped to `$strLenCP` (string character length). There is no array length shortcut — use `$size($.array)` for array length. This is documented in `docs/LANGUAGE.md`.

The check for `.length` happens before `asFieldPath()` in the `MemberAccess` codegen case, so even `$.name.length` maps to `{ $strLenCP: "$name" }` rather than the field path `"$name.length"`.
