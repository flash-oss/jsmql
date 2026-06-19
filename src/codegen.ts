import { lookupOperator } from "./operators.ts";
import { validateOperatorArgs } from "./operator-validation.ts";
import { didYouMean } from "./levenshtein.ts";
import { someExpr } from "./ast-walk.ts";
import { LENGTH_SLOT } from "./namespace.ts";
import { ObjectId } from "./objectid.ts";
import { SET_METHODS } from "./ast.ts";
import type {
  BinaryOp,
  Expr,
  ArrayElement,
  ObjectEntry,
  CallArg,
  SpreadElement,
  KeyValueEntry,
  MathMethod,
  MathConstant,
  ObjectMethod,
  NumberStaticMethod,
  TypeCastOp,
  AssignExpr,
  UpdateOp,
  UpdateFilter,
  ExprBlock,
  Lambda,
  FuncDecl,
} from "./ast.ts";

export class CodegenError extends Error {
  readonly pos: number;
  constructor(message: string, pos: number = 0) {
    super(message);
    this.name = "CodegenError";
    this.pos = pos;
  }
}

/**
 * Throw a `CodegenError` flagged as a jsmql bug. Use for invariants the
 * parser is supposed to uphold — if a user ever sees one of these messages,
 * something has slipped past the parser's validation and we want them to
 * report it. Keeps the wording consistent across every internal-only throw
 * site so they're trivially greppable.
 */
export function internalError(detail: string, pos: number = 0): never {
  throw new CodegenError(`jsmql internal error (please report to the jsmql maintainers): ${detail}`, pos);
}

export class UnknownIdentifierError extends CodegenError {
  identifier: string;
  constructor(identifier: string, pos: number = 0) {
    super(`Unknown identifier '${identifier}'. Did you mean '$.${identifier}'?`, pos);
    this.name = "UnknownIdentifierError";
    this.identifier = identifier;
  }
}

// ── Context ───────────────────────────────────────────────────────────────────

export type GenerateCtx = {
  lambdaParams: ReadonlySet<string>;
  reduceRemap?: ReadonlyMap<string, string>;
  /**
   * Pipeline-scoped `let` bindings in scope. Key is the user-facing name; value
   * is the field-path string to read it back (e.g. `"__jsmql.var.subtotal"` — no
   * leading `$`, that gets prepended at lookup sites). Threaded through
   * pipeline lowering by `pipeline.ts`; ignored in expression-mode codegen.
   */
  pipelineLets?: ReadonlyMap<string, string>;
  /**
   * Subset of `pipelineLets` names that were declared with `const` (not `let`).
   * A `const` binding is read-only: a later `<name> = …` reassignment is
   * rejected, whereas a `let` binding re-`$set`s its slot. Tracked separately so
   * the common read path (`pipelineLets`) is untouched. See
   * docs/specs/let-bindings.md § Reassignment.
   */
  pipelineConstNames?: ReadonlySet<string>;
  /**
   * Names of lets that were dropped by an earlier scope-reshaping stage
   * (`$group`, `$replaceRoot`, …). Value is the stage that dropped them, used
   * to produce a precise "let X can't be read after $group" error rather than
   * the generic "unknown identifier" fallback.
   */
  droppedLets?: ReadonlyMap<string, string>;
  /**
   * Function-form parameter bindings in scope. Key is the destructured binding
   * name; value is the raw JS value supplied at call time (already validated
   * JSON-safe by `validateInterpolatable`). A `ParamRef` whose name lives here
   * emits the value as an inline literal in the MQL output — the same shape
   * the template-tag form produces from `${value}` interpolation. Bindings
   * are *compile-time constants*, not document state, so unlike `pipelineLets`
   * they cross sub-pipeline boundaries; `freshSubPipelineCtx` preserves them.
   */
  bindings?: ReadonlyMap<string, unknown>;
  /**
   * Static type of selected in-scope bindings. Populated by (a) the `.reduce()`
   * codegen when both `initialValue` and the lambda body are statically the
   * same compound type — see the reduce case below; and (b) pipeline `const`
   * declarations whose initializer has a provable static type (`extendCtxLets`
   * via `staticBindingType`). Read by the `IndexAccess` codegen two ways: to
   * skip the runtime `$cond` on `$isArray` when the *receiver* is a `ParamRef`
   * of known compound type, and — when the *key* is a `ParamRef` of type
   * `"string"` — to know `obj[k]` is a property getter (never a numeric array
   * index) and emit `$getField` directly. Keyed by the user-facing param name
   * (pre-`reduceRemap`), so the lookup happens on the raw AST `ParamRef.name`
   * before any MQL variable-name remap.
   */
  bindingTypes?: ReadonlyMap<string, "object" | "array" | "string">;
  /**
   * When true, suppress the auto-`$literal` wrap on `"$..."`-shaped string
   * literals. Set by the `$literal(...)` operator codegen on the recursive
   * call for its argument — the whole subtree is already inside a `$literal`
   * envelope, so MongoDB will not interpret nested strings as field refs and
   * a second wrap would produce a literal of a literal. Propagated through
   * `extendCtx` so it survives lambda bodies and other ctx-modifying paths.
   */
  insideLiteral?: boolean;
  /**
   * When true, suppress the auto-`$literal` wrap on RUNTIME-INJECTED
   * `"$..."`-shaped strings (a pipeline is a paste-raw-MQL surface). Set once at
   * every pipeline-generation entrypoint (`generatePipeline` /
   * `generateImplicitPipeline` / `generatePipelineWithCtx`) and propagated down
   * through all stage bodies, sub-pipelines, and nested operator args. Distinct
   * from `insideLiteral` (which marks a `$literal(...)` envelope); the two are
   * OR-ed in `literalSafeInjectedString` / `safeBoundValue`. Left unset by
   * `jsmql.expr`, where an injected `"$y"` keeps the safety wrap.
   *
   * Note (HR1): source-typed string literals pass through verbatim in EVERY
   * context regardless of this flag — see the `StringLiteral` codegen case.
   * This flag now only gates the injected-value wrap.
   */
  pipelineContext?: boolean;
  /**
   * True only in **top-level pipeline** expression position — set by the two
   * pipeline lowerers in `pipeline.ts` (and preserved by `extendCtx` for
   * same-document lambda bodies, but deliberately dropped by
   * `freshSubPipelineCtx` so sub-pipelines don't inherit it). Gates `$$.length`
   * (the stream-cardinality value): valid only where `pipeline.ts` has
   * materialised `__jsmql.length` ahead of the stage. Absent in `jsmql.expr` /
   * Filter mode and inside any `$lookup`/`$facet`/`$unionWith` sub-pipeline, so
   * `$$.length` there is rejected (see `generateStreamLength`).
   */
  topLevelStream?: boolean;
  /**
   * In-scope sub-stream length handles: the named 3rd callback param of a
   * lookup-chain `.map`/`.filter` (`$$$.<coll>.filter(p).map((o, _i, coll) => …)`)
   * maps to the MQL path its `.length` resolves to. The *current* sub-pipeline
   * level's handle resolves to `"$__jsmql.length"` (a `$setWindowFields` `$count`
   * the lowerer stamps just before the consuming stage); an *ancestor* level's
   * handle resolves to a `$$v<depth>_…` variable the inner `$lookup.let`
   * captured (cross-level passthrough — any nesting depth). Read by
   * `generateLengthAccess` for a `ParamRef` receiver. Propagated by `extendCtx`
   * so nested lambdas inside the body keep the handles in scope.
   * See docs/specs/stream-length.md § sub-pipeline.
   */
  substreamLengthHandles?: ReadonlyMap<string, string>;
  /**
   * The `$lookup.let` variable that holds the ROOT stream's count, when the
   * `$$.length` sigil is used inside a sub-pipeline. Per the design, `$$` is
   * always the ROOT/top-level stream regardless of nesting depth (mirroring
   * `$` = root doc); a lookup whose body reads `$$.length` captures the
   * top-materialised `$__jsmql.length` into its `let` (depth-stamped `v<d>_len`)
   * and sets this so `generateStreamLength` emits `$$<var>` rather than the
   * (wrong) sub-stream `$__jsmql.length` field. Inner sub-stream counts use the
   * named 3rd-arg handle (`substreamLengthHandles`) instead.
   */
  rootStreamLengthVar?: string;
  /**
   * Accumulator context — set by `pipeline.ts` when descending into a `$group`
   * field-value body (other than `_id`) or a `$setWindowFields.output[<key>]`
   * slot. Used by the operator-call codegen to gate operators that only make
   * sense inside one of these contexts:
   *   - `"group"`: accumulator-only operators ($addToSet, $push, $bottom*, etc.)
   *     are allowed; window-only operators ($rank, $denseRank, etc.) are NOT.
   *   - `"window-output"`: BOTH accumulator-only AND window-only operators are
   *     allowed.
   *   - unset / undefined: neither — outside any aggregation accumulator scope.
   */
  accumulatorContext?: "group" | "window-output";
  /**
   * True when codegen is in **aggregation-expression** position — `jsmql.expr`,
   * and every non-`$match` stage body (set in pipeline.ts). It is NOT set in
   * query field-value position (a raw filter / `$match` object), where a
   * comparison operator like `{ $gt: v }` is the valid single-value *query* form.
   * Used only by the operator-arg validator to gate the comparison operators'
   * exact-2 arity: in agg position `$gt($.x)` (1 operand) is a certain error,
   * but `{ age: $gt($.x) }` in a query is valid. Default-off is the HR3-safe
   * direction — a missed agg position just under-validates (the server still
   * rejects it); it never produces a false positive on valid query code.
   */
  aggExpr?: boolean;
  /**
   * Reusable named functions in scope (`const f = (a) => …`). Key is the
   * declared name; value is the parsed declaration. A `CallExpression` whose
   * callee is a `ParamRef` naming one of these expands the body INLINE at the
   * call site as an IIFE → `$let` (re-lowered per call, never hoisted). Like
   * `pipelineLets` they are pipeline-scoped: `freshSubPipelineCtx` drops them
   * (they don't cross into `$lookup`/`$unionWith` sub-pipelines) and
   * `freshFacetCtx` preserves them. See docs/specs/reusable-functions.md.
   */
  functions?: ReadonlyMap<string, FuncDecl>;
  /**
   * Names of functions currently mid-expansion (the inline-expansion stack).
   * A call to a name already on the stack is direct/mutual recursion, which a
   * MongoDB expression can't represent — rejected with a precise error rather
   * than looping forever. See docs/specs/reusable-functions.md § Recursion.
   */
  expandingFns?: ReadonlySet<string>;
  /**
   * Set while lowering a `$lookup` sub-pipeline **block body**, so a nested
   * `$$$.<coll>.find/filter(...)` appearing as a statement (or inside a stage
   * body) within that block knows its enclosing-lookup context — the same
   * `foreignParams` / `inScopeLetNames` the expression-body path threads
   * directly. The lookup-translation entry points (`lowerLookup` /
   * `extractLookupCalls` / `translatePredicate` / `buildPipelineFormPredicate`)
   * read it when no explicit `enclosing` argument is passed; `lowerBlock` is the
   * only carrier because block lowering runs through `generateImplicitPipeline`,
   * which has no `enclosing` parameter. Structurally identical to
   * `EnclosingLookupContext` in lookup-translation.ts (kept inline here to avoid
   * a type import cycle). `freshSubPipelineCtx` drops it — each lookup re-seeds
   * its own. See docs/specs/lookup-stage.md § Nested lookups.
   */
  enclosingLookup?: { foreignParams: ReadonlyArray<string>; inScopeLetNames: ReadonlySet<string> };
};

const EMPTY_CTX: GenerateCtx = { lambdaParams: new Set() };

function extendCtx(ctx: GenerateCtx, params: string[]): GenerateCtx {
  return {
    lambdaParams: new Set([...ctx.lambdaParams, ...params]),
    reduceRemap: ctx.reduceRemap,
    pipelineLets: ctx.pipelineLets,
    pipelineConstNames: ctx.pipelineConstNames,
    droppedLets: ctx.droppedLets,
    bindings: ctx.bindings,
    bindingTypes: ctx.bindingTypes,
    insideLiteral: ctx.insideLiteral,
    pipelineContext: ctx.pipelineContext,
    topLevelStream: ctx.topLevelStream,
    substreamLengthHandles: ctx.substreamLengthHandles,
    rootStreamLengthVar: ctx.rootStreamLengthVar,
    accumulatorContext: ctx.accumulatorContext,
    aggExpr: ctx.aggExpr,
    functions: ctx.functions,
    expandingFns: ctx.expandingFns,
  };
}

/**
 * `extendCtx` for an array-method lambda, additionally typing the lambda's
 * *element* parameter (`params[0]`) from the input array's static element type
 * (`arrayElementType`). This lets `element[k]` / a provably-string element key
 * lower precisely — e.g. `["sender","recipient"].map(p => $.x[p])` emits
 * `$getField` directly instead of the runtime `$isArray` guard whose dead
 * `$arrayElemAt`-with-string-index branch some servers reject. Mirrors the
 * reduce-accumulator narrowing. Any lambda param shadowing an outer same-named
 * binding has that stale type cleared (the index param `params[1]` is a number,
 * never the element type, so it is only ever cleared — never set).
 */
function elementTypedCtx(ctx: GenerateCtx, params: string[], inputExpr: Expr | undefined): GenerateCtx {
  const base = extendCtx(ctx, params);
  if (params.length === 0) return base;
  const elementType = inputExpr ? arrayElementType(inputExpr) : undefined;
  const shadows = params.some((p) => ctx.bindingTypes?.has(p));
  if (!elementType && !shadows) return base;
  const bindingTypes = new Map(ctx.bindingTypes ?? []);
  for (const p of params) bindingTypes.delete(p);
  if (elementType) bindingTypes.set(params[0], elementType);
  return { ...base, bindingTypes };
}

/**
 * Add a new pipeline let to the context. Returns a fresh ctx; never mutates.
 * `kind: "const"` also records the name as read-only (reassignment rejected).
 */
export function extendCtxLets(
  ctx: GenerateCtx,
  name: string,
  fieldPath: string,
  kind: "let" | "const" = "let",
  type?: "object" | "array" | "string",
): GenerateCtx {
  const next = new Map(ctx.pipelineLets ?? []);
  next.set(name, fieldPath);
  // Record the binding's static type only for `const`: it is read-only, so the
  // type can't drift via a later `<name> = …` reassignment (a `let` can, so we
  // leave `let` untracked and it keeps the conservative runtime dispatch).
  let bindingTypes = ctx.bindingTypes;
  if (kind === "const" && type) {
    const bt = new Map(ctx.bindingTypes ?? []);
    bt.set(name, type);
    bindingTypes = bt;
  }
  if (kind !== "const") return { ...ctx, pipelineLets: next, bindingTypes };
  const consts = new Set(ctx.pipelineConstNames ?? []);
  consts.add(name);
  return { ...ctx, pipelineLets: next, pipelineConstNames: consts, bindingTypes };
}

/** Drop all pipeline lets, moving them to `droppedLets` with the stage name. */
export function clearCtxLets(ctx: GenerateCtx, droppedByStage: string): GenerateCtx {
  if (!ctx.pipelineLets || ctx.pipelineLets.size === 0) return ctx;
  const dropped = new Map(ctx.droppedLets ?? []);
  for (const name of ctx.pipelineLets.keys()) dropped.set(name, droppedByStage);
  return { ...ctx, pipelineLets: new Map(), pipelineConstNames: new Set(), droppedLets: dropped };
}

/** Public access for pipeline.ts to read the let-bindings count. */
export function ctxHasLets(ctx: GenerateCtx): boolean {
  return (ctx.pipelineLets?.size ?? 0) > 0;
}

/**
 * Construct a fresh ctx for sub-pipeline lowering. Outer `let` bindings do NOT
 * cross — they're per-document state and the sub-pipeline starts against a
 * different document (e.g. `$lookup.pipeline` runs against the foreign
 * collection). Function-form `bindings` DO cross: they are compile-time
 * constants, not document state, and inlining them inside a sub-pipeline is
 * the same shape as the user writing the literal there directly. Reusable
 * named functions (`functions`) do NOT cross — they are pipeline-scoped like
 * `let`s; a sub-pipeline declares and uses its own.
 */
export function freshSubPipelineCtx(outer: GenerateCtx): GenerateCtx {
  return { lambdaParams: new Set(), bindings: outer.bindings, pipelineContext: outer.pipelineContext };
}

/**
 * Construct a sub-pipeline ctx that PRESERVES outer pipeline lets — used by
 * `$facet` branches. Unlike `$lookup.pipeline` / `$unionWith.pipeline`
 * (which operate on a different document set), every facet branch operates
 * on the SAME input docs that arrived at the outer pipeline's $facet stage.
 * Those docs still carry the `__jsmql.var.<name>` fields the outer lets
 * materialised into, so `$__jsmql.var.<name>` references inside the branch
 * resolve correctly.
 */
export function freshFacetCtx(outer: GenerateCtx): GenerateCtx {
  return {
    lambdaParams: new Set(),
    bindings: outer.bindings,
    pipelineLets: outer.pipelineLets,
    pipelineConstNames: outer.pipelineConstNames,
    bindingTypes: outer.bindingTypes,
    pipelineContext: outer.pipelineContext,
    // Functions declared before the $facet are visible inside its branches,
    // mirroring the outer-lets rule above.
    functions: outer.functions,
    expandingFns: outer.expandingFns,
  };
}

/**
 * Register a reusable named function. Returns a fresh ctx; never mutates. Used
 * by pipeline.ts when a `const f = (a) => …` declaration is reached. Collision
 * checks (re-declaration, name clash with a `let`/binding) live at the call
 * site (pipeline.ts `lowerFuncDecl`), mirroring `extendCtxLets` / `lowerLetDecl`.
 */
export function extendCtxFunctions(ctx: GenerateCtx, decl: FuncDecl): GenerateCtx {
  const next = new Map(ctx.functions ?? []);
  next.set(decl.name, decl);
  return { ...ctx, functions: next };
}

/** Predicate: is `name` a reusable-function binding in scope? */
export function ctxHasFunction(ctx: GenerateCtx, name: string): boolean {
  return ctx.functions?.has(name) ?? false;
}

/** Return a fresh ctx with the given function-form parameter bindings applied. */
export function withBindings(ctx: GenerateCtx, bindings: ReadonlyMap<string, unknown>): GenerateCtx {
  return { ...ctx, bindings };
}

/** Public re-export of EMPTY_CTX for pipeline.ts. */
export { EMPTY_CTX };

// ── String-producing helpers ──────────────────────────────────────────────────

// Operators whose return type is always a string — used for string-context + inference.
const STRING_OUTPUT_OPS = new Set([
  "$toLower",
  "$toUpper",
  "$trim",
  "$ltrim",
  "$rtrim",
  "$concat",
  "$substrCP",
  "$substrBytes",
  "$substr",
  "$replaceOne",
  "$replaceAll",
  "$dateToString",
  "$type",
  "$strcasecmp",
  "$toString",
]);

// ── JS-method metadata registry ───────────────────────────────────────────────
//
// Single source of truth for every JS method jsmql recognises. The lowering for
// each method still lives in its `case` in generateMethodCall (the dispatch is
// the switch); this table holds the *metadata* that several inference passes
// read — return type and optional-chaining receiver type — plus the full name
// list that powers "did you mean?" suggestions. Adding a method is one entry
// here (for its inference behaviour) plus its `case`, instead of editing up to
// three separate Sets scattered across the file.
//
//   returns:  the method's result type, when invariant — feeds isStringProducing
//             / isArrayProducing / isProvablyBool. Omitted when the result type
//             depends on the receiver/args (e.g. `.slice`, `.concat`, `.at`).
//   optional: the receiver's type, picking the `$ifNull` neutral when a `?.`
//             chain feeds the receiver — "string" → "", "array" → [], "either" →
//             runtime/branch-aware (see neutralForMethod). Omitted for methods
//             whose underlying operator handles null cleanly (date/set/regex).
type MethodReturn = "string" | "array" | "bool";
type MethodOptional = "string" | "array" | "either";
type MethodMeta = { returns?: MethodReturn; optional?: MethodOptional };

const METHODS: Record<string, MethodMeta> = {
  // ── String ────────────────────────────────────────────────────────────────
  trim: { returns: "string", optional: "string" },
  trimStart: { returns: "string", optional: "string" },
  trimLeft: { returns: "string", optional: "string" },
  trimEnd: { returns: "string", optional: "string" },
  trimRight: { returns: "string", optional: "string" },
  toLowerCase: { returns: "string", optional: "string" },
  toUpperCase: { returns: "string", optional: "string" },
  substr: { returns: "string", optional: "string" },
  substring: { returns: "string", optional: "string" },
  charAt: { returns: "string", optional: "string" },
  split: { returns: "array", optional: "string" }, // returns an array, but the receiver is a string
  startsWith: { returns: "bool", optional: "string" },
  endsWith: { returns: "bool", optional: "string" },
  replace: { returns: "string", optional: "string" },
  replaceAll: { returns: "string", optional: "string" },
  match: { optional: "string" },
  matchAll: { optional: "string" },
  search: { optional: "string" },
  padStart: { returns: "string", optional: "string" },
  padEnd: { returns: "string", optional: "string" },
  repeat: { returns: "string", optional: "string" },
  indexOf: { optional: "either" },
  includes: { returns: "bool", optional: "either" },
  // ── Array ─────────────────────────────────────────────────────────────────
  at: { optional: "array" },
  slice: { optional: "either" },
  concat: { optional: "either" },
  reverse: { returns: "array", optional: "array" }, // throws in expression position; metadata used by the statement-position rewrite
  toReversed: { returns: "array", optional: "array" },
  toSorted: { returns: "array", optional: "array" },
  toSpliced: { returns: "array" },
  with: { returns: "array" },
  flat: { returns: "array", optional: "array" },
  flatMap: { returns: "array", optional: "array" },
  map: { returns: "array", optional: "array" },
  filter: { returns: "array", optional: "array" },
  find: { optional: "array" },
  findIndex: {},
  findLast: { optional: "array" },
  findLastIndex: { optional: "array" },
  lastIndexOf: {},
  some: { returns: "bool", optional: "array" },
  every: { returns: "bool", optional: "array" },
  reduce: { optional: "array" },
  reduceRight: {},
  join: { returns: "string", optional: "array" }, // returns a string, but the receiver is an array
  toString: {},
  // ── Mutators (shimmed with tailored errors that point at immutable variants) ─
  sort: {},
  splice: {},
  push: {},
  pop: {},
  shift: {},
  unshift: {},
  fill: {},
  copyWithin: {},
  // ── Iterator / void / locale (shimmed with tailored errors) ─────────────────
  forEach: {},
  entries: {},
  keys: {},
  values: {},
  toLocaleString: {},
  // ── Date ────────────────────────────────────────────────────────────────────
  getFullYear: {},
  getMonth: {},
  getDate: {},
  getDay: {},
  getHours: {},
  getMinutes: {},
  getSeconds: {},
  getMilliseconds: {},
  getTime: {},
  toISOString: { returns: "string" },
  // ── Set (intercepted before generateMethodCall when the receiver is a NewSet,
  //    but listed so a typo on a non-NewSet receiver still surfaces a suggestion) ─
  intersection: {},
  union: {},
  difference: {},
  isSubsetOf: {},
  isSupersetOf: {},
  // ── Regex (intercepted on RegexLiteral receivers; same rationale) ───────────
  test: {},
  exec: {},
};

function methodsWhere(pred: (m: MethodMeta) => boolean): ReadonlySet<string> {
  return new Set(Object.keys(METHODS).filter((name) => pred(METHODS[name])));
}

// Method names that always return a string / array / boolean — derived from METHODS.
const STRING_RETURNING_METHODS = methodsWhere((m) => m.returns === "string");

// ── Array-producing helpers ───────────────────────────────────────────────────

// Operators whose return type is always an array
const ARRAY_OUTPUT_OPS = new Set([
  "$split",
  "$range",
  "$reverseArray",
  "$slice",
  "$map",
  "$filter",
  "$concatArrays",
  "$setUnion",
  "$setIntersection",
  "$setDifference",
  "$zip",
  "$objectToArray",
]);

// Method names that always return an array — derived from METHODS.
const ARRAY_RETURNING_METHODS = methodsWhere((m) => m.returns === "array");

function isArrayProducing(expr: Expr): boolean {
  switch (expr.type) {
    case "ArrayLiteral":
      return true;
    case "OperatorCall":
      return ARRAY_OUTPUT_OPS.has(expr.name);
    case "MethodCall":
      // `.slice` preserves receiver type — array→array, string→string.
      if (expr.method === "slice") return isArrayProducing(expr.object);
      return ARRAY_RETURNING_METHODS.has(expr.method);
    case "ObjectCall":
      return expr.method === "entries" || expr.method === "keys" || expr.method === "values";
    default:
      return false;
  }
}

function isObjectProducing(expr: Expr): boolean {
  return expr.type === "ObjectLiteral";
}

/**
 * The provable static type of an expression, or `undefined` when it can't be
 * pinned at compile time. Used by `pipeline.ts` to type `const` bindings so the
 * `IndexAccess` codegen can resolve `obj[k]` precisely (see `bindingTypes`).
 */
export function staticBindingType(expr: Expr): "object" | "array" | "string" | undefined {
  if (isArrayProducing(expr)) return "array";
  if (isObjectProducing(expr)) return "object";
  if (isStringProducing(expr)) return "string";
  return undefined;
}

/**
 * The provable static type of the *elements* of an array-valued expression,
 * when uniform — so a lambda iterating it (`arr.map(x => …)`) can type its
 * element parameter the way `.reduce()` already types its accumulator and the
 * pipeline types a `const`. `["a","b"]` → `"string"`, `[[1],[2]]` → `"array"`,
 * `[{},{}]` → `"object"`; `$.csv.split(",")` and `Object.keys(o)` → `"string"`.
 * Mixed-type, empty, spread-bearing, or otherwise-unknown inputs → `undefined`,
 * leaving the `IndexAccess` dispatch conservative (the runtime `$isArray` guard).
 */
function arrayElementType(expr: Expr): "object" | "array" | "string" | undefined {
  switch (expr.type) {
    case "ArrayLiteral": {
      let elementType: "object" | "array" | "string" | undefined;
      for (const el of expr.elements) {
        // Only plain value elements carry a static type; a spread or a
        // pipeline-only statement node leaves the element set open-ended.
        if (
          el.type === "SpreadElement" ||
          el.type === "AssignExpr" ||
          el.type === "DeleteStmt" ||
          el.type === "LetDecl" ||
          el.type === "FuncDecl"
        ) {
          return undefined;
        }
        const t = staticBindingType(el);
        if (t === undefined) return undefined;
        if (elementType === undefined) elementType = t;
        else if (elementType !== t) return undefined;
      }
      return elementType; // undefined for `[]` (no elements to type)
    }
    case "MethodCall":
      // String.prototype.split always yields a string[].
      return expr.method === "split" ? "string" : undefined;
    case "ObjectCall":
      // Object.keys → array of field-name strings.
      return expr.method === "keys" ? "string" : undefined;
    default:
      return undefined;
  }
}

function isStringProducing(expr: Expr): boolean {
  switch (expr.type) {
    case "StringLiteral":
      return true;
    case "TemplateLiteral":
      return true;
    case "OperatorCall":
      return STRING_OUTPUT_OPS.has(expr.name);
    case "MethodCall":
      // `.slice` preserves receiver type — array→array, string→string.
      if (expr.method === "slice") return isStringProducing(expr.object);
      return STRING_RETURNING_METHODS.has(expr.method);
    case "TypeCast":
      return expr.cast === "String";
    case "TypeofExpr":
      return true;
    case "BinaryExpr":
      if (expr.op === "+") {
        const chain: Expr[] = [];
        collectExprChain("+", expr, chain);
        return chain.some((e) => isStringProducing(e));
      }
      return false;
    default:
      return false;
  }
}

// ── JS truthy/falsy semantics ─────────────────────────────────────────────────
//
// JavaScript treats `false`, `null`, `undefined`, `0`, `""`, and `NaN` as
// falsy; everything else (including `[]` and `{}`) is truthy. MongoDB's
// $cond/$and/$or/$not/$toBool use a different rule (e.g. `""` is truthy in
// MQL). To make `&&`, `||`, `!`, `?:`, `Boolean()`, and predicate-method
// bodies match the JS semantics users expect, we wrap operands in `jsBool`.
//
// NaN: detecting NaN in MongoDB is expensive (its $eq treats NaN==NaN as
// true, so `$ne:[x,x]` does not work). NaN values are vanishingly rare in
// MongoDB collections, so we accept this divergence and document it.

// Operators whose return type is always a boolean — used to elide the jsBool
// wrap when an operand is already a boolean.
const BOOL_OUTPUT_OPS = new Set([
  "$eq",
  "$ne",
  "$gt",
  "$gte",
  "$lt",
  "$lte",
  "$and",
  "$or",
  "$not",
  "$in",
  "$regexMatch",
  "$isNumber",
  "$isArray",
  "$allElementsTrue",
  "$anyElementTrue",
  "$setEquals",
  "$setIsSubset",
]);

// Method names whose codegen always emits a boolean — derived from METHODS.
const BOOL_RETURNING_METHODS = methodsWhere((m) => m.returns === "bool");

/** True if the AST node always compiles to an MQL expression that evaluates
 *  to a boolean. When true we skip the jsBool wrap. */
function isProvablyBool(expr: Expr): boolean {
  switch (expr.type) {
    case "BooleanLiteral":
      return true;
    case "UnaryExpr":
      return expr.op === "!";
    case "BinaryExpr":
      switch (expr.op) {
        case "==":
        case "===":
        case "!=":
        case "!==":
        case "<":
        case "<=":
        case ">":
        case ">=":
        case "in":
          return true;
        case "&&":
        case "||":
          // JS `&&`/`||` are operand-preserving, so they're bool only when
          // every operand is bool. Recurse — this matches the chain-level
          // optimization in `generateLogical` which emits `$and`/`$or`
          // (a bool) for all-bool chains.
          return isProvablyBool(expr.left) && isProvablyBool(expr.right);
        default:
          return false;
      }
    case "TypeCast":
      return expr.cast === "Boolean";
    case "OperatorCall":
      return BOOL_OUTPUT_OPS.has(expr.name);
    case "MethodCall":
      return BOOL_RETURNING_METHODS.has(expr.method);
    default:
      return false;
  }
}

/** Wrap an already-generated MQL expression in a JS-truthy check.
 *  Returns true iff `value` is truthy under JS rules (false, null, missing,
 *  0, "" → false; everything else → true; NaN treated as truthy — see note). */
function jsBool(value: unknown): unknown {
  return {
    $and: [
      // Catches both `null` and *missing*. A bare `$ne: [value, null]` does NOT
      // catch missing — MongoDB's `$eq`/`$ne` treat a missing value as distinct
      // from null (`$eq: ["$absent", null]` is false), so `arr.filter(x => x.f)`
      // would wrongly keep elements where `f` is absent. `$ifNull` collapses
      // missing → null first, matching JS where `undefined` is falsy. The other
      // three clauses compare the raw value (false/""/0 are never "missing").
      { $ne: [{ $ifNull: [value, null] }, null] },
      { $ne: [value, false] },
      { $ne: [value, ""] },
      { $ne: [value, 0] },
    ],
  };
}

/** jsBool around a generated value, but elide if the source AST is already
 *  provably boolean. The AST is needed to do the elision check; the generated
 *  value is what gets emitted. Pass them both for the common case where
 *  callers have already invoked _generate(). */
function jsBoolIfNeeded(srcExpr: Expr, generated: unknown): unknown {
  return isProvablyBool(srcExpr) ? generated : jsBool(generated);
}

/** True if `expr` resolves to a stable field/param/path (no computation,
 *  no side-effects, free to reference twice). Used by `&&`/`||` to decide
 *  whether the operand-preserving codegen needs a `$let` to bind once. */
function isPureRef(expr: Expr, ctx: GenerateCtx): boolean {
  return asFieldPath(expr, ctx) !== null;
}

/**
 * MongoDB user-variable names (a `$let`/`$map`/`$filter` `as` or `vars` key,
 * referenced as `$$name`) must begin with a lowercase ASCII letter `[a-z]` (or a
 * non-ASCII character). Names starting with `_`, `$`, a digit, or an uppercase
 * letter are reserved/invalid and the server rejects the whole pipeline
 * ("'…' starts with an invalid character for a user variable name"). User lambda
 * params (the idiomatic throwaway `_` in `(_, i) => …`) routinely hit this.
 * (`$lookup.let` names take a different route — `letVarName` in
 * lookup-translation.ts stamps a `v<depth>_` prefix for cross-level uniqueness.)
 *
 * Deterministic and idempotent: valid names are returned unchanged (so the
 * overwhelmingly common case produces identical output), and an invalid name
 * gets a `v` lead-in (`_id` → `v_id`, `_` → `v_`, `ID` → `vID`). Because it is a
 * pure function, the emission site (the `as`/`vars` key) and every reference
 * site (`$$name`) can call it independently and always agree — no remap table
 * needs threading through the context.
 */
export function safeVarName(name: string): string {
  return /^[a-z]/.test(name) ? name : "v" + name;
}

/**
 * Map a JS regex's flags to the subset MongoDB's `$regex*` operators accept as
 * `options`. MongoDB supports only `i`, `m`, `s`, `x`; the JS-only flags
 * (`g`, `u`, `y`, `d`, `v`) are not valid `options` and make the server reject
 * the pipeline ("invalid flag in regex options"). `g` is implied by
 * `$regexFindAll` and irrelevant to `$regexMatch`/`$regexFind`, so dropping it
 * preserves semantics; the rarer `u`/`y`/`d`/`v` have no MQL equivalent and are
 * dropped too. Returns "" when nothing survives (the caller then omits
 * `options` entirely).
 */
function mongoRegexOptions(jsFlags: string): string {
  let out = "";
  for (const ch of jsFlags) if ("imsx".includes(ch) && !out.includes(ch)) out += ch;
  return out;
}

/** Pick a $let binding name that doesn't shadow any in-scope lambda param. */
function gensymInScope(ctx: GenerateCtx, base: string): string {
  if (!ctx.lambdaParams.has(base)) return base;
  for (let i = 2; ; i++) {
    const name = `${base}${i}`;
    if (!ctx.lambdaParams.has(name)) return name;
  }
}

/**
 * Clamp a string-index AST node to non-negative, matching JS `.substring`
 * semantics where negative arguments are treated as 0. Folds at compile time
 * when the node is a literal number (or unary-minus of one); otherwise wraps
 * the generated value in `$max:[0, …]` so the runtime sees a non-negative
 * index.
 */
function clampNonNegativeIndex(node: Expr, ctx: GenerateCtx): unknown {
  if (node.type === "NumberLiteral") return Math.max(0, node.value);
  if (node.type === "UnaryExpr" && node.op === "-" && node.operand.type === "NumberLiteral") {
    return Math.max(0, -node.operand.value);
  }
  return { $max: [0, _generate(node, ctx)] };
}

/** Clamp a derived length value to non-negative, folding when known. */
function clampNonNegativeLength(value: unknown): unknown {
  if (typeof value === "number") return Math.max(0, value);
  return { $max: [0, value] };
}

/** Subtract `b` from `a`, folding when both operands are numeric literals. */
function foldedSubtract(a: unknown, b: unknown): unknown {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return { $subtract: [a, b] };
}

/**
 * Emit a `$cond` in MongoDB's object form `{ if, then, else }` rather than the
 * positional array `[if, then, else]`. Both are valid MQL, but the named-key
 * form is far easier to read in emitted output — a DX win for anyone inspecting
 * what jsmql produced. Every internal `$cond` jsmql emits goes through here.
 */
function cond(
  ifExpr: unknown,
  thenExpr: unknown,
  elseExpr: unknown,
): { $cond: { if: unknown; then: unknown; else: unknown } } {
  return { $cond: { if: ifExpr, then: thenExpr, else: elseExpr } };
}

/**
 * Normalise a JS-style `.slice` index against a string length. JS treats
 * negative indices as `len + idx`; MQL `$substrCP` rejects negatives. Folds
 * literal negatives into `$strLenCP - n` at compile time; non-literals expand
 * to a `$cond` that picks the form at runtime.
 *
 * `genObj` is reused for `$strLenCP` rather than re-generating from the
 * source AST, so callers should pass the same generated value they use in
 * the surrounding `$substrCP` call.
 */
function normaliseSliceIndex(node: Expr, ctx: GenerateCtx, genObj: unknown): unknown {
  if (node.type === "NumberLiteral") {
    if (node.value >= 0) return node.value;
    return foldedSubtract({ $strLenCP: genObj }, -node.value);
  }
  if (node.type === "UnaryExpr" && node.op === "-" && node.operand.type === "NumberLiteral") {
    return foldedSubtract({ $strLenCP: genObj }, node.operand.value);
  }
  const gen = _generate(node, ctx);
  return cond({ $lt: [gen, 0] }, { $add: [gen, { $strLenCP: genObj }] }, gen);
}

/** Lower `.slice` on a known-array (or fallback) receiver to MQL `$slice`. */
function sliceArray(genObj: unknown, exprArgs: Expr[], ctx: GenerateCtx): unknown {
  if (exprArgs.length === 0) return genObj;
  if (exprArgs.length === 1) return { $slice: [genObj, _generate(exprArgs[0], ctx)] };
  return { $slice: [genObj, _generate(exprArgs[0], ctx), _generate(exprArgs[1], ctx)] };
}

/** Lower `.slice` on a known-string receiver to MQL `$substrCP`. */
function sliceString(genObj: unknown, exprArgs: Expr[], ctx: GenerateCtx): unknown {
  if (exprArgs.length === 0) return genObj;
  const start = normaliseSliceIndex(exprArgs[0], ctx, genObj);
  if (exprArgs.length === 1) {
    // For 1-arg `.slice(-n)` on a string, the length is exactly `n` (JS
    // returns the last n characters). Fold that case so the output isn't
    // a noisy `strLen - (strLen - n)`.
    const negativeLiteral = negativeLiteralValue(exprArgs[0]);
    if (negativeLiteral !== null) return { $substrCP: [genObj, start, negativeLiteral] };
    return { $substrCP: [genObj, start, foldedSubtract({ $strLenCP: genObj }, start)] };
  }
  const end = normaliseSliceIndex(exprArgs[1], ctx, genObj);
  return { $substrCP: [genObj, start, clampNonNegativeLength(foldedSubtract(end, start))] };
}

/** Return the absolute value of a negative numeric literal AST node, else null. */
function negativeLiteralValue(node: Expr): number | null {
  if (node.type === "NumberLiteral" && node.value < 0) return -node.value;
  if (node.type === "UnaryExpr" && node.op === "-" && node.operand.type === "NumberLiteral" && node.operand.value > 0) {
    return node.operand.value;
  }
  return null;
}

/**
 * Auto-wrap a RUNTIME-INJECTED string in `$literal` when MongoDB would misread
 * it as a field reference / system variable. This is HR1's only exception: a
 * `"$x"` typed in jsmql *source* passes through verbatim (it IS the field ref —
 * see the `StringLiteral` codegen case), but a `"$x"` arriving as a
 * `jsmql.compile` param or template-tag `${…}` is untrusted input we must not
 * let silently become a field reference, so we wrap it in expression position.
 *
 * Suppressed when `ctx.insideLiteral` is set (already inside a `$literal(...)`
 * envelope — a second wrap would produce a literal-of-a-literal) or when
 * `ctx.pipelineContext` is set (a pipeline is a paste-raw-MQL surface).
 */
function literalSafeInjectedString(value: string, ctx: GenerateCtx): unknown {
  if (ctx.insideLiteral || ctx.pipelineContext) return value;
  if (value.length > 0 && value.charCodeAt(0) === 36 /* $ */) {
    return { $literal: value };
  }
  return value;
}

/**
 * Apply the `$literal` safety net to a `jsmql.compile`/template-tag bound
 * value: any `"$..."`-shaped string, at any nesting depth, gets wrapped so
 * MongoDB doesn't read injected input as a field ref at runtime (HR1's
 * runtime-injected exception). Plain objects and arrays recurse; primitives
 * pass through.
 *
 * `validateInterpolatable` has already rejected functions, symbols, BigInt,
 * non-finite numbers, and circular references, so this walker only needs to
 * handle JSON-shaped data — and opaque BSON instances (Date, RegExp,
 * Uint8Array, ObjectId), which are passed through unchanged because they're
 * the very values MongoDB's driver expects in-situ; walking them with
 * `Object.entries` would silently strip them to `{}`.
 */
function safeBoundValue(value: unknown, ctx: GenerateCtx): unknown {
  if (ctx.insideLiteral || ctx.pipelineContext) return value;
  if (typeof value === "string") return literalSafeInjectedString(value, ctx);
  if (isOpaqueBsonValue(value)) return value;
  if (Array.isArray(value)) return value.map((v) => safeBoundValue(v, ctx));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = safeBoundValue(v, ctx);
    }
    return out;
  }
  return value;
}

/**
 * BSON instance values that the MongoDB driver consumes in-situ (i.e. the
 * driver expects the actual JS object, not a JSON-shaped surrogate). They
 * have no fidelity-preserving JSON representation: `JSON.stringify` returns
 * `"{}"` for `RegExp` and `Uint8Array`, an ISO string for `Date` (which
 * compares as a string in BSON, not a date), and `{}` for ObjectId.
 *
 * ObjectId is detected by `_bsontype` because importing the MongoDB driver
 * would add a hard dependency the library deliberately avoids; the BSON
 * library tags instances with `"ObjectID"` (older versions) or `"ObjectId"`
 * (newer versions). Accept both.
 */
export function isOpaqueBsonValue(value: unknown): boolean {
  if (value instanceof Date) return true;
  if (value instanceof RegExp) return true;
  if (value instanceof Uint8Array) return true;
  if (typeof value === "object" && value !== null) {
    const tag = (value as { _bsontype?: unknown })._bsontype;
    if (tag === "ObjectID" || tag === "ObjectId") return true;
  }
  return false;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function generate(expr: Expr): unknown {
  return _generate(expr, EMPTY_CTX);
}

/** Generate an expression with an explicit context (e.g. pipeline-let bindings). */
export function generateWithCtx(expr: Expr, ctx: GenerateCtx): unknown {
  return _generate(expr, ctx);
}

// ── Core generator ────────────────────────────────────────────────────────────

function _generate(expr: Expr, ctx: GenerateCtx): unknown {
  return _generateBody(expr, ctx);
}

function _generateBody(expr: Expr, ctx: GenerateCtx): unknown {
  // Defensive: parseGrouped may surface an AssignExpr through this path when
  // it sees `($.x = expr)` — a parenthesized assignment. AssignExpr is not in
  // the Expr union, but the cast in parseGrouped lets it flow here. Reject
  // with a clear message so users debugging `1 + ($.a = 5)` see what's wrong.
  const dynType = (expr as unknown as { type: string }).type;
  if (dynType === "AssignExpr" || dynType === "DeleteStmt") {
    throw new CodegenError(
      `${dynType === "AssignExpr" ? "Assignment" : "delete"} is a statement, not a value. ` +
        `It is only valid at the top level or as a pipeline-array element.`,
      expr.pos,
    );
  }
  if (dynType === "LetDecl") {
    throw new CodegenError(
      "`let` is a pipeline statement, not a value. " + "It is only valid at the top level of a pipeline.",
      expr.pos,
    );
  }
  if (dynType === "FuncDecl") {
    throw new CodegenError(
      "A function declaration is a pipeline statement, not a value. " +
        "Declare `const f = (…) => …` at the top level of a pipeline, then call `f(...)`.",
      expr.pos,
    );
  }
  switch (expr.type) {
    case "NumberLiteral":
      return expr.value;
    case "BigIntLiteral":
      return { $toLong: expr.value };
    case "StringLiteral":
      // HR1: a `"$x"` string typed in source IS the MQL field ref `$x`, in every
      // context — it passes through verbatim, jsmql adds no `$literal` of its own.
      // (Runtime-INJECTED values get the safety wrap; see `safeBoundValue`.)
      return expr.value;
    case "BooleanLiteral":
      return expr.value;
    case "NullLiteral":
      return null;
    case "UndefinedLiteral":
      // MongoDB's aggregation expression language has no way to distinguish
      // "missing field" from "field present with null value" — `$eq` against
      // missing returns true for both. `undefined` only carries non-redundant
      // meaning in `$match` position (where it lowers to `$exists`); in any
      // expression position it's ambiguous, so we surface an actionable error
      // rather than silently lowering to `null`.
      throw new CodegenError(
        `'undefined' is only meaningful in '$match' position (where it lowers to '$exists'). ` +
          `In aggregation expressions, use 'null' for the present-but-null case, or move the comparison into a '$match' stage.`,
        expr.pos,
      );
    case "FieldRef":
      // Bare `$` (empty path) is the current document — MQL spells it `$$ROOT`.
      // Nested paths (`$.a.b`) lower verbatim to `"$a.b"`.
      return expr.path === "" ? "$$ROOT" : `$${expr.path}`;

    case "CollectionRef":
      // `$$.push(...)` is materialised into `$unionWith` stages,
      // `$$.filter(...)` inside `$ = { ... }` is materialised into a `$facet`
      // stage, and `$$ = <expr>` is materialised into `$match` (narrow) or
      // `$limit: 0` + `$unionWith` (source switch) — all by `pipeline.ts`
      // *before* codegen sees the surrounding expression. A bare
      // `CollectionRef` reaching this case is a use outside those supported
      // shapes — either `$$` was referenced as a value (in arithmetic, a
      // Filter, an inline expression) or the statement-shaped form appeared
      // in a non-statement position (on a RHS, inside another expression, etc.).
      throw new CodegenError(
        `'$$' (current collection) is statement-only and supports '.push(...)', '.filter(...)' in the facet pattern, and '$$ = <expr>' as a top-level assignment. ` +
          `Write \`$$.push({...})\`, \`$$.push(...$$$.<coll>[.filter(pred)])\`, or \`$$.push($$$.<coll>.find(pred))\` ` +
          `as a top-level Pipeline statement to append documents (lowers to '$unionWith'), ` +
          `\`$ = { key1: $$.filter(p1), key2: $$.filter(p2), ... }\` to build a '$facet' stage, ` +
          `or \`$$ = $$.filter(<pred>)\` / \`$$ = $$$.<coll>.filter(<pred>)\` to replace the current stream. ` +
          `As the first stage it also accepts a collection-scoped diagnostic — \`$$.indexStats()\`, \`$$.collStats({...})\`, \`$$.planCacheStats()\`, \`$$.listSearchIndexes({...})\`. ` +
          `Bare '$$' has no value, and these statement shapes cannot appear on a RHS or inside another expression.`,
        expr.pos,
      );
    case "DatabaseRef":
      // The two supported uses of `$$$` are both materialised by `pipeline.ts`
      // *before* codegen sees the surrounding expression:
      //   - `$$$.<coll>.find/filter(pred)` → `$lookup` stage (read).
      //   - `$$$.<coll> = <RHS>`            → `$out` stage (write).
      // Reaching this case means neither matched: the user wrote `$$$.<coll>`
      // as a bare value, used the chain in an expression-only position (a
      // Filter, `jsmql.expr`, an arithmetic operand), or used a method other
      // than `.find/.filter` that the pre-materialisation walker didn't
      // recognise.
      throw new CodegenError(
        `'$$$.<coll>' must be either followed by .find(pred) / .filter(pred) and consumed as a value (a $lookup read), ` +
          `or assigned to as a destination ('$$$.<coll> = $$' → $out write). ` +
          `Bare '$$$' reference is not a value, and these sugars are only valid in Pipeline mode (use \`;\`-separated statements or jsmql.pipeline()). ` +
          `(System diagnostics aren't database-scoped: collection ones are on '$$', server/cluster ones on '$$$$'.)`,
        expr.pos,
      );
    case "ClusterRef":
      // Like DatabaseRef: the two supported uses of `$$$$.<db>.<coll>` are
      // `.find/.filter(pred)` (cross-db lookup) and `= <RHS>` (cross-db $out).
      // Both are materialised pre-codegen. Reaching this case means a use
      // outside those shapes (bare reference, expression-only position,
      // wrong depth, dynamic db/coll names, etc.).
      throw new CodegenError(
        `'$$$$.<db>.<coll>' must be either followed by .find(pred) / .filter(pred) and consumed as a value (a cross-database $lookup), ` +
          `or assigned to as a destination ('$$$$.<db>.<coll> = $$' → cross-database $out). A direct call on '$$$$' is a server/cluster-scoped diagnostic source stage ` +
          `(\`$$$$.currentOp({...})\`, \`$$$$.listSessions({...})\`, \`$$$$.listLocalSessions({...})\`, \`$$$$.listSampledQueries({...})\`, \`$$$$.shardedDataDistribution()\`) as the first Pipeline stage. ` +
          `Bare '$$$$' reference is not a value, and these sugars are only valid in Pipeline mode (use \`;\`-separated statements or jsmql.pipeline()).`,
        expr.pos,
      );

    case "ArrayLiteral":
      return generateArrayLiteral(expr.elements, ctx, expr.pos);

    case "ObjectLiteral":
      return generateObjectLiteral(expr.entries, ctx, expr.pos);

    case "TemplateLiteral":
      return generateTemplateLiteral(expr.quasis, expr.expressions, ctx);

    case "OperatorCall":
      return generateOperatorCall(expr.name, expr.style, expr.args, ctx, expr.pos);

    case "BinaryExpr":
      return generateBinaryExpr(expr.op, expr.left, expr.right, ctx, expr.pos);

    case "UnaryExpr":
      return generateUnaryExpr(expr.op, expr.operand, ctx, expr.pos);

    case "TernaryExpr":
      return cond(
        jsBoolIfNeeded(expr.condition, _generate(expr.condition, ctx)),
        _generate(expr.consequent, ctx),
        _generate(expr.alternate, ctx),
      );

    case "IndexAccess": {
      // `obj[idx]` and `obj?.[idx]` produce the same AST shape; only the
      // `optional` flag distinguishes them. Type-aware dispatch:
      //   known array (structural OR binding-typed)  → $arrayElemAt
      //   known object (binding-typed only)          → $getField
      //   unknown                                    → runtime $cond between the two
      // Binding-typed = the receiver is a `ParamRef` whose name lives in
      // `ctx.bindingTypes` (populated today by `.reduce()` when initialValue
      // and body agree on a compound type). The optional-chain `$ifNull`
      // fallback matches the consumer: `[]` for array, `{}` for object so a
      // missing path doesn't poison `$getField` with an array.
      // Bracket access is *raw* data access — no compiler interpretation of the
      // key. Unlike dot `.length` (which folds to the string-or-array length
      // operator), `["length"]` just reads a property called "length". This
      // makes brackets the deliberate escape hatch: whatever the user spells in
      // the brackets is the property they get.
      //
      // `$["any.field"]` — a string-literal key on the bare root document — is a
      // plain field reference: the root is never an array, so the `$arrayElemAt`
      // branch below would be dead, and this lets users reach a field whose name
      // isn't a bare identifier (a dot, dash, space, …) — e.g.
      // `$["cart.field.length"]` → `"$cart.field.length"`.
      if (expr.index.type === "StringLiteral" && expr.object.type === "FieldRef" && expr.object.path === "") {
        return `$${expr.index.value}`;
      }
      const rawObj = _generate(expr.object, ctx);
      const idx = _generate(expr.index, ctx);
      const optional = expr.optional || chainHasOptional(expr.object);
      const containerType = expr.object.type === "ParamRef" ? ctx.bindingTypes?.get(expr.object.name) : undefined;
      // A receiver that is provably never an array — the bare root document
      // (`$` → `$$ROOT`, always a BSON object) or an object literal — makes
      // `obj[k]` an unambiguous property getter for *any* key, so emit
      // `$getField` and skip the `$isArray` dual guard. This generalises the
      // string-literal-on-root shortcut above (`$["x"]` → `$x`) to a computed
      // key: `$[k]` reads field `k` from the document. Without this the guard's
      // dead `$arrayElemAt` branch carries the key as an array index, and a
      // non-numeric index there is rejected at pipeline-optimization time
      // ("$arrayElemAt's second argument must be a numeric value, but is
      // string") on engines that don't prune the unreachable branch — a latent
      // HR3 violation that only surfaces on some servers.
      const isBareRoot = expr.object.type === "FieldRef" && expr.object.path === "";
      const known: "object" | "array" | undefined = isArrayProducing(expr.object)
        ? "array"
        : isObjectProducing(expr.object) || isBareRoot
          ? "object"
          : containerType === "array" || containerType === "object"
            ? containerType
            : undefined;
      // A provably-string key can never be a numeric array index, so `obj[k]` is
      // unambiguously an object property getter — emit `$getField` directly and
      // skip the `$isArray`/`$arrayElemAt` dual guard. This wins even over a
      // known-array receiver: JS reads `arr["x"]` as a property lookup (e.g.
      // `[1,2]["length"]`), and `$arrayElemAt` *rejects* a string index outright
      // ("second argument must be a numeric value, but is string"), whereas
      // `$getField` on an array input is accepted and yields missing — the
      // faithful, server-valid lowering (HR3). Covers a literal / `.toLowerCase()`-
      // style string key and a `const k = "…"` binding typed `"string"`.
      const keyIsString =
        isStringProducing(expr.index) ||
        (expr.index.type === "ParamRef" && ctx.bindingTypes?.get(expr.index.name) === "string");
      if (known === "object" || keyIsString) {
        const obj = optional ? wrapIfNull(rawObj, {}) : rawObj;
        return { $getField: { field: idx, input: obj } };
      }
      if (known === "array") {
        const obj = optional ? wrapIfNull(rawObj, []) : rawObj;
        return { $arrayElemAt: [obj, idx] };
      }
      const obj = optional ? wrapIfNull(rawObj, []) : rawObj;
      return cond({ $isArray: obj }, { $arrayElemAt: [obj, idx] }, { $getField: { field: idx, input: obj } });
    }

    case "RegexLiteral":
      // Method dispatch (e.g. `.match(/foo/)`, `/foo/.test(s)`) handles regex
      // arguments and receivers directly, reading pattern + flags from the AST
      // node before recursion. If we land here, the regex showed up in some
      // other position (binary operand, ternary branch, $op argument value)
      // where MQL has no concept of a regex value — silently returning the
      // pattern string would lose the flags and surprise the user.
      throw new CodegenError(
        `Regex literals are only valid as arguments to .match(), .test(), .exec(), .matchAll(), and .search(). To pass a regex pattern as a string, use a string literal instead.`,
        expr.pos,
      );

    case "ParamRef": {
      // Resolution order (innermost wins):
      //   1. `.reduce()` parameter remap (renamed to MQL's fixed $$value/$$this)
      //   2. lambda parameter — emit `$$name`
      //   3. pipeline `let` binding — emit `$<fieldPath>` (document field)
      //   4. function-form parameter binding — emit the inlined literal value
      //   5. reusable named function — error (it can only be called, not read)
      //   6. dropped let — precise post-reshape error
      //   7. otherwise — unknown identifier
      // (3) and (4) are name-disjoint by construction (pipeline.ts rejects a
      //  `let` that shadows a function-form binding), so their relative order
      //  affects only the error path, not correctness for valid programs.
      if (ctx.reduceRemap?.has(expr.name)) {
        return `$$${ctx.reduceRemap.get(expr.name)!}`;
      }
      if (ctx.lambdaParams.has(expr.name)) {
        return `$$${safeVarName(expr.name)}`;
      }
      const letPath = ctx.pipelineLets?.get(expr.name);
      if (letPath !== undefined) {
        return `$${letPath}`;
      }
      if (ctx.bindings?.has(expr.name)) {
        return safeBoundValue(ctx.bindings.get(expr.name), ctx);
      }
      if (ctx.functions?.has(expr.name)) {
        // A reusable function used in bare value position (`$ = { fn: double }`,
        // `double + 1`). MongoDB has no first-class functions — call it instead.
        // Higher-order use is [DEF-032]. (A bare array-method callback
        // `arr.map(double)` is caught earlier in requireLambda, which suggests
        // the `x => double(x)` wrap.)
        throw new CodegenError(
          `'${expr.name}' is a reusable function — call it with '${expr.name}(...)'. ` +
            `A function can't be used as a value (passing it to another function isn't supported); inline the call instead.`,
          expr.pos,
        );
      }
      const droppedBy = ctx.droppedLets?.get(expr.name);
      if (droppedBy !== undefined) {
        throw new CodegenError(
          `\`${expr.name}\` is a \`let\` binding and can't be read after \`${droppedBy}\` — ` +
            `the stage replaces the document. Inline the expression into the \`${droppedBy}\` body, ` +
            `or rebind after the stage with another \`let\`.`,
          expr.pos,
        );
      }
      throw new UnknownIdentifierError(expr.name, expr.pos);
    }

    case "MemberAccess": {
      if (expr.member === "length") {
        return generateLengthAccess(expr.object, expr.optional || chainHasOptional(expr.object), ctx);
      }
      const path = asFieldPath(expr, ctx);
      if (path !== null) return path;
      // Receiver isn't a foldable field path (e.g. result of $.items[0], a method call,
      // or a ternary). Use $getField, which works on any expression result.
      const rawObj = _generate(expr.object, ctx);
      const obj = expr.optional || chainHasOptional(expr.object) ? wrapIfNull(rawObj, {}) : rawObj;
      return { $getField: { field: expr.member, input: obj } };
    }

    case "MethodCall":
      return generateMethodCall(expr.object, expr.method, expr.args, ctx, expr.pos, !!expr.optional);

    case "CallExpression":
      return generateCallExpression(expr.callee, expr.args, ctx, expr.pos);

    case "Lambda":
      throw new CodegenError(
        "A function (=>) is only valid as the callback to an iterating array method (.map, .filter, .some, .every, .find, .reduce, …) or as the second argument to $let.",
        expr.pos,
      );

    case "TypeofExpr":
      return { $type: _generate(expr.operand, ctx) };

    case "NewDate":
      return generateNewDate(expr.args, ctx);

    case "ObjectIdLiteral":
      // Mint a live BSON ObjectId — the only value the driver accepts in a
      // query doc (an Extended JSON envelope is server-rejected). The instance
      // passes through `safeBoundValue`/`isOpaqueBsonValue` unchanged in every
      // position, exactly like an interpolated ObjectId. See src/objectid.ts.
      return new ObjectId(expr.hex);

    case "NewSet":
      // `new Set(arr)` is a tag for the value — used as a receiver in set-method calls
      // (intersection/union/etc.). When evaluated as a standalone value, it just unwraps
      // to the underlying array (MQL has no Set type).
      return expr.arg === null ? [] : _generate(expr.arg, ctx);

    case "ArrayFrom":
      return generateArrayFrom(expr.input, expr.mapFn, ctx, expr.pos);

    case "NumberStatic":
      return generateNumberStatic(expr.method, expr.arg, ctx);

    case "DateNow":
      // Date.now() returns ms since epoch — match JS semantics
      return { $toLong: "$$NOW" };

    case "DateUTC":
      return generateDateUTC(expr.args, ctx);

    case "TypeCast":
      return generateTypeCast(expr.cast, expr.arg, ctx, expr.pos);

    case "TypeCastRef":
      // A bare `Boolean` / `Number` / `String` outside callback position.
      // Inside `.filter(Boolean)` etc. this node is desugared away in
      // requireLambda(); reaching this case means the user wrote it as a
      // value (e.g. `Boolean + 5`), which has no MQL counterpart.
      throw new CodegenError(
        `'${expr.cast}' used as a value is only valid as a callback to a higher-order array method (e.g. $.items.filter(${expr.cast})). To coerce a single value, write ${expr.cast}(value).`,
        expr.pos,
      );

    case "MathCall":
      return generateMathCall(expr.method, expr.args, ctx, expr.pos);

    case "MathCallRef":
      // A bare `Math.floor` / `Math.round` / … outside callback position.
      // In `.map(Math.floor)` etc. this node is desugared away in
      // requireLambda(); reaching this case means the user wrote it as a
      // value (e.g. `Math.floor + 5`), which has no MQL counterpart.
      throw new CodegenError(
        `'Math.${expr.method}' used as a value is only valid as a callback to a higher-order array method (e.g. $.items.map(Math.${expr.method})). To compute on a single value, write Math.${expr.method}(value).`,
        expr.pos,
      );

    case "MathConst":
      return generateMathConst(expr.name);

    case "ObjectCall":
      return generateObjectCall(expr.method, expr.args, ctx, expr.pos);
  }
}

// ── Optional-chaining safety wraps ────────────────────────────────────────────
//
// `?.` in jsmql preserves an `optional: true` flag on the AST node the parser
// produced from it. Codegen consults `chainHasOptional` at every null-unsafe
// consumer site (array spread, array/string method receivers, string `$concat`
// operands, template-literal interpolations, `.length`, `Object.keys`/etc.) and
// wraps the value with `$ifNull(v, neutral)`, where `neutral` is the empty
// value matching the consumer slot:
//   - `[]` for array consumers
//   - `""` for string consumers
//   - `{}` for object consumers
//
// The walker descends only through `MemberAccess` and `IndexAccess` links — it
// stops at `MethodCall` because once a method has been called the value is
// whatever the method returned, not the optional chain that produced its
// receiver. (The method call site itself already wrapped its receiver if its
// own chain was optional, so the result is guaranteed safe.) The walker also
// does not descend into lambda bodies, binary operands, method arguments, or
// `IndexAccess.index` — `?.` buried in those positions belongs to a different
// chain. The current node's own `.optional` flag is consulted separately at
// each consumer site (see `expr.optional ||` checks in `_generate`).

function chainHasOptional(expr: Expr): boolean {
  let node: Expr = expr;
  while (node.type === "MemberAccess" || node.type === "IndexAccess") {
    if (node.optional) return true;
    node = node.object;
  }
  return false;
}

function wrapIfNull(value: unknown, fallback: unknown): unknown {
  return { $ifNull: [value, fallback] };
}

// `.length` / `["length"]` of `object`. Known string → `$strLenCP`, known array
// → `$size`, otherwise dispatch at runtime. When the chain is optional, wrap the
// receiver with `$ifNull(_, [])` so `$isArray` succeeds, the array branch runs,
// and `$size([])` returns 0 (matching JS short-circuit: `undefined?.length` is
// undefined; we surface 0).
function generateLengthAccess(object: Expr, optional: boolean, ctx: GenerateCtx): unknown {
  // `$$.length` — the current stream's cardinality. `pipeline.ts` materialises
  // it into the `__jsmql.length` field (via `$setWindowFields`) ahead of the
  // stage that reads it; here we just emit the field reference. Gated to
  // top-level pipeline position (see `generateStreamLength`).
  if (object.type === "CollectionRef") return generateStreamLength(ctx, object.pos);
  // A lookup-chain `.map`/`.filter` 3rd param naming the sub-stream
  // (`$$$.<coll>.filter(p).map((o, _i, coll) => coll.length)`): its `.length`
  // is the sub-stream's document count, materialised by the lowerer into
  // `__jsmql.length` (current level) or captured via `$lookup.let` from an
  // ancestor level (cross-level). Checked BEFORE the array-typed branch — the
  // handle is NOT a bound `$$`-variable, so `$size` of it would be invalid.
  if (object.type === "ParamRef") {
    const handleSource = ctx.substreamLengthHandles?.get(object.name);
    if (handleSource !== undefined) return handleSource;
  }
  // A lambda's 3rd 'array' callback param (`.map((el, i, arr) => arr.length)`)
  // is provably an array — you can only iterate an array — so its `.length` is
  // a clean `$size`, not the runtime `$isArray` guard used for unknown receivers.
  if (object.type === "ParamRef" && ctx.bindingTypes?.get(object.name) === "array") {
    const v = _generate(object, ctx);
    return { $size: optional ? wrapIfNull(v, []) : v };
  }
  const rawObj = _generate(object, ctx);
  if (isStringProducing(object)) return { $strLenCP: optional ? wrapIfNull(rawObj, "") : rawObj };
  if (isArrayProducing(object)) return { $size: optional ? wrapIfNull(rawObj, []) : rawObj };
  const obj = optional ? wrapIfNull(rawObj, []) : rawObj;
  return cond({ $isArray: obj }, { $size: obj }, { $strLenCP: obj });
}

/**
 * Lower `$$.length` (the current stream's document count) to the materialised
 * field reference `"$__jsmql.length"`. `pipeline.ts` guarantees a
 * `$setWindowFields` populated `__jsmql.length` on each document ahead of the
 * stage that reads it. Gated to top-level pipeline position:
 *   - no pipeline (Filter / `jsmql.expr`) → there is no stream to count;
 *   - inside a sub-pipeline (`$lookup`/`$facet`/`$unionWith`) → the count would
 *     mean the SUB-stream, which needs correlation we don't do yet [DEF-033].
 * See docs/specs/stream-length.md.
 */
function generateStreamLength(ctx: GenerateCtx, pos: number): unknown {
  if (!ctx.pipelineContext) {
    throw new CodegenError(
      `'$$.length' (the current stream's document count) needs Pipeline mode — it materialises a '$setWindowFields' stage. ` +
        `Use it inside a pipeline (e.g. \`($) => { $.n = $$.length; … }\`); it has no meaning in a Filter or in 'jsmql.expr'.`,
      pos,
    );
  }
  // Inside a sub-pipeline, `$$` is still the ROOT stream — its count was
  // materialised at the top level and captured into this lookup's `$lookup.let`
  // (a depth-stamped `v<d>_len`), so read it back as that `$$`-variable.
  if (ctx.rootStreamLengthVar !== undefined) return `$$${ctx.rootStreamLengthVar}`;
  if (!ctx.topLevelStream) {
    throw new CodegenError(
      `'$$.length' (the root stream count) isn't available here yet [DEF-033] — it works at the top level and inside a top-level '$lookup' ` +
        `(predicate, block, or '.map' chain, captured into '$lookup.let'), but not yet in a '$facet' / '$unionWith' sub-pipeline or a deeper nested lookup. ` +
        `Compute it in the outer (top-level) pipeline and reference the value instead.`,
      pos,
    );
  }
  return `$${LENGTH_SLOT}`;
}

// Method-name → "neutral input for the operator this method lowers to".
// Used to pick the `$ifNull` fallback when a `?.` chain feeds the method's
// receiver. Date / Set / Regex methods are intentionally absent: their
// underlying operators (`$year`, set ops, regex ops) handle null cleanly and
// don't poison downstream callers.
// Derived from METHODS (`optional` field). String-receiver methods pick the
// `""` neutral, array-receiver methods pick `[]`.
const OPTIONAL_STRING_METHODS = methodsWhere((m) => m.optional === "string");

const OPTIONAL_ARRAY_METHODS = methodsWhere((m) => m.optional === "array");

// `indexOf` / `includes` / `concat` / `slice` dispatch on receiver type at codegen
// time (or at runtime via `$cond` when the type is unknown). For these we pick the
// fallback that matches the chosen branch: `""` when the receiver is provably
// string-producing, `[]` otherwise — `[]` is also safe for the runtime-dispatch
// path because `$isArray([])` is true, sending it down the array branch which
// returns the same sensible empty-array result the JS short-circuit would.
const OPTIONAL_EITHER_METHODS = methodsWhere((m) => m.optional === "either");

function neutralForMethod(method: string, object: Expr): unknown | undefined {
  if (OPTIONAL_STRING_METHODS.has(method)) return "";
  if (OPTIONAL_ARRAY_METHODS.has(method)) return [];
  if (OPTIONAL_EITHER_METHODS.has(method)) {
    if (isStringProducing(object)) return "";
    return [];
  }
  return undefined;
}

// ── Field path reconstruction ─────────────────────────────────────────────────

function asFieldPath(expr: Expr, ctx: GenerateCtx): string | null {
  if (expr.type === "FieldRef") return expr.path === "" ? "$$ROOT" : `$${expr.path}`;
  if (expr.type === "ParamRef") {
    if (ctx.reduceRemap?.has(expr.name)) {
      return `$$${ctx.reduceRemap.get(expr.name)!}`;
    }
    if (ctx.lambdaParams.has(expr.name)) {
      return `$$${safeVarName(expr.name)}`;
    }
    const letPath = ctx.pipelineLets?.get(expr.name);
    if (letPath !== undefined) {
      return `$${letPath}`;
    }
    return null;
  }
  if (expr.type === "MemberAccess") {
    const base = asFieldPath(expr.object, ctx);
    if (base !== null) return `${base}.${expr.member}`;
  }
  return null;
}

// ── Binary expressions ────────────────────────────────────────────────────────

/**
 * Canonical JS-binary-operator → MQL-operator-name mapping — the single source
 * of truth shared between codegen (which emits `{ $op: … }`) and
 * `match-translation` (which uses the operator name as a query-document key, see
 * its `orderedOpToMql`). Only operators with a *direct* single-operator lowering
 * appear here; the ones with bespoke handling (`+` numeric-vs-string, `==`/`!=`
 * null-only, `&&`/`||` JS-truthy, `in` membership) are not in the table.
 *
 * Two emission groups share it: DIRECT ops lower to `{ $op: [left, right] }`;
 * CHAIN ops (associative) flatten to a flat N-ary array via `flattenChain`.
 */
const BINARY_OP_TO_MQL = {
  "-": "$subtract",
  "/": "$divide",
  "%": "$mod",
  "**": "$pow",
  "===": "$eq",
  "!==": "$ne",
  ">": "$gt",
  ">=": "$gte",
  "<": "$lt",
  "<=": "$lte",
  "*": "$multiply",
  "??": "$ifNull",
  "&": "$bitAnd",
  "|": "$bitOr",
  "^": "$bitXor",
} as const satisfies Partial<Record<BinaryOp, string>>;

type DirectBinaryOp = "-" | "/" | "%" | "**" | "===" | "!==" | ">" | ">=" | "<" | "<=";
type ChainBinaryOp = "*" | "??" | "&" | "|" | "^";

/** The MQL operator name for a direct/chain binary op — the one accessor other
 *  modules use (match-translation's query-document path), so `BINARY_OP_TO_MQL`
 *  stays the single source of truth. */
export function mqlForBinaryOp(op: DirectBinaryOp | ChainBinaryOp): string {
  return BINARY_OP_TO_MQL[op];
}

function generateBinaryExpr(op: BinaryOp, left: Expr, right: Expr, ctx: GenerateCtx, pos: number): unknown {
  switch (op) {
    case "+":
      return generateAdd(left, right, ctx);
    case "==":
    case "!=":
      return generateLooseEquality(op, left, right, ctx, pos);
    case "&&":
      return generateLogical("&&", left, right, ctx);
    case "||":
      return generateLogical("||", left, right, ctx);
    case "in":
      return generateInExpr(left, right, ctx, pos);
    // Direct binary operators → `{ $op: [left, right] }`.
    case "-":
    case "/":
    case "%":
    case "**":
    case "===":
    case "!==":
    case ">":
    case ">=":
    case "<":
    case "<=":
      return { [BINARY_OP_TO_MQL[op]]: [_generate(left, ctx), _generate(right, ctx)] };
    // Associative chain operators → flat N-ary array.
    case "*":
    case "??":
    case "&":
    case "|":
    case "^":
      return { [BINARY_OP_TO_MQL[op]]: flattenChain(op, left, right, ctx) };
  }
}

/**
 * Loose equality (`==`, `!=`) is restricted to comparisons against `null` —
 * the one JS use of `==` that is unambiguous and useful (matches null or
 * missing). Any other use is a footgun (JS type coercion) and is rejected
 * with a message pointing the user at `===`.
 *
 * `$.x == null` compiles to a $type check covering both BSON "null" and
 * "missing", so missing-field docs match the same way they do in MongoDB's
 * query language (`{ field: null }`). `$.x != null` is the negation.
 */
function generateLooseEquality(op: "==" | "!=", left: Expr, right: Expr, ctx: GenerateCtx, pos: number): unknown {
  const leftIsNull = left.type === "NullLiteral";
  const rightIsNull = right.type === "NullLiteral";
  if (!leftIsNull && !rightIsNull) {
    throw new CodegenError(
      `'${op}' is only allowed against null in jsmql. Use '${op === "==" ? "===" : "!=="}' for JS-like strict equality (no surprising type coercion). To match "null or missing", write '$.x ${op} null'.`,
      pos,
    );
  }
  const operand = _generate(leftIsNull ? right : left, ctx);
  const inNullOrMissing = { $in: [{ $type: operand }, ["null", "missing"]] };
  return op === "==" ? inNullOrMissing : { $not: [inNullOrMissing] };
}

/**
 * Collect all operands from a left-associative chain of the same operator.
 * e.g. BinaryExpr(*, BinaryExpr(*, a, b), c) → [gen(a), gen(b), gen(c)]
 */
function flattenChain(op: BinaryOp, left: Expr, right: Expr, ctx: GenerateCtx): unknown[] {
  const operands: unknown[] = [];
  collectChain(op, left, operands, ctx);
  operands.push(_generate(right, ctx));
  return operands;
}

function collectChain(op: BinaryOp, expr: Expr, out: unknown[], ctx: GenerateCtx): void {
  if (expr.type === "BinaryExpr" && expr.op === op) {
    collectChain(op, expr.left, out, ctx);
    out.push(_generate(expr.right, ctx));
  } else {
    out.push(_generate(expr, ctx));
  }
}

// ── Logical && / || (operand-preserving, JS semantics) ───────────────────────
//
// JS `a && b` returns `a` if a is falsy, else `b`. JS `a || b` returns `a`
// if a is truthy, else `b`. The result is the operand, not a boolean — so
// `$.x || "default"` evaluates to "default" only when $.x is JS-falsy, and
// `[$.b && $.b + ","]` includes the concatenation only when $.b is truthy.
//
// We compile to `$cond` and bind the LHS once via `$let` when re-evaluating
// it would be wasteful or unsafe. Pure refs (FieldRef / lambda param /
// member access on either) compile inline without `$let`.
//
// Chains like `a && b && c` are folded right so short-circuit semantics
// are preserved: `a && (b && c)` → if a falsy return a, else evaluate b&&c.

function generateLogical(op: "&&" | "||", left: Expr, right: Expr, ctx: GenerateCtx): unknown {
  const chain: Expr[] = [];
  collectExprChain(op, left, chain);
  chain.push(right);
  return foldLogical(op, chain, ctx);
}

function foldLogical(op: "&&" | "||", chain: Expr[], ctx: GenerateCtx): unknown {
  if (chain.length === 1) return _generate(chain[0], ctx);
  // All-bool chains (or all-bool tails) keep the cheap `$and`/`$or` form.
  // The result is bool either way — JS's operand-preserving rule is moot
  // when every operand is already a boolean. Covers the common filter-
  // condition case (`x > 0 && y < 10`) and bool-only tails of mixed chains.
  if (chain.every((e) => isProvablyBool(e))) {
    const operands = chain.map((e) => _generate(e, ctx));
    return op === "&&" ? { $and: operands } : { $or: operands };
  }
  const lhs = chain[0];
  const lhsGen = _generate(lhs, ctx);
  const rhsGen = foldLogical(op, chain.slice(1), ctx);
  // Pure refs and provably-bool LHS values are cheap to reference twice, so
  // we inline rather than introducing `$let`. (For provably-bool, the value
  // and its truthiness are the same — re-eval cost is at most a comparison.)
  if (isPureRef(lhs, ctx) || isProvablyBool(lhs)) {
    return condForLogical(op, lhsGen, rhsGen, lhs);
  }
  // Bind lhs once so we can both test and return it without re-evaluating.
  // Base name must be MongoDB-valid (lowercase lead); gensym handles collisions.
  const v = gensymInScope(ctx, "v");
  const ref = `$$${v}`;
  return {
    $let: {
      vars: { [v]: lhsGen },
      // The bound value is a runtime value — we don't have an AST for it,
      // so we can't ask isProvablyBool. Always wrap in jsBool for the cond.
      in: condForLogical(op, ref, rhsGen, null),
    },
  };
}

function condForLogical(op: "&&" | "||", lhs: unknown, rhs: unknown, lhsExpr: Expr | null): unknown {
  const test = lhsExpr ? jsBoolIfNeeded(lhsExpr, lhs) : jsBool(lhs);
  return op === "&&" ? cond(test, rhs, lhs) : cond(test, lhs, rhs);
}

// ── `in` operator ─────────────────────────────────────────────────────────────

/**
 * `in` straddles two JS semantics depending on the RHS:
 *   - array on the right: value membership (different from JS, which checks
 *     numeric-index existence on arrays — but value-membership is overwhelmingly
 *     what users want for MongoDB queries, so we deliberately diverge here).
 *   - object on the right: property existence — JS-faithful.
 *
 * For an object-literal RHS we extract the keys at compile time and reduce to
 * `{ $in: [LHS, [...keys]] }`. Computed keys are evaluated at runtime; spread
 * entries unwrap to `$objectToArray` over the spread expression so the keys
 * become available without us having to know them at compile time.
 *
 * Scalar literals on the right have no useful interpretation in either
 * direction and stay rejected.
 */
function generateInExpr(left: Expr, right: Expr, ctx: GenerateCtx, pos: number): unknown {
  if (
    right.type === "StringLiteral" ||
    right.type === "NumberLiteral" ||
    right.type === "BooleanLiteral" ||
    right.type === "NullLiteral"
  ) {
    throw new CodegenError(
      "Right-hand side of 'in' must be an array literal, object literal, or field reference, not a scalar value",
      pos,
    );
  }
  if (right.type === "ObjectLiteral") {
    return { $in: [_generate(left, ctx), keyArrayForObjectLiteral(right.entries, ctx)] };
  }
  return { $in: [_generate(left, ctx), _generate(right, ctx)] };
}

/**
 * Build the MQL expression representing the *keys* of an object-literal RHS,
 * for the `key in obj` case. Static-only entries collapse to a literal string
 * array. Computed-key entries emit the key expression directly (it should
 * resolve to a string at runtime). Spread entries lower to
 * `$objectToArray(expr).k` so we can splice the runtime keys in.
 *
 * If every chunk is static the result is a plain JS array; if any spread is
 * present we wrap the chunks in `$concatArrays`.
 */
function keyArrayForObjectLiteral(entries: ObjectEntry[], ctx: GenerateCtx): unknown {
  // Fast path: all static keys → a plain literal array of strings.
  if (entries.every((e) => e.type === "KeyValueEntry" && e.key.kind === "static")) {
    return entries.map((e) => ((e as KeyValueEntry).key as { kind: "static"; name: string }).name);
  }

  // Mixed path: build `$concatArrays` of per-chunk operands. Consecutive
  // non-spread entries group into one literal array (mirrors the array-literal
  // spread codegen for compact output).
  const operands: unknown[] = [];
  let currentChunk: unknown[] | null = null;
  const flush = () => {
    if (currentChunk !== null) {
      operands.push(currentChunk);
      currentChunk = null;
    }
  };
  for (const entry of entries) {
    if (entry.type === "SpreadElement") {
      flush();
      operands.push({ $map: { input: { $objectToArray: _generate(entry.argument, ctx) }, as: "kv", in: "$$kv.k" } });
      continue;
    }
    if (currentChunk === null) currentChunk = [];
    currentChunk.push(entry.key.kind === "static" ? entry.key.name : _generate(entry.key.expr, ctx));
  }
  flush();

  if (operands.length === 1) return operands[0];
  return { $concatArrays: operands };
}

// ── String-context + ──────────────────────────────────────────────────────────

function generateAdd(left: Expr, right: Expr, ctx: GenerateCtx): unknown {
  // Collect full operand chain first, then decide $add vs $concat
  const exprs: Expr[] = [];
  collectExprChain("+", left, exprs);
  exprs.push(right);

  const isString = exprs.some((e) => isStringProducing(e));
  if (isString) {
    // `$concat` returns null on any null operand, poisoning the whole string.
    // Wrap optional-chain operands with $ifNull(v, "") so `?.` operands match
    // JS-like fallback semantics for string concatenation.
    return {
      $concat: exprs.map((e) => {
        const gen = _generate(e, ctx);
        return chainHasOptional(e) ? wrapIfNull(gen, "") : gen;
      }),
    };
  }
  // Numeric `$add` already returns null on null operand, matching JS's
  // `1 + undefined === NaN` closely enough — leave optional operands alone
  // so the result is honestly null rather than silently coerced to 0.
  return { $add: exprs.map((e) => _generate(e, ctx)) };
}

function collectExprChain(op: BinaryOp, expr: Expr, out: Expr[]): void {
  if (expr.type === "BinaryExpr" && expr.op === op) {
    collectExprChain(op, expr.left, out);
    out.push(expr.right);
  } else {
    out.push(expr);
  }
}

// ── Unary expressions ─────────────────────────────────────────────────────────

function generateUnaryExpr(op: "!" | "-" | "~", operand: Expr, ctx: GenerateCtx, _pos: number): unknown {
  if (op === "!") {
    // !!x → jsBool(x): the canonical "coerce to JS boolean" idiom, identical
    // to what `Boolean(x)` emits. Saves a $not-of-$not.
    if (operand.type === "UnaryExpr" && operand.op === "!") {
      return jsBool(_generate(operand.operand, ctx));
    }
    return { $not: jsBoolIfNeeded(operand, _generate(operand, ctx)) };
  }
  if (op === "~") {
    return { $bitNot: _generate(operand, ctx) };
  }
  // Unary minus: optimise -<number> to a plain negative number literal
  if (operand.type === "NumberLiteral") {
    return -operand.value;
  }
  return { $multiply: [_generate(operand, ctx), -1] };
}

// ── Array / object literals ───────────────────────────────────────────────────

/**
 * Generate an array literal. Mirrors `generateObjectLiteral`'s spread handling:
 *
 *   - No spread → plain MQL array of generated elements.
 *   - Any spread (`[1, ...a, 2]`) → `$concatArrays` over a list of operands, where
 *     consecutive non-spread elements are grouped into one literal-array operand
 *     and each spread argument is its own operand (presumed to evaluate to an
 *     array at runtime).
 *
 * The single-operand case (`[...a]` on its own) returns the spread argument
 * directly — `{ $concatArrays: [a] }` is semantically equivalent and noisier.
 */
function generateArrayLiteral(elements: ArrayElement[], ctx: GenerateCtx, pos: number): unknown {
  // Update ops (`$.a = 1`, `delete $.x`) are valid as ArrayElements only when
  // the array is a pipeline (handled in pipeline.ts before reaching here).
  // Reaching here with a update op means the user wrote a update op inside a
  // value array — reject with a precise error pointing at the supported forms.
  for (const el of elements) {
    if (el.type === "AssignExpr" || el.type === "DeleteStmt") {
      throw new CodegenError(
        `${el.type === "AssignExpr" ? "Assignment" : "delete"} is a statement, not a value, and is only valid at the top level or as a pipeline-array element. ` +
          `If this array is meant to be a pipeline, ensure its first element is a stage like \`$match(...)\`.`,
        el.pos,
      );
    }
    if (el.type === "LetDecl") {
      throw new CodegenError(
        "`let` is a pipeline statement, not a value, and is only valid as a pipeline-array element. " +
          "If this array is meant to be a pipeline, ensure its first element is a stage like `$match(...)`.",
        el.pos,
      );
    }
    if (el.type === "FuncDecl") {
      throw new CodegenError(
        "A function declaration is a pipeline statement, not a value, and is only valid as a pipeline-array element. " +
          "If this array is meant to be a pipeline, ensure its first element is a stage like `$match(...)`.",
        el.pos,
      );
    }
  }
  void pos;

  const hasSpread = elements.some((el) => el.type === "SpreadElement");

  if (!hasSpread) {
    return elements.map((el) => _generate(el as Expr, ctx));
  }

  const operands: unknown[] = [];
  let buffer: Expr[] = [];

  const flushBuffer = () => {
    if (buffer.length === 0) return;
    operands.push(buffer.map((el) => _generate(el, ctx)));
    buffer = [];
  };

  for (const el of elements) {
    if (el.type === "SpreadElement") {
      flushBuffer();
      // `[..., ...x?.y, ...]` — if the spread argument's chain is optional,
      // wrap with `$ifNull(v, [])` so a missing field produces an empty array
      // rather than `null` (which poisons `$concatArrays` and crashes any
      // downstream operator expecting an array).
      const argVal = _generate(el.argument, ctx);
      operands.push(chainHasOptional(el.argument) ? wrapIfNull(argVal, []) : argVal);
    } else if (
      el.type === "AssignExpr" ||
      el.type === "DeleteStmt" ||
      el.type === "LetDecl" ||
      el.type === "FuncDecl"
    ) {
      // Already rejected above; unreachable.
      continue;
    } else {
      buffer.push(el);
    }
  }
  flushBuffer();

  if (operands.length === 1) return operands[0];
  return { $concatArrays: operands };
}

/**
 * Generate an object literal. The shape it compiles to depends on which features the
 * source used:
 *
 *   - All static keys, no spread        → plain MQL object.
 *   - Any computed key, no spread       → `$arrayToObject` over `[[k, v], ...]`.
 *   - Any spread (`{...a, x: 1, ...b}`) → `$mergeObjects` over a list of operands,
 *                                         where consecutive non-spread entries are
 *                                         grouped into one operand each (using the
 *                                         same static / `$arrayToObject` rules) and
 *                                         each spread argument is its own operand.
 *
 * The single-operand case (`{...a}` on its own) returns the spread argument directly
 * to avoid emitting a redundant `$mergeObjects: [a]` wrapper — they're semantically
 * equivalent in MQL.
 */
function generateObjectLiteral(entries: ObjectEntry[], ctx: GenerateCtx, _pos: number): unknown {
  const hasSpread = entries.some((e) => e.type === "SpreadElement");

  if (!hasSpread) {
    const hasComputed = entries.some((e) => e.type === "KeyValueEntry" && e.key.kind === "computed");
    if (!hasComputed) {
      return generateStaticObjectEntries(entries, ctx);
    }
    return generateComputedKeyObject(entries as KeyValueEntry[], ctx);
  }

  // Spread present: walk entries left-to-right, grouping consecutive non-spread
  // entries into one $mergeObjects operand each, and emitting each spread argument
  // as its own operand. JS spread semantics ("later wins") match $mergeObjects's
  // own ("rightmost value wins on key collision"), so left-to-right order is
  // preserved verbatim.
  const operands: unknown[] = [];
  let staticBuffer: KeyValueEntry[] = [];

  const flushBuffer = () => {
    if (staticBuffer.length === 0) return;
    const hasComputed = staticBuffer.some((e) => e.key.kind === "computed");
    operands.push(
      hasComputed ? generateComputedKeyObject(staticBuffer, ctx) : generateStaticObjectEntries(staticBuffer, ctx),
    );
    staticBuffer = [];
  };

  for (const entry of entries) {
    if (entry.type === "SpreadElement") {
      flushBuffer();
      operands.push(_generate(entry.argument, ctx));
    } else {
      staticBuffer.push(entry);
    }
  }
  flushBuffer();

  if (operands.length === 1) return operands[0];
  return { $mergeObjects: operands };
}

/**
 * Wrap a literal pairs array as a server-valid `$arrayToObject` argument.
 *
 * `{ $arrayToObject: <arrayLiteral> }` is mis-parsed: MongoDB reads a literal
 * array *value* as the operator's argument LIST, so `[[k,v],[k2,v2]]` becomes
 * two arguments ("$arrayToObject takes exactly 1 argument"), and even a single
 * `[[k,v]]` is unwrapped to `[k,v]` and rejected ("Unrecognised input type").
 * Wrapping one level deeper — `{ $arrayToObject: [pairs] }` — makes MongoDB
 * unwrap exactly once back to `pairs`, the single array argument. Works for any
 * pair count and for expression-valued pairs (a `$literal` wrap can't — it would
 * freeze `$$this` etc.). Verified on MongoDB 8.2.
 */
function arrayToObjectOfLiteralPairs(pairs: unknown): Record<string, unknown> {
  return { $arrayToObject: [pairs] };
}

function generateComputedKeyObject(entries: KeyValueEntry[], ctx: GenerateCtx): unknown {
  // Emit `$arrayToObject`'s `{ k, v }` object-pair form rather than the `[k, v]`
  // array-pair form: one less nesting level once wrapped, self-documenting, and
  // unambiguous when a value is itself an array. (Both still need the
  // `arrayToObjectOfLiteralPairs` wrap — a bare `[{k,v}]` is unwrapped by MongoDB
  // to the object and rejected, "requires an array input, found: object".)
  const pairs = entries.map((entry) => {
    const k = entry.key.kind === "static" ? entry.key.name : _generate(entry.key.expr, ctx);
    return { k, v: _generate(entry.value, ctx) };
  });
  return arrayToObjectOfLiteralPairs(pairs);
}

/**
 * Used for object-style operator args, where the keys must literally appear in MQL output
 * (e.g. `{ input, find, replacement }` for `$replaceOne`). Computed keys are rejected here —
 * MongoDB operator key names are part of the operator's wire format and can't be runtime values.
 */
function generateStaticObjectEntries(entries: ObjectEntry[], ctx: GenerateCtx): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const entry of entries) {
    if (entry.type === "SpreadElement") {
      throw new CodegenError("Spread elements in objects are not supported in MQL output", entry.pos);
    }
    if (entry.key.kind === "computed") {
      throw new CodegenError(
        "Computed object keys are not allowed here — operator argument keys must be literal names",
        entry.pos,
      );
    }
    // HR3: a raw `{ $op: value }` object whose key is a list-only operator (no
    // single-value form) is only valid MQL when `value` is the operand array —
    // `{ $setUnion: $.x }` is server-rejected. Reject it here too, with the same
    // message as the `$op(...)` call form, so the rule holds on every surface.
    if (entry.key.name.charCodeAt(0) === 36 /* $ */ && entry.value.type !== "ArrayLiteral") {
      if (lookupOperator(entry.key.name)?.shape.kind === "array") {
        throw listOperandError(entry.key.name, entry.value.pos);
      }
    }
    result[entry.key.name] = _generate(entry.value, ctx);
  }
  return result;
}

// ── Operator calls ────────────────────────────────────────────────────────────

/**
 * Validate that an operator call appears in a context that allows it. Throws
 * a precise `CodegenError` for window-only / accumulator-only operators used
 * outside `$group` / `$setWindowFields.output`. Permissive by default — any
 * operator whose category is `window` or whose `accumulatorOnly` flag is set
 * gets gated; everything else passes through.
 *
 * Accumulator-only operators have no expression-form in MongoDB — they only
 * mean something inside `$group` field-value slots or `$setWindowFields.output`
 * bodies, so using them elsewhere produces invalid MQL the server would reject
 * at runtime. The `accumulatorOnly` flag lives on the operator registry entry
 * ([operators.ts](operators.ts)) — the single source of truth — so it stays
 * distinct from ops with *both* expression and accumulator forms ($sum, $avg,
 * $max, $min, $stdDev*), which leave the flag unset and stay unrestricted.
 */
function checkOperatorContext(name: string, ctx: GenerateCtx, pos: number): void {
  const def = lookupOperator(name);
  // Window-only: category === "window" → require `window-output` context.
  if (def?.category === "window") {
    if (ctx.accumulatorContext !== "window-output") {
      throw new CodegenError(
        `${name} is a window operator — only valid inside '$setWindowFields' output slots. ` +
          `Use $setWindowFields({ partitionBy: ..., sortBy: ..., output: { <key>: ${name}(...) } }) to compute it per-document over a window.`,
        pos,
      );
    }
    return;
  }
  // Accumulator-only: allowed inside `$group` field-value slots and inside
  // `$setWindowFields.output` slots.
  if (def?.accumulatorOnly) {
    if (ctx.accumulatorContext === undefined) {
      throw new CodegenError(
        `${name} is an accumulator operator — only valid inside '$group' field-value slots or '$setWindowFields' output slots. ` +
          `Use $group({ _id: ..., <key>: ${name}(...) }) to compute it per-group, or $setWindowFields(...) for the windowed form.`,
        pos,
      );
    }
  }
}

function generateOperatorCall(
  name: string,
  style: "positional" | "object",
  args: CallArg[],
  ctx: GenerateCtx,
  pos: number,
): Record<string, unknown> {
  checkOperatorContext(name, ctx, pos);
  // HR2: the `$op(...)` escape hatch takes operands directly. The JS spread
  // (`$op(...arr)`) is not supported on any operator — pass operands as
  // separate args or as a single array literal.
  assertNoSpread(args, name, pos);
  // Literal-gated argument validation (arity / required keys / enums / types).
  // Runs after the spread guard, before shape dispatch; see operator-validation.ts.
  validateOperatorArgs(name, style, args, pos, ctx);
  // Special case: $literal(value) — the argument is wrapped verbatim and
  // MongoDB does not re-evaluate it at query time. Recurse with the
  // `insideLiteral` flag so nested `"$..."` strings don't get a second
  // `$literal` wrap (that would emit a literal-of-a-literal object). Sits
  // ahead of the `style === "object"` branch because the parser tags
  // `$literal({...})` as object-style, but we still want the suppress flag.
  if (name === "$literal" && args.length === 1 && args[0].type !== "SpreadElement") {
    const inner = _generate(args[0] as Expr, { ...ctx, insideLiteral: true });
    return { $literal: inner };
  }

  if (style === "object") {
    const objArg = args[0];
    if (!objArg || objArg.type !== "ObjectLiteral") {
      throw new CodegenError(`Object-style call to ${name} must have exactly one object argument`, pos);
    }
    const def = lookupOperator(name);
    // For operators that genuinely expect a named-key object (e.g. $trim, $dateAdd),
    // the keys must be literal names — they are part of the MQL wire format.
    // For any other operator (or unknown), the object is just a value, so computed
    // keys and any other normal object behaviour applies.
    if (def?.shape.kind === "object") {
      return { [name]: generateStaticObjectEntries(objArg.entries, ctx) };
    }
    return { [name]: generateObjectLiteral(objArg.entries, ctx, objArg.pos) };
  }

  // Special case: $let(varsObj, lambda) — lambda defines the "in" body
  if (name === "$let" && args.length === 2 && args[1]?.type === "Lambda") {
    const varsExpr = args[0];
    if (!varsExpr || varsExpr.type !== "ObjectLiteral") {
      throw new CodegenError("$let first argument must be an object literal", varsExpr?.pos ?? pos);
    }
    const lambdaExpr = args[1];
    if (lambdaExpr.type !== "Lambda") throw new CodegenError("$let second argument must be a lambda", lambdaExpr.pos);
    if (lambdaExpr.block !== undefined) {
      throw new CodegenError(
        "$let second argument cannot be a statement-block arrow (a sub-pipeline) — that form is only for '$$$.<coll>.find/filter(...)'. Use an expression, or a value-returning block `() => { const a = …; return a; }`.",
        lambdaExpr.pos,
      );
    }
    const vars = generateStaticObjectEntries(varsExpr.entries, ctx);
    const bodyCtx = extendCtx(ctx, lambdaExpr.params);
    return { $let: { vars, in: genLambdaBody(lambdaExpr, bodyCtx) } };
  }

  // $arrayToObject([pairs]) — a literal pairs-array argument must be wrapped one
  // level deeper (see `arrayToObjectOfLiteralPairs`). A field-ref / expression
  // argument (`$arrayToObject($.pairs)`) already resolves to one array, so it is
  // left untouched by the `single`-shape default below.
  if (name === "$arrayToObject" && style === "positional" && args.length === 1 && args[0].type === "ArrayLiteral") {
    return arrayToObjectOfLiteralPairs(_generate(args[0] as Expr, ctx));
  }

  const def = lookupOperator(name);

  if (!def) {
    return generateUnknownOperator(name, args, ctx);
  }

  const { shape } = def;

  switch (shape.kind) {
    case "none": {
      return { [name]: {} };
    }

    case "single": {
      if (args.length !== 1) {
        throw new CodegenError(`Operator ${name} expects exactly 1 argument, got ${args.length}`, pos);
      }
      return { [name]: _generate(args[0] as Expr, ctx) };
    }

    case "array": {
      // List-only operator (no single-value form). HR2/HR3:
      //   2+ args        → `{ $op: [a, b, ...] }`
      //   1 array literal → `{ $op: [...] }`  (the array IS the operand list)
      //   1 non-array     → HR3 error (a list operator can't take a lone scalar)
      if (args.length === 0) {
        throw new CodegenError(`Operator ${name} expects at least 1 argument`, pos);
      }
      if (args.length === 1) {
        const only = args[0] as Expr;
        if (only.type !== "ArrayLiteral") {
          throw listOperandError(name, only.pos);
        }
        return { [name]: _generate(only, ctx) };
      }
      return { [name]: generateVariadicArgs(args, ctx) };
    }

    case "flex": {
      // Flex (has a single-value form): 1 arg → `{ $op: expr }`, 2+ → `{ $op: [a, b, ...] }`.
      if (args.length === 0) {
        throw new CodegenError(`Operator ${name} expects at least 1 argument`, pos);
      }
      if (args.length === 1) {
        return { [name]: _generate(args[0] as Expr, ctx) };
      }
      return { [name]: generateVariadicArgs(args, ctx) };
    }

    case "object": {
      if (args.length === 0) {
        throw new CodegenError(`Operator ${name} expects at least 1 argument`, pos);
      }
      const keys = shape.keys;
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < args.length; i++) {
        const key = keys[i];
        if (!key) {
          throw new CodegenError(
            `Operator ${name} received more positional arguments than expected (max ${keys.length})`,
            (args[i] as Expr | SpreadElement).pos,
          );
        }
        obj[key] = _generate(args[i] as Expr, ctx);
      }
      return { [name]: obj };
    }
  }
}

// Registry-miss path: the compiler can't know an unknown operator's shape, so it
// can't tell whether a single non-array value is invalid (HR3 only fires on what
// it KNOWS). Mirror `flex`: 1 arg → bare value, 2+ → array. (Spread is already
// rejected up-front by `generateOperatorCall`.)
function generateUnknownOperator(name: string, args: CallArg[], ctx: GenerateCtx): Record<string, unknown> {
  if (args.length === 0) {
    return { [name]: {} };
  }
  if (args.length === 1) {
    const only = args[0] as Expr;
    if (only.type === "ObjectLiteral") {
      return { [name]: generateStaticObjectEntries(only.entries, ctx) };
    }
    return { [name]: _generate(only, ctx) };
  }
  return { [name]: generateVariadicArgs(args, ctx) };
}

/**
 * Generate a variadic argument list, handling JS spread via `$concatArrays`.
 * Used by the JS-method lowerings (`Math.min`/`Math.max`, `Object.assign`) where
 * spread is idiomatic JS the developer already knows. The `$op(...)` escape hatch
 * does NOT reach here with a spread — `generateOperatorCall` rejects it up-front.
 *
 *   - all-non-spread args → a flat array
 *   - single spread arg → the spread's value (presumed to be an array)
 *   - mixed → `{ $concatArrays: [...] }`, non-spread args wrapped as single-element arrays.
 */
function generateVariadicArgs(args: CallArg[], ctx: GenerateCtx): unknown {
  const hasSpread = args.some((a) => a.type === "SpreadElement");
  if (!hasSpread) {
    return args.map((a) => _generate(a as Expr, ctx));
  }
  if (args.length === 1) {
    const only = args[0] as SpreadElement;
    return _generate(only.argument, ctx);
  }
  const parts = args.map((a) => (a.type === "SpreadElement" ? _generate(a.argument, ctx) : [_generate(a, ctx)]));
  return { $concatArrays: parts };
}

/** HR3: a list-only operator (no single-value form) was handed a lone non-array operand. */
function listOperandError(name: string, pos: number): CodegenError {
  return new CodegenError(
    `${name} operates on a list of operands — pass two or more (${name}(a, b)) or a single array (${name}([a, b])).`,
    pos,
  );
}

// JS-idiomatic spread alternative per operator, for the spread-rejection message.
// These operators have a JS form where spread IS supported (it lowers to the same
// MQL), so the error points the user straight at it instead of a dead end.
const SPREAD_JS_ALTERNATIVE: Record<string, string> = {
  $min: "use the JS form Math.min(...arr)",
  $max: "use the JS form Math.max(...arr)",
  $concatArrays: "use array spread ([...a, ...b]) or .concat()",
  $mergeObjects: "use object spread ({ ...a, ...b }) or Object.assign(...docs)",
};

function assertNoSpread(args: CallArg[], name: string, callPos: number): void {
  for (const a of args) {
    if (a.type === "SpreadElement") {
      const alt = SPREAD_JS_ALTERNATIVE[name];
      const fix = alt
        ? `${alt}, or pass a single array (${name}([a, b]))`
        : `pass operands directly (${name}(a, b)) or as a single array (${name}([a, b]))`;
      throw new CodegenError(`Spread (...) is not supported in ${name}(...) — ${fix}.`, a.pos ?? callPos);
    }
  }
}

// ── Template literals ─────────────────────────────────────────────────────────

/**
 * Compile a template literal to `$concat`. Empty quasis and adjacent expressions are
 * still emitted as literal strings to keep the structure faithful — MongoDB will see
 * exactly the chunks the user wrote.
 *
 * `\`hello, ${name}!\`` → `{ $concat: ["hello, ", expr_for_name, "!"] }`
 *
 * Non-string interpolations are wrapped with `$toString` to match JS semantics —
 * `\`count: ${$.n}\`` works whether `$.n` is a number or a string. Expressions that
 * are statically known to produce strings skip the wrap to keep output compact.
 *
 * Special case: a template with no expressions and a single quasi just returns that
 * string (so `\`hi\`` ≡ `"hi"`).
 */
function generateTemplateLiteral(quasis: string[], expressions: Expr[], ctx: GenerateCtx): unknown {
  if (expressions.length === 0) {
    return quasis[0] ?? "";
  }
  const parts: unknown[] = [];
  for (let i = 0; i < expressions.length; i++) {
    if (quasis[i] !== "") parts.push(quasis[i]);
    const expr = expressions[i];
    const gen = _generate(expr, ctx);
    // Template literals lower to `$concat`, which is null-poisoning. When the
    // interpolation's chain has `?.`, wrap with `$ifNull(v, "")` before
    // `$toString` so a missing field produces `""` rather than `null` (which
    // would collapse the whole template). JS would produce `"undefined"` here;
    // `""` is the saner empty for templates.
    const wrappedGen = chainHasOptional(expr) ? wrapIfNull(gen, "") : gen;
    parts.push(isStringProducing(expr) ? wrappedGen : { $toString: wrappedGen });
  }
  const tail = quasis[expressions.length];
  if (tail !== "") parts.push(tail);
  return { $concat: parts };
}

// ── Method calls ──────────────────────────────────────────────────────────────

function generateMethodCall(
  object: Expr,
  method: string,
  args: CallArg[],
  ctx: GenerateCtx,
  callPos: number,
  optional: boolean = false,
): unknown {
  // ── Set receiver: new Set(arr).intersection / union / difference / ... ─────
  if (object.type === "NewSet") {
    return generateSetMethodCall(object, method, args, ctx);
  }
  // ── Regex receiver: /pat/flags.test(str) / .exec(str) ──────────────────────
  if (object.type === "RegexLiteral") {
    return generateRegexMethodCall(object, method, args, ctx);
  }

  // When `?.` appears on this method call itself or anywhere in the receiver's
  // postfix chain, wrap the receiver with `$ifNull(v, neutral)` so the called
  // operator receives an empty value of the right type instead of null
  // (which would either error or poison downstream callers).
  const rawObj = _generate(object, ctx);
  const wrapReceiver = optional || chainHasOptional(object);
  const neutral = wrapReceiver ? neutralForMethod(method, object) : undefined;
  const genObj = neutral !== undefined ? wrapIfNull(rawObj, neutral) : rawObj;

  switch (method) {
    // ── String methods ──────────────────────────────────────────────────────
    case "trim":
      return { $trim: { input: genObj } };
    case "trimStart":
    case "trimLeft":
      return { $ltrim: { input: genObj } };
    case "trimEnd":
    case "trimRight":
      return { $rtrim: { input: genObj } };
    case "toLowerCase":
      return { $toLower: genObj };
    case "toUpperCase":
      return { $toUpper: genObj };
    case "substr": {
      const exprArgs = exprArgsOnly(args, "substr");
      checkArity("substr", { sig: "start[, count]", allowed: [1, 2] }, exprArgs.length, callPos);
      if (exprArgs.length === 1) {
        return { $substrCP: [genObj, _generate(exprArgs[0], ctx), { $strLenCP: genObj }] };
      }
      return { $substrCP: [genObj, _generate(exprArgs[0], ctx), _generate(exprArgs[1], ctx)] };
    }
    case "substring": {
      const exprArgs = exprArgsOnly(args, "substring");
      checkArity("substring", { sig: "start[, end]", allowed: [0, 1, 2] }, exprArgs.length, callPos);
      if (exprArgs.length === 0) return genObj;
      // JS .substring(s, e) takes end-exclusive; MQL $substrCP takes a length.
      // JS clamps negative indices to 0 (and would also swap if start > end —
      // we model the clamping but not the swap; see docs/specs/string-methods.md).
      const start = clampNonNegativeIndex(exprArgs[0], ctx);
      if (exprArgs.length === 1) {
        return { $substrCP: [genObj, start, foldedSubtract({ $strLenCP: genObj }, start)] };
      }
      const end = clampNonNegativeIndex(exprArgs[1], ctx);
      return { $substrCP: [genObj, start, clampNonNegativeLength(foldedSubtract(end, start))] };
    }
    case "charAt": {
      const exprArgs = exprArgsOnly(args, "charAt");
      checkArity("charAt", { sig: "index", exact: 1 }, exprArgs.length, callPos);
      return { $substrCP: [genObj, _generate(exprArgs[0], ctx), 1] };
    }
    case "split": {
      const exprArgs = exprArgsOnly(args, "split");
      checkArity("split", { sig: "separator", exact: 1 }, exprArgs.length, callPos);
      return { $split: [genObj, _generate(exprArgs[0], ctx)] };
    }
    case "startsWith": {
      const exprArgs = exprArgsOnly(args, "startsWith");
      checkArity("startsWith", { sig: "searchString", exact: 1 }, exprArgs.length, callPos);
      return { $eq: [{ $indexOfCP: [genObj, _generate(exprArgs[0], ctx)] }, 0] };
    }
    case "endsWith": {
      const exprArgs = exprArgsOnly(args, "endsWith");
      checkArity("endsWith", { sig: "searchString", exact: 1 }, exprArgs.length, callPos);
      const needle = _generate(exprArgs[0], ctx);
      // Compares the last N codepoints of the input with the needle, where N is the needle's length.
      return {
        $eq: [
          { $substrCP: [genObj, { $subtract: [{ $strLenCP: genObj }, { $strLenCP: needle }] }, { $strLenCP: needle }] },
          needle,
        ],
      };
    }
    case "indexOf": {
      const exprArgs = exprArgsOnly(args, "indexOf");
      checkArity("indexOf", { sig: "searchValue", exact: 1 }, exprArgs.length, callPos);
      rejectPredicateOnValueSearch(exprArgs[0], "indexOf", "findIndex");
      const needle = _generate(exprArgs[0], ctx);
      // Type-aware dispatch: known array → $indexOfArray; known string → $indexOfCP;
      // unknown → runtime $cond on $isArray so the right form runs at query time.
      if (isArrayProducing(object)) {
        return { $indexOfArray: [genObj, needle] };
      }
      if (isStringProducing(object)) {
        return { $indexOfCP: [genObj, needle] };
      }
      return cond({ $isArray: genObj }, { $indexOfArray: [genObj, needle] }, { $indexOfCP: [genObj, needle] });
    }
    case "lastIndexOf": {
      const exprArgs = exprArgsOnly(args, "lastIndexOf");
      checkArity("lastIndexOf", { sig: "searchValue", exact: 1 }, exprArgs.length, callPos);
      if (isStringProducing(object)) {
        throw new CodegenError(
          `.lastIndexOf() on strings isn't supported — MongoDB's \$indexOfCP is forward-only. Use \$op($indexOfCP, str, needle) for first-match indexing.`,
          callPos,
        );
      }
      const needle = _generate(exprArgs[0], ctx);
      // Find the first match in the reversed array, then map back to the original index.
      // Wrap with $let so genObj is evaluated once.
      return {
        $let: {
          vars: { jsmqlArr: genObj },
          in: {
            $let: {
              vars: { jsmqlRevIdx: { $indexOfArray: [{ $reverseArray: "$$jsmqlArr" }, needle] } },
              in: cond({ $eq: ["$$jsmqlRevIdx", -1] }, -1, {
                $subtract: [{ $subtract: [{ $size: "$$jsmqlArr" }, 1] }, "$$jsmqlRevIdx"],
              }),
            },
          },
        },
      };
    }
    case "replace": {
      const exprArgs = exprArgsOnly(args, "replace");
      checkArity("replace", { sig: "find, replacement", exact: 2 }, exprArgs.length, callPos);
      return {
        $replaceOne: { input: genObj, find: _generate(exprArgs[0], ctx), replacement: _generate(exprArgs[1], ctx) },
      };
    }
    case "replaceAll": {
      const exprArgs = exprArgsOnly(args, "replaceAll");
      checkArity("replaceAll", { sig: "find, replacement", exact: 2 }, exprArgs.length, callPos);
      return {
        $replaceAll: { input: genObj, find: _generate(exprArgs[0], ctx), replacement: _generate(exprArgs[1], ctx) },
      };
    }
    case "includes": {
      const exprArgs = exprArgsOnly(args, "includes");
      checkArity("includes", { sig: "searchValue", exact: 1 }, exprArgs.length, callPos);
      rejectPredicateOnValueSearch(exprArgs[0], "includes", "some");
      const needle = _generate(exprArgs[0], ctx);
      // Type-aware dispatch: known array → $in; known string → $indexOfCP form;
      // unknown → runtime $cond so a bare $.field works for either type.
      if (isArrayProducing(object)) {
        return { $in: [needle, genObj] };
      }
      if (isStringProducing(object)) {
        return { $gte: [{ $indexOfCP: [genObj, needle] }, 0] };
      }
      return cond({ $isArray: genObj }, { $in: [needle, genObj] }, { $gte: [{ $indexOfCP: [genObj, needle] }, 0] });
    }
    case "match": {
      const exprArgs = exprArgsOnly(args, "match");
      checkArity("match", { sig: "regex", exact: 1 }, exprArgs.length, callPos);
      const pattern = exprArgs[0];
      if (pattern.type === "RegexLiteral") {
        const result: Record<string, unknown> = { input: genObj, regex: pattern.pattern };
        const opts = mongoRegexOptions(pattern.flags);
        if (opts) result["options"] = opts;
        return { $regexMatch: result };
      }
      return { $regexMatch: { input: genObj, regex: _generate(pattern, ctx) } };
    }
    case "matchAll": {
      const exprArgs = exprArgsOnly(args, "matchAll");
      checkArity("matchAll", { sig: "regex", exact: 1 }, exprArgs.length, callPos);
      const pattern = exprArgs[0];
      if (pattern.type === "RegexLiteral") {
        if (!pattern.flags.includes("g")) {
          throw new CodegenError(
            `.matchAll() requires a regex with the 'g' flag (matching JS's TypeError on non-global regex)`,
            callPos,
          );
        }
        const result: Record<string, unknown> = { input: genObj, regex: pattern.pattern };
        // Drop the required `g` (and any other JS-only flag) — `$regexFindAll`
        // is inherently global, and `g` is not a valid MongoDB option.
        const opts = mongoRegexOptions(pattern.flags);
        if (opts) result["options"] = opts;
        return { $regexFindAll: result };
      }
      return { $regexFindAll: { input: genObj, regex: _generate(pattern, ctx) } };
    }
    case "search": {
      const exprArgs = exprArgsOnly(args, "search");
      checkArity("search", { sig: "regex", exact: 1 }, exprArgs.length, callPos);
      const pattern = exprArgs[0];
      // .search returns the index of the first match, or -1. $regexFind returns
      // an object with .idx for matches; null on no match. We surface .idx with
      // an $ifNull fallback to -1 to match JS semantics exactly.
      const searchOpts = pattern.type === "RegexLiteral" ? mongoRegexOptions(pattern.flags) : "";
      const findCall =
        pattern.type === "RegexLiteral"
          ? {
              $regexFind: searchOpts
                ? { input: genObj, regex: pattern.pattern, options: searchOpts }
                : { input: genObj, regex: pattern.pattern },
            }
          : { $regexFind: { input: genObj, regex: _generate(pattern, ctx) } };
      return { $ifNull: [{ $getField: { field: "idx", input: findCall } }, -1] };
    }
    case "padStart":
    case "padEnd": {
      const exprArgs = exprArgsOnly(args, method);
      checkArity(method, { sig: "targetLength[, padString]", allowed: [1, 2] }, exprArgs.length, callPos);
      const target = _generate(exprArgs[0], ctx);
      const pad = exprArgs.length === 2 ? _generate(exprArgs[1], ctx) : " ";
      // If str length >= target, return str. Otherwise build pad-str of (target - len)
      // chars by reducing $range, then concat str on the appropriate side.
      const padReduce = {
        $reduce: {
          input: { $range: [0, { $subtract: [target, { $strLenCP: "$$s" }] }] },
          initialValue: "",
          in: { $concat: ["$$value", pad] },
        },
      };
      const concatOrder = method === "padStart" ? [padReduce, "$$s"] : ["$$s", padReduce];
      return {
        $let: {
          vars: { s: genObj },
          in: cond({ $gte: [{ $strLenCP: "$$s" }, target] }, "$$s", { $concat: concatOrder }),
        },
      };
    }
    case "repeat": {
      const exprArgs = exprArgsOnly(args, "repeat");
      checkArity("repeat", { sig: "count", exact: 1 }, exprArgs.length, callPos);
      const count = _generate(exprArgs[0], ctx);
      return { $reduce: { input: { $range: [0, count] }, initialValue: "", in: { $concat: ["$$value", genObj] } } };
    }

    // ── Array methods (no lambda) ───────────────────────────────────────────
    case "at": {
      const exprArgs = exprArgsOnly(args, "at");
      checkArity("at", { sig: "index", exact: 1 }, exprArgs.length, callPos);
      return { $arrayElemAt: [genObj, _generate(exprArgs[0], ctx)] };
    }
    case "slice": {
      const exprArgs = exprArgsOnly(args, "slice");
      checkArity("slice", { sig: "start[, end]", allowed: [0, 1, 2] }, exprArgs.length, callPos);
      // Receiver-type dispatch: known array → $slice (native negative-index support);
      // known string → $substrCP (with compile-time/runtime normalisation of negatives);
      // unknown → runtime $cond on $isArray so a bare $.field works for either type.
      if (isStringProducing(object)) return sliceString(genObj, exprArgs, ctx);
      if (isArrayProducing(object)) return sliceArray(genObj, exprArgs, ctx);
      return cond({ $isArray: genObj }, sliceArray(genObj, exprArgs, ctx), sliceString(genObj, exprArgs, ctx));
    }
    case "toReversed": {
      checkArity(method, { sig: "", none: true }, args.length, callPos);
      return { $reverseArray: genObj };
    }
    case "toSorted": {
      if (args.length === 0) {
        return { $sortArray: { input: genObj, sortBy: 1 } };
      }
      const exprArgs = exprArgsOnly(args, "toSorted");
      checkArity("toSorted", { sig: "keyFn", allowed: [0, 1] }, exprArgs.length, callPos);
      const sortBy = lambdaToSortBy(exprArgs[0], "toSorted");
      return { $sortArray: { input: genObj, sortBy } };
    }
    case "toSpliced": {
      const exprArgs = exprArgsOnly(args, "toSpliced");
      checkArity("toSpliced", { sig: "start[, deleteCount, ...items]", atLeast: 1 }, exprArgs.length, callPos);
      const startArg = exprArgs[0];
      if (isNegativeLiteral(startArg)) {
        throw new CodegenError(
          `.toSpliced() with a negative start index isn't supported — MongoDB \$slice's position arg is non-negative.`,
          startArg.pos,
        );
      }
      const start = _generate(startArg, ctx);
      // deleteCount omitted ⇒ remove to end. Match JS exactly.
      const hasDeleteCount = exprArgs.length >= 2;
      const deleteCountArg = hasDeleteCount ? exprArgs[1] : null;
      if (deleteCountArg && isNegativeLiteral(deleteCountArg)) {
        throw new CodegenError(
          `.toSpliced() with a negative deleteCount isn't supported — MongoDB \$slice's length arg is non-negative.`,
          deleteCountArg.pos,
        );
      }
      const items = exprArgs.slice(2).map((a) => _generate(a, ctx));
      // Bind arr/start/end once: $let so size & arithmetic are computed a single time.
      // tailStart = start + deleteCount, or just start if deleteCount omitted (no removal, pure insert).
      // tailLen = $size - tailStart, clamped non-negative.
      const tailStart = hasDeleteCount ? { $add: ["$$jsmqlStart", _generate(deleteCountArg!, ctx)] } : "$$jsmqlStart";
      return {
        $let: {
          vars: { jsmqlArr: genObj, jsmqlStart: start },
          in: {
            $let: {
              vars: { jsmqlTailStart: tailStart },
              in: {
                $concatArrays: [
                  { $slice: ["$$jsmqlArr", 0, "$$jsmqlStart"] },
                  items,
                  {
                    $slice: [
                      "$$jsmqlArr",
                      "$$jsmqlTailStart",
                      { $max: [0, { $subtract: [{ $size: "$$jsmqlArr" }, "$$jsmqlTailStart"] }] },
                    ],
                  },
                ],
              },
            },
          },
        },
      };
    }
    case "with": {
      const exprArgs = exprArgsOnly(args, "with");
      checkArity("with", { sig: "index, value", exact: 2 }, exprArgs.length, callPos);
      const idxArg = exprArgs[0];
      if (isNegativeLiteral(idxArg)) {
        throw new CodegenError(
          `.with() with a negative index isn't supported — MongoDB \$slice's position arg is non-negative.`,
          idxArg.pos,
        );
      }
      const idx = _generate(idxArg, ctx);
      const value = _generate(exprArgs[1], ctx);
      return {
        $let: {
          vars: { jsmqlArr: genObj, jsmqlIdx: idx, jsmqlVal: value },
          in: {
            $concatArrays: [
              { $slice: ["$$jsmqlArr", 0, "$$jsmqlIdx"] },
              ["$$jsmqlVal"],
              {
                $slice: [
                  "$$jsmqlArr",
                  { $add: ["$$jsmqlIdx", 1] },
                  { $max: [0, { $subtract: [{ $size: "$$jsmqlArr" }, { $add: ["$$jsmqlIdx", 1] }] }] },
                ],
              },
            ],
          },
        },
      };
    }
    case "findLast": {
      const lambda = requireLambda(exprArgsOnly(args, "findLast"), "findLast", callPos, ctx);
      const iter = arrayIterInput(lambda, genObj, ctx, "findLast", object);
      const cond = iter.wrap(jsBoolIfNeeded(lambdaResult(lambda), genLambdaBody(lambda, iter.bodyCtx)));
      if (!iter.paired) {
        return { $arrayElemAt: [{ $filter: { input: iter.input, as: iter.asName, cond } }, -1] };
      }
      return { $arrayElemAt: [{ $arrayElemAt: [{ $filter: { input: iter.input, as: iter.asName, cond } }, -1] }, 1] };
    }
    case "findIndex":
    case "findLastIndex": {
      const lambda = requireLambda(exprArgsOnly(args, method), method, callPos, ctx);
      if (lambda.params.length >= 3) {
        throw new CodegenError(
          `.${method}() callbacks take at most 2 parameters (element, index); the third 'array' argument isn't supported. Reference the receiver directly instead.`,
          lambda.pos,
        );
      }
      const bodyCtx = elementTypedCtx(ctx, lambda.params, object);
      // Reduce over [(index, element), ...] pairs. $let rebinds the user-named
      // params to the pair components so the predicate body's $$<param>
      // references resolve correctly. For findIndex we want the *first* match —
      // guard the update with `$$value == -1` so later matches don't overwrite.
      // For findLastIndex any match overwrites, so the final value is the last.
      const vars: Record<string, unknown> = { [lambda.params[0]]: { $arrayElemAt: ["$$this", 1] } };
      if (lambda.params[1]) {
        vars[lambda.params[1]] = { $arrayElemAt: ["$$this", 0] };
      }
      const predicate = jsBoolIfNeeded(lambdaResult(lambda), genLambdaBody(lambda, bodyCtx));
      const test = method === "findIndex" ? { $and: [{ $eq: ["$$value", -1] }, predicate] } : predicate;
      return {
        $reduce: {
          input: { $zip: { inputs: [{ $range: [0, { $size: genObj }] }, genObj] } },
          initialValue: -1,
          in: { $let: { vars, in: cond(test, { $arrayElemAt: ["$$this", 0] }, "$$value") } },
        },
      };
    }
    case "concat": {
      // Type-aware: known array → $concatArrays; known string → $concat;
      // unknown → runtime $cond on $isArray so the right form runs at query time.
      checkArity("concat", { sig: "...items", atLeast: 1 }, args.length, callPos);
      const tail = args.map((a) => (a.type === "SpreadElement" ? _generate(a.argument, ctx) : _generate(a, ctx)));
      if (isArrayProducing(object)) {
        return { $concatArrays: [genObj, ...tail] };
      }
      if (isStringProducing(object)) {
        return { $concat: [genObj, ...tail] };
      }
      return cond({ $isArray: genObj }, { $concatArrays: [genObj, ...tail] }, { $concat: [genObj, ...tail] });
    }
    case "join": {
      const exprArgs = exprArgsOnly(args, "join");
      checkArity("join", { sig: "separator", allowed: [0, 1] }, exprArgs.length, callPos);
      const sep = exprArgs.length === 1 ? _generate(exprArgs[0], ctx) : ",";
      // Reduce: concatenate elements with the separator, omitting it for the first element.
      // The accumulator carries the running string; an empty start lets us detect "first".
      return {
        $reduce: {
          input: genObj,
          initialValue: "",
          in: cond(
            { $eq: ["$$value", ""] },
            { $toString: "$$this" },
            { $concat: ["$$value", sep, { $toString: "$$this" }] },
          ),
        },
      };
    }
    case "toString": {
      checkArity("toString", { sig: "", none: true }, args.length, callPos);
      // JS Array.prototype.toString is `.join(",")`. For known string receivers
      // this is a no-op. For other scalars MongoDB's $toString covers it
      // (numbers, dates → ISO string, booleans, ObjectId, etc.).
      if (isArrayProducing(object)) {
        return {
          $reduce: {
            input: genObj,
            initialValue: "",
            in: cond(
              { $eq: ["$$value", ""] },
              { $toString: "$$this" },
              { $concat: ["$$value", ",", { $toString: "$$this" }] },
            ),
          },
        };
      }
      if (isStringProducing(object)) {
        return genObj;
      }
      return { $toString: genObj };
    }
    case "flat": {
      const exprArgs = exprArgsOnly(args, "flat");
      checkArity("flat", { sig: "depth", allowed: [0, 1] }, exprArgs.length, callPos);
      // We only support depth=1 (default). MongoDB has no recursive-depth flatten;
      // emulating arbitrary depths would require unbounded $reduce nesting.
      if (exprArgs.length === 1) {
        const arg = exprArgs[0];
        if (arg.type !== "NumberLiteral" || arg.value !== 1) {
          throw new CodegenError(
            `.flat() only supports depth=1 (the default). MongoDB has no recursive flatten primitive.`,
            callPos,
          );
        }
      }
      return { $reduce: { input: genObj, initialValue: [], in: { $concatArrays: ["$$value", "$$this"] } } };
    }
    case "flatMap": {
      const lambda = requireLambda(exprArgsOnly(args, "flatMap"), "flatMap", callPos, ctx);
      const iter = arrayIterInput(lambda, genObj, ctx, "flatMap", object);
      return {
        $reduce: {
          input: { $map: { input: iter.input, as: iter.asName, in: iter.wrap(genLambdaBody(lambda, iter.bodyCtx)) } },
          initialValue: [],
          in: { $concatArrays: ["$$value", "$$this"] },
        },
      };
    }

    // ── Array methods (lambda) ──────────────────────────────────────────────
    case "map": {
      const lambda = requireLambda(exprArgsOnly(args, "map"), "map", callPos, ctx);
      const iter = arrayIterInput(lambda, genObj, ctx, "map", object);
      return { $map: { input: iter.input, as: iter.asName, in: iter.wrap(genLambdaBody(lambda, iter.bodyCtx)) } };
    }
    case "filter": {
      const lambda = requireLambda(exprArgsOnly(args, "filter"), "filter", callPos, ctx);
      const iter = arrayIterInput(lambda, genObj, ctx, "filter", object);
      const cond = iter.wrap(jsBoolIfNeeded(lambdaResult(lambda), genLambdaBody(lambda, iter.bodyCtx)));
      if (!iter.paired) {
        return { $filter: { input: iter.input, as: iter.asName, cond } };
      }
      // Paired (index used): filter the (index, element) pairs, then project
      // back to elements.
      return {
        $map: {
          input: { $filter: { input: iter.input, as: iter.asName, cond } },
          as: "jsmqlPair",
          in: { $arrayElemAt: ["$$jsmqlPair", 1] },
        },
      };
    }
    case "find": {
      const lambda = requireLambda(exprArgsOnly(args, "find"), "find", callPos, ctx);
      const iter = arrayIterInput(lambda, genObj, ctx, "find", object);
      const cond = iter.wrap(jsBoolIfNeeded(lambdaResult(lambda), genLambdaBody(lambda, iter.bodyCtx)));
      if (!iter.paired) {
        return { $arrayElemAt: [{ $filter: { input: iter.input, as: iter.asName, cond } }, 0] };
      }
      // Paired (index used): find first matching pair, then extract its element.
      return { $arrayElemAt: [{ $arrayElemAt: [{ $filter: { input: iter.input, as: iter.asName, cond } }, 0] }, 1] };
    }
    case "some": {
      const lambda = requireLambda(exprArgsOnly(args, "some"), "some", callPos, ctx);
      const iter = arrayIterInput(lambda, genObj, ctx, "some", object);
      return {
        $anyElementTrue: {
          $map: {
            input: iter.input,
            as: iter.asName,
            in: iter.wrap(jsBoolIfNeeded(lambdaResult(lambda), genLambdaBody(lambda, iter.bodyCtx))),
          },
        },
      };
    }
    case "every": {
      const lambda = requireLambda(exprArgsOnly(args, "every"), "every", callPos, ctx);
      const iter = arrayIterInput(lambda, genObj, ctx, "every", object);
      return {
        $allElementsTrue: {
          $map: {
            input: iter.input,
            as: iter.asName,
            in: iter.wrap(jsBoolIfNeeded(lambdaResult(lambda), genLambdaBody(lambda, iter.bodyCtx))),
          },
        },
      };
    }
    case "reduce":
    case "reduceRight": {
      const exprArgs = exprArgsOnly(args, method);
      checkArity(method, { sig: "lambda, initialValue", exact: 2 }, exprArgs.length, callPos);
      const lambda = requireLambda(exprArgs, method, callPos, ctx);
      if (lambda.params.length < 2 || lambda.params.length > 3) {
        throw new CodegenError(
          `.${method}() lambda must have 2 or 3 parameters (accumulator, element[, index])`,
          callPos,
        );
      }
      // Narrow the accumulator's type when initialValue and body agree on a
      // compound type. `$$value` after iteration i ≥ 1 is the body's return
      // from iteration i-1, not the initialValue — so narrowing on the initial
      // alone would be unsound (`reduce((a,x)=>x.foo, {})` keeps the cond
      // because `a` becomes `x.foo` after the first step). When both agree the
      // type is invariant across iterations; the IndexAccess case reads this
      // to skip the runtime $isArray dispatch.
      const accType: "object" | "array" | undefined =
        isObjectProducing(exprArgs[1]) && isObjectProducing(lambdaResult(lambda))
          ? "object"
          : isArrayProducing(exprArgs[1]) && isArrayProducing(lambdaResult(lambda))
            ? "array"
            : undefined;
      const nextBindingTypes = new Map(ctx.bindingTypes ?? []);
      if (accType) nextBindingTypes.set(lambda.params[0], accType);
      else nextBindingTypes.delete(lambda.params[0]);
      // The element parameter (params[1]) inherits the input array's static
      // element type, mirroring the map-family narrowing. The optional index
      // parameter (params[2]) is a number — only ever cleared, so an outer
      // same-named binding can't leak in.
      const elemType = arrayElementType(object);
      if (elemType) nextBindingTypes.set(lambda.params[1], elemType);
      else nextBindingTypes.delete(lambda.params[1]);
      if (lambda.params[2]) nextBindingTypes.delete(lambda.params[2]);
      const has3 = lambda.params.length === 3;
      // 2-param: acc → value, element → this (status quo).
      // 3-param: acc → value still, but element + index come from $$this being
      // an (index, element) pair — body wraps in $let to expose both names.
      const reduceCtx: GenerateCtx = {
        lambdaParams: new Set([...ctx.lambdaParams, ...lambda.params]),
        reduceRemap: has3
          ? new Map([[lambda.params[0], "value"]])
          : new Map([
              [lambda.params[0], "value"],
              [lambda.params[1], "this"],
            ]),
        pipelineLets: ctx.pipelineLets,
        droppedLets: ctx.droppedLets,
        bindingTypes: nextBindingTypes,
        functions: ctx.functions,
        expandingFns: ctx.expandingFns,
      };
      const baseBody = genLambdaBody(lambda, reduceCtx);
      const inExpr = has3
        ? {
            $let: {
              vars: {
                [safeVarName(lambda.params[1])]: { $arrayElemAt: ["$$this", 1] },
                [safeVarName(lambda.params[2])]: { $arrayElemAt: ["$$this", 0] },
              },
              in: baseBody,
            },
          }
        : baseBody;
      // reduceRight: reverse the input (or the zipped pairs) so iteration runs
      // right-to-left. The zip happens BEFORE the reverse so each pair's index
      // still reflects the original array position (matching JS).
      let input: unknown = genObj;
      if (has3) {
        input = { $zip: { inputs: [{ $range: [0, { $size: genObj }] }, genObj] } };
      }
      if (method === "reduceRight") {
        input = { $reverseArray: input };
      }
      return { $reduce: { input, initialValue: _generate(exprArgs[1], ctx), in: inExpr } };
    }

    // ── Date methods ────────────────────────────────────────────────────────
    case "getFullYear":
      return { $year: genObj };
    case "getMonth":
      // 0-based: MongoDB $month is 1-based
      return { $subtract: [{ $month: genObj }, 1] };
    case "getDate":
      return { $dayOfMonth: genObj };
    case "getDay":
      // 0-based: MongoDB $dayOfWeek is 1-based (Sunday=1)
      return { $subtract: [{ $dayOfWeek: genObj }, 1] };
    case "getHours":
      return { $hour: genObj };
    case "getMinutes":
      return { $minute: genObj };
    case "getSeconds":
      return { $second: genObj };
    case "getMilliseconds":
      return { $millisecond: genObj };
    case "getTime":
      // Match JS: ms since epoch
      return { $toLong: genObj };
    case "toISOString":
      return { $dateToString: { date: genObj, format: "%Y-%m-%dT%H:%M:%S.%LZ" } };

    // ── DX shims: mutating Array methods ────────────────────────────────────
    // These all mutate the receiver in JavaScript. In expression position
    // jsmql is immutable, so we surface a tailored "use the immutable
    // equivalent" message. At statement position (a top-level pipeline
    // statement on a field-path receiver), `tryRewriteMutatorCall` rewrites
    // the call to `$.<field> = $.<field>.<immutable>(...)` before codegen
    // sees it — so reaching these throws means the user used a mutator in
    // expression position.
    case "sort":
      throw new CodegenError(
        `.sort() mutates the array in JavaScript. In expression position, use '.toSorted()' — or call it at statement position (top-level on a '$.<field>' receiver) to mutate the field.`,
        callPos,
      );
    case "reverse":
      throw new CodegenError(
        `.reverse() mutates the array in JavaScript. In expression position, use '.toReversed()' — or call it at statement position (top-level on a '$.<field>' receiver) to mutate the field.`,
        callPos,
      );
    case "splice":
      throw new CodegenError(
        `.splice() mutates the array in JavaScript. In expression position, use '.toSpliced(start, deleteCount, ...items)' — or call it at statement position (top-level on a '$.<field>' receiver) to mutate the field.`,
        callPos,
      );
    case "push":
      throw new CodegenError(
        `.push() mutates the array in JavaScript. In expression position, use '.concat(x)' or spread '[...arr, x]' — or call it at statement position (top-level on a '$.<field>' receiver) to mutate the field.`,
        callPos,
      );
    case "pop":
      throw new CodegenError(
        `.pop() mutates the array in JavaScript. In expression position, use '.at(-1)' to read the last element or '.slice(0, -1)' for everything-but-last — or call it at statement position (top-level on a '$.<field>' receiver) to drop the last element.`,
        callPos,
      );
    case "shift":
      throw new CodegenError(
        `.shift() mutates the array in JavaScript. In expression position, use '.at(0)' to read the first element or '.slice(1)' for everything-but-first — or call it at statement position (top-level on a '$.<field>' receiver) to drop the first element.`,
        callPos,
      );
    case "unshift":
      throw new CodegenError(
        `.unshift() mutates the array in JavaScript. In expression position, use '.concat()' with the new items first or spread '[...newItems, ...arr]' — or call it at statement position (top-level on a '$.<field>' receiver) to prepend in place.`,
        callPos,
      );
    case "fill":
      throw new CodegenError(
        `.fill() mutates the array in JavaScript. In expression position there is no direct immutable replacement (build from a $range or pass a pre-filled array as a parameter) — or call it at statement position (top-level on a '$.<field>' receiver) to fill the field in place.`,
        callPos,
      );
    case "copyWithin":
      throw new CodegenError(
        `.copyWithin() mutates the array in JavaScript; jsmql expressions are immutable. Call it at statement position (top-level on a '$.<field>' receiver) to copy-within the field in place, or compose '.slice()' calls with '$concatArrays' for an inline expression.`,
        callPos,
      );

    // ── DX shims: iterator / void / locale methods ──────────────────────────
    // None of these have a sensible lowering to an MQL expression. Throw a
    // pointed error explaining why, with a workaround when one exists.
    case "forEach":
      throw new CodegenError(
        `.forEach() returns undefined in JavaScript; jsmql expressions must produce a value. Use '.map(...)' to transform, or move side-effecting work outside the query.`,
        callPos,
      );
    case "entries":
      throw new CodegenError(
        `.entries() returns an iterator in JavaScript and has no MongoDB equivalent. Use '.map((v, i) => [i, v])' if you want [index, value] pairs as an array.`,
        callPos,
      );
    case "keys":
      throw new CodegenError(
        `.keys() returns an iterator in JavaScript and has no MongoDB equivalent. Use '$op($range, 0, $op($size, arr))' if you want the index array.`,
        callPos,
      );
    case "values":
      throw new CodegenError(
        `.values() returns an iterator in JavaScript and has no MongoDB equivalent. The array itself is already the value sequence — use it directly.`,
        callPos,
      );
    case "toLocaleString":
      throw new CodegenError(
        `.toLocaleString() is locale-dependent and isn't expressible as a MongoDB expression. Use '.join(...)' with explicit formatting, or '$dateToString' for dates.`,
        callPos,
      );

    default: {
      const hint = didYouMean(method, KNOWN_METHODS);
      throw new CodegenError(`Unknown method '.${method}()'.${hint}`, callPos);
    }
  }
}

/** True for `-N` literal expressions in either AST shape (`NumberLiteral(-N)` or
 *  `UnaryExpr(-, NumberLiteral(N))`). Used by `.toSpliced` / `.with` to reject
 *  negative literals at compile time — MongoDB's `$slice` position/length args
 *  are non-negative and a runtime check would surprise users with confusing MQL. */
function isNegativeLiteral(e: Expr): boolean {
  if (e.type === "NumberLiteral") return e.value < 0;
  if (e.type === "UnaryExpr" && e.op === "-" && e.operand.type === "NumberLiteral") {
    return e.operand.value > 0;
  }
  return false;
}

/**
 * Lower a callback's input shape so the body can reference `(element, index)` —
 * the JS callback signature for `.map`, `.filter`, `.find`, `.findLast`,
 * `.some`, `.every`, `.flatMap` (matching MDN).
 *
 * - 1-param `x => …`: status quo. `as` is the user's name; the body's `$$x` is
 *   bound directly by `$map` / `$filter`.
 * - 2-param `(x, i) => …`: iterate over `$zip([$range(0..size), arr])` so each
 *   element is paired with its index. `as` becomes a synthetic `jsmqlPair`; a
 *   `$let` wrapper rebinds the user's names to the pair components. Picking a
 *   synthetic name (rather than reusing one of the user's params) keeps the
 *   shape uniform and avoids per-method collision checks.
 * - ≥3 params: rejected. The third `array` argument from JS would mean leaking
 *   the receiver into every iteration, which has no real use case.
 */
function arrayIterInput(
  lambda: Extract<Expr, { type: "Lambda" }>,
  genObj: unknown,
  ctx: GenerateCtx,
  method: string,
  inputExpr?: Expr,
): { input: unknown; asName: string; bodyCtx: GenerateCtx; wrap: (body: unknown) => unknown; paired: boolean } {
  const params = lambda.params;
  if (params.length > 3) {
    throw new CodegenError(
      `.${method}() callbacks take at most 3 parameters (element, index, array); got ${params.length}.`,
      lambda.pos,
    );
  }
  const arrayParam = params.length === 3 ? params[2] : undefined;
  // The 3rd 'array' callback param (JS's `(el, i, arr)`) is the iterated array
  // itself — i.e. this method's input. Typed as an array so `arr.length` lowers
  // to `$size`. Strict-JS semantics fall out: in a `.filter(...).map((el,i,arr)
  // => …)` chain, `genObj` for the `.map` is the `.filter` result, so `arr` is
  // the post-filter array, exactly as in JS.
  const elementCtx = elementTypedCtx(ctx, params, inputExpr);
  const bodyCtx = arrayParam
    ? { ...elementCtx, bindingTypes: new Map([...(elementCtx.bindingTypes ?? []), [arrayParam, "array" as const]]) }
    : elementCtx;
  const asName = params[0] ? safeVarName(params[0]) : "v";

  // The `$zip`/`$range` index machinery is only worth emitting when the index
  // param is *actually referenced* (at any depth). When it isn't — including the
  // common `(el, i, arr) => …arr…` case where `i` is only there positionally to
  // reach the array param — emit the plain `$map`/`$filter`, binding the array
  // param (if any) with a thin `$let`.
  const indexUsed = params.length >= 2 && someExpr(lambda, (e) => e.type === "ParamRef" && e.name === params[1]);
  if (!indexUsed) {
    const wrap = arrayParam
      ? (body: unknown) => ({ $let: { vars: { [safeVarName(arrayParam)]: genObj }, in: body } })
      : (body: unknown) => body;
    return { input: genObj, asName, bodyCtx, wrap, paired: false };
  }

  return {
    input: { $zip: { inputs: [{ $range: [0, { $size: genObj }] }, genObj] } },
    asName: "jsmqlPair",
    bodyCtx,
    paired: true,
    wrap: (body) => ({
      $let: {
        vars: {
          [safeVarName(params[0])]: { $arrayElemAt: ["$$jsmqlPair", 1] },
          [safeVarName(params[1])]: { $arrayElemAt: ["$$jsmqlPair", 0] },
          ...(arrayParam ? { [safeVarName(arrayParam)]: genObj } : {}),
        },
        in: body,
      },
    }),
  };
}

/**
 * Translate a `.toSorted(keyFn)` / `.sort(keyFn)` callback into the `sortBy`
 * value MongoDB's `$sortArray` expects.
 *
 * Supported callback shapes (the key-function form):
 *   - `x => x.path` → `{ "path": 1 }`            (ascending, dotted nested paths welcome)
 *   - `x => -x.path` → `{ "path": -1 }`          (descending, unary `-` only)
 *
 * Everything else — comparator-style `(a, b) => …`, arithmetic on the key,
 * computed indices, 0-param or ≥2-param arrows — is rejected with a pointer at
 * the `$op($sortArray, { input, sortBy })` escape hatch.
 */
function lambdaToSortBy(arg: Expr, method: string): Record<string, 1 | -1> {
  if (arg.type !== "Lambda") {
    throw new CodegenError(
      `.${method}() supports 0 or 1 arguments — an optional key function 'x => x.path' or 'x => -x.path'. For comparator-style sorts use $op($sortArray, { input, sortBy }).`,
      arg.pos,
    );
  }
  if (arg.body === undefined) {
    throw new CodegenError(
      `.${method}() does not accept a block-body arrow — pass an expression-body key function like 'x => x.field'.`,
      arg.pos,
    );
  }
  if (arg.params.length !== 1) {
    throw new CodegenError(
      `.${method}() key function takes exactly 1 parameter ('x => x.field'). For comparator-style sorts use $op($sortArray, { input, sortBy }).`,
      arg.pos,
    );
  }
  const param = arg.params[0];
  let body = arg.body;
  let direction: 1 | -1 = 1;
  if (body.type === "UnaryExpr" && body.op === "-") {
    direction = -1;
    body = body.operand;
  }
  const path = paramKeyPath(body, param);
  if (path === null) {
    throw new CodegenError(
      `.${method}() key function body must be '${param}.<field>' (optionally negated). For more complex sort criteria use $op($sortArray, { input, sortBy }).`,
      arg.body.pos,
    );
  }
  return { [path]: direction };
}

/**
 * If `expr` is a `MemberAccess` chain rooted at `ParamRef(param)`, return the
 * dotted key path (e.g. `MemberAccess(MemberAccess(ParamRef("x"), "user"), "name")`
 * with `param = "x"` → `"user.name"`). Otherwise null.
 */
function paramKeyPath(expr: Expr, param: string): string | null {
  if (expr.type === "ParamRef" && expr.name === param) {
    // `x => x` — sort by self isn't a valid sortBy key (an empty object key).
    return null;
  }
  if (expr.type === "MemberAccess") {
    const base = paramKeyPath(expr.object, param);
    if (expr.object.type === "ParamRef" && expr.object.name === param) {
      return expr.member;
    }
    if (base !== null) return `${base}.${expr.member}`;
  }
  return null;
}

// ── Mutating-method rewrite (statement-position desugar) ──────────────────────
//
// In JavaScript the array mutators (`.sort`, `.reverse`, `.push`, `.pop`,
// `.shift`, `.unshift`, `.splice`, `.fill`) modify the receiver in place and
// return either the array itself or the removed element(s). MQL pipelines are
// declaratively immutable, so we surface these as `$set` stages when — and
// only when — the call appears at statement position with a writable
// field-path receiver. The rewrite materialises a synthetic `AssignExpr`
// (`$.<field> = $.<field>.<immutable equivalent>(...)`) and hands it to the
// existing UpdateOp coalescer, so chained mutations on the same field
// compose through the same read-after-write logic explicit `=` already uses.
//
// Expression-position calls (anywhere inside a larger expression, sub-pipeline,
// `$match` body, etc.) and statement-position calls on non-field-path
// receivers fall through to the dedicated throws in `generateMethodCall` —
// each one names the immutable variant the user should reach for instead.

const MUTATING_ARRAY_METHODS: ReadonlySet<string> = new Set([
  "sort",
  "reverse",
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "fill",
  "copyWithin",
]);

/**
 * Predicate: can `target` appear on the LHS of an `AssignExpr`? Mirrors the
 * parser's constraint for `$.<path> = <expr>` — a `FieldRef` with a non-empty
 * path, or a `MemberAccess` chain rooted at one. Bare `$` (path `""`) is the
 * `$replaceWith` sugar, not an assignable field.
 */
export function isWritableFieldPath(expr: Expr): boolean {
  if (expr.type === "FieldRef") return expr.path !== "";
  if (expr.type === "MemberAccess") return isWritableFieldPath(expr.object);
  return false;
}

export type MutatorRewrite = { kind: "rewrite"; assign: AssignExpr } | { kind: "passthrough" };

/**
 * If `expr` is a mutating array method on a writable field-path receiver,
 * return the synthesized `$.<field> = <immutable RHS>` `AssignExpr`. The RHS
 * AST is built from existing Expr node types so it flows through normal
 * codegen — there is no per-mutator branch in the lowering path.
 */
export function tryRewriteMutatorCall(expr: Expr): MutatorRewrite {
  if (expr.type !== "MethodCall") return { kind: "passthrough" };
  if (!MUTATING_ARRAY_METHODS.has(expr.method)) return { kind: "passthrough" };
  if (!isWritableFieldPath(expr.object)) return { kind: "passthrough" };
  const value = buildMutatorRhs(expr.method, expr.object, expr.args, expr.pos);
  return { kind: "rewrite", assign: { type: "AssignExpr", target: expr.object, value, pos: expr.pos } };
}

function buildMutatorRhs(method: string, object: Expr, args: CallArg[], pos: number): Expr {
  switch (method) {
    case "sort":
      // Delegate to the existing `.toSorted` lowering — including 0-arg ascending
      // form and 1-arg key-function form. The args list is forwarded as-is.
      return { type: "MethodCall", object, method: "toSorted", args, pos };
    case "reverse":
      checkArity("reverse", { sig: "", none: true }, args.length, pos);
      return { type: "MethodCall", object, method: "toReversed", args: [], pos };
    case "splice":
      return { type: "MethodCall", object, method: "toSpliced", args, pos };
    case "push": {
      // `arr.push(a, b)` → `arr.concat([a, b])`-style, but `.concat` flattens
      // arrays one level (JS spec), while `.push` does not. Emit
      // `$concatArrays: [arr, [a, b]]` directly so an array argument is added
      // as a single element, matching JS.
      const items: ArrayElement[] = args.map((a) => a as ArrayElement);
      const itemsArr: Expr = { type: "ArrayLiteral", elements: items, pos };
      return { type: "OperatorCall", name: "$concatArrays", style: "positional", args: [object, itemsArr], pos };
    }
    case "unshift": {
      const items: ArrayElement[] = args.map((a) => a as ArrayElement);
      const itemsArr: Expr = { type: "ArrayLiteral", elements: items, pos };
      return { type: "OperatorCall", name: "$concatArrays", style: "positional", args: [itemsArr, object], pos };
    }
    case "pop": {
      checkArity("pop", { sig: "", none: true }, args.length, pos);
      // `arr.slice(0, max(0, size - 1))` — everything-but-last with a clamp so
      // an empty input yields an empty output instead of `$slice([], 0, -1)`.
      const sizeExpr: Expr = mkOpCall("$size", [object], pos);
      const minus1: Expr = { type: "BinaryExpr", op: "-", left: sizeExpr, right: mkNumber(1, pos), pos };
      const clamped: Expr = mkOpCall("$max", [mkNumber(0, pos), minus1], pos);
      return mkOpCall("$slice", [object, mkNumber(0, pos), clamped], pos);
    }
    case "shift": {
      checkArity("shift", { sig: "", none: true }, args.length, pos);
      // `$slice: [arr, 1, $size(arr)]` — start at index 1 and take everything
      // remaining. MongoDB clamps `len` to what's actually available, so an
      // empty input yields an empty output.
      const sizeExpr: Expr = mkOpCall("$size", [object], pos);
      return mkOpCall("$slice", [object, mkNumber(1, pos), sizeExpr], pos);
    }
    case "fill":
      return buildFillRhs(object, args, pos);
    case "copyWithin":
      return buildCopyWithinRhs(object, args, pos);
  }
  return internalError(`tryRewriteMutatorCall: unhandled method '${method}'`, pos);
}

/**
 * `arr.copyWithin(target, start, end?)` — JS in-place sequence copy. We lower
 * to a recomposition: take the prefix [0, target), splice in arr[start, end),
 * then the suffix starting at target + len. The suffix len is the original
 * size minus (target + len), clamped to non-negative.
 *
 * We accept non-negative integer literals only (no JS negative-indexing or
 * runtime values) — consistent with `.slice` / `.toSpliced` / `.fill` on
 * statement-position mutators. Two-arg form (`target, start`) treats `end`
 * as the array's `$size` at runtime.
 */
function buildCopyWithinRhs(object: Expr, args: CallArg[], pos: number): Expr {
  checkArity("copyWithin", { sig: "target, start[, end]", allowed: [2, 3] }, args.length, pos);
  const lits = args.map((a) => {
    if (a.type === "SpreadElement") {
      throw new CodegenError(`.copyWithin(target, start[, end]) does not accept spread arguments.`, a.pos);
    }
    if (a.type !== "NumberLiteral" || !Number.isInteger(a.value) || a.value < 0) {
      throw new CodegenError(
        `.copyWithin(target, start[, end]) requires non-negative integer literals; got '${a.type}'. ` +
          `Computed or negative arguments aren't supported — JS's negative-indexing isn't representable here.`,
        a.pos,
      );
    }
    return a.value;
  });
  const target = lits[0];
  const start = lits[1];
  const endLit: number | null = lits.length === 3 ? lits[2] : null;
  // len = end - start (constant if end is literal; $subtract: [size, start] otherwise)
  const lenExpr: Expr =
    endLit !== null
      ? mkNumber(Math.max(0, endLit - start), pos)
      : mkOpCall(
          "$max",
          [mkNumber(0, pos), mkOpCall("$subtract", [mkOpCall("$size", [object], pos), mkNumber(start, pos)], pos)],
          pos,
        );
  // Suffix start position: target + len (constant if literal-end, else $add)
  const suffixStartExpr: Expr =
    endLit !== null
      ? mkNumber(target + Math.max(0, endLit - start), pos)
      : mkOpCall("$add", [mkNumber(target, pos), lenExpr], pos);
  // Suffix length: $max(0, $size(arr) - suffixStart)
  const suffixLenExpr: Expr = mkOpCall(
    "$max",
    [mkNumber(0, pos), mkOpCall("$subtract", [mkOpCall("$size", [object], pos), suffixStartExpr], pos)],
    pos,
  );
  // $concatArrays: [prefix, copied, suffix]
  const prefix = mkOpCall("$slice", [object, mkNumber(0, pos), mkNumber(target, pos)], pos);
  const copied = mkOpCall("$slice", [object, mkNumber(start, pos), lenExpr], pos);
  const suffix = mkOpCall("$slice", [object, suffixStartExpr, suffixLenExpr], pos);
  return mkOpCall("$concatArrays", [prefix, copied, suffix], pos);
}

function mkOpCall(name: string, args: Expr[], pos: number): Expr {
  return { type: "OperatorCall", name, style: "positional", args, pos };
}

function mkNumber(value: number, pos: number): Expr {
  return { type: "NumberLiteral", value, pos };
}

/**
 * `.fill(v[, start[, end]])` at statement position.
 *
 * Lower to an IIFE that binds the normalised start/end once, then maps over
 * the array swapping in `v` for indices in `[s0, e0)` and keeping the original
 * element elsewhere:
 *
 *   ((s0, e0) => arr.map((x, i) => (i >= s0 && i < e0) ? v : x))(
 *     <normalised start>, <normalised end>,
 *   )
 *
 * Normalisation matches JS:
 *   - `start` undefined  ⇒ 0
 *   - `start < 0`        ⇒ max(0, size + start)
 *   - `start >= 0`       ⇒ start
 *   - `end` undefined    ⇒ size
 *   - `end < 0`          ⇒ max(0, size + end)
 *   - `end >= 0`         ⇒ end
 */
function buildFillRhs(object: Expr, args: CallArg[], pos: number): Expr {
  checkArity("fill", { sig: "value[, start[, end]]", allowed: [1, 2, 3] }, args.length, pos);
  const exprArgs: Expr[] = [];
  for (const a of args) {
    if (a.type === "SpreadElement") {
      throw new CodegenError(`Spread (...) is not supported as an argument to .fill()`, a.pos);
    }
    exprArgs.push(a);
  }
  const v = exprArgs[0];
  const startArg: Expr | undefined = exprArgs[1];
  const endArg: Expr | undefined = exprArgs[2];

  const zero = mkNumber(0, pos);

  // Compile-time fast path: when `start` and `end` are both omitted, every
  // element becomes `v`. Skip the IIFE and the index plumbing entirely.
  if (startArg === undefined && endArg === undefined) {
    const unusedAndV: Expr = { type: "Lambda", params: ["jsmqlFillUnused"], body: v, pos };
    return { type: "MethodCall", object, method: "map", args: [unusedAndV], pos };
  }

  const sizeOf = (): Expr => mkOpCall("$size", [object], pos);
  const normalize = (e: Expr | undefined, defaultIfUndef: () => Expr): Expr => {
    if (e === undefined) return defaultIfUndef();
    // Compile-time fast path: a non-negative number literal needs no
    // normalisation — pass it through verbatim. Avoids emitting a runtime
    // `$cond` (`if: { $lt: [n, 0] }`, …, `else: n`) whose test is statically false.
    if (e.type === "NumberLiteral" && e.value >= 0) return e;
    // `e < 0 ? max(0, size + e) : e`
    const isNeg: Expr = { type: "BinaryExpr", op: "<", left: e, right: zero, pos };
    const fromTail: Expr = { type: "BinaryExpr", op: "+", left: sizeOf(), right: e, pos };
    const clamped = mkOpCall("$max", [zero, fromTail], pos);
    return { type: "TernaryExpr", condition: isNeg, consequent: clamped, alternate: e, pos };
  };

  const s0Init = normalize(startArg, () => zero);
  const e0Init = normalize(endArg, () => sizeOf());

  // Inner map body: `(i >= jsmqlFillStart && i < jsmqlFillEnd) ? v : x`.
  const sRef: Expr = { type: "ParamRef", name: "jsmqlFillStart", pos };
  const eRef: Expr = { type: "ParamRef", name: "jsmqlFillEnd", pos };
  const xRef: Expr = { type: "ParamRef", name: "x", pos };
  const iRef: Expr = { type: "ParamRef", name: "i", pos };
  const condition: Expr = {
    type: "BinaryExpr",
    op: "&&",
    left: { type: "BinaryExpr", op: ">=", left: iRef, right: sRef, pos },
    right: { type: "BinaryExpr", op: "<", left: iRef, right: eRef, pos },
    pos,
  };
  const mapBody: Expr = { type: "TernaryExpr", condition, consequent: v, alternate: xRef, pos };
  const mapLambda: Expr = { type: "Lambda", params: ["x", "i"], body: mapBody, pos };
  const mapCall: Expr = { type: "MethodCall", object, method: "map", args: [mapLambda], pos };

  const iifeCallee: Expr = { type: "Lambda", params: ["jsmqlFillStart", "jsmqlFillEnd"], body: mapCall, pos };
  return { type: "CallExpression", callee: iifeCallee, args: [s0Init, e0Init], pos };
}

// Every recognised method name, used to power "did you mean?" suggestions on
// unknown methods — derived from the METHODS registry so adding a method is a
// single entry there (no separate list to keep in sync).
const KNOWN_METHODS: ReadonlySet<string> = new Set(Object.keys(METHODS));

/**
 * Most methods can't take spread args — only variadic ones (concat). This helper
 * unwraps a CallArg list to a plain Expr list and rejects spreads with a clear error.
 */
function exprArgsOnly(args: CallArg[], method: string): Expr[] {
  return args.map((a) => {
    if (a.type === "SpreadElement") {
      throw new CodegenError(`Spread (...) is not supported as an argument to .${method}()`, a.pos);
    }
    return a;
  });
}

/**
 * `.includes(x)` / `.indexOf(x)` search for a *value*; they don't take a
 * predicate (that's JS, not jsmql being strict). When the user passes a lambda
 * they meant the predicate sibling — `.some` (bool) for `.includes`,
 * `.findIndex` (index) for `.indexOf` — so point there. Without this the lambda
 * falls through to the generic "function only valid as a callback to an
 * iterating array method" rejection, which misleads because `.includes`/
 * `.indexOf` ARE array methods.
 */
function rejectPredicateOnValueSearch(arg: Expr | undefined, method: string, sibling: string): void {
  if (arg?.type !== "Lambda") return;
  const p = arg.params[0] ?? "x";
  throw new CodegenError(
    `.${method}() searches for a value — it doesn't take a function. To test elements against a predicate, use .${sibling}(${p} => …).`,
    arg.pos,
  );
}

/**
 * Argument-count spec for a method/static call. Exactly one of
 * `exact` / `allowed` / `atLeast` / `none` is set. `sig` is the parameter
 * signature shown in the error — e.g. `"start[, count]"` renders as
 * `.substr(start[, count])`; `""` renders the bare `.toReversed()`.
 */
type Arity = { sig: string; exact?: number; allowed?: readonly number[]; atLeast?: number; none?: true };

/**
 * The single place every argument-count error is worded, so the surface stays
 * consistent (see the error-consistency rules in CLAUDE.md). Validates `count`
 * against `spec` and throws `<prefix><method>(<sig>) <quantity-clause>, got <N>`
 * on mismatch — `.charAt(index) requires exactly 1 argument, got 0`,
 * `.slice(start[, end]) requires 0, 1, or 2 arguments, got 3`,
 * `Math.hypot(...values) requires at least 1 argument, got 0`. The trailing
 * `, got <N>` tells the user exactly what they passed. The caller passes the
 * count it validates (`exprArgs.length` for most; raw `args.length` for the few
 * that count spread args). `prefix` is `"."` for instance methods (the default)
 * or `"Math."` / `"Object."` / `"Set."` / `"regex."` for the static families.
 */
export function checkArity(method: string, spec: Arity, count: number, callPos: number, prefix: string = "."): void {
  const ok =
    spec.none !== undefined
      ? count === 0
      : spec.exact !== undefined
        ? count === spec.exact
        : spec.allowed !== undefined
          ? spec.allowed.includes(count)
          : count >= spec.atLeast!;
  if (ok) return;
  let quantity: string;
  if (spec.none !== undefined) {
    quantity = "takes no arguments";
  } else if (spec.exact !== undefined) {
    quantity = `requires exactly ${spec.exact} argument${spec.exact === 1 ? "" : "s"}`;
  } else if (spec.allowed !== undefined) {
    quantity = `requires ${formatCountList(spec.allowed)} arguments`;
  } else {
    quantity = `requires at least ${spec.atLeast} argument${spec.atLeast === 1 ? "" : "s"}`;
  }
  throw new CodegenError(`${prefix}${method}(${spec.sig}) ${quantity}, got ${count}`, callPos);
}

/** Render an allowed-count list the way the messages read: `[1,2]` → "1 or 2",
 *  `[0,1,2]` → "0, 1, or 2". */
function formatCountList(ns: readonly number[]): string {
  if (ns.length === 2) return `${ns[0]} or ${ns[1]}`;
  return `${ns.slice(0, -1).join(", ")}, or ${ns[ns.length - 1]}`;
}

// ── Lambda bodies (expression body or expr-block → nested $let) ───────────────

type LambdaLike = { params: string[]; body?: Expr; exprBlock?: ExprBlock; pos: number };

/**
 * The expression whose value the lambda yields: the bare body, or the `return`
 * expression of an expr-block. Used for static type inference (string/array/
 * object/boolean producing-ness) at the consumer sites.
 */
function lambdaResult(lambda: LambdaLike): Expr {
  return lambda.exprBlock ? lambda.exprBlock.ret : lambda.body!;
}

/**
 * Generate the value of a lambda body, threading `ctx`. An expression body is
 * generated directly; an expr-block `{ const a = …; return <e>; }` is lowered
 * by [generateExprBlock] to a right-folded nest of `$let`.
 */
function genLambdaBody(lambda: LambdaLike, ctx: GenerateCtx): unknown {
  return lambda.exprBlock ? generateExprBlock(lambda.exprBlock, ctx) : _generate(lambda.body!, ctx);
}

/**
 * Lower an expr-block body to nested `$let`. Right-fold so each declaration's
 * initialiser — and the final `return` — sees every PRIOR declaration as a
 * `$$name` variable (MongoDB's `$let.vars` are mutually invisible, hence one
 * `$let` per decl rather than a single shared `vars` block). This is a faithful
 * 1:1 lowering of the user's `const`/`let` bindings, not an optimisation. See
 * docs/specs/method-dispatch.md.
 */
function generateExprBlock(block: ExprBlock, ctx: GenerateCtx): unknown {
  const seen = new Set<string>();
  const fold = (i: number, c: GenerateCtx): unknown => {
    if (i === block.decls.length) return _generate(block.ret, c);
    const decl = block.decls[i];
    if (seen.has(decl.name)) {
      throw new CodegenError(
        `\`${decl.kind} ${decl.name}\` is already declared earlier in this block — re-declaration in the same scope is not allowed; pick a different name.`,
        decl.pos,
      );
    }
    seen.add(decl.name);
    const value = _generate(decl.value, c); // initialiser sees only prior decls
    const inner = extendCtx(c, [decl.name]); // decl.name now resolves to $$name
    return { $let: { vars: { [safeVarName(decl.name)]: value }, in: fold(i + 1, inner) } };
  };
  return fold(0, ctx);
}

function requireLambda(
  args: Expr[],
  method: string,
  callerPos: number,
  ctx?: GenerateCtx,
): { type: "Lambda"; params: string[]; body?: Expr; exprBlock?: ExprBlock; pos: number } {
  const first = args[0];
  // Bare type-cast callback: `.filter(Boolean)` desugars to `.filter(v => Boolean(v))`.
  if (first?.type === "TypeCastRef") {
    return {
      type: "Lambda",
      params: ["v"],
      body: {
        type: "TypeCast",
        cast: first.cast,
        arg: { type: "ParamRef", name: "v", pos: first.pos },
        pos: first.pos,
      },
      pos: first.pos,
    };
  }
  // Bare unary-Math callback: `.map(Math.floor)` desugars to `.map(v => Math.floor(v))`.
  if (first?.type === "MathCallRef") {
    return {
      type: "Lambda",
      params: ["v"],
      body: {
        type: "MathCall",
        method: first.method,
        args: [{ type: "ParamRef", name: "v", pos: first.pos }],
        pos: first.pos,
      },
      pos: first.pos,
    };
  }
  if (!first || first.type !== "Lambda") {
    // A reusable function passed as a bare callback (`arr.map(double)`) — name it
    // and point at the lambda-wrap form. MongoDB has no first-class functions, so
    // the callback must be a lambda that calls it.
    if (first?.type === "ParamRef" && ctx?.functions?.has(first.name)) {
      throw new CodegenError(
        `.${method}() got the reusable function '${first.name}' as a bare callback — pass a lambda that calls it: \`.${method}(x => ${first.name}(x))\`.`,
        first.pos,
      );
    }
    throw new CodegenError(
      `.${method}() requires a lambda as its first argument, e.g. x => x > 0`,
      first?.pos ?? callerPos,
    );
  }
  if (first.block !== undefined) {
    throw new CodegenError(
      `.${method}() does not accept a statement-block body (a sub-pipeline of stages) — that form is only for '$$$.<coll>.find/filter(...)' and '$$.filter(...)'. Use an expression \`x => x > 0\`, or a value-returning block \`x => { const y = …; return y; }\`.`,
      first.pos,
    );
  }
  return first as { type: "Lambda"; params: string[]; body?: Expr; exprBlock?: ExprBlock; pos: number };
}

// ── Call expressions (IIFE / reusable functions → $let) ───────────────────────

/**
 * Apply a lambda to argument expressions — shared by the anonymous IIFE form
 * (`((x) => …)(arg)`) and the named reusable-function call form (`f(arg)`).
 * Arguments are generated in the CALLER ctx (`argCtx`); the body is generated
 * in `bodyCtx` (caller ctx extended with the params, so they resolve to
 * `$$param`). Each param is bound once via `$let`, so a multiply-read argument
 * isn't recomputed — and so a zero-param lambda still emits `{ $let: { vars: {},
 * in: … } }`, matching the IIFE precedent (empty `vars` is server-valid).
 *
 * `label` names the construct in arity/spread/block errors ("IIFE" or
 * `Function 'f'`). `bodyCtx` is supplied by the caller so the named form can
 * push the function onto the recursion-guard stack before lowering the body.
 */
function applyLambda(
  lambda: Lambda,
  args: CallArg[],
  argCtx: GenerateCtx,
  bodyCtx: GenerateCtx,
  pos: number,
  label: string,
): unknown {
  if (lambda.block !== undefined) {
    throw new CodegenError(
      `${label} cannot have a statement-block body (a sub-pipeline of stages) — that form is only for '$$$.<coll>.find/filter(...)'. Use an expression, or a value-returning block \`(x) => { const y = …; return y; }\`.`,
      lambda.pos,
    );
  }
  if (lambda.params.length !== args.length) {
    throw new CodegenError(
      `${label}: expected ${lambda.params.length} argument(s)${lambda.params.length ? ` for params (${lambda.params.join(", ")})` : ""}, got ${args.length}.`,
      pos,
    );
  }
  const vars: Record<string, unknown> = {};
  for (let i = 0; i < lambda.params.length; i++) {
    const a = args[i];
    if (a.type === "SpreadElement") {
      throw new CodegenError(
        `${label}: spread arguments aren't supported — pass each argument explicitly, or use $op($let, ...) to build the bindings by hand.`,
        a.pos,
      );
    }
    vars[lambda.params[i]] = _generate(a, argCtx);
  }
  return { $let: { vars, in: genLambdaBody(lambda, bodyCtx) } };
}

/**
 * Lower a call expression. Two supported callees:
 *   - a lambda literal — an IIFE: `((x, y) => $.a + x * y)(2, 3)` →
 *     `{ $let: { vars: { x: 2, y: 3 }, in: … } }`;
 *   - a bare identifier naming a reusable function declared `const f = (…) => …`
 *     — the body is expanded INLINE here as the same `$let` shape (re-lowered
 *     per call). See docs/specs/reusable-functions.md.
 * Any other callee (e.g. a field ref followed by `(...)`) isn't callable in MQL;
 * we reject it with an error pointing at the supported forms.
 */
function generateCallExpression(callee: Expr, args: CallArg[], ctx: GenerateCtx, pos: number): unknown {
  // Named reusable function: `f(args)` where `f` was declared `const f = (…) => …`.
  if (callee.type === "ParamRef") {
    const fn = ctx.functions?.get(callee.name);
    if (fn !== undefined) {
      if (ctx.expandingFns?.has(callee.name)) {
        throw new CodegenError(
          `Recursive function calls aren't supported — a MongoDB expression can't call itself. ` +
            `'${callee.name}' is invoked while it is still being expanded (direct or mutual recursion). Rewrite it without recursion.`,
          pos,
        );
      }
      const marked: GenerateCtx = { ...ctx, expandingFns: new Set([...(ctx.expandingFns ?? []), callee.name]) };
      const bodyCtx = extendCtx(marked, fn.lambda.params);
      return applyLambda(fn.lambda, args, ctx, bodyCtx, pos, `Function '${callee.name}'`);
    }
    // `assert(...)` is a statement, not a value — reaching here means it was
    // used in expression position (a ternary branch, a field RHS, nested in a
    // call). Point at the statement form. (A user-declared `const assert = …`
    // takes precedence above via the `ctx.functions` lookup.)
    if (callee.name === ASSERT_FN_NAME) {
      throw new CodegenError(
        `'assert(...)' is a pipeline statement, not a value — it can't appear inside an expression. ` +
          `Use it as its own statement in a pipeline body, e.g. ` +
          `\`($) => { assert($.qty >= 0, "qty must be >= 0"); … }\`.`,
        pos,
      );
    }
    // A bare-identifier call that isn't a reusable function in scope.
    throw new CodegenError(
      `Unknown function '${callee.name}(...)'.${didYouMean(callee.name, [...(ctx.functions?.keys() ?? [])], (s) => `${s}(...)`)} ` +
        `Declare it first with \`const ${callee.name} = (…) => …;\` at the top level of a pipeline; ` +
        `for a MongoDB operator write \`$${callee.name}(...)\`; for a method, \`receiver.${callee.name}(...)\`.`,
      pos,
    );
  }
  if (callee.type !== "Lambda") {
    throw new CodegenError(
      `Direct call '(...)(args)' is only supported when the callee is an arrow function (IIFE → $let) or a declared function name. For named operators use $opName(...); for methods use receiver.method(...).`,
      pos,
    );
  }
  const bodyCtx = extendCtx(ctx, callee.params);
  return applyLambda(callee, args, ctx, bodyCtx, pos, "IIFE");
}

// ── assert(condition[, message]) — conditional runtime error ────────────────────
//
// jsmql's `assert` is a pipeline-statement guard. It lowers to a `$convert`
// whose TARGET TYPE is a `$cond`: when the assertion holds, the type is a real
// BSON type so `$convert` is a no-op on the constant `true` (→ `true`); when it
// fails, the type is the (prefixed) message string, which MongoDB rejects at
// runtime with `Unknown type name: <message>` (BadValue, code 2). pipeline.ts
// wraps this expression in `{ $match: { $expr: … } }` — a `$match` neither adds
// nor drops fields, so a holding assertion is invisible in the output, and the
// `$convert` is ALWAYS evaluated (the gating lives in its runtime `to`), so the
// guard never relies on the undocumented short-circuiting of `$cond`/`$and`.
// The `ASSERT_FAIL_BASE` prefix is load-bearing, not cosmetic: it guarantees the
// failing-branch string is never itself a valid type name (e.g. a literal
// message of `"int"`), which would otherwise make `$convert` SUCCEED and
// silently skip the assertion. See docs/specs/assert.md.
export const ASSERT_FN_NAME = "assert";
const ASSERT_FAIL_BASE = "jsmql assertion failed";

/**
 * Build the bare `$convert` guard expression for `assert(condition[, message])`.
 * Statement-position only — the caller (pipeline.ts) wraps it in a `$match`
 * stage; expression-position uses are rejected in `generateCallExpression`.
 */
export function generateAssertGuardExpr(args: CallArg[], ctx: GenerateCtx, callPos: number): unknown {
  const exprArgs = args.map((a) => {
    if (a.type === "SpreadElement") {
      throw new CodegenError(`Spread (...) is not supported as an argument to 'assert(...)'.`, a.pos);
    }
    return a;
  });
  checkArity("assert", { sig: "condition[, message]", allowed: [1, 2] }, exprArgs.length, callPos, "");
  const condition = jsBoolIfNeeded(exprArgs[0], _generate(exprArgs[0], ctx));
  return { $convert: { input: true, to: { $cond: [condition, "bool", assertFailType(exprArgs[1], ctx)] } } };
}

/**
 * The failing-branch value placed in `$convert.to`. A static string message
 * folds to a constant; any other expression (template literal, field ref, …)
 * is coerced to a string and prefixed at runtime via `$concat`. The
 * `ASSERT_FAIL_BASE` prefix keeps the result from ever being a valid type name.
 */
function assertFailType(msgExpr: Expr | undefined, ctx: GenerateCtx): unknown {
  if (msgExpr === undefined) return ASSERT_FAIL_BASE;
  if (msgExpr.type === "StringLiteral") return `${ASSERT_FAIL_BASE}: ${msgExpr.value}`;
  return { $concat: [`${ASSERT_FAIL_BASE}: `, { $toString: _generate(msgExpr, ctx) }] };
}

// ── Type casts ────────────────────────────────────────────────────────────────

function generateTypeCast(cast: TypeCastOp, arg: Expr, ctx: GenerateCtx, _pos: number): unknown {
  const val = _generate(arg, ctx);
  switch (cast) {
    case "Number":
    case "parseFloat":
      return { $toDouble: val };
    case "String":
      return { $toString: val };
    case "Boolean":
      // JS truthy/falsy semantics — see jsBool() above. Users who want the
      // raw MongoDB $toBool can call it directly: $toBool($.x).
      return jsBoolIfNeeded(arg, val);
    case "parseInt":
      return { $toInt: val };
  }
}

// ── Math ──────────────────────────────────────────────────────────────────────

function generateMathConst(name: MathConstant): number {
  switch (name) {
    case "PI":
      return Math.PI;
    case "E":
      return Math.E;
  }
}

function generateMathCall(method: MathMethod, args: CallArg[], ctx: GenerateCtx, pos: number): unknown {
  switch (method) {
    case "abs":
      return { $abs: oneArg(method, args, ctx, pos) };
    case "ceil":
      return { $ceil: oneArg(method, args, ctx, pos) };
    case "floor":
      return { $floor: oneArg(method, args, ctx, pos) };
    case "round":
      return { $round: [oneArg(method, args, ctx, pos), 0] };
    case "sqrt":
      return { $sqrt: oneArg(method, args, ctx, pos) };
    case "exp":
      return { $exp: oneArg(method, args, ctx, pos) };
    case "log":
      // Math.log is natural log → $ln
      return { $ln: oneArg(method, args, ctx, pos) };
    case "log2":
      return { $log: [oneArg(method, args, ctx, pos), 2] };
    case "log10":
      return { $log10: oneArg(method, args, ctx, pos) };
    case "trunc":
      return { $trunc: oneArg(method, args, ctx, pos) };
    case "sign":
      // JS returns -1 / 0 / 1 for negative / zero / positive — same as $cmp(x, 0)
      return { $cmp: [oneArg(method, args, ctx, pos), 0] };
    case "cbrt":
      return { $pow: [oneArg(method, args, ctx, pos), { $divide: [1, 3] }] };
    case "pow": {
      const exprArgs = exprArgsOnly(args, "pow");
      checkArity("pow", { sig: "base, exponent", exact: 2 }, exprArgs.length, pos, "Math.");
      return { $pow: [_generate(exprArgs[0], ctx), _generate(exprArgs[1], ctx)] };
    }
    case "min":
    case "max": {
      // Variadic: accept (a, b, c, ...) OR a single array OR ...spread
      checkArity(method, { sig: "...values", atLeast: 1 }, args.length, pos, "Math.");
      const op = method === "min" ? "$min" : "$max";
      // Single non-spread arg → pass through (Mongo $min/$max accept either a value or an array)
      if (args.length === 1 && args[0].type !== "SpreadElement") {
        return { [op]: _generate(args[0], ctx) };
      }
      return { [op]: generateVariadicArgs(args, ctx) };
    }
    case "hypot": {
      const exprArgs = exprArgsOnly(args, "hypot");
      checkArity("hypot", { sig: "...values", atLeast: 1 }, exprArgs.length, pos, "Math.");
      const squares = exprArgs.map((a) => ({ $pow: [_generate(a, ctx), 2] }));
      return { $sqrt: { $add: squares } };
    }
    case "random":
      checkArity("random", { sig: "", none: true }, args.length, pos, "Math.");
      return { $rand: {} };
    case "sin":
      return { $sin: oneArg(method, args, ctx, pos) };
    case "cos":
      return { $cos: oneArg(method, args, ctx, pos) };
    case "tan":
      return { $tan: oneArg(method, args, ctx, pos) };
    case "asin":
      return { $asin: oneArg(method, args, ctx, pos) };
    case "acos":
      return { $acos: oneArg(method, args, ctx, pos) };
    case "atan":
      return { $atan: oneArg(method, args, ctx, pos) };
    case "atan2": {
      const exprArgs = exprArgsOnly(args, "atan2");
      checkArity("atan2", { sig: "y, x", exact: 2 }, exprArgs.length, pos, "Math.");
      return { $atan2: [_generate(exprArgs[0], ctx), _generate(exprArgs[1], ctx)] };
    }
    case "sinh":
      return { $sinh: oneArg(method, args, ctx, pos) };
    case "cosh":
      return { $cosh: oneArg(method, args, ctx, pos) };
    case "tanh":
      return { $tanh: oneArg(method, args, ctx, pos) };
    case "asinh":
      return { $asinh: oneArg(method, args, ctx, pos) };
    case "acosh":
      return { $acosh: oneArg(method, args, ctx, pos) };
    case "atanh":
      return { $atanh: oneArg(method, args, ctx, pos) };
  }
}

function oneArg(method: MathMethod, args: CallArg[], ctx: GenerateCtx, pos: number): unknown {
  const exprArgs = exprArgsOnly(args, method);
  checkArity(method, { sig: "value", exact: 1 }, exprArgs.length, pos, "Math.");
  return _generate(exprArgs[0], ctx);
}

// ── Object calls ──────────────────────────────────────────────────────────────

function generateObjectCall(method: ObjectMethod, args: CallArg[], ctx: GenerateCtx, pos: number): unknown {
  // Helper: wrap argument with $ifNull(v, neutral) when the chain has `?.`
  // (`$objectToArray(null)` and `$arrayToObject(null)` both error).
  const genWith = (arg: Expr, neutral: unknown): unknown => {
    const gen = _generate(arg, ctx);
    return chainHasOptional(arg) ? wrapIfNull(gen, neutral) : gen;
  };
  switch (method) {
    case "keys": {
      const exprArgs = exprArgsOnly(args, "Object.keys");
      checkArity("keys", { sig: "obj", exact: 1 }, exprArgs.length, pos, "Object.");
      return { $map: { input: { $objectToArray: genWith(exprArgs[0], {}) }, as: "kv", in: "$$kv.k" } };
    }
    case "values": {
      const exprArgs = exprArgsOnly(args, "Object.values");
      checkArity("values", { sig: "obj", exact: 1 }, exprArgs.length, pos, "Object.");
      return { $map: { input: { $objectToArray: genWith(exprArgs[0], {}) }, as: "kv", in: "$$kv.v" } };
    }
    case "entries": {
      const exprArgs = exprArgsOnly(args, "Object.entries");
      checkArity("entries", { sig: "obj", exact: 1 }, exprArgs.length, pos, "Object.");
      return { $objectToArray: genWith(exprArgs[0], {}) };
    }
    case "fromEntries": {
      const exprArgs = exprArgsOnly(args, "Object.fromEntries");
      checkArity("fromEntries", { sig: "entries", exact: 1 }, exprArgs.length, pos, "Object.");
      return { $arrayToObject: genWith(exprArgs[0], []) };
    }
    case "assign": {
      checkArity("assign", { sig: "...sources", atLeast: 1 }, args.length, pos, "Object.");
      return { $mergeObjects: generateVariadicArgs(args, ctx) };
    }
    case "groupBy": {
      const exprArgs = exprArgsOnly(args, "Object.groupBy");
      checkArity("groupBy", { sig: "items, x => key", exact: 2 }, exprArgs.length, pos, "Object.");
      const input = exprArgs[0];
      const lambda = exprArgs[1];
      if (lambda.type !== "Lambda" || lambda.params.length !== 1) {
        throw new CodegenError(
          `Object.groupBy() requires a single-parameter arrow function as the discriminator`,
          lambda.pos,
        );
      }
      if (lambda.block !== undefined) {
        throw new CodegenError(
          `Object.groupBy() does not accept a statement-block arrow (a sub-pipeline) — that form is only for '$$$.<coll>.find/filter(...)'. Use an expression \`x => x.key\`, or a value-returning block.`,
          lambda.pos,
        );
      }
      // Reduce over the input. For each element, compute the discriminator key with the
      // user's lambda param bound to $$this. Use $let to materialise the key once, then
      // append the current element to the array under that key in the accumulator.
      const keyCtx: GenerateCtx = {
        lambdaParams: new Set([...ctx.lambdaParams, lambda.params[0]]),
        reduceRemap: new Map([[lambda.params[0], "this"]]),
        pipelineLets: ctx.pipelineLets,
        droppedLets: ctx.droppedLets,
        bindingTypes: ctx.bindingTypes,
        functions: ctx.functions,
        expandingFns: ctx.expandingFns,
      };
      const keyBody = genLambdaBody(lambda, keyCtx);
      const keyExpr = isStringProducing(lambdaResult(lambda)) ? keyBody : { $toString: keyBody };
      return {
        $reduce: {
          input: _generate(input, ctx),
          initialValue: {},
          in: {
            $let: {
              vars: { key: keyExpr },
              in: {
                $mergeObjects: [
                  "$$value",
                  {
                    $arrayToObject: [
                      [
                        [
                          "$$key",
                          {
                            $concatArrays: [
                              { $ifNull: [{ $getField: { field: "$$key", input: "$$value" } }, []] },
                              ["$$this"],
                            ],
                          },
                        ],
                      ],
                    ],
                  },
                ],
              },
            },
          },
        },
      };
    }
  }
}

// ── Array.from ────────────────────────────────────────────────────────────────

/**
 * `Array.from({length: n}, (_, i) => f(i))` — the only supported form. Other
 * Array.from invocations are rejected because MQL has no general iterable-to-array
 * primitive. Compiles to `$map($range(0, n), (i) => body)` where the lambda's first
 * (element) parameter is bound to null via $let, matching JS's `Array.from({length}, ...)`
 * semantics where the element is always undefined.
 */
/**
 * Evaluate a `new Date(...)` whose arguments are all compile-time constants,
 * returning the resulting JS `Date` — **even when that Date is Invalid** (so the
 * caller can distinguish "not constant" from "constant but unparseable"). Returns
 * null only when the value can't be known at compile time: `new Date()` (= now)
 * or any non-literal argument.
 *
 * Multi-arg `(y, m, d, …)` and `new Date(Date.UTC(…))` are interpreted as
 * **UTC** (month index 0-based, as in JS `Date.UTC`), matching the
 * `$dateFromParts` timezone in `generateDateFromParts`. This is the documented
 * UTC divergence — "local time" on a MongoDB server is rarely what a query
 * author wants — and evaluating here keeps the query-translator's value
 * identical to codegen's (it previously used JS-local time and silently
 * disagreed).
 */
function evalConstDate(args: Expr[]): Date | null {
  if (args.length === 0) return null; // new Date() — runtime "now"
  if (args.length === 1) {
    const arg = args[0];
    if (arg.type === "DateUTC") {
      const utc = constNumberArgs(arg.args);
      return utc === null ? null : new Date(utcMs(utc));
    }
    if (arg.type === "NumberLiteral") return new Date(arg.value); // epoch ms
    if (arg.type === "StringLiteral") return new Date(arg.value); // ISO string
    return null; // new Date(<runtime expr>)
  }
  const nums = constNumberArgs(args);
  if (nums === null) return null; // multi-arg with a non-literal part
  return new Date(utcMs(nums));
}

/**
 * Fold a `new Date(...)` whose arguments are all compile-time constants into a
 * real, **valid** JS `Date`, or null otherwise — the single source of truth for
 * "is this `new Date(...)` a usable constant date?". Used by the `$match`/Filter
 * query translator (`match-translation.ts`): a null result (runtime, or a
 * constant that doesn't parse) drops the comparison to the `$expr` residual,
 * which re-enters codegen — where `generateNewDate` decides between the runtime
 * lowering and an HR3 compile-time rejection.
 */
export function foldConstantDate(args: Expr[]): Date | null {
  const d = evalConstDate(args);
  return d !== null && !Number.isNaN(d.getTime()) ? d : null;
}

function utcMs(parts: number[]): number {
  return (Date.UTC as (...a: number[]) => number)(...parts);
}

function constNumberArgs(args: Expr[]): number[] | null {
  const out: number[] = [];
  for (const a of args) {
    if (a.type !== "NumberLiteral") return null;
    out.push(a.value);
  }
  return out;
}

/**
 * An actionable rejection for a `new Date(...)` whose constant arguments we
 * evaluated to an Invalid Date — the server would reject the resulting
 * `{ $toDate }` / `$dateFromParts` at parse time, so we refuse it here (HR3)
 * instead of emitting it. The string-literal case (by far the common one) names
 * the offending value and the format to use; the numeric/parts case reports the
 * out-of-range result.
 */
function invalidConstDateError(args: Expr[]): CodegenError {
  const first = args[0];
  if (args.length === 1 && first.type === "StringLiteral") {
    return new CodegenError(
      `new Date("${first.value}") — "${first.value}" is not a valid date string. ` +
        `Use an ISO 8601 date like "2026-01-01" or "2026-01-01T00:00:00.000Z".`,
      first.pos,
    );
  }
  return new CodegenError(
    `new Date(…) — these arguments produce an invalid date (out of the representable range).`,
    first.pos,
  );
}

/**
 * Lower `new Date(args…)`:
 *   - constant args (valid)                → a real BSON `Date` (folded; see below)
 *   - constant args (Invalid Date)         → compile-time rejection (HR3; see below)
 *   - 0 args (`new Date()`)                → `{ $toDate: "$$NOW" }`
 *   - 1 runtime arg (`new Date($.ts)`)     → `{ $toDate: <arg> }`
 *   - runtime multi-arg                    → `{ $dateFromParts: { year, month: +1, … } }`
 *
 * A `new Date(...)` with compile-time-constant arguments denotes a constant
 * Date, so it folds to a real `Date` value (HR1: a Date passes through
 * verbatim). This is correct in BOTH positions a date can appear: an
 * aggregation expression (where `{ $toDate: … }` would also work) AND a
 * query document — Filter / `$match` object-literal passthrough — where the
 * runtime `{ $toDate: … }` form is read as an inert literal subdocument that
 * matches nothing. The fold makes both contexts emit the working shape and
 * keeps `new Date("…")` producing the *same* MQL regardless of where it sits.
 *
 * When the constant args evaluate to an *Invalid* Date (e.g. `new Date("nope")`)
 * we reject at compile time (HR3): the server rejects the equivalent `{ $toDate }`
 * at parse time, so emitting it would knowingly produce unrunnable MQL. Only
 * genuinely-runtime forms fall through to `{ $toDate }` / `$dateFromParts`.
 *
 * JS month indices are 0-based; MQL `$dateFromParts.month` is 1-based, so an
 * `$add: [month, 1]` is inserted (folded at compile time for literal months).
 *
 * Divergence: JS multi-arg `new Date(y, m, d, …)` interprets the parts in
 * **local time** (whatever the runtime considers local); jsmql interprets
 * them as **UTC** (MQL's `$dateFromParts` default / `Date.UTC` for the fold),
 * since "local time" on a MongoDB server is rarely what a query author wants.
 * Use `Date.UTC(...)` (or build the Date in client code and pass it via the
 * template-tag form) if the JS-local semantics matter.
 */
function generateNewDate(args: Expr[], ctx: GenerateCtx): unknown {
  const constEval = evalConstDate(args);
  if (constEval !== null) {
    // All arguments are compile-time constants — fold to a real BSON Date, or
    // reject if they don't form a valid date (HR3 — the server would too).
    if (Number.isNaN(constEval.getTime())) throw invalidConstDateError(args);
    return constEval;
  }
  if (args.length === 0) return { $toDate: "$$NOW" };
  if (args.length === 1) {
    // Peephole: `new Date(Date.UTC(y, m, d, …))` with a runtime part is the
    // canonical UTC-date idiom. Skip the `$toLong → $toDate` round-trip and
    // emit the raw `$dateFromParts` (still UTC-anchored, just as a Date).
    const arg = args[0];
    if (arg.type === "DateUTC") {
      return generateDateFromParts(arg.args, ctx, "UTC");
    }
    return { $toDate: _generate(arg, ctx) };
  }
  return generateDateFromParts(args, ctx, /*timezone*/ null);
}

/**
 * Lower `Date.UTC(y, m, d, …)`. JS returns **ms since epoch as a number**, not
 * a Date — so we wrap `$dateFromParts` (with `timezone: "UTC"`) in `$toLong`
 * to produce the same numeric value. The `new Date(Date.UTC(…))` form gets a
 * peephole in `generateNewDate` that skips the wrap.
 */
function generateDateUTC(args: Expr[], ctx: GenerateCtx): unknown {
  return { $toLong: generateDateFromParts(args, ctx, "UTC") };
}

/**
 * Build a `$dateFromParts` document from a positional argument list. Used by
 * both `new Date(y, m, d, …)` (no timezone) and `Date.UTC(y, m, d, …)`
 * (timezone: "UTC"). Folds the JS-to-MQL month offset (+1) when the month
 * argument is a number literal.
 */
function generateDateFromParts(args: Expr[], ctx: GenerateCtx, timezone: string | null): unknown {
  const parts: Record<string, unknown> = { year: _generate(args[0], ctx) };
  if (args.length >= 2) {
    const monthAst = args[1];
    if (monthAst.type === "NumberLiteral") {
      parts.month = monthAst.value + 1;
    } else {
      parts.month = { $add: [_generate(monthAst, ctx), 1] };
    }
  }
  const slots = ["day", "hour", "minute", "second", "millisecond"];
  for (let i = 2; i < args.length && i - 2 < slots.length; i++) {
    parts[slots[i - 2]] = _generate(args[i], ctx);
  }
  if (timezone !== null) parts.timezone = timezone;
  return { $dateFromParts: parts };
}

function generateArrayFrom(input: Expr, mapFn: Expr | null, ctx: GenerateCtx, pos: number): unknown {
  if (input.type !== "ObjectLiteral") {
    throw new CodegenError(
      `Array.from() only supports the {length: n} form: Array.from({length: n}, (_, i) => …). For other inputs use $op($range, …) or .map().`,
      input.pos,
    );
  }
  if (input.entries.length !== 1) {
    throw new CodegenError(`Array.from({length: n}) — exactly one 'length' entry is required`, input.pos);
  }
  const entry = input.entries[0];
  if (entry.type !== "KeyValueEntry" || entry.key.kind !== "static" || entry.key.name !== "length") {
    throw new CodegenError(`Array.from() only supports {length: n}; saw a different object shape`, entry.pos);
  }
  const lengthExpr = _generate(entry.value, ctx);
  if (mapFn === null) {
    return { $range: [0, lengthExpr] };
  }
  if (mapFn.type !== "Lambda") {
    throw new CodegenError(`Array.from() second argument must be an arrow function (e.g. (_, i) => i * 2)`, mapFn.pos);
  }
  if (mapFn.block !== undefined) {
    throw new CodegenError(
      `Array.from() does not accept a statement-block arrow (a sub-pipeline) — that form is only for '$$$.<coll>.find/filter(...)'. Use an expression \`(_, i) => i * 2\`, or a value-returning block.`,
      mapFn.pos,
    );
  }
  if (mapFn.params.length !== 2) {
    throw new CodegenError(
      `Array.from() map function must take 2 parameters (element, index) — element is always null in the {length} form`,
      mapFn.pos,
    );
  }
  void pos;
  const [elemParam, idxParam] = mapFn.params;
  const bodyCtx = extendCtx(ctx, mapFn.params);
  return {
    $map: {
      input: { $range: [0, lengthExpr] },
      as: safeVarName(idxParam),
      in: { $let: { vars: { [safeVarName(elemParam)]: null }, in: genLambdaBody(mapFn, bodyCtx) } },
    },
  };
}

// ── Number.* static predicates ────────────────────────────────────────────────

function generateNumberStatic(method: NumberStaticMethod, arg: Expr, ctx: GenerateCtx): unknown {
  const val = _generate(arg, ctx);
  const pos = arg.pos;
  switch (method) {
    case "isInteger":
      // BSON has separate int/long/decimal/double types. Match JS: any numeric
      // value with no fractional part is an integer. Long and int are always
      // integers; double/decimal are integers iff trunc(x) === x.
      return cond(
        { $in: [{ $type: val }, ["int", "long"]] },
        true,
        cond({ $in: [{ $type: val }, ["double", "decimal"]] }, { $eq: [val, { $trunc: val }] }, false),
      );
    case "isNaN":
      // NaN is the only IEEE 754 value where x !== x.
      return { $ne: [val, val] };
    case "isFinite":
      // jsmql has no JS-syntax surface for ±Infinity or NaN literals, so we
      // cannot emit the obvious `{ $and: [{ $ne: [$x, Infinity] }, ...] }`.
      // Lifting this needs a literal-Infinity/literal-NaN escape hatch — track
      // separately. Until then, give users a concrete workaround in the error.
      throw new CodegenError(
        `Number.isFinite($.x) is not yet supported in jsmql [DEF-022] — there is no syntax for Infinity/NaN literals to compare against. ` +
          `Workarounds: ` +
          `(1) check the BSON type with $type($.x) and reject "double" values you know to be non-finite at the source, ` +
          `(2) use $op($convert, { input: $.x, to: "double", onError: 0 }) to substitute a sentinel for any non-finite value, ` +
          `(3) constrain to a known range (e.g. $.x > -1e300 && $.x < 1e300) if your domain allows it. See docs/DEFERRED.md.`,
        pos,
      );
  }
}

// ── Set method calls (ES2025) ─────────────────────────────────────────────────

/**
 * `new Set(a).intersection(new Set(b))` → `{ $setIntersection: [a, b] }`. The wrapper
 * is a JS-syntax tag for "this is a set"; codegen unwraps it on both receiver and
 * argument. MQL has no Set type — these compile to set operators on plain arrays.
 */
function generateSetMethodCall(
  receiver: { type: "NewSet"; arg: Expr | null; pos: number },
  method: string,
  args: CallArg[],
  ctx: GenerateCtx,
): unknown {
  const pos = receiver.pos;
  // `new Set(x?.y)` — if x is missing, treat the set as empty (JS semantics
  // for `new Set(undefined)` is the empty set). Wrap the inner argument with
  // $ifNull(v, []) when the chain is optional so `$setIntersection` and friends
  // see an empty array instead of null.
  const genSetInner = (inner: Expr): unknown => {
    const gen = _generate(inner, ctx);
    return chainHasOptional(inner) ? wrapIfNull(gen, []) : gen;
  };
  const lhs = receiver.arg ? genSetInner(receiver.arg) : [];
  const exprArgs = exprArgsOnly(args, `Set.${method}`);
  const requireSetArg = (): unknown => {
    checkArity(method, { sig: "other", exact: 1 }, exprArgs.length, pos, "Set.");
    const arg = exprArgs[0];
    if (arg.type !== "NewSet") {
      throw new CodegenError(
        `Set.${method}()'s argument must be a 'new Set(...)' expression, not a plain value`,
        arg.pos,
      );
    }
    return arg.arg ? genSetInner(arg.arg) : [];
  };
  switch (method) {
    case "intersection":
      return { $setIntersection: [lhs, requireSetArg()] };
    case "union":
      return { $setUnion: [lhs, requireSetArg()] };
    case "difference":
      return { $setDifference: [lhs, requireSetArg()] };
    case "isSubsetOf":
      return { $setIsSubset: [lhs, requireSetArg()] };
    case "isSupersetOf":
      // A is a superset of B ⇔ B is a subset of A
      return { $setIsSubset: [requireSetArg(), lhs] };
    case "symmetricDifference":
    case "isDisjointFrom":
      throw new CodegenError(
        `Set.${method}() has no MongoDB equivalent — compose via $setDifference / $setIntersection / $setUnion as needed`,
        pos,
      );
    default: {
      const setHint = didYouMean(method, SET_METHODS);
      throw new CodegenError(`Unknown Set method '.${method}()'.${setHint} Supported: ${SET_METHODS.join(", ")}.`, pos);
    }
  }
}

// ── Regex method calls ────────────────────────────────────────────────────────

/**
 * `/pat/flags.test(str)` → `$regexMatch`; `/pat/flags.exec(str)` → `$regexFind`.
 * The regex literal supplies the pattern and flags; the str is the input.
 */
function generateRegexMethodCall(
  regex: { type: "RegexLiteral"; pattern: string; flags: string; pos: number },
  method: string,
  args: CallArg[],
  ctx: GenerateCtx,
): unknown {
  const pos = regex.pos;
  const exprArgs = exprArgsOnly(args, `regex.${method}`);
  checkArity(method, { sig: "str", exact: 1 }, exprArgs.length, pos, "regex.");
  const input = _generate(exprArgs[0], ctx);
  const opName = method === "test" ? "$regexMatch" : method === "exec" ? "$regexFind" : null;
  if (!opName) {
    const regexHint = didYouMean(method, ["test", "exec"]);
    throw new CodegenError(
      `Unknown regex method '.${method}()'.${regexHint} Supported: regex.test(str), regex.exec(str).`,
      pos,
    );
  }
  const obj: Record<string, unknown> = { input, regex: regex.pattern };
  const opts = mongoRegexOptions(regex.flags);
  if (opts) obj["options"] = opts;
  return { [opName]: obj };
}

// ── UpdateOp codegen ──────────────────────────────────────────────────────────

/**
 * Compile a top-level `UpdateFilter` to either a single stage object (if
 * everything coalesces into one $set/$unset) or an array of stage objects.
 *
 * The shape mirrors `jsmql()`'s existing top-level convention: one stage →
 * bare object, multiple stages → array.
 */
export function generateUpdateFilter(prog: UpdateFilter, ctx: GenerateCtx = EMPTY_CTX): object | object[] {
  if (prog.ops.length === 0) {
    throw new CodegenError("UpdateOp program must contain at least one assignment or delete", prog.pos);
  }
  const groups = groupUpdateOps(prog.ops);
  const stages = groups.map((g) => generateUpdateOpGroup(g, ctx));
  if (stages.length === 1) return stages[0];
  return stages;
}

/**
 * Coalescer used by both jsmql() top-level update ops and by pipeline.ts when
 * update ops appear as pipeline elements. Returns one or more stage objects.
 *
 * Grouping rule (preserves JS sequential semantics):
 *   - Consecutive same-kind (assign/delete) update ops join one group, UNLESS
 *   - A new update op's write path collides (equals or is a parent/child) with
 *     any prior write in the group, OR
 *   - For assignments: the new RHS reads any path that was written earlier in
 *     the group. (Delete has no reads.)
 */
export function generateUpdateOpGroups(ops: UpdateOp[], ctx: GenerateCtx = EMPTY_CTX): object[] {
  const groups = groupUpdateOps(ops);
  return groups.map((g) => generateUpdateOpGroup(g, ctx));
}

function groupUpdateOps(ops: UpdateOp[]): UpdateOp[][] {
  const groups: UpdateOp[][] = [];
  let current: UpdateOp[] = [];
  let writes = new Set<string>();
  let kind: "assign" | "delete" | null = null;

  for (const m of ops) {
    const myKind: "assign" | "delete" = m.type === "AssignExpr" ? "assign" : "delete";
    const writePath = updateOpWritePath(m);
    const reads = m.type === "AssignExpr" ? collectUpdateOpReads(m.value) : null;

    let mustBreak = false;
    if (kind !== null && kind !== myKind) {
      mustBreak = true;
    }
    if (!mustBreak) {
      for (const w of writes) {
        if (pathsCollide(w, writePath)) {
          mustBreak = true;
          break;
        }
      }
    }
    if (!mustBreak && reads !== null) {
      for (const r of reads) {
        for (const w of writes) {
          if (pathsCollide(w, r)) {
            mustBreak = true;
            break;
          }
        }
        if (mustBreak) break;
      }
    }

    if (mustBreak && current.length > 0) {
      groups.push(current);
      current = [];
      writes = new Set();
    }
    current.push(m);
    writes.add(writePath);
    kind = myKind;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function generateUpdateOpGroup(group: UpdateOp[], ctx: GenerateCtx): object {
  if (group.length === 0) {
    internalError("empty update op group");
  }
  if (group[0].type === "AssignExpr") {
    const fields: Record<string, unknown> = {};
    for (const m of group) {
      if (m.type !== "AssignExpr") {
        internalError("mixed-kind update op group");
      }
      const path = updateOpWritePath(m);
      if (Object.prototype.hasOwnProperty.call(fields, path)) {
        internalError(`field '${path}' written twice in same group`);
      }
      fields[path] = _generate(m.value, ctx);
    }
    return { $set: fields };
  }
  // Delete group
  const paths: string[] = [];
  for (const m of group) {
    if (m.type !== "DeleteStmt") {
      internalError("mixed-kind update op group");
    }
    paths.push(updateOpWritePath(m));
  }
  // MongoDB pipeline `$unset` accepts a single string OR an array of strings.
  // Use the more compact string form for size 1 to match handwritten output.
  return paths.length === 1 ? { $unset: paths[0] } : { $unset: paths };
}

/** Reconstruct the dotted write path from a update op target. */
export function updateOpWritePath(m: UpdateOp): string {
  return targetToPath(m.target);
}

function targetToPath(target: Expr): string {
  if (target.type === "FieldRef") return target.path;
  if (target.type === "MemberAccess") {
    return `${targetToPath(target.object)}.${target.member}`;
  }
  // A bare identifier (`x = …`). The parser defers this to codegen because a
  // `let`-binding reassignment is valid — but only inside a pipeline, where
  // `tryLowerAssignSugar` intercepts it before it reaches here. Reaching this
  // point means there is no pipeline scope (Filter / `jsmql.expr` / update-doc
  // mode), so the name can't be a binding.
  if (target.type === "ParamRef") {
    throw new CodegenError(
      `Cannot assign to bare identifier '${target.name}'. ` +
        `Reassignable \`let\` bindings exist only inside a pipeline — add a \`;\` to enter pipeline mode and declare it first (\`let ${target.name} = …\`). ` +
        `To write a document field, use a field path: \`$.${target.name} = …\`.`,
      target.pos,
    );
  }
  internalError("update op target is not a field path (parser should have rejected)");
}

/**
 * Collect dotted field-path reads from an expression. Used by the coalescer
 * to detect read-after-write conflicts within a $set group. Lambda-local
 * params are intentionally not recorded — they reference iteration values,
 * not document fields.
 */
function collectUpdateOpReads(expr: Expr): Set<string> {
  const out = new Set<string>();
  collectReadsInto(expr, out);
  return out;
}

function collectReadsInto(expr: Expr, out: Set<string>): void {
  // Foldable field path (`$.a`, `$.a.b.c`) — record as a single dotted entry.
  const path = tryFieldPath(expr);
  if (path !== null) {
    out.add(path);
    return;
  }
  switch (expr.type) {
    case "FieldRef":
      out.add(expr.path);
      return;
    case "NumberLiteral":
    case "BigIntLiteral":
    case "StringLiteral":
    case "BooleanLiteral":
    case "NullLiteral":
    case "UndefinedLiteral":
    case "RegexLiteral":
    case "ParamRef":
    case "MathConst":
    case "MathCallRef":
    case "DateNow":
    case "ObjectIdLiteral":
    case "TypeCastRef":
      return;
    case "ArrayLiteral":
      for (const el of expr.elements) {
        if (el.type === "SpreadElement") collectReadsInto(el.argument, out);
        else if (
          el.type === "AssignExpr" ||
          el.type === "DeleteStmt" ||
          el.type === "LetDecl" ||
          el.type === "FuncDecl"
        ) {
          // update ops/lets/func-decls inside expressions are rejected elsewhere; ignore here
        } else collectReadsInto(el, out);
      }
      return;
    case "ObjectLiteral":
      for (const e of expr.entries) {
        if (e.type === "SpreadElement") {
          collectReadsInto(e.argument, out);
        } else {
          if (e.key.kind === "computed") collectReadsInto(e.key.expr, out);
          collectReadsInto(e.value, out);
        }
      }
      return;
    case "TemplateLiteral":
      for (const e of expr.expressions) collectReadsInto(e, out);
      return;
    case "BinaryExpr":
      collectReadsInto(expr.left, out);
      collectReadsInto(expr.right, out);
      return;
    case "UnaryExpr":
      collectReadsInto(expr.operand, out);
      return;
    case "TernaryExpr":
      collectReadsInto(expr.condition, out);
      collectReadsInto(expr.consequent, out);
      collectReadsInto(expr.alternate, out);
      return;
    case "IndexAccess":
      collectReadsInto(expr.object, out);
      collectReadsInto(expr.index, out);
      return;
    case "MemberAccess":
      collectReadsInto(expr.object, out);
      return;
    case "MethodCall":
      collectReadsInto(expr.object, out);
      collectArgsInto(expr.args, out);
      return;
    case "CallExpression":
      collectReadsInto(expr.callee, out);
      collectArgsInto(expr.args, out);
      return;
    case "Lambda":
      // A coalesced update-op RHS may embed a lambda — e.g.
      // `$.x = $.items.map(i => { const y = i * 2; return y; })`. Walk both the
      // expression body and the expr-block (decl initialisers + return). The
      // statement-block (`block`) form only appears inside lookup callbacks,
      // which are intercepted before this walker runs.
      if (expr.body !== undefined) collectReadsInto(expr.body, out);
      if (expr.exprBlock !== undefined) {
        for (const d of expr.exprBlock.decls) collectReadsInto(d.value, out);
        collectReadsInto(expr.exprBlock.ret, out);
      }
      return;
    case "TypeofExpr":
      collectReadsInto(expr.operand, out);
      return;
    case "NewDate":
      for (const a of expr.args) collectReadsInto(a, out);
      return;
    case "NewSet":
      if (expr.arg) collectReadsInto(expr.arg, out);
      return;
    case "TypeCast":
      collectReadsInto(expr.arg, out);
      return;
    case "MathCall":
    case "ObjectCall":
      collectArgsInto(expr.args, out);
      return;
    case "ArrayFrom":
      collectReadsInto(expr.input, out);
      if (expr.mapFn) collectReadsInto(expr.mapFn, out);
      return;
    case "NumberStatic":
      collectReadsInto(expr.arg, out);
      return;
    case "OperatorCall":
      collectArgsInto(expr.args, out);
      return;
    case "DateUTC":
      for (const a of expr.args) collectReadsInto(a, out);
      return;
  }
}

function collectArgsInto(args: CallArg[], out: Set<string>): void {
  for (const a of args) {
    if (a.type === "SpreadElement") collectReadsInto(a.argument, out);
    else collectReadsInto(a, out);
  }
}

function tryFieldPath(expr: Expr): string | null {
  if (expr.type === "FieldRef") return expr.path;
  if (expr.type === "MemberAccess") {
    const base = tryFieldPath(expr.object);
    if (base !== null) return `${base}.${expr.member}`;
  }
  return null;
}

/**
 * Two paths "collide" when one is the same as, or a strict ancestor of, the
 * other. `a` and `a` collide; `a` and `a.b` collide; `a` and `b` do not.
 * Used by the update op coalescer to detect conflicts that force a stage
 * boundary.
 */
function pathsCollide(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < b.length && b.startsWith(a) && b.charCodeAt(a.length) === 0x2e /* . */) {
    return true;
  }
  if (b.length < a.length && a.startsWith(b) && a.charCodeAt(b.length) === 0x2e /* . */) {
    return true;
  }
  return false;
}
