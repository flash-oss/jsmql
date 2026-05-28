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
import { containsLookupCall, extractLetsFromExpr, type SubPipelineLowerer } from "./lookup-translation.ts";
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
  /** Produce the stages this method contributes. */
  lower: (
    args: readonly CallArg[],
    ctx: GenerateCtx,
    callPos: number,
    lowerBlock: SubPipelineLowerer,
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
// "use the lambda parameter" convention as `.filter`). Lookups and
// `$$.push` calls inside the body are rejected for v1 — hoist them above
// the chain.
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
  lower(args, ctx, _callPos, _lowerBlock) {
    const lambda = args[0] as LambdaNode;
    const param = lambda.params[0];
    const body = lambda.body as Expr;
    if (containsLookupCall(body, ctx)) {
      throw new CodegenError(
        `'$$$.<coll>.find/filter(...)' inside a '.map(d => …)' body isn't supported in v1 — hoist the lookup to a 'let' before the chain, then reference the bound name from the body.`,
        lambda.pos,
      );
    }
    if (containsUnionPush(body)) {
      throw new CodegenError(
        `'$$.push(...)' inside a '.map(d => …)' body isn't meaningful — '$$.push' is a statement-level form that emits '$unionWith' stages. Hoist it before the chain.`,
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
    const expr = generateWithCtx(rewritten, ctx);
    return { stages: [{ $replaceWith: expr }], clearLets: true };
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

// ── Registry ──────────────────────────────────────────────────────────────────

const STREAM_METHODS: Record<string, StreamMethodDef> = { slice: SLICE, concat: CONCAT, map: MAP, toSorted: TO_SORTED };

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
