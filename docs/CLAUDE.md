# docs/ — documentation notes

## Two audiences, two file trees

| Path | Audience | Update when |
|---|---|---|
| `docs/LANGUAGE.md` | Users of jsmql | User-visible behaviour changes |
| `docs/DEVLOG.md` | Future-self / contributors asking "why?" | Every observable change — feature, refactor, naming, doc decision |
| `docs/DEFERRED.md` | Anyone wanting "what's left to do?" / "what did we decide against?" | Adding a new "not yet supported" throw, shipping a deferred item, or recording a "won't implement" decision. See root `CLAUDE.md` § Maintain docs/DEFERRED.md. |
| `docs/specs/*.md` | Claude / contributors implementing jsmql | Code structure or internal behaviour changes |

Never put implementation detail in `LANGUAGE.md`. Never put user-facing examples in the specs. Each spec is the **single source of truth** for its feature's internals (see root `CLAUDE.md` § "Single source of truth"); the table below is an **index** — one short scope phrase per spec, not a second copy of its contents.

`DEVLOG.md` is the single historical record — there is no separate CHANGELOG or ROADMAP. Newest entries on top. See the file's own header for the format. The [`devlog`](../.claude/skills/devlog/SKILL.md) project skill captures that format and the `merge-devlog.mjs` conflict resolver.

## docs/LANGUAGE.md

The canonical user-facing reference. It must stay in sync with `src/index.ts` and the behaviour of `jsmql()`, `jsmql.compile()`, and `jsmql.validate()` (each polymorphic over the three call shapes — string, arrow, template tag).

When you add a new operator or syntax feature, add a table row or code example here first (docs-driven), then implement it.

## docs/specs/

### Current spec files

| File | Scope (one line — the spec itself is the detail) |
|---|---|
| `specs/architecture.md` | End-to-end pipeline, data flow, module responsibilities |
| `specs/grammar.md` | Formal grammar (EBNF) for the parser |
| `specs/operator-registry.md` | Operator-shape registry: how it works, how to add/modify entries |
| `specs/method-dispatch.md` | `.foo()` method-call dispatch, lambda scoping, regex/template/optional-chaining lexing |
| `specs/aggregation-stages.md` | Pipeline-stage authoring through `jsmql()`: detection, lowering, sub-pipeline recursion, the `$match` body rule |
| `specs/pipeline-validation.md` | Compile-time validation: structural stage placement + per-stage body shape + `$match` operator placement |
| `specs/operator-validation.md` | Compile-time validation of `$op(...)` arguments: arity, object required/unknown keys, enums, literal types (the value-position mirror of pipeline-validation) |
| `specs/filter-mode.md` | No-semicolon top-level dispatch: a bare expression → a Filter document |
| `specs/match-query-translation.md` | The `$match`/Filter expression-body → query-language translator |
| `specs/update-filter.md` | Assignment + `delete` statements → `$set` / `$unset` stages |
| `specs/let-bindings.md` | Pipeline-scoped local variables (`let x = …`) |
| `specs/reusable-functions.md` | Reusable named functions (`const f = (a) => …`) → inline IIFE/`$let` per call |
| `specs/function-form-params.md` | `jsmql.compile(fn)` parameter bindings: the three-slot arrow signature |
| `specs/ops-generation.md` | How `src/ops.ts` (`@koresar/jsmql/ops`) is generated + its drift test |
| `specs/strict-shape-entries.md` | `jsmql.filter` / `jsmql.pipeline` / `jsmql.update`: strict-shape dispatch + the update whitelist |
| `specs/mongoose-plugin.md` | The `@koresar/jsmql/mongoose` plugin |
| `specs/context-references.md` | The `$$` / `$$$` / `$$$$` context-ref prefixes (collection / database / cluster) |
| `specs/lookup-stage.md` | `$$$.<coll>.find/.filter(pred)` → `$lookup` |
| `specs/union-stage.md` | `$$.push(args…)` → `$unionWith` |
| `specs/replace-root-stage.md` | `$ = <expr>` → `$replaceWith` / `$facet`; hosts the "all root-replacing sugar starts with `$ =`" convention |
| `specs/replace-stream-stage.md` | `$$ = <expr>` → `$match` (narrow) / `$match`+`$unionWith` (source switch) |
| `specs/out-stage.md` | `$$$.<coll> = …` / `$$$$.<db>.<coll> = …` → `$out` |
| `specs/system-stages.md` | `$$.indexStats()` / `$$$$.currentOp(…)` / … → diagnostic / system source stages |
| `specs/stream-methods.md` | Registry of chainable array-shaped methods on a `$$ = …` RHS, plus the `.reduce` wrap forms |
| `specs/assert.md` | `assert(condition[, message])` → conditional-error `$match` guard (`$convert` "Unknown type name") |
| `specs/stream-length.md` | `$$.length` → stream-cardinality value via lazily-materialised `$setWindowFields` `$count` (`__jsmql.length`) |
| `specs/cli.md` | The `jsmql` command-line bin (`src/cli.ts` → `dist/cjs/cli.cjs`) |

Items still on the roadmap live in [docs/DEFERRED.md](DEFERRED.md) — that file is their single source of truth. Add a spec file when the work begins.

### When to update specs

- `architecture.md` — when new pipeline stages or modules are added
- `grammar.md` — when the parser's accepted syntax changes (new constructs, changed rules)
- `operator-registry.md` — when a new operator is added, a shape changes, or the registry lookup logic changes

### Adding a new spec file

Create `docs/specs/<topic>.md` and add a row to the table above. Add a link in the root `CLAUDE.md` file map if it is important enough to surface there.
