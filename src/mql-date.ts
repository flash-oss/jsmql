// Date-method shapes: the trailing options argument, the `.set()` part families, the
// `.format()` specifier gate, and the date parts JavaScript has no getter for.
//
// A LEAF: it imports only other leaves. `dateOptions` reads an AST node AND lowers it, so
// it takes a `Gen` — the function, not the `GenerateCtx` that carries it. Everything else
// here is a constant or a literal gate.
//
// See docs/specs/method-dispatch.md § Date methods.

import type { Expr } from "./ast.ts";
import { CodegenError } from "./errors.ts";
import { didYouMean } from "./levenshtein.ts";
import { litString, objectInfo } from "./literal-gate.ts";
import type { Gen } from "./mql-shape.ts";
import { checkArgEnum, checkArgType } from "./operator-validation.ts";

// ── The trailing options argument of a date method ────────────────────────────
// Every date method takes the same optional last argument: a timezone string
// (the shorthand, which is what `.plus(2, "hour", "America/New_York")` uses), or
// an object literal whose keys are the operator's own remaining fields. One rule
// across the family, so a method that grows a field needs no new argument slot.
// See docs/specs/method-dispatch.md § Date methods.

/** Per-key literal gate, reusing the operator path's helpers so both spellings
 *  error identically. Every entry no-ops on a non-literal. */
export const DATE_OPTION_CHECK: Record<string, (label: string, value: Expr) => void> = {
  binSize: (l, v) => checkArgType(l, "binSize", v, "number"),
  timezone: (l, v) => checkArgType(l, "timezone", v, "string"),
  startOfWeek: (l, v) => checkArgEnum(l, "startOfWeek", v, "weekday"),
};

/** Emit order: the operators' own field order, so output reads like the manual.
 *  No operator carries more than three of these, so one total order serves all. */
export const DATE_OPTION_ORDER = ["binSize", "timezone", "startOfWeek"] as const;

export type DateOptionKey = (typeof DATE_OPTION_ORDER)[number];

// ── .set(): the two $dateFromParts families ───────────────────────────────────
// The operator takes calendar parts OR ISO-week parts, never both — mongod says
// "$dateFromParts does not allow mixing natural dates with ISO dates". Listed in
// the operator's own field order; the four time parts belong to both.
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
// The keys that decide which family a `.set({ … })` call is in.
export const DATE_PARTS_ISO_MARKERS = ["isoWeekYear", "isoWeek", "isoDayOfWeek"];
export const DATE_PARTS_CALENDAR_MARKERS = ["year", "month", "day"];

// The MQL date parts JavaScript's `Date` has no getter for, under the method
// names Moment gives them. Each operator takes a bare date, or the
// `{ date, timezone }` form when a timezone is passed.
export const DATE_PART_OPERATOR: Record<string, string> = {
  week: "$week",
  isoWeek: "$isoWeek",
  isoWeekYear: "$isoWeekYear",
  isoWeekday: "$isoDayOfWeek",
  dayOfYear: "$dayOfYear",
};

// ── .format(): MongoDB's own format specifiers ────────────────────────────────
// The characters `$dateToString` accepts after a `%`. Verified against mongod,
// which fails an unknown one at execution time ("Invalid format character
// '%Q'"), so a literal typo is a certain error and belongs at compile time.
export const DATE_FORMAT_SPECIFIERS = "dGHjLmMSuUVwYzZ%";

// Moment / Luxon format tokens paired with the MQL specifier that does the same
// job, or `null` where MongoDB has none. Scanned longest-first and left to right,
// so `MMM` is consumed whole rather than leaving an `M` behind after `MM`.
export const MOMENT_FORMAT_TOKENS: readonly (readonly [string, string | null])[] = [
  ["YYYY", "%Y"],
  ["MMMM", null], // month name
  ["dddd", null], // weekday name
  ["MMM", null],
  ["ddd", null],
  ["DDD", "%j"],
  ["SSS", "%L"],
  ["YY", null], // 2-digit year
  ["MM", "%m"],
  ["DD", "%d"],
  ["HH", "%H"],
  ["hh", null], // 12-hour clock
  ["ZZ", "%z"],
  ["mm", "%M"],
  ["ss", "%S"],
  ["Do", null], // ordinal day
];

// Does this look like a Moment/Luxon format rather than an MQL one? Such a
// string IS valid MQL — it formats as its own literal text — so nothing but the
// token spelling reveals the mistake, and the mistake is silent otherwise.
export const MOMENT_FORMAT_RE = /YYYY|YY|MMMM|MMM|MM|DDD|DD|dddd|ddd|HH|hh|mm|ss|SSS|ZZ|Do/;

/**
 * Translate a Moment/Luxon format to MQL specifiers for the error message —
 * never for output. Offers the translation only when nothing is left
 * untranslated: what survives the scan is found by stripping the `%X` pairs and
 * looking for remaining letters, so a token MongoDB has no specifier for gets
 * named rather than silently dropped from a suggestion.
 */
function momentFormatHint(fmt: string): string {
  let out = "";
  let i = 0;
  outer: while (i < fmt.length) {
    for (const [token, spec] of MOMENT_FORMAT_TOKENS) {
      if (!fmt.startsWith(token, i)) continue;
      out += spec ?? token;
      i += token.length;
      continue outer;
    }
    out += fmt[i];
    i++;
  }
  const missing = out.replace(/%./g, "").match(/[A-Za-z]+/g);
  if (missing === null) return ` Did you mean '${out}'?`;
  return (
    ` MongoDB has no format specifier for ${[...new Set(missing)].map((t) => `'${t}'`).join(", ")}: it outputs no ` +
    `month name, weekday name, 12-hour clock or 2-digit year. Derive those from the numeric parts ` +
    `(e.g. ["Jan", …][$.t.getMonth() - 1]).`
  );
}

/** Reject a literal `.format` string MongoDB would refuse, or one written in
 *  Moment's token dialect (valid MQL, but it formats as its own text). */
export function checkDateFormat(label: string, arg: Expr): void {
  const fmt = litString(arg);
  if (fmt === null) return;
  for (let i = 0; i < fmt.length; i++) {
    if (fmt[i] !== "%") continue;
    const spec = fmt[i + 1];
    if (spec === undefined || !DATE_FORMAT_SPECIFIERS.includes(spec)) {
      // The likeliest slip is the wrong case (`%y` for `%Y`), so try that first.
      const flip = spec === undefined ? undefined : flipCase(spec);
      const hint = flip !== undefined && DATE_FORMAT_SPECIFIERS.includes(flip) ? ` Did you mean '%${flip}'?` : "";
      throw new CodegenError(
        `'${label}' format has an invalid specifier '%${spec ?? ""}'.${hint} MongoDB accepts ` +
          `%Y %G %m %d %j %U %V %u %w %H %M %S %L %z %Z and %%.`,
        arg.pos,
      );
    }
    i++; // consume the specifier character
  }
  if (!fmt.includes("%") && MOMENT_FORMAT_RE.test(fmt)) {
    throw new CodegenError(
      `'${label}' takes MongoDB's date format specifiers, not Moment/Luxon tokens — ` +
        `'${fmt}' formats as that literal text, never a date.${momentFormatHint(fmt)}`,
      arg.pos,
    );
  }
}

function flipCase(ch: string): string {
  const up = ch.toUpperCase();
  return ch === up ? ch.toLowerCase() : up;
}

/**
 * Resolve a date method's trailing options argument into the operator fields it
 * contributes. `allowed` is the subset that method's operator accepts; an
 * unknown key is rejected with a suggestion rather than passed to mongod.
 *
 * A written-out object literal is the options form; **anything else** is the
 * timezone shorthand. That split is on what the argument *means*, not merely its
 * node type: MongoDB reads these fields by name from the operator document, so a
 * document of options only ever exists as source the compiler can read — a field
 * path or parameter in this slot can only be a runtime timezone string. Values
 * inside the literal stay free to be paths or parameters.
 */
export function dateOptions(
  method: string,
  arg: Expr | undefined,
  allowed: readonly DateOptionKey[],
  gen: Gen,
): Record<string, unknown> {
  if (arg === undefined) return {};
  const label = `.${method}`;
  if (arg.type !== "ObjectLiteral") {
    checkArgType(label, "timezone", arg, "string");
    return { timezone: gen(arg) };
  }
  const info = objectInfo(arg);
  if (info === null || info.hasSpread) {
    throw new CodegenError(
      `${label}(…) options must be an object literal with plain keys (${allowed.join(", ")}) — ` +
        `a spread or computed key can't be read at compile time, and MongoDB needs these field names ` +
        `written out. Spell the keys and pass field paths or parameters as their values.`,
      arg.pos,
    );
  }
  for (const [key, value] of info.byKey) {
    if (allowed.includes(key as DateOptionKey)) continue;
    throw new CodegenError(
      `${label}(…) has no option '${key}'.${didYouMean(key, allowed, (s) => s)} ` +
        `Valid options: ${allowed.join(", ")}.`,
      value.pos,
    );
  }
  const out: Record<string, unknown> = {};
  for (const key of DATE_OPTION_ORDER) {
    const value = info.byKey.get(key);
    if (value === undefined) continue;
    DATE_OPTION_CHECK[key](label, value);
    out[key] = gen(value);
  }
  return out;
}
