# 0091. The TypeExpr grammar and the callback parameter kinds

Status: Accepted
Applies to: `src/registry/vocabulary.ts`

## Context

A row must state the type of its result. The compiler, the server tests and the globals generator all read that type. Each parameter of a callback also needs a meaning per row.

## Decision

- `TypeExpr` is a closed grammar of data terms, not a function. A test can measure each term on mongod, the registry audits can read it, and the globals generator can turn it into a TypeScript signature. A function would allow none of the three. The terms are in [types.md § A row's `returns`](../specs/types.md#a-rows-returns).
- The per-family map uses `Family` as its key, which has `array` and `object` members. So the element form of a term is `arrayOf` and the record form is `recordOf`, and no key collides.
- `ParamKind`: names follow JavaScript and lodash. `Array.map` gives `(value, index, array)`, `Array.reduce` gives `(accumulator, value, index, array)`, and lodash `mapValues` gives `(value, key, object)`. The last parameter is the receiver itself, so the list calls it `receiver`. `accumulator` becomes MongoDB's fixed `$$value`. Two `value` parameters make a comparator. A read of `index` changes what the operator walks (the `[i, x]` pairs). `binding` is a variable declared in a sibling argument: in `$let({ x: 1, y: 2 }, (p, q) => p + q)`, `p` binds `x`; its arity comes from that sibling, and `elementsCallback` counts it there.
- `CallbackParams`: one written shape means three things, and only the row says which: in `.map((x, i) => …)` `x` is the element, in `.reduce((x, i) => …, 0)` `x` is the accumulator, and in `.mapValues((x, i) => …)` `x` is the value. Without this field the compiler would need a hard-coded name list. The list is PER POSITION where the answer differs: `$.a.toSorted(d => d.x)` is a key function, and `$$ = $$.toSorted((a, b) => a.n - b.n)` needs a comparator. A list can be SHORTER than the API it names, on purpose, and each refusal names the parameter it drops (`.reduce` takes at most `(acc, element, index)`). `.filter` takes the index, and `.reject` does not.

## Consequences

A new term or parameter kind needs a measurement in `test/compiler-returns-agrees.test.ts` and a case in the globals generator.
