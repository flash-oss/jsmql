# Function-form parameter bindings (`jsmql.compile`)

## Purpose

How `jsmql.compile(fn)` lowers a parameterised arrow function to a reusable MQL builder. The companion user-facing reference is [`docs/LANGUAGE.md` § Parameterised Queries](../LANGUAGE.md#parameterised-queries-jsmqlcompile).

`jsmql.compile` exists so a query with dynamic values, such as a minimum age, a region filter, or an allowed-status list, can parse once and re-bind on every call. It is the function-form counterpart to template-tag interpolation. It has the same value-inlining meaning but a typed surface. The destructure pattern of the arrow names each binding, and TypeScript can flow types from the params object to each identifier in the body.

Every rule below applies the same way to the strict-shape `.compile` builders (`jsmql.filter.compile`, `jsmql.pipeline.compile`, `jsmql.update.compile`, `jsmql.expr.compile`). They share the one parametric engine (`makeCompile(lower, apiName)` in [`src/index.ts`](../../src/index.ts)), and differ only in the `lower` callback they run and the output type they narrow to. See [strict-shape-entries.md § Parameterised form](strict-shape-entries.md#parameterised-form-compile).

## Accepted input

`jsmql.compile()` accepts either an arrow function or a **string** that contains the arrow source text. The function form goes through `Function.prototype.toString.call` to get the source; the string form passes through unchanged. Both paths converge on the same `Parser.parseEntry()` call, so every rule below applies to each the same way. A string with no arrow shape gives the same `FunctionInputError` that the function-form path would raise. The message names the arrow form that the entry takes. Anything that is neither a function nor a string throws `TypeError` from the entry point in [`src/index.ts`](../../src/index.ts).

JSMQL supports no placeholder syntax inside the string (`${name}`, `$1`, and so on). The destructure pattern is the one way to declare a parameter. See [ADR 0155](../adr/0155-compile-string-placeholder.md).

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

> The toolbox slot is types-only convenience. The **preferred way** to get IDE autocomplete is `import "@koresar/jsmql/globals"` (see [`globals-generation.md`](globals-generation.md)), which makes every stage and operator an ambient global. You do not list them per call site. When you list `$` (and any operator) in the toolbox, the arrow type-checks even without that import.
> The toolbox type `JsmqlToolbox` is `any`, so an arrow declared separately from the call also type-checks. See [ADR 0038](../adr/0038-index-entry-mechanics.md).

When both slots appear, the only legal order is `(params, { $, … })`. A shorter combination also works: `(params)`, `({ $, … })`, and `()`. Anything else, such as a third slot, a bare-identifier or bare-`$` slot, or the toolbox before params, throws `FunctionInputError`. The error states the actual and expected shape.

## Parser

`parseEntry(source)` in [`src/compiler/parse/parser.ts`](../../src/compiler/parse/parser.ts) returns an `EntryForm` — `{ params, toolbox, program }` — where `params` and `toolbox` are each a list of `ParamBinding`. It reads the parameter slots, then reads the body exactly as it reads any other program.

A slot is one `{ … }` destructure and nothing else:

- An `LBrace` opens one; its keys, not its position, decide which list it fills.
- A bare `Ident`, or a bare `$` / `$$` / `$$$` / `$$$$` token, gives an immediate `FunctionInputError`: a parameter must be an object destructure (`({ $ }) => …`).
- An `LBracket` gives an immediate `FunctionInputError` (JSMQL rejects array destructure).

Each key of the `{ … }` body is either `Ident` (a params key) or a `$`-prefixed toolbox key: the bare `$` (a lone `Dollar`), an operator `$name` (`Dollar` + `Ident`), or a context ref `$$` / `$$$` / `$$$$` (`DoubleDollar` / `TripleDollar` / `QuadDollar`). For each entry it also handles:

- `key: alias` — sets the binding's `name` field to the alias (params keys only; the parser strips an alias on a toolbox key, because it matters only for autocomplete, and the original key already provides that).
- `key = expr` — the compiler rejects it with the explanatory message, whatever `expr` is. See [§ Defaults](#defaults).
- `...rest`, a nested pattern, an array pattern — each rejected with its own targeted message.
- Mixed `$`-and-non-`$` keys in the same destructure — rejected; the params and toolbox destructures stay separate slots.

A `ParamBinding` is `{ key: string; name: string }`:
- `key` is the property looked up on the params object at call time (the *outer* destructure key).
- `name` is the identifier used inside the function body (the *inner* alias, or the same as `key` when there is no rename).

The slot-ordering validator runs after the slots are collected. A slot count above 2 throws immediately. Each slot kind may appear at most once. The order must be `(params, { $, … })`, with params before the toolbox.

### Defaults

The compiler refuses every default in the params destructure, whatever its expression. **The only way a value reaches a compiled query is through the params object at call time.** For a run-time fallback, the user writes `q({ minAge: input ?? 18 })`. For a fixed value, the template tag inlines a literal (`` jsmql`$.age > ${18}` ``). See [ADR 0154](../adr/0154-compile-defaults-refused.md) for the alternatives that the project rejected.

## Lowering

A parameter is a VALUE, never syntax. `inject` in [src/compiler/passes/inject.ts](../../src/compiler/passes/inject.ts) runs before the fold. It replaces every identifier that the params destructure of the arrow names with the value that the call supplied. The value becomes a literal node when the source could have spelled it (a number, a string, a boolean, `null`, a Date, an ObjectId, an array or object of such values). Otherwise it becomes an `Injected` node ([src/registry/ast.ts](../../src/registry/ast.ts)). From there the value is an ordinary constant. The fold folds it, the filter road compares it natively (`$match($.age >= minAge)` with `{ minAge: 21 }` → `{ $match: { age: { $gte: 21 } } }`), a member read on an object parameter reads the value (`q.min`), and a value that reads as MQL goes through HR1's gate: see [aggregation-stages.md § `$`-string pass-through](aggregation-stages.md). The compiler recognises the value by what it is, never by the realm that made it: a Date from a `vm` context or a test runner's sandbox rides the same road as one from this realm ([bson-types.md § Recognition across realms](bson-types.md#recognition-across-realms)).

### The value the driver sends

The compiler must see the value that the server gets, so `jsmql.stringify` prints
that value too. `driverValue` in [src/index.ts](../../src/index.ts) walks each
parameter and each template slot before `inject`, and it makes the conversions
that the driver makes when it sends a document:

- A value with its own `toBSON()` becomes the value that `toBSON()` gives. The
  driver calls it once per value, and so does the walk. A mongoose document,
  subdocument, array and Buffer each have one.
- A Map becomes a document of its entries. A key that is not a string is
  refused, because the driver sends each key as a field name.
- Any other object with no internal slot becomes a document of its own
  enumerable fields. A plain object that the walk does not change stays the same
  object.

A Date, a RegExp, a Uint8Array and a BSON value pass as they are. The walk refuses
every other built-in object, for example a Set, an Error, an ArrayBuffer, a boxed
primitive or a typed array other than Uint8Array. The driver sends such an object
as `{}` or as index keys, which is never its data. The walk also refuses an object
that only sets `Symbol.toStringTag` to "Date", "RegExp" or "Map". `bson` finds
these three kinds by the tag alone, so it sends such an object as that kind. The walk also refuses
`undefined`, a function, a symbol, a number that is not finite, an Invalid Date, and a cycle.
The driver sends an Invalid Date as the epoch, so a comparison with it would answer with
no error.

### Shadowing

A callback parameter inside the body shadows a parameter of the same name, as JavaScript's own scoping rule says: `.map(x => x * 2)` in a body with `{ x }` bound reads the callback's `x`. A `let` of a parameter's name is JavaScript's own error (a second declaration of the name), so it never reaches the compiler.

## index.ts — entry points

[`src/index.ts`](../../src/index.ts) exposes `jsmql` as a callable with attached properties built through `Object.assign`, because the strippable-TS rule in [src/CLAUDE.md](../../src/CLAUDE.md) forbids `namespace`:

```
jsmql                     // one-shot: string / function / template tag
jsmql.compile(fn)         // parameterised, reusable
jsmql.validate(input)     // { valid, errors } instead of a throw
```

`jsmql.validate` accepts every shape that `jsmql.compile` accepts. It also accepts the one-shot string / function / template-tag shapes of `jsmql()`. So editor tooling can check a parameterised arrow before it passes the arrow to `jsmql.compile`. The check binds each parameter to a value of no known kind (`ParameterValue` in [src/index.ts](../../src/index.ts)). The check does not bind `null`, because each slot that takes a value other than `null` refuses `null` (HR7). The call can pass a value of the kind that the slot takes. See [types.md](types.md#the-kind-check).

`jsmql.compile` resolves the arrow source and parses it once. The source is the trimmed text of `Function.prototype.toString.call` for a function input. For a string input, the source is the string as given, with no trim, so `.pos` counts from its first character, as in `validate()`. `parseEntry` gives the params, the toolbox names and the program. The returned closure, on each call:

1. Looks each destructured key up on the params object. It refuses a missing key by name, and the message shows the call that passes it.
2. Checks each value (`checkValue`, shared with the template tag): it refuses `undefined`, a function, a symbol, a non-finite number, an Invalid Date and a circular structure, by slot (`JsmqlInterpolationError`, with the key on `.key`).
3. Injects the values, folds, desugars, positions, and lowers through the same `lowerMode` the one-shot entry uses ([strict-shape-entries.md](strict-shape-entries.md)), so it shapes and refuses a compiled program as it does the one-shot form.

`jsmql.compile(fn)` is the parse-once-bind-many surface: each compiled callable captures the parsed program in its closure, so a repeated call injects a fresh value into the same tree. The one-shot `jsmql(fn)` form re-parses on every call.

### Error mapping

`jsmql.validate()` turns every compiler error class into a `ValidationError` with a `.pos`. The compile *invocation* path throws instead, because a call-time failure, such as a missing or refused value, is the caller's error, not a source error.

The inject pass spells each value at the position of the name that the value replaces. So the refusal of a value carries the offset of that name in the arrow's source:

```js
jsmql.expr.compile(({ start }, { $ }) => $.a.slice(start))({ start: null })
// ✗ a null in an integer slot; .pos is the offset of `start` in `$.a.slice(start)`
```

## Validation rules summary

| When | Failure mode | Error class |
|------|--------------|-------------|
| `jsmql.compile(fn)` (parse time) | Default in destructure | `FunctionInputError` |
| `jsmql.compile(fn)` (parse time) | Nested / rest / array destructure | `FunctionInputError` |
| `jsmql.compile(fn)` (parse time) | Mixed `$`/non-`$` keys | `FunctionInputError` |
| `jsmql.compile(fn)` (parse time) | > 2 params, bare-identifier slot, or wrong slot ordering | `FunctionInputError` |
| Compiled callable (bind time) | Body references binding not in params | `UnknownIdentifierError` |
| Compiled callable (bind time) | Param value with no MQL form (see § The value the driver sends) | `JsmqlInterpolationError` |
| Compiled callable (bind time) | `let <name>` shadows binding (defensive) | `CodegenError` |

JSMQL allows an extra key on the params object that the body never references. So a partial-coverage refactor does not need to keep the params type in sync with the body by hand.

## Test coverage

[`test/codegen.test.ts`](../../test/codegen.test.ts) carries the `describe("jsmql.compile()")` block: simple, array, and object bindings; aliased destructure; lambda-param shadow; `$match` index-friendly path with bindings; pipeline integration; sub-pipeline boundary; missing-binding errors; defaults rejection; malformed destructure; slot orderings; unsafe param values.

[`test/realistic.test.ts`](../../test/realistic.test.ts) carries the `eligibleUsersQuery` example — a real e-commerce-style two-stage pipeline reused across calls.
