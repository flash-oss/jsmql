# The desugar pass

## Overview

A sugar is a construct that MEANS another construct the language already has.
`$.items.sort();` means the write `$.items = $.items.toSorted();`. `$.a.b` means
one field path. `$.items.filter({ a: 1 })` means the arrow it is short for. The
desugar pass rewrites every one of them, source to source, before any lowering
runs. After the pass, those shapes are gone.

That property is the point. Every loop that lowers must recognise a sugar
recognised DURING lowering. JSMQL assembles stages from more than one place, and
a loop that does not know a form mis-lowers it silently, instead of refusing it.
A pass that removes sugar cannot miss it, because by the time any loop runs there
is nothing left to miss.

The destination-visible sugars — `$ = <expr>`, `$$$.<coll>.find(…)`,
`$$.push(…)`, `$$.indexStats()` — are NOT rewritten here. They read their
neighbours: the stages already emitted, the chain they sit in, the target a
write names. A source-to-source rewrite cannot see those neighbours, so the emit
phase lowers each form where its neighbours are in hand ([emit-pass.md](emit-pass.md)).
Each form's own rules stay in its own spec; see [docs/CLAUDE.md](../CLAUDE.md) for
the index.

This file owns the pass: what it rewrites, in what order, and the constraints
that order must respect.

## The forms

One row per rule, in `RULES` order
([desugar.ts](../../src/compiler/passes/desugar.ts)):

| Rule | Trigger | Becomes |
|---|---|---|
| `compoundAssign` | `$.n += 1;` | `$.n = $.n + 1;` — every later rule reads `op` as `=` |
| `incDec` | `$.n++;` | `$.n = $.n + 1;` |
| `bareReturnBlock` | `x => { return E }` | `x => E` — required, or an empty `$let: { vars: {} }` reaches the emitter |
| `fieldPath` | `$.a.b` | one `FieldRef` holding `a.b` |
| `mutatorTwin` | `$.items.sort();` | `$.items = $.items.toSorted();` — the row's `immutableTwin` |
| `mutatorSpread` | `$.items.push(9);` | `$.items = [...$.items, 9];` — the row's `asArrayLiteral` |
| `mutatorForm` | `$.items.pop();` | `$.items = $.items.slice(0, -1);` — the row's `mutatorForm`, JSMQL by argument count |
| `mutatedArgument` | `Object.assign($.o, x);` | `$.o = Object.assign($.o, x);` — the row's `mutatesArgumentAt` |
| `packSpread` | `Math.max(...$.a, 1)` | `Math.max([...$.a, 1])` — one list, for a rule that reads one (`args.spread`) |
| `groupBodyLink` | `$$.groupBy({ _id: "$k", n: $sum(1) })` | `$$.$group({ … })` — an `_id` key on a stream is the stage body |
| `iterateeShorthand` | `$.items.filter({ a: 1 })` | `$.items.filter(x => x.a === 1)` |

## Position, and why the pass needs it

Several forms mean one thing as a **statement** and are refused everywhere else:

```
$.items.sort();        →  [{ "$set": { "items": { "$sortArray": { "input": "$items", "sortBy": 1 } } } }]
$.a = $.items.sort()   →  ".sort() mutates the array in JavaScript. In expression position, use '.toSorted()'"
```

One tree shape, two meanings. A rewrite blind to position would turn the second
into a nested assignment, and it would throw away the message the row carries.
So the position arrives WITH the node, carried down by `mapTreeIn`.

The position cannot be a set of nodes looked up by identity. The walk rebuilds a
parent as soon as one of its children changes. So by the time a rule runs, the
object it holds is not the object anyone recorded.

[position-pass.md](position-pass.md) owns where each position comes from, and
how a stage's body is laid out. A statement can stand in four places:

| Slot | Example |
|---|---|
| the program root | `$.items.sort()` |
| an element of a `;`-separated program | `$.a = 1; $.items.sort();` |
| an element of a bracketed pipeline | `[$match(…), $.items.sort()]` |
| an element of a stage's sub-pipeline | `$lookup({ …, pipeline: [$.items.sort()], … })` |

## The statement mutators

A mutator is the one JavaScript shape whose whole meaning is "write this back".
So the rewrite is a write. The row states which mutators to rewrite, in two
fields, and the test for both is the SAME ARGUMENTS:

| Field | Rows | Rewrite |
|---|---|---|
| `immutableTwin` | `sort`, `reverse`, `splice` | `$.a = $.a.<twin>(<same args>)` |
| `asArrayLiteral` | `push`, `unshift` | `$.a = [...$.a, <args>]` or `[<args>, ...$.a]` |

The rewrite spreads the arguments; it does not use `.concat()`, because the two
are not the same function: `[1].push([2])` is `[1, [2]]`, and `[1].concat([2])`
is `[1, 2]`.

`pop`, `shift`, `fill` and `copyWithin` carry neither field, and the pass lowers
them directly. `.toSpliced(-1, 1)` does compute what `.pop()` does, but from
arguments the caller never wrote. Re-deriving them spends the receiver-family
proof the mutator's own row supplies. So the MQL comes out 1.5 times the size
for `.pop()`, and 4.4 times for `.shift()`.

The receiver must be a field PATH. MQL writes a path, so `$.items[0].push(1)`
and `$.items.filter(p).sort()` have no destination, and they are not statements
at all. Declining a non-path receiver also keeps `$$.push(…)` (`$unionWith`) and
`$$.sort(…)` (`$sort`) out of a rule meant for fields.

The shape pass asks the same question one phase earlier, where `$.a.b` is still
a chain of accesses, not yet the path it folds to (`couldWriteItsReceiver` in
[naming.ts](../../src/compiler/passes/naming.ts)). So it walks the chain to its
base, and it admits any receiver the fold MIGHT reach a path from. This set is
wider than the set this pass really rewrites, and deliberately so. A receiver
admitted there and declined here is refused by name on the statement road. The
reverse order would read a whole program as the wrong document
([filter-mode.md](filter-mode.md)).

**A mutator with neither a twin nor a literal shape states its WRITE FORM.**
This is JSMQL source by argument count, with `_r` the receiver and `_0`, `_1`,
… the arguments as written (`mutatorForm` on the row). The pass parses the form
with the compiler's own parser, and writes it back to the receiver. So the
statement reaches exactly the value cells a developer's own spelling would,
negative indices included.

`.fill(v, s, e)` is three slices, with the middle one mapped to `v`.
`.copyWithin(t, s, e)` is the head, the copied run cut to what fits, and the
tail from where the run ends. A count the row does not state gives the arity
error, worded from the row's `sig`.

```
$.a.pop();          → $.a = $.a.slice(0, -1);
$.a.shift();        → $.a = $.a.slice(1);
$.a.fill(0);        → $.a = $.a.map(() => 0);
$.a.fill(9, 1, 2);  → $.a = [...$.a.slice(0, 1), ...$.a.slice(1, 2).map(() => 9), ...$.a.slice($.a.slice(0, 1).size() + $.a.slice(1, 2).size())];
```

**A name that writes one of its arguments in place** (`mutatesArgumentAt`) is, as
a statement, a write of that argument with the call as the value:
`Object.assign($.o, x);` → `$.o = Object.assign($.o, x);`.

## The iteratee shorthands

A shorthand is a shorter spelling of an arrow. So this rewrite is the plainest
sugar the pass has. The pass does this rewrite here, not inside each lowering.
That is what makes the spellings agree — and today they do not:

```
$.items.some(x => x.active === true)  →  {"items":{"$elemMatch":{"active":true}}}
$.items.some({ active: true })        →  {"$expr":{"$anyElementTrue":{"$map":…}}}
```

Same meaning. On a document whose `items` is a string, the second form fails the
query outright, while the first form answers it. The second form also cannot
use an index. The pass rewrites first, so lowering sees one shape, and the
divergence cannot arise.

`iterateeSlots` on the row states which slots may be rewritten. The rule never
reads this off the argument, because three other kinds of slot wear the same
spellings. The row states one of three things per receiver family, each a
different fact with its own name:

- a **layout** (which slots take which spellings, all of them meaning an arrow)
- **`arrowOnly`** (only an arrow is accepted — `.mapValues` takes a
  two-parameter callback and refuses `"name"`)
- **`sortSpec`** (the string, object and array spellings are an ORDER, read by
  `sortSpecOf` in `src/compiler/emit/sort-spec.ts`; the pass accepts them
  without rewriting them — `$.a.toSorted("k")` means `{ k: 1 }`, not `x => x.k`)

Only a layout has slots for the rule to rewrite. The rule reads the receiver's
FAMILY off the chain: a chain rooted in `$$` or `$$$.<coll>` is the stream
family wherever the call stands. It never reads the family off the call's own
position, because that gave two answers for one link.

| Spelling | As an iteratee | As something else |
|---|---|---|
| `"f"` | `$.items.map("f")` → pluck | `$.items.toSorted("f")` → a sort KEY |
| `{f: 1}` | `$.items.filter({f: 1})` → a matcher | `$.items.toSorted({f: 1})` → a DIRECTION |
| `["a", "b"]` | `$.items.find(["a", "b"])` → a path/value pair | `$.items.toSorted(["a", "b"])` → two sort keys |

A matcher is lodash's `_.matches`, a PARTIAL deep match, and `matchTests` reads
it as such. A nested object narrows the path (`{ a: { b: { c: 3 } } }` →
`x.a.b.c === 3`; it says nothing about `a.b.d`). An array of constants is a
subset (`{ tags: ["a", "b"] }` → `x.tags.has("a") && x.tags.has("b")`).
An empty object or array matches anything (`x => true`, because nothing is left
to test). Any other value compares with `===`.

A key is a field name however it is spelled — `{ qty: { $gt: 5 } }` is the
field `qty.$gt` equal to 5. The value road reads a `$`-named segment through
`$getField`, with the name as a literal, because the server refuses it in a
field path (measured).

`bareCallable` is a callable GLOBAL handed over unapplied — `$.items.map(String)`,
`$.items.filter(Boolean)`, `$.items.map(Math.abs)`, `$.items.map(ObjectId)` — and
it means the arrow that applies the global to the element, `x => String(x)`.
The row's `iterateeSlots` decides which slots take it. The rewrite only tells a
callable global apart from a binding, and a name that needs `new` (`Date`) is
not callable bare. So both stay as written, and the emitter refuses them.

The synthesised parameter cannot capture: it steps aside from any name the values
spliced into the body mention. See `freshParam`.

## The driver

The rules run in order, then the fold runs, and the whole round repeats until a
round changes nothing. Identity is the test, because `mapTree` returns the same
object when no rule fires.

A round that produces a tree ALREADY SEEN (compared with positions erased) is a
cycle: two rules undo each other's work. This is a bug in the table, and the
pass reports it as an internal error. No round limit decides between a cycle
and real progress: a chain of declarations, where each needs the previous one
folded, advances one link per round, and a developer may write as many links as
they like.

## Constant folding

The fold (`src/compiler/passes/fold.ts`, with `evaluate.ts`, `fold-methods.ts`,
`fold-dates.ts` and `literal.ts`) runs inside the driver's rounds. The pass
computes a `const` or `let` once, when its right-hand side is a constant. The
declaration then emits nothing, and every reference becomes the value. The
pass replaces any constant SUBEXPRESSION the same way. For the user-facing
statement and examples, see
[LANGUAGE.md § Compile-time constants](../LANGUAGE.md#compile-time-constants-folding).

**What a constant is.** An expression over literals and earlier constants that
reads neither the document nor the environment: arithmetic, the string and array
methods, `new Date(<literal>)` and the date methods on one, an `ObjectId`
literal and its `.toString()`, a literal array or object and a read out of it.
A binding that reads the document, the clock or the RNG stays the runtime
`__jsmql.var.<name>` field of [let-bindings.md](let-bindings.md).

**An operator call is not a constant, unless its row states `foldsAs`.** The
escape hatch is the developer's MQL. A row that states `foldsAs` names the
method whose fold it shares, and over a constant operand the call answers what
that method answers: `$size([1, 2, 3])` is 3, as `[1, 2, 3].size()` is. The
operand is the one the lowering reads. A list of ONE element is the operand
list (`$size([[1, 2]])` reads `[1, 2]`), an EMPTY list is no operand (the count
refuses it), and any other array literal is the value. A raw document
(`{ $size: [[1, 2, 3]] }`) is an object literal, not a call, and is never
settled. `test/compiler-returns-agrees.test.ts` holds each fold against the
server's answer for the call left alone.

**The invariant: a fold must not change the answer.** Every rule computes what
the SERVER computes for the same expression, measured on mongod, not what
JavaScript computes where the two differ. That is why a month added to 31
January gives the last day of February (`$dateAdd` clamps). That is why
`.startOf("week")` gives the Sunday (`$dateTrunc`'s default). That is why
`.diff` counts the boundaries crossed (`$dateDiff`). That is why
`Math.round(0.5)` gives 0.

The pass leaves a form to the server when it cannot reproduce the answer with
certainty: a date method with a timezone or another option (a named zone
shifts with daylight saving), a number in `String(n)` or a template slot
outside the integers both sides print identically, `Number("42")` (a double on
the server, an int when written), `typeof` (a BSON type name, when a written
`1` is an int). `test/fold-consistency.test.ts` runs every folded method
against its runtime lowering on the fixture mongod, and the pass removes a
rule that fails there.

**Spelling the value.** A value goes back into the tree as the literal that
spells it, so later rules match on it (`const k = "name"; $.items.map(k)`
reaches the shorthand rule). A Date has no literal spelling, so it goes in as
an `Injected` node — the carrier a `${…}` slot uses. So a query compares it as
written, and an expression passes it through.

A value no node can carry (`undefined`, a non-finite number) does not fold. A
declaration then keeps its binding, and a declaration whose constant IS such a
value is a positioned error. A constant computed key (`{ [k]: 1 }`) becomes
the static key JavaScript would compute.

**What never folds.** A raw `$op(…)` call (HR2: it is emitted as written), a name
written to or mutated anywhere in its scope, a name read before its declaration,
and a fold that would add a name the language does not have.

## Order constraints

Some rules overlap, because one input matches more than one rule. The pass
resolves these in a fixed order, and each constraint below is load-bearing.
Where two rules cannot collide, the order is declaration order and nothing
more.

**The write normalisations come first.** Everything downstream reads `op` as
`"="`, including the sugar dispatch that routes a write by its target, so
`compoundAssign` and `incDec` run before anything that reads a write.

**Field-path fold before the mutators.** A mutator writes a PATH. `$.a.b.sort()`
reaches a `FieldRef` target only because the fold has already made one from
the chain.

```
$.a.b.sort();
  fold first → [{"$set":{"a.b":{"$sortArray":{"input":"$a.b","sortBy":1}}}}]
  reversed   → "'.sort()' changes its receiver in place, so as a statement it needs a field …"
```

**Mutator spread before spread pack.** A statement mutator spreads its receiver
into an array literal. The pack rule reads only value-position calls, never
one on `$$` / `$$$`. `$$.push(...$$$.coll)` spreads a collection into the
stream, and the union road reads that spread itself.

```
Math.max(...$.a, 1)
  packed   → {"$max":{"$concatArrays":["$a",[1]]}}
$.a.indexOf(...$.b)
  not packed (the rule reads one argument) → "Spread (...) is not supported in .indexOf(...) …"
```

**Group body before iteratee shorthand.** Both read an object argument, and the
`$group` body must not be read as a matcher.

```
$$.groupBy({ _id: "$k", n: $sum(1) });
  group body first → [{"$group":{"_id":"$k","n":{"$sum":1}}}]
  reversed         → the object read as a partial deep match, and a $match of it
```

The four mutator rules cannot collide with each other: a row carries an
`immutableTwin`, an `asArrayLiteral`, a `mutatorForm` or a `mutatesArgumentAt`,
never two.

## Adding a sugar form

1. Declare its trigger shape and the node it rewrites into.
2. If the trigger overlaps an existing rule, declare the precedence here, and add
   the input that discriminates them to the test suite.
3. Write its spec, and add a row to the index in [docs/CLAUDE.md](../CLAUDE.md).
4. New sugar keeps the destination visible. Root-replacing sugar starts with
   `$ =`. Everything else names where the result goes. See
   [replace-root-stage.md](replace-root-stage.md) for the convention.
