# Changelog

All notable changes to the public mjsql API are recorded here. The public API is `mjsql()`, `validate()`, and the `mql` template tag — see `docs/LANGUAGE.md` for the user-facing reference.

## Unreleased

### Added — modern JavaScript syntax and built-ins

- **Template literals.** Backtick strings with `${expr}` interpolation compile to `$concat`. Templates nest, support escape sequences (`\\`, `` \` ``, `\$`, `\n`, `\t`, `\r`), and participate in string-context `+` chains.
- **Optional chaining.** `?.`, `?.[index]`, and `?.()` after method calls. Compiles identically to `.` because MongoDB's dotted-path traversal already null-passes through missing fields.
- **Numeric separators.** `1_000_000`, `1_234.567_89`, `1_2e3`. Underscores are stripped at lex time. Leading, trailing, and doubled `_` are rejected.
- **Computed object keys.** `{ [$.k]: 1 }` compiles via `$arrayToObject`. Mixes with literal keys.
- **Shorthand object properties.** `{ x }` is sugar for `{ x: x }` inside lambda scope.
- **Spread in call arguments.** `Math.max(...$.scores)`, `Object.assign(...$.docs)`, `$concatArrays(...$.arrs)`. Mixed spread+scalar args wrap into `$concatArrays`.
- **String methods:** `.startsWith(s)`, `.endsWith(s)`, `.charAt(i)`.
- **Array methods:** `.includes(x)`, `.indexOf(x)`, `.concat(...args)` (type-aware vs. string), `.join(sep?)`, `.flat()` / `.flat(1)`, `.flatMap(fn)`.
- **Date methods/statics:** `.getTime()`, `.toISOString()`, `Date.now()`.
- **Math methods:** `Math.min`, `Math.max`, `Math.sign`, `Math.log2`, `Math.log10`, `Math.cbrt`, `Math.hypot`, `Math.random`.
- **Math constants:** `Math.PI`, `Math.E`.
- **Array static:** `Array.isArray(x)`.
- **Object static:** `Object.fromEntries(arr)`.

### Changed

- `.includes()`, `.indexOf()`, and `.concat()` are now type-aware. When the receiver is statically known to be an array (array literal, `.split()` result, `.map()` result, etc.) they emit the array-typed MQL form (`$in`, `$indexOfArray`, `$concatArrays`). For string and unknown-type receivers, they emit the previous string-typed form unchanged.
- Object-style operator calls are now routed by the operator's registered shape: only operators with `object` shape (e.g. `$trim`, `$dateAdd`) require literal key names. For any other operator (or unknown), a single `{...}` argument is treated as a value and may use computed keys, spread, etc.
- `.length` on a known array-producing receiver was already documented; it now also recognises `Object.keys()` and `Object.values()` outputs as arrays.
- Template-literal interpolations are now wrapped with `$toString` unless the expression is statically known to produce a string. Matches JS coercion — `` `n=${$.n}` `` works for numeric or boolean fields without manual casting. Output is unchanged for string-producing interpolations.

### Notes on backwards-compatibility

All v3 expressions continue to compile to identical MQL. The only place to verify if you were relying on edge behaviour:

- `$.field.includes(needle)` still emits the string form (`$gte`/`$indexOfCP`). If you want array semantics on a bare field reference, use `$in($.field, needle)` explicitly.
- Object literals with a single entry passed to a non-object-shape operator previously also went through the strict-key path — this never had a user-visible reason to reject computed keys, so widening it is non-breaking in practice.
- Template literals previously emitted bare interpolated expressions — `` `n=${$.n}` `` produced `{$concat:["n=","$n"]}`. The new output wraps non-string-producing expressions with `$toString`. The old output errored at MongoDB runtime when the field wasn't already a string, so this is closer to a fix than a behaviour change.
