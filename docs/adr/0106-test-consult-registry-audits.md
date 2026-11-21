# 0106. The consult suite audits the whole registry table, and each audit encodes one rule of the rows

Status: Accepted
Applies to: `test/compiler-consult.test.ts`

## Context

`consult` in `src/compiler/emit/consult.ts` answers what a row says about one name in one position. A question to the registry covers every name and every position at once. An example test proves one row. A table test proves the rule. `test/compiler-consult.test.ts` audits every row and every position.

## Decision

- **The subject of a refusal.** A refusal either names its construct, or sets `needsSubject` so the caller adds its own spelling. The alternative is to read the first letter of the message and guess, which is a coupling that nothing declares. This applies to names only. A production has a descriptive key (for example `remainder`, never `"%"`), so its key is not what a user typed.
- **A production key never reaches a user.** The key exists so two rules cannot collide on one symbol. Nobody types a word such as `conditional`, so a message that quotes it is unusable. `everyName()` also leaves out production keys, because a construct is not something a user misspells, so it is never a suggestion.
- **Where a row may have no cell.** A production is never an accumulator, so it has no `group` or `window` cell. Only a MongoDB operator is ever specific to an update document, so neither a production nor a name has an `updateDoc` cell. `$cond` inside `$group` sits in the ARGUMENT of an accumulator, which is value position. A `$op` row has a cell exactly where its `where` lists the position. A call anywhere else is the developer's own MQL, and it takes HR2's plain form.
- **Per-family cells.** `.size()` has a filter cell per receiver family: the array family falls back to a scan, and the stream family refuses. One answer for both would claim the wrong thing. A method with one family, such as `.length()`, has a flat cell, and a family argument does not change it.
- **Compose-only constructs.** `%` alone has no query form, but `$.a % 2 === 0` has one, and the fold belongs to the equality row (`strictEquality`). `consult("remainder", "filter")` answers `composedOnly` with that owner.
- **Not positions.** `positionOf` answers null for an assignment target, because nothing is evaluated on the left of `=`. It answers null for a stage body, because a stage body is on the way to a position.
- **A stage has two spellings.** `$match(<body>);` and `$$ = $$.$match(<body>)` are the same stage. Every row that lists `stream` must also list `statement`. Without `statement`, the row refuses the canonical spelling that every pipeline program in the docs uses. The language accepts both spellings, measured on every stage row.
- **The two stage cells render one document.** Each cell has its own `emit` closure. The test runs both on the same probe bodies. Every service of the context answers with a marker that names the service and its arguments. So a different use of a service gives a different output. `args` compares by value. Every stage row must render at least one probe body, so the test never compares two refusals.
- **Arity agrees with shape.** The row's `shape` governs the cells that put OPERANDS into `{ $name: … }`: `value`, `group`, `window` and `updateDoc`. `stream` and `statement` render a stage BODY, and `$count` shows the difference: `$count("total")` is a stage with one argument, and `$count()` as an accumulator takes none. `filter` renders a query document. An operand that a cell accepts and the shape does not render VANISHES. `$abs($.a, $.b)` would emit `{"$abs":"$a"}`, which is valid MQL and the wrong answer. An object-shaped date operator would emit a shape that mongod refuses outright: `{$dateDiff:"$a"}`, because `$dateDiff` takes only a document.
- **Accumulator slots.** The `single` shape reads `args[0]` and nothing else, so a `group` or `window` cell with that shape must accept exactly one operand. `atLeast` is banned there (see docs/specs/position-pass.md § An accumulator slot takes one operand).
- **Key order.** A row whose cells accept more than one argument must state `keys`. One argument is the object literal itself and needs no key order.
- **`returns`.** A missing `returns` and `returns: "unknown"` mean the same thing to a type check, but different things to a reader. Absent means the name produces no value. `"unknown"` means a value whose type follows the operands. So `returns` is present on exactly the rows whose `where` lists `value`, `group` or `window`. `$push` and `$addToSet` collect their operand, so their element type is `{ arg: 0 }`.

## Consequences

A new row must pass every audit. A new refusal must name its construct or set `needsSubject`. A new stage row lists both `stream` and `statement`. A new shaped cell keeps its arity within what its shape renders.
