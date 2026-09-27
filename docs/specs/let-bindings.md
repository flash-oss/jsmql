# Pipeline-scoped `let` bindings

**Status:** implemented.

This spec states how `let <name> = <expr>;` lowers from a JavaScript-syntax
pipeline statement to MongoDB `$set` / `$unset` stages, and how a later
identifier reference is rewritten to the materialised field path.

User-facing reference is in [LANGUAGE.md](../LANGUAGE.md) § Pipelines.

> **Constant folding.** This `$set` / `__jsmql.var.<name>` lowering is the
> **runtime** path. The compiler takes it when the right-hand side reads
> document or environment state. When the right-hand side is a
> **compile-time constant**, the declaration instead folds to a value that
> is inlined at every reference (no stage, and the preamble does not force
> Pipeline mode). [desugar-pass.md](desugar-pass.md) owns that fold. Folding
> is a post-parse pre-pass; everything below applies to the runtime fallback.

> **Scope note.** This spec covers `let` / `const` at the **top level of a
> pipeline**. There, the compiler materialises each one as an
> `__jsmql.var.<name>` document field (`$set` stage). The *same keywords*
> inside a **block-body arrow** (`x => { const a = …; return … }`) form a
> different construct with a different lowering — an in-expression `$let`
> variable (`$$name`), not a document field. [emit-pass.md → Block-body
> arrows](emit-pass.md#bindings-between-stages) owns that construct.

## Why it exists

The construct sits above the existing [update ops](update-filter.md) machinery (`$.x = …`)
and adds three things to plain update ops:

1. **Auto-cleanup** — the compiler emits one trailing `{ $unset: "__jsmql" }`
   stage per pipeline, whenever at least one `let` declaration exists.
2. **Collision-safe storage** — every let materialises under one nested field,
   `__jsmql.var.<name>`. The lowering never touches a user's real document
   field named `name`.
3. **Bare-identifier reference** — a call site reads `total`, not `$.total`,
   so a "scratch helper" read looks visually distinct from a "real document
   field" read. This also gives each derivation one line for an intent
   comment.

The lowering is a thin layer over the existing primitives. It adds no
MongoDB-side feature.

## AST

One new node type in [src/registry/ast.ts](../../src/registry/ast.ts):

```ts
type LetDecl = { type: "LetDecl"; name: string; value: Expr; kind: "let" | "const" };
```

`kind` records the surface keyword and affects only reassignment (see
§ Reassignment): a `let` binding accepts reassignment, a `const` binding
does not.

> **Fork note.** When the initialiser is an **arrow function**
> (`const f = (a) => …`), the parser produces a `FuncDecl` instead — a reusable
> named function, not a value binding. The initialiser alone tells the two
> apart. See [reusable-functions.md](reusable-functions.md).

`PipelineStmt` widens to `UpdateFilter | Expr | LetDecl`. `ArrayElement` does
not hold a `LetDecl`: JavaScript refuses a declaration as an array element, so
a let is always a `;`-separated statement (see § Parser).

## Lexer

Two keywords in [src/compiler/lex/lexer.ts](../../src/compiler/lex/lexer.ts):

| Token | Source | Notes |
|-------|--------|-------|
| `Let` | `let`  | A reserved keyword. It is added to `isIdentOrKeyword`, so `$let(...)` (the MongoDB operator) and `{ let: … }` (an object key in `$lookup`, `$graphLookup`, or top-level `aggregate({ let })`) still parse. The parser rejects the shorthand-property form `{ let }` on purpose — it has no useful meaning and it would collide with a `let x = …` statement. |
| `Const` | `const` | The read-only sibling of `let` (see § `let` vs `const`). It is also added to `isIdentOrKeyword`, so a `$.const` field path and a `{ const: … }` object key keep parsing — `const` is a valid JS property name. The parser rejects shorthand `{ const }`, the same as `{ let }`. |

## Parser

A leading `let` (or its `const` alias) opens a declaration wherever a
statement stands — at the top level and inside a block body. The declaration reads `let <Ident> = <Expression>`. A missing
identifier raises a position-marked `ParseError` that echoes the keyword as
written. A missing initialiser raises the same kind of error: a binding is a
value, and MQL has no `undefined` to hold the place of one. So the parser
refuses `let x;` with the spelling that works —
`'let x' binds no value at position 0. JSMQL has no 'undefined' to bind — write
'let x = <expr>'.`

### Declaration lists

A `,` continues the declaration, exactly as JavaScript reads
`const a = …, b = …;`. Each declarator is its OWN declaration: a later one
reads the ones before it, a foldable declarator emits no stage, and a
declarator whose initialiser is an arrow becomes a reusable function
([reusable-functions.md](reusable-functions.md)). Each declarator needs an
initialiser, and the parser refuses a trailing `,` — the same rules
JavaScript enforces.

**The `,` is the merge; the `;` is the stage boundary.** [Update ops](update-filter.md)
already follow this rule (`$.a = …, $.b = …` is one `$set`, `$.a = …; $.b = …;`
is two), and a declaration follows it too:

```js
let a = $.p, b = $.q;                  let a = $.p;
$match(a > b);                         let b = $.q;
                                       $match(a > b);
// → [{ $set: { "__jsmql.var.a": "$p",   // → [{ $set: { "__jsmql.var.a": "$p" } },
//              "__jsmql.var.b": "$q" } },//    { $set: { "__jsmql.var.b": "$q" } },
//    { $match: … }, { $unset: … }]        //    { $match: … }, { $unset: … }]
```

#### Where a shared stage breaks

A `$set` stage evaluates every field against the stage's INPUT document, so a
declarator cannot read a sibling bound beside it. Measured on a running
mongod over `{ x: 10 }`: `[{ $set: { "__jsmql.var.a": "$x", "__jsmql.var.b":
{ $add: ["$__jsmql.var.a", 1] } } }]` answers `b: null`, while the split form
answers `b: 11`.

So the compiler opens a new stage exactly at a declarator that reads one
bound in the same stage, and nowhere else. The test runs on the LOWERED
value, so a dependency that arrives through an inlined function counts too:

```js
let a = $.x, b = a + 1, c = $.y;
$.o = b + c;
// → [{ $set: { "__jsmql.var.a": "$x" } },
//    { $set: { "__jsmql.var.b": { $add: ["$__jsmql.var.a", 1] },
//              "__jsmql.var.c": "$y" } },
//    { $set: { o: { $add: ["$__jsmql.var.b", "$__jsmql.var.c"] } } },
//    { $unset: "__jsmql" }]
```

`c` reads neither `a` nor `b`, so it joins `b` instead of opening a third stage.

Two more kinds of declarator end a run, both for the same reason: either one
would put a stage on the wrong side of the shared `$set`.

- **One whose lowering is not a plain `$set`** — for example a `$lookup` a
  foreign read writes into a binding's slot.
- **One whose value HOISTS a stage of its own.** A foreign read in a VALUE
  position (`let n = $$$.orders.filter(o => o.k === a).size()`) leaves a
  `$set` behind and puts its `$lookup` on the chain's prologue, which the
  chain flushes AHEAD of every stage the statement returns. Shared with the
  sibling it correlates on, that `$lookup` would run before the `$set` that
  binds the sibling, and it would correlate on a field nothing has written
  yet. Measured: `let a = $.x, b = $$$.c.filter(o => o.x === a).size() + 1;`
  answered `1` for every document, where the `;` spelling answered the real
  counts, and the server REJECTED two chained joins. So the compiler takes
  the declarator back (`Chain.rewind`) and lowers it again as its own
  statement, where the per-statement flush lands its prologue correctly.

A declarator that emits no stage at all — a folded constant, a function —
groups with anything.

#### Membership is the keyword, not adjacency

The declarators of one declaration share the source offset of the KEYWORD
that opened it. Adjacency in the statement list is not enough, because the
constant fold REMOVES a folded declaration from that list: in
`let a = $.x; let b = 5, c = $.y;` the folded `b` leaves `a` and `c` side by
side, and grouping them would merge two declarations the developer separated
with a `;`. They carry different keyword offsets, so each takes a stage of
its own.

#### The same rule inside a block

A block-body arrow binds `$let` variables rather than document fields
([emit-pass.md](emit-pass.md#bindings-between-stages)). `$let` evaluates
every var against the ENCLOSING scope — mongod answers
`Use of undefined variable: a` for `vars: { a: 5, b: { $add: ["$$a", 1] } }`.
So the same merge and break rule applies there, one `$let` per group:

```js
$.o = $.i.map((v) => { const d = v * 2, e = v + 1; return d + e; });
// → { $let: { vars: { d: { $multiply: ["$$v", 2] }, e: { $add: ["$$v", 1] } },
//             in: { $add: ["$$d", "$$e"] } } }

$.o = $.i.map((v) => { const d = v * 2, e = d + 1; return e; });
// → { $let: { vars: { d: { $multiply: ["$$v", 2] } },
//             in: { $let: { vars: { e: { $add: ["$$d", 1] } }, in: "$$e" } } } }
```

A declaration is never an element of a bracketed `[…]` pipeline, because
JavaScript refuses `[let x = …]`. The parser refuses it where the keyword
stands, and names the statement form:

```js
[let x = $.a + 1, $match(x > 5)]
// ✗ error — "`let x = …` is a declaration, and JavaScript refuses a declaration as an array element, at position 1.
//            Write the pipeline as statements, with a ';' after each one: `let x = …; $match(…);`.
//            A sub-pipeline takes its statements in an '.aggregate' block: …"

let x = $.a + 1; $match(x > 5);
// → [{ $set: { "__jsmql.var.x": { $add: ["$a", 1] } } },
//    { $match: { $expr: { $gt: ["$__jsmql.var.x", 5] } } },
//    { $unset: "__jsmql" }]
```

A sub-pipeline takes its declarations in an `.aggregate` block, and the refusal
names the three forms: `$.<field> = $$$.<coll>.aggregate(() => { … })` for a
`$lookup`, `$$.push(...$$$.<coll>.aggregate(() => { … }))` for a `$unionWith`,
and `$ = { k: $$.aggregate(() => { … }) }` for a `$facet` branch:

```js
$.o = $$$.orders.aggregate(() => { let x = $.b * 2; $match({ y: x }); });
// → [{ $lookup: { from: "orders", let: { jsmql_f0_b: "$b" }, pipeline: [{ $set: { "__jsmql.var.x": { $multiply: ["$$jsmql_f0_b", 2] } } }, { $match: { $expr: { $eq: ["$y", "$__jsmql.var.x"] } } }, { $unset: "__jsmql" }], as: "o" } }]
```

The declaration's `pos` — the offset every codegen error about the binding
forwards — is the KEYWORD for the first declarator, and the declarator's own
NAME for each one after it. This lets an error underline the exact
declarator it is about.

A declaration ALONE never stands as a Filter: `collapse()` keeps it in a
`Pipeline`, because nothing would read it. A constant declaration that
nothing reads leaves no stage, and the emitter refuses the empty program.
See [src/compiler/parse/parser.ts](../../src/compiler/parse/parser.ts).

**Re-declaration is a parse error, as in JavaScript.** One scope declares a
name once. The statement loop `block()` holds the scope of its block, and a
function's parameters open it: an arrow's or a `function`'s names (a
destructured pattern's parts included) and the entry form's destructure. A
second declaration of a name, or a declaration that names a parameter, is a
`ParseError` at that declaration. The parser holds this rule, because the
fold inlines a constant declaration before a later phase can see it. A
nested function opens a scope of its own, and its declaration may shadow an
outer name:

```js
let a = 1; let a = 2; $.x = a;
// ✗ error — "`let a` at position 11 is already declared earlier in this block, which JavaScript refuses. Pick a different name."

$.items.map(x => { const x = 99; return x })
// ✗ error — "`const x` re-declares the parameter `x` at position 19, which JavaScript refuses. Pick a different name."

$.items.map(x => $.other.map(y => { const x = 99; return x + y }))
// → { $map: { input: { $ifNull: ["$items", []] }, as: "x", in:
//      { $map: { input: { $ifNull: ["$other", []] }, as: "y", in:
//        { $let: { vars: { x: 99 }, in: { $add: ["$$x", "$$y"] } } } } } } }
```

The constructed `LetDecl` node records the keyword's source offset in its
`pos` field, and codegen forwards that offset into every `CodegenError` it
raises about the binding (a binding that shadows an outer one in the same
documents, a dropped-let read after a reshape stage). So a `.validate()`
caller sees the original keyword in `errors[0].pos`.

### `let` vs `const`

Both keywords declare a pipeline-scoped binding. They differ in
**reassignment**, and, as a result, in **static typing**. The statement
loop's `statement()` accepts either keyword.
`declarator()` records which one was written, in `LetDecl.kind`
(`"let" | "const"`). Declaration, read, scope-tracking, and cleanup
otherwise ignore the keyword. A re-declaration, shadow, or parser error
message echoes the keyword the user wrote.

### Static typing

A binding carries the kind the registry can prove of its initialiser
(`kindOf`). A later read dispatches at compile time where the kind is known,
and takes the dual-receiver form where it is not — the same rule every
other value follows ([emit-pass.md](emit-pass.md)). A `const` and a `let`
are typed alike at declaration; a reassignment writes the same slot.

### Reassignment

A later `<name> = <expr>` statement (a bare-identifier assignment) reassigns
an in-scope `let`. The parser accepts any bare identifier as a write target.
The write road (`writeStages` in
[src/compiler/emit/statement.ts](../../src/compiler/emit/statement.ts))
reads the binding:

- **a `let`** — lowers to one `{ $set: { "__jsmql.var.<name>": <value> } }`
  stage of its own, because a read-after-write needs separate stages. The
  right-hand side reads the binding's own slot, so `p = p * 0.9` lowers to
  `{ $set: { "__jsmql.var.p": { $multiply: ["$__jsmql.var.p", 0.9] } } }`.
  `+=` and `++` desugar to the same write.
- **a `const`** — refused: "'x' is a 'const' and cannot be assigned again.
  Declare it with 'let' to write it more than once."
- **dropped by a replacing stage** — refused with the post-replace error,
  in its reassignment form.
- **undeclared** — refused: "Unknown identifier 'y'. Did you mean '$.y'?"

Outside a pipeline — a filter, `jsmql.expr`, an update document — there is
no binding scope, so the compiler refuses a bare-identifier assignment
there too.

### `Object.assign` mutation

`Object.assign(<name>, ...sources)` at statement position is JavaScript's
*mutating* merge of a binding. Its value twin is
`<name> = { ...<name>, ...sources }`. The compiler reads it as a write of
the binding's slot
(`{ $set: { "__jsmql.var.<name>": { $mergeObjects: ["$__jsmql.var.<name>", …sources] } } }`).
Unlike `=`, it is **allowed on a `const`**: mutating a const-bound object is
legal JavaScript, and only rebinding is not. An undeclared name is refused,
the same as any unknown identifier. The field-path sibling
(`Object.assign($.x, …)`) and the shape rule that makes a bare call a write
live in
[update-filter.md § Mutators and `Object.assign`](update-filter.md).

## Lowering

### The binding

`letStages` in [src/compiler/emit/statement.ts](../../src/compiler/emit/statement.ts) lowers `let x = <expr>;` to `{ $set: { "__jsmql.var.x": <value> } }` and binds `x`, in the Env's scope, to that field slot. It marks the binding `mutable` for `let`, not for `const`, and types it with what the registry can prove of the value, so a later read is checked the way the value itself would be. Three values never reach a slot: a constant, because the fold already inlined it (`let x = 1; $.y = x` → `[{ $set: { y: 1 } }]`, with no slot and no cleanup); a lambda, because it is a name for a body (`const f = (x) => …`, inlined at each call like `function f`); and a complete join chain, whose `$lookup` writes the slot as its `as` ([lookup-stage.md](lookup-stage.md)). A second `let x` in one block is refused, as JavaScript refuses it. A binding a stage dropped stays declared, and `x = …` is the way back to it.

### Scope and resolution

Every name lives in the Env's `Scope` ([src/compiler/emit/env.ts](../../src/compiler/emit/env.ts), [src/compiler/emit/names.ts](../../src/compiler/emit/names.ts)). A callback body's Env is built from its parent's, so a body inherits every binding, and a callback parameter shadows a `let` of the same name only inside that body. A binding's `ref` states what a read becomes: a `field` slot is a path (`"$__jsmql.var.x"`, or a `let`-captured `$$` variable inside a `$lookup` body); a `var` is a `$$` variable (a callback parameter); a `constant` is its own value; a `function` is inlined at the call; a `streamHandle` is the callback's third parameter (the inner stream); and a `dropped` binding carries the refusal a read of it raises. An unknown name is refused, and the message names the nearest declared one.

### Stages that replace the document

`afterStages` reads each emitted stage's row. A stage whose `document` effect replaces the document — `fields`, `value` or `unknown` (`$group`, `$bucket`, `$replaceWith`, and others; see docs/specs/types.md) — or a `projection` in INCLUSION mode (every value `1` / `true`, apart from `_id: 0`) — takes every field-carried binding and the scratch namespace with it. A later read is refused, with a precise message:

```
let x = $.a; $group({ _id: null }); $.y = x
// ✗ `x` is a `let` binding and can't be read after `$group` — that stage replaced the document
//   that carried it. Assign it again after the stage (`x = …`), or carry the value as a field of the new document.
```

`$project({ b: 0 })` (exclusion mode) and `$project({ x: $.y + 1 })` (expression mode) leave the rest of the document alone, `__jsmql` included, so the bindings survive them. So does a chain link whose row states `restoresDocuments` (`.uniq()`): its `$group` and `$replaceWith` give the documents back as they were. The Env takes each group of stages once, in the order of the stages. So the same refusal holds for a write later in the same `,` run. See docs/specs/types.md § The document after a stage.

### Blocks and sub-pipelines

A block over the SAME documents — a `$facet` branch, a top-level callback — shares their fields: an outer binding is visible there (`let x = $.a; $ = { f: $$.filter(d => d.n > x) }` reads `"$__jsmql.var.x"` inside the branch), and the compiler refuses a shadowing `let`, because it would write the outer binding's slot. A body over ANOTHER collection — a `$lookup` — has documents of its own: an outer binding read there is carried through the stage's `let` as `jsmql_v<level>_<name>` and read as a `$$` variable, and the body can shadow freely. A `$unionWith` body has no `let`, so an outer read there is refused, with the join form that carries the value instead.

### Cleanup

The chain appends one `{ $unset: "__jsmql" }` when it closes with the namespace still on the documents (`Chain.dirty`): a `let` slot, a join's scratch slot, and the stream count share the namespace and the one cleanup. A stage that replaced the document clears the flag, so the cleanup never unsets a field that is already gone. A scratch field that a later stage writes sets the flag again: the flag follows the stages in the order they stand. A `$facet` branch is a pipeline over the documents that the `$facet` receives. So its chain starts with the flag of the chain around it (`Env.enter`). So each branch ends with its own cleanup, and the `$facet` output holds no scratch field. A program whose `let`s all folded emits no trace of the machinery.

## Output stability

A pipeline with no `let` declaration carries **no trace** of the binding
machinery. The `__jsmql` field name and the trailing `$unset` appear only
when at least one `let` is in scope at some point during lowering, or when
at least one `$$$.<coll>.find/filter(...)` chained terminal materialises
into an internal `__jsmql.tmp.<N>` slot (see
[`lookup-stage.md`](./lookup-stage.md)). The two features share the
`__jsmql` namespace and the single trailing `$unset` cleanup, so a pipeline
that uses both still emits exactly one `$unset` stage at the end.

## Lookup as a `let` RHS

`let os = $$$.c.filter(p);` uses the binding's own slot as the `$lookup`'s `as` — one stage, no `$set` — and types the binding as the array (`.filter`, `.aggregate`) or the document (`.find`) the chain yields. A chain that goes on (`let n = $$$.c.filter(p).size()`, `let s = $$$.tx.filter(p).reduce(fn, init)`) is a VALUE: the compiler hoists the `$lookup` into a scratch slot ahead of the `let`, and the slot holds the rest of the chain as a value — see [lookup-stage.md § The join road](lookup-stage.md). `const` refuses reassignment on both routes.

## Deferred

- **`$let`-as-optimisation.** When a let is read in exactly one downstream
  expression and no reshape stage steps between, the compiler could emit a
  single MongoDB `$let` that wraps that expression, instead of
  `$addFields` / `$unset`. This would help an index-preserving `$match`;
  the compiler does not do it today.
- **Index-pitfall warning [DEF-012].** A `let` before an indexable `$match`
  blocks the match from using the index. The compiler could surface a
  warning through `validate()`, but that needs a warning channel the
  project has not built yet. `LANGUAGE.md` documents the pitfall instead.

## Outer lets inside sub-pipelines

[Blocks and sub-pipelines](#blocks-and-sub-pipelines) states this: a `$facet` branch reads the outer binding's field, a `$lookup` body reads it through the stage's `let`, and a `$unionWith` body cannot read it at all.

## Tests

[test/compiler-statement.test.ts](../../test/compiler-statement.test.ts) covers the binding, reassignment, the fold of a constant `let`, the reads a replacing stage refuses, shadowing, and the cleanup. [test/compiler-join.test.ts](../../test/compiler-join.test.ts) covers a `let` as a `$lookup` slot and the `let` capture inside a body. [test/compiler-env.test.ts](../../test/compiler-env.test.ts) covers the Env's scope rules. Every pipeline these suites assert on runs on `mongod`.

[test/realistic.test.ts](../../test/realistic.test.ts) carries the canonical
order-pricing example under `pipeline: order pricing with let bindings +
commentary`, which doubles as the playground example via the post-edit hook.
