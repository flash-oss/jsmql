# Function-form parameter bindings (`jsmql.compile`)

## Purpose

How `jsmql.compile(fn)` lowers a parameterised arrow function to a reusable MQL builder. The companion user-facing reference is [`docs/LANGUAGE.md` § Parameterised Queries](../LANGUAGE.md#parameterised-queries-jsmqlcompile).

`jsmql.compile` exists so a query whose values are dynamic — minimum age, region filter, allowed-status list — can be parsed once and re-bound on every call. It is the function-form counterpart to template-tag interpolation, with the same value-inlining semantics but a typed surface: bindings are named in the arrow's destructure pattern, and TypeScript can flow types from the params object straight through to each identifier in the body.

Every rule below applies identically to the strict-shape `.compile` builders (`jsmql.filter.compile`, `jsmql.pipeline.compile`, `jsmql.update.compile`, `jsmql.expr.compile`): they share the one parametric engine (`makeCompile(lower, apiName)` in [`src/index.ts`](../../src/index.ts)), differing only in the `lower` callback they run and the output type they narrow to. See [strict-shape-entries.md § Parameterised form](strict-shape-entries.md#parameterised-form-compile).

## Accepted input

`jsmql.compile()` accepts either an arrow function or a **string** containing the arrow source text. The function form goes through `Function.prototype.toString.call` to obtain the source; the string form is passed through unchanged. Both paths converge on the same `Parser.parseEntry()` call, so every rule below applies identically. A string without an arrow shape surfaces the same `FunctionInputError` the function-form path would have raised (`"jsmql expects an arrow function \`({ $ }) => …\` … as the function-form input."`). Anything that is neither a function nor a string throws `TypeError` from the entry point in [`src/index.ts`](../../src/index.ts).

Placeholder syntaxes inside the string (`${name}`, `$1`, etc.) are **not** supported — the destructure pattern remains the single parameter-declaration mechanism. Adding inline placeholders would violate the strict-JS-subset invariant (`${id}` is not valid JS outside a template literal) and silently collide with real template literals: a user writing `` jsmql.compile(`… ${id} …`) `` with backticks would have `id` resolved by JS before jsmql ever saw the string.

## Arrow signature

```
(params?, { $, …ops }?) => body
```

Two optional slots, each an **object destructure**. The parser classifies each by **shape**, not position:

| Slot shape | Interpretation |
|------------|----------------|
| Destructure with ≥1 non-`$` key (`{ minAge }`) | Params slot — names become bindings. |
| Destructure with only `$`-prefixed keys (`{ $ }`, `{ $, $match }`, incl. the context refs `$$` / `$$$` / `$$$$`) | Toolbox slot — the document root `$`, context refs, and operators; keys are discarded after parsing. See note below. |
| Bare identifier or bare `$` (`$`, `doc`) | **Rejected** — the document context must be destructured (`({ $ }) => …`). |

> The toolbox slot is types-only convenience; the **preferred way** to get IDE autocomplete is `import "@koresar/jsmql/globals"` (see [`globals-generation.md`](globals-generation.md)), which surfaces every stage and operator as an ambient global — no need to list them per call site. Listing `$` (and any op) in the toolbox lets the arrow type-check even without that import.

When both appear, the only legal order is `(params, { $, … })`. Shorter combinations: `(params)`, `({ $, … })`, and `()`. Anything else — a third slot, a bare-identifier / bare-`$` slot, or the toolbox before params — throws `FunctionInputError` with the actual and expected shape.

## Parser

[`src/compiler/parse/parser.ts`](../../src/compiler/parse/parser.ts) — `parseEntry` returns `{ program, bindings }` (type `FunctionInputResult`). The body is parsed exactly as today; the new work happens in `parseParameterList` (replacing the old `skipParameterList`).

`parseParameterList` walks each top-level slot inside the parens, calling `parseParameterSlot` for each:

- An `LBrace` token → `parseDestructureSlot`. Returns either `{ kind: "toolbox" }` or `{ kind: "params", bindings: ParamBinding[] }`.
- A bare `Ident` or bare `$` / `$$` / `$$$` / `$$$$` token → immediate `FunctionInputError`: a parameter must be an object destructure (`({ $ }) => …`).
- An `LBracket` → immediate `FunctionInputError` (array destructure rejected).

`parseDestructureSlot` walks the `{ … }` body. Each key is either `Ident` (params key) or a `$`-prefixed toolbox key — the bare `$` (a lone `Dollar`), an operator `$name` (`Dollar` + `Ident`), or a context ref `$$` / `$$$` / `$$$$` (`DoubleDollar` / `TripleDollar` / `QuadDollar`). For each entry it also handles:

- `key: alias` — sets the binding's `name` field to the alias (params keys only; aliases are stripped on toolbox keys because they only matter for autocomplete, which the original key already provides).
- `key = expr` — rejected with the explanatory message, regardless of what `expr` is. See [§ Why defaults are rejected](#why-defaults-are-rejected).
- `...rest`, nested patterns, array patterns — each rejected with its own targeted message.
- Mixed `$`-and-non-`$` keys in the same destructure → rejected; the params and toolbox destructures stay separate slots.

A `ParamBinding` is `{ key: string; name: string }`:
- `key` is the property looked up on the params object at call time (the *outer* destructure key).
- `name` is the identifier used inside the function body (the *inner* alias, or the same as `key` when there's no rename).

The slot-ordering validator runs after the slots are collected. Slot count > 2 throws immediately. Each slot kind may appear at most once; the order must be `(params, { $, … })` — params before the toolbox.

### Why defaults are rejected

Two alternatives were considered and rejected:

- **Allow only literal defaults** (`{ a = 1 }`, but not `{ a = config.x }`). Surface looks like normal JS, but silently fails on any non-literal default. The failure mode is arbitrary from a user's perspective — destructure defaults usually accept any expression. A user who writes `{ minAge = 18 }` and later refactors to `{ minAge = config.defaults.minAge }` would suddenly hit `FunctionInputError`. CLAUDE.md priority #1 forbids that kind of "subset surprise".
- **Evaluate defaults by stringify-then-`Function`-eval.** Lets arbitrary expressions through but reintroduces eval-style semantics into a compile-time API, and forces jsmql to take a position on how unrelated closure references resolve.

Rejecting defaults entirely keeps the rule simple and the surface honest: **the only way values reach a compiled query is through the params object at call time.** For a runtime fallback the user writes `q({ minAge: input ?? 18 })`; for a hardcoded value the template tag already inlines literals (`` jsmql`$.age > ${18}` ``).

## Lowering

A parameter is a VALUE, never syntax. `inject` in [src/compiler/passes/inject.ts](../../src/compiler/passes/inject.ts) runs before the fold: every identifier the arrow's params destructure is replaced by the value the call supplied — as a literal node when the source could have spelled it (a number, a string, a boolean, `null`, a Date, an ObjectId, an array or object of such), and as an `Injected` node otherwise ([src/registry/ast.ts](../../src/registry/ast.ts)). From there the value is an ordinary constant: the fold folds it, the filter road compares it natively (`$match($.age >= minAge)` with `{ minAge: 21 }` → `{ $match: { age: { $gte: 21 } } }`), a member read on an object parameter is a read of the value (`q.min`), and a `"$…"` string is wrapped in `$literal` wherever the server would evaluate it (HR1's gate — [aggregation-stages.md § `$`-string pass-through](aggregation-stages.md)).

### Shadowing

A callback parameter inside the body shadows a parameter of the same name, as JavaScript's scoping says: `.map(x => x * 2)` in a body with `{ x }` bound reads the callback's `x`. A `let` of a parameter's name is JavaScript's own error (`Identifier 'a' has already been declared`), so it never reaches the compiler.

## index.ts — entry points

[`src/index.ts`](../../src/index.ts) — `jsmql` is exposed as a callable with attached properties built via `Object.assign` (since the strippable-TS rule in [src/CLAUDE.md](../../src/CLAUDE.md) forbids `namespace`):

```
jsmql                     // one-shot: string / function / template tag
jsmql.compile(fn)         // parameterised, reusable
jsmql.validate(input)     // { valid, errors } instead of a throw
```

`jsmql.validate` accepts every shape `jsmql.compile` accepts (in addition to the one-shot string / function / template-tag shapes from `jsmql()`), so editor tooling can pre-flight a parameterised arrow before passing it to `jsmql.compile`; the parameters are stubbed to `null` for the check.

`jsmql.compile` resolves the arrow source — `Function.prototype.toString.call` for a function input, the trimmed string itself for a string input — and parses it once (`parseEntry` → the params, the toolbox names and the program). The returned closure, per call:

1. Looks each destructured key up on the params object. A missing key is refused, naming the key: "'minAge' is a parameter of this query and was not supplied. Pass it: jsmql.compile(fn)({ minAge: … })."
2. Checks each value (`checkValue`, shared with the template tag): `undefined`, a function, a symbol, a non-finite number and a circular structure are refused by slot (`JsmqlInterpolationError`, with the key on `.key`).
3. Injects the values, folds, desugars, positions, and lowers through the same `lowerMode` the one-shot entry uses ([strict-shape-entries.md](strict-shape-entries.md)), so a compiled program is shaped and refused exactly as the one-shot form is.

`jsmql.compile(fn)` is the parse-once-bind-many surface: each compiled callable captures the parsed program in its closure, so repeated calls inject fresh values into the same tree. The one-shot `jsmql(fn)` form re-parses on every call.

### Error mapping

`jsmql.validate()` turns every compiler error class into a `ValidationError` with a `.pos`; the compile *invocation* path throws, because a call-time failure (a missing or refused value) is the caller's error, not a source error.

## Validation rules summary

| When | Failure mode | Error class |
|------|--------------|-------------|
| `jsmql.compile(fn)` (parse time) | Default in destructure | `FunctionInputError` |
| `jsmql.compile(fn)` (parse time) | Nested / rest / array destructure | `FunctionInputError` |
| `jsmql.compile(fn)` (parse time) | Mixed `$`/non-`$` keys | `FunctionInputError` |
| `jsmql.compile(fn)` (parse time) | > 2 params, bare-identifier slot, or wrong slot ordering | `FunctionInputError` |
| Compiled callable (bind time) | Body references binding not in params | `UnknownIdentifierError` |
| Compiled callable (bind time) | Param value not JSON-safe | `JsmqlInterpolationError` |
| Compiled callable (bind time) | `let <name>` shadows binding (defensive) | `CodegenError` |

Extra keys on the params object that aren't referenced in the body are silently allowed — partial-coverage refactors don't need to keep the params type in sync with the body manually.

## Test coverage

[`test/codegen.test.ts`](../../test/codegen.test.ts) carries the `describe("jsmql.compile()")` block: simple, array, and object bindings; aliased destructure; lambda-param shadow; `$match` index-friendly path with bindings; pipeline integration; sub-pipeline boundary; missing-binding errors; defaults rejection; malformed destructure; slot orderings; unsafe param values.

[`test/realistic.test.ts`](../../test/realistic.test.ts) carries the `eligibleUsersQuery` example — a real e-commerce-style two-stage pipeline reused across calls.
