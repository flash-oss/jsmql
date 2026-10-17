// The value model of the interpreter.
//
// An answer is a VALUE, or the reason that there is none. A value is a number, a
// string, a boolean, null, a Date, an ObjectId, an array or a plain object.
// Every other BSON value (a Long, a Decimal128, a Binary, a regex) is OPAQUE: a
// rule can carry it, but it never computes with it. The rules in this directory
// follow one law: an answer must equal the answer of the server for the same MQL.
// Where the server answer is not exactly specified, the rule refuses.
//
// See src/compiler/interpret/CLAUDE.md.

import { bsonTagOf, isDate, isObjectId, isPlainObject as plainByPrototype, isRegExp, objectIdHex } from "../../bson.ts";

/** A value, or the reason that there is none. `unspellable` names a NaN or an infinity. */
export type Answer = { ok: true; value: unknown } | { ok: false; unspellable?: string };

/** The answer that carries no value. A refusal is never an error: the expression stays at run time. */
export const NO: Answer = { ok: false };

export const ok = (value: unknown): Answer => ({ ok: true, value });

/** A constant with no MongoDB literal, named so that the caller can say which. */
export const unspellable = (name: string): Answer => ({ ok: false, unspellable: name });

/**
 * The binding of a variable whose expression has no value. A variable that nothing reads
 * costs nothing, as in JavaScript. A read of it gives the failure that the expression gave.
 */
export class Failed {
  readonly answer: Answer;
  constructor(answer: Answer) {
    this.answer = answer;
  }
}

/**
 * Where a rule evaluates one operand. `bind` names the variables that the operand sees.
 *
 * A set operator answers an array in an order that the server does not specify, so
 * the answer of the interpreter is such an array too. A rule that reads the order of
 * an array (`$first`, `$slice`, an equality) must never see it. So `at` refuses a value
 * that holds a set answer, and `raw` returns it. A rule uses `raw` when it only passes the
 * value on, or reads nothing of its order. An operator that builds a value from the
 * elements, one by one and in no order that it reads, gives a value with the same
 * unspecified order. The rule records that with `markSet`.
 */
export type Walk = {
  at(mql: unknown, bind?: Readonly<Record<string, unknown>>): Answer;
  raw(mql: unknown, bind?: Readonly<Record<string, unknown>>): Answer;
  /** Is a set answer inside the value, at any depth? */
  holdsSet(value: unknown): boolean;
  /** Is the value itself a set answer, or built from one in an order that no rule reads? */
  isSet(value: unknown): boolean;
  /** Record that the array or the document has an unspecified order, and return it. */
  markSet<T extends object>(array: T): T;
};

/** One operator. It receives the operand as written, and reads it through `walk`. */
export type Rule = (operand: unknown, walk: Walk) => Answer;

/** How deep an expression may nest before the interpreter stops. A deeper tree would overflow the stack. */
export const MAX_DEPTH = 400;

/** A string or an array may not exceed this length. A larger value does not belong in a query. */
export const MAX_SIZE = 1_000_000;

/** How many nodes one call may visit. This stops a nested `$map` over a `$range` from an endless run. */
export const MAX_STEPS = 2_000_000;

/** Is the value inside the size limit? */
export function withinSize(value: unknown): boolean {
  if (typeof value === "string") return value.length <= MAX_SIZE;
  if (Array.isArray(value)) return value.length <= MAX_SIZE && value.every(withinSize);
  return true;
}

// ── kinds ────────────────────────────────────────────────────────────────────

export type ValueKind = "null" | "number" | "string" | "boolean" | "date" | "objectId" | "array" | "object" | "other";

/** A plain object: one whose own properties are its only content. */
export function isPlain(v: unknown): v is Record<string, unknown> {
  return plainByPrototype(v) && bsonTagOf(v) === undefined;
}

/** The kind of a value. `other` is any value that the interpreter carries and never reads. */
export function kindOf(v: unknown): ValueKind {
  if (v === null) return "null";
  switch (typeof v) {
    case "number":
      return "number";
    case "string":
      return "string";
    case "boolean":
      return "boolean";
  }
  if (Array.isArray(v)) return "array";
  if (isDate(v)) return "date";
  if (isObjectId(v)) return "objectId";
  if (isPlain(v)) return "object";
  return "other";
}

/**
 * Can the interpreter carry this value? A leaf is a number, a string, a boolean,
 * null, a Date, or a value with a BSON tag. An `undefined`, a BigInt and a function are not values.
 * A string with a lone surrogate has no UTF-8 encoding, so it is not a value either.
 */
export function isValue(v: unknown): boolean {
  switch (typeof v) {
    case "number":
    case "boolean":
      return true;
    case "string":
      return isWellFormed(v);
    case "object":
      break;
    default:
      return false;
  }
  if (v === null) return true;
  if (Array.isArray(v)) return v.every(isValue);
  if (isDate(v)) return !Number.isNaN(v.getTime());
  if (isPlain(v)) return Object.values(v).every(isValue);
  return bsonTagOf(v) !== undefined || isRegExp(v);
}

/** Does the value hold nothing opaque at any depth? A rule compares only such a value. */
export function inert(v: unknown): boolean {
  switch (kindOf(v)) {
    case "other":
      return false;
    case "array":
      return (v as unknown[]).every(inert);
    case "object":
      return Object.values(v as Record<string, unknown>).every(inert);
    default:
      return true;
  }
}

/**
 * MongoDB truthiness. Null, 0 and false are false. The empty string and the
 * empty array are true. It answers null for a value that it does not read.
 */
export function truthOf(v: unknown): boolean | null {
  switch (kindOf(v)) {
    case "null":
      return false;
    case "number":
      return v !== 0;
    case "boolean":
      return v as boolean;
    case "string":
    case "array":
    case "object":
    case "date":
    case "objectId":
      return true;
    default:
      return null;
  }
}

// ── equality and order ───────────────────────────────────────────────────────

/** Is the string free of a lone surrogate? Only such a string has a UTF-8 encoding. */
export const isWellFormed = (s: string): boolean =>
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

/**
 * The order of two well formed strings by code point, which is also the UTF-8 byte order.
 * JavaScript compares UTF-16 units, and the two orders differ for a surrogate against
 * a unit from U+E000 up. So a surrogate moves above those units before the comparison.
 */
export function compareCodePoints(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let x = a.charCodeAt(i);
    let y = b.charCodeAt(i);
    if (x === y) continue;
    if (x >= 0xd800 && y >= 0xd800) {
      x = x >= 0xe000 ? x - 0x800 : x + 0x2000;
      y = y >= 0xe000 ? y - 0x800 : y + 0x2000;
    }
    return x < y ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/**
 * A string that two values share exactly when `sameValue` holds for them. It lets a set
 * operator find a repeated value in one pass instead of one comparison for each pair.
 * Each part of the string ends where the next part starts, so no two values share one.
 */
export function keyOf(v: unknown): string {
  switch (kindOf(v)) {
    case "null":
      return "z";
    case "number":
      return `n${v as number}`;
    case "string":
      return `s${JSON.stringify(v)}`;
    case "boolean":
      return v ? "t" : "f";
    case "date":
      return `d${(v as Date).getTime()}`;
    case "objectId":
      return `o${objectIdHex(v)}`;
    case "array":
      return `[${(v as unknown[]).map(keyOf).join(",")}]`;
    case "object":
      return `{${Object.entries(v as Record<string, unknown>)
        .map(([k, x]) => `${JSON.stringify(k)}:${keyOf(x)}`)
        .join(",")}}`;
    default:
      return `?${String(v)}`;
  }
}

/** Structural equality, as `$eq`, `$in` and the set operators compare. Key order is part of a document. */
export function sameValue(a: unknown, b: unknown): boolean {
  const kind = kindOf(a);
  if (kind !== kindOf(b)) return false;
  switch (kind) {
    case "null":
      return true;
    case "number":
    case "string":
    case "boolean":
      return a === b && Object.is(a, -0) === Object.is(b, -0);
    case "date":
      return (a as Date).getTime() === (b as Date).getTime();
    case "objectId":
      return objectIdHex(a) === objectIdHex(b);
    case "array": {
      const x = a as unknown[];
      const y = b as unknown[];
      return x.length === y.length && x.every((v, i) => sameValue(v, y[i]));
    }
    case "object": {
      const x = a as Record<string, unknown>;
      const y = b as Record<string, unknown>;
      const kx = Object.keys(x);
      const ky = Object.keys(y);
      return kx.length === ky.length && kx.every((k, i) => k === ky[i] && sameValue(x[k], y[k]));
    }
    default:
      return false;
  }
}

/** The place of each kind that a rule reads, in the BSON order of types. */
const KIND_RANK: Readonly<Record<string, number>> = {
  null: 1,
  number: 2,
  string: 3,
  object: 4,
  array: 5,
  objectId: 7,
  boolean: 8,
  date: 9,
};

/** The place of each tagged value that the interpreter carries and never reads. A Long and a Decimal128 are numbers. */
const TAG_RANK: Readonly<Record<string, number>> = {
  MinKey: 0,
  Int32: 2,
  Long: 2,
  Double: 2,
  Decimal128: 2,
  Binary: 6,
  Timestamp: 10,
  BSONRegExp: 11,
  MaxKey: 12,
};

/**
 * The place of the value in the BSON order of types, or undefined for a value that has none
 * here. Every comparison on the server orders two values of different places by this number alone:
 * MinKey, null, a number, a string, a document, an array, a binary, an ObjectId, a boolean,
 * a date, a timestamp, a regular expression, MaxKey. All numeric types share one place.
 */
export function rankOf(v: unknown): number | undefined {
  const kind = kindOf(v);
  if (kind !== "other") return KIND_RANK[kind];
  return isRegExp(v) ? TAG_RANK.BSONRegExp : TAG_RANK[bsonTagOf(v) ?? ""];
}

const signOf = (n: number): -1 | 0 | 1 => (n < 0 ? -1 : n > 0 ? 1 : 0);

/**
 * The order of two values: -1, 0 or 1. Two values of different places in the BSON order of types
 * compare by that place. Two values of one place compare by value. It answers undefined
 * where the order is not the business of the interpreter: an opaque value of a place
 * that holds values to compare (a Long beside a number), or a value with no place.
 * A document compares field by field, and each field by its place, then its name, then its value.
 */
export function compareValues(a: unknown, b: unknown): -1 | 0 | 1 | undefined {
  const ra = rankOf(a);
  const rb = rankOf(b);
  if (ra === undefined || rb === undefined) return undefined;
  if (ra !== rb) return ra < rb ? -1 : 1;
  const ka = kindOf(a);
  if (ka !== kindOf(b)) return undefined;
  switch (ka) {
    case "null":
      return 0;
    case "number":
      return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
    case "string":
      return signOf(compareCodePoints(a as string, b as string));
    case "boolean":
      return a === b ? 0 : a ? 1 : -1;
    case "date":
      return signOf((a as Date).getTime() - (b as Date).getTime());
    case "objectId":
      return signOf(compareCodePoints(objectIdHex(a) as string, objectIdHex(b) as string));
    case "array": {
      const x = a as unknown[];
      const y = b as unknown[];
      for (let i = 0; i < Math.min(x.length, y.length); i++) {
        const c = compareValues(x[i], y[i]);
        if (c === undefined) return undefined;
        if (c !== 0) return c;
      }
      return signOf(x.length - y.length);
    }
    case "object": {
      const x = Object.entries(a as Record<string, unknown>);
      const y = Object.entries(b as Record<string, unknown>);
      for (let i = 0; i < Math.min(x.length, y.length); i++) {
        const [px, py] = [rankOf(x[i][1]), rankOf(y[i][1])];
        if (px === undefined || py === undefined) return undefined;
        if (px !== py) return px < py ? -1 : 1;
        const byName = signOf(compareCodePoints(x[i][0], y[i][0]));
        if (byName !== 0) return byName;
        const c = compareValues(x[i][1], y[i][1]);
        if (c !== 0) return c;
      }
      return signOf(x.length - y.length);
    }
    default:
      // MinKey and MaxKey have one value each. Any other opaque value has an order that no rule reads.
      return ra === TAG_RANK.MinKey || ra === TAG_RANK.MaxKey ? 0 : undefined;
  }
}

// ── numbers ──────────────────────────────────────────────────────────────────

/** An index or a count that a 32-bit integer holds. The server refuses every other value. */
export const isInt32 = (n: unknown): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= -0x80000000 && n <= 0x7fffffff;

/** The name of a value that MongoDB cannot write down, or null when it can. */
function nameIfUnspellable(value: unknown): string | null {
  switch (kindOf(value)) {
    case "number": {
      const n = value as number;
      if (Number.isNaN(n)) return "NaN";
      if (!Number.isFinite(n)) return String(n);
      // `-0` is a double to the driver, where the same arithmetic gives MongoDB an int 0.
      return Object.is(n, -0) ? "-0" : null;
    }
    case "array":
      for (const v of value as unknown[]) {
        const name = nameIfUnspellable(v);
        if (name !== null) return name;
      }
      return null;
    case "object":
      for (const v of Object.values(value as Record<string, unknown>)) {
        const name = nameIfUnspellable(v);
        if (name !== null) return name;
      }
      return null;
    default:
      return null;
  }
}

/**
 * Does a document hold keys in an order that a JavaScript object cannot keep? An
 * object lists a key that reads as an array index (`"1"`) before every other key,
 * so a document of two or more keys with such a key loses its BSON order. A document
 * of unspecified order has no order to lose, so `unordered` exempts it.
 */
function losesKeyOrder(value: unknown, unordered: (document: object) => boolean): boolean {
  switch (kindOf(value)) {
    case "array":
      return (value as unknown[]).some((v) => losesKeyOrder(v, unordered));
    case "object": {
      const keys = Object.keys(value as Record<string, unknown>);
      if (!unordered(value as object) && keys.length > 1) {
        if (keys.some((k) => /^(0|[1-9][0-9]*)$/.test(k) && Number(k) < 4294967295)) return true;
      }
      return Object.values(value as Record<string, unknown>).some((v) => losesKeyOrder(v, unordered));
    }
    default:
      return false;
  }
}

/**
 * Every value leaves through here, so one check covers every rule. NaN and an
 * infinity are unspellable, and the caller reports them. A `-0`, an `undefined`
 * and a document that loses its key order are a plain refusal.
 */
export function spellable(value: unknown, unordered: (document: object) => boolean = () => false): Answer {
  if (value === undefined || losesKeyOrder(value, unordered)) return NO;
  const name = nameIfUnspellable(value);
  if (name === null) return withinSize(value) ? ok(value) : NO;
  return name === "-0" ? NO : unspellable(name);
}

/**
 * Integers whose result a double cannot hold exactly. MongoDB computes an integer
 * result in 64 bits, exact to the last digit. JavaScript computes in doubles and
 * rounds above 2^53. So the interpreter refuses such a result. An operand above 2^53
 * is always a double on the server: no rule answers an integer that large. So
 * the arithmetic of such an operand is double arithmetic on both sides.
 */
export function losesPrecision(result: number, ...operands: readonly number[]): boolean {
  return Number.isFinite(result) && operands.every(Number.isSafeInteger) && !Number.isSafeInteger(result);
}

/** A double's EXACT value as `digits * 10 ** exponent`. Every double has one. */
export function exactDecimal(n: number): { digits: bigint; exponent: number } {
  const bits = new DataView(new ArrayBuffer(8));
  bits.setFloat64(0, Math.abs(n));
  const high = bits.getUint32(0);
  const raw = (high >>> 20) & 0x7ff;
  let mantissa = (BigInt(high & 0xfffff) << 32n) | BigInt(bits.getUint32(4));
  // A subnormal has no implicit leading bit and a fixed exponent.
  let power = -1074;
  if (raw !== 0) {
    mantissa |= 1n << 52n;
    power = raw - 1075;
  }
  // `2 ** -k` is `5 ** k / 10 ** k`, so a negative power of two is an exact decimal.
  if (power >= 0) return { digits: mantissa << BigInt(power), exponent: 0 };
  return { digits: mantissa * 5n ** BigInt(-power), exponent: power };
}

/**
 * A number reduced to `places` decimal places, in the exact decimal value of the
 * double. `half` picks the neighbour when the dropped digits are exactly a half:
 * `$round` goes to the even one. A scaled multiplication decides on a perturbed
 * number, so this uses integer arithmetic and cannot drift. The result is read
 * back through its decimal spelling, which is one correctly rounded step.
 */
export function reduceToPlaces(n: number, places: number, mode: "half-even" | "toward-zero"): number {
  if (!Number.isFinite(n) || n === 0) return n;
  const { digits, exponent } = exactDecimal(n);
  const shift = exponent + places;
  // The number is exact at that many places already, so nothing is dropped.
  if (shift >= 0) return n;
  const unit = 10n ** BigInt(-shift);
  const whole = digits / unit;
  const rest = digits % unit;
  const half = unit / 2n;
  let rounded = whole;
  if (mode === "half-even") {
    rounded = rest > half ? whole + 1n : rest < half ? whole : whole % 2n === 0n ? whole : whole + 1n;
  }
  let spelt = rounded.toString();
  if (places > 0 && spelt.length <= places) spelt = spelt.padStart(places + 1, "0");
  const body =
    places > 0
      ? `${spelt.slice(0, spelt.length - places)}.${spelt.slice(spelt.length - places)}`
      : places < 0 && rounded !== 0n
        ? spelt + "0".repeat(-places)
        : spelt;
  return Number(`${n < 0 ? "-" : ""}${body}`);
}

/**
 * The string `$toString` writes for a number, or null where it and JavaScript part
 * company. Both write an integer below 10^16 digit for digit. Above that the
 * server switches to an exponent. A fraction has its own threshold, and `-0` keeps its sign there.
 */
export function numberSpelling(n: number): string | null {
  if (!Number.isInteger(n) || Object.is(n, -0) || Math.abs(n) >= 1e16) return null;
  return String(n);
}

/**
 * The text that `$toString` writes for a finite number whose spelling the interpreter does not
 * reproduce. The text itself is not known. Its start is: an optional minus sign, then a digit. So
 * it differs from every string that does not start so, and no rule reads anything else of it. A
 * value that holds one is never an answer. It exists for the finite-number test that a lowering
 * writes as `$in: [{ $toString: x }, ["NaN", "Infinity", "-Infinity"]]`.
 */
export class NumberText {}

/** Can the string be the text of a finite number? */
export const startsLikeNumber = (s: string): boolean => /^-?[0-9]/.test(s);

/** Does the value hold a `NumberText` at any depth? */
export function holdsNumberText(v: unknown): boolean {
  if (v instanceof NumberText) return true;
  if (Array.isArray(v)) return v.some(holdsNumberText);
  return isPlain(v) && Object.values(v).some(holdsNumberText);
}

// ── strings ──────────────────────────────────────────────────────────────────

/** `$toUpper` and `$toLower` change the ASCII letters only. */
export const asciiUpper = (s: string): string => s.replace(/[a-z]/g, (c) => c.toUpperCase());
export const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** Code points, because the CP operators count those and not UTF-16 units. */
export const points = (s: string): string[] => [...s];
