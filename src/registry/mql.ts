import type { Expr } from "./ast.ts";

export function setKey<T>(out: Record<string, T>, name: string, value: T): Record<string, T> {
  if (name === "__proto__") {
    Object.defineProperty(out, name, { value, enumerable: true, writable: true, configurable: true });
    return out;
  }
  out[name] = value;
  return out;
}

export const cond = (ifExpr: unknown, thenExpr: unknown, elseExpr: unknown): unknown => {
  if (ifExpr === true) return thenExpr;
  if (ifExpr === false) return elseExpr;
  return { $cond: [ifExpr, thenExpr, elseExpr] };
};

export const isNullish = (value: unknown): Record<string, unknown> => ({ $lte: [value, null] });

export const isNotNullish = (value: unknown): Record<string, unknown> => ({ $gt: [value, null] });

export const isIfNullWrapped = (value: unknown): boolean =>
  typeof value === "object" && value !== null && "$ifNull" in value && Object.keys(value).length === 1;

export const coerceStringBinding = (v: unknown): unknown => (isIfNullWrapped(v) ? v : { $ifNull: [v, ""] });

export const clampNonNegative = (value: unknown): unknown =>
  typeof value === "number" ? Math.max(0, value) : { $max: [0, value] };

export const foldedSubtract = (a: unknown, b: unknown): unknown =>
  typeof a === "number" && typeof b === "number" ? a - b : { $subtract: [a, b] };

export function constantText(value: unknown): string | null {
  if (typeof value === "string") return value.startsWith("$") ? null : value;
  if (typeof value === "object" && value !== null && Object.keys(value).length === 1) {
    const held = (value as { $literal?: unknown }).$literal;
    if (typeof held === "string") return held;
  }
  return null;
}

export const isSingleCodePointLiteral = (value: unknown): boolean => {
  const text = constantText(value);
  return text !== null && [...text].length === 1;
};

export function mongoRegexOptions(jsFlags: string): string {
  let out = "";
  for (const ch of jsFlags) if ("imsx".includes(ch) && !out.includes(ch)) out += ch;
  return out;
}

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

export const clampNonNegativeIndex = (node: Expr, lowered: unknown): unknown => {
  const lit = literalIndexValue(node);
  return lit === null ? { $max: [0, lowered] } : Math.max(0, lit);
};

export function strLenOf(value: unknown, present = false): unknown {
  const text = constantText(value);
  if (text !== null) return [...text].length;
  return { $strLenCP: present || isIfNullWrapped(value) ? value : { $ifNull: [value, ""] } };
}

export function normaliseSliceIndex(node: Expr, lowered: unknown, recv: unknown, present = false): unknown {
  const lit = literalIndexValue(node);
  if (lit !== null) return lit >= 0 ? lit : clampNonNegative(foldedSubtract(strLenOf(recv, present), -lit));
  return cond({ $lt: [lowered, 0] }, clampNonNegative({ $add: [lowered, strLenOf(recv, present)] }), lowered);
}

export function negativeLiteralValue(node: Expr): number | null {
  const lit = literalIndexValue(node);
  return lit !== null && lit < 0 ? -lit : null;
}

export const substrOperand = (s: unknown): unknown => {
  const operands =
    typeof s === "object" && s !== null && !Array.isArray(s) ? (s as { $ifNull?: unknown }).$ifNull : undefined;
  return Array.isArray(operands) && operands.length === 2 && operands[1] === "" && Object.keys(s as object).length === 1
    ? operands[0]
    : s;
};

export const strTail = (s: unknown, from: number, present = false): unknown => ({
  $substrCP: [substrOperand(s), from, strLenOf(s, present)],
});

export const capitalizeExpr = (s: unknown, present = false): unknown => ({
  $concat: [{ $toUpper: { $substrCP: [substrOperand(s), 0, 1] } }, { $toLower: strTail(s, 1, present) }],
});

export const firstCharExpr = (s: unknown, op: "$toUpper" | "$toLower", present = false): unknown => ({
  $concat: [{ [op]: { $substrCP: [substrOperand(s), 0, 1] } }, strTail(s, 1, present)],
});

export const ASCII_WORDS_RE = "[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[A-Z]|[0-9]+";

export const HTML_ESCAPE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["&", "&amp;"],
  ["<", "&lt;"],
  [">", "&gt;"],
  ['"', "&quot;"],
  ["'", "&#39;"],
];

export type Minted = { as: string; ref: string };

export function wordsExpr(s: unknown, mint: (hint: string) => Minted): unknown {
  const w = mint("word");
  return { $map: { input: { $regexFindAll: { input: s, regex: ASCII_WORDS_RE } }, as: w.as, in: `${w.ref}.match` } };
}

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

export function escapeHtmlExpr(s: unknown): unknown {
  let e: unknown = s;
  for (const [find, replacement] of HTML_ESCAPE_PAIRS) e = { $replaceAll: { input: e, find, replacement } };
  return e;
}

export function regexBody(recv: unknown, pattern: Expr, lower: () => unknown): Record<string, unknown> {
  if (pattern.type !== "RegexLiteral") return { input: recv, regex: lower() };
  const body: Record<string, unknown> = { input: recv, regex: pattern.pattern };
  const opts = mongoRegexOptions(pattern.flags);
  if (opts) body.options = opts;
  return body;
}

export const DATE_PARTS_CALENDAR = ["year", "month", "day", "hour", "minute", "second", "millisecond"] as const;
export const DATE_PARTS_ISO = [
  "isoWeekYear",
  "isoWeek",
  "isoDayOfWeek",
  "hour",
  "minute",
  "second",
  "millisecond",
] as const;
export const DATE_PARTS_ISO_MARKERS = ["isoWeekYear", "isoWeek", "isoDayOfWeek"] as const;
export const DATE_OPTION_ORDER = ["binSize", "timezone", "startOfWeek"] as const;

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

export const SORT_KEY_LIMIT = 32;

export const singleArrayArg = (operand: unknown): unknown => (Array.isArray(operand) ? [operand] : operand);
export const sizeOf = (a: unknown): unknown => (Array.isArray(a) ? a.length : { $size: a });
export const firstOf = (a: unknown): Record<string, unknown> => ({ $first: singleArrayArg(a) });
export const lastOf = (a: unknown): Record<string, unknown> => ({ $last: singleArrayArg(a) });
export const reverseArrayOf = (a: unknown): Record<string, unknown> => ({ $reverseArray: singleArrayArg(a) });

export const slotAggregate = (
  op: string,
  recv: unknown,
  perDocument: (a: unknown) => unknown,
): Record<string, unknown> => ({ [op]: Array.isArray(recv) ? perDocument(recv) : recv });

export const negate = (n: unknown): unknown => (typeof n === "number" ? -n : { $subtract: [0, n] });

export const propertyKeyExpr = (key: unknown): unknown => ({ $toString: { $ifNull: [key, ""] } });

export const stringKeyExpr = (value: unknown): unknown => ({ $ifNull: [{ $toString: value }, "null"] });

export type Iter = { as: string; ref: string; in: unknown };

export const distinctKeysExpr = (arr: unknown, it: Iter): unknown => ({
  $setUnion: [{ $map: { input: arr, as: it.as, in: stringKeyExpr(it.in) } }, []],
});
export const iterateeKeys = (arr: unknown, it: Iter): unknown => ({ $map: { input: arr, as: it.as, in: it.in } });

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

export function resolveSliceIndex(node: Expr, lowered: unknown, size: unknown): unknown {
  const lit = literalIndexValue(node);
  if (lit !== null) {
    if (lit === 0) return 0;
    if (lit > 0) return { $min: [lit, size] };
    return { $max: [{ $subtract: [size, -lit] }, 0] };
  }
  return { $cond: [{ $lt: [lowered, 0] }, { $max: [{ $add: [lowered, size] }, 0] }, { $min: [lowered, size] }] };
}

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

export const joinedWith = (recv: unknown, separator: unknown): unknown => {
  const piece = cond(isNullish("$$this"), "", { $toString: "$$this" });
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

export const indexedPairs = (arr: unknown): Record<string, unknown> => ({
  $zip: { inputs: [{ $range: [0, sizeOf(arr)] }, arr] },
});

export const atPrecision = (op: "$ceil" | "$floor", value: unknown, precision: unknown): unknown => {
  const scale = typeof precision === "number" ? 10 ** precision : { $pow: [10, precision] };
  return { $divide: [{ [op]: { $multiply: [value, scale] } }, scale] };
};

export const cbrt = (v: unknown): Record<string, unknown> => ({
  $multiply: [{ $cmp: [v, 0] }, { $pow: [{ $abs: v }, 1 / 3] }],
});

export const isFiniteNumber = (v: unknown): Record<string, unknown> => ({
  $and: [{ $isNumber: v }, { $not: [{ $in: [{ $toString: v }, ["NaN", "Infinity", "-Infinity"]] }] }],
});

export const pairsToObject = (pairs: unknown): unknown => ({
  $arrayToObject: {
    $map: { input: pairs, in: [{ $toString: { $first: "$$this" } }, { $arrayElemAt: ["$$this", 1] }] },
  },
});

const CARRIES_ROOT = new WeakSet<object>();

export function carriesRoot<T extends object>(o: T): T {
  CARRIES_ROOT.add(o);
  return o;
}

export const isRootCarrier = (o: object): boolean => CARRIES_ROOT.has(o);
