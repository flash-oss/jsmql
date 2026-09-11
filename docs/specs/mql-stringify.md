# `jsmql.stringify` — MQL as the JavaScript that rebuilds it

`jsmql.stringify(value, options?)` turns a compiled MQL document into text. The
text is **JavaScript source**, not JSON: every value is written as the
expression that MAKES it, so the output pastes into a driver script or into
mongosh and means what the source meant.

Source: [src/stringify.ts](../../src/stringify.ts). One printer serves every
surface that shows MQL to a person — the CLI, the landing page, the playground,
the expectation rewriters, the compiler's own error messages. None of them
carries a copy.

```js
jsmql.stringify(jsmql('$.status === "active" && $._id === 0x507f1f77bcf86cd799439011'));
// → { status: "active", _id: new ObjectId("507f1f77bcf86cd799439011") }
```

## Why not `JSON.stringify`

JSON cannot spell what MQL holds, and what it writes instead is wrong rather
than merely lossy — the document still runs, and matches nothing, which is the
worst failure a query has.

| The value | `JSON.stringify` writes | The server then |
| --- | --- | --- |
| `new Date("2026-01-01")` | `"2026-01-01T00:00:00.000Z"` | compares a string to a date |
| an ObjectId | `"507f1f77bcf86cd799439011"` | compares a string to an `_id` |
| `/^a/i` | `{}` | matches every document |
| a `Decimal128`, a `Long`, a `Binary` | its internal byte fields | reads a document, not a number |
| a key named `__proto__` | `"__proto__": 1` | never gets the field: pasting the text back sets the prototype and creates no own property |

## One spelling, two runtimes

Each BSON class is written as `new X(…)`, the form the Node driver requires.
MEASURED in mongosh 2.9.2: the same text runs there and yields the identical
value, because mongosh exposes the driver's BSON classes as globals on top of
its own `ISODate` / `NumberDecimal` helpers. There is therefore ONE spelling per
type rather than one per runtime. The bare-call forms (`ObjectId("…")`,
`MinKey()`) and the helper names (`ISODate`, `NumberLong`, `BinData`) run only
in mongosh, so neither is written.

Pasting into a driver script needs the classes in scope; mongosh has them
already:

```js
const { ObjectId, Decimal128, Long, Int32, Double, Binary, UUID, Timestamp,
        MinKey, MaxKey, Code, DBRef, BSONSymbol, BSONRegExp } = require("mongodb");
```

The classes are keyed by `_bsontype`, the tag every one of them sets and the tag
the compiler itself reads. A duck check does not work here: a driver `UUID`
reports `_bsontype: "Binary"` AND carries `toHexString`, so a check for that
method calls a UUID an ObjectId and prints text that throws in both runtimes.

A few spellings are chosen rather than mechanical:

- **`Long.fromString("…")`**, not `new Long(low, high)` — the string is the
  value a reader can check, and the two-word constructor is not.
- **`new UUID("…")`** for a Binary of subtype 4, which IS a UUID and reads as
  one. Every other Binary is `Binary.createFromBase64(base64, subtype)`.
  MEASURED: a Binary filled a byte at a time over-allocates its buffer (260
  bytes held for 5 written), and only its own `toString` knows where the value
  ends — so the bytes come from there, never from the buffer's length.
- **`new Uint8Array([…])`** for raw bytes. A Uint8Array — a Node `Buffer` is one
  — is a value the compiler passes through, and MEASURED both runtimes store it
  as BSON Binary subtype 0 and match that document again with the same text. It
  is written as itself rather than translated into a `Binary` call, so what
  comes back is the value the document holds, down to its JavaScript class.
- **`new Double(42)`**, never `42` — a whole-number Double would come back as an
  int. MEASURED on the server: the field's `$type` is `double` after a round
  trip through either runtime.
- **`-0`**, never `0` — `String(-0)` writes `0`, and the two are different BSON
  doubles.

## A tag without the data behind it

Every class reads its data defensively and the printer falls back to the plain
object when it is absent. A plain object may wear the tag — the compiler passes
`{ _bsontype: "ObjectId", id: "xyz" }` through as the value it is — and a
printer that called the class's methods on it threw, taking the whole document's
output down with it. The legacy `_bsontype: "ObjectID"` (uppercase D, bson 1.x)
is read as an ObjectId, because the compiler reads it as one.

## Keys

A key that is a plain JavaScript identifier is written bare (`age`), and every
other key is quoted (`"$gt"`, `"__jsmql.length"`). `__proto__` is the one name a
quoted key cannot carry: in an object literal `{"__proto__": 1}` sets the
prototype and creates no own property, so the field would vanish the moment the
text was pasted back — MEASURED in mongosh and in Node alike. It is written as
the computed key `["__proto__"]`, the only spelling that survives.

## Layout

A document is written on ONE line while it fits inside `width`, and broken one
entry per line once it does not. MQL nests deeply and narrowly, so a brace per
line buries the shape the text is meant to show:

```js
[
  { $match: { age: { $gte: 18 }, region: "AU" } },
  { $group: { _id: "$shopId", total: { $sum: "$amount" } } },
  { $sort: { total: -1 } }
]
```

| Option | Default | Meaning |
| --- | --- | --- |
| `indent` | `2` | spaces per level, or the literal string to indent with (`"\t"`) |
| `width` | `80` | break a document across lines once its one-line form passes this |

`width: Infinity` puts the whole document on one line whatever the indent says —
that is what the CLI's `-c`/`--compact` and the playground's Prettify toggle
set. An `indent` of `0` (or `""`) does the same, since a broken line would then
be indistinguishable from an unbroken one.

## What it refuses

Three values have no MQL form, and printing something in their place would hide
the fault rather than report it. Each raises a `TypeError`:

- an **Invalid Date** — the driver stores it as epoch 0, so any spelling would
  print a value the document does not hold;
- **`undefined`** — the language declares it an existence TEST, never a value,
  so it is refused at every entry point and cannot reach a compiled document;
  reaching the printer means a guard was missed;
- a **circular structure**, which no text rebuilds.

## Who uses it

| Surface | How |
| --- | --- |
| the CLI | `stringify(result, { indent, width })` — [cli.md](cli.md) |
| `index.html`, `playground.html` | `jsmql.stringify` from the same bundle they compile with — [site.md](site.md) |
| `scripts/regen-expectations.mjs`, `scripts/convert-expectations.mjs` | through `spell()` in `scripts/expectations.mjs`, so a suite reads as the CLI prints |
| `scripts/check-doc-claims.mjs` | to compare a prose claim with the compiler's answer |
| `src/compiler/emit/check.ts` | to name a value inside a refusal, so a Date in a message reads as a date |
| `test/probe` | to print what the server returned — see [test/CLAUDE.md](../../test/CLAUDE.md) |

The one place that deliberately does NOT use it is the equality key in
`src/compiler/emit/filter.ts`: that function answers "are these two values the
same", not "how does a person read this value", and it sorts keys and ignores
layout to do so.
