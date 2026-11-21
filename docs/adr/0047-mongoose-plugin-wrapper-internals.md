# 0047. Shape of each mongoose wrapper, and the type-only import for the augmentation

Status: Accepted
Applies to: `src/mongoose.ts`

## Context

src/mongoose.ts patches mongoose `Model` statics one by one. A named function expression binds its own name inside its body. So a captured original with the same name is not reachable from inside the wrapper.
The module also augments the mongoose types. A `declare module "mongoose"` block needs mongoose in the program to have a target interface. The plugin must add no runtime dependency on mongoose.

## Decision

Each patched method gets its own named wrapper, written inline. The module has no generic helper and no lookup table. Three reasons apply:
- A stack trace names the method that failed. A failure inside `Model.updateOne(...)` shows `updateOne`, not a generic `patchMethod`.
- The mongoose signature of each method sits next to its code. A maintainer can compare each block with `mongoose/lib/model.js` in one file.
- A search lists the patched set: `grep "^  Model\." src/mongoose.ts`.

The wrapper captures the original under `_<name>` (for example `_find`). Inside `function find(...) { ... }`, the name `find` resolves to the wrapper itself, not to an outer `const find`. Without the prefix, the wrapper calls itself in a loop and the stack overflows.

The file has `import type {} from "mongoose"`. This type-only import brings mongoose into the program, so the `declare module "mongoose"` block has an interface to merge with. TypeScript erases the import at emit, so it adds no runtime dependency. The shape is valid under `--isolatedDeclarations` and `--verbatimModuleSyntax`, and bundlers remove it.

## Consequences

A new patched method gets its own block, and uses the `_<name>` capture. A rename of the capture to the bare method name makes the wrapper recurse. Do not change the type-only import to a value import, because that adds a runtime mongoose dependency.
