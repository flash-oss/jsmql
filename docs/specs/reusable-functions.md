# Reusable named functions

**Status:** implemented (arrow form + the `function` keyword — see § The `function` keyword).

How `const <name> = (params) => <body>;` declares a reusable function that is
**not** lowered at the declaration, and how a call `name(args)` expands the body
INLINE at the call site as an IIFE → MongoDB `$let`.

User-facing reference is in [LANGUAGE.md](../LANGUAGE.md) § Reusable functions.

## The one-line idea

A reusable function is a **named [IIFE](emit-pass.md)**. Calling it is sugar for
`((params) => body)(args)`, and JSMQL already lowers that to `$let`. So the feature
reuses the whole IIFE → `$let` machinery. The only new parts are *naming* a lambda
and *resolving a call* back to it.

This gives the feature three properties:

1. **Declared, not lowered.** A declaration emits no MQL. It registers
   `name → lambda` in a compile-time table and is otherwise erased.
2. **Lowered on use.** A call expands the stored body through the IIFE path.
3. **Re-lowered per use.** Each call site runs the expansion on its own, so two
   calls produce two separate `$let` blocks (no hoisting, no CSE). The same input
   always gives the same output, with no data-dependent shape drift.

```js
const double = (x) => x * 2;
$ = { a: double($.price), b: double($.cost) };
```
→
```json
[{ "$replaceWith": {
    "a": { "$let": { "vars": { "x": "$price" }, "in": { "$multiply": ["$$x", 2] } } },
    "b": { "$let": { "vars": { "x": "$cost" },  "in": { "$multiply": ["$$x", 2] } } } } }]
```

## The fork rule (declaration vs `let` binding)

`const`/`let` already declares a [pipeline-scoped value binding](let-bindings.md)
(`const total = $.amount * 1.1` → a `$set` stage). The initialiser alone
distinguishes the two:

| Initialiser | Node | Lowering |
|---|---|---|
| an arrow function (`(a) => …` / `a => …`) | `FuncDecl` | none (registered, expanded on call) |
| anything else (`$.x`, `5`, `$op(…)`, …) | `LetDecl` | a `$set { __jsmql.var.<name>: … }` stage |

The fork is syntactic. There is no data dependence and no heuristic, so a JS
developer's mental model — "a `const` holding a function" against "a `const`
holding a value" — maps directly. Both keywords (`const`/`let`) work. `kind` is
recorded on the node but has no behavioural effect for a function, because a
function is not reassignable and is not a value.

The fork is per DECLARATOR, so a [declaration list](let-bindings.md#declaration-lists)
may hold a function beside a value, and a later declarator may call an earlier
function: `const double = (x) => x * 2, v = double($.p);` declares a `FuncDecl` and
a `LetDecl`, exactly as the two `;`-separated statements do.

## AST

Two additions in [src/registry/ast.ts](../../src/registry/ast.ts):

```ts
type Lambda   = Extract<Expr, { type: "Lambda" }>;            // the arrow node, reusable standalone
type FuncDecl = { type: "FuncDecl"; name: string; lambda: Lambda; kind: "let" | "const"; form: "arrow" | "function"; pos: number };
```

`PipelineStmt` and `ArrayElement` are both widened to include `FuncDecl` (parallel
to how `LetDecl` is admitted), so a declaration can appear either as a
`;`-separated statement or as an element in a bracketed `[…]` pipeline.

## Lexer

No new tokens. `function` is **not** a keyword; it lexes as an ordinary identifier,
so a `{ function: … }` object key and a `$.function` field path keep working. The
parser intercepts it *by value* only where a function expression or declaration can
start. See § The `function` keyword.

## Parser

[src/compiler/parse/parser.ts](../../src/compiler/parse/parser.ts):

- **`parseLetDecl()`** also recognises an **unparenthesised** single-param arrow
  right-hand side (`const f = x => …`), which `parseExpression` does not — only the
  parenthesised `(x) => …` form is recognised there, through `parsePrimary`'s
  `isLambdaStart`. Without this rule, `const f = x => …` fails with
  `Unexpected token '=>'`.
- **`declarator()`** holds the fork itself, so every dispatch site inherits it: the
  statement loop's declaration list (`bindings()`) and the bracketed pipeline's
  single element (`binding()`) alike. If the parsed initialiser is a `Lambda`, it
  returns a `FuncDecl`; otherwise it returns a `LetDecl`. The block-body-arrow path
  (`parseExprBlockBody`) does **not** fork, because a function declares only at the
  top level, so it rejects a nested arrow-valued binding there with a precise
  "declare at the top level" message.
- **`function`-keyword declaration** in `collectStatement()` / `parseArrayLiteral()`:
  a leading identifier `function` is parsed by `parseFunctionDeclStatement()` into
  the same `FuncDecl` node (`form: "function"`). See § The `function` keyword.
- **Outside-a-pipeline rejection**: a sole `FuncDecl` with no `;` (and not
  bracketed) throws `throwFuncDeclOutsidePipeline`, the same shape as the existing
  `let`-outside-pipeline rule.

## Lowering

### The binding

A declaration — `const f = (x) => …`, `function f(x) { … }` — emits no stage.
`statementStages` / `letStages` in
[src/compiler/emit/statement.ts](../../src/compiler/emit/statement.ts) bind the name
in the Env's scope as a `function` binding that holds the lambda
([let-bindings.md § Scope and resolution](let-bindings.md)). A second declaration of
the name, or a clash with a `let` / `const` / parameter, is refused with a
position-bearing error. The binding is pipeline-scoped like a `let`. A body over
the same documents (a `$facet` branch, a callback) reads it, and so does a
`$lookup` body, because the body is inlined at the call and reads nothing the call
site cannot.

### Call expansion

`callExpression` in [src/compiler/emit/lower.ts](../../src/compiler/emit/lower.ts)
dispatches on the callee: a name bound to a function expands it; a name bound to
anything else gives "Unknown function" with a `didYouMean` over the declared names;
a lambda takes the IIFE path. Both expansions run `applyLambda`. The lowering lowers
each argument in the CALLER's Env, binds each parameter once by `$let` so a
multiply-read argument is not computed twice, and lowers the body under them. A call
with no parameters binds nothing, so no `$let` wraps the body (`const two = () =>
$.a * 2; two()` → `{ $multiply: ["$a", 2] }`). Inside the body the function's own
name is bound to a refusal, so direct or mutual recursion is refused ("Recursive
function calls are not supported — a MongoDB expression cannot call itself …").

### Free-variable capture

A function body may reference more than its params — `$.field` (the document) or
an in-scope `let`. These resolve against the CALL SITE's Env, because that is
simply where the body is lowered. A pure-param function is the common case, and
capture of `$` and a `let` is a natural bonus, not a separate mechanism.

### Function-as-value

A reusable function used where a **value** is expected is refused with guidance
toward calling it, because MQL has no first-class function ([DEF-032]). Two sites:

- **bare value position** (`$ = { fn: double }`, `double + 1`): the identifier
  resolves to a `function` binding, and a function is not a value — "'f' is a
  reusable function — call it with 'f(...)'. A function cannot be used as a value …".
- **bare array-method callback** (`arr.map(double)`): the method's callback rule
  sees a name where it takes an arrow — "'.map((x[, i[, arr]]) => …)' takes an
  arrow with an expression body." — write `arr.map(x => double(x))`.

## Output stability

A pipeline whose only addition is an **uncalled** function declaration produces
**byte-identical** MQL to the same pipeline without it, because the declaration is
erased and contributes no `__jsmql` namespace. The `$let` shape appears only at a
call site, exactly as for a hand-written IIFE.

## Errors

| Situation | Message gist |
|---|---|
| Wrong argument count | ``Function 'add': expected 2 argument(s) for params (a, b), got 1.`` |
| Direct/mutual recursion | ``Recursive function calls aren't supported …`` |
| Call to an undeclared name | ``Unknown function 'comput(...)'. Did you mean 'compute(...)'? …`` |
| Function used as a value | ``'double' is a reusable function — call it with 'double(...)' …`` ([DEF-032]) |
| `function` body without `return` | ``A block body must end with a `return <expr>` statement …`` |
| Generator `function*` | ``jsmql does not support generator functions (`function*`) …`` |
| `function` predicate with local bindings | *accepted* — the bindings become the `$let` the predicate's `$expr` rides in |
| Re-declaration / name clash | ``Function `f` is already declared earlier in this pipeline …`` |
| Nested declaration in an arrow body | ``Reusable functions must be declared at the top level of a pipeline …`` |
| Declaration with no pipeline | ``A reusable function declaration (…) is only valid inside a pipeline …`` |

Every one of these carries a meaningful `.pos`, so `validate()` underlines the
offending span.

## The `function` keyword

The JS `function` keyword is a **second spelling** of the same surface, accepted
everywhere an arrow is. It parses into the *same* `Lambda` / `FuncDecl` nodes, so
codegen stays unchanged; the whole feature lives in the front end (the parser)
only. `function` stays an ordinary identifier, not a lexer keyword, and the parser
intercepts it **by value**:

- **Value position** (`parsePrimary`, top of the `Ident` branch): `function [name]
  (params) { … }` → a `Lambda`. This covers an inline callback (`.map(function (x) {
  return x * 2 })`), an IIFE (`(function (x) { return x * 2 })(5)`), and `const f =
  function (x) { … }`. JS allows a name on a function expression, but the name is
  unreachable in MQL (no recursion), so the parser reads it and **discards** it —
  `.map(function scale(x){…})` behaves the same as the anonymous form.
- **Statement / array-element position** (`collectStatement` / `parseArrayLiteral`):
  `function name(params) { … }` → a `FuncDecl` with `form: "function"`, identical
  to `const name = (params) => …`.
- **Entry form** (`parseEntry`): `jsmql(function ({ $ }) { … })` /
  `jsmql.compile(function (params, { $ }) { … })`.

**Body grammar.** A `function` body reuses `parseExprBlockBody` — `{ (const|let
…;)* return <expr>; }`. A body whose only statement is `return E` is normalised to
a plain expression-body `Lambda` (`body: E`), so it is byte-identical to `(x) => E`
in **every** position, including the query-translation predicate positions
(`$$$.coll.find/filter`, `$$.filter`, stream `.filter`), which translate a `body`
expression. A body with leading `const`/`let` keeps the `exprBlock` (→ nested
`$let`); a query-predicate position rejects such a body, and the fix is to inline
the bindings.

**Self-termination.** A `function` declaration ends at its closing `}` (JS-style),
so the next statement may follow with **no `;`** — `function f(x){ return x*2 } $ =
{ … }`. `form: "function"` drives this in the statement loops (`parse`,
`parseBlockBody`, `parseCallbackBlock`); an array element still needs a
`,`-separator. A `function` declaration forces Pipeline mode, since it cannot be a
Filter, the same as `$ = …` and an arrow `FuncDecl`.

**Entry block-body reconciliation.** At the entry, a brace body that opens with
`return` is the value form (`{ return E }` behaves as `({ $ }) => E`); otherwise it
is the existing `;`-pipeline body. This rule applies to both `=> {` and
`function {`, and it also fixes the long-broken `({ $ }) => { return E }`.
`rejectReturn` rejects a stray statement-position `return` in a pipeline body, with
guidance.

Rejected (matching the arrow form): `async function` / `function*` (generator),
and a default, rest or destructured parameter.

## Deferred

- **Function-aware Filters through textual inline** ([DEF-031]) — a function in a
  bare Filter (no `;`) would inline into the predicate rather than bind through
  `$let`.
- **Higher-order functions** ([DEF-032]) — passing a function as a value.

## Tests

[test/compiler-statement.test.ts](../../test/compiler-statement.test.ts) and
[test/compiler-lower.test.ts](../../test/compiler-lower.test.ts) cover declaration +
call, every call-site context (object value, `$set`, `.map` lambda, `$match`,
template tag), multi/zero param, block-body + nested local `const`, free-var
capture, inter-function composition, output stability, both pipeline forms, and
every rejection above plus the `validate()` `.pos` round-trip.

[test/realistic.test.ts](../../test/realistic.test.ts) carries the order-pricing
example (`money()` reused across three fields), which doubles as the playground
example through the post-edit hook.
