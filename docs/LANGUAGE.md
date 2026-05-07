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
3. [Comments](#comments)
4. [Field References](#field-references)
5. [Operators](#operators)
6. [String Methods](#string-methods)
7. [Array Methods](#array-methods)
8. [Lambda Functions](#lambda-functions)
9. [Math Functions](#math-functions)
10. [Type Casting](#type-casting)
11. [Date Operations](#date-operations)
12. [Escape Hatch (Direct Operator Form)](#escape-hatch-direct-operator-form)
13. [Pipelines](#pipelines)
14. [Function Form](#function-form)
15. [Template Tag (`mql`)](#template-tag-mql)
16. [Validation](#validation)
17. [Error Messages](#error-messages)
18. [Examples](#examples)

---

## Expressions

An mjsql expression is a **subset of JavaScript** that compiles to MongoDB aggregation expression JSON. Write JS operators, method chains, and lambdas — mjsql handles the translation. For MongoDB operators without a JS equivalent, use the `$op()` escape hatch (the direct operator form).

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
- Escape hatch (direct operator form): `$sampleRate(0.33)`, `$dateTrunc($.createdAt, "day")`, etc.
- Comments: `// line` and `/* block */` — semantics identical to JavaScript

### Invalid Constructs

- Control flow: `if`, `for`, `while`, `break`, etc.
- Statements: function definitions, assignments
- Object/array mutations: `.push()`, `.splice()`
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

## Comments

mjsql accepts JavaScript-style comments and discards them as trivia — they have no effect on the compiled MQL. Both forms are valid anywhere whitespace is.

```js
$.age >= 18  // line comment to end-of-line
$.score /* block comment, can span lines */ * 1.1
```

Semantics match JavaScript exactly: line comments end at any LineTerminator (LF, CR, LSEP, PSEP) or EOF; block comments do not nest (the first `*/` closes), and an unclosed `/* …` is a parse error. Comments inside string literals, regex literals, and template-literal text are character data, not comments.

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

Use square brackets for computed index/key access. The compiled MQL depends on the receiver type:

```js
$.items.map(x => x.id)[0]     // known array → { $arrayElemAt: [{ $map: ... }, 0] }
[1, 2, 3][$.idx]              // known array → { $arrayElemAt: [[1, 2, 3], "$idx"] }
```

For a bare `$.field`, mjsql can't tell at compile time whether you mean array indexing
or object dynamic-key lookup, so it emits a runtime `$cond` on `$isArray` that picks
the right form at query time:

```js
$.items[0]
// → { $cond: [
//       { $isArray: "$items" },
//       { $arrayElemAt: ["$items", 0] },
//       { $getField: { field: 0, input: "$items" } }
//     ] }

$.config["host"]
// → { $cond: [
//       { $isArray: "$config" },
//       { $arrayElemAt: ["$config", "host"] },
//       { $getField: { field: "host", input: "$config" } }
//     ] }
```

If you want compact output, pin the type by chaining a type-fixing method (`.map(x => x)`, `.slice(0)`, `.reverse()`, etc.) or use the `.at(i)` method (always emits `$arrayElemAt`).

### Optional Chaining

`?.` is accepted everywhere `.` is. MongoDB already returns `null`/missing when a dotted path traverses a missing field, so `?.` is purely for JS readability — the compiled MQL is identical to the non-optional form:

```js
$.user?.address?.city                // → "$user.address.city"
$.items?.[0]                         // → same as $.items[0] above (runtime $cond)
$.items.reverse()?.[0]               // → known array → { $arrayElemAt: [{ $reverseArray: "$items" }, 0] }
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

**Precedence** matches JS: `==` / `!=` bind tighter than `&` / `^` / `|`, which bind tighter than `&&` / `||`. So `$.a == $.b & $.c` parses as `($.a == $.b) & $.c`, just like in JavaScript.

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
$.text.matchAll(/word/g)           // { $regexFindAll: { input: "$text", regex: "word", options: "g" } }
$.text.search(/foo/)               // first match index, or -1 (via $regexFind + $ifNull)
$.code.padStart(5, "0")            // padded via $reduce + $range + $concat
$.note.padEnd(10)                  // (default pad char is space)
"-".repeat($.n)                    // $reduce concatenating "-" n times

// Regex receiver methods — equivalent to .match / .search-style calls
/^[a-z]/.test($.s)                 // { $regexMatch: { input: "$s", regex: "^[a-z]" } }
/word/i.exec($.s)                  // { $regexFind: { input: "$s", regex: "word", options: "i" } }

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
$.items.toReversed()       // { $reverseArray: "$items" }            (ES2023, identical to .reverse())
$.scores.toSorted()        // { $sortArray: { input: "$scores", sortBy: 1 } } (ascending)
Array.from({length: 5})    // { $range: [0, 5] }
Array.from({length: 3}, (_, i) => i * 2)
                           // { $map: { input: { $range: [0, 3] }, as: "i", in: <body> } }
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

// reduce — fold to a single value (two-param lambda required)
$.numbers.reduce((acc, x) => acc + x, 0)
// → { $reduce: { input: "$numbers", initialValue: 0, in: { $add: ["$$value", "$$this"] } } }
```

**Note:** In `reduce`, the accumulator and element are mapped to MongoDB's `$$value` and `$$this` variables.

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

### Number static predicates

```js
Number.isInteger($.n)              // true if $.n is int/long, or a double with no fractional part
Number.isNaN($.x)                  // { $ne: ["$x", "$x"] }   — NaN is the only value where x !== x
```

`Number.isFinite()` is **not supported** — MongoDB has no Infinity literal that can be referenced cleanly. For finite-bound checks, write the bounds explicitly (e.g. `$.x > -1e300 && $.x < 1e300`) or use `$convert` with an `onError` clause.

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

For MongoDB operators that have no JavaScript equivalent, use the `$opName()` escape hatch — a direct call to the underlying MQL operator. Every MongoDB aggregation operator is available this way, and unknown operators pass through automatically, making mjsql forward-compatible with new MongoDB releases.

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

Some operators are commonly used as accumulators in `$group` (taking a single field expression) but also work as expression operators in `$project` (taking multiple expressions to compare). mjsql accepts both shapes — pass one argument for the accumulator form, multiple for the expression form:

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

### Bitwise

```js
$bitAnd($.flags, $.mask)           // { $bitAnd: ["$flags", "$mask"] }
$bitOr($.a, $.b)                   // { $bitOr: ["$a", "$b"] }
$bitXor($.a, $.b)                  // { $bitXor: ["$a", "$b"] }
$bitNot($.flags)                   // { $bitNot: "$flags" }
```

### `$literal` — bypass expression evaluation

⚠️ **Watch out:** `$literal` is the only operator whose argument is **not** evaluated as an expression. Use it when you want to keep a value the pipeline would otherwise interpret as a field reference (anything starting with `$`):

```js
$literal("$foo")                   // { $literal: "$foo" }   — the literal string "$foo"
                                   //   (without $literal, "$foo" would mean field foo)
$literal(42)                       // { $literal: 42 }       — equivalent to bare 42
```

### `$meta` — per-document aggregation metadata

⚠️ **Watch out:** `$meta` takes a **keyword string** (`"textScore"`, `"indexKey"`, `"searchScore"`, etc.), not an arbitrary expression. mjsql does not validate the keyword.

```js
$meta("textScore")                 // { $meta: "textScore" }
```

### Custom Aggregation: `$function` and `$accumulator`

⚠️ **Watch out:** the `body`, `init`, `accumulate`, `merge`, and `finalize` fields are **JavaScript source code as a string**, executed by MongoDB's V8 engine on the server. They are NOT mjsql expressions — `$.field` references will not be substituted, and you must pass field values via the `args` / `accumulateArgs` arrays.

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

⚠️ **Watch out:** these are valid only inside the `$setWindowFields` stage. Calling `$rank()` from a `$project` stage produces nonsense MQL — mjsql does not validate the surrounding stage context.

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

## Pipelines

`mjsql()` also compiles **whole aggregation pipelines** — arrays of stage objects like `[{ $match: ... }, { $sort: ... }, { $limit: ... }]`. The same function detects pipeline mode from the input and returns an `object[]` instead of a single `object`. No new exports, no separate API.

### Two equivalent forms

```js
// Stage-call form: terser, reads like JavaScript end-to-end. Recommended
// when you're authoring a new pipeline.
mjsql(`[
  $match($.age > 18),
  $project({ name: 1, total: $.price * $.qty }),
  $group({ _id: $.dept, total: $sum($.salary) }),
  $sort({ total: -1 }),
  $limit(10)
]`);

// Stage-object form: matches the shape MongoDB emits in Compass and the
// docs. Useful when porting an existing pipeline you've copied verbatim.
mjsql(`[
  { $match: $.age > 18 },
  { $project: { name: 1, total: $.price * $.qty } },
  { $group: { _id: $.dept, total: $sum($.salary) } },
  { $sort: { total: -1 } },
  { $limit: 10 }
]`);
```

The two forms compile to the same MQL pipeline and may be mixed in one array. Each stage body is a regular mjsql expression: arithmetic, accumulators, field refs, and method chains all work as they do anywhere else.

### `$match` and `$expr`

In real MongoDB, `$match`'s body can be either a *query document* or an *aggregation expression* — the latter must be wrapped in `$expr`. mjsql does the wrapping for you whenever the body is anything other than a plain object literal:

```js
mjsql("[{ $match: $.age > 18 }]");
// → [{ $match: { $expr: { $gt: ["$age", 18] } } }]   ← auto-wrapped

mjsql("[{ $match: { age: { $gt: 18 } } }]");
// → [{ $match: { age: { $gt: 18 } } }]               ← raw query doc, untouched
```

Use the object-literal form when porting an existing query document; use any expression when you want aggregation operators inside `$match`.

### Sub-pipelines

`$lookup`, `$unionWith`, and `$facet` carry nested pipelines inside their stage body. mjsql recognises these positions and recurses, so `$match`'s `$expr` rule and the strict typo check apply uniformly:

```js
mjsql(`[{
  $lookup: {
    from: "orders",
    let: { uid: $._id },
    pipeline: [
      { $match: $.userId === $$uid },     // gets $expr-wrapped
      { $project: { total: 1 } }
    ],
    as: "userOrders"
  }
}]`);
```

### Detection and typos

A top-level array enters pipeline mode when its first element looks like a stage attempt — a single-`$<name>`-key object literal, or a `$<name>(...)` call. Once pipeline mode is active, every element must be a recognised stage; mistakes surface immediately:

```js
mjsql("[{ $macth: $.age > 18 }]");
// → CodegenError: Element 0 of pipeline: '$macth' is not a known
//                 aggregation stage. Did you mean '$match'?
```

A plain value array like `[1, 2, 3]` is *not* a pipeline — the first element doesn't look like a stage attempt, so mjsql leaves it as a literal array expression.

### What stages are supported?

All 45 stages defined in the MongoDB aggregation spec, including: `$addFields`, `$bucket`, `$bucketAuto`, `$count`, `$densify`, `$documents`, `$facet`, `$fill`, `$geoNear`, `$graphLookup`, `$group`, `$limit`, `$lookup`, `$match`, `$merge`, `$out`, `$project`, `$redact`, `$replaceRoot`, `$replaceWith`, `$sample`, `$search`, `$set`, `$setWindowFields`, `$skip`, `$sort`, `$sortByCount`, `$unionWith`, `$unset`, `$unwind`, `$vectorSearch`, and the rest.

---

## Function Form

In addition to a string, `mjsql()` and `validate()` accept an **arrow function** whose body is the expression. The runtime calls `Function.prototype.toString()`, extracts the body, and runs it through the same parser as the string form:

```js
const { mjsql } = require("mjsql");

mjsql(($) => $.age > 18);
// → { $gt: ["$age", 18] }

mjsql(($) =>
  [$.streetNo, $.street, $.suburb, $.state, $.country, $.postcode]
    .filter((x) => typeof x === "string" && x !== "")
    .map((x) => x.trim())
    .join(" "),
);
// identical MQL to the equivalent template-string form, but prettier and oxfmt
// will indent and line-break it like any other JS — that is the whole point.
```

**Why use it.** JavaScript formatters (prettier, oxfmt) treat template-literal contents as opaque strings. Long mjsql expressions sit as one un-broken line. Wrapping the expression in a plain arrow function lets every JS formatter handle it for free — no plugin, no config.

### Restrictions

- **Arrow functions only.** `function` declarations are rejected. Use `() => …`.
- **Expression-body only.** `() => $.age > 18` works; `() => { return $.age > 18; }` does not.
- **No `async`, no generators.**
- **No outer-scope variables.** `Function.prototype.toString()` returns text, not a closure — values from the surrounding scope are unresolvable. Use the [`mql` template tag](#template-tag-mql) when you need to interpolate a value:
  ```js
  const minAge = 21;
  mjsql(($) => $.age > minAge);   // ❌ error: Unknown identifier 'minAge'
  mql`$.age > ${minAge}`;         // ✓ works — value is interpolated
  ```
- **The wrapper's parameter is not bound inside the body.** `($) =>` is the recommended idiom because `$` is also the document context, but other names (`(doc) =>`) act as a typing/IDE hook only — `doc.foo` in the body resolves as an unknown identifier, not as `$.foo`.

When an unknown identifier is encountered in the function-form path, the error message also points at the `mql` tag as the right tool for closure interpolation.

### Escape-hatch operators (`$op` destructure)

Direct `$op(...)` calls (e.g. `$dateDiff`, `$sampleRate`, `$stdDevPop`) work inside the function body, but TypeScript / your IDE will flag the operator name as an unknown identifier. To silence that warning, destructure the operators you use from the function's optional second parameter:

```js
mjsql(($, { $dateDiff }) =>
  $dateDiff({ startDate: $.lastLoginAt, endDate: new Date(), unit: "day" }) ?? -1,
);
```

The second parameter is types-only — the destructured names are typed as callables but never evaluated. The runtime strips the parameter list before parsing, so the body is identical to writing the call directly. Any `$`-prefixed name destructured from the second parameter is accepted by the type system; whether it is a real MongoDB operator is checked at compile time by the codegen.

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
A: Use `.length`: `$.items.length` works for both arrays and strings (mjsql dispatches by receiver type). The `$size()` escape hatch is also available if you want to force the array form: `$size($.items)`.

**Q: Why doesn't `$.field.includes(x)` use `$in` for arrays?**
A: A bare field reference's type is unknown at compile time, so mjsql defaults to string semantics for `.includes()`/`.indexOf()`/`.concat()`. When the receiver is *demonstrably* an array — an array literal, a `.split()` result, a `.map()` result, etc. — mjsql emits the array form. To force array semantics, use `$in($.items, x)` or rebuild the chain so the type is known (e.g. `$.items.map(x => x).includes(target)`).

**Q: Does `?.` actually short-circuit?**
A: For field paths, MongoDB already returns `null`/missing when traversing through missing fields, so `$.a?.b?.c` and `$.a.b.c` produce the same MQL — `?.` is purely a JS-readability sugar.

**Q: How do `Math.max(...$.arr)` and `Math.max($.arr)` differ?**
A: They produce identical MQL (`{ $max: "$arr" }`). The spread form is just JS-natural sugar.

---
