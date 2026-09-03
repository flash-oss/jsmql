// What a date computes when it is a constant.
//
// Every rule here answers in UTC and MongoDB's own numbering, because that is
// what the language means — measured, not assumed:
//   new Date("2020-03-05…").getMonth()   →  3   ($month is 1-based; JavaScript's
//                                              getUTCMonth is 0-based)
//   new Date("2020-03-05…").getDay()     →  5   ($dayOfWeek is 1 = Sunday, so a
//                                              Thursday is 5; JavaScript says 4)
//   new Date("2020-03-05…").getHours()   →  20  the LOCAL-sounding getters read
//                                              UTC, because `$hour` does
// A getter that read local time would answer differently on every machine that
// compiled the same query, which is reason enough on its own.

import type { Evaluation } from "./evaluate.ts";

const NO: Evaluation = { ok: false };
const ok = (value: unknown): Evaluation => ({ ok: true, value });

const DAY = 86_400_000;

/** Midnight UTC on the day `d` falls in. */
const midnight = (d: Date): number => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

/** 1 = Monday … 7 = Sunday, which is what `$isoDayOfWeek` answers. */
const isoWeekday = (d: Date): number => (d.getUTCDay() === 0 ? 7 : d.getUTCDay());

/** The Thursday of this date's ISO week — the year that week belongs to. */
function isoThursday(d: Date): Date {
  const shifted = new Date(midnight(d));
  shifted.setUTCDate(shifted.getUTCDate() + 4 - isoWeekday(d));
  return shifted;
}

/**
 * A date method on a constant receiver.
 *
 * `null` means the method is not one this knows; the caller leaves the call to
 * run on the server. That is the right answer for every date method whose value
 * is itself a date — `plus`, `startOf` — because a Date has no literal spelling,
 * so folding one buys nothing unless something reads a number out of it.
 */
export function foldDateMethod(d: Date, name: string, args: readonly unknown[]): Evaluation {
  if (args.length > 0) return NO;
  switch (name) {
    case "getFullYear":
    case "getUTCFullYear":
      return ok(d.getUTCFullYear());
    case "getMonth":
    case "getUTCMonth":
      // `$month` counts from 1.
      return ok(d.getUTCMonth() + 1);
    case "getDate":
    case "getUTCDate":
      return ok(d.getUTCDate());
    case "getDay":
    case "getUTCDay":
      // `$dayOfWeek` counts from 1, with Sunday first.
      return ok(d.getUTCDay() + 1);
    case "getHours":
    case "getUTCHours":
      return ok(d.getUTCHours());
    case "getMinutes":
    case "getUTCMinutes":
      return ok(d.getUTCMinutes());
    case "getSeconds":
    case "getUTCSeconds":
      return ok(d.getUTCSeconds());
    case "getMilliseconds":
    case "getUTCMilliseconds":
      return ok(d.getUTCMilliseconds());
    case "getTime":
      return ok(d.getTime());
    case "toISOString":
      return ok(d.toISOString());
    case "quarter":
      return ok(Math.floor(d.getUTCMonth() / 3) + 1);
    case "dayOfYear":
      return ok(Math.round((midnight(d) - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY) + 1);
    case "isoWeekday":
      return ok(isoWeekday(d));
    case "isoWeekYear":
      return ok(isoThursday(d).getUTCFullYear());
    case "isoWeek": {
      const thursday = isoThursday(d);
      const firstThursday = Date.UTC(thursday.getUTCFullYear(), 0, 4);
      const firstThursdayWeekStart = firstThursday - (isoWeekday(new Date(firstThursday)) - 1) * DAY;
      return ok(
        Math.round((midnight(thursday) - isoWeekday(thursday) * DAY + DAY - firstThursdayWeekStart) / (7 * DAY)) + 1,
      );
    }
    case "week": {
      // `$week`: weeks start on Sunday, and the days before the first Sunday of
      // the year are week 0.
      const jan1 = Date.UTC(d.getUTCFullYear(), 0, 1);
      const firstSunday = jan1 + ((7 - new Date(jan1).getUTCDay()) % 7) * DAY;
      const days = Math.round((midnight(d) - firstSunday) / DAY);
      return ok(days < 0 ? 0 : Math.floor(days / 7) + 1);
    }
    default:
      return NO;
  }
}

/**
 * `new Date(…)` with constant arguments.
 *
 * The calendar-parts form counts months from ONE, matching `$dateFromParts` and
 * every other month in the language — `new Date(2020, 1, 1)` is January here and
 * February in JavaScript.
 */
export function foldNewDate(args: readonly unknown[]): Evaluation {
  // `new Date()` reads the clock, so it is never a constant.
  if (args.length === 0) return NO;
  if (args.length === 1) {
    const [a] = args;
    if (typeof a === "number") return Number.isFinite(a) ? ok(new Date(a)) : NO;
    if (typeof a !== "string") return NO;
    const parsed = new Date(a);
    // An unparseable string is an error the language raises with a position.
    // Folding it to `Invalid Date` would swallow that.
    return Number.isNaN(parsed.getTime()) ? NO : ok(parsed);
  }
  if (!args.every((v) => typeof v === "number" && Number.isInteger(v))) return NO;
  const [year, month, day = 1, hour = 0, minute = 0, second = 0, ms = 0] = args as number[];
  if (month < 1 || month > 12) return NO;
  return ok(new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms)));
}

/**
 * `Date.UTC(…)` — the same parts, answered as a number of milliseconds.
 *
 * ONE number is a YEAR here, where `new Date(n)` reads it as milliseconds:
 * `Date.UTC(2020)` is 1577836800000 in JavaScript and `$toLong($dateFromParts
 * { year: 2020 })` in the shipped compiler. Routed through the parts form so
 * the two spellings cannot disagree.
 */
export function foldDateUTC(args: readonly unknown[]): Evaluation {
  const parts = args.length === 1 && typeof args[0] === "number" ? [args[0], 1] : args;
  const date = foldNewDate(parts);
  return date.ok ? ok((date.value as Date).getTime()) : NO;
}
