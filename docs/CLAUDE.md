# docs/ — documentation notes

## Two audiences, two file trees

| Path | Audience | Update when |
|---|---|---|
| `docs/LANGUAGE.md` | Users of mjsql | User-visible behaviour changes |
| `docs/specs/*.md` | Claude / contributors implementing mjsql | Code structure or internal behaviour changes |

Never put implementation detail in `LANGUAGE.md`. Never put user-facing examples in the specs.

## docs/LANGUAGE.md

The canonical user-facing reference. It must stay in sync with `src/index.ts` exports and the behaviour of `mjsql()`, `validate()`, and `mql`.

When you add a new operator or syntax feature, add a table row or code example here first (docs-driven), then implement it.

## docs/specs/

### Current spec files

| File | Covers |
|---|---|
| `specs/architecture.md` | End-to-end pipeline, data flow, module responsibilities |
| `specs/grammar.md` | Formal grammar (EBNF) — current at v4 |
| `specs/operator-registry.md` | How operator shapes work, how to add/modify entries |
| `specs/v3-method-dispatch.md` | Method call dispatch, lambda scoping, `asFieldPath()`, `$reduce` remap, regex lexing, template literals, optional chaining, computed keys, spread args |

### When to update specs

- `architecture.md` — when new pipeline stages or modules are added
- `grammar.md` — when the parser's accepted syntax changes (new constructs, changed rules)
- `operator-registry.md` — when a new operator is added, a shape changes, or the registry lookup logic changes

### Adding a new spec file

Create `docs/specs/<topic>.md` and add a row to the table above. Add a link in the root `CLAUDE.md` file map if it is important enough to surface there.
