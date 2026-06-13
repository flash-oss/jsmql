// Shared literal-gating helpers for compile-time validation.
//
// THE LITERAL-GATING INVARIANT: a validator may inspect only fully-static
// literal shapes. The moment a checked slot holds a field reference, an
// expression, an operator call, a template literal, a computed key, or a
// spread, the check must no-op and the MQL is emitted unchanged. We never throw
// on a value we cannot statically pin down — a *probable* violation must still
// compile. This is how comprehensive coverage coexists with "only 100%-certain
// throws".
//
// These helpers are consumed by BOTH validators that uphold that invariant:
//   - src/stage-validation.ts   — per-stage body shape (the elements of a pipeline)
//   - src/operator-validation.ts — per-operator argument shape (`$op(...)` calls)
// Keep them registry-agnostic: every entry takes a `stage`/`label` string so the
// same helper serves a stage name (`$group`) or an operator name (`$dateAdd`).
//
// See docs/specs/pipeline-validation.md and docs/specs/operator-validation.md.

import type { Expr } from "./ast.ts";
import { CodegenError } from "./codegen.ts";
import { closestNameTo } from "./levenshtein.ts";

// ── Literal-inspection helpers (the gate) ───────────────────────────────────────

/** The numeric value of `e` IF it is a literal number (incl. a unary `-` on one), else null. */
export function litNumber(e: Expr): number | null {
  if (e.type === "NumberLiteral") return e.value;
  if (e.type === "UnaryExpr" && e.op === "-" && e.operand.type === "NumberLiteral") return -e.operand.value;
  return null;
}

/** The string value of `e` IF it is a literal string, else null. */
export function litString(e: Expr): string | null {
  return e.type === "StringLiteral" ? e.value : null;
}

/** The boolean value of `e` IF it is a literal boolean, else null. */
export function litBool(e: Expr): boolean | null {
  return e.type === "BooleanLiteral" ? e.value : null;
}

/**
 * A human description IF `e` is a fully-static literal (scalar / array / object /
 * regex), else null — null means "a non-literal expression we can't judge".
 * Note: a negative number literal is a `UnaryExpr`, so it is NOT described here;
 * use `litNumber` for numeric slots.
 */
export function describeLiteral(e: Expr): string | null {
  switch (e.type) {
    case "NumberLiteral":
      return "a number";
    case "BigIntLiteral":
      return "a bigint";
    case "StringLiteral":
      return "a string";
    case "BooleanLiteral":
      return "a boolean";
    case "NullLiteral":
      return "null";
    case "ArrayLiteral":
      return "an array";
    case "ObjectLiteral":
      return "an object";
    case "RegexLiteral":
      return "a regular expression";
    default:
      return null;
  }
}

export type ObjectInfo = { byKey: Map<string, Expr>; hasSpread: boolean };

/**
 * Static view of an object-literal body: its static keys → value, plus whether
 * a spread is present. Returns null when `e` is not an object literal OR has a
 * computed key — in both cases we can't reason statically, so callers no-op.
 */
export function objectInfo(e: Expr): ObjectInfo | null {
  if (e.type !== "ObjectLiteral") return null;
  const byKey = new Map<string, Expr>();
  let hasSpread = false;
  for (const entry of e.entries) {
    if (entry.type === "SpreadElement") {
      hasSpread = true;
      continue;
    }
    if (entry.key.kind !== "static") return null;
    byKey.set(entry.key.name, entry.value);
  }
  return { byKey, hasSpread };
}

/** Literal elements of an array literal, or null if `e` isn't an array literal. */
export function arrayElements(e: Expr): Expr[] | null {
  if (e.type !== "ArrayLiteral") return null;
  const out: Expr[] = [];
  for (const el of e.elements) {
    // A spread / assignment inside the array → not a plain value list; bail.
    if (
      el.type === "SpreadElement" ||
      el.type === "AssignExpr" ||
      el.type === "DeleteStmt" ||
      el.type === "LetDecl" ||
      el.type === "FuncDecl"
    ) {
      return null;
    }
    out.push(el);
  }
  return out;
}

// ── Shared check helpers ────────────────────────────────────────────────────────

/** Require `keys` to be present on an object-literal body (skips if a spread hides them). */
export function requireKeys(stage: string, info: ObjectInfo, bodyPos: number, keys: readonly string[]): void {
  if (info.hasSpread) return;
  for (const k of keys) {
    if (!info.byKey.has(k)) {
      throw new CodegenError(`'${stage}' requires the '${k}' field, but it is missing.`, bodyPos);
    }
  }
}

/**
 * Open an object-body validator: return the body's key map, or `null` when the
 * body isn't an inspectable object literal (validation is best-effort — a field
 * path or runtime expression in body position is left for MongoDB to check), in
 * which case the caller `return`s. Any `required` keys are enforced up front.
 * Folds the `objectInfo` + null-gate + `requireKeys` prelude that opens most
 * object-shaped validators into one call.
 */
export function requireObjectBody(stage: string, body: Expr, required: readonly string[] = []): ObjectInfo | null {
  const info = objectInfo(body);
  if (info === null) return null;
  requireKeys(stage, info, body.pos, required);
  return info;
}

/** Throw if a literal-string slot value is outside the allowed enum (with a "Did you mean"). */
export function checkEnum(stage: string, field: string, value: Expr, allowed: readonly string[]): void {
  const s = litString(value);
  if (s === null || allowed.includes(s)) return;
  const near = closestNameTo(s, allowed);
  const hint = near !== null ? ` Did you mean '${near}'?` : "";
  throw new CodegenError(`'${stage}' ${field} must be one of: ${allowed.join(", ")} — got '${s}'.${hint}`, value.pos);
}

/**
 * A compile-bound param (`ParamRef`) inlines to a literal value at codegen, so a
 * constant-only slot can't statically rule it out. Everything else that isn't a
 * literal — a field ref or a runtime expression — is a certain violation.
 */
export function nonConstantDesc(e: Expr): string {
  return e.type === "FieldRef" ? "a field reference" : "a runtime expression";
}

/** Reject a non-constant in a slot the server requires to be a constant array (e.g. `$lookup.pipeline`). */
export function requireConstantArray(label: string, value: Expr): void {
  if (value.type === "ArrayLiteral" || value.type === "ParamRef") return;
  const desc = describeLiteral(value);
  throw new CodegenError(
    `'${label}' must be a constant array — got ${desc ?? nonConstantDesc(value)}, ` +
      `which the server can't accept here. Use a literal array.`,
    value.pos,
  );
}

/** Throw if a numeric slot holds a definitely-wrong literal (non-number, non-integer, or out of bound). */
export function checkIntBound(stage: string, body: Expr, opts: { min: number; label: string }): void {
  const n = litNumber(body);
  if (n === null) {
    const desc = describeLiteral(body);
    // A literal of a clearly-wrong type (string/array/object/…) throws.
    if (desc !== null) {
      throw new CodegenError(`'${stage}' expects an integer, but got ${desc}.`, body.pos);
    }
    // HR3 constant-only-slot exception: the server requires a constant integer
    // here, so a field ref / runtime expression is a certain violation. A param
    // inlines to a value, so it's allowed.
    if (body.type !== "ParamRef") {
      throw new CodegenError(
        `'${stage}' must be ${opts.label} and a compile-time constant — got ${nonConstantDesc(body)}, ` +
          `which the server can't accept here. Use a literal value.`,
        body.pos,
      );
    }
    return;
  }
  if (!Number.isInteger(n)) {
    throw new CodegenError(`'${stage}' must be an integer, but got ${n}.`, body.pos);
  }
  if (n < opts.min) {
    throw new CodegenError(`'${stage}' must be ${opts.label}, but got ${n}.`, body.pos);
  }
}
