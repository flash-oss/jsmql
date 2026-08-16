// String methods — the self-contained half of the family.
//
// A declaration here owns its arity rule, and dispatch always applies it. That alone
// fixed a real gap: `.trim("x")` and `.toLowerCase(1)` used to compile and silently
// discard the argument, because the switch arm returned without checking. A method
// cannot skip its own rule when the rule and the lowering are the same object.
//
// NOT YET HERE, and why: `.indexOf`, `.lastIndexOf`, `.includes`, `.at` and `.slice` are
// the DUAL-receiver methods — each works on a string and on an array, and picks its
// lowering from what the receiver is inferred to be. That inference is a compiler service
// no declaration can express yet, and the receiver family they would declare is not one of
// the five. They stay in the switch; the ratchet in `test/methods-grid.test.ts` counts them.
//
// See docs/specs/lowering-grid.md.

import {
  clampNonNegative,
  clampNonNegativeIndex,
  coerceStringBinding,
  cond,
  foldedSubtract,
  isSingleCodePointLiteral,
  literalIndexValue,
  mongoRegexOptions,
} from "../mql-shape.ts";
import { normaliseSliceIndex, strLenOf } from "../mql-string.ts";
import type { Expr } from "../ast.ts";
import type { LowerInput, MethodDef } from "./types.ts";

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

/** `.replace(find, replacement)` / `.replaceAll(...)`: the operator differs, nothing else. */
function replacer(operator: "$replaceOne" | "$replaceAll"): MethodDef {
  return {
    receiver: "string",
    returns: "string",
    args: { sig: "find, replacement", exact: 2 },
    value: ({ recv, args, gen }) => ({ [operator]: { input: recv, find: gen(args[0]), replacement: gen(args[1]) } }),
  };
}

/**
 * The `{ input, regex[, options] }` body `.match` / `.matchAll` share.
 *
 * A regex written as a literal carries its flags in the source, so they are translated at
 * compile time; a runtime pattern is a plain string and carries none.
 */
function regexBody(recv: unknown, pattern: Expr, gen: LowerInput["gen"]): Record<string, unknown> {
  if (pattern.type !== "RegexLiteral") return { input: recv, regex: gen(pattern) };
  const body: Record<string, unknown> = { input: recv, regex: pattern.pattern };
  const opts = mongoRegexOptions(pattern.flags);
  if (opts) body["options"] = opts;
  return body;
}

/** The `{ length, omission }` options `.truncate` reads, with lodash's defaults. */
function truncateOptions(args: readonly Expr[], err: LowerInput["err"]): { length: number; omission: string } {
  const out = { length: 30, omission: "..." };
  if (args.length === 0) return out;
  const opts = args[0];
  if (opts.type !== "ObjectLiteral") {
    throw err(`.truncate(...) takes an options object, e.g. '.truncate({ length: 24, omission: "…" })'.`, opts.pos);
  }
  for (const entry of opts.entries) {
    if (entry.type !== "KeyValueEntry" || entry.key.kind !== "static") {
      throw err(`.truncate({ … }) options must be static keys ('length', 'omission').`, entry.pos);
    }
    if (entry.key.name === "length" && entry.value.type === "NumberLiteral") out.length = entry.value.value;
    else if (entry.key.name === "omission" && entry.value.type === "StringLiteral") out.omission = entry.value.value;
    else if (entry.key.name === "separator") {
      throw err(
        `.truncate({ separator }) (word-boundary truncation) isn't supported — MQL has no back-search. Use 'length' + 'omission'.`,
        entry.value.pos,
      );
    } else {
      throw err(
        `.truncate({ ${entry.key.name} }) — only literal 'length' and 'omission' are supported.`,
        entry.value.pos,
      );
    }
  }
  return out;
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

  substr: {
    receiver: "string",
    returns: "string",
    args: { sig: "start[, count]", allowed: [1, 2] },
    // JS `.substr(start, count)`: a negative start counts from the end (as `.slice` does),
    // and a negative count yields "". `$substrCP` rejects either outright, so both are
    // normalised rather than passed through.
    value: ({ recv, args, gen }) => {
      const start = normaliseSliceIndex(args[0], gen, recv);
      // A length past the end is clamped by the server, so the full length stands in for
      // "the rest of the string".
      const count = args.length === 1 ? strLenOf(recv) : clampNonNegativeIndex(args[1], gen);
      return { $substrCP: [recv, start, count] };
    },
  },

  substring: {
    receiver: "string",
    returns: "string",
    args: { sig: "start[, end]", allowed: [0, 1, 2] },
    // JS `.substring(s, e)` takes end-EXCLUSIVE; `$substrCP` takes a length. JS clamps
    // negative indices to 0 (and would also swap when start > end — jsmql models the
    // clamping but not the swap; see docs/specs/method-dispatch.md).
    value: ({ recv, args, gen }) => {
      if (args.length === 0) return recv;
      const start = clampNonNegativeIndex(args[0], gen);
      // `strLen - start` is negative when start runs past the end.
      const end = args.length === 1 ? strLenOf(recv) : clampNonNegativeIndex(args[1], gen);
      return { $substrCP: [recv, start, clampNonNegative(foldedSubtract(end, start))] };
    },
  },

  replace: replacer("$replaceOne"),
  replaceAll: replacer("$replaceAll"),

  match: {
    receiver: "string",
    returns: "bool",
    args: { sig: "regex", exact: 1 },
    value: ({ recv, args, gen }) => ({ $regexMatch: regexBody(recv, args[0], gen) }),
  },

  matchAll: {
    receiver: "string",
    returns: "array",
    args: { sig: "regex", exact: 1 },
    value: ({ recv, args, gen, err }) => {
      const pattern = args[0];
      if (pattern.type === "RegexLiteral" && !pattern.flags.includes("g")) {
        throw err(`.matchAll() requires a regex with the 'g' flag (matching JS's TypeError on non-global regex)`);
      }
      // The required `g` drops out with the other JS-only flags: `$regexFindAll` is
      // inherently global, and `g` is not a valid MongoDB option.
      return { $regexFindAll: regexBody(recv, pattern, gen) };
    },
  },

  truncate: {
    receiver: "string",
    returns: "string",
    args: { sig: "[{ length, omission }]", allowed: [0, 1] },
    value: ({ recv, args, internalVar, err }) => {
      const { length, omission } = truncateOptions(args, err);
      const keep = Math.max(0, length - omission.length);
      // Bound once (and coerced) so the receiver isn't evaluated three times and an absent
      // field truncates to "" like lodash, rather than passing null through the else branch.
      const [vStr, s] = internalVar("str");
      return {
        $let: {
          vars: { [vStr]: coerceStringBinding(recv) },
          in: { $cond: [{ $gt: [{ $strLenCP: s }, length] }, { $concat: [{ $substrCP: [s, 0, keep] }, omission] }, s] },
        },
      };
    },
  },
};
