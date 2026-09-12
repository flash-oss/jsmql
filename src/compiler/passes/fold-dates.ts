// What a date computes when it is a constant.
//
// Every rule here answers in UTC and JavaScript's own numbering, because a
// JavaScript spelling gets JavaScript's behaviour — the runtime cells shift
// MongoDB's 1-based `$month` and `$dayOfWeek` the same way:
//   new Date("2020-03-05…").getMonth()   →  2   (March; `$month` would say 3)
//   new Date("2020-03-05…").getDay()     →  4   (Thursday; `$dayOfWeek` would say 5)
//   new Date("2020-03-05…").getHours()   →  20  the LOCAL-sounding getters read
//                                              UTC, because `$hour` does
// A getter that read local time would answer differently on every machine that
// compiled the same query, which is reason enough on its own.
//
// The methods that answer a DATE — `.plus`, `.startOf`, `.set` — fold as well,
// and they fold to what the SERVER computes, measured on mongod, because a
// folded value replaces the operator the server would have run:
//   .plus(1, "month") from 31 January   →  29 February   ($dateAdd clamps to the month's last day)
//   .startOf("week")                    →  the Sunday    ($dateTrunc's default week start)
//   .diff(other, "day")                 →  the midnights crossed, not the 24-hour spans
// A form that names a TIMEZONE, a bin size or a week start is left to the server:
// a named zone shifts with daylight saving, and the table of zones is the server's.

import type { Evaluation } from "./evaluate.ts";

const NO: Evaluation = { ok: false };
const ok = (value: unknown): Evaluation => ({ ok: true, value });
/** A computed instant, or nothing when the arithmetic left the range a Date can hold. */
const dateOk = (d: Date): Evaluation => (Number.isNaN(d.getTime()) ? NO : ok(d));

const DAY = 86_400_000;

/** The units `$dateAdd`, `$dateTrunc` and `$dateDiff` take, with the length of the fixed ones. */
const FIXED_MS = { week: 7 * DAY, day: DAY, hour: 3_600_000, minute: 60_000, second: 1000, millisecond: 1 } as const;
const MONTHS_IN = { year: 12, quarter: 3, month: 1 } as const;
type Unit = keyof typeof FIXED_MS | keyof typeof MONTHS_IN;
const isUnit = (u: unknown): u is Unit => typeof u === "string" && (u in FIXED_MS || u in MONTHS_IN);

/**
 * An instant from UTC calendar parts, with JavaScript's roll-over of a part out
 * of range. Not `Date.UTC`, which reads a year below 100 as 19xx.
 */
function utc(year: number, month: number, day: number, h = 0, mi = 0, s = 0, ms = 0): Date {
  const t = new Date(0);
  t.setUTCFullYear(year, month, day);
  t.setUTCHours(h, mi, s, ms);
  return t;
}

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

const isoWeekYearOf = (d: Date): number => isoThursday(d).getUTCFullYear();

/** `$isoWeek`: the week holding the year's first Thursday is week 1. */
function isoWeekOf(d: Date): number {
  const thursday = isoThursday(d);
  const firstThursday = Date.UTC(thursday.getUTCFullYear(), 0, 4);
  const firstThursdayWeekStart = firstThursday - (isoWeekday(new Date(firstThursday)) - 1) * DAY;
  return Math.round((midnight(thursday) - isoWeekday(thursday) * DAY + DAY - firstThursdayWeekStart) / (7 * DAY)) + 1;
}

/** `$week`: weeks start on Sunday, and the days before the first Sunday of the year are week 0. */
function weekOf(d: Date): number {
  const jan1 = Date.UTC(d.getUTCFullYear(), 0, 1);
  const firstSunday = jan1 + ((7 - new Date(jan1).getUTCDay()) % 7) * DAY;
  const days = Math.round((midnight(d) - firstSunday) / DAY);
  return days < 0 ? 0 : Math.floor(days / 7) + 1;
}

const dayOfYearOf = (d: Date): number => Math.round((midnight(d) - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY) + 1;

// ── the operators' arithmetic ────────────────────────────────────────────────

/**
 * `$dateAdd` / `$dateSubtract`. A calendar unit moves the month and keeps the
 * day, clamped to the target month's last day: 31 January + 1 month is 29
 * February in a leap year. A fixed unit moves the instant.
 */
function shift(d: Date, unit: Unit, amount: number): Date {
  if (unit in MONTHS_IN) {
    const month = d.getUTCMonth() + MONTHS_IN[unit as keyof typeof MONTHS_IN] * amount;
    const lastDay = utc(d.getUTCFullYear(), month + 1, 0).getUTCDate();
    const day = Math.min(d.getUTCDate(), lastDay);
    return utc(
      d.getUTCFullYear(),
      month,
      day,
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
      d.getUTCMilliseconds(),
    );
  }
  return new Date(d.getTime() + amount * FIXED_MS[unit as keyof typeof FIXED_MS]);
}

/** `$dateTrunc` with a bin of one and the week starting on Sunday. */
function truncate(d: Date, unit: Unit): Date {
  switch (unit) {
    case "year":
      return utc(d.getUTCFullYear(), 0, 1);
    case "quarter":
      return utc(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1);
    case "month":
      return utc(d.getUTCFullYear(), d.getUTCMonth(), 1);
    case "week":
      return new Date(midnight(d) - d.getUTCDay() * DAY);
    default: {
      const ms = FIXED_MS[unit];
      return new Date(Math.floor(d.getTime() / ms) * ms);
    }
  }
}

/** `$dateDiff`: the number of unit BOUNDARIES crossed from `start` to `end` — one day from 23:59 to 00:01. */
function boundariesBetween(start: Date, end: Date, unit: Unit): number {
  switch (unit) {
    case "year":
      return end.getUTCFullYear() - start.getUTCFullYear();
    case "quarter":
      return quarterIndex(end) - quarterIndex(start);
    case "month":
      return end.getUTCFullYear() * 12 + end.getUTCMonth() - (start.getUTCFullYear() * 12 + start.getUTCMonth());
    default:
      return Math.round((truncate(end, unit).getTime() - truncate(start, unit).getTime()) / FIXED_MS[unit]);
  }
}
const quarterIndex = (d: Date): number => d.getUTCFullYear() * 4 + Math.floor(d.getUTCMonth() / 3);

// ── $dateToString ────────────────────────────────────────────────────────────

const pad = (n: number, width: number): string => String(n).padStart(width, "0");

/**
 * `$dateToString` for a constant date, or null for a specifier outside the set
 * the row accepts (the row and the server refuse others — `%e`, a trailing `%`)
 * or a year outside the four digits it prints. Refusing to fold leaves the call
 * where it is, so the refusal reaches the developer.
 */
function formatDate(d: Date, format: string): string | null {
  const year = d.getUTCFullYear();
  if (year < 1000 || year > 9999) return null;
  let out = "";
  for (let i = 0; i < format.length; i++) {
    const c = format[i] as string;
    if (c !== "%") {
      out += c;
      continue;
    }
    const spec = format[++i];
    switch (spec) {
      case "Y":
        out += pad(year, 4);
        break;
      case "G":
        out += pad(isoWeekYearOf(d), 4);
        break;
      case "m":
        out += pad(d.getUTCMonth() + 1, 2);
        break;
      case "d":
        out += pad(d.getUTCDate(), 2);
        break;
      case "H":
        out += pad(d.getUTCHours(), 2);
        break;
      case "M":
        out += pad(d.getUTCMinutes(), 2);
        break;
      case "S":
        out += pad(d.getUTCSeconds(), 2);
        break;
      case "L":
        out += pad(d.getUTCMilliseconds(), 3);
        break;
      case "j":
        out += pad(dayOfYearOf(d), 3);
        break;
      case "w":
        out += String(d.getUTCDay() + 1);
        break;
      case "u":
        out += String(isoWeekday(d));
        break;
      case "U":
        out += pad(weekOf(d), 2);
        break;
      case "V":
        out += pad(isoWeekOf(d), 2);
        break;
      case "z":
        out += "+0000";
        break;
      case "Z":
        out += "0";
        break;
      case "%":
        out += "%";
        break;
      default:
        return null;
    }
  }
  return out;
}

// ── $dateFromParts ───────────────────────────────────────────────────────────

const CALENDAR_PARTS = ["year", "month", "day"] as const;
const ISO_PARTS = ["isoWeekYear", "isoWeek", "isoDayOfWeek"] as const;
const TIME_PARTS = ["hour", "minute", "second", "millisecond"] as const;

/**
 * `.set({ parts })`: the named parts replace the date's own, the rest are read
 * from it — `$dateToParts` into `$dateFromParts`. A part out of range rolls over
 * as the server rolls it (month 13 is January of the next year). Null where the
 * server would refuse: a key it has no part for, ISO and calendar parts mixed, a
 * year outside 1–9999, any other part outside a 16-bit integer.
 */
function setParts(d: Date, parts: Record<string, unknown>): Date | null {
  const keys = Object.keys(parts);
  const known: readonly string[] = [...CALENDAR_PARTS, ...ISO_PARTS, ...TIME_PARTS];
  if (keys.some((k) => !known.includes(k))) return null;
  const iso = keys.some((k) => (ISO_PARTS as readonly string[]).includes(k));
  if (iso && keys.some((k) => (CALENDAR_PARTS as readonly string[]).includes(k))) return null;
  for (const k of keys) {
    const v = parts[k];
    if (typeof v !== "number" || !Number.isInteger(v)) return null;
    if (k === "year" || k === "isoWeekYear" ? v < 1 || v > 9999 : v < -32768 || v > 32767) return null;
  }
  const part = (k: string, own: number): number => (typeof parts[k] === "number" ? (parts[k] as number) : own);
  const h = part("hour", d.getUTCHours());
  const mi = part("minute", d.getUTCMinutes());
  const s = part("second", d.getUTCSeconds());
  const ms = part("millisecond", d.getUTCMilliseconds());
  if (!iso) {
    return utc(
      part("year", d.getUTCFullYear()),
      part("month", d.getUTCMonth() + 1) - 1,
      part("day", d.getUTCDate()),
      h,
      mi,
      s,
      ms,
    );
  }
  const weekYear = part("isoWeekYear", isoWeekYearOf(d));
  const week = part("isoWeek", isoWeekOf(d));
  const weekday = part("isoDayOfWeek", isoWeekday(d));
  // Week 1 holds 4 January; its Monday anchors the year.
  const jan4 = utc(weekYear, 0, 4);
  const monday = jan4.getTime() - (isoWeekday(jan4) - 1) * DAY;
  const days = (week - 1) * 7 + (weekday - 1);
  return new Date(monday + days * DAY + h * FIXED_MS.hour + mi * FIXED_MS.minute + s * FIXED_MS.second + ms);
}

// ── the table ────────────────────────────────────────────────────────────────

/**
 * A date method on a constant receiver.
 *
 * `{ ok: false }` means the method, or the form it is called in, is not one this
 * knows; the caller leaves the call to run on the server. Every form that names
 * a timezone or another option is such a form.
 */
export function foldDateMethod(d: Date, name: string, args: readonly unknown[]): Evaluation {
  if (args.length === 0) return getter(d, name);
  const [first, second] = args;
  switch (name) {
    case "plus":
    case "minus":
      if (args.length !== 2 || !isUnit(second) || typeof first !== "number" || !Number.isInteger(first)) return NO;
      return dateOk(shift(d, second, name === "plus" ? first : -first));
    case "startOf":
      return args.length === 1 && isUnit(first) ? dateOk(truncate(d, first)) : NO;
    case "endOf":
      // the start of the next bucket, one millisecond back
      return args.length === 1 && isUnit(first)
        ? dateOk(new Date(shift(truncate(d, first), first, 1).getTime() - 1))
        : NO;
    case "diff":
      if (args.length !== 2 || !(first instanceof Date) || !isUnit(second)) return NO;
      return ok(boundariesBetween(first, d, second));
    case "isSame":
    case "isBefore":
    case "isAfter": {
      if (args.length !== 2 || !(first instanceof Date) || !isUnit(second)) return NO;
      const mine = truncate(d, second).getTime();
      const theirs = truncate(first, second).getTime();
      return ok(name === "isSame" ? mine === theirs : name === "isBefore" ? mine < theirs : mine > theirs);
    }
    case "format": {
      if (args.length !== 1 || typeof first !== "string") return NO;
      const out = formatDate(d, first);
      return out === null ? NO : ok(out);
    }
    case "set": {
      if (args.length !== 1 || first === null || typeof first !== "object" || Array.isArray(first)) return NO;
      const out = setParts(d, first as Record<string, unknown>);
      return out === null ? NO : dateOk(out);
    }
    default:
      return NO;
  }
}

/** The zero-argument reads. */
function getter(d: Date, name: string): Evaluation {
  switch (name) {
    case "getFullYear":
    case "getUTCFullYear":
      return ok(d.getUTCFullYear());
    case "getMonth":
    case "getUTCMonth":
      return ok(d.getUTCMonth());
    case "getDate":
    case "getUTCDate":
      return ok(d.getUTCDate());
    case "getDay":
    case "getUTCDay":
      return ok(d.getUTCDay());
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
      return ok(dayOfYearOf(d));
    case "isoWeekday":
      return ok(isoWeekday(d));
    case "isoWeekYear":
      return ok(isoWeekYearOf(d));
    case "isoWeek":
      return ok(isoWeekOf(d));
    case "week":
      return ok(weekOf(d));
    default:
      return NO;
  }
}

/**
 * `new Date(…)` with constant arguments.
 *
 * The calendar-parts form counts months from ZERO and rolls an out-of-range part
 * over, exactly as JavaScript does — `new Date(2020, 1, 1)` is February, and
 * `new Date(2024, 12, 1)` is January 2025. The runtime cell adds one for
 * `$dateFromParts`, which counts from one and rolls over the same way.
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
  return ok(new Date(Date.UTC(year, month, day, hour, minute, second, ms)));
}

/**
 * `Date.UTC(…)` — the same parts, answered as a number of milliseconds.
 *
 * ONE number is a YEAR here, where `new Date(n)` reads it as milliseconds:
 * `Date.UTC(2020)` is 1577836800000 in JavaScript and `$toLong($dateFromParts
 * { year: 2020 })` here. Routed through the parts form so the two spellings
 * cannot disagree.
 */
export function foldDateUTC(args: readonly unknown[]): Evaluation {
  const parts = args.length === 1 && typeof args[0] === "number" ? [args[0], 0] : args;
  const date = foldNewDate(parts);
  return date.ok ? ok((date.value as Date).getTime()) : NO;
}
