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
    Compiled bodies are cached in a Map<string, object> keyed on the extracted
    body string (cache-key choice rationale: see below).
    │
    ▼
Lexer (src/lexer.ts)
    Scans the input character-by-character into a flat Token[].
    Handles: punctuation, $. (field ref prefix), $ (operator prefix),
    number/string/boolean/null literals, identifiers, spread (...).
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
    Union type. Nodes: OperatorCall, FieldRef, NumberLiteral,
    StringLiteral, BooleanLiteral, NullLiteral, ArrayLiteral,
    ObjectLiteral, BinaryExpr, UnaryExpr, TernaryExpr,
    IndexAccess, MemberAccess, MethodCall, Lambda, ParamRef,
    RegexLiteral, TypeofExpr, NewDate, DateNow, TypeCast,
    MathCall, MathConst, ObjectCall, TemplateLiteral.
    Spread/key-value are auxiliary types used inside
    array/object nodes and call argument lists.
    │
    ▼
generate() (src/codegen.ts)
    Walks the AST. For OperatorCall nodes, consults the operator
    registry (src/operators.ts) to determine the output shape.
    │
    ▼
MQL JSON (plain JS object)
```

## Module responsibilities

| Module | Responsibility | Must NOT |
|---|---|---|
| `lexer.ts` | Produce tokens | Know anything about operators or AST structure |
| `parser.ts` | Produce AST | Look up operators; do any MQL-specific logic |
| `ast.ts` | Define node types | Contain logic |
| `operators.ts` | Define operator shapes | Import from parser or codegen |
| `codegen.ts` | Produce MQL JSON | Parse tokens; contain grammar rules |
| `index.ts` | Export public API | Contain parser or codegen logic |

## Public API surface (`src/index.ts`)

```ts
type MjsqlInput = string | ((...args: any[]) => unknown);
// Accepts any callable shape — `() => …`, `($) => …`, `(doc) => …` all work.
// The parameter list is stripped at extraction time; `any` for parameters
// gives IDE autocomplete on unannotated `$` without `noImplicitAny` errors.

mjsql(input: MjsqlInput): object
// Parses and transpiles. Throws LexError | ParseError | CodegenError | FunctionInputError.
// For function input, the body is extracted (toString + arrow strip) and the result is cached.

validate(input: MjsqlInput): ValidationResult
// Same pipeline, but catches all errors and returns { valid, errors[] } instead.

mql(strings: TemplateStringsArray, ...values: unknown[]): object
// Template tag. Interpolates values via JSON.stringify, then calls mjsql().
```

### Function-input cache

Cache key: the **extracted body string**, not the function reference. Inline arrows like `mjsql(($) => …)` evaluate to a fresh function object on every call (JS does not intern function literals), so a `WeakMap<Function, object>` would never hit. The body string is stable across every evaluation of the same source location, which gives cache hits in hot loops, in hoisted module-top-level constants, and across identical bodies declared at different call sites.

The cache is unbounded but safely so: function bodies cannot be string-interpolated, so the set of distinct bodies is bounded by source-code size. The string-input path is intentionally **not** cached, because raw strings are often built via dynamic concatenation and would leak memory.

## Error types

All errors are classes with a `.message` string. Positional errors also have `.pos: number` (byte offset in the source string).

| Class | Module | Has pos | Notes |
|---|---|---|---|
| `LexError` | `lexer.ts` | yes | |
| `ParseError` | `parser.ts` | yes | |
| `CodegenError` | `codegen.ts` | no | |
| `UnknownIdentifierError` | `codegen.ts` | no | Subclass of `CodegenError`. Carries `.identifier` so the function-input path can append an `mql` hint to the message. |
| `FunctionInputError` | `index.ts` | no | Function source isn't a supported shape (block body, async, `function` keyword, missing `=>`). |

`validate()` maps `LexError` and `ParseError` to `SYNTAX_ERROR`, `CodegenError` (and its subclasses) to `CODEGEN_ERROR`, and `FunctionInputError` to `SYNTAX_ERROR` with `pos: 0`.
