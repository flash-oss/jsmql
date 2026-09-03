// The scanners: where a token ENDS.
//
// `src/registry/tokens.ts` says which spelling makes which token. It cannot say
// where a token stops, because that is an algorithm — `1_000.5e-3n` is one number
// and `0x507f1f77bcf86cd799439011` is an ObjectId only at exactly 24 hex digits.
// So the table drives the lexer's dispatch and these functions drive its cursor.
//
// Every scanner is a pure function of (source, index). It returns the token and
// the index just past it, or throws with the offset of the character at fault.

import type { TokenName } from "../../registry/vocabulary.ts";
import { type Token, spanned } from "./token.ts";

export class LexError extends Error {
  pos: number;
  constructor(message: string, pos: number) {
    super(`${message} at position ${pos}`);
    this.name = "LexError";
    this.pos = pos;
  }
}

export type Scan = { token: Token; next: number };

const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= "0" && ch <= "9";
const isHex = (ch: string | undefined): boolean =>
  isDigit(ch) || (ch !== undefined && ((ch >= "a" && ch <= "f") || (ch >= "A" && ch <= "F")));

export const isIdentStart = (ch: string | undefined): boolean =>
  ch !== undefined && (ch === "_" || /[A-Za-z]/.test(ch));
export const isIdentPart = (ch: string | undefined): boolean =>
  ch !== undefined && (ch === "_" || /[A-Za-z0-9]/.test(ch));

/**
 * A run of digits with `_` between them. `1_000_000` is one number; a leading,
 * trailing or doubled `_` is an error, so a later `replace(/_/g, "")` is safe.
 */
function digits(src: string, i: number, ok: (ch: string | undefined) => boolean): number {
  if (!ok(src[i])) return i;
  i++;
  while (i < src.length) {
    if (ok(src[i])) {
      i++;
      continue;
    }
    if (src[i] === "_") {
      if (!ok(src[i + 1])) throw new LexError("Numeric separator '_' must be between two digits", i);
      i++;
      continue;
    }
    break;
  }
  return i;
}

/**
 * A number, a BigInt, or a hex run. The lexer assigns no MEANING here — a `0x`
 * lexeme keeps its prefix so the parser can decide whether 24 hex digits make an
 * ObjectId, which is a syntactic question and lives in productions.ts.
 */
export function scanNumber(src: string, start: number): Scan {
  if (src[start] === "0" && (src[start + 1] === "x" || src[start + 1] === "X")) {
    const from = start + 2;
    const i = digits(src, from, isHex);
    if (i === from) {
      throw new LexError(`Hexadecimal literal has no digits after '0${src[from - 1]}'`, start);
    }
    return { token: spanned("Number", src.slice(start, i).replace(/_/g, ""), start, i), next: i };
  }
  let i = digits(src, start, isDigit);
  let fraction = false;
  let exponent = false;
  // Only a digit after the dot makes a fraction, so `0.name` stays a member access.
  if (src[i] === "." && isDigit(src[i + 1])) {
    fraction = true;
    i = digits(src, i + 1, isDigit);
  }
  if (src[i] === "e" || src[i] === "E") {
    exponent = true;
    i++;
    if (src[i] === "+" || src[i] === "-") i++;
    i = digits(src, i, isDigit);
  }
  if (src[i] === "n") {
    if (fraction || exponent) {
      throw new LexError("Invalid BigInt literal: the 'n' suffix requires an integer", start);
    }
    const raw = src.slice(start, i).replace(/_/g, "");
    return { token: spanned("BigInt", raw, start, i + 1), next: i + 1 };
  }
  return { token: spanned("Number", src.slice(start, i).replace(/_/g, ""), start, i), next: i };
}

const ESCAPES: Readonly<Record<string, string>> = { n: "\n", t: "\t", r: "\r" };

/**
 * ONE escape sequence, at the backslash `src[i]`: the character it stands for,
 * and the index just past it. A letter with no entry stands for itself, so
 * `\\` is a backslash and `\"` a quote.
 *
 * The single decoder for every quoted form. A string and a template used to
 * decode separately, and the template copy dropped the backslash and KEPT the
 * letter — `\`a\nb\`` read as "anb". One decoder, one answer.
 */
export function decodeEscape(src: string, i: number): { text: string; next: number } {
  const esc = src[i + 1];
  return { text: esc === undefined ? "" : (ESCAPES[esc] ?? esc), next: i + 2 };
}

/** A quoted string. `text` is the DECODED value, so the span is given explicitly. */
export function scanString(src: string, start: number): Scan {
  const quote = src[start];
  let i = start + 1;
  let out = "";
  while (i < src.length && src[i] !== quote) {
    if (src[i] === "\\") {
      const esc = decodeEscape(src, i);
      out += esc.text;
      i = esc.next;
      continue;
    }
    out += src[i];
    i++;
  }
  if (i >= src.length) throw new LexError("Unterminated string", start);
  return { token: spanned("String", out, start, i + 1), next: i + 1 };
}

export type RegexScan = { token: Token; flags: string; next: number };

/** `/pattern/flags`. A `/` inside a `[…]` class does not close it. */
export function scanRegex(src: string, start: number): RegexScan {
  let i = start + 1;
  let pattern = "";
  let inClass = false;
  let closed = false;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      pattern += ch + (src[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) {
      i++;
      closed = true;
      break;
    } else if (ch === "\n") throw new LexError("Unterminated regex literal", start);
    pattern += ch;
    i++;
  }
  // The old lexer let an unterminated regex reach end-of-input silently. A token
  // that ran off the end is not a token, so it is refused here.
  if (!closed) throw new LexError("Unterminated regex literal", start);
  let flags = "";
  while (i < src.length && /[gimsuy]/.test(src[i])) {
    flags += src[i];
    i++;
  }
  return { token: spanned("RegexLiteral", pattern, start, i), flags, next: i };
}

/** A bare name. What it MEANS is names.ts's business, not the lexer's. */
export function scanIdent(src: string, start: number): Scan {
  let i = start;
  while (i < src.length && isIdentPart(src[i])) i++;
  return { token: spanned("Ident", src.slice(start, i), start, i), next: i };
}

/**
 * Whitespace, a line comment, and a block comment. Returns the first index
 * that is not trivia.
 */
export function skipTrivia(src: string, i: number): number {
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] === "/" && src[i + 1] === "/") {
      while (i < src.length && !/[\n\r\u2028\u2029]/.test(src[i])) i++;
      continue;
    }
    if (src[i] === "/" && src[i + 1] === "*") {
      const at = i;
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      if (i >= src.length) throw new LexError("Unterminated block comment", at);
      i += 2;
      continue;
    }
    return i;
  }
}

export type { TokenName };
