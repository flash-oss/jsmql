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

What this target has NOT built yet is stated as data — `PENDING_CONSTRUCTS` in
`emit/errors.ts` — so the differential harness can VERIFY a "not yet" rather
than trust one, and so the work left is countable. The list emptying is what
finishing the statement target means.

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
