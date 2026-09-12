# `$$$.<coll>` `.find / .filter` → `$lookup` (cross-database `$$$$.<db>.<coll>` reads are rejected)

## What this covers

The implementation-facing companion to the user-facing reference in [LANGUAGE.md → Cross-collection lookups](../LANGUAGE.md#cross-collection-lookups-collfind--filter). Covers detection of the `$$$.<coll>` same-database shape (a `$$$$.<db>.<coll>` cross-database **read** is detected only to be **rejected** — see § Cross-database reads are rejected), predicate translation (basic vs pipeline form, auto-`let` extraction), the chained-terminal materialisation (`.length`, `.reduce`, member access), the slot-allocation contract for internal `__jsmql.tmp.<N>` slots, the mode-gate behaviour, the cross-database rejection at the `foreignChain` choke point in [src/compiler/emit/join.ts](../../src/compiler/emit/join.ts), and the error catalog.

## Why `$$$` (and not `this.`)

`this.<coll>.find(pred)` reads well, and cannot be the surface: `this` is a JavaScript reserved word that is *parse-rejected* outside a class or method body, so `({ $ }) => this.users.find(...)` would not round-trip through a `.js` file — the strict-JS-subset rule in the root [`CLAUDE.md`](../../CLAUDE.md). The context-reference prefixes (`$$` / `$$$` / `$$$$`) parse anywhere, never collide with the host language, and give one uniform vocabulary for the four document-context scopes (`$.`, `$$`, `$$$`, `$$$$`). See [`context-references.md`](./context-references.md) for the prefix grammar and AST nodes.

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

**Block bodies.** The parser accepts a `{ … }` body on any callback (see [grammar.md](grammar.md)); what the block MEANS is the row's business. `.aggregate((o) => { $sort(…); $limit(5); })` keeps its statements as the stages of the sub-pipeline. `.find` / `.filter` / `.reject` / `.map` are JavaScript methods: a stage-free block folds back to its value (`{ return E }` → `E`; `{ const … ; return E }` → a `$let`), and a stage-bearing one is refused, naming the stage and the `.aggregate` rewrite ([method-dispatch of callback blocks](emit-pass.md)). Parsing first is what buys that message: a grammar that stopped at the first `$` could only say "unexpected token".

## AST extension

`src/registry/ast.ts` — the `Lambda` variant gains an optional sibling field:

```ts
| { type: "Lambda"; params: string[]; body?: Expr; block?: Pipeline; pos: number }
```

Exactly one of `body` / `block` is set. Every consumer that needs a value (an array method's callback, an IIFE, `$let`) refuses a block-form lambda with an actionable error — `.aggregate` is the one position that keeps a block — so a call site that reads `lambda.body` is total after that check.

## The join road

[`src/compiler/emit/join.ts`](../../src/compiler/emit/join.ts) lowers every `$$$.<coll>.<chain>`. Two shapes, one road: a body that opens with one correlated equality is the `localField` / `foreignField` pair, with the links that follow it in `pipeline` beside the pair (MongoDB 5.0+ runs that pipeline over the pair's matches), and everything else is `let` + `pipeline` + `$expr` (the shapes, the server-version fact and the rules that apply to each: [emit-pass.md § The join road](emit-pass.md)).

**`lookupOf(node, env)`** turns the chain into a `$lookup`. It peels the links from the collection outwards, asking each link's row for the stages it means on a stream (the same `stream` cell a top-level `$$.<link>` uses — [stream-methods.md](stream-methods.md)), and appends them to the sub-pipeline: `.filter(p)` → `$match`, `.sortBy(k)` → `$sort`, `.take(n)` → `$limit`, a stage link `.$group(…)` → the stage, `.aggregate(block)` → the block's stages. `.find(p)` is the first match as ONE document — `$match` + `$limit: 1`, and the destination unwraps the array with `$first`. The peel stops at the first link that makes a VALUE of the documents (`.length`, `.map(o => o.total)`, `.sum()`, a field read after `.find`): what follows is `rest`, and `complete` is false.

**The body's Env.** The sub-pipeline is lowered one level deeper: `env.enter` crosses a `$lookup` boundary with a fresh `Capture`, so every read of the OUTER document inside the body is interned into the stage's `let` and read back as a `$$` variable — `$.userId` → `let: { jsmql_f0_userId: "$userId" }`, a pipeline `let` binding → `jsmql_v0_<name>`, the root count `$$.length` → `jsmql_s0_length` ([stream-length.md](stream-length.md)). The number is the level the read comes FROM, so a nested body captures an ancestor under a distinct name and MQL's lexical `$$` scoping never shadows it. The callback's first parameter is the foreign document (`o.total` → `"$total"`); the second is refused as a read (a stream has no index); the third is the joined stream itself (`coll.length`, `coll.filter(…)`). `$.` is the outer document at every depth (HR4); a write inside the body goes through the parameter (`o.x = …`).

**A value terminal gives ONE DOCUMENT.** The `$lookup.as` array holds the foreign collection's documents, so the binding for the slot states `elements: "object"`, and a method whose row answers `returns: "element"` — `.head()`, `.first()`, `.last()`, `.at(i)`, `.nth(i)`, `.find(p)`, `.findLast(p)`, `.min()`, `.max()`, `.minBy(k)`, `.maxBy(k)` — is typed `"object"` over it. Every array method is then refused on that document, with the field read named as the way out. The proof belongs to the binding and travels no further: a link that REPLACES the elements (`$$$.c.map(f).head()`) leaves them unproven, and a field path proves nothing at all (`$.items.head()`), so both keep every method open. Before the elements were stated, `$$$.c.head().map(f)` emitted `$map` over a document, which mongod refuses at execution time on a non-empty collection and silently answers null on an empty one.

**The callback's third parameter** (`(o, _i, c) => …`) is the body's own stream: `c.length` is its count and a chain on it (`c.filter(…)`) its stages. Read as a value on its own (`c.total`, `c`) it is refused by name — it is neither a document nor a value.

**Four destinations**, by the statement the chain stands in:

| Statement | Lowering | Function |
|---|---|---|
| `$.o = $$$.c.<chain>` with nothing after the peel | the target IS `as`; `.find` adds `$set: { o: { $first: "$o" } }` | `joinWrite` |
| any VALUE position (`$.n = <chain>.length`, `let t = <chain>.reduce(…)`, a stage body) | the `$lookup` is hoisted ahead of the statement into a scratch slot `__jsmql.tmp.<N>`, bound as a typed name (an array for `.filter`, a document for `.find`), and the rest of the chain is lowered as a value over the slot — `.length` → `$size`, `.map(f).sum()` → `$sum: { $map: … }`, `.name` → a path | `joinValue` |
| `$ = $$$.c.find(p)` | `$lookup` into a slot, `$unwind`, `$replaceWith`: each document becomes the one it found, and a document that found nothing leaves the stream (`$unwind` of an empty slot drops it — by design) | `joinRoot` |
| `$$ = $$$.c.<chain>` | correlated (the body read the outer document): a `$lookup` per outer document, `$unwind`, `$replaceWith`; uncorrelated: the current stream is dropped and the other collection's pipeline unioned in (`$unionWith`) | `joinStream` |

A write whose chain goes on after the peel (`$.o = $$$.c.filter(p).map(f)`) is lowered twice — once to learn it is not complete, once on the value road — and the first attempt takes back what it hoisted, so a `$$.length` stamp lands once. A `let` whose value is a complete chain uses its own slot `__jsmql.var.<name>` as `as` ([let-bindings.md](let-bindings.md)). The scratch slots live under `__jsmql`, which the chain's single trailing `{ $unset: "__jsmql" }` removes; inside a sub-pipeline the cleanup is the sub-pipeline's own.

**Nested reads.** A `$$$.<coll2>` read inside a body is a `$lookup` inside the sub-pipeline, hoisted ahead of the stage that reads it, with its own `let` at its own level:

```js
$.a = $$$.b.filter(x => x.n > $.m && $$$.c.filter(y => y.k === x.k).length > 0)
// → [{ $lookup: { from: "b", let: { jsmql_f0_m: "$m" }, pipeline: [
//        { $lookup: { from: "c", localField: "k", foreignField: "k", as: "__jsmql.tmp.0" } },
//        { $match: { $expr: { $and: [{ $gt: ["$n", "$$jsmql_f0_m"] }, { $gt: [{ $size: "$__jsmql.tmp.0" }, 0] }] } } },
//        { $unset: "__jsmql" }], as: "a" } }]
```

**The collection's name** is a compile-time constant: `$$$.orders`, `$$$["orders"]`, or a `jsmql.compile` parameter / template slot holding a string (`$$$[coll]`) — MongoDB's `$lookup.from` takes no expression. `$$$[$.name]` is refused ("the collection is named when the pipeline is written"), and `$$$[""]` names no collection.

**Cross-database reads are refused.** `$$$$.<db>.<coll>.<chain>` would need `from: { db, coll }`, which is Atlas Data Federation's form and not a MongoDB server's; the refusal says to drop the `$$$$.<db>.` prefix and run the pipeline against that database, and that the cross-database WRITE (`$$$$.<db>.<coll> = $$` → `$out`) works ([out-stage.md](out-stage.md)).

## Mode gates

A join materialises a `$lookup` stage, so it needs a pipeline to place it in. `jsmql.filter()`, `jsmql()` on a bare expression and `jsmql.expr()` refuse it — "'$$$.<coll>' (a read of another collection) needs Pipeline mode — it materialises a '$lookup' stage. Use it inside a pipeline …" — and `jsmql.update()` refuses it as it refuses everything that is not a write ("An update document is made of writes …").

## Error catalog

Every refusal is a `CodegenError` with the offending node's `pos`, so `validate()` underlines the span.

| Trigger | Message (paraphrased) |
|---|---|
| `$$$.orders.filter(p);` — a read with no destination | "Reading another collection produces a value, and this statement gives it no destination. Assign it to a field ('$.<field> = …'), bind it ('let x = …'), or make it the stream ('$$ = …')." |
| `$$ = $$$.c.filter(p).length` — a value where documents are needed | "… makes a value …" |
| `$$ = $$$.c.find(p)` — one document where a stream is needed | ".find gives ONE document, and a stream is many" |
| `$ = $$$.c.filter(p)` — many where the root needs one | "… the root needs one document …" |
| `$$$.orders.fnid(o => …)` | "Unknown method '.fnid()' at position N. Did you mean '.find()'?" |
| `$$$.orders.find()` | "'.find(predicate)' requires exactly 1 argument, got 0" |
| `$$$.orders.find(p).length` | "'.length' is not available on a 'object' — it is defined on 'array', 'string', 'stream'." |
| `$$$.orders.filter(p)` in a filter / `jsmql.expr` | the pipeline-mode refusal above |
| `$$$[$.name]` / `$$$[""]` | "named when the pipeline is written" / "names no collection" |
| `$$$$.<db>.<coll>.filter(p)` | the cross-database refusal above |
| `$$.push($$$.c.filter(x => x.n > $.m))` — an outer read in a `$unionWith` body | "'$unionWith' has no 'let': its body cannot read the outer document …" ([union-stage.md](union-stage.md)) |
