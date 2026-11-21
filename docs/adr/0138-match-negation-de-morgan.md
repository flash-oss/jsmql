# 0138. Negation distributed by De Morgan in `$match`

Status: Rejected
Applies to: the filter target in `src/compiler/emit/`, `docs/specs/emit-pass.md` § The filter target

## Context

The idea: lower `!expr` in a `$match` or a Filter by De Morgan's laws. The negation then goes into each clause, and the query can use an index.

## Decision

JSMQL does not distribute the negation. Negation has subtle null and missing-field interactions in MongoDB. With De Morgan, the shape of the data alone would decide whether the query uses an index. That silent change is exactly the surprise that JSMQL exists to prevent. This is the "no silent output drift" principle of [ADR 0153](0153-no-silent-output-drift.md).

## Consequences

- `!expr` lowers to the query language's own negation, `$nor`. See [docs/specs/emit-pass.md](../specs/emit-pass.md) § The filter target.
- A developer who wants another form writes `$op($not, …)`, the explicit escape.
- Reconsider only if a distributed negation gives the same documents as `$nor` for every null and missing-field case.
