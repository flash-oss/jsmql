# Function-form parameter bindings (`jsmql.compile`)

## Purpose

How `jsmql.compile(fn)` lowers a parameterised arrow function to a reusable MQL builder. The companion user-facing reference is [`docs/LANGUAGE.md` § Parameterised Queries](../LANGUAGE.md#parameterised-queries-jsmqlcompile).

`jsmql.compile` exists so a query with dynamic values, such as a minimum age, a region filter, or an allowed-status list, can parse once and re-bind on every call. It is the function-form counterpart to template-tag interpolation, with the same value-inlining meaning but a typed surface: a binding is named in the arrow's destructure pattern, and TypeScript can flow types from the params object straight through to each identifier in the body.

Every rule below applies the same way to the strict-shape `.compile` builders (`jsmql.filter.compile`, `jsmql.pipeline.compile`, `jsmql.update.compile`, `jsmql.expr.compile`). They share the one parametric engine (`makeCompile(lower, apiName)` in [`src/index.ts`](../../src/index.ts)), and differ only in the `lower` callback they run and the output type they narrow to. See [strict-shape-entries.md § Parameterised form](strict-shape-entries.md#parameterised-form-compile).

## Accepted input

`jsmql.compile()` accepts either an arrow function or a **string** that contains the arrow source text. The function form goes through `Function.prototype.toString.call` to get the source; the string form passes through unchanged. Both paths converge on the same `Parser.parseEntry()` call, so every rule below applies to each the same way. A string with no arrow shape gives the same `FunctionInputError` the function-form path would raise (`"jsmql expects an arrow function \`({ $ }) => …\` … as the function-form input."`). Anything that is neither a function nor a string throws `TypeError` from the entry point in [`src/index.ts`](../../src/index.ts).

JSMQL does not support a placeholder syntax inside the string (`${name}`, `$1`, and so on); the destructure pattern stays the one parameter-declaration mechanism. An inline placeholder would break the strict-JS-subset invariant, because `${id}` is not valid JS outside a template literal, and it would silently collide with a real template literal: a user who writes `` jsmql.compile(`… ${id} …`) `` with backticks would have JS resolve `id` before JSMQL ever saw the string.

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

> The toolbox slot is types-only convenience. The **preferred way** to get IDE autocomplete is `import "@koresar/jsmql/globals"` (see [`globals-generation.md`](globals-generation.md)), which surfaces every stage and operator as an ambient global, with no need to list them per call site. Listing `$` (and any operator) in the toolbox lets the arrow type-check even without that import.

When both slots appear, the only legal order is `(params, { $, … })`. A shorter combination also works: `(params)`, `({ $, … })`, and `()`. Anything else, such as a third slot, a bare-identifier or bare-`$` slot, or the toolbox before params, throws `FunctionInputError` and states the actual and expected shape.

## Parser

`parseEntry(source)` in [`src/compiler/parse/parser.ts`](../../src/compiler/parse/parser.ts) returns an `EntryForm` — `{ params, toolbox, program }` — where `params` and `toolbox` are each a list of `ParamBinding`. It reads the parameter slots, then reads the body exactly as it reads any other program.

A slot is one `{ … }` destructure and nothing else:

- An `LBrace` opens one; its keys, not its position, decide which list it fills.
- A bare `Ident`, or a bare `$` / `$$` / `$$$` / `$$$$` token, gives an immediate `FunctionInputError`: a parameter must be an object destructure (`({ $ }) => …`).
- An `LBracket` gives an immediate `FunctionInputError` (JSMQL rejects array destructure).

Each key of the `{ … }` body is either `Ident` (a params key) or a `$`-prefixed toolbox key: the bare `$` (a lone `Dollar`), an operator `$name` (`Dollar` + `Ident`), or a context ref `$$` / `$$$` / `$$$$` (`DoubleDollar` / `TripleDollar` / `QuadDollar`). For each entry it also handles:

- `key: alias` — sets the binding's `name` field to the alias (params keys only; the parser strips an alias on a toolbox key, because it matters only for autocomplete, and the original key already provides that).
- `key = expr` — rejected with the explanatory message, regardless of what `expr` is. See [§ Why defaults are rejected](#why-defaults-are-rejected).
- `...rest`, a nested pattern, an array pattern — each rejected with its own targeted message.
- Mixed `$`-and-non-`$` keys in the same destructure — rejected; the params and toolbox destructures stay separate slots.

A `ParamBinding` is `{ key: string; name: string }`:
- `key` is the property looked up on the params object at call time (the *outer* destructure key).
- `name` is the identifier used inside the function body (the *inner* alias, or the same as `key` when there is no rename).

The slot-ordering validator runs after the slots are collected. A slot count above 2 throws immediately. Each slot kind may appear at most once, and the order must be `(params, { $, … })`, with params before the toolbox.

### Why defaults are rejected

The team considered and rejected two alternatives:

- **Allow only a literal default** (`{ a = 1 }`, but not `{ a = config.x }`). The surface looks like normal JS, but silently fails on any non-literal default. The failure mode looks arbitrary to a user, because a destructure default usually accepts any expression. A user who writes `{ minAge = 18 }` and later refactors to `{ minAge = config.defaults.minAge }` would then hit `FunctionInputError` with no warning. CLAUDE.md priority #1 forbids that kind of "subset surprise".
- **Evaluate a default by stringify-then-`Function`-eval.** This lets an arbitrary expression through, but brings eval-style meaning back into a compile-time API, and forces JSMQL to take a position on how an unrelated closure reference resolves.

Rejecting a default entirely keeps the rule simple and the surface honest: **the only way a value reaches a compiled query is through the params object at call time.** For a runtime fallback the user writes `q({ minAge: input ?? 18 })`; for a hardcoded value the template tag already inlines a literal (`` jsmql`$.age > ${18}` ``).

## Lowering

A parameter is a VALUE, never syntax. `inject` in [src/compiler/passes/inject.ts](../../src/compiler/passes/inject.ts) runs before the fold. It replaces every identifier the arrow's params destructure names with the value the call supplied: as a literal node when the source could have spelled it (a number, a string, a boolean, `null`, a Date, an ObjectId, an array or object of such values), and as an `Injected` node otherwise ([src/registry/ast.ts](../../src/registry/ast.ts)). From there the value is an ordinary constant. The fold folds it, the filter road compares it natively (`$match($.age >= minAge)` with `{ minAge: 21 }` → `{ $match: { age: { $gte: 21 } } }`), a member read on an object parameter reads the value (`q.min`), and a `"$…"` string is wrapped in `$literal` wherever the server would evaluate it (HR1's gate — [aggregation-stages.md § `$`-string pass-through](aggregation-stages.md)). The compiler recognises the value by what it is, never by the realm that made it: a Date from a `vm` context or a test runner's sandbox rides the same road as one from this realm ([bson-types.md § Recognition across realms](bson-types.md#recognition-across-realms)).

### Shadowing

A callback parameter inside the body shadows a parameter of the same name, as JavaScript's own scoping rule says: `.map(x => x * 2)` in a body with `{ x }` bound reads the callback's `x`. A `let` of a parameter's name is JavaScript's own error (`Identifier 'a' has already been declared`), so it never reaches the compiler.

## index.ts — entry points

[`src/index.ts`](../../src/index.ts) exposes `jsmql` as a callable with attached properties built through `Object.assign`, because the strippable-TS rule in [src/CLAUDE.md](../../src/CLAUDE.md) forbids `namespace`:

```
jsmql                     // one-shot: string / function / template tag
jsmql.compile(fn)         // parameterised, reusable
jsmql.validate(input)     // { valid, errors } instead of a throw
```

`jsmql.validate` accepts every shape `jsmql.compile` accepts, in addition to the one-shot string / function / template-tag shapes from `jsmql()`, so editor tooling can pre-flight a parameterised arrow before it passes the arrow to `jsmql.compile`. The check stubs each parameter to `null`.

`jsmql.compile` resolves the arrow source — `Function.prototype.toString.call` for a function input, the trimmed string itself for a string input — and parses it once (`parseEntry` gives the params, the toolbox names and the program). The returned closure, on each call:

1. Looks each destructured key up on the params object. It refuses a missing key by name: "'minAge' is a parameter of this query and was not supplied. Pass it: jsmql.compile(fn)({ minAge: … })."
2. Checks each value (`checkValue`, shared with the template tag): it refuses `undefined`, a function, a symbol, a non-finite number and a circular structure, by slot (`JsmqlInterpolationError`, with the key on `.key`).
3. Injects the values, folds, desugars, positions, and lowers through the same `lowerMode` the one-shot entry uses ([strict-shape-entries.md](strict-shape-entries.md)), so it shapes and refuses a compiled program exactly as it shapes and refuses the one-shot form.

`jsmql.compile(fn)` is the parse-once-bind-many surface: each compiled callable captures the parsed program in its closure, so a repeated call injects a fresh value into the same tree. The one-shot `jsmql(fn)` form re-parses on every call.

### Error mapping

`jsmql.validate()` turns every compiler error class into a `ValidationError` with a `.pos`. The compile *invocation* path throws instead, because a call-time failure, such as a missing or refused value, is the caller's error, not a source error.

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

JSMQL allows an extra key on the params object that the body never references, so a partial-coverage refactor does not need to keep the params type in sync with the body by hand.

## Test coverage

[`test/codegen.test.ts`](../../test/codegen.test.ts) carries the `describe("jsmql.compile()")` block: simple, array, and object bindings; aliased destructure; lambda-param shadow; `$match` index-friendly path with bindings; pipeline integration; sub-pipeline boundary; missing-binding errors; defaults rejection; malformed destructure; slot orderings; unsafe param values.

[`test/realistic.test.ts`](../../test/realistic.test.ts) carries the `eligibleUsersQuery` example — a real e-commerce-style two-stage pipeline reused across calls.
