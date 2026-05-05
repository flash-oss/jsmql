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

// String methods
$.email.toLowerCase().trim()
$.title.split(" ").at(0)

// Array methods with lambdas
$.orders.filter(o => o.total > 100).map(o => o.id)
$.scores.reduce((acc, x) => acc + x, 0)

// Math, typeof, new Date, type casts
Math.floor($.rating)
typeof $.field == "string" ? $.field.trim() : String($.field)
$dateDiff({ startDate: $.createdAt, endDate: new Date(), unit: "day" })
```

### Fallback: `$op()` utility form

For MongoDB operators that have no JavaScript equivalent, use `$opName()`:

```js
$round($.price, 2)                 // { $round: ["$price", 2] }
$dateAdd($.date, "day", 7)         // { $dateAdd: { startDate: "$date", unit: "day", amount: 7 } }
$size($.items)                     // { $size: "$items" }
$cond($.active, "yes", "no")       // { $cond: ["$active", "yes", "no"] }
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
