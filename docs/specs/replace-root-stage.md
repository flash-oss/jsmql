# `$ = <expr>` → `$replaceWith` / `$facet` stage

## Overview

`$ = <expr>` is the jsmql surface for MongoDB's `$replaceRoot` / `$replaceWith`
stage. The LHS is the bare `$` token — the document itself, the same role
MQL's `$$ROOT` plays — and the assignment reads as "replace the current
document with this expression."

We lower to `$replaceWith` (the shorter MQL spelling) rather than
`$replaceRoot: { newRoot: <expr> }` (the legacy spelling). They are exact
runtime equivalents on MongoDB 4.2+, and `$replaceWith: <expr>` is
substantially fewer characters than `$replaceRoot: { newRoot: <expr> }` — the
cost is the 4.0 / 4.1 line of server versions, which the rest of the
language already excludes by relying on 4.2+ features (`$function`, `let` on
`$lookup`, etc.).

Statement-only: `$ = <expr>` appears as a top-level pipeline statement —
either inside `[ ... ]` array-form or as a `;`-separated implicit-pipeline
statement (including inside a comma-separated update-filter chain like
`$.a = 1, $ = $.profile, $.b = 2`). Using it inside a Filter / `jsmql.expr`
goes through the normal pipeline-mode-required gate.

See [`docs/LANGUAGE.md#replace-root`](../LANGUAGE.md#replace-root) for the
user-facing reference.

## Lowering table

| Input | Output stage(s) |
|---|---|
| `$ = $.profile` | `{ $replaceWith: "$profile" }` |
| `$ = $` | `{ $replaceWith: "$$ROOT" }` (identity — bare `$` lowers to `"$$ROOT"`) |
| `$ = $mergeObjects($.a, $.b)` | `{ $replaceWith: { $mergeObjects: ["$a", "$b"] } }` |
| `$ = { ...$, x: 1 }` | `{ $replaceWith: { $mergeObjects: ["$$ROOT", { x: 1 }] } }` |
| `$ = $$$.coll.find(pred)` (direct lookup) | `{ $lookup: { …, as: "__jsmql.__lookupN" } }`, `{ $replaceWith: { $first: "$__jsmql.__lookupN" } }`, trailing `{ $unset: "__jsmql" }` |
| `$ = $.foo + $$$.coll.find(pred).count` (buried lookup) | Prologue `$lookup` + `$set $first` stages for the buried lookup, then `{ $replaceWith: <rewritten-expr> }` |

For the direct-lookup variant we deliberately skip the `$set { slot: $first slot }`
step that `lowerLookup` emits for the assignment-target form (`$.users = …`).
The slot is discarded immediately by the `$replaceWith` anyway, so we save
one stage by folding `$first` into the `$replaceWith` body. The trailing
`$unset: "__jsmql"` still fires (it's pipeline-wide, not per-stage) — it's
harmless after `$replaceWith` because the namespace field is already gone.

## Bare `$` is `$$ROOT`

Bare `$` (no `.<field>` suffix, no following identifier for `$op(...)`) is a
new primary expression. The AST representation is `FieldRef { path: "" }`
— reusing the existing node rather than minting a `RootRef` variant — and
codegen lowers any empty-path `FieldRef` to the string `"$$ROOT"` (the MQL
spelling for the current document). The rule is universal: anywhere a
field path is valid, bare `$` produces `"$$ROOT"`, e.g.

```
jsmql.expr("$mergeObjects($, { x: 1 })")
// → { $mergeObjects: ["$$ROOT", { x: 1 }] }
```

This is why `$ = { ...$, … }` works with no spread-specific code in
`lowerReplaceRoot` — the spread codegen already emits `$mergeObjects`
operands by calling `_generate(arg, ctx)`, and the first operand for a bare
`$` is just `"$$ROOT"`.

## Facet variant

When the RHS of `$ = …` is an object literal where every value is a
`$$.filter(<lambda>)` call, the same `$ = { … }` surface lowers to a
`$facet` stage instead of `$replaceWith`. The detection lives in
`src/facet-translation.ts` and runs *before* the `$replaceWith` emission
inside `lowerReplaceRoot`'s callers:

```
$ = {
  topByScore: $$.filter(o => { $sort({ score: -1 }); $limit(10); }),
  recent:     $$.filter(o => o.createdAt >= "2026-01-01"),
  byStatus:   $$.filter(o => { $group({ _id: o.status, n: $sum(1) }); }),
};
// → [{ $facet: {
//       topByScore: [{ $sort: { score: -1 } }, { $limit: 10 }],
//       recent:     [{ $match: { createdAt: { $gte: "2026-01-01" } } }],
//       byStatus:   [{ $group: { _id: "$status", n: { $sum: 1 } } }]
//   } }]
```

**Detection — all-or-nothing.** `detectFacetShape(value)`:

1. If `value` isn't an `ObjectLiteral`, returns `null` (caller falls through to `$replaceWith`).
2. Scans for any entry whose value is a `$$.filter(<lambda>)` call.
   - Zero filter entries → returns `null`. The RHS is treated as a normal `$replaceWith` body.
   - At least one filter entry → enters strict-shape mode: *every* entry must be a `$$.filter(<lambda>)`. Mixed shapes throw a precise error naming the offending key (`Entry 'b' is something else. Either convert it to '$$.filter(<predicate>)' or move it out of the object.`).

Spread entries (`...rest`) and computed keys are also rejected in strict mode.

**Each filter lambda becomes one sub-pipeline body.** `lowerFacetEntry(lambda, ctx, lowerBlock)`:

- Lambda must take exactly one parameter — the doc is named explicitly so the rejection message for `$.<field>` references can point at the right replacement (`o.<field>`).
- Expression body: rewritten via `extractLetsFromExpr` (foreign param → `FieldRef`), then run through `translateMatchBody` (same engine `$match` uses). Translatable portions emit index-friendly `{ field: value }`; residuals ride in `$expr` side-by-side.
- Block body: rewritten via `extractLetsFromPipeline`, then lowered via `lowerBlock` (same `SubPipelineLowerer` used by lookup and union).
- **`$.<field>` is rejected.** If `extractLetsFromExpr` / `extractLetsFromPipeline` returns any letVars (= the predicate referenced the local doc), the helper throws: `\`$.<field>\` inside \`$$.filter(p)\` in a \`$ = { ... }\` $facet is not supported — use the lambda parameter …`. Rationale: inside a facet sub-pipeline, the lambda param IS the current document, so `$.x` and `o.x` would mean the same thing — supporting both invites drift. (Contrast with `$lookup`, where `$.x` refers to the *outer* doc and gets auto-`let`-extracted.)

**Reshape-clearing.** `$facet` joined `RESHAPE_CLEARING_STAGES` in this work (it was a pre-existing oversight — `$facet`'s output is `{ facetName: […], … }`, completely replacing the input doc). The interception in `pipeline.ts` calls `clearCtxLets(ctx, "$facet")` after emission so a subsequent let reference produces the existing precise "can't be read after `$facet`" error.

**Parser tweak.** Block-body lambdas (`o => { stmts; }`) inside method calls were previously allowed only when the receiver chain was rooted at `$$$` / `$$$$` (lookup). The new facet form needs block bodies for `$$.filter(...)` too, so the gate in `parsePostfix` now also allows `left.type === "CollectionRef"` for `.filter`. No new tokens or AST nodes — block-body parsing was already implemented, just gated by receiver shape.

**Statement-position `$$.filter(...)`.** `validateUnionPushShape` (now misleadingly named, kept for stability) emits a targeted error when a user writes `$$.filter(...)` at a statement position rather than inside the facet object: it suggests `$match(<predicate>)` for stream-level filtering or the `$ = { ... }` shape for facets. The bare-`$$` codegen message in `codegen.ts` was updated in parallel to mention both `.push` and `.filter`.

## Detection

`isReplaceRootAssign(op)` (in `src/pipeline.ts`) recognises the shape:

```ts
op.target.type === "FieldRef" && op.target.path === ""
```

Different from `$.<x> = <expr>` (non-empty path) and from any `MemberAccess`
chain (different node type). The interception fires before the update-op
buffer in three places — both pipeline entry points and the
update-filter-with-lookups inner loop:

- `generatePipeline` (the `[ … ]` form) — line ~196 in `src/pipeline.ts`
- `generateImplicitPipeline` (the `;` form, via `lowerUpdateFilterWithLookups`)
- `lowerUpdateFilterWithLookups` (one `,`-chained UpdateFilter statement)

Because the interception runs first, `updateOpWritePath` / `validateUpdateTarget`
never see an empty-path target through the assignment path, and the
existing invariants for those helpers are untouched.

## Validation

`lowerReplaceRoot` rejects four shapes before any stage is emitted, each
with a message that names a concrete fix:

| Trigger | Message excerpt |
|---|---|
| `BinaryExpr` whose `.left === target` by reference identity (compound desugar `$++`, `$ += 5`, `$--`, `$ *= 2`, etc.) | `Cannot use compound assignment / increment on bare '$' — '$' is the whole document, not a scalar. Use '$ = { ...$, ...overrides }' to merge fields into the root or '$ = <newRoot>' to replace it outright.` |
| `ArrayLiteral` RHS (e.g. `$ = [1, 2]`) | `Cannot replace root with an array. Use '.find(...)' for a single doc, or wrap: '$ = { items: [...] }'.` |
| Number / BigInt / String / Boolean / Null / Regex literal RHS | `Cannot replace root with a <kind> — the new root must be a document. Did you mean to wrap it: '$ = { value: ... }'?` |
| Direct `$$$.<coll>.filter(pred)` RHS (array result) | `Cannot replace root with an array — '.filter(...)' returns an array. Use '.find(...)' for a single matching doc, or wrap: '$ = { items: $$$.<coll>.filter(...) }'.` |

Compound-desugar detection works by referential identity rather than a
parser flag: `parsePrefixIncDec` (`src/parser.ts:860`), the postfix branch
in `parseUpdateOp` (around line 749), and the compound branch in
`parseAssignmentChainFrom` (line 799) all build a `BinaryExpr` that *reuses*
the original `target` node as `left`. Two different syntactic occurrences
of `$` are distinct AST nodes (the lexer and parser don't memoise), so
`el.value.type === "BinaryExpr" && el.value.left === el.target` only fires
for the synthesised compound shape.

Anything not in the table passes through. MongoDB validates the document-shape
at runtime — e.g. `$ = $.points * 1.1` produces a numeric `$multiply` that
the server rejects, but compile-time we can't distinguish that from a
legitimate sub-document expression.

Two related parse-time rejections (in `pipeline.ts`, not `parser.ts`):

| Trigger | Message excerpt |
|---|---|
| `delete $` (bare `$` as a DeleteStmt target) | `Cannot 'delete $' — bare '$' is the whole document. Use '$ = <newDoc>' to replace it, or 'delete $.<field>' to drop a single field.` |
| (covered above) `$++`, `$--`, `$ += …`, `$ -= …`, `$ *= …`, `$ /= …` | Same compound-desugar message |

The parser doesn't pre-reject any of these — `isFieldPathTarget` already
accepts `FieldRef { path: "" }` (it returns `true` for any FieldRef). All
the rejections live in `lowerReplaceRoot` / pipeline lowering so the same
parser path serves both the "good" form (`$ = X`) and the bad ones (`$++`,
`delete $`), and the error message can carry the right `.pos` (RHS for
assignment-shape errors; the statement itself for delete/inc-dec).

## Interaction with `$set` / `$unset`

`$replaceWith` is in `RESHAPE_CLEARING_STAGES` (already, before this work).
Concretely:

1. **Update buffer flushes before `$ = …`.** The pipeline lowerer calls
   `flushUpdateOps()` immediately before invoking `lowerReplaceRoot`. So
   `$.a = 1; $ = $.profile;` emits `[{ $set: { a: 1 } }, { $replaceWith: "$profile" }]`
   — never one merged `$set`.
2. **Subsequent `$.x = …` ops start a fresh buffer.** They operate on the
   new root, not the pre-replace one.
3. **Let scope clears.** `ctx = clearCtxLets(ctx, "$replaceWith")` runs in
   all three interception sites. A later `let`-binding reference produces
   the existing precise error: `` `x` is a `let` binding and can't be read after `$replaceWith` — the stage replaces the document. ``. The
   `lowerUpdateFilterWithLookups` helper changed signature to return both
   `stages` and `ctx` (instead of just `stages`) to thread this update back
   to the outer pipeline loop in `generateImplicitPipeline`.

## Module layout

```
src/
  parser.ts                Updated. parsePrimary's TokenType.Dollar branch
                           now peeks at the next token: if not an identifier-
                           like keyword, returns FieldRef { path: "" } instead
                           of falling through to parseOperatorCall. One added
                           branch; no new TokenType or AST node.
  codegen.ts               Updated. FieldRef case in _generate() and
                           asFieldPath() both special-case empty path →
                           "$$ROOT". No other call site touches FieldRef.
  pipeline.ts              Updated. Adds isReplaceRootAssign,
                           lowerReplaceRoot, rejectNonDocumentReplaceRoot.
                           Wires the interception into generatePipeline,
                           lowerUpdateFilterWithLookups. Inserts the bare-$
                           DeleteStmt rejection in two places.
                           lowerUpdateFilterWithLookups now returns
                           { stages, ctx } so the let-clearing flows out.
  lookup-translation.ts    No change. translatePredicate is already exported
                           and is reused by lowerReplaceRoot's direct-lookup
                           branch.
  stages.ts                No change. $replaceWith was already registered.
  facet-translation.ts     New. detectFacetShape, lowerFacet, lowerFacetEntry.
                           Reuses extractLetsFromExpr / extractLetsFromPipeline
                           from lookup-translation and translateMatchBody from
                           match-translation. Treats any non-empty letVars as
                           a "use lambda param instead of $.<field>" error.
  union-translation.ts     Updated. validateUnionPushShape recognises a
                           statement-position $$.filter call and emits a
                           "use $match or move into facet" hint; other
                           wrong-method calls mention both .push and .filter
                           as supported.
```

## Deferred

- **Trailing `$unset` after a final `$ = …`.** When the pipeline's last stage
  is `$replaceWith` and no later stage uses the namespace, the trailing
  `$unset: "__jsmql"` is harmless but unnecessary (the field doesn't exist
  on the post-replace document). Folding it away would be a small win; out
  of scope for this release.
- **`$replaceRoot` as an alternative target.** If a user explicitly wants
  the verbose 4.0-compatible shape, they can still write
  `$replaceRoot({ newRoot: <expr> })` directly — the stage-call form is
  unchanged. We don't currently offer a knob to make `$ = …` lower to the
  verbose form.
- **Type-aware non-document rejection.** Beyond the literal-type rejections
  above, we could in principle detect `$ = <BinaryExpr with arithmetic ops>`
  as obviously-not-a-doc. Skipped: the MongoDB runtime error names the
  offending stage and is precise enough; the extra rules would risk
  false positives on legitimate `{ $cond: … }` and `$let`-style expressions.
