import { bsonTagOf, isDate, isObjectId, isPlainObject as plainByPrototype, isRegExp, objectIdHex } from "../../bson.ts";

export type Answer = { ok: true; value: unknown } | { ok: false; unspellable?: string };

export const NO: Answer = { ok: false };

export const ok = (value: unknown): Answer => ({ ok: true, value });

export const unspellable = (name: string): Answer => ({ ok: false, unspellable: name });

export class Failed {
  readonly answer: Answer;
  constructor(answer: Answer) {
    this.answer = answer;
  }
}

export type Walk = {
  at(mql: unknown, bind?: Readonly<Record<string, unknown>>): Answer;
  raw(mql: unknown, bind?: Readonly<Record<string, unknown>>): Answer;
  holdsSet(value: unknown): boolean;
  isSet(value: unknown): boolean;
  markSet<T extends object>(array: T): T;
};

export type Rule = (operand: unknown, walk: Walk) => Answer;

export const MAX_DEPTH = 400;

export const MAX_SIZE = 1_000_000;

export const MAX_STEPS = 2_000_000;

export function withinSize(value: unknown): boolean {
  if (typeof value === "string") return value.length <= MAX_SIZE;
  if (Array.isArray(value)) return value.length <= MAX_SIZE && value.every(withinSize);
  return true;
}

export type ValueKind = "null" | "number" | "string" | "boolean" | "date" | "objectId" | "array" | "object" | "other";

export function isPlain(v: unknown): v is Record<string, unknown> {
  return plainByPrototype(v) && bsonTagOf(v) === undefined;
}

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

export const isWellFormed = (s: string): boolean =>
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

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

export function rankOf(v: unknown): number | undefined {
  const kind = kindOf(v);
  if (kind !== "other") return KIND_RANK[kind];
  return isRegExp(v) ? TAG_RANK.BSONRegExp : TAG_RANK[bsonTagOf(v) ?? ""];
}

const signOf = (n: number): -1 | 0 | 1 => (n < 0 ? -1 : n > 0 ? 1 : 0);

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
      return ra === TAG_RANK.MinKey || ra === TAG_RANK.MaxKey ? 0 : undefined;
  }
}

export const isInt32 = (n: unknown): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= -0x80000000 && n <= 0x7fffffff;

function nameIfUnspellable(value: unknown): string | null {
  switch (kindOf(value)) {
    case "number": {
      const n = value as number;
      if (Number.isNaN(n)) return "NaN";
      if (!Number.isFinite(n)) return String(n);
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

export const isIndexKey = (k: string): boolean => /^(0|[1-9][0-9]*)$/.test(k) && Number(k) < 4294967295;

export class OrderedDocument {
  readonly pairs: readonly (readonly [string, unknown])[];
  constructor(pairs: readonly (readonly [string, unknown])[]) {
    this.pairs = pairs;
  }
}

function losesKeyOrder(value: unknown, unordered: (document: object) => boolean): boolean {
  switch (kindOf(value)) {
    case "array":
      return (value as unknown[]).some((v) => losesKeyOrder(v, unordered));
    case "object": {
      const keys = Object.keys(value as Record<string, unknown>);
      if (!unordered(value as object) && keys.length > 1) {
        if (keys.some(isIndexKey)) return true;
      }
      return Object.values(value as Record<string, unknown>).some((v) => losesKeyOrder(v, unordered));
    }
    default:
      return false;
  }
}

export function spellable(value: unknown, unordered: (document: object) => boolean = () => false): Answer {
  if (value === undefined || losesKeyOrder(value, unordered)) return NO;
  const name = nameIfUnspellable(value);
  if (name === null) return withinSize(value) ? ok(value) : NO;
  return name === "-0" ? NO : unspellable(name);
}

export function losesPrecision(result: number, ...operands: readonly number[]): boolean {
  return Number.isFinite(result) && operands.every(Number.isSafeInteger) && !Number.isSafeInteger(result);
}

export function exactDecimal(n: number): { digits: bigint; exponent: number } {
  const bits = new DataView(new ArrayBuffer(8));
  bits.setFloat64(0, Math.abs(n));
  const high = bits.getUint32(0);
  const raw = (high >>> 20) & 0x7ff;
  let mantissa = (BigInt(high & 0xfffff) << 32n) | BigInt(bits.getUint32(4));
  let power = -1074;
  if (raw !== 0) {
    mantissa |= 1n << 52n;
    power = raw - 1075;
  }
  if (power >= 0) return { digits: mantissa << BigInt(power), exponent: 0 };
  return { digits: mantissa * 5n ** BigInt(-power), exponent: power };
}

export function reduceToPlaces(n: number, places: number, mode: "half-even" | "toward-zero"): number {
  if (!Number.isFinite(n) || n === 0) return n;
  const { digits, exponent } = exactDecimal(n);
  const shift = exponent + places;
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

export function numberSpelling(n: number): string | null {
  if (!Number.isInteger(n) || Object.is(n, -0) || Math.abs(n) >= 1e16) return null;
  return String(n);
}

export class NumberText {}

export const startsLikeNumber = (s: string): boolean => /^-?[0-9]/.test(s);

export function holdsNumberText(v: unknown): boolean {
  if (v instanceof NumberText) return true;
  if (v instanceof OrderedDocument) return v.pairs.some(([, x]) => holdsNumberText(x));
  if (Array.isArray(v)) return v.some(holdsNumberText);
  return isPlain(v) && Object.values(v).some(holdsNumberText);
}

export const asciiUpper = (s: string): string => s.replace(/[a-z]/g, (c) => c.toUpperCase());
export const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

export const points = (s: string): string[] => [...s];
