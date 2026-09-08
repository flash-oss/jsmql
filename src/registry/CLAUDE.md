# src/registry/

The single source of truth the compiler in `src/compiler/` reads. Four
registries, one per compiler phase, written in one shared vocabulary — the
header of [vocabulary.ts](vocabulary.ts) names each file, its key space and its
job. Nothing here builds MQL for a construct that needs its neighbours: a row
says what the language HAS (see `src/compiler/CLAUDE.md`).

## Rules

- **Imports nothing from outside this directory.** The registry is data. A row
  that reaches into the compiler closes a cycle and initialises after the code
  that reads it.
- **Every fact is STATED, never derived.** If a phase could compute it from
  other fields, it is still written down, so a reader sees it and a test can
  hold it. `bodyPositions`, `returns`, `binds`, `alsoTypes` are all measured on
  a running `mongod` and the `// MEASURED:` comment beside each shows the
  command and the answer.
- **One fact, one field.** Two differently-named features never share an array
  or a flag. `stream` and `statement` are two cells; `group` and `window` are
  two cells; `TIME_UNIT` and `WINDOW_TIME_UNIT` are two constants. Every pair
  that ever shared a field turned out to hold opposite answers.
- **Readable by a human.** Repetition is fine; a clever abstraction that hides
  which rows say what is not.
- **A refusal carries the alternative.** `unsupported("…")` text tells the
  developer what to write instead, in JSMQL terms.

## The types ARE the audit — and each audit is made to fail

The vocabulary's types hold the rules: `where` and the cells cannot disagree
(`Cell`/`Lists`), a filter renderer may answer null only where a value form
exists (`FilterOut`), a receiver of unprovable family is decided on every row
with two or more field families and on no row with one (`Uncertain`), an
argument-shape dispatch is a keyed partition with its leftover stated
(`ByArgs`). Each file ends with type-level audits over its own cross-references.

A type-level audit is trusted only once it has been seen to fail. Three ways it
passes silently: a union never matches an object pattern; `never extends readonly
(infer V)[]` resolves to `unknown`; a field not threaded through a `const`
generic collapses to its constraint. So every rule stands twice in
[test/types/registry-contracts.ts](../../test/types/registry-contracts.ts) — a
value that must compile and one under `@ts-expect-error` that must not. Add a
pair there whenever you add a rule. The cross-references no type can hold
(a field's presence against another's content) live in
`test/registry-agrees.test.ts`; the facts only a server can confirm in
`test/compiler-returns-agrees.test.ts` and `test/compiler-accumulator-agrees.test.ts`.

## Where to add X

- **A name** (`.foo()`, `$foo`, `Foo`, `$`) — one row in `names.ts` through the
  constructor for its kind (`name`, `mongo`, `global_`, `root`). Fill every cell;
  a position `where` omits still says why in its cell.
- **A construct** (an operator spelling, a statement form) — a row in
  `productions.ts`; its lexemes are keys of `tokens.ts` / `keywords.ts`.
- **A new fact about rows** — a field on the spec type with a doc comment that
  shows the measured case, the type that holds its rule, a `@ts-expect-error`
  pair in the contracts fixture, and the rows that state it. Never a list in the
  compiler.
- **A new position** — `Position` and `OutOf` in `src/registry/vocabulary.ts`,
  `CELL_OF` in `src/compiler/emit/consult.ts`, a cell on every spec type (`names.ts`,
  `productions.ts`), the constants and `edge()` in `passes/position.ts`, the root
  facts in `emit/env.ts` (which roots are pipelines, where an injected `$…` is
  literal), and the `CELL_OF` copy in `scripts/diff-compilers.mjs`. The position
  tests each hold their own list of the seven; extend them.
