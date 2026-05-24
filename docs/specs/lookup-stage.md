# `this.<collection>.find / .filter` → `$lookup`

## What this covers

The JS-style syntax for MongoDB's `$lookup` stage. `this.<coll>.find(predicate)` and `this.<coll>.filter(predicate)` lower to a `$lookup` stage (with an `$unwind` follow-up for `.find`). Anywhere the user previously reached for the raw `$lookup({ from, localField, foreignField, as })` callable, they can now write a JS-style join instead. The escape hatch is unchanged for cases the v1 surface doesn't cover.

User-facing reference: [docs/LANGUAGE.md → Cross-collection lookups](../LANGUAGE.md#cross-collection-lookups).

## Why `this.` and not `super.`

`super.<coll>.find(...)` was the first instinct — semantically perfect, but `super` is a `SyntaxError` outside class/method bodies, which violates the strippable-JS rule in the root `CLAUDE.md` (priority #2: every accepted construct must parse as valid JS when pasted into a `.js` file). `this.<coll>.find(...)` parses everywhere as valid JS, including the bare-arrow `($) => this.users.find(...)` form, so the rule is upheld.

## Grammar

A new primary expression `ThisRef` (lexer token `This`, AST node `{ type: "ThisRef"; pos }`). The token is recognised in `keywordToken()` in [src/lexer.ts](../../src/lexer.ts). It is also added to `isIdentOrKeyword` so JS-legal property uses (`obj.this`, `{ this: 1 }`) keep parsing.

The chain `this.<coll>.find(arrow)` parses through the existing `parsePostfix` machinery — no new productions — and yields:

```
MethodCall {
  object: MemberAccess { object: ThisRef, member: "<coll>" },
  method: "find" | "filter",
  args: [ Lambda { params: ["o"], body: BinaryExpr(===), ... } ]
}
```

The bracket form `this["user-orders"].filter(...)` yields `IndexAccess { object: ThisRef, index: StringLiteral }` and is also accepted (for collection names with hyphens or other non-identifier characters).

## Dispatch — Pipeline mode only

`$lookup` is a pipeline stage, so `this.<coll>` is **only valid inside a Pipeline-mode source**:

- `;`-separated source (`$.user = this.users.find(...);`) — accepted.
- Bracketed pipeline (`[$.user = this.users.find(...)]`) — accepted.
- Filter-mode source (no `;`, bare expression) — rejected with the codegen `ThisRef` error.
- `jsmql.filter()` — rejected via the same codegen `ThisRef` error.
- `jsmql.update()` — accepted by the parser; the generated `$lookup` stage is then rejected by the update-stage whitelist with `jsmql.update() rejected '$lookup' (stage N)` (the existing `UPDATE_PIPELINE_STAGES` check in [src/index.ts](../../src/index.ts) — `$lookup` is intentionally absent).

Implementation: [src/pipeline.ts](../../src/pipeline.ts) intercepts assignment ops whose RHS is a `this.<coll>.find/filter` chain in both `generateImplicitPipeline` and `generatePipeline` (via the `emitUpdateOpsWithLookups` helper). Anywhere else, the `case "ThisRef"` in `_generateBody` ([src/codegen.ts](../../src/codegen.ts)) throws the user-facing error explaining the valid shape and pointing at the `;`.

## Lowering rules

| Source | Output stages |
|---|---|
| `$.foo = this.coll.filter(o => o.fk === $.pk);` | `[ { $lookup: { from: "coll", localField: "pk", foreignField: "fk", as: "foo" } } ]` |
| `$.foo = this.coll.find(o => o.fk === $.pk);` | `[ { $lookup: { … as: "foo" } }, { $unwind: { path: "$foo", preserveNullAndEmptyArrays: true } } ]` |
| `$.a.b = this.coll.filter(...);` | `as: "a.b"` (MongoDB accepts dotted output paths in `$lookup.as`) |
| `this["my-coll"].filter(...)` | `from: "my-coll"` |

### `.find` returns one or null

`Array.prototype.find` in JS returns the first matching element or `undefined`. The closest MQL approximation that uses only basic-form `$lookup` is `$lookup` + `$unwind` with `preserveNullAndEmptyArrays: true`: when the lookup matches zero docs the row is preserved with the lookup field absent; when it matches one doc the field is that doc.

**Known caveat:** when the predicate matches *multiple* foreign docs, `$unwind` fans the pipeline out (one row per match). This diverges from the JS `find` contract (which always returns exactly one element). The basic-form `$lookup` cannot apply a `LIMIT 1` — that requires the pipeline form. Users who need scalar-or-null on a multi-match predicate must drop to `$lookup({ from, let, pipeline: [{ $match: ... }, { $limit: 1 }], as })` explicitly. Document this in `docs/LANGUAGE.md` so it isn't a surprise.

## Predicate translation — v1 boundary

`translateLookupEquality` in [src/lookup-translation.ts](../../src/lookup-translation.ts) accepts:

- A single-parameter arrow.
- A body that is one `===` (or `==`) `BinaryExpr`.
- Each side resolves to a static field path — either the lambda parameter chain (`o`, `o.a`, `o.a.b`) for `foreignField`, or `$.…` for `localField`. Dotted paths and bracket access for non-ident segments **on `this`** are supported; bracket access on the foreign param (e.g. `o["x"]`) is **not** v1 because basic-form `$lookup` is path-string-based and the helper's foreign-path walker mirrors `asFieldPath()`.

Anything else throws a `CodegenError` whose `.pos` points at the offending sub-expression. The error message always names the `$lookup({ from, let, pipeline, as })` escape hatch as the path forward.

### Why basic-form only

MongoDB's basic-form `$lookup` is *intrinsically* limited to two field-path strings. Any operand richer than a field path (computed values, method calls, additional conjuncts) cannot be expressed as `{ localField, foreignField }` — it requires the pipeline form (`let` + `pipeline: [{ $match: $expr: … }]`). Auto-generating that pipeline form is future work; the current v1 boundary is the rectangle MongoDB's own basic form already draws.

## Error catalog

All errors use `CodegenError` with a real `.pos` so `validate()` returns a usable offset.

| Trigger | Message (paraphrased) | Where |
|---|---|---|
| `this.<coll>` in Filter mode / no `;` | `\`this.<collection>\` is only valid in a \`;\`-terminated Pipeline statement as the head of a .find(predicate) or .filter(predicate) chain assigned to a field` | codegen `ThisRef` case |
| `this.<coll>` not followed by a method | `\`this.<collection>\` must be followed by .find(predicate) or .filter(predicate)` | `detectLookupAssign` |
| Wrong method, e.g. `.map(...)` | `\`this.<collection>\` supports .find(predicate) and .filter(predicate), not .map().` (+ `closestNameTo` suggestion) | `detectLookupAssign` |
| Chained `this.users.orders.find(...)` | `\`this.<collection>\` must be a direct property access — chained navigation … is not a join` | `detectLookupAssign` |
| Missing predicate, e.g. `.find()` | `.find(predicate) requires a predicate, e.g. …` | `detectLookupAssign` |
| Non-arrow predicate, e.g. `.find(123)` | `.find(predicate) requires an arrow predicate, e.g. …` | `detectLookupAssign` |
| Multi-param arrow | `.find(predicate) takes a single-parameter arrow (the foreign document), got N` | `translateLookupEquality` |
| Non-equality body | `.find() lookup predicate must be a field-path equality like 'o.x === $.y'` + escape-hatch hint | `translateLookupEquality` |
| Either side not a field path | `lookup predicate sides must be plain field paths …; MongoDB's basic-form $lookup cannot express computed joins.` + escape-hatch hint | `translateLookupEquality` |
| Both sides foreign | `predicate compares two foreign paths; at least one side must be a '$.x' local field.` | `translateLookupEquality` |
| Both sides local | `predicate compares two local paths; at least one side must be a 'o.x' foreign field.` | `translateLookupEquality` |
| `jsmql.update(…)` containing a lookup (with `;`) | `jsmql.update() rejected '$lookup' (stage N) …` | existing `UPDATE_PIPELINE_STAGES` whitelist |

## Future work — the grammar is reserved

The `this.<coll>.<method>(...)` shape is claimed as the cross-collection vocabulary. v1 only ships `.find` and `.filter`. Future methods must map to an **existing JS API** — no invented names. The defensible candidate today:

- `this.events.concat($ => …)` → `$unionWith`. `Array.prototype.concat` is a real JS method and "produce a sequence containing this followed by the argument" is a faithful reading of `$unionWith`.

`$graphLookup`, `$merge`, `$out` have no obvious existing-JS-API analog and naming is deferred until one is found. Leaving the slot empty is preferred over inventing a name that would lock users into vocabulary they can't transfer.

Other deferred work:

- **Pipeline-form auto-lowering.** When the predicate is richer than a single equality (`o.x === $.y && o.active`, computed joins, multi-conjunct correlated subqueries), auto-emit the pipeline form with `let` extraction. This needs a new `correlated-predicate-translation.ts` that knows the two binding sources (foreign param + `$`) and harvests `$.x` references into the `let` clause.
- **`this.<coll>` as a value outside an assignment** (`if (this.users.find(...).length > 0)`). `$lookup` can only appear as a stage, so this would have to precompute into an intermediate stage. Out of scope for v1.
