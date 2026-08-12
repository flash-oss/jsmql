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
  ExprBlock,
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
import { someArg, someExpr, someStmt } from "./ast-walk.ts";
import {
  aggregateRewrite,
  callbackBlockToValue,
  requireStageFreeCallback,
  STREAM_STAGE_REWRITE,
  tryCallbackBlockToValue,
  type StageRewrite,
} from "./callback-block.ts";
import {
  generateExprBlockWithCtx,
  noteSlotType,
  internalError,
  CodegenError,
  documentReceiverViolation,
  EMPTY_CTX,
  generateWithCtx,
  freshSubPipelineCtx,
  type GenerateCtx,
  RECEIVER_NOUN,
  requiredReceiverFamily,
  returnsReceiverElement,
  shorthandToLambda,
} from "./codegen.ts";
import { translateMatchBody, mergeTranslatedQuery, type MatchTranslation } from "./match-translation.ts";
import { LENGTH_SLOT, exprVar, letBindingVar, letFieldVar, letSysVar, tmpSlot } from "./namespace.ts";
import { didYouMean } from "./levenshtein.ts";
// Cycle-safe import: stream-methods.ts imports SlotAllocator / SubPipelineLowerer
// from this module, and lookupStreamMethod is a runtime function (not consumed
// at this module's top level), so ESM's late-binding handles it cleanly.
import {
  prepareStreamArgs,
  fromTheEndRejection,
  lookupStreamMethod,
  streamMethodNames,
  VALUE_TERMINAL_METHODS,
} from "./stream-methods.ts";
import { checkStageLinkPlacement, isStageLink, stageLinkBlockLambda, stageLinkBody } from "./stage-link.ts";

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
export type EnclosingLookupContext = {
  foreignParams: ReadonlyArray<string>;
  inScopeLetNames: ReadonlySet<string>;
  /**
   * The live `LetAllocator` of each enclosing lookup, indexed by scope depth
   * (`parentAllocators[L]` = the lookup at depth L). Threaded ONLY through the
   * `.aggregate`-block path (where enclosing refs survive as `ParamRef`s, so their
   * scope level is recoverable). A reference to scope level K — root (`$.x`,
   * K = −1), an ancestor foreign param (`outer.x`, K = that param's level), or
   * an ancestor handle — is captured ONCE at the level-(K+1) allocator (its
   * `$lookup.let` evaluates against level-K's documents, so the captured `$x`
   * is correct) and read at any deeper level as `$$jsmql_f<K+1>_x` — MQL `$$`
   * vars propagate through nested `$lookup.pipeline` boundaries, so no
   * re-capture is needed per level. Empty in the expression-body path (which
   * pre-rewrites enclosing refs to `FieldRef`s via `rewriteEnclosingForeignParams`).
   */
  parentAllocators?: ReadonlyArray<LetAllocator>;
  /**
   * Sub-stream length handles (3rd `.aggregate` param) bound by the enclosing
   * lookups: handle name → the scope depth where it is defined. Lets a nested
   * `.aggregate` block capture an ancestor `<handle>.length` into its own
   * `$lookup.let`. `.aggregate`-block path only.
   */
  parentHandles?: ReadonlyMap<string, number>;
  /**
   * Static type of those enclosing let-vars that captured a whole outer binding
   * of provable type — the `bindingTypes` slice a deeper level inherits along
   * with `inScopeLetNames`. Built by `correlatedBindingTypes`; empty at the top
   * level and for every var whose capture proves nothing (a `$.<field>` read, a
   * sub-path of a binding).
   */
  letVarTypes?: ReadonlyMap<string, "object" | "array" | "string">;
};

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
/** The `ExprBlock` sibling of `rewriteEnclosingForeignParams`, applied per initialiser and to the `return`. */
function rewriteEnclosingForeignParamsInBlock(block: ExprBlock, params: ReadonlyArray<string>): ExprBlock {
  if (params.length === 0) return block;
  return {
    type: "ExprBlock",
    decls: block.decls.map((d) => ({ ...d, value: rewriteEnclosingForeignParams(d.value, params) })),
    ret: rewriteEnclosingForeignParams(block.ret, params),
    pos: block.pos,
  };
}

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
  /**
   * `.find` returns scalar-or-null; `.filter` / `.aggregate` return an array.
   * `.aggregate(<pipeline>)` is the full-sub-pipeline join — see
   * docs/specs/lookup-stage.md § `.aggregate`.
   */
  method: "find" | "filter" | "aggregate";
  /**
   * The lambda that becomes the `$lookup.pipeline`. For `.find`/`.filter` it's
   * the predicate — always in value form, since a `{ … }` predicate body is folded
   * back to the expression it returns. For `.aggregate` it's the block-body arrow;
   * a stage-array literal argument is normalised to a synthetic zero-parameter
   * block lambda by `aggregateArgToLambda`.
   */
  lambda: Lambda;
};

/**
 * Spell a detected lookup call's receiver the way the developer wrote it — the
 * concrete `$$$.orders` / `$$$$.reporting.orders`, not the `$$$.<coll>` placeholder
 * `classifyLookupReceiver` yields from an unresolved chain. Used wherever an error
 * offers a rewrite on the same receiver.
 */
export function formatLookupReceiver(call: { db?: string; collection: string }): string {
  return call.db !== undefined ? `$$$$.${call.db}.${call.collection}` : `$$$.${call.collection}`;
}

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
 * Resolve a lookup/union READ target to its `$lookup.from` / `$unionWith.coll`
 * value — and **reject cross-database reads**. A same-database target
 * (`$$$.<coll>`, `db === undefined`) returns the bare collection string. A
 * cross-database target (`$$$$.<db>.<coll>`) is NOT lowered: it would emit a
 * `$lookup`/`$unionWith` with a `{ db, coll }` namespace, which a standalone /
 * replica-set / sharded MongoDB rejects (that shape is Atlas Data Federation
 * only) — so emitting it violates HR3. The error redirects to a same-database
 * reference. Cross-database WRITES are unaffected: `$out` builds its own
 * `{ db, coll }` body in `out-translation.ts`, and the server accepts that.
 *
 * Single choke point for every read-side `from`/`coll`: lookup (`lowerLookup`,
 * `tryExtractChainedLookup`), `$ =`/`$$ =` lookup-pivots and source-switch
 * unions (pipeline.ts), and `$$.push(...)` unions (union-translation.ts).
 */
export function requireSameDbColl(db: string | undefined, collection: string, pos: number): string {
  if (db !== undefined) {
    throw new CodegenError(
      `Cross-database reads aren't supported: '$$$$.${db}.${collection}' would emit a $lookup/$unionWith with a '{ db, coll }' namespace, ` +
        `which a standalone / replica-set / sharded MongoDB rejects (that shape is Atlas Data Federation only). ` +
        `Reference a collection in the CURRENT database instead — write '$$$.${collection}' (drop the '$$$$.${db}.' prefix) — ` +
        `and run the pipeline against the '${db}' database if that's where the data lives. ` +
        `(Cross-database WRITES still work: '$$$$.${db}.${collection} = $$' lowers to $out.)`,
      pos,
    );
  }
  return collection;
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
  // `.$match(<plain equality map>)` is the STAGE spelling of `.filter(<matches
  // object>)` — same predicate, same meaning — so it is normalised to `filter`
  // here and takes the identical path, indexed basic form included. Only a plain
  // equality map converts; a query document carrying operators (`{ qty: { $gt: 5 } }`,
  // `$and`, `$expr`) is NOT a lodash matcher and stays on the sub-pipeline path.
  const method = expr.method === "$match" && isPlainEqualityMap(expr.args[0]) ? "filter" : expr.method;
  if (method !== "find" && method !== "filter" && method !== "aggregate") return null;
  const target = extractLookupTarget(expr.object, ctx);
  if (target === null) return null;
  if (expr.args.length !== 1) return null;
  const arg = expr.args[0];
  // `.aggregate(<pipeline>)` accepts a block-body arrow OR a stage-array literal;
  // `.find`/`.filter` accept an arrow OR any lodash predicate shorthand. Each
  // normalises to a `Lambda` HERE, so the rest of the lookup machinery
  // (translatePredicate → tryBasicForm / buildBlockBodyPredicate, chained-terminal
  // materialisation, cross-DB gate) treats every spelling identically.
  // A malformed argument (expression-body arrow, spread-bearing array, empty
  // matcher) returns null here; `validateLookupShape` surfaces the actionable error.
  //
  // `.find`/`.filter` take a JavaScript predicate, so a `{ … }` body is a JS value
  // block: `tryCallbackBlockToValue` folds it back to the expression it returns, and
  // a stage-bearing block passes through untouched for `validateLookupShape` /
  // `translatePredicate` to reject (detection stays side-effect-free — this function
  // also runs from the mode-gate and position probes).
  const lambda =
    method === "aggregate"
      ? aggregateArgToLambda(arg)
      : arg.type === "Lambda"
        ? tryCallbackBlockToValue(arg)
        : predicateArgToLambda(arg, method);
  if (lambda === null) return null;
  return { pos: target.pos, callPos: expr.pos, db: target.db, collection: target.collection, method, lambda };
}

/**
 * Is this `$match` body a **plain equality map** — every key a literal field name
 * mapped to a plain value, exactly what a lodash matches-object means?
 *
 * `{ userId: $._id }` qualifies: it says "userId equals this", which is what
 * `.filter({ userId: $._id })` says. `{ qty: { $gt: 5 } }`, `{ $and: [...] }` and
 * `{ $expr: … }` do NOT — those are query-language constructs with no matcher
 * equivalent, so converting them would change what the predicate means.
 */
function isPlainEqualityMap(arg: CallArg | undefined): boolean {
  if (arg === undefined || arg.type !== "ObjectLiteral" || arg.entries.length === 0) return false;
  return arg.entries.every((e) => {
    if (e.type !== "KeyValueEntry" || e.key.kind !== "static" || e.key.name.startsWith("$")) return false;
    const v = e.value;
    // A nested object is an operator document (`{ $gt: 5 }`) whenever any key is
    // `$`-prefixed; a plain sub-document (`{ city: "NY" }`) is a legitimate
    // equality value and stays convertible.
    if (v.type === "ObjectLiteral") {
      return v.entries.every(
        (k) => k.type === "KeyValueEntry" && k.key.kind === "static" && !k.key.name.startsWith("$"),
      );
    }
    return true; // any other expression is a plain value on the right of the equality
  });
}

/**
 * Normalise a `.find(<pred>)` / `.filter(<pred>)` argument that is a lodash
 * predicate SHORTHAND (matches-object / field name / `["field", value]`) into the
 * equivalent single-parameter arrow, so `$$$.<coll>.find({ userId: $._id })` IS
 * `$$$.<coll>.find(o => o.userId === $._id)` from detection onward — same
 * `$lookup` form (basic when the predicate qualifies), same `.length` lowering,
 * same mode-gate error. Spelling must never change the emitted MQL.
 *
 * Both methods take a *predicate*, so both take every predicate spelling; `.find`
 * differing only in how its RESULT is consumed (scalar-or-null via `$first`) is no
 * reason to restrict how its predicate is WRITTEN.
 *
 * Returns null for a non-shorthand argument, and — per `detectLookupCall`'s
 * normalise-or-null contract, the same one `aggregateArgToLambda` follows — for a
 * MALFORMED shorthand: detection stays side-effect-free, and `validateLookupShape`
 * (which runs the throwing `shorthandToLambda`) owns the actionable message.
 */
function predicateArgToLambda(arg: CallArg, method: string): Lambda | null {
  return tryShorthandToLambda(arg, method, FOREIGN_SHORTHAND_PARAM);
}

/**
 * Non-throwing `shorthandToLambda`: yields the desugared arrow for a well-formed
 * lodash shorthand, and `null` for both a non-shorthand argument and a MALFORMED
 * one (empty matcher, computed key, bad `["field", value]` pair).
 *
 * Callers are *detection* / *classification* sites — "is this a shorthand?" — which
 * must stay side-effect-free: they run on expressions that may not even be the
 * construct they are testing for. The matching `validate` runs the throwing form
 * and owns the actionable message, so nothing is swallowed, only deferred.
 */
export function tryShorthandToLambda(arg: CallArg, method: string, param: string): Lambda | null {
  if (arg.type === "SpreadElement") return null;
  try {
    return shorthandToLambda(arg, method, param);
  } catch (e) {
    if (e instanceof CodegenError) return null;
    throw e;
  }
}

/**
 * Synthetic foreign-document parameter for a shorthand-spelled `.filter(...)`
 * predicate. Shared with the chained-`.filter` normaliser (`chainFilterLambda`)
 * so head and chain positions desugar to a byte-identical lambda.
 */
const FOREIGN_SHORTHAND_PARAM = exprVar("item");

/**
 * The local-`$$` predicate gate: normalise ANY predicate spelling — arrow,
 * matches-object, field name, `["field", value]` pair — into the single-parameter
 * arrow the lowering consumes, and enforce that arity.
 *
 * This is the local-stream counterpart to what `detectLookupCall`
 * (`predicateArgToLambda`) + `validateLookupShape` already do for the foreign
 * `$$$.<coll>.filter(...)` side. **Every** container that lowers a `$$.filter(...)`
 * / `$$.reject(...)` — the `$$ =` stream, a `$facet` branch, an `$out` write chain
 * — routes its argument through here, so one predicate position has one vocabulary
 * and one lowering: which spelling you write never changes the emitted MQL.
 *
 * Adding a new container? Call this and lower the `Lambda` it returns; never read
 * the raw argument yourself. Hand-rolling the check is what let the `$$ =` stream
 * lower a matches-object through the raw-query path (emitting `{ a: { $add: … } }`,
 * which mongod rejects) while `$out` rejected the same spelling outright.
 */
export function requireStreamPredicate(
  arg: CallArg,
  opts: {
    method: string;
    position: string;
    pos: number;
    /**
     * Where pipeline stages go in THIS position, for the callback-block rejection.
     * Defaults to the chained-stage spelling, right for every `$$`-rooted container;
     * a `$$$.<coll>`-rooted chain (the `$$ = $$$.<coll>.…` source switch) passes
     * `aggregateRewrite(<receiver>)` instead.
     */
    rewrite?: StageRewrite;
    /**
     * How the developer spelled the receiver — `$$` for a local stream chain,
     * `$$$.<coll>` / `$$$$.<db>.<coll>` for a `$$ = $$$.<coll>.…` source switch.
     * Every message reads it, so the advice names the chain the developer wrote. It
     * is not cosmetic: telling the author of `$$$.orders.filter(…)` to "write
     * `$$.filter(o => …)`" points at the CURRENT stream, so following the advice
     * silently changes which collection the query reads.
     */
    receiver?: string;
  },
): Lambda {
  const { method, position } = opts;
  const receiver = opts.receiver ?? "$$";
  const spell = `'${receiver}.${method}(<predicate>)' ${position}`;
  // A real arrow passes through; every other spelling desugars. `shorthandToLambda`
  // is the THROWING form on purpose — this is a lowering site, not a detection one,
  // so a malformed shorthand (`{}`, a computed key, a bad pair) must surface its own
  // actionable message rather than being silently reclassified.
  const lambda =
    arg.type === "Lambda"
      ? arg
      : arg.type === "SpreadElement"
        ? null
        : shorthandToLambda(arg, method, FOREIGN_SHORTHAND_PARAM);
  if (lambda === null) {
    throw new CodegenError(
      `${spell} takes a single arrow predicate ('o => …'), a matches-object ('{ active: true }'), ` +
        `a field name ('"active"'), or a ["field", value] pair.`,
      "pos" in arg ? arg.pos : opts.pos,
    );
  }
  if (lambda.params.length !== 1) {
    throw new CodegenError(
      `${spell} must take exactly one parameter — write '${receiver}.${method}(o => …)' (the param name is ` +
        `your choice). The param represents each document. Got ${lambda.params.length}.`,
      lambda.pos,
    );
  }
  // A predicate's `{ … }` body is a JavaScript value block.
  return callbackBlockToValue(lambda, { method, rewrite: opts.rewrite ?? STREAM_STAGE_REWRITE });
}

/**
 * The message for a `$.<field>` reference inside a local-`$$` predicate, where the
 * parameter already IS the current document so the two spellings would mean the
 * same thing (jsmql keeps one canonical spelling rather than both).
 *
 * Shared by every container for one reason beyond consistency: after
 * `requireStreamPredicate` normalises a shorthand, the "lambda parameter" is the
 * gate's *synthetic* name. Naming it back at the user ("use `jsmqlItem.b`") would be
 * unwritable advice, so a shorthand-spelled predicate is pointed at the arrow form
 * instead. Callers must not build this message themselves.
 */
export function localRefInPredicateMessage(opts: {
  letVars: Record<string, string>;
  param: string;
  method: string;
  position: string;
  /** The receiver as written — see `requireStreamPredicate`'s `receiver`. */
  receiver?: string;
}): string {
  const { param, method, position } = opts;
  const receiver = opts.receiver ?? "$$";
  const samplePath = Object.values(opts.letVars)[0].replace(/^\$+/, ""); // "$createdAt" → "createdAt"
  const head = `'$.<field>' inside '${receiver}.${method}(<predicate>)' ${position} is not supported`;
  if (param === FOREIGN_SHORTHAND_PARAM) {
    return (
      `${head} — a matches-object / field-name predicate has no parameter to reference the current ` +
      `document with. Rewrite it as an arrow and use that parameter, e.g. ` +
      `'${receiver}.${method}(o => … o.${samplePath} …)'.`
    );
  }
  return (
    `${head} — use the lambda parameter (e.g. '${param}.${samplePath}') to reference the current ` +
    `document. Inside this predicate, the lambda's parameter \`${param}\` IS the current document.`
  );
}

/**
 * Negate a normalised predicate lambda — the `.reject` half of the `.filter`/
 * `.reject` pair. Lives beside the gate so every container negates identically:
 * `o => !(<body>)`, which lowers to `$match: { $expr: { $not: … } }` (no query-form
 * De Morgan, which jsmql rejects project-wide). A `const`/`let` block negates its
 * `return` and keeps the bindings, since those compute values rather than decide the
 * match. Returns null only for a statement block, which has no single expression.
 */
export function negateStreamPredicate(lambda: Lambda): Lambda | null {
  const pos = lambda.pos;
  if (lambda.exprBlock !== undefined) {
    const block = lambda.exprBlock;
    return {
      type: "Lambda",
      params: lambda.params,
      exprBlock: {
        type: "ExprBlock",
        decls: block.decls,
        ret: { type: "UnaryExpr", op: "!", operand: block.ret, pos: block.ret.pos },
        pos: block.pos,
      },
      pos,
    };
  }
  if (lambda.body === undefined) return null;
  return {
    type: "Lambda",
    params: lambda.params,
    body: { type: "UnaryExpr", op: "!", operand: lambda.body, pos },
    pos,
  };
}

/**
 * Normalise a `.aggregate(...)` argument into the block-body `Lambda` the lookup
 * machinery consumes. A block-body arrow (`(o) => { $sort(...); ... }`) is
 * returned as-is; a stage-array literal (`[{ $sort: ... }, ...]`) is wrapped in a
 * synthetic zero-parameter block lambda whose statements are the array elements
 * (so `$.<field>` correlation auto-lets and raw `"$field"` refs pass through, as
 * in any sub-pipeline). Returns null for an expression-body arrow or a
 * spread-bearing array — `validateLookupShape` throws the actionable error.
 */
export function aggregateArgToLambda(arg: CallArg): Lambda | null {
  if (arg.type === "Lambda") return arg.block !== undefined ? arg : null;
  if (arg.type === "ArrayLiteral") {
    const stmts: PipelineStmt[] = [];
    for (const el of arg.elements) {
      if (el.type === "SpreadElement") return null;
      // Bare update ops (`$.x = …`, `delete $.x`) wrap into an UpdateFilter stmt
      // (→ `$set`/`$unset` stage); every other element is already a PipelineStmt.
      if (el.type === "AssignExpr" || el.type === "DeleteStmt") {
        stmts.push({ type: "UpdateFilter", ops: [el], pos: el.pos });
      } else {
        stmts.push(el);
      }
    }
    return { type: "Lambda", params: [], block: { type: "Pipeline", stmts, pos: arg.pos }, pos: arg.pos };
  }
  return null;
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
    // ANY method on a `$$$.<coll>` / `$$$$.<db>.<coll>` receiver heads a lookup
    // chain — not just the `detectLookupCall` heads. Every lodash stream method
    // and every chained stage call (`.$match(...)`) does too, so the mode gates
    // must see `$$$.orders.toSorted(...).take(...)` as lookup syntax as well.
    // (`extractLookupTarget` needs the collection hop, so a bare `$$$` / `$$$$`
    // receiver — the `$$$$.currentOp(...)` diagnostics — stays out.)
    if (extractLookupTarget(expr.object, ctx) !== null) return true;
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
  // Names are collected outermost-first, so they read back reversed. A hop whose
  // name isn't a compile-time string (`$$$[someVar]`) leaves `names` empty and the
  // spelling falls back to the placeholder — an error must never quote a receiver
  // the developer did not write.
  const names: string[] = [];
  let node: Expr = receiver;
  let resolved = true;
  for (;;) {
    if (node.type === "DatabaseRef" || node.type === "ClusterRef") {
      const placeholder = node.type === "DatabaseRef" ? "$$$.<coll>" : "$$$$.<db>.<coll>";
      const root = node.type === "DatabaseRef" ? "$$$" : "$$$$";
      const spelling = resolved && names.length > 0 ? [root, ...names.reverse()].join(".") : placeholder;
      return { spelling };
    }
    if (node.type === "MemberAccess") {
      names.push(node.member);
      node = node.object;
      continue;
    }
    if (node.type === "IndexAccess") {
      if (node.index.type === "StringLiteral") names.push(node.index.value);
      else resolved = false;
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
  if (expr.method === "aggregate") {
    validateAggregateShape(expr, spell);
    return;
  }
  if (expr.method !== "find" && expr.method !== "filter") {
    // A lodash stream-method / `.reject` head (`$$$.coll.toSorted(k)…`) or a
    // value-collapsing terminal (`$$$.coll.head()`) is a valid chain head — leave it
    // to the chain assembler (`tryExtractChainedLookup`) / implicit-filter injector.
    // Only a genuinely unknown method is malformed here.
    if (isPeelableChainMethod(expr.method) || VALUE_TERMINAL_METHODS.has(expr.method)) return;
    // A "from the end" method (`.takeRight`/`.toReversed`/…) is not merely unknown — it
    // is deliberately absent, so say why and name the rewrite rather than offering a
    // spelling suggestion for a method that does not exist on a stream.
    const fromTheEnd = fromTheEndRejection(expr.method, spell, expr.pos);
    if (fromTheEnd !== null) throw fromTheEnd;
    const hint = didYouMean(expr.method, ["find", "filter", "aggregate", ...streamMethodNames()], (s) => `.${s}`);
    throw new CodegenError(
      `'${spell}' supports .find(pred), .filter(pred), .aggregate(pipeline), and the lodash stream methods ` +
        `(e.g. .toSorted, .take, .map — see docs/specs/stream-methods.md), not .${expr.method}().${hint} ` +
        `For a full sub-pipeline (grouping, reshaping), use ` +
        `\`${spell}.aggregate((o) => { $group(...); $sort(...); ... })\`.`,
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
    // Both `.find` and `.filter` take a *predicate*, so both accept every lodash
    // predicate spelling — arrow, matches-object, field name, `["field", value]`.
    // Which one you write is a spelling choice; it never changes what is emitted
    // (`filterArgToLambda` desugars it at detection). Restricting `.find` to the arrow
    // would make `$$$.coll.find({ x: 1 })` an error while the same shorthand works on
    // `.filter`, in value position, and on a chained `.find`.
    if (arg.type !== "SpreadElement" && shorthandToLambda(arg, expr.method, FOREIGN_SHORTHAND_PARAM) !== null) {
      return;
    }
    throw new CodegenError(
      `.${expr.method}(predicate) requires an arrow predicate (\`.${expr.method}(o => o._id === $.userId)\`), ` +
        `a matches-object (\`{ userId: $._id }\`), a field name (\`"active"\`), or a \`["field", value]\` pair.`,
      "pos" in arg ? arg.pos : expr.pos,
    );
  }
  // A JavaScript predicate's `{ … }` body is a JS value block, never a sub-pipeline.
  // Called for its throws only — `detectLookupCall` owns the normalisation, so that
  // every consumer sees the folded lambda whether or not it came through here.
  callbackBlockToValue(arg, { method: expr.method, rewrite: aggregateRewrite(spell) });
  if (arg.params.length !== 1) {
    // `(element, index, array)` is the JavaScript signature both `.find` and
    // `.filter` take, so the extra params may be PRESENT (`(s, _i, _coll) => …` is
    // valid JS and compiles) — they just have nothing to hold: a predicate runs per
    // candidate document, so there is no index and the filtered sub-stream doesn't
    // exist yet. A *used* one is rejected and pointed at `.aggregate`, whose 3rd
    // param IS the sub-stream count handle.
    if (arg.params.length > 3) {
      throw new CodegenError(
        `.${expr.method}(predicate) takes at most 3 parameters '(element, index, array)', got ${arg.params.length}.`,
        arg.pos,
      );
    }
    for (let p = 1; p < arg.params.length; p++) {
      if (someExpr(arg, (e) => e.type === "ParamRef" && e.name === arg.params[p])) {
        throw new CodegenError(
          `'${arg.params[p]}' (the ${p === 1 ? "index" : "array"} parameter) has no meaning on a '.${expr.method}' predicate — ` +
            `the filtered sub-stream doesn't exist yet while the predicate runs. For its count, use \`.aggregate\` and its 3rd param, ` +
            `e.g. \`${spell}.aggregate((${arg.params[0]}, _i, coll) => { $match(...); assert(coll.length > 0, "…"); })\`.`,
          arg.pos,
        );
      }
    }
  }
}

/**
 * Validate a `$$$.<coll>.aggregate(<pipeline>)` shape. The argument must be a
 * block-body arrow (`(o) => { $stage(...); ... }`) or a stage-array literal
 * (`[{ $stage: ... }, ...]`). Params mirror `.filter`/`.map`: `(element, index,
 * collection)`, at most 3; the index is positional-only and only `<collection>.
 * length` is available (checked by `validateAggregateParams`).
 */
function validateAggregateShape(expr: MethodCall, spell: string): void {
  if (expr.args.length !== 1) {
    throw new CodegenError(
      `.aggregate(pipeline) takes exactly one argument — a block-body arrow \`(o) => { $stage(...); ... }\` ` +
        `or a stage-array literal \`[{ $stage: ... }, ...]\`, got ${expr.args.length}.`,
      expr.pos,
    );
  }
  validateAggregateArg(expr.args[0], expr.pos, spell);
}

/**
 * Validate a single `.aggregate(...)` argument (shape + param semantics). Shared
 * by the head form (`validateAggregateShape`) and the chain form (the `AGGREGATE`
 * stream-method's `validate`). `spell` tailors the example in the error to the
 * receiver (`$$$.<coll>` by default).
 */
export function validateAggregateArg(arg: CallArg, callPos: number, spell: string = "$$$.<coll>"): void {
  if (arg.type === "SpreadElement") {
    throw new CodegenError(
      `.aggregate(...) does not accept a spread argument — pass a block-body arrow \`(o) => { ... }\` ` +
        `or a stage-array literal \`[{ ... }, ...]\`.`,
      arg.pos,
    );
  }
  if (arg.type === "ArrayLiteral") {
    if (arg.elements.length === 0) {
      // Consistent with the arrow form, whose empty block the parser rejects.
      throw new CodegenError(
        `.aggregate([]) — an empty pipeline has nothing to run. List at least one stage, ` +
          `e.g. \`${spell}.aggregate([{ $sort: { … } }, { $limit: 5 }])\`.`,
        arg.pos,
      );
    }
    for (const el of arg.elements) {
      if (el.type === "SpreadElement") {
        throw new CodegenError(
          `.aggregate([...]) — a spread element isn't a pipeline stage. List the stages directly, ` +
            `e.g. \`${spell}.aggregate([{ $sort: { … } }, { $limit: 5 }])\`.`,
          el.pos,
        );
      }
    }
    return;
  }
  if (arg.type !== "Lambda") {
    throw new CodegenError(
      `.aggregate(pipeline) requires a block-body arrow \`(o) => { $stage(...); ... }\` ` +
        `or a stage-array literal \`[{ $stage: ... }, ...]\`.`,
      arg.pos,
    );
  }
  if (arg.block === undefined) {
    throw new CodegenError(
      `.aggregate(pipeline) needs a block body — write \`${spell}.aggregate((o) => { $match(...); $group(...); ... })\` ` +
        `(each statement is a stage) — or pass a stage-array literal \`[{ ... }, ...]\`. An expression-body arrow isn't a pipeline.`,
      arg.pos,
    );
  }
  if (arg.ret !== undefined) {
    // A trailing `return` is `.map`'s reshape terminal, not `.aggregate`'s —
    // silently dropping it would discard the user's intent, so reject.
    throw new CodegenError(
      `.aggregate((o) => { … }) doesn't take a \`return\` — each statement is a pipeline stage, not a per-document reshape. ` +
        `To shape the output add a \`$project\`/\`$replaceWith\` stage; for a per-document transform use \`.map(o => …)\`.`,
      arg.pos,
    );
  }
  if (arg.params.length > 3) {
    throw new CodegenError(
      `.aggregate((element, index, collection) => …) takes at most 3 parameters, got ${arg.params.length}.`,
      arg.pos,
    );
  }
  validateAggregateParams(arg);
}

/**
 * Enforce the `(element, index, collection)` param semantics shared by
 * `.aggregate`'s head form (via `validateAggregateShape`) and its chain form
 * (via the `AGGREGATE` stream-method's `validate`): the index (2nd) param is
 * positional-only — MongoDB streams have no per-doc index — and the 3rd
 * 'collection' param exposes only `<coll>.length` (the sub-stream count). A
 * no-op for the array form (a synthetic zero-parameter lambda) and any lambda
 * with fewer than two params.
 */
export function validateAggregateParams(lambda: Lambda): void {
  if (lambda.block === undefined) return;
  const block = lambda.block;
  const element = lambda.params[0];
  const indexParam = lambda.params.length >= 2 ? lambda.params[1] : undefined;
  const collParam = lambda.params.length === 3 ? lambda.params[2] : undefined;
  const uses = (pred: (e: Expr) => boolean): boolean => block.stmts.some((s) => someStmt(s, pred));
  if (indexParam !== undefined && uses((e) => e.type === "ParamRef" && e.name === indexParam)) {
    throw new CodegenError(
      `'${indexParam}' (the 2nd, index parameter) has no meaning inside '.aggregate((${element}, ${indexParam}, …) => …)' — ` +
        `MongoDB streams have no per-doc index. Keep it unused (e.g. '(${element}, _${indexParam}, coll)') only to reach the 3rd 'collection' parameter.`,
      lambda.pos,
    );
  }
  if (collParam !== undefined) {
    let total = 0;
    let lengthUses = 0;
    uses((e) => {
      if (e.type === "ParamRef" && e.name === collParam) total++;
      if (
        e.type === "MemberAccess" &&
        e.member === "length" &&
        e.object.type === "ParamRef" &&
        e.object.name === collParam
      ) {
        lengthUses++;
      }
      return false; // visit all
    });
    if (total > lengthUses) {
      throw new CodegenError(
        `In '.aggregate((${element}, _i, ${collParam}) => { … })', only '${collParam}.length' (the sub-stream count) is available — ` +
          `there's no materialised array to index or iterate inside the pipeline.`,
        lambda.pos,
      );
    }
  }
}

// ── Slot allocator ────────────────────────────────────────────────────────────

/**
 * Per-pipeline counter shared across `extractLookupCalls` invocations so
 * `__jsmql.tmp.1` / `tmp.2` / … stay distinct within one pipeline. The caller
 * owns the counter; the path itself comes from `tmpSlot` (see namespace.ts).
 */
export type SlotAllocator = () => string;

/** Is this node the `$$.length` (ROOT stream count) reference? */
function isRootStreamLengthNode(e: Expr): boolean {
  return e.type === "MemberAccess" && e.object.type === "CollectionRef" && e.member === "length";
}

/**
 * `$$.length` (the ROOT stream count) used inside this lookup's body: when the
 * lookup is at the TOP level (`depth === 0`, where the top-materialised
 * `$__jsmql.length` lives on the input documents), capture it into the
 * `$lookup.let` as the system var `jsmql_s0_length` and return the sub-ctx with
 * `rootStreamLengthVar` set so codegen emits `$$jsmql_s0_length`. `$$` is always
 * the ROOT stream regardless of nesting depth; inner sub-stream counts use the
 * named 3rd-arg handle instead. Deeper nesting (`depth > 0`) is left uncaptured —
 * the foreign documents don't carry the root field — so `$$.length` there stays
 * rejected [DEF-033].
 */
export function captureRootStreamLength(
  usesRootLen: boolean,
  depth: number,
  letVars: Record<string, string>,
  subCtx: GenerateCtx,
): GenerateCtx {
  if (!usesRootLen || depth !== 0) return subCtx;
  const v = letSysVar("length", 0);
  letVars[v] = `$${LENGTH_SLOT}`;
  return { ...subCtx, rootStreamLengthVar: v };
}

/** Does any of these call args read `$$.length` (the ROOT stream count)? */
export function argsReadRootStreamLength(args: readonly CallArg[]): boolean {
  return args.some((a) => someArg(a, isRootStreamLengthNode));
}

export function createSlotAllocator(): SlotAllocator {
  let n = 0;
  return () => {
    n += 1;
    return tmpSlot(n);
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
  // A path rooted at an ENCLOSING lookup's foreign param (`.aggregate`-block path only,
  // where these survive as `ParamRef`s). `level` is the scope depth of that
  // param (its index in `enclosingParams`); the resolver captures it at the
  // level-(`level`+1) allocator. See `LetAllocator.allocateAncestorForeign`.
  | { kind: "ancestorForeign"; level: number; segments: string[] }
  | {
      // An outer pipeline-scoped `let` binding referenced inside the predicate
      // (optionally with member access on it). The let materialises under
      // `__jsmql.var.<bindingName>` on each outer doc; `fieldPath` is the full
      // resolved path including any `.member` chain (e.g.
      // `__jsmql.var.user._id` for `user._id` where `user` is the binding).
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
  enclosingParams: readonly string[] = [],
): ClassifiedPath | null {
  // The bare root `$` is a `FieldRef` with an empty path; it contributes NO path
  // segment, so a bracket access onto it (`$["sub-id"]`) folds to `["sub-id"]`,
  // not `["", "sub-id"]` (which would join to the leading-dot path `.sub-id` that
  // MongoDB rejects). Mirrors general codegen, where `$["x"]` is `$x` and a bare
  // `$` is `$$ROOT` (both keyed on `path === ""`). A standalone bare `$` yields
  // `segments: []`, caught downstream (`transformExpr` rejects it, `tryBasicForm`
  // declines it) — the whole outer document isn't a correlation field path.
  if (expr.type === "FieldRef") return { kind: "local", segments: expr.path === "" ? [] : [expr.path] };
  if (expr.type === "ParamRef") {
    if (expr.name === foreignParam) return { kind: "foreign", segments: [] };
    const level = enclosingParams.indexOf(expr.name);
    if (level !== -1) return { kind: "ancestorForeign", level, segments: [] };
    if (outerLets !== undefined && outerLets.has(expr.name)) {
      const fieldPath = outerLets.get(expr.name);
      if (fieldPath !== undefined) {
        return { kind: "outerLet", segments: [expr.name], fieldPath };
      }
    }
    return null;
  }
  if (expr.type === "MemberAccess") {
    const inner = classifyPath(expr.object, foreignParam, outerLets, enclosingParams);
    if (inner === null) return null;
    if (inner.kind === "outerLet") {
      return {
        kind: "outerLet",
        segments: [...inner.segments, expr.member],
        fieldPath: `${inner.fieldPath}.${expr.member}`,
      };
    }
    if (inner.kind === "ancestorForeign") {
      return { kind: "ancestorForeign", level: inner.level, segments: [...inner.segments, expr.member] };
    }
    return { kind: inner.kind, segments: [...inner.segments, expr.member] };
  }
  if (expr.type === "IndexAccess" && expr.index.type === "StringLiteral") {
    const inner = classifyPath(expr.object, foreignParam, outerLets, enclosingParams);
    if (inner === null) return null;
    if (inner.kind === "outerLet") {
      return {
        kind: "outerLet",
        segments: [...inner.segments, expr.index.value],
        fieldPath: `${inner.fieldPath}.${expr.index.value}`,
      };
    }
    if (inner.kind === "ancestorForeign") {
      return { kind: "ancestorForeign", level: inner.level, segments: [...inner.segments, expr.index.value] };
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
  enclosingArg?: EnclosingLookupContext,
): BasicFormPredicate | PipelineFormPredicate {
  // When the caller (pipeline.ts dispatch) passes no explicit enclosing, fall
  // back to the ctx carrier — set by an outer `.aggregate` block so a nested
  // lookup reached through `lowerBlock` knows it is nested. See
  // docs/specs/lookup-stage.md § Nested lookups inside an `.aggregate` block.
  const enclosing = enclosingArg ?? outerCtx.enclosingLookup ?? EMPTY_ENCLOSING;
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
    const { rewritten, letVars } = extractLetsFromExpr(
      preRewritten,
      foreignParam,
      outerLets,
      enclosing.foreignParams.length,
    );

    // Step 2: materialise nested lookups in the now-rewritten body. The
    // enclosing context grows by one level: this lookup's foreignParam plus
    // its newly-allocated letVars are now in scope for any deeper lookups.
    const innerEnclosing: EnclosingLookupContext = {
      foreignParams: [...enclosing.foreignParams, foreignParam],
      inScopeLetNames: new Set([...enclosing.inScopeLetNames, ...Object.keys(letVars)]),
      letVarTypes: correlatedBindingTypes(outerCtx, letVars, enclosing),
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
    const subCtxBase = makeSubPipelineCtx(outerCtx, letVars, enclosing);
    // `$$.length` (ROOT count) in the predicate, at the top level → capture into
    // `$lookup.let` so the residual `$expr` codegen reads it as `$$v0_length`.
    const subCtx = captureRootStreamLength(
      someExpr(lookupFree, isRootStreamLengthNode),
      enclosing.foreignParams.length,
      letVars,
      subCtxBase,
    );
    // Index-friendly translation: constant comparisons (`o.status === "x"`)
    // become a `{ field: value }` query the server can use an index for; only
    // the parts that have no query form — correlated `$$letVar` comparisons,
    // computed expressions — fall back to `$expr`. This is the same translator
    // the top-level `$match` / `$unionWith` / `$facet` / `$out` predicates use,
    // so the lookup path does not wrap everything in `$expr` the way a bespoke one would.
    const t = translateMatchBody(lookupFree, { bindings: subCtx.bindings });
    return { kind: "pipeline", letVars, pipeline: [...nestedStages, ...matchStagesFromTranslation(t, subCtx)] };
  }

  // ── Block body: `.aggregate`'s sub-pipeline ────────────────────────
  if (lambda.block !== undefined) {
    // Stages belong to `.aggregate(pipeline)` alone. `validateLookupShape` normally
    // rejects a `.find`/`.filter` block first; this is the lowering-level guarantee
    // that no path can reach the sub-pipeline engine through a JavaScript callback.
    if (call.method !== "aggregate") {
      requireStageFreeCallback(lambda, { method: call.method, rewrite: aggregateRewrite(formatLookupReceiver(call)) });
    }
    const { letVars, pipeline } = buildBlockBodyPredicate(lambda, outerCtx, outerLets, lowerBlock, enclosing);
    return { kind: "pipeline", letVars, pipeline };
  }

  // ── Block body with `const`/`let` bindings (an `ExprBlock`) ────────
  // The whole predicate is one `$let` expression, so there is no query form to
  // translate — it rides in `$expr` entire. Bindings still see the same auto-`let`
  // hoisting as an expression body: a `$.<field>` read in an initialiser or in the
  // `return` becomes a `$lookup.let` var.
  if (lambda.exprBlock !== undefined) {
    const preRewritten = rewriteEnclosingForeignParamsInBlock(lambda.exprBlock, enclosing.foreignParams);
    const { rewritten, letVars } = extractLetsFromExprBlock(
      preRewritten,
      foreignParam,
      outerLets,
      enclosing.foreignParams.length,
    );
    const subCtx = makeSubPipelineCtx(outerCtx, letVars, enclosing);
    return {
      kind: "pipeline",
      letVars,
      pipeline: [{ $match: { $expr: generateExprBlockWithCtx(rewritten, subCtx) } }],
    };
  }

  return internalError(`.${call.method}(predicate) lambda has no body, block, or exprBlock`, lambda.pos);
}

/**
 * Ctx for a `$lookup.pipeline` body. The correlation vars this level allocated
 * (`letVars`) plus every ancestor's in-scope var join `lambdaParams`, so codegen
 * emits `$$<name>` for a reference to one.
 */
function makeSubPipelineCtx(
  outerCtx: GenerateCtx,
  letVars: Record<string, string>,
  enclosing: EnclosingLookupContext,
): GenerateCtx {
  const fresh = freshSubPipelineCtx(outerCtx, "lookup");
  const names = [...Object.keys(letVars), ...enclosing.inScopeLetNames];
  if (names.length === 0) return fresh;
  const bindingTypes = correlatedBindingTypes(outerCtx, letVars, enclosing);
  return {
    ...fresh,
    lambdaParams: new Set([...fresh.lambdaParams, ...names]),
    ...(bindingTypes !== undefined && { bindingTypes }),
  };
}

/**
 * The `bindingTypes` a `$lookup.pipeline` inherits through its correlation vars.
 *
 * A var that captures a WHOLE outer binding (`jsmql_v0_ids = "$__jsmql.var.ids"`)
 * holds exactly what that binding holds, so it carries the binding's static type
 * inward and a receiver-typed lowering inside the predicate keeps its precise
 * form — `ids.includes(p)` stays `$in` instead of a runtime `$cond` on `$isArray`
 * whose string branch can never run. Derived by joining `letVars` (var → outer
 * field path) against `pipelineLets` (binding name → field path), the two records
 * that already exist; a sub-path capture (`user._id` → `"$__jsmql.var.user._id"`)
 * matches nothing and stays untyped, because the type of `user` says nothing
 * about the type of `user._id`.
 *
 * Ancestor vars (`enclosing.letVarTypes`) merge in first so a deeper level keeps
 * what shallower ones proved; this level's own captures win on a name clash.
 */
function correlatedBindingTypes(
  outerCtx: GenerateCtx,
  letVars: Record<string, string>,
  enclosing: EnclosingLookupContext,
): ReadonlyMap<string, "object" | "array" | "string"> | undefined {
  const outerTypes = outerCtx.bindingTypes;
  const out = new Map(enclosing.letVarTypes ?? []);
  if (outerTypes !== undefined && outerTypes.size > 0) {
    const bindingByPath = new Map<string, string>();
    for (const [name, path] of outerCtx.pipelineLets ?? []) bindingByPath.set(path, name);
    for (const [letVar, value] of Object.entries(letVars)) {
      const binding = bindingByPath.get(value.slice(1)); // drop the leading "$"
      const t = binding === undefined ? undefined : outerTypes.get(binding);
      if (t !== undefined) out.set(letVar, t);
    }
  }
  return out.size > 0 ? out : undefined;
}

/**
 * Lower an `.aggregate` block (`o => { $match(...); $sort(...); ... }`) into a
 * `$lookup.pipeline` stage list — the full multi-stage sub-pipeline surface. A
 * JavaScript callback never reaches here: `.find`/`.filter`/`.map` blocks are folded
 * to their value form (or rejected) by `src/callback-block.ts` first.
 *
 * Mirrors the expression-body path's two-step nesting:
 *   1. Rewrite refs to ENCLOSING foreign params into local `FieldRef`s so this
 *      lookup's let-extractor captures them into its own `$lookup.let` (no-op at
 *      the top level).
 *   2. Grow the enclosing context (this lookup's foreignParam + its newly-
 *      allocated letVars) and thread it through `lowerBlock` via the ctx carrier
 *      (`subCtx.enclosingLookup`), so a nested `$$$.<coll>.find/filter(...)`
 *      reached while lowering the block knows it is nested.
 * The enclosing-`inScopeLetNames` join the codegen `lambdaParams` so a ref to an
 * enclosing let emits `$$<name>` rather than throwing `UnknownIdentifier`.
 */
function buildBlockBodyPredicate(
  lambda: Lambda,
  outerCtx: GenerateCtx,
  outerLets: ReadonlyMap<string, string> | undefined,
  lowerBlock: SubPipelineLowerer,
  enclosing: EnclosingLookupContext,
): { letVars: Record<string, string>; pipeline: object[] } {
  // `(element, index, collection)`: the index has no per-doc meaning on a stream,
  // and only `<coll>.length` (the sub-stream count) is available. One check, shared
  // with the head/chain validators, so the wording can't drift between them.
  validateAggregateParams(lambda);
  const collParam = lambda.params.length === 3 ? lambda.params[2] : undefined;
  return lowerCallbackBlock(lambda, outerCtx, outerLets, lowerBlock, enclosing, { collParam });
}

/**
 * Shared sub-pipeline lowerer for an `.aggregate` block — the single engine behind
 * the head form (`buildBlockBodyPredicate`) AND the chained form (the `AGGREGATE`
 * stream method in `stream-methods.ts`). The ONLY difference between them is the
 * `opts.terminalRet`: a root-replace terminal (`$ = <expr>`, a synthetic
 * `UpdateFilter` that `lowerBlock` turns into `$replaceWith`). Everything else —
 * cross-level capture, the 3rd-param length handle, nested-lookup enclosing — is
 * identical, so the two stay in lock-step.
 *
 * Cross-level capture (see `EnclosingLookupContext`): a fresh
 * `LetAllocator` is seeded with this scope's depth, the enclosing foreign params,
 * and the enclosing allocators, so `transformExpr` resolves a root read (`$.x`)
 * or an ancestor-foreign read (`outer.x`) to its correct ancestor level instead
 * of mis-capturing it as a local field of this level's input.
 */
export function lowerCallbackBlock(
  lambda: Lambda,
  outerCtx: GenerateCtx,
  outerLets: ReadonlyMap<string, string> | undefined,
  lowerBlock: SubPipelineLowerer,
  enclosing: EnclosingLookupContext,
  opts: { collParam?: string; terminalRet?: Expr } = {},
): { letVars: Record<string, string>; pipeline: object[] } {
  const block = lambda.block as Pipeline; // caller guarantees lambda.block !== undefined
  const foreignParam = lambda.params[0];
  const depth = enclosing.foreignParams.length;
  const parents = enclosing.parentAllocators ?? [];
  const parentHandles = enclosing.parentHandles ?? new Map<string, number>();
  const allocator = createLetAllocator(depth, parents, enclosing.foreignParams, parentHandles);

  // `.map`'s `return <ret>` → the root-replace statement `$ = <ret>` appended to
  // the block, so the same extraction + lowering handles the reshape terminal.
  let workBlock = block;
  if (opts.terminalRet !== undefined) {
    const ret = opts.terminalRet;
    const replaceStmt: UpdateFilter = {
      type: "UpdateFilter",
      ops: [{ type: "AssignExpr", target: { type: "FieldRef", path: "", pos: ret.pos }, value: ret, pos: ret.pos }],
      pos: ret.pos,
    };
    workBlock = { type: "Pipeline", stmts: [...block.stmts, replaceStmt], pos: block.pos };
  }

  const { rewritten } = extractLetsFromPipeline(workBlock, foreignParam, outerLets, depth, allocator);
  const letVars = allocator.letVars(); // live ref — picks up any deeper cross-level captures into THIS level
  const innerEnclosing: EnclosingLookupContext = {
    foreignParams: [...enclosing.foreignParams, foreignParam],
    inScopeLetNames: new Set([...enclosing.inScopeLetNames, ...Object.keys(letVars)]),
    letVarTypes: correlatedBindingTypes(outerCtx, letVars, enclosing),
    parentAllocators: [...parents, allocator],
    // This level's 3rd-param handle becomes an ANCESTOR handle for nested lookups,
    // recorded at this scope's depth so they can capture its `.length`.
    parentHandles: opts.collParam !== undefined ? new Map([...parentHandles, [opts.collParam, depth]]) : parentHandles,
  };
  const subCtx: GenerateCtx = {
    ...makeSubPipelineCtx(outerCtx, letVars, enclosing),
    enclosingLookup: innerEnclosing,
    // `$$.length` (the ROOT stream count) captured by an enclosing chain stays
    // in scope inside this block — preserve the var `makeSubPipelineCtx`/
    // `freshSubPipelineCtx` would otherwise drop, so `generateStreamLength`
    // keeps emitting `$$<rootStreamLengthVar>` rather than the (wrong)
    // sub-stream `$__jsmql.length`.
    rootStreamLengthVar: outerCtx.rootStreamLengthVar,
    // Bind the 3rd 'collection' param to this sub-stream's materialised count
    // (`$__jsmql.length`); `generateImplicitPipeline` (via `lowerBlock`) stamps
    // the `$setWindowFields` ahead of the statement that reads `<coll>.length`.
    ...(opts.collParam !== undefined ? { substreamLengthHandles: new Map([[opts.collParam, `$${LENGTH_SLOT}`]]) } : {}),
  };
  return { letVars, pipeline: lowerBlock(rewritten, subCtx) };
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
  enclosingArg?: EnclosingLookupContext,
  predicate: { method: string; receiver: string } = { method: "filter", receiver: "$$$.<coll>" },
): { letVars: Record<string, string>; pipelineBody: object[] } {
  // Every caller arrives with a PREDICATE lambda — a `.filter` / `.reject` head or
  // chain link — so its `{ … }` body is JavaScript, never a sub-pipeline. The chain
  // head reaches here straight from `detectLookupCall` (which normalises but never
  // throws), so this is where a stage-bearing head block is caught.
  lambda = callbackBlockToValue(lambda, { method: predicate.method, rewrite: aggregateRewrite(predicate.receiver) });
  const enclosing = enclosingArg ?? outerCtx.enclosingLookup ?? EMPTY_ENCLOSING;
  const foreignParam = lambda.params[0];
  const outerLets = outerCtx.pipelineLets;
  if (lambda.body !== undefined) {
    const preRewritten = rewriteEnclosingForeignParams(lambda.body, enclosing.foreignParams);
    const { rewritten, letVars } = extractLetsFromExpr(
      preRewritten,
      foreignParam,
      outerLets,
      enclosing.foreignParams.length,
    );
    const innerEnclosing: EnclosingLookupContext = {
      foreignParams: [...enclosing.foreignParams, foreignParam],
      inScopeLetNames: new Set([...enclosing.inScopeLetNames, ...Object.keys(letVars)]),
      letVarTypes: correlatedBindingTypes(outerCtx, letVars, enclosing),
    };
    const localAllocSlot = createSlotAllocator();
    const { stages: nestedStages, rewritten: lookupFree } = extractLookupCalls(
      rewritten,
      outerCtx,
      localAllocSlot,
      lowerBlock,
      innerEnclosing,
    );
    const subCtx = makeSubPipelineCtx(outerCtx, letVars, enclosing);
    // Index-friendly translation — see the matching note in `translatePredicate`.
    const t = translateMatchBody(lookupFree, { bindings: subCtx.bindings });
    return { letVars, pipelineBody: [...nestedStages, ...matchStagesFromTranslation(t, subCtx)] };
  }
  if (lambda.block !== undefined) {
    const { letVars, pipeline } = buildBlockBodyPredicate(lambda, outerCtx, outerLets, lowerBlock, enclosing);
    return { letVars, pipelineBody: pipeline };
  }
  // `const`/`let` bindings → one `$let` expression, so the whole predicate rides in
  // `$expr` (see `translatePredicate`'s matching branch).
  if (lambda.exprBlock !== undefined) {
    const preRewritten = rewriteEnclosingForeignParamsInBlock(lambda.exprBlock, enclosing.foreignParams);
    const { rewritten, letVars } = extractLetsFromExprBlock(
      preRewritten,
      foreignParam,
      outerLets,
      enclosing.foreignParams.length,
    );
    const subCtx = makeSubPipelineCtx(outerCtx, letVars, enclosing);
    return { letVars, pipelineBody: [{ $match: { $expr: generateExprBlockWithCtx(rewritten, subCtx) } }] };
  }
  return internalError("predicate lambda has no body, block, or exprBlock", lambda.pos);
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
export function predicateReferencesOuterDoc(rawLambda: Lambda, outerCtx: GenerateCtx): boolean {
  if (rawLambda.params.length !== 1) return false;
  // Fold a callback block to its value form first, as `detectLookupCall` does. The
  // probe must see what the lowering sees: a `$.<field>` read inside
  // `.filter(o => { return o.uid === $._id; })` correlates the chain exactly as the
  // expression spelling does. The non-throwing half keeps this a detection site.
  const lambda = tryCallbackBlockToValue(rawLambda);
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
  // (whose materialised path lives at `__jsmql.var.<binding>` on each outer doc).
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
  /** This lookup's scope depth (0 = outermost lookup). */
  depth: number;
  /** Foreign-param names of the enclosing lookups, indexed by their scope
   * depth (`enclosingParams[L]` = the param of the lookup at depth L). Only
   * populated in the `.aggregate`-block path; see `EnclosingLookupContext.parentAllocators`. */
  enclosingParams: readonly string[];
  /** Live allocator of each enclosing lookup, indexed by depth. */
  parents: readonly LetAllocator[];
  /** Sub-stream length handles (3rd `.map`/`.filter` param) of the ENCLOSING
   * lookups: handle name → the scope depth where it is defined. A
   * `<handle>.length` read of an ancestor handle is captured into the lookup
   * just inside that handle's level; see `allocateAncestorHandle`. */
  enclosingHandles: ReadonlyMap<string, number>;
  /** Records "userId" → "$userId"; on second call with same path, returns the existing name. */
  allocateForLocalPath: (segments: string[]) => string;
  /**
   * Outer pipeline-scoped `let` binding referenced inside the predicate.
   * `segments` is the access chain rooted at the binding name (e.g.
   * `["user", "_id"]` for `user._id`); `fieldPath` is the full materialised
   * path on the outer doc (e.g. `"__jsmql.var.user._id"`). The allocated letVar
   * name is `segments[last]` — same convention as `allocateForLocalPath` —
   * uniquified on collision.
   */
  allocateForOuterLet: (segments: string[], fieldPath: string) => string;
  /**
   * A ROOT-document read (`$.x`) seen inside a nested lookup (`.aggregate`-block path).
   * The root doc is the top-level pipeline's current doc; the outermost lookup
   * (depth 0) is the level whose `$lookup.let` evaluates against it, so the
   * capture lands in `parents[0]` (or this allocator at depth 0) as
   * `jsmql_f0_x = "$x"`. Returns the var name; deeper levels read it as
   * `$$jsmql_f0_x` via `$$` propagation. */
  allocateRootField: (segments: string[]) => string;
  /**
   * A read of an ENCLOSING foreign param at scope level K (`outer.x`, `.aggregate`-block
   * path). Captured at the level-(K+1) lookup (whose `let` evaluates against
   * level-K's documents) as `jsmql_f<K+1>_x = "$x"`; for the immediate parent
   * (K = depth−1) that target is THIS allocator (unchanged from before). */
  allocateAncestorForeign: (level: number, segments: string[]) => string;
  /** Capture this level's materialised sub-stream count (`$__jsmql.length`) into
   * THIS allocator's `let` as `jsmql_s<depth>_length`. Idempotent. */
  allocateSysLength: () => string;
  /** A read of an ENCLOSING handle's `.length` (`outerColl.length`), where the
   * handle is defined at scope level K (`enclosingHandles.get(name)`). Captured
   * at the level-(K+1) lookup (whose `let` evaluates against level-K's docs,
   * which carry the materialised `$__jsmql.length`) as `jsmql_s<K+1>_length`;
   * deeper levels read it via `$$` propagation. */
  allocateAncestorHandle: (handleName: string) => string;
  /** Final mapping for emit into `$lookup.let`. */
  letVars: () => Record<string, string>;
};

// `$lookup.let` correlation-var names come from `letFieldVar` / `letBindingVar`
// / `letSysVar` in namespace.ts (`jsmql_f|v|s<depth>_<name>`). The `depth` is
// load-bearing, not cosmetic: MQL `$$` variables are lexically scoped *through*
// nested `$lookup.pipeline` boundaries, so two lookups in the same nesting chain
// that each capture a value of the same name would otherwise allocate the same
// var and the deeper `let` would shadow the shallower one — the `$$v_id`
// collision bug. The scope-depth stamp keeps every level distinct.

function createLetAllocator(
  depth: number,
  parents: readonly LetAllocator[] = [],
  enclosingParams: readonly string[] = [],
  enclosingHandles: ReadonlyMap<string, number> = new Map(),
): LetAllocator {
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
  const self: LetAllocator = {
    depth,
    enclosingParams,
    parents,
    enclosingHandles,
    allocateForLocalPath(segments: string[]): string {
      const dotted = segments.join(".");
      const existing = byPath.get(dotted);
      if (existing !== undefined) return existing;
      const base = letFieldVar(segments[segments.length - 1], depth);
      const name = uniqueName(base);
      used.add(name);
      byPath.set(dotted, name);
      out[name] = `$${dotted}`;
      return name;
    },
    allocateForOuterLet(segments: string[], fieldPath: string): string {
      const existing = byPath.get(fieldPath);
      if (existing !== undefined) return existing;
      const base = letBindingVar(segments[segments.length - 1], depth);
      const name = uniqueName(base);
      used.add(name);
      byPath.set(fieldPath, name);
      out[name] = `$${fieldPath}`;
      return name;
    },
    // A reference to scope level L is captured at the allocator owning that
    // depth: `parents[L]` for an ancestor, or `self` for the current level
    // (L === depth). `allocateForLocalPath` on the chosen allocator names it
    // `jsmql_f<L>_<field>` with value `$<field>` — correct in that level's
    // `$lookup.let` context — and the result propagates to deeper levels.
    allocateRootField(segments: string[]): string {
      const target = depth === 0 ? self : parents[0];
      return target.allocateForLocalPath(segments);
    },
    allocateAncestorForeign(level: number, segments: string[]): string {
      const captureDepth = level + 1;
      const target = captureDepth >= depth ? self : parents[captureDepth];
      return target.allocateForLocalPath(segments);
    },
    allocateSysLength(): string {
      const key = " syslen"; // distinct from any dotted path / fieldPath
      const existing = byPath.get(key);
      if (existing !== undefined) return existing;
      const name = uniqueName(letSysVar("length", depth));
      used.add(name);
      byPath.set(key, name);
      out[name] = `$${LENGTH_SLOT}`;
      return name;
    },
    allocateAncestorHandle(handleName: string): string {
      const sourceLevel = enclosingHandles.get(handleName) ?? 0;
      const captureDepth = sourceLevel + 1;
      const target = captureDepth >= depth ? self : parents[captureDepth];
      return target.allocateSysLength();
    },
    letVars: () => out,
  };
  return self;
}

export function extractLetsFromExpr(
  body: Expr,
  foreignParam: string,
  outerLets?: ReadonlyMap<string, string>,
  depth: number = 0,
): { rewritten: Expr; letVars: Record<string, string> } {
  const allocator = createLetAllocator(depth);
  const rewritten = transformExpr(body, foreignParam, allocator, outerLets);
  return { rewritten, letVars: allocator.letVars() };
}

/**
 * The `ExprBlock` sibling of `extractLetsFromExpr`: rewrite each `const`/`let`
 * initialiser and the `return` expression, so `<foreignParam>.<field>` becomes a bare
 * field path and a `$.<field>` read hoists into the `$lookup.let`. A declaration NAME
 * is left alone — it is a `$let` variable, not a document path, and `transformExpr`
 * only classifies paths rooted at the foreign param or `$`.
 */
export function extractLetsFromExprBlock(
  block: ExprBlock,
  foreignParam: string,
  outerLets?: ReadonlyMap<string, string>,
  depth: number = 0,
): { rewritten: ExprBlock; letVars: Record<string, string> } {
  const allocator = createLetAllocator(depth);
  const decls: LetDecl[] = block.decls.map((d) => ({
    ...d,
    value: transformExpr(d.value, foreignParam, allocator, outerLets),
  }));
  const ret = transformExpr(block.ret, foreignParam, allocator, outerLets);
  return { rewritten: { type: "ExprBlock", decls, ret, pos: block.pos }, letVars: allocator.letVars() };
}

export function extractLetsFromPipeline(
  block: Pipeline,
  foreignParam: string,
  outerLets?: ReadonlyMap<string, string>,
  depth: number = 0,
  allocator: LetAllocator = createLetAllocator(depth),
): { rewritten: Pipeline; letVars: Record<string, string> } {
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
 * Lower a single-parameter lambda — the foreign/current document is the param —
 * into sub-pipeline stages. Shared by the `$unionWith`, `$facet`, and `$out`
 * translators, which differ only in (a) the message thrown when the lambda
 * references the *local* doc (`$.<field>`, which would need a `let` slot the
 * target stage lacks) and (b) which fresh sub-pipeline ctx they build. Both are
 * injected; the expression-body / block / missing-body skeleton and the `$match`
 * emission are identical and live here.
 *
 * An expression body is a predicate (→ one `$match`), and so is an `ExprBlock` — the
 * `const`/`let` form, which becomes one `$let` and therefore rides in `$expr` entire.
 * A **statement block** reaches here only from an `.aggregate(pipeline)` union source;
 * a predicate's block body is folded to its value form long before this, by
 * `requireStreamPredicate` / `detectLookupCall`.
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

  // `const`/`let` bindings → one `$let` expression, so the predicate rides in `$expr`
  // entire: nothing inside a `$let` has a query form to translate.
  if (lambda.exprBlock !== undefined) {
    const { rewritten, letVars } = extractLetsFromExprBlock(lambda.exprBlock, param);
    if (Object.keys(letVars).length > 0) opts.onLocalRef(letVars, param, lambda.pos);
    const subCtx = opts.freshCtx(outerCtx);
    return [{ $match: { $expr: generateExprBlockWithCtx(rewritten, subCtx) } }];
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
          target: transformTarget(op.target, foreignParam, allocator, outerLets),
          value: transformExpr(op.value, foreignParam, allocator, outerLets),
          pos: op.pos,
        };
      }
      // DeleteStmt
      return {
        type: "DeleteStmt",
        target: transformTarget(op.target, foreignParam, allocator, outerLets),
        pos: op.pos,
      };
    });
    return { type: "UpdateFilter", ops, pos: stmt.pos };
  }
  return transformExpr(stmt as Expr, foreignParam, allocator, outerLets);
}

/**
 * Transform an assignment / delete TARGET inside a block-body sub-pipeline.
 *
 * Unlike a value, a target is a WRITE destination, not a correlation read: a
 * `$.foo` here names the field `foo` on the sub-pipeline's current (foreign)
 * doc — the eventual `$set`/`$unset` key — so it must lower to a `FieldRef`,
 * never be hoisted into a `$lookup.let` var the way `transformExpr` does for a
 * local read. Both root spellings denote the current doc inside the
 * sub-pipeline (`$.foo` = current doc; `<foreignParam>.foo` = the same doc), so
 * either resolves to the bare field path. Exotic targets (computed index,
 * outer-let) fall back to the normal value transform, preserving their existing
 * behaviour and error messages.
 */
function transformTarget(
  target: Expr,
  foreignParam: string,
  allocator: LetAllocator,
  outerLets: ReadonlyMap<string, string> | undefined,
): Expr {
  const classified = classifyPath(target, foreignParam, outerLets, allocator.enclosingParams);
  // A local target lowers to the current-doc field path — INCLUDING the bare root
  // `$` (empty segments → `FieldRef("")`, the document root), which is a valid
  // root-replace destination (`$ = { … }` from an object-body `.map`). A foreign
  // target needs a real field (`o.foo`); bare `o` falls through to transformExpr's
  // bare-param rejection. (transformExpr would reject a bare-root VALUE read; a
  // bare-root WRITE target is fine, so targets are resolved here first.)
  if (classified !== null && classified.kind === "local") {
    return { type: "FieldRef", path: classified.segments.join("."), pos: target.pos };
  }
  if (classified !== null && classified.kind === "foreign" && classified.segments.length > 0) {
    return { type: "FieldRef", path: classified.segments.join("."), pos: target.pos };
  }
  return transformExpr(target, foreignParam, allocator, outerLets);
}

/**
 * Recursive AST rewriter. At each visited node:
 *   - An ancestor `<handle>.length` read (block-body path) → a `ParamRef` to the
 *     captured sub-stream-count var (`allocateAncestorHandle`).
 *   - If the node is a `classifyPath`-able sub-tree:
 *     - "local" (`$.x`) → a `ParamRef` to the allocated let-var. In a nested
 *       block (enclosingParams non-empty) `$.x` is a ROOT read, captured at the
 *       outermost lookup (`allocateRootField`); otherwise a current-level capture.
 *     - "foreign" (current param) → a bare `FieldRef(path)` (`"$path"`, the
 *       sub-pipeline's local doc).
 *     - "ancestorForeign" (an enclosing param, block-body path) → a `ParamRef` to
 *       the var captured at that param's level (`allocateAncestorForeign`).
 *   - Otherwise recurse into children, producing a fresh node with
 *     transformed sub-trees.
 *
 * Nested lambdas inside the predicate body keep their own params; we recurse into
 * expression bodies with the same foreign param so an enclosing-foreign ref still
 * hoists, but NOT into a nested lambda's statement *block* body (see the Lambda
 * case) — those are handled when the nested lookup is dispatched (`lowerCallbackBlock`).
 */
function transformExpr(
  expr: Expr,
  foreignParam: string,
  allocator: LetAllocator,
  outerLets: ReadonlyMap<string, string> | undefined,
): Expr {
  // `<enclosingHandle>.length` — a read of an ANCESTOR lookup's sub-stream count
  // (a 3rd `.map`/`.filter` param from an enclosing scope). Capture it into the
  // lookup just inside that handle's level and read it as `$$jsmql_s<…>_length`.
  if (
    expr.type === "MemberAccess" &&
    expr.member === "length" &&
    expr.object.type === "ParamRef" &&
    allocator.enclosingHandles.has(expr.object.name)
  ) {
    const letVar = allocator.allocateAncestorHandle(expr.object.name);
    return { type: "ParamRef", name: letVar, pos: expr.pos } as ParamRef;
  }
  const classified = classifyPath(expr, foreignParam, outerLets, allocator.enclosingParams);
  if (classified !== null) {
    if (classified.kind === "local") {
      // A bare root `$` (empty segments — the whole outer document) can't be a
      // correlation field path; reject with guidance instead of emitting an
      // invalid empty field path (`localField: ""` / a `let` value of `"$"`).
      if (classified.segments.length === 0) {
        throw new CodegenError(
          `Bare '$' (the whole outer document) can't be used as a value in a $lookup predicate — ` +
            `reference a specific field with '$.<field>' (e.g. '$.userId').`,
          expr.pos,
        );
      }
      // `$.x` is a ROOT-document read. In the `.aggregate`-block path inside a nested
      // lookup (enclosingParams non-empty), capture it at the outermost lookup
      // (`allocateRootField` → `jsmql_f0_x`) so it resolves to the root doc, not
      // this level's input. At the top level / expression-body path it stays a
      // current-level capture (unchanged).
      const letVar =
        allocator.enclosingParams.length > 0
          ? allocator.allocateRootField(classified.segments)
          : allocator.allocateForLocalPath(classified.segments);
      return { type: "ParamRef", name: letVar, pos: expr.pos } as ParamRef;
    }
    if (classified.kind === "ancestorForeign") {
      // A read of an enclosing lookup's foreign param (`outer.x`); capture at the
      // level just inside that param's scope so it threads down correctly.
      const letVar = allocator.allocateAncestorForeign(classified.level, classified.segments);
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
    case "ObjectIdLiteral":
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
 * `let`) or an internal `__jsmql.tmp.N` slot (when chained).
 */
export function lowerLookup(
  call: LookupCall,
  as: string,
  outerCtx: GenerateCtx,
  lowerBlock: SubPipelineLowerer,
  enclosingArg?: EnclosingLookupContext,
): object[] {
  const enclosing = enclosingArg ?? outerCtx.enclosingLookup ?? EMPTY_ENCLOSING;
  const pred = translatePredicate(call, outerCtx, lowerBlock, enclosing);
  // `$lookup.from` is the bare collection string. Same-database joins only —
  // a cross-database `$$$$.<db>.<coll>` target is rejected by `requireSameDbColl`
  // (MongoDB doesn't accept the `{ db, coll }` join namespace; see HR3).
  const from = requireSameDbColl(call.db, call.collection, call.pos);
  const stages: object[] = [];
  if (pred.kind === "basic") {
    stages.push({ $lookup: { from, localField: pred.localField, foreignField: pred.foreignField, as } });
  } else {
    stages.push({ $lookup: pipelineLookupBody(from, pred.letVars, pred.pipeline, as) });
  }
  if (call.method === "find") {
    // JS `.find()` returns scalar-or-null. Overwrite the slot with `$first`
    // so the row is preserved on no match (slot becomes null) and the slot
    // holds a single doc on any match — no row fan-out.
    stages.push({ $set: { [as]: { $first: `$${as}` } } });
  }
  return stages;
}

/**
 * The static type of the slot `lowerLookup` fills, for `staticBindingType`'s
 * `const`-typing. `.filter` / `.aggregate` leave the `$lookup.as` array in place,
 * so a binding of one is provably an array. `.find` is deliberately untyped: its
 * `$first` overwrite yields a document on a match and `null` on none, and `null`
 * is not an object.
 */
export function lookupSlotType(call: LookupCall): "array" | undefined {
  return call.method === "find" ? undefined : "array";
}

/**
 * Assemble a pipeline-form `$lookup` body, **omitting `let` when nothing was
 * correlated** — an empty `let: {}` is pure noise, and the server treats
 * `let` as optional.
 *
 * Every pipeline-form emission site routes through here so the shape can't
 * depend on which one ran. It used to: the lean form was gated on `.aggregate`
 * in `lowerLookup`, and on "the chain had no `.filter` head" in
 * `tryExtractChainedLookup` — so `$$$.orders.take(2)` and
 * `$$$.orders.filter(p).take(2)` disagreed about `let: {}` for no semantic
 * reason. One helper, one shape.
 */
export function pipelineLookupBody(
  from: string,
  letVars: Record<string, string>,
  pipeline: object[],
  as: string,
): object {
  return Object.keys(letVars).length === 0 ? { from, pipeline, as } : { from, let: letVars, pipeline, as };
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
 * Nested lookups inside an outer lookup's predicate — expression-body or
 * block-body — materialise through the same recursive descent (with
 * `EnclosingLookupContext` threading, the block-body path supplying it via
 * `outerCtx.enclosingLookup`), landing as prologue `$lookup` stages inside
 * the outer's `$lookup.pipeline`. See docs/specs/lookup-stage.md § Nested lookups.
 */
// A value-collapsing terminal (`.head()` / `.size()` / …) directly on a bare
// `$$$.<coll>` — with no `.filter`/`.find` — is sugar for "over ALL documents":
// `$$$.orders.head()` ≡ `$$$.orders.filter(() => true).head()`. Inject that implicit
// match-all `.filter` so the existing value-mode peel (over the materialised lookup
// result) handles it; without it the chain would hit the "needs .find/.filter"
// gate. Returns `expr` unchanged for anything else (a `.filter` head is already
// present, the innermost method isn't a value terminal, the receiver isn't a
// lookup target). Only fires in VALUE position (`extractLookupCalls`), so a `$$ =`
// pivot / bare statement of the same shape still reaches its rejection.
function injectImplicitFilterForValueTerminal(expr: Expr): Expr {
  if (expr.type !== "MethodCall") return expr;
  const chain: MethodCall[] = [];
  let cur: Expr = expr;
  while (cur.type === "MethodCall") {
    chain.push(cur);
    cur = cur.object;
  }
  const innermost = chain[chain.length - 1]; // the method whose object is `cur`
  if (innermost.method === "find" || innermost.method === "filter") return expr; // already has a head
  if (!VALUE_TERMINAL_METHODS.has(innermost.method)) return expr;
  if (classifyLookupReceiver(cur) === null) return expr; // not a `$$$.<coll>` receiver
  const trueArrow: Expr = {
    type: "Lambda",
    params: [exprVar("d")],
    body: { type: "BooleanLiteral", value: true, pos: innermost.pos },
    pos: innermost.pos,
  };
  const filterCall: MethodCall = {
    type: "MethodCall",
    method: "filter",
    object: cur,
    args: [trueArrow],
    pos: innermost.pos,
  };
  // Rebuild the chain from the (now filter-headed) innermost method up to `expr`.
  let rebuilt: Expr = { ...innermost, object: filterCall };
  for (let i = chain.length - 2; i >= 0; i--) rebuilt = { ...chain[i], object: rebuilt };
  return rebuilt;
}

export function extractLookupCalls(
  exprArg: Expr,
  outerCtx: GenerateCtx,
  allocSlot: SlotAllocator,
  lowerBlock: SubPipelineLowerer,
  enclosingArg?: EnclosingLookupContext,
): { stages: object[]; rewritten: Expr } {
  const expr = injectImplicitFilterForValueTerminal(exprArg);
  const enclosing = enclosingArg ?? outerCtx.enclosingLookup ?? EMPTY_ENCLOSING;
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
  // Chained `.aggregate(...)` on a `.find()` result (scalar-or-null) — not
  // meaningful, mirror the `.length`/`.reduce`-on-`.find` rejections.
  if (expr.type === "MethodCall" && expr.method === "aggregate") {
    const innerCall = detectLookupCall(expr.object, outerCtx);
    if (innerCall !== null && innerCall.method === "find") {
      throw new CodegenError(
        `.aggregate() on a .find() result is not meaningful — .find returns a scalar-or-null, not a collection to aggregate. ` +
          `Use .filter(pred).aggregate(...) to run a sub-pipeline over the matches.`,
        expr.pos,
      );
    }
    rejectAggregateOnCollapsedChain(expr, outerCtx);
  }
  rejectDocumentTerminalMethod(expr, outerCtx);
  // Direct lookup as the whole expression
  const direct = detectLookupCall(expr, outerCtx);
  if (direct !== null) {
    const slot = allocSlot();
    const stages = lowerLookup(direct, slot, outerCtx, lowerBlock, enclosing);
    // The slot IS the `$lookup.as` array for `.filter`/`.aggregate`, so a method
    // chained onto the rewritten `FieldRef` needs no runtime type guard. `.find`
    // records nothing — `lookupSlotType` leaves it untyped because its `$first`
    // overwrite is `null` on no match.
    noteSlotType(outerCtx, slot, lookupSlotType(direct));
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
 * stream-method semantics for `.toSorted` / `.flatMap` /
 * `.slice` / `.concat` / `.map` / `.filter` (which expression-form either
 * couldn't represent or represented as the bulkier `$map` / `$filter` / `$slice`
 * operators).
 */
// A synthesized `el => el.<path>` lambda for the `.map("<path>")` shorthand, used
// when peeling a terminal map off a lookup chain (below).
/** Synthetic element parameter for a shorthand-spelled `.map` iteratee. */
const ITERATEE_SHORTHAND_PARAM = exprVar("el");

// If a chain's terminal method is a value-extracting `.map(iteratee)` — a field
// string or an expression-body arrow — return its iteratee as a lambda so it can
// be applied as a value-mode `$map` on the lookup RESULT array (in the surrounding
// `$set`) rather than as a `$replaceWith` inside the `$lookup.pipeline`. That in-
// pipeline `$replaceWith` is invalid MQL when the mapped value is a scalar (mongod:
// "'replacement document' must evaluate to an object"). Returns null (leave it in
// the sub-pipeline) for a block-body arrow or a non-map terminal.
function peelableTerminalMap(m: MethodCall): Lambda | null {
  if (m.method !== "map" || m.args.length !== 1) return null;
  const arg = m.args[0];
  if (arg.type === "Lambda" && arg.block === undefined && arg.body !== undefined) return arg;
  // A block-body arrow with a NON-document return (`o => { …; return o.total }`) is
  // value-extracting exactly like the expression form `o => o.total` — normalise it so
  // it peels to a value-mode `$map` over the result array, never a scalar `$replaceWith`
  // inside the sub-pipeline (which mongod rejects). A stream `.map` block is PARSED as a
  // sub-pipeline; when it holds no real stages it's the expression form in disguise —
  // identical to the same block on an in-document array (`$.items.map(o => { return … })`):
  //   - no statements               → an expression body   (`$map: { in: <ret> }`)
  //   - only `const`/`let` bindings → an `$let` expr-block  (`$map: { in: { $let: … } }`)
  //   - real stages ($match/$sort/…) → NOT value-extractable; return the block as-is so
  //     value-mode codegen rejects it (a scalar reshape after stages is genuinely invalid).
  // A document-returning block (`ret` is an `ObjectLiteral`) stays in the sub-pipeline.
  if (arg.type === "Lambda" && arg.block !== undefined && arg.ret !== undefined && arg.ret.type !== "ObjectLiteral") {
    const stmts = arg.block.stmts;
    if (stmts.length === 0) {
      return { type: "Lambda", params: arg.params, body: arg.ret, pos: arg.pos };
    }
    if (stmts.every((s) => s.type === "LetDecl")) {
      return {
        type: "Lambda",
        params: arg.params,
        exprBlock: { type: "ExprBlock", decls: stmts as LetDecl[], ret: arg.ret, pos: arg.block.pos },
        pos: arg.pos,
      };
    }
    return arg;
  }
  // Any lodash iteratee shorthand — `"a.b"`, `{ a: 1 }`, `["a.b", v]` — desugars to
  // its arrow and peels the same way. Value position already accepts all three, so
  // restricting the stream form to the field-string spelling was an accidental gap,
  // not a capability one: every shorthand yields a NON-document (a plucked value or
  // a match boolean), which is exactly the value-mode `$map` this peel produces.
  return tryShorthandToLambda(arg, "map", ITERATEE_SHORTHAND_PARAM);
}

// A `.map` whose result is NOT provably a document — a field-string shorthand or
// an expression-body arrow whose body is anything but an object literal. Such a
// map COLLAPSES the document stream into a value stream: it can't stay in the
// `$lookup.pipeline`, because its lowering there is `$replaceWith <that value>`
// and mongod rejects a non-document new root ("'replacement document' must
// evaluate to an object"). When one appears NON-terminally (the terminal case is
// handled by the peel above), we bail the whole chain to the expression form,
// which lowers every method value-mode over the lookup RESULT array — the same
// path that already handles `.map("f").flatten().uniq()` (flatten/uniq aren't
// stream methods, so that chain always took the expression form). An object-
// literal body / statement block returns a document and is fine in-pipeline.
export function isValueCollapsingMap(m: MethodCall): boolean {
  if (m.method !== "map" || m.args.length !== 1) return false;
  const arg = m.args[0];
  // Every iteratee shorthand collapses: `"a.b"` plucks a (possibly scalar) value and
  // `{ a: 1 }` / `["a", 1]` yield a match BOOLEAN — never a document.
  if (arg.type !== "Lambda") return tryShorthandToLambda(arg, "map", ITERATEE_SHORTHAND_PARAM) !== null;
  // Expression body OR block-body return that isn't an object literal → the map
  // produces a (possibly) non-document, so it collapses a document stream to a value
  // stream. Same structural rule for both arrow shapes.
  if (arg.block === undefined && arg.body !== undefined) return arg.body.type !== "ObjectLiteral";
  if (arg.block !== undefined && arg.ret !== undefined) return arg.ret.type !== "ObjectLiteral";
  return false;
}

// A chain terminal that COLLAPSES the sub-pipeline to a single object document
// (`$group` … + `$replaceWith: { $arrayToObject }`) — lodash `.countBy`/`.keyBy`,
// and `.groupBy("<key>")` (the bare-string form only; the `$group`-body form stays
// a document stream). `$lookup.as` is always an array, so the one collapsed doc
// lands as `[obj]`; the caller unwraps it with `$first` (see the return below).
function isCollapsingTerminal(m: MethodCall): boolean {
  if (m.method === "countBy" || m.method === "keyBy") return true;
  // `.groupBy(<key>)` collapses to one object; `.groupBy({ _id, … })` — the
  // `$group`-body form — stays a document stream. The test is therefore "is it the
  // KEY form", i.e. anything but an object literal. Narrowing it to a *recognised*
  // key (`StringLiteral`, later `fieldKeyArg`) is the recurring trap: each time the
  // key surface grew, the unwrap silently stopped firing for the new spelling and
  // the caller got the raw `[obj]` slot. An unrecognised key can't reach here at
  // all — `validate` rejected it long before.
  if (m.method === "groupBy") return m.args.length === 1 && m.args[0].type !== "ObjectLiteral";
  return false;
}

/**
 * Normalise a chained foreign `.filter(...)` / `.reject(...)` to a single-parameter
 * arrow predicate over the foreign document. Accepts an arrow, or a lodash
 * shorthand (matches-object / field name / `["field", value]`) via
 * `shorthandToLambda`; `.reject` wraps the body in `!(…)`. The result feeds
 * `buildPipelineFormPredicate`, which lowers it to a `$lookup.pipeline` `$match`
 * and hoists any `$.<field>` correlation into the `$lookup.let`.
 */
function chainFilterLambda(m: MethodCall, receiver: string): Lambda {
  const rejectHint =
    m.method === "reject" ? `, a matches-object ('{ active: true }'), a field name, or a ["field", value] pair` : "";
  if (m.args.length !== 1 || m.args[0].type === "SpreadElement") {
    throw new CodegenError(`.${m.method}(<predicate>) takes a single arrow predicate ('o => …')${rejectHint}.`, m.pos);
  }
  const arg = m.args[0];
  const raw = arg.type === "Lambda" ? arg : shorthandToLambda(arg, m.method, FOREIGN_SHORTHAND_PARAM);
  // A predicate's `{ … }` body is a JavaScript value block, never a sub-pipeline.
  const base =
    raw === null ? null : callbackBlockToValue(raw, { method: m.method, rewrite: aggregateRewrite(receiver) });
  if (base === null || base.params.length !== 1) {
    throw new CodegenError(
      `.${m.method}(<predicate>) takes a single-parameter arrow ('o => …')${rejectHint}.`,
      arg.pos,
    );
  }
  if (m.method === "reject") {
    const negated = negateStreamPredicate(base);
    if (negated === null) {
      throw new CodegenError(`.reject(<predicate>) takes a single-parameter expression arrow ('o => …').`, base.pos);
    }
    return negated;
  }
  return base;
}

/**
 * Lower a chained foreign `.filter(...)` / `.reject(...)` to its `$lookup.pipeline`
 * `$match` stage(s) plus any hoisted correlation `let` vars — the same translation
 * the lookup's `.filter` head uses, so a `.filter` anywhere in the chain (not just
 * the head) correlates against the outer document identically.
 */
function lowerForeignChainFilter(
  m: MethodCall,
  receiver: string,
  outerCtx: GenerateCtx,
  lowerBlock: SubPipelineLowerer,
  enclosing: EnclosingLookupContext,
): { letVars: Record<string, string>; stages: object[] } {
  const lambda = chainFilterLambda(m, receiver);
  const { letVars, pipelineBody } = buildPipelineFormPredicate(lambda, outerCtx, lowerBlock, enclosing, {
    method: m.method,
    receiver,
  });
  return { letVars, stages: pipelineBody };
}

/**
 * Peel chain methods `methods[start..chainEnd)` into a foreign `$lookup.pipeline`
 * body (mutating `pipelineBody`) plus its correlation `let` vars (mutating
 * `letVars`). `.filter`/`.reject` lower via the shared predicate translator
 * (`lowerForeignChainFilter`, against `outerCtx`); every other method dispatches
 * through the stream-method registry (against the sub-pipeline `innerCtx`). Shared
 * by the value-position chain assembler (`tryExtractChainedLookup`) and the `$$ =`
 * correlated pivot (`lowerLookupPivot`), so a chain lowers to the same sub-pipeline
 * in either destination.
 */
export function peelForeignChain(
  methods: readonly MethodCall[],
  start: number,
  chainEnd: number,
  outerCtx: GenerateCtx,
  lowerBlock: SubPipelineLowerer,
  allocSlot: SlotAllocator,
  enclosing: EnclosingLookupContext,
  innerCtx: GenerateCtx,
  pipelineBody: object[],
  letVars: Record<string, string>,
  receiver: string,
): void {
  // Temp-field cleanup runs once after the whole chain — see StreamMethodResult.
  const cleanup: object[] = [];
  for (let i = start; i < chainEnd; i++) {
    const m = methods[i];
    // `.$match(<body>)` — a chained pipeline stage. Lowered as the equivalent
    // one-statement `.aggregate((o) => { $match(<body>); })` block, through the
    // very same engine, so an outer-document read in the body hoists into this
    // `$lookup.let` identically. See docs/specs/aggregation-stages.md.
    if (isStageLink(m)) {
      const body = stageLinkBody(m);
      checkStageLinkPlacement(m.method, m.pos, pipelineBody.length, i === chainEnd - 1, "lookup");
      const { letVars: sLets, pipeline } = lowerCallbackBlock(
        stageLinkBlockLambda(m, body),
        { ...innerCtx, slotAllocator: allocSlot },
        innerCtx.pipelineLets,
        lowerBlock,
        enclosing,
      );
      Object.assign(letVars, sLets);
      pipelineBody.push(...pipeline);
      continue;
    }
    if (m.method === "filter" || m.method === "reject") {
      const { letVars: fLets, stages } = lowerForeignChainFilter(m, receiver, outerCtx, lowerBlock, enclosing);
      Object.assign(letVars, fLets);
      pipelineBody.push(...stages);
      continue;
    }
    const def = lookupStreamMethod(m.method);
    if (def === null) continue; // caller pre-validated the chain; defensive no-op
    const args = prepareStreamArgs(def, m.args, m.pos, aggregateRewrite(receiver));
    const result = def.lower(args, innerCtx, m.pos, lowerBlock, pipelineBody, allocSlot, true);
    pipelineBody.push(...result.stages);
    if (result.cleanupStages) cleanup.push(...result.cleanupStages);
    // A chained `.aggregate` may capture cross-level reads into THIS lookup's let.
    if (result.extraLetVars) Object.assign(letVars, result.extraLetVars);
  }
  pipelineBody.push(...cleanup);
}

/**
 * Is `name` a chain method that can head/extend a foreign stream chain?
 *
 * `$`-prefixed names (stage links) are claimed unconditionally — including
 * unregistered ones — so a typo reports "not a known aggregation stage" from
 * `stageLinkBody` instead of bailing the whole chain to value-mode, where it
 * would surface as a nonsense "unknown method" suggestion.
 */
function isPeelableChainMethod(name: string): boolean {
  return lookupStreamMethod(name) !== null || name === "filter" || name === "reject" || name.startsWith("$");
}

/**
 * Reject a string/array/number/date method applied to a value terminal that
 * returned a single DOCUMENT — `$$$.orders.head().map(…)`, `.minBy("t").slice(…)`,
 * `.last().toUpperCase()`. A `$$$.<coll>` stream is a stream of documents, so an
 * element-returning terminal on it always yields a document; `$map` / `$filter` /
 * `$slice` / `$trim` over one is a shape mongod refuses at execution time
 * (`input to $map must be an array not object`), so emitting it breaks HR3.
 *
 * The document-producing set is *derived*, not listed: a value terminal
 * (`VALUE_TERMINAL_METHODS`) whose `METHODS` entry returns its receiver's element
 * (`returnsReceiverElement`). That intersection is what keeps the stream methods
 * with the same registry shape (`.sample`, `.groupBy`) and the reducer-typed
 * `.reduce` out of it. The `.find(pred)` head is gated separately in
 * `tryExtractChainedLookup`, where the advice differs (`.filter` over all matches).
 */
function rejectDocumentTerminalMethod(expr: Expr, ctx: GenerateCtx): void {
  if (expr.type !== "MethodCall") return;
  const next = expr; // the method being applied TO the terminal
  const recv = next.object;
  if (recv.type !== "MethodCall") return;
  if (!VALUE_TERMINAL_METHODS.has(recv.method) || !returnsReceiverElement(recv.method)) return;
  const needs = documentReceiverViolation(next.method);
  if (needs === null) return;
  // Only a `$$$.<coll>`-rooted chain proves the element is a document; an
  // in-document array (`$.nums.head().toFixed(2)`) keeps the generic paths.
  let cur: Expr = recv.object;
  let target = extractLookupTarget(cur, ctx);
  while (target === null) {
    if (cur.type === "MethodCall" || cur.type === "MemberAccess" || cur.type === "IndexAccess") cur = cur.object;
    else return;
    target = extractLookupTarget(cur, ctx);
  }
  const spell = target.db === undefined ? `$$$.${target.collection}` : `$$$$.${target.db}.${target.collection}`;
  const terminal = `.${recv.method}(${recv.args.length > 0 ? "..." : ""})`;
  throw new CodegenError(
    `'${spell}${terminal}' returns a single document, but '.${next.method}(...)' needs ${needs}. ` +
      `Move '.${next.method}(...)' ahead of ${terminal} ('${spell}.${next.method}(...)${terminal}'), ` +
      `or read a field of the document ('${spell}${terminal}.<field>').`,
    next.pos,
  );
}

/**
 * Reject `.aggregate(...)` whose receiver the chain has already reduced to a
 * single value — a value terminal (`.head()` / `.size()` / `.sum()` / …), a field
 * read (`.length`, `.<field>`), or an index (`[0]`). `.aggregate` needs a document
 * STREAM to run a sub-pipeline over; on a value it reaches value-mode codegen,
 * where it isn't a JavaScript method and surfaces as a bare "Unknown method
 * '.aggregate()'" — a dead end. The `.find(pred)` head has its own message
 * (caller-side, above) because its fix differs: `.find` takes a predicate, so the
 * user wants `.filter(pred).aggregate(...)`, not a reordered chain.
 *
 * Only fires on a `$$$.<coll>`-rooted chain; a plain in-document array
 * (`$.items.head().aggregate(...)`) keeps the generic unknown-method path.
 */
function rejectAggregateOnCollapsedChain(expr: MethodCall, ctx: GenerateCtx): void {
  // Walk toward the `$$$.<coll>` head, remembering the OUTERMOST hop that ends the
  // stream. Testing the target first keeps the collection hop itself unconsumed.
  let cur: Expr = expr.object;
  let collapsedBy: { spelling: string; produces: string } | null = null;
  let target = extractLookupTarget(cur, ctx);
  while (target === null) {
    if (cur.type === "MethodCall") {
      if (collapsedBy === null && !isPeelableChainMethod(cur.method)) {
        // Keep the arity visible so the suggested rewrite stays writable —
        // `.every(...)` never means the arg-less `.every()`.
        const call = `.${cur.method}(${cur.args.length > 0 ? "..." : ""})`;
        collapsedBy = { spelling: call, produces: "returns a single value" };
      }
      cur = cur.object;
    } else if (cur.type === "MemberAccess") {
      if (collapsedBy === null) collapsedBy = { spelling: `.${cur.member}`, produces: "reads a value off the result" };
      cur = cur.object;
    } else if (cur.type === "IndexAccess") {
      if (collapsedBy === null) {
        const idx = cur.index.type === "NumberLiteral" ? String(cur.index.value) : "i";
        collapsedBy = { spelling: `[${idx}]`, produces: "reads one element" };
      }
      cur = cur.object;
    } else {
      return; // not a `$$$.<coll>` chain — leave it to the generic paths
    }
    target = extractLookupTarget(cur, ctx);
  }
  if (collapsedBy === null) return; // every link kept the receiver a stream
  const spell = target.db === undefined ? `$$$.${target.collection}` : `$$$$.${target.db}.${target.collection}`;
  const { spelling, produces } = collapsedBy;
  throw new CodegenError(
    `.aggregate() on a ${spelling} result is not meaningful — ${spelling} ${produces}, not a collection to aggregate. ` +
      `Move .aggregate(...) ahead of it ('${spell}.aggregate((o) => { ... })${spelling}'), ` +
      `or drop ${spelling} to aggregate the whole stream.`,
    expr.pos,
  );
}

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
  if (methods.length === 0) return null;

  const head = methods[0];
  const direct = detectLookupCall(head, outerCtx);
  // Resolve the foreign target and the first method index to peel:
  //   - `.filter(<pred>)` head → seed the sub-pipeline from the predicate (the head
  //     becomes the leading `$match`); peel from methods[1].
  //   - a stream-method / `.reject` / `.aggregate` head → seed EMPTY and peel from
  //     methods[0]. This is the "any lodash method may start the chain" surface
  //     (`$$$.coll.toSorted(k).take(n)…`), lowering to the lean `$lookup` (no `let`
  //     when uncorrelated). `.aggregate` belongs here because it IS a registered
  //     stream method — its own `lower` contributes the block's stages, so a head
  //     `.aggregate` peels exactly like a chained one.
  // `.find` heads keep their existing dedicated handling.
  let target: { db?: string; collection: string; pos: number };
  let start: number;
  const seedLetVars: Record<string, string> = {};
  const seedPipeline: object[] = [];
  if (direct !== null && direct.method === "find") {
    // `.find(<pred>)` yields a single matched DOCUMENT. Chaining an array/string/
    // number/date method on it can never make sense — reject with a message that
    // points at `.filter(...)` (run over all matches) or a field read. Object
    // methods (`.pick`/`.omit`/…) and field access ARE valid on a document, so they
    // fall through to the existing materialise-then-value-mode path (`return null`).
    if (methods.length > 1) {
      const next = methods[1];
      const needs = documentReceiverViolation(next.method);
      if (needs !== null) {
        throw new CodegenError(
          `'$$$.${direct.collection}.find(<pred>)' returns a single matched document, but '.${next.method}(...)' needs ${needs}. ` +
            `Use '$$$.${direct.collection}.filter(<pred>).${next.method}(...)' to run it over all matches, ` +
            `or read a field of the matched document ('$$$.${direct.collection}.find(<pred>).<field>').`,
          next.pos,
        );
      }
    }
    return null;
  }
  if (direct !== null && direct.method === "filter") {
    // `.filter` head — a lone `.filter` is a DIRECT lookup handled before this walker,
    // so require at least one chained method.
    if (methods.length < 2) return null;
    const seed = buildPipelineFormPredicate(direct.lambda, outerCtx, lowerBlock, enclosing, {
      method: direct.method,
      receiver: formatLookupReceiver(direct),
    });
    Object.assign(seedLetVars, seed.letVars);
    seedPipeline.push(...seed.pipelineBody);
    target = { db: direct.db, collection: direct.collection, pos: direct.pos };
    start = 1;
  } else {
    // Stream-method / `.reject` / `.aggregate` head (`.toSorted`/`.take`/`.map`/…).
    // A lone `.aggregate` is a DIRECT lookup handled before this walker, so it only
    // reaches here with at least one chained method to peel.
    if (direct !== null && methods.length < 2) return null;
    const t = extractLookupTarget(cur, outerCtx);
    if (t === null) return null;
    if (!isPeelableChainMethod(head.method)) return null;
    target = t;
    start = 0;
  }

  // A value-extracting terminal `.map` is peeled off the sub-pipeline and applied
  // to the RESULT array instead (see `peelableTerminalMap`). `chainEnd` bounds the
  // sub-pipeline chain loop below to exclude it.
  const terminalMap = peelableTerminalMap(methods[methods.length - 1]);
  const chainEnd = terminalMap !== null ? methods.length - 1 : methods.length;
  // A peeled terminal `.map` whose immediate predecessor is an object-collapsing
  // terminal (`.countBy`/`.keyBy`/`.groupBy("k")`) is `.map` over a single object —
  // value-mode rejects that ("map expects an array, countBy returns an object"), and
  // silently applying the map over the `[obj]` slot wrapper would return the wrong
  // shape. Reject it here to match value-mode rather than mis-assemble.
  if (terminalMap !== null && chainEnd >= 1 && isCollapsingTerminal(methods[chainEnd - 1])) {
    const collapser = methods[chainEnd - 1].method;
    throw new CodegenError(
      `'.map(...)' can't follow '.${collapser}(...)' on '$$$.${target.collection}' — '.${collapser}' returns a single object, not an array. ` +
        `Drop the '.map', or map over the object's values with a value-mode expression on the assigned field.`,
      methods[methods.length - 1].pos,
    );
  }
  // Every peeled method must be a registered stream method or `.filter`/`.reject`;
  // otherwise the chain falls back to the expression-form path (`descendAndExtract`),
  // which still handles value-terminals / string methods on the lookup result.
  for (let i = start; i < chainEnd; i++) {
    // …except a "from the end" method, which must REJECT rather than fall back.
    // Falling back would materialise the sub-pipeline into an array and slice its
    // tail — but that array's order is whatever the foreign scan produced, so "the
    // last 3" is exactly as meaningless as it is on the stream itself. Silently
    // answering a question with no answer is the failure mode being removed here.
    const fromTheEnd = fromTheEndRejection(methods[i].method, `$$$.${target.collection}`, methods[i].pos);
    if (fromTheEnd !== null) throw fromTheEnd;
    if (!isPeelableChainMethod(methods[i].method)) return null;
  }
  // A value-collapsing `.map` anywhere in the SUB-PIPELINE portion (before the
  // peeled terminal) can't lower here — its in-pipeline `$replaceWith` would take a
  // non-document root. Bail to the expression form, which lowers the whole chain
  // value-mode over the result array (see `isValueCollapsingMap`).
  for (let i = start; i < chainEnd; i++) {
    if (isValueCollapsingMap(methods[i])) return null;
  }

  const letVars: Record<string, string> = { ...seedLetVars };
  const pipelineBody: object[] = [...seedPipeline];
  // `$$.length` (the ROOT stream count) used in any peeled method body: capture
  // the top-materialised `$__jsmql.length` into THIS lookup's `$lookup.let`
  // (depth-stamped `v<d>_len`) so the sub-pipeline reads it as `$$v<d>_len`
  // (via `rootStreamLengthVar`). `$$` is always the ROOT stream regardless of
  // depth; inner sub-stream counts use the 3rd-arg handle instead.
  const usesRootLen = methods
    .slice(start, chainEnd)
    .some((m) => m.args.some((a) => someArg(a, isRootStreamLengthNode)));
  // Carry `enclosing` on the chain ctx so a statement-block `.map` chain method
  // (`lowerCallbackBlock`) can capture its cross-level reads into the right
  // ancestor `$lookup.let`. Carry the outer pipeline's `let`s too, so a chain
  // `.map` can capture an outer-`let` reference (rewritten to its `$$`-var
  // before codegen, so no raw read leaks as a sub-pipeline field).
  const innerCtx: GenerateCtx = {
    ...captureRootStreamLength(
      usesRootLen,
      enclosing.foreignParams.length,
      letVars,
      freshSubPipelineCtx(outerCtx, "lookup"),
    ),
    enclosingLookup: enclosing,
    pipelineLets: outerCtx.pipelineLets,
  };
  peelForeignChain(
    methods,
    start,
    chainEnd,
    outerCtx,
    lowerBlock,
    allocSlot,
    enclosing,
    innerCtx,
    pipelineBody,
    letVars,
    formatLookupReceiver(target),
  );

  // Build the $lookup stage. `as` is an internal slot; the surrounding
  // expression's codegen reads it. (Future optimisation: detect when the
  // chain is the entire RHS of a `$.<field> = <chain>` and use the field
  // path as `as` directly, dropping the trailing `$set` + `$unset`.)
  const slot = allocSlot();
  const from = requireSameDbColl(target.db, target.collection, target.pos);
  const slotRef: Expr = { type: "FieldRef", path: slot, pos: expr.pos };
  // A peeled terminal `.map` becomes `<slot>.map(iteratee)` — codegen lowers it to
  // a value-mode `$map` over the lookup result array in the surrounding assignment.
  const rewritten: Expr =
    terminalMap !== null
      ? { type: "MethodCall", object: slotRef, method: "map", args: [terminalMap], pos: expr.pos }
      : slotRef;
  const stages: object[] = [{ $lookup: pipelineLookupBody(from, letVars, pipelineBody, slot) }];
  // A collapsing terminal (`.countBy`/`.keyBy`/`.groupBy("k")`) makes the sub-
  // pipeline emit exactly one object doc, but `$lookup.as` is always an array — so
  // the slot holds `[obj]`. Unwrap it to the single object (mirrors lowerLookup's
  // `.find` $first); `$ifNull(…, {})` makes an empty foreign match yield `{}`
  // (lodash `_.countBy([]) === {}`) rather than a missing field.
  const collapsed = isCollapsingTerminal(methods[methods.length - 1]);
  if (collapsed) {
    stages.push({ $set: { [slot]: { $ifNull: [{ $first: `$${slot}` }, {}] } } });
  }
  // Either way the slot's type is certain: the unwrapped single object, or the
  // `$lookup.as` array the chain's stages transformed.
  noteSlotType(outerCtx, slot, collapsed ? "object" : "array");
  return { stages, rewritten };
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
    case "ObjectIdLiteral":
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
