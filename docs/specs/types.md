# The type tracker

The compiler proves a type for every value it touches: a field the program
writes, a `let`, a callback parameter, a call's result. It carries that proof to
every later read, and each consumer emits the smallest document the proof allows.
This spec is the single source of truth for the model, the sources of a proof, the
rules that combine two proofs, and each consumer's rule. The user-facing rule and
its examples live in [LANGUAGE.md § Type-aware dispatch](../LANGUAGE.md#type-aware-dispatch).

A proof is never a guess. The compiler answers `ANY` wherever the registry and the
program cannot show a type, and a consumer then emits the runtime form it emits
today. So the tracker only ever removes a test that cannot fail; it never adds an
assumption.

## The model

`Type` in [src/registry/vocabulary.ts](../../src/registry/vocabulary.ts) is one
record for every proof:

| Field | Holds |
|---|---|
| `kinds` | The set of `Kind` values the value can have, or `"any"` when nothing is proven. A set, because `c ? "a" : [1]` is a string or an array, and a dispatch over two kinds still beats a dispatch over every kind. |
| `absent` | `true` when the value may be null or missing. One flag for both: every guard the compiler writes folds the two with `$ifNull`, and the truthiness rule reads them alike. |
| `element` | What one element is, when `kinds` holds `array`. |
| `items` | What each position holds, when the array has a fixed length — an `.entries()` pair. |
| `props` | The properties the compiler has seen, when `kinds` holds `object`. |
| `open` | `true` when the object may hold properties `props` does not name. |
| `values` | What a property `props` does not name holds, when `open` — a `.groupBy()` record. |

Three proofs have names in [src/compiler/emit/type.ts](../../src/compiler/emit/type.ts):
`ANY` (nothing known), `NOTHING` (certainly null or missing: a `null` literal, a
closed object's property nobody wrote), and `DOCUMENT` (a present, open object
nothing else is known about: the root document, a foreign collection's document).

### The algebra

`type.ts` holds every operation over two proofs. It reads no node and no row.

- **`join(a, b)`** — one of `a` or `b`: the branches of a `? :`, the operands of
  `??`, `&&` and `||` read as values. The kinds unite, `absent` is either's,
  elements and properties join pairwise. A branch that is `NOTHING` makes the
  other maybe-absent.
- **`merge(a, b)`** — `{ ...a, ...b }`: `b`'s properties win. An open `b` may hold
  any of `a`'s names, so those join with `b`'s unnamed value. A `b` that may be
  absent spreads as `{}`, so its properties may be missing. MEASURED:
  `$mergeObjects` skips a null operand.
- **`propOf(t, name)`** — property `name` of a value. A closed object without it
  holds `NOTHING`. A value that may be an array reads the property of every
  element, as an array: MEASURED, `"$a.b"` over `a: [{ b: 1 }, { b: 2 }]` is
  `[1, 2]`. So `propOf` joins the object's property with an array of the element's.
- **`at(doc, path)`** — `propOf` along a dotted path; `""` is the document.
- **`written(doc, path, value)`** and **`removed(doc, path)`** — the write rules below.
- **`evaluate(expr, site)`** — a row's `returns` term at one call site, below.

## The sources

### The document

`Env.documents` holds one document `Type` per document level: index 0 is the root
pipeline's document, and each body over another collection (`$lookup`,
`$graphLookup`) adds one, the same levels `Binding.level` counts. A `FieldRef`
reads level 0 at every depth, because `$` is the root document (HR4). A
document-kind binding (a stream callback's parameter) reads its own level.

**The write rules.** The statement target records each write of `$.<path> = v`
on the document, right after the write, so the next op in the same statement and
every later statement read it. The `$set` grouping already ends a group when a
later write reads a path an earlier write touched, so the proof and the stage
order agree.

1. **A whole-field write replaces the field's proof.** `$.a = <string>` makes `a`
   a string, with the value's `absent`, and any properties recorded under `a` are
   gone.
2. **A dotted write keeps the parent's other properties.** `$.address.full = <s>`
   makes `address` a present object, open when it was not known, with `full` set
   inside it. MEASURED with `{ $set: { "a.b": 1 } }`: a scalar, null or missing `a`
   becomes `{ b: 1 }`; an object `a` keeps its other fields; an **array** `a` gets
   `b` written into every element, so `[1, 2]` becomes `[{ b: 1 }, { b: 1 }]`. So
   a dotted write into a parent that may be an array proves the parent an object
   OR an array whose elements carry the property, and a read of `a.b` then proves
   a number or an array of numbers.
3. **`delete $.a`** removes the property. On an open document the property becomes
   `NOTHING`; on a closed one it is gone.
4. **A write of a join** (`$.o = $$$.c.filter(p)`) proves `o` what the join
   proves, below: a present array of the body's documents; a `.find` may find
   nothing, so it proves a maybe-absent document.
5. **A stage that replaces the document** takes every proof about it away: the
   document on that level is `DOCUMENT` again. The same reset runs inside a
   statement, so a write after `$ = …` in the same statement lands on a fresh
   document. Which stages replace the document is the `document` fact below.

### A binding

`Binding.type` carries what the value proved. A `let` or `const` takes its
value's proof. `x = <value>` on a `let` gives it the new value's proof from that
statement on: JSMQL has no `if` and no loop at statement level, so a binding's
type is one straight line. A `let` a document-replacing stage dropped and then
assigned again is revived with the new value's proof.

A `const` whose value is a chain over another collection takes the join's proof,
below.

A callback parameter takes the receiver's element proof through the row's
`binds`. A declared function is inlined per call, so its parameter takes the
argument's proof at that call. A parameter carries its own presence: an element
the receiver proves present (`Object.keys(o)`, `.split()`, a literal) is
present, because `$map` over a null receiver never runs the body; an element of
an unproven array may be null. So `Object.keys(counts).map(ObjectId)` is a
present array of present ObjectIds, and `[1, 2, 3].map(i => $.m[i])` reads the
key with no `$ifNull`.

### A join

A chain over another collection (`$$$.<coll>.<links>`) lowers to a `$lookup`
whose body is the peeled links, and the value is the rest of the chain over the
`as` array ([join.ts](../../src/compiler/emit/join.ts)). The body's documents are
the other collection's, `DOCUMENT`, run through the body's stages by
`documentAfter` — so a `.pick([...])` link (a `$project`) closes the element, a
`.flatMap("f")` link (an `$unwind`) types it by the field, and a `.countBy()`
link (two `$group`s and a `$replaceWith`) makes it a record of numbers. The
joined value is then the array of those documents, present, because the server
always writes `as`; one such document, maybe absent, after a `.find`; or the one
collapsed document, present, because the unwrap answers `{}` for nothing. The
rest of the chain is proven over that slot, and the chain's node carries the
answer (`Chain.proved`) so the statement that binds or writes it reads the same
proof. A raw `$lookup` stage, and each `$facet` key, fold their own `pipeline`
the same way.

```js
const ids = $$$.orders.filter({ status: "a" }).map("pid").uniq();  $.hit = ids.has("x");
// → [{ $lookup: { from: "orders", pipeline: [{ $match: { status: "a" } }], as: "__jsmql.tmp.0" } }, { $set: { "__jsmql.var.ids": { $setUnion: { $map: { input: "$__jsmql.tmp.0", as: "x", in: "$$x.pid" } } } } }, { $set: { hit: { $in: ["x", "$__jsmql.var.ids"] } } }, { $unset: "__jsmql" }]
$.p = $$$.products.filter({ active: true }).pick(["_id", "name"]);  $.t = $.p[0].price ? 1 : 2;   // `price` was not kept: certainly missing
// → [{ $lookup: { from: "products", pipeline: [{ $match: { active: true } }, { $project: { _id: 1, name: 1 } }], as: "p" } }, { $set: { t: 2 } }]
```

### A row's `returns`

A row states its result as a `TypeExpr`, a closed data grammar the compiler
evaluates at the call site. The terms and their meaning are documented on the type
in [vocabulary.ts](../../src/registry/vocabulary.ts); `evaluate` in `type.ts` is
the one reader. A term is data, not a function, so
[test/compiler-returns-agrees.test.ts](../../test/compiler-returns-agrees.test.ts)
measures its top kind on mongod, the registry audits read it, and the globals
generator can turn it into a TypeScript signature. A row whose result no term
describes states `"unknown"`.

The receiver's family picks the term of a per-family map. For an **unproven**
receiver the call is on one of the families the row names, or the server raises
an error; so the result is the row's answers over its field families, joined.
`.size()` is a number on an array and on an object, so it is a number; a receiver
that may be several kinds proves several.

**A callback's answer** (`{ callback: n }`) is the body's proof under the
parameters the row's `params` bind: `value` is one element of the receiver (or a
property value of an object receiver), `index` a number, `key` a string,
`collection` the receiver, `accumulator` the seed argument. A parameter is never
proven present. So `.map(t => t.trim())` over an array proves an array of strings
that may be null, `.flatMap(f)` flattens one level of the callback's answer
(`elementOf`), and `.reduce(f, seed)` is one of the seed and the callback's
answer (`oneOf`).

**An object shape** follows the same terms. `{ ...a, ...b }` and `.assign(...)`
are `merge` (later wins, an open operand makes the earlier properties unknown, an
absent operand's properties may be missing); `.pick([...])` and `.omit([...])`
are `picked` and `omitted`, closed and open respectively; `.groupBy`, `.countBy`,
`.keyBy` and `.mapValues` are `recordOf` a value type; `.entries()` is an array
of `[string, value]` tuples, so a destructured pair reads each position, and
`.fromEntries()` is `recordOf` the pair's second item (`itemOf`). An array
literal with no spread is a tuple too: `["a", 1]` holds a string at 0 and a
number at 1. A method that keeps the receiver's own elements — a sub-array such
as `.take(n)`, a reordering such as `.toSorted()` — answers `same`, so the
element proof survives it.

**A read at an index or name the proof does not state may be missing.** An
index into an array of unknown length may fall outside it, a property an open
record does not name may not be there, and an index the compiler cannot read
(`counts[$.pid]`) is either. Each answers the element or the record's value,
maybe absent. A tuple's stated position, and a property `props` names, answer
exactly what they hold.

### Presence

A proof's `absent` flag comes from the row or the source where either states it
(`statedPresence` in [prove.ts](../../src/compiler/emit/prove.ts)): a literal is
present; a call is present when its row states `neverNull` and its receiver and
value arguments are present; an `Injected` value is present unless it is null. A
`? :` is present when both branches are; a property read carries the object's
proof; a binding carries what its value proved. `a ?? b` is present exactly when
`b` is. MEASURED: `{ $size: null }` and `{ $in: [x, null] }` abort the command, so
a cell guards with `$ifNull` exactly where the proof says `absent`.

### The document after a stage

Every stage row states a `document` fact, from the `DocumentEffect` vocabulary:
`keeps`, `fields`, `value`, `projection`, `element`, `unknown`. `StageFacts` in
[names.ts](../../src/registry/names.ts) pairs it with `body` at the type level, so
a stage row cannot omit it. The scope tracker drops every field-carried binding
and skips the trailing namespace cleanup after a stage whose effect is `fields`,
`value` or `unknown`, and after a `projection` that names fields to keep.
MEASURED: a `let` binding survived `{ $project: { x: 0 } }` and went away under
`{ $project: { x: 1 } }`.

**The effect is applied to the emitted stage, not to its source.** `documentAfter`
in [prove.ts](../../src/compiler/emit/prove.ts) reads the stage's body as MQL:
the body names the output fields and the operators that fill them, whatever road
wrote the stage — a statement, a chain link, `$ = …` sugar. `typeOfEmitted` proves
an MQL value against the input document: a field path reads the input's proof, an
operator answers its row's `returns` over its operands (`{ $sum: … }` is a
number, `{ $push: … }` an array), a `$cond` or `$switch` joins its branches, a
`$literal` proves itself, a `$$` variable proves nothing, and `$arrayToObject`
over pairs (`[{ k, v }]` or `[[k, v]]`) is a record of the pairs' values. A raw
`$op(…)` passes through as written (HR2), so the reader answers `ANY` for a body
shape it does not recognise. An accumulator — a `$group` key, a
`$setWindowFields` output — answers its empty value over a missing operand
(MEASURED: `$push` gives `[]`, `$sum` gives `0`), so it is present when its row
states `neverNull`, whatever its operand.

| Effect | The document after the stage |
|---|---|
| `keeps` | The input, with `$set` / `$addFields` keys written, `$unset` paths removed, a `$lookup` / `$graphLookup` `as` written as a present array of the documents its `pipeline` makes, and each `$setWindowFields` `output` key written. |
| `fields` | Exactly the body's keys, closed: `$group` types `_id` by its expression and each key by its accumulator; `$facet` gives each key an array of the documents its pipeline makes; `$count`'s string body names one number field. |
| `value` | The body value's proof, when it proves an object (`$replaceWith`, `$replaceRoot.newRoot`); otherwise an unknown document. |
| `projection` | An inclusion is a closed object of the named paths with their input types, `_id` kept unless `0`; an exclusion removes the named paths. |
| `element` | The unwound path becomes its element, present unless `preserveNullAndEmptyArrays`. |
| `unknown` | An unknown document. `$bucket`, `$bucketAuto` and `$sortByCount` state this until a layout can name their output fields [DEF-038]. |

Inside one statement the same reader runs at each replacing stage, so a write
after `$ = …` lands on what that stage made.

```js
$group({ _id: $.k, total: $sum($.amount), items: $push($.item) });  $.t = $.total ? 1 : 2;
// → …, { $set: { t: { $cond: { if: "$total", then: 1, else: 2 } } } }
$.p = { a: 1, b: "x" };  $ = $.p;  $.c = $.b.length;
// → …, { $replaceWith: "$p" }, { $set: { c: { $strLenCP: "$b" } } }
```

### A filter narrows the document

A `$match` passes only the documents its query selects, so what the query
states about a field holds for every document after it. The `$match` row states
the effect `narrows`, and `narrowedBy` in
[prove.ts](../../src/compiler/emit/prove.ts) reads the emitted **query
document** — so every road that filters feeds it: `$match(<predicate>)`, a
`$$.filter(p)` link, a raw `{ status: "a" }` pass-through. Each top-level field
clause, and each member of a top-level `$and`, narrows its field: the field's
kinds intersect with what the clause allows, and a clause that excludes null
proves the field present. `$or`, `$nor`, `$expr` and every other top-level
operator prove nothing, so a conjunct that fell to the `$expr` residual proves
nothing either.

The query language reads an array field element by element: `{ a: 5 }` and
`{ a: { $gt: 5 } }` select `a: 5` and `a: [5, 6]` alike, and
`{ a: { $type: "string" } }` selects `a: ["x"]`. So a clause that names a kind
proves that kind **or an array**. MEASURED: the comparison operators compare
inside one BSON type bracket, so `{ a: { $gt: 5 } }` never selects a string.

| Clause | Proves |
|---|---|
| `{ f: <literal> }`, `$eq`, `$gt`, `$gte`, `$lt`, `$lte` | the literal's kind or an array, present — nothing for `null` |
| `$in: [<literals>]` | the literals' kinds or an array, present — nothing when the list holds `null` |
| `$type: <name>` | the named kind or an array, present |
| `$ne: null` | present, any kind |
| `$size`, `$all`, `$elemMatch`, a literal array | an array, present |
| `$regex`, a regex literal | a string or an array, present |
| a literal sub-document | an object or an array, present |
| `$ne: <value>`, `$nin`, `$exists`, `$not`, and every other clause | nothing |

```js
$match($.tags != null);  $.arr = $.tags.uniq();  $.bool = $.arr.has("red");
// → [{ $match: { tags: { $ne: null } } }, { $set: { arr: { $setUnion: "$tags" } } }, { $set: { bool: { $in: ["red", "$arr"] } } }]
$match($.n > 5);  $.x = $.n ? 1 : 2;     // n: a number or an array, present → only the zero test
// → [{ $match: { n: { $gt: 5 } } }, { $set: { x: { $cond: { if: { $ne: ["$n", 0] }, then: 1, else: 2 } } } }]
```

## The consumers

### The dispatch

`receiverOf` in [lower.ts](../../src/compiler/emit/lower.ts) hands `select.ts`
the receiver's proof as a closed `Receiver`:

- one field family → `value`: the row's cell for that family runs, with no test;
- several kinds → `opaque` with `possible` (the field families among them),
  `exact` (does `possible` name every kind?) and `present`;
- a kind no family covers (`bool`, `objectId`) → `opaque` with `proved`, and every
  field-family row refuses it, naming what it takes;
- nothing proven → `opaque`, today's full runtime dispatch.

`fromPerFamily` in [select.ts](../../src/compiler/emit/select.ts) then applies four rules:

1. **Branches for the possible families only.** The dispatch runs over the row's
   families that the receiver can be, in the row's order.
2. **The default only when it can fire.** A dispatch is `complete` when the value
   is present and every kind it can be has a branch. A complete dispatch is a
   `$switch` with **no `default`**. It is never a `$cond`: MEASURED, the server
   optimises a `$cond`'s branches before it reads the test, so
   `{ $cond: [<is array>, { $size: v }, { $strLenCP: v }] }` over a constant `v`
   (a `$let` variable, a `$literal`) fails with "Failed to optimize pipeline", while
   the same branches under `$switch` run on every receiver (`switchOver` in
   [mql.ts](../../src/compiler/emit/mql.ts)).
3. **Refuse at compile time only when no possible kind is accepted.** `$.b.trim()`
   after `$.b = $.arr.has("x")` is a compile error. A partial overlap is not:
   `{string, number}` under `.trim()` runs the string branch and the number falls
   to the null default, because "possible" is not "proven".
4. **`ANY` on a one-family row is that family**, by the row's claim, as before.

```js
$.v = $.flag ? "abc" : [1, 2];  $.i = $.v.indexOf("x");
// → …, { $set: { i: { $switch: { branches: [{ case: { $in: [{ $type: "$v" }, ["array"]] }, then: { $indexOfArray: ["$v", "x"] } }, { case: { $in: [{ $type: "$v" }, ["string"]] }, then: { $indexOfCP: ["$v", "x"] } }] } } } }

$.v = $.flag ? 5 : [1, 2];  $.i = $.v.indexOf("x");   // a number has no `.indexOf` form → the default stays
// → …, { $set: { i: { $switch: { branches: [{ case: { $in: [{ $type: "$v" }, ["array"]] }, then: { $indexOfArray: ["$v", "x"] } }], default: null } } } }
```

### The truthiness rule

`truthOf(value, type)` in [mode.ts](../../src/compiler/emit/mode.ts) reads a
value as a JavaScript condition. JavaScript has four falsy values JSMQL supports
— null-or-missing, `false`, `""`, `0` — and each belongs to one part of a proof,
so the check is **subtractive**: it keeps only the tests some part of the proof
can fail.

| Test | Kept while |
|---|---|
| `{ $ne: [{ $ifNull: [v, null] }, null] }` | `absent` is true |
| `{ $ne: [v, false] }` | `bool` is a possible kind |
| `{ $ne: [v, ""] }` | `string` is a possible kind |
| `{ $ne: [v, 0] }` | `number` is a possible kind |

An array, an object, a date, an ObjectId or binData owes no test: JavaScript
reads each one as true. Three shape rules follow. One test left is emitted bare,
with no `$and`. No test left is the constant `TRUE`, and the slot that reads it
folds: `cond`, `filter`, `switchOn` and `switchOver` in
[mql.ts](../../src/compiler/emit/mql.ts) and the registry's own `cond` builder
pick their branch at compile time, and `and`, `or` and `not` fold a constant
operand. A value whose only possible kinds are `bool` or `number` is its own
truth, whatever its `absent`: MEASURED, MongoDB reads `0`, a `Long` zero, a
`Decimal128` zero, negative zero, `false`, null and missing as false, so
`{ $cond: { if: "$n", … } }` agrees with JavaScript on every number.

```js
$.s = $.a.trim();  $.t = $.s ? 1 : 2;   // s: string, maybe absent
// → …, { $set: { t: { $cond: { if: { $and: [{ $ne: [{ $ifNull: ["$s", null] }, null] }, { $ne: ["$s", ""] }] }, then: 1, else: 2 } } } }
$.u = "x";  $.v = $.u ? 1 : 2;           // u: string, present
// → …, { $set: { v: { $cond: { if: { $ne: ["$u", ""] }, then: 1, else: 2 } } } }
$.arr = [1];  $.w = $.arr ? 1 : 2;       // arr: array, present — always true
// → …, { $set: { w: 1 } }
$.n = $.a.length;  $.x = $.n ? 1 : 2;    // n: number, maybe absent
// → …, { $set: { x: { $cond: { if: "$n", then: 1, else: 2 } } } }
```

The rule rejected: `{ $gt: [v, ""] }` covers a string of any presence in one
operator, because null sorts below every string. It reads as a comparison, not as
a truth test, and a reader has to know the BSON sort order to see why it is
right.

**In the filter target** the same rule has a native form. `bareTruth` in
[filter.ts](../../src/compiler/emit/filter.ts) lowers a bare field read whose
proof rules an array out to a query clause: a boolean is `{ f: true }`, and
anything else excludes one value per part of the proof that can be falsy —
`{ f: { $ne: 0 } }`, `{ f: { $nin: [null, ""] } }`, `{ f: { $ne: null } }`, or
`{}` when nothing can be falsy. A value that may be an array stays on the `$expr`
road: the query language reads an array field element by element, so
`{ f: { $nin: [0] } }` drops `f: [0, 1]`, which JavaScript keeps.

### A refusal reads the whole set

A position that takes one kind — the document root under `$ = …`, the elements of
`$$ = <array>`, a spread's operand, a `$$.push(…)` argument, a `.map(d => …)` body
under a stream — refuses a value that can **never** be that kind, and lets a value
that *may* be it through for the server to judge: "possible" is not "proven". The
message names every kind the value can be (`nounOfKinds` in
[errors.ts](../../src/compiler/emit/errors.ts)): `$.x = $.f ? "s" : 5; $ = $.x;`
is refused as "a string or a number is not one", while `$.f ? { a: 1 } : 5` passes.
A spread of a value proven a string keeps its own message, which names the
character-wise spelling.

### The null guard

A cell that would abort or answer a value on null tests the receiver first
(`nullOr` in `names.ts`) exactly where the proof says `absent`. A written field
whose value was present takes no test: `$.s = "abc"; $.t = $.s.toUpperCase();`
emits `{ $toUpper: "$s" }` alone.

## What proves this spec

[test/compiler-types.test.ts](../../test/compiler-types.test.ts) states each rule
as a JSMQL program with its MQL, and runs that MQL on the project's mongod. Every
`MEASURED` note above has a case there or in the module it names.
