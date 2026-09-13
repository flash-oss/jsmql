# Pipeline-scoped `let` bindings

**Status:** implemented.

How `let <name> = <expr>;` lowers from JavaScript-syntax pipeline statements
to MongoDB `$set` / `$unset` stages, and how downstream identifier references
are rewritten to the materialised field paths.

User-facing reference is in [LANGUAGE.md](../LANGUAGE.md) § Pipelines.

> **Constant folding.** This `$set`/`__jsmql.var.<name>` lowering is the
> **runtime** path, taken when the RHS reads document/environment state. When
> the RHS is a **compile-time constant**, the declaration instead folds to a
> value that is inlined at every reference (no stage, and the preamble does not
> force Pipeline mode) — owned by [desugar-pass.md](desugar-pass.md). Folding
> is a post-parse pre-pass; everything below applies to the runtime fallback.

> **Scope note.** This spec covers `let`/`const` at the **top level of a pipeline**, which materialise as `__jsmql.var.<name>` document fields (`$set` stages). The *same keywords* inside a **block-body arrow** (`x => { const a = …; return … }`) are a different construct with a different lowering — in-expression `$let` variables (`$$name`), not document fields. That is owned by [emit-pass.md → Block-body arrows](emit-pass.md#bindings-between-stages).

## Why it exists

The construct sits above the existing [update ops](update-filter.md) machinery (`$.x = …`)
and adds three things on top of plain update ops:

1. **Auto-cleanup** — one trailing `{ $unset: "__jsmql" }` stage per pipeline,
   emitted by the compiler whenever at least one `let` was declared.
2. **Collision-safe storage** — all lets materialise under a single nested field
   `__jsmql.var.<name>`. A user's real document field named `name` is never touched.
3. **Bare-identifier reference** — `total` (not `$.total`) at call sites, so
   "scratch helper" reads visually distinct from "real document field". Naturally
   provides a one-line spot for an intent comment per derivation.

Mechanically, the lowering is a thin layer on top of the existing primitives;
no MongoDB-side feature is being added.

## AST

One new node type in [src/registry/ast.ts](../../src/registry/ast.ts):

```ts
type LetDecl = { type: "LetDecl"; name: string; value: Expr; kind: "let" | "const" };
```

`kind` records the surface keyword and only affects reassignment (see
§ Reassignment): a `let` binding is reassignable, a `const` binding is not.

> **Fork note.** When the initialiser is an **arrow function**
> (`const f = (a) => …`), the parser produces a `FuncDecl` instead — a reusable
> named function, not a value binding. The two are distinguished purely by the
> initialiser. See [reusable-functions.md](reusable-functions.md).

`PipelineStmt` is widened to `UpdateFilter | Expr | LetDecl`; `ArrayElement`
is widened to include `LetDecl` (parallel to `AssignExpr` / `DeleteStmt`), so a
let can appear either as a `;`-separated statement or as an element in a
bracketed `[…]` pipeline.

## Lexer

Two keywords in [src/compiler/lex/lexer.ts](../../src/compiler/lex/lexer.ts):

| Token | Source | Notes |
|-------|--------|-------|
| `Let` | `let`  | Reserved keyword. Added to `isIdentOrKeyword` so `$let(...)` (the MongoDB operator) and `{ let: … }` (object keys in `$lookup`, `$graphLookup`, top-level `aggregate({ let })`) still parse. The shorthand-property form `{ let }` is intentionally rejected — there's no useful meaning for it and it would collide with `let x = …` statements. |
| `Const` | `const` | Read-only sibling of `let` (see § `let` vs `const`). Also added to `isIdentOrKeyword` so `$.const` field paths and `{ const: … }` object keys keep parsing — `const` is a valid JS property name. Shorthand `{ const }` is rejected, same as `{ let }`. |

## Parser

A leading `let` (or its `const` alias) opens a declaration wherever a statement
stands — at the top level, inside a bracketed pipeline, and inside a block body —
and the declaration is `let <Ident> = <Expression>`. A missing identifier is a
position-marked `ParseError` that echoes the keyword as written. So is a missing
initialiser: a binding is a value and MQL has no `undefined` to hold the place of
one, so `let x;` is refused with the spelling that works —
`'let x' binds no value at position 0. jsmql has no 'undefined' to bind — write
'let x = <expr>'.`

### Declaration lists

A `,` continues the declaration, exactly as JavaScript reads
`const a = …, b = …;`. Each declarator is its OWN declaration, so the parser
builds for a list the same nodes it builds for the `;`-separated statements: a
later declarator reads the ones before it, a foldable declarator still emits no
stage, and a declarator whose initialiser is an arrow is still a reusable
function ([reusable-functions.md](reusable-functions.md)). An initialiser is
required per declarator, and a trailing `,` is refused — JavaScript refuses both.

Each runtime binding therefore keeps a `$set` of its own, and that is what lets a
binding read the one before it: a `$set` evaluates every field against the stage's
INPUT document, so two bindings sharing a stage could not depend on each other
(measured on `{ x: 10 }`: one stage answers `b: null`, two answer `b: 11`).

```js
let x = $.a, y = x + 1;
$.c = y;
// → [{ $set: { "__jsmql.var.x": "$a" } },
//    { $set: { "__jsmql.var.y": { $add: ["$__jsmql.var.x", 1] } } },
//    { $set: { c: "$__jsmql.var.y" } },
//    { $unset: "__jsmql" }]
```

Inside a bracketed `[…]` pipeline the `,` is already the ELEMENT separator, so a
list is not read there: each element carries its own keyword
(`[ let a = …, let b = …, … ]`).

The declaration's `pos` — the offset every codegen error about the binding
forwards — is the KEYWORD for the first declarator and the declarator's own NAME
for each one after it, so an error underlines the declarator it is about.

A declaration ALONE is not a program: with no `;` to make the input a pipeline, a
lone `let X = …` is refused with the two spellings that work — a trailing `;`, or
the bracketed form `[ let X = …, … ]`. See
[src/compiler/parse/parser.ts](../../src/compiler/parse/parser.ts).
Re-declaration is **not** caught at the parser — it needs a pipeline-level view
and lives in codegen. The constructed `LetDecl` node records the keyword's source
offset in its `pos` field; codegen forwards that offset into every `CodegenError`
it raises about the binding (re-declaration, binding/parameter name collision,
dropped-let read after a reshape stage), so `.validate()` callers see the original
keyword in `errors[0].pos`.

### `let` vs `const`

Both keywords declare a pipeline-scoped binding; they differ in **reassignment**
and, following from that, in **static typing**. The three dispatch sites
(`collectStatement()`, `parseArrayLiteral()`, and the object-key branch in
`parseObjectEntry()`) accept either keyword. `parseLetDecl()` records which one was
written in `LetDecl.kind` (`"let" | "const"`); declaration, read, scope-tracking,
and cleanup are otherwise keyword-agnostic. The keyword is echoed in the
re-declaration / shadow / parser error wording.

### Static typing

A binding carries the kind the registry can prove of its initialiser (`kindOf`),
so a later read dispatches at compile time where the kind is known and takes the
dual-receiver form where it is not — the same rule every other value follows
([emit-pass.md](emit-pass.md)). A `const` and a `let` are typed alike at
declaration; a reassignment writes the same slot.

### Reassignment

A later `<name> = <expr>` statement (a bare-identifier assignment) reassigns an
in-scope `let`. The parser accepts any bare identifier as a write target, and the
write road (`writeStages` in
[src/compiler/emit/statement.ts](../../src/compiler/emit/statement.ts)) reads the
binding:

- **a `let`** → one `{ $set: { "__jsmql.var.<name>": <value> } }` stage of its own
  (a read-after-write needs separate stages); the RHS reads the binding's own slot,
  so `p = p * 0.9` lowers to
  `{ $set: { "__jsmql.var.p": { $multiply: ["$__jsmql.var.p", 0.9] } } }`.
  `+=` / `++` desugar to the same write.
- **a `const`** → refused: "'x' is a 'const' and cannot be assigned again. Declare
  it with 'let' to write it more than once."
- **dropped by a replacing stage** → the post-replace error, reassignment flavour.
- **undeclared** → "Unknown identifier 'y'. Did you mean '$.y'?"

Outside a pipeline (a filter, `jsmql.expr`, an update document) there is no
binding scope, so a bare-identifier assignment is refused there too.

### `Object.assign` mutation

`Object.assign(<name>, ...sources)` at statement position is JavaScript's
*mutating* merge of a binding — the value twin is `<name> = { ...<name>, ...sources }`.
It is read as a write of the binding's slot
(`{ $set: { "__jsmql.var.<name>": { $mergeObjects: ["$__jsmql.var.<name>", …sources] } } }`),
and — unlike `=` — it is **allowed on a `const`**: mutating a const-bound object is
legal JavaScript, only rebinding is not. An undeclared name is refused as any
unknown identifier is. The field-path sibling (`Object.assign($.x, …)`) and the
shape rule that makes a bare call a write live in
[update-filter.md § Mutators and `Object.assign`](update-filter.md).

## Lowering

### The binding

`letStages` in [src/compiler/emit/statement.ts](../../src/compiler/emit/statement.ts) lowers `let x = <expr>;` to `{ $set: { "__jsmql.var.x": <value> } }` and binds `x` in the Env's scope to that field slot — `mutable` for `let`, not for `const`, typed with what the registry can prove of the value, so a later read is checked as the value would be. Three values never reach a slot: a constant, which the fold has inlined (`let x = 1; $.y = x` → `[{ $set: { y: 1 } }]`, no slot, no cleanup); a lambda, which is a name for a body (`const f = (x) => …`, inlined at each call like `function f`); and a complete join chain, whose `$lookup` writes the slot as its `as` ([lookup-stage.md](lookup-stage.md)). A second `let x` in one block is refused, as JavaScript refuses it; a binding a stage dropped is still declared, and the way back is `x = …`.

### Scope and resolution

Every name lives in the Env's `Scope` ([src/compiler/emit/env.ts](../../src/compiler/emit/env.ts), [src/compiler/emit/names.ts](../../src/compiler/emit/names.ts)); a callback body's Env is made from its parent's, so a body inherits every binding and a callback parameter shadows a `let` of the same name inside the body only. A binding's `ref` says what a read becomes: a `field` slot is a path (`"$__jsmql.var.x"`, or a `let`-captured `$$` variable inside a `$lookup` body), a `var` is a `$$` variable (a callback parameter), a `constant` is its value, a `function` is inlined at the call, a `streamHandle` is the callback's third parameter (the inner stream), and a `dropped` binding carries the refusal a read of it raises. An unknown name is refused with the nearest declared one.

### Stages that replace the document

`afterStages` reads each emitted stage's row: a stage whose `replacesDocument` fact is true (`$group`, `$bucket`, `$bucketAuto`, `$replaceRoot`, `$replaceWith`, …) — or `$project` in INCLUSION mode (every value `1` / `true`, `_id: 0` aside) — takes every field-carried binding and the scratch namespace with it. A later read is refused precisely:

```
let x = $.a; $group({ _id: null }); $.y = x
// ✗ `x` is a `let` binding and can't be read after `$group` — that stage replaced the document
//   that carried it. Assign it again after the stage (`x = …`), or carry the value as a field of the new document.
```

`$project({ b: 0 })` (exclusion) and `$project({ x: $.y + 1 })` (expression mode) leave the rest of the document, `__jsmql` included, so the bindings survive them.

### Blocks and sub-pipelines

A block over the SAME documents — a `$facet` branch, a top-level callback — shares their fields: the outer bindings are visible there (`let x = $.a; $ = { f: $$.filter(d => d.n > x) }` reads `"$__jsmql.var.x"` inside the branch), and a shadowing `let` is refused, because it would write the outer binding's slot. A body over ANOTHER collection — a `$lookup` — has documents of its own: an outer binding read there is carried through the stage's `let` as `jsmql_v<level>_<name>` and read as a `$$` variable, and the body shadows freely. A `$unionWith` body has no `let`, so an outer read there is refused with the join form that carries the value.

### Cleanup

The chain appends one `{ $unset: "__jsmql" }` when it closes with the namespace still on the documents (`Chain.dirty`): a `let` slot, a join's scratch slot and the stream count share the namespace and the one cleanup. A stage that replaced the document clears the flag, so nothing is unset that is already gone; a program whose `let`s were all folded emits no trace of the machinery.

## Output stability

Pipelines with no `let` declarations carry **no trace** of the binding
machinery. The `__jsmql` field name and the trailing `$unset` only
appear when at least one `let` is in scope at some point during lowering — or
at least one `$$$.<coll>.find/filter(...)` chained terminal materialises into
an internal `__jsmql.tmp.<N>` slot (see [`lookup-stage.md`](./lookup-stage.md)).
The two features share the `__jsmql` namespace and the single trailing `$unset`
cleanup, so a pipeline that uses both still emits exactly one `$unset` stage at
the end.

## Lookup as a `let` RHS

`let os = $$$.c.filter(p);` uses the binding's own slot as the `$lookup`'s `as` — one stage, no `$set` — and types the binding as the array (`.filter`, `.aggregate`) or the document (`.find`) the chain yields. A chain that goes on (`let n = $$$.c.filter(p).length`, `let s = $$$.tx.filter(p).reduce(fn, init)`) is a VALUE: the `$lookup` is hoisted into a scratch slot ahead of the `let`, and the slot holds the rest of the chain as a value — see [lookup-stage.md § The join road](lookup-stage.md). `const` refuses reassignment on both routes.

## Deferred

- **`$let`-as-optimisation.** When a let is read in exactly one downstream
  expression and no reshape stage intervenes, the compiler could emit a
  single MongoDB `$let` wrapping that expression instead of `$addFields`/
  `$unset`. Worthwhile for index-preserving `$match`es; not done.
- **Index-pitfall warning [DEF-012].** A `let` before an indexable `$match` blocks the
  match from using the index. The compiler could surface a warning through
  `validate()`, but that requires a warning channel which doesn't exist yet.
  Documented in `LANGUAGE.md` instead.

## Outer lets inside sub-pipelines

Stated under [Blocks and sub-pipelines](#blocks-and-sub-pipelines): a `$facet` branch reads the outer binding's field, a `$lookup` body reads it through the stage's `let`, a `$unionWith` body cannot read it.

## Tests

[test/compiler-statement.test.ts](../../test/compiler-statement.test.ts) covers the binding, reassignment, the fold of a constant `let`, the reads a replacing stage refuses, shadowing, and the cleanup; [test/compiler-join.test.ts](../../test/compiler-join.test.ts) covers a `let` as a `$lookup` slot and the `let` capture inside a body; [test/compiler-env.test.ts](../../test/compiler-env.test.ts) covers the Env's scope rules. Every pipeline they assert on runs on `mongod`.

[test/realistic.test.ts](../../test/realistic.test.ts) carries the canonical
order-pricing example under `pipeline: order pricing with let bindings +
commentary`, which doubles as the playground example via the post-edit hook.
