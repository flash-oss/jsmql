# The emit phase — the value and filter targets

The fifth phase of `src/compiler/`: a settled tree to its MQL. This spec owns
the VALUE target (`jsmql.expr`), the FILTER target (`jsmql.filter`, a `$match`
body), the modules under `src/compiler/emit/`, and the acceptance gate. The registry states what the language has; this phase
says how a document is built, and only where a row cannot — see
`src/compiler/CLAUDE.md` for that boundary.

## The reading order

`lowerValue(node, env)` handles every node type the tree has, in one exhaustive
switch. Each case is one of three kinds:

1. **A node that is its own document.** A literal, a field path (`$.a.b` →
   `"$a.b"`, the bare `$` → `"$$ROOT"`), an array or object literal. A constant
   the fold could not write back as source — a `Date`, an `ObjectId`, a `Set` —
   is settled here by the evaluator before any row is read; a value holding a
   JavaScript `bigint` is not, because `$toLong` spells it.
2. **A name.** `consult` (the row's answer for the position), then `select` (the
   receiver's proof and the arguments' class), then the rule's own renderer
   over an `ExprIn` built by `inputs.ts`. Every JavaScript method, MongoDB
   operator, global and namespace member takes this road; so does every
   operator production with a plain renderer (`-`, `*`, `===`, `?:`, …).
3. **A construct that reads its neighbours.** `+` is `$concat` when an operand
   is provably a string and `$add` otherwise; `&&`/`||` as a value keep the
   operand and bind a computed left side once; `x[i]` dispatches on what the
   receiver and the index are proven to be; `=== undefined` and `typeof x ===
   "t"` are the predicate vocabulary's expression cells. These are the rows
   whose cell says `inCode("src/compiler/emit/lower.ts")`.

`lowerTruth(node, env)` is the second reading: `&&`/`||`/`!`/`?:` recurse as
truths, anything else is `truthOf(value, row says bool)`. See `mode.ts`.

## The receiver's proof and the runtime dispatch

`types.ts` answers `kindOf(node, env)`: a literal, a binding's recorded type, a
row's measured `returns` (resolved per family for `.filter`-like rows), a
production's `returns`. A field path is `"unknown"`.

An unprovable receiver on a row with ONE field family is that family by the
row's claim. On a row with two or more it is dispatched at runtime:

```js
$.x.length
// → {$switch:{branches:[
//      {case:{$in:[{$type:"$x"},["array"]]},then:{$size:"$x"}},
//      {case:{$in:[{$type:"$x"},["string","null","missing"]]},then:{$strLenCP:{$ifNull:["$x",""]}}}],
//    default:"$$REMOVE"}}
```

The branches are the field families that hold a rule, in the row's order; the
guard is `$type` against the family's BSON types widened by the rule's
`alsoTypes`; the default is the row's required `uncertain`. A receiver that is
not a path or a variable is bound once with `$let`.

## Operand shapes and the checks

A MongoDB operator's `shape` is applied at the call, not in the renderer:

```js
$setUnion([$.a, $.b])   // → {$setUnion:["$a","$b"]}     one array literal IS the operand list (HR2)
$eq([$.n, 4])           // → {$eq:["$n",4]}              the same for a flex operator; counted by its elements
$setUnion($.a)          // refused: a list operator with one scalar (the server refuses it too)
$and([])                // → {$and:[]}                    an explicit empty list passes where the row states `emptyList`
$divide([])             // refused: nothing was written, and `$divide` states no empty list
$concatArrays([...$.a, [1]]) // → {$concatArrays:{$concatArrays:["$a",[[1]]]}}  a list with a spread is one array-valued expression
$trim($.name)           // → {$trim:{input:"$name"}}      one value maps onto the first positional key
$size([$.a])            // → {$size:["$a"]}               a 1-operand operator: one element is the operand list as written
$size([$.a, 2])         // → {$size:[["$a",2]]}           two or more can only be the array VALUE — wrapped once
$literal(["$a", "$b"])  // → {$literal:["$a","$b"]}       shape "verbatim": the operand is a value, never a list
[$.a, 2].length         // → {$size:[["$a",2]]}           a JavaScript lowering wraps an array LITERAL receiver itself
```

`$let(vars, arrow)` binds the arrow's parameters to the vars, and both sides are
spelled by the one variable encoder: `$let({ v_x: 1 }, (v_x) => v_x)` →
`{$let:{vars:{v_v_5fx:1},in:"$$v_v_5fx"}}`, so a name the server refuses (`ROOT`)
becomes one it takes. `Number(<constant>)` is never folded: `$toDouble("3")` is a
double on the server and a written `3` an int.

`check.ts` holds the literal-gated checks, each reading a `BodyRule` or `Arity`
field the row states: required and closed keys (with a suggestion), enums,
flag sets, key and slot types, `elementType` over every operand, `nullRefused`
slots (a per-row fact: `$size(null)` is refused by the server, `$reverseArray(null)`
answers null), `constant` slots and `constantKeys`, and the two refusals for a
spread or a computed key inside an operator body. A slot that is a field path,
an expression or a spread is never judged. The checks run on every rule —
an operator's, a method's, a production's — and `test/registry-fields-read.test.ts`
holds that every stated rule field has a reader.

## Truthiness

A JavaScript spelling checks missing, null, `false`, `""`, `0`; the `$op(...)`
escape hatch keeps MongoDB's rules; NaN is not checked. `mode.ts` is the one
minter of `Truth`, and `mql.ts` builds every slot that reads one. The table in
[docs/LANG_RULES.md](../LANG_RULES.md) states the rule for developers.

## The filter target

`lowerFilter(node, env)` in `emit/filter.ts` turns a predicate into a QUERY
document — the language an index reads — and falls back to `{ $expr: <truth> }`
exactly where a row states no native form. The rules the shipped translator
established hold (see [match-query-translation.md](match-query-translation.md)
for the query semantics and the documented divergences from the expression
form), with one change the developer ruled:

```js
$.a > 1 && $.b <= 2                    // → {"a":{"$gt":1},"b":{"$lte":2}}
$.a >= 1 && $.a <= 9                   // → {"$and":[{"a":{"$gte":1}},{"a":{"$lte":9}}]}   colliding keys into one $and
$.a === 1 && $.q * $.p > 100           // → {"a":1,"$expr":{"$gt":[{"$multiply":["$q","$p"]},100]}}
$.tags === "red" || $.q * $.p > 100    // → {"$or":[{"tags":"red"},{"$expr":{"$gt":[…]}}]}     PER BRANCH (the ruling)
$.a || $.b                             // → {"$expr":{"$or":[<truth a>,<truth b>]}}            every branch $expr: one $expr
$.tags.includes("a") && $.tags.includes("b")  // → {"tags":{"$all":["a","b"]}}
$.items.some(i => i.q > 2)             // → {"items":{"$elemMatch":{"q":{"$gt":2}}}}
{ status: "a", x: $gt($.y) }           // → {"status":"a","x":{"$gt":"$y"}}     a raw document: keys as written, a one-operand $op is the query operator
$abs($.delta)                          // → {"$expr":<truth of $abs>}            a value operator is a predicate through its truth
```

The shipped compiler wrapped the whole `||` in `$expr` as soon as one branch
needed it, and `{ $expr: { $eq: ["$tags", "red"] } }` does not match
`tags: ["red", "blue"]` where `{ tags: "red" }` does — the left leaf's answer
changed with its sibling. Per branch, each branch means what the same predicate
means alone.

Per branch also changes WHEN a branch runs. The server picks the order of the
clauses in a query document, so a branch whose expression the server refuses on
some document can now be reached where one `$expr` over the whole `||` happened
to run after a cheaper clause had already excluded that document. Measured over
`{a:1,b:1,c:5}`, `{a:2,b:"oops",c:1}`, `{a:2,b:1,c:9}`:

```js
($.a === 1 || $.b * 2 === 2) && $.c > 3
// per branch:  {"$or":[{"a":1},{"$expr":{"$eq":[{"$multiply":["$b",2]},2]}}],"c":{"$gt":3}}
//              the server refuses it: "$multiply only supports numeric types"
// one $expr:   {"c":{"$gt":3},"$expr":{"$or":[{"$eq":["$a",1]},{"$eq":[{"$multiply":["$b",2]},2]}]}}
//              selects _id 1 and 3 — the `c` clause excluded the string `b` first
```

Neither order is promised by the server, and `"oops" * 2` is `NaN` in
JavaScript, which this language does not model, so an arithmetic expression over
a field of mixed type can fail on either shape. The per-branch rule stands: a
predicate that means one thing alone means the same thing beside a sibling.

### A query operator's call form is its clause

A query operator CALLED — `$exists($.a)`, `$regex($.s, "x", "i")`, `$gt($.a, 1)` —
is the row's `filter` cell, and it writes the clause the document form spells:
the first argument is the field, the rest the operand. An operator that also has an
expression form answers the clause when the field is a path and the operand a
constant (a literal list or document of constants is one), and null otherwise, so
`$gt($.a, $.b)` takes the expression road; a query-only operator must answer, so a
first argument that is not a field path and an operand read at run time are refused
by name. The raw spelling keeps MongoDB's own reading — no own-value clause is
added — while an `$elemMatch` ARROW is a JavaScript spelling over the element and
reads it as one. `$and` / `$or` / `$nor` list their predicates, each a filter of
its own, as a call and as a key of a raw document; `$not` negates one raw clause on
one field and otherwise takes the expression form, whose negation of a JavaScript
spelling is exact. `$expr(e)` is `{ $expr: <expression> }`; `$text`, `$comment`,
`$where` and `$jsonSchema` take their literal.

A FRAGMENT — `$box` inside `$geoWithin`, `$case` inside `$switch`, the row's
`onlyInside` — is valid only as an argument of the operator it names: the Env's
site records the operator whose arguments are being lowered (`inside`), any other
call boundary clears it, and a fragment met elsewhere is refused by name in both
the filter and the value target. A literal list or document of constants is a
literal for the raw operators alone (`literalIn`): a JavaScript spelling reads it
by reference — `$.tags === [1, 2]` is never true in JavaScript — and takes the
expression road, where `$eq` compares the whole value.

```
$exists($.a)                          → {"a":{"$exists":true}}
$and([{ a: 1 }, $.b < 2])             → {"$and":[{"a":1},{"b":{"$lt":2,"$not":{"$type":"array"}}}]}
$geoWithin($.loc, $box([[0,0],[1,1]])) → {"loc":{"$geoWithin":{"$box":[[0,0],[1,1]]}}}
```

### A JavaScript spelling reads the field's own value

MongoDB's query language satisfies a field comparison when ANY ELEMENT of an
array value satisfies it, and it traverses an array in the middle of a path.
JavaScript does neither. So every query cell of a JavaScript spelling states two
facts about its own meaning — `ValueReading` in `src/registry/vocabulary.ts` —
and `queryOwnValue` turns them into MQL:

| the cell's answer | field ABSENT | value IS an array | shape |
|---|---|---|---|
| `$.a === 1` | false | false | `{ a: { $eq: 1, $not: { $type: "array" } } }` |
| `$.a !== 1` | true | true | `{ $or: [{ a: { $ne: 1 } }, { a: { $type: "array" } }] }` |
| `$.a == null` | true | false | `{ a: { $eq: null, $not: { $type: "array" } } }` |
| `$.a != null` | false | true | `{ $or: [{ a: { $ne: null } }, { a: { $type: "array" } }] }` |

An array at a path PREFIX is the ABSENT case, because that is what JavaScript
reads there: `$.a.b === 1` adds `a: { $not: { $type: "array" } }`, and
`$.a.b !== 1` offers `{ a: { $type: "array" } }` as an alternative instead. A
third reading, `FIELD_VALUE`, is for a test the server reads of the FIELD rather
than of an element — `$exists`, and the `$elemMatch` a `.some` becomes: neither
can be satisfied by an element, so neither takes a leaf exclusion, and a prefix
array is still absent (`$.a.items.some(…)` where `a` is an array selects
nothing, as `.some` throws there).

`!p` is the COMPLEMENT of p's own clause — `{ $nor: [<p>] }` — whenever p has a
clause with no `$expr` inside. That is not a size choice: `$expr` orders across
BSON types, so `{ $not: { $gt: ["$v", 1] } }` is false for `v: [0, 20]` and for
`v: "x"`, where JavaScript answers true for both, and `$.v > 1 || !($.v > 1)`
stopped being a tautology. Measured, it is one again. A predicate with an `$expr`
inside keeps the truth road, whose own `$not` over one expression is already
JavaScript's answer.

Two measured facts hold the shape in place. The exclusion costs no index: `{ a: {
$eq: 1, $not: { $type: "array" } } }` plans an IXSCAN over the bounds `[1, 1]`,
exactly as `{ a: 1 }` does — while a `$not` wrapped around the whole positive
clause drops to a collection scan, which is why a negation is an `$or`. And the
answer is compared with JavaScript's own, by evaluating the source in node over
the same documents (`test/compiler-js-agreement.test.ts`). Two families of
source still differ there, neither of them an array: JavaScript COERCES under a
relational operator (`[2] > 1` is true) and THROWS when a path walks through a
missing intermediate. Raw MQL — a raw `{ … }` filter document, a `$op(…)` call —
keeps MongoDB's own reading.

A query cell is a row fact: the comparison productions carry `strictEqualityQuery`
and friends (the type test, the presence test, the modulo test, the null test, a
field against a constant — in that order), `includes`/`startsWith`/`endsWith`/
`match`/`some` carry theirs, `$sampleRate` states its one slot `constant`, a
`number`, in the range `[0, 1]`. Each answers null where the operands are not a
path and a constant, and null is the `FilterOut` contract for "wrap my value
form". A row with no value form (a query-only operator) has nothing to wrap, so
inside an `$elemMatch` boundary — where the server refuses it — the leaf throws a
worded refusal before the cell runs. `FilterIn` hands a cell `pathOf` (a `.length`
is never a path segment; inside a `.some` callback the INNERMOST element is the
root, and only its fields are paths — an outer callback's parameter read inside
a nested one has no query form and takes the `$expr` road; the `$elemMatch`
boundary records which parameter is its element), `constant` (a value the query
language compares as written — never an array, a regex or a bigint), `query`,
`nativeQuery` and `elementQuery`. The
predicate alias tables (`typeof` spellings, the numeric group) are registry data
in `vocabulary.ts`, read by both the query and the expression cells.

## The statement target

A program is a sequence of statements, and each becomes zero or more STAGES.
Two statements never merge: the `;` the developer wrote IS the stage boundary and
the `,` IS the merge, so one source keeps one output and no rule reads across a
boundary the developer drew.

```js
$.total = $.qty * $.price;   // → [{"$set":{"total":{"$multiply":["$qty","$price"]}}}]
$.a = 1, $.b = 2;            // → [{"$set":{"a":1,"b":2}}]          one run, one stage
$.a = 1; $.b = 2;            // → [{"$set":{"a":1}},{"$set":{"b":2}}]   two statements
delete $.a, delete $.b;      // → [{"$unset":["a","b"]}]
$ = { id: $._id };           // → [{"$replaceWith":{"id":"$_id"}}]
$match($.a > 1); $limit(1);  // → [{"$match":{"a":{"$gt":1,…}}},{"$limit":1}]
{ $match: { a: 2 } };        // → [{"$match":{"a":2}}]              raw MQL, HR1
[$match($.a > 1)]            // → the same program, bracketed
```

Inside a `,`-joined run the writes group as far as ONE stage can carry them.
Three things end a group, each measured on the server:

| the run | becomes | because |
|---|---|---|
| `$.a = 1, $.b = 2` | one `$set` | one `$set` evaluates every value against the document it received |
| `$.x = 1, $.z = $.x` | two `$set`s | the second must read the NEW `x`, and one stage would read the old one |
| `$.a = 1, $.a.b = 2` | two `$set`s | the server refuses a parent beside its own child: "specification contains two conflicting paths" |
| `$.a = 1, delete $.b` | `$set` then `$unset` | two stages, because they are two stages |

A write to the document ROOT is its own stage: it replaces what the next write
would be written into. `$.a = $.b, $.b = 1` needs NO split — writing what an
earlier value read is exactly what one `$set` already means.

A statement that NAMES something asks the row, and the row's own cell renders
it. Not `isStageName`: `assert(…)` is a statement and is not a stage, and asking
the wrong question refuses it with the wrong word. A stage's BODY lowers in the
position its row states (`bodyPositions`), which is how `$match`'s predicate
becomes a query document and a `$group` output key becomes an accumulator
without either cell knowing which reading it asked for. `readIn` is that hub.

Four facts the row states are applied where the statement stands, each because
the server enforces it and no renderer implies it:

| the row says | the target does | measured |
|---|---|---|
| `only: ["stageFirst"]` | refuses the stage anywhere but first | "$documents is only valid as the first stage" |
| `only: ["stageLast"]` | files it on the chain, so the `__jsmql` cleanup precedes it, and refuses a statement after it | "$out can only be the final stage" |
| `forbiddenIn: […]` | refuses it inside those containers | the server refuses a write stage in a sub-pipeline |
| `bodyPositions` | reads each body key in the position it names | `$geoNear`'s `query` as an aggregation expression: "unknown top level operator: $eq" |

A stage's own body sub-pipeline runs under its OWN chain, with the container
recorded as a boundary. Without the chain a stage filed as LAST is filed on the
outer one and silently leaves the body — measured: a `$out` inside a `$lookup`
body landed at the end of the outer pipeline and the body came out empty.

Two JavaScript meanings the query language does not share by default:

```js
$.n = { x: 1 }       // → { $set: { n: { $mergeObjects: [{ x: 1 }] } } }
$.a = 1, $.b = "$a"  // → two $sets, because `"$a"` IS a read of `a`
```

`{ $set: { n: { x: 1 } } }` MERGES into `n` on the server — measured, `y` survived
— where a JavaScript assignment replaces the field. `$mergeObjects` makes the
document the value of an expression rather than a nested field spec, and unlike
`$literal` an expression inside it still evaluates. And a `"$a"` the developer
typed is the field `a` (HR1), so it ends a write group exactly as `$.a` does;
without that, one `$set` gave `b` the value `a` held before the stage.

Which DOCUMENT the whole program becomes is asked once, at the entry: a folded
constant array (`[1,2].slice(2,2)` settles to `[]`) is a VALUE, and read as a
program it would compile to no stages at all.

A stage's BODY is checked from the row's own facts, through the same two
mechanisms an operator's arguments use: `args` for a body that is not an object
(`slotType`, `constant`, `slotRange`), and `body` — a `BodyRule` — for one that
is. The valuable half is `constant`: a slot the server reads before any document
exists accepts a field path SILENTLY, and `$unionWith($.c)` unions a collection
literally named `$c` rather than saying so. `fieldName` is the ArgType for a slot
that NAMES a field to write, where a `$`-led string is the error rather than a
runtime value — the one place the literal gate is bypassed, because
`{ $count: "$n" }` is refused by the server.

### The stream road

`$$.filter(d => d.x > 1).sortBy("k").take(3);` — and the same chain with an
explicit `$$ =` head, which is never the default spelling — are one program: a chain on the stream, one
row's `stream` cell per link, base first. A stage is a link too (`$$.$match(…)`),
through the very cell its statement form uses, and each link's stages take the
placement its row states — a link after `$out` is refused exactly as a statement
after it is.

```js
$$.filter(d => d.x > 1);          // → [{"$match":{"x":{"$gt":1,"$not":{"$type":"array"}}}}]
$$.map(d => ({ a: d.x }));        // → [{"$replaceWith":{"a":"$x"}}]
$$.sortBy("x").take(2);           // → [{"$sort":{"x":1}},{"$limit":2}]
$$.toSorted((a, b) => b.x - a.x); // → [{"$sort":{"x":-1}}]
$$.reject(d => d.x > 1);          // → [{"$match":{"$nor":[{"x":{"$gt":1,…}}]}}]   the complement, as `!p` is
$$.uniqBy("k");                   // → [{"$group":{"_id":"$k","__jsmqlTmp":{"$first":"$$ROOT"}}},{"$replaceWith":"$__jsmqlTmp"}]
$$.take(0);                       // → [{"$match":{"$expr":false}}]           `$limit: 0` is refused by the server
```

A callback's FIRST parameter IS the stream's document: `d.x` is the path "x" in a
predicate and `"$x"` in a reshape, and the bare `d` is `"$$ROOT"`. `$.x` inside the
callback names the same document — the root — as HR4 says it does everywhere. The
index and collection parameters lodash allows are bound, and a READ of either says
what to write instead (a stream has no per-document index; `$$.length` is its size).

A stream cell receives its arguments as SOURCE and asks for the reading it wants:
`predicate(cb)` a query document (total — a body with no native form arrives as
`$expr`), `reshape(cb)` a value, `block(cb)` the stages of a `{ … }` body,
`sortSpec(e)` and `orderBy(keys, orders)` the `{ field: 1 | -1 }` document from
any of the sort spellings (`emit/sort-spec.ts`, a reader over the tree that never
lowers), `slot()` a scratch field the chain's cleanup drops. A bare `$$.<name>(…)`
with one link asks the row's STATEMENT cell first — the union sugar and the
source stages are statements spelled on the stream, and their rows say so.

### Bindings between stages

A `let` whose value is not a constant is carried between stages in a field of
the document, `__jsmql.var.<name>`, and the chain's trailing cleanup drops it. A
constant `let` never gets that far: the fold inlines it. The binding is written
again by `x = …` when it is a `let`, and refused when it is a `const`. A second
`let x` in the same block is refused, as JavaScript refuses it; a nested block —
a stage's `[ … ]` body, an `o => { … }` block — declares its own names and sees
the outer ones, so a `let` there shadows and never collides.

```js
let x = $.a * 2; $.b = x;            // → [{"$set":{"__jsmql.var.x":{"$multiply":["$a",2]}}},{"$set":{"b":"$__jsmql.var.x"}},{"$unset":"__jsmql"}]
let t = $.a; $$.filter(d => d.x > t);  // → the binding is a FIELD, so the predicate is field-to-field: {"$expr":{"$gt":["$x","$__jsmql.var.t"]}}
let x = $.a; $group({ _id: x });     // → the group drops every field, the cleanup is not owed, and a later `x` is refused
```

The scope THREADS through the program: each statement answers the Env the next
one is lowered under. A stage whose row states `replacesDocument` takes every
field-carried binding with it — `true` for `$group`, `$replaceWith`, `$count`
and their kind, `"inclusion"` for a `$project` whose body names fields to keep
— and a read after that is refused naming the stage, where the shipped compiler
emitted a read of a field that was no longer there. The way back is the one
JavaScript allows: `x = …` on a dropped `let` writes its slot again and the next
statement reads it; a dropped `const` can only be carried as a field of the new
document. Every name that has no value here — a dropped binding, a callback's
index or collection parameter the stream cannot fill, a function inside its own
body — is one `dropped` marker carrying the wording its read throws, so the
reason is worded where the name was taken away and not guessed where it is
read. `$$ = [ … ]` starts the
stream from a literal list of documents (`$documents`, a source stage that must
stand first); the empty list is a stream of nothing.

What this target has NOT built yet is stated as data — `PENDING_CONSTRUCTS` in
`emit/errors.ts` — so the differential harness can VERIFY a "not yet" rather
than trust one, and so the work left is countable. The list emptying is what
finishing the statement target means.

### The join road

`$$$.<coll>.<chain>` is a `$lookup`, in every position the chain may stand
(`emit/join.ts`). One route: `let` + `pipeline` + `$expr`, never `localField` /
`foreignField`. The pipeline form compares the two fields' OWN values as
JavaScript does — `1 === [1, 2]` is false, `undefined === undefined` is true,
`undefined === null` is false — where the basic form reads null as missing and
matches an array element-wise; and the pipeline form uses the foreign index too
(measured on mongod 8.3.7: `indexesUsed`, keys examined = rows matched, `$limit: 1`
examines one key per document). One route also means one meaning: the shipped
compiler switched routes on a syntactic accident, and adding `&& o.status === "paid"`
changed which documents matched.

```js
$.orders = $$$.orders.filter(o => o.userId === $._id);
// → [{ $lookup: { from: "orders", let: { jsmql_f0__id: "$_id" },
//       pipeline: [{ $match: { $expr: { $eq: ["$userId", "$$jsmql_f0__id"] } } }], as: "orders" } }]
$.first = $$$.orders.find(o => o.userId === $._id);
// → the same with `{ $limit: 1 }`, then { $set: { first: { $first: "$first" } } } — absent when nothing matched
$.n = $$$.orders.filter(o => o.userId === $._id).length;
// → the $lookup HOISTED into "__jsmql.tmp.0", { $set: { n: { $size: "$__jsmql.tmp.0" } } }, { $unset: "__jsmql" }
```

**The chain peels.** A link goes into `$lookup.pipeline` while its row has a
`stream` cell that accepts it — `filter`/`reject`, the sort spellings, `take`,
`aggregate`, a stage link, a `.map` whose body is a provable document (the row
states `streamBody: "document"`). The first link that is not such a link ends the
body; it and everything after it — `.length`, `.total`, `[0]`, a value `.map` —
read the materialised array as a VALUE. `.find` is the one special head (the row
states `picksOne`): `filter` plus `{ $limit: 1 }`, the slot unwrapped with `$first`.
A link that folds the stream into one document (`collapses` on the row: `countBy`,
`keyBy`, `groupBy` with a field name) is unwrapped too, to `{}` when nothing
matched, as lodash answers for an empty array. The slot is a typed binding, so
`.length` on it is `$size` with no runtime guard and `.total` after `.find` is a path.

**Where it stands decides the destination.** A bare write `$.o = <chain>` and a
`let` make the target the stage's `as` — no scratch, no cleanup. Inside a value the
stage is hoisted ahead of the statement into `__jsmql.tmp.<n>`. `$$ = <chain>`
switches the stream: correlated (the body read the outer document), a `$lookup`
per document unwound into the stream; uncorrelated, `{ $match: { $expr: false } }`
and a `$unionWith`. `$ = $$$.c.find(p)` makes each document the one it found,
through `$unwind` — a document that found nothing has nothing to become and leaves
the stream (`$replaceWith: { $first: … }` fails on the server for it, measured).
A chain with no destination is refused with the three that exist.

**Correlation is the Env's business.** Every binding records the LEVEL of
documents it lives on (0 for the root pipeline's, one more per body over another
collection), and `Env.render` reads a located value: on this level, as its path;
on a shallower level, through the `let` of the boundary whose stage runs over that
level's documents (`Capture`, held by reference on the boundary like a Chain), as
`$$jsmql_<f|v|s><level>_<hint>` — `f` a field, `v` a `let` binding, `s` a system
value; the names come from `src/namespace.ts`. A root read two levels down is
captured once, at the outermost `$lookup`, and read by name below: MQL variables
are lexically scoped through nested `$lookup.pipeline`s (measured). The raw stage
call `$lookup({ …, pipeline: [ … ] })` is the same road: what its body reads of the
outer document is merged into the developer's own `let`. `$unionWith` has no `let`
(measured: `IDLUnknownField`), so a read of the outer document inside it is refused
with the way out.

**Inside the body.** The callback's parameter IS the body's document: `o.x` reads
it, `o.x = …` / `delete o.x` write it (`$set` / `$unset`), `o = { … }` replaces it.
The callback's THIRD parameter is the body's own stream: `coll.filter(…)` is a
`$match` there and `coll.length` its count (a `$setWindowFields` inside the body).
`$.` is the OUTER document and `$$` the ROOT stream at every depth (HR4): `$.x` is
read-only from inside — `$.x = …` is refused naming `o.x = …` — `$$.length` is the
root count, materialised on the root pipeline and carried in by `let`, and
`$$.filter(…)` inside a body is refused naming `coll`. A nested
`$$$.items.filter(…)` inside a predicate is hoisted inside the body's own chain,
whose close runs its own cleanup, so no scratch leaks into the joined array (the
shipped compiler leaked `__jsmql.tmp` there).

### The facet, union and out roads, the source stages, and declared functions

**`$ = { k: <$$ chain>, … }` is a `$facet`** (`statement.ts`, `facetStages`): one
branch per entry, each the stages its chain means under a `$facet` boundary, so a
`$out` or a second `$facet` inside is refused by the row's `forbiddenIn`. Every
entry must be a chain on `$$` — a value among branches is refused naming the key —
and a bare `$$` is the stream unchanged (`[]`). Branch names follow the server's
field rules (not empty, no `.`, no leading `$`; measured). The facet is a document-
replacing stage, so the bindings end with it. A chain on `$$` anywhere else than
the root replace is refused as "not a value", pointing at the facet form.

**`$$.push(…)` and `.concat(…)` are `$unionWith`** (`emit/union.ts`), one stage
per source in order: `...$$$.c` is `{ $unionWith: "c" }`, `...$$$.c.filter(p)` is
the collection with its pipeline, `$$$.c.find(p)` (no spread) the same with
`$limit: 1`, and a run of documents one `$documents`. JavaScript's spread rule
holds — an array spreads, one document does not — and the wrong one is refused
with the other spelling. The rows state `unions`. A `$unionWith` body has no `let`
(measured), so a read of the outer document inside it is refused where it reads;
`$documents` runs over nothing, so `{ a: $.a }` there is refused the same way.

**`$$$.<coll> = <stream>` and `$$$$.<db>.<coll> = <stream>` are `$out`**
(`outStages`): the stream's stages, then the write, filed as the pipeline's last
stage — so the `__jsmql` cleanup precedes it and nothing can follow it. The right
side must be `$$` or a chain on it; the target one name for the current database
(`{ db, coll }` for another), constant, not empty, not `$`-led (measured).

**`$$ = [{ k: $$.reduce((acc, d) => …, init), … }]` folds the stream to one
document** (`emit/reduce-wrap.ts`): one `$group` with `_id: null` and one
accumulator per key, then the `$replaceWith` that drops `_id`. Each body is read
as the accumulator it spells — `acc + d.x` is `$sum`, `acc + 1` counts,
`Math.max`/`Math.min`, `acc ?? d.x` is `$first`, a bare `d.x` is `$last`,
`[...acc, d.x]` or `acc.concat(d.x)` is `$push` — and a body that spells none is
refused naming them. The object form `[$$.reduce((acc, d) => ({ ...acc, k: acc.k + … }), { k: init })]`
names every fold in its body and its init, and the two sets must agree. The
init is JavaScript's and unread: MongoDB's accumulators have their own neutral
elements. A `$$.reduce` anywhere but inside this wrap is refused with the wrap.

**The source stages** — `$$.indexStats()`, `$$$$.currentOp(…)` and their kind —
run each row's own statement cell (`refStatement`), with the receiver checked
against the sigil the row's `on` states, so `$$$$.indexStats()` is refused naming
`stream`. They are first-stage-only by their rows' `only`.

**A declared function** binds its name to its body and emits no stage; a call
inlines the body as a `$let` (`lower.ts`, `applyLambda`). A second declaration in
one block is refused, as JavaScript refuses it.

**`assert(condition[, message]);` is a guard stage** — the row's own statement
cell: a `$match` whose `$expr` converts `true` to a type NAMED by the outcome,
`"bool"` when the condition holds and the message when it does not; the server
refuses the unknown type name and its error carries the message (measured:
`Unknown type name: jsmql assertion failed: …`). The condition is read as a
truth (a JavaScript spelling tests JavaScript truthiness); a literal message is
spelled into the name, a dynamic one concatenated at run time.

```
assert($.qty >= 0, "qty must be >= 0");
  → [{"$match":{"$expr":{"$convert":{"input":true,"to":{"$cond":[{"$gte":["$qty",0]},"bool","jsmql assertion failed: qty must be >= 0"]}}}}}]
```

## The method cells

A JavaScript method's value lowering is its row's `expr` cell — `{ args, emit }`,
per family under `perFamily` when the method lives on more than one prototype —
and the pure MQL builders the cells share live in `src/registry/mql.ts`, a leaf
like the rest of the registry. A cell RECEIVES everything it needs (`ExprIn`: the
lowered receiver, the source arguments, `value`, `truth`, `iteratee`, `predicate`,
`objIteratee`, `callback`, `reducer`, `elements`, `bind`) and throws nothing: every refusal is a fact on `args` the
dispatcher checks first — `slotType`, `slotEnums`, `regexFlag` (`.matchAll` needs
`g`), `dateFormat` (a `%` specifier the server knows, and a Moment token named
for what it is), `body` (an options document's keys, types and `notTogether`
families), `reject` (a count with a message of its own). What the cell then reads
is already known to be well-formed.

Where JavaScript and MongoDB number differently, the cell follows JavaScript:
`getMonth()` and `getDay()` count from 0 (`$month` and `$dayOfWeek` from 1), so
each subtracts 1. The local-time accessors are the same operators as the UTC
ones: the server has no client timezone, so both read UTC. A receiver PROVEN to be
of a kind no family has — a boolean, an ObjectId — is refused by every
field-family row, naming the way to the type the method takes; a `?.` on a
receiver of unproven type takes the neutral of the one family the row names.

The callbacks are services, so a cell never binds a parameter itself. `callback`
is the array callback `(x[, i[, arr]]) => …`: an index read makes the input the
`[i, x]` pairs of a `$zip`. `reducer` is `(acc, x[, i]) => …` with its seed: the
accumulator IS `$value` and the element IS `$this` when the body is plain
arithmetic, and both are read through a `$let` when the body calls anything,
because a call may lower to a `$reduce` of its own and shadow them.
`elements` binds one parameter per position of one array element — `.zipWith`'s
arrow over a `$zip` pair, `Array.from`'s `(_, i)` over a `$range`.

```
$.a.reduce((acc, x) => acc + x, 0)
  → {"$reduce":{"input":"$a","initialValue":0,"in":{"$add":["$value","$this"]}}}
$.a.reduceRight((acc, x) => acc.concat([x]), [])
  → {"$reduce":{"input":{"$reverseArray":"$a"},"initialValue":[],
               "in":{"$let":{"vars":{"acc":"$value","x":"$this"},"in":{"$concatArrays":["$acc",["$x"]]}}}}}
```

A rule that reads its arguments as ONE list states `spread: true` on its `args`,
and the desugar pass packs a spread call's arguments into one array literal for
it (see [desugar-pass.md](desugar-pass.md)): `Math.max(...$.a, 1)` reaches its
cell as one operand, `{ $max: { $concatArrays: ["$a", [1]] } }`, and
`Object.assign({}, ...$.docs)` as `{ $mergeObjects: <one list> }` — the server
reads a single array operand for both (measured).

The globals follow JavaScript where the two number differently or the server
holds a different equality. `new Date(y, m, d, …)` and `Date.UTC(…)` count the
month from 0, like `getMonth()`, so the month moves up by one on the way to
`$dateFromParts` (folded for a literal). `Number.isNaN` reads `$toString`,
because the server holds NaN equal to itself (`$eq: [NaN, NaN]` is true,
measured), and `Number.isInteger` excludes NaN and the infinities the same way.
`Math.cbrt` keeps the sign (`$pow` of a negative base to 1/3 is NaN), and
`parseInt` truncates through `$toDouble` so `"12.7"` reads as 12. The Set
relations (`isSubsetOf`, `isSupersetOf`, `isDisjointFrom`,
`symmetricDifference`, and the three set operations) accept a Set or an array
receiver: `new Set(x)` folds to `x`, since the server has no set type.

A JavaScript aggregate written where a stage takes an ACCUMULATOR — a
`$group` output field, a `$setWindowFields.output` entry — is the row's `group`
or `window` cell, and the receiver is the accumulator's operand: `$.a.sum()` is
`{ $sum: "$a" }`, `.mean()` is `$avg`, `.first()` / `.head()` are `$first`,
`.last()` is `$last`, `.max()` / `.min()` their operators. `.sumBy(fn)` and
`.meanBy(fn)` accumulate each document's OWN value — `{ $sum: { $sum: <map> } }`,
`{ $avg: { $avg: <map> } }` — because the accumulator alone ignores an array
operand (`$sum` of an array is 0 and `$avg` of one is null, measured), so
`.meanBy` in a group is the mean of the per-document means. A `GroupIn` carries
the receiver and `iteratee` for these cells; an operator call passes null.

```
$group({ _id: $.tag, total: $.a.sum(), f: $.a.first() });
  → [{"$group":{"_id":"$tag","total":{"$sum":"$a"},"f":{"$first":"$a"}}}]
$group({ _id: $.tag, q: $.items.sumBy(i => i.q) });
  → [{"$group":{"_id":"$tag","q":{"$sum":{"$sum":{"$map":{"input":"$items","as":"i","in":"$i.q"}}}}}}]
```

## What has no value

`undefined` (compare with it instead), a regex outside its methods, a lambda
outside a callback, `$$`/`$$$`/`$$$$` (the root rows' own texts), a declared
function read without a call, a `let` a document-replacing stage dropped. Each
refusal is in `errors.ts`, worded once, and every rejection that comes from a
row quotes the row.

## The acceptance gate

`node scripts/diff-compilers.mjs --cur src/compiler/index.ts --entry expr`
compares the new `expr` with the shipped one over the harvested corpus. A
lowering the registry still marks `pending` is a verified SKIP (the row's cell
must state `pending: <livesIn>`); a statement-shaped source — one the
expression parser refuses and the statement parser accepts, or one the shipped
`expr` answers with a pipeline — is the statement slice's, and skipped. Every
other divergence is a row in `test/accepted-divergences.json` with a reason:
`equivalent` (the fold settles a constant), `intended` (the `$switch` dispatch,
the `jsmql` mint prefix), `shippedBug` (a measured server fact the shipped
compiler contradicted), `message` (a reworded refusal), or `statement slice`.
The gate is green at zero unclassified rows.
