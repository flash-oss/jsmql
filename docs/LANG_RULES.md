
# Language rules

These are the foundational rules of jsmql. The **HARD RULES** are invariants the compiler always upholds — a build that breaks one is a bug, not a feature. The **SOFT RULES** are preferences that may have documented exceptions.

## HARD RULES

**HR1 — jsmql is a strict superset of MQL.** Any valid MQL is valid jsmql, and the compiler leaves it unchanged. Raw object/array literal, string including `$`-prefixed path string), number, boolean, null, Date, RegExp, BigInt pass through verbatim in all contexts. JSMQL adds no `$expr` or `$literal` wrappers of its own:

```js
jsmql('{ age: { $gt: 18 } }');         // → { age: { $gt: 18 } }      (a hand-written find filter, untouched)
jsmql.expr('{ a: "$b" }');             // → { a: "$b" }               ("$b" is the field ref $b, as in raw MQL)
jsmql('[{ $match: { a: "$x" } }]');    // → [{ $match: { a: "$x" } }]
```

But non-literal values get compiled:

```js
jsmql('{ year: { $abs: 1900 + $.age } }'); // → { year: { $abs: { $add: [1900, "$age"] } } }
```

A `"$x"` string you type in source is the MQL field reference `$x`. To force the *literal* four-character string, use `$literal("$x")` — exactly as you would in raw MQL. (For safety, **runtime-injected** values — `jsmql.compile` params and template-tag `${…}` interpolations — that look like `"$x"` are still wrapped in `$literal` in expression position, so untrusted input can't silently become a field reference.)

**HR2 — every `$op: value` can be written `$op(value)`, and vice-versa.** The `$op(…)` direct-operator form (AKA the escape hatch) takes **exactly one argument**, and `$op(value)` lowers to `{ $op: value }` with the value left as plain MQL — no array wrapping. The array wrapping happens when an `$op()` function got more than one argument, or the argument is not a plain MQL value:

```js
$abs($divide("$cents", 100))    // → { $abs: { $divide: ["$cents", 100] }
$and({ a: 1 }, { b: 2 })        // → { $and: [{ a: 1 }, { b: 2 }] }
$eq(1)                          // ✗ error — "$eq(...) takes 2 arguments" → write $eq(x, y) or $eq([x, y])
```

But non-literal values get compiled:

```js
jsmql('$abs($.cents / 100)');           // → { $abs: { $divide: ["$cents", 100] }
jsmql('{ year: $abs(1900 + $.age) }');  // → { year: { $abs: { $add: [1900, "$age"] } } }
```

**HR3 — jsmql never knowingly emits invalid MQL.** When the compiler can tell from what it knows (the operator registry, stage shapes) that the server would reject its output, it raises an actionable error instead of emitting the MQL object. For the escape hatch specifically, a list-operand operator handed a non-array value is rejected rather than emitted:

```js
$setUnion($.a)          // ✗ error — "$setUnion operates on a list of operands" → write $setUnion($.a, $.b) or $setUnion([$.a, $.b])
$add($.x)               // ✗ error — $add needs an operands array → write $add($.x, $.y) or $add([$.x, $.y])
$gt($.x)                // → { $gt: "$x" } — because a $gt value can be a single argument or an array of 2 items
$round($.x)             // → { $round: "$x" } — because $round supports a single argument when it's a field reference
```

HR3 governs both: the raw MQL given to it and the MQL it emits by compiling JS to MQL.

**HR4 — the four sigils each mean exactly one scope, always.** `$` = the current document, `$$` = the current collection/stream, `$$$` = the current database, `$$$$` = the current server. They never mean anything else. Each is used either as a source/destination (`$$ = …`, `$$$.coll = $$`) or to call its methods (`$$$.coll.find(…)`, `$$.filter(…)`). Known as context references.

## SOFT RULES

**SR1 — jsmql is trying to guess what you mean.** When a construct could lower more than one way, jsmql leans toward the reading a developer most likely intended, accepting the shorter, idiomatic form over the most literal one. The guessing stays conservative: where intent is genuinely ambiguous, or the likely reading would emit invalid MQL, it raises an actionable error rather than guess wrong.

**SR2 — a native JavaScript API behaves as its JavaScript self.** When jsmql accepts a JS built-in — a method (`.map`, `.filter`, `.trim`, `.slice`) or a static (`Math.max`, `Number.isInteger`) — it lowers to MQL that reproduces the JavaScript behaviour and never repurposes that name to mean something else. Best-effort: where MQL can't match the JavaScript semantics exactly (e.g. how `null` or a missing field is handled), the divergence is documented, not hidden. This covers named APIs only, not operators — `+`, `==`, `===` already diverge from JS (string `+` concatenates in JS, but jsmql's `+` is `$add`). jsmql also adds some APIs of its own for brevity.

```js
$.name.trim().toLowerCase()  // → { $toLower: { $trim: { input: "$name" } } }   (same result as JS)
$.items.map(x => x * 1.1)    // → { $map: { input: "$items", as: "x", in: { $multiply: ["$$x", 1.1] } } }   (same as Array.prototype.map)
```
