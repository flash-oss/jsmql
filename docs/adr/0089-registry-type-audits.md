# 0089. How the registry type-level audits stay sound

Status: Accepted
Applies to: `src/registry/names.ts`, `src/registry/productions.ts`, `src/registry/tokens.ts`

## Context

Each registry file ends with type-level audits over its own cross-references (`src/registry/names.ts`, `productions.ts`, `tokens.ts`). A type-level audit can pass silently and test nothing.

## Decision

- Every generic of a row constructor (`production`, `token`, the `ProductionSpec` generics `C`, `M`, `L`, `A`) defaults to the EMPTY type (`never` or `readonly never[]`), and never to its constraint. Otherwise a row with no `after` (or no `closes`) widens the generic to `readonly string[]` (or `string`). The union of the audit then holds every string, and the audit passes with no test. The generic carries the literal, so the audit reads it.
- An audit over a cell first applies `Extract`, because the declared type of a cell is a union, and a union never matches an object pattern on its own. A match against the union gives `never` for every row.
- An audit then guards `never` BEFORE the inference. `never extends readonly (infer V)[]` succeeds with `V = unknown`, and one `unknown` in the union makes the audit accept anything. The `onlyInside` audit (`ContainersOf`) needs BOTH guards, because a row with no `onlyInside` reaches an empty object whose value type is `never`. A bogus container name makes the audit fail, which confirms this.
- The `immutableTwin` audit exists because a twin is a NAME that the desugar pass rewrites to. A typo makes the mutator silently impossible to rewrite, and not a failure.
- `productions.ts` has NO audit over `tokens`. The constraint `T extends readonly Lexeme[]` on the row applies the rule better, and the error lands on the row that breaks it. An audit cannot work there. When a literal breaks the constraint, TypeScript instantiates `T` with the constraint. Then `Mentioned<"tokens">` gives `Lexeme`, and the audit reads `never`. MEASURED: a false lexeme gives exactly one error, at the row. `after` needs its audit, because `A extends readonly string[]` applies no such constraint.

## Consequences

A new audit must keep the empty default, the `Extract` step and the `never` guard. Each audit needs a pair in `test/types/registry-contracts.ts` that proves it fails once.
