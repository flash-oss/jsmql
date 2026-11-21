# 0077. How the registry type-level audits stay sound

Status: Accepted
Applies to: `src/registry/names.ts`, `src/registry/productions.ts`, `src/registry/tokens.ts`

## Context

Each registry file ends with type-level audits over its own cross-references. The audits run in the type checker. A type-level audit can pass silently and test nothing. It does this in three ways:

- A union never matches an object pattern on its own.
- `never extends readonly (infer V)[]` resolves `V` to `unknown`.
- A field that is not threaded through a `const` generic collapses to its constraint.

## Decision

- Every generic of a row constructor defaults to the EMPTY type. It never defaults to its constraint. (`root`, `name`, `mongo`, `global_`, `production`, `token`, the `ProductionSpec` generics `C`, `M`, `L`, `A`) defaults to the EMPTY type (`never` or `readonly never[]`), and never to its constraint. Otherwise a row with no `forbiddenIn`, `after` or `closes` widens the generic to `readonly string[]` (or `string`). The union of the audit then holds every string, and the audit passes with no test. The generic carries the literal, so the audit reads it.
- The `T` parameter of `name` carries the `immutableTwin` literal out to the audit. On the spec alone it widens to `string`. The audit would then read `string` from every row and could never name the row at fault.
- `ListedCells` maps each listed position to `unknown`. It gives no contextual type to a cell. It only makes the key required (`-?`), and `MongoSpec` types the cell.
- An audit over a cell first applies `Extract`, because the declared type of a cell is a union. A match against the union gives `never` for every row.
- An audit then guards `never` BEFORE the inference. One `unknown` in the union makes the audit accept anything. The `onlyInside` audit (`ContainersOf`) needs BOTH guards, because a row with no `onlyInside` reaches an empty object whose value type is `never`. A bogus container name makes the audit fail, which confirms this.
- The `immutableTwin` audit exists because a twin is a NAME that the desugar pass rewrites to. A typo makes the mutator silently impossible to rewrite, and not a failure.
- `productions.ts` has NO audit over `tokens`. The constraint `T extends readonly Lexeme[]` on the row applies the rule better, and the error lands on the row that breaks it. An audit cannot work there. When a literal breaks the constraint, TypeScript instantiates `T` with the constraint. Then `Mentioned<"tokens">` gives `Lexeme`, and the audit reads `never`. MEASURED: a false lexeme gives exactly one error, at the row. `after` needs its audit, because `A extends readonly string[]` applies no such constraint.

## Consequences

A new generic on a constructor must default to the empty type. A new audit must keep the `Extract` step and the `never` guard. The contracts fixture that proves each audit can fail is in `src/registry/CLAUDE.md` § The types hold the rules.
