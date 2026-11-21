# 0158. What the mongoose plugin patches, and how it reads an argument

Status: Accepted
Applies to: `src/mongoose.ts`

## Context

mongoose puts MQL at fixed argument positions: `find(filter, …)`, `aggregate(pipeline, …)`, `updateOne(filter, update, …)`. Each such slot has one strict-shape entry that lowers JSMQL to its shape. Without the plugin, a developer calls that entry by hand at each call site.

## Decision

- The plugin patches the `Model` statics only. It patches no `Query.prototype` method (`.where()`, `.gt()`, `.sort()`), and the project plans no patch of them. A small surface means that a developer learns no new API. The Query builder is a surface that a developer composes after a static call. No driver method name fixes the shape there.
- The plugin patches the filter slot of `replaceOne` and `findOneAndReplace`, but not the replacement slot. A replacement is a whole document, not an update. A JSMQL expression there would become a literal object, with no error. `jsmql.update()` exists to stop the same mistake at the update slot.
- The plugin reads each slot by the runtime type of the argument. A string or a function is JSMQL. Every other value passes through unchanged. The plugin does not parse a function to tell a JSMQL arrow from a mongoose callback. mongoose 7 and later accept no callback at these methods, because they are Promise-only.
- The plugin sets `Model.__jsmqlPatched` after the first call, and a second call returns at once. A second wrap would lower a document that the first wrap already lowered. That failure is quiet and strange, and the developer has no other place to look for it. One property check is enough, so the plugin uses no `Symbol.for` key.
- The type augmentation adds only the overloads for a JSMQL input, and their return type is `any`. A new declaration of the schema-aware return types of mongoose (`QueryWithHelpers<…>`, `Aggregate<…>`) inside the augmentation breaks easily, and changes with each mongoose minor release. A JSMQL string also reaches none of the schema generics of mongoose.
- `devDependencies` pins mongoose at `"*"`. Each `npm install` then takes the newest mongoose. A change of generic arity or a rename in mongoose fails the type check of the augmentation before a user meets it.

## Consequences

Every existing MQL call site keeps its behaviour. A developer who needs the precise return type passes a typed value, or casts at the call site. A new patched method follows the same slot rules, and gets a row in the table of `docs/specs/mongoose-plugin.md`.
