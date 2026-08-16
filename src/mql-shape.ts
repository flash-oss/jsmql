// Pure MQL shape-builders and literal readers.
//
// A LEAF: it imports only `ast.ts` types. That is what lets `codegen.ts` and the method
// families in `src/methods/` both use it — a family file that reached back into
// `codegen.ts` would make the two mutually dependent, and the registry would then assemble
// before the family initialised, silently dropping every method in it.
//
// Everything here takes an ALREADY-LOWERED value (or a literal AST node) and returns MQL
// or a plain JS value. None of it needs a `GenerateCtx`, which is exactly why it can live
// at this level.
//
// See docs/specs/lowering-grid.md § Where declarations live.

import type { Expr } from "./ast.ts";

/**
 * Emit a `$cond` in MongoDB's object form `{ if, then, else }` rather than the positional
 * array. Both are valid MQL, but the named-key form is far easier to read in emitted
 * output — a DX win for anyone inspecting what jsmql produced. Every internal `$cond`
 * jsmql emits goes through here.
 */
export function cond(
  ifExpr: unknown,
  thenExpr: unknown,
  elseExpr: unknown,
): { $cond: { if: unknown; then: unknown; else: unknown } } {
  return { $cond: { if: ifExpr, then: thenExpr, else: elseExpr } };
}

/** True when `value` is already an `$ifNull` wrap (e.g. an optional-chain receiver). */
export function isIfNullWrapped(value: unknown): boolean {
  return typeof value === "object" && value !== null && "$ifNull" in value && Object.keys(value).length === 1;
}

export function wrapIfNull(value: unknown, fallback: unknown): unknown {
  return { $ifNull: [value, fallback] };
}

/**
 * Coerce a receiver to a string ONCE, at its binding.
 *
 * `$strLenCP` aborts the query on a missing input where `$indexOfCP` returns null and
 * `$substrCP` returns "". Without this, `.endsWith()` on an absent field would take a
 * query down while the same predicate spelled `.startsWith()` simply returned false.
 */
export function coerceStringBinding(genObj: unknown): unknown {
  return isIfNullWrapped(genObj) ? genObj : wrapIfNull(genObj, "");
}

/**
 * Floor an already-generated index or length at 0, folding when known.
 *
 * `$substrCP` rejects a negative start (`Location34455`) and a negative length
 * (`Location34454`) outright — it aborts the whole query rather than returning a value —
 * so every index/length jsmql *derives* (rather than passes through from a literal) goes
 * through here. `$max` ignores nulls, so a floored value stays safe on a missing receiver.
 */
export function clampNonNegative(value: unknown): unknown {
  if (typeof value === "number") return Math.max(0, value);
  return { $max: [0, value] };
}

/** Subtract `b` from `a`, folding when both operands are numeric literals. */
export function foldedSubtract(a: unknown, b: unknown): unknown {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return { $subtract: [a, b] };
}

/**
 * True when a generated value is a source string literal exactly one code point long.
 * Repeating such a pad N times lands on exactly N characters, so a padding lowering can
 * skip its trim. Per HR1 a `$`-prefixed source string is a field reference, never a
 * literal — its length is unknown at compile time.
 */
export function isSingleCodePointLiteral(value: unknown): boolean {
  return typeof value === "string" && !value.startsWith("$") && [...value].length === 1;
}

/**
 * Keep only the regex flags MongoDB accepts (`imsx`), dropping JS-only ones (`g`, `y`,
 * `u`, `d`). The server rejects an unknown flag outright, so passing them through would
 * turn a working JS regex into a failed query.
 */
export function mongoRegexOptions(jsFlags: string): string {
  let out = "";
  for (const ch of jsFlags) if ("imsx".includes(ch) && !out.includes(ch)) out += ch;
  return out;
}

/**
 * Lower an argument expression. The one thing an index resolver needs from the compiler,
 * and the reason these helpers can live at leaf level: they take the FUNCTION, not the
 * `GenerateCtx` that carries it.
 */
export type Gen = (node: Expr) => unknown;

/**
 * Clamp a string-index AST node to non-negative, matching JS `.substring`
 * semantics where negative arguments are treated as 0. Folds at compile time
 * when the node is a literal number (or unary-minus of one); otherwise wraps
 * the generated value in `$max:[0, …]` so the runtime sees a non-negative
 * index.
 */
export function clampNonNegativeIndex(node: Expr, gen: Gen): unknown {
  if (node.type === "NumberLiteral") return Math.max(0, node.value);
  if (node.type === "UnaryExpr" && node.op === "-" && node.operand.type === "NumberLiteral") {
    return Math.max(0, -node.operand.value);
  }
  return { $max: [0, gen(node)] };
}

/**
 * JS-resolve a `.slice` index against the array length `size`, mirroring the
 * `k`/`final` clamping in the ECMAScript `Array.prototype.slice` algorithm:
 * a negative index counts from the end (`size + i`, floored at 0); a positive
 * one clamps up to `size`. Literals fold to plain `$min`/`$max`; a runtime
 * index expands to a `$cond` that picks the branch at runtime.
 */
export function resolveSliceIndex(node: Expr, gen: Gen, size: unknown): unknown {
  const lit = literalIndexValue(node);
  if (lit !== null) {
    if (lit === 0) return 0;
    if (lit > 0) return { $min: [lit, size] };
    return { $max: [{ $subtract: [size, -lit] }, 0] };
  }
  const g = gen(node);
  return { $cond: [{ $lt: [g, 0] }, { $max: [{ $add: [g, size] }, 0] }, { $min: [g, size] }] };
}

/**
 * Signed integer value of a slice-index literal (`5` or `-5`), else null — a runtime
 * expression, or a non-integer literal jsmql does not fold.
 */
export function literalIndexValue(node: Expr): number | null {
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

/** Negate an already-generated number, folding when it is a literal. */
export function negate(n: unknown): unknown {
  return typeof n === "number" ? -n : { $subtract: [0, n] };
}

/** True when a source node is a negative numeric literal (`-5`, written either way). */
export function isNegativeLiteral(e: Expr): boolean {
  if (e.type === "NumberLiteral") return e.value < 0;
  if (e.type === "UnaryExpr" && e.op === "-" && e.operand.type === "NumberLiteral") {
    return e.operand.value > 0;
  }
  return false;
}

/**
 * Reject a count argument that is a literal but not a whole number >= `min`.
 *
 * LITERAL-GATED: a runtime expression passes silently, because only the server can judge
 * it. A fraction is what this exists for — `$slice` aborts the whole query on one, and a
 * `.take(1.5)` that compiled would fail at query time rather than at the keyboard.
 */
export function requireIntCount(
  method: string,
  sig: string,
  arg: Expr | undefined,
  min: number,
  err: (message: string, pos?: number) => Error,
): void {
  if (arg === undefined || arg.type !== "NumberLiteral") return;
  if (!Number.isInteger(arg.value)) {
    throw err(`.${method}(${sig}) needs a whole number, but got ${arg.value}.`, arg.pos);
  }
  if (arg.value < min) {
    throw err(`.${method}(${sig}) needs an integer >= ${min}, but got ${arg.value}.`, arg.pos);
  }
}
