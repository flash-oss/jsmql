// String methods — the self-contained half of the family.
//
// A declaration here owns its arity rule, and dispatch always applies it. That alone
// fixed a real gap: `.trim("x")` and `.toLowerCase(1)` used to compile and silently
// discard the argument, because the switch arm returned without checking. A method
// cannot skip its own rule when the rule and the lowering are the same object.
//
// NOT YET HERE, and why: `.substr`, `.substring`, `.replace`, `.replaceAll`, `.match`
// and `.matchAll` need the slice-index normalisers, which read the AST *and* lower it —
// they take a `GenerateCtx`, so they cannot be a leaf without more surgery. They stay in
// the switch; the ratchet in `test/methods-grid.test.ts` counts them.
//
// See docs/specs/lowering-grid.md.

import {
  clampNonNegative,
  coerceStringBinding,
  cond,
  foldedSubtract,
  isSingleCodePointLiteral,
  literalIndexValue,
  mongoRegexOptions,
} from "../mql-shape.ts";
import { strLenOf } from "../mql-string.ts";
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

/**
 * `.padStart(target[, pad])` / `.padEnd(...)`.
 *
 * No length guard: when the receiver already reaches `target`, `need` is <= 0, `$range`
 * is empty, the filler is "", and the concat returns the receiver unchanged. JS pads to
 * exactly `target` CHARACTERS, truncating a multi-character pad mid-string, so the
 * repeated filler is trimmed back — except for a one-code-point literal, which already
 * lands exactly and whose trim would only add noise to the common `.padStart(n, "0")`.
 */
function padder(side: "start" | "end"): MethodDef {
  return {
    receiver: "string",
    returns: "string",
    args: { sig: "targetLength[, padString]", allowed: [1, 2] },
    value: ({ recv, args, gen, internalVar }) => {
      const target = gen(args[0]);
      const pad = args.length === 2 ? gen(args[1]) : " ";
      const [v, ref] = internalVar("pad");
      const need = { $subtract: [target, { $strLenCP: ref }] };
      const repeated = {
        $reduce: { input: { $range: [0, need] }, initialValue: "", in: { $concat: ["$$value", pad] } },
      };
      const filler = isSingleCodePointLiteral(pad) ? repeated : { $substrCP: [repeated, 0, clampNonNegative(need)] };
      return {
        $let: {
          vars: { [v]: coerceStringBinding(recv) },
          in: { $concat: side === "start" ? [filler, ref] : [ref, filler] },
        },
      };
    },
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

  charAt: {
    receiver: "string",
    returns: "string",
    args: { sig: "index", exact: 1 },
    // JS `.charAt(i)` returns "" for a negative index, so this is the ONE string index
    // that must not be floored — flooring to 0 would wrongly return the first character.
    // A literal negative folds away; a runtime one needs the guard.
    value: ({ recv, args, gen }) => {
      const lit = literalIndexValue(args[0]);
      if (lit !== null) return lit < 0 ? "" : { $substrCP: [recv, lit, 1] };
      const index = gen(args[0]);
      return cond({ $lt: [index, 0] }, "", { $substrCP: [recv, index, 1] });
    },
  },

  startsWith: {
    receiver: "string",
    returns: "bool",
    args: { sig: "searchString", exact: 1 },
    value: ({ recv, args, gen }) => ({ $eq: [{ $indexOfCP: [recv, gen(args[0])] }, 0] }),
  },

  endsWith: {
    receiver: "string",
    returns: "bool",
    args: { sig: "searchString", exact: 1 },
    // Compare the last N code points with the needle, N being the needle's length. The
    // receiver binds once so a chained one is not re-evaluated, and the start is floored:
    // a receiver shorter than the needle makes `strLen - N` negative, which `$substrCP`
    // rejects outright rather than returning false. The binding is coerced so `$strLenCP`
    // sees a string even when the field is absent.
    value: ({ recv, args, gen, internalVar }) => {
      const needle = gen(args[0]);
      const needleLen = strLenOf(needle);
      const [vStr, s] = internalVar("str");
      return {
        $let: {
          vars: { [vStr]: coerceStringBinding(recv) },
          in: {
            $eq: [{ $substrCP: [s, clampNonNegative(foldedSubtract({ $strLenCP: s }, needleLen)), needleLen] }, needle],
          },
        },
      };
    },
  },

  search: {
    receiver: "string",
    returns: "number",
    args: { sig: "regex", exact: 1 },
    // `.search` returns the index of the first match, or -1. `$regexFind` yields an object
    // with `.idx` on a match and null otherwise, so `$ifNull` supplies the -1.
    value: ({ recv, args, gen }) => {
      const pattern = args[0];
      const opts = pattern.type === "RegexLiteral" ? mongoRegexOptions(pattern.flags) : "";
      const findCall =
        pattern.type === "RegexLiteral"
          ? {
              $regexFind: opts
                ? { input: recv, regex: pattern.pattern, options: opts }
                : { input: recv, regex: pattern.pattern },
            }
          : { $regexFind: { input: recv, regex: gen(pattern) } };
      return { $ifNull: [{ $getField: { field: "idx", input: findCall } }, -1] };
    },
  },

  padStart: padder("start"),
  padEnd: padder("end"),

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
