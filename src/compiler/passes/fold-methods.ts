// What a method call computes when its receiver and arguments are constants.
//
// Two tables, because the language has two shapes of call. A NAMESPACE call
// reads nothing — for example `Math.max(3, 7)`. An INSTANCE call has a receiver
// whose value decides which rule applies: `.slice()` cuts a string or an
// array, and the value decides which.
//
// Every rule here answers the LANGUAGE's question, not JavaScript's, wherever
// the two differ. They differ in these ways:
//   'Ä'.toUpperCase()     JSMQL: 'Ä'      JavaScript: 'Ä'   ($toUpper is ASCII)
//   new Date(2020, 1, 1)  February, in both — a JavaScript spelling gets JavaScript's behaviour
//   (2.5).round()         JSMQL: 2        JavaScript: 3     (banker's rounding)
// A rule that cannot answer the language's question returns nothing, and the
// call stays a runtime one.

import type { Evaluation } from "./evaluate.ts";
import { bsonConstant, bsonNullary, bsonTagOf, canonicalBsonName, isObjectId, objectIdHex } from "../../bson.ts";
import { isDate, isPlainObject as isPlainByPrototype } from "../../bson.ts";
import { sameValue, truthy } from "./evaluate.ts";
import { setKey } from "../../registry/mql.ts";
import { foldDateMethod, foldDateUTC, foldNewDate } from "./fold-dates.ts";

const NO: Evaluation = { ok: false };
const ok = (value: unknown): Evaluation => ({ ok: true, value });

/** A callback argument, already made callable. Throws when it is not constant. */
export type Callable = (...args: unknown[]) => unknown;

/** One argument: a plain value, or a callback. */
export type Arg = { fn?: Callable; value?: unknown };

const valueOf = (a: Arg | undefined): unknown => a?.value;
const fnOf = (a: Arg | undefined): Callable | undefined => a?.fn;

// ── the pieces MongoDB spells differently from JavaScript ────────────────────

/** `$toUpper` / `$toLower` are ASCII-only; JavaScript's are Unicode-aware. */
const asciiUpper = (s: string): string => s.replace(/[a-z]/g, (c) => c.toUpperCase());
const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** Code points, because `$strLenCP` and `$substrCP` count those, not UTF-16 units. */
const points = (s: string): string[] => [...s];

/**
 * An index or a count MongoDB can take.
 *
 * `$substrCP`, `$arrayElemAt`, `$slice` and `$range` all demand a value that a
 * 32-bit integer can represent, and refuse anything else: `"abc".charAt(1.5)`
 * is an error there and `""` in JavaScript. Folding it would answer where the
 * program does not run. That would make this pass a second, more permissive
 * grammar.
 */
const isInt32 = (n: unknown): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= -0x80000000 && n <= 0x7fffffff;

// ── namespace calls ──────────────────────────────────────────────────────────

/**
 * `Math.<name>(…)` — the ones whose result is EXACTLY specified.
 *
 * Measured against mongod: eleven of the twenty-nine differ, most by one unit in
 * the last place, and `Math.round(0.5)` differs by a whole unit. That is not a
 * defect in either implementation. IEEE-754 pins down `sqrt` and the algebraic
 * operations, and leaves every transcendental free. So `cbrt log2 cos tan asin
 * acos atan sinh cosh atanh` and similar functions run on the server, where the
 * answer is whatever the server gives. Agreement at the points one test happens
 * to check is not a guarantee. So the line follows the standard, not luck.
 */
const MATH: Readonly<Record<string, (a: readonly number[]) => number>> = {
  abs: ([x]) => Math.abs(x),
  sign: ([x]) => Math.sign(x),
  trunc: ([x]) => Math.trunc(x),
  floor: ([x]) => Math.floor(x),
  ceil: ([x]) => Math.ceil(x),
  // IEEE-754 requires a correctly rounded square root, so this one is safe.
  sqrt: ([x]) => Math.sqrt(x),
  min: (xs) => Math.min(...xs),
  max: (xs) => Math.max(...xs),
  // `$round` rounds a half to the EVEN neighbour; JavaScript rounds it up.
  round: ([x]) => roundToPlaces(x, 0),
};

/**
 * MongoDB's rounding: a half goes to the EVEN neighbour, in DECIMAL.
 *
 * Decimal is the whole difficulty. Scaling by `10 ** places` makes the rounding
 * decision on a perturbed number: `(2.675).round(2)` is 2.68 that way, and 2.67
 * on the server, because 2.675 is really 2.67499999999999982. So the decision
 * uses the number's EXACT value instead, which is integer arithmetic and cannot
 * drift. Measured against `$round` over 2,184 value/place pairs.
 *
 * A negative number that rounds to zero answers `-0`. This is what the server
 * answers, and what the pass then refuses to spell. So the call stays a runtime
 * one, rather than fold to a `0` of the wrong sign.
 */
function roundToPlaces(n: number, places: number): number {
  if (!Number.isFinite(n) || n === 0) return n;
  const { digits, exponent } = exactDecimal(n);
  // Already exact at that many places: there is nothing to decide.
  const shift = exponent + places;
  if (shift >= 0) return n;
  const unit = 10n ** BigInt(-shift);
  const whole = digits / unit;
  const rest = digits % unit;
  const half = unit / 2n;
  const rounded = rest > half ? whole + 1n : rest < half ? whole : whole % 2n === 0n ? whole : whole + 1n;
  // Read back through the DECIMAL spelling: a string becomes the nearest double in
  // one correctly-rounded step, where a division by `10 ** places` rounds twice.
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

/** A double's EXACT value as `digits * 10 ** exponent`. Every double has one. */
function exactDecimal(n: number): { digits: bigint; exponent: number } {
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
 * A call on a static namespace: `Math.max(3, 7)`, `Number.isInteger(4)`.
 *
 * `Date.UTC` is here too, and its months are ONE-based — the language settled
 * that so `Date.UTC(2020, 1, 1)` reads as January and matches `new Date(…)`.
 */
export function foldNamespaceCall(namespace: string, name: string, args: readonly Arg[]): Evaluation {
  const values = args.map(valueOf);

  if (namespace === "Math") {
    const rule = MATH[name];
    if (rule === undefined) return NO;
    if (!values.every((v) => typeof v === "number")) return NO;
    return ok(rule(values as number[]));
  }

  if (namespace === "Number") {
    const [x] = values;
    switch (name) {
      case "isInteger":
        return ok(typeof x === "number" && Number.isInteger(x));
      case "isNaN":
        return ok(typeof x === "number" && Number.isNaN(x));
      // No `isFinite` and no `isSafeInteger`: the language has neither, and
      // folding one would ADD it.
      default:
        return NO;
    }
  }

  if (namespace === "Date") {
    // `Date.now()` reads the clock; only `Date.UTC` is a function of its arguments.
    return name === "UTC" ? foldDateUTC(values) : NO;
  }

  if (namespace === "Object") {
    const [o, b] = values;
    const plain = (v: unknown): v is Record<string, unknown> =>
      typeof v === "object" && v !== null && !Array.isArray(v) && !isDate(v);
    switch (name) {
      case "keys":
        return plain(o) ? ok(Object.keys(o)) : NO;
      case "values":
        return plain(o) ? ok(Object.values(o)) : NO;
      case "entries":
        // `$objectToArray` — a list of `{k, v}` DOCUMENTS, not JavaScript's
        // two-element arrays. `.toPairs()` is the one that gives those.
        return plain(o) ? ok(Object.entries(o).map(([k, v]) => ({ k, v }))) : NO;
      case "assign":
        return values.every(plain) ? ok(Object.assign({}, ...(values as object[]))) : NO;
      case "fromEntries": {
        if (!Array.isArray(o)) return NO;
        if (!o.every((p) => Array.isArray(p) && p.length === 2 && isKey(p[0]))) return NO;
        return ok(Object.fromEntries(o.map(([k, v]) => [String(k), v])));
      }
      default:
        void b;
        return NO;
    }
  }

  return NO;
}

/** A value MongoDB can use as an object key: a scalar it stringifies the same way. */
const isKey = (v: unknown): boolean => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/**
 * A constant READ on a namespace: `Math.PI`, `Math.E`.
 *
 * The registry states that these two are read, not called. Their value is
 * arithmetic, and that arithmetic lives here.
 */
export function foldNamespaceConstant(namespace: string, name: string): Evaluation {
  if (namespace !== "Math") return NO;
  if (name === "PI") return ok(Math.PI);
  if (name === "E") return ok(Math.E);
  return NO;
}

/**
 * `new X(…)` with constant arguments.
 *
 * `new Set([…])` answers with the ARRAY, unchanged and un-deduplicated, because
 * that is what the language does — measured: `new Set([1,2,2,3])` reads back as
 * `[1,2,2,3]` from the server. jsmql has no set type; the constructor is a way
 * of writing an array that the set operators then read.
 */
export function foldConstructor(name: string, args: readonly Arg[]): Evaluation {
  const values = args.map(valueOf);
  switch (canonicalBsonName(name)) {
    case "Date":
      return foldNewDate(values);
    case "Set": {
      const [a] = values;
      if (args.length === 0) return ok([]);
      return Array.isArray(a) ? ok(a) : NO;
    }
    default:
      return bsonValue(name, args.length, values);
  }
}

/**
 * A named call: `String(42)`, `Number("42")`, `ObjectId("<24 hex>")`.
 *
 * Each is a conversion, and each refuses exactly where the SERVER refuses.
 * `$convert` with no `onError` fails on a string it cannot parse. So
 * `Number("nope")` is an error there, and a quiet NaN in JavaScript. Folding it
 * would answer where the program does not run.
 */

export function foldNamedCall(name: string, args: readonly Arg[]): Evaluation {
  const values = args.map(valueOf);
  const [a] = values;
  switch (canonicalBsonName(name)) {
    // `Date(…)` without `new` means the same date `new Date(…)` does. JavaScript's
    // bare call returns a string instead; jsmql keeps the syntax, not that meaning.
    case "Date":
      return foldNewDate(values);
    case "String":
      // `$toString(null)` is null, not the four letters "null".
      if (a === null) return ok(null);
      if (typeof a === "string") return ok(a);
      if (typeof a === "boolean") return ok(String(a));
      if (typeof a === "number") {
        const spelled = numberSpelling(a);
        return spelled === null ? NO : ok(spelled);
      }
      return NO;
    case "Boolean":
      return args.length === 1 ? ok(Boolean(a)) : NO;
    case "Number":
      // Never folded. `$toDouble("3")` is a DOUBLE on the server and a written `3`
      // is an int — `$type` tells them apart, and so does `$out`. The call stays
      // and converts at run time, where the server also judges a string it cannot
      // parse (" 12 ", "0x10").
      return NO;
    default:
      return bsonValue(name, args.length, values);
  }
}

/**
 * The live BSON value a constructor name settles to: `Decimal128("1.50")`,
 * `MinKey()`, `ObjectId("<24 hex>")`. `new X(…)` and `X(…)` fold alike — the row
 * decides which spellings the name accepts, not this.
 *
 * NO for anything the type cannot hold. The call then stands, and the row
 * refuses it at its source position. jsmql never builds a value that `bson`
 * would silently wrap: `new Int32(5000000000)` is 705032704 there. See
 * docs/specs/bson-types.md.
 */
function bsonValue(name: string, count: number, values: readonly unknown[]): Evaluation {
  if (count === 0) {
    const minted = bsonNullary(name);
    return minted === null ? NO : ok(minted);
  }
  if (count !== 1) return NO;
  const built = bsonConstant(name, values[0]);
  return built === null ? NO : ok(built);
}

/**
 * The string `$toString` writes for a number, or null where it and JavaScript
 * part company. Both write an integer below 10^16 in magnitude digit for
 * digit. From there the server switches to an exponent ("1e+16"), where
 * JavaScript holds out to 10^21. A fraction's threshold also differs ("1e-07"
 * against "1e-7"), and `-0` keeps its sign there and loses it here. Those stay
 * runtime; the integers a query compares fold.
 */
export function numberSpelling(n: number): string | null {
  if (!Number.isInteger(n) || Object.is(n, -0) || Math.abs(n) >= 1e16) return null;
  return String(n);
}

// ── instance calls ───────────────────────────────────────────────────────────

/**
 * `<constant>.<name>(…)`.
 *
 * The receiver's runtime type picks the rule. This is why one table serves
 * `.slice()` on a string and on an array: by this point the value is in hand,
 * so there is nothing to infer.
 */
export function foldInstanceCall(receiver: unknown, name: string, args: readonly Arg[]): Evaluation {
  if (typeof receiver === "string") return stringMethod(receiver, name, args);
  if (Array.isArray(receiver)) return arrayMethod(receiver, name, args);
  if (typeof receiver === "number") return numberMethod(receiver, name, args);
  if (isDate(receiver)) return foldDateMethod(receiver, name, args.map(valueOf));
  // A BSON value's one EXACT read: the text it prints. Nothing else folds. A
  // decimal's arithmetic belongs to the server, which is the whole reason the
  // type exists (MEASURED: `$add: ["$p", Decimal128("0.2")]` is 0.3 where a
  // double is 0.30000000000000004). A long's arithmetic would need MongoDB's
  // promotion rules.
  if (bsonTagOf(receiver) !== undefined) {
    if (name !== "toString" || args.length !== 0) return NO;
    // An ObjectId prints its 24 hex digits. The defensive reader is the one
    // that survives a plain object that carries the tag.
    if (isObjectId(receiver)) {
      const hex = objectIdHex(receiver);
      return hex === null ? NO : ok(hex);
    }
    const own = (receiver as { toString?: () => string }).toString;
    return typeof own === "function" && own !== Object.prototype.toString ? ok(String(own.call(receiver))) : NO;
  }
  // PLAIN objects only. A RegExp, a Date and a BSON value are all objects to
  // JavaScript. Reading one with the object rules answers about the wrong
  // thing entirely: `/ab/.size()` would become `Object.keys(regex).length`,
  // which is 0 and means nothing. The language refuses those receivers, and so
  // does this. A fold must never answer a question the language does not ask.
  if (isPlainObject(receiver)) return objectMethod(receiver as Record<string, unknown>, name, args);
  return NO;
}

/** An object whose own properties are all there is to it — not a Date, not BSON. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return isPlainByPrototype(v) && bsonTagOf(v) === undefined;
}

// ── the lodash string family ─────────────────────────────────────────────────
//
// These have no JavaScript counterpart. So there is nothing to inherit, and the
// rules are written out. Each mirrors the `$regexFindAll` split that the
// runtime lowering uses, which is ASCII-only — the same reason `$toUpper` is.

/** The runtime splits on this exact pattern, so the fold splits on it too. */
const WORD = /[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[0-9]+/g;

const wordsOf = (s: string): string[] => s.match(WORD) ?? [];

/** `$replaceAll` chain, in the order the runtime applies it. */
const HTML: readonly (readonly [string, string])[] = [
  ["&", "&amp;"],
  ["<", "&lt;"],
  [">", "&gt;"],
  ['"', "&quot;"],
  ["'", "&#39;"],
];

function lodashString(s: string, name: string, args: readonly Arg[]): Evaluation {
  const [a] = args.map(valueOf);
  switch (name) {
    case "escape": {
      let out = s;
      for (const [from, to] of HTML) out = out.split(from).join(to);
      return ok(out);
    }
    case "words":
      return ok(wordsOf(s));
    case "kebabCase":
      return ok(asciiLower(wordsOf(s).join("-")));
    case "snakeCase":
      return ok(asciiLower(wordsOf(s).join("_")));
    case "startCase":
      return ok(
        wordsOf(s)
          // Upper-case the first character and LOWER-case the rest, which is
          // what the lowering does: `"ABC"` becomes `"Abc"`, not `"ABC"`.
          .map((w) => asciiUpper(w.slice(0, 1)) + asciiLower(w.slice(1)))
          .join(" "),
      );
    case "camelCase": {
      const parts = wordsOf(s).map((w) => asciiLower(w));
      if (parts.length === 0) return ok("");
      const [head, ...rest] = parts;
      return ok(head + rest.map((w) => asciiUpper(w.slice(0, 1)) + w.slice(1)).join(""));
    }
    case "capitalize":
      return ok(asciiUpper(s.slice(0, 1)) + asciiLower(s.slice(1)));
    case "upperFirst":
      return ok(asciiUpper(s.slice(0, 1)) + s.slice(1));
    case "lowerFirst":
      return ok(asciiLower(s.slice(0, 1)) + s.slice(1));
    case "truncate": {
      // Only the two options the runtime supports; anything else stays runtime.
      // No argument at all is the default options — the same 30 and "..." the lowering writes.
      if (a !== undefined && (a === null || typeof a !== "object" || Array.isArray(a))) return NO;
      const options = (a === undefined ? {} : a) as Record<string, unknown>;
      for (const key of Object.keys(options)) if (key !== "length" && key !== "omission") return NO;
      const limit = options.length === undefined ? 30 : options.length;
      const omission = options.omission === undefined ? "..." : options.omission;
      if (typeof limit !== "number" || typeof omission !== "string") return NO;
      const cps = points(s);
      if (cps.length <= limit) return ok(s);
      return ok(cps.slice(0, Math.max(0, limit - points(omission).length)).join("") + omission);
    }
    default:
      return NO;
  }
}

function stringMethod(s: string, name: string, args: readonly Arg[]): Evaluation {
  const [a, b] = args.map(valueOf);
  switch (name) {
    case "toUpperCase":
      return ok(asciiUpper(s));
    case "toLowerCase":
      return ok(asciiLower(s));
    case "trim":
      return ok(s.trim());
    case "trimStart":
    case "trimLeft":
      return ok(s.trimStart());
    case "trimEnd":
    case "trimRight":
      return ok(s.trimEnd());
    case "startsWith":
      return typeof a === "string" ? ok(s.startsWith(a, typeof b === "number" ? b : undefined)) : NO;
    case "endsWith":
      return typeof a === "string" ? ok(s.endsWith(a, typeof b === "number" ? b : undefined)) : NO;
    case "includes":
      return typeof a === "string" ? ok(s.includes(a)) : NO;
    case "indexOf": {
      // `$indexOfCP` answers in CODE POINTS. `"😀a".indexOf("a")` is 1 there and
      // 2 in JavaScript, whose index counts UTF-16 units.
      if (typeof a !== "string") return NO;
      if (b !== undefined && !isInt32(b)) return NO;
      const cps = points(s);
      const needle = points(a);
      for (let i = Math.max(0, typeof b === "number" ? b : 0); i <= cps.length - needle.length; i++) {
        if (cps.slice(i, i + needle.length).join("") === a) return ok(i);
      }
      return ok(-1);
    }
    // No `lastIndexOf`: the language refuses it on a string, because `$indexOfCP`
    // only searches forward. Folding it would ADD a method to the language.
    case "charAt":
      return isInt32(a) ? ok(points(s)[a] ?? "") : NO;
    case "at": {
      if (!isInt32(a)) return NO;
      const cps = points(s);
      const i = a < 0 ? cps.length + a : a;
      // Out of range answers `undefined` in JavaScript and MISSING on the
      // server, which are not the same thing. It stays a runtime read.
      return i >= 0 && i < cps.length ? ok(cps[i]) : NO;
    }
    case "slice":
      return sliceOf(points(s), a, b, (parts) => parts.join(""));
    case "substring": {
      // `$substrCP(s, start, length)` with the length clamped at zero. It does
      // NOT swap its arguments the way JavaScript's `substring` does. So
      // `"abcd".substring(3, 1)` is `""` on the server and `"bc"` in JavaScript.
      if (!isInt32(a) || a < 0) return NO;
      if (b !== undefined && (!isInt32(b) || b < 0)) return NO;
      const cps = points(s);
      const end = b === undefined ? cps.length : b;
      return ok(cps.slice(a, a + Math.max(0, end - a)).join(""));
    }
    case "repeat":
      // A negative count is a `RangeError` in JavaScript and a fractional one is
      // an error on the server. Refusing keeps both as jsmql's own, with a position.
      return isInt32(a) && a >= 0 ? ok(s.repeat(a)) : NO;
    case "padStart":
    case "padEnd": {
      // In CODE POINTS. JavaScript pads to a UTF-16 length, and truncates the pad
      // string by units. For an astral character this both pads to the wrong
      // width and can cut one in half. The result is a lone surrogate, a string
      // with no UTF-8 encoding at all, on its way to the driver.
      if (!isInt32(a)) return NO;
      const fill = b === undefined ? " " : b;
      if (typeof fill !== "string" || fill === "") return ok(s);
      const cps = points(s);
      if (cps.length >= a) return ok(s);
      const pad = points(fill);
      const built: string[] = [];
      while (built.length < a - cps.length) built.push(pad[built.length % pad.length]);
      return ok(name === "padStart" ? built.join("") + s : s + built.join(""));
    }
    case "split":
      // `$split` rejects an empty separator, and so does the row. The fold declines
      // here so that the registry's refusal reaches the developer, instead of a folded answer.
      if (typeof a !== "string" || a === "") return NO;
      if (b !== undefined && !isInt32(b)) return NO;
      return ok(s.split(a, typeof b === "number" ? b : undefined));
    case "concat":
      return args.every((x) => typeof valueOf(x) === "string") ? ok(s + args.map(valueOf).join("")) : NO;
    default:
      return lodashString(s, name, args);
  }
}

/** `.slice(start, end)` over a list, with JavaScript's negative-index rules. */
function sliceOf<T>(items: T[], start: unknown, end: unknown, done: (parts: T[]) => unknown): Evaluation {
  if (start !== undefined && !isInt32(start)) return NO;
  if (end !== undefined && !isInt32(end)) return NO;
  return ok(done(items.slice(start as number | undefined, end as number | undefined)));
}

function numberMethod(n: number, name: string, args: readonly Arg[]): Evaluation {
  const [a, b] = args.map(valueOf);
  switch (name) {
    case "round":
    case "ceil":
    case "floor": {
      if (a !== undefined && !Number.isInteger(a)) return NO;
      const places = (a as number | undefined) ?? 0;
      if (name === "round") return ok(roundToPlaces(n, places));
      // `.ceil(p)` / `.floor(p)` lower to `$divide[$ceil|$floor[$multiply[x, 10 ** p]], 10 ** p]`
      // — three correctly-rounded double operations, which is this same expression.
      const scale = 10 ** places;
      const scaled = name === "ceil" ? Math.ceil(n * scale) : Math.floor(n * scale);
      const answer = scaled / scale;
      // `(1e300).ceil(100)` overflows to Infinity on both sides, and Infinity has no MQL literal.
      return Number.isFinite(answer) ? ok(answer) : NO;
    }
    case "clamp":
      // A BOUND, not a place count — it may be fractional.
      if (typeof a !== "number") return NO;
      if (b !== undefined && typeof b !== "number") return NO;
      return typeof b === "number" ? ok(Math.min(Math.max(n, a), b)) : ok(Math.min(n, a));
    case "inRange":
      if (typeof a !== "number") return NO;
      if (b !== undefined && typeof b !== "number") return NO;
      // With one bound, lodash treats a NEGATIVE one as the lower end and zero
      // as the upper: `(-1).inRange(-1)` is true.
      if (typeof b !== "number") return ok(n >= Math.min(0, a) && n < Math.max(0, a));
      return ok(n >= Math.min(a, b) && n < Math.max(a, b));
    default:
      return NO;
  }
}

function objectMethod(o: Record<string, unknown>, name: string, args: readonly Arg[]): Evaluation {
  const [a] = args.map(valueOf);
  const fn = fnOf(args[0]);
  switch (name) {
    case "size":
      return ok(Object.keys(o).length);
    case "toPairs":
      return ok(Object.entries(o));
    case "invert": {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(o)) {
        if (!isKey(v)) return NO;
        setKey(out, String(v), k);
      }
      return ok(out);
    }
    case "pick":
    case "omit": {
      if (!Array.isArray(a) || !a.every((k) => typeof k === "string")) return NO;
      const keep = new Set(a as string[]);
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(o)) if (keep.has(k) === (name === "pick")) setKey(out, k, v);
      return ok(out);
    }
    case "mapValues": {
      if (fn === undefined) return NO;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(o)) setKey(out, k, fn(v, k, o));
      return ok(out);
    }
    case "mapKeys": {
      if (fn === undefined) return NO;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(o)) {
        const key = fn(v, k, o);
        if (!isKey(key)) return NO;
        setKey(out, String(key), v);
      }
      return ok(out);
    }
    case "pickBy":
    case "omitBy": {
      if (fn === undefined) return NO;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(o)) {
        const verdict = fn(v, k, o);
        // A predicate that answers with something other than a boolean is where
        // JavaScript's truthiness and MongoDB's part company: `""` and `0` are
        // false there and true here. So it does not fold.
        if (typeof verdict !== "boolean") return NO;
        if (verdict === (name === "pickBy")) setKey(out, k, v);
      }
      return ok(out);
    }
    default:
      return NO;
  }
}

// ── the array set and aggregate helpers ──────────────────────────────────────

/**
 * Deep equality, the way MongoDB's set operators compare.
 *
 * `$setUnion` and friends compare VALUES. So `[{a:1}]` and `[{a:1}]` are one
 * element to them, and two to JavaScript's `includes`. The lodash set family
 * here follows MongoDB. `.includes()` and `.indexOf()` keep JavaScript's
 * identity, which is what the runtime lowering of those two does.
 */
const deepIncludes = (haystack: readonly unknown[], needle: unknown): boolean =>
  haystack.some((h) => sameValue(h, needle));

/** Every element, keyed for comparison. Non-scalar keys have no MongoDB spelling. */
function keyedBy(xs: readonly unknown[], fn: Callable): unknown[] | null {
  const keys = xs.map((v, i) => fn(v, i, xs));
  return keys;
}

/** A count argument that defaults to 1, as the lodash take/drop family does. */
function countArg(a: unknown): number | null {
  if (a === undefined) return 1;
  return isInt32(a) ? a : null;
}

/** The numbers in a list, skipping everything else — what `$sum` does. */
const numbersIn = (xs: readonly unknown[]): number[] => xs.filter((v): v is number => typeof v === "number");

/**
 * Strings JavaScript orders the way MongoDB does.
 *
 * `$min`, `$max` and `$sortArray` compare a string by CODE POINT. JavaScript's
 * `<` compares UTF-16 units, and a surrogate pair sorts BELOW U+E000 there and
 * above it on the server. No surrogate, no disagreement.
 */
const comparableStrings = (keys: readonly unknown[]): boolean =>
  keys.every((k) => typeof k === "string" && !/[\uD800-\uDFFF]/.test(k));

/** A stable sort by a computed key. Mixed or null keys have no BSON order here. */
function sortByKeys(xs: readonly unknown[], keys: readonly unknown[], descending = false): unknown[] | null {
  const kind = (k: unknown): string => (typeof k === "number" ? "number" : typeof k === "string" ? "string" : "other");
  if (keys.some((k) => kind(k) === "other")) return null;
  if (new Set(keys.map(kind)).size > 1) return null;
  if (!keys.every((k) => typeof k === "number") && !comparableStrings(keys)) return null;
  const paired = xs.map((v, i) => ({ v, k: keys[i], i }));
  paired.sort((p, q) => {
    if (p.k === q.k) return p.i - q.i; // stable
    const less = (p.k as number) < (q.k as number);
    return (less ? -1 : 1) * (descending ? -1 : 1);
  });
  return paired.map((p) => p.v);
}

/** One key of a sort argument: the field it names, and which way it runs. */
type SortKey = { readonly field: string; readonly direction: 1 | -1 };

/**
 * The sort argument, as VALUES — the reading `emit/sort-spec.ts` does over source.
 *
 *   .sortBy("age")              .orderBy("age", "desc")
 *   .sortBy(["dept", "age"])    .orderBy(["dept", "age"], ["asc", "desc"])
 *                               .orderBy({ dept: 1, age: -1 })
 *
 * `.sortBy` takes no direction: lodash reads an object there as a matcher. An
 * unnamed direction is ascending. Every spelling the emitter refuses (a leading
 * `$`, an unknown direction, no key at all) is refused here too. So the fold
 * never answers where the program raises.
 */
function sortAsk(name: string, values: readonly unknown[]): SortKey[] | null {
  const direction = (v: unknown): 1 | -1 | null =>
    v === undefined || v === 1 || v === "asc" ? 1 : v === -1 || v === "desc" ? -1 : null;
  const [first, second] = values;
  const keys: SortKey[] = [];

  if (name === "orderBy" && isPlainObject(first)) {
    if (second !== undefined) return null;
    for (const [field, v] of Object.entries(first)) {
      const d = direction(v);
      if (d === null || field === "" || field.startsWith("$")) return null;
      keys.push({ field, direction: d });
    }
    return keys.length === 0 ? null : keys;
  }

  const fields = typeof first === "string" ? [first] : Array.isArray(first) ? first : null;
  if (fields === null || fields.length === 0) return null;
  if (!fields.every((f) => typeof f === "string" && f !== "" && !f.startsWith("$"))) return null;
  if (name === "sortBy" && second !== undefined) return null;
  const directions = second === undefined ? [] : Array.isArray(second) ? second : [second];
  for (const [i, field] of (fields as string[]).entries()) {
    const d = name === "sortBy" ? 1 : direction(directions[i]);
    if (d === null) return null;
    keys.push({ field, direction: d });
  }
  return keys;
}

/** A field's value, one dotted segment at a time — nothing, unless every step is a document. */
function readField(doc: unknown, field: string): unknown {
  let cursor: unknown = doc;
  for (const segment of field.split(".")) {
    if (!isPlainObject(cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

/**
 * `$sortArray` with a `{ field: 1 | -1 }` spec: a STABLE sort by each key in
 * turn. Measured: ten tied elements keep their input order both ways.
 *
 * The server reads a field that is not there as one that sorts below every
 * value. It also compares across BSON types by its own order. So a column
 * that is not one comparable type throughout runs on the server.
 */
function sortByFields(xs: readonly unknown[], keys: readonly SortKey[]): Evaluation {
  const columns = keys.map((k) => xs.map((x) => readField(x, k.field)));
  for (const column of columns) {
    if (!column.every((v) => typeof v === "number") && !comparableStrings(column)) return NO;
  }
  const order = xs.map((_, i) => i);
  order.sort((i, j) => {
    for (const [c, key] of keys.entries()) {
      const left = columns[c][i] as number | string;
      const right = columns[c][j] as number | string;
      if (left !== right) return (left < right ? -1 : 1) * key.direction;
    }
    return i - j; // stable
  });
  return ok(order.map((i) => xs[i]));
}

function arrayMethod(xs: unknown[], name: string, args: readonly Arg[]): Evaluation {
  const [a, b] = args.map(valueOf);
  const fn = fnOf(args[0]);

  /**
   * A predicate answers with a VALUE. This is the reading of it, the same four
   * checks the lowering spells out in the emitted condition: not missing, not
   * null, not `false`, not `""`, not `0`. `.filter("ok")` over `{ ok: "" }` drops
   * the element on the server for exactly that reason, so it does here. The
   * OBJECT family is not this: `.pickBy` lowers to a raw condition, which is
   * MongoDB's truthiness, and keeps `""`.
   */
  const predicate =
    (f: Callable) =>
    (v: unknown, i: number): boolean =>
      truthy(f(v, i, xs));

  switch (name) {
    case "size":
      return ok(xs.length);
    case "map":
      return fn === undefined ? NO : ok(xs.map((v, i) => fn(v, i, xs)));
    case "filter":
      return fn === undefined ? NO : ok(xs.filter(predicate(fn)));
    case "reject":
      return fn === undefined ? NO : ok(xs.filter((v, i) => !predicate(fn)(v, i)));
    case "some":
      return fn === undefined ? NO : ok(xs.some(predicate(fn)));
    case "every":
      return fn === undefined ? NO : ok(xs.every(predicate(fn)));
    case "find": {
      if (fn === undefined) return NO;
      const i = xs.findIndex(predicate(fn));
      // Not found is MISSING on the server, and `undefined` here. Runtime.
      return i === -1 ? NO : ok(xs[i]);
    }
    case "findIndex":
      return fn === undefined ? NO : ok(xs.findIndex(predicate(fn)));
    case "findLastIndex": {
      if (fn === undefined) return NO;
      const test = predicate(fn);
      for (let i = xs.length - 1; i >= 0; i--) if (test(xs[i], i)) return ok(i);
      return ok(-1);
    }
    case "flatMap": {
      if (fn === undefined) return NO;
      const parts = xs.map((v, i) => fn(v, i, xs));
      // JavaScript keeps a non-array result as one element; `$concatArrays`
      // refuses it. `[1,2,3].flatMap(x => null)` is `[null,null,null]` there and
      // `null` on the server.
      if (!parts.every((p) => Array.isArray(p))) return NO;
      return ok((parts as unknown[][]).flat());
    }
    case "reduce": {
      if (fn === undefined || args.length < 2) return NO;
      return ok(xs.reduce((acc, v, i) => fn(acc, v, i, xs), valueOf(args[1])));
    }
    case "partition": {
      if (fn === undefined) return NO;
      const yes: unknown[] = [];
      const no: unknown[] = [];
      xs.forEach((v, i) => (predicate(fn)(v, i) ? yes : no).push(v));
      return ok([yes, no]);
    }
    case "slice":
      return sliceOf(xs, a, b, (parts) => parts);
    case "toReversed":
      return ok([...xs].reverse());
    case "concat":
      // `$concatArrays` takes ARRAYS. `[1].concat(2)` is `[1,2]` in JavaScript
      // and an error on the server.
      if (!args.every((x) => Array.isArray(valueOf(x)))) return NO;
      return ok(xs.concat(...(args.map(valueOf) as unknown[][])));
    // Structurally, the way `$in` and `$indexOfArray` compare. JavaScript's
    // identity would answer false for `[[1]].includes([1])`, where the server
    // answers true, and every literal here is a fresh object.
    case "includes":
      return ok(xs.some((v) => sameValue(v, a)));
    case "indexOf":
      return ok(xs.findIndex((v) => sameValue(v, a)));
    case "lastIndexOf": {
      for (let i = xs.length - 1; i >= 0; i--) if (sameValue(xs[i], a)) return ok(i);
      return ok(-1);
    }
    case "join": {
      if (a !== undefined && typeof a !== "string") return NO;
      // The `$reduce` lowering uses an empty accumulator as its "first element"
      // sentinel, and `$toString` per element. So an EMPTY-STRING element yields
      // a leading separator, and a NULL element collapses the whole result to
      // null. Neither matches JavaScript, so neither folds.
      if (!xs.every((v) => (typeof v === "string" && v !== "") || typeof v === "number")) return NO;
      return ok(xs.join(a as string | undefined));
    }
    case "at": {
      if (!isInt32(a)) return NO;
      const i = a < 0 ? xs.length + a : a;
      return i >= 0 && i < xs.length ? ok(xs[i]) : NO;
    }

    // ── aggregates ──────────────────────────────────────────────────────────
    case "sum":
      // `$sum` skips what is not a number rather than refusing the list.
      return ok(numbersIn(xs).reduce((t, n) => t + n, 0));
    case "mean": {
      const ns = numbersIn(xs);
      // An empty list averages to null, not to a division by zero.
      return ns.length === 0 ? ok(null) : ok(ns.reduce((t, n) => t + n, 0) / ns.length);
    }
    case "min":
    case "max": {
      if (xs.length === 0) return ok(null);
      // One type only: ACROSS types MongoDB orders by its own rules, not by `<`.
      if (xs.every((v) => typeof v === "number")) {
        const ns = xs as number[];
        return ok(name === "min" ? Math.min(...ns) : Math.max(...ns));
      }
      if (!comparableStrings(xs)) return NO;
      const ss = xs as string[];
      return ok(ss.reduce((best, v) => ((name === "min" ? v < best : v > best) ? v : best)));
    }
    case "sumBy":
    case "meanBy": {
      if (fn === undefined) return NO;
      const ns = numbersIn(xs.map((v, i) => fn(v, i, xs)));
      if (name === "sumBy") return ok(ns.reduce((t, n) => t + n, 0));
      return ns.length === 0 ? ok(null) : ok(ns.reduce((t, n) => t + n, 0) / ns.length);
    }
    case "minBy":
    case "maxBy": {
      if (fn === undefined || xs.length === 0) return NO;
      const keys = xs.map((v, i) => fn(v, i, xs));
      if (!keys.every((k) => typeof k === "number") && !comparableStrings(keys)) return NO;
      // The lowering sorts by the key and takes the first, and that sort is stable.
      // So a tie answers with the EARLIEST element, which is what a strict `<` / `>` keeps.
      const ordered = keys as (number | string)[];
      const best = ordered.reduce<number>(
        (bi, k, i) => ((name === "minBy" ? k < ordered[bi] : k > ordered[bi]) ? i : bi),
        0,
      );
      return ok(xs[best]);
    }

    // ── the set family, compared the way MongoDB compares ───────────────────
    case "uniq":
    case "sortedUniq": {
      const out: unknown[] = [];
      for (const v of xs) if (!deepIncludes(out, v)) out.push(v);
      return ok(out);
    }
    case "uniqBy":
    case "sortedUniqBy": {
      if (fn === undefined) return NO;
      const seen: unknown[] = [];
      const out: unknown[] = [];
      xs.forEach((v, i) => {
        const k = fn(v, i, xs);
        if (deepIncludes(seen, k)) return;
        seen.push(k);
        out.push(v);
      });
      return ok(out);
    }
    case "without":
      return ok(xs.filter((v) => !deepIncludes(args.map(valueOf), v)));
    case "xor": {
      if (!Array.isArray(a)) return NO;
      const other = a as unknown[];
      return ok([...xs.filter((v) => !deepIncludes(other, v)), ...other.filter((v) => !deepIncludes(xs, v))]);
    }
    case "differenceBy":
    case "intersectionBy":
    case "unionBy":
    case "xorBy": {
      const other = a;
      const by = fnOf(args[1]);
      if (!Array.isArray(other) || by === undefined) return NO;
      const keyOf = (v: unknown, i: number, list: readonly unknown[]): unknown => by(v, i, list);
      const otherKeys = (other as unknown[]).map(keyOf);
      const mine = xs.filter((v, i) => deepIncludes(otherKeys, keyOf(v, i, xs)));
      const notMine = xs.filter((v, i) => !deepIncludes(otherKeys, keyOf(v, i, xs)));
      if (name === "differenceBy") return ok(notMine);
      if (name === "intersectionBy") return ok(mine);
      const myKeys = xs.map(keyOf);
      const extra = (other as unknown[]).filter((v, i) => !deepIncludes(myKeys, keyOf(v, i, other as unknown[])));
      if (name === "xorBy") return ok([...notMine, ...extra]);
      // `_.unionBy` is the uniqBy of the concatenation: one element per key, the first wins.
      const seen: unknown[] = [];
      const union: unknown[] = [];
      [...xs, ...(other as unknown[])].forEach((v, i, all) => {
        const k = keyOf(v, i, all);
        if (deepIncludes(seen, k)) return;
        seen.push(k);
        union.push(v);
      });
      return ok(union);
    }

    // ── slicing by count ────────────────────────────────────────────────────
    case "take":
    case "drop":
    case "takeRight":
    case "dropRight": {
      const n = countArg(a);
      if (n === null || n < 0) return NO;
      if (name === "take") return ok(xs.slice(0, n));
      if (name === "drop") return ok(xs.slice(n));
      if (name === "takeRight") return ok(n === 0 ? [] : xs.slice(-n));
      return ok(n === 0 ? [...xs] : xs.slice(0, -n));
    }
    case "takeWhile":
    case "dropWhile": {
      if (fn === undefined) return NO;
      let i = 0;
      while (i < xs.length && predicate(fn)(xs[i], i)) i++;
      return ok(name === "takeWhile" ? xs.slice(0, i) : xs.slice(i));
    }
    case "takeRightWhile":
    case "dropRightWhile": {
      if (fn === undefined) return NO;
      let i = xs.length;
      while (i > 0 && predicate(fn)(xs[i - 1], i - 1)) i--;
      return ok(name === "takeRightWhile" ? xs.slice(i) : xs.slice(0, i));
    }
    case "tail":
      return ok(xs.slice(1));
    case "initial":
      return ok(xs.slice(0, -1));
    case "head":
    case "first":
    case "last":
      // An empty list reads as MISSING on the server, not as null.
      return xs.length === 0 ? NO : ok(name === "last" ? xs[xs.length - 1] : xs[0]);
    case "nth": {
      const n = a === undefined ? 0 : a;
      if (!isInt32(n)) return NO;
      const i = n < 0 ? xs.length + n : n;
      return i >= 0 && i < xs.length ? ok(xs[i]) : NO;
    }

    // ── reshaping ───────────────────────────────────────────────────────────
    case "chunk": {
      if (!isInt32(a) || a < 1) return NO;
      const out: unknown[][] = [];
      for (let i = 0; i < xs.length; i += a) out.push(xs.slice(i, i + a));
      return ok(out);
    }
    case "compact":
      return ok(xs.filter((v) => v !== 0 && v !== "" && v !== null && v !== false && v !== undefined));
    case "flatten":
      // ONE level, which is what the runtime lowering does.
      return ok(xs.flat());
    case "flat":
      // `$concatArrays`, which takes ARRAYS only. `.flatten()` wraps a scalar
      // first. `[1, 2].flat()` is an error on the server and `[1, 2]` in JavaScript,
      // and one null element makes the whole answer null there. The row allows a depth
      // of exactly 1, which is the level this concatenates.
      if (a !== undefined && a !== 1) return NO;
      if (!xs.every((v) => Array.isArray(v))) return NO;
      return ok(xs.flat());
    case "zip": {
      const lists = [xs, ...args.map(valueOf)];
      if (!lists.every((l) => Array.isArray(l))) return NO;
      const width = Math.max(...(lists as unknown[][]).map((l) => l.length));
      // Short lists are padded with null, not left ragged.
      return ok(
        Array.from({ length: width }, (_, i) => (lists as unknown[][]).map((l) => (i < l.length ? l[i] : null))),
      );
    }
    case "unzip": {
      if (!xs.every((row) => Array.isArray(row))) return NO;
      const rows = xs as unknown[][];
      const width = Math.max(0, ...rows.map((r) => r.length));
      // A ragged row would produce a hole, and a hole has no BSON value.
      if (!rows.every((r) => r.length === width)) return NO;
      return ok(Array.from({ length: width }, (_, i) => rows.map((r) => r[i])));
    }
    case "zipWith": {
      const lists = [xs, ...args.slice(0, -1).map(valueOf)];
      const with_ = fnOf(args[args.length - 1]);
      if (with_ === undefined || !lists.every((l) => Array.isArray(l))) return NO;
      // The lowering zips to the LONGEST list, and hands the body a null where a
      // list ran out. JavaScript would hand it undefined, and the two answers part
      // (`a + b` is null on the server, a number here). So only equal lengths fold.
      const widths = new Set((lists as unknown[][]).map((l) => l.length));
      if (widths.size !== 1) return NO;
      const width = [...widths][0];
      return ok(Array.from({ length: width }, (_, i) => with_(...(lists as unknown[][]).map((l) => l[i]))));
    }
    case "zipObject": {
      if (!Array.isArray(a)) return NO;
      const values = a as unknown[];
      const out: Record<string, unknown> = {};
      xs.forEach((k, i) => {
        if (!isKey(k)) throw NOT_A_KEY;
        setKey(out, String(k), i < values.length ? values[i] : null);
      });
      return ok(out);
    }
    case "fromPairs": {
      const out: Record<string, unknown> = {};
      for (const pair of xs) {
        if (!Array.isArray(pair) || pair.length === 0 || !isKey(pair[0])) return NO;
        setKey(out, String(pair[0]), pair.length > 1 ? pair[1] : null);
      }
      return ok(out);
    }
    case "keyBy": {
      if (fn === undefined) return NO;
      const out: Record<string, unknown> = {};
      for (const [i, v] of xs.entries()) {
        const k = fn(v, i, xs);
        if (!isKey(k)) return NO;
        setKey(out, String(k), v); // last wins
      }
      return ok(out);
    }
    case "groupBy":
    case "countBy": {
      if (fn === undefined) return NO;
      // A MAP, not an object: the accumulator is keyed by a value the DEVELOPER
      // computed. Reading `out["constructor"]` off a plain object answers a
      // function that was never stored. Writing `out["__proto__"]` stores
      // nothing at all. `Object.fromEntries` then builds the answer safely.
      const out = new Map<string, unknown>();
      for (const [i, v] of xs.entries()) {
        const k = fn(v, i, xs);
        if (!isKey(k)) return NO;
        const key = String(k);
        if (name === "countBy") out.set(key, ((out.get(key) as number) ?? 0) + 1);
        else out.set(key, [...((out.get(key) as unknown[]) ?? []), v]);
      }
      return ok(Object.fromEntries(out));
    }

    // ── ordering ────────────────────────────────────────────────────────────
    case "sortBy":
    case "orderBy": {
      // A key FUNCTION: the sort is by what it computes, which is the
      // `$map` / `$sortArray` / `$map` lowering.
      if (fn !== undefined) {
        const direction = name === "orderBy" ? valueOf(args[1]) : undefined;
        const descending = direction === "desc" || direction === -1;
        if (direction !== undefined && !descending && direction !== "asc" && direction !== 1) return NO;
        const keys = keyedBy(xs, fn);
        if (keys === null) return NO;
        const sorted = sortByKeys(xs, keys, descending);
        return sorted === null ? NO : ok(sorted);
      }
      // No argument at all: the natural order of the values themselves.
      if (args.length === 0) {
        const sorted = sortByKeys(xs, [...xs]);
        return sorted === null ? NO : ok(sorted);
      }
      // Otherwise the argument NAMES fields, and `$sortArray` reads each one out of
      // the element. So a receiver of anything but documents that carry that field
      // is a sort this cannot answer. Reading the argument as a direction, and
      // sorting the ELEMENTS, would answer `[1, 2, 3]` for `[3, 1, 2].sortBy("x")`,
      // where the server leaves the list alone.
      const ask = sortAsk(name, args.map(valueOf));
      return ask === null ? NO : sortByFields(xs, ask);
    }

    default:
      return NO;
  }
}

/** Thrown when a value with no MongoDB key spelling is used as one. */
const NOT_A_KEY = Symbol("value cannot be an object key");
