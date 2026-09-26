# Language rules

This file gives the basic rules of JSMQL. There are two types of rule:

- A **HARD RULE** is always true. The compiler obeys each hard rule in every build. A build that breaks a hard rule has a bug, not a new feature.
- A **SOFT RULE** tells what JSMQL usually does. A soft rule can have exceptions. The documentation states each exception.

## HARD RULES

**HR1 — JSMQL is a strict superset of MQL.** Each valid MQL value is also valid JSMQL. The compiler does not change it, in any position. This is true for an object, an array, a string, a number, a boolean, `null`, a Date, a RegExp and a BigInt. The rule also applies to a string that starts with `$`. JSMQL adds no `$expr` wrapper and no `$literal` wrapper of its own:

```js
jsmql('{ age: { $gt: 18 } }');         // → { age: { $gt: 18 } }      // a find filter that you wrote: no change
jsmql.expr('{ a: "$b" }');             // → { a: "$b" }               // "$b" is the field path, as in raw MQL
jsmql('[{ $match: { a: "$x" } }]');    // → [{ $match: { a: "$x" } }]
```

The compiler lowers only the parts that are not plain MQL:

```js
jsmql.expr('{ year: { $abs: 1900 + $.age } }'); // → { year: { $abs: { $add: [1900, "$age"] } } }
```

In your source, the string `"$x"` is the MQL field path `$x`. To get the string itself, write `$literal("$x")`, as in raw MQL.

A value that your program passes in is different. There are two types of such a value: a `jsmql.compile` parameter, and a `${…}` value in a template tag. Such a value can read as MQL, for example the string `"$x"`. In an expression, the compiler then puts the value in `$literal`. This is a safety rule: untrusted input cannot become a field path.

**HR2 — `$op(value)` and `{ $op: value }` are two spellings of the same MQL.** The escape hatch is the `$op(…)` form. It calls a MongoDB operator by its name. `$op(value)` lowers to `{ $op: value }`. The compiler does not put the value in an array. Two or more arguments become an array: `$op(a, b)` lowers to `{ $op: [a, b] }`.

```js
$abs($divide("$cents", 100))    // → { $abs: { $divide: ["$cents", 100] } }
$and({ a: 1 }, { b: 2 })        // → { $and: [{ a: 1 }, { b: 2 }] }
$eq(1)                          // ✗ "'$eq(expr1, expr2)' requires exactly 2 arguments, got 1" → write $eq(x, y) or $eq([x, y])
```

The compiler lowers each argument that is not plain MQL:

```js
jsmql.expr('$abs($.cents / 100)');           // → { $abs: { $divide: ["$cents", 100] } }
jsmql.expr('{ year: $abs(1900 + $.age) }');  // → { year: { $abs: { $add: [1900, "$age"] } } }
```

**HR3 — JSMQL never emits MQL that it knows is invalid.** The registry gives the compiler the shape of each operator and each stage. When a shape shows that the server rejects an output, the compiler does not emit that output. It throws an error that names the fix.

The count of operands is one such shape. `$divide` takes exactly two operands, so the server rejects one. `$add` takes one or more, so one operand is valid MQL:

```js
$divide(10)             // ✗ "'$divide(dividend, divisor)' requires exactly 2 arguments, got 1" → write $divide(a, b) or $divide([a, b])
$add($.x)               // → { $add: "$x" }   // the server reads "$x" as the one operand
$round($.x)             // → { $round: "$x" }   // $round accepts one operand, because its place operand is optional
```

HR3 applies to two sources of MQL: the raw MQL that you write, and the MQL that the compiler emits from JavaScript. So `{ $divide: 10 }` gets the same error, and `{ $add: "$x" }` passes unchanged (HR1).

**HR4 — Each of the four sigils names one scope, at every depth.** The four sigils are the context references:

| Sigil | Scope |
|---|---|
| `$` | the root document |
| `$$` | the root stream: the documents of the pipeline that you write |
| `$$$` | the current database |
| `$$$$` | the current server |

A body that reads another collection does not change these meanings. In `$$$.orders.aggregate(o => { … })`, `$` is still the root document, and `$$` is still the root stream. The body has its own document: the callback parameter, here `o`. The body also has its own stream: the third parameter of the callback. For example, in `(o, _i, stream) => { o.n = stream.size(); }`, `stream` is the stream of the body.

You use a sigil in one of two ways:

- as a source or a destination, for example `$$ = …` or `$$$.archive = $$`
- as the receiver of a method, for example `$$.filter(…)` or `$$$.orders.find(…)`

Inside a sub-pipeline, `$.x` still reads the root document. A sub-pipeline is, for example, a `$$$.<coll>` chain, an `.aggregate((o) => { … })` body or a `.filter((o) => …)` predicate. The compiler passes the value from the root document into the sub-pipeline through `$lookup.let`. The sub-pipeline has two spellings for its own document: the callback parameter, and a raw `"$x"` field path. So in one stage body, `$.tag` and `"$tag"` name two different documents:

```js
$.t = $$$.orders.$set({ owner: $.tag });    // → let: { jsmql_f0_tag: "$tag" }, $set: { owner: "$$jsmql_f0_tag" }   ← the root document
$.t = $$$.orders.$set({ owner: "$tag" });   // → $set: { owner: "$tag" }                                            ← the document from orders
```

**HR5 — A dot runs the method on an empty array or object. A `?.` gives `null`.**

A method is a call after a dot, for example `.uniq()`. The value before the dot is the receiver. Each method works on one kind of value, and its name tells which kind. For example, `.length()` works on a string, `.size()` works on an array, and `.pick()` works on an object.

The field that the receiver names can be missing from the document, or it can hold `null`. This rule tells what the method gives in these two cases. The answer depends on the accessor before the method name: a dot or `?.`.

**You wrote a dot.** The compiler replaces a missing or `null` receiver with an empty array or object, to match the kind of the method: `[]` for an array method, and `{}` for an object method. The method then runs on that empty array or object. The answer is what the MongoDB operator gives for it. So the answer always has the type that you expect, and it is never `null`.

A string method is the exception. On a missing or `null` string, a string method gives `null`. The reason is that JavaScript throws an error here, and MongoDB has no error to throw inside an expression.

**You wrote `?.`.** The compiler tests the value before the `?.`. When that value is missing or `null`, the whole chain gives `null`, and nothing after the `?.` runs. This is what `?.` does in JavaScript, with `null` in place of `undefined`. Each `?.` tests only the value before it. A dot after a `?.` obeys the dot rule.

```js
// The document is {}. It has no field `a`.
$.a.uniq()          // → { $setUnion: { $ifNull: ["$a", []] } }        → []
$.a.has("red")      // → { $in: ["red", { $ifNull: ["$a", []] }] }     → false
$.a.sum()           // → { $sum: { $ifNull: ["$a", []] } }             → 0
$.a?.uniq()         // → { $cond: { if: { $eq: [{ $ifNull: ["$a", null] }, null] }, then: null, else: { $setUnion: "$a" } } }   → null

// The document is { a: ["x", "x"] }.
$.a.uniq()          // → the same MQL as above                          → ["x"]
$.a?.uniq()         // → the same MQL as above                          → ["x"]

// The document is {}. It has no field `s`.
$.s.length()        // → { $cond: { if: { $eq: [{ $ifNull: ["$s", null] }, null] }, then: null, else: { $strLenCP: "$s" } } }   → null

// The document is { a: { c: 1 } }. The field `a` is there, but `a` has no field `b`.
$.a?.b.uniq()       // → { $cond: { if: { $eq: [{ $ifNull: ["$a", null] }, null] }, then: null, else: { $setUnion: { $ifNull: ["$a.b", []] } } } }   → []

// The document is {}. It has no field `a`.
$.a?.b.uniq()       // → the same MQL as above                          → null
```

When the compiler can prove that the receiver is there, it adds no check, for example no `$ifNull`. On such a receiver, `?.` gives the same MQL as a dot.

Two more facts belong to this rule:

1. `.indexOf()` works on a string and on an array, because JavaScript has no other spelling for the position of a value in a string. The compiler selects the operator in this sequence:
   1. When the compiler knows the type of the receiver, that type selects the operator.
   2. If not, the argument can select the operator. `$indexOfCP` searches only for a string, so an argument that is not a string selects the array operator.
   3. If neither selects the operator, the emitted MQL tests the type when it runs.
2. Each value that JSMQL computes from a receiver is a method call, never a property. Write `.length()`, `.size()` and `$$.size()`. So `$.a.length` always reads the field `length` of your document.

## SOFT RULES

**SR1 — JSMQL guesses what you mean.** Sometimes a construct can lower in more than one way. Then JSMQL selects the meaning that a developer most probably intends. It accepts the short, idiomatic form, and does not ask for the most literal form. The guess is careful. The compiler does not guess when the meaning is not clear, or when the probable meaning gives invalid MQL. In these cases, it throws an error that names the fix.

**SR2 — JSMQL gives you the JavaScript *syntax* you know, not the JavaScript *runtime* you know.** JSMQL accepts a JavaScript built-in, for example a method or a static call that you use in plain JavaScript. The compiler lowers the call to the MQL that a MongoDB developer writes by hand for the same task. The notation comes from JavaScript. The behaviour comes from MongoDB.

The rule separates what you **wrote** from what you **never wrote**:

- **You wrote it**, for example a negative index, an argument or an operator. JSMQL keeps its JavaScript meaning, even when this makes the MQL larger. You typed the token on purpose, so it is an instruction.
- **You never wrote it**, for example an element order, a stability guarantee, or the default value of an argument. The JavaScript runtime or lodash adds these on its own. For these, JSMQL uses the behaviour of MongoDB and the smaller MQL. Nobody types `order: "preserve"`, so JSMQL has nothing to keep.

```js
$.s.substr(-3, 2)   // you typed -3, so the count starts at the end, and the MQL is larger
$.tags.toSorted()   // MongoDB's order (9 before 10), not the text order of JavaScript (10 before 9)
$$.uniqBy("t")      // → $group: MongoDB's order, because you never asked for the order of lodash
```

Sometimes MQL rejects the JavaScript form. Then the compiler throws an error that names the fix. It does not emit a wrapper that hides the limit of MQL. When a behaviour of MongoDB is different from JavaScript, the documentation states the difference. JSMQL does not hide it.

For a comparison, the compiler emits the query document that a MongoDB developer writes by hand. The rules of MongoDB then apply to that document. For example, the query `{ tags: "red" }` matches a `tags` array that holds `"red"`. The query language also traverses an array in the middle of a path. The compiler adds nothing to prevent this, because each index plan, each code review and each `explain` output works with this plain document:

```js
$.tags === "red"            // → { tags: "red" }
$.tags.has("red")           // → { tags: "red" }                               // membership in an array: the same document
$.name.includes("red")      // → { name: { $regex: /red/ } }                   // a substring of a string
$.items.some(i => i.q > 2)  // → { items: { $elemMatch: { q: { $gt: 2 } } } }
$.a.b === 1                 // → { "a.b": 1 }
```

Each intent has its own spelling:

- `.has(x)` tests if an array holds `x`.
- `.includes(x)` tests if a string holds the substring `x`.
- `.some(e => …)` tests if one element of an array matches.
- To compare the whole value, and not one element, use the aggregation road. This road is `jsmql.expr`, or a predicate that needs `$expr` for another reason.

This rule does not let the compiler guess the type of a value. Sometimes the compiler does not know if a field holds an array or a string. Then the MQL tests the type when it runs, for example with `$isArray`. This test replaces information that the compiler does not have. It is not a JavaScript behaviour. Without the test, the answer is wrong, not smaller.

**SR3 — JSMQL adds some APIs of its own, to make your code shorter and clearer.** Some constructs have no natural spelling in JavaScript. A nested pipeline is the main example. For such a construct, JSMQL gives a convenience API, so that you do not need the escape hatch. The API uses a name that developers already know, so that it causes no surprise:

- a method of the MongoDB driver, for example `.aggregate()`
- a date method from a well-known JavaScript library, for example `.plus()` from Luxon

The compiler lowers each such API to a real MQL operator or stage. It never invents a `$foo()` operator. The MQL stays available, and you can write it by hand. So each API adds a spelling, and removes nothing.

```js
$$$.orders.aggregate(…)         // a nested sub-pipeline: the driver's own .aggregate()
$$.$count("total")              // → the $count stage, called as a method of the stream
$.createdAt.plus(7, "day")      // → $dateAdd   (.minus() → $dateSubtract)
$.start.diff($.end, "hour")     // → $dateDiff
```
