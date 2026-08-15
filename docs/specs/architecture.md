# Architecture

## Overview

jsmql is a transpiler. It reads a JavaScript subset and writes MQL JSON.

The front end is one straight line: source text → tokens → AST. The back end is
a grid. MongoDB accepts three unrelated languages inside one document, and a
jsmql construct usually has a meaning in more than one of them. The grid is how
a feature declares its meaning in each.

This file owns the end-to-end flow, the pass order, and the module map. Each
feature's own lowering rules live in its spec — see [docs/CLAUDE.md](../CLAUDE.md)
for the index.

## The three target languages

| Target | MQL shape | Reached from |
|---|---|---|
| **Query** | `{ age: { $gt: 18 } }` | a Filter, a `$match` body, `$elemMatch`, a `$lookup` predicate |
| **Expr** | `{ $gt: ["$age", 18] }` | any value position — a stage body, `jsmql.expr`, an operator argument |
| **Stage** | `[{ $match: … }]` | a statement position — a pipeline element |

The target is **not** a value threaded through lowering. It follows from
position, and position decides which lowering entry point runs. A predicate
reaches the Predicate IR; a value reaches the expression emitter; a statement
reaches the stage assembler. Nothing has to remember to pass the target down,
so nothing can drop it.

Update ops are the Stage target restricted to `$set` / `$unset`, plus a
bare-document variant for `updateOne`. See [update-filter.md](update-filter.md).

## The two receiver kinds

A method's receiver is either a **Value** (an array, string, number, object or
date inside a document) or the **Stream** (the pipeline's sequence of
documents). One method name, one meaning, two receivers:

```
$.items.filter(x => x.a > 1)   Value  → { $filter: { input: "$items", as: "x", cond: … } }
$$ = $$.filter(d => d.a > 1);  Stream → [{ $match: { a: { $gt: 1 } } }]
```

The receiver is a dispatch parameter, resolved once from the receiver
expression at the method-dispatch site.

## Pipeline

```
jsmql(string | Function | TemplateStringsArray + values)
    │
    ▼
Input dispatcher (src/index.ts)
    Normalises the three call shapes to a source string plus bindings.
      - TemplateStringsArray: joins strings with JSON-stringified values
        (per-slot validation in stringifyInterpolation()). Opaque BSON values
        route through a synthesized binding instead of source text.
      - Function: Function.prototype.toString(), rejects non-arrow / async /
        generator shapes, strips the parameter list at the first `=>`.
      - String: used as-is.
      - Anything else: TypeError naming the three accepted shapes.
    │
    ▼
Lexer (src/lexer.ts)  →  Token[]
    Single-pass character scanner. No meaning, no structure.
    │
    ▼
Parser (src/parser.ts)  →  AST
    Recursive descent. No MQL knowledge and no operator lookup.
    Decides Filter vs Pipeline: any top-level `;` produces a Pipeline node.
    Every node carries `pos` — the offset of its leading token.
    │
    ▼
┌─ PASSES ─────────────────────────────────────────────────────────────────┐
│                                                                          │
│  1. Constant fold   (src/const-fold.ts, src/const-eval.ts)               │
│     Folds `const` / `let` whose value is known at compile time and       │
│     inlines it. May collapse a Pipeline back to a single expression.     │
│     See const-folding.md.                                                │
│                                                                          │
│  2. Desugar         (src/desugar.ts)                                     │
│     Rewrites every sugar form into an explicit node. After this pass no  │
│     sugar remains, so no downstream loop can fail to recognise one.      │
│     See desugar-pass.md.                                                 │
│                                                                          │
│  3. Validate        (src/validate.ts)                                    │
│     Walks the tree and COLLECTS errors rather than throwing at the       │
│     first. Literal-gated: it inspects fully-static shapes only, so it    │
│     rejects certain violations and stays silent wherever an expression   │
│     fills the slot. This is what lets `.validate()` return more than     │
│     one error. See pipeline-validation.md and operator-validation.md.    │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
    │
    ▼
Lowering — one entry point per target
    │
    ├──▶ Stage   (src/pipeline.ts)      → an array of stage documents
    │       Stage bodies recurse into Expr; sub-pipeline slots recurse
    │       into Stage. See aggregation-stages.md.
    │
    ├──▶ Query   (src/predicate-ir.ts + the query backend)
    │       A predicate lowers to the Predicate IR, then to query form. An
    │       IR node with no query rule falls back to `{ $expr: <Expr> }` by
    │       construction, so a missing query rule is never a wrong answer.
    │       See predicate-ir.md.
    │
    └──▶ Expr    (src/codegen.ts)       → one aggregation expression
    │
    ▼
MQL JSON
```

Scope and generated variable names are services the lowering consults, not
passes. Scope travels in one object, copied whole; a deliberate drop is written
as an explicit `undefined` with a `// why` note. Generated names come from
`internalVar(ctx, base)`, never a string literal — see
[src/CLAUDE.md](../../src/CLAUDE.md).

## The grid

Every feature is one declaration. It states its receiver family, its return
type, its argument rule, and its lowering for each cell it supports.

```ts
take: {
  receiver: "array",
  returns:  "array",
  args:     { sig: "n", exact: 1, type: "int>=0" },
  value:    (recv, [n]) => ({ $slice: [recv, n] }),
  stage:    ([n])       => [{ $limit: n }],
  query:    unsupported("not a predicate"),
}
```

That one declaration is the single source for the arity check, the literal type
gate, and the generated TypeScript signature — so the editor cannot disagree
with the compiler.

**Applicability is derived, and every applicable cell must be answered.** The
declared `receiver` decides which cells a feature can have: a string receiver
never has a Stage cell, because the stream is a sequence of documents. An
applicable cell holds either a lowering or `unsupported(reason)`. An unanswered
applicable cell fails the build.

This is the rule the whole design exists for. A feature added to one cell and
not to its sibling stops being invisible.

The same declaration model covers all four feature kinds — JS methods,
operators, stages, and sugar forms — over one shared argument vocabulary.
Declarations live one file per family (`methods/string.ts`, `methods/array.ts`,
…), assembled into one registry at import. See [lowering-grid.md](lowering-grid.md).

## Traversal

Every walk over the AST derives from one child-list table:

```ts
const CHILDREN: Record<Expr["type"], readonly ChildRef[]> = { … };
```

`Record<Expr["type"], …>` makes TypeScript demand an entry for every node kind,
so a new kind fails the build until its children are declared. `some`, `map` and
`fold` all read that table, so traversal shapes cannot drift apart.

## Module responsibilities

| Module | Responsibility | Must NOT |
|---|---|---|
| `lexer.ts` | Produce tokens | Know anything about operators or AST structure |
| `parser.ts` | Produce AST | Look up operators; do any MQL-specific logic |
| `ast.ts` | Define node types | Contain logic |
| `ast-walk.ts` | The child-list table and the walks built on it | Know any feature |
| `const-fold.ts` / `const-eval.ts` | The constant-fold pass | Emit MQL |
| `desugar.ts` | The desugar pass | Emit MQL |
| `validate.ts` | The validate pass | Emit MQL; throw at the first error |
| `predicate-ir.ts` | The predicate vocabulary and its two backends | Know about stages |
| `operators.ts` | Expression-operator shapes | Import from parser or codegen |
| `stages.ts` | Stage shapes and sub-pipeline fields | Import from parser, codegen, or pipeline |
| `methods/*.ts` | One declaration per JS method, grouped by family | Contain dispatch logic |
| `codegen.ts` | The Expr backend | Parse tokens; contain grammar rules; know about stages |
| `pipeline.ts` | The Stage backend | Contain expression codegen (calls into `codegen.ts`) |
| `index.ts` | The public API; route to a target entry point | Contain parser or codegen logic |

## Public API surface (`src/index.ts`)

```ts
export type JsmqlToolbox = { [K in `$${string}`]: any };
type JsmqlFn = (toolbox: JsmqlToolbox) => unknown;
type JsmqlInput = string | JsmqlFn;
// The canonical arrow form is `({ $ }) => …`: the arrow receives a single
// destructured "toolbox" object carrying the document root `$`, the context
// refs `$$` / `$$$` / `$$$$`, and every `$`-prefixed operator / stage. The
// parameter list is stripped at extraction time (jsmql parses the source; it
// never calls the arrow), so the destructure is types-only. Every key is `any`:
// `$` so unannotated `$.foo` keeps autocomplete without `noImplicitAny`, and
// each `$op` so a destructured `({ $, $dateDiff }) => …` type-checks even
// without the `@koresar/jsmql/globals` ambient import (which is where rich
// signatures come from). A bare `$` / bare identifier is not a valid
// parameter slot — the document context must be destructured.

type JsmqlOutput = object | object[];
// Single compiled MQL expression, or — for top-level aggregation pipelines —
// an array of stage objects. Pipeline-mode detection lives in src/pipeline.ts;
// see specs/aggregation-stages.md.

jsmql(input: JsmqlInput): JsmqlOutput
jsmql(strings: TemplateStringsArray, ...values: unknown[]): JsmqlOutput
// Polymorphic over three call shapes: string, arrow function, and template tag.
// The template-tag form interpolates JSON-shaped values via JSON.stringify (with
// validation — see JsmqlInterpolationError below). Opaque BSON instances
// (Date, RegExp, Uint8Array, ObjectId) bypass JSON.stringify entirely — they
// would lose fidelity (`new Date(...)` → ISO string, `RegExp` → `"{}"`, etc.) —
// and are instead routed through a synthesized `__jsmql_interp_<slot>` binding
// resolved at lower time via the same `bindings` machinery `jsmql.compile()`
// uses. The MQL output carries the JS instance untouched, which is what the
// Node MongoDB driver expects in-situ. Function input has its body extracted
// (toString + arrow-list strip) and is re-parsed on each call — see
// `jsmql.compile(fn)` for the parse-once-bind-many path. Throws
// LexError | ParseError | CodegenError | FunctionInputError |
// JsmqlInterpolationError | TypeError.

jsmql.compile<P>(fn: (params: P, toolbox?: JsmqlToolbox) => unknown): (params: P) => JsmqlOutput
// Parse once, bind many. The arrow's first slot is a destructure pattern naming
// the parameter bindings; the returned callable inlines fresh values from the
// params object into the AST on each call (no re-parse). Output shape matches
// the template-tag form — values appear as JSON literals, never wrapped in
// $let. See specs/function-form-params.md.

jsmql.validate<P>(fn: (params: P, toolbox?: JsmqlToolbox) => unknown): ValidationResult
jsmql.validate(input: JsmqlInput): ValidationResult
jsmql.validate(strings: TemplateStringsArray, ...values: unknown[]): ValidationResult
// Accepts every input shape jsmql() or jsmql.compile() accepts. Same parsing
// pipeline — but catches all errors and returns { valid, errors[] } instead.
// Total — never throws (see error-mapping table below). `errors` carries every
// error the validate pass collects, not only the first one reached. The
// compile-form arrow overload is listed first so IDEs contextually type
// `({ params }, { $ })` against `(params: P, toolbox: JsmqlToolbox)` rather than
// the one-shot `(toolbox: JsmqlToolbox)` shape (which would mis-type the params
// slot as the toolbox). For validation, parameter bindings resolve to null
// placeholders — values don't affect syntactic validity. The compile
// *invocation* path (`jsmql.compile(fn)(params)`) remains throw-style; there is
// intentionally no `jsmql.validate.compile` sub-namespace.
```

The entries are attached to `jsmql` via `Object.assign` (the strippable-TS rule
in [src/CLAUDE.md](../../src/CLAUDE.md) forbids `namespace` declarations).

### No implicit cache for `jsmql(fn)`

The one-shot `jsmql(fn)` path re-parses the extracted body on every call. A
bounded LRU keyed on the body string has two problems: one-shot queries (parsed
once at process startup, never re-executed) occupy slots until eviction, and a
`WeakMap` swap that would let the GC reclaim them isn't possible — `WeakMap`
requires object keys (strings are primitives) and exposes neither `.size` nor
iteration, so the cap can't be preserved.

Callers that want parse-once-bind-many use `jsmql.compile(fn)` — see
[function-form-params.md](function-form-params.md). The string-input and
template-tag paths are also uncached, for the same reason: any cache that
catches repeated calls would have to retain dynamically-built strings
indefinitely.

## Error types

All errors are classes with a `.message` string and a `.pos: number` carrying
the source offset where the error was detected. Codegen-layer errors get a real
offset because every AST node carries `pos` (populated by the parser from the
leading token of each construct); helpers thread it down to throw sites.

| Class | Module | Has pos | Notes |
|---|---|---|---|
| `LexError` | `lexer.ts` | yes | Byte offset of the failing character. |
| `ParseError` | `parser.ts` | yes | Byte offset of the offending token. |
| `CodegenError` | `codegen.ts` | yes | Forwarded from the AST node that triggered the error (parser populates `pos` at every construction site). |
| `UnknownIdentifierError` | `codegen.ts` | yes | Subclass of `CodegenError`. Carries `.identifier` so the function-input path can append a `` jsmql`…` `` template-tag hint to the message. |
| `FunctionInputError` | `index.ts` | yes | Function source isn't a supported shape (block body, async, `function` keyword, missing `=>`). Position is into the stringified arrow source. |
| `JsmqlInterpolationError` | `index.ts` | no | Raised by the template-tag form of `jsmql` (and `validate`) when an interpolated value cannot be safely embedded as a JSON literal (function/Symbol/`undefined`, NaN/±Infinity, BigInt, circular refs). Carries `.slot: number` pointing to the offending interpolation slot (and optionally `.key` for the `jsmql.compile()` path); no source offset because the template's text is split across the `strings`/`values` arrays. |
| `TypeError` | `index.ts` | no | Raised by `jsmql()`'s top-level guard when the first argument isn't a string, function, or `TemplateStringsArray` (e.g. `jsmql(42)`, `jsmql({})`). |

`validate()` maps errors as follows:

| Source | Code | `pos` |
|---|---|---|
| `LexError`, `ParseError` | `SYNTAX_ERROR` | original `.pos` |
| `CodegenError` and subclasses | `CODEGEN_ERROR` | `err.pos` (AST-node offset) |
| `FunctionInputError` | `SYNTAX_ERROR` | `err.pos` (offset in stringified arrow source) |
| `JsmqlInterpolationError` | `SYNTAX_ERROR` | `0` (use `.slot` / `.key` on the underlying error to locate the bad interpolation) |
| `RangeError`, `TypeError` | `SYNTAX_ERROR` | `0` (`RangeError` is defensive — should be unreachable now that the parser/codegen depth caps trip first; `TypeError` comes from the top-level input-shape guard) |
| anything else | `CODEGEN_ERROR` | `0` (wrapped as `internal error: …` to keep `validate()` total) |
