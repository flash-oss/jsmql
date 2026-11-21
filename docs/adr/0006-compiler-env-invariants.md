# 0006. The Env record has no optional field, and each transition changes one thing

Status: Accepted
Applies to: `src/compiler/emit/env.ts`, `test/compiler-env.test.ts`, `test/types/registry-contracts.ts`

## Context

Every lowering in `src/compiler/emit/` runs under one `Env` from `src/compiler/emit/env.ts`. The Env holds three services: `scope`, `site` and `chain`. `docs/specs/state-machines.md` § The pipeline chain states the `Chain` fields. Each invariant below is the negative of a context bug.

## Decision

- No field of `Env` or `Site` is optional, and only an Env makes an Env. A context with optional fields lets a literal drop one field with no error. Then, for example, a `jsmql.compile` parameter resolves inside `.map` and throws inside `.reduce`.
- A lambda body inherits every field, because it gets its Env from its parent Env. A transition changes one thing and copies the rest. `emit/inputs.ts` builds the `In` record of a lowering from the Env, and the lowering never sees the Env.
- The HR1 gate is one predicate, `injectedPlacement`, with a stated truth table (see docs/specs/aggregation-stages.md § `$`-string pass-through (HR1)).
- A chain closes in one order: the stages, then the cleanup, then the terminal stage. Nothing follows `$out`.
- `Env.enter` records a boundary that keeps the SAME `Chain` it came FROM, by reference. This is how `$$` reaches the root stream from inside a `$lookup` body.
- A `Boundary` is a sub-pipeline (the stage and the path to its body) or an `$elemMatch` body. An `$elemMatch` boundary names the parameter that is the element. Only that name has fields that are query paths inside the body. The outer document has no query path there, so a body that reads it has no native form.
- `Chain.isPipeline` is false for a bare expression and for a filter. A value that must place a stage, for example the stream count, then has nowhere to go. The compiler refuses it, and does not write it into a list that nothing drains.
- `Env.root` reserves every name that the program introduces anywhere. So a name that the compiler mints never shadows a parameter that the program binds deeper in.
- `Env.render` reads a located value at the current level. A variable reads as itself. A path on the current level reads as the path. A path on a shallower level reads as `$$<var>`, through the `let` of the boundary that starts the level below it.
- `Env.value` is `render`, except that the whole document comes from the chain of its own level (`Chain.wholeDocument`). A caller that builds on the path keeps `render`.
- `dropFields` runs after a stage that replaces the document. Every binding held in a field goes, and every proof about the document goes too.
- `clearedSince` runs after the compiler removed `__jsmql` ahead of the stages since `before`. The bindings that `before` held in fields go. The document keeps its proof, because only fields of the compiler left it.
- `backAt` keeps the bindings and proofs but goes back to the site of `parent`. A statement lowers its values under the Env of a child, and the next statement stands where this one stood.
- `enter` starts a sub-pipeline: a new chain, the boundary recorded, statement position. A body over another collection starts a document level of its own. A body over the same documents (a `$facet` branch) gets each scratch field that the outer chain left, so its cleanup owes those fields too.

`test/compiler-env.test.ts` holds the runtime half. The type-level half (no optional field, no literal, no spread) is in `test/types/registry-contracts.ts`.

## Consequences

Do not add an optional field to `Env` or `Site`. A new transition must answer a new Env and change one thing. A change to `Env` must keep the boundary's reference to the outer chain. Keep the name reservation in `Env.root`, or a minted name can shadow a user parameter.
