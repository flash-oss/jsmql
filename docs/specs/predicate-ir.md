# Predicate IR

## Overview

MongoDB's query language is a predicate language and nothing else. It is
reached only from predicate position — a Filter, a `$match` body, `$elemMatch`,
a `$lookup` predicate. Everywhere else jsmql emits the aggregation-expression
language.

So Query and Expr overlap on exactly one thing: predicates. That overlap is the
Predicate IR. A predicate-shaped feature declares **one** lowering into the IR,
and the two backends turn that IR into query form or expression form.

The value of the IR is not the sharing. It is the fallback. Each node declares
which operand kinds its Query cell accepts. When the operands do not match, the
Query cell is unavailable **by construction**, and the node emits
`{ $expr: <its Expr lowering> }` instead. A missing query rule is therefore
never a wrong answer and never a silent one — it is a larger, correct document.

See [match-query-translation.md](match-query-translation.md) for the
user-visible translation table, and [architecture.md](architecture.md) for
where the IR sits in the pipeline.

## The operand-kind gate

Two operand kinds decide every Query cell:

| Kind | Meaning |
|---|---|
| `path` | a static dotted field path |
| `const` | a constant that can sit in a query document |

A Query cell is available only when the node's operands match the kinds it
declares. Anything else — a computed operand, an expression, a runtime value —
makes the cell unavailable and selects the `$expr` fallback.

This one declared gate per node replaces a bail-out check at each translation
site. A node either states the kinds it can index on, or it has no Query cell
at all.

## The nodes

`P` is an IR node. `T` is a term in the Expr language.

| # | Node | Query lowering | Expr lowering |
|---|---|---|---|
| 1 | `Cmp(op, a, b, nullMode?)`<br>`op ∈ eq \| ne \| gt \| gte \| lt \| lte` | gate: one side `path`, the other `const`; flip `op` when reversed. `eq` → `{p: v}`; `ne` → `{p:{$ne:v}}`; ordered → `{p:{$gt:v}}` …<br>`v = null`, strict → `{p:{$type:"null"}}`<br>`v = null`, loose → `{p: null}` | `{$eq\|$ne\|$gt\|$gte\|$lt\|$lte: [A,B]}`<br>loose null → `{$in:[{$type:A},["null","missing"]]}` |
| 2 | `Exists(operand, present)` | gate: `operand` is a `path` → `{p:{$exists: present}}` | `{$eq\|$ne: [{$type: P}, "missing"]}` — `$type` reports `"missing"` for an absent field and `"null"` for a present-but-null one, the same line `$exists` draws |
| 3 | `TypeIs(path, alias, negated)` | `{p:{$type:alias}}` / `{p:{$not:{$type:alias}}}`; gate: `alias` is a BSON type alias | `{$eq\|$ne: [{$type: P}, alias]}` |
| 4 | `Mod(path, d, m, negated)` | `{p:{$mod:[d,m]}}` / `{p:{$not:{$mod:[d,m]}}}`; gate: `d`, `m` non-negative integer literals | `{$eq\|$ne: [{$mod:[P,d]}, m]}` |
| 5 | `Membership(path, values, mode)` | `any` → `{p:{$in:[…]}}`; `all` → `{p:{$all:[…]}}` | `any` → `{$in:[P,[…]]}`; `all` → an `$and` of `Contains` |
| 6 | `Contains(hay, needle, anchor)` | `anchor=any`, `hay=path`, `needle=const` → `{hay: needle}`.<br>`start` / `end` → `unsupported` — the query language has no anchored substring test; the message names `.match(/^x/)` | `any` → `$in` on an array, `$indexOfCP ≥ 0` on a string, `$cond` on `$isArray` when the type is unknown<br>`start` → `{$eq:[{$indexOfCP:…},0]}`<br>`end` → `$substrCP` from the end |
| 7 | `RegexMatch(input, pattern, flags)` | gate: `input=path`, pattern a literal → `{p: <RegExp>}` | `{$regexMatch:{input, regex[, options]}}` |
| 8 | `Quantify(path, param, inner, q)` | `q=some` and the inner query is total → `{p:{$elemMatch: Q(inner)}}`<br>`q=every` → `unsupported` — needs De Morgan | `some` → `$anyElementTrue` over `$map`<br>`every` → `$allElementsTrue` over `$map` |
| 9 | `Logical(op, kids)` | `and` → merge keys, `$and` on collision<br>`or` → `{$or:[…]}`, all-or-nothing<br>`not` → `unsupported` — De Morgan flips index usage with the data shape | `{$and:[…]}` / `{$or:[…]}` / `{$not: …}` |
| 10 | `Truthy(t)` | `unsupported` — JS truthiness needs "not in `{null, missing, false, "", 0}`", and `$nin` on an array field switches to element matching | the `$and` chain `jsBool` emits |
| 11 | `Raw(t)` | `unsupported` by definition | the term's own Expr lowering |

## What the nodes absorb

Eleven nodes cover the predicate surface. The point of the IR is that nodes are
fewer than methods, so a new predicate-shaped method usually needs no new node:

| Node | Methods it absorbs |
|---|---|
| `Contains` | `includes`, `startsWith`, `endsWith` |
| `Cmp` | `isSame`, `isBefore`, `isAfter` |
| `Quantify` | `some`, `every` |
| `RegexMatch` | `match`, `test` |
| `Logical` | `inRange` |

`.startsWith` and `.endsWith` reach `Contains` with an anchor, so they gain an
indexed query form the day the anchored case gets one. Until then they take the
`$expr` fallback automatically rather than by omission.

## Two nodes for one method

`includes` splits by receiver shape, and the split happens once, at desugar
time, instead of inside a translator:

```
$.tags.includes("vip")        → Contains(path, const, any)      → { tags: "vip" }
["a","b"].includes($.status)  → Membership(path, consts, any)   → { status: { $in: ["a","b"] } }
```

## Normalisation, not special cases

`Membership(mode: all)` is not a source construct. The desugar pass produces it
from an `&&` chain of same-path `Contains` nodes, so `$all` is an
And-normalisation rewrite over `Logical` children rather than a branch inside a
leaf translator. See [desugar-pass.md](desugar-pass.md).

## Implementation state

The IR lands node by node. `src/predicate-ir.ts` holds the shared vocabulary and the cells;
each node moves when its two sides are made to read that vocabulary instead of their own.

| Node | State |
|---|---|
| 6 `Contains` (anchored) | **shared.** `.startsWith` / `.endsWith` gained the indexed query form the overview predicted — an escaped prefix/suffix regex, gated on a literal needle and a static path. |
| 2 `Exists` | **shared.** `$exists` as a query, a `$type`-against-`"missing"` test as an expression. |
| 3 `TypeIs` | **shared.** One alias table, both cells derived. The Query cell is gated on a static path and takes the alias directly; the Expr cell accepts any operand and expands a query-only group alias (`number`) into the concrete types `$type` can return. |
| the other eight | still two implementations — the Query cell in `src/match-translation.ts`, the Expr cell in `src/codegen.ts` and the method families. |

`TypeIs` moved first because its two sides provably disagreed: the expression cell compared
`$type` against JavaScript's own spelling, so `typeof $.a === "boolean"` was false for every
document while the identical source in Filter position was correct. That is the failure the
IR exists to make impossible, so it is the node that earns it.

## The acceptance harness

`test/query-expr-agreement.test.ts` runs both lowerings of one source over the same documents
on a live mongod and compares which come back. It is what makes migrating a node safe: the
unit tests assert what each side EMITS, and the two sides drifted apart for months while
every one of those tests passed.

Migrate a node by adding its sources to that suite first. A node that already agrees must
still agree afterwards; a node that does not is a bug to fix, not a shape to preserve — which
is how `TypeIs` was found.

## Adding a predicate feature

1. Check whether an existing node covers it. Most do — see the absorption table.
2. If it needs a new node, declare both cells. The Query cell states the operand
   kinds it accepts, or `unsupported(reason)` when the query language has no
   equivalent.
3. A node without a Query cell needs nothing else. The `$expr` fallback is
   automatic.
