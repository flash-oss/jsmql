# 0150. A wrapper for nested-operator `$`-strings ("Model A")

Status: Rejected
Applies to: `$`-string arguments of a `$op(…)` call, HR1 in `docs/LANG_RULES.md`

## Context

When a stage value is itself an operator call, for example `$project({ t: $concat("$a", "$b") })`, the `$`-string arguments pass through verbatim: `{ $concat: ["$a", "$b"] }`. They do not get a `$literal` wrap. The idea, "Model A": an operator call wraps its `$`-string arguments, so only a direct stage-spec value passes through.

## Decision

JSMQL does not do this. Model A makes the same `$op("$x")` call mean a different thing at each nesting depth. It also breaks the property that raw MQL pastes in and round-trips. HR1 settles this for every context: a source-typed `$`-string passes through in a pipeline, a stage and `jsmql.expr` alike. See [docs/LANG_RULES.md](../LANG_RULES.md) (HR1).

## Consequences

- No wrap depends on the nesting depth or on the entry point.
- Only a runtime-injected value gets a wrap.
- Reconsider only if HR1 changes.
