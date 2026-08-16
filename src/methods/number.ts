// Number methods.
//
// `.round` / `.ceil` / `.floor` share one shape: MongoDB has a native operator for the
// zero-precision case, and precision is expressed by scaling. `.round` is the exception —
// `$round` takes the place directly.
//
// See docs/specs/lowering-grid.md.

import type { MethodDef } from "./types.ts";

/**
 * `.ceil([precision])` / `.floor([precision])`.
 *
 * `$ceil` / `$floor` take no precision, so a requested one is expressed by scaling:
 * divide(op(multiply(n, 10^p)), 10^p).
 */
function rounder(operator: "$ceil" | "$floor"): MethodDef {
  return {
    receiver: "number",
    returns: "number",
    args: { sig: "[precision]", allowed: [0, 1] },
    value: ({ recv, args, gen }) => {
      if (args.length === 0) return { [operator]: recv };
      const factor = { $pow: [10, gen(args[0])] };
      return { $divide: [{ [operator]: { $multiply: [recv, factor] } }, factor] };
    },
  };
}

export const NUMBER_METHODS: Record<string, MethodDef> = {
  // `$round` is half-to-EVEN (banker's rounding), which differs from JavaScript's
  // half-away-from-zero. MongoDB's behaviour wins: nobody writes a tie-breaking rule when
  // they write `.round()`. See SR2 in docs/LANG_RULES.md.
  round: {
    receiver: "number",
    returns: "number",
    args: { sig: "[precision]", allowed: [0, 1] },
    value: ({ recv, args, gen }) => ({ $round: [recv, args.length === 1 ? gen(args[0]) : 0] }),
  },

  ceil: rounder("$ceil"),
  floor: rounder("$floor"),

  inRange: {
    receiver: "number",
    returns: "bool",
    args: { sig: "[start, ]end", allowed: [1, 2] },
    // lodash: `.inRange(end)` is [0, end); `.inRange(start, end)` is [start, end). The
    // bounds swap when start > end, so a negative range still works — hence `$min`/`$max`
    // rather than using the arguments in the order they were written.
    value: ({ recv, args, gen }) => {
      const lo = args.length === 2 ? gen(args[0]) : 0;
      const hi = gen(args[args.length === 2 ? 1 : 0]);
      return { $and: [{ $gte: [recv, { $min: [lo, hi] }] }, { $lt: [recv, { $max: [lo, hi] }] }] };
    },
  },
};
