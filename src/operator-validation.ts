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

import type { CallArg } from "./ast.ts";
import { checkArity, CodegenError } from "./codegen.ts";
import { lookupOperator } from "./operators.ts";

/**
 * Validate an operator call's arguments against its shape + `args` rules.
 * No-op for unknown operators (forward-compat passthrough) and for any rule the
 * operator doesn't declare. Throws a `CodegenError` (with the offending node's
 * `.pos`) on a 100%-certain violation.
 */
export function validateOperatorArgs(
  name: string,
  _style: "positional" | "object",
  args: CallArg[],
  pos: number,
): void {
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
}
