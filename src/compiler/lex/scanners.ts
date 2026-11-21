import type { TokenName } from "../../registry/vocabulary.ts";
import { type Token, spanned } from "./token.ts";

export class LexError extends Error {
  pos: number;
  constructor(message: string, pos: number) {
    super(/\bat position \d+/.test(message) ? message : `${message} at position ${pos}`);
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
  if (src[i] === ".") {
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

const ESCAPES: Readonly<Record<string, string>> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" };

export function decodeEscape(src: string, i: number): { text: string; next: number } {
  const esc = src[i + 1];
  if (esc === undefined) return { text: "", next: i + 2 };
  if (esc === "x" && isHex(src[i + 2]) && isHex(src[i + 3])) {
    return { text: String.fromCharCode(parseInt(src.slice(i + 2, i + 4), 16)), next: i + 4 };
  }
  if (esc === "u") {
    if (src[i + 2] === "{") {
      const close = src.indexOf("}", i + 3);
      const hex = close === -1 ? "" : src.slice(i + 3, close);
      if (hex.length > 0 && [...hex].every((c) => isHex(c))) {
        const point = parseInt(hex, 16);
        if (point <= 0x10ffff) return { text: String.fromCodePoint(point), next: close + 1 };
      }
    } else if ([2, 3, 4, 5].every((k) => isHex(src[i + k]))) {
      return { text: String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16)), next: i + 6 };
    }
  }
  return { text: ESCAPES[esc] ?? esc, next: i + 2 };
}

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
  if (!closed) throw new LexError("Unterminated regex literal", start);
  let flags = "";
  while (i < src.length && /[gimsuy]/.test(src[i])) {
    flags += src[i];
    i++;
  }
  return { token: spanned("RegexLiteral", pattern, start, i), flags, next: i };
}

export function scanIdent(src: string, start: number): Scan {
  let i = start;
  while (i < src.length && isIdentPart(src[i])) i++;
  return { token: spanned("Ident", src.slice(start, i), start, i), next: i };
}

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
