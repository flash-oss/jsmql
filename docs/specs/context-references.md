# Context-reference prefixes (`$$`, `$$$`, `$$$$`)

## Purpose

JSMQL has four levels of context prefix. Each prefix names one fixed scope:

| Prefix | Scope             | Example                  |
| ------ | ----------------- | ------------------------ |
| `$.`   | Current document  | `$.age` (existing)       |
| `$$`   | Current collection| `$$.find(…)`             |
| `$$$`  | Current database  | `$$$.myColl.find(…)`     |
| `$$$$` | Current cluster   | `$$$$.myDb.myColl.find(…)` |

The four levels give JSMQL one vocabulary for a document, a collection, a database, or a cluster. This is the syntax behind `$lookup`, `$unionWith`, `$out`, and the diagnostic source stages, and it uses forms users already know.

The table gives the plain name of each scope. The precise name for `$$` is the **root stream**: the documents that the current collection sends into the pipeline. HR4 in [docs/LANG_RULES.md](../LANG_RULES.md) uses that term, and so does the rest of this specification.

This spec covers the **syntax**: the tokens, the AST nodes, and the parse. The road that lowers a prefix defines what the prefix MEANS, and each road has its own spec — see [What each reference carries](#what-each-reference-carries). A prefix can reach a position where no row gives it a meaning; the compiler refuses it there, in that row's own words. A cross-database **read** (`$$$$.db.coll.find/filter(...)`) parses, but the compiler **rejects it at compile time** — see the `$$$$` entry below.

## Lexer

[`src/compiler/lex/lexer.ts`](../../src/compiler/lex/lexer.ts) — `lex()` takes the longest token from the table in [`src/registry/tokens.ts`](../../src/registry/tokens.ts). So a run of `$` characters reads as one of these tokens:

| Source              | Token            |
| ------------------- | ---------------- |
| `$.` (1 `$` + `.`)  | `DollarDot`      |
| `$` (bare)          | `Dollar`         |
| `$$` (2 `$`)        | `DoubleDollar`   |
| `$$$` (3 `$`)       | `TripleDollar`   |
| `$$$$` (4 `$`)      | `QuadDollar`     |
| `$$$$$+` (5 or more)| `LexError`       |

The trailing `.` / `[` is **not** part of a prefix token. Each prefix is bare. Postfix parsing reads the dot or bracket as a `Dot` / `LBracket` token, and a `MemberAccess` / `IndexAccess` node wraps it. `$.` is the one prefix whose dot IS baked in: `$` alone is the document handle, so the lexeme tells the two readings apart.

The table's row keys — `'$$'`, `'$$$'`, `'$$$$'` — are the spellings the parser's messages print. So an internal token name never leaks into a user-facing string.

5 or more consecutive `$` characters, followed by anything, throw this error:

> `Up to 4 levels of context reference are supported ('$.', '$$', '$$$', '$$$$') at position N`

## AST

[`src/registry/ast.ts`](../../src/registry/ast.ts) — three bare marker nodes, beside `FieldRef`:

```ts
| { type: "StreamRef"; pos: number }   // $$
| { type: "DatabaseRef"; pos: number }     // $$$
| { type: "ClusterRef"; pos: number }      // $$$$
```

They carry no payload. The existing `MemberAccess` (for `.name`) and `IndexAccess` (for `[expr]`) nodes wrap them and capture the path or key. Example:

- `$$.foo` → `MemberAccess { object: StreamRef, member: "foo" }`
- `$$["foo"]` → `IndexAccess { object: StreamRef, index: StringLiteral "foo" }`
- `$$$$[db].coll` → `MemberAccess { object: IndexAccess { object: ClusterRef, index: <ParamRef db> }, member: "coll" }`

Why use separate node types instead of one `ContextRef { depth }` node? Each level carries a different surface. A database ref needs a collection after it. A cluster ref needs a database and a collection. `$$` is a stream in its own right. So each node matches on its own, rather than by a depth count.

## Parser

[`src/compiler/parse/parser.ts`](../../src/compiler/parse/parser.ts) — `atom()` matches each prefix token on its own and returns the bare marker node, in two lines:

```ts
case "DoubleDollar":
  this.c.next();
  return { type: "StreamRef", pos: t.pos };
// TripleDollar → DatabaseRef and QuadDollar → ClusterRef read the same way.
```

The prefix carries no follow-token guard of its own, because a prefix IS a whole expression: `$$$.<coll> = $$` has a bare `$$` as its RHS. The surrounding grammar decides what may follow a prefix. The typo `$$foo` (no separator, then an identifier) is a parse error at the point where the statement ends. A bare prefix that no road claims is refused at emit time, in the words its own row states.

Postfix wrapping (`MemberAccess`, `IndexAccess`, optional chains, calls) happens in the standard primary-postfix loop.

## Lowering

[`src/compiler/emit/lower.ts`](../../src/compiler/emit/lower.ts) — the three marker nodes share one case on the value road, `rootAsValue`. This case asks the node's registry row what it says about the position the node stands in, then throws that refusal with the node's own `pos`:

```
$.x = $$
→ '$$' (the root stream) is statement-only. In a value slot, use a method on it, for example '$$.size()'.
```

Postfix wraps recurse into their `object` first. So any chained form (`$$.foo`, `$$$[x]`, `$$$$[a].b.c()`) that no road claims reaches the leaf marker node and is refused there. No wrapper site needs a case of its own.

`src/index.ts` maps `CodegenError` to `ValidationError` (see the [error table in src/CLAUDE.md](../../src/CLAUDE.md)). So `jsmql.validate("$.x = $$")` returns `{ valid: false, errors: [{ ..., pos: <prefix-pos> }] }`.

## Helpers that pattern-match `FieldRef`

The emitter locates a `FieldRef` through one function, `locate` in `src/compiler/emit/lower.ts`. Every write target and read shares this function. A context ref is not a document field path, so `locate` answers `null` for one, and each caller states its own rule:

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
- Lexer cap (5 or more `$`).
- The prefix tokens do not change `$.` behaviour.

Tests use the string form rather than the arrow form, but the arrow form also type-checks: `$$` / `$$$` / `$$$$` are declared as ambient globals in [`src/globals.ts`](../../src/globals.ts) (through `import "@koresar/jsmql/globals"`). This declaration gives completion for the diagnostic source stages, and — on `$$` — for the stream vocabulary (`$$.filter(...)`, `$$.map(...)`, `$$.slice(...)`, …). See `globals-generation.md` § Context references.

## What each reference carries

- **`$$` — the root stream, at every depth.** A chain on it is the stream road (`$$.filter(…);`, [stream-methods.md](stream-methods.md)). `$$ = …` replaces the stream ([replace-stream-stage.md](replace-stream-stage.md)). `$$.push(…)` unions documents in ([union-stage.md](union-stage.md)). `$$.size()` is the stream's count ([stream-size.md](stream-size.md)). `$$` also carries the collection-scoped diagnostic sources (`$$.indexStats()`, [system-stages.md](system-stages.md)). `$$` is never a value: the compiler refuses `$.x = $$.filter(…)` and names the `$facet` form, `$$.size()`, and the statement form instead. Inside a body over another collection, `$$` is still the ROOT stream — the body's own stream is the callback's third parameter.
- **`$$$.<coll>` — a collection of the current database.** A chain on it reads that collection, through the join road ([lookup-stage.md](lookup-stage.md)). As a write target, it names the `$out` destination ([out-stage.md](out-stage.md)). The source writes the name directly, or supplies it as a `jsmql.compile` parameter; the name is never computed.
- **`$$$$.<db>.<coll>` — a collection of another database.** This is a write target only (`$out` takes a `{ db, coll }` namespace). The compiler refuses a read, because `$lookup` and `$unionWith` reach the current database alone. The `{ db, coll }` form belongs to Atlas Data Federation, and a MongoDB server refuses it there (HR3). `$$$$` also carries the cluster-scoped diagnostic sources (`$$$$.currentOp(…)`).
- **Types.** `src/globals.ts` declares the three as ambient globals. Each type carries the surface that prefix carries — the stream vocabulary, the chained stage calls, the stream count, and the value terminals on `$$` and `$$$.<coll>`, plus the diagnostic sources on `$$` and `$$$$`. The document stays `any` ([globals-generation.md](globals-generation.md)).

`$$.find(p)` / `$$.filter(p)` as a VALUE — reading the current collection as data — has no lowering. A `$lookup` needs the collection's name, and a pipeline does not carry that name. So the compiler refuses the value form and names the statement form (`$$.filter(p);`), the `$facet` form, and `$$.size()` instead.
