# 0009. Server facts behind the literal checks in check.ts

Status: Accepted
Applies to: `src/compiler/emit/check.ts`

## Context

`src/compiler/emit/check.ts` refuses a literal argument only when the server always refuses it. The general rule is in `docs/specs/emit-pass.md` § Operand shapes and the checks. The rules below rest on server behaviour that no spec states.

## Decision

- A `fieldPath` slot reads the string from the source, not through the literal gate. A field NAME is the one slot where a string that starts with `$` is the error, not a runtime value. The server refuses `{ $count: "$n" }`. It also refuses a dotted name and an empty name.
- `checkEnum` usually skips a string that starts with `$`, because that string is a field reference. In a constant-only slot, the server reads the string as itself. MEASURED: the server refuses `{ $bucketAuto: { granularity: "$g" } }` as a value outside the set. So in a constant key the closed set applies to a `$`-led string too.
- `checkBody` does not judge a body that the call supplies whole as one `Injected` value (`.set(${parts})`). That body is a value, and the server judges its keys.
- A key in `constantKeys`, and an argument the row marks constant, must hold a compile-time constant. The server reads it before any document, and refuses a field path or an expression there. An `Injected` value counts as a constant, because the call supplies it before the compile.
- `checkSlots` exempts an object literal from `slotType` when the row states an object form (`hasObjectForm`). The date accessors take a date or a `{ date, timezone }` document, and the `body` rule of the row judges the document. With no object form, an object literal is the wrong type: the server refuses `$documents({ a: 1 })`.
- The same exemption applies to the constant check. For a body that may be a name or a document, the `body` rule describes the keys, and some keys hold expressions. `$unionWith("c")` must be constant. `$unionWith({ coll: "c", pipeline: [$match(…)] })` must not be.
- A slot type in `SOURCE_CHECKED` gives its own reason. So a refusal names the one shape the value nearly was, for example `$unwind("items")` is a path with no leading `$`.

## Consequences

A new constant-only slot must list its keys in `constantKeys`, or a `$`-led string escapes the closed set. Verify each new server fact on the `:27018` mongod before a rule depends on it.
