# 0016. How inputs.ts binds callbacks and words the refusal of a callback slot

Status: Accepted
Applies to: `src/compiler/emit/inputs.ts`

## Context

`src/compiler/emit/inputs.ts` builds the record that a renderer receives. A renderer never binds a parameter. The constructors bind each callback, and they refuse an argument that is not the callback the slot wants. The desugar pass rewrites each short spelling first, so the constructors see fewer shapes.

## Decision

- `callback` binds one element parameter, and the compiler lowers the body under it. An index or receiver parameter is a different lowering. No row that reaches `callback` states one, so `callback` raises an internal error for any other count.
- `arrayCallback` reads the proof of one element of the receiver where the registry can show it. The proof comes from a written list of strings, a `.split()`, or a row whose `returns` states its element. Without the proof, a string key read as `$.m[k]` takes the run-time array or object dispatch. Its array arm gives `$arrayElemAt` a string, and the server refuses that (measured). The element keeps its own presence, not the presence of the array. `$map` over null never runs the body. An element that the row proves present, for example from `.keys()` or `.split()`, is never null.
- A callback that names no parameter still needs a binder. `arrayCallback` mints one with `env.fresh("unused")`, a name that the program cannot spell. A binder `_` would collide with the developer's own `_`, which encodes to the same MongoDB variable.
- `exprInputs` takes `overrides`, so a dispatcher can substitute a lowering for one argument. An example is the `$let` arrow, whose body the compiler lowers under its variables. The renderer does not know about the substitution.
- `exprInputs` and `stageInputs` refuse an argument that is not an arrow, in a slot that takes an iteratee or a predicate. An earlier pass rewrites each short spelling that the row accepts. So the refusal names the spellings that remain (`slotFormsOf`). A well-formed `[field, value]` pair is already an arrow. A pair that arrives is malformed. A shorthand such as `.countBy(String)` that arrives is the developer's mistake.
- `callbackRefusal` gives each callback mistake its own sentence. Each mistake has its own fix.
- A block slot has one spelling. So an argument that is not an arrow gets the sentence that an arrow with a value body gets (`valueWhereBlockExpected`).
- `stageInputs` gives `value` as the reading that the position of the body asks for. So the row of `$match` makes its body a query document, and a sub-pipeline makes its elements stages. The cell does not know that it asked for anything but a value.
- `stageInputs` takes `written`, the method that the source wrote. A link can run as another row, for example `$$$.users.find(p)` runs `filter`. Messages use `written`. Everything else uses the row.
- A stream callback binds its first parameter to the element of the stream. That is the document, or the unwound field after `.flatMap("items")`. A stream has no per-document index, and the receiver is the stream itself. So `stageInputs` binds the index parameter as a name whose read gives a refusal that says what to write instead.

## Consequences

A new callback shape needs a constructor here, not a binding inside a renderer. A change to the desugar pass that stops a rewrite of a shorthand must also change the refusals here. The fresh binder must stay a name that the source cannot spell.
