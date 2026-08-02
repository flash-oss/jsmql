// `$out` collection-write translation: lowers `$$$.<coll> = <RHS>;` (same-db)
// and `$$$$.<db>.<coll> = <RHS>;` (cross-db), dot or string-bracket forms, into
// pipeline stages ending with `$out`. Statement-only and last-stage-only
// (`sawOut` blocks anything after it).
//
// LHS/RHS shape detection, the destination-bearing-LHS convention (vs `$ = …`),
// and the error catalog are owned by docs/specs/out-stage.md (convention also in
// docs/specs/replace-root-stage.md).

import type { Expr, AssignExpr, Pipeline, PipelineStmt, UpdateFilter, UpdateOp } from "./ast.ts";
import { CodegenError, freshSubPipelineCtx, type GenerateCtx } from "./codegen.ts";
import { lowerLambdaPredicate, type SubPipelineLowerer, type SlotAllocator } from "./lookup-translation.ts";
import { lookupStreamMethod } from "./stream-methods.ts";

// ── Detection ─────────────────────────────────────────────────────────────────

export type OutTarget =
  | { kind: "same-db"; coll: string; pos: number }
  | { kind: "cross-db"; db: string; coll: string; pos: number };

/**
 * One step of static (dot or string-literal-bracket) member access. Distinct
 * from `lookup-translation`'s helper because `$out` rejects computed brackets
 * outright (the destination must be statically known), while the lookup
 * helper silently returns null and lets the caller fall back.
 *
 * Returns `null` for non-access nodes (e.g. the leaf `DatabaseRef`).
 * Returns `{ ok: false, indexPos }` for a computed bracket — the caller
 * surfaces the precise "literal collection name" error using that pos.
 */
type AccessStep =
  | { ok: true; name: string; object: Expr }
  | { ok: false; indexPos: number; reason: "computed" | "non-string-binding" };

function classifyStep(node: Expr, ctx?: GenerateCtx): AccessStep | null {
  if (node.type === "MemberAccess") return { ok: true, name: node.member, object: node.object };
  if (node.type === "IndexAccess") {
    if (node.index.type === "StringLiteral") {
      return { ok: true, name: node.index.value, object: node.object };
    }
    // `jsmql.compile` parameter binding — resolve at compile time when the
    // value is a string. Anything else (number, array, missing binding) falls
    // through to the standard "must be literal / runtime expression" error.
    if (node.index.type === "ParamRef" && ctx?.bindings?.has(node.index.name)) {
      const value = ctx.bindings.get(node.index.name);
      if (typeof value === "string") {
        return { ok: true, name: value, object: node.object };
      }
      return { ok: false, indexPos: node.index.pos, reason: "non-string-binding" };
    }
    return { ok: false, indexPos: node.index.pos, reason: "computed" };
  }
  return null;
}

/**
 * Recognise the `$out` LHS shape on an `AssignExpr.target`. Returns the
 * extracted target on a match, or `null` if the shape isn't even close to
 * `$out`-like — in which case the caller falls through to its other branches
 * (replace-root, lookup, regular update op, etc.).
 *
 * When the shape *is* `$out`-like but malformed (wrong segment count,
 * computed bracket), this throws a precise `CodegenError` — that's what we
 * want, because the user clearly meant to address a collection but the
 * shape doesn't quite parse as one.
 */
export function detectOutAssign(op: AssignExpr, ctx?: GenerateCtx): OutTarget | null {
  const t = op.target;
  // Cheap pre-filter: must be a member/index chain ending in `DatabaseRef` or
  // `ClusterRef`. Anything else (FieldRef paths, bare CollectionRef, etc.) is
  // not an `$out` target.
  const leaf = findContextRefLeaf(t);
  if (leaf === null) return null;

  if (leaf.type === "DatabaseRef") {
    // Expect exactly one access step: `$$$.<coll>` or `$$$["<coll>"]`.
    const step = classifyStep(t, ctx);
    if (step === null) {
      // Bare `$$$` on the LHS (no segment) — `$$$ = $$;` would never reach this
      // branch (parser rejects assignment-to-non-path), but defend.
      throw new CodegenError(
        `'$$$' alone isn't a $out target — write '$$$.<coll>' (or '$$$["<coll>"]') to write to a collection in the local database.`,
        t.pos,
      );
    }
    if (!step.ok) {
      const why =
        step.reason === "non-string-binding"
          ? `the parameter binding must be a string (collection name is statically determined at compile time)`
          : `not a runtime expression`;
      throw new CodegenError(
        `'$out' target must be a literal collection name — use '$$$.<coll>' or '$$$["<coll>"]', ${why}. ` +
          `If you need a parameterised target, use 'jsmql.compile' and pass the name in.`,
        step.indexPos,
      );
    }
    // step.ok — verify the inner is `DatabaseRef` and nothing deeper.
    if (step.object.type !== "DatabaseRef") {
      // Two-or-more segments after `$$$` — `$$$.a.b = …`. Either too many segments
      // for same-DB or the user meant the cross-DB four-dollar form.
      throw new CodegenError(
        `'$$$.<a>.<b>' has too many segments for a same-database $out target — use '$$$$.<db>.<coll>' (four \$) for a cross-database write, ` +
          `or '$$$.<coll>' (three \$) for the local database.`,
        t.pos,
      );
    }
    return { kind: "same-db", coll: step.name, pos: t.pos };
  }

  // leaf is ClusterRef — expect exactly two access steps.
  const outer = classifyStep(t, ctx);
  if (outer === null) {
    // Bare `$$$$` on LHS — unreachable through the parser, but defend.
    throw new CodegenError(
      `'$$$$' alone isn't a $out target — write '$$$$.<db>.<coll>' (or its bracket equivalents) to write to a collection in another database.`,
      t.pos,
    );
  }
  if (!outer.ok) {
    const why =
      outer.reason === "non-string-binding"
        ? `the parameter binding must be a string (collection name is statically determined at compile time)`
        : `not a runtime expression`;
    throw new CodegenError(
      `'$out' target must be a literal collection name — use '$$$$.<db>.<coll>' or bracketed equivalents, ${why}. ` +
        `If you need a parameterised target, use 'jsmql.compile' and pass the name in.`,
      outer.indexPos,
    );
  }
  const inner = classifyStep(outer.object, ctx);
  if (inner === null) {
    // Only one segment after `$$$$` — `$$$$.<x> = …`. Missing the collection.
    throw new CodegenError(
      `'$$$$.<x>' is missing the collection — write '$$$$.<db>.<coll>' (db, then collection), ` +
        `or use '$$$.<coll>' (three \$) for the local database.`,
      t.pos,
    );
  }
  if (!inner.ok) {
    const why =
      inner.reason === "non-string-binding"
        ? `the parameter binding must be a string (database name is statically determined at compile time)`
        : `not a runtime expression`;
    throw new CodegenError(
      `'$out' target must be a literal database name — use '$$$$.<db>.<coll>' or bracketed equivalents, ${why}. ` +
        `If you need a parameterised target, use 'jsmql.compile' and pass the name in.`,
      inner.indexPos,
    );
  }
  if (inner.object.type !== "ClusterRef") {
    // Three or more segments after `$$$$` — `$$$$.a.b.c = …`. Too many.
    throw new CodegenError(
      `'$$$$.<a>.<b>.<c>' has too many segments for a $out target — '$out' writes to one collection in one database, so '$$$$.<db>.<coll>' is the deepest form.`,
      t.pos,
    );
  }
  return { kind: "cross-db", db: inner.name, coll: outer.name, pos: t.pos };
}

/**
 * Walk through member/index nesting to find the root context-ref leaf, if any.
 * Returns the leaf node so callers can branch on `DatabaseRef` vs `ClusterRef`,
 * or `null` if the chain doesn't bottom out in a context-ref (e.g. it's a
 * regular field path, a `CollectionRef`, etc.).
 */
function findContextRefLeaf(node: Expr): { type: "DatabaseRef" | "ClusterRef" } | null {
  let cur: Expr = node;
  for (;;) {
    if (cur.type === "DatabaseRef") return { type: "DatabaseRef" };
    if (cur.type === "ClusterRef") return { type: "ClusterRef" };
    if (cur.type === "MemberAccess" || cur.type === "IndexAccess") {
      cur = cur.object;
      continue;
    }
    return null;
  }
}

// ── RHS chain lowering ────────────────────────────────────────────────────────

/**
 * Walk the RHS chain rooted at `$$` (CollectionRef) and emit the prefix
 * pipeline stages, left-to-right. Returns the (possibly empty) stage list;
 * the caller appends the final `$out` stage.
 *
 * Supported RHS shapes:
 *   - bare `$$`                                    → []
 *   - `$$.filter(<predicate>)`                     → [{ $match: ... }]
 *   - chained stream-methods registry methods
 *     (`.slice`, `.map`, `.toSorted`, `.flatMap`,
 *     `.concat`) compose freely                    → [<their stages>...]
 *
 * Unrecognised methods throw an actionable error naming the
 * stage-call alternative.
 */
export function lowerOutChain(
  rhs: Expr,
  outerCtx: GenerateCtx,
  lowerBlock: SubPipelineLowerer,
  allocSlot: SlotAllocator,
): object[] {
  // Bare `$$` — no extra stages.
  if (rhs.type === "CollectionRef") return [];

  // A method-call chain — walk it inside-out, then emit stages in source order.
  if (rhs.type === "MethodCall") {
    return walkChain(rhs, outerCtx, lowerBlock, allocSlot);
  }

  // Anything else — the RHS isn't rooted at `$$`. Diagnose.
  throw new CodegenError(
    `The right-hand side of '$$$.<coll> = …' must start with '$$' (the current pipeline). ` +
      `Write '$$$.<coll> = $$' to write the current stream as-is, or '$$$.<coll> = $$.filter(<predicate>)' to pre-filter before writing.`,
    rhs.pos,
  );
}

/**
 * Recursively walk a `$$.<method>(…).<method>(…)…` chain. Emits stages in
 * source order. Each method-call layer must be one of the supported chain
 * methods (currently just `.filter`); unsupported methods throw with a
 * hint. The bottom of the chain must be a bare `$$` — anything else means
 * the chain isn't actually rooted at the current pipeline.
 */
function walkChain(
  call: Expr,
  outerCtx: GenerateCtx,
  lowerBlock: SubPipelineLowerer,
  allocSlot: SlotAllocator,
): object[] {
  if (call.type !== "MethodCall") {
    // Bottomed out somewhere other than `$$` — the chain isn't rooted at the
    // current pipeline.
    if (call.type === "CollectionRef") {
      // Defensive — should be unreachable because the entry point handles the
      // bare-CollectionRef case before calling walkChain.
      return [];
    }
    throw new CodegenError(
      `The right-hand side of '$$$.<coll> = …' must be a chain rooted at '$$' (the current pipeline). ` +
        `'$$$.<coll> = $$', '$$$.<coll> = $$.filter(<predicate>)' are the supported shapes today.`,
      call.pos,
    );
  }

  // First lower the receiver (the prefix of the chain), then append this
  // method's stage(s) so source order is preserved.
  const prefix: object[] =
    call.object.type === "CollectionRef" ? [] : walkChain(call.object, outerCtx, lowerBlock, allocSlot);

  const here = lowerChainMethod(call, outerCtx, lowerBlock, prefix, allocSlot);
  prefix.push(...here.stages);
  return prefix;
}

/**
 * Lower one method-call layer of a `$$.…` chain into one or more pipeline
 * stages. `.filter(<predicate>)` → `$match` is special-cased so it can
 * compose with the existing query-translator (and emit `$expr` residuals);
 * every other method is routed through the shared `STREAM_METHODS` registry
 * (`.slice`, `.map`, `.toSorted`, `.flatMap`, `.concat`).
 *
 * `prevStages` is passed through for the methods that read it
 * (`.takeWhile`/`.dropWhile` need a preceding `$sort`).
 */
function lowerChainMethod(
  call: Expr & { type: "MethodCall" },
  outerCtx: GenerateCtx,
  lowerBlock: SubPipelineLowerer,
  prevStages: readonly object[],
  allocSlot: SlotAllocator,
): { stages: object[] } {
  if (call.method === "filter") {
    return { stages: lowerFilterAsMatch(call, outerCtx, lowerBlock) };
  }
  const def = lookupStreamMethod(call.method);
  if (def !== null) {
    def.validate(call.args, call.pos);
    // `inSubPipeline = false` — `$out` chains live at the outer pipeline level,
    // not inside a `$unionWith.pipeline` body.
    const result = def.lower(call.args, outerCtx, call.pos, lowerBlock, prevStages, allocSlot, false);
    return { stages: result.stages };
  }
  // Method not in the stream-methods registry either. Mention the stage-call
  // alternative so the user has an immediate workaround.
  const equivalent = STAGE_EQUIVALENT_HINT[call.method];
  const hint =
    equivalent !== undefined
      ? ` Use '${equivalent}' as a separate stage before the '$out' instead.`
      : ` Add the equivalent stage call (e.g. '$sort({ … })', '$skip(N)', '$limit(N)') before the '$out' instead.`;
  throw new CodegenError(`'$$.${call.method}(...)' isn't a recognised chain method for a '$out' RHS.${hint}`, call.pos);
}

const STAGE_EQUIVALENT_HINT: Record<string, string> = {
  map: "$project({...}) or $addFields({...})",
  sort: "$sort({ field: 1 | -1 })",
  slice: "$skip(N); $limit(M)",
  reduce: "$group({ ... })",
  flatMap: "$unwind",
  flat: "$unwind",
};

/**
 * `$$.filter(<lambda>)` → `[{ $match: <translated> }]`. After validating the
 * arrow shape (exactly one single-parameter predicate), the body is lowered via
 * the shared `lowerLambdaPredicate` from lookup-translation, which both
 * lookup/union/facet use:
 *   - Expression body → match-translation's engine: translatable conjuncts emit
 *     index-friendly `{ field: value }` syntax, residuals ride in `$expr`.
 *   - Block body → the caller-supplied `lowerBlock` (each statement → a stage).
 * `$.<field>` references on the param are rejected — the parameter *is* the
 * current document, so they'd be ambiguous (mirrors the facet-form rule).
 */
function lowerFilterAsMatch(
  call: Expr & { type: "MethodCall" },
  outerCtx: GenerateCtx,
  lowerBlock: SubPipelineLowerer,
): object[] {
  if (call.args.length !== 1) {
    throw new CodegenError(
      `'$$.filter(<predicate>)' expects exactly one arrow predicate, got ${call.args.length}.`,
      call.pos,
    );
  }
  const arg = call.args[0];
  if (arg.type !== "Lambda") {
    throw new CodegenError(
      `'$$.filter(<predicate>)' requires an arrow predicate, e.g. \`$$$.coll = $$.filter(d => d.active)\`.`,
      "pos" in arg ? arg.pos : call.pos,
    );
  }
  if (arg.params.length !== 1) {
    throw new CodegenError(
      `'$$.filter(<predicate>)' takes a single-parameter arrow (the current document), got ${arg.params.length}.`,
      arg.pos,
    );
  }
  // Shared expr-or-block predicate lowering (see `lowerLambdaPredicate`). A
  // `$out` chain has no `let` slot, so a predicate that references the local doc
  // (`$.<field>`, captured as a non-empty `letVars`) is rejected in favour of the
  // lambda parameter.
  return lowerLambdaPredicate(arg, outerCtx, lowerBlock, {
    freshCtx: freshSubPipelineCtx,
    onLocalRef: (_letVars, param, pos) => {
      throw new CodegenError(
        `\`$.<field>\` inside '$$.filter(<predicate>)' in a '$out' chain is not supported — the lambda's parameter \`${param}\` IS the current document. ` +
          `Write \`${param}.<field>\` instead.`,
        pos,
      );
    },
    missingBody: () => {
      throw new CodegenError(
        `'$$.filter(<predicate>)' predicate has a block body with local \`const\`/\`let\` bindings, which isn't supported in this position. Write the predicate as a single expression — \`function (x) { return <expr> }\` / \`(x) => <expr>\` — and fold any bindings into <expr>.`,
        arg.pos,
      );
    },
  });
}

// ── Public entry point: lower an `$out` assignment to stages ──────────────────

/**
 * Compose RHS-prefix stages with the trailing `{ $out: <target> }`. Returns
 * the stage list to splice into the surrounding pipeline. The caller is
 * responsible for flushing any preceding update-op buffer and setting the
 * "saw $out" flag so subsequent statements throw the trailing-stage error.
 */
export function lowerOut(
  op: AssignExpr,
  target: OutTarget,
  outerCtx: GenerateCtx,
  lowerBlock: SubPipelineLowerer,
  allocSlot: SlotAllocator,
): object[] {
  const prefix = lowerOutChain(op.value, outerCtx, lowerBlock, allocSlot);
  const body: string | { db: string; coll: string } =
    target.kind === "same-db" ? target.coll : { db: target.db, coll: target.coll };
  prefix.push({ $out: body });
  return prefix;
}

// ── Mode-gate helper ──────────────────────────────────────────────────────────

/**
 * Cheap walk: does `node` contain an `$out` assignment? Used by Filter /
 * `jsmql.expr` mode gates to surface a precise "use Pipeline mode" error.
 * Recognising only the canonical AssignExpr-target shape (one or two
 * static accesses on `DatabaseRef`/`ClusterRef`) is enough — anything else
 * never participates in `$out` lowering anyway.
 */
export function containsOutAssign(node: Expr | Pipeline | UpdateFilter): boolean {
  return walkContainsOut(node);
}

function walkContainsOut(node: Expr | Pipeline | UpdateFilter | PipelineStmt | UpdateOp): boolean {
  if (node.type === "Pipeline") return node.stmts.some(walkContainsOut);
  if (node.type === "UpdateFilter") return node.ops.some(walkContainsOut);
  if (node.type === "AssignExpr") {
    // Looks-like-$out shape on the target?
    if (findContextRefLeaf(node.target) !== null) {
      // Confirm it really *is* an $out shape (vs a malformed one we'd reject).
      // We can't call `detectOutAssign` here because that throws on malformed
      // shapes; the mode-gate just wants to know if the user's syntax is
      // reaching for `$out` at all, malformed or not.
      return true;
    }
    return false;
  }
  if (node.type === "DeleteStmt") return false;
  if (node.type === "LetDecl") return false;
  if (node.type === "FuncDecl") return false;
  if (node.type === "ArrayLiteral") {
    for (const el of node.elements) {
      if (el.type === "SpreadElement") continue;
      if (walkContainsOut(el)) return true;
    }
    return false;
  }
  return false;
}
