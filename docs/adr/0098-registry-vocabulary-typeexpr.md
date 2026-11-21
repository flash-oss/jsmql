# 0098. The TypeExpr grammar and the callback parameter kinds

Status: Accepted
Applies to: `src/registry/vocabulary.ts`

## Context

A row states its result type as data, so a test can measure each term on mongod and the globals generator can turn it into a TypeScript signature. Callback parameters need a meaning per row.

## Decision

- `TypeExpr` is a closed grammar that `src/compiler/emit/type.ts` evaluates against the receiver's `Type` and the arguments' types. A row whose result no term describes states `"unknown"`, and a test lists those rows. Terms: a `Kind` (`.trim()` is a string); `"same"` (the receiver's type; a fixed-length array keeps its elements, not its positions); `"element"` (one element: `.head()`, `.max()`); `"unknown"`; `{ arrayOf: T }` (`.keys()`); `{ elementOf: T }` (one element of T when T is an array, else T: what `.flatMap` keeps of a callback's answer); `{ callback: n }` (`.map(f)` is `{ arrayOf: { callback: 0 } }`); `{ arg: n }` (`$ifNull(a, b)`); `{ args: n }` (every argument from n on, only inside `merge` and `oneOf`); `{ merge: [...] }` (`.assign(o)`, a later term wins); `{ oneOf: [...] }` (`.reduce(f, seed)`); `{ recordOf: T }` (`.groupBy(k)`); `{ tuple: [...] }` (`.entries()` pairs); `{ itemOf: [T, n] }` (`.fromEntries()`); `"picked"` and `"omitted"` (the receiver's props kept or dropped by the first argument's names); and a per-family map (`.filter` on an array is an array, on a stream a stream). The per-family map is keyed by `Family`, which has `array` and `object` members, so the element form is `arrayOf` and the record form is `recordOf`.
- `ParamKind`: names follow JavaScript and lodash. `Array.map` gives `(value, index, array)`, `Array.reduce` gives `(accumulator, value, index, array)`, and lodash `mapValues` gives `(value, key, object)`. The last parameter is the receiver itself, so the list calls it `receiver`. `accumulator` becomes MongoDB's fixed `$$value`. Two `value` parameters make a comparator. A read of `index` changes what the operator walks (the `[i, x]` pairs). `binding` is a variable declared in a sibling argument: in `$let({ x: 1, y: 2 }, (p, q) => p + q)`, `p` binds `x`; its arity comes from that sibling, and `elementsCallback` counts it there.
- `CallbackParams`: one written shape means three things, and only the row says which: in `.map((x, i) => …)` `x` is the element, in `.reduce((x, i) => …, 0)` `x` is the accumulator, and in `.mapValues((x, i) => …)` `x` is the value. Without this field the compiler would need a hard-coded name list. The list is PER POSITION where the answer differs: `$.a.toSorted(d => d.x)` is a key function, and `$$ = $$.toSorted((a, b) => a.n - b.n)` needs a comparator. A list can be SHORTER than the API it names, on purpose, and each refusal names the parameter it drops (`.reduce` takes at most `(acc, element, index)`). `.filter` takes the index, and `.reject` does not.

## Consequences

A new term or parameter kind needs a measurement in `test/compiler-returns-agrees.test.ts` and a case in the globals generator.
