# mjsql Language Reference

> This is the **user-facing language reference** for mjsql. For implementation details, see `specs/`.

---

## Quick Start

mjsql is a JavaScript-subset language that compiles to MongoDB aggregation expression JSON — like SQL but for MongoDB, using JS syntax you already know.

```js
const { mjsql } = require("mjsql");

// JS operators
mjsql("$.age > 18 && $.status == 'active'");
// → { $and: [{ $gt: ["$age", 18] }, { $eq: ["$status", "active"] }] }

// Method chains
mjsql("$.email.split('@').at(1).toLowerCase()");
// → { $toLower: { $arrayElemAt: [{ $split: ["$email", "@"] }, 1] } }

// Lambdas
mjsql("$.prices.map(p => p * 1.1)");
// → { $map: { input: "$prices", as: "p", in: { $multiply: ["$$p", 1.1] } } }

// With template tag (for embedded values)
const { mql } = require("mjsql");
const minAge = 21;
mql`$.age >= ${minAge} && $.status == 'active'`;
// → { $and: [{ $gte: ["$age", 21] }, { $eq: ["$status", "active"] }] }
```

---

## Table of Contents

1. [Expressions](#expressions)
2. [Literals](#literals)
3. [Field References](#field-references)
4. [Operators](#operators)
5. [String Methods](#string-methods)
6. [Array Methods](#array-methods)
7. [Lambda Functions](#lambda-functions)
8. [Math Functions](#math-functions)
9. [Type Casting](#type-casting)
10. [Date Operations](#date-operations)
11. [Utility Functions](#utility-functions)
12. [Template Tag (`mql`)](#template-tag-mql)
13. [Validation](#validation)
14. [Error Messages](#error-messages)
15. [Examples](#examples)

---

## Expressions

An mjsql expression is a **subset of JavaScript** that compiles to MongoDB aggregation expression JSON. Write JS operators, method chains, and lambdas — mjsql handles the translation. For MongoDB operators without a JS equivalent, use the `$op()` fallback form.

### Valid Constructs

- Literals: numbers (with numeric separators `1_000_000`), strings, booleans, `null`, arrays, objects
- Template literals: `` `hello, ${$.name}!` ``
- Spread: `[...arr]`, `{ ...obj }`, `Math.max(...$.scores)`
- Field references: `$.fieldName`, `$.nested.path`
- Optional chaining: `$.a?.b`, `$.a?.[0]`, `$.name?.trim()`
- Bracket access: `$.items[0]`, `$.arr[$.idx]`
- Computed object keys: `{ [$.k]: 1 }`
- Shorthand object properties: `x => ({ x })` (sugar for `{ x: x }`)
- Binary operators: `+`, `-`, `*`, `/`, `%`, `==`, `!=`, `>`, `>=`, `<`, `<=`, `&&`, `||`, `??`, `in`, `**`
- Unary operators: `!`, `-`
- Ternary operator: `? :`
- String methods: `.trim()`, `.toLowerCase()`, `.startsWith()`, etc.
- Array methods: `.map()`, `.filter()`, `.flat()`, `.join()`, etc.
- Math functions and constants: `Math.floor()`, `Math.min()`, `Math.PI`, etc.
- Type casting: `Number()`, `String()`, `typeof`, etc.
- Date operations: `new Date()`, `Date.now()`, `.getFullYear()`, `.toISOString()`, etc.
- Lambda functions: `x => expr`, `(a, b) => expr`
- Fallback: `$sampleRate(0.33)`, `$dateTrunc($.createdAt, "day")`, etc.

### Invalid Constructs

- Control flow: `if`, `for`, `while`, `break`, etc.
- Statements: function definitions, assignments
- Object/array mutations: `.push()`, `.splice()`
- Destructuring: `{ a, b } = obj`
- Pipeline stages: `$match`, `$project`, `$group`, etc.

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

### Strings

Both single and double quotes. Escape sequences: `\\`, `\"`, `\'`, `\n`, `\t`:

```js
"hello"
'world'
"line1\nline2"
"escaped \"quote\""
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

### Objects

Key-value pairs in braces, including spread:

```js
{ name: $.name, score: $.score }           // field values
{ status: "active", count: $.count + 1 }   // mixed
{ ...$.defaults, priority: 1 }             // spread an object field
{ ...$.a, ...$.b, extra: true }            // merge multiple objects
```

Objects are useful as `$push` arguments in `group()`, as `$project` escape hatch values, and in `$let` bindings.

#### Computed Keys

Keys may be computed expressions, just like in JS:

```js
{ [$.k]: 1 }                       // → { $arrayToObject: [["$k", 1]] }
{ a: 1, [$.dynKey]: 2 }            // → { $arrayToObject: [["a", 1], ["$dynKey", 2]] }
```

Whenever an object literal contains at least one computed key, it compiles to `$arrayToObject` so MongoDB can build the object at query time. Mixing computed keys with `...spread` is not supported.

#### Shorthand Properties

`{ x }` is sugar for `{ x: x }` — useful inside lambda bodies:

```js
$.items.map(x => ({ x }))
// → { $map: { input: "$items", as: "x", in: { x: "$$x" } } }
```

The shorthand value is treated as an identifier (lambda parameter); using shorthand outside a lambda scope produces an "Unknown identifier" error.

---

## Field References

Document fields are referenced with `$.` (dollar-dot):

```js
$.age              // simple field
$.address.city     // nested field
$.items.0.name     // array element by index
$.in               // field literally named "in" (no conflict with operator)
```

### Bracket Access

Use square brackets for computed index access on arrays:

```js
$.items[0]         // first element
$.items[$.idx]     // element at dynamic index
$.matrix[$.row][$.col]  // nested access
```

Bracket access maps to MongoDB's `$arrayElemAt`:
```js
$.items[0]         // { $arrayElemAt: ["$items", 0] }
$.items[$.idx]     // { $arrayElemAt: ["$items", "$idx"] }
```

### Optional Chaining

`?.` is accepted everywhere `.` is. MongoDB already returns `null`/missing when a dotted path traverses a missing field, so `?.` is purely for JS readability — the compiled MQL is identical to the non-optional form:

```js
$.user?.address?.city                // → "$user.address.city"
$.items?.[0]                         // → { $arrayElemAt: ["$items", 0] }
$.name?.trim()                       // → { $trim: { input: "$name" } }
```

### Syntax

- Must start with `$.`
- Followed by a valid identifier (letter or underscore)
- May include dots for nested access
- May include numeric indices for arrays

### Invalid field references

```
$age           // ❌ Missing dot — use $.age or $age()
$.             // ❌ Incomplete
$.0.name       // ❌ Can't start with digit after $.
```

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
$.status == "active"                // { $eq: ["$status", "active"] }
$.status != null                    // { $ne: ["$status", null] }
$.age > 18                          // { $gt: ["$age", 18] }
$.age >= 21                         // { $gte: ["$age", 21] }
$.score < 50                        // { $lt: ["$score", 50] }
$.score <= 100                      // { $lte: ["$score", 100] }
$.status in ["active", "pending"]   // { $in: ["$status", ["active", "pending"]] }
```

**Note:** `===` and `!==` work the same as `==` and `!=`.

### Logical

```js
$.active && $.age > 18              // { $and: ["$active", { $gt: ["$age", 18] }] }
$.a > 0 || $.b > 0                  // { $or: [{ $gt: ["$a", 0] }, { $gt: ["$b", 0] }] }
!$.active                           // { $not: "$active" } 
```

### Conditional

```js
$.age >= 18 ? "adult" : "minor"     // { $cond: [{ $gte: ["$age", 18] }, "adult", "minor"] }
$.nickname ?? $.name                // { $ifNull: ["$nickname", "$name"] }
```

---

## String Methods

Call methods on any expression that produces a string:

```js
$.name.trim()                      // { $trim: { input: "$name" } }
$.name.trimStart()                 // { $ltrim: { input: "$name" } }
$.name.trimEnd()                   // { $rtrim: { input: "$name" } }
$.name.toLowerCase()               // { $toLower: "$name" }
$.name.toUpperCase()               // { $toUpper: "$name" }
$.name.substr(1)                   // { $substrCP: ["$name", 1, { $strLenCP: "$name" }] }
$.name.substr(0, 3)                // { $substrCP: ["$name", 0, 3] }
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

// Property access — type-aware dispatch
$.name.trim().length                // { $strLenCP: ... }       — known string → $strLenCP
$.csv.split(",").length             // { $size: ... }           — known array  → $size
$.field.length                      // { $cond: [{ $isArray: "$field" }, { $size: ... }, { $strLenCP: ... }] }
                                    //                          — unknown type → runtime dispatch

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
$.items.slice(2)           // { $slice: ["$items", 2] }
$.items.slice(1, 3)        // { $slice: ["$items", 1, 3] }
$.items.reverse()          // { $reverseArray: "$items" }
[1, 2].concat([3, 4])      // { $concatArrays: [[1, 2], [3, 4]] }   (array-typed)
[1, 2, 3].includes($.x)    // { $in: ["$x", [1, 2, 3]] }            (array-typed)
[1, 2, 3].indexOf($.x)     // { $indexOfArray: [[1, 2, 3], "$x"] }  (array-typed)
$.tags.join(", ")          // builds a comma-separated string via $reduce/$concat
$.nested.flat()            // flatten one level via $reduce + $concatArrays
$.docs.flatMap(d => d.tags)// $reduce over $map of the lambda
```

**Type-aware dispatch.** `.includes()`, `.indexOf()`, and `.concat()` work on both strings and arrays:

- **Statically known array** (array literal, `.split()`, `.map()`, `.filter()`, `Object.values()`, etc.) → emits the array form (`$in`, `$indexOfArray`, `$concatArrays`).
- **Statically known string** (`.toLowerCase()`, `String(x)`, `+` in string context, template literal, etc.) → emits the string form (`$indexOfCP` / `$concat`).
- **Unknown receiver** (a bare `$.field`, a ternary, etc.) → emits a runtime `$cond` on `$isArray` so the right form runs at query time. The output is more verbose, but works whether the field is a string or an array.

```js
$.tags.includes("active")
// → { $cond: [
//       { $isArray: "$tags" },
//       { $in: ["active", "$tags"] },
//       { $gte: [{ $indexOfCP: ["$tags", "active"] }, 0] }
//     ] }
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
$.items.find(x => x.status == "active")
// → { $arrayElemAt: [{ $filter: { input: "$items", as: "x", cond: { $eq: ["$$x.status", "active"] } } }, 0] }

// some — true if any element matches
$.scores.some(x => x >= 90)
// → { $anyElementTrue: { $map: { input: "$scores", as: "x", in: { $gte: ["$$x", 90] } } } }

// every — true if all elements match
$.scores.every(x => x >= 60)
// → { $allElementsTrue: { $map: { input: "$scores", as: "x", in: { $gte: ["$$x", 60] } } } }

// reduce — fold to a single value (two-param lambda required)
$.numbers.reduce((acc, x) => acc + x, 0)
// → { $reduce: { input: "$numbers", initialValue: 0, in: { $add: ["$$value", "$$this"] } } }
```

**Note:** In `reduce`, the accumulator and element are mapped to MongoDB's `$$value` and `$$this` variables.

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

### Constants

```js
Math.PI                            // 3.141592653589793
Math.E                             // 2.718281828459045
```

**Note:** `Math.round(x)` rounds to the nearest integer (`{ $round: [x, 0] }`). For rounding to N decimal places, use the `$round()` utility — there is no JS equivalent:
```js
$round($.value, 2)                 // { $round: ["$value", 2] } (round to 2 decimal places)
```

**Note:** `Math.log()` is the natural logarithm. For arbitrary base, use `$log()` utility:
```js
$log($.value, 10)                  // { $log: ["$value", 10] } (log base 10)
```

---

## Type Casting

### JavaScript-Style Casting

```js
Number($.stringField)              // { $toDouble: "$stringField" }
String($.numField)                 // { $toString: "$numField" }
Boolean($.value)                   // { $toBool: "$value" }
parseInt($.stringField)            // { $toInt: "$stringField" }
parseFloat($.stringField)          // { $toDouble: "$stringField" }
```

### `typeof` Operator

```js
typeof $.field                     // { $type: "$field" }
typeof $.age == "number"           // { $eq: [{ $type: "$age" }, "number"] }
```

Returns the BSON type name as a string (e.g. `"double"`, `"string"`, `"bool"`, `"objectId"`, `"date"`, `"null"`, `"array"`, `"object"`).

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

---

## Date Operations

### Date Constructor and `Date.now()`

```js
new Date()                         // { $toDate: "$$NOW" }  (current date/time)
new Date($.dateString)             // { $toDate: "$dateString" }
new Date("2024-01-01")             // { $toDate: "2024-01-01" }
Date.now()                         // { $toLong: "$$NOW" }  (ms since epoch, like JS)
```

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

**Note:** `getMonth()` and `getDay()` are adjusted to match JavaScript's 0-based conventions. MongoDB's `$month` is 1-based; mjsql subtracts 1 automatically.

### Date Utility Functions

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

## Utility Functions

For MongoDB operators that have no JavaScript equivalent, use the `$opName()` fallback form. Every MongoDB aggregation operator is available this way — and unknown operators pass through automatically, making mjsql forward-compatible with new MongoDB releases.

### Examples:

```js
$cmp($.a, $.b)                     // { $cmp: ["$a", "$b"] }   (-1, 0, or 1)
$in($.x, [1, 2, 3])                // { $in: ["$x", [1, 2, 3]] }  (alternative to `in` operator)
$or($.a, $.b, $.c)                 // { $or: ["$a", "$b", "$c"] }
```

### String

```js
$concat($.first, " ", $.last)      // { $concat: ["$first", " ", "$last"] }
```

### Math

```js
$log($.value, 10)                  // { $log: ["$value", 10] }  (log base 10)
$round($.value, 2)                 // { $round: ["$value", 2] }  (2 decimal places)
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
$setIntersection($.a, $.b)         // { $setIntersection: ["$a", "$b"] }
$setDifference($.a, $.b)           // { $setDifference: ["$a", "$b"] }
$setIsSubset($.a, $.b)             // { $setIsSubset: ["$a", "$b"] }
$setEquals($.a, $.b)               // { $setEquals: ["$a", "$b"] }
```

### Object Operations

```js
Object.keys($.obj)                 // { $map: { input: { $objectToArray: "$obj" }, as: "kv", in: "$$kv.k" } }
Object.values($.obj)               // { $map: { input: { $objectToArray: "$obj" }, as: "kv", in: "$$kv.v" } }
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

### Spread in Variadic Calls

For variadic operators (and `Math.min`/`Math.max`, `Object.assign`), `...arr` passes the whole array through as the operator value:

```js
Math.max(...$.scores)              // { $max: "$scores" }
$concatArrays(...$.arrs)           // { $concatArrays: "$arrs" }
Object.assign(...$.docs)           // { $mergeObjects: "$docs" }
```

When mixed with non-spread args, mjsql wraps the non-spreads in single-element arrays and joins via `$concatArrays`:

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

---

## Template Tag (`mql`)

For expressions with embedded literal values, use the `mql` template tag:

```js
const { mql } = require("mjsql");

const minAge = 21;
const expr = mql`$.age > ${minAge}`;
// → { $gt: ["$age", 21] }

const statuses = ["active", "pending"];
const expr2 = mql`$.status in ${statuses}`;
// → { $in: ["$status", ["active", "pending"]] }

// Complex expression
const expr3 = mql`$.age > ${21} && $.status in ${["active"]}`;
// → { $and: [{ $gt: ["$age", 21] }, { $in: ["$status", ["active"]] }] }
```

Template values must be **literals** (numbers, strings, booleans, null, or arrays). Field references go in the template string:

```js
// ✓ Correct
mql`$.age > ${25}`

// ❌ Wrong — can't interpolate field names as values
const field = "age";
mql`$.${field} > ${25}`  // syntax error
```

---

## Validation

Use the `validate()` function to check syntax without generating output:

```js
const { validate } = require("mjsql");

validate("$.age > 18");
// → { valid: true, errors: [] }

validate("age > 18");
// → {
//     valid: false,
//     errors: [{
//       message: "Unknown identifier 'age'. Did you mean '$.age'?",
//       pos: 0,
//       code: "CODEGEN_ERROR"
//     }]
//   }
```

Use `validate()` for:
- IDE linters and code completion
- Pre-flight checks before building expressions
- User input validation in forms

---

## Error Messages

When you write invalid mjsql, you get clear error messages with suggestions:

```js
mjsql("age > 18");
// CodegenError: Unknown identifier 'age'. Did you mean '$.age'?

mjsql("$.age > 18 &&");
// ParseError: Unexpected end of expression

mjsql("$.age >>");
// ParseError: Unexpected token '>' at position 7

mjsql('$.status in "active"');
// CodegenError: Right-hand side of 'in' must be an array literal or field reference, not a scalar value

mjsql("$.name.frobulate()");
// CodegenError: Unknown method '.frobulate()'. String methods: trim, trimStart, ...
```

---

## Examples

### Numeric Comparisons

```js
// Find adults
mjsql("$.age >= 18")
// → { $gte: ["$age", 18] }

// Price range
mjsql("$.price > 10 && $.price <= 100")
// → { $and: [{ $gt: ["$price", 10] }, { $lte: ["$price", 100] }] }

// Score calculation
mjsql("($.correct + $.partial * 0.5) / $.total * 100")
// → { $divide: [{ $multiply: [{ $add: ["$correct", { $multiply: ["$partial", 0.5] }] }, 100] }, "$total"] }
```

### String Operations

```js
// Full name
mjsql('$.firstName + " " + $.lastName')
// → { $concat: ["$firstName", " ", "$lastName"] }

// Normalized email
mjsql("$.email.toLowerCase().trim()")
// → { $trim: { input: { $toLower: "$email" } } }

// Check domain
mjsql('$.email.substr($.email.indexOf("@") + 1)')
// → { $substrCP: ["$email", { $add: [{ $indexOfCP: ["$email", "@"] }, 1] }, ...] }
```

### Conditional Logic

```js
// Age category
mjsql('$.age < 13 ? "child" : $.age < 18 ? "teen" : "adult"')
// → nested $cond chain

// Fallback value (chained ?? flattens into a single $ifNull)
mjsql("$.nickname ?? $.firstName ?? 'Unknown'")
// → { $ifNull: ["$nickname", "$firstName", "Unknown"] }
```

### Array Operations

```js
// Status filter
mjsql('$.status in ["active", "pending"]')
// → { $in: ["$status", ["active", "pending"]] }

// Transform array
mjsql("$.prices.map(p => p * 1.1)")
// → { $map: { input: "$prices", as: "p", in: { $multiply: ["$$p", 1.1] } } }

// Filter array
mjsql("$.items.filter(x => x.qty > 0)")
// → { $filter: { input: "$items", as: "x", cond: { $gt: ["$$x.qty", 0] } } }

// Sum array
mjsql("$.amounts.reduce((acc, x) => acc + x, 0)")
// → { $reduce: { input: "$amounts", initialValue: 0, in: { $add: ["$$value", "$$this"] } } }
```

### Date Operations

```js
// Extract year from date field
mjsql("$.createdAt.getFullYear()")
// → { $year: "$createdAt" }

// Days since creation
mjsql("$dateDiff($.createdAt, new Date(), 'day')")
// → { $dateDiff: { startDate: "$createdAt", endDate: { $toDate: "$$NOW" }, unit: "day" } }

// Format date
mjsql('$dateToString($.createdAt, "%Y-%m-%d")')
// → { $dateToString: { date: "$createdAt", format: "%Y-%m-%d" } }
```

### Type Casting

```js
// Convert string to number
mjsql("Number($.stringPrice) * 1.1")
// → { $multiply: [{ $toDouble: "$stringPrice" }, 1.1] }

// Type check
mjsql("typeof $.value == 'string'")
// → { $eq: [{ $type: "$value" }, "string"] }
```

### With Template Tag

```js
const statusFilter = mql`$.status in ${["active", "pending"]}`;
// → { $in: ["$status", ["active", "pending"]] }

const ageFilter = mql`$.age > ${21}`;
// → { $gt: ["$age", 21] }

// Combine using mjsql() for dynamic composition
const combined = mjsql(`$.age > 21 && $.status in ["active", "pending"]`);
// → { $and: [{ $gt: ["$age", 21] }, { $in: ["$status", ["active", "pending"]] }] }
```

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
            | utility_call | math_call | math_const | type_cast | date_new | date_now
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

utility_call  = "$" identifier "(" call_args ")"

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
| 2 | `!`, `-` (unary) | Right |
| 3 | `**` (exponentiation) | Right |
| 4 | `*`, `/`, `%` | Left |
| 5 | `+`, `-` (binary) | Left |
| 6 | `<`, `<=`, `>`, `>=`, `in` | Left |
| 7 | `==`, `!=`, `===`, `!==` | Left |
| 8 | `&&` | Left |
| 9 | `\|\|` | Left |
| 10 | `??` | Left |
| 11 | `? :` (ternary) | Right |

---

## FAQ

**Q: How do I get an array's length?**
A: Use the `$size()` utility: `$size($.items)`. String length uses `.length` property: `$.name.length`.

**Q: Why doesn't `$.field.includes(x)` use `$in` for arrays?**
A: A bare field reference's type is unknown at compile time, so mjsql defaults to string semantics for `.includes()`/`.indexOf()`/`.concat()`. When the receiver is *demonstrably* an array — an array literal, a `.split()` result, a `.map()` result, etc. — mjsql emits the array form. To force array semantics, use `$in($.items, x)` or rebuild the chain so the type is known (e.g. `$.items.map(x => x).includes(target)`).

**Q: Does `?.` actually short-circuit?**
A: For field paths, MongoDB already returns `null`/missing when traversing through missing fields, so `$.a?.b?.c` and `$.a.b.c` produce the same MQL — `?.` is purely a JS-readability sugar.

**Q: How do `Math.max(...$.arr)` and `Math.max($.arr)` differ?**
A: They produce identical MQL (`{ $max: "$arr" }`). The spread form is just JS-natural sugar.

---
