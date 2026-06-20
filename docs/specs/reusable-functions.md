# Reusable named functions

**Status:** implemented (arrow form + the `function` keyword — see § The `function` keyword).

How `const <name> = (params) => <body>;` declares a reusable function that is
**not** lowered at the declaration, and how a call `name(args)` expands the body
INLINE at the call site as an IIFE → MongoDB `$let`.

User-facing reference is in [LANGUAGE.md](../LANGUAGE.md) § Reusable functions.

## The one-line idea

A reusable function is a **named [IIFE](method-dispatch.md)**. Calling it is
sugar for `((params) => body)(args)` — which jsmql already lowers to `$let`. So
the feature reuses the entire IIFE → `$let` machinery; the only new parts are
*naming* a lambda and *resolving a call* back to it.

This yields the three properties the feature is defined by:

1. **Declared, not lowered.** A declaration emits no MQL — it registers
   `name → lambda` in a compile-time table and is otherwise erased.
2. **Lowered on use.** A call expands the stored body through the IIFE path.
3. **Re-lowered per use.** Each call site runs the expansion independently, so
   two calls produce two separate `$let` blocks (no hoisting, no CSE). Same
   input → same output, always — no data-dependent shape drift.

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
(`const total = $.amount * 1.1` → a `$set` stage). The two are distinguished
**purely by the initialiser**:

| Initialiser | Node | Lowering |
|---|---|---|
| an arrow function (`(a) => …` / `a => …`) | `FuncDecl` | none (registered, expanded on call) |
| anything else (`$.x`, `5`, `$op(…)`, …) | `LetDecl` | a `$set { __jsmql.var.<name>: … }` stage |

The fork is syntactic — there is no data dependence and no heuristic — so a JS
developer's mental model ("a `const` holding a function" vs "a `const` holding a
value") maps directly. Both keywords (`const`/`let`) work; `kind` is recorded on
the node but has no behavioural effect for functions (they aren't reassignable —
they aren't values).

## AST

Two additions in [src/ast.ts](../../src/ast.ts):

```ts
type Lambda   = Extract<Expr, { type: "Lambda" }>;            // the arrow node, reusable standalone
type FuncDecl = { type: "FuncDecl"; name: string; lambda: Lambda; kind: "let" | "const"; form: "arrow" | "function"; pos: number };
```

`PipelineStmt` and `ArrayElement` are both widened to include `FuncDecl`
(parallel to how `LetDecl` is admitted), so a declaration can appear either as a
`;`-separated statement or as an element in a bracketed `[…]` pipeline.

## Lexer

No new tokens. `function` is **not** a keyword — it lexes as an ordinary
identifier (so `{ function: … }` object keys and `$.function` field paths keep
working). The parser intercepts it *by value* only where a function
expression/declaration can start. See § The `function` keyword.

## Parser

[src/parser.ts](../../src/parser.ts):

- **`parseLetDecl()`** additionally recognises an **unparenthesised** single-param
  arrow RHS (`const f = x => …`), which `parseExpression` does not (only the
  parenthesised `(x) => …` form is recognised there, via `parsePrimary`'s
  `isLambdaStart`). Without this, `const f = x => …` would fail with
  `Unexpected token '=>'`.
- **`parseDeclStatement()`** wraps `parseLetDecl()` at the two pipeline-statement
  dispatch sites (`collectStatement`, `parseArrayLiteral`): if the parsed
  initialiser is a `Lambda`, it returns a `FuncDecl`; otherwise a `LetDecl`. The
  block-body-arrow path (`parseExprBlockBody`) deliberately does **not** fork —
  functions are top-level-only, so a nested arrow-valued binding is rejected
  there with a precise "declare at the top level" message.
- **`function`-keyword declaration** in `collectStatement()` / `parseArrayLiteral()`:
  a leading identifier `function` is parsed by `parseFunctionDeclStatement()` into
  the same `FuncDecl` node (`form: "function"`). See § The `function` keyword.
- **Outside-a-pipeline rejection**: a sole `FuncDecl` with no `;` (and not
  bracketed) throws `throwFuncDeclOutsidePipeline` — same shape as the existing
  `let`-outside-pipeline rule.

## Codegen

[src/codegen.ts](../../src/codegen.ts).

### Context

Two fields on `GenerateCtx`:

```ts
functions?:   ReadonlyMap<string, FuncDecl>;  // declared functions in scope
expandingFns?: ReadonlySet<string>;            // the inline-expansion stack (recursion guard)
```

Both are preserved by every ctx-extending helper (`extendCtx`, `extendCtxLets`,
the inline `.reduce()` / `Object.groupBy()` lambda ctxs, `freshFacetCtx`) so a
function is callable inside nested lambda bodies and `$facet` branches.
`freshSubPipelineCtx` deliberately **omits** them — functions are pipeline-scoped
like `let`s and do not cross into `$lookup`/`$unionWith` sub-pipelines.

### Call expansion

`generateCallExpression` dispatches on the callee:

- **`ParamRef` naming a function** → expand. First the recursion guard: if the
  name is already in `expandingFns`, throw (a MongoDB expression can't recurse).
  Otherwise push the name onto `expandingFns`, extend the ctx with the params,
  and lower via the shared `applyLambda` helper.
- **`ParamRef` not naming a function** → "Unknown function" error with a
  `didYouMean` suggestion over the declared names.
- **`Lambda`** → the original IIFE path (anonymous), also via `applyLambda`.
- **anything else** → the "Direct call" rejection.

`applyLambda(lambda, args, argCtx, bodyCtx, pos, label)` is shared by both the
IIFE and named-function paths: arguments are generated in the **caller** ctx
(`argCtx`); the body is generated in `bodyCtx` (caller ctx + the params, plus —
for the named path — the recursion marker). Each param is bound once via `$let`,
so a multiply-read argument isn't recomputed. A zero-param lambda still emits
`{ $let: { vars: {}, in: … } }` (empty `vars` is server-valid, matching the IIFE
precedent).

### Free-variable capture

A function body may reference more than its params — `$.field` (the document) or
an in-scope `let`. These resolve against the **call-site** ctx (that's just where
the body is lowered). Pure-param functions are the common case; capture of `$`
and lets is a natural bonus, not a separate mechanism.

### Function-as-value

A reusable function used where a **value** is expected is rejected with guidance
toward calling it — MQL has no first-class functions ([DEF-032]). Two sites:

- **bare value position** (`$ = { fn: double }`, `double + 1`) hits the
  `ParamRef` codegen case. Resolution order there: reduce-remap → lambda param →
  pipeline `let` → function-form binding → **function-as-value error** →
  dropped-let → unknown identifier. The function check sits after lambda params,
  so a lambda param may legitimately shadow a function name inside its own body.
- **bare array-method callback** (`arr.map(double)`) is caught earlier, in
  `requireLambda` (the method runs before the `ParamRef` is reached as a value):
  it names the function and points at the lambda-wrap form `arr.map(x => double(x))`.

## Pipeline

[src/pipeline.ts](../../src/pipeline.ts) `lowerFuncDecl(decl, ctx)`:

- Emits **no stage**; returns `extendCtxFunctions(ctx, decl)`.
- Collision guards (mirroring `lowerLetDecl`): re-declaration, clash with a
  `let`/`const` binding, clash with a function-form parameter — each a
  position-bearing `CodegenError`.

All three pipeline-element loops (`generatePipeline` `[…]`,
`generateImplicitPipeline` `;`, `generatePipelineWithCtx` sub-pipeline `[…]`)
dispatch a `FuncDecl` to `lowerFuncDecl` before the `LetDecl` branch. In the
buffered `[…]` forms, the pending update-op buffer is flushed **before**
registering, so update ops written before the declaration can't see the function
(declaration-before-use) and ops after it can.

`isStageCandidate` admits `FuncDecl`, so `[const f = …, $set(…)]` is detected as
a pipeline. The lookup / union / out / match / stage-validation walkers all treat
a `FuncDecl` the same way they treat a `LetDecl` that contains no relevant
construct — skip / `null` / `false` / pass-through-unchanged — because a function
declaration produces no stage and its body is expanded only at call sites.

## Output stability

A pipeline whose only addition is an **uncalled** function declaration produces
**byte-identical** MQL to the same pipeline without it — the declaration is
erased and contributes no `__jsmql` namespace. The `$let` shape appears only at
call sites, exactly as for a hand-written IIFE.

## Errors

| Situation | Message gist |
|---|---|
| Wrong argument count | ``Function 'add': expected 2 argument(s) for params (a, b), got 1.`` |
| Direct/mutual recursion | ``Recursive function calls aren't supported …`` |
| Call to an undeclared name | ``Unknown function 'comput(...)'. Did you mean 'compute(...)'? …`` |
| Function used as a value | ``'double' is a reusable function — call it with 'double(...)' …`` ([DEF-032]) |
| `function` body without `return` | ``A block body must end with a `return <expr>` statement …`` |
| Generator `function*` | ``jsmql does not support generator functions (`function*`) …`` |
| `function` predicate with local bindings | ``predicate has a block body with local `const`/`let` bindings, which isn't supported in this position …`` |
| Re-declaration / name clash | ``Function `f` is already declared earlier in this pipeline …`` |
| Nested declaration in an arrow body | ``Reusable functions must be declared at the top level of a pipeline …`` |
| Declaration with no pipeline | ``A reusable function declaration (…) is only valid inside a pipeline …`` |

All carry a meaningful `.pos`, so `validate()` underlines the offending span.

## The `function` keyword

The JS `function` keyword is a **second spelling** of the same surface, accepted
everywhere an arrow is. It parses into the *same* `Lambda` / `FuncDecl` nodes, so
codegen is unchanged — the whole feature is front-end (parser) only. `function`
stays an ordinary identifier (not a lexer keyword), intercepted **by value**:

- **Value position** (`parsePrimary`, top of the `Ident` branch): `function [name]
  (params) { … }` → a `Lambda`. Covers inline callbacks (`.map(function (x) {
  return x * 2 })`), IIFEs (`(function (x) { return x * 2 })(5)`), and `const f =
  function (x) { … }`. JS allows naming a function expression, but the name is
  unreachable in MQL (no recursion), so it is parsed and **discarded** —
  `.map(function scale(x){…})` ≡ the anonymous form.
- **Statement / array-element position** (`collectStatement` / `parseArrayLiteral`):
  `function name(params) { … }` → a `FuncDecl` with `form: "function"`, identical
  to `const name = (params) => …`.
- **Entry form** (`parseFunctionInput`): `jsmql(function ($) { … })` /
  `jsmql.compile(function (params, $) { … })`.

**Body grammar.** A `function` body reuses `parseExprBlockBody` — `{ (const|let
…;)* return <expr>; }`. A body whose only statement is `return E` is normalised to
a plain expression-body `Lambda` (`body: E`), so it is byte-identical to `(x) => E`
in **every** position — including the query-translation predicate positions
(`$$$.coll.find/filter`, `$$.filter`, stream `.filter`) which translate a `body`
expression. A body with leading `const`/`let` keeps the `exprBlock` (→ nested
`$let`); such a body is rejected in a query-predicate position (inline the
bindings).

**Self-termination.** A `function` declaration ends at its closing `}` (JS-style),
so the next statement may follow with **no `;`** — `function f(x){ return x*2 } $ =
{ … }`. `form: "function"` drives this in the statement loops (`parse`,
`parseBlockBody`, `parseCallbackBlock`); array elements stay `,`-separated.
A `function` declaration forces Pipeline mode (it can't be a Filter), the same as
`$ = …` and arrow `FuncDecl`s.

**Entry block-body reconciliation.** At the entry, a brace body that opens with
`return` is the value form (`{ return E }` ≡ `($) => E`); otherwise it is the
existing `;`-pipeline body. This applies to both `=> {` and `function {`, which
also fixes the long-broken `($) => { return E }`. A stray statement-position
`return` in a pipeline body is rejected by `rejectReturn` with guidance.

Rejected (matching the arrow form): `async function` / `function*` (generator),
default / rest / destructured params.

## Deferred

- **Function-aware Filters via textual inline** ([DEF-031]) — functions in a bare
  Filter (no `;`) would be inlined into the predicate rather than `$let`-bound.
- **Higher-order functions** ([DEF-032]) — passing a function as a value.

## Tests

[test/functions.test.ts](../../test/functions.test.ts) covers declaration +
call, every call-site context (object value, `$set`, `.map` lambda, `$match`,
template tag), multi/zero param, block-body + nested local `const`, free-var
capture, inter-function composition, output stability, both pipeline forms, and
every rejection above plus the `validate()` `.pos` round-trip.

[test/realistic.test.ts](../../test/realistic.test.ts) carries the order-pricing
example (`money()` reused across three fields), which doubles as the playground
example via the post-edit hook.
