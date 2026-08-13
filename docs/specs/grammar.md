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

let_decl       = ("let" | "const") IDENT "=" expression
               (* pipeline-scoped local binding; see docs/specs/let-bindings.md.
                  `let` is reassignable (`name = …` later), `const` is not.
                  Only valid inside a pipeline (any `;`-separated form or a
                  bracketed `[...]` pipeline element). A top-level let/const in
                  expression mode is a parse error. *)

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
               | new_date_or_set | objectid_literal | date_now | array_static
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
FIELD_SEGMENT  = IDENT | "in" | "new" | "typeof"             (* see "Strict-JS-subset rule" — numeric segments use [n] *)

context_ref    = ( "$$" | "$$$" | "$$$$" )                   (* bare prefix tokens — collection / database / cluster *)
               (* parser sanity-guards: next token must be `.` or `[`.
                  Postfix `.name` / `[expr]` composes via the standard
                  postfix rule above. Codegen currently throws — the syntax
                  is reserved; semantics land in a future release. See
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
expr_block     = "{" (let_decl ";")* "return" expression [";"] "}"   (* lowers to nested $let *)
function_expr  = "function" IDENT? "(" [IDENT ("," IDENT)* ","?] ")" expr_block
               (* a function expression — the same node a block-body arrow
                  produces. An optional name is parsed and discarded (unreachable
                  in MQL). A single-`return` body normalises to a plain
                  expression body, so it is identical to `(x) => <expr>`
                  everywhere. `function` is not a keyword token — the parser
                  intercepts the identifier by value. *)

math_call      = "Math" "." MATH_METHOD "(" call_arg_list ")"
MATH_METHOD    = (* see `MathMethod` in src/ast.ts *)

math_const     = "Math" "." MATH_CONST
MATH_CONST     = (* see `MathConstant` in src/ast.ts *)

object_call    = "Object" "." OBJECT_METHOD "(" call_arg_list ")"
OBJECT_METHOD  = (* see `ObjectMethod` in src/ast.ts *)

type_cast      = TYPE_CAST_NAME "(" expression ","? ")"      (* exactly one arg; a lone trailing comma is allowed *)
TYPE_CAST_NAME = (* see `TypeCastOp` in src/ast.ts *)

type_cast_ref  = BARE_CAST_NAME                              (* bare callback shorthand, no `(` *)
BARE_CAST_NAME = "Boolean" | "Number" | "String"             (* see `BareCastOp` in src/ast.ts *)

number_static  = "Number" "." NUMBER_STATIC "(" expression ","? ")"
NUMBER_STATIC  = (* see `NumberStaticMethod` in src/ast.ts *)

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
  the input to pipeline mode (array output). Each `;`-separated chunk is
  lowered in isolation — adjacent update op statements never coalesce
  across `;`. A single trailing `;` is enough to trigger pipeline mode
  (`$.a = 1;` → `[{ $set: { a: 1 } }]`).
- `,` is the **in-stage update op separator**. Comma-grouped update ops
  share one stage and coalesce through the existing kind / read-after-write
  rules in `src/codegen.ts`.

Mixed forms compose naturally: in `$.a = 1, $.b = 2; $match(…)`, the `,`
keeps `a` and `b` in one `$set` stage, and the `;` adds the `$match` as
the next stage. Inside an explicit `[…]` pipeline, only `,` is valid (JS
syntax) and adjacent update op elements coalesce — that is the
documented difference between the two pipeline forms.

Implemented in `Parser.parse()` (top-level `;` loop) and
`generateImplicitPipeline` in `src/pipeline.ts`. `generatePipeline` (for
`[…]`) keeps coalescing across elements; `generateImplicitPipeline` (for
`;`-separated) does not.

## Strict-JS-subset rule

Every expression accepted by this grammar is also valid JavaScript syntax. Adding a production that JS would reject (e.g. `obj.0`, which is why `FIELD_SEGMENT` excludes `NUMBER`) is a violation of the project's [#2 priority](../../CLAUDE.md). When a feature seems to need JS-incompatible syntax, either find a JS-syntax-equivalent surface (bracket access for numeric indices, method calls for transformations) or expose it as a `$op(...)` call — `$op` is always valid JS because it's a function name.

## Trailing commas

Because JS allows a single trailing comma after the last element of any comma-separated list (`f(a, b,)`, `[1, 2,]`, `{ a: 1, }`, `(x, y,) => …`), the parser accepts one **everywhere a comma list appears** — call args (method / `$op` / `Math` / `Object` / `Date.UTC` / `new Date|Set`), array & object literals, destructure patterns, arrow / `function` parameter lists, the `jsmql.compile` `(params, { $, … })` signature, and the in-stage update-op chain (`$.a = 1, $.b = 2,`). The EBNF spells the `","?` on the core lists above and elides it on the fixed-arity built-ins (`type_cast`, `number_static`, `Array.isArray`, `objectid_literal`) where only a *lone* trailing comma is meaningful; a trailing comma never changes the parse, so output is byte-identical to the comma-free form (`$op({…})` ≡ `$op({…},)` stays object-style). A trailing comma is *not* a way to pass an extra argument: `Number(x, y)` still raises the fixed-arity error. Shared helpers `parseDelimitedList` / `parseCommaTail` / `consumeTrailingComma` in `src/parser.ts` enforce this uniformly.

## Function-form input is not part of the grammar

`jsmql()` and `validate()` are polymorphic: each accepts a string, a function (an arrow `({ $ }) => …` or a `function ({ $ }) { return … }`), or a template-tag invocation (see [architecture.md](architecture.md)). When given a function, an adapter in `src/index.ts` extracts the body via `Function.prototype.toString()` and feeds the body to the parser — the function wrapper itself never reaches the parser and is **not** described by this grammar. A `function ({ $ }) { return <expr> }` entry body is the value form (≡ `({ $ }) => <expr>`); a `function ({ $ }) { <stmts> }` body is the `;`-pipeline form (≡ `({ $ }) => { <stmts> }`). When called as a template tag, the adapter joins the literal chunks with `JSON.stringify`'d interpolations and feeds the resulting source to the parser. In every case the parser sees ordinary `expression`-conforming source, so this grammar covers all three call shapes.

## Template literals

A template literal is a sequence of literal chunks alternating with `${expr}` interpolations, delimited by backticks. The lexer emits a stream of tokens (`TemplateStart`, `TemplateChars`, `TemplateExprStart`, ..., `TemplateEnd`) and tracks brace depth across `${...}` regions so that an inner `}` returns the lexer to template-chunk mode rather than emitting `RBrace`. Templates may nest.

## Optional chaining

A `.` followed by `$<name>(` is a **chained stage call** (`$$.$match({…}).$limit(5)`), not a property access — the lexer emits `$match` as `Dollar` + `Ident`, so the parser consumes both and produces an ordinary `MethodCall` whose `method` is `"$match"`. Only the *call* form is a stage link: a bare `.$name` and an optional-chained `?.$name(…)` are both parse errors. Semantics and lowering: [aggregation-stages.md](aggregation-stages.md#chained-stage-calls).

`?.` is accepted everywhere `.` is. The parser produces the same `MemberAccess` / `MethodCall` / `IndexAccess` AST nodes — there is no separate "optional" node. This is sound because MongoDB's dotted-path semantics already null-pass through missing fields, so `$.a?.b` and `$.a.b` produce identical MQL.

## Numeric separators

Digit sequences may contain single `_` characters between two digits. The lexer rejects leading `_`, trailing `_`, and `__`. The parser sees the underscore-stripped numeric value.

## Comments

JavaScript-style comments are skipped by the lexer, with semantics identical to ECMAScript:

- `// …` to end-of-line (any of LF, CR, LSEP U+2028, PSEP U+2029) or EOF.
- `/* … */` block comments. Nesting is **not** supported — the first `*/` closes. Unclosed block comments raise a `LexError`.

Comments are trivia: they are discarded during tokenisation by `skipTrivia()` (which alternates whitespace and comment passes until neither makes progress) and never appear in the token stream or AST. They are valid anywhere whitespace is, including inside template `${…}` interpolations. They are **not** recognised inside string literals, regex literals, or template-literal quasi text — those are consumed atomically by `readString` / `readRegex` / `readTemplateChunk`.

## Spread

`...expr` is a valid construct anywhere positional args, array literal elements, or object literal entries appear. It is represented in the AST as a `SpreadElement`. Codegen handles spread in:

- Variadic operator/method calls — single spread → bare value; mixed → `$concatArrays`-wrapped per-arg
- `Math.min`/`Math.max` — same as variadic
- `Object.assign` — same
- Unknown operators — single spread passes through
- Array literals — `$concatArrays` with consecutive non-spread elements grouped into one literal-array operand; a lone `[...x]` returns `x` directly
- Object literals — `$mergeObjects` with consecutive non-spread entries grouped into one operand; a lone `{...x}` returns `x` directly

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

## Type-cast call vs bare reference

`Boolean`, `Number`, `String` are ambiguous between `type_cast` (call form, `Boolean(x)`) and `type_cast_ref` (bare callback, `arr.filter(Boolean)`). The parser disambiguates by 1-token lookahead in `parsePrimary()`:

- If the cast name is followed by `(`, parse as `type_cast`.
- Otherwise, if the name is in `BARE_CAST_NAMES` (`Boolean` / `Number` / `String`), parse as `type_cast_ref`.
- `parseInt` / `parseFloat` are not in `BARE_CAST_NAMES` — without `(` they fall through to the existing `parseTypeCast()` "Expected LParen" error. This is intentional: real-JS `arr.map(parseInt)` has the index-as-radix footgun, so users must write `x => parseInt(x)` to opt in.

A `type_cast_ref` is only meaningful as a callback to a higher-order array method. In any other position, codegen throws an actionable error directing the user to the call form.

## Context-sensitive `/` (regex vs divide)

`/` is context-sensitive. After a **value-ending token** (`Number`, `String`, `True`, `False`, `Null`, `Ident`, `RParen`, `RBracket`), `/` is a divide operator. After anything else (operator, opening delimiter, start of input), `/` starts a regex literal.

This matches the JavaScript lexer rules and enables `.match(/pattern/flags)`.

## Lambda syntax

Lambdas are first-class expressions valid in:
- Method call arguments: `.map(x => ...)`, `.filter((x) => ...)`, `.reduce((acc, x) => ..., init)`
- Operator call arguments: `$let({ vars }, (x) => body)`

A lambda appearing anywhere else (e.g. as a standalone expression) is a codegen error.

### Body: expression or block (JS-faithful `=> {`)

A lambda body is either an expression (`x => x * 2`) or a **statement-laden block** (`x => { … }`). jsmql follows JavaScript exactly: `=> {` **always** opens a block, so an object return must be parenthesised — `x => ({ k: v })`, never `x => { k: v }` (the latter is a labeled-statement block in JS). Two block grammars exist, selected by position:

- **Expression block** (`expr_block` above) — the default everywhere a lambda is a value (array methods, `$let`, IIFE, `Object.groupBy`, `Array.from`). It is `(const|let <name> = <expr>;)* return <expr>;` and lowers to a right-folded nest of `$let` (see [method-dispatch.md → Block-body arrows](method-dispatch.md#block-body-arrows--nested-let)). A bare `=> { k: v }` is rejected (no `return`), pointing at `=> ({ k: v })`; re-declaring a name, or omitting `return`, are likewise actionable errors.
- **Statement block** (`block_body`, the `$lookup`/facet sub-pipeline form) — parsed inside a stream-rooted callback whose method is in `STREAM_BLOCK_METHODS`, e.g. `$$$.<coll>.aggregate((o) => { … })` and `$$.filter(...)`. Its statements are stages/update ops, not a single `return`. Only `.aggregate` *keeps* them: for the JavaScript methods the grammar is shared so the stage rejection can name what was written, and a stage-free block folds back to the expression it returns. See [lookup-stage.md](lookup-stage.md) § Grammar and [method-dispatch.md](method-dispatch.md#callback-block-bodies).

The parser threads a `BlockArgCtx` (`{ kind: "expr" }` default, `kind: "pipeline"` for the lookup positions) from the method-call dispatch to decide which to parse. It also carries the receiver context — the `method` name and whether it was `streamRooted` — so a **statement block in an expression-block position** can be diagnosed for what it is. When `parseExprBlockBody` reaches its missing-`return` check and the next token is `$` (a stage call), `subPipelineBlockError` reports the real mistake instead of demanding a `return` the user never wanted: a `didYouMean` over `STREAM_BLOCK_METHODS` when the receiver was a stream (so the method name is the error — `.aggregat(o => { $group(…); })`), or "stage calls need a stream receiver" when it wasn't (`$.items.map(d => { $group(…); })`). A block with no stage call keeps the original message. `return` is a reserved keyword (lexed as its own token; still usable as a property name / object key, matching JS).

## `$let` with lambda

`$let(varsObject, lambda)` is a special positional form where the second argument is a lambda. The `vars` keys come from the **object literal** (the first argument); the lambda's parameters are added to scope so that references inside the body emit `$$paramName`. Lambda parameter names must match the keys in the object literal — when they do, the binding works:
```
$let({ d: $.price * 0.1 }, (d) => $.price - d)
→ { $let: { vars: { d: ... }, in: { $subtract: ["$price", "$$d"] } } }
```
A name mismatch (`$let({ x: ... }, (d) => ...)`) compiles, but emits a `$$d` reference with no `vars.d` binding — which MongoDB rejects at runtime. See `generateOperatorCall`'s `$let` intercept in `src/codegen.ts`.

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

When any operand of a `+` chain is **string-producing**, the entire chain emits `$concat` instead of `$add`. String-producing expressions: string and template literals, `String(x)` casts, `typeof x`, any `OperatorCall` in `STRING_OUTPUT_OPS`, any `MethodCall` to a method in `STRING_RETURNING_METHODS` — both sets are defined in `src/codegen.ts` — and recursively, a nested `+` chain with at least one string-producing operand.

## JS truthy/falsy semantics for `&&`, `||`, `!`, `?:`, `Boolean()`, predicate methods

The codegen helpers `jsBool(value)`, `isProvablyBool(expr)`, and `generateBool(expr, ctx)` (in `src/codegen.ts`) implement JavaScript's truthy/falsy rules over MQL primitives.

- `jsBool(value)` emits `{ $and: [{$ne:[{$ifNull:[v,null]},null]}, {$ne:[v,false]}, {$ne:[v,""]}, {$ne:[v,0]}] }`. The null-check operand is wrapped in `$ifNull(v, null)` so it catches **both** `null` and *missing*: a bare `$ne:[v,null]` does **not** match missing — MongoDB's `$eq`/`$ne` treat a missing value as distinct from null (`{$eq:["$absent",null]}` is `false`), so without the wrap `arr.filter(x => x.f)` would wrongly keep elements where `f` is absent. `$ifNull` collapses missing → null first, matching JS where `undefined`/missing is falsy. The other three clauses compare the raw value (false/`""`/`0` are never "missing") and rely on type-bracketed comparison for the cross-type checks (e.g. `{$ne: ["abc", 0]}` is true). Empty array `[]` and empty object `{}` correctly stay truthy. NaN is treated as truthy — see "Truthy and falsy" in `LANGUAGE.md`.
- `generateBool(expr, ctx)` lowers an expression in **boolean position** — anywhere only its truthiness is observed. Every such position goes through it, so one rule covers the whole language: a `?:` test, `!`, `Boolean()`, `assert()`, a predicate lambda body (`genLambdaBoolBody`), the lodash predicate-run family (`resolvePredicate` — see `method-dispatch.md`), `.compact()`, and the `$match` / Filter residual (`mergeTranslatedQuery` — see `match-query-translation.md`). That is what makes `.compact()` identical to `.filter(Boolean)`, `.reject(p)` the exact complement of `.filter(p)`, and a stream `$$.filter(p)` agree with the value-mode `.filter(p)`.
- A `&&` / `||` chain in boolean position becomes `$and` / `$or` of its **boolified operands**, spliced flat when an operand is already the same connective — *not* the operand-preserving `$cond` that value position emits. Same answer (`jsBool(a && b)` is "a truthy AND b truthy"), but the `$cond` is invisible where nothing reads the returned operand, and wrapping it instead would repeat the whole chain once per falsy-value clause. Value position (`$set({ v: $.a && $.b })`) keeps the `$cond`.
- `isProvablyBool(expr)` returns true when an AST node always compiles to a boolean MQL value: `BooleanLiteral`; `UnaryExpr` op `!`; comparison `BinaryExpr` (`==`, `===`, `!=`, `!==`, `<`, `<=`, `>`, `>=`, `in`); `&&` / `||` whose every operand is itself provably bool; `TypeCast` cast `Boolean`; `OperatorCall` whose name is in `BOOL_OUTPUT_OPS` (registry-driven); `MethodCall` whose name is in `BOOL_RETURNING_METHODS`. When true the codegen elides the `jsBool` wrap.
- `isBoolValued(value)` asks the same of the **generated** value, for constructs that are boolean only after lowering and so have no bool-shaped AST to inspect: an inlined reusable function or IIFE (a `$let` whose body is a comparison), and a `jsmql.compile` parameter bound to a boolean. A sole key in `BOOL_OUTPUT_OPS`, a JS boolean, or a `$let` whose `in` is itself bool-valued all elide the wrap.

**Codegen rules:**

| Construct | Output |
|---|---|
| `Boolean(x)` | `jsBoolIfNeeded(x)` — bare value when `x` already bool |
| `!x` | `{$not: jsBoolIfNeeded(x)}`; `!!x` peephole → `jsBool(x)` |
| `a ? b : c` | `{$cond: {if: jsBoolIfNeeded(a), then: b, else: c}}` |
| `a && b` (all-bool chain) | `{$and: [...operands]}` (cheap form) |
| `a && b` (mixed chain, pure-ref or bool LHS) | `{$cond: {if: jsBoolIfNeeded(a), then: b, else: a}}` (operand-preserving) |
| `a && b` (mixed chain, expensive LHS) | `$let` binds `v = a`, then `$cond` on `$$v` (no double-eval). `v` gensyms against in-scope lambda params (and is MongoDB-valid — lowercase lead). |
| `a \|\| b` | mirror of `&&` with `$cond` branches swapped |
| `arr.filter(p)` etc. | predicate body wrapped in `jsBoolIfNeeded` |

Direct operator escapes (`$toBool($.x)`, `$op($and, …)`, `$cond({…})`) bypass these wrappers — they are explicit MongoDB semantics.

`a ?? b` keeps the existing `$ifNull` codegen — JS's `??` already matches MongoDB's null/undefined-fallback behaviour.

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
- `JSON.stringify`/`JSON.parse` — no MQL primitive
- `<<`, `>>`, `>>>` (bitwise shifts) — no MQL primitive
- `Number.isFinite()` — MQL has no Infinity literal that can be referenced cleanly
- `Set.prototype.symmetricDifference` and `.isDisjointFrom` — no direct MongoDB equivalent (compose manually via `$setDifference` + `$setUnion`)
- `Array.from(iterable)` (non-`{length}` form) — MQL has no general iterable-to-array primitive
