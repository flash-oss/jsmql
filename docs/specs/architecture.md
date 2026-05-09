# Architecture

## Pipeline

```
mjsql(string | Function)
    │
    ▼
Function-input adapter (src/index.ts)
    Only when input is a function. Calls Function.prototype.toString(),
    rejects non-arrow / async / generator / block-body shapes, splits on the
    first `=>` and takes the right-hand side as the expression source.
    Compiled bodies are cached LRU keyed on the extracted body string
    (cache-key choice rationale: see below).
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
export type MjsqlOps = Record<`$${string}`, (...args: any[]) => any>;
type MjsqlFn = ($: any, ops: MjsqlOps) => unknown;
type MjsqlInput = string | MjsqlFn;
// Accepts any callable shape — `() => …`, `($) => …`, `($, { $dateDiff }) => …`
// all work, by JS function variance. The parameter list is stripped at
// extraction time; `$` is `any` so unannotated `$.foo` keeps autocomplete
// without `noImplicitAny`. The optional second parameter is **types-only** —
// it gives users a destructure site for escape-hatch operators (e.g.
// `$dateDiff`) so the IDE doesn't flag them as unknown identifiers. Its
// template-literal key (`` `$${string}` ``) accepts any `$`-prefixed name as
// a callable; correctness against the real operator registry is enforced at
// codegen time, not by the type.

type MjsqlOutput = object | object[];
// Single compiled MQL expression, or — for top-level aggregation pipelines —
// an array of stage objects. Pipeline-mode detection lives in src/pipeline.ts;
// see specs/aggregation-stages.md.

mjsql(input: MjsqlInput): MjsqlOutput
// Parses and transpiles. Throws LexError | ParseError | CodegenError | FunctionInputError.
// For function input, the body is extracted (toString + arrow strip) and the result is cached.

validate(input: MjsqlInput): ValidationResult
// Same pipeline, but catches all errors and returns { valid, errors[] } instead.
// Total — never throws (see error-mapping table below).

mql(strings: TemplateStringsArray, ...values: unknown[]): MjsqlOutput
// Template tag. Interpolates values via JSON.stringify (with validation —
// see MqlInterpolationError below), then calls mjsql().
```

### Function-input cache

Cache key: the **extracted body string**, not the function reference. Inline arrows like `mjsql(($) => …)` evaluate to a fresh function object on every call (JS does not intern function literals), so a `WeakMap<Function, object>` would never hit. The body string is stable across every evaluation of the same source location, which gives cache hits in hot loops, in hoisted module-top-level constants, and across identical bodies declared at different call sites.

The cache is a **bounded LRU** (cap `FN_BODY_CACHE_CAP = 256`, eviction by `Map` insertion order). Today function bodies cannot be string-interpolated, so the natural set of distinct bodies is bounded by source-code size, but the cap is defence-in-depth against a future change that lets dynamic strings reach this map (e.g. accepting `new Function(...)` as input). The string-input path is intentionally **not** cached, because raw strings are often built via dynamic concatenation and would defeat any cache.

## Error types

All errors are classes with a `.message` string. Positional errors also have `.pos: number` (byte offset in the source string).

| Class | Module | Has pos | Notes |
|---|---|---|---|
| `LexError` | `lexer.ts` | yes | |
| `ParseError` | `parser.ts` | yes | |
| `CodegenError` | `codegen.ts` | no | Includes pipeline-detection errors raised by `pipeline.ts`. |
| `UnknownIdentifierError` | `codegen.ts` | no | Subclass of `CodegenError`. Carries `.identifier` so the function-input path can append an `mql` hint to the message. |
| `FunctionInputError` | `index.ts` | no | Function source isn't a supported shape (block body, async, `function` keyword, missing `=>`). |
| `MqlInterpolationError` | `index.ts` | no | Raised by the `mql` template tag when an interpolated value cannot be safely embedded as a JSON literal (function/Symbol/`undefined`, NaN/±Infinity, BigInt, circular refs). Carries `.slot: number` pointing to the offending interpolation slot. |

`validate()` maps errors as follows:

| Source | Code | `pos` |
|---|---|---|
| `LexError`, `ParseError` | `SYNTAX_ERROR` | original `.pos` |
| `CodegenError` and subclasses | `CODEGEN_ERROR` | `0` |
| `FunctionInputError`, `MqlInterpolationError` | `SYNTAX_ERROR` | `0` |
| `RangeError` | `SYNTAX_ERROR` | `0` (defensive — should be unreachable now that the parser/codegen depth caps trip first) |
| anything else | `CODEGEN_ERROR` | `0` (wrapped as `internal error: …` to keep `validate()` total) |
