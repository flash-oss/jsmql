# 0162. Recognition reads what a value is, not the class or the realm that made it

Status: Accepted
Applies to: `src/registry/vocabulary.ts`, `src/bson.ts`, `src/stringify.ts`

## Context

A valid value can arrive with a prototype that JSMQL never saw:

- A BSON value from another copy of `bson`: a monorepo that pins the other major, an ESM consumer of a CJS driver, or a server response. The documentation of MongoDB's shell says that a server response gets a base class that differs from a value that the user supplies.
- A Date, a RegExp, a Uint8Array or a plain object from another realm: a `vm` context, the sandbox of a test runner, a worker. Each realm has its own `Date`, `RegExp`, `Uint8Array` and `Object.prototype`.

A test against the class of this copy or this realm fails such a value. The value then takes the wrong road. A Date parameter that fails the test compares on the `$expr` road and loses the index. A `$`-keyed object that fails the plain-object test skips the `$literal` gate.

## Decision

- A BSON value matches when `v instanceof Cls || bsonTagOf(v) === tag`. The prototype answers for a value from this copy. The `_bsontype` tag answers for a value from any copy.
- No module in `src/` tests a value with `instanceof` or against `Object.prototype`. Each recogniser reads the internal slot through a reader of the engine, which works for a value from any realm.

## Consequences

JSMQL accepts a valid value from any source. A plain object can carry a tag. So each read of a recognised value goes through a defensive reader that returns null when the data is absent. `test/cross-realm.test.ts` scans `src/` for the banned tests.
