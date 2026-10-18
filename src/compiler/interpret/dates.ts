// The date operators.
//
// A date here is a number of milliseconds since the epoch, and every rule works in
// UTC. The server runs a named time zone through a table that the interpreter does
// not hold, so a `timezone` operand runs only when it names UTC: `utcOnly` is the one
// place that states this. Every other value for it is a refusal.
//
// The calendar arithmetic uses integers only (`daysFromCivil`), so it is exact for
// every year that a JavaScript Date holds. The rules agree with the server on these
// points, each one measured and not assumed:
//   - `$dateAdd` clamps a day of month to the last day of the target month.
//   - `$dateTrunc` bins from 2000-01-01, and a week bin starts on `startOfWeek`
//     (Sunday by default), at the first such day on or after that anchor.
//   - `$dateDiff` counts the unit BOUNDARIES crossed, not the elapsed units.
//   - `$dateFromParts` carries a part out of range into the next part, and refuses a
//     part outside the range that the server accepts.
//   - `$dateToString` knows a fixed list of format specifiers and fails on another.
//   - A date string runs only in the few ISO 8601 spellings below. The server parser
//     accepts far more forms, and some of its answers differ, so every other string
//     is a refusal.
//   - `$toDate` of a number fails on the server when the number is an int. The kind
//     of a computed number is not known, so only a fraction or an integer beyond
//     32 bits runs.
// A result outside the range of a JavaScript Date is a refusal.
//
// See src/compiler/interpret/CLAUDE.md.

import type { Answer, Rule, Walk } from "./values.ts";
import { NO, isPlain, kindOf, ok } from "./values.ts";
import { argsOf, keyed, positional } from "./operand.ts";
import { bsonTagOf, objectIdHex } from "../../bson.ts";

// ── time ─────────────────────────────────────────────────────────────────────

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MAX_MS = 8.64e15;

/** Midnight UTC on 2000-01-01, the anchor of every `$dateTrunc` bin. It is a Saturday. */
const ANCHOR_MS = 946_684_800_000;
const ANCHOR_WEEKDAY = 6;

/** The answer for an instant, or a refusal when a JavaScript Date cannot hold it. */
const dateAt = (ms: number): Answer => (Number.isFinite(ms) && Math.abs(ms) <= MAX_MS ? ok(new Date(ms)) : NO);

/** Days since 1970-01-01 of a calendar date in the proleptic Gregorian calendar. */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

/** The calendar date of a day number: the inverse of `daysFromCivil`. */
function civilFromDays(days: number): { year: number; month: number; day: number } {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const dayOfEra = z - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36_524) - Math.floor(dayOfEra / 146_096)) / 365,
  );
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const shifted = Math.floor((5 * dayOfYear + 2) / 153);
  const month = shifted < 10 ? shifted + 3 : shifted - 9;
  return {
    year: yearOfEra + era * 400 + (month <= 2 ? 1 : 0),
    month,
    day: dayOfYear - Math.floor((153 * shifted + 2) / 5) + 1,
  };
}

const daysInMonth = (year: number, month: number): number =>
  daysFromCivil(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1, 1) - daysFromCivil(year, month, 1);

/** The calendar fields of an instant. `weekday` is 0 for Sunday. */
type Fields = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  days: number;
  weekday: number;
};

function fieldsOf(ms: number): Fields {
  const days = Math.floor(ms / DAY);
  const rest = ms - days * DAY;
  return {
    ...civilFromDays(days),
    hour: Math.floor(rest / HOUR),
    minute: Math.floor(rest / MINUTE) % 60,
    second: Math.floor(rest / SECOND) % 60,
    millisecond: rest % SECOND,
    days,
    weekday: (((days + 4) % 7) + 7) % 7,
  };
}

const isoWeekday = (weekday: number): number => (weekday === 0 ? 7 : weekday);

/** The ISO week and the year that the week belongs to: the year of the Thursday of the week. */
function isoWeekOf(f: Fields): { year: number; week: number } {
  const thursday = f.days + 4 - isoWeekday(f.weekday);
  const { year } = civilFromDays(thursday);
  return { year, week: Math.floor((thursday - daysFromCivil(year, 1, 1)) / 7) + 1 };
}

const dayOfYearOf = (f: Fields): number => f.days - daysFromCivil(f.year, 1, 1) + 1;

/** `$week`: weeks start on Sunday, and the days before the first Sunday of the year are week 0. */
const sundayWeekOf = (f: Fields): number => Math.floor((dayOfYearOf(f) - 1 + 7 - f.weekday) / 7);

// ── the operands ──────────────────────────────────────────────────────────────

/** The time zones that name UTC. Any other zone is a refusal. */
const UTC_ZONES: readonly string[] = ["UTC", "+00:00", "+0000"];
const utcOnly = (v: unknown): boolean => typeof v === "string" && UTC_ZONES.includes(v);

/**
 * The instant of a value that the server turns into a date: a Date, or an ObjectId, which
 * holds a time in seconds. Any other value is undefined.
 */
function instantOf(v: unknown): number | undefined {
  switch (kindOf(v)) {
    case "date":
      return (v as Date).getTime();
    case "objectId": {
      const hex = objectIdHex(v);
      return hex === null ? undefined : parseInt(hex.slice(0, 8), 16) * SECOND;
    }
    default:
      return undefined;
  }
}

const isInstant = (v: unknown): boolean => instantOf(v) !== undefined;
const isBoolean = (v: unknown): boolean => typeof v === "boolean";

/** An integer in the range, as a date part takes it. */
const integerIn =
  (low: number, high: number) =>
  (v: unknown): boolean =>
    typeof v === "number" && Number.isInteger(v) && v >= low && v <= high;

/** The units of `$dateAdd`, `$dateDiff` and `$dateTrunc`. */
const UNITS = ["year", "quarter", "month", "week", "day", "hour", "minute", "second", "millisecond"] as const;
type Unit = (typeof UNITS)[number];
const isUnit = (v: unknown): v is Unit => typeof v === "string" && (UNITS as readonly string[]).includes(v);

/** The length in milliseconds of every unit that has a fixed length. */
const FIXED_MS: Readonly<Record<string, number>> = {
  week: 7 * DAY,
  day: DAY,
  hour: HOUR,
  minute: MINUTE,
  second: SECOND,
  millisecond: 1,
};
/** The months in each calendar unit. */
const MONTHS_IN: Readonly<Record<string, number>> = { year: 12, quarter: 3, month: 1 };

/** The day that a week starts on, by name. The index is the weekday, with 0 for Sunday. */
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const isWeekdayName = (v: unknown): boolean => typeof v === "string" && WEEKDAYS.includes(v);
const startOfWeekOf = (v: Record<string, unknown>): number =>
  v.startOfWeek === undefined ? 0 : WEEKDAYS.indexOf(v.startOfWeek as string);

type Check = (v: unknown) => boolean;

/** `startOfWeek` matters to the week unit only. The server ignores it for any other unit, even a null. */
const nullWeekStart = (v: Record<string, unknown>): boolean => v.startOfWeek === null && v.unit !== "week";

/**
 * A keyed date operator. Every operand is evaluated, and the first one with no value
 * stops the walk. A null operand makes the answer null, but only when every other operand
 * is valid, because the server fails on an invalid operand beside a null one in some
 * cases and not in others. `shape` judges the written keys before any operand is read.
 * `unread` names a case where a null operand is not the one that the server reads.
 */
function dated(
  required: readonly string[],
  optional: readonly string[],
  checks: Readonly<Record<string, Check>>,
  compute: (v: Record<string, unknown>) => Answer,
  shape: (keys: readonly string[]) => boolean = () => true,
  unread: (v: Record<string, unknown>) => boolean = () => false,
): Rule {
  return keyed(required, optional, (parts, walk) => {
    if (!shape(Object.keys(parts))) return NO;
    const values: Record<string, unknown> = {};
    for (const key of Object.keys(parts)) {
      const a = walk.at(parts[key]);
      if (!a.ok) return a;
      values[key] = a.value;
    }
    if (unread(values)) return NO;
    let sawNull = false;
    for (const [key, v] of Object.entries(values)) {
      if (v === null) sawNull = true;
      else if (!checks[key](v)) return NO;
    }
    return sawNull ? ok(null) : compute(values);
  });
}

const TIMEZONE = { timezone: utcOnly };

// ── the parts of a date ──────────────────────────────────────────────────────

/**
 * `$year` and the operators like it take a date, `[date]`, or `{ date, timezone }`.
 * A document with a dollar key is an expression, and so it is one argument.
 */
function part(read: (f: Fields) => number): Rule {
  const options = dated(["date"], ["timezone"], { date: isInstant, ...TIMEZONE }, (v) =>
    ok(read(fieldsOf(instantOf(v.date) as number))),
  );
  return (operand, walk) => {
    if (isPlain(operand) && !Object.keys(operand).some((k) => k.startsWith("$"))) return options(operand, walk);
    const args = argsOf(operand);
    if (args.length !== 1) return NO;
    const a = walk.at(args[0]);
    if (!a.ok) return a;
    if (a.value === null) return ok(null);
    const ms = instantOf(a.value);
    return ms === undefined ? NO : ok(read(fieldsOf(ms)));
  };
}

const dateToParts = dated(
  ["date"],
  ["timezone", "iso8601"],
  { date: isInstant, iso8601: isBoolean, ...TIMEZONE },
  (v) => {
    const f = fieldsOf(instantOf(v.date) as number);
    const time = { hour: f.hour, minute: f.minute, second: f.second, millisecond: f.millisecond };
    if (v.iso8601 !== true) return ok({ year: f.year, month: f.month, day: f.day, ...time });
    const iso = isoWeekOf(f);
    return ok({ isoWeekYear: iso.year, isoWeek: iso.week, isoDayOfWeek: isoWeekday(f.weekday), ...time });
  },
);

// ── a date from parts ────────────────────────────────────────────────────────

const CALENDAR_PARTS = ["month", "day"];
const ISO_PARTS = ["isoWeek", "isoDayOfWeek"];
const CLOCK_PARTS = ["hour", "minute", "second", "millisecond"];
const PART = integerIn(-32_768, 32_767);

/** The calendar form has `year`, the ISO form has `isoWeekYear`, and a document has one form only. */
function partsShape(keys: readonly string[]): boolean {
  const calendar = keys.includes("year");
  const iso = keys.includes("isoWeekYear");
  if (calendar === iso) return false;
  return keys.every(
    (k) =>
      k === "timezone" ||
      CLOCK_PARTS.includes(k) ||
      k === (calendar ? "year" : "isoWeekYear") ||
      (calendar ? CALENDAR_PARTS : ISO_PARTS).includes(k),
  );
}

const dateFromParts = dated(
  [],
  ["year", ...CALENDAR_PARTS, "isoWeekYear", ...ISO_PARTS, ...CLOCK_PARTS, "timezone"],
  {
    year: integerIn(1, 9999),
    isoWeekYear: integerIn(1, 9999),
    ...Object.fromEntries([...CALENDAR_PARTS, ...ISO_PARTS, ...CLOCK_PARTS].map((k) => [k, PART])),
    ...TIMEZONE,
  },
  (v) => {
    const n = (key: string, otherwise: number): number => (v[key] === undefined ? otherwise : (v[key] as number));
    let days: number;
    if (v.year !== undefined) {
      // A month out of range carries into the year, and a day out of range into the month.
      const months = (v.year as number) * 12 + n("month", 1) - 1;
      days = daysFromCivil(Math.floor(months / 12), (((months % 12) + 12) % 12) + 1, 1) + n("day", 1) - 1;
    } else {
      // Week 1 holds 4 January, and its Monday anchors the year.
      const fourth = daysFromCivil(v.isoWeekYear as number, 1, 4);
      const monday = fourth - (isoWeekday((((fourth + 4) % 7) + 7) % 7) - 1);
      days = monday + (n("isoWeek", 1) - 1) * 7 + n("isoDayOfWeek", 1) - 1;
    }
    return dateAt(
      days * DAY + n("hour", 0) * HOUR + n("minute", 0) * MINUTE + n("second", 0) * SECOND + n("millisecond", 0),
    );
  },
  partsShape,
);

// ── a date moved, counted, and cut ───────────────────────────────────────────

/**
 * The instant `amount` units after `ms`. A calendar unit keeps the day of month, and the
 * last day of the target month is the limit of it. A fixed unit moves the instant.
 */
function shift(ms: number, unit: Unit, amount: number): Answer {
  const months = MONTHS_IN[unit];
  if (months === undefined) {
    const moved = BigInt(ms) + BigInt(amount) * BigInt(FIXED_MS[unit]);
    return dateAt(Number(moved));
  }
  // A shift of this size leaves the range of a Date, and the product below stays exact.
  if (Math.abs(amount * months) > 4_000_000) return NO;
  const f = fieldsOf(ms);
  const total = f.year * 12 + f.month - 1 + amount * months;
  const year = Math.floor(total / 12);
  const month = (((total % 12) + 12) % 12) + 1;
  const day = Math.min(f.day, daysInMonth(year, month));
  return dateAt(daysFromCivil(year, month, day) * DAY + (ms - f.days * DAY));
}

const SHIFT_CHECKS = {
  startDate: isInstant,
  unit: isUnit,
  amount: (v: unknown) => typeof v === "number" && Number.isSafeInteger(v),
  ...TIMEZONE,
};
const shifting = (sign: 1 | -1): Rule =>
  dated(["startDate", "unit", "amount"], ["timezone"], SHIFT_CHECKS, (v) =>
    shift(instantOf(v.startDate) as number, v.unit as Unit, sign * (v.amount as number) + 0),
  );

/** The number of the unit that holds the instant. Two instants of one number are in one unit. */
function unitIndex(ms: number, unit: Unit, startOfWeek: number): number {
  const f = fieldsOf(ms);
  switch (unit) {
    case "year":
      return f.year;
    case "quarter":
      return f.year * 4 + Math.floor((f.month - 1) / 3);
    case "month":
      return f.year * 12 + f.month - 1;
    case "week":
      // The first day of this week, less the days that the epoch week starts after it.
      return (f.days - ((f.weekday - startOfWeek + 7) % 7) - ((startOfWeek + 3) % 7)) / 7;
    default:
      return Math.floor(ms / FIXED_MS[unit]);
  }
}

const dateDiff = dated(
  ["startDate", "endDate", "unit"],
  ["timezone", "startOfWeek"],
  { startDate: isInstant, endDate: isInstant, unit: isUnit, startOfWeek: isWeekdayName, ...TIMEZONE },
  (v) => {
    const sow = startOfWeekOf(v);
    const start = unitIndex(instantOf(v.startDate) as number, v.unit as Unit, sow);
    const end = unitIndex(instantOf(v.endDate) as number, v.unit as Unit, sow);
    return Number.isSafeInteger(end - start) ? ok(end - start) : NO;
  },
  undefined,
  nullWeekStart,
);

const floorDiv = (a: bigint, b: bigint): bigint => {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
};

const dateTrunc = dated(
  ["date", "unit"],
  ["binSize", "timezone", "startOfWeek"],
  { date: isInstant, unit: isUnit, binSize: integerIn(1, 2_147_483_647), startOfWeek: isWeekdayName, ...TIMEZONE },
  (v) => {
    const ms = instantOf(v.date) as number;
    const unit = v.unit as Unit;
    const bin = v.binSize === undefined ? 1 : (v.binSize as number);
    const months = MONTHS_IN[unit];
    if (months !== undefined) {
      // Bins count calendar months from January 2000.
      const f = fieldsOf(ms);
      const size = bin * months;
      const since = f.year * 12 + f.month - 1 - 24_000;
      const start = Math.floor(since / size) * size + 24_000;
      return dateAt(daysFromCivil(Math.floor(start / 12), (((start % 12) + 12) % 12) + 1, 1) * DAY);
    }
    // A week bin starts on the first `startOfWeek` day on or after the anchor.
    const anchor = ANCHOR_MS + (unit === "week" ? ((startOfWeekOf(v) - ANCHOR_WEEKDAY + 7) % 7) * DAY : 0);
    const size = BigInt(bin) * BigInt(FIXED_MS[unit]);
    return dateAt(Number(BigInt(anchor) + floorDiv(BigInt(ms) - BigInt(anchor), size) * size));
  },
  undefined,
  nullWeekStart,
);

// ── a date as a string, and a string as a date ───────────────────────────────

const pad = (n: number, width: number): string => String(n).padStart(width, "0");

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** The text of one format specifier, or undefined for a specifier that the server fails on. */
const SPECIFIERS: Readonly<Record<string, (f: Fields) => string | undefined>> = {
  Y: (f) => yearText(f.year),
  G: (f) => yearText(isoWeekOf(f).year),
  m: (f) => pad(f.month, 2),
  d: (f) => pad(f.day, 2),
  H: (f) => pad(f.hour, 2),
  M: (f) => pad(f.minute, 2),
  S: (f) => pad(f.second, 2),
  L: (f) => pad(f.millisecond, 3),
  j: (f) => pad(dayOfYearOf(f), 3),
  w: (f) => String(f.weekday + 1),
  u: (f) => String(isoWeekday(f.weekday)),
  U: (f) => pad(sundayWeekOf(f), 2),
  V: (f) => pad(isoWeekOf(f).week, 2),
  b: (f) => MONTH_NAMES[f.month - 1].slice(0, 3),
  B: (f) => MONTH_NAMES[f.month - 1],
  z: () => "+0000",
  Z: () => "0",
  "%": () => "%",
};

/** The server writes a year from 0 to 9999 with four digits, and fails on any other year. */
const yearText = (year: number): string | undefined => (year >= 0 && year <= 9999 ? pad(year, 4) : undefined);

const DEFAULT_FORMAT = "%Y-%m-%dT%H:%M:%S.%LZ";

/**
 * The text of the instant in the format. The server fails on a specifier it does not
 * know, on a `%` at the end, and on a year specifier for a year outside 0 to 9999.
 */
function formatInstant(ms: number, format: string): string | undefined {
  const f = fieldsOf(ms);
  let out = "";
  for (let i = 0; i < format.length; i++) {
    if (format[i] !== "%") {
      out += format[i];
      continue;
    }
    const specifier = Object.prototype.hasOwnProperty.call(SPECIFIERS, format[i + 1])
      ? SPECIFIERS[format[i + 1]]
      : undefined;
    const text = specifier?.(f);
    if (text === undefined) return undefined;
    out += text;
    i++;
  }
  return out;
}

/** The value of an optional operand that the answer needs: its walk, or null when it is not written. */
function orNull(parts: Record<string, unknown>, key: string, walk: Walk): Answer {
  return key in parts ? walk.at(parts[key]) : ok(null);
}

const dateToString = keyed(["date"], ["format", "timezone", "onNull"], (parts, walk) => {
  const date = walk.at(parts.date);
  if (!date.ok) return date;
  const format = "format" in parts ? walk.at(parts.format) : ok(DEFAULT_FORMAT);
  if (!format.ok) return format;
  // A null time zone, here, is a case that the server answers in a way the rule does not state.
  const zone = "timezone" in parts ? walk.at(parts.timezone) : ok("UTC");
  if (!zone.ok) return zone;
  if (!utcOnly(zone.value)) return NO;
  if (format.value !== null && typeof format.value !== "string") return NO;
  if (date.value === null) return orNull(parts, "onNull", walk);
  const ms = instantOf(date.value);
  if (ms === undefined) return NO;
  if (format.value === null) return ok(null);
  const text = formatInstant(ms, format.value as string);
  return text === undefined ? NO : ok(text);
});

/** A string that the parser reads: a date, and an optional time with an optional offset. */
const ISO_STRING = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * What the server does with a string: the instant for a string that it reads and that the
 * rule reads the same way, `fails` for a string in the shape above with a part out of
 * range, and undefined for every other string.
 */
type Parsed = number | "fails" | undefined;

function parseIso(text: string): Parsed {
  const m = ISO_STRING.exec(text);
  if (m === null) return text === "" ? "fails" : undefined;
  const [year, month, day, hour, minute, second] = [m[1], m[2], m[3], m[4] ?? "0", m[5] ?? "0", m[6] ?? "0"].map(
    Number,
  );
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return "fails";
  if (hour > 23 || minute > 59 || second > 59) return "fails";
  const fraction = Number((m[7] ?? "").padEnd(3, "0"));
  let ms = daysFromCivil(year, month, day) * DAY + hour * HOUR + minute * MINUTE + second * SECOND + fraction;
  const zone = m[8];
  if (zone !== undefined && zone !== "Z") {
    const [offsetHour, offsetMinute] = [Number(zone.slice(1, 3)), Number(zone.slice(4, 6))];
    if (offsetHour > 23 || offsetMinute > 59) return undefined;
    ms -= (zone[0] === "-" ? -1 : 1) * (offsetHour * HOUR + offsetMinute * MINUTE);
  }
  return ms;
}

const dateFromString = keyed(["dateString"], ["format", "timezone", "onError", "onNull"], (parts, walk) => {
  // A `format` operand makes the server read the string by a pattern that the rule does not hold.
  if ("format" in parts) return NO;
  const text = walk.at(parts.dateString);
  if (!text.ok) return text;
  const zone = "timezone" in parts ? walk.at(parts.timezone) : ok("UTC");
  if (!zone.ok) return zone;
  if (!utcOnly(zone.value)) return NO;
  if (text.value === null) return orNull(parts, "onNull", walk);
  const failure = (): Answer => ("onError" in parts ? walk.at(parts.onError) : NO);
  // A value that is not a string fails on the server, and `onError` then gives the answer.
  if (typeof text.value !== "string")
    return ["number", "boolean", "date"].includes(kindOf(text.value)) ? failure() : NO;
  const parsed = parseIso(text.value);
  if (parsed === undefined) return NO;
  if (parsed === "fails") return failure();
  return dateAt(parsed);
});

// ── conversions ──────────────────────────────────────────────────────────────

/**
 * `$toDate` takes a date, an ObjectId, a number of milliseconds or a string in the forms
 * above. An int fails on the server and a double or a long does not. A computed
 * integer inside 32 bits could be either, so only a fraction or a larger integer runs.
 */
const toDate = positional(1, 1, ([v]) => {
  if (v === null) return ok(null);
  if (typeof v === "number") {
    if (Number.isInteger(v) && Math.abs(v) <= 0x7fffffff) return NO;
    return dateAt(Math.trunc(v));
  }
  if (typeof v === "string") {
    const parsed = parseIso(v);
    return typeof parsed === "number" ? dateAt(parsed) : NO;
  }
  const ms = instantOf(v);
  return ms === undefined ? NO : dateAt(ms);
});

/** `$tsSecond` and `$tsIncrement` read one half of the 64 bits of a timestamp, as an unsigned number. */
const timestampHalf = (half: "high" | "low"): Rule =>
  positional(1, 1, ([v]) => {
    if (v === null) return ok(null);
    return bsonTagOf(v) === "Timestamp" ? ok((v as Record<string, number>)[half] >>> 0) : NO;
  });

export const DATES: Record<string, Rule> = {
  $year: part((f) => f.year),
  $month: part((f) => f.month),
  $dayOfMonth: part((f) => f.day),
  $hour: part((f) => f.hour),
  $minute: part((f) => f.minute),
  $second: part((f) => f.second),
  $millisecond: part((f) => f.millisecond),
  $dayOfWeek: part((f) => f.weekday + 1),
  $dayOfYear: part(dayOfYearOf),
  $week: part(sundayWeekOf),
  $isoWeek: part((f) => isoWeekOf(f).week),
  $isoWeekYear: part((f) => isoWeekOf(f).year),
  $isoDayOfWeek: part((f) => isoWeekday(f.weekday)),
  $dateToParts: dateToParts,
  $dateFromParts: dateFromParts,
  $dateAdd: shifting(1),
  $dateSubtract: shifting(-1),
  $dateDiff: dateDiff,
  $dateTrunc: dateTrunc,
  $dateToString: dateToString,
  $dateFromString: dateFromString,
  $toDate: toDate,
  $tsSecond: timestampHalf("high"),
  $tsIncrement: timestampHalf("low"),
};
