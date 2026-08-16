// Pure MQL shape-builders for string lowerings.
//
// A LEAF: it imports only other leaves (`lodash-shared.ts`, `namespace.ts`). That is what
// lets both `codegen.ts` and the method families use it — a family file that reached back
// into `codegen.ts` would make the two mutually dependent, and the registry would then
// assemble before the family initialised, silently dropping every method in it.
//
// It sits BESIDE `src/methods/`, not inside it: that directory holds method families and
// nothing else, which is what lets the assembly test compare it to the registry directly.
//
// Each function takes an ALREADY-LOWERED value and returns MQL. None of them needs a
// `GenerateCtx`, which is precisely why they can live here.
//
// See docs/specs/lowering-grid.md § Where declarations live.

import { ASCII_WORDS_RE, HTML_ESCAPE_PAIRS } from "./lodash-shared.ts";
import { exprVar } from "./namespace.ts";

function isIfNullWrapped(value: unknown): boolean {
  return typeof value === "object" && value !== null && "$ifNull" in value && Object.keys(value).length === 1;
}

/**
 * `$strLenCP` of a generated value, tolerant of a missing field.
 *
 * `$strLenCP` is the one string primitive that **aborts the query** on a missing/null
 * input (`Location34471`) — `$indexOfCP` returns null and `$substrCP` returns "". Since a
 * length is something jsmql derives rather than something the user wrote, an absent field
 * would otherwise take down a query through `.endsWith()` while the same predicate spelled
 * `.startsWith()` simply returned false. Coercing here makes the whole string surface
 * behave alike.
 *
 * Folds a literal receiver to its **code point** count: `$strLenCP` counts code points
 * where JS `.length` counts UTF-16 units, so "a👍b" is 3, not 4. A source string starting
 * with `$` is an MQL field reference (HR1), never a literal.
 */
export function strLenOf(value: unknown): unknown {
  if (typeof value === "string" && !value.startsWith("$")) return [...value].length;
  return { $strLenCP: isIfNullWrapped(value) ? value : { $ifNull: [value, ""] } };
}

/** Everything from `from` to the end of the string. */
export function strTail(s: unknown, from: number): unknown {
  return { $substrCP: [s, from, strLenOf(s)] };
}

/** First character upper, rest lower — lodash's `capitalize`. */
export function capitalizeExpr(s: unknown): unknown {
  return { $concat: [{ $toUpper: { $substrCP: [s, 0, 1] } }, { $toLower: strTail(s, 1) }] };
}

/** Change only the first character's case; the rest is untouched. */
export function firstCharExpr(s: unknown, op: "$toUpper" | "$toLower"): unknown {
  return { $concat: [{ [op]: { $substrCP: [s, 0, 1] } }, strTail(s, 1)] };
}

/**
 * Split into words — "fooBar-baz" → ["foo", "Bar", "baz"]. ASCII-only; the pattern is
 * shared with the compile-time fold so both halves split identically.
 *
 * `exprVar` is called directly rather than through `internalVar`: the body is fixed MQL
 * with nothing inside that could reference an outer parameter, so there is nothing to
 * capture and no gensym to do.
 */
export function wordsExpr(s: unknown): unknown {
  const w = exprVar("word");
  return { $map: { input: { $regexFindAll: { input: s, regex: ASCII_WORDS_RE } }, as: w, in: `$$${w}.match` } };
}

/** Join word expressions with `sep`, optionally transforming each word first. */
export function joinWords(words: unknown, sep: string, transform?: (w: unknown) => unknown): unknown {
  const w = exprVar("w");
  const items = transform === undefined ? words : { $map: { input: words, as: w, in: transform(`$$${w}`) } };
  return {
    $reduce: {
      input: items,
      initialValue: "",
      in: { $cond: [{ $eq: ["$$value", ""] }, "$$this", { $concat: ["$$value", sep, "$$this"] }] },
    },
  };
}

/** HTML-escape, one `$replaceAll` per pair, in the order lodash applies them. */
export function escapeHtmlExpr(s: unknown): unknown {
  let e: unknown = s;
  for (const [find, replacement] of HTML_ESCAPE_PAIRS) e = { $replaceAll: { input: e, find, replacement } };
  return e;
}
