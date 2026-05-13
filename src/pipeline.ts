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

import type { Expr, ArrayElement, Mutation, Pipeline, LetDecl } from "./ast.ts";
import {
  generateWithCtx,
  generateMutationGroups,
  generateMutationProgram,
  CodegenError,
  EMPTY_CTX,
  extendCtxLets,
  clearCtxLets,
  ctxHasLets,
  freshSubPipelineCtx,
  type GenerateCtx,
} from "./codegen.ts";
import { closestNameTo } from "./levenshtein.ts";
import { lookupStage, STAGES } from "./stages.ts";
import { translateMatchBody } from "./match-translation.ts";

type StageShape = { name: string; body: Expr };

/** Stages that replace the document and so drop all in-scope `let` bindings. */
const RESHAPE_CLEARING_STAGES = new Set([
  "$group",
  "$bucket",
  "$bucketAuto",
  "$replaceRoot",
  "$replaceWith",
]);

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
  // Mutations (`$.a = 1`, `delete $.x`) and `let` bindings are pipeline
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
 * Consecutive mutation elements (`$.a = 1`, `delete $.x`) coalesce through
 * the same algorithm `jsmql()` uses at the top level — see
 * `generateMutationGroups` in codegen.ts. Non-mutation stages flush the
 * current mutation buffer and emit its compiled $set/$unset stage(s) inline.
 *
 * `let` bindings extend a pipeline-scoped GenerateCtx that downstream stages
 * inherit; reshape-clearing stages drop the scope; a trailing `$unset` is
 * appended once if any let was declared.
 */
export function generatePipeline(ast: Expr): unknown[] {
  if (ast.type !== "ArrayLiteral") {
    throw new CodegenError("generatePipeline expects an ArrayLiteral AST");
  }
  const out: unknown[] = [];
  let mutationBuffer: Mutation[] = [];
  let ctx: GenerateCtx = EMPTY_CTX;
  let everHadLet = false;

  const flushMutations = () => {
    if (mutationBuffer.length === 0) return;
    for (const stage of generateMutationGroups(mutationBuffer, ctx)) out.push(stage);
    mutationBuffer = [];
  };

  ast.elements.forEach((el, i) => {
    if (el.type === "AssignExpr" || el.type === "DeleteStmt") {
      mutationBuffer.push(el);
      return;
    }
    if (el.type === "LetDecl") {
      flushMutations();
      const stage = lowerLetDecl(el, ctx);
      out.push(stage.set);
      ctx = stage.ctx;
      everHadLet = true;
      return;
    }
    flushMutations();
    const result = lowerStageElement(el, i, ctx);
    out.push(result.stage);
    ctx = result.ctx;
  });
  flushMutations();
  if (everHadLet) out.push({ $unset: LET_NAMESPACE });
  return out;
}

/**
 * Compile a `Pipeline` (a sequence of `;`-separated top-level statements) to
 * an MQL stage array. Each statement is lowered in isolation: a mutation
 * chain (`,`-grouped, possibly RAW-split) goes through `generateMutationProgram`
 * and contributes one or more `$set`/`$unset` stages; an expression must be a
 * stage call/object and contributes exactly one stage.
 *
 * Adjacent mutation statements never coalesce — `;` is a hard boundary, in
 * contrast to `generatePipeline` (the `[…]` form), where consecutive
 * mutation elements coalesce through `generateMutationGroups`. This is the
 * core difference between the two pipeline forms.
 *
 * `let` declarations contribute one `$set` stage each and extend the let
 * scope visible to subsequent statements.
 */
export function generateImplicitPipeline(p: Pipeline): unknown[] {
  const out: unknown[] = [];
  let ctx: GenerateCtx = EMPTY_CTX;
  let everHadLet = false;

  p.stmts.forEach((stmt, i) => {
    if (stmt.type === "LetDecl") {
      const stage = lowerLetDecl(stmt, ctx);
      out.push(stage.set);
      ctx = stage.ctx;
      everHadLet = true;
      return;
    }
    if (stmt.type === "MutationProgram") {
      const result = generateMutationProgram(stmt, ctx);
      if (Array.isArray(result)) out.push(...result);
      else out.push(result);
      return;
    }
    const result = lowerStageElement(stmt, i, ctx);
    out.push(result.stage);
    ctx = result.ctx;
  });

  if (everHadLet) out.push({ $unset: LET_NAMESPACE });
  return out;
}

type LetLowering = { set: Record<string, unknown>; ctx: GenerateCtx };

function lowerLetDecl(decl: LetDecl, ctx: GenerateCtx): LetLowering {
  if (ctx.pipelineLets?.has(decl.name)) {
    throw new CodegenError(
      `\`let ${decl.name}\` is already declared earlier in this pipeline. ` +
        `Re-declaration in the same scope is not allowed — pick a different name, ` +
        `or rebind after a reshape stage (\`$group\`, \`$replaceRoot\`, …).`,
    );
  }
  const fieldPath = `${LET_NAMESPACE}.${decl.name}`;
  const value = generateWithCtx(decl.value, ctx);
  return {
    set: { $set: { [fieldPath]: value } },
    ctx: extendCtxLets(ctx, decl.name, fieldPath),
  };
}

type StageLowering = { stage: Record<string, unknown>; ctx: GenerateCtx };

function lowerStageElement(el: ArrayElement, index: number, ctx: GenerateCtx): StageLowering {
  const stage = asStageShape(el);
  if (!stage) throw new CodegenError(formatNotAStageError(el, index));
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
    const t = translateMatchBody(body);
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
      throw new CodegenError(`Spread entries are not allowed in ${stageName} body`);
    }
    if (entry.key.kind !== "static") {
      throw new CodegenError(`Computed keys are not allowed in ${stageName} body`);
    }
    const key = entry.key.name;
    const isPipelineSlot = allValuesArePipelines || pipelineSlot.has(key);
    if (isPipelineSlot && isPipelineAst(entry.value)) {
      // Sub-pipelines run in a fresh scope. Outer lets do not cross.
      out[key] = generatePipelineWithCtx(entry.value, freshSubPipelineCtx());
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
    throw new CodegenError("generatePipelineWithCtx expects an ArrayLiteral AST");
  }
  const out: unknown[] = [];
  let mutationBuffer: Mutation[] = [];
  let ctx: GenerateCtx = startCtx;
  let everHadLet = ctxHasLets(startCtx); // shouldn't happen for sub-pipelines, but safe

  const flushMutations = () => {
    if (mutationBuffer.length === 0) return;
    for (const stage of generateMutationGroups(mutationBuffer, ctx)) out.push(stage);
    mutationBuffer = [];
  };

  ast.elements.forEach((el, i) => {
    if (el.type === "AssignExpr" || el.type === "DeleteStmt") {
      mutationBuffer.push(el);
      return;
    }
    if (el.type === "LetDecl") {
      flushMutations();
      const stage = lowerLetDecl(el, ctx);
      out.push(stage.set);
      ctx = stage.ctx;
      everHadLet = true;
      return;
    }
    flushMutations();
    const result = lowerStageElement(el, i, ctx);
    out.push(result.stage);
    ctx = result.ctx;
  });
  flushMutations();
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
  }
  return (
    `Element ${index} of pipeline is not a recognised stage. ` +
    `Expected \`{ $stage: ... }\` or \`$stage(...)\` where $stage is one of: ` +
    `${formatStageList()}.`
  );
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
