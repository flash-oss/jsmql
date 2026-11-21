# 0180. Only a block-bodied arrow narrows the output type of `jsmql()`

Status: Accepted
Applies to: `JsmqlArrowOutput<F>` in `src/index.ts`, docs/specs/aggregation-stages.md § Public API impact

## Context

`jsmql()` returns `object | object[]`. The type of an arrow input can settle the shape of the output in some cases, and a change can try to narrow more cases.

## Decision

Only a block-bodied arrow narrows to `object[]`, because its arrow type returns `void` and it is always a Pipeline. Every other input keeps the full union, because its type does not settle the shape. An expression-bodied arrow can be a Filter or a Pipeline. An array return type can be a Pipeline or an array-valued Filter, and only a check of the AST separates them. A string and a template tag are opaque. This record states the cases so that a later change does not narrow them by mistake.

## Consequences

A caller who needs a fixed shape uses `jsmql.pipeline` or `jsmql.filter`.
