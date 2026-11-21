# 0010. The verdict model of consult.ts

Status: Accepted
Applies to: `src/compiler/emit/consult.ts`

## Context

`src/compiler/emit/consult.ts` answers what a row says about one name in one position. Every phase that touches a name asks it first. The module builds no document.

## Decision

- `consult` gives one of a closed set of verdicts. All but `lower` are final with no lowering. So the refusal surface of the language works before any lowering exists.
- `ROWS` merges `NAMES` and `PRODUCTIONS`. A NAME is an identifier the source writes (`sort`, `Math`, `$inc`). A PRODUCTION is a construct (`%`, `===`, `?:`). Both carry the same cells, so a caller never needs to know the source registry. The keys cannot collide, because a production has a descriptive key (`remainder`, never `"%"`), and no row of `names.ts` uses such a key.
- `CELL_OF` maps a position to its cell. The cell `expr` answers the position `value`; the other names match. `positionOf` reads `CELL_OF` and not a hand-written switch. A switch answers only for the positions it lists, and it drops each new position with no error. `target`, `stageBody` and `stageEntry` are waypoints, not positions.
- A `refused` verdict carries `needsSubject` when the row holds only the reason, because one reason serves every spelling. `refusalSentence` adds the subject, which is how the source spelled the call. Only the caller knows that spelling.
- A `perFamily` verdict is not an error. It comes back when the caller gave no receiver family, or a family the row does not list. A caller that cannot prove the family runs the one lowering family of the row.
- `noCell` is not a refusal. For example, only a MongoDB row has an `updateDoc` cell, because only a MongoDB operator is specific to an update document. `$.views++` is a statement, and the choice between `$inc` and `$set` belongs to the whole program.
- `inCode` names a pass that owns the node. The pass already rewrote the node or left it. A caller reads such a node the way the other cells of the row describe.
- `everyName` lists names only, for `didYouMean`. A production is a construct, and a user cannot misspell it.
- `everyMethodName` leaves out a global (`Number`), a static of a namespace (`Array.isArray`) and a row that refuses in every position. A suggestion must name a method that runs. A renamed row stays, and the suggestion shows its new name through `suggestedAs`.

## Consequences

A new position must get a `CELL_OF` entry. A new production key must not equal a key of `names.ts`. A new verdict kind must keep the rule that only `lower` runs a lowering.
