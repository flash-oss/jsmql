# 0128. Registry and AST audits read the source and fail in both directions

Status: Accepted
Applies to: `test/registry-fields-read.test.ts`, `test/registry-slot-kinds.test.ts`, `test/support/ast-nodes.ts`, `test/types/registry-contracts.ts`

## Context

The registry states its rules as fields and as types. A field that no compiler line reads is decoration: a row author trusts it, and nothing enforces it. A type-level check that never fails proves nothing. Vitest strips types, so a type annotation inside a suite checks nothing.

## Decision

`test/registry-fields-read.test.ts` checks that each field of `Arity` and `BodyRule` has a reader in `src/compiler`. `fieldsOf` reads the field list from the type body in `src/registry/vocabulary.ts`: each top-level ` name:` or ` name?:` line. The test does not copy the list, so a new field joins the check. A read is a property access (`args.slotType`, `rule?.enums`, `x[0].exact`). The character before the dot must be a word character, `$`, `]` or `)`, so a spread (`...spread`) does not count as a read.

`test/registry-slot-kinds.test.ts` holds HR7 for the registry as a whole. Each slot that a rule admits has an entry in `slotType`, or `rest` covers it. A slot that takes every kind states `"any"`, so "not typed" stays distinct from "takes every kind". The audit walks the rows of the kinds `name`, `global` and `root`, and every row of `PRODUCTIONS`. It skips `$op` rows, because a `$op(…)` call is the developer's own MQL, and HR7 does not judge it. It reads each `args` rule in a cell, and beneath `perFamily` and `byArgs`. It reports every untyped slot in one list.

`test/support/ast-nodes.ts` lists every node type of `src/registry/ast.ts` as a value. `tsc` checks the file through `test/types/tsconfig.ast.json`, and `test/compiler-ast.test.ts` runs that check. A node that the list omits, or a key that `ast.ts` does not hold, fails the compile. One `@ts-expect-error` line names a type that is not a node, so the file also proves that `tsc` reads it.

In `test/types/registry-contracts.ts`, a `byArgs` cell may state a rule for its `constant` class. The compiler may lower a constant (for example `Number("3")` converts on the server and gives a double) or refuse it.

## Consequences

A new field on `Arity` or `BodyRule` needs a reader in `src/compiler` before the suite passes. A new AST node needs an entry in `ast-nodes.ts`. A new registry kind that is JavaScript code must join the slot-kind walk. Keep every type rule as a pair: one value that compiles, one under `@ts-expect-error`.
