// Constants shared between the MQL lowering of the lodash string methods
// (codegen.ts) and their compile-time JS fold (lodash-fold.ts). They live here
// so the two implementations physically cannot drift — a change to the word
// pattern or the HTML-entity table applies to both at once. See
// docs/specs/const-folding.md § fidelity contract.

// lodash's ASCII word pattern: `[A-Z]?[a-z]+ | [A-Z]+(?![a-z]) | [A-Z] | [0-9]+`
// — e.g. "foo-barBaz 9" → ["foo", "bar", "Baz", "9"], "FOOBar" → ["FOO", "Bar"].
// ASCII-only by design (matching `$toUpper`/`$toLower`); accented text is
// treated as separators. Used as a `$regexFindAll` regex (no flags) in codegen
// and with a "g" flag in the fold.
export const ASCII_WORDS_RE = "[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[A-Z]|[0-9]+";

// HTML entities for `.escape()`, in application order — `&` MUST run first so
// the `&` it introduces isn't re-escaped.
export const HTML_ESCAPE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["&", "&amp;"],
  ["<", "&lt;"],
  [">", "&gt;"],
  ['"', "&quot;"],
  ["'", "&#39;"],
];
