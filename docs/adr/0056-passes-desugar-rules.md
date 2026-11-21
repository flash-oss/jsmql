# 0056. Invariants of the desugar rules that the desugar spec does not state

Status: Accepted
Applies to: `src/compiler/passes/desugar-rules.ts`

## Context

`src/compiler/passes/desugar-rules.ts` holds the rewrites that docs/specs/desugar-pass.md describes. Some rules depend on facts about the walk, the AST and the positions of writes that the spec does not state.

## Decision

- A rule never recurses. `mapTree` rewrites the children first, so the node that a rule sees is as reduced as it can get.
- `COMPOUND` comes from `ASSIGN_OPS` in src/registry/ast.ts. Every compound operator is a binary operator and `=`. So the table is that list without `=` and the two increments. A hand-written copy makes a third table of assignment spellings.
- A write in an update document (`where.at === "updateDoc"`) is a field of the document, spelled as it stands. `compoundAssign` and `incDec` leave it alone.
- A collection (`$$$.<coll>`, `$$$$.<db>.<coll>`) is not a scalar, so `+=` on it is not arithmetic. It names the stage that adds to the collection, where `=` replaces it. The emit phase reads the spelling, so `writesACollection` makes the rewrite leave it alone. The parser refuses an arithmetic write on `$` and `$$` before this pass runs, because the rewrite turns `$ += 1` into the valid-looking `$ = $ + 1`.
- A rewrite that puts the target in two slots gives each slot a fresh copy. The walk in walk.ts compares nodes by identity to know what changed, so no node object may sit in two slots. `writeBack` follows the same rule.
- `writeBack` marks a mutator's own write with `mutates`, because JavaScript allows a mutator call on a `const` binding.
- `incDec`: prefix and postfix give the same MQL, because a write in a statement has no value in MQL. The parser stores a placeholder copy of the target in `value`. The rule overwrites it and never reads it.
- A `$`-led segment is never a path segment. MQL paths cannot hold one, and the spelling belongs to the chained stage call (`.$match(…)`). `fieldPath` also skips a name that `isFieldProperty` reports.
- `mutatorTwin` writes the source name in `wrote`, so a later refusal names `.reverse()`, not its twin.
- `instantiate` places every node that the write form adds at the statement's position. A substituted subtree keeps its own position.
- In `iterateeShorthand`, a method that runs as another row on a stream (`.find` as `filter`, `picksOneOf`) takes the shorthands of that row. A value terminal on a stream chain (`$$$.c.filter(p).maxBy("total")`) has no stream layout. It reads the joined documents as an array, so the array family's layout applies.

## Consequences

A new rule must not recurse and must not share a node object between two slots. A new compound operator needs only a new entry in `ASSIGN_OPS`. A rewrite of a write must keep the update-document and collection exceptions.
