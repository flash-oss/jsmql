# 0038. Error frames and entry-form details in the public entry (index.ts)

Status: Accepted
Applies to: `src/index.ts`

## Context

`src/index.ts` turns the input of a caller into source and values, runs the compiler, and frames each error. Some details of that work affect the message that a developer reads.

## Decision

- An entry can run inside another entry: the `toBSON()` of a parameter can call `jsmql`. The error then leaves through both entries. Its `.pos` is a position in the inner source only, so only the inner entry frames it. `FRAMED` records each framed error.
- The caret line of the frame keeps each tab of the source line, so the caret stays under the fault.
- `framed` reads `e.stack` before it changes `e.message`. V8 builds the stack on the first read, from the message at that time. The function then replaces the old message inside the stack text.
- `isEntryForm` accepts `function f(…) { … }` only when its body is the whole input. A declaration that more statements follow is a program that declares a function.
- `received` reports a binding in front of one expression as the Filter that the expression is. A `;` alone does not make a Pipeline. A Pipeline message sends the developer back to the pipeline entry that the developer already called.
- The compiler judges the shape of a program only when the program is correct. A value such as `Date("nope")` is wrong under every entry. So the pipeline entry first calls `defectAsFilter`. This function lowers the program as a Filter and reports a defect that the developer must fix under every entry. It gives null when only the shape is wrong, and the entry then reports the shape. It searches only the filter reading, because that is the shape of a program that the pipeline entry refuses. Another reading gives a position that the developer never asked about.
- `expressionOf` gives the one expression of a Filter or expression program after the fold inlines its `const` prelude. A binding that the fold could not settle reads the document, so it goes in as the expression. The compiler refuses a `let` in such a prelude, because it needs the pipeline form, where it becomes a field.
- `JsmqlToolbox` is `any`, not a type with an index signature. A developer can declare an arrow apart from the call, with its own toolbox type that has a required member for each name. An index signature cannot give a required member, so that arrow does not type-check against it.

## Consequences

A change to the frame must keep the stack and the message in step. A change to the order of the defect check and the shape check changes which error a developer sees first.
