# mjsql

Write MongoDB aggregation expressions in a readable, LISP-style syntax instead of deeply nested JSON.

```js
const { mjsql } = require("mjsql");

mjsql("$and($gte($.age, 18), $eq($toLower($.status), 'active'))");
// → { $and: [{ $gte: ["$age", 18] }, { $eq: [{ $toLower: "$status" }, "active"] }] }
```

## Install

```sh
npm install mjsql
```

## Quick start

```js
const { mjsql, validate, mql } = require("mjsql");

// Transpile a string expression to MQL JSON
const expr = mjsql("$gte($.price, 100)");
// → { $gte: ["$price", 100] }

// Use as a $match stage
db.products.aggregate([{ $match: { $expr: mjsql("$gte($.price, 100)") } }]);

// Embed JS values with the template tag
const minAge = 21;
const filter = mql`$and($gte($.age, ${minAge}), $eq($.active, true))`;

// Check syntax without throwing
const result = validate("$eq($.age, 18)");
// → { valid: true, errors: [] }
```

## Syntax

Every MongoDB aggregation operator is available as a function call:

```
$operatorName(arg1, arg2, ...)
```

Operators that take an object in MQL accept both styles:

```js
// Positional (args mapped to named keys in order)
$trim($.name, " ")
// → { $trim: { input: "$name", chars: " " } }

// Object-style (pass the object directly)
$trim({ input: $.name, chars: " " })
// → { $trim: { input: "$name", chars: " " } }
```

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
mql`$in($.status, ${statuses})`
// → { $in: ["$status", ["active", "pending"]] }
```

## License

MIT
