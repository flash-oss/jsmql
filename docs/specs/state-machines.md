# State machines

This spec lists each place where JSMQL keeps state that changes over time. For each one it gives
the state, the invariants, and the transitions. Some state machines are explicit: a class with
fields and methods that change them, for example `Chain`. Others are implicit: a few variables
that change together, for example the lexer's loop or the playground's session.

Each invariant names the guard that holds it and the test that checks the guard. The spec of each
feature holds the lowering rules. This file links to them and does not copy them.

The compiler is synchronous, and it keeps no state between two calls. So "concurrency" here
means three things. The first is re-entry: user code, for example a `toBSON()`, calls an entry
inside another entry. The second is repetition: one `jsmql.compile` builder runs many times. The
third is interleaving: two browser events, or two tabs, change one page session.

## The lexer

`lex()` in [src/compiler/lex/lexer.ts](../../src/compiler/lex/lexer.ts) is a loop over the source.
Its state is local to one call.

| Variable | Meaning |
|---|---|
| `last` | The type of the last token that the lexer pushed, or null at the start |
| `braceDepth` | How many `{` are open outside a template text |
| `templateDepths` | A stack: one entry for each open `${`, with the `braceDepth` at which it opened |

States: **code** (scan tokens) and **template text** (`templateChunk` reads the text of a template
literal up to its next boundary).

| Event | From | To | Effect |
|---|---|---|---|
| `` ` `` | code | template text | push `TemplateStart` |
| `${` in the text | template text | code | push `braceDepth` on `templateDepths` |
| `` ` `` in the text | template text | code | push `TemplateEnd` |
| `{` | code | code | `braceDepth + 1` |
| `}` while the top of `templateDepths` equals `braceDepth` | code | template text | pop `templateDepths` |
| any other `}` | code | code | `braceDepth - 1` |
| `/` after a token in `ENDS_A_VALUE` | code | code | a division token |
| `/` after any other token, or at the start | code | code | a regex literal (`chooseBy` in [src/registry/tokens.ts](../../src/registry/tokens.ts)) |
| a reserved word after a token that `introducesName` | code | code | a plain name (`$.typeof`) |

Invariants:

- **L1.** At the end of the source, `templateDepths` is empty, or the lexer throws a positioned
  `LexError`.
- **L2.** A `}` closes the interpolation that opened at its own depth only. So an object literal
  inside `${ … }` keeps its braces.
- **L3.** The choice between `/` and a regex reads only `last`. `TemplateEnd`, `)` and `]` end a
  value, so `` `a` / 2 `` and `[1][0] / 2` are divisions.

[test/compiler-parse.test.ts](../../test/compiler-parse.test.ts) holds L1, L2 and L3.

## An entry, and a compile builder

[src/index.ts](../../src/index.ts) holds the entries. A one-shot entry (`jsmql(…)`, `jsmql.expr(…)`, …)
parses, lowers and returns. It keeps nothing.

`jsmql.compile(fn)` (and each strict `.compile`) parses ONCE and returns a builder:

| Event | From | To | Effect |
|---|---|---|---|
| `compile(input)` | — | **built** | lex and parse once; the parsed tree and the parameter list stay in the closure |
| `builder(params)` | built | built | check each key, walk each value (`driverValue`), then `lowerMode` |
| a throw inside `builder(params)` | built | built | the error leaves; the builder stays usable |

`lowerMode` writes one thing on the shared tree: `rawMqlBoundary` sets `text` on a `"$…"`
string that JSMQL reads as text. The mark depends on the tree only, never on a value, and the
pass never clears it. Every other pass builds a new tree.

Invariants:

- **E1.** A builder's answer depends on the source and the parameters of THIS call only. The order
  of earlier calls, and a throw in an earlier call, change nothing.
- **E2.** A caller that changes an answer in place (mongoose casts a filter in place) changes no
  later answer. Each call builds a new document.
- **E3.** `.pos` counts from the first character of the string the caller passed, in every entry
  and in `validate()`. `jsmql.compile` therefore keeps a blank lead.
- **E4.** `driverValue` refuses a value that the driver changes into another value. One
  example is an Invalid Date, which the driver sends as the epoch. See
  [function-form-params.md](function-form-params.md#the-value-the-driver-sends).

[test/strict-api.test.ts](../../test/strict-api.test.ts) holds E1 and E2. It calls one builder in
two orders, and compares each answer with the answer of a new builder.
[test/error-pos.test.ts](../../test/error-pos.test.ts) holds E3,
and [test/security.test.ts](../../test/security.test.ts) holds E4.

### The frame of an error

An error that leaves an entry carries a frame: the line, the column, the source line and a caret
(`framed()` in `index.ts`).

| Event | From | To |
|---|---|---|
| a phase throws | **raw** | raw |
| the error leaves through `framed()` | raw | **framed** (`FRAMED` holds it) |
| the error leaves through an outer `framed()` | framed | framed |
| the CLI prints it | framed | printed as it is |

- **F1.** An error has one frame, from the entry that threw it. An entry can run inside another:
  a parameter's `toBSON()` can call `jsmql`. Its `.pos` is a position in the inner source, so
  only the inner entry frames it.
- **F2.** The CLI prints the message and adds no second frame. See [cli.md](cli.md#error-rendering).

[test/error-pos.test.ts](../../test/error-pos.test.ts) holds F1, and
[test/cli.test.ts](../../test/cli.test.ts) holds F2.

## The pipeline chain

`Chain` in [src/compiler/emit/env.ts](../../src/compiler/emit/env.ts) is the pipeline under
assembly. Each `Env` holds its chain by reference. A sub-pipeline (a `$lookup` body, a `$facet`
branch) has a chain of its own.

| Field | Meaning |
|---|---|
| `emitted` | The stages placed so far |
| `hoisted` | The stages a value placed ahead of the stage it stands in; `ahead()` and `flush()` drain them |
| `dirty` | A field under `__jsmql` may be on the documents. `wrote` counts each change from false to true |
| `terminal` | The `$out` or `$merge` stage, filed so that it stays last |
| `element` | Where the stream's element lives: `""` for the document, or an unwound field |
| `stamped` | The stream counts that a later read can reuse |
| `slots` | The next scratch slot number |
| `bareReads`, `clearRoot` | The whole-document reads that took the bare `$$ROOT`, and the switch that clears them |
| `source` | For a branch over the same documents, the chain those documents come from |

| Event | Guard | Effect |
|---|---|---|
| `slot()` | — | `dirty = true`; the next slot number |
| `hoist(stages, reads)` | `reads` is not stamped | the stages go into `hoisted`; `dirty = true` |
| a `let` lands | — | one `$set` under `__jsmql.var`; `dirty = true` |
| a stage lands (`afterStages`) | the stage does not keep `preservesCount` | `stamped` empties |
| a stage that replaces the document lands | — | `element = ""`; `dirty = false`, except when the stage keeps a bare `$$ROOT` (`keepsRoot`) |
| `$out` or `$merge` is filed | `terminal` is null | `terminal` holds it |
| a statement after a filed terminal | — | refused (`afterTerminalStage`) |
| `wholeDocument()` | `dirty` or a `clearRoot` on this chain or a `source` | the namespace-free document; else `"$$ROOT"`, and `bareReads + 1` on each chain it reads |
| `enter()` a branch over the same documents | — | the branch's `dirty` starts as the outer one; `source` is the outer chain |
| `mark()` / `rewind()` | — | `rewind` puts back `hoisted`, `stamped`, `slots`, `dirty`, `wrote`, `element`, `terminal` and `bareReads` |
| `close()` | — | `flush()`; then the stages, `{ $unset: "__jsmql" }` when `dirty`, and the terminal |

A statement lowers inside `clearOfNamespace` (in
[src/compiler/emit/statement.ts](../../src/compiler/emit/statement.ts)). Two things can be true
together: the statement read the whole document bare, and a stage ahead of that read wrote under
`__jsmql`. Then the statement goes back to its mark. It lowers again with `clearRoot` true.

Invariants:

- **C1.** No document that a pipeline gives back holds a field under `__jsmql`, at any depth. The
  trailing `$unset` removes the top-level field. A read of the whole document leaves the namespace
  out of every copy. See [let-bindings.md](let-bindings.md#the-whole-document-as-a-value).
- **C2.** Nothing follows the terminal stage. The cleanup comes before it.
- **C3.** `close()` drains `hoisted`, so it keeps each hoisted stage.
- **C4.** One lowering gives one output. A lowering that the compiler takes back (`rewind`) leaves
  no hoist, stamp, slot number, flag or terminal behind.
- **C5.** The compiler never changes MQL that the developer wrote (HR1). So a raw stage that keeps
  `$$ROOT` keeps the cleanup. See below for the one place where raw MQL can still carry the
  namespace.

[test/compiler-statement.test.ts](../../test/compiler-statement.test.ts) holds C1 and C5: the MQL
of each shape, and a live run that looks for `__jsmql` at every depth.
[test/permutations.test.ts](../../test/permutations.test.ts) checks C1 for every chain it runs.

### What raw MQL can still reach

HR1 keeps a raw `"$$ROOT"` as written. So a raw stage that puts the document inside a value keeps
the namespace there, and no cleanup reaches it:

```js
let t = $.a + 1; $group({ _id: null, all: { $push: "$$ROOT" } });
// → [{ $set: { "__jsmql.var.t": { $add: ["$a", 1] } } },
//    { $group: { _id: null, all: { $push: "$$ROOT" } } },
//    { $unset: "__jsmql" }]
// each element of `all` holds __jsmql.var.t; the $unset reaches the top level only
```

The JSMQL spelling `$push($)` reads the document through its chain, and gives no namespace.

## The mongoose plugin

`jsmqlMongoose(mongoose)` in [src/mongoose.ts](../../src/mongoose.ts) has two states on
`mongoose.Model`: **unpatched** and **patched** (`Model.__jsmqlPatched`). Each `Mongoose` instance
shares the one `Model` class, so the flag covers all of them.

| Event | From | To |
|---|---|---|
| the first call | unpatched | patched: each static of the table in [mongoose-plugin.md](mongoose-plugin.md) wraps the original |
| any later call | patched | patched (no change) |

- **M1.** No static wraps twice. See [mongoose-plugin.md](mongoose-plugin.md#idempotence).
- **M2.** The plugin turns a value into MQL when the call happens. A query that runs twice
  (`query.exec()` twice) holds the MQL already, so nothing lowers a second time.

The plugin sets the flag before it changes the statics. An assignment to a static throws only when the class
is frozen or the static is read-only. So a normal mongoose module never reaches a patched state in
which only some statics wrap the original.

## The CLI

`parseArgs` in [src/cli.ts](../../src/cli.ts) reads the arguments from left to right.

| Event | Effect |
|---|---|
| a shape flag while the mode is `auto` | the mode becomes that shape |
| a second shape flag | a usage error that names both flags |
| `--arg` / `--argjson NAME VALUE` | the parameter map takes NAME; a second NAME replaces the first |
| a positional argument while none is set | it is the source |
| a second positional argument | a usage error |

The source comes from the positional argument, then `--file`, then stdin, in that order. See
[cli.md](cli.md).

## The playground

[playground_skeleton.html](../../playground_skeleton.html) holds the page's script. It keeps its state
in module variables, the URL hash and `localStorage`.

### The example on screen

| Variable | Meaning |
|---|---|
| `activeSlug` | The example the editor holds unchanged, or null |
| `loadingFromList` | True while `selectExample` writes the example into the editor |

| Event | From | To |
|---|---|---|
| a click on an item, ↑/↓, a `#slug` hash | any | the example; hash `#slug` |
| an edit that makes the text differ from the example | the example | none; the hash goes |
| a `#s=` share link | any | none, unless its text is an example |

- **P1.** `activeSlug` is not null exactly when the editor holds that example's text, and the hash
  names it. `selectExample` resets `loadingFromList` in a `finally`. So a throw from the `change`
  handler of the editor cannot keep the page in the loading state.
- **P2.** Another example's output starts at its top. `selectExample` resets the remembered
  scroll offset (`mqlScroll`).

### The compile mode

`currentMode` is one of the entries. A click on a mode button sets it, and the session saves it.
`selectExample` sets the mode that the example's own call names.

- **P3.** A click on a mode button keeps its mode, also on an empty editor. The edit that empties the
  editor sets the mode back to AUTO (the `change` handler).
- **P4.** A refresh shows the mode the session saved. When the session holds an example unchanged,
  the page opens that example and then applies the saved mode. This is true with the hash
  (rung 2) and without it (rung 2c).

### The output panel

The panel shows one of: an empty panel, an error in the Variables, an error from the compiler or
the printer, a validation error, or MQL.

- **P5.** The panel always shows the current input, Variables and mode. Every branch of `render()`
  either sets the output or shows an error. The printer (`pretty` / `compact`) runs inside the same
  `try` as the compiler, so its error shows in the panel.

### The session in storage

`saveState()` writes `{ stamp, slug, input, vars, mode }` under one key for each page URL. The start
of the page reads it through the ladder in the script. The ladder tries these in order: a share
link, a `#slug` hash, a superseded example, an unchanged example, a saved query, the first example.

- **P6.** `slug` is not null only while the editor holds that example unchanged.
  `staleExampleSession` reads it to replace a superseded example.
- Two tabs of one page share the key. The session of the last tab that saves replaces the other. The page has no `storage`
  listener, so an open tab does not see the other tab's work until it reloads.

## The landing page

[index.html](../../index.html) compiles each example in the browser.

| Event | Effect |
|---|---|
| the script starts | each "Open in playground" link gets its `#s=` payload |
| the import of `dist/jsmql.js` succeeds | each output goes from "compiling…" to its MQL, or to its error |
| the import fails | the notice shows, and each output says that it has no MQL |

- **S1.** A link opens the example it names, also before the bundle loads.
- **S2.** No output stays "compiling…" after the import fails.

The browser checks of P2 to P5, S1 and S2 are manual: the suites do not run a browser.
[test/site.test.ts](../../test/site.test.ts) compiles every landing-page example.
