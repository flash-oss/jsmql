# 0095. A field name that matches a prototype member stays ordinary data

Status: Accepted
Applies to: `test/security.test.ts`

## Context

MongoDB reserves no field names, so `__proto__`, `constructor`, `toString` and `valueOf` are ordinary data. In JavaScript, each of these names fails in a different way when code uses a plain object as a map. [ADR 0060](0060-registry-mql-builders.md) records the failures, and the rule for the compiler: `setKey` for a write, and a `Map` or a `Set` for a lookup.

## Decision

`test/security.test.ts` asserts each of these names on every write road, and on every folding road that builds an object. The suite covers each place where code can read a plain object by a developer-supplied key: a duplicate guard, for example the guard over `$facet` branch names, and a fold that reads its accumulator back.

## Consequences

A new write road or folding road must keep the names, and the suite must cover it.
