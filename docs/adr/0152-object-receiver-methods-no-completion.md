# 0152. Ambient completion for object-receiver value methods

Status: Rejected
Applies to: `VALUE_METHOD_SKIP.object` in `scripts/generate-globals.mjs`, `src/globals.ts`, `docs/specs/globals-generation.md` § Value-method augmentations

## Context

The `@koresar/jsmql/globals` value-method augmentations type the lodash value methods onto the built-in `Array<T>`, `String` and `Number` interfaces. So the methods autocomplete on a receiver with a concrete type. The idea: give the object-receiver value methods the same completion.

## Decision

The project leaves the object-receiver methods without completion. The only interface that can carry them is `Object`, the base of every type. An augmentation of `Object` would show them, falsely, on numbers, strings, arrays and every other value in a file that imports the module.

## Consequences

- The `VALUE_METHOD_SKIP.object` set in `scripts/generate-globals.mjs` names the methods that the generator skips.
- The methods work in JSMQL exactly as documented. They do not show in IDE completion.
- See `docs/LANGUAGE.md` § Operator autocomplete and `docs/specs/globals-generation.md` § Value-method augmentations.
- Reconsider only if a narrower "plain object" carrier type becomes available. For example, schema threading (DEF-013) can type a document field as a specific object shape. Then `.pick` and `.omit` on that field can complete without an augmentation of the global `Object`.
