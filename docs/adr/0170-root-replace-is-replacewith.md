# 0170. `$ = <expr>` lowers to `$replaceWith`, not `$replaceRoot`

Status: Accepted
Applies to: `writeStages` in `src/compiler/emit/statement.ts`, docs/specs/replace-root-stage.md

## Context

MongoDB has two spellings of root replacement: `$replaceWith: <expr>` and `$replaceRoot: { newRoot: <expr> }`. They are exact runtime equivalents on MongoDB 4.2+.

## Decision

The compiler emits `$replaceWith`, because it uses far fewer characters. The cost is the 4.0 and 4.1 server versions. The rest of the language already excludes them, because it relies on 4.2+ features, for example `$function` and `let` on `$lookup`. No option makes `$ = …` lower to the `$replaceRoot` form, because the stage call `$replaceRoot({ newRoot: <expr> })` already gives it.

## Consequences

A developer who needs the `$replaceRoot` form writes the stage call.
