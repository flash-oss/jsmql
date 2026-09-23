# `$$$.<coll>` `.find / .filter` → `$lookup` (cross-database `$$$$.<db>.<coll>` reads are rejected)

## What this covers

This file is the implementation companion to the user guide in [LANGUAGE.md → Cross-collection lookups](../LANGUAGE.md#cross-collection-lookups-collfind--filter).

This file covers:

- detection of the `$$$.<coll>` same-database shape (the compiler detects a `$$$$.<db>.<coll>` cross-database **read** only to refuse it — see § Cross-database reads are refused)
- predicate translation (the basic form, the pipeline form, and auto-`let` extraction)
- the chained-terminal materialisation (`.size()`, `.reduce`, member access)
- the slot-allocation contract for internal `__jsmql.tmp.<N>` slots
- the place of a materialised `$lookup` in the pipeline (§ Where a hoisted stage lands)
- the mode-gate behaviour
- the cross-database refusal at the `foreignChain` choke point in [src/compiler/emit/join.ts](../../src/compiler/emit/join.ts)
- the error catalog

## Why `$$$` (and not `this.`)

`this.<coll>.find(pred)` reads well, but it cannot be the surface. `this` is a JavaScript reserved word, and a parser refuses it outside a class or a method body. So `({ $ }) => this.users.find(...)` would not parse as a `.js` file — see the strict-JS-subset rule in the root [`CLAUDE.md`](../../CLAUDE.md).

The context-reference prefixes (`$$` / `$$$` / `$$$$`) parse anywhere. They never collide with the host language, and they give one uniform vocabulary for the four document-context scopes (`$.`, `$$`, `$$$`, `$$$$`). See [`context-references.md`](./context-references.md) for the prefix grammar and the AST nodes.

## Grammar

No new lexer or parser tokens. The receiver chain is one of:

| Source                       | AST shape (outermost first)                                                                        |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| `$$$.<coll>`                 | `MemberAccess { object: DatabaseRef, member: <coll> }`                                              |
| `$$$["<coll>"]`              | `IndexAccess { object: DatabaseRef, index: StringLiteral }`                                         |
| `$$$$.<db>.<coll>`           | `MemberAccess { object: MemberAccess { object: ClusterRef, member: <db> }, member: <coll> }`        |
| `$$$$["db"]["coll"]`         | `IndexAccess { object: IndexAccess { object: ClusterRef, index: StringLiteral }, index: StringLiteral }` |
| `$$$$.db["coll"]` / `$$$$["db"].coll` | mixed `MemberAccess` / `IndexAccess` over `ClusterRef`                                    |

All shapes are built by the standard primary-postfix loop ([`src/compiler/parse/parser.ts`](../../src/compiler/parse/parser.ts)). The method call `.find(pred)` / `.filter(pred)` parses as the existing `MethodCall` node.

**Block bodies.** The parser accepts a `{ … }` body on any callback (see [grammar.md](grammar.md)). What the block MEANS is the row's own business. `.aggregate((o) => { $sort(…); $limit(5); })` keeps its statements as the stages of the sub-pipeline. `.find` / `.filter` / `.reject` / `.map` are JavaScript methods. A stage-free block folds back to its value (`{ return E }` → `E`; `{ const … ; return E }` → a `$let`). The compiler refuses a stage-bearing block, and the message names the stage and the `.aggregate` rewrite ([method-dispatch of callback blocks](emit-pass.md)). Parsing first is what buys that message: a grammar that stopped at the first `$` could only say "unexpected token".

## AST extension

`src/registry/ast.ts` — the `Lambda` variant gains an optional sibling field:

```ts
| { type: "Lambda"; params: string[]; body?: Expr; block?: Pipeline; pos: number }
```

Exactly one of `body` / `block` is set. Every consumer that needs a value (an array method's callback, an IIFE, `$let`) refuses a block-form lambda with an actionable error. `.aggregate` is the one position that keeps a block. So a call site that reads `lambda.body` is total after that check.

## The join road

[`src/compiler/emit/join.ts`](../../src/compiler/emit/join.ts) lowers every `$$$.<coll>.<chain>`. There are two shapes, and both use one road.

A body that opens with a correlated equality is the `localField` / `foreignField` pair. The equality can stand alone, or as one `&&` conjunct of the first predicate. The pair sits beside the other conjuncts and the links that follow, in `pipeline` (MongoDB 5.0+ runs that pipeline over the pair's matches). Everything else lowers as `let` + `pipeline` + `$expr`. For the shapes, the server-version fact, and the rule for each, see [emit-pass.md § The join road](emit-pass.md).

**`lookupOf(node, env)`** turns the chain into a `$lookup`. It peels the links from the collection outwards. For each link, it asks the link's row for the stages it means on a stream — the same `stream` cell a top-level `$$.<link>` uses ([stream-methods.md](stream-methods.md)) — and it appends them to the sub-pipeline: `.filter(p)` → `$match`, `.sortBy(k)` → `$sort`, `.take(n)` → `$limit`, a stage link `.$group(…)` → the stage, `.aggregate(block)` → the block's stages.

`.find(p)` gives the first match as ONE document: `$match` + `$limit: 1`, and the destination unwraps the array with `$first`. The peel stops at the first link that makes a VALUE of the documents (`.size()`, `.map(o => o.total)`, `.sum()`, a field read after `.find`). What follows is `rest`, and `complete` is false.

**The body's Env.** The sub-pipeline is lowered one level deeper. `env.enter` crosses a `$lookup` boundary with a fresh `Capture`. So every read of the OUTER document inside the body is interned into the stage's `let`, and read back as a `$$` variable: `$.userId` → `let: { jsmql_f0_userId: "$userId" }`, a pipeline `let` binding → `jsmql_v0_<name>`, the root count `$$.size()` → `jsmql_s0_size` ([stream-size.md](stream-size.md)).

The number is the level the read comes FROM. So a nested body captures an ancestor under a distinct name, and MQL's lexical `$$` scoping never shadows it.

The callback's first parameter is the foreign document (`o.total` → `"$total"`). The compiler refuses the second parameter as a read, because a stream has no index. The third parameter is the joined stream itself (`coll.size()`, `coll.filter(…)`). `$.` is the outer document at every depth (HR4). A write inside the body goes through the parameter (`o.x = …`).

**A value terminal gives ONE DOCUMENT.** The `$lookup.as` array holds the foreign collection's documents. So the binding for the slot states `elements: "object"`. A method whose row answers `returns: "element"` — `.head()`, `.first()`, `.last()`, `.at(i)`, `.nth(i)`, `.find(p)`, `.findLast(p)`, `.min()`, `.max()`, `.minBy(k)`, `.maxBy(k)` — is typed `"object"` over it. The compiler then refuses every array method on that document, and it names the field read as the way out.

The proof belongs to the binding, and it travels no further. A link that REPLACES the elements (`$$$.c.map(f).head()`) leaves them unproven. A field path proves nothing at all (`$.items.head()`). So both keep every method open.

Before this rule stated the elements, `$$$.c.head().map(f)` emitted `$map` over a document. mongod refuses this at execution time on a non-empty collection, and it silently answers null on an empty one.

**The callback's third parameter** (`(o, _i, c) => …`) is the body's own stream. `c.size()` is its count, and a chain on it (`c.filter(…)`) gives its stages. When the source reads it as a value on its own (`c.total`, `c`), the compiler refuses it by name, because it is neither a document nor a value.

**Four destinations**, by the statement the chain stands in:

| Statement | Lowering | Function |
|---|---|---|
| `$.o = $$$.c.<chain>` with nothing after the peel | the target IS `as`; `.find` adds `$set: { o: { $first: "$o" } }` | `joinWrite` |
| any VALUE position (`$.n = <chain>.size()`, `let t = <chain>.reduce(…)`, a stage body) | the compiler hoists the `$lookup` ahead of the stage that reads it (§ Where a hoisted stage lands), into a scratch slot `__jsmql.tmp.<N>` bound as a typed name (an array for `.filter`, a document for `.find`); it then lowers the rest of the chain as a value over the slot — `.size()` → `$size`, `.map(f).sum()` → `$sum: { $map: … }`, `.name` → a path | `joinValue` |
| `$ = $$$.c.find(p)` | `$lookup` into a slot, `$unwind`, `$replaceWith`: each document becomes the one it found, and a document that found nothing leaves the stream (`$unwind` of an empty slot drops it — by design) | `joinRoot` |
| `$$ = $$$.c.<chain>` | correlated (the body read the outer document): a `$lookup` per outer document, `$unwind`, `$replaceWith`; uncorrelated: the compiler drops the current stream and unions in the other collection's pipeline (`$unionWith`) | `joinStream` |

The compiler lowers a write whose chain goes on after the peel (`$.o = $$$.c.filter(p).map(f)`) twice. It lowers the write once to learn it is not complete, then once more on the value road. The first attempt takes back what it hoisted, so a `$$.size()` stamp lands once.

A `let` whose value is a complete chain uses its own slot `__jsmql.var.<name>` as `as` ([let-bindings.md](let-bindings.md)). The scratch slots live under `__jsmql`. The chain's single trailing `{ $unset: "__jsmql" }` removes them. Inside a sub-pipeline, the cleanup belongs to the sub-pipeline itself.

**Nested reads.** A `$$$.<coll2>` read inside a body is a `$lookup` inside the sub-pipeline. The compiler hoists it ahead of the stage that reads it, with its own `let` at its own level:

```js
$.a = $$$.b.filter(x => x.n > $.m && $$$.c.filter(y => y.k === x.k).size() > 0)
// → [{ $lookup: { from: "b", let: { jsmql_f0_m: "$m" }, pipeline: [
//        { $lookup: { from: "c", localField: "k", foreignField: "k", as: "__jsmql.tmp.0" } },
//        { $match: { $expr: { $and: [{ $gt: ["$n", "$$jsmql_f0_m"] }, { $gt: [{ $size: "$__jsmql.tmp.0" }, 0] }] } } },
//        { $unset: "__jsmql" }], as: "a" } }]
```

## Where a hoisted stage lands

A join in a VALUE position materialises a `$lookup` into a scratch slot. The chain's
`hoist` / `ahead` pair places that stage ([`src/compiler/emit/env.ts`](../../src/compiler/emit/env.ts)).
It lands **directly ahead of the stages of the lowering that hoisted it**, never at
the front of the statement. A callback's parameter names the document ITS stage
receives, so that is the document the `$lookup` has to read.

```js
$$.$sortByCount($.tag).map(g => ({ _id: g._id, n: $$$.orders.filter(o => o.tag === g._id).size() }));
// → [{ $sortByCount: "$tag" },
//    { $lookup: { from: "orders", localField: "_id", foreignField: "tag", as: "__jsmql.tmp.0" } },
//    { $replaceWith: { _id: "$_id", n: { $size: "$__jsmql.tmp.0" } } }]
```

`g._id` is the group key `$sortByCount` MADE, so `localField: "_id"` must be read
after it. Ahead of the statement, the same `_id` is the source document's.
`$sortByCount` then replaces the document and discards the slot. The read comes
back missing, and the server says nothing about it.

Every stage that reshapes the document (`$group`, `$replaceWith` / `$replaceRoot`,
`$project`, `$unwind`, `$bucket`, …) puts the two documents further apart. So the
drain runs per STAGE, not per statement, on every road that makes several stages
out of one source statement: the stream chain (one drain per link), a
`,`-joined run of writes (one per op, so `$.k = $.pid, $.name = $$$.c.find({ _id:
$.k }).name` joins on the `k` the first write made), the array reducer, a
bracketed program, and a stage block's statements. `lookupOf` has always drained
per link. This is why the same chain inside a `$lookup` body placed its nested
join correctly.

**A variable an enclosing expression binds is refused.** `$lookup` is a stage. So
the compiler hoists it out of any `$map` / `$filter` / `$reduce` / `$let` the
source wrote it inside, and its body would then name a variable the server never
bound there ("Use of undefined variable: x", measured).

No placement fixes this: the join runs per ARRAY ELEMENT, and a stage runs per
DOCUMENT. So the compiler refuses the read where it stands. The message names
the two spellings that work: make the elements documents first (`$$ = $.items;`),
or read the collection outside the callback into a binding (`let ps =
$$$.<coll>.filter(…);`) that the callback then uses.

`Env.render` holds the gate. A `Located` of kind `var` carries the LEVEL it was
bound on, and a read of one from a deeper level is the refusal.

**A correlated key is a CONSTANT to the server.** `$lookup` evaluates its `let`
against the outer document, then it optimises the sub-pipeline with the result
substituted in. So a type-dispatching expression there folds against that one
value, branch by branch.

A nested `$cond` folds the branch that does not apply, and the server refuses the
whole pipeline before it reads a document — MEASURED: `$.o =
$$$.products.find({ _id: $.arr[0] })` answered "can't convert from BSON type array to
String" for an array key, and "$arrayElemAt's first argument must be an array" for a
string one.

So every runtime type dispatch JSMQL writes is a `$switch`. A `$switch` drops a
branch whose case folds to false, without optimising it (`indexAccess` in
[src/compiler/emit/lower.ts](../../src/compiler/emit/lower.ts), and the family dispatch
`select.ts` builds). The same hazard reaches a plain expression through any value the
server holds as a constant — a `jsmql.compile` parameter inside `$literal` — so the
shape is one shape everywhere, and no rule ever picks it by position.

**The collection's name** is a compile-time constant: `$$$.orders`, `$$$["orders"]`, or a `jsmql.compile` parameter or template slot that holds a string (`$$$[coll]`). MongoDB's `$lookup.from` takes no expression. The compiler refuses `$$$[$.name]` ("the collection is named when the pipeline is written"), and `$$$[""]` names no collection.

**Cross-database reads are refused.** `$$$$.<db>.<coll>.<chain>` would need `from: { db, coll }`. That is Atlas Data Federation's form, not a MongoDB server's. The refusal tells the reader to drop the `$$$$.<db>.` prefix and run the pipeline against that database. It also states that the cross-database WRITE (`$$$$.<db>.<coll> = $$` → `$out`) works ([out-stage.md](out-stage.md)).

## Mode gates

A join materialises a `$lookup` stage, so it needs a pipeline to place it in. `jsmql.filter()`, `jsmql()` on a bare expression, and `jsmql.expr()` refuse it: "'$$$.<coll>' (a read of another collection) needs Pipeline mode — it materialises a '$lookup' stage. Use it inside a pipeline …". `jsmql.update()` refuses it too, the same way it refuses everything that is not a write ("An update document is made of writes …").

## Error catalog

Every refusal is a `CodegenError` with the offending node's `pos`, so `validate()` underlines the span.

| Trigger | Message (paraphrased) |
|---|---|
| `$$$.orders.filter(p);` — a read with no destination | "Reading another collection produces a value, and this statement gives it no destination. Assign it to a field ('$.<field> = …'), bind it ('let x = …'), or make it the stream ('$$ = …')." |
| `$$ = $$$.c.filter(p).size()` — a value where documents are needed | "… makes a value …" |
| `$$ = $$$.c.find(p)` — one document where a stream is needed | ".find gives ONE document, and a stream is many" |
| `$ = $$$.c.filter(p)` — many where the root needs one | "… the root needs one document …" |
| `$$$.orders.fnid(o => …)` | "Unknown method '.fnid()' at position N. Did you mean '.find()'?" |
| `$$$.orders.find()` | "'.find(predicate)' requires exactly 1 argument, got 0" |
| `$$$.orders.find(p).size()` | "'.size()' is not available on an 'object' — it is defined on 'array', 'stream'. For the number of fields, write '.keys().size()'." |
| `$$$.orders.filter(p)` in a filter / `jsmql.expr` | the pipeline-mode refusal above |
| `$$$[$.name]` / `$$$[""]` | "named when the pipeline is written" / "names no collection" |
| `$$$$.<db>.<coll>.filter(p)` | the cross-database refusal above |
| `$$.push($$$.c.filter(x => x.n > $.m))` — an outer read in a `$unionWith` body | "'$unionWith' has no 'let': its body cannot read the outer document …" ([union-stage.md](union-stage.md)) |
| `$geoNear({ …, query: { n: $$.size() } })` — a first-only stage whose body needs a hoisted stage | "'$geoNear' has to be the FIRST stage of the pipeline, and a value in its body needs a '$setWindowFields' stage of its own to run BEFORE it …" ([emit-pass.md](emit-pass.md) § Placement) |
| `$.n = $.items.map(x => $$$.c.find({ _id: x.k }))` — a join reading a variable an enclosing callback binds | "'x' is bound by an enclosing callback, and a read of another collection is a '$lookup' STAGE … Make the elements documents first ('$$ = $.<array>;') … or read the collection OUTSIDE the callback ('let <name> = $$$.<coll>.filter(…);')" |
