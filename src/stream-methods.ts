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
  containsLookupCall,
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
// the top-level `$$` chain context: the body is post-processed through
// `extractLookupCalls` to materialise each lookup into an
// `__jsmql.__lookup<N>` slot ahead of the `$replaceWith`. References to
// the outer doc (`d.<field>`) get rewritten to bare field paths via
// `extractLetsFromExpr` BEFORE the lookup extractor runs, so the lookup
// predicate's `extractLetsFromExpr` (called from inside
// `translatePredicate`) sees those as `$.<field>` and hoists them to
// `$lookup.let` slots — basic-form is preferred when the predicate is a
// single `===` between matching paths. In the lookup-body context
// (`$$$.<coll>.filter(p).map(...)`), an embedded lookup would land inside
// a `$unionWith.pipeline` — a nested lookup, which jsmql defers to v2
// across the codebase. That case is rejected with the standard
// "hoist to sibling stage" message.
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
  lower(args, ctx, _callPos, lowerBlock, _prevStages, allocSlot, inSubPipeline) {
    const lambda = args[0] as LambdaNode;
    const param = lambda.params[0];
    const body = lambda.body as Expr;
    if (containsUnionPush(body)) {
      throw new CodegenError(
        `'$$.push(...)' inside a '.map(d => …)' body isn't meaningful — '$$.push' is a statement-level form that emits '$unionWith' stages. Hoist it before the chain.`,
        lambda.pos,
      );
    }
    if (inSubPipeline && containsLookupCall(body, ctx)) {
      throw new CodegenError(
        `'$$$.<coll>.find/filter(...)' inside a '.map(d => …)' body of a '$$$.<coll>.<chain>' RHS would emit a nested '$lookup' inside a '$unionWith.pipeline' — nested lookups are deferred to v2. Hoist the inner lookup to a sibling stage in the outer pipeline.`,
        lambda.pos,
      );
    }
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

// ── .reduce((acc, d) => …, <init>) on $$ → $group { _id: null, … } ────────────
//
// Folds the document stream down to a single doc carrying the aggregate.
// Output shape: `{ _id: null, value: <aggregate> }`. Pattern-matches the
// reducer body to one of MongoDB's accumulator operators:
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
// separate.

type ReduceAccumulator =
  | { kind: "sum"; value: string | number }
  | { kind: "max"; value: string }
  | { kind: "min"; value: string };

function classifyReduceBody(body: Expr, accParam: string, dParam: string): ReduceAccumulator | null {
  if (body.type === "BinaryExpr" && body.op === "+") {
    const accSide = body.left.type === "ParamRef" && body.left.name === accParam ? body.right : null;
    const otherSide =
      accSide === null && body.right.type === "ParamRef" && body.right.name === accParam ? body.left : accSide;
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
    const otherSide =
      a0.type === "ParamRef" && a0.name === accParam ? a1 : a1.type === "ParamRef" && a1.name === accParam ? a0 : null;
    if (otherSide !== null) {
      const path = paramFieldPath(otherSide, dParam);
      if (path !== null) return { kind: body.method, value: path };
    }
  }
  return null;
}

const REDUCE: StreamMethodDef = {
  name: "reduce",
  validate(args, callPos) {
    if (args.length !== 2) {
      throw new CodegenError(
        `.reduce((acc, d) => <expr>, <init>) takes exactly two arguments (the reducer arrow and the initial value), got ${args.length}.`,
        callPos,
      );
    }
    const [arg0, arg1] = args;
    if (arg0.type === "SpreadElement") {
      throw new CodegenError(`.reduce(...) does not accept spread arguments.`, arg0.pos);
    }
    if (arg1.type === "SpreadElement") {
      throw new CodegenError(`.reduce(...) does not accept spread arguments.`, arg1.pos);
    }
    if (arg0.type !== "Lambda") {
      throw new CodegenError(
        `.reduce((acc, d) => <expr>, <init>) requires an arrow function as the first argument.`,
        arg0.pos,
      );
    }
    if (arg0.params.length !== 2) {
      throw new CodegenError(
        `.reduce((acc, d) => <expr>, <init>) requires a two-parameter arrow '(acc, d) => …' (got ${arg0.params.length} params).`,
        arg0.pos,
      );
    }
    if (arg0.body === undefined) {
      throw new CodegenError(`.reduce(...) requires an expression body, not a block.`, arg0.pos);
    }
    // The init must be a literal — anything else (field refs, computed expressions)
    // would suggest the user expects per-doc state, which $group can't provide.
    const isLiteral =
      arg1.type === "NumberLiteral" ||
      arg1.type === "StringLiteral" ||
      arg1.type === "BooleanLiteral" ||
      arg1.type === "NullLiteral" ||
      arg1.type === "BigIntLiteral";
    if (!isLiteral) {
      throw new CodegenError(
        `.reduce((acc, d) => …, <init>) — the initial value must be a literal (number, string, boolean, null). Computed initial values aren't supported when reducing a document stream (MongoDB's $group accumulators have fixed neutral elements).`,
        ("pos" in arg1 ? arg1.pos : callPos) as number,
      );
    }
  },
  lower(args, _ctx, callPos, _lowerBlock, _prevStages) {
    const lambda = args[0] as LambdaNode;
    const [accParam, dParam] = lambda.params;
    const body = lambda.body as Expr;
    const accumulator = classifyReduceBody(body, accParam, dParam);
    if (accumulator === null) {
      throw new CodegenError(
        `.reduce((${accParam}, ${dParam}) => …) v1 supports only these reducer shapes: ` +
          `'${accParam} + ${dParam}.<field>' (→ $sum), '${accParam} + 1' (→ $sum: 1, count), ` +
          `'Math.max(${accParam}, ${dParam}.<field>)' (→ $max), 'Math.min(${accParam}, ${dParam}.<field>)' (→ $min). ` +
          `Other shapes aren't supported yet — write the $group stage by hand.`,
        body.pos ?? callPos,
      );
    }
    const op = accumulator.kind === "sum" ? "$sum" : accumulator.kind === "max" ? "$max" : "$min";
    const value: string | number = accumulator.kind === "sum" ? accumulator.value : `$${accumulator.value}`;
    return { stages: [{ $group: { _id: null, value: { [op]: value } } }], clearLets: true };
  },
};

// ── Registry ──────────────────────────────────────────────────────────────────

const STREAM_METHODS: Record<string, StreamMethodDef> = {
  slice: SLICE,
  concat: CONCAT,
  map: MAP,
  toSorted: TO_SORTED,
  toReversed: TO_REVERSED,
  flatMap: FLAT_MAP,
  reduce: REDUCE,
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
