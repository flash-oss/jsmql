# 0144. Checks on the escape hatch

Status: Rejected
Applies to: `$op(…)` calls, `$stage(…)` calls, a raw `{ $op: … }` document, HR1, HR2 and HR3 in `docs/LANG_RULES.md`

## Context

The idea: let the compiler check the MQL that a developer writes through an escape hatch. An escape hatch is a `$op(…)` call, a `$stage(…)` call, or a raw `{ $op: … }` document.

## Decision

The developer decided that the compiler does not check the MQL that you write yourself. HR3 does not apply to the escape hatches of HR1 and HR2. There are three reasons:

- A check on raw MQL can refuse MQL that the server accepts, and that breaks HR1. For example, `{ $setUnion: "$a" }` is valid: the server reads one operand.
- A check copies the validation of the server. The copy goes stale when a new server version adds a key or a value.
- The server checks this MQL before it reads a document, and its message names the problem.

## Consequences

- `$eq(1)` compiles to `{ $eq: 1 }`, and the server gives the error.
- Two checks stay, because the developer decided so. The first is the place of each stage in the pipeline, and that includes your own stages. The second is the list of query operators that an aggregation `$match` refuses, for example `$near`.
- The compiler also refuses a spread in `$op(…)`, because no MQL exists for it. See [ADR 0143](0143-spread-in-op-escape-hatch.md).
- Reconsider only if a check can refuse nothing that the server accepts, and needs no update for a new server version.
