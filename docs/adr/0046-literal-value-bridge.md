# 0046. How a computed or injected value goes back into the tree (literal.ts, inject.ts)

Status: Accepted
Applies to: `src/compiler/passes/inject.ts`, `src/compiler/passes/literal.ts`

## Context

The fold and the inject pass both produce JavaScript values. A later phase reads only a tree. `src/compiler/passes/literal.ts` turns a value into the node that spells it, and `src/compiler/passes/inject.ts` puts call-supplied values into the tree. `docs/specs/constant-engine.md § The write-back` states the general rule.

## Decision

- `isSpellable` is the one test of whether a value has a literal. If arithmetic, a number method and `.sum()` each test it, the answers drift apart. For example, `[1e308, 1e308].sum()` then reaches the driver as `Infinity`, but the compiler refuses `1e308 * 10`. One function removes the question of which policy applies where.
- A literal that `asLiteral` builds takes the position of the reference that it replaces. A folded value has no source of its own, so a later error points at that reference.
- `undefined` is never a folded value. JavaScript gives it for a read that finds nothing, for example `[1,2,3].at(9)`. BSON has no such value: the driver sends it as a hole, so an array element becomes null and an object key disappears. So `asLiteral` gives null, and the read stays a runtime read.
- `leafOf` writes each element of an injected structure. A Date inside `{ startDate, endDate }` becomes an `Injected` leaf, so the keys of the object stay readable (`$dateDiff(${parts})` is the body that it spells). `undefined` stops the structure, and so does a nested structure that `asLiteral` refused.
- A RegExp inside a structure is data that the structure carries. `leafOf` holds it as an `Injected` node, never as a regex literal to evaluate.
- `spellValue` marks a RegExp that the call supplies (`injected` on the `RegexLiteral`). It is the developer's own MongoDB regex. A query slot takes it as written, and a value slot passes it through. A regex that the source spells is a pattern for the regex methods.
- `replaceIdents` keeps the positions of a node from the source. An `Injected` node takes the position of the reference that it replaces.

## Consequences

Every site that asks whether a value has a literal must call `isSpellable` or `asLiteral`. A change that lets `undefined` through puts holes into emitted documents. A change to the RegExp provenance mark changes how a query slot reads a passed regex.
