# Method Dispatch

This document describes how method calls, property access, lambdas, and template literals are implemented.

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

Method calls are handled by `generateMethodCall(object, method, args, ctx)` via a large switch statement on `method`. Each method's *codegen* is hardcoded in its `case` (the switch is the lowering dispatch), but its *metadata* lives in one registry, `METHODS`.

### `METHODS` — the metadata registry

`METHODS: Record<string, MethodMeta>` is the single source of truth for every JS method jsmql recognises. Each entry carries up to two optional fields:

- `returns?: "string" | "array" | "bool" | "number" | "object"` — the method's result type when it's **invariant** (independent of receiver element type / args / context). Feeds `isStringProducing` / `isArrayProducing` / `isProvablyBool` and the chain type-check (below). Omitted when the result type depends on the receiver or args (`.slice`, `.concat`, `.at`, `.max`/`.min`/`.minBy`/`.maxBy` → element; `.plus`/`.minus` → same-as-receiver date; `.clamp` → number-or-date; `.reduce` → whatever the reducer returns).
- `optional?: "string" | "array" | "either"` — the *receiver's* type, used to pick the `$ifNull` neutral when a `?.` chain feeds the receiver (`""` / `[]` / branch-aware). Omitted for date/set/regex methods whose underlying operators handle null cleanly. Also doubles as the required-receiver family for the chain type-check (see `requiredReceiverFamily`).

The former hand-maintained Sets (`STRING_RETURNING_METHODS`, `ARRAY_RETURNING_METHODS`, `BOOL_RETURNING_METHODS`, `OPTIONAL_STRING_METHODS`, `OPTIONAL_ARRAY_METHODS`, `OPTIONAL_EITHER_METHODS`) and `KNOWN_METHODS` are now **derived** from `METHODS` via `methodsWhere(...)` / `Object.keys(...)`. Adding a method is one `METHODS` entry (for inference + suggestions) plus its `case` (for lowering) plus a `checkArity` call (for arity), instead of editing several scattered Sets. Unknown methods throw `CodegenError` with a `didYouMean` suggestion drawn from `Object.keys(METHODS)`.

### Argument-count validation — `checkArity`

Every arg-count error is worded by one helper, `checkArity(method, spec, count, callPos, prefix?)`, so the surface stays consistent (per the error-consistency rules in the root `CLAUDE.md`). Each call site supplies an inline `Arity` spec — `{ sig, exact | allowed | atLeast | none }` — and the helper renders `<prefix><method>(<sig>) <quantity-clause>, got <N>` on mismatch:

- `{ sig: "index", exact: 1 }` → `.charAt(index) requires exactly 1 argument, got 0`
- `{ sig: "start[, end]", allowed: [0, 1, 2] }` → `.slice(start[, end]) requires 0, 1, or 2 arguments, got 3`
- `{ sig: "...items", atLeast: 1 }` → `.concat(...items) requires at least 1 argument, got 0`
- `{ sig: "", none: true }` → `.toReversed() takes no arguments, got 1`

The `sig` always shows the intended call shape (parameter names, with optional ones in `[...]`), so the user sees the signature up front rather than having to consult MDN, and the trailing `, got <N>` reports exactly what was passed. The caller passes the count it validates — `exprArgs.length` for most, raw `args.length` for the few that count spread args (`.concat`, `.toReversed`, `.toString`). `prefix` defaults to `"."`; the static families pass `"Math."` / `"Object."` / `"Set."` / `"regex."`. Every arg-count error across the whole surface — instance methods, the `Math.`/`Object.`/`Set.`/`regex.` statics, `generateMathCall`'s `oneArg` helper, and the statement-position array-mutator rewrites (`.reverse` / `.pop` / `.shift` / `.copyWithin` / `.fill`) — now flows through `checkArity`. (The parser-side constructor checks `new Set(...)` / `new Date(...)` / `Date.UTC(...)` are the one exception: they throw `ParseError`, not `CodegenError`, so they keep their own `, got N` wording.) The spec lives next to each method's lowering rather than in a separate table, so adding a method is a `case` plus a one-line `checkArity`.

### Chain type-check — reject a method on a provably-incompatible receiver

`generateMethodCall` throws (before the lowering switch) when a method is chained on a receiver whose type is **100%-certain** to be incompatible — the "lodash-style chaining must make sense" rule. Without it, `.every(p).map(f)` / `s.toUpperCase().map(f)` / `a.countBy("t").take(3)` silently emitted MQL the server rejects (`$map` over a boolean/number/string, `$slice` over an object). Two helpers drive it:

- `certainReceiverType(object)` — the receiver's provable, invariant type, or `null` when uncertain. `bool`/`array` reuse the verified-sound `isProvablyBool` / `isArrayProducing` (which recurse through `.slice`/`MethodCall` and subsume literals + array-typed operators); `string`/`number`/`object` are read from the receiver **method's** invariant `returns` — deliberately **not** from `isStringProducing` (its `STRING_OUTPUT_OPS` wrongly holds the int-returning `$strcasecmp`) nor object literals (a `{$op}` escape hatch can return any type). Every unknown receiver (a field ref, a `.find()`/`.at()`/`.max()` element of unknown type, a `.concat`/operator/`{$op}`-literal result) returns `null` and never throws — the literal-gating guarantee, mirroring the date-receiver gate.
- `requiredReceiverFamily(method)` — the receiver type a method **requires**, or `null` for dual/universal methods (`.slice`/`.concat`/`.indexOf`/`.includes` accept string OR array; `.size` array OR object; `.toString`/`.getTime` any) which are therefore never gated (their legitimate multi-type uses always compile). Derived from `receiver` (`"date"`), the `NUMBER_RECEIVER_METHODS` / `OBJECT_RECEIVER_METHODS` sets, and `optional`.

`rejectIncompatibleChain` compares them: a `bool` receiver rejects every method except `.toString`/`.getTime` (a boolean has no others); any other type rejects a method whose required family differs. All enforced rules were verified against a live mongod as genuine server-rejections; the deliberately-uncertain cases (value-mode `.find(...)/.at(...)` element type unknown, `.clamp(...)` number-or-date, dual methods) still emit. In the `$$$.<coll>` lookup path a `.find(<pred>).<array-method>` chain is caught earlier, in `lookup-translation.ts` (a `.find` result is one document) — see [lookup-stage.md](lookup-stage.md).

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
| `.matchAll(/pat/g)` | `{ $regexFindAll: { input, regex, options } }` (requires `g` flag) |
| `.search(/pat/)` | `$regexFind` + `.idx` field, with `$ifNull` fallback to `-1` |
| `.padStart(n[, ch])` | `$let` + `$cond` + `$reduce`($range) — pad-string concatenated *before* receiver |
| `.padEnd(n[, ch])` | mirror of padStart, pad string concatenated *after* receiver |
| `.repeat(n)` | `$reduce` over `$range(0, n)` concatenating receiver |
| `.length` (property) | `{ $strLenCP: expr }` if string-producing, `{ $size: expr }` if array-producing, `{ $cond: { if: { $isArray: expr }, then: { $size: expr }, else: { $strLenCP: expr } } }` otherwise |

### Array methods (no lambda)

| Method | MQL output |
|---|---|
| `.at(n)` | `{ $arrayElemAt: [expr, n] }` |
| `.slice(start)` | `{ $slice: [expr, start] }` |
| `.slice(start, count)` | `{ $slice: [expr, start, count] }` |
| `.toReversed()` | `{ $reverseArray: expr }` (ES2023). `.reverse()` is rejected at expression position — see *Mutators at statement position* below. |
| `.toSorted()` | `{ $sortArray: { input: expr, sortBy: 1 } }` (ES2023, ascending). `.sort()` is rejected at expression position — see *Mutators at statement position* below. |
| `.toSorted(x => x.path)` | `{ $sortArray: { input: expr, sortBy: { "path": 1 } } }` — key-function form, ascending. Lowered via `lambdaToSortBy()` in `codegen.ts`. |
| `.toSorted(x => -x.path)` | `{ $sortArray: { input: expr, sortBy: { "path": -1 } } }` — key-function form with unary `-`, descending. |
| `.sortBy(<field> \| [fields] \| keyFn)` | Lodash ascending-sort alias → `{ $sortArray: { input: expr, sortBy: { … } } }` (all keys ascending). An object arg is rejected (a lodash matches-shorthand, not a direction; error points at `.orderBy({…})` / `.toSorted({…})`). |
| `.orderBy(keys[, orders])` / `.orderBy({ field: dir })` | Lodash multi-key sort → `{ $sortArray: { input: expr, sortBy: { … } } }`. Parallel form: `keys` (field / `[fields]` / key-fn) zipped with `orders` (`1 \| -1 \| "asc" \| "desc"`, or an array; fewer orders ⇒ rest ascending) via `orderByKeyNames` + `orderByDirs`. Object form: a `{ field: dir }` spec with directions inline (lowered through the shared `argToSortBy`, like `.toSorted({…})`) — a second `orders` arg is then rejected. |
| `.toSpliced(start, [deleteCount, ...items])` | `$let` over receiver + start + tail-start, then `$concatArrays` of `[$slice(arr, 0, start), [items...], $slice(arr, tailStart, max(0, size - tailStart))]`. Omitted `deleteCount` ⇒ remove to end. ES2023. Negative-literal `start`/`deleteCount` rejected at compile time. |
| `.with(index, value)` | `$let` over receiver + index + value, then `$concatArrays` of `[$slice(arr, 0, idx), [value], $slice(arr, idx+1, max(0, size - (idx+1)))]`. ES2023. Negative-literal `index` rejected at compile time. |
| `.includes(x)` *(known array receiver)* | `{ $in: [x, expr] }` |
| `.indexOf(x)` *(known array receiver)* | `{ $indexOfArray: [expr, x] }` |
| `.lastIndexOf(x)` *(array only)* | `$let` over receiver + `$indexOfArray($reverseArray(arr), x)`, mapped back to original index (or `-1`). String receivers throw — MongoDB `$indexOfCP` is forward-only. |
| `.concat(...args)` *(known array receiver)* | `{ $concatArrays: [expr, ...args] }` |
| `.concat(...args)` *(known string receiver)* | `{ $concat: [expr, ...args] }` |
| `.includes/.indexOf/.concat` *(unknown receiver)* | runtime `$cond` on `$isArray` between the array and string forms (see below) |
| `.join(sep?)` | `$reduce` over the array, prepending `sep` for non-first elements |
| `.toString()` *(known array)* | same `$reduce` as `.join(",")`. Known string receiver: no-op. Unknown: `{ $toString: expr }`. |
| `.flat()` / `.flat(1)` | `$reduce` with `$concatArrays` |

### Array methods (with lambda)

| Method | MQL output (1-param `x => …`) |
|---|---|
| `.map(x => body)` | `{ $map: { input, as: "x", in: body } }` |
| `.filter(x => cond)` | `{ $filter: { input, as: "x", cond } }` |
| `.find(x => cond)` | `{ $arrayElemAt: [{ $filter: {...} }, 0] }` |
| `.findIndex(x => cond)` | `$reduce` over `$zip` of `($range, expr)` with `initialValue: -1`; updates `$$value` only while it's still `-1`, so the result is the first match (or `-1`) |
| `.findLast(x => cond)` | `{ $arrayElemAt: [{ $filter: {...} }, -1] }` (ES2023) |
| `.findLastIndex(x => cond)` | `$reduce` over `$zip` of `($range, expr)`, last index where cond is true (or `-1`) |
| `.some(x => body)` | `{ $anyElementTrue: { $map: {...} } }` |
| `.every(x => body)` | `{ $allElementsTrue: { $map: {...} } }` |
| `.flatMap(x => body)` | `$reduce` over `$map` (concatenating each element's mapped array) |
| `.reduce((acc, x) => body, init)` | `{ $reduce: { input, initialValue: init, in: body } }` |
| `.reduceRight((acc, x) => body, init)` | same as `.reduce`, but `input: { $reverseArray: expr }` |

**Bare type-cast callbacks.** All single-param lambda callbacks above also accept a bare `Boolean` / `Number` / `String` reference (`TypeCastRef` AST node) in place of a `Lambda`. `requireLambda()` in `codegen.ts` desugars `TypeCastRef { cast }` to a synthetic `Lambda { params: ["v"], body: TypeCast(cast, ParamRef("v")) }` before the per-method handler runs — so all eight handlers above support `.filter(Boolean)` etc. with no per-method changes. `.reduce()` / `.reduceRight()` reject this through their existing 2-or-3 param check (synthetic lambda has 1 param). `parseInt`/`parseFloat` are deliberately not bare-callable; see [grammar.md](grammar.md#type-cast-call-vs-bare-reference).

**lodash iteratee/predicate shorthands.** Alongside the type-cast desugar, `requireLambda()` also desugars the three `_.identity`-family shorthands into synthetic arrows via `shorthandToLambda(arg, method, "jsmqlItem")` — a **property string** `"a.b"` → `it => it.a.b`, a **matches object** `{ a: 1, b }` → `it => it.a === 1 && it.b === b` (flat `$eq` per key; single key emits a bare `$eq`, multiple an `$and`), and a **matchesProperty pair** `["a.b", v]` → `it => it.a.b === v`. Because they become ordinary arrows before lowering, each method's own value/boolean handling applies unchanged (a predicate method's `jsBoolIfNeeded` gives a property string JS-truthy semantics; `.map` reads it as a plucked value). The lodash iteratee/predicate helpers (`resolveIteratee` → the `By` family; `resolvePredicate` → `.reject`/`.partition`/`.takeWhile`/… delegates to it) share the same `shorthandToLambda`, so the shorthand vocabulary and emitted shape are identical across native and lodash methods. The `_.matches` comparison is flat `$eq`, **not** lodash's deep partial match.

**Optional iteratee → identity (the object-collapse family).** `resolveIteratee(undefined, …)` returns the identity iteratee (`$$jsmqlItem` → the element itself), so a value-mode `*By` method invoked with no argument counts/groups/keys by the element value — mirroring lodash's `[iteratee=_.identity]` default (`_.countBy([1,2,2])` → `{ "1": 1, "2": 2 }`). This is enabled only for the three collapse methods that have no existing no-arg alias — `.countBy()` / `.groupBy()` / `.keyBy()` (arity `allowed: [0, 1]`). It is deliberately **not** extended to `.sumBy`/`.meanBy`/`.minBy`/`.maxBy`/`.uniqBy`, whose lodash no-arg forms already have dedicated spellings (`.sum`/`.mean`/`.min`/`.max`/`.uniq`) — a second spelling for the same capability is the drift jsmql rejects. The **stream** forms (`$$.countBy("field")`, …) still require a field-name literal: a `$$`/`$$$.<coll>` stream is always a stream of documents, which has no scalar identity to collapse by (grouping a whole document would emit `$toString`-on-object MQL the server rejects — HR3).

**Predicate bodies use JS truthy/falsy semantics.** The `cond` (or inner `$map` body for `.some`/`.every`) on `.filter`, `.find`, `.findIndex`, `.findLast`, `.findLastIndex`, `.some`, and `.every` is wrapped via `jsBoolIfNeeded` so that `arr.filter(x => x.name)` keeps items where `x.name` is truthy under JS rules (drops `null`, `""`, `0`, missing). When the body is already provably bool (`x => x > 0`, `x => Boolean(x)`, etc.) the wrap is elided and the cheap form ships through. See [grammar.md](grammar.md#js-truthyfalsy-semantics-for---boolean-predicate-methods) for the full ruleset and the helpers in `src/codegen.ts`.

### Callback parameters: `(element, index, array)`

JS array-method callbacks receive `(element, index, array)`. jsmql supports all three. They are shared across `.map`, `.filter`, `.find`, `.findLast`, `.some`, `.every`, `.flatMap` via the `arrayIterInput()` helper in `codegen.ts` (`.findIndex`/`.findLastIndex` keep their own inline 2-param path).

- **`array` (3rd param)** is the iterated array itself — i.e. this method's *input* (`genObj`). It's bound to that input and typed as an array, so `arr.length` lowers to a clean `$size` (and `generateLengthAccess` honours the array-typed `ParamRef`). Strict-JS semantics fall out of "the input": in a `.filter(...).map((el,i,arr)=>…)` chain, `genObj` for the `.map` is the `.filter` result, so `arr` is the post-filter array — exactly as in JS.
- **`index` (2nd param) is lazy.** The `$zip`/`$range` pairing is emitted **only when the index is actually referenced** anywhere in the body (a complete `someExpr` walk from `ast-walk.ts`). When it isn't — including the common `(el, i, arr) => …arr…` case where `i` is only there positionally to reach `arr` — the plain `$map`/`$filter` is used and the array param (if any) is bound with a thin `$let`. `arrayIterInput` returns a `paired` flag so `.filter`/`.find`/`.findLast` know whether to project elements back out of `[index, element]` pairs.

**On a stream (`$$$.<coll>` lookup chain / `$$ =` chain), the 3rd param is different.** A lookup-chain `.map((o, _i, coll) => …)` is a per-doc transform *inside* the `$lookup.pipeline`, not an in-document array `$map` — so `coll` is the foreign **sub-stream**, not a materialised array. There, `coll.length` is the sub-stream's document count: `MAP.lower` (stream-methods.ts) prepends `streamLengthStage()` (the `$setWindowFields` `$count`) and binds `coll` via `GenerateCtx.substreamLengthHandles`, which `generateLengthAccess` resolves to `"$__jsmql.length"` (checked **before** the array-typed `$size` branch — the handle isn't a bound `$$`-variable). **Only `.length`** is available on this handle (no indexing/iteration — there's no array), and the **index** param is never available (no per-doc stream index); both are permanent rejections. See [stream-length.md](stream-length.md) § Sub-stream length.

**Simple form** (index unused): `as` is the element name and the body's `$$<name>` is bound directly by `$map`/`$filter`; an `array` param adds `{ $let: { vars: { [arrName]: <input> }, in: <body> } }`.

**Paired form** (index used):

- `input` becomes `{ $zip: { inputs: [{ $range: [0, { $size: expr }] }, expr] } }` (an array of `[index, element]` pairs).
- `as` becomes a synthetic name `jsmqlPair` so it never collides with a user-named param.
- The body is wrapped in `{ $let: { vars: { [elemName]: $arrayElemAt($$jsmqlPair, 1), [idxName]: $arrayElemAt($$jsmqlPair, 0)[, [arrName]: <input>] }, in: <body> } }` so the user's names resolve via the standard `lambdaParams` path.

Per-method shape under the paired form:

| Method | 2-param shape |
|---|---|
| `.map` | `$map` over `$zip`, body wrapped. Cardinality unchanged. |
| `.some` / `.every` | `$anyElementTrue` / `$allElementsTrue` of `$map` over the zip. |
| `.filter` | `$map($filter($zip, wrapped cond), pair => $arrayElemAt(pair, 1))` — filter pairs, then project back to elements. |
| `.find` / `.findLast` | `$arrayElemAt: [$arrayElemAt: [$filter(zip, wrapped cond), 0 \| -1], 1]` — outer extracts the element from the matching pair. |
| `.flatMap` | `$reduce` over `$map($zip, wrapped body)` concatenating each per-pair output. |

`.findIndex` / `.findLastIndex` always emit the zipped `$reduce` regardless of param count. When `params[1]` is present, the `$let.vars` inside also binds `params[1]` to `$arrayElemAt($$this, 0)` (the index).

`.reduce` / `.reduceRight` accept 2 or 3 params: `(acc, x[, i])`. With 3 params, `input` becomes the zipped `$range × expr` (for `.reduceRight`, `$reverseArray` wraps the zip so indices reflect the original array). The accumulator still rides through `reduceRemap` (`acc` → `$$value`); the element and index come from a `$let` wrap that rebinds `params[1]` to `$arrayElemAt($$this, 1)` and `params[2]` to `$arrayElemAt($$this, 0)`.

### Block-body arrows (→ nested `$let`)

A lambda body may be an **expression block** — `(x) => { const a = …; const b = f(a); return g(a, b); }` — anywhere a lambda is accepted as a value: the array methods above, `$let(vars, fn)`, the IIFE `(…)=>…)(…)` form, `Object.groupBy`, and `Array.from`'s map function. The parser represents it as an `ExprBlock` AST node (`{ decls: LetDecl[]; ret: Expr }`) on the `Lambda` — distinct from the lookup-callback `block: Pipeline` (whose statements are stages/update ops, lowered to a `$lookup` sub-pipeline).

`generateExprBlock` (`codegen.ts`) lowers a **non-constant** declaration to a `$let` binding; a declaration whose initialiser is a **compile-time constant** folds instead (its value inlined, no `$let` — see [const-folding.md](const-folding.md)). The runtime bindings form a **right-folded nest of `$let`** — one binding per non-folded declaration, in source order:

```
{ const a = A; const b = B; return R; }
→ { $let: { vars: { a: A }, in: { $let: { vars: { b: B }, in: R } } } }
```

One `$let` per decl (rather than a single shared `vars` block) is required because MongoDB's `$let.vars` are mutually invisible — a later var cannot read an earlier one. Nesting puts each prior decl in scope (as `$$name`) for the next decl's initialiser and for the `return`. Variable names are added to `lambdaParams` via `extendCtx` and emitted/referenced through `safeVarName`, so the binding key and every `$$name` reference always agree (incl. the `v`-prefix rewrite for non-`[a-z]`-leading names). This is a **faithful 1:1 lowering** of the user's `const`/`let` bindings — every binding becomes exactly one `$let`, deterministically; it is not the rejected "$let-as-optimisation" (no dependency analysis, no value-preserving rewrite the compiler chose).

The consumer sites use two helpers: `genLambdaBody(lambda, ctx)` (generates the body — expression or expr-block) and `lambdaResult(lambda)` (the expression whose value the lambda yields — the bare body or the block's `ret` — used for static type inference: `jsBoolIfNeeded` on predicate methods, the object/array narrowing in `.reduce`, the string check in `Object.groupBy`). For a predicate method the `jsBoolIfNeeded` truthiness wrap is applied around the whole `$let` (which evaluates to `ret`), so `arr.filter(x => { const ok = x.active; return ok; })` keeps JS truthy/falsy semantics.

**Disambiguation (JS-faithful).** `=> {` always opens a block; an object return needs `=> ({ … })`. `parseExprBlockBody` requires the block to be `(const|let <name> = <expr>;)* return <expr>;` — a bare `=> { k: v }` is a labeled-statement block in JS, so jsmql rejects it (no `return`) and points at `=> ({ k: v })`. Re-declaring a name in one block, or a block with no `return`, are rejected with actionable errors. The lookup-callback positions (`$$$.<coll>.find/filter`, `$$.filter`) keep their statement-block grammar via a `blockKind: "pipeline" | "expr"` flag threaded from the method-call dispatch (`"expr"` is the default everywhere else). `.toSorted`/`.sort` key functions still reject any block body — their structural path needs a bare `x => x.field` expression.

### Mutators at statement position

The in-place JS array mutators — `.sort()`, `.reverse()`, `.push()`, `.pop()`, `.shift()`, `.unshift()`, `.splice()`, `.fill()`, `.copyWithin()` — work at **statement position** on a writable field-path receiver, lowering to a `$set` stage that re-assigns the field. At **expression position** they keep throwing the tailored DX errors (which also mention the statement-position option). `.copyWithin(target, start[, end])` accepts non-negative integer literals (no negative-indexing); the two-arg form treats `end` as the array's `$size` at runtime.

The mechanism is a pre-pass on the statement list:

- `MUTATING_ARRAY_METHODS` in `codegen.ts` lists the eight method names that participate.
- `isWritableFieldPath(expr)` mirrors the parser's `AssignExpr.target` constraint: `FieldRef` with a non-empty path, or a `MemberAccess` chain rooted at one. Bare `$` (path `""`) is excluded because it's `$replaceWith` sugar, not a writable field.
- `tryRewriteMutatorCall(expr)` returns `{ kind: "rewrite", assign }` when both predicates match, where `assign` is a synthetic `AssignExpr { target: <receiver>, value: <immutable RHS> }`. Otherwise `{ kind: "passthrough" }`.
- The immutable RHS is built from existing AST node types, so it flows through normal codegen with no per-mutator branch in the lowering path:
  - `.sort(args)` → `MethodCall(object, "toSorted", args)` (delegates to the existing `.toSorted` case, including the 1-arg key-function form).
  - `.reverse()` → `MethodCall(object, "toReversed", [])`.
  - `.splice(args)` → `MethodCall(object, "toSpliced", args)`.
  - `.push(...items)` → `OperatorCall($concatArrays, [object, ArrayLiteral(items)])`. Items are wrapped in an `ArrayLiteral` because `$concatArrays`-with-`.concat`-semantics would flatten one level, but JS `.push` does not.
  - `.unshift(...items)` → `OperatorCall($concatArrays, [ArrayLiteral(items), object])`.
  - `.pop()` → `OperatorCall($slice, [object, 0, $max(0, $subtract($size(object), 1))])`. The `$max` clamp keeps an empty receiver yielding `[]` instead of an invalid `$slice` length.
  - `.shift()` → `OperatorCall($slice, [object, 1, $size(object)])`.
  - `.fill(v[, s[, e]])` → IIFE binding the normalised start/end once, then `object.map((x, i) => i >= s0 && i < e0 ? v : x)` (built directly in `buildFillRhs()`). Normalisation matches JS semantics (`< 0` ⇒ `max(0, size + n)`, undefined ⇒ default), with a compile-time fast path that inlines non-negative numeric literals.

Hook sites (the pre-pass runs in each):

- `pipeline.ts::generatePipeline` — `[...]` Pipeline literal element loop.
- `pipeline.ts::generateImplicitPipeline` — `;`-separated Pipeline statement loop. Wraps the synthesized `AssignExpr` in a single-op `UpdateFilter` (which is what a bare `$.a = …` statement parses to in this form).
- `index.ts::lowerWithCtx` — top-level dispatcher. When the parsed root is an `Expr` that `tryRewriteMutatorCall` would rewrite, the program is routed through Pipeline mode without requiring a trailing `;`, mirroring the existing auto-wraps for stage calls and `$$.<method>(...)`. **Not** applied in `lowerExprWithCtx` (`jsmql.expr`) — the raw-expression entry point should still surface the mutator throw, since its callers want the bare value-shape building block.

The synthesized `AssignExpr` is indistinguishable from an explicit `$.field = …` by the time it reaches the UpdateOp coalescer, so chained mutators (e.g. `$.events.push(x); $.events.sort(e => e.t);`) interact with read-after-write splitting exactly the same way explicit assignments do.

### Iterator / void / locale methods — DX shims

`.entries()`, `.forEach()`, `.keys()`, `.values()`, `.toLocaleString()` cannot be lowered to any MQL shape (iterators have no representation; `.forEach` returns undefined; locale-dependent output isn't deterministic). Each has an explicit case in the dispatcher that throws a tailored error pointing at the right replacement (e.g. `.entries()` → `.map((v, i) => [i, v])`). All shimmed names appear in `KNOWN_METHODS` so a typo on a different receiver still gets a "did you mean?" suggestion toward them when relevant.

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
| `.getUTCFullYear()` | `{ $year: { date: expr, timezone: "UTC" } }` | UTC-anchored |
| `.getUTCMonth()` | `{ $subtract: [{ $month: { date: expr, timezone: "UTC" } }, 1] }` | UTC, 0-based |
| `.getUTCDate()` | `{ $dayOfMonth: { date: expr, timezone: "UTC" } }` | UTC |
| `.getUTCDay()` | `{ $subtract: [{ $dayOfWeek: { date: expr, timezone: "UTC" } }, 1] }` | UTC, 0-based, Sunday=0 |
| `.getUTCHours()` | `{ $hour: { date: expr, timezone: "UTC" } }` | UTC |
| `.getUTCMinutes()` | `{ $minute: { date: expr, timezone: "UTC" } }` | UTC |
| `.getUTCSeconds()` | `{ $second: { date: expr, timezone: "UTC" } }` | UTC |
| `.getUTCMilliseconds()` | `{ $millisecond: { date: expr, timezone: "UTC" } }` | UTC |
| `.getTime()` | `{ $toLong: expr }` | ms since epoch (matches JS; already UTC, no `getUTCTime`) |
| `.toISOString()` | `{ $dateToString: { date: expr, format: "%Y-%m-%dT%H:%M:%S.%LZ" } }` | |
| `.plus(amount, unit[, tz])` | `{ $dateAdd: { startDate: expr, unit, amount[, timezone] } }` | `unit` enum-checked when a literal |
| `.minus(amount, unit[, tz])` | `{ $dateSubtract: { startDate: expr, unit, amount[, timezone] } }` | `unit` enum-checked when a literal |

`.plus` / `.minus` take Temporal/Luxon's method name with Moment's `(amount, unit)` argument order — the receiver is the `startDate`, `amount` first, `unit` second, and an optional third `timezone`. Argument count is checked by `checkArity` (2 or 3 args); the literal slots are gated to the same shapes the `$dateAdd` / `$dateSubtract` operator path rejects, reusing its own helpers so both spellings error identically: `checkEnum` against `TIME_UNIT` (the shared time-unit enum in `operator-validation.ts`) for `unit`, and `checkArgType` for `amount` (`int-or-long`) and `timezone` (`string`). All three are literal-gated — a field-path or parameter in any slot passes through unchecked.

**Receiver type-check.** Every date method that lowers to a date-requiring operator carries `receiver: "date"` in the `METHODS` registry, and `generateMethodCall` runs `checkArgType(\`.${method}\`, "", <receiver>, "date")` before dispatch — so a literal non-date receiver (`"2020-01-01".getFullYear()`, `"x".plus(1, "day")`) is rejected at compile time with the same wording the operator form gives, while a field ref / `new Date(…)` / param no-ops. `.getTime()` is the one date method **without** `receiver: "date"`: it lowers to `$toLong`, which converts strings/numbers, so a non-date receiver is valid there and must pass through.

## Lambda scoping (`GenerateCtx`)

All codegen functions accept a `GenerateCtx`:

```ts
type GenerateCtx = {
  lambdaParams: ReadonlySet<string>;
  reduceRemap?: ReadonlyMap<string, string>;
  bindingTypes?: ReadonlyMap<string, "object" | "array">;
};
```

When a lambda is processed, its parameters are added to `lambdaParams` via `extendCtx(ctx, params)`. Inside the lambda body:
- `ParamRef("x")` → `"$$x"` (if `x ∈ lambdaParams`)
- `MemberAccess(ParamRef("x"), "status")` → `"$$x.status"` via `asFieldPath()`

`bindingTypes` holds the static type (`"object" | "array" | "string"`) of selected in-scope bindings: `.reduce()` accumulators (see below), **array-method lambda *element* parameters** typed from the input array's static element type (`arrayElementType` — fed through `elementTypedCtx` for `.map`/`.filter`/`.find`/`.findLast`/`.some`/`.every`/`.flatMap`/`.findIndex`/`.findLastIndex`, and inline for `.reduce`/`.reduceRight`), and pipeline `const` declarations whose initializer has a provable static type (`extendCtxLets` consults `staticBindingType`; `let` is left untracked because a later reassignment could change its type). It is keyed by the user-facing param name (pre-`reduceRemap`) and read by the `IndexAccess` codegen two ways: to skip the runtime `$cond` on `$isArray` when the *receiver*'s type is known, and — when the *key* is a `ParamRef` typed `"string"` — to treat `obj[k]` as a property getter. `extendCtx` and every manual ctx-literal in `codegen.ts` forward the field; `freshSubPipelineCtx` deliberately does **not** (lambda-scoped narrowing must not cross into a sub-pipeline that runs against a different document), but `freshFacetCtx` **does** (the `const` slots persist into facet branches, so their types remain valid).

**Bracket access is raw; dot access is interpreted.** This is a deliberate language rule (see [LANGUAGE.md → Bracket Access](../LANGUAGE.md#bracket-access)). A `MemberAccess` can carry compiler meaning — most notably `.length`, which `generateLengthAccess` folds to the string-or-array length operator. `IndexAccess` never does: the codegen does **not** interpret the key. `$.x["length"]`, `$.x["anything"]`, `$.x[$.dynamic]` are all direct property access. The `IndexAccess` codegen has two short-circuits before its general array-or-object dispatch:

- A string-literal key on the **bare root** (`FieldRef` with `path === ""`) → a plain field reference `` `$${value}` ``. The root document is never an array, so the `$arrayElemAt` branch is dead; this also gives users a way to name fields that aren't bare identifiers (`$["cart.field.length"]` → `"$cart.field.length"`, `$["dash-name"]` → `"$dash-name"`).
- A **provably-string key** (`isStringProducing(idx)` — a string literal, template literal, `.toLowerCase()`-style string-returning method, etc. — or a `ParamRef` typed `"string"` in `bindingTypes`) → `$getField` directly, **even when the receiver is a known array**. A string is never a numeric array index, so the access is unambiguously an object property getter. This is not just an optimisation: `$arrayElemAt` *rejects* a string index at runtime ("second argument must be a numeric value, but is string"), so the old `$isArray`/`$arrayElemAt` dual guard would turn a valid-JS access (`arr["x"]` is a property lookup in JS, e.g. `[1,2]["length"]`) into a server error whenever the value is an array — an HR3 violation. `$getField` on an array input is accepted and yields missing, the faithful lowering.

Everything else (`$.items[0]`, `$.cart.field[$.mainSide]`) takes the general dispatch: known-array receiver → `$arrayElemAt`; a **structurally- or binding-typed object** receiver → `$getField`; otherwise the runtime `$cond` on `$isArray`. A *structural* object is one provably never an array — the bare root document (`$` → `$$ROOT`, always a BSON object) or an object literal — so a computed key on it (`$[$.k]`, `$[SSTM_PROP[party]]`, `({a:1})[$.k]`) skips the dispatch and lowers straight to `$getField`, not a `$cond` whose dead `$arrayElemAt` branch would carry a string field name as an array index (rejected at *pipeline-optimization* time — "$arrayElemAt's second argument must be a numeric value, but is string" — on engines that don't prune unreachable branches; an HR3 violation that only surfaces on some servers). Notably there is **no** `["length"]` special case — `$.field["length"]` reads a property called "length" (now via `$getField`, since `"length"` is a string key), it does not compute a size.

## `reduce` parameter remapping

MongoDB's `$reduce` uses fixed variable names `$$value` (accumulator) and `$$this` (current element). The user's parameter names are remapped via `ctx.reduceRemap`:

```
.reduce((acc, x) => acc + x, 0)
→ reduceRemap: { acc → "value", x → "this" }
→ body generates: { $add: ["$$value", "$$this"] }
```

The remap is applied in both `_generate(ParamRef, ctx)` and `asFieldPath(ParamRef, ctx)` — so `o.price` in a reduce body generates `"$$this.price"` when `o` is the element parameter.

### Accumulator type narrowing

Alongside the remap, reduce-codegen also pins the accumulator parameter's static type in `ctx.bindingTypes` when both the `initialValue` and the lambda body are statically the same compound type:

- `isObjectProducing(initialValue) && isObjectProducing(body)` → `params[0]` tagged `"object"`
- `isArrayProducing(initialValue) && isArrayProducing(body)` → `params[0]` tagged `"array"`
- otherwise → no narrowing; any prior `bindingTypes` entry for the same name is **explicitly deleted** so a nested reduce that reuses the name shadows the outer narrowing rather than inheriting it stale.

Both sides must agree because `$$value` after iteration `i ≥ 1` is the body's return from iteration `i-1`, not the `initialValue` — narrowing on the initial alone is unsound the moment the body returns a different shape. `isObjectProducing(expr)` is `expr.type === "ObjectLiteral"` (covers `{}`, `{ ...acc, [k]: v }`, and every other object-literal shape); `isArrayProducing(expr)` is the same predicate the IndexAccess case already uses.

The IndexAccess case below consumes this to skip the runtime dispatch for `acc[k]` inside the body.

## `$let` with lambda — special intercept

`$let(varsObject, lambda)` is intercepted in `generateOperatorCall` before the registry shape dispatch. This is necessary because the registry shape for `$let` is `obj("vars", "in")`, which doesn't know how to handle a `Lambda` node as the second positional argument.

The intercept:
1. Validates that args[0] is an `ObjectLiteral`
2. Extracts the lambda params and body (an expression body **or** an expr-block — see [Block-body arrows](#block-body-arrows--nested-let); only the lookup `block: Pipeline` form is rejected here)
3. Generates `vars` in the current ctx (vars are bound, not yet in scope)
4. Generates `in` via `genLambdaBody` in an extended ctx with the lambda params added

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

## Type-aware dispatch for `.includes` / `.indexOf` / `.concat`

These three methods exist on both strings and arrays in JS but compile to different MQL operators. Codegen consults `isArrayProducing(expr)` and `isStringProducing(expr)`:

- **Known array** receiver → array form (`$in`, `$indexOfArray`, `$concatArrays`).
- **Known string** receiver → string form (`$indexOfCP`, `$gte/$indexOfCP`, `$concat`).
- **Unknown** receiver (bare `FieldRef`, ternary, etc.) → emit a runtime `$cond` on `$isArray` whose branches are the two forms above. The receiver expression is reused in all three positions; for field paths this is free, and for sub-expressions MongoDB's `$cond` is short-circuit so only the chosen branch runs.

The unknown-receiver path is intentionally verbose. When the user knows the type at design time, they can pin it by chaining a type-fixing method (e.g. `.toLowerCase()` for strings, `.slice()` for arrays) or by switching to the operator form (`$in`, `$indexOfArray`, `$concatArrays`).

The `ARRAY_RETURNING_METHODS` and `ARRAY_OUTPUT_OPS` sets in `codegen.ts` drive the detection. Adding a new array-producing method requires updating both sets.

Spread args are handled identically across the array and string branches in `.concat`: `args.map(a => a.type === "SpreadElement" ? gen(a.argument) : gen(a))`.

**Predicate (lambda) arg is rejected with a redirect.** `.includes()` / `.indexOf()` search for a *value*, never a predicate (this is faithful JS — `[].includes(fn)` checks function identity, not a test). Passing a lambda is the classic "I meant the predicate sibling" slip, so `rejectPredicateOnValueSearch(arg, method, sibling)` in `codegen.ts` intercepts it before the generic `Lambda` rejection and points at the right method — `.some` for `.includes` (both bool), `.findIndex` for `.indexOf` (both index) — echoing the user's own param name (`use .some(sc => …)`). The generic `case "Lambda"` message is the fallback for every other misuse and names the iterating methods (`.map`/`.filter`/`.some`/…) that *do* take a callback.

## Template literals

`TemplateLiteral` is an AST node with `quasis: string[]` and `expressions: Expr[]`, where `quasis.length === expressions.length + 1`. Codegen emits `$concat` over the interleaved chunks and expressions. Empty quasis are skipped to keep the output tidy.

Each interpolated expression is wrapped with `$toString` unless `isStringProducing(expr)` returns true. This matches JS template-literal coercion semantics — `` `n=${$.n}` `` works whether `$.n` is a number, boolean, or string at runtime. Expressions that are statically known to produce strings (string literals, nested templates, methods like `.toLowerCase()`, `String()` casts, the `+` operator in string context, `typeof`, and operators in `STRING_OUTPUT_OPS`) skip the wrap. `$toString` is a no-op on strings, so the wrap is purely an output-size optimisation.

A template literal is always string-producing — it counts in the string-context `+` chain detection.

## Optional chaining

`?.` produces the same AST node shapes as `.`, but the parser sets
`optional: true` on the `MemberAccess` / `IndexAccess` / `MethodCall` node it
consumes. Codegen consults that flag (and walks the chain to check earlier
links) to wrap the chain's result with `$ifNull(v, neutral)` at every
null-unsafe consumer site, where `neutral` is the empty value matching the
consumer:

- `[]` for array consumers
- `""` for string consumers
- `{}` for object consumers

Helpers (see `src/codegen.ts`):

- `chainHasOptional(expr)` walks `MemberAccess.object` / `IndexAccess.object`
  links looking for any `optional: true` flag. It **does not** descend through
  `MethodCall` — once a method has been called the value is whatever the
  method returned, not the original optional chain. The walker also does not
  enter lambda bodies, binary operands, method arguments, or
  `IndexAccess.index`.
- `wrapIfNull(value, fallback)` returns `{ $ifNull: [value, fallback] }`.
- `neutralForMethod(method, object)` picks the right fallback for the method's
  underlying operator: `""` for known string methods, `[]` for known array
  methods, and for the "either" methods (`indexOf`, `includes`, `concat`) `""`
  when the receiver is `isStringProducing` else `[]` (which works for both
  the static array form and the runtime `$cond` dispatch, since `$isArray([])`
  routes to the array branch).

Consumer sites that apply the wrap:

| Site | `src/codegen.ts` location | Fallback |
|---|---|---|
| Array spread | `generateArrayLiteral` | `[]` |
| Method receiver (array / string / either) | `generateMethodCall`, before the switch | `[]` / `""` / type-dependent |
| `.length` on optional | `_generate` `MemberAccess` branch | `""` (string) / `[]` (array or unknown) |
| `$getField` for non-foldable `MemberAccess` | same branch | `{}` |
| `IndexAccess` (`obj[k]`, `obj?.[k]`) | `_generate` `IndexAccess` branch | `[]` |
| String `+` operands lowered to `$concat` | `generateAdd` | `""` |
| Template literal interpolation (`$concat`) | `generateTemplateLiteral` | `""` (before `$toString`) |
| `Object.keys` / `.values` / `.entries` arg | `generateObjectCall` | `{}` |
| `Object.fromEntries` arg | same | `[]` |
| `new Set(...)` arg (receiver or method arg) | `generateSetMethodCall` | `[]` |

Sites that deliberately do **not** wrap (already null-safe):

- Object spread — `$mergeObjects` ignores null operands.
- Comparisons (`$eq` / `$ne` / `$lt` / `$gt` / `$lte` / `$gte`) — accept null cleanly.
- `&&` / `||` / `$cond` condition — null is falsy.
- `$in` first arg — searching for null in an array is a defined operation.
- Numeric arithmetic — `$add` / `$subtract` / `$multiply` / `$divide` / `$mod` / `$pow` return null on null operand, matching JS's `NaN` behaviour better than a `0` fallback would.

`?.[expr]` produces an `IndexAccess` node with `optional: true`, so the
receiver-type dispatch (below) applies with the wrap already in place.

## Type-aware dispatch for `IndexAccess` (`obj[k]` and `obj?.[k]`)

JS bracket access serves two purposes that compile to different MQL operators: array indexing (`$arrayElemAt`) and object dynamic-key lookup (`$getField`). Codegen resolves the receiver type from `isArrayProducing(expr.object)`, then structural-object detection (`isObjectProducing(expr.object)` or the bare root — `FieldRef` with `path === ""`), then `ctx.bindingTypes` (when the receiver is a `ParamRef`), and independently asks whether the **key** is provably a string. Dispatch, in order:

- **Provably-string key** (`keyIsString`: `isStringProducing(idx)`, or `idx` is a `ParamRef` typed `"string"` in `bindingTypes`) → `{ $getField: { field: idx, input: obj } }` directly, **regardless of receiver type** (a string is never a numeric index). Optional-chain fallback: `{}`. This branch is checked first precisely so it overrides a known-array receiver — `$arrayElemAt` rejects a string index at runtime, while `$getField` on an array input is accepted (yields missing), matching JS property-lookup semantics.
- **Known object** receiver — an object literal (`isObjectProducing`), the **bare root** (`FieldRef` with `path === ""`, always a BSON object), or `bindingTypes` says `"object"` → `{ $getField: { field: idx, input: obj } }`; **optional-chain fallback is `{}`** (feeding `$getField` an array on null receivers would be a type error in MongoDB). The two *structural* cases are provably never arrays, so this fires for **any** key — that is what keeps a computed key on the root (`$[$.k]`, `$[SSTM_PROP[party]]`) or an object literal (`({a:1})[$.k]`) off the `$cond` guard and out of the dead `$arrayElemAt`-with-string-index trap (which a non-pruning optimizer rejects at pipeline-optimization time).
- **Known array** receiver (`isArrayProducing` true, or `bindingTypes` says `"array"`) → `{ $arrayElemAt: [obj, idx] }`. Optional-chain fallback: `[]`.
- **Unknown** receiver + non-string key (bare `FieldRef`, ternary, etc.) → runtime `$cond` on `$isArray` between `$arrayElemAt` (array branch) and `$getField` (object branch). Both branches reuse the same `obj` expression; for paths this is free, and `$cond` is short-circuit so only the chosen branch executes. Optional-chain fallback: `[]` (the array branch handles empties cleanly).

The key-is-string check beats the receiver type because a string key can only mean property access (never an array index), and the runtime guard would otherwise emit a server-rejected `$arrayElemAt`-with-string shape. For a *numeric* index there is no such shortcut — the receiver type alone drives the decision. If a user wants compact output for `$.field[0]`, they can use `.at(0)` (always emits `$arrayElemAt`) or pin the receiver type with `.map(x => x)` / `.slice(0)` / `.reverse()`. Inside a `.reduce()` body, the accumulator parameter is narrowed automatically when initialValue and body agree on a compound type — see the reduce parameter-remapping section above.

### Lambda element-type inference

A lambda parameter is a *variable*, so `keyIsString` / the receiver-type checks only fire for it when its type is recorded in `bindingTypes`. Array-method lambdas now type their **element** parameter from the input array's static element type, so `element[k]` (element as key *or* receiver) lowers as precisely as a literal would — the win that turns `["sender","recipient"].map(party => $.cre.result[party])` into a direct `$getField` instead of the `$isArray` guard (whose dead `$arrayElemAt`-with-string-index branch some servers reject — the same trap as the bare-root case).

- `arrayElementType(expr)` returns the **uniform** static element type of an array-valued expression, or `undefined`: an `ArrayLiteral` whose every element shares one `staticBindingType` (`["a","b"]` → `"string"`, `[{},{}]` → `"object"`, `[[1],[2]]` → `"array"`; mixed / empty / spread-bearing → `undefined`); `String.prototype.split` and `Object.keys` → `"string"`. Anything else (a bare field path, `.map`-of-mixed, a numeric array) → `undefined`, leaving the runtime guard in place — so the inference only ever *removes* a guard it can prove redundant, never changes a genuinely-ambiguous one.
- `elementTypedCtx(ctx, params, inputExpr)` is `extendCtx` plus: type `params[0]` (the element) to that element type, and **clear** every lambda param name from `bindingTypes` first so a param shadowing an outer same-named binding can't inherit the stale type. The index param (`params[1]`) is a number, so it is only ever cleared, never typed. Used by `arrayIterInput` (covers `.map`/`.filter`/`.find`/`.findLast`/`.some`/`.every`/`.flatMap`) and the `.findIndex`/`.findLastIndex` case; `.reduce`/`.reduceRight` apply the same element-typing inline (its element is `params[1]`, since `params[0]` is the accumulator).

## Set-receiver methods (ES2025)

When the receiver is a `NewSet` AST node (`new Set(arr)`), method dispatch is intercepted at the top of `generateMethodCall` and routed to `generateSetMethodCall`. The wrapper is unwrapped to its underlying array; the method's argument must itself be a `NewSet` and is also unwrapped.

| Method | MQL output |
|---|---|
| `.intersection(new Set(other))` | `{ $setIntersection: [arr, other] }` |
| `.union(new Set(other))` | `{ $setUnion: [arr, other] }` |
| `.difference(new Set(other))` | `{ $setDifference: [arr, other] }` |
| `.isSubsetOf(new Set(other))` | `{ $setIsSubset: [arr, other] }` |
| `.isSupersetOf(new Set(other))` | `{ $setIsSubset: [other, arr] }` (operands swapped to reuse `$setIsSubset`) |
| `.symmetricDifference` / `.isDisjointFrom` | rejected with a clear error — no MongoDB equivalent (compose manually via `$setDifference` + `$setUnion`) |

## Regex-receiver methods

When the receiver is a `RegexLiteral`, method dispatch is intercepted and routed to `generateRegexMethodCall`. `.test(str)` → `$regexMatch`; `.exec(str)` → `$regexFind`. The pattern and flags from the regex literal are emitted directly into the operator's `regex` and `options` fields. `RegexLiteral` as a standalone primary expression is parsed via the existing context-sensitive `/`-vs-divide lexer logic; appearing as a method receiver requires no new lexer state.

## Object literals with computed or special entries

`generateObjectLiteral(entries, ctx)` is the entry point for object literals as values. If any entry has a computed key, it emits via `$arrayToObject` over a list of `{ k, v }` object pairs — wrapped one level deeper as `{ $arrayToObject: [pairs] }` (see `arrayToObjectOfLiteralPairs` in codegen.ts) so MongoDB reads the pairs array as the single argument rather than an argument list (a bare `{ $arrayToObject: [{k,v}] }` is server-rejected — unwrapped to the object, "requires an array input"). The `{ k, v }` object form is one nesting level shallower than the `[k, v]` array form and is unambiguous when a value is itself an array. Otherwise it falls through to the static-key fast path. `generateStaticObjectEntries` is used for operator-style argument objects (`{ input, find, replacement }`) where keys are part of the wire format.

The split between the two helpers is enforced inside `generateOperatorCall`: when an operator's registered shape is `object`, the static helper is used (and computed keys are rejected); otherwise the value helper is used.

## Spread

`SpreadElement` appears in three positions, each with its own codegen helper. They all share the same target operator (`$concatArrays` for arrays, `$mergeObjects` for objects) but differ in how they group consecutive non-spread elements.

### Call args

`SpreadElement` is valid in call arg lists (`OperatorCall`, `MethodCall`, `MathCall`, `ObjectCall`). The `CallArg = Expr | SpreadElement` type is used for those arg arrays. `generateVariadicArgs(args, ctx)` decides between:

1. No spread → flat array of generated values
2. Single `...arg` → bare value
3. Mixed → `{ $concatArrays: [...] }` with each non-spread arg wrapped in its own 1-element array

`assertNoSpread()` is called in non-variadic operator paths (single/object/none shapes) to surface a clear error.

### Array literals

`generateArrayLiteral(elements, ctx)` handles `ArrayLiteral` AST nodes. It uses the same `$concatArrays` target as the call-arg helper, but **groups consecutive non-spread elements into a single literal-array operand** rather than wrapping each individually. So `[1, 2, ...$.arr, 3]` lowers to `{ $concatArrays: [[1, 2], "$arr", [3]] }`, not `{ $concatArrays: [[1], [2], "$arr", [3]] }`. A lone `[...x]` returns `x` directly. The two helpers are kept separate (call-arg wrapping vs. array-literal grouping) intentionally — call args are usually short and per-arg wrapping reads more cleanly there, while array literals can be long and benefit from tighter output.

### Object literals

`generateObjectLiteral(entries, ctx)` follows the same shape as the array-literal helper but targets `$mergeObjects`. Consecutive non-spread entries group into one operand (a static or `$arrayToObject` block depending on whether any keys are computed), each `...expr` becomes its own operand, and a lone `{...x}` returns `x` directly.
