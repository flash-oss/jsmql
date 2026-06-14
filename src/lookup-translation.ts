// Cross-collection lookup translation: lowers `$$$.<coll>.find/filter(pred)`
// and its chained-read forms into MongoDB `$lookup` (+ follow-up) stages.
// Detect → translate predicate → materialise into a slot. Also the hub for
// shared predicate lowering reused by union / facet / out / replace-stream
// (`extractLetsFromExpr`, `lowerLambdaPredicate`, `matchStagesFromTranslation`).
//
// `containsLookupCall` is the cheap walk `index.ts` uses to pre-reject lookup
// syntax outside Pipeline mode with an actionable error.
//
// Design, predicate-translation algorithm, slot conventions, and error catalog
// are owned by docs/specs/lookup-stage.md.

import type {
  Expr,
  Pipeline,
  PipelineStmt,
  UpdateFilter,
  UpdateOp,
  CallArg,
  ArrayElement,
  ObjectEntry,
  KeyValueEntry,
  LetDecl,
  FuncDecl,
} from "./ast.ts";
import {
  CodegenError,
  EMPTY_CTX,
  generateWithCtx,
  freshSubPipelineCtx,
  safeVarName,
  type GenerateCtx,
} from "./codegen.ts";
import { translateMatchBody, mergeTranslatedQuery, type MatchTranslation } from "./match-translation.ts";
import { didYouMean } from "./levenshtein.ts";
// Cycle-safe import: stream-methods.ts imports SlotAllocator / SubPipelineLowerer
// from this module, and lookupStreamMethod is a runtime function (not consumed
// at this module's top level), so ESM's late-binding handles it cleanly.
import { lookupStreamMethod } from "./stream-methods.ts";

// AST shapes are exported only as the discriminated union `Expr`. The
// specific variants we touch directly need local aliases extracted from
// that union — saves us from re-declaring the shapes and keeps the
// types in lock-step with `src/ast.ts`.
type Lambda = Extract<Expr, { type: "Lambda" }>;
type FieldRef = Extract<Expr, { type: "FieldRef" }>;
type ParamRef = Extract<Expr, { type: "ParamRef" }>;
type MethodCall = Extract<Expr, { type: "MethodCall" }>;

/**
 * Caller-supplied sub-pipeline lowerer. lookup-translation lives "below"
 * pipeline.ts in the dependency graph (pipeline.ts imports from here),
 * so a direct import back into pipeline.ts would be circular. The
 * top-level orchestrator in pipeline.ts wires this through when it
 * invokes `lowerLookup` / `extractLookupCalls`.
 */
export type SubPipelineLowerer = (block: Pipeline, ctx: GenerateCtx) => object[];

/**
 * State carried into a lookup translation when it's *nested* inside another
 * lookup's predicate. Empty at the top level; populated as we recurse.
 *
 * - `foreignParams` — every enclosing lookup's lambda param name, outermost
 *   first. References to these (e.g. `o.x`, `o.user._id`) need to lower as
 *   paths on the local doc of the enclosing pipeline, so we pre-rewrite them
 *   to `FieldRef(<path>)` before the inner's let-extractor runs. The
 *   extractor then auto-lets them into the inner's `$lookup.let` clause
 *   exactly like ordinary `$.x` refs.
 * - `inScopeLetNames` — let-var names already visible via the enclosing
 *   `$lookup.let` clauses. MQL `$$<name>` is lexically scoped through nested
 *   `$lookup.pipeline` boundaries, so the inner shouldn't re-let them. We
 *   thread the names into the inner's `lambdaParams` so codegen emits
 *   `$$<name>` instead of throwing `UnknownIdentifier`.
 */
export type EnclosingLookupContext = { foreignParams: ReadonlyArray<string>; inScopeLetNames: ReadonlySet<string> };

export const EMPTY_ENCLOSING: EnclosingLookupContext = { foreignParams: [], inScopeLetNames: new Set() };

/**
 * Pre-rewrite `<enclosingForeignParam>.<x>.<y>...` chains to `FieldRef("<x>.<y>...")`.
 *
 * In the current implementation, this helper is defensive: the outer's
 * `extractLetsFromExpr` walk already descends through nested lookup-call
 * lambda bodies (via `mapChildren`'s MethodCall case) using the outer's
 * foreignParam, so most enclosing-foreign-param refs are already rewritten
 * by the time the nested lookup's `translatePredicate` runs. The
 * defensive re-run handles only the cases where a deeper level needs to
 * rewrite refs that this level couldn't see — e.g. a fresh
 * `buildPipelineFormPredicate` invocation that wasn't preceded by an
 * outer-level extraction.
 */
function rewriteEnclosingForeignParams(expr: Expr, params: ReadonlyArray<string>): Expr {
  if (params.length === 0) return expr;
  const paramSet = new Set(params);
  function walk(node: Expr): Expr {
    const path = matchEnclosingParamPath(node, paramSet);
    if (path !== null) {
      if (path.segments.length === 0) {
        // Defense-in-depth: this branch is rarely reached because the outer
        // let-extractor's classifyPath catches bare enclosing-foreign refs
        // first (using its own foreignParam matching). Same restriction
        // family as the §B "Bare lambda parameter 'o' in a $lookup
        // predicate" rejection — no $$ROOT lowering for the foreign doc.
        throw new CodegenError(
          `Bare lambda parameter '${path.param}' from an enclosing lookup is not yet supported — use \`${path.param}.<field>\` to reference a field of the enclosing foreign document.`,
          node.pos,
        );
      }
      return { type: "FieldRef", path: path.segments.join("."), pos: node.pos };
    }
    return walkChildren(node);
  }
  function walkChildren(node: Expr): Expr {
    switch (node.type) {
      case "BinaryExpr":
        return { ...node, left: walk(node.left), right: walk(node.right) };
      case "UnaryExpr":
        return { ...node, operand: walk(node.operand) };
      case "TernaryExpr":
        return {
          ...node,
          condition: walk(node.condition),
          consequent: walk(node.consequent),
          alternate: walk(node.alternate),
        };
      case "MemberAccess":
        return { ...node, object: walk(node.object) };
      case "IndexAccess":
        return { ...node, object: walk(node.object), index: walk(node.index) };
      case "MethodCall":
        return { ...node, object: walk(node.object), args: node.args.map(walkArg) };
      case "CallExpression":
        return { ...node, callee: walk(node.callee), args: node.args.map(walkArg) };
      case "OperatorCall":
        return { ...node, args: node.args.map(walkArg) };
      case "Lambda":
        if (node.body !== undefined) return { ...node, body: walk(node.body) };
        if (node.exprBlock !== undefined) {
          return {
            ...node,
            exprBlock: {
              type: "ExprBlock",
              decls: node.exprBlock.decls.map((d) => ({ ...d, value: walk(d.value) })),
              ret: walk(node.exprBlock.ret),
              pos: node.exprBlock.pos,
            },
          };
        }
        return node;
      case "ArrayLiteral":
        return {
          ...node,
          elements: node.elements.map((el): ArrayElement => {
            if (el.type === "SpreadElement") return { ...el, argument: walk(el.argument) };
            if (el.type === "AssignExpr") return { ...el, target: walk(el.target), value: walk(el.value) };
            if (el.type === "DeleteStmt") return { ...el, target: walk(el.target) };
            if (el.type === "LetDecl") return { ...el, value: walk(el.value) };
            // A reusable function declared in this scope may close over the
            // enclosing foreign param in its body — rewrite it like a LetDecl's
            // value so the body's `o.<field>` refs hoist out (mirrors transformStmt).
            if (el.type === "FuncDecl") return { ...el, lambda: walk(el.lambda) as Lambda };
            return walk(el as Expr);
          }),
        };
      case "ObjectLiteral":
        return {
          ...node,
          entries: node.entries.map((entry): ObjectEntry => {
            if (entry.type === "SpreadElement") return { ...entry, argument: walk(entry.argument) };
            return {
              ...entry,
              key: entry.key.kind === "computed" ? { kind: "computed", expr: walk(entry.key.expr) } : entry.key,
              value: walk(entry.value),
            };
          }),
        };
      case "TemplateLiteral":
        return { ...node, expressions: node.expressions.map(walk) };
      case "TypeofExpr":
        return { ...node, operand: walk(node.operand) };
      case "NewDate":
        return { ...node, args: node.args.map(walk) };
      case "NewSet":
        return { ...node, arg: node.arg !== null ? walk(node.arg) : null };
      case "TypeCast":
        return { ...node, arg: walk(node.arg) };
      case "MathCall":
        return { ...node, args: node.args.map(walkArg) };
      case "ObjectCall":
        return { ...node, args: node.args.map(walkArg) };
      case "ArrayFrom":
        return { ...node, input: walk(node.input), mapFn: node.mapFn !== null ? walk(node.mapFn) : null };
      case "NumberStatic":
        return { ...node, arg: walk(node.arg) };
      case "DateUTC":
        return { ...node, args: node.args.map(walk) };
      default:
        return node;
    }
  }
  function walkArg(arg: CallArg): CallArg {
    if (arg.type === "SpreadElement") return { ...arg, argument: walk(arg.argument) };
    return walk(arg);
  }
  return walk(expr);
}

function matchEnclosingParamPath(
  node: Expr,
  params: ReadonlySet<string>,
): { param: string; segments: string[] } | null {
  if (node.type === "ParamRef" && params.has(node.name)) {
    return { param: node.name, segments: [] };
  }
  if (node.type === "MemberAccess") {
    const inner = matchEnclosingParamPath(node.object, params);
    if (inner !== null) return { param: inner.param, segments: [...inner.segments, node.member] };
  }
  if (node.type === "IndexAccess" && node.index.type === "StringLiteral") {
    const inner = matchEnclosingParamPath(node.object, params);
    if (inner !== null) return { param: inner.param, segments: [...inner.segments, node.index.value] };
  }
  return null;
}

// ── Detection ─────────────────────────────────────────────────────────────────

export type LookupCall = {
  /** Position of the context-ref prefix `$$$` / `$$$$` (for errors). */
  pos: number;
  /** Position of the method call (for errors specific to the call shape). */
  callPos: number;
  /**
   * Database name extracted from `$$$$.<db>.<coll>` (any bracket combination).
   * Undefined for the same-database form `$$$.<coll>` — in which case
   * `$lookup.from` is emitted as a bare collection-name string. When set,
   * `$lookup.from` is emitted as `{ db, coll }` — the Atlas Data Federation
   * shape for cross-database joins. See docs/specs/lookup-stage.md.
   */
  db?: string;
  /** Collection name extracted from `.<name>` or `["<name>"]`. */
  collection: string;
  /** `.find` returns scalar-or-null; `.filter` returns an array. */
  method: "find" | "filter";
  /** The predicate lambda. May be expression-body OR block-body. */
  lambda: Lambda;
};

/** One step of static (dot, string-bracket, or bound-param-bracket) member access on a receiver. */
type StaticAccess = { name: string; object: Expr };

/**
 * Resolve one step of a lookup-receiver chain to a compile-time string name.
 * Three index kinds resolve to a static name:
 *
 *   - `MemberAccess`        (`$$$.coll`)            → the dotted member name.
 *   - `IndexAccess` whose index is a `StringLiteral` (`$$$["coll"]`) → the literal.
 *   - `IndexAccess` whose index is a `ParamRef` whose name is bound in
 *     `ctx.bindings` to a string value (`jsmql.compile(({ coll }, $) => $$$[coll]…)`)
 *     → the bound string.
 *
 * The third form is the new compile-time-binding case: `jsmql.compile`
 * parameter bindings are compile-time constants validated as JSON-shaped
 * values at call time, so resolving them here matches the rule MongoDB
 * itself enforces on `$lookup.from` (a plan-time constant string).
 *
 * Non-string bound values (a number, an array, etc.) throw a precise
 * "parameter binding must be a string" error — the dynamic-name footgun
 * surfaces at compile time instead of producing wrong MQL.
 *
 * An unbound `ParamRef` (the name isn't in `ctx.bindings` at all) returns
 * null; the downstream codegen then surfaces either the bare-reference
 * error (when the chain is reachable as a lookup) or `UnknownIdentifierError`
 * (when the ParamRef leaks into a non-lookup expression position).
 */
function staticAccess(node: Expr, ctx: GenerateCtx): StaticAccess | null {
  if (node.type === "MemberAccess") return { name: node.member, object: node.object };
  if (node.type === "IndexAccess") {
    if (node.index.type === "StringLiteral") {
      return { name: node.index.value, object: node.object };
    }
    if (node.index.type === "ParamRef") {
      const bindings = ctx.bindings;
      if (bindings === undefined || !bindings.has(node.index.name)) return null;
      const bound = bindings.get(node.index.name);
      if (typeof bound !== "string") {
        throw new CodegenError(
          `'$$$[${node.index.name}]' / '$$$$[${node.index.name}]' parameter binding must be a string ` +
            `(got ${typeof bound}); collection / database names are compile-time constants in MongoDB's $lookup.from.`,
          node.index.pos,
        );
      }
      return { name: bound, object: node.object };
    }
  }
  return null;
}

/** Extracted target of a lookup-shaped receiver: `$$$.<coll>` or `$$$$.<db>.<coll>`. */
export type LookupTarget = { pos: number; db?: string; collection: string };

/**
 * Walk back through one or two levels of static (dot or string-bracket) access
 * to recognise the four lookup-receiver shapes:
 *
 * | Source                  | AST shape (outermost first)                                 |
 * | ----------------------- | ----------------------------------------------------------- |
 * | `$$$.<coll>`            | one-level access onto `DatabaseRef`                          |
 * | `$$$["<coll>"]`         | one-level bracket-access onto `DatabaseRef`                  |
 * | `$$$$.<db>.<coll>`      | two-level access; inner onto `ClusterRef`                    |
 * | `$$$$["db"]["coll"]`    | two-level bracket access; inner onto `ClusterRef`            |
 * | `$$$$.db["coll"]`       | two-level mixed (bracket outer, dot inner); onto `ClusterRef` |
 * | `$$$$["db"].coll`       | two-level mixed (dot outer, bracket inner); onto `ClusterRef` |
 *
 * Non-static indices (`$$$$[someVar].coll`) break the classification — we
 * can't materialise a runtime-computed db/coll name into `$lookup.from`
 * (the field is a compile-time string in MQL). Returns null for those
 * shapes; the bare-reference codegen path then surfaces the standard
 * actionable error.
 */
export function extractLookupTarget(receiver: Expr, ctx: GenerateCtx): LookupTarget | null {
  const outer = staticAccess(receiver, ctx);
  if (outer === null) return null;
  // Single-level: $$$.<coll> / $$$["<coll>"] / $$$[boundCollParam]
  if (outer.object.type === "DatabaseRef") {
    return { pos: outer.object.pos, collection: outer.name };
  }
  // Two-level: $$$$.<db>.<coll> and all six (literal × literal, literal × bound,
  // bound × literal, bound × bound — across dot vs bracket) combinations.
  const inner = staticAccess(outer.object, ctx);
  if (inner === null) return null;
  if (inner.object.type !== "ClusterRef") return null;
  return { pos: inner.object.pos, db: inner.name, collection: outer.name };
}

/**
 * Recognise `$$$.<coll>.find(pred)` / `$$$.<coll>.filter(pred)` /
 * `$$$$.<db>.<coll>.find(pred)` / `$$$$.<db>.<coll>.filter(pred)` and all
 * their bracket variants — including `jsmql.compile`-parameter-bound
 * bracket indices (resolved through `ctx.bindings`). Returns `null` if
 * `expr` is not the shape, or if the shape is malformed (which surfaces
 * an actionable error elsewhere — see `validateLookupShape`).
 *
 * Callers in mode-gate / position-locator code paths that don't have a
 * meaningful `ctx` pass `EMPTY_CTX` — bound-bracket lookups won't be
 * detected from those paths, but those paths only run in expression
 * contexts (Filter / `jsmql.expr` / `jsmql.update`) where lookups would
 * be rejected wholesale anyway, so the trade-off is benign.
 */
export function detectLookupCall(expr: Expr, ctx: GenerateCtx): LookupCall | null {
  if (expr.type !== "MethodCall") return null;
  if (expr.method !== "find" && expr.method !== "filter") return null;
  const target = extractLookupTarget(expr.object, ctx);
  if (target === null) return null;
  if (expr.args.length !== 1) return null;
  const arg = expr.args[0];
  if (arg.type !== "Lambda") return null;
  return {
    pos: target.pos,
    callPos: expr.pos,
    db: target.db,
    collection: target.collection,
    method: expr.method,
    lambda: arg,
  };
}

/**
 * Cheap recursive walk: does `node` (or any sub-tree thereof) contain a
 * lookup call? Used by mode-gates in `index.ts` to pre-reject lookup
 * syntax in Filter / expression / update modes with an actionable error,
 * and by `lowerWithCtx` to detect lookup-bearing `UpdateFilter` inputs so
 * they can be rerouted through the lookup-aware pipeline lowerer.
 *
 * `ctx` defaults to `EMPTY_CTX` for the mode-gate call sites that don't
 * have a meaningful context. When the caller has the real ctx
 * (`lowerWithCtx`, `rejectNestedLookup`), pass it so bound bracket-index
 * lookups (`$$$[boundParam].find(...)`) detect correctly — without the
 * ctx, the binding can't resolve and the detection silently fails.
 */
export function containsLookupCall(node: Expr | Pipeline | UpdateFilter, ctx: GenerateCtx = EMPTY_CTX): boolean {
  return walkContainsLookup(node, ctx);
}

function walkContainsLookup(node: Expr | Pipeline | UpdateFilter | PipelineStmt | UpdateOp, ctx: GenerateCtx): boolean {
  if (node.type === "Pipeline") {
    return node.stmts.some((s) => walkContainsLookup(s, ctx));
  }
  if (node.type === "UpdateFilter") {
    return node.ops.some((op) => walkContainsLookup(op, ctx));
  }
  if (node.type === "AssignExpr") return walkContainsLookup(node.value, ctx);
  if (node.type === "DeleteStmt") return false;
  if (node.type === "LetDecl") return walkContainsLookup(node.value, ctx);
  if (node.type === "FuncDecl") return false; // compile-time decl; expanded at call sites, not here
  // Expr branches that could contain nested expressions
  const expr = node;
  if (detectLookupCall(expr, ctx) !== null) return true;
  if (expr.type === "MethodCall") {
    if (walkContainsLookup(expr.object, ctx)) return true;
    return walkArgsContainLookup(expr.args, ctx);
  }
  if (expr.type === "CallExpression") {
    if (walkContainsLookup(expr.callee, ctx)) return true;
    return walkArgsContainLookup(expr.args, ctx);
  }
  if (expr.type === "OperatorCall") return walkArgsContainLookup(expr.args, ctx);
  if (expr.type === "MathCall" || expr.type === "ObjectCall") return walkArgsContainLookup(expr.args, ctx);
  if (expr.type === "MemberAccess") return walkContainsLookup(expr.object, ctx);
  if (expr.type === "IndexAccess") return walkContainsLookup(expr.object, ctx) || walkContainsLookup(expr.index, ctx);
  if (expr.type === "BinaryExpr") return walkContainsLookup(expr.left, ctx) || walkContainsLookup(expr.right, ctx);
  if (expr.type === "UnaryExpr") return walkContainsLookup(expr.operand, ctx);
  if (expr.type === "TernaryExpr") {
    return (
      walkContainsLookup(expr.condition, ctx) ||
      walkContainsLookup(expr.consequent, ctx) ||
      walkContainsLookup(expr.alternate, ctx)
    );
  }
  if (expr.type === "Lambda") {
    if (expr.body !== undefined) return walkContainsLookup(expr.body, ctx);
    if (expr.exprBlock !== undefined) {
      return (
        expr.exprBlock.decls.some((d) => walkContainsLookup(d.value, ctx)) ||
        walkContainsLookup(expr.exprBlock.ret, ctx)
      );
    }
    if (expr.block !== undefined) return walkContainsLookup(expr.block, ctx);
    return false;
  }
  if (expr.type === "ArrayLiteral") {
    for (const el of expr.elements) {
      if (el.type === "SpreadElement") {
        if (walkContainsLookup(el.argument, ctx)) return true;
      } else if (walkContainsLookup(el as Expr | UpdateOp | LetDecl | FuncDecl, ctx)) {
        return true;
      }
    }
    return false;
  }
  if (expr.type === "ObjectLiteral") {
    for (const entry of expr.entries) {
      if (entry.type === "SpreadElement") {
        if (walkContainsLookup(entry.argument, ctx)) return true;
      } else {
        if (entry.key.kind === "computed" && walkContainsLookup(entry.key.expr, ctx)) return true;
        if (walkContainsLookup(entry.value, ctx)) return true;
      }
    }
    return false;
  }
  if (expr.type === "TemplateLiteral") return expr.expressions.some((e) => walkContainsLookup(e, ctx));
  if (expr.type === "TypeofExpr") return walkContainsLookup(expr.operand, ctx);
  if (expr.type === "NewDate") return expr.args.some((a) => walkContainsLookup(a, ctx));
  if (expr.type === "NewSet") return expr.arg ? walkContainsLookup(expr.arg, ctx) : false;
  if (expr.type === "TypeCast") return walkContainsLookup(expr.arg, ctx);
  if (expr.type === "ArrayFrom")
    return walkContainsLookup(expr.input, ctx) || (expr.mapFn ? walkContainsLookup(expr.mapFn, ctx) : false);
  if (expr.type === "NumberStatic") return walkContainsLookup(expr.arg, ctx);
  if (expr.type === "DateUTC") return expr.args.some((a) => walkContainsLookup(a, ctx));
  return false;
}

function walkArgsContainLookup(args: CallArg[], ctx: GenerateCtx): boolean {
  for (const a of args) {
    if (a.type === "SpreadElement") {
      if (walkContainsLookup(a.argument, ctx)) return true;
    } else if (walkContainsLookup(a, ctx)) return true;
  }
  return false;
}

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Walk `expr` back to a context-ref leaf and report which prefix it's rooted
 * at, alongside the spelling used in error messages. Returns null if the
 * receiver isn't context-ref-shaped. Distinct from `extractLookupTarget` —
 * that helper requires a *valid* one-or-two-level shape with static names;
 * this one is used to gate the validation-error throw site so a malformed
 * lookup-shaped receiver (wrong method, dynamic indices, missing levels)
 * still produces the targeted error instead of falling through to the
 * generic codegen one.
 */
function classifyLookupReceiver(receiver: Expr): { spelling: string } | null {
  let node: Expr = receiver;
  for (;;) {
    if (node.type === "DatabaseRef") return { spelling: "$$$.<coll>" };
    if (node.type === "ClusterRef") return { spelling: "$$$$.<db>.<coll>" };
    if (node.type === "MemberAccess" || node.type === "IndexAccess") {
      node = node.object;
      continue;
    }
    return null;
  }
}

/**
 * If `expr` looks like a lookup but is malformed (wrong method, wrong arity,
 * non-lambda arg), throw the targeted error. Used by the prologue extractor
 * before falling through to a generic walk.
 */
export function validateLookupShape(expr: Expr): void {
  if (expr.type !== "MethodCall") return;
  const shape = classifyLookupReceiver(expr.object);
  if (shape === null) return;
  // We're on a `$$$.<coll>.<method>(...)` or `$$$$.<db>.<coll>.<method>(...)` chain.
  const spell = shape.spelling;
  if (expr.method !== "find" && expr.method !== "filter") {
    const hint = didYouMean(expr.method, ["find", "filter"], (s) => `.${s}`);
    throw new CodegenError(
      `'${spell}' supports .find(pred) and .filter(pred), not .${expr.method}().${hint} ` +
        `For richer queries, use a block-body lambda: ` +
        `\`${spell}.filter(o => { $match(...); $sort(...); ... })\`.`,
      expr.pos,
    );
  }
  if (expr.args.length !== 1) {
    throw new CodegenError(
      `.${expr.method}(predicate) takes exactly one argument (a single-parameter arrow), got ${expr.args.length}.`,
      expr.pos,
    );
  }
  const arg = expr.args[0];
  if (arg.type !== "Lambda") {
    throw new CodegenError(
      `.${expr.method}(predicate) requires an arrow predicate, e.g. \`.${expr.method}(o => o._id === $.userId)\`.`,
      "pos" in arg ? arg.pos : expr.pos,
    );
  }
  if (arg.params.length !== 1) {
    throw new CodegenError(
      `.${expr.method}(predicate) takes a single-parameter arrow (the foreign document), got ${arg.params.length}.`,
      arg.pos,
    );
  }
}

// ── Slot allocator ────────────────────────────────────────────────────────────

/** Compiler-owned namespace; same field jsmql's pipeline-scoped `let` uses. */
const LET_NAMESPACE = "__jsmql";

/**
 * Per-pipeline counter shared across `extractLookupCalls` invocations so
 * `__jsmql.__lookup1` / `__lookup2` / … stay distinct within one pipeline.
 * The caller owns the counter.
 */
export type SlotAllocator = () => string;

export function createSlotAllocator(): SlotAllocator {
  let n = 0;
  return () => {
    n += 1;
    return `${LET_NAMESPACE}.__lookup${n}`;
  };
}

// ── Path classification (for let extraction) ──────────────────────────────────

/**
 * Walk down `expr` (an AST sub-tree at `MemberAccess` / `IndexAccess` /
 * `FieldRef` / `ParamRef` shape) and report whether it's a path rooted at
 * the local doc (`$.…`) or at the foreign-doc lambda param (`o.…`).
 *
 * Returns the dotted path segments alongside the root kind. IndexAccess
 * with a static string is folded into the path; non-static indices break
 * the classification (the sub-tree is not a foldable path).
 */
type ClassifiedPath =
  | { kind: "local"; segments: string[] }
  | { kind: "foreign"; segments: string[] }
  | {
      // An outer pipeline-scoped `let` binding referenced inside the predicate
      // (optionally with member access on it). The let materialises under
      // `__jsmql.<bindingName>` on each outer doc; `fieldPath` is the full
      // resolved path including any `.member` chain (e.g.
      // `__jsmql.user._id` for `user._id` where `user` is the binding).
      // `segments` is the access chain starting at the binding name —
      // used for letVar-naming via `segments[last]`, mirroring the
      // local-path convention.
      kind: "outerLet";
      segments: string[];
      fieldPath: string;
    };

function classifyPath(
  expr: Expr,
  foreignParam: string,
  outerLets?: ReadonlyMap<string, string>,
): ClassifiedPath | null {
  if (expr.type === "FieldRef") return { kind: "local", segments: [expr.path] };
  if (expr.type === "ParamRef") {
    if (expr.name === foreignParam) return { kind: "foreign", segments: [] };
    if (outerLets !== undefined && outerLets.has(expr.name)) {
      const fieldPath = outerLets.get(expr.name);
      if (fieldPath !== undefined) {
        return { kind: "outerLet", segments: [expr.name], fieldPath };
      }
    }
    return null;
  }
  if (expr.type === "MemberAccess") {
    const inner = classifyPath(expr.object, foreignParam, outerLets);
    if (inner === null) return null;
    if (inner.kind === "outerLet") {
      return {
        kind: "outerLet",
        segments: [...inner.segments, expr.member],
        fieldPath: `${inner.fieldPath}.${expr.member}`,
      };
    }
    return { kind: inner.kind, segments: [...inner.segments, expr.member] };
  }
  if (expr.type === "IndexAccess" && expr.index.type === "StringLiteral") {
    const inner = classifyPath(expr.object, foreignParam, outerLets);
    if (inner === null) return null;
    if (inner.kind === "outerLet") {
      return {
        kind: "outerLet",
        segments: [...inner.segments, expr.index.value],
        fieldPath: `${inner.fieldPath}.${expr.index.value}`,
      };
    }
    return { kind: inner.kind, segments: [...inner.segments, expr.index.value] };
  }
  return null;
}

// ── Predicate translation ─────────────────────────────────────────────────────

export type BasicFormPredicate = { kind: "basic"; localField: string; foreignField: string };

export type PipelineFormPredicate = {
  kind: "pipeline";
  /** let-vars to expose at the $lookup level. Key = letVarName; value = MQL field path string (e.g. "$_id"). */
  letVars: Record<string, string>;
  /** Stages making up the $lookup.pipeline body. */
  pipeline: object[];
};

/**
 * Translate a lookup-call's lambda into either the basic-form fields
 * (when the body is a single `===` between a foreign-path and a `$.`
 * local-path) or the correlated-pipeline form (everything else).
 *
 * `outerCtx` is the GenerateCtx the consuming pipeline is running under
 * — passed through so sub-pipeline codegen sees the same function-form
 * `bindings` (compile-time constants cross sub-pipeline boundaries; lets
 * do not, per `freshSubPipelineCtx`).
 */
export function translatePredicate(
  call: LookupCall,
  outerCtx: GenerateCtx,
  lowerBlock: SubPipelineLowerer,
  enclosing: EnclosingLookupContext = EMPTY_ENCLOSING,
): BasicFormPredicate | PipelineFormPredicate {
  const { lambda } = call;
  const foreignParam = lambda.params[0];
  const outerLets = outerCtx.pipelineLets;

  // ── Expression body ────────────────────────────────────────────────
  if (lambda.body !== undefined) {
    // Step 1: pre-rewrite enclosing-foreign-param refs to FieldRefs so the
    // inner's classifyPath sees them as local paths (auto-let captured into
    // the inner's $lookup.let). No-op at the top level.
    const preRewritten = rewriteEnclosingForeignParams(lambda.body, enclosing.foreignParams);

    // Basic-form is only valid at the top level. Nested lookups can't use
    // basic-form because their `localField` would be a path on the
    // enclosing pipeline's local doc, not on the outermost doc — force
    // pipeline-form so all the let-coordination plumbing kicks in.
    if (enclosing.foreignParams.length === 0) {
      const basic = tryBasicForm(preRewritten, foreignParam, outerLets);
      if (basic !== null) return basic;
    }

    // Pipeline-form with auto-`let` extraction.
    const { rewritten, letVars } = extractLetsFromExpr(preRewritten, foreignParam, outerLets);

    // Step 2: materialise nested lookups in the now-rewritten body. The
    // enclosing context grows by one level: this lookup's foreignParam plus
    // its newly-allocated letVars are now in scope for any deeper lookups.
    const innerEnclosing: EnclosingLookupContext = {
      foreignParams: [...enclosing.foreignParams, foreignParam],
      inScopeLetNames: new Set([...enclosing.inScopeLetNames, ...Object.keys(letVars)]),
    };
    const localAllocSlot = createSlotAllocator();
    const { stages: nestedStages, rewritten: lookupFree } = extractLookupCalls(
      rewritten,
      outerCtx,
      localAllocSlot,
      lowerBlock,
      innerEnclosing,
    );

    // Codegen context: our own letVar names PLUS enclosing-in-scope names
    // are all `lambdaParams` so codegen emits `$$<name>` correctly.
    const subCtx = makeSubPipelineCtx(outerCtx, [...Object.keys(letVars), ...enclosing.inScopeLetNames]);
    const matchBody = generateWithCtx(lookupFree, subCtx);
    return { kind: "pipeline", letVars, pipeline: [...nestedStages, { $match: { $expr: matchBody } }] };
  }

  // ── Block body ─────────────────────────────────────────────────────
  if (lambda.block !== undefined) {
    // Block-body nesting is a separate slice of work — each statement
    // may carry its own lookup, and the block's lowering already runs
    // `extractLookupCalls` for stage bodies. For now, only expression-body
    // lookups support nesting; block-body nested lookups would need ctx-
    // threading through `lowerBlock` (tracked as the next step). Reject
    // EITHER condition: (a) this lookup is itself nested inside another
    // (enclosing non-empty), or (b) this lookup is top-level but its block
    // body itself contains a nested lookup call.
    if (enclosing.foreignParams.length > 0 || containsLookupCall(lambda.block, outerCtx)) {
      // [DEF-023] block-body nested lookups
      throw new CodegenError(
        `Nested lookup inside another lookup's block-body lambda is not yet supported. ` +
          `Use an expression-body lambda for the outer lookup, or hoist the inner lookup to a sibling stage.`,
        lambda.pos,
      );
    }
    const { rewritten, letVars } = extractLetsFromPipeline(lambda.block, foreignParam, outerLets);
    const subCtx = makeSubPipelineCtx(outerCtx, Object.keys(letVars));
    const stages = lowerBlock(rewritten, subCtx);
    return { kind: "pipeline", letVars, pipeline: stages };
  }

  throw new CodegenError(
    `.${call.method}(predicate) predicate has a block body with local \`const\`/\`let\` bindings, which isn't supported in this position. Write the predicate as a single expression — \`function (x) { return <expr> }\` / \`(x) => <expr>\` — and fold any bindings into <expr>.`,
    lambda.pos,
  );
}

function makeSubPipelineCtx(outerCtx: GenerateCtx, letVarNames: string[]): GenerateCtx {
  const fresh = freshSubPipelineCtx(outerCtx);
  if (letVarNames.length === 0) return fresh;
  return { ...fresh, lambdaParams: new Set([...fresh.lambdaParams, ...letVarNames]) };
}

/**
 * Translate a `.filter(<lambda>)` predicate into the pipeline-form
 * components — `{ letVars, pipelineBody }` — usable as a `$lookup.let` +
 * `$lookup.pipeline` payload OR as the seed of a longer sub-pipeline that
 * chain methods will extend. Exported so callers outside this module
 * (`pipeline.ts`'s lookup-pivot and chain-extension paths) can build
 * pipeline-form lookups without re-implementing the predicate translation.
 *
 * Same algorithm as `translatePredicate`'s pipeline branch — expression
 * bodies route through `extractLetsFromExpr` (auto-`let` extraction +
 * foreign-path rewriting) and emit a `$match: { $expr: <translated> }`;
 * block bodies route through `extractLetsFromPipeline` + the caller-
 * supplied `lowerBlock` for the full sub-pipeline shape.
 */
export function buildPipelineFormPredicate(
  lambda: Lambda,
  outerCtx: GenerateCtx,
  lowerBlock: SubPipelineLowerer,
  enclosing: EnclosingLookupContext = EMPTY_ENCLOSING,
): { letVars: Record<string, string>; pipelineBody: object[] } {
  const foreignParam = lambda.params[0];
  const outerLets = outerCtx.pipelineLets;
  if (lambda.body !== undefined) {
    const preRewritten = rewriteEnclosingForeignParams(lambda.body, enclosing.foreignParams);
    const { rewritten, letVars } = extractLetsFromExpr(preRewritten, foreignParam, outerLets);
    const innerEnclosing: EnclosingLookupContext = {
      foreignParams: [...enclosing.foreignParams, foreignParam],
      inScopeLetNames: new Set([...enclosing.inScopeLetNames, ...Object.keys(letVars)]),
    };
    const localAllocSlot = createSlotAllocator();
    const { stages: nestedStages, rewritten: lookupFree } = extractLookupCalls(
      rewritten,
      outerCtx,
      localAllocSlot,
      lowerBlock,
      innerEnclosing,
    );
    const subCtx = makeSubPipelineCtx(outerCtx, [...Object.keys(letVars), ...enclosing.inScopeLetNames]);
    return { letVars, pipelineBody: [...nestedStages, { $match: { $expr: generateWithCtx(lookupFree, subCtx) } }] };
  }
  if (lambda.block !== undefined) {
    if (enclosing.foreignParams.length > 0) {
      // [DEF-023] block-body nested lookups
      throw new CodegenError(
        `Nested lookup inside another lookup's block-body lambda is not yet supported. ` +
          `Use an expression-body lambda for the outer lookup, or hoist the inner lookup to a sibling stage.`,
        lambda.pos,
      );
    }
    const { rewritten, letVars } = extractLetsFromPipeline(lambda.block, foreignParam, outerLets);
    const subCtx = makeSubPipelineCtx(outerCtx, Object.keys(letVars));
    return { letVars, pipelineBody: lowerBlock(rewritten, subCtx) };
  }
  throw new CodegenError(
    `Predicate predicate has a block body with local \`const\`/\`let\` bindings, which isn't supported in this position. Write the predicate as a single expression — \`function (x) { return <expr> }\` / \`(x) => <expr>\` — and fold any bindings into <expr>.`,
    lambda.pos,
  );
}

/**
 * Does the predicate reference any outer-doc context — either a `$.<field>`
 * path on the current document, or an in-scope `let` binding (a name bound
 * via `let foo = …` in the surrounding pipeline)? Used by `pipeline.ts` to
 * decide whether a `$$ = $$$.<coll>.filter(<pred>)` source-switch needs the
 * `$lookup`-pivot lowering (when the predicate correlates per-outer-doc) vs
 * the `$limit:0 + $unionWith` lowering (when it's a flat source-collection
 * scan).
 *
 * Detection mirrors what `extractLetsFromExpr` would produce — if there are
 * any `$.<field>` paths OR outer-let references in the body that would be
 * hoisted into `$lookup.let` vars, this returns true.
 */
export function predicateReferencesOuterDoc(lambda: Lambda, outerCtx: GenerateCtx): boolean {
  if (lambda.params.length !== 1) return false;
  const foreignParam = lambda.params[0];
  const outerLets = outerCtx.pipelineLets;
  if (lambda.body !== undefined) {
    const { letVars } = extractLetsFromExpr(lambda.body, foreignParam, outerLets);
    return Object.keys(letVars).length > 0;
  }
  if (lambda.block !== undefined) {
    const { letVars } = extractLetsFromPipeline(lambda.block, foreignParam, outerLets);
    return Object.keys(letVars).length > 0;
  }
  return false;
}

/**
 * Detect the basic-form predicate shape: body is `===` with one side a
 * foreign-path and the other a `$.` local path. Returns null for any
 * richer shape so the caller falls back to pipeline form.
 *
 * Only `===` is accepted here — never `==`. jsmql's project-wide rule
 * (see LANGUAGE.md, `===` vs `==` table) restricts `==` to comparisons
 * against `null`; anything else is rejected with a targeted "use `===`"
 * error. Carving an exception for lookup predicates would create exactly
 * the kind of inconsistency the rule exists to prevent. A user-written
 * `o.userId == $._id` falls through to pipeline form, where the
 * sub-pipeline codegen of the `$expr` body hits the standard `==`-only-
 * against-null check and throws the same error the user would get
 * anywhere else in jsmql.
 */
function tryBasicForm(
  body: Expr,
  foreignParam: string,
  outerLets?: ReadonlyMap<string, string>,
): BasicFormPredicate | null {
  if (body.type !== "BinaryExpr") return null;
  if (body.op !== "===") return null;
  const leftPath = classifyPath(body.left, foreignParam, outerLets);
  const rightPath = classifyPath(body.right, foreignParam, outerLets);
  if (leftPath === null || rightPath === null) return null;
  // "Local" for basic-form purposes means anything that resolves to a field
  // path on the OUTER doc — either a `$.<field>` ref OR an outer-let ref
  // (whose materialised path lives at `__jsmql.<binding>` on each outer doc).
  function localFieldFor(p: ClassifiedPath): string | null {
    if (p.kind === "local" && p.segments.length > 0) return p.segments.join(".");
    if (p.kind === "outerLet") return p.fieldPath;
    return null;
  }
  if (leftPath.kind === "foreign" && leftPath.segments.length > 0) {
    const local = localFieldFor(rightPath);
    if (local !== null) {
      return { kind: "basic", foreignField: leftPath.segments.join("."), localField: local };
    }
  }
  if (rightPath.kind === "foreign" && rightPath.segments.length > 0) {
    const local = localFieldFor(leftPath);
    if (local !== null) {
      return { kind: "basic", foreignField: rightPath.segments.join("."), localField: local };
    }
  }
  return null;
}

// ── Let extraction (AST rewriter) ─────────────────────────────────────────────

type LetAllocator = {
  /** Records "userId" → "$userId"; on second call with same path, returns the existing name. */
  allocateForLocalPath: (segments: string[]) => string;
  /**
   * Outer pipeline-scoped `let` binding referenced inside the predicate.
   * `segments` is the access chain rooted at the binding name (e.g.
   * `["user", "_id"]` for `user._id`); `fieldPath` is the full materialised
   * path on the outer doc (e.g. `"__jsmql.user._id"`). The allocated letVar
   * name is `segments[last]` — same convention as `allocateForLocalPath` —
   * uniquified on collision.
   */
  allocateForOuterLet: (segments: string[], fieldPath: string) => string;
  /** Final mapping for emit into `$lookup.let`. */
  letVars: () => Record<string, string>;
};

function createLetAllocator(): LetAllocator {
  const byPath = new Map<string, string>();
  const used = new Set<string>();
  const out: Record<string, string> = {};
  function uniqueName(preferred: string): string {
    if (!used.has(preferred)) return preferred;
    let n = 2;
    let candidate = `${preferred}_${n}`;
    while (used.has(candidate)) {
      n += 1;
      candidate = `${preferred}_${n}`;
    }
    return candidate;
  }
  return {
    allocateForLocalPath(segments: string[]): string {
      const dotted = segments.join(".");
      const existing = byPath.get(dotted);
      if (existing !== undefined) return existing;
      // The let-var name is `$$<name>` in the sub-pipeline; sanitize so a field
      // like `_id` (the most common join key) doesn't yield an invalid `$$_id`.
      const base = safeVarName(segments[segments.length - 1]);
      const name = uniqueName(base);
      used.add(name);
      byPath.set(dotted, name);
      out[name] = `$${dotted}`;
      return name;
    },
    allocateForOuterLet(segments: string[], fieldPath: string): string {
      const existing = byPath.get(fieldPath);
      if (existing !== undefined) return existing;
      const base = safeVarName(segments[segments.length - 1]);
      const name = uniqueName(base);
      used.add(name);
      byPath.set(fieldPath, name);
      out[name] = `$${fieldPath}`;
      return name;
    },
    letVars: () => out,
  };
}

export function extractLetsFromExpr(
  body: Expr,
  foreignParam: string,
  outerLets?: ReadonlyMap<string, string>,
): { rewritten: Expr; letVars: Record<string, string> } {
  const allocator = createLetAllocator();
  const rewritten = transformExpr(body, foreignParam, allocator, outerLets);
  return { rewritten, letVars: allocator.letVars() };
}

export function extractLetsFromPipeline(
  block: Pipeline,
  foreignParam: string,
  outerLets?: ReadonlyMap<string, string>,
): { rewritten: Pipeline; letVars: Record<string, string> } {
  const allocator = createLetAllocator();
  const stmts: PipelineStmt[] = block.stmts.map((s) => transformStmt(s, foreignParam, allocator, outerLets));
  return { rewritten: { type: "Pipeline", stmts, pos: block.pos }, letVars: allocator.letVars() };
}

/**
 * Emit the `$match` stages for a translated expression-body predicate. Lifted
 * verbatim from the union/facet/out translators, which all needed the same
 * four-way split: vacuous predicate → no stage; pure query → `{ $match: query }`;
 * pure residual → `{ $match: { $expr } }`; both → merged. Keeping it in one
 * place means the index-friendly/`$expr`-residual emission can't drift between
 * the sub-pipeline translators.
 */
export function matchStagesFromTranslation(t: MatchTranslation, subCtx: GenerateCtx): object[] {
  const merged = mergeTranslatedQuery(t, subCtx);
  return merged === null ? [] : [{ $match: merged }]; // null = vacuous predicate, skip the $match
}

/**
 * Lower a single-parameter predicate lambda — the foreign/current document is
 * the param — into sub-pipeline stages. Shared by the `$unionWith`, `$facet`,
 * and `$out` translators, which differ only in (a) the message thrown when the
 * predicate references the *local* doc (`$.<field>`, which would need a `let`
 * slot the target stage lacks) and (b) which fresh sub-pipeline ctx they build.
 * Both are injected; the expr-body / block-body / missing-body skeleton and the
 * `$match` emission are identical and live here.
 *
 * The caller validates the lambda's parameter count first (with its own
 * stage-specific message) — this helper assumes `lambda.params[0]` is the
 * document parameter.
 */
export function lowerLambdaPredicate(
  lambda: Lambda,
  outerCtx: GenerateCtx,
  lowerBlock: SubPipelineLowerer,
  opts: {
    freshCtx: (outer: GenerateCtx) => GenerateCtx;
    onLocalRef: (letVars: Record<string, string>, param: string, pos: number) => never;
    missingBody: () => never;
  },
): object[] {
  const param = lambda.params[0];

  // Expression body → query-language translation + `$match`.
  if (lambda.body !== undefined) {
    const { rewritten, letVars } = extractLetsFromExpr(lambda.body, param);
    if (Object.keys(letVars).length > 0) opts.onLocalRef(letVars, param, lambda.pos);
    const subCtx = opts.freshCtx(outerCtx);
    const t = translateMatchBody(rewritten, { bindings: subCtx.bindings });
    return matchStagesFromTranslation(t, subCtx);
  }

  // Block body → each statement becomes a stage via the caller's lowerer.
  if (lambda.block !== undefined) {
    const { rewritten, letVars } = extractLetsFromPipeline(lambda.block, param);
    if (Object.keys(letVars).length > 0) opts.onLocalRef(letVars, param, lambda.pos);
    const subCtx = opts.freshCtx(outerCtx);
    return lowerBlock(rewritten, subCtx);
  }

  return opts.missingBody();
}

function transformStmt(
  stmt: PipelineStmt,
  foreignParam: string,
  allocator: LetAllocator,
  outerLets: ReadonlyMap<string, string> | undefined,
): PipelineStmt {
  if (stmt.type === "LetDecl") {
    return {
      type: "LetDecl",
      name: stmt.name,
      value: transformExpr(stmt.value, foreignParam, allocator, outerLets),
      kind: stmt.kind,
      pos: stmt.pos,
    };
  }
  if (stmt.type === "FuncDecl") {
    // A function declared in this sub-pipeline may close over the foreign param
    // in its body — rewrite the lambda body just like a LetDecl's value, so the
    // body's `<foreignParam>.<field>` refs hoist to `$<field>` and the inlined
    // expansion at the call site resolves.
    return { ...stmt, lambda: transformExpr(stmt.lambda, foreignParam, allocator, outerLets) as Lambda };
  }
  if (stmt.type === "UpdateFilter") {
    const ops: UpdateOp[] = stmt.ops.map((op) => {
      if (op.type === "AssignExpr") {
        return {
          type: "AssignExpr",
          target: transformExpr(op.target, foreignParam, allocator, outerLets),
          value: transformExpr(op.value, foreignParam, allocator, outerLets),
          pos: op.pos,
        };
      }
      // DeleteStmt
      return { type: "DeleteStmt", target: transformExpr(op.target, foreignParam, allocator, outerLets), pos: op.pos };
    });
    return { type: "UpdateFilter", ops, pos: stmt.pos };
  }
  return transformExpr(stmt as Expr, foreignParam, allocator, outerLets);
}

/**
 * Recursive AST rewriter. At each visited node:
 *   - If the node is a `classifyPath`-able sub-tree:
 *     - "local" root → swap for a `ParamRef` whose name is the allocated
 *       let-var (codegen lowers it to `$$<letVar>` — exactly the MQL
 *       binding the sub-pipeline needs).
 *     - "foreign" root → swap for a bare `FieldRef(path)` (lowers to
 *       `"$path"` inside the sub-pipeline, where the foreign doc is the
 *       root).
 *   - Otherwise recurse into children, producing a fresh node with
 *     transformed sub-trees.
 *
 * Nested lambdas inside the predicate body keep their own params; we
 * stop walking into their bodies because their scope is distinct. (A
 * nested `$$$.x.find/filter(...)` is detected separately by the
 * pipeline integration, which rejects it in v1 — see plan §5.)
 */
function transformExpr(
  expr: Expr,
  foreignParam: string,
  allocator: LetAllocator,
  outerLets: ReadonlyMap<string, string> | undefined,
): Expr {
  const classified = classifyPath(expr, foreignParam, outerLets);
  if (classified !== null) {
    if (classified.kind === "local") {
      const letVar = allocator.allocateForLocalPath(classified.segments);
      return { type: "ParamRef", name: letVar, pos: expr.pos } as ParamRef;
    }
    if (classified.kind === "outerLet") {
      const letVar = allocator.allocateForOuterLet(classified.segments, classified.fieldPath);
      return { type: "ParamRef", name: letVar, pos: expr.pos } as ParamRef;
    }
    // Foreign path. Bare `o` alone is not yet supported (no $$ROOT lowering).
    if (classified.segments.length === 0) {
      throw new CodegenError(
        `Bare lambda parameter '${foreignParam}' in a $lookup predicate is not yet supported — use \`${foreignParam}.<field>\` to reference a foreign document field.`,
        expr.pos,
      );
    }
    return { type: "FieldRef", path: classified.segments.join("."), pos: expr.pos } as FieldRef;
  }
  return mapChildren(expr, foreignParam, allocator, outerLets);
}

function mapChildren(
  expr: Expr,
  foreignParam: string,
  allocator: LetAllocator,
  outerLets: ReadonlyMap<string, string> | undefined,
): Expr {
  switch (expr.type) {
    case "FieldRef":
    case "CollectionRef":
    case "DatabaseRef":
    case "ClusterRef":
    case "NumberLiteral":
    case "BigIntLiteral":
    case "StringLiteral":
    case "BooleanLiteral":
    case "NullLiteral":
    case "UndefinedLiteral":
    case "RegexLiteral":
    case "ParamRef":
    case "TypeCastRef":
    case "MathConst":
    case "MathCallRef":
    case "DateNow":
      return expr;
    case "BinaryExpr":
      return {
        type: "BinaryExpr",
        op: expr.op,
        left: transformExpr(expr.left, foreignParam, allocator, outerLets),
        right: transformExpr(expr.right, foreignParam, allocator, outerLets),
        pos: expr.pos,
      };
    case "UnaryExpr":
      return {
        type: "UnaryExpr",
        op: expr.op,
        operand: transformExpr(expr.operand, foreignParam, allocator, outerLets),
        pos: expr.pos,
      };
    case "TernaryExpr":
      return {
        type: "TernaryExpr",
        condition: transformExpr(expr.condition, foreignParam, allocator, outerLets),
        consequent: transformExpr(expr.consequent, foreignParam, allocator, outerLets),
        alternate: transformExpr(expr.alternate, foreignParam, allocator, outerLets),
        pos: expr.pos,
      };
    case "MemberAccess":
      return {
        type: "MemberAccess",
        object: transformExpr(expr.object, foreignParam, allocator, outerLets),
        member: expr.member,
        pos: expr.pos,
        ...(expr.optional && { optional: true }),
      };
    case "IndexAccess":
      return {
        type: "IndexAccess",
        object: transformExpr(expr.object, foreignParam, allocator, outerLets),
        index: transformExpr(expr.index, foreignParam, allocator, outerLets),
        pos: expr.pos,
        ...(expr.optional && { optional: true }),
      };
    case "MethodCall":
      // Note on nested lookups: when this MethodCall is itself a lookup call
      // (`$$$.<coll>.find/filter(...)`), the args[0] is its OWN lambda. The
      // recursive `transformExpr` below walks INTO the inner lambda's body
      // with the OUTER's foreignParam still in scope — which is what we
      // want: a `outerForeign.<x>` ref inside the inner body classifies as
      // foreign and rewrites to `FieldRef(<x>)`, exactly the pre-rewrite
      // that `rewriteEnclosingForeignParams` would apply in the nested-
      // materialisation step. Inner-foreign refs (`inner.x`) don't match
      // the outer's foreignParam, so they pass through unchanged.
      return {
        type: "MethodCall",
        object: transformExpr(expr.object, foreignParam, allocator, outerLets),
        method: expr.method,
        args: transformCallArgs(expr.args, foreignParam, allocator, outerLets),
        pos: expr.pos,
        ...(expr.optional && { optional: true }),
      };
    case "CallExpression":
      return {
        type: "CallExpression",
        callee: transformExpr(expr.callee, foreignParam, allocator, outerLets),
        args: transformCallArgs(expr.args, foreignParam, allocator, outerLets),
        pos: expr.pos,
      };
    case "OperatorCall":
      return {
        type: "OperatorCall",
        name: expr.name,
        style: expr.style,
        args: transformCallArgs(expr.args, foreignParam, allocator, outerLets),
        pos: expr.pos,
      };
    case "Lambda":
      // Nested lambdas shadow the foreign param if they reuse the name; otherwise
      // their references resolve through the outer scope. Conservatively, we
      // recurse with the same foreign-param so $.x refs inside still hoist out.
      if (expr.body !== undefined) {
        return {
          type: "Lambda",
          params: expr.params,
          body: transformExpr(expr.body, foreignParam, allocator, outerLets),
          pos: expr.pos,
        };
      }
      if (expr.exprBlock !== undefined) {
        return {
          type: "Lambda",
          params: expr.params,
          exprBlock: {
            type: "ExprBlock",
            decls: expr.exprBlock.decls.map((d) => ({
              ...d,
              value: transformExpr(d.value, foreignParam, allocator, outerLets),
            })),
            ret: transformExpr(expr.exprBlock.ret, foreignParam, allocator, outerLets),
            pos: expr.exprBlock.pos,
          },
          pos: expr.pos,
        };
      }
      // Statement-block body in a nested position would be unusual (only the
      // outermost lookup-callback parses a statement block). Pass through.
      return expr;
    case "ArrayLiteral":
      return {
        type: "ArrayLiteral",
        elements: expr.elements.map((el): ArrayElement => {
          if (el.type === "SpreadElement") {
            return {
              type: "SpreadElement",
              argument: transformExpr(el.argument, foreignParam, allocator, outerLets),
              pos: el.pos,
            };
          }
          if (el.type === "AssignExpr") {
            return {
              type: "AssignExpr",
              target: transformExpr(el.target, foreignParam, allocator, outerLets),
              value: transformExpr(el.value, foreignParam, allocator, outerLets),
              pos: el.pos,
            };
          }
          if (el.type === "DeleteStmt") {
            return {
              type: "DeleteStmt",
              target: transformExpr(el.target, foreignParam, allocator, outerLets),
              pos: el.pos,
            };
          }
          if (el.type === "LetDecl") {
            return {
              type: "LetDecl",
              name: el.name,
              value: transformExpr(el.value, foreignParam, allocator, outerLets),
              kind: el.kind,
              pos: el.pos,
            };
          }
          if (el.type === "FuncDecl")
            return { ...el, lambda: transformExpr(el.lambda, foreignParam, allocator, outerLets) as Lambda };
          return transformExpr(el as Expr, foreignParam, allocator, outerLets);
        }),
        pos: expr.pos,
      };
    case "ObjectLiteral":
      return {
        type: "ObjectLiteral",
        entries: expr.entries.map((entry): ObjectEntry => {
          if (entry.type === "SpreadElement") {
            return {
              type: "SpreadElement",
              argument: transformExpr(entry.argument, foreignParam, allocator, outerLets),
              pos: entry.pos,
            };
          }
          const kv: KeyValueEntry = {
            type: "KeyValueEntry",
            key:
              entry.key.kind === "computed"
                ? { kind: "computed", expr: transformExpr(entry.key.expr, foreignParam, allocator, outerLets) }
                : entry.key,
            value: transformExpr(entry.value, foreignParam, allocator, outerLets),
            pos: entry.pos,
          };
          return kv;
        }),
        pos: expr.pos,
      };
    case "TemplateLiteral":
      return {
        type: "TemplateLiteral",
        quasis: expr.quasis,
        expressions: expr.expressions.map((e) => transformExpr(e, foreignParam, allocator, outerLets)),
        pos: expr.pos,
      };
    case "TypeofExpr":
      return {
        type: "TypeofExpr",
        operand: transformExpr(expr.operand, foreignParam, allocator, outerLets),
        pos: expr.pos,
      };
    case "NewDate":
      return {
        type: "NewDate",
        args: expr.args.map((a) => transformExpr(a, foreignParam, allocator, outerLets)),
        pos: expr.pos,
      };
    case "NewSet":
      return {
        type: "NewSet",
        arg: expr.arg !== null ? transformExpr(expr.arg, foreignParam, allocator, outerLets) : null,
        pos: expr.pos,
      };
    case "TypeCast":
      return {
        type: "TypeCast",
        cast: expr.cast,
        arg: transformExpr(expr.arg, foreignParam, allocator, outerLets),
        pos: expr.pos,
      };
    case "MathCall":
      return {
        type: "MathCall",
        method: expr.method,
        args: transformCallArgs(expr.args, foreignParam, allocator, outerLets),
        pos: expr.pos,
      };
    case "ObjectCall":
      return {
        type: "ObjectCall",
        method: expr.method,
        args: transformCallArgs(expr.args, foreignParam, allocator, outerLets),
        pos: expr.pos,
      };
    case "ArrayFrom":
      return {
        type: "ArrayFrom",
        input: transformExpr(expr.input, foreignParam, allocator, outerLets),
        mapFn: expr.mapFn !== null ? transformExpr(expr.mapFn, foreignParam, allocator, outerLets) : null,
        pos: expr.pos,
      };
    case "NumberStatic":
      return {
        type: "NumberStatic",
        method: expr.method,
        arg: transformExpr(expr.arg, foreignParam, allocator, outerLets),
        pos: expr.pos,
      };
    case "DateUTC":
      return {
        type: "DateUTC",
        args: expr.args.map((a) => transformExpr(a, foreignParam, allocator, outerLets)),
        pos: expr.pos,
      };
  }
}

function transformCallArgs(
  args: CallArg[],
  foreignParam: string,
  allocator: LetAllocator,
  outerLets: ReadonlyMap<string, string> | undefined,
): CallArg[] {
  return args.map((a): CallArg => {
    if (a.type === "SpreadElement") {
      return {
        type: "SpreadElement",
        argument: transformExpr(a.argument, foreignParam, allocator, outerLets),
        pos: a.pos,
      };
    }
    return transformExpr(a, foreignParam, allocator, outerLets);
  });
}

// ── Lowering ──────────────────────────────────────────────────────────────────

/**
 * Build the `$lookup` (+ optional `$set { $first }`) stage list for a single
 * lookup call, writing its result into the `as` slot. The `as` slot may be a
 * user-named field path (when the lookup is the whole RHS of an assignment /
 * `let`) or an internal `__jsmql.__lookupN` slot (when chained).
 */
export function lowerLookup(
  call: LookupCall,
  as: string,
  outerCtx: GenerateCtx,
  lowerBlock: SubPipelineLowerer,
  enclosing: EnclosingLookupContext = EMPTY_ENCLOSING,
): object[] {
  const pred = translatePredicate(call, outerCtx, lowerBlock, enclosing);
  // `$lookup.from` is a bare string for same-database joins (`$$$.<coll>`) and
  // an object `{ db, coll }` for cross-database joins (`$$$$.<db>.<coll>`).
  // The object shape is the Atlas Data Federation form — community-server
  // MongoDB does not accept it; we still emit it because the surface lights
  // up on Atlas Data Federation and the runtime error on community Mongo
  // names the offending shape if a user runs it on the wrong deployment.
  // See docs/specs/lookup-stage.md and the DEVLOG entry.
  const from: string | { db: string; coll: string } =
    call.db !== undefined ? { db: call.db, coll: call.collection } : call.collection;
  const stages: object[] = [];
  if (pred.kind === "basic") {
    stages.push({ $lookup: { from, localField: pred.localField, foreignField: pred.foreignField, as } });
  } else {
    stages.push({ $lookup: { from, let: pred.letVars, pipeline: pred.pipeline, as } });
  }
  if (call.method === "find") {
    // JS `.find()` returns scalar-or-null. Overwrite the slot with `$first`
    // so the row is preserved on no match (slot becomes null) and the slot
    // holds a single doc on any match — no row fan-out.
    stages.push({ $set: { [as]: { $first: `$${as}` } } });
  }
  return stages;
}

// ── Chained-terminal recognition + materialisation ────────────────────────────

/**
 * Top-down walk of `expr`. At each sub-tree, recognise either a
 * directly-consumed lookup or a "chained terminal" (`<lookup>.length`,
 * `<lookup>.reduce(fn, init)`). For each recognised lookup, allocate a
 * fresh slot, emit the prologue stages (the lookup itself, plus any
 * chained transform), and substitute a `FieldRef(slot)` into the
 * returned expression so the surrounding stage's codegen runs over the
 * materialised result.
 *
 * Anything not recognised as a lookup pattern is left alone but
 * recursed into so a lookup buried in (say) an arithmetic operand still
 * materialises correctly.
 *
 * Nested lookups inside an expression-body predicate of an outer lookup
 * materialise through the same recursive descent (with
 * `EnclosingLookupContext` threading), landing as prologue `$lookup`
 * stages inside the outer's `$lookup.pipeline`. Block-body nested
 * lookups are still rejected — see [DEF-023] in `translatePredicate`.
 */
export function extractLookupCalls(
  expr: Expr,
  outerCtx: GenerateCtx,
  allocSlot: SlotAllocator,
  lowerBlock: SubPipelineLowerer,
  enclosing: EnclosingLookupContext = EMPTY_ENCLOSING,
): { stages: object[]; rewritten: Expr } {
  // Malformed-shape pre-check: if expr is a MethodCall on a DatabaseRef-rooted
  // receiver, run the targeted validator so wrong-method (`fnid`), wrong-arity,
  // and non-arrow-arg cases surface their precise messages instead of falling
  // through to the generic "must be followed by .find/.filter" codegen error.
  validateLookupShape(expr);
  // Chained `.length` on a lookup
  if (expr.type === "MemberAccess" && expr.member === "length") {
    const innerCall = detectLookupCall(expr.object, outerCtx);
    if (innerCall !== null) {
      if (innerCall.method === "find") {
        // `.find()` returns scalar-or-null (after `$set $first`); `.length` on
        // a doc/null isn't meaningful and `$size` on a non-array would error
        // at runtime. Mirror the `.find().reduce()` rejection with an
        // actionable hint at the right call.
        throw new CodegenError(
          `.length on a .find() result is not meaningful — .find returns scalar-or-null. ` +
            `Use .filter(...).length to count matching documents, or chain a field access ` +
            `(.find(...).<field>) to read a property of the matched doc.`,
          expr.pos,
        );
      }
      const slot = allocSlot();
      const stages = lowerLookup(innerCall, slot, outerCtx, lowerBlock, enclosing);
      // .filter result is an array; $size is the array length.
      stages.push({ $set: { [slot]: { $size: `$${slot}` } } });
      return { stages, rewritten: { type: "FieldRef", path: slot, pos: expr.pos } };
    }
  }
  // Chained `.reduce(fn, init)` on a lookup
  if (expr.type === "MethodCall" && expr.method === "reduce") {
    const innerCall = detectLookupCall(expr.object, outerCtx);
    if (innerCall !== null) {
      if (innerCall.method === "find") {
        throw new CodegenError(
          `.reduce() on a .find() result is not meaningful — .find returns a scalar-or-null. ` +
            `Use .filter(...) before .reduce(), or read the scalar directly.`,
          expr.pos,
        );
      }
      // The reduce lambda runs over an array (the filter result). Hand off to
      // the existing `.reduce` codegen by emitting a generic $set whose value
      // is the reduce expression over the materialised slot.
      const slot = allocSlot();
      const stages = lowerLookup(innerCall, slot, outerCtx, lowerBlock, enclosing);
      // Synthesize: `$set { slot: <reduceMethodCall over FieldRef(slot)> }`
      const reduceCall: MethodCall = {
        type: "MethodCall",
        object: { type: "FieldRef", path: slot, pos: expr.pos },
        method: "reduce",
        args: expr.args,
        pos: expr.pos,
      };
      const reduceExpr = generateWithCtx(reduceCall, outerCtx);
      stages.push({ $set: { [slot]: reduceExpr } });
      return { stages, rewritten: { type: "FieldRef", path: slot, pos: expr.pos } };
    }
  }
  // Direct lookup as the whole expression
  const direct = detectLookupCall(expr, outerCtx);
  if (direct !== null) {
    const slot = allocSlot();
    const stages = lowerLookup(direct, slot, outerCtx, lowerBlock, enclosing);
    return { stages, rewritten: { type: "FieldRef", path: slot, pos: expr.pos } };
  }
  // Chained stream methods on a `.filter` lookup (e.g.,
  // `$$$.coll.filter(p).map(...).toSorted((a,b) => …).slice(0, N)`): push the
  // chain stages INTO the `$lookup.pipeline` body so methods without a clean
  // expression-form ($sort with comparator, $unwind, $group, …) lower the
  // same way they would in a stage-position chain. The slot then holds the
  // already-transformed array, and chained terminals (`.length`, `.reduce`)
  // / member access on the result keep working through the recursion below.
  const chained = tryExtractChainedLookup(expr, outerCtx, allocSlot, lowerBlock, enclosing);
  if (chained !== null) return chained;
  // Otherwise: recurse into children so a lookup buried deeper still
  // materialises. Reuse the AST-mapping pattern but accumulate stages.
  return descendAndExtract(expr, outerCtx, allocSlot, lowerBlock, enclosing);
}

/**
 * Detect `$$$.<coll>.filter(p).<m1>(...).<m2>(...)…` — a `.filter` lookup
 * followed by one or more registered stream methods. When matched, build the
 * `$lookup` with all the chain stages pushed into its `pipeline:` body and
 * return a `FieldRef(slot)` substituting the entire chain. The slot holds the
 * transformed array; the surrounding expression's codegen reads it as
 * `"$<slot>"`.
 *
 * Returns `null` when:
 *   - `expr` isn't a `MethodCall`,
 *   - the chain has no methods on top of the lookup head,
 *   - the innermost receiver isn't a `.filter` lookup (`.find` heads are
 *     scalar — chain methods don't apply the same way; left to the caller's
 *     existing `descendAndExtract` path), or
 *   - any chain method isn't in the stream-methods registry.
 *
 * This is the stage-form counterpart to the expression-form fallthrough
 * `descendAndExtract` would produce: same final array, fewer stages, and
 * stream-method semantics for `.toSorted` / `.toReversed` / `.flatMap` /
 * `.slice` / `.concat` / `.map` / `.filter` (which expression-form either
 * couldn't represent or represented as the bulkier `$map` / `$filter` / `$slice`
 * operators).
 */
function tryExtractChainedLookup(
  expr: Expr,
  outerCtx: GenerateCtx,
  allocSlot: SlotAllocator,
  lowerBlock: SubPipelineLowerer,
  enclosing: EnclosingLookupContext = EMPTY_ENCLOSING,
): { stages: object[]; rewritten: Expr } | null {
  if (expr.type !== "MethodCall") return null;
  // Walk back collecting the chain of MethodCall nodes.
  const methods: MethodCall[] = [];
  let cur: Expr = expr;
  while (cur.type === "MethodCall") {
    methods.push(cur);
    cur = cur.object;
  }
  methods.reverse(); // innermost first
  if (methods.length < 2) return null;
  // Innermost must be a `.filter` lookup head (a `$$$.<coll>.filter(<lambda>)` call).
  const head = methods[0];
  const direct = detectLookupCall(head, outerCtx);
  if (direct === null) return null;
  if (direct.method !== "filter") return null;
  // Every subsequent method must come from the stream-methods registry —
  // otherwise the chain falls through to the existing expression-form path,
  // which can still handle e.g. string methods on lookup results.
  for (let i = 1; i < methods.length; i++) {
    if (lookupStreamMethod(methods[i].method) === null) return null;
  }
  // Force pipeline form for the lookup so the chain stages can extend it.
  // The enclosing context flows through so nested lookups inside the
  // predicate materialise correctly with their own let-bindings.
  const { letVars, pipelineBody } = buildPipelineFormPredicate(direct.lambda, outerCtx, lowerBlock, enclosing);
  // Apply each chain method through the stream-methods registry. `inSubPipeline`
  // is true so methods know they're emitting inside a sub-pipeline body.
  const innerCtx = freshSubPipelineCtx(outerCtx);
  for (let i = 1; i < methods.length; i++) {
    const m = methods[i];
    const def = lookupStreamMethod(m.method);
    if (def === null) return null; // (defensive — already filtered above)
    def.validate(m.args, m.pos);
    const result = def.lower(m.args, innerCtx, m.pos, lowerBlock, pipelineBody, allocSlot, true);
    if (result.replacesPreviousStage) pipelineBody.pop();
    pipelineBody.push(...result.stages);
  }
  // Build the $lookup stage. `as` is an internal slot; the surrounding
  // expression's codegen reads it. (Future optimisation: detect when the
  // chain is the entire RHS of a `$.<field> = <chain>` and use the field
  // path as `as` directly, dropping the trailing `$set` + `$unset`.)
  const slot = allocSlot();
  const from: string | { db: string; coll: string } =
    direct.db !== undefined ? { db: direct.db, coll: direct.collection } : direct.collection;
  return {
    stages: [{ $lookup: { from, let: letVars, pipeline: pipelineBody, as: slot } }],
    rewritten: { type: "FieldRef", path: slot, pos: expr.pos },
  };
}

function descendAndExtract(
  expr: Expr,
  outerCtx: GenerateCtx,
  allocSlot: SlotAllocator,
  lowerBlock: SubPipelineLowerer,
  enclosing: EnclosingLookupContext = EMPTY_ENCLOSING,
): { stages: object[]; rewritten: Expr } {
  const stages: object[] = [];
  const rewriteChild = (child: Expr): Expr => {
    const r = extractLookupCalls(child, outerCtx, allocSlot, lowerBlock, enclosing);
    for (const s of r.stages) stages.push(s);
    return r.rewritten;
  };
  switch (expr.type) {
    case "FieldRef":
    case "CollectionRef":
    case "DatabaseRef":
    case "ClusterRef":
    case "NumberLiteral":
    case "BigIntLiteral":
    case "StringLiteral":
    case "BooleanLiteral":
    case "NullLiteral":
    case "UndefinedLiteral":
    case "RegexLiteral":
    case "ParamRef":
    case "TypeCastRef":
    case "MathConst":
    case "MathCallRef":
    case "DateNow":
      return { stages, rewritten: expr };
    case "BinaryExpr":
      return {
        stages,
        rewritten: {
          type: "BinaryExpr",
          op: expr.op,
          left: rewriteChild(expr.left),
          right: rewriteChild(expr.right),
          pos: expr.pos,
        },
      };
    case "UnaryExpr":
      return {
        stages,
        rewritten: { type: "UnaryExpr", op: expr.op, operand: rewriteChild(expr.operand), pos: expr.pos },
      };
    case "TernaryExpr":
      return {
        stages,
        rewritten: {
          type: "TernaryExpr",
          condition: rewriteChild(expr.condition),
          consequent: rewriteChild(expr.consequent),
          alternate: rewriteChild(expr.alternate),
          pos: expr.pos,
        },
      };
    case "MemberAccess":
      return {
        stages,
        rewritten: {
          type: "MemberAccess",
          object: rewriteChild(expr.object),
          member: expr.member,
          pos: expr.pos,
          ...(expr.optional && { optional: true }),
        },
      };
    case "IndexAccess":
      return {
        stages,
        rewritten: {
          type: "IndexAccess",
          object: rewriteChild(expr.object),
          index: rewriteChild(expr.index),
          pos: expr.pos,
          ...(expr.optional && { optional: true }),
        },
      };
    case "MethodCall":
      return {
        stages,
        rewritten: {
          type: "MethodCall",
          object: rewriteChild(expr.object),
          method: expr.method,
          args: rewriteCallArgs(expr.args, rewriteChild),
          pos: expr.pos,
          ...(expr.optional && { optional: true }),
        },
      };
    case "CallExpression":
      return {
        stages,
        rewritten: {
          type: "CallExpression",
          callee: rewriteChild(expr.callee),
          args: rewriteCallArgs(expr.args, rewriteChild),
          pos: expr.pos,
        },
      };
    case "OperatorCall":
      return {
        stages,
        rewritten: {
          type: "OperatorCall",
          name: expr.name,
          style: expr.style,
          args: rewriteCallArgs(expr.args, rewriteChild),
          pos: expr.pos,
        },
      };
    case "Lambda":
      // Lookups inside a lambda body (other than the lookup-callback lambda
      // itself, which is already detected above) are uncommon and would only
      // arise from very contrived nesting. Pass through — the codegen errors
      // if a DatabaseRef escapes unhandled.
      return { stages, rewritten: expr };
    case "ArrayLiteral":
      return {
        stages,
        rewritten: {
          type: "ArrayLiteral",
          elements: expr.elements.map((el): ArrayElement => {
            if (el.type === "SpreadElement")
              return { type: "SpreadElement", argument: rewriteChild(el.argument), pos: el.pos };
            if (el.type === "AssignExpr")
              return {
                type: "AssignExpr",
                target: rewriteChild(el.target),
                value: rewriteChild(el.value),
                pos: el.pos,
              };
            if (el.type === "DeleteStmt") return { type: "DeleteStmt", target: rewriteChild(el.target), pos: el.pos };
            if (el.type === "LetDecl")
              return { type: "LetDecl", name: el.name, value: rewriteChild(el.value), kind: el.kind, pos: el.pos };
            if (el.type === "FuncDecl") return el; // compile-time decl; nothing to rewrite
            return rewriteChild(el as Expr);
          }),
          pos: expr.pos,
        },
      };
    case "ObjectLiteral":
      return {
        stages,
        rewritten: {
          type: "ObjectLiteral",
          entries: expr.entries.map((entry): ObjectEntry => {
            if (entry.type === "SpreadElement")
              return { type: "SpreadElement", argument: rewriteChild(entry.argument), pos: entry.pos };
            const kv: KeyValueEntry = {
              type: "KeyValueEntry",
              key: entry.key.kind === "computed" ? { kind: "computed", expr: rewriteChild(entry.key.expr) } : entry.key,
              value: rewriteChild(entry.value),
              pos: entry.pos,
            };
            return kv;
          }),
          pos: expr.pos,
        },
      };
    case "TemplateLiteral":
      return {
        stages,
        rewritten: {
          type: "TemplateLiteral",
          quasis: expr.quasis,
          expressions: expr.expressions.map(rewriteChild),
          pos: expr.pos,
        },
      };
    case "TypeofExpr":
      return { stages, rewritten: { type: "TypeofExpr", operand: rewriteChild(expr.operand), pos: expr.pos } };
    case "NewDate":
      return { stages, rewritten: { type: "NewDate", args: expr.args.map(rewriteChild), pos: expr.pos } };
    case "NewSet":
      return {
        stages,
        rewritten: { type: "NewSet", arg: expr.arg !== null ? rewriteChild(expr.arg) : null, pos: expr.pos },
      };
    case "TypeCast":
      return { stages, rewritten: { type: "TypeCast", cast: expr.cast, arg: rewriteChild(expr.arg), pos: expr.pos } };
    case "MathCall":
      return {
        stages,
        rewritten: {
          type: "MathCall",
          method: expr.method,
          args: rewriteCallArgs(expr.args, rewriteChild),
          pos: expr.pos,
        },
      };
    case "ObjectCall":
      return {
        stages,
        rewritten: {
          type: "ObjectCall",
          method: expr.method,
          args: rewriteCallArgs(expr.args, rewriteChild),
          pos: expr.pos,
        },
      };
    case "ArrayFrom":
      return {
        stages,
        rewritten: {
          type: "ArrayFrom",
          input: rewriteChild(expr.input),
          mapFn: expr.mapFn !== null ? rewriteChild(expr.mapFn) : null,
          pos: expr.pos,
        },
      };
    case "NumberStatic":
      return {
        stages,
        rewritten: { type: "NumberStatic", method: expr.method, arg: rewriteChild(expr.arg), pos: expr.pos },
      };
    case "DateUTC":
      return { stages, rewritten: { type: "DateUTC", args: expr.args.map(rewriteChild), pos: expr.pos } };
  }
}

function rewriteCallArgs(args: CallArg[], rewrite: (e: Expr) => Expr): CallArg[] {
  return args.map((a): CallArg => {
    if (a.type === "SpreadElement") return { type: "SpreadElement", argument: rewrite(a.argument), pos: a.pos };
    return rewrite(a);
  });
}
