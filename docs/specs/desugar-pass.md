# The desugar pass

## Overview

jsmql carries 17 sugar forms — surfaces that look like ordinary JavaScript but
lower to specific pipeline stages. `$ = <expr>` becomes `$replaceWith`,
`$$$.<coll>.find(p)` becomes `$lookup`, `$$.push(…)` becomes `$unionWith`, and
so on.

The desugar pass rewrites every one of them into an explicit AST node, before
any lowering runs. After the pass no sugar remains.

That property is the point. Sugar recognised during lowering must be recognised
by every loop that lowers, and a loop that does not know a form mis-lowers it
silently. Sugar removed by a pass cannot be missed, because by the time any loop
runs there is nothing left to miss.

Each form's own lowering rules stay in its own spec — see
[docs/CLAUDE.md](../CLAUDE.md) for the index. This file owns the pass: what it
recognises, in what order, and the constraints that order must respect.

## The forms

| Form | Trigger | Becomes |
|---|---|---|
| `let` / `const` declaration | `const cutoff = 18;` | a binding node — [let-bindings.md](let-bindings.md) |
| reusable function | `function adult(d) { … }` | a function node — [reusable-functions.md](reusable-functions.md) |
| `let` reassignment | `n = n + 1;` | a rebind node |
| replace root | `$ = { a: 1 };` | `$replaceWith` — [replace-root-stage.md](replace-root-stage.md) |
| root fan-out | `$ = [{ a: 1 }, { a: 2 }];` | a fan-out node |
| root lookup pivot | `$ = $$$.orders.find(…);` | `$lookup` + `$replaceWith` |
| facet | `$ = { hi: $$.filter(…), lo: $$.filter(…) };` | `$facet` — [replace-root-stage.md](replace-root-stage.md) |
| replace stream | `$$.filter(…);` | `$match` — [replace-stream-stage.md](replace-stream-stage.md) |
| dict-build wrap | `$$ = [{ [d.k]: $$.reduce(…) }];` | a group node — [stream-methods.md](stream-methods.md) |
| object reduce wrap | `$$ = [{ total: $$.reduce(…) }];` | a group node |
| array reduce wrap | `$$.reduce((a,d) => a.concat(d.items), []);` | a group node |
| foreign source switch | `$$ = $$$.orders.filter(…);` | `$match` + `$unionWith` |
| write out | `$$$.archive = $$;` | `$out` — [out-stage.md](out-stage.md) |
| lookup | `$.o = $$$.orders.find(…);` | `$lookup` — [lookup-stage.md](lookup-stage.md) |
| union | `$$.push({ … });` | `$unionWith` — [union-stage.md](union-stage.md) |
| system source stage | `$$.indexStats();` | a diagnostic stage — [system-stages.md](system-stages.md) |
| guard | `assert(cond, msg);` | a conditional-error `$match` — [assert.md](assert.md) |
| field path | `$.a.b` | one `FieldRef` holding `a.b` |
| mutator with a twin | `$.items.sort();` | `$.items = $.items.toSorted();` |
| mutator as a literal | `$.items.push(9);` | `$.items = [...$.items, 9];` |
| mutator with a write form | `$.items.pop();` | `$.items = $.items.slice(0, -1);` — the row's `mutatorForm`, JSMQL by argument count |
| mutated argument | `Object.assign($.o, x);` | `$.o = Object.assign($.o, x);` — the row's `mutatesArgumentAt` |
| iteratee shorthand | `$.items.filter({ a: 1 })` | `$.items.filter(x => x.a === 1)` |
| spread pack | `Math.max(...$.a, 1)` | `Math.max([...$.a, 1])` — one list, for a rule that reads one (`args.spread`) |

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

## Order constraints

Some forms overlap: one input matches more than one detector. The pass must
resolve those in a fixed order, and each constraint below is load-bearing —
reverse it and the output changes.

**Facet before plain replace-root.** A facet right-hand side also satisfies the
replace-root test, which looks only at the target.

```
$ = { hi: $$.filter(t => t.x > 1), lo: $$.filter(t => t.x <= 1) };
  facet first  → [{"$facet":{"hi":[{"$match":{"x":{"$gt":1}}}],"lo":[{"$match":{"x":{"$lte":1}}}]}}]
  reversed     → throws "'$$' (current collection) is statement-only …"
```

**Write-out before lookup.** The write-out test reads the left-hand side and the
lookup test reads the right-hand side, so an input with both matches both.

```
$$$.dst = $$$.src.find(t => t.a === 1);
  write-out first → "The right-hand side of '$$$.<coll> = …' must be a chain rooted at '$$' …"
  reversed        → an internal error, because the write target is not a field path
```

**Lookup before the general fallback.** The fallback is unconditional, so it
makes the direct lookup form unreachable if it runs first.

```
$.o = $$$.orders.find(o => o.uid === $._id);
  lookup first → 2 stages: $lookup as:"o", then $set {o:{$first:"$o"}}
  reversed     → 4 stages through a scratch slot, plus the trailing $unset
```

**Replace-root and replace-stream before lookup.** Both re-detect a lookup
inside their own right-hand side and place it against their own destination. The
general lookup form would build an empty `as` target.

**Mutator spread before spread pack.** A statement mutator spreads its receiver
into an array literal; the pack rule reads only value-position calls, and never
one on `$` / `$# The desugar pass

## Overview

jsmql carries 17 sugar forms — surfaces that look like ordinary JavaScript but
lower to specific pipeline stages. `$ = <expr>` becomes `$replaceWith`,
`$$$.<coll>.find(p)` becomes `$lookup`, `$$.push(…)` becomes `$unionWith`, and
so on.

The desugar pass rewrites every one of them into an explicit AST node, before
any lowering runs. After the pass no sugar remains.

That property is the point. Sugar recognised during lowering must be recognised
by every loop that lowers, and a loop that does not know a form mis-lowers it
silently. Sugar removed by a pass cannot be missed, because by the time any loop
runs there is nothing left to miss.

Each form's own lowering rules stay in its own spec — see
[docs/CLAUDE.md](../CLAUDE.md) for the index. This file owns the pass: what it
recognises, in what order, and the constraints that order must respect.

## The forms

| Form | Trigger | Becomes |
|---|---|---|
| `let` / `const` declaration | `const cutoff = 18;` | a binding node — [let-bindings.md](let-bindings.md) |
| reusable function | `function adult(d) { … }` | a function node — [reusable-functions.md](reusable-functions.md) |
| `let` reassignment | `n = n + 1;` | a rebind node |
| replace root | `$ = { a: 1 };` | `$replaceWith` — [replace-root-stage.md](replace-root-stage.md) |
| root fan-out | `$ = [{ a: 1 }, { a: 2 }];` | a fan-out node |
| root lookup pivot | `$ = $$$.orders.find(…);` | `$lookup` + `$replaceWith` |
| facet | `$ = { hi: $$.filter(…), lo: $$.filter(…) };` | `$facet` — [replace-root-stage.md](replace-root-stage.md) |
| replace stream | `$$.filter(…);` | `$match` — [replace-stream-stage.md](replace-stream-stage.md) |
| dict-build wrap | `$$ = [{ [d.k]: $$.reduce(…) }];` | a group node — [stream-methods.md](stream-methods.md) |
| object reduce wrap | `$$ = [{ total: $$.reduce(…) }];` | a group node |
| array reduce wrap | `$$.reduce((a,d) => a.concat(d.items), []);` | a group node |
| foreign source switch | `$$ = $$$.orders.filter(…);` | `$match` + `$unionWith` |
| write out | `$$$.archive = $$;` | `$out` — [out-stage.md](out-stage.md) |
| lookup | `$.o = $$$.orders.find(…);` | `$lookup` — [lookup-stage.md](lookup-stage.md) |
| union | `$$.push({ … });` | `$unionWith` — [union-stage.md](union-stage.md) |
| system source stage | `$$.indexStats();` | a diagnostic stage — [system-stages.md](system-stages.md) |
| guard | `assert(cond, msg);` | a conditional-error `$match` — [assert.md](assert.md) |
| field path | `$.a.b` | one `FieldRef` holding `a.b` |
| mutator with a twin | `$.items.sort();` | `$.items = $.items.toSorted();` |
| mutator as a literal | `$.items.push(9);` | `$.items = [...$.items, 9];` |
| iteratee shorthand | `$.items.filter({ a: 1 })` | `$.items.filter(x => x.a === 1)` |
| spread pack | `Math.max(...$.a, 1)` | `Math.max([...$.a, 1])` — one list, for a rule that reads one (`args.spread`) |

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

## Order constraints

Some forms overlap: one input matches more than one detector. The pass must
resolve those in a fixed order, and each constraint below is load-bearing —
reverse it and the output changes.

**Facet before plain replace-root.** A facet right-hand side also satisfies the
replace-root test, which looks only at the target.

```
$ = { hi: $$.filter(t => t.x > 1), lo: $$.filter(t => t.x <= 1) };
  facet first  → [{"$facet":{"hi":[{"$match":{"x":{"$gt":1}}}],"lo":[{"$match":{"x":{"$lte":1}}}]}}]
  reversed     → throws "'$$' (current collection) is statement-only …"
```

**Write-out before lookup.** The write-out test reads the left-hand side and the
lookup test reads the right-hand side, so an input with both matches both.

```
$$$.dst = $$$.src.find(t => t.a === 1);
  write-out first → "The right-hand side of '$$$.<coll> = …' must be a chain rooted at '$$' …"
  reversed        → an internal error, because the write target is not a field path
```

**Lookup before the general fallback.** The fallback is unconditional, so it
makes the direct lookup form unreachable if it runs first.

```
$.o = $$$.orders.find(o => o.uid === $._id);
  lookup first → 2 stages: $lookup as:"o", then $set {o:{$first:"$o"}}
  reversed     → 4 stages through a scratch slot, plus the trailing $unset
```

**Replace-root and replace-stream before lookup.** Both re-detect a lookup
inside their own right-hand side and place it against their own destination. The
general lookup form would build an empty `as` target.

 / `$$` — `$.push(...$$.coll)` spreads a collection into
the stream, and the union road reads that spread itself.

```
Math.max(...$.a, 1)
  packed   → {"$max":{"$concatArrays":["$a",[1]]}}
$.a.indexOf(...$.b)
  not packed (the rule reads one argument) → "Spread (...) is not supported in .indexOf(...) …"
```

**System source stages before stream chains.** A system stage call has the same
shape as a one-method stream chain.

```
$$.indexStats();
  system stage first → [{"$indexStats":{}}]
  reversed           → "'.indexStats(...)' is not a chainable stream method on '$$'"
```

## Constraints that hold only by exclusion

The union form and the system-stage form do not overlap, but only because a
hand-maintained set of reserved collection method names keeps them apart. Remove
that set and the pair becomes order-sensitive.

An exclusion list is a coupling between two forms that neither form declares.
The grid removes it: each form declares its own trigger, and an overlap is
resolved by declared precedence rather than by a list one form keeps about
another. See [emit-pass.md](emit-pass.md#the-method-cells).

## Why a pass and not a hub

Sugar recognised during lowering has to be recognised at every place lowering
begins. jsmql assembles stages from more than one place — the top-level
statement sequence, the bracketed array form, a literal sub-pipeline array, and
each container that lowers a chain.

A form that one of those places does not test for is not rejected. It falls
through to whatever the generic path does with it, which is how a root-replace
inside a literal sub-pipeline can become a `$set` on an empty field path — a
document the server refuses.

The pass removes the class. Every entry to lowering receives a tree with no
sugar in it, so no entry can fail to test for a form.

## Adding a sugar form

1. Declare its trigger shape and the node it rewrites into.
2. If the trigger overlaps an existing form, declare the precedence, and add the
   input that discriminates them to the test suite.
3. Write its spec, and add a row to the index in [docs/CLAUDE.md](../CLAUDE.md).
4. New sugar keeps the destination visible. Root-replacing sugar starts with
   `$ =`; everything else names where the result goes. See
   [replace-root-stage.md](replace-root-stage.md) for the convention.
