// Cross-collection lookup translation: lowers `$$$.<coll>.find/filter(pred)`
// and its chained-read forms into MongoDB `$lookup` (+ follow-up) stages.
//
// Three responsibilities:
//
//   1. **Detect** a lookup call in an arbitrary expression position
//      (`detectLookupCall`).
//
//   2. **Translate** the predicate lambda into either the basic-form
//      shape (`{ from, localField, foreignField, as }`) when the body
//      collapses to a single `===` between a foreign path and a `$.`
//      local path, or the correlated-pipeline shape
//      (`{ from, let, pipeline: [...], as }`) otherwise. The pipeline
//      form auto-hoists every `$.x` reference into a `let` entry whose
//      name is the path's last segment; references to the foreign-doc
//      lambda param (`o.x.y`) are rewritten to bare `FieldRef` so they
//      lower to `"$x.y"` inside the sub-pipeline (foreign doc is
//      `$$ROOT` there). Block-body lambdas (`o => { stmt; stmt; }`)
//      always go through the pipeline form, using the block stmts as
//      the sub-pipeline body verbatim.
//
//   3. **Materialise** the lookup result into a pipeline stage,
//      writing to either a user-named slot (when the lookup is the
//      whole RHS of an assignment or `let`) or an internal
//      `__jsmql.__lookup<N>` slot. For `.find`, an extra
//      `$set { <slot>: { $first: "$<slot>" } }` stage follows the
//      `$lookup` so the slot holds scalar-or-null instead of an array
//      — JS-faithful semantics. For chained terminals (`.length`,
//      `.reduce(fn, init)`), a third `$set` stage applies the
//      reduction over the slot. Internal slots ride the existing
//      `__jsmql` cleanup at the end of the pipeline — no per-temp
//      `$unset` emitted.
//
// `containsLookupCall` is the cheap walk used by `index.ts` to
// pre-reject lookup syntax in Filter / `jsmql.expr` / `jsmql.update`
// modes before codegen, so the user sees an actionable "use Pipeline
// mode" error instead of the generic `DatabaseRef` reserved-syntax
// throw.
//
// See `docs/specs/lookup-stage.md` for the full design, the predicate-
// translation algorithm, and the error catalog.

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
} from "./ast.ts";
import { CodegenError, EMPTY_CTX, generateWithCtx, freshSubPipelineCtx, type GenerateCtx } from "./codegen.ts";
import { closestNameTo } from "./levenshtein.ts";

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
    if (expr.block !== undefined) return walkContainsLookup(expr.block, ctx);
    return false;
  }
  if (expr.type === "ArrayLiteral") {
    for (const el of expr.elements) {
      if (el.type === "SpreadElement") {
        if (walkContainsLookup(el.argument, ctx)) return true;
      } else if (
        walkContainsLookup(el as Expr | UpdateOp | { type: "LetDecl"; name: string; value: Expr; pos: number }, ctx)
      ) {
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
    const suggestion = closestNameTo(expr.method, ["find", "filter"]);
    const hint = suggestion ? ` Did you mean '.${suggestion}'?` : "";
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
type ClassifiedPath = { kind: "local"; segments: string[] } | { kind: "foreign"; segments: string[] };

function classifyPath(expr: Expr, foreignParam: string): ClassifiedPath | null {
  if (expr.type === "FieldRef") return { kind: "local", segments: [expr.path] };
  if (expr.type === "ParamRef" && expr.name === foreignParam) return { kind: "foreign", segments: [] };
  if (expr.type === "MemberAccess") {
    const inner = classifyPath(expr.object, foreignParam);
    if (inner === null) return null;
    return { kind: inner.kind, segments: [...inner.segments, expr.member] };
  }
  if (expr.type === "IndexAccess" && expr.index.type === "StringLiteral") {
    const inner = classifyPath(expr.object, foreignParam);
    if (inner === null) return null;
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
): BasicFormPredicate | PipelineFormPredicate {
  const { lambda } = call;
  const foreignParam = lambda.params[0];

  // ── Expression body ────────────────────────────────────────────────
  if (lambda.body !== undefined) {
    // Try the basic-form fast path.
    const basic = tryBasicForm(lambda.body, foreignParam);
    if (basic !== null) return basic;

    // Fall back to pipeline-form with auto-`let` extraction.
    const { rewritten, letVars } = extractLetsFromExpr(lambda.body, foreignParam);
    const subCtx = makeSubPipelineCtx(outerCtx, Object.keys(letVars));
    const matchBody = generateWithCtx(rewritten, subCtx);
    return { kind: "pipeline", letVars, pipeline: [{ $match: { $expr: matchBody } }] };
  }

  // ── Block body ─────────────────────────────────────────────────────
  if (lambda.block !== undefined) {
    const { rewritten, letVars } = extractLetsFromPipeline(lambda.block, foreignParam);
    const subCtx = makeSubPipelineCtx(outerCtx, Object.keys(letVars));
    const stages = lowerBlock(rewritten, subCtx);
    return { kind: "pipeline", letVars, pipeline: stages };
  }

  throw new CodegenError(
    `.${call.method}(predicate) lambda is missing a body — internal parser bug; please report.`,
    lambda.pos,
  );
}

function makeSubPipelineCtx(outerCtx: GenerateCtx, letVarNames: string[]): GenerateCtx {
  const fresh = freshSubPipelineCtx(outerCtx);
  if (letVarNames.length === 0) return fresh;
  return { ...fresh, lambdaParams: new Set([...fresh.lambdaParams, ...letVarNames]) };
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
function tryBasicForm(body: Expr, foreignParam: string): BasicFormPredicate | null {
  if (body.type !== "BinaryExpr") return null;
  if (body.op !== "===") return null;
  const leftPath = classifyPath(body.left, foreignParam);
  const rightPath = classifyPath(body.right, foreignParam);
  if (leftPath === null || rightPath === null) return null;
  if (
    leftPath.kind === "foreign" &&
    rightPath.kind === "local" &&
    leftPath.segments.length > 0 &&
    rightPath.segments.length > 0
  ) {
    return { kind: "basic", foreignField: leftPath.segments.join("."), localField: rightPath.segments.join(".") };
  }
  if (
    rightPath.kind === "foreign" &&
    leftPath.kind === "local" &&
    rightPath.segments.length > 0 &&
    leftPath.segments.length > 0
  ) {
    return { kind: "basic", foreignField: rightPath.segments.join("."), localField: leftPath.segments.join(".") };
  }
  return null;
}

// ── Let extraction (AST rewriter) ─────────────────────────────────────────────

type LetAllocator = {
  /** Records "userId" → "$userId"; on second call with same path, returns the existing name. */
  allocateForLocalPath: (segments: string[]) => string;
  /** Final mapping for emit into `$lookup.let`. */
  letVars: () => Record<string, string>;
};

function createLetAllocator(): LetAllocator {
  const byPath = new Map<string, string>();
  const used = new Set<string>();
  const out: Record<string, string> = {};
  return {
    allocateForLocalPath(segments: string[]): string {
      const dotted = segments.join(".");
      const existing = byPath.get(dotted);
      if (existing !== undefined) return existing;
      const base = segments[segments.length - 1];
      let name = base;
      let n = 2;
      while (used.has(name)) {
        name = `${base}_${n}`;
        n += 1;
      }
      used.add(name);
      byPath.set(dotted, name);
      out[name] = `$${dotted}`;
      return name;
    },
    letVars: () => out,
  };
}

export function extractLetsFromExpr(
  body: Expr,
  foreignParam: string,
): { rewritten: Expr; letVars: Record<string, string> } {
  const allocator = createLetAllocator();
  const rewritten = transformExpr(body, foreignParam, allocator);
  return { rewritten, letVars: allocator.letVars() };
}

export function extractLetsFromPipeline(
  block: Pipeline,
  foreignParam: string,
): { rewritten: Pipeline; letVars: Record<string, string> } {
  const allocator = createLetAllocator();
  const stmts: PipelineStmt[] = block.stmts.map((s) => transformStmt(s, foreignParam, allocator));
  return { rewritten: { type: "Pipeline", stmts, pos: block.pos }, letVars: allocator.letVars() };
}

function transformStmt(stmt: PipelineStmt, foreignParam: string, allocator: LetAllocator): PipelineStmt {
  if (stmt.type === "LetDecl") {
    return {
      type: "LetDecl",
      name: stmt.name,
      value: transformExpr(stmt.value, foreignParam, allocator),
      pos: stmt.pos,
    };
  }
  if (stmt.type === "UpdateFilter") {
    const ops: UpdateOp[] = stmt.ops.map((op) => {
      if (op.type === "AssignExpr") {
        return {
          type: "AssignExpr",
          target: transformExpr(op.target, foreignParam, allocator),
          value: transformExpr(op.value, foreignParam, allocator),
          pos: op.pos,
        };
      }
      // DeleteStmt
      return { type: "DeleteStmt", target: transformExpr(op.target, foreignParam, allocator), pos: op.pos };
    });
    return { type: "UpdateFilter", ops, pos: stmt.pos };
  }
  return transformExpr(stmt as Expr, foreignParam, allocator);
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
function transformExpr(expr: Expr, foreignParam: string, allocator: LetAllocator): Expr {
  const classified = classifyPath(expr, foreignParam);
  if (classified !== null) {
    if (classified.kind === "local") {
      const letVar = allocator.allocateForLocalPath(classified.segments);
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
  return mapChildren(expr, foreignParam, allocator);
}

function mapChildren(expr: Expr, foreignParam: string, allocator: LetAllocator): Expr {
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
    case "RegexLiteral":
    case "ParamRef":
    case "TypeCastRef":
    case "MathConst":
    case "DateNow":
      return expr;
    case "BinaryExpr":
      return {
        type: "BinaryExpr",
        op: expr.op,
        left: transformExpr(expr.left, foreignParam, allocator),
        right: transformExpr(expr.right, foreignParam, allocator),
        pos: expr.pos,
      };
    case "UnaryExpr":
      return {
        type: "UnaryExpr",
        op: expr.op,
        operand: transformExpr(expr.operand, foreignParam, allocator),
        pos: expr.pos,
      };
    case "TernaryExpr":
      return {
        type: "TernaryExpr",
        condition: transformExpr(expr.condition, foreignParam, allocator),
        consequent: transformExpr(expr.consequent, foreignParam, allocator),
        alternate: transformExpr(expr.alternate, foreignParam, allocator),
        pos: expr.pos,
      };
    case "MemberAccess":
      return {
        type: "MemberAccess",
        object: transformExpr(expr.object, foreignParam, allocator),
        member: expr.member,
        pos: expr.pos,
        ...(expr.optional && { optional: true }),
      };
    case "IndexAccess":
      return {
        type: "IndexAccess",
        object: transformExpr(expr.object, foreignParam, allocator),
        index: transformExpr(expr.index, foreignParam, allocator),
        pos: expr.pos,
        ...(expr.optional && { optional: true }),
      };
    case "MethodCall":
      return {
        type: "MethodCall",
        object: transformExpr(expr.object, foreignParam, allocator),
        method: expr.method,
        args: transformCallArgs(expr.args, foreignParam, allocator),
        pos: expr.pos,
        ...(expr.optional && { optional: true }),
      };
    case "CallExpression":
      return {
        type: "CallExpression",
        callee: transformExpr(expr.callee, foreignParam, allocator),
        args: transformCallArgs(expr.args, foreignParam, allocator),
        pos: expr.pos,
      };
    case "OperatorCall":
      return {
        type: "OperatorCall",
        name: expr.name,
        style: expr.style,
        args: transformCallArgs(expr.args, foreignParam, allocator),
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
          body: transformExpr(expr.body, foreignParam, allocator),
          pos: expr.pos,
        };
      }
      // Block-body in a nested position would be unusual (only the outermost
      // lookup-callback parses a block body). Pass through unchanged.
      return expr;
    case "ArrayLiteral":
      return {
        type: "ArrayLiteral",
        elements: expr.elements.map((el): ArrayElement => {
          if (el.type === "SpreadElement") {
            return {
              type: "SpreadElement",
              argument: transformExpr(el.argument, foreignParam, allocator),
              pos: el.pos,
            };
          }
          if (el.type === "AssignExpr") {
            return {
              type: "AssignExpr",
              target: transformExpr(el.target, foreignParam, allocator),
              value: transformExpr(el.value, foreignParam, allocator),
              pos: el.pos,
            };
          }
          if (el.type === "DeleteStmt") {
            return { type: "DeleteStmt", target: transformExpr(el.target, foreignParam, allocator), pos: el.pos };
          }
          if (el.type === "LetDecl") {
            return {
              type: "LetDecl",
              name: el.name,
              value: transformExpr(el.value, foreignParam, allocator),
              pos: el.pos,
            };
          }
          return transformExpr(el as Expr, foreignParam, allocator);
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
              argument: transformExpr(entry.argument, foreignParam, allocator),
              pos: entry.pos,
            };
          }
          const kv: KeyValueEntry = {
            type: "KeyValueEntry",
            key:
              entry.key.kind === "computed"
                ? { kind: "computed", expr: transformExpr(entry.key.expr, foreignParam, allocator) }
                : entry.key,
            value: transformExpr(entry.value, foreignParam, allocator),
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
        expressions: expr.expressions.map((e) => transformExpr(e, foreignParam, allocator)),
        pos: expr.pos,
      };
    case "TypeofExpr":
      return { type: "TypeofExpr", operand: transformExpr(expr.operand, foreignParam, allocator), pos: expr.pos };
    case "NewDate":
      return { type: "NewDate", args: expr.args.map((a) => transformExpr(a, foreignParam, allocator)), pos: expr.pos };
    case "NewSet":
      return {
        type: "NewSet",
        arg: expr.arg !== null ? transformExpr(expr.arg, foreignParam, allocator) : null,
        pos: expr.pos,
      };
    case "TypeCast":
      return {
        type: "TypeCast",
        cast: expr.cast,
        arg: transformExpr(expr.arg, foreignParam, allocator),
        pos: expr.pos,
      };
    case "MathCall":
      return {
        type: "MathCall",
        method: expr.method,
        args: transformCallArgs(expr.args, foreignParam, allocator),
        pos: expr.pos,
      };
    case "ObjectCall":
      return {
        type: "ObjectCall",
        method: expr.method,
        args: transformCallArgs(expr.args, foreignParam, allocator),
        pos: expr.pos,
      };
    case "ArrayFrom":
      return {
        type: "ArrayFrom",
        input: transformExpr(expr.input, foreignParam, allocator),
        mapFn: expr.mapFn !== null ? transformExpr(expr.mapFn, foreignParam, allocator) : null,
        pos: expr.pos,
      };
    case "NumberStatic":
      return {
        type: "NumberStatic",
        method: expr.method,
        arg: transformExpr(expr.arg, foreignParam, allocator),
        pos: expr.pos,
      };
    case "DateUTC":
      return { type: "DateUTC", args: expr.args.map((a) => transformExpr(a, foreignParam, allocator)), pos: expr.pos };
  }
}

function transformCallArgs(args: CallArg[], foreignParam: string, allocator: LetAllocator): CallArg[] {
  return args.map((a): CallArg => {
    if (a.type === "SpreadElement") {
      return { type: "SpreadElement", argument: transformExpr(a.argument, foreignParam, allocator), pos: a.pos };
    }
    return transformExpr(a, foreignParam, allocator);
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
): object[] {
  rejectNestedLookup(call, outerCtx);
  const pred = translatePredicate(call, outerCtx, lowerBlock);
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
 * Nested lookups inside the predicate of an outer lookup are not
 * materialised here — the outer translator's sub-pipeline lowering runs
 * `containsLookupCall` on its sub-pipeline and rejects with a clear
 * "nested lookup not yet supported" error (plan §5).
 */
export function extractLookupCalls(
  expr: Expr,
  outerCtx: GenerateCtx,
  allocSlot: SlotAllocator,
  lowerBlock: SubPipelineLowerer,
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
      const stages = lowerLookup(innerCall, slot, outerCtx, lowerBlock);
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
      const stages = lowerLookup(innerCall, slot, outerCtx, lowerBlock);
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
    const stages = lowerLookup(direct, slot, outerCtx, lowerBlock);
    return { stages, rewritten: { type: "FieldRef", path: slot, pos: expr.pos } };
  }
  // Otherwise: recurse into children so a lookup buried deeper still
  // materialises. Reuse the AST-mapping pattern but accumulate stages.
  return descendAndExtract(expr, outerCtx, allocSlot, lowerBlock);
}

function descendAndExtract(
  expr: Expr,
  outerCtx: GenerateCtx,
  allocSlot: SlotAllocator,
  lowerBlock: SubPipelineLowerer,
): { stages: object[]; rewritten: Expr } {
  const stages: object[] = [];
  const rewriteChild = (child: Expr): Expr => {
    const r = extractLookupCalls(child, outerCtx, allocSlot, lowerBlock);
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
    case "RegexLiteral":
    case "ParamRef":
    case "TypeCastRef":
    case "MathConst":
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
              return { type: "LetDecl", name: el.name, value: rewriteChild(el.value), pos: el.pos };
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

/**
 * Nested lookups (a `$$$.coll2.find/filter` whose eventual stage would
 * live inside another lookup's sub-pipeline) are planned future work —
 * see `docs/specs/lookup-stage.md` "Future work". The blocker is
 * auto-`let` extraction across two binding scopes (outer-doc `$.x` AND
 * outer-foreign-doc `u.x`); until that lands, the outer lookup's
 * predicate translator catches this case when its sub-pipeline lowering
 * encounters a lookup call inside the block-body or the generated
 * `$match $expr` body — at which point we throw the targeted
 * "not yet supported, hoist to sibling stage" error.
 *
 * Detection is purely structural: at the point we're materialising a
 * lookup, we check whether the lookup's own lambda body contains another
 * lookup. If so, throw.
 */
function rejectNestedLookup(call: LookupCall, ctx: GenerateCtx): void {
  const inner: Expr | Pipeline | undefined = call.lambda.body ?? call.lambda.block;
  if (inner === undefined) return;
  // Pass the outer ctx so a nested lookup with a bound bracket-index
  // (`$$$$[boundDb].coll.find(...)` inside another lookup's predicate)
  // detects correctly. Without the ctx, the binding wouldn't resolve and
  // the inner lookup would silently slip past this gate, then get
  // materialised as an actual nested $lookup later — the exact case the
  // nested-lookup future-work item is planned to handle.
  if (containsLookupCall(inner, ctx)) {
    // Find the inner lookup's pos for a precise error
    const innerPos = findFirstLookupPos(inner) ?? call.lambda.pos;
    throw new CodegenError(
      `Nested lookup ('$$$.<coll>.find/filter' inside another lookup's predicate or pipeline) is not yet supported in this release. ` +
        `Hoist the inner lookup to a sibling stage in the outer pipeline.`,
      innerPos,
    );
  }
}

function findFirstLookupPos(node: Expr | Pipeline | UpdateFilter | PipelineStmt | UpdateOp): number | null {
  if (node.type === "Pipeline") {
    for (const s of node.stmts) {
      const p = findFirstLookupPos(s);
      if (p !== null) return p;
    }
    return null;
  }
  if (node.type === "UpdateFilter") {
    for (const op of node.ops) {
      const p = findFirstLookupPos(op);
      if (p !== null) return p;
    }
    return null;
  }
  if (node.type === "AssignExpr") return findFirstLookupPos(node.value);
  if (node.type === "DeleteStmt") return null;
  if (node.type === "LetDecl") return findFirstLookupPos(node.value);
  // Expr branch
  // findFirstLookupPos only locates a position for the nested-lookup error
  // message; EMPTY_CTX is fine because the surrounding `rejectNestedLookup`
  // already established (via containsLookupCall, same EMPTY_CTX semantics)
  // that a nested lookup is present.
  const direct = detectLookupCall(node, EMPTY_CTX);
  if (direct !== null) return direct.pos;
  // Recurse into common shapes
  const expr = node;
  if (expr.type === "MethodCall") return findFirstLookupPos(expr.object) ?? findFirstInArgs(expr.args);
  if (expr.type === "MemberAccess") return findFirstLookupPos(expr.object);
  if (expr.type === "IndexAccess") return findFirstLookupPos(expr.object) ?? findFirstLookupPos(expr.index);
  if (expr.type === "BinaryExpr") return findFirstLookupPos(expr.left) ?? findFirstLookupPos(expr.right);
  if (expr.type === "UnaryExpr") return findFirstLookupPos(expr.operand);
  if (expr.type === "Lambda") {
    if (expr.body !== undefined) return findFirstLookupPos(expr.body);
    if (expr.block !== undefined) return findFirstLookupPos(expr.block);
  }
  return null;
}

function findFirstInArgs(args: CallArg[]): number | null {
  for (const a of args) {
    if (a.type === "SpreadElement") {
      const p = findFirstLookupPos(a.argument);
      if (p !== null) return p;
    } else {
      const p = findFirstLookupPos(a);
      if (p !== null) return p;
    }
  }
  return null;
}
