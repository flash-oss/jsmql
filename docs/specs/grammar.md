# Grammar (v3)

This is the formal grammar for the v3 expression syntax accepted by the parser.

## EBNF

```ebnf
program        = expression EOF

expression     = ternary

ternary        = nullish ("?" expression ":" ternary)?   (* right-associative *)

nullish        = or ("??" or)*

or             = and ("||" and)*

and            = comparison ("&&" comparison)*

comparison     = relational [ ("==" | "!=" | "===" | "!==") relational ]
                 (* non-chainable; lower precedence than relational *)

relational     = additive [ ("<" | "<=" | ">" | ">=" | "in") additive ]
                 (* non-chainable: a < b < c is a parse error *)

additive       = multiplicative (("+"|"-") multiplicative)*

multiplicative = power (("*"|"/"|"%") power)*

power          = unary ("**" power)?                     (* right-associative *)

unary          = "typeof" unary
               | ("!" | "-") unary
               | postfix

postfix        = primary ("[" expression "]" | "." member_call)*

member_call    = FIELD_SEGMENT "(" arg_list ")"          (* method call *)
               | FIELD_SEGMENT                           (* property access *)

primary        = operator_call
               | field_ref
               | math_call
               | object_call
               | type_cast
               | new_date
               | regex_literal
               | number
               | string
               | boolean
               | null
               | array_literal
               | object_literal
               | lambda_paren                            (* (x) => expr *)
               | "(" expression ")"
               | IDENT                                   (* param_ref — lambda param or type cast name *)

operator_call  = "$" IDENT_OR_KW "(" op_arg_list ")"

op_arg_list    = ""                                           (* zero args *)
               | object_literal                               (* object-style, see note *)
               | arg_or_lambda ("," arg_or_lambda)*           (* positional args *)

arg_or_lambda  = lambda_unparen | lambda_paren | expression

field_ref      = "$." FIELD_SEGMENT                          (* one segment only; postfix handles further dots *)
FIELD_SEGMENT  = IDENT | NUMBER | "in" | "new" | "typeof"

array_literal  = "[" array_elements? "]"
array_elements = array_element ("," array_element)*
array_element  = "..." expression | expression

object_literal = "{" object_entries? "}"
object_entries = object_entry ("," object_entry)*
object_entry   = "..." expression | (IDENT | STRING) ":" expression

lambda_unparen = IDENT "=>" expression                       (* x => expr *)
lambda_paren   = "(" [IDENT ("," IDENT)*] ")" "=>" expression  (* (x, y) => expr *)

math_call      = "Math" "." MATH_METHOD "(" [expression ("," expression)*] ")"
MATH_METHOD    = "abs" | "ceil" | "floor" | "round" | "pow" | "sqrt" | "exp" | "log" | "trunc"

object_call    = "Object" "." OBJECT_METHOD "(" [expression ("," expression)*] ")"
OBJECT_METHOD  = "keys" | "values" | "entries" | "assign"

type_cast      = TYPE_CAST_NAME "(" expression ")"
TYPE_CAST_NAME = "Number" | "String" | "Boolean" | "parseInt" | "parseFloat"

new_date       = "new" "Date" "(" expression? ")"

regex_literal  = "/" REGEX_CHARS "/" REGEX_FLAGS?            (* context-sensitive: see below *)
REGEX_FLAGS    = [gimsuy]+

number         = DIGITS ("." DIGITS)? (("e"|"E") ("+"|"-")? DIGITS)?
                 (* decimal point only consumed when followed by a digit *)
string         = '"' chars '"' | "'" chars "'"
boolean        = "true" | "false"
null           = "null"

IDENT          = [a-zA-Z_][a-zA-Z0-9_]*
IDENT_OR_KW    = IDENT | "in" | "new" | "typeof"
DIGITS         = [0-9]+
```

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
- `$.items.0.name` → AST chain → codegen: `"$items.0.name"`

This enables method chaining: `$.name.trim()` parses as `MethodCall(FieldRef("name"), "trim", [])`.

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

## Operator precedence (high → low)

| Level | Operators | Associativity |
|---|---|---|
| Postfix | `[index]` `.prop` `.method()` | left |
| Unary | `typeof` `!` `-` | right |
| Power | `**` | right |
| Multiplicative | `*` `/` `%` | left |
| Additive | `+` `-` | left |
| Relational | `<` `<=` `>` `>=` `in` | none (non-chainable) |
| Equality | `==` `!=` `===` `!==` | none (non-chainable) |
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

## What is NOT in v3

- Assignment expressions (`$.a = $.b + 1`)
- Control flow (`if`, `for`, `while`)
- `class` or prototype methods
- Destructuring
