
# Language rules

These are the foundational rules of JSMQL. The **HARD RULES** are invariants the compiler always upholds — a build that breaks one is a bug, not a feature. The **SOFT RULES** are preferences that may have documented exceptions.

## HARD RULES

**HR1 — JSMQL is a strict superset of MQL.** Every valid MQL value is valid JSMQL, and the compiler leaves it unchanged. A raw object literal, array literal, string (including a `$`-prefixed path string), number, boolean, null, Date, RegExp or BigInt passes through as-is in every context. JSMQL adds no `$expr` wrapper and no `$literal` wrapper of its own:

```js
jsmql('{ age: { $gt: 18 } }');         // → { age: { $gt: 18 } }      (a hand-written find filter, untouched)
jsmql.expr('{ a: "$b" }');             // → { a: "$b" }               ("$b" is the field ref $b, as in raw MQL)
jsmql('[{ $match: { a: "$x" } }]');    // → [{ $match: { a: "$x" } }]
```

But non-literal values get compiled:

```js
jsmql.expr('{ year: { $abs: 1900 + $.age } }'); // → { year: { $abs: { $add: [1900, "$age"] } } }
```

A `"$x"` string in your source is the MQL field reference `$x`. To force the literal four-character string, use `$literal("$x")`, exactly as in raw MQL. For safety, a runtime-injected value — a `jsmql.compile` parameter or a template-tag `${…}` interpolation — that looks like `"$x"` still gets a `$literal` wrap in expression position. This stops untrusted input from silently becoming a field reference.

**HR2 — every `$op: value` can be written `$op(value)`, and vice-versa.** The `$op(…)` direct-operator form, also called the escape hatch, takes exactly one argument. `$op(value)` lowers to `{ $op: value }`, and the value stays as plain MQL with no array wrap. The compiler adds the array wrap only when the `$op()` call takes more than one argument, or the argument is not a plain MQL value:

```js
$abs($divide("$cents", 100))    // → { $abs: { $divide: ["$cents", 100] }
$and({ a: 1 }, { b: 2 })        // → { $and: [{ a: 1 }, { b: 2 }] }
$eq(1)                          // ✗ error — "$eq(...) takes 2 arguments" → write $eq(x, y) or $eq([x, y])
```

But non-literal values get compiled:

```js
jsmql.expr('$abs($.cents / 100)');           // → { $abs: { $divide: ["$cents", 100] } }
jsmql.expr('{ year: $abs(1900 + $.age) }');  // → { year: { $abs: { $add: [1900, "$age"] } } }
```

**HR3 — JSMQL never knowingly emits invalid MQL.** The compiler knows the operator registry and the stage shapes. When this knowledge shows that the server would reject the output, the compiler raises an actionable error instead of emitting the MQL object. For the escape hatch, the compiler rejects a list-operand operator when you hand it a non-array value:

```js
$setUnion($.a)          // ✗ error — "$setUnion operates on a list of operands" → write $setUnion($.a, $.b) or $setUnion([$.a, $.b])
$add($.x)               // ✗ error — $add needs an operands array → write $add($.x, $.y) or $add([$.x, $.y])
$round($.x)             // → { $round: "$x" } — because $round supports a single argument when it's a field reference
```

HR3 governs two things: the raw MQL you give the compiler, and the MQL the compiler emits from JS.

**HR4 — the four sigils each mean exactly one scope, always.** `$` = the **root document**, `$$` = the **root stream** (the pipeline's own documents), `$$$` = the current database, `$$$$` = the current server. Each sigil keeps this one meaning at every depth. Inside a body over another collection, for example `$$$.orders.aggregate(o => { … })`, `$` still names the outer document and `$$` still names the root stream. The body has its own document: the callback parameter (`o`). The body has its own stream: the callback's third parameter, for example `(o, _i, coll) => { coll.size() }`. You use each sigil as a source or a destination (`$$ = …`, `$$$.coll = $$`), or to call its methods (`$$$.coll.find(…)`, `$$.filter(…)`). The project calls these sigils context references.

`$` names the root document of the pipeline you write, and it keeps that meaning at every depth. Inside a sub-pipeline — a `$$$.<coll>` chain, an `.aggregate((o) => { … })` block, or a `.filter((o) => …)` predicate — `$.x` still reads the outer document. JSMQL threads this value in through `$lookup.let`. The sub-pipeline has its own document: the callback parameter, or a raw `"$x"` MQL path string. So in one stage body, the two spellings name two different documents:

```js
$.t = $$$.orders.$set({ owner: $.tag });    // → let: { jsmql_f0_tag: "$tag" }, $set: { owner: "$$jsmql_f0_tag" }   ← ROOT doc
$.t = $$$.orders.$set({ owner: "$tag" });   // → $set: { owner: "$tag" }                                            ← the ORDERS doc
```

**HR5 — A dot runs the method on an empty collection. A `?.` gives `null`.**

A method is the name after a dot: `.uniq()`, `.has()`, `.length()`. The value before the dot is the receiver. Each method works on one kind of value. The name of the method says which kind: `.length()` works on a string, `.size()` works on an array, `.pick()` works on an object.

A document can lack the field the receiver names, or the field can hold `null`. This rule says what the method answers in that case. The answer depends on the accessor you wrote before the method name.

**You wrote a dot.** The compiler replaces the missing value with the empty collection of the method's kind: `[]` for an array method, `{}` for an object method. Then the method runs on that empty collection, and the answer is what the MongoDB operator gives for it. So the answer always has the type you expect, and the answer is never `null`. A string method is the exception. For a missing string, a string method answers `null`, because JavaScript raises an error there, and MongoDB has no error to raise inside an expression.

**You wrote `?.`.** The compiler tests the value before the `?.`. If that value is `null` or missing, the whole chain answers `null`, and nothing after the `?.` runs. This is what `?.` does in JavaScript. Each `?.` tests only the value in front of it. A dot after a `?.` follows the dot rule.

```js
// Document: {}   — there is no field `a`
$.a.uniq()          // → { $setUnion: { $ifNull: ["$a", []] } }        → []
$.a.has("red")      // → { $in: ["red", { $ifNull: ["$a", []] }] }     → false
$.a.sum()           // → { $sum: { $ifNull: ["$a", []] } }             → 0
$.a?.uniq()         // → { $cond: { if: { $eq: [{ $ifNull: ["$a", null] }, null] }, then: null, else: { $setUnion: "$a" } } }   → null

// Document: { a: ["x", "x"] }
$.a.uniq()          // → the same MQL as above                          → ["x"]
$.a?.uniq()         // → the same MQL as above                          → ["x"]

// Document: {}   — there is no field `s`
$.s.length()        // → { $cond: { if: { $eq: [{ $ifNull: ["$s", null] }, null] }, then: null, else: { $strLenCP: "$s" } } }   → null

// Document: { a: { c: 1 } }   — `a` is there, but `a` has no field `b`
$.a?.b.uniq()       // → { $cond: { if: { $eq: [{ $ifNull: ["$a", null] }, null] }, then: null, else: { $setUnion: { $ifNull: ["$a.b", []] } } } }   → []
// Document: {}   — the same JSMQL, but there is no field `a`        → null
```

When the compiler can prove that the value is there, it adds no runtime check like `$ifNull`. A `?.` on such a value does the same as a dot.

Two more facts belong to this rule. First, `.indexOf()` and `.lastIndexOf()` work on a string and on an array, because JavaScript has no other spelling for "the position of" in a string. For these two, the type of the receiver decides the operator; when the receiver's type is not known, the type of the argument decides; when neither is known, the emitted MQL tests the type when it runs. Second, every value that JSMQL computes from a receiver is a method call, never a property: write `.length()`, `.size()`, `$$.size()`. So `$.a.length` always reads a field named `length` in your document.

## SOFT RULES

**SR1 — JSMQL guesses what you mean.** A construct can lower in more than one way. JSMQL then picks the reading a developer most likely intends, and accepts the shorter, idiomatic form over the most literal one. This guess stays conservative. When the intent is truly ambiguous, or the likely reading would emit invalid MQL, JSMQL raises an actionable error instead of a wrong guess.

**SR2 — JSMQL gives you the JavaScript *syntax* you know, not the JavaScript *runtime* you know.** JSMQL accepts a JavaScript built-in — a method or a static call you use in plain JS. It then lowers this call to the MQL a MongoDB developer writes by hand for the same task. The notation carries over from JavaScript. The behaviour comes from MongoDB.

The line runs between what you **wrote** and what you **never wrote**:

- **You wrote it** — a negative index, an argument, an operator. JSMQL honours its JavaScript meaning, even when that costs MQL size. A token you typed on purpose is an instruction.
- **You never wrote it** — an ordering, a stability guarantee, or an argument default that the JS or lodash runtime carries on its own. JSMQL then uses MongoDB's behaviour and the smaller MQL. Nobody types `order: "preserve"`, so there is nothing to honour.

```js
$.s.substr(-3, 2)   // honours the -3 you typed: counts from the end, and pays the MQL to do it
$.tags.toSorted()   // MongoDB's numeric order, not JavaScript's lexicographic default
$$ = $$.uniqBy("t") // → $group — MongoDB's order, because you never asked for lodash's
```

When MQL rejects the JavaScript form, JSMQL raises an actionable error. It does not emit a wrapper that hides the constraint. When a behaviour differs, the docs state the difference; JSMQL does not hide it.

A comparison emits the query document a MongoDB developer writes by hand. MongoDB's own rules then apply to it. The query language matches `{ tags: "red" }` against a `tags` array that holds `"red"`, and it traverses an array in the middle of a path. The emitted document does nothing to stop this, because every index plan, every code review and every `explain` output is written against that same document:

```js
$.tags === "red"            // → {"tags":"red"}
$.tags.has("red")           // → {"tags":"red"} — membership in an array, the same document
$.name.includes("red")      // → {"name":{"$regex":/red/}} — a substring of a string
$.items.some(i => i.q > 2)  // → {"items":{"$elemMatch":{"q":{"$gt":2}}}}
$.a.b === 1                 // → {"a.b":1}
```

A comparison that must read one value, not one element, has its own spelling. `.has(x)` tests membership in an array. `.includes(x)` tests a substring of a string. `.some(e => …)` tests one element. The aggregation road — `jsmql.expr`, or a predicate that already needs `$expr` — compares the value itself. Each method reads one kind of value, and its name says which: `.length()` counts the characters of a string, `.size()` counts the elements of an array.

This rule does not allow a guess at a value's type. A `$cond` on `$isArray` appears when the compiler does not know whether a field holds an array or a string. This is missing information, not JavaScript behaviour. Dropping the check would return a wrong answer, not a smaller one.

**SR3 — JSMQL also adds some APIs of its own for brevity and better DX.** A construct can lack a natural JavaScript spelling, above all a nested pipeline. JSMQL then invents a convenience API, rather than leave you in the `$op(…)` escape hatch. To stay unsurprising, it borrows a name developers already know — a MongoDB driver method such as `.aggregate()`, or a widely recognised JavaScript date idiom (`.plus` / `.minus` / `.diff`, as in Temporal or Luxon) — and lowers it to a real MQL operator or stage. It never mints a `$foo()` of its own. The underlying MQL stays reachable by hand, so the sugar is always additive.

```js
$$$.orders.aggregate(…)          // nested sub-pipeline (the driver's own .aggregate)
$$.$count("total")              // → $count stage (a stage link, spelled on the stream)
$.createdAt.plus(7, "day")      // → $dateAdd  (.minus → $dateSubtract)
$.start.diff($.end, "hour")     // → $dateDiff
```
