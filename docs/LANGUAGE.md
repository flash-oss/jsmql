# JSMQL Language Reference

> This is the **user-facing language reference** for jsmql. For implementation details, see `specs/`. For the list of open items and rejected features, see [DEFERRED.md](DEFERRED.md).

---

## Quick Start

JSMQL is a JavaScript subset that compiles to MongoDB query syntax. Think of it as SQL for MongoDB, but it uses JS syntax you already know. A semicolon, present or absent, picks the output shape. This matches the terminology of the Node.js MongoDB driver:

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
// → { $expr: { $eq: [ { $let: { vars: { jsmqlRecv: { $arrayElemAt: [{ $ifNull: [{ $split: ["$email", "@"] }, []] }, 1] } }, in: { $cond: { if: { $eq: [{ $ifNull: ["$$jsmqlRecv", null] }, null] }, then: null, else: { $toLower: "$$jsmqlRecv" } } } } }, "gmail.com" ] } }

// Any `;` flips to Pipeline mode — even one stage with a trailing `;`.
jsmql("$match($.age > 18); $sort({ age: 1 });");
// → [ { $match: { age: { $gt: 18 } } }, { $sort: { age: 1 } } ]
//   db.users.aggregate([...])

// With the template-tag form of jsmql (for embedded values)
const minAge = 21;
jsmql`$.age >= ${minAge} && $.status === 'active'`;
// → { age: { $gte: 21 }, status: "active" }
```

The same rule applies to the [function form](#function-form). An **expression-body** arrow (`({ $ }) => …`) lowers as a Filter. A **block-body** arrow (`({ $ }) => { …; … }`) lowers as a Pipeline.

---

## Table of Contents

1. [Output dispatch: Filter vs Pipeline](#output-dispatch-filter-vs-pipeline)
2. [Expressions](#expressions)
3. [Literals](#literals)
4. [Comments](#comments)
5. [Trailing commas](#trailing-commas)
6. [Field References](#field-references)
7. [Mistakes caught at compile time](#mistakes-caught-at-compile-time)
8. [Operators](#operators)
9. [String Methods](#string-methods)
10. [Array Methods](#array-methods)
11. [Lambda Functions](#lambda-functions)
12. [Math Functions](#math-functions)
13. [Type Casting](#type-casting)
14. [Date Operations](#date-operations)
15. [Escape Hatch (Direct Operator Form)](#escape-hatch-direct-operator-form)
16. [Update filters](#update-filters)
17. [Pipelines](#pipelines)
18. [Function Form](#function-form)
19. [Partial expressions (`jsmql.expr`)](#partial-expressions-jsmqlexpr)
20. [Strict-shape entry points (`jsmql.filter`, `jsmql.pipeline`, `jsmql.update`)](#strict-shape-entry-points-jsmqlfilter-jsmqlpipeline-jsmqlupdate)
21. [Command Line (`jsmql`)](#command-line-jsmql)
22. [Printing MQL (`jsmql.stringify`)](#printing-mql-jsmqlstringify)
23. [Parameterised Queries (`jsmql.compile`)](#parameterised-queries-jsmqlcompile)
24. [Template-Tag Form (`` jsmql`…` ``)](#template-tag-form--jsmql-)
25. [Validation](#validation)
26. [Error Messages](#error-messages)
27. [Examples](#examples)
28. [Replacing Server-Side JavaScript](#replacing-server-side-javascript)
29. [Language Grammar (EBNF, simplified)](#language-grammar-ebnf-simplified)
30. [Operator Precedence (High to Low)](#operator-precedence-high-to-low)
31. [FAQ](#faq)

---

## Output dispatch: Filter vs Pipeline

`jsmql()` picks its output shape from the top level of the input. Names follow the Node.js MongoDB driver:

| Input top-level shape | Output | Used with |
|---|---|---|
| **Stage call** (`$match(...)`, `$project(...)`, `{ $match: ... }`, …) | a **Pipeline** `[…stages…]` (one stage) | `db.coll.aggregate(pipeline)` |
| **Update filter** (`$.x = …`, `delete $.x`) | a **Pipeline** `[{ $set: … }]` / `[{ $unset: … }]` | `db.coll.updateOne(filter, update)` |
| **Statement sugar** whose target is a destination rather than a field (e.g. `$$ = …`, `$$.<chain>`) | a **Pipeline** `[…stages…]` | `db.coll.aggregate(pipeline)` |
| **`;`-separated statements** (even a single trailing `;`) | a **Pipeline** `[…stages…]` | `db.coll.aggregate(pipeline)` |
| **Anything else** (predicate, expression) | a **Filter** (single document) | `db.coll.find(filter)` |

The first four rows all produce arrays. The rule for `jsmql()` is simple: does the driver call site need an array here? If yes, `jsmql()` gives it an array. The `;` is needed only to compose **multiple** stages. A single stage, written with or without `;`, works either way.

### No semicolons → Filter

JSMQL reads the expression as a Filter. A field-vs-literal predicate the MongoDB query language can express directly emits an indexable `{ field: { $op: lit } }` pair. Anything else — a method call, a computed expression, a non-predicate value — rides in a top-level `$expr` residual, a legal Filter operator. So both a predicate and a computed expression produce a valid Filter.

**A query document is the plain one.** `$.age > 18` is `{ age: { $gt: 18 } }`. This is the document you would write by hand, and the one every index plan and `explain` output is written against. MongoDB's own rules then apply to it. A field comparison is satisfied when *any element* of an array value satisfies it, and a path can traverse an array in the middle. JavaScript does neither. So a comparison that must read exactly ONE value has its own spelling: `$.tags.has("a")` for membership in an array, `$.items.some(i => i.qty > 5)` for an element test (`$.tags.some(t => t.startsWith("a"))` tests the element itself: `{ tags: { $elemMatch: { $regex: /^a/ } } }`), and `jsmql.expr` for the aggregation language's value comparison.

```js
// Pure query-document — indexable on `age` and `status`
jsmql("$.age > 18 && $.status === 'active'");
// → {age:{$gt:18},status:"active"}

// `new Date(...)` with literal args folds to a JS Date — index-friendly on `createdAt`
jsmql(`$.method === "postalDelivery" && $.createdAt >= new Date("2026-01-01")`);
// → { method: "postalDelivery", createdAt: { $gte: <Date 2026-01-01> } }

// Mixed: indexable conjunct + `$expr` residual for the untranslatable part
jsmql("$.status === 'active' && $.name.trim() === 'alice'");
// → {status:"active",$expr:{$eq:[{$trim:{input:"$name"}},"alice"]}}

// A value that is not a predicate — the JavaScript truthiness test rides in $expr
jsmql("$.a + $.b");
// → { $expr: { $and: [{ $ne: [{ $ifNull: [{ $add: ["$a", "$b"] }, null] }, null] },
//                     { $ne: [{ $add: ["$a", "$b"] }, false] }, { $ne: [{ $add: ["$a", "$b"] }, ""] }, { $ne: [{ $add: ["$a", "$b"] }, 0] }] } }
```

JSMQL uses the same translation rules that [`$match` uses inside a Pipeline](#match-indexes-by-default). See [docs/specs/emit-pass.md](specs/emit-pass.md) for the full table.

**`new Date(...)` and indexes.** Take three cases: `new Date("2026-01-01")`, `new Date(2026, 1, 1)`, and `new Date(Date.UTC(2026, 1, 1))`. When all `new Date(...)` arguments are compile-time literals like these, JSMQL folds the constructor at compile time and emits a real JS `Date` instance on the query-doc RHS. This is the shape an index on `createdAt` needs. `new Date()` (zero-argument, server-side `$$NOW`) and `new Date($.someField)` fall back to `$expr`, because the server cannot evaluate them before query time. `{ field: { $gte: { $toDate: "..." } } }` does **not** work in a Filter, because MongoDB's query language treats `{ $toDate: ... }` as a literal subdocument that matches nothing. The fold avoids this trap.

### Stage call → Pipeline (no `;` required)

A top-level stage call or stage-object literal auto-wraps into a one-element Pipeline. The call site needs no `;` discipline: the cleanest JS surface produces the cleanest correct MQL.

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

A `;`-separated statement **must** be a stage call (`$match`, `$project`, `$sort`, …), an update op (`$.x = …`), or a `let` binding. JSMQL rejects a bare expression like `$.age > 18;` and suggests `$match(...)`:

```text
Element 0 of Pipeline is not a stage call. To filter documents on a
predicate, wrap it as `$match(...)` — e.g. `$match($.age > 18)`. …
```

### Function form mirrors the rule

An **expression-body** arrow (`({ $ }) => …`) is the function equivalent of a no-`;` string. It lowers as a Filter, unless the body is itself a stage call, in which case auto-wrap fires. A **block-body** arrow (`({ $ }) => { …; … }`) is the equivalent of a `;`-separated string. It lowers as a Pipeline.

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

The template-tag form (`` jsmql`…` ``) follows the string-form rule. A stage call or any `;` in the assembled source produces a Pipeline.

---

## Expressions

A JSMQL expression is a **subset of JavaScript** that compiles to MongoDB aggregation expression JSON. Write JS operators, method chains, and lambdas, and JSMQL translates them. For a MongoDB operator with no JS equivalent, use the `$op()` escape hatch (the direct operator form).

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
- Comments: `// line` and `/* block */` — same behaviour as JavaScript

### Invalid Constructs

- Control flow: `if`, `for`, `while`, `break`, etc.
- Statement-level features other than update ops: function definitions, declarations
- Object/array in-place update ops: `.push()`, `.splice()`
- Destructuring assignment: `{ a, b } = obj` (a destructured *parameter* — `([a, b]) => …` — is fine)

---

## Literals

### Numbers

Integer and floating-point numbers, scientific notation, and numeric separators (a `_` between two digits):

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

**BigInt literals.** An integer literal with an `n` suffix is a MongoDB 64-bit integer. JSMQL builds the value itself, instead of asking the server to parse one per document:

```js
123n           // Long.fromString("123")
-123n          // Long.fromString("-123")
1_000_000n     // Long.fromString("1000000")   (separators allowed)
$.timestamp - 1000n
               // { $subtract: ["$timestamp", Long.fromString("1000")] }
```

The value is a real `Long`, so a comparison stays a query the index serves. It matches an **element** of an array field, as any other query value does:

```js
$.n === 9007199254740993n   // { n: Long.fromString("9007199254740993") }
```

The `n` suffix works on an integer only. `1.5n` and `1e2n` are syntax errors, as in JS. JSMQL refuses a BigInt past the 64-bit range at compile time, and names `Decimal128` as the type that holds it.

### Strings

Both single and double quotes. Escape sequences: `\\`, `\"`, `\'`, `\n`, `\t`:

```js
"hello"
'world'
"line1\nline2"
"escaped \"quote\""
```

#### `$`-prefixed strings: a `"$x"` you type is the field ref `$x`

MongoDB reads a string that starts with `$` (like `"$items"`) as a **field
reference** in an aggregation expression. JSMQL honours that rule. A `"$x"` you type in
source **is** the field ref `$x`, and it **passes through verbatim in every
context** — pipelines, stage bodies, and `jsmql.expr` alike. JSMQL never adds a
`$literal` of its own (this is rule **HR1**; see [LANG_RULES.md](LANG_RULES.md)):

```js
jsmql(`$unwind("$items");`)        // → [{ $unwind: "$items" }]
jsmql(`[{ $unwind: "$items" }]`)   // → [{ $unwind: "$items" }]  (raw MQL, unchanged)
jsmql(`$project({ t: $concat("$a", "$b") });`)
//    → [{ $project: { t: { $concat: ["$a", "$b"] } } }]   (even nested in an operator)
jsmql.expr(`$eq($.x, "$y")`)       // → { $eq: ["$x", "$y"] }   ("$y" is the field ref $y)
```

Writing `$.items` instead of `"$items"` produces the identical output, so use
whichever reads better. To force a **literal** string that starts with
`$`, use the `$literal(...)` escape hatch, exactly as in raw MQL:

```js
jsmql.expr(`$literal("$y")`)                // → { $literal: "$y" }
jsmql(`$project({ x: $literal("$y") });`)   // → [{ $project: { x: { $literal: "$y" } } }]
```

There is one exception, for safety. A **runtime-injected** value (a `jsmql.compile`
parameter or a template-tag `${…}` interpolation) that looks like `"$x"` *is*
wrapped in `$literal` in expression position. This stops untrusted input from
silently turning into a field reference:

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

JSMQL wraps an interpolated expression with `$toString` to match JS coercion rules, so
`` `count: ${$.n}` `` works whether `$.n` is a number or a string. An expression that
statically produces a string — a string literal, `.toLowerCase()`, `String(x)`,
a nested template literal, and so on — skips the wrap, to keep the output compact:

```js
`name=${$.name.toLowerCase()}`
// → { $concat: ["name=", { $cond: { if: { $eq: [{ $ifNull: ["$name", null] }, null] }, then: null, else: { $toLower: "$name" } } }] }
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

### `undefined` — the existence test

`undefined` is not a value in MQL, so JSMQL gives it the one meaning it can carry. A comparison
against it asks whether a field is **present**.

```js
$.deletedAt === undefined      // the field is absent
$.deletedAt !== undefined      // the field is present
```

It works in every position. In a Filter or `$match` body it becomes MongoDB's indexed
`$exists`. Everywhere else it becomes a `$type` test against `"missing"`. Both draw the same
line, so the two agree on every document:

```js
jsmql(`$.a === undefined`);        // → { a: { $exists: false } }
jsmql.expr(`$.a === undefined`);   // → { $eq: [{ $type: "$a" }, "missing"] }
```

**Absent is not the same as null.** A document that holds `{ a: null }` *has* the field, so
`$.a === undefined` is false for it, while `$.a === null` is true. That distinction is the
reason to keep both.

JSMQL rejects `undefined` as a **value** rather than in a comparison. MQL has nothing to
lower it to, and a quiet fallback to `null` would merge two different documents. Write `null`
for the present-but-null case, or `delete $.field` to remove a field.

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

Spread compiles to `$concatArrays`. Consecutive non-spread elements group into one operand. Each `...expr` becomes its own operand. A lone `[...x]` returns `x` directly, with no redundant `$concatArrays` wrapper. Each spread argument must evaluate to an array at runtime — the same constraint that MongoDB's own `$concatArrays` imposes.

### Objects

Key-value pairs in braces, including spread:

```js
{ name: $.name, score: $.score }           // field values
{ status: "active", count: $.count + 1 }   // mixed
{ ...$.defaults, priority: 1 }             // → { $mergeObjects: ["$defaults", { priority: 1 }] }
{ ...$.a, ...$.b, extra: true }            // → { $mergeObjects: ["$a", "$b", { extra: true }] }
```

Spread compiles to `$mergeObjects`. Consecutive non-spread keys group into one operand. Each `...expr` becomes its own operand. JS "later wins" behaviour on a key collision matches `$mergeObjects` exactly. A lone `{...x}` returns `x` directly, with no redundant `$mergeObjects` wrapper.

Objects are useful as `$push` arguments in `group()`, as `$project` escape hatch values, and in `$let` bindings.

#### Computed Keys

Keys may be computed expressions, just like in JS:

```js
{ [$.k]: 1 }                       // → { $arrayToObject: [[{ k: "$k", v: 1 }]] }
{ a: 1, [$.dynKey]: 2 }            // → { $arrayToObject: [[{ k: "a", v: 1 }, { k: "$dynKey", v: 2 }]] }
```

When a static block of keys holds at least one computed key, that block compiles to `$arrayToObject` (using its `{ k, v }` object-pair form), so MongoDB can build it at query time. The pairs array is wrapped one level deeper, as `{ $arrayToObject: [pairs] }`, because MongoDB reads a bare literal array as an *argument list*. The wrap makes it the single argument. A computed key mixes with spread. JSMQL builds each block on its own, then `$mergeObjects` joins them:

```js
{ ...$.base, [$.k]: $.v }          // → { $mergeObjects: ["$base", { $arrayToObject: [[{ k: "$k", v: "$v" }]] }] }
```

#### Shorthand Properties

`{ x }` is sugar for `{ x: x }` — useful inside lambda bodies:

```js
$.items.map(x => ({ x }))
// → { $map: { input: "$items", as: "x", in: { x: "$$x" } } }
```

JSMQL treats the shorthand value as an identifier (a lambda parameter). Shorthand outside a lambda scope produces an "Unknown identifier" error.

---

## Comments

JSMQL accepts JavaScript-style comments and discards them as trivia; they have no effect on the compiled MQL. Both forms are valid wherever whitespace is valid.

```js
$.age >= 18  // line comment to end-of-line
$.score /* block comment, can span lines */ * 1.1
```

The behaviour matches JavaScript exactly. A line comment ends at a LineTerminator (LF, CR, LSEP, PSEP) or at EOF. A block comment does not nest — the first `*/` closes it — and an unclosed `/* …` is a parse error. Text inside a string literal, a regex literal, or template-literal text is character data, never a comment.

---

## Trailing commas

As in JavaScript, JSMQL allows a single trailing comma after the last item of a comma-separated list, and ignores it. This works **everywhere** a list appears: call arguments, array and object literals, arrow / `function` parameter lists, and the in-stage update-op chain. So code your formatter has already touched — prettier and oxfmt add a trailing comma when they break a list across lines — pastes straight in.

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

A trailing comma never changes the result: the output is identical to the comma-free form. It is **not** a way to add an extra argument. `Number($.x, $.y)` still gives the "takes exactly 1 argument" error, while `Number($.x,)` is fine.

---

## Field References

Use `$.` (dollar-dot) to reference a document field:

```js
$.age              // simple field
$.address.city     // nested field
$.items[0].name    // array element by index — use bracket access (`$.items.0` is invalid JS)
$.in               // field literally named "in" (no conflict with operator)
```

**`$.` always means the *root* document — never "whichever document is nearest".** This matters
once you read another collection. Inside a `$$$.<coll>` chain, an `.aggregate((o) => { … })`
block, or a `.filter((o) => …)` predicate, `$.x` still reads the **outer** document. The
sub-pipeline's own document is the callback parameter (`o`), or a raw MQL path string
(`"$x"`). So the two spellings in one stage body point at two different documents:

```js
$.t = $$$.orders.$set({ owner: $.tag });    // owner ← the ROOT doc's `tag`
$.t = $$$.orders.$set({ owner: "$tag" });   // owner ← the ORDERS doc's `tag`
```

JSMQL threads the root-document read through `$lookup.let` for you; see
[Cross-collection lookups](#cross-collection-lookups-collfind--filter).

### Bracket Access

> **JSMQL interprets dot access; it reads bracket access raw.** A `.member` access is a field read, and a `.method()` call after it is a JSMQL method: `$.x.length` is the field named `length` inside `x`, and `$.x.length()` is the character count of `x`. Square brackets never carry compiler meaning: `$.x["length"]`, `$.x["anything"]`, `$.x[$.dynamicKey]` are all **direct property access**. JSMQL does not interpret what sits inside the brackets — whatever you write is the property you get. So when you mean "the data at this key, exactly as written" (including a field literally named `length`), use brackets.

Use square brackets for computed index/key access. The compiled MQL depends on the receiver type:

```js
$.items.map(x => x.id)[0]     // known array → { $arrayElemAt: [{ $map: ... }, 0] }
[1, 2, 3][$.idx]              // known array → { $arrayElemAt: [[1, 2, 3], "$idx"] }
```

An **integer** key has three meanings in JavaScript, and each compiles to a different
MongoDB operator: an array position, a string character, or a document field whose name
is that digit (JS coerces a property key to a string, so `({ 0: "z" })[0] === "z"`). When
the receiver's type is provable, JSMQL emits just the one that applies:

```js
$.tags.uniq()[0]                    // known array  → { $arrayElemAt: [ …, 0] }
$.name.trim()[0]                    // known string → { $substrCP: [ …, 0, 1] }   — the first character
$[0]                                // the root is a document → { $getField: { field: "0", input: "$$ROOT" } }
```

For a bare `$.field` the type is not knowable at compile time, so all three run at query
time and the right one wins:

```js
$.items[0]
// → { $switch: {
//       branches: [
//         { case: { $isArray: "$items" }, then: { $arrayElemAt: ["$items", 0] } },
//         { case: { $eq: [{ $type: "$items" }, "string"] }, then: { $substrCP: ["$items", 0, 1] } }
//       ],
//       default: { $getField: { field: "0", input: "$items" } }
//     } }
```

The dispatch is a `$switch` and never a nested `$cond`, because MongoDB optimises a
`$cond`'s branches *before* it reads the test. Where the server holds the receiver as a
constant — a `$lookup.let` variable, a `jsmql.compile` parameter — a `$cond` folds the
branch that does not apply, and MongoDB refuses the whole pipeline before it reads a document
(`$.o = $$$.products.find({ _id: $.arr[0] })` answered *"cannot convert from BSON type
array to String"*). A `$switch` drops a branch whose case is false without evaluating it,
so every receiver type answers the same as it always did before.

**A numeric object key builds the stringified field name.** JavaScript coerces every
property key to a string, so `{ 0: 1 }` is the field `"0"` and `{ 0x10: 1 }` is `"16"` —
the numeric *value*, not the source text. JSMQL matches that, which is the write-side
counterpart of reading `doc[0]`:

```js
({ 0: 1, 1.5: 2, 0x10: 3 })         // → { "0": 1, "1.5": 2, "16": 3 }   — exactly what JS builds
```

A 24-hex `0x…` literal is an ObjectId in JSMQL, and an ObjectId is not a field name, so
JSMQL rejects it as a key and points at the quoted spelling.

**JSMQL rejects a negative bracket index.** In JavaScript `arr[-1]` reads a property named
`"-1"` — normally `undefined` — it does **not** count from the end. `.at(-1)` is the
JavaScript way to do that on an array, so JSMQL points you there instead of a silent pick
of one of the three possible answers:

```js
$.items[-1]
// error: Negative bracket index '[-1]' isn't allowed — in JavaScript that reads a
//        property named "-1" (normally 'undefined'), not the element 1 from the end.
//        Use '.at(-1)' to index from the end.
```

The rejection happens at compile time, so it only fires on an index JSMQL can *see* is negative.
JSMQL passes a computed index (`$.items[$.i]`) through as written; if it turns out negative at
query time, MongoDB decides what happens (`$arrayElemAt` counts from the end).

When the key is **provably a string** — a string literal, a `.toLowerCase()`-style
string-returning expression, a `const k = "…"` binding, or **a lambda parameter iterating
an array whose elements are all strings** — it can only be an object property name (a string
is never a numeric array index), so JSMQL skips the dispatch and emits `$getField` directly:

```js
$.config["host"]              // → { $getField: { field: "host", input: "$config" } }
$.scores[$.key.toLowerCase()] // → { $getField: { field: { $cond: { if: { $eq: [{ $ifNull: ["$key", null] }, null] }, then: null, else: { $toLower: "$key" } } }, input: "$scores" } }

// `party` iterates a string array → typed `string`, so `$.cre.result[party]` is a getter:
["sender", "recipient"].map(party => $.cre.result[party])
// → { $map: { input: ["sender","recipient"], as: "party", in: { $cond: {
//       if: { $isArray: "$cre.result" },
//       then: { $arrayElemAt: ["$cre.result", "$$party"] },
//       else: { $getField: { field: { $toString: { $ifNull: ["$$party", ""] } }, input: "$cre.result" } } } } } }
```

When the key is **not** provably a string, JSMQL coerces it — `{ $toString: { $ifNull: [k, ""] } }`
— because MongoDB's `$getField` requires a string field name and **aborts the whole query**
on anything else. That includes a key field that is simply *absent* on some documents, which
is ordinary data, so the coercion is what keeps `$.doc[$.k]` from killing the query; a
missing key reads as missing, as `obj[undefined]` does in JavaScript. Stringifying also
matches JS, where `obj[0]` *is* `obj["0"]`.

The same element-type inference applies across `.filter`/`.find`/`.some`/`.every`/`.flatMap`/`.reduce`, and the element type is also read from `String.split(",")` and `Object.keys(o)` (both yield string arrays) and from object/array-literal element arrays (so `[{…}, {…}].map(o => o[k])` treats `o` as an object). It only ever *removes* a redundant guard: a numeric or unknown-typed element keeps the runtime `$isArray` dispatch.

If you want compact output for a *numeric* index, pin the type — bind the value to a `const` with a type-revealing initialiser, or chain a type-fixing method (`.map(x => x)`, `.toReversed()`, …).

**Callback `(element, index, array)`.** Array-method callbacks (`.map` / `.filter` / `.find` / `.some` / `.every` / `.flatMap` / …) accept all three JS parameters. The third — the array being iterated — is the method's input, so `arr.size()` is the count of that array (`$size`): `$.items.map((el, i, arr) => el / arr.size())`. Strict-JS semantics: in a `.filter(...).map((el, i, arr) => …)` chain, `arr` is the post-filter array (it's `map`'s input). The `index` is lazy — JSMQL only emits the `$zip`/`$range` index machinery when `i` is *actually used*; `(el, i, arr) => arr.size()` (where `i` is only there positionally to reach `arr`) compiles to a plain `$map`/`$filter`.

On a **`$$$.<coll>` lookup chain** (`$$$.orders.filter(p).map((o, _i, coll) => …)`) the third param is the *foreign sub-stream*, and `coll.size()` is its document count — how many documents matched the filter — materialised by a `$setWindowFields` `$count` inside the `$lookup.pipeline`. A stream has no materialised array, so **only `.size()`** is available on this handle (no indexing or iteration), and the **index** param is never available (MongoDB streams have no per-doc index; it may be present, unused, only to reach the 3rd param). Example: `$.byOrder = $$$.orders.filter(o => o.userId === $._id).map((o, _i, coll) => ({ id: o._id, share: o.total / coll.size() }))`.

The **bare root** `$` is the simplest case: the root document is always an object and never an array, so there is nothing to dispatch on for *any* key. A string-literal key lowers to a plain field reference — `$["x"]` is just `$.x` — and a computed key lowers straight to `$getField`. This is how you name a field that is not a bare identifier — a name containing a dot, dash, space, etc. — and a nested `length` field is a plain `.length` read, because JSMQL computes no property:

```js
$["cart.field.length"]              // → "$cart.field.length"   — the nested `length` field, raw
$["weird-name"]                     // → "$weird-name"
$["cart.field.length"] * $.cart.field.width   // → { $multiply: ["$cart.field.length", "$cart.field.width"] }
$[$.fieldName]                      // → { $getField: { field: "$fieldName", input: "$$ROOT" } }   — computed key, no $isArray dispatch
```

(An object literal receiver follows the same rule — `({ a: 1 })[$.k]` → `{ $getField: { field: "$k", input: { a: 1 } } }` — since an object literal is never an array either.)

### Optional Chaining

`?.` is accepted everywhere `.` is, and it does what JavaScript's `?.` does.

**A `?.` with a CALL after it stops the chain.** The call does not run, and the chain answers `null` — the nearest thing MongoDB holds to JavaScript's `undefined`. The test sits at the top of the chain, so the links below it run only when the field exists. Each `?.` tests only the value in front of it; a dot after it follows the dot rule of [HR5](LANG_RULES.md): an array or object method runs on the empty collection when its receiver is missing.

```js
$.s?.trim().length() // a call runs after the ?. — the chain stops, and answers null
// → { $cond: { if: { $eq: [{ $ifNull: ["$s", null] }, null] }, then: null, else: { $strLenCP: { $trim: { input: "$s" } } } } }
$.s.trim().length()  // no ?. — but `.length()` is a string method, and its receiver may be null, so it too answers null
// → { $let: { vars: { jsmqlRecv: { $trim: { input: "$s" } } }, in: { $cond: { if: { $eq: [{ $ifNull: ["$$jsmqlRecv", null] }, null] }, then: null, else: { $strLenCP: "$$jsmqlRecv" } } } } }
$.a?.b.uniq()        // the ?. tests `a` alone; `a.b` inside follows the dot rule
// → { $cond: { if: { $eq: [{ $ifNull: ["$a", null] }, null] }, then: null, else: { $setUnion: { $ifNull: ["$a.b", []] } } } }
$.a.uniq()           // no ?. — an array method on a field that may be missing runs on []
// → { $setUnion: { $ifNull: ["$a", []] } }
```

**A `?.` with no call after it changes nothing.** There is nothing to stop: the chain's value is the field, and a path through a missing field already answers missing. So the consumer supplies its own empty value, as the table below shows. That table covers every `?.` EXCEPT a chain that calls something.

| Consumer category | Wrapped with | Example |
|---|---|---|
| Bare read | nothing (sugar only) | `$.user?.name` → `"$user.name"` |
| Array spread | `[]` — under `.` as well: a missing collection spreads as the empty one (HR5) | `[...$.room?.mods]` → `{ $ifNull: ["$room.mods", []] }` |
| Any method receiver — a CALL runs after the `?.` | nothing; the chain stops | `$.user?.name.trim()` → `{ $cond: { if: { $eq: [{ $ifNull: ["$user.name", null] }, null] }, then: null, else: { $trim: { input: "$user.name" } } } }` |
| String `+` operand (string concat) | `""` | `$.first + " " + $.user?.last` → `{ $concat: ["$first", " ", { $ifNull: ["$user.last", ""] }] }` |
| Template literal interpolation | `""` | `` `hello ${$.user?.name}` `` → `{ $concat: ["hello ", { $toString: { $ifNull: ["$user.name", ""] } }] }` |
| `.size()` of optional — a call, so it stops the chain | nothing; the chain stops | `$.user?.tags.size()` → `{ $cond: { if: { $eq: [{ $ifNull: ["$user.tags", null] }, null] }, then: null, else: { $size: "$user.tags" } } }` |
| Index access (`obj?.[k]` or `?.` earlier in chain) | `[]` | `$.scoresByLevel?.[$.level]` → runtime `$cond` over `$ifNull("$scoresByLevel", [])` |
| Non-foldable `$getField` receiver | `{}` | `$.items[0]?.label` → `{ $getField: { field: "label", input: { $ifNull: [..., {}] } } }` |

A reader of a whole object follows the same rule. `$.o.keys()` is an object method under a dot, so a missing `o` reads as `{}` and the answer is `[]`. `$.o?.keys()` has a call after the `?.`, so the chain stops and answers `null`. `Object.keys(o)` is a namespace call with no receiver to carry the `?.`, so it reads the `?.` off its argument: `Object.keys($.user?.profile)` takes `{}` for a missing profile.

These cases produce the same MQL whether you use `.` or `?.`:

| Consumer | Why no wrap |
|---|---|
| Object spread (`{...x?.y}`) | `$mergeObjects` silently ignores null operands and returns `{}` when all operands are null. |
| Comparisons (`==`, `!=`, `<`, `>`, `<=`, `>=`, `===`, `!==`) | `$eq` / `$ne` / `$lt` / `$gt` accept null cleanly. |
| Loose-equality null check (`$.x?.y == null`) | The `==`/`!=` form already lowers to a `$type` check that catches "null" and "missing". |
| `$cond` / `&&` / `\|\|` condition | Null is falsy; the chain naturally short-circuits to the alternate branch. |
| `$in` first argument (`arr.has($.x?.y)`) | Searching for null in an array is a defined, non-erroring operation. |
| Numeric arithmetic operand (`$.a + $.b?.c` in numeric mode, `-`, `*`, `/`, `%`, `**`) | MQL's `$add` etc. return null on null operand — matches JS's `1 + undefined === NaN` closely. Forcing a `0` fallback would silently produce different numbers than JS, which is worse DX than honest null. |

**Scope of the wrap.** `?.` only wraps the chain it appears in. A `?.` that sits
inside a lambda body, a method argument, an `IndexAccess.index`, or a binary
operand belongs to a *different* chain — it does **not** trigger an outer wrap.
For example, `$.items.map(x => x?.tags)` wraps inside the lambda body, but the
outer `.map`'s receiver (`$.items`) is not optional, so JSMQL leaves it unwrapped.

### Syntax

- Must start with `$.`
- Followed by a valid JavaScript identifier (letter or underscore; digits allowed after the first character)
- May include dots for nested object access (`$.a.b.c`)
- For array elements, use bracket access — `$.items[0]`, not `$.items.0` (the dotted-digit form is invalid JS, so the lexer rejects it)

### Invalid field references

```
$age           // ❌ Missing dot — use $.age or $age()
$.             // ❌ Incomplete
$.0.name       // ❌ Can't start with digit after $.
```

### Context references: `$$`, `$$$`, `$$$$`

JSMQL provides three more prefix levels, parallel to `$.`, for cross-collection, cross-database and cross-cluster references.

| Prefix | Scope                          | Status                                                                  |
| ------ | ------------------------------ | ----------------------------------------------------------------------- |
| `$.`   | Current document field         | JSMQL supports this today (`$.age`, `$.address.city`)                                 |
| `$$`   | Current collection             | JSMQL supports `.push(...)` → `$unionWith` ([Collection union](#collection-union-push)) and collection-scoped diagnostics (`$$.indexStats()`, … — [System stages](#system--diagnostic-stages-indexstats-currentop-)) now. `.find` / `.filter` data reads on `$$` still need schema/driver binding `[DEF-013]`. |
| `$$$`  | Current database               | JSMQL supports `.find/.filter` joins ([below](#cross-collection-lookups-collfind--filter)) and the `$$$.<coll> = …` `$out` write now. `$$$` has no diagnostics, because they are collection- or server-scoped. |
| `$$$$` | Current cluster / server       | JSMQL supports the cross-database `$$$$.<db>.<coll> = …` `$out` write ([below](#out-write-the-pipeline-to-a-collection)) and server/cluster-scoped diagnostics (`$$$$.currentOp()`, `$$$$.shardedDataDistribution()`, …) now. JSMQL **rejects** a cross-database **read** (`.find/.filter`) — see below. |

Both the dot-identifier form (`$$$.myColl`) and the bracket-expression form (`$$$[collVar]`) work. Bracket access uses standard JS semantics, so the inner expression can be any value — a `jsmql.compile` parameter, a string literal, or a deeper expression.

```js
jsmql.expr("$$$.myColl");              // ❌ CodegenError: '$$$.<coll>' must be followed by .find(pred) or .filter(pred)
jsmql.expr('$$$$["db"]["coll"]');      // ❌ '$$$$.<db>.<coll>' is only usable as a cross-database $out destination — cross-database READS aren't supported
jsmql("$$");                            // ❌ ParseError: Expected '.<name>' or '[<expr>]' after '$$'
jsmql("$$.foo");                        // ❌ '$$' is statement-only and only supports '.push(...)'
jsmql("$$$$$.x");                       // ❌ LexError: Up to 4 levels of context reference are supported
```

The next sections document the full `$$$.<coll>.find/filter(...)` and `$$.push(...)` syntax. JSMQL does **not support** a cross-database **read** through `$$$$.<db>.<coll>.find/filter(...)`, because every non-federated MongoDB rejects a `{ db, coll }` join or union namespace — see [Cross-database reads](#cross-database-reads-not-supported). The only cross-database `$$$$` write JSMQL supports is the `$$$$.<db>.<coll> = …` `$out` destination ([below](#out-write-the-pipeline-to-a-collection)).

### Cross-collection lookups: `$$$.<coll>.find / .filter`

`$$$.<coll>.find(predicate)` and `$$$.<coll>.filter(predicate)` lower to MongoDB's `$lookup` stage. They are JS-style spellings for the most common join shape, and the two methods follow JS semantics:

| Method      | Returns                  | MQL lowering                                                    |
| ----------- | ------------------------ | --------------------------------------------------------------- |
| `.find(p)`  | one matching doc or null | `$lookup` + `$set { <as>: { $first: "$<as>" } }`               |
| `.filter(p)`| array of matching docs   | bare `$lookup`                                                  |

**Pipeline-mode only.** Lookups produce stages, not expressions, so they are valid only where a Pipeline output makes sense — assigned to a field with `$.x = …`, used as the RHS of `let`, or read inline as part of a chained terminal. `jsmql.filter()`, `jsmql.update()`, and `jsmql.expr()` reject lookup syntax with an actionable message that names `jsmql.pipeline()` / `jsmql()` as the right entry point.

**A chain that opens with a correlated equality is the pair.** A predicate that says this foreign field equals that field of the outer document (`$.x`, or a `const` bound to one) — alone, or as one `&&` condition among others — is the `localField` / `foreignField` join every MongoDB developer reads and writes. The planner reads it straight off the foreign index. MongoDB's own rules apply to it: a missing field counts as null, and an array matches element-wise, the same boundary a query document has. So `{ productIds: myProductIds }` with an array on both sides joins the orders that share **one** element with the list, from the multikey index.

**The links that follow it run in `pipeline` beside the pair.** MongoDB 5.0+ runs a `$lookup.pipeline` over the documents the pair matched, so a trailing `.toSorted(…)`, `.take(n)`, `.$group(…)` changes what the join *returns* and never what it *matches*. The same predicate is the same join with or without a `.take()`. `.find` is the pair with `{ $limit: 1 }` in that pipeline. The equality has to come first; after a sort or a cut it becomes a `$match` in place.

**The other `&&` conditions run beside the pair too.** `o.userId === $._id && o.status === "paid"` is the pair plus a `$match` in the pipeline, over the pair's matches. A constant condition stays a query document there. A condition that reads a date, a computed value, or a second outer field is `$expr`, and it carries every read of the outer document (`$.tier`, a `let` binding) into the stage's `let` clause under a correlation variable. When the predicate has no such equality — every condition is a comparison that is not one, or the equality sits under `||` — the whole predicate becomes `let` + `pipeline` + `$expr`. The pipeline form also uses the foreign collection's index (measured). A later link that reads the outer document keeps its `let` beside the pair.

```js
// One equality — the compact join, in either spelling
$.orders = $$$.orders.filter(o => o.userId === $._id);
$.orders = $$$.orders.filter({ userId: $._id });
// → [{ $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "orders" } }]

// The links after it run over the matched documents
$.recent = $$$.orders.filter({ userId: $._id }).toSorted({ placedAt: -1 }).take(5);
// → [{ $lookup: { from: "orders", localField: "_id", foreignField: "userId",
//                 pipeline: [{ $sort: { placedAt: -1 } }, { $limit: 5 }], as: "recent" } }]

// An array on both sides — joined on a shared element, from the multikey index
const mine = $.productIds;
$.coPurchases = $$$.orders.filter({ productIds: mine }).take(100);
// → [{ $set: { "__jsmql.var.mine": "$productIds" } },
//    { $lookup: { from: "orders", localField: "__jsmql.var.mine", foreignField: "productIds",
//                 pipeline: [{ $limit: 100 }], as: "coPurchases" } },
//    { $unset: "__jsmql" }]

// A second condition runs beside the pair, over its matches
$.paid = $$$.orders.filter(o => o.userId === $._id && o.status === "paid");
// → [{ $lookup: { from: "orders", localField: "_id", foreignField: "userId",
//                 pipeline: [{ $match: { status: "paid" } }], as: "paid" } }]

// A date bound is an expression, so it is `$expr` in that $match
$.recent = $$$.orders.filter(o => o.userId === $._id && o.createdAt > new Date().minus(1, "year"));
// → [{ $lookup: { from: "orders", localField: "_id", foreignField: "userId",
//                 pipeline: [{ $match: { $expr: { $gt: ["$createdAt",
//                   { $dateSubtract: { startDate: { $toDate: "$$NOW" }, unit: "year", amount: 1 } }] } } }],
//                 as: "recent" } }]

// An equality under || is no pair: the whole predicate runs as one $match
$.any = $$$.orders.filter(o => o.userId === $._id || o.total > 15);
// → [{ $lookup: { from: "orders", let: { jsmql_f0__id: "$_id" },
//                 pipeline: [{ $match: { $or: [{ $expr: { $eq: ["$userId", "$$jsmql_f0__id"] } }, { total: { $gt: 15 } }] } }],
//                 as: "any" } }]

// .find stops at the first match ($limit 1) and unwraps it, so the slot holds one document or nothing
$.user = $$$.users.find(u => u._id === $.userId);
// → [
//     { $lookup: { from: "users", localField: "userId", foreignField: "_id", pipeline: [{ $limit: 1 }], as: "user" } },
//     { $set: { user: { $first: "$user" } } }
//   ]

// A compound predicate — the pair, and `u.active` (the JavaScript truthiness test) beside it
$.user = $$$.users.find(u => u._id === $.userId && u.active);
// → [
//     { $lookup: {
//         from: "users",
//         localField: "userId",
//         foreignField: "_id",
//         pipeline: [{ $match: { $expr: /* u.active is truthy */ } }, { $limit: 1 }],
//         as: "user"
//       } },
//     { $set: { user: { $first: "$user" } } }
//   ]
```

**`.find` / `.filter` take a JavaScript predicate.** Their callback is JavaScript, so a `{ … }` body holds `const`/`let` bindings and one `return <expr>` — `o => { return o.active; }` means exactly what `o => o.active` means. JSMQL rejects a **pipeline stage** inside one, because a predicate says which documents to keep, not what stages to run:

```js
$.recentOrders = $$$.orders.filter(o => { $match(o.userId === $._id); $sort({ createdAt: -1 }); });
// ✗ `$match(...)` is a pipeline stage, not part of a callback —
//   write `$$$.orders.aggregate((o) => { $match(...); $sort(...); ... })`
```

**`.aggregate(pipeline)` — a full sub-pipeline for grouping, top-N, or reshaping.** When you need more than "keep matching docs" — a `$group`, a `$sort`+`$limit` top-N, a `$bucket`, a window stage — use `.aggregate()`, named after the driver's own `db.coll.aggregate(pipeline)`. It runs an arbitrary sub-pipeline against the foreign collection and lowers to `$lookup`. The argument is a **block-body arrow** `(o) => { $stage(...); ... }`, where each statement is a stage and none returns a value, or a **stage-array literal** `[{ $stage: ... }, ...]`. Inside, `o.<field>` is the foreign document's field, and `$.<field>` is the outer document, auto-hoisted into `let` exactly as in `.filter`:

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
//     localField: "_id",
//     foreignField: "userId",
//     pipeline: [
//       { $group: { _id: { $month: "$createdAt" }, total: { $sum: "$amount" } } },
//       { $sort: { _id: 1 } }
//     ],
//     as: "monthlyTotals" } }]
```

`.aggregate` is **a link like any other**, so it composes with the rest of the chain in
both directions. A `.filter` before it correlates, a lodash method before it bounds the
scan, and a lodash method after it ranks the groups. Everything lands in the one
`$lookup.pipeline`, in source order:

```js
$.byMonth = $$$.orders.filter(o => o.userId === $._id).aggregate((o) => {
  $group({ _id: { $month: o.createdAt }, total: $sum(o.amount) });
});

// Cap the scan first, group, then keep the top 3 groups — one $lookup, no
// intermediate array: [$sort, $limit, $group, $sort, $limit]
$.topRegions = $$$.orders.sort({ createdAt: -1 }).take(1000)
  .aggregate((o) => { $group({ _id: o.region, revenue: $sum(o.total) }); })
  .sort({ revenue: -1 }).take(3);
```

`.aggregate` takes the same `(element, index, collection)` params `.filter`/`.map` accept, but the index is positional-only. It is the pipeline-oriented spelling — reshape, roll up, or paste an array of stages — while `.find`/`.filter` are the element-predicate spellings; that split is why the `{ … }` block belongs to `.aggregate` alone. `.aggregate` also works on the current stream (`$$.aggregate((o) => { … })`), where the block's statements are simply the chain's stages — the same thing writing them directly, or chaining them (`$$.$sort({ … }).$limit(10)`), does. It earns its keep there in a [`$facet` branch](#facet-via----key--chain--), which *is* a sub-pipeline, so it has no "write them directly" alternative.

**The sub-stream count (`(o, _i, coll) => …`).** The 3rd param names the **sub-stream** the pipeline has produced so far; `coll.size()` is how many documents are in it, materialised by a `$setWindowFields` `$count` *inside* the `$lookup.pipeline`. Use it as an in-pipeline guard:

```js
$.orders = $$$.orders.aggregate((o, _i, coll) => {
  $match(o.userId === $._id);
  assert(coll.size() > 0, "User without orders is impossible");
});
```

Only `coll.size()` is available, because a stream has no array to index or iterate. The index (2nd) param may be present but JSMQL never *uses* it, because there is no per-doc stream index. **Caveat — empty sub-stream:** an in-pipeline `assert(coll.size() > 0, …)` runs *inside* the lookup pipeline, so when a user has **zero** matching orders there is no document for it to reject — the result is just `orders: []`, and the assert does not fire. To *guarantee* a non-empty result, assert on the materialised array at the outer level instead: `$.orders = $$$.orders.filter(o => o.userId === $._id); assert($.orders.size() > 0, "…");`.

**Chained terminals.** A lookup call is a first-class value. Chain `.size()` / `.reduce(fn, init)` on a `.filter` result, or a `.field` member access on a `.find` result, and JSMQL materialises the lookup into an internal `__jsmql.tmp.<N>` slot and reads the rest of the chain as a value over that slot. The same pipeline-scoped `let` that cleans up `__jsmql` clears the slot at the end:

```js
let nOrders = $$$.orders.filter(o => o.userId === $._id).size();
$.n = nOrders;
// → [
//     { $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "__jsmql.tmp.0" } },
//     { $set: { "__jsmql.var.nOrders": { $size: "$__jsmql.tmp.0" } } },
//     { $set: { n: "$__jsmql.var.nOrders" } },
//     { $unset: "__jsmql" }
//   ]

let total = $$$.tx.filter(t => t.userId === $._id).reduce((acc, t) => acc + t.amount, 0);
// → the same $lookup into a slot, then
//   { $set: { "__jsmql.var.total": { $reduce: { input: "$__jsmql.tmp.0", initialValue: 0, in: { $add: ["$$value", "$$this.amount"] } } } } }

let name = $$$.users.find(u => u._id === $.userId).name;
// .find's $first is applied first; the trailing .name reads off the scalar slot
```

**The materialised `$lookup` runs beside the stage that reads it.** A join written inside a callback reads the document that callback's *stage* receives, so JSMQL places the `$lookup` directly ahead of that stage — never at the front of the statement. The callback parameter of a chain link names what the previous link produced, and the join follows it:

```js
$$.$sortByCount($.tag).map(g => ({ _id: g._id, n: $$$.orders.filter(o => o.tag === g._id).size() }));
// → [{ $sortByCount: "$tag" },
//    { $lookup: { from: "orders", localField: "_id", foreignField: "tag", as: "__jsmql.tmp.0" } },
//    { $replaceWith: { _id: "$_id", n: { $size: "$__jsmql.tmp.0" } } }]
```

`g._id` is the group key `$sortByCount` made, and `localField: "_id"` reads it because the join stands after that stage. The same holds inside one `,`-joined run of writes: `$.k = $.pid, $.name = $$$.products.find({ _id: $.k }).name` joins on the `k` that the first write made.

**A join cannot read a variable an enclosing callback binds.** `$lookup` is a stage, and a stage runs over whole documents — it cannot run once per element of an array inside one document. So JSMQL rejects a join whose predicate reads a `.map` / `.filter` / `.reduce` element, and the message names the two spellings that work:

```js
$.names = $.items.map(x => $$$.products.find({ _id: x.pid }).name);
// ✗ 'x' is bound by an enclosing callback, and a read of another collection is a
//   '$lookup' STAGE …

$$ = $.items; $.name = $$$.products.find({ _id: $.pid }).name;     // ✅ each element is a document
let ps = $$$.products.filter(p => p.ok); $.n = $.items.map(x => ps.size());  // ✅ joined once, outside
```

A chained terminal (`.size()`, `.reduce`, `.map`) requires a preceding `.find/.filter`. JSMQL rejects a bare `$$$.coll.reduce(...)`, because it would be a Cartesian product over the whole foreign collection. JSMQL also rejects `.size()` and `.reduce` on a `.find()` result, with a targeted message: `.find` returns scalar-or-null (after `$set $first`), so an array reduction over it is not meaningful. To count matches, use `.filter(pred).size()`; to read a property of the matched doc, chain `.find(pred).<field>`.

**Stream-method chains push into the `$lookup.pipeline` body.** A sequence of registered stream methods (the stream-method vocabulary in [src/registry/names.ts](../src/registry/names.ts) — for example `.map`, `.toSorted`, `.slice`) chained on a `$$$.<coll>` receiver becomes the `$lookup`'s sub-pipeline. The slot then holds the already-transformed array, with no temp-slot reshape stage, and methods without a clean expression-form equivalent (a `.toSorted((a, b) => …)` comparator, `.flatMap` / `$unwind`) lower cleanly.

**Any lodash stream method may *start* the chain — not only `.find` / `.filter` / `.aggregate`.** The whole chain lowers, in source order, into one `$lookup.pipeline`, and a `.filter` / `.reject` may sit at any position — each becomes a `$match`, and correlates `$.<field>` into `let` when present. Because stages run in chain order, `.toSorted(k).take(n).filter(p)` sorts and caps the array *before* filtering — a different result from filter-first, one no prior spelling could express. A chain with no `$.` correlation emits the lean uncorrelated `$lookup`, with no `let`, matching the `.aggregate` shape:

```js
// The 200 most-recent orders (a recency window), then this product's co-purchases.
$.recentCoPurchase = $$$.orders.toSorted({ createdAt: -1 }).take(200).filter(o => o.productIds.has($._id));
// → { $lookup: { from: "orders", let: { jsmql_f0__id: "$_id" },
//       pipeline: [{ $sort: { createdAt: -1 } }, { $limit: 200 }, { $match: { $expr: /* includes */ } }], as: … } }
```

**Value-collapsing terminals (`.head` / `.first` / `.last` / `.nth` / `.size` / `.every` / `.some` / `.includes` / `.partition`, and the aggregates `.sum` / `.mean` / `.max` / `.min` / `.sumBy` / `.meanBy` / `.minBy` / `.maxBy`) return a *value*, so they work only in a value position.** Like a value-extracting `.map`, they pivot to value-mode over the lookup result — valid in an assignment or binding (`$.first = $$$.orders.filter(o => o.userId === $._id).head()`), and on a **bare** `$$$.<coll>` too, with no `.filter` needed (`$$$.orders.head()` means "over all orders"). JSMQL **rejects** them as a `$$ = …` stream pivot or a bare statement, because a value is not a stream or a stage. The error points you at the value position, or at `.take(1)` for a one-document stream. (`.keyBy` / `.countBy` / `.groupBy` are **not** in this list: they collapse to a lodash object but *do* have a stream lowering, so they work in both positions — see [Stream methods](#stream-methods-chained-after-the-rhs).)

```js
$.firstOrder = $$$.orders.filter(o => o.userId === $._id).head();  // ok — the first matching order (a doc value)
$.orderCount = $$$.orders.filter(o => o.userId === $._id).size();  // ok — the match count
$$ = $$$.orders.head();   // throws — a value can't be the new stream; use `.take(1)` for a 1-doc stream
$$$.orders.head();        // throws — a bare value isn't a pipeline stage; assign it
```

**A value-extracting `.map` runs value-mode on the result — anywhere in the chain.** A `.map("field")` / `.map(x => <expr>)`, with any body but an object literal, does **not** go into the sub-pipeline. A `$replaceWith` there would be invalid MQL whenever the mapped value is a scalar or an array, because MongoDB requires a document root. Whether it is the *last* method or feeds further methods, it runs as a value-mode `$map` over the lookup result array in the surrounding `$set`. A **block-body** value-extractor (`.map(x => { return <expr>; })`, or one with `const`/`let` bindings) behaves identically to the expression form — a `{ … }` callback body is just the arrow in disguise (`x => { const y = …; return y; }` → a `$let`):

```js
$.recentTotals = $$$.orders
  .filter({ userId: $._id })
  .toSorted({ placedAt: -1 })
  .take(5)
  .map(o => o.total);
// → [{
//     $lookup: {
//       from: "orders",
//       localField: "_id",
//       foreignField: "userId",
//       pipeline: [
//         { $sort: { placedAt: -1 } },      // toSorted({ placedAt: -1 })
//         { $limit: 5 },                    // take(5)
//       ],
//       as: "__jsmql.tmp.0",
//     },
//   },
//   // terminal .map → value-mode $map on the result:
//   { $set: { recentTotals: { $map: { input: "$__jsmql.tmp.0", as: "o", in: "$$o.total" } } } },
//   { $unset: "__jsmql" }]

// Scalar extraction — the case a sub-pipeline $replaceWith can't express:
$.userIds = $$$.orders.filter(o => o.uid === $.id).map("userId");
// → $lookup (pipeline: [$match]) + $set { userIds: { $map: { input, in: "$$…​.userId" } } }

// Mid-chain: the extraction feeds further value methods — the whole tail is value-mode:
$.productIds = $$$.orders.filter(o => o.userId === $._id).map("productIds").flatten().uniq();
// → $lookup (pipeline: [$match]) + $set { productIds: uniq(flatten($map(result, "productIds"))) }
```

The `.size()` / `.reduce` / member-access terminals take precedence — `.filter(p).map(...).size()` emits `$size` against the materialised, transformed slot. An **object-literal-body** `.map(x => ({ … }))` yields a document, so it stays in the sub-pipeline as a `$replaceWith`, and a following `.take` etc. lowers to `$limit` there. A `.map(x => { … ; return ({ … }) })` block that returns one does the same. Non-registered chain methods (`.toLowerCase`, `.padStart`, …) fall through to the existing expression-form path unchanged.

**Validate or reshape with intermediate stages — `.aggregate`.** `.map` is a per-document reshape, so its callback is JavaScript, and JSMQL rejects a stage inside it. To run stages *and* reshape, use `.aggregate` and write the reshape as `<param> = <expr>`, which replaces the body's own document — the same `$replaceWith` a `.map` emits. `$` is the OUTER document at every depth, so JSMQL refuses `$ = …` inside a body and names the parameter. The block has the full `;`-separated statement vocabulary — `assert(...)`, `$match(...)`, `let`, `<coll>.size()`, and nested `$$$.<coll>` lookups:

```js
$.orders = $$$.orders.filter(o => o.userId === $._id).aggregate(o => {
  assert(o.total > 0, "order total must be positive");
  o = { id: o._id, total: o.total };
});
// → the orders $lookup.pipeline gains, after the filter's $match:
//     { $match: { $expr: { $convert: { input: true, to: { $cond: [{ $gt: ["$total", 0] }, "bool", "jsmql assertion failed: order total must be positive"] } } } } },
//     { $replaceWith: { id: "$_id", total: "$total" } }
```

As in a `.map`, the lambda parameter *is* the current document (`o.total` → `$total`), and a `$.<field>` reference *reads* the outer document, auto-hoisted into `let`.

**Why does `.find()` keep JS-faithful cardinality?** MongoDB's `$lookup` always returns an array. JSMQL adds a `$set { <as>: { $first: "$<as>" } }` so `.find()` matches JS's scalar-or-null contract. The trade-off is one extra in-place `$set` stage. Even when the predicate matches several foreign docs, the row count stays stable, unlike the `$unwind preserveNullAndEmptyArrays` alternative, which fans rows out.

**Caveats:**
- **Nested lookups work at any depth, in a predicate and in an `.aggregate` sub-pipeline alike.** A `$$$.coll2.find/filter(...)` inside another lookup's lambda materialises as a prologue `$lookup` stage inside the outer's `$lookup.pipeline`. A reference to the enclosing-foreign param (`o.x`) auto-lets into the inner's `$lookup.let` clause. Predicate example: `$.posts = $$$.posts.filter(p => p.userId === $._id && $$$.tags.filter(t => t.postId === p._id).size() > 0)`. Sub-pipeline example: `$.users = $$$.users.aggregate(u => { $match(u.active); u.orders = $$$.orders.filter(o => o.userId === u._id); })`.
  - **Cross-level references resolve correctly at any depth.** A reference to an *ancestor* scope needs one capture, at the level it belongs to. This applies to the root stream count (`$$.size()`), the root doc (`$.field`), an enclosing foreign param (`outer.field`), an ancestor sub-stream count (`outerColl.size()`, the 3rd `.aggregate` param, computed on that ancestor's own pipeline rather than the one reading it), and an outer-pipeline `let`/`const` declared before the lookup. JSMQL captures each **once** into the `$lookup.let` of its own level (depth-stamped `jsmql_f<d>_…` for fields, `jsmql_s<d>_…` for counts, `jsmql_v<d>_…` for bindings), and every deeper level reads it back through MongoDB's `$$`-variable propagation. So one sub-pipeline can read four different "lengths" at once — `$$.size()` (root stream count), `$.length` (a root doc field), a `const` derived from it, and `coll.size()` (the sub-stream). Each resolves to its own var with no collision, and each takes its value from the right document, not the immediate parent. This needs the **correlated** lookup form (`$$ = $$$.<coll>.filter(o => o.x === $.y).aggregate(…)` or `$.field = $$$.<coll>.filter(…)`). A bare `$$ = $$$.<coll>.aggregate(…)`, with no filter, is a [`$unionWith` source-switch](#replace-stream-via---expr) that *replaces* the stream, so it cannot read the outer doc, count, or `let` inside it — only `coll.size()` is available there.
- **`$$.find(...)` (self-join on the current collection)** needs collection-name binding from a schema or driver `[DEF-013]` — see [DEFERRED.md](DEFERRED.md).
- **`.find()` multi-match.** `$first` picks the first matching doc, and the ordering follows MongoDB's storage order. For deterministic single-doc selection, use `.aggregate((o) => { …; $sort({ … }); $limit(1); }).at(0)`.
- **Bracket-index collection name.** The bracket form `$$$[collVar]` accepts a string literal *or* a [`jsmql.compile`](#parameterised-queries-jsmqlcompile) parameter binding — JSMQL inlines its value into `$lookup.from` at call time. A runtime field-ref (`$$$[$.dynColl]`) cannot become the compile-time `from` field, so JSMQL rejects it with the bare-reference error. Non-string bindings (number, array, …) throw a precise "parameter binding must be a string" error.

### Cross-database reads: not supported

JSMQL **rejects a cross-database read at compile time** — naming another database in a `.find` / `.filter` join, or in a `$$.push(...)` union. Each of these forms throws:

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

**Why.** A cross-database `.find` / `.filter` would have to compile to `$lookup` (or `$unionWith`) with a `from: { db, coll }` *namespace object*. That object form works only on **Atlas Data Federation**: every regular MongoDB deployment (standalone, replica set, sharded cluster) validates `$lookup.from` on the server as a bare collection-name *string*, and rejects the object at runtime. Per HR3 (JSMQL never knowingly emits invalid MQL), JSMQL rejects these reads at compile time instead of emitting a shape that will not run. The rejection lives on the join road in [`src/compiler/emit/join.ts`](../src/compiler/emit/join.ts), which every join chain passes through.

**What to write instead.** Reference the collection in the *current* database with same-database `$$$.<coll>` (drop the `$$$$.<db>.` prefix) and run the pipeline against the database that holds the data:

```js
$.archivedOrders = $$$.orders.filter(o => o.userId === $._id);  // ✅ same-db $lookup
```

**Cross-database writes still work.** The one cross-database `$$$$` form that *is* supported is the `$out` destination — `$$$$.<db>.<coll> = $$` lowers to `{ $out: { db, coll } }`, which MongoDB does accept. See [`$out`](#out-write-the-pipeline-to-a-collection). Server/cluster-scoped diagnostics on `$$$$` (`$$$$.currentOp()`, `$$$$.shardedDataDistribution()`, …) are also unaffected — see [System / diagnostic stages](#system--diagnostic-stages-indexstats-currentop-).

### Collection union: `$$.push(...)`

`$$` is the current collection. `.push(...items)` appends those items to the current stream — the JS-faithful name for MongoDB's [`$unionWith`](https://www.mongodb.com/docs/manual/reference/operator/aggregation/unionWith/) stage. **Statement-only**: `$$.push(...)` emits one or more `$unionWith` stages and has no value. You cannot use it on a RHS, in arithmetic, inside a Filter, or anywhere else JSMQL reads an expression.

The spread (`...`) rule is identical to JavaScript's: you must spread arrays, and you must not spread scalars. `.concat(list)` is the other JavaScript spelling, and it takes the array itself.

**JSMQL cannot append an array the DATA decides.** `$documents` takes a list the program spells out. MEASURED: the server refuses a field path there ("an array is expected"). So JSMQL refuses `$$.push(...$.items)`, and the message names what does work — another collection, a written list of documents, or `$$ = <array>` to make the stream FROM that array rather than append to it.

```js
// 1. Bare collection — short form.
$$.push(...$$$.archive_users);
// → { $unionWith: "archive_users" }

// 2. .filter(pred) spread — pipeline-form $unionWith.
$$.push(...$$$.archive_users.filter(u => u.active === true));
// → { $unionWith: { coll: "archive_users", pipeline: [{ $match: { active: true } }] } }
//   (a bare `u.active` is the JavaScript truthiness test, and rides in `$expr`)

// 3. .find(pred) without spread — single-doc append.
$$.push($$$.archive_users.find(u => u._id === "ABC"));
// → { $unionWith: { coll: "archive_users", pipeline: [{ $match: { _id: "ABC" } }, { $limit: 1 }] } }

// 4. Inline document — lowers to a $documents sub-pipeline.
$$.push({ _id: 1, name: "Alice" });
// → { $unionWith: { pipeline: [{ $documents: [{ _id: 1, name: "Alice" }] }] } }

// 4b. A written LIST of documents, spread — the same batch.
$$.push(...[{ a: 1 }, { a: 2 }]);
// → { $unionWith: { pipeline: [{ $documents: [{ a: 1 }, { a: 2 }] }] } }

// 4c. `.concat(list)` takes the array itself, as JavaScript's own .concat does.
$$.concat([{ a: 1 }]);
// → { $unionWith: { pipeline: [{ $documents: [{ a: 1 }] }] } }

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

// 7. Aggregate source — a full sub-pipeline (uncorrelated: `$unionWith` has no `let`).
$$.push(...$$$.archive_users.aggregate(u => {
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
| `$$$.coll` (bare collection) | yes | it stands for an array of docs |
| `$$$.coll.filter(pred)` | yes | `.filter` returns an array |
| `$$$.coll.find(pred)` | **no** | `.find` returns a single doc; spreading a scalar is a JS TypeError |
| `{ ... }` (inline document) | **no** | it is a scalar, so push it as one item |

JSMQL enforces each rule at compile time with a targeted error:

- `$$.push($$$.coll.filter(pred))` (forgot the `...`) → "use undefined to merge documents from another collection".
- `$$.push(...$$$.coll.find(pred))` (spurious `...`) → "undefined returns a single document; drop the undefined".

**`$unionWith` has no `let` slot.** A predicate inside `$$.push(...$$$.coll.filter(pred))` may reference only foreign-document fields. A `$.` reference (`o.userId === $.tenantId`) triggers a compile-time error that points you at the fix: move the local filter to a `$match(...)` stage *before* the push.

**Index-friendly inner `$match`.** When the predicate translates to query syntax, the same engine `$match` itself uses, the inner `$match` emits the index-friendly `{ field: value }` form, not a blanket `$expr` wrap, so MongoDB can use indexes on the foreign collection.

**Server version.** The bare `$documents`-only form of `$unionWith`, used for inline docs without a `coll`, requires **MongoDB 6.0+**. Spreads against existing collections work on every server that supports `$unionWith` (4.4+).

**Statement-only.** `$$.push(...)` must appear as a top-level Pipeline statement. JSMQL rejects `let x = $$.push(...)`, `$.x = $$.push(...)`, or any other read of the result, with the statement-only error. Filter / `jsmql.expr` / `jsmql.update` reject the syntax wholesale, because collection union is Pipeline-only.

**Nested.** JSMQL rejects `$$.push(...)` inside a lookup's `.aggregate` block or inside a sub-pipeline (`$facet.*`, `$lookup.pipeline`, `$unionWith.pipeline`), with a hoist-to-outer hint — the stages it would emit cannot land inside the inner pipeline without changing what gets unioned.

### `assert`: fail the pipeline when an invariant breaks

`assert(condition[, message])` is a guard clause for a pipeline. When `condition`
holds, the document passes through unchanged. When it fails, the **whole operation
aborts** with a server error that carries your `message`. It is the closest thing to
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
tail. JSMQL cannot set a custom error *code*; it can set only the message text.

**How it works, and why not JS.** MongoDB has no native assert/throw operator. The
one mechanism that carries a custom message — `$function` (server-side JS) — is
deprecated in MongoDB 8.0 and unavailable under the Stable API and on Atlas
Flex/free tiers, so JSMQL avoids it. Instead `assert` feeds the (prefixed)
message to `$convert` as a bogus target type. A holding assertion converts a
constant `true` to `bool` (a no-op the surrounding `$match` keeps); a failing one
trips `Unknown type name`. The `jsmql assertion failed:` prefix is required, not
decorative — it stops a message that happens to be a real type name (for example
`"int"`) from making the convert *succeed* and silently skipping the check.

**Statement-only.** `assert(...)` must be a top-level Pipeline statement — it has
no value. JSMQL rejects `$.x = assert(...)`, `cond ? a : assert(...)`, or any other
read of the result, with a hint that points at the statement form. `jsmql.filter` /
`jsmql.expr` reject it wholesale, because it is Pipeline-only; `jsmql.update`
rejects it too, because an update document is made of writes.

### `$$.size()`: count the current stream

`$$` is the current stream; `$$.size()` is its document count **at the point you
use it** — `.size()`, as `Set.size` names a count. It is a value you can use anywhere an
expression goes: a field, arithmetic, an `assert` condition, a stage body.

```js
// Annotate every doc with the size of the (filtered) stream.
jsmql(`$match($.status === "active"); $.activeCount = $$.size();`);
// → [
//     { $match: { status: "active" } },
//     { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
//     { $set: { activeCount: "$__jsmql.size" } },
//     { $unset: "__jsmql" }
//   ]

// Reuse is free; the count is RECOMPUTED after a stage that changes it.
jsmql(`$.before = $$.size(); $match($.keep); $.after = $$.size();`);
// → before = pre-match count, after = post-match count (two $setWindowFields)

// The conditional-error use — "at most one match":
jsmql(`$match($.email === "me@x.com"); assert($$.size() <= 1, "expected ≤ 1 user");`);
```

**How it works.** MongoDB has no inline "stream count" operator, so JSMQL
materialises one. A `$setWindowFields` `$count` stamps the count onto every
document, under `__jsmql.size`, cleaned up by the trailing `$unset`, and
`$$.size()` reads it back. JSMQL emits the materialiser **once**, before the first
use, **reuses** it while it stays valid, and **recomputes** it after any stage that
changes the count or drops the field (`$match`, `$group`, `$unwind`, `$project`,
…). This needs **MongoDB 5.0+** (`$setWindowFields`), and it buffers the stream
(100 MB / `allowDiskUse`), like any window or group stage.

**`$$` is always the ROOT stream — at any nesting depth.** Mirroring `$` (the
root document), `$$` is the top-level stream even when you read `$$.size()`
*inside* a `$lookup` sub-pipeline. There JSMQL materialises the root count at the
top and passes it into the lookup automatically — as the `localField` when the
predicate is one equality, and as a `$lookup.let` correlation variable
(`jsmql_s0_size`) otherwise — so it reads back correctly:

```js
// "this user's recent-order count vs the total recent-user count"
jsmql(`$.peers = $$$.users.filter(u => u.orderCount === $$.size());`);
// → [
//     { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
//     { $lookup: { from: "users", localField: "__jsmql.size", foreignField: "orderCount", as: "peers" } },
//     { $unset: "__jsmql" }
//   ]
```

To count an **inner** sub-stream instead of the root, use the 3rd callback param —
`$$$.orders.filter(p).map((o, _i, coll) => coll.size())` (see *Cross-collection
lookups* above). `$$.size()` counts the root; `coll.size()` counts that sub-stream.

Each handle counts **the stream the callback that bound it runs over**, at any depth.
A body nested inside another can read both its own count and every ancestor's at
once, and JSMQL takes each from the right documents — the ancestor's count is
computed on the ancestor's own pipeline and carried down through the `$lookup.let`
it passes:

```js
$$ = $$$.orders.filter({ userId: $._id }).aggregate((o, _i, ordersColl) => {
  o.items = $$$.items.filter({ orderId: o._id }).aggregate((t, _k, itemsColl) => {
    t = { id: t._id, inThisOrder: itemsColl.size(), ordersForUser: ordersColl.size() };
  });
});
```

**Scope.** Pipeline-only — a Filter / `jsmql.expr` has no stream to count.
`$$.size()` is the root count at every depth: a `$lookup` body (predicate,
`.aggregate` block, or `.map` chain) reads it through the `$lookup.let` capture
above, and a `$facet` branch and a declared function body read the stamped field
directly. The one place it cannot reach is a `$$.push(…)` (`$unionWith`) body,
because that stage has no `let`, so the compiler refuses the read and names the
join form that carries the value. Two other positions refuse it for the same
reason, and each names the rewrite that works: the body of a stage the server
requires FIRST (`$geoNear`, `$documents`, `$search`, …), because the
`$setWindowFields` would have to run ahead of a stage nothing may precede; and the
body of the stage that writes the output (`$merge`'s `let`), because JSMQL clears
its scratch fields in the stage right before it.

### `$out`: write the pipeline to a collection

An assignment to a context-ref-rooted LHS writes the current pipeline's documents into a destination collection — MongoDB's [`$out`](https://www.mongodb.com/docs/manual/reference/operator/aggregation/out/) stage. The destination name sits on the **left** (where the documents go), and the source, optionally filtered, sits on the **right**:

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

// 5. Chained stages — a full sub-pipeline lands before the $out.
jsmql("$$$.top10 = $$.$sort({ score: -1 }).$limit(10);")
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

Bracket and dotted segments mix freely (`$$$$.dw["archive"]` is equivalent to `$$$$["dw"].archive`). Bracket is **required** for non-identifier names (hyphens, dots, leading digits, reserved words). JSMQL rejects a computed bracket (`$$$[someVar]`), because the destination must be a literal so you can read it from the source. For parameterised destinations, use `jsmql.compile` and pass the name in as a binding.

**RHS chain:**

| Method | Stage | Notes |
|---|---|---|
| bare `$$` | (none) | Writes the current stream unchanged. |
| `$$.filter(<predicate>)` | `$match` | The same index-friendly translator `$match` uses, and the same predicate spellings as everywhere else — query syntax, with any residual in `$expr`. For several stages, chain them instead (`$$.$match({ … }).$sort({ … })`). |
| `$$.reject(<predicate>)` | `$match` | The negation of `.filter` — `$match: { $expr: { $not: … } }`, the same as in a `$$ =` chain. |
| `$$.<streamMethod>(…)` | that method's stage(s) | Any chainable stream method (for example `.take(n)`, `.toSorted(…)`) — see [Stream methods chained after the RHS](#stream-methods-chained-after-the-rhs) for the vocabulary. |
| `$$.$<stage>(…)` | that stage | A chained stage call (for example `$$.$sort({ … })`). A `$out` chain runs at the outer pipeline level, so this is an ordinary top-level stage placed before the write. |

JSMQL rejects a method in neither form, and the error names the equivalent stage call as a workaround (`$group({ … }) before the $out`, …).

**`$out` must be the last stage.** Anything after the sugar throws an actionable compile-time error that points at the offending later statement. The same guard rejects two `$out` statements in one pipeline.

**Pipeline-mode only.** Like `$$.push(...)` and `$$$.<coll>.find(...)`, JSMQL refuses the `$out` sugar in Filter (`jsmql.filter`), expression (`jsmql.expr`), or update-pipeline (`jsmql.update`) modes. `$out` writes are a Pipeline-only concept, and MongoDB itself rejects them inside `db.coll.updateOne(filter, update)`.

**Why the `$$$.<coll> = …` LHS, not `$ = $out(...)`?** JSMQL reserves `$ = …` for *root-replacing* sugar (see [Replace root via `$ = <expr>`](#replace-root-via---expr)). `$out` writes elsewhere and does not replace the current document, so the LHS makes the destination visible on the left, mirroring `$lookup` (`$$$.<coll>.find(...)`) and `$unionWith` (`$$.push(...)`).

#### Adding to a collection instead of replacing it — `$merge`

`$out` REPLACES the destination: whatever it held is gone. `$merge` ADDS to it — it
updates the documents whose `_id` matches, and inserts the rest. JSMQL spells the
difference as `=` against `+=`:

```js
jsmql("$$$.metrics = $$;")
// → [{ $out: "metrics" }]                        the collection now holds only these

jsmql("$$$.metrics += $$;")
// → [{ $merge: "metrics" }]                      what was there is kept

jsmql("$$$.metrics += $$.filter(d => d.active);")
// → [{ $match: <translated d => d.active> }, { $merge: "metrics" }]
```

The JavaScript verbs that mean "add to this" write the same stage, and they also
accept an **array** of documents, which `+=` does not:

```js
jsmql("$$$.metrics.concat($$);")
// → [{ $merge: "metrics" }]                      the same as `+=`

jsmql("$$$.metrics.concat($.items);")
jsmql("$$$.metrics.push(...$.items);")
// both → [{ $set: { "__jsmql.tmp.0": "$items" } },
//         { $unwind: "$__jsmql.tmp.0" },
//         { $replaceWith: "$__jsmql.tmp.0" },
//         { $merge: "metrics" }]

jsmql("$$$.metrics.push($.summary);")
// → [{ $replaceWith: "$summary" }, { $merge: "metrics" }]
```

The spread is what tells the two `.push` forms apart, exactly as in JavaScript:
`.push(...xs)` writes one document per element of `xs`, and `.push(x)` writes `x`
itself as one document. If you push a list without the spread, JSMQL refuses it and
the message names the spread.

`$merge`'s four settings — `on`, `whenMatched`, `whenNotMatched`, `let` — need no
sugar. Write the stage directly:

```js
jsmql('$merge({ into: "metrics", on: "_id", whenMatched: "merge" });')
// → [{ $merge: { into: "metrics", on: "_id", whenMatched: "merge" } }]
```

Everything the `$out` sugar states above also holds for `$merge`: it must be the last
stage, it works only in Pipeline mode, and the destination shapes are the same.

---

### System / diagnostic stages: `$$.indexStats()`, `$$$$.currentOp()`, …

A handful of MongoDB stages do not transform the stream — they *produce* it (index metadata, collection stats, running ops, …), so each must be the pipeline's **first** stage. They also differ by *where* they run, and JSMQL encodes that scope in the context-ref prefix: call the stage as a method on the ref whose scope matches. There are two tiers. The stages run either on **your collection** (`$$`) or on the **deployment/admin** (`$$$$`); none target the *current* database, so `$$$` carries no diagnostics.

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

The method name is the stage name minus the leading `$`. The optional argument is the stage's options object; omit it for an empty `{}`. The two no-option stages — `$$.indexStats()` and `$$.planCacheStats()` — take no argument, and neither does `$$$$.shardedDataDistribution()`.

| Prefix | Scope | Driver | Stages |
| ------ | ----- | ------ | ------ |
| `$$`   | collection | `db.coll.aggregate()` | `.indexStats()`, `.collStats({…})`, `.planCacheStats()`, `.listSearchIndexes({…})` |
| `$$$`  | database   | —                      | *(none — diagnostics are collection- or server-scoped)* |
| `$$$$` | cluster/server | admin / config DB  | `.currentOp({…})`, `.listSessions({…})`, `.listLocalSessions({…})`, `.listSampledQueries({…})`, `.shardedDataDistribution()` |

Why `$$$$` and not `$$$` for `currentOp` and its siblings? MongoDB requires them to run on the **admin** database — `$listSessions` reads the cluster-wide `config.system.sessions`, never your current application database — and they report deployment-wide state. `$$$` means "current database" (the DB `$$$.<coll>.find()` joins into), so `$$$.currentOp()` would read as "ops in *this* database", which you cannot physically run. `$$$$` (cluster/server) is the honest home.

Because the prefix *is* the scope, using a stage at the wrong scope raises a **compile-time** error that names the right prefix. JSMQL catches the classic "ran undefined against a collection, or against the wrong database" mistake before it reaches the driver:

```js
jsmql("$$.currentOp()");
// ❌ 'currentOp' is a cluster-scoped system stage — write '$$$$.currentOp(...)' (the '$$$$' cluster reference, run on the admin database), not '$$'.

jsmql("$$.indexStat()");
// ❌ '$$.indexStat(...)' is not a known diagnostic stage. … Did you mean '$$.indexStats(...)'?

jsmql("$match($.x > 1); $$.indexStats();");
// ❌ '$$.indexStats(...)' produces the pipeline's source documents ($indexStats), so it must be the first stage.
```

**Pipeline-mode only**, like `$$.push(...)` and the lookup/`$out` sugars, because these are source stages, not Filter predicates.

> The plain stage forms (`jsmql("[{ $indexStats: {} }]")` and `jsmql("$indexStats({})")`) still work; the `$$`/`$$$`/`$$$$` sugar adds discoverability and scope-checking.

---

## Mistakes caught at compile time

The MongoDB server validates your pipeline before running it and rejects malformed
ones with terse errors. JSMQL is a compiler, so it catches these *as you compile* —
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
// ✗ '$text' reads the text index, and the server reads that index at the START of a
//   pipeline. Put the '$match' that uses it first and filter further in a later '$match'.

jsmql.expr("$dateAdd({ startDate: $.t, unit: 'fortnight' })")
// ✗ '$dateAdd' requires the 'amount' field, but it is missing.   (+ unit enum, on the next pass)

jsmql.expr("$dateAdd({ startdate: $.t, unit: 'day', amount: 1 })")
// ✗ '$dateAdd' has no parameter 'startdate'. Did you mean 'startDate'? Valid keys: startDate, unit, amount, timezone.

jsmql.expr("$divide(6, 2, 1)")
// ✗ $divide(dividend, divisor) requires exactly 2 arguments, got 3.

jsmql.expr("$year('2020-01-01')")
// ✗ '$year' expects a date, but got a string. Use a field path or new Date(…).
```

JSMQL checks four things during a compile:

- **Stage placement.** A source stage such as `$collStats`, `$geoNear`, or `$changeStream` must come first. `$out` and `$merge` must come last. JSMQL forbids some stages inside a `$facet`, `$lookup`, or `$unionWith` sub-pipeline.
- **Stage body shape.** JSMQL checks the literal type, range, enum, required-key, and mutual-exclusivity rules — for example `$count('')`, `$bucket` boundaries out of order, or a typo in a `$merge` `whenMatched` value.
- **`$match` query operators.** JSMQL checks `$text` placement at any depth of the body, the `$near` ban, and the `$where` call form.
- **Operator arguments.** JSMQL checks the operand count (`$divide` takes 2 arguments), required and unknown object keys (with a `Did you mean '…'?` hint), enum slots such as `unit`, `startOfWeek`, `$convert.to`, and regex flags, and literal types — for example a non-date value in a date slot, or a non-number value in `$abs`.

Call `jsmql.validate(...)` to get these as a list of `{ message, pos }` objects instead of a throw.

### A method chained on the wrong type

When JSMQL knows what a value *is*, it also knows which methods can follow it — so a chain that would be a `TypeError` in JavaScript is a compile error here, with the conversion you actually wanted named in the message:

```js
jsmql.expr('$.createdAt.startOf("month").map(x => x)')
// ✗ '.map(...)' expects an array receiver, but '.startOf(...)' returns a date.
//   Call '.map(...)' on an array value instead.

jsmql.expr('$.createdAt.plus(1, "day").toUpperCase()')
// ✗ '.toUpperCase(...)' expects a string receiver, but '.plus(...)' returns a date.
//   Render the date as a string first with '.format("%Y-%m-%d")' or '.toISOString()'.

jsmql.expr('$.items.every(x => x.ok).filter(y => y)')
// ✗ '.filter(...)' can't run on a boolean — the value before it evaluates to true/false…

jsmql.expr('$.tags.split(",").toUpperCase()')
// ✗ '.toUpperCase(...)' expects a string receiver, but the value before it returns an array.
//   Map over the array first, e.g. '.map(x => x.toUpperCase(...))', or take one element with '.at(0)'.
```

Every method that applies to only one type takes part, in both directions. JSMQL refuses an array-only method (`.map`, `.findIndex`, `.sort`, `.reduceRight`, …) on a string, number, date or document receiver, and it does the same for the string-only, number-only, date-only and document-only methods. JSMQL never refuses a method that genuinely accepts more than one type: `.slice`, `.concat`, `.indexOf`, `.includes` and `.lastIndexOf` work on a string or an array, `.size` works on an array or a document, `.clamp` and `.inRange` work on a number or a date, and `.toString` / `.getTime` work on anything.

JSMQL knows a receiver's type whenever it comes from a method with an invariant result (`.trim()` → string, `.startOf()` → date, `.map()` → array, `.some()` → boolean, `.size()` → number), from an operator whose result type is invariant (`$concat(...)` → string, `$dateTrunc(...)` → date, `$year(...)` → number), from `new Date(…)`, from a literal or a template string, or from a written field (see [Type-aware dispatch](#type-aware-dispatch)).

Where JSMQL does not know the type, it rejects nothing and emits the MQL: a field path (`$.whatever`), an element plucked with `.find()` / `.at()`, a `.reduce()` result, a `.clamp()` that could be numeric or a date, and any operator whose result type follows its arguments — `$add` / `$subtract` (number or date), `$min` / `$max` / `$first` (an element of the array), `$ifNull` / `$cond` / `$switch` / `$getField` (whatever value they receive). `.toString()` and `.getTime()` are exempt everywhere, as they are in JavaScript.

**This check follows JavaScript, not MongoDB's coercions.** MongoDB would happily run `$toUpper` on a date and hand back the stringified date; JavaScript throws on `date.toUpperCase()`, and so does JSMQL, because you almost certainly meant `.format(…)`. If you write the operator by hand (`$toUpper($.createdAt)`), it still passes through untouched — raw MQL is yours.

**Only certain mistakes throw.** If the offending value is a field reference or expression
JSMQL cannot evaluate (`$limit($.pageSize)`, `$bucket({ boundaries: $.bounds })`), JSMQL
emits the MQL as-is — it never blocks a query it cannot *prove* is wrong. JSMQL also leaves
constraints that depend on your deployment (sharding, transactions, memory limits, Atlas
availability) to the server.

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

**Operator flattening:** The compiler flattens chained `&&`, `||`, `+`, `*`, and `??` operators into one MongoDB array. It does not nest them:
```js
$.a + $.b + $.c                // → { $add: ["$a", "$b", "$c"] }
$.a > 1 && $.b > 2 && $.c > 3  // → { $and: [{ $gt: ["$a", 1] }, { $gt: ["$b", 2] }, { $gt: ["$c", 3] }] }   (a Filter merges them into one query document)
$.a > 1 || $.b > 2 || $.c > 3  // → { $or: [{ $gt: ["$a", 1] }, { $gt: ["$b", 2] }, { $gt: ["$c", 3] }] }
$.a ?? $.b ?? $.c              // → { $ifNull: ["$a", "$b", "$c"] }
```
Between plain values (`$.x && $.y`), the operators keep JavaScript's meaning. The result is the operand that decided, after the JavaScript truthiness test. See [Truthy and falsy](#truthy-and-falsy).

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
// In a raw query document a field READ has no query form: the query language compares
// against a constant, so "$b" there is the two-character string. Such a value lifts whole:
//   { a: [1, $.b] }        → { $expr: { $eq: ["$a", [1, "$b"]] } }
//   { a: { $gte: $.since } } → { $expr: { $gte: ["$a", "$since"] } }
// A value with no read in it is your own MQL and passes through as written.

$.status in ["active", "pending"]   // { $in: ["$status", ["active", "pending"]] }
// in a filter (no ';'), a constant list is the native query operator — the '$not' keeps JavaScript's
// meaning, a test of the scalar, where MongoDB's '$in' alone would also match an array field holding the value:
//   {status:{$in:["active","pending"]}}
$.key in { foo: 1, bar: 2 }         // { $in: ["$key", ["foo", "bar"]] }    (property existence)
```

#### `===` / `!==` vs `==` / `!=` — null and missing fields

JSMQL tracks the JS distinction between strict and loose equality. It maps each to a natural MongoDB semantics around `null` / missing fields:

- **`===` / `!==`** are JS-like strict equality. Use them for every comparison except null-vs-missing checks.
- **`==` / `!=`** apply only to comparisons against `null`. This is the one JS idiom where `==` has one clear, useful meaning: it matches null or missing. Any other use is a compile error that points you at `===`. This removes the usual JS `==` trap of silent type coercion, a common source of bugs in plain JavaScript.

| JSMQL              | Matches                              | MQL (expression context)                                              | MQL (`$match` body)                          |
| ------------------ | ------------------------------------ | --------------------------------------------------------------------- | -------------------------------------------- |
| `$.x === null`     | only real `null` (excludes missing)  | `{ $eq: ["$x", null] }`                                               | `{"x":{"$type":"null"}}` |
| `$.x !== null`     | anything except real `null` (incl. missing) | `{ $ne: ["$x", null] }`                                        | `{"x":{"$not":{"$type":"null"}}}` |
| `$.x == null`      | null OR missing                      | `{ $in: [{ $type: "$x" }, ["null", "missing"]] }`                     | `{"x":null}` |
| `$.x != null`      | neither null nor missing             | `{ $not: [{ $in: [{ $type: "$x" }, ["null", "missing"]] }] }`         | `{"x":{"$ne":null}}` |
| `$.x === 5`        | `5`                                  | `{ $eq: ["$x", 5] }`                                                  | `{"x":5}` |
| `$.x == 5`         | **compile error**                    | —                                                                     | —                                            |

The error for non-null `==`:

> `'=='` is only allowed against null in jsmql. Use `'==='` for JS-like strict equality (no surprising type coercion). To match "null or missing", write `$.x == null`.

`null` may appear on either side: `null == $.x` is identical to `$.x == null`.

The `$match` column reads the field's **own** value (see [No semicolons → Filter](#no-semicolons--filter)). An equality excludes an array field. A negation (`!==`, `!= null`) is a two-branch `$or`, because an array field is *not equal* to the literal in JavaScript and must match.

**`in` operator semantics:**
- A list spelled in the source on the right → value membership, MongoDB's own `$in`: `$.x in [1, 2, 3]` is true when `$.x` equals 1, 2, or 3, and in a filter it is `{ x: { $in: [1, 2, 3] } }`. *(JavaScript itself tests index existence here.)*
- An object literal on the right → key existence, as in JavaScript: `$.x in { a, b }` is true when `$.x` equals `"a"` or `"b"`. JSMQL supports computed keys and `...spread`, and reads spread keys at run time through `$objectToArray`.
- Any other value on the right → the key test on an object. `"k" in $.o` reads the field: `{ $ne: [{ $type: { $getField: { field: "k", input: "$o" } } }, "missing"] }`, and in a filter `{ "o.k": { $exists: true } }`. A computed key is searched among the object's keys, and a missing object has none (HR5). A value the compiler has PROVEN to be an array is refused, because an array's keys are its indexes: for membership write `.has(x)`, for a bound on the count `.size() > n`.
- A scalar literal on the right → a compile-time error (JSMQL has no useful reading for this).

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

`&&` and `||` follow JavaScript. They return the operand, not a coerced boolean. When every operand in a chain is already a boolean comparison, the compiler emits the plain `$and` / `$or` form. A mixed chain compiles to `$cond`, so the operand value flows through. See [Truthy and falsy](#truthy-and-falsy) for the rule.

### Conditional

```js
$.age >= 18 ? "adult" : "minor"     // { $cond: { if: { $gte: ["$age", 18] }, then: "adult", else: "minor" } }
$.nickname ?? $.name                // { $ifNull: ["$nickname", "$name"] }
```

### Truthy and falsy

`&&`, `||`, `!`, `?:`, `Boolean(x)`, and **every** predicate position use **JavaScript** truthy/falsy semantics, not MongoDB's. A predicate position is: an array-value method (the JavaScript predicate methods, the lodash predicate-run family, `.compact()`), a `$match` body, a stream `$$.filter(p)` / `$$.reject(p)`, a `$$$.<coll>` lookup predicate, or a bare-expression Filter. This rule holds for every way you write the predicate: an arrow, a `_.matches` object, a field-name string, a `["field", value]` pair, or a bare `Boolean`. The values below are falsy:

| Value | Falsy? |
|---|---|
| `false` | yes |
| `null` | yes |
| missing field | yes |
| `0` | yes |
| `""` (empty string) | yes |
| `NaN` | **no** — see limitation below |
| everything else (`[]`, `{}`, `"0"`, `-1`, dates, …) | truthy |

MongoDB's raw `$toBool` and bare `$cond` use a different rule; for example, `""` is truthy in MQL. To get raw MongoDB semantics — for example, to match an existing aggregation — call the operator directly: `$toBool($.x)`, `$op($and, …)`. Those escapes keep their own meaning.

One rule for every spelling and every position keeps matching pairs equal. `.compact()` is `.filter(Boolean)`. `.reject(p)` is the exact complement of `.filter(p)`. `.partition(p)` is `[filter(p), reject(p)]`, so no element can fall out of both halves. A stream `$$.filter(p)` keeps exactly the documents that the value-mode `.filter(p)` keeps.

```js
$.active                            // Filter: { $expr: <JS-truthy check on "$active"> }
$match($.active)                    // the same check, as a stage
$$.filter(o => o.active)            // and again, on a stream
```

**The check shrinks to what the value can be.** Each of the four tests belongs to one kind of value, so a value the compiler has a type for — a field the pipeline wrote, a `let`, a literal, a method result — keeps only the tests that value can fail. A field written as a string keeps the `""` test, and the null test while it may be missing. A field written as an array, an object or a date keeps only the null test, and none at all when it is certainly there, so `$.arr ? a : b` becomes `a`. A boolean or a number is its own truth, because MongoDB already reads `0`, `false`, null and missing as false: `$.n ? 1 : 2` is `{ $cond: { if: "$n", then: 1, else: 2 } }`. In a Filter or a `$match`, a bare field with a known type takes the query form — `{ active: true }` for a boolean, `{ n: { $nin: [null, 0] } }` for a number that may be missing — unless the field may hold an array, which the query language reads element by element. See [docs/specs/types.md](specs/types.md).

```js
$.s = $.a.trim(); $.t = $.s ? 1 : 2;
// → [{ $set: { s: { $trim: { input: "$a" } } } }, { $set: { t: { $cond: { if: { $and: [{ $ne: [{ $ifNull: ["$s", null] }, null] }, { $ne: ["$s", ""] }] }, then: 1, else: 2 } } } }]
$.b = $.n > 1; $match($.b);
// → [{ $set: { b: { $gt: ["$n", 1] } } }, { $match: { b: true } }]
```

Only the index-friendly half of a `$match` is an exception, because it needs no coercion. A comparison is already a boolean, so `$.age > 18` still emits the plain query form `{ age: { $gt: 18 } }`. To get MongoDB's own truthiness in a `$match`, write the object-literal escape hatch: `$match({ $expr: $.active })` passes through as written.

**Known limitation: JSMQL treats `NaN` as truthy.** It is the one JS-falsy value the rule above does not catch, so `$.xs.compact()` keeps a `NaN` value that `_.compact` would drop. Detecting `NaN` needs a per-value `$convert`. MongoDB's `$eq` treats `NaN == NaN` as true, so the cheap `$ne:[x,x]` self-comparison does not work. The `$convert` check costs about +40% on a `$match` and +20% on a `$filter`, and every predicate in the language would pay it. `NaN` values are rare in MongoDB data, so this document states the gap instead of paying that cost. When you need the check, compare explicitly: `$ne($.x, $toDouble("NaN"))` → `{ "$ne": ["$x", { "$toDouble": "NaN" }] }`. This is true for every value except a `NaN` of either the `double` or `decimal` type.

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

**No shift operators.** MongoDB has no `<<`, `>>`, or `>>>`. JSMQL does not accept those tokens.

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
$.name.substr(-3)                  // the last three characters — a negative start counts from the end
$.csv.split(",")                   // { $split: ["$csv", ","] }
$.csv.split("")                    // REFUSED: MongoDB's `$split` needs a non-empty separator, and it
                                   // has no split-into-characters form. For one character per element
                                   // write `$range(0, $.csv.length()).map(i => $.csv.charAt(i))`.
$.email.toLowerCase().indexOf("@") // { $indexOfCP: [{ $toLower: "$email" }, "@"] }
$.text.replace("old", "new")       // { $replaceOne: { input: "$text", find: "old", replacement: "new" } }
$.text.replaceAll(" ", "_")        // { $replaceAll: { input: "$text", find: " ", replacement: "_" } }
$.email.toLowerCase().includes("@")// { $gte: [{ $indexOfCP: [{ $toLower: "$email" }, "@"] }, 0] }
$.email.startsWith("admin@")       // { $eq: [{ $indexOfCP: ["$email", "admin@"] }, 0] }
$.file.endsWith(".pdf")            // substring-equality at the tail (see below)
$.name.charAt(0)                   // { $substrCP: ["$name", 0, 1] }
$.first.trim() + " " + $.last      // { $concat: [{ $trim: ... }, " ", "$last"] }   — `+` joins strings; `.concat()` is an array method
$.email.match(/^[a-z]/)            // { $regexMatch: { input: "$email", regex: "^[a-z]" } }
$.text.matchAll(/word/g)           // { $regexFindAll: { input: "$text", regex: "word" } }  — see flag note
$.text.search(/foo/)               // first match index, or -1 (via $regexFind + $ifNull)
$.code.padStart(5, "0")            // padded via $reduce + $range + $concat (no length guard — an already-long string concats an empty filler)
$.tier.padStart(9, "US")           // "gold" → "USUSUgold" — a multi-char pad is cut to fit, as in JS
$.note.padEnd(10)                  // (default pad char is space)
"-".repeat($.n)                    // $reduce concatenating "-" n times

// Regex receiver methods — equivalent to .match / .search-style calls
/^[a-z]/.test($.s)                 // { $regexMatch: { input: "$s", regex: "^[a-z]" } }
/word/i.exec($.s)                  // { $regexFind: { input: "$s", regex: "word", options: "i" } }
/word/gi.test($.s)                 // { $regexMatch: { input: "$s", regex: "word", options: "i" } }  — g dropped
```

**`.endsWith()` and out-of-range indices.** MongoDB's `$substrCP` is stricter than JavaScript's
string slicing. A negative start or length makes the server **abort the whole query**, instead of
returning a value. This happens exactly where JS is most forgiving: `"a@b.com".endsWith("@example.com")`
is simply `false` in JS, but the tail index `strLen - needleLen` is negative there. So JSMQL floors every
index it derives, and `.endsWith()` binds its receiver once:

```js
$.file.endsWith(".pdf")
// { $let: { vars: { jsmqlStr: { $ifNull: ["$file", ""] } },
//           in: { $eq: [{ $substrCP: ["$$jsmqlStr",
//                                     { $max: [0, { $subtract: [{ $strLenCP: "$$jsmqlStr" }, 4] }] },
//                                     4] },
//                       ".pdf"] } } }
```

Each method keeps its own JavaScript meaning for a negative index. `.substr()` counts
from the end. `.substring()` clamps to 0. `.charAt()` returns `""`; JSMQL never floors it, because
that would return the *first* character instead. A start or length past the end of the string is safe.
It yields `""`, as in JS.

**A missing field never aborts a query.** MongoDB's `$strLenCP` aborts the query when its input is
missing or null, and every derived length needs `$strLenCP`. So JSMQL coerces the receiver of every
length it derives — `.endsWith()` binds `{ $ifNull: ["$file", ""] }` above — and a string method on a
receiver it cannot prove is there is tested first and answers `null`, the JavaScript-method rule of
[Type-aware dispatch](#type-aware-dispatch): on an absent field, `.length()`, `.padStart(5, "0")` and
`.endsWith(…)` are all `null`. A *type* mismatch is still an error: an array or a number where a string
is expected fails as the server reports it.

Note: the emitted length of a **literal** folds at compile time. It counts **code points**, the way
`$strLenCP` does, not JS's UTF-16 units. So `"a👍b"` is 3, not 4.

**Regex flags.** MongoDB's `$regex*` operators accept only the options `i`, `m`, `s`, `x`. JavaScript-only flags — `g` (global), `u`/`v` (unicode), `y` (sticky), `d` (indices) — have no MongoDB equivalent. So JSMQL drops them from the emitted `options` and keeps only `i`/`m`/`s`. Dropping `g` causes no problem: `$regexFindAll` is always global, and `g` has no effect on `$regexMatch`/`$regexFind`. `.matchAll()` still *requires* a `/g` regex, matching JS, which throws without one. But `g` itself does not appear in the output.

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

**ASCII-only, by design.** `$toUpper`/`$toLower` work only on ASCII; an accented letter passes through unchanged. Word-splitting uses the ASCII pattern `[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[A-Z]|[0-9]+`. This pattern splits camelCase boundaries and non-alphanumeric characters; an accented character acts as a separator. `truncate`'s word-boundary `separator` option has no MQL equivalent, because MQL cannot search backward. JSMQL omits `deburr`, because it is a no-op without Unicode support. A live mongod verified every shape here.

```js
// Property access — DOT access is interpreted, BRACKET access is raw
$.name.trim().length()              // { $strLenCP: ... } under a null test — the character count
$.csv.split(",").size()             // { $size: ... }           — the element count
$.field.length                      // "$field.length"          — a FIELD named `length`; JSMQL computes no property
$.field["length"]                   // { $getField: { field: "length", input: "$field" } } — the same field, bracket access

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
$.items.at(0)              // { $arrayElemAt: ["$items", 0] }        — the element at 0
$.items.at(-1)             // { $arrayElemAt: ["$items", -1] }       — the last element; the only way to index from the end
[1, 2, 3].slice(0, 2)      // { $slice: [[1, 2, 3], 2] }          (indices, end-exclusive — like JS)
[1, 2, 3, 4].slice(1, 3)   // { $slice: [[1, 2, 3, 4], 1, 2] }    (index 1 up to 3 → 2 elements)
$.items.slice(1, 3)        // { $slice: ["$items", 1, 2] } under a null test — a string takes `.substring(1, 3)`
$.items.toReversed()       // { $reverseArray: "$items" }            (ES2023, immutable)
$.scores.toSorted()        // { $sortArray: { input: "$scores", sortBy: 1 } } (ascending)
$.scores.toSorted(s => s.value)
                           // { $sortArray: { input: "$scores", sortBy: { value: 1 } } }
$.scores.toSorted(s => -s.value)
                           // { $sortArray: { input: "$scores", sortBy: { value: -1 } } } (descending)
$.scores.toSorted((a, b) => a.value - b.value)
                           // { $sortArray: { input: "$scores", sortBy: { value: 1 } } }  — a comparator
$.scores.toSorted((a, b) => a - b)
                           // { $sortArray: { input: "$scores", sortBy: 1 } }   — the ELEMENTS are the key
$.scores.toSorted((a, b) => b - a)
                           // { $sortArray: { input: "$scores", sortBy: -1 } }  (descending)
$.items.with(0, 99)        // immutable index-set — replace element at index, returns new array (ES2023)
$.items.toSpliced(1, 2)    // immutable splice — remove 2 items starting at 1 (ES2023)
$.items.toSpliced(1, 0, "x", "y")
                           // immutable insert — insert items without removing
$.items.toSpliced(2)       // no count removes everything from index 2 on, as JavaScript does
$.items.toSpliced(-1, 1)   // a negative start counts from the END, and both ends clamp
[1, 2].concat([3, 4])      // [1, 2, 3, 4]                          (every operand a literal — folded)
$.csv.split(",").concat(2, 3)
                           // { $concatArrays: [{ $split: … }, [2], [3]] }  — a proven array
                           //   receiver, and a scalar argument becomes the one-element array
                           //   it stands for, which is what JavaScript's `.concat` does and
                           //   the only operand `$concatArrays` accepts
                           //   — `.concat()` is an array method: a string joins with `+`
[1, 2, 3].has($.x)         // { $in: ["$x", [1, 2, 3]] }            — membership; a string tests a substring with `.includes()`
[1, 2, 3].indexOf($.x)     // { $indexOfArray: [[1, 2, 3], "$x"] }  (array-typed)
$.items.lastIndexOf($.x)   // last index of $.x, or -1 (array-only — strings rejected)
$.items.size()             // { $size: { $ifNull: ["$items", []] } } — the element count; a string has `.length()`
$.tags.join(", ")          // builds a separated string via $reduce/$concat, reading each
                           //   element as JavaScript does: a null or missing element is
                           //   written as "" rather than dropped (`[1, null, 2].join(",")`
                           //   is "1,,2"), an empty array is "", and a leading "" element
                           //   keeps its separator (`["", "a"].join(",")` is ",a")
$.items.toString()         // same as .join(",") for arrays; no-op for strings; $toString otherwise
// an array that provably holds arrays — [[1, 2], [3]], .partition(…) — is refused by both:
// the server cannot stringify an array element; flatten first, or map each inner array to a string
$.nested.flat()            // flatten one level via $reduce + $concatArrays
$.docs.flatMap(d => d.tags)// $reduce over $map of the lambda
```

#### Type-aware dispatch

**Each method reads one kind of value, and its name says which.** `.length()` counts the characters of a string, `.size()` the elements of an array. `.includes(x)` tests a substring of a string, `.has(x)` membership in an array. `.slice()`, `.at()`, `.nth()` and `.concat()` read an array; a string has `.substring()`, `.substr()`, `.charAt()` and `+`. On a bare field JSMQL emits the method's own operator, and the server judges the value. On a field the compiler has proven, a method of the other kind is a compile-time error, and the message names the method to write:

```js
$.arr = $.tags.uniq(); $.n = $.arr.length();
// ✗ '.length()' is not available on an 'array' — it is defined on 'string'. For the number of elements, write '.size()'.
$.s = $.name.trim(); $.b = $.s.has("re");
// ✗ '.has()' is not available on a 'string' — it is defined on 'array'. For a substring test, write '.includes(x)'.
```

`.indexOf()` and `.lastIndexOf()` are the one pair that reads a string and an array, because JavaScript gives a string no other spelling for "the position of". The receiver's proof picks the operator; then the argument's proof does — `$indexOfCP` takes a string, so an argument proven not to be one picks the array form; a receiver and an argument that prove nothing take a runtime `$switch` on the value's own `$type`:

```js
$.a.indexOf(1)
// → { $indexOfArray: [{ $ifNull: ["$a", []] }, 1] }
$.a.indexOf("x")
// → { $switch: { branches: [ { case: { $in: [{ $type: "$a" }, ["array"]] }, then: { $indexOfArray: ["$a", "x"] } }, { case: { $in: [{ $type: "$a" }, ["string"]] }, then: { $indexOfCP: ["$a", "x"] } } ], default: -1 } }
```

**A field the pipeline wrote carries the type of its value.** After `$.arr = $.tags.uniq();` the compiler knows `arr` is an array, or null when `tags` is missing, so `$.arr.has("red")` takes the array form with only the null guard. After `$.bool = $.arr.has("red");` it knows `bool` is a boolean, so `$.bool ? "R" : "OTHER"` reads it as its own truth. The proof follows a method's result too: `$.tags.map(t => t.trim())` is an array of strings, `{ ...$.address, done: true }` and `$.address.assign({ done: true })` are objects whose `done` is a boolean, `$.o.pick(["a"])` holds `a` and nothing else, and `.filter(p).head()` is one element that may be missing. It follows every write — a whole field, a dotted path such as `$.address.full = …`, a `let` and each value it is assigned again — and every stage: after `$group({ _id: $.k, total: $sum($.amount) })` the compiler knows `total` is a number, after `$ = $.p` it knows the shape it recorded for `p`, after `.flatMap("items")` it knows `items` is one element, and after `$ = $.pick([...])` it knows exactly which fields remain. A join carries the shape its body made: after `const ids = $$$.orders.filter(p).map("pid").uniq()` the compiler knows `ids` is an array that is there, so `ids.has(x)` takes the array form with no guard, and after `$.p = $$$.products.filter(p).pick(["_id", "name"])` it knows each element holds exactly those two fields. A `$match` narrows too: after `$match($.tags != null)` the field is present and needs no null guard, after `$match(typeof $.b === "string")` or `$$.filter({ status: "a" })` the field has that kind, and after `$match($.n > 5)` it is a number, because the query language compares inside one type. A query clause reads an array field element by element, so each of these also allows an array; an `||` proves nothing. A method on a field proven to hold a kind it has no form for is a compile-time error that names what the method takes, so `$.bool.trim()` fails before it runs. A value that can be one of several kinds (`c ? "abc" : [1, 2]`) dispatches over those kinds alone, and drops the `default` when every kind has a branch and the value is there. See [docs/specs/types.md](specs/types.md).

```js
$.arr = $.tags.uniq();
$.bool = $.arr.has("red");
$.result = $.bool ? "R" : "OTHER";
// → [ { $set: { arr: { $setUnion: { $ifNull: ["$tags", []] } } } }, { $set: { bool: { $in: ["red", "$arr"] } } }, { $set: { result: { $cond: { if: "$bool", then: "R", else: "OTHER" } } } } ]
```

**A method on a receiver that is null or missing answers what its family's empty collection answers.** This is [HR5](LANG_RULES.md). Under a dot, an array method runs on `[]` and an object method on `{}`: the compiler wraps the receiver in `$ifNull`, and the operator gives the answer — `[]` for `.uniq()`, `0` for `.sum()` and `.size()`, `false` for `.has(x)`, `true` for `.every(p)`, missing for `.first()` and `.at(0)`, `{}` for `.pick([...])`. A string method answers `null`: JavaScript throws there (`undefined.trim()` is a TypeError), MongoDB has no error to raise inside an expression, and `null` is the nearest value it holds; `$strLenCP` and `$toUpper` would abort or answer `""`, so the receiver is tested first. A receiver that is certainly there takes no wrap and no test: a literal, `$range(...)`, the keys of the root document, a `$lookup` result, a field a `$match` or a `?.` proved, and the result of an array or object method under a dot, which the wrap made present — so a chain pays once, at its head. Under `?.` the chain stops and answers `null` (see Optional Chaining):

```js
$.s.trim().length()               // a STRING method: `s` may be missing → tested first, and answers null
// → { $let: { vars: { jsmqlRecv: { $trim: { input: "$s" } } }, in: { $cond: { if: { $eq: [{ $ifNull: ["$$jsmqlRecv", null] }, null] }, then: null, else: { $strLenCP: "$$jsmqlRecv" } } } } }

$.a.map(x => x + 1).size()        // an ARRAY method: a missing `a` is [], so the count is 0, and `.size()` adds no guard of its own
// → { $size: { $map: { input: { $ifNull: ["$a", []] }, as: "x", in: { $add: ["$$x", 1] } } } }

$.a.uniq().sortBy("k")            // one wrap at the head of the chain: `.uniq()` under a dot never answers null
// → { $sortArray: { input: { $setUnion: { $ifNull: ["$a", []] } }, sortBy: { k: 1 } } }

Object.keys($).size()             // the root document is always there
// → { $size: { $map: { input: { $objectToArray: "$$ROOT" }, as: "jsmqlKv", in: "$$jsmqlKv.k" } } }

$.a?.map(x => x + 1).size()       // `?.` with a call after it stops the chain — see Optional Chaining
// → { $cond: { if: { $eq: [{ $ifNull: ["$a", null] }, null] }, then: null, else: { $size: { $map: { input: "$a", as: "x", in: { $add: ["$$x", 1] } } } } } }

$.n = $$$.orders.filter({ userId: $._id }).map(o => o.total).size();   // a $lookup always writes its array
// → …, { $set: { n: { $size: { $map: { input: "$__jsmql.tmp.0", as: "o", in: "$$o.total" } } } } }, …
```

**A list ARGUMENT takes the same empty-list reading.** A method that compares the receiver
against a second list reaches `$in` or `$setIsSubset` with that list, and both abort on
null. So the cell guards the list the way HR5 guards the receiver, and a missing list
means "the empty list" — the reading lodash gives a missing list. JSMQL hands a list
spelled in the source straight through, because it is already an array:

```js
$.a.difference($.b)               // `a` and `b` may be missing → both read as []
// → { $filter: { input: { $ifNull: ["$a", []] }, as: "jsmqlItem", cond: { $not: [{ $in: ["$$jsmqlItem", { $ifNull: ["$b", []] }] }] } } }

$.a.difference([1, 2])            // spelled in the source — an array, always
// → { $filter: { input: { $ifNull: ["$a", []] }, as: "jsmqlItem", cond: { $not: [{ $in: ["$$jsmqlItem", [1, 2]] }] } } }

$.a.isSubsetOf($.b)               // a missing set, on either side, is the empty set
// → { $setIsSubset: [{ $ifNull: ["$a", []] }, { $ifNull: ["$b", []] }] }
```

So the three set PREDICATES — `.isSubsetOf()`, `.isSupersetOf()`, `.isDisjointFrom()` —
read a missing operand as the **empty set** and answer a real boolean: `true`, `true` and
`true` over a document that holds neither field. Their array-returning siblings —
`.union()`, `.intersection()`, `.symmetricDifference()`, `.xor()` — answer the other list,
or `[]`.

If you know the type of an `.indexOf()` receiver at design time and want compact output, you have three options. Bind the value to a `const` with a type-revealing initialiser. Or chain a type-fixing method first — `$.tags.toLowerCase().indexOf(...)` pins a string. Or use the explicit `$indexOfArray` / `$indexOfCP` operator forms.

**A query document takes the indexable reading.** An index is read through a query document, so in a filter or a `$match` a boolean method emits the query clause its row states. `$.tags.has("vip")` becomes `{ tags: "vip" }`: "equals, or is an array that contains", which is what `.has` asks of an array. `$.name.includes("vip")` becomes `{ name: { $regex: /vip/ } }`, the substring test. `jsmql.expr` gives the expression forms, `$in` and `$indexOfCP`.

**A `const` carries its type.** A `const` whose initialiser is statically an array or a string counts as "statically known" everywhere the binding is read. This includes inside a `$lookup` predicate, where JSMQL threads the binding in as a correlation variable:

```js
const ids = $.tags.uniq();          // provably an array
const hits = $$$.orders.filter(o => ids.has(o.pid));
// → [
//     { $set: { "__jsmql.var.ids": { $reduce: { … } } } },
//     { $lookup: { from: "orders",
//                  let: { jsmql_v0_ids: "$__jsmql.var.ids" },
//                  pipeline: [{ $match: { $expr: { $in: ["$pid", "$$jsmql_v0_ids"] } } }],
//                  as: "__jsmql.var.hits" } },
//     { $unset: "__jsmql" }
//   ]
```

Knowing the type also turns a genuine mistake into a compile-time error instead of a server error. `const s = $.name.trim(); s.map(f)` reports that `.map()` needs an array receiver.

A `let` does **not** carry its type. A `let` can be reassigned, so its type could change between the declaration and the read, and JSMQL keeps the runtime `$cond`. Use `const` when the value never changes — which is also what you would write in JavaScript.

**`.at(i)` is the from-the-end reader of an array.** It is the only spelling that accepts a
negative index; brackets reject one. It lowers to `$arrayElemAt`, which takes a negative
index natively. An index past either end answers *missing*, not `null`, so `.at()` on an
absent element stays absent, and `$.aliases.at(0) ?? "anonymous"` reaches its fallback. A
string reads one character with `.charAt(i)`, and its last characters with `.substr(-n)`:

```js
$.tags.uniq().at(-1)                // → { $arrayElemAt: [{ $setUnion: { $ifNull: ["$tags", []] } }, -1] }
$.name.substr(-1)                   // the last character of a string
```

**`.flat()` depth.** JSMQL supports only `flat()` and `flat(1)`. MongoDB has no recursive flatten primitive, so JSMQL rejects a deeper depth at compile time.

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
// → { $arrayElemAt: [{ $filter: { input: "$items", as: "x", cond: <x.active is truthy> } }, -1] }

// findLastIndex — index of last matching element, or -1 (ES2023)
$.items.findLastIndex(x => x.active)
// → $reduce over [(idx, el), ...] pairs, keeping the last index where the predicate matches

// some — true if any element matches
$.scores.some(x => x >= 90)
// → { $anyElementTrue: { $map: { input: { $ifNull: ["$scores", []] }, as: "x", in: { $gte: ["$$x", 90] } } } }

// every — true if all elements match
$.scores.every(x => x >= 60)
// → { $allElementsTrue: { $map: { input: { $ifNull: ["$scores", []] }, as: "x", in: { $gte: ["$$x", 60] } } } }

// reduce — fold to a single value (2- or 3-param lambda required)
$.numbers.reduce((acc, x) => acc + x, 0)
// → { $reduce: { input: "$numbers", initialValue: 0, in: { $add: ["$$value", "$$this"] } } }

// reduceRight — fold right-to-left
$.numbers.reduceRight((acc, x) => acc + x, 0)
// → same as .reduce but input is wrapped in { $reverseArray: ... }
```

**Note:** In `reduce` and `reduceRight`, JSMQL maps the accumulator name to MongoDB's `$$value`. With a 2-parameter callback, the element rides through `$$this`. With a 3-parameter callback `(acc, x, i)`, JSMQL zips the input with `$range` and binds both `x` and `i` through a `$let` wrapper.

### Callback parameters `(element, index, array)`

JavaScript array-method callbacks receive `(element, index, array)`, and JSMQL accepts all three. The third parameter binds the method's own input through a `$let`, so `arr.size()` inside the callback gives the receiver's size. Naming the index changes what is iterated, because JSMQL then zips the input with `$range`; it emits this machinery only where a parameter is actually read. `.reduce` and `.reduceRight` take a leading `acc` parameter and allow at most three parameters. See [Optional Chaining](#optional-chaining) for the fuller treatment.

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

JavaScript's array mutators (`.sort()`, `.reverse()`, `.push()`, `.pop()`, `.shift()`, `.unshift()`, `.splice()`, `.fill()`) modify the receiver in place. In JSMQL they work the same way **when you call them at statement position on a `$.<field>` receiver**: the call lowers to a `$set` stage that re-assigns the field. JSMQL keeps JS semantics: `.toSorted()` returns a new array and leaves the field unchanged, but `.sort()` mutates the field.

```js
// At statement position — each line desugars to a $set stage.
$.events.sort(e => e.timestamp);
// → { $set: { events: { $sortArray: { input: "$events", sortBy: { timestamp: 1 } } } } }

$.events.push($.newEvent);
// → { $set: { events: { $concatArrays: [{ $ifNull: ["$events", []] }, ["$newEvent"]] } } }

$.events.pop();
// → { $set: { events: { $let: { vars: { jsmqlArr: { $ifNull: ["$events", []] } }, in: { $slice: [ "$$jsmqlArr", { $max: [{ $subtract: [{ $size: "$$jsmqlArr" }, 1] }, 0] } ] } } } } }

$.events.reverse();
// → { $set: { events: { $reverseArray: { $ifNull: ["$events", []] } } } }
```

Chained mutators on the same field interact with the `$set` coalescer exactly the same way an explicit `$.events = …` assignment does: a read-after-write splits into separate stages:

```js
jsmql`
  $.events.push($.newEvent);
  $.events.sort(e => e.timestamp);
  $.events = $.events.slice(-10);
`
// → three $set stages, in order
```

**In expression position, mutators throw.** Calling `.sort()`, or any other mutator, inside an expression — chained, in a `$match` body, or as a `$project` value — raises a tailored error. It names both the immutable variant and the statement-position option:

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

`.forEach()`, `.entries()`, `.keys()`, `.values()`, and `.toLocaleString()` also throw tailored errors. Each explains why it has no MQL form — the iterator protocol, a void return, or locale dependence — and what to use instead.

**A mutator at the end of a chain is expression position too.** This surprises a JavaScript developer: `[...].filter(p).sort()` reads fine in JS, because `.filter` makes a throw-away array, and sorting it in place is invisible. JSMQL has no throw-away array to mutate, so it asks for the immutable spelling instead:

```js
jsmql.expr("$.items.filter(i => i.qty > 0).map(i => i.sku).uniq().sort()");
// ✗ .sort() mutates the array in JavaScript. In expression position, use '.toSorted()' — or
//   call it at statement position (top-level on a '$.<field>' receiver) to mutate the field.

jsmql.expr("$.items.filter(i => i.qty > 0).map(i => i.sku).uniq().toSorted()");
// → { $sortArray: { input: { $setUnion: { $map: {
//       input: { $filter: { input: "$items", as: "i", cond: { $gt: ["$$i.qty", 0] } } },
//       as: "i", in: "$$i.sku" } } }, sortBy: 1 } }
```

#### `Object.assign(target, ...sources)` mutates `target`

`Object.assign` is JavaScript's *mutating* merge: it writes the merged object back into its first argument. At statement position, JSMQL honours this. The target may be a document field **or** an in-scope `let`/`const` binding:

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

`Object.assign(result, …)` works even when `result` is `const`, because mutating a `const`-bound object is legal JavaScript; only *rebinding* it with `result = …` is not. It is the mutating twin of the value form `result = { ...result, ... }`. In **expression** position, `Object.assign(a, b)` keeps its own meaning: it lowers to `$mergeObjects` (see [Object Operations](#object-operations)). The first argument must be a writable target — a `$.field` or an in-scope binding. Anything else, such as `Object.assign({}, …)` or an undeclared name, throws an actionable error.

#### Array sort: `.toSorted(<sort>)` and `.sort(<sort>)`

Both accept a field name, an array of field names, a `{ field: 1 | -1 | "asc" | "desc" }` spec, or a key-function lambda. `.toSorted()` returns a new array. `.sort()` mutates at statement position. The same shapes work everywhere:

```js
$.events.toSorted("distance")             // { $sortArray: { input: "$events", sortBy: { distance: 1 } } }
$.events.toSorted({ distance: -1 })       // descending
$.events.toSorted({ a: "asc", b: "desc" })// multi-key
$.events.toSorted(["a", "b"])             // both ascending
$.events.toSorted(e => e.distance)        // key-function form (nested paths welcome)
$.events.toSorted(e => -e.user.name)      // descending, via unary -
$.events.sort({ distance: -1 });          // statement position → $set with $sortArray
```

A **comparator** is a supported spelling. `(a, b) => a.x - b.x` sorts ascending on `x`; `(a, b) => b.x - a.x` sorts descending. `||` joins keys, and each becomes one `sortBy` key.

```js
$.items.toSorted((a, b) => a.x - b.x || b.y - a.y)
// → { $sortArray: { input: "$items", sortBy: { x: 1, y: -1 } } }
```

A **key function** may name a deep path: `x => x.a.b.c` → `sortBy: { "a.b.c": 1 }`. JSMQL refuses a comparator body that does not subtract one field from each side. The error message names the two forms and the `{ field: dir }` spec.

#### lodash iteratee / predicate shorthands

Every higher-order value method accepts the same lodash iteratee/predicate vocabulary. This includes the native JS methods (`.map` / `.filter` / `.find` / `.findIndex` / `.findLast` / `.some` / `.every` / `.flatMap`) and the lodash methods (`.sumBy` / `.uniqBy` / `.groupBy` / `.reject` / `.takeWhile` / `.differenceBy` / …). Each shorthand desugars to exactly what the equivalent one-parameter arrow would emit:

| shorthand | example | equivalent arrow |
|---|---|---|
| property string (dotted paths ok) | `.map("addr.city")` | `x => x.addr.city` |
| `_.matches` object | `.filter({ role: "admin", active: true })` | `x => x.role === "admin" && x.active === true` |
| `_.matches` object, nested | `.filter({ a: { b: { c: 3 } } })` | `x => x.a.b.c === 3` — a partial match, like lodash's: `x.a.b.d` may be anything |
| `_.matches` object, array value | `.filter({ tags: ["a", "b"] })` | `x => x.tags.has("a") && x.tags.has("b")` — a subset, like lodash's |
| `_.matchesProperty` pair | `.find(["status.code", 200])` | `x => x.status.code === 200` |
| single-parameter arrow | `.map(x => x.total * 1.1)` | — |
| omitted (identity) | `.uniq()` | `x => x` |

An iteratee context reads the result as a value: `.map("name")` plucks the field. A predicate context reads it as a boolean: `.filter("active")` keeps the truthy ones. The `_.matches` object is lodash's **partial deep match**. Every key is a path. A nested object narrows the path further — `{ a: { b: { c: 3 } } }` says nothing about `a.b.d`. An array of constants is a subset test. An empty object or array matches anything. A key is a field name, whatever it looks like: `{ qty: { $gt: 5 } }` matches a document whose `qty.$gt` field equals `5`, exactly as `_.filter(docs, { qty: { $gt: 5 } })` does. To compare with an operator, write the predicate instead: `x => x.qty > 5`. A value that is not a plain object or an array of constants compares with `===`.

#### lodash array methods

These are value-mode methods on an array field. Their iteratee/predicate arguments take any of the shorthands above.

```js
$.nums.sum()  / .mean() / .max() / .min()   // $sum / $avg / $max / $min of the array
$.items.sumBy("price")  / .meanBy(x => x.p) // $sum / $avg of the mapped values
$.items.minBy("score")  / .maxBy("score")   // the element with the min/max key
$.items.sortBy("age") / .sortBy(x => x.age) // ascending sort by a key (alias of .toSorted)
$.items.orderBy(["age", "name"], ["desc", "asc"])  // multi-key sort (parallel keys + directions)
$.items.orderBy({ age: -1, name: 1 })              // …or a { field: dir } object (directions inline)
$.tags.uniq()                               // dedupe → $setUnion (MongoDB does not define the order)
$.items.uniqBy("id")                        // dedupe by key, keep first
$.items.keyBy("id")                         // { <id>: <last item with that id> }
$.items.groupBy("type")                     // { <type>: [items…] }
$.items.countBy("type")                     // { <type>: <count> }
$.nums.countBy()                            // omit the iteratee → count by the element itself: [1,2,2] → { "1": 1, "2": 2 } (also .groupBy() / .keyBy())
$.items.partition(x => x.ok)                // [ [matches…], [non-matches…] ]
$.items.reject({ active: false })           // items NOT matching
$.xs.chunk(3)                               // [[…3], […3], [rest]]   (size: positive int literal)
$.xs.flatten()                              // one level (with an $isArray guard)
$.xs.compact()                              // drop JS-falsy (false/null/0/""/missing) — same as .filter(Boolean)
$.a.union($.b) / .intersection($.b) / .xor($.b)          // $setUnion / $setIntersection / composed — unique values, order undefined
$.a.difference($.b)                                      // keeps the receiver's duplicates, as lodash does — a $filter, not $setDifference
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

> A predicate-run method takes an arrow (`x => …`) or a `_.matches` object (`{ active: true }`). It stops at the first element the predicate rejects, using JS truthiness, as `.filter` does — see [Truthy and falsy](#truthy-and-falsy). The `*RightWhile` pair scans the reversed array and reverses the result back. `sample`/`sampleSize` use `$rand`, so each run gives a **different result** — non-deterministic, like the stream `.sample()` → `$sample`. `sampleSize` draws **without replacement** and returns the whole shuffled array when `n` exceeds the length.

> **Pitfalls.** `keyBy`/`groupBy`/`countBy` **stringify** the key, using `$toString`, to match lodash. A missing or null key coerces to the string `"null"`, but an object or array key still *errors*. **A stringified key stays a string.** So `Object.keys(<a countBy result>)` hands back hex strings, and on the server a string never equals an `ObjectId`. A join on such a key then silently matches nothing. Cast the key back first: `Object.keys(counts).map(id => ObjectId(id))` (see [ObjectId](#objectid-literals); it lowers to `$toObjectId`). Group order is unspecified, and `groupBy`/`countBy` run in O(n²) time. `.sum`/`.mean`/… ignore non-numeric elements, following MQL's `$sum`/`$avg` semantics. `.uniq`/`.union`/`.intersection`/`.xor` lower to MongoDB's set operators: **unique values, in no defined order** — `$setUnion` sorted one sample and `$setDifference` did not, so do not rely on either. lodash preserves input order and JSMQL does not, because nobody writes an ordering when they write `.uniq()`. `.difference` is the exception and stays a `$filter`, because lodash keeps the receiver's duplicates there, and dropping them would change the values, not just their order. A live mongod verified every shape here.

> **JSMQL rejects chaining that cannot type-check.** When a method is chained on a receiver whose type is provably wrong for it, JSMQL throws at compile time, instead of emitting MQL the server would reject. Examples: `.every(p).map(f)` — a boolean has no methods; `s.toUpperCase().map(f)` — a string is not an array; `a.countBy("t").take(3)` — an object is not an array; and, over a lookup, `$$$.orders.find(p).take(5)` — `.find` returns one document. This check fires only when the receiver type is **fully certain**. An element of unknown type still compiles, for example `arr.find(p).map(f)`, because the element could itself be an array. A result whose type depends on its arguments, such as `n.clamp(a, b)`, still compiles too.

#### lodash positional / slicing methods

Element and sub-array accessors on an array field:

```js
$.xs.take(3)      / .drop(3)                 // first 3 / all but the first 3   (n defaults to 1)
$.xs.takeRight(3) / .dropRight(3)            // last 3  / all but the last 3
$.xs.head()  / .first()                      // first element  ($first)
$.xs.last()                                  // last element   ($last)
$.xs.tail()  / .initial()                    // all but the first / all but the last element
$.xs.nth(2)  / .nth(-1)                       // lodash spelling of `.at(i)` (n defaults to 0)
$.xs.size()                                  // the element count — a string has `.length()`, an object `.keys().size()`
```

> `take`/`drop`/`takeRight`/`dropRight` reject a **negative** count; the error message points at the opposite-end method. An `n` past the array length is fine: you get the whole array or an empty one, matching lodash. `head`/`first`/`last` on an empty array yield `null`, MongoDB's missing-value marker.

### Bare built-in callbacks

You can pass a built-in that converts one value bare as the callback, just like in plain JavaScript: `Boolean`, `Number`, `String`, `ObjectId`, and the single-argument `Math` methods:

```js
$.items.filter(Boolean)         // drop JS-falsy values (null, "", 0, false, missing)
// → $filter whose `cond` checks each element for JS truthiness
// (see "Truthy and falsy" above)

$.scores.map(Number)            // coerce strings to numbers
// → { $map: { input: { $ifNull: ["$scores", []] }, as: "x", in: { $toDouble: "$$x" } } }

Object.keys($.counts).map(ObjectId)   // object keys are strings — cast them back
// → { $map: { input: { … }, as: "v", in: { $toObjectId: "$$v" } } }

$.scores.map(Math.floor)        // round each element down

[$.first, $.middle, $.last].filter(Boolean).join(" ")
// composed display name, skipping missing parts
```

Each is sugar for the one-parameter arrow it reads as (`x => Number(x)`), and it lowers to exactly what that arrow lowers to. Every method that takes a callback accepts them, both the array methods and the lodash iteratee/predicate methods alike — `.uniqBy(Number)`, `.keyBy(ObjectId)`, `.reject(Boolean)`. So one vocabulary covers whichever method you reach for.

The bare form is for **arrays of values**. A pipeline stream carries documents, so `$$.countBy(String)` would stringify a whole document. The stream methods take a field name or an arrow instead (see [Stream methods](#stream-methods-chained-after-the-rhs)). Outside a callback position, the bare form errors at compile time. Write `Boolean(x)` / `ObjectId(x)` to convert a single value.

**JSMQL does not allow `Date` bare, by design.** The rule is that a bare built-in must mean what it reads as. `Date`, called without `new`, ignores its argument entirely and returns the current time as a string. Write the explicit form instead: `x => new Date(x)`.

**`parseInt` and `parseFloat` are not JSMQL names.** `Number(…)` is the one numeric conversion. `parseInt` reads a RADIX from its second argument, so `['1', '2', '3'].map(parseInt)` answers `[1, NaN, NaN]` in real JavaScript, because the index arrives as the radix. MongoDB's `$toInt` refuses a fractional string outright, so `parseInt`'s truncation has no MQL form. `parseFloat` differs from `Number` on a value with trailing text — `parseFloat("12abc")` is `12`, but `Number("12abc")` is `NaN` — and `$toDouble` refuses `"12abc"` on the server. JSMQL refuses both, and the error message names `Number(<value>)`, or `Math.trunc(Number(<value>))` for the whole number `parseInt` would give.

### Set methods (ES2025)

Wrap arrays in `new Set(...)` to use the ES2025 set-algebra methods. The wrapper is a JS-syntax tag; MQL has no Set type, so the underlying arrays go straight into the operator.

```js
new Set($.a).intersection(new Set($.b))   // { $setIntersection: ["$a", "$b"] }
new Set($.a).union(new Set($.b))          // { $setUnion: ["$a", "$b"] }
new Set($.a).difference(new Set($.b))     // { $setDifference: ["$a", "$b"] }
new Set($.a).isSubsetOf(new Set($.b))     // { $cond: { if: { $eq: [{ $ifNull: ["$a", null] }, null] }, then: null, else: { $setIsSubset: ["$a", { $ifNull: ["$b", []] }] } } }
new Set($.a).isSupersetOf(new Set($.b))   // { $cond: { if: { $eq: [{ $ifNull: ["$a", null] }, null] }, then: null, else: { $setIsSubset: [{ $ifNull: ["$b", []] }, "$a"] } } }
```

The first three pass a null operand straight through and answer null. `$setIsSubset` refuses a null operand and aborts the command. So JSMQL tests the receiver first and answers null when it is not there, as every JavaScript method does (see [the rule](#type-aware-dispatch)); a missing *argument* reads as the empty set.

```js
new Set($.a).symmetricDifference(new Set($.b))
// → { $let: { vars: { jsmqlA: { $ifNull: ["$a", []] }, jsmqlB: "$b" }, in: { $setDifference: [ { $setUnion: ["$$jsmqlA", "$$jsmqlB"] }, { $setIntersection: ["$$jsmqlA", "$$jsmqlB"] } ] } } }
new Set($.a).isDisjointFrom(new Set($.b))
// → { $eq: [ { $size: { $setIntersection: [{ $ifNull: ["$a", []] }, { $ifNull: ["$b", []] }] } }, 0 ] }
```

The last two have no single MongoDB operator, so JSMQL composes them. Each operand is bound once, so a field is read once however the composition uses it. The set-method argument must itself be a `new Set(...)` literal, so that the JS reads consistently.

For `$allElementsTrue` / `$anyElementTrue`, use the natural JS forms `arr.every(Boolean)` / `arr.some(Boolean)`.

### Grouping: `<collection>.groupBy()`

```js
$.items.groupBy(x => x.category)
// → an object keyed by the discriminator, each key holding the matching elements
```

The discriminator is a single-parameter arrow, a field name (`"category"`), or omitted for the element itself. JSMQL wraps a non-string key in `$toString`, matching JavaScript, which coerces an object key to a string.

**`Object.groupBy(collection, discriminator)` is not a JSMQL name.** It said the same thing as the receiver form and emitted identical MQL, and one capability gets one spelling. The name still parses, so JSMQL's error names the form that works:

```js
Object.groupBy($.items, x => x.category)
// → ❌ CodegenError: 'Object.groupBy(collection, discriminator)' is not part of jsmql …
//    Write '<collection>.groupBy(<discriminator>)'
```

### lodash object methods

These are value-mode methods on an object field, built over `$objectToArray` / `$arrayToObject`. The `mapValues` / `mapKeys` / `pickBy` / `omitBy` iteratee is a `(value[, key]) => …` arrow.

A reader of an object has two spellings, the JavaScript static and the lodash method, and both emit the same MQL:

```js
$.scores.mapValues(v => v * 2)        // { <k>: v*2 }
$.o.mapKeys((v, k) => k.toUpperCase())// rename keys
$.user.pick(["name", "age"])          // keep only those keys (missing keys drop out)
$.user.omit(["password"])             // all keys except those
$.user.pick($.visibleFields)          // the key list read from the document itself
$.pick(["name", "age"])               // the document itself is a receiver too — bare $ is $$ROOT
$.o.pickBy(v => v != null)            // keep entries whose value passes
$.o.omitBy((v, k) => k.startsWith("_"))// drop entries whose (value, key) passes
$.o.invert()                          // swap keys/values (new keys stringified, last wins)
$.o.toPairs()                         // [[k, v], …]
$.pairs.fromPairs()                   // { pairs[i][0]: pairs[i][1] }   (receiver is a [[k,v]] array)

$.o.keys()                            // same MQL as Object.keys($.o)
$.o.values()                          // same MQL as Object.values($.o)
$.o.entries()                         // same MQL as Object.entries($.o)
$.o.assign($.p, $.q)                  // { $mergeObjects: ["$o", "$p", "$q"] } — a NEW object, like .pick()
$.pairs.fromEntries()                 // same MQL as Object.fromEntries($.pairs) — and as $.pairs.fromPairs()
$.user?.profile?.keys()               // `?.` stops the chain: null when `user.profile` is missing (see Optional Chaining)
```

> `.keys()` / `.values()` / `.entries()` read the object when the receiver's type is not known at compile time. JSMQL refuses them on a receiver it can PROVE is an array, because JavaScript's `Array.prototype.keys()` returns an iterator, and MongoDB has no such value. `$.xs.map(x => x).keys()` names `$op($range, 0, $op($size, arr))` instead.

> `pick` uses flat field names only; a deep path such as `"a.b"` has no support here — use `$op($getField, …)` instead. `mapKeys`/`invert` **stringify** the produced key, using `$toString`, and the last one wins on a collision, like lodash. A live mongod verified every shape here.

> **A missing object is `{}` under a dot, and `null` under `?.`** — [HR5](LANG_RULES.md). `$objectToArray` answers `null` for a missing field, and `$arrayToObject` passes that null on, so the compiler wraps the receiver of every object method in `{ $ifNull: [<field>, {}] }`: `_.pick(undefined, …)` is `{}`, `Object.keys({})` is `[]`, and that is what each method answers. Write `?.` and the chain stops instead, with `null`:
>
> ```js
> $.o.keys()             // → { $map: { input: { $objectToArray: { $ifNull: ["$o", {}] } }, as: "jsmqlKv", in: "$$jsmqlKv.k" } }
> $.o?.keys()            // → { $cond: { if: { $eq: [{ $ifNull: ["$o", null] }, null] }, then: null, else: { $map: { input: { $objectToArray: "$o" }, as: "jsmqlKv", in: "$$jsmqlKv.k" } } } }
> $.o.toPairs()          // → { $map: { input: { $objectToArray: { $ifNull: ["$o", {}] } }, as: "jsmqlKv", in: ["$$jsmqlKv.k", "$$jsmqlKv.v"] } }
> ```
>
> That is the one place `.toPairs()` and `.entries()` differ: one is lodash's spelling of the reading, and the other is JavaScript's. `Object.keys($)` reads the root document, which is always there, so it needs no neutral answer either way.

> **JSMQL reads a `pick` / `omit` key list at query time when the source does not spell it out** — for example, a field path, or a list holding an element read at run time. JSMQL walks the object's own keys and matches each against the list. A key list that is missing or null picks nothing and omits nothing, as lodash does. The `$$.pick(…)` / `$$.omit(…)` STREAM forms still need a spelled-out list, because they lower to `$project`, and the server reads a stage's field list before it reads any document.

---

## Lambda Functions

Array methods use lambdas. JSMQL supports two forms:

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

### Destructured parameters

A parameter may be an array or object pattern of plain names, as in JavaScript. The pattern is one parameter, and each name is that parameter's part wherever the body reads it. So `([id, count]) => -count` **is** `x => -x[1]`: the MQL is the same, and a sort key still reads its minus sign as the direction:

```js
$.tally.entries().sortBy(([id, count]) => -count)       // ≡ .sortBy(e => -e[1]) — count descending
// → { $map: { input: { $sortArray: { input: { $map: { input: { $map: { input: { $objectToArray: "$tally" }, as: "jsmqlKv", in: ["$$jsmqlKv.k", "$$jsmqlKv.v"] } },
//                                                       as: "x", in: { k: { $arrayElemAt: ["$$x", 1] }, v: "$$x" } } }, sortBy: { k: -1 } } },
//             as: "jsmqlP", in: "$$jsmqlP.v" } }

$.items.map(({ sku, qty: n }) => sku + n)                // ≡ .map(x => x.sku + x.qty)
// → { $map: { input: "$items", as: "x", in: { $add: ["$$x.sku", "$$x.qty"] } } }

$.pairs.map(([, second]) => second)                     // an elision skips an element
```

The names are the pattern's whole vocabulary. JSMQL refuses a default value (`[a = 1]`), a rest element (`[a, ...rest]`), a nested pattern (`[[a]]`, `{ a: { b } }`), or a computed key (`{ [k]: v }`). Each error names the plain-name spelling to write instead: `x => x.a ?? 1`, `x => x.slice(1)`, `x => x[0][0]`. The `function` form takes the same patterns.

Lambda parameters shadow outer field references within their scope:

```js
$.items.map(price => price * $.taxRate)
// price refers to the loop variable; $.taxRate refers to the document field
```

### Block bodies with local `const` (→ `$let`)

A lambda can have a **block body** that declares local `const` / `let` bindings and ends with a `return`. Each binding becomes a MongoDB `$let` variable, so you can name an intermediate value and reuse it, just as in JavaScript:

```js
$.legs.map(leg => {
  const score = leg.riskScore;
  const band = score > 50 ? "high" : "low";
  return { id: leg.id, score, band };
})
// → { $map: { input: "$legs", as: "leg", in:
//      { $let: { vars: { score: "$$leg.riskScore" }, in:
//        { $let: { vars: { band: { $cond: { if: { $gt: ["$$score", 50] }, then: "high", else: "low" } } }, in:
//          { id: "$$leg.id", score: "$$score", band: "$$band" } } } } } } }
```

JSMQL nests bindings in source order, so a later `const` can read an earlier one (`band` reads `score` above). This works wherever a lambda takes a value — an in-document array method, the `$let(vars, fn)` form, an IIFE — **and in every predicate position**, including a `$$$.<coll>` lookup, `$$.filter` / `$$.reject`, a `$facet` branch, an `$out` write chain, and a `$$.push(...)` union source:

```js
$.recent = $$$.orders.filter(o => { const t = o.total; return t > $.minTotal; });
// → [{ $lookup: {
//      from: "orders",
//      let: { jsmql_f0_minTotal: "$minTotal" },
//      pipeline: [{ $match: { $expr:
//        { $let: { vars: { t: "$total" }, in: { $gt: ["$$t", "$$jsmql_f0_minTotal"] } } } } }],
//      as: "recent" } }]
```

A `$let` has no query-document form, so a predicate written this way rides entirely in `$expr`; JSMQL does not translate it to indexable query syntax. Note this when the predicate is one an index would otherwise serve. Everything else behaves as it does elsewhere: bindings nest, a `$.<field>` read still hoists into the `$lookup.let`, and `.reject` negates the `return` while it keeps the bindings.

> **⚠️ JavaScript pitfall — `=> {` always opens a block.** Exactly as in JavaScript, `x => { … }` opens a *statement block*, not an object. To return an object, wrap it in parentheses: `x => ({ a: 1 })`. Writing `x => { a: 1 }` is an error, because it has no `return`; JSMQL points you at the parenthesised form. A block body must be `{ (const|let … ;)* return <expr>; }`.

### Immediately-invoked arrow functions (IIFE → `$let`)

A call expression whose callee is an arrow-function literal compiles to MongoDB's `$let`. This is the JS-natural way to bind a name and avoid computing a sub-expression twice:

```js
((maxAge, minAge) => $.age >= minAge && $.age <= maxAge)(65, 18)
// → { $let: {
//       vars: { maxAge: 65, minAge: 18 },
//       in: { $and: [{ $gte: ["$age", "$$minAge"] }, { $lte: ["$age", "$$maxAge"] }] }
//     } }

((d) => $.price - d)($.price * 0.1)
// → { $let: { vars: { d: { $multiply: ["$price", 0.1] } }, in: { $subtract: ["$price", "$$d"] } } }
```

Either single-parameter paren style works: `(x => body)(arg)` and `((x) => body)(arg)` produce identical MQL. A parameter may be destructured into plain names (see [Destructured parameters](#destructured-parameters)). JSMQL refuses a default value or a rest parameter; write the default with `??` in the body, and slice the parameter for the rest.

The body of the IIFE can reference outer `$.fields` freely. Only the lambda parameters are rebound.

### Reusable functions

Inside a pipeline, you can give an arrow function a **name** — `const f = (a) => …` — and call it by that name, as a named IIFE. The declaration itself emits nothing. Each call expands the body inline as its own `$let`, so you can declare a helper once and reuse it across many fields, without storing anything in the document:

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

A practical example: a formatter declared once, reused for sender and recipient.

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

The **`function` keyword** is a second spelling of the same thing. Write it however you would write JavaScript. It works everywhere an arrow does: as a declaration, as an inline callback, and as the `jsmql(fn)` input. A `function` declaration is *self-terminating*: it needs no `;` after the `}`, exactly like JS:

```js
function money(n) { return Math.round(n * 100) / 100 }
$ = { subtotal: money($.price), tax: money($.tax) };
// …identical MQL to `const money = (n) => …`

$.items.map(function (x) { return x * 1.1 })   // inline callback — same as `(x) => x * 1.1`
jsmql(function ({ $ }) { return $.age >= 18 })  // entry form — same as `({ $ }) => $.age >= 18`
```

JSMQL accepts a named function *expression*, such as `.map(function scale(x) { … })`, but ignores the name, because MQL has no recursion and the name is unreachable. JSMQL rejects `async function` and generator `function*`, and points you at the plain form.

Notes:

- **Both `=>` styles, the `function` keyword, and a block body all work**: `x => …`, `(x) => …`, `(x) => { const t = …; return …; }`, and `function f(x) { return …; }`. A block body uses the same local-`const` rules described above.
- **A function body can close over the document.** Beyond its parameters, a function body may read `$.fields` and in-scope `let` bindings.
- **Functions compose.** One function may call another declared earlier in the same pipeline.
- **Functions are pipeline-only.** A function is a pipeline statement, exactly like [`let`](#local-bindings-let). An arrow declaration needs the `;` that puts the source into pipeline mode. A `function` declaration is self-terminating and triggers pipeline mode on its own. Declare functions at the top level of the pipeline, not inside an arrow body.
- **JSMQL re-lowers a function per call.** Calling a function twice produces two independent `$let` blocks. JSMQL stores no shared definition anywhere, and a declared-but-uncalled function adds nothing to the output.
- Each of these produces an actionable error: calling an undeclared name, using the wrong argument count, recursion, or using a function as a value instead of calling it.

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
Math.cbrt($.x)                     // { $multiply: [{ $cmp: ["$x", 0] }, { $pow: [{ $abs: "$x" }, { $divide: [1, 3] }] }] }
                                   // the sign is factored out: Math.cbrt(-8) is -2 in JavaScript,
                                   // and $pow of a negative base to a fractional exponent is not that
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

MongoDB has no JS equivalent for degree/radian conversion. Use the escape hatch:
```js
$degreesToRadians($.degAngle)      // { $degreesToRadians: "$degAngle" }
$radiansToDegrees($.radAngle)      // { $radiansToDegrees: "$radAngle" }
```

### Constants

```js
Math.PI                            // 3.141592653589793
Math.E                             // 2.718281828459045
```

**Note:** `Math.round(x)` rounds to the nearest integer (`{ $round: [x, 0] }`). To round to N decimal places, use the `$round()` escape hatch. JS has no equivalent:
```js
$round($.value, 2)                 // { $round: ["$value", 2] } (round to 2 decimal places)
```

**Note:** `Math.log()` is the natural logarithm. For another base, use the `$log()` escape hatch:
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
Math.trunc(Number($.stringField))  // { $trunc: { $toDouble: "$stringField" } } — the whole number
```

`Boolean(x)` follows JavaScript's truthy and falsy rules. `Boolean("")` is `false`, `Boolean(0)` is `false`, and `Boolean([])` is `true`. To get MongoDB's raw `$toBool`, call the operator directly: `$toBool($.x)`. Here `""` is truthy and `null` stays `null`.

### `typeof` Operator

```js
typeof $.field                     // { $type: "$field" }
typeof $.age === "string"          // { $eq: [{ $type: "$age" }, "string"] }
typeof $.age === "number"          // { $in: [{ $type: "$age" }, ["double", "int", "long", "decimal"]] }
```

It returns the BSON type name as a string, for example `"string"`, `"bool"`, `"objectId"` or `"date"`. An **umbrella** name, such as `"number"`, tests membership over the concrete types it covers, because `$type` answers with one concrete type.

**A `typeof` comparison names a BSON type, not a JavaScript type.** MongoDB's vocabulary is the only vocabulary here: `"bool"`, not JavaScript's `"boolean"`; `"long"`, not `"bigint"`; `"javascript"`, not `"function"`. JSMQL refuses each of these three names and points at the MongoDB name, instead of a test that silently matches nothing. `"undefined"` is a MongoDB type, the deprecated BSON one, so it means only that. Absence has its own spelling: `x === undefined`.

### Number static predicates

```js
Number.isInteger($.n)              // true if $.n is int/long, or a double with no fractional part
Number.isNaN($.x)                  // { $and: [{ $isNumber: "$x" }, { $eq: [{ $toString: "$x" }, "NaN"] }] }
                                   // MongoDB's $eq says NaN == NaN, so JS's self-comparison
                                   // trick cannot work: the test is a numeric-type check plus
                                   // a string comparison of the value's own rendering.
```

JSMQL does not support `Number.isFinite()`, because MongoDB has no Infinity literal to reference cleanly. For finite-bound checks, write the bounds directly, for example `$.x > -1e300 && $.x < 1e300`. You can also use `$convert` with an `onError` clause.

### lodash number methods

Value-mode methods on a number field (per document, not stream methods):

```js
$.n.clamp(0, 100)      // { $min: [{ $max: ["$n", 0] }, 100] }
$.n.inRange(10)        // 0 <= n < 10   (checked with $min/$max so negative ranges swap)
$.n.inRange(5, 10)     // 5 <= n < 10
$.t.inRange(new Date("2024-01-01"), new Date("2025-01-01"))   // a date reads the same range test
$.n.round()            // { $round: ["$n", 0] }   — MongoDB $round is half-to-EVEN (banker's), so round(2.5) === 2
$.n.round(2)           // { $round: ["$n", 2] }
$.n.ceil()             // { $ceil: "$n" }
$.n.ceil(2)            // scale by 10² via $pow, $ceil, scale back
$.n.floor(1)           // as ceil, with $floor
```

> `round` uses MongoDB's `$round`, which rounds half-to-even. This **differs from lodash**, where `_.round(2.5) === 3`. JSMQL emits the native operator on purpose, instead of an emulation.

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

`to` takes any BSON type name that `$convert` accepts. The enum is a fact on the `$convert` row in [`src/registry/names.ts`](../src/registry/names.ts). JSMQL refuses a typo at compile time and names the valid set in the message.

### ObjectId literals

Write a constant `_id` in three ways. They all produce the same live BSON ObjectId:

```js
$._id === 0x507f1f77bcf86cd799439011        // leanest: type `0x`, paste the 24-char id
$._id === ObjectId("507f1f77bcf86cd799439011")
$._id === new ObjectId("507f1f77bcf86cd799439011")
// all → { _id: new ObjectId("507f1f77bcf86cd799439011") }

[0x507f1f77bcf86cd799439011, 0x698a76556c10b90d8bd0497e].has($._id)
// { _id: { $in: [new ObjectId("507f…"), new ObjectId("698a…")] } }
```

The **`0x` hex form** is the easiest to use. It needs no quotes and no wrapper: paste a 24-character hex `_id` after `0x` (numeric separators like `0x507f_1f77_…` are allowed). A `0x` literal with **exactly 24 hex digits** is an ObjectId. A shorter one is an ordinary integer (`0xff` → `255`). JSMQL rejects a longer, non-24-digit hex value that exceeds the safe integer range.

JSMQL emits a real BSON `ObjectId` value. This is the only value the MongoDB driver accepts in a query document, so the equality test uses the index with no `$expr` wrapper. (A hand-written Extended JSON envelope is **not** equivalent: the driver passes it to the server as written, and the server rejects it as an unknown operator.) JSMQL checks the string passed to `ObjectId("…")` for 24 hex characters at compile time, so it catches a typo early.

**Typo guard.** The first four bytes of an ObjectId are a creation timestamp. MongoDB did not exist before 2009, so JSMQL rejects any ObjectId whose timestamp predates that date (the smallest accepted id is `0x4a000000…`, 2009-05-05). This catches common mistakes: an all-zeros id, a sequential placeholder such as `0x1234…`, or a dropped leading digit. The error names the decoded date, so you can see what you typed.

Two more forms handle the non-constant cases:

```js
$.userId = ObjectId($.idString)    // dynamic value → { $toObjectId: "$idString" } (server-side convert)
$.newId  = ObjectId()              // no argument   → { $createObjectId: {} } (server-side fresh id)
```

For an id you only have **at runtime**, pass a real ObjectId through the template tag or a `jsmql.compile` parameter. Do not bake a string into the source:

```js
jsmql`$._id === ${someObjectId}`              // interpolate a live ObjectId instance
jsmql.compile(({ id }) => $._id === id)       // then call with { id: someObjectId }
```

The value is an `ObjectId` from **your own `bson`** package. JSMQL declares `bson` as a peer dependency, so it resolves to the one copy your driver already carries. The value passes `instanceof` in your code, and it moves to any other module unchanged.

### The other BSON types

Eight more BSON types have the same three-way spelling. A constant is a live BSON value. A runtime value converts on the server. `X(…)` and `new X(…)` are equivalent, and `jsmql.stringify` writes the `new X(…)` form.

```js
$.price === Decimal128("9.99")     // → { price: new Decimal128("9.99") }
$.n === Long("9007199254740993")   // → { n: Long.fromString("9007199254740993") }
$.count === Int32(3)               // → { count: new Int32(3) }
$.ratio === Double(1)              // → { ratio: new Double(1) }
$.id === UUID("6ac24965-7917-4323-8d44-920ad1d69b94")
$.grade === MinKey()               // → { grade: new MinKey() }
$.grade < MaxKey()                 // → { grade: { $lt: new MaxKey() } }

$.a = Decimal128($.s);             // → [{ $set: { a: { $toDecimal: "$s" } } }]
```

If you know mongosh, its names also work here and mean exactly the same thing: `NumberDecimal` → `Decimal128`, `NumberLong` → `Long`, `NumberInt` → `Int32`, `ISODate` → `Date`.

`Timestamp`, `Binary`, `DBRef`, `Code`, `BSONSymbol` and `BSONRegExp` have **no source spelling**, because they are not analytics types. `Timestamp` in particular is MongoDB's *internal* oplog type, not a date. Interpolate one when you need it (`` jsmql`$.ts === ${new Timestamp({ t, i })}` ``). JSMQL passes it through unchanged, and `jsmql.stringify` prints it correctly.

**`Double` changes the stored type.** The driver writes a whole JavaScript number as an **int**, so `$.a = 1;` stores an int, and `$.a = Double(1);` stores a double.

**Arithmetic stays on the server.** JSMQL never computes arithmetic on a BSON number at compile time. Computing it in JavaScript would break the guarantee you asked for when you wrote the type:

```js
$.a = Decimal128("0.1") + Decimal128("0.2");
// → [{ $set: { a: { $add: [new Decimal128("0.1"), new Decimal128("0.2")] } } }]
// the server answers 0.3 — exact. A double answers 0.30000000000000004.
```

The one thing that does fold is an exact read: `Decimal128("1.50").toString()` → `"1.50"`.

**JSMQL refuses what `bson` would silently wrap.** `new Int32(5000000000)` becomes `705032704` in `bson` and in mongosh, a wrong number that looks plausible. JSMQL rejects it at the source position and names the type that fits:

```js
$.a = Int32(5000000000);
// 'Int32(<constant>)' — this constant is not a whole number in the 32-bit range
// (-2147483648 … 2147483647). Write 'Long(…)' for a bigger integer, or 'Double(…)'
// to keep a fraction.
```

### Surprise: numeric equality is cross-type, but exact

MongoDB compares numbers across BSON types, so `{ price: 1.5 }` matches an int, a long, a double and a decimal `1.5` alike. But the comparison is **exact**, and a double cannot represent most decimal fractions exactly:

```js
// a collection storing money as Decimal128
$.price === Decimal128("0.1")   // finds it
$.price === 0.1                 // finds NOTHING — and reports no error
```

The double `0.1` is really `0.1000000000000000055…`, which truly differs from decimal `0.1`. On a `Decimal128` column, write the constant as `Decimal128(…)`. (`1.5` happens to store exactly, so it matches either way. This is what makes the mistake easy to miss.)

Two more measured surprises are worth knowing. `Long + Double` promotes to a double and loses the integer: `$add: [Long("9007199254740993"), Double(0.5)]` gives `9007199254740992`. `MinKey` and `MaxKey` **compare** with every type but **compute** with none: `$add: [MinKey(), 1]` is a server error.

---

## Date Operations

### Date Constructor and `Date.now()`

```js
// Constant arguments → a real BSON Date, folded at compile time (see note below):
new Date("2024-01-01")             // Date(2024-01-01T00:00:00Z)
new Date(2024, 1, 15)              // Date(2024-02-15T00:00:00Z)   (UTC; month 1 = February — months count from 0, as in JS)
new Date(2024, 11, 31, 23, 59, 58, 999)
                                   // Date(2024-12-31T23:59:58.999Z) — full y/m/d/h/min/s/ms form; December is 11
new Date(Date.UTC(2024, 1, 15))    // Date(2024-02-15T00:00:00Z)

// Runtime arguments → the aggregation form (value isn't known until query time):
new Date()                         // "$$NOW"  (current date/time)
new Date($.dateString)             // { $toDate: "$dateString" }
new Date($.y, $.m, $.d)            // { $dateFromParts: { year: "$y", month: { $add: ["$m", 1] }, day: "$d" } }

Date.now()                         // { $toLong: "$$NOW" }  (ms since epoch, like JS)
Date.UTC(2024, 1, 15)              // 1707955200000  (folded — 15 February)
Date.UTC($.y, $.m)                 // { $toLong: { $dateFromParts: { year: "$y", month: { $add: ["$m", 1] }, timezone: "UTC" } } }
```

**Constant folding.** When every argument to `new Date(...)` is a compile-time literal, JSMQL evaluates the constructor and emits a real BSON `Date`, **not** the aggregation `{ $toDate }` or `$dateFromParts` form. This matters because a `Date` is the only shape that works in *both* an aggregation expression *and* a query document. `{ field: { $gte: { $toDate: "..." } } }` does **not** match in a Filter or `$match`, because MongoDB's query language reads `{ $toDate: ... }` as a literal subdocument and never matches anything. Only truly runtime forms (`new Date()`, `new Date($.field)`) keep the aggregation form. If the constant arguments do not form a valid date (`new Date("not-a-date")`), JSMQL rejects it at compile time instead of emitting MQL that the server would refuse.

**Months count from 0, as in JavaScript. `new Date(2024, 1, 15)` is 15 February.** A JavaScript spelling gets JavaScript's behaviour: the constructor, `Date.UTC` and `.getMonth()` all count January as `0`. So a getter round trip needs no adjustment (`new Date($.t.getFullYear(), $.t.getMonth(), 1)` is the first of the month), and code pasted from a JavaScript file means what it meant there. An out-of-range part rolls over exactly as in JavaScript: `new Date(2024, 12, 1)` is 1 January 2025. MongoDB's own operators keep MongoDB's base when you reach them through the escape hatch: `$month($.t)` is 1-based, and `$dateFromParts({ year: 2024, month: 1, day: 15 })` is January. The compiler leaves a `$op(…)` untouched.

```js
new Date(2024, 0, 15)              // Date(2024-01-15T00:00:00Z)  — January is 0
new Date(2024, 12, 1)              // Date(2025-01-01T00:00:00Z)  — rolls over, as JavaScript does
$.createdAt.getMonth()             // { $subtract: [{ $month: "$createdAt" }, 1] }   — January is 0
$month($.createdAt)                // { $month: "$createdAt" }                        — MongoDB's: January is 1
```

**Note:** JavaScript's multi-argument `new Date(y, m, d, …)` reads in the runtime's *local time*. JSMQL reads it as **UTC** (MQL's `$dateFromParts` default, or `Date.UTC` for the constant fold), because "local time" on a MongoDB server is rarely what a query author wants. Use `Date.UTC(...)` or `new Date(Date.UTC(...))` when you need the UTC behaviour explicitly.

### Date Getter Methods

Call on any expression that produces a date:

```js
$.createdAt.getFullYear()          // { $year: "$createdAt" }
$.createdAt.getMonth()             // { $subtract: [{ $month: "$createdAt" }, 1] }   (January = 0, as in JS)
$.createdAt.getDate()              // { $dayOfMonth: "$createdAt" }
$.createdAt.getDay()               // { $subtract: [{ $dayOfWeek: "$createdAt" }, 1] }   (0 = Sunday … 6 = Saturday, as in JS)
$.createdAt.getHours()             // { $hour: "$createdAt" }
$.createdAt.getMinutes()           // { $minute: "$createdAt" }
$.createdAt.getSeconds()           // { $second: "$createdAt" }
$.createdAt.getMilliseconds()      // { $millisecond: "$createdAt" }
$.createdAt.getTime()              // { $toLong: "$createdAt" }   (ms since epoch)
$.createdAt.toISOString()          // { $dateToString: { date: "$createdAt" } }   (that format IS $dateToString's default)
```

Each component getter has a `getUTC*` variant that reads the date in UTC instead of the server's local zone. This matches JavaScript's split between `getHours()` (local) and `getUTCHours()` (UTC):

```js
$.createdAt.getUTCFullYear()       // { $year: "$createdAt" }
$.createdAt.getUTCMonth()          // { $subtract: [{ $month: "$createdAt" }, 1] }   (January = 0)
$.createdAt.getUTCDate()           // { $dayOfMonth: "$createdAt" }
$.createdAt.getUTCDay()            // { $subtract: [{ $dayOfWeek: "$createdAt" }, 1] }   (0 = Sunday, as in JS)
$.createdAt.getUTCHours()          // { $hour: "$createdAt" }
$.createdAt.getUTCMinutes()        // { $minute: "$createdAt" }
$.createdAt.getUTCSeconds()        // { $second: "$createdAt" }
$.createdAt.getUTCMilliseconds()   // { $millisecond: "$createdAt" }
```

**Parts with no JavaScript getter.** MongoDB counts weeks, ISO weeks and days of the year, but JavaScript's `Date` does not. So these methods carry Moment's method names and MQL's own numbering:

```js
$.t.week()                         // { $week: "$t" }             → 32   (weeks start Sunday, 0–53)
$.t.isoWeek()                      // { $isoWeek: "$t" }          → 33   (ISO 8601, 1–53)
$.t.isoWeekYear()                  // { $isoWeekYear: "$t" }      → 2026 (the year the ISO week belongs to)
$.t.isoWeekday()                   // { $isoDayOfWeek: "$t" }     → 3    (1 = Monday … 7 = Sunday)
$.t.dayOfYear()                    // { $dayOfYear: "$t" }        → 224
$.t.quarter()                      // { $toInt: { $ceil: { $divide: [{ $month: "$t" }, 3] } } }   → 3

$.t.week("America/New_York")       // { $week: { date: "$t", timezone: "America/New_York" } }
```

Each method takes the optional `timezone` argument, which switches the operator to its `{ date, timezone }` form. `.quarter()` is the one derived value, because MongoDB has no `$quarter` operator. The `$toInt` keeps the result an integer, like every other getter (`$ceil` of a division gives a double). To group *by* quarter, prefer `.startOf("quarter")`, which is one operator and sorts as a date.

**Date arithmetic.** Add or subtract a span of time with `.plus(amount, unit)` and `.minus(amount, unit)`. Both take an optional third `timezone` argument:

```js
$.subscribedAt.plus(30, "day")     // { $dateAdd: { startDate: "$subscribedAt", unit: "day", amount: 30 } }
$.expiresAt.minus(1, "month")      // { $dateSubtract: { startDate: "$expiresAt", unit: "month", amount: 1 } }
$.t.plus(2, "hour", "America/New_York")
// { $dateAdd: { startDate: "$t", unit: "hour", amount: 2, timezone: "America/New_York" } }
```

On a constant date the call folds to the instant the server would compute. See [Compile-time constants](#compile-time-constants-folding). `unit` accepts the same time units as the `$dateAdd` operator (listed under [Date Operator Calls](#date-operator-calls) below). JSMQL rejects a literal typo with a suggestion (`.plus(30, "days")` → *"unit must be one of: … — got 'days'. Did you mean 'day'?"*). A literal `amount` must be an integer, and a literal `timezone` must be a string. Otherwise you get the same compile-time error that the `$dateAdd(…)` operator form gives. A field path or parameter in either slot passes through unchecked. The method name follows Temporal and Luxon (`.plus` / `.minus`), while the `(amount, unit)` argument order follows Moment's `.add(amount, unit)`: `amount` first, `unit` second.

**Date difference.** `.diff(other, unit)` gives the whole number of `unit`s between two dates:

```js
$.end.diff($.start, "day")
// { $dateDiff: { startDate: "$start", endDate: "$end", unit: "day" } }

new Date().diff($._id, "day")      // how old is this document?
// { $dateDiff: { startDate: "$_id", endDate: "$$NOW", unit: "day" } }
```

**The receiver is the later date**, so the result is `receiver − other`. This is the same direction that Moment's `.diff`, Luxon's `.diff` and Temporal's `.since` all use. `other` may be a date, a BSON timestamp, or an ObjectId (MongoDB reads the creation time out of the id), and so may the receiver.

**Note — `.diff` counts boundaries, not elapsed time.** This is MongoDB's `$dateDiff` behaviour, and it is *not* what Moment or Luxon do. For a unit of `"day"` or larger, MQL counts how many unit boundaries lie between the two dates. So 23:00 to 01:00 the next morning is **1 day** (one midnight crossed), and 00:30 to 23:30 the same day is **0 days**. Moment's elapsed-time subtraction reports the opposite result in both cases. For raw elapsed milliseconds, subtract the dates instead: `$.end - $.start` → `{ $subtract: ["$end", "$start"] }`.

**Truncate to a unit.** `.startOf(unit)` rounds a date down to the start of its year, quarter, month, week, day, hour, minute or second. It is the bucket key that a time-series `$group` wants:

```js
$.createdAt.startOf("month")
// { $dateTrunc: { date: "$createdAt", unit: "month" } }

$group({ _id: $.createdAt.startOf("month"), revenue: $sum($.total) });
// { $group: { _id: { $dateTrunc: { date: "$createdAt", unit: "month" } }, revenue: { $sum: "$total" } } }
```

Because the result is a date, it sorts, compares and chains like one: `$.createdAt.startOf("month").plus(1, "month")` is the exclusive end of the same bucket. `"quarter"` is available here even though no getter returns a quarter number.

Two options refine it. `binSize` groups several units into one bucket, and `startOfWeek` moves the week boundary:

```js
$.createdAt.startOf("minute", { binSize: 15 })    // 15-minute buckets
// { $dateTrunc: { date: "$createdAt", unit: "minute", binSize: 15 } }

$.createdAt.startOf("week", { startOfWeek: "monday" })
// { $dateTrunc: { date: "$createdAt", unit: "week", startOfWeek: "monday" } }
```

**Format a date as a string.** `.format(spec)` takes MongoDB's own format specifiers:

```js
$.createdAt.format("%Y-%m-%d")
// { $dateToString: { date: "$createdAt", format: "%Y-%m-%d" } }        → "2026-08-12"

$.createdAt.startOf("month").format("%Y-%m")
// { $dateToString: { date: { $dateTrunc: { date: "$createdAt", unit: "month" } }, format: "%Y-%m" } }
//                                                                     → "2026-08"

$.createdAt.format("%H:%M", "America/New_York")
// { $dateToString: { date: "$createdAt", format: "%H:%M", timezone: "America/New_York" } }
```

| | | | |
|---|---|---|---|
| `%Y` year | `%m` month | `%d` day of month | `%j` day of year |
| `%G` ISO year | `%V` ISO week | `%U` week (Sunday-based) | `%u` `%w` weekday (ISO / Sunday-based) |
| `%H` hour (24) | `%M` minute | `%S` second | `%L` millisecond |
| `%z` UTC offset | `%Z` offset in minutes | `%%` a literal `%` | |

**The specifiers are MongoDB's, not Moment's.** `.format` borrows Moment's method *name*, but JSMQL rejects a Moment token string at compile time and gives the translation: `"YYYY-MM-DD"` → *"Did you mean '%Y-%m-%d'?"*. This matters because such a string is valid MQL on its own: `$dateToString` formats it as literal text, so every document would come back reading `"YYYY-MM-DD"` with no sign of the mistake. JSMQL also rejects a wrong specifier (`%y` for `%Y`) and fixes the case in the suggestion. JSMQL does not translate Moment tokens fully, because MongoDB has no month-name, weekday-name, 12-hour or 2-digit-year output at all, so a translator could not handle `dddd` or `MMM`. Derive those values from the numeric parts instead: `["Jan", "Feb", …][$.t.getMonth() - 1]` → `{ $arrayElemAt: [["Jan", "Feb", …], { $subtract: [{ $month: "$t" }, 1] }] }`.

`$dateToString`'s `onNull` is not an option here. The method's result is always a string, which is what lets `$.t.format("%Y") + "-x"` compile to `$concat`. Use `$dateToString({ date: …, format: …, onNull: … })` when you need `onNull`.

**The inclusive end of the bucket.** `.endOf(unit)` gives the last instant that still belongs to the same bucket, Moment's `23:59:59.999`:

```js
$.createdAt.endOf("month")
// { $dateSubtract: { startDate: { $dateAdd: { startDate: { $dateTrunc: { date: "$createdAt", unit: "month" } },
//                                            unit: "month", amount: 1 } },
//                    unit: "millisecond", amount: 1 } }
//                                        → 2026-08-31T23:59:59.999Z for any August date
```

MongoDB has no ceiling operator, so this needs three operators: truncate, add one unit, and step back a millisecond. `.endOf` takes the same options as `.startOf`. With `binSize`, the step is the whole bin, so `.endOf("minute", { binSize: 15 })` on `15:47` gives `15:59:59.999`. A `timezone` also carries to the addition, so the step stays aware of daylight saving time.

**Prefer a half-open range for date filtering.** `.endOf` is the right answer when you need the last instant itself. But a range test reads better as a half-open interval, and it emits two operators instead of four:

```js
// Recommended: half-open, no millisecond edge to reason about
$.createdAt >= $.t.startOf("month") && $.createdAt < $.t.startOf("month").plus(1, "month")

// Equivalent, but pays for .endOf twice and depends on millisecond precision
$.createdAt >= $.t.startOf("month") && $.createdAt <= $.t.endOf("month")
```

**Note — the week starts on Sunday.** That is MongoDB's default, and Moment's default in an English locale, so `.startOf("week")` on a Wednesday goes back to the preceding Sunday. Luxon's `startOf('week')` uses the ISO Monday instead. Pass `{ startOfWeek: "monday" }` when you want that. The weekday name is not case-sensitive, and JSMQL rejects a typo with a suggestion.

**Replace parts of a date.** `.set({ … })` reads the date's parts, overrides the ones you name, and rebuilds the date (Luxon's `.set`, Temporal's `.with`). Like every JSMQL method, it returns a new value and mutates nothing:

```js
$.t.set({ year: 2030 })
// { $let: { vars: { jsmqlParts: { $dateToParts: { date: "$t" } } },
//           in: { $dateFromParts: { year: 2030, month: "$$jsmqlParts.month", day: "$$jsmqlParts.day",
//                                   hour: "$$jsmqlParts.hour", minute: "$$jsmqlParts.minute",
//                                   second: "$$jsmqlParts.second", millisecond: "$$jsmqlParts.millisecond" } } } }
//                                                            → 2030-08-12T15:47:03.123Z

// Override every part and there is nothing to read back, so the $let goes away:
$.t.set({ year: 2030, month: 1, day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 })
// { $dateFromParts: { year: 2030, month: 1, day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 } }
```

**`.set` counts months from 1.** `{ month: 1 }` is January, as in Luxon's `.set` and MongoDB's `$dateFromParts`, whose vocabulary this method borrows. It is the one date API here that is not a JavaScript spelling, so it does not share `.getMonth()`'s zero base (`$.t.set({ month: $.t.getMonth() + 1 })` round-trips). Every part must be an integer. JSMQL rejects a literal that is not an integer at compile time, exactly as the `$dateFromParts` operator would reject it at run time.

The parts come in two families, and `.set` follows whichever family you name: `year` / `month` / `day`, or the ISO-week family `isoWeekYear` / `isoWeek` / `isoDayOfWeek`. Either family may combine with `hour` / `minute` / `second` / `millisecond`, but the two families cannot mix. MongoDB builds a date from one family or the other, and JSMQL rejects a mix and names both offending keys.

Write the parts out as an object literal, because MongoDB reads them by name. Their values may be field paths or parameters. The timezone is the *second* argument, not a part: `.set({ year: 2030 }, "America/New_York")`. It applies to both the read and the rebuild, so the parts read in that zone.

**Compare at a granularity.** `.isSame(other, unit)`, `.isBefore(other, unit)` and `.isAfter(other, unit)` truncate both sides to `unit` and then compare, so "same day" ignores the time of day:

```js
$.a.isSame($.b, "day")
// { $eq: [{ $dateTrunc: { date: "$a", unit: "day" } },
//         { $dateTrunc: { date: "$b", unit: "day" } }] }

$.a.isBefore($.b, "month")           // strictly an earlier calendar month
// { $lt: [{ $dateTrunc: { date: "$a", unit: "month" } },
//         { $dateTrunc: { date: "$b", unit: "month" } }] }
```

**The unit is required.** Without one, these three methods are exactly `===`, `<` and `>`, which JSMQL already has. So JSMQL rejects a call with no unit and points at the operator: `$.a.isSame($.b)` → *".isSame(other) without a unit is just '==='"*. Options apply to both sides, because a one-sided timezone would compare two different calendars.

#### The trailing `timezone` / options argument

Every date method takes the same optional last argument: a **timezone string**, or an **object literal** whose keys are the underlying operator's remaining fields.

```js
$.end.diff($.start, "week", "UTC")
// { $dateDiff: { startDate: "$start", endDate: "$end", unit: "week", timezone: "UTC" } }

$.end.diff($.start, "week", { startOfWeek: "monday", timezone: "Europe/Kyiv" })
// { $dateDiff: { startDate: "$start", endDate: "$end", unit: "week",
//                timezone: "Europe/Kyiv", startOfWeek: "monday" } }
```

The options a method accepts are exactly the fields its operator has left over. `.diff` takes `timezone` and `startOfWeek`; `.plus` and `.minus` take `timezone` alone. JSMQL rejects an unknown key at compile time and gives a suggestion and the valid set. It emits keys in the operator's own field order, not the order you wrote them, so the output reads like the MongoDB manual.

Write the options form out as an object literal, because MongoDB reads these fields by name from the operator document, so the key names must exist in your source. Their *values* may be field paths or `jsmql.compile` parameters (`{ timezone: $.tz }`). Any non-object argument in this slot is the timezone shorthand.

**Every date number is JavaScript's.** `getMonth()` and `getUTCMonth()` count January as `0` (`{ $subtract: [{ $month: "$t" }, 1] }`). `getDay()` and `getUTCDay()` count Sunday as `0` (`{ $subtract: [{ $dayOfWeek: "$t" }, 1] }`). The constructors and `Date.UTC` read their month the same way, so a getter round trip needs no adjustment, and code pasted from a JavaScript file means what it meant there. MongoDB's own numbering is one `$op(…)` away: `$month($.t)` is 1-based, `$dayOfWeek($.t)` is 1 for Sunday, and the compiler leaves both untouched.

Week numbering needs no adjustment at all: `week()` is `$week` (0–53, weeks begin Sunday), `isoWeek()` is `$isoWeek` (1–53), and `isoWeekday()` is `$isoDayOfWeek` (1 for Monday). The `startOfWeek` option and the `%U` / `%V` / `%u` / `%w` format specifiers are MongoDB's own.

**Note:** the constructors use the same base, so a getter round trip needs no adjustment: `new Date($.t.getFullYear(), $.t.getMonth(), 1)` is the first of the receiver's own month. See [the constructor note](#date-constructor-and-datenow).

**Note:** these methods require a date receiver, so JSMQL rejects a literal non-date at compile time (`"2020-01-01".getFullYear()` → *"'.getFullYear' expects a date, but got a string. Use a field path or new Date(…)."*). A field path or `new Date(…)` passes through. The one exception is `.getTime()`, which lowers to `$toLong` and so also accepts numeric strings or numbers.

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

For a MongoDB operator with no JavaScript equivalent, use the `$opName()` escape hatch: a direct call to the underlying MQL operator. Every MongoDB aggregation operator is available this way. JSMQL passes an unknown operator through automatically, which keeps it compatible with new MongoDB releases.

### Examples:

```js
$zip([$.weeks, $.amounts])         // { $zip: { inputs: ["$weeks", "$amounts"] } }
                                   //   pairs parallel arrays element-wise — no JS equivalent
$match($sampleRate(0.1));          // [{ $match: { $sampleRate: 0.1 } }]
                                   //   probabilistic match (10% sample) — no JS equivalent.
                                   //   A query operator, so it goes in a $match body; written
                                   //   bare it is refused with that position named.
$stdDevPop($.measurements)         // { $stdDevPop: "$measurements" }
                                   //   population standard deviation — no JS equivalent
$group({ _id: $.cat, top3: $topN({ output: $.score, sortBy: { score: -1 }, n: 3 }) });
                                   // [{ $group: { _id: "$cat",
                                   //     top3: { $topN: { output: "$score", sortBy: { score: -1 }, n: 3 } } } }]
                                   //   an accumulator, so it goes in a $group output slot
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

Some operators are commonly used as accumulators in `$group`, where they take a single field expression, but they also work as expression operators in `$project`, where they take multiple expressions to compare. JSMQL accepts both shapes: pass one argument for the accumulator form, or multiple for the expression form:

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

**Operand rules for list operators.** An operator whose operand is a list (the
set operators, arithmetic `$add` / `$divide` / …, `$and` / `$or`, the bitwise
operators) takes either two or more arguments, or a single array. Both forms
produce the same `{ $op: […] }`. JSMQL rejects a single *non-array* value,
because such an operator has no single-value form (write `$setUnion($.a, $.b)`
or `$setUnion([$.a, $.b])`, not `$setUnion($.a)`). `$op(...)` does not accept the
JS spread. Pass a single array instead, or use the JS-method form where it
applies (`Math.max(...$.scores)`). The comparison operators are the exception:
they *do* have a single-value form (`$gt($.x)` → `{ $gt: "$x" }`, the
query-operator shape), so a lone argument is fine there.

### Object Operations

```js
Object.keys($.obj)                 // { $map: { input: { $objectToArray: "$obj" }, as: "jsmqlKv", in: "$$jsmqlKv.k" } }
Object.values($.obj)               // { $map: { input: { $objectToArray: "$obj" }, as: "jsmqlKv", in: "$$jsmqlKv.v" } }
Object.entries($.obj)              // { $map: { input: { $objectToArray: "$obj" }, as: "jsmqlKv", in: ["$$jsmqlKv.k", "$$jsmqlKv.v"] } }
Object.fromEntries($.pairs)        // { $arrayToObject: "$pairs" }
Object.assign($.a, $.b)            // { $mergeObjects: ["$a", "$b"] }
Object.assign($.a, $.b, $.c)       // { $mergeObjects: ["$a", "$b", "$c"] }
Object.assign(...$.docs)           // { $mergeObjects: "$docs" }   (spread)

Array.isArray($.items)             // { $isArray: "$items" }

$getField("fieldName", $.doc)      // { $getField: { field: "fieldName", input: "$doc" } }
$setField("fieldName", $.doc, val) // { $setField: { field: "fieldName", input: "$doc", value: val } }
$unsetField("fieldName", $.doc)    // { $unsetField: { field: "fieldName", input: "$doc" } }
```

`Object.assign` shown here is the **expression** form (→ `$mergeObjects`). Called as a bare **statement**, it mutates its first argument instead. See [Mutators](#objectassigntarget-sources-mutates-target).

### Spread in Variadic Calls

A JavaScript static that takes a list (`Math.min` / `Math.max`, `Object.assign`) takes `...arr`, and passes the whole array through as the operator's value:

```js
Math.max(...$.scores)              // { $max: "$scores" }
Object.assign(...$.docs)           // { $mergeObjects: "$docs" }
```

When you mix spread with non-spread arguments, JSMQL wraps each non-spread value in a single-element array and joins them with `$concatArrays`:

```js
Math.min($.a, ...$.others)         // { $min: { $concatArrays: [["$a"], "$others"] } }
```

**The `$op(…)` escape hatch takes no spread.** `$op(value)` is `{ $op: value }` and `$op(a, b)` is `{ $op: [a, b] }` ([HR2](LANG_RULES.md)); a spread has no MQL of its own. JSMQL refuses `$concatArrays(...$.arrs)` and `$foo(...$.arr)` alike, and the message names the forms that work: the operands one by one, the single array (`$concatArrays($.arrs)`), or the JavaScript spelling (`Math.max(...)`, `[...a, ...b]`, `.concat()`).

`$getField` and `$setField` are useful when a field name is dynamic or contains special characters.

### Variable Binding with `$let`

`$let` binds named variables scoped to a single expression. This avoids repeated sub-expressions:

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

A `"$..."` string that you write in the source is MongoDB's own spelling of a field path, and it passes through as written. JSMQL is a strict superset of MQL ([HR1](LANG_RULES.md)), so `{ a: "$b" }` means what it means in raw MQL. To store or compare the *string* `"$foo"`, mark it with `$literal`:

```js
({ a: "$b" })                      // { a: "$b" }              — the field b, as in MQL
$concat("$first", " ", "$last")    // { $concat: ["$first", " ", "$last"] }
$literal("$foo")                   // { $literal: "$foo" }     — the string "$foo"
$literal(42)                       // { $literal: 42 }         — equivalent to bare 42
$literal({ x: "$foo" })            // { $literal: { x: "$foo" } }
```

A value that arrives at **run time** — a template-tag `${…}` interpolation, or a `jsmql.compile()` parameter — is a value, never syntax. JSMQL wraps a `"$..."` string there in `$literal` wherever the server would evaluate it (an expression, a `$set` value, a stage body), so user input cannot become a field reference. Two places evaluate nothing and take the string as written: a query slot (`$.a === ${s}` compares against the string) and an update document (`jsmql.update`). See [Template-Tag Form](#template-tag-form--jsmql-) and [Parameterised Queries](#parameterised-queries-jsmqlcompile).

```js
jsmql.expr`$.a + ${"$b"}`        // { $add: ["$a", { $literal: "$b" }] }
jsmql.pipeline`$.x = ${"$b"};`   // [{ $set: { x: { $literal: "$b" } } }]
jsmql`$.a === ${"$b"}`           // { a: { $literal: "$b" } }
jsmql.update`$.x = ${"$b"}`      // { $set: { x: "$b" } }
```

### `$meta` — per-document aggregation metadata

⚠️ **Watch out:** `$meta` takes a **keyword string**, for example `"textScore"`, `"indexKey"` or `"searchScore"`, not an arbitrary expression. JSMQL does not check the keyword.

```js
$meta("textScore")                 // { $meta: "textScore" }
```

### Custom Aggregation: `$function` and `$accumulator`

⚠️ **Watch out:** the `body`, `init`, `accumulate`, `merge` and `finalize` fields are **JavaScript source code as a string**. MongoDB's V8 engine executes them on the server. They are NOT JSMQL expressions: JSMQL does not substitute `$.field` references, so you must pass field values through the `args` / `accumulateArgs` arrays.

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

These operators are valid only in a `$setWindowFields` **output** slot, and JSMQL holds them to it. Write one anywhere else, and the refusal names the stage and the shape.

```js
$project({ r: $rank() });
// ✗ $rank is a window operator — only valid inside '$setWindowFields' output slots.
//   Use $setWindowFields({ partitionBy: …, sortBy: …, output: { <key>: $rank(…) } }) …

$setWindowFields({ sortBy: { t: 1 }, output: { r: $rank() } });
// → [{ $setWindowFields: { sortBy: { t: 1 }, output: { r: { $rank: {} } } } }]
```

Write every operator below in that `output` slot. Each one makes this shape:

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

You can write a document field update in JavaScript-natural syntax: `=`, `+=`, `-=`, `*=`, `/=`, and `delete`. Each update op compiles to a MongoDB pipeline `$set` or `$unset` stage. Multiple update ops coalesce into the smallest correct stage shape. `jsmql()` always returns a pipeline **array**, so you can pass the output directly to `db.coll.updateOne(filter, update)`. See [the document form via `jsmql.update`](#document-form-via-jsmqlupdate) at the end of this section for the `{ $set, $inc, … }` update document.

```js
db.users.updateOne({ _id: 1 }, jsmql("$.score = 100"))
// → db.users.updateOne({ _id: 1 }, [{ $set: { score: 100 } }])

db.users.updateOne({ _id: 1 }, jsmql("$.cnt += 1"))
// → db.users.updateOne({ _id: 1 }, [{ $set: { cnt: { $add: ["$cnt", 1] } } }])

db.users.updateOne({ _id: 1 }, jsmql("delete $.tmp"))
// → db.users.updateOne({ _id: 1 }, [{ $unset: "tmp" }])
```

### Sequencing

A `,` separates multiple update ops in the **same stage** (a trailing comma is allowed):

```js
jsmql("$.a = 1, $.b = 2")
// → [{ $set: { a: 1, b: 2 } }]
```

A `;` is **not** a same-stage separator — it splits stages. See [Pipelines](#pipelines) for the canonical `;`-separated pipeline form.

### Targets

In a Filter or an update document, the left side must be a field path: `$.x`, `$.x.y`, `$.x.y.z`. You cannot assign to computed access or index access. A bare identifier is assignable only inside a pipeline, where it names an in-scope `let` binding (see [Local bindings](#local-bindings-let)):

```js
x = 5                  // ✗ — bare identifier, no pipeline / not a `let`
$.items[0] = 5         // ✗ — index access
$.user.name = "alice"  // ✓ — nested field path
```

### Compound assignment

`+=`, `-=`, `*=`, `/=` are sugar for `$.x = $.x <op> rhs`. The `+=` operator inherits the language's type-aware addition: a numeric `+=` produces `$add`, and a string `+=` produces `$concat`.

```js
jsmql("$.score *= 2")
// → [{ $set: { score: { $multiply: ["$score", 2] } } }]

jsmql("$.greeting += '!'")
// → [{ $set: { greeting: { $concat: ["$greeting", "!"] } } }]
```

### Increment / decrement

`x++`, `++x`, `x--`, `--x` are sugar for `x += 1` and `x -= 1`. JavaScript gives prefix and postfix a different meaning: postfix returns the old value, and prefix returns the new value. A statement-level update op in a MongoDB pipeline has no return value, so all four forms compile to the same `$set` stage.

```js
jsmql("$.cnt++")
// → [{ $set: { cnt: { $add: ["$cnt", 1] } } }]

jsmql("--$.lives")
// → [{ $set: { lives: { $subtract: ["$lives", 1] } } }]
```

Like other update ops, increment/decrement is a statement. You cannot use it as a value (`1 + $.x++` is rejected), and it works only on a field-path target.

### Chained assignment

`$.a = $.b = expr` is right-associative, like JavaScript. Both fields receive the same expression on the right side. A compound chain (`a += b += 1`) is rejected, because it is too easy to misread.

```js
jsmql("$.x = $.y = 0")
// → [{ $set: { x: 0, y: 0 } }]
```

### Coalescing

The compiler groups consecutive update ops of the same kind (all assignments, or all deletes) into one `$set` or `$unset` stage. A new stage starts when:

- The kind changes (assignment to delete, or delete to assignment)
- A later update op writes to a path the current group already wrote
- A later assignment **reads** a path the current group has written. This keeps the JavaScript order of execution.

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

### Document form via `jsmql.update`

`jsmql.update()` returns the **update document** — the `{ $set, $inc, $unset, … }` shape that `updateOne(filter, update)` takes. It lowers each write to the update operator that means it. It holds constants only: it refuses a value computed from the document (`$.b + 1`, `$.name.toUpperCase()`), because the server reads `"$b"` in an update document as the *string* `"$b"`, never as the field. The refusal names the pipeline form, which `updateOne` also accepts. See [Strict-shape entry points](#strict-shape-entry-points-jsmqlfilter-jsmqlpipeline-jsmqlupdate) for the full rule.

```js
jsmql.update("$.score = 100")            // → { $set: { score: 100 } }
jsmql.update("$.cnt += 1")               // → { $inc: { cnt: 1 } }
jsmql.update("$.score *= 2")             // → { $mul: { score: 2 } }
jsmql.update("delete $.tmp")             // → { $unset: { tmp: "" } }
jsmql.update("$.updatedAt = new Date()") // → { $currentDate: { updatedAt: true } }
// `new Date()` is the server's clock only as the whole write; `$.a = { t: new Date() }`
// is refused, naming '$.a.t = new Date()' and the pipeline form.
jsmql.update("delete $.a, delete $.b, $.status = 'done'")
// → { $unset: { a: "", b: "" }, $set: { status: "done" } }

jsmql.update("$.name = $.name.toUpperCase()")
// Error: A document-form update takes constants: the server reads '$b' there as the string,
//        not the field. To compute from the document, use the pipeline form
//        ('jsmql.pipeline("$.a = $.b + 1;")'), which 'updateOne' accepts as well.
```

`jsmql.expr()` refuses a write altogether, because an aggregation expression has no `$set`. It names the two entries that take one.

### Update filters inside pipelines

An update filter can appear as a pipeline element alongside an ordinary stage. The same coalescing rule applies between adjacent update op elements. A non-update op stage acts as a boundary:

```js
jsmql(`[
  $match($.active),
  $.score += 1,
  $.lastSeenAt = new Date(),
  $sort({ score: -1 })
]`)
// → [
//     { $match: { $expr: { $and: [{ $ne: [{ $ifNull: ["$active", null] }, null] },   // `$.active` is the JavaScript truthiness test
//                                 { $ne: ["$active", false] }, { $ne: ["$active", ""] }, { $ne: ["$active", 0] }] } } },
//     { $set: { score: { $add: ["$score", 1] }, lastSeenAt: "$$NOW" } },
//     { $sort: { score: -1 } }
//   ]
```

### Limits

An update filter is a **statement**, not an expression value. It is valid only at the top level of a `jsmql()` call or as a direct pipeline-array element. It cannot appear:

- Inside an arbitrary expression (`($.a = 1) + 2` — rejected)
- Inside a lambda body (`$.list.map(x => $.a = x)` — rejected)
- As any value other than a top-level statement or a pipeline element

The `delete` keyword is statement-only. Unlike JavaScript, it does not return a boolean.

### Replace root via `$ = <expr>`

Assigning to bare `$` replaces the **whole document** with the expression on the right side. The natural JS shape — the left side *is* the document — lowers to MongoDB's `$replaceWith` stage, the shorter equivalent of `$replaceRoot: { newRoot: <expr> }`. The trailing `;` is optional when `$ = <expr>` is the only statement: `jsmql("$ = { … }")` and `jsmql("$ = { … };")` both produce the same `$replaceWith` pipeline.

> **Convention:** a leading `$ =` is reserved for *root-replacing* sugar (`$replaceWith`, the [fan-out](#fan-out-one-document-to-many-documents) form, and the `$facet` variant below). A stage that writes elsewhere uses a different left-side prefix, so the write destination is visible at a glance: `$out` uses `$$$.<coll> = …`, `$lookup` uses `$$$.<coll>.find(…)`, and `$unionWith` uses `$$.push(…)`.

```js
// Lift an embedded sub-document to the top level
jsmql("$ = $.profile;")
// → [{ $replaceWith: "$profile" }]

// Keep only some fields of the document, or drop some. An object method on the
// bare `$` says of ONE document what its `$$` spelling says of every document in
// the stream, so both emit the same `$project`.
jsmql('$ = $.pick(["name", "email"]);')
// → [{ $project: { name: 1, email: 1, _id: 0 } }]
jsmql('$ = $.omit(["passwordHash"]);')
// → [{ $project: { passwordHash: 0 } }]
// A key list the document carries is read at query time — a stage cannot take it,
// so the same `.pick` runs as a value under `$replaceWith`.
jsmql("$ = $.pick($.visibleFields);")
// → [{ $replaceWith: { $arrayToObject: { $filter: { input: { $objectToArray: "$$ROOT" }, as: "jsmqlKv", cond: { $in: ["$$jsmqlKv.k", { $ifNull: ["$visibleFields", []] }] } } } } }]

// Merge fresh fields into the existing root.
// Bare `$` inside the spread is the current document ($$ROOT in MQL).
jsmql("$ = { ...$, computedScore: $.points * 1.1 };")
// → [{ $replaceWith: { $mergeObjects: ["$$ROOT", { computedScore: { $multiply: ["$points", 1.1] } }] } }]

// Replace the doc with a single matched join. A document whose `.find` matched
// nothing has nothing to become and leaves the stream (the `$unwind` drops it).
jsmql("$ = $$$.users.find(u => u._id === $.userId);")
// → [
//     { $lookup: { from: "users", localField: "userId", foreignField: "_id", pipeline: [{ $limit: 1 }], as: "__jsmql.tmp.0" } },
//     { $unwind: "$__jsmql.tmp.0" },
//     { $replaceWith: "$__jsmql.tmp.0" }
//   ]
```

Any other method on bare `$` reads the document as its receiver and stays a `$replaceWith`. For example, `$ = $.mapValues(v => v + 1)` lowers the lodash method over `$$ROOT`.

Bare `$` is a new primary expression: the current document. It plays the role that MQL spells as `"$$ROOT"`, and you can use it anywhere a field path is valid:

```js
jsmql.expr("$mergeObjects($, { x: 1 })")
// → { $mergeObjects: ["$$ROOT", { x: 1 }] }
```

Compile-time rejections (each with an actionable hint):

| RHS | Why it's rejected |
|---|---|
| `$ = []` | An empty array discards every document. Fan out a data-dependent array (`$ = $.items.filter(...)`) to drop documents conditionally, or use `$$ = []` to empty the stream. |
| `$ = [1, 2]`, `$ = ["a"]` | Each fanned-out element becomes a document root, so each element must be a document. Wrap it: `$ = [{ value: ... }]`. |
| `$ = 5`, `$ = "foo"`, `$ = true`, `$ = null` | A scalar is not a document. Wrap it: `$ = { value: ... }`. |
| `$ = undefined` | `undefined` has meaning only in `$match` position. Use `null` for the present-but-null case, or move the comparison into `$match`. |
| `$ = $$$.users.filter(...)` | `.filter()` on a collection is a join that returns an array. Use `.find()` for a single document. |
| `$++`, `$ += 5`, `$--`, `$ *= 2`, etc. | `$` is the whole document, not a scalar. Use `$ = { ...$, ...overrides }` to merge fields. |
| `delete $` | Bare `$` is the whole document. Use `$ = <newDoc>` to replace it, or `delete $.<field>` to drop a single field. |

`$replaceWith` is a **reshape-clearing stage**: any `let` binding declared before it is gone. A later reference produces a precise error: `` `x` is a `let` binding and can't be read after `$replaceWith` — the stage replaces the document. ``

#### Fan-out: one document to many documents

The root takes one document, and the stream takes an array, so the destination shows which you mean. `$$ = <array>` makes the stream from the array's elements: one document per element, per input document. JSMQL refuses `$ = <array>`, and the message names the spelling that takes it.

```js
// Explode each order's line-items into per-item documents
jsmql("$$ = $.lineItems.map(li => ({ orderId: $._id, sku: li.sku }));")
// → $set the $map into a slot, then $unwind + $replaceWith

// Turn a sub-document into one { k, v } document per key
jsmql("$$ = $objectToArray($.scores);")
// → $set the $objectToArray into a slot, then $unwind + $replaceWith

// A stream holds DOCUMENTS, and where a row states what ONE element is, an element
// that is not one is refused. JavaScript's Object.entries gives [key, value] PAIRS:
jsmql("$$ = Object.entries($.scores);")
// → '$$ = …' makes the stream from the array's ELEMENTS, one document each, and these
//   elements are arrays. Put each under a field — '$$ = <array>.map((v) => ({ value: v }));'
//   — or write to a field of the document you have ('$.<field> = <array>;').

// The root is one document, so an array there is refused
jsmql("$ = $.lineItems;")
// → '$ = …' replaces ONE document, and this value is an array. Name the destination
//   that takes an array: '$$ = <array>;' …
```

A **bare field reference is not** provably an array, because a field path carries no compile-time type. So `$ = $.items` stays a single-document `$replaceWith`. To fan a field out, name the stream: `$$ = $.items` and `$$ = [...$.items]` are the same three stages.

A **field path proves nothing about its elements either**, so `$$ = $.items` fans out whatever is there, and the server decides. The refusal above fires only where a row *states* the element kind: `.split()` gives strings, `Object.keys()` gives strings, `Object.entries()` and `.chunk()` give arrays, and `$objectToArray` gives documents. Where nothing is stated, the fan-out stands.

An array LITERAL of documents on the stream is a different operation. `$$ = [{ … }, { … }]` names the stream's documents outright, wherever it stands in the program: it drops every document and unions in the new ones. The fan-out reading belongs to an array that the data decides, with one answer per input document.

**Conditional drop falls out for free.** `$unwind` emits nothing for an empty array. So a fan-out of a possibly-empty array drops exactly the documents whose array came out empty, and fans out the rest.

```js
// Docs with no qualifying item are dropped; the rest fan out per qualifying item
jsmql("$$ = $.items.filter(x => x.qty > 0);")
```

This is the idiomatic way to drop documents conditionally. (To empty the *whole* stream unconditionally, write `$$ = []`.)

#### `$facet` via `$ = { key: <$$ chain>, … }`

When every value in the object literal is a `$$` chain, the same `$ = { … }` surface lowers to a `$facet` stage instead. Each named branch becomes its own sub-pipeline that runs against the parent's input documents. A branch is a `$$.filter(<predicate>)`, a chain of stage calls, or any mix:

```js
jsmql(`$ = {
  topByScore: $$.$sort({ score: -1 }).$limit(10),
  recent:     $$.filter(o => o.createdAt >= "2026-01-01"),
  byStatus:   $$.$group({ _id: $.status, n: $sum(1) }),
};`)
// → [{ $facet: {
//       topByScore: [{ $sort: { score: -1 } }, { $limit: 10 }],
//       recent:     [{ $match: { createdAt: { $gte: "2026-01-01" } } }],
//       byStatus:   [{ $group: { _id: "$status", n: { $sum: 1 } } }]
//   } }]
```

The lambda parameter (`o` in the examples; you choose the name) represents each input document inside the sub-pipeline. An expression body becomes a `$match` stage. A block body becomes the block's stages verbatim.

Rules:

- **Every value must be a chain on `$$`.** Write a `.filter(<lambda>)`, a run of stage calls (`$$.$sort({…}).$limit(10)`), or any mix. A static value (`b: 1`) or a spread (`...rest`) is a compile-time error. Without this check the parser would silently fall through to `$replaceWith`, and that would show a confusing "$$ is statement-only" error inside code generation.
- **A `.filter` / `.reject` branch takes exactly one lambda parameter.** Name the document explicitly, so the error message for a stray `$.<field>` reference can point at the right replacement. A stage-call chain has no lambda.
- **Use `o.<field>`, not `$.<field>`.** Inside a facet sub-pipeline, the lambda parameter IS the current document. Supporting both spellings would only invite drift. JSMQL rejects `$.x` inside the predicate, with a precise hint.
- **`$facet` clears the let scope**, because it replaces the document with `{ facetName: [docs], … }`. A later reference to a `let` binding produces the standard "can't be read after undefined" error.

To filter the current stream as a top-level stage (one `$match`, not split into facets), write `$$.filter(<predicate>);`. This is the bare-stream-chain spelling, and it emits exactly that one `$match`. `$match(<predicate>);` writes the same stage as a stage call. See [Bare-statement stream operations](#bare-statement-stream-operations).

### Replace stream via `$$ = <expr>`

This is the *stream*-level sister of `$ = <expr>`. Assigning to bare `$$` replaces the pipeline's document stream. The trailing `;` below is optional: a lone `$$ = <expr>` is already a Pipeline, per [Output dispatch](#output-dispatch-filter-vs-pipeline). JSMQL accepts two shapes on the right side:

```js
// Narrow the current stream (equivalent to $match($.client === 156 && $.createdAt >= "2026-01-01"))
jsmql(`$$.filter(t => t.client === 156 && t.createdAt >= "2026-01-01");`)
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

The lambda parameter IS the document being matched: write `t.client`, not `$.client`. This follows the same convention as the facet form. JSMQL rejects `$.<field>` inside the predicate of a flat (non-correlated) source-switch, with a "use the lambda parameter" hint. A block-body predicate (`o => { $sort(...); $limit(...); }`) works in the source-switch form, just as it does in a lookup.

A flat source-switch *replaces* the stream: it is a `$unionWith` with no `let:`. So inside the switched-in pipeline, the outer document, the root `$$.size()`, and any outer `let` or `const` are **gone** — only the new collection's own fields (through the lambda parameter) and its own `coll.size()` are available. A reference to the outer context there is an error that points you at the correlated form. For example, an outer `const k` read inside `$$ = $$$.orders.map(o => ({ v: k }))` reports that `k` "isn't available inside `$.<field>` … correlate with a `.filter` instead", and a `$.<field>` read explains that the original root is gone. To keep the outer context, add a correlating `.filter` (below); that lowers to `$lookup` and threads it in.

**Correlated source-switch — per-outer-document pivot via `$lookup`.** When the predicate *does* reference an outer-document field (`$.<field>`), JSMQL auto-rewrites the chain to `$lookup` + `$unwind` + `$replaceWith`. The result is a stream of foreign documents *correlated* to each input: one row per (outer × matching-foreign) pair, with the foreign document as the new root. MongoDB's `$unionWith` has no `let:` slot to thread outer-document context into its sub-pipeline, so this is the only way to express a "per-outer-document source switch" in MQL. JSMQL picks the right lowering family automatically, based on the predicate shape:

```js
// "For each user, pivot the stream onto their orders, top-5 most-recent."
jsmql`$$ = $$$.orders
  .filter({ userId: $._id })
  .toSorted({ placedAt: -1 })
  .take(5);`
// → [
//   { $lookup: {
//       from: "orders",
//       localField: "_id",
//       foreignField: "userId",
//       pipeline: [
//         { $sort: { placedAt: -1 } },
//         { $limit: 5 },
//       ],
//       as: "__jsmql.tmp.0",
//   } },
//   { $unwind: "$__jsmql.tmp.0" },
//   { $replaceWith: "$__jsmql.tmp.0" },
// ]
```

The predicate becomes the `localField` / `foreignField` pair when it is one equality. Otherwise it becomes `let` plus `$match $expr` inside the sub-pipeline. These are the two shapes of the one `$lookup` route (see [Cross-collection lookups](#cross-collection-lookups-collfind--filter)). Either way, the foreign collection's index is used.

The `$unwind` drops outer documents with no matches by default. If you need `preserveNullAndEmptyArrays`, write the explicit `$.matched = $$$.coll.filter(...); $unwind($.matched, true); $ = $.matched` chain instead.

**A `let` binding crosses the source-switch boundary too.** You can reference a name bound with `let foo = …` in the surrounding pipeline directly inside a correlated `.filter` predicate. JSMQL carries it into `$lookup.let` the same way it carries a `$.<field>` reference. Member access on a `let`-bound object also works (for example, `user._id` when `let user = $.user`):

```js
jsmql`
let uid = $.userId;
$$ = $$$.users.filter(u => u._id === uid);
`
// → [
//   { $set: { "__jsmql.var.uid": "$userId" } },
//   { $lookup: { from: "users", localField: "__jsmql.var.uid", foreignField: "_id", as: "__jsmql.tmp.0" } },
//   { $unwind: "$__jsmql.tmp.0" },
//   { $replaceWith: "$__jsmql.tmp.0" },
// ]
```

A mixed predicate works too. A `$.<field>` reference and an outer-`let` reference hoist together into the `$lookup.let` slot of the pipeline-form lookup.

**Putting it all together: narrow, guard, pivot.** The full idiom is three statements. Narrow the current stream down to the matching document or documents, assert that exactly one matched, then pivot to another collection correlated by the root document's field. Every line is JavaScript an app developer already knows; JSMQL lowers the bookkeeping. This is the "look up the logged-in user, then fetch their recent orders" shape that recurs in nearly every web app:

```js
jsmql(`
  $$.filter({ email: "me@example.com" });
  assert($$.size() === 1, "More than one user with such email found");
  $$ = $$$.orders
    .filter({ userId: $._id })
    .toSorted({ placedAt: -1 })
    .take(5);
`);
// → [
//   { $match: { email: "me@example.com" } },
//   { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
//   { $match: { $expr: { $convert: { input: true, to: { $cond: [
//       { $eq: ["$__jsmql.size", 1] }, "bool",
//       "jsmql assertion failed: More than one user with such email found" ] } } } } },
//   { $lookup: {
//       from: "orders",
//       localField: "_id",
//       foreignField: "userId",
//       pipeline: [
//         { $sort: { placedAt: -1 } },
//         { $limit: 5 },
//       ],
//       as: "__jsmql.tmp.0",
//   } },
//   { $unwind: "$__jsmql.tmp.0" },
//   { $replaceWith: "$__jsmql.tmp.0" },
// ]
```

Note the contrast with hand-written MQL. `$unionWith` has no `let:` slot, so a source-switch cannot carry the user's `_id` forward on its own; only `$lookup` can. JSMQL picks the right shape automatically when the foreign predicate references an outer name (here `$._id`, captured as the correlation variable `$$jsmql_f0__id`). The `assert` is a stream-count guard: `$$.size()` materialises through `$setWindowFields`, and a `$convert`-to-bool that errors on the message aborts the run unless exactly one user matched. Each statement stays self-contained and means what JS says it means, and the lowering composes them into one correlated `$lookup`-pivot pipeline. (The final `$replaceWith` drops the whole document, so the scratch `__jsmql` fields need no trailing `$unset`.)

**Empty the stream.** `$$ = []` drops every document. It lowers to `[{ $match: { $expr: false } }]`, a never-matching `$match`. MongoDB rejects `$limit: 0` ("the limit must be positive"), so JSMQL emits the never-matching `$match` instead. The explicit-stage spelling is `$match(false)`.

Compile-time rejections:

| RHS | Why it's rejected |
|---|---|
| `$$ = cond ? A : B` | JSMQL does not support a stream-level ternary. A stream has no single condition that swaps the whole stream for A or B. Narrow with `$$.filter(p)`, or switch source with `$$$.<coll>.filter(p)`. |
| `$$ = $$$.<coll>.find(...)` | `.find(...)` returns a single element in JS, but a pipeline is an array. For "first match", write `.filter(p).slice(0, 1)`. To replace each document with a single matching foreign document, use `$ = $$$.<coll>.find(<predicate>)` (a separate lookup form). |
| `$$ = $$$.<coll>` (no `.filter` and no other chain method) | A bare collection reference needs a predicate (`.filter(o => …)`) or a chained stream method, for example `.slice(0, 10)`. |
| `$$ += …`, `$$++` | `$$` is the stream, not a scalar. |

**Let scope.** The narrow form (`$$.filter(p)`) is just a `$match`, and it preserves any prior `let` binding: a reference resolves to the binding's field as usual. The source-switch form (`$$ = $$$.<coll>.filter(p)`) is **reshape-clearing**: the outer collection's documents are gone after the never-matching `$match`, so any prior `let` becomes unreadable. The next reference produces `` `x` is a `let` binding and can't be read after `$unionWith` … ``.

#### Stream methods chained after the RHS

The right side of `$$ = …` accepts a chainable, JS-array-shaped method after the initial `$$` / `$$$.<coll>` receiver, with or without a leading `.filter(<pred>)`. Each chained method appends one or more stages: to the surrounding pipeline for `$$.<chain>`, or to the `$unionWith.pipeline` body for `$$$.<coll>.<chain>`:

```js
// Skip the first 5 and keep the next 10 — pure $skip + $limit, no $match.
jsmql(`$$.slice(5, 15);`)
// → [{ $skip: 5 }, { $limit: 10 }]

// Filter then take the first 10 — $match + $limit.
jsmql(`$$.filter(o => o.tier === "gold").slice(0, 10);`)
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
| `.concat(...others)` | One or more arguments, with the same shapes as `$$.push(...)`: a spread of `$$$.<coll>[.filter(p)]`, an inline `{...}` document, or `$$$.<coll>.find(p)` (no spread) | One `$unionWith` stage per argument. Consecutive inline documents batch into one `$documents` stage |
| `.map(d => <expr>)` / `.map("field")` | A single-parameter, expression-body arrow (the parameter is the current document: write `d.x`, not `$.x`), **or** the lodash property shorthand `.map("field")`. An embedded `$$$.<coll>.find/filter(...)` lookup works in both stream contexts | `$replaceWith: <expr>`, the chain form of `$ = <expr>`. The shorthand lowers to `$replaceWith: "$field"`. An embedded lookup materialises into a prologue `$lookup` stage ahead of the `$replaceWith`. In the `$$$.<coll>.<chain>` context, the prologue lands inside the outer `$unionWith.pipeline` (a nested `$lookup`, valid MQL) |
| `.sort(<sort>)` / `.toSorted(<sort>)` | A field name (ascending), `["a", "b"]` (all ascending), a `{ field: 1 \| -1 \| "asc" \| "desc" }` spec, or a comparator `(a, b) => a.<f> - b.<f>` (use `\|\|` for a compound key). `.sort` and `.toSorted` mean the same thing on a stream | `$sort: { … }`. JSMQL rejects a zero-argument call, because a stream has no natural document order |
| `.sortBy(<field> \| [fields])` / `.orderBy(keys[, orders])` | The lodash sort aliases. `.sortBy` sorts ascending by one or more keys. `.orderBy` takes parallel keys and directions (`1`/`-1`/`"asc"`/`"desc"`), **or** a `{ field: dir }` object with the directions inline, like `.sort({…})` | `$sort: { … }`. JSMQL rejects `.sortBy({…})`, because an object there is a lodash matches-shorthand, not a direction; the error points you at `.orderBy({…})` |
| `.filter(<predicate>)` | An arrow (`o => …`), a matches-object (`{ active: true }`), a field name (`"active"`), or a `["field", value]` pair. Each spelling is interchangeable, in every position where a `$$` predicate may sit (see the note below) | `$match`, using the index-friendly translator: query syntax where it can, with any residual in `$expr` |
| `.reject(<predicate>)` | The negation of `.filter`: an arrow (`o => …`), a matches-object, a field name, or a `["field", value]` pair | `$match: { $expr: { $not: … } }` (the `$expr` form, never a query-form De Morgan) |
| `.pick([fields])` / `.omit([fields])` | The lodash object methods, applied per document. `.pick` keeps only the named fields and drops `_id` unless you name it. `.omit` drops the named fields | `$project` (inclusion / exclusion) |
| `.takeWhile(<pred>)` / `.dropWhile(<pred>)` | The leading run where the predicate holds (`takeWhile`), or everything from the first failure on (`dropWhile`). It accepts the same predicate spellings as `.filter`. **A sort must come first**, in any spelling (`.sort` / `.toSorted` / `.sortBy` / `.orderBy` / `.$sort({…})`). With no sort, JSMQL rejects the call rather than default to `_id` | A `$setWindowFields` stage that carries a running "has it failed yet" flag, then a `$match` on that flag (`0` keeps, `1` drops). The two methods are exact complements |
| `.tail()` | Zero arguments: all but the first document | `$skip: 1` |
| `.shuffle()` | Zero arguments: random document order (non-deterministic, like `.sample`) | `$addFields` a `$rand` key · `$sort` by it · `$unset` it |
| `.take(n)` / `.drop(n)` | One non-negative integer literal | `.take(n)` lowers to `$limit: n` (`take(0)` lowers to an always-false `$match`, because `$limit: 0` is invalid). `.drop(n)` lowers to `$skip: n` (`drop(0)` is identity: it emits no stage) |
| `.sampleSize(n)` | One integer literal ≥ 1 | `$sample: { size: n }` |
| `.sample()` | Zero arguments | `$sample: { size: 1 }`: one random document (lodash `_.sample`). Use `.sampleSize(n)` for more |
| `.flatMap(<key>)` | One field key: the array field to flatten | One `$unwind: "$<path>"` stage. From here on **the element is what every callback receives**: `.filter(i => i.qty > 1)` reads `items.qty`, a key-less `.countBy()` groups on the element, and `.sortBy("price")` sorts by `items.price`. The documents keep their other fields, as MQL's `$unwind` does. For "the elements as the documents", chain `.map(item => item)`. JSMQL rejects a complex arrow body (`.flatMap(d => d.items.map(...))`). See [The element after `.flatMap`](#the-element-after-flatmap) |
| `.groupBy(<key>)` / `.groupBy()` / `.groupBy({ _id, … })` | One field key, or none for the element itself, **or** a raw `$group` body object. The body object must contain `_id`; an accumulator operator such as `$addToSet` is allowed in a field slot | The key form collapses to the lodash object `{ <key>: [docs] }`, like value-mode `$.arr.groupBy(...)`. The body form lowers to `$group: <body>` verbatim: a stream of group documents. The accumulator form has no lodash equivalent |
| `.countBy(<key>)` / `.countBy()` | One field key, or none, in which case the element itself is the key (lodash's identity default, the natural spelling after `.flatMap`) | Collapses to the lodash object `{ <key>: <count> }`, like value-mode `$.arr.countBy(...)`. For the count-descending `{ _id, count }` stream, write the `$sortByCount("$field")` stage directly |
| `.keyBy(<key>)` / `.keyBy()` | One field key, or none for the element itself | Collapses to the lodash object `{ <key>: <last doc> }`, like value-mode `$.arr.keyBy(...)`; the last document wins. "Last" follows the current order, so precede it with `.sort(...)` when the order matters |
| `.uniqBy(<key>)` | One field key | `$group` keeps the first document per key, then `$replaceWith`. "First" follows the current order, so precede it with `.sort(...)` when the order matters |
| `.uniq()` | None | `$group` keyed on the element (the whole document, or the unwound field after `.flatMap`), then `$replaceWith`: one document per distinct element |
| `.difference(list)` / `.without(...values)` | **After `.flatMap`** — the values to drop. JSMQL reads a missing `list` as empty, as lodash does | A `$match` on the element: `{ $nor: [{ <el>: { $in: [...] } }] }` for a constant list, or `{ $expr: { $not: { $in: ["$<el>", { $ifNull: [<list>, []] }] } } }` for a variable one. JSMQL refuses it on a stream of whole documents; unwind the field first |
| `.intersection(list)` | **After `.flatMap`** — the values to keep | A `$match: { <el>: { $in: [...] } }`, then the `.uniq()` group, because lodash keeps each value once |
| `.differenceBy(list, key)` / `.intersectionBy(list, key)` | **After `.flatMap`** — a list and an iteratee (`"sku"`, `i => i.sku`, a matcher) | `$match: { $expr: { $not: { $in: [<key of the element>, <the list's keys>] } } }`. Use `$in` for intersection, then the `.uniq()` group on the key |
| `.compact()` | **After `.flatMap`**, no arguments: drop the falsy values | `$match: { <el>: { $nin: [null, 0, false, ""] } }`. `null` in the list also drops a missing value |
| `.flat()` | **After `.flatMap`**, when the element is itself an array | one more `$unwind: "$<el>"` |
| `.sortBy()` / `.sort()` / `.toSorted()` with no argument | **After `.flatMap`** — the natural order of the values | `$sort: { <el>: 1 }`. On a stream of whole documents, JSMQL requires a key |
| `.sortedUniq()` / `.sortedUniqBy(<key>)` | As `.uniq` / `.uniqBy` | Aliases for `.uniq` / `.uniqBy`: `$group` needs no sorted input, so lodash's sorted-input precondition has nothing to express in MQL |

`.filter(<pred>)` can appear **anywhere** in the chain, not only as the head. So `.flatMap("items").filter(o => o.qty > 0)` composes.

#### Callback spellings

**How you spell a callback never changes the MQL.** A lodash shorthand works the same on a stream as on an array value, and each shorthand is exactly its longhand:

| Slot | Write any of these | They all mean |
|---|---|---|
| **Sort key** — `.sortBy` `.orderBy` | `"cat"` · `d => d.cat` · `d => d.cat.toLowerCase()` | order by that value |
| **Group key** — `.groupBy` `.countBy` `.keyBy` `.uniqBy` | the above, **plus** `{ cat: "a" }` · `["cat", "a"]` | group on that value |
| **Unwind path** — `.flatMap` | `"items"` · `d => d.items` | the `items` array field |
| **Predicate** — `.find` `.filter` `.reject` (and `.map`'s iteratee) | `o => o.cat === "a"` · `{ cat: "a" }` · `["cat", "a"]` · `"active"` (truthy test) | match on `cat` |

```js
$.n = $$$.orders.filter({ userId: $._id }).size();   // ≡ .filter(o => o.userId === $._id)
// → [{ $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "__jsmql.tmp.0" } },
//    { $set: { n: { $size: "$__jsmql.tmp.0" } } }, { $unset: "__jsmql" }]  — the same $lookup either way
```

**A group key may be computed.** MongoDB evaluates `$group._id` per document, so all four grouping methods take any expression. It lowers straight into the key, with no extra stage:

```js
$$.countBy(d => d.category.toLowerCase());
// → [{ $group: { _id: { $toLower: "$category" }, … } }, … ]

$$.groupBy(d => d.email.split("@")[1]);   // group by email domain
$$.countBy({ active: true });             // count matching vs not (lodash _.matches)
```

**A sort key may be computed too**, but a `$sort` key must be a literal field path. So JSMQL puts the value in a scratch field first, then clears it once the chain finishes:

```js
$$.sortBy(d => d.category.toLowerCase());
// → [{ $addFields: { "__jsmql.tmp.0": { $toLower: "$category" } } },
//    { $sort: { "__jsmql.tmp.0": 1 } },
//    { $unset: "__jsmql" }]
```

The scratch field is cleared once the chain finishes, so it never reaches your output.

**`.flatMap` is the exception**: it takes only a field path. `$unwind` puts each element back into a *named* field, so which field it is is part of what you mean. JSMQL cannot pick one for you:

```js
$.allTags = $.tags.concat($.extraTags);
$$.flatMap("allTags");
```

#### The element after `.flatMap`

In JavaScript, `orders.flatMap(o => o.items)` is a list of **items**, and every method after it works on an item. The stream reads the same way. After `.flatMap("items")`, each callback's parameter is the element, the unwound field. Its fields are paths under that field, a lodash shorthand names the element's fields, a comparator on the whole element sorts by the field, and a key-less `.countBy()` / `.groupBy()` / `.keyBy()` groups on the element:

```js
$$.flatMap("items").filter(i => i.qty > 1).sortBy("price").uniq().pick(["sku"]);
// → [ { $unwind: "$items" },
//     { $match: { "items.qty": { $gt: 1 } } },
//     { $sort: { "items.price": 1 } },
//     { $group: { _id: "$items", __jsmqlTmp: { $first: "$$ROOT" } } }, { $replaceWith: "$__jsmqlTmp" },
//     { $project: { "items.sku": 1, _id: 0 } } ]

$$.flatMap("productIds").filter(p => !$.owned.has(p)).countBy();   // { <productId>: count }
// → [ { $unwind: "$productIds" }, { $match: … }, { $group: { _id: "$productIds", … } }, … ]
```

The lodash set methods, `.compact()`, `.flat()`, and the key-less sorts work on the element too, and only there. A whole document is never falsy, never nested, and has no natural order:

```js
$$.flatMap("ids").difference([1, 2]);
// → [{ $unwind: "$ids" }, { $match: { $nor: [{ ids: { $in: [1, 2] } }] } }]
```

```js
$$.flatMap("ids").intersection([1, 2]);
// → [{ $unwind: "$ids" }, { $match: { ids: { $in: [1, 2] } } }, { $group: { _id: "$ids", __jsmqlTmp: { $first: "$$ROOT" } } }, { $replaceWith: "$__jsmqlTmp" }]
```

```js
$$.flatMap("ids").compact().sortBy();
// → [{ $unwind: "$ids" }, { $match: { ids: { $nin: [null, 0, false, ""] } } }, { $sort: { ids: 1 } }]
```

```js
$$.flatMap("matrix").flat();
// → [{ $unwind: "$matrix" }, { $unwind: "$matrix" }]
```

```js
$$.flatMap("items").differenceBy([{ sku: "a" }], "sku");
// → [{ $unwind: "$items" }, { $match: { $expr: { $not: { $in: ["$items.sku", ["a"]] } } } }]
```

```js
$$.difference([1, 2]);
// → error: '.difference()' isn't available on '$$' — compares each ELEMENT against a second array, and every element of this stream is a whole document. Unwind the field first — '.flatMap("<field>").difference(<list>)' — or drop documents with '.reject(<pred>)'.
```

In a join, the same link on a stream of whole documents is not a stream link. It reads the joined array as a value — `$$$.orders.filter(p).difference(docs)` is lodash's `$filter` over the array — like any method with no stream form.

The **documents** stay MongoDB's: `$unwind` keeps every other field, so the stream still carries one order per line, with `items` holding that line. To make the elements the documents, say so: `.map(item => item)` is `{ $replaceWith: "$items" }`. From that stage on, the document is the element again, as it is after any stage that replaces the document (`$group`, `$project`, `.map`). The raw stage spelling `$$.$unwind("$items")` is MQL and changes nothing else: a callback after it still receives the whole document.

In a **value** position the chain is JavaScript's value. `$$$.orders.flatMap("items")` is the items themselves: the `$lookup` holds one order per line, and the value reads the line off each. So `.size()` counts lines (`{ $size: "$<the joined array>" }`, one joined document per line, so nothing is picked out first), `[0]` is a line, and `$$$.orders.flatMap("items").find(i => i.sku === $.sku)` is one item.

On three methods, an object means something richer than a matcher, so JSMQL reads it that way: `.orderBy({ field: -1 })` and `.sort`/`.toSorted({ field: -1 })` are direction specs, and `.groupBy({ _id, … })` is a raw `$group` body.

`.map(d => …)` / `.map("field")` replaces each document with the body through `$replaceWith`, so the **body must resolve to a document**, because MongoDB requires an object root. JSMQL rejects a provably non-document body at compile time — `.map(d => 5)`, `.map(d => "x")`, `.map(d => [1, 2])`. A field reference that turns out to be a scalar at runtime, for example `.map("userId")` where `userId` is an ObjectId, is emitted but errors on the server, exactly like `$ = $.userId`. To keep a single value, wrap it in a document: `.map(d => ({ value: d.x }))`. Use `.map("subdoc")` only to promote a sub-document to the root.

The methods that count **from the end** (`.takeRight(n)`, `.dropRight(n)`, `.initial()`, `.toReversed()`) are also deliberately not on this list. A MongoDB stream has no order except the one a `$sort` gives it, and no stage reverses one (`$reverseArray` is an *expression*, for an array inside a document). So "the last 3" has nothing to count back from. Say the order you want, and take from the **front**:

```js
$$.toSorted({ createdAt: -1 }).take(3);   // the 3 most recent
```

All four still work in value position on a real array (`$.items.takeRight(3)` → `$slice`, `$.items.toReversed()` → `$reverseArray`). There, the array carries its own order, and each method means exactly what it means in JS.

The methods that return a single element in JS (`.find(p)`, `.findLast(p)`, `.at(n)`) are deliberately not on this list. A pipeline is an array, and chaining a single-element method would mislead. Use `.filter(p).take(1)` or `.slice(n, n + 1)` instead. (`$$$.<coll>.find(<pred>)` is unrelated: that is a lookup-context shape, not a stream chain. See [`$$$.<coll>.find / .filter`](#cross-collection-lookups-collfind--filter).)

**A predicate is a predicate, wherever it sits.** `$$.filter(...)` / `$$.reject(...)` accept the same four spellings in every position where a `$$` predicate can appear: narrowing the current stream (`$$.filter(p)`), a `$facet` branch (`$ = { k: $$.filter(p) }`), and an `$out` write chain (`$$$.archive = $$.filter(p)`). Each spelling emits identical MQL, so picking one is purely a matter of taste:

```js
jsmql(`$$$.archive = $$.filter({ status: "expired" });`)
jsmql(`$$$.archive = $$.filter(["status", "expired"]);`)
jsmql(`$$$.archive = $$.filter(o => o.status === "expired");`)
// all three → [{ $match: { status: "expired" } }, { $out: "archive" }]
```

The one thing a predicate may not do in these positions is reference `$.<field>`. The parameter already *is* the current document, so `o.status` is the spelling. (Inside a `$$$.<coll>` lookup predicate, `$.<field>` means the *outer* document and JSMQL auto-extracts it into `let` — a different position, a different rule.)

A worked lodash-style chain: the newest 10 closed orders' distinct products:

```js
jsmql(`$$.filter({ status: "CLOSED" })
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

Every stream method works this way, for example `.filter`, `.map`, `.toSorted`. Chaining and splitting are interchangeable: these three forms all produce the same MQL:

```js
$$.filter(p).map(f);        // chained
$$.filter(p); $$.map(f);    // split across statements
$$.filter(p).map(f);   // explicit assignment
```

This also holds for chained stage calls, so a chain may mix them freely: `$$.filter(p).$sort({ score: -1 }).take(3);` and `$$.filter(p); $sort({ score: -1 }); $limit(3);` are the same pipeline.

> **Note.** In plain JS, `arr.filter(...)` as a bare statement throws away the result. In a JSMQL pipeline, a bare `$$.filter(...)` statement *transforms the running stream*: each statement is a stage. (This follows the same idea as `$$.push(...)`.) The bare `$$` receiver is required. For a source-switch, keep the explicit `$$ = $$$.<coll>.<chain>;` head.

**`.reduce` is not a chain method either.** What a reducer returns in JS decides how you assign it. A reducer that returns a **scalar or object** (one value) must be **wrapped** into a stream-shaped right side. A reducer that returns an **array** is already a stream and is assigned directly (see the array-returning form below). Both scalar/object wraps lower to the same `$group` + `$replaceWith` pair. Pick whichever reads best at the call site:

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

Both forms support the same per-key reducer bodies: `acc + d.<field>` (or `acc.<key> + d.<field>` in the object form) lowers to `$sum`; `acc + 1` lowers to `$sum: 1` (count); `Math.max(acc, d.<field>)` lowers to `$max`; `Math.min(acc, d.<field>)` lowers to `$min`. In the object form, each entry must reference `acc.<sameKey>` as the accumulator side, and the init object must declare the same key set as the body. An extra or missing key on either side throws — in JS this would silently work, but it would mean something different.

The `init` value is required for JS faithfulness, but the MQL accumulators have their own neutral elements, so its actual value does not matter. Dictionary-build reducers (`(acc, d) => ({...acc, [d.k]: d.v})`) and other richer body shapes are future work.

**Array-returning reducer** — for "flatten the stream by projecting each document to a sub-document, optionally filtered". A reducer seeded with `[]` already returns an array, a stream, so you assign it **directly**, without the surrounding `[ ]`:

```js
// Filter active users with an email, project to their contactDetails sub-doc.
jsmql(`$$.reduce(
  (acc, d) => (d.active && d.contactDetails.email ? acc.concat(d.contactDetails) : acc),
  []
);`)
// → [{ $match: <translated condition> }, { $replaceWith: "$contactDetails" }]

// Unconditional projection (just the map).
jsmql(`$$.reduce((acc, d) => acc.concat(d.contactDetails), []);`)
// → [{ $replaceWith: "$contactDetails" }]
```

This form lowers to `$match` (when the body is a `cond ? acc.concat(...) : acc` ternary) plus `$replaceWith` (when the projection is a field path on `d`). It is equivalent to `$$.filter(d => cond).map(d => d.<field>)` written as a single reducer; pick whichever reads better at the call site. The init must be `[]`, and the body must be either `acc.concat(d.<path>)` or a ternary whose alternate branch is bare `acc`. JSMQL does not recognise a spread-form variant (`[...acc, d.<x>]`, a multi-element wrapper).

JSMQL **rejects** wrapping it in `[ ]` (`$$ = [$$.reduce(…, [])]`), because that would make a stream whose single document is itself an array. (The scalar and object reducer wraps above keep their `[ ]`, because those reducers return a single document, so `[ <doc> ]` is a legitimate one-document stream literal.)

---

## Pipelines

`jsmql()` also compiles **whole aggregation pipelines**. The same function detects pipeline mode from the input, and returns an `object[]` instead of a single `object`. There is no new export and no separate API.

### Canonical form: `;` between stages

Write each stage as a top-level statement separated by `;`. Any `;` at the top level, including a single trailing `;`, flips `jsmql()` into pipeline mode. Inside one `;`-separated chunk, `,` keeps its in-stage role for update ops:

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
//     { $match: { $expr: <$.active is the JavaScript truthiness test> } },
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

- **`;` is a hard stage boundary.** Adjacent update ops across `;` do **not** coalesce. `$.a = 1; $.b = 2` produces two `$set` stages. Use `,` for a single coalesced stage.
- **A trailing `;` is enough.** `$.a = 1;` returns `[{ $set: { a: 1 } }]`. `$.a = 1` (no `;`) returns `{ $set: { a: 1 } }`. Pick the form that matches what you want from MongoDB: a stage object or a pipeline array.

Each stage body is an ordinary JSMQL expression. Arithmetic, an accumulator, a field reference, and a method chain all work as they do anywhere else.

### Chained form: `.$stage(...)` on a stream

You can also write a stage as a **chain link** on a stream: `$$` (the current
collection) or `$$$.<coll>` (another one). It means exactly what the statement form means:

```js
jsmql("$$.$match({ status: 'shipped' }).$sort({ total: -1 }).$limit(5);");
// → [{ $match: { status: "shipped" } }, { $sort: { total: -1 } }, { $limit: 5 }]

// …identical to writing the same three stages as statements:
jsmql("$match({ status: 'shipped' }); $sort({ total: -1 }); $limit(5);");
```

**Two spellings, no winner.** Where a stage has a JavaScript equivalent, both compile to the
same thing. Pick whichever reads better for the query at hand:

```js
jsmql("$$.filter({ a: 1 }).take(5);");     // → [{ $match: { a: 1 } }, { $limit: 5 }]
jsmql("$$.$match({ a: 1 }).$limit(5);");   // → [{ $match: { a: 1 } }, { $limit: 5 }]
```

They interleave freely, so a chain can use each spelling where it reads clearest:

```js
jsmql("$$.filter(p => p.score > 0).$sort({ score: -1 }).take(10);");
// → [{ $match: { score: { $gt: 0 } } }, { $sort: { score: -1 } }, { $limit: 10 }]
```

This earns its keep in a **value position**, where you cannot drop into statements.
`$group`, `$unwind`, `$setWindowFields`, `$bucket`, and similar stages have no JavaScript
spelling, so a chain could never reach them otherwise:

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

The name after the `.` must be a real aggregation stage; JSMQL invents none. It takes
exactly one argument: its body. Two things may surprise you:

- **A stage chains only while the chain is still a stream.** A stage runs *inside* the
  pipeline. Once a link turns the chain into a **value** — `.map("<field>")` (extracting a
  field, not reshaping a document), `.flatten()`, `.uniq()`, `.sum()`, `.head()`, and the
  other value terminals — everything after it is ordinary array/value work, and a stage
  there has nothing to run in. Put the stages first:

  ```js
  $.x = $$$.c.$match({ a: 1 }).$limit(5).map("f");   // ✅ stages, then values
  $.x = $$$.c.$match({ a: 1 }).map("f").$limit(5);   // ❌ '.$limit(...)' is a pipeline stage,
                                                     //    but its receiver here is a value
  ```

  JSMQL rejects `$.items.$match(...)` for the same reason: an in-document array was never a
  stream. Use the array method `.filter(...)`.
- **JSMQL rewrites a correlated `$match` for you.** In a `$$$.<coll>` chain, `$.` reads the
  *outer* document. MongoDB would not evaluate that in a `$match` object body, because the
  query language ignores variables, so the match would silently return nothing. JSMQL
  re-expresses the body as a predicate instead: exactly what `.filter({ … })` does. A term
  that does not read the outer document stays in index-friendly query form:

  ```js
  $.orders = $$$.orders.$match({ userId: $._id, status: "shipped" });
  // → { $lookup: { from: "orders", let: { jsmql_f0__id: "$_id" },
  //                pipeline: [{ $match: { status: "shipped",
  //                                       $expr: { $eq: ["$userId", "$$jsmql_f0__id"] } } }], as: … } }
  ```

### Alternative: bracketed array literal

When you want JSMQL to *evaluate to* a pipeline array, rather than statements that build one, wrap the same stage calls in a `[…]` literal. You can write a stage as a call expression or as a MongoDB-shaped stage object; both compile identically, and you may mix them in one array.

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

Use the bracketed form when you paste MQL from MongoDB Compass or the manual, because the stage-object shape lets you copy it verbatim, or when a build step needs the literal array as a value. For a new pipeline, prefer the `;`-separated form above. It reads as JavaScript end-to-end, and it stays consistent with the update op, `let`-binding, and block-body-arrow forms.

### `$match` indexes by default

In real MongoDB, the body of `$match` can be either a *query document* (`{ field: value }`) or an *aggregation expression* (`$expr: { ... }`). The two look interchangeable, but they are not: **`$expr` disables index use**. A naïve translation of `$.email === "alice"` into an `$expr` wrapper turns every match into a collection scan.

JSMQL translates the index-safe subset of expressions — a field-versus-literal comparison combined with `&&` and `||` — into the query-document form, so an index still works. Anything outside that subset (a computed value, a method call, a field-to-field comparison) stays in `$expr`. When part of the predicate is translatable and part is not, you get both: the indexable part as a query document, and the rest in `$expr` on the same `$match`.

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
// → [{ $match: { $expr: { $eq: [{ $cond: { if: { $eq: [{ $ifNull: ["$name", null] }, null] }, then: null, else: { $toLower: "$name" } } }, "alice"] } } }]

// Object-literal body is passed through unchanged (also the escape hatch)
jsmql("[{ $match: { age: { $gt: 18 } } }]");
// → [{ $match: { age: { $gt: 18 } } }]
```

**Index-friendly JS patterns that translate to MongoDB query operators.** Several common JS shapes have a direct query-language equivalent. The translator recognises them and emits the indexable form:

```js
// Array-element / set-membership tests
jsmql(`[{ $match: $.tags.has("vip") }]`);
// → [{ $match: { tags: "vip" } }]                          // implicit array-element match
jsmql(`[{ $match: ["active", "trial"].has($.status) }]`);
// → [{ $match: { status: { $in: ["active", "trial"] } } }]
jsmql(`[{ $match: $.tags.has("a") && $.tags.has("b") }]`);
// → [{ $match: { tags: { $all: ["a", "b"] } } }]           // folded $all

// Regex match — receiver field, regex-literal arg
jsmql(`[{ $match: $.name.match(/^a/i) }]`);
// → [{ $match: { name: { $regex: /^a/i } } }]

// Half-open range — field receiver, constant bounds
jsmql(`[{ $match: $.age.inRange(18, 65) }]`);
// → [{ $match: { age: { $gte: 18, $lt: 65 } } }]
//   The bounds order at compile time, so `.inRange(65, 18)` is the same clause.
//   A bound read at run time keeps the `$min`/`$max` expression under `$expr`.

// Nested-array predicate
jsmql(`[{ $match: $.items.some(it => it.qty > 5 && it.tag === "vip") }]`);
// → [{ $match: { items: { $elemMatch: { qty: { $gt: 5 }, tag: "vip" } } } }]

// Existence / type / size / modulo
jsmql(`[{ $match: $.deletedAt === undefined }]`);
// → [{ $match: { deletedAt: { $exists: false } } }]
jsmql.expr(`$.deletedAt === undefined`);
// → { $eq: [{ $type: "$deletedAt" }, "missing"] }         // the same test, outside $match
jsmql(`[{ $match: typeof $.x === "bool" }]`);
// → [{ $match: { x: { $type: "bool" } } }]                 // a 'typeof' comparison names a BSON type
// → "boolean" is refused, with 'bool' named — see "typeof" under Operators
jsmql(`[{ $match: $.items.size() === 3 }]`);
// → [{ $match: { $expr: { $eq: [{ $size: { $ifNull: ["$items", []] } }, 3] } } }]
//   `.size()` is the element count of an array, and a missing array counts as empty. A count has
//   no query form, so it takes `$expr`. To read a field literally named `size`, write `$["items.size"]`.
jsmql(`[{ $match: $.x % 5 === 0 }]`);
// → [{ $match: { x: { $mod: [5, 0] } } }]
```

`.has(<literal>)` on a field receiver emits the bare `{ field: value }` shape in `$match` position, which matches an array that contains the value or a scalar equality. `.includes(<literal>)` emits `{ field: { $regex: /value/ } }`, the substring test.

**Known semantic divergences.** Query-language equality differs from aggregation `$eq` in three ways: array fields (query mode matches an array element), `$ne` with a missing field (the `!== <value>` shape excludes a missing document), and field-to-field comparison (JSMQL does not do this; it stays in `$expr`). For null/missing handling, `===` / `!==` and `==` / `!=` translate to two distinct index-friendly shapes. See the [strict vs loose null table](#---vs-----null-and-missing-fields).

```js
// Strict — only explicit null matches; missing fields excluded
jsmql("[{ $match: $.deletedAt === null }]");
// → [{ $match: { deletedAt: { $type: "null" } } }]

// Loose — both null AND missing match
jsmql("[{ $match: $.deletedAt == null }]");
// → [{ $match: { deletedAt: null } }]
```

The full rule table and divergence reference live in [docs/specs/emit-pass.md](specs/emit-pass.md).

### Local bindings (`let`)

A pipeline can introduce a **named local helper** with `let`. Each binding is scoped to the rest of the pipeline. The compiler materialises it under a single compiler-owned namespace (`__jsmql.var.<name>`) and emits one cleanup `$unset` at the end.

A `let` binding is **reassignable**: a later `name = …` re-`$set`s it, just like JavaScript. Each reassignment is its own `$set` stage, because a read-after-write needs a separate stage:

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

A `,` continues the declaration, exactly as it does in JavaScript, and a later declarator reads the ones before it:

```js
jsmql`
  const start = new Date("2026-08-01"), end = start.plus(1, "month");
  $.t.inRange(start, end);
`;
// → { t: { $gte: new Date("2026-08-01T00:00:00.000Z"),
//          $lt:  new Date("2026-09-01T00:00:00.000Z") } }
```

**The `,` shares a stage; the `;` starts a new one.** This is the same rule writes follow (`$.a = 1, $.b = 2` is one `$set`, `$.a = 1; $.b = 2;` is two):

```js
jsmql`
  let a = $.p, b = $.q;
  $match(a > b);
`;
// → [
//   { $set: { "__jsmql.var.a": "$p", "__jsmql.var.b": "$q" } },
//   { $match: { $expr: { $gt: ["$__jsmql.var.a", "$__jsmql.var.b"] } } },
//   { $unset: "__jsmql" },
// ]
```

A declarator that reads one bound beside it starts the next stage, because a `$set` reads every field from the document that **enters** it. Nothing else breaks the run — below, `c` reads neither `a` nor `b`, so it joins `b`:

```js
jsmql`
  let a = $.x, b = a + 1, c = $.y;
  $.o = b + c;
`;
// → [
//   { $set: { "__jsmql.var.a": "$x" } },
//   { $set: { "__jsmql.var.b": { $add: ["$__jsmql.var.a", 1] }, "__jsmql.var.c": "$y" } },
//   { $set: { o: { $add: ["$__jsmql.var.b", "$__jsmql.var.c"] } } },
//   { $unset: "__jsmql" },
// ]
```

Both declarators of the date example above are constants, so both fold at compile time and neither emits a stage at all.

A declarator whose value is an arrow is a [reusable function](#reusable-functions), in a list as anywhere else. Every declarator needs a value, because MQL has no `undefined` to bind. So `let x;` is an error that names `let x = <expr>`.

Inside a block-body arrow the same rule binds `$let` variables instead of document fields, because `$let` also reads every variable from the enclosing scope:

```js
jsmql.expr`$.i.map((v) => { const d = v * 2, e = v + 1; return d + e; })`;
// → { $map: { input: "$i", as: "v", in: { $let: { vars: { d: { $multiply: ["$$v", 2] }, e: { $add: ["$$v", 1] } }, in: { $add: ["$$d", "$$e"] } } } } }
```

Why use `let` instead of `$.tmp = …; … ; delete $.tmp`:

- Each derived value sits on its own line, a natural spot for a one-line `// …` comment.
- No collision risk: even when your document has a real field named `subtotal`, the let lives under `__jsmql.var.subtotal` and never touches it.
- No forgotten cleanup: the compiler appends the `$unset` automatically.
- `subtotal` (a bare identifier) at a call site reads visually distinct from `$.subtotal` (a real document field).

**Scope rules.** A let is visible from its declaration to the end of the pipeline, with one exception: a stage that *replaces* the document drops the let, because the field that carries it is gone. Which stages do this is a fact on each row of [`src/registry/names.ts`](../src/registry/names.ts) (the `document` effect); `$group` is the one every pipeline meets. Referring to a let after one of them is a compile-time error:

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

`$project` clears the scope in **inclusion** mode only. Naming the fields to keep drops `__jsmql` with the rest, so a later let read gives the same compile-time error that `$group` gives. An expression-mode projection (`{ x: $.y + 1 }`) and an exclusion-mode projection (`{ a: 0 }`) preserve the document, and the let survives them. The row states this as `document: "projection"`.

**Indexing pitfall.** A let materialises through `$addFields` / `$set`. A `$match` on a let-bound value cannot use an index, and the optimiser cannot push that `$match` past the `$set` that produced the field. Place an index-eligible `$match` on a real document field **before** your `let` binding:

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

**Sub-pipelines.** An outer let is not visible inside `$lookup.pipeline`, `$unionWith.pipeline`, or a `$facet.*` branch. Each sub-pipeline can declare its own lets independently; they live inside that sub-pipeline only.

**Not the same as `$let`.** MongoDB's `$let` operator is *expression-scoped*: the binding lives inside one `in:` clause. JSMQL's `let` is *pipeline-scoped*. They are different constructs that happen to share a name.

### Compile-time constants (folding)

When the right side of a `const` / `let` is a **compile-time constant** — a value that does not depend on the document or the environment — JSMQL evaluates it once at compile time and **inlines the value** everywhere it names it. There is no `$set` stage, no `__jsmql` namespace, and no `$unset`. Because the declaration emits no stage, a preamble of constants does not force Pipeline mode. So a constant plus a predicate compiles to a clean, indexable **Filter**:

```js
jsmql("const userId = 0x507f1f77bcf86cd799439011; $.userId === userId");
// → { userId: new ObjectId("507f1f77bcf86cd799439011") }

jsmql("const msInDay = 24 * 60 * 60 * 1000; $.elapsedMs > msInDay");
// → { elapsedMs: { $gt: 86400000 } }
```

A "compile-time constant" is any pure, deterministic expression over literals and earlier constants: arithmetic, `new Date("2020-01-01")` and the date methods on it, an ObjectId literal and its `.toString()`, an array or object literal, a constant computed key (`{ [k]: 1 }`), and (see the method sections) a string or array transform. A binding whose right side reads the document (`$.x`), the clock (`new Date()`), or the RNG (`Math.random()`) is **not** constant, so it keeps the runtime `$set` binding described above. So a constant folds the same way in every entry point — a Filter, a pipeline stage, an expression — including per call in [`jsmql.compile`](#parameterised-queries-jsmqlcompile), where a constant built from a parameter folds against each call's arguments.

A folded value is what the **server** would compute, not what JavaScript computes, where the two differ. A month added to 31 January lands on the last day of February, as `$dateAdd` does. `.startOf("week")` gives the Sunday, as `$dateTrunc` does. `.diff(other, "day")` counts the midnights crossed, as `$dateDiff` does. So a date range built from constants is two literal dates, and the `$match` can use the index on the field:

```js
jsmql(`const start = new Date("2026-09-01");
       const end = start.plus(1, "month");
       $.createdAt >= start && $.createdAt < end`);
// → { createdAt: { $gte: new Date("2026-09-01T00:00:00.000Z"), $lt: new Date("2026-10-01T00:00:00.000Z") } }

jsmql('const monthStart = new Date("2026-09-15").startOf("month"); $match({ day: monthStart.format("%Y-%m-%d") })');
// → [{ $match: { day: "2026-09-01" } }]
```

JSMQL does **not** fold a date method called with a `timezone` or another option (`.plus(1, "month", "Europe/Kyiv")`, `.startOf("week", { startOfWeek: "monday" })`). A named zone shifts with daylight saving, and that table belongs to the server, so it stays the aggregation operator. `String(n)` and a `${n}` template slot fold for an integer, because both sides write `"42"`. A fraction or a number of sixteen or more digits stays `$toString`, because the two spell an exponent differently. `Number("42")` never folds: `$toDouble` yields a double on the server, where a written `42` is an int.

> A constant expression that JSMQL cannot represent as a MongoDB literal — for example, one that evaluates to `Infinity` or `NaN` (`1 / 0`) — is a compile-time error, not silently broken MQL.

### Sub-pipelines

`$lookup`, `$unionWith`, and `$facet` carry a nested pipeline inside their stage body. JSMQL recognises these positions and recurses, so the `$match` translation rule and the strict typo check apply uniformly:

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

Pipeline mode starts two ways:

- **`;`-separated form.** Any top-level `;` flips `jsmql()` into pipeline mode. Every statement must be a recognised stage call, an update op, or a `let` binding.
- **Bracketed form.** A top-level array enters pipeline mode when its first element looks like a stage attempt: a single-`$<name>`-key object literal, or a `$<name>(...)` call. Once pipeline mode is active, every element must be a recognised stage.

Either way, a mistake surfaces immediately, with a Levenshtein-based suggestion:

```js
jsmql("[{ $macth: $.age > 18 }]");
// → CodegenError: Element 0 of pipeline: '$macth' is not a known
//                 aggregation stage. Did you mean '$match'?
```

A plain value array like `[1, 2, 3]` is *not* a pipeline. The first element does not look like a stage attempt, so JSMQL leaves it as a literal array expression.

### Which stages does JSMQL support?

JSMQL supports every stage that the pinned MongoDB aggregation spec defines: one row per stage in [`src/registry/names.ts`](../src/registry/names.ts), which is the live list. JSMQL refuses a name that is not one of them, and names the nearest match (`$grpup` → "Did you mean '$group'?").

---

## Function Form

`jsmql()` and `jsmql.validate()` accept a string, or a **function** whose body is the expression. The function is an arrow `({ $ }) => …` or a `function` keyword form (`function ({ $ }) { return … }`). The runtime calls `Function.prototype.toString()`, extracts the body, and runs it through the same parser as the string form:

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

**Why use it.** A JavaScript formatter (prettier, oxfmt) treats template-literal contents as an opaque string. A long JSMQL expression then sits as one line with no break. A plain function lets every JS formatter break it for free, with no plugin and no config.

### Block-body arrows for pipelines

A block-body arrow `({ $ }) => { stmt; stmt; }` is the function-form mirror of the canonical `;`-separated pipeline string form. The body is a list of JSMQL statements separated by `;`. A `,` keeps its role inside one stage:

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

The `function` keyword mirrors both shapes. `function ({ $ }) { return <expr> }` is the value form, the same as `({ $ }) => <expr>`. `function ({ $ }) { stmt; stmt; }` is the pipeline form, the same as the block-body arrow above.

Two formatter quirks are worth knowing about. First, prettier and oxfmt wrap a top-level assignment statement in parens (`($.x = …)`) when it appears in a position that could read as a destructuring assignment. The parser accepts this transparently. Second, JavaScript's comma operator combines `$.a = 1, $.b = 2` into one expression statement. The parser reads this as an in-stage update-op chain, the same as the string form.

`return` is **not** part of jsmql. A block body is a statement list, not JavaScript control flow. A `return` inside a block-body arrow throws a clear `FunctionInputError` that points at the `;`-separated form or an expression-body arrow as an alternative.

### Restrictions

- **Arrow or `function`, but synchronous and non-generator.** Both `({ $ }) => …` and `function ({ $ }) { … }` are accepted as the input. A named function expression's name is parsed but discarded, because it is unreachable in MQL. An `async` function and a generator (`function*`) are rejected, with a message that points at the synchronous form.
- **No `return` inside a block body.** Use `;`-separated statements (block body), or a plain expression body — never both, and never with `return`. (A single-`return` `function` body is the exception: `function ({ $ }) { return <expr> }` *is* the value form, the same as `({ $ }) => <expr>`.)
- **No outer-scope variables.** `Function.prototype.toString()` returns text, not a closure, so JSMQL cannot resolve a value from the surrounding scope. Two options exist to parameterise a query instead: the [template-tag form](#template-tag-form--jsmql-) for one-shot interpolation, and the [`jsmql.compile(fn)` form](#parameterised-queries-jsmqlcompile) for a reusable parameterised query:
  ```js
  const minAge = 21;
  jsmql(({ $ }) => $.age > minAge);              // ❌ error: Unknown identifier 'minAge'
  jsmql`$.age > ${minAge}`;                      // ✓ template tag — value interpolated
  jsmql.compile(({ minAge }, { $ }) => $.age > minAge)({ minAge });   // ✓ named param
  ```
- **The toolbox destructure binds `$` to the document context.** `({ $ }) =>` is the idiom. The destructured `$` is the document root. The `$$` / `$$$` / `$$$$` context refs and the `$`-operators come from the same object. Jsmql rejects a bare identifier or no destructure at all.

When JSMQL meets an unknown identifier on the function-form path, the error message also names the template-tag form of `jsmql` as the right tool for closure interpolation.

### Escape-hatch operators (`$op` destructure)

A direct `$op(...)` call (for example `$dateDiff`, `$sampleRate`, `$stdDevPop`) works inside the function body, but TypeScript or your IDE flags the operator name as an unknown identifier. To silence that warning, list the operators you use alongside `$` in the toolbox destructure:

```js
jsmql(({ $, $dateDiff }) =>
  $dateDiff({ startDate: $.lastLoginAt, endDate: new Date(), unit: "day" }) ?? -1,
);
```

The arrow receives one destructured toolbox object: the document root `$`, the context refs, and the `$`-operators. Listing the names is optional, types-only convenience — JSMQL types the destructured names as callables but never runs them. The runtime strips the parameter list before it parses, so the body is the same as writing the call directly. The type system accepts any `$`-prefixed name in the toolbox destructure. The code generator checks at compile time whether it names a real MongoDB operator.

---

## Partial expressions (`jsmql.expr`)

`jsmql()` picks the shape for you. It returns a Filter for `db.coll.find(filter)`, or an aggregation Pipeline array for `db.coll.aggregate(pipeline)` and for the pipeline form of `db.coll.updateOne(filter, update)`. When you need a **raw aggregation expression** — the shape that goes *inside* a hand-written Pipeline stage body — call `jsmql.expr(input)` instead.

`jsmql.expr` accepts the same three call shapes as `jsmql()`: string, arrow, and template tag. A bare expression (no `;`) lowers directly to its aggregation-expression form, with no Filter wrapper and no `$expr` envelope. `jsmql()` would instead wrap a non-predicate expression in `$expr` to build a legal Filter. JSMQL refuses anything that is not an expression — a stage, a write (`$.x = …`, `delete $.x`), a stream chain — and names the entry point that takes it:

```js
jsmql.expr("$.score = 100")
// Error: jsmql.expr() expects an aggregation expression (the value of a stage field, `jsmql.expr`),
//        but received a write (`$.x = …`, `delete $.x`). Use jsmql.update() for an update document,
//        or jsmql.pipeline() for a `$set` / `$unset` pipeline.
```

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

The rule: **match the function to the call site**. Use `jsmql()` for `find()`, `aggregate()`, and `updateOne()`. Use `jsmql.expr()` inside a hand-written stage body, or in a `$cond`'s `then` branch, where you want the raw aggregation expression. For the `{ $set, $inc, … }` update document, use [`jsmql.update()`](#jsmqlupdateinput--for-dbcollupdateonefilter-update--updatemany).

---

## Strict-shape entry points (`jsmql.filter`, `jsmql.pipeline`, `jsmql.update`)

`jsmql()` is polymorphic. It picks Filter or Pipeline from the input. When the call site needs one fixed shape, and a silent wrong choice would be a trap, use one of the three strict entry points. Each accepts the same string, arrow, and template-tag inputs as `jsmql()`, but refuses the other shape and throws an actionable error instead.

| Function | Returns | Throws on |
|---|---|---|
| `jsmql.filter(input)` | a single Filter document | any Pipeline-shaped input |
| `jsmql.pipeline(input)` | a Pipeline (stage array) | a bare expression that would lower to a Filter |
| `jsmql.update(input)` | the update document `{ $set, $inc, $unset, … }` | a computed value, a stage, anything that is not a write or an update operator |

(The function is `update`, not `updateFilter`, even though the Node MongoDB driver types the slot as `UpdateFilter<TSchema>`. The word "filter" in that type name routinely leads a developer to reach for it when they mean the query document. The MongoDB type name stays as the driver defines it; JSMQL just does not repeat the confusing half of it on this call.)

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

The accepted branch is identical to the no-`;` path of `jsmql()`. It uses the same indexable-conjunct translation, and the same `$expr` fallback for the part it cannot translate. Only the rejected input differs.

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

JSMQL accepts a single top-level stage call (`$match(...)`), a single stage-object literal (`{ $match: ... }`), an update-op chain, and an array-literal Pipeline. This is the same auto-wrap rule `jsmql()` uses for a Pipeline shape.

### `jsmql.update(input)` — for `db.coll.updateOne(filter, update)` / `updateMany`

```js
db.users.updateOne(
  { _id: 123 },
  jsmql.update("$.visits += 1, $.status = 'active', $.updatedAt = new Date(), delete $.tmp"),
);
// → db.users.updateOne(
//     { _id: 123 },
//     { $inc: { visits: 1 }, $set: { status: "active" }, $currentDate: { updatedAt: true }, $unset: { tmp: "" } },
//   )

jsmql.update("$.name = $.name.toUpperCase()");
// Error: A document-form update takes constants: the server reads '$b' there as the
//        string, not the field. To compute from the document, use the pipeline form
//        ('jsmql.pipeline("$.a = $.b + 1;")'), which 'updateOne' accepts as well.

jsmql.update("$match($.age > 18); $set({ x: 1 })");
// Error: '$match' is not valid in an update document — see its 'where'.
```

Output is the **update document**: one key per update operator, the shape `updateOne`, `updateMany`, and the mongoose `updateOne` take. Each write lowers to the operator that means it: `=` to `$set`; `+=` / `-=` / `++` / `--` to `$inc`; `*=` to `$mul`; `delete` to `$unset`; `= new Date()` to `$currentDate`; `Math.min` / `Math.max` of the field and a constant to `$min` / `$max`; `.push(x)` to `$push`; `.pop()` / `.shift()` to `$pop`. A raw update operator (`$inc({ n: 2 })`, `{ $set: { a: 1 } }`) merges in as written. JSMQL refuses two writes to one path.

The values are **constants**. MongoDB's document-form update reads `"$b"` as the string `"$b"`, not as the field. So JSMQL refuses a value computed from the document, and names the pipeline form instead (`jsmql.pipeline("$.a = $.b + 1;")` or `jsmql()`). `updateOne` accepts that form too, and MongoDB evaluates it server-side.

### When to use each

- Call site is `find()`, `deleteOne()`, or `countDocuments()` → use `jsmql.filter()`.
- Call site is `aggregate()` → use `jsmql.pipeline()`.
- Call site is `updateOne()` or `updateMany()` with constant values → use `jsmql.update()`. With values computed from the document → use `jsmql.pipeline()` (or `jsmql()`).
- The same source string might correctly produce either a Filter or a Pipeline → use `jsmql()`.
- Inside another structure (a hand-written stage body, the `then` branch of a `$cond`) → use `jsmql.expr()`.

Each strict entry has a parameterised `.compile` variant (`jsmql.filter.compile`, `jsmql.pipeline.compile`, `jsmql.update.compile`) for a reusable parameterised query that keeps the same shape guarantee. See [Shape-specific compile builders](#shape-specific-compile-builders).

---

## Command Line (`jsmql`)

Installing the package puts a `jsmql` command on your `PATH`. It reads **JSMQL source on stdin** and writes **MQL on stdout**, as JavaScript you can paste into mongosh or a driver script. A positional argument or `--file <path>` can supply the source instead of stdin.

```sh
echo '$.age > 18' | jsmql
# { age: { $gt: 18 } }

jsmql --pipeline -c '$match($.age > 18); $sort({ age: -1 })'
# [{ $match: { age: { $gt: 18 } } }, { $sort: { age: -1 } }]
```

With no flag, the CLI dispatches the output shape exactly like `jsmql()` does: a top-level `;` makes it a Pipeline. The mode flags lock the shape to one of the entry points above:

| Flag | Output | Same as |
| --- | --- | --- |
| *(none)* | Filter or Pipeline | `jsmql()` |
| `--filter` | Filter document | `jsmql.filter()` |
| `--pipeline` | stage array | `jsmql.pipeline()` |
| `--expr` | aggregation expression | `jsmql.expr()` |
| `--update` | update document | `jsmql.update()` |
| `--validate` (or `--check`) | `{ valid, errors }`; exits 1 if invalid | `jsmql.validate()` |

The CLI pretty-prints output with a 2-space indent by default. `-c` / `--compact` writes one line, `--tab` indents with tabs, and `--indent N` indents with N spaces. The printer is `jsmql.stringify` below. Parameterise a query with `--arg` / `--argjson`. The source must then be a parameterised arrow (see [Parameterised Queries](#parameterised-queries-jsmqlcompile)):

```sh
echo '({ minAge }, { $ }) => $.age > minAge' | jsmql --argjson minAge 18
# { age: { $gt: 18 } }

# Params combine with any shape flag — routed through the matching *.compile():
echo '({ minAge }, { $ }) => { $match($.age > minAge) }' | jsmql --pipeline --argjson minAge 18
# [{ $match: { age: { $gt: 18 } } }]
```

`--arg name value` binds a string. `--argjson name value` binds a JSON value. Both flags repeat. A param works with any output-shape flag — each routes through the matching `*.compile()` builder and enforces that shape — and with `--validate`, which checks the parameterised arrow's shape. A compile error prints with a caret at the offending position. Exit codes: `0` for success, `1` for a compile error (or an invalid `--validate` result), `2` for a usage error. Run `jsmql --help` for the full list.

---

## Printing MQL (`jsmql.stringify`)

`jsmql.stringify(document)` writes a compiled document as **the JavaScript that rebuilds it**. This is the text the CLI prints and the playground shows. Paste it into mongosh or a driver script, and it means what your source meant.

```js
const filter = jsmql('$.status === "active" && $._id === 0x507f1f77bcf86cd799439011 && $.at > new Date("2026-01-01")');

jsmql.stringify(filter);
// {
//   status: "active",
//   _id: new ObjectId("507f1f77bcf86cd799439011"),
//   at: { $gt: new Date("2026-01-01T00:00:00.000Z") }
// }
```

`JSON.stringify` cannot write that document. A Date and an ObjectId each carry a `toJSON`, so both collapse to a plain string, and the server then compares them as strings. A live `RegExp` becomes `{}`, which matches every document. Every other BSON value becomes its internal byte fields. The document still runs, and it matches nothing.

JSMQL writes every BSON class as `new X(…)`, the form the Node driver needs. The same text runs in mongosh, which exposes the driver's classes as globals. A driver script needs them in scope:

```js
const { ObjectId, Decimal128, Long, Int32, Double, Binary, UUID, Timestamp,
        MinKey, MaxKey, Code, DBRef, BSONSymbol, BSONRegExp } = require("mongodb");
```

A document stays on ONE line while it fits. Once it does not fit, it breaks one entry per line, so a pipeline reads one stage per line:

```js
jsmql.stringify(jsmql("$match($.age > 18); $set({ t: $.a * 2 }); $sort({ t: -1 })"));
// [
//   { $match: { age: { $gt: 18 } } },
//   { $set: { t: { $multiply: ["$a", 2] } } },
//   { $sort: { t: -1 } }
// ]
```

Two options control that. `indent` sets the spaces per level, or the string to indent with (default `2`). `width` sets the column at which a document breaks (default `80`). `jsmql.stringify(doc, { width: Infinity })` puts the whole document on one line — this is what the CLI's `-c` does.

JSMQL refuses three values with a `TypeError`, because writing anything in their place would hide the fault: an Invalid Date, `undefined` (the language declares it an existence test, never a value), and a circular structure.

Full detail — every BSON spelling and why, the `__proto__` key, the layout rules — is in [docs/specs/mql-stringify.md](specs/mql-stringify.md).

## Parameterised Queries (`jsmql.compile`)

Use `jsmql.compile(fn)` for a query that runs many times with different values — a typical "list users in region X above age Y" handler. It parses the arrow once and returns a callable. Call it with a fresh **params object** each time. Each call walks the cached AST and puts the bound values inline as MQL literals. No call re-parses the source.

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

The first argument may also be a **string** that holds the same arrow source. Use this when the query text lives elsewhere — a config file, a file, a database — and you want the same parse-once, bind-many behaviour:

```js
const eligibleUsersQuery = jsmql.compile(
  "({ minAge, region }, { $ }) => $.age >= minAge && $.region === region",
);

eligibleUsersQuery({ minAge: 21, region: "AU" });
// → { $and: [{ $gte: ["$age", 21] }, { $eq: ["$region", "AU"] }] }
```

The destructure is still the only way to declare a parameter. JSMQL deliberately does **not** support a placeholder syntax like `${name}` inside the string, because it would break JSMQL's strict-JS-subset rule and collide with a real template literal. When the query string is not function-shaped — an arrow `(params, { $ }) => …` or a `function (params, { $ }) { … }` — you get the same `FunctionInputError` the function form would raise.

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

You can omit either slot as long as the remaining one keeps its position. `jsmql.compile(({ minAge }) => …)` is the minimal form when you need only the params.

### Values are inlined as MQL literals

A binding value flows into the MQL output the same way an interpolated template-tag value does: as a JSON literal.

```js
jsmql.compile(({ allowed }, { $ }) => $.grade in allowed)({ allowed: ["A", "B"] });
// → { $in: ["$grade", ["A", "B"]] }
```

In particular, `$match` keeps its **index-friendly** translation when the comparison is against a binding. The compiled stage emits MongoDB query-language form, not `$expr`-wrapped aggregation form, so an index on the compared field still works.

### Restrictions on the params destructure

- **No defaults** — JSMQL rejects `({ minAge = 18 }) => …`. The parser cannot evaluate an arbitrary default expression (for example `= config.x`), and allowing only a literal default would create a confusing JS-subset rule. For a runtime fallback, use nullish coalescing at the call site: `q({ minAge: input ?? 18 })`.
- **No nested destructure** — `({ a: { b } })`. Use a flat key-to-value map.
- **No rest pattern** — `({ ...rest })`. List each binding by name.
- **No array destructure** — `[a, b]`. Params is always an object.
- **No mixing `$`-keys and non-`$`-keys** in the same destructure. Keep them as two separate destructures: `(params, { $, … }) => …`.

Each restriction throws a clear `FunctionInputError` that names the problem and points at the fix.

### Param values

Each value on the params object must be a JSON-safe literal: a number, a string, a boolean, `null`, a plain array, or a plain object. JSMQL applies the same check that template-tag interpolation uses, and rejects `NaN`, `Infinity`, a function, a Symbol, `undefined`, and a circular reference — at call time, with a `JsmqlInterpolationError` that names the binding key. JSMQL accepts a BigInt and turns it into a `Long`. It refuses a value past the 64-bit range.

A BSON instance value — `Date`, `RegExp`, `Uint8Array` (and `Buffer`), and ObjectId (matched by its `_bsontype` field) — passes through to the MQL output as the live JS instance, exactly the way the template-tag form preserves it. This pass-through works **anywhere** in the binding value: at the top level, nested inside an object, nested inside an array, and at any depth. The same shape that works through interpolation also works through a parameter binding, with no manual unpacking at the call site:

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

When the body references a binding missing from the params object, the call throws `UnknownIdentifierError` and names the binding (and the aliased outer key, when the code used `{ key: alias }`).

### Validation

`jsmql.compile(fn)` is throw-style: bad input fails fast. For a structured per-call error, wrap the compiled callable in your own `try`/`catch`, and route the thrown error into `jsmql.validate()`'s catch-and-classify branch table by re-throwing it there. More commonly, keep the throw and let the upstream error handler decide. `jsmql.validate()` accepts the one-shot input shapes (string, arrow / `function`, template tag) **and** a parameterised-function string — it checks the function's shape with the bindings stubbed out. The parameterised callable that `.compile` returns stays throw-only.

### Shape-specific compile builders

`jsmql.compile` is polymorphic. The compiled callable returns a Filter or a Pipeline based on the arrow body, exactly like `jsmql()` does. When the call site needs a fixed shape, each strict entry point carries its own `.compile` that locks the output:

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

`jsmql.filter.compile`, `jsmql.pipeline.compile`, `jsmql.update.compile`, and `jsmql.expr.compile` share `jsmql.compile`'s binding mechanics exactly. They only narrow the output and enforce the same shape contract as their one-shot siblings. A compiled builder whose arrow body lowers to the wrong shape throws the identical error the one-shot strict entry would (for example, `jsmql.pipeline.compile(({ m }, { $ }) => $.age > m)` throws "expects a Pipeline … but received a bare expression" when called).

### Operator autocomplete (`@koresar/jsmql/globals`)

Listing every stage and operator alongside `$` in the toolbox destructure gets tedious. A real pipeline mentions five to ten stages plus a handful of escape-hatch expression ops. Spelling them out at every call site is bookkeeping the user should not have to do.

The `@koresar/jsmql/globals` subpath is a **pure-types** module that surfaces every JSMQL stage and operator as an ambient global. Import it once at the top of your file, keep only `$` in the toolbox destructure, and write `$match(…)`, `$dateAdd(…)`, and so on directly. Your IDE then autocompletes names and arg objects, catches a typo at compile time, and shows the official MongoDB description and doc link on hover.

```ts
import "@koresar/jsmql/globals"; // ← side-effect import; loads only `declare global` types
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
import "@koresar/jsmql/globals";

const recent = jsmql(
  ({ $ }) => $dateAdd({ startDate: $.purchaseDate, unit: "day", amount: 3 }),
  //                  ╰── autocomplete suggests: startDate, unit, amount, timezone?
  //                  ╰── `unit` is typed as the MQL timeUnit literal union
);
```

How it works:

- The compiled module (`dist/globals.js`) is `export {};`. **It exports no value, and costs nothing at runtime** beyond a single empty module load. A bundler tree-shakes it to nothing in practice. For fully zero-runtime use, add `"@koresar/jsmql/globals"` to your tsconfig `compilerOptions.types` instead of importing it.
- The types are **generated at build time from the official MongoDB MQL spec** ([`mongodb/mql-specifications`](https://github.com/mongodb/mql-specifications)), so they always match the operator the server documents: required versus optional args, a function-overload shape (for example `$and(x)` versus `$and(x, y, z)`), the full description, version metadata, and a link.
- The declarations are **global**, through TypeScript's `declare global`. Once any file in your project imports the module, the names are visible everywhere. **This is intentional.** A bundler rewrites every alternative — a named import, a namespace import — into `(0, _ops.$match)(…)` form, which the JSMQL parser cannot read. A global is the only shape that survives every transform. Each name starts with `$`, so a real collision with a user identifier is nil — `$` as an identifier prefix is the MongoDB convention, and no other part of the TS ecosystem uses it.
- The runtime path stays the same. The JSMQL parser already recognises a bare `$stage(…)` or `$op(…)` call regardless of what TypeScript sees. This import only quiets TypeScript and gives your IDE something to complete.

Listing an operator name in the toolbox destructure (`(…, { $, $match, $project })`) is the per-call-site alternative. `@koresar/jsmql/globals` is the better choice when you do not want to keep those lists.

The import also declares the context-reference prefixes `$$`, `$$$`, and `$$$$`, so arrow-form code that uses them type-checks instead of erroring on an undeclared name. The collection-scoped (`$$`) and cluster-scoped (`$$$$`) **diagnostic source stages** get full completion and hover documentation with an annotated option object:

```ts
import "@koresar/jsmql/globals";

jsmql(({ $ }) => $$.collStats({ storageStats: { scale: 1024 } }));
//                    ╰── autocomplete: indexStats, collStats, planCacheStats, listSearchIndexes
jsmql(({ $ }) => $$$$.currentOp({ allUsers: true }));
//                      ╰── autocomplete: currentOp, listSessions, shardedDataDistribution, …
```

A pipeline completes as well. A stream method, a chained stage call, and a foreign-collection
chain are all typed members that return the stream, so a chain stays completable from end
to end. Where a stream genuinely *is* an array, it reads as one:

```ts
import "@koresar/jsmql/globals";

jsmql(({ $ }) => {
  $set({ orderCount: $$$.orders.filter((o) => o.userId === $._id).size() });
  //                     ╰── autocomplete: find, filter, aggregate, map, sortBy, $match, $group, …
  //                                                                  ╰── typed `number`
  $$.filter((d) => d.orderCount > 0).$sort({ orderCount: -1 }).take(3);
  //                                    ╰── every stage chains: $sort, $group, $unwind, $out, …
});
```

The document values themselves stay `any`. The interfaces give chaining and completion,
not per-collection document typing, which needs schema threading `[DEF-013]`. Two other
limits are worth knowing. A typo of an *unlisted* member (`$$.pus(...)`) still does not
error: the refs keep a permissive index signature, so a form that carries no named type
(`$$ = …`, an `$out` write, a field read off a materialised lookup) stays legal, and JSMQL's own
parser catches the typo instead. Completion also needs the ref used **un-destructured**.
Naming `$$` in the toolbox destructure (`({ $, $$ }) => …`) shadows the ambient declaration
with `any`.

#### Value-method completion on typed values

A **value** method (a JavaScript method JSMQL recognises on an array, string, number, or date value — for example `.uniq()`, `.capitalize()`, `.clamp()`, `.startOf()`) is called on a *value*, not on a `$`-prefixed global, so its completion depends on the **receiver's type**. An import of `@koresar/jsmql/globals` augments the built-in `Array<T>` / `String` / `Number` / `Date` types with these methods, each with a concrete return type, so a chain stays completable end to end:

```ts
import "@koresar/jsmql/globals";

// annotate the document once → every hop completes and chains
jsmql(({ $ }: { $: { orders: { total: number; sku: string }[] } }) =>
  $.orders.sortBy("total").takeRight(3).map((o) => o.sku).uniq()
);
```

The **date** methods matter most here. JSMQL's date vocabulary
beyond the native accessors — `.plus()`, `.minus()`, `.diff()`, `.startOf()`, `.endOf()`,
`.format()`, `.set()`, `.quarter()`, `.isSame()`, and more — has no match in JavaScript's
own `Date`. So without the import, a typed date receiver does not merely miss completion:
TypeScript reports an error on code JSMQL compiles correctly. Each `unit` argument is
typed as the MQL time-unit set, so JSMQL catches a mistyped unit as you write it:

```ts
import "@koresar/jsmql/globals";

jsmql.expr(({ $ }: { $: { placedAt: Date } }) =>
  $.placedAt.startOf("month").plus(3, "day").format("%Y-%m-%d")
  //          ╰── autocomplete: startOf, endOf, plus, minus, diff, quarter, isSame, set, …
  //          ╰── "fortnight" is rejected; "month" is not
);
```

Completion flows from any value with a **concrete type**: an annotated `$` (above), a typed static (`Object.values(o)`, `Object.keys(o)`), a literal, or the result of a known-return method earlier in the chain. A **bare, un-annotated `$.field` is `any`**, and `any.uniq()` stays `any`, so a method on it neither autocompletes nor errors. This is a deliberate trade. `$.field` must stay `any` so the operator forms JSMQL relies on — `$.age > 18`, `$.price * 1.1` — keep type-checking. In TypeScript, one value cannot be both an operator operand and a rich method receiver. Type your document to light up completion.

Two points on scope:

- The augmentations are **global** once imported, like the operator globals. JSMQL's value methods then show up in completion on every array, string, and number in a file that sees the import. They are compile-time JSMQL methods — types only, no runtime — so a call to one *outside* a JSMQL expression fails at run time. Treat their appearance as a jsmql-authoring aid.
- JSMQL does **not** augment an **object-transform method** (`.mapValues` / `.pick` / `.omit` / `.invert`, and the like). The only interface they could hang on is `Object`, the base of every type, so augmenting it would advertise them on a number, a string, and an array too. Write them in JSMQL as usual; they simply do not autocomplete.

---

## Template-Tag Form (`` jsmql`…` ``)

For a query with an embedded literal value, call `jsmql` as a template tag. The tag
dispatches on shape exactly as the string form does: no `;` gives a Filter.
`jsmql.expr`, `jsmql.pipeline`, and `jsmql.update` are tags too:

```js
const { jsmql } = require("@koresar/jsmql");

const minAge = 21;
const filter = jsmql`$.age > ${minAge}`;
// → { age: { $gt: 21 } }

const statuses = ["active", "pending"];
const filter2 = jsmql`$.status in ${statuses}`;
// → { status: { $in: ["active", "pending"] } }

// Complex expression
const filter3 = jsmql`$.age > ${21} && $.status in ${["active"]}`;
// → { age: { $gt: 21 }, status: { $in: ["active"] } }
```

A template value must be a **literal** (a number, a string, a boolean, `null`, an array, or a plain object). A field reference goes in the template string:

```js
// ✓ Correct
jsmql`$.age > ${25}`

// ❌ Wrong — can't interpolate field names as values
const field = "age";
jsmql`$.${field} > ${25}`  // syntax error
```

### BSON instances round-trip

JSMQL emits an interpolation as a JSON literal, **except** for a native BSON instance that has no JSON shape that preserves its fidelity. Such an instance reaches the MQL output as the JS instance itself, which is what the Node MongoDB driver consumes in place:

```js
// Date — emitted as a real Date, indexed comparisons still work
const cutoff = new Date("2026-01-01");
jsmql`$.method === ${"postalDelivery"} && $.createdAt >= ${cutoff}`
// → { method: "postalDelivery", createdAt: { $gte: <Date 2026-01-01> } }

// RegExp — used as a query-language regex match
jsmql`$.username === ${/^alice/i}`
// → { username: /^alice/i }
```

A RegExp you pass is a value in every position, not only in a query slot. `` jsmql.expr`${re}` `` is the RegExp itself, `` jsmql`$.name = ${re};` `` writes it, and a filter keeps the instance you passed rather than a copy. Only a regex written in the source (`/^a/`) stays confined to the regex methods.

Pass-through types: `Date`, `RegExp`, `Uint8Array` (and `Buffer`, which subclasses `Uint8Array`), and ObjectId (matched by its `_bsontype` field). Everything else goes through `JSON.stringify`. Pass-through also works for a **nested** instance. A Date, RegExp, or similar value buried inside an interpolated object or array still arrives as a live instance, so a realistic operator-call shape like `` jsmql.expr`$dateDiff(${{ startDate: new Date(...), endDate: new Date(...), unit: "day" })` `` works the way you would write it by hand.

`jsmql.validate` is polymorphic in the same way, so `` jsmql.validate`$.age > ${minAge}` `` works as its non-throwing counterpart.

---

## Validation

Use `jsmql.validate()` to check syntax without building output:

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
- an IDE linter and code completion
- a check before you build an expression
- a check on user input in a form

---

## Error Messages

When you write invalid JSMQL, you get a clear error message with a suggestion:

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

Every example here is an **aggregation expression**: what `jsmql.expr(…)` returns, and
what goes in a stage field. The same source through `jsmql(…)` is a Filter instead. See
[Filter or Pipeline](#output-dispatch-filter-vs-pipeline) for the dispatch rule.

### Numeric Comparisons

```js
// Find adults
jsmql.expr("$.age >= 18")
// → { $gte: ["$age", 18] }

// Price range
jsmql.expr("$.price > 10 && $.price <= 100")
// → { $and: [{ $gt: ["$price", 10] }, { $lte: ["$price", 100] }] }

// Score calculation
jsmql.expr("($.correct + $.partial * 0.5) / $.total * 100")
// → { $multiply: [{ $divide: [{ $add: ["$correct", { $multiply: ["$partial", 0.5] }] }, "$total"] }, 100] }
```

### String Operations

```js
// Full name
jsmql.expr('$.firstName + " " + $.lastName')
// → { $concat: ["$firstName", " ", "$lastName"] }

// Normalized email
jsmql.expr("$.email.toLowerCase().trim()")
// → { $trim: { input: { $cond: { if: { $eq: [{ $ifNull: ["$email", null] }, null] }, then: null, else: { $toLower: "$email" } } } } }

// Check domain
jsmql.expr('$.email.substr($.email.indexOf("@") + 1)')
// → { $substrCP: ["$email", <the index after "@">, <the rest of the string>] }
//   — the index is a $switch on the receiver's own type, because `.indexOf` reads an
//     array and a string alike; see "Type-aware dispatch" above
```

### Conditional Logic

```js
// Age category
jsmql.expr('$.age < 13 ? "child" : $.age < 18 ? "teen" : "adult"')
// → { $cond: { if: { $lt: ["$age", 13] }, then: "child",
//     else: { $cond: { if: { $lt: ["$age", 18] }, then: "teen", else: "adult" } } } }

// Fallback value (chained ?? flattens into a single $ifNull)
jsmql.expr("$.nickname ?? $.firstName ?? 'Unknown'")
// → { $ifNull: ["$nickname", "$firstName", "Unknown"] }
```

### Array Operations

```js
// Status filter
jsmql.expr('$.status in ["active", "pending"]')
// → { $in: ["$status", ["active", "pending"]] }

// Transform array
jsmql.expr("$.prices.map(p => p * 1.1)")
// → { $map: { input: "$prices", as: "p", in: { $multiply: ["$$p", 1.1] } } }

// Filter array
jsmql.expr("$.items.filter(x => x.qty > 0)")
// → { $filter: { input: "$items", as: "x", cond: { $gt: ["$$x.qty", 0] } } }

// Sum array
jsmql.expr("$.amounts.reduce((acc, x) => acc + x, 0)")
// → { $reduce: { input: "$amounts", initialValue: 0, in: { $add: ["$$value", "$$this"] } } }
```

### Date Operations

```js
// Extract year from date field
jsmql.expr("$.createdAt.getFullYear()")
// → { $year: "$createdAt" }

// Days since creation
jsmql.expr("$dateDiff($.createdAt, new Date(), 'day')")
// → { $dateDiff: { startDate: "$createdAt", endDate: "$$NOW", unit: "day" } }

// Format date
jsmql.expr('$dateToString($.createdAt, "%Y-%m-%d")')
// → { $dateToString: { date: "$createdAt", format: "%Y-%m-%d" } }
```

### Type Casting

```js
// Convert string to number
jsmql.expr("Number($.stringPrice) * 1.1")
// → { $multiply: [{ $toDouble: "$stringPrice" }, 1.1] }

// Type check
jsmql.expr("typeof $.value === 'string'")
// → { $eq: [{ $type: "$value" }, "string"] }
```

### With Template Tag

```js
const statusFilter = jsmql`$.status in ${["active", "pending"]}`;
// → { $in: ["$status", ["active", "pending"]] }

const ageFilter = jsmql`$.age > ${21}`;
// → { $gt: ["$age", 21] }

// Combine using jsmql.expr() for dynamic composition
const combined = jsmql.expr(`$.age > 21 && $.status in ["active", "pending"]`);
// → { $and: [{ $gt: ["$age", 21] }, { $in: ["$status", ["active", "pending"]] }] }
```

## Replacing Server-Side JavaScript

MongoDB 8.0 deprecated three operators that run JavaScript on the server: `$function`, `$accumulator`, and `$where`. MongoDB's own documentation says to rewrite this logic as a native aggregation operator. JSMQL does that for you: you write JavaScript, and JSMQL compiles it to a native operator.

For the full case for and against server-side JavaScript, see the [README](../README.md). In short: it is deprecated, it is slow, it cannot use an index, many deployments turn it off, and it is a security risk.

**JSMQL adds no new syntax for these three operators.** If you need them on an older MongoDB version, the registry passthrough form still works (for example `$function({ body: "...", args: [...], lang: "js" })`). It gives no error and no warning; existing code keeps working as it is.

Each migration below shows the deprecated form on top, then the JSMQL replacement in **template-tag form** (`` jsmql`…` ``) and **function form** (`jsmql(({ $ }) => …)`).

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

`$where` runs a JavaScript predicate over every document. The native replacement is `$expr` around a comparison. Unlike `$where`, `$expr` lets MongoDB use an index when it can.

```js
// Deprecated
db.users.find({ $where: "function() { return this.age > 18; }" });

// Template-tag form
db.users.find({ $expr: jsmql`$.age > 18` });

// Function form
db.users.find({ $expr: jsmql(({ $ }) => $.age > 18) });
```

Inside an aggregation pipeline, you can use `$match` directly. JSMQL translates an index-safe predicate to query-document form, so MongoDB still uses an index, and it falls back to `$expr` only for the part it cannot express as a query (see [Pipelines](#pipelines)):

```js
// Translatable comparison → indexable query doc
jsmql`[{ $match: $.age > 18 }]`;
// → [{ $match: { age: { $gt: 18 } } }]

// Function form
jsmql(({ $ }) => [{ $match: $.age > 18 }]);
```

### `$accumulator` — custom accumulator inside `$group` / `$setWindowFields`

Most use of `$accumulator` maps to a built-in accumulator. Average:

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

For an accumulator that needs custom state, `$reduce` handles the common shapes natively. A running min and max alongside a count:

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

This form stays unchanged for backward compatibility. We do not recommend it on MongoDB 8.0 or later. Deprecation eventually means removal, and many deployments already refuse server-side JavaScript outright. If you do reach for it, leave a comment that explains why, and check whether `$reduce` or a custom pipeline can do the same job.

## Language Grammar (EBNF, simplified)

> The grammar below covers the core structure. A date constructor and a type-cast call follow standard JavaScript syntax, so this grammar omits them. A statement — `let` / `const`, `function`, a write, a stage call — is the pipeline surface, covered under [Pipelines](#pipelines).

```ebnf
expression  = ternary

ternary     = nullish ("?" expression ":" ternary)?

nullish     = logical_or ("??" logical_or)*

logical_or  = logical_and ("||" logical_and)*

logical_and = bitwise_or ("&&" bitwise_or)*

bitwise_or  = bitwise_xor ("|" bitwise_xor)*

bitwise_xor = bitwise_and ("^" bitwise_and)*

bitwise_and = comparison ("&" comparison)*

comparison  = relational ((==|!=|===|!==) relational)?

relational  = additive ((<|<=|>|>=|in) additive)?

additive    = multiplicative ((+|-) multiplicative)*

multiplicative = power ((*|/|%) power)*

power       = unary ("**" power)?

unary       = "typeof" unary | (!|-|~) unary | postfix

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

lambda      = params "=>" (expression | block)
            | "function" identifier? "(" params ")" block

params      = identifier | "(" (identifier ("," identifier)*)? ")"

block       = "{" statement* "return" expression ";"? "}"    (* a value body *)
            | "{" statement* "}"                             (* .aggregate: a list of stages *)

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
A: Use `.size()` for an array and `.length()` for a string. `$.items.size()` is `{ $size: { $ifNull: ["$items", []] } }`, and a missing array counts as empty. The `$size()` escape hatch is also there: `$size($.items)`.

**Q: Is `$.field.includes(x)` a `$in` or a string-substring match?**
A: A substring match, always: `.includes(x)` is a string method. Membership in an array is `.has(x)`, which emits `$in` in an expression and `{ field: x }` in a query document (see [Type-aware dispatch](#type-aware-dispatch)). On a field the compiler has proven to be an array, `.includes` is a compile-time error that names `.has(x)`. The operator forms are also there: `$in(x, $.items)`, the needle first, as MongoDB spells it.

**Q: Does `?.` actually short-circuit?**
A: For a bare READ it is sugar. MongoDB already returns null or missing when a path crosses a missing field, so `$.a?.b?.c` and `$.a.b.c` are the same MQL. Once the chain feeds a consumer that is not null-safe, the `?.` adds a real `$ifNull` neutral value. The table under [Optional Chaining](#optional-chaining) lists which consumer takes which neutral value.

**Q: How do `Math.max(...$.arr)` and `Math.max($.arr)` differ?**
A: They produce identical MQL (`{ $max: "$arr" }`). The spread form is JS-natural sugar only.

---
