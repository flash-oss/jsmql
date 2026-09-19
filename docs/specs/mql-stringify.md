# `jsmql.stringify` — MQL as the JavaScript that rebuilds it

`jsmql.stringify(value, options?)` turns a compiled MQL document into text. The
text is **JavaScript source**, not JSON. Each value is written as the
expression that MAKES it. So the output pastes into a driver script or into
mongosh and keeps the source's own meaning.

Source: [src/stringify.ts](../../src/stringify.ts). One printer serves every
surface that shows MQL to a person: the CLI, the landing page, the playground,
the expectation rewriters, and the compiler's own error messages. None of them
carries its own copy.

```js
jsmql.stringify(jsmql('$.status === "active" && $._id === 0x507f1f77bcf86cd799439011'));
// → { status: "active", _id: new ObjectId("507f1f77bcf86cd799439011") }
```

## Why not `JSON.stringify`

JSON cannot spell what MQL holds. What it writes instead is wrong, not just
lossy: the document still runs, but it matches nothing. This is the worst
failure a query can have.

| The value | `JSON.stringify` writes | The server then |
| --- | --- | --- |
| `new Date("2026-01-01")` | `"2026-01-01T00:00:00.000Z"` | compares a string to a date |
| an ObjectId | `"507f1f77bcf86cd799439011"` | compares a string to an `_id` |
| `/^a/i` | `{}` | matches every document |
| a `Decimal128`, a `Long`, a `Binary` | its internal byte fields | reads a document, not a number |
| a key named `__proto__` | `"__proto__": 1` | never gets the field: pasting the text back sets the prototype and creates no own property |

## One spelling, two runtimes

The printer writes each BSON class as `new X(…)`, the form the Node driver
needs. MEASURED in mongosh 2.9.2: the same text runs there and gives the same
value, because mongosh exposes the driver's BSON classes as globals on top of
its own `ISODate` / `NumberDecimal` helpers. So there is ONE spelling per type,
not one per runtime. The bare-call forms (`ObjectId("…")`, `MinKey()`) and the
helper names (`ISODate`, `NumberLong`, `BinData`) run only in mongosh, so the
printer writes neither.

Pasting the text into a driver script needs the classes in scope. mongosh has
them already:

```js
const { ObjectId, Decimal128, Long, Int32, Double, Binary, UUID, Timestamp,
        MinKey, MaxKey, Code, DBRef, BSONSymbol, BSONRegExp } = require("mongodb");
```

The `_bsontype` tag keys the classes. Every class sets this tag, and the
compiler itself reads it. A duck check does not work here: a driver `UUID`
reports `_bsontype: "Binary"` AND carries `toHexString`. So a check for that
method calls a UUID an ObjectId, and prints text that throws in both runtimes.

The printer picks a few spellings by hand, rather than by a fixed rule:

- **`Long.fromString("…")`**, not `new Long(low, high)`. A reader can check the
  string value, but not the two-word constructor.
- **`new UUID("…")`** for a Binary of subtype 4, which IS a UUID and reads as
  one. Every other Binary is `Binary.createFromBase64(base64, subtype)`.
  MEASURED: a Binary filled one byte at a time over-allocates its buffer (260
  bytes held for 5 written). Only its own `toString` knows where the value
  ends, so the bytes come from there, never from the buffer's length.
- **`new Uint8Array([…])`** for raw bytes. A Uint8Array — a Node `Buffer` is one
  — is a value the compiler passes through as-is. MEASURED: both runtimes store
  it as BSON Binary subtype 0, and match that document again with the same
  text. The printer writes it as itself, not as a `Binary` call, so what comes
  back is the value the document holds, down to its JavaScript class.
- **`new Double(42)`**, never `42`. A whole-number Double would come back as an
  int. MEASURED on the server: the field's `$type` is `double` after a round
  trip through either runtime.
- **`-0`**, never `0`. `String(-0)` writes `0`, but the two are different BSON
  doubles.

## A tag without the data behind it

Every class reads its data defensively, and the printer falls back to the
plain object when the data is absent. A plain object may wear the tag — the
compiler passes `{ _bsontype: "ObjectId", id: "xyz" }` through as the value it
is. If the printer called the class's methods on this object, it would throw,
and take the whole document's output down with it. The legacy `_bsontype:
"ObjectID"` (uppercase D, bson 1.x) is read as an ObjectId, because the
compiler reads it as one.

## Keys

The printer writes a key bare (`age`) when it is a plain JavaScript identifier,
and quotes every other key (`"$gt"`, `"__jsmql.length"`). `__proto__` is the
one name a quoted key cannot carry: in an object literal, `{"__proto__": 1}`
sets the prototype and creates no own property. So the field would vanish the
moment the text was pasted back — MEASURED in mongosh and in Node alike. The
printer writes it as the computed key `["__proto__"]`, the only spelling that
survives.

## Layout

The printer writes a document on ONE line while it fits inside `width`, and
breaks it to one entry per line once it does not fit. MQL nests deeply and
narrowly, so a brace on each line would bury the shape the text should show:

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

`width: Infinity` puts the whole document on one line, whatever the indent
says. The CLI's `-c`/`--compact` flag and the playground's Prettify toggle set
this value. An `indent` of `0` (or `""`) has the same effect, because a broken
line would then look the same as an unbroken one.

## What it refuses

Three values have no MQL form. Printing something in their place would hide
the fault, not report it. Each one raises a `TypeError`:

- an **Invalid Date** — the driver stores it as epoch 0, so any spelling would
  print a value the document does not hold;
- **`undefined`** — the language declares it an existence TEST, never a value.
  Every entry point refuses it, so it cannot reach a compiled document. If it
  reaches the printer, a guard was missed;
- a **circular structure**, which no text can rebuild.

## Who uses it

| Surface | How |
| --- | --- |
| the CLI | `stringify(result, { indent, width })` — [cli.md](cli.md) |
| `index.html`, `playground.html` | `jsmql.stringify` from the same bundle they compile with — [site.md](site.md) |
| `scripts/regen-expectations.mjs`, `scripts/convert-expectations.mjs` | through `spell()` in `scripts/expectations.mjs`, so a suite reads as the CLI prints |
| `scripts/check-doc-claims.mjs` | to compare a prose claim with the compiler's answer |
| `src/compiler/emit/check.ts` | to name a value inside a refusal, so a Date in a message reads as a date |
| `test/probe` | to print what the server returned — see [test/CLAUDE.md](../../test/CLAUDE.md) |

One place deliberately does NOT use it: the equality key in
`src/compiler/emit/filter.ts`. That function answers "are these two values the
same", not "how does a person read this value". So it sorts keys and ignores
layout.
