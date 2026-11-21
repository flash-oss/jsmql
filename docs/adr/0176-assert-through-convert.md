# 0176. `assert` fails through an unknown type name in `$convert`

Status: Accepted
Applies to: the `assert` row in `src/registry/names.ts`, docs/specs/assert.md

## Context

MongoDB has no error, assert or throw operator in aggregation. The project confirmed this against the v8.x operator reference and the JIRA issue SERVER-27190. The only mechanism with a custom message is `$function`, a JavaScript `throw` on the server. MongoDB 8.0 deprecates server-side JavaScript. The Stable API (`apiStrict: true`) excludes it, and Atlas Flex and the free tiers do not offer it.

## Decision

- JSMQL does not use `$function`. It feeds an unknown type name to `$convert`, which is a portable failure at run time and is not deprecated. The server's message contains the type name, so the type name carries the custom message.
- The gate lives only in the runtime `to` value of `$convert`, computed per document. MongoDB does not document or guarantee that `$cond` or `$and` skips a branch that it does not take. The `$and`/`$or` reference warns that a later operand can cause an error even when the first one is false. A failing expression directly in a `$cond` branch can also fold at planning time when its message is constant, and then fire on every document. A route through `$convert.to` prevents both risks.

## Consequences

The failing branch must never be a real type name, so it carries the `jsmql assertion failed` prefix.
