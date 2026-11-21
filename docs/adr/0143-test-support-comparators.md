# 0143. Test helpers compare answers by meaning, with independent oracles

Status: Accepted
Applies to: `test/stringify.test.ts`, `test/support/canon.ts`, `test/support/set-answer.ts`, `test/truthy.ts`

## Context

Some suites compare two outputs that differ only in a detail that carries no meaning. Others must not build the expected value from the code under test.

## Decision

- `canon` in `test/support/canon.ts` renames each compiler binding by the order of its introduction, because two spellings of one meaning differ only in the binding names. Structure-identical trees introduce bindings in the same order, so the numbers are stable. A sort by name is not stable. The walk is structural, not a string substitution. MongoDB's own variables (for example `$$value`) keep their names. A `{ k, v }` pair inside `$arrayToObject` is data, not a scope.
- `answersSet` in `test/support/set-answer.ts` decides when a server answer has an unspecified order. A set operator (`$setUnion`, `$setIntersection`, `$setDifference`) gives each value once, in an order that MongoDB does not specify. An operator that builds a value from the elements one by one (`$map`, `$filter`, `$arrayToObject`, and similar) keeps that order. A sort removes the order, so `$sortArray` does not carry it. A `$let` gives the answer of its `in`, and `in` may read a variable, so the check reads both. The emitted MQL selects the comparison, not the method name, so a new set method needs no change here.
- `test/truthy.ts` is a second, hand-written implementation of `jsTruthy` in `src/compiler/emit/mode.ts`. A test that builds its expectation from the code under test passes whatever the code emits. The mirror stays one module, so a change to the truthy rule is one edit there and one in the emitter.
- `test/stringify.test.ts` asserts two things for most cases: the printed text, and the round trip. The round trip evaluates the text with the driver's BSON classes in scope, serialises the result to BSON, and compares the bytes with the original. Equal bytes are what "the text rebuilds the document" means.

## Consequences

Never import the emitter's own helper to build an expected value. When a new operator carries element order from its operand, add it to `CARRIES`.
