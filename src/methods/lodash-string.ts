// lodash string methods — the case/word family.
//
// All ASCII-only, and all built from the same two primitives: split into words, then
// rejoin them with a separator and a per-word transform. Declaring them together makes
// that shared shape visible; in the switch it was nine `case` labels sharing one arity
// check and a nested switch.
//
// `.truncate` is NOT here: its options object needs literal-shape validation the
// declaration vocabulary cannot express yet. The ratchet counts it.
//
// See docs/specs/lowering-grid.md.

import { capitalizeExpr, escapeHtmlExpr, firstCharExpr, joinWords, wordsExpr } from "../mql-string.ts";
import type { MethodDef } from "./types.ts";

/** Every method here takes no arguments and returns a string. */
function stringOp(value: MethodDef["value"]): MethodDef {
  return { receiver: "string", returns: "string", args: { sig: "", none: true }, value };
}

export const LODASH_STRING_METHODS: Record<string, MethodDef> = {
  capitalize: stringOp(({ recv }) => capitalizeExpr(recv)),
  upperFirst: stringOp(({ recv }) => firstCharExpr(recv, "$toUpper")),
  lowerFirst: stringOp(({ recv }) => firstCharExpr(recv, "$toLower")),

  // Returns the word ARRAY rather than a string — the one exception in this family.
  words: { receiver: "string", returns: "array", args: { sig: "", none: true }, value: ({ recv }) => wordsExpr(recv) },

  kebabCase: stringOp(({ recv }) => ({ $toLower: joinWords(wordsExpr(recv), "-") })),
  snakeCase: stringOp(({ recv }) => ({ $toLower: joinWords(wordsExpr(recv), "_") })),
  startCase: stringOp(({ recv }) => joinWords(wordsExpr(recv), " ", capitalizeExpr)),

  camelCase: stringOp(({ recv, internalVar }) => {
    // Pascal-case first (capitalise each word, no separator), then lower the leading
    // character. The intermediate is bound so the join runs once rather than twice.
    const [vPascal, pascal] = internalVar("pascal");
    return {
      $let: {
        vars: { [vPascal]: joinWords(wordsExpr(recv), "", capitalizeExpr) },
        in: firstCharExpr(pascal, "$toLower"),
      },
    };
  }),

  escape: stringOp(({ recv }) => escapeHtmlExpr(recv)),
};
