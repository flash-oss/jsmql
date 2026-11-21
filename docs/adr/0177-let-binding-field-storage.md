# 0177. A pipeline `let` lives in a field under `__jsmql.var`, and a read names it bare

Status: Accepted
Applies to: `letStages` in `src/compiler/emit/statement.ts`, docs/specs/let-bindings.md

## Context

A developer can already store a value with an update op (`$.x = …`). The `let` statement adds a binding that the next statements read.

## Decision

- Every binding materialises under one nested field, `__jsmql.var.<name>`. So the binding never touches a real field of the user's document with the same name, and one trailing `$unset` removes every binding.
- A read names the binding bare (`total`, not `$.total`). So a read of a scratch value looks different from a read of a real field. Each derivation also gets its own line, where a comment can state the intent.
- The construct is a thin layer over the existing primitives, and it adds no feature on the server side.

## Consequences

A pipeline with no `let` carries no trace of the namespace.
