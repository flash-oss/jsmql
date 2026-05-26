// Collection-union translation: lowers `$$.push(args...)` statements into
// MongoDB `$unionWith` stages.
//
// `$$` is the current-collection context-ref. `.push(...)` is the JS array
// mutation that appends items to the end of an array — exactly the
// semantic of `$unionWith` (append documents from another collection /
// pipeline / `$documents` block to the current stream). Symmetry with
// `Array.prototype.push` means the spread (`...`) rule is JS-faithful:
//
//   - `.push(...arr)` spreads an array (`.filter(pred)` or bare collection).
//   - `.push(scalar)` pushes one value (`.find(pred)` or `{ inline doc }`).
//
// `.find(...)` returns a single doc → no spread. `.filter(...)` returns an
// array → must be spread. Inline objects are scalars → no spread. Each
// shape lowers to a distinct `$unionWith` stage body; consecutive inline-doc
// arguments batch into one `$documents` sub-pipeline (fewer stages, identical
// behaviour). Source-order is preserved across the whole arg list — a
// document pushed before a collection appears first in the union, and vice
// versa.
//
// `$unionWith` has no `let` slot (unlike `$lookup`), so a predicate that
// references the local document (`$.x`) is a compile-time error — moving the
// local filter to a `$match` stage before the push is the documented fix.
//
// Statement-only: `$$.push(...)` emits one or more stages and produces no
// value. Using it on a RHS / as a value is rejected — `CollectionRef`
// codegen surfaces the bare-reference error for those misuses.
//
// See `docs/specs/union-stage.md` for the full design and the error catalog.

import type { Expr, CallArg, Pipeline, PipelineStmt, UpdateFilter, UpdateOp } from "./ast.ts";
import { CodegenError, EMPTY_CTX, freshSubPipelineCtx, generateWithCtx, type GenerateCtx } from "./codegen.ts";
import {
  detectLookupCall,
  extractLetsFromExpr,
  extractLetsFromPipeline,
  extractLookupTarget,
  validateLookupShape,
  type LookupCall,
  type SubPipelineLowerer,
} from "./lookup-translation.ts";
import { translateMatchBody } from "./match-translation.ts";

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
 * use a method other than `push` (those surface a "wrong method" error
 * elsewhere — see `validateUnionPushShape`).
 */
export function detectUnionPush(expr: Expr): UnionPushCall | null {
  if (expr.type !== "MethodCall") return null;
  if (expr.method !== "push") return null;
  if (expr.object.type !== "CollectionRef") return null;
  return { pos: expr.object.pos, callPos: expr.pos, args: expr.args };
}

/**
 * If `expr` looks like a `$$.<method>(...)` call but is malformed (wrong
 * method, wrong receiver shape after `$$`, etc.), throw the targeted error.
 * Mirrors `validateLookupShape` from lookup-translation.
 */
export function validateUnionPushShape(expr: Expr): void {
  if (expr.type !== "MethodCall") return;
  if (expr.object.type !== "CollectionRef") return;
  if (expr.method === "push") return;
  if (expr.method === "filter") {
    // `$$.filter(<predicate>)` is only valid as a value inside the facet
    // pattern `$ = { key: $$.filter(p), ... }` or as the RHS of `$$ = …`.
    // At a statement position, the user almost certainly meant
    // `$match(<predicate>)` (the leaner form for narrowing the current stream).
    throw new CodegenError(
      `'$$.filter(<predicate>)' is only valid as the RHS of \`$$ = $$.filter(<predicate>)\` or as a value inside \`$ = { key1: $$.filter(p1), key2: $$.filter(p2), ... }\` (the \`$facet\` pattern). For filtering the current stream as a stage, use \`$match(<predicate>)\` instead.`,
      expr.pos,
    );
  }
  // Any other method on `$$` — direct CollectionRef receiver.
  throw new CodegenError(
    `'$$' (current collection) only supports .push(...) and .filter(...) — .${expr.method}() is not defined. ` +
      `Use \`$$.push({...})\` to append a single document, ` +
      `\`$$.push(...$$$.<coll>)\` or \`$$.push(...$$$.<coll>.filter(pred))\` to union with another collection, ` +
      `\`$$.push($$$.<coll>.find(pred))\` to append a single matching document, ` +
      `or \`$ = { key: $$.filter(p), ... }\` to build a \`$facet\` stage.`,
    expr.pos,
  );
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
      if (lookupCall.method === "filter") {
        const recv = formatReceiver(lookupCall);
        throw new CodegenError(
          `$$.push(...) was given \`${recv}.filter(pred)\` without \`...\` — that would push the whole array as a single document. ` +
            `Use \`$$.push(...${recv}.filter(pred))\` to append every matching document, ` +
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
 * (`$$$$.<db>.<coll>[.filter(pred)]`) lower to the Atlas Data Federation
 * `from: { db, coll }` shape. `.find(pred)` is rejected here (scalar; can't
 * be spread).
 */
function lowerSpreadArg(arg: SpreadElement, outerCtx: GenerateCtx, lowerBlock: SubPipelineLowerer): object {
  const inner = arg.argument;
  // .find(pred) inside a spread — JS-faithful: spreading a scalar is a TypeError.
  if (inner.type === "MethodCall" && inner.method === "find" && inner.object.type !== "FieldRef") {
    const lookup = detectLookupCall(inner, outerCtx);
    if (lookup !== null) {
      const recv = formatReceiver(lookup);
      throw new CodegenError(
        `$$.push(...arg) was given \`...${recv}.find(pred)\` — \`.find\` returns a single document, not an array, so spreading isn't meaningful (JS would \`TypeError\`). ` +
          `Drop the \`...\` to append the matched document, or switch to \`...${recv}.filter(pred)\` to append every match.`,
        inner.pos,
      );
    }
  }
  // `.filter(pred)` → pipeline-form `$unionWith`.
  const lookup = detectLookupCall(inner, outerCtx);
  if (lookup !== null && lookup.method === "filter") {
    validateLookupShape(inner);
    return buildUnionWith(lookup, outerCtx, lowerBlock, /* limitOne */ false);
  }
  // Bare `$$$.coll` (no method): short-form `{ $unionWith: "<coll>" }`.
  const target = extractLookupTarget(inner, outerCtx);
  if (target !== null) {
    if (target.db !== undefined) {
      return { $unionWith: { coll: { db: target.db, coll: target.collection } } };
    }
    return { $unionWith: target.collection };
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
  const from: string | { db: string; coll: string } =
    call.db !== undefined ? { db: call.db, coll: call.collection } : call.collection;
  if (pipeline.length === 0) {
    // Vacuous predicate (e.g. a block body with no stages) collapses to short
    // form. Only reachable for `.filter` with an empty block body — `.find`
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
  const { lambda } = call;
  const foreignParam = lambda.params[0];

  // ── Expression body ────────────────────────────────────────────────
  if (lambda.body !== undefined) {
    const { rewritten, letVars } = extractLetsFromExpr(lambda.body, foreignParam);
    if (Object.keys(letVars).length > 0) {
      throw new CodegenError(correlatedPushPredicateMessage(call), call.lambda.pos);
    }
    // Run the rewritten body (foreign-paths now bare `FieldRef`s) through the
    // same translator `$match` uses at the top level. The sub-pipeline runs in
    // a fresh ctx (outer lets don't cross sub-pipeline boundaries) and inherits
    // the function-form bindings so compile-time param values translate as
    // literals.
    const subCtx = freshSubPipelineCtx(outerCtx);
    const t = translateMatchBody(rewritten, { bindings: subCtx.bindings });
    const queryEmpty = Object.keys(t.query).length === 0;
    if (queryEmpty && t.residual === null) {
      // Vacuous predicate (e.g. literal `true`). Skip the $match entirely.
      return [];
    }
    if (t.residual === null) {
      return [{ $match: t.query }];
    }
    const exprBody = generateWithCtx(t.residual, subCtx);
    if (queryEmpty) return [{ $match: { $expr: exprBody } }];
    return [{ $match: { ...t.query, $expr: exprBody } }];
  }

  // ── Block body ─────────────────────────────────────────────────────
  if (lambda.block !== undefined) {
    const { rewritten, letVars } = extractLetsFromPipeline(lambda.block, foreignParam);
    if (Object.keys(letVars).length > 0) {
      throw new CodegenError(correlatedPushPredicateMessage(call), call.lambda.pos);
    }
    const subCtx = freshSubPipelineCtx(outerCtx);
    return lowerBlock(rewritten, subCtx);
  }

  throw new CodegenError(
    `.${call.method}(predicate) lambda is missing a body — internal parser bug; please report.`,
    lambda.pos,
  );
}

function correlatedPushPredicateMessage(call: LookupCall): string {
  const recv = formatReceiver(call);
  return (
    `$$.push(...${recv}.${call.method}(pred)) — predicate references the local document (\`$.<field>\`), ` +
    `but MongoDB's \`$unionWith\` has no \`let\` slot. The union sub-pipeline can only reference foreign-document fields. ` +
    `Move the local-doc filter to a \`$match(...)\` stage before \`$$.push(...)\`.`
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

function formatReceiver(call: LookupCall): string {
  return call.db !== undefined ? `$$$$.${call.db}.${call.collection}` : `$$$.${call.collection}`;
}
