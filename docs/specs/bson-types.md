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

### What the peer dependency does and does not buy

It guarantees **one resolved copy per module condition**, which is what makes the BSON
version symbol always agree — the thing a serializer checks before it writes a value.
The hand-made class hard-coded that number, so an app on bson 6 hit `BSONVersionError`.

It does NOT guarantee `instanceof` everywhere, and nothing can. `bson` ships a dual
build: its exports map sends `import` to `lib/bson.node.mjs` and `require` to
`lib/bson.cjs`, so an ESM importer and a CJS importer hold two different class objects.
MEASURED, with jsmql absent from the test entirely:

```
ESM bson.ObjectId === CJS bson.ObjectId : false
CJS bson.ObjectId === mongodb.ObjectId  : true      (mongodb is CJS)
version symbol both sides               : 7 7
mongodb serialises an ESM-built ObjectId: OK
```

So a CJS consumer — which is what `mongodb` and `mongoose` are — gets exact class
identity with jsmql's CJS build. An ESM consumer reaching the driver's classes through
CJS interop does not, and never did, with or without jsmql. The value still serializes,
because the version symbol is what the serializer reads.

This is the concrete reason recognition duck-types: a valid value can arrive wearing a
prototype jsmql has never seen, through no fault of anyone's dependency graph.

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

## The nine the source can spell

| spelling | mongosh name | no argument | a constant | a runtime value |
|---|---|---|---|---|
| `ObjectId` | — | `$createObjectId` | live value | `$toObjectId` |
| `Date` | `ISODate` | `$$NOW` | live value | `$toDate` |
| `Decimal128` | `NumberDecimal` | refused | live value | `$toDecimal` |
| `Long` | `NumberLong` | refused | live value | `$toLong` |
| `Int32` | `NumberInt` | refused | live value | `$toInt` |
| `Double` | — | refused | live value | `$toDouble` |
| `UUID` | — | refused | live value | `$toUUID` |
| `MinKey` | — | live value | refused | refused |
| `MaxKey` | — | live value | refused | refused |

`X(…)` and `new X(…)` are both accepted (`newKeyword: "optional"` on every row), and
`jsmql.stringify` writes `new X(…)` for either. JavaScript's own bare `Date()` returns
a STRING; jsmql keeps the syntax and not that meaning, so one rule covers all nine.

The rows come from two factories in `src/registry/names.ts` — `bsonValue` and
`bsonSentinel` — so a tenth type is one call, and `constructorGlobals()` in
`src/compiler/rows.ts` feeds the ambient declarations without a generator edit.

## Constant, and what the fold may do with it

The FOLD builds every constant it can (`bsonConstant` in `src/bson.ts`, reached from
`src/compiler/passes/fold-methods.ts`), so a row's `constant` cell is reached ONLY by a
constant the type cannot hold — which is why that cell is a refusal naming the type
that fits.

`bson` does not refuse what it cannot hold. MEASURED against 7.2.0:

| written | `bson` answers | jsmql |
|---|---|---|
| `new Int32(3.7)` | `3` | refuses |
| `new Int32(5000000000)` | `705032704` | refuses |
| `Long.fromString("1.5")` | `1` | refuses |
| `Long.fromString("99999999999999999999")` | `7766279631452241919` | refuses |
| `new Double("x")` | `NaN` | refuses |

A JavaScript number past 2^53 has already lost the integer it was written as, so it is
refused too — the same line the fold holds for `(2 ** 60) + 1`.

Once built, a BSON value is a VALUE and nothing else:

- **Its kind is `number`** for the four numerics (`BSON_KIND` in
  `src/registry/vocabulary.ts`), because MongoDB's own `$type: "number"` alias is
  int + long + double + decimal. That is what keeps a comparison on the query road and
  a method off the per-document `$isArray` wrapper.
- **The fold never computes with it.** `bson.Decimal128`'s whole prototype is
  `toString` / `toJSON` / `toExtendedJSON` — there is no decimal arithmetic to fold
  with, and the server's answer is the exact one (MEASURED: `$add: ["$p", Decimal128("0.2")]`
  is `0.3` where a double is `0.30000000000000004`). `Long` and `Int32` would need
  MongoDB's promotion matrix reimplemented, and a wrong square is a wrong number in a
  report.
- **One exact read folds**: `toString()`, which cannot lose anything.

## A BigInt literal is a `Long`

`5n` is an int64 in MQL, so `src/compiler/emit/lower.ts` builds the value instead of
emitting `{ $toLong: "5" }`. Three things follow. The server parses no string per
document. The comparison stays on the query road, so `$.xs === 1n` matches an ELEMENT
of `xs` where the `$expr` form compared the whole array. And a BigInt past 64 bits is
refused at its source position, where it used to compile and die on the server —
MEASURED: `$toLong: "12345678901234567890123"` is "Failed to parse number … in
$convert".

`longsWithin` converts at any depth, because a settled constant can hold BigInts
inside an array or an object. Negation folds (`-5n`), since a BigInt negates exactly;
no other BigInt arithmetic folds.

An interpolated BigInt takes the same path and the same refusal.

## The sentinels

`MinKey` / `MaxKey` compare against every type and compute with none. MEASURED:
`$add: [MinKey, 1]` is "only supports numeric or date types". There is no MQL
expression that produces one either — `{ $minKey: 1 }` is "Unrecognized expression" —
so the value can only be the live one the fold builds, and their rows say `inCode`.

jsmql does not refuse `MinKey() + 1` at compile time, because it refuses none of its
siblings either: `true + 1`, `[1,2] + 1` and `0x507f… + 1` all emit `$add` today. A
general operand gate over every kind is its own change; a MinKey-only one would be an
inconsistency, not a fix.

## Running against both majors

The peer range is `^6.10.0 || ^7.0.0`, and a range jsmql never runs against is a claim
with nothing behind it. `test/bson-majors.test.ts` is the second lane: `bson6` is an
npm alias for the 6.x line installed beside the 7.x one, so both are in the tree at
once and every constructor is exercised through each.

It covers the two things that can vary — the class BEHAVIOUR jsmql's refusals are built
on (which throw, which silently wrap), and a value from the OTHER copy flowing through
the compiler, which is what `instanceof || tag` exists for. The rest of the suite runs
once, because the compiler is bson-agnostic: it builds nine values and reads a
`_bsontype` string.

That lane also holds the proof of the peer decision. A bson 7 serializer REFUSES a
bson 6 value outright (`BSONVersionError`, from the `@@mdb.bson.version` registry
symbol) — so a nested second copy would not merely fail an `instanceof`; the query
would never reach the server.

## The plausibility rule

`src/compiler/objectid-guard.ts` refuses an ObjectId whose embedded timestamp predates
MongoDB itself. It is jsmql's own rule about a source typo, not a bson rule, and it
applies to both spellings the source has (`0x…` and `ObjectId("…")`).
