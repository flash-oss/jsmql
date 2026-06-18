// Stream-method registry: the chainable JS array-method vocabulary that
// extends a `$$ = $$.<chain>;` or `$$ = $$$.<coll>.<chain>;` RHS into
// pipeline stages. One entry per method, each declaring its arg-shape
// validator and its lowering to MQL stages. Walked by pipeline.ts —
// adding a method here makes it usable in both stream contexts.
//
// See docs/specs/stream-methods.md for the design and the per-method
// shape/lowering/error table.

import type { ArrayElement, CallArg, Expr } from "./ast.ts";
import { CodegenError, generateWithCtx, type GenerateCtx } from "./codegen.ts";
import {
  extractLetsFromExpr,
  extractLookupCalls,
  type SlotAllocator,
  type SubPipelineLowerer,
} from "./lookup-translation.ts";
import { GROUP_TMP } from "./namespace.ts";
import { containsUnionPush } from "./union-translation.ts";
import { lowerUnionPush } from "./union-translation.ts";

type LambdaNode = Extract<Expr, { type: "Lambda" }>;

export type StreamMethodResult = {
  /** Stages this method contributes, appended to the surrounding chain. */
  stages: object[];
  /**
   * True if the emitted stages replace the document and drop in-scope `let`
   * bindings. Threaded back to the caller so the outer pipeline ctx can
   * clear the let scope. Defaults to false.
   */
  clearLets?: boolean;
  /**
   * If true, the caller drops the *immediately preceding* stage from the
   * accumulator before appending `stages`. Used by methods like
   * `.toReversed()` that rewrite the preceding `$sort` rather than appending
   * a new stage. Defaults to false.
   */
  replacesPreviousStage?: boolean;
};

export type StreamMethodDef = {
  /** JS method name (e.g. "slice"). */
  name: string;
  /**
   * Validate the call's arg shape. Throw `CodegenError` (with `.pos`) for
   * any rejection branch. Called before `lower`; lowering may assume the
   * args have the shape the validator accepts.
   */
  validate: (args: readonly CallArg[], callPos: number) => void;
  /**
   * Produce the stages this method contributes.
   *
   * `prevStages` is the read-only view of stages the chain has emitted so
   * far in this context (outer pipeline for `$$` chains; `$unionWith`
   * sub-pipeline body for `$$$.<coll>` chains). Methods that don't need to
   * peek (`.slice`, `.map`, …) simply ignore it. Methods that do
   * (`.toReversed`) can read the last stage and return
   * `replacesPreviousStage: true` so the caller drops it before appending.
   *
   * `allocSlot` allocates a fresh `__jsmql.tmp.<N>` slot from the
   * surrounding pipeline's tracker — used by methods that need to
   * materialise embedded `$$$.<coll>.find/filter(...)` lookups (e.g.
   * `.map`'s body). Each call to `allocSlot()` marks the pipeline as
   * having used the namespace so the trailing `$unset: "__jsmql"` cleanup
   * is emitted. `inSubPipeline` is true when the chain is being lowered
   * inside a `$unionWith.pipeline` body (i.e. the `$$$.<coll>.<chain>` head);
   * methods that would otherwise produce nested `$lookup` stages use this
   * flag to surface the standard "nested lookup not yet supported" error.
   */
  lower: (
    args: readonly CallArg[],
    ctx: GenerateCtx,
    callPos: number,
    lowerBlock: SubPipelineLowerer,
    prevStages: readonly object[],
    allocSlot: SlotAllocator,
    inSubPipeline: boolean,
  ) => StreamMethodResult;
};

// ── .slice(start, end?) → $skip + $limit ──────────────────────────────────────
//
// Non-negative integer literals only. `start === 0` skips the `$skip` emission
// (no-op); a missing `end` skips the `$limit` emission (slice-from-start).
//
// JS `arr.slice(start, end)` returns elements at indices [start, end). The
// stream equivalent skips `start` documents from the head and (optionally)
// limits the remaining count to `end - start`.
const SLICE: StreamMethodDef = {
  name: "slice",
  validate(args, callPos) {
    if (args.length === 0 || args.length > 2) {
      throw new CodegenError(`.slice(start[, end]) takes 1 or 2 arguments, got ${args.length}.`, callPos);
    }
    for (const arg of args) {
      if (arg.type === "SpreadElement") {
        throw new CodegenError(`.slice(start[, end]) does not accept spread arguments.`, arg.pos);
      }
      if (arg.type !== "NumberLiteral") {
        throw new CodegenError(
          `.slice(start[, end]) requires non-negative integer literals; got '${arg.type}'. Computed or dynamic arguments aren't supported on streams in v1 — write the literal in source.`,
          arg.pos,
        );
      }
      if (arg.value < 0 || !Number.isInteger(arg.value)) {
        throw new CodegenError(
          `.slice(start[, end]) requires non-negative integer literals; got ${arg.value}. Negative indices and fractional values aren't supported on streams.`,
          arg.pos,
        );
      }
    }
    if (args.length === 2) {
      const start = (args[0] as Extract<Expr, { type: "NumberLiteral" }>).value;
      const end = (args[1] as Extract<Expr, { type: "NumberLiteral" }>).value;
      if (end < start) {
        throw new CodegenError(`.slice(start, end) requires end >= start (got start=${start}, end=${end}).`, callPos);
      }
    }
  },
  lower(args, _ctx, _callPos) {
    const start = (args[0] as Extract<Expr, { type: "NumberLiteral" }>).value;
    const stages: object[] = [];
    if (start > 0) stages.push({ $skip: start });
    if (args.length === 2) {
      const end = (args[1] as Extract<Expr, { type: "NumberLiteral" }>).value;
      stages.push({ $limit: end - start });
    }
    return { stages };
  },
};

// ── .concat(...others) → $unionWith per arg ───────────────────────────────────
//
// JS-idiomatic alias for `$$.push(...)` in the chain context. Same arg-shape
// rules — collections must be spread (`...$$$.coll[.filter(p)]`), inline docs
// must not, `.find(pred)` results must not. The lowering routes through
// `lowerUnionPush` so the two codepaths stay in lock-step (no second copy of
// the spread / inline-doc / `.find` validation logic).
//
// Statement-only `$$.push(...)` continues to live in `union-translation.ts`;
// `.concat` is purely the chain-method analogue.
const CONCAT: StreamMethodDef = {
  name: "concat",
  validate(args, callPos) {
    if (args.length === 0) {
      throw new CodegenError(
        `.concat(...) requires at least one argument — a document literal ('{...}'), a spread of '$$$.<coll>[.filter(pred)]', or '$$$.<coll>.find(pred)'.`,
        callPos,
      );
    }
    // Per-arg shape validation lives inside `lowerUnionPush` (same engine
    // `$$.push` uses) — running it here would duplicate the rejection branches
    // verbatim. Defer.
  },
  lower(args, ctx, callPos, lowerBlock) {
    const stages = lowerUnionPush({ pos: callPos, callPos, args: [...args] }, ctx, lowerBlock);
    return { stages };
  },
};

// ── .map(d => <expr>) → $replaceWith ──────────────────────────────────────────
//
// Chain-form of the existing `$ = <expr>` statement sugar. Single-param
// arrow only; the parameter IS the current document, so `d.x` rewrites to
// the bare field path `$x` and `$.<field>` references are rejected (same
// "use the lambda parameter" convention as `.filter`). `$$.push` calls
// inside the body are rejected (statement-only construct, semantics don't
// fit inside an expression-position lambda).
//
// `$$$.<coll>.find/filter(...)` lookups inside the body ARE supported in
// both stream contexts. The body is post-processed through
// `extractLookupCalls` to materialise each lookup into an
// `__jsmql.tmp.<N>` slot ahead of the `$replaceWith`. References to
// the outer doc (`d.<field>`) get rewritten to bare field paths via
// `extractLetsFromExpr` BEFORE the lookup extractor runs, so the lookup
// predicate's `extractLetsFromExpr` (called from inside
// `translatePredicate`) sees those as `$.<field>` and hoists them to
// `$lookup.let` slots — basic-form is preferred when the predicate is a
// single `===` between matching paths. In the lookup-body context
// (`$$$.<coll>.filter(p).map(...)`), the materialised `$lookup` lands as
// a nested stage inside the outer `$unionWith.pipeline` — valid MQL,
// since the lookup correlates against the sub-pipeline's local doc (the
// foreign collection), not any outer-pipeline `let` binding.
const MAP: StreamMethodDef = {
  name: "map",
  validate(args, callPos) {
    if (args.length !== 1) {
      throw new CodegenError(
        `.map(d => <expr>) takes exactly one argument (a single-parameter arrow), got ${args.length}.`,
        callPos,
      );
    }
    const arg = args[0];
    if (arg.type === "SpreadElement") {
      throw new CodegenError(`.map(...) does not accept a spread argument — pass a '(d) => <expr>' arrow.`, arg.pos);
    }
    if (arg.type !== "Lambda") {
      throw new CodegenError(
        `.map(d => <expr>) requires an arrow function as its argument, e.g. '.map(d => ({ id: d._id, name: d.name }))'.`,
        arg.pos,
      );
    }
    if (arg.params.length !== 1) {
      throw new CodegenError(
        `.map(d => <expr>) takes a single-parameter arrow (got ${arg.params.length}). MongoDB streams have no per-doc index, so '(d, i) => …' isn't meaningful here.`,
        arg.pos,
      );
    }
    if (arg.body === undefined) {
      throw new CodegenError(
        `.map(d => <expr>) requires an expression body. Block-body arrows ('d => { … }') aren't supported here — split into separate stages ($set, $project, …) instead.`,
        arg.pos,
      );
    }
  },
  lower(args, ctx, _callPos, lowerBlock, _prevStages, allocSlot, _inSubPipeline) {
    const lambda = args[0] as LambdaNode;
    const param = lambda.params[0];
    const body = lambda.body as Expr;
    if (containsUnionPush(body)) {
      throw new CodegenError(
        `'$$.push(...)' inside a '.map(d => …)' body isn't meaningful — '$$.push' is a statement-level form that emits '$unionWith' stages. Hoist it before the chain.`,
        lambda.pos,
      );
    }
    // Lookups inside the body are supported in both the top-level `$$` chain
    // and the lookup-body context (`$$$.<coll>.<chain>`). In the latter,
    // they land as a `$lookup` nested inside the outer `$unionWith.pipeline`
    // — valid MQL; the basic-form / pipeline-form translation in
    // `lookup-translation.ts` correlates against the sub-pipeline's local
    // doc (the foreign collection from the outer `$unionWith`), not any
    // outer-pipeline `let` bindings, so the let-coordination problem that
    // blocks the general nested-lookup case doesn't apply here.
    const { rewritten, letVars } = extractLetsFromExpr(body, param);
    if (Object.keys(letVars).length > 0) {
      const samplePath = Object.values(letVars)[0].replace(/^\$+/, "");
      throw new CodegenError(
        `'$.<field>' inside '.map(d => …)' isn't supported — use the lambda parameter (e.g. '${param}.${samplePath}') to reference each input document. Inside this map, the lambda parameter IS the current document.`,
        lambda.pos,
      );
    }
    // Materialise any `$$$.<coll>.find/filter(...)` lookups in the rewritten
    // body into prologue stages. `extractLookupCalls` handles the basic-vs-
    // pipeline-form predicate translation, auto-`let` extraction (for the
    // outer-doc paths we just rewrote to bare `FieldRef`s), and `$first`
    // wrapping for `.find`. When there are no lookups it returns prologue=[]
    // and the unchanged expr.
    const { stages: prologue, rewritten: rewritten2 } = extractLookupCalls(rewritten, ctx, allocSlot, lowerBlock);
    const expr = generateWithCtx(rewritten2, ctx);
    return { stages: [...prologue, { $replaceWith: expr }], clearLets: true };
  },
};

// ── .toSorted((a, b) => …) → $sort ────────────────────────────────────────────
//
// Accepts a comparator-shape expression body built from `a.<path> - b.<path>`
// terms (ascending), `b.<path> - a.<path>` terms (descending), and `||`
// combining multiple terms (compound sort, source order preserved). Anything
// else is rejected — bare `.toSorted()` (default JS string compare) included,
// because MongoDB streams of documents have no natural ordering.
type ComparatorPath = { param: "a" | "b"; path: string };

function classifyComparatorPath(expr: Expr, paramA: string, paramB: string): ComparatorPath | null {
  let cur: Expr = expr;
  const segments: string[] = [];
  while (cur.type === "MemberAccess" || cur.type === "IndexAccess") {
    if (cur.type === "MemberAccess") {
      segments.unshift(cur.member);
      cur = cur.object;
      continue;
    }
    if (cur.type === "IndexAccess" && cur.index.type === "StringLiteral") {
      segments.unshift(cur.index.value);
      cur = cur.object;
      continue;
    }
    return null;
  }
  if (cur.type !== "ParamRef") return null;
  const which: "a" | "b" | null = cur.name === paramA ? "a" : cur.name === paramB ? "b" : null;
  if (which === null) return null;
  if (segments.length === 0) return null;
  return { param: which, path: segments.join(".") };
}

function parseComparatorBody(body: Expr, paramA: string, paramB: string, callPos: number): Record<string, 1 | -1> {
  if (body.type === "BinaryExpr" && body.op === "||") {
    const left = parseComparatorBody(body.left, paramA, paramB, callPos);
    const right = parseComparatorBody(body.right, paramA, paramB, callPos);
    return { ...left, ...right };
  }
  if (body.type === "BinaryExpr" && body.op === "-") {
    const leftPath = classifyComparatorPath(body.left, paramA, paramB);
    const rightPath = classifyComparatorPath(body.right, paramA, paramB);
    if (leftPath !== null && rightPath !== null && leftPath.path === rightPath.path) {
      if (leftPath.param === "a" && rightPath.param === "b") return { [leftPath.path]: 1 };
      if (leftPath.param === "b" && rightPath.param === "a") return { [leftPath.path]: -1 };
    }
  }
  throw new CodegenError(
    `.toSorted((${paramA}, ${paramB}) => …) accepts only '${paramA}.<field> - ${paramB}.<field>' (ascending) or '${paramB}.<field> - ${paramA}.<field>' (descending) terms, combined with '||' for compound sorts. Other comparator shapes aren't supported on streams.`,
    body.pos ?? callPos,
  );
}

const TO_SORTED: StreamMethodDef = {
  name: "toSorted",
  validate(args, callPos) {
    if (args.length === 0) {
      throw new CodegenError(
        `.toSorted(<comparator>) requires a comparator arrow — MongoDB streams have no natural document ordering. Write '.toSorted((a, b) => a.<field> - b.<field>)' for ascending, 'b.<field> - a.<field>' for descending.`,
        callPos,
      );
    }
    if (args.length > 1) {
      throw new CodegenError(`.toSorted(<comparator>) takes exactly one argument, got ${args.length}.`, callPos);
    }
    const arg = args[0];
    if (arg.type === "SpreadElement") {
      throw new CodegenError(`.toSorted(...) does not accept a spread argument.`, arg.pos);
    }
    if (arg.type !== "Lambda") {
      throw new CodegenError(
        `.toSorted(<comparator>) requires an arrow function, e.g. '.toSorted((a, b) => a.age - b.age)'.`,
        arg.pos,
      );
    }
    if (arg.params.length !== 2) {
      throw new CodegenError(
        `.toSorted(<comparator>) requires a two-parameter arrow '(a, b) => …' (got ${arg.params.length} params).`,
        arg.pos,
      );
    }
    if (arg.body === undefined) {
      throw new CodegenError(`.toSorted(<comparator>) requires an expression body, not a block.`, arg.pos);
    }
  },
  lower(args, _ctx, callPos, _lowerBlock) {
    const lambda = args[0] as LambdaNode;
    const [paramA, paramB] = lambda.params;
    const body = lambda.body as Expr;
    const spec = parseComparatorBody(body, paramA, paramB, callPos);
    return { stages: [{ $sort: spec }] };
  },
};

// ── .toReversed() → flips the preceding $sort spec ────────────────────────────
//
// Zero-arg. Only valid when the immediately preceding stage is a `$sort` —
// MongoDB streams of documents have no natural ordering, so reversing requires
// a sort key. In the `$$ = $$.<chain>` form that preceding `$sort` comes from a
// `.toSorted(...)` earlier in the same chain; in the bare-statement form
// (`$$.toReversed();`) it can also come from a prior statement or a literal
// `$sort(...)` stage, since the chain is lowered against the live pipeline.
// Lowering doesn't emit a new $sort stage: it rewrites the preceding one with
// all directions flipped (1 → -1, -1 → 1), so the total stage count stays equal
// to a hand-written descending `.toSorted`.
const TO_REVERSED: StreamMethodDef = {
  name: "toReversed",
  validate(args, callPos) {
    if (args.length !== 0) {
      throw new CodegenError(`.toReversed() takes no arguments, got ${args.length}.`, callPos);
    }
  },
  lower(_args, _ctx, callPos, _lowerBlock, prevStages) {
    const last = prevStages[prevStages.length - 1] as Record<string, unknown> | undefined;
    const sortSpec = last !== undefined ? (last["$sort"] as Record<string, unknown> | undefined) : undefined;
    if (sortSpec === undefined) {
      throw new CodegenError(
        `.toReversed() needs a preceding $sort (from a '.toSorted(...)' call or a '$sort' stage) to invert — MongoDB streams have no natural document ordering. Either swap to '.toSorted((a, b) => b.<field> - a.<field>)' for descending directly, or place '.toReversed()' after a sort.`,
        callPos,
      );
    }
    const flipped: Record<string, 1 | -1> = {};
    for (const key of Object.keys(sortSpec)) {
      const dir = sortSpec[key];
      if (dir !== 1 && dir !== -1) {
        throw new CodegenError(
          `.toReversed() can only invert a '$sort' with numeric 1/-1 directions (preceding stage has '${key}: ${String(dir)}'). Inverting non-direction sort specs (text-meta, custom expressions) isn't supported.`,
          callPos,
        );
      }
      flipped[key] = dir === 1 ? -1 : 1;
    }
    return { stages: [{ $sort: flipped }], replacesPreviousStage: true };
  },
};

// ── .flatMap(d => d.<path>) → $unwind ─────────────────────────────────────────
//
// v1 only supports bare-field-path bodies. The lambda body must walk back
// to the param ref through `.member` / `["literal"]` access; the lowered
// stage is a single `$unwind: "$<path>"` that splits each input doc into
// one-per-element, with surrounding fields preserved (MQL-natural — differs
// from JS `flatMap` which yields bare elements).
//
// Users who want JS-faithful "just the elements" can chain
// `.map(d => d.<path>)` after to project the unwound array down to its
// element. More complex bodies (e.g. `.flatMap(d => d.items.map(...))`)
// would require a slot allocator threaded through the chain walker;
// deferred to a follow-up.

function paramFieldPath(expr: Expr, param: string): string | null {
  const segments: string[] = [];
  let cur: Expr = expr;
  while (cur.type === "MemberAccess" || cur.type === "IndexAccess") {
    if (cur.type === "MemberAccess") {
      segments.unshift(cur.member);
      cur = cur.object;
      continue;
    }
    if (cur.type === "IndexAccess" && cur.index.type === "StringLiteral") {
      segments.unshift(cur.index.value);
      cur = cur.object;
      continue;
    }
    return null;
  }
  if (cur.type !== "ParamRef") return null;
  if (cur.name !== param) return null;
  if (segments.length === 0) return null;
  return segments.join(".");
}

const FLAT_MAP: StreamMethodDef = {
  name: "flatMap",
  validate(args, callPos) {
    if (args.length !== 1) {
      throw new CodegenError(
        `.flatMap(d => d.<path>) takes exactly one argument (a single-parameter arrow), got ${args.length}.`,
        callPos,
      );
    }
    const arg = args[0];
    if (arg.type === "SpreadElement") {
      throw new CodegenError(`.flatMap(...) does not accept a spread argument.`, arg.pos);
    }
    if (arg.type !== "Lambda") {
      throw new CodegenError(
        `.flatMap(d => d.<path>) requires an arrow function — in v1 the body must be a bare field-path on the lambda param (e.g. 'd.items', 'd.profile.tags').`,
        arg.pos,
      );
    }
    if (arg.params.length !== 1) {
      throw new CodegenError(
        `.flatMap(d => d.<path>) requires a single-parameter arrow (got ${arg.params.length} params).`,
        arg.pos,
      );
    }
    if (arg.body === undefined) {
      throw new CodegenError(`.flatMap(d => d.<path>) requires an expression body, not a block.`, arg.pos);
    }
  },
  lower(args, _ctx, callPos, _lowerBlock, _prevStages) {
    const lambda = args[0] as LambdaNode;
    const param = lambda.params[0];
    const body = lambda.body as Expr;
    const path = paramFieldPath(body, param);
    if (path === null) {
      throw new CodegenError(
        `.flatMap(d => …) v1 only supports a bare field-path body on the lambda param (e.g. '.flatMap(d => d.items)'). Complex bodies (e.g. '.flatMap(d => d.items.map(...))') aren't supported yet — hoist the transformation to a separate stage above the chain.`,
        body.pos ?? callPos,
      );
    }
    return { stages: [{ $unwind: `$${path}` }] };
  },
};

// ── $$ = [{ key: $$.reduce(…) }] wrap pattern → $group + $replaceWith ─────────
//
// `.reduce(...)` is NOT a chain method on `$$`. In JS, `arr.reduce(...)`
// returns a single value (scalar / object / array depending on the
// reducer); assigning a non-array value directly to `$$` would violate
// the "stream is always an array of docs" invariant. So jsmql requires
// the user to **explicitly wrap** the reduce result(s) into a stream-
// shaped RHS:
//
//   - For scalar reducers: `$$ = [{ <key>: $$.reduce(<reducer>, <init>) }];`
//     The wrap turns the scalar into a named field of a single-doc stream.
//   - For object reducers: `$$ = [$$.reduce(<reducer>, <init>)];`
//     (future work — needs object-returning reducer patterns).
//
// This file owns the scalar-into-object wrap. Each entry of the inner
// object must be a direct `$$.reduce(...)` call; lowering pattern-matches
// each reducer body to a MongoDB `$group` accumulator and emits:
//
//   [
//     { $group: { _id: null, <key>: { $sum/$max/$min: <expr> }, ... } },
//     { $replaceWith: { <key>: "$<key>", ... } },                    // drop _id
//   ]
//
// Reducer-body shapes (pattern-matched per entry):
//
//   `acc + d.<field>`              → `{ $sum: "$<field>" }`
//   `acc + 1`                       → `{ $sum: 1 }` (count documents)
//   `Math.max(acc, d.<field>)`     → `{ $max: "$<field>" }`
//   `Math.min(acc, d.<field>)`     → `{ $min: "$<field>" }`
//
// The `init` argument is required (JS-faithful — `.reduce` without an
// initial value is a footgun in JS too) but its specific value is unused
// in the `$group` lowering (MongoDB accumulators have their own neutral
// elements). Validated to be a literal so a stray `$.field` reference
// can't sneak through.
//
// Distinct from the existing `.reduce` chained terminal on
// `$$$.<coll>.find/filter(...)` chains (in `lookup-translation.ts`) —
// that one builds a `$reduce` expression over a materialised array slot.
// Different surface, different target operator, intentionally kept
// separate. `.reduce` is also explicitly NOT in `STREAM_METHODS` — the
// chain walker rejects it with an actionable wrap-pattern hint via
// `unknownStreamMethod`.

type ReduceAccumulator =
  | { kind: "sum"; value: string | number }
  | { kind: "max"; value: string }
  | { kind: "min"; value: string }
  | { kind: "first"; value: string }
  | { kind: "last"; value: string }
  | { kind: "push"; value: string };

export type ReduceWrapEntry = { key: string; accumulator: ReduceAccumulator; pos: number };

/**
 * Pattern-match an accumulator expression. The `isAccRef` predicate decides
 * what counts as the accumulator reference — for scalar reducers it's
 * `ParamRef(accParam)`; for object reducers (one accumulator per key) it's
 * `MemberAccess { object: ParamRef(accParam), member: key }`. Reusing one
 * matcher keeps the supported reducer shapes in lock-step across both forms.
 *
 * Recognised body shapes:
 *   - `<acc> + d.<path>`        →  $sum: "$<path>"
 *   - `<acc> + 1`                →  $sum: 1 (count)
 *   - `Math.max(<acc>, d.<path>)`→  $max: "$<path>"
 *   - `Math.min(<acc>, d.<path>)`→  $min: "$<path>"
 *   - `<acc> ?? d.<path>`        →  $first: "$<path>" (first non-null value)
 *   - `d.<path>` (acc-ignoring)  →  $last: "$<path>" (always-overwrite ⇒ last value)
 *   - `[...<acc>, d.<path>]`     →  $push: "$<path>"
 *   - `<acc>.concat(d.<path>)`   →  $push: "$<path>" (alt spelling)
 */
function classifyAccumulatorExpr(body: Expr, isAccRef: (e: Expr) => boolean, dParam: string): ReduceAccumulator | null {
  // $sum / count via `acc + ...`
  if (body.type === "BinaryExpr" && body.op === "+") {
    const otherSide = isAccRef(body.left) ? body.right : isAccRef(body.right) ? body.left : null;
    if (otherSide !== null) {
      if (otherSide.type === "NumberLiteral" && otherSide.value === 1) {
        return { kind: "sum", value: 1 };
      }
      const path = paramFieldPath(otherSide, dParam);
      if (path !== null) return { kind: "sum", value: `$${path}` };
    }
  }
  // $max / $min via Math.max(acc, d.<path>) / Math.min(acc, d.<path>)
  if (body.type === "MathCall" && (body.method === "max" || body.method === "min") && body.args.length === 2) {
    const [a0, a1] = body.args;
    if (a0.type === "SpreadElement" || a1.type === "SpreadElement") return null;
    const a0e = a0 as Expr;
    const a1e = a1 as Expr;
    const otherSide = isAccRef(a0e) ? a1e : isAccRef(a1e) ? a0e : null;
    if (otherSide !== null) {
      const path = paramFieldPath(otherSide, dParam);
      if (path !== null) return { kind: body.method, value: path };
    }
  }
  // $first via `acc ?? d.<path>` (or `acc.<key> ?? d.<path>` for object form).
  // JS-faithful: ?? returns LHS if LHS is non-null, else RHS. Across the
  // group, the accumulator stays at its initial value (null) until the first
  // non-null d.<path> arrives — exactly $first semantics.
  if (body.type === "BinaryExpr" && body.op === "??") {
    if (isAccRef(body.left)) {
      const path = paramFieldPath(body.right, dParam);
      if (path !== null) return { kind: "first", value: path };
    }
  }
  // $last via bare `d.<path>` — body doesn't reference acc at all, so every
  // doc overwrites; the final value wins, matching $last in MongoDB.
  {
    const path = paramFieldPath(body, dParam);
    if (path !== null) return { kind: "last", value: path };
  }
  // $push via `[...acc, d.<path>]` (single-element spread + push) OR
  // `acc.concat(d.<path>)` (method form).
  if (body.type === "ArrayLiteral" && body.elements.length === 2) {
    const [first, second] = body.elements;
    if (first.type === "SpreadElement" && isAccRef(first.argument) && second.type !== "SpreadElement") {
      // Reject update-op array elements (AssignExpr/DeleteStmt/LetDecl); only
      // Expr second elements are valid here.
      if (
        second.type === "AssignExpr" ||
        second.type === "DeleteStmt" ||
        second.type === "LetDecl" ||
        second.type === "FuncDecl"
      )
        return null;
      const path = paramFieldPath(second, dParam);
      if (path !== null) return { kind: "push", value: path };
    }
  }
  if (body.type === "MethodCall" && body.method === "concat" && body.args.length === 1) {
    if (isAccRef(body.object)) {
      const arg = body.args[0];
      if (arg.type !== "SpreadElement") {
        const path = paramFieldPath(arg, dParam);
        if (path !== null) return { kind: "push", value: path };
      }
    }
  }
  return null;
}

function classifyReduceBody(body: Expr, accParam: string, dParam: string): ReduceAccumulator | null {
  return classifyAccumulatorExpr(body, (e) => e.type === "ParamRef" && e.name === accParam, dParam);
}

type ObjectLiteralNode = Extract<Expr, { type: "ObjectLiteral" }>;

/**
 * Detect the wrap patterns that consume `$$.reduce(...)` back into the
 * stream. Two forms, both lowering to the same `$group` + `$replaceWith`
 * pair via `lowerReduceWrap`:
 *
 *   1. **Scalar wrap.** `$$ = [{ <key>: $$.reduce(…, <literal-init>), … }];`
 *      The inner array element is an object literal; each entry is a direct
 *      `$$.reduce(...)` call. One accumulator per entry.
 *
 *   2. **Object reducer.** `$$ = [$$.reduce((acc, d) => ({...acc, <key>: <expr>, ...}), { <key>: <init>, ... })];`
 *      The inner array element is the `$$.reduce(...)` call itself; the
 *      reducer body returns an object literal whose keys become the
 *      accumulator namespace. Each entry's value is pattern-matched the
 *      same way as the scalar form, except `acc` is referenced as
 *      `acc.<key>` (not bare `acc`).
 *
 * The array-returning reducer form (`$$ = [$$.reduce(... => acc.concat(...), [])]`)
 * is **not** handled here — its lowering is `$match` + `$replaceWith` rather
 * than `$group`-shaped, so it has its own detector / lowering pair
 * (`detectArrayReducerWrap` / `lowerArrayReducerWrap`).
 *
 * Returns `null` for non-matching shapes (the caller falls through to the
 * other RHS handlers, including the array-reducer detector). Throws for
 * matching-but-malformed shapes so the user sees a precise error instead of
 * a generic "RHS must be …".
 */
export function detectReduceWrap(value: Expr): ReduceWrapEntry[] | null {
  if (value.type !== "ArrayLiteral") return null;
  if (value.elements.length !== 1) return null;
  const el = value.elements[0];
  if (el.type === "ObjectLiteral") return detectScalarReduceWrap(el);
  if (el.type === "MethodCall" && el.method === "reduce" && el.object.type === "CollectionRef") {
    // An ArrayLiteral init means the user wants the array-returning reducer
    // form — let `detectArrayReducerWrap` handle it. (We could also throw
    // here with a more precise message, but the fall-through keeps the two
    // detectors decoupled: each one only commits to its shape when it sees
    // its own init type.)
    if (el.args.length === 2 && el.args[1].type === "ArrayLiteral") return null;
    return detectObjectReducerWrap(el);
  }
  return null;
}

function detectScalarReduceWrap(docEl: ObjectLiteralNode): ReduceWrapEntry[] | null {
  if (docEl.entries.length === 0) return null;
  // First pass: every entry must be `<staticKey>: $$.reduce(...)`.
  for (const entry of docEl.entries) {
    if (entry.type !== "KeyValueEntry") return null;
    if (entry.key.kind !== "static") return null;
    const ev = entry.value;
    if (ev.type !== "MethodCall") return null;
    if (ev.method !== "reduce") return null;
    if (ev.object.type !== "CollectionRef") return null;
  }
  // Second pass: validate and classify each reducer. (Throwing only happens
  // here so a near-miss shape — e.g. a single-doc array literal with one
  // non-reduce entry — falls through cleanly via the early `return null`s
  // above.)
  const out: ReduceWrapEntry[] = [];
  for (const entry of docEl.entries) {
    if (entry.type !== "KeyValueEntry" || entry.key.kind !== "static") continue;
    const ev = entry.value as Extract<Expr, { type: "MethodCall" }>;
    validateReduceCallBasics(ev);
    ensureLiteralInit(ev);
    const lambda = ev.args[0] as LambdaNode;
    const [accParam, dParam] = lambda.params;
    const body = lambda.body as Expr;
    const accumulator = classifyReduceBody(body, accParam, dParam);
    if (accumulator === null) {
      throw new CodegenError(
        `$$.reduce((${accParam}, ${dParam}) => …) v1 supports only these reducer shapes: ` +
          `'${accParam} + ${dParam}.<field>' (→ $sum), '${accParam} + 1' (→ $sum: 1, count), ` +
          `'Math.max(${accParam}, ${dParam}.<field>)' (→ $max), 'Math.min(${accParam}, ${dParam}.<field>)' (→ $min). ` +
          `Other shapes aren't supported yet — write the $group stage by hand.`,
        body.pos ?? ev.pos,
      );
    }
    out.push({ key: entry.key.name, accumulator, pos: entry.pos });
  }
  return out;
}

function detectObjectReducerWrap(reduceCall: Extract<Expr, { type: "MethodCall" }>): ReduceWrapEntry[] {
  validateReduceCallBasics(reduceCall);
  const lambda = reduceCall.args[0] as LambdaNode;
  const initArg = reduceCall.args[1];
  const [accParam, dParam] = lambda.params;
  const body = lambda.body as Expr;
  if (body.type !== "ObjectLiteral") {
    throw new CodegenError(
      `'$$ = [$$.reduce(...)]' requires the reducer to return an object literal — '(${accParam}, ${dParam}) => ({ ...${accParam}, <key>: <expr>, ... })'. ` +
        `For scalar reducers, use the object-wrap form instead: '$$ = [{ <key>: $$.reduce((acc, d) => …, <literal-init>) }];'.`,
      body.pos,
    );
  }
  if (initArg.type === "SpreadElement" || initArg.type !== "ObjectLiteral") {
    throw new CodegenError(
      `'$$ = [$$.reduce(<reducer>, <init>)]' with an object-returning reducer requires an object init that names each accumulator key — got '${initArg.type}'. Write '{ <key1>: <init1>, <key2>: <init2>, ... }' matching the keys returned by the reducer body.`,
      ("pos" in initArg ? initArg.pos : reduceCall.pos) as number,
    );
  }
  return classifyObjectReducer(reduceCall, body, initArg, accParam, dParam);
}

function classifyObjectReducer(
  reduceCall: Extract<Expr, { type: "MethodCall" }>,
  body: ObjectLiteralNode,
  init: ObjectLiteralNode,
  accParam: string,
  dParam: string,
): ReduceWrapEntry[] {
  // Body entries: optional leading `...accParam` spread, then static-keyed entries.
  const bodyEntries: { key: string; value: Expr; pos: number }[] = [];
  let seenNamedEntry = false;
  for (const entry of body.entries) {
    if (entry.type === "SpreadElement") {
      if (seenNamedEntry) {
        throw new CodegenError(
          `Object-reducer body's '...${accParam}' spread must be the first entry, not after named keys.`,
          entry.pos,
        );
      }
      const sp = entry.argument;
      if (sp.type !== "ParamRef" || sp.name !== accParam) {
        throw new CodegenError(
          `Object-reducer body may only spread the accumulator parameter ('...${accParam}'). Spreads of other expressions aren't supported in v1.`,
          entry.pos,
        );
      }
      continue;
    }
    seenNamedEntry = true;
    if (entry.key.kind !== "static") {
      throw new CodegenError(
        `Object-reducer body entry must have a static key. Computed keys ('[expr]: …') aren't supported in v1.`,
        entry.pos,
      );
    }
    bodyEntries.push({ key: entry.key.name, value: entry.value, pos: entry.pos });
  }
  if (bodyEntries.length === 0) {
    throw new CodegenError(
      `Object-reducer body must declare at least one '<key>: <reducer-expr>' entry (got an empty or spread-only object).`,
      body.pos,
    );
  }
  // Init keys.
  const initKeys = new Set<string>();
  for (const entry of init.entries) {
    if (entry.type !== "KeyValueEntry") {
      throw new CodegenError(
        `The init object passed to $$.reduce must be a literal '{ <key>: <init>, ... }' — spreads aren't supported in v1.`,
        entry.pos,
      );
    }
    if (entry.key.kind !== "static") {
      throw new CodegenError(`The init object's keys must be static (no computed '[expr]:' keys).`, entry.pos);
    }
    initKeys.add(entry.key.name);
  }
  // Body keys must match init keys exactly. (Asymmetric sets would mean
  // either an accumulator with no starting value or a starting value with
  // no per-doc update — both are user-side bugs in JS too.)
  const bodyKeys = new Set(bodyEntries.map((e) => e.key));
  const missingInInit = Array.from(bodyKeys).filter((k) => !initKeys.has(k));
  const missingInBody = Array.from(initKeys).filter((k) => !bodyKeys.has(k));
  if (missingInInit.length > 0 || missingInBody.length > 0) {
    const parts: string[] = [];
    if (missingInInit.length > 0) parts.push(`init is missing keys [${missingInInit.join(", ")}]`);
    if (missingInBody.length > 0) parts.push(`body is missing keys [${missingInBody.join(", ")}]`);
    throw new CodegenError(
      `Object-reducer body and init must declare the same keys (${parts.join("; ")}). Each key needs a starting value in init and a per-doc update in the body.`,
      reduceCall.pos,
    );
  }
  // Classify each body entry's value.
  const out: ReduceWrapEntry[] = [];
  for (const entry of bodyEntries) {
    const accumulator = classifyAccumulatorExpr(
      entry.value,
      (e) =>
        e.type === "MemberAccess" &&
        e.object.type === "ParamRef" &&
        e.object.name === accParam &&
        e.member === entry.key,
      dParam,
    );
    if (accumulator === null) {
      throw new CodegenError(
        `Object-reducer entry '${entry.key}: …' — v1 supports only: ` +
          `'${accParam}.${entry.key} + ${dParam}.<field>' (→ $sum), '${accParam}.${entry.key} + 1' (→ $sum: 1, count), ` +
          `'Math.max(${accParam}.${entry.key}, ${dParam}.<field>)' (→ $max), 'Math.min(${accParam}.${entry.key}, ${dParam}.<field>)' (→ $min). ` +
          `Each entry must reference '${accParam}.${entry.key}' as the accumulator side.`,
        entry.value.pos ?? entry.pos,
      );
    }
    out.push({ key: entry.key, accumulator, pos: entry.pos });
  }
  return out;
}

function validateReduceCallBasics(call: Extract<Expr, { type: "MethodCall" }>): void {
  if (call.args.length !== 2) {
    throw new CodegenError(
      `$$.reduce((acc, d) => <expr>, <init>) takes exactly two arguments (the reducer arrow and the initial value), got ${call.args.length}.`,
      call.pos,
    );
  }
  const [arg0, arg1] = call.args;
  if (arg0.type === "SpreadElement") {
    throw new CodegenError(`$$.reduce(...) does not accept spread arguments.`, arg0.pos);
  }
  if (arg1.type === "SpreadElement") {
    throw new CodegenError(`$$.reduce(...) does not accept spread arguments.`, arg1.pos);
  }
  if (arg0.type !== "Lambda") {
    throw new CodegenError(
      `$$.reduce((acc, d) => <expr>, <init>) requires an arrow function as the first argument.`,
      arg0.pos,
    );
  }
  if (arg0.params.length !== 2) {
    throw new CodegenError(
      `$$.reduce((acc, d) => <expr>, <init>) requires a two-parameter arrow '(acc, d) => …' (got ${arg0.params.length} params).`,
      arg0.pos,
    );
  }
  if (arg0.body === undefined) {
    throw new CodegenError(`$$.reduce(...) requires an expression body, not a block.`, arg0.pos);
  }
}

function ensureLiteralInit(call: Extract<Expr, { type: "MethodCall" }>): void {
  const arg1 = call.args[1] as Expr;
  const isLiteral =
    arg1.type === "NumberLiteral" ||
    arg1.type === "StringLiteral" ||
    arg1.type === "BooleanLiteral" ||
    arg1.type === "NullLiteral" ||
    arg1.type === "BigIntLiteral";
  if (!isLiteral) {
    throw new CodegenError(
      `$$.reduce((acc, d) => <scalar-expr>, <init>) — the initial value must be a literal (number, string, boolean, null) for the scalar wrap form. For object-returning reducers, use '$$ = [$$.reduce((acc, d) => ({ ...acc, ... }), { ... })];' instead.`,
      ("pos" in arg1 ? arg1.pos : call.pos) as number,
    );
  }
}

// ── Dictionary-build reducer wrap → $group + $replaceWith ────────────────────
//
// `$$ = [$$.reduce((acc, d) => ({ ...acc, [d.<keyPath>]: <d.<valPath>|d> }), {})];`
//
// The single-computed-key form of the object-returning reducer. Distinct from
// the static-key object-reducer (which the user names every accumulator at
// compile time) because here the *keys come from runtime data* — one input
// doc, one output entry, key/value both read off the doc. Lowers to:
//
//   [{ $group:       { _id: null, __jsmqlTmp: { $push: { k: "$<keyPath>", v: "$<valPath>"|"$$ROOT" } } } },
//    { $replaceWith: { $arrayToObject: "$__jsmqlTmp" } }]
//
// The leading `...acc` spread is supported (JS-faithful — that's how `{ ...acc, [k]: v }`
// is conventionally spelled in JS) but optional: `(acc, d) => ({ [d.k]: d.v })`
// works equally well. The init MUST be `{}` (empty object) — non-empty seeds
// have no MQL accumulator analogue. Mixed shapes (computed key + static key in
// the same body, e.g. `({ ...acc, [d.k]: d.v, count: acc.count + 1 })`) fall
// through to the existing object-reducer path, which will report the
// computed-key error there.

export type DictBuildWrap = {
  /** Path on `d` for the dict-entry key (e.g. "id" or "user.email"). */
  keyPath: string;
  /** Path on `d` for the dict-entry value, OR null when the value is the bare doc. */
  valuePath: string | null;
  /** Lambda position for actionable errors. */
  lambdaPos: number;
};

/**
 * Detect the dict-build wrap form. Returns null if the shape doesn't match
 * (so `detectReduceWrap` / `detectArrayReducerWrap` can have a turn);
 * returns a `DictBuildWrap` when it does match cleanly.
 *
 * Deliberately narrow: requires exactly one computed-key entry (plus optional
 * leading `...acc` spread), key path rooted on the `d` param, value path or
 * bare `d`, and `{}` init. Anything richer (multiple computed keys, mixed
 * static + computed, computed key reading from `acc`) is not this pattern
 * and either lands in the existing object-reducer path or surfaces a clear
 * error there.
 */
export function detectDictBuildWrap(value: Expr): DictBuildWrap | null {
  if (value.type !== "ArrayLiteral") return null;
  if (value.elements.length !== 1) return null;
  const el = value.elements[0];
  if (el.type !== "MethodCall" || el.method !== "reduce" || el.object.type !== "CollectionRef") return null;
  if (el.args.length !== 2) return null;
  const lambda = el.args[0];
  const init = el.args[1];
  if (lambda.type === "SpreadElement" || init.type === "SpreadElement") return null;
  if (lambda.type !== "Lambda" || lambda.params.length !== 2 || lambda.body === undefined) return null;
  if (init.type !== "ObjectLiteral" || init.entries.length !== 0) return null;
  const body = lambda.body;
  if (body.type !== "ObjectLiteral") return null;
  const [accParam, dParam] = lambda.params;
  // Walk entries: optional leading `...acc` spread, then exactly one
  // computed-key entry. Any other shape (static keys, second computed entry,
  // bare-value spreads) is not dict-build.
  let seenComputed = false;
  let result: DictBuildWrap | null = null;
  for (const entry of body.entries) {
    if (entry.type === "SpreadElement") {
      if (seenComputed) return null;
      if (entry.argument.type !== "ParamRef" || entry.argument.name !== accParam) return null;
      continue;
    }
    // KeyValueEntry
    if (seenComputed) return null;
    if (entry.key.kind !== "computed") return null;
    const keyPath = paramFieldPath(entry.key.expr, dParam);
    if (keyPath === null) return null;
    const valuePath = paramFieldOrBareParam(entry.value, dParam);
    if (valuePath === undefined) return null;
    result = { keyPath, valuePath, lambdaPos: lambda.pos };
    seenComputed = true;
  }
  return result;
}

/**
 * Bare `d` → null (lowering uses `$$ROOT`); `d.<path>` → "<path>".
 * Anything else returns `undefined` (caller bails to "not dict-build").
 */
function paramFieldOrBareParam(expr: Expr, param: string): string | null | undefined {
  if (expr.type === "ParamRef" && expr.name === param) return null;
  const path = paramFieldPath(expr, param);
  if (path !== null) return path;
  return undefined;
}

/**
 * Lower a detected dict-build wrap to the `$group` + `$replaceWith` pair.
 * Collects the `{k, v}` pairs into the flat `GROUP_TMP` slot (a `$group`
 * accumulator output key can't be dotted, so this is the namespace's
 * group-output exception — see namespace.ts); `$replaceWith` consumes it on
 * the very next stage, so it never reaches the developer's output.
 */
export function lowerDictBuildWrap(wrap: DictBuildWrap): object[] {
  const v: string = wrap.valuePath === null ? "$$ROOT" : `$${wrap.valuePath}`;
  return [
    { $group: { _id: null, [GROUP_TMP]: { $push: { k: `$${wrap.keyPath}`, v } } } },
    { $replaceWith: { $arrayToObject: `$${GROUP_TMP}` } },
  ];
}

/**
 * Emit the `$group` + `$replaceWith` pair for a detected `[{key: $$.reduce(…), …}]`
 * wrap. The `$group` collects every keyed accumulator under `_id: null`; the
 * trailing `$replaceWith` drops the `_id: null` field so the output stream is
 * a single doc with exactly the user-named keys.
 */
export function lowerReduceWrap(entries: readonly ReduceWrapEntry[]): object[] {
  const groupBody: Record<string, unknown> = { _id: null };
  const replaceBody: Record<string, unknown> = {};
  for (const entry of entries) {
    const acc = entry.accumulator;
    // Map accumulator kind to MQL operator and value form. `sum` is the only
    // kind that takes a non-`$<path>` value (`1` for the count form); every
    // other kind takes a `$<path>` field reference.
    const op =
      acc.kind === "sum"
        ? "$sum"
        : acc.kind === "max"
          ? "$max"
          : acc.kind === "min"
            ? "$min"
            : acc.kind === "first"
              ? "$first"
              : acc.kind === "last"
                ? "$last"
                : "$push";
    const v: string | number = acc.kind === "sum" ? acc.value : `$${acc.value}`;
    groupBody[entry.key] = { [op]: v };
    replaceBody[entry.key] = `$${entry.key}`;
  }
  return [{ $group: groupBody }, { $replaceWith: replaceBody }];
}

// ── Array-returning reducer wrap → $match (optional) + $replaceWith ───────────
//
// `$$ = [$$.reduce(<reducer>, [])];` — the third wrap form. Used when the
// reducer collapses the stream into a flat array of projected docs:
//
//   • Unconditional map:  '(acc, d) => acc.concat(d.<path>)'
//       → '[{$replaceWith: "$<path>"}]'   (each input doc becomes its sub-doc)
//
//   • Filter + map (ternary):  '(acc, d) => (cond ? acc.concat(d.<path>) : acc)'
//       → '[{$match: <cond translated>}, {$replaceWith: "$<path>"}]'
//
//   • Identity variants where `d` itself is concatted (bare param, no `.path`)
//     skip the `$replaceWith` — the docs flow through unchanged.
//
// The init MUST be `[]` (empty array) — non-empty initial arrays are rejected
// because no MQL accumulator preserves a JS-faithful "seed array" semantic.
// The body's `.concat(...)` argument must be a path on `d` (a sub-doc the
// stream will replace each input doc with) or bare `d` (identity, used for
// pure filter shapes).
//
// Distinct from the `$group`-shaped scalar/object wraps because the output
// is a doc-shaped stream of the projected fields, not a single summary doc.
// Detection commits at the init-is-empty-ArrayLiteral check; lowering lives
// in `pipeline.ts` so it can reuse `lowerStreamFilterPredicate` for the
// condition (same predicate translation `.filter` uses).

export type ArrayReducerProject = { kind: "field"; path: string } | { kind: "identity" };

export type ArrayReducerWrap = {
  /** Identity (`acc.concat(d)`) or field-path projection (`acc.concat(d.<path>)`). */
  project: ArrayReducerProject;
  /**
   * When present, the lowering emits a `$match` stage before the projection
   * using this expression as the predicate body. Translated through
   * `lowerStreamFilterPredicate` in pipeline.ts (same engine `.filter` uses).
   */
  condition: Expr | null;
  /** The reducer's per-doc parameter name (used to translate the condition). */
  dParam: string;
  /** Lambda position (for actionable errors). */
  lambdaPos: number;
};

/** `$$.reduce(<reducer>, [<...>])` — a reduce on the stream seeded with an array literal. */
function isArrayInitReduce(el: ArrayElement): el is Extract<Expr, { type: "MethodCall" }> {
  return (
    el.type === "MethodCall" &&
    el.method === "reduce" &&
    el.object.type === "CollectionRef" &&
    el.args.length === 2 &&
    el.args[1].type === "ArrayLiteral"
  );
}

/**
 * Detect `$$ = $$.reduce(<reducer>, [])` — the array-returning reducer form.
 * A reducer seeded with `[]` already returns an array, i.e. a stream, so it is
 * assigned **unbracketed**. Returns the classified `ArrayReducerWrap`, or null
 * for non-matching shapes (the caller falls through to other handlers).
 *
 * Throws for: the legacy **bracketed** form `$$ = [$$.reduce(…, [])]` (wrapping
 * a stream in `[ ]` yields `[[…]]` — nonsense; the throw points at the
 * unbracketed form); a non-empty seed array; and unrecognised reducer bodies.
 */
export function detectArrayReducerWrap(value: Expr): ArrayReducerWrap | null {
  // Legacy bracketed shape: detect it precisely and reject with a fix-it hint.
  // Everything else inside an array literal falls through to `null`.
  if (value.type === "ArrayLiteral") {
    if (value.elements.length !== 1) return null;
    if (!isArrayInitReduce(value.elements[0])) return null;
    throw new CodegenError(
      `A reducer seeded with '[]' already produces a stream, so don't wrap it in '[ ]' — assign it directly: '$$ = $$.reduce((acc, d) => …, [])'.`,
      value.pos,
    );
  }
  if (!isArrayInitReduce(value)) return null;
  const el = value;
  const initArg = el.args[1];
  // Past this point we commit — throw for malformed shapes.
  if (initArg.type === "ArrayLiteral" && initArg.elements.length !== 0) {
    throw new CodegenError(
      `'$$ = $$.reduce(<reducer>, <init>)' with an array-returning reducer requires the init to be '[]' — a non-empty seed array isn't supported (no MQL accumulator preserves the JS-faithful "start with these elements" semantic).`,
      initArg.pos,
    );
  }
  validateReduceCallBasics(el);
  const lambda = el.args[0] as LambdaNode;
  const [accParam, dParam] = lambda.params;
  const body = lambda.body as Expr;
  const classified = classifyArrayReducerBody(body, accParam, dParam);
  if (classified === null) {
    throw new CodegenError(
      `Array-returning reducer body — v1 supports only:\n` +
        `  • Unconditional map:  '(${accParam}, ${dParam}) => ${accParam}.concat(${dParam}.<field>)'  →  '$replaceWith: "$<field>"'\n` +
        `  • Filter + map:       '(${accParam}, ${dParam}) => (<cond> ? ${accParam}.concat(${dParam}.<field>) : ${accParam})'  →  '$match(<cond>) + $replaceWith: "$<field>"'\n` +
        `  • The '${dParam}' itself (bare param) instead of '${dParam}.<field>' projects the whole doc (no '$replaceWith').\n` +
        `Other shapes — '${accParam}.concat([${dParam}.<x>, ${dParam}.<y>])', '[...${accParam}, ${dParam}.<x>]', non-ternary branches — aren't supported yet.`,
      body.pos,
    );
  }
  return { ...classified, dParam, lambdaPos: lambda.pos };
}

function classifyArrayReducerBody(
  body: Expr,
  accParam: string,
  dParam: string,
): { project: ArrayReducerProject; condition: Expr | null } | null {
  // Filter + map: `<cond> ? <concat-call> : acc`
  if (body.type === "TernaryExpr") {
    if (body.alternate.type !== "ParamRef" || body.alternate.name !== accParam) return null;
    const project = classifyConcatCall(body.consequent, accParam, dParam);
    if (project === null) return null;
    return { project, condition: body.condition };
  }
  // Unconditional map: `<concat-call>`
  const project = classifyConcatCall(body, accParam, dParam);
  if (project !== null) return { project, condition: null };
  return null;
}

function classifyConcatCall(expr: Expr, accParam: string, dParam: string): ArrayReducerProject | null {
  if (expr.type !== "MethodCall") return null;
  if (expr.method !== "concat") return null;
  if (expr.object.type !== "ParamRef" || expr.object.name !== accParam) return null;
  if (expr.args.length !== 1) return null;
  const arg = expr.args[0];
  if (arg.type === "SpreadElement") return null;
  // Bare `d` — identity (no projection).
  if (arg.type === "ParamRef" && arg.name === dParam) return { kind: "identity" };
  // `d.<path>` — field-path projection.
  const path = paramFieldPath(arg, dParam);
  if (path !== null) return { kind: "field", path };
  return null;
}

// ── Registry ──────────────────────────────────────────────────────────────────

const STREAM_METHODS: Record<string, StreamMethodDef> = {
  slice: SLICE,
  concat: CONCAT,
  map: MAP,
  toSorted: TO_SORTED,
  toReversed: TO_REVERSED,
  flatMap: FLAT_MAP,
  // Note: `.reduce` is deliberately NOT in this registry. `arr.reduce(...)`
  // returns a scalar / object / array in JS depending on the reducer. A
  // scalar/object result must be wrapped into a stream-shaped RHS; an
  // array-returning reducer already IS a stream and is assigned unbracketed.
  // The chain walker's `unknownStreamMethod` helper special-cases `.reduce`
  // with an actionable hint, and the forms are implemented above:
  //   • `detectReduceWrap`         — scalar-into-object `$$ = [{ k: $$.reduce(…) }]` & object-returning `$$ = [$$.reduce(…, {})]` ($group + $replaceWith)
  //   • `detectArrayReducerWrap`   — array-returning `$$ = $$.reduce(…, [])`, unbracketed ($match + $replaceWith); the bracketed form throws
};

/** Look up a registered stream method by name; null if not registered. */
export function lookupStreamMethod(name: string): StreamMethodDef | null {
  return STREAM_METHODS[name] ?? null;
}

/** Names of all registered stream methods (for error messages). */
export function streamMethodNames(): readonly string[] {
  return Object.keys(STREAM_METHODS);
}

// ── Chain collection helper ───────────────────────────────────────────────────

export type MethodCallNode = Extract<Expr, { type: "MethodCall" }>;

export type StreamChain = {
  /** The receiver at the innermost end of the chain (CollectionRef, DatabaseRef-rooted member access, etc.). */
  root: Expr;
  /** Method calls in the order they apply (innermost first). */
  methods: MethodCallNode[];
};

/**
 * Walk an Expr that's expected to be a chain of `.method(...)` calls and
 * separate the innermost receiver from the chain. Always succeeds —
 * non-MethodCall input returns `{ root: expr, methods: [] }`. Callers
 * inspect `root.type` to decide whether the chain is rooted at a
 * legitimate stream/collection receiver.
 */
export function collectStreamChain(expr: Expr): StreamChain {
  const methods: MethodCallNode[] = [];
  let cur: Expr = expr;
  while (cur.type === "MethodCall") {
    methods.push(cur);
    cur = cur.object;
  }
  methods.reverse();
  return { root: cur, methods };
}
