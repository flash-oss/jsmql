// What a method call computes when its receiver and arguments are constants.
//
// Two tables, because the language has two shapes of call. A NAMESPACE call
// reads nothing — `Math.max(3, 7)` — while an INSTANCE call has a receiver whose
// value decides which rule applies: `.slice()` cuts a string or an array, and
// the value tells us which.
//
// Every rule here answers the LANGUAGE's question, not JavaScript's, wherever
// the two differ — and they do differ, in ways worth naming:
//   'Ä'.toUpperCase()     JSMQL: 'Ä'      JavaScript: 'Ä'   ($toUpper is ASCII)
//   new Date(2020, 1, 1)  JSMQL: January  JavaScript: February  (months are 1-based)
//   (2.5).round()         JSMQL: 2        JavaScript: 3     (banker's rounding)
// A rule that cannot answer the language's question returns nothing, and the
// call stays a runtime one.

import type { Evaluation } from "./evaluate.ts";

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

// ── namespace calls ──────────────────────────────────────────────────────────

/**
 * `Math.<name>(…)` — the ones whose result is EXACTLY specified.
 *
 * Measured against mongod: eleven of the twenty-nine differ, most by one unit in
 * the last place, and `Math.round(0.5)` by a whole unit. That is not a defect in
 * either implementation — IEEE-754 pins down `sqrt` and the algebraic operations
 * and leaves every transcendental free — so `cbrt log2 cos tan asin acos atan
 * sinh cosh atanh` and friends are left to run on the server, where the answer
 * is whatever the server says it is. Agreement at the points one happens to test
 * is not a guarantee, so the line is drawn by the standard rather than by luck.
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
  round: ([x]) => bankersRound(x, 0),
};

/** MongoDB's rounding: a half goes to the even neighbour. `$round`, `.round()`. */
function bankersRound(n: number, places: number): number {
  const scale = 10 ** places;
  const scaled = n * scale;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  if (diff !== 0.5) return Math.round(scaled) / scale;
  return (floor % 2 === 0 ? floor : floor + 1) / scale;
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

  if (namespace === "Object") {
    const [o, b] = values;
    const plain = (v: unknown): v is Record<string, unknown> =>
      typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
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
 * The registry says these two are read rather than called; what they are worth
 * is arithmetic, and lives here.
 */
export function foldNamespaceConstant(namespace: string, name: string): Evaluation {
  if (namespace !== "Math") return NO;
  if (name === "PI") return ok(Math.PI);
  if (name === "E") return ok(Math.E);
  return NO;
}

// ── instance calls ───────────────────────────────────────────────────────────

/**
 * `<constant>.<name>(…)`.
 *
 * The receiver's runtime type picks the rule, which is why one table serves
 * `.slice()` on a string and on an array: by the time we are here the value is
 * in hand, so there is nothing to infer.
 */
export function foldInstanceCall(receiver: unknown, name: string, args: readonly Arg[]): Evaluation {
  if (typeof receiver === "string") return stringMethod(receiver, name, args);
  if (Array.isArray(receiver)) return arrayMethod(receiver, name, args);
  if (typeof receiver === "number") return numberMethod(receiver, name, args);
  // PLAIN objects only. A RegExp, a Date and a BSON value are all objects to
  // JavaScript, and reading one with the object rules answers about the wrong
  // thing entirely: `/ab/.size()` would be `Object.keys(regex).length`, which
  // is 0 and means nothing. The language refuses those receivers, and so does
  // this — a fold may never answer a question the language does not ask.
  if (isPlainObject(receiver)) return objectMethod(receiver as Record<string, unknown>, name, args);
  return NO;
}

/** An object whose own properties are all there is to it — not a Date, not BSON. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  if (v instanceof Date || v instanceof RegExp || v instanceof Uint8Array) return false;
  if ((v as { _bsontype?: unknown })._bsontype !== undefined) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

// ── the lodash string family ─────────────────────────────────────────────────
//
// These have no JavaScript counterpart, so there is nothing to inherit and the
// rules are written out. Each mirrors the `$regexFindAll` split the runtime
// lowering uses, which is ASCII-only — the same reason `$toUpper` is.

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
          .map((w) => asciiUpper(w.slice(0, 1)) + w.slice(1))
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
      if (a === null || typeof a !== "object" || Array.isArray(a)) return NO;
      const options = a as Record<string, unknown>;
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
    case "indexOf":
      return typeof a === "string" ? ok(s.indexOf(a, typeof b === "number" ? b : undefined)) : NO;
    // No `lastIndexOf`: the language refuses it on a string, because `$indexOfCP`
    // only searches forward. Folding it would ADD a method to the language.
    case "charAt":
      return typeof a === "number" ? ok(points(s)[a] ?? "") : NO;
    case "at": {
      if (typeof a !== "number") return NO;
      const cps = points(s);
      const i = a < 0 ? cps.length + a : a;
      // Out of range answers `undefined` in JavaScript and MISSING on the
      // server, which are not the same thing. It stays a runtime read.
      return i >= 0 && i < cps.length ? ok(cps[i]) : NO;
    }
    case "slice":
      return sliceOf(points(s), a, b, (parts) => parts.join(""));
    case "substring": {
      if (typeof a !== "number") return NO;
      const cps = points(s);
      const end = typeof b === "number" ? b : cps.length;
      const [lo, hi] = [Math.max(0, Math.min(a, end)), Math.min(cps.length, Math.max(a, end))];
      return ok(cps.slice(lo, hi).join(""));
    }
    case "repeat":
      // A negative count is a `RangeError` in JavaScript. Refusing keeps the
      // error jsmql's, with a position, instead of a bare V8 message.
      return typeof a === "number" && a >= 0 && Number.isFinite(a) ? ok(s.repeat(Math.floor(a))) : NO;
    case "padStart":
      return typeof a === "number" ? ok(s.padStart(a, typeof b === "string" ? b : " ")) : NO;
    case "padEnd":
      return typeof a === "number" ? ok(s.padEnd(a, typeof b === "string" ? b : " ")) : NO;
    case "split":
      // `$split` rejects an empty separator, so the two disagree there.
      return typeof a === "string" && a !== "" ? ok(s.split(a, typeof b === "number" ? b : undefined)) : NO;
    case "concat":
      return args.every((x) => typeof valueOf(x) === "string") ? ok(s + args.map(valueOf).join("")) : NO;
    case "length":
      return ok(points(s).length);
    default:
      return lodashString(s, name, args);
  }
}

/** `.slice(start, end)` over a list, with JavaScript's negative-index rules. */
function sliceOf<T>(items: T[], start: unknown, end: unknown, done: (parts: T[]) => unknown): Evaluation {
  if (start !== undefined && typeof start !== "number") return NO;
  if (end !== undefined && typeof end !== "number") return NO;
  return ok(done(items.slice(start as number | undefined, end as number | undefined)));
}

function numberMethod(n: number, name: string, args: readonly Arg[]): Evaluation {
  const [a, b] = args.map(valueOf);
  const places = typeof a === "number" && Number.isInteger(a) ? a : 0;
  if (a !== undefined && !Number.isInteger(a)) return NO;
  const scale = 10 ** places;
  switch (name) {
    case "round":
      // `$round` rounds a half to the EVEN neighbour; JavaScript rounds it up.
      return ok(bankersRound(n, places));
    case "ceil":
      return ok(Math.ceil(n * scale) / scale);
    case "floor":
      return ok(Math.floor(n * scale) / scale);
    case "clamp":
      if (typeof a !== "number") return NO;
      return typeof b === "number" ? ok(Math.min(Math.max(n, a), b)) : ok(Math.min(n, a));
    case "inRange":
      if (typeof a !== "number") return NO;
      return typeof b === "number" ? ok(n >= Math.min(a, b) && n < Math.max(a, b)) : ok(n >= 0 && n < a);
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
        out[String(v)] = k;
      }
      return ok(out);
    }
    case "pick":
    case "omit": {
      if (!Array.isArray(a) || !a.every((k) => typeof k === "string")) return NO;
      const keep = new Set(a as string[]);
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(o)) if (keep.has(k) === (name === "pick")) out[k] = v;
      return ok(out);
    }
    case "mapValues": {
      if (fn === undefined) return NO;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(o)) out[k] = fn(v, k, o);
      return ok(out);
    }
    case "mapKeys": {
      if (fn === undefined) return NO;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(o)) {
        const key = fn(v, k, o);
        if (!isKey(key)) return NO;
        out[String(key)] = v;
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
        // JavaScript's truthiness and MongoDB's part company — `""` and `0` are
        // false there and true here — so it does not fold.
        if (typeof verdict !== "boolean") return NO;
        if (verdict === (name === "pickBy")) out[k] = v;
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
 * `$setUnion` and friends compare VALUES, so `[{a:1}]` and `[{a:1}]` are one
 * element to them and two to JavaScript's `includes`. The lodash set family here
 * follows MongoDB; `.includes()` and `.indexOf()` keep JavaScript's identity,
 * which is what the runtime lowering of those two does.
 */
const deepEqual = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

const deepIncludes = (haystack: readonly unknown[], needle: unknown): boolean =>
  haystack.some((h) => deepEqual(h, needle));

/** Every element, keyed for comparison. Non-scalar keys have no MongoDB spelling. */
function keyedBy(xs: readonly unknown[], fn: Callable): unknown[] | null {
  const keys = xs.map((v, i) => fn(v, i, xs));
  return keys;
}

/** A count argument that defaults to 1, as the lodash take/drop family does. */
function countArg(a: unknown): number | null {
  if (a === undefined) return 1;
  return typeof a === "number" && Number.isInteger(a) ? a : null;
}

/** The numbers in a list, skipping everything else — what `$sum` does. */
const numbersIn = (xs: readonly unknown[]): number[] => xs.filter((v): v is number => typeof v === "number");

/** A stable sort by a computed key. Mixed or null keys have no BSON order here. */
function sortByKeys(xs: readonly unknown[], keys: readonly unknown[], descending = false): unknown[] | null {
  const kind = (k: unknown): string => (typeof k === "number" ? "number" : typeof k === "string" ? "string" : "other");
  if (keys.some((k) => kind(k) === "other")) return null;
  if (new Set(keys.map(kind)).size > 1) return null;
  const paired = xs.map((v, i) => ({ v, k: keys[i], i }));
  paired.sort((p, q) => {
    if (p.k === q.k) return p.i - q.i; // stable
    const less = (p.k as number) < (q.k as number);
    return (less ? -1 : 1) * (descending ? -1 : 1);
  });
  return paired.map((p) => p.v);
}

function arrayMethod(xs: unknown[], name: string, args: readonly Arg[]): Evaluation {
  const [a, b] = args.map(valueOf);
  const fn = fnOf(args[0]);

  /** A predicate must answer with a boolean; see `pickBy` above for why. */
  const predicate =
    (f: Callable) =>
    (v: unknown, i: number): boolean => {
      const verdict = f(v, i, xs);
      if (typeof verdict !== "boolean") throw NOT_A_BOOLEAN;
      return verdict;
    };

  switch (name) {
    case "length":
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
    case "flatMap":
      return fn === undefined ? NO : ok(xs.flatMap((v, i) => fn(v, i, xs) as unknown[]));
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
      return ok(xs.concat(...(args.map(valueOf) as unknown[])));
    case "includes":
      return ok(xs.includes(a));
    case "indexOf":
      return ok(xs.indexOf(a));
    case "lastIndexOf":
      return ok(xs.lastIndexOf(a));
    case "join":
      return a === undefined || typeof a === "string" ? ok(xs.join(a as string | undefined)) : NO;
    case "at": {
      if (typeof a !== "number") return NO;
      const i = a < 0 ? xs.length + a : Math.trunc(a);
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
      // Only numbers: across types MongoDB orders by its own rules, not by `<`.
      if (!xs.every((v) => typeof v === "number")) return NO;
      const ns = xs as number[];
      return ok(name === "min" ? Math.min(...ns) : Math.max(...ns));
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
      if (!keys.every((k) => typeof k === "number")) return NO;
      const best = (keys as number[]).reduce(
        (bi, k, i) => ((name === "minBy" ? k < (keys[bi] as number) : k > (keys[bi] as number)) ? i : bi),
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
      return ok(name === "unionBy" ? [...xs, ...extra] : [...notMine, ...extra]);
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
      if (typeof n !== "number" || !Number.isInteger(n)) return NO;
      const i = n < 0 ? xs.length + n : n;
      return i >= 0 && i < xs.length ? ok(xs[i]) : NO;
    }

    // ── reshaping ───────────────────────────────────────────────────────────
    case "chunk": {
      if (typeof a !== "number" || !Number.isInteger(a) || a < 1) return NO;
      const out: unknown[][] = [];
      for (let i = 0; i < xs.length; i += a) out.push(xs.slice(i, i + a));
      return ok(out);
    }
    case "compact":
      return ok(xs.filter((v) => v !== 0 && v !== "" && v !== null && v !== false && v !== undefined));
    case "flatten":
      // ONE level, which is what the runtime lowering does.
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
      const width = Math.min(...(lists as unknown[][]).map((l) => l.length));
      return ok(Array.from({ length: width }, (_, i) => with_(...(lists as unknown[][]).map((l) => l[i]))));
    }
    case "zipObject": {
      if (!Array.isArray(a)) return NO;
      const values = a as unknown[];
      const out: Record<string, unknown> = {};
      xs.forEach((k, i) => {
        if (!isKey(k)) throw NOT_A_KEY;
        out[String(k)] = i < values.length ? values[i] : null;
      });
      return ok(out);
    }
    case "fromPairs": {
      const out: Record<string, unknown> = {};
      for (const pair of xs) {
        if (!Array.isArray(pair) || pair.length === 0 || !isKey(pair[0])) return NO;
        out[String(pair[0])] = pair.length > 1 ? pair[1] : null;
      }
      return ok(out);
    }
    case "keyBy": {
      if (fn === undefined) return NO;
      const out: Record<string, unknown> = {};
      for (const [i, v] of xs.entries()) {
        const k = fn(v, i, xs);
        if (!isKey(k)) return NO;
        out[String(k)] = v; // last wins
      }
      return ok(out);
    }
    case "groupBy":
    case "countBy": {
      if (fn === undefined) return NO;
      const out: Record<string, unknown> = {};
      for (const [i, v] of xs.entries()) {
        const k = fn(v, i, xs);
        if (!isKey(k)) return NO;
        const key = String(k);
        if (name === "countBy") out[key] = ((out[key] as number) ?? 0) + 1;
        else (out[key] = (out[key] as unknown[]) ?? []) && (out[key] as unknown[]).push(v);
      }
      return ok(out);
    }

    // ── ordering ────────────────────────────────────────────────────────────
    case "sortBy": {
      const keys = fn === undefined ? [...xs] : keyedBy(xs, fn);
      if (keys === null) return NO;
      const sorted = sortByKeys(xs, keys);
      return sorted === null ? NO : ok(sorted);
    }
    case "orderBy": {
      const by = fnOf(args[0]);
      const direction = valueOf(args[1]);
      const descending = direction === "desc" || direction === -1;
      if (direction !== undefined && !descending && direction !== "asc" && direction !== 1) return NO;
      const keys = by === undefined ? [...xs] : keyedBy(xs, by);
      if (keys === null) return NO;
      const sorted = sortByKeys(xs, keys, descending);
      return sorted === null ? NO : ok(sorted);
    }

    default:
      return NO;
  }
}

/** Thrown when a value with no MongoDB key spelling is used as one. */
const NOT_A_KEY = Symbol("value cannot be an object key");

/** Thrown by a predicate whose answer is not a boolean; caught by the caller. */
export const NOT_A_BOOLEAN = Symbol("predicate did not answer with a boolean");
