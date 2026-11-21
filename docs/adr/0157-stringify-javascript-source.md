# 0157. jsmql.stringify writes JavaScript, with one spelling for each BSON type

Status: Accepted
Applies to: `src/stringify.ts`

## Context

A developer reads a compiled document as text, and pastes the text into a driver script or into mongosh. The document holds values that JSON cannot spell. What `JSON.stringify` writes for them is wrong, not only lossy: the document still runs, but it matches nothing. This is the worst failure that a query can have.

| The value | `JSON.stringify` writes | The server then |
| --- | --- | --- |
| `new Date("2026-01-01")` | `"2026-01-01T00:00:00.000Z"` | compares a string to a date |
| an ObjectId | `"507f1f77bcf86cd799439011"` | compares a string to an `_id` |
| `/^a/i` | `{}` | matches every document |
| a `Decimal128`, a `Long`, a `Binary` | its internal byte fields | reads a document, not a number |
| a key named `__proto__` | `"__proto__": 1` | never gets the field: a paste of the text sets the prototype and creates no own property |

mongosh has its own helpers (`ISODate`, `NumberDecimal`) and a bare-call form (`ObjectId("…")`). The Node driver needs `new X(…)`.

## Decision

- The printer writes JavaScript source. Each value is the expression that makes it.
- The printer writes each BSON class as `new X(…)`. MEASURED in mongosh 2.9.2: the same text runs there and gives the same value, because mongosh exposes the BSON classes of the driver as globals. So each type has one spelling, not one per runtime. The printer writes no bare-call form and no mongosh helper name, because these run only in mongosh.
- The printer selects the class by the `_bsontype` tag, which every class sets and the compiler reads. A duck check does not work. A driver `UUID` reports `_bsontype: "Binary"` and has `toHexString`. A check for that method reads a UUID as an ObjectId, and the printed text then throws in both runtimes.

## Consequences

The text pastes into both runtimes. A driver script must have the BSON classes in scope. A new BSON type gets one `new X(…)` spelling, keyed by its tag.
