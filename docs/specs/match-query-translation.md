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

`mergeTranslatedQuery` (in `src/match-translation.ts`) is the one place the emission
lives — every consumer routes through it, so the shape can't drift:

- `query` non-empty, `residual === null` → `{ $match: <query> }`
- `query` non-empty, `residual !== null` → `{ $match: { ...<query>, $expr: <generateBool(residual)> } }`
- `query` empty → `{ $match: { $expr: <generateBool(residual)> } }` (full fallback)
- both empty → `null`, and the caller skips the `$match` entirely (vacuous predicate)

**The residual is a boolean position**, so it lowers through `generateBool` (see
`grammar.md`) rather than plain `generate`: a `$match` decides which documents survive,
which is the same question `.filter` asks, and raw `$expr` truthiness would keep a `""`
that `.filter(x => x.f)` drops. Only the residual takes the wrap — the translated
`query` half is comparisons, already boolean, so the index-friendly shape is untouched.
A predicate written with `const`/`let` bindings rides in `$expr` entire and takes the
wrap around its `return`, inside the `$let` (`generateExprBlockPredicate`).

`ObjectLiteral` bodies never reach the translator — they pass through verbatim, providing the explicit escape hatch (`$match({ $expr: $.foo === 5 })`) for raw MQL truthiness.

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
- `NewDate` (both equality and ordered) **when all its arguments are themselves compile-time literals** — `new Date("2026-01-01")`, `new Date(2026, 1, 1)`, and `new Date(Date.UTC(2026, 1, 1))` fold to real JS `Date` instances placed directly in the query-doc value slot. The fold defers to the shared `foldConstantDate` in [codegen.ts](../../src/codegen.ts) — the single source of truth — so the translator's value is byte-identical to what codegen emits for the same `new Date(...)` in aggregation position (multi-arg `(y, m, d)` is **UTC**, matching `$dateFromParts`). `new Date()` (zero-arg) and `new Date($.someField)` aren't constant, so they fall through to `$expr` where codegen emits the `{ $toDate: ... }` aggregation form. A constant that doesn't parse to a valid date (`new Date("nonsense")`) also falls through here, but codegen then **rejects it at compile time** (HR3 — the server would reject the equivalent `{ $toDate }`), so the comparison never silently becomes a bogus filter. See [filter-mode.md](filter-mode.md) for worked examples.
- `ObjectIdLiteral` (equality only) — `ObjectId("…")` / `new ObjectId("…")` / a 24-hex `0x…` literal is minted to a live BSON `ObjectId` (see [src/objectid.ts](../../src/objectid.ts)) and placed directly in the query-doc value slot, so `$._id === ObjectId("…")` and `[ObjectId("…"), …].includes($._id)` stay index-friendly. The 24-hex shape (and the 2009 plausibility floor) is validated by the parser, so the value here is always constructible. There is no ordered (`<`/`>`) case — those fall through to `$expr`.
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

1. **Array fields — on every comparison, and per clause under `&&`.** `{ email: "x" }` matches docs where `email === "x"` OR `email` is an array containing `"x"`; `{ a: { $gt: 1 } }` matches when ANY element is greater; `{ a: { $type: "number" } }` matches an array holding a number. `$expr` compares the whole value and matches none of these. Under `&&` each clause is satisfied by its own element: `$.a === 1 && $.a === 2` selects `a: [1, 2, 3]` — the "contains both" reading, which the `.includes` chain spells as `$all`. In practice, this is what users want when filtering by tags, roles, etc.

2. **`{ field: { $ne: x } }`** is the complement of the array-element equality match: it excludes a document whose `field` is an ARRAY holding `x` (`a: [1, 2, 3]` fails `{ a: { $ne: 1 } }`), where `$expr: { $ne: ["$field", x] }` compares the whole array and keeps it. Both forms select a document that lacks the field — measured on mongod: `{ a: { $ne: 1 } }` and `{ $expr: { $ne: ["$a", 1] } }` both return the missing-field document. `===` and `!==` therefore partition the collection exactly, on both roads.

3. **Ordered comparison is type-bracketed in the query language.** `{ age: { $lt: 18 } }` compares only values of the same canonical type: a missing field, a `null`, a string, a boolean, a date or a document never match. `$expr: { $lt: ["$age", 18] }` orders across BSON types (missing and null sort below every number; strings, documents, arrays, booleans and dates sort above), so it matches documents the query form does not — measured: `$.a > 1` selects 4 documents as a query and 11 as an expression over one fixture. The query form is the closer to JavaScript (`"hello" > 1` is false) and the indexable one. Same for `>`, `>=`, `<=`.

4. **`.includes()` on a receiver whose type can't be proved.** `$.tags.includes("vip")` becomes `{ tags: "vip" }`, MongoDB's "equals, or is an array containing" — which is exactly what `.includes` means on an array, and is indexed. In EXPRESSION position the same source dispatches on `$isArray` at runtime and does a SUBSTRING test when the value is a string. So on a string field the two select different documents. A receiver jsmql can prove is a string (`$.s.trim().includes(…)`, a string literal) never takes the query form at all — it falls back to `$expr` and the two agree. For a substring query on a bare field path, reach for `.match(/…/)`, which is indexable and unambiguous.

`test/query-expr-agreement.test.ts` runs both lowerings of the same source over the same documents on a live mongod and asserts each of these — the agreements AND the divergences. A divergence that is ever repaired fails that suite, so a fix cannot land silently.

3. **Field-to-field comparison.** `{ a: "$b" }` is a literal-string match against `"$b"`, NOT a field comparison. We avoid this entirely by refusing to translate `BinaryExpr` where both sides resolve as field paths — those stay in `$expr`.

6. **`%` truncates in the query language.** `{ a: { $mod: [2, 0] } }` truncates a double before dividing, so `a: 2.5` satisfies `$.a % 2 === 0`, where JavaScript's `2.5 % 2` is `0.5`. The expression form (`$mod` under `$expr`) does the same. A fractional field with a modulo test is a domain error either way; state the integer type where it matters. The negated form `$.a % 2 !== 0` is `{ a: { $not: { $mod: [2, 0] } } }`, and a query `$not` also selects a document whose `a` is missing, `null` or not a number — where JavaScript's `null % 2` is `0` and the test is false. A zero divisor never reaches the server: `$.a % 0 === 1` and `$divide($.a, 0)` are refused at compile time (the `remainder`/`division`/`$mod`/`$divide` rows state `nonZero: [1]`), because the server refuses it ("divisor cannot be 0") and JavaScript's `NaN` has no MongoDB value.

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
- **`typeof $.a === "undefined"` is absence.** JavaScript answers `"undefined"` for a field that is not there, so the query form is the presence test — `{ a: { $exists: false } }`, and `!==` gives `{ $exists: true }` — never `{ $type: "undefined" }`, which tests the deprecated BSON `undefined` type and matches no ordinary document. The expression form compares `$type` against `"missing"`, which is what `$type` answers for an absent field. The spelling map (`JS_TYPEOF_TO_BSON` in `src/registry/vocabulary.ts`) states `undefined → missing`.
- **`$sampleRate(rate)` is a top-level predicate.** Its one argument is a compile-time number from 0 to 1 (the row states `constant`, `slotType` and `slotRange`; the server refuses `2` and a string). Inside a `.some(…)` body it is refused with the way out (`$.items.some(…) && $sampleRate(…)`), because the server accepts it only against the top-level document and it has no expression form to fall back to; inside `||` it is accepted.
- **`.length` is a length.** The dot form `.length` is the length of a string or an array, whatever it is compared with: the comparison residualises into `$expr`, where the runtime dispatch on the receiver's type runs (`$size` for an array, `$strLenCP` for a string). It is never read as a field named `length`; a document field literally named `length` is reached with bracket access — `$["items.length"]` (a plain field reference on the root) or `$getField($.items, "length")`. Bracket access is raw data access and is never folded to a length (see [method-dispatch.md](method-dispatch.md)).
## Out of scope — rejected as bad DX

- **`!expr` via De Morgan.** Negation has subtle null/missing interactions in MongoDB — silent index/non-index flips driven by data shape are exactly the surprise jsmql aims to avoid. Users write positive forms or `$op($not, …)` explicitly. See `feedback_no_silent_output_drift.md` in user memory for the rationale.
- **Server-side JS predicates (`$where`) and a `function`-keyword sugar for `$function` / `$accumulator`.** jsmql's purpose is to compile JS to MQL on the *client*, not to ship JS to the server — and `$where` is deprecated. We will not add a `function` keyword that lowers to these. (`$function` / `$accumulator` stay reachable through the `$op(...)` escape hatch for the rare case server-side JS is genuinely needed.)

## Out of scope — future work

- **`in` operator** (jsmql's `BinaryExpr(in)`) — distinct from query-language `$in` and rarely the right translation. Stays rejected; `.includes()` covers the common case.
- **Partial extraction under `||`** [DEF-011] for the case where every branch has a translatable AND an untranslatable factor with matching shape — only useful in narrow cases.
- **`$jsonSchema`, `$geoWithin`, `$near`, `$text`** — query-only operators that have no idiomatic JS shape. Continue to use `$op($jsonSchema, …)` etc. as the escape hatch.
