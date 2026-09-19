# docs/ — documentation notes

## Two audiences, two file trees

| Path | Audience | Update when |
|---|---|---|
| `docs/LANG_RULES.md` | Anyone changing the language | A language axiom changes. The HARD RULES (HR1–HR4) outrank every other document here. A change to them is a language design decision, not a doc edit. |
| `docs/LANGUAGE.md` | Users of jsmql | The user-visible behaviour changes |
| `docs/DEVLOG.md` | Future-self / contributors asking "why?" | Every observable change — feature, refactor, naming, doc decision |
| `docs/DEFERRED.md` | Anyone wanting "what's left to do?" / "what did we decide against?" | You add a "not yet supported" throw, you ship a deferred item, or you record a "won't implement" decision. See § Maintain docs/DEFERRED.md in the root `CLAUDE.md`. |
| `docs/specs/*.md` | Claude / contributors implementing jsmql | The code structure or the internal behaviour changes |
| `docs/STE.md` | Anyone who writes prose here | This is the ASD-STE100 digest. It gives the rules, the banned-word table, the Technical Name exemption, and the official links. The short form that binds every session is in § Write in Simplified Technical English in the root `CLAUDE.md`. |

Do not put implementation detail in `LANGUAGE.md`. Do not put user-facing examples in the specs. Each spec is the **single source of truth** for its own feature's internals. See § "Single source of truth" in the root `CLAUDE.md`. The table below is an **index**. It gives one short scope phrase per spec, not another copy of its contents.

`DEVLOG.md` is the single historical record. There is no separate CHANGELOG file and no separate ROADMAP file. The newest entries stay on top. See the file's own header for the format. The [`devlog`](../.claude/skills/devlog/SKILL.md) project skill holds that format and the `merge-devlog.mjs` conflict resolver.

## docs/LANGUAGE.md

This is the canonical user-facing reference. It must stay in sync with `src/index.ts` and with the behaviour of `jsmql()`, `jsmql.compile()`, and `jsmql.validate()`. Each of these is polymorphic over the three call shapes: string, arrow, and template tag.

A new operator or syntax feature lands as a row in the registry. You update the LANGUAGE.md table row or example in the same commit. The drift tests enforce this recipe; it is in § Adding a new MongoDB operator in the root `CLAUDE.md`. `scripts/check-doc-claims.mjs` re-derives every `<jsmql>  // → <MQL>` pair here from the compiler. Run it after a shape change.

## docs/specs/

### Current spec files

| File | Scope (one line — the spec itself gives the detail) |
|---|---|
| `specs/architecture.md` | The five phases over the registry, from start to end, and the owner of each construct |
| `specs/desugar-pass.md` | Sugar → explicit nodes before lowering runs. The precedence between overlapping forms matters here. |
| `specs/position-pass.md` | The seven positions: the source of each one, how a stage row lays out its body, and why an accumulator slot takes one operand |
| `specs/emit-pass.md` | The emit phase's value and filter targets: the reading order, the receiver proof and runtime dispatch, operand shapes, the checks, the query cells and the per-branch `$or` |
| `specs/grammar.md` | The formal grammar (EBNF) that the parser in `src/compiler/parse/` accepts |
| `specs/operator-registry.md` | The registry of operator shapes: how it works, and how to add or change an entry |
| `specs/aggregation-stages.md` | Pipeline-stage authoring through `jsmql()`: detection, lowering, sub-pipeline recursion, the `$match` body rule |
| `specs/filter-mode.md` | No-semicolon top-level dispatch: a bare expression → a Filter document |
| `specs/update-filter.md` | Assignment and `delete` statements → `$set` / `$unset` stages |
| `specs/let-bindings.md` | Pipeline-scoped local variables (`let x = …`) → runtime `$set` binding |
| `specs/reusable-functions.md` | Reusable named functions (`const f = (a) => …`) → an inline IIFE or `$let` per call |
| `specs/function-form-params.md` | `jsmql.compile(fn)` parameter bindings: the two-slot `(params, { $, … })` arrow signature |
| `specs/bson-types.md` | The `bson` peer dependency contract, the difference between construction and recognition, and where each phase touches a live BSON value |
| `specs/globals-generation.md` | How `src/globals.ts` (`@koresar/jsmql/globals`) is generated, and its drift test |
| `specs/strict-shape-entries.md` | `jsmql.filter` / `jsmql.pipeline` / `jsmql.update`: strict-shape dispatch and the update whitelist |
| `specs/mongoose-plugin.md` | The `@koresar/jsmql/mongoose` plugin |
| `specs/context-references.md` | The `$$` / `$$$` / `$$$$` context-ref prefixes (collection / database / cluster) |
| `specs/lookup-stage.md` | `$$$.<coll>.find/.filter(pred)` → `$lookup` |
| `specs/union-stage.md` | `$$.push(args…)` → `$unionWith` |
| `specs/replace-root-stage.md` | `$ = <expr>` → `$replaceWith` / `$facet`. This spec hosts the convention: all root-replacing sugar starts with `$ =`. |
| `specs/replace-stream-stage.md` | `$$ = <expr>` → `$match` (narrow) / `$match`+`$unionWith` (source switch) |
| `specs/out-stage.md` | writing a collection: `$$$.<coll> = …` → `$out`, `+= ` / `.concat(…)` / `.push(…)` → `$merge` |
| `specs/system-stages.md` | `$$.indexStats()` / `$$$$.currentOp(…)` / … → diagnostic / system source stages |
| `specs/stream-methods.md` | The chainable array-shaped methods a stream chain (`$$.<method>(…)`) accepts, and the `.reduce` wrap forms |
| `specs/assert.md` | `assert(condition[, message])` → conditional-error `$match` guard (`$convert` "Unknown type name") |
| `specs/stream-length.md` | `$$.length` → a stream-cardinality value, made by a lazily-materialised `$setWindowFields` `$count` (`__jsmql.length`) |
| `specs/mql-stringify.md` | `jsmql.stringify` — a compiled document as the JavaScript that rebuilds it: the BSON spellings, the keys, the fit-or-break layout |
| `specs/cli.md` | The `jsmql` command-line bin (`src/cli.ts` → `dist/cjs/cli.cjs`) |
| `specs/site.md` | The published site at jsmql.js.org: what GitHub Pages serves, the Jekyll passthrough rule, and the JS.ORG subdomain binding |

The items that are still open live in [docs/DEFERRED.md](DEFERRED.md). That file is their single source of truth. Add a spec file when the work begins.

### When to update specs

- `architecture.md` — when you add a new pipeline stage or a new module
- `grammar.md` — when the syntax that the parser accepts changes (a new construct or a changed rule)
- `operator-registry.md` — when you add a new operator, a shape changes, or the lookup logic of the registry changes

### Adding a new spec file

Create `docs/specs/<topic>.md`. Add a row to the table above. Add a link in the file map of the root `CLAUDE.md` if the spec is important enough to show there.
