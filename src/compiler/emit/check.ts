// Phase 5 — EMIT. These are the literal-gated checks on the arguments of JSMQL code: a
// JavaScript method, a global and a production. A `$op(…)` or `$stage(…)` call is the
// developer's own MQL, so it meets none of them (HR3), apart from `checkBodyKeys`.
//
// Each check here inspects only what is fully static — a literal string in an
// enum slot, or the keys of an object literal. Each check answers nothing when
// a slot holds a field path, a computed key, a spread or an expression. So the
// check refuses only a 100% certain violation, and a probable violation still
// emits: the server decides what it can decide, and jsmql refuses only what the
// server always refuses. Each rule read here is a `BodyRule` field or an
// `Arity` field the row states.

import type { Arity, ArgType, BodyRule, Expr, Kind } from "../../registry/vocabulary.ts";
import { kindFits } from "./select.ts";
import type { Known } from "./prove.ts";
import { CodegenError } from "../../errors.ts";
import { didYouMean } from "../../levenshtein.ts";
import { staticKey } from "../passes/naming.ts";
import { computedKeyInOperatorBody, spreadInOperatorBody } from "./errors.ts";
import { evaluate } from "../passes/evaluate.ts";
import { isFieldPathString } from "../../registry/ast.ts";

type Lit = { kind: "number" | "string" | "bool" | "null" | "array" | "object" | "regex" | "bigint"; value: Expr };

/** The literal a slot holds, or null for anything the gate must not judge. */
function literal(e: Expr): Lit | null {
  switch (e.type) {
    case "NumberLiteral":
      return { kind: "number", value: e };
    case "UnaryExpr":
      return e.op === "-" && e.argument.type === "NumberLiteral" ? { kind: "number", value: e } : null;
    case "StringLiteral":
      // A `"$x"` in raw MQL IS the field reference `$x` — a runtime value, not a literal.
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
      // checkType handles this case before the literal gate runs — see `checkType`.
      return false;
    case "date":
    case "timestamp":
      return false;
    case "any":
      return true;
    case "regex":
      return lit.kind === "regex";
  }
}

/** The kind a slot takes, as a noun with its article. */
const TAKES: Record<ArgType, string> = {
  number: "a number",
  int: "an integer",
  "int-or-long": "an integer",
  "number-or-date": "a number or a date",
  string: "a string",
  fieldName: "a field NAME to write: a plain string with no '$' and no dot",
  fieldPath: "a field PATH to read: a string that starts with '$'",
  bool: "a boolean",
  array: "an array",
  object: "a document",
  date: "a date",
  timestamp: "a timestamp",
  any: "a value",
  regex: "a regular expression",
};

/**
 * Each positional slot that states a kind, in order: the `slotType` slots, and `rest`
 * for every other operand of a flattened chain.
 */
function slotKinds(args: Arity, count: number): readonly (readonly [number, ArgType | readonly ArgType[]])[] {
  const stated = args.slotType ?? {};
  const out: (readonly [number, ArgType | readonly ArgType[]])[] = Object.entries(stated).map(
    ([i, t]) => [Number(i), t] as const,
  );
  const rest = args.rest;
  if (rest !== undefined) for (let i = 0; i < count; i++) if (!(i in stated)) out.push([i, rest]);
  return out.sort((a, b) => a[0] - b[0]);
}

/** The kinds a slot takes, as one list: "a number", "a number or a date", "a number, a string or a date". */
const takesOf = (t: ArgType | readonly ArgType[]): string => {
  const nouns = Array.isArray(t) ? (t as readonly ArgType[]).map((x) => TAKES[x]) : [TAKES[t as ArgType]];
  return nouns.length === 1 ? nouns[0] : `${nouns.slice(0, -1).join(", ")} or ${nouns[nouns.length - 1]}`;
};

/** The hint for a fraction where the server takes a whole number. */
const ROUND = " Write an integer, or round the value with '.ceil()' or '.floor()'.";

/**
 * The one refusal of a value of the wrong kind. The literal checks and the proof check
 * all build it, so each one reads the same. `slot` names the slot: a key, `argument N`,
 * `element N` or `receiver`.
 */
const wrongKind = (name: string, slot: string, takes: string, got: string, hint = ""): string =>
  `'${spell(name)}' ${slot} takes ${takes}, but got ${got}.${hint}`;

/** What the proof shows of a value: one kind, `"null"`, or "unknown". */
type KindOf = (e: Expr) => Known;

/** Is the value `null`: written, injected (a `NullLiteral` after the inject pass), or proven? */
const isNull = (e: Expr, kindOf: KindOf): boolean => e.type === "NullLiteral" || kindOf(e) === "null";

/** Does the row state that `null` is data in slot `i`? */
const takesNullAt = (args: Arity, i: number): boolean =>
  args.takesNull === "every" || (args.takesNull ?? []).includes(i);

/** How a message names a positional slot. */
const argument = (i: number | string): string => `argument ${Number(i) + 1}`;

const hint = (expected: ArgType): string => {
  if (expected === "date" || expected === "number-or-date") return " Use a field path or new Date(…).";
  if (expected === "timestamp") return " Use a field path (a timestamp has no literal form).";
  return "";
};

/** The kind of a PROVEN value, as a noun with its article. */
const KIND_NOUN: Readonly<Partial<Record<Kind | "null", string>>> = {
  null: "null",
  string: "a string",
  number: "a number",
  bool: "a boolean",
  array: "an array",
  object: "a document",
  date: "a date",
  objectId: "an ObjectId",
  binData: "binary data",
};

/** A literal of a type the slot can never take. `slot` names the key or the argument. */
export function checkType(name: string, slot: string, e: Expr, expected: ArgType): void {
  // `null` is not the kind any slot states (HR7). The fix depends on what the developer
  // meant, so the message names no alternative.
  if (e.type === "NullLiteral") throw new CodegenError(wrongKind(name, slot, TAKES[expected], "null"), e.pos);
  // A field NAME is the one slot where a string that starts with `$` is the ERROR,
  // not a runtime value. The check reads it from the source, not through the
  // literal gate. The server refuses `{ $count: "$n" }`, and it also refuses a
  // dotted or empty name.
  if (expected === "fieldPath") {
    if (e.type !== "StringLiteral") return;
    if (!e.value.startsWith("$") || e.value.startsWith("$$") || e.value === "$") {
      throw new CodegenError(
        `'${spell(name)}' ${slot} reads a field PATH. The path must start with '$'. Write '$${e.value.replace(/^\$+/, "")}'.`,
        e.pos,
      );
    }
    return;
  }
  if (expected === "fieldName") {
    if (e.type !== "StringLiteral") {
      const other = literal(e);
      if (other === null) return;
      throw new CodegenError(
        `'${spell(name)}' ${slot} names a field to WRITE. ${NOUN[other.kind]} is not a name. Use a plain field name, for example 'total'.`,
        e.pos,
      );
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
      `'${spell(name)}' ${slot} names a field to WRITE. '${e.value}' ${bad}. The server refuses it. Use a plain field name, for example 'total'.`,
      e.pos,
    );
  }
  const lit = literal(e);
  if (lit === null || matches(lit, expected)) return;
  // A number in an integer slot is a fraction: the kind fits, and the value does not.
  const fraction = lit.kind === "number" && (expected === "int" || expected === "int-or-long");
  throw new CodegenError(
    wrongKind(name, slot, TAKES[expected], fraction ? "a fraction" : NOUN[lit.kind], fraction ? ROUND : hint(expected)),
    e.pos,
  );
}

/**
 * A literal string outside a closed set, with a suggestion.
 *
 * A string that starts with `$` is normally a runtime field reference, and a
 * validator has no business with it — unless the slot is CONSTANT-only. There
 * the server reads the string as itself: measured, the server refuses `{ $bucketAuto:
 * { granularity: "$g" } }` as a value outside the set, and does not read a field.
 */
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

/**
 * A body of named keys — an object-form operator's, a stage's — is MQL syntax. A
 * JavaScript spread or computed key there lowers to `$mergeObjects` or
 * `$arrayToObject`, which the operator or the stage does not take as its body. That
 * MQL is the compiler's own, so HR3 refuses it, inside the escape hatch too.
 */
export function checkBodyKeys(body: Expr): void {
  if (body.type !== "ObjectLiteral") return;
  for (const e of body.entries) {
    if (e.type === "SpreadElement") throw spreadInOperatorBody(e.pos);
    if (e.key.kind === "computed") throw computedKeyInOperatorBody(e.pos);
  }
}

/**
 * The options document of a JavaScript method (`args.body`), for example the parts of
 * `.set({ year, month })`: the keys it must have, the keys it may not have (with a
 * suggestion), and each key's enum and type. `args` are the call's arguments; `keys`
 * the row's positional order. A `$op(…)` or `$stage(…)` body is the developer's own
 * MQL, and no rule judges it (HR3).
 */
export function checkBody(
  name: string,
  rule: BodyRule,
  args: readonly Expr[],
  keys: readonly string[],
  pos: number,
  kindOf: KindOf,
  readFirst?: (e: Expr) => unknown,
): void {
  // A body the call supplied whole (`.set(${parts})`) is a value, and its keys are the server's to judge.
  if (args.length === 1 && args[0].type === "Injected") return;
  let present: readonly string[];
  let valueOf: (k: string) => Expr | undefined;
  const body = args.length === 1 && args[0].type === "ObjectLiteral" ? args[0] : null;
  if (body !== null) {
    // The keys of the body are its wire format: neither a spread nor a computed key
    // can produce one, and the server refuses the document either way.
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
    // A `$`-led string in a CONSTANT key is read by the server as itself, so the
    // closed set applies to it there.
    if (v !== undefined) checkEnum(name, k, v, allowed, caseInsensitive.has(k), (rule.constantKeys ?? []).includes(k));
  }
  for (const [k, t] of Object.entries(rule.keyTypes ?? {})) {
    const v = valueOf(k);
    if (v !== undefined) checkType(name, k, v, t);
  }
  // `null` is no option value. A key with a stated kind names that kind.
  for (const k of present) {
    const v = valueOf(k);
    if (v === undefined || !isNull(v, kindOf)) continue;
    if (v.type !== "NullLiteral") readFirst?.(v);
    const t = rule.keyTypes?.[k];
    throw new CodegenError(wrongKind(name, k, t === undefined ? "a value" : TAKES[t], "null"), v.pos);
  }
  // A key the server reads at compile time must hold a constant. The server refuses a
  // field path or an expression there.
  for (const k of rule.constantKeys ?? []) {
    const v = valueOf(k);
    // A run-time value is a constant too: the call supplies it before the compile.
    if (v !== undefined && v.type !== "Injected" && !evaluate(v, new Map()).ok) {
      throw new CodegenError(
        `'${name}' ${k} must be a compile-time constant. The server reads it before any document. It got an expression.`,
        v.pos,
      );
    }
  }
}

/**
 * How the source spells a name. A method gets its dot and parentheses. A stage, an
 * operator, an operator token (`+`) and a name the caller spelled (`Number()`) stay
 * as written.
 */
const spell = (name: string): string => (/^[A-Za-z_]\w*$/.test(name) ? `.${name}()` : name);

/**
 * The per-slot checks an `Arity` states, over positional operands. The literal checks
 * read the source. The kind check reads the proof (`kinds`, one per operand), so it
 * also covers a value that an earlier statement computes.
 */
export function checkSlots(
  name: string,
  args: Arity,
  operands: readonly Expr[],
  /** What an operand PROVABLY is. */
  kindOf: KindOf,
  /**
   * Does the row state an OBJECT form for this body? When it does, an object
   * literal is exempt from `slotType` — the date accessors take a date OR the
   * `{ date, timezone }` document, and the rule stated for the first must not
   * refuse the second. The row's own `body` rule judges the second instead. When
   * the row states no object form, an object literal is simply the wrong type:
   * the server refuses `$documents({ a: 1 })`.
   */
  hasObjectForm = true,
  /** The receiver of a method call, for a rule that states slot `-1`. */
  receiver?: Expr,
  /**
   * Lowers an operand before its refusal as a proven null. A read of a field that no
   * stage wrote has a refusal of its own, and that refusal names the cause.
   */
  readFirst?: (e: Expr) => unknown,
): void {
  for (const i of args.integer ?? []) {
    const e = i === -1 ? receiver : operands[i];
    const n = e === undefined ? null : numberOf(e);
    if (n !== null && !Number.isInteger(n)) {
      const what = i === -1 ? "receiver" : argument(i);
      throw new CodegenError(wrongKind(name, what, "an integer", "a fraction", ROUND), e!.pos);
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
    if (e !== undefined && e.type === "ObjectLiteral") checkBody(name, rule, [e], [], e.pos, kindOf, readFirst);
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
  for (const [i, t] of slotKinds(args, operands.length)) {
    const e = operands[i];
    if (e === undefined || (hasObjectForm && e.type === "ObjectLiteral")) continue;
    if (!Array.isArray(t)) {
      checkType(name, argument(i), e, t as ArgType);
      continue;
    }
    // A slot that takes more than one shape: the literal must match one of them,
    // and the message names them all.
    const types = t as readonly ArgType[];
    // A type with a message of its own answers for itself, so the reason names the
    // one shape the value nearly was: `$unwind("items")` is a path missing its '$'.
    if (e.type === "StringLiteral" && types.includes("fieldPath")) {
      checkType(name, argument(i), e, "fieldPath");
      continue;
    }
    const lit = literal(e);
    if (lit === null || types.some((one) => matches(lit, one))) continue;
    throw new CodegenError(wrongKind(name, argument(i), takesOf(types), NOUN[lit.kind]), e.pos);
  }
  for (const [i, t] of Object.entries(args.arrayOf ?? {})) {
    const e = operands[Number(i)];
    if (e === undefined || e.type !== "ArrayLiteral") continue;
    for (const el of e.elements) {
      if (el.type === "SpreadElement") continue;
      const slot = `element ${e.elements.indexOf(el) + 1}`;
      checkType(name, slot, el as Expr, t as ArgType);
      if (kindOf(el as Expr) !== "null") continue;
      readFirst?.(el as Expr);
      throw new CodegenError(wrongKind(name, slot, TAKES[t as ArgType], "null"), el.pos);
    }
  }
  for (const [i, [lo, hi]] of Object.entries(args.slotRange ?? {})) {
    const e = operands[Number(i)];
    const n = e === undefined ? null : numberOf(e);
    if (n !== null && (n < lo || n > hi)) {
      // A range whose top is the largest safe integer is a FLOOR, and reads as one.
      const bound = hi === Number.MAX_SAFE_INTEGER ? `of ${lo} or more` : `from ${lo} to ${hi}`;
      throw new CodegenError(`'${name}' argument ${Number(i) + 1} must be a number ${bound}. It got ${n}.`, e!.pos);
    }
  }
  for (const i of args.nonZero ?? []) {
    const e = operands[i];
    if (e !== undefined && numberOf(e) === 0) {
      throw new CodegenError(
        `'${name}' cannot divide by zero. The server refuses a zero divisor. JavaScript's NaN has no MongoDB value.`,
        e.pos,
      );
    }
  }
  for (const i of args.constant ?? []) {
    const e = operands[i];
    // An object literal is exempt, as it is for `slotType`: for a body that may be
    // a name OR a document, the row's `body` rule describes its keys, and several
    // of those keys hold expressions. `$unionWith("c")` must be constant;
    // `$unionWith({ coll: "c", pipeline: [$match(…)] })` must not be.
    // A run-time value is a constant too: the call supplies it before the compile.
    if (e !== undefined && e.type !== "ObjectLiteral" && e.type !== "Injected" && !evaluate(e, new Map()).ok) {
      throw new CodegenError(
        `'${name}' argument ${i + 1} must be a compile-time constant. The server reads it before any document. It got an expression.`,
        e.pos,
      );
    }
  }
  for (const [i, allowed] of Object.entries(args.slotEnums ?? {})) {
    const e = operands[Number(i)];
    if (e !== undefined) checkEnum(name, argument(i), e, allowed, false);
  }
  // A positional operand PROVEN to be a kind the slot can never take: `$.s.indexOf(n)`
  // with `n` a number the program wrote.
  for (const [i, t] of slotKinds(args, operands.length)) {
    const e = operands[i];
    if (e === undefined) continue;
    const k = kindOf(e);
    if (k === "unknown" || kindFits(k, t)) continue;
    if (k === "null") readFirst?.(e);
    throw new CodegenError(wrongKind(name, argument(i), takesOf(t), KIND_NOUN[k] ?? `a ${k}`), e.pos);
  }
  // Every other slot refuses `null` too, unless the row states that `null` is data there.
  operands.forEach((e, i) => {
    if (takesNullAt(args, i) || !isNull(e, kindOf)) return;
    if (e.type !== "NullLiteral") readFirst?.(e);
    throw new CodegenError(wrongKind(name, argument(i), "a value", "null"), e.pos);
  });
}

// ── date formats ─────────────────────────────────────────────────────────────

const DATE_FORMAT_SPECIFIERS = "dGHjLmMSuUVwYzZ%";
/** Moment/Luxon tokens a developer may reach for, and the MongoDB specifier each is — or null for one MongoDB cannot format. */
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

/** A MongoDB date format: every `%` carries a known specifier, and Moment tokens are named for what they are. */
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
