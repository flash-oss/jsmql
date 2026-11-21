# 0066. Pure MQL builders in src/registry/mql.ts and the server facts they obey

Status: Accepted
Applies to: `src/registry/mql.ts`, `src/registry/names.ts`

## Context

The method cells in names.ts share small MQL shapes. The registry must stay a leaf, and many shapes depend on measured server behaviour.

## Decision

General rules:
- Each builder takes lowered operands, or a source node that it only reads, and returns a document. No builder reads a registry row or a compiler service. A builder folds a constant when it can (`strLenOf("ab")` is 2, `foldedSubtract(5, 2)` is 3). A constant that stays a constant lets a later `$substrCP` take a plain number.
- MongoDB reserves no field names, so `__proto__` is ordinary data. JavaScript misbehaves with it in these ways. `out[name] = v` writes the prototype slot, so the field disappears. `out[name]` reads a method of `Object.prototype` for names such as `constructor`. `name in out` is true for those names, so a duplicate guard refuses a valid program. A plain object used as a set has the same defect. `setKey` uses `Object.defineProperty` for writes. For the other cases, use a `Map` or a `Set`. `Object.fromEntries` and object spread are already safe.
- `cond` is the one spelling of a condition, in the short array form. A constant test emits its branch alone.
- The lowering of a string method follows lodash: `ASCII_WORDS_RE` is the lodash ASCII word boundary, and `HTML_ESCAPE_PAIRS` keeps the lodash order, with `&` first.
- `regexBody` lowers the pattern only when it is not a regex literal, because a regex literal has no value outside the regex string operators. `mongoRegexOptions` keeps `i`, `m`, `s` and `x`; `g` and `y` have no MongoDB meaning.
- `dateOptions` reads a bare string as the timezone, and a document as named options. The row rule checks the keys and types first, so the function only reads. `dateFromParts` adds one to the month, because JavaScript counts months from 0 and MongoDB from 1. The emitter folds that step for a literal month.
- `isSingleCodePointLiteral` exists because a pad of one character repeats cleanly.
Measured server facts:
- `isNullish` is `{ $lte: [v, null] }`. Null sorts below every value except `MinKey`. MEASURED: it is true for a missing value and for null, and false for `0`, `""`, `false`, `[]` and `{}`. `isNotNullish` is `{ $gt: [v, null] }`, measured on the same values.
- `$strLenCP` refuses null, so `strLenOf` wraps a value in `$ifNull` to `""` unless the caller knows that it is present. `$substrCP` reads null as `""` (MEASURED: `{ $substrCP: [null, 1, 2] }` is `""`). So `substrOperand` removes the HR5 wrap there, and a `$strLenCP` beside it keeps the wrap.
- `SORT_KEY_LIMIT` is 32. MEASURED on the project server: 32 keys run and 33 keys fail in the `$sort` stage, in `$setWindowFields.sortBy`, and in `$top`, `$topN`, `$bottom` and `$bottomN` (group and window forms). `$sortArray.sortBy` and the `$sort` modifier of an update `$push` run with 33 keys, so they state no limit.
- The server reads `{ $size: [1, 2] }` as two operands and `{ $size: [[1, 2]] }` as one. `singleArrayArg` wraps an array literal one level deeper. The conversion and type-test cells use it for the same reason.
- `sizeOf` counts an array literal at compile time. MEASURED: `{ $size: [["$nope", "$x"]] }` is 2, because a missing field is still an element.
- `slotAggregate`: in an accumulator slot (a `$group` output, a `$setWindowFields.output` entry), the receiver is the operand (`$.a.sum()` gives `{ $sum: "$a" }`). The slot reads an array-literal operand as an operand list. MEASURED: a `$group` slot refuses it, and a window slot answers 0. So `perDocument` reduces the array on each document first: `[$.n, $.m].sum()` gives `{ $sum: { $sum: ["$n", "$m"] } }`, and `[$.n, $.m].first()` gives `{ $first: { $first: [["$n", "$m"]] } }`.
- `propertyKeyExpr` is `{ $toString: { $ifNull: [key, ""] } }`. JavaScript turns a computed key into a string, and the server refuses a key of another kind. A null or missing key becomes `""`, the name that `o[k]` reads. MEASURED: the server refuses an int key and a null key. `pairsToObject` uses `$toString` on each pair key for the same reason. Its `in` body reads the default `$$this`, because the body is fixed text and holds no expression of the developer.
- `joinedWith` starts the `$reduce` at null, not at `""`. With `""`, the reduce cannot tell "no element yet" from "empty result", and MEASURED `["", "a"].join(",")` then gives `"a"` where JavaScript gives `",a"`. A null or missing element becomes `""` (`[1, null, 2].join(",")` is `"1,,2"`), because `$toString` and `$concat` answer null for null. `$ifNull` turns the null of an empty array into `""`. That also covers a null or missing receiver.
- `atPrecision`: only `$round` takes a precision. So `.ceil(p)` and `.floor(p)` multiply by 10^p, round, and divide back. MEASURED on 1.234: ceil(2) is 1.24, floor(2) is 1.23, and ceil(2) of -1.234 is -1.23, as in JavaScript. A constant precision folds, because MEASURED `{ $pow: [10, p] }` equals `10 ** p` for -7 ≤ p ≤ 15.
- `cbrt` keeps the sign with `$cmp`, because `$pow` of a negative base to a fractional exponent is NaN on the server.
- `isFiniteNumber` tests `$toString` against the NaN and infinity texts, because the server holds NaN equal to itself.

## Consequences

A builder must not import a row or a compiler service. A new builder that writes a developer-chosen key must use `setKey`. A change to any measured shape needs a new run on the project's mongod.
