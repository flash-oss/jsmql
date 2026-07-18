// Pipeline detection and lowering — owns everything stage-related so codegen.ts
// stays focused on a single expression. Also the sugar-dispatch hub
// (tryLowerAssignSugar / lowerStatementTail — see src/CLAUDE.md § Extending the
// pipeline sugar).
//
// Public surface:
//   - isPipelineAst(ast)    — true if the AST root looks like an aggregation pipeline
//   - generatePipeline(ast) — compile a pipeline-shaped AST to an MQL stage array
//
// Behaviour (detection rule, the two-layer $match body lowering, pipeline-scoped
// `let` variables and their reshape-clearing rules) is owned by the specs:
//   docs/specs/aggregation-stages.md      — detection + stage lowering
//   docs/specs/match-query-translation.md — $match body → query document
//   docs/specs/let-bindings.md            — pipeline-scoped `let` variables

import type {
  Expr,
  ArrayElement,
  UpdateOp,
  AssignExpr,
  Pipeline,
  LetDecl,
  FuncDecl,
  PipelineStmt,
  UpdateFilter,
  CallArg,
} from "./ast.ts";
import {
  generateWithCtx,
  generateUpdateOpGroups,
  generateUpdateFilter,
  generateAssertGuardExpr,
  ASSERT_FN_NAME,
  updateOpWritePath,
  tryRewriteMutatorCall,
  CodegenError,
  EMPTY_CTX,
  extendCtxLets,
  staticBindingType,
  clearCtxLets,
  ctxHasLets,
  extendCtxFunctions,
  freshSubPipelineCtx,
  internalError,
  isWritableFieldPath,
  type GenerateCtx,
} from "./codegen.ts";
import { didYouMean } from "./levenshtein.ts";
import { someExpr, someElement, someStmt } from "./ast-walk.ts";
import { JSMQL_NS, bindingSlot, streamLengthStage } from "./namespace.ts";
import { lookupStage, STAGES, stageMustBeFirst, stageMustBeLast, stageForbiddenIn } from "./stages.ts";
import { translateMatchBody, mergeTranslatedQuery } from "./match-translation.ts";
import {
  argsReadRootStreamLength,
  buildPipelineFormPredicate,
  captureRootStreamLength,
  EMPTY_ENCLOSING,
  detectLookupCall,
  lowerLookup,
  extractLookupCalls,
  createSlotAllocator,
  predicateReferencesOuterDoc,
  validateLookupShape,
  translatePredicate,
  extractLookupTarget,
  requireSameDbColl,
  lowerLambdaPredicate,
  type LookupCall,
  type LookupTarget,
  type SlotAllocator,
  type SubPipelineLowerer,
} from "./lookup-translation.ts";
import { detectUnionPush, lowerUnionPush } from "./union-translation.ts";
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

/**
 * `assert(condition[, message])` — a pipeline-statement guard that lowers to a
 * `$match` carrying a conditional `$convert` (see `generateAssertGuardExpr` in
 * codegen.ts and docs/specs/assert.md). A bare-identifier call to `assert`.
 * Expression-position uses are rejected in codegen; this only flags the
 * statement form so both pipeline forms route it through `lowerStatementTail`.
 */
export function isAssertCall(el: ArrayElement): el is Extract<Expr, { type: "CallExpression" }> {
  return el.type === "CallExpression" && el.callee.type === "ParamRef" && el.callee.name === ASSERT_FN_NAME;
}

/** Stages that replace the document and so drop all in-scope `let` bindings. */
const RESHAPE_CLEARING_STAGES = new Set(["$group", "$bucket", "$bucketAuto", "$replaceRoot", "$replaceWith", "$facet"]);

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
  // Update ops (`$.a = 1`, `delete $.x`), `let` bindings, and function
  // declarations are pipeline statements — they lower to $set / $unset stages
  // (or, for a function declaration, to nothing). Recognising them here flips
  // the array into pipeline mode even when no `$stage`-shaped element comes
  // first (`[let x = 5, $match(x > 0)]` / `[const f = a => a, $set(...)]`).
  if (el.type === "AssignExpr" || el.type === "DeleteStmt" || el.type === "LetDecl" || el.type === "FuncDecl") {
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
  // `assert(cond[, msg])` is a statement-style guard that lowers to a `$match`
  // stage. Recognising it here flips a leading-`assert` array / single-statement
  // block into pipeline mode (same pattern as `$$.push(...)` above).
  if (isAssertCall(el)) return true;
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
 * Statement-position `Object.assign(target, ...sources)` — JavaScript's
 * *mutating* merge: it writes the merged object back into `target` and returns
 * it. jsmql mirrors that at pipeline-statement position:
 *
 *   - **target = in-scope `let`/`const` binding** → one `$set` re-materialising
 *     the binding's slot to `$mergeObjects[<slot>, ...sources]`. Allowed on a
 *     `const` binding: mutating a const-bound object is legal JS (only
 *     *rebinding* via `=` is not), so the const-reassignment guard in
 *     `tryLowerAssignSugar` is deliberately bypassed here.
 *   - **target = writable field path** (`$.profile`, `$.a.b`) → desugars to
 *     `$.profile = Object.assign($.profile, …)`, flowing through the same `$set`
 *     coalescer as `$.x = …` and the array mutators (so a read-after-write
 *     splits stages correctly).
 *
 * Returns `null` when `node` isn't a statement-position `Object.assign(...)`
 * we can lower as a mutation (no args, spread target, or a target that is
 * neither an in-scope binding nor a writable field path). The caller then lets
 * the generic stage path raise its error. Expression-position `Object.assign`
 * (inside a stage body, a `$match`, etc.) never reaches here — it lowers to
 * `$mergeObjects` through codegen, unchanged. See docs/specs/update-filter.md
 * § Object.assign and docs/LANGUAGE.md § Mutators.
 */
type ObjectAssignMutation =
  | { kind: "binding"; slot: string; call: Expr }
  | { kind: "field"; assign: AssignExpr }
  | { kind: "reject"; message: string; pos: number };

function classifyObjectAssignStmt(node: Expr, ctx: GenerateCtx): ObjectAssignMutation | null {
  // Only a bare `Object.assign(...)` statement is a mutation; everything else
  // (other Object statics, non-ObjectCall nodes) falls through untouched.
  if (node.type !== "ObjectCall" || node.method !== "assign") return null;
  const target = node.args.length === 0 ? null : node.args[0];
  if (target !== null && target.type === "ParamRef") {
    const slot = ctx.pipelineLets?.get(target.name);
    if (slot !== undefined) return { kind: "binding", slot, call: node };
    return {
      kind: "reject",
      message:
        `Cannot 'Object.assign(${target.name}, …)' — '${target.name}' isn't a 'let'/'const' binding in scope. ` +
        `Declare it first with 'let ${target.name} = …', or write '$.${target.name}' to mutate a document field.`,
      pos: node.pos,
    };
  }
  if (target !== null && target.type !== "SpreadElement" && isWritableFieldPath(target)) {
    return { kind: "field", assign: { type: "AssignExpr", target, value: node, pos: node.pos } };
  }
  // It IS `Object.assign(...)` at statement position, but the first argument
  // isn't a persistable mutation target — name what a valid target looks like.
  return {
    kind: "reject",
    message:
      `'Object.assign(...)' at statement position mutates its first argument, but ` +
      `${target === null ? "no first argument was given" : "the first argument isn't a writable target"}. ` +
      `Pass a document field ('$.profile') or an in-scope 'let'/'const' binding — ` +
      `e.g. 'Object.assign($.profile, { … })' or 'let r = {}; Object.assign(r, { … })'. ` +
      `(To build a merged object as a value, assign it: '$.merged = Object.assign(a, b)'.)`,
    pos: node.pos,
  };
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
  // Pipeline context: `$`-prefixed string literals pass through verbatim
  // (field paths / wire syntax), never auto-wrapped in `$literal`. See
  // GenerateCtx.pipelineContext. `topLevelStream` gates `$$.length` to this
  // top-level pipeline (dropped by freshSubPipelineCtx for sub-pipelines).
  let ctx: GenerateCtx = { ...startCtx, pipelineContext: true, topLevelStream: true };
  let everHadLet = false;
  const validator = makePipelineValidator("top");
  const tracking = makeSlotTracking(startCtx.slotAllocator);

  const flushUpdateOps = () => {
    if (updateBuffer.length === 0) return;
    for (const stage of generateUpdateOpGroups(updateBuffer, ctx)) out.push(stage);
    updateBuffer = [];
  };

  // `$$.length` materialisation: emit the `$setWindowFields` count stage before
  // the first use, reuse it while it stays fresh, recompute after an
  // invalidating stage. `lengthSlotAt` is the `out` index right after the last
  // materialise (null = never materialised). See the stream-length helpers above.
  let lengthSlotAt: number | null = null;
  const ensureStreamLength = () => {
    flushUpdateOps(); // land pending ops in `out` so the freshness scan sees them
    if (lengthSlotAt !== null && (out as object[]).slice(lengthSlotAt).every(stagePreservesStreamLength)) return;
    out.push(streamLengthStage());
    lengthSlotAt = out.length;
  };

  ast.elements.forEach((rawEl, i) => {
    validator.checkBeforeElement(rawEl.pos);
    if (containsStreamLength(rawEl)) ensureStreamLength();
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
    // Statement-position `Object.assign(target, …)` — JS's mutating merge.
    // A binding target emits its own `$set`; a field target becomes an
    // `AssignExpr` and falls through to the update-op coalescer below.
    if (el.type === "ObjectCall") {
      const mut = classifyObjectAssignStmt(el, ctx);
      if (mut !== null) {
        if (mut.kind === "reject") throw new CodegenError(mut.message, mut.pos);
        if (mut.kind === "binding") {
          flushUpdateOps();
          const { stages, rewritten } = extractLookupCalls(mut.call, ctx, tracking.alloc, lowerBlock);
          for (const s of stages) out.push(s);
          out.push({ $set: { [mut.slot]: generateWithCtx(rewritten, ctx) } });
          return;
        }
        el = mut.assign;
      }
    }
    if (el.type === "AssignExpr") {
      const r = tryLowerAssignSugar(el, ctx, out, flushUpdateOps, tracking.alloc, lowerBlock, out.length === 0);
      if (r.handled) {
        ctx = r.ctx;
        if (r.outPos !== null) validator.markSugarOut(r.outPos);
        return;
      }
      updateBuffer.push(r.bufferOp);
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
    if (el.type === "FuncDecl") {
      flushUpdateOps();
      ctx = lowerFuncDecl(el, ctx);
      return;
    }
    if (el.type === "LetDecl") {
      flushUpdateOps();
      const direct = detectLookupCall(el.value, ctx);
      if (direct !== null) {
        validateLookupShape(el.value);
        const slot = bindingSlot(el.name);
        const stages = lowerLookup(direct, slot, ctx, lowerBlock);
        for (const s of stages) out.push(s);
        ctx = extendCtxLets(ctx, el.name, slot);
        everHadLet = true;
        return;
      }
      const { stages: prologue, rewritten } = extractLookupCalls(el.value, ctx, tracking.alloc, lowerBlock);
      for (const s of prologue) out.push(s);
      const stage = lowerLetDecl({ type: "LetDecl", name: el.name, value: rewritten, kind: el.kind, pos: el.pos }, ctx);
      out.push(stage.set);
      ctx = stage.ctx;
      everHadLet = true;
      return;
    }
    flushUpdateOps();
    ctx = lowerStatementTail(el, i, ctx, out, validator, tracking.alloc, lowerBlock);
  });
  flushUpdateOps();
  if ((everHadLet || tracking.used() || lengthSlotAt !== null) && !shouldSkipTrailingNamespaceUnset(out)) {
    out.push({ $unset: JSMQL_NS });
  }
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
  // Pipeline context: see GenerateCtx.pipelineContext (string literals pass through).
  // `topLevelStream` gates `$$.length` — set ONLY at the top level; a
  // sub-pipeline (container !== "top") leaves it off so codegen rejects
  // `$$.length` there (it would mean the sub-stream — not supported, [DEF-033]).
  let ctx: GenerateCtx = { ...startCtx, pipelineContext: true, topLevelStream: container === "top" };
  let everHadLet = false;
  const validator = makePipelineValidator(container);
  const tracking = makeSlotTracking(startCtx.slotAllocator);
  // Sub-stream length handles in scope (a block-body `.filter`/`.map` 3rd param,
  // bound by buildBlockBodyPredicate). Their `.length` materialises a
  // `$setWindowFields` `$count` in THIS pipeline, exactly like `$$.length`.
  const handleNames: ReadonlySet<string> = new Set(ctx.substreamLengthHandles?.keys() ?? []);

  // `$$.length` materialisation. The implicit (`;`-separated) form never buffers
  // update ops (`;` is a hard boundary), so no flush is needed before the scan.
  let lengthSlotAt: number | null = null;
  const ensureStreamLength = () => {
    if (lengthSlotAt !== null && (out as object[]).slice(lengthSlotAt).every(stagePreservesStreamLength)) return;
    out.push(streamLengthStage());
    lengthSlotAt = out.length;
  };

  p.stmts.forEach((rawStmt, i) => {
    validator.checkBeforeElement(rawStmt.pos);
    // Stream length: `$$.length` (top-level), or a bound sub-stream handle's
    // `.length` (inside a block-body lookup, where `container === "top"` via
    // `lowerBlock`). Materialise the `$setWindowFields` ahead of the using stage.
    if ((container === "top" || handleNames.size > 0) && containsStreamLength(rawStmt, handleNames)) {
      ensureStreamLength();
    }
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
    if (stmt.type === "FuncDecl") {
      ctx = lowerFuncDecl(stmt, ctx);
      return;
    }
    // Statement-position `Object.assign(target, …)` — JS's mutating merge.
    // A binding target emits its own `$set`; a field target is wrapped as a
    // single-op `UpdateFilter` so it routes through the same path as `$.x = …`.
    if (stmt.type === "ObjectCall") {
      const mut = classifyObjectAssignStmt(stmt, ctx);
      if (mut !== null) {
        if (mut.kind === "reject") throw new CodegenError(mut.message, mut.pos);
        if (mut.kind === "binding") {
          const { stages, rewritten } = extractLookupCalls(mut.call, ctx, tracking.alloc, lowerBlock);
          for (const s of stages) out.push(s);
          out.push({ $set: { [mut.slot]: generateWithCtx(rewritten, ctx) } });
          return;
        }
        stmt = { type: "UpdateFilter", ops: [mut.assign], pos: mut.assign.pos };
      }
    }
    if (stmt.type === "LetDecl") {
      const direct = detectLookupCall(stmt.value, ctx);
      if (direct !== null) {
        validateLookupShape(stmt.value);
        const slot = bindingSlot(stmt.name);
        const stages = lowerLookup(direct, slot, ctx, lowerBlock);
        for (const s of stages) out.push(s);
        ctx = extendCtxLets(ctx, stmt.name, slot);
        everHadLet = true;
        return;
      }
      const { stages: prologue, rewritten } = extractLookupCalls(stmt.value, ctx, tracking.alloc, lowerBlock);
      for (const s of prologue) out.push(s);
      const stage = lowerLetDecl(
        { type: "LetDecl", name: stmt.name, value: rewritten, kind: stmt.kind, pos: stmt.pos },
        ctx,
      );
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
    ctx = lowerStatementTail(stmt as Expr, i, ctx, out, validator, tracking.alloc, lowerBlock);
  });

  if ((everHadLet || tracking.used() || lengthSlotAt !== null) && !shouldSkipTrailingNamespaceUnset(out)) {
    out.push({ $unset: JSMQL_NS });
  }
  return out;
}

type LetLowering = { set: Record<string, unknown>; ctx: GenerateCtx };

/**
 * Lower a reusable-function declaration: register `name → lambda` in the ctx
 * and emit NO stage. Mirrors `lowerLetDecl`'s collision guards (re-declaration,
 * clash with a `let`/`const` binding or a function-form parameter). See
 * docs/specs/reusable-functions.md.
 */
function lowerFuncDecl(decl: FuncDecl, ctx: GenerateCtx): GenerateCtx {
  if (ctx.functions?.has(decl.name)) {
    throw new CodegenError(
      `Function \`${decl.name}\` is already declared earlier in this pipeline. ` +
        `Re-declaration in the same scope is not allowed — pick a different name.`,
      decl.pos,
    );
  }
  if (ctx.pipelineLets?.has(decl.name)) {
    throw new CodegenError(
      `Function \`${decl.name}\` collides with a \`${ctx.pipelineConstNames?.has(decl.name) ? "const" : "let"} ${decl.name}\` binding already in scope. ` +
        `Rename one — a reusable function and a value binding can't share a name.`,
      decl.pos,
    );
  }
  if (ctx.bindings?.has(decl.name)) {
    throw new CodegenError(
      `Function \`${decl.name}\` shadows a function-form parameter binding of the same name. Rename one.`,
      decl.pos,
    );
  }
  // `$$.length` inside a reusable function body would be inlined at each call
  // site, but the body lives in the ctx (not the inline AST), so the
  // materialiser can't see it to hoist the `$setWindowFields` ahead of the
  // calling stage. Reject it rather than emit a dangling `$__jsmql.length`.
  if (someExpr(decl.lambda, (e) => isStreamLengthNode(e, NO_HANDLES))) {
    throw new CodegenError(
      `'$$.length' isn't supported inside a reusable function body yet [DEF-033]. ` +
        `Read it at the top level of the pipeline (e.g. \`let n = $$.length;\`) and pass the value in as a parameter.`,
      decl.pos,
    );
  }
  return extendCtxFunctions(ctx, decl);
}

function lowerLetDecl(decl: LetDecl, ctx: GenerateCtx): LetLowering {
  if (ctx.functions?.has(decl.name)) {
    throw new CodegenError(
      `\`${decl.kind} ${decl.name}\` collides with a reusable function \`${decl.name}\` already declared in this pipeline. ` +
        `Rename one — a value binding and a function can't share a name.`,
      decl.pos,
    );
  }
  if (ctx.pipelineLets?.has(decl.name)) {
    throw new CodegenError(
      `\`${decl.kind} ${decl.name}\` is already declared earlier in this pipeline. ` +
        `Re-declaration in the same scope is not allowed — ${decl.kind === "const" ? "" : "reassign it (`" + decl.name + " = …`), "}pick a different name, ` +
        `or rebind after a reshape stage (\`$group\`, \`$replaceRoot\`, …).`,
      decl.pos,
    );
  }
  if (ctx.bindings?.has(decl.name)) {
    throw new CodegenError(
      `\`${decl.kind} ${decl.name}\` shadows a function-form parameter binding of the same name. ` +
        `Rename one — parameter bindings are compile-time constants supplied at call time, ` +
        `\`${decl.kind}\` bindings are per-document values derived from a stage expression; ` +
        `mixing them under one name would be ambiguous.`,
      decl.pos,
    );
  }
  const fieldPath = bindingSlot(decl.name);
  const value = generateWithCtx(decl.value, ctx);
  return {
    set: { $set: { [fieldPath]: value } },
    ctx: extendCtxLets(ctx, decl.name, fieldPath, decl.kind, staticBindingType(decl.value)),
  };
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
 * Does this UpdateFilter contain a bare `$ = <expr>` root-replace op? A single
 * top-level `$ = <expr>` written **without** a trailing `;` parses as a one-op
 * `UpdateFilter` (not a `Pipeline`), so it never reaches `tryLowerAssignSugar`.
 * `index.ts` uses this to reroute such an UpdateFilter through the pipeline
 * lowerer (`generateImplicitPipeline`) so it emits `$replaceWith` — identical to
 * the `;`-terminated form — instead of a meaningless `$set` on the "" field
 * path. Parallel to `containsOutAssign` (out-translation.ts), which reroutes the
 * sibling `$$$.<coll> = …` `$out` sugar the same way. See
 * docs/specs/replace-root-stage.md.
 */
export function updateFilterHasReplaceRoot(uf: UpdateFilter): boolean {
  return uf.ops.some((op) => op.type === "AssignExpr" && isReplaceRootAssign(op));
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
 *     `__jsmql.tmp.<N>` slot) followed by `$replaceWith: { $first: "$<slot>" }`.
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
  // `$ = [<docs>]` and other provably-array RHS fan out: one output document per
  // element, via `$set` into a temp slot → `$unwind` → `$replaceWith`. Array
  // literals are validated element-wise here; non-literal array expressions
  // (`.map`, `Object.entries`, …) are handled after the lookup check below.
  if (el.value.type === "ArrayLiteral") {
    if (el.value.elements.length === 0) {
      throw new CodegenError(
        `Cannot fan out an empty array — '$ = []' would discard every document. To drop documents conditionally, fan out a data-dependent array (e.g. '$ = $.items.filter(...)'); to empty the stream, use '$$ = []'.`,
        el.value.pos,
      );
    }
    rejectScalarFanOutElements(el.value);
    return lowerFanOut(el.value, ctx, allocSlot, lowerBlockFn);
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
    const from = requireSameDbColl(direct.db, direct.collection, direct.pos);
    const stages: object[] = [];
    if (pred.kind === "basic") {
      stages.push({ $lookup: { from, localField: pred.localField, foreignField: pred.foreignField, as: slot } });
    } else {
      stages.push({ $lookup: { from, let: pred.letVars, pipeline: pred.pipeline, as: slot } });
    }
    stages.push({ $replaceWith: { $first: `$${slot}` } });
    return stages;
  }

  // Non-literal provably-array RHS (`.map`, `.filter`, `Object.entries`, array
  // operators, …) fans out too — same lowering as the array-literal case.
  if (staticBindingType(el.value) === "array") {
    return lowerFanOut(el.value, ctx, allocSlot, lowerBlockFn);
  }

  const { stages: prologue, rewritten } = extractLookupCalls(el.value, ctx, allocSlot, lowerBlockFn);
  const out: object[] = [...prologue];
  out.push({ $replaceWith: generateWithCtx(rewritten, ctx) });
  return out;
}

type ArrayLiteralNode = Extract<Expr, { type: "ArrayLiteral" }>;

/**
 * Lower a provably-array `$ = <arr>` to a fan-out: materialise the array into a
 * compiler-owned slot, `$unwind` it (one output document per element — empty
 * arrays drop the document, standard `$unwind` behaviour), then `$replaceWith`
 * each element as the new root. `$unwind` needs a field path, so the inline
 * array can't be unwound directly — hence the `$set` into a slot. Buried lookups
 * inside the array materialise as prologue stages first.
 */
function lowerFanOut(
  arr: Expr,
  ctx: GenerateCtx,
  allocSlot: SlotAllocator,
  lowerBlockFn: SubPipelineLowerer,
): object[] {
  const { stages: prologue, rewritten } = extractLookupCalls(arr, ctx, allocSlot, lowerBlockFn);
  const slot = allocSlot();
  return [
    ...prologue,
    { $set: { [slot]: generateWithCtx(rewritten, ctx) } },
    { $unwind: `$${slot}` },
    { $replaceWith: `$${slot}` },
  ];
}

/**
 * Each fanned-out element becomes a document root, so a provably-scalar element
 * (`$ = [1, 2]`, `$ = ["a"]`, …) can never be a valid root — reject it up front
 * with an actionable message rather than emitting MQL the server will refuse.
 * Spreads, object literals, field refs, ternaries, and calls are trusted (the
 * server validates document-shape at runtime if our static check missed it).
 */
function rejectScalarFanOutElements(arr: ArrayLiteralNode): void {
  for (const el of arr.elements) {
    const kind = scalarFanOutElementKind(el);
    if (kind !== null) {
      throw new CodegenError(
        `Cannot fan out an array of ${kind} — each array element becomes a document root, so elements must be documents. Did you mean to wrap them: '$ = [{ value: ... }]'?`,
        el.pos,
      );
    }
  }
}

function scalarFanOutElementKind(el: ArrayElement): string | null {
  switch (el.type) {
    case "NumberLiteral":
      return "number";
    case "BigIntLiteral":
      return "bigint";
    case "StringLiteral":
    case "TemplateLiteral":
      return "string";
    case "BooleanLiteral":
      return "boolean";
    case "NullLiteral":
      return "null";
    case "RegexLiteral":
      return "regex";
    default:
      return null;
  }
}

/**
 * Reject scalar-literal RHS shapes that the user wouldn't have meant as a new
 * document root. Permissive by design — anything that *might* be a document
 * (FieldRef, MemberAccess, ObjectLiteral, OperatorCall, MethodCall, BinaryExpr,
 * ternaries, `$let`-style helpers) passes through; MongoDB validates
 * document-shape at runtime if our static check missed something. Array RHS is
 * handled earlier by the fan-out path in `lowerReplaceRoot`, not here.
 */
function rejectNonDocumentReplaceRoot(value: Expr): void {
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
  //   - `$$ = []` → `[{ $match: { $expr: false } }]` (drop all docs; pre-1.0 sugar item #2)
  //   - `$$ = [{...}, {...}]` at stage 0 → `[{ $documents: [...] }]`
  //     (literal-doc seed; MongoDB requires $documents to be the first stage)
  //   - `$$ = [{...}, {...}]` mid-pipeline → throw, naming `$$.push(...)` as
  //     the right tool for appending docs to an existing stream.
  if (v.type === "ArrayLiteral") {
    if (v.elements.length === 0) {
      // Drop every document. `$limit: 0` is rejected by the server ("the limit
      // must be positive"), so emit a never-matching `$match` instead.
      return { stages: [{ $match: { $expr: false } }], clearLets: false };
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
  const clearLets = applyStreamMethods(methods, stages, outerCtx, lowerBlockFn, allocSlot, rhs);
  return { stages, clearLets };
}

/**
 * Apply a `$$`-rooted method chain onto `target`, appending each method's
 * stages and using `target` itself as the `prevStages` view (and the
 * `replacesPreviousStage` pop target).
 *
 * Shared by two callers that differ only in *which* buffer they pass:
 *   - `lowerChainOnStream` (the `$$ = $$.<chain>` assignment form) passes a
 *     fresh local array, so the chain composes only against itself.
 *   - `lowerStatementTail` (the bare `$$.<chain>;` statement form) passes the
 *     live pipeline `out`, so a stage-coupled method (`.toReversed`) flips the
 *     `$sort` emitted just before it — whether that `$sort` came from an
 *     earlier method in this chain OR an earlier *statement*. That's what makes
 *     `$$.toSorted(c).toReversed();` and `$$.toSorted(c); $$.toReversed();`
 *     lower identically.
 *
 * The first method may be `.filter(<lambda>)` → a `$match` stage (predicate
 * translated in `ctx` so prior `let` bindings resolve). Any subsequent method,
 * or a non-`.filter` first method, dispatches through the stream-method
 * registry; unknown names throw an actionable error. Returns whether any
 * method cleared the `let` scope (the caller applies `clearCtxLets`).
 */
function applyStreamMethods(
  methods: MethodCallNode[],
  target: object[],
  ctx: GenerateCtx,
  lowerBlockFn: SubPipelineLowerer,
  allocSlot: SlotAllocator,
  rhs: Expr,
): boolean {
  let clearLets = false;
  for (let i = 0; i < methods.length; i++) {
    const m = methods[i];
    // `.filter` is handled outside the registry (its predicate translation is
    // shared with $unionWith/$facet). It may appear anywhere in the chain — as
    // the head, or after a reshaping method like `.flatMap`/`.groupBy`.
    if (m.method === "filter") {
      target.push(...lowerStreamFilterArg(m, ctx, lowerBlockFn, rhs, i === 0));
      continue;
    }
    const def = lookupStreamMethod(m.method);
    if (def === null) {
      throw unknownStreamMethod(m, "$$");
    }
    def.validate(m.args, m.pos);
    const result = def.lower(m.args, ctx, m.pos, lowerBlockFn, target, allocSlot, false);
    if (result.replacesPreviousStage) target.pop();
    target.push(...result.stages);
    if (result.clearLets) clearLets = true;
  }
  return clearLets;
}

/**
 * Lower a `.filter(...)` in a `$$` stream chain to `$match` stages. Accepts an
 * arrow predicate (`o => …`, via the shared predicate lowering) or the lodash
 * matches-object shorthand (`{ field: value, … }` → an equality `$match` query).
 * `isHead` gates the "RHS must be `.filter(<predicate>)`" error to the chain head
 * (where a bad shape means the whole `$$ = …` RHS is unrecognised).
 */
function lowerStreamFilterArg(
  m: MethodCallNode,
  ctx: GenerateCtx,
  lowerBlockFn: SubPipelineLowerer,
  rhs: Expr,
  isHead: boolean,
): object[] {
  if (m.args.length === 1 && m.args[0].type === "Lambda") {
    return lowerStreamFilterPredicate(m.args[0] as LambdaNode, ctx, lowerBlockFn);
  }
  if (m.args.length === 1 && m.args[0].type === "ObjectLiteral") {
    return [{ $match: generateWithCtx(m.args[0], ctx) }];
  }
  if (isHead) rejectInvalidReplaceStream(rhs, ctx);
  throw new CodegenError(
    `.filter(<predicate> | { field: value, … }) takes a single arrow predicate ('o => …') or a matches-object.`,
    m.pos,
  );
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
  target: LookupTarget,
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
  // Non-correlated source-switch: the stream is REPLACED by `target` (a
  // `$unionWith`), so outer context — the outer document, the root `$$.length`,
  // and outer `let`s — doesn't cross. Record the switch on the sub-pipeline ctx
  // so a chain-body reference to any of it produces a precise "correlate with a
  // `.filter`" error rather than a bare "unknown identifier" / "use the param"
  // (the head here was already classified as non-correlated, so the outer values
  // genuinely can't be threaded).
  const switchDesc =
    target.db !== undefined ? `$$ = $$$$.${target.db}.${target.collection}` : `$$ = $$$.${target.collection}`;
  const innerCtx: GenerateCtx = {
    ...freshSubPipelineCtx(outerCtx),
    sourceSwitch: { desc: switchDesc, letNames: new Set(outerCtx.pipelineLets?.keys() ?? []) },
  };
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
  const from = requireSameDbColl(target.db, target.collection, target.pos);
  // Drop the incoming stream, then union in the switched source. `$limit: 0`
  // is rejected by the server ("the limit must be positive"), so clear the
  // stream with a never-matching `$match` instead.
  const stages: object[] = [{ $match: { $expr: false } }];
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
  target: LookupTarget,
  outerCtx: GenerateCtx,
  lowerBlockFn: SubPipelineLowerer,
  allocSlot: SlotAllocator,
): { stages: object[]; clearLets: boolean } {
  const filterMethod = methods[0];
  const restMethods = methods.slice(1);
  const lambda = filterMethod.args[0] as LambdaNode;
  const slot = allocSlot();
  const from = requireSameDbColl(target.db, target.collection, target.pos);
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
    // `$$.length` (the ROOT stream count) used in any chain method body →
    // capture the top-materialised `$__jsmql.length` into this lookup's
    // `$lookup.let` (a top-level pivot is depth 0 → `v0_length`) so the sub-pipeline
    // reads it as `$$v0_length`. `$$` is always the ROOT stream; inner sub-stream
    // counts use the 3rd-arg handle.
    const usesRootLen = restMethods.some((m) => argsReadRootStreamLength(m.args));
    // Carry the outer pipeline's `let`s on the chain ctx so a chain `.map` can
    // capture an outer-`let` reference into the lookup's `$lookup.let` (the
    // `.filter` head already does via its own `outerCtx`). The sub-pipeline
    // lowerer rewrites every such ref to its `$$`-var, so codegen never reads a
    // raw outer-`let` as a sub-pipeline field.
    const innerCtx: GenerateCtx = {
      ...captureRootStreamLength(usesRootLen, 0, letVars, freshSubPipelineCtx(outerCtx)),
      pipelineLets: outerCtx.pipelineLets,
      // Signal "inside a correlated `$lookup`" (depth 0) so a chain `.map` routes
      // through `lowerCallbackBlock` and captures cross-level reads into THIS
      // lookup's `let` — unlike a flat `$unionWith`, which leaves it unset.
      enclosingLookup: EMPTY_ENCLOSING,
    };
    for (const m of restMethods) {
      const def = lookupStreamMethod(m.method);
      if (def === null) {
        throw unknownStreamMethod(m, "$$$.<coll>");
      }
      def.validate(m.args, m.pos);
      const result = def.lower(m.args, innerCtx, m.pos, lowerBlockFn, pipelineBody, allocSlot, true);
      if (result.replacesPreviousStage) pipelineBody.pop();
      pipelineBody.push(...result.stages);
      // A block-body `.map` chain method may capture cross-level reads
      // (`$.<field>`, …) into this lookup's `$lookup.let`.
      if (result.extraLetVars) Object.assign(letVars, result.extraLetVars);
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
  // The bare `$$` stream also accepts `.push(...)` as a statement-level method
  // (→ `$unionWith`); it isn't a chain method, but naming it in the suggestion
  // set catches `.pop` / `.shift` mix-ups that a JS dev reaches for.
  const isStream = receiver === "$$";
  const hint = didYouMean(m.method, isStream ? ["filter", "push", ...names] : ["filter", ...names], (s) => `.${s}`);
  const list = names.length > 0 ? names.map((n) => `.${n}`).join(", ") : "(none yet)";
  const pushNote = isStream ? ` ('.push(...)' appends documents as a statement → $unionWith.)` : "";
  return new CodegenError(
    `'.${m.method}(...)' is not a chainable stream method on '${receiver}'.${hint} ` +
      `The chain head may be '.filter(<predicate>)'; subsequent methods must come from the stream-method registry: ${list}.${pushNote}`,
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
        `'.filter(<predicate>)' predicate has a block body with local \`const\`/\`let\` bindings, which isn't supported in this position. Write the predicate as a single expression — \`function (x) { return <expr> }\` / \`(x) => <expr>\` — and fold any bindings into <expr>.`,
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
      `'$$ = <ternary>' (conditional stream branching) is not a supported form — a stream has no single condition that swaps the whole stream for A or B. The RHS of '$$ = …' must be '$$.filter(<predicate>)' (narrow the current stream) or '$$$.<coll>.filter(<predicate>)' (switch source to another collection).`,
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
    // `?? {}` is defensive — translateMatchBody never yields empty-query +
    // null-residual (a vacuous body lands in the residual as `$expr`).
    return mergeTranslatedQuery(t, ctx) ?? {};
  }

  // $unwind: its body is field-path DATA, not an expression — a bare path
  // string ("$items") or { path: "$items", includeArrayIndex, preserveNull... }.
  // The leading `$` is the path the user wants, NOT a string to protect with
  // $literal (that wrap is for expression contexts). validateUnwind already
  // enforced the `$`-prefix, and `ctx.pipelineContext` (seeded at every
  // pipeline entrypoint) already suppresses the `$literal` wrap here, so the
  // path emits raw with the surrounding ctx.
  if (stageName === "$unwind") {
    if (body.type === "ObjectLiteral") return generateBodyObject(body, stageName, ctx);
    return generateWithCtx(body, ctx);
  }

  // Other stages: if the body is an object literal, walk its entries so we
  // can spot sub-pipeline slots; otherwise generate directly. These bodies are
  // aggregation expressions (not query documents — that's `$match` above), so
  // mark `aggExpr` to enable the comparison-operator arity check. Sub-pipeline
  // slots reset to a fresh ctx (so a nested `$match` isn't mis-marked).
  const aggCtx: GenerateCtx = { ...ctx, aggExpr: true };
  if (body.type === "ObjectLiteral") {
    return generateBodyObject(body, stageName, aggCtx);
  }
  return generateWithCtx(body, aggCtx);
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
  // Nested lookups inside both expression-body and block-body predicates are
  // materialised by `extractLookupCalls` with an `EnclosingLookupContext`
  // thread-through (see lookup-translation.ts; the block-body path supplies the
  // context via `GenerateCtx.enclosingLookup`). `$facet`/`$unionWith`
  // sub-pipelines also walk through this path, caught at the per-statement level
  // when `extractLookupCalls` runs over each stage body.
  for (const el of ast.elements) {
    // `$$.push(...)` inside a sub-pipeline targets the *outer* collection but
    // emits stages that would live inside the inner pipeline — the semantics are
    // ambiguous and the MongoDB server has no equivalent shape. Reject.
    if (el.type !== "SpreadElement") {
      const innerPush =
        el.type === "AssignExpr" || el.type === "DeleteStmt" || el.type === "LetDecl" || el.type === "FuncDecl"
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
  // Pipeline context: see GenerateCtx.pipelineContext (string literals pass through).
  let ctx: GenerateCtx = { ...startCtx, pipelineContext: true };
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
    if (el.type === "FuncDecl") {
      flushUpdateOps();
      ctx = lowerFuncDecl(el, ctx);
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
  if (everHadLet && !shouldSkipTrailingNamespaceUnset(out)) out.push({ $unset: JSMQL_NS });
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
      stmt.type === "LetDecl" || stmt.type === "FuncDecl" || stmt.type === "UpdateFilter"
        ? null
        : detectUnionPush(stmt as Expr);
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
 * the end of a top-level pipeline — `__jsmql.tmp.<N>` slots ride the same
 * cleanup as `let`-bindings, so a pipeline with no lets but at least one
 * lookup still needs the trailing `$unset`.
 */
function makeSlotTracking(external?: SlotAllocator): { alloc: SlotAllocator; used: () => boolean } {
  // When an enclosing chain threads its allocator in (via ctx.slotAllocator),
  // continue *its* counter so nested `__jsmql.tmp.<N>` slots stay globally
  // distinct within the emitted pipeline; otherwise start a fresh per-pipeline
  // counter. Either way `touched` tracks whether THIS pipeline handed one out
  // (drives the trailing `$unset "__jsmql"` decision).
  const base = external ?? createSlotAllocator();
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
/**
 * The `$ =`-rooted / lookup `AssignExpr` sugar chain, shared by both pipeline
 * forms — `generatePipeline`'s `[…]` elements and `lowerUpdateFilterWithLookups`'s
 * `,`-grouped ops. Tries each sugar in order and, on a hit, flushes the caller's
 * update buffer (via `flush`), pushes the lowered stages onto `out`, and returns
 * the (possibly let-cleared) ctx:
 *   - `$$ = …`                              → replace-stream stages
 *   - `$ = { k: $$.filter(…) }`             → `$facet`
 *   - `$ = <expr>`                          → `$replaceWith`
 *   - `$$$.<coll> = …`                      → `$out` (signalled via `outPos`)
 *   - `$.<f> = $$$.<coll>.find/filter(…)`   → `$lookup`
 * On a miss it returns `{ handled: false, bufferOp }` — the rewritten op (any
 * buried lookups already hoisted onto `out`) for the caller to push onto its
 * own update buffer.
 *
 * Per-form differences stay with the caller: first-stage detection (`isFirst`),
 * loop control (`return` vs `continue`), the buffer identity, and how an `$out`
 * terminal is recorded (`validator.markSugarOut` vs a `TerminalState`) — keyed
 * off the returned `outPos`.
 */
type AssignSugarResult =
  | { handled: true; ctx: GenerateCtx; outPos: number | null }
  | { handled: false; bufferOp: AssignExpr };

function tryLowerAssignSugar(
  op: AssignExpr,
  ctx: GenerateCtx,
  out: unknown[],
  flush: () => void,
  allocSlot: SlotAllocator,
  lowerBlockFn: SubPipelineLowerer,
  isFirst: boolean,
): AssignSugarResult {
  // `<name> = …` — reassignment of a pipeline `let` binding. The bare-identifier
  // target (a `ParamRef`) is unique to this case — every other assign sugar is
  // rooted at a `FieldRef` / context-ref — so dispatch on it first. A `let`
  // re-`$set`s its materialised slot; a `const` is read-only; an undeclared
  // name isn't assignable. See docs/specs/let-bindings.md § Reassignment.
  if (op.target.type === "ParamRef") {
    const name = op.target.name;
    if (ctx.pipelineConstNames?.has(name)) {
      throw new CodegenError(
        `Cannot reassign \`${name}\` — it is a \`const\` binding. ` +
          `Declare it with \`let ${name} = …\` instead if its value needs to change.`,
        op.pos,
      );
    }
    const letPath = ctx.pipelineLets?.get(name);
    if (letPath !== undefined) {
      flush();
      const { stages, rewritten } = extractLookupCalls(op.value, ctx, allocSlot, lowerBlockFn);
      for (const s of stages) out.push(s);
      out.push({ $set: { [letPath]: generateWithCtx(rewritten, ctx) } });
      return { handled: true, ctx, outPos: null };
    }
    const droppedBy = ctx.droppedLets?.get(name);
    if (droppedBy !== undefined) {
      throw new CodegenError(
        `\`${name}\` is a \`let\` binding and can't be reassigned after \`${droppedBy}\` — ` +
          `the stage replaces the document. Rebind it after the stage with \`let ${name} = …\`.`,
        op.pos,
      );
    }
    throw new CodegenError(
      `Cannot assign to bare identifier '${name}' — it isn't a \`let\` binding in scope. ` +
        `Declare it first with \`let ${name} = …\`, or write \`$.${name} = …\` to set a document field.`,
      op.pos,
    );
  }
  if (isReplaceStreamAssign(op)) {
    flush();
    const result = lowerReplaceStream(op, ctx, lowerBlockFn, allocSlot, isFirst);
    for (const s of result.stages) out.push(s);
    return { handled: true, ctx: result.clearLets ? clearCtxLets(ctx, "$unionWith") : ctx, outPos: null };
  }
  if (isReplaceRootAssign(op)) {
    const facets = detectFacetShape(op.value);
    if (facets !== null) {
      flush();
      for (const s of lowerFacet(facets, ctx, lowerBlockFn)) out.push(s);
      return { handled: true, ctx: clearCtxLets(ctx, "$facet"), outPos: null };
    }
    flush();
    for (const s of lowerReplaceRoot(op, ctx, allocSlot, lowerBlockFn)) out.push(s);
    return { handled: true, ctx: clearCtxLets(ctx, "$replaceWith"), outPos: null };
  }
  const outTarget = detectOutAssign(op, ctx);
  if (outTarget !== null) {
    flush();
    for (const s of lowerOut(op, outTarget, ctx, lowerBlockFn, allocSlot)) out.push(s);
    return { handled: true, ctx, outPos: op.pos };
  }
  const direct = detectLookupCall(op.value, ctx);
  if (direct !== null) {
    validateLookupShape(op.value);
    flush();
    const asPath = updateOpWritePath(op);
    for (const s of lowerLookup(direct, asPath, ctx, lowerBlockFn)) out.push(s);
    return { handled: true, ctx, outPos: null };
  }
  const { stages, rewritten } = extractLookupCalls(op.value, ctx, allocSlot, lowerBlockFn);
  if (stages.length > 0) {
    flush();
    for (const s of stages) out.push(s);
  }
  return { handled: false, bufferOp: { type: "AssignExpr", target: op.target, value: rewritten, pos: op.pos } };
}

/**
 * The statement-tail dispatch shared by both pipeline forms: a non-assignment
 * element that is either statement-only sugar or a stage call. Tries, in order:
 *   - `$$.push(…)`                          → `$unionWith` stages
 *   - `$$.indexStats()` / `$$$$.currentOp()`/ … → a diagnostic source stage
 *     (first-stage-only)
 *   - otherwise a stage call/object         → lowered via `lowerStageElement`,
 *     with buried lookups hoisted to `out` first and stage-placement validated.
 * Pushes the resulting stage(s) onto `out` and returns the next ctx. The
 * `el.type !== "SpreadElement"` guard skips the sugar checks for a bare
 * `...spread` element (only reachable from the `[…]` form) while still routing
 * it through stage lowering.
 */
function lowerStatementTail(
  el: ArrayElement,
  i: number,
  ctx: GenerateCtx,
  out: unknown[],
  validator: ReturnType<typeof makePipelineValidator>,
  allocSlot: SlotAllocator,
  lowerBlockFn: SubPipelineLowerer,
): GenerateCtx {
  if (el.type !== "SpreadElement") {
    // `assert(cond[, msg]);` — a guard statement → one `$match` with a
    // conditional `$convert` that throws `Unknown type name: <message>` when the
    // condition is false (see generateAssertGuardExpr). A user-declared function
    // named `assert` takes precedence (falls through to the generic stage path).
    if (isAssertCall(el) && !ctx.functions?.has(ASSERT_FN_NAME)) {
      out.push({ $match: { $expr: generateAssertGuardExpr(el.args, ctx, el.pos) } });
      return ctx;
    }
    const pushCall = detectUnionPush(el as Expr);
    if (pushCall !== null) {
      for (const s of lowerUnionPush(pushCall, ctx, lowerBlockFn)) out.push(s);
      return ctx;
    }
    if (el.type === "MethodCall" && isSystemStageCall(el)) {
      const sys = resolveSystemStageCall(el);
      if (out.length > 0) throw new CodegenError(notFirstStageMessage(sys), sys.callPos);
      out.push(lowerSystemStageStmt(sys, ctx));
      return ctx;
    }
    // Bare-statement stream chain: `$$.filter(p).map(f);` (no `$$ =` head),
    // sugar for `$$ = $$.<chain>;`. Lowered against the live `out` so that a
    // stage-coupled method composes with earlier statements — guaranteeing
    // `$$.toSorted(c); $$.toReversed();` ≡ `$$.toSorted(c).toReversed();`.
    // `$$.push(...)` / `$$.indexStats()` are handled above; any other method on
    // a bare `$$` (valid stream method, or an unknown one → actionable error
    // from `applyStreamMethods`) flows through here. This supersedes the old
    // `validateUnionPushShape` statement-position hook: every `$$.<method>(...)`
    // is a CollectionRef-rooted chain, so it's caught here before reaching the
    // generic stage path.
    const streamChain = collectStreamChain(el as Expr);
    if (streamChain.root.type === "CollectionRef" && streamChain.methods.length > 0) {
      const clearLets = applyStreamMethods(
        streamChain.methods,
        out as object[],
        ctx,
        lowerBlockFn,
        allocSlot,
        el as Expr,
      );
      return clearLets ? clearCtxLets(ctx, "$unionWith") : ctx;
    }
  }
  const rewrittenEl = extractFromStageElement(el, ctx, allocSlot, lowerBlockFn, out);
  const shape = asStageShape(rewrittenEl);
  if (shape !== null) validator.checkStage(shape.name, rewrittenEl.pos ?? el.pos, i, shape.body);
  const result = lowerStageElement(rewrittenEl, i, ctx);
  out.push(result.stage);
  return result.ctx;
}

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
      const r = tryLowerAssignSugar(op, ctx, out, flush, allocSlot, lowerBlockFn, globalStageIndex + out.length === 0);
      if (r.handled) {
        ctx = r.ctx;
        if (r.outPos !== null) terminal = { stageName: "$out", pos: r.outPos, viaSugar: true };
        continue;
      }
      buffer.push(r.bufferOp);
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

// ── `$$.length` stream-cardinality materialisation ──────────────────────────────
//
// `$$.length` is the document count of the current stream at the point it's
// used. It lowers to a `$setWindowFields` that stamps `__jsmql.length` onto
// every doc, after which codegen reads it back as `"$__jsmql.length"`
// (see generateStreamLength in codegen.ts). The materialise stage is hoisted
// lazily: emitted once before the first use, reused while it stays fresh, and
// recomputed after any stage that changes the count or drops the field.
// See docs/specs/stream-length.md.

const NO_HANDLES: ReadonlySet<string> = new Set();

/**
 * Is this node a stream-cardinality `.length` reference? `$$.length` (the
 * `CollectionRef` sigil) always; `<handle>.length` (a `ParamRef`) only when the
 * name is a bound sub-stream handle (a lookup-chain `.filter`/`.map` 3rd param —
 * see GenerateCtx.substreamLengthHandles).
 */
function isStreamLengthNode(e: Expr, handleNames: ReadonlySet<string>): boolean {
  if (e.type !== "MemberAccess" || e.member !== "length") return false;
  if (e.object.type === "CollectionRef") return true;
  return e.object.type === "ParamRef" && handleNames.has(e.object.name);
}

/**
 * True if a statement reads the stream length anywhere in its (inline)
 * expressions — `$$.length`, or (when `handleNames` is supplied) a bound
 * sub-stream handle's `.length`.
 */
export function containsStreamLength(
  node: ArrayElement | PipelineStmt,
  handleNames: ReadonlySet<string> = NO_HANDLES,
): boolean {
  const pred = (e: Expr) => isStreamLengthNode(e, handleNames);
  return node.type === "UpdateFilter" ? someStmt(node, pred) : someElement(node, pred);
}

/**
 * Stages that preserve a materialised `__jsmql.length` — same count, field kept.
 * Conservative allowlist: anything else (a `$match`, `$group`, `$unwind`,
 * `$project`, `$unset`, `$replaceWith`, sugar, …) is treated as invalidating, so
 * the next `$$.length` use recomputes. Recomputing is always correct; reusing a
 * stale count is a bug — so we only keep freshness across provably-safe stages.
 */
const STREAM_LENGTH_PRESERVING = new Set(["$set", "$addFields", "$sort", "$lookup", "$setWindowFields"]);

function stagePreservesStreamLength(stage: unknown): boolean {
  if (stage === null || typeof stage !== "object") return false;
  const keys = Object.keys(stage as Record<string, unknown>);
  return keys.length === 1 && STREAM_LENGTH_PRESERVING.has(keys[0]);
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
  if (el.type === "FuncDecl") return null; // compile-time decl; lookups surface at call sites
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
    if (expr.exprBlock !== undefined) {
      for (const d of expr.exprBlock.decls) {
        const a = findFirstLookupInExpr(d.value);
        if (a !== null) return a;
      }
      return findFirstLookupInExpr(expr.exprBlock.ret);
    }
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
        } else if (stmt.type === "FuncDecl") {
          // compile-time decl; no lookup to locate here
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
