// String methods — the self-contained half of the family.
//
// A declaration here owns its arity rule, and dispatch always applies it. That alone
// fixed a real gap: `.trim("x")` and `.toLowerCase(1)` used to compile and silently
// discard the argument, because the switch arm returned without checking. A method
// cannot skip its own rule when the rule and the lowering are the same object.
//
// NOT YET HERE, and why: `.substr`, `.substring`, `.charAt`, `.startsWith`, `.endsWith`,
// `.replace`, `.replaceAll`, `.match`, `.matchAll`, `.search`, `.padStart`, `.padEnd`
// and the lodash string family reach into codegen internals a declaration cannot see
// yet — `internalVar` for gensymmed bindings, the negative-index normalisers, the
// string-coercion helper. They stay in the switch until `LowerInput` carries those
// services. The ratchet in `test/methods-grid.test.ts` counts them.
//
// See docs/specs/lowering-grid.md.

import type { MethodDef } from "./types.ts";

/**
 * `.trim()` and friends: one operator each, no arguments.
 *
 * The `none: true` arity rule is what rejects `.trim("x")` — the switch arm this replaces
 * returned without checking, so the argument was silently discarded. (MQL's trim operators
 * DO take a `chars` option; the JavaScript methods do not, so it is reachable only through
 * the operator form, `$trim({ input, chars })`.)
 */
function trimmer(operator: string): MethodDef {
  return {
    receiver: "string",
    returns: "string",
    args: { sig: "", none: true },
    value: ({ recv }) => ({ [operator]: { input: recv } }),
  };
}

/** `.toLowerCase()` / `.toUpperCase()`: one operator each, applied to the receiver. */
function caseMapper(operator: string): MethodDef {
  return {
    receiver: "string",
    returns: "string",
    args: { sig: "", none: true },
    value: ({ recv }) => ({ [operator]: recv }),
  };
}

export const STRING_METHODS: Record<string, MethodDef> = {
  trim: trimmer("$trim"),
  trimStart: trimmer("$ltrim"),
  trimLeft: trimmer("$ltrim"),
  trimEnd: trimmer("$rtrim"),
  trimRight: trimmer("$rtrim"),

  toLowerCase: caseMapper("$toLower"),
  toUpperCase: caseMapper("$toUpper"),

  split: {
    receiver: "string",
    // Returns an array, but the RECEIVER is a string — the two are independent.
    returns: "array",
    args: { sig: "separator", exact: 1 },
    value: ({ recv, args, gen }) => ({ $split: [recv, gen(args[0])] }),
  },

  repeat: {
    receiver: "string",
    returns: "string",
    args: { sig: "count", exact: 1 },
    // No `$repeat` operator exists: concatenate the receiver once per index.
    value: ({ recv, args, gen }) => ({
      $reduce: { input: { $range: [0, gen(args[0])] }, initialValue: "", in: { $concat: ["$$value", recv] } },
    }),
  },
};
