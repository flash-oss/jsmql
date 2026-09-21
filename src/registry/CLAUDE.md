# src/registry/

This is the single source of truth that the compiler in `src/compiler/` reads.
There are four registries, one per compiler phase, written in one shared
vocabulary. The header of [vocabulary.ts](vocabulary.ts) names each file, its
key space and its job. Nothing here builds MQL for a construct that needs its
neighbours. A row says what the language has (see `src/compiler/CLAUDE.md`).

## Rules

- **The registry imports nothing from outside this directory.** The registry
  is data. A row that reaches into the compiler closes a cycle and then
  initialises after the code that reads it.
- **Every fact is stated, never derived.** A phase might compute a fact from
  other fields, but the registry still writes it down, so a reader sees it and
  a test can check it. `bodyPositions`, `returns`, `document`, `binds` and `alsoTypes` are
  all measured on a running `mongod`, and the `// MEASURED:` comment beside
  each one shows the command and the answer.
- **One fact, one field.** Two features with different names never share an
  array or a flag. `stream` and `statement` are two cells. `group` and
  `window` are two cells. `TIME_UNIT` and `WINDOW_TIME_UNIT` are two
  constants. Every pair that once shared a field turned out to hold opposite
  answers.
- **A human can read the registry.** Repetition is fine. An abstraction that
  hides which rows state which facts is not fine.
- **A refusal names the alternative.** The `unsupported("…")` text tells the
  developer what to write instead, in JSMQL terms. A method row or global row
  may add an `updateDoc` cell for this reason alone. The update document holds
  constants only, so this cell is always a refusal. A row adds this cell when
  the general sentence for the position (`NO_CELL` in
  `src/compiler/emit/errors.ts`) cannot name the row's own alternative — for
  example `new Date()` → `$currentDate`.

## The types hold the rules, and each check must fail once

The vocabulary's types hold the rules. `where` and the cells cannot disagree
(`Cell`/`Lists`). A filter renderer may answer null only where a value form
exists (`FilterOut`). The type decides whether a receiver has an unprovable
family: every row with two or more field families states this decision
(`Uncertain`), and no row with only one field family states it. An
argument-shape dispatch is a keyed partition with its leftover stated
(`ByArgs`). Each file ends with type-level audits over its own
cross-references.

A type-level audit earns trust only after it has failed once. It can pass
silently in three ways. A union never matches an object pattern. `never
extends readonly (infer V)[]` resolves to `unknown`. A field not threaded
through a `const` generic collapses to its constraint. So every rule stands
twice in [test/types/registry-contracts.ts](../../test/types/registry-contracts.ts):
one value that must compile, and one value under `@ts-expect-error` that must
not compile. Add a pair there whenever you add a rule. `test/registry-agrees.test.ts`
holds the cross-references no type can hold — a field's presence checked
against another field's content. `test/compiler-returns-agrees.test.ts` and
`test/compiler-accumulator-agrees.test.ts` hold the facts only a server can
confirm.

## Where to add X

- **A name** (`.foo()`, `$foo`, `Foo`, `$`) needs one row in `names.ts`,
  through the constructor for its kind (`name`, `mongo`, `global_`, `root`).
  Fill every cell. When a position's `where` omits a cell, that cell still
  says why.
- **A construct** (an operator spelling, a statement form) needs a row in
  `productions.ts`. Its lexemes are keys of `tokens.ts` and `keywords.ts`.
- **A new fact about rows** needs a field on the spec type. Give it a doc
  comment that shows the measured case. Add the type that holds its rule, a
  `@ts-expect-error` pair in the contracts fixture, and the rows that state
  the fact. Never add it as a list in the compiler.
- **A new position** needs changes in several places. Add it to `Position`
  and `OutOf` in `src/registry/vocabulary.ts`. Add it to `CELL_OF` in
  `src/compiler/emit/consult.ts`. Add a cell for it on every spec type
  (`names.ts`, `productions.ts`). Add it to the constants and to `edge()` in
  `passes/position.ts`. Add the root facts for it in `emit/env.ts`: which
  roots are pipelines, and where an injected `$…` value is literal. The
  position tests each hold their own list of the seven positions. Extend
  each one.
