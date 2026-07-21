# `@koresar/jsmql/ops` — spec-generated ambient types

## Purpose

How `src/ops.ts` is generated from the canonical jsmql registries and the vendored MongoDB MQL spec, exposed as the `@koresar/jsmql/ops` subpath. The companion user-facing reference is [`docs/LANGUAGE.md` § Operator autocomplete](../LANGUAGE.md#operator-autocomplete-koresarjsmqlops).

The module is **pure-types** at the source: `declare global { … } export {};`. There are no exported runtime values. Users import it with `import "@koresar/jsmql/ops"` (the side-effect form — TS does not allow `import type "…"` on a side-effect-only import), which costs one empty-module load and brings every stage and operator into ambient global scope. The runtime path is unchanged — the parser already accepts bare `$stage(…)` / `$op(…)` calls via [`STAGES`](../../src/stages.ts) and [`OPERATORS`](../../src/operators.ts); this module exists solely so TypeScript stops underlining the names and the IDE has something to autocomplete.

Users who want zero runtime impact can instead add `"@koresar/jsmql/ops"` to their tsconfig's `compilerOptions.types` array; the ambient declarations propagate without any `import` statement.

## Generator

[`scripts/generate-ops.mjs`](../../scripts/generate-ops.mjs). Runs as `prebuild` and `pretest` in `package.json`, so the file emitted to `src/ops.ts` always reflects the pinned spec on every build and test run. Also exposed as `npm run generate:ops` for ad-hoc regeneration.

Exports `generateOpsSource()` so [`test/operator-spec-coverage.test.ts`](../../test/operator-spec-coverage.test.ts) can byte-compare the committed `src/ops.ts` against fresh generator output (passed through `oxfmt --stdin-filepath` to normalise whitespace). The drift test fails if either side moves.

### Inputs

- `vendor/mql-specifications/definitions/expression/*.yaml` — expression operators.
- `vendor/mql-specifications/definitions/accumulator/*.yaml` — accumulators (also valid as expression operators inside `$group` / `$setWindowFields`).
- `vendor/mql-specifications/definitions/stage/*.yaml` — pipeline stages.
- `src/operators.ts` (`OPERATORS`) — canonical list and `OperatorShape` for expression operators; the parser's call-shape source of truth.
- `src/stages.ts` (`STAGES`) — canonical list for pipeline stages.

`SUB_CONSTRUCTS` (currently `["$case"]`) — names that appear in the spec as standalone files but are not top-level callable operators. Skipped. Kept in sync with the equivalent set in `test/operator-spec-coverage.test.ts`.

### Output

A single `src/ops.ts` file containing one `declare global { … } export {};` block, alphabetised within five sections:

1. **Stages** — every key of `STAGES`.
2. **Expression operators (incl. accumulators and window functions)** — every key of `OPERATORS`. Accumulators sit in the same registry; the section header reflects that this set covers all non-stage callables.
3. **Context references (`$$`, `$$$`, `$$$$`)** — three ambient declarations (`var $$`, `const $$$`, `const $$$$`) so arrow-form context-ref code type-checks. See § Context references below.
4. **JS construction forms** — non-`$` builtins that have no registry entry but still need an ambient declaration for the arrow form. Currently just `ObjectId`: an `interface ObjectIdConstructor` with both a call and a construct signature (so `ObjectId("…")` and `new ObjectId("…")` resolve) plus `var ObjectId: ObjectIdConstructor`. Emitted by `constructionFormsBlock()`.
5. **Statement-form built-ins** — non-`$` statement-position builtins with no registry entry. Currently just `assert(condition[, message])`, emitted by `statementFormsBlock()` as `function assert(condition: any, message?: any): void` — typed `void` because it's a pipeline-statement guard with no value (see [`assert.md`](assert.md)).
6. **Value-method augmentations** — the lodash-flavoured *value* methods (`.uniq`, `.chunk`, `.clamp`, `.capitalize`, …) augmented onto the built-in `Array<T>` / `String` / `Number` interfaces, emitted by `valueMethodAugmentationBlock()`. See § Value-method augmentations below.

For each operator the generator emits:

- A multi-line JSDoc with the full spec `description` (or the registry description as fallback), an optional `@minVersion <ver>`, and `@see <link>` (the spec's `link` field, or the default Mongo docs URL constructed from the name).
- One or more `function $name(…): any;` declarations — multiple lines for `flex`-shape operators that emit two overloads.

### Call-shape rules

Stages (driven by the spec's `encode` field):

| `encode` | Signature |
|---|---|
| `object` | `function $stage(args: { …spec args… }): any;` with each spec argument as a field, marked optional per `optional: true`. |
| `single` (or missing) | `function $stage(name: type): any;` lifting the first spec argument's name and type. |
| `array` | `function $stage(name: unknown[]): any;` |
| `none` or zero arguments | `function $stage(): any;` |

Expression operators (driven by the jsmql `OperatorShape` in `OPERATORS` — authoritative because that's what the parser accepts):

| `shape.kind` | Signature |
|---|---|
| `single` | `function $op(expression: type): any;`, or `function $op(...expression: type[]): any;` when the YAML marks the arg `variadic: array`. |
| `array` | `function $op(...expressions: type[]): any;` (jsmql's array shape is N positional args, not one array). |
| `object` | `function $op(args: { …registry keys… }): any;`, where each registry key is annotated with its spec arg's optionality and type when present. |
| `none` | `function $op(): any;` |
| `flex` | Two overloads — `(expression: type): any;` and `(...expressions: type[]): any;` — covering both call shapes the parser accepts. |

### Type mapping

The jsmql body lets users pass `$.field` paths, literals, and nested `$op(…)` calls — all `any` from TypeScript's perspective — so most argument types stay permissive. The generator specialises the few cases where a narrower type adds real DX value:

| YAML `type` | TS type emitted |
|---|---|
| Contains `timeUnit` | `"year" \| "quarter" \| "month" \| "week" \| "day" \| "hour" \| "minute" \| "second" \| "millisecond"` |
| Singleton `string` (raw, not `resolvesToString`) | `string` |
| Singleton `pipeline` | `unknown[]` |
| Singleton `query` | `Record<string, any>` |
| Singleton `object` | `Record<string, any>` |
| Anything else (incl. `resolvesToX` unions and unknowns) | `any` |

Per-operator return-type narrowing (e.g. `$abs(): number`) is **deferred**: it interferes with method-chain inference on field refs (`$.foo` is `any`, but `$abs($.foo)` shouldn't suddenly become `number` and reject `.toString()`). Stays as `: any` until the broader return-typing story is designed.

Reserved TS keywords used as argument names (e.g. `default` for `$bucket`) are quoted as object-type keys.

### Context references (`$$` / `$$$` / `$$$$`)

`contextRefBlock(spec)` emits one ambient declaration per context-ref prefix, in scope order (collection → database → cluster), so arrow-form code like `jsmql(({ $ }) => $$.indexStats())` or `jsmql(({ $ }) => $$$.orders.find(...))` type-checks under TypeScript instead of erroring on an undeclared identifier.

The declaration keyword differs by ref. **`$$` is declared `var`**, not `const`: the `$$ = …` replace-stream / `$facet` sugar reassigns it wholesale, and `const $$` would make TypeScript reject that valid jsmql with `TS2588: Cannot assign to '$$' because it is a constant.`. **`$$$` / `$$$$` stay `const`** — they only ever take *property* writes (`$$$.coll = …`, `$$$$.db.coll = …` → `$out`), which `const` permits, while `const` still flags the invalid `$$$ = …` whole-reassignment (there is no such sugar).

Each ref is typed as an object shape:

- **Named diagnostic methods** — derived from the `diagnostic: { scope, options }` field on each entry in `STAGES` (the single source of truth, also read by [`src/system-stage-translation.ts`](../../src/system-stage-translation.ts)). Stages bucket by `diagnostic.scope`: `collection` → `$$`, `cluster` → `$$$$`. `$$$` (database) has no diagnostics by design — `$currentOp` & friends run on the admin DB. The method name is the stage name minus its leading `$`; method names are sorted for byte-stable output. Each method reuses the *same* `jsdocFor(...)` JSDoc the stage's own block gets (description, `@minVersion`, `@see`), so docs stay consistent. The signature is `method(): any;` when `options: false`, else `method(options?: <shape>): any;`.
- **Options shapes** — the option *field* shapes (`collStats`'s `latencyStats`/`storageStats`/…, `currentOp`'s `allUsers`/`idleCursors`/…) aren't carried by `STAGES` or the vendored YAML in a usable form, and matter only to TS completion, so they live in the generator as a hardcoded `DIAGNOSTIC_OPTION_SHAPES` map keyed by stage name, transcribed from the MongoDB manual (doc URLs inline). The three no-option stages (`$indexStats`, `$planCacheStats`, `$shardedDataDistribution`) are absent from the map — they take zero arguments, matching `options: false` and the runtime arg check in `resolveSystemStageCall`.
- **Stream methods (collection ref only)** — the `$$` const additionally carries the chainable / statement-level stream vocabulary (`.filter`, `.map`, `.slice`, `.concat`, `.toSorted`, `.toReversed`, `.flatMap`, `.push`) as typed members, so arrow-form `$$.filter(...).map(...)` chains get completion instead of falling through the tail. The method *names* derive from `streamMethodNames()` (the `STREAM_METHODS` registry in [`src/stream-methods.ts`](../../src/stream-methods.ts)); `.filter` (special-cased chain head) and `.push` (statement-level `$unionWith`) aren't in that registry so they're listed explicitly. The *signatures* are hardcoded in `STREAM_METHOD_SIGNATURES` (same rationale as the option shapes — they matter only to completion and aren't in any registry in TS form), and `streamMethodMembers()` throws at generation time if a registered stream method has no signature, keeping the registry the source of truth. A registry method listed in `STREAM_METHODS_FOREIGN_ONLY` (currently `.aggregate`, which is valid only against a foreign `$$$.<coll>`, not the current stream) is deliberately **not** emitted as a `$$` member — it still needs a signature (the completeness check runs over the whole registry), but reaches `$$$.<coll>` via the permissive tail, so offering `$$.aggregate()` completion (which jsmql rejects) is avoided. Each method **returns the ref interface** (`JsmqlCollectionRef`), not `any` — that's why `$$` is emitted as a named `interface` rather than an inline anonymous type: a method returning `any` would collapse the chain so the *next* lambda's parameter trips `noImplicitAny` (`$$.filter(d => …).map(d => …)`), whereas returning the interface keeps every link's callback contextually typed. The values are still effectively untyped (the callback params are `any`); the interface is for chaining + completion, not real document typing. Only `$$` gets these — `$$$` / `$$$$` stay inline anonymous types and reach the same methods via member access on the permissive tail.
- **Permissive tail** — each const ends with `[key: string]: any;`. The context refs carry far more syntax than the named members (`$$ = …` replace-stream; `$$$.coll.find/filter(...)` → `$lookup`; `$$$.coll = …` / `$$$$.db.coll = …` → `$out`; member access). Typing all of that precisely needs schema/collection-name threading (DEF-013) that doesn't exist yet, so the index signature keeps every such form type-checking as `any`. **Trade-off:** TS won't flag a typo of an unnamed method (e.g. `$$.pus(...)`); the jsmql parser still catches it at compile time. The named members (diagnostic + stream methods) take precedence over the index signature for known keys, so they keep their precise types and completion.

The methods derive from the registries, so adding a new diagnostic stage (a `diagnostic` field on a `STAGES` entry) or a new stream method (a `STREAM_METHODS` entry) surfaces it on the right ref automatically — a new diagnostic stage needs a `DIAGNOSTIC_OPTION_SHAPES` entry only if it takes options; a new stream method needs a `STREAM_METHOD_SIGNATURES` entry (the generator errors until one exists), and, if it's valid only against a foreign collection rather than the current stream, a `STREAM_METHODS_FOREIGN_ONLY` entry to keep it off the `$$` member list.

**The database ref (`$$$`) keeps the `[key: string]: any` tail.** Typing `$$$.<coll>` as a chainable ref — so a foreign-collection chain (`$$$.orders.filter(...).sortBy(...)`) gets the same stream-method completion `$$` chains do — was prototyped and reverted: it regresses either the canonical `.find(pred)` form (the callback's parameter trips `noImplicitAny`, because a real-typed receiver no longer suppresses the check the way an `any` receiver does) **or**, once `.find`/`.aggregate` are given explicit callback signatures to fix that, the `$out` write form (`$$$.coll = $$…` — a bare `JsmqlCollectionRef` is no longer assignable to a ref that names those members). `$$$.<coll>` is simultaneously a read head (wants `.find`) and an `$out` write target (must accept a `$$` stream), and one index type can't serve both cleanly. Clean foreign-chain typing needs the schema / collection-name threading tracked by `[DEF-013]` / `[DEF-015]`.

### Value-method augmentations

The lodash-flavoured **value** methods — a JS-array / string / number method jsmql recognises (the `METHODS` registry in [`src/codegen.ts`](../../src/codegen.ts)) beyond the native ones — are called on *values* (`$.items.uniq()`, `$.name.capitalize()`), not on a `$`-prefixed global. Completion therefore needs the *receiver* to have a real type, so `valueMethodAugmentationBlock()` augments the built-in `Array<T>` / `String` / `Number` interfaces with them:

- **Signatures** live in the generator's hardcoded `VALUE_METHOD_SIGNATURES` map (same rationale as `STREAM_METHOD_SIGNATURES` — they matter only to completion and aren't in any registry in TS form). Each entry is `{ recv, sig, doc }`; `recv` picks the interface, `sig` is the `(params): Return` text (Array sigs reference the element type `T`). **Return types are chosen so chains stay typed** — element-preserving ops return `T[]`, element accessors `T`, aggregates `number`, `chunk` `T[][]`, `groupBy`/`keyBy`/`countBy` a `Record<…>`, etc. Param types are permissive (jsmql validates the real argument at compile time; the TS type only needs to not *reject* valid jsmql).
- **Drift protection.** `VALUE_METHOD_SKIP` buckets every registry method that is *not* augmented — `nativeArray` / `nativeString` (already typed by lib.d.ts), `date` (getters native on `Date`), `object` (see below), `set` / `regex` (native on `Set`/`RegExp`), and `shimmed` (error-only, e.g. `.unzipWith`). The block asserts every non-skipped registry method has a signature, every signature is a real non-skipped method, and every skip name is a real registry method — so adding a value method to jsmql without a signature (or a skip entry) fails the build, exactly like `streamMethodMembers()` does for the stream vocabulary. `valueMethodNames()` (exported from `src/codegen.ts`) is the registry source of truth for the check.

Two boundaries are inherent, not incidental:

- **The receiver must be concretely typed.** A bare `$.field` is `any`, and `any.uniq()` stays `any` — so the augmentation "activates" only on an annotated `$`, a typed static (`Object.values(o)`), a literal, or a known-return method result mid-chain. This is the same tension `[DEF-016]` notes for `$op(...)` returns: `$.field` must stay `any` so operator forms (`$.age > 18`) type-check, and `any` can't also carry completion. The augmentation is safe precisely because it never forces a field ref to narrow — it only adds members to types that are *already* concrete.
- **Object-receiver methods are excluded.** `.mapValues` / `.pick` / `.omit` / `.invert` / `.pickBy` / `.omitBy` / `.toPairs` would have to be hung on `interface Object`, the base of every type — which would advertise them (misleadingly) on numbers, strings, and arrays. They sit in `VALUE_METHOD_SKIP.object` and get no completion.

Covered by the type-level regression test [`test/types/ops-completion.ts`](../../test/types/ops-completion.ts) (run through `tsc` by `test/smoke.test.ts`): positive chains plus `@ts-expect-error` typos that prove the surface isn't silently `any`.

### Stable ordering

The generator sorts:

- Section order: stages, then expression operators, then the context refs (`$$` / `$$$` / `$$$$`, themselves in scope order).
- Within each section: alphabetical by name (`Object.keys(…).sort()`); the context-ref methods are sorted within each const too.
- YAML files listed by `readdirSync(…).sort()` so the loader is platform-stable.

This determinism is required for the drift test to byte-compare without spurious failures.

### Final formatting pass

After writing the file, the generator invokes `node_modules/.bin/oxfmt` to normalise spacing, line breaks inside argument-object literals, and trailing commas. The drift test mirrors this by piping its own output through the same binary via `--stdin-filepath`. Outside Claude Code or CI, `npm run generate:ops` runs the full pipeline.

## Subpath export

`package.json`:

```json
"exports": {
  ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
  "./ops": { "types": "./dist/ops.d.ts", "default": "./dist/ops.js" }
}
```

The `default` field points at the (essentially empty) `dist/ops.js` so an accidental non-type `import "@koresar/jsmql/ops"` resolves at runtime — it's a no-op but doesn't error.

## Test coverage

[`test/operator-spec-coverage.test.ts`](../../test/operator-spec-coverage.test.ts) — drift test "src/ops.ts is byte-equal to the generator output".

[`test/smoke.test.ts`](../../test/smoke.test.ts) — existence-and-content check on `dist/ops.{js,d.ts}` in the `smoke:dist` flow.

[`test/realistic.test.ts`](../../test/realistic.test.ts) — the `Compile form: ambient ops via \`import "@koresar/jsmql/ops"\`` describe shows the runtime end-to-end without an ops-hint destructure. Linked from `README.md`, so it doubles as a copy-paste reference for new users.

## When to regenerate

The generator runs automatically on `npm run build` and `npm test`, so the committed `src/ops.ts` should always match `OPERATORS` ∪ `STAGES` × the pinned spec. The drift test fails if a contributor edits the registries without running the generator, or edits `src/ops.ts` by hand.

Bumping `PINNED_SHA` in [`vendor/fetch-mql-specs.mjs`](../../vendor/fetch-mql-specs.mjs) pulls new spec data; the next test run will fail the drift check, prompting `npm run generate:ops` and a commit of the refreshed `src/ops.ts`.
