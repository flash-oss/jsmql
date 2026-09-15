# BSON types

How jsmql builds, recognises and prints a live BSON value.

Canonical for: the `bson` dependency contract, the recognition rule, and where each
phase touches a BSON value. User-facing behaviour is in
[docs/LANGUAGE.md](../LANGUAGE.md); the printer is
[docs/specs/mql-stringify.md](mql-stringify.md).

## Why a live value, and not Extended JSON

jsmql emits a real BSON instance wherever the source spells one. The Extended JSON
envelope (`{ "$oid": "…" }`) is a client-side serialization shape. The driver does not
parse it for queries — sent verbatim it reaches the server, which refuses it as an
unknown operator. Measured against mongod.

## The dependency contract

`bson` is a **peer** dependency, range `^6.10.0 || ^7.0.0`.

A peer dependency resolves to ONE copy: the application's own. That is the whole point.
A value jsmql emits is then the same class the driver builds, so it passes the caller's
`instanceof` checks and carries the BSON major version its serializer expects. A plain
`dependencies` entry would let npm nest a second copy beside the application's, and a
value from the wrong copy fails both checks — which is the defect this contract removes.

Two build rules follow, and breaking either reintroduces the defect:

| artifact | rule | why |
|---|---|---|
| `dist/cjs/*.cjs` | `external: ["bson"]` | inlined, the package ships its own copy |
| `dist/jsmql.js` (site) | bundled | a browser cannot resolve a bare specifier, and the page has no driver to share with |

## Construction vs recognition

`src/bson.ts` is the one module that names `bson`. It draws the line:

- **Construction** uses the real classes. `new ObjectId(hex)`, `Decimal128.fromString(s)`.
- **Recognition** does not trust the prototype alone:

```ts
v instanceof Cls || bsonTagOf(v) === tag
```

The prototype answers for a value from this copy. The `_bsontype` tag answers for a value
from any copy — a monorepo that pins the other major, or a server response, which
MongoDB's own shell documentation warns is assigned a different base class than a
user-supplied value. Either match is a yes, so jsmql accepts a valid value from wherever
it came.

`UUID` is the one type the tag cannot answer alone: it reports `_bsontype: "Binary"`. From
another copy it is known only by `sub_type === 4` — `isUUID` holds both readings.

Every read of a recognised value goes through a **defensive** reader (`objectIdHex`),
because a plain object may wear the tag: the compiler passes an injected
`{ _bsontype: "ObjectId", id: "xyz" }` through as the value it is, and calling the class's
method on it throws. The reader answers null instead, and the caller treats the value as
what it is.

## Where a BSON value is touched

| file | what it does |
|---|---|
| `src/bson.ts` | the classes, `bsonTagOf`, `isBsonType`, `isUUID`, `isObjectId`, `objectIdHex` |
| `src/compiler/passes/literal.ts` | a value ⇄ the AST literal that spells it |
| `src/compiler/passes/fold-methods.ts` | the exact reads a fold may run on a constant |
| `src/compiler/emit/types.ts` | the kind a value proves |
| `src/compiler/emit/filter.ts` | whether the query language compares it as written |
| `src/compiler/emit/lower.ts` | a literal to the value the driver sends |
| `src/stringify.ts` | the value as the JavaScript that rebuilds it — tag-keyed, never `instanceof` |

## The plausibility rule

`src/compiler/objectid-guard.ts` refuses an ObjectId whose embedded timestamp predates
MongoDB itself. It is jsmql's own rule about a source typo, not a bson rule, and it
applies to both spellings the source has (`0x…` and `ObjectId("…")`).
