# docs/ — documentation notes

## Two audiences, two file trees

| Path | Audience | Update when |
|---|---|---|
| `docs/LANGUAGE.md` | Users of mjsql | User-visible behaviour changes |
| `docs/DEVLOG.md` | Future-self / contributors asking "why?" | Every observable change — feature, refactor, naming, doc decision |
| `docs/specs/*.md` | Claude / contributors implementing mjsql | Code structure or internal behaviour changes |

Never put implementation detail in `LANGUAGE.md`. Never put user-facing examples in the specs.

`DEVLOG.md` is the single historical record — there is no separate CHANGELOG or ROADMAP. Newest entries on top. See the file's own header for the format.

## docs/LANGUAGE.md

The canonical user-facing reference. It must stay in sync with `src/index.ts` exports and the behaviour of `mjsql()`, `validate()`, and `mql`.

When you add a new operator or syntax feature, add a table row or code example here first (docs-driven), then implement it.

## docs/specs/

### Current spec files

| File | Covers |
|---|---|
| `specs/architecture.md` | End-to-end pipeline, data flow, module responsibilities |
| `specs/grammar.md` | Formal grammar (EBNF) for the parser |
| `specs/operator-registry.md` | How operator shapes work, how to add/modify entries |
| `specs/method-dispatch.md` | Method call dispatch, lambda scoping, `asFieldPath()`, `$reduce` remap, regex lexing, template literals, optional chaining, computed keys, spread args |
| `specs/query-predicates.md` | (Stub) Future support for query-predicate operators inside `$match` / `find()`. |
| `specs/projection.md` | (Stub) Future support for projection operators (`$`, `$elemMatch`, `$slice`, `$meta`). |
| `specs/accumulators.md` | (Stub) Future stage-spec integration for `$group` / `$setWindowFields` accumulators. |
| `specs/update.md` | (Stub) Future support for update operators (`$set`, `$inc`, `$push`, …). |
| `specs/aggregation-stages.md` | Pipeline-stage authoring through `mjsql()`: detection, lowering, sub-pipeline recursion, the `$match` `$expr`-wrap rule. |

### When to update specs

- `architecture.md` — when new pipeline stages or modules are added
- `grammar.md` — when the parser's accepted syntax changes (new constructs, changed rules)
- `operator-registry.md` — when a new operator is added, a shape changes, or the registry lookup logic changes

### Adding a new spec file

Create `docs/specs/<topic>.md` and add a row to the table above. Add a link in the root `CLAUDE.md` file map if it is important enough to surface there.
