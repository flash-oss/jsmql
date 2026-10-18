// The string operators.
//
// A string here is well formed: the walk refuses a string with a lone surrogate,
// because no UTF-8 encoding exists for one. The server counts and cuts a string
// in code points (`CP`) or in bytes (`Bytes`), and JavaScript counts UTF-16 units. So
// every rule here works on code points or on UTF-8 bytes, never on `.length`.
// A string operator that accepts a null or a number on the server (and
// answers a coerced value) is refused for that operand: HR7 refuses it before the interpreter.

import type { Rule } from "./values.ts";
import {
  NO,
  NumberText,
  asciiLower,
  asciiUpper,
  compareCodePoints,
  isInt32,
  kindOf,
  ok,
  numberSpelling,
  points,
  spellable,
} from "./values.ts";
import { keyed, positional } from "./operand.ts";
import { bsonTagOf, objectIdHex } from "../../bson.ts";

const isString = (v: unknown): v is string => typeof v === "string";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const utf8 = (s: string): Uint8Array => encoder.encode(s);

/** The first offset at or after `from` where `needle` lies in `bytes`, or -1. */
function findBytes(bytes: Uint8Array, needle: Uint8Array, from: number): number {
  for (let i = from; i + needle.length <= bytes.length; i++) {
    if (needle.every((b, j) => bytes[i + j] === b)) return i;
  }
  return -1;
}

// ── new strings ─────────────────────────────────────────────────────────────────

const concat = positional(0, Infinity, (xs) => {
  if (!xs.every((x) => x === null || isString(x))) return NO;
  return xs.includes(null) ? ok(null) : spellable((xs as string[]).join(""));
});

/** `$toUpper` and `$toLower` change the ASCII letters. A null gives the empty string. */
const letterCase = (change: (s: string) => string): Rule =>
  positional(1, 1, ([s]) => (s === null ? ok("") : isString(s) ? ok(change(s)) : NO));

/**
 * `$toString` writes an ObjectId as its 24 hex digits, an integer type as its digits, and a
 * Decimal128 as the text that its type prints. A number that has no exact spelling here is a `NumberText`.
 */
const toString = positional(1, 1, ([v]) => {
  if (v === null || isString(v)) return ok(v);
  if (typeof v === "boolean") return ok(String(v));
  if (typeof v === "number") return ok(numberSpelling(v) ?? new NumberText());
  if (kindOf(v) === "objectId") return objectIdHex(v) === null ? NO : ok(objectIdHex(v));
  const tag = bsonTagOf(v);
  // An unsigned Long above the signed range prints as a wrapped number on the server.
  if (tag === "Long" && (v as { unsigned?: boolean }).unsigned === true) return NO;
  return tag !== undefined && TEXT_OF.has(tag) ? ok(String(v)) : NO;
});

/** The tagged values whose own text is the text that the server writes. */
const TEXT_OF = new Set(["Decimal128", "Long", "Int32"]);

// ── trim ─────────────────────────────────────────────────────────────────

/** The code points that `$trim` removes by default, as measured on the server. */
const DEFAULT_TRIM = (cp: number): boolean =>
  cp === 0 || (cp >= 9 && cp <= 13) || cp === 32 || cp === 0xa0 || cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200a);

/**
 * The documentation lists more spaces than the server trims. These are the ones
 * where the two disagree. A string with one of them is a refusal, so the answer
 * does not depend on the version of the server.
 */
const DISPUTED = /[\u0085\u2028\u2029\u202f\u205f\u3000]/;

const trimming = (left: boolean, right: boolean): Rule =>
  keyed(["input"], ["chars"], (parts, walk) => {
    const input = walk.at(parts.input);
    if (!input.ok) return input;
    if (!isString(input.value)) return NO;
    let drops: (cp: number) => boolean;
    if ("chars" in parts) {
      const chars = walk.at(parts.chars);
      if (!chars.ok) return chars;
      if (!isString(chars.value)) return NO;
      const set = new Set(points(chars.value).map((c) => c.codePointAt(0)));
      drops = (cp) => set.has(cp);
    } else {
      if (DISPUTED.test(input.value)) return NO;
      drops = DEFAULT_TRIM;
    }
    const cps = points(input.value).map((c) => c.codePointAt(0) as number);
    let from = 0;
    let to = cps.length;
    if (left) while (from < to && drops(cps[from])) from++;
    if (right) while (to > from && drops(cps[to - 1])) to--;
    return ok(
      cps
        .slice(from, to)
        .map((cp) => String.fromCodePoint(cp))
        .join(""),
    );
  });

// ── length and cut ────────────────────────────────────────────────────

const strLenCP = positional(1, 1, ([s]) => (isString(s) ? ok(points(s).length) : NO));
const strLenBytes = positional(1, 1, ([s]) => (isString(s) ? ok(utf8(s).length) : NO));

const substrCP = positional(3, 3, ([s, start, length]) => {
  if (!isString(s) || !isInt32(start) || !isInt32(length) || start < 0 || length < 0) return NO;
  return ok(
    points(s)
      .slice(start, start + length)
      .join(""),
  );
});

/** A continuation byte is the 10xxxxxx part of a multi-byte character. A cut may not start or end on one. */
const isContinuation = (byte: number | undefined): boolean => byte !== undefined && (byte & 0xc0) === 0x80;

/** `$substrBytes` cuts at byte offsets. A negative length means the rest of the string. */
const substrBytes = positional(3, 3, ([s, start, length]) => {
  if (!isString(s) || !isInt32(start) || !isInt32(length) || start < 0) return NO;
  const bytes = utf8(s);
  if (start >= bytes.length) return ok("");
  const stop = length < 0 ? bytes.length : Math.min(start + length, bytes.length);
  if (isContinuation(bytes[start]) || isContinuation(bytes[stop])) return NO;
  return ok(decoder.decode(bytes.subarray(start, stop)));
});

// ── search ────────────────────────────────────────────────────────────────

/**
 * `$indexOfCP` counts code points. Its end bound differs on the server, so the rule refuses an end bound.
 * MEASURED: a start at or past the end gives -1, also for the empty string, unless the start is 0.
 */
const indexOfCP = positional(2, 3, ([s, needle, from = 0]) => {
  if (!isString(needle) || !isInt32(from) || from < 0) return NO;
  if (s === null) return ok(null);
  if (!isString(s)) return NO;
  const text = points(s);
  if (from > 0 && from >= text.length) return ok(-1);
  const find = points(needle);
  for (let i = from; i + find.length <= text.length; i++) {
    if (find.every((c, j) => text[i + j] === c)) return ok(i);
  }
  return ok(-1);
});

/** `$indexOfBytes` counts bytes. A match must lie wholly inside the range. */
const indexOfBytes = positional(2, 4, ([s, needle, from = 0, to]) => {
  if (!isString(needle) || needle === "" || !isInt32(from) || from < 0) return NO;
  if (to !== undefined && !(isInt32(to) && to >= 0)) return NO;
  if (s === null) return ok(null);
  if (!isString(s)) return NO;
  const bytes = utf8(s);
  const find = utf8(needle);
  const found = findBytes(bytes, find, from);
  const stop = to === undefined ? bytes.length : to;
  return ok(found !== -1 && found + find.length <= stop ? found : -1);
});

const split = positional(2, 2, ([s, separator]) => {
  if (!isString(s) || !isString(separator) || separator === "") return NO;
  return spellable(s.split(separator));
});

/** `$replaceOne` and `$replaceAll` take a keyed operand. An empty `find` has a server answer that the rule does not model, so the rule refuses it. */
const replacing = (all: boolean): Rule =>
  keyed(["input", "find", "replacement"], [], (parts, walk) => {
    const input = walk.at(parts.input);
    const find = walk.at(parts.find);
    const replacement = walk.at(parts.replacement);
    if (!input.ok) return input;
    if (!find.ok) return find;
    if (!replacement.ok) return replacement;
    const [text, what, by] = [input.value, find.value, replacement.value];
    if (!isString(text) || !isString(what) || !isString(by) || what === "") return NO;
    if (all) return spellable(text.split(what).join(by));
    const at = text.indexOf(what);
    return spellable(at === -1 ? text : text.slice(0, at) + by + text.slice(at + what.length));
  });

/** `$strcasecmp` upper-cases the ASCII letters, then compares by code point. */
const strcasecmp = positional(2, 2, ([a, b]) => {
  if (!isString(a) || !isString(b)) return NO;
  const order = compareCodePoints(asciiUpper(a), asciiUpper(b));
  return ok(order < 0 ? -1 : order > 0 ? 1 : 0);
});

export const STRING: Record<string, Rule> = {
  $concat: concat,
  $toUpper: letterCase(asciiUpper),
  $toLower: letterCase(asciiLower),
  $toString: toString,
  $trim: trimming(true, true),
  $ltrim: trimming(true, false),
  $rtrim: trimming(false, true),
  $strLenCP: strLenCP,
  $strLenBytes: strLenBytes,
  $substrCP: substrCP,
  $substrBytes: substrBytes,
  $substr: substrBytes,
  $indexOfCP: indexOfCP,
  $indexOfBytes: indexOfBytes,
  $split: split,
  $replaceOne: replacing(false),
  $replaceAll: replacing(true),
  $strcasecmp: strcasecmp,
};
