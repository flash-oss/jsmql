# Grammar

The formal grammar for the expression syntax accepted by the parser.

## EBNF

```ebnf
program        = expression EOF

expression     = ternary

ternary        = nullish ("?" expression ":" ternary)?   (* right-associative *)

nullish        = or ("??" or)*

or             = and ("||" and)*

and            = bit_or ("&&" bit_or)*

bit_or         = bit_xor ("|" bit_xor)*

bit_xor        = bit_and ("^" bit_and)*

bit_and        = comparison ("&" comparison)*

comparison     = relational [ ("==" | "!=" | "===" | "!==") relational ]
                 (* non-chainable; lower precedence than relational *)

relational     = additive [ ("<" | "<=" | ">" | ">=" | "in") additive ]
                 (* non-chainable: a < b < c is a parse error *)

additive       = multiplicative (("+"|"-") multiplicative)*

multiplicative = power (("*"|"/"|"%") power)*

power          = unary ("**" power)?                     (* right-associative *)

unary          = "typeof" unary
               | ("!" | "-" | "~") unary
               | postfix

postfix        = primary (
                   "[" expression "]"
                 | "." member_call
                 | "?." member_call                          (* optional chaining *)
                 | "?." "[" expression "]"                   (* optional bracket access *)
                 | "(" call_arg_list ")"                     (* direct call — IIFE → $let *)
                 )*

member_call    = FIELD_SEGMENT "(" call_arg_list ")"         (* method call *)
               | FIELD_SEGMENT                               (* property access *)

primary        = operator_call
               | field_ref
               | math_call | math_const
               | object_call
               | type_cast
               | new_date | date_now | array_static
               | regex_literal
               | template_literal
               | number
               | string
               | boolean
               | null
               | array_literal
               | object_literal
               | lambda_paren                                (* (x) => expr *)
               | "(" expression ")"
               | IDENT                                       (* param_ref — lambda param or type cast name *)

operator_call  = "$" IDENT_OR_KW "(" op_arg_list ")"

op_arg_list    = ""                                          (* zero args *)
               | object_literal                              (* object-style, see note *)
               | call_arg ("," call_arg)*                    (* positional args, may include lambdas/spreads *)

call_arg_list  = (call_arg ("," call_arg)*)?
call_arg       = "..." expression                            (* spread *)
               | lambda_unparen | lambda_paren
               | expression

field_ref      = "$." FIELD_SEGMENT                          (* one segment only; postfix handles further dots *)
FIELD_SEGMENT  = IDENT | "in" | "new" | "typeof"             (* see "Strict-JS-subset rule" — numeric segments use [n] *)

array_literal  = "[" array_elements? "]"
array_elements = array_element ("," array_element)*
array_element  = "..." expression | expression

object_literal = "{" object_entries? "}"
object_entries = object_entry ("," object_entry)*
object_entry   = "..." expression
               | (IDENT | STRING) ":" expression
               | "[" expression "]" ":" expression           (* computed key *)
               | IDENT                                       (* shorthand: name → name: name *)

template_literal = "`" template_chunk ("${" expression "}" template_chunk)* "`"

lambda_unparen = IDENT "=>" expression                       (* x => expr *)
lambda_paren   = "(" [IDENT ("," IDENT)*] ")" "=>" expression  (* (x, y) => expr *)

math_call      = "Math" "." MATH_METHOD "(" call_arg_list ")"
MATH_METHOD    = "abs" | "ceil" | "floor" | "round" | "pow" | "sqrt"
               | "exp" | "log" | "log2" | "log10" | "trunc"
               | "min" | "max" | "sign" | "hypot" | "cbrt" | "random"
               | "sin" | "cos" | "tan" | "asin" | "acos" | "atan" | "atan2"
               | "sinh" | "cosh" | "tanh" | "asinh" | "acosh" | "atanh"

math_const     = "Math" "." ("PI" | "E")

object_call    = "Object" "." OBJECT_METHOD "(" call_arg_list ")"
OBJECT_METHOD  = "keys" | "values" | "entries" | "assign" | "fromEntries"

type_cast      = TYPE_CAST_NAME "(" expression ")"
TYPE_CAST_NAME = "Number" | "String" | "Boolean" | "parseInt" | "parseFloat"

new_date       = "new" "Date" "(" expression? ")"
date_now       = "Date" "." "now" "(" ")"
array_static   = "Array" "." "isArray" "(" expression ")"

regex_literal  = "/" REGEX_CHARS "/" REGEX_FLAGS?            (* context-sensitive: see below *)
REGEX_FLAGS    = [gimsuy]+

number         = DIGIT_SEQ ("." DIGIT_SEQ)? (("e"|"E") ("+"|"-")? DIGIT_SEQ)?
                 (* decimal point only consumed when followed by a digit *)
DIGIT_SEQ      = [0-9]+ ("_" [0-9]+)*                         (* numeric separators *)
string         = '"' chars '"' | "'" chars "'"
boolean        = "true" | "false"
null           = "null"

IDENT          = [a-zA-Z_][a-zA-Z0-9_]*
IDENT_OR_KW    = IDENT | "in" | "new" | "typeof"
```

## Strict-JS-subset rule

Every expression accepted by this grammar is also valid JavaScript syntax. Adding a production that JS would reject (e.g. `obj.0`, which is why `FIELD_SEGMENT` excludes `NUMBER`) is a violation of the project's [#2 priority](../../CLAUDE.md). When a feature seems to need JS-incompatible syntax, either find a JS-syntax-equivalent surface (bracket access for numeric indices, method calls for transformations) or expose it as a `$op(...)` call — `$op` is always valid JS because it's a function name.

## Function-form input is not part of the grammar

`mjsql()` and `validate()` accept either a string or an arrow function (see [architecture.md](architecture.md)). When given a function, an adapter in `src/index.ts` extracts the body via `Function.prototype.toString()` and feeds the body to the parser — the arrow wrapper itself never reaches the parser and is **not** described by this grammar. The parser sees only the right-hand side of `=>`, which must conform to `expression` exactly as the string-input path does.

## Template literals

A template literal is a sequence of literal chunks alternating with `${expr}` interpolations, delimited by backticks. The lexer emits a stream of tokens (`TemplateStart`, `TemplateChars`, `TemplateExprStart`, ..., `TemplateEnd`) and tracks brace depth across `${...}` regions so that an inner `}` returns the lexer to template-chunk mode rather than emitting `RBrace`. Templates may nest.

## Optional chaining

`?.` is accepted everywhere `.` is. The parser produces the same `MemberAccess` / `MethodCall` / `IndexAccess` AST nodes — there is no separate "optional" node. This is sound because MongoDB's dotted-path semantics already null-pass through missing fields, so `$.a?.b` and `$.a.b` produce identical MQL.

## Numeric separators

Digit sequences may contain single `_` characters between two digits. The lexer rejects leading `_`, trailing `_`, and `__`. The parser sees the underscore-stripped numeric value.

## Comments

JavaScript-style comments are skipped by the lexer, with semantics identical to ECMAScript:

- `// …` to end-of-line (any of LF, CR, LSEP U+2028, PSEP U+2029) or EOF.
- `/* … */` block comments. Nesting is **not** supported — the first `*/` closes. Unclosed block comments raise a `LexError`.

Comments are trivia: they are discarded during tokenisation by `skipTrivia()` (which alternates whitespace and comment passes until neither makes progress) and never appear in the token stream or AST. They are valid anywhere whitespace is, including inside template `${…}` interpolations. They are **not** recognised inside string literals, regex literals, or template-literal quasi text — those are consumed atomically by `readString` / `readRegex` / `readTemplateChunk`.

## Spread in call arguments

`...expr` is a valid argument anywhere that takes positional args (operator calls, method calls, `Math.*`, `Object.*`). It is represented in the AST as a `SpreadElement` interleaved with `Expr` arguments. Codegen handles spread in:

- Variadic operator/method calls — single spread → bare value; mixed → `$concatArrays`-wrapped
- `Math.min`/`Math.max` — same as variadic
- `Object.assign` — same
- Unknown operators — single spread passes through

Non-variadic operators (single/object/none shapes) reject spread with a clear error.

> **Note on negative numbers:** The lexer never produces a negative number token.
> A leading `-` is always lexed as a `Minus` token; unary minus is handled by the
> `unary` rule. Codegen optimises `UnaryExpr('-', NumberLiteral(n))` to `-n` directly.

> **Note on decimal numbers:** The lexer only treats `.` as a decimal point when the
> character immediately following it is also a digit. This means `0.5` is a number token
> but `$.items.0.name` tokenizes correctly as three separate segments.

## Object-style detection rule

An operator call uses **object-style** if and only if:
1. There is exactly one argument, AND
2. That argument is an `object_literal` (starts with `{`).

If there is more than one argument, the call is always **positional**, even if the first argument happens to be an object literal (e.g. `$foo({ a: 1 }, $.b)` is positional with two args).

This rule is implemented in `Parser.parseOperatorCall()`.

## Field ref — one segment only

`parseFieldRef()` stops after the **first** segment. Subsequent dot accesses are handled by `parsePostfix()` as `MemberAccess` or `MethodCall` nodes. Codegen's `asFieldPath()` helper reconstructs MongoDB dotted field paths transparently:

- `$.a.b.c` → AST: `MemberAccess(MemberAccess(FieldRef("a"), "b"), "c")` → codegen: `"$a.b.c"`

This enables method chaining: `$.name.trim()` parses as `MethodCall(FieldRef("name"), "trim", [])`.

If `asFieldPath()` can't fold the chain into a single dotted-path string — e.g. the receiver is an `IndexAccess` (`$.items[0].name`), a method call result, or a ternary — codegen falls back to `$getField`:

- `$.items[0].name` → `MemberAccess(IndexAccess(FieldRef("items"), 0), "name")` → codegen: `{ $getField: { field: "name", input: <bracket-access $cond> } }`

(For numeric array indices specifically, this is the supported replacement for the previously-accepted-but-not-valid-JS form `$.items.0.name`. See "Strict-JS-subset rule" above.)

## Context-sensitive `/` (regex vs divide)

`/` is context-sensitive. After a **value-ending token** (`Number`, `String`, `True`, `False`, `Null`, `Ident`, `RParen`, `RBracket`), `/` is a divide operator. After anything else (operator, opening delimiter, start of input), `/` starts a regex literal.

This matches the JavaScript lexer rules and enables `.match(/pattern/flags)`.

## Lambda syntax

Lambdas are first-class expressions valid in:
- Method call arguments: `.map(x => ...)`, `.filter((x) => ...)`, `.reduce((acc, x) => ..., init)`
- Operator call arguments: `$let({ vars }, (x) => body)`

A lambda appearing anywhere else (e.g. as a standalone expression) is a codegen error.

## `$let` with lambda

`$let(varsObject, lambda)` is a special positional form where the second argument is a lambda. The lambda parameters become the `vars` binding names:
```
$let({ d: $.price * 0.1 }, (d) => $.price - d)
→ { $let: { vars: { d: ... }, in: { $subtract: ["$price", "$$d"] } } }
```

## IIFE → `$let`

A `CallExpression` whose callee is a `Lambda` literal compiles to `$let`, with each lambda parameter becoming a `vars` entry bound to the corresponding argument:

```
((x, y) => $.a + x * y)(2, 3)
→ { $let: { vars: { x: 2, y: 3 }, in: { $add: ["$a", { $multiply: ["$$x", 3] }] } } }
```

`CallExpression` nodes whose callee is *not* a Lambda are rejected at codegen with an error directing the user to `$opName(...)` (operator) or `receiver.method(...)` (method) — there is no other callable value in MQL.

Two parser surfaces produce a Lambda usable here:
- `(IDENT, ..., IDENT) => expr` — handled by `isLambdaStart()` + `parseLambdaParen()`.
- `(IDENT => expr)` — single param without inner parens; handled by a check inside `parseGrouped()` (see source).

Spread args (`(...arr)`) and arity mismatches are codegen errors, not parse errors.

## Operator precedence (high → low)

| Level | Operators | Associativity |
|---|---|---|
| Postfix | `[index]` `.prop` `.method()` | left |
| Unary | `typeof` `!` `-` `~` | right |
| Power | `**` | right |
| Multiplicative | `*` `/` `%` | left |
| Additive | `+` `-` | left |
| Relational | `<` `<=` `>` `>=` `in` | none (non-chainable) |
| Equality | `==` `!=` `===` `!==` | none (non-chainable) |
| Bitwise AND | `&` | left |
| Bitwise XOR | `^` | left |
| Bitwise OR | `\|` | left |
| Logical AND | `&&` | left |
| Logical OR | `\|\|` | left |
| Nullish | `??` | left |
| Ternary | `? :` | right |

## String-context `+`

When any operand of a `+` chain is **string-producing**, the entire chain emits `$concat` instead of `$add`. String-producing expressions are:

- `StringLiteral`
- `OperatorCall` whose name is in `STRING_OUTPUT_OPS` (defined in `codegen.ts`)
- `MethodCall` to a string-returning method (`trim`, `trimStart`, `trimEnd`, `trimLeft`, `trimRight`, `toLowerCase`, `toUpperCase`, `substr`, `replace`, `replaceAll`)
- `TypeCast` with cast `"String"` (i.e. `String(x)`)
- `TypeofExpr` (`typeof x` always returns a string)
- A nested `+` sub-expression where at least one of its own operands is string-producing

## `in` operator — RHS validation

The `in` operator is parsed like any relational operator, but **codegen validates the right-hand side**: if the RHS is a scalar literal (`StringLiteral`, `NumberLiteral`, `BooleanLiteral`, `NullLiteral`), codegen throws:

```
Right-hand side of 'in' must be an array literal or field reference, not a scalar value
```

Array literals, field refs, operator calls, and any other expression are accepted. This catches the common mistake `$.x in "value"` at transpile time rather than producing silently invalid MQL.

## What is NOT supported

- Assignment expressions (`$.a = $.b + 1`)
- Control flow (`if`, `for`, `while`)
- `class` or prototype methods
- Destructuring (in lambda params or anywhere)
- `padStart`/`padEnd`/`repeat` — no MQL primitive
- `JSON.stringify`/`JSON.parse` — no MQL primitive
- `Number.isInteger`/`isNaN`/`isFinite` — partial via `$type`, not built-in
- `<<`, `>>`, `>>>` (bitwise shifts) — no MQL primitive
