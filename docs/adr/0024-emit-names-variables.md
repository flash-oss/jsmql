# 0024. The MongoDB variable names that the compiler writes

Status: Accepted
Applies to: `src/compiler/emit/names.ts`

## Context

MongoDB variables live in ONE flat scope. The lambda parameters of the developer, a `$let` that the developer wrote, and each variable that a lowering binds share it. Three problems can happen there: a name that the server refuses, two JavaScript names that become one variable, and a compiler name that captures a name of the developer. `src/compiler/emit/names.ts` closes each problem with a type, not with care at each site.

## Decision

- MEASURED on mongod with `$let: { vars: { <name>: 7 } }`: `x`, `x_1`, `xY`, `jsmqlArr` and `v_id` pass. `_x`, `X` and `1x` fail, because the first character is not allowed. `x-y` and `x$` fail, because a later character is not allowed.
- Only `mongoVarName` mints a `MongoVar`, and it is total and injective. `PLAIN` (`/^[a-z][A-Za-z0-9_]*$/`) is what the server takes as written. A plain name that does not start with `v_` stays as it is, so the MQL reads as written. Every other name becomes `v_` plus an escape. In an escaped result, `_` only opens an escape of fixed width. Examples: `_id` → `v__5fid`, `$x` → `v__24x`, `X` → `v_X`, `v_id` → `v_v_5fid`, `é` → `v__e9`. A code point below U+0100 takes two hex digits. `_u` plus four hex digits covers a code point below U+10000 (`漢` → `v__u6f22`). `_U` plus six hex digits covers the rest (`😀` → `v__U01f600`). A reader can decode the result one escape at a time.
- A scheme that only adds a letter at the front makes `_id` and `v_id` the same variable. The injective encoding prevents this.
- `Scope.root(introduced)` marks every name that the PROGRAM binds as taken: each parameter and declaration that `namesIn` collects, plus `SYSTEM_VARS`. So a mint at a site steps aside from a parameter that a deeper lambda binds later.
- `Scope.param` encodes a name of the developer and never renames it. `Scope.bind(hint)` mints `jsmql<Hint>`, then `jsmql<Hint>2`, `jsmql<Hint>3`, … while the name is taken.
- `Binder` carries the variable and the scope that the body lowers under. The compiler can lower the body only under `binder.scope`, so the mint stays visible to the body, and the names of the body stay clear.
- A `var` in `Located` keeps the level that binds it. An expression that binds a variable does not cross into the sub-pipeline of a stage that the compiler hoists out of it. The other kinds name a document level and a path. Their letter names the variable that carries the value across a `$lookup`: `f` a field, `v` a `let` binding, `s` a system value.
- A `streamHandle` binding keeps its `chain`. A value that it materialises, for example its count, belongs on THAT pipeline only. A `$facet` branch and a body over another collection each build their own chain. A stamp on the wrong chain counts the wrong documents under the same field name.
- `names.ts` imports `Chain` from `env.ts` as a type only. So nothing loads at run time, and `env.ts` can still import `names.ts`.
- The spellings `jsmql<Hint>` and `__jsmql.tmp.<n>` live in `src/namespace.ts`.

## Consequences

- A new variable mint must go through `mongoVarName` or `Scope.bind`.
- A change to the encoding must stay injective and must keep plain names as written.
- The import from `env.ts` must stay type-only.
