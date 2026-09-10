// The registry — pure MQL shape builders the method cells share.
//
// Every function here takes LOWERED operands (or a source node it only reads)
// and answers a document; none reads a registry row or a compiler service, so
// the registry stays a leaf. A builder that can fold a constant does: `strLenOf("ab")`
// is 2, `foldedSubtract(5, 2)` is 3, and a constant that stays a constant is what
// lets a later `$substrCP` take a plain number.
//
// See docs/specs/emit-pass.md § The method cells for the cells that use these.

import type { Expr } from "./ast.ts";

// ── a field name the DEVELOPER chose ─────────────────────────────────────────
//
// MongoDB reserves no field names, so `__proto__` is ordinary data — and it is the
// one name JavaScript refuses to store the ordinary way. Four operations go wrong,
// and only the first is about writing:
//
//   out[name] = v      writes the PROTOTYPE slot, creates no own property: the field
//                      vanishes from the emitted document
//   out[name]          reads a method off `Object.prototype` for "constructor",
//                      "toString", "valueOf", … so an accumulator sees a value it
//                      never stored
//   name in out        answers true for every one of those names, so a duplicate
//                      guard refuses a program that has no duplicate
//   seen[name] = true  the same, when a plain object stands in for a set
//
// `setKey` answers the first. The other three have no helper because the fix is to
// stop using an object: a `Map` and a `Set` hold exactly what was put in them.

/**
 * `out[name] = value`, creating an OWN property even when `name` is `__proto__`.
 * `Object.defineProperty` is the escape — it never consults the prototype.
 * (`Object.fromEntries` and object spread are already safe; a site using either
 * needs no change.)
 */
export function setKey<T>(out: Record<string, T>, name: string, value: T): Record<string, T> {
  if (name === "__proto__") {
    Object.defineProperty(out, name, { value, enumerable: true, writable: true, configurable: true });
    return out;
  }
  out[name] = value;
  return out;
}

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

// ── arrays ───────────────────────────────────────────────────────────────────

/** A literal array as ONE operand: `{ $size: [1, 2] }` is two operands to the server, `{ $size: [[1, 2]] }` one. */
export const singleArrayArg = (operand: unknown): unknown => (Array.isArray(operand) ? [operand] : operand);
export const sizeOf = (a: unknown): Record<string, unknown> => ({ $size: singleArrayArg(a) });
export const firstOf = (a: unknown): Record<string, unknown> => ({ $first: singleArrayArg(a) });
export const lastOf = (a: unknown): Record<string, unknown> => ({ $last: singleArrayArg(a) });
export const reverseArrayOf = (a: unknown): Record<string, unknown> => ({ $reverseArray: singleArrayArg(a) });

/** JavaScript's truth of a lowered value: not missing, null, false, "" or 0. */
export const jsTruth = (value: unknown): unknown => ({
  $and: [
    { $ne: [{ $ifNull: [value, null] }, null] },
    { $ne: [value, false] },
    { $ne: [value, ""] },
    { $ne: [value, 0] },
  ],
});

/** `0 - n`, folded for a constant. */
export const negate = (n: unknown): unknown => (typeof n === "number" ? -n : { $subtract: [0, n] });

/** A group key as the string a document key must be; `null` for a missing one, as lodash spells it. */
export const stringKeyExpr = (value: unknown): unknown => ({ $ifNull: [{ $toString: value }, "null"] });

/** An iteratee over an array: the element variable and the body reading it. */
export type Iter = { as: string; ref: string; in: unknown };

/** The distinct keys an iteratee yields over the array, as strings. */
export const distinctKeysExpr = (arr: unknown, it: Iter): unknown => ({
  $setUnion: [{ $map: { input: arr, as: it.as, in: stringKeyExpr(it.in) } }, []],
});
/** Every key an iteratee yields over the array. */
export const iterateeKeys = (arr: unknown, it: Iter): unknown => ({ $map: { input: arr, as: it.as, in: it.in } });

/** lodash `uniqBy`: the first element per key, in order — one `$reduce` carrying the keys seen. */
export function uniqByReduce(input: unknown, it: Iter, mint: (hint: string) => Minted): unknown {
  const key = mint("key");
  const keyExpr = it.in === it.ref ? "$$this" : { $let: { vars: { [it.as]: "$$this" }, in: it.in } };
  return {
    $getField: {
      field: "out",
      input: {
        $reduce: {
          input,
          initialValue: { seen: [], out: [] },
          in: {
            $let: {
              vars: { [key.as]: keyExpr },
              in: {
                $cond: [
                  { $in: [key.ref, "$$value.seen"] },
                  "$$value",
                  {
                    seen: { $concatArrays: ["$$value.seen", [key.ref]] },
                    out: { $concatArrays: ["$$value.out", ["$$this"]] },
                  },
                ],
              },
            },
          },
        },
      },
    },
  };
}

/** lodash `takeWhile` / `dropWhile`: the prefix a predicate holds over, kept or dropped. */
export function takeDropWhile(arrExpr: unknown, pred: Iter, drop: boolean, mint: (hint: string) => Minted): unknown {
  const arr = mint("arr");
  const fi = mint("fi");
  const preds = { $map: { input: arr.ref, as: pred.as, in: { $cond: [pred.in, true, false] } } };
  const body = drop
    ? { $cond: [{ $eq: [fi.ref, -1] }, [], { $slice: [arr.ref, fi.ref, { $size: arr.ref }] }] }
    : { $cond: [{ $eq: [fi.ref, -1] }, arr.ref, { $slice: [arr.ref, fi.ref] }] };
  return {
    $let: {
      vars: { [arr.as]: arrExpr },
      in: { $let: { vars: { [fi.as]: { $indexOfArray: [preds, false] } }, in: body } },
    },
  };
}

/** A JavaScript slice index on an array of `size`: negative counts from the end, both ends clamped. */
export function resolveSliceIndex(node: Expr, lowered: unknown, size: unknown): unknown {
  const lit = literalIndexValue(node);
  if (lit !== null) {
    if (lit === 0) return 0;
    if (lit > 0) return { $min: [lit, size] };
    return { $max: [{ $subtract: [size, -lit] }, 0] };
  }
  return { $cond: [{ $lt: [lowered, 0] }, { $max: [{ $add: [lowered, size] }, 0] }, { $min: [lowered, size] }] };
}

/** `arr.slice(start[, end])` on an array value. */
export function sliceArray(
  recv: unknown,
  args: readonly Expr[],
  value: (e: Expr) => unknown,
  mint: (hint: string) => Minted,
): unknown {
  if (args.length === 0) return recv;
  const startNode = args[0];
  const startLit = literalIndexValue(startNode);
  if (args.length === 1) {
    if (startLit !== null && startLit < 0) return { $slice: [recv, startLit] };
    if (startLit === 0) return recv;
    const arr = mint("arr");
    return {
      $let: {
        vars: { [arr.as]: recv },
        in: { $slice: [arr.ref, value(startNode), { $max: [1, { $size: arr.ref }] }] },
      },
    };
  }
  const endNode = args[1];
  const endLit = literalIndexValue(endNode);
  if (startLit !== null && startLit >= 0 && endLit !== null && endLit >= 0) {
    if (startLit === 0) return { $slice: [recv, endLit] };
    if (endLit <= startLit) return [];
    return { $slice: [recv, startLit, endLit - startLit] };
  }
  if (startLit === 0) {
    const arr = mint("arr");
    return {
      $let: {
        vars: { [arr.as]: recv },
        in: { $slice: [arr.ref, resolveSliceIndex(endNode, value(endNode), { $size: arr.ref })] },
      },
    };
  }
  const arr = mint("arr");
  const k = mint("k");
  const f = mint("f");
  const count = { $subtract: [f.ref, k.ref] };
  return {
    $let: {
      vars: { [arr.as]: recv },
      in: {
        $let: {
          vars: {
            [k.as]: resolveSliceIndex(startNode, value(startNode), { $size: arr.ref }),
            [f.as]: resolveSliceIndex(endNode, value(endNode), { $size: arr.ref }),
          },
          in: { $cond: [{ $gt: [count, 0] }, { $slice: [arr.ref, k.ref, { $max: [count, 1] }] }, []] },
        },
      },
    },
  };
}

/**
 * `arr.join(sep)`: every element as a string, joined — an empty array is "".
 *
 * Two things JavaScript does that the obvious `$reduce` does not.
 *
 * The accumulator starts at `null`, not `""`, because `""` cannot tell "nothing joined
 * yet" from "what is joined so far is empty": with `""` as the marker an array whose
 * FIRST element is the empty string loses its separator, and MEASURED,
 * `["", "a"].join(",")` answered "a" where JavaScript answers ",a".
 *
 * And a `null` or missing element is written as "" rather than dropped —
 * `[1, null, 2].join(",")` is "1,,2". `$toString` of null answers null and `$concat`
 * with a null operand answers null, so without the test the whole join answered null.
 *
 * The reduce keeps its `null` for an empty array, which `$ifNull` turns into the ""
 * JavaScript gives. That reading covers a null or missing RECEIVER too, the empty-array
 * neutral the rest of the language uses.
 */
export const joinedWith = (recv: unknown, separator: unknown): unknown => {
  const piece = cond({ $in: [{ $type: "$$this" }, ["null", "missing"]] }, "", { $toString: "$$this" });
  return {
    $ifNull: [
      {
        $reduce: {
          input: recv,
          initialValue: null,
          in: cond({ $eq: ["$$value", null] }, piece, { $concat: ["$$value", separator, piece] }),
        },
      },
      "",
    ],
  };
};

// ── the JavaScript globals ───────────────────────────────────────────────────

/**
 * `$dateFromParts` from the positional `(year, month, day, hour, minute, second,
 * ms)` of `new Date(…)` and `Date.UTC(…)`. JavaScript counts months from 0 and
 * MongoDB from 1, so the month moves up by one — folded when it is a literal.
 */
export function dateFromParts(parts: readonly unknown[], timezone: string | null): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  DATE_PARTS_CALENDAR.forEach((key, i) => {
    if (i >= parts.length) return;
    const p = parts[i];
    body[key] = key !== "month" ? p : typeof p === "number" ? p + 1 : { $add: [p, 1] };
  });
  if (timezone !== null) body.timezone = timezone;
  return { $dateFromParts: body };
}

/** The `[index, element]` pairs of an array, for a lowering that needs the position of each element. */
export const indexedPairs = (arr: unknown): Record<string, unknown> => ({
  $zip: { inputs: [{ $range: [0, sizeOf(arr)] }, arr] },
});

/**
 * `.ceil(p)` / `.floor(p)` at a precision. Only `$round` takes one on the server, so
 * the value is scaled by 10^p, rounded to a whole number, and scaled back. MEASURED
 * on 1.234: ceil(2) → 1.24, floor(2) → 1.23, and ceil(2) of -1.234 → -1.23, each
 * JavaScript's own answer.
 */
export const atPrecision = (op: "$ceil" | "$floor", value: unknown, precision: unknown): unknown => {
  const scale = { $pow: [10, precision] };
  return { $divide: [{ [op]: { $multiply: [value, scale] } }, scale] };
};

/** `Math.cbrt` keeps the sign: `$pow` of a negative base to a fractional exponent is NaN on the server. */
export const cbrt = (v: unknown): Record<string, unknown> => ({
  $multiply: [{ $cmp: [v, 0] }, { $pow: [{ $abs: v }, { $divide: [1, 3] }] }],
});

/** A number, and neither NaN nor an infinity — read off `$toString`, since the server holds NaN equal to itself. */
export const isFiniteNumber = (v: unknown): Record<string, unknown> => ({
  $and: [{ $isNumber: v }, { $not: [{ $in: [{ $toString: v }, ["NaN", "Infinity", "-Infinity"]] }] }],
});

/**
 * A list of `[key, value]` pairs as a document. The key is rendered with
 * `$toString`, because JavaScript's own `Object.fromEntries([[7, 1]])` answers
 * `{ "7": 1 }` and `$arrayToObject` refuses a non-string key outright —
 * MEASURED: "\$arrayToObject requires an array of key-value pairs".
 */
export const pairsToObject = (pairs: unknown, p: { as: string; ref: string }): unknown => ({
  $arrayToObject: {
    $map: { input: pairs, as: p.as, in: [{ $toString: { $arrayElemAt: [p.ref, 0] } }, { $arrayElemAt: [p.ref, 1] }] },
  },
});
