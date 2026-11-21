# 0051. Shape of each mongoose wrapper, and the type-only import for the augmentation

Status: Accepted
Applies to: `src/mongoose.ts`

## Context

src/mongoose.ts patches mongoose `Model` statics one by one. Each wrapper is a named function, so that a stack trace names the method. A named function expression binds its own name inside its body. So a captured original with the same name is not reachable from inside the wrapper.
The module also augments the mongoose types. A `declare module "mongoose"` block needs mongoose in the program to have a target interface. The plugin must add no runtime dependency on mongoose.

## Decision

Each patch block follows the same four steps:
1. Capture the original method under `_<name>` (for example `_find`).
2. Assign a named function with the mongoose signature of that method.
3. Run each jsmql slot through the matching strict entry when the input is a string or a function. Pass every other value through unchanged.
4. Call the captured original with `.call(this, …)`. The subclass receiver and the other arguments (projection, options) reach mongoose unchanged.
The capture takes the underscore prefix because of the named-function rule. Inside `function find(...) { ... }`, the name `find` resolves to the wrapper itself, not to an outer `const find`. Without the prefix, the wrapper calls itself in a loop and the stack overflows. The example in docs/specs/mongoose-plugin.md § Implementation shape uses `const find` and has this defect, so correct the spec to `_find`.
The file has `import type {} from "mongoose"`. This type-only import brings mongoose into the program, so the `declare module "mongoose"` block has an interface to merge with. TypeScript erases the import at emit, so it adds no runtime dependency. The shape is valid under `--isolatedDeclarations` and `--verbatimModuleSyntax`, and bundlers remove it.

## Consequences

A new patched method must use the `_<name>` capture. A rename of the capture to the bare method name makes the wrapper recurse. Do not change the type-only import to a value import, because that adds a runtime mongoose dependency.
