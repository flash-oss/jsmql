# 0191. The union road refuses a correlated read and checks no server version

Status: Rejected
Applies to: `$$.push(…)` → `$unionWith`, `docs/specs/union-stage.md`

## Context

The developer considered two additions to the union road. The first is a custom let-substitution. `$lookup.let` does not apply to `$unionWith`. JSMQL could give the same effect with a `$set` stage before the push, and a `$match` against the captured value inside the sub-pipeline. The second is a compile-time check that the deployment runs MongoDB 6.0 or later, for a `$unionWith` that reads only `$documents`.

## Decision

JSMQL adds neither. A correlated read inside a push gets an explicit refusal, and that refusal is the documented contract. The server error for an old deployment is precise enough, so a version check adds nothing.

## Consequences

To reconsider the let-substitution, show that the developer can predict the emitted stages, as [ADR 0153](0153-no-silent-output-drift.md) requires. A version check needs a way to know the server version at compile time, and JSMQL has none.
