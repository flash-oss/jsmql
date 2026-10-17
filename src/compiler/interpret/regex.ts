// The regular-expression operators: `$regexMatch`, `$regexFind` and `$regexFindAll`.
//
// The server runs PCRE2, and the interpreter runs JavaScript's engine. The two agree on a
// small syntax only. So the rule reads the pattern into a tree, and refuses every pattern
// that has a construct outside that syntax. The tree then prints as JavaScript, so no
// character of the source reaches the JavaScript engine as syntax that the rule did not read.
//
// The syntax: a literal ASCII character, a backslash with an ASCII punctuation character,
// a class of ASCII ranges (negated or not), `\d`, `\w` and `\s` as the ASCII sets, the
// quantifiers `?`, `*`, `+` and `{n}`, `{n,}`, `{n,m}`, a group `(…)` or `(?:…)`, the
// alternation `|`, the anchors `^` and `$`, and the lookahead `(?=…)` and `(?!…)`.
//
// The differences that the rule removes, each one measured on the server:
//   - `$` in PCRE2 also matches before a final newline, so it prints as `(?=\n?$)`.
//   - `\s` in PCRE2 is the six ASCII spaces, and `\d` and `\w` are ASCII. In JavaScript `\s` is wider.
//   - PCRE2 keeps a capture of an earlier pass through a repeated group, and JavaScript clears
//     it. A capture inside a group that repeats, or inside a lookahead, is a refusal.
//   - `$regexFindAll` never reports an empty match at the end of the string, unless the search
//     that began before the end found it there. See `findAll`.
//   - Case folding: with the `i` option, the characters U+017F and U+212A fold to an ASCII
//     letter. The rule refuses a string that holds either one.
// A pattern with a deep or a long form, and a string that is too long for the form of its
// pattern, are refusals too, because a backtracking engine has no bound on its time.
// See src/compiler/interpret/CLAUDE.md.

import type { Answer, Rule } from "./values.ts";
import { NO, ok } from "./values.ts";
import { keyed } from "./operand.ts";

type Node =
  | { t: "char"; cp: number }
  | { t: "class"; negated: boolean; ranges: readonly (readonly [number, number])[] }
  | { t: "seq"; parts: readonly Node[] }
  | { t: "alt"; branches: readonly Node[] }
  | { t: "group"; capture: boolean; body: Node }
  | { t: "look"; negative: boolean; body: Node }
  | { t: "start" }
  | { t: "end" }
  | { t: "quant"; min: number; max: number; body: Node };

/** The parser stops with this when the pattern leaves the syntax. */
class Outside extends Error {}
const outside = (): never => {
  throw new Outside();
};

const MAX_PATTERN = 200;
const MAX_DEPTH = 12;
const MAX_COUNT = 100;
const MAX_SUBJECT = 20_000;
/** The cost of the whole run, as the length of the string to the power of the degree plus one. */
const MAX_COST = 5e7;

const isDigit = (c: string): boolean => c >= "0" && c <= "9";
const isAlnum = (c: string): boolean => isDigit(c) || (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
const isPrintable = (c: string): boolean => c >= " " && c <= "~";

/** The characters that stand for themselves in a pattern. Every other printable one is syntax or is refused. */
const SPECIAL = new Set("\\^$.|?*+()[]{}");
const isLiteral = (c: string): boolean => isPrintable(c) && !SPECIAL.has(c);

const DIGITS: readonly (readonly [number, number])[] = [[48, 57]];
const WORD: readonly (readonly [number, number])[] = [
  [48, 57],
  [65, 90],
  [95, 95],
  [97, 122],
];
const SPACE: readonly (readonly [number, number])[] = [
  [9, 13],
  [32, 32],
];
/** The class that each of `\d`, `\w` and `\s` stands for. */
const SHORTHAND: Readonly<Record<string, readonly (readonly [number, number])[]>> = { d: DIGITS, w: WORD, s: SPACE };

class Reader {
  readonly src: string;
  pos = 0;
  groups = 0;
  constructor(src: string) {
    this.src = src;
  }
  peek(): string {
    return this.src[this.pos] ?? "";
  }
  next(): string {
    return this.src[this.pos++] ?? outside();
  }
  eat(c: string): boolean {
    if (this.peek() !== c) return false;
    this.pos++;
    return true;
  }
}

/** What a quantified group may hold, and the length of the shortest string that it matches. */
function inspect(node: Node): { capture: boolean; quant: boolean; alt: boolean; min: number } {
  switch (node.t) {
    case "char":
    case "class":
      return { capture: false, quant: false, alt: false, min: 1 };
    case "start":
    case "end":
    case "look":
      return { capture: false, quant: false, alt: false, min: 0 };
    case "group": {
      const i = inspect(node.body);
      return { ...i, capture: i.capture || node.capture };
    }
    case "quant": {
      const i = inspect(node.body);
      return { ...i, quant: true, min: i.min * node.min };
    }
    case "seq": {
      const all = node.parts.map(inspect);
      return {
        capture: all.some((i) => i.capture),
        quant: all.some((i) => i.quant),
        alt: all.some((i) => i.alt),
        min: all.reduce((n, i) => n + i.min, 0),
      };
    }
    case "alt": {
      const all = node.branches.map(inspect);
      return {
        capture: all.some((i) => i.capture),
        quant: all.some((i) => i.quant),
        alt: true,
        min: Math.min(...all.map((i) => i.min)),
      };
    }
  }
}

function parseClass(r: Reader): Node {
  const negated = r.eat("^");
  const ranges: (readonly [number, number])[] = [];
  const atStart = (): boolean => ranges.length === 0;
  for (;;) {
    const c = r.next();
    if (c === "]") {
      if (ranges.length === 0) outside();
      return { t: "class", negated, ranges };
    }
    // A shorthand class stands alone: a range cannot start or end on it.
    if (c === "\\") {
      const e = r.next();
      if (e in SHORTHAND) {
        ranges.push(...SHORTHAND[e]);
        if (r.peek() === "-" && r.src[r.pos + 1] !== "]") outside();
        continue;
      }
      if (isAlnum(e) || !isPrintable(e)) outside();
      ranges.push(...rangeFrom(r, e.charCodeAt(0)));
      continue;
    }
    if (c === "-") {
      // A hyphen is a literal only at the start or the end of the class.
      if (!atStart() && r.peek() !== "]") outside();
      ranges.push([45, 45]);
      continue;
    }
    if (!isLiteral(c) && c !== "^") outside();
    ranges.push(...rangeFrom(r, c.charCodeAt(0)));
  }
}

/** One class member that starts at `low`: a single character, or a range if a hyphen and an end follow. */
function rangeFrom(r: Reader, low: number): [number, number][] {
  if (r.peek() !== "-" || r.src[r.pos + 1] === "]" || r.src[r.pos + 1] === undefined) return [[low, low]];
  r.pos++;
  const end = r.next();
  let high: number;
  if (end === "\\") {
    const e = r.next();
    if (isAlnum(e) || !isPrintable(e)) return outside();
    high = e.charCodeAt(0);
  } else {
    if (!isLiteral(end) && end !== "^") return outside();
    high = end.charCodeAt(0);
  }
  if (high < low) outside();
  return [[low, high]];
}

function parseQuantifier(r: Reader): { min: number; max: number } | null {
  const c = r.peek();
  let q: { min: number; max: number };
  if (c === "?") q = { min: 0, max: 1 };
  else if (c === "*") q = { min: 0, max: Infinity };
  else if (c === "+") q = { min: 1, max: Infinity };
  else if (c === "{") {
    const m = /^\{(\d{1,3})(?:(,)(\d{0,3}))?\}/.exec(r.src.slice(r.pos));
    if (m === null) return outside();
    const min = Number(m[1]);
    const max = m[2] === undefined ? min : m[3] === "" ? Infinity : Number(m[3]);
    if (min > max || min > MAX_COUNT || (max !== Infinity && max > MAX_COUNT)) outside();
    q = { min, max };
    r.pos += m[0].length - 1;
  } else return null;
  r.pos++;
  // A lazy or possessive suffix, and a second quantifier, mean other things in PCRE2.
  if ("?+*{".includes(r.peek()) && r.peek() !== "") outside();
  return q;
}

function parseAlt(r: Reader, depth: number, inLook: boolean): Node {
  if (depth > MAX_DEPTH) outside();
  const branches = [parseSeq(r, depth, inLook)];
  while (r.eat("|")) branches.push(parseSeq(r, depth, inLook));
  return branches.length === 1 ? branches[0] : { t: "alt", branches };
}

function parseSeq(r: Reader, depth: number, inLook: boolean): Node {
  const parts: Node[] = [];
  while (r.peek() !== "" && r.peek() !== "|" && r.peek() !== ")") {
    const c = r.next();
    let atom: Node;
    let quantifiable = true;
    if (c === "(") {
      if (r.eat("?")) {
        const kind = r.next();
        if (kind === ":") atom = { t: "group", capture: false, body: parseAlt(r, depth + 1, inLook) };
        else if (kind === "=" || kind === "!") {
          atom = { t: "look", negative: kind === "!", body: parseAlt(r, depth + 1, true) };
          quantifiable = false;
        } else return outside();
      } else {
        if (inLook) outside();
        r.groups++;
        atom = { t: "group", capture: true, body: parseAlt(r, depth + 1, inLook) };
      }
      if (!r.eat(")")) outside();
    } else if (c === "[") {
      atom = parseClass(r);
    } else if (c === "\\") {
      const e = r.next();
      if (e in SHORTHAND) atom = { t: "class", negated: false, ranges: SHORTHAND[e] };
      else if (isAlnum(e) || !isPrintable(e)) return outside();
      else atom = { t: "char", cp: e.charCodeAt(0) };
    } else if (c === "^" || c === "$") {
      atom = { t: c === "^" ? "start" : "end" };
      quantifiable = false;
    } else if (isLiteral(c)) {
      atom = { t: "char", cp: c.charCodeAt(0) };
    } else return outside();

    const q = parseQuantifier(r);
    if (q === null) {
      parts.push(atom);
      continue;
    }
    if (!quantifiable) outside();
    if (atom.t === "group" && q.max > 1) {
      // A group that repeats may not hold what makes PCRE2 and JavaScript part: a capture, a
      // second quantifier or an alternation (a runaway backtrack), or a body that can match the empty string.
      const i = inspect(atom);
      if (i.capture || i.quant || i.alt || i.min === 0) outside();
    }
    parts.push({ t: "quant", min: q.min, max: q.max, body: atom });
  }
  return parts.length === 1 ? parts[0] : { t: "seq", parts };
}

/** How many unbounded repeats in a row the pattern can nest or chain, which sets the cost of a run. */
function degree(node: Node): number {
  switch (node.t) {
    case "quant":
      return (node.max === Infinity ? 1 : 0) + degree(node.body);
    case "seq":
      return node.parts.reduce((n, p) => n + degree(p), 0);
    case "alt":
      return Math.max(...node.branches.map(degree));
    case "group":
    case "look":
      return degree(node.body);
    default:
      return 0;
  }
}

// ── print as JavaScript ───────────────────────────────────────────────────────

/** A character as a JavaScript pattern reads it: a letter, a digit or a space as itself, and every other one as a hex escape. */
const lit = (cp: number): string => {
  const c = String.fromCharCode(cp);
  return isAlnum(c) || c === " " ? c : `\\x${cp.toString(16).padStart(2, "0")}`;
};

function print(node: Node): string {
  switch (node.t) {
    case "char":
      return lit(node.cp);
    case "class": {
      const body = node.ranges.map(([a, b]) => (a === b ? lit(a) : `${lit(a)}-${lit(b)}`)).join("");
      return `[${node.negated ? "^" : ""}${body}]`;
    }
    case "seq":
      return node.parts.map(print).join("");
    case "alt":
      return node.branches.map(print).join("|");
    case "group":
      return `(${node.capture ? "" : "?:"}${print(node.body)})`;
    case "look":
      return `(?${node.negative ? "!" : "="}${print(node.body)})`;
    case "start":
      return "^";
    // PCRE2 also matches `$` before a newline that ends the string.
    case "end":
      return "(?=\\n?$)";
    case "quant": {
      const count =
        node.min === 0 && node.max === 1
          ? "?"
          : node.min === 0 && node.max === Infinity
            ? "*"
            : node.min === 1 && node.max === Infinity
              ? "+"
              : `{${node.min}${node.max === node.min ? "" : `,${node.max === Infinity ? "" : node.max}`}}`;
      return print(node.body) + count;
    }
  }
}

type Compiled = { re: RegExp; groups: number; longest: number };

/** The pattern as a JavaScript engine, or null when the pattern is outside the syntax that both engines share. */
function compile(pattern: string, caseless: boolean): Compiled | null {
  if (pattern.length > MAX_PATTERN) return null;
  const reader = new Reader(pattern);
  let tree: Node;
  try {
    tree = parseAlt(reader, 0, false);
    // A `)` with no `(` ends the sequence early.
    if (reader.pos !== pattern.length) return null;
  } catch (e) {
    if (e instanceof Outside) return null;
    throw e;
  }
  const longest = Math.min(MAX_SUBJECT, Math.floor(MAX_COST ** (1 / (degree(tree) + 1))));
  return { re: new RegExp(print(tree), caseless ? "giu" : "gu"), groups: reader.groups, longest };
}

// ── the operators ─────────────────────────────────────────────────────────────

type Match = { match: string; idx: number; captures: (string | null)[] };

/** The number of code points before a UTF-16 offset: the server counts in code points. */
const codePointsBefore = (s: string, at: number): number => {
  let n = 0;
  for (let i = 0; i < at; i += s.codePointAt(i)! > 0xffff ? 2 : 1) n++;
  return n;
};

const read = (s: string, m: RegExpExecArray): Match => ({
  match: m[0],
  idx: codePointsBefore(s, m.index),
  captures: m.slice(1).map((c) => c ?? null),
});

/**
 * Does the offset fall between the two halves of a surrogate pair? A JavaScript engine can report
 * an empty match there, for a pattern such as `(?![^a])`, and the server never does.
 */
const insidePair = (s: string, at: number): boolean => {
  const unit = s.charCodeAt(at);
  const before = s.charCodeAt(at - 1);
  return at > 0 && unit >= 0xdc00 && unit <= 0xdfff && before >= 0xd800 && before <= 0xdbff;
};

/**
 * Every match. A search starts at the end of the last non-empty match, or one code point past an
 * empty match. The search that begins at the end of the string does not run, so an empty match
 * there is lost, unless the search before it found the match there. This is the measured server rule.
 */
function findAll(re: RegExp, s: string): Match[] | undefined {
  const found: Match[] = [];
  let start = 0;
  do {
    re.lastIndex = start;
    const m = re.exec(s);
    if (m === null) break;
    if (insidePair(s, m.index)) return undefined;
    found.push(read(s, m));
    start = m.index + (m[0] === "" ? (s.codePointAt(m.index)! > 0xffff ? 2 : 1) : m[0].length);
  } while (start < s.length);
  return found;
}

/** The text that the case folding of the server and of JavaScript treat in different ways. */
const FOLDS_TO_ASCII = /[ſK]/;

/**
 * The three operators share their operand: `input`, `regex` and `options`. A null `input` gives
 * the empty answer of the operator, and the pattern is read first, so a pattern outside the syntax always refuses.
 * An answer of `undefined` is a refusal.
 */
function regexRule(answer: (re: RegExp, subject: string | null) => unknown): Rule {
  return keyed(["input", "regex"], ["options"], (parts, walk): Answer => {
    const input = walk.at(parts.input);
    const regex = walk.at(parts.regex);
    if (!input.ok) return input;
    if (!regex.ok) return regex;
    let caseless = false;
    if ("options" in parts) {
      const options = walk.at(parts.options);
      if (!options.ok) return options;
      if (options.value !== "" && options.value !== "i") return NO;
      caseless = options.value === "i";
    }
    if (typeof regex.value !== "string") return NO;
    const compiled = compile(regex.value, caseless);
    if (compiled === null) return NO;
    const subject = input.value;
    if (subject === null) return ok(answer(compiled.re, null));
    if (typeof subject !== "string" || subject.length > compiled.longest || subject.includes("\u0000")) return NO;
    if (caseless && FOLDS_TO_ASCII.test(subject)) return NO;
    const value = answer(compiled.re, subject);
    return value === undefined ? NO : ok(value);
  });
}

export const REGEX: Record<string, Rule> = {
  $regexMatch: regexRule((re, s) => {
    if (s === null) return false;
    re.lastIndex = 0;
    const m = re.exec(s);
    if (m === null) return false;
    return insidePair(s, m.index) ? undefined : true;
  }),
  $regexFind: regexRule((re, s) => {
    if (s === null) return null;
    re.lastIndex = 0;
    const m = re.exec(s);
    if (m === null) return null;
    return insidePair(s, m.index) ? undefined : read(s, m);
  }),
  $regexFindAll: regexRule((re, s) => (s === null ? [] : findAll(re, s))),
};
