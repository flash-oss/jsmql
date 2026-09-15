# src/ — implementation notes

## Layout

```
string  →  compiler/lex  →  compiler/parse  →  compiler/passes (fold, desugar, position, shape, inject)  →  compiler/emit  →  MQL JSON
                                                              ↑ every fact read from  src/registry/
```

- [`registry/`](registry/CLAUDE.md) is the single source of truth: one row per name, production and lexeme, in one vocabulary. It imports nothing outside itself and builds no MQL for a construct that needs its neighbours.
- [`compiler/`](compiler/CLAUDE.md) is the five phases over the registry. A phase asks a row; it never lists names of its own.
- `index.ts` is the public API (the `jsmql` callable and its properties). It turns the caller's input — a string, an arrow, a template tag — into source and injected values, picks the root position (a Filter, a Pipeline, an expression, an update document — see docs/specs/position-pass.md), and maps the compiler's errors to `validate()` results. It lowers nothing itself.
- `cli.ts` and `mongoose.ts` call `jsmql` and nothing below it.
- `errors.ts`, `namespace.ts`, `levenshtein.ts` are leaves the compiler shares; each imports nothing.
- `bson.ts` is the one module that names `bson` — a PEER dependency, so the value jsmql emits is the caller's own class. It builds with the real classes and recognises with `instanceof` OR the `_bsontype` tag, so a value from a second copy still counts. See docs/specs/bson-types.md.
- `stringify.ts` is the one MQL printer — a compiled document as the JavaScript that rebuilds it. Also a leaf, and the only text form of a document anywhere: the CLI, both site pages, the expectation rewriters and one compiler refusal all read it, and none holds a copy. See docs/specs/mql-stringify.md.
- `globals.ts` is GENERATED from the registry rows and the vendored MQL spec (`scripts/generate-globals.mjs`) — never edit it by hand.

## Invariants

- **`src/` stays in TypeScript's strippable subset** — the source runs on Node 22.18+ / 24.3+ via native type-stripping (no flag, no transpiler), and on Deno and Bun. No `enum` (use `as const` objects + derived unions), no `namespace`, no parameter properties in constructors, no decorators, no `<T>x` casts (use `x as T`), no `import =` / `export =`. Internal imports use `.ts` extensions. `node src/index.ts` must execute without errors; `test/smoke.test.ts` holds the line.
- **Public-API shape: a callable with attached properties, built via `Object.assign`.** `index.ts` exports one `jsmql` value that is callable and carries `compile`, `validate`, `expr`, `filter`, `pipeline`, `update` (each strict entry with its own `.compile`) and `stringify`. Not a `namespace` — that is banned above. Extend it the same way; never add a top-level named export for what should be a property on `jsmql`.
- **An injected value is a VALUE (HR1).** A `jsmql.compile` parameter or a template slot becomes a literal node when the source could have spelled it, and an `Injected` node otherwise (`compiler/passes/inject.ts`): a `"$b"` stays the string `"$b"` in a query and `{ $literal: "$b" }` in an expression. Nothing a caller supplies is ever parsed as syntax.
- **The three compiler namespaces** live in `namespace.ts`: `__jsmql.<bucket>.<name>` document fields for what a stage threads to the next, `jsmql_<f|v|s><level>_<hint>` correlation variables in `$lookup.let`, and `jsmql<Hint>` expression variables minted through the Env so they never collide with a developer's parameter. Add a temporary through those helpers, never as a fresh top-level `__` field.
- **Never guard raw MQL.** A hand-written `$op(...)` call, stage document or query document passes through as written (HR2), even where a particular deployment would refuse it; only a shape every deployment refuses is refused, and that refusal is a fact on the row.

## Error classes

The classes live in `errors.ts`, a leaf: `CodegenError` (with `.pos`), `UnknownIdentifierError` (a `CodegenError`), and `internalError(detail)` for an invariant a phase must uphold (its message says "please report"). `compiler/lex` throws `LexError`, `compiler/parse` throws `ParseError` — both with `.pos`. `index.ts` maps all of them to `ValidationError` objects for `validate()`, and adds two of its own: `FunctionInputError` (a `ParseError`, with `.pos`) when the arrow-form input is not an arrow or carries an illegal parameter destructure, and `JsmqlInterpolationError` (`.slot` / `.key`, `.pos = 0`) for a template slot or parameter with no MQL representation.
