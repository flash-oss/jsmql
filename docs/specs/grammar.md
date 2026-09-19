# Grammar

The formal grammar for the expression syntax accepted by the parser.

## EBNF

```ebnf
program        = pipeline_program EOF
               | update_filter EOF
               | expression EOF

pipeline_program
               = pipeline_stmt (";" pipeline_stmt)+ ";"?
               | pipeline_stmt ";"          (* trailing `;` triggers pipeline mode *)
               (* any `;` at the top level flips parsing into pipeline mode;
                  each `;`-separated chunk becomes its own pipeline stage(s)
                  with no cross-coalescing *)

pipeline_stmt  = update_filter
               | let_decl
               | function_decl
               | expression           (* must compile to a stage at codegen *)

function_decl  = "function" IDENT "(" [IDENT ("," IDENT)* ","?] ")" expr_block
               (* reusable-function declaration; the keyword spelling of
                  `const IDENT = (params) => <body>`. Self-terminating: its
                  closing `}` ends the statement, so the next pipeline_stmt may
                  follow with no `;` (and its presence flips into pipeline mode).
                  See docs/specs/reusable-functions.md § The `function` keyword. *)

let_decl       = ("let" | "const") declarator ("," declarator)*
               (* pipeline-scoped local binding; see docs/specs/let-bindings.md.
                  `let` is reassignable (`name = …` later), `const` is not.
                  Only valid inside a pipeline (any `;`-separated form or a
                  bracketed `[...]` pipeline element). A top-level let/const in
                  expression mode is a parse error.
                  A declaration list is N declarations, as in JavaScript: a later
                  declarator reads the earlier ones. The `,` is also the MERGE and
                  the `;` the stage boundary, the rule update_filter follows, so
                  one list takes one `$set` — broken only at a declarator that
                  reads a sibling bound in it. Inside a bracketed `[...]` pipeline
                  the `,` is already the ELEMENT separator, so each element there
                  carries its own keyword. *)

declarator     = IDENT "=" expression
               (* an initialiser is required: a binding is a value, and MQL has
                  no `undefined` to hold the place of one, so `let x;` is a
                  position-marked ParseError naming `let x = <expr>`. *)

update_filter  = update_op ("," update_op)* ","?
               (* parser dispatch:
                  - leading `delete`, `++`, or `--`, OR
                  - leading expression followed by an assignment operator
                  triggers update_filter; otherwise expression *)

separator      = ","                   (* in-update-filter update_op separator *)

update_op      = "delete" target
               | assignment_chain

assignment_chain
               = target "=" assignment_chain          (* right-associative *)
               | target "=" expression
               | target compound_op expression
               (* compound_op chains are rejected: `a += b += 1` is a parse error *)

compound_op    = "+=" | "-=" | "*=" | "/="

target         = field_ref ("." FIELD_SEGMENT)*
               | IDENT                       (* bare identifier — a `let` reassignment;
                                                accepted at parse time, validated against
                                                the pipeline let-scope at codegen *)
               (* a field-path target must be static; index access ($.x[0]) is
                  rejected at parse time *)

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

member_call    = "$" FIELD_SEGMENT "(" call_arg_list ")"     (* chained stage call — see aggregation-stages.md *)
               | FIELD_SEGMENT "(" call_arg_list ")"         (* method call *)
               | FIELD_SEGMENT                               (* property access *)

primary        = operator_call
               | field_ref
               | context_ref                                 (* $$, $$$, $$$$ — see context-references.md *)
               | math_call | math_const
               | object_call
               | type_cast | type_cast_ref | number_static
               | new_date_or_set | objectid_literal | objectid_ref | date_now | array_static
               | regex_literal
               | template_literal
               | number | bigint
               | string
               | boolean
               | null
               | array_literal
               | object_literal
               | lambda_paren                                (* (x) => expr *)
               | function_expr                               (* function (x) { return expr } *)
               | "(" expression ")"                          (* also accepts (x => expr) *)
               | IDENT                                       (* param_ref — lambda param or type cast name *)

operator_call  = "$" IDENT_OR_KW "(" op_arg_list ")"

op_arg_list    = ""                                          (* zero args *)
               | object_literal ","?                         (* object-style — a lone trailing comma stays object-style; see note *)
               | call_arg ("," call_arg)* ","?               (* positional args, may include lambdas/spreads *)

call_arg_list  = (call_arg ("," call_arg)* ","?)?
call_arg       = "..." expression                            (* spread *)
               | lambda_unparen | lambda_paren
               | expression

field_ref      = "$." FIELD_SEGMENT                          (* one segment only; postfix handles further dots *)
FIELD_SEGMENT  = IDENT | KEYWORD                             (* KEYWORD: every row of src/registry/keywords.ts; numeric segments use [n] *)

context_ref    = ( "$$" | "$$$" | "$$$$" )                   (* bare prefix tokens — collection / database / cluster *)
               (* parser sanity-guards: next token must be `.` or `[`.
                  Postfix `.name` / `[expr]` composes via the standard
                  postfix rule above. Codegen throws — the syntax is
                  reserved and has no lowering. See
                  docs/specs/context-references.md. *)

array_literal  = "[" array_elements? "]"
array_elements = array_element ("," array_element)* ","?
array_element  = "..." expression | expression

object_literal = "{" object_entries? "}"
object_entries = object_entry ("," object_entry)* ","?
object_entry   = "..." expression
               | (IDENT | STRING) ":" expression
               | NUMBER ":" expression                       (* numeric key → its stringified VALUE:
                                                                { 0: 1 } is the field "0", { 0x10: 1 } is "16",
                                                                matching JS property-key coercion. A 24-hex
                                                                ObjectId literal is rejected — not a field name. *)
               | "$" IDENT ":" expression                    (* dollar-prefixed key, e.g. { $match: ... } *)
               | "[" expression "]" ":" expression           (* computed key *)
               | IDENT                                       (* shorthand: name → name: name *)

template_literal = "`" template_chunk ("${" expression "}" template_chunk)* "`"

lambda_unparen = IDENT "=>" lambda_body                      (* x => expr | x => { … } *)
lambda_paren   = "(" [IDENT ("," IDENT)* ","?] ")" "=>" lambda_body  (* (x, y) => … *)
lambda_body    = expr_block | expression
expr_block     = "{" (let_decl ";")* "return" expression [";"] "}"   (* lowers to nested $let;
                  a let_decl here may be a list, and one list shares one $let — the
                  same merge-and-break rule the $set road follows *)
function_expr  = "function" IDENT? "(" [IDENT ("," IDENT)* ","?] ")" expr_block
               (* a function expression — the same node a block-body arrow
                  produces. An optional name is parsed and discarded (unreachable
                  in MQL). A single-`return` body normalises to a plain
                  expression body, so it is identical to `(x) => <expr>`
                  everywhere. `function` is not a keyword token — the parser
                  intercepts the identifier by value. *)

math_call      = "Math" "." MATH_METHOD "(" call_arg_list ")"
MATH_METHOD    = (* the rows in src/registry/names.ts with `on: "Math"` and `call: true` *)

math_const     = "Math" "." MATH_CONST
MATH_CONST     = (* the rows in src/registry/names.ts with `on: "Math"` and `call: false` *)

object_call    = "Object" "." OBJECT_METHOD "(" call_arg_list ")"
OBJECT_METHOD  = (* the rows in src/registry/names.ts with `on: "Object"` *)

type_cast      = TYPE_CAST_NAME "(" expression ","? ")"      (* exactly one arg; a lone trailing comma is allowed *)
TYPE_CAST_NAME = (* the global rows in src/registry/names.ts that cast one value *)

type_cast_ref  = BARE_CAST_NAME                              (* bare callback shorthand, no `(` *)
BARE_CAST_NAME = "Boolean" | "Number" | "String"             (* the cast rows that also say `asReference: true` *)

objectid_ref   = "ObjectId"                                  (* bare callback shorthand, no `(` *)

number_static  = "Number" "." NUMBER_STATIC "(" expression ","? ")"
NUMBER_STATIC  = (* the rows in src/registry/names.ts with `on: "Number"` *)

new_date_or_set = "new" ("Date" | "Set") "(" (expression ("," expression)* ","?)? ")"
objectid_literal = "new"? "ObjectId" "(" (expression ","?)? ")"
                 (* empty → $createObjectId(); a 24-hex string literal → ObjectId
                    literal (non-24 string throws; pre-2009 timestamp throws);
                    any other expr → $toObjectId(expr) *)
date_now       = "Date" "." "now" "(" ")"
array_static   = "Array" "." ("isArray" "(" expression ","? ")" | "from" "(" expression ("," call_arg)? ","? ")")

regex_literal  = "/" REGEX_CHARS "/" REGEX_FLAGS?            (* context-sensitive: see below *)
REGEX_FLAGS    = [gimsuy]+

number         = hex_number
               | DIGIT_SEQ ("." DIGIT_SEQ)? (("e"|"E") ("+"|"-")? DIGIT_SEQ)?
                 (* decimal point only consumed when followed by a digit *)
hex_number     = ("0x"|"0X") HEX_SEQ
                 (* parser classifies: exactly 24 hex digits → ObjectId literal
                    (rejected if its embedded timestamp predates 2009 — a typo);
                    else an integer (rejected if > Number.MAX_SAFE_INTEGER) *)
bigint         = DIGIT_SEQ "n"                                (* integer-only; no fraction or exponent *)
DIGIT_SEQ      = [0-9]+ ("_" [0-9]+)*                         (* numeric separators *)
HEX_SEQ        = [0-9a-fA-F]+ ("_" [0-9a-fA-F]+)*             (* numeric separators *)
string         = '"' chars '"' | "'" chars "'"
boolean        = "true" | "false"
null           = "null"

IDENT          = [a-zA-Z_][a-zA-Z0-9_]*
IDENT_OR_KW    = IDENT | "in" | "new" | "typeof"
```

## Top-level statements: `;` vs `,`

The two top-level separators have distinct roles:

- `;` is the **pipeline-stage separator**. Any `;` at the top level flips
  the input to pipeline mode (array output). The compiler lowers each `;`-separated chunk
  in isolation — adjacent update op statements never coalesce
  across `;`. One trailing `;` is enough to trigger pipeline mode
  (`$.a = 1;` → `[{ $set: { a: 1 } }]`).
- `,` is the **in-stage update op separator**. Comma-grouped update ops
  share one stage, and they coalesce through the existing kind / read-after-write
  rules in `src/compiler/emit/lower.ts`.

Mixed forms compose naturally: in `$.a = 1, $.b = 2; $match(…)`, the `,`
keeps `a` and `b` in one `$set` stage, and the `;` adds the `$match` as
the next stage. Inside an explicit `[…]` pipeline, only `,` is valid (JS
syntax), and adjacent update op elements coalesce. This is the
documented difference between the two pipeline forms.

The parser's top-level `;` loop implements this, along with `writeStages`
(`src/compiler/emit/statement.ts`), which coalesces a `,`-run of writes into the
fewest stages that keep their order ([update-filter.md § The pipeline](update-filter.md)).
A `;` is a stage boundary.

## Strict-JS-subset rule

Every expression this grammar accepts is also valid JavaScript syntax. Adding a production that JS would reject (for example `obj.0`, which is why `FIELD_SEGMENT` excludes `NUMBER`) breaks the project's [#2 priority](../../CLAUDE.md). When a feature seems to need JS-incompatible syntax, either find a JS-syntax-equivalent surface (bracket access for numeric indices, method calls for transformations), or expose it as a `$op(...)` call. `$op` is always valid JS, because it is a function name.

## Trailing commas

JS allows one trailing comma after the last element of any comma-separated list (`f(a, b,)`, `[1, 2,]`, `{ a: 1, }`, `(x, y,) => …`). So the parser accepts one **everywhere a comma list appears**: call args (method / `$op` / `Math` / `Object` / `Date.UTC` / `new Date|Set`), array and object literals, destructure patterns, arrow / `function` parameter lists, the `jsmql.compile` `(params, { $, … })` signature, and the in-stage update-op chain (`$.a = 1, $.b = 2,`). The EBNF spells the `","?` on the core lists above, and leaves it out on the fixed-arity built-ins (`type_cast`, `number_static`, `Array.isArray`, `objectid_literal`), where only a *lone* trailing comma is meaningful. A trailing comma never changes the parse, so the output is byte-identical to the comma-free form (`$op({…})` ≡ `$op({…},)` stays object-style). A trailing comma is *not* a way to pass an extra argument: `Number(x, y)` still raises the fixed-arity error. Every comma loop in `src/compiler/parse/parser.ts` — `args`, `arrayLiteral`, `objectLiteral`, `paramList`, `destructure` — is written the same way, `do { if (<closer>) break; … } while (eat("Comma"))`, so one shape enforces this rule everywhere.

## Function-form input is not part of the grammar

`jsmql()` and `validate()` are polymorphic: each accepts a string, a function (an arrow `({ $ }) => …` or a `function ({ $ }) { return … }`), or a template-tag invocation (see [architecture.md](architecture.md)). When given a function, an adapter in `src/index.ts` extracts the body through `Function.prototype.toString()` and feeds the body to the parser. The function wrapper itself never reaches the parser, and this grammar does **not** describe it. A `function ({ $ }) { return <expr> }` entry body is the value form (≡ `({ $ }) => <expr>`); a `function ({ $ }) { <stmts> }` body is the `;`-pipeline form (≡ `({ $ }) => { <stmts> }`). When called as a template tag, the adapter joins the literal chunks with `JSON.stringify`'d interpolations and feeds the resulting source to the parser. In every case the parser sees ordinary `expression`-conforming source, so this grammar covers all three call shapes.

## Template literals

A template literal is a sequence of literal chunks that alternate with `${expr}` interpolations, and backticks delimit it. The lexer emits a stream of tokens (`TemplateStart`, `TemplateChars`, `TemplateExprStart`, ..., `TemplateEnd`) and tracks the brace depth across `${...}` regions, so an inner `}` returns the lexer to template-chunk mode instead of emitting `RBrace`. Templates may nest.

## Optional chaining

A `.` followed by `$<name>(` is a **chained stage call** (`$$.$match({…}).$limit(5)`), not a property access. The lexer emits `$match` as `Dollar` + `Ident`, so the parser consumes both and produces an ordinary `MethodCall` whose `method` is `"$match"`. Only the *call* form is a stage link: a bare `.$name` and an optional-chained `?.$name(…)` are both parse errors. For semantics and lowering, see [aggregation-stages.md](aggregation-stages.md#chained-stage-calls).

`?.` is accepted everywhere `.` is. The parser produces the same `MemberAccess` / `MethodCall` / `IndexAccess` AST nodes — there is no separate "optional" node. This is sound because MongoDB's dotted-path semantics already null-pass through missing fields, so `$.a?.b` and `$.a.b` produce identical MQL.

## Numeric separators

A digit sequence may contain single `_` characters between two digits. The lexer rejects a leading `_`, a trailing `_`, and `__`. The parser reads the numeric value with the underscores stripped.

## Comments

The lexer skips JavaScript-style comments, with semantics identical to ECMAScript:

- `// …` runs to end-of-line (any of LF, CR, LSEP U+2028, PSEP U+2029) or to EOF.
- `/* … */` marks a block comment. Nesting is **not** supported — the first `*/` closes it. An unclosed block comment raises a `LexError`.

Comments are trivia: `skipTrivia()` discards them during tokenisation (it alternates whitespace and comment passes until neither makes progress), and they never appear in the token stream or AST. They are valid anywhere whitespace is, including inside template `${…}` interpolations. The lexer does **not** recognise them inside string literals, regex literals, or template-literal quasi text — `scanString` / `scanRegex` in [src/compiler/lex/scanners.ts](../../src/compiler/lex/scanners.ts) consume those atomically, as does `templateChunk` inside `lex()`.

## Spread

`...expr` is a valid construct anywhere positional args, array literal elements, or object literal entries appear. The AST represents it as a `SpreadElement`. Codegen handles spread in:

- Variadic operator/method calls — single spread → bare value; mixed → `$concatArrays`-wrapped per-arg
- `Math.min`/`Math.max` — same as variadic
- `Object.assign` — same
- Unknown operators — single spread passes through
- Array literals — `$concatArrays` with consecutive non-spread elements grouped into one literal-array operand; a lone `[...x]` returns `x` directly
- Object literals — `$mergeObjects` with consecutive non-spread entries grouped into one operand; a lone `{...x}` returns `x` directly

Non-variadic operators (single/object/none shapes) reject spread with a clear error.

> **Note on negative numbers:** The lexer never produces a negative number token.
> It always lexes a leading `-` as a `Minus` token, and the `unary` rule handles
> unary minus. Codegen optimises `UnaryExpr('-', NumberLiteral(n))` to `-n` directly.

> **Note on decimal numbers:** The lexer treats `.` as a decimal point only when the
> character right after it is also a digit. So `0.5` is one number token,
> but `$.items.0.name` tokenizes correctly as three separate segments.

## Object-style detection rule

An operator call uses **object-style** if and only if:
1. It has exactly one argument, AND
2. That argument is an `object_literal` (it starts with `{`).

If there is more than one argument, the call is always **positional**, even when the first argument is an object literal (for example `$foo({ a: 1 }, $.b)` is positional, with two args).

The rule runs in the parser's argument loop, [src/compiler/parse/parser.ts](../../src/compiler/parse/parser.ts).

## Field ref — one segment only

The parser stops a field reference after the **first** segment; later dot accesses are `MemberAccess` or `MethodCall` nodes. The value road (`src/compiler/emit/lower.ts`) renders a member chain on a field as one dotted path:

- `$.a.b.c` → AST: `MemberAccess(MemberAccess(FieldRef("a"), "b"), "c")` → `"$a.b.c"`

This enables method chaining: `$.name.trim()` parses as `MethodCall(FieldRef("name"), "trim", [])`.

A name after `$.` that is followed by `(` is not a field, because a field is never callable. So
`$.pick(["a"])` parses as `MethodCall(FieldRef(""), "pick", […])` — a method on the document
itself, with the bare `$` as its receiver. The node's position is the `.` of the `$.` token, the same point
every other method call points to.

When the chain cannot be one path — the receiver is an `IndexAccess` (`$.items[0].name`), a method call result, or a ternary — the member read becomes `$getField` over the lowered receiver:

- `$.items[0].name` → `MemberAccess(IndexAccess(FieldRef("items"), 0), "name")` → `{ $getField: { field: "name", input: <the bracket access: $arrayElemAt on an array, $substrCP on a string, $getField otherwise> } }`

(For numeric array indices specifically, bracket access is the only form: `$.items.0.name` is not valid JavaScript, so JSMQL does not accept it. See "Strict-JS-subset rule" above.)

## Built-in call vs bare reference

A one-value-in/one-value-out built-in reads two ways: its call form (`Boolean(x)`, `ObjectId(x)`) and a bare callback reference (`arr.filter(Boolean)`, `ids.map(ObjectId)`). The parser is **name-blind** and settles neither question — `Boolean(x)` is a `CallExpression`, a bare `Boolean` is an `Ident`, and `Math.abs` is a `MemberAccess`, whatever the name spells. Facts on the row decide later which of them MEANS a callback:

- The desugar pass rewrites a bare callable in an iteratee slot into the arrow that applies it. `bareCall` in [src/compiler/passes/desugar.ts](../../src/compiler/passes/desugar.ts) turns `Boolean` into `x => Boolean(x)` and `Math.abs` into `x => Math.abs(x)`. The row's `iterateeSlots` layout states which slots accept the spelling; the rewrite never guesses this.
- A name reaches that rewrite only when its row says `asReference: true` and `call` is not `false`. The parser refuses a name whose row says `new` is *required* (`Date`) as a bare callable — real-JS `Date` without `new` ignores its argument, so JSMQL asks for the explicit arrow instead.

Outside an iteratee slot, a bare name has no value to stand for, and the emit phase refuses it and names the call form: `'Boolean' used as a value is only valid as a callback to a higher-order array method … To apply it to one value, write Boolean(value).`

## Context-sensitive `/` (regex vs divide)

`/` is context-sensitive. After a **value-ending token** (`Number`, `String`, `True`, `False`, `Null`, `Ident`, `RParen`, `RBracket`), `/` is a divide operator. After anything else (an operator, an opening delimiter, or the start of input), `/` starts a regex literal.

This matches the JavaScript lexer rules and enables `.match(/pattern/flags)`.

## Lambda syntax

Lambdas are first-class expressions valid in:
- Method call arguments: `.map(x => ...)`, `.filter((x) => ...)`, `.reduce((acc, x) => ..., init)`
- Operator call arguments: `$let({ vars }, (x) => body)`

A lambda that appears anywhere else (for example as a standalone expression) is a codegen error.

### Body: expression or block (JS-faithful `=> {`)

A lambda body is either an expression (`x => x * 2`) or a **statement-laden block** (`x => { … }`). JSMQL follows JavaScript exactly: `=> {` **always** opens a block, so an object return must be parenthesised — write `x => ({ k: v })`, never `x => { k: v }` (the latter is a labeled-statement block in JS). Two block grammars exist, and position selects between them:

- **Expression block** (`expr_block` above) — the default everywhere a lambda is a value (array methods, `$let`, IIFE). It is `(const|let <name> = <expr>;)* return <expr>;`, and it lowers to a right-folded nest of `$let` (see [emit-pass.md § Bindings between stages](emit-pass.md#bindings-between-stages)). A bare `=> { k: v }` is rejected (it has no `return`), and the error points at `=> ({ k: v })`; re-declaring a name, or leaving out `return`, are likewise actionable errors.
  The compiler refuses a block that holds anything else, and names the mistake it finds, split by what the block holds. A stage call, a bare call (`assert(…)`), or a write with NO `return` beside it is "a pipeline stage, not part of a callback", and the error carries the `.aggregate((o) => { … })` rewrite. The same statement WITH a `return` names both positions instead: one block cannot be a stage block and a value callback at once, and the `.aggregate` rewrite refuses the block while the `return` sits in it, so the message asks the developer to delete one or the other. A reusable-function declaration gets its own sentence: it belongs at the top level of a pipeline, and the message quotes the spelling the developer wrote (`const g = (…) => …`, not `function g(…) { … }`). A stray expression statement follows the block's own rule ("must end with a `return <expr>`", or "holds 'const' declarations and one 'return'" when a return is present).
- **Statement block** (the `$lookup`/facet sub-pipeline form) — a `{ … }` body with **no `return`**, for example `$$$.<coll>.aggregate((o) => { … })`. Its statements are stages or update ops. Only `.aggregate` *keeps* them: the JavaScript methods share this grammar, so the stage rejection can name what the developer wrote, and a stage-free block folds back to the expression it returns. See [lookup-stage.md](lookup-stage.md) § Grammar and [emit-pass.md § The method cells](emit-pass.md#the-method-cells).

The parser needs no lookahead to tell the two apart: `lambdaBody` parses the braces once, and the presence of `return` decides — present, the body is an `ExprBlock`; absent, the statements form a stages `Pipeline`. WHOSE stages they are is the row's fact, not the parser's guess: `args` claims the body for a callee whose row says `blockBody: "stages"` (`blockBodyOf` in [src/compiler/rows.ts](../../src/compiler/rows.ts)), and it leaves an unknown callee's body unclaimed, so the emit phase can name the nearest method instead. `finish()` runs after the parser builds the whole tree, and it refuses a stages body nobody claimed. It reports the real mistake — the stage the developer wrote, with the `.aggregate((o) => { … })` and `$$.$match(…)` rewrites — instead of demanding a `return` the developer never wanted. `return` is a reserved keyword (the lexer treats it as its own token; it is still usable as a property name or object key, matching JS).

## `$let` with lambda

`$let(varsObject, lambda)` is a special positional form, where the second argument is a lambda. The `vars` keys come from the **object literal** (the first argument), and the compiler adds the lambda's parameters to scope, so references inside the body emit `$$paramName`. Lambda parameter names must match the keys in the object literal — when they do, the binding works:
```
$let({ d: $.price * 0.1 }, (d) => $.price - d)
→ { $let: { vars: { d: ... }, in: { $subtract: ["$price", "$$d"] } } }
```
The `$let` row's cell (`src/registry/names.ts`) refuses a name mismatch (`$let({ x: ... }, (d) => ...)`) with "$let's arrow parameters must name its variables: got (d) for vars { x }."

## IIFE → `$let`

A `CallExpression` whose callee is a `Lambda` literal compiles to `$let`. Each lambda parameter becomes a `vars` entry bound to the matching argument:

```
((x, y) => $.a + x * y)(2, 3)
→ { $let: { vars: { x: 2, y: 3 }, in: { $add: ["$a", { $multiply: ["$$x", 3] }] } } }
```

Codegen rejects a `CallExpression` node whose callee is *not* a Lambda, with an error that directs the user to `$opName(...)` (operator) or `receiver.method(...)` (method) — MQL has no other callable value.

Two parser surfaces produce a Lambda usable here:
- `(IDENT, ..., IDENT) => expr` — `parenthesised()` reads the names, and rewinds to a plain parenthesised expression when no `=>` follows.
- `IDENT => expr` — a single param with no parens; `identifierOrLambda()` takes the arrow after the name.

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

When any operand of a `+` chain is **string-producing**, the whole chain emits `$concat` instead of `$add`. String-producing is a PROOF, not a list: `kindOf` in [src/compiler/emit/types.ts](../../src/compiler/emit/types.ts) answers `"string"` for a string or template literal, for a call or method whose row states `returns: "string"` (`String(x)`, `typeof x`, `$.name.trim()`), and, recursively, for a nested `+` chain with at least one string-producing operand. A field path proves nothing, and stays `"unknown"`, so `$.a + $.b` is `$add`.

## JS truthy/falsy semantics for `&&`, `||`, `!`, `?:`, `Boolean()`, predicate methods

`lowerTruth` in [src/compiler/emit/lower.ts](../../src/compiler/emit/lower.ts) is the truth READING of an expression, and [src/compiler/emit/mode.ts](../../src/compiler/emit/mode.ts) holds the rules it applies over MQL primitives. `Truth` is a brand the vocabulary declares ([src/registry/vocabulary.ts](../../src/registry/vocabulary.ts)), and `mode.ts` alone mints it. Every slot that reads a boolean is typed to take one, so a value cannot land in `$cond.if` without passing through, and a value that is provably a boolean passes bare.

- The JavaScript test emits `{ $and: [{$ne:[{$ifNull:[v,null]},null]}, {$ne:[v,false]}, {$ne:[v,""]}, {$ne:[v,0]}] }`. The null-check operand is wrapped in `$ifNull(v, null)`, so it catches **both** `null` and *missing*: a bare `$ne:[v,null]` does **not** match missing. MongoDB's `$eq`/`$ne` treat a missing value as distinct from null (`{$eq:["$absent",null]}` is `false`), so without the wrap `arr.filter(x => x.f)` would wrongly keep elements where `f` is absent. `$ifNull` collapses missing to null first, matching JS, where `undefined`/missing is falsy. The other three clauses compare the raw value (false/`""`/`0` are never "missing"), and rely on type-bracketed comparison for the cross-type checks (for example `{$ne: ["abc", 0]}` is true). Empty array `[]` and empty object `{}` correctly stay truthy. JSMQL treats NaN as truthy — see "Truthy and falsy" in `LANGUAGE.md`.
- The truth reading covers every **boolean position** — anywhere only an expression's truthiness is observed — so one rule covers the whole language: a `?:` test, `!`, `Boolean()`, `assert()`, a predicate lambda body and the lodash predicate-run family (the `predicate` and `condition` services in [src/compiler/emit/inputs.ts](../../src/compiler/emit/inputs.ts), which read a callback's body through `lowerTruth`), `.compact()`, and the `$expr` residual the filter road emits where no row states a native query form (`matchExpr` in [src/compiler/emit/filter.ts](../../src/compiler/emit/filter.ts)). This is what makes `.compact()` identical to `.filter(Boolean)`, makes `.reject(p)` the exact complement of `.filter(p)`, and makes a stream `$$.filter(p)` agree with the value-mode `.filter(p)`.
- A `&&` / `||` chain in boolean position becomes `$and` / `$or` of its **boolified operands**, spliced flat when an operand is already the same connective — *not* the operand-preserving `$cond` that value position emits. This gives the same answer (`a && b` read for truth means "a truthy AND b truthy"), but the `$cond` is invisible where nothing reads the returned operand, and wrapping it instead would repeat the whole chain once per falsy-value clause. Value position (`$set({ v: $.a && $.b })`) keeps the `$cond`.
- An expression is provably boolean when `kindOf` proves it so, from the registry alone: a boolean literal; a call, operator, or method whose row states `returns: "bool"` — a comparison and `!` are among them, each a production with its own row; `&&` / `||` whose every operand is itself provably bool; or a `jsmql.compile` parameter the call bound to a JavaScript boolean. When it is, the compiler skips the check, and mints the lowered value as a `Truth` unchanged, so `$.a > 1 ? 1 : 2` carries no test beyond the one the comparison already made.
- Constructs that are boolean only AFTER lowering have no bool-shaped node to inspect, and `lowerTruth` reads them structurally instead: a `&&` / `||` chain, a `!`, a `?:`, and an `ExprBlock` — an inlined reusable function or IIFE — each read for truth through its own parts, and each returned as a `Truth`.

**Codegen rules:**

| Construct | Output |
|---|---|
| `Boolean(x)` | the truth test — the bare value when `x` is already boolean |
| `!x` | `{$not: <truth of x>}`; `!!x` → the truth test of `x` |
| `a ? b : c` | `{$cond: {if: <truth of a>, then: b, else: c}}` |
| `a && b` (all-bool chain) | `{$and: [...operands]}` (cheap form) |
| `a && b` (mixed chain, pure-ref or bool LHS) | `{$cond: {if: <truth of a>, then: b, else: a}}` (operand-preserving) |
| `a && b` (mixed chain, expensive LHS) | `$let` binds `v = a`, then `$cond` on `$$v` (no double-eval). `v` gensyms against in-scope lambda params (and is MongoDB-valid — lowercase lead). |
| `a \|\| b` | mirror of `&&` with `$cond` branches swapped |
| `arr.filter(p)` etc. | the predicate body through the truth test |

Direct operator escapes (`$toBool($.x)`, `$op($and, …)`, `$cond({…})`) bypass these wrappers, because they are explicit MongoDB semantics.

`a ?? b` keeps the existing `$ifNull` codegen, because JS's `??` already matches MongoDB's null/undefined-fallback behaviour.

## `in` operator — RHS validation

The parser reads the `in` operator like any relational operator, but **codegen validates the right-hand side**: if the RHS is a scalar literal (`StringLiteral`, `NumberLiteral`, `BooleanLiteral`, `NullLiteral`), codegen throws:

```
Right-hand side of 'in' must be an array literal or field reference, not a scalar value
```

Array literals, field refs, operator calls, and any other expression are accepted. This catches the common mistake `$.x in "value"` at transpile time, instead of producing silently invalid MQL.

## What is NOT supported

- Assignment expressions (`$.a = $.b + 1`)
- Control flow (`if`, `for`, `while`)
- `class` or prototype methods
- Destructuring assignment (`{ a } = obj`). A destructured *parameter* of plain names — `([a, b]) => …`, `({ a, b: c }) => …`, with elisions — is read by `param()` in `src/compiler/parse/parser.ts` and rewritten at parse time to one fresh parameter whose parts replace the names in the body (`replaceIdents`), so no later phase sees a pattern; a default, a rest element, a nested pattern or a computed key is refused
- `JSON.stringify`/`JSON.parse` — no MQL primitive
- `<<`, `>>`, `>>>` (bitwise shifts) — no MQL primitive
- `Number.isFinite()` — MQL has no Infinity literal that can be referenced cleanly
- `Set.prototype.symmetricDifference` and `.isDisjointFrom` — no direct MongoDB equivalent (compose manually via `$setDifference` + `$setUnion`)
- `Array.from(…)` in every form — `$range(0, n)` is the range, and `.map(…)` on an array you already hold is the rest; one capability gets one spelling
