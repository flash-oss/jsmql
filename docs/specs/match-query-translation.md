# `$match` Query-Language Translation

**Status:** implemented.

This spec covers the translation that `$match` applies to expression-form bodies so MongoDB indexes still work. The same translation also drives the top-level [Filter dispatch](filter-mode.md): a no-semicolon `jsmql(...)` input lowers as a Filter (the document `db.coll.find(filter)` takes) using the rules below — there is one translation engine, two callers. The user-facing surface lives in [LANGUAGE.md](../LANGUAGE.md); the broader Pipeline machinery lives in [aggregation-stages.md](aggregation-stages.md). This file is the implementation contract for [src/match-translation.ts](../../src/match-translation.ts).

## Why

MongoDB's `$match` stage uses indexes when the body is a query document (`{ field: value }`, `{ field: { $gt: 5 } }`, …) but **disables index usage** when the body is wrapped in `$expr`. A naïve mapping of `$match($.age > 18)` to `{ $match: { $expr: { $gt: ["$age", 18] } } }` silently turns every match into a collection scan.

The translation rule emits the indexable query-document shape whenever the expression is index-safe, and falls back to `$expr` only for the parts that genuinely need aggregation semantics (computed values, method calls, field-to-field comparison).

## Public contract

`translateMatchBody(body: Expr): MatchTranslation` walks an `Expr` and returns:

```ts
type MatchTranslation = {
  query: Record<string, unknown>;  // translated query-language fragment
  residual: Expr | null;           // unhandled sub-expression to wrap in $expr
};
```

The caller in `src/pipeline.ts:generateStageBody` emits:

- `query` non-empty, `residual === null` → `{ $match: <query> }`
- `query` non-empty, `residual !== null` → `{ $match: { ...<query>, $expr: <generate(residual)> } }`
- `query` empty → `{ $match: { $expr: <generate(body)> } }` (full fallback)

`ObjectLiteral` bodies never reach the translator — they pass through verbatim, providing the explicit escape hatch (`$match({ $expr: $.foo === 5 })`).

## Translation rules

| AST shape | Translation |
|---|---|
| `BinaryExpr(===, FieldRef f, Literal l)` (and order-flipped) — non-null literal | `{ [f.path]: <value> }` |
| `BinaryExpr(!==, FieldRef f, Literal l)` (and order-flipped) — non-null literal | `{ [f.path]: { $ne: <value> } }` |
| `BinaryExpr(===, FieldRef f, NullLiteral)` (and order-flipped) | `{ [f.path]: { $type: "null" } }` — strict, excludes missing |
| `BinaryExpr(!==, FieldRef f, NullLiteral)` (and order-flipped) | `{ [f.path]: { $not: { $type: "null" } } }` — strict, missing passes |
| `BinaryExpr(==, FieldRef f, NullLiteral)` (and order-flipped) | `{ [f.path]: null }` — loose, matches null OR missing |
| `BinaryExpr(!=, FieldRef f, NullLiteral)` (and order-flipped) | `{ [f.path]: { $ne: null } }` — loose, excludes both |
| `BinaryExpr(==\|!=, …, non-null …)` | **not translated** — codegen rejects with a "use ===" error when the body ultimately falls back to `$expr` |
| `BinaryExpr(>\|>=\|<\|<=, FieldRef f, Num/Str literal)` (and order-flipped, with operator flipped accordingly) | `{ [f.path]: { $gt: <value> } }` (etc.) |
| `BinaryExpr(&&, A, B)` | recurse; merge query docs (object-merge if disjoint; `$and` array if keys collide); concat residuals into a synthetic `A && B` residual |
| `BinaryExpr(\|\|, A, B)` | recurse; both branches must fully translate (no residual, non-empty query); emit `{ $or: [<A>, <B>] }`. Otherwise the whole `\|\|` becomes a residual. |
| Everything else | residual (caller wraps in `$expr`) |

**Strict vs loose equality split.** `===`/`!==` are JS-strict — `$type: "null"` checks for null, `$eq`/`$ne` for everything else. `==`/`!=` are restricted to comparisons against `null` (loose null check, matches null OR missing); any other use is a codegen error pointing the user at `===`. Both paths produce semantically consistent MQL whether the body translates to the query language or falls back to `$expr` — codegen mirrors the same null-handling rules. See `docs/LANGUAGE.md` for the user-facing table.

**Field path reconstruction**: `asFieldPath()` walks `FieldRef → MemberAccess → MemberAccess` chains and produces the dotted path (`$.user.role` → `"user.role"`). Anything that interrupts the chain (index access, method call, lambda param) returns null and disqualifies translation.

**Literal types accepted**:

- *Equality* (`===`/`==`/`!==`/`!=`): `NumberLiteral`, `StringLiteral`, `BooleanLiteral`, `NullLiteral`.
- *Ordered* (`>`/`>=`/`<`/`<=`): `NumberLiteral`, `StringLiteral` only — booleans and nulls in this position are almost certainly user bugs; let them fall through to `$expr` for visibility.

**Literal types rejected**:

- `BigIntLiteral` — compiles to `{ $toLong: "..." }` in aggregation form; the query language doesn't recognise that as a value.
- `ArrayLiteral` — would silently switch on query-language array-element matching; too surprising. Documented as an escape-hatch case.
- `RegexLiteral` — regex equality isn't a thing in jsmql; method dispatch via `.match()` / `.test()` is the supported surface.
- Any non-literal (operator call, method call, ternary, template literal, etc.) — these need computed evaluation and only work under `$expr`.

## Partial extraction under `&&`

```
$match($.status === "active" && $.score > $.threshold)
```

Left translates to `{ status: "active" }`; right is residual (`$.threshold` is a FieldRef, not a literal). Emission:

```js
{ $match: { status: "active", $expr: { $gt: ["$score", "$threshold"] } } }
```

The MongoDB query planner uses the `status` index, narrows the candidate set, and evaluates `$expr` on the survivors. This is the conventional hand-written shape.

When multiple residuals chain under `&&`, the translator combines them into a synthetic `BinaryExpr(&&, …, …)` so codegen produces a single `$and`:

```
$.status === "active" && $.a > $.b && $.c < $.d
→ { $match: { status: "active", $expr: { $and: [ { $gt: ["$a", "$b"] }, { $lt: ["$c", "$d"] } ] } } }
```

## `||` is all-or-nothing

```
$match($.status === "active" || $.score > $.threshold)
```

We cannot emit `{ $or: [{ status: "active" }, { $expr: ... }] }` and preserve the index-using guarantee of the disjunction. If any branch under `||` has a residual or empty query, the **whole** `||` becomes a residual and the entire expression falls back to `$expr`. The current implementation prefers correctness over partial gain here; future work could detect specific safe rewrites.

## Key collision under `&&`

When two `&&` branches translate to the same field name, object merge would silently overwrite. We fall back to `$and`:

```
$.age > 18 && $.age < 65
→ { $and: [ { age: { $gt: 18 } }, { age: { $lt: 65 } } ] }
```

When one side is already an `$and`-only doc, we flatten instead of nesting:

```
$a && $b && $.x === 1 && $.x === 2
→ { $and: [ ..., ..., ... ] }   // single $and, not $and-of-$and
```

## Documented semantic divergences from aggregation `$eq`

These are intentional trade-offs — the query-language behavior matches what most users mean. Users who need strict aggregation semantics use the `$match({ $expr: <expr> })` escape hatch.

1. **Array fields.** `{ email: "x" }` matches docs where `email === "x"` OR `email` is an array containing `"x"`. `$expr: { $eq: ["$email", "x"] }` is strict (no array-element match). In practice, this is what users want when filtering by tags, roles, etc.

2. **`{ field: { $ne: x } }`** matches when `field` is present and not equal to `x`. **Missing-field docs are excluded.** `$expr: { $ne: [...] }` evaluates `$field` as `null` for missing fields and would match. Document carefully when relying on either shape.

3. **Field-to-field comparison.** `{ a: "$b" }` is a literal-string match against `"$b"`, NOT a field comparison. We avoid this entirely by refusing to translate `BinaryExpr` where both sides resolve as field paths — those stay in `$expr`.

4. **Null and missing.** `===`/`!==` are JS-strict — missing fields are not null. `==`/`!=` (null-only) are loose — missing fields are treated as null. The two shapes compile to distinct MQL (`$type: "null"` vs bare `null`) on both code paths so the translated and residual fall-back paths agree on semantics. Users who want aggregation's "$eq with null is strict" behaviour use `===`; users who want query-language's "field: null matches missing" behaviour use `==`.

## Escape hatch

The object-literal `$match` body bypasses translation entirely:

```js
$match({ $expr: $.foo === 5 })
// → { $match: { $expr: { $eq: ["$foo", 5] } } }
```

This is the recommended opt-out when any of the four divergences above matter. It composes with other query-document keys:

```js
$match({ status: "active", $expr: $.score > $.threshold })
// → { $match: { status: "active", $expr: { $gt: ["$score", "$threshold"] } } }
```

(The partial-extraction emission shape and this manual form are identical — by design.)

## Tests

[test/match-translation.test.ts](../../test/match-translation.test.ts) covers every translation rule, every partial-extraction case, every documented divergence, and the escape hatch. The high-level `test/pipeline.test.ts` cases were updated to the new output shape; the realistic-pipeline tests in [test/realistic.test.ts](../../test/realistic.test.ts) now show indexable query-document output.

## Out of scope (future work)

- **`!expr` via De Morgan.** Negation has subtle null/missing interactions in MongoDB; user-written positive forms or the `$expr` escape are safer for v1.
- **`.includes()` / `Array.prototype.includes` → `$in`.** Method-dispatch translation; coordinate with `method-dispatch.md`.
- **Regex match (`$.name.match(/^a/)`) → `{ name: /^a/ }`.** Requires regex-flag preservation and a clear story for global/multiline flags.
- **`in` operator** (jsmql's `BinaryExpr(in)`) — distinct from query-language `$in` and rarely the right translation.
- **Partial extraction under `||`** for the case where every branch has a translatable AND an untranslatable factor with matching shape — only useful in narrow cases.
- **`$elemMatch`, `$exists`, `$type`, `$size`, etc.** — query-only operators that have no aggregation analogue. Would require their own jsmql surface.
