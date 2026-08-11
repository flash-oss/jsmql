// `$out` collection-write translation: lowers `$$$.<coll> = <RHS>;` (same-db)
// and `$$$$.<db>.<coll> = <RHS>;` (cross-db), dot or string-bracket forms, into
// pipeline stages ending with `$out`. Statement-only and last-stage-only
// (`sawOut` blocks anything after it).
//
// LHS/RHS shape detection, the destination-bearing-LHS convention (vs `$ = …`),
// and the error catalog are owned by docs/specs/out-stage.md (convention also in
// docs/specs/replace-root-stage.md).

import type { Expr, AssignExpr, Pipeline, PipelineStmt, UpdateFilter, UpdateOp } from "./ast.ts";
import { STREAM_STAGE_REWRITE } from "./callback-block.ts";
import { internalError, CodegenError, freshSubPipelineCtx, type GenerateCtx } from "./codegen.ts";
import {
  localRefInPredicateMessage,
  lowerLambdaPredicate,
  negateStreamPredicate,
  requireStreamPredicate,
  type SubPipelineLowerer,
  type SlotAllocator,
} from "./lookup-translation.ts";
import { prepareStreamArgs, lookupStreamMethod, streamMethodNames } from "./stream-methods.ts";
import { didYouMean } from "./levenshtein.ts";
import { checkStageLinkPlacement, isStageLink, stageLinkBlock, stageLinkBody } from "./stage-link.ts";

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
 * `.$stage(<body>)` is a chained pipeline stage. Every other method is routed
 * through the shared `STREAM_METHODS` registry (`.slice`, `.map`, `.toSorted`,
 * `.flatMap`, `.concat`).
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
  // `.$sort({ … })` — a chained pipeline stage before the write. The `$out`
  // chain lives at the OUTER pipeline level, so a stage link here is an
  // ordinary top-level stage: run its one-statement block through the same
  // lowerer the statement form uses. `isLastInContainer: false` because the
  // `$out` itself always follows, which rejects a second write stage.
  if (isStageLink(call)) {
    const body = stageLinkBody(call);
    checkStageLinkPlacement(call.method, call.pos, prevStages.length, false, "top");
    return { stages: lowerBlock(stageLinkBlock(call, body), outerCtx) };
  }
  if (call.method === "filter" || call.method === "reject") {
    return { stages: lowerFilterAsMatch(call, outerCtx, lowerBlock) };
  }
  const def = lookupStreamMethod(call.method);
  if (def !== null) {
    const args = prepareStreamArgs(def, call.args, call.pos, STREAM_STAGE_REWRITE);
    // `inSubPipeline = false` — `$out` chains live at the outer pipeline level,
    // not inside a `$unionWith.pipeline` body.
    const result = def.lower(args, outerCtx, call.pos, lowerBlock, prevStages, allocSlot, false);
    return { stages: result.stages };
  }
  // Method in neither the stage-link form nor the stream-methods registry. Suggest a
  // near-miss name, then point at the stage-call escape hatch as the workaround.
  const suggestion = didYouMean(call.method, ["filter", "reject", ...streamMethodNames()], (s) => `.${s}()`);
  const equivalent = STAGE_EQUIVALENT_HINT[call.method];
  const hint =
    equivalent !== undefined
      ? ` Use '${equivalent}' as a separate stage before the '$out' instead.`
      : ` Add the equivalent stage call before the '$out' — either chained ('$$.$<stage>({ … })') or as its own statement.`;
  throw new CodegenError(
    `'$$.${call.method}(...)' isn't a recognised chain method for a '$out' RHS.${suggestion}${hint}`,
    call.pos,
  );
}

/** Where a `$out` write chain's predicate sits, for the shared gate's messages. */
const OUT_PREDICATE_POSITION = "in a '$out' write chain";

/**
 * Stage equivalents for JS methods a user might reasonably reach for that a stream
 * chain deliberately does NOT carry. Only reached when `lookupStreamMethod` returns
 * null, so a method that IS in the registry must never appear here — it would be
 * dead weight suggesting a workaround for something that already works. (`.map`,
 * `.sort`, `.slice` and `.flatMap` sat here for exactly that reason until the
 * registry grew to cover them.)
 */
const STAGE_EQUIVALENT_HINT: Record<string, string> = { reduce: "$group({ ... })", flat: "$unwind" };

/**
 * `$$.filter(<predicate>)` / `$$.reject(<predicate>)` → `[{ $match: <translated> }]`.
 * The argument goes through the shared gate (`requireStreamPredicate`), so an arrow
 * and its matches-object / field-name / `["field", value]` equivalents all lower
 * identically here — same vocabulary as the `$$ =` stream and a `$facet` branch.
 * `.reject` is `.filter` negated via the shared `negateStreamPredicate`, so the pair
 * stays in lockstep here as it does in a `$$ =` chain.
 * The normalised lambda is then lowered via the shared `lowerLambdaPredicate`,
 * which lookup/union/facet use too:
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
  const method = call.method;
  if (call.args.length !== 1) {
    throw new CodegenError(
      `'$$.${method}(<predicate>)' takes exactly one predicate argument, got ${call.args.length}.`,
      call.pos,
    );
  }
  const predicate = requireStreamPredicate(call.args[0], { method, position: OUT_PREDICATE_POSITION, pos: call.pos });
  // `.reject` negates the same predicate `.filter` would have matched. A `$let` body
  // has no single expression to invert, so that combination is rejected rather than
  // silently dropping the negation.
  const arg = method === "reject" ? negateStreamPredicate(predicate) : predicate;
  if (arg === null) {
    throw new CodegenError(
      `'$$.reject(<predicate>)' ${OUT_PREDICATE_POSITION} takes a single-parameter expression arrow ('o => …') — ` +
        `a body with local \`const\`/\`let\` bindings has no single expression to negate. Write the negation yourself with '$$.filter(o => !(…))', ` +
        `or use a block-bodied '$$.filter' with the inverted condition.`,
      predicate.pos,
    );
  }
  // Shared expr-or-block predicate lowering (see `lowerLambdaPredicate`). A
  // `$out` chain has no `let` slot, so a predicate that references the local doc
  // (`$.<field>`, captured as a non-empty `letVars`) is rejected in favour of the
  // lambda parameter.
  return lowerLambdaPredicate(arg, outerCtx, lowerBlock, {
    freshCtx: freshSubPipelineCtx,
    onLocalRef: (letVars, param, pos) => {
      throw new CodegenError(
        localRefInPredicateMessage({ letVars, param, method, position: OUT_PREDICATE_POSITION }),
        pos,
      );
    },
    missingBody: () => internalError(`'$$.${method}(<predicate>)' lambda has no body, block, or exprBlock`, arg.pos),
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
