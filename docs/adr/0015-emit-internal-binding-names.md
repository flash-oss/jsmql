# 0015. The compiler encodes every variable name injectively, and a minted name never captures a user name

Status: Accepted
Applies to: `src/compiler/emit/names.ts`, `test/codegen.test.ts`

## Context

MongoDB variables live in ONE flat scope. The lambda parameters of the developer, a `$let` that the developer wrote, and each variable that a lowering binds share it. Three problems can happen there: a name that the server refuses, two JavaScript names that become one variable, and a compiler name that captures a name of the developer. Many lowerings bind the receiver in a `$let`, or bind a synthetic callback parameter, and then splice a user expression into the body. When an internal name equals a user name, the spliced `$$name` silently points at the wrong value. The result is wrong values, not an error. `src/compiler/emit/names.ts` closes each problem with a type, not with care at each site.

## Decision

The encoding:
- MEASURED on mongod with `$let: { vars: { <name>: 7 } }`: `x`, `x_1`, `xY`, `jsmqlArr` and `v_id` pass. `_x`, `X` and `1x` fail, because the first character is not allowed. `x-y` and `x$` fail, because a later character is not allowed.
- Only `mongoVarName` mints a `MongoVar`, and it is total and injective. `PLAIN` (`/^[a-z][A-Za-z0-9_]*$/`) is what the server takes as written. A plain name that does not start with `v_` stays as it is, so the MQL reads as written. Every other name becomes `v_` plus an escape. In an escaped result, `_` only opens an escape of fixed width. Examples: `_id` → `v__5fid`, `$x` → `v__24x`, `X` → `v_X`, `v_id` → `v_v_5fid`, `é` → `v__e9`. A code point below U+0100 takes two hex digits. `_u` plus four hex digits covers a code point below U+10000 (`漢` → `v__u6f22`). `_U` plus six hex digits covers the rest (`😀` → `v__U01f600`). A reader can decode the result one escape at a time.
- A scheme that only adds a letter at the front makes `_id` and `v_id` the same variable. The injective encoding prevents this.

The minted names:
- `Scope.root(introduced)` marks every name that the PROGRAM binds as taken: each parameter and declaration that `namesIn` collects, plus `SYSTEM_VARS`. So a mint at a site steps aside from a parameter that a deeper lambda binds later.
- `Scope.param` encodes a name of the developer and never renames it. `Scope.bind(hint)` mints `jsmql<Hint>`, then `jsmql<Hint>2`, `jsmql<Hint>3`, … while a binding already uses the name. So a lambda parameter named `jsmqlArr` pushes the internal binding to `jsmqlArr2`, and the user's name stays the `as`. The common case keeps the base name, so the output stays stable.
- `Binder` carries the variable and the scope that the body lowers under. The compiler can lower the body only under `binder.scope`, so the mint stays visible to the body, and the names of the body stay clear.
- A callback with no parameters still takes an `as` name in the emitted MQL. The compiler mints it, so an inner callback does not shadow the outer element: in `$.a.map(v => $.b.map(() => v))`, `$$v` reads the outer element.
- The `.fill(value, start)` lowering builds the value inside a synthetic `(el, idx)` map callback. A pipeline binding with the same name as a synthetic parameter, for example `let x = 5; $.arr.fill(x, 1)`, still reads as 5.
- An iteratee's `$let` must not enclose the `$reduce` accumulator reads. A parameter named `value` would shadow `$$value`, so the dedupe test of `.uniqBy` would read `.seen` off the element, and every element would survive.
- A string lowering such as `.truncate()` or `.endsWith()` binds and coerces the receiver once in a `$let`. It emits the receiver once, not once per use, and an absent field reads as `""`, not as null.
- The spellings `jsmql<Hint>` and `__jsmql.tmp.<n>` live in `src/namespace.ts`.

The located bindings:
- A `var` in `Located` keeps the level that binds it. An expression that binds a variable does not cross into the sub-pipeline of a stage that the compiler hoists out of it. The other kinds name a document level and a path. Their letter names the variable that carries the value across a `$lookup`: `f` a field, `v` a `let` binding, `s` a system value.
- A `streamHandle` binding keeps its `chain`. A value that it materialises, for example its count, belongs on THAT pipeline only. A `$facet` branch and a body over another collection each build their own chain. A stamp on the wrong chain counts the wrong documents under the same field name, and the server answers with no error. For example, a level taken from the READ puts two counts on one `$__jsmql.size` field, and `shpmntsColl.size() < ordersColl.size()` then compares a value with itself.
- `names.ts` imports `Chain` from `env.ts` as a type only. So nothing loads at run time, and `env.ts` can still import `names.ts`.

## Consequences

- A new variable mint must go through `mongoVarName` or `Scope.bind`, never a fixed string.
- A change to the encoding must stay injective and must keep plain names as written.
- Test each new lowering with a user parameter that has the internal base name.
- The import from `env.ts` must stay type-only.
