# 0031. errors.ts imports nothing from the compiler

Status: Accepted
Applies to: `src/errors.ts`

## Context

The registry refuses names, and many modules must throw a compiler error. If the module that holds the error classes imports the compiler, an import cycle forms. A cycle evaluates the importer before the module that it depends on. A name can then fall out of the registry with no error at all.

## Decision

`src/errors.ts` is a leaf module. It holds `CodegenError`, `UnknownIdentifierError` and `internalError`, and imports nothing from the compiler. A throw is not a compiler service, so it sits where every module can reach it. See `docs/specs/architecture.md § Error types`.

## Consequences

A change must not add an import from `src/compiler/` or `src/registry/` to `src/errors.ts`. A module that only refuses must import its error from here, not from a compiler module.
