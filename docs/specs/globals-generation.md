# `@koresar/jsmql/globals` — spec-generated ambient types

## Purpose

The generator builds `src/globals.ts` from the canonical JSMQL registries and the vendored MongoDB MQL spec. It exposes the file as the `@koresar/jsmql/globals` subpath. The companion user-facing reference is [`docs/LANGUAGE.md` § Operator autocomplete](../LANGUAGE.md#operator-autocomplete-koresarjsmqlglobals).

The module holds **only types**: `declare global { … } export {};`. It exports no runtime value. A user imports it with `import "@koresar/jsmql/globals"` (the side-effect form — TS does not allow `import type "…"` on a side-effect-only import). The import costs one empty-module load and brings every stage and operator into ambient global scope. The runtime path stays the same: the parser already accepts a bare `$stage(…)` or `$op(…)` call off the rows in [`src/registry/names.ts`](../../src/registry/names.ts). This module exists only so that TypeScript does not underline the names, and so that the IDE has names to complete.

A user who wants zero runtime impact can instead add `"@koresar/jsmql/globals"` to their tsconfig's `compilerOptions.types` array. Then the ambient declarations apply without any `import` statement.

## Generator

[`scripts/generate-globals.mjs`](../../scripts/generate-globals.mjs) is the generator. `package.json` runs it as `prebuild` and `pretest`, so the file it writes to `src/globals.ts` always matches the pinned spec on every build and test run. `npm run generate:globals` also runs it, for a one-off regeneration.

It exports `generateGlobalsSource()`, so [`test/operator-spec-coverage.test.ts`](../../test/operator-spec-coverage.test.ts) can compare the committed `src/globals.ts`, byte for byte, against fresh generator output (passed through `oxfmt --stdin-filepath` to normalise whitespace). The drift test fails when either side changes.

### Inputs

- `vendor/mql-specifications/definitions/expression/*.yaml` — expression operators.
- `vendor/mql-specifications/definitions/accumulator/*.yaml` — accumulators (also valid as expression operators inside `$group` / `$setWindowFields`).
- `vendor/mql-specifications/definitions/stage/*.yaml` — pipeline stages.
- `src/registry/names.ts` — the rows: which names are stages, which are operators, each one's operand shape, positional keys, description and diagnostic scope. Read through the accessors in `src/compiler/rows.ts`, so the generator holds no list of its own.

A name the rows confine to another operator's body (`$case` inside `$switch.branches[]`) is not a callable operator, so it never reaches the output. The accessor leaves it out.

### Output

A single `src/globals.ts` file containing one `declare global { … } export {};` block, alphabetised within five sections:

1. **Stages** — every stage the rows state (`everyStageName()`).
2. **Expression operators (incl. accumulators and window functions)** — every operator the rows state (`everyOperatorName()`). An accumulator is a row like any other. The section header shows that this set covers every non-stage callable.
3. **Context references (`$$`, `$$$`, `$$$$`)** — three ambient declarations (`var $$`, `const $$$`, `const $$$$`), so arrow-form context-ref code type-checks. See § Context references below.
4. **JS construction forms** — the global rows that list the value position (`constructorGlobals()`), except `Date`, which TypeScript's own library declares. Each is an `interface XConstructor` with a call signature only, because JSMQL has no `new` keyword (HR8), plus `var X: XConstructor`. `constructionFormsBlock()` emits them.
5. **Statement-form built-ins** — non-`$` statement-position built-ins with no registry entry. Today this is only `assert(condition[, message])`. `statementFormsBlock()` emits it as `function assert(condition: any, message?: any): void`, typed `void` because it is a pipeline-statement guard with no value (see [`assert.md`](assert.md)).
6. **Value-method augmentations** — the value methods (for example `.uniq()`, `.capitalize()`, `.startOf()`) added onto the built-in interfaces that `VALUE_METHOD_INTERFACES` names. `valueMethodAugmentationBlock()` emits them. See § Value-method augmentations below.

For each operator the generator emits:

- A multi-line JSDoc comment with the full spec `description` (or the registry description as a fallback), an optional `@minVersion <ver>` tag, and an `@see <link>` tag (the `link` field of the spec, or the default Mongo docs URL that the generator builds from the name).
- One or more `function $name(…): any;` declarations. A `flex`-shape operator emits two overloads, so it takes more than one line.
- One catch-all overload, `function $name(...args: any[]): any;`, after the documented ones. A `$op(…)` or `$stage(…)` call is the developer's own MQL (HR2), and the compiler takes it with any arguments: the positional form of an object-form operator (`$trim($.name, " ")`), a string body (`$unwind("$items")`), or a count that the server refuses (`$size(1, 2)`). So the types never refuse a `$` call.

### Call-shape rules

Stages (driven by the spec's `encode` field):

| `encode` | Signature |
|---|---|
| `object` | `function $stage(args: { …spec args… }): any;` with each spec argument as an optional field. The field's doc starts with "Required." when the spec states no `optional: true`. |
| `single` (or missing) | `function $stage(name: type): any;` lifting the first spec argument's name and type. |
| `array` | `function $stage(name: unknown[]): any;` |
| `none` or zero arguments | `function $stage(): any;` |

Expression operators (driven by the operand shape the row states — authoritative because that's what the parser accepts):

| `shape.kind` | Signature |
|---|---|
| `single` | `function $op(expression: type): any;`, or `function $op(...expression: type[]): any;` when the YAML marks the arg `variadic: array`. |
| `array` | JSMQL's array shape is N positional args, not one array. When the YAML names two or more fixed arguments, each one is a named parameter: `function $op(string: string, start: number, length: number): any;`, with `?` on an optional one. TypeScript refuses a required parameter after an optional one, so such a list gives two overloads: one without the optional parameters, and one with every parameter. Otherwise the signature is `function $op(...expressions: type[]): any;`. |
| `object` | `function $op(args: { …registry keys… }): any;`, where each registry key is an optional field with its spec arg's type, and its doc starts with "Required." when the spec arg is not optional. |
| `none` | `function $op(): any;` |
| `flex` | Two overloads — `(expression: type): any;` and `(...expressions: type[]): any;` — covering both call shapes the parser accepts. |

Every key of an object signature is optional, so that an incomplete object literal still gets key completion. See [ADR 0037](../adr/0037-globals-generator-details.md).

### Type mapping

Each YAML type name maps to the TS type that the argument must resolve to. A multi-name type joins as a union, with duplicates removed. A union that contains `any` collapses to `any`. A `$.field` path and a nested `$op(…)` call are `any`, so they fit every typed parameter. A literal of a different type still type-checks through the catch-all overload, because the types never refuse a `$` call.

| YAML `type` | TS type emitted |
|---|---|
| `resolvesToNumber`, `resolvesToInt`, `resolvesToLong`, `resolvesToDouble`, `resolvesToDecimal`, `number`, `int`, `double`, `long`, `decimal` | `number` |
| `resolvesToString`, `string` | `string` |
| `resolvesToBool`, `bool` | `boolean` |
| `resolvesToDate`, `date` | `Date` |
| `resolvesToArray`, `array` | `unknown[]` |
| `resolvesToObject` | `Record<string, any>` |
| `resolvesToNull`, `null` | `null` |
| `resolvesToRegex`, `regex` | `RegExp` |
| Contains `timeUnit` | `"year" \| "quarter" \| "month" \| "week" \| "day" \| "hour" \| "minute" \| "second" \| "millisecond"` |
| Singleton `pipeline` | `unknown[]` |
| Singleton `query` or `object` (a stage body) | `any` |
| `resolvesToObjectId`, `resolvesToTimestamp`, `resolvesToBinData`, `resolvesToAny`, `expression`, `T`, `javascript`, and every other name | `any` |

For the reason behind the `any` rows, see [ADR 0037](../adr/0037-globals-generator-details.md).

MEASURED with the TypeScript language service: the signature help for `$sum(|` shows `$sum(expression: number | unknown[]): any`, then the variadic overload and the catch-all; `$substrCP(|` shows `$substrCP(string: string, start: number, length: number): any`, then the catch-all.

The project sets aside per-operator return-type narrowing (for example `$abs(): number`): it would interfere with method-chain inference on a field ref. `$.foo` is `any`, and `$abs($.foo)` must not suddenly become `number` and reject `.toString()`. It stays typed `: any` until the project designs the broader return-typing story.

A reserved TS keyword used as an argument name (for example `default` for `$bucket`) appears as a quoted object-type key.

### Context references (`$$` / `$$$` / `$$$$`)

`contextRefBlock(spec)` emits one ambient declaration per context-ref prefix, in scope order (collection, then database, then cluster). This makes arrow-form code like `jsmql(({ $ }) => $$.indexStats())` or `jsmql(({ $ }) => $$$.orders.find(...))` type-check under TypeScript. Without it, TypeScript reports an undeclared identifier.

The declaration keyword differs by ref. `$$` is a `var`. `$$$` and `$$$$` are `const`.

`JsmqlForeignRef` is the type of `$$$.<coll>`. `JsmqlStreamRef extends JsmqlForeignRef` is the type of `$$`. Each ref declares the chainable vocabulary again, with itself as the return type. `.find` on the stream ref is a `find(...args: never[]): never` member with a `@deprecated` JSDoc that names the alternative. The cluster ref (`$$$$`) has only a plain `[key: string]: any` tail.

See [ADR 0159](../adr/0159-globals-context-ref-types.md) for the reason behind each of these choices, and behind the members below.

Each ref carries:

- **Named diagnostic methods** — derived from the `diagnostic: { scope, options }` fact on each stage row (the single source of truth, also read by [`src/compiler/emit/statement.ts`](../../src/compiler/emit/statement.ts)). Stages sort by `diagnostic.scope`: `collection` goes to `$$`, `cluster` goes to `$$$$`. `$$$` (database) has no diagnostics by design — `$currentOp` and its siblings run on the admin DB. The method name is the stage name minus its leading `$`; the generator sorts method names for byte-stable output. Each method reuses the *same* `jsdocFor(...)` JSDoc as the stage's own block (description, `@minVersion`, `@see`), so the docs stay consistent. The signature is `method(): any;` when `options: false`, and `method(options?: <shape>): any;` otherwise.
- **Options shapes** — the option *field* shapes (`collStats`'s `latencyStats` / `storageStats` / …, `currentOp`'s `allUsers` / `idleCursors` / …) are not in the stage rows or the vendored YAML in a usable form. They matter only for TS completion. So they live in the generator as a hardcoded `DIAGNOSTIC_OPTION_SHAPES` map keyed by stage name, transcribed from the MongoDB manual. The three no-option stages (`$indexStats`, `$planCacheStats`, `$shardedDataDistribution`) are absent from the map: they take zero arguments, matching `options: false` and the runtime arg check in `resolveSystemStageCall`.
- **Stream methods** — the chainable stream vocabulary, so `$$.filter(...).map(...)` and `$$$.orders.filter(...).sortBy(...)` both complete, and do not fall through to the tail. The method *names* come from `streamMethodNames()` in [`src/compiler/rows.ts`](../../src/compiler/rows.ts): every row in [`src/registry/names.ts`](../../src/registry/names.ts) with a `stream` cell. `.filter` / `.reject` (special-cased chain heads) and `.push` (statement-level `$unionWith`, current stream only) are not in that registry, so the generator lists them by hand. The *signatures* are hardcoded in `STREAM_METHOD_SIGNATURES`, for the same reason as the option shapes. Each method **returns the ref interface**, not `any`, so the callback of every link keeps a contextual type. The values stay untyped (a callback parameter is `any`). The interfaces exist for chains and completion, not for the types of documents.
- **Chained stage calls** — every stage **except** one that carries `diagnostic`, emitted as `$name(body: any): <ref>` by `stageLinkMembers()`. The diagnostic stages are excluded because they are *source* stages: a link form can never come first, JSMQL rejects `$$.$indexStats({})` outright, and they already appear under their own non-`$` spelling with a different arity. The body is typed `any`, not the generated argument object of the stage. Key completion is on the statement form (`$group({ … })`).
- **Array-shaped members** — `readonly length: number` (the stream count), the `VALUE_TERMINAL_METHODS` (`.head()`, `.sum()`, `.size()`, and others, each of which ends a chain with a value in value position), and `[Symbol.iterator](): Iterator<any>`, so that `$$.push(...$$$.other)` spreads a ref. The refs do not extend `Array<any>`.
- **Permissive tail** — each ref ends with `[key: string]: any;`. It covers the syntax that the named members do not: `$$ = …` (replace-stream), `$$$.coll = …` (`$out`), and member access on a materialised lookup result. TypeScript does not flag a typo in an unnamed method (`$$.pus(...)`), but the JSMQL parser refuses it. A named member takes precedence over the index signature, so it keeps its precise type.

The methods come from the rows, so a new diagnostic stage (a `diagnostic` fact on its row), a new stage, or a new stream method appears on the right ref without extra work. A new diagnostic stage needs a `DIAGNOSTIC_OPTION_SHAPES` entry only when it takes options; a new stream method needs a `STREAM_METHOD_SIGNATURES` entry. `streamMethodMembers()` guards that table in **both** directions: every registry name must have a signature, and every signature must name a live registry entry. So a method that JSMQL later drops from streams cannot stay as a phantom completion.

### Value-method augmentations

A **value** method is one whose row in [`src/registry/names.ts`](../../src/registry/names.ts) has a value cell on an array, string, number, or date receiver (`valueMethodNames()` in [`src/compiler/rows.ts`](../../src/compiler/rows.ts)) , for example `$.items.uniq()`, `$.name.capitalize()` or `$.placedAt.startOf("month")`, not on a `$`-prefixed global. Completion needs the *receiver* to have a real type, so `valueMethodAugmentationBlock()` adds each method to the matching built-in interface. The receiver interfaces it emits are the keys of `VALUE_METHOD_INTERFACES`, and that map also sets the emit order.

- **Signatures** live in the generator's hardcoded `VALUE_METHOD_SIGNATURES` map, for the same reason as `STREAM_METHOD_SIGNATURES`: they matter only for completion and appear in no registry in TS form. Each entry is `{ recv, sig, doc }`. `recv` names the interface, or an **array** of interfaces for a method valid on more than one receiver. `sig` is the `(params): Return` text, or a **map keyed by receiver** when the signature differs between receivers. `.clamp` needs both: it bounds a number *or* a date, and its result follows the receiver. So it emits onto `Number` and `Date` with a different return type on each. An array signature references the element type `T`. **The generator picks return types that keep a chain typed**: an element-preserving operator returns `T[]`, an element accessor returns `T`, an aggregate returns `number`, `chunk` returns `T[][]`, and `groupBy` / `keyBy` / `countBy` return a `Record<…>`. Parameter types stay permissive. JSMQL validates the real argument at compile time, and the TS type only needs to not *reject* valid JSMQL. One deliberate exception exists: the generator emits a `unit` parameter as the MQL `timeUnit` literal union, derived from the same `TIME_UNIT` (`src/compiler/emit/check.ts`) that `checkEnum` validates against. So the editor catches a mistyped unit against the same closed set.
- **Members are emitted as methods, never properties.** See [ADR 0160](../adr/0160-globals-value-method-augmentation.md).
- **Drift protection (membership).** `VALUE_METHOD_SKIP` sorts every registry method the generator does *not* augment: `nativeArray` / `nativeString` / `dateNative` (lib.d.ts already types them), `object` (see below), `regex` (native on `RegExp`), and `shimmed` (error-only, for example `.unzipWith`). `dateNative` is the exported `NATIVE_DATE_METHODS` from `src/compiler/emit/lower.ts`, which also drives the zero-argument arity check for those methods — one list serves both uses. The block asserts that every non-skipped registry method has a signature, that every signature names a real non-skipped method, and that every skip name is a real registry method. So a value method that a developer adds to JSMQL without a signature (or a skip entry) fails the build. `streamMethodMembers()` enforces the same rule for the stream vocabulary. `valueMethodNames()` (exported from `src/compiler/emit/lower.ts`) is the registry source of truth for the check.
- **Drift protection (return category).** When a row declares an invariant result kind (`returns`), the augmentation's TS return type must stay in that category, for **every** receiver a multi-receiver entry emits onto. `valueMethodReturns()` (from `src/compiler/rows.ts`) feeds a per-method check that reads the signature's return type and confirms the match (`"number"` → `number`, `"object"` → `Record<…>`, `"array"` → a `[]` or tuple type, and so on). A registry change that the ambient signature does not mirror fails the build. A method with **no** invariant `returns` — its result depends on the receiver or the arguments, as with `.head` (element `T`), `.groupBy` (value versus stream), `.max` / `.min`, or `.clamp` — takes the skip. There is no invariant to enforce, and the signature already carries the more precise element or context type. The methods that return a date leave `returns` unset, so they take the skip: see [ADR 0160](../adr/0160-globals-value-method-augmentation.md). If you add `returns: "date"` to the registry without a matching `inCategory` row, the build breaks.

Two boundaries apply:

- **The receiver must have a concrete type.** A bare `$.field` is `any`, and `any.uniq()` stays `any`. So the augmentation "activates" only on an annotated `$`, a literal, or a known-return method result mid-chain. `[DEF-016]` notes the same tension for `$op(...)` returns: `$.field` must stay `any` so an operator form (`$.age > 18`) type-checks, and `any` cannot also carry completion. The augmentation stays safe because it never forces a field ref to narrow; it only adds members to a type that is *already* concrete.
- **Object-receiver methods are excluded.** `VALUE_METHOD_SKIP.object` holds every object-receiver method, for example `.pick`, and the generator gives these methods no completion: see [ADR 0152](../adr/0152-object-receiver-methods-no-completion.md). The generator augments `Date`: see [ADR 0160](../adr/0160-globals-value-method-augmentation.md).

The type-level regression test [`test/types/globals-completion.ts`](../../test/types/globals-completion.ts) (run through `tsc` by `test/smoke.test.ts`) covers this: positive chains plus `@ts-expect-error` typos prove the surface is not silently `any`.

### Stable ordering

The generator sorts:

- Section order: stages, then expression operators, then the context refs (`$$` / `$$$` / `$$$$`, themselves in scope order).
- Order within each section: alphabetical by name (`Object.keys(…).sort()`). The generator also sorts the context-ref methods within each const.
- The YAML file list, through `readdirSync(…).sort()`, so the loader stays stable across platforms.

This order is a requirement: without it the drift test would report a spurious failure on every byte compare.

### Final formatting pass

After it writes the file, the generator runs `node_modules/.bin/oxfmt` to normalise spacing, line breaks inside argument-object literals, and trailing commas. The drift test mirrors this: it pipes its own output through the same binary with `--stdin-filepath`. Outside Claude Code or CI, `npm run generate:globals` runs the full pipeline.

## Subpath export

`package.json`:

```json
"exports": {
  ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
  "./globals": { "types": "./dist/globals.d.ts", "default": "./dist/globals.js" }
}
```

The `default` field points at the near-empty `dist/globals.js`, so an accidental non-type `import "@koresar/jsmql/globals"` resolves at runtime. It does nothing, but it does not raise an error.

## Test coverage

[`test/operator-spec-coverage.test.ts`](../../test/operator-spec-coverage.test.ts) runs the drift test "src/globals.ts is byte-equal to the generator output".

[`test/types/globals-completion.ts`](../../test/types/globals-completion.ts) holds the catch-all: `$trim(x, " ")`, `$unwind("$items")` and `$size(1, 2)` type-check.

[`test/smoke.test.ts`](../../test/smoke.test.ts) checks that `dist/globals.{js,d.ts}` exists and holds real content, as part of the `smoke:dist` flow.

[`test/realistic.test.ts`](../../test/realistic.test.ts) imports the module at the top of the file, so every showcase example compiles against the ambient globals. `README.md` links to it, so it also serves new users as a copy-paste reference.

## When to regenerate

The generator runs on every `npm run build` and `npm test`, so the committed `src/globals.ts` should always match the rows and the pinned spec. The drift test fails when a contributor edits a row and does not run the generator, or edits `src/globals.ts` by hand.

A bump of `PINNED_SHA` in [`vendor/fetch-mql-specs.mjs`](../../vendor/fetch-mql-specs.mjs) pulls in new spec data. The next test run then fails the drift check. Run `npm run generate:globals` and commit the refreshed `src/globals.ts` to fix it.
