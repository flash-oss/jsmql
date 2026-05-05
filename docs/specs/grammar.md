# Grammar (v2)

This is the formal grammar for the v2 expression syntax accepted by the parser.

## EBNF

```ebnf
program        = expression EOF

expression     = ternary

ternary        = nullish ("?" expression ":" ternary)?   (* right-associative *)

nullish        = or ("??" or)*

or             = and ("||" and)*

and            = comparison ("&&" comparison)*

comparison     = additive [ ("==" | "!=" | "===" | "!==" | ">" | ">=" | "<" | "<=" | "in") additive ]
                 (* non-chainable: a < b < c is a parse error *)

additive       = multiplicative (("+"|"-") multiplicative)*

multiplicative = power (("*"|"/"|"%") power)*

power          = unary ("**" power)?                     (* right-associative *)

unary          = ("!" | "-") unary
               | postfix

postfix        = primary ("[" expression "]")*

primary        = operator_call
               | field_ref
               | number
               | string
               | boolean
               | null
               | array_literal
               | object_literal
               | "(" expression ")"

operator_call  = "$" IDENT_OR_KW "(" arg_list ")"

arg_list       = ""                                           (* zero args *)
               | object_literal                               (* object-style, see note *)
               | expression ("," expression)*                 (* positional args *)

field_ref      = "$." FIELD_SEGMENT ("." FIELD_SEGMENT)*
FIELD_SEGMENT  = IDENT | NUMBER | "in"                       (* "in" is a valid field name *)

array_literal  = "[" array_elements? "]"
array_elements = array_element ("," array_element)*
array_element  = "..." expression | expression

object_literal = "{" object_entries? "}"
object_entries = object_entry ("," object_entry)*
object_entry   = "..." expression | (IDENT | STRING) ":" expression

number         = DIGITS ("." DIGITS)? (("e"|"E") ("+"|"-")? DIGITS)?
string         = '"' chars '"' | "'" chars "'"
boolean        = "true" | "false"
null           = "null"

IDENT          = [a-zA-Z_][a-zA-Z0-9_]*
IDENT_OR_KW    = IDENT | "in"
DIGITS         = [0-9]+
```

> **Note on negative numbers:** The lexer never produces a negative number token.
> A leading `-` is always lexed as a `Minus` token; unary minus is handled by the
> `unary` rule. Codegen optimises `UnaryExpr('-', NumberLiteral(n))` to `-n` directly.

## Object-style detection rule

An operator call uses **object-style** if and only if:
1. There is exactly one argument, AND
2. That argument is an `object_literal` (starts with `{`).

If there is more than one argument, the call is always **positional**, even if the first argument happens to be an object literal (e.g. `$foo({ a: 1 }, $.b)` is positional with two args).

This rule is implemented in `Parser.parseOperatorCall()`.

## Operator precedence (high → low)

| Level | Operators | Associativity |
|---|---|---|
| Postfix | `[index]` | left |
| Unary | `!` `-` | right |
| Power | `**` | right |
| Multiplicative | `*` `/` `%` | left |
| Additive | `+` `-` | left |
| Comparison | `==` `!=` `===` `!==` `>` `>=` `<` `<=` `in` | none (non-chainable) |
| Logical AND | `&&` | left |
| Logical OR | `\|\|` | left |
| Nullish | `??` | left |
| Ternary | `? :` | right |

## String-context `+`

When any operand of a `+` chain is **string-producing**, the entire chain emits `$concat` instead of `$add`. String-producing expressions are:

- `StringLiteral`
- `OperatorCall` whose name is in `STRING_OUTPUT_OPS` (defined in `codegen.ts`)
- A nested `+` sub-expression where at least one of its own operands is string-producing

In v3, method calls to string methods and type casts to `String`/`toString` will also be string-producing.

## What is NOT in v2 (planned for v3)

- Method call syntax (`.trim()`, `.map()`, `.filter()`, etc.)
- Lambda expressions (`x => expr`)
- `Math.*` calls
- `new Date()` constructor
- `typeof` operator
- `Object.keys()` / `Object.values()` / `Object.entries()`
- Assignment expressions (`$.a = $.b + 1`)
