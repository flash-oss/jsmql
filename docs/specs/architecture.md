# Architecture

## Pipeline

```
mjsql(string)
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
    Union type. Core nodes: OperatorCall, FieldRef, NumberLiteral,
    StringLiteral, BooleanLiteral, NullLiteral, ArrayLiteral,
    ObjectLiteral. v2 nodes: BinaryExpr, UnaryExpr, TernaryExpr,
    IndexAccess. v3 nodes: MemberAccess, MethodCall, Lambda,
    ParamRef, RegexLiteral, TypeofExpr, NewDate, TypeCast,
    MathCall, ObjectCall. Spread/key-value are auxiliary types
    used inside array/object nodes.
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
mjsql(expression: string): object
// Parses and transpiles. Throws LexError | ParseError | CodegenError on failure.

validate(expression: string): ValidationResult
// Same pipeline, but catches all errors and returns { valid, errors[] } instead.

mql(strings: TemplateStringsArray, ...values: unknown[]): object
// Template tag. Interpolates values via JSON.stringify, then calls mjsql().
```

## Error types

All errors are classes with a `.message` string. Positional errors also have `.pos: number` (byte offset in the source string).

| Class | Module | Has pos |
|---|---|---|
| `LexError` | `lexer.ts` | yes |
| `ParseError` | `parser.ts` | yes |
| `CodegenError` | `codegen.ts` | no |

`validate()` maps all three to `ValidationError` objects (`{ message, pos, code }`).
