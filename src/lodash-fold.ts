// Compile-time JS implementations of the lodash string methods, used by the
// constant folder (const-eval.ts). CRITICAL: the source of truth for these is
// jsmql's OWN MQL lowering (codegen.ts), NOT real lodash — jsmql's versions are
// ASCII-only and use one specific word pattern. Each function here mirrors the
// exact expression its `generateMethodCall` case builds, and the shared
// constants (word regex, HTML-entity table) are imported from lodash-shared.ts
// so the two can't drift. Every function is validated against its MQL lowering
// on a real mongod by test/fold-consistency.test.ts (HR3). See
// docs/specs/const-folding.md § fidelity contract.

import { ASCII_WORDS_RE, HTML_ESCAPE_PAIRS } from "./lodash-shared.ts";

// ASCII-only case, matching MongoDB `$toUpper`/`$toLower` (non-ASCII unchanged).
function asciiUpper(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 97 && c <= 122 ? String.fromCharCode(c - 32) : s[i];
  }
  return out;
}
function asciiLower(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : s[i];
  }
  return out;
}

// The ASCII words of a string (mirrors `wordsExpr` → `$regexFindAll`).
export function words(s: string): string[] {
  return s.match(new RegExp(ASCII_WORDS_RE, "g")) ?? [];
}

// upper-first-char + lower-rest (mirrors `capitalizeExpr`).
function capitalizeWord(s: string): string {
  return asciiUpper(s.slice(0, 1)) + asciiLower(s.slice(1));
}

export function capitalize(s: string): string {
  return capitalizeWord(s);
}
export function upperFirst(s: string): string {
  return asciiUpper(s.slice(0, 1)) + s.slice(1);
}
export function lowerFirst(s: string): string {
  return asciiLower(s.slice(0, 1)) + s.slice(1);
}
export function kebabCase(s: string): string {
  return asciiLower(words(s).join("-"));
}
export function snakeCase(s: string): string {
  return asciiLower(words(s).join("_"));
}
export function startCase(s: string): string {
  return words(s).map(capitalizeWord).join(" ");
}
export function camelCase(s: string): string {
  const pascal = words(s).map(capitalizeWord).join("");
  return asciiLower(pascal.slice(0, 1)) + pascal.slice(1);
}
export function escape(s: string): string {
  let e = s;
  for (const [find, replacement] of HTML_ESCAPE_PAIRS) e = e.split(find).join(replacement);
  return e;
}

// truncate({ length = 30, omission = "..." }) — mirrors the `$cond`/`$substrCP`
// lowering. `separator` (word-boundary) is unsupported there and unsupported here.
export function truncate(s: string, length: number, omission: string): string {
  if (s.length <= length) return s;
  const keep = Math.max(0, length - omission.length);
  return s.slice(0, keep) + omission;
}

// ── shared helpers (mirror MQL semantics) ─────────────────────────────────────

/** BSON deep equality — the semantics of `$in` / `$eq` (used by uniq/without). */
export function bsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => bsonEqual(x, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every(
      (k) =>
        Object.prototype.hasOwnProperty.call(b, k) &&
        bsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

/** JS truthiness (for `.compact`), mirroring codegen's `jsBool`: false / null /
 *  undefined / 0 / "" are falsy. NaN is truthy — jsmql's documented divergence. */
export function jsTruthy(v: unknown): boolean {
  return !(v === false || v === null || v === undefined || v === 0 || v === "");
}

/** `$toString` of a key value (for object-key building in keyBy/groupBy/invert/…). */
export function mqlKeyString(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined; // non-scalar key — the lowering wouldn't produce a clean key; withhold
}

// ── number methods ────────────────────────────────────────────────────────────

export function clamp(n: number, lower: number, upper: number): number {
  return Math.min(Math.max(n, lower), upper);
}
export function inRange(n: number, a: number, b?: number): boolean {
  const lo = b === undefined ? 0 : a;
  const hi = b === undefined ? a : b;
  return n >= Math.min(lo, hi) && n < Math.max(lo, hi);
}
/** Half-to-even (banker's) rounding at precision `p`, matching MongoDB `$round`. */
export function round(n: number, p: number): number {
  const f = 10 ** p;
  const x = n * f;
  const floor = Math.floor(x);
  const diff = x - floor;
  let r: number;
  if (diff < 0.5) r = floor;
  else if (diff > 0.5) r = floor + 1;
  else r = floor % 2 === 0 ? floor : floor + 1; // exactly .5 → nearest even
  return r / f;
}
export function ceilN(n: number, p: number): number {
  if (p === 0) return Math.ceil(n);
  const f = 10 ** p;
  return Math.ceil(n * f) / f;
}
export function floorN(n: number, p: number): number {
  if (p === 0) return Math.floor(n);
  const f = 10 ** p;
  return Math.floor(n * f) / f;
}

// ── array methods (non-iteratee) ──────────────────────────────────────────────

const isNum = (x: unknown): x is number => typeof x === "number";

export function sum(arr: unknown[]): number {
  return arr.filter(isNum).reduce((a, b) => a + b, 0); // $sum: numeric only, empty → 0
}
/** null on empty (matching `$avg`); averages numeric elements only. */
export function mean(arr: unknown[]): number | null {
  const ns = arr.filter(isNum);
  return ns.length === 0 ? null : ns.reduce((a, b) => a + b, 0) / ns.length;
}
export function uniq(arr: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const x of arr) if (!out.some((y) => bsonEqual(x, y))) out.push(x);
  return out;
}
export function compact(arr: unknown[]): unknown[] {
  return arr.filter(jsTruthy);
}
export function flatten(arr: unknown[]): unknown[] {
  return arr.reduce<unknown[]>((acc, x) => acc.concat(Array.isArray(x) ? x : [x]), []);
}
export function chunk(arr: unknown[], size: number): unknown[][] {
  const out: unknown[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
export function take(arr: unknown[], n: number): unknown[] {
  return arr.slice(0, Math.max(0, n));
}
export function drop(arr: unknown[], n: number): unknown[] {
  return arr.slice(Math.max(0, n));
}
export function takeRight(arr: unknown[], n: number): unknown[] {
  return n <= 0 ? [] : arr.slice(-n);
}
export function dropRight(arr: unknown[], n: number): unknown[] {
  return arr.slice(0, Math.max(0, arr.length - n));
}
export function without(arr: unknown[], values: unknown[]): unknown[] {
  return arr.filter((x) => !values.some((v) => bsonEqual(x, v)));
}
export function xor(a: unknown[], b: unknown[]): unknown[] {
  const aNotB = a.filter((x) => !b.some((y) => bsonEqual(x, y)));
  const bNotA = b.filter((x) => !a.some((y) => bsonEqual(x, y)));
  return uniq(aNotB.concat(bNotA));
}
/** Zip to the LONGEST array, padding short arrays with null (matching the lowering). */
export function zip(arrays: unknown[][]): unknown[][] {
  const len = arrays.reduce((m, a) => Math.max(m, a.length), 0);
  const out: unknown[][] = [];
  for (let i = 0; i < len; i++) out.push(arrays.map((a) => (i < a.length ? a[i] : null)));
  return out;
}
export function unzip(rows: unknown[][]): unknown[][] {
  const cols = Array.isArray(rows[0]) ? rows[0].length : 0;
  const out: unknown[][] = [];
  for (let j = 0; j < cols; j++) out.push(rows.map((r) => (r as unknown[])[j]));
  return out;
}
