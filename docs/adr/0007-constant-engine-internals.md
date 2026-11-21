# 0007. Small decisions inside the constant engine (evaluate.ts, date-literal.ts)

Status: Accepted
Applies to: `src/compiler/passes/evaluate.ts`, `src/compiler/passes/date-literal.ts`

## Context

The constant engine in `src/compiler/passes/evaluate.ts` gives the value of a closed expression. It lowers the expression with the emitter and gives the MQL to the interpreter. Some inputs need a rule that the general steps do not state. The spec `docs/specs/constant-engine.md` owns the general steps.

A date literal is a date that the source spells with literal parts: `Date(0)`, `Date("2026-01-01")`, `Date(2026, 1, 1)` and `Date.UTC(2026, 1, 1)`. The server cannot compute some of these. `{ $toDate: 0 }` fails there, because the driver sends a small integer as an int. So the lowering of `Date(0)` has no value that the interpreter can give.

## Decision

- A declared function goes into the environment inside a wrapper, `DeclaredFunction` (`asDeclaredFunction`). A function has no MongoDB literal. A substitution of a function into the tree puts a lambda where an expression must stand. The wrapper makes sure that no reader takes it for a value. So `fold` keeps a declared function in `env`, and keeps it out of the substitution map (`folded`). The fold can evaluate a call to one, but never substitutes the function itself into the tree.
- `withinSize` refuses a folded string or array longer than `MAX_SIZE`. A call such as `"x".padStart(500000000)` computes in a millisecond and gives half a gigabyte of text. That text goes into the AST, then into the document, and then past the 16 MB BSON limit. Such a value is not a useful constant, so it stays a runtime expression.
- `read` gives the value of `-<BigInt literal>` (for example `-5n`) directly, as a negative BigInt. The lowering of that node multiplies a Long by -1, and the interpreter keeps a Long opaque and does not compute with it. So the general path cannot settle it.
- The scan in `readsMoreThanConstants` accepts a declaration inside the block of a callback (`ExprBlock`). There, each declaration is a value, not a statement. A declaration in any other place refuses the subtree.

The date-literal reader (`readDateLiteral` in `src/compiler/passes/date-literal.ts`):
- `evaluate` reads a date literal from its source parts before it lowers anything, because the server cannot compute some of these dates. `settle` also replaces such a date inside the subtree with its value before the lowering.
- `Date()` with no argument reads the clock, so it is never a constant.
- The reader declines a fraction of milliseconds and an unparsable string. It does not refuse them itself. The row of `Date` raises those errors with a position.
- A name that the program binds is no global, so the reader declines it (`isBound`).
- `Date.UTC(…)` reads ONE number as a year, where `Date(n)` reads it as milliseconds. The reader sends `Date.UTC` through the parts form, so the two spellings cannot disagree.
- The parts form counts months from zero, as JavaScript does, and rolls an out-of-range part over. The runtime cell adds one for `$dateFromParts`, which counts from one and rolls over in the same way.

## Consequences

A change to the interpreter that adds Long arithmetic can remove the special case for `-<BigInt literal>`. A change must keep declared functions out of the substitution map. A change must keep the size cap, or the compiler can build a document that BSON cannot hold.

A new date spelling must reach the reader through the parts form or the millisecond form. Each refusal of a bad literal stays on the row, so it keeps a position. See docs/specs/constant-engine.md and docs/LANGUAGE.md for the user-facing date rules.
