# 0182. The HR6 check reads the tree as the parser gives it

Status: Accepted
Applies to: `src/compiler/passes/raw-mql.ts`, `lowerMode` in `src/index.ts`, `src/compiler/index.ts`

## Context

The HR6 check finds raw MQL used as an operand of a JSMQL construct. It can run on the parsed tree, or after the passes that change it.

## Decision

The check runs before `inject` and before `fold`.
- A passed value is not source. Before `inject`, a template `${…}` slot or a `jsmql.compile` parameter is still a name. A name is JSMQL, so the check never sees the value, and `` jsmql`${base} && $.qty > 5` `` merges `base` as a query document.
- A later phase moves nodes. `fold` inlines a `const` binding, and a desugar rule rewrites a method to another spelling. After them, the tree no longer shows what the developer wrote.

## Consequences

A new entry must call the check on the parsed tree, before it injects a value or folds a constant.
