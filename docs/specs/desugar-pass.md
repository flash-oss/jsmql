# The desugar pass

## Overview

A sugar is a construct that MEANS another construct the language already has.
`$.items.sort();` means the write `$.items = $.items.toSorted();`; `$.a.b` means
one field path; `$.items.filter({ a: 1 })` means the arrow it is short for. The
desugar pass rewrites every one of them, source to source, before any lowering
runs. After the pass those shapes are gone.

That property is the point. Sugar recognised DURING lowering must be recognised
by every loop that lowers — jsmql assembles stages from more than one place, and
a loop that does not know a form mis-lowers it silently rather than refusing it.
Sugar removed by a pass cannot be missed, because by the time any loop runs there
is nothing left to miss.

The destination-visible sugars — `$ = <expr>`, `$$$.<coll>.find(…)`,
`$$.push(…)`, `$$.indexStats()` — are NOT rewritten here. They read their
neighbours (the stages already emitted, the chain they sit in, the target a write
names), which a source-to-source rewrite cannot see, so the emit phase lowers
them where those neighbours are in hand ([emit-pass.md](emit-pass.md)). Each
form's own rules stay in its own spec; see [docs/CLAUDE.md](../CLAUDE.md) for the
index. This file owns the pass: what it rewrites, in what order, and the
constraints that order must respect.

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
into a nested assignment and throw away the message the row carries — so the
position arrives WITH the node, carried down by `mapTreeIn`. It cannot be a set
of nodes looked up by identity: the walk rebuilds a parent as soon as one of its
children changes, so by the time a rule runs, the object it holds is not the
object anyone recorded.

Where each position comes from, and how a stage's body is laid out, is owned by
[position-pass.md](position-pass.md). The four places a statement can stand:

| Slot | Example |
|---|---|
| the program root | `$.items.sort()` |
| an element of a `;`-separated program | `$.a = 1; $.items.sort();` |
| an element of a bracketed pipeline | `[$match(…), $.items.sort()]` |
| an element of a stage's sub-pipeline | `$lookup({ …, pipeline: [$.items.sort()], … })` |

## The statement mutators

A mutator is the one JavaScript shape whose whole meaning is "write this back",
so the rewrite is a write. Which mutators are rewritten is stated by the row, in
two fields, and the test for both is the SAME ARGUMENTS:

| Field | Rows | Rewrite |
|---|---|---|
| `immutableTwin` | `sort`, `reverse`, `splice` | `$.a = $.a.<twin>(<same args>)` |
| `asArrayLiteral` | `push`, `unshift` | `$.a = [...$.a, <args>]` or `[<args>, ...$.a]` |

Spread and not `.concat()`, because they are not the same function: `[1].push([2])`
is `[1, [2]]` and `[1].concat([2])` is `[1, 2]`.

`pop`, `shift`, `fill` and `copyWithin` carry neither field and are lowered
directly. `.toSpliced(-1, 1)` does compute what `.pop()` does, but from arguments
the caller never wrote — and re-deriving them spends the receiver-family proof
the mutator's own row supplies, so the MQL comes out 1.5x the size for `.pop()`
and 4.4x for `.shift()`.

The receiver must be a field PATH. MQL writes a path, so `$.items[0].push(1)` and
`$.items.filter(p).sort()` have no destination and are not statements at all.
Declining a non-path receiver is also what keeps `$$.push(…)` (`$unionWith`) and
`$$.sort(…)` (`$sort`) out of a rule meant for fields.

The shape pass asks the same question one phase earlier, where `$.a.b` is still a
chain of accesses and not yet the path it folds to (`couldWriteItsReceiver` in
[naming.ts](../../src/compiler/passes/naming.ts)). So it walks the chain to its
base and admits any receiver the fold MIGHT reach a path from — wider than the
set this pass really rewrites, and deliberately so: a receiver admitted there and
declined here is refused by name on the statement road, while the reverse would
read a whole program as the wrong document ([filter-mode.md](filter-mode.md)).

**A mutator with neither a twin nor a literal shape states its WRITE FORM** —
JSMQL source by argument count, `_r` the receiver and `_0`, `_1`, … the
arguments as written (`mutatorForm` on the row). The pass parses the form with
the compiler's own parser and writes it back to the receiver, so the statement
reaches exactly the value cells a developer's own spelling would, negative
indices included: `.fill(v, s, e)` is three slices, the middle one mapped to
`v`, and `.copyWithin(t, s, e)` the head, the copied run cut to what fits, and
the tail from where the run ends. A count the row does not state is the arity
error, worded from the row's `sig`.

```
$.a.pop();          → $.a = $.a.slice(0, -1);
$.a.shift();        → $.a = $.a.slice(1);
$.a.fill(0);        → $.a = $.a.map(() => 0);
$.a.fill(9, 1, 2);  → $.a = [...$.a.slice(0, 1), ...$.a.slice(1, 2).map(() => 9), ...$.a.slice($.a.slice(0, 1).length + $.a.slice(1, 2).length)];
```

**A name that writes one of its arguments in place** (`mutatesArgumentAt`) is, as
a statement, a write of that argument with the call as the value:
`Object.assign($.o, x);` → `$.o = Object.assign($.o, x);`.

## The iteratee shorthands

A shorthand is a shorter spelling of an arrow, so rewriting it is the plainest
sugar the pass has. Doing it here rather than inside each lowering is what makes
the spellings agree — and today they do not:

```
$.items.some(x => x.active === true)  →  {"items":{"$elemMatch":{"active":true}}}
$.items.some({ active: true })        →  {"$expr":{"$anyElementTrue":{"$map":…}}}
```

Same meaning. On a document whose `items` is a string the second fails the query
outright while the first answers it, and the second cannot use an index either.
Rewriting first leaves one shape to lower, so the divergence cannot arise.

Which slots may be rewritten is stated by `iterateeSlots` on the row and is never
read off the argument, because three other kinds of slot wear the same spellings.
The row states one of three things per receiver family, each a different fact
with its own name: a **layout** (which slots take which spellings, all of them
meaning an arrow), **`arrowOnly`** (only an arrow is accepted — `.mapValues` takes
a two-parameter callback and refuses `"name"`), or **`sortSpec`** (the string,
object and array spellings are an ORDER, read by `sortSpecOf` in
`src/compiler/emit/sort-spec.ts`, and are accepted without being rewritten — `$.a.toSorted("k")` means `{ k: 1 }`, not `x => x.k`).
Only a layout has slots for the rule to rewrite. The receiver's FAMILY is read
off the chain — a chain rooted in `$$` or `$$$.<coll>` is the stream family
wherever the call stands — never off the call's own position, which gave two
answers for one link.

| Spelling | As an iteratee | As something else |
|---|---|---|
| `"f"` | `$.items.map("f")` → pluck | `$.items.toSorted("f")` → a sort KEY |
| `{f: 1}` | `$.items.filter({f: 1})` → a matcher | `$.items.toSorted({f: 1})` → a DIRECTION |
| `["a", "b"]` | `$.items.find(["a", "b"])` → a path/value pair | `$.items.toSorted(["a", "b"])` → two sort keys |

A matcher is lodash's `_.matches`, a PARTIAL deep match, and `matchTests` reads it as
such: a nested object narrows the path (`{ a: { b: { c: 3 } } }` → `x.a.b.c === 3`, nothing
said about `a.b.d`), an array of constants is a subset (`{ tags: ["a", "b"] }` →
`x.tags.includes("a") && x.tags.includes("b")`), an empty object or array matches anything
(`x => true` when nothing is left to test), and any other value compares with `===`. A
key is a field name however it is spelled — `{ qty: { $gt: 5 } }` is the field `qty.$gt`
equal to 5 — and the value road reads a `$`-named segment through `$getField` with the
name as a literal, because the server refuses it in a field path (measured).

`bareCallable` is a callable GLOBAL handed over unapplied — `$.items.map(String)`,
`$.items.filter(Boolean)`, `$.items.map(Math.abs)`, `$.items.map(ObjectId)` — and
means the arrow that applies it to the element, `x => String(x)`. Which slots take
it is the row's decision (`iterateeSlots`); the rewrite only knows a callable
global from a binding, and a name that needs `new` (`Date`) is not callable bare,
so both stay as written and the emitter refuses them.

The synthesised parameter cannot capture: it steps aside from any name the values
spliced into the body mention. See `freshParam`.

## The driver

The rules run in order, then the fold, and the whole round repeats until a round
changes nothing — identity is the test, because `mapTree` returns the same object
when no rule fired. A round that produces a tree ALREADY SEEN (compared with
positions erased) is a cycle: two rules undoing each other's work, which is a bug
in the table and is reported as an internal error. There is no round limit that
decides between the two: a chain of declarations where each needs the previous
one folded and a rule run advances one link per round, and a developer may write
as many links as they like.

## Constant folding

The fold (`src/compiler/passes/fold.ts`, with `evaluate.ts`, `fold-methods.ts`,
`fold-dates.ts` and `literal.ts`) runs inside the driver's rounds. A `const` or
`let` whose right-hand side is a constant is computed once, the declaration
emits nothing, and every reference becomes the value; any constant
SUBEXPRESSION is replaced the same way. User-facing statement and examples:
[LANGUAGE.md § Compile-time constants](../LANGUAGE.md#compile-time-constants-folding).

**What a constant is.** An expression over literals and earlier constants that
reads neither the document nor the environment: arithmetic, the string and array
methods, `new Date(<literal>)` and the date methods on one, an `ObjectId`
literal and its `.toString()`, a literal array or object and a read out of it.
A binding that reads the document, the clock or the RNG stays the runtime
`__jsmql.var.<name>` field of [let-bindings.md](let-bindings.md).

**The invariant: a fold must not change the answer.** Every rule computes what the
SERVER computes for the same expression, measured on mongod — not what JavaScript
computes where the two differ. That is why a month added to 31 January is the last
day of February (`$dateAdd` clamps), why `.startOf("week")` is the Sunday
(`$dateTrunc`'s default), why `.diff` counts the boundaries crossed (`$dateDiff`),
and why `Math.round(0.5)` is 0. A form whose answer the fold cannot reproduce with
certainty is left to the server: a date method with a timezone or another option
(a named zone shifts with daylight saving), a number in `String(n)` or a template
slot outside the integers both sides print identically, `Number("42")` (a double
on the server, an int when written), `typeof` (a BSON type name, and a written
`1` is an int). `test/fold-consistency.test.ts` runs every folded method against
its runtime lowering on the fixture mongod; a rule that fails there is removed.

**Spelling the value.** A value goes back into the tree as the literal that spells
it, so later rules match on it (`const k = "name"; $.items.map(k)` reaches the
shorthand rule). A Date has no literal spelling and goes in as an `Injected`
node — the carrier a `${…}` slot uses — so a query compares it as written and an
expression passes it through. A value no node can carry (`undefined`, a non-finite
number) does not fold: a declaration keeps its binding, and a declaration whose
constant IS such a value is a positioned error. A constant computed key
(`{ [k]: 1 }`) becomes the static key JavaScript would compute.

**What never folds.** A raw `$op(…)` call (HR2: it is emitted as written), a name
written to or mutated anywhere in its scope, a name read before its declaration,
and a fold that would add a name the language does not have.

## Order constraints

Some rules overlap: one input matches more than one. The pass resolves those in a
fixed order, and each constraint below is load-bearing. Where two rules cannot
collide, the order is declaration order and nothing more.

**The write normalisations come first.** Everything downstream reads `op` as
`"="`, including the sugar dispatch that routes a write by its target, so
`compoundAssign` and `incDec` run before anything that reads a write.

**Field-path fold before the mutators.** A mutator writes a PATH, and
`$.a.b.sort()` reaches a `FieldRef` target only because the fold has already made
one of the chain.

```
$.a.b.sort();
  fold first → [{"$set":{"a.b":{"$sortArray":{"input":"$a.b","sortBy":1}}}}]
  reversed   → "'.sort()' changes its receiver in place, so as a statement it needs a field …"
```

**Mutator spread before spread pack.** A statement mutator spreads its receiver
into an array literal; the pack rule reads only value-position calls, and never
one on `$$` / `$$$` — `$$.push(...$$$.coll)` spreads a collection into the
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
   `$ =`; everything else names where the result goes. See
   [replace-root-stage.md](replace-root-stage.md) for the convention.
