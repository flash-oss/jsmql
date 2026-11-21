# 0058. The HR8 check runs on the parsed tree, and leaves two cases to the emit phase

Status: Accepted
Applies to: `src/compiler/passes/no-new.ts`

## Context

HR8 says JSMQL has no `new` keyword (`docs/LANG_RULES.md`). A later pass can fold `new Date("…")` to its value, or prove a type from it. After that, the tree does not show the `new`.

## Decision

`refuseNew` in `src/compiler/passes/no-new.ts` runs on the tree as parsed, before any pass can fold a `new X(…)`. It refuses the first `new` in the source. Two cases wait for the emit phase (`src/compiler/emit/lower.ts`), which owns their answer. The first is a name that the program binds, because only the scope knows what that name holds. The second is a row that every position refuses (for example `Set`), because its own refusal names the JSMQL way.

## Consequences

The check must stay before `fold` and `inject`. A change that moves it later lets a folded `new Date(…)` pass with no error.
