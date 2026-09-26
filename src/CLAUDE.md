# src/ — implementation notes

## Layout

```
string  →  compiler/lex  →  compiler/parse  →  compiler/passes (fold, desugar, position, shape, inject)  →  compiler/emit  →  MQL JSON
                                                              ↑ every fact read from  src/registry/
```

- [`registry/`](registry/CLAUDE.md) is the single source of truth: one row per name, production and lexeme, in one vocabulary. It imports nothing outside itself and builds no MQL for a construct that needs its neighbours.
- [`compiler/`](compiler/CLAUDE.md) is the five phases over the registry. A phase asks a row; it never lists names of its own.
- `index.ts` is the public API. It is the `jsmql` callable and its properties. It reads the caller's input — a string, an arrow or a template tag. It turns the input into source and injected values. It picks the root position: a Filter, a Pipeline, an expression or an update document. See docs/specs/position-pass.md. It maps the compiler's errors to `validate()` results. It lowers nothing itself.
- `cli.ts` and `mongoose.ts` call `jsmql` and nothing below it.
- `errors.ts`, `namespace.ts` and `levenshtein.ts` are leaves the compiler shares. Each imports nothing.
- `bson.ts` is the one module that names `bson`, a peer dependency. So the value JSMQL emits is the caller's own class. It builds values with the real classes. It recognises a value with `instanceof` or with the `_bsontype` tag, so a value from a second copy of `bson` still counts. It also re-exports the registry's realm-independent recognisers: `isDate`, `isRegExp`, `isBytes` and `isPlainObject`. No module tests a value with `instanceof Date` or against `Object.prototype`, because a value from another realm fails both tests — `test/cross-realm.test.ts` holds the line. See docs/specs/bson-types.md § Recognition across realms.
- `stringify.ts` is the one MQL printer. It turns a compiled document into the JavaScript code that rebuilds it. It is also a leaf, and the only text form of a document anywhere: the CLI, both site pages, the expectation rewriters and one compiler refusal all read it, and none of them holds a copy. See docs/specs/mql-stringify.md.
- `globals.ts` is generated from the registry rows and the vendored MQL spec, by `scripts/generate-globals.mjs`. Never edit it by hand.

## Invariants

- **`src/` stays in TypeScript's strippable subset.** The source runs on Node 22.18+ and 24.3+ through native type-stripping, with no flag and no transpiler, and it also runs on Deno and on Bun. Do not use `enum` (use `as const` objects and derived unions instead). Do not use `namespace`. Do not use parameter properties in constructors. Do not use decorators. Do not use `<T>x` casts (use `x as T` instead). Do not use `import =` or `export =`. Internal imports use `.ts` extensions. `node src/index.ts` must run without errors; `test/smoke.test.ts` holds the line.
- **The public API is a callable with attached properties, built with `Object.assign`.** `index.ts` exports one `jsmql` value that is callable and carries `compile`, `validate`, `expr`, `filter`, `pipeline`, `update` (each strict entry with its own `.compile`) and `stringify`. It is not a `namespace` — that construct is banned above. Extend `jsmql` the same way; never add a top-level named export for something that should be a property on `jsmql`.
- **An injected value is a value (HR1).** A `jsmql.compile` parameter or a template slot becomes a literal node when the source could have written that value directly, and an `Injected` node otherwise (`compiler/passes/inject.ts`): `"$b"` stays the string `"$b"` in a query and becomes `{ $literal: "$b" }` in an expression. The compiler never parses a value the caller supplies as syntax.
- **The three compiler namespaces live in `namespace.ts`.** `__jsmql.<bucket>.<name>` names document fields for what a stage passes to the next stage. `jsmql_<f|v|s><level>_<hint>` names correlation variables in `$lookup.let`. `jsmql<Hint>` names expression variables. The Env mints these so they never collide with a developer's parameter. Add a temporary variable through these helpers, never as a fresh top-level `__` field.
- **Never guard raw MQL.** A hand-written `$op(...)` call, stage document or query document passes through as written (HR2). This is true even where one particular deployment would refuse it. The compiler refuses a shape only when every deployment refuses it, and that refusal is a fact stated on the row. A call settles to a constant only where its row states `foldsAs`, for example `$size([1, 2, 3])` → `3`; a raw document never settles.

## Error classes

These classes live in `errors.ts`, a leaf: `CodegenError` (with `.pos`), `UnknownIdentifierError` (a `CodegenError`), and `internalError(detail)`. Use `internalError(detail)` for an invariant a phase must uphold; its message says "please report". `compiler/lex` throws `LexError`. `compiler/parse` throws `ParseError`. Both carry `.pos`. `index.ts` maps all of these to `ValidationError` objects for `validate()`, and adds two of its own. `FunctionInputError` (a `ParseError`, with `.pos`) fires when the arrow-form input is not an arrow, or carries an illegal parameter destructure. `JsmqlInterpolationError` (`.slot` / `.key`, `.pos = 0`) fires for a template slot or parameter with no MQL representation.
