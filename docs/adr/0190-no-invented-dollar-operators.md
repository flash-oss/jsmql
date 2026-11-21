# 0190. JSMQL never invents its own `$`-prefixed operator

Status: Accepted
Applies to: `src/registry/names.ts`, every `$`-named callable and stage

## Context

A convenience operator can look useful. An example is a `$drop(pred)` that lowers to `$match(!(pred))`. Such an operator would be a `$name` that MongoDB does not define.

## Decision

Every `$`-named callable that JSMQL accepts maps to a real MongoDB operator or a real pipeline stage. JSMQL does not add a convenience operator or a pseudo-stage of its own. Two reasons apply:

- An invented `$name` breaks the rule that every `$op` is a real MongoDB operator. It also breaks the property that raw MQL pastes into JSMQL and comes back unchanged.
- An invented `$name` gives a second spelling to a capability that already has one. The developer then has to ask which spelling the codebase uses. [ADR 0141](0141-one-spelling-per-capability.md) rejects that friction.

## Consequences

A new ergonomic feature goes into a JavaScript-style surface: a JS method (`.foo()`), or sugar that names its destination over a real stage ([ADR 0169](0169-destination-visible-prefixes.md)). A proposal for a new `$foo()` conflicts with this decision.
