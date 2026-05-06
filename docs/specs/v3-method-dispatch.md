# Method Dispatch (v3 + v4 additions)

This document describes how method calls, property access, lambdas, and template literals are implemented. The original v3 method set is preserved unchanged; v4 added new methods, type-aware dispatch for `.includes`/`.indexOf`/`.concat`, and a few new node types.

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
| `.indexOf(str)` | `{ $indexOfCP: [expr, str] }` *(known string receiver only)* |
| `.replace(find, rep)` | `{ $replaceOne: { input, find, replacement } }` |
| `.replaceAll(find, rep)` | `{ $replaceAll: { input, find, replacement } }` |
| `.startsWith(s)` | `{ $eq: [{ $indexOfCP: [expr, s] }, 0] }` |
| `.endsWith(s)` | substring-equality at the tail (computed from `$strLenCP`) |
| `.charAt(n)` | `{ $substrCP: [expr, n, 1] }` |
| `.includes(str)` | `{ $gte: [{ $indexOfCP: [expr, str] }, 0] }` *(known string receiver only)* |
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
| `.includes(x)` *(known array receiver)* | `{ $in: [x, expr] }` |
| `.indexOf(x)` *(known array receiver)* | `{ $indexOfArray: [expr, x] }` |
| `.concat(...args)` *(known array receiver)* | `{ $concatArrays: [expr, ...args] }` |
| `.concat(...args)` *(known string receiver)* | `{ $concat: [expr, ...args] }` |
| `.includes/.indexOf/.concat` *(unknown receiver)* | runtime `$cond` on `$isArray` between the array and string forms (see below) |
| `.join(sep?)` | `$reduce` over the array, prepending `sep` for non-first elements |
| `.flat()` / `.flat(1)` | `$reduce` with `$concatArrays` |
| `.flatMap(x => body)` | `$reduce` over `$map` |

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
| `.getTime()` | `{ $toLong: expr }` | ms since epoch (matches JS) |
| `.toISOString()` | `{ $dateToString: { date: expr, format: "%Y-%m-%dT%H:%M:%S.%LZ" } }` | |

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

## `.length` — type-aware

`.length` is dispatched on the receiver's static type:

- string-producing receiver → `{ $strLenCP: expr }`
- array-producing receiver → `{ $size: expr }`
- otherwise → runtime `$cond` on `$isArray`

The check happens before `asFieldPath()` in the `MemberAccess` codegen case, so even `$.name.length` maps to a runtime-dispatch `$cond` rather than the field path `"$name.length"`.

## v4: type-aware dispatch for `.includes` / `.indexOf` / `.concat`

These three methods exist on both strings and arrays in JS. mjsql checks `isArrayProducing(receiver)` first — if the receiver is provably array-typed (array literal, `.split()` result, `.map()` result, etc.), the array form is emitted. Otherwise the string form is emitted (this is intentional for back-compat with v3, where `.includes` always meant `$indexOfCP`).

The `ARRAY_RETURNING_METHODS` and `ARRAY_OUTPUT_OPS` sets in `codegen.ts` drive this detection. Adding a new array-producing method requires updating both sets.

## v4: type-aware dispatch for `.includes`/`.indexOf`/`.concat`

These three methods exist on both strings and arrays in JS but compile to different MQL operators. Codegen consults `isArrayProducing(expr)` and `isStringProducing(expr)`:

- **Known array** receiver → array form (`$in`, `$indexOfArray`, `$concatArrays`).
- **Known string** receiver → string form (`$indexOfCP`, `$gte/$indexOfCP`, `$concat`).
- **Unknown** receiver (bare `FieldRef`, ternary, etc.) → emit a runtime `$cond` on `$isArray` whose branches are the two forms above. The receiver expression is reused in all three positions; for field paths this is free, and for sub-expressions MongoDB's `$cond` is short-circuit so only the chosen branch runs.

The unknown-receiver path is intentionally verbose. When the user knows the type at design time, they can pin it by chaining a type-fixing method (e.g. `.toLowerCase()` for strings, `.slice()` for arrays) or by switching to the operator form (`$in`, `$indexOfArray`, `$concatArrays`).

Spread args are handled identically across the array and string branches in `.concat`: `args.map(a => a.type === "SpreadElement" ? gen(a.argument) : gen(a))`.

## v4: template literals

`TemplateLiteral` is a new AST node with `quasis: string[]` and `expressions: Expr[]`, where `quasis.length === expressions.length + 1`. Codegen emits `$concat` over the interleaved chunks and expressions. Empty quasis are skipped to keep the output tidy.

Each interpolated expression is wrapped with `$toString` unless `isStringProducing(expr)` returns true. This matches JS template-literal coercion semantics — `` `n=${$.n}` `` works whether `$.n` is a number, boolean, or string at runtime. Expressions that are statically known to produce strings (string literals, nested templates, methods like `.toLowerCase()`, `String()` casts, the `+` operator in string context, `typeof`, and operators in `STRING_OUTPUT_OPS`) skip the wrap. `$toString` is a no-op on strings, so the wrap is purely an output-size optimisation.

A template literal is always string-producing — it counts in the string-context `+` chain detection.

## v4: optional chaining

`?.` produces the same AST nodes as `.`. There is no separate "optional" marker — the codegen for member/method access is unchanged. This is correct because MongoDB's dotted-path semantics already null-pass through missing fields.

## v4: object literals with computed or special entries

`generateObjectLiteral(entries, ctx)` is the new entry point for object literals as values. If any entry has a computed key, it emits via `$arrayToObject` over a list of `[key, value]` pairs. Otherwise it falls through to the static-key fast path. `generateStaticObjectEntries` is still used for operator-style argument objects (`{ input, find, replacement }`) where keys are part of the wire format.

The split between the two helpers is enforced inside `generateOperatorCall`: when an operator's registered shape is `object`, the static helper is used (and computed keys are rejected); otherwise the value helper is used.

## v4: spread in call args

`SpreadElement` was previously only valid in array/object literals. v4 extends it to call arg lists (`OperatorCall`, `MethodCall`, `MathCall`, `ObjectCall`). The `CallArg = Expr | SpreadElement` type is used for these arg arrays. `generateVariadicArgs(args, ctx)` decides between:

1. No spread → flat array of generated values
2. Single `...arg` → bare value
3. Mixed → `{ $concatArrays: [...] }` with non-spread args wrapped in 1-element arrays

`assertNoSpread()` is called in non-variadic operator paths (single/object/none shapes) to surface a clear error.
