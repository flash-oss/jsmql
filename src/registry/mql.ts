// The registry — pure MQL shape builders the method cells share.
//
// Every function here takes LOWERED operands (or a source node it only reads)
// and answers a document; none reads a registry row or a compiler service, so
// the registry stays a leaf. A builder that can fold a constant does: `strLenOf("ab")`
// is 2, `foldedSubtract(5, 2)` is 3, and a constant that stays a constant is what
// lets a later `$substrCP` take a plain number.
//
// See docs/specs/lowering-grid.md for the cells that use these.

import type { Expr } from "./ast.ts";

/** `{ $cond: { if, then, else } }` — the one spelling of a condition. */
export const cond = (
  ifExpr: unknown,
  thenExpr: unknown,
  elseExpr: unknown,
): { $cond: { if: unknown; then: unknown; else: unknown } } => ({
  $cond: { if: ifExpr, then: thenExpr, else: elseExpr },
});

/** Is `value` already `{ $ifNull: [ … ] }`? A second wrap would say nothing. */
export const isIfNullWrapped = (value: unknown): boolean =>
  typeof value === "object" && value !== null && "$ifNull" in value && Object.keys(value).length === 1;

/** A string operand read as "" when missing or null, so a string operator does not fail on it. */
export const coerceStringBinding = (v: unknown): unknown => (isIfNullWrapped(v) ? v : { $ifNull: [v, ""] });

/** `Math.max(0, n)`, folded for a constant. */
export const clampNonNegative = (value: unknown): unknown =>
  typeof value === "number" ? Math.max(0, value) : { $max: [0, value] };

/** `a - b`, folded for two constants. */
export const foldedSubtract = (a: unknown, b: unknown): unknown =>
  typeof a === "number" && typeof b === "number" ? a - b : { $subtract: [a, b] };

/** Is the lowered value ONE character, written as a literal? A pad of one repeats cleanly. */
export const isSingleCodePointLiteral = (value: unknown): boolean =>
  typeof value === "string" && !value.startsWith("$") && [...value].length === 1;

/** The regex options MongoDB knows, from JavaScript's flags — `g` and `y` have no MongoDB meaning. */
export function mongoRegexOptions(jsFlags: string): string {
  let out = "";
  for (const ch of jsFlags) if ("imsx".includes(ch) && !out.includes(ch)) out += ch;
  return out;
}

/** The integer a source node spells as a literal — `3`, `-3` — or null when it is not one. */
export function literalIndexValue(node: Expr): number | null {
  if (node.type === "NumberLiteral" && Number.isInteger(node.value)) return node.value;
  if (
    node.type === "UnaryExpr" &&
    node.op === "-" &&
    node.argument.type === "NumberLiteral" &&
    Number.isInteger(node.argument.value)
  ) {
    return -node.argument.value;
  }
  return null;
}

/** An index clamped at 0: a literal folds, a runtime value takes `$max`. */
export const clampNonNegativeIndex = (node: Expr, lowered: unknown): unknown => {
  const lit = literalIndexValue(node);
  return lit === null ? { $max: [0, lowered] } : Math.max(0, lit);
};

/** The length of a string value: a literal counts its code points, a value takes `$strLenCP` over "" for missing. */
export function strLenOf(value: unknown): unknown {
  if (typeof value === "string" && !value.startsWith("$")) return [...value].length;
  return { $strLenCP: isIfNullWrapped(value) ? value : { $ifNull: [value, ""] } };
}

/** A JavaScript slice index on a string: negative counts from the end, clamped at 0. */
export function normaliseSliceIndex(node: Expr, lowered: unknown, recv: unknown): unknown {
  const lit = literalIndexValue(node);
  if (lit !== null) return lit >= 0 ? lit : clampNonNegative(foldedSubtract(strLenOf(recv), -lit));
  return cond({ $lt: [lowered, 0] }, clampNonNegative({ $add: [lowered, strLenOf(recv)] }), lowered);
}

/** A negative literal's magnitude — `-3` → 3 — or null. */
export function negativeLiteralValue(node: Expr): number | null {
  const lit = literalIndexValue(node);
  return lit !== null && lit < 0 ? -lit : null;
}

/** `str.slice(start[, end])` on a string value. */
export function sliceString(recv: unknown, args: readonly Expr[], value: (e: Expr) => unknown): unknown {
  if (args.length === 0) return recv;
  const start = normaliseSliceIndex(args[0], value(args[0]), recv);
  if (args.length === 1) {
    const negative = negativeLiteralValue(args[0]);
    if (negative !== null) return { $substrCP: [recv, start, negative] };
    return { $substrCP: [recv, start, clampNonNegative(foldedSubtract(strLenOf(recv), start))] };
  }
  const end = normaliseSliceIndex(args[1], value(args[1]), recv);
  return { $substrCP: [recv, start, clampNonNegative(foldedSubtract(end, start))] };
}

/** Everything from `from` on. */
export const strTail = (s: unknown, from: number): unknown => ({ $substrCP: [s, from, strLenOf(s)] });

/** lodash `capitalize`: first character up, the rest down. */
export const capitalizeExpr = (s: unknown): unknown => ({
  $concat: [{ $toUpper: { $substrCP: [s, 0, 1] } }, { $toLower: strTail(s, 1) }],
});

/** lodash `upperFirst` / `lowerFirst`: the first character changed, the rest as it is. */
export const firstCharExpr = (s: unknown, op: "$toUpper" | "$toLower"): unknown => ({
  $concat: [{ [op]: { $substrCP: [s, 0, 1] } }, strTail(s, 1)],
});

/** lodash's word boundary: a capitalised word, an acronym, a lone capital, a number. */
export const ASCII_WORDS_RE = "[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[A-Z]|[0-9]+";

/** The five characters lodash `escape` replaces, in its order. */
export const HTML_ESCAPE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["&", "&amp;"],
  ["<", "&lt;"],
  [">", "&gt;"],
  ['"', "&quot;"],
  ["'", "&#39;"],
];

/** A variable minted for a body: its `as` name and the `$$name` that reads it. */
export type Minted = { as: string; ref: string };

/** lodash `words`: every ASCII word of the string, as an array. */
export function wordsExpr(s: unknown, mint: (hint: string) => Minted): unknown {
  const w = mint("word");
  return { $map: { input: { $regexFindAll: { input: s, regex: ASCII_WORDS_RE } }, as: w.as, in: `${w.ref}.match` } };
}

/** The words joined with `sep`, each first passed through `transform` when given. */
export function joinWords(
  words: unknown,
  sep: string,
  mint: (hint: string) => Minted,
  transform?: (w: unknown) => unknown,
): unknown {
  const w = mint("w");
  const items = transform === undefined ? words : { $map: { input: words, as: w.as, in: transform(w.ref) } };
  return {
    $reduce: {
      input: items,
      initialValue: "",
      in: { $cond: [{ $eq: ["$$value", ""] }, "$$this", { $concat: ["$$value", sep, "$$this"] }] },
    },
  };
}

/** lodash `escape`: the five HTML characters replaced, one `$replaceAll` each. */
export function escapeHtmlExpr(s: unknown): unknown {
  let e: unknown = s;
  for (const [find, replacement] of HTML_ESCAPE_PAIRS) e = { $replaceAll: { input: e, find, replacement } };
  return e;
}

/**
 * The body a regex-taking string operator reads: a literal's pattern and options,
 * or a value — lowered only when it is not a literal, since a regex literal has no
 * value of its own outside these operators.
 */
export function regexBody(recv: unknown, pattern: Expr, lower: () => unknown): Record<string, unknown> {
  if (pattern.type !== "RegexLiteral") return { input: recv, regex: lower() };
  const body: Record<string, unknown> = { input: recv, regex: pattern.pattern };
  const opts = mongoRegexOptions(pattern.flags);
  if (opts) body.options = opts;
  return body;
}

// ── dates ────────────────────────────────────────────────────────────────────

/** The calendar parts `$dateFromParts` takes, in its order. */
export const DATE_PARTS_CALENDAR = ["year", "month", "day", "hour", "minute", "second", "millisecond"] as const;
/** The ISO-week parts, in its order. */
export const DATE_PARTS_ISO = [
  "isoWeekYear",
  "isoWeek",
  "isoDayOfWeek",
  "hour",
  "minute",
  "second",
  "millisecond",
] as const;
/** The parts that name a family: any one of these decides which `$dateFromParts` spelling is built. */
export const DATE_PARTS_ISO_MARKERS = ["isoWeekYear", "isoWeek", "isoDayOfWeek"] as const;
/** The trailing options a date method takes, in MongoDB's key order. */
export const DATE_OPTION_ORDER = ["binSize", "timezone", "startOfWeek"] as const;

/**
 * A date method's trailing options as the keys the operator takes: a bare string
 * is the timezone; a document names them. The rule on the row has already
 * checked the keys and their types, so this only reads.
 */
export function dateOptions(arg: Expr | undefined, value: (e: Expr) => unknown): Record<string, unknown> {
  if (arg === undefined) return {};
  if (arg.type !== "ObjectLiteral") return { timezone: value(arg) };
  const byKey = new Map<string, Expr>();
  for (const e of arg.entries)
    if (e.type === "KeyValueEntry" && e.key.kind === "static") byKey.set(e.key.name, e.value);
  const out: Record<string, unknown> = {};
  for (const key of DATE_OPTION_ORDER) {
    const v = byKey.get(key);
    if (v !== undefined) out[key] = value(v);
  }
  return out;
}
