import type { Arity, ArgType, BodyRule, Expr } from "../../registry/vocabulary.ts";
import { CodegenError } from "../../errors.ts";
import { didYouMean } from "../../levenshtein.ts";
import { staticKey } from "../passes/naming.ts";
import { computedKeyInOperatorBody, spreadInOperatorBody } from "./errors.ts";
import { constantOf } from "../passes/evaluate.ts";
import { isFieldPathString } from "../../registry/ast.ts";

type Lit = { kind: "number" | "string" | "bool" | "null" | "array" | "object" | "regex" | "bigint"; value: Expr };

function literal(e: Expr): Lit | null {
  switch (e.type) {
    case "NumberLiteral":
      return { kind: "number", value: e };
    case "UnaryExpr":
      return e.op === "-" && e.argument.type === "NumberLiteral" ? { kind: "number", value: e } : null;
    case "StringLiteral":
      return isFieldPathString(e) ? null : { kind: "string", value: e };
    case "BooleanLiteral":
      return { kind: "bool", value: e };
    case "NullLiteral":
      return { kind: "null", value: e };
    case "ArrayLiteral":
      return { kind: "array", value: e };
    case "ObjectLiteral":
      return { kind: "object", value: e };
    case "RegexLiteral":
      return { kind: "regex", value: e };
    case "BigIntLiteral":
      return { kind: "bigint", value: e };
    default:
      return null;
  }
}

const numberOf = (e: Expr): number | null =>
  e.type === "NumberLiteral"
    ? e.value
    : e.type === "UnaryExpr" && e.op === "-" && e.argument.type === "NumberLiteral"
      ? -e.argument.value
      : null;

const NOUN: Record<Lit["kind"], string> = {
  number: "a number",
  string: "a string",
  bool: "a boolean",
  null: "null",
  array: "an array",
  object: "a document",
  regex: "a regular expression",
  bigint: "a bigint",
};

function matches(lit: Lit, expected: ArgType): boolean {
  switch (expected) {
    case "number":
    case "number-or-date":
      return lit.kind === "number" || lit.kind === "bigint";
    case "int":
    case "int-or-long": {
      if (lit.kind === "bigint") return true;
      const n = numberOf(lit.value);
      return n !== null && Number.isInteger(n);
    }
    case "string":
    case "bool":
    case "array":
    case "object":
      return lit.kind === expected;
    case "fieldName":
    case "fieldPath":
      return false;
    case "regex":
      return lit.kind === "regex" || lit.kind === "string";
    case "any":
    case "element":
      return true;
    case "value":
      return lit.kind !== "null";
    case "orderable":
      return lit.kind === "number" || lit.kind === "bigint" || lit.kind === "string";
    case "date":
    case "timestamp":
    case "objectId":
    case "binData":
    case "callback":
      return false;
  }
}

const TAKES: Record<ArgType, string> = {
  number: "a number",
  int: "an integer",
  "int-or-long": "an integer",
  "number-or-date": "a number or a date",
  orderable: "a number, a string, a date or an ObjectId",
  string: "a string",
  fieldName: "a field NAME to write: a plain string with no '$' and no dot",
  fieldPath: "a field PATH to read: a string that starts with '$'",
  bool: "a boolean",
  array: "an array",
  object: "a document",
  date: "a date",
  timestamp: "a timestamp",
  objectId: "an ObjectId",
  binData: "binary data",
  any: "a value",
  value: "a value",
  callback: "a callback",
  regex: "a regular expression or a string",
  element: "an element of the array",
};

export const takesOf = (t: ArgType | readonly ArgType[]): string => {
  if (!Array.isArray(t)) return TAKES[t as ArgType];
  const nouns = (t as readonly ArgType[]).map((x) => TAKES[x]);
  return nouns.length < 2 ? nouns[0] : `${nouns.slice(0, -1).join(", ")} or ${nouns[nouns.length - 1]}`;
};

const ROUND = " Write an integer, or round the value with '<number>.ceil()' or '<number>.floor()'.";

export type SlotProof = { readonly isNull: (e: Expr) => boolean; readonly read: (e: Expr) => unknown };

function refuseProvenNull(name: string, slot: string, e: Expr, takes: string, proof: SlotProof | undefined): void {
  if (proof === undefined || e.type === "NullLiteral" || !proof.isNull(e)) return;
  proof.read(e);
  throw new CodegenError(wrongKind(`'${spell(name)}'`, slot, takes, "got null"), e.pos);
}

export const wrongKind = (shown: string, slot: string, takes: string, found: string, hint = ""): string =>
  `${shown}${slot ? ` ${slot}` : ""} takes ${takes}, but ${found}.${hint}`;

export const hint = (expected: ArgType | readonly ArgType[], got: readonly string[] = []): string => {
  if (Array.isArray(expected)) {
    return (expected as readonly ArgType[]).includes("number") ? hint("number", got) : "";
  }
  if (expected === "number" && got.includes("date")) {
    return " To add time to a date or subtract time from it, use '.plus(n, unit)' or '.minus(n, unit)'. For the time between two dates, use '.diff(other, unit)'.";
  }
  if (expected === "date" || expected === "number-or-date") return " Use a field path or Date(…).";
  if (expected === "timestamp") return " Use a field path (a timestamp has no literal form).";
  return "";
};

export function checkType(name: string, slot: string, e: Expr, expected: ArgType): void {
  if (expected === "fieldPath") {
    if (e.type !== "StringLiteral") return;
    if (!e.value.startsWith("$") || e.value.startsWith("$$") || e.value === "$") {
      throw new CodegenError(
        `'${spell(name)}'${slot ? ` ${slot}` : ""} reads a field PATH. The path must start with '$'. Write '$${e.value.replace(/^\$+/, "")}'.`,
        e.pos,
      );
    }
    return;
  }
  if (expected === "fieldName") {
    if (e.type !== "StringLiteral") {
      const other = literal(e);
      if (other === null) return;
      throw new CodegenError(wrongKind(`'${spell(name)}'`, slot, TAKES.fieldName, `got ${NOUN[other.kind]}`), e.pos);
    }
    const bad =
      e.value === ""
        ? "is empty"
        : e.value.startsWith("$")
          ? "starts with '$'"
          : e.value.includes(".")
            ? "holds a dot"
            : null;
    if (bad === null) return;
    throw new CodegenError(
      `'${spell(name)}'${slot ? ` ${slot}` : ""} names a field to WRITE. '${e.value}' ${bad}. The server refuses it. Use a plain field name, for example 'total'.`,
      e.pos,
    );
  }
  const lit = literal(e);
  if (lit === null || matches(lit, expected)) return;
  const fraction = lit.kind === "number" && (expected === "int" || expected === "int-or-long");
  throw new CodegenError(
    wrongKind(
      `'${spell(name)}'`,
      slot,
      TAKES[expected],
      `got ${fraction ? "a fraction" : NOUN[lit.kind]}`,
      fraction ? ROUND : hint(expected),
    ),
    e.pos,
  );
}

function checkEnum(
  name: string,
  key: string,
  e: Expr,
  allowed: readonly string[],
  caseInsensitive: boolean,
  isConstantSlot = false,
): void {
  if (e.type !== "StringLiteral" || (isFieldPathString(e) && !isConstantSlot)) return;
  const v = caseInsensitive ? e.value.toLowerCase() : e.value;
  if (allowed.includes(v)) return;
  const near = didYouMean(v, allowed, (s) => s);
  throw new CodegenError(`'${name}' ${key} must be one of: ${allowed.join(", ")}. It got '${e.value}'.${near}`, e.pos);
}

export function checkBodyKeys(body: Expr): void {
  if (body.type !== "ObjectLiteral") return;
  for (const e of body.entries) {
    if (e.type === "SpreadElement") throw spreadInOperatorBody(e.pos);
    if (e.key.kind === "computed") throw computedKeyInOperatorBody(e.pos);
  }
}

export function checkBody(
  name: string,
  rule: BodyRule,
  args: readonly Expr[],
  keys: readonly string[],
  pos: number,
  proof?: SlotProof,
): void {
  if (args.length === 1 && args[0].type === "Injected") return;
  let present: readonly string[];
  let valueOf: (k: string) => Expr | undefined;
  const body = args.length === 1 && args[0].type === "ObjectLiteral" ? args[0] : null;
  if (body !== null) {
    checkBodyKeys(body);
    const byKey = new Map<string, Expr>();
    for (const e of body.entries) if (e.type === "KeyValueEntry") byKey.set(staticKey(e) ?? "", e.value);
    present = [...byKey.keys()];
    valueOf = (k) => byKey.get(k);
  } else {
    present = keys.slice(0, args.length);
    valueOf = (k) => {
      const i = keys.indexOf(k);
      return i >= 0 && i < args.length ? args[i] : undefined;
    };
  }
  const closed = [...rule.required, ...rule.optional];
  if (body !== null && rule.closed) {
    for (const k of present) {
      if (!closed.includes(k)) {
        throw new CodegenError(
          `'${name}' has no parameter '${k}'.${didYouMean(k, closed, (s) => s)} Valid keys: ${closed.join(", ")}.`,
          valueOf(k)?.pos ?? pos,
        );
      }
    }
  }
  for (const k of rule.required) {
    if (!present.includes(k)) throw new CodegenError(`'${name}' requires the '${k}' field, but it is missing.`, pos);
  }
  for (const [a, b] of rule.notTogether ?? []) {
    const inA = present.filter((k) => a.includes(k));
    const inB = present.filter((k) => b.includes(k));
    if (inA.length > 0 && inB.length > 0) {
      throw new CodegenError(
        `'${name}' takes '${inA[0]}' or '${inB[0]}', not both. These belong to two families that never mix: ${a.join("/")} against ${b.join("/")}.`,
        pos,
      );
    }
  }
  const caseInsensitive = new Set(rule.caseInsensitiveKeys ?? []);
  for (const [k, allowed] of Object.entries(rule.enums ?? {})) {
    const v = valueOf(k);
    if (v !== undefined) checkEnum(name, k, v, allowed, caseInsensitive.has(k), (rule.constantKeys ?? []).includes(k));
  }
  for (const [k, t] of Object.entries(rule.keyTypes ?? {})) {
    const v = valueOf(k);
    if (v !== undefined) checkType(name, k, v, t);
  }
  for (const k of present) {
    const v = valueOf(k);
    if (v === undefined) continue;
    const t = rule.keyTypes?.[k];
    const takes = t === undefined ? "a value" : TAKES[t];
    if (v.type === "NullLiteral") throw new CodegenError(wrongKind(`'${spell(name)}'`, k, takes, "got null"), v.pos);
    refuseProvenNull(name, k, v, takes, proof);
  }
  for (const k of rule.constantKeys ?? []) {
    const v = valueOf(k);
    if (v !== undefined && v.type !== "Injected" && !constantOf(v).ok) {
      throw new CodegenError(
        `'${name}' ${k} must be a compile-time constant. The server reads it before any document. It got an expression.`,
        v.pos,
      );
    }
  }
}

const spell = (name: string): string => (/^[A-Za-z_]\w*$/.test(name) ? `.${name}()` : name);

const SOURCE_CHECKED: ReadonlySet<ArgType> = new Set(["int", "int-or-long", "fieldName", "fieldPath"]);

export function checkSlots(
  name: string,
  args: Arity,
  operands: readonly Expr[],
  hasObjectForm = true,
  receiver?: Expr,
  settling = false,
  proof?: SlotProof,
): void {
  for (const i of args.integer ?? []) {
    const e = i === -1 ? receiver : operands[i];
    const n = e === undefined ? null : numberOf(e);
    if (n !== null && !Number.isInteger(n)) {
      const what = i === -1 ? "receiver" : `argument ${i + 1}`;
      throw new CodegenError(wrongKind(`'${spell(name)}'`, what, "an integer", "got a fraction", ROUND), e!.pos);
    }
  }
  for (const [i, instead] of Object.entries(args.zeroRefused ?? {})) {
    const e = operands[Number(i)];
    if (e !== undefined && numberOf(e) === 0) {
      throw new CodegenError(
        `'${spell(name)}' argument ${Number(i) + 1} cannot be 0. The server refuses it. ${instead}`,
        e.pos,
      );
    }
  }
  for (const i of args.oneChar ?? []) {
    const e = operands[i];
    const text =
      e?.type === "StringLiteral" ? e.value : e?.type === "Injected" && typeof e.value === "string" ? e.value : null;
    if (text !== null && (text.length !== 1 || text.charCodeAt(0) > 0x7f)) {
      throw new CodegenError(
        `'${spell(name)}' argument ${i + 1} takes one ASCII character, but got ${JSON.stringify(text)}.`,
        e!.pos,
      );
    }
  }
  for (const [i, flag] of Object.entries(args.regexFlag ?? {})) {
    const e = operands[Number(i)];
    if (e !== undefined && e.type === "RegexLiteral" && !e.flags.includes(flag)) {
      throw new CodegenError(
        `'${name}' needs the '${flag}' flag on its regex, as JavaScript does. JavaScript throws a TypeError without it. Write /…/${flag}.`,
        e.pos,
      );
    }
  }
  for (const [i, message] of Object.entries(args.noCallback ?? {})) {
    const e = operands[Number(i)];
    if (e !== undefined && e.type === "Lambda") throw new CodegenError(message, e.pos);
  }
  for (const i of args.dateFormat ?? []) {
    const e = operands[i];
    if (e !== undefined && e.type === "StringLiteral") checkDateFormat(name, e.value, e.pos);
  }
  for (const [i, rule] of Object.entries(args.body ?? {})) {
    const e = operands[Number(i)];
    if (e !== undefined && e.type === "ObjectLiteral") checkBody(name, rule, [e], [], e.pos, proof);
  }
  for (const [i, { noun, instead }] of Object.entries(args.nonEmpty ?? {})) {
    const e = operands[Number(i)];
    if (e === undefined) continue;
    if ((e.type === "StringLiteral" && e.value === "") || (e.type === "ArrayLiteral" && e.elements.length === 0)) {
      throw new CodegenError(
        `'${spell(name)}' needs at least one ${noun}. An empty ${e.type === "StringLiteral" ? "string" : "list"} has none. ${instead}`,
        e.pos,
      );
    }
  }
  operands.forEach((e, i) => {
    const t = args.slotType?.[i] ?? args.rest;
    if (t === undefined || (hasObjectForm && e.type === "ObjectLiteral")) return;
    const own = (Array.isArray(t) ? (t as readonly ArgType[]) : [t as ArgType]).find((one) => SOURCE_CHECKED.has(one));
    if (own === undefined) return;
    if (e.type === "StringLiteral" || !Array.isArray(t)) checkType(name, `argument ${i + 1}`, e, own);
  });
  for (const [i, t] of Object.entries(args.arrayOf ?? {})) {
    const e = operands[Number(i)];
    if (e === undefined || e.type !== "ArrayLiteral") continue;
    for (const el of e.elements) {
      if (el.type === "SpreadElement") continue;
      const slot = `element ${e.elements.indexOf(el) + 1}`;
      checkType(name, slot, el as Expr, t as ArgType);
      refuseProvenNull(name, slot, el as Expr, TAKES[t as ArgType], proof);
    }
  }
  for (const [i, [lo, hi]] of Object.entries(args.slotRange ?? {})) {
    const e = operands[Number(i)];
    const n = e === undefined ? null : numberOf(e);
    if (n !== null && (n < lo || n > hi)) {
      const bound = hi === Number.MAX_SAFE_INTEGER || hi === Infinity ? `of ${lo} or more` : `from ${lo} to ${hi}`;
      throw new CodegenError(
        `'${spell(name)}' argument ${Number(i) + 1} must be a number ${bound}. It got ${n}.`,
        e!.pos,
      );
    }
  }
  for (const i of args.nonZero ?? []) {
    const e = operands[i];
    if (!settling && e !== undefined && numberOf(e) === 0) {
      throw new CodegenError(
        `'${name}' cannot divide by zero. The server refuses a zero divisor. JavaScript's NaN has no MongoDB value.`,
        e.pos,
      );
    }
  }
  for (const i of args.constant ?? []) {
    const e = operands[i];
    if (e !== undefined && e.type !== "ObjectLiteral" && e.type !== "Injected" && !constantOf(e).ok) {
      throw new CodegenError(
        `'${spell(name)}' argument ${i + 1} must be a compile-time constant, but got an expression. Write a literal, or pass the value as a parameter.`,
        e.pos,
      );
    }
  }
  for (const [i, allowed] of Object.entries(args.slotEnums ?? {})) {
    const e = operands[Number(i)];
    if (e !== undefined) checkEnum(name, `argument ${Number(i) + 1}`, e, allowed, false);
  }
}

const DATE_FORMAT_SPECIFIERS = "dGHjLmMSuUVwYzZ%";
const MOMENT_FORMAT_TOKENS: readonly (readonly [string, string | null])[] = [
  ["YYYY", "%Y"],
  ["MMMM", null],
  ["dddd", null],
  ["MMM", null],
  ["ddd", null],
  ["DDD", "%j"],
  ["SSS", "%L"],
  ["YY", null],
  ["MM", "%m"],
  ["DD", "%d"],
  ["HH", "%H"],
  ["hh", null],
  ["ZZ", "%z"],
  ["mm", "%M"],
  ["ss", "%S"],
  ["Do", null],
];
const MOMENT_FORMAT_RE = /YYYY|YY|MMMM|MMM|MM|DDD|DD|dddd|ddd|HH|hh|mm|ss|SSS|ZZ|Do/;

function momentFormatHint(fmt: string): string {
  let out = "";
  let i = 0;
  outer: while (i < fmt.length) {
    for (const [token, spec] of MOMENT_FORMAT_TOKENS) {
      if (!fmt.startsWith(token, i)) continue;
      out += spec ?? token;
      i += token.length;
      continue outer;
    }
    out += fmt[i];
    i++;
  }
  const missing = out.replace(/%./g, "").match(/[A-Za-z]+/g);
  if (missing === null) return ` Did you mean '${out}'?`;
  return (
    ` MongoDB has no format specifier for ${[...new Set(missing)].map((t) => `'${t}'`).join(", ")}. It outputs no ` +
    `month name, weekday name, 12-hour clock or 2-digit year. Derive those from the numeric parts. For example: ["Jan", …][$.t.getMonth()].`
  );
}

export function checkDateFormat(name: string, fmt: string, pos: number): void {
  for (let i = 0; i < fmt.length; i++) {
    if (fmt[i] !== "%") continue;
    const spec = fmt[i + 1];
    if (spec === undefined || !DATE_FORMAT_SPECIFIERS.includes(spec)) {
      const flip =
        spec === undefined ? undefined : spec === spec.toUpperCase() ? spec.toLowerCase() : spec.toUpperCase();
      const hint = flip !== undefined && DATE_FORMAT_SPECIFIERS.includes(flip) ? ` Did you mean '%${flip}'?` : "";
      throw new CodegenError(
        `'${name}' format has an invalid specifier '%${spec ?? ""}'.${hint} MongoDB accepts %Y %G %m %d %j %U %V %u %w %H %M %S %L %z %Z and %%.`,
        pos,
      );
    }
    i++;
  }
  if (!fmt.includes("%") && MOMENT_FORMAT_RE.test(fmt)) {
    throw new CodegenError(
      `'${name}' takes MongoDB's date format specifiers, not Moment or Luxon tokens. '${fmt}' formats as that literal text, never a date.${momentFormatHint(fmt)}`,
      pos,
    );
  }
}
