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
| `stream` | one link of a `$$ = $$…` chain | `$$ = $$.filter(p)` |
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
path. It answers `{ deeper: true }` while a longer key still claims something
below — without which `$setWindowFields`'s body would settle as a value and its
`output` keys would never reach the window position.

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

## The two answers that are not positions

`edge` also returns two things `Position` does not name:

- **`target`** — the left of `=`, or the operand of `delete`. Not evaluated: it
  names a place to write. Calling it a value would let a rule meant for
  expressions fire on the destination of a write.
- **`stageBody`** — part-way down a body path the stage's row still owns, with
  the stage and the path so far. A waypoint, not a place a name can be legal in.

## What the pass does NOT decide

A predicate's own connectives. `$.a > 1 && $.b > 2` at `filter` reaches its two
operands as filters, and `$.a > 1` reaches its operands as values — but that
recursion belongs to the `filter` cell of the `logicalAnd` production, which
calls back into the predicate lowering itself. Phase 4 answers where a node
stands; a lowering decides how far its own position travels into its operands.
