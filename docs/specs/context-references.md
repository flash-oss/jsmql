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

This spec covers **syntax only**. Codegen throws a `CodegenError` for any use of each prefix that isn't already wired into a shipped lowering (`$$.push(...)`, `$$$.coll.find/filter(...)`, `$$$$.db.coll.find/filter(...)`). The semantic API surface for the remaining shapes (`$$.find/.filter` on the current collection, anything else on `$$$$`, etc.) is staged into future releases.

## Lexer

[`src/lexer.ts`](../../src/lexer.ts) — the `$` branch in `tokenize()` does longest-match counting over consecutive `$` characters, then chooses one of:

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

[`src/ast.ts`](../../src/ast.ts) — three new bare marker nodes added immediately after `FieldRef`:

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

[`src/parser.ts`](../../src/parser.ts) — `parsePrimary()` adds three cases that dispatch to one shared helper:

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

[`src/codegen.ts`](../../src/codegen.ts) — three new cases in the main `_generate` switch immediately after `FieldRef`. Each throws a `CodegenError` with the offending node's `pos`:

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

Several codegen / parser helpers explicitly check for `FieldRef` — `asFieldPath`, `targetToPath`, `tryFieldPath`, `isFieldPathTarget`, the `match-translation` field-path extractor. All of them return `null` / `false` for the new node types, which is correct:

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

Tests use the string form rather than the arrow form because `$$` / `$$$` / `$$$$` are not yet declared as ambient globals (that's part of the future API surface — see `ops-generation.md`).

## Status

- **`$$.push(...) → $unionWith`** — **shipped**. Statement-only collection union. JS-faithful spread rules (`...` on arrays, no `...` on scalars), inline-doc batching into `$documents`, source-order preserved, and a precise rejection for correlated predicates (`$unionWith` has no `let`). Re-uses `extractLetsFromExpr` / `extractLetsFromPipeline` / `extractLookupTarget` / `validateLookupShape` from [`lookup-stage.md`](./lookup-stage.md). See [`union-stage.md`](./union-stage.md) and [LANGUAGE.md → Collection union](../LANGUAGE.md#collection-union-push).
- **`$$$.<coll>.find / .filter(...) → $lookup`** — **shipped**. See [`lookup-stage.md`](./lookup-stage.md) for the predicate translation, auto-`let` extraction, chained-terminal materialisation, and error catalog. User-facing reference in [LANGUAGE.md → Cross-collection lookups](../LANGUAGE.md#cross-collection-lookups-coll-find--filter).
- **`$$$$.<db>.<coll>.find / .filter(...) → $lookup` with `from: { db, coll }`** — **shipped**. Same surface as `$$$`, with the cross-database `from` object shape (Atlas Data Federation form). Community MongoDB doesn't accept the object form, so the lowered MQL runs only on Atlas Data Federation or equivalent federated deployments. See [`lookup-stage.md`](./lookup-stage.md) → "Cluster-rooted ($$$$) cross-database joins" and [LANGUAGE.md → Cross-database lookups](../LANGUAGE.md#cross-database-lookups-dbcollfind--filter).
- **`$$$.<coll> = …` / `$$$$.<db>.<coll> = …` → `$out`** — **shipped**. The same dot/bracket access chain that `$$$` / `$$$$` already supported on the RHS (lookup-receiver position) now also lights up as an `AssignExpr` LHS: the assignment is intercepted in `pipeline.ts`, lowered into the trailing `$out` stage with an optional `$$.filter(<predicate>)` chain on the RHS contributing a leading `$match`. Last-stage-only; statement-only; Pipeline-mode-only. See [`out-stage.md`](./out-stage.md) and [LANGUAGE.md → `$out`](../LANGUAGE.md#out-write-the-pipeline-to-a-collection).
- **Diagnostic source stages — direct call on a bare ref (`$$.indexStats()`, `$$$.currentOp(...)`, `$$$$.shardedDataDistribution()`)** — **shipped**. A *direct* `MethodCall` on a bare `CollectionRef` / `DatabaseRef` / `ClusterRef` (distinct from the lookup's `MemberAccess`-wrapped receiver) lowers to MongoDB's diagnostic / system source stages. The ref prefix encodes the scope MongoDB requires (collection / database / cluster), so a wrong-scope use is a compile-time error. First-stage-only; Pipeline-mode-only. The scope ↔ stage mapping lives in the `diagnostic` field of the STAGES registry. See [`system-stages.md`](./system-stages.md) and [LANGUAGE.md → System / diagnostic stages](../LANGUAGE.md#system--diagnostic-stages-indexstats-currentop-).

## Future work

Each remaining item lands in its own session as a codegen branch on the corresponding ref node — the parser, lexer, and AST stay stable.

- **`$$.find / .filter` on the current collection** — needs the schema/metadata threading below to resolve the receiver's name into the inner `$lookup.from` (or the outer match against `$$ROOT`). Until then, `$$` supports `.push(...)` (union) and the collection-scoped diagnostic source stages (`$$.indexStats()`, `$$.collStats(...)`, … — see [`system-stages.md`](./system-stages.md)), but not data `.find` / `.filter`.
- **Schema / metadata threading** — collection-name and database-name binding needs a slot on `GenerateCtx`, fed by the entry-point (`jsmql.compile`, the mongoose plugin, or a new `jsmql.bind({ db, collection })`).
- **Ambient globals** — `src/ops.ts` (or a parallel generator) declares `$$`, `$$$`, `$$$$` so the arrow-form syntax type-checks under TypeScript.
- **Nested lookups** — `$$$.coll2.find/filter(...)` (or any `$$$$` variant) inside another lookup's predicate or block body. Currently rejected with a targeted error by `rejectNestedLookup` in [`lookup-stage.md`](./lookup-stage.md).
