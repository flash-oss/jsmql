# jsmql Language Reference

> This is the **user-facing language reference** for jsmql. For implementation details, see `specs/`. For the list of features not yet implemented or rejected as bad DX, see [DEFERRED.md](DEFERRED.md).

---

## Quick Start

jsmql is a JavaScript-subset language that compiles to MongoDB query syntax — like SQL but for MongoDB, using JS syntax you already know. The presence (or absence) of a semicolon picks the output shape, matching the Node.js MongoDB driver's own terminology:

- **No `;`** → a **Filter** (the document `db.coll.find(filter)` takes)
- **Any `;`** → a **Pipeline** of stages (the array `db.coll.aggregate(pipeline)` takes)

```js
const { jsmql } = require("@koresar/jsmql");

// No semicolons → Filter. Field-vs-literal predicates emit indexable
// query-doc entries; anything else rides in a top-level `$expr` residual.
jsmql("$.age > 18 && $.status === 'active'");
// → { age: { $gt: 18 }, status: "active" }
//   db.users.find({ age: { $gt: 18 }, status: "active" })

// Method calls aren't expressible in the query language, so the whole thing
// falls into `$expr` (still a legal Filter operator).
jsmql("$.email.split('@').at(1).toLowerCase() === 'gmail.com'");
// → { $expr: { $eq: [ { $toLower: { $arrayElemAt: [{ $split: ["$email", "@"] }, 1] } }, "gmail.com" ] } }

// Any `;` flips to Pipeline mode — even one stage with a trailing `;`.
jsmql("$match($.age > 18); $sort({ age: 1 });");
// → [ { $match: { age: { $gt: 18 } } }, { $sort: { age: 1 } } ]
//   db.users.aggregate([...])

// With the template-tag form of jsmql (for embedded values)
const minAge = 21;
jsmql`$.age >= ${minAge} && $.status === 'active'`;
// → { age: { $gte: 21 }, status: "active" }
```

The same rule applies to the [function form](#function-form): an **expression-body** arrow (`({ $ }) => …`) lowers as a Filter, while a **block-body** arrow (`({ $ }) => { …; … }`) lowers as a Pipeline.

---

## Table of Contents

1. [Output dispatch: Filter vs Pipeline](#output-dispatch-filter-vs-pipeline)
2. [Expressions](#expressions)
3. [Literals](#literals)
4. [Comments](#comments)
5. [Trailing commas](#trailing-commas)
6. [Field References](#field-references)
6. [Mistakes caught at compile time](#mistakes-caught-at-compile-time)
7. [Operators](#operators)
7. [String Methods](#string-methods)
8. [Array Methods](#array-methods)
9. [Lambda Functions](#lambda-functions)
10. [Math Functions](#math-functions)
11. [Type Casting](#type-casting)
12. [Date Operations](#date-operations)
13. [Escape Hatch (Direct Operator Form)](#escape-hatch-direct-operator-form)
14. [Update filters](#update ops)
15. [Pipelines](#pipelines)
16. [Function Form](#function-form)
17. [Partial expressions (`jsmql.expr`)](#partial-expressions-jsmqlexpr)
18. [Strict-shape entry points (`jsmql.filter`, `jsmql.pipeline`, `jsmql.update`)](#strict-shape-entry-points-jsmqlfilter-jsmqlpipeline-jsmqlupdate)
19. [Parameterised Queries (`jsmql.compile`)](#parameterised-queries-jsmqlcompile)
20. [Template-Tag Form (`` jsmql`…` ``)](#template-tag-form-jsmql)
21. [Validation](#validation)
22. [Error Messages](#error-messages)
23. [Examples](#examples)
24. [Replacing Server-Side JavaScript](#replacing-server-side-javascript)

---

## Output dispatch: Filter vs Pipeline

`jsmql()` picks its output shape from what's at the top level of the input. Names follow the Node.js MongoDB driver:

| Input top-level shape | Output | Used with |
|---|---|---|
| **Stage call** (`$match(...)`, `$project(...)`, `{ $match: ... }`, …) | a **Pipeline** `[…stages…]` (one stage) | `db.coll.aggregate(pipeline)` |
| **Update filter** (`$.x = …`, `delete $.x`) | a **Pipeline** `[{ $set: … }]` / `[{ $unset: … }]` | `db.coll.updateOne(filter, update)` |
| **`;`-separated statements** (even a single trailing `;`) | a **Pipeline** `[…stages…]` | `db.coll.aggregate(pipeline)` |
| **Anything else** (predicate, expression) | a **Filter** (single document) | `db.coll.find(filter)` |

The first three rows all produce arrays — `jsmql()` is "would the driver call site need an array here?" → yes, give it an array. The `;` is only required to compose **multiple** stages; a single stage written naturally (with or without `;`) works.

### No semicolons → Filter

The expression is interpreted as a Filter. Field-vs-literal predicates the MongoDB query language can express directly emit indexable `{ field: { $op: lit } }` pairs; anything else (method calls, computed expressions, non-predicate values) rides in a top-level `$expr` residual — a legal Filter operator. So both predicates and computational expressions produce a valid Filter.

```js
// Pure query-document — indexable on `age` and `status`
jsmql("$.age > 18 && $.status === 'active'");
// → { age: { $gt: 18 }, status: "active" }

// `new Date(...)` with literal args folds to a JS Date — index-friendly on `createdAt`
jsmql(`$.method === "postalDelivery" && $.createdAt >= new Date("2026-01-01")`);
// → { method: "postalDelivery", createdAt: { $gte: <Date 2026-01-01> } }

// Mixed: indexable conjunct + `$expr` residual for the untranslatable part
jsmql("$.status === 'active' && $.name.trim() === 'alice'");
// → { status: "active", $expr: { $eq: [{ $trim: { input: "$name" } }, "alice"] } }

// Fully untranslatable — the whole thing rides in $expr
jsmql("$add($.a, $.b)");
// → { $expr: { $add: ["$a", "$b"] } }
```

The translation rules are the same ones [`$match` uses inside a Pipeline](#match-indexes-by-default) — see [docs/specs/match-query-translation.md](specs/match-query-translation.md) for the full table.

**`new Date(...)` and indexes.** When all `new Date(...)` arguments are compile-time literals — `new Date("2026-01-01")`, `new Date(2026, 0, 1)`, `new Date(Date.UTC(2026, 0, 1))` — jsmql folds the constructor at compile time and emits a real JS `Date` instance on the query-doc RHS. That's the shape MongoDB indexes on `createdAt` actually need. `new Date()` (zero-arg, server-side `$$NOW`) and `new Date($.someField)` necessarily fall back to `$expr` since they can't be evaluated until query time. Conversely, `{ field: { $gte: { $toDate: "..." } } }` does **not** work in a Filter — MongoDB's query language treats `{ $toDate: ... }` as a literal subdocument, never matching anything. The fold avoids that footgun.

### Stage call → Pipeline (no `;` required)

A top-level stage call or stage-object literal auto-wraps into a one-element Pipeline. No `;` discipline at the call site — the cleanest JS surface produces the cleanest correct MQL.

```js
// Single-stage Pipeline, no `;` needed
jsmql("$match($.age > 18)");
// → [ { $match: { age: { $gt: 18 } } } ]

// The Compass copy-paste shape works the same way
jsmql("{ $match: $.age > 18 }");
// → [ { $match: { age: { $gt: 18 } } } ]

// `;` is still allowed and produces identical output
jsmql("$match($.age > 18);");
// → [ { $match: { age: { $gt: 18 } } } ]
```

### Any `;` → Pipeline (multi-stage)

Each `;`-separated statement is one Pipeline stage. Use `;` to compose multiple stages in one call.

```js
// Multi-stage Pipeline
jsmql("$match($.age > 18); $sort({ age: 1 });");
// → [ { $match: { age: { $gt: 18 } } }, { $sort: { age: 1 } } ]
```

A `;`-separated statement **must** be a stage call (`$match`, `$project`, `$sort`, …), an update op (`$.x = …`), or a `let` binding. A bare expression like `$.age > 18;` is rejected with a `$match(...)` suggestion:

```text
Element 0 of Pipeline is not a stage call. To filter documents on a
predicate, wrap it as `$match(...)` — e.g. `$match($.age > 18)`. …
```

### Function form mirrors the rule

An **expression-body** arrow (`({ $ }) => …`) is the function equivalent of a no-`;` string — it lowers as a Filter, unless the body is itself a stage call (then auto-wrap fires). A **block-body** arrow (`({ $ }) => { …; … }`) is the equivalent of a `;`-separated string — it lowers as a Pipeline.

```js
jsmql(({ $ }) => $.age > 18);
// → { age: { $gt: 18 } }                            (Filter)

jsmql(({ $ }) => $match($.age > 18));
// → [ { $match: { age: { $gt: 18 } } } ]            (Pipeline — stage call auto-wraps)

jsmql(({ $, $match, $sort }) => {
  $match($.age > 18);
  $sort({ age: 1 });
});
// → [ { $match: { age: { $gt: 18 } } }, { $sort: { age: 1 } } ]   (Pipeline)
```

The template-tag form (`` jsmql`…` ``) follows the string-form rule: a stage call or any `;` in the assembled source produces a Pipeline.

---

## Expressions

An jsmql expression is a **subset of JavaScript** that compiles to MongoDB aggregation expression JSON. Write JS operators, method chains, and lambdas — jsmql handles the translation. For MongoDB operators without a JS equivalent, use the `$op()` escape hatch (the direct operator form).

### Valid Constructs

- Literals: numbers (with numeric separators `1_000_000`), strings, booleans, `null`, arrays, objects
- Template literals: `` `hello, ${$.name}!` ``
- Spread: `[...$.arr]`, `{ ...$.obj }`, `Math.max(...$.scores)`
- Field references: `$.fieldName`, `$.nested.path`
- Optional chaining: `$.a?.b`, `$.a?.[0]`, `$.name?.trim()`
- Bracket access: `$.items[0]`, `$.arr[$.idx]`
- Computed object keys: `{ [$.k]: 1 }`
- Shorthand object properties: `x => ({ x })` (sugar for `{ x: x }`)
- Binary operators: `+`, `-`, `*`, `/`, `%`, `===`, `!==`, `==`/`!=` (against `null` only — see [Comparison](#comparison)), `>`, `>=`, `<`, `<=`, `&&`, `||`, `??`, `in`, `**`
- Unary operators: `!`, `-`
- Ternary operator: `? :`
- String methods: `.trim()`, `.toLowerCase()`, `.startsWith()`, etc.
- Array methods: `.map()`, `.filter()`, `.flat()`, `.join()`, etc.
- Math functions and constants: `Math.floor()`, `Math.min()`, `Math.PI`, etc.
- Type casting: `Number()`, `String()`, `typeof`, etc.
- Date operations: `new Date()`, `Date.now()`, `.getFullYear()`, `.toISOString()`, etc.
- Lambda functions: `x => expr`, `(a, b) => expr`
- Escape hatch (direct operator form): `$sampleRate(0.33)`, `$dateTrunc($.createdAt, "day")`, etc.
- Comments: `// line` and `/* block */` — semantics identical to JavaScript

### Invalid Constructs

- Control flow: `if`, `for`, `while`, `break`, etc.
- Statement-level features other than update ops: function definitions, declarations
- Object/array in-place update ops: `.push()`, `.splice()`
- Destructuring: `{ a, b } = obj`

---

## Literals

### Numbers

Integer and floating-point numbers, scientific notation, and numeric separators (`_` between digits):

```js
42
3.14
-7
1e3          // 1000
2.5e-2       // 0.025
1_000_000    // 1000000   (separators are stripped)
1_234.567_89 // 1234.56789
```

Underscores must sit between two digits — `1_`, `_1`, and `1__0` are errors.

**BigInt literals.** Integer literals with an `n` suffix compile to MongoDB's `$toLong`:

```js
123n           // { $toLong: "123" }
1_000_000n     // { $toLong: "1000000" }   (separators allowed)
$.timestamp - 1000n
               // { $subtract: ["$timestamp", { $toLong: "1000" }] }
```

`n` suffix is integer-only — `1.5n`, `1e2n`, etc. are syntax errors (matches JS).

### Strings

Both single and double quotes. Escape sequences: `\\`, `\"`, `\'`, `\n`, `\t`:

```js
"hello"
'world'
"line1\nline2"
"escaped \"quote\""
```

#### `$`-prefixed strings: a `"$x"` you type is the field ref `$x`

A string that starts with `$` (like `"$items"`) is read by MongoDB as a **field
reference** in aggregation expressions. jsmql honours that: a `"$x"` you type in
source **is** the field ref `$x`, and it **passes through verbatim in every
context** — pipelines, stage bodies, and `jsmql.expr` alike. jsmql never adds a
`$literal` of its own (this is rule **HR1**; see [LANG_RULES.md](LANG_RULES.md)):

```js
jsmql(`$unwind("$items");`)        // → [{ $unwind: "$items" }]
jsmql(`[{ $unwind: "$items" }]`)   // → [{ $unwind: "$items" }]  (raw MQL, unchanged)
jsmql(`$project({ t: $concat("$a", "$b") });`)
//    → [{ $project: { t: { $concat: ["$a", "$b"] } } }]   (even nested in an operator)
jsmql.expr(`$eq($.x, "$y")`)       // → { $eq: ["$x", "$y"] }   ("$y" is the field ref $y)
```

Writing `$.items` instead of `"$items"` produces the identical output, so use
whichever reads better. To force a **literal** string that happens to start with
`$`, use the `$literal(...)` escape hatch — exactly as in raw MQL:

```js
jsmql.expr(`$literal("$y")`)                // → { $literal: "$y" }
jsmql(`$project({ x: $literal("$y") });`)   // → [{ $project: { x: { $literal: "$y" } } }]
```

The one exception is for safety: a **runtime-injected** value (a `jsmql.compile`
parameter or a template-tag `${…}` interpolation) that looks like `"$x"` *is*
wrapped in `$literal` in expression position, so untrusted input can't silently
turn into a field reference:

```js
jsmql.expr`$.x === ${userInput}`   // userInput = "$secret" → { $eq: ["$x", { $literal: "$secret" }] }
```

### Template Literals

Backtick-delimited strings with `${expr}` interpolation, just like JS. They compile to `$concat`:

```js
`hello, ${$.name}!`
// → { $concat: ["hello, ", { $toString: "$name" }, "!"] }

`total: ${$.a + $.b}`
// → { $concat: ["total: ", { $toString: { $add: ["$a", "$b"] } }] }
```

Interpolated expressions are wrapped with `$toString` to match JS coercion semantics —
`` `count: ${$.n}` `` works whether `$.n` is a number or a string. Expressions that are
statically known to produce strings (string literals, `.toLowerCase()`, `String(x)`,
nested template literals, etc.) skip the wrap to keep the output compact:

```js
`name=${$.name.toLowerCase()}`
// → { $concat: ["name=", { $toLower: "$name" }] }     // no $toString — already a string
```

Templates with no expressions resolve to plain strings. Escape sequences support `\\`, `` \` ``, `\$`, `\n`, `\t`, `\r`. Templates nest: `` `outer ${`inner ${$.x}`}` `` works.

### Booleans

```js
true
false
```

### Null

```js
null
```

### Arrays

Comma-separated values in brackets, including spread:

```js
[1, 2, 3]
["active", "pending"]
[1, "two", true, null]
[$.age, $.name]               // can contain field refs and expressions
[...$.tags, "extra"]          // spread an array field
[...$.a, ...$.b]              // spread multiple arrays
```

Spread compiles to `$concatArrays`. Consecutive non-spread elements group into one operand, each `...expr` becomes its own operand, and a lone `[...x]` returns `x` directly — no redundant `$concatArrays` wrapper. Each spread argument must evaluate to an array at runtime; this is the same constraint MongoDB's `$concatArrays` itself imposes.

### Objects

Key-value pairs in braces, including spread:

```js
{ name: $.name, score: $.score }           // field values
{ status: "active", count: $.count + 1 }   // mixed
{ ...$.defaults, priority: 1 }             // → { $mergeObjects: ["$defaults", { priority: 1 }] }
{ ...$.a, ...$.b, extra: true }            // → { $mergeObjects: ["$a", "$b", { extra: true }] }
```

Spread compiles to `$mergeObjects`. Consecutive non-spread keys group into one operand, each `...expr` becomes its own operand, and JS "later wins" semantics on key collision match `$mergeObjects` exactly. A lone `{...x}` returns `x` directly — no redundant `$mergeObjects` wrapper.

Objects are useful as `$push` arguments in `group()`, as `$project` escape hatch values, and in `$let` bindings.

#### Computed Keys

Keys may be computed expressions, just like in JS:

```js
{ [$.k]: 1 }                       // → { $arrayToObject: [[{ k: "$k", v: 1 }]] }
{ a: 1, [$.dynKey]: 2 }            // → { $arrayToObject: [[{ k: "a", v: 1 }, { k: "$dynKey", v: 2 }]] }
```

Whenever a static block of keys contains at least one computed key, that block compiles to `$arrayToObject` (using its `{ k, v }` object-pair form) so MongoDB can build it at query time. (The pairs array is wrapped one level deeper — `{ $arrayToObject: [pairs] }` — because MongoDB reads a bare literal array as an *argument list*; the wrap makes it the single argument.) Computed keys mix with spread — each block is built independently, then `$mergeObjects` joins them:

```js
{ ...$.base, [$.k]: $.v }          // → { $mergeObjects: ["$base", { $arrayToObject: [[{ k: "$k", v: "$v" }]] }] }
```

#### Shorthand Properties

`{ x }` is sugar for `{ x: x }` — useful inside lambda bodies:

```js
$.items.map(x => ({ x }))
// → { $map: { input: "$items", as: "x", in: { x: "$$x" } } }
```

The shorthand value is treated as an identifier (lambda parameter); using shorthand outside a lambda scope produces an "Unknown identifier" error.

---

## Comments

jsmql accepts JavaScript-style comments and discards them as trivia — they have no effect on the compiled MQL. Both forms are valid anywhere whitespace is.

```js
$.age >= 18  // line comment to end-of-line
$.score /* block comment, can span lines */ * 1.1
```

Semantics match JavaScript exactly: line comments end at any LineTerminator (LF, CR, LSEP, PSEP) or EOF; block comments do not nest (the first `*/` closes), and an unclosed `/* …` is a parse error. Comments inside string literals, regex literals, and template-literal text are character data, not comments.

---

## Trailing commas

As in JavaScript, a single trailing comma after the last item of any comma-separated list is allowed — and ignored. It works **everywhere** a list appears: call arguments, array and object literals, arrow / `function` parameter lists, and the in-stage update-op chain. This means code your formatter has already touched (prettier and oxfmt add trailing commas when they break a list across lines) pastes straight in.

```js
Math.max($.a, $.b,)                       // call args
[1, 2, 3,]                                // array
{ name: $.name, age: $.age, }             // object
$.items.map((x, i,) => x * i)             // lambda params + call args
$match(
  $.amount > 100 &&
  ($.currency === "USD" || $.currency === "EUR") &&
  $.status === "active",                  // ← trailing comma on a multi-line stage body
)
$.a = 1, $.b = 2,                         // update-op chain
```

A trailing comma never changes the result — output is identical to the comma-free form — and it is **not** a way to sneak in an extra argument: `Number($.x, $.y)` is still the "takes exactly 1 argument" error, while `Number($.x,)` is fine.

---

## Field References

Document fields are referenced with `$.` (dollar-dot):

```js
$.age              // simple field
$.address.city     // nested field
$.items[0].name    // array element by index — use bracket access (`$.items.0` is invalid JS)
$.in               // field literally named "in" (no conflict with operator)
```

**`$.` always means the *root* document — not "whichever document is nearest".** That matters
once you read another collection: inside a `$$$.<coll>` chain, an `.aggregate((o) => { … })`
block, or a `.filter((o) => …)` predicate, `$.x` still reads the **outer** document. The
sub-pipeline's own document is the callback parameter (`o`), or a raw MQL path string
(`"$x"`). So the two spellings in one stage body address two different documents:

```js
$.t = $$$.orders.$set({ owner: $.tag });    // owner ← the ROOT doc's `tag`
$.t = $$$.orders.$set({ owner: "$tag" });   // owner ← the ORDERS doc's `tag`
```

jsmql threads the root-document read through `$lookup.let` for you; see
[Cross-collection lookups](#cross-collection-lookups-coll-find--filter).

### Bracket Access

> **Dot access is interpreted; bracket access is raw.** A `.member` access can carry compiler meaning — most notably `.length`, which folds to the string-or-array length operator. Square brackets never do: `$.x["length"]`, `$.x["anything"]`, `$.x[$.dynamicKey]` are all **direct property access**. jsmql does not interpret what's inside the brackets — whatever you spell is the property you get. So when you mean "the data at this key, verbatim" (including a field literally named `length`), reach for brackets.

Use square brackets for computed index/key access. The compiled MQL depends on the receiver type:

```js
$.items.map(x => x.id)[0]     // known array → { $arrayElemAt: [{ $map: ... }, 0] }
[1, 2, 3][$.idx]              // known array → { $arrayElemAt: [[1, 2, 3], "$idx"] }
```

For a bare `$.field` indexed by a **non-string** key (a number, or a field whose type
isn't known), jsmql can't tell at compile time whether you mean array indexing or object
dynamic-key lookup, so it emits a runtime `$cond` on `$isArray` that picks the right form
at query time:

```js
$.items[0]
// → { $cond: {
//       if: { $isArray: "$items" },
//       then: { $arrayElemAt: ["$items", 0] },
//       else: { $getField: { field: 0, input: "$items" } }
//     } }
```

When the key is **provably a string** — a string literal, a `.toLowerCase()`-style
string-returning expression, a `const k = "…"` binding, or **a lambda parameter iterating
an array whose elements are all strings** — it can only be an object property name (a string
is never a numeric array index), so jsmql skips the dispatch and emits `$getField` directly:

```js
$.config["host"]              // → { $getField: { field: "host", input: "$config" } }
$.scores[$.key.toLowerCase()] // → { $getField: { field: { $toLower: "$key" }, input: "$scores" } }

// `party` iterates a string array → typed `string`, so `$.cre.result[party]` is a getter:
["sender", "recipient"].map(party => $.cre.result[party])
// → { $map: { input: ["sender","recipient"], as: "party",
//             in: { $getField: { field: "$$party", input: "$cre.result" } } } }
```

The same element-type inference applies across `.filter`/`.find`/`.some`/`.every`/`.flatMap`/`.reduce`, and the element type is also read from `String.split(",")` and `Object.keys(o)` (both yield string arrays) and from object/array-literal element arrays (so `[{…}, {…}].map(o => o[k])` treats `o` as an object). It only ever *removes* a redundant guard: a numeric or unknown-typed element keeps the runtime `$isArray` dispatch.

If you want compact output for a *numeric* index, pin the type by chaining a type-fixing method (`.map(x => x)`, `.toReversed()`, etc.) or use the `.at(i)` method (always emits `$arrayElemAt`).

**Callback `(element, index, array)`.** Array-method callbacks (`.map` / `.filter` / `.find` / `.some` / `.every` / `.flatMap` / …) accept all three JS parameters. The third — the array being iterated — is the method's input, so `arr.length` is the count of that array (`$size`): `$.items.map((el, i, arr) => el / arr.length)`. Strict-JS semantics: in a `.filter(...).map((el, i, arr) => …)` chain, `arr` is the post-filter array (it's `map`'s input). The `index` is lazy — jsmql only emits the `$zip`/`$range` index machinery when `i` is *actually used*; `(el, i, arr) => arr.length` (where `i` is only there positionally to reach `arr`) compiles to a plain `$map`/`$filter`.

On a **`$$$.<coll>` lookup chain** (`$$$.orders.filter(p).map((o, _i, coll) => …)`) the third param is the *foreign sub-stream*, and `coll.length` is its document count — how many documents matched the filter — materialised by a `$setWindowFields` `$count` inside the `$lookup.pipeline`. A stream has no materialised array, so **only `.length`** is available on this handle (no indexing or iteration), and the **index** param is never available (MongoDB streams have no per-doc index; it may be present, unused, only to reach the 3rd param). Example: `$.byOrder = $$$.orders.filter(o => o.userId === $._id).map((o, _i, coll) => ({ id: o._id, share: o.total / coll.length }))`.

The **bare root** `$` is the simplest case: the root document is always an object and never an array, so there's nothing to dispatch on for *any* key. A string-literal key lowers to a plain field reference — `$["x"]` is just `$.x` — and a computed key lowers straight to `$getField`. This is how you name a field that isn't a bare identifier — a name containing a dot, dash, space, etc. — and how you read a nested `length` field without `.length` folding to the string-or-array length operator:

```js
$["cart.field.length"]              // → "$cart.field.length"   — the nested `length` field, raw
$["weird-name"]                     // → "$weird-name"
$["cart.field.length"] * $.cart.field.width   // → { $multiply: ["$cart.field.length", "$cart.field.width"] }
$[$.fieldName]                      // → { $getField: { field: "$fieldName", input: "$$ROOT" } }   — computed key, no $isArray dispatch
```

(An object literal receiver follows the same rule — `({ a: 1 })[$.k]` → `{ $getField: { field: "$k", input: { a: 1 } } }` — since an object literal is never an array either.)

### Optional Chaining

`?.` is accepted everywhere `.` is. It's a real safety annotation — when an
optional chain feeds a null-unsafe MongoDB operator, jsmql wraps the chain's
result with `$ifNull(v, neutral)` so a missing field produces an empty value
matching the consumer instead of `null` (which would either crash the operator
or poison every downstream caller).

| Consumer category | Wrapped with | Example |
|---|---|---|
| Bare read | nothing (sugar only) | `$.user?.name` → `"$user.name"` |
| Array spread | `[]` | `[...$.room?.mods]` → `{ $ifNull: ["$room.mods", []] }` |
| Array method receiver (`.map`, `.filter`, `.reduce`, `.reduceRight`, `.find`, `.findIndex`, `.some`, `.every`, `.flat`, `.flatMap`, `.at`, `.toReversed`, `.toSorted`, `.toSpliced`, `.with`, `.join`, `.findLast`, `.findLastIndex`, `.lastIndexOf`, `.toString`) | `[]` | `$.user?.posts.map(p => p.id)` → `{ $map: { input: { $ifNull: ["$user.posts", []] }, ... } }` |
| Either-method receiver (`.slice`, `.indexOf`, `.includes`, `.concat` — `.slice` since type depends on receiver) | `""` (string-typed) / `[]` otherwise | `$.user?.tags.slice(0, 3)` → runtime `$cond` over `$ifNull("$user.tags", [])` |
| String method receiver (`.trim`, `.toUpperCase`, `.toLowerCase`, `.split`, `.substr`, `.substring`, `.charAt`, `.startsWith`, `.endsWith`, `.replace`, `.replaceAll`, `.padStart`, `.padEnd`, `.repeat`, `.match`, `.matchAll`, `.search`) | `""` | `$.user?.name.trim()` → `{ $trim: { input: { $ifNull: ["$user.name", ""] } } }` |
| String `+` operand (string concat) | `""` | `$.first + " " + $.user?.last` → `{ $concat: ["$first", " ", { $ifNull: ["$user.last", ""] }] }` |
| Template literal interpolation | `""` | `` `hello ${$.user?.name}` `` → `{ $concat: ["hello ", { $toString: { $ifNull: ["$user.name", ""] } }] }` |
| `.length` of optional | `""` (string) / `[]` (array or unknown — array branch produces 0) | `$.user?.tags.length` → runtime `$cond` over `$ifNull("$user.tags", [])` |
| Index access (`obj?.[k]` or `?.` earlier in chain) | `[]` | `$.scoresByLevel?.[$.level]` → runtime `$cond` over `$ifNull("$scoresByLevel", [])` |
| Non-foldable `$getField` receiver | `{}` | `$.items[0]?.label` → `{ $getField: { field: "label", input: { $ifNull: [..., {}] } } }` |
| `Object.keys` / `.values` / `.entries` argument | `{}` | `Object.keys($.user?.profile)` → `$objectToArray: { $ifNull: ["$user.profile", {}] }` |
| `Object.fromEntries` argument | `[]` | `Object.fromEntries($.user?.pairs)` → `$arrayToObject: { $ifNull: ["$user.pairs", []] }` |
| `new Set(...)` argument | `[]` | `new Set($.user?.tags).union(new Set($.global))` → set ops on `$ifNull(..., [])` |

`?.` is **deliberately not** wrapped where the consumer is already null-safe.
These cases produce the same MQL whether you use `.` or `?.`:

| Consumer | Why no wrap |
|---|---|
| Object spread (`{...x?.y}`) | `$mergeObjects` silently ignores null operands and returns `{}` when all operands are null. |
| Comparisons (`==`, `!=`, `<`, `>`, `<=`, `>=`, `===`, `!==`) | `$eq` / `$ne` / `$lt` / `$gt` accept null cleanly. |
| Loose-equality null check (`$.x?.y == null`) | The `==`/`!=` form already lowers to a `$type` check that catches "null" and "missing". |
| `$cond` / `&&` / `\|\|` condition | Null is falsy; the chain naturally short-circuits to the alternate branch. |
| `$in` first argument (`arr.includes($.x?.y)`) | Searching for null in an array is a defined, non-erroring operation. |
| Numeric arithmetic operand (`$.a + $.b?.c` in numeric mode, `-`, `*`, `/`, `%`, `**`) | MQL's `$add` etc. return null on null operand — matches JS's `1 + undefined === NaN` closely. Forcing a `0` fallback would silently produce different numbers than JS, which is worse DX than honest null. |

**Scope of the wrap.** `?.` only wraps the chain it appears in. `?.` buried
inside a lambda body, a method argument, an `IndexAccess.index`, or a binary
operand belongs to a *different* chain — it does **not** trigger an outer wrap.
For example, `$.items.map(x => x?.tags)` wraps inside the lambda body, but the
outer `.map`'s receiver (`$.items`) is not optional and is not wrapped.

### Syntax

- Must start with `$.`
- Followed by a valid JavaScript identifier (letter or underscore; digits allowed after the first character)
- May include dots for nested object access (`$.a.b.c`)
- For array elements, use bracket access — `$.items[0]`, not `$.items.0` (the dotted-digit form is invalid JS and is rejected by the lexer)

### Invalid field references

```
$age           // ❌ Missing dot — use $.age or $age()
$.             // ❌ Incomplete
$.0.name       // ❌ Can't start with digit after $.
```

### Context references: `$$`, `$$$`, `$$$$`

jsmql provides three further prefix levels, parallel to `$.`, for cross-collection / cross-database / cross-cluster references.

| Prefix | Scope                          | Status                                                                  |
| ------ | ------------------------------ | ----------------------------------------------------------------------- |
| `$.`   | Current document field         | works today (`$.age`, `$.address.city`)                                 |
| `$$`   | Current collection             | **live for `.push(...)` → `$unionWith`** ([Collection union](#collection-union-push)) and collection-scoped **diagnostics** (`$$.indexStats()`, … — [System stages](#system--diagnostic-stages-indexstats-currentop-)). `.find` / `.filter` data reads on `$$` still need schema/driver binding (deferred). |
| `$$$`  | Current database               | **live for `.find/.filter` joins** ([below](#cross-collection-lookups-coll-find--filter)) and the `$$$.<coll> = …` `$out` write. No diagnostics — they're collection- or server-scoped. |
| `$$$$` | Current cluster / server       | **live for the cross-database `$$$$.<db>.<coll> = …` `$out` write** ([below](#out-write-the-pipeline-to-a-collection)) and server/cluster-scoped **diagnostics** (`$$$$.currentOp()`, `$$$$.shardedDataDistribution()`, …). Cross-database **reads** (`.find/.filter`) are **rejected** — see below. |

Both dot-identifier (`$$$.myColl`) and bracket-expression (`$$$[collVar]`) postfix forms work — bracket access uses standard JS semantics, so the inner expression can be any value (a `jsmql.compile` parameter, a string literal, a deeper expression).

```js
jsmql.expr("$$$.myColl");              // ❌ CodegenError: '$$$.<coll>' must be followed by .find(pred) or .filter(pred)
jsmql.expr('$$$$["db"]["coll"]');      // ❌ '$$$$.<db>.<coll>' is only usable as a cross-database $out destination — cross-database READS aren't supported
jsmql("$$");                            // ❌ ParseError: Expected '.<name>' or '[<expr>]' after '$$'
jsmql("$$.foo");                        // ❌ '$$' is statement-only and only supports '.push(...)'
jsmql("$$$$$.x");                       // ❌ LexError: Up to 4 levels of context reference are supported
```

The full `$$$.<coll>.find/filter(...)` and `$$.push(...)` syntaxes are documented next. Cross-database **reads** through `$$$$.<db>.<coll>.find/filter(...)` are **not supported** (a `{ db, coll }` join/union namespace is rejected by every non-federated MongoDB) — see [Cross-database reads](#cross-database-reads-not-supported). The only cross-database `$$$$` write that *is* supported is the `$$$$.<db>.<coll> = …` `$out` destination ([below](#out-write-the-pipeline-to-a-collection)).

### Cross-collection lookups: `$$$.<coll>.find / .filter`

`$$$.<coll>.find(predicate)` and `$$$.<coll>.filter(predicate)` lower to MongoDB's `$lookup` stage — JS-style spellings for the most common join shape. The two methods follow JS semantics:

| Method      | Returns                  | MQL lowering                                                    |
| ----------- | ------------------------ | --------------------------------------------------------------- |
| `.find(p)`  | one matching doc or null | `$lookup` + `$set { <as>: { $first: "$<as>" } }`               |
| `.filter(p)`| array of matching docs   | bare `$lookup`                                                  |

**Pipeline-mode only.** Lookups produce stages, not expressions — they're only valid where a Pipeline output makes sense (assigned to a field with `$.x = …`, used as the RHS of `let`, or read inline as part of a chained terminal). `jsmql.filter()`, `jsmql.update()`, and `jsmql.expr()` reject lookup syntax with an actionable message naming `jsmql.pipeline()` / `jsmql()` as the right entry point.

**Basic form vs pipeline form.** When the predicate is a single `===` between a foreign field-path (e.g. `o.userId`) and a `$.` local field-path (e.g. `$._id`), jsmql emits the index-friendly basic form (`{ from, localField, foreignField, as }`). Anything richer auto-hoists `$.x` references into the `let` clause and emits the correlated-pipeline form:

```js
// Basic form: pure equality predicate
$.orders = $$$.orders.filter(o => o.userId === $._id);
// → [{ $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "orders" } }]

// .find adds a $set { $first } so the slot holds scalar-or-null
$.user = $$$.users.find(u => u._id === $.userId);
// → [
//     { $lookup: { from: "users", localField: "userId", foreignField: "_id", as: "user" } },
//     { $set: { user: { $first: "$user" } } }
//   ]

// Pipeline form: compound predicate, auto-let hoist
$.user = $$$.users.find(u => u._id === $.userId && u.active);
// → [
//     { $lookup: {
//         from: "users",
//         let: { userId: "$userId" },
//         pipeline: [{ $match: { $expr: { /* u._id === $$userId && u.active */ } } }],
//         as: "user"
//       } },
//     { $set: { user: { $first: "$user" } } }
//   ]
```

**Block-body lambdas — full sub-pipeline.** When the predicate is a block-body arrow (`o => { stmt; stmt; }`), each statement becomes one stage in the `$lookup.pipeline` body. `$match`, `$sort`, `$limit`, `$project`, etc. all work; outer-doc `$.x` references auto-hoist into the lookup's `let` clause:

```js
$.recentOrders = $$$.orders.filter(o => {
  $match(o.userId === $._id);
  $sort({ createdAt: -1 });
  $limit(10);
});
// → [{
//     $lookup: {
//       from: "orders",
//       let: { jsmql_f0__id: "$_id" },
//       pipeline: [
//         { $match: { $expr: { $eq: ["$userId", "$$jsmql_f0__id"] } } },
//         { $sort: { createdAt: -1 } },
//         { $limit: 10 }
//       ],
//       as: "recentOrders"
//     }
//   }]
```

**`.aggregate(pipeline)` — a full sub-pipeline (grouping, top-N, reshaping).** When you need more than "keep matching docs" — a `$group`, a `$sort`+`$limit` top-N, a `$bucket`, a window stage — reach for `.aggregate()`, named after the driver's own `db.coll.aggregate(pipeline)`. It runs an arbitrary sub-pipeline against the foreign collection and lowers to `$lookup`. The argument is a **block-body arrow** `(o) => { $stage(...); ... }` (each statement is a stage — no `return`) or a **stage-array literal** `[{ $stage: ... }, ...]`. Inside, `o.<field>` is the foreign document's field and `$.<field>` is the outer document (auto-hoisted into `let`, exactly as `.filter`):

```js
// Uncorrelated — same result attached to every doc (no $. refs → no `let`)
$.topProducts = $$$.products.aggregate((p) => { $sort({ sales: -1 }); $limit(5); });
// → [{ $lookup: { from: "products", pipeline: [{ $sort: { sales: -1 } }, { $limit: 5 }], as: "topProducts" } }]

// Correlated group-by — per-outer-doc, via the same auto-`let` hoist as `.filter`
$.monthlyTotals = $$$.orders.aggregate((o) => {
  $match(o.userId === $._id);
  $group({ _id: { $month: o.createdAt }, total: $sum(o.amount) });
  $sort({ _id: 1 });
});
// → [{ $lookup: {
//     from: "orders",
//     let: { jsmql_f0__id: "$_id" },
//     pipeline: [
//       { $match: { $expr: { $eq: ["$userId", "$$jsmql_f0__id"] } } },
//       { $group: { _id: { $month: "$createdAt" }, total: { $sum: "$amount" } } },
//       { $sort: { _id: 1 } }
//     ],
//     as: "monthlyTotals" } }]
```

`.aggregate` also **chains after `.filter`** — the filter correlates, the aggregate reshapes:

```js
$.byMonth = $$$.orders.filter(o => o.userId === $._id).aggregate((o) => {
  $group({ _id: { $month: o.createdAt }, total: $sum(o.amount) });
});
```

The same `(element, index, collection)` params as `.filter`/`.map` apply (the index is positional-only; `coll.length` is the sub-stream count). How it differs from a block-body `.filter`: `.aggregate` is the pipeline-oriented spelling (reshape / roll up, and the array-paste form), while `.find`/`.filter` are the element-predicate spellings. Running `.aggregate(...)` on the current stream (`$$.aggregate(...)`) is rejected — just write the stages directly; it only earns its keep against a foreign collection.

**The sub-stream count inside a block (`(o, _i, coll) => …`).** A block-body `.filter` may take a 3rd param naming the **post-filter sub-stream**; `coll.length` is how many documents matched, materialised by a `$setWindowFields` `$count` *inside* the `$lookup.pipeline`. Useful for an in-pipeline guard:

```js
$.orders = $$$.orders.filter((o, _i, coll) => {
  $match(o.userId === $._id);
  assert(coll.length > 0, "User without orders is impossible");
});
```

Only `coll.length` is available (a stream has no array to index/iterate), and the index (2nd) param may be present but never *used* (no per-doc stream index). **Caveat — empty sub-stream:** an in-block `assert(coll.length > 0, …)` runs *inside* the lookup pipeline, so when a user has **zero** matching orders there's no document for it to reject — the result is just `orders: []`, the assert does not fire. To *guarantee* a non-empty result, assert on the materialised array at the outer level instead: `$.orders = $$$.orders.filter(o => o.userId === $._id); assert($.orders.length > 0, "…");`.

**Chained terminals.** A lookup call is a first-class value: chain `.length` / `.reduce(fn, init)` on a `.filter` result, or a `.field` member access on a `.find` result, and jsmql materialises the lookup into an internal `__jsmql.tmp.<N>` slot, emits the chained transform as a follow-up `$set`, and substitutes a FieldRef into the parent expression. The same `__jsmql` cleanup pipeline-scoped `let` uses takes care of the slot at the end:

```js
let nOrders = $$$.orders.filter(o => o.userId === $._id).length;
// → [
//     { $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "__jsmql.tmp.1" } },
//     { $set: { "__jsmql.tmp.1": { $size: "$__jsmql.tmp.1" } } },
//     { $set: { "__jsmql.var.nOrders": "$__jsmql.tmp.1" } },
//     { $unset: "__jsmql" }
//   ]

let total = $$$.tx.filter(t => t.userId === $._id).reduce((acc, t) => acc + t.amount, 0);
// uses $reduce against the materialised slot

let name = $$$.users.find(u => u._id === $.userId).name;
// .find's $first is applied first; the trailing .name reads off the scalar slot
```

A chained terminal (`.length`, `.reduce`, `.map`) requires a preceding `.find/.filter` — a bare `$$$.coll.reduce(...)` would be a Cartesian product over the whole foreign collection and is rejected. `.length` and `.reduce` on a `.find()` result are also rejected with a targeted message — `.find` returns scalar-or-null (after `$set $first`), so array reductions over it aren't meaningful. To count matches, use `.filter(pred).length`; to read a property of the matched doc, chain `.find(pred).<field>`.

**Stream-method chains push into the `$lookup.pipeline` body.** A sequence of registered stream methods (the stream-method vocabulary in [src/stream-methods.ts](../src/stream-methods.ts) — e.g. `.map`, `.toSorted`, `.slice`) chained on a `$$$.<coll>` receiver becomes the `$lookup`'s sub-pipeline. The slot then holds the already-transformed array — no temp-slot reshape stage, and methods without a clean expression-form equivalent (a `.toSorted((a, b) => …)` comparator, `.flatMap` / `$unwind`) lower cleanly.

**Any lodash stream method may *start* the chain — not only `.find` / `.filter` / `.aggregate`.** The whole chain lowers, in source order, into one `$lookup.pipeline`, and a `.filter` / `.reject` may sit at any position (each becomes a `$match`, correlating `$.<field>` into `let` when present). Because stages run in chain order, `.toSorted(k).take(n).filter(p)` sorts and caps *before* filtering — a different result from filter-first, and one no prior spelling could express. A chain with no `$.` correlation emits the lean uncorrelated `$lookup` (no `let`, matching the `.aggregate` shape):

```js
// The 200 most-recent orders (a recency window), then this product's co-purchases.
$.recentCoPurchase = $$$.orders.toSorted({ createdAt: -1 }).take(200).filter(o => o.productIds.includes($._id));
// → { $lookup: { from: "orders", let: { jsmql_f0__id: "$_id" },
//       pipeline: [{ $sort: { createdAt: -1 } }, { $limit: 200 }, { $match: { $expr: /* includes */ } }], as: … } }
```

**Value-collapsing terminals (`.head` / `.first` / `.last` / `.nth` / `.size` / `.every` / `.some` / `.includes` / `.partition`, and the aggregates `.sum` / `.mean` / `.max` / `.min` / `.sumBy` / `.meanBy` / `.minBy` / `.maxBy`) return a *value*, so they're value-position-only.** Like a value-extracting `.map`, they pivot to value-mode over the lookup result — valid in an assignment or binding (`$.first = $$$.orders.filter(o => o.userId === $._id).head()`), and on a **bare** `$$$.<coll>` too (no `.filter` needed — `$$$.orders.head()` means "over all orders"). They are **rejected** as a `$$ = …` stream pivot or a bare statement (a value isn't a stream/stage) — the error points you at the value position, or at `.take(1)` for a one-document stream. (`.keyBy` / `.countBy` / `.groupBy` are **not** in this list: they collapse to a lodash object but *do* have a stream lowering, so they work in both positions — see [Stream methods](#stream-methods-chained-after-the-rhs).)

```js
$.firstOrder = $$$.orders.filter(o => o.userId === $._id).head();  // ok — the first matching order (a doc value)
$.orderCount = $$$.orders.filter(o => o.userId === $._id).size();  // ok — the match count
$$ = $$$.orders.head();   // throws — a value can't be the new stream; use `.take(1)` for a 1-doc stream
$$$.orders.head();        // throws — a bare value isn't a pipeline stage; assign it
```

**A value-extracting `.map` runs value-mode on the result — anywhere in the chain.** A `.map("field")` / `.map(x => <expr>)` (any body but an object literal) does **not** go into the sub-pipeline — a `$replaceWith` there would be invalid MQL whenever the mapped value is a scalar/array (MongoDB requires a document root). Whether it's the *last* method or feeds further methods, it runs as a value-mode `$map` over the lookup result array in the surrounding `$set`. A **block-body** value-extractor (`.map(x => { return <expr>; })`, or with `const`/`let` bindings) behaves identically to the expression form — a stage-less block is just the arrow in disguise (`x => { const y = …; return y; }` → a `$let`). Only a block that contains real sub-pipeline **stages** and returns a non-document is rejected (you can't value-extract through a `$match`/`$sort` reshape):

```js
$.recentOrders = $$$.orders
  .filter({ userId: $._id })
  .toSorted({ placedAt: -1 })
  .take(5)
  .map(o => ({ id: o._id, total: o.total }));
// → [{
//     $lookup: {
//       from: "orders",
//       let: { jsmql_f0__id: "$_id" },
//       pipeline: [
//         { $match: { $expr: { $eq: ["$userId", "$$jsmql_f0__id"] } } },
//         { $sort: { placedAt: -1 } },      // toSorted({ placedAt: -1 })
//         { $limit: 5 },                    // take(5)
//       ],
//       as: "__jsmql.tmp.1",
//     },
//   },
//   // terminal .map → value-mode $map on the result:
//   { $set: { recentOrders: { $map: { input: "$__jsmql.tmp.1", as: "o", in: { id: "$$o._id", total: "$$o.total" } } } } },
//   { $unset: "__jsmql" }]

// Scalar extraction — the case a sub-pipeline $replaceWith can't express:
$.userIds = $$$.orders.filter(o => o.uid === $.id).map("userId");
// → $lookup (pipeline: [$match]) + $set { userIds: { $map: { input, in: "$$…​.userId" } } }

// Mid-chain: the extraction feeds further value methods — the whole tail is value-mode:
$.productIds = $$$.orders.filter(o => o.userId === $._id).map("productIds").flatten().uniq();
// → $lookup (pipeline: [$match]) + $set { productIds: uniq(flatten($map(result, "productIds"))) }
```

The existing `.length` / `.reduce` / member-access terminals continue to take precedence — `.filter(p).map(...).length` still emits `$size` against the materialised (and transformed) slot. An **object-literal-body** `.map(x => ({ … }))` yields a document, so it stays in the sub-pipeline as a `$replaceWith` (a following `.take` etc. lowers to `$limit` there); a **block-body** `.map(x => { … ; return <ret> })` likewise stays in the sub-pipeline. Non-registered chain methods (`.toLowerCase`, `.padStart`, …) fall through to the existing expression-form path unchanged.

**`.map(d => { … ; return <ret> })` — statement-block body.** A stream `.map` may take a statement block ending in `return`, exactly like a block-body `.filter` — same `;`-separated statement vocabulary (`assert(...)`, `$match(...)`, `let`, `<coll>.length`, nested `$$$.<coll>` lookups). The only difference from `.filter` is the trailing `return`: its value becomes each output document (a `$replaceWith`). This is the idiomatic way to validate or reshape with intermediate steps:

```js
$.orders = $$$.orders.filter(o => o.userId === $._id).map(o => {
  assert(o.total > 0, "order total must be positive");
  return { id: o._id, total: o.total };
});
// → the orders $lookup.pipeline gains, after the filter's $match:
//     { $match: { $expr: { $convert: { input: true, to: { $cond: [{ $gt: ["$total", 0] }, "bool", "jsmql assertion failed: order total must be positive"] } } } } },
//     { $replaceWith: { id: "$_id", total: "$total" } }
```

As in an expression-body `.map`, the lambda parameter *is* the current document (`o.total` → `$total`); a `$.<field>` reference is rejected with the "use the lambda parameter" hint, and a block without a `return` is rejected (a `.map` must produce a value).

**Why JS-faithful cardinality for `.find()`?** MongoDB's `$lookup` always returns an array; jsmql adds a `$set { <as>: { $first: "$<as>" } }` so `.find()` matches JS's scalar-or-null contract. The trade-off: one extra in-place `$set` stage. Even when the predicate matches multiple foreign docs, the row count stays stable (vs the `$unwind preserveNullAndEmptyArrays` alternative, which fans rows out).

**Caveats:**
- **Nested lookups work at any depth, in both expression-body and block-body predicates.** A `$$$.coll2.find/filter(...)` inside another lookup's lambda materialises as a prologue `$lookup` stage inside the outer's `$lookup.pipeline`. Refs to the enclosing-foreign param (`o.x`) auto-let into the inner's `$lookup.let` clause. Expression-body example: `$.posts = $$$.posts.filter(p => p.userId === $._id && $$$.tags.filter(t => t.postId === p._id).length > 0)`. Block-body example: `$.users = $$$.users.filter(u => { $match(u.active); $.orders = $$$.orders.filter(o => o.userId === u._id); })`.
  - **Cross-level references resolve correctly at any depth (block-body / statement-block `.map`).** A reference to an *ancestor* scope — the root stream count (`$$.length`), the root doc (`$.field`), an enclosing foreign param (`outer.field`), an ancestor sub-stream count (`outerColl.length`, the 3rd `.map`/`.filter` param), or an outer-pipeline `let`/`const` declared before the lookup — is captured **once** into the `$lookup.let` of the level it belongs to (depth-stamped `jsmql_f<d>_…` for fields, `jsmql_s<d>_…` for counts, `jsmql_v<d>_…` for bindings) and read at every deeper level through MongoDB's `$$`-variable propagation. So one `.map` can read four different "lengths" at once — `$$.length` (root stream count), `$.length` (a root doc field), a `const` derived from it, and `coll.length` (the sub-stream) — each resolving to its own var with no collision, and the value taken from the right document, not the immediate parent. This needs the **correlated** lookup form (`$$ = $$$.<coll>.filter(o => o.x === $.y).map(…)` or `$.field = $$$.<coll>.filter(…)`); a bare `$$ = $$$.<coll>.map(…)` (no filter) is a [`$unionWith` source-switch](#replace-stream-via--expr) that *replaces* the stream, so the outer doc / count / `let` can't be read inside it — only `coll.length` is available there.
- **`$$.find(...)` (self-join on the current collection)** needs collection-name binding from a schema/driver — also planned (see `$$$` schema-threading work).
- **`.find()` multi-match.** `$first` picks the first matching doc; ordering follows MongoDB's storage order. Use the block-body form with `$sort` + `$limit(1)` if you need deterministic single-doc selection.
- **Bracket-index collection name.** The bracket form `$$$[collVar]` accepts a string literal *or* a [`jsmql.compile`](#parameterised-queries-jsmqlcompile) parameter binding — its value is inlined into `$lookup.from` at call time. A runtime field-ref (`$$$[$.dynColl]`) cannot be materialised into the compile-time `from` field and is rejected with the bare-reference error. Non-string bindings (number, array, …) throw a precise "parameter binding must be a string" error.

### Cross-database reads: not supported

A cross-database **read** — naming another database in a `.find` / `.filter` join or in a `$$.push(...)` union — is **rejected at compile time**. Any of these forms throws:

```js
// All of these throw a CodegenError:
$.archivedOrders = $$$$.cold_storage.orders.filter(o => o.userId === $._id);  // cross-db $lookup
$ = $$$$.cold_storage.orders.find(o => o.userId === $._id);                    // replace-root via cross-db $lookup
$$ = $$$$.cold_storage.orders.filter(o => o.active);                           // source-switch via cross-db read
$$.push(...$$$$.archive_db.users.filter(u => u.deleted));                       // cross-db $unionWith
```

The error names the fix:

```
Cross-database reads aren't supported: '$$$$.cold_storage.orders' would emit a
$lookup/$unionWith with a '{ db, coll }' namespace, which a standalone /
replica-set / sharded MongoDB rejects (that shape is Atlas Data Federation only).
Reference a collection in the CURRENT database instead — write '$$$.orders'
(drop the '$$$$.cold_storage.' prefix) …
```

**Why.** A cross-database `.find` / `.filter` would have to compile to `$lookup` (or `$unionWith`) with a `from: { db, coll }` *namespace object*. That object form is **Atlas-Data-Federation-only**: every regular MongoDB deployment (standalone, replica set, sharded cluster) server-validates `$lookup.from` to a bare collection-name *string* and rejects the object at runtime. Per HR3 (jsmql never knowingly emits invalid MQL), we reject these reads at compile time rather than emit a shape that won't run. The rejection lives at the `requireSameDbColl` choke point in [`src/lookup-translation.ts`](../../src/lookup-translation.ts).

**What to write instead.** Reference the collection in the *current* database with same-database `$$$.<coll>` (drop the `$$$$.<db>.` prefix) and run the pipeline against the database that holds the data:

```js
$.archivedOrders = $$$.orders.filter(o => o.userId === $._id);  // ✅ same-db $lookup
```

**Cross-database writes still work.** The one cross-database `$$$$` form that *is* supported is the `$out` destination — `$$$$.<db>.<coll> = $$` lowers to `{ $out: { db, coll } }`, which MongoDB does accept. See [`$out`](#out-write-the-pipeline-to-a-collection). Server/cluster-scoped diagnostics on `$$$$` (`$$$$.currentOp()`, `$$$$.shardedDataDistribution()`, …) are also unaffected — see [System / diagnostic stages](#system--diagnostic-stages-indexstats-currentop-).

### Collection union: `$$.push(...)`

`$$` is the current collection. `.push(...items)` appends those items to the current stream — the JS-faithful name for MongoDB's [`$unionWith`](https://www.mongodb.com/docs/manual/reference/operator/aggregation/unionWith/) stage. **Statement-only**: `$$.push(...)` emits one or more `$unionWith` stages and has no value. It cannot be used on a RHS, in arithmetic, inside a Filter, or anywhere else an expression is read.

The spread (`...`) rule is identical to JavaScript's: arrays must be spread, scalars must not.

```js
// 1. Bare collection — short form.
$$.push(...$$$.archive_users);
// → { $unionWith: "archive_users" }

// 2. .filter(pred) spread — pipeline-form $unionWith.
$$.push(...$$$.archive_users.filter(u => u.active));
// → { $unionWith: { coll: "archive_users", pipeline: [{ $match: { active: true } }] } }

// 3. .find(pred) without spread — single-doc append.
$$.push($$$.archive_users.find(u => u._id === "ABC"));
// → { $unionWith: { coll: "archive_users", pipeline: [{ $match: { _id: "ABC" } }, { $limit: 1 }] } }

// 4. Inline document — lowers to a $documents sub-pipeline.
$$.push({ _id: 1, name: "Alice" });
// → { $unionWith: { pipeline: [{ $documents: [{ _id: 1, name: "Alice" }] }] } }

// 5. Mixed args — source order preserved; consecutive inline docs batch.
$$.push({ a: 1 }, { a: 2 }, ...$$$.archive, { b: 3 });
// → { $unionWith: { pipeline: [{ $documents: [{ a: 1 }, { a: 2 }] }] } },
//   { $unionWith: "archive" },
//   { $unionWith: { pipeline: [{ $documents: [{ b: 3 }] }] } }

// 6. Cross-database union — REJECTED. A '{ db, coll }' $unionWith namespace
//    is Atlas-Data-Federation-only; reference a current-database collection.
$$.push(...$$$$.archive_db.users.filter(u => u.deleted));
// → ❌ CodegenError: Cross-database reads aren't supported … write '$$$.users'
//    (See "Cross-database reads: not supported" above.)

// 7. Block-body filter — full sub-pipeline.
$$.push(...$$$.archive_users.filter(u => {
  $match(u.tier === "gold");
  $sort({ joined: -1 });
  $limit(100);
}));
// → { $unionWith: { coll: "archive_users", pipeline: [
//       { $match: { tier: "gold" } },
//       { $sort: { joined: -1 } },
//       { $limit: 100 },
//     ] } }
```

**Spread rule (JS-faithful):**

| Inside `.push(...)` | Spread `...`? | Why |
|---|---|---|
| `$$$.coll` (bare collection) | yes | conceptually an array of docs |
| `$$$.coll.filter(pred)` | yes | `.filter` returns an array |
| `$$$.coll.find(pred)` | **no** | `.find` returns a single doc; spreading a scalar is a JS TypeError |
| `{ ... }` (inline document) | **no** | scalar — push as one item |

Each rule is enforced at compile time with a targeted error:

- `$$.push($$$.coll.filter(pred))` (forgot the `...`) → "use `...` to merge documents from another collection".
- `$$.push(...$$$.coll.find(pred))` (spurious `...`) → "`.find` returns a single document; drop the `...`".

**`$unionWith` has no `let` slot.** Predicates inside `$$.push(...$$$.coll.filter(pred))` may only reference foreign-document fields. A `$.` reference (`o.userId === $.tenantId`) is a compile-time error pointing you at the fix: move the local filter to a `$match(...)` stage *before* the push.

**Index-friendly inner `$match`.** When the predicate translates to query syntax (the same engine `$match` itself uses), the inner `$match` emits the index-friendly `{ field: value }` form — not a blanket `$expr` wrap — so MongoDB can use indexes on the foreign collection.

**Server version.** The bare `$documents`-only form of `$unionWith` (used for inline docs without a `coll`) requires **MongoDB 6.0+**. Spreads against existing collections work on every server that supports `$unionWith` (4.4+).

**Statement-only.** `$$.push(...)` must appear as a top-level Pipeline statement. `let x = $$.push(...)`, `$.x = $$.push(...)`, or any other read of the result is rejected with the statement-only error. Filter / `jsmql.expr` / `jsmql.update` reject the syntax wholesale — collection union is Pipeline-only.

**Nested.** `$$.push(...)` inside another lookup's block body or inside a sub-pipeline (`$facet.*`, `$lookup.pipeline`, `$unionWith.pipeline`) is rejected with a hoist-to-outer hint — the stages it would emit can't land inside the inner pipeline without changing what gets unioned.

### `assert`: fail the pipeline when an invariant breaks

`assert(condition[, message])` is a guard clause for a pipeline. When `condition`
holds the document passes through unchanged; when it fails the **whole operation
aborts** with a server error carrying your `message`. It's the closest thing to
`throw new Error(...)` that runs purely server-side.

```js
// 1. Guard, then transform. A failing doc aborts the aggregate.
jsmql(({ $ }) => {
  assert($.qty >= 0, "qty must be >= 0");
  $.fee = $.qty * 0.01;
});
// → [
//     { $match: { $expr: { $convert: { input: true,
//         to: { $cond: [{ $gte: ["$qty", 0] }, "bool", "jsmql assertion failed: qty must be >= 0"] } } } } },
//     { $set: { fee: { $multiply: ["$qty", 0.01] } } }
//   ]

// 2. Dynamic message — interpolate a runtime value.
jsmql(({ $ }) => { assert($.qty >= 0, `qty was ${$.qty}`); });

// 3. Message optional (uses a generic default), truthiness is JS-like.
jsmql("assert($.active)");   // 0 / "" / null / missing all fail
```

When the assertion fails, the driver throws `BadValue (2)` with a message ending
`Unknown type name: jsmql assertion failed: qty must be >= 0`. The
`Unknown type name:` prefix is MongoDB boilerplate — your message is the readable
tail. (jsmql can't set a custom error *code*; only the message text.)

**How it works / why no JS.** MongoDB has no native assert/throw operator, and
the one mechanism that carries a custom message — `$function` (server-side JS) —
is deprecated in MongoDB 8.0 and unavailable under the Stable API and on Atlas
Flex/free tiers, so jsmql avoids it. Instead `assert` feeds the (prefixed)
message to `$convert` as a bogus target type; a holding assertion converts a
constant `true`→`bool` (a no-op the surrounding `$match` keeps), a failing one
trips `Unknown type name`. The `jsmql assertion failed:` prefix is required, not
decorative — it stops a message that happens to be a real type name (e.g.
`"int"`) from making the convert *succeed* and silently skipping the check.

**Statement-only.** `assert(...)` must be a top-level Pipeline statement — it has
no value. `$.x = assert(...)`, `cond ? a : assert(...)`, or any other read of the
result is rejected with a hint pointing at the statement form. `jsmql.filter` /
`jsmql.expr` reject it wholesale (it's Pipeline-only); `jsmql.update` rejects it
too, because it lowers to a `$match`, which update pipelines disallow.

### `$$.length`: count the current stream

`$$` is the current stream; `$$.length` is its document count **at the point you
use it** — the JS array-length idiom. It's a value usable anywhere an expression
goes: a field, arithmetic, an `assert` condition, a stage body.

```js
// Annotate every doc with the size of the (filtered) stream.
jsmql(`$match($.status === "active"); $.activeCount = $$.length;`);
// → [
//     { $match: { status: "active" } },
//     { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
//     { $set: { activeCount: "$__jsmql.length" } },
//     { $unset: "__jsmql" }
//   ]

// Reuse is free; the count is RECOMPUTED after a stage that changes it.
jsmql(`$.before = $$.length; $match($.keep); $.after = $$.length;`);
// → before = pre-match count, after = post-match count (two $setWindowFields)

// The conditional-error use — "at most one match":
jsmql(`$match($.email === "me@x.com"); assert($$.length <= 1, "expected ≤ 1 user");`);
```

**How it works.** MongoDB has no inline "stream count" operator, so jsmql
materialises one: a `$setWindowFields` `$count` stamps the count onto every
document (under `__jsmql.length`, cleaned up by the trailing `$unset`), and
`$$.length` reads it back. The materialiser is emitted **once** before the first
use, **reused** while it stays valid, and **recomputed** after any stage that
changes the count or drops the field (`$match`, `$group`, `$unwind`, `$project`,
…). Needs **MongoDB 5.0+** (`$setWindowFields`); it buffers the stream
(100 MB / `allowDiskUse`), like any window/group.

**`$$` is always the ROOT stream — at any nesting depth.** Mirroring `$` (the
root document), `$$` is the top-level stream even when you read `$$.length`
*inside* a `$lookup` sub-pipeline. There jsmql materialises the root count at the
top and passes it into the lookup automatically via `$lookup.let` (as `jsmql_s0_length`),
so it reads back correctly:

```js
// "this user's recent-order count vs the total recent-user count"
jsmql(`$.peers = $$$.users.filter(u => u.orderCount === $$.length);`);
// → [
//     { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
//     { $lookup: { from: "users", let: { jsmql_s0_length: "$__jsmql.length" },
//         pipeline: [{ $match: { $expr: { $eq: ["$orderCount", "$$jsmql_s0_length"] } } }], as: "peers" } },
//     { $unset: "__jsmql" }
//   ]
```

To count an **inner** sub-stream (not the root), use the 3rd callback param —
`$$$.orders.filter(p).map((o, _i, coll) => coll.length)` (see *Cross-collection
lookups* above). `$$.length` = root; `coll.length` = that sub-stream.

**Scope.** Pipeline-only — in a Filter / `jsmql.expr` there is no stream to
count. Inside a top-level `$lookup` (predicate, block body, or `.map` chain)
`$$.length` works via the `$lookup.let` capture above; still **not** supported
inside a `$facet`/`$unionWith` sub-pipeline, a *deeper* nested lookup, or a
reusable function body `[DEF-033]` (compute it at the top level and carry the
value in).

### `$out`: write the pipeline to a collection

Assigning to a context-ref-rooted LHS writes the current pipeline's documents into a destination collection — MongoDB's [`$out`](https://www.mongodb.com/docs/manual/reference/operator/aggregation/out/) stage. The destination is named on the **left** (where the documents go), the (optionally filtered) source on the **right**:

```js
// 1. Same-database write — destination is a bare string.
jsmql("$$$.warehouse_orders = $$;")
// → [{ $out: "warehouse_orders" }]

// 2. Cross-database write — destination is { db, coll }.
jsmql("$$$$.dw.archive = $$;")
// → [{ $out: { db: "dw", coll: "archive" } }]

// 3. Pre-filter inline — $$.filter(<predicate>) on the RHS emits a $match before the $out.
//    Any predicate spelling works, and $$.reject(<predicate>) is its negation.
jsmql("$$$$.dw.archive = $$.filter(u => !u.active);")
// → [{ $match: ... }, { $out: { db: "dw", coll: "archive" } }]
jsmql('$$$$.dw.archive = $$.filter({ status: "expired" });')
// → [{ $match: { status: "expired" } }, { $out: { db: "dw", coll: "archive" } }]

// 4. Bracket form — required for collection names that aren't valid JS identifiers.
jsmql('$$$["my-archive.v2"] = $$;')
// → [{ $out: "my-archive.v2" }]

// 5. Block-body filter — full sub-pipeline lands before the $out.
jsmql("$$$.top10 = $$.filter(o => { $sort({ score: -1 }); $limit(10); });")
// → [{ $sort: { score: -1 } }, { $limit: 10 }, { $out: "top10" }]

// 6. Composes with preceding stages.
jsmql("$.tier = 'gold'; $$$.gold_users = $$;")
// → [{ $set: { tier: "gold" } }, { $out: "gold_users" }]
```

**LHS shapes:**

| Form | Lowers `$out` body to |
|---|---|
| `$$$.<coll> = …` / `$$$["<coll>"] = …` | `"<coll>"` (same database) |
| `$$$$.<db>.<coll> = …` / `$$$$["<db>"]["<coll>"] = …` | `{ db: "<db>", coll: "<coll>" }` (cross-database) |

Bracket and dotted segments mix freely (`$$$$.dw["archive"]` is equivalent to `$$$$["dw"].archive`). Bracket is **required** for non-identifier names (hyphens, dots, leading digits, reserved words). Computed brackets (`$$$[someVar]`) are rejected — the destination must be a literal so it's readable from the source; for parameterised destinations, use `jsmql.compile` and pass the name in as a binding.

**RHS chain:**

| Method | Stage | Notes |
|---|---|---|
| bare `$$` | (none) | Writes the current stream unchanged. |
| `$$.filter(<predicate>)` | `$match` | Same index-friendly translator `$match` uses, and the same predicate spellings as everywhere else. Expression body → query syntax + `$expr` residual; block body → full sub-pipeline. |
| `$$.reject(<predicate>)` | `$match` | `.filter` negated — `$match: { $expr: { $not: … } }`, same as in a `$$ =` chain. |
| `$$.<streamMethod>(…)` | that method's stage(s) | Any chainable stream method (e.g. `.take(n)`, `.toSorted(…)`) — see [Stream methods chained after the RHS](#stream-methods-chained-after-the-rhs) for the vocabulary. |
| `$$.$<stage>(…)` | that stage | A chained stage call (e.g. `$$.$sort({ … })`). A `$out` chain runs at the outer pipeline level, so this is an ordinary top-level stage placed before the write. |

A method in neither form is rejected, and the error names the equivalent stage call as a workaround (`$group({ … }) before the $out`, …).

**`$out` must be the last stage.** Anything after the sugar throws an actionable compile-time error pointing at the offending later statement. Two `$out` statements in one pipeline are rejected via the same guard.

**Pipeline-mode only.** Like `$$.push(...)` and `$$$.<coll>.find(...)`, the `$out` sugar can't appear in Filter (`jsmql.filter`), expression (`jsmql.expr`), or update-pipeline (`jsmql.update`) modes — `$out` writes are a Pipeline-only concept and MongoDB itself rejects them inside `db.coll.updateOne(filter, update)`.

**Why the `$$$.<coll> = …` LHS, not `$ = $out(...)`?** jsmql reserves `$ = …` for *root-replacing* sugar (see [Replace root via `$ = <expr>`](#replace-root-via---expr)). `$out` writes elsewhere — it doesn't replace the current document — so the LHS makes the destination visible on the left, mirroring `$lookup` (`$$$.<coll>.find(...)`) and `$unionWith` (`$$.push(...)`).

---

### System / diagnostic stages: `$$.indexStats()`, `$$$$.currentOp()`, …

A handful of MongoDB stages don't transform the stream — they *produce* it (index metadata, collection stats, running ops, …), so each must be the pipeline's **first** stage. They also differ by *where* they run, and jsmql encodes that scope in the context-ref prefix: call the stage as a method on the ref whose scope matches. There are two tiers — the stages either run on **your collection** (`$$`) or on the **deployment/admin** (`$$$$`); none target the *current* database, so `$$$` carries no diagnostics.

```js
// Collection-scoped — run on db.coll.aggregate().
jsmql("$$.indexStats()");                          // → [{ $indexStats: {} }]
jsmql("$$.collStats({ storageStats: {} })");       // → [{ $collStats: { storageStats: {} } }]
jsmql("$$.planCacheStats()");                      // → [{ $planCacheStats: {} }]
jsmql('$$.listSearchIndexes({ name: "default" })');// → [{ $listSearchIndexes: { name: "default" } }]

// Server / cluster-scoped — run on the admin (or config) database, not the current one.
jsmql("$$$$.currentOp({ allUsers: true })");       // → [{ $currentOp: { allUsers: true } }]
jsmql("$$$$.listSessions({ allUsers: true })");    // → [{ $listSessions: { allUsers: true } }]
jsmql("$$$$.listLocalSessions()");                 // → [{ $listLocalSessions: {} }]
jsmql('$$$$.listSampledQueries({ namespace: "db.coll" })');
jsmql("$$$$.shardedDataDistribution()");           // → [{ $shardedDataDistribution: {} }]

// Compose with following stages like any source:
jsmql("$$.indexStats(); $sort({ accesses: -1 });");
// → [{ $indexStats: {} }, { $sort: { accesses: -1 } }]
```

The method name is the stage name minus the leading `$`; the optional argument is the stage's options object (omit it for an empty `{}`). The two no-option stages — `$$.indexStats()`, `$$.planCacheStats()`, plus `$$$$.shardedDataDistribution()` — take no argument.

| Prefix | Scope | Driver | Stages |
| ------ | ----- | ------ | ------ |
| `$$`   | collection | `db.coll.aggregate()` | `.indexStats()`, `.collStats({…})`, `.planCacheStats()`, `.listSearchIndexes({…})` |
| `$$$`  | database   | —                      | *(none — diagnostics are collection- or server-scoped)* |
| `$$$$` | cluster/server | admin / config DB  | `.currentOp({…})`, `.listSessions({…})`, `.listLocalSessions({…})`, `.listSampledQueries({…})`, `.shardedDataDistribution()` |

Why `$$$$` and not `$$$` for `currentOp` & friends? MongoDB requires them to run on the **admin** database (`$listSessions` reads the cluster-wide `config.system.sessions`) — never your current application database — and they report deployment-wide state. `$$$` means "current database" (the DB `$$$.<coll>.find()` joins into), so `$$$.currentOp()` would read as "ops in *this* database", which you physically can't run. `$$$$` (cluster/server) is the honest home.

Because the prefix *is* the scope, using a stage at the wrong scope is a **compile-time** error that names the right prefix — jsmql catches the classic "ran `$currentOp` against a collection / against the wrong database" mistake before it reaches the driver:

```js
jsmql("$$.currentOp()");
// ❌ 'currentOp' is a cluster-scoped system stage — write '$$$$.currentOp(...)' (the '$$$$' cluster reference, run on the admin database), not '$$'.

jsmql("$$.indexStat()");
// ❌ '$$.indexStat(...)' is not a known diagnostic stage. … Did you mean '$$.indexStats(...)'?

jsmql("$match($.x > 1); $$.indexStats();");
// ❌ '$$.indexStats(...)' produces the pipeline's source documents ($indexStats), so it must be the first stage.
```

**Pipeline-mode only**, like `$$.push(...)` and the lookup/`$out` sugars — these are source stages, not Filter predicates.

> The plain stage forms (`jsmql("[{ $indexStats: {} }]")` and `jsmql("$indexStats({})")`) still work; the `$$`/`$$$`/`$$$$` sugar adds discoverability and scope-checking.

---

## Mistakes caught at compile time

The MongoDB server validates your pipeline before running it and rejects malformed
ones with terse errors. jsmql is a compiler, so it catches these *as you compile* —
you get an actionable message with a position instead of a runtime surprise:

```js
jsmql("[ { $merge: 'archive' }, $sort({ date: -1 }) ]")
// ✗ '$merge' must be the last stage in a pipeline — nothing can run after it.

jsmql("[ $match($.active), { $collStats: {} } ]")
// ✗ '$collStats' must be the first stage in a pipeline — it produces the source documents.

jsmql("[ { $facet: { recent: [ { $out: 'tmp' } ] } } ]")
// ✗ '$out' is not allowed inside a '$facet' sub-pipeline.

jsmql("[ $project({ name: 1, ssn: 0 }) ]")
// ✗ '$project' cannot mix field inclusion ('name: 1') and exclusion ('ssn: 0') —
//   only '_id' may be excluded in an inclusion projection.

jsmql("[ $limit(-5) ]")
// ✗ '$limit' must be a positive integer, but got -5.

jsmql("[ $sort({ x: 1 }), $match({ $text: { $search: 'mongo' } }) ]")
// ✗ A '$match' that uses '$text' must be the first stage in a pipeline.

jsmql.expr("$dateAdd({ startDate: $.t, unit: 'fortnight' })")
// ✗ '$dateAdd' requires the 'amount' field, but it is missing.   (+ unit enum, on the next pass)

jsmql.expr("$dateAdd({ startdate: $.t, unit: 'day', amount: 1 })")
// ✗ '$dateAdd' has no parameter 'startdate'. Did you mean 'startDate'? Valid keys: startDate, unit, amount, timezone.

jsmql.expr("$divide(6, 2, 1)")
// ✗ $divide(dividend, divisor) requires exactly 2 arguments, got 3.

jsmql.expr("$year('2020-01-01')")
// ✗ '$year' expects a date, but got a string. Use a field path or new Date(…).
```

What's checked: stage **placement** (source stages like `$collStats`/`$geoNear`/`$changeStream`
must be first; `$out`/`$merge` must be last; stages forbidden inside `$facet`/`$lookup`/`$unionWith`
sub-pipelines), stage **body shape** (literal type/range/enum/required-key/mutual-exclusivity
rules — e.g. `$count('')`, `$bucket` boundaries out of order, a `$merge` `whenMatched` typo),
`$match` query operators (`$text` placement; `$near`/`$where` bans), and **operator arguments**
(operand count — `$divide` takes 2; required and unknown object keys with a `Did you mean '…'?`;
enum slots — `unit`/`startOfWeek`/`$convert.to`/regex flags; and literal types — a non-date in a
date slot, a non-number in `$abs`, …). Use `jsmql.validate(...)` to get these as a list of
`{ message, pos }` instead of a throw.

**Only certain mistakes throw.** If the offending value is a field reference or expression
jsmql can't evaluate (`$limit($.pageSize)`, `$bucket({ boundaries: $.bounds })`), the MQL is
emitted as-is — jsmql never blocks a query it can't *prove* is wrong. Constraints that depend
on your deployment (sharding, transactions, memory limits, Atlas availability) are also left to
the server.

---

## Operators

### Arithmetic

| Operator | MongoDB | Example |
|---|---|---|
| `+` | `$add` (numeric) or `$concat` (string) | `$.a + $.b` or `$.first + " " + $.last` |
| `-` | `$subtract` | `$.a - $.b` |
| `*` | `$multiply` | `$.a * $.b` |
| `/` | `$divide` | `$.a / $.b` |
| `%` | `$mod` | `$.a % $.b` |
| `**` | `$pow` | `$.base ** 2` |
| `-x` | `$multiply` by -1 | `-$.amount` |

**Operator flattening:** Chained `&&`, `||`, `+`, `*`, and `??` operators are flattened into a single MongoDB array instead of nesting:
```js
$.a + $.b + $.c                // → { $add: ["$a", "$b", "$c"] }
$.x && $.y && $.z              // → { $and: ["$x", "$y", "$z"] }
$.x || $.y || $.z              // → { $or: ["$x", "$y", "$z"] }
$.a ?? $.b ?? $.c              // → { $ifNull: ["$a", "$b", "$c"] }
```

**Context-sensitive `+`:** If any operand is a string literal or string-producing method, the entire chain becomes `$concat`:
```js
$.a + $.b           // → { $add: ["$a", "$b"] }
$.a + " " + $.b     // → { $concat: ["$a", " ", "$b"] }
$.a + ""            // → { $concat: ["$a", ""] }
```

### Comparison

```js
$.status === "active"               // { $eq: ["$status", "active"] }
$.status !== "archived"             // { $ne: ["$status", "archived"] }
$.age > 18                          // { $gt: ["$age", 18] }
$.age >= 21                         // { $gte: ["$age", 21] }
$.score < 50                        // { $lt: ["$score", 50] }
$.score <= 100                      // { $lte: ["$score", 100] }
$.status in ["active", "pending"]   // { $in: ["$status", ["active", "pending"]] }
$.key in { foo: 1, bar: 2 }         // { $in: ["$key", ["foo", "bar"]] }    (property existence)
```

#### `===` / `!==` vs `==` / `!=` — null and missing fields

jsmql tracks the JS distinction between strict and loose equality, mapped to the two natural MongoDB semantics around `null` / missing fields:

- **`===` / `!==`** are JS-like strict equality. Use them for every comparison except null-vs-missing checks.
- **`==` / `!=`** are restricted to comparisons against `null` — the one JS idiom where `==` has a clear, useful meaning (matches null or missing). Any other use is a compile error pointing you at `===`. This eliminates the usual JS `==` footgun (silent type coercion).

| jsmql              | Matches                              | MQL (expression context)                                              | MQL (`$match` body)                          |
| ------------------ | ------------------------------------ | --------------------------------------------------------------------- | -------------------------------------------- |
| `$.x === null`     | only real `null` (excludes missing)  | `{ $eq: ["$x", null] }`                                               | `{ x: { $type: "null" } }`                   |
| `$.x !== null`     | anything except real `null` (incl. missing) | `{ $ne: ["$x", null] }`                                        | `{ x: { $not: { $type: "null" } } }`         |
| `$.x == null`      | null OR missing                      | `{ $in: [{ $type: "$x" }, ["null", "missing"]] }`                     | `{ x: null }`                                |
| `$.x != null`      | neither null nor missing             | `{ $not: [{ $in: [{ $type: "$x" }, ["null", "missing"]] }] }`         | `{ x: { $ne: null } }`                       |
| `$.x === 5`        | `5`                                  | `{ $eq: ["$x", 5] }`                                                  | `{ x: 5 }`                                   |
| `$.x == 5`         | **compile error**                    | —                                                                     | —                                            |

The error for non-null `==`:

> `'=='` is only allowed against null in jsmql. Use `'==='` for JS-like strict equality (no surprising type coercion). To match "null or missing", write `$.x == null`.

`null` may appear on either side: `null == $.x` is identical to `$.x == null`.

**`in` operator semantics:**
- Array on the right → value membership: `$.x in [1, 2, 3]` is true when `$.x` equals 1, 2, or 3. *(JavaScript itself uses index existence here — we deliberately diverge because value membership is what users want for MongoDB queries.)*
- Object literal on the right → property existence (JS-faithful): `$.x in { a, b }` is true when `$.x` equals `"a"` or `"b"`. Computed keys and `...spread` are supported; spread keys are pulled at runtime via `$objectToArray`.
- Field reference on the right → array membership against the field's value (assumes the field holds an array at query time).
- Scalar literal on the right → codegen error (no useful interpretation).

### Logical

```js
$.a > 0 && $.b > 0                  // { $and: [{ $gt: ["$a", 0] }, { $gt: ["$b", 0] }] }
$.a > 0 || $.b > 0                  // { $or:  [{ $gt: ["$a", 0] }, { $gt: ["$b", 0] }] }

// Operand-preserving (returns the operand, like JS) when at least one side
// is not already a boolean:
$.nickname || "anonymous"           // returns $.nickname if truthy, else "anonymous"
$.building && $.building + ","      // includes the suffix only when $.building is truthy

!$.active                           // logical NOT, JS truthy/falsy semantics
```

`&&` and `||` follow JavaScript: they return the operand, not a coerced boolean. When every operand in a chain is already a boolean comparison the codegen emits the cheap `$and` / `$or` form; mixed chains compile to `$cond` so the operand value flows through. See [Truthy and falsy](#truthy-and-falsy) below for the rule used.

### Conditional

```js
$.age >= 18 ? "adult" : "minor"     // { $cond: { if: { $gte: ["$age", 18] }, then: "adult", else: "minor" } }
$.nickname ?? $.name                // { $ifNull: ["$nickname", "$name"] }
```

### Truthy and falsy

`&&`, `||`, `!`, `?:`, `Boolean(x)`, and predicate-method bodies (`.filter`, `.find`, `.findIndex`, `.findLast`, `.findLastIndex`, `.some`, `.every`) all use **JavaScript** truthy/falsy semantics, not MongoDB's. The values treated as falsy are:

| Value | Falsy? |
|---|---|
| `false` | yes |
| `null` | yes |
| missing field | yes |
| `0` | yes |
| `""` (empty string) | yes |
| `NaN` | **no** — see limitation below |
| everything else (`[]`, `{}`, `"0"`, `-1`, dates, …) | truthy |

MongoDB's raw `$toBool` and bare `$cond` use a different rule (e.g. `""` is truthy in MQL). When you need raw MongoDB semantics — for example to match the behaviour of an existing aggregation — call the operator directly: `$toBool($.x)`, `$op($and, …)`. Those escapes are unaffected.

**Known limitation: `NaN` is treated as truthy.** Detecting `NaN` in MongoDB aggregation requires an expensive per-value `$convert` (its `$eq` treats `NaN == NaN` as true, so the cheap `$ne:[x,x]` self-comparison does not work). `NaN` values are vanishingly rare in MongoDB data; the divergence is documented rather than papered over.

### Bitwise

| Operator | MongoDB | Example |
|---|---|---|
| `&` | `$bitAnd` | `$.flags & $.mask` |
| `\|` | `$bitOr` | `$.flags \| 0x10` |
| `^` | `$bitXor` | `$.a ^ $.b` |
| `~` | `$bitNot` | `~$.flags` |

```js
$.flags & $.mask                    // { $bitAnd: ["$flags", "$mask"] }
$.flags & $.mask & 255              // { $bitAnd: ["$flags", "$mask", 255] }   (chains flatten)
$.a | $.b | $.c                     // { $bitOr: ["$a", "$b", "$c"] }
$.a ^ $.b                           // { $bitXor: ["$a", "$b"] }
~$.flags                            // { $bitNot: "$flags" }
```

**Precedence** matches JS: `===` / `!==` (and the null-restricted `==` / `!=`) bind tighter than `&` / `^` / `|`, which bind tighter than `&&` / `||`. So `$.a === $.b & $.c` parses as `($.a === $.b) & $.c`, just like in JavaScript.

**No shift operators.** MongoDB has no `<<` / `>>` / `>>>`; those tokens are not accepted.

---

## String Methods

Call methods on any expression that produces a string:

```js
$.name.trim()                      // { $trim: { input: "$name" } }
$.name.trimStart()                 // { $ltrim: { input: "$name" } }
$.name.trimEnd()                   // { $rtrim: { input: "$name" } }
$.name.toLowerCase()               // { $toLower: "$name" }
$.name.toUpperCase()               // { $toUpper: "$name" }
$.name.substr(1)                   // { $substrCP: ["$name", 1, { $strLenCP: { $ifNull: ["$name", ""] } }] }
$.name.substr(0, 3)                // { $substrCP: ["$name", 0, 3] }
$.name.substring(2, 7)             // { $substrCP: ["$name", 2, 5] }   — end-exclusive folded to length
$.name.substring(1)                // { $substrCP: ["$name", 1, { $max: [0, { $subtract: [{ $strLenCP: { $ifNull: ["$name", ""] } }, 1] }] }] }
"hello".slice(1, 3)                // { $substrCP: ["hello", 1, 2] }   — `.slice` on a string-typed receiver
"hello".slice(-3)                  // { $substrCP: ["hello", 2, 3] }   — negative counts from end (folded: "hello" is 5 long)
$.csv.split(",")                   // { $split: ["$csv", ","] }
$.email.toLowerCase().indexOf("@") // { $indexOfCP: [{ $toLower: "$email" }, "@"] }
$.text.replace("old", "new")       // { $replaceOne: { input: "$text", find: "old", replacement: "new" } }
$.text.replaceAll(" ", "_")        // { $replaceAll: { input: "$text", find: " ", replacement: "_" } }
$.email.toLowerCase().includes("@")// { $gte: [{ $indexOfCP: [{ $toLower: "$email" }, "@"] }, 0] }
$.email.startsWith("admin@")       // { $eq: [{ $indexOfCP: ["$email", "admin@"] }, 0] }
$.file.endsWith(".pdf")            // substring-equality at the tail (see below)
$.name.charAt(0)                   // { $substrCP: ["$name", 0, 1] }
$.first.trim().concat(" ", $.last) // { $concat: [{ $trim: ... }, " ", "$last"] }
$.email.match(/^[a-z]/)            // { $regexMatch: { input: "$email", regex: "^[a-z]" } }
$.text.matchAll(/word/g)           // { $regexFindAll: { input: "$text", regex: "word" } }  — see flag note
$.text.search(/foo/)               // first match index, or -1 (via $regexFind + $ifNull)
$.code.padStart(5, "0")            // padded via $reduce + $range + $concat
$.tier.padStart(9, "US")           // "gold" → "USUSUgold" — a multi-char pad is cut to fit, as in JS
$.note.padEnd(10)                  // (default pad char is space)
"-".repeat($.n)                    // $reduce concatenating "-" n times

// Regex receiver methods — equivalent to .match / .search-style calls
/^[a-z]/.test($.s)                 // { $regexMatch: { input: "$s", regex: "^[a-z]" } }
/word/i.exec($.s)                  // { $regexFind: { input: "$s", regex: "word", options: "i" } }
/word/gi.test($.s)                 // { $regexMatch: { input: "$s", regex: "word", options: "i" } }  — g dropped
```

**`.endsWith()` and out-of-range indices.** MongoDB's `$substrCP` is stricter than JavaScript's
string slicing: a negative start or length makes the server **abort the whole query** instead of
returning a value. That bites exactly where JS is most forgiving — `"a@b.com".endsWith("@example.com")`
is simply `false` in JS, but the tail index `strLen - needleLen` is negative. So jsmql floors every
index it derives, and `.endsWith()` binds its receiver once:

```js
$.file.endsWith(".pdf")
// { $let: { vars: { jsmqlStr: { $ifNull: ["$file", ""] } },
//           in: { $eq: [{ $substrCP: ["$$jsmqlStr",
//                                     { $max: [0, { $subtract: [{ $strLenCP: "$$jsmqlStr" }, 4] }] },
//                                     4] },
//                       ".pdf"] } } }
```

Each method keeps its own JavaScript meaning for a negative index — `.slice()` / `.substr()` count
from the end, `.substring()` clamps to 0, and `.charAt()` returns `""` (it is never floored, since
that would return the *first* character). A start or length past the end of the string is safe and
yields `""`, as in JS.

**A missing field behaves like `""`, never an error.** MongoDB's `$strLenCP` — which every derived
length needs — aborts the query when its input is missing or null, where `$indexOfCP` and `$substrCP`
return `null` / `""`. Left alone, that would make `.endsWith()` take a query down on a document with
no such field while `.startsWith()` on the same field simply returned `false`. So jsmql coerces the
receiver of every length it derives, and the whole string surface agrees: on an absent field
`.length` is `0`, `.padStart(5, "0")` is `"00000"`, `.capitalize()` is `""`, and `.endsWith(…)` is
`false`. (Plain JS would throw a `TypeError` on `undefined` — matching MQL's null-tolerance is the
more useful behaviour over a heterogeneous collection, and matches what the already-safe methods
did.) A *type* mismatch is still an error: an array or number where a string is expected fails the
same way it always has.

Note this makes the emitted length of a **literal** fold at compile time, counting **code points**
the way `$strLenCP` does rather than JS's UTF-16 units — `"a👍b"` is 3, not 4.

**Regex flags.** MongoDB's `$regex*` operators accept only the options `i`, `m`, `s`, `x`. JavaScript-only flags — `g` (global), `u`/`v` (unicode), `y` (sticky), `d` (indices) — have no MongoDB equivalent, so jsmql drops them from the emitted `options` (keeping `i`/`m`/`s`). Dropping `g` is harmless: `$regexFindAll` is inherently global, and `g` is irrelevant to `$regexMatch`/`$regexFind`. `.matchAll()` still *requires* a `/g` regex (matching JS, which throws without it), but the `g` doesn't appear in the output.

#### lodash string methods (ASCII-only)

```js
$.s.capitalize()         // "foo BAR" → "Foo bar"    (upper-first + lower-rest)
$.s.upperFirst()         // "foo" → "Foo"
$.s.lowerFirst()         // "FOO" → "fOO"
$.s.words()              // "fooBarBaz 9" → ["foo", "Bar", "Baz", "9"]  ($regexFindAll)
$.s.camelCase()          // "Foo bar-baz" → "fooBarBaz"
$.s.kebabCase()          // "fooBarBaz" → "foo-bar-baz"
$.s.snakeCase()          // "fooBarBaz" → "foo_bar_baz"
$.s.startCase()          // "foo_bar" → "Foo Bar"
$.s.escape()             // "a<b>&" → "a&lt;b&gt;&amp;"   (&<>"' → HTML entities)
$.s.truncate()           // > 30 chars → first 27 + "..."
$.s.truncate({ length: 24, omission: "…" })
```

**ASCII-only, by design.** `$toUpper`/`$toLower` are ASCII (accented letters pass through unchanged), and word-splitting uses the ASCII pattern `[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[A-Z]|[0-9]+` (splits camelCase boundaries and non-alphanumerics; accented characters act as separators). `truncate`'s word-boundary `separator` option is not supported (MQL has no back-search); `deburr` is omitted (a no-op without Unicode). All verified against a live mongod.

```js
// Property access — DOT access is interpreted, BRACKET access is raw
$.name.trim().length                // { $strLenCP: ... }       — known string → $strLenCP
$.csv.split(",").length             // { $size: ... }           — known array  → $size
$.field.length                      // { $cond: { if: { $isArray: "$field" }, then: { $size: ... }, else: { $strLenCP: ... } } }
                                    //                          — unknown type → runtime dispatch
$.field["length"]                   // { $getField: { field: "length", input: "$field" } }
                                    //   RAW access — a property called "length", NOT the length operator;
                                    //   a string key → $getField (only dot .length is interpreted; see Bracket Access)

// Chaining
$.name.trim().toLowerCase()         // { $toLower: { $trim: { input: "$name" } } }

// On sub-expressions
($.firstName + " " + $.lastName).trim()  // { $trim: { input: { $concat: [...] } } }
```

---

## Array Methods

Call methods on any expression that produces an array.

### Simple Methods

```js
$.items.at(0)              // { $arrayElemAt: ["$items", 0] }
$.items.at(-1)             // { $arrayElemAt: ["$items", -1] }  (last element)
[1, 2, 3].slice(0, 2)      // { $slice: [[1, 2, 3], 2] }          (indices, end-exclusive — like JS)
[1, 2, 3, 4].slice(1, 3)   // { $slice: [[1, 2, 3, 4], 1, 2] }    (index 1 up to 3 → 2 elements)
$.items.slice(1, 3)        // runtime $cond on $isArray — array → $slice, string → $substrCP
                           // (type-aware, like .indexOf / .includes / .concat)
$.items.toReversed()       // { $reverseArray: "$items" }            (ES2023, immutable)
$.scores.toSorted()        // { $sortArray: { input: "$scores", sortBy: 1 } } (ascending)
$.scores.toSorted(s => s.value)
                           // { $sortArray: { input: "$scores", sortBy: { value: 1 } } }
$.scores.toSorted(s => -s.value)
                           // { $sortArray: { input: "$scores", sortBy: { value: -1 } } } (descending)
$.items.with(0, 99)        // immutable index-set — replace element at index, returns new array (ES2023)
$.items.toSpliced(1, 2)    // immutable splice — remove 2 items starting at 1 (ES2023)
$.items.toSpliced(1, 0, "x", "y")
                           // immutable insert — insert items without removing
Array.from({length: 5})    // { $range: [0, 5] }
Array.from({length: 3}, (_, i) => i * 2)
                           // { $map: { input: { $range: [0, 3] }, as: "i", in: <body> } }
[1, 2].concat([3, 4])      // { $concatArrays: [[1, 2], [3, 4]] }   (array-typed)
[1, 2, 3].includes($.x)    // { $in: ["$x", [1, 2, 3]] }            (array-typed)
[1, 2, 3].indexOf($.x)     // { $indexOfArray: [[1, 2, 3], "$x"] }  (array-typed)
$.items.lastIndexOf($.x)   // last index of $.x, or -1 (array-only — strings rejected)
$.tags.join(", ")          // builds a comma-separated string via $reduce/$concat
$.items.toString()         // same as .join(",") for arrays; no-op for strings; $toString otherwise
$.nested.flat()            // flatten one level via $reduce + $concatArrays
$.docs.flatMap(d => d.tags)// $reduce over $map of the lambda
```

**Type-aware dispatch.** `.includes()`, `.indexOf()`, and `.concat()` work on both strings and arrays:

- **Statically known array** (array literal, `.split()`, `.map()`, `.filter()`, `Object.values()`, etc.) → emits the array form (`$in`, `$indexOfArray`, `$concatArrays`).
- **Statically known string** (`.toLowerCase()`, `String(x)`, `+` in string context, template literal, etc.) → emits the string form (`$indexOfCP` / `$concat`).
- **Unknown receiver** (a bare `$.field`, a ternary, etc.) → emits a runtime `$cond` on `$isArray` so the right form runs at query time. The output is more verbose, but works whether the field is a string or an array.

```js
$.tags.includes("active")
// → { $cond: {
//       if: { $isArray: "$tags" },
//       then: { $in: ["active", "$tags"] },
//       else: { $gte: [{ $indexOfCP: ["$tags", "active"] }, 0] }
//     } }
```

If you know the type at design time and want compact output, hint by chaining a type-fixing method first (`$.tags.toLowerCase().includes(...)` for string, `$.tags.slice().includes(...)` for array), or use the explicit `$in`/`$indexOfArray`/`$concatArrays` operator forms.

**`.flat()` depth.** Only `flat()` and `flat(1)` are supported — MongoDB has no recursive flatten primitive, so deeper depths are rejected at compile time.

### Lambda Methods

Array methods that take a function argument use lambda syntax (`x => expr` or `(x) => expr`):

```js
// map — transform each element
$.prices.map(x => x * 1.1)
// → { $map: { input: "$prices", as: "x", in: { $multiply: ["$$x", 1.1] } } }

// filter — keep matching elements
$.items.filter(x => x > 0)
// → { $filter: { input: "$items", as: "x", cond: { $gt: ["$$x", 0] } } }

// find — first matching element
$.items.find(x => x.status === "active")
// → { $arrayElemAt: [{ $filter: { input: "$items", as: "x", cond: { $eq: ["$$x.status", "active"] } } }, 0] }

// findIndex — index of first matching element, or -1
$.items.findIndex(x => x.active)
// → $reduce over [(idx, el), ...] pairs, keeping the first index where the predicate matches

// findLast — last matching element (ES2023)
$.items.findLast(x => x.active)
// → { $arrayElemAt: [{ $filter: { input: "$items", as: "x", cond: "$$x.active" } }, -1] }

// findLastIndex — index of last matching element, or -1 (ES2023)
$.items.findLastIndex(x => x.active)
// → $reduce over [(idx, el), ...] pairs, keeping the last index where the predicate matches

// some — true if any element matches
$.scores.some(x => x >= 90)
// → { $anyElementTrue: { $map: { input: "$scores", as: "x", in: { $gte: ["$$x", 90] } } } }

// every — true if all elements match
$.scores.every(x => x >= 60)
// → { $allElementsTrue: { $map: { input: "$scores", as: "x", in: { $gte: ["$$x", 60] } } } }

// reduce — fold to a single value (2- or 3-param lambda required)
$.numbers.reduce((acc, x) => acc + x, 0)
// → { $reduce: { input: "$numbers", initialValue: 0, in: { $add: ["$$value", "$$this"] } } }

// reduceRight — fold right-to-left
$.numbers.reduceRight((acc, x) => acc + x, 0)
// → same as .reduce but input is wrapped in { $reverseArray: ... }
```

**Note:** In `reduce` and `reduceRight`, the accumulator name is mapped to MongoDB's `$$value`. With a 2-param callback the element rides through `$$this`; with a 3-param callback `(acc, x, i)` the input is zipped with `$range` and both `x` and `i` are bound through a `$let` wrapper.

### Callback parameters `(element, index)`

JavaScript array-method callbacks receive `(element, index, array)`. jsmql supports the first two — `(x)` and `(x, i)` — across `.map`, `.filter`, `.find`, `.findIndex`, `.findLast`, `.findLastIndex`, `.some`, `.every`, `.flatMap`, and `.reduce` / `.reduceRight` (which take a leading `acc`). The third `array` parameter is **rejected at compile time** — the receiver is already in scope at the call site, so re-binding it into every iteration adds no expressive power but doubles the iteration cost.

```js
// Index-aware map: pair each element with its position
$.tags.map((tag, i) => ({ rank: i, tag }))
// → $map over $zip([$range(0, $size), $tags]) with a $let that binds tag/i

// Index-aware filter: drop the first item only
$.items.filter((_, i) => i > 0)

// Index-aware reduce: weight by position
$.scores.reduce((acc, x, i) => acc + x * i, 0)
```

### Mutators: at statement position, they mutate the field

JavaScript's array mutators (`.sort()`, `.reverse()`, `.push()`, `.pop()`, `.shift()`, `.unshift()`, `.splice()`, `.fill()`) modify the receiver in place. In jsmql they work the same way **when called at statement position on a `$.<field>` receiver** — the call lowers to a `$set` stage that re-assigns the field. JS semantics are preserved: `.toSorted()` returns a new array and leaves the field unchanged; `.sort()` mutates the field.

```js
// At statement position — each line desugars to a $set stage.
$.events.sort(e => e.timestamp);
// → { $set: { events: { $sortArray: { input: "$events", sortBy: { timestamp: 1 } } } } }

$.events.push($.newEvent);
// → { $set: { events: { $concatArrays: ["$events", ["$newEvent"]] } } }

$.events.pop();
// → { $set: { events: { $slice: ["$events", { $max: [0, { $subtract: [{ $size: "$events" }, 1] }] }] } } }

$.events.reverse();
// → { $set: { events: { $reverseArray: "$events" } } }
```

Chained mutators on the same field interact with the `$set` coalescer exactly the same way explicit `$.events = …` assignments do — a read-after-write splits into separate stages:

```js
jsmql`
  $.events.push($.newEvent);
  $.events.sort(e => e.timestamp);
  $.events = $.events.slice(-10);
`
// → three $set stages, in order
```

**In expression position, mutators throw.** Calling `.sort()` (or any other mutator) inside an expression — chained, in a `$match` body, as a `$project` value — surfaces a tailored error pointing at both the immutable variant and the statement-position option:

| You wrote in expression position | Use instead |
|---|---|
| `.sort()` | `.toSorted()` (or write `$.field.sort()` at statement position) |
| `.reverse()` | `.toReversed()` (or write `$.field.reverse()` at statement position) |
| `.splice(...)` | `.toSpliced(start, deleteCount, ...items)` |
| `.push(x)` | `.concat(x)` or spread `[...arr, x]` |
| `.pop()` | `.at(-1)` to read, or `.slice(0, -1)` for everything-but-last |
| `.shift()` | `.at(0)` to read, or `.slice(1)` for everything-but-first |
| `.unshift(x)` | `.concat()` with the new items first, or spread `[...newItems, ...arr]` |
| `.fill(v[, s[, e]])` | No direct immutable replacement — call at statement position, or build via `.map` and `$range` |
| `.copyWithin(...)` | No direct immutable replacement — compose `.slice()` calls with `$concatArrays` |

`.forEach()`, `.entries()`, `.keys()`, `.values()`, and `.toLocaleString()` also throw tailored errors explaining why they're not expressible (iterator protocol / void return / locale-dependence) and what to use instead.

#### `Object.assign(target, ...sources)` mutates `target`

`Object.assign` is JavaScript's *mutating* merge: it writes the merged object back into its first argument. At statement position jsmql honours that — the target may be a document field **or** an in-scope `let`/`const` binding:

```js
// Merge into a document field — one $set:
Object.assign($.profile, { verified: true });
// → { $set: { profile: { $mergeObjects: ["$profile", { verified: true }] } } }

// Build up a scratch object across statements:
const result = {};
Object.assign(result, { a: $.foo });
// → { $set: { "__jsmql.var.result": {} } }
//   { $set: { "__jsmql.var.result": { $mergeObjects: ["$__jsmql.var.result", { a: "$foo" }] } } }
```

`Object.assign(result, …)` works even when `result` is `const` — mutating a `const`-bound object is legal JavaScript (only *rebinding* it with `result = …` is not). It's the mutating twin of the value form `result = { ...result, ... }`. In **expression** position `Object.assign(a, b)` is unchanged — it lowers to `$mergeObjects` (see [Object Operations](#object-operations)). The first argument must be a writable target (a `$.field` or an in-scope binding); anything else — `Object.assign({}, …)`, an undeclared name — throws an actionable error.

#### Array sort: `.toSorted(<sort>)` and `.sort(<sort>)`

Both accept a field name, an array of field names, a `{ field: 1 | -1 | "asc" | "desc" }` spec, or a key-function lambda. `.toSorted()` returns a new array; `.sort()` mutates at statement position. The same shapes work everywhere:

```js
$.events.toSorted("distance")             // { $sortArray: { input: "$events", sortBy: { distance: 1 } } }
$.events.toSorted({ distance: -1 })       // descending
$.events.toSorted({ a: "asc", b: "desc" })// multi-key
$.events.toSorted(["a", "b"])             // both ascending
$.events.toSorted(e => e.distance)        // key-function form (nested paths welcome)
$.events.toSorted(e => -e.user.name)      // descending, via unary -
$.events.sort({ distance: -1 });          // statement position → $set with $sortArray
```

Comparator-style lambdas (`(a, b) => a.x - b.x`) and key functions more complex than `x => x.path` (optionally negated) are rejected at compile time — use a `{ field: dir }` spec, or `$op($sortArray, { input, sortBy })` for a non-trivial sort.

#### lodash iteratee / predicate shorthands

Every higher-order value method — the native JS ones (`.map` / `.filter` / `.find` / `.findIndex` / `.findLast` / `.some` / `.every` / `.flatMap`) **and** the lodash ones (`.sumBy` / `.uniqBy` / `.groupBy` / `.reject` / `.takeWhile` / `.differenceBy` / …) — accepts the same lodash iteratee/predicate vocabulary, each desugaring to exactly what the equivalent one-parameter arrow would emit:

| shorthand | example | equivalent arrow |
|---|---|---|
| property string (dotted paths ok) | `.map("addr.city")` | `x => x.addr.city` |
| `_.matches` object | `.filter({ role: "admin", active: true })` | `x => x.role === "admin" && x.active === true` |
| `_.matchesProperty` pair | `.find(["status.code", 200])` | `x => x.status.code === 200` |
| single-parameter arrow | `.map(x => x.total * 1.1)` | — |
| omitted (identity) | `.uniq()` | `x => x` |

An iteratee context reads the result as a value (`.map("name")` plucks the field); a predicate context reads it as a boolean (`.filter("active")` keeps the truthy ones). The `_.matches` object compares each key with `$eq` (flat equality, not lodash's deep partial match); a single key emits a bare `$eq`, multiple keys an `$and`.

#### lodash array methods

Value-mode methods on an array field (iteratee/predicate args take any of the shorthands above).

```js
$.nums.sum()  / .mean() / .max() / .min()   // $sum / $avg / $max / $min of the array
$.items.sumBy("price")  / .meanBy(x => x.p) // $sum / $avg of the mapped values
$.items.minBy("score")  / .maxBy("score")   // the element with the min/max key
$.items.sortBy("age") / .sortBy(x => x.age) // ascending sort by a key (alias of .toSorted)
$.items.orderBy(["age", "name"], ["desc", "asc"])  // multi-key sort (parallel keys + directions)
$.items.orderBy({ age: -1, name: 1 })              // …or a { field: dir } object (directions inline)
$.tags.uniq()                               // order-preserving keep-first dedupe
$.items.uniqBy("id")                        // dedupe by key, keep first
$.items.keyBy("id")                         // { <id>: <last item with that id> }
$.items.groupBy("type")                     // { <type>: [items…] }
$.items.countBy("type")                     // { <type>: <count> }
$.nums.countBy()                            // omit the iteratee → count by the element itself: [1,2,2] → { "1": 1, "2": 2 } (also .groupBy() / .keyBy())
$.items.partition(x => x.ok)                // [ [matches…], [non-matches…] ]
$.items.reject({ active: false })           // items NOT matching
$.xs.chunk(3)                               // [[…3], […3], [rest]]   (size: positive int literal)
$.xs.flatten()                              // one level (with an $isArray guard)
$.xs.compact()                              // drop MQL-falsy (false/null/0/missing; keeps ""/NaN)
$.a.difference($.b) / .intersection($.b) / .union($.b)   // order-preserving set ops
$.a.without(2, 4)                           // exclude the given values (variadic)
$.a.xor($.b)                                // symmetric difference (chain .xor(c) for more)
$.a.differenceBy($.b, "id")                 // set ops compared BY an iteratee key…
$.a.intersectionBy($.b, x => x.id) / .unionBy($.b, "id") / .xorBy($.b, "id")
$.a.sortedUniq() / .sortedUniqBy("id")      // aliases of uniq / uniqBy (no sorted-only optimisation in MQL)
$.keys.zipObject($.vals)                    // { keys[i]: vals[i] }
$.a.zip($.b, $.c)                           // [[a0,b0,c0], …]   (groups run to the longest; short arrays pad with null)
$.a.zipWith($.b, (x, y) => x + y)           // [x0+y0, x1+y1, …] (N-param arrow, one per array)
$.tuples.unzip()                            // inverse of zip — transpose an array of equal-length tuples
$.a.takeWhile(x => x < 3) / .dropWhile(p)   // from the START, up to / from the first falsy element
$.a.takeRightWhile(p) / .dropRightWhile(p)  // same, scanning from the END
$.a.sample()                                // one random element ($rand)
$.a.sampleSize(3)                           // 3 random elements, without replacement
```

> Predicate-run methods take an arrow (`x => …`) or a `_.matches` object (`{ active: true }`), stopping at the first element the predicate rejects (MQL truthiness, as in `.filter`). The `*RightWhile` pair scans the reversed array and reverses the result back. `sample`/`sampleSize` use `$rand`, so they return a **different result on every run** (non-deterministic, like the stream `.sample()` → `$sample`); `sampleSize` draws **without replacement** and returns the whole (shuffled) array when `n` exceeds the length.

> **Footguns.** `keyBy`/`groupBy`/`countBy` **stringify** the key (`$toString` — matching lodash); a missing/null key coerces to the string `"null"`, but an object/array key still *errors*. Group order is unspecified; `groupBy`/`countBy` are O(n²). `.sum`/`.mean`/… ignore non-numeric elements (MQL `$sum`/`$avg` semantics). Set ops are order-preserving `$filter`/dedupe forms (not `$setDifference`, which reorders). All shapes were verified against a live mongod.

> **Chaining that can't type-check is rejected.** When a method is chained on a receiver whose type is provably wrong for it, jsmql throws at compile time instead of emitting MQL the server would reject — e.g. `.every(p).map(f)` (a boolean has no methods), `s.toUpperCase().map(f)` (a string isn't an array), `a.countBy("t").take(3)` (an object isn't an array), and, over a lookup, `$$$.orders.find(p).take(5)` (`.find` returns one document). The check only fires when the receiver type is **100% certain**: an element of unknown type (`arr.find(p).map(f)` — the element could itself be an array) or a result whose type depends on its arguments (`n.clamp(a, b)`) still compiles.

#### lodash positional / slicing methods

Element and sub-array accessors on an array field:

```js
$.xs.take(3)      / .drop(3)                 // first 3 / all but the first 3   (n defaults to 1)
$.xs.takeRight(3) / .dropRight(3)            // last 3  / all but the last 3
$.xs.head()  / .first()                      // first element  ($first)
$.xs.last()                                  // last element   ($last)
$.xs.tail()  / .initial()                    // all but the first / all but the last element
$.xs.nth(2)  / .nth(-1)                       // element at index 2 / from the end   (n defaults to 0)
$.xs.size()                                  // element count (array) or key count (object) — strings use .length
```

> `take`/`drop`/`takeRight`/`dropRight` reject a **negative** count (the message points at the opposite-end method). `n` past the array length is fine — you get the whole array or an empty one, matching lodash. `head`/`first`/`last` on an empty array yield `null` (MongoDB's missing-value).

### Bare type-cast callbacks

`Boolean`, `Number`, and `String` can be passed bare as the callback to any of the lambda-taking array methods, just like in plain JavaScript:

```js
$.items.filter(Boolean)         // drop JS-falsy values (null, "", 0, false, missing)
// → $filter whose `cond` checks each element for JS truthiness
// (see "Truthy and falsy" above)

$.scores.map(Number)            // coerce strings to numbers
// → { $map: { input: "$scores", as: "v", in: { $toDouble: "$$v" } } }

[$.first, $.middle, $.last].filter(Boolean).join(" ")
// composed display name, skipping missing parts
```

This is sugar for `x => Boolean(x)` / `x => Number(x)` / `x => String(x)`. Outside of a callback position the bare form errors at compile time — write `Boolean(x)` etc. to coerce a single value.

**`parseInt` / `parseFloat` are intentionally not allowed bare.** In real JS, `['1', '2', '3'].map(parseInt)` returns `[1, NaN, NaN]` because `parseInt` receives the array index as its second (radix) argument. Rather than replicate the footgun, jsmql requires the call form: write `x => parseInt(x)` or `x => parseFloat(x)`.

### Set methods (ES2025)

Wrap arrays in `new Set(...)` to use the ES2025 set-algebra methods. The wrapper is a JS-syntax tag — MQL has no Set type, so the underlying arrays go straight into the operator.

```js
new Set($.a).intersection(new Set($.b))   // { $setIntersection: ["$a", "$b"] }
new Set($.a).union(new Set($.b))          // { $setUnion: ["$a", "$b"] }
new Set($.a).difference(new Set($.b))     // { $setDifference: ["$a", "$b"] }
new Set($.a).isSubsetOf(new Set($.b))     // { $setIsSubset: ["$a", "$b"] }
new Set($.a).isSupersetOf(new Set($.b))   // { $setIsSubset: ["$b", "$a"] }   (swap)
```

`Set.prototype.symmetricDifference()` and `.isDisjointFrom()` have no MongoDB equivalent — compose manually via `$setDifference` and `$setIntersection`. The set-method argument must itself be a `new Set(...)` literal so that the JS reads consistently.

Need `$allElementsTrue` / `$anyElementTrue`? Use the natural JS forms `arr.every(Boolean)` / `arr.some(Boolean)`.

### `Object.groupBy()` (ES2024)

```js
Object.groupBy($.items, x => x.category)
// → $reduce that accumulates an object keyed by the discriminator
```

The discriminator must be a single-parameter arrow function. Non-string discriminators are wrapped in `$toString` automatically (matching JS, where the key is coerced to a string property name). `Map.groupBy()` is not supported — MQL has no Map type.

### lodash object methods

Value-mode methods on an object field (built over `$objectToArray` / `$arrayToObject`). The `mapValues` / `mapKeys` / `pickBy` / `omitBy` iteratee is a `(value[, key]) => …` arrow.

```js
$.scores.mapValues(v => v * 2)        // { <k>: v*2 }
$.o.mapKeys((v, k) => k.toUpperCase())// rename keys
$.user.pick(["name", "age"])          // keep only those keys (missing keys drop out)
$.user.omit(["password"])             // all keys except those
$.o.pickBy(v => v != null)            // keep entries whose value passes
$.o.omitBy((v, k) => k.startsWith("_"))// drop entries whose (value, key) passes
$.o.invert()                          // swap keys/values (new keys stringified, last wins)
$.o.toPairs()                         // [[k, v], …]
$.pairs.fromPairs()                   // { pairs[i][0]: pairs[i][1] }   (receiver is a [[k,v]] array)
```

> `pick` uses flat field names only (deep paths like `"a.b"` aren't supported — use `$op($getField, …)`). `mapKeys`/`invert` **stringify** the produced key (`$toString`; last wins on collision), like lodash. All verified against a live mongod.

---

## Lambda Functions

Lambdas are used with array methods. Two forms are supported:

```js
// Single parameter (no parentheses required)
x => x * 2
item => item.price > 0

// Single parameter (with parentheses)
(x) => x * 2

// Two parameters (parentheses required, for reduce)
(acc, x) => acc + x
(total, item) => total + item.price
```

Lambda parameters shadow outer field references within their scope:

```js
$.items.map(price => price * $.taxRate)
// price refers to the loop variable; $.taxRate refers to the document field
```

### Block bodies with local `const` (→ `$let`)

A lambda can have a **block body** that declares local `const` / `let` bindings and ends with a `return`. Each binding becomes a MongoDB `$let` variable, so you can name intermediate values and reuse them — just like in JavaScript:

```js
$.legs.map(leg => {
  const score = leg.riskScore;
  const band = score > 50 ? "high" : "low";
  return { id: leg.id, score, band };
})
// → { $map: { input: "$legs", as: "leg", in:
//      { $let: { vars: { score: "$$leg.riskScore" }, in:
//        { $let: { vars: { band: { $cond: [{ $gt: ["$$score", 50] }, "high", "low"] } }, in:
//          { id: "$$leg.id", score: "$$score", band: "$$band" } } } } } } }
```

Bindings are nested in source order, so a later `const` can read an earlier one (`band` reads `score` above). This works in `.map`, `.filter`, `.reduce`, `.flatMap`, `.find`/`.some`/`.every`, the `$let(vars, fn)` form, IIFEs, `Object.groupBy`, and `Array.from`.

> **⚠️ JavaScript gotcha — `=> {` is always a block.** Exactly as in JavaScript, `x => { … }` opens a *statement block*, not an object. To return an object, wrap it in parentheses: `x => ({ a: 1 })`. Writing `x => { a: 1 }` is an error (it has no `return`) — jsmql points you at the parenthesised form. A block body must be `{ (const|let … ;)* return <expr>; }`.

### Immediately-invoked arrow functions (IIFE → `$let`)

A call expression whose callee is an arrow-function literal compiles to MongoDB's `$let`. This is the JS-natural way to bind a name and avoid recomputing a sub-expression:

```js
((maxAge, minAge) => $.age >= minAge && $.age <= maxAge)(65, 18)
// → { $let: {
//       vars: { maxAge: 65, minAge: 18 },
//       in: { $and: [{ $gte: ["$age", "$$minAge"] }, { $lte: ["$age", "$$maxAge"] }] }
//     } }

((d) => $.price - d)($.price * 0.1)
// → { $let: { vars: { d: { $multiply: ["$price", 0.1] } }, in: { $subtract: ["$price", "$$d"] } } }
```

Either single-param paren style works: `(x => body)(arg)` and `((x) => body)(arg)` produce identical MQL. Param destructuring, default values, and rest parameters are not supported — drop into `$let({ vars }, (x) => body)` for those cases.

The body of the IIFE can reference outer `$.fields` freely; only the lambda parameters are rebound.

### Reusable functions

Inside a pipeline you can give an arrow function a **name** (`const f = (a) => …`) and call it by that name — a named IIFE. The declaration itself emits nothing; each call expands the body inline as its own `$let`, so a helper declared once can be reused across many fields without storing anything in the document:

```js
const money = (n) => Math.round(n * 100) / 100;
$ = {
  subtotal: money($.price * $.qty),
  tax:      money($.price * $.qty * $.taxRate),
  total:    money($.price * $.qty * (1 + $.taxRate)),
};
// → [{ $replaceWith: {
//       subtotal: { $let: { vars: { n: { $multiply: ["$price", "$qty"] } },
//                           in: { $divide: [{ $round: [{ $multiply: ["$$n", 100] }, 0] }, 100] } } },
//       tax:      { $let: { vars: { n: { $multiply: ["$price", "$qty", "$taxRate"] } }, in: { …same… } } },
//       total:    { $let: { vars: { n: { $multiply: ["$price", "$qty", { $add: [1, "$taxRate"] }] } }, in: { …same… } } },
//   } }]
```

A real-world example — a formatter declared once, reused for sender and recipient:

```js
const addressToString = (a) => {
  return [a.building && a.building + ",", a.streetNo, a.street, a.suburb, a.state, a.country, a.postcode]
    .filter(Boolean)
    .join(" ");
};
$ = {
  senderAddress:    addressToString($.sender.address),
  recipientAddress: addressToString($.recipient.address),
};
```

The **`function` keyword** is a second spelling of the same thing — write it however you'd write JavaScript. It works everywhere an arrow does: as a declaration, as an inline callback, and as the `jsmql(fn)` input. A `function` declaration is *self-terminating* (no `;` needed after the `}`, exactly like JS):

```js
function money(n) { return Math.round(n * 100) / 100 }
$ = { subtotal: money($.price), tax: money($.tax) };
// …identical MQL to `const money = (n) => …`

$.items.map(function (x) { return x * 1.1 })   // inline callback — same as `(x) => x * 1.1`
jsmql(function ({ $ }) { return $.age >= 18 })  // entry form — same as `({ $ }) => $.age >= 18`
```

A named function *expression* (`.map(function scale(x) { … })`) is accepted, but the name is ignored — MQL has no recursion, so the name is unreachable. `async function` and generator `function*` are rejected with a pointer to the plain form.

Notes:

- **Both `=>` styles, the `function` keyword, and a block body work** — `x => …`, `(x) => …`, `(x) => { const t = …; return …; }`, and `function f(x) { return …; }`. A block body uses the same local-`const` rules described above.
- **Bodies can close over the document.** Beyond their parameters, a function body may read `$.fields` and in-scope `let` bindings.
- **Functions compose** — one function may call another declared earlier in the same pipeline.
- **Pipeline-only.** A function is a pipeline statement, exactly like [`let`](#local-bindings-let). An arrow declaration needs the `;` that puts the source in pipeline mode; a `function` declaration is self-terminating and triggers pipeline mode on its own. Declare functions at the top level of the pipeline, not inside an arrow body.
- **Re-lowered per call.** Calling a function twice produces two independent `$let` blocks — there's no shared definition stored anywhere, and a declared-but-uncalled function adds nothing to the output.
- Calling an undeclared name, the wrong argument count, recursion, or using a function as a value (rather than calling it) each produce an actionable error.

---

## Math Functions

Use `Math.*` for numeric operations:

```js
Math.abs($.delta)                  // { $abs: "$delta" }
Math.ceil($.avg)                   // { $ceil: "$avg" }
Math.floor($.avg)                  // { $floor: "$avg" }
Math.round($.avg)                  // { $round: ["$avg", 0] }
Math.pow($.base, 2)                // { $pow: ["$base", 2] }
Math.sqrt($.variance)              // { $sqrt: "$variance" }
Math.exp($.rate)                   // { $exp: "$rate" }
Math.log($.value)                  // { $ln: "$value" } (natural log)
Math.log2($.value)                 // { $log: ["$value", 2] }
Math.log10($.value)                // { $log10: "$value" }
Math.trunc($.avg)                  // { $trunc: "$avg" }
Math.sign($.delta)                 // { $cmp: ["$delta", 0] } (-1 / 0 / 1)
Math.cbrt($.x)                     // { $pow: ["$x", { $divide: [1, 3] }] }
Math.hypot($.a, $.b)               // sqrt(a² + b²) via $sqrt + $add + $pow
Math.random()                      // { $rand: {} }

Math.min($.a, $.b, $.c)            // { $min: ["$a", "$b", "$c"] }
Math.max($.scores)                 // { $max: "$scores" }   (single array arg)
Math.max(...$.scores)              // { $max: "$scores" }   (spread is sugar for the above)
Math.min($.a, ...$.others)         // { $min: { $concatArrays: [["$a"], "$others"] } }
```

### Trigonometry

All angles are in radians (matches both JS and MongoDB).

```js
Math.sin($.angle)                  // { $sin: "$angle" }
Math.cos($.angle)                  // { $cos: "$angle" }
Math.tan($.angle)                  // { $tan: "$angle" }
Math.asin($.x)                     // { $asin: "$x" }
Math.acos($.x)                     // { $acos: "$x" }
Math.atan($.x)                     // { $atan: "$x" }
Math.atan2($.y, $.x)               // { $atan2: ["$y", "$x"] }
Math.sinh($.x)                     // { $sinh: "$x" }
Math.cosh($.x)                     // { $cosh: "$x" }
Math.tanh($.x)                     // { $tanh: "$x" }
Math.asinh($.x)                    // { $asinh: "$x" }
Math.acosh($.x)                    // { $acosh: "$x" }
Math.atanh($.x)                    // { $atanh: "$x" }
```

For degree/radian conversion (no JS equivalent), drop into the escape hatch:
```js
$degreesToRadians($.degAngle)      // { $degreesToRadians: "$degAngle" }
$radiansToDegrees($.radAngle)      // { $radiansToDegrees: "$radAngle" }
```

### Constants

```js
Math.PI                            // 3.141592653589793
Math.E                             // 2.718281828459045
```

**Note:** `Math.round(x)` rounds to the nearest integer (`{ $round: [x, 0] }`). For rounding to N decimal places, drop into the `$round()` escape hatch — there is no JS equivalent:
```js
$round($.value, 2)                 // { $round: ["$value", 2] } (round to 2 decimal places)
```

**Note:** `Math.log()` is the natural logarithm. For arbitrary base, drop into the `$log()` escape hatch:
```js
$log($.value, 10)                  // { $log: ["$value", 10] } (log base 10)
```

---

## Type Casting

### JavaScript-Style Casting

```js
Number($.stringField)              // { $toDouble: "$stringField" }
String($.numField)                 // { $toString: "$numField" }
Boolean($.value)                   // JS-truthy check — see "Truthy and falsy"
parseInt($.stringField)            // { $toInt: "$stringField" }
parseFloat($.stringField)          // { $toDouble: "$stringField" }
```

`Boolean(x)` follows JavaScript's truthy/falsy rules — `Boolean("")` is `false`, `Boolean(0)` is `false`, `Boolean([])` is `true`. To get MongoDB's raw `$toBool` (where `""` is truthy and `null` propagates as `null`), call the operator directly: `$toBool($.x)`.

### `typeof` Operator

```js
typeof $.field                     // { $type: "$field" }
typeof $.age === "number"          // { $eq: [{ $type: "$age" }, "number"] }
```

Returns the BSON type name as a string (e.g. `"double"`, `"string"`, `"bool"`, `"objectId"`, `"date"`, `"null"`, `"array"`, `"object"`).

### Number static predicates

```js
Number.isInteger($.n)              // true if $.n is int/long, or a double with no fractional part
Number.isNaN($.x)                  // { $ne: ["$x", "$x"] }   — NaN is the only value where x !== x
```

`Number.isFinite()` is **not supported** — MongoDB has no Infinity literal that can be referenced cleanly. For finite-bound checks, write the bounds explicitly (e.g. `$.x > -1e300 && $.x < 1e300`) or use `$convert` with an `onError` clause.

### lodash number methods

Value-mode methods on a number field (per-doc, not stream methods):

```js
$.n.clamp(0, 100)      // { $min: [{ $max: ["$n", 0] }, 100] }
$.n.inRange(10)        // 0 <= n < 10   (checked with $min/$max so negative ranges swap)
$.n.inRange(5, 10)     // 5 <= n < 10
$.n.round()            // { $round: ["$n", 0] }   — MongoDB $round is half-to-EVEN (banker's), so round(2.5) === 2
$.n.round(2)           // { $round: ["$n", 2] }
$.n.ceil()             // { $ceil: "$n" }
$.n.ceil(2)            // scale by 10² via $pow, $ceil, scale back
$.n.floor(1)           // as ceil, with $floor
```

> `round` uses MongoDB's `$round`, which rounds half-to-even — this **differs from lodash** (`_.round(2.5) === 3`). It's kept deliberately so jsmql emits the native operator rather than an emulation.

### MongoDB Type Conversion Utilities

```js
$toObjectId($.idString)            // { $toObjectId: "$idString" }
$toDate($.timestamp)               // { $toDate: "$timestamp" }
$toLong($.value)                   // { $toLong: "$value" }
$toDecimal($.value)                // { $toDecimal: "$value" }
```

For controlled conversion with a fallback on error, use `$convert()`:

```js
$convert($.field, "int")                // { $convert: { input: "$field", to: "int" } }
$convert($.field, "int", 0)             // { $convert: { input: "$field", to: "int", onError: 0 } }
$convert($.field, "int", 0, null)       // { $convert: { input: "$field", to: "int", onError: 0, onNull: null } }
```

Valid target types: `"double"`, `"string"`, `"objectId"`, `"bool"`, `"date"`, `"int"`, `"long"`, `"decimal"`.

### ObjectId literals

Write a constant `_id` three ways — they all produce the same live BSON ObjectId:

```js
$._id === 0x507f1f77bcf86cd799439011        // leanest: type `0x`, paste the 24-char id
$._id === ObjectId("507f1f77bcf86cd799439011")
$._id === new ObjectId("507f1f77bcf86cd799439011")
// all → { _id: ObjectId("507f1f77bcf86cd799439011") }

[0x507f1f77bcf86cd799439011, 0x698a76556c10b90d8bd0497e].includes($._id)
// { _id: { $in: [ObjectId("507f…"), ObjectId("698a…")] } }
```

The **`0x` hex form** is the most ergonomic — no quotes, no wrapper, just paste a 24-character hex `_id` after `0x` (numeric separators like `0x507f_1f77_…` are allowed). A `0x` literal with **exactly 24 hex digits** is an ObjectId; a shorter one is an ordinary integer (`0xff` → `255`); a longer-than-safe-integer, non-24-digit hex is rejected.

jsmql emits a real BSON `ObjectId` value, which is the only thing the MongoDB driver accepts in a query document — so the equality is index-friendly with no `$expr` wrapper. (A hand-written Extended JSON envelope is **not** equivalent: the driver passes it to the server verbatim, which the server rejects as an unknown operator.) The string passed to `ObjectId("…")` is validated as 24 hex chars at compile time, so a typo is caught early.

**Typo guard.** An ObjectId's first 4 bytes are a creation timestamp, and MongoDB didn't exist before 2009 — so jsmql rejects any ObjectId whose timestamp predates that (the smallest accepted id is `0x4a000000…`, 2009‑05‑05). This catches the common slips: an all‑zeros id, a sequential placeholder like `0x1234…`, or a dropped leading digit. The error names the decoded date so you can see what you actually typed.

Two more forms handle the non-constant cases:

```js
$.userId = ObjectId($.idString)    // dynamic value → { $toObjectId: "$idString" } (server-side convert)
$.newId  = ObjectId()              // no argument   → { $createObjectId: {} } (server-side fresh id)
```

For an id you only have **at runtime**, pass a real ObjectId via the template tag or a `jsmql.compile` parameter rather than baking a string into the source:

```js
jsmql`$._id === ${someObjectId}`              // interpolate a live ObjectId instance
jsmql.compile(({ id }) => $._id === id)       // then call with { id: someObjectId }
```

> Note: the value jsmql constructs is hard-coded to the BSON major version jsmql's supported driver ships (currently bson 7). It serializes byte-for-byte identically to a driver `ObjectId`; if your app pins a *different* bson major, prefer interpolating your driver's own ObjectId instance.

---

## Date Operations

### Date Constructor and `Date.now()`

```js
// Constant arguments → a real BSON Date, folded at compile time (see note below):
new Date("2024-01-01")             // Date(2024-01-01T00:00:00Z)
new Date(2024, 0, 15)              // Date(2024-01-15T00:00:00Z)   (UTC)
new Date(2024, 11, 31, 23, 59, 58, 999)
                                   // Date(2024-12-31T23:59:58.999Z) — full y/m/d/h/min/s/ms form
new Date(Date.UTC(2024, 0, 15))    // Date(2024-01-15T00:00:00Z)

// Runtime arguments → the aggregation form (value isn't known until query time):
new Date()                         // { $toDate: "$$NOW" }  (current date/time)
new Date($.dateString)             // { $toDate: "$dateString" }
new Date($.y, $.m, $.d)            // { $dateFromParts: { year: "$y", month: { $add: ["$m", 1] }, day: "$d" } }

Date.now()                         // { $toLong: "$$NOW" }  (ms since epoch, like JS)
Date.UTC(2024, 0, 15)              // { $toLong: { $dateFromParts: { year: 2024, month: 1, day: 15, timezone: "UTC" } } }
```

**Constant folding.** When every argument to `new Date(...)` is a compile-time literal, jsmql evaluates the constructor and emits a real BSON `Date`, **not** the aggregation `{ $toDate }` / `$dateFromParts` form. This matters because a `Date` is the only shape that works in *both* an aggregation expression *and* a query document: `{ field: { $gte: { $toDate: "..." } } }` does **not** match in a Filter / `$match` — MongoDB's query language reads `{ $toDate: ... }` as a literal subdocument, never matching anything. Only genuinely runtime forms (`new Date()`, `new Date($.field)`) keep the aggregation form. If the constant arguments don't form a valid date (`new Date("not-a-date")`), jsmql rejects it at compile time rather than emit MQL the server would refuse.

**Note:** JS's multi-arg `new Date(y, m, d, …)` is interpreted in the runtime's *local time*; jsmql interprets it as **UTC** (MQL's `$dateFromParts` default / `Date.UTC` for the constant fold), since "local time" on a MongoDB server is rarely what a query author wants. Use `Date.UTC(...)` or `new Date(Date.UTC(...))` when the UTC semantics matter explicitly. JS month indices stay 0-based on the input side — jsmql folds the `+1` adjustment for you.

### Date Getter Methods

Call on any expression that produces a date:

```js
$.createdAt.getFullYear()          // { $year: "$createdAt" }
$.createdAt.getMonth()             // { $subtract: [{ $month: "$createdAt" }, 1] }  (0-indexed, JS-compatible)
$.createdAt.getDate()              // { $dayOfMonth: "$createdAt" }
$.createdAt.getDay()               // { $subtract: [{ $dayOfWeek: "$createdAt" }, 1] }  (0=Sun, JS-compatible)
$.createdAt.getHours()             // { $hour: "$createdAt" }
$.createdAt.getMinutes()           // { $minute: "$createdAt" }
$.createdAt.getSeconds()           // { $second: "$createdAt" }
$.createdAt.getMilliseconds()      // { $millisecond: "$createdAt" }
$.createdAt.getTime()              // { $toLong: "$createdAt" }   (ms since epoch)
$.createdAt.toISOString()          // { $dateToString: { date: "$createdAt", format: "%Y-%m-%dT%H:%M:%S.%LZ" } }
```

Each component getter has a `getUTC*` variant that reads the date in UTC instead of the server's local zone — matching JavaScript's `getHours()` (local) vs `getUTCHours()` (UTC) split:

```js
$.createdAt.getUTCFullYear()       // { $year: { date: "$createdAt", timezone: "UTC" } }
$.createdAt.getUTCMonth()          // { $subtract: [{ $month: { date: "$createdAt", timezone: "UTC" } }, 1] }  (0-indexed)
$.createdAt.getUTCDate()           // { $dayOfMonth: { date: "$createdAt", timezone: "UTC" } }
$.createdAt.getUTCDay()            // { $subtract: [{ $dayOfWeek: { date: "$createdAt", timezone: "UTC" } }, 1] }  (0=Sun)
$.createdAt.getUTCHours()          // { $hour: { date: "$createdAt", timezone: "UTC" } }
$.createdAt.getUTCMinutes()        // { $minute: { date: "$createdAt", timezone: "UTC" } }
$.createdAt.getUTCSeconds()        // { $second: { date: "$createdAt", timezone: "UTC" } }
$.createdAt.getUTCMilliseconds()   // { $millisecond: { date: "$createdAt", timezone: "UTC" } }
```

**Date arithmetic** — add or subtract a span of time with `.plus(amount, unit)` and `.minus(amount, unit)`, with an optional third `timezone` argument:

```js
$.subscribedAt.plus(30, "day")     // { $dateAdd: { startDate: "$subscribedAt", unit: "day", amount: 30 } }
$.expiresAt.minus(1, "month")      // { $dateSubtract: { startDate: "$expiresAt", unit: "month", amount: 1 } }
$.t.plus(2, "hour", "America/New_York")
// { $dateAdd: { startDate: "$t", unit: "hour", amount: 2, timezone: "America/New_York" } }
```

`unit` accepts the same time units as the `$dateAdd` operator (listed under [Date Operator Calls](#date-operator-calls) below); a literal typo is rejected with a suggestion (`.plus(30, "days")` → *"unit must be one of: … — got 'days'. Did you mean 'day'?"*). A literal `amount` must be an integer and a literal `timezone` must be a string — otherwise you get the same compile-time error the `$dateAdd(…)` operator form gives; a field path or parameter in either slot passes through unchecked. The method name follows Temporal/Luxon (`.plus` / `.minus`), while the `(amount, unit)` argument order follows Moment's `.add(amount, unit)` — `amount` first, `unit` second.

**Note:** `getMonth()` / `getUTCMonth()` and `getDay()` / `getUTCDay()` are adjusted to match JavaScript's 0-based conventions. MongoDB's `$month` is 1-based; jsmql subtracts 1 automatically. There is no `getUTCTime()` — JS's `getTime()` is already UTC epoch milliseconds.

**Note:** these methods require a date receiver, so a literal non-date is rejected at compile time (`"2020-01-01".getFullYear()` → *"'.getFullYear' expects a date, but got a string. Use a field path or new Date(…)."*). A field path or `new Date(…)` passes through. The one exception is `.getTime()`, which lowers to `$toLong` and so also accepts numeric strings/numbers.

### Date Operator Calls

```js
$dateAdd($.date, "day", 7)
// { $dateAdd: { startDate: "$date", unit: "day", amount: 7 } }

$dateDiff($.start, $.end, "month")
// { $dateDiff: { startDate: "$start", endDate: "$end", unit: "month" } }

$dateToString($.date, "%Y-%m-%d")
// { $dateToString: { date: "$date", format: "%Y-%m-%d" } }

$dateFromParts($.year, $.month, $.day)
// { $dateFromParts: { year: "$year", month: "$month", day: "$day" } }

$dateFromParts($.year, $.month, $.day, $.hour, $.min, $.sec, $.ms)
// { $dateFromParts: { year: ..., month: ..., day: ..., hour: ..., minute: ..., second: ..., millisecond: ... } }

$dateFromParts($.year, $.month, $.day, $.hour, $.min, $.sec, $.ms, "America/New_York")
// { $dateFromParts: { year: ..., month: ..., day: ..., hour: ..., minute: ..., second: ..., millisecond: ..., timezone: "America/New_York" } }

$dateFromString($.dateString)
// { $dateFromString: { dateString: "$dateString" } }
```

Valid `$dateAdd` / `$dateDiff` units: `"year"`, `"quarter"`, `"week"`, `"month"`, `"day"`, `"hour"`, `"minute"`, `"second"`, `"millisecond"`.

---

## Escape Hatch (Direct Operator Form)

For MongoDB operators that have no JavaScript equivalent, use the `$opName()` escape hatch — a direct call to the underlying MQL operator. Every MongoDB aggregation operator is available this way, and unknown operators pass through automatically, making jsmql forward-compatible with new MongoDB releases.

### Examples:

```js
$zip([$.weeks, $.amounts])         // { $zip: { inputs: ["$weeks", "$amounts"] } }
                                   //   pairs parallel arrays element-wise — no JS equivalent
$sampleRate(0.1)                   // { $sampleRate: 0.1 }
                                   //   probabilistic match (10% sample) — no JS equivalent
$stdDevPop($.measurements)         // { $stdDevPop: "$measurements" }
                                   //   population standard deviation — no JS equivalent
$topN({ output: $.score, sortBy: { score: -1 }, n: 3 })
                                   // { $topN: { output: "$score", sortBy: { score: -1 }, n: 3 } }
                                   //   top-N accumulator over a group — no JS equivalent
```

### String

```js
$concat($.first, " ", $.last)      // { $concat: ["$first", " ", "$last"] }
```

### Math

```js
$log($.value, 10)                  // { $log: ["$value", 10] }  (log base 10)
$round($.value)                    // { $round: "$value" }       (round to integer)
$round($.value, 2)                 // { $round: ["$value", 2] }  (2 decimal places)
$trunc($.value)                    // { $trunc: "$value" }
$trunc($.value, 1)                 // { $trunc: ["$value", 1] }
```

### Accumulators (also valid as expressions)

Some operators are commonly used as accumulators in `$group` (taking a single field expression) but also work as expression operators in `$project` (taking multiple expressions to compare). jsmql accepts both shapes — pass one argument for the accumulator form, multiple for the expression form:

```js
$min($.scores)                     // { $min: "$scores" }              (single — accumulator-style)
$min($.a, $.b, $.c)                // { $min: ["$a", "$b", "$c"] }     (multi — expression-style)

$max($.scores)                     // { $max: "$scores" }
$avg($.values)                     // { $avg: "$values" }
$sum($.amounts)                    // { $sum: "$amounts" }
$stdDevPop($.measurements)         // { $stdDevPop: "$measurements" }
$mergeObjects($.docs)              // { $mergeObjects: "$docs" }       (single — accumulator-style)
$mergeObjects($.a, $.b)            // { $mergeObjects: ["$a", "$b"] }  (multi — expression-style)
```

### Array

```js
$size($.items)                     // { $size: "$items" }  (array length)
$range(0, 5)                       // { $range: [0, 5] }   → [0,1,2,3,4]
$range(0, 10, 2)                   // { $range: [0, 10, 2] }  → [0,2,4,6,8]
$first($.items)                    // { $first: "$items" }  (first array element)
$last($.items)                     // { $last: "$items" }   (last array element)
```

### Set Operations

These treat arrays as sets (order ignored, duplicates removed):

```js
$setUnion($.a, $.b)                // { $setUnion: ["$a", "$b"] }
$setUnion($.a, $.b, $.c)           // $setUnion accepts more than 2 arguments
$setUnion([$.a, $.b])              // a single array is the operand list — same output
$setIntersection($.a, $.b)         // { $setIntersection: ["$a", "$b"] }
$setDifference($.a, $.b)           // { $setDifference: ["$a", "$b"] }
$setIsSubset($.a, $.b)             // { $setIsSubset: ["$a", "$b"] }
$setEquals($.a, $.b)               // { $setEquals: ["$a", "$b"] }
```

**Operand rules for list operators.** Operators whose operand is a list (the set
operators, arithmetic `$add`/`$divide`/…, `$and`/`$or`, the bitwise ops) take
either two-or-more arguments or a single array — both produce the same `{ $op:
[…] }`. A single *non-array* value is rejected, because such an operator has no
single-value form (write `$setUnion($.a, $.b)` or `$setUnion([$.a, $.b])`, not
`$setUnion($.a)`). The JS spread isn't accepted in `$op(...)` — pass a single
array, or use the JS-method form where it applies (`Math.max(...$.scores)`). The
comparison operators are the exception: they *do* have a single-value form
(`$gt($.x)` → `{ $gt: "$x" }`, the query-operator shape), so a lone argument is
fine there.

### Object Operations

```js
Object.keys($.obj)                 // { $map: { input: { $objectToArray: "$obj" }, as: "jsmqlKv", in: "$$jsmqlKv.k" } }
Object.values($.obj)               // { $map: { input: { $objectToArray: "$obj" }, as: "jsmqlKv", in: "$$jsmqlKv.v" } }
Object.entries($.obj)              // { $objectToArray: "$obj" }
Object.fromEntries($.pairs)        // { $arrayToObject: "$pairs" }
Object.assign($.a, $.b)            // { $mergeObjects: ["$a", "$b"] }
Object.assign($.a, $.b, $.c)       // { $mergeObjects: ["$a", "$b", "$c"] }
Object.assign(...$.docs)           // { $mergeObjects: "$docs" }   (spread)

Array.isArray($.items)             // { $isArray: "$items" }

$getField("fieldName", $.doc)      // { $getField: { field: "fieldName", input: "$doc" } }
$setField("fieldName", $.doc, val) // { $setField: { field: "fieldName", input: "$doc", value: val } }
$unsetField("fieldName", $.doc)    // { $unsetField: { field: "fieldName", input: "$doc" } }
```

`Object.assign` shown here is the **expression** form (→ `$mergeObjects`). Called as a bare **statement** it mutates its first argument instead — see [Mutators](#objectassigntarget-sources-mutates-target).

### Spread in Variadic Calls

For variadic operators (and `Math.min`/`Math.max`, `Object.assign`), `...arr` passes the whole array through as the operator value:

```js
Math.max(...$.scores)              // { $max: "$scores" }
$concatArrays(...$.arrs)           // { $concatArrays: "$arrs" }
Object.assign(...$.docs)           // { $mergeObjects: "$docs" }
```

When mixed with non-spread args, jsmql wraps the non-spreads in single-element arrays and joins via `$concatArrays`:

```js
Math.min($.a, ...$.others)         // { $min: { $concatArrays: [["$a"], "$others"] } }
```

`$getField` and `$setField` are useful when field names are dynamic or contain special characters.

### Variable Binding with `$let`

`$let` binds named variables scoped to a single expression, avoiding repeated sub-expressions:

```js
$let({ discount: $.price * 0.1 }, (discount) => $.price - discount)
// → { $let: { vars: { discount: { $multiply: ["$price", 0.1] } }, in: { $subtract: ["$price", "$$discount"] } } }

$let({ x: $.a + $.b, y: $.c * 2 }, (x, y) => x + y)
// binds multiple variables, body can reference all of them
```

### Bitwise

```js
$bitAnd($.flags, $.mask)           // { $bitAnd: ["$flags", "$mask"] }
$bitOr($.a, $.b)                   // { $bitOr: ["$a", "$b"] }
$bitXor($.a, $.b)                  // { $bitXor: ["$a", "$b"] }
$bitNot($.flags)                   // { $bitNot: "$flags" }
```

### `$literal` — bypass MongoDB's runtime expression evaluation

Most of the time you don't need to call `$literal` yourself — jsmql wraps `"$..."`-shaped string **values** in `$literal` automatically:

```js
"$foo"                             // { $literal: "$foo" }   — automatic
[1, "$foo", "bar"]                 // [1, { $literal: "$foo" }, "bar"]
({ x: "$foo" })                    // { x: { $literal: "$foo" } }
$concat("$first", " ", "$last")    // { $concat: [{ $literal: "$first" }, " ", { $literal: "$last" }] }
```

The same protection applies to values interpolated via the template-tag form and to bindings supplied to `jsmql.compile()` — a `"$..."` string cannot accidentally become a field reference on its way through user input. Real field references (`$.foo`) are unaffected: they come from the dedicated `$.` syntax, not from string literals.

`$literal` is **not** applied to object **keys** — MongoDB doesn't auto-evaluate keys at query time, so `{ "$foo": 1 }` stays as `{ "$foo": 1 }` (which is how you'd intentionally name a field `$foo`).

You can still call `$literal` explicitly; the auto-wrap detects that the subtree is already inside a `$literal` envelope and won't double-wrap:

```js
$literal("$foo")                   // { $literal: "$foo" }
$literal(42)                       // { $literal: 42 }       — equivalent to bare 42
$literal({ x: "$foo" })            // { $literal: { x: "$foo" } }   — inner $-string not double-wrapped
```

### `$meta` — per-document aggregation metadata

⚠️ **Watch out:** `$meta` takes a **keyword string** (`"textScore"`, `"indexKey"`, `"searchScore"`, etc.), not an arbitrary expression. jsmql does not validate the keyword.

```js
$meta("textScore")                 // { $meta: "textScore" }
```

### Custom Aggregation: `$function` and `$accumulator`

⚠️ **Watch out:** the `body`, `init`, `accumulate`, `merge`, and `finalize` fields are **JavaScript source code as a string**, executed by MongoDB's V8 engine on the server. They are NOT jsmql expressions — `$.field` references will not be substituted, and you must pass field values via the `args` / `accumulateArgs` arrays.

```js
$function({
  body: "function(price, taxRate) { return price * (1 + taxRate); }",
  args: [$.price, $.taxRate],
  lang: "js"
})
// → { $function: { body: "...", args: ["$price", "$taxRate"], lang: "js" } }

$accumulator({
  init: "function() { return 0; }",
  accumulate: "function(state, value) { return state + value; }",
  accumulateArgs: [$.amount],
  merge: "function(a, b) { return a + b; }",
  lang: "js"
})
```

### Window Operators

⚠️ **Watch out:** these are valid only inside the `$setWindowFields` stage. Calling `$rank()` from a `$project` stage produces nonsense MQL — jsmql does not validate the surrounding stage context.

```js
$rank()                            // { $rank: {} }
$denseRank()                       // { $denseRank: {} }
$documentNumber()                  // { $documentNumber: {} }
$linearFill($.value)               // { $linearFill: "$value" }
$locf($.value)                     // { $locf: "$value" }

$shift($.price, -1, 0)             // { $shift: { output: "$price", by: -1, default: 0 } }
$expMovingAvg($.price, 5)          // { $expMovingAvg: { input: "$price", N: 5 } }
$expMovingAvg({ input: $.price, alpha: 0.3 })
                                   // { $expMovingAvg: { input: "$price", alpha: 0.3 } }
$derivative($.value, "hour")       // { $derivative: { input: "$value", unit: "hour" } }
$integral($.value, "hour")         // { $integral: { input: "$value", unit: "hour" } }

$covariancePop($.x, $.y)           // { $covariancePop: ["$x", "$y"] }
$covarianceSamp($.x, $.y)          // { $covarianceSamp: ["$x", "$y"] }
```

### Encrypted String (Queryable Encryption)

These operate on encrypted fields created with MongoDB's Queryable Encryption feature.

```js
$encStrContains($.encField, "secret")
                                   // { $encStrContains: { input: "$encField", substring: "secret" } }
$encStrStartsWith($.encField, "abc")
                                   // { $encStrStartsWith: { input: "$encField", prefix: "abc" } }
$encStrEndsWith($.encField, "xyz") // { $encStrEndsWith: { input: "$encField", suffix: "xyz" } }
$encStrNormalizedEq($.encField, "match")
                                   // { $encStrNormalizedEq: { input: "$encField", string: "match" } }
```

### Statistical Accumulators: `$median` and `$percentile`

```js
$median($.scores, "approximate")
// { $median: { input: "$scores", method: "approximate" } }

$percentile($.scores, [0.5, 0.95], "approximate")
// { $percentile: { input: "$scores", p: [0.5, 0.95], method: "approximate" } }
```

### Deprecated: `$substr`

`$substr` is deprecated in MongoDB. Prefer `$substrBytes` (byte-indexed) or `$substrCP` (code-point-indexed) for new code.

---

## Update filters

Document field updates can be written with JavaScript-natural syntax: `=`, `+=`, `-=`, `*=`, `/=`, and `delete`. Each update op compiles to a MongoDB pipeline `$set` or `$unset` stage; multiple update ops coalesce into the smallest correct stage shape. `jsmql()` always returns a pipeline **array** so the output is safe to pass directly to `db.coll.updateOne(filter, update)` — see the `jsmql.expr` note at the end of the section for when you want the bare-document form instead.

```js
db.users.updateOne({ _id: 1 }, jsmql("$.score = 100"))
// → db.users.updateOne({ _id: 1 }, [{ $set: { score: 100 } }])

db.users.updateOne({ _id: 1 }, jsmql("$.cnt += 1"))
// → db.users.updateOne({ _id: 1 }, [{ $set: { cnt: { $add: ["$cnt", 1] } } }])

db.users.updateOne({ _id: 1 }, jsmql("delete $.tmp"))
// → db.users.updateOne({ _id: 1 }, [{ $unset: "tmp" }])
```

### Sequencing

Multiple update ops in the **same stage** are separated by `,` (trailing comma allowed):

```js
jsmql("$.a = 1, $.b = 2")
// → [{ $set: { a: 1, b: 2 } }]
```

A `;` is **not** a same-stage separator — it splits stages. See [Pipelines](#pipelines) for the canonical `;`-separated pipeline form.

### Targets

In a Filter / update-doc, the left-hand side must be a field path: `$.x`, `$.x.y`, `$.x.y.z`. Computed/index access is not assignable, and a bare identifier is assignable only inside a pipeline where it names an in-scope `let` binding (see [Local bindings](#local-bindings-let)):

```js
x = 5                  // ✗ — bare identifier, no pipeline / not a `let`
$.items[0] = 5         // ✗ — index access
$.user.name = "alice"  // ✓ — nested field path
```

### Compound assignment

`+=`, `-=`, `*=`, `/=` are sugar for `$.x = $.x <op> rhs`. The `+=` operator inherits the language's type-aware addition: numeric `+=` produces `$add`, string `+=` produces `$concat`.

```js
jsmql("$.score *= 2")
// → [{ $set: { score: { $multiply: ["$score", 2] } } }]

jsmql("$.greeting += '!'")
// → [{ $set: { greeting: { $concat: ["$greeting", "!"] } } }]
```

### Increment / decrement

`x++`, `++x`, `x--`, `--x` are sugar for `x += 1` and `x -= 1`. The prefix/postfix distinction is meaningful in JavaScript (return-then-mutate vs mutate-then-return), but in MongoDB pipeline context there is no "value of expression" for a statement-level update op, so all four forms compile to the same `$set` stage.

```js
jsmql("$.cnt++")
// → [{ $set: { cnt: { $add: ["$cnt", 1] } } }]

jsmql("--$.lives")
// → [{ $set: { lives: { $subtract: ["$lives", 1] } } }]
```

Like other update ops, inc/dec is a statement: invalid as a value (`1 + $.x++` is rejected) and restricted to field-path targets.

### Chained assignment

`$.a = $.b = expr` is supported (right-associative, like JavaScript); both fields receive the same RHS expression. Compound chains (`a += b += 1`) are rejected — too easy to misread.

```js
jsmql("$.x = $.y = 0")
// → [{ $set: { x: 0, y: 0 } }]
```

### Coalescing

Consecutive same-kind update ops (all assignments, or all deletes) are grouped into a single `$set`/`$unset` stage. A new stage starts when:

- The kind changes (assignment ↔ delete)
- A later update op writes to a path already written in the current group
- A later assignment **reads** a path the current group has written — preserves JS sequential semantics

```js
// Independent assignments → one stage (wrapped as a one-element pipeline)
jsmql("$.a = 1, $.b = 2")
// → [{ $set: { a: 1, b: 2 } }]

// Read-after-write → two stages
jsmql("$.a = 1, $.b = $.a")
// → [{ $set: { a: 1 } }, { $set: { b: "$a" } }]

// Kind change → two stages
jsmql("delete $.a, delete $.b, $.status = 'done'")
// → [{ $unset: ["a", "b"] }, { $set: { status: "done" } }]
```

### Bare-document form via `jsmql.expr`

When you need the bare `{ $set: … }` / `{ $unset: … }` document — e.g. to embed inside a hand-written pipeline stage you're composing yourself — use `jsmql.expr()` instead. It produces the unwrapped document; the caller is responsible for the surrounding shape. See [Partial expressions](#partial-expressions-jsmqlexpr) for the full call shape comparison.

```js
// One stage, bare doc — for slotting into something else
jsmql.expr("$.score = 100")
// → { $set: { score: 100 } }
```

Do **not** pass a single-statement `jsmql.expr()` result to `updateOne()`: MongoDB only evaluates aggregation expressions on the RHS when the second argument is an array. The bare doc form would silently store a literal `{ $toUpper: "$name" }` object instead of evaluating it. Use `jsmql()` at every driver call site.

### Update filters inside pipelines

Update filters can appear as pipeline elements alongside ordinary stages. The same coalescing rule applies between adjacent update op elements; non-update op stages act as boundaries:

```js
jsmql(`[
  $match($.active),
  $.score += 1,
  $.lastSeenAt = new Date(),
  $sort({ score: -1 })
]`)
// → [
//     { $match: { $expr: "$active" } },   // bare field ref isn't a comparison; stays $expr
//     { $set: { score: { $add: ["$score", 1] }, lastSeenAt: { $toDate: "$$NOW" } } },
//     { $sort: { score: -1 } }
//   ]
```

### Limits

Update filters are **statements**, not expression values. They are valid only at the top level of a `jsmql()` call or as direct pipeline-array elements. They cannot appear:

- Inside an arbitrary expression (`($.a = 1) + 2` — rejected)
- Inside a lambda body (`$.list.map(x => $.a = x)` — rejected)
- As any value other than a top-level statement or pipeline element

The `delete` keyword is statement-only — unlike JavaScript, it does not return a boolean.

### Replace root via `$ = <expr>`

Assigning to bare `$` replaces the **whole document** with the RHS expression. The natural JS shape — the LHS *is* the document — lowers to MongoDB's `$replaceWith` stage (the shorter equivalent of `$replaceRoot: { newRoot: <expr> }`). The trailing `;` is optional when `$ = <expr>` is the only statement — `jsmql("$ = { … }")` and `jsmql("$ = { … };")` both produce the same `$replaceWith` pipeline.

> **Convention:** a leading `$ =` is reserved for *root-replacing* sugar (`$replaceWith`, the [fan-out](#fan-out-one-document-to-many-documents) form, and the `$facet` variant below). Stages that write elsewhere — `$out` uses `$$$.<coll> = …`, `$lookup` uses `$$$.<coll>.find(…)`, `$unionWith` uses `$$.push(…)` — use distinct LHS prefixes so the write destination is visible at a glance.

```js
// Lift an embedded sub-document to the top level
jsmql("$ = $.profile;")
// → [{ $replaceWith: "$profile" }]

// Merge fresh fields into the existing root.
// Bare `$` inside the spread is the current document ($$ROOT in MQL).
jsmql("$ = { ...$, computedScore: $.points * 1.1 };")
// → [{ $replaceWith: { $mergeObjects: ["$$ROOT", { computedScore: { $multiply: ["$points", 1.1] } }] } }]

// Replace the doc with a single matched join.
// `.find` returns scalar-or-null; `$replaceWith` runs `$first` on the lookup slot.
jsmql("$ = $$$.users.find(u => u._id === $.userId);")
// → [
//     { $lookup: { from: "users", localField: "userId", foreignField: "_id", as: "__jsmql.tmp.1" } },
//     { $replaceWith: { $first: "$__jsmql.tmp.1" } },
//     { $unset: "__jsmql" }
//   ]
```

Bare `$` is a new primary expression — the current document. It plays the same role MQL spells as `"$$ROOT"`, and you can use it anywhere a field path is valid:

```js
jsmql.expr("$mergeObjects($, { x: 1 })")
// → { $mergeObjects: ["$$ROOT", { x: 1 }] }
```

Compile-time rejections (each with an actionable hint):

| RHS | Why it's rejected |
|---|---|
| `$ = []` | An empty array would discard every document. Fan out a data-dependent array (`$ = $.items.filter(...)`) to drop docs conditionally, or use `$$ = []` to empty the stream. |
| `$ = [1, 2]`, `$ = ["a"]` | Each fanned-out element becomes a document root, so elements must be documents — wrap them: `$ = [{ value: ... }]`. |
| `$ = 5`, `$ = "foo"`, `$ = true`, `$ = null` | Scalars aren't documents. Wrap with `$ = { value: ... }`. |
| `$ = undefined` | `undefined` is only meaningful in `$match` position. Use `null` for the present-but-null case, or move the comparison into `$match`. |
| `$ = $$$.users.filter(...)` | `.filter()` on a collection is a join that returns an array; use `.find()` for a single doc. |
| `$++`, `$ += 5`, `$--`, `$ *= 2`, etc. | `$` is the whole document, not a scalar. Use `$ = { ...$, ...overrides }` to merge fields. |
| `delete $` | Bare `$` is the whole document. Use `$ = <newDoc>` to replace it, or `delete $.<field>` to drop a single field. |

`$replaceWith` is a **reshape-clearing stage** — any `let` binding declared before it is gone. A later reference produces a precise error: `` `x` is a `let` binding and can't be read after `$replaceWith` — the stage replaces the document. ``

#### Fan-out: one document to many documents

When the RHS is **provably an array** — an array literal, or an array-typed expression like `.map()`, `.filter()`, or `Object.entries()` — `$ = …` fans out: each input document produces one output document **per array element** (via `$unwind`).

```js
// Explode an array literal: 1 input doc → 2 output docs
jsmql("$ = [{ kind: 'a' }, { kind: 'b' }];")
// → [
//     { $set: { "__jsmql.tmp.1": [{ kind: "a" }, { kind: "b" }] } },
//     { $unwind: "$__jsmql.tmp.1" },
//     { $replaceWith: "$__jsmql.tmp.1" }
//   ]

// Explode each order's line-items into per-item documents
jsmql("$ = $.lineItems.map(li => ({ orderId: $._id, sku: li.sku }));")
// → $set the $map into a slot, then $unwind + $replaceWith

// Turn a sub-document into one {k, v} document per key
jsmql("$ = Object.entries($.scores);")
// → $set the $objectToArray into a slot, then $unwind + $replaceWith
```

A **bare field ref is not** provably an array (field paths carry no compile-time type), so `$ = $.items` stays a single-doc `$replaceWith`. To fan out a field, spread it into a literal: **`$ = [...$.items]`**.

**Conditional drop falls out for free.** `$unwind` emits nothing for an empty array, so fanning out a possibly-empty array drops exactly the documents whose array came out empty and fans out the rest:

```js
// Docs with no qualifying item are dropped; the rest fan out per qualifying item
jsmql("$ = $.items.filter(x => x.qty > 0);")
```

This is the idiomatic way to conditionally drop documents. (To empty the *whole* stream unconditionally, that's a different operation — `$$ = []`.)

#### `$facet` via `$ = { key: $$.filter(p), … }`

When every value of the object literal is a `$$.filter(<lambda>)` call, the same `$ = { … }` surface lowers to a `$facet` stage instead — each named filter becomes its own sub-pipeline running against the parent's input docs:

```js
jsmql(`$ = {
  topByScore: $$.filter(o => { $sort({ score: -1 }); $limit(10); }),
  recent:     $$.filter(o => o.createdAt >= "2026-01-01"),
  byStatus:   $$.filter(o => { $group({ _id: o.status, n: $sum(1) }); }),
};`)
// → [{ $facet: {
//       topByScore: [{ $sort: { score: -1 } }, { $limit: 10 }],
//       recent:     [{ $match: { createdAt: { $gte: "2026-01-01" } } }],
//       byStatus:   [{ $group: { _id: "$status", n: { $sum: 1 } } }]
//   } }]
```

The lambda parameter (`o` in the examples — name is your choice) represents each input document inside the sub-pipeline. Expression bodies become a `$match` stage; block bodies become the block's stages verbatim.

Rules:

- **Every value must be `$$.filter(<lambda>)`.** Mixing in a static value (`b: 1`) or a spread (`...rest`) is a compile-time error — the parser would otherwise silently fall through to `$replaceWith`, which would surface a confusing "$$ is statement-only" error inside the codegen.
- **Lambda takes exactly one parameter.** You must name the doc explicitly so the error message for stray `$.<field>` references can point at the right replacement.
- **Use `o.<field>`, not `$.<field>`.** Inside a facet sub-pipeline, the lambda param IS the current document — supporting both spellings would just invite drift. `$.x` inside the predicate is rejected with a precise hint.
- **`$facet` clears the let scope** (it replaces the document with `{ facetName: [docs], … }`). A later `let`-binding reference produces the standard "can't be read after `$facet`" error.

For filtering the current stream as a top-level stage (one $match, not split into facets), use `$match(<predicate>)` directly — `$$.filter(...)` at a statement position is rejected with a hint pointing at `$match`.

### Replace stream via `$$ = <expr>`

Sister to `$ = <expr>` at the *stream* level. Assigning to bare `$$` replaces the pipeline's document stream. Two RHS shapes are accepted:

```js
// Narrow the current stream (equivalent to $match($.client === 156 && $.createdAt >= "2026-01-01"))
jsmql(`$$ = $$.filter(t => t.client === 156 && t.createdAt >= "2026-01-01");`)
// → [{ $match: { client: 156, createdAt: { $gte: "2026-01-01" } } }]

// Switch source to another collection: drop the current stream, union in filtered foreign docs.
// The driver call (`db.<original>.aggregate(...)`) keeps its original collection.
jsmql(`$$ = $$$.transactions.filter(t => t.client === 156 && t.createdAt >= new Date("2026-01-01"));`)
// → [
//     { $match: { $expr: false } },
//     { $unionWith: { coll: "transactions",
//                     pipeline: [{ $match: { client: 156, createdAt: { $gte: <Date> } } }] } }
//   ]
```

The lambda param IS the document being matched — write `t.client`, not `$.client`. Same convention as the facet form: `$.<field>` inside the predicate of a flat (non-correlated) source-switch is rejected with a "use the lambda parameter" hint. Block-body predicates (`o => { $sort(...); $limit(...); }`) work in the source-switch form just like in lookups.

Because a flat source-switch *replaces* the stream (a `$unionWith` with no `let:`), the outer document, the root `$$.length`, and any outer `let`/`const` are **gone** inside the switched-in pipeline — only the new collection's own fields (via the lambda param) and its own `coll.length` are available. Referencing the outer context there is an error that points you at the correlated form: e.g. an outer `const k` read inside `$$ = $$$.orders.map(o => ({ v: k }))` reports that `k` "isn't available inside `$$ = $$$.orders` … correlate with a `.filter` instead", and a `$.<field>` read explains the original root is gone. To keep the outer context, add a correlating `.filter` (below) — that lowers to `$lookup` and threads it in.

**Correlated source-switch — per-outer-doc pivot via `$lookup`.** When the predicate *does* reference outer-doc fields (`$.<field>`), jsmql auto-rewrites the chain to `$lookup` + `$unwind` + `$replaceWith`. The result is a stream of foreign docs *correlated* to each input — one row per (outer × matching-foreign) pair, with the foreign doc as the new root. MongoDB's `$unionWith` doesn't have a `let:` slot to thread outer-doc context into its sub-pipeline, so this is the only way to express "per-outer-doc source switch" in MQL; jsmql picks the right lowering family automatically based on the predicate shape:

```js
// "For each user, pivot the stream onto their orders, top-5 most-recent."
jsmql`$$ = $$$.orders
  .filter({ userId: $._id })
  .toSorted({ placedAt: -1 })
  .take(5);`
// → [
//   { $lookup: {
//       from: "orders",
//       let: { jsmql_f0__id: "$_id" },
//       pipeline: [
//         { $match: { $expr: { $eq: ["$userId", "$$jsmql_f0__id"] } } },
//         { $sort: { placedAt: -1 } },
//         { $limit: 5 },
//       ],
//       as: "__jsmql.tmp.1",
//   } },
//   { $unwind: "$__jsmql.tmp.1" },
//   { $replaceWith: "$__jsmql.tmp.1" },
// ]
```

When the predicate is a single `===` between a foreign-path and a `$.<path>` (and there are no chain methods after `.filter`), the lookup uses **basic form** (`localField` / `foreignField`) instead of `let` + `$match $expr` — same index-friendliness as a hand-written `$lookup`. With chain methods or richer predicates, pipeline-form with auto-hoisted `let` vars kicks in.

The `$unwind` drops outer docs with no matches by default — if you need `preserveNullAndEmptyArrays`, write the explicit `$.matched = $$$.coll.filter(...); $unwind($.matched, true); $ = $.matched` chain instead.

**`let` bindings cross the source-switch boundary too.** A name bound via `let foo = …` in the surrounding pipeline can be referenced directly inside a correlated `.filter` predicate — jsmql hoists it as a `$lookup.let` var the same way it does `$.<field>` refs. Member access on a `let`-bound object (`user._id` when `let user = $.user`) works too: the resolved path becomes the materialised `__jsmql.var.user._id` and basic-form `$lookup` continues to fire when the predicate is a single `===`:

```js
jsmql`
let uid = $.userId;
$$ = $$$.users.filter(u => u._id === uid);
`
// → [
//   { $set: { "__jsmql.var.uid": "$userId" } },
//   { $lookup: { from: "users", localField: "__jsmql.var.uid", foreignField: "_id", as: "__jsmql.tmp.1" } },
//   { $unwind: "$__jsmql.tmp.1" },
//   { $replaceWith: "$__jsmql.tmp.1" },
// ]
```

Mixed predicates work too — `$.<field>` refs and outer-`let` refs hoist together into the `$lookup.let` slot of the pipeline-form lookup.

**Putting it all together — narrow, guard, pivot.** The full idiom is three statements: narrow the current stream down to the matching doc(s), assert exactly one matched, then pivot to another collection correlated by the root doc's field. Every line is JavaScript an app developer already knows; jsmql lowers the bookkeeping. This is the "look up the logged-in user, then fetch their recent orders" shape that recurs in nearly every web app:

```js
jsmql(`
  $$ = $$.filter({ email: "me@example.com" });
  assert($$.length === 1, "More than one user with such email found");
  $$ = $$$.orders
    .filter({ userId: $._id })
    .toSorted({ placedAt: -1 })
    .take(5);
`);
// → [
//   { $match: { email: "me@example.com" } },
//   { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
//   { $match: { $expr: { $convert: { input: true, to: { $cond: [
//       { $eq: ["$__jsmql.length", 1] }, "bool",
//       "jsmql assertion failed: More than one user with such email found" ] } } } } },
//   { $lookup: {
//       from: "orders",
//       let: { jsmql_f0__id: "$_id" },
//       pipeline: [
//         { $match: { $expr: { $eq: ["$userId", "$$jsmql_f0__id"] } } },
//         { $sort: { placedAt: -1 } },
//         { $limit: 5 },
//       ],
//       as: "__jsmql.tmp.1",
//   } },
//   { $unwind: "$__jsmql.tmp.1" },
//   { $replaceWith: "$__jsmql.tmp.1" },
// ]
```

Note the contrast with hand-written MQL: `$unionWith` has no `let:` slot, so a source-switch can't carry the user's `_id` forward on its own — only `$lookup` can. jsmql picks the right shape automatically when the foreign predicate references an outer name (here `$._id`, captured as the correlation var `$$jsmql_f0__id`). The `assert` is a stream-count guard: `$$.length` materialises via `$setWindowFields`, and a `$convert`-to-bool that errors on the message aborts the run unless exactly one user matched. The statements stay self-contained: each one means what JS says it means, and the lowering composes them into a single correlated `$lookup`-pivot pipeline. (The final `$replaceWith` drops the whole document, so the scratch `__jsmql` fields need no trailing `$unset`.)

**Empty the stream.** `$$ = []` drops every document — it lowers to `[{ $match: { $expr: false } }]` (a never-matching `$match`). MongoDB rejects `$limit: 0` ("the limit must be positive"), so the never-matching `$match` is what jsmql emits. The explicit-stage spelling is `$match(false)`.

Compile-time rejections:

| RHS | Why it's rejected |
|---|---|
| `$$ = cond ? A : B` | Stream-level ternary is not a supported form — a stream has no single condition that swaps the whole stream for A or B. Narrow with `$$.filter(p)` or switch source with `$$$.<coll>.filter(p)`. |
| `$$ = $$$.<coll>.find(...)` | `.find(...)` returns a single element in JS but pipelines are arrays. For "first match", write `.filter(p).slice(0, 1)`. For replacing each doc with a single matching foreign doc, use `$ = $$$.<coll>.find(<predicate>)` (a separate lookup form). |
| `$$ = $$$.<coll>` (no `.filter` and no other chain method) | Bare collection ref — name a predicate (`.filter(o => …)`) or chain a stream method (e.g. `.slice(0, 10)`). |
| `$$ += …`, `$$++` | `$$` is the stream, not a scalar. |

**Let scope.** The narrow form (`$$ = $$.filter(p)`) is just a `$match` and preserves any prior `let` bindings — references resolve through `ctx.pipelineLets` as usual. The source-switch form (`$$ = $$$.<coll>.filter(p)`) is **reshape-clearing**: the outer collection's docs are gone after the never-matching `$match`, so any prior `let` becomes unreadable, producing `` `x` is a `let` binding and can't be read after `$unionWith` … `` on the next reference.

#### Stream methods chained after the RHS

The RHS of `$$ = …` accepts chainable JS-array-shaped methods after the initial `$$` / `$$$.<coll>` receiver (with or without a leading `.filter(<pred>)`). Each chained method appends one or more stages to the surrounding pipeline (for `$$.<chain>`) or the `$unionWith.pipeline` body (for `$$$.<coll>.<chain>`):

```js
// Skip the first 5 and keep the next 10 — pure $skip + $limit, no $match.
jsmql(`$$ = $$.slice(5, 15);`)
// → [{ $skip: 5 }, { $limit: 10 }]

// Filter then take the first 10 — $match + $limit.
jsmql(`$$ = $$.filter(o => o.tier === "gold").slice(0, 10);`)
// → [{ $match: { tier: "gold" } }, { $limit: 10 }]

// Source-switch with a slice inside the union body.
jsmql(`$$ = $$$.archive.filter(o => o.tier === "gold").slice(0, 10);`)
// → [{ $match: { $expr: false } },
//    { $unionWith: { coll: "archive",
//                    pipeline: [{ $match: { tier: "gold" } }, { $limit: 10 }] } }]
```

| Method | Args | Lowering |
|---|---|---|
| `.slice(start, end?)` | 1-2 non-negative integer literals | `$skip: start` (omitted when `start === 0`) + `$limit: end - start` (omitted when `end` is absent) |
| `.concat(...others)` | One or more — same shapes as `$$.push(...)`: spread of `$$$.<coll>[.filter(p)]`, inline `{...}` doc, or `$$$.<coll>.find(p)` (no spread) | One `$unionWith` per arg; consecutive inline docs batch into one `$documents` stage |
| `.map(d => <expr>)` / `.map("field")` | Single-param expression-body arrow (the param is the current document — write `d.x`, not `$.x`), **or** the lodash property shorthand `.map("field")`. Embedded `$$$.<coll>.find/filter(...)` lookups work in both stream contexts | `$replaceWith: <expr>` — the chain-form of `$ = <expr>`; the shorthand → `$replaceWith: "$field"`. Embedded lookups materialise into prologue `$lookup` stages ahead of the `$replaceWith`. In the `$$$.<coll>.<chain>` context the prologue lands inside the outer `$unionWith.pipeline` (a nested `$lookup`, valid MQL) |
| `.sort(<sort>)` / `.toSorted(<sort>)` | A field name (ascending), `["a", "b"]` (all ascending), a `{ field: 1 \| -1 \| "asc" \| "desc" }` spec, or a comparator `(a, b) => a.<f> - b.<f>` (`\|\|` for compound). `.sort` and `.toSorted` are equivalent on a stream | `$sort: { … }`. Zero-arg is rejected (streams have no natural document ordering) |
| `.sortBy(<field> \| [fields])` / `.orderBy(keys[, orders])` | The lodash sort aliases. `.sortBy` is ascending by one/more keys; `.orderBy` takes parallel keys + directions (`1`/`-1`/`"asc"`/`"desc"`), **or** a `{ field: dir }` object with the directions inline (like `.sort({…})`) | `$sort: { … }`. `.sortBy({…})` is rejected (an object is a lodash matches-shorthand, not a direction — it points at `.orderBy({…})`) |
| `.filter(<predicate>)` | An arrow (`o => …`, expression or block body), a matches-object (`{ active: true }`), a field name (`"active"`), or a `["field", value]` pair. The spellings are interchangeable — and interchangeable in *every* position a `$$` predicate may sit (see the note below) | `$match` — the index-friendly translator `$match` uses. Expression body → query syntax with any residual in `$expr`; block body → the block's stages |
| `.reject(<predicate>)` | `.filter` negated — an arrow (`o => …`), a matches-object, a field name, or a `["field", value]` pair | `$match: { $expr: { $not: … } }` (the `$expr` form, never a query-form De Morgan) |
| `.pick([fields])` / `.omit([fields])` | The lodash object methods, per document. `.pick` keeps only the named fields (`_id` dropped unless named); `.omit` drops the named fields | `$project` (inclusion / exclusion) |
| `.takeWhile(<pred>)` / `.dropWhile(<pred>)` | The leading run where the predicate holds (`takeWhile`), or everything from the first failure on (`dropWhile`). Same predicate spellings as `.filter`. **A sort must come first** — any spelling (`.sort` / `.toSorted` / `.sortBy` / `.orderBy` / `.$sort({…})`); with none it is rejected, never defaulted to `_id` | `$setWindowFields` carrying a running "has it failed yet" flag, then `$match` on that flag (`0` keeps, `1` drops). The two are exact complements |
| `.tail()` | Zero args — all but the first document | `$skip: 1` |
| `.shuffle()` | Zero args — random document order (non-deterministic, like `.sample`) | `$addFields` a `$rand` key · `$sort` by it · `$unset` it |
| `.take(n)` / `.drop(n)` | One non-negative integer literal | `.take(n)` → `$limit: n` (`take(0)` → an always-false `$match`, since `$limit: 0` is invalid); `.drop(n)` → `$skip: n` (`drop(0)` is identity — no stage) |
| `.sampleSize(n)` | One integer literal ≥ 1 | `$sample: { size: n }` |
| `.sample()` | Zero args | `$sample: { size: 1 }` — one random document (lodash `_.sample`; use `.sampleSize(n)` for more) |
| `.flatMap(<key>)` | One field key — the array field to flatten | One `$unwind: "$<path>"` stage. Surrounding fields preserved (MQL-natural); chain `.map(d => d.<path>)` after for JS-faithful "just the elements". Complex arrow bodies (`.flatMap(d => d.items.map(...))`) are rejected for v1 |
| `.groupBy(<key>)` / `.groupBy({ _id, … })` | One field key, **or** a raw `$group` body object (must contain `_id`; accumulator ops like `$addToSet` are allowed in the field slots) | Key form → collapses to the lodash object `{ <key>: [docs] }` (like value-mode `$.arr.groupBy(...)`); body form → `$group: <body>` verbatim (a stream of group docs — the accumulator form has no lodash analogue) |
| `.countBy(<key>)` | One field key | Collapses to the lodash object `{ <key>: <count> }` (like value-mode `$.arr.countBy(...)`). For the count-descending `{ _id, count }` stream, write the `$sortByCount("$field")` stage directly |
| `.keyBy(<key>)` | One field key | Collapses to the lodash object `{ <key>: <last doc> }` (like value-mode `$.arr.keyBy(...)`), last wins. "Last" follows current order — precede with `.sort(...)` when it matters |
| `.uniqBy(<key>)` | One field key | `$group` keeping the first document per key + `$replaceWith`. "First" follows current order — precede with `.sort(...)` when it matters |

`.filter(<pred>)` can appear **anywhere** in the chain — not only as the head, so `.flatMap("items").filter(o => o.qty > 0)` composes.

#### Callback spellings

**How you spell a callback never changes the MQL.** The lodash shorthands work the same on a stream as on an array value, and each is exactly its longhand:

| Slot | Write any of these | They all mean |
|---|---|---|
| **Sort key** — `.sortBy` `.orderBy` | `"cat"` · `d => d.cat` · `d => d.cat.toLowerCase()` | order by that value |
| **Group key** — `.groupBy` `.countBy` `.keyBy` `.uniqBy` | the above, **plus** `{ cat: "a" }` · `["cat", "a"]` | group on that value |
| **Unwind path** — `.flatMap` | `"items"` · `d => d.items` | the `items` array field |
| **Predicate** — `.find` `.filter` `.reject` (and `.map`'s iteratee) | `o => o.cat === "a"` · `{ cat: "a" }` · `["cat", "a"]` · `"active"` (truthy test) | match on `cat` |

```js
$.n = $$$.orders.filter({ userId: $._id }).length;   // ≡ .filter(o => o.userId === $._id)
// → [{ $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "…" } },
//    { $set: { "…": { $size: "$…" } } }, …]  — same indexed $lookup either way
```

**Group keys may be computed.** MongoDB evaluates `$group._id` per document, so the four grouping methods take any expression — it lowers straight into the key, with no extra stages:

```js
$$ = $$.countBy(d => d.category.toLowerCase());
// → [{ $group: { _id: { $toLower: "$category" }, … } }, … ]

$$ = $$.groupBy(d => d.email.split("@")[1]);   // group by email domain
$$ = $$.countBy({ active: true });             // count matching vs not (lodash _.matches)
```

**Sort keys may be computed too**, but a `$sort` key has to be a literal field path, so jsmql puts the value in a scratch field first and clears it once the chain is done:

```js
$$ = $$.sortBy(d => d.category.toLowerCase());
// → [{ $addFields: { "__jsmql.tmp.1": { $toLower: "$category" } } },
//    { $sort: { "__jsmql.tmp.1": 1 } },
//    { $unset: "__jsmql" }]
```

The scratch field is cleared once the chain finishes, so it never reaches your output.

**`.flatMap` is the exception** — it takes a field path only. `$unwind` puts each element back into a *named* field, so which field it is is part of what you mean; jsmql can't pick one for you:

```js
$.allTags = $.tags.concat($.extraTags);
$$ = $$.flatMap("allTags");
```

On three methods an object means something richer than a matcher, so it is read that way: `.orderBy({ field: -1 })` and `.sort`/`.toSorted({ field: -1 })` are direction specs, and `.groupBy({ _id, … })` is a raw `$group` body.

`.map(d => …)` / `.map("field")` replaces each document with the body via `$replaceWith`, so the **body must resolve to a document** (MongoDB requires an object root). A provably non-document body — `.map(d => 5)`, `.map(d => "x")`, `.map(d => [1, 2])` — is rejected at compile time; a field ref that turns out to be a scalar at runtime (e.g. `.map("userId")` where `userId` is an ObjectId) is emitted but errors on the server, exactly like `$ = $.userId`. To keep a single value, wrap it in a document: `.map(d => ({ value: d.x }))`. Use `.map("subdoc")` only to promote a sub-document to the root.

Methods that count **from the end** (`.takeRight(n)`, `.dropRight(n)`, `.initial()`, `.toReversed()`) are deliberately not on this list either. A MongoDB stream has no order except the one a `$sort` gives it, and there is no stage that reverses one (`$reverseArray` is an *expression*, for an array inside a document) — so "the last 3" has nothing to count back from. Say the order you want and take from the **front**:

```js
$$ = $$.toSorted({ createdAt: -1 }).take(3);   // the 3 most recent
```

All four still work in value position on a real array (`$.items.takeRight(3)` → `$slice`, `$.items.toReversed()` → `$reverseArray`), where the array carries its own order and they mean exactly what they mean in JS.

Methods that return a single element in JS (`.find(p)`, `.findLast(p)`, `.at(n)`) are deliberately not on this list — pipelines are arrays, and chaining a single-element method would mislead. Use `.filter(p).take(1)` or `.slice(n, n + 1)` instead. (`$$$.<coll>.find(<pred>)` is unrelated — that's a lookup-context shape, not a stream chain; see [`$$$.<coll>.find / .filter`](#cross-collection-lookups-collfind--filter).)

**A predicate is a predicate, wherever it sits.** `$$.filter(...)` / `$$.reject(...)` accept the same four spellings in every position a `$$` predicate can appear — narrowing the current stream (`$$ = $$.filter(p)`), a `$facet` branch (`$ = { k: $$.filter(p) }`), and an `$out` write chain (`$$$.archive = $$.filter(p)`) — and each spelling emits identical MQL, so picking one is purely a matter of taste:

```js
jsmql(`$$$.archive = $$.filter({ status: "expired" });`)
jsmql(`$$$.archive = $$.filter(["status", "expired"]);`)
jsmql(`$$$.archive = $$.filter(o => o.status === "expired");`)
// all three → [{ $match: { status: "expired" } }, { $out: "archive" }]
```

The one thing a predicate may not do in these positions is reference `$.<field>`: the parameter already *is* the current document, so `o.status` is the spelling. (Inside a `$$$.<coll>` lookup predicate `$.<field>` means the *outer* doc and is auto-`let`-extracted — a different position, a different rule.)

A worked lodash-style chain — the newest 10 closed orders' distinct products:

```js
jsmql(`$$ = $$.filter({ status: "CLOSED" })
  .sort({ createdAt: -1 })
  .take(10)
  .flatMap("productIds")
  .groupBy({ _id: null, boughtProductIds: $addToSet("$productIds") });`)
// → [ { $match: { status: "CLOSED" } },
//     { $sort: { createdAt: -1 } },
//     { $limit: 10 },
//     { $unwind: "$productIds" },
//     { $group: { _id: null, boughtProductIds: { $addToSet: "$productIds" } } } ]
```

#### Bare-statement stream operations

When the receiver is the bare `$$` stream, you can drop the `$$ =` head entirely and write the chain as a plain statement. It reads like ordinary JS array work and lowers identically to the assignment form:

```js
jsmql(`
  $$.filter(o => o.tier === "gold");
  $$.map(d => ({ id: d._id, name: d.name }));
`)
// → [{ $match: { tier: "gold" } }, { $replaceWith: { id: "$_id", name: "$name" } }]
```

Every stream method works this way (`.filter`, `.map`, `.slice`, `.concat`, `.toSorted`, `.toReversed`, `.flatMap`). Chaining and splitting are interchangeable — these three forms all produce the same MQL:

```js
$$.filter(p).map(f);        // chained
$$.filter(p); $$.map(f);    // split across statements
$$ = $$.filter(p).map(f);   // explicit assignment
```

This holds even for `.toReversed()`, which flips a preceding `$sort`: in the bare form the sort can come from an earlier statement, so `$$.toSorted((a, b) => a.age - b.age); $$.toReversed();` flips the sort from the previous line just as the chained `$$.toSorted(...).toReversed();` does.

> **Note.** In plain JS, `arr.filter(...)` as a bare statement throws the result away. In a jsmql pipeline a bare `$$.filter(...)` statement *transforms the running stream* — each statement is a stage. (Same spirit as `$$.push(...)`.) The bare `$$` receiver is required; for source-switches keep the explicit `$$ = $$$.<coll>.<chain>;` head.

**`.reduce` is not a chain method either** — what a reducer returns in JS decides how it's assigned. A reducer that returns a **scalar or object** (one value) must be **wrapped** into a stream-shaped RHS; a reducer that returns an **array** is already a stream and is assigned directly (see the array-returning form below). The two scalar/object wraps both lower to the same `$group` + `$replaceWith` pair — pick whichever reads best at the call site:

**Scalar wrap** — one `$$.reduce(...)` per named field:

```js
// Single aggregate
jsmql(`$$ = [{ total: $$.reduce((acc, d) => acc + d.amount, 0) }];`)
// → [{ $group: { _id: null, total: { $sum: "$amount" } } },
//    { $replaceWith: { total: "$total" } }]

// Multiple aggregates share one $group
jsmql(`$$ = [{
  count: $$.reduce((acc, d) => acc + 1, 0),
  total: $$.reduce((acc, d) => acc + d.amount, 0),
  best:  $$.reduce((acc, d) => Math.max(acc, d.score), 0)
}];`)
// → [{ $group: { _id: null, count: { $sum: 1 }, total: { $sum: "$amount" }, best: { $max: "$score" } } },
//    { $replaceWith: { count: "$count", total: "$total", best: "$best" } }]
```

**Object reducer** — one `$$.reduce(...)` whose body returns an object naming every accumulator:

```js
jsmql(`$$ = [$$.reduce(
  (acc, d) => ({
    ...acc,
    count: acc.count + 1,
    total: acc.total + d.amount,
    best:  Math.max(acc.best, d.score)
  }),
  { count: 0, total: 0, best: 0 }
)];`)
// → identical to the multi-aggregate scalar wrap above
```

Both forms support the same per-key reducer bodies: `acc + d.<field>` (or `acc.<key> + d.<field>` in the object form) → `$sum`; `acc + 1` → `$sum: 1` (count); `Math.max(acc, d.<field>)` → `$max`; `Math.min(acc, d.<field>)` → `$min`. In the object form each entry must reference `acc.<sameKey>` as the accumulator side, and the init object must declare the same key set as the body (extra or missing keys on either side throw — in JS this would silently work but mean something different).

The `init` value is required for JS-faithfulness but the MQL accumulators have their own neutral elements, so its actual value doesn't matter. Dictionary-build reducers (`(acc, d) => ({...acc, [d.k]: d.v})`) and other richer body shapes are future work.

**Array-returning reducer** — for "flatten the stream by projecting each doc to a sub-doc, optionally filtered". A reducer seeded with `[]` already returns an array — a stream — so it's assigned **directly**, without the surrounding `[ ]`:

```js
// Filter active users with an email, project to their contactDetails sub-doc.
jsmql(`$$ = $$.reduce(
  (acc, d) => (d.active && d.contactDetails.email ? acc.concat(d.contactDetails) : acc),
  []
);`)
// → [{ $match: <translated condition> }, { $replaceWith: "$contactDetails" }]

// Unconditional projection (just the map).
jsmql(`$$ = $$.reduce((acc, d) => acc.concat(d.contactDetails), []);`)
// → [{ $replaceWith: "$contactDetails" }]
```

This form lowers to `$match` (when the body is a `cond ? acc.concat(...) : acc` ternary) + `$replaceWith` (when the projection is a field path on `d`). Equivalent to `$$.filter(d => cond).map(d => d.<field>)` written as a single reducer — pick whichever reads better at the call site. Init must be `[]`; the body must be either `acc.concat(d.<path>)` or a ternary whose alternate branch is bare `acc`. Spread-form variants (`[...acc, d.<x>]`, multi-element wrappers) aren't recognised in v1.

Wrapping it in `[ ]` (`$$ = [$$.reduce(…, [])]`) is **rejected** — that would make a stream whose single document is itself an array. (The scalar and object reducer wraps above keep their `[ ]` because those reducers return a single document, so `[ <doc> ]` is a legitimate one-document stream literal.)

---

## Pipelines

`jsmql()` also compiles **whole aggregation pipelines**. The same function detects pipeline mode from the input and returns an `object[]` instead of a single `object`. No new exports, no separate API.

### Canonical form: `;` between stages

Write each stage as a top-level statement separated by `;`. Any `;` at the top level — including a single trailing `;` — flips `jsmql()` into pipeline mode. Inside one `;`-separated chunk, `,` keeps its in-stage role for update ops:

```js
// Stages read like a script — one statement per stage.
jsmql(({ $ }) => {
  $match($.age > 18);
  $project({ name: 1, total: $.price * $.qty });
  $group({ _id: $.dept, total: $sum($.salary) });
  $sort({ total: -1 });
  $limit(10);
});

// String form, same shape.
jsmql(`
  $match($.active);
  $.score += 1;
  $sort({ score: -1 })
`);
// → [
//     { $match: { $expr: "$active" } },
//     { $set: { score: { $add: ["$score", 1] } } },
//     { $sort: { score: -1 } }
//   ]

// `,` groups into one stage; `;` adds the next
jsmql("$.lineTotal = $.qty * $.unitPrice, $.invoiceCount += 1; $.status = 'done'");
// → [
//     { $set: { lineTotal: { $multiply: ["$qty", "$unitPrice"] }, invoiceCount: { $add: ["$invoiceCount", 1] } } },
//     { $set: { status: "done" } }
//   ]
```

Two things to know:

- **`;` is a hard stage boundary.** Adjacent update ops across `;` do **not** coalesce — `$.a = 1; $.b = 2` produces two `$set` stages. Use `,` if you want a single coalesced stage.
- **A trailing `;` is enough.** `$.a = 1;` returns `[{ $set: { a: 1 } }]`; `$.a = 1` (no `;`) returns `{ $set: { a: 1 } }`. Pick the form that matches what you want from MongoDB — a stage object or a pipeline array.

Each stage body is a regular jsmql expression: arithmetic, accumulators, field refs, and method chains all work as they do anywhere else.

### Chained form: `.$stage(...)` on a stream

A stage can also be written as a **chain link** on a stream — `$$` (the current
collection) or `$$$.<coll>` (another one). It means exactly what the statement form means:

```js
jsmql("$$.$match({ status: 'shipped' }).$sort({ total: -1 }).$limit(5);");
// → [{ $match: { status: "shipped" } }, { $sort: { total: -1 } }, { $limit: 5 }]

// …identical to writing the same three stages as statements:
jsmql("$match({ status: 'shipped' }); $sort({ total: -1 }); $limit(5);");
```

**Two spellings, no winner.** Where a stage has a JavaScript equivalent, both compile to the
same thing — pick whichever reads better for the query at hand:

```js
jsmql("$$.filter({ a: 1 }).take(5);");     // → [{ $match: { a: 1 } }, { $limit: 5 }]
jsmql("$$.$match({ a: 1 }).$limit(5);");   // → [{ $match: { a: 1 } }, { $limit: 5 }]
```

They interleave freely, so a chain can use each where it's clearest:

```js
jsmql("$$.filter(p => p.score > 0).$sort({ score: -1 }).take(10);");
// → [{ $match: { score: { $gt: 0 } } }, { $sort: { score: -1 } }, { $limit: 10 }]
```

Where this earns its keep is a **value position**, where you can't drop into statements.
`$group`, `$unwind`, `$setWindowFields`, `$bucket` and friends have no JavaScript
spelling, so a chain could never reach them:

```js
jsmql(`
const byRegion = $$$.orders
  .$match({ status: "shipped" })
  .$group({ _id: "$region", revenue: $sum("$total") })
  .$sort({ revenue: -1 })
  .$limit(5)
  .map(g => ({ region: g._id, revenue: g.revenue }));
$set({ topRegions: byRegion });
`);
// → [
//     { $lookup: { from: "orders", pipeline: [
//         { $match: { status: "shipped" } },
//         { $group: { _id: "$region", revenue: { $sum: "$total" } } },
//         { $sort: { revenue: -1 } },
//         { $limit: 5 }
//       ], as: "__jsmql.tmp.1" } },
//     { $set: { "__jsmql.var.byRegion": { $map: { … } } } },
//     { $set: { topRegions: "$__jsmql.var.byRegion" } },
//     { $unset: "__jsmql" }
//   ]
```

The name after the `.` must be a real aggregation stage — jsmql invents none — and takes
exactly one argument, its body. Two things that may surprise you:

- **Stages chain only while the chain is still a stream.** A stage runs *inside* the
  pipeline; once a link turns the chain into a **value** — `.map("<field>")` (extracting a
  field, not reshaping a document), `.flatten()`, `.uniq()`, `.sum()`, `.head()`, and the
  other value terminals — everything after it is ordinary array/value work, and a stage
  there has nothing to run in. Put the stages first:

  ```js
  $.x = $$$.c.$match({ a: 1 }).$limit(5).map("f");   // ✅ stages, then values
  $.x = $$$.c.$match({ a: 1 }).map("f").$limit(5);   // ❌ '.$limit(...)' is a pipeline stage,
                                                     //    but its receiver here is a value
  ```

  `$.items.$match(...)` is rejected for the same reason — an in-document array was never a
  stream. Use the array method `.filter(...)`.
- **A correlated `$match` is rewritten for you.** In a `$$$.<coll>` chain, `$.` reads the
  *outer* document. In a `$match` object body MongoDB wouldn't evaluate that (the query
  language ignores variables, so the match would silently return nothing), so jsmql
  re-expresses the body as a predicate — exactly what `.filter({ … })` does. Terms that
  don't read the outer document stay in index-friendly query form:

  ```js
  $.orders = $$$.orders.$match({ userId: $._id, status: "shipped" });
  // → { $lookup: { from: "orders", let: { jsmql_f0__id: "$_id" },
  //                pipeline: [{ $match: { status: "shipped",
  //                                       $expr: { $eq: ["$userId", "$$jsmql_f0__id"] } } }], as: … } }
  ```

### Alternative: bracketed array literal

When you want jsmql to *evaluate to* a pipeline array (rather than statements that build one), wrap the same stage calls in a `[…]` literal. Stages can be written as call expressions or as MongoDB-shaped stage objects — both compile identically and may be mixed in one array.

```js
// Stage-call form inside an array literal — same stages, expression-style.
jsmql(`[
  $match($.age > 18),
  $project({ name: 1, total: $.price * $.qty }),
  $group({ _id: $.dept, total: $sum($.salary) }),
  $sort({ total: -1 }),
  $limit(10)
]`);

// Stage-object form — matches the shape MongoDB emits in Compass and the
// docs. Use this when porting an existing pipeline you've copied verbatim.
jsmql(`[
  { $match: $.age > 18 },
  { $project: { name: 1, total: $.price * $.qty } },
  { $group: { _id: $.dept, total: $sum($.salary) } },
  { $sort: { total: -1 } },
  { $limit: 10 }
]`);
```

Use the bracketed form when you're pasting MQL from MongoDB Compass or the docs (the stage-object shape lets you copy verbatim), or when a build step needs the literal array as a value. For new pipelines, prefer the `;`-separated form above — it reads as JavaScript end-to-end and stays consistent with the update op, `let`-binding, and block-body-arrow forms.

### `$match` indexes by default

In real MongoDB, `$match`'s body can be either a *query document* (`{ field: value }`) or an *aggregation expression* (`$expr: { ... }`). The two look interchangeable, but they aren't: **`$expr` disables index usage**. A naïve translation of `$.email === "alice"` into an `$expr` wrapper turns every match into a collection scan.

jsmql translates the index-safe subset of expressions — field-vs-literal comparisons combined with `&&` and `||` — into the query-document form so indexes still work. Anything outside that subset (computed values, method calls, field-to-field comparisons) stays in `$expr`. When part of the predicate is translatable and part isn't, you get both: the indexable part as a query doc, the rest in `$expr` on the same `$match`.

```js
// Simple equality → indexable query doc
jsmql("[{ $match: $.email === \"alice@example.com\" }]");
// → [{ $match: { email: "alice@example.com" } }]

// Ordered comparison → indexable
jsmql("[{ $match: $.age > 18 }]");
// → [{ $match: { age: { $gt: 18 } } }]

// && of two translatable clauses → merged into one query doc
jsmql(`[{ $match: $.status === "active" && $.age > 18 }]`);
// → [{ $match: { status: "active", age: { $gt: 18 } } }]

// || of translatable branches → $or
jsmql(`[{ $match: $.role === "admin" || $.role === "owner" }]`);
// → [{ $match: { $or: [{ role: "admin" }, { role: "owner" }] } }]

// Partial: status indexed via query doc; computed comparison stays in $expr
jsmql(`[{ $match: $.status === "active" && $.score > $.threshold }]`);
// → [{ $match: { status: "active", $expr: { $gt: ["$score", "$threshold"] } } }]

// Untranslatable shape → falls back to $expr entirely
jsmql("[{ $match: $.name.toLowerCase() === \"alice\" }]");
// → [{ $match: { $expr: { $eq: [{ $toLower: "$name" }, "alice"] } } }]

// Object-literal body is passed through unchanged (also the escape hatch)
jsmql("[{ $match: { age: { $gt: 18 } } }]");
// → [{ $match: { age: { $gt: 18 } } }]
```

**Index-friendly JS patterns that translate to MongoDB query operators.** Several common JS shapes have direct query-language equivalents — the translator recognises them and emits the indexable form:

```js
// Array-element / set-membership tests
jsmql(`[{ $match: $.tags.includes("vip") }]`);
// → [{ $match: { tags: "vip" } }]                          // implicit array-element match
jsmql(`[{ $match: ["active", "trial"].includes($.status) }]`);
// → [{ $match: { status: { $in: ["active", "trial"] } } }]
jsmql(`[{ $match: $.tags.includes("a") && $.tags.includes("b") }]`);
// → [{ $match: { tags: { $all: ["a", "b"] } } }]           // folded $all

// Regex match — receiver field, regex-literal arg
jsmql(`[{ $match: $.name.match(/^a/i) }]`);
// → [{ $match: { name: /^a/i } }]

// Nested-array predicate
jsmql(`[{ $match: $.items.some(it => it.qty > 5 && it.tag === "vip") }]`);
// → [{ $match: { items: { $elemMatch: { qty: { $gt: 5 }, tag: "vip" } } } }]

// Existence / type / size / modulo
jsmql(`[{ $match: $.deletedAt === undefined }]`);
// → [{ $match: { deletedAt: { $exists: false } } }]
jsmql(`[{ $match: typeof $.x === "boolean" }]`);
// → [{ $match: { x: { $type: "bool" } } }]                 // JS "boolean" → BSON "bool"
jsmql(`[{ $match: $.items.length === 3 }]`);
// → [{ $match: { $expr: { $eq: [{ $cond: { if: { $isArray: "$items" }, then: { $size: "$items" }, else: { $strLenCP: { $ifNull: ["$items", ""] } } } }, 3] } } }]
//   `.length` vs a natural number is a string-or-array length (works on both, unlike a bare $size).
//   Compared against a non-natural value (=== 3.5, === "x"), `.length` reads as a literal field
//   path instead → { "items.length": 3.5 }. To read a field literally named `length` against a
//   natural number, use $getField($.items, "length").
jsmql(`[{ $match: $.x % 5 === 0 }]`);
// → [{ $match: { x: { $mod: [5, 0] } } }]
```

`.includes(<literal>)` on a field receiver diverges from the expression-form translation — in `$match` position it emits the bare `{ field: value }` shape (which matches arrays-containing-value or scalar equality, but NOT string substring). Use `.match(/value/)` if you want substring match in `$match`.

**Known semantic divergences.** Query-language equality differs from aggregation `$eq` in three ways: array fields (query mode matches array elements), `$ne` with missing fields (the `!== <value>` shape excludes missing docs), and field-to-field comparison (not done; stays in `$expr`). For null/missing handling, `===` / `!==` and `==` / `!=` translate to two distinct index-friendly shapes — see the [strict vs loose null table](#-vs--null-and-missing-fields).

```js
// Strict — only explicit null matches; missing fields excluded
jsmql("[{ $match: $.deletedAt === null }]");
// → [{ $match: { deletedAt: { $type: "null" } } }]

// Loose — both null AND missing match
jsmql("[{ $match: $.deletedAt == null }]");
// → [{ $match: { deletedAt: null } }]
```

The full rule table and divergence reference live in [docs/specs/match-query-translation.md](specs/match-query-translation.md).

### Local bindings (`let`)

Pipelines can introduce **named local helpers** with `let`. Each binding is scoped to the rest of the pipeline; the compiler materialises it under a single compiler-owned namespace (`__jsmql.var.<name>`) and emits one cleanup `$unset` at the end.

A `let` binding is **reassignable** — a later `name = …` re-`$set`s it, just like JavaScript. Each reassignment is its own `$set` stage (a read-after-write needs a separate stage):

```js
jsmql`
  let basePrice = $.price * $.qty;
  basePrice = basePrice * 0.9;          // 10% discount, in place
  $project({ total: basePrice });
`;
// → [
//   { $set: { "__jsmql.var.basePrice": { $multiply: ["$price", "$qty"] } } },
//   { $set: { "__jsmql.var.basePrice": { $multiply: ["$__jsmql.var.basePrice", 0.9] } } },
//   { $project: { total: "$__jsmql.var.basePrice" } },
//   { $unset: "__jsmql" },
// ]
```

`+= -= *= …` and `++ / --` work on a `let` too (they desugar to the same `$set`).

Use **`const`** for a binding that must not change. It declares and reads identically to `let`, but reassigning it is a compile-time error:

```js
jsmql`
  const basePrice = $.price * $.qty;
  basePrice = basePrice * 0.9;          // ✗
`;
// → Error: Cannot reassign `basePrice` — it is a `const` binding.
//   Declare it with `let basePrice = …` instead if its value needs to change.
```

```js
jsmql`
  let subtotal = $.price * $.qty;       // sub-total before tax/shipping
  let withTax  = subtotal * 1.2;        // with tax
  let withShip = withTax + $.shipping;  // with tax and shipping
  $project({ sku: 1, subtotal, withTax, final: withShip });
`;
```

Lowers to:

```js
[
  { $set: { "__jsmql.var.subtotal": { $multiply: ["$price", "$qty"] } } },
  { $set: { "__jsmql.var.withTax":  { $multiply: ["$__jsmql.var.subtotal", 1.2] } } },
  { $set: { "__jsmql.var.withShip": { $add: ["$__jsmql.var.withTax", "$shipping"] } } },
  { $project: { sku: 1,
                subtotal: "$__jsmql.var.subtotal",
                withTax:  "$__jsmql.var.withTax",
                final:    "$__jsmql.var.withShip" } },
  { $unset: "__jsmql" }
]
```

Why use `let` instead of `$.tmp = …; … ; delete $.tmp`:

- Each derived value sits on its own line — natural spot for a one-line `// …` comment.
- No collision risk: even if your document has a real field named `subtotal`, the let lives under `__jsmql.var.subtotal` and never touches it.
- No forgotten cleanup — the compiler appends the `$unset` automatically.
- `subtotal` (a bare identifier) at call sites reads visually distinct from `$.subtotal` (a real document field).

**Scope rules.** A let is visible from its declaration to the end of the pipeline, with one exception: stages that *replace* the document drop the let. Those stages are `$group`, `$bucket`, `$bucketAuto`, `$replaceRoot`, and `$replaceWith`. Referring to a let after any of these is a compile-time error:

```js
jsmql`
  let total = $.price * $.qty;
  $group({ _id: $.cat });
  $match(total > 100);  // ← error
`;
// → CodegenError: `total` is a `let` binding and can't be read after `$group` —
//   the stage replaces the document. Inline the expression into the $group body,
//   or rebind after the stage with another `let`.
```

`$project` is **not** in the reshape-clearing set, because expression-mode (`{ x: $.y + 1 }`) and exclusion-mode (`{ a: 0 }`) projections preserve the rest of the document. If you write an inclusion-mode `$project` that omits `__jsmql`, any later let reference will silently coerce to `null` at runtime — same trap as today's manual `$.tmp = …` + `delete` pattern. Place inclusion-mode projections at the end of the pipeline whenever possible.

**Indexing pitfall.** A let materialises through `$addFields`/`$set`. A `$match` on a let-bound value cannot use an index, and the optimiser cannot push that `$match` past the `$set` that produced the field. Place index-eligible `$match`es on real document fields **before** your `let` bindings:

```js
// Good — index on $.status is preserved by the leading $match
jsmql`
  $match({ status: "shipped" });
  let revenue = $.price * $.qty;
  $sort({ revenue: -1 });
`;

// Suboptimal — the $match below the let cannot use any index on $.status
jsmql`
  let revenue = $.price * $.qty;
  $match($.status === "shipped" && revenue > 100);
  $sort({ revenue: -1 });
`;
```

**Bracketed form.** `let` also works as an element of a `[…]`-form pipeline:

```js
jsmql("[let big = $.score > 100, $match(big), $sort({ score: -1 })]");
```

**Sub-pipelines.** Outer lets are not visible inside `$lookup.pipeline`, `$unionWith.pipeline`, or `$facet.*` branches. Each sub-pipeline can declare its own lets independently — they live inside that sub-pipeline only.

**Not the same as `$let`.** MongoDB's `$let` operator is *expression-scoped* — the binding lives inside one `in:` clause. jsmql's `let` is *pipeline-scoped*. They are different constructs that happen to share a name.

### Compile-time constants (folding)

When a `const`/`let` right-hand side is a **compile-time constant** — a value that doesn't depend on the document or the environment — jsmql evaluates it once at compile time and **inlines the value** everywhere the name is used. No `$set` stage, no `__jsmql` namespace, no `$unset`. And because the declaration emits no stage, a preamble of constants no longer forces Pipeline mode — so a constant plus a predicate compiles to a clean, indexable **Filter**:

```js
jsmql("const userId = 0x507f1f77bcf86cd799439011; $.userId === userId");
// → { userId: ObjectId("507f1f77bcf86cd799439011") }

jsmql("const msInDay = 24 * 60 * 60 * 1000; $.elapsedMs > msInDay");
// → { elapsedMs: { $gt: 86400000 } }
```

A "compile-time constant" is any pure, deterministic expression over literals and earlier constants — arithmetic, `new Date("2020-01-01")`, ObjectId literals, array/object literals, and (see the method sections) string/array transforms. A binding whose RHS reads the document (`$.x`), the clock (`new Date()`), or the RNG (`Math.random()`) is **not** constant, so it keeps the runtime `$set` binding described above. This means a constant folds the same way in every entry point, including per call in [`jsmql.compile`](#parameterised-queries-jsmqlcompile) (a constant built from a parameter folds against each call's arguments).

> A constant expression that can't be represented as a MongoDB literal — e.g. one that evaluates to `Infinity` or `NaN` (`1 / 0`) — is a compile-time error rather than silently-broken MQL.

### Sub-pipelines

`$lookup`, `$unionWith`, and `$facet` carry nested pipelines inside their stage body. jsmql recognises these positions and recurses, so the `$match` translation rule and the strict typo check apply uniformly:

```js
jsmql(`[{
  $lookup: {
    from: "orders",
    let: { uid: $._id },
    pipeline: [
      { $match: $.userId === $$uid },     // field-to-let-var — stays in $expr
      { $project: { total: 1 } }
    ],
    as: "userOrders"
  }
}]`);
```

### Detection and typos

Pipeline mode kicks in two ways:

- **`;`-separated form.** Any top-level `;` flips `jsmql()` into pipeline mode. Every statement must be a recognised stage call, a update op, or a `let` binding.
- **Bracketed form.** A top-level array enters pipeline mode when its first element looks like a stage attempt — a single-`$<name>`-key object literal, or a `$<name>(...)` call. Once pipeline mode is active, every element must be a recognised stage.

Either way, mistakes surface immediately with a Levenshtein-based suggestion:

```js
jsmql("[{ $macth: $.age > 18 }]");
// → CodegenError: Element 0 of pipeline: '$macth' is not a known
//                 aggregation stage. Did you mean '$match'?
```

A plain value array like `[1, 2, 3]` is *not* a pipeline — the first element doesn't look like a stage attempt, so jsmql leaves it as a literal array expression.

### What stages are supported?

All 45 stages defined in the MongoDB aggregation spec, including: `$addFields`, `$bucket`, `$bucketAuto`, `$count`, `$densify`, `$documents`, `$facet`, `$fill`, `$geoNear`, `$graphLookup`, `$group`, `$limit`, `$lookup`, `$match`, `$merge`, `$out`, `$project`, `$redact`, `$replaceRoot`, `$replaceWith`, `$sample`, `$search`, `$set`, `$setWindowFields`, `$skip`, `$sort`, `$sortByCount`, `$unionWith`, `$unset`, `$unwind`, `$vectorSearch`, and the rest.

---

## Function Form

In addition to a string, `jsmql()` and `jsmql.validate()` accept a **function** whose body is the expression — either an arrow `({ $ }) => …` or the `function` keyword (`function ({ $ }) { return … }`). The runtime calls `Function.prototype.toString()`, extracts the body, and runs it through the same parser as the string form:

```js
const { jsmql } = require("@koresar/jsmql");

jsmql(({ $ }) => $.age > 18);
// → { age: { $gt: 18 } }                          (Filter — no `;`, so it dispatches like the string form)

jsmql(function ({ $ }) { return $.age > 18 });
// → { age: { $gt: 18 } } — same result; the `function` keyword is equivalent

jsmql(function named({ $ }) { return $.age > 18 });
// → identical; a named function expression's name is parsed and discarded
//   (it's unreachable in MQL — there is no recursion)

jsmql(({ $ }) =>
  [$.streetNo, $.street, $.suburb, $.state, $.country, $.postcode]
    .filter((x) => typeof x === "string" && x !== "")
    .map((x) => x.trim())
    .join(" "),
);
// identical MQL to the equivalent template-string form, but prettier and oxfmt
// will indent and line-break it like any other JS — that is the whole point.
```

**Why use it.** JavaScript formatters (prettier, oxfmt) treat template-literal contents as opaque strings. Long jsmql expressions sit as one un-broken line. Wrapping the expression in a plain function lets every JS formatter handle it for free — no plugin, no config.

### Block-body arrows for pipelines

A block-body arrow `({ $ }) => { stmt; stmt; }` is the function-form mirror of the canonical `;`-separated pipeline string form. The body is a sequence of jsmql statements separated by `;`, with `,` keeping its in-stage role:

```js
jsmql(({ $, $match }) => {
  $match($.status === "pending" && $.paidAt != null);
  ($.lineTotal = $.qty * $.unitPrice), ($.invoiceCount += 1);
  delete $.tempToken, delete $._processingState;
  $.status = "complete";
});
// → [
//     { $match: { status: "pending", paidAt: { $ne: null } } },
//     { $set: { lineTotal: …, invoiceCount: { $add: ["$invoiceCount", 1] } } },
//     { $unset: ["tempToken", "_processingState"] },
//     { $set: { status: "complete" } }
//   ]
```

The `function` keyword mirrors both shapes: `function ({ $ }) { return <expr> }` is the value form (≡ `({ $ }) => <expr>`), and `function ({ $ }) { stmt; stmt; }` is the pipeline form (≡ the block-body arrow above).

Two formatter quirks worth knowing about. First, prettier and oxfmt wrap top-level assignment statements in parens (`($.x = …)`) when they appear in a position that could be read as a destructuring assignment — the parser accepts this transparently. Second, JavaScript's comma operator combines `$.a = 1, $.b = 2` into a single expression statement; the parser handles that as an in-stage update op chain, identical to the string form.

`return` is **not** part of jsmql — block bodies are statement lists, not JavaScript control flow. Using `return` inside a block-body arrow throws a clear `FunctionInputError` pointing at either the `;`-separated form or an expression-body arrow as alternatives.

### Restrictions

- **Arrow or `function`, but synchronous and non-generator.** Both `({ $ }) => …` and `function ({ $ }) { … }` are accepted as the input (a named function expression's name is parsed but discarded — it's unreachable in MQL). `async` functions and generators (`function*`) are rejected, with a message pointing at the synchronous form.
- **No `return` inside a block body.** Use `;`-separated statements (block body) or a plain expression body — never both, never with `return`. (A single-`return` `function` body is the exception: `function ({ $ }) { return <expr> }` *is* the value form, exactly like `({ $ }) => <expr>`.)
- **No outer-scope variables.** `Function.prototype.toString()` returns text, not a closure — values from the surrounding scope are unresolvable. Two options for parameterising a query exist instead: the [template-tag form](#template-tag-form-jsmql) for one-shot interpolation, and the [`jsmql.compile(fn)` form](#parameterised-queries-jsmqlcompile) for reusable parameterised queries:
  ```js
  const minAge = 21;
  jsmql(({ $ }) => $.age > minAge);              // ❌ error: Unknown identifier 'minAge'
  jsmql`$.age > ${minAge}`;                      // ✓ template tag — value interpolated
  jsmql.compile(({ minAge }, { $ }) => $.age > minAge)({ minAge });   // ✓ named param
  ```
- **The toolbox destructure binds `$` to the document context.** `({ $ }) =>` is the idiom — the destructured `$` is the document root; the `$$` / `$$$` / `$$$$` context refs and `$`-operators come from the same object. Destructuring nothing (or a plain identifier) is rejected.

When an unknown identifier is encountered in the function-form path, the error message also points at the template-tag form of `jsmql` as the right tool for closure interpolation.

### Escape-hatch operators (`$op` destructure)

Direct `$op(...)` calls (e.g. `$dateDiff`, `$sampleRate`, `$stdDevPop`) work inside the function body, but TypeScript / your IDE will flag the operator name as an unknown identifier. To silence that warning, list the operators you use alongside `$` in the toolbox destructure:

```js
jsmql(({ $, $dateDiff }) =>
  $dateDiff({ startDate: $.lastLoginAt, endDate: new Date(), unit: "day" }) ?? -1,
);
```

The arrow receives a single destructured toolbox object — the document root `$`, the context refs, and the `$`-operators — and listing the names is optional, types-only convenience: the destructured names are typed as callables but never evaluated. The runtime strips the parameter list before parsing, so the body is identical to writing the call directly. Any `$`-prefixed name in the toolbox destructure is accepted by the type system; whether it is a real MongoDB operator is checked at compile time by the codegen.

---

## Partial expressions (`jsmql.expr`)

`jsmql()` is opinionated: it returns a Filter (for `db.coll.find(filter)`) or an aggregation Pipeline array (for `db.coll.aggregate(pipeline)` *and* for the pipeline-form of `db.coll.updateOne(filter, update)`). When you need a **raw aggregation expression** — the shape that goes *inside* a hand-written Pipeline stage body, or the bare `{ $set: … }` update document for a doc-form `updateOne` — call `jsmql.expr(input)` instead.

`jsmql.expr` accepts the same three call shapes as `jsmql()` (string / arrow / template tag) and differs in two branches:

- **Bare expression (no `;`)** — `jsmql.expr()` lowers directly to its aggregation-expression form, with no Filter wrapper and no `$expr` envelope. `jsmql()` would wrap a non-predicate expression in `$expr` to produce a legal Filter.
- **Update-filter input (single stage)** — `jsmql.expr()` returns the bare `{ $set: … }` / `{ $unset: … }` document. `jsmql()` wraps the same output in a single-element pipeline array (`[{ $set: … }]`) so it can be passed directly to `db.coll.updateOne(filter, update)`, which only evaluates aggregation expressions on the RHS when the second argument is an array.

`;`-separated input always produces a Pipeline and array-literal Pipelines always pass through — those branches are identical between the two entry points.

```js
// Filter — for db.coll.find(filter)
db.users.find(jsmql("$.age > 18 && $.status === 'active'"));
// → db.users.find({ age: { $gt: 18 }, status: "active" })

// Pipeline — for db.coll.aggregate(pipeline)
db.users.aggregate(jsmql(`
  $match($.age > 18);
  $project({ name: 1, email: 1 });
`));
// → db.users.aggregate([{ $match: { age: { $gt: 18 } } }, { $project: { name: 1, email: 1 } }])

// updateOne — `jsmql()` returns an aggregation pipeline so RHS expressions
// like `.toUpperCase()` actually evaluate server-side
db.users.updateOne({ _id: 123 }, jsmql("$.name = $.name.toUpperCase()"));
// → db.users.updateOne({ _id: 123 }, [{ $set: { name: { $toUpper: "$name" } } }])

// Raw aggregation expression — for embedding inside a hand-written stage body
db.users.aggregate([
  { $addFields: { discount: jsmql.expr("$.price * (1 - $.loyalty.multiplier)") } },
]);
```

⚠️ **Don't pass `jsmql.expr()` directly to `updateOne()`.** The bare-doc form `{ $set: { name: { $toUpper: "$name" } } }` would silently store the literal expression object instead of evaluating `$toUpper` — MongoDB only treats `updateOne`'s second argument as an aggregation pipeline when it is an array. Use `jsmql()` for the call site; reserve `jsmql.expr()` for the slot inside another structure.

The rule of thumb: **the function you call should match the call site**. `find()`, `aggregate()`, `updateOne()` → `jsmql()`. Inside a hand-written stage body or a `$cond`'s `then`-branch (where you want the raw aggregation expression) → `jsmql.expr()`.

---

## Strict-shape entry points (`jsmql.filter`, `jsmql.pipeline`, `jsmql.update`)

`jsmql()` is polymorphic — it picks Filter or Pipeline from the input. When the call site demands a specific shape and a silent mis-dispatch would be a footgun, use one of the three strict entry points. Each accepts the same string / arrow / template-tag inputs `jsmql()` does, but refuses to produce the other shape and throws an actionable error instead.

| Function | Returns | Throws on |
|---|---|---|
| `jsmql.filter(input)` | a single Filter document | any Pipeline-shaped input |
| `jsmql.pipeline(input)` | a Pipeline (stage array) | a bare expression that would lower to a Filter |
| `jsmql.update(input)` | a Pipeline (stage array) | a bare expression, **and** any stage outside the update-pipeline whitelist |

(The function is `update`, not `updateFilter`, even though the Node MongoDB driver types the slot as `UpdateFilter<TSchema>` — "filter" in that type name routinely trips developers into reaching for it when they meant the query document. The MongoDB type name stays as the driver defines it; we just don't repeat the confusing half of it on this call.)

### `jsmql.filter(input)` — for `db.coll.find(filter)`

```js
db.users.find(jsmql.filter("$.age > 18 && $.status === 'active'"));
// → db.users.find({ age: { $gt: 18 }, status: "active" })

jsmql.filter("$match($.age > 18)");
// Error: jsmql.filter() expects a Filter, but received a top-level '$match'
//        stage call. Call jsmql.pipeline() or jsmql() for Pipeline output — or,
//        if you wanted a Filter, drop the `$match(...)` wrapper and pass the
//        predicate directly to jsmql.filter().
```

The accepted branch is identical to the no-`;` path of `jsmql()` — same indexable-conjunct translation, same `$expr` fallback for the untranslatable residual. The only difference is what gets rejected.

### `jsmql.pipeline(input)` — for `db.coll.aggregate(pipeline)`

```js
db.users.aggregate(jsmql.pipeline(`
  $match($.age > 18);
  $sort({ age: 1 });
  $project({ name: 1, email: 1 });
`));

jsmql.pipeline("$.age > 18");
// Error: jsmql.pipeline() expects a Pipeline (one or more aggregation
//        stages — `;`-separated, a top-level stage call, or a stage-array
//        literal), but received a bare expression that would lower to a
//        Filter document. Call jsmql.filter() or jsmql() for Filter output,
//        or wrap the predicate as `$match(...)` to make it a Pipeline.
```

A single top-level stage call (`$match(...)`), single stage-object literal (`{ $match: ... }`), update-op chain, and array-literal Pipeline are all accepted — exactly the same auto-wrap rule `jsmql()` uses for Pipeline shapes.

### `jsmql.update(input)` — for `db.coll.updateOne(filter, update)` / `updateMany`

```js
db.users.updateOne(
  { _id: 123 },
  jsmql.update("$.name = $.name.toUpperCase(), $.updatedAt = new Date()"),
);
// → db.users.updateOne(
//     { _id: 123 },
//     [
//       { $set: { name: { $toUpper: "$name" }, updatedAt: { $toDate: "$$NOW" } } },
//     ],
//   )

jsmql.update("$match($.age > 18); $set({ x: 1 })");
// Error: jsmql.update() rejected '$match' (stage 0): MongoDB's
//        aggregation-pipeline update form only accepts $addFields, $project,
//        $replaceRoot, $replaceWith, $set, $unset. Use jsmql.pipeline() if
//        you need other stages.
```

Output is **always** an array — never the legacy bare-document update form. That form silently treats RHS expressions as object literals, which is exactly the kind of footgun this entry point exists to avoid. Passing `jsmql.update(...)` to the driver guarantees expressions like `$.name.toUpperCase()` evaluate server-side instead of landing in the document as the literal object `{ $toUpper: "$name" }`.

The allowed stages are MongoDB's [aggregation-pipeline update whitelist](https://www.mongodb.com/docs/manual/reference/method/db.collection.updateOne/#update-with-aggregation-pipeline): `$addFields`, `$project`, `$replaceRoot`, `$replaceWith`, `$set`, `$unset`. Anything else (e.g. `$match`, `$sort`, `$group`) is rejected at compile time with the offending stage name and position in the message, before MongoDB would reject the same query at runtime with a less helpful error.

### When to use each

- Call site is `find()` / `deleteOne()` / `countDocuments()` → `jsmql.filter()`.
- Call site is `aggregate()` → `jsmql.pipeline()`.
- Call site is `updateOne()` / `updateMany()` → `jsmql.update()`.
- The same source string might legitimately produce either Filter or Pipeline → `jsmql()`.
- Inside another structure (a hand-written stage body, the `then` branch of a `$cond`) → `jsmql.expr()`.

Each strict entry has a parameterised `.compile` variant (`jsmql.filter.compile`, `jsmql.pipeline.compile`, `jsmql.update.compile`) for reusable parameterised queries that keep the same shape guarantee — see [Shape-specific compile builders](#shape-specific-compile-builders).

---

## Command Line (`jsmql`)

Installing the package puts a `jsmql` command on your `PATH`. It is a `jq`-style transpiler: **JSMQL source on stdin, MQL JSON on stdout**. A positional argument or `--file <path>` can supply the source instead of stdin.

```sh
echo '$.age > 18' | jsmql
# {
#   "age": { "$gt": 18 }
# }

jsmql --pipeline -c '$match($.age > 18); $sort({ age: -1 })'
# [{"$match":{"age":{"$gt":18}}},{"$sort":{"age":-1}}]
```

With no flag, the output shape is dispatched exactly like `jsmql()` (a top-level `;` makes it a Pipeline). The mode flags lock the shape to one of the entry points above:

| Flag | Output | Same as |
| --- | --- | --- |
| *(none)* | Filter or Pipeline | `jsmql()` |
| `--filter` | Filter document | `jsmql.filter()` |
| `--pipeline` | stage array | `jsmql.pipeline()` |
| `--expr` | aggregation expression | `jsmql.expr()` |
| `--update` | update pipeline | `jsmql.update()` |
| `--validate` (or `--check`) | `{ valid, errors }`; exits 1 if invalid | `jsmql.validate()` |

Output is pretty-printed (2-space) by default; `-c` / `--compact` emits one line, `--tab` indents with tabs, `--indent N` with N spaces. Parameterise a query with `jq`'s own flags — the source must then be a parameterised arrow (see [Parameterised Queries](#parameterised-queries-jsmqlcompile)):

```sh
echo '({ minAge }, { $ }) => $.age > minAge' | jsmql --argjson minAge 18
# { "age": { "$gt": 18 } }

# Params combine with any shape flag — routed through the matching *.compile():
echo '({ minAge }, { $ }) => { $match($.age > minAge) }' | jsmql --pipeline --argjson minAge 18
# [{ "$match": { "age": { "$gt": 18 } } }]
```

`--arg name value` binds a string; `--argjson name value` binds a JSON value; both repeat. Params work with any output-shape flag (each routes through the matching `*.compile()` builder and enforces that shape) and with `--validate` (which validates the parameterised arrow's shape). Compile errors print with a caret at the offending position. Exit codes: `0` success, `1` compile error (or `--validate` invalid), `2` usage error. Run `jsmql --help` for the full list.

---

## Parameterised Queries (`jsmql.compile`)

For queries that run repeatedly with different values — a typical "list users in region X above age Y" handler — use `jsmql.compile(fn)`. It parses the arrow once and returns a callable that you invoke with a fresh **params object** on every call. Each call walks the cached AST and substitutes the bound values inline as MQL literals; no re-parsing happens.

```js
const { jsmql } = require("@koresar/jsmql");

const eligibleUsersQuery = jsmql.compile(
  ({ minAge, region }, { $, $match, $project }) => [
    $match($.age >= minAge && $.region === region && $.status === "active"),
    $project({ id: $._id, name: $.name, email: $.email }),
  ],
);

eligibleUsersQuery({ minAge: 21, region: "AU" });
// → [
//   { $match: { age: { $gte: 21 }, region: "AU", status: "active" } },
//   { $project: { id: "$_id", name: "$name", email: "$email" } }
// ]

eligibleUsersQuery({ minAge: 65, region: "US" });
// → same shape, with new values
```

### String input

The first argument may also be a **string** containing the same arrow source — useful when the query text is stored elsewhere (config, file, database) and you want the same parse-once-bind-many semantics:

```js
const eligibleUsersQuery = jsmql.compile(
  "({ minAge, region }, { $ }) => $.age >= minAge && $.region === region",
);

eligibleUsersQuery({ minAge: 21, region: "AU" });
// → { $and: [{ $gte: ["$age", 21] }, { $eq: ["$region", "AU"] }] }
```

The destructure is still the only way to declare parameters; placeholder syntaxes like `${name}` inside the string are deliberately **not** supported — they would break jsmql's strict-JS-subset rule and collide with real template literals. If the query string isn't function-shaped (an arrow `(params, { $ }) => …` or a `function (params, { $ }) { … }`), you get the same `FunctionInputError` the function form would have raised.

### The arrow signature

The compile-form arrow takes up to two destructures, both optional, in this order — the params destructure first, the toolbox destructure second:

```
(params?, { $, …ops }?) => body
```

Each slot is recognised by **shape**:

| Slot shape | Interpretation |
|------------|----------------|
| Destructure with at least one non-`$` key (`{ minAge, region }`) | Params slot — the binding names listed here must be keys on the params object at call time. |
| Destructure whose keys are all `$`-prefixed (`{ $ }`, and any of `$$` / `$$$` / `$$$$` and `$op` names, e.g. `{ $, $match, $project }`) | Toolbox slot — the document root `$`, context refs, and `$`-operators; listing operator names is types-only IDE convenience. |
| A bare identifier or a bare `$` (not destructured) | Rejected. |

You can omit either slot as long as the remaining one keeps its position. `jsmql.compile(({ minAge }) => …)` is the minimal form when you only need the params.

### Values are inlined as MQL literals

A binding value flows into the MQL output exactly the way an interpolated template-tag value does — as a JSON literal:

```js
jsmql.compile(({ allowed }, { $ }) => $.grade in allowed)({ allowed: ["A", "B"] });
// → { $in: ["$grade", ["A", "B"]] }
```

In particular, `$match` keeps its **index-friendly** translation when the comparison is against a binding: the compiled stage emits MongoDB query-language form, not `$expr`-wrapped aggregation form, so indexes on the compared field still work.

### Restrictions on the params destructure

- **No defaults** — `({ minAge = 18 }) => …` is rejected. The parser cannot evaluate arbitrary default expressions (e.g. `= config.x`), and allowing only literal defaults would create a confusing JS-subset rule. For a runtime fallback, use nullish coalescing at the call site: `q({ minAge: input ?? 18 })`.
- **No nested destructure** — `({ a: { b } })`. Use a flat key→value map.
- **No rest pattern** — `({ ...rest })`. List bindings explicitly.
- **No array destructure** — `[a, b]`. Params is always an object.
- **No mixing `$`-keys and non-`$`-keys** in the same destructure. Keep them as two separate destructures: `(params, { $, … }) => …`.

Each restriction produces a clear `FunctionInputError` that names the problem and points at the fix.

### Param values

Each value on the params object must be a JSON-safe literal: number, string, boolean, null, plain array, or plain object. The same validation that template-tag interpolation uses rejects `NaN`, `Infinity`, functions, Symbols, `undefined`, BigInts, and circular references — at call time, with a `JsmqlInterpolationError` that names the binding key.

BSON instance values — `Date`, `RegExp`, `Uint8Array` (and `Buffer`), and ObjectId (duck-typed via `_bsontype`) — are passed through to the MQL output as the live JS instance, exactly the way the template-tag form preserves them. The pass-through works **anywhere** in the binding value: at the top level, nested inside an object, nested inside an array, and arbitrarily deep. The same shape that works via interpolation also works via parameter bindings — no manual unpacking required at the call site:

```js
// Top-level Date binding — lands in the query doc as a real Date, so MongoDB
// uses the index on `createdAt` for the range scan.
const recentByMethod = jsmql.compile(({ method, cutoff }, { $ }) =>
  $.method === method && $.createdAt >= cutoff,
);
recentByMethod({ method: "postalDelivery", cutoff: new Date("2026-01-01") });
// → { method: "postalDelivery", createdAt: { $gte: <Date 2026-01-01> } }

// Nested Date inside a binding object — preserved at its position in the
// $set body, alongside JSON-shaped siblings.
const stampWindow = jsmql.compile(({ window }) => ($.activeWindow = window));
stampWindow({ window: { startedAt: new Date("2026-01-01"), mode: "fast" } });
// → [{ $set: { activeWindow: { startedAt: <Date 2026-01-01>, mode: "fast" } } }]
```

If a binding referenced in the body is missing from the params object, the call throws `UnknownIdentifierError` naming the binding (and the aliased outer key if `{ key: alias }` was used).

### Validation

`jsmql.compile(fn)` is throw-style — bad input fails fast. For structured per-call errors, wrap the compiled callable in your own `try`/`catch` and route the thrown error through `jsmql.validate()`'s catch-and-classify branch table by re-throwing into it, or — more commonly — keep the throw and let the upstream error handler decide. `jsmql.validate()` accepts the one-shot input shapes (string, arrow / `function`, template tag) **and** a parameterised-function string (it validates the function's shape with bindings stubbed out); the parameterised callable returned by `.compile` stays throw-only.

### Shape-specific compile builders

`jsmql.compile` is polymorphic — the compiled callable returns a Filter or a Pipeline depending on the arrow body, exactly like `jsmql()`. When the call site has a fixed shape, each strict entry point carries its own `.compile` that locks the output:

```js
const adultsInRegion = jsmql.filter.compile(({ minAge, region }, { $ }) =>
  $.age >= minAge && $.region === region,
);
db.users.find(adultsInRegion({ minAge: 18, region: "AU" }));
// → { age: { $gte: 18 }, region: "AU" }

const recentFirst = jsmql.pipeline.compile(({ minAge }, { $ }) => {
  $match($.age >= minAge);
  $sort({ createdAt: -1 });
});
db.users.aggregate(recentFirst({ minAge: 18 }));
// → [ { $match: { age: { $gte: 18 } } }, { $sort: { createdAt: -1 } } ]

const bumpTier = jsmql.update.compile(({ tier }, { $ }) => ($.tier = tier));
db.users.updateMany({}, bumpTier({ tier: 2 }));
// → [ { $set: { tier: 2 } } ]
```

`jsmql.filter.compile`, `jsmql.pipeline.compile`, `jsmql.update.compile`, and `jsmql.expr.compile` share `jsmql.compile`'s binding mechanics exactly — they only narrow the output and enforce the same shape contract their one-shot siblings do. A compiled builder whose arrow body lowers to the wrong shape throws the identical error the one-shot strict entry would (e.g. `jsmql.pipeline.compile(({ m }, { $ }) => $.age > m)` throws "expects a Pipeline … but received a bare expression" when called).

### Operator autocomplete (`@koresar/jsmql/ops`)

Listing every stage and operator alongside `$` in the toolbox destructure gets tedious. A real-world pipeline mentions five to ten stages plus a handful of escape-hatch expression ops; spelling them out at every call site is bookkeeping the user shouldn't have to do.

The `@koresar/jsmql/ops` subpath is a **pure-types** module that surfaces every jsmql stage and operator as an ambient global. Import it once at the top of your file, keep just `$` in the toolbox destructure, and write `$match(…)`, `$dateAdd(…)`, etc. directly — your IDE will autocomplete names and arg objects, catch typos at compile time, and surface the official MongoDB description and doc link on hover.

```ts
import "@koresar/jsmql/ops"; // ← side-effect import; loads only `declare global` types
import { jsmql } from "@koresar/jsmql";

const eligibleUsersQuery = jsmql.compile(
  ({ minAge, region }: { minAge: number; region: string }, { $ }) => [
    $match($.age >= minAge && $.region == region),
    $project({ id: $._id, name: $.name }),
    $sort({ name: 1 }),
    $skip(20),
    $limit(10),
  ],
);
```

Object-form operators get full key autocomplete from the spec:

```ts
import "@koresar/jsmql/ops";

const recent = jsmql(
  ({ $ }) => $dateAdd({ startDate: $.purchaseDate, unit: "day", amount: 3 }),
  //                  ╰── autocomplete suggests: startDate, unit, amount, timezone?
  //                  ╰── `unit` is typed as the MQL timeUnit literal union
);
```

How it works:

- The compiled module (`dist/ops.js`) is `export {};` — **no exported values, no runtime cost** beyond a single empty module load. Bundlers tree-shake it to nothing in practice. For fully zero-runtime use, add `"@koresar/jsmql/ops"` to your tsconfig `compilerOptions.types` instead of importing.
- The types are **generated at build time from the official MongoDB MQL spec** ([`mongodb/mql-specifications`](https://github.com/mongodb/mql-specifications)), so they always match the operator the server documents — required vs optional args, function-overload shapes (e.g. `$and(x)` vs `$and(x, y, z)`), full descriptions, version metadata, and links.
- The declarations are **global** (via TypeScript's `declare global`): once any file in your project imports the module, the names are visible everywhere. **This is intentional** — every alternative (named imports, namespace imports) gets rewritten by bundlers into `(0, _ops.$match)(…)` form, which the jsmql parser can't recognise. Globals are the only shape that survives every transform. The names all start with `$`, so realistic collisions with user identifiers are nil — `$` as an identifier prefix is the MongoDB convention and isn't used elsewhere in the TS ecosystem.
- The runtime path is unchanged. The jsmql parser already recognises bare `$stage(…)` and `$op(…)` calls regardless of TypeScript's view; this import only quiets TypeScript and gives your IDE something to autocomplete.

Listing operator names in the toolbox destructure (`(…, { $, $match, $project })`) is the per-call-site alternative — `@koresar/jsmql/ops` is preferred when you don't want to maintain those lists.

The import also declares the context-reference prefixes `$$`, `$$$`, and `$$$$`, so arrow-form code using them type-checks instead of erroring on an undeclared name. The collection-scoped (`$$`) and cluster-scoped (`$$$$`) **diagnostic source stages** get full completion and hover docs with annotated option objects:

```ts
import "@koresar/jsmql/ops";

jsmql(({ $ }) => $$.collStats({ storageStats: { scale: 1024 } }));
//                    ╰── autocomplete: indexStats, collStats, planCacheStats, listSearchIndexes
jsmql(({ $ }) => $$$$.currentOp({ allUsers: true }));
//                      ╰── autocomplete: currentOp, listSessions, shardedDataDistribution, …
```

The other context-ref forms (`$$.push(...)`, `$$$.orders.find(...)`, `$$$.reports = …`, stream methods) type-check too, but as `any` for now — precise per-collection typing is future work `[DEF-015]`.

#### Value-method completion on typed values

The lodash-flavoured **value** methods (a JavaScript-array / string / number method jsmql recognises — e.g. `.uniq()`, `.chunk()`, `.groupBy()`, `.capitalize()`, `.clamp()`) are called on *values*, not on a `$`-prefixed global, so their completion depends on the **receiver's type**. Importing `@koresar/jsmql/ops` augments the built-in `Array<T>` / `String` / `Number` types with them, each with a concrete return type so a chain stays completable end to end:

```ts
import "@koresar/jsmql/ops";

// annotate the document once → every hop completes and chains
jsmql(({ $ }: { $: { orders: { total: number; sku: string }[] } }) =>
  $.orders.sortBy("total").takeRight(3).map((o) => o.sku).uniq()
);
```

Completion flows from any value that has a **concrete type** — an annotated `$` (above), a typed static (`Object.values(o)`, `Object.keys(o)`), a literal, or the result of a known-return method earlier in the chain. A **bare, un-annotated `$.field` is `any`**, and `any.uniq()` stays `any`, so a method on it doesn't autocomplete (it also doesn't error). That is a deliberate trade: `$.field` must stay `any` so the operator forms jsmql relies on — `$.age > 18`, `$.price * 1.1` — keep type-checking; a value can't be both an operator operand and a rich method receiver in TypeScript. Type your document to light up completion.

Two points on scope:

- The augmentations are **global** once imported (like the operator globals): jsmql's value methods show up in completion on every array/string/number in files that see the import. They are compile-time jsmql methods — types only, no runtime — so calling one *outside* a jsmql expression would fail at run time; treat their appearance as a jsmql-authoring aid.
- **Object-transform methods** (`.mapValues` / `.pick` / `.omit` / `.invert`, and the like) are **not** augmented. The only interface they could hang on is `Object`, the base of every type, so augmenting it would advertise them on numbers, strings, and arrays too. Write them in jsmql as usual; they simply don't autocomplete.

---

## Template-Tag Form (`` jsmql`…` ``)

For expressions with embedded literal values, call `jsmql` as a template tag:

```js
const { jsmql } = require("@koresar/jsmql");

const minAge = 21;
const expr = jsmql`$.age > ${minAge}`;
// → { $gt: ["$age", 21] }

const statuses = ["active", "pending"];
const expr2 = jsmql`$.status in ${statuses}`;
// → { $in: ["$status", ["active", "pending"]] }

// Complex expression
const expr3 = jsmql`$.age > ${21} && $.status in ${["active"]}`;
// → { $and: [{ $gt: ["$age", 21] }, { $in: ["$status", ["active"]] }] }
```

Template values must be **literals** (numbers, strings, booleans, null, arrays, or plain objects). Field references go in the template string:

```js
// ✓ Correct
jsmql`$.age > ${25}`

// ❌ Wrong — can't interpolate field names as values
const field = "age";
jsmql`$.${field} > ${25}`  // syntax error
```

### BSON instances round-trip

Interpolations are emitted as JSON literals **except** for native BSON instances that have no fidelity-preserving JSON shape — those reach the MQL output as the JS instance itself, which is what the Node MongoDB driver consumes in-situ:

```js
// Date — emitted as a real Date, indexed comparisons still work
const cutoff = new Date("2026-01-01");
jsmql`$.method === ${"postalDelivery"} && $.createdAt >= ${cutoff}`
// → { method: "postalDelivery", createdAt: { $gte: <Date 2026-01-01> } }

// RegExp — used as a query-language regex match
jsmql`$.username === ${/^alice/i}`
// → { username: /^alice/i }
```

Pass-through types: `Date`, `RegExp`, `Uint8Array` (and `Buffer`, which subclasses `Uint8Array`), and ObjectId (duck-typed via `_bsontype`). Everything else goes through `JSON.stringify`. Pass-through also works for **nested** instances — a Date / RegExp / etc. buried inside an interpolated object or array still arrives as a live instance, so realistic operator-call shapes like `` jsmql.expr`$dateDiff(${{ startDate: new Date(...), endDate: new Date(...), unit: "day" })` `` work the way you'd write them by hand.

`jsmql.validate` is polymorphic in the same way, so `` jsmql.validate`$.age > ${minAge}` `` works as the non-throwing counterpart.

---

## Validation

Use `jsmql.validate()` to check syntax without generating output:

```js
const { jsmql } = require("@koresar/jsmql");

jsmql.validate("$.age > 18");
// → { valid: true, errors: [] }

jsmql.validate("age > 18");
// → {
//     valid: false,
//     errors: [{
//       message: "Unknown identifier 'age'. Did you mean '$.age'?",
//       pos: 0,
//       code: "CODEGEN_ERROR"
//     }]
//   }
```

Use `jsmql.validate()` for:
- IDE linters and code completion
- Pre-flight checks before building expressions
- User input validation in forms

---

## Error Messages

When you write invalid jsmql, you get clear error messages with suggestions:

```js
jsmql("age > 18");
// CodegenError: Unknown identifier 'age'. Did you mean '$.age'?

jsmql("$.age > 18 &&");
// ParseError: Unexpected end of expression

jsmql("$.age >>");
// ParseError: Unexpected token '>' at position 7

jsmql('$.status in "active"');
// CodegenError: Right-hand side of 'in' must be an array literal, object literal, or field reference, not a scalar value

jsmql("$.name.frobulate()");
// CodegenError: Unknown method '.frobulate()'.

jsmql("$.name.trinm()");
// CodegenError: Unknown method '.trinm()'. Did you mean '.trim()'?
```

---

## Examples

### Numeric Comparisons

```js
// Find adults
jsmql("$.age >= 18")
// → { $gte: ["$age", 18] }

// Price range
jsmql("$.price > 10 && $.price <= 100")
// → { $and: [{ $gt: ["$price", 10] }, { $lte: ["$price", 100] }] }

// Score calculation
jsmql("($.correct + $.partial * 0.5) / $.total * 100")
// → { $divide: [{ $multiply: [{ $add: ["$correct", { $multiply: ["$partial", 0.5] }] }, 100] }, "$total"] }
```

### String Operations

```js
// Full name
jsmql('$.firstName + " " + $.lastName')
// → { $concat: ["$firstName", " ", "$lastName"] }

// Normalized email
jsmql("$.email.toLowerCase().trim()")
// → { $trim: { input: { $toLower: "$email" } } }

// Check domain
jsmql('$.email.substr($.email.indexOf("@") + 1)')
// → { $substrCP: ["$email", { $add: [{ $indexOfCP: ["$email", "@"] }, 1] }, ...] }
```

### Conditional Logic

```js
// Age category
jsmql('$.age < 13 ? "child" : $.age < 18 ? "teen" : "adult"')
// → nested $cond chain

// Fallback value (chained ?? flattens into a single $ifNull)
jsmql("$.nickname ?? $.firstName ?? 'Unknown'")
// → { $ifNull: ["$nickname", "$firstName", "Unknown"] }
```

### Array Operations

```js
// Status filter
jsmql('$.status in ["active", "pending"]')
// → { $in: ["$status", ["active", "pending"]] }

// Transform array
jsmql("$.prices.map(p => p * 1.1)")
// → { $map: { input: "$prices", as: "p", in: { $multiply: ["$$p", 1.1] } } }

// Filter array
jsmql("$.items.filter(x => x.qty > 0)")
// → { $filter: { input: "$items", as: "x", cond: { $gt: ["$$x.qty", 0] } } }

// Sum array
jsmql("$.amounts.reduce((acc, x) => acc + x, 0)")
// → { $reduce: { input: "$amounts", initialValue: 0, in: { $add: ["$$value", "$$this"] } } }
```

### Date Operations

```js
// Extract year from date field
jsmql("$.createdAt.getFullYear()")
// → { $year: "$createdAt" }

// Days since creation
jsmql("$dateDiff($.createdAt, new Date(), 'day')")
// → { $dateDiff: { startDate: "$createdAt", endDate: { $toDate: "$$NOW" }, unit: "day" } }

// Format date
jsmql('$dateToString($.createdAt, "%Y-%m-%d")')
// → { $dateToString: { date: "$createdAt", format: "%Y-%m-%d" } }
```

### Type Casting

```js
// Convert string to number
jsmql("Number($.stringPrice) * 1.1")
// → { $multiply: [{ $toDouble: "$stringPrice" }, 1.1] }

// Type check
jsmql("typeof $.value === 'string'")
// → { $eq: [{ $type: "$value" }, "string"] }
```

### With Template Tag

```js
const statusFilter = jsmql`$.status in ${["active", "pending"]}`;
// → { $in: ["$status", ["active", "pending"]] }

const ageFilter = jsmql`$.age > ${21}`;
// → { $gt: ["$age", 21] }

// Combine using jsmql() for dynamic composition
const combined = jsmql(`$.age > 21 && $.status in ["active", "pending"]`);
// → { $and: [{ $gt: ["$age", 21] }, { $in: ["$status", ["active", "pending"]] }] }
```

## Replacing Server-Side JavaScript

MongoDB 8.0 deprecated three operators that run JavaScript on the server: `$function`, `$accumulator`, and `$where`. MongoDB's own docs say to rewrite this logic as native aggregation operators. jsmql does that for you — you write JavaScript, and jsmql compiles it to native operators.

For the full pros and cons of server-side JavaScript, see the [README](../README.md#pros-and-cons-of-server-side-javascript). Short version: it's deprecated, slow, can't use indexes, often turned off, and a security risk.

**jsmql does not add new syntax for these three operators.** If you need them on older MongoDB versions, the registry passthrough form still works (e.g. `$function({ body: "...", args: [...], lang: "js" })`). No errors, no warnings — existing code keeps working as-is.

Each migration below shows the deprecated form on top, then the jsmql replacement in **template-tag form** (`` jsmql`…` ``) and **function form** (`jsmql(({ $ }) => …)`).

### `$function` — per-document JavaScript expression

Field arithmetic:

```js
// Deprecated
{ $project: { doubled: { $function: {
    body: "function(x) { return x * 2; }",
    args: ["$qty"],
    lang: "js"
} } } }

// Template-tag form
jsmql`{ doubled: $.qty * 2 }`;

// Function form
jsmql(({ $ }) => ({ doubled: $.qty * 2 }));
```

Conditional reshaping:

```js
// Deprecated
{ $function: {
    body: "function(x) { return x > 100 ? 'high' : 'low'; }",
    args: ["$score"],
    lang: "js"
} }

// Template-tag form
jsmql`$.score > 100 ? "high" : "low"`;

// Function form
jsmql(({ $ }) => ($.score > 100 ? "high" : "low"));
```

String cleanup:

```js
// Deprecated
{ $function: {
    body: "function(s) { return s.toLowerCase().trim(); }",
    args: ["$email"],
    lang: "js"
} }

// Template-tag form
jsmql`$.email.toLowerCase().trim()`;

// Function form
jsmql(({ $ }) => $.email.toLowerCase().trim());
```

### `$where` — predicate inside `find()` / `$match`

`$where` runs a JavaScript predicate over every document. The native replacement is `$expr` wrapping a comparison. Unlike `$where`, `$expr` lets MongoDB use indexes when it can.

```js
// Deprecated
db.users.find({ $where: "function() { return this.age > 18; }" });

// Template-tag form
db.users.find({ $expr: jsmql`$.age > 18` });

// Function form
db.users.find({ $expr: jsmql(({ $ }) => $.age > 18) });
```

Inside an aggregation pipeline, you can use `$match` directly — jsmql translates index-safe predicates to query-document form so MongoDB still uses indexes, and falls back to `$expr` only for parts that can't be expressed as a query (see [Pipelines](#pipelines)):

```js
// Translatable comparison → indexable query doc
jsmql`[{ $match: $.age > 18 }]`;
// → [{ $match: { age: { $gt: 18 } } }]

// Function form
jsmql(({ $ }) => [{ $match: $.age > 18 }]);
```

### `$accumulator` — custom accumulator inside `$group` / `$setWindowFields`

Most uses of `$accumulator` map to a built-in accumulator. Average:

```js
// Deprecated — six JavaScript fields
{ $group: {
    _id: "$category",
    avg: { $accumulator: {
        init:           "function() { return { sum: 0, count: 0 }; }",
        accumulate:     "function(s, v) { return { sum: s.sum + v, count: s.count + 1 }; }",
        accumulateArgs: ["$value"],
        merge:          "function(a, b) { return { sum: a.sum + b.sum, count: a.count + b.count }; }",
        finalize:       "function(s) { return s.sum / s.count; }",
        lang: "js"
} } } }

// Template-tag form
jsmql`[{ $group: { _id: $.category, avg: $avg($.value) } }]`;

// Function form
jsmql(({ $ }) => [{ $group: { _id: $.category, avg: $avg($.value) } }]);
```

For accumulators that need custom state, `$reduce` handles the common shapes natively. Running min/max alongside count:

```js
// Template-tag form
jsmql`
  $.values.reduce(
    (acc, x) => ({
      min: acc.min == null ? x : (x < acc.min ? x : acc.min),
      max: acc.max == null ? x : (x > acc.max ? x : acc.max),
      n:   acc.n + 1
    }),
    { min: null, max: null, n: 0 }
  )
`;

// Function form
jsmql(({ $ }) =>
  $.values.reduce(
    (acc, x) => ({
      min: acc.min == null ? x : x < acc.min ? x : acc.min,
      max: acc.max == null ? x : x > acc.max ? x : acc.max,
      n: acc.n + 1,
    }),
    { min: null, max: null, n: 0 },
  ),
);
```

### What if I really need server-side JavaScript?

The registry passthrough form still compiles:

```js
jsmql(`$function({ body: "function(x) { return x * 2; }", args: [$.qty], lang: "js" })`);
// → { $function: { body: "...", args: ["$qty"], lang: "js" } }
```

This is unchanged for backwards compatibility. We don't recommend it on MongoDB 8.0+ — deprecation eventually means removal, and many setups already turn server-side JavaScript off with `--noscripting`. If you do reach for it, leave a comment explaining why, and check whether `$reduce` or a custom pipeline can do the same job.

## Language Grammar (EBNF, simplified)

> The grammar below covers the core structure. Object literals, spread, lambdas, date constructors, and type-cast calls follow standard JavaScript syntax and are omitted here for brevity.

```ebnf
expression  = ternary

ternary     = nullish ("?" expression ":" ternary)?

nullish     = logical_or ("??" logical_or)*

logical_or  = logical_and ("||" logical_and)*

logical_and = comparison ("&&" comparison)*

comparison  = relational ((==|!=|===|!==) relational)?

relational  = additive ((<|<=|>|>=|in) additive)?

additive    = multiplicative ((+|-) multiplicative)*

multiplicative = power ((*|/|%) power)*

power       = unary ("**" power)?

unary       = "typeof" unary | (!|-) unary | postfix

postfix     = primary (member_access | method_call | index_access)*

primary     = number | string | boolean | null
            | template_literal
            | field_ref | array_literal | object_literal
            | operator_call | math_call | math_const | type_cast | date_new | date_now
            | "(" expression ")"

field_ref   = "$" "." identifier

array_literal = "[" (spread | expression) ("," (spread | expression))* "]"

object_literal = "{" (spread | key_value) ("," (spread | key_value))* "}"

spread      = "..." expression

key_value   = identifier ":" expression
            | string ":" expression
            | "[" expression "]" ":" expression       (* computed key *)
            | identifier                              (* shorthand: name → name: name *)

template_literal = "`" template_chunk ("${" expression "}" template_chunk)* "`"

operator_call = "$" identifier "(" call_args ")"   (* the "$op()" escape hatch *)

math_call   = "Math" "." identifier "(" call_args ")"

math_const  = "Math" "." ("PI" | "E")

date_now    = "Date" "." "now" "(" ")"

index_access = ("[" | "?.[") expression "]"

member_access = ("." | "?.") identifier

method_call = ("." | "?.") identifier "(" call_args ")"

call_args   = (call_arg ("," call_arg)*)?

call_arg    = "..." expression                        (* spread *)
            | lambda
            | expression

lambda      = identifier "=>" expression
            | "(" identifier ("," identifier)* ")" "=>" expression

args        = (expression ("," expression)*)?

identifier  = [a-zA-Z_][a-zA-Z0-9_]*

number      = digit_seq ("." digit_seq)? ([eE][+-]? digit_seq)?
digit_seq   = [0-9]+ ("_" [0-9]+)*                    (* numeric separators *)

string      = "\"" ... "\"" | "'" ... "'"

boolean     = "true" | "false"

null        = "null"
```

---

## Operator Precedence (High to Low)

| Precedence | Operator | Associativity |
|---|---|---|
| 1 | `()` grouping, `.`/`?.` member access, `[]`/`?.[]` index, method calls | — |
| 2 | `!`, `-`, `~` (unary) | Right |
| 3 | `**` (exponentiation) | Right |
| 4 | `*`, `/`, `%` | Left |
| 5 | `+`, `-` (binary) | Left |
| 6 | `<`, `<=`, `>`, `>=`, `in` | Left |
| 7 | `==`, `!=`, `===`, `!==` | Left |
| 8 | `&` (bitwise AND) | Left |
| 9 | `^` (bitwise XOR) | Left |
| 10 | `\|` (bitwise OR) | Left |
| 11 | `&&` | Left |
| 12 | `\|\|` | Left |
| 13 | `??` | Left |
| 14 | `? :` (ternary) | Right |

---

## FAQ

**Q: How do I get an array's length?**
A: Use `.length`: `$.items.length` works for both arrays and strings (jsmql dispatches by receiver type). The `$size()` escape hatch is also available if you want to force the array form: `$size($.items)`.

**Q: How does `$.field.includes(x)` know whether to use `$in` or string-substring matching?**
A: When the receiver is *demonstrably* an array — an array literal, a `.split()` result, a `.map()` result, etc. — jsmql emits the array form (`$in` / `$indexOfArray` / `$concatArrays`). When it is demonstrably a string — `.toLowerCase()`, `String(x)`, template literal, etc. — it emits the string form. For a bare field reference whose type can't be known at compile time, jsmql emits a runtime `$cond` on `$isArray` that picks the right form at query time. If you want compact output, hint by chaining a type-fixing method first (e.g. `$.items.slice().includes(target)` for array, `$.tags.toLowerCase().includes("x")` for string), or call the operator directly: `$in($.items, x)`.

**Q: Does `?.` actually short-circuit?**
A: For field paths, MongoDB already returns `null`/missing when traversing through missing fields, so `$.a?.b?.c` and `$.a.b.c` produce the same MQL — `?.` is purely a JS-readability sugar.

**Q: How do `Math.max(...$.arr)` and `Math.max($.arr)` differ?**
A: They produce identical MQL (`{ $max: "$arr" }`). The spread form is just JS-natural sugar.

---
