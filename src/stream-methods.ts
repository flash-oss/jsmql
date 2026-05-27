// Stream-method registry: the chainable JS array-method vocabulary that
// extends a `$$ = $$.<chain>;` or `$$ = $$$.<coll>.<chain>;` RHS into
// pipeline stages. One entry per method, each declaring its arg-shape
// validator and its lowering to MQL stages. Walked by pipeline.ts —
// adding a method here makes it usable in both stream contexts.
//
// See docs/specs/stream-methods.md for the design and the per-method
// shape/lowering/error table.

import type { CallArg, Expr } from "./ast.ts";
import { CodegenError, type GenerateCtx } from "./codegen.ts";

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
  lower: (args: readonly CallArg[], ctx: GenerateCtx, callPos: number) => StreamMethodResult;
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

// ── Registry ──────────────────────────────────────────────────────────────────

const STREAM_METHODS: Record<string, StreamMethodDef> = { slice: SLICE };

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
