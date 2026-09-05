# The position pass

## Overview

MQL reads the same document differently depending on the slot it sits in. jsmql
therefore compiles into seven **positions**, and every name in the registry
states which of them it is legal in (`where`):

| Position | The slot it renders | Written as |
|---|---|---|
| `value` | an aggregation expression | `$addFields: { v: … }` |
| `filter` | a query document | `db.coll.find(…)`, a `$match` body |
| `statement` | one element of a pipeline | `$match(…);` |
| `stream` | one link of a `$$ = $$…` chain | `$$.filter(p)` |
| `group` | a `$group` output slot | `$group({ _id: …, s: … })` |
| `window` | a `$setWindowFields.output` slot | `output: { r: … }` |
| `updateDoc` | the object form of an update | `updateOne(f, { $inc: … })` |

A position is not a property of a node's shape. `$sum($.x, $.y)` is a valid
two-operand expression **and** an invalid accumulator, and only the slot tells
the two readings apart:

```
$.total = $sum($.x, $.y);            →  { "$set": { "total": { "$sum": ["$x", "$y"] } } }
$group({_id: null, s: $sum($.x)});   →  { "$group": { "_id": null, "s": { "$sum": "$x" } } }
```

The pass answers one question — *where does this node stand* — for every node,
and answers it on the way DOWN. `edge(node, key, here)` in
[src/compiler/passes/position.ts](../../src/compiler/passes/position.ts) says what
the position becomes on one parent-to-property step, and `mapTreeIn` carries it.

It cannot be a set of nodes looked up by identity: a rewriting walk rebuilds a
parent as soon as one of its children changes, so by the time a rule runs, the
object it holds is not the object anyone recorded.

## The root is the caller's fact

Four entry points, four roots, and no program can tell them apart:

| Entry | Root position |
|---|---|
| `jsmql(<pipeline>)` — any top-level `;` | `statement` |
| `jsmql(<filter>)` — no `;` | `filter` |
| `jsmql.expr(…)` | `value` |
| `jsmql.update(…)` — object form | `updateDoc` |

`shapeOf` ([shape.ts](../../src/compiler/passes/shape.ts)) decides between the
first two; the other two are the caller's own knowledge. So the root arrives as a
parameter — `desugar(program, FILTER)` — and everything below it is `edge`'s to
answer. A wrong root is a wrong document rather than an error, because both
readings of a predicate are legal MQL.

## A stage body is laid out by its own row

A stage's argument is a **body**, and a body can mix positions. Each stage row
states the layout in `bodyPositions`, keyed by dotted path from the body:

| Key | Means |
|---|---|
| `""` | the body itself, and everything under it that no longer key claims |
| `"*"` | every key of the body object |
| `"k"` | that one key |
| `"k.*"` | every key of that key's object |

The longest covering key wins, and a literal beats a `*` of the same depth. A
`*` covers a computed key (`{ [k]: … }`); a literal never does, because a
computed key cannot be known to be the one the row names.

```ts
$group:            { "": "value", "*": "group", _id: "value" }
$setWindowFields:  { "": "value", "output.*": "window" }
$facet:            { "": "value", "*": "statement" }
$lookup:           { "": "value", pipeline: "statement" }
$rankFusion:       { "": "value", "input.pipelines.*": "statement" }
$match:            { "": "filter" }
$geoNear:          { "": "value", query: "filter" }
$graphLookup:      { "": "value", restrictSearchWithMatch: "filter" }
```

`bodySlotAt(stage, path)` in [rows.ts](../../src/compiler/rows.ts) resolves one
path to BOTH facts: the position a leaf here holds, and whether a longer key
still claims something below (`deeper`). An object under a `deeper` path keeps
descending; anything else takes the path's position at once. Without the first,
`$merge("out")` — a string under a layout that names `whenMatched` — reached no
position at all; without the second, `$setWindowFields`'s body would settle as a
value and its `output` keys would never reach the window position.

The layout is consulted for every spelling of a stage — the call `$group({…})`,
the chained link `$$.$group({…})`, and the raw document `{ $group: {…} }` — because
all three name the same row ([naming.ts](../../src/compiler/passes/naming.ts)
answers "which row does this node name" once, for every pass). And only where a
stage may stand: `$count` is a stage AND an accumulator, and inside `$group` its
arguments are an operator's, not a body.

The layout is **stated, never derived**, because the slots differ per stage and
mongod refuses the wrong reading. Measured:

```
{ $group: { _id: { $sum: ["$x","$y"] }, s: "…" } }        accepted
{ $group: { _id: null, s: { $sum: ["$x","$y"] } } }       "The $sum accumulator is a unary operator"
{ $geoNear: { …, query: { $eq: ["$k","a"] } } }           "unknown top level operator: $eq"
{ $geoNear: { …, query: { $expr: { $eq: ["$k","a"] } } } } accepted
```

A type-level check makes the `""` key mandatory, and
`test/compiler-position.test.ts` asserts that exactly the stage rows carry a
layout — a stage with none sends its whole body to `value`, which is where every
bug this field fixes came from.

## An accumulator slot takes one operand

Both the `group` and the `window` slots hold **one** expression, whatever the
operator's expression form allows. They report a second operand differently, and
the second way is the dangerous one:

```
{ $group: { _id: null, s: { $sum: ["$x","$y"] } } }             → refused
{ $setWindowFields: { …, output: { r: { $sum: ["$x","$y"] } } } } → 0
{ $setWindowFields: { …, output: { r: { $sum: "$x" } } } }        → 4
```

So every operand-shaped accumulator cell states `exact: 1` and renders through
one emitter, `accumulated`
([vocabulary.ts](../../src/registry/vocabulary.ts)). Two audits hold the rule:
a `group` or `window` cell may never state `atLeast` (an accumulator slot has a
ceiling), and a cell using `accumulated` must state `exact: 1` (the emitter reads
`args[0]` and nothing else).

`$covariancePop` and `$covarianceSamp` are the exception the registry states
rather than derives: their window slot genuinely takes an array of two, and one
operand answers `null`.

### The array shield

An operand that RENDERS as an array needs shielding, because `{ acc: [ … ] }` is
read as an operand list wherever it appears. For `$push([$.x, $.y])`, whose one
argument is an array literal:

```
{ $group: { _id: null, r: { $push: ["$x","$y"] } } }                       refused
{ $group: { _id: null, r: { $push: { $let: { vars: {}, in: ["$x","$y"] } } } } }  → [[1,2],[3,4]]
```

which is the answer the bare array already gives in a window slot. The shield is
needed only in a `$group` slot; both cells use the one emitter anyway, so the
rule is stated once and the two slots cannot drift apart.

[test/compiler-accumulator-agrees.test.ts](../../test/compiler-accumulator-agrees.test.ts)
runs each of these documents — emitted by the registry itself — on a live mongod,
and asserts the shielded form answers exactly what the bare form answers wherever
the bare form runs. A fix may not change an answer to buy a shape.

## A stream is a chain rooted in a context reference

`$$.filter(p)`, `$$$.orders.find(p)` and `$$$["archive"].find(p)` all read a
stream, whatever their last link is and however the collection is spelled — the
chain is walked to its BASE through every access node (`chainBase`). Every link
below the top is a stream. The top link stands where its parent put it: as the
right of `$$ = …` it is a stream too (the row says the right-hand side replaces
the stream), while as the argument of `$$.push(…)` or the right of `$.o = …` it is
a value that the sugar's own lowering hands to the stream lowering. `$$` itself is
the stream it names; `$$$` and `$$$$` are scopes, never evaluated, and stand at
`value`.

A receiver supplies a FAMILY, not a position: the desugar pass asks whether a
receiver chain is rooted in a context reference to pick the stream family, and
never reads the call's own position for it — `$ = { k: $$.map({ a: 1 }) }` and
`$$.map({ a: 1 })` rewrite the same shorthand the same way.

One consequence for stage links: a chained stage on a context-rooted chain is a
stage WHEREVER the chain stands, so its body layout is consulted even when the
chain's top is a value to its parent — `$.o = $$$.orders.filter(p).$group({ …,
s: $sum($.x) })` puts `$sum` at `group`, exactly as `$group({ … });` does. And a
callee whose row says `blockBody: "stages"` takes them as an array too:
`$$.aggregate([$match(…)])` puts each element at `statement`.

## The three answers that are not positions

`edge` also returns three things `Position` does not name:

- **`target`** — the left of `=`, the operand of `delete`, or the callee of a
  call. Not evaluated: each names a place to write or a thing to call. Calling it
  a value would let a rule meant for expressions fire on the destination of a
  write, or fold `f` away in `f(1)` to give `3(1)`. The fold pass and this pass
  share the one predicate that says so (`namesSomething` in naming.ts).
- **`stageBody`** — part-way down a body path the stage's row still owns, with
  the stage and the path so far. A waypoint, not a place a name can be legal in.
- **`stageEntry`** — the one entry of a raw stage document `{ $match: … }`,
  whose value is the body. The same waypoint idea for the pasted-MQL spelling.

## What a `{ … }` callback body means

A block with no `return` is pipeline STAGES only under a callee whose row says
`blockBody: "stages"`; under every other callee it is a JavaScript block that
forgot its `return`, and is refused. That is decided in the PARSER, because only
the parser holds the callee and the body at the same time: `args()` claims a
stages block for a stages-taking owner, and `finish()` refuses whatever nobody
claimed. Phase 4 therefore never has to ask whether a `Lambda.stages` it meets
is legal — by the time it runs, every one is.

## What the pass does NOT decide

A predicate's own connectives. `$.a > 1 && $.b > 2` at `filter` reaches its two
operands as filters, and `$.a > 1` reaches its operands as values — but that
recursion belongs to the `filter` cell of the `logicalAnd` production, which
calls back into the predicate lowering itself. Phase 4 answers where a node
stands; a lowering decides how far its own position travels into its operands.
