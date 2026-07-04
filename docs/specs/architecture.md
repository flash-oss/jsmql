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
        `=>`, and parses. Re-parses on every call — use `jsmql.compile(fn)`
        for parse-once-bind-many.
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
    Every node carries `pos: number` — the byte offset of
    the leading token of that construct, threaded through
    by the parser. Codegen forwards `.pos` into every
    error it raises so .validate() callers can locate the
    offending region in the source.
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
export type JsmqlToolbox = { [K in `$${string}`]: any };
type JsmqlFn = (toolbox: JsmqlToolbox) => unknown;
type JsmqlInput = string | JsmqlFn;
// The canonical arrow form is `({ $ }) => …`: the arrow receives a single
// destructured "toolbox" object carrying the document root `$`, the context
// refs `$$` / `$$$` / `$$$$`, and every `$`-prefixed operator / stage. The
// parameter list is stripped at extraction time (jsmql parses the source; it
// never calls the arrow), so the destructure is types-only. Every key is `any`:
// `$` so unannotated `$.foo` keeps autocomplete without `noImplicitAny`, and
// each `$op` so a destructured `({ $, $dateDiff }) => …` type-checks even
// without the `@koresar/jsmql/ops` ambient import (which is where rich
// signatures come from). A bare `$` / bare identifier is no longer a valid
// parameter slot — the document context must be destructured.

type JsmqlOutput = object | object[];
// Single compiled MQL expression, or — for top-level aggregation pipelines —
// an array of stage objects. Pipeline-mode detection lives in src/pipeline.ts;
// see specs/aggregation-stages.md.

jsmql(input: JsmqlInput): JsmqlOutput
jsmql(strings: TemplateStringsArray, ...values: unknown[]): JsmqlOutput
// Polymorphic over three call shapes: string, arrow function, and template tag.
// The template-tag form interpolates JSON-shaped values via JSON.stringify (with
// validation — see JsmqlInterpolationError below). Opaque BSON instances
// (Date, RegExp, Uint8Array, ObjectId) bypass JSON.stringify entirely — they
// would lose fidelity (`new Date(...)` → ISO string, `RegExp` → `"{}"`, etc.) —
// and are instead routed through a synthesized `__jsmql_interp_<slot>` binding
// resolved at lower time via the same `bindings` machinery `jsmql.compile()`
// uses. The MQL output carries the JS instance untouched, which is what the
// Node MongoDB driver expects in-situ. Function input has its body extracted
// (toString + arrow-list strip) and is re-parsed on each call — see
// `jsmql.compile(fn)` for the parse-once-bind-many path. Throws
// LexError | ParseError | CodegenError | FunctionInputError |
// JsmqlInterpolationError | TypeError.

jsmql.compile<P>(fn: (params: P, toolbox?: JsmqlToolbox) => unknown): (params: P) => JsmqlOutput
// Parse once, bind many. The arrow's first slot is a destructure pattern naming
// the parameter bindings; the returned callable inlines fresh values from the
// params object into the AST on each call (no re-parse). Output shape matches
// the template-tag form — values appear as JSON literals, never wrapped in
// $let. See specs/function-form-params.md.

jsmql.validate<P>(fn: (params: P, toolbox?: JsmqlToolbox) => unknown): ValidationResult
jsmql.validate(input: JsmqlInput): ValidationResult
jsmql.validate(strings: TemplateStringsArray, ...values: unknown[]): ValidationResult
// Accepts every input shape jsmql() or jsmql.compile() accepts. Same parsing
// pipeline — but catches all errors and returns { valid, errors[] } instead.
// Total — never throws (see error-mapping table below). The compile-form
// arrow overload is listed first so IDEs contextually type `({ params }, { $ })`
// against `(params: P, toolbox: JsmqlToolbox)` rather than the one-shot
// `(toolbox: JsmqlToolbox)` shape (which would mis-type the params slot as the
// toolbox). For validation, parameter bindings resolve to null placeholders —
// values don't affect syntactic validity. The compile *invocation* path
// (`jsmql.compile(fn)(params)`) remains throw-style; there is intentionally
// no `jsmql.validate.compile` sub-namespace.
```

The three entries are attached to `jsmql` via `Object.assign` (the strippable-TS rule in [src/CLAUDE.md](../../src/CLAUDE.md) forbids `namespace` declarations). The pre-1.0 import surface moved from `{ jsmql, validate } from "@koresar/jsmql"` to `{ jsmql } from "@koresar/jsmql"` with `validate` reachable as `jsmql.validate`.

### No implicit cache for `jsmql(fn)`

The one-shot `jsmql(fn)` path re-parses the extracted body on every call. An earlier implementation kept a 256-entry LRU keyed on the body string, but it had two problems: one-shot queries (parsed once at process startup, never re-executed) occupied slots until eviction, and a `WeakMap` swap that would let the GC reclaim them isn't possible — `WeakMap` requires object keys (strings are primitives) and exposes neither `.size` nor iteration, so the cap can't be preserved.

Callers that want parse-once-bind-many use `jsmql.compile(fn)` — see [function-form-params.md](function-form-params.md). The string-input and template-tag paths are also uncached, for the same reason: any cache that catches repeated calls would have to retain dynamically-built strings indefinitely.

## Error types

All errors are classes with a `.message` string and a `.pos: number` carrying the source offset where the error was detected. Codegen-layer errors get a real offset because every AST node carries `pos` (populated by the parser from the leading token of each construct); helpers thread it down to throw sites.

| Class | Module | Has pos | Notes |
|---|---|---|---|
| `LexError` | `lexer.ts` | yes | Byte offset of the failing character. |
| `ParseError` | `parser.ts` | yes | Byte offset of the offending token. |
| `CodegenError` | `codegen.ts` | yes | Forwarded from the AST node that triggered the error (parser populates `pos` at every construction site). Includes pipeline-detection errors raised by `pipeline.ts`. |
| `UnknownIdentifierError` | `codegen.ts` | yes | Subclass of `CodegenError`. Carries `.identifier` so the function-input path can append a `` jsmql`…` `` template-tag hint to the message. |
| `FunctionInputError` | `index.ts` | yes | Function source isn't a supported shape (block body, async, `function` keyword, missing `=>`). Position is into the stringified arrow source. |
| `JsmqlInterpolationError` | `index.ts` | no | Raised by the template-tag form of `jsmql` (and `validate`) when an interpolated value cannot be safely embedded as a JSON literal (function/Symbol/`undefined`, NaN/±Infinity, BigInt, circular refs). Carries `.slot: number` pointing to the offending interpolation slot (and optionally `.key` for the `jsmql.compile()` path); no source offset because the template's text is split across the `strings`/`values` arrays. |
| `TypeError` | `index.ts` | no | Raised by `jsmql()`'s top-level guard when the first argument isn't a string, function, or `TemplateStringsArray` (e.g. `jsmql(42)`, `jsmql({})`). |

`validate()` maps errors as follows:

| Source | Code | `pos` |
|---|---|---|
| `LexError`, `ParseError` | `SYNTAX_ERROR` | original `.pos` |
| `CodegenError` and subclasses | `CODEGEN_ERROR` | `err.pos` (AST-node offset) |
| `FunctionInputError` | `SYNTAX_ERROR` | `err.pos` (offset in stringified arrow source) |
| `JsmqlInterpolationError` | `SYNTAX_ERROR` | `0` (use `.slot` / `.key` on the underlying error to locate the bad interpolation) |
| `RangeError`, `TypeError` | `SYNTAX_ERROR` | `0` (`RangeError` is defensive — should be unreachable now that the parser/codegen depth caps trip first; `TypeError` comes from the top-level input-shape guard) |
| anything else | `CODEGEN_ERROR` | `0` (wrapped as `internal error: …` to keep `validate()` total) |
