# The emit phase — the value and filter targets

The fifth phase of `src/compiler/` turns a settled tree into its MQL. This spec
owns the VALUE target (`jsmql.expr`), the FILTER target (`jsmql.filter`, a
`$match` body) and the modules under `src/compiler/emit/`. The registry states
what the language has. This phase states how a document is built, and only
where a row cannot state it — see `src/compiler/CLAUDE.md` for that boundary.

## The reading order

`lowerValue(node, env)` handles every node type in the tree, in one exhaustive
switch. Each case is one of three kinds.

1. **A node that is its own document.** A literal, a field path (`$.a.b` →
   `"$a.b"`, the bare `$` → `"$$ROOT"`), an array or object literal. A constant
   the fold could not write back as source — a `Date`, an `ObjectId`, a `Set` —
   is settled here by the evaluator before any row is read; a value holding a
   JavaScript `bigint` is not, because `$toLong` spells it.
2. **A name.** The reading order is: `consult` (the row's answer for the
   position), then `select` (the receiver's proof and the arguments' class),
   then the rule's own renderer over an `ExprIn` built by `inputs.ts`. Every
   JavaScript method, MongoDB operator, global and namespace member takes this
   road. So does every operator production with a plain renderer (`-`, `*`,
   `===`, `?:`, …).
3. **A construct that reads its neighbours.** `+` is `$concat` when an operand
   is provably a string, and `$add` otherwise. `&&`/`||` as a value keep the
   operand and bind a computed left side once. `x[i]` dispatches on what the
   receiver and the index are proven to be. `=== undefined` and `typeof x ===
   "t"` are the predicate vocabulary's expression cells. These are the rows
   whose cell says `inCode("src/compiler/emit/lower.ts")`.

`lowerTruth(node, env)` is the second reading: `&&`/`||`/`!`/`?:` recurse as
truths, and anything else is `truthOf(value, row says bool)`. See `mode.ts`.

## The receiver's proof and the runtime dispatch

`prove.ts` answers `typeOf(node, env)`, the receiver's proof: a literal, a
binding's recorded `Type`, a row's `returns` term evaluated at the call site, a
written field's recorded proof, and `ANY` for a field nothing wrote. The model,
the sources of a proof and the four dispatch rules — branches for the possible
families only, a default only where it can fire, a compile-time refusal only
where no possible kind is accepted, the one-family claim for `ANY` — are the
subject of [docs/specs/types.md](types.md). This section keeps what a CELL has to
know about the proof it runs under.

An unprovable receiver on a row with ONE field family is that family, by the
row's claim. On a row with two or more families, the compiler dispatches it at
run time over the families the receiver can be. `.indexOf()` and `.lastIndexOf()`
are the two such rows among the JavaScript methods: every other method reads one
family, and its row states a `sibling` sentence per family it refuses, which the
refusal (`errors.ts`) puts after its head — `'.length()' is not available on an
'array' — it is defined on 'string'. For the number of elements, write
'.size()'.` A branch whose `slotType` cannot take a PROVEN argument kind drops
out of the dispatch (`argsFit` in `select.ts`), and one branch left runs alone;
`checkSlotKinds` (`check.ts`) refuses a rule whose slot cannot take the proven
kind.

```js
$.x.indexOf("a")
// → { $switch: { branches: [{ case: { $in: [{ $type: "$x" }, ["array"]] }, then: { $indexOfArray: ["$x", "a"] } }, { case: { $in: [{ $type: "$x" }, ["string"]] }, then: { $indexOfCP: ["$x", "a"] } }], default: null } }
$.x.indexOf(1)
// → { $indexOfArray: ["$x", 1] }
```

**A JavaScript method on a receiver that may be missing answers null.** `nullOr`
in `src/registry/names.ts` is the one shape: `{ $cond: [{ $eq: [{ $ifNull: [r, null] }, null] },
null, <body over r>] }`, with the receiver bound by `$let` unless it is a path.
A cell calls it where its operator would otherwise ABORT on null (`$size`,
`$strLenCP`, `$setIsSubset`, `$in`'s list) or would answer a VALUE for it
(`$toUpper` → "", `$substrCP` → "", `$regexMatch` → false, `$indexOfCP` → -1) —
each case measured per row. The body runs on a proven receiver, so it carries
no `$ifNull` of its own. A row that dispatches on the receiver's type lets null
and missing fall to its `uncertain` default, which answers null. No branch
admits them through `alsoTypes` any more. The compiler skips the test when the
receiver is PRESENT (`ExprIn.present`): proven from the source by `isPresent`
(`emit/prove.ts` — a literal, the root document, a `$lookup`'s array, a `let`
of a present value through the binding's proof, a `neverNull` row over
present operands, a written field whose value was present, or a path a `?.`
proved through `Env.proving`), or proven at run time by the
`$type` test of the dispatch branch the cell runs under. A LODASH cell never
calls `nullOr`. The lodash rows do not yet share one answer for a missing
receiver — `.size()` answers 0, `.pick()` answers `{}`, `.uniq()` answers null
— and [DEF-037] tracks which one they should share. The `neverNull` fact is
stated per row: `.map`, `.filter`, `.slice` and `Object.keys` answer null only
for a null input. `.find` (a missing element), `.max` (of an empty array) and
`.match` (`$regexFind` with no match) do not state it.

**A `?.` with a CALL after it STOPS the chain.** `stoppedChain`
(`emit/lower.ts`) walks the receiver spine of a `MemberAccess` /
`IndexAccess` / `MethodCall` down to its base. When a call runs after the
`?.`, it answers the value the `?.` guards. `lowerValue` then emits `{ $cond:
[<that value is null or missing>, null, <the chain with every `?.` on its
spine cleared>] }`. The fold moves a `?.` on a plain read onto the PATH, so the
walk also checks the base `FieldRef`. A `?.` with no call after it answers
null anyway, because a path through a missing field is missing. So the
compiler emits no test there, and the consumer's neutral still describes it.

The second branch runs only when the test passed, so the guarded path IS
there inside it. `Env.proving(path)` records that fact, and `isPresent` reads
it. This is what keeps the cell from putting its own `$ifNull` back on the
same field. `Env.dropFields` does not carry the set: a stage that replaced the
document invalidates every path a test proved.

**The optional chain's neutral reaches a row that dispatches too.**
`withOptional` wraps the receiver in the family's empty value before any cell
sees it. The family is the receiver's family when proven, otherwise the ONE
field family the row lowers (`soleFieldFamilyOf`: a namespace is not a field
family, and neither is a family the row REFUSES, because a receiver of that
family is not a program that compiles). The wrap happens above the
rule/dispatch split, so `$.o?.keys()` takes `{}` although `.keys()` resolves
through a `$switch`. The dispatch reads such a wrapper once per guard rather
than binding it, because a row with one family left collapses to a single
branch anyway.

A cell has to know two more things about the proof. First, a value the row
guards may arrive as an ARGUMENT rather than as the receiver — a namespace
call (`Object.keys(o)`) has a receiver that is the namespace, so nothing about
it describes `o` — and `ExprIn.optionalArg` answers whether that argument
carries a `?.`. Second, a cell that reads `present` answers a DIFFERENT
document inside a dispatch branch, whose `$type` test proves the receiver,
from the one it answers outside the branch. When a row's family cell and its
`uncertain` are meant to be one answer, that difference makes the compiler
emit a `$switch` the row does not want. So those cells share one body that
does not read `present` at all (`lastIndexOfArray`, `pairsRead` in
`src/registry/names.ts`).

The branches are the field families that hold a rule, in the row's order. The
guard is `$type` against the family's BSON types, widened by the rule's
`alsoTypes`. The default is the row's required `uncertain`. The compiler binds
a receiver that is not a path or a variable once, with `$let`.

When a row states a REFUSAL for the position, that refusal is the answer even
on a receiver the row's `on` does not admit. It is the more specific sentence,
and the project wrote it for the receiver that reaches it (`$$.takeRight(3)`
hears why a stream cannot count from the end, not that the row lists
`array`). A mutator is the exception, because its refusal is advice ABOUT
arrays — `.sort()` says to write `.toSorted()`, which is right for an array
and wrong for `$.s.trim()`, a string that has neither method. There the proof
answers first.

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
[$.a, 2].size()         // → {$size:[["$a",2]]}           a JavaScript lowering wraps an array LITERAL receiver itself
```

`$let(vars, arrow)` binds the arrow's parameters to the vars, and both sides
carry the spelling of one variable encoder: `$let({ v_x: 1 }, (v_x) => v_x)` →
`{$let:{vars:{v_v_5fx:1},in:"$$v_v_5fx"}}`, so a name the server refuses
(`ROOT`) becomes one it takes. The compiler never folds `Number(<constant>)`:
`$toDouble("3")` is a double on the server, and a written `3` is an int.

`check.ts` holds the literal-gated checks. Each one reads a `BodyRule` or
`Arity` field the row states: required and closed keys (with a suggestion),
enums, flag sets, key and slot types, `elementType` over every operand,
`nullRefused` slots (a per-row fact: the server refuses `$size(null)`, but
`$reverseArray(null)` answers null), `constant` slots and `constantKeys`, and
the two refusals for a spread or a computed key inside an operator body. The
checks also cover the body facts the server enforces — `nonEmpty`,
`minimums`, `sortedList`, `atLeastOneOf` / `exactlyOneOf`, `requiresWhen` (a
key required once another holds a given value), and `nested` bodies whose
every value is checked (`eachValue`). A method row's `elements: "scalar"`
refuses a receiver that provably holds arrays (a literal of literals,
`.partition(…)`) before its rule runs. The checks never judge a slot that is a
field path, an expression or a spread. The checks run on every rule — an
operator's, a method's, a production's — and
`test/registry-fields-read.test.ts` makes sure that every stated rule field
has a reader.

## Truthiness

A JavaScript spelling checks missing, null, `false`, `""` and `0` — and only
the tests the value's proof can fail: the subtractive rule and its constant
folding live in [docs/specs/types.md § The truthiness rule](types.md#the-truthiness-rule).
The `$op(...)` escape hatch keeps MongoDB's own rules. The compiler does not
check NaN. `mode.ts` is the one minter of `Truth`, and `mql.ts` builds every
slot that reads one. The table in [docs/LANG_RULES.md](../LANG_RULES.md) states
the rule for developers.

## The filter target

`lowerFilter(node, env)` in `emit/filter.ts` turns a predicate into a QUERY
document — the language an index reads — and falls back to `{ $expr: <truth> }`
exactly where a row states no native form. The query semantics and the
measured divergences from the expression road are in
[filter-mode.md](filter-mode.md) § The filter road. The rule below is the one
this file owns.

```js
$.a > 1 && $.b <= 2                    // → {"a":{"$gt":1},"b":{"$lte":2}}
$.a >= 1 && $.a <= 9                   // → {"a":{"$gte":1,"$lte":9}}                     two operators on ONE field merge into one document
$.a === 1 && $.a === 2                 // → {"$and":[{"a":1},{"a":2}]}                    a COLLIDING key splits into $and
$.a === 1 && $.q * $.p > 100           // → {"a":1,"$expr":{"$gt":[{"$multiply":["$q","$p"]},100]}}
$.tags === "red" || $.q * $.p > 100    // → {"$or":[{"tags":"red"},{"$expr":{"$gt":[…]}}]}     PER BRANCH (the ruling)
$.a || $.b                             // → {"$expr":{"$or":[<truth a>,<truth b>]}}            every branch $expr: one $expr
$.tags.has("a") && $.tags.has("b")  // → {"tags":{"$all":["a","b"]}}
$.items.some(i => i.q > 2)             // → {"items":{"$elemMatch":{"q":{"$gt":2}}}}
{ status: "a", x: $gt($.y) }           // → {"status":"a","$expr":{"$gt":["$x","$y"]}}   a raw document keeps its keys, but an operand that READS the document has no query form and lifts through the row's `liftsTo` twin
$abs($.delta)                          // → {"$expr":<truth of $abs>}            a value operator is a predicate through its truth
```

Wrapping the whole `||` in `$expr` as soon as one branch needs it changes what
the other branches mean: `{ $expr: { $eq: ["$tags", "red"] } }` does not match
`tags: ["red", "blue"]`, where `{ tags: "red" }` does. So a leaf's answer would
depend on its sibling. Per branch, each branch means what the same predicate
means alone.

Per branch also changes WHEN a branch runs. The server picks the order of the
clauses in a query document. So a branch whose expression the server refuses
on some document can now run there, in a case where one `$expr` over the
whole `||` would instead run after a cheaper clause had already excluded that
document. Measured over `{a:1,b:1,c:5}`, `{a:2,b:"oops",c:1}`, `{a:2,b:1,c:9}`:

```js
($.a === 1 || $.b * 2 === 2) && $.c > 3
// per branch:  { $or: [{ a: 1 }, { $expr: { $eq: [{ $multiply: ["$b", 2] }, 2] } }], c: { $gt: 3 } }
//              the server refuses it: "$multiply only supports numeric types"
// one $expr:   { c: { $gt: 3 }, $expr: { $or: [{ $eq: ["$a", 1] }, { $eq: [{ $multiply: ["$b", 2] }, 2] }] } }
//              selects _id 1 and 3 — the `c` clause excluded the string `b` first
```

The server does not promise either order, and `"oops" * 2` is `NaN` in
JavaScript, which this language does not model. So an arithmetic expression
over a field of mixed type can fail on either shape. The per-branch rule
stands: a predicate that means one thing alone means the same thing beside a
sibling.

### A query operator's call form is its clause

A query operator CALLED — `$exists($.a)`, `$regex($.s, "x", "i")`, `$gt($.a, 1)`
— is the row's `filter` cell, and it writes the clause the document form
spells: the first argument is the field, and the rest is the operand. An
operator that also has an expression form answers the clause when the field
is a path and the operand a constant (a literal list or document of constants
counts as one), and answers null otherwise, so `$gt($.a, $.b)` takes the
expression road. A query-only operator must answer, so the compiler refuses by
name a first argument that is not a field path, and an operand read at run
time. The raw spelling keeps MongoDB's own reading — the compiler adds no
own-value clause — while an `$elemMatch` ARROW is a JavaScript spelling over
the element and reads it as one. `$and` / `$or` / `$nor` list their
predicates, each a filter of its own, as a call and as a key of a raw
document. `$not` negates one raw clause on one field, and otherwise takes the
expression form, whose negation of a JavaScript spelling is exact. `$expr(e)`
is `{ $expr: <expression> }`. `$text`, `$comment`, `$where` and `$jsonSchema`
take their literal.

A FRAGMENT — `$box` inside `$geoWithin`, `$case` inside `$switch`, the row's
`onlyInside` — is valid only as an argument of the operator it names. The
Env's site records the operator whose arguments the compiler lowers now
(`inside`); any other call boundary clears it. The compiler refuses by name a
fragment met elsewhere, in both the filter and the value target. A literal
list or document of constants is a literal for the raw operators alone
(`literalIn`). A JavaScript spelling reads it by reference — `$.tags === [1,
2]` is never true in JavaScript — and takes the expression road, where `$eq`
compares the whole value.

```
$exists($.a)                          → {"a":{"$exists":true}}
$and([{ a: 1 }, $.b < 2])             → {"$and":[{"a":1},{"b":{"$lt":2}}]}
$geoWithin($.loc, $box([[0,0],[1,1]])) → {"loc":{"$geoWithin":{"$box":[[0,0],[1,1]]}}}
```

### A query document is the plain one

`queryOwnValue` in `src/registry/vocabulary.ts` puts a cell's test at its path
and does nothing else. So the output is the document a MongoDB developer
writes by hand, and the server's own rules apply to it.

| source | shape |
|---|---|
| `$.a === 1` | `{"a":1}` |
| `$.a !== 1` | `{"a":{"$ne":1}}` |
| `$.a == null` | `{"a":null}` |
| `$.a != null` | `{"a":{"$ne":null}}` |
| `$.a.b === 1` | `{"a.b":1}` |

`{ $eq: v }` is written `v`, the spelling MQL reads and writes — except where
`v` would be read as something else, an operator document or a regular
expression.

MongoDB then satisfies a field comparison when any ELEMENT of an array value
satisfies it, and it traverses an array in the middle of a path. JavaScript
does neither. Two suites measure the gap and name every source it separates:
`test/compiler-js-agreement.test.ts` against JavaScript's own answers, and
`test/compiler-query-expr-agreement.test.ts` against the aggregation road.

`!p` is the COMPLEMENT of p's own clause — `{ $nor: [<p>] }` — whenever p has a
clause with no `$expr` inside. That is not a size choice: `$expr` orders
across BSON types, so `{ $not: { $gt: ["$v", 1] } }` is false for `v: [0, 20]`
and for `v: "x"`, where JavaScript answers true for both. So
`$.v > 1 || !($.v > 1)` stopped being a tautology. Measured, it is one again.
A predicate with an `$expr` inside keeps the truth road, whose own `$not` over
one expression is already JavaScript's answer.

Two measured facts hold the shape in place. First, the exclusion costs no
index: `{ a: { $eq: 1 } }` plans an IXSCAN over the bounds `[1, 1]`, exactly as
`{ a: 1 }` does — while a `$not` wrapped around the whole positive clause
drops to a collection scan. This is why a negation is an `$or`. Second, the
project compares the answer with JavaScript's own, by evaluating the source in
node over the same documents (`test/compiler-js-agreement.test.ts`). Two
families of source still differ there, and neither is an array: JavaScript
COERCES under a relational operator (`[2] > 1` is true), and it THROWS when a
path walks through a missing intermediate. Raw MQL — a raw `{ … }` filter
document, a `$op(…)` call — keeps MongoDB's own reading.

A query cell is a row fact. The comparison productions carry
`strictEqualityQuery` and its family (the type test, the presence test, the
modulo test, the null test, a field against a constant — in that order), and
`includes`/`startsWith`/`endsWith`/`match`/`some`/`inRange` carry theirs.
`$sampleRate` states its one slot `constant`, a `number` in the range `[0,
1]`. Each cell answers null where the operands are not a path and a constant,
and null is the `FilterOut` contract for "wrap my value form". A row with no
value form (a query-only operator) has nothing to wrap. So inside an
`$elemMatch` boundary — where the server refuses it — the leaf throws a worded
refusal before the cell runs. `FilterIn` hands a cell `pathOf` (a `.length()` call is
never a path segment; inside a `.some` callback the INNERMOST element is the
root, and only its fields are paths — an outer callback's parameter read
inside a nested one has no query form and takes the `$expr` road; the
`$elemMatch` boundary records which parameter is its element), `constant` (a
value the query language compares as written — never an array, a regex or a
bigint), `query`, `nativeQuery` and `elementQuery`.

`.inRange()` accepts its two bounds either way round, and the value form
orders them at run time with `$min`/`$max`. A query clause has no such
operator, so its cell orders the pair at COMPILE time — which it can only do
when both bounds are constants of one kind, two numbers or two dates. Any
other pair answers null and takes the `$expr` road, so the compiler emits no
clause from a comparison it could not actually make.

The predicate alias tables (`typeof` spellings, the numeric group) are
registry data in `vocabulary.ts`, and both the query and the expression cells
read them.

## The statement target

A program is a sequence of statements, and each becomes zero or more STAGES.
Two statements never merge: the `;` the developer wrote IS the stage boundary,
and the `,` IS the merge. So one source keeps one output, and no rule reads
across a boundary the developer drew.

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

Inside a `,`-joined run, the writes group as far as ONE stage can carry them.
Three things end a group, each measured on the server.

| the run | becomes | because |
|---|---|---|
| `$.a = 1, $.b = 2` | one `$set` | one `$set` evaluates every value against the document it received |
| `$.x = 1, $.z = $.x` | two `$set`s | the second must read the NEW `x`, and one stage would read the old one |
| `$.a = 1, $.a.b = 2` | two `$set`s | the server refuses a parent beside its own child: "specification contains two conflicting paths" |
| `$.a = 1, delete $.b` | `$set` then `$unset` | two stages, because they are two stages |

A write to the document ROOT is its own stage: it replaces what the next
write would be written into. `$.a = $.b, $.b = 1` needs NO split — writing
what an earlier value read is exactly what one `$set` already means.

A statement that NAMES something asks the row, and the row's own cell renders
it. The compiler does not ask `isStageName`: `assert(…)` is a statement and is
not a stage, and asking the wrong question would refuse it with the wrong
word. A stage's BODY lowers in the position its row states (`bodyPositions`).
This is how `$match`'s predicate becomes a query document and a `$group`
output key becomes an accumulator, without either cell knowing which reading
it asked for. `readIn` is that hub.

The compiler applies four facts the row states where the statement stands,
each because the server enforces it and no renderer implies it.

| the row says | the target does | measured |
|---|---|---|
| `only: ["stageFirst"]` | refuses the stage anywhere but first, and anywhere its own body needs a hoisted stage | "$documents is only valid as the first stage"; "$geoNear was not the first stage in the pipeline after optimization" |
| `only: ["stageLast"]` | files it on the chain, so the `__jsmql` cleanup precedes it, refuses a statement after it, and refuses a body that READS a scratch field | "$out can only be the final stage"; "Use of undefined variable: v" |
| `forbiddenIn: […]` | refuses it inside those containers | the server refuses a write stage in a sub-pipeline |
| `bodyPositions` | reads each body key in the position it names | `$geoNear`'s `query` as an aggregation expression: "unknown top level operator: $eq" |
| `bodyPositions` with a `{ list, otherwise }` pair | reads a bracketed list one way and every other shape the other | `$merge`'s `whenMatched` takes an update pipeline or one of four words |
| `statementBody` | says what a `statement` slot HOLDS: a pipeline of its own, or an update spec and the stages it runs | "$sort is not allowed to be used within an update" |
| `literalKeys` | judges a `$`-led string against the closed set, because the server reads the key as a word | `{ $merge: { whenMatched: "$g" } }` → "Enumeration value '$g' for field 'whenMatched' is not a valid value" |

A stage's own body sub-pipeline runs under its OWN chain, with the container
recorded as a boundary. Without the chain, a stage filed as LAST files onto
the outer chain and silently leaves the body — measured: a `$out` inside a
`$lookup` body landed at the end of the outer pipeline, and the body came out
empty.

**A first-only row reads a hoist, not just a position.** A value in a stage's
own body can need a stage of its own — `$$.size()` needs a `$setWindowFields`,
a `$$$.<coll>` read needs a `$lookup` — and the compiler places that stage
directly ahead of the one that reads it
([lookup-stage.md § Where a hoisted stage lands](lookup-stage.md)). So "is
this stage first?" is only half the question: `place` asks it again of the
chain's PENDING hoist, which by then holds whatever this stage's body made.
A first-only stage with one pending hoist has no placement at all — the
materialiser cannot follow the read, and nothing may precede the stage. So
the compiler refuses it and names the later-statement rewrite. The chain it
asks is `env.chain`, never the root one: a `$$.size()` read inside a
sub-pipeline stamps OUTSIDE it and leaves that body's own first stage first
(measured, the server runs it). The compiler judges a name the BODY holds the
same way, unless the row files its slot as a sub-pipeline — a stage there is
first where IT stands, because its own `place` call already said so. Which
slots those are is the row's `statementBody` fact, not the slot's `statement`
kind. The two are different things: `$lookup.pipeline` and a `$facet` branch
start a pipeline, while `$merge.whenMatched` is an UPDATE spec with no first
position at all and a closed set of stages the server runs there. Reading the
slot kind alone conflated them, and one line then did two wrong things at
once: it refused `$geoNear` first-in-a-`$lookup`-body because a statement
preceded the `$lookup` (the server runs that), and it caught a banned stage
in `whenMatched` only when a statement happened to precede the `$merge` (the
server never runs that). The row states which kind it is. A row that files a
`statement` slot and states nothing fails the build. The `stageLast` mirror
is the same fact read backwards: the cleanup that drops the scratch fields is
the stage before the terminal stage, so a terminal body that reads a scratch
field reads a field already gone.

Two JavaScript meanings the query language does not share by default:

```js
$.n = { x: 1 }       // → { $set: { n: { $mergeObjects: [{ x: 1 }] } } }
$.a = 1, $.b = "$a"  // → two $sets, because `"$a"` IS a read of `a`
```

`{ $set: { n: { x: 1 } } }` MERGES into `n` on the server — measured, `y`
survived — where a JavaScript assignment replaces the field. `$mergeObjects`
makes the document the value of an expression rather than a nested field
spec, and unlike `$literal` an expression inside it still evaluates. A `"$a"`
the developer typed is the field `a` (HR1), so it ends a write group exactly
as `$.a` does. Without that, one `$set` would give `b` the value `a` held
before the stage.

The compiler asks which DOCUMENT the whole program becomes once, at the
entry: a folded constant array (`[1,2].slice(2,2)` settles to `[]`) is a
VALUE, and read as a program it would compile to no stages at all.

The compiler checks a stage's BODY from the row's own facts, through the same
two mechanisms an operator's arguments use: `args` for a body that is not an
object (`slotType`, `constant`, `slotRange`), and `body` — a `BodyRule` — for
one that is. The valuable half is `constant`: a slot the server reads before
any document exists accepts a field path SILENTLY, and `$unionWith($.c)`
unions a collection literally named `$c` rather than saying so. `fieldName`
is the ArgType for a slot that NAMES a field to write, where a `$`-led string
is the error rather than a run-time value — the one place the literal gate is
bypassed, because the server refuses `{ $count: "$n" }`.

### The stream road

`$$.filter(d => d.x > 1).sortBy("k").take(3);` — and the same chain with an
explicit `$$ =` head, which is never the default spelling — are one program: a
chain on the stream, one row's `stream` cell per link, base first. A stage is
a link too (`$$.$match(…)`), through the very cell its statement form uses,
and each link's stages take the placement its row states. The compiler
refuses a link after `$out` exactly as it refuses a statement after it.

```js
$$.filter(d => d.x > 1);          // → [{"$match":{"x":{"$gt":1}}}]
$$.map(d => ({ a: d.x }));        // → [{"$replaceWith":{"a":"$x"}}]
$$.sortBy("x").take(2);           // → [{"$sort":{"x":1}},{"$limit":2}]
$$.toSorted((a, b) => b.x - a.x); // → [{"$sort":{"x":-1}}]
$$.reject(d => d.x > 1);          // → [{"$match":{"$nor":[{"x":{"$gt":1,…}}]}}]   the complement, as `!p` is
$$.uniqBy("k");                   // → [{"$group":{"_id":"$k","__jsmqlTmp":{"$first":"$$ROOT"}}},{"$replaceWith":"$__jsmqlTmp"}]
$$.take(0);                       // → [{"$match":{"$expr":false}}]           `$limit: 0` is refused by the server
```

A callback's FIRST parameter IS the stream's document: `d.x` is the path "x"
in a predicate and `"$x"` in a reshape, and the bare `d` is `"$$ROOT"`. `$.x`
inside the callback names the same document — the root — as HR4 says it does
everywhere. The compiler binds the index and collection parameters lodash
allows, and a READ of either says what to write instead (a stream has no
per-document index; `$$.size()` is its size).

A stream cell receives its arguments as SOURCE and asks for the reading it
wants: `predicate(cb)` a query document (total — a body with no native form
arrives as `$expr`), `reshape(cb)` a value, `block(cb)` the stages of a
`{ … }` body, `sortSpec(e)` and `orderBy(keys, orders)` the
`{ field: 1 | -1 }` document from any of the sort spellings
(`emit/sort-spec.ts`, a reader over the tree that never lowers), `slot()` a
scratch field the chain's cleanup drops, `element()` where the stream's
element lives (the document, or the unwound field after `.flatMap` — see
[stream-methods.md § The element after `.flatMap`](stream-methods.md#the-element-after-flatmap)),
and `unwound(path)` to say it moved. A bare `$$.<name>(…)` with one link asks
the row's STATEMENT cell first — the union sugar and the source stages are
statements spelled on the stream, and their rows say so.

### Bindings between stages

The compiler carries a `let` whose value is not a constant between stages, in
a field of the document, `__jsmql.var.<name>`, and the chain's trailing
cleanup drops it. A constant `let` never gets that far: the fold inlines it.
`x = …` writes the binding again when it is a `let`, and the compiler refuses
it when it is a `const`. A second `let x` in the same block is refused, as
JavaScript refuses it. A nested block — a stage's `[ … ]` body, an
`o => { … }` block — declares its own names and sees the outer ones, so a
`let` there shadows and never collides.

```js
let x = $.a * 2; $.b = x;            // → [{"$set":{"__jsmql.var.x":{"$multiply":["$a",2]}}},{"$set":{"b":"$__jsmql.var.x"}},{"$unset":"__jsmql"}]
let t = $.a; $$.filter(d => d.x > t);  // → the binding is a FIELD, so the predicate is field-to-field: {"$expr":{"$gt":["$x","$__jsmql.var.t"]}}
let x = $.a; $group({ _id: x });     // → the group drops every field, the cleanup is not owed, and a later `x` is refused
```

The scope THREADS through the program: each statement answers the Env the
next one lowers under. A stage whose `document` effect replaces the document (see docs/specs/types.md) takes
every field-carried binding with it — `true` for `$group`, `$replaceWith`,
`$count` and their kind, `"inclusion"` for a `$project` whose body names
fields to keep — and the compiler refuses a read after that, naming the
stage, rather than emitting a read of a field the stage took away. The way
back is the one JavaScript allows: `x = …` on a dropped `let` writes its slot
again, and the next statement reads it. A dropped `const` can only be carried
as a field of the new document. Every name that has no value here — a
dropped binding, a callback's index or collection parameter the stream
cannot fill, a function inside its own body — is one `dropped` marker
carrying the wording its read throws. This way the reason is worded where
the name was taken away, and not guessed where it is read. `$$ = [ … ]`
starts the stream from a literal list of documents — see
docs/specs/replace-root-stage.md for the pair it emits and why. The empty
list is a stream of nothing.

### The join road

`$$$.<coll>.<chain>` is a `$lookup`, in every position the chain may stand
(`emit/join.ts`). **A body that opens with a correlated equality** — its
first stage is a `$match` whose predicate says
`<foreign field> === <outer field>`, alone or as one `&&` conjunct among
others, where the outer side is a document field (`$.x`, or a binding the
compiler stores as `__jsmql.var.<name>`) — is the `localField` /
`foreignField` pair: the join every MongoDB developer reads and writes, and
the one the planner reads straight off the foreign index (a multikey index
when either side is an array). The server's own rules then apply to it: a
missing field counts as null, and an array matches element-wise, so two
arrays join when they share one element. That is the same boundary a query
document has (see docs/LANG_RULES.md), so the two say one thing.

**The links that follow the equality go into `pipeline` beside the pair.**
MongoDB 5.0+ runs a `$lookup.pipeline` over the documents `localField` /
`foreignField` matched (the concise correlated subquery). So a trailing
sort, cut, group or document `.map` changes what the join RETURNS and never
what it MATCHES: the same predicate is the same join with or without a
`.take(n)`. The compiler takes the pair from the body's FIRST stage — an
equality that follows a sort or a cut is a `$match` in place. A later stage
that still reads the outer document keeps its `let` beside the pair (the
server accepts all four keys together; measured on 8.3.7). `.find` is the
pair with `pipeline: [{ $limit: 1 }]`: the server takes one matched document
per outer document and stops (measured: one key and one document examined
per outer document), where the pair alone would materialise every match
first — 110 matching documents of 1 MB each answer Location4568. The pair's
read leaves `let` unless a later stage reads it.

**The other conjuncts of that first `$match` stay in it**, as the
pipeline's first stage over the pair's matches: a constant clause as the
query document it already is, an expression clause under `$expr` (the
compiler drops the `$and` when one clause is left). The FIRST conjunct that
is a correlated equality is the pair, and a second one keeps its `let` var
and its `$expr` beside it. Everything else keeps `let` + `pipeline` +
`$expr`: a predicate whose comparisons are not equalities, an equality
under `||` (the `$match` is an `$or`, not a conjunction), or a side that is
not a plain field path. The pipeline form compares the two fields' OWN
values as JavaScript does (`undefined === null` is false), and it uses the
foreign index too (measured on mongod 8.3.7: `indexesUsed`, keys examined =
rows matched). `$expr: { $eq: [array, array] }` compares whole arrays. This
is why the compiler never emits an array-to-array join in this form: the
developer wrote one equality, and the pair is the join that reads it
(measured on 5000 orders with a multikey index: the pair examines one key
per matched row; the `$expr` form scans the collection and matches
nothing).

```js
$.orders = $$$.orders.filter(o => o.userId === $._id);
// → [{ $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "orders" } }]
$.orders = $$$.orders.filter({ userId: $._id });
// → the same stage: the query spelling of one equality is the same join
$.recent = $$$.orders.filter({ userId: $._id }).toSorted({ placedAt: -1 }).take(5);
// → [{ $lookup: { from: "orders", localField: "_id", foreignField: "userId",
//       pipeline: [{ $sort: { placedAt: -1 } }, { $limit: 5 }], as: "recent" } }]
const ids = $.wants; $.o = $$$.orders.filter({ productIds: ids }).take(100);
// → [{ $set: { "__jsmql.var.ids": "$wants" } },
//    { $lookup: { from: "orders", localField: "__jsmql.var.ids", foreignField: "productIds",
//       pipeline: [{ $limit: 100 }], as: "o" } },
//    { $unset: "__jsmql" }]   — two arrays: joined on a shared element, from the multikey index
$.paid = $$$.orders.filter(o => o.userId === $._id && o.status === "paid");
// → [{ $lookup: { from: "orders", localField: "_id", foreignField: "userId",
//       pipeline: [{ $match: { status: "paid" } }], as: "paid" } }]   — the other conjunct, beside the pair
let cutoff = $.minTotal; $.big = $$$.orders.filter(o => o.userId === $._id && o.total > cutoff);
// → [{ $set: { "__jsmql.var.cutoff": "$minTotal" } },
//    { $lookup: { from: "orders", localField: "_id", foreignField: "userId",
//       let: { jsmql_v0_cutoff: "$__jsmql.var.cutoff" },
//       pipeline: [{ $match: { $expr: { $gt: ["$total", "$$jsmql_v0_cutoff"] } } }], as: "big" } },
//    { $unset: "__jsmql" }]
$.first = $$$.orders.find(o => o.userId === $._id);
// → [{ $lookup: { from: "orders", localField: "_id", foreignField: "userId", pipeline: [{ $limit: 1 }], as: "first" } },
//    { $set: { first: { $first: "$first" } } }]   — absent when nothing matched
$.n = $$$.orders.filter(o => o.userId === $._id).size();
// → the $lookup HOISTED into "__jsmql.tmp.0", { $set: { n: { $size: "$__jsmql.tmp.0" } } }, { $unset: "__jsmql" }
```

**The chain peels.** A link goes into `$lookup.pipeline` while its row has a
`stream` cell that accepts it — `filter`/`reject`, the sort spellings,
`take`, `aggregate`, a stage link, a `.map` whose body is a provable document
(the row states `streamBody: "document"`). The first link that is not such a
link ends the body. It and everything after it — `.size()`, `.total`, `[0]`,
a value `.map` — read the materialised array as a VALUE. A row that states
`elementOnly` (`.difference`, `.compact`, the bare `.sortBy()`, …) is such a
link only while the body's element is an unwound field; on a stream of whole
documents it ends the body the same way. `.find` is the one special head
(the row states `picksOne`): `filter` plus `{ $limit: 1 }`, with the slot
unwrapped by `$first`. A link that folds the stream into one document
(`collapses` on the row: `countBy`, `keyBy`, `groupBy` with a field name) is
unwrapped too, to `{}` when nothing matched, as lodash answers for an empty
array. The slot is a typed binding, so `.size()` on it is `$size` with no
run-time guard, and `.total` after `.find` is a path. When the body ends
with its element in an unwound field (`Lookup.element`, set by a `.flatMap`
no later stage replaced), the value is the elements and not their carriers:
the compiler rebases the rest of the chain onto `<slot>.map(x => x.<element>)`
(or onto the slot itself when the whole value is a COUNT — `.size()` /
`.size()` — since one document holds one element; or `<slot>.<element>`
after `.find`). The `$ =` road replaces with `$<slot>.<element>`, and the
direct-to-`as` shortcut declines so the value road runs.

**Where it stands decides the destination.** A bare write `$.o = <chain>`
and a `let` make the target the stage's `as` — no scratch, no cleanup.
Inside a value, the compiler hoists the stage ahead of the stage that reads
it, into `__jsmql.tmp.<n>`. `$$ = <chain>` switches the stream: correlated
(the body read the outer document), a `$lookup` per document unwound into
the stream; uncorrelated, `{ $match: { $expr: false } }` and a `$unionWith`.
`$ = $$$.c.find(p)` makes each document the one it found, through `$unwind`
— a document that found nothing has nothing to become and leaves the stream
(`$replaceWith: { $first: … }` fails on the server for it, measured). The
compiler refuses a chain with no destination, and names the three that
exist.

**Correlation is the Env's business.** Every binding records the LEVEL of
documents it lives on (0 for the root pipeline's, one more per body over
another collection), and `Env.render` reads a located value: on this level,
as its path; on a shallower level, through the `let` of the boundary whose
stage runs over that level's documents (`Capture`, held by reference on the
boundary like a Chain), as `$$jsmql_<f|v|s><level>_<hint>` — `f` a field, `v`
a `let` binding, `s` a system value; the names come from `src/namespace.ts`.
The compiler captures a root read two levels down once, at the outermost
`$lookup`, and reads it by name below: MQL variables are lexically scoped
through nested `$lookup.pipeline`s (measured). The raw stage call
`$lookup({ …, pipeline: [ … ] })` is the same road: the compiler merges what
its body reads of the outer document into the developer's own `let`.
`$unionWith` has no `let` (measured: `IDLUnknownField`), so the compiler
refuses a read of the outer document inside it, and names the way out.

**Inside the body.** The callback's parameter IS the body's document: `o.x`
reads it, `o.x = …` / `delete o.x` write it (`$set` / `$unset`), `o = { … }`
replaces it. The callback's THIRD parameter is the body's own stream:
`coll.filter(…)` is a `$match` there, and `coll.size()` its count (a
`$setWindowFields` inside the body). `$.` is the OUTER document and `$$` the
ROOT stream at every depth (HR4): `$.x` is read-only from inside — the
compiler refuses `$.x = …`, naming `o.x = …` — `$$.size()` is the root
count, materialised on the root pipeline and carried in by `let`, and the
compiler refuses `$$.filter(…)` inside a body, naming `coll`. A nested
`$$$.items.filter(…)` inside a predicate is hoisted inside the body's own
chain, whose close runs its own cleanup, so no `__jsmql.tmp` scratch leaks
into the joined array.

### The facet, union and out roads, the source stages, and declared functions

**`$ = { k: <$$ chain>, … }` is a `$facet`** (`statement.ts`, `facetStages`):
one branch per entry, each the stages its chain means under a `$facet`
boundary, so the row's `forbiddenIn` refuses a `$out` or a second `$facet`
inside. Every entry must be a chain on `$$` — the compiler refuses a value
among branches, naming the key — and a bare `$$` is the stream unchanged
(`[]`). Branch names follow the server's field rules (not empty, no `.`, no
leading `$`; measured). The facet is a document-replacing stage, so the
bindings end with it. The compiler refuses a chain on `$$` anywhere else than
the root replace, as "not a value", and points at the facet form.

**`$$.push(…)` and `.concat(…)` are `$unionWith`** (`emit/union.ts`), one
stage per source in order: `...$$$.c` is `{ $unionWith: "c" }`,
`...$$$.c.filter(p)` is the collection with its pipeline, `$$$.c.find(p)` (no
spread) is the same with `$limit: 1`, and a run of documents is one
`$documents`. JavaScript's spread rule holds — an array spreads, one document
does not — and the compiler refuses the wrong one, naming the other spelling.
The rows state `unions`. A `$unionWith` body has no `let` (measured), so the
compiler refuses a read of the outer document inside it, where it reads;
`$documents` runs over nothing, so it refuses `{ a: $.a }` there the same
way.

**`$$$.<coll> = <stream>` and `$$$$.<db>.<coll> = <stream>` are `$out`**
(`outStages`): the stream's stages, then the write, filed as the pipeline's
last stage — so the `__jsmql` cleanup precedes it, and nothing can follow it.
The right side must be `$$` or a chain on it. The target is one name for the
current database (`{ db, coll }` for another), constant, not empty, and not
`$`-led (measured).

**`$$ = [{ k: $$.reduce((acc, d) => …, init), … }]` folds the stream to one
document** (`emit/reduce-wrap.ts`): one `$group` with `_id: null` and one
accumulator per key, then the `$replaceWith` that drops `_id`. The compiler
reads each body as the accumulator it spells — `acc + d.x` is `$sum`,
`acc + 1` counts, `Math.max`/`Math.min`, `acc ?? d.x` is `$first`, a bare
`d.x` is `$last`, `[...acc, d.x]` or `acc.concat(d.x)` is `$push` — and it
refuses a body that spells none, naming them. The object form
`[$$.reduce((acc, d) => ({ ...acc, k: acc.k + … }), { k: init })]` names
every fold in its body and its init, and the two sets must agree. The init
is JavaScript's own and stays unread: MongoDB's accumulators have their own
neutral elements. The compiler refuses a `$$.reduce` anywhere but inside
this wrap, and names the wrap.

**The source stages** — `$$.indexStats()`, `$$$$.currentOp(…)` and their
kind — run each row's own statement cell (`refStatement`), with the receiver
checked against the sigil the row's `on` states, so the compiler refuses
`$$$$.indexStats()`, naming `stream`. Their rows' `only` field makes them
first-stage-only.

**A declared function** binds its name to its body and emits no stage; a
call inlines the body as a `$let` (`lower.ts`, `applyLambda`). The compiler
refuses a second declaration in one block, as JavaScript refuses it.

**`assert(condition[, message]);` is a guard stage** — the row's own
statement cell: a `$match` whose `$expr` converts `true` to a type NAMED by
the outcome, `"bool"` when the condition holds and the message when it does
not. The server refuses the unknown type name, and its error carries the
message (measured: `Unknown type name: jsmql assertion failed: …`). The
compiler reads the condition as a truth (a JavaScript spelling tests
JavaScript truthiness). It spells a literal message into the name, and
concatenates a dynamic one at run time.

```
assert($.qty >= 0, "qty must be >= 0");
  → [{"$match":{"$expr":{"$convert":{"input":true,"to":{"$cond":[{"$gte":["$qty",0]},"bool","jsmql assertion failed: qty must be >= 0"]}}}}}]
```

## The method cells

A JavaScript method's value lowering is its row's `expr` cell — `{ args,
emit }`, per family under `perFamily` when the method lives on more than one
prototype — and the pure MQL builders the cells share live in
`src/registry/mql.ts`, a leaf like the rest of the registry. A cell RECEIVES
everything it needs (`ExprIn`: the lowered receiver, the source arguments,
`value`, `truth`, `iteratee`, `predicate`, `objIteratee`, `callback`,
`reducer`, `elements`, `bind`), and it throws nothing: every refusal is a
fact on `args` the dispatcher checks first — `slotType`, `slotEnums`,
`regexFlag` (`.matchAll` needs `g`), `dateFormat` (a `%` specifier the
server knows, and a Moment token named for what it is), `body` (an options
document's keys, types and `notTogether` families), `reject` (a count with a
message of its own). So what the cell then reads is already known to be
well-formed.

Where JavaScript and MongoDB number differently, the cell follows
JavaScript: `getMonth()` and `getDay()` count from 0 (`$month` and
`$dayOfWeek` count from 1), so each subtracts 1. The local-time accessors
are the same operators as the UTC ones: the server has no client time zone,
so both read UTC. Every field-family row refuses a receiver PROVEN to be of
a kind no family has — a boolean, an ObjectId — and names the way to the
type the method takes. A `?.` on a receiver of unproven type takes the
neutral of the one family the row names.

The callbacks are services, so a cell never binds a parameter itself.
`callback` is the array callback `(x[, i[, arr]]) => …`: an index read makes
the input the `[i, x]` pairs of a `$zip`. `reducer` is `(acc, x[, i]) => …`
with its seed: the accumulator IS `$value` and the element IS `$this` when
the body is plain arithmetic, and the compiler reads both through a `$let`
when the body calls anything, because a call may lower to a `$reduce` of its
own and shadow them. `elements` binds one parameter per position of one
array element — `.zipWith`'s arrow over a `$zip` pair.

```
$.a.reduce((acc, x) => acc + x, 0)
  → {"$reduce":{"input":"$a","initialValue":0,"in":{"$add":["$value","$this"]}}}
$.a.reduceRight((acc, x) => acc.concat([x]), [])
  → {"$reduce":{"input":{"$reverseArray":"$a"},"initialValue":[],
               "in":{"$let":{"vars":{"acc":"$value","x":"$this"},"in":{"$concatArrays":["$acc",["$x"]]}}}}}
```

A rule that reads its arguments as ONE list states `spread: true` on its
`args`, and the desugar pass packs a spread call's arguments into one array
literal for it (see [desugar-pass.md](desugar-pass.md)): `Math.max(...$.a, 1)`
reaches its cell as one operand, `{ $max: { $concatArrays: ["$a", [1]] } }`,
and `Object.assign({}, ...$.docs)` reaches it as `{ $mergeObjects: <one list> }`
— the server reads a single array operand for both (measured).

The globals follow JavaScript where the two number differently or the server
holds a different equality. `new Date(y, m, d, …)` and `Date.UTC(…)` count
the month from 0, like `getMonth()`, so the month moves up by one on the way
to `$dateFromParts` (folded for a literal). `Number.isNaN` reads `$toString`,
because the server holds NaN equal to itself (`$eq: [NaN, NaN]` is true,
measured), and `Number.isInteger` excludes NaN and the infinities the same
way. `Math.cbrt` keeps the sign (`$pow` of a negative base to 1/3 is NaN).
`Number` is the one numeric conversion: the compiler parses `parseInt` and
`parseFloat` and refuses them, because a bare `parseInt` takes the element
index as its radix, and `$toInt` refuses a fractional string. The Set
relations (`isSubsetOf`, `isSupersetOf`, `isDisjointFrom`,
`symmetricDifference`, and the three set operations) accept a Set or an array
receiver: `new Set(x)` folds to `x`, since the server has no set type.

A JavaScript aggregate written where a stage takes an ACCUMULATOR — a
`$group` output field, a `$setWindowFields.output` entry — is the row's
`group` or `window` cell, and the receiver is the accumulator's operand:
`$.a.sum()` is `{ $sum: "$a" }`, `.mean()` is `$avg`, `.first()` / `.head()`
are `$first`, `.last()` is `$last`, `.max()` / `.min()` are their operators.
`.sumBy(fn)` and `.meanBy(fn)` accumulate each document's OWN value —
`{ $sum: { $sum: <map> } }`, `{ $avg: { $avg: <map> } }` — because the
accumulator alone ignores an array operand (`$sum` of an array is 0, and
`$avg` of one is null, measured). So `.meanBy` in a group is the mean of the
per-document means. A `GroupIn` carries the receiver and `iteratee` for these
cells; an operator call passes null.

```
$group({ _id: $.tag, total: $.a.sum(), f: $.a.first() });
  → [{"$group":{"_id":"$tag","total":{"$sum":"$a"},"f":{"$first":"$a"}}}]
$group({ _id: $.tag, q: $.items.sumBy(i => i.q) });
  → [{"$group":{"_id":"$tag","q":{"$sum":{"$sum":{"$map":{"input":"$items","as":"i","in":"$i.q"}}}}}}]
```

## The update-document target

`update(source)` is the OBJECT form of an update — what
`updateOne(filter, …)` takes when it is not a pipeline. Its root position is
`updateDoc`, and every statement under it stays there (`edge` keeps the
position below a `Pipeline` and an `UpdateFilter` at that root), so no
statement sugar rewrites a write: `$.n += 2` IS `{ $inc: { n: 2 } }`, and
`$.tags.push(x)` IS `{ $push: { tags: x } }`. A document-form update takes
CONSTANTS — the server reads `"$b"` there as the string — so the compiler
refuses a read of the document anywhere in a value (`Env.render` at this
root), and names the pipeline form as the way to compute.

| Write | Document |
|---|---|
| `$.a = c` / `delete $.a` | `$set` / `$unset: { a: "" }` |
| `$.n += c`, `-= c`, `++`, `--` | `$inc` (negated for `-=`) |
| `$.n *= c`, `/= c` | `$mul` (`1 / c` for `/=`) |
| `$.n = Math.min($.n, c)` / `Math.max` | `$min` / `$max` (the same path on both sides) |
| `$.t = new Date()` | `$currentDate: { t: true }` |
| `$.b = $.a; delete $.a;` (either order) | `$rename: { a: "b" }` — a copy without the delete is refused |
| `$.tags.push(x[, y])`, `.unshift(x)` | `$push`, with `$each` for several and `$position: 0` for unshift |
| `$.tags.pop()` / `.shift()` | `$pop: 1` / `$pop: -1` |
| `$inc({ n: 2 })`, `{ $inc: { n: 2 } }` | the row's `updateDoc` cell, as written |

The compiler refuses a field written twice in one document, as the conflict
the server would raise. The update operators' `updateDoc` cells pass their
document through. The fragments (`$each`, `$slice`, `$sort`, `$position`) are
valid only inside `$push` / `$addToSet`, which `onlyInside` enforces.

```
$.n += 2; $.tags.push(3, 4); $.b = $.a; delete $.a;
  → {"$inc":{"n":2},"$push":{"tags":{"$each":[3,4]}},"$rename":{"a":"b"}}
$.a = $.b + 1
  → refused: a document-form update takes constants — use the pipeline form
```

## What has no value

`undefined` (compare with it instead), a regex outside its methods, a lambda
outside a callback, `$$`/`$$$`/`$$$$` (the root rows' own texts), a declared
function read without a call, and a `let` a document-replacing stage dropped.
Each refusal lives in `errors.ts`, worded once, and every rejection that
comes from a row quotes the row.

## What proves the value target

Three suites run it on a live mongod and compare the server's answer with
JavaScript's own for the same input: [`test/compiler-methods.test.ts`](../../test/compiler-methods.test.ts)
per method cell, [`test/compiler-fold-agrees.test.ts`](../../test/compiler-fold-agrees.test.ts)
for a folded constant against its run-time lowering, and
[`test/compiler-returns-agrees.test.ts`](../../test/compiler-returns-agrees.test.ts)
for each row's measured `returns`. A `toEqual` proves only what JSMQL EMITS;
only the server proves the document runs (HR3).
