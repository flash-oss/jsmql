// Per-operator argument validation.
//
// The mirror of src/stage-validation.ts, for value-position `$op(...)` calls.
// Catches operator-argument mistakes the MongoDB server always rejects — wrong
// operand counts, missing/unknown object keys, bad enum values, literal slots of
// a type the operator can never accept — and turns the opaque runtime server
// error into an actionable compile-time message.
//
// THE LITERAL-GATING INVARIANT (shared with stage-validation; helpers live in
// src/literal-gate.ts): every check inspects only fully-static literal shapes
// and no-ops the instant a slot is a field ref / op call / template literal /
// computed key / spread, so only 100%-certain violations throw. UNLIKE the
// stage validator, there is NO constant-only inversion here: operator argument
// slots legitimately accept runtime expressions, so a non-literal is NEVER a
// certain violation.
//
// Driven by the optional `args` (ArgRules) dimension on each OperatorDef plus
// the operator's `shape`. Called once from generateOperatorCall (codegen.ts)
// after assertNoSpread, before shape dispatch. See docs/specs/operator-validation.md.

import type { CallArg, Expr } from "./ast.ts";
import { checkArity, CodegenError } from "./codegen.ts";
import { didYouMean } from "./levenshtein.ts";
import { objectInfo } from "./literal-gate.ts";
import type { ArgRules } from "./operators.ts";
import { lookupOperator } from "./operators.ts";

/**
 * Validate an operator call's arguments against its shape + `args` rules.
 * No-op for unknown operators (forward-compat passthrough) and for any rule the
 * operator doesn't declare. Throws a `CodegenError` (with the offending node's
 * `.pos`) on a 100%-certain violation.
 */
export function validateOperatorArgs(name: string, style: "positional" | "object", args: CallArg[], pos: number): void {
  const def = lookupOperator(name);
  if (def === undefined) return; // unknown operator — codegen passes it through

  // ── none-shape: takes no arguments ──────────────────────────────────────────
  // Shape-driven (no `args` rule needed). The server ignores/​rejects operands
  // here; today codegen silently swallows them, hiding a real misconception
  // (the user thinks they pass a field).
  if (def.shape.kind === "none") {
    if (args.length === 0) return;
    if (def.category === "window") {
      // $rank / $denseRank / $documentNumber compute position from the window
      // ordering, not from an argument.
      throw new CodegenError(
        `${name}() takes no arguments, got ${args.length}. Its value is computed from the ` +
          `'$setWindowFields' sortBy ordering — set sortBy on the stage, don't pass a field.`,
        pos,
      );
    }
    checkArity(name, { sig: "", none: true }, args.length, pos, "");
    return;
  }

  const rules = def.args;
  if (rules === undefined) return;

  // ── object-shape: required / unknown keys ────────────────────────────────────
  // Only object-shape operators have named-key wire format; a `flex`/`single`
  // operator given a lone object literal treats it as a VALUE, not named keys.
  if (def.shape.kind === "object") {
    validateObjectKeys(name, def.shape.keys, rules, style, args, pos);
  }
}

/**
 * Validate the named keys of an object-shape operator call (both call styles):
 *   - object form `$op({ k: v })`  → keys come from the object literal
 *   - positional   `$op(a, b)`     → keys come from `shape.keys` in order
 * Enforces `required` (missing-key) and — for the object form, where keys are
 * user-written — the closed-key set (`required ∪ optional`, unless
 * `closedKeys: false`) with a `didYouMean` suggestion. A spread in the object
 * body suppresses both checks (the missing/extra key might be in the spread).
 */
function validateObjectKeys(
  name: string,
  shapeKeys: readonly string[],
  rules: ArgRules,
  style: "positional" | "object",
  args: CallArg[],
  pos: number,
): void {
  const required = rules.required ?? [];
  if (required.length === 0 && (rules.optional ?? []).length === 0) return;

  let presentKeys: readonly string[];
  let hasSpread = false;
  let posOf: ((k: string) => number) | null = null;

  if (style === "object") {
    const info = objectInfo(args[0] as Expr); // parser guarantees args[0] is an object literal here
    if (info === null) return; // computed key / non-object → gate no-op
    presentKeys = [...info.byKey.keys()];
    hasSpread = info.hasSpread;
    posOf = (k) => info.byKey.get(k)?.pos ?? pos;
  } else {
    // Positional: codegen maps args[i] → shapeKeys[i], so the present keys are
    // the leading `args.length` names. (No spread, no unknown keys possible.)
    presentKeys = shapeKeys.slice(0, args.length);
  }

  const closedSet = [...required, ...(rules.optional ?? [])];

  // Unknown-key FIRST (object form only — positional keys come from the registry
  // and are always valid). Checking before required-keys means a typo'd required
  // key (`iff` for `if`) is reported as the unknown key with a `didYouMean`
  // suggestion, not as a confusing "requires 'if'" on a key the user thought
  // they supplied. A spread might legitimise an out-of-set key, so skip then.
  if (style === "object" && !hasSpread && rules.closedKeys !== false) {
    for (const k of presentKeys) {
      if (!closedSet.includes(k)) {
        throw new CodegenError(
          `'${name}' has no parameter '${k}'.${didYouMean(k, closedSet, (s) => s)} ` +
            `Valid keys: ${closedSet.join(", ")}.`,
          posOf!(k),
        );
      }
    }
  }

  // Required-keys (a spread might supply a missing one — skip then).
  if (!hasSpread) {
    for (const k of required) {
      if (!presentKeys.includes(k)) {
        throw new CodegenError(`'${name}' requires the '${k}' field, but it is missing.`, pos);
      }
    }
  }
}
