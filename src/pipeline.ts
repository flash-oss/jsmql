// Pipeline detection and lowering.
//
// Owns everything stage-related so codegen.ts stays focused on a single
// expression. Public surface:
//   - isPipelineAst(ast)   — true if the AST root looks like an aggregation pipeline
//   - generatePipeline(ast) — compile a pipeline-shaped AST to an MQL stage array
//
// Detection rule: the AST root is an ArrayLiteral whose *first* element is a
// recognised stage shape (single-key object literal `{ $stage: body }` whose
// key is in STAGES, or `$stage(body)` whose name is in STAGES). Once
// triggered, every remaining element must also be a stage shape — otherwise
// CodegenError pinpoints the offending element. If the first element does
// not look like a stage, the array is left to the existing expression-mode
// codegen (so `jsmql("[1, 2, 3]")` still compiles as a literal array).
//
// $match has a special-case body lowering with two layers:
//   1. An object-literal body is treated as a raw MongoDB query document and
//      passed through verbatim. This is the explicit escape hatch for users
//      who want strict aggregation `$eq` semantics (`$match({ $expr: ... })`).
//   2. An expression body goes through `translateMatchBody` (see
//      `match-translation.ts`), which emits an index-friendly query document
//      for the translatable subset (field-vs-literal comparisons combined
//      with `&&`/`||`). Untranslatable sub-expressions are returned as a
//      residual and wrapped in `$expr`, yielding e.g.
//      `{ $match: { status: "active", $expr: <residual> } }` — indexes still
//      apply to the `status` predicate.
// See `docs/specs/match-query-translation.md` for the translation rules and
// the four documented semantic divergences between query-language equality
// and aggregation `$eq`.
//
// `let` bindings (see docs/specs/let-bindings.md) are pipeline-scoped local
// variables that materialise under a single compiler-owned namespace field
// (`__jsmql.<name>`) for the duration of the pipeline, with one trailing
// `$unset: "__jsmql"` stage to clean up. The let scope is threaded through
// stage lowering via a GenerateCtx so subsequent stages can resolve bare-
// identifier references to the corresponding field path. Reshape-clearing
// stages (`$group`, `$bucket`, `$bucketAuto`, `$replaceRoot`, `$replaceWith`)
// drop the document and so drop all lets; later references become precise
// "let X can't be read after $group" errors. Sub-pipelines (`$lookup.pipeline`,
// `$unionWith.pipeline`, `$facet.*`) get a fresh empty let scope — outer lets
// do not cross sub-pipeline boundaries in v1. The `$match` translator returns
// AST residuals that the caller re-lowers; we re-lower them with the current
// pipeline ctx so a let referenced inside an otherwise-translatable $match body
// still resolves correctly.

import type {
  Expr,
  ArrayElement,
  UpdateOp,
  AssignExpr,
  Pipeline,
  LetDecl,
  PipelineStmt,
  UpdateFilter,
  CallArg,
} from "./ast.ts";
import {
  generateWithCtx,
  generateUpdateOpGroups,
  generateUpdateFilter,
  updateOpWritePath,
  tryRewriteMutatorCall,
  CodegenError,
  EMPTY_CTX,
  extendCtxLets,
  clearCtxLets,
  ctxHasLets,
  freshSubPipelineCtx,
  internalError,
  type GenerateCtx,
} from "./codegen.ts";
import { didYouMean } from "./levenshtein.ts";
import { lookupStage, STAGES, stageMustBeFirst, stageMustBeLast, stageForbiddenIn } from "./stages.ts";
import { translateMatchBody } from "./match-translation.ts";
import {
  buildPipelineFormPredicate,
  detectLookupCall,
  lowerLookup,
  extractLookupCalls,
  createSlotAllocator,
  predicateReferencesOuterDoc,
  validateLookupShape,
  translatePredicate,
  extractLookupTarget,
  lowerLambdaPredicate,
  type LookupCall,
  type SlotAllocator,
  type SubPipelineLowerer,
} from "./lookup-translation.ts";
import { detectUnionPush, lowerUnionPush, validateUnionPushShape } from "./union-translation.ts";
import { detectFacetShape, lowerFacet } from "./facet-translation.ts";
import { validateStageBody, validateMatchPlacement } from "./stage-validation.ts";
import { detectOutAssign, lowerOut } from "./out-translation.ts";
import {
  isSystemStageCall,
  notFirstStageMessage,
  resolveSystemStageCall,
  type SystemStageCall,
} from "./system-stage-translation.ts";
import {
  collectStreamChain,
  detectArrayReducerWrap,
  detectDictBuildWrap,
  detectReduceWrap,
  lookupStreamMethod,
  lowerDictBuildWrap,
  lowerReduceWrap,
  streamMethodNames,
  type ArrayReducerWrap,
  type MethodCallNode,
} from "./stream-methods.ts";

type StageShape = { name: string; body: Expr };

/** Stages that replace the document and so drop all in-scope `let` bindings. */
const RESHAPE_CLEARING_STAGES = new Set(["$group", "$bucket", "$bucketAuto", "$replaceRoot", "$replaceWith", "$facet"]);

/** Compiler-owned namespace for materialised `let` bindings. */
const LET_NAMESPACE = "__jsmql";

/**
 * Peephole: skip the trailing `{ $unset: "__jsmql" }` cleanup when the
 * previous stage already dropped the document (Wave 5 #36). After
 * `$replaceWith` / `$replaceRoot` / `$group` / `$bucket*` / `$facet`, the
 * `__jsmql` field no longer exists on the output doc — cleaning up an
 * absent path is just noise. One stage saved per pipeline in the common
 * case.
 *
 * Detection mirrors RESHAPE_CLEARING_STAGES: any stage that the
 * scope-clearing machinery already treats as a reshape boundary also
 * eats the namespace field, so the cleanup is unconditionally redundant
 * after it.
 */
function shouldSkipTrailingNamespaceUnset(stages: readonly unknown[]): boolean {
  if (stages.length === 0) return false;
  const last = stages[stages.length - 1];
  if (last === null || typeof last !== "object") return false;
  const keys = Object.keys(last as Record<string, unknown>);
  if (keys.length !== 1) return false;
  return RESHAPE_CLEARING_STAGES.has(keys[0]);
}

/**
 * Loose detection: does `el` look like the user *intended* a pipeline stage?
 * Used only for top-level detection so a typo like `{ $macth: ... }` triggers
 * pipeline mode and surfaces a precise error instead of silently compiling
 * the array as a value expression. Returns true for:
 *   - any single- or multi-entry ObjectLiteral whose first static key starts
 *     with `$` (covers correctly-spelled stages, typos, and accidental
 *     multi-key stage objects)
 *   - any OperatorCall whose name is a registered stage
 * False for plain values, computed keys, spreads, expression operator calls,
 * etc. — these stay in expression mode.
 */
function isStageCandidate(el: ArrayElement): boolean {
  if (el.type === "SpreadElement") return false;
  // Update ops (`$.a = 1`, `delete $.x`) and `let` bindings are pipeline
  // statements — they lower to $set / $unset stages. Recognising them here
  // flips the array into pipeline mode even when no `$stage`-shaped element
  // comes first (`[let x = 5, $match(x > 0)]` is a pipeline).
  if (el.type === "AssignExpr" || el.type === "DeleteStmt" || el.type === "LetDecl") {
    return true;
  }
  if (el.type === "ObjectLiteral") {
    if (el.entries.length === 0) return false;
    const first = el.entries[0];
    if (first.type !== "KeyValueEntry") return false;
    if (first.key.kind !== "static") return false;
    return first.key.name.startsWith("$");
  }
  // Any `$<name>(...)` call at the array root is treated as a stage candidate
  // — even when `<name>` isn't a known stage. This makes typos like
  // `$prject({...})` surface a "not a known stage" error instead of silently
  // compiling as a value array of expression-operator results. Top-level
  // value arrays of operator calls are vanishingly rare in real aggregation
  // use; copy-pasted MongoDB pipelines are the common case.
  if (el.type === "OperatorCall") return true;
  // `$$.push(...)` is a stage-shaped statement — it lowers to `$unionWith`
  // stages. Recognising it here flips the array into pipeline mode so a
  // bracketed `[$$.push(...), $sort(...)]` works and a sub-pipeline carrying
  // a push (e.g. `$facet.*`) routes through the sub-pipeline path that
  // pre-rejects it with a precise hoist-to-outer hint.
  if (el.type === "MethodCall" && detectUnionPush(el as Expr) !== null) return true;
  // `$$.indexStats()` / `$$$$.currentOp()` / `$$$$.shardedDataDistribution()` —
  // a diagnostic source stage. Direct method call on a bare context-ref node;
  // it lowers to a `$<stage>` source. Recognising it here flips a bracketed
  // `[$$.indexStats(), $sort(...)]` into pipeline mode (same pattern as the
  // `detectUnionPush` line above).
  if (el.type === "MethodCall" && isSystemStageCall(el as Expr)) return true;
  return false;
}

/**
 * Strict shape validation for elements once pipeline mode is active. Returns
 * null when the element does not validate as a real stage; callers turn that
 * into a precise CodegenError via formatNotAStageError.
 */
function asStageShape(el: ArrayElement): StageShape | null {
  if (el.type === "SpreadElement") return null;

  // Stage-object form: `{ $stage: <body> }` — single static $-key.
  if (el.type === "ObjectLiteral") {
    if (el.entries.length !== 1) return null;
    const entry = el.entries[0];
    if (entry.type !== "KeyValueEntry") return null;
    if (entry.key.kind !== "static") return null;
    if (!lookupStage(entry.key.name)) return null;
    return { name: entry.key.name, body: entry.value };
  }

  // Stage-call form: `$stage(<body>)` or `$stage({ ... })` — exactly one arg.
  if (el.type === "OperatorCall") {
    if (!lookupStage(el.name)) return null;
    if (el.args.length !== 1) return null;
    const arg = el.args[0];
    if (arg.type === "SpreadElement") return null;
    return { name: el.name, body: arg };
  }

  return null;
}

export function isPipelineAst(ast: Expr): boolean {
  if (ast.type !== "ArrayLiteral") return false;
  if (ast.elements.length === 0) return false;
  return isStageCandidate(ast.elements[0]);
}

// ── Structural stage-placement validation ──────────────────────────────────────
//
// MongoDB rejects a pipeline at build time when a stage sits in an illegal
// position: a source stage ($geoNear, $collStats, $changeStream, …) anywhere
// but first; a write stage ($out, $merge) anywhere but last; a stage forbidden
// inside a $facet / $lookup / $unionWith sub-pipeline. We catch all of these at
// compile time. The rules live declaratively in the STAGES registry (`position`
// / `forbiddenIn`, read via stageMustBeFirst / stageMustBeLast / stageForbiddenIn);
// this validator only applies them. See docs/specs/pipeline-validation.md.
//
// The sugar forms ($out via `$$$.<coll> = …`, system stages via
// `$$.indexStats()`) keep their own dedicated, sugar-aware messages and feed
// this validator through `markSugarOut` for the must-be-last "after" error.

type ContainerKind = "top" | "facet" | "lookup" | "unionWith";

type TerminalState = { stageName: string; pos: number; viaSugar: boolean };

type PipelineValidator = {
  /** Call at the top of every element/statement iteration, before lowering it. */
  checkBeforeElement: (pos: number) => void;
  /**
   * Call for a literal stage (resolved by asStageShape) BEFORE pushing it.
   * `userIndex` is the loop index — the user-authored position in THIS pipeline.
   * Order: forbidden-in-context → must-be-first → record must-be-last →
   * (for `$match`) query-operator placement ($text-first, $near/$where bans).
   */
  checkStage: (name: string, pos: number, userIndex: number, body: Expr) => void;
  /** The sugar `$out` paths call this so the unified "after terminal" check fires. */
  markSugarOut: (pos: number) => void;
};

function makePipelineValidator(container: ContainerKind): PipelineValidator {
  let terminal: TerminalState | null = null;
  return {
    checkBeforeElement(pos: number): void {
      if (terminal !== null) throw makeAfterTerminalError(terminal, pos);
    },
    checkStage(name: string, pos: number, userIndex: number, body: Expr): void {
      const def = lookupStage(name);
      if (def === undefined) return; // asStageShape already guaranteed it; defensive
      if (container !== "top" && stageForbiddenIn(def, container)) {
        throw new CodegenError(forbiddenInContextMessage(name, container), pos);
      }
      // Key on the user-authored index, NOT out.length: prologue $lookup/$set
      // stages (from prior `let`/lookup statements or this stage's own buried
      // lookups) inflate out.length, but every prior user element emits ≥1
      // stage, so `userIndex > 0` ⟺ a real preceding stage exists.
      if (stageMustBeFirst(def) && userIndex > 0) {
        throw new CodegenError(mustBeFirstLiteralMessage(name), pos);
      }
      if (stageMustBeLast(def)) terminal = { stageName: name, pos, viaSugar: false };
      if (name === "$match") {
        validateMatchPlacement(body, { isTopLevel: container === "top", isFirstStage: userIndex === 0 });
      }
    },
    markSugarOut(pos: number): void {
      terminal = { stageName: "$out", pos, viaSugar: true };
    },
  };
}

/**
 * Error raised when any stage appears after a must-be-last (terminal) stage.
 * The sugar `$out` form keeps its original `'$$$.<coll> = …'` wording; literal
 * terminal stages ($out / $merge / $changeStreamSplitLargeEvent) name the stage.
 */
function makeAfterTerminalError(terminal: TerminalState, afterPos: number): CodegenError {
  if (terminal.viaSugar) {
    return new CodegenError(
      `'$out' must be the last stage in a pipeline. Move this statement before the '$$$.<coll> = …' write (at position ${terminal.pos}), ` +
        `or remove it.`,
      afterPos,
    );
  }
  return new CodegenError(
    `'${terminal.stageName}' must be the last stage in a pipeline — nothing can run after it. ` +
      `Move it to the end of the pipeline, or remove the stage(s) that follow it.`,
    afterPos,
  );
}

/** Message for a source stage (must-be-first) used in a non-first position, literal form. */
function mustBeFirstLiteralMessage(stageName: string): string {
  return (
    `'${stageName}' must be the first stage in a pipeline — it produces the pipeline's source documents, ` +
    `so nothing can run before it. Move it to the front, or remove the stage(s) that precede it.`
  );
}

/** Message for a stage used inside a sub-pipeline container that forbids it. */
function forbiddenInContextMessage(stageName: string, container: "facet" | "lookup" | "unionWith"): string {
  const owner = container === "facet" ? "$facet" : container === "lookup" ? "$lookup" : "$unionWith";
  return (
    `'${stageName}' is not allowed inside a '${owner}' sub-pipeline. ` + `Move it to the outer (top-level) pipeline.`
  );
}

/** Maps a sub-pipeline-owning stage to its container kind. */
function containerKindFor(stageName: string): "facet" | "lookup" | "unionWith" {
  if (stageName === "$facet") return "facet";
  if (stageName === "$unionWith") return "unionWith";
  return "lookup";
}

/**
 * Compile a pipeline-shaped ArrayLiteral AST to an MQL pipeline (stage array).
 *
 * Caller must have verified `isPipelineAst(ast)` first; we still validate
 * every element here and throw a precise CodegenError on the first non-stage
 * element so the error message points at the offending position.
 *
 * Consecutive update op elements (`$.a = 1`, `delete $.x`) coalesce through
 * the same algorithm `jsmql()` uses at the top level — see
 * `generateUpdateOpGroups` in codegen.ts. Non-update op stages flush the
 * current update op buffer and emit its compiled $set/$unset stage(s) inline.
 *
 * `let` bindings extend a pipeline-scoped GenerateCtx that downstream stages
 * inherit; reshape-clearing stages drop the scope; a trailing `$unset` is
 * appended once if any let was declared.
 */
export function generatePipeline(ast: Expr, startCtx: GenerateCtx = EMPTY_CTX): unknown[] {
  if (ast.type !== "ArrayLiteral") {
    internalError("generatePipeline expects an ArrayLiteral AST");
  }
  const out: unknown[] = [];
  let updateBuffer: UpdateOp[] = [];
  let ctx: GenerateCtx = startCtx;
  let everHadLet = false;
  const validator = makePipelineValidator("top");
  const tracking = makeSlotTracking();

  const flushUpdateOps = () => {
    if (updateBuffer.length === 0) return;
    for (const stage of generateUpdateOpGroups(updateBuffer, ctx)) out.push(stage);
    updateBuffer = [];
  };

  ast.elements.forEach((rawEl, i) => {
    validator.checkBeforeElement(rawEl.pos);
    let el: ArrayElement = rawEl;
    // Statement-position mutator rewrite: a `$.<field>.sort(...)` / `.push(...)`
    // / … call becomes a synthetic `$.<field> = <immutable RHS>` assignment so
    // it flows through the existing UpdateOp coalescer. Expression-position
    // calls and non-field-path receivers leave the AST untouched and fall
    // through to the dedicated codegen throws.
    if (el.type === "MethodCall") {
      const rewrite = tryRewriteMutatorCall(el);
      if (rewrite.kind === "rewrite") el = rewrite.assign;
    }
    if (el.type === "AssignExpr") {
      if (isReplaceStreamAssign(el)) {
        flushUpdateOps();
        const result = lowerReplaceStream(el, ctx, lowerBlock, tracking.alloc, out.length === 0);
        for (const s of result.stages) out.push(s);
        if (result.clearLets) ctx = clearCtxLets(ctx, "$unionWith");
        return;
      }
      if (isReplaceRootAssign(el)) {
        const facets = detectFacetShape(el.value);
        if (facets !== null) {
          flushUpdateOps();
          for (const s of lowerFacet(facets, ctx, lowerBlock)) out.push(s);
          ctx = clearCtxLets(ctx, "$facet");
          return;
        }
        flushUpdateOps();
        for (const s of lowerReplaceRoot(el, ctx, tracking.alloc, lowerBlock)) out.push(s);
        ctx = clearCtxLets(ctx, "$replaceWith");
        return;
      }
      const outTarget = detectOutAssign(el, ctx);
      if (outTarget !== null) {
        flushUpdateOps();
        for (const s of lowerOut(el, outTarget, ctx, lowerBlock, tracking.alloc)) out.push(s);
        validator.markSugarOut(el.pos);
        return;
      }
      const direct = detectLookupCall(el.value, ctx);
      if (direct !== null) {
        validateLookupShape(el.value);
        flushUpdateOps();
        const asPath = updateOpWritePath({ type: "AssignExpr", target: el.target, value: el.value, pos: el.pos });
        const stages = lowerLookup(direct, asPath, ctx, lowerBlock);
        for (const s of stages) out.push(s);
        return;
      }
      const { stages, rewritten } = extractLookupCalls(el.value, ctx, tracking.alloc, lowerBlock);
      if (stages.length > 0) {
        flushUpdateOps();
        for (const s of stages) out.push(s);
      }
      updateBuffer.push({ type: "AssignExpr", target: el.target, value: rewritten, pos: el.pos });
      return;
    }
    if (el.type === "DeleteStmt") {
      if (el.target.type === "FieldRef" && el.target.path === "") {
        throw new CodegenError(
          `Cannot 'delete $' — bare '$' is the whole document. Use '$ = <newDoc>' to replace it, or 'delete $.<field>' to drop a single field.`,
          el.pos,
        );
      }
      updateBuffer.push(el);
      return;
    }
    if (el.type === "LetDecl") {
      flushUpdateOps();
      const direct = detectLookupCall(el.value, ctx);
      if (direct !== null) {
        validateLookupShape(el.value);
        const slot = `${LET_NAMESPACE}.${el.name}`;
        const stages = lowerLookup(direct, slot, ctx, lowerBlock);
        for (const s of stages) out.push(s);
        ctx = extendCtxLets(ctx, el.name, slot);
        everHadLet = true;
        return;
      }
      const { stages: prologue, rewritten } = extractLookupCalls(el.value, ctx, tracking.alloc, lowerBlock);
      for (const s of prologue) out.push(s);
      const stage = lowerLetDecl({ type: "LetDecl", name: el.name, value: rewritten, pos: el.pos }, ctx);
      out.push(stage.set);
      ctx = stage.ctx;
      everHadLet = true;
      return;
    }
    flushUpdateOps();
    // `$$.push(...)` statement → one or more `$unionWith` stages (with inline-doc
    // batching across consecutive `{...}` args). Statement-only; runs before
    // the generic stage-element lowering so a bare `$$` receiver doesn't fall
    // through to `lowerStageElement`'s "not a recognised stage" error.
    if (el.type !== "SpreadElement") {
      const pushCall = detectUnionPush(el as Expr);
      if (pushCall !== null) {
        for (const s of lowerUnionPush(pushCall, ctx, lowerBlock)) out.push(s);
        return;
      }
      // `$$.indexStats()` / `$$$$.currentOp()` / `$$$$.shardedDataDistribution()`
      // → a diagnostic source stage. First-stage-only: a source produces the
      // stream, so anything emitted before it is a contradiction.
      if (el.type === "MethodCall" && isSystemStageCall(el)) {
        const sys = resolveSystemStageCall(el);
        if (out.length > 0) throw new CodegenError(notFirstStageMessage(sys), sys.callPos);
        out.push(lowerSystemStageStmt(sys, ctx));
        return;
      }
      validateUnionPushShape(el as Expr);
    }
    const rewrittenEl = extractFromStageElement(el, ctx, tracking.alloc, lowerBlock, out);
    const shape = asStageShape(rewrittenEl);
    if (shape !== null) validator.checkStage(shape.name, rewrittenEl.pos ?? el.pos, i, shape.body);
    const result = lowerStageElement(rewrittenEl, i, ctx);
    out.push(result.stage);
    ctx = result.ctx;
  });
  flushUpdateOps();
  if ((everHadLet || tracking.used()) && !shouldSkipTrailingNamespaceUnset(out)) out.push({ $unset: LET_NAMESPACE });
  return out;
}

/**
 * Compile a `Pipeline` (a sequence of `;`-separated top-level statements) to
 * an MQL stage array. Each statement is lowered in isolation: a update op
 * chain (`,`-grouped, possibly RAW-split) goes through `generateUpdateFilter`
 * and contributes one or more `$set`/`$unset` stages; an expression must be a
 * stage call/object and contributes exactly one stage.
 *
 * Adjacent update op statements never coalesce — `;` is a hard boundary, in
 * contrast to `generatePipeline` (the `[…]` form), where consecutive
 * update op elements coalesce through `generateUpdateOpGroups`. This is the
 * core difference between the two pipeline forms.
 *
 * `let` declarations contribute one `$set` stage each and extend the let
 * scope visible to subsequent statements.
 */
export function generateImplicitPipeline(
  p: Pipeline,
  startCtx: GenerateCtx = EMPTY_CTX,
  container: ContainerKind = "top",
): unknown[] {
  const out: unknown[] = [];
  let ctx: GenerateCtx = startCtx;
  let everHadLet = false;
  const validator = makePipelineValidator(container);
  const tracking = makeSlotTracking();

  p.stmts.forEach((rawStmt, i) => {
    validator.checkBeforeElement(rawStmt.pos);
    let stmt: PipelineStmt = rawStmt;
    // Statement-position mutator rewrite: same logic as `generatePipeline`,
    // wrapped in a single-op `UpdateFilter` so it routes through the existing
    // `lowerUpdateFilterWithLookups` path. See the matching block in
    // `generatePipeline` for the rationale.
    if (stmt.type === "MethodCall") {
      const rewrite = tryRewriteMutatorCall(stmt);
      if (rewrite.kind === "rewrite") {
        stmt = { type: "UpdateFilter", ops: [rewrite.assign], pos: rewrite.assign.pos };
      }
    }
    if (stmt.type === "LetDecl") {
      const direct = detectLookupCall(stmt.value, ctx);
      if (direct !== null) {
        validateLookupShape(stmt.value);
        const slot = `${LET_NAMESPACE}.${stmt.name}`;
        const stages = lowerLookup(direct, slot, ctx, lowerBlock);
        for (const s of stages) out.push(s);
        ctx = extendCtxLets(ctx, stmt.name, slot);
        everHadLet = true;
        return;
      }
      const { stages: prologue, rewritten } = extractLookupCalls(stmt.value, ctx, tracking.alloc, lowerBlock);
      for (const s of prologue) out.push(s);
      const stage = lowerLetDecl({ type: "LetDecl", name: stmt.name, value: rewritten, pos: stmt.pos }, ctx);
      out.push(stage.set);
      ctx = stage.ctx;
      everHadLet = true;
      return;
    }
    if (stmt.type === "UpdateFilter") {
      // Process each op in order, splitting at lookup-bearing ops so the
      // lookup stages can sit between coalesced $set groups. A `$ = <expr>`
      // op within the chain clears the let scope (it's a reshape stage), so
      // the returned ctx may differ from `ctx`. A `$$$.<coll> = …` op records
      // the terminal `$out` — once set, the next pipeline statement produces
      // the "must be last stage" error.
      const result = lowerUpdateFilterWithLookups(stmt, ctx, tracking.alloc, lowerBlock, out.length);
      for (const s of result.stages) out.push(s);
      ctx = result.ctx;
      if (result.terminal !== null) validator.markSugarOut(result.terminal.pos);
      return;
    }
    // `$$.push(...)` statement → one or more `$unionWith` stages (with
    // inline-doc batching across consecutive `{...}` args). Statement-only.
    const pushCall = detectUnionPush(stmt as Expr);
    if (pushCall !== null) {
      for (const s of lowerUnionPush(pushCall, ctx, lowerBlock)) out.push(s);
      return;
    }
    // `$$.indexStats()` / `$$$$.currentOp()` / `$$$$.shardedDataDistribution()`
    // → a diagnostic source stage. First-stage-only.
    if (stmt.type === "MethodCall" && isSystemStageCall(stmt as Expr)) {
      const sys = resolveSystemStageCall(stmt as Expr);
      if (out.length > 0) throw new CodegenError(notFirstStageMessage(sys), sys.callPos);
      out.push(lowerSystemStageStmt(sys, ctx));
      return;
    }
    validateUnionPushShape(stmt as Expr);
    // Stage call statement (Expr that resolves to a stage shape).
    const rewrittenStmt = extractFromStageElement(stmt as Expr, ctx, tracking.alloc, lowerBlock, out);
    const shape = asStageShape(rewrittenStmt as ArrayElement);
    if (shape !== null) validator.checkStage(shape.name, (rewrittenStmt as Expr).pos, i, shape.body);
    const result = lowerStageElement(rewrittenStmt as ArrayElement, i, ctx);
    out.push(result.stage);
    ctx = result.ctx;
  });

  if ((everHadLet || tracking.used()) && !shouldSkipTrailingNamespaceUnset(out)) out.push({ $unset: LET_NAMESPACE });
  return out;
}

type LetLowering = { set: Record<string, unknown>; ctx: GenerateCtx };

function lowerLetDecl(decl: LetDecl, ctx: GenerateCtx): LetLowering {
  if (ctx.pipelineLets?.has(decl.name)) {
    throw new CodegenError(
      `\`let ${decl.name}\` is already declared earlier in this pipeline. ` +
        `Re-declaration in the same scope is not allowed — pick a different name, ` +
        `or rebind after a reshape stage (\`$group\`, \`$replaceRoot\`, …).`,
      decl.pos,
    );
  }
  if (ctx.bindings?.has(decl.name)) {
    throw new CodegenError(
      `\`let ${decl.name}\` shadows a function-form parameter binding of the same name. ` +
        `Rename one — parameter bindings are compile-time constants supplied at call time, ` +
        `\`let\` bindings are per-document values derived from a stage expression; ` +
        `mixing them under one name would be ambiguous.`,
      decl.pos,
    );
  }
  const fieldPath = `${LET_NAMESPACE}.${decl.name}`;
  const value = generateWithCtx(decl.value, ctx);
  return { set: { $set: { [fieldPath]: value } }, ctx: extendCtxLets(ctx, decl.name, fieldPath) };
}

/**
 * `$ = <expr>` is an AssignExpr whose LHS is the bare `$` token — represented
 * in the AST as `FieldRef { path: "" }`. Different from `$.<x> = <expr>`
 * (which has a non-empty path) and from any `MemberAccess` chain. This helper
 * recognises the shape; lowering is performed by `lowerReplaceRoot`.
 */
function isReplaceRootAssign(op: AssignExpr): boolean {
  return op.target.type === "FieldRef" && op.target.path === "";
}

/**
 * Lower `$ = <expr>` to a `$replaceWith` stage (MQL's shorthand for
 * `$replaceRoot: { newRoot: <expr> }` — same runtime, fewer characters).
 *
 * Four variants:
 *   - Compound desugar (`$++`, `$ += 5`, …) is rejected up front: the parser
 *     reuses the same AST node for both `target` and `value.left`, so a
 *     referential-identity check on `BinaryExpr.left === target` catches all of
 *     them without us needing to remember the original surface operator.
 *   - Obviously non-document RHS (`$ = [1,2]`, `$ = 5`, `$ = "x"`, direct
 *     `.filter()` lookup) is rejected with an actionable message.
 *   - Direct `$$$.<coll>.find(pred)` RHS becomes `$lookup` (into an internal
 *     `__jsmql.__lookup<N>` slot) followed by `$replaceWith: { $first: "$<slot>" }`.
 *     We don't reuse `lowerLookup` because its `.find` form emits an extra
 *     `$set { slot: $first slot }` stage that's wasteful here — the slot is
 *     discarded by the replace anyway, so `$first` lives inside the
 *     `$replaceWith` instead.
 *   - Anything else: any buried lookups inside the RHS materialise as prologue
 *     stages, then `$replaceWith: <rewritten-RHS>`.
 */
function lowerReplaceRoot(
  el: AssignExpr,
  ctx: GenerateCtx,
  allocSlot: SlotAllocator,
  lowerBlockFn: SubPipelineLowerer,
): object[] {
  if (el.value.type === "BinaryExpr" && el.value.left === el.target) {
    throw new CodegenError(
      `Cannot use compound assignment / increment on bare '$' — '$' is the whole document, not a scalar. Use '$ = { ...$, ...overrides }' to merge fields into the root or '$ = <newRoot>' to replace it outright.`,
      el.pos,
    );
  }
  rejectNonDocumentReplaceRoot(el.value);

  const direct = detectLookupCall(el.value, ctx);
  if (direct !== null) {
    validateLookupShape(el.value);
    if (direct.method === "filter") {
      throw new CodegenError(
        `Cannot replace root with an array — '.filter(...)' returns an array. Use '.find(...)' for a single matching doc, or wrap: '$ = { items: $$$.<coll>.filter(...) }'.`,
        el.value.pos,
      );
    }
    const slot = allocSlot();
    const pred = translatePredicate(direct, ctx, lowerBlockFn);
    const from: string | { db: string; coll: string } =
      direct.db !== undefined ? { db: direct.db, coll: direct.collection } : direct.collection;
    const stages: object[] = [];
    if (pred.kind === "basic") {
      stages.push({ $lookup: { from, localField: pred.localField, foreignField: pred.foreignField, as: slot } });
    } else {
      stages.push({ $lookup: { from, let: pred.letVars, pipeline: pred.pipeline, as: slot } });
    }
    stages.push({ $replaceWith: { $first: `$${slot}` } });
    return stages;
  }

  const { stages: prologue, rewritten } = extractLookupCalls(el.value, ctx, allocSlot, lowerBlockFn);
  const out: object[] = [...prologue];
  out.push({ $replaceWith: generateWithCtx(rewritten, ctx) });
  return out;
}

/**
 * Reject RHS shapes that the user wouldn't have meant as a new document root.
 * Permissive by design — anything that *might* be a document (FieldRef,
 * MemberAccess, ObjectLiteral, OperatorCall, MethodCall, BinaryExpr, ternaries,
 * `$let`-style helpers) passes through; MongoDB validates document-shape at
 * runtime if our static check missed something.
 */
function rejectNonDocumentReplaceRoot(value: Expr): void {
  if (value.type === "ArrayLiteral") {
    throw new CodegenError(
      `Cannot replace root with an array. Use '.find(...)' for a single doc, or wrap: '$ = { items: [...] }'.`,
      value.pos,
    );
  }
  const literalKind =
    value.type === "NumberLiteral"
      ? "number"
      : value.type === "BigIntLiteral"
        ? "bigint"
        : value.type === "StringLiteral"
          ? "string"
          : value.type === "BooleanLiteral"
            ? "boolean"
            : value.type === "NullLiteral"
              ? "null"
              : value.type === "RegexLiteral"
                ? "regex"
                : null;
  if (literalKind !== null) {
    throw new CodegenError(
      `Cannot replace root with a ${literalKind} — the new root must be a document. Did you mean to wrap it: '$ = { value: ... }'?`,
      value.pos,
    );
  }
}

type LambdaNode = Extract<Expr, { type: "Lambda" }>;

/**
 * `$$ = <expr>` is an AssignExpr whose LHS is the `$$` token (the current
 * document stream) — represented in the AST as `CollectionRef`. Sister shape
 * to `$ = <expr>` (single-doc replacement → `$replaceWith`); `$$ = <expr>`
 * replaces the *stream* and lowers to either a `$match` (narrow) or
 * `$limit: 0` + `$unionWith` (switch source).
 */
function isReplaceStreamAssign(op: AssignExpr): boolean {
  return op.target.type === "CollectionRef";
}

/**
 * Lower `$$ = <expr>` to the stage(s) it represents.
 *
 * Two RHS shapes are accepted; anything else throws an actionable error:
 *
 *   - `$$.filter(<lambda>)`            → `[{ $match: <translated> }]`
 *   - `$$$.<coll>.filter(<lambda>)`    → `[{ $limit: 0 },
 *                                          { $unionWith: { coll, pipeline: [{ $match }] } }]`
 *
 * Inside both shapes the lambda parameter IS the document being matched;
 * `param.x` rewrites to a bare `FieldRef("x")` and `$.<field>` references
 * are rejected with a "use the lambda parameter" hint. This mirrors the
 * facet form's convention — adding a second spelling for the current doc
 * would only invite drift.
 *
 * `clearLets` distinguishes the two outcomes for the caller: the source-
 * switch form drops the outer collection entirely, so any prior `let`
 * binding becomes unreadable; the narrow form preserves the stream and
 * its bindings.
 */
function lowerReplaceStream(
  el: AssignExpr,
  outerCtx: GenerateCtx,
  lowerBlockFn: SubPipelineLowerer,
  allocSlot: SlotAllocator,
  isFirstStage: boolean,
): { stages: object[]; clearLets: boolean } {
  if (el.value.type === "BinaryExpr" && el.value.left === el.target) {
    throw new CodegenError(
      `Cannot use compound assignment / increment on '$$' — '$$' is the document stream, not a scalar. Use '$$ = $$.filter(<predicate>)' to narrow the stream or '$$ = $$$.<coll>.filter(<predicate>)' to switch source.`,
      el.pos,
    );
  }
  const v = el.value;
  // `$$ = [{ <key>: $$.reduce(…), … }];` — the JS-faithful wrap pattern for
  // folding the stream into a single-doc summary. `.reduce` is NOT a chain
  // method on `$$` (would break the "stream is always an array" invariant);
  // this wrap is the only legal way to consume a reduce result back into
  // the stream. See docs/specs/stream-methods.md.
  // Dict-build runs FIRST because its shape (single computed key on `d.<path>`)
  // overlaps with the object-reducer detector below, which would otherwise
  // throw "computed keys not supported" before we get a chance.
  const dictBuild = detectDictBuildWrap(v);
  if (dictBuild !== null) {
    return { stages: lowerDictBuildWrap(dictBuild), clearLets: true };
  }
  const reduceWrap = detectReduceWrap(v);
  if (reduceWrap !== null) {
    return { stages: lowerReduceWrap(reduceWrap), clearLets: true };
  }
  // `$$ = $$.reduce((acc, d) => acc.concat(d.<path>), []);` — the
  // array-returning reducer form. A `[]`-seeded reducer already returns an
  // array (a stream), so it's assigned unbracketed. Lowers to `$match` (when
  // the reducer is a `cond ? concat : acc` ternary) + `$replaceWith` (when the
  // projection is a field path). Sibling to the `$group`-shaped wrap above;
  // different lowering family. The legacy bracketed form throws (see
  // `detectArrayReducerWrap`).
  const arrayReducer = detectArrayReducerWrap(v);
  if (arrayReducer !== null) {
    return { stages: lowerArrayReducerWrap(arrayReducer, outerCtx, lowerBlockFn), clearLets: true };
  }
  const chain = collectStreamChain(v);
  if (chain.root.type === "CollectionRef" && chain.methods.length > 0) {
    return lowerChainOnStream(chain.methods, outerCtx, lowerBlockFn, allocSlot, v);
  }
  if (chain.methods.length > 0) {
    const target = extractLookupTarget(chain.root, outerCtx);
    if (target !== null) {
      return lowerChainOnCollection(chain.methods, target, outerCtx, lowerBlockFn, allocSlot, v);
    }
  }
  // Array-literal RHSes that aren't reduce-wraps:
  //   - `$$ = []` → `[{ $limit: 0 }]` (drop all docs; pre-1.0 sugar item #2)
  //   - `$$ = [{...}, {...}]` at stage 0 → `[{ $documents: [...] }]`
  //     (literal-doc seed; MongoDB requires $documents to be the first stage)
  //   - `$$ = [{...}, {...}]` mid-pipeline → throw, naming `$$.push(...)` as
  //     the right tool for appending docs to an existing stream.
  if (v.type === "ArrayLiteral") {
    if (v.elements.length === 0) {
      return { stages: [{ $limit: 0 }], clearLets: false };
    }
    if (isFirstStage) {
      const docs = extractDocumentsLiteral(v);
      if (docs !== null) {
        return { stages: [{ $documents: docs }], clearLets: true };
      }
    } else if (isAllObjectLiteralElements(v)) {
      throw new CodegenError(
        `'$$ = [<docs>]' is only valid as the first stage of a pipeline ('$documents' must be at the head per MongoDB). To append documents to an existing stream, use '$$.push({...}, {...}, …)' instead, which lowers to '$unionWith'.`,
        v.pos,
      );
    }
  }
  rejectInvalidReplaceStream(v, outerCtx);
}

/**
 * Extract a literal-document list for the `$$ = [{...}, {...}]` →
 * `$documents` sugar. Returns null if any element isn't a literal object —
 * then the caller falls through to the reduce-wrap / "use push" error path.
 */
function extractDocumentsLiteral(arr: Extract<Expr, { type: "ArrayLiteral" }>): unknown[] | null {
  const out: unknown[] = [];
  for (const el of arr.elements) {
    if (el.type !== "ObjectLiteral") return null;
    out.push(generateWithCtx(el, EMPTY_CTX));
  }
  return out;
}

function isAllObjectLiteralElements(arr: Extract<Expr, { type: "ArrayLiteral" }>): boolean {
  for (const el of arr.elements) {
    if (el.type !== "ObjectLiteral") return false;
  }
  return true;
}

/**
 * Lower a chain `$$.<m1>(...).<m2>(...)…` into stages on the outer pipeline.
 *
 * The first method may be `.filter(<lambda>)` — that produces a `$match`
 * stage exactly as before (predicate translated in the outer ctx so prior
 * `let` bindings resolve). Any subsequent method, or a non-`.filter` first
 * method, is dispatched through the stream-method registry. Unknown method
 * names throw an actionable error listing the registered alternatives.
 */
function lowerChainOnStream(
  methods: MethodCallNode[],
  outerCtx: GenerateCtx,
  lowerBlockFn: SubPipelineLowerer,
  allocSlot: SlotAllocator,
  rhs: Expr,
): { stages: object[]; clearLets: boolean } {
  const stages: object[] = [];
  let clearLets = false;
  let i = 0;
  if (methods[0].method === "filter") {
    const m = methods[0];
    if (m.args.length !== 1 || m.args[0].type !== "Lambda") {
      rejectInvalidReplaceStream(rhs, outerCtx);
    }
    const matchStages = lowerStreamFilterPredicate(m.args[0] as LambdaNode, outerCtx, lowerBlockFn);
    stages.push(...matchStages);
    i = 1;
  }
  for (; i < methods.length; i++) {
    const m = methods[i];
    const def = lookupStreamMethod(m.method);
    if (def === null) {
      throw unknownStreamMethod(m, "$$");
    }
    def.validate(m.args, m.pos);
    const result = def.lower(m.args, outerCtx, m.pos, lowerBlockFn, stages, allocSlot, false);
    if (result.replacesPreviousStage) stages.pop();
    stages.push(...result.stages);
    if (result.clearLets) clearLets = true;
  }
  return { stages, clearLets };
}

/**
 * Lower a chain `$$$.<coll>.<m1>(...).<m2>(...)…` on the RHS of `$$ = …`.
 *
 * **Two lowering families** depending on whether the chain head's
 * `.filter(<pred>)` correlates against the outer document:
 *
 *   - **Source switch (`$limit:0` + `$unionWith`).** When the predicate is
 *     a flat foreign-collection scan — no `$.<field>` references — the
 *     chain runs as an independent sub-pipeline. The outer stream is
 *     dropped (`$limit:0`) and replaced by docs flowing out of the
 *     `$unionWith.pipeline:` body. Default behaviour.
 *
 *   - **`$lookup`-pivot (`$lookup` + `$unwind` + `$replaceWith`).** When
 *     the predicate references the outer doc (`$.<field>`) — i.e. the
 *     match is *per-outer-doc* — jsmql can't use `$unionWith` because that
 *     stage has no `let:` slot. Instead the chain lowers to a `$lookup`
 *     (basic-form when the predicate is a single `===`, pipeline-form
 *     otherwise) that joins each outer doc to its matching foreign docs,
 *     followed by `$unwind` to explode the array and `$replaceWith` to
 *     make the matched doc the new root. Subsequent chain methods extend
 *     the lookup's pipeline body (so `.toSorted` / `.slice` / etc. apply
 *     before `$unwind`).
 *
 * The dispatch happens at the predicate level: `predicateReferencesOuterDoc`
 * runs `extractLetsFromExpr` to see whether any `$.<field>` paths would be
 * hoisted as `$lookup.let` vars; if any, the pivot path takes over.
 *
 * When the chain is just `.filter(o => true)` (vacuous, no outer refs and
 * no chain methods) the inner pipeline is empty and the short-form
 * `$unionWith` shape is emitted — same as before this chain walker existed.
 */
function lowerChainOnCollection(
  methods: MethodCallNode[],
  target: { db?: string; collection: string },
  outerCtx: GenerateCtx,
  lowerBlockFn: SubPipelineLowerer,
  allocSlot: SlotAllocator,
  rhs: Expr,
): { stages: object[]; clearLets: boolean } {
  // $lookup-pivot dispatch: when the head's `.filter(<pred>)` references
  // outer-doc fields, switch lowering families.
  if (
    methods[0].method === "filter" &&
    methods[0].args.length === 1 &&
    methods[0].args[0].type === "Lambda" &&
    predicateReferencesOuterDoc(methods[0].args[0] as LambdaNode, outerCtx)
  ) {
    return lowerLookupPivot(methods, target, outerCtx, lowerBlockFn, allocSlot);
  }
  const innerCtx = freshSubPipelineCtx(outerCtx);
  const inner: object[] = [];
  let i = 0;
  if (methods[0].method === "filter") {
    const m = methods[0];
    if (m.args.length !== 1 || m.args[0].type !== "Lambda") {
      rejectInvalidReplaceStream(rhs, outerCtx);
    }
    const matchStages = lowerStreamFilterPredicate(m.args[0] as LambdaNode, innerCtx, lowerBlockFn);
    inner.push(...matchStages);
    i = 1;
  }
  for (; i < methods.length; i++) {
    const m = methods[i];
    const def = lookupStreamMethod(m.method);
    if (def === null) {
      throw unknownStreamMethod(m, "$$$.<coll>");
    }
    def.validate(m.args, m.pos);
    const result = def.lower(m.args, innerCtx, m.pos, lowerBlockFn, inner, allocSlot, true);
    if (result.replacesPreviousStage) inner.pop();
    inner.push(...result.stages);
  }
  const from: string | { db: string; coll: string } =
    target.db !== undefined ? { db: target.db, coll: target.collection } : target.collection;
  const stages: object[] = [{ $limit: 0 }];
  if (inner.length === 0) {
    if (typeof from === "string") {
      stages.push({ $unionWith: from });
    } else {
      stages.push({ $unionWith: { coll: from } });
    }
  } else {
    stages.push({ $unionWith: { coll: from, pipeline: inner } });
  }
  return { stages, clearLets: true };
}

/**
 * Lower a `$$ = $$$.<coll>.filter(<correlatedPred>).<chain>;` source-switch
 * whose predicate references the outer document. Emits:
 *
 *   1. `$lookup` joining each outer doc to its matching foreign docs.
 *      - Basic form (`{ from, localField, foreignField, as }`) when the
 *        predicate is a single `===` between a foreign-path and a
 *        `$.<path>` and there are no chain methods after `.filter`.
 *      - Pipeline form (`{ from, let, pipeline, as }`) otherwise — `let`
 *        threads the outer-doc fields through, and chain methods extend
 *        the pipeline body before the array is returned.
 *   2. `$unwind` to explode the per-outer-doc array of matches.
 *   3. `$replaceWith` to make each matched foreign doc the new stream root.
 *
 * The result is a stream pivoted onto the foreign collection, where every
 * row was *correlated* against an outer doc (vs `$unionWith`, which would
 * just append a flat scan). Outer docs with no match are dropped by
 * `$unwind`'s default behaviour — the user can keep them by writing the
 * explicit `$.matched = $$$.coll.filter(...); $unwind($.matched, true); $ = $.matched`
 * chain when they need `preserveNullAndEmptyArrays`.
 *
 * `clearLets: true` because the trailing `$replaceWith` reshapes the doc,
 * dropping any outer `let` bindings the surrounding pipeline had.
 */
function lowerLookupPivot(
  methods: MethodCallNode[],
  target: { db?: string; collection: string },
  outerCtx: GenerateCtx,
  lowerBlockFn: SubPipelineLowerer,
  allocSlot: SlotAllocator,
): { stages: object[]; clearLets: boolean } {
  const filterMethod = methods[0];
  const restMethods = methods.slice(1);
  const lambda = filterMethod.args[0] as LambdaNode;
  const slot = allocSlot();
  const from: string | { db: string; coll: string } =
    target.db !== undefined ? { db: target.db, coll: target.collection } : target.collection;
  let lookupStage: object;
  if (restMethods.length === 0) {
    // No chain methods after `.filter` — basic form is fine when the
    // predicate qualifies. `translatePredicate` handles both basic and
    // pipeline forms; we just write whichever it returns.
    const fakeCall: LookupCall = {
      pos: filterMethod.pos,
      callPos: filterMethod.pos,
      db: target.db,
      collection: target.collection,
      method: "filter",
      lambda,
    };
    const pred = translatePredicate(fakeCall, outerCtx, lowerBlockFn);
    if (pred.kind === "basic") {
      lookupStage = { $lookup: { from, localField: pred.localField, foreignField: pred.foreignField, as: slot } };
    } else {
      lookupStage = { $lookup: { from, let: pred.letVars, pipeline: pred.pipeline, as: slot } };
    }
  } else {
    // Chain methods need a pipeline-form lookup so their stages can extend
    // the sub-pipeline body.
    const { letVars, pipelineBody } = buildPipelineFormPredicate(lambda, outerCtx, lowerBlockFn);
    const innerCtx = freshSubPipelineCtx(outerCtx);
    for (const m of restMethods) {
      const def = lookupStreamMethod(m.method);
      if (def === null) {
        throw unknownStreamMethod(m, "$$$.<coll>");
      }
      def.validate(m.args, m.pos);
      const result = def.lower(m.args, innerCtx, m.pos, lowerBlockFn, pipelineBody, allocSlot, true);
      if (result.replacesPreviousStage) pipelineBody.pop();
      pipelineBody.push(...result.stages);
    }
    lookupStage = { $lookup: { from, let: letVars, pipeline: pipelineBody, as: slot } };
  }
  return { stages: [lookupStage, { $unwind: `$${slot}` }, { $replaceWith: `$${slot}` }], clearLets: true };
}

function unknownStreamMethod(m: MethodCallNode, receiver: string): CodegenError {
  // Methods that return a single element in JS — deliberately rejected because
  // pipelines are arrays. The error names the explicit alternative so the user
  // doesn't have to dig for it.
  if (m.method === "find" || m.method === "findLast" || m.method === "at") {
    const alt = m.method === "at" ? `'${receiver}.slice(n, n + 1)'` : `'${receiver}.filter(<pred>).slice(0, 1)'`;
    const findHint =
      receiver === "$$$.<coll>"
        ? ` (For replacing the current document with a single matched foreign doc, write '$ = $$$.<coll>.find(<pred>)' instead — that's a separate lookup form.)`
        : "";
    return new CodegenError(
      `'.${m.method}(...)' is not allowed in a chain on '${receiver}' — '.${m.method}' returns a single element in JS, but pipelines are arrays. ` +
        `Use ${alt} for the equivalent "first match" / "n-th" shape.${findHint}`,
      m.pos,
    );
  }
  // `.reduce` is rejected as a chain method for the same reason — in JS,
  // `arr.reduce(...)` returns a scalar / object / array depending on the
  // reducer. Assigning a non-array result directly to `$$` would break the
  // "stream is always an array of docs" invariant. The user must wrap.
  if (m.method === "reduce") {
    return new CodegenError(
      `'.reduce(...)' is not a chain method on '${receiver}' — in JS '.reduce' collapses an array to a single value, but '${receiver}' must stay a stream of documents. Wrap the reduce result into a stream-shaped RHS:\n` +
        `  • Scalar reducer:  '$$ = [{ <key>: $$.reduce((acc, d) => …, <literal-init>) }];' — each entry becomes a '$group' accumulator; output is a single-doc stream of your named keys.\n` +
        `  • Object reducer:  '$$ = [$$.reduce((acc, d) => ({ ...acc, <key1>: <expr1>, <key2>: <expr2> }), { <key1>: <init1>, <key2>: <init2> })];' — same MQL output as the scalar form, keyed accumulators declared inline.\n` +
        `  • Array reducer:   '$$ = $$.reduce((acc, d) => (<cond> ? acc.concat(d.<field>) : acc), []);' — a '[]'-seeded reducer already returns a stream, so assign it directly (no '[ ]'); lowers to '$match' (when the body is a ternary) + '$replaceWith: "$<field>"'. Each input doc that passes <cond> becomes its <field> sub-doc.\n` +
        `Pick the wrap shape that matches what your reducer would return in plain JS.`,
      m.pos,
    );
  }
  const names = streamMethodNames();
  const hint = didYouMean(m.method, ["filter", ...names], (s) => `.${s}`);
  const list = names.length > 0 ? names.map((n) => `.${n}`).join(", ") : "(none yet)";
  return new CodegenError(
    `'.${m.method}(...)' is not a chainable stream method on '${receiver}'.${hint} ` +
      `The chain head may be '.filter(<predicate>)'; subsequent methods must come from the stream-method registry: ${list}.`,
    m.pos,
  );
}

/**
 * Lower a detected `$$ = $$.reduce((acc, d) => …, [])` array-returning
 * reducer into `$match` (when the body is `cond ? acc.concat(...) : acc`)
 * + `$replaceWith` (when the projection is `d.<path>`; omitted when the
 * reducer concats bare `d` — the docs flow through unchanged).
 *
 * The condition translates through the same `lowerStreamFilterPredicate`
 * engine `.filter` uses; the condition's `$.<field>` refs are rejected
 * with the standard "use the lambda parameter" hint.
 */
function lowerArrayReducerWrap(
  wrap: ArrayReducerWrap,
  outerCtx: GenerateCtx,
  lowerBlockFn: SubPipelineLowerer,
): object[] {
  const stages: object[] = [];
  if (wrap.condition !== null) {
    // Synthesise a single-param Lambda from (dParam, condition) so the
    // existing predicate-translation engine handles the body unchanged.
    // `pos` carries the lambda's original pos for error reporting.
    const fakeLambda: LambdaNode = { type: "Lambda", params: [wrap.dParam], body: wrap.condition, pos: wrap.lambdaPos };
    stages.push(...lowerStreamFilterPredicate(fakeLambda, outerCtx, lowerBlockFn));
  }
  if (wrap.project.kind === "field") {
    stages.push({ $replaceWith: `$${wrap.project.path}` });
  }
  return stages;
}

function lowerStreamFilterPredicate(
  lambda: LambdaNode,
  predicateCtx: GenerateCtx,
  lowerBlockFn: SubPipelineLowerer,
): object[] {
  if (lambda.params.length !== 1) {
    throw new CodegenError(
      `'.filter(<predicate>)' on the RHS of '$$ = …' must take exactly one parameter — write '.filter(o => …)' (the param name is your choice). The param represents each document.`,
      lambda.pos,
    );
  }
  // Shared expr-or-block predicate lowering (see `lowerLambdaPredicate`). The
  // stream filter already runs in the right ctx, so `freshCtx` is identity. A
  // `$.<field>` reference (captured as a non-empty `letVars`) is rejected — the
  // lambda parameter IS the document being matched.
  return lowerLambdaPredicate(lambda, predicateCtx, lowerBlockFn, {
    freshCtx: (ctx) => ctx,
    onLocalRef: rejectLocalRefInStreamFilter,
    missingBody: () => {
      throw new CodegenError(
        `'.filter(<predicate>)' lambda is missing a body — internal parser bug; please report.`,
        lambda.pos,
      );
    },
  });
}

function rejectLocalRefInStreamFilter(letVars: Record<string, string>, param: string, pos: number): never {
  const sample = Object.values(letVars)[0];
  const samplePath = sample.replace(/^\$+/, "");
  throw new CodegenError(
    `'$.<field>' inside the '.filter(<predicate>)' of '$$ = …' is not supported — use the lambda parameter (e.g. '${param}.${samplePath}') to reference each document. Inside this filter, the lambda parameter IS the document being matched.`,
    pos,
  );
}

function rejectInvalidReplaceStream(value: Expr, ctx: GenerateCtx): never {
  if (value.type === "ArrayLiteral") {
    // ArrayLiteral handling has moved up into `lowerReplaceStream` (empty → $limit:0,
    // first-stage literal-doc list → $documents, non-first-stage rejection). The
    // only ArrayLiteral RHSes that reach this rejection branch are ones that
    // pass the reduce-wrap detectors *and* fall outside the new sugar — i.e.
    // a single-doc-shaped array element that didn't match any wrap form. Point
    // at the three reduce-wrap patterns explicitly.
    throw new CodegenError(
      `'$$ = [<expr>]' didn't match any supported wrap pattern. Recognised shapes: ` +
        `'$$ = [{ <key>: $$.reduce(…, <literal-init>), … }]' (scalar accumulators → '$group' + '$replaceWith'), ` +
        `'$$ = [$$.reduce((acc, d) => ({ ...acc, <key>: <expr>, … }), { <key>: <init>, … })]' (object-returning reducer, same lowering), ` +
        `'$$ = [$$.reduce((acc, d) => ({ ...acc, [d.<k>]: <expr>, … }), {})]' (dict-build reducer → '$group' + '\$arrayToObject'), ` +
        `or '$$ = [$$.reduce((acc, d) => (<cond> ? acc.concat(d.<field>) : acc), [])]' (array-returning reducer → '$match' + '$replaceWith'). ` +
        `For a literal-doc seeder at stage 0, use '$$ = [{...}, {...}]' (lowers to '$documents'). To append docs mid-pipeline, use '$$.push({...}, {...}, …)'.`,
      value.pos,
    );
  }
  if (value.type === "TernaryExpr") {
    throw new CodegenError(
      `'$$ = <ternary>' (conditional stream branching) is not yet supported [DEF-001]. The RHS of '$$ = …' must be '$$.filter(<predicate>)' (narrow the current stream) or '$$$.<coll>.filter(<predicate>)' (switch source to another collection). See docs/DEFERRED.md.`,
      value.pos,
    );
  }
  if (value.type === "MethodCall") {
    const onCollection = value.object.type === "CollectionRef";
    const onDatabase = extractLookupTarget(value.object, ctx) !== null;
    if (onCollection || onDatabase) {
      const hint = didYouMean(value.method, ["filter"], (s) => `.${s}`);
      const recv = onCollection ? "$$" : "$$$.<coll>";
      const intent = onCollection ? "narrow the current stream" : "switch source to another collection";
      throw new CodegenError(
        `'$$ = …' RHS supports only '${recv}.filter(<predicate>)' — '.${value.method}(...)' is not allowed here.${hint} ` +
          `Use '${recv}.filter(<predicate>)' to ${intent}, ` +
          `or write '$ = $$$.<coll>.find(<predicate>)' if you meant to replace each document with a single matching foreign doc.`,
        value.pos,
      );
    }
  }
  if (value.type === "CollectionRef" || value.type === "DatabaseRef") {
    throw new CodegenError(
      `'$$ = …' RHS must call '.filter(<predicate>)'. Write '$$.filter(o => …)' to narrow the current stream or '$$$.<coll>.filter(o => …)' to switch source.`,
      value.pos,
    );
  }
  throw new CodegenError(
    `'$$ = …' RHS must be '$$.filter(<predicate>)' (narrow the current stream) or '$$$.<coll>.filter(<predicate>)' (switch source to another collection).`,
    value.pos,
  );
}

/**
 * Emit the single source stage for a `$$.indexStats()` / `$$$$.currentOp(...)` /
 * `$$$$.shardedDataDistribution()` diagnostic call. The options object (when
 * present) lowers through the same `generateStageBody` path every other stage
 * body uses — all nine diagnostics declare `subPipelineFields: []`, so it's a
 * plain recursive object codegen. No options → an empty `{}` body.
 */
function lowerSystemStageStmt(call: SystemStageCall, ctx: GenerateCtx): object {
  const body = call.optionsExpr === null ? {} : generateStageBody(call.stageName, call.optionsExpr, ctx);
  return { [call.stageName]: body };
}

type StageLowering = { stage: Record<string, unknown>; ctx: GenerateCtx };

function lowerStageElement(el: ArrayElement, index: number, ctx: GenerateCtx): StageLowering {
  const stage = asStageShape(el);
  if (!stage) {
    const pos = (el as { pos?: number }).pos ?? 0;
    throw new CodegenError(formatNotAStageError(el, index), pos);
  }
  const body = generateStageBody(stage.name, stage.body, ctx);
  const nextCtx = RESHAPE_CLEARING_STAGES.has(stage.name) ? clearCtxLets(ctx, stage.name) : ctx;
  return { stage: { [stage.name]: body }, ctx: nextCtx };
}

function generateStageBody(stageName: string, body: Expr, ctx: GenerateCtx): unknown {
  // Body-shape validation (literal-gated; see stage-validation.ts). Runs for
  // every user-written stage body before lowering.
  validateStageBody(stageName, body);
  // $match: ObjectLiteral body → raw query document (also the `$expr` escape
  // hatch). Expression body → query-language translation with $expr fallback
  // for residual sub-expressions. Residual lowering re-enters codegen with the
  // pipeline ctx so a let referenced inside the residual still resolves to its
  // namespace field path.
  if (stageName === "$match") {
    if (body.type === "ObjectLiteral") {
      return generateBodyObject(body, stageName, ctx);
    }
    const t = translateMatchBody(body, { bindings: ctx.bindings });
    const queryEmpty = Object.keys(t.query).length === 0;
    if (queryEmpty) return { $expr: generateWithCtx(body, ctx) };
    if (t.residual === null) return t.query;
    return { ...t.query, $expr: generateWithCtx(t.residual, ctx) };
  }

  // Other stages: if the body is an object literal, walk its entries so we
  // can spot sub-pipeline slots; otherwise generate directly.
  if (body.type === "ObjectLiteral") {
    return generateBodyObject(body, stageName, ctx);
  }
  return generateWithCtx(body, ctx);
}

/**
 * Walk a stage's object-literal body, recursing into sub-pipeline slots
 * (configured per-stage in STAGES). Non-pipeline slots fall through to the
 * normal expression codegen with the parent's ctx (so lets are visible in
 * stage-body expressions). Sub-pipelines get a fresh empty ctx — outer lets
 * do not cross sub-pipeline boundaries.
 */
function generateBodyObject(
  body: Expr & { type: "ObjectLiteral" },
  stageName: string,
  ctx: GenerateCtx,
): Record<string, unknown> {
  const stage = lookupStage(stageName)!;
  const allValuesArePipelines = stage.subPipelineFields.includes("*");
  const pipelineSlot = new Set(stage.subPipelineFields);

  const out: Record<string, unknown> = {};
  for (const entry of body.entries) {
    if (entry.type !== "KeyValueEntry") {
      throw new CodegenError(`Spread entries are not allowed in ${stageName} body`, entry.pos);
    }
    if (entry.key.kind !== "static") {
      throw new CodegenError(`Computed keys are not allowed in ${stageName} body`, entry.pos);
    }
    const key = entry.key.name;
    const isPipelineSlot = allValuesArePipelines || pipelineSlot.has(key);
    if (isPipelineSlot && isPipelineAst(entry.value)) {
      // Sub-pipelines run in a fresh scope. Outer lets do not cross; function-
      // form parameter bindings do (they're compile-time constants).
      out[key] = generatePipelineWithCtx(entry.value, freshSubPipelineCtx(ctx), containerKindFor(stageName));
      continue;
    }
    // Accumulator-context gate (Wave 5 #22 + #41).
    //
    // - `$group` field-value slots (every key except `_id`) → "group" ctx,
    //   so accumulator-only operators ($addToSet, $push, $bottom*, etc.)
    //   pass the codegen gate; window ops still throw.
    // - `$setWindowFields.output[<key>]` → "window-output" ctx, both
    //   accumulator-only AND window-only operators (e.g. $rank,
    //   $denseRank) pass.
    // - `$bucket` / `$bucketAuto` `output` key's nested values: same as
    //   $group field values — accumulator context.
    const nestedScope = NESTED_ACCUMULATOR_OUTPUT[stageName];
    if (nestedScope !== undefined && key === "output" && entry.value.type === "ObjectLiteral") {
      out[key] = generateNestedAccumulatorObject(entry.value, ctx, nestedScope);
      continue;
    }
    const slotCtx = accumulatorCtxFor(stageName, key, ctx);
    out[key] = generateWithCtx(entry.value, slotCtx);
  }
  return out;
}

/**
 * Stages whose `output` slot is an object whose VALUES are accumulator (or,
 * for `$setWindowFields`, window) expressions. The level of indirection
 * matters: `$bucket({ output: { count: $sum(1) } })` vs `$group({ count:
 * $sum(1) })` — same accumulator semantics, different nesting depth.
 */
const NESTED_ACCUMULATOR_OUTPUT: Record<string, "group" | "window-output"> = {
  $bucket: "group",
  $bucketAuto: "group",
  $setWindowFields: "window-output",
};

/** For `$group` field-value slots (other than `_id`). */
function accumulatorCtxFor(stageName: string, key: string, ctx: GenerateCtx): GenerateCtx {
  if (stageName === "$group" && key !== "_id") {
    return { ...ctx, accumulatorContext: "group" };
  }
  return ctx;
}

/**
 * Walk an object whose direct entries are accumulator expressions — used for
 * `$bucket.output`, `$bucketAuto.output`, and `$setWindowFields.output`. Each
 * entry's value is generated with the appropriate `accumulatorContext`. The
 * surrounding object literal preserves order.
 */
function generateNestedAccumulatorObject(
  body: Expr & { type: "ObjectLiteral" },
  ctx: GenerateCtx,
  scope: "group" | "window-output",
): Record<string, unknown> {
  const scopedCtx: GenerateCtx = { ...ctx, accumulatorContext: scope };
  const out: Record<string, unknown> = {};
  for (const entry of body.entries) {
    if (entry.type !== "KeyValueEntry") {
      throw new CodegenError(`Spread entries are not allowed in an accumulator-output object`, entry.pos);
    }
    if (entry.key.kind !== "static") {
      throw new CodegenError(`Computed keys are not allowed in an accumulator-output object`, entry.pos);
    }
    out[entry.key.name] = generateWithCtx(entry.value, scopedCtx);
  }
  return out;
}

/**
 * Sub-pipeline entry point. Same as `generatePipeline` but starts from a
 * caller-supplied ctx. Used for literal sub-pipeline slots (`$facet.*`,
 * `$lookup.pipeline`, `$unionWith.pipeline`); `container` names which owning
 * stage so structural validation can enforce the forbidden-in-context bans
 * (e.g. `$out`/`$merge` inside any sub-pipeline) and the per-sub-pipeline
 * position rules.
 */
function generatePipelineWithCtx(ast: Expr, startCtx: GenerateCtx, container: ContainerKind): unknown[] {
  if (ast.type !== "ArrayLiteral") {
    internalError("generatePipelineWithCtx expects an ArrayLiteral AST");
  }
  // Nested lookups inside expression-body predicates are now materialised by
  // `extractLookupCalls` with an `EnclosingLookupContext` thread-through (see
  // lookup-translation.ts). Block-body and `$facet`/`$unionWith` sub-pipelines
  // still walk through this path; those forms are caught at the per-statement
  // level when `extractLookupCalls` runs over each stage body. (Block-body
  // nested lookups themselves are still rejected upstream in
  // `translatePredicate` — they need ctx threading through `lowerBlock`.)
  for (const el of ast.elements) {
    // `$$.push(...)` inside a sub-pipeline targets the *outer* collection but
    // emits stages that would live inside the inner pipeline — the semantics are
    // ambiguous and the MongoDB server has no equivalent shape. Reject.
    if (el.type !== "SpreadElement") {
      const innerPush =
        el.type === "AssignExpr" || el.type === "DeleteStmt" || el.type === "LetDecl"
          ? null
          : detectUnionPush(el as Expr);
      if (innerPush !== null) {
        throw new CodegenError(
          `'$$.push(...)' inside a sub-pipeline ('$lookup.pipeline', '$unionWith.pipeline', '$facet.*') is not supported — ` +
            `$$.push emits '$unionWith' stages against the current (outer) collection. Hoist the push to a sibling stage in the outer pipeline.`,
          innerPush.pos,
        );
      }
    }
  }
  const out: unknown[] = [];
  let updateBuffer: UpdateOp[] = [];
  let ctx: GenerateCtx = startCtx;
  let everHadLet = ctxHasLets(startCtx); // shouldn't happen for sub-pipelines, but safe
  const validator = makePipelineValidator(container);

  const flushUpdateOps = () => {
    if (updateBuffer.length === 0) return;
    for (const stage of generateUpdateOpGroups(updateBuffer, ctx)) out.push(stage);
    updateBuffer = [];
  };

  ast.elements.forEach((el, i) => {
    validator.checkBeforeElement(el.pos);
    if (el.type === "AssignExpr" || el.type === "DeleteStmt") {
      updateBuffer.push(el);
      return;
    }
    if (el.type === "LetDecl") {
      flushUpdateOps();
      const stage = lowerLetDecl(el, ctx);
      out.push(stage.set);
      ctx = stage.ctx;
      everHadLet = true;
      return;
    }
    flushUpdateOps();
    const shape = asStageShape(el);
    if (shape !== null) validator.checkStage(shape.name, el.pos, i, shape.body);
    const result = lowerStageElement(el, i, ctx);
    out.push(result.stage);
    ctx = result.ctx;
  });
  flushUpdateOps();
  if (everHadLet && !shouldSkipTrailingNamespaceUnset(out)) out.push({ $unset: LET_NAMESPACE });
  return out;
}

// ── Error formatting ──────────────────────────────────────────────────────────

function formatNotAStageError(el: ArrayElement, index: number): string {
  // Try to surface the offending name when we can guess one — gives users a
  // precise pointer ("Element 1: '$macth' is not a known stage. Did you mean
  // '$match'?") instead of the generic shape complaint.
  if (el.type !== "SpreadElement") {
    if (el.type === "ObjectLiteral") {
      if (el.entries.length === 1) {
        const entry = el.entries[0];
        if (entry.type === "KeyValueEntry" && entry.key.kind === "static") {
          const name = entry.key.name;
          if (!lookupStage(name)) {
            return formatUnknownStage(name, index);
          }
        }
      } else if (el.entries.length > 1) {
        return (
          `Element ${index} of pipeline must be a single-key stage object ` +
          `(e.g. \`{ $match: ... }\`), but found an object with ${el.entries.length} keys.`
        );
      }
    }
    if (el.type === "OperatorCall" && !lookupStage(el.name)) {
      return formatUnknownStage(el.name, index);
    }
    // Bare predicate / expression in pipeline position is almost always a user
    // who wants to filter — point them at `$match(...)` explicitly so they
    // don't have to look it up. The semicolon-form pipeline (`$.age > 18;`)
    // hits this path most often.
    if (looksLikePredicate(el)) {
      return (
        `Element ${index} of pipeline is not a stage call. ` +
        `To filter documents on a predicate, wrap it as \`$match(...)\` — ` +
        `e.g. \`$match($.age > 18)\`. ` +
        `Pipeline statements must be stage calls; available stages: ${formatStageList()}.`
      );
    }
  }
  return (
    `Element ${index} of pipeline is not a recognised stage. ` +
    `Expected \`{ $stage: ... }\` or \`$stage(...)\` where $stage is one of: ` +
    `${formatStageList()}.`
  );
}

/**
 * Heuristic: does this element look like a boolean predicate the user probably
 * meant to filter on? Comparison and logical binary ops, unary `!`, and the
 * `in` / `instanceof` shapes all qualify. Used only for friendlier error
 * messages — no behaviour change.
 */
function looksLikePredicate(el: ArrayElement): boolean {
  if (el.type === "BinaryExpr") {
    const op = el.op;
    return (
      op === "===" ||
      op === "==" ||
      op === "!==" ||
      op === "!=" ||
      op === "<" ||
      op === "<=" ||
      op === ">" ||
      op === ">=" ||
      op === "&&" ||
      op === "||"
    );
  }
  if (el.type === "UnaryExpr" && el.op === "!") return true;
  return false;
}

function formatUnknownStage(name: string, index: number): string {
  const suffix = didYouMean(name, Object.keys(STAGES), (s) => s);
  return `Element ${index} of pipeline: '${name}' is not a known aggregation stage.${suffix}`;
}

function formatStageList(): string {
  // Compact list, alphabetised, capped to keep the error readable.
  const all = Object.keys(STAGES).sort();
  const head = all.slice(0, 12).join(", ");
  return `${head}, … (${all.length} total)`;
}

// ── Lookup integration ────────────────────────────────────────────────────────

/**
 * Lower a Pipeline AST (a block-body lambda body, normalised by the parser) to a
 * stage array. Provided to lookup-translation as its SubPipelineLowerer so the
 * `$lookup.pipeline` body for a block-body lambda uses the same `;`-separated
 * semantics as a top-level pipeline. `extractLookupCalls` itself rejects nested
 * `$$$.<coll>.find/filter(...)` inside this block via `rejectNestedLookup`, so
 * by the time `lowerBlock` runs the block is free of nested lookups and can be
 * lowered with `generateImplicitPipeline` unchanged.
 */
const lowerBlock: SubPipelineLowerer = (block, ctx) => {
  // `$$.push(...)` targets the *outer* collection but the stages it emits
  // would live inside this lookup's `$lookup.pipeline` — semantically wrong
  // (the push wouldn't union into the outer stream). Reject before lowering
  // with a precise hoist-to-outer hint, mirroring the nested-lookup rule.
  for (const stmt of block.stmts) {
    const innerPush =
      stmt.type === "LetDecl" ? null : stmt.type === "UpdateFilter" ? null : detectUnionPush(stmt as Expr);
    if (innerPush !== null) {
      throw new CodegenError(
        `'$$.push(...)' inside a lookup's block-body lambda is not supported — $$.push appends documents to the outer collection's stream via '$unionWith', but the stages would land inside '$lookup.pipeline'. ` +
          `Hoist the push to a sibling stage in the outer pipeline.`,
        innerPush.pos,
      );
    }
  }
  return generateImplicitPipeline(block, ctx) as object[];
};

/**
 * Per-pipeline slot allocator plus a flag for whether any slot was handed out.
 * Used to decide whether to emit the trailing `$unset "__jsmql"` cleanup at
 * the end of a top-level pipeline — `__jsmql.__lookup<N>` slots ride the same
 * cleanup as `let`-bindings, so a pipeline with no lets but at least one
 * lookup still needs the trailing `$unset`.
 */
function makeSlotTracking(): { alloc: SlotAllocator; used: () => boolean } {
  const base = createSlotAllocator();
  let touched = false;
  return {
    alloc: () => {
      touched = true;
      return base();
    },
    used: () => touched,
  };
}

/**
 * Lower one `UpdateFilter` statement, splitting at any update op whose RHS is
 * a direct lookup. Adjacent non-lookup update ops keep coalescing through
 * `generateUpdateOpGroups`; a direct-lookup op flushes the buffer, emits the
 * lookup stages (using its LHS field path as the `$lookup.as` slot), and
 * resumes buffering on the next op. Chained-on-lookup and lookup-bearing
 * arithmetic RHSes go through `extractLookupCalls` first — the prologue
 * stages flush before the op is queued.
 */
function lowerUpdateFilterWithLookups(
  stmt: UpdateFilter,
  startCtx: GenerateCtx,
  allocSlot: SlotAllocator,
  lowerBlockFn: SubPipelineLowerer,
  globalStageIndex: number = 0,
): { stages: object[]; ctx: GenerateCtx; terminal: TerminalState | null } {
  const out: object[] = [];
  let buffer: UpdateOp[] = [];
  let ctx = startCtx;
  let terminal: TerminalState | null = null;
  const flush = () => {
    if (buffer.length === 0) return;
    for (const stage of generateUpdateOpGroups(buffer, ctx)) out.push(stage);
    buffer = [];
  };
  for (const op of stmt.ops) {
    if (terminal !== null) throw makeAfterTerminalError(terminal, op.pos);
    if (op.type === "AssignExpr") {
      if (isReplaceStreamAssign(op)) {
        flush();
        const result = lowerReplaceStream(op, ctx, lowerBlockFn, allocSlot, globalStageIndex + out.length === 0);
        for (const s of result.stages) out.push(s);
        if (result.clearLets) ctx = clearCtxLets(ctx, "$unionWith");
        continue;
      }
      if (isReplaceRootAssign(op)) {
        const facets = detectFacetShape(op.value);
        if (facets !== null) {
          flush();
          for (const s of lowerFacet(facets, ctx, lowerBlockFn)) out.push(s);
          ctx = clearCtxLets(ctx, "$facet");
          continue;
        }
        flush();
        for (const s of lowerReplaceRoot(op, ctx, allocSlot, lowerBlockFn)) out.push(s);
        ctx = clearCtxLets(ctx, "$replaceWith");
        continue;
      }
      const outTarget = detectOutAssign(op, ctx);
      if (outTarget !== null) {
        flush();
        for (const s of lowerOut(op, outTarget, ctx, lowerBlockFn, allocSlot)) out.push(s);
        terminal = { stageName: "$out", pos: op.pos, viaSugar: true };
        continue;
      }
      const direct = detectLookupCall(op.value, ctx);
      if (direct !== null) {
        validateLookupShape(op.value);
        flush();
        const asPath = updateOpWritePath(op);
        const stages = lowerLookup(direct, asPath, ctx, lowerBlockFn);
        for (const s of stages) out.push(s);
        continue;
      }
      const { stages, rewritten } = extractLookupCalls(op.value, ctx, allocSlot, lowerBlockFn);
      if (stages.length > 0) {
        flush();
        for (const s of stages) out.push(s);
      }
      buffer.push({ type: "AssignExpr", target: op.target, value: rewritten, pos: op.pos });
      continue;
    }
    // DeleteStmt — target is a field path; no lookups possible.
    if (op.target.type === "FieldRef" && op.target.path === "") {
      throw new CodegenError(
        `Cannot 'delete $' — bare '$' is the whole document. Use '$ = <newDoc>' to replace it, or 'delete $.<field>' to drop a single field.`,
        op.pos,
      );
    }
    buffer.push(op);
  }
  flush();
  return { stages: out, ctx, terminal };
}

/**
 * Extract lookups from one stage-call element (e.g. a `$project({...})` or
 * `{ $project: {...} }` whose body has a lookup buried in some entry). The
 * stage's body expressions are walked; lookups are materialised into internal
 * slots and prologue stages are pushed to `out` *before* the stage itself.
 * Returns the rewritten element (an ArrayElement of the same shape) so the
 * existing stage lowering machinery handles it unchanged.
 */
function extractFromStageElement(
  el: ArrayElement,
  ctx: GenerateCtx,
  allocSlot: SlotAllocator,
  lowerBlockFn: SubPipelineLowerer,
  out: unknown[],
): ArrayElement {
  if (el.type === "OperatorCall") {
    const args = el.args.map((arg): CallArg => {
      if (arg.type === "SpreadElement") {
        const { stages, rewritten } = extractLookupCalls(arg.argument, ctx, allocSlot, lowerBlockFn);
        for (const s of stages) out.push(s);
        return { type: "SpreadElement", argument: rewritten, pos: arg.pos };
      }
      const { stages, rewritten } = extractLookupCalls(arg, ctx, allocSlot, lowerBlockFn);
      for (const s of stages) out.push(s);
      return rewritten;
    });
    return { type: "OperatorCall", name: el.name, style: el.style, args, pos: el.pos };
  }
  if (el.type === "ObjectLiteral") {
    // Stage-object form: `{ $stage: <body> }`. Walk the entries.
    const entries = el.entries.map((entry) => {
      if (entry.type === "SpreadElement") {
        const { stages, rewritten } = extractLookupCalls(entry.argument, ctx, allocSlot, lowerBlockFn);
        for (const s of stages) out.push(s);
        return { type: "SpreadElement" as const, argument: rewritten, pos: entry.pos };
      }
      const { stages, rewritten } = extractLookupCalls(entry.value, ctx, allocSlot, lowerBlockFn);
      for (const s of stages) out.push(s);
      return { type: "KeyValueEntry" as const, key: entry.key, value: rewritten, pos: entry.pos };
    });
    return { type: "ObjectLiteral", entries, pos: el.pos };
  }
  return el;
}

/**
 * Find the source position of the first `$$$.<coll>.find/filter(...)` chain
 * inside an ArrayElement, or null if none. Used by `generatePipelineWithCtx`
 * to surface a precise nested-lookup-not-supported error.
 */
function findFirstLookupInElement(el: ArrayElement): number | null {
  if (el.type === "AssignExpr") return findFirstLookupInExpr(el.value);
  if (el.type === "DeleteStmt") return null;
  if (el.type === "LetDecl") return findFirstLookupInExpr(el.value);
  if (el.type === "SpreadElement") return findFirstLookupInExpr(el.argument);
  return findFirstLookupInExpr(el as Expr);
}

function findFirstLookupInExpr(expr: Expr): number | null {
  // findFirstLookupInExpr only locates a position for the nested-lookup
  // rejection in `generatePipelineWithCtx`. The position is informational;
  // the surrounding code has already established (structurally) that a
  // lookup is present. EMPTY_CTX is safe here.
  const direct = detectLookupCall(expr, EMPTY_CTX);
  if (direct !== null) return direct.pos;
  // Recurse into common shapes
  if (expr.type === "MethodCall") {
    const a = findFirstLookupInExpr(expr.object);
    if (a !== null) return a;
    for (const arg of expr.args) {
      const a2 = arg.type === "SpreadElement" ? findFirstLookupInExpr(arg.argument) : findFirstLookupInExpr(arg);
      if (a2 !== null) return a2;
    }
    return null;
  }
  if (expr.type === "MemberAccess") return findFirstLookupInExpr(expr.object);
  if (expr.type === "IndexAccess") {
    return findFirstLookupInExpr(expr.object) ?? findFirstLookupInExpr(expr.index);
  }
  if (expr.type === "BinaryExpr") return findFirstLookupInExpr(expr.left) ?? findFirstLookupInExpr(expr.right);
  if (expr.type === "UnaryExpr") return findFirstLookupInExpr(expr.operand);
  if (expr.type === "TernaryExpr") {
    return (
      findFirstLookupInExpr(expr.condition) ??
      findFirstLookupInExpr(expr.consequent) ??
      findFirstLookupInExpr(expr.alternate)
    );
  }
  if (expr.type === "OperatorCall" || expr.type === "MathCall" || expr.type === "ObjectCall") {
    for (const arg of expr.args) {
      const a = arg.type === "SpreadElement" ? findFirstLookupInExpr(arg.argument) : findFirstLookupInExpr(arg);
      if (a !== null) return a;
    }
    return null;
  }
  if (expr.type === "ArrayLiteral") {
    for (const child of expr.elements) {
      const a = findFirstLookupInElement(child);
      if (a !== null) return a;
    }
    return null;
  }
  if (expr.type === "ObjectLiteral") {
    for (const entry of expr.entries) {
      if (entry.type === "SpreadElement") {
        const a = findFirstLookupInExpr(entry.argument);
        if (a !== null) return a;
      } else {
        if (entry.key.kind === "computed") {
          const a = findFirstLookupInExpr(entry.key.expr);
          if (a !== null) return a;
        }
        const a = findFirstLookupInExpr(entry.value);
        if (a !== null) return a;
      }
    }
    return null;
  }
  if (expr.type === "Lambda") {
    if (expr.body !== undefined) return findFirstLookupInExpr(expr.body);
    if (expr.block !== undefined) {
      for (const stmt of expr.block.stmts) {
        if (stmt.type === "UpdateFilter") {
          for (const op of stmt.ops) {
            if (op.type === "AssignExpr") {
              const a = findFirstLookupInExpr(op.value);
              if (a !== null) return a;
            }
          }
        } else if (stmt.type === "LetDecl") {
          const a = findFirstLookupInExpr(stmt.value);
          if (a !== null) return a;
        } else {
          const a = findFirstLookupInExpr(stmt as Expr);
          if (a !== null) return a;
        }
      }
    }
    return null;
  }
  return null;
}
