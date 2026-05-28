// Stream-method registry: the chainable JS array-method vocabulary that
// extends a `$$ = $$.<chain>;` or `$$ = $$$.<coll>.<chain>;` RHS into
// pipeline stages. One entry per method, each declaring its arg-shape
// validator and its lowering to MQL stages. Walked by pipeline.ts —
// adding a method here makes it usable in both stream contexts.
//
// See docs/specs/stream-methods.md for the design and the per-method
// shape/lowering/error table.

import type { CallArg, Expr } from "./ast.ts";
import { CodegenError, generateWithCtx, type GenerateCtx } from "./codegen.ts";
import {
  extractLetsFromExpr,
  extractLookupCalls,
  type SlotAllocator,
  type SubPipelineLowerer,
} from "./lookup-translation.ts";
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
   * `allocSlot` allocates a fresh `__jsmql.__lookup<N>` slot from the
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
// `__jsmql.__lookup<N>` slot ahead of the `$replaceWith`. References to
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
    // outer-pipeline `let` bindings, so the v2-deferred let-coordination
    // case doesn't apply here.
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
// Zero-arg. Only valid immediately after `.toSorted(...)` in the same chain
// — MongoDB streams of documents have no natural ordering, so reversing
// requires a sort key. Lowering doesn't emit a new $sort stage: it rewrites
// the preceding one with all directions flipped (1 → -1, -1 → 1), so the
// total stage count stays equal to a hand-written descending `.toSorted`.
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
        `.toReversed() needs a preceding .toSorted(...) in the same chain — MongoDB streams have no natural document ordering. Either swap to '.toSorted((a, b) => b.<field> - a.<field>)' for descending directly, or chain after a '.toSorted(...)' call to invert it.`,
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
  | { kind: "min"; value: string };

export type ReduceWrapEntry = { key: string; accumulator: ReduceAccumulator; pos: number };

/**
 * Pattern-match an accumulator expression. The `isAccRef` predicate decides
 * what counts as the accumulator reference — for scalar reducers it's
 * `ParamRef(accParam)`; for object reducers (one accumulator per key) it's
 * `MemberAccess { object: ParamRef(accParam), member: key }`. Reusing one
 * matcher keeps the supported reducer shapes ($sum / $max / $min) in lock-step
 * across both forms.
 */
function classifyAccumulatorExpr(body: Expr, isAccRef: (e: Expr) => boolean, dParam: string): ReduceAccumulator | null {
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
 * Returns `null` for non-matching shapes (the caller falls through to the
 * other RHS handlers). Throws for matching-but-malformed shapes so the user
 * sees a precise error instead of a generic "RHS must be …".
 */
export function detectReduceWrap(value: Expr): ReduceWrapEntry[] | null {
  if (value.type !== "ArrayLiteral") return null;
  if (value.elements.length !== 1) return null;
  const el = value.elements[0];
  if (el.type === "ObjectLiteral") return detectScalarReduceWrap(el);
  if (el.type === "MethodCall" && el.method === "reduce" && el.object.type === "CollectionRef") {
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
    const op = entry.accumulator.kind === "sum" ? "$sum" : entry.accumulator.kind === "max" ? "$max" : "$min";
    const v: string | number =
      entry.accumulator.kind === "sum" ? entry.accumulator.value : `$${entry.accumulator.value}`;
    groupBody[entry.key] = { [op]: v };
    replaceBody[entry.key] = `$${entry.key}`;
  }
  return [{ $group: groupBody }, { $replaceWith: replaceBody }];
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
  // returns a scalar/object in JS, not an array; assigning it directly to
  // `$$` would break the "stream is always an array of docs" invariant.
  // The chain walker's `unknownStreamMethod` helper special-cases `.reduce`
  // with an actionable wrap-pattern hint, and `detectReduceWrap` (above)
  // implements the wrap form `$$ = [{ <key>: $$.reduce(…) }];`.
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
