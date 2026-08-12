import { lookupOperator } from "./operators.ts";
import { checkArgEnum, checkArgType, TIME_UNIT, validateOperatorArgs } from "./operator-validation.ts";
import { checkEnum, litString, objectInfo } from "./literal-gate.ts";
import { callbackBlockToValue } from "./callback-block.ts";
import { didYouMean } from "./levenshtein.ts";
import { someExpr } from "./ast-walk.ts";
import { CORRELATION_VAR_RE, exprVar, LENGTH_SLOT } from "./namespace.ts";
import { ObjectId } from "./objectid.ts";
import { ASCII_WORDS_RE, HTML_ESCAPE_PAIRS } from "./lodash-shared.ts";
import { type ConstEnv, evalConst } from "./const-eval.ts";
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

/**
 * How every user-facing error spells the cross-collection lookup surface — one
 * constant so the phrasing can't drift between throw sites.
 *
 * Deliberately NOT a list of the methods that may head the chain. `.find` /
 * `.filter`, `.aggregate`, every lodash stream method, and every chained stage
 * call (`.$match(...)`) all can, and that set grows with the registries that
 * own it (`STREAM_METHODS` in stream-methods.ts, `STAGES` in stages.ts). What
 * makes a chain a lookup is the `$$$.<coll>` head, so that is what these
 * messages name; when the method itself is the problem, the unknown-method
 * throw in lookup-translation.ts names the categories and offers a
 * `didYouMean`. See docs/specs/lookup-stage.md.
 */
export const LOOKUP_SYNTAX = "'$$$.<coll>.<method>(...)'";

/**
 * How errors name *where* a `=> { … }` statement block is legal. A statement
 * block parses as a sub-pipeline only in a callback on a stream — `$$` or a
 * `$$$.<coll>` chain (parser: `STREAM_BLOCK_METHODS` × `isStreamRooted`) — and
 * only lowers where that chain stays a stage. Same rule as `LOOKUP_SYNTAX`
 * above: one open-ended example, never an inventory of the methods that take
 * one.
 */
const STREAM_BLOCK_FORM = "a stream-chain callback (e.g. `$$$.<coll>.aggregate((o) => { … })`)";

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
  /**
   * True inside ANY sub-pipeline body (`$lookup.pipeline`, `$unionWith.pipeline`,
   * a `$facet` branch), including an `.aggregate` block. Stages the registry forbids
   * in *every* container ($out / $merge) are rejected on this flag alone, so no
   * sub-pipeline can emit one (HR3) even where the container went unlabelled. See
   * `subPipelineContainer` for the per-container half.
   *
   * Required rather than optional: a ctx built from scratch has to say which side
   * of the boundary it starts on, so a sub-pipeline path added later cannot drop
   * the guard by leaving the field out. Derived ctxs inherit it through the
   * `{ ...ctx }` spread. A path that states it *wrongly* still can't emit invalid
   * MQL — `assertNoWriteStageInSubPipeline` re-checks the assembled stages.
   */
  inSubPipeline: boolean;
  /**
   * WHICH sub-pipeline container we are inside, when it is known — the missing half
   * of `inSubPipeline`. A stage the registry forbids in *every* container needs no
   * label (that is what `inSubPipeline` alone catches); one forbidden in a *single*
   * container (`$collStats`, `forbiddenIn: ["facet"]`) can only be judged against a
   * name, and inside an `.aggregate` block the loop-position validator never sees the
   * stage. Set by the ctx builders — `freshSubPipelineCtx(outer, container)` and
   * `freshFacetCtx` — so it travels with the ctx rather than through
   * `generateImplicitPipeline`, whose `lowerBlock` is shared with lowerings that emit
   * TOP-LEVEL stages (an `$out` write chain's predicate) and would be mislabelled by a
   * fixed container. Left undefined by those, which keeps them on the all-container
   * check alone. Optional, unlike `inSubPipeline`: an unlabelled path loses only
   * message precision, never the HR3 guard.
   */
  subPipelineContainer?: "facet" | "lookup" | "unionWith";
  /**
   * True while lowering stages that a must-be-last stage will FOLLOW — the `$out`
   * write chain's RHS (`$$$.<coll> = $$.<chain>`), whose stages land at the outer
   * pipeline level with the `$out` appended after them. A second write stage there
   * emits two terminal stages, which mongod refuses ("$out can only be the final
   * stage"). The stage-link spelling was already checked (`checkStageLinkPlacement`
   * with `isLastInContainer: false`); this carries the same rule to a stage written
   * inside an `.aggregate` block, which never reaches that call.
   */
  beforeTerminalStage?: boolean;
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
   * Set inside the sub-pipeline of a `$$ = $$$.<coll>…` source-switch (a
   * non-correlated `$unionWith` that REPLACES the stream with a different
   * collection). Outer context — the outer document (`$.<field>`), the root
   * `$$.length`, and outer `let`/`const`s — isn't carried into the new stream,
   * so a reference to any of it is unsatisfiable here. `desc` is the switch
   * (`$$ = $$$.orders`) and `letNames` are the outer bindings that were dropped;
   * both feed a precise "correlate with a `.filter`" error instead of the
   * generic "unknown identifier" / "use the param" fallback. Distinct from
   * `droppedLets` (in-place document reshape) because the fix differs (correlate,
   * not rebind). Seeded only on the union path (`lowerChainOnCollection`).
   */
  sourceSwitch?: { desc: string; letNames: ReadonlySet<string> };
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
   * Shared `__jsmql.tmp.<N>` slot allocator, threaded in so a sub-pipeline
   * block lowered through `generateImplicitPipeline` continues the *enclosing*
   * chain's counter instead of starting a fresh one. Set by the stream `.map`
   * block path (`stream-methods.ts`) to the chain's `allocSlot`, so a nested
   * `$$$.<coll>` lookup materialised inside a `.map(d => { … })` body gets a
   * slot distinct from the outer lookup's `as` (no `__jsmql.tmp.1` collision).
   * When absent, the pipeline lowerer allocates its own per-pipeline counter
   * (the default for top-level pipelines and `.filter` sub-pipeline blocks).
   */
  slotAllocator?: () => string;
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
   * Set while lowering a `$lookup` sub-pipeline **`.aggregate` block**, so a nested
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

const EMPTY_CTX: GenerateCtx = { lambdaParams: new Set(), inSubPipeline: false };

function extendCtx(ctx: GenerateCtx, params: string[]): GenerateCtx {
  return {
    lambdaParams: new Set([...ctx.lambdaParams, ...params]),
    inSubPipeline: ctx.inSubPipeline,
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
    slotAllocator: ctx.slotAllocator,
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
export function freshSubPipelineCtx(outer: GenerateCtx, container?: "facet" | "lookup" | "unionWith"): GenerateCtx {
  return {
    lambdaParams: new Set(),
    inSubPipeline: true,
    ...(container !== undefined && { subPipelineContainer: container }),
    bindings: outer.bindings,
    pipelineContext: outer.pipelineContext,
    // The slot allocator is a pipeline-global resource (gensym counter for
    // `__jsmql.tmp.<N>`), not per-document state, so it crosses sub-pipeline
    // boundaries — a lookup materialised inside a `.map` block keeps allocating
    // from the enclosing chain's counter. Undefined unless an enclosing chain
    // set it, so ordinary sub-pipelines still start their own counter.
    slotAllocator: outer.slotAllocator,
  };
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
    inSubPipeline: true,
    subPipelineContainer: "facet",
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
//             / isArrayProducing / isProvablyBool AND the chain type-check
//             (`certainReceiverType`, which rejects a method chained on a receiver
//             of a provably-incompatible type). Omitted when the result type
//             depends on the receiver/args (e.g. `.slice`, `.concat`, `.at`,
//             `.max`/`.min` → element, `.plus`/`.minus` → same-as-receiver date).
//   optional: the receiver's type, picking the `$ifNull` neutral when a `?.`
//             chain feeds the receiver — "string" → "", "array" → [], "either" →
//             runtime/branch-aware (see neutralForMethod). Omitted for methods
//             whose underlying operator handles null cleanly (date/set/regex).
//             Also doubles as the required-receiver family for the chain
//             type-check (see requiredReceiverFamily).
type MethodReturn = "string" | "array" | "bool" | "number" | "object";
type MethodOptional = "string" | "array" | "either";
//   receiver: the receiver's required type, literal-gated at dispatch — a literal
//             receiver of the wrong type is rejected at compile time (same as the
//             operator form). Only "date" today (the date methods); a field ref /
//             new Date(…) / param no-ops.
type MethodMeta = { returns?: MethodReturn; optional?: MethodOptional; receiver?: "date" };

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
  search: { returns: "number", optional: "string" },
  padStart: { returns: "string", optional: "string" },
  padEnd: { returns: "string", optional: "string" },
  repeat: { returns: "string", optional: "string" },
  indexOf: { returns: "number", optional: "either" },
  includes: { returns: "bool", optional: "either" },
  // ── Array ─────────────────────────────────────────────────────────────────
  at: { optional: "array" },
  slice: { optional: "either" },
  concat: { optional: "either" },
  reverse: { returns: "array", optional: "array" }, // throws in expression position; metadata used by the statement-position rewrite
  toReversed: { returns: "array", optional: "array" },
  toSorted: { returns: "array", optional: "array" },
  sortBy: { returns: "array", optional: "array" },
  orderBy: { returns: "array", optional: "array" },
  toSpliced: { returns: "array" },
  with: { returns: "array" },
  flat: { returns: "array", optional: "array" },
  flatMap: { returns: "array", optional: "array" },
  map: { returns: "array", optional: "array" },
  filter: { returns: "array", optional: "array" },
  find: { optional: "array" },
  findIndex: { returns: "number" },
  findLast: { optional: "array" },
  findLastIndex: { returns: "number", optional: "array" },
  lastIndexOf: { returns: "number" },
  some: { returns: "bool", optional: "array" },
  every: { returns: "bool", optional: "array" },
  reduce: { optional: "array" },
  reduceRight: {},
  join: { returns: "string", optional: "array" }, // returns a string, but the receiver is an array
  // NB `toString` is intentionally left without a `returns` — the key collides with
  // Object.prototype.toString and confuses tsc's contextual typing of the literal;
  // it's also universal (never gated), so its return type doesn't matter here.
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
  // The accessors all return a number ($year/$month/…); toISOString → string;
  // plus/minus → a date (same-as-receiver, so returns is omitted).
  getFullYear: { returns: "number", receiver: "date" },
  getMonth: { returns: "number", receiver: "date" },
  getDate: { returns: "number", receiver: "date" },
  getDay: { returns: "number", receiver: "date" },
  getHours: { returns: "number", receiver: "date" },
  getMinutes: { returns: "number", receiver: "date" },
  getSeconds: { returns: "number", receiver: "date" },
  getMilliseconds: { returns: "number", receiver: "date" },
  getUTCFullYear: { returns: "number", receiver: "date" },
  getUTCMonth: { returns: "number", receiver: "date" },
  getUTCDate: { returns: "number", receiver: "date" },
  getUTCDay: { returns: "number", receiver: "date" },
  getUTCHours: { returns: "number", receiver: "date" },
  getUTCMinutes: { returns: "number", receiver: "date" },
  getUTCSeconds: { returns: "number", receiver: "date" },
  getUTCMilliseconds: { returns: "number", receiver: "date" },
  getTime: { returns: "number" }, // → $toLong, which converts strings/numbers, so the receiver is NOT required to be a date
  toISOString: { returns: "string", receiver: "date" },
  plus: { receiver: "date" },
  minus: { receiver: "date" },
  diff: { returns: "number", receiver: "date" },
  startOf: { receiver: "date" },
  format: { returns: "string", receiver: "date" },
  endOf: { receiver: "date" },
  // ── lodash array methods (Phase 1) ──────────────────────────────────────────
  sum: { returns: "number", optional: "array" },
  mean: { returns: "number", optional: "array" },
  max: { optional: "array" }, // returns the max ELEMENT (unknown type), not a number
  min: { optional: "array" }, // returns the min ELEMENT (unknown type), not a number
  sumBy: { returns: "number", optional: "array" },
  meanBy: { returns: "number", optional: "array" },
  minBy: { optional: "array" }, // returns the ELEMENT with the min key
  maxBy: { optional: "array" }, // returns the ELEMENT with the max key
  uniq: { returns: "array", optional: "array" },
  uniqBy: { returns: "array", optional: "array" },
  sortedUniq: { returns: "array", optional: "array" },
  sortedUniqBy: { returns: "array", optional: "array" },
  without: { returns: "array", optional: "array" },
  xor: { returns: "array", optional: "array" },
  differenceBy: { returns: "array", optional: "array" },
  intersectionBy: { returns: "array", optional: "array" },
  unionBy: { returns: "array", optional: "array" },
  xorBy: { returns: "array", optional: "array" },
  compact: { returns: "array", optional: "array" },
  flatten: { returns: "array", optional: "array" },
  chunk: { returns: "array", optional: "array" },
  take: { returns: "array", optional: "array" },
  drop: { returns: "array", optional: "array" },
  takeRight: { returns: "array", optional: "array" },
  dropRight: { returns: "array", optional: "array" },
  tail: { returns: "array", optional: "array" },
  initial: { returns: "array", optional: "array" },
  head: { optional: "array" },
  first: { optional: "array" },
  last: { optional: "array" },
  nth: { optional: "array" },
  size: { returns: "number", optional: "array" },
  takeWhile: { returns: "array", optional: "array" },
  dropWhile: { returns: "array", optional: "array" },
  takeRightWhile: { returns: "array", optional: "array" },
  dropRightWhile: { returns: "array", optional: "array" },
  sample: { optional: "array" },
  sampleSize: { returns: "array", optional: "array" },
  zipObject: { returns: "object", optional: "array" },
  zip: { returns: "array", optional: "array" },
  unzip: { returns: "array", optional: "array" },
  zipWith: { returns: "array", optional: "array" },
  unzipWith: {}, // shimmed with a tailored "use .unzip().map(group => …)" error

  keyBy: { returns: "object", optional: "array" },
  groupBy: { optional: "array" }, // context-dependent result (value → object, stream → doc-stream); no invariant return
  countBy: { returns: "object", optional: "array" },
  partition: { returns: "array", optional: "array" },
  reject: { returns: "array", optional: "array" },
  // ── lodash object methods (Phase 1) ─────────────────────────────────────────
  mapValues: { returns: "object" },
  mapKeys: { returns: "object" },
  pick: {}, // context-dependent (value → object, stream → $project doc-stream)
  omit: {}, // context-dependent (value → object, stream → $project doc-stream)
  pickBy: { returns: "object" },
  omitBy: { returns: "object" },
  invert: { returns: "object" },
  toPairs: { returns: "array" },
  fromPairs: { returns: "object", optional: "array" },
  // ── lodash string methods (Phase 1; ASCII-only) ─────────────────────────────
  capitalize: { returns: "string", optional: "string" },
  upperFirst: { returns: "string", optional: "string" },
  lowerFirst: { returns: "string", optional: "string" },
  words: { returns: "array", optional: "string" },
  kebabCase: { returns: "string", optional: "string" },
  snakeCase: { returns: "string", optional: "string" },
  startCase: { returns: "string", optional: "string" },
  camelCase: { returns: "string", optional: "string" },
  escape: { returns: "string", optional: "string" },
  truncate: { returns: "string", optional: "string" },
  // ── lodash number methods (Phase 1) ─────────────────────────────────────────
  clamp: {}, // result type follows the receiver/args (number OR date) — no invariant return
  inRange: { returns: "bool" },
  round: { returns: "number" },
  ceil: { returns: "number" },
  floor: { returns: "number" },
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

// Every JS-method alias jsmql recognises (the `METHODS` registry keys). Consumed by
// `scripts/generate-ops.mjs` to drift-check the `@koresar/jsmql/ops` value-method
// prototype augmentations against the registry — the same single-source-of-truth
// contract `streamMethodNames()` gives the stream-method members.
export function valueMethodNames(): readonly string[] {
  return Object.keys(METHODS);
}

// The invariant result category of each method (`METHODS[name].returns`), or
// `undefined` when the result type depends on the receiver/args. Consumed by the
// same generator drift-check to assert each value-method augmentation's TS return
// type stays in the category the registry declares — so a registry `returns`
// change that isn't mirrored in the ambient signature fails the build.
export function valueMethodReturns(): Record<string, MethodReturn | undefined> {
  const out: Record<string, MethodReturn | undefined> = {};
  for (const name of Object.keys(METHODS)) out[name] = METHODS[name].returns;
  return out;
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

/**
 * Is every element of `expr` provably an array — i.e. is it an array OF arrays?
 *
 * Only two shapes are certain: an array literal whose every element is itself an
 * array, and `.partition(pred)` (whose result is always the two-bucket
 * `[[…matched], […rest]]`). Everything else returns false, per the literal-gating
 * rule: an unknown receiver must not be guessed at.
 *
 * `.join()` / `.toString()` need this because JS stringifies nested arrays
 * recursively (`[[1,2],[3]].join(",") === "1,2,3"`) and MQL has no recursion —
 * `$toString` of an array is an execution-time failure, so the honest answer is a
 * compile-time rejection wherever we can prove the shape.
 */
function isArrayOfArrays(expr: Expr): boolean {
  if (expr.type === "ArrayLiteral") {
    if (expr.elements.length === 0) return false;
    return expr.elements.every((el) => {
      switch (el.type) {
        // Not a plain element — the shape is unknown, so don't guess.
        case "SpreadElement":
        case "AssignExpr":
        case "DeleteStmt":
        case "LetDecl":
        case "FuncDecl":
          return false;
        default:
          return isArrayProducing(el);
      }
    });
  }
  return expr.type === "MethodCall" && expr.method === "partition";
}

/**
 * Reject `.join()` / `.toString()` on a provable array OF arrays. JS stringifies
 * nested arrays recursively; MQL expressions have no recursion, so the emitted
 * `$toString` of an element would fail at execution time ("Unsupported conversion
 * from array to string"). Emitting that would break HR3, and quietly flattening one
 * level would answer a different question than the source asked — so say what the
 * user must decide. Fires only on the two provable shapes (`isArrayOfArrays`).
 */
function rejectNestedArrayStringify(object: Expr, method: string, callPos: number): void {
  if (!isArrayOfArrays(object)) return;
  const recv = object.type === "MethodCall" ? `'.${object.method}(...)'` : "this array literal";
  throw new CodegenError(
    `.${method}() can't stringify an array of arrays — ${recv} holds arrays, and MongoDB has no recursive ` +
      `string conversion (JavaScript's nested '[[1,2],[3]].${method}()' has no MQL equivalent). ` +
      `Flatten first ('.flat().${method}()'), or map each inner array to a string ('.map(a => a.${method}()).${method}()').`,
    callPos,
  );
}

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

// ── Chain type-check ──────────────────────────────────────────────────────────
//
// Reject a method chained on a receiver whose type is 100%-CERTAIN to be
// incompatible — the "lodash-style chaining must make sense" rule. Examples that
// now throw at compile time instead of emitting server-rejected MQL:
//   `.every(p).map(f)`      — a boolean has no methods (only .toString/.getTime)
//   `s.toUpperCase().map(f)`— a string is not an array
//   `a.size().map(f)`       — a number is not an array
//   `a.countBy("t").take(3)`— an object map is not an array
// Literal-gated exactly like the date-receiver gate: `certainReceiverType`
// returns non-null ONLY when the receiver type is provable, so an unknown receiver
// (a field ref, a `.find()`/`.at()`/`.max()` element of unknown type, a `.concat`/
// operator/`{$op}`-literal result) never throws and still emits — mongod decides.
// Deliberately NOT derived from isStringProducing (STRING_OUTPUT_OPS holds the
// int-returning $strcasecmp) nor object literals (a `{$op}` escape hatch can return
// any type): only method `returns` and the verified-sound array/bool producers
// seed a rejection. See docs/specs/method-dispatch.md § chain type-check.

// Methods whose receiver must be a number / a document. Their `optional` field is
// absent or "either", so it can't stand in for the required-receiver type — these
// two sets fill that gap for `requiredReceiverFamily`. `clamp` is excluded (its
// receiver may be a number OR a date), matching its omitted `returns`.
const NUMBER_RECEIVER_METHODS = new Set(["round", "ceil", "floor", "inRange"]);
const OBJECT_RECEIVER_METHODS = new Set([
  "mapValues",
  "mapKeys",
  "invert",
  "pickBy",
  "omitBy",
  "pick",
  "omit",
  "toPairs",
]);

type ReceiverFamily = "string" | "array" | "number" | "date" | "object";

/** The receiver type a method REQUIRES, or null when it's dual / universal
 *  (`.slice`/`.concat`/`.indexOf`/`.includes` accept string OR array; `.size`
 *  accepts array OR object; `.toString`/`.getTime` accept any) or simply unknown.
 *  Null-family methods are never gated, so their legitimate multi-type uses always
 *  compile — that's the deliberate false-positive-avoiding gap. */
export function requiredReceiverFamily(method: string): ReceiverFamily | null {
  const meta = METHODS[method];
  if (meta === undefined) return null;
  if (method === "size" || method === "toString" || method === "getTime") return null;
  if (meta.receiver === "date") return "date";
  if (NUMBER_RECEIVER_METHODS.has(method)) return "number";
  if (OBJECT_RECEIVER_METHODS.has(method)) return "object";
  if (meta.optional === "string") return "string";
  if (meta.optional === "array") return "array";
  return null;
}

/** The provable, invariant type of a receiver expression, or null when uncertain.
 *  `bool`/`array` reuse the verified-sound isProvablyBool/isArrayProducing (which
 *  recurse through `.slice`/MethodCall and subsume literals + array-typed ops);
 *  `string`/`number`/`object` come from the receiver method's invariant `returns`.
 *  Returns null for every unknown receiver — the literal-gating guarantee. */
function certainReceiverType(o: Expr): "bool" | "array" | "string" | "number" | "object" | null {
  if (isProvablyBool(o)) return "bool";
  if (isArrayProducing(o)) return "array";
  if (o.type === "MethodCall") {
    if (o.method === "slice") return certainReceiverType(o.object); // .slice preserves receiver type
    const r = METHODS[o.method]?.returns;
    if (r === "string" || r === "number" || r === "object") return r;
  }
  return null;
}

export const RECEIVER_NOUN: Record<string, string> = {
  bool: "a boolean",
  string: "a string",
  array: "an array",
  number: "a number",
  date: "a date",
  object: "an object (a document)",
};

/**
 * Does `method` return an ELEMENT of its array receiver, rather than a value of
 * some fixed type? These carry no invariant `returns` in `METHODS` on purpose —
 * `[1, 2].head()` is a number while `[{}, {}].head()` is a document, so the
 * generic type inference can't commit. A caller that *knows* its receiver is a
 * stream of documents (a `$$$.<coll>` chain) can commit, which is what lets
 * `lookup-translation.ts` reject a string/array method after one.
 */
export function returnsReceiverElement(method: string): boolean {
  const meta = METHODS[method];
  return meta !== undefined && meta.optional === "array" && meta.returns === undefined;
}

/**
 * The receiver noun `method` demands when it cannot possibly run on a DOCUMENT,
 * or null when a document is fine (object-family and universal methods).
 *
 * Beyond the four single families this also catches the **dual** `string | array`
 * methods (`.slice`, …). `requiredReceiverFamily` returns null for those — it
 * can't tell which of the two is meant, and guessing would cause false positives
 * on legitimate uses. A document is *neither*, so here the dual family is still a
 * certainty, not a guess.
 */
export function documentReceiverViolation(method: string): string | null {
  const fam = requiredReceiverFamily(method);
  if (fam === "string" || fam === "array" || fam === "number" || fam === "date") return RECEIVER_NOUN[fam];
  if (METHODS[method]?.optional === "either") return "an array or a string";
  return null;
}

function receiverPhrase(o: Expr): string {
  return o.type === "MethodCall" ? `'.${o.method}(...)'` : "the value before it";
}

/** Throw when `method` cannot run on a receiver of the provable type `recv`.
 *  `object` supplies the error position and a human phrase. */
function rejectIncompatibleChain(
  recv: "bool" | "array" | "string" | "number" | "object",
  method: string,
  object: Expr,
): void {
  // A boolean is a scalar with NO methods except `.toString()` / `.getTime()`, so
  // reject regardless of the called method's required family (unlike the other
  // types, which each have their own valid method families).
  if (recv === "bool") {
    if (method === "toString" || method === "getTime") return;
    throw new CodegenError(
      `'.${method}(...)' can't run on a boolean — ${receiverPhrase(object)} evaluates to true/false, which has no methods (only .toString() / .getTime()). ` +
        `Move '.${method}(...)' ahead of the step that collapses the value to a boolean.`,
      object.pos,
    );
  }
  const need = requiredReceiverFamily(method);
  if (need === null || need === recv) return; // dual/universal method, or a matching family
  const hint =
    recv === "array" && need === "object"
      ? `Use it on a single document, or '.map(x => x.${method}(...))' to apply it per element.`
      : recv === "array"
        ? `Map over the array first, e.g. '.map(x => x.${method}(...))', or take one element with '.at(0)'.`
        : recv === "object" && need === "array"
          ? `Iterate its values with 'Object.values(...)' or its entries with 'Object.entries(...)' / '.toPairs()' first.`
          : `Call '.${method}(...)' on ${RECEIVER_NOUN[need]} value instead.`;
  throw new CodegenError(
    `'.${method}(...)' expects ${RECEIVER_NOUN[need]} receiver, but ${receiverPhrase(object)} returns ${RECEIVER_NOUN[recv]}. ${hint}`,
    object.pos,
  );
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
 * Coerce a receiver to a string for a `$let` binding, without double-wrapping.
 */
function coerceStringBinding(genObj: unknown): unknown {
  return isIfNullWrapped(genObj) ? genObj : wrapIfNull(genObj, "");
}

/**
 * True when a generated value is a source string literal exactly one code point
 * long. Repeating such a pad N times lands on exactly N characters, so the
 * padding lowering can skip its trim. Per HR1 a `$`-prefixed source string is a
 * field reference, never a literal — its length is unknown at compile time.
 */
function isSingleCodePointLiteral(value: unknown): boolean {
  return typeof value === "string" && !value.startsWith("$") && [...value].length === 1;
}

/**
 * Name a compiler-emitted `$let` / `$map` / `$filter` variable, plus its `$$` read.
 * Returns `[name, ref]` because nearly every caller needs both — the `vars`/`as`
 * key and the references spliced into the body.
 *
 * MongoDB variables live in ONE flat scope shared with the user's lambda params,
 * so a lowering that binds its receiver and then splices outer-scope codegen into
 * the same `$let` will capture any argument referencing a param of that name. The
 * `jsmql` prefix (`src/namespace.ts` § expression variables) makes that unlikely;
 * the gensym makes it impossible. It returns the prefixed base untouched unless
 * the name is genuinely in scope, so output only changes for a program that
 * actually uses it — and then OUR binding moves aside, never the user's param.
 *
 * Comparing against the raw `lambdaParams` is exact here: `safeVarName` only ever
 * prepends `v`, and no `jsmql`-prefixed base can be the image of that.
 */
function internalVar(ctx: GenerateCtx, base: string): [string, string] {
  const name = gensymInScope(ctx, exprVar(base));
  return [name, `$$${name}`];
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

/**
 * Floor an already-generated index or length at 0, folding when known.
 * `$substrCP` rejects a negative start (`Location34455`) and a negative length
 * (`Location34454`) outright — it aborts the whole query rather than returning
 * a value — so every index/length jsmql *derives* (rather than passes through
 * from a literal) goes through here. `$max` ignores nulls, so a floored value
 * stays safe when the receiver is missing.
 */
function clampNonNegative(value: unknown): unknown {
  if (typeof value === "number") return Math.max(0, value);
  return { $max: [0, value] };
}

/** True when `value` is already an `$ifNull` wrap (e.g. an optional-chain receiver). */
function isIfNullWrapped(value: unknown): boolean {
  return typeof value === "object" && value !== null && "$ifNull" in value && Object.keys(value).length === 1;
}

/**
 * `$strLenCP` of a generated value, tolerant of a missing field.
 *
 * `$strLenCP` is the one string primitive that **aborts the query** on a
 * missing/null input (`Location34471`) — `$indexOfCP` returns null and
 * `$substrCP` returns "". Since a length is something jsmql derives rather than
 * something the user wrote, an absent field would otherwise take down a query
 * through `.endsWith()` while the same predicate spelled `.startsWith()` simply
 * returned false. Coercing here makes the whole string surface behave alike.
 *
 * Folds a literal receiver to its **code point** count: `$strLenCP` counts code
 * points where JS `.length` counts UTF-16 units, so "a👍b" is 3, not 4. A source
 * string starting with `$` is an MQL field reference (HR1), never a literal.
 */
function strLenOf(value: unknown): unknown {
  if (typeof value === "string" && !value.startsWith("$")) return [...value].length;
  return { $strLenCP: isIfNullWrapped(value) ? value : wrapIfNull(value, "") };
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
 * negative indices as `len + idx`, floored at 0; MQL `$substrCP` rejects
 * negatives. Folds literal negatives into `$strLenCP - n` at compile time;
 * non-literals expand to a `$cond` that picks the form at runtime. Either way
 * the from-the-end result is floored, because `len + idx` is itself negative
 * when the receiver is shorter than the index (`"abc".slice(-5)`).
 *
 * Mirrors `resolveSliceIndex`, the array analogue, which floors the same way.
 *
 * `genObj` is reused for `$strLenCP` rather than re-generating from the
 * source AST, so callers should pass the same generated value they use in
 * the surrounding `$substrCP` call.
 */
function normaliseSliceIndex(node: Expr, ctx: GenerateCtx, genObj: unknown): unknown {
  if (node.type === "NumberLiteral") {
    if (node.value >= 0) return node.value;
    return clampNonNegative(foldedSubtract(strLenOf(genObj), -node.value));
  }
  if (node.type === "UnaryExpr" && node.op === "-" && node.operand.type === "NumberLiteral") {
    return clampNonNegative(foldedSubtract(strLenOf(genObj), node.operand.value));
  }
  const gen = _generate(node, ctx);
  return cond({ $lt: [gen, 0] }, clampNonNegative({ $add: [gen, strLenOf(genObj)] }), gen);
}

/** Signed integer value of a slice-index literal (`5` or `-5`), else null
 *  (runtime expression, or a non-integer literal we don't fold). */
function literalIndexValue(node: Expr): number | null {
  if (node.type === "NumberLiteral" && Number.isInteger(node.value)) return node.value;
  if (
    node.type === "UnaryExpr" &&
    node.op === "-" &&
    node.operand.type === "NumberLiteral" &&
    Number.isInteger(node.operand.value)
  ) {
    return -node.operand.value;
  }
  return null;
}

/**
 * JS-resolve a `.slice` index against the array length `size`, mirroring the
 * `k`/`final` clamping in the ECMAScript `Array.prototype.slice` algorithm:
 * a negative index counts from the end (`size + i`, floored at 0); a positive
 * one clamps up to `size`. Literals fold to plain `$min`/`$max`; a runtime
 * index expands to a `$cond` that picks the branch at runtime.
 */
function resolveSliceIndex(node: Expr, ctx: GenerateCtx, size: unknown): unknown {
  const lit = literalIndexValue(node);
  if (lit !== null) {
    if (lit === 0) return 0;
    if (lit > 0) return { $min: [lit, size] };
    return { $max: [{ $subtract: [size, -lit] }, 0] };
  }
  const gen = _generate(node, ctx);
  return { $cond: [{ $lt: [gen, 0] }, { $max: [{ $add: [gen, size] }, 0] }, { $min: [gen, size] }] };
}

/**
 * Lower array `.slice(start, end?)` to MQL `$slice`, faithful to
 * `Array.prototype.slice`: `start`/`end` are indices (end **exclusive**) and
 * negatives count from the end. MongoDB's `$slice` is position+**count** based
 * (and its 3-arg count must be > 0), so we translate rather than pass the JS
 * args straight through. See docs/specs/method-dispatch.md.
 */
function sliceArray(genObj: unknown, exprArgs: Expr[], ctx: GenerateCtx): unknown {
  if (exprArgs.length === 0) return genObj;

  const startNode = exprArgs[0];
  const startLit = literalIndexValue(startNode);

  // --- slice(start): every element from `start` to the end ---
  if (exprArgs.length === 1) {
    // Negative literal → last |start| elements: the 2-arg `$slice` primitive.
    if (startLit !== null && startLit < 0) return { $slice: [genObj, startLit] };
    // slice(0) is a whole-array copy.
    if (startLit === 0) return genObj;
    // Positive literal or runtime start → drop the first `start` (a runtime
    // negative start is resolved from the end by `$slice`'s position arg).
    // count = max(1, size) so an empty array is `$slice: [[], start, 1]` → []
    // rather than a rejected count of 0 (same guard as `.drop(n)`).
    const [vArr, arr] = internalVar(ctx, "arr");
    return {
      $let: {
        vars: { [vArr]: genObj },
        in: { $slice: [arr, _generate(startNode, ctx), { $max: [1, { $size: arr }] }] },
      },
    };
  }

  // --- slice(start, end): elements at indices [start, end) ---
  const endNode = exprArgs[1];
  const endLit = literalIndexValue(endNode);

  // Both indices are non-negative literals → pure arithmetic, no `$size` needed.
  if (startLit !== null && startLit >= 0 && endLit !== null && endLit >= 0) {
    // start 0 → "first `end`". The 2-arg `$slice` tolerates a 0 count (→ []),
    // so no guard is needed and a 0-length slice needs no special case.
    if (startLit === 0) return { $slice: [genObj, endLit] };
    if (endLit <= startLit) return []; // empty range
    return { $slice: [genObj, startLit, endLit - startLit] };
  }

  // start 0 (literal), non-literal-or-negative end → "first `end`": resolve the
  // end index and lean on the 2-arg (count-tolerant) `$slice`.
  if (startLit === 0) {
    const [vArr, arr] = internalVar(ctx, "arr");
    return {
      $let: { vars: { [vArr]: genObj }, in: { $slice: [arr, resolveSliceIndex(endNode, ctx, { $size: arr })] } },
    };
  }

  // General case (negative start, or a runtime index): resolve both indices
  // against the length, take `end - start` elements from the resolved start,
  // and guard the empty range (the 3-arg `$slice` count must be > 0). The
  // slice's own count is `max(count, 1)` — never 0 — so that when the array is
  // a compile-time literal, MongoDB's optimizer can fold the (unselected) slice
  // branch instead of rejecting a constant 0-count `$slice`; the outer `$cond`
  // still returns `[]` for the empty range.
  const [vArr, arr] = internalVar(ctx, "arr");
  const [vK, k] = internalVar(ctx, "k");
  const [vF, f] = internalVar(ctx, "f");
  const count = { $subtract: [f, k] };
  return {
    $let: {
      vars: { [vArr]: genObj },
      in: {
        $let: {
          vars: {
            [vK]: resolveSliceIndex(startNode, ctx, { $size: arr }),
            [vF]: resolveSliceIndex(endNode, ctx, { $size: arr }),
          },
          in: { $cond: [{ $gt: [count, 0] }, { $slice: [arr, k, { $max: [count, 1] }] }, []] },
        },
      },
    },
  };
}

/** Negate a count that's either a compile-time number or a runtime expression. */
function negate(n: unknown): unknown {
  return typeof n === "number" ? -n : { $subtract: [0, n] };
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
    // `strLen - start` is negative when start runs past the end ("".slice(1)).
    return { $substrCP: [genObj, start, clampNonNegative(foldedSubtract(strLenOf(genObj), start))] };
  }
  const end = normaliseSliceIndex(exprArgs[1], ctx, genObj);
  return { $substrCP: [genObj, start, clampNonNegative(foldedSubtract(end, start))] };
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

/**
 * Generate an `ExprBlock` (`{ (const|let … ;)* return <expr>; }`) as a value — the
 * right-folded nest of `$let` a block-bodied arrow means. Exported for the predicate
 * translators, which lower a block-bodied predicate into `$match: { $expr: … }` and
 * must not re-implement the folding, shadowing, and re-declaration rules
 * [generateExprBlock] already owns.
 */
export function generateExprBlockWithCtx(block: ExprBlock, ctx: GenerateCtx): unknown {
  return generateExprBlock(block, ctx);
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
      //   - `$$$.<coll>.<chain>` → `$lookup` stage (read).
      //   - `$$$.<coll> = <RHS>` → `$out` stage (write).
      // Reaching this case means neither matched: the user wrote `$$$.<coll>`
      // as a bare value, used the chain in an expression-only position (a
      // Filter, `jsmql.expr`, an arithmetic operand), or headed it with a
      // method the pre-materialisation walker didn't recognise.
      throw new CodegenError(
        `'$$$.<coll>' must be either followed by a stream chain and consumed as a value (a $lookup read — ` +
          `any lodash stream method may head the chain, e.g. '.filter(pred)' / '.toSorted(...)', and ` +
          `'.aggregate((o) => { ... })' runs a full sub-pipeline), ` +
          `or assigned to as a destination ('$$$.<coll> = $$' → $out write). ` +
          `Bare '$$$' reference is not a value, and these sugars are only valid in Pipeline mode (use \`;\`-separated statements or jsmql.pipeline()). ` +
          `(System diagnostics aren't database-scoped: collection ones are on '$$', server/cluster ones on '$$$$'.)`,
        expr.pos,
      );
    case "ClusterRef":
      // The one value-position use of `$$$$.<db>.<coll>` is `= <RHS>` (cross-db
      // $out), materialised pre-codegen. Cross-database READS (`.find/.filter`,
      // `$$.push(...)`, `$$ = …`) are NOT supported — MongoDB rejects the
      // `{ db, coll }` join/union namespace on a regular server — and are rejected
      // at their own lowering site (`requireSameDbColl`). Reaching this case means
      // a bare reference / expression-only position / wrong depth / dynamic names.
      throw new CodegenError(
        `'$$$$.<db>.<coll>' is only usable as a cross-database $out destination ('$$$$.<db>.<coll> = $$'). ` +
          `Cross-database READS aren't supported (a $lookup/$unionWith with a '{ db, coll }' namespace is rejected by a standalone / replica-set / sharded MongoDB) — use a same-database reference '$$$.<coll>' instead. ` +
          `A direct call on '$$$$' is a server/cluster-scoped diagnostic source stage ` +
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
      // Compiler-generated `$lookup.let` correlation var (`jsmql_f|v|s<depth>_<name>`,
      // see namespace.ts). These are produced ONLY by the lookup let-extractor and
      // are captured into some enclosing lookup's `let` — possibly LAZILY, as a
      // deeper level's cross-level read induces the capture after this level's
      // `lambdaParams` set was frozen — so they may not appear in `lambdaParams`.
      // MQL `$$` vars propagate through nested `$lookup.pipeline` boundaries, so the
      // var is in scope by construction; emit it directly. (User identifiers can't
      // collide: this exact reserved shape is never produced from user source.)
      if (CORRELATION_VAR_RE.test(expr.name)) {
        return `$$${expr.name}`;
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
      if (ctx.sourceSwitch?.letNames.has(expr.name)) {
        throw new CodegenError(
          `\`${expr.name}\` is a \`let\`/\`const\` declared before \`${ctx.sourceSwitch.desc}\`, which replaces the stream ` +
            `with a different collection (a \`$unionWith\`, which can't correlate) — so \`${expr.name}\` ` +
            `(along with the outer document and the root \`$$.length\`) isn't available inside the new stream. ` +
            `To read outer values per document, correlate with a \`.filter\` instead: ` +
            `\`$$$.<coll>.filter(d => d.<field> === $.<field>).map(…)\` lowers to a \`$lookup\` and threads ` +
            `\`${expr.name}\`, \`$.<field>\`, and \`$$.length\` into the sub-pipeline.`,
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
    return sizeOf(optional ? wrapIfNull(v, []) : v);
  }
  const rawObj = _generate(object, ctx);
  if (isStringProducing(object)) return strLenOf(rawObj);
  if (isArrayProducing(object)) return sizeOf(optional ? wrapIfNull(rawObj, []) : rawObj);
  const obj = optional ? wrapIfNull(rawObj, []) : rawObj;
  // Only the string branch needs coercing: an absent field is already routed to
  // `$size([])` by the `[]` neutral when the chain is optional, and reaches the
  // else branch (where `$strLenCP` would abort) when it isn't.
  return cond({ $isArray: obj }, sizeOf(obj), strLenOf(obj));
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
        `Use it inside a pipeline (e.g. \`({ $ }) => { $.n = $$.length; … }\`); it has no meaning in a Filter or in 'jsmql.expr'.`,
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
      const [vKv, kv] = internalVar(ctx, "kv");
      operands.push({ $map: { input: { $objectToArray: _generate(entry.argument, ctx) }, as: vKv, in: `${kv}.k` } });
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

/**
 * Wrap the operand of a **positional single-array-argument** operator (`$size`,
 * `$first`, `$last`, `$reverseArray`) so a *literal* array can't be read as the
 * argument LIST. MongoDB splices a bare array there: `{ $size: [1, 2] }` is two
 * arguments ("takes exactly 1 arguments. 2 were passed in") and the one-element
 * `{ $size: [1] }` unwraps to the scalar ("must be an array, but was of type:
 * int") — so `[1, 2].length` emitted invalid MQL. One extra level,
 * `{ $size: [[1, 2]] }`, is unwrapped exactly once back to the intended operand.
 *
 * Every other operand — a field path, a `$$var`, a nested operator document — is
 * already unambiguous and passes through untouched, so the four constructors below
 * are safe to use at every site. Same trap and same remedy as
 * `arrayToObjectOfLiteralPairs`. Applies only to jsmql's own lowering; a raw
 * `$op($size, …)` stays a faithful passthrough (HR2).
 */
function singleArrayArg(operand: unknown): unknown {
  return Array.isArray(operand) ? [operand] : operand;
}

const sizeOf = (a: unknown): Record<string, unknown> => ({ $size: singleArrayArg(a) });
const firstOf = (a: unknown): Record<string, unknown> => ({ $first: singleArrayArg(a) });
const lastOf = (a: unknown): Record<string, unknown> => ({ $last: singleArrayArg(a) });
const reverseArrayOf = (a: unknown): Record<string, unknown> => ({ $reverseArray: singleArrayArg(a) });

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
        `$let second argument cannot be a statement-block arrow (a sub-pipeline of stages) — that form is only for ${STREAM_BLOCK_FORM}. Use an expression, or a value-returning block \`() => { const a = …; return a; }\`.`,
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

// Shared expression builders for the lodash string methods (Phase 1). ASCII-only
// by design: `$toUpper`/`$toLower` are ASCII, and word splitting matches ASCII
// alphanumerics (accented text passes through / is treated as separators).
function strTail(s: unknown, from: number): unknown {
  return { $substrCP: [s, from, strLenOf(s)] };
}
function capitalizeExpr(s: unknown): unknown {
  return { $concat: [{ $toUpper: { $substrCP: [s, 0, 1] } }, { $toLower: strTail(s, 1) }] };
}
function firstCharExpr(s: unknown, op: "$toUpper" | "$toLower"): unknown {
  return { $concat: [{ [op]: { $substrCP: [s, 0, 1] } }, strTail(s, 1)] };
}
// The ASCII words of a string, splitting on non-alphanumerics AND camelCase
// boundaries — e.g. "foo-barBaz 9" → ["foo", "bar", "Baz", "9"], "FOOBar" →
// ["FOO", "Bar"]. Pattern (`ASCII_WORDS_RE`) is shared with the compile-time
// fold (lodash-fold.ts) via lodash-shared.ts so the two can't drift.
// `$regexFindAll` needs 4.4+.
// These two take no ctx, so their element vars can't be gensym'd — safe because
// both bodies are fixed MQL built from the ref itself, never user codegen, so
// there is nothing inside that could reference an outer param. (`exprVar` still
// owns the spelling.)
function wordsExpr(s: unknown): unknown {
  const w = exprVar("word");
  return { $map: { input: { $regexFindAll: { input: s, regex: ASCII_WORDS_RE } }, as: w, in: `$$${w}.match` } };
}
// Join word expressions with `sep`, optionally transforming each word first.
function joinWords(words: unknown, sep: string, transform?: (w: unknown) => unknown): unknown {
  const w = exprVar("w");
  const items = transform === undefined ? words : { $map: { input: words, as: w, in: transform(`$$${w}`) } };
  return {
    $reduce: {
      input: items,
      initialValue: "",
      in: { $cond: [{ $eq: ["$$value", ""] }, "$$this", { $concat: ["$$value", sep, "$$this"] }] },
    },
  };
}
function escapeHtmlExpr(s: unknown): unknown {
  let e: unknown = s;
  for (const [find, replacement] of HTML_ESCAPE_PAIRS) e = { $replaceAll: { input: e, find, replacement } };
  return e;
}

// Desugar a lodash iteratee / predicate SHORTHAND into a synthetic one-parameter
// arrow, so every higher-order method accepts the same forms and lowers each to
// exactly what the equivalent arrow would (whether the method reads the result as a
// value or a boolean is the method's business — `.map("x")` plucks, `.filter("x")`
// truthy-tests). Three forms; returns null for anything else (a real arrow, a bare
// `Boolean`/`Math.floor` cast, …) so the caller keeps its own handling:
//   • property string   `"a.b"`       → `it => it.a.b`                    (_.property)
//   • matches object    `{ a: 1, b }` → `it => it.a === 1 && it.b === b`  (_.matches, flat $eq per key)
//   • matchesProperty   `["a.b", v]`  → `it => it.a.b === v`              (_.matchesProperty)
export function shorthandToLambda(arg: Expr, method: string, param: string): Lambda | null {
  const pos = arg.pos;
  const paramRef: Expr = { type: "ParamRef", name: param, pos };
  const memberPath = (base: Expr, path: string): Expr => {
    let e = base;
    for (const seg of path.split(".")) e = { type: "MemberAccess", object: e, member: seg, pos };
    return e;
  };
  const lambda = (body: Expr): Lambda => ({ type: "Lambda", params: [param], body, pos });
  if (arg.type === "StringLiteral") {
    if (arg.value === "" || arg.value.startsWith("$")) {
      throw new CodegenError(`.${method}("field") requires a plain field name (no leading '$').`, pos);
    }
    return lambda(memberPath(paramRef, arg.value));
  }
  if (arg.type === "ObjectLiteral") {
    if (arg.entries.length === 0) throw new CodegenError(`.${method}({ … }) needs at least one field to match.`, pos);
    const eqs: Expr[] = arg.entries.map((entry) => {
      if (entry.type !== "KeyValueEntry" || entry.key.kind !== "static") {
        throw new CodegenError(`.${method}({ … }) matcher keys must be plain field names.`, entry.pos);
      }
      return {
        type: "BinaryExpr",
        op: "===",
        left: memberPath(paramRef, entry.key.name),
        right: entry.value,
        pos: entry.pos,
      };
    });
    return lambda(eqs.reduce((a, b) => ({ type: "BinaryExpr", op: "&&", left: a, right: b, pos })));
  }
  if (arg.type === "ArrayLiteral") {
    const els = arg.elements;
    const path = els[0];
    const value = els[1];
    // The value must be a plain expression (not a spread or an update/decl statement,
    // which are only valid inside a pipeline-shaped array literal).
    const valueIsExpr =
      value !== undefined &&
      value.type !== "SpreadElement" &&
      value.type !== "AssignExpr" &&
      value.type !== "DeleteStmt" &&
      value.type !== "LetDecl" &&
      value.type !== "FuncDecl";
    if (els.length !== 2 || path.type !== "StringLiteral" || !valueIsExpr) {
      throw new CodegenError(
        `.${method}(["field", value]) matchesProperty shorthand needs a field-name string and a value.`,
        pos,
      );
    }
    return lambda({ type: "BinaryExpr", op: "===", left: memberPath(paramRef, path.value), right: value, pos });
  }
  return null;
}

// A lodash *iteratee* for the array methods (`.keyBy`, `.sumBy`, `.uniqBy`, …):
// a single-parameter arrow (`x => x.id`), one of the `shorthandToLambda` forms
// (`"id"` / `{ active: true }` / `["a.b", v]`), or omitted (identity). Returns the
// `$map`/`$filter` element var name and the iteratee expression evaluated against it.
type ResolvedIteratee = { as: string; elem: string; value: unknown };
function resolveIteratee(iteratee: Expr | undefined, method: string, ctx: GenerateCtx): ResolvedIteratee {
  const AS = gensymInScope(ctx, exprVar("item"));
  if (iteratee === undefined) return { as: AS, elem: `$$${AS}`, value: `$$${AS}` };
  if (iteratee.type === "Lambda" && iteratee.block === undefined && iteratee.params.length === 1) {
    const as = safeVarName(iteratee.params[0]);
    return { as, elem: `$$${as}`, value: _generate(iteratee.body as Expr, extendCtx(ctx, [iteratee.params[0]])) };
  }
  const lam = shorthandToLambda(iteratee, method, AS);
  if (lam !== null) {
    return { as: AS, elem: `$$${AS}`, value: _generate(lam.body as Expr, extendCtx(ctx, [AS])) };
  }
  throw new CodegenError(
    `.${method}(iteratee) takes a field name ("id"), a matches object ({ active: true }), a ["field", value] pair, or a single-parameter arrow ('x => x.id').`,
    iteratee.pos,
  );
}

// A lodash *predicate* for `.partition` / `.reject` / `.takeWhile` / …: any of the
// iteratee forms above, read as a boolean. Shares `resolveIteratee` so the shorthand
// vocabulary and lowering stay identical to the value-producing methods.
function resolvePredicate(pred: Expr, method: string, ctx: GenerateCtx): { as: string; cond: unknown } {
  const it = resolveIteratee(pred, method, ctx);
  return { as: it.as, cond: it.value };
}

// `.takeWhile` / `.dropWhile` from the LEFT: find the first element whose predicate
// is falsy (`$indexOfArray` on the strict-boolified predicate array → -1 if none),
// then slice on that boundary. The receiver is bound to an internal var; the caller
// passes the (possibly reversed) array in. `drop` picks the keep-from-boundary slice;
// otherwise the take-up-to-boundary slice.
function takeDropWhile(
  arrExpr: unknown,
  pred: { as: string; cond: unknown },
  drop: boolean,
  ctx: GenerateCtx,
): unknown {
  const [vArr, arr] = internalVar(ctx, "arr");
  const [vFi, fi] = internalVar(ctx, "fi");
  const preds = { $map: { input: arr, as: pred.as, in: { $cond: [pred.cond, true, false] } } };
  const body = drop
    ? { $cond: [{ $eq: [fi, -1] }, [], { $slice: [arr, fi, { $size: arr }] }] }
    : // take: the first `fi` elements. The 2-arg `$slice` (first-n) — NOT the
      // 3-arg `$slice: [arr, 0, fi]` — so a boundary at index 0 (the first
      // element already fails the predicate) is `$slice: [arr, 0]` → `[]`, instead of
      // the 3-arg `$slice: [arr, 0, 0]` mongod rejects ("count must be positive").
      { $cond: [{ $eq: [fi, -1] }, arr, { $slice: [arr, fi] }] };
  return {
    $let: { vars: { [vArr]: arrExpr }, in: { $let: { vars: { [vFi]: { $indexOfArray: [preds, false] } }, in: body } } },
  };
}

// A null-safe stringified object key for `$arrayToObject` / `$group`-`_id` entries.
// lodash coerces a group key to a string; MongoDB's `$toString` yields *null* for a
// missing/null value, and `$arrayToObject` then rejects it ("the value of 'k' must be
// of type string"). Coerce that null to the literal "null" (matching `String(null)`)
// so a missing/null grouping field lands under one "null" key instead of erroring on
// the server. NB `$toString` still errors on an object/array value — a separate,
// documented footgun. Shared by value-mode `keyBy`/`groupBy`/`countBy` and their
// stream-collapse forms (imported by src/stream-methods.ts) so both stay consistent.
export function stringKeyExpr(value: unknown): unknown {
  return { $ifNull: [{ $toString: value }, "null"] };
}

// group/count key set of an array: distinct STRINGIFIED iteratee values (lodash
// coerces group keys to strings). `$setUnion` needs a 2-arg form to be valid.
function distinctKeysExpr(arr: unknown, it: ResolvedIteratee): unknown {
  return { $setUnion: [{ $map: { input: arr, as: it.as, in: stringKeyExpr(it.value) } }, []] };
}

// The iteratee-keyed values of an array: `[it(x) for x in arr]` (NOT stringified —
// used for `$in` membership in the `*By` set ops).
function iterateeKeys(arr: unknown, it: ResolvedIteratee): unknown {
  return { $map: { input: arr, as: it.as, in: it.value } };
}

// Order-preserving keep-first dedupe of `input` BY iteratee key (`.uniqBy`, and the
// `.unionBy`/`.xorBy` tails). Tracks seen keys in a `{ seen, out }` accumulator, then
// projects `out`.
function uniqByReduce(input: unknown, it: ResolvedIteratee, ctx: GenerateCtx): unknown {
  // The iteratee is written against the user's own param name, so the $let binding it
  // must NOT enclose the $reduce accumulator reads — an iteratee like `value => value.id`
  // would otherwise shadow `$$value` and read `.seen`/`.out` off the element.
  // A $let var's VALUE is evaluated in the enclosing scope, so computing the key there
  // keeps the user's name scoped to the key expression alone. It also binds the key once
  // instead of re-emitting the iteratee for both the membership test and the accumulator.
  const [k, key] = internalVar(ctx, "key");
  // An identity iteratee (`x => x`) is just the element — no binding needed.
  const keyExpr = it.value === it.elem ? "$$this" : { $let: { vars: { [it.as]: "$$this" }, in: it.value } };
  return {
    $getField: {
      field: "out",
      input: {
        $reduce: {
          input,
          initialValue: { seen: [], out: [] },
          in: {
            $let: {
              vars: { [k]: keyExpr },
              in: {
                $cond: [
                  { $in: [key, "$$value.seen"] },
                  "$$value",
                  {
                    seen: { $concatArrays: ["$$value.seen", [key]] },
                    out: { $concatArrays: ["$$value.out", ["$$this"]] },
                  },
                ],
              },
            },
          },
        },
      },
    },
  };
}

// A lodash (value[, key]) iteratee over `$objectToArray` entries (used by
// `.mapValues`/`.mapKeys`/`.pickBy`/`.omitBy`). Binds the arrow's 1–2 params to
// the entry's value (`.v`) and key (`.k`) via `$let`. Returns the `$map`/`$filter`
// element var alongside the body so the caller emits the SAME name it was built
// against — the user's lambda body sits inside that element binding, so the name
// has to be gensym'd once, here, not re-derived at each call site.
function objIterateeVar(ctx: GenerateCtx): [string, string] {
  return internalVar(ctx, "kv");
}
function resolveObjIteratee(iteratee: Expr, method: string, ctx: GenerateCtx): { as: string; body: unknown } {
  const [as, kv] = objIterateeVar(ctx);
  if (
    iteratee.type === "Lambda" &&
    iteratee.block === undefined &&
    iteratee.params.length >= 1 &&
    iteratee.params.length <= 2
  ) {
    const vars: Record<string, unknown> = { [safeVarName(iteratee.params[0])]: `${kv}.v` };
    if (iteratee.params.length === 2) vars[safeVarName(iteratee.params[1])] = `${kv}.k`;
    return { as, body: { $let: { vars, in: _generate(iteratee.body as Expr, extendCtx(ctx, iteratee.params)) } } };
  }
  throw new CodegenError(`.${method}((value[, key]) => …) takes a one- or two-parameter arrow.`, iteratee.pos);
}

// The literal field names of a `.pick(["a", "b"])` / `.omit([...])` argument.
function pickKeys(arg: Expr, method: string): string[] {
  if (arg.type !== "ArrayLiteral") {
    throw new CodegenError(
      `.${method}([keys]) takes an array of field-name strings, e.g. '.${method}(["name", "age"])'.`,
      arg.pos,
    );
  }
  return arg.elements.map((el) => {
    if (el.type !== "StringLiteral" || el.value === "" || el.value.startsWith("$")) {
      throw new CodegenError(`.${method}([keys]) entries must be plain field-name strings (no leading '$').`, el.pos);
    }
    return el.value;
  });
}

// The date argument the `getUTC*` getters hand to MongoDB's date-part operators.
// The local getters pass the bare date (extraction uses the server process zone);
// the UTC variants pass `{ date, timezone: "UTC" }` so the result is UTC-anchored,
// mirroring JS's `getHours()` (local) vs `getUTCHours()` (UTC) split.
function utcDate(date: unknown): { date: unknown; timezone: string } {
  return { date, timezone: "UTC" };
}

// ── The trailing options argument of a date method ────────────────────────────
// Every date method takes the same optional last argument: a timezone string
// (the shorthand, which is what `.plus(2, "hour", "America/New_York")` uses), or
// an object literal whose keys are the operator's own remaining fields. One rule
// across the family, so a method that grows a field needs no new argument slot.
// See docs/specs/method-dispatch.md § Date methods.

/** Per-key literal gate, reusing the operator path's helpers so both spellings
 *  error identically. Every entry no-ops on a non-literal. */
const DATE_OPTION_CHECK: Record<string, (label: string, value: Expr) => void> = {
  binSize: (l, v) => checkArgType(l, "binSize", v, "number"),
  timezone: (l, v) => checkArgType(l, "timezone", v, "string"),
  startOfWeek: (l, v) => checkArgEnum(l, "startOfWeek", v, "weekday"),
};

/** Emit order: the operators' own field order, so output reads like the manual.
 *  No operator carries more than three of these, so one total order serves all. */
const DATE_OPTION_ORDER = ["binSize", "timezone", "startOfWeek"] as const;

type DateOptionKey = (typeof DATE_OPTION_ORDER)[number];

// ── .format(): MongoDB's own format specifiers ────────────────────────────────
// The characters `$dateToString` accepts after a `%`. Verified against mongod,
// which fails an unknown one at execution time ("Invalid format character
// '%Q'"), so a literal typo is a certain error and belongs at compile time.
const DATE_FORMAT_SPECIFIERS = "dGHjLmMSuUVwYzZ%";

// Moment / Luxon format tokens paired with the MQL specifier that does the same
// job, or `null` where MongoDB has none. Scanned longest-first and left to right,
// so `MMM` is consumed whole rather than leaving an `M` behind after `MM`.
const MOMENT_FORMAT_TOKENS: readonly (readonly [string, string | null])[] = [
  ["YYYY", "%Y"],
  ["MMMM", null], // month name
  ["dddd", null], // weekday name
  ["MMM", null],
  ["ddd", null],
  ["DDD", "%j"],
  ["SSS", "%L"],
  ["YY", null], // 2-digit year
  ["MM", "%m"],
  ["DD", "%d"],
  ["HH", "%H"],
  ["hh", null], // 12-hour clock
  ["ZZ", "%z"],
  ["mm", "%M"],
  ["ss", "%S"],
  ["Do", null], // ordinal day
];

// Does this look like a Moment/Luxon format rather than an MQL one? Such a
// string IS valid MQL — it formats as its own literal text — so nothing but the
// token spelling reveals the mistake, and the mistake is silent otherwise.
const MOMENT_FORMAT_RE = /YYYY|YY|MMMM|MMM|MM|DDD|DD|dddd|ddd|HH|hh|mm|ss|SSS|ZZ|Do/;

/**
 * Translate a Moment/Luxon format to MQL specifiers for the error message —
 * never for output. Offers the translation only when nothing is left
 * untranslated: what survives the scan is found by stripping the `%X` pairs and
 * looking for remaining letters, so a token MongoDB has no specifier for gets
 * named rather than silently dropped from a suggestion.
 */
function momentFormatHint(fmt: string): string {
  let out = "";
  let i = 0;
  outer: while (i < fmt.length) {
    for (const [token, spec] of MOMENT_FORMAT_TOKENS) {
      if (!fmt.startsWith(token, i)) continue;
      out += spec ?? token;
      i += token.length;
      continue outer;
    }
    out += fmt[i];
    i++;
  }
  const missing = out.replace(/%./g, "").match(/[A-Za-z]+/g);
  if (missing === null) return ` Did you mean '${out}'?`;
  return (
    ` MongoDB has no format specifier for ${[...new Set(missing)].map((t) => `'${t}'`).join(", ")}: it outputs no ` +
    `month name, weekday name, 12-hour clock or 2-digit year. Derive those from the numeric parts ` +
    `(e.g. ["Jan", …][$.t.getMonth() - 1]).`
  );
}

/** Reject a literal `.format` string MongoDB would refuse, or one written in
 *  Moment's token dialect (valid MQL, but it formats as its own text). */
function checkDateFormat(label: string, arg: Expr): void {
  const fmt = litString(arg);
  if (fmt === null) return;
  for (let i = 0; i < fmt.length; i++) {
    if (fmt[i] !== "%") continue;
    const spec = fmt[i + 1];
    if (spec === undefined || !DATE_FORMAT_SPECIFIERS.includes(spec)) {
      // The likeliest slip is the wrong case (`%y` for `%Y`), so try that first.
      const flip = spec === undefined ? undefined : flipCase(spec);
      const hint = flip !== undefined && DATE_FORMAT_SPECIFIERS.includes(flip) ? ` Did you mean '%${flip}'?` : "";
      throw new CodegenError(
        `'${label}' format has an invalid specifier '%${spec ?? ""}'.${hint} MongoDB accepts ` +
          `%Y %G %m %d %j %U %V %u %w %H %M %S %L %z %Z and %%.`,
        arg.pos,
      );
    }
    i++; // consume the specifier character
  }
  if (!fmt.includes("%") && MOMENT_FORMAT_RE.test(fmt)) {
    throw new CodegenError(
      `'${label}' takes MongoDB's date format specifiers, not Moment/Luxon tokens — ` +
        `'${fmt}' formats as that literal text, never a date.${momentFormatHint(fmt)}`,
      arg.pos,
    );
  }
}

function flipCase(ch: string): string {
  const up = ch.toUpperCase();
  return ch === up ? ch.toLowerCase() : up;
}

/**
 * Resolve a date method's trailing options argument into the operator fields it
 * contributes. `allowed` is the subset that method's operator accepts; an
 * unknown key is rejected with a suggestion rather than passed to mongod.
 *
 * A written-out object literal is the options form; **anything else** is the
 * timezone shorthand. That split is on what the argument *means*, not merely its
 * node type: MongoDB reads these fields by name from the operator document, so a
 * document of options only ever exists as source the compiler can read — a field
 * path or parameter in this slot can only be a runtime timezone string. Values
 * inside the literal stay free to be paths or parameters.
 */
function dateOptions(
  method: string,
  arg: Expr | undefined,
  allowed: readonly DateOptionKey[],
  ctx: GenerateCtx,
): Record<string, unknown> {
  if (arg === undefined) return {};
  const label = `.${method}`;
  if (arg.type !== "ObjectLiteral") {
    checkArgType(label, "timezone", arg, "string");
    return { timezone: _generate(arg, ctx) };
  }
  const info = objectInfo(arg);
  if (info === null || info.hasSpread) {
    throw new CodegenError(
      `${label}(…) options must be an object literal with plain keys (${allowed.join(", ")}) — ` +
        `a spread or computed key can't be read at compile time, and MongoDB needs these field names ` +
        `written out. Spell the keys and pass field paths or parameters as their values.`,
      arg.pos,
    );
  }
  for (const [key, value] of info.byKey) {
    if (allowed.includes(key as DateOptionKey)) continue;
    throw new CodegenError(
      `${label}(…) has no option '${key}'.${didYouMean(key, allowed, (s) => s)} ` +
        `Valid options: ${allowed.join(", ")}.`,
      value.pos,
    );
  }
  const out: Record<string, unknown> = {};
  for (const key of DATE_OPTION_ORDER) {
    const value = info.byKey.get(key);
    if (value === undefined) continue;
    DATE_OPTION_CHECK[key](label, value);
    out[key] = _generate(value, ctx);
  }
  return out;
}

function generateMethodCall(
  object: Expr,
  method: string,
  args: CallArg[],
  ctx: GenerateCtx,
  callPos: number,
  optional: boolean = false,
): unknown {
  // ── Stage link in value position ───────────────────────────────────────────
  // `.$match(...)` parses anywhere, but only the stream/collection chain
  // lowerers claim it. Reaching value-mode codegen means the receiver isn't a
  // stream — either an in-document array (`$.items.$match(...)`) or a chain
  // that already collapsed to a value (`….uniq().$limit(5)`). Caught here so
  // the user gets the real diagnosis instead of the generic unknown-method
  // fallthrough ("Did you mean '.match()'?") — and so a stage name can never
  // reach `generateUnknownOperator` and emit plausible-looking invalid MQL
  // (HR3). Purely a `$`-prefix test: codegen stays free of the stage registry.
  if (method.startsWith("$")) {
    throw new CodegenError(
      `'.${method}(...)' is a pipeline stage, but its receiver here is a value, not a stream. ` +
        `Stages chain on '$$' or '$$$.<coll>', and only while the chain is still a stream — ` +
        `a value-producing link ('.map("<field>")', '.uniq()', …) ends it, and '$.<field>' is an in-document array. ` +
        `For a value, use the JavaScript array method instead (e.g. '.filter(...)' rather than '.$match(...)').`,
      callPos,
    );
  }
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

  // Date methods require a date receiver — reject a literal non-date at compile
  // time, the same shape the operator form ($year / $dateAdd / …) gates. The
  // check is literal-gated (a field ref / new Date(…) / param no-ops), so only
  // a certain-wrong literal like "2020-01-01".getFullYear() throws.
  const receiverType = METHODS[method]?.receiver;
  if (receiverType !== undefined) checkArgType(`.${method}`, "", object, receiverType);

  // Chain type-check: reject a method chained on a receiver of a provably
  // incompatible type (`.every(...).map(...)`, `s.toUpperCase().map(...)`,
  // `a.countBy("t").take(3)`). Literal-gated — an unknown receiver never throws.
  // Guarded by `method in METHODS` so an unknown method falls through to the
  // "did you mean?" path below rather than this receiver-shape error.
  if (method in METHODS) {
    const recv = certainReceiverType(object);
    if (recv !== null) rejectIncompatibleChain(recv, method, object);
  }

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
      // JS .substr(start, count): a negative start counts from the end (as
      // .slice does), and a negative count yields "". Both were previously
      // passed straight to $substrCP, which rejects either outright.
      const start = normaliseSliceIndex(exprArgs[0], ctx, genObj);
      if (exprArgs.length === 1) {
        // A length past the end is clamped by the server, so the full length
        // stands in for "the rest of the string".
        return { $substrCP: [genObj, start, strLenOf(genObj)] };
      }
      return { $substrCP: [genObj, start, clampNonNegativeIndex(exprArgs[1], ctx)] };
    }
    case "substring": {
      const exprArgs = exprArgsOnly(args, "substring");
      checkArity("substring", { sig: "start[, end]", allowed: [0, 1, 2] }, exprArgs.length, callPos);
      if (exprArgs.length === 0) return genObj;
      // JS .substring(s, e) takes end-exclusive; MQL $substrCP takes a length.
      // JS clamps negative indices to 0 (and would also swap if start > end —
      // we model the clamping but not the swap; see docs/specs/method-dispatch.md).
      const start = clampNonNegativeIndex(exprArgs[0], ctx);
      if (exprArgs.length === 1) {
        // `strLen - start` is negative when start runs past the end.
        return { $substrCP: [genObj, start, clampNonNegative(foldedSubtract(strLenOf(genObj), start))] };
      }
      const end = clampNonNegativeIndex(exprArgs[1], ctx);
      return { $substrCP: [genObj, start, clampNonNegative(foldedSubtract(end, start))] };
    }
    case "charAt": {
      const exprArgs = exprArgsOnly(args, "charAt");
      checkArity("charAt", { sig: "index", exact: 1 }, exprArgs.length, callPos);
      // JS .charAt(i) returns "" for a negative index, so this is the one string
      // index that must NOT be floored — flooring to 0 would wrongly return the
      // first character. Fold a literal negative away; guard a runtime one.
      const lit = literalIndexValue(exprArgs[0]);
      if (lit !== null) return lit < 0 ? "" : { $substrCP: [genObj, lit, 1] };
      const index = _generate(exprArgs[0], ctx);
      return cond({ $lt: [index, 0] }, "", { $substrCP: [genObj, index, 1] });
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
      // Compares the last N codepoints of the input with the needle, where N is
      // the needle's length. The receiver is bound once so a chained one isn't
      // re-evaluated, and the start is floored: a receiver shorter than the
      // needle makes `strLen - N` negative, which $substrCP rejects outright
      // (it aborts the query rather than returning false).
      // The receiver is coerced once at the binding, so `$strLenCP` inside sees
      // a string even when the field is absent. A literal needle folds to its
      // code-point count, which also stops it being spliced in three times.
      const needleLen = strLenOf(needle);
      // `needle` is generated in the OUTER scope but lands inside the $let, so the
      // binding is gensym'd against the in-scope params.
      const [vStr, s] = internalVar(ctx, "str");
      return {
        $let: {
          vars: { [vStr]: coerceStringBinding(genObj) },
          in: {
            $eq: [{ $substrCP: [s, clampNonNegative(foldedSubtract({ $strLenCP: s }, needleLen)), needleLen] }, needle],
          },
        },
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
      const [vArr, arr] = internalVar(ctx, "arr");
      const [vRev, rev] = internalVar(ctx, "revIdx");
      return {
        $let: {
          vars: { [vArr]: genObj },
          in: {
            $let: {
              vars: { [vRev]: { $indexOfArray: [{ $reverseArray: arr }, needle] } },
              in: cond({ $eq: [rev, -1] }, -1, { $subtract: [{ $subtract: [{ $size: arr }, 1] }, rev] }),
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
      // If str length >= target, return str. Otherwise build the filler by
      // repeating `pad`, then concat it on the appropriate side.
      // `target`/`pad` are generated in the OUTER scope but land inside the $let, so
      // the binding must not capture a name they can reference (`.padStart(s.n)`
      // inside `.map(s => …)` used to re-resolve `s` against the receiver string).
      const [v, ref] = internalVar(ctx, "pad");
      const need = { $subtract: [target, { $strLenCP: ref }] };
      const repeated = {
        $reduce: { input: { $range: [0, need] }, initialValue: "", in: { $concat: ["$$value", pad] } },
      };
      // JS pads to exactly `targetLength` CHARACTERS, truncating a multi-character
      // pad mid-string ("gold".padStart(9, "US") === "USUSUgold"). Repeating it
      // `need` times over-fills, so trim back to `need`. A one-code-point literal
      // already lands exactly, and skipping its trim keeps the common
      // `.padStart(n, "0")` output unchanged. The length is floored because the
      // optimizer may fold this branch even when the $cond selects the other one.
      const filler = isSingleCodePointLiteral(pad) ? repeated : { $substrCP: [repeated, 0, clampNonNegative(need)] };
      const concatOrder = method === "padStart" ? [filler, ref] : [ref, filler];
      // The binding itself is coerced, not just the `$strLenCP` argument: an
      // uncoerced receiver would leave the trailing `$concat` returning null on
      // a missing field rather than the fully-padded string JS gives for "".
      return {
        $let: {
          vars: { [v]: coerceStringBinding(genObj) },
          in: cond({ $gte: [{ $strLenCP: ref }, target] }, ref, { $concat: concatOrder }),
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
      return reverseArrayOf(genObj);
    }
    case "toSorted": {
      if (args.length === 0) {
        return { $sortArray: { input: genObj, sortBy: 1 } };
      }
      const exprArgs = exprArgsOnly(args, "toSorted");
      checkArity(
        "toSorted",
        { sig: '"field" | ["a", "b"] | { field: dir } | keyFn', allowed: [0, 1] },
        exprArgs.length,
        callPos,
      );
      const sortBy = argToSortBy(exprArgs[0], "toSorted");
      return { $sortArray: { input: genObj, sortBy } };
    }
    case "sortBy": {
      // lodash `sortBy` — ascending sort by an iteratee. Field name / array of field
      // names / key function, like `.toSorted`. An OBJECT arg is rejected: in lodash a
      // `{ age: -1 }` here is a matches-shorthand (sort by a boolean), NOT a direction —
      // point the user at .orderBy / .toSorted so the surprise can't bite.
      const exprArgs = exprArgsOnly(args, "sortBy");
      checkArity("sortBy", { sig: '["field" | keyFn | [fields]]', allowed: [0, 1] }, exprArgs.length, callPos);
      if (exprArgs.length === 0) return { $sortArray: { input: genObj, sortBy: 1 } };
      if (exprArgs[0].type === "ObjectLiteral") {
        throw new CodegenError(
          `.sortBy({ … }) isn't supported — an object here is a lodash matches-shorthand, not a direction. Use '.orderBy({ field: -1 })' or '.toSorted({ field: -1 })' for directions.`,
          exprArgs[0].pos,
        );
      }
      return { $sortArray: { input: genObj, sortBy: argToSortBy(exprArgs[0], "sortBy") } };
    }
    case "orderBy": {
      // lodash `orderBy(keys, orders)` — parallel arrays of sort keys + directions.
      // Object form `.orderBy({ field: dir })` mirrors `.toSorted({ … })`: the
      // directions live inside the object, so there is no separate `orders` argument.
      const exprArgs = exprArgsOnly(args, "orderBy");
      checkArity("orderBy", { sig: "keys[, orders] | { field: dir }", allowed: [1, 2] }, exprArgs.length, callPos);
      if (exprArgs[0].type === "ObjectLiteral") {
        if (exprArgs.length > 1) {
          throw new CodegenError(
            `.orderBy({ … }) already carries a direction per field — drop the second 'orders' argument.`,
            exprArgs[1].pos,
          );
        }
        return { $sortArray: { input: genObj, sortBy: argToSortBy(exprArgs[0], "orderBy") } };
      }
      const names = orderByKeyNames(exprArgs[0], "orderBy");
      const dirs = exprArgs[1] !== undefined ? orderByDirs(exprArgs[1], "orderBy") : [];
      const spec: Record<string, 1 | -1> = {};
      names.forEach((nm, i) => {
        spec[nm] = dirs[i] ?? 1; // orders shorter than keys ⇒ remaining ascending (lodash)
      });
      return { $sortArray: { input: genObj, sortBy: spec } };
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
      const [vArr, arr] = internalVar(ctx, "arr");
      const [vStart, startRef] = internalVar(ctx, "start");
      const [vTail, tail] = internalVar(ctx, "tailStart");
      const tailStart = hasDeleteCount ? { $add: [startRef, _generate(deleteCountArg!, ctx)] } : startRef;
      return {
        $let: {
          vars: { [vArr]: genObj, [vStart]: start },
          in: {
            $let: {
              vars: { [vTail]: tailStart },
              in: {
                $concatArrays: [
                  { $slice: [arr, 0, startRef] },
                  items,
                  { $slice: [arr, tail, { $max: [0, { $subtract: [{ $size: arr }, tail] }] }] },
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
      const [vArr, arr] = internalVar(ctx, "arr");
      const [vIdx, idxRef] = internalVar(ctx, "idx");
      const [vVal, valRef] = internalVar(ctx, "val");
      return {
        $let: {
          vars: { [vArr]: genObj, [vIdx]: idx, [vVal]: value },
          in: {
            $concatArrays: [
              { $slice: [arr, 0, idxRef] },
              [valRef],
              {
                $slice: [
                  arr,
                  { $add: [idxRef, 1] },
                  { $max: [0, { $subtract: [{ $size: arr }, { $add: [idxRef, 1] }] }] },
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
      const vars: Record<string, unknown> = { [safeVarName(lambda.params[0])]: { $arrayElemAt: ["$$this", 1] } };
      if (lambda.params[1]) {
        vars[safeVarName(lambda.params[1])] = { $arrayElemAt: ["$$this", 0] };
      }
      const predicate = jsBoolIfNeeded(lambdaResult(lambda), genLambdaBody(lambda, bodyCtx));
      const test = method === "findIndex" ? { $and: [{ $eq: ["$$value", -1] }, predicate] } : predicate;
      return {
        $reduce: {
          input: { $zip: { inputs: [{ $range: [0, sizeOf(genObj)] }, genObj] } },
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
      rejectNestedArrayStringify(object, "join", callPos);
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
        rejectNestedArrayStringify(object, "toString", callPos);
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
      const [vPair, pair] = internalVar(ctx, "pair");
      return {
        $map: {
          input: { $filter: { input: iter.input, as: iter.asName, cond } },
          as: vPair,
          in: { $arrayElemAt: [pair, 1] },
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
        inSubPipeline: ctx.inSubPipeline,
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
        input = { $zip: { inputs: [{ $range: [0, sizeOf(genObj)] }, genObj] } };
      }
      if (method === "reduceRight") {
        input = reverseArrayOf(input);
      }
      return { $reduce: { input, initialValue: _generate(exprArgs[1], ctx), in: inExpr } };
    }

    // ── Date methods ────────────────────────────────────────────────────────
    case "getFullYear":
      return { $year: genObj };
    case "getMonth":
      // 1-based, matching MongoDB's $month (NOT JavaScript's 0-based getMonth) —
      // one month base across the whole language, the same one `.set({ month })`
      // and `$month` use. See docs/specs/method-dispatch.md § Date methods.
      return { $month: genObj };
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
    // UTC variants: same operators, anchored to UTC via `timezone: "UTC"`.
    case "getUTCFullYear":
      return { $year: utcDate(genObj) };
    case "getUTCMonth":
      // 1-based, like `.getMonth()` above.
      return { $month: utcDate(genObj) };
    case "getUTCDate":
      return { $dayOfMonth: utcDate(genObj) };
    case "getUTCDay":
      // 0-based: MongoDB $dayOfWeek is 1-based (Sunday=1)
      return { $subtract: [{ $dayOfWeek: utcDate(genObj) }, 1] };
    case "getUTCHours":
      return { $hour: utcDate(genObj) };
    case "getUTCMinutes":
      return { $minute: utcDate(genObj) };
    case "getUTCSeconds":
      return { $second: utcDate(genObj) };
    case "getUTCMilliseconds":
      return { $millisecond: utcDate(genObj) };
    case "getTime":
      // Match JS: ms since epoch (already UTC; no getUTCTime exists in JS)
      return { $toLong: genObj };
    case "toISOString":
      return { $dateToString: { date: genObj, format: "%Y-%m-%dT%H:%M:%S.%LZ" } };
    case "plus":
    case "minus": {
      // Date arithmetic: `d.plus(amount, unit[, timezone])` → $dateAdd,
      // `.minus(...)` → $dateSubtract. Temporal/Luxon method name with Moment's
      // (amount, unit) argument order — both map 1:1 to the operator's fields.
      const exprArgs = exprArgsOnly(args, method);
      checkArity(method, { sig: "amount, unit[, timezone]", allowed: [2, 3] }, exprArgs.length, callPos);
      // Gate the literal slots to the same shapes the $dateAdd/$dateSubtract
      // operator path rejects (unit enum, integer amount) so both spellings error
      // identically; each no-ops on a non-literal.
      checkEnum(`.${method}`, "unit", exprArgs[1], TIME_UNIT);
      checkArgType(`.${method}`, "amount", exprArgs[0], "int-or-long");
      return {
        [method === "plus" ? "$dateAdd" : "$dateSubtract"]: {
          startDate: genObj,
          unit: _generate(exprArgs[1], ctx),
          amount: _generate(exprArgs[0], ctx),
          ...dateOptions(method, exprArgs[2], ["timezone"], ctx),
        },
      };
    }
    case "format": {
      // `d.format(fmt)` → $dateToString. Moment's method name with MongoDB's own
      // format specifiers (`%Y-%m-%d`): translating Moment's token dialect would
      // dead-end on the tokens MQL has no equivalent for, so the specifiers stay
      // MQL's and a token-dialect string is rejected with the translation.
      const exprArgs = exprArgsOnly(args, method);
      checkArity(method, { sig: "format[, timezone]", allowed: [1, 2] }, exprArgs.length, callPos);
      checkArgType(".format", "format", exprArgs[0], "string");
      checkDateFormat(".format", exprArgs[0]);
      return {
        $dateToString: {
          date: genObj,
          format: _generate(exprArgs[0], ctx),
          ...dateOptions(method, exprArgs[1], ["timezone"], ctx),
        },
      };
    }
    case "startOf": {
      // `d.startOf(unit)` → $dateTrunc: the bucket key every time-series $group
      // wants. Moment / Luxon / date-fns all spell it this way.
      const exprArgs = exprArgsOnly(args, method);
      checkArity(method, { sig: "unit[, timezone]", allowed: [1, 2] }, exprArgs.length, callPos);
      checkEnum(".startOf", "unit", exprArgs[0], TIME_UNIT);
      return {
        $dateTrunc: {
          date: genObj,
          unit: _generate(exprArgs[0], ctx),
          ...dateOptions(method, exprArgs[1], ["binSize", "timezone", "startOfWeek"], ctx),
        },
      };
    }
    case "endOf": {
      // `d.endOf(unit)` — MongoDB has no ceiling operator, so this is the
      // truncate → add one unit → step back 1 ms composition, which lands on
      // Moment's 23:59:59.999-style inclusive end. `binSize` makes the step the
      // whole bin; only `timezone` carries to the $dateAdd ($dateAdd has no
      // binSize/startOfWeek field), and the final millisecond is absolute.
      const exprArgs = exprArgsOnly(args, method);
      checkArity(method, { sig: "unit[, timezone]", allowed: [1, 2] }, exprArgs.length, callPos);
      checkEnum(".endOf", "unit", exprArgs[0], TIME_UNIT);
      const opts = dateOptions(method, exprArgs[1], ["binSize", "timezone", "startOfWeek"], ctx);
      const step: Record<string, unknown> = {
        startDate: { $dateTrunc: { date: genObj, unit: _generate(exprArgs[0], ctx), ...opts } },
        unit: _generate(exprArgs[0], ctx),
        amount: opts.binSize ?? 1,
      };
      if (opts.timezone !== undefined) step.timezone = opts.timezone;
      return { $dateSubtract: { startDate: { $dateAdd: step }, unit: "millisecond", amount: 1 } };
    }
    case "diff": {
      // `end.diff(start, unit)` → $dateDiff. The receiver is the LATER date (the
      // operator's endDate), so the result is receiver − argument — the direction
      // Moment's `.diff`, Luxon's `.diff` and Temporal's `.since` all agree on.
      const exprArgs = exprArgsOnly(args, method);
      checkArity(method, { sig: "other, unit[, timezone]", allowed: [2, 3] }, exprArgs.length, callPos);
      checkArgType(".diff", "other", exprArgs[0], "date");
      checkEnum(".diff", "unit", exprArgs[1], TIME_UNIT);
      return {
        $dateDiff: {
          startDate: _generate(exprArgs[0], ctx),
          endDate: genObj,
          unit: _generate(exprArgs[1], ctx),
          ...dateOptions(method, exprArgs[2], ["timezone", "startOfWeek"], ctx),
        },
      };
    }

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
    case "unzipWith":
      // lodash's iteratee gets each group spread as separate args — its arity is the
      // receiver's (runtime) row count, which a fixed-parameter arrow can't express.
      throw new CodegenError(
        `.unzipWith(fn) isn't supported — its iteratee's argument count depends on the array's length at runtime. Write '.unzip().map(group => …)' instead, where 'group' is one unzipped column.`,
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

    // ── lodash array methods (Phase 1 value vocabulary) ──────────────────────
    case "sum":
    case "mean":
    case "max":
    case "min": {
      checkArity(method, { sig: "", none: true }, exprArgsOnly(args, method).length, callPos);
      const op = method === "sum" ? "$sum" : method === "mean" ? "$avg" : method === "max" ? "$max" : "$min";
      return { [op]: genObj };
    }
    case "sumBy":
    case "meanBy": {
      const exprArgs = exprArgsOnly(args, method);
      checkArity(method, { sig: "iteratee", exact: 1 }, exprArgs.length, callPos);
      const it = resolveIteratee(exprArgs[0], method, ctx);
      return { [method === "sumBy" ? "$sum" : "$avg"]: { $map: { input: genObj, as: it.as, in: it.value } } };
    }
    case "minBy":
    case "maxBy": {
      const exprArgs = exprArgsOnly(args, method);
      checkArity(method, { sig: "iteratee", exact: 1 }, exprArgs.length, callPos);
      const it = resolveIteratee(exprArgs[0], method, ctx);
      // Decorate each element with its key, sort ascending, take the last (max) or
      // first (min) element back out.
      const [vSorted, sorted] = internalVar(ctx, "sorted");
      return {
        $let: {
          vars: {
            [vSorted]: {
              $sortArray: {
                input: { $map: { input: genObj, as: it.as, in: { k: it.value, v: it.elem } } },
                sortBy: { k: 1 },
              },
            },
          },
          in: { $getField: { field: "v", input: { $arrayElemAt: [sorted, method === "maxBy" ? -1 : 0] } } },
        },
      };
    }
    case "sortedUniq": // MQL has no sorted-array optimisation; alias of the general form.
    case "uniq": {
      checkArity(method, { sig: "", none: true }, exprArgsOnly(args, method).length, callPos);
      // Order-preserving, keep-first dedupe ($setUnion would reorder).
      return {
        $reduce: {
          input: genObj,
          initialValue: [],
          in: { $cond: [{ $in: ["$$this", "$$value"] }, "$$value", { $concatArrays: ["$$value", ["$$this"]] }] },
        },
      };
    }
    case "sortedUniqBy": // alias of .uniqBy (no sorted-array optimisation in MQL)
    case "uniqBy": {
      const exprArgs = exprArgsOnly(args, method);
      checkArity(method, { sig: "iteratee", exact: 1 }, exprArgs.length, callPos);
      // Track seen keys, keep the first element for each; then drop the tracker.
      return uniqByReduce(genObj, resolveIteratee(exprArgs[0], method, ctx), ctx);
    }
    case "compact": {
      checkArity("compact", { sig: "", none: true }, exprArgsOnly(args, "compact").length, callPos);
      // MQL truthiness (drops false/null/0/missing; keeps ""/NaN — per project call).
      const [vItem, item] = internalVar(ctx, "item");
      return { $filter: { input: genObj, as: vItem, cond: item } };
    }
    case "flatten": {
      checkArity("flatten", { sig: "", none: true }, exprArgsOnly(args, "flatten").length, callPos);
      // One level; `$isArray` guard so non-array elements pass through.
      return {
        $reduce: {
          input: genObj,
          initialValue: [],
          in: { $concatArrays: ["$$value", { $cond: [{ $isArray: "$$this" }, "$$this", ["$$this"]] }] },
        },
      };
    }
    case "chunk": {
      const exprArgs = exprArgsOnly(args, "chunk");
      checkArity("chunk", { sig: "size", exact: 1 }, exprArgs.length, callPos);
      const size = exprArgs[0];
      if (size.type !== "NumberLiteral" || !Number.isInteger(size.value) || size.value < 1) {
        throw new CodegenError(
          `.chunk(size) requires a positive integer literal (got ${size.type === "NumberLiteral" ? size.value : "a non-literal"}).`,
          size.pos,
        );
      }
      const [vI, i] = internalVar(ctx, "i");
      return {
        $map: { input: { $range: [0, sizeOf(genObj), size.value] }, as: vI, in: { $slice: [genObj, i, size.value] } },
      };
    }
    // ── lodash positional / slicing (array → element or sub-array) ──────────────
    case "take":
    case "drop":
    case "takeRight":
    case "dropRight": {
      const exprArgs = exprArgsOnly(args, method);
      checkArity(method, { sig: "[n=1]", allowed: [0, 1] }, exprArgs.length, callPos);
      const nArg = exprArgs[0];
      if (nArg !== undefined && isNegativeLiteral(nArg)) {
        const mirror = method === "take" ? ".takeRight(n)" : method === "takeRight" ? ".take(n)" : null;
        throw new CodegenError(
          `.${method}(n) needs a non-negative count${mirror ? ` — use ${mirror} to count from the other end` : ""}.`,
          nArg.pos,
        );
      }
      const n = nArg !== undefined ? _generate(nArg, ctx) : 1;
      if (method === "take") return { $slice: [genObj, n] };
      if (method === "takeRight") return { $slice: [genObj, negate(n)] };
      // dropRight keeps the first max(0, size-n) — a 2-arg `$slice` (first-count), so a
      // count of 0 (n ≥ size) is `$slice: [arr, 0]` → `[]`, NOT the 3-arg `$slice: [arr,
      // 0, 0]` mongod rejects ("Third argument to $slice must be positive").
      const [vArr, arr] = internalVar(ctx, "arr");
      if (method === "dropRight") {
        const keep = { $max: [0, { $subtract: [{ $size: arr }, n] }] };
        return { $let: { vars: { [vArr]: genObj }, in: { $slice: [arr, keep] } } };
      }
      // drop: from position n. The count (3rd arg) is max(1, size) so an EMPTY array
      // is `$slice: [[], n, 1]` → `[]` rather than a rejected 3-arg count of 0.
      return { $let: { vars: { [vArr]: genObj }, in: { $slice: [arr, n, { $max: [1, { $size: arr }] }] } } };
    }
    case "tail":
    case "initial": {
      checkArity(method, { sig: "", none: true }, exprArgsOnly(args, method).length, callPos);
      // initial = dropRight(1): keep the first max(0, size-1) via 2-arg `$slice`.
      const [vArr, arr] = internalVar(ctx, "arr");
      if (method === "initial") {
        const keep = { $max: [0, { $subtract: [{ $size: arr }, 1] }] };
        return { $let: { vars: { [vArr]: genObj }, in: { $slice: [arr, keep] } } };
      }
      // tail = drop(1): count max(1, size) guards the empty-array → count-0 rejection.
      return { $let: { vars: { [vArr]: genObj }, in: { $slice: [arr, 1, { $max: [1, { $size: arr }] }] } } };
    }
    case "head":
    case "first": {
      checkArity(method, { sig: "", none: true }, exprArgsOnly(args, method).length, callPos);
      return firstOf(genObj);
    }
    case "last": {
      checkArity("last", { sig: "", none: true }, exprArgsOnly(args, "last").length, callPos);
      return lastOf(genObj);
    }
    case "nth": {
      const exprArgs = exprArgsOnly(args, "nth");
      checkArity("nth", { sig: "[n=0]", allowed: [0, 1] }, exprArgs.length, callPos);
      // $arrayElemAt supports negative indices, matching lodash's nth.
      return { $arrayElemAt: [genObj, exprArgs[0] !== undefined ? _generate(exprArgs[0], ctx) : 0] };
    }
    case "size": {
      checkArity("size", { sig: "", none: true }, exprArgsOnly(args, "size").length, callPos);
      // lodash size counts array elements OR object keys. Arrays → $size; objects →
      // key count via $objectToArray. Strings should use `.length` (see docs).
      if (isArrayProducing(object)) return sizeOf(genObj);
      if (isObjectProducing(object)) return sizeOf({ $objectToArray: genObj });
      return cond({ $isArray: genObj }, sizeOf(genObj), sizeOf({ $objectToArray: genObj }));
    }
    case "takeWhile":
    case "dropWhile":
    case "takeRightWhile":
    case "dropRightWhile": {
      const exprArgs = exprArgsOnly(args, method);
      checkArity(method, { sig: "predicate", exact: 1 }, exprArgs.length, callPos);
      const pred = resolvePredicate(exprArgs[0], method, ctx);
      const drop = method === "dropWhile" || method === "dropRightWhile";
      const fromRight = method === "takeRightWhile" || method === "dropRightWhile";
      // From the right = do the left-side scan on the reversed array, then reverse back.
      if (!fromRight) return takeDropWhile(genObj, pred, drop, ctx);
      return reverseArrayOf(takeDropWhile(reverseArrayOf(genObj), pred, drop, ctx));
    }
    case "sample": {
      // A random element: $arrayElemAt at floor($rand * size). Non-deterministic at
      // runtime (like the stream `.sample` / `$sample`), deterministic to compile.
      checkArity("sample", { sig: "", none: true }, exprArgsOnly(args, "sample").length, callPos);
      const [vArr, arr] = internalVar(ctx, "arr");
      return {
        $let: {
          vars: { [vArr]: genObj },
          in: { $arrayElemAt: [arr, { $floor: { $multiply: [{ $rand: {} }, { $size: arr }] } }] },
        },
      };
    }
    case "sampleSize": {
      // n random elements without replacement: decorate each with a random key, sort
      // by it, take the first n, undecorate. n past the length yields the whole shuffle.
      const exprArgs = exprArgsOnly(args, "sampleSize");
      checkArity("sampleSize", { sig: "[n=1]", allowed: [0, 1] }, exprArgs.length, callPos);
      if (exprArgs[0] !== undefined && isNegativeLiteral(exprArgs[0])) {
        throw new CodegenError(`.sampleSize(n) needs a non-negative count.`, exprArgs[0].pos);
      }
      const n = exprArgs[0] !== undefined ? _generate(exprArgs[0], ctx) : 1;
      const [vShuf, shuf] = internalVar(ctx, "shuffled");
      const [vItem, item] = internalVar(ctx, "item");
      return {
        $let: {
          vars: {
            [vShuf]: {
              $sortArray: {
                input: { $map: { input: genObj, as: vItem, in: { k: { $rand: {} }, v: item } } },
                sortBy: { k: 1 },
              },
            },
          },
          in: { $map: { input: { $slice: [shuf, n] }, as: vItem, in: `${item}.v` } },
        },
      };
    }
    case "difference":
    case "intersection": {
      // On a plain array receiver (Set receivers were intercepted earlier). Order-
      // preserving vs `$setDifference`/`$setIntersection`.
      const exprArgs = exprArgsOnly(args, method);
      checkArity(method, { sig: "other", exact: 1 }, exprArgs.length, callPos);
      const other = _generate(exprArgs[0], ctx);
      const [vItem, item] = internalVar(ctx, "item");
      const inOther = { $in: [item, other] };
      return { $filter: { input: genObj, as: vItem, cond: method === "intersection" ? inOther : { $not: [inOther] } } };
    }
    case "union": {
      const exprArgs = exprArgsOnly(args, "union");
      checkArity("union", { sig: "other", exact: 1 }, exprArgs.length, callPos);
      // Order-preserving unique of the concatenation.
      return {
        $reduce: {
          input: { $concatArrays: [genObj, _generate(exprArgs[0], ctx)] },
          initialValue: [],
          in: { $cond: [{ $in: ["$$this", "$$value"] }, "$$value", { $concatArrays: ["$$value", ["$$this"]] }] },
        },
      };
    }
    case "without": {
      // lodash `without(arr, ...values)` — exclude the given values (variadic).
      const exprArgs = exprArgsOnly(args, "without");
      checkArity("without", { sig: "...values", atLeast: 1 }, exprArgs.length, callPos);
      const values = exprArgs.map((a) => _generate(a, ctx));
      const [vItem, item] = internalVar(ctx, "item");
      return { $filter: { input: genObj, as: vItem, cond: { $not: [{ $in: [item, values] }] } } };
    }
    case "xor": {
      // Symmetric difference of two arrays (chain `.xor(b).xor(c)` for more), order-
      // preserving + deduped: uniq( A∖B ++ B∖A ) by value.
      const exprArgs = exprArgsOnly(args, "xor");
      checkArity("xor", { sig: "other", exact: 1 }, exprArgs.length, callPos);
      const other = _generate(exprArgs[0], ctx);
      const [vA, a] = internalVar(ctx, "a");
      const [vB, b] = internalVar(ctx, "b");
      const [vX, x] = internalVar(ctx, "x");
      const notInB = { $filter: { input: a, as: vX, cond: { $not: [{ $in: [x, b] }] } } };
      const notInA = { $filter: { input: b, as: vX, cond: { $not: [{ $in: [x, a] }] } } };
      return {
        $let: {
          vars: { [vA]: genObj, [vB]: other },
          in: {
            $reduce: {
              input: { $concatArrays: [notInB, notInA] },
              initialValue: [],
              in: { $cond: [{ $in: ["$$this", "$$value"] }, "$$value", { $concatArrays: ["$$value", ["$$this"]] }] },
            },
          },
        },
      };
    }
    case "differenceBy":
    case "intersectionBy": {
      // Like difference/intersection but compared by iteratee key.
      const exprArgs = exprArgsOnly(args, method);
      checkArity(method, { sig: "other, iteratee", exact: 2 }, exprArgs.length, callPos);
      const it = resolveIteratee(exprArgs[1], method, ctx);
      const otherKeys = iterateeKeys(_generate(exprArgs[0], ctx), it);
      // The internal binding is read from inside a `$filter` bound to the USER's
      // iteratee param, so it must be gensym'd against that name too.
      const [vKeys, keys] = internalVar(extendCtx(ctx, [it.as]), "otherKeys");
      const inOther = { $in: [it.value, keys] };
      return {
        $let: {
          vars: { [vKeys]: otherKeys },
          in: {
            $filter: { input: genObj, as: it.as, cond: method === "intersectionBy" ? inOther : { $not: [inOther] } },
          },
        },
      };
    }
    case "unionBy": {
      // Concatenate then keep-first dedupe BY iteratee key.
      const exprArgs = exprArgsOnly(args, "unionBy");
      checkArity("unionBy", { sig: "other, iteratee", exact: 2 }, exprArgs.length, callPos);
      const it = resolveIteratee(exprArgs[1], "unionBy", ctx);
      return uniqByReduce({ $concatArrays: [genObj, _generate(exprArgs[0], ctx)] }, it, ctx);
    }
    case "xorBy": {
      // Symmetric difference BY iteratee key: uniqBy( A∖B ++ B∖A ) on the keys.
      const exprArgs = exprArgsOnly(args, "xorBy");
      checkArity("xorBy", { sig: "other, iteratee", exact: 2 }, exprArgs.length, callPos);
      const it = resolveIteratee(exprArgs[1], "xorBy", ctx);
      const other = _generate(exprArgs[0], ctx);
      // The key-set bindings are read from inside `$filter`s bound to the USER's
      // iteratee param, so gensym them against that name too.
      const itCtx = extendCtx(ctx, [it.as]);
      const [vA, a] = internalVar(itCtx, "a");
      const [vB, b] = internalVar(itCtx, "b");
      const [vAKeys, aKeys] = internalVar(itCtx, "aKeys");
      const [vBKeys, bKeys] = internalVar(itCtx, "bKeys");
      const aNotInB = { $filter: { input: a, as: it.as, cond: { $not: [{ $in: [it.value, bKeys] }] } } };
      const bNotInA = { $filter: { input: b, as: it.as, cond: { $not: [{ $in: [it.value, aKeys] }] } } };
      // Outer $let binds the two arrays once; inner derives their key sets from the
      // bound copies (MongoDB $let vars can't reference their siblings).
      return {
        $let: {
          vars: { [vA]: genObj, [vB]: other },
          in: {
            $let: {
              vars: { [vAKeys]: iterateeKeys(a, it), [vBKeys]: iterateeKeys(b, it) },
              in: uniqByReduce({ $concatArrays: [aNotInB, bNotInA] }, it, ctx),
            },
          },
        },
      };
    }
    case "zipObject": {
      const exprArgs = exprArgsOnly(args, "zipObject");
      checkArity("zipObject", { sig: "values", exact: 1 }, exprArgs.length, callPos);
      const values = _generate(exprArgs[0], ctx);
      // Pair keys with values by index (keys.length); stringify keys for $arrayToObject.
      const [vI, i] = internalVar(ctx, "i");
      return {
        $arrayToObject: {
          $map: {
            input: { $range: [0, sizeOf(genObj)] },
            as: vI,
            in: { k: { $toString: { $arrayElemAt: [genObj, i] } }, v: { $arrayElemAt: [values, i] } },
          },
        },
      };
    }
    case "zip":
    case "zipWith": {
      // `.zip(b, c)` → [[a0,b0,c0], …]; `.zipWith(b, c, fn)` → [fn(a0,b0,c0), …].
      // Groups run to the LONGEST array; short arrays pad with null (MongoDB fills an
      // out-of-range $arrayElemAt inside a literal tuple with null — matching lodash).
      const exprArgs = exprArgsOnly(args, method);
      const isWith = method === "zipWith";
      checkArity(
        method,
        isWith ? { sig: "...arrays, iteratee", atLeast: 2 } : { sig: "...arrays", atLeast: 1 },
        exprArgs.length,
        callPos,
      );
      const fn = isWith ? exprArgs[exprArgs.length - 1] : null;
      const otherArrays = isWith ? exprArgs.slice(0, -1) : exprArgs;
      const arrays = [genObj, ...otherArrays.map((a) => _generate(a, ctx))];
      const [vI, i] = internalVar(ctx, "i");
      const vars: Record<string, unknown> = {};
      const refs: string[] = [];
      arrays.forEach((arr, k) => {
        const [v, ref] = internalVar(ctx, `zip${k}`);
        vars[v] = arr;
        refs.push(ref);
      });
      const elems = refs.map((r) => ({ $arrayElemAt: [r, i] }));
      let inExpr: unknown = elems; // the tuple
      if (isWith) {
        if (fn!.type !== "Lambda" || fn!.block !== undefined || fn!.params.length !== arrays.length) {
          throw new CodegenError(
            `.zipWith(...arrays, iteratee) needs a ${arrays.length}-parameter arrow (one per zipped array).`,
            fn!.pos,
          );
        }
        const fnVars: Record<string, unknown> = {};
        fn!.params.forEach((p, k) => {
          fnVars[safeVarName(p)] = elems[k];
        });
        inExpr = { $let: { vars: fnVars, in: _generate(fn!.body as Expr, extendCtx(ctx, fn!.params)) } };
      }
      return {
        $let: {
          vars,
          in: { $map: { input: { $range: [0, { $max: refs.map((r) => sizeOf(r)) }] }, as: vI, in: inExpr } },
        },
      };
    }
    case "unzip": {
      // Inverse of zip: transpose an array of equal-length tuples. Column count =
      // size of the first tuple ($ifNull → [] guards an empty receiver).
      checkArity("unzip", { sig: "", none: true }, exprArgsOnly(args, "unzip").length, callPos);
      const [vT, t] = internalVar(ctx, "t");
      const [vJ, j] = internalVar(ctx, "j");
      const [vRow, row] = internalVar(ctx, "row");
      return {
        $let: {
          vars: { [vT]: genObj },
          in: {
            $map: {
              input: { $range: [0, { $size: { $ifNull: [{ $arrayElemAt: [t, 0] }, []] } }] },
              as: vJ,
              in: { $map: { input: t, as: vRow, in: { $arrayElemAt: [row, j] } } },
            },
          },
        },
      };
    }
    case "keyBy": {
      const exprArgs = exprArgsOnly(args, "keyBy");
      // Iteratee is optional — omitted means identity (lodash `_.keyBy([...])`).
      checkArity("keyBy", { sig: "[iteratee]", allowed: [0, 1] }, exprArgs.length, callPos);
      const it = resolveIteratee(exprArgs[0], "keyBy", ctx);
      // { <key>: <last element with that key> } — $arrayToObject keeps the last.
      return { $arrayToObject: { $map: { input: genObj, as: it.as, in: { k: stringKeyExpr(it.value), v: it.elem } } } };
    }
    case "groupBy":
    case "countBy": {
      const exprArgs = exprArgsOnly(args, method);
      // Iteratee is optional — omitted means identity (lodash `_.countBy([1,2,2])`
      // → `{ "1": 1, "2": 2 }`, `_.groupBy([1,2,2])` → `{ "1": [1], "2": [2,2] }`).
      checkArity(method, { sig: "[iteratee]", allowed: [0, 1] }, exprArgs.length, callPos);
      const it = resolveIteratee(exprArgs[0], method, ctx);
      // Read from inside a `$filter` bound to the USER's iteratee param — gensym
      // against that name too.
      const [vKey, key] = internalVar(extendCtx(ctx, [it.as]), "key");
      const filtered = { $filter: { input: genObj, as: it.as, cond: { $eq: [stringKeyExpr(it.value), key] } } };
      return {
        $arrayToObject: {
          $map: {
            input: distinctKeysExpr(genObj, it),
            as: vKey,
            in: { k: key, v: method === "countBy" ? { $size: filtered } : filtered },
          },
        },
      };
    }
    case "partition":
    case "reject": {
      const exprArgs = exprArgsOnly(args, method);
      checkArity(method, { sig: "predicate", exact: 1 }, exprArgs.length, callPos);
      const p = resolvePredicate(exprArgs[0], method, ctx);
      const yes = { $filter: { input: genObj, as: p.as, cond: p.cond } };
      const no = { $filter: { input: genObj, as: p.as, cond: { $not: [p.cond] } } };
      return method === "reject" ? no : [yes, no];
    }

    // ── lodash object methods (Phase 1 value vocabulary) ─────────────────────
    case "mapValues":
    case "mapKeys": {
      const exprArgs = exprArgsOnly(args, method);
      checkArity(method, { sig: "iteratee", exact: 1 }, exprArgs.length, callPos);
      const { as, body: mapped } = resolveObjIteratee(exprArgs[0], method, ctx);
      const entry =
        method === "mapValues" ? { k: `$$${as}.k`, v: mapped } : { k: { $toString: mapped }, v: `$$${as}.v` };
      return { $arrayToObject: { $map: { input: { $objectToArray: genObj }, as, in: entry } } };
    }
    case "pick": {
      const exprArgs = exprArgsOnly(args, "pick");
      checkArity("pick", { sig: "[keys]", exact: 1 }, exprArgs.length, callPos);
      const keys = pickKeys(exprArgs[0], "pick");
      // Field-select into a fresh object; a missing key drops out (lodash parity).
      const [vObj, obj] = internalVar(ctx, "obj");
      const out: Record<string, unknown> = {};
      for (const k of keys) out[k] = { $getField: { field: k, input: obj } };
      return { $let: { vars: { [vObj]: genObj }, in: out } };
    }
    case "omit": {
      const exprArgs = exprArgsOnly(args, "omit");
      checkArity("omit", { sig: "[keys]", exact: 1 }, exprArgs.length, callPos);
      const keys = pickKeys(exprArgs[0], "omit");
      const [as, kv] = objIterateeVar(ctx);
      return {
        $arrayToObject: {
          $filter: { input: { $objectToArray: genObj }, as, cond: { $not: [{ $in: [`${kv}.k`, keys] }] } },
        },
      };
    }
    case "pickBy":
    case "omitBy": {
      const exprArgs = exprArgsOnly(args, method);
      checkArity(method, { sig: "predicate", exact: 1 }, exprArgs.length, callPos);
      const { as, body: cond } = resolveObjIteratee(exprArgs[0], method, ctx);
      return {
        $arrayToObject: {
          $filter: { input: { $objectToArray: genObj }, as, cond: method === "pickBy" ? cond : { $not: [cond] } },
        },
      };
    }
    case "invert": {
      checkArity("invert", { sig: "", none: true }, exprArgsOnly(args, "invert").length, callPos);
      // Swap keys/values (new keys stringified; last wins — lodash parity).
      const [as, kv] = objIterateeVar(ctx);
      return {
        $arrayToObject: {
          $map: { input: { $objectToArray: genObj }, as, in: { k: { $toString: `${kv}.v` }, v: `${kv}.k` } },
        },
      };
    }
    case "toPairs": {
      checkArity("toPairs", { sig: "", none: true }, exprArgsOnly(args, "toPairs").length, callPos);
      const [as, kv] = objIterateeVar(ctx);
      return { $map: { input: { $objectToArray: genObj }, as, in: [`${kv}.k`, `${kv}.v`] } };
    }
    case "fromPairs": {
      checkArity("fromPairs", { sig: "", none: true }, exprArgsOnly(args, "fromPairs").length, callPos);
      // Receiver is a [[k, v], …] array; stringify keys for $arrayToObject.
      const [vP, p] = internalVar(ctx, "p");
      return {
        $arrayToObject: {
          $map: { input: genObj, as: vP, in: [{ $toString: { $arrayElemAt: [p, 0] } }, { $arrayElemAt: [p, 1] }] },
        },
      };
    }

    // ── lodash string methods (Phase 1 value vocabulary; ASCII-only) ─────────
    case "capitalize":
    case "upperFirst":
    case "lowerFirst":
    case "words":
    case "kebabCase":
    case "snakeCase":
    case "startCase":
    case "camelCase":
    case "escape": {
      checkArity(method, { sig: "", none: true }, exprArgsOnly(args, method).length, callPos);
      switch (method) {
        case "capitalize":
          return capitalizeExpr(genObj);
        case "upperFirst":
          return firstCharExpr(genObj, "$toUpper");
        case "lowerFirst":
          return firstCharExpr(genObj, "$toLower");
        case "words":
          return wordsExpr(genObj);
        case "kebabCase":
          return { $toLower: joinWords(wordsExpr(genObj), "-") };
        case "snakeCase":
          return { $toLower: joinWords(wordsExpr(genObj), "_") };
        case "startCase":
          return joinWords(wordsExpr(genObj), " ", capitalizeExpr);
        case "camelCase": {
          // Pascal-case (capitalize each word, no separator) then lower the first char.
          const [vPascal, pascal] = internalVar(ctx, "pascal");
          return {
            $let: {
              vars: { [vPascal]: joinWords(wordsExpr(genObj), "", capitalizeExpr) },
              in: firstCharExpr(pascal, "$toLower"),
            },
          };
        }
        default:
          return escapeHtmlExpr(genObj);
      }
    }
    case "truncate": {
      const exprArgs = exprArgsOnly(args, "truncate");
      checkArity("truncate", { sig: "[{ length, omission }]", allowed: [0, 1] }, exprArgs.length, callPos);
      let length = 30;
      let omission = "...";
      if (exprArgs.length === 1) {
        const opts = exprArgs[0];
        if (opts.type !== "ObjectLiteral") {
          throw new CodegenError(
            `.truncate(...) takes an options object, e.g. '.truncate({ length: 24, omission: "…" })'.`,
            opts.pos,
          );
        }
        for (const entry of opts.entries) {
          if (entry.type !== "KeyValueEntry" || entry.key.kind !== "static") {
            throw new CodegenError(`.truncate({ … }) options must be static keys ('length', 'omission').`, entry.pos);
          }
          if (entry.key.name === "length" && entry.value.type === "NumberLiteral") length = entry.value.value;
          else if (entry.key.name === "omission" && entry.value.type === "StringLiteral") omission = entry.value.value;
          else if (entry.key.name === "separator") {
            throw new CodegenError(
              `.truncate({ separator }) (word-boundary truncation) isn't supported — MQL has no back-search. Use 'length' + 'omission'.`,
              entry.value.pos,
            );
          } else {
            throw new CodegenError(
              `.truncate({ ${entry.key.name} }) — only literal 'length' and 'omission' are supported.`,
              entry.value.pos,
            );
          }
        }
      }
      const keep = Math.max(0, length - omission.length);
      // Bound once (and coerced) so the receiver isn't evaluated three times and
      // an absent field truncates to "" like lodash, rather than passing null
      // through the else branch.
      const [vStr, s] = internalVar(ctx, "str");
      return {
        $let: {
          vars: { [vStr]: coerceStringBinding(genObj) },
          in: { $cond: [{ $gt: [{ $strLenCP: s }, length] }, { $concat: [{ $substrCP: [s, 0, keep] }, omission] }, s] },
        },
      };
    }

    // ── lodash number methods (Phase 1 value vocabulary) ─────────────────────
    case "clamp": {
      const exprArgs = exprArgsOnly(args, "clamp");
      checkArity("clamp", { sig: "lower, upper", exact: 2 }, exprArgs.length, callPos);
      return { $min: [{ $max: [genObj, _generate(exprArgs[0], ctx)] }, _generate(exprArgs[1], ctx)] };
    }
    case "inRange": {
      const exprArgs = exprArgsOnly(args, "inRange");
      checkArity("inRange", { sig: "[start, ]end", allowed: [1, 2] }, exprArgs.length, callPos);
      // lodash: `.inRange(end)` is [0, end); `.inRange(start, end)` is [start, end);
      // the bounds swap when start > end (so negative ranges work) — `$min`/`$max`.
      const lo = exprArgs.length === 2 ? _generate(exprArgs[0], ctx) : 0;
      const hi = _generate(exprArgs[exprArgs.length === 2 ? 1 : 0], ctx);
      return { $and: [{ $gte: [genObj, { $min: [lo, hi] }] }, { $lt: [genObj, { $max: [lo, hi] }] }] };
    }
    case "round": {
      const exprArgs = exprArgsOnly(args, "round");
      checkArity("round", { sig: "[precision]", allowed: [0, 1] }, exprArgs.length, callPos);
      // → MongoDB `$round` (half-to-even / banker's rounding, per project decision).
      const place = exprArgs.length === 1 ? _generate(exprArgs[0], ctx) : 0;
      return { $round: [genObj, place] };
    }
    case "ceil":
    case "floor": {
      const exprArgs = exprArgsOnly(args, method);
      checkArity(method, { sig: "[precision]", allowed: [0, 1] }, exprArgs.length, callPos);
      const op = method === "ceil" ? "$ceil" : "$floor";
      if (exprArgs.length === 0) return { [op]: genObj };
      // precision p: divide(op(multiply(n, 10^p)), 10^p).
      const factor = { $pow: [10, _generate(exprArgs[0], ctx)] };
      return { $divide: [{ [op]: { $multiply: [genObj, factor] } }, factor] };
    }

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
  // With no element param the binding is unreferenced, but it still occupies a name
  // in the emitted MQL — gensym so a nested `.map(() => …)` can't shadow an outer one.
  const asName = params[0] ? safeVarName(params[0]) : gensymInScope(ctx, "v");

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

  const [vPair, pair] = internalVar(bodyCtx, "pair");
  return {
    input: { $zip: { inputs: [{ $range: [0, sizeOf(genObj)] }, genObj] } },
    asName: vPair,
    bodyCtx,
    paired: true,
    wrap: (body) => ({
      $let: {
        vars: {
          [safeVarName(params[0])]: { $arrayElemAt: [pair, 1] },
          [safeVarName(params[1])]: { $arrayElemAt: [pair, 0] },
          ...(arrayParam ? { [safeVarName(arrayParam)]: genObj } : {}),
        },
        in: body,
      },
    }),
  };
}

// 1 (ascending) or -1 (descending) from a `1` / `-1` number or an "asc" / "desc"
// string. `-1` parses as a UnaryExpr, so that shape is handled too.
function sortDirLiteral(e: Expr): 1 | -1 | null {
  if (e.type === "NumberLiteral") return e.value === 1 ? 1 : e.value === -1 ? -1 : null;
  if (e.type === "UnaryExpr" && e.op === "-" && e.operand.type === "NumberLiteral" && e.operand.value === 1) return -1;
  if (e.type === "StringLiteral") return e.value === "asc" ? 1 : e.value === "desc" ? -1 : null;
  return null;
}

/**
 * Translate a `.toSorted(...)` / `.sort(...)` argument into the `sortBy` value
 * `$sortArray` expects. Accepts the same flexible forms as the stream sort:
 * a field name ("age"), an array of field names (all ascending), a
 * `{ field: 1 | -1 | "asc" | "desc" }` spec, or the key-function form
 * `x => x.path` / `x => -x.path`.
 */
function argToSortBy(arg: Expr, method: string): Record<string, 1 | -1> {
  if (arg.type === "StringLiteral") {
    if (arg.value === "" || arg.value.startsWith("$")) {
      throw new CodegenError(
        `.${method}("field") requires a plain field name (no leading '$'), got ${JSON.stringify(arg.value)}.`,
        arg.pos,
      );
    }
    return { [arg.value]: 1 };
  }
  if (arg.type === "ArrayLiteral") {
    if (arg.elements.length === 0)
      throw new CodegenError(`.${method}([fields]) needs at least one field name.`, arg.pos);
    const spec: Record<string, 1 | -1> = {};
    for (const el of arg.elements) {
      if (el.type !== "StringLiteral")
        throw new CodegenError(`.${method}([fields]) entries must be field-name strings.`, el.pos);
      spec[el.value] = 1;
    }
    return spec;
  }
  if (arg.type === "ObjectLiteral") {
    if (arg.entries.length === 0) throw new CodegenError(`.${method}({ … }) needs at least one field.`, arg.pos);
    const spec: Record<string, 1 | -1> = {};
    for (const entry of arg.entries) {
      if (entry.type === "SpreadElement")
        throw new CodegenError(`.${method}({ … }) does not accept spread entries.`, entry.pos);
      if (entry.key.kind !== "static")
        throw new CodegenError(`.${method}({ … }) keys must be plain field names.`, entry.pos);
      const dir = sortDirLiteral(entry.value);
      if (dir === null) {
        throw new CodegenError(
          `.${method}({ ${entry.key.name}: … }) direction must be 1 / -1 / "asc" / "desc".`,
          entry.value.pos,
        );
      }
      spec[entry.key.name] = dir;
    }
    return spec;
  }
  return lambdaToSortBy(arg, method);
}

/**
 * The sort-key field names for `.orderBy(keys, orders)`: a single field name, a
 * key function (`x => x.path`), or an array of either. Directions come from the
 * separate `orders` arg (see `orderByDirs`), so a bare `x => x.path` yields just
 * its path.
 */
function orderByKeyNames(arg: Expr, method: string): string[] {
  const one = (e: ArrayElement): string => {
    if (e.type === "StringLiteral") {
      if (e.value === "" || e.value.startsWith("$"))
        throw new CodegenError(`.${method}("field") requires a plain field name (no leading '$').`, e.pos);
      return e.value;
    }
    // A key function contributes its path (direction is taken from `orders`).
    if (e.type === "Lambda") return Object.keys(lambdaToSortBy(e, method))[0];
    throw new CodegenError(`.${method}(keys) entries must be a field name or a key function 'x => x.path'.`, e.pos);
  };
  if (arg.type === "ArrayLiteral") {
    if (arg.elements.length === 0) throw new CodegenError(`.${method}([keys]) needs at least one key.`, arg.pos);
    return arg.elements.map(one);
  }
  return [one(arg)];
}

/**
 * The sort directions for `.orderBy(keys, orders)`: `1` / `-1` / `"asc"` / `"desc"`,
 * or an array of them (parallel to the keys). Fewer directions than keys ⇒ the
 * remainder default ascending (lodash).
 */
function orderByDirs(arg: Expr, method: string): (1 | -1)[] {
  const one = (e: ArrayElement): 1 | -1 => {
    const dir =
      e.type === "StringLiteral" || e.type === "NumberLiteral" || e.type === "UnaryExpr" ? sortDirLiteral(e) : null;
    if (dir === null)
      throw new CodegenError(`.${method}(keys, orders) directions must be 1 / -1 / "asc" / "desc".`, e.pos);
    return dir;
  };
  if (arg.type === "ArrayLiteral") return arg.elements.map(one);
  return [one(arg)];
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

export const MUTATING_ARRAY_METHODS: ReadonlySet<string> = new Set([
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
      // `arr.slice(0, -1)` — everything-but-last, via the 2-arg `$slice`
      // (first-`n`) whose count IS allowed to be 0. `max(0, size - 1)` is 0 for
      // an empty or single-element receiver → `$slice: [arr, 0]` → []. The 3-arg
      // `$slice: [arr, 0, 0]` mongod would reject ("Third argument to $slice must
      // be positive"), even at runtime. Mirrors the `.initial()` lowering.
      const sizeExpr: Expr = mkOpCall("$size", [object], pos);
      const minus1: Expr = { type: "BinaryExpr", op: "-", left: sizeExpr, right: mkNumber(1, pos), pos };
      const clamped: Expr = mkOpCall("$max", [mkNumber(0, pos), minus1], pos);
      return mkOpCall("$slice", [object, clamped], pos);
    }
    case "shift": {
      checkArity("shift", { sig: "", none: true }, args.length, pos);
      // `$slice: [arr, 1, max(1, $size(arr))]` — everything from index 1. The
      // count is `max(1, size)`, never 0, so an empty receiver is
      // `$slice: [[], 1, 1]` → [] (position past the end) rather than the 3-arg
      // count of 0 mongod rejects. Mirrors the `.tail()` / `.drop(1)` lowering.
      const sizeExpr: Expr = mkOpCall("$size", [object], pos);
      const count: Expr = mkOpCall("$max", [mkNumber(1, pos), sizeExpr], pos);
      return mkOpCall("$slice", [object, mkNumber(1, pos), count], pos);
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
    const unusedAndV: Expr = { type: "Lambda", params: [exprVar("fillUnused")], body: v, pos };
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

  // Inner map body: `(idx >= start && idx < end) ? v : el`. All four are synthetic
  // params the user never wrote, and the fill VALUE `v` is generated INSIDE them —
  // so bare names like `x`/`i` captured a pipeline binding of the same name
  // (`let x = 5; $.arr.fill(x)` filled with each element instead of 5). This
  // rewrite runs on the AST with no ctx to gensym against, so the namespace is
  // what keeps them clear of user names.
  const sRef: Expr = { type: "ParamRef", name: exprVar("fillStart"), pos };
  const eRef: Expr = { type: "ParamRef", name: exprVar("fillEnd"), pos };
  const xRef: Expr = { type: "ParamRef", name: exprVar("fillEl"), pos };
  const iRef: Expr = { type: "ParamRef", name: exprVar("fillIdx"), pos };
  const condition: Expr = {
    type: "BinaryExpr",
    op: "&&",
    left: { type: "BinaryExpr", op: ">=", left: iRef, right: sRef, pos },
    right: { type: "BinaryExpr", op: "<", left: iRef, right: eRef, pos },
    pos,
  };
  const mapBody: Expr = { type: "TernaryExpr", condition, consequent: v, alternate: xRef, pos };
  const mapLambda: Expr = { type: "Lambda", params: [exprVar("fillEl"), exprVar("fillIdx")], body: mapBody, pos };
  const mapCall: Expr = { type: "MethodCall", object, method: "map", args: [mapLambda], pos };

  const iifeCallee: Expr = { type: "Lambda", params: [exprVar("fillStart"), exprVar("fillEnd")], body: mapCall, pos };
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
 * Lower an expr-block body. A declaration whose initialiser is a compile-time
 * constant folds — its value is inlined at every reference (via `ctx.bindings`)
 * and NO `$let` is emitted — matching the top-level constant-folding behaviour
 * (const-fold.ts) so a constant `const` vanishes wherever it appears. Any
 * non-constant declaration keeps the faithful nested-`$let` lowering, right-
 * folded so each initialiser and the `return` see every PRIOR declaration as a
 * `$$name` variable. See docs/specs/const-folding.md and method-dispatch.md.
 */
function generateExprBlock(block: ExprBlock, ctx: GenerateCtx): unknown {
  const seen = new Set<string>();
  const emptyEnv: ConstEnv = new Map();
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
    // Try to fold to a compile-time constant (prior folded decls / compile
    // params live in `c.bindings`). A name shadowing an in-scope lambda param is
    // NOT folded: `ParamRef` resolves lambda params before bindings, so folding
    // it would mis-resolve; the `$let` below shadows the param correctly instead.
    if (!c.lambdaParams.has(decl.name)) {
      const r = evalConst(decl.value, emptyEnv, c);
      if (r.ok) {
        const merged = new Map(c.bindings ?? []);
        merged.set(decl.name, r.value);
        let c2 = withBindings(c, merged);
        const t = foldedCompoundType(r.value);
        if (t) c2 = { ...c2, bindingTypes: new Map([...(c.bindingTypes ?? []), [decl.name, t]]) };
        return fold(i + 1, c2);
      }
    }
    const value = _generate(decl.value, c); // initialiser sees only prior decls
    const inner = extendCtx(c, [decl.name]); // decl.name now resolves to $$name
    return { $let: { vars: { [safeVarName(decl.name)]: value }, in: fold(i + 1, inner) } };
  };
  return fold(0, ctx);
}

/** The static compound type of a folded value, for `bindingTypes` (see const-fold.ts). */
function foldedCompoundType(v: unknown): "object" | "array" | "string" | undefined {
  if (typeof v === "string") return "string";
  if (Array.isArray(v)) return "array";
  if (v !== null && typeof v === "object" && !isOpaqueBsonValue(v)) return "object";
  return undefined;
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
  // lodash iteratee/predicate shorthands: `"a.b"` / `{ active: true }` / `["a.b", v]`
  // desugar to the equivalent one-parameter arrow, so `.map`/`.filter`/`.find`/… all
  // accept them. The method's own value/boolean handling (e.g. `jsBoolIfNeeded` for a
  // predicate) then applies, matching lodash.
  if (
    first !== undefined &&
    (first.type === "StringLiteral" || first.type === "ObjectLiteral" || first.type === "ArrayLiteral")
  ) {
    const sh = shorthandToLambda(first, method, exprVar("item"));
    if (sh !== null) return sh;
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
    // A statement block only ever parses on a stream-rooted callback. A stage-free
    // one is the JavaScript value form in disguise, so it folds (`{ return E }` → `E`).
    // Reaching the throw inside means the block holds STAGES *and* the chain that
    // carried it is being consumed as a VALUE (`.map` returning a scalar, a chained
    // `.find`), lowering to an array operator — which takes an expression and has no
    // stage position at all. The rewrite names that, rather than a heading method the
    // developer would then have to guess at.
    const keepIt =
      method === "map"
        ? "keep it a sub-pipeline by moving the stages into a heading `.aggregate((o) => { … })`, or `return` a document instead of a scalar (a document `.map` stays a '$replaceWith' stage)"
        : "keep it a sub-pipeline by moving the stages into a heading `.aggregate((o) => { … })`";
    return callbackBlockToValue(first, {
      method,
      rewrite: `the chain is consumed as a value here, so it lowers to an array operator with nowhere to run stages — ${keepIt}`,
    });
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
      `${label} cannot have a statement-block body (a sub-pipeline of stages) — that form is only for ${STREAM_BLOCK_FORM}. Use an expression, or a value-returning block \`(x) => { const y = …; return y; }\`.`,
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
    vars[safeVarName(lambda.params[i])] = _generate(a, argCtx);
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
          `\`({ $ }) => { assert($.qty >= 0, "qty must be >= 0"); … }\`.`,
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
      const [vKv, kv] = internalVar(ctx, "kv");
      return { $map: { input: { $objectToArray: genWith(exprArgs[0], {}) }, as: vKv, in: `${kv}.k` } };
    }
    case "values": {
      const exprArgs = exprArgsOnly(args, "Object.values");
      checkArity("values", { sig: "obj", exact: 1 }, exprArgs.length, pos, "Object.");
      const [vKv, kv] = internalVar(ctx, "kv");
      return { $map: { input: { $objectToArray: genWith(exprArgs[0], {}) }, as: vKv, in: `${kv}.v` } };
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
          `Object.groupBy() does not accept a statement-block arrow (a sub-pipeline of stages) — that form is only for ${STREAM_BLOCK_FORM}. Use an expression \`x => x.key\`, or a value-returning block.`,
          lambda.pos,
        );
      }
      // Reduce over the input. For each element, compute the discriminator key with the
      // user's lambda param bound to $$this. Use $let to materialise the key once, then
      // append the current element to the array under that key in the accumulator.
      const keyCtx: GenerateCtx = {
        lambdaParams: new Set([...ctx.lambdaParams, lambda.params[0]]),
        inSubPipeline: ctx.inSubPipeline,
        reduceRemap: new Map([[lambda.params[0], "this"]]),
        pipelineLets: ctx.pipelineLets,
        droppedLets: ctx.droppedLets,
        bindingTypes: ctx.bindingTypes,
        functions: ctx.functions,
        expandingFns: ctx.expandingFns,
      };
      const keyBody = genLambdaBody(lambda, keyCtx);
      const keyExpr = isStringProducing(lambdaResult(lambda)) ? keyBody : { $toString: keyBody };
      const [vKey, key] = internalVar(ctx, "key");
      return {
        $reduce: {
          input: _generate(input, ctx),
          initialValue: {},
          in: {
            $let: {
              vars: { [vKey]: keyExpr },
              in: {
                $mergeObjects: [
                  "$$value",
                  {
                    $arrayToObject: [
                      [
                        [
                          key,
                          {
                            $concatArrays: [
                              { $ifNull: [{ $getField: { field: key, input: "$$value" } }, []] },
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
      `Array.from() does not accept a statement-block arrow (a sub-pipeline of stages) — that form is only for ${STREAM_BLOCK_FORM}. Use an expression \`(_, i) => i * 2\`, or a value-returning block.`,
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
      // statement-block (`block`) form only appears inside an `.aggregate` callback,
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
