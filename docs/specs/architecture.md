# Architecture

## Pipeline

```
jsmql(string | Function | TemplateStringsArray + values)
    │
    ▼
Input dispatcher (src/index.ts)
    Branches on the first argument:
      - TemplateStringsArray (Array with .raw Array): joins strings with
        JSON-stringified values (per-slot validation in
        stringifyInterpolation()), then feeds the resulting source string
        into the parser path.
      - Function: calls Function.prototype.toString(), rejects non-arrow /
        async / generator shapes, strips the parameter list at the first
        `=>`, parses, and caches the result LRU keyed on the body string.
      - String: parses directly.
      - Anything else: throws TypeError naming the three accepted shapes.
    │
    ▼
Lexer (src/lexer.ts)
    Scans the input character-by-character into a flat Token[].
    Token shapes — see `TokenType` in src/lexer.ts.
    │
    ▼
Token[]
    │
    ▼
Parser (src/parser.ts)
    Recursive-descent. Consumes tokens and emits an Expr AST node.
    Key decision made here: object-style vs. positional operator call.
    No operator-specific knowledge — purely structural.
    │
    ▼
Expr (src/ast.ts)
    Union type — see the `Expr` union in src/ast.ts.
    Spread/key-value are auxiliary types used inside
    array/object nodes and call argument lists.
    │
    ▼
compile() (src/index.ts)
    Branches the parsed AST. If the root is a pipeline-shaped
    array (per `isPipelineAst()`), routes to generatePipeline();
    otherwise routes to generate().
    │
    ├──▶ generatePipeline() (src/pipeline.ts)
    │       Walks the array, validates each element against STAGES
    │       (src/stages.ts), and emits one stage object per element.
    │       Stage bodies recurse back into generate(); sub-pipeline
    │       slots (e.g. `$lookup.pipeline`, `$facet.*`) recurse into
    │       generatePipeline().
    │
    └──▶ generate() (src/codegen.ts)
            Walks the AST. For OperatorCall nodes, consults the
            operator registry (src/operators.ts) for the output shape.
    │
    ▼
MQL JSON (plain JS object, or array of stage objects)
```

## Module responsibilities

| Module | Responsibility | Must NOT |
|---|---|---|
| `lexer.ts` | Produce tokens | Know anything about operators or AST structure |
| `parser.ts` | Produce AST | Look up operators; do any MQL-specific logic |
| `ast.ts` | Define node types | Contain logic |
| `operators.ts` | Define expression-operator shapes | Import from parser or codegen |
| `stages.ts` | Define aggregation-pipeline stages and their sub-pipeline fields | Import from parser, codegen, or pipeline |
| `codegen.ts` | Produce MQL JSON for an expression AST | Parse tokens; contain grammar rules; know about pipeline stages |
| `pipeline.ts` | Detect pipeline-shaped ASTs and lower them to MQL stage arrays | Contain expression codegen logic (calls back into `codegen.ts`) |
| `index.ts` | Export public API; route between expression and pipeline codegen | Contain parser or codegen logic |

## Public API surface (`src/index.ts`)

```ts
export type JsmqlOps = Record<`$${string}`, (...args: any[]) => any>;
type JsmqlFn = ($: any, ops: JsmqlOps) => unknown;
type JsmqlInput = string | JsmqlFn;
// Accepts any callable shape — `() => …`, `($) => …`, `($, { $dateDiff }) => …`
// all work, by JS function variance. The parameter list is stripped at
// extraction time; `$` is `any` so unannotated `$.foo` keeps autocomplete
// without `noImplicitAny`. The optional second parameter is **types-only** —
// it gives users a destructure site for escape-hatch operators (e.g.
// `$dateDiff`) so the IDE doesn't flag them as unknown identifiers. Its
// template-literal key (`` `$${string}` ``) accepts any `$`-prefixed name as
// a callable; correctness against the real operator registry is enforced at
// codegen time, not by the type.

type JsmqlOutput = object | object[];
// Single compiled MQL expression, or — for top-level aggregation pipelines —
// an array of stage objects. Pipeline-mode detection lives in src/pipeline.ts;
// see specs/aggregation-stages.md.

jsmql(input: JsmqlInput): JsmqlOutput
jsmql(strings: TemplateStringsArray, ...values: unknown[]): JsmqlOutput
// Polymorphic over three call shapes: string, arrow function, and template tag.
// The template-tag form interpolates values via JSON.stringify (with validation —
// see JsmqlInterpolationError below) and feeds the result into the same parser
// path as the string form. Function input has its body extracted (toString +
// arrow-list strip) and cached LRU. Throws LexError | ParseError | CodegenError
// | FunctionInputError | JsmqlInterpolationError | TypeError.

jsmql.compile<P>(fn: (params: P, $?, ops?) => unknown): (params: P) => JsmqlOutput
// Parse once, bind many. The arrow's first slot is a destructure pattern naming
// the parameter bindings; the returned callable inlines fresh values from the
// params object into the AST on each call (no re-parse). Output shape matches
// the template-tag form — values appear as JSON literals, never wrapped in
// $let. See specs/function-form-params.md.

jsmql.validate(input: JsmqlInput): ValidationResult
jsmql.validate(strings: TemplateStringsArray, ...values: unknown[]): ValidationResult
// Same three call shapes as jsmql(), same pipeline — but catches all errors and
// returns { valid, errors[] } instead. Total — never throws (see error-mapping
// table below). The compile-form path stays throw-style; there is intentionally
// no `jsmql.validate.compile`.
```

The three entries are attached to `jsmql` via `Object.assign` (the strippable-TS rule in [src/CLAUDE.md](../../src/CLAUDE.md) forbids `namespace` declarations). The pre-1.0 import surface moved from `{ jsmql, validate } from "jsmql"` to `{ jsmql } from "jsmql"` with `validate` reachable as `jsmql.validate`.

### Function-input cache

Cache key: the **extracted body string**, not the function reference. Inline arrows like `jsmql(($) => …)` evaluate to a fresh function object on every call (JS does not intern function literals), so a `WeakMap<Function, object>` would never hit. The body string is stable across every evaluation of the same source location, which gives cache hits in hot loops, in hoisted module-top-level constants, and across identical bodies declared at different call sites.

The cache is a **bounded LRU** (cap `FN_BODY_CACHE_CAP = 256`, eviction by `Map` insertion order). Today function bodies cannot be string-interpolated, so the natural set of distinct bodies is bounded by source-code size, but the cap is defence-in-depth against a future change that lets dynamic strings reach this map (e.g. accepting `new Function(...)` as input). The string-input path is intentionally **not** cached, because raw strings are often built via dynamic concatenation and would defeat any cache.

## Error types

All errors are classes with a `.message` string. Positional errors also have `.pos: number` (byte offset in the source string).

| Class | Module | Has pos | Notes |
|---|---|---|---|
| `LexError` | `lexer.ts` | yes | |
| `ParseError` | `parser.ts` | yes | |
| `CodegenError` | `codegen.ts` | no | Includes pipeline-detection errors raised by `pipeline.ts`. |
| `UnknownIdentifierError` | `codegen.ts` | no | Subclass of `CodegenError`. Carries `.identifier` so the function-input path can append a `` jsmql`…` `` template-tag hint to the message. |
| `FunctionInputError` | `index.ts` | no | Function source isn't a supported shape (block body, async, `function` keyword, missing `=>`). |
| `JsmqlInterpolationError` | `index.ts` | no | Raised by the template-tag form of `jsmql` (and `validate`) when an interpolated value cannot be safely embedded as a JSON literal (function/Symbol/`undefined`, NaN/±Infinity, BigInt, circular refs). Carries `.slot: number` pointing to the offending interpolation slot. |
| `TypeError` | `index.ts` | no | Raised by `jsmql()`'s top-level guard when the first argument isn't a string, function, or `TemplateStringsArray` (e.g. `jsmql(42)`, `jsmql({})`). |

`validate()` maps errors as follows:

| Source | Code | `pos` |
|---|---|---|
| `LexError`, `ParseError` | `SYNTAX_ERROR` | original `.pos` |
| `CodegenError` and subclasses | `CODEGEN_ERROR` | `0` |
| `FunctionInputError`, `JsmqlInterpolationError` | `SYNTAX_ERROR` | `0` |
| `RangeError`, `TypeError` | `SYNTAX_ERROR` | `0` (`RangeError` is defensive — should be unreachable now that the parser/codegen depth caps trip first; `TypeError` comes from the top-level input-shape guard) |
| anything else | `CODEGEN_ERROR` | `0` (wrapped as `internal error: …` to keep `validate()` total) |
