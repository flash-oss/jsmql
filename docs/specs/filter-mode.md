# Filter mode (no-semicolon dispatch)

## What this covers

The rule that turns a program into a MongoDB **Filter** (the document `db.coll.find(filter)` takes) rather than a **Pipeline** (the stage array `db.coll.aggregate(pipeline)` takes), and the road that lowers a filter.

Terminology follows the Node.js MongoDB driver: **Filter** for `find()`, **Pipeline** for `aggregate()`.

User-facing reference: [docs/LANGUAGE.md → Output dispatch](../LANGUAGE.md#output-dispatch-filter-vs-pipeline).

## The decision

`shapeOf` in [src/compiler/passes/shape.ts](../../src/compiler/passes/shape.ts) decides which of the two documents a program becomes. It decides once, for the WHOLE program. The decision does not come from punctuation: `$.a = 1` is a pipeline with no `;` in it, and `const a = 1; $.x === a` is a filter with two.

| Program | Shape | Why |
|---|---|---|
| a write (`$.x = …`, `delete $.x`), a `let` / `const` / function declaration, a `;`-separated run | pipeline | a statement by its node type |
| a chain on a context reference (`$$.filter(…)`, `$$$.orders.find(…)`, `$$ = …`) | pipeline | a stream is a pipeline wherever it stands |
| a name whose row has a `statement` or `stream` form and NO value form (`$match(…)`, `{ $match: … }`) | pipeline | a stage is not a value |
| `Object.assign($.p, …)` / `Object.assign(binding, …)` | pipeline | it writes its first argument; a merged object is truthy, so as a filter it would keep every document |
| a mutator (`.sort()`, `.push(…)`, …) on a receiver that is NOT a place — a call in the middle (`$.items.filter(p).sort()`), a literal (`[3, 1, 2].sort()`) | filter | a mutator is a write, and a fresh array is nothing to write to; so the chain is a value, and the value road refuses it by name (`.toSorted()`) instead of naming an entry that refuses it too |
| declarations followed by ONE expression (`const cutoff = 18; $.age > cutoff`) | filter | a prelude the fold inlines, then the filter |
| a bracketed literal | its FIRST element decides | `[$match(…), 1]` is a pipeline that refuses element 1; `[1, $match(…)]` an array |
| anything else — a predicate, a value, a raw `{ … }` document | filter | |

`src/index.ts` reads the shape and lowers through the matching road; the strict entries (`jsmql.filter`, `jsmql.pipeline`, `jsmql.expr`, `jsmql.update`) refuse the other shape and name the entry that takes it ([strict-shape-entries.md](strict-shape-entries.md)).

## The filter road

[src/compiler/emit/filter.ts](../../src/compiler/emit/filter.ts) lowers a filter; the same road lowers a `$match` body, so `find()` and `$match` produce the same document for the same input. The rules apply in this order:

1. **A raw document passes through (HR1).** A top-level `{ … }` is the developer's own query document: `{ age: { $gt: 18 } }` → `{ age: { $gt: 18 } }`, untouched. A `$op(…)` call with a query form (`$exists($.a)`, `$gt($.a, 1)`, `$regex($.s, "x", "i")`) lowers to its query clause — MongoDB's reading, with no array exclusion.
2. **A raw value that holds a READ has no query form.** The query language compares a field with a CONSTANT, so `$.b` written into a query slot is the two-character string `"$b"`, and the filter matches nothing. Such a value takes the expression road whole: `{ a: [1, $.b] }` → `{ $expr: { $eq: ["$a", [1, "$b"]] } }`. JSMQL asks the question at every depth — an array, a document, and any nesting of the two — so `{ a: $.b }`, `{ a: [{ x: $.b }] }` and `{ a: { x: { y: $.b } } }` are one case. An operator whose operand is read at run time takes the expression twin its row states in `liftsTo` (`$nin` states `$in` negated, because the expression language has no `$nin`); JSMQL refuses an operator that states none, and names the rewrite, because a document-shaped body such as `$elemMatch`'s admits no `$expr` at all. The two spellings of one operator agree here: `{ a: { $gte: $.since } }` and `{ a: $gte($.since) }` both lift. A value with no read in it stays untouched under rule 1.
3. **A JavaScript spelling becomes the plain query clause.** Every field-vs-constant pair the query language can express becomes the document a MongoDB developer reads and writes: `$.age > 18` → `{ age: { $gt: 18 } }`, `$.s === "a"` → `{ s: "a" }`, `$.x !== null` → `{ x: { $not: { $type: "null" } } }`. MongoDB's own rules then apply to it — a missing field counts as null, and an array matches element-wise — which is the boundary [LANG_RULES.md](../LANG_RULES.md) draws between JS syntax and MongoDB behaviour. This uses the index on the field.
4. **A query document is read through an INDEX, so a boolean method takes its indexable form.** Each method has one receiver family, and its row states the query clause for a literal argument: `$.tags.has("x")` → `{ tags: "x" }`, MongoDB's "equals, or is an array containing"; `$.name.includes("x")` → `{ name: { $regex: /x/ } }`, the substring test; `.startsWith` and `.endsWith` anchor the regex. A run-time argument cannot go into a pattern or a clause, so it takes rule 7. `test/query-expr-agreement.test.ts` contracts that the two roads select the same documents.
5. **`&&` merges clauses on distinct fields into one document**; a repeated field, or a clause with no native form, rides in `$expr`.
6. **`||` lowers per branch.** JSMQL lowers each branch on its own, so a native branch stays native beside an `$expr` branch: `$.tags === "red" || $.qty * $.price > 100` → `{ $or: [{ tags: "red" }, { $expr: { $gt: … } }] }`. A leaf's form never changes because of a sibling.
7. **Anything without a native form is `{ $expr: <expression> }`** — a method call (`$.name.trim() === "alice"`), a field-to-field comparison (`$.a === $.b`), a value that is not a predicate (`$.a + $.b`, lowered as the JavaScript truthiness test). `$expr` is a legal top-level filter operator, so the output is always a valid filter.

The per-operator query cells (`filter` on each row in [src/registry/names.ts](../../src/registry/names.ts)) state the native forms; [emit-pass.md § The filter road](emit-pass.md) holds the full table and the measured divergences from the expression road.

## Stage calls without a `;`

A single stage call (`$match($.age > 18)`) or a single stage document (`{ $match: … }` — the form a copy from Compass produces) is a pipeline by the table above, so `jsmql("$match($.age > 18)")` produces `[{ $match: { age: { $gt: 18 } } }]` — the same output as the `;` form. `jsmql.expr()` does not take a stage: its contract is a raw aggregation expression, and a stage is not one.

## Function form

The parser reads an arrow's body shape: an expression body (`({ $ }) => <expr>`) is the program that expression is, a block body (`({ $ }) => { stmt; stmt; }`) is a `Pipeline` program. The shape rule then applies to the program exactly as it does to a string.

## Edge cases

- **`$expr` in filters is legal.** MongoDB accepts `{ $expr: <aggExpr> }` at the top level of a filter, so the residual wrapping is always safe.
- **Source `$`-strings pass through; no automatic `$literal` (HR1).** A `"$y"` typed in source is the field path `$y` everywhere — in a query slot (`$.x === "$y"` → `{ x: "$y" }`, which the server compares as a string, as any query value) and in the `$expr` residual (`$concat($.a, "$b") === $.c` → `{ $expr: { $eq: [{ $concat: ["$a", "$b"] }, "$c"] } }`). The one wrap is HR1's gate for a value that arrives at run time — a `jsmql.compile` parameter, a template `${…}` — which `injectedNeedsLiteral` in [src/compiler/emit/env.ts](../../src/compiler/emit/env.ts) wraps in `$literal` wherever the server would evaluate it, and leaves as written in a query slot.
- **`new Date(<constant args>)` is folded** in a query slot: `$.createdAt >= new Date("2026-01-01")` lowers to `{ createdAt: { $gte: <Date> } }`, never `{ $gte: { $toDate: … } }` — the query language would read that as a literal sub-document and match nothing.
- **`$.tags.length < 5` is an `$expr`.** `.length` has no query form: it is a value (`$size` on an array, `$strLenCP` on a string — the dual-receiver `$switch`), so the comparison rides in `$expr`.
- **A write is a pipeline.** `$.x = …` and `delete $.x` are statements by the table above; `jsmql()` returns the `$set` / `$unset` pipeline, `jsmql.update()` the update document ([update-filter.md](update-filter.md)).

## Compile and validate

`jsmql.compile(fn)(params)` and `jsmql.validate(input)` run the same passes, so a parameterised or validated program takes exactly the shape one of the one-shot call forms would give it.
