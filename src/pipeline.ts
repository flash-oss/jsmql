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

import type { Expr, ArrayElement, UpdateOp, Pipeline, LetDecl, PipelineStmt, UpdateFilter, CallArg } from "./ast.ts";
import {
  generateWithCtx,
  generateUpdateOpGroups,
  generateUpdateFilter,
  updateOpWritePath,
  CodegenError,
  EMPTY_CTX,
  extendCtxLets,
  clearCtxLets,
  ctxHasLets,
  freshSubPipelineCtx,
  internalError,
  type GenerateCtx,
} from "./codegen.ts";
import { closestNameTo } from "./levenshtein.ts";
import { lookupStage, STAGES } from "./stages.ts";
import { translateMatchBody } from "./match-translation.ts";
import {
  detectLookupCall,
  lowerLookup,
  extractLookupCalls,
  createSlotAllocator,
  validateLookupShape,
  type SlotAllocator,
  type SubPipelineLowerer,
} from "./lookup-translation.ts";

type StageShape = { name: string; body: Expr };

/** Stages that replace the document and so drop all in-scope `let` bindings. */
const RESHAPE_CLEARING_STAGES = new Set(["$group", "$bucket", "$bucketAuto", "$replaceRoot", "$replaceWith"]);

/** Compiler-owned namespace for materialised `let` bindings. */
const LET_NAMESPACE = "__jsmql";

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
  const tracking = makeSlotTracking();

  const flushUpdateOps = () => {
    if (updateBuffer.length === 0) return;
    for (const stage of generateUpdateOpGroups(updateBuffer, ctx)) out.push(stage);
    updateBuffer = [];
  };

  ast.elements.forEach((el, i) => {
    if (el.type === "AssignExpr") {
      const direct = detectLookupCall(el.value);
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
      updateBuffer.push(el);
      return;
    }
    if (el.type === "LetDecl") {
      flushUpdateOps();
      const direct = detectLookupCall(el.value);
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
    const rewrittenEl = extractFromStageElement(el, ctx, tracking.alloc, lowerBlock, out);
    const result = lowerStageElement(rewrittenEl, i, ctx);
    out.push(result.stage);
    ctx = result.ctx;
  });
  flushUpdateOps();
  if (everHadLet || tracking.used()) out.push({ $unset: LET_NAMESPACE });
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
export function generateImplicitPipeline(p: Pipeline, startCtx: GenerateCtx = EMPTY_CTX): unknown[] {
  const out: unknown[] = [];
  let ctx: GenerateCtx = startCtx;
  let everHadLet = false;
  const tracking = makeSlotTracking();

  p.stmts.forEach((stmt, i) => {
    if (stmt.type === "LetDecl") {
      const direct = detectLookupCall(stmt.value);
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
      // lookup stages can sit between coalesced $set groups.
      const result = lowerUpdateFilterWithLookups(stmt, ctx, tracking.alloc, lowerBlock);
      for (const s of result) out.push(s);
      return;
    }
    // Stage call statement (Expr that resolves to a stage shape).
    const rewrittenStmt = extractFromStageElement(stmt as Expr, ctx, tracking.alloc, lowerBlock, out);
    const result = lowerStageElement(rewrittenStmt as ArrayElement, i, ctx);
    out.push(result.stage);
    ctx = result.ctx;
  });

  if (everHadLet || tracking.used()) out.push({ $unset: LET_NAMESPACE });
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
      out[key] = generatePipelineWithCtx(entry.value, freshSubPipelineCtx(ctx));
    } else {
      out[key] = generateWithCtx(entry.value, ctx);
    }
  }
  return out;
}

/**
 * Sub-pipeline entry point. Same as `generatePipeline` but starts from a
 * caller-supplied ctx. Currently used only for sub-pipeline slots (where the
 * ctx is fresh-empty); the top-level entry stays parameter-less for API
 * stability.
 */
function generatePipelineWithCtx(ast: Expr, startCtx: GenerateCtx): unknown[] {
  if (ast.type !== "ArrayLiteral") {
    internalError("generatePipelineWithCtx expects an ArrayLiteral AST");
  }
  // Nested lookups: a sub-pipeline (`$lookup.pipeline`, `$unionWith.pipeline`,
  // `$facet.*`) that contains its own `$$$.<coll>.find/filter(...)` is not
  // supported in this release. The pre-materialisation walker would emit
  // stages *inside* the sub-pipeline, but coordinating the outer-pipeline's
  // let-bindings across the nesting is the bit we've deferred to v2 —
  // surface a targeted error here instead of producing wrong MQL.
  for (const el of ast.elements) {
    const inner = findFirstLookupInElement(el);
    if (inner !== null) {
      throw new CodegenError(
        `Nested lookup ('$$$.<coll>.find/filter' inside another sub-pipeline) is not yet supported in this release. ` +
          `Hoist the inner lookup to a sibling stage in the outer pipeline.`,
        inner,
      );
    }
  }
  const out: unknown[] = [];
  let updateBuffer: UpdateOp[] = [];
  let ctx: GenerateCtx = startCtx;
  let everHadLet = ctxHasLets(startCtx); // shouldn't happen for sub-pipelines, but safe

  const flushUpdateOps = () => {
    if (updateBuffer.length === 0) return;
    for (const stage of generateUpdateOpGroups(updateBuffer, ctx)) out.push(stage);
    updateBuffer = [];
  };

  ast.elements.forEach((el, i) => {
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
    const result = lowerStageElement(el, i, ctx);
    out.push(result.stage);
    ctx = result.ctx;
  });
  flushUpdateOps();
  if (everHadLet) out.push({ $unset: LET_NAMESPACE });
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
  const suggestion = closestStage(name);
  const suffix = suggestion ? ` Did you mean '${suggestion}'?` : "";
  return `Element ${index} of pipeline: '${name}' is not a known aggregation stage.${suffix}`;
}

function closestStage(name: string): string | null {
  return closestNameTo(name, Object.keys(STAGES));
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
const lowerBlock: SubPipelineLowerer = (block, ctx) => generateImplicitPipeline(block, ctx) as object[];

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
): object[] {
  const out: object[] = [];
  let buffer: UpdateOp[] = [];
  const ctx = startCtx;
  const flush = () => {
    if (buffer.length === 0) return;
    for (const stage of generateUpdateOpGroups(buffer, ctx)) out.push(stage);
    buffer = [];
  };
  for (const op of stmt.ops) {
    if (op.type === "AssignExpr") {
      const direct = detectLookupCall(op.value);
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
    buffer.push(op);
  }
  flush();
  return out;
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
  const direct = detectLookupCall(expr);
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
