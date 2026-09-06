# Context-reference prefixes (`$$`, `$$$`, `$$$$`)

## Purpose

Four levels of jsmql doc-context prefix, one per scope:

| Prefix | Scope             | Example                  |
| ------ | ----------------- | ------------------------ |
| `$.`   | Current document  | `$.age` (existing)       |
| `$$`   | Current collection| `$$.find(…)`             |
| `$$$`  | Current database  | `$$$.myColl.find(…)`     |
| `$$$$` | Current cluster   | `$$$$.myDb.myColl.find(…)` |

The first level (`$.` → `FieldRef`) has been the only doc-context prefix since the project started. The three new levels exist to give jsmql a uniform vocabulary for cross-collection / cross-database / cross-cluster references — the primary intended use is driving `$lookup` and similar multi-collection operators from a syntax users already understand.

This spec covers **syntax only**. Codegen throws a `CodegenError` for any use of each prefix that isn't already wired into a shipped lowering (`$$.push(...)`, `$$$.coll.find/filter(...)`, the cross-database `$out` write `$$$$.db.coll = $$`, and the `$$$$` diagnostic source stages). A cross-database **read** (`$$$$.db.coll.find/filter(...)`) is parsed but **rejected at compile time** — see the `$$$$` status entry below. The semantic API surface for the remaining shapes (`$$.find/.filter` on the current collection, etc.) is staged into future releases.

## Lexer

[`src/compiler/lex/lexer.ts`](../../src/compiler/lex/lexer.ts) — the `$` branch in `tokenize()` does longest-match counting over consecutive `$` characters, then chooses one of:

| Source              | Token            |
| ------------------- | ---------------- |
| `$.` (1 `$` + `.`)  | `DollarDot`      |
| `$` (bare)          | `Dollar`         |
| `$$` (2 `$`)        | `DoubleDollar`   |
| `$$$` (3 `$`)       | `TripleDollar`   |
| `$$$$` (4 `$`)      | `QuadDollar`     |
| `$$$$$+` (5 or more)| `LexError`       |

The trailing `.` / `[` is **not** consumed by the new prefix tokens — they're bare. Postfix parsing handles the dot or bracket via the existing `Dot` / `LBracket` token + `MemberAccess` / `IndexAccess` AST rule. The existing `$.` baked-in dot stays for back-compat (rewriting it would churn the parser and codegen for no DX gain).

`TOKEN_DISPLAY` entries are `'$$'`, `'$$$'`, `'$$$$'` so error messages stay human-readable.

5+ consecutive `$` followed by anything throws:

> `Up to 4 levels of context reference are supported ('$.', '$$', '$$$', '$$$$') at position N`

## AST

[`src/registry/ast.ts`](../../src/registry/ast.ts) — three new bare marker nodes added immediately after `FieldRef`:

```ts
| { type: "CollectionRef"; pos: number }   // $$
| { type: "DatabaseRef"; pos: number }     // $$$
| { type: "ClusterRef"; pos: number }      // $$$$
```

They carry no payload because the path / key information is captured by the existing `MemberAccess` (for `.name`) and `IndexAccess` (for `[expr]`) nodes that wrap them. Example:

- `$$.foo` → `MemberAccess { object: CollectionRef, member: "foo" }`
- `$$["foo"]` → `IndexAccess { object: CollectionRef, index: StringLiteral "foo" }`
- `$$$$[db].coll` → `MemberAccess { object: IndexAccess { object: ClusterRef, index: <ParamRef db> }, member: "coll" }`

Why separate node types instead of a single `ContextRef { depth }`? Cleaner pattern-matching in codegen, and the three levels will diverge as semantics land — e.g. database-level needs a `coll` follow-up, cluster-level needs `db.coll` or `db[coll]`, collection-level may be a value of its own.

## Parser

[`src/compiler/parse/parser.ts`](../../src/compiler/parse/parser.ts) — `parsePrimary()` adds three cases that dispatch to one shared helper:

```ts
case TokenType.DoubleDollar:  return this.parseContextRef("CollectionRef", "$$");
case TokenType.TripleDollar:  return this.parseContextRef("DatabaseRef", "$$$");
case TokenType.QuadDollar:    return this.parseContextRef("ClusterRef", "$$$$");
```

`parseContextRef(nodeType, displayPrefix)`:
1. Consumes the prefix token (captures `pos`).
2. Sanity-guards that the next token is `Dot` or `LBracket`. Otherwise throws `ParseError`:
   > `Expected '.<name>' or '[<expr>]' after '${displayPrefix}' at position N`

   This matches the spirit of `parseFieldRef`'s "expected field name after `$.`" check — bare `$$`, `$$foo`, etc. yield an actionable message instead of a downstream surprise.
3. Returns the bare marker node `{ type: nodeType, pos }`.

Postfix wrapping (`MemberAccess`, `IndexAccess`, optional chains, calls) happens in the standard primary-postfix loop — no parser changes needed there.

## Codegen

[`src/compiler/emit/lower.ts`](../../src/compiler/emit/lower.ts) — three new cases in the main `_generate` switch immediately after `FieldRef`. Each throws a `CodegenError` with the offending node's `pos`:

```ts
case "CollectionRef":
  throw new CodegenError(
    "'$$' (current-collection reference) is reserved syntax — " +
    "not yet lowered to MQL. Coming in a future release.",
    expr.pos,
  );
// DatabaseRef and ClusterRef follow the same pattern.
```

Because postfix wraps recurse into their `object` first, any chained form (`$$.foo`, `$$$[x]`, `$$$$[a].b.c()`) reaches the leaf marker node, fires `CodegenError`, and never needs special handling at the wrapper site.

`src/index.ts` already maps `CodegenError` → `ValidationError` (see the [error table in src/CLAUDE.md](../../src/CLAUDE.md)), so `jsmql.validate("$$.foo")` returns `{ valid: false, errors: [{ ..., pos: <prefix-pos> }] }` automatically. No `index.ts` changes were required.

## Helpers that pattern-match `FieldRef`

The emitter locates a `FieldRef` through one function, `locate` in `src/compiler/emit/lower.ts`, which every write target and read shares.

- Path extractors give up — context refs aren't document field paths.
- Assignment-target validator rejects them — you can't write to `$$.foo`.
- Match-translation falls through to `$expr`, which then triggers the codegen throw.

No changes needed to any of these helpers.

## Tests

[`test/codegen.test.ts`](../../test/codegen.test.ts) — `describe("context-reference prefixes ($$, $$$, $$$$)", …)` covers:

- Both postfix forms (`.name`, `[expr]`) at every depth.
- All four mixed forms at depth 4 (`.dot.dot`, `[bracket][bracket]`, `[bracket].dot`, `.dot[bracket]`).
- `.pos` correctness — every error points at the prefix token, not zero.
- Postfix composition through the ref (`$$$.myColl.find(...)` still throws at the leaf).
- Parser sanity-guard messages for bare `$$` / `$$foo` / `$$$` / `$$$$`.
- Lexer cap (5+ `$`).
- Existing `$.` behaviour is unchanged.

Tests use the string form rather than the arrow form, but the arrow form now type-checks too: `$$` / `$$$` / `$$$$` are declared as ambient globals in [`src/globals.ts`](../../src/globals.ts) (via `import "@koresar/jsmql/globals"`), with completion for the diagnostic source stages and — on `$$` — the stream vocabulary (`$$.filter(...)`, `$$.map(...)`, `$$.slice(...)`, …) — see `globals-generation.md` § Context references.

## What each reference carries

- **`$$` — the root stream, at every depth.** A chain on it is the stream road (`$$.filter(…);`, [stream-methods.md](stream-methods.md)); `$$ = …` replaces the stream ([replace-stream-stage.md](replace-stream-stage.md)); `$$.push(…)` unions documents in ([union-stage.md](union-stage.md)); `$$.length` is the stream's count ([stream-length.md](stream-length.md)); the collection-scoped diagnostic sources (`$$.indexStats()`, [system-stages.md](system-stages.md)). It is never a value: `$.x = $$.filter(…)` is refused with the `$facet` form, `$$.length` and the statement form named. Inside a body over another collection it is still the ROOT stream — the body's own stream is the callback's third parameter.
- **`$$$.<coll>` — a collection of the current database.** A chain on it is a read of that collection, the join road ([lookup-stage.md](lookup-stage.md)); as a write target it is the `$out` destination ([out-stage.md](out-stage.md)). The name is written in the source or supplied as a `jsmql.compile` parameter, never computed.
- **`$$$$.<db>.<coll>` — a collection of another database.** A write target only (`$out` takes a `{ db, coll }` namespace); a read is refused, because `$lookup` and `$unionWith` reach the current database alone — the `{ db, coll }` form is Atlas Data Federation's, and a MongoDB server refuses it (HR3). `$$$$` also carries the cluster-scoped diagnostic sources (`$$$$.currentOp(…)`).
- **Types.** `src/globals.ts` declares the three as ambient globals, typed with the surface each carries — the stream vocabulary, the chained stage calls, the stream count and the value terminals on `$$` and `$$$.<coll>`, the diagnostic sources on `$$` and `$$$$`. The document stays `any` ([globals-generation.md](globals-generation.md)).

`$$.find(p)` / `$$.filter(p)` as a VALUE — the current collection read as data — has no lowering: a `$lookup` needs the collection's name, which a pipeline does not carry, so the compiler refuses the value form and names the statement form (`$$.filter(p);`), the `$facet` form and `$$.length`.
