# `@koresar/jsmql/globals` — spec-generated ambient types

## Purpose

The generator builds `src/globals.ts` from the canonical JSMQL registries and the vendored MongoDB MQL spec. It exposes the file as the `@koresar/jsmql/globals` subpath. The companion user-facing reference is [`docs/LANGUAGE.md` § Operator autocomplete](../LANGUAGE.md#operator-autocomplete-koresarjsmqlglobals).

The module holds **only types**: `declare global { … } export {};`. It exports no runtime value. A user imports it with `import "@koresar/jsmql/globals"` (the side-effect form — TS does not allow `import type "…"` on a side-effect-only import). The import costs one empty-module load and brings every stage and operator into ambient global scope. The runtime path stays the same: the parser already accepts a bare `$stage(…)` or `$op(…)` call off the rows in [`src/registry/names.ts`](../../src/registry/names.ts). This module exists only so TypeScript stops underlining the names, and so the IDE has something to complete.

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
4. **JS construction forms** — non-`$` built-ins with no registry entry that still need an ambient declaration for the arrow form. Today this is only `ObjectId`: an `interface ObjectIdConstructor` with both a call and a construct signature (so `ObjectId("…")` and `new ObjectId("…")` resolve), plus `var ObjectId: ObjectIdConstructor`. `constructionFormsBlock()` emits it.
5. **Statement-form built-ins** — non-`$` statement-position built-ins with no registry entry. Today this is only `assert(condition[, message])`. `statementFormsBlock()` emits it as `function assert(condition: any, message?: any): void`, typed `void` because it is a pipeline-statement guard with no value (see [`assert.md`](assert.md)).
6. **Value-method augmentations** — the value methods (for example `.uniq()`, `.capitalize()`, `.startOf()`) added onto the built-in interfaces that `VALUE_METHOD_INTERFACES` names. `valueMethodAugmentationBlock()` emits them. See § Value-method augmentations below.

For each operator the generator emits:

- A multi-line JSDoc comment with the full spec `description` (or the registry description as a fallback), an optional `@minVersion <ver>` tag, and an `@see <link>` tag (the spec's `link` field, or the default Mongo docs URL built from the name).
- One or more `function $name(…): any;` declarations. A `flex`-shape operator emits two overloads, so it takes more than one line.

### Call-shape rules

Stages (driven by the spec's `encode` field):

| `encode` | Signature |
|---|---|
| `object` | `function $stage(args: { …spec args… }): any;` with each spec argument as a field, marked optional per `optional: true`. |
| `single` (or missing) | `function $stage(name: type): any;` lifting the first spec argument's name and type. |
| `array` | `function $stage(name: unknown[]): any;` |
| `none` or zero arguments | `function $stage(): any;` |

Expression operators (driven by the operand shape the row states — authoritative because that's what the parser accepts):

| `shape.kind` | Signature |
|---|---|
| `single` | `function $op(expression: type): any;`, or `function $op(...expression: type[]): any;` when the YAML marks the arg `variadic: array`. |
| `array` | `function $op(...expressions: type[]): any;` (JSMQL's array shape is N positional args, not one array). |
| `object` | `function $op(args: { …registry keys… }): any;`, where each registry key is annotated with its spec arg's optionality and type when present. |
| `none` | `function $op(): any;` |
| `flex` | Two overloads — `(expression: type): any;` and `(...expressions: type[]): any;` — covering both call shapes the parser accepts. |

### Type mapping

A JSMQL body lets a user pass a `$.field` path, a literal, or a nested `$op(…)` call. TypeScript sees all three as `any`, so most argument types stay permissive. The generator narrows only the few cases that add real value for the user:

| YAML `type` | TS type emitted |
|---|---|
| Contains `timeUnit` | `"year" \| "quarter" \| "month" \| "week" \| "day" \| "hour" \| "minute" \| "second" \| "millisecond"` |
| Singleton `string` (raw, not `resolvesToString`) | `string` |
| Singleton `pipeline` | `unknown[]` |
| Singleton `query` | `any` |
| Singleton `object` | `any` |
| Anything else (incl. `resolvesToX` unions and unknowns) | `any` |

The project sets aside per-operator return-type narrowing (for example `$abs(): number`): it would interfere with method-chain inference on a field ref. `$.foo` is `any`, and `$abs($.foo)` must not suddenly become `number` and reject `.toString()`. It stays typed `: any` until the project designs the broader return-typing story.

A reserved TS keyword used as an argument name (for example `default` for `$bucket`) appears as a quoted object-type key.

### Context references (`$$` / `$$$` / `$$$$`)

`contextRefBlock(spec)` emits one ambient declaration per context-ref prefix, in scope order (collection, then database, then cluster). This makes arrow-form code like `jsmql(({ $ }) => $$.indexStats())` or `jsmql(({ $ }) => $$$.orders.find(...))` type-check under TypeScript, instead of raising an error for an undeclared identifier.

The declaration keyword differs by ref. **`$$` uses `var`**, not `const`: the `$$ = …` replace-stream / `$facet` sugar reassigns it wholesale, and `const $$` would make TypeScript reject that valid JSMQL with `TS2588: Cannot assign to '$$' because it is a constant.`. **`$$$` and `$$$$` use `const`**: they only ever take a *property* write (`$$$.coll = …`, `$$$$.db.coll = …` → `$out`), and `const` permits that. `const` still flags the invalid `$$$ = …` whole reassignment, and no sugar needs that form.

**Two named interfaces, one extends the other.** `JsmqlForeignRef` is what `$$$.<coll>` indexes to. `JsmqlStreamRef extends JsmqlForeignRef` is what `$$` is. The `extends` clause carries real weight, not tidiness: `$$$.<coll>` is at once a **read head** (`$$$.orders.filter(…)`) and an **`$out` write target** (`$$$.archive = $$`). TypeScript checks a target's named members against the source's **declared** members, never through the source's index signature. So a permissive tail on `$$` cannot satisfy `JsmqlForeignRef`'s members; only a real declaration can, and inheritance gives that. Drop the `extends` clause, and `$$$.coll = $$` stops type-checking (`TS2739`).

**Each ref re-declares the chainable vocabulary with itself as the return type.** A chain keeps the identity of its **root** — this is the rule JSMQL enforces: `.find` is legal at *any* position of a foreign chain and at *no* position of a current-stream chain. `$$$.orders.filter(p).find(q)` compiles; `$$.filter(p).find(q)` does not. One shared return type cannot express that difference, so the member list appears twice, and the duplication buys the distinction. `.find` on the collection ref is a `find(...args: never[]): never` shim that carries a `@deprecated` JSDoc naming the alternative: the member must *exist* for the `$out` assignment above, but a call to it must fail.

The cluster ref (`$$$$`) keeps a plain `[key: string]: any` tail. Its second level names a **database**, not a collection, so typing it would either advertise the cross-database reads `requireSameDbColl` rejects, or reopen the same write-assignability question one level down.

Each ref carries:

- **Named diagnostic methods** — derived from the `diagnostic: { scope, options }` fact on each stage row (the single source of truth, also read by [`src/compiler/emit/statement.ts`](../../src/compiler/emit/statement.ts)). Stages sort by `diagnostic.scope`: `collection` goes to `$$`, `cluster` goes to `$$$$`. `$$$` (database) has no diagnostics by design — `$currentOp` and its siblings run on the admin DB. The method name is the stage name minus its leading `$`; the generator sorts method names for byte-stable output. Each method reuses the *same* `jsdocFor(...)` JSDoc as the stage's own block (description, `@minVersion`, `@see`), so the docs stay consistent. The signature is `method(): any;` when `options: false`, and `method(options?: <shape>): any;` otherwise.
- **Options shapes** — the option *field* shapes (`collStats`'s `latencyStats` / `storageStats` / …, `currentOp`'s `allUsers` / `idleCursors` / …) are not carried by the stage rows or the vendored YAML in a usable form, and they matter only for TS completion. So they live in the generator as a hardcoded `DIAGNOSTIC_OPTION_SHAPES` map keyed by stage name, transcribed from the MongoDB manual (with the doc URLs inline). The three no-option stages (`$indexStats`, `$planCacheStats`, `$shardedDataDistribution`) are absent from the map: they take zero arguments, matching `options: false` and the runtime arg check in `resolveSystemStageCall`.
- **Stream methods** — the chainable stream vocabulary, so `$$.filter(...).map(...)` and `$$$.orders.filter(...).sortBy(...)` both complete instead of falling through the tail. The method *names* come from `streamMethodNames()` in [`src/compiler/rows.ts`](../../src/compiler/rows.ts): every row in [`src/registry/names.ts`](../../src/registry/names.ts) with a `stream` cell. `.filter` / `.reject` (special-cased chain heads) and `.push` (statement-level `$unionWith`, current stream only) are not in that registry, so the generator lists them by hand. The *signatures* are hardcoded in `STREAM_METHOD_SIGNATURES`, for the same reason as the option shapes. Each method **returns the ref interface**, not `any`. This is why the refs are named `interface`s rather than inline anonymous types: a method that returns `any` would collapse the chain, so the *next* lambda's parameter would trip `noImplicitAny` (`$$.filter(d => …).map(d => …)`). Returning the interface instead keeps every link's callback contextually typed. The values stay effectively untyped (a callback parameter is `any`); the interfaces exist for chaining and completion, not for document typing.
- **Chained stage calls** — every stage **except** one that carries `diagnostic`, emitted as `$name(body: any): <ref>` by `stageLinkMembers()`. The diagnostic stages are excluded because they are *source* stages: a link form can never come first, JSMQL rejects `$$.$indexStats({})` outright, and they already appear under their own non-`$` spelling with a different arity. The body is typed `any` rather than the stage's generated args object, because several stages also accept a bare string (`.$unwind("$items")`, `.$merge("coll")`), and a named member has no `any` escape hatch — a narrower type would reject valid JSMQL. Argument-key completion lives on the statement form (`$group({ … })`), which the spec *does* generate.
- **Array-shaped members** — `readonly length: number` (the stream count), the `VALUE_TERMINAL_METHODS` (`.head()`, `.sum()`, `.size()`, and others, each of which ends a chain with a value in value position), and `[Symbol.iterator](): Iterator<any>`. The iterator earns its place: `$$.push(...$$$.other)` spreads a ref, which fails as `TS2488` without it. The generator tried `interface … extends Array<any>` instead, and it does not compile — `push`'s return type conflicts (`TS2430`) — and it would advertise the mutators and from-the-end methods JSMQL rejects on a stream.
- **Permissive tail** — each ref ends with `[key: string]: any;`. The refs carry more syntax than the named members (`$$ = …` replace-stream; `$$$.coll = …` → `$out`; member access on a materialised lookup result), and typing that needs the schema threading tracked by DEF-013. **Trade-off:** TS does not flag a typo in an unnamed method (`$$.pus(...)`); the JSMQL parser still catches it. Narrowing the tail to a `` `$${string}` `` pattern would turn a typo into a `TS2551` suggestion, but a named member has no escape hatch — any form not listed above would become a hard error on valid JSMQL, which costs more than a missed typo. A named member takes precedence over the index signature, so it keeps its precise type.

The methods come from the rows, so a new diagnostic stage (a `diagnostic` fact on its row), a new stage, or a new stream method appears on the right ref without extra work. A new diagnostic stage needs a `DIAGNOSTIC_OPTION_SHAPES` entry only when it takes options; a new stream method needs a `STREAM_METHOD_SIGNATURES` entry. `streamMethodMembers()` guards that table in **both** directions: every registry name must have a signature, and every signature must name a live registry entry. So a method JSMQL later drops from streams cannot linger as a phantom completion.

### Value-method augmentations

A **value** method is one whose row in [`src/registry/names.ts`](../../src/registry/names.ts) has a value cell on an array, string, number, or date receiver (`valueMethodNames()` in [`src/compiler/rows.ts`](../../src/compiler/rows.ts)) — for example `$.items.uniq()`, `$.name.capitalize()`, `$.placedAt.startOf("month")` — rather than on a `$`-prefixed global. Completion needs the *receiver* to have a real type, so `valueMethodAugmentationBlock()` adds each method to the matching built-in interface. The receiver interfaces it emits are the keys of `VALUE_METHOD_INTERFACES`, and that map also sets the emit order.

- **Signatures** live in the generator's hardcoded `VALUE_METHOD_SIGNATURES` map, for the same reason as `STREAM_METHOD_SIGNATURES`: they matter only for completion and appear in no registry in TS form. Each entry is `{ recv, sig, doc }`. `recv` names the interface, or an **array** of interfaces for a method valid on more than one receiver. `sig` is the `(params): Return` text, or a **map keyed by receiver** when the signature differs between receivers. `.clamp` needs both: it bounds a number *or* a date, and its result follows the receiver, so it emits onto `Number` and `Date` with a different return type on each. An array signature references the element type `T`. **The generator picks return types that keep a chain typed**: an element-preserving operator returns `T[]`, an element accessor returns `T`, an aggregate returns `number`, `chunk` returns `T[][]`, and `groupBy` / `keyBy` / `countBy` return a `Record<…>`. Parameter types stay permissive, because JSMQL validates the real argument at compile time and the TS type only needs to not *reject* valid JSMQL — with one deliberate exception: the generator emits a `unit` parameter as the MQL `timeUnit` literal union, derived from the same `TIME_UNIT` (`src/compiler/emit/check.ts`) that `checkEnum` validates against, so the editor catches a mistyped unit against the same closed set.
- **Members are emitted as methods, never properties.** Same-named method declarations merge into an overload set and can never collide. A property declaration is the one shape that can hit TS2717 against another augmentation of the same built-in.
- **Drift protection (membership).** `VALUE_METHOD_SKIP` sorts every registry method the generator does *not* augment: `nativeArray` / `nativeString` / `dateNative` (lib.d.ts already types them), `object` (see below), `set` / `regex` (native on `Set` / `RegExp`), and `shimmed` (error-only, for example `.unzipWith`). `dateNative` is the exported `NATIVE_DATE_METHODS` from `src/compiler/emit/lower.ts`, which also drives the zero-argument arity check for those methods — one list serves both uses. The block asserts that every non-skipped registry method has a signature, that every signature names a real non-skipped method, and that every skip name is a real registry method. So a value method added to JSMQL without a signature (or a skip entry) fails the build, exactly as `streamMethodMembers()` enforces for the stream vocabulary. `valueMethodNames()` (exported from `src/compiler/emit/lower.ts`) is the registry source of truth for the check.
- **Drift protection (return category).** When a row declares an invariant result kind (`returns`), the augmentation's TS return type must stay in that category, for **every** receiver a multi-receiver entry emits onto. `valueMethodReturns()` (from `src/compiler/rows.ts`) feeds a per-method check that reads the signature's return type and confirms the match (`"number"` → `number`, `"object"` → `Record<…>`, `"array"` → a `[]` or tuple type, and so on). A registry change not mirrored in the ambient signature fails the build. A method with **no** invariant `returns` — its result depends on the receiver or the arguments, as with `.head` (element `T`), `.groupBy` (value versus stream), `.max` / `.min`, or `.clamp` — takes the skip: there is no invariant to enforce, and the signature already carries the more precise element or context type. **The date-returning methods (`.plus` / `.minus` / `.startOf` / `.endOf` / `.set`) stay unprotected by design**, not by omission: `MethodReturn` has no `date` member, because those methods return "the same type as the receiver". So the registry leaves `returns` unset for them, and they take the skip. Adding `returns: "date"` to the registry without a matching `inCategory` row would break the build.

Two boundaries follow from the design, not from an oversight:

- **The receiver must have a concrete type.** A bare `$.field` is `any`, and `any.uniq()` stays `any`. So the augmentation "activates" only on an annotated `$`, a typed static (`Object.values(o)`), a literal, or a known-return method result mid-chain. `[DEF-016]` notes the same tension for `$op(...)` returns: `$.field` must stay `any` so an operator form (`$.age > 18`) type-checks, and `any` cannot also carry completion. The augmentation stays safe because it never forces a field ref to narrow; it only adds members to a type that is *already* concrete.
- **Object-receiver methods are excluded.** `.mapValues` / `.pick` / `.omit` / `.invert` / `.pickBy` / `.omitBy` / `.toPairs` would have to hang on `interface Object`, the base of every type, and that would misleadingly advertise them on numbers, strings, and arrays. They sit in `VALUE_METHOD_SKIP.object` and get no completion. `Date` carries no such cost, so the generator augments it: it is a leaf type, so its members appear on dates and nothing else — a strictly narrower blast radius than the `Number` augmentation the project already accepts. It also removes real false positives rather than only adding completion, because JSMQL's date vocabulary beyond the native accessors (`.plus`, `.startOf`, `.format`, and others) has no lib.d.ts declaration at all.

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

[`test/smoke.test.ts`](../../test/smoke.test.ts) checks that `dist/globals.{js,d.ts}` exists and holds real content, as part of the `smoke:dist` flow.

[`test/realistic.test.ts`](../../test/realistic.test.ts) imports the module at the top of the file, so every showcase example compiles against the ambient globals. `README.md` links to it, so it also serves new users as a copy-paste reference.

## When to regenerate

The generator runs on every `npm run build` and `npm test`, so the committed `src/globals.ts` should always match the rows and the pinned spec. The drift test fails when a contributor edits a row without running the generator, or edits `src/globals.ts` by hand.

A bump of `PINNED_SHA` in [`vendor/fetch-mql-specs.mjs`](../../vendor/fetch-mql-specs.mjs) pulls in new spec data. The next test run then fails the drift check. Run `npm run generate:globals` and commit the refreshed `src/globals.ts` to fix it.
