# 0022. How lower.ts locates and renders a read of a field

Status: Accepted
Applies to: `src/compiler/emit/lower.ts`

## Context

A JSMQL read can be a root path, a field of a callback parameter, a `let` carried in a field, or a variable. Each lands on one level of documents. The server also has rules for what a field path can hold.

## Decision

- `locate(node, env)` answers WHERE an access chain reads: a level of documents and a path on it, or a variable. `Env.render` then renders it for the level that reads it. `$.x` is the ROOT document at every depth (HR4). A parameter bound as a document is its own level's. A `let` carried in a field lives on the level that declares it.
- A field of the DOCUMENT is a root path, spelled as `$.x` spells it. `d.x` in `$$.map(d => d.x)` is `"$x"`, not `"$$ROOT.x"`.
- A path segment cannot start with `$`. `locate` returns null for a bracket name that starts with `$`, so the read goes through `$getField`.
- MEASURED: the server refuses a segment that starts with `$` in a field path. An example is the field `$gt` in `{ qty: { $gt: 5 } }`, read as `o.qty.$gt`. `reachable(path)` renders that segment as `$getField`, with the name in `$literal`. Every segment after it is a `$getField` too, because a path cannot continue from an expression.
- In `indexAccess`, a constant integer key on a proven string uses `$substrCP`. `$substrCP` answers `""` for null. So a string that may be missing takes a `$switch` that tests the `$type` first, and answers `$$REMOVE` otherwise.

## Consequences

- A new kind of binding must state its level, so that `locate` stays correct across `$lookup` levels.
- A change to path rendering must keep the `$getField` fallback for `$`-led segments.
