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
