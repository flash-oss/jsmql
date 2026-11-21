# 0112. The iteratee-slots suite re-measures each declared slot form

Status: Accepted
Applies to: `test/iteratee-slots.test.ts`

## Context

A row's `iterateeSlots` states which argument slots stand for an arrow, on which receiver family, and with which shorthand spellings. The claim has value only when a test checks it.

## Decision

`test/iteratee-slots.test.ts` compiles each declared form and the arrow that it means, and it checks that the compiler refuses each form that a slot leaves out.
- The comparison erases binding names first (`test/support/canon.ts`). Two spellings of one meaning differ only in the names of the compiler's own `$let` variables and `$map` `as` names.
- On a stream, `takeWhile` and `dropWhile` keep a leading or trailing run, so the source sorts the stream first. A row that reads the element (`elementOnlyOf`) needs an unwound field to read.
- A family that the row refuses in value position takes no callback, so it states no iteratee layout. The `Object` family of `groupBy` exists only so that `Object.groupBy(…)` gets a message that names the receiver form.
- No static is a JSMQL name inside a callback. So a bare callable reads as its arrow, and the row of the static refuses it.
- A sort key string is an ORDER, not the property path `x => x.k`. It has the same spelling with a different meaning. So `sortSpec` is its own state, not a slot form. The other sort forms that a row takes belong to that row's arity and to `src/compiler/emit/sort-spec.ts`. A mutator is a statement, so the suite compiles it in statement position.

## Consequences

A new row with an iteratee slot needs no extra test, because the suite checks it. A new slot form needs an entry in `SPELLINGS` with the arrow that it means.
