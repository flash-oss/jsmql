// Date methods — the arithmetic, comparison, formatting and part-reading vocabulary.
//
// The 16 component accessors JavaScript already has (`.getFullYear()`, `.getUTCHours()`, …)
// live in `date-accessors.ts`; this file holds everything JavaScript does NOT have, under
// the names Moment, Luxon and Temporal gave them.
//
// One rule runs through the whole family: the LAST argument is always the options argument,
// and it is either a timezone string (the shorthand — `.plus(2, "hour", "America/New_York")`)
// or an object literal whose keys are the operator's own remaining fields. `dateOptions` in
// `src/mql-date.ts` owns it, so a method that grows a field needs no new argument slot.
//
// Every literal slot is gated with the same helpers the `$op(...)` path uses, so a unit
// enum or an integer amount errors identically whichever spelling the user reached for.
//
// See docs/specs/method-dispatch.md § Date methods.

import { checkEnum, objectInfo } from "../literal-gate.ts";
import { didYouMean } from "../levenshtein.ts";
import {
  checkDateFormat,
  DATE_PART_OPERATOR,
  DATE_PARTS_CALENDAR,
  DATE_PARTS_CALENDAR_MARKERS,
  DATE_PARTS_ISO,
  DATE_PARTS_ISO_MARKERS,
  dateOptions,
} from "../mql-date.ts";
import { checkArgType, TIME_UNIT } from "../operator-validation.ts";
import type { MethodDef } from "./types.ts";

/**
 * `.plus(amount, unit[, timezone])` → `$dateAdd`; `.minus(...)` → `$dateSubtract`.
 *
 * The Temporal/Luxon method name with Moment's `(amount, unit)` argument order — both map
 * one-to-one onto the operator's fields.
 */
function shifter(kind: "plus" | "minus"): MethodDef {
  return {
    receiver: "date",
    args: { sig: "amount, unit[, timezone]", allowed: [2, 3] },
    value: ({ recv, args, gen }) => {
      checkEnum(`.${kind}`, "unit", args[1], TIME_UNIT);
      checkArgType(`.${kind}`, "amount", args[0], "int-or-long");
      return {
        [kind === "plus" ? "$dateAdd" : "$dateSubtract"]: {
          startDate: recv,
          unit: gen(args[1]),
          amount: gen(args[0]),
          ...dateOptions(kind, args[2], ["timezone"], gen),
        },
      };
    },
  };
}

/**
 * `.isSame` / `.isBefore` / `.isAfter` — compare two dates at a GRANULARITY: truncate both
 * to the unit, then compare.
 *
 * The unit is what earns the method. Without one these are `===`, `<` and `>`, which JSMQL
 * already has, so a unit-less call is pointed back at the operator rather than lowered.
 */
function comparer(kind: "isSame" | "isBefore" | "isAfter"): MethodDef {
  const jsOp = kind === "isSame" ? "===" : kind === "isBefore" ? "<" : ">";
  const cmp = kind === "isSame" ? "$eq" : kind === "isBefore" ? "$lt" : "$gt";
  return {
    receiver: "date",
    returns: "bool",
    args: {
      sig: "other, unit[, timezone]",
      allowed: [2, 3],
      // The unit is what earns the method, so the one-argument form gets the reason rather
      // than a count. See the `reject` field in src/arity.ts.
      reject: {
        1:
          `.${kind}(other) without a unit is just '${jsOp}' — write 'a ${jsOp} b'. ` +
          `Pass a unit to compare at that granularity instead: .${kind}(other, "day").`,
      },
    },
    value: ({ recv, args, gen }) => {
      checkArgType(`.${kind}`, "other", args[0], "date");
      checkEnum(`.${kind}`, "unit", args[1], TIME_UNIT);
      const bucketOf = (date: unknown): unknown => ({
        $dateTrunc: {
          date,
          unit: gen(args[1]),
          ...dateOptions(kind, args[2], ["binSize", "timezone", "startOfWeek"], gen),
        },
      });
      return { [cmp]: [bucketOf(recv), bucketOf(gen(args[0]))] };
    },
  };
}

/**
 * The date parts JavaScript has no getter for.
 *
 * There is no JS convention to honour, so these follow MQL's own numbering — which is also
 * Moment's for the ISO parts (`.isoWeekday()` → 1 = Monday … 7 = Sunday).
 */
function datePart(method: string): MethodDef {
  return {
    receiver: "date",
    returns: "number",
    args: { sig: "[timezone]", allowed: [0, 1] },
    value: ({ recv, args, gen }) => {
      const opts = dateOptions(method, args[0], ["timezone"], gen);
      const operand = opts.timezone === undefined ? recv : { date: recv, ...opts };
      const op = DATE_PART_OPERATOR[method];
      // MongoDB has no `$quarter`. `$ceil` of a `$divide` is a double, so `$toInt` keeps
      // the result an int like every other date getter.
      return op === undefined ? { $toInt: { $ceil: { $divide: [{ $month: operand }, 3] } } } : { [op]: operand };
    },
  };
}

export const DATE_METHODS: Record<string, MethodDef> = {
  getTime: {
    // NOT date-only, unlike every other method in this file. `$toLong` converts a string or
    // a number too, and jsmql does not take that away — so the receiver is unconstrained and
    // one cell serves all of it. (JavaScript puts `.getTime()` on `Date` alone; the chain
    // type-check declines to gate what the lowering genuinely accepts.)
    receiver: "any",
    returns: "number",
    args: { sig: "", none: true },
    // Match JS: milliseconds since the epoch, already UTC (there is no `getUTCTime`).
    value: ({ recv }) => ({ $toLong: recv }),
  },

  toISOString: {
    receiver: "date",
    returns: "string",
    args: { sig: "", none: true },
    // `%Y-%m-%dT%H:%M:%S.%LZ` IS `$dateToString`'s default format, so naming it would only
    // restate the default. Verified identical on a live mongod.
    value: ({ recv }) => ({ $dateToString: { date: recv } }),
  },

  plus: shifter("plus"),
  minus: shifter("minus"),

  isSame: comparer("isSame"),
  isBefore: comparer("isBefore"),
  isAfter: comparer("isAfter"),

  week: datePart("week"),
  isoWeek: datePart("isoWeek"),
  isoWeekYear: datePart("isoWeekYear"),
  isoWeekday: datePart("isoWeekday"),
  dayOfYear: datePart("dayOfYear"),
  quarter: datePart("quarter"),

  format: {
    receiver: "date",
    returns: "string",
    args: { sig: "format[, timezone]", allowed: [1, 2] },
    // `d.format(fmt)` → `$dateToString`: Moment's method name with MongoDB's own format
    // specifiers (`%Y-%m-%d`). Translating Moment's token dialect would dead-end on the
    // tokens MQL has no equivalent for, so the specifiers stay MQL's and a token-dialect
    // string is rejected WITH the translation.
    value: ({ recv, args, gen }) => {
      checkArgType(".format", "format", args[0], "string");
      checkDateFormat(".format", args[0]);
      return {
        $dateToString: { date: recv, format: gen(args[0]), ...dateOptions("format", args[1], ["timezone"], gen) },
      };
    },
  },

  startOf: {
    receiver: "date",
    args: { sig: "unit[, timezone]", allowed: [1, 2] },
    // `$dateTrunc` — the bucket key every time-series `$group` wants. Moment, Luxon and
    // date-fns all spell it this way.
    value: ({ recv, args, gen }) => {
      checkEnum(".startOf", "unit", args[0], TIME_UNIT);
      return {
        $dateTrunc: {
          date: recv,
          unit: gen(args[0]),
          ...dateOptions("startOf", args[1], ["binSize", "timezone", "startOfWeek"], gen),
        },
      };
    },
  },

  endOf: {
    receiver: "date",
    args: { sig: "unit[, timezone]", allowed: [1, 2] },
    // MongoDB has no ceiling operator, so this is the truncate → add one unit → step back
    // 1 ms composition, which lands on Moment's inclusive 23:59:59.999-style end. `binSize`
    // makes the step the whole bin; only `timezone` carries to the `$dateAdd` (which has no
    // binSize/startOfWeek field), and the final millisecond is absolute.
    value: ({ recv, args, gen }) => {
      checkEnum(".endOf", "unit", args[0], TIME_UNIT);
      const opts = dateOptions("endOf", args[1], ["binSize", "timezone", "startOfWeek"], gen);
      const step: Record<string, unknown> = {
        startDate: { $dateTrunc: { date: recv, unit: gen(args[0]), ...opts } },
        unit: gen(args[0]),
        amount: opts.binSize ?? 1,
      };
      if (opts.timezone !== undefined) step.timezone = opts.timezone;
      return { $dateSubtract: { startDate: { $dateAdd: step }, unit: "millisecond", amount: 1 } };
    },
  },

  diff: {
    receiver: "date",
    returns: "number",
    args: { sig: "other, unit[, timezone]", allowed: [2, 3] },
    // `end.diff(start, unit)` → `$dateDiff`. The RECEIVER is the later date (the operator's
    // endDate), so the result is receiver − argument — the direction Moment's `.diff`,
    // Luxon's `.diff` and Temporal's `.since` all agree on.
    value: ({ recv, args, gen }) => {
      checkArgType(".diff", "other", args[0], "date");
      checkEnum(".diff", "unit", args[1], TIME_UNIT);
      return {
        $dateDiff: {
          startDate: gen(args[0]),
          endDate: recv,
          unit: gen(args[1]),
          ...dateOptions("diff", args[2], ["timezone", "startOfWeek"], gen),
        },
      };
    },
  },

  set: {
    receiver: "date",
    args: { sig: "{ parts }[, timezone]", allowed: [1, 2] },
    // `d.set({ year: 2030 })` — read the parts, override the named ones, rebuild. Luxon's
    // `.set` (Temporal's `.with`), immutable like every jsmql method. Months are 1-based
    // here, the same base `.getMonth()` and `$month` use.
    value: ({ recv, args, gen, internalVar, err }) => {
      const info = objectInfo(args[0]);
      if (info === null || info.hasSpread) {
        throw err(
          `.set({ … }) needs an object literal with plain keys (${DATE_PARTS_CALENDAR.join(", ")}) — ` +
            `MongoDB reads the parts by name, so a spread or computed key can't be resolved at compile ` +
            `time. Spell the keys and pass field paths or parameters as their values.`,
          args[0].pos,
        );
      }
      const tzArg = info.byKey.get("timezone");
      if (tzArg !== undefined) {
        throw err(
          `.set({ … }) takes date parts only — the timezone is the second argument: ` +
            `.set({ … }, "America/New_York").`,
          tzArg.pos,
        );
      }
      const keys = [...info.byKey.keys()];
      const isoKey = keys.find((k) => DATE_PARTS_ISO_MARKERS.includes(k));
      const calKey = keys.find((k) => DATE_PARTS_CALENDAR_MARKERS.includes(k));
      if (isoKey !== undefined && calKey !== undefined) {
        throw err(
          `.set({ … }) can't mix ISO-week parts with calendar parts ('${isoKey}' with '${calKey}') — ` +
            `MongoDB builds a date from one family or the other. Use ${DATE_PARTS_CALENDAR_MARKERS.join("/")} ` +
            `or ${DATE_PARTS_ISO_MARKERS.join("/")}, plus any of hour/minute/second/millisecond.`,
          info.byKey.get(isoKey)!.pos,
        );
      }
      const family: readonly string[] = isoKey !== undefined ? DATE_PARTS_ISO : DATE_PARTS_CALENDAR;
      for (const [key, value] of info.byKey) {
        if (family.includes(key)) continue;
        throw err(
          `.set({ … }) has no date part '${key}'.${didYouMean(key, family, (s) => s)} ` +
            `Valid parts: ${family.join(", ")}.`,
          value.pos,
        );
      }
      const tz = dateOptions("set", args[1], ["timezone"], gen);
      // Every part overridden → nothing to read back, so no `$let` / `$dateToParts`.
      const complete = family.every((k) => info.byKey.has(k));
      const [partsVar, partsRef] = complete ? ["", ""] : internalVar("parts");
      const rebuilt: Record<string, unknown> = {};
      for (const key of family) {
        const value = info.byKey.get(key);
        if (value !== undefined) checkArgType(".set", key, value, "int-or-long");
        rebuilt[key] = value !== undefined ? gen(value) : `${partsRef}.${key}`;
      }
      const fromParts = { $dateFromParts: { ...rebuilt, ...tz } };
      if (complete) return fromParts;
      const toParts: Record<string, unknown> = { date: recv, ...tz };
      if (isoKey !== undefined) toParts.iso8601 = true;
      return { $let: { vars: { [partsVar]: { $dateToParts: toParts } }, in: fromParts } };
    },
  },
};
