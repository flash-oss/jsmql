# jsmql

Write MongoDB aggregation expressions in JavaScript. jsmql is a JS-subset language that compiles to MQL JSON — like SQL but for MongoDB, using syntax you already know.

```js
import { jsmql } from "jsmql";

jsmql(($) => $.age > 18 && $.status === "active")
// → { $and: [{ $gt: ["$age", 18] }, { $eq: ["$status", "active"] }] }

jsmql(($) => $.name.trim().toLowerCase())
// → { $toLower: { $trim: { input: "$name" } } }

jsmql(($) => $.items.map((item) => item.price * item.qty).reduce((acc, x) => acc + x, 0))
// → { $reduce: { input: { $map: { input: "$items", as: "item", in: { $multiply: ["$$item.price", "$$item.qty"] } } }, initialValue: 0, in: { $add: ["$$value", "$$this"] } } }
```

You can pass jsmql a **string** (`jsmql("…")`) or an **arrow function** (`jsmql(($) => …)`). The function form is recommended — your JS formatter (prettier, oxfmt) handles indentation and line breaks for long expressions automatically.

MongoDB 8.0 deprecated `$function`, `$accumulator`, and `$where` — three operators that run JavaScript on the server. They're slow, can't use indexes, and are turned off in many setups. jsmql is the replacement: you write your logic as plain JavaScript and it compiles to fast native MongoDB operators. See [Replacing server-side JavaScript](#replacing-server-side-javascript) for examples.

## Install

```sh
npm install jsmql
```

Works with **Node 24+**, Deno, and Bun. No build step needed in your project.

The package is published as ESM. Node 24+ supports [`require(esm)`](https://nodejs.org/api/modules.html#loading-ecmascript-modules-using-require), so both `import { jsmql } from "jsmql"` and `const { jsmql } = require("jsmql")` work.

**Try it without installing.** Clone the repo, run `npm install && npm run build`, then serve the repo root (`python3 -m http.server`) and open [`playground.html`](./playground.html) — a single-file static playground with a live jsmql → MQL JSON view.

## Quick start

```js
import { jsmql } from "jsmql";

// JS operators and method chains — function form (recommended)
jsmql(($) => $.price >= 100 && $.stock > 0)
// → { $and: [{ $gte: ["$price", 100] }, { $gt: ["$stock", 0] }] }

// String form — equivalent
jsmql("$.price >= 100 && $.stock > 0")

// Use in a $match stage
db.products.aggregate([{ $match: { $expr: jsmql(($) => $.price >= 100) } }]);

// Embed JS values with the template-tag form
const minAge = 21;
const filter = jsmql`$.age >= ${minAge} && $.active === true`;
// → { $and: [{ $gte: ["$age", 21] }, { $eq: ["$active", true] }] }

// Compile once, bind many — for queries that run repeatedly with different values
const eligible = jsmql.compile(
  ({ minAge, region }, $, { $match }) =>
    [$match($.age >= minAge && $.region === region)],
);
eligible({ minAge: 21, region: "AU" });
// → [{ $match: { age: { $gte: 21 }, region: "AU" } }]

// Check syntax without throwing
jsmql.validate(($) => $.age > 18);
// → { valid: true, errors: [] }
```

## Syntax

jsmql accepts a JS-like expression syntax that covers the full range of JavaScript operators and methods:

```js
// Arithmetic, comparison, logical
$.price * 1.1 > $.msrp
$.age >= 18 && $.status === "active"
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
typeof $.field === "string" ? $.field.trim() : String($.field)
Array.isArray($.tags) && $.tags.length > 0

// Dates
Date.now() - $.createdAt.getTime()
$.event.ts.toISOString()
$dateDiff({ startDate: $.createdAt, endDate: new Date(), unit: "day" })

// Numeric separators, computed keys, object spread
$.price <= 1_000_000
{ [$.dynamicKey]: $.value, count: 1 }
{ ...$.defaults, priority: 1 }
Object.fromEntries($.metrics.map((m) => [m.name, m.value]))
```

JavaScript-style line (`// …`) and block (`/* … */`) comments are supported anywhere whitespace is allowed.

### Mutations: `=`, `+=`, `delete`

For document updates, use JS-natural assignment and `delete`. Each mutation compiles to a MongoDB pipeline `$set`/`$unset` stage; consecutive same-kind mutations coalesce automatically:

```js
jsmql("$.score += 1")
// → { $set: { score: { $add: ["$score", 1] } } }

jsmql("$.total = $.price * $.qty, $.views += 1")
// → { $set: { total: { $multiply: ["$price", "$qty"] }, views: { $add: ["$views", 1] } } }

jsmql("delete $.tempToken, delete $._processingState, $.status = 'complete'")
// → [
//     { $unset: ["tempToken", "_processingState"] },
//     { $set: { status: "complete" } }
//   ]
```

Works for `=`, `+=`, `-=`, `*=`, `/=`, and `delete`; targets are field paths (`$.x`, `$.x.y`); separators are `;` or `,`. See [docs/LANGUAGE.md § Mutations](docs/LANGUAGE.md#mutations) for the full rules.

### Escape hatch: `$op()` (direct operator form)

For MongoDB operators that have no JavaScript equivalent, call the operator directly with `$opName()`:

```js
$zip([$.weeks, $.amounts])         // { $zip: { inputs: ["$weeks", "$amounts"] } }
$sampleRate(0.1)                   // { $sampleRate: 0.1 }
$stdDevPop($.measurements)         // { $stdDevPop: "$measurements" }
$dateTrunc({ date: $.createdAt, unit: "week" })
                                   // { $dateTrunc: { date: "$createdAt", unit: "week" } }
$round($.price, 2)                 // { $round: ["$price", 2] }   (Math.round has no precision arg)
```

jsmql knows 182 operators — every aggregation expression and accumulator from MongoDB's official specs, including the full Bitwise and Window categories. Unknown operators pass through, so jsmql works with new MongoDB versions out of the box.

In the function form, destructure escape-hatch operators from the second parameter to keep your IDE happy. The second parameter is types-only and never runs:

```js
jsmql(($, { $dateDiff }) =>
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

**[test/realistic.test.ts](test/realistic.test.ts)** contains end-to-end examples of realistic MongoDB aggregation expressions — tiered discounts, slug generation, date formatting, parameterised queries, and more. It is the best place to see what jsmql looks like in practice.

## Replacing server-side JavaScript

MongoDB 8.0 deprecated `$function`, `$accumulator`, and `$where`. These three operators run JavaScript on the server, and MongoDB's own docs say to replace them with native aggregation operators. jsmql does that for you — you write JavaScript, jsmql compiles it to native MongoDB operators.

### Pros and cons of server-side JavaScript

**Pros:**
- Maximum flexibility — you can write any JavaScript, including things native operators can't do.
- One operator covers many cases — no need to learn a big aggregation operator catalog.

**Cons:**
- Deprecated in MongoDB 8.0 — will be removed in a future version.
- Slower — the JavaScript engine runs once per document; native operators run in C++.
- Skips indexes — `$where` can't use them at all; native operators can.
- Often turned off — many setups (including parts of Atlas) disable server-side JavaScript with `--noscripting`.
- Hides logic from the query planner — MongoDB can't reorder or push down through JavaScript.
- Sharding issues — `$where` doesn't work cleanly across shards.
- Security risk — running JavaScript on the server is a known attack surface, especially with user input.
- Verbose — `$accumulator` is six JavaScript fields for what's usually one line in jsmql.
- Your IDE can't see the code — the body is just a string. No autocomplete, no rename, no go-to-definition, no ESLint, no formatter.
- Hard to test — you need a real MongoDB instance with scripting enabled to run the JS body. jsmql expressions are plain JavaScript and test like any other function.
- No syntax checking — typos blow up at runtime, not at compile time.

### `$where` becomes `$expr`

```js
// Deprecated in MongoDB 8.0
db.users.find({ $where: "function() { return this.age > 18; }" });

// jsmql
db.users.find({ $expr: jsmql(($) => $.age > 18) });
// → { $expr: { $gt: ["$age", 18] } }
```

Unlike `$where`, `$expr` can use indexes.

### `$accumulator` becomes `$reduce` (count orders by status per shop)

For each shop, you want a count of orders by status: `{ pending: 12, paid: 87, refunded: 3 }`. No built-in accumulator can build a dynamic-keyed object during `$group`, so people reach for `$accumulator` and JavaScript:

```js
// Deprecated in MongoDB 8.0 — six JavaScript fields, all stored as strings
{ $group: {
    _id: "$shopId",
    counts: { $accumulator: {
        init:           "function() { return {}; }",
        accumulate:     "function(state, status) { state[status] = (state[status] || 0) + 1; return state; }",
        accumulateArgs: ["$status"],
        merge:          "function(a, b) { const out = {...a}; for (const k in b) out[k] = (out[k] || 0) + b[k]; return out; }",
        lang: "js"
} } } }
```

In jsmql, collect the statuses with `$push`, then build the object with `$reduce` and a computed key:

```js
jsmql(($) => [
  { $group: { _id: $.shopId, statuses: $push($.status) } },
  {
    $project: {
      counts: $.statuses.reduce((acc, s) => ({ ...acc, [s]: (acc[s] ?? 0) + 1 }), {}),
    },
  },
]);
```

Same result, no string-encoded JavaScript, no separate merge function. Every line is plain JS — your IDE lints, formats, and refactors it like any other code. `$function` follows the same pattern: replace the JS body with native arithmetic and method chains.

See [docs/LANGUAGE.md#replacing-server-side-javascript](docs/LANGUAGE.md#replacing-server-side-javascript) for the full migration guide.

## API

### `jsmql(input): object | object[]`

Compiles your expression to MongoDB aggregation JSON. Throws a clear error if the input is invalid.

Returns either a single MQL object (for an expression) or an array of stages (for a top-level pipeline). Pass an expression to get an expression, pass a pipeline array to get a stage array:

```js
// Expression input → MQL object output
jsmql(($) => $.age > 18);
// → { $gt: ["$age", 18] }

// Pipeline input → MQL stage array output (and $match auto-wraps in $expr)
jsmql(($) => [{ $match: $.age > 18 }, { $project: { name: 1 } }]);
// → [{ $match: { $expr: { $gt: ["$age", 18] } } }, { $project: { name: 1 } }]
```

`jsmql` accepts three call shapes — pick whichever fits the moment:

**1. Arrow function** (recommended for inline expressions):

```js
jsmql(($) => $.age > 18);
jsmql(($, { $dateDiff }) =>
  $dateDiff({ startDate: $.t, endDate: new Date(), unit: "day" }),
);
```

Behind the scenes, jsmql calls `Function.prototype.toString()` on the function, strips the parameter list at the first `=>`, and parses the body just like a string. Block bodies (`($) => { return …; }`), `function` declarations, and `async` arrows are rejected with a clear error. For queries that run repeatedly, use [`jsmql.compile(fn)`](docs/LANGUAGE.md) — it parses the arrow once and returns a callable you invoke with a fresh params object on every call.

**2. String** (when the source comes from elsewhere):

```js
jsmql("$.price >= 100 && $.stock > 0");
```

**3. Template tag** (when you need to embed runtime values from outer scope):

```js
const statuses = ["active", "pending"];
jsmql`$.status in ${statuses}`;
// → { $in: ["$status", ["active", "pending"]] }
```

Each `${value}` is JSON-stringified and dropped into the expression source. Accepts strings, numbers, booleans, `null`, arrays, and plain objects. Anything else (`undefined`, functions, `Symbol`, `NaN`, `±Infinity`, `BigInt`, circular structures) throws `JsmqlInterpolationError` so you find out at the call site, not via a confusing parse error downstream.

The template-tag form is the right tool when the function form's `Function.prototype.toString()` would lose closure variables you need to embed.

A wrong-shape input (e.g. `jsmql(42)`, `jsmql({})`) throws a `TypeError` naming the three accepted shapes.

### `jsmql.compile<P>(fn): (params: P) => object | object[]`

Compile a parameterised arrow function once and bind fresh values on every call. The arrow's first slot is a destructure pattern that names the bindings; the same names must appear as keys on the params object passed at call time. Output shape matches the template tag — each value appears as an inline MQL literal, never wrapped in `$let` — so `$match` keeps its index-friendly translation even when the comparison value is dynamic.

```js
const q = jsmql.compile(({ minAge, region }, $, { $match }) =>
  [$match($.age >= minAge && $.region === region)],
);
q({ minAge: 21, region: "AU" });
// → [{ $match: { age: { $gte: 21 }, region: "AU" } }]
```

Defaults in the destructure (`{ minAge = 18 }`) are rejected with a long-form error pointing at the JS `??` fallback for runtime defaults and the template-tag form for hardcoded values. See [docs/LANGUAGE.md § Parameterised Queries](docs/LANGUAGE.md#parameterised-queries-jsmqlcompile) for the full surface.

### `jsmql.validate(input): { valid: boolean, errors: object[] }`

Same as `jsmql()` but returns errors in a structured result instead of throwing. Useful for linters and form validation. Accepts the same three call shapes (string, arrow function, template tag) — `` jsmql.validate`$.x === ${val}` `` works the same as `jsmql.validate("$.x === 1")`. `jsmql.validate()` never throws — even on stack overflow, wrong-typed input, or unexpected internal errors, you get a structured result describing the failure.

The parameterised path stays throw-style: `jsmql.compile(fn)(params)` throws on bad input. There is no `jsmql.validate.compile` — wrap the compiled callable in your own `try`/`catch` if you need structured per-call errors.

Each error has `{ message: string, pos: number, code: "SYNTAX_ERROR" | "CODEGEN_ERROR" }`. `pos` is the character offset in the source (or `0` if not applicable).

### Errors

jsmql throws regular `Error` subclasses you can catch by class:

- `JsmqlInterpolationError` — the template-tag form got a value it can't safely embed (see above).
- `FunctionInputError` — the function form got something it can't extract a body from (block body, `function` declaration, `async`).

Parse and codegen failures throw plain `Error`s with descriptive messages.

## License

MIT
