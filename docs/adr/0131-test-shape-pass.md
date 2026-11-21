# 0131. How compiler-shape.test.ts checks which document a program becomes

Status: Accepted
Applies to: `test/compiler-shape.test.ts`

## Context

`src/compiler/passes/shape.ts` decides whether a program is a filter or a pipeline. The entries of `src/index.ts` pick their output with this same pass.

## Decision

- The pass asks the row, and stacks no auto-wrap special cases. Each test case states the shape by hand. A comparison with `jsmql(src)` would check the pass against itself.
- The pass reads the shape off the parsed program. An entry picks the desugar root from it. The statement-root desugar turns a lone mutator call into the write that it means.
- At this phase, the destination of a mutator is still a path, one phase before the fold makes it one. So `$.a["b"].push(9)` and `x.sort()` are pipelines.
- A call in the middle of a chain makes a fresh array. A fresh array is a value, however the row reads. A mutator on a value is a filter, not a pipeline. If the pass called these a pipeline, `jsmql.expr` would reach `jsmql.pipeline()`, which refuses them.
- `.filter()` lists `value` as well as `stream` in its `where`, so a lone `.filter()` is a filter. `$match` lists only `stream`.
- lodash's `_.assign` writes its target. So the statement cell answers `$.a.assign($.b)` and names the write. `({}).assign(…)` writes nothing, so it is a value.

## Consequences

State each new shape case by hand. Never derive an expectation from the entry points.
