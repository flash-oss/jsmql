# 0023. Small value-road decisions in lower.ts for literals, guards and update keys

Status: Accepted
Applies to: `src/compiler/emit/lower.ts`

## Context

`lowerValue` in `src/compiler/emit/lower.ts` builds the MQL of literals, spreads and `?.` reads. The project wants the smallest document that keeps the meaning. Some shapes depend on the position and on facts that the server measures.

## Decision

- `positionIn(env)` answers the position of the Env. When phase 4 named a waypoint, `positionOf` gives null, and `positionIn` answers `value`. The reason: a raw `{ $op: … }` in a value slot is a document.
- `ifNull(v, neutral)` builds `{ $ifNull: [v, neutral] }`. When `v` is the `{ $ifNull: [x, null] }` of a bare `?.` read, it builds one wrap `{ $ifNull: [x, neutral] }`. The value is the same, and the document has no layer that says nothing.
- Each truth test answers a missing value as it answers null. So `nullPassing` clears the `?.` of a read whose consumer is a truth test or `== null`. The read then runs as a plain read, with no `{ $ifNull: [x, null] }`.
- An array spread follows HR5: a missing array spreads as the empty one. `[...$.a, 1]` is `[1]` when `a` is not there. `$concatArrays` answers null for a null operand. The mutator templates (`.pop()`, `.fill()`) spread the receiver into a `$size`, and `$size` aborts on a missing value. So `arrayLiteral` wraps a spread operand in `ifNull(v, [])` when its proof is `absent`. A value that the proof shows present takes no wrap. The list that the desugar pass PACKS from the spread arguments of a call (`$op(...$.a)`, `packed: true`) is the operand list of the operator itself. It is raw MQL under HR2, so it takes no wrap.
- In an update document (position `updateDoc`), an object key that starts with `$` is the cell of that operator, for example `{ $each: [...], $slice: -3 }` under `$push`. `objectLiteral` lowers the key and its value as an `OperatorCall`, and merges the result into the host document.

## Consequences

- A change to the `?.` lowering must keep the single-wrap merge in `ifNull`.
- A change to the mutator templates must keep the empty-array wrap, or `$size` aborts.
- A packed spread list must stay unwrapped, because HR2 passes raw MQL as written.
