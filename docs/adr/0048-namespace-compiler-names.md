# 0048. The three compiler namespaces and the constraints on each spelling

Status: Accepted
Applies to: `src/namespace.ts`

## Context

The compiler must store temporary values in documents and bind its own MongoDB variables. These names must not collide with the developer's fields, variables or lambda parameters. MongoDB has different grammar rules for field names and for `$$` variable names.

## Decision

src/namespace.ts owns the spelling of the namespaces of the compiler.
Document fields. All compiler temporaries live under the one top-level object `__jsmql`. The bucket `__jsmql.var.<name>` holds a `let` or `const` binding (`bindingSlot`). The bucket `__jsmql.tmp.<n>` holds anonymous scratch (`tmpSlot`). The bucket `__jsmql.<reserved>` holds a named system value such as the stream size. Scratch covers each temporary value that a lowering needs. The Env in src/compiler/emit/env.ts holds the per-pipeline scratch counter, and it builds the path through `scratchSlot` in src/compiler/emit/names.ts. When a stage writes under the namespace, the Env appends one trailing `{ $unset: "__jsmql" }`, which removes all of it before output.
The one exception is `GROUP_TMP` (`__jsmqlTmp`). The server forbids dots in a `$group` or `$bucket` accumulator output key, so scratch made inside a group cannot live under the object. That scratch uses the flat reserved name. The stage that immediately follows must consume it, so it never reaches the output or the trailing `$unset`.
Correlation variables. A sub-pipeline reads an outer value through `$lookup.let` as a `$$<name>` variable. The server refuses a variable name that starts with `_`, `$` or an uppercase letter. So the prefix is `jsmql_`, with no leading `__`. The shape is `jsmql_<kind><scopeDepth>_<name>`. `scopeDepth` is the depth of the JS scope that holds the value: 0 is the root pipeline, 1 is the first lookup body. `kind` is `f` for a document field, `v` for a `let` or `const` binding, and `s` for a system value. The connector after the depth is always one `_`, so a field `_id` gives `jsmql_f0__id` with a doubled underscore, by design.
Expression variables. A lowering that binds its own value (a receiver it must not evaluate twice, a loop element, an index) emits a `$let`, `$map` or `$filter` variable. That name shares one flat scope with the developer's lambda parameters. A bare name such as `s` is a capture hazard when the lowering also puts outer-scope code into the `in:` clause. For example, `.lastIndexOf(s.n)` inside `.map(s => …)` would resolve `s` against the wrong value. The spelling is `jsmql<Hint>` (`exprVar("arr")` gives `jsmqlArr`), with the same grammar as the correlation variables. The prefix is only a convention, because a developer can name a parameter `jsmqlArr`. `Scope.bind` in src/compiler/emit/names.ts gives uniqueness: it adds a number (`jsmqlArr2`) when a program name is in the way. Callers must reach `exprVar` through `Scope.bind`, never directly.

## Consequences

Add a new temporary only through these helpers, never as a new top-level `__` field. Code that writes `GROUP_TMP` must consume it in the next stage. A new correlation-variable kind must keep the lowercase lead.
