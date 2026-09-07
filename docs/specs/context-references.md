# Context-reference prefixes (`$$`, `$$$`, `$$$$`)

## Purpose

Four levels of jsmql doc-context prefix, one per scope:

| Prefix | Scope             | Example                  |
| ------ | ----------------- | ------------------------ |
| `$.`   | Current document  | `$.age` (existing)       |
| `$$`   | Current collection| `$$.find(…)`             |
| `$$$`  | Current database  | `$$$.myColl.find(…)`     |
| `$$$$` | Current cluster   | `$$$$.myDb.myColl.find(…)` |

The four levels give jsmql one uniform vocabulary for document / collection / database / cluster references — the surface that drives `$lookup`, `$unionWith`, `$out` and the diagnostic source stages from a syntax users already understand.

This spec covers the **syntax**: the tokens, the AST nodes and the parse. What each prefix MEANS belongs to the road that lowers it, and each road has its own spec — see [What each reference carries](#what-each-reference-carries). A prefix that reaches a position no row gives it a meaning in is refused there in that row's own words. A cross-database **read** (`$$$$.db.coll.find/filter(...)`) parses and is **rejected at compile time** — see the `$$$$` entry below.

## Lexer

[`src/compiler/lex/lexer.ts`](../../src/compiler/lex/lexer.ts) — `lex()` takes the longest token the table in [`src/registry/tokens.ts`](../../src/registry/tokens.ts) holds, so a run of `$` characters reads as one of:

| Source              | Token            |
| ------------------- | ---------------- |
| `$.` (1 `$` + `.`)  | `DollarDot`      |
| `$` (bare)          | `Dollar`         |
| `$$` (2 `$`)        | `DoubleDollar`   |
| `$$$` (3 `$`)       | `TripleDollar`   |
| `$$$$` (4 `$`)      | `QuadDollar`     |
| `$$$$$+` (5 or more)| `LexError`       |

The trailing `.` / `[` is **not** part of a prefix token — each prefix is bare, and postfix parsing reads the dot or bracket as a `Dot` / `LBracket` token that a `MemberAccess` / `IndexAccess` node wraps. `$.` is the one prefix whose dot IS baked in: `$` alone is the document handle, so the two readings are told apart at the lexeme.

The table's row keys — `'$$'`, `'$$$'`, `'$$$$'` — are the spellings the parser's messages print, so an internal token name never leaks into a user-facing string.

5+ consecutive `$` followed by anything throws:

> `Up to 4 levels of context reference are supported ('$.', '$$', '$$$', '$$$$') at position N`

## AST

[`src/registry/ast.ts`](../../src/registry/ast.ts) — three bare marker nodes, beside `FieldRef`:

```ts
| { type: "CollectionRef"; pos: number }   // $$
| { type: "DatabaseRef"; pos: number }     // $$$
| { type: "ClusterRef"; pos: number }      // $$$$
```

They carry no payload because the path / key information is captured by the existing `MemberAccess` (for `.name`) and `IndexAccess` (for `[expr]`) nodes that wrap them. Example:

- `$$.foo` → `MemberAccess { object: CollectionRef, member: "foo" }`
- `$$["foo"]` → `IndexAccess { object: CollectionRef, index: StringLiteral "foo" }`
- `$$$$[db].coll` → `MemberAccess { object: IndexAccess { object: ClusterRef, index: <ParamRef db> }, member: "coll" }`

Why separate node types instead of a single `ContextRef { depth }`? Each level carries a different surface — a database ref needs a collection after it, a cluster ref a database and a collection, and `$$` is a stream in its own right — so each is matched on its own rather than by counting a depth.

## Parser

[`src/compiler/parse/parser.ts`](../../src/compiler/parse/parser.ts) — `atom()` matches each prefix token on its own and returns the bare marker node, two lines apiece:

```ts
case "DoubleDollar":
  this.c.next();
  return { type: "CollectionRef", pos: t.pos };
// TripleDollar → DatabaseRef and QuadDollar → ClusterRef read the same way.
```

The prefix carries no follow-token guard of its own, because a prefix IS a whole expression: `$$$.<coll> = $$` has a bare `$$` as its RHS. What may follow one is the surrounding grammar's question — the typo `$$foo` (no separator, an identifier next) is a parse error where the statement ends, and a bare prefix that no road claims is refused at emit, in the words its row states.

Postfix wrapping (`MemberAccess`, `IndexAccess`, optional chains, calls) happens in the standard primary-postfix loop.

## Lowering

[`src/compiler/emit/lower.ts`](../../src/compiler/emit/lower.ts) — the three marker nodes share one case on the value road, `rootAsValue`, which asks the node's registry row what it says about the position the node stands in and throws that refusal with the node's own `pos`:

```
$.x = $$
→ '$$' (current collection) is statement-only. In a value slot use a name on it, e.g. '$$.length'.
```

Because postfix wraps recurse into their `object` first, any chained form (`$$.foo`, `$$$[x]`, `$$$$[a].b.c()`) that no road claims reaches the leaf marker node and is refused there, so no wrapper site needs a case of its own.

`src/index.ts` maps `CodegenError` → `ValidationError` (see the [error table in src/CLAUDE.md](../../src/CLAUDE.md)), so `jsmql.validate("$.x = $$")` returns `{ valid: false, errors: [{ ..., pos: <prefix-pos> }] }`.

## Helpers that pattern-match `FieldRef`

The emitter locates a `FieldRef` through one function, `locate` in `src/compiler/emit/lower.ts`, which every write target and read shares. A context ref is not a document field path, so `locate` answers `null` for one and each caller says its own thing:

- A read has no path to render.
- A write target is rejected — you cannot write to `$$.foo`.
- The filter road drops to `$expr`, where the value road's refusal fires.

## Tests

[`test/codegen.test.ts`](../../test/codegen.test.ts) — `describe("context-reference prefixes ($$, $$$, $$$$)", …)` covers:

- Both postfix forms (`.name`, `[expr]`) at every depth.
- All four mixed forms at depth 4 (`.dot.dot`, `[bracket][bracket]`, `[bracket].dot`, `.dot[bracket]`).
- `.pos` correctness — every error points at the prefix token, not zero.
- Postfix composition through the ref (`$$$.myColl.find(...)` in a value position outside a Pipeline reaches the leaf refusal).
- The refusal for a bare `$$` / `$$$` / `$$$$`, each naming its own prefix, and the parse error for the typo `$$foo`.
- Lexer cap (5+ `$`).
- `$.` behaviour is unaffected by the prefix tokens.

Tests use the string form rather than the arrow form, but the arrow form type-checks too: `$$` / `$$$` / `$$$$` are declared as ambient globals in [`src/globals.ts`](../../src/globals.ts) (via `import "@koresar/jsmql/globals"`), with completion for the diagnostic source stages and — on `$$` — the stream vocabulary (`$$.filter(...)`, `$$.map(...)`, `$$.slice(...)`, …) — see `globals-generation.md` § Context references.

## What each reference carries

- **`$$` — the root stream, at every depth.** A chain on it is the stream road (`$$.filter(…);`, [stream-methods.md](stream-methods.md)); `$$ = …` replaces the stream ([replace-stream-stage.md](replace-stream-stage.md)); `$$.push(…)` unions documents in ([union-stage.md](union-stage.md)); `$$.length` is the stream's count ([stream-length.md](stream-length.md)); the collection-scoped diagnostic sources (`$$.indexStats()`, [system-stages.md](system-stages.md)). It is never a value: `$.x = $$.filter(…)` is refused with the `$facet` form, `$$.length` and the statement form named. Inside a body over another collection it is still the ROOT stream — the body's own stream is the callback's third parameter.
- **`$$$.<coll>` — a collection of the current database.** A chain on it is a read of that collection, the join road ([lookup-stage.md](lookup-stage.md)); as a write target it is the `$out` destination ([out-stage.md](out-stage.md)). The name is written in the source or supplied as a `jsmql.compile` parameter, never computed.
- **`$$$$.<db>.<coll>` — a collection of another database.** A write target only (`$out` takes a `{ db, coll }` namespace); a read is refused, because `$lookup` and `$unionWith` reach the current database alone — the `{ db, coll }` form is Atlas Data Federation's, and a MongoDB server refuses it (HR3). `$$$$` also carries the cluster-scoped diagnostic sources (`$$$$.currentOp(…)`).
- **Types.** `src/globals.ts` declares the three as ambient globals, typed with the surface each carries — the stream vocabulary, the chained stage calls, the stream count and the value terminals on `$$` and `$$$.<coll>`, the diagnostic sources on `$$` and `$$$$`. The document stays `any` ([globals-generation.md](globals-generation.md)).

`$$.find(p)` / `$$.filter(p)` as a VALUE — the current collection read as data — has no lowering: a `$lookup` needs the collection's name, which a pipeline does not carry, so the compiler refuses the value form and names the statement form (`$$.filter(p);`), the `$facet` form and `$$.length`.
