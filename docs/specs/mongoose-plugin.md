# `@koresar/jsmql/mongoose` plugin

## What this covers

The mongoose registration plugin in [src/mongoose.ts](../../src/mongoose.ts). It has one default export — a function that takes a mongoose module and monkey-patches `Model` static methods, so they accept JSMQL source (string / arrow) at the slots where mongoose expects a filter, update document, or aggregation pipeline.

User-facing reference: README.md → *Using JSMQL with mongoose*.

## Why it exists

Mongoose's documented signatures put MQL JSON at fixed argument positions (`find(filter, …)`, `aggregate(pipeline, …)`, `updateOne(filter, update, …)`). With the strict-shape entries from [strict-shape-entries.md](strict-shape-entries.md), each of those slots has an unambiguous lowering function (`jsmql.filter`, `jsmql.pipeline`, `jsmql.update`). The plugin wires those lowering functions into the mongoose method surface, so users do not have to call them by hand at every call site:

```js
// Before
User.find(jsmql.filter("$.age > 18"));
User.aggregate(jsmql.pipeline(({ $ }) => { $match($.age > 18); $sort({ age: 1 }); }));
User.updateMany({}, jsmql.update(({ $ }) => $.score += 1));

// After registration
require("@koresar/jsmql/mongoose")(mongoose);
User.find("$.age > 18");
User.aggregate(({ $ }) => { $match($.age > 18); $sort({ age: 1 }); });
User.updateMany({}, ({ $ }) => $.score += 1);
```

The strict-shape entries throw on wrong-shape input (for example, a stage array passed to a filter slot, or `$match` inside an update pipeline). Routing through them at the mongoose surface means a misuse like `User.updateMany({}, "$.age > 18")` fails at the patched call site with the actionable strict-mode message — instead of mongoose silently sending a bad document to the server.

## Detection rule

The plugin inspects the relevant argument at each patched slot:

| Runtime type of the argument | Action |
|---|---|
| `string`                     | Run through the strict lowerer for that slot. |
| `function`                   | Run through the strict lowerer for that slot (arrow form). |
| anything else (object, array, `null`, `undefined`, …) | Pass through to the original mongoose method unchanged. |

That rule keeps every existing MQL-JSON call site working — a plain object/array stays a plain object/array. The user pre-lowers a template-tag input (`jsmql\`…\`` returns an object), so it takes the pass-through path automatically. The mongoose layer supports no call shape that the JSMQL layer does not already support.

The plugin **does not parse function arguments to disambiguate** between a JSMQL arrow and a mongoose callback. Modern mongoose (7+) is Promise-only and no longer accepts callback arguments at these methods, so the heuristic is safe in practice.

## Implementation shape

One named wrapper per patched method, written inline. Each block in [src/mongoose.ts](../../src/mongoose.ts) follows the same four-line pattern:

```ts
const find = Model.find;
Model.find = function find(conditions, projection, options) {
  if (isJsmql(conditions)) conditions = jsmql.filter(conditions);
  return find.call(this, conditions, projection, options);
};
```

This is deliberately not abstracted into a generic helper or a lookup table:

- **A stack trace points at the method that did the wrong thing.** A failure inside `Model.updateOne(...)` shows `updateOne` in the stack, not a generic `patchMethod`.
- **The mongoose signature sits right next to the code.** A future maintainer can compare each block against `mongoose/lib/model.js` without crossing files.
- **The set of patched methods stays grep-able.** `grep "^  Model\." src/mongoose.ts` lists exactly what it covers.

## TypeScript module augmentation

The bottom of [src/mongoose.ts](../../src/mongoose.ts) carries a `declare module "mongoose" { interface Model<…> { … } }` block that adds overloads to every patched mongoose static. Each overload extends one parameter slot to accept `JsmqlInput` (`string | JsmqlFn`), so `User.find("$.age > 18")` and `User.aggregate(({ $ }) => { $match(...) })` type-check after `import "@koresar/jsmql/mongoose"` — no per-call cast required.

The augmentation is intentionally narrow:

- **It adds only the JSMQL-shaped overloads.** Mongoose's own typed `FilterQuery<T>` / `UpdateQuery<T>` / `PipelineStage[]` overloads still apply for the MQL-JSON pass-through path. Overload resolution picks our overload when the parameter is a string or function, and mongoose's overload otherwise.
- **Return types stay `any`.** Re-declaring mongoose's schema-aware `QueryWithHelpers<…>` / `Aggregate<…>` machinery from inside the augmentation would be brittle and would drift on every mongoose minor release. A user who needs the precise return type either passes a typed value (matching mongoose's own overloads) or casts at the call site. The user already crosses a type boundary the moment they hand JSMQL syntax to the driver, so mongoose's schema generics are not reachable from a string anyway.
- **Methods with two patched slots** (`updateOne`, `updateMany`, `findOneAndUpdate`) get two overloads — one with `JsmqlInput` at slot 0, one with `JsmqlInput` at slot 1 — so `updateOne(filter, jsmqlUpdate)` and `updateOne(jsmqlFilter, plainDoc)` both type-check.

The augmentation merges into mongoose's existing `Model<TRawDocType, …>` interface, so it activates only when the consumer actually has mongoose installed. A project that imports `@koresar/jsmql/mongoose` purely for the runtime function, and does not have mongoose on the resolution path, sees no spurious "mongoose is missing" errors — TypeScript silently drops the unresolved augmentation.

A type-only validation file at [test/types/mongoose-augmentation.ts](../../test/types/mongoose-augmentation.ts), driven by [test/types/tsconfig.json](../../test/types/tsconfig.json), exercises every patched overload (JSMQL string, JSMQL arrow, plain MQL JSON) against a real mongoose Model. The smoke suite in [test/smoke.test.ts](../../test/smoke.test.ts) spawns `tsc --noEmit` against it; mongoose is pinned at `"*"` in `devDependencies`, so the case always runs locally and in CI, and it is the canary that catches the augmentation drifting against mongoose's evolving generics. The `"*"` pin is deliberate — every `npm install` pulls whatever mongoose just published, so a generic-arity change or rename in mongoose shows up here before a user hits it. If the spawn does not find tsc/mongoose on a degraded environment, the case skips, so `npm test` still passes.

## Idempotence

The plugin is **idempotent** — a second `jsmqlMongoose(mongoose)` call on the same `Model` is a no-op. After the first call, the function sets `Model.__jsmqlPatched = true`, and the next call short-circuits on that flag. This is one property check, with no `Symbol.for` indirection. It stays minimal because the failure mode it prevents (double-wrap, then a second wrap that re-`jsmql.filter()`s an already-lowered object) is quietly weird rather than loud, and the user has nowhere else to look for the bug.

## Patched methods and their slots

The set mirrors the static methods exported by `mongoose/lib/model.js` (mongoose 9.x):

| Mongoose method | jsmql-eligible slot(s) | Lowerer used |
|---|---|---|
| `find(conditions, projection, options)` | 0 | `jsmql.filter` |
| `findOne(conditions, projection, options)` | 0 | `jsmql.filter` |
| `findOneAndDelete(conditions, options)` | 0 | `jsmql.filter` |
| `findOneAndReplace(filter, replacement, options)` | 0 | `jsmql.filter` |
| `findOneAndUpdate(conditions, update, options)` | 0, 1 | `jsmql.filter`, `jsmql.update` |
| `findByIdAndUpdate(id, update, options)` | 1 | `jsmql.update` |
| `countDocuments(conditions, options)` | 0 | `jsmql.filter` |
| `distinct(field, conditions, options)` | 1 | `jsmql.filter` |
| `deleteOne(conditions, options)` | 0 | `jsmql.filter` |
| `deleteMany(conditions, options)` | 0 | `jsmql.filter` |
| `updateOne(conditions, doc, options)` | 0, 1 | `jsmql.filter`, `jsmql.update` |
| `updateMany(conditions, update, options)` | 0, 1 | `jsmql.filter`, `jsmql.update` |
| `replaceOne(conditions, doc, options)` | 0 | `jsmql.filter` |
| `exists(filter, options)` | 0 | `jsmql.filter` |
| `aggregate(pipeline, options)` | 0 | `jsmql.pipeline` |

### Methods deliberately not patched

- **`findOneAndReplace(filter, replacement, …)` and `replaceOne(filter, replacement, …)`** — the second argument is a complete *replacement document*, not an update spec. A JSMQL expression at that slot would silently land as a literal object (the same pitfall `jsmql.update()` exists to prevent at the update slot). The filter slot is patched; the replacement slot is not.
- **`findById`, `findByIdAndDelete`** — id-only methods. They have no jsmql-eligible slot.
- **`Query.prototype.*` (`.where()`, `.gt()`, `.sort()`, …)** — deliberately not patched, and not planned. JSMQL keeps the mongoose surface small (the `Model` statics), so a developer does not have to learn a new API — DX comes first, and any extra surface is extra complexity to learn. The Query builder is a separate surface the user composes *after* a static call, not a call site where a driver method name fixes the shape.
- **`Model.create`, `insertOne`, `insertMany`, `Document#save`** — these take whole documents, not query filters.

## Subclass propagation

Mongoose compiles a fresh `Model` subclass per `mongoose.model(name, schema)` call. JavaScript class statics are inherited through the constructor's prototype chain, so patching `mongoose.Model.find = …` propagates to every subclass automatically — it needs no per-model bookkeeping. Each wrapper uses `original.call(this, …)`, so the subclass receiver (the actual model the user called) reaches the original mongoose method untouched. [test/mongoose.test.ts](../../test/mongoose.test.ts) covers this with an explicit `class User extends Model {}` case.

## CJS interop

`require("@koresar/jsmql/mongoose")(mongoose)` is the primary documented call shape. esbuild's CJS bundling of an ES-module default export lands the function at `module.exports.default`, so [scripts/build-cjs.mjs](../../scripts/build-cjs.mjs) appends a short footer to `dist/cjs/mongoose.cjs` that promotes the default export to `module.exports = fn`, while it keeps `.default = fn` for ESM-style synthetic imports. The same source file makes both call shapes work. The smoke test in [test/smoke.test.ts](../../test/smoke.test.ts) locks the `require(…)(…)` shape down end-to-end against the actual built bundle.

## When to update this spec

- A new mongoose method enters the patched set (or an existing one moves slots) — add a per-method wrapper to [src/mongoose.ts](../../src/mongoose.ts), add a row to the table above, and add a test case to [test/mongoose.test.ts](../../test/mongoose.test.ts).
- A new shape distinction enters the JSMQL layer that affects which lowerer fits which slot.
- The CJS interop strategy changes (for example, esbuild's default-export shape changes in a future major version).
