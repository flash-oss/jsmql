// Collection-union translation: lowers `$$.push(args...)` statements into
// MongoDB `$unionWith` stages. `.push` mirrors `Array.prototype.push`, so the
// spread rule is JS-faithful (`...arr` spreads, scalar pushes one) and source
// order is preserved. Statement-only — no value position.
//
// Spread rules, inline-doc `$documents` batching, the no-`let`-slot predicate
// rejection, and the error catalog are owned by docs/specs/union-stage.md.

import type { Expr, CallArg, Pipeline, PipelineStmt, UpdateFilter, UpdateOp } from "./ast.ts";
import { CodegenError, EMPTY_CTX, freshSubPipelineCtx, generateWithCtx, type GenerateCtx } from "./codegen.ts";
import {
  detectLookupCall,
  extractLookupTarget,
  formatLookupReceiver,
  lowerLambdaPredicate,
  requireSameDbColl,
  validateLookupShape,
  type LookupCall,
  type SubPipelineLowerer,
} from "./lookup-translation.ts";

// Aliases for the few AST variants we touch directly.
type SpreadElement = Extract<CallArg, { type: "SpreadElement" }>;

// ── Detection ─────────────────────────────────────────────────────────────────

export type UnionPushCall = {
  /** Position of the `$$` receiver token. */
  pos: number;
  /** Position of the `.push(...)` call site (for argument-level errors). */
  callPos: number;
  /** Raw args; lowering re-walks them so each one's pos is preserved for errors. */
  args: CallArg[];
};

/**
 * Recognise a `$$.push(...)` MethodCall — the union entry point. Returns
 * `null` for anything else, including method calls on `CollectionRef` that
 * use a method other than `push`. Those other methods (`.filter`, `.map`,
 * `.slice`, … as well as unknown names) are handled by the bare-statement
 * stream-chain branch in `pipeline.ts` (`applyStreamMethods`), which lowers
 * the valid ones and emits an actionable registry error for the rest.
 */
export function detectUnionPush(expr: Expr): UnionPushCall | null {
  if (expr.type !== "MethodCall") return null;
  if (expr.method !== "push") return null;
  if (expr.object.type !== "CollectionRef") return null;
  return { pos: expr.object.pos, callPos: expr.pos, args: expr.args };
}

/**
 * Cheap recursive walk: does `node` (or any sub-tree thereof) contain a
 * `$$.push(...)` call? Used by mode-gates in `index.ts` to pre-reject the
 * statement-only union syntax in Filter / `jsmql.expr` / `jsmql.update`
 * modes with an actionable error.
 *
 * Defaults `ctx` to `EMPTY_CTX` for mode-gate call sites without a
 * meaningful context — the detection doesn't depend on ctx (push doesn't
 * have any bracket-bound forms today), but the parameter is kept so the
 * shape mirrors `containsLookupCall` and survives if we add binding-aware
 * shapes later.
 */
export function containsUnionPush(node: Expr | Pipeline | UpdateFilter, _ctx: GenerateCtx = EMPTY_CTX): boolean {
  return walkContainsPush(node);
}

function walkContainsPush(node: Expr | Pipeline | UpdateFilter | PipelineStmt | UpdateOp): boolean {
  if (node.type === "Pipeline") return node.stmts.some(walkContainsPush);
  if (node.type === "UpdateFilter") return node.ops.some(walkContainsPush);
  if (node.type === "AssignExpr") return walkContainsPush(node.value);
  if (node.type === "DeleteStmt") return false;
  if (node.type === "LetDecl") return walkContainsPush(node.value);
  if (node.type === "FuncDecl") return false;
  const expr = node;
  if (detectUnionPush(expr) !== null) return true;
  if (expr.type === "MethodCall") {
    if (walkContainsPush(expr.object)) return true;
    return walkArgsContainPush(expr.args);
  }
  if (expr.type === "CallExpression") {
    if (walkContainsPush(expr.callee)) return true;
    return walkArgsContainPush(expr.args);
  }
  if (expr.type === "OperatorCall" || expr.type === "MathCall" || expr.type === "ObjectCall") {
    return walkArgsContainPush(expr.args);
  }
  if (expr.type === "MemberAccess") return walkContainsPush(expr.object);
  if (expr.type === "IndexAccess") return walkContainsPush(expr.object) || walkContainsPush(expr.index);
  if (expr.type === "BinaryExpr") return walkContainsPush(expr.left) || walkContainsPush(expr.right);
  if (expr.type === "UnaryExpr") return walkContainsPush(expr.operand);
  if (expr.type === "TernaryExpr") {
    return walkContainsPush(expr.condition) || walkContainsPush(expr.consequent) || walkContainsPush(expr.alternate);
  }
  if (expr.type === "Lambda") {
    if (expr.body !== undefined) return walkContainsPush(expr.body);
    if (expr.block !== undefined) return walkContainsPush(expr.block);
    return false;
  }
  if (expr.type === "ArrayLiteral") {
    for (const el of expr.elements) {
      if (el.type === "SpreadElement") {
        if (walkContainsPush(el.argument)) return true;
      } else if (walkContainsPush(el)) {
        return true;
      }
    }
    return false;
  }
  if (expr.type === "ObjectLiteral") {
    for (const entry of expr.entries) {
      if (entry.type === "SpreadElement") {
        if (walkContainsPush(entry.argument)) return true;
      } else {
        if (entry.key.kind === "computed" && walkContainsPush(entry.key.expr)) return true;
        if (walkContainsPush(entry.value)) return true;
      }
    }
    return false;
  }
  if (expr.type === "TemplateLiteral") return expr.expressions.some(walkContainsPush);
  if (expr.type === "TypeofExpr") return walkContainsPush(expr.operand);
  if (expr.type === "NewDate") return expr.args.some(walkContainsPush);
  if (expr.type === "NewSet") return expr.arg ? walkContainsPush(expr.arg) : false;
  if (expr.type === "TypeCast") return walkContainsPush(expr.arg);
  if (expr.type === "ArrayFrom")
    return walkContainsPush(expr.input) || (expr.mapFn ? walkContainsPush(expr.mapFn) : false);
  if (expr.type === "NumberStatic") return walkContainsPush(expr.arg);
  if (expr.type === "DateUTC") return expr.args.some(walkContainsPush);
  return false;
}

function walkArgsContainPush(args: CallArg[]): boolean {
  for (const a of args) {
    if (a.type === "SpreadElement") {
      if (walkContainsPush(a.argument)) return true;
    } else if (walkContainsPush(a)) {
      return true;
    }
  }
  return false;
}

// ── Lowering ──────────────────────────────────────────────────────────────────

/**
 * Walk the `$$.push(arg1, arg2, …)` arg list and emit one or more
 * `$unionWith` stages. Consecutive inline-doc args (`{...}`) batch into a
 * single `$documents`-form `$unionWith`. Collection-sourced args
 * (`...$$$.coll[.filter(pred)]`, `$$$.coll.find(pred)`) each emit their own
 * stage. Source order is preserved across the whole list: e.g. one inline
 * doc followed by a spread collection followed by another inline doc
 * produces three stages in that order.
 *
 * Rejections (raised on the offending arg's `pos`):
 *
 *   - `...$$$.coll.find(pred)` — spreading a scalar (JS would TypeError);
 *      "drop the `...`".
 *   - `$$$.coll.filter(pred)` without `...` — pushing an array as one doc
 *      (silent footgun in JS too); "add the `...`".
 *   - Predicate references `$.x` — `$unionWith` has no `let`; move the
 *      local-doc filter to a `$match` before the push.
 *   - Non-document argument (scalar literal, arithmetic expression, etc.) —
 *      collections only hold documents.
 *   - Wrong method on `$$` (anything other than `.push`) — surfaced earlier
 *      by `validateUnionPushShape`.
 */
export function lowerUnionPush(call: UnionPushCall, outerCtx: GenerateCtx, lowerBlock: SubPipelineLowerer): object[] {
  if (call.args.length === 0) {
    throw new CodegenError(
      `$$.push() requires at least one argument — a document literal (\`{...}\`), ` +
        `a spread of \`$$$.<coll>[.filter(pred)]\`, or \`$$$.<coll>.find(pred)\`.`,
      call.callPos,
    );
  }
  const stages: object[] = [];
  let inlineBatch: unknown[] = [];

  const flushInline = () => {
    if (inlineBatch.length === 0) return;
    stages.push({ $unionWith: { pipeline: [{ $documents: inlineBatch }] } });
    inlineBatch = [];
  };

  for (const arg of call.args) {
    if (arg.type === "SpreadElement") {
      flushInline();
      stages.push(lowerSpreadArg(arg, outerCtx, lowerBlock));
      continue;
    }
    // Non-spread arg.
    if (arg.type === "ObjectLiteral") {
      // Inline doc — batch with adjacent inline docs.
      inlineBatch.push(generateWithCtx(arg, outerCtx));
      continue;
    }
    // `.find(pred)` without spread → append a single doc.
    const lookupCall = detectLookupCall(arg, outerCtx);
    if (lookupCall !== null) {
      if (lookupCall.method === "filter" || lookupCall.method === "aggregate") {
        const recv = formatLookupReceiver(lookupCall);
        const shape = lookupCall.method === "filter" ? "filter(pred)" : "aggregate(pipeline)";
        throw new CodegenError(
          `$$.push(...) was given \`${recv}.${shape}\` without \`...\` — that would push the whole array as a single document. ` +
            `Use \`$$.push(...${recv}.${shape})\` to append every matching document, ` +
            `or switch to \`.find(pred)\` if you meant the first match.`,
          arg.pos,
        );
      }
      // .find — single-doc append.
      validateLookupShape(arg);
      flushInline();
      stages.push(lowerFindAsUnion(lookupCall, outerCtx, lowerBlock));
      continue;
    }
    // Anything else is invalid.
    rejectNonDocumentArg(arg);
  }
  flushInline();
  return stages;
}

/**
 * Lower one `...inner` argument inside `$$.push(...)`. Accepted shapes for
 * `inner`: bare `$$$.coll` (no method, short-form `$unionWith`), or
 * `$$$.coll.filter(pred)` (pipeline-form `$unionWith`). Cross-DB variants
 * (`$$$$.<db>.<coll>[.filter(pred)]`) are REJECTED by `requireSameDbColl` — a
 * regular MongoDB doesn't accept the `{ db, coll }` `$unionWith` namespace. The
 * error redirects to a same-database `$$$.<coll>` reference. `.find(pred)` is
 * rejected here too (scalar; can't be spread).
 */
function lowerSpreadArg(arg: SpreadElement, outerCtx: GenerateCtx, lowerBlock: SubPipelineLowerer): object {
  const inner = arg.argument;
  // .find(pred) inside a spread — JS-faithful: spreading a scalar is a TypeError.
  if (inner.type === "MethodCall" && inner.method === "find" && inner.object.type !== "FieldRef") {
    const lookup = detectLookupCall(inner, outerCtx);
    if (lookup !== null) {
      const recv = formatLookupReceiver(lookup);
      throw new CodegenError(
        `$$.push(...arg) was given \`...${recv}.find(pred)\` — \`.find\` returns a single document, not an array, so spreading isn't meaningful (JS would \`TypeError\`). ` +
          `Drop the \`...\` to append the matched document, or switch to \`...${recv}.filter(pred)\` to append every match.`,
        inner.pos,
      );
    }
  }
  // `.filter(pred)` / `.aggregate(pipeline)` → pipeline-form `$unionWith`. Both
  // reach the same builder: a predicate is one `$match`, a pipeline is its stages.
  // `$unionWith` has no `let` slot, so a predicate or a stage that reads the LOCAL
  // document is rejected (`correlatedPushPredicateMessage`) — the union sub-pipeline
  // sees foreign fields only.
  const lookup = detectLookupCall(inner, outerCtx);
  if (lookup !== null && (lookup.method === "filter" || lookup.method === "aggregate")) {
    validateLookupShape(inner);
    return buildUnionWith(lookup, outerCtx, lowerBlock, /* limitOne */ false);
  }
  // Bare `$$$.coll` (no method): short-form `{ $unionWith: "<coll>" }`.
  const target = extractLookupTarget(inner, outerCtx);
  if (target !== null) {
    return { $unionWith: requireSameDbColl(target.db, target.collection, target.pos) };
  }
  // Catch-all: malformed shapes that still parsed (e.g. `...someVar`).
  // Surface the same actionable hint that `lowerUnionPush` uses for non-spread args.
  throw new CodegenError(
    `$$.push(...arg) — spread argument must be \`$$$.<coll>\`, \`$$$.<coll>.filter(pred)\`, or the cross-DB \`$$$$.<db>.<coll>[.filter(pred)]\` form. ` +
      `Spreading anything else isn't meaningful for collection union.`,
    inner.pos,
  );
}

/**
 * Lower a `.find(pred)` argument (no spread) into a `$unionWith` whose
 * sub-pipeline ends with `$limit: 1` — appending zero-or-one document, the
 * JS-faithful counterpart to the `$lookup + $first` lowering used when
 * `.find` is consumed as a value.
 */
function lowerFindAsUnion(call: LookupCall, outerCtx: GenerateCtx, lowerBlock: SubPipelineLowerer): object {
  return buildUnionWith(call, outerCtx, lowerBlock, /* limitOne */ true);
}

function buildUnionWith(
  call: LookupCall,
  outerCtx: GenerateCtx,
  lowerBlock: SubPipelineLowerer,
  limitOne: boolean,
): object {
  const pipeline = translateUnionPredicate(call, outerCtx, lowerBlock);
  if (limitOne) pipeline.push({ $limit: 1 });
  const from = requireSameDbColl(call.db, call.collection, call.pos);
  if (pipeline.length === 0) {
    // Vacuous predicate (e.g. `u => true`) collapses to short form.
    // Only reachable for `.filter`/`.aggregate` — `.find`
    // always emits at least the `$limit: 1` we just pushed.
    return { $unionWith: from };
  }
  if (typeof from === "string") {
    return { $unionWith: { coll: from, pipeline } };
  }
  return { $unionWith: { coll: from, pipeline } };
}

/**
 * Translate a `.filter(pred)` / `.find(pred)` lambda into the sub-pipeline
 * body for `$unionWith.pipeline`. Differs from the `$lookup`-side
 * `translatePredicate` in two ways:
 *
 *   1. `$unionWith` has no `let` slot, so any `$.x` reference (= a let-var
 *      auto-extracted from the predicate body) is a compile-time error.
 *
 *   2. Expression-body predicates that don't reference the local doc are
 *      routed through the same `translateMatchBody` engine `$match` uses,
 *      so the inner `$match` emits index-friendly query syntax
 *      (`{ field: value }`) instead of always wrapping in `{ $expr: … }`.
 *      The query planner can use foreign-collection indexes on the
 *      translated half. Untranslatable residuals still ride in `$expr`.
 */
function translateUnionPredicate(call: LookupCall, outerCtx: GenerateCtx, lowerBlock: SubPipelineLowerer): object[] {
  // The 3rd 'collection' param is a `$lookup.pipeline`-only handle: its count is
  // materialised by a `$setWindowFields` the lookup assembler stamps, and a
  // `$unionWith` sub-pipeline has no such step. Reject it here rather than let the
  // param leak out as an "unknown identifier".
  if (call.lambda.params.length === 3) {
    const collParam = call.lambda.params[2];
    throw new CodegenError(
      `'${collParam}' (the 3rd, sub-stream count parameter) isn't available inside a \`$$.push(...)\` union — ` +
        `\`$unionWith\` runs its sub-pipeline standalone, with nothing to count against. Count it explicitly with ` +
        `\`$setWindowFields({ output: { n: { $count: {} } } })\` inside the pipeline and read \`$.n\`, or assign to a ` +
        `field instead (\`$.<field> = ${formatLookupReceiver(call)}.aggregate((o, _i, ${collParam}) => { … })\`).`,
      call.lambda.pos,
    );
  }
  // Shared expr-or-block predicate lowering (see `lowerLambdaPredicate`). The
  // foreign-doc paths are rewritten to bare `FieldRef`s, then expression bodies
  // run through the same translator `$match` uses; the sub-pipeline gets a fresh
  // ctx (outer lets don't cross the boundary). `$unionWith` has no `let` slot, so
  // a predicate that references the local doc (`$.<field>`) is rejected.
  return lowerLambdaPredicate(call.lambda, outerCtx, lowerBlock, {
    freshCtx: freshSubPipelineCtx,
    onLocalRef: () => {
      throw new CodegenError(correlatedPushPredicateMessage(call), call.lambda.pos);
    },
    missingBody: () => {
      throw new CodegenError(
        `.${call.method}(predicate) lambda is missing a body — internal parser bug; please report.`,
        call.lambda.pos,
      );
    },
  });
}

function correlatedPushPredicateMessage(call: LookupCall): string {
  const recv = formatLookupReceiver(call);
  const arg = call.method === "aggregate" ? "pipeline" : "pred";
  const what = call.method === "aggregate" ? "sub-pipeline reads" : "predicate references";
  return (
    `$$.push(...${recv}.${call.method}(${arg})) — ${what} the local document (\`$.<field>\`), ` +
    `but MongoDB's \`$unionWith\` has no \`let\` slot. The union sub-pipeline can only reference foreign-document fields. ` +
    `Move the local-doc filter to a \`$match(...)\` stage before \`$$.push(...)\`, or assign the result to a field ` +
    `instead (\`$.<field> = ${recv}.${call.method}(${arg})\`), where a \`$lookup.let\` can carry the correlation.`
  );
}

function rejectNonDocumentArg(arg: Expr): never {
  // Best-effort hint: name the offending shape if we recognise it.
  let hint = "";
  if (arg.type === "NumberLiteral" || arg.type === "StringLiteral" || arg.type === "BooleanLiteral") {
    hint = ` Got a ${arg.type.replace(/Literal$/, "").toLowerCase()} literal — collections only hold documents.`;
  } else if (arg.type === "NullLiteral") {
    hint = " Got `null` — collections only hold documents.";
  } else if (arg.type === "FieldRef" || arg.type === "ParamRef") {
    hint =
      " To append a runtime-supplied document, accept it as a `jsmql.compile` parameter binding and wrap as `$$.push($.<doc>)`. " +
      "Note: $$.push doesn't accept bare field paths — wrap inside an inline `{ ... }` if you want to project specific fields.";
  }
  throw new CodegenError(
    `$$.push(...) argument must be a document literal (\`{ ... }\`), a \`$$$.<coll>.find(pred)\` scalar, ` +
      `or a spread of \`$$$.<coll>[.filter(pred)]\`.${hint}`,
    (arg as { pos?: number }).pos ?? 0,
  );
}
