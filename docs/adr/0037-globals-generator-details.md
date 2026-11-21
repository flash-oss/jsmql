# 0037. Small type decisions in the globals generator

Status: Accepted
Applies to: `scripts/generate-globals.mjs`

## Context

`scripts/generate-globals.mjs` writes `src/globals.ts`. `docs/specs/globals-generation.md` states the main contract. Some smaller decisions in the generator have no place in that spec.

## Decision

- Value terminals (`valueTerminalMethodNames()`) return `any`, because the result is a document or a field of one. The numeric aggregates are the exception: `VALUE_TERMINAL_RETURNS` gives them `number`. `terminalParams` uses a signature from `VALUE_TERMINAL_PARAMS` when one exists. Otherwise a terminal with no argument (from `argCountOf`) is `()`, and every other terminal takes `(...args: any[])`.
- `length` is in `VALUE_METHOD_SKIP.nativeString`. The method `.length()` reads the native `length` property, and the call form gets its type through `$`.
- `.range` on a number reads like lodash's `_.range`. With no argument, the receiver is lodash's `end`. With more arguments, the receiver is lodash's `start`.
- `mapType` maps a singleton `query` or `object` type to `any`, not to `Record<string, any>`. JSMQL accepts more than the MQL spec shows. `$match` takes a boolean expression that the compiler wraps in `$expr`, for example `$match($.age >= 18)`. A tighter type would refuse the most common use.
- `resolvesToObjectId`, `resolvesToTimestamp` and `resolvesToBinData` map to `any`. A JSMQL ObjectId literal is `0x…` hex, and TypeScript types it as `number`. `ObjectId("…")`, `Timestamp` and `Binary` are `bson` classes, and the globals module does not import `bson`. So a narrower type misleads.
- Every key of an object signature is optional. TypeScript completes the keys from the overload that the call matches. An incomplete object literal, which the developer has while the developer types, must still match the documented overload. With a required key, TypeScript selects the catch-all, and the key completion is lost. MEASURED with the TypeScript language service: `$trim({ | })` completes `input` and `chars`, and `$dateAdd({ startDate: x, | })` completes the other three keys.
- An operator of shape `verbatim` takes one operand, and the server gets it untouched. So the signature has one parameter of the type of the first spec argument.
- `$count` is a name that is both a stage and an operator. The generator emits it once, in the Stages section, with the overloads of both meanings. Identical signatures from both sides merge into one.
- The JSDoc of a name prefers the stage spec, then the operator spec, then the description of the row. The stage description is the higher-level one that a user wants first.

## Consequences

A new name that is both a stage and an operator follows the `$count` rule. Keep the `query` and `object` types permissive while `$match` accepts an expression.
