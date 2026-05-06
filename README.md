# mjsql

Write MongoDB aggregation expressions in JavaScript. mjsql is a JS-subset language that compiles to MQL JSON — like SQL but for MongoDB, using syntax you already know.

```js
const { mjsql } = require("mjsql");

mjsql("$.age > 18 && $.status == 'active'")
// → { $and: [{ $gt: ["$age", 18] }, { $eq: ["$status", "active"] }] }

mjsql("$.name.trim().toLowerCase()")
// → { $toLower: { $trim: { input: "$name" } } }

mjsql("$.items.map(item => item.price * item.qty).reduce((acc, x) => acc + x, 0)")
// → { $reduce: { input: { $map: { input: "$items", as: "item", in: { $multiply: ["$$item.price", "$$item.qty"] } } }, initialValue: 0, in: { $add: ["$$value", "$$this"] } } }
```

## Install

```sh
npm install mjsql
```

## Quick start

```js
const { mjsql, validate, mql } = require("mjsql");

// JS operators and method chains
mjsql("$.price >= 100 && $.stock > 0")
// → { $and: [{ $gte: ["$price", 100] }, { $gt: ["$stock", 0] }] }

// Use in a $match stage
db.products.aggregate([{ $match: { $expr: mjsql("$.price >= 100") } }]);

// Embed JS values with the template tag
const minAge = 21;
const filter = mql`$.age >= ${minAge} && $.active == true`;
// → { $and: [{ $gte: ["$age", 21] }, { $eq: ["$active", true] }] }

// Check syntax without throwing
validate("$.age > 18");
// → { valid: true, errors: [] }
```

## Syntax

mjsql accepts a JS-like expression syntax that covers the full range of JavaScript operators and methods:

```js
// Arithmetic, comparison, logical
$.price * 1.1 > $.msrp
$.age >= 18 && $.status == 'active'
$.nickname ?? $.firstName ?? "Anonymous"

// Template literals and optional chaining
`Hi, ${$.user?.firstName ?? "there"} — your order ${$.id} is ready`

// String methods
$.email.toLowerCase().trim()
$.title.split(" ").at(0)
$.file.name.endsWith(".pdf") || $.file.name.startsWith("draft-")
$.code.charAt(0).toUpperCase()

// Array methods with lambdas
$.orders.filter(o => o.total > 100).map(o => o.id)
$.scores.reduce((acc, x) => acc + x, 0)
$.docs.flatMap(d => d.tags).join(", ")
$.posts.map(p => p.tags).flat()
[".pdf", ".docx"].includes($.file.ext)

// Math, typeof, type casts, constants
Math.min(...$.scores)              // spread args
Math.hypot($.dx, $.dy)             // Euclidean distance
Math.log10($.amplitude) * 20       // signal in dB
Math.PI * $.radius ** 2            // Math.PI / Math.E constants
typeof $.field == "string" ? $.field.trim() : String($.field)
Array.isArray($.tags) && $.tags.length > 0

// Dates
Date.now() - $.createdAt.getTime()
$.event.ts.toISOString()
$dateDiff({ startDate: $.createdAt, endDate: new Date(), unit: "day" })

// Numeric separators and computed object keys
$.price <= 1_000_000
{ [$.dynamicKey]: $.value, count: 1 }
Object.fromEntries($.metrics.map(m => [m.name, m.value]))
```

### Fallback: `$op()` utility form

For MongoDB operators that have no JavaScript equivalent, use `$opName()`:

```js
$zip([$.weeks, $.amounts])         // { $zip: { inputs: ["$weeks", "$amounts"] } }
$sampleRate(0.1)                   // { $sampleRate: 0.1 }
$stdDevPop($.measurements)         // { $stdDevPop: "$measurements" }
$dateTrunc({ date: $.createdAt, unit: "week" })
                                   // { $dateTrunc: { date: "$createdAt", unit: "week" } }
$round($.price, 2)                 // { $round: ["$price", 2] }   (Math.round has no precision arg)
```

Every MongoDB aggregation operator is available this way. Unknown operators pass through automatically, making mjsql forward-compatible with new MongoDB releases.

Field references use `$.` notation:

```js
$.age              // "$age"
$.address.city     // "$address.city"
$.items.0.name     // "$items.0.name"
```

See **[docs/LANGUAGE.md](docs/LANGUAGE.md)** for the full language reference.

## Real-world examples

**[test/realistic.test.ts](test/realistic.test.ts)** contains end-to-end examples of realistic MongoDB aggregation expressions — tiered discounts, slug generation, date formatting, parameterised queries, and more. It is the best place to see what mjsql looks like in practice.

## API

### `mjsql(expression: string): object`

Parses and transpiles the expression. Throws a descriptive error on invalid input.

### `validate(expression: string): { valid: boolean, errors: ValidationError[] }`

Same as `mjsql()` but returns errors instead of throwing. Useful for linters and form validation.

### `` mql`...` `` (template tag)

Interpolate JavaScript values (numbers, strings, booleans, arrays) directly into expressions:

```js
const statuses = ["active", "pending"];
mql`$.status in ${statuses}`
// → { $in: ["$status", ["active", "pending"]] }
```

## License

MIT
