# 0185. The position pass answers on the way down, and a target is not a value

Status: Accepted
Applies to: `src/compiler/passes/position.ts` (`edge`, `mapTreeIn`), `namesSomething` in `src/compiler/passes/naming.ts`

## Context

The position pass tells each node where it stands. The walk that carries the pass also rewrites the tree. A walk that rewrites rebuilds a parent as soon as one of its children changes. Some nodes, for example the left of `=`, the operand of `delete` and the callee of a call, hold no value.

## Decision

- The pass answers on the way DOWN. `edge` gives the position of a child on one parent-to-property step, and `mapTreeIn` carries it forward. The alternative was a set of nodes looked up by identity. The developer rejected it, because when a rule runs, the object that it holds is no longer the object that anyone recorded.
- `target` is an answer of its own, not `value`. JSMQL does not evaluate a target. If the pass called a target a value, a rule meant for an expression could fire on the destination of a write. The fold could also fold `f` away in `f(1)` to give `3(1)`.

## Consequences

A rule reads the position from the walk, never from a record of nodes. A new construct that names a place to write or a thing to call takes `target`. The fold and the position pass share one predicate for this, so they cannot disagree.
