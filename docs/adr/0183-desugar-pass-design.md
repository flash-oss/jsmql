# 0183. One source-to-source pass removes every sugar before lowering, and carries the position with each node

Status: Accepted
Applies to: `src/compiler/passes/desugar.ts`, `src/compiler/passes/desugar-rules.ts`, `src/compiler/passes/walk.ts` (`mapTreeIn`), `src/compiler/passes/position.ts`

## Context

A sugar is a construct that means another construct that the language already has. JSMQL assembles stages from more than one place. Some sugars mean one thing as a statement, and the compiler refuses them everywhere else. `docs/specs/desugar-pass.md` states the rules of the pass.

## Decision

- One pass rewrites every sugar, source to source, before any lowering runs. If a lowering loop must recognise a sugar, a loop that does not know a form lowers it wrong, with no refusal. After the pass, no sugar remains for a loop to miss.
- The position arrives with the node. `mapTreeIn` carries it down the tree, and `passes/position.ts` states it at each parent-to-property step. So phase 4 runs inside phase 3, and also after it. One tree shape can have two meanings: `$.items.sort();` is a write, and the compiler refuses the same call in a value. A rewrite that does not know the position turns the value form into a nested assignment, and loses the message of the row.
- The position is not a set of nodes that a rule looks up by identity. The walk rebuilds a parent as soon as one of its children changes. So the object that a rule holds is not the object that an earlier step recorded.
- The iteratee shorthands rewrite in this pass, not inside each lowering. Two lowerings of one meaning can disagree. A lowering of `$.items.some({ active: true })` on its own gives an `$expr` with `$anyElementTrue` over `$map`, where the arrow gives `$elemMatch`. On a document whose `items` is a string, the `$expr` form fails the query, and the `$elemMatch` form answers it. The `$expr` form also cannot use an index. With the rewrite first, the lowering sees one shape.
- `iterateeShorthand` reads the receiver family off the chain, never off the position of the call. A read off the position gives two answers for one link.
- The driver has no round limit. A chain of declarations, where each one needs the previous one folded, advances one link for each round. A developer may write as many links as they like. So a limit cannot tell a cycle from real progress. The driver finds a cycle as a tree that it already saw, with the positions erased.

## Consequences

A new sugar is a rule in the pass, not a branch in a lowering. A rule that needs the position reads it from `mapTreeIn`, never from a table of node objects. A cycle between two rules is an internal error, not a time-out.
