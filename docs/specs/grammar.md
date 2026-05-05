# Grammar (v1)

This is the formal grammar for the v1 LISP-style expression syntax accepted by the parser.

## EBNF

```ebnf
program        = expression EOF

expression     = operator_call
               | field_ref
               | number
               | string
               | boolean
               | null
               | array_literal
               | object_literal

operator_call  = "$" IDENT "(" arg_list ")"

arg_list       = ""                                           (* zero args *)
               | object_literal                               (* object-style, see note *)
               | expression ("," expression)*                 (* positional args *)

field_ref      = "$." IDENT ("." (IDENT | NUMBER))*

array_literal  = "[" array_elements? "]"
array_elements = array_element ("," array_element)*
array_element  = "..." expression | expression

object_literal = "{" object_entries? "}"
object_entries = object_entry ("," object_entry)*
object_entry   = "..." expression | (IDENT | STRING) ":" expression

number         = "-"? DIGITS ("." DIGITS)? (("e"|"E") ("+"|"-")? DIGITS)?
string         = '"' chars '"' | "'" chars "'"
boolean        = "true" | "false"
null           = "null"

IDENT          = [a-zA-Z_][a-zA-Z0-9_]*
DIGITS         = [0-9]+
```

## Object-style detection rule

An operator call uses **object-style** if and only if:
1. There is exactly one argument, AND
2. That argument is an `object_literal` (starts with `{`).

If there is more than one argument, the call is always **positional**, even if the first argument happens to be an object literal (e.g. `$foo({ a: 1 }, $.b)` is positional with two args).

This rule is implemented in `Parser.parseOperatorCall()`.

## What is NOT in v1

The following constructs from `docs/LANGUAGE.md` are planned for future versions and are not currently parsed:

- JavaScript infix operators (`+`, `-`, `*`, `/`, `==`, `&&`, `||`, `? :`, `??`, etc.)
- Method call syntax (`.trim()`, `.map()`, `.filter()`, etc.)
- Lambda expressions (`x => expr`)
- `Math.*` calls
- `new Date()` constructor
- `typeof` operator
- `Object.keys()` / `Object.values()` / `Object.entries()`
- Assignment expressions (`$.a = $.b + 1`)
