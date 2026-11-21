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

class Outside extends Error {}
const outside = (): never => {
  throw new Outside();
};

const MAX_PATTERN = 200;
const MAX_DEPTH = 12;
const MAX_COUNT = 100;
const MAX_SUBJECT = 20_000;
const MAX_COST = 5e7;

const isDigit = (c: string): boolean => c >= "0" && c <= "9";
const isAlnum = (c: string): boolean => isDigit(c) || (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
const isPrintable = (c: string): boolean => c >= " " && c <= "~";

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
      if (!atStart() && r.peek() !== "]") outside();
      ranges.push([45, 45]);
      continue;
    }
    if (!isLiteral(c) && c !== "^") outside();
    ranges.push(...rangeFrom(r, c.charCodeAt(0)));
  }
}

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
      const i = inspect(atom);
      if (i.capture || i.quant || i.alt || i.min === 0) outside();
    }
    parts.push({ t: "quant", min: q.min, max: q.max, body: atom });
  }
  return parts.length === 1 ? parts[0] : { t: "seq", parts };
}

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

function compile(pattern: string, caseless: boolean): Compiled | null {
  if (pattern.length > MAX_PATTERN) return null;
  const reader = new Reader(pattern);
  let tree: Node;
  try {
    tree = parseAlt(reader, 0, false);
    if (reader.pos !== pattern.length) return null;
  } catch (e) {
    if (e instanceof Outside) return null;
    throw e;
  }
  const longest = Math.min(MAX_SUBJECT, Math.floor(MAX_COST ** (1 / (degree(tree) + 1))));
  return { re: new RegExp(print(tree), caseless ? "giu" : "gu"), groups: reader.groups, longest };
}

type Match = { match: string; idx: number; captures: (string | null)[] };

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

const insidePair = (s: string, at: number): boolean => {
  const unit = s.charCodeAt(at);
  const before = s.charCodeAt(at - 1);
  return at > 0 && unit >= 0xdc00 && unit <= 0xdfff && before >= 0xd800 && before <= 0xdbff;
};

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

const FOLDS_TO_ASCII = /[ſK]/;

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
