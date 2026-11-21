# 0102. A field name that matches a prototype member stays ordinary data

Status: Accepted
Applies to: `test/security.test.ts`

## Context

MongoDB reserves no field names, so `__proto__` is ordinary data. In JavaScript, `out[name] = value` sends `__proto__` to the prototype slot and creates no own property. A plain object also reads back a method for `constructor`, `toString` and `valueOf`, and `name in out` answers true for each of them. Each of the four names fails in a different way.

## Decision

`test/security.test.ts` asserts each hostile name on every write road and on every folding road that builds an object. The compiler writes a key through `setKey` in `src/registry/mql.ts`, which uses `Object.defineProperty` for `__proto__`. A duplicate guard must not use `key in branches`, because that answers true for every member of `Object.prototype`. An example is the guard over `$facet` branch names. A fold that reads its accumulator back must not read from a plain object. A plain object answers a function for `constructor`, a value that the fold never stored. Use a `Map` or a `Set` for these.

## Consequences

A new write road or folding road must keep the names, and the suite must cover it. Do not add a duplicate check or an accumulator that reads a plain object by a developer-supplied key.
