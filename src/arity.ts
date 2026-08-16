// Argument-count rules, and the single place every count error is worded.
//
// A LEAF: it imports only `errors.ts`. Counting arguments is not a compiler service, and
// keeping it in `codegen.ts` forced every validator that merely checks an arity to depend
// on the whole compiler — closing a cycle for the modules `codegen.ts` imports back.
//
// ONE rule type, read by everything: the method grid's declarations, the `$op(...)`
// operator validator, the stage validators, and the static-call families. A second copy of
// this shape beside a second copy of the checker is exactly the drift the grid exists to
// remove.
//
// See docs/specs/lowering-grid.md.

import { CodegenError } from "./errors.ts";

/**
 * The one argument rule. Exactly one of `exact` / `allowed` / `atLeast` / `none` is set.
 *
 * `sig` is the parameter signature shown in the error — `"start[, count]"` renders as
 * `.substr(start[, count])`; `""` renders the bare `.toReversed()`. It is read by the
 * compile-time check AND by the TypeScript signature generator, because a signature written
 * by hand beside a check written by hand is two statements of one fact, and two statements
 * drift.
 */
export type MethodArgs = {
  sig: string;
  exact?: number;
  allowed?: readonly number[];
  atLeast?: number;
  none?: true;
  /**
   * Counts that parse fine but are wrong for a REASON, paired with the message that reason
   * deserves. Checked before the count rule, so `.isSame(other)` can answer "without a unit
   * that is just '===' — write 'a === b'" instead of "requires 2 or 3 arguments".
   *
   * The same principle as an `unsupported` cell: where jsmql refuses, the answer IS the
   * message, and burying it behind a generic count complaint wastes the one chance to say
   * what to write instead.
   */
  reject?: Readonly<Record<number, string>>;
};

/**
 * Validate `count` against `spec` and throw `<prefix><method>(<sig>) <quantity-clause>,
 * got <N>` on mismatch — `.charAt(index) requires exactly 1 argument, got 0`,
 * `.slice(start[, end]) requires 0, 1, or 2 arguments, got 3`, `Math.hypot(...values)
 * requires at least 1 argument, got 0`.
 *
 * The trailing `, got <N>` tells the user exactly what they passed. The caller passes the
 * count it validates (`exprArgs.length` for most; the raw `args.length` for the few that
 * count spread args). `prefix` is `"."` for instance methods (the default) or
 * `"Math."` / `"Object."` / `"Set."` / `"regex."` for the static families.
 */
export function checkArity(
  method: string,
  spec: MethodArgs,
  count: number,
  callPos: number,
  prefix: string = ".",
): void {
  const tailored = spec.reject?.[count];
  if (tailored !== undefined) throw new CodegenError(tailored, callPos);
  const ok =
    spec.none !== undefined
      ? count === 0
      : spec.exact !== undefined
        ? count === spec.exact
        : spec.allowed !== undefined
          ? spec.allowed.includes(count)
          : count >= spec.atLeast!;
  if (ok) return;
  let quantity: string;
  if (spec.none !== undefined) {
    quantity = "takes no arguments";
  } else if (spec.exact !== undefined) {
    quantity = `requires exactly ${spec.exact} argument${spec.exact === 1 ? "" : "s"}`;
  } else if (spec.allowed !== undefined) {
    quantity = `requires ${formatCountList(spec.allowed)} arguments`;
  } else {
    quantity = `requires at least ${spec.atLeast} argument${spec.atLeast === 1 ? "" : "s"}`;
  }
  throw new CodegenError(`${prefix}${method}(${spec.sig}) ${quantity}, got ${count}`, callPos);
}

/** Render an allowed-count list the way the messages read: `[1,2]` → "1 or 2",
 *  `[0,1,2]` → "0, 1, or 2". */
function formatCountList(ns: readonly number[]): string {
  if (ns.length === 2) return `${ns[0]} or ${ns[1]}`;
  return `${ns.slice(0, -1).join(", ")}, or ${ns[ns.length - 1]}`;
}
