# `jsmql/ops` — spec-generated ambient types

## Purpose

How `src/ops.ts` is generated from the canonical jsmql registries and the vendored MongoDB MQL spec, exposed as the `jsmql/ops` subpath. The companion user-facing reference is [`docs/LANGUAGE.md` § Operator autocomplete](../LANGUAGE.md#operator-autocomplete-jsmqlops).

The module is **pure-types** at the source: `declare global { … } export {};`. There are no exported runtime values. Users import it with `import "jsmql/ops"` (the side-effect form — TS does not allow `import type "…"` on a side-effect-only import), which costs one empty-module load and brings every stage and operator into ambient global scope. The runtime path is unchanged — the parser already accepts bare `$stage(…)` / `$op(…)` calls via [`STAGES`](../../src/stages.ts) and [`OPERATORS`](../../src/operators.ts); this module exists solely so TypeScript stops underlining the names and the IDE has something to autocomplete.

Users who want zero runtime impact can instead add `"jsmql/ops"` to their tsconfig's `compilerOptions.types` array; the ambient declarations propagate without any `import` statement.

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

A single `src/ops.ts` file containing one `declare global { … } export {};` block, alphabetised within two sections:

1. **Stages** — every key of `STAGES`.
2. **Expression operators (incl. accumulators and window functions)** — every key of `OPERATORS`. Accumulators sit in the same registry; the section header reflects that this set covers all non-stage callables.

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

### Stable ordering

The generator sorts:

- Section order: stages first, then expression operators.
- Within each section: alphabetical by name (`Object.keys(…).sort()`).
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

The `default` field points at the (essentially empty) `dist/ops.js` so an accidental non-type `import "jsmql/ops"` resolves at runtime — it's a no-op but doesn't error.

## Test coverage

[`test/operator-spec-coverage.test.ts`](../../test/operator-spec-coverage.test.ts) — drift test "src/ops.ts is byte-equal to the generator output".

[`test/smoke.test.ts`](../../test/smoke.test.ts) — existence-and-content check on `dist/ops.{js,d.ts}` in the `smoke:dist` flow.

[`test/realistic.test.ts`](../../test/realistic.test.ts) — `e-commerce: reusable eligible-users query via \`import type 'jsmql/ops'\`` shows the runtime end-to-end without an ops-hint destructure. Linked from `README.md`, so it doubles as a copy-paste reference for new users.

## When to regenerate

The generator runs automatically on `npm run build` and `npm test`, so the committed `src/ops.ts` should always match `OPERATORS` ∪ `STAGES` × the pinned spec. The drift test fails if a contributor edits the registries without running the generator, or edits `src/ops.ts` by hand.

Bumping `PINNED_SHA` in [`vendor/fetch-mql-specs.mjs`](../../vendor/fetch-mql-specs.mjs) pulls new spec data; the next test run will fail the drift check, prompting `npm run generate:ops` and a commit of the refreshed `src/ops.ts`.
