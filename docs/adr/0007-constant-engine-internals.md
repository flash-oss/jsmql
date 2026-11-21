# 0007. Small decisions inside the constant engine (evaluate.ts)

Status: Accepted
Applies to: `src/compiler/passes/evaluate.ts`

## Context

The constant engine in `src/compiler/passes/evaluate.ts` gives the value of a closed expression. It lowers the expression with the emitter and gives the MQL to the interpreter. Some inputs need a rule that the general steps do not state. The spec `docs/specs/constant-engine.md` owns the general steps.

## Decision

- A declared function goes into the environment inside a wrapper, `DeclaredFunction` (`asDeclaredFunction`). A function has no MongoDB literal. A substitution of a function into the tree puts a lambda where an expression must stand. The wrapper makes sure that no reader takes it for a value. So `fold` keeps a declared function in the environment, and keeps it out of the substitution map.
- `withinSize` refuses a folded string or array longer than `MAX_SIZE`. A call such as `"x".padStart(500000000)` computes in a millisecond and gives half a gigabyte of text. That text goes into the AST, then into the document, and then past the 16 MB BSON limit. Such a value is not a useful constant, so it stays a runtime expression.
- `read` gives the value of `-<BigInt literal>` (for example `-5n`) directly, as a negative BigInt. The lowering of that node multiplies a Long by -1, and the interpreter keeps a Long opaque and does not compute with it. So the general path cannot settle it.
- The scan in `readsMoreThanConstants` accepts a declaration inside the block of a callback (`ExprBlock`). There, each declaration is a value, not a statement. A declaration in any other place refuses the subtree.
- `evaluate` reads a date that the source spells with literal parts (`readDateLiteral`) before it lowers anything. The server cannot compute some of these dates, so the engine must read them itself. `settle` also replaces such a date inside the subtree with its value before the lowering.

## Consequences

A change to the interpreter that adds Long arithmetic can remove the special case for `-<BigInt literal>`. A change must keep declared functions out of the substitution map. A change must keep the size cap, or the compiler can build a document that BSON cannot hold.
