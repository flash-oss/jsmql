# The emit phase — the value target

The fifth phase of `src/compiler/`: a settled tree to its MQL. This spec owns
the VALUE target (`jsmql.expr`), the modules under `src/compiler/emit/`, and
the acceptance gate. The registry states what the language has; this phase
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
$setUnion([$.a, $.b])   // → {$setUnion:["$a","$b"]}     one array literal IS the operand list
$setUnion($.a)          // refused: a list operator with one scalar (the server refuses it too)
$and([])                // → {$and:[]}                    an explicit empty list passes where the row states `emptyList`
$divide([])             // refused: nothing was written, and `$divide` states no empty list
$trim($.name)           // → {$trim:{input:"$name"}}      one value maps onto the first positional key
$size([$.a, 2])         // → {$size:[["$a",2]]}           a single operand that renders as an array is wrapped one level
$literal(["$a", "$b"])  // → {$literal:["$a","$b"]}       verbatim — the one exception
```

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
