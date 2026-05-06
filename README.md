# mjsql

Write MongoDB aggregation expressions in JavaScript. mjsql is a JS-subset language that compiles to MQL JSON — like SQL but for MongoDB, using syntax you already know.

```js
import { mjsql } from "mjsql";

mjsql(($) => $.age > 18 && $.status == "active")
// → { $and: [{ $gt: ["$age", 18] }, { $eq: ["$status", "active"] }] }

mjsql(($) => $.name.trim().toLowerCase())
// → { $toLower: { $trim: { input: "$name" } } }

mjsql(($) => $.items.map((item) => item.price * item.qty).reduce((acc, x) => acc + x, 0))
// → { $reduce: { input: { $map: { input: "$items", as: "item", in: { $multiply: ["$$item.price", "$$item.qty"] } } }, initialValue: 0, in: { $add: ["$$value", "$$this"] } } }
```

mjsql accepts the expression as either a **string** (`mjsql("…")`) or an **arrow function** (`mjsql(($) => …)`). The function form is recommended — your editor's regular JS formatter (prettier, oxfmt) indents and line-breaks long expressions for free.

## Install

```sh
npm install mjsql
```

Requires **Node 24+** (or Deno / Bun) — mjsql ships its source as native TypeScript and runs without a build step.

The package is published as ESM (`"type": "module"`). On Node 24+ it works from both ESM and CommonJS via Node's [`require(esm)`](https://nodejs.org/api/modules.html#loading-ecmascript-modules-using-require) support — `import { mjsql } from "mjsql"` and `const { mjsql } = require("mjsql")` are both fine.

## Quick start

```js
import { mjsql, validate, mql } from "mjsql";

// JS operators and method chains — function form (recommended)
mjsql(($) => $.price >= 100 && $.stock > 0)
// → { $and: [{ $gte: ["$price", 100] }, { $gt: ["$stock", 0] }] }

// String form — equivalent
mjsql("$.price >= 100 && $.stock > 0")

// Use in a $match stage
db.products.aggregate([{ $match: { $expr: mjsql(($) => $.price >= 100) } }]);

// Embed JS values with the template tag
const minAge = 21;
const filter = mql`$.age >= ${minAge} && $.active == true`;
// → { $and: [{ $gte: ["$age", 21] }, { $eq: ["$active", true] }] }

// Check syntax without throwing
validate(($) => $.age > 18);
// → { valid: true, errors: [] }
```

## Syntax

mjsql accepts a JS-like expression syntax that covers the full range of JavaScript operators and methods:

```js
// Arithmetic, comparison, logical
$.price * 1.1 > $.msrp
$.age >= 18 && $.status == "active"
$.nickname ?? $.firstName ?? "Anonymous"

// Template literals and optional chaining
`Hi, ${$.user?.firstName ?? "there"} — your order ${$.id} is ready`

// String methods
$.email.toLowerCase().trim()
$.title.split(" ").at(0)
$.file.name.endsWith(".pdf") || $.file.name.startsWith("draft-")
$.code.charAt(0).toUpperCase()

// Array methods with lambdas
$.orders.filter((o) => o.total > 100).map((o) => o.id)
$.scores.reduce((acc, x) => acc + x, 0)
$.docs.flatMap((d) => d.tags).join(", ")
$.posts.map((p) => p.tags).flat()
[".pdf", ".docx"].includes($.file.ext)

// Math, typeof, type casts, constants
Math.min(...$.scores)              // spread args
Math.hypot($.dx, $.dy)             // Euclidean distance
Math.log10($.amplitude) * 20       /* signal in dB */
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
Object.fromEntries($.metrics.map((m) => [m.name, m.value]))
```

JavaScript-style line (`// …`) and block (`/* … */`) comments are supported anywhere whitespace is allowed.

### Escape Hatch: `$op()` (direct operator form)

For MongoDB operators that have no JavaScript equivalent, use the `$opName()` escape hatch — a direct call to the underlying MQL operator:

```js
$zip([$.weeks, $.amounts])         // { $zip: { inputs: ["$weeks", "$amounts"] } }
$sampleRate(0.1)                   // { $sampleRate: 0.1 }
$stdDevPop($.measurements)         // { $stdDevPop: "$measurements" }
$dateTrunc({ date: $.createdAt, unit: "week" })
                                   // { $dateTrunc: { date: "$createdAt", unit: "week" } }
$round($.price, 2)                 // { $round: ["$price", 2] }   (Math.round has no precision arg)
```

The registry covers every MongoDB aggregation expression and accumulator the official `mongodb/mql-specifications` repo defines (182 operators, including the full Bitwise and Window categories). Unknown operators pass through automatically, making mjsql forward-compatible with new MongoDB releases.

Inside the function form, destructure escape-hatch operators from the second parameter so the IDE doesn't flag them as unknown identifiers — the parameter is types-only and never reaches the runtime:

```js
mjsql(($, { $dateDiff }) =>
  $dateDiff({ startDate: $.lastLoginAt, endDate: new Date(), unit: "day" }) ?? -1,
);
```

Field references use `$.` notation, with bracket access for array indices and dynamic keys:

```js
$.age                  // "$age"
$.address.city         // "$address.city"
$.items[0].name        // first element's name (use bracket access — `$.items.0` is invalid JS)
$.items[$.idx]         // dynamic index
```

See **[docs/LANGUAGE.md](docs/LANGUAGE.md)** for the full language reference.

## Real-world examples

**[test/realistic.test.ts](test/realistic.test.ts)** contains end-to-end examples of realistic MongoDB aggregation expressions — tiered discounts, slug generation, date formatting, parameterised queries, and more. It is the best place to see what mjsql looks like in practice.

## API

### `mjsql(input: string | function): object`

Parses and transpiles the expression. Throws a descriptive error on invalid input.

The function form accepts an **expression-body arrow function**:

```js
mjsql(($) => $.age > 18);
mjsql(($, { $dateDiff }) =>
  $dateDiff({ startDate: $.t, endDate: new Date(), unit: "day" }),
);
```

The runtime calls `Function.prototype.toString()`, strips the parameter list at the first `=>`, and feeds the body to the same parser as the string form. Block bodies (`($) => { return …; }`), `function` declarations, `async`, and generators are rejected with a clear error. Outer-scope variables don't survive `toString()` — for those, use the `mql` template tag. Compiled bodies are cached by their extracted source string, so inline arrows in hot paths (`collection.find(mjsql(($) => $.status == "active"))`) compile only once.

### `validate(input: MjsqlInput): { valid: boolean, errors: ValidationError[] }`

Same as `mjsql()` but returns errors instead of throwing. Useful for linters and form validation.

### `` mql`...` `` (template tag)

Interpolate JavaScript values (numbers, strings, booleans, arrays) directly into expressions:

```js
const statuses = ["active", "pending"];
mql`$.status in ${statuses}`
// → { $in: ["$status", ["active", "pending"]] }
```

The template tag is the canonical answer when you need to inject closure-scope values into a function-form expression.

### TypeScript

```ts
import type { MjsqlInput, MjsqlOps, ValidationError, ValidationResult } from "mjsql";
```

`MjsqlOps` is the type of the function form's optional second parameter — `Record<\`$${string}\`, (...args: any[]) => any>` — used purely to silence IDE warnings on direct `$op(...)` calls inside the body.

## License

MIT
