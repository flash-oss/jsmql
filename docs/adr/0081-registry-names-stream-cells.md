# 0081. Decisions in the stream cells of the array methods

Status: Accepted
Applies to: `src/registry/names.ts`

## Context

A stream method lowers to stages over the documents of `$$`. A MongoDB stream has no order until a sort gives it one, and the server refuses some stage bodies.

## Decision

- `sort`: the row lists the stream family. A stream has nothing to mutate, and `.sort` and `.toSorted` both reorder the flow.
- `.uniq()`: one document per distinct ELEMENT. The element is the whole document, or the unwound field after `.flatMap`.
- `.uniqBy()` keeps the first document per key, and `.keyBy()` keeps the last. First and last follow the current order of the stream. Sort first when the order matters.
- `.compact()`: the stage drops JavaScript's falsy values. JSMQL has no NaN. MEASURED: `null` in a `$nin` list also drops a missing field.
- `.take(n)`: the server refuses `$limit: 0`. A take of zero emits `{ $match: { $expr: false } }`.
- `.drop(n)`: `$skip: 0` is the identity, so a drop of zero emits no stage.
- `.size()`: the filter cell is per family. The array form scans (`viaFallback`). The stream form does not compile in a filter. One flat `viaFallback` would claim that the stream form only scans.
- `.size()` on an array: lodash's `_.size(undefined)` is 0, so the cell reads a receiver that may be missing as the empty array. An array LITERAL is the value, not an operand list.
- `.takeWhile()` and `.dropWhile()`: the row states `only: ["afterSort"]`. As a chain link the method keeps a RUN of the stream, and a run needs an order. An array in a value slot already has an order. The stage is a `$setWindowFields` over the sorted stream with a `$max` flag. The flag is 0 while every document so far passed, and 1 from the first document that did not. A `$match` on the flag follows.
- `.reject(p)`: the stage is `$match` with `$nor` of the predicate's own clause. This is the complement, as `!p` is.
- `.shuffle()`: a random key per document (`$rand`), a sort by that key, and the chain's own cleanup drops the key.
- `assert(condition[, message])`: the stage is a `$match` whose `$expr` is a `$convert` of `true` to a type name. The name is `"bool"` when the condition holds, and the message when it does not. MEASURED: the server refuses the unknown type name, and its error carries the name. So the message reaches the developer.

## Consequences

A new stream link that needs an order must state `afterSort`. A scratch field that a link adds must sit under the chain's cleanup.
