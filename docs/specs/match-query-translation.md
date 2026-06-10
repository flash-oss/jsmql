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
| `BinaryExpr(=== \| !== \| >\|>=\|<\|<=, FieldRef f, NewDate)` where all `NewDate` (and any nested `DateUTC`) args are number/string literals | `{ [f.path]: { $gte: <Date instance> } }` (etc.) — folded at translate time |
| `BinaryExpr(=== \| !==, FieldRef f, UndefinedLiteral)` (and order-flipped) | `{ [f.path]: { $exists: false } }` / `{ ... $exists: true }` |
| `BinaryExpr(=== \| !== \| >\|>=\|<\|<=, MemberAccess(…, "length"), NumberLiteral n)` where `n` is a non-negative integer (and order-flipped) | **not translated** — residualises to `$expr` so codegen emits the string-or-array `$cond` (see the natural-number rule below). Dot `.length` only; bracket `["length"]` is raw access. |
| `BinaryExpr(=== \| !==, BinaryExpr("%", FieldRef f, IntLit d), IntLit m)` (and order-flipped) | `{ [f.path]: { $mod: [d, m] } }` / `{ ... { $not: { $mod: [d, m] } } }` |
| `MethodCall(FieldRef f, "includes", [Literal v])` (boolean predicate) | `{ [f.path]: <v> }` — implicit array-element / scalar-equality match |
| `MethodCall(ArrayLiteral [Literal …], "includes", [FieldRef f])` (boolean predicate) | `{ [f.path]: { $in: [<lits…>] } }` |
| `MethodCall(FieldRef f, "match", [RegexLiteral r])` (boolean predicate) | `{ [f.path]: <real-RegExp(r)> }` |
| `MethodCall(FieldRef f, "some", [Lambda([p], body)])` where `body` translates with no residual against `p`-as-root | `{ [f.path]: { $elemMatch: <translated-body> } }` |
| `&&`-chain where **every** leaf is `FieldRef(f).includes(Literal)` on the **same** `f` | `{ [f.path]: { $all: [<lits…>] } }` |
| `BinaryExpr(&&, A, B)` | recurse; merge query docs (object-merge if disjoint; `$and` array if keys collide); concat residuals into a synthetic `A && B` residual |
| `BinaryExpr(\|\|, A, B)` | recurse; both branches must fully translate (no residual, non-empty query); emit `{ $or: [<A>, <B>] }`. Otherwise the whole `\|\|` becomes a residual. |
| Everything else | residual (caller wraps in `$expr`) |

**Strict vs loose equality split.** `===`/`!==` are JS-strict — `$type: "null"` checks for null, `$eq`/`$ne` for everything else. `==`/`!=` are restricted to comparisons against `null` (loose null check, matches null OR missing); any other use is a codegen error pointing the user at `===`. Both paths produce semantically consistent MQL whether the body translates to the query language or falls back to `$expr` — codegen mirrors the same null-handling rules. See `docs/LANGUAGE.md` for the user-facing table.

**Field path reconstruction**: `asFieldPath()` walks `FieldRef → MemberAccess → MemberAccess` chains and produces the dotted path (`$.user.role` → `"user.role"`). Anything that interrupts the chain (index access, method call, lambda param) returns null and disqualifies translation.

**Literal types accepted**:

- *Equality* (`===`/`==`/`!==`/`!=`): `NumberLiteral`, `StringLiteral`, `BooleanLiteral`, `NullLiteral`.
- *Ordered* (`>`/`>=`/`<`/`<=`): `NumberLiteral`, `StringLiteral` only — booleans and nulls in this position are almost certainly user bugs; let them fall through to `$expr` for visibility.
- `NewDate` (both equality and ordered) **when all its arguments are themselves compile-time literals** — `new Date("2026-01-01")`, `new Date(2026, 0, 1)`, and `new Date(Date.UTC(2026, 0, 1))` are folded to real JS `Date` instances at translate time and placed directly in the query-doc value slot. `new Date()` (zero-arg) and `new Date($.someField)` keep their `{ $toDate: ... }` aggregation form and fall back to `$expr`. The fold is also gated on the result being a valid date — `new Date("nonsense")` falls through so the failure surfaces at query time rather than producing a silently bogus filter. See [filter-mode.md](filter-mode.md) for worked examples.
- `ParamRef` (function-form bindings via `jsmql.compile`) when its bound value is a query-doc-compatible BSON value: number, string, boolean, null, `Date`, `RegExp` (equality only), `Uint8Array`/`Buffer` (equality only), or duck-typed ObjectId (`_bsontype === "ObjectID"` / `"ObjectId"`, equality only).

**Literal types rejected**:

- `BigIntLiteral` — compiles to `{ $toLong: "..." }` in aggregation form; the query language doesn't recognise that as a value.
- `ArrayLiteral` — would silently switch on query-language array-element matching; too surprising. Documented as an escape-hatch case.
- `RegexLiteral` — regex equality isn't a thing in jsmql; method dispatch via `.match()` / `.test()` is the supported surface. (A `RegExp` value passed through a `jsmql.compile` binding IS accepted, since the user has explicitly opted in by passing a runtime regex.)
- Any non-literal (operator call, method call, ternary, template literal, etc.) — these need computed evaluation and only work under `$expr`. **`{ $toDate: ... }` and other aggregation expressions are not query-doc values**: MongoDB compares the literal subdocument, not the evaluated value. This is the reason we fold `new Date(<static-args>)` ourselves rather than emitting `{ $toDate: ... }` into the query-doc slot.

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

We cannot emit `{ $or: [{ status: "active" }, { $expr: ... }] }` and preserve the index-using guarantee of the disjunction. If any branch under `||` has a residual or empty query, the **whole** `||` becomes a residual and the entire expression falls back to `$expr`. The current implementation prefers correctness over partial gain here; future work could detect specific safe rewrites [DEF-011].

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

## Query-position-only divergences

A few patterns translate differently in `$match` position than they would in an arbitrary expression. The translator's job is to emit index-friendly MQL; the expression-form codegen's job is to mirror JS semantics on values. When the two differ, we document the divergence here:

- **`.includes(<literal>)` on a field receiver.** Expression form is type-polymorphic (`$cond` over `$isArray` to choose `$in` vs `$indexOfCP`-substring). Query form emits the bare `{ field: <value> }` — which matches arrays-containing-value *and* scalar equality (MongoDB's "value or array-of-value" semantics), but NOT string substring. Users who want substring match in `$match` reach for `.match(/value/)`.
- **`typeof === "boolean"` / `typeof === "bool"`.** JS's `typeof` returns `"boolean"`; MongoDB's `$type` accepts `"bool"`. The translator accepts either spelling and emits the BSON form.
- **`.length` natural-number test.** Only the **dot** form `.length` is interpreted as a length — bracket access (`["length"]`) is raw data access and is never folded here (see [method-dispatch.md](method-dispatch.md) for the language rule). The dot form is read one of two ways depending on the other operand:
  - **vs a natural-number literal** (non-negative integer): it's the *length of a string or array*. The comparison residualises into `$expr` so codegen emits the runtime `$isArray`/`$size`/`$strLenCP` dispatch. This applies to **all** comparison operators — `===`, `!==`, `<`, `<=`, `>`, `>=`. (The old array-only `$size` peephole was removed: `$size` silently fails on strings, so it didn't honour the "string or array" contract.)
  - **vs anything else** (`3.5`, a string, etc.): a length can't sensibly equal a non-natural value, so `.length` is read as a *literal field path* and collapses into the dotted key `{ "items.length": <value> }` via the generic field-path translation. This is the documented way the dotted-key path is reached intentionally.

  **Boundary:** a `.length` compared against a *non-literal* (another field or expression) has no natural-number literal to test, so it residualises to the `$expr` length form rather than a literal field path — `$expr` position can't express "the field literally named length" without `$getField`. To read such a field, use raw bracket access: `$["items.length"]` (a plain field reference on the root) or `$getField($.items, "length")`.

## Out of scope — rejected as bad DX

- **`!expr` via De Morgan.** Negation has subtle null/missing interactions in MongoDB — silent index/non-index flips driven by data shape are exactly the surprise jsmql aims to avoid. Users write positive forms or `$op($not, …)` explicitly. See `feedback_no_silent_output_drift.md` in user memory for the rationale.
- **Server-side JS predicates (`$where`) and a `function`-keyword sugar for `$function` / `$accumulator`.** jsmql's purpose is to compile JS to MQL on the *client*, not to ship JS to the server — and `$where` is deprecated. We will not add a `function` keyword that lowers to these. (`$function` / `$accumulator` stay reachable through the `$op(...)` escape hatch for the rare case server-side JS is genuinely needed.)

## Out of scope — future work

- **`in` operator** (jsmql's `BinaryExpr(in)`) — distinct from query-language `$in` and rarely the right translation. Stays rejected; `.includes()` covers the common case.
- **Partial extraction under `||`** [DEF-011] for the case where every branch has a translatable AND an untranslatable factor with matching shape — only useful in narrow cases.
- **`$jsonSchema`, `$geoWithin`, `$near`, `$text`** — query-only operators that have no idiomatic JS shape. Continue to use `$op($jsonSchema, …)` etc. as the escape hatch.
