// One declaration per JS method — the grid's unit.
//
// A declaration states what the method IS and how it lowers into each MQL language that
// can reach it. Nothing about a method lives anywhere else: the arity check, the literal
// type gate and the generated TypeScript signature all read the same `args` rule, so the
// editor cannot disagree with the compiler.
//
// Applicability is derived from `receiver`. A string receiver never has a Stage cell,
// because the stream is a sequence of documents and not a string. Every cell that IS
// applicable must carry a lowering or `unsupported(reason)` — an unanswered applicable
// cell fails the build.
//
// See docs/specs/lowering-grid.md.

import type { Expr } from "../ast.ts";

/** The receiver family a method requires. Decides which cells are applicable. */
export type ReceiverFamily = "string" | "array" | "number" | "date" | "object";

/** The result type, where it is invariant. Drives inference and the chain type-check. */
export type MethodReturns = "string" | "array" | "bool" | "number" | "object" | "date";

/**
 * The one argument rule. Read by the compile-time arity check AND by the TypeScript
 * signature generator — a signature written by hand beside a check written by hand is
 * two statements of one fact, and two statements drift.
 */
export type MethodArgs = {
  /** How the arguments read in an error message, e.g. `"start[, end]"`. */
  sig: string;
  exact?: number;
  allowed?: readonly number[];
  atLeast?: number;
  none?: true;
};

/** What a lowering receives: the generated receiver, the raw argument nodes, and services. */
export type LowerInput = {
  /** The receiver, already lowered. */
  recv: unknown;
  /** Argument AST nodes — a lowering that needs a value calls `gen`. */
  args: readonly Expr[];
  /** Lower an argument expression. */
  gen: (e: Expr) => unknown;
  /** Source offset of the call, for errors. */
  pos: number;
  /**
   * Mint a MongoDB variable name that cannot capture a user parameter, gensymmed against
   * the live scope. Returns `[name, "$$name"]`. Every emitted variable name comes from
   * here — never a string literal. See src/namespace.ts.
   *
   * This is a SERVICE, not a context bag. Add another only when a lowering genuinely
   * cannot be written without it; `LowerInput` turning into a grab-bag is the failure
   * `GenerateCtx` already demonstrated.
   */
  internalVar: (base: string) => [string, string];
};

/** A cell that cannot exist, with the reason a user reads. */
export type Unsupported = { unsupported: string };

export function unsupported(reason: string): Unsupported {
  return { unsupported: reason };
}

export function isUnsupported(cell: unknown): cell is Unsupported {
  return typeof cell === "object" && cell !== null && "unsupported" in cell;
}

export type ValueCell = (input: LowerInput) => unknown;

export type MethodDef = {
  receiver: ReceiverFamily;
  returns?: MethodReturns;
  args: MethodArgs;
  /** The Expr cell. Always applicable — every method produces a value somewhere. */
  value: ValueCell | Unsupported;
};

/**
 * Which cells a receiver family can have.
 *
 * The stream is a sequence of documents, so only an array receiver can have a Stage
 * cell — every other family's Stage cell is not "unanswered", it cannot exist.
 */
export function stageCellApplies(receiver: ReceiverFamily): boolean {
  return receiver === "array";
}
