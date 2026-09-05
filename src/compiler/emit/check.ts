// Phase 5 — EMIT. The literal-gated checks on a MongoDB operator's arguments.
//
// Every check here inspects only what is fully static — a literal string in an
// enum slot, an object literal's own keys — and answers nothing the moment a
// slot is a field path, a computed key, a spread or an expression. So only a
// 100%-certain violation is refused, and a probable one still emits: the server
// decides what it can, and jsmql refuses only what the server always refuses.
// Every rule read here is a `BodyRule` or `Arity` field the row states.

import type { Arity, ArgType, BodyRule, Expr } from "../../registry/vocabulary.ts";
import { CodegenError } from "../../errors.ts";
import { didYouMean, closestNameTo } from "../../levenshtein.ts";
import { staticKey } from "../passes/naming.ts";
import { computedKeyInOperatorBody, spreadInOperatorBody } from "./errors.ts";
import { evaluate } from "../passes/evaluate.ts";

type Lit = { kind: "number" | "string" | "bool" | "null" | "array" | "object" | "regex" | "bigint"; value: Expr };

/** The literal a slot holds, or null for anything the gate must not judge. */
function literal(e: Expr): Lit | null {
  switch (e.type) {
    case "NumberLiteral":
      return { kind: "number", value: e };
    case "UnaryExpr":
      return e.op === "-" && e.argument.type === "NumberLiteral" ? { kind: "number", value: e } : null;
    case "StringLiteral":
      // A source `"$x"` IS the field reference `$x` — a runtime value, not a literal.
      return e.value.startsWith("$") ? null : { kind: "string", value: e };
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
  object: "an object",
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
      // Handled before the literal gate — see `checkType`.
      return false;
    case "date":
    case "timestamp":
      return false;
  }
}

const EXPECTS: Record<ArgType, string> = {
  number: "expects a number",
  int: "expects an integer",
  "int-or-long": "expects an integer",
  "number-or-date": "expects a number or a date",
  string: "expects a string",
  fieldName: "expects the NAME of a field to write — a non-empty string with no '$' prefix and no dot",
  fieldPath: "expects the PATH of a field to read, carrying its own '$'",
  bool: "expects a boolean",
  array: "expects an array",
  object: "expects a document",
  date: "expects a date",
  timestamp: "expects a timestamp",
};

const hint = (expected: ArgType): string =>
  expected === "date" || expected === "number-or-date"
    ? " Use a field path or new Date(…)."
    : expected === "timestamp"
      ? " Use a field path (a timestamp has no literal form)."
      : "";

/** A literal of a type the slot can never take. `slot` is the key, or "" for a positional operand. */
export function checkType(name: string, slot: string, e: Expr, expected: ArgType): void {
  // A field NAME is the one slot where a `$`-led string is the ERROR rather than a
  // runtime value, so it is read from the source and not through the literal gate:
  // `{ $count: "$n" }` is refused by the server, and so is a dotted or empty name.
  if (expected === "fieldPath") {
    if (e.type !== "StringLiteral") return;
    if (!e.value.startsWith("$") || e.value.startsWith("$$") || e.value === "$") {
      throw new CodegenError(
        `'${name}'${slot ? ` ${slot}` : ""} reads a field PATH, and the server insists it carries its own '$': write '$${e.value.replace(/^\$+/, "")}'.`,
        e.pos,
      );
    }
    return;
  }
  if (expected === "fieldName") {
    if (e.type !== "StringLiteral") {
      const other = literal(e);
      if (other === null || other.kind === "null") return;
      throw new CodegenError(
        `'${name}'${slot ? ` ${slot}` : ""} names a field to WRITE, and ${NOUN[other.kind]} is not a name. Pass a plain field name, e.g. 'total'.`,
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
      `'${name}'${slot ? ` ${slot}` : ""} names a field to WRITE, and '${e.value}' ${bad}. The server refuses it — pass a plain field name, e.g. 'total'.`,
      e.pos,
    );
  }
  const lit = literal(e);
  if (lit === null || lit.kind === "null") return;
  if (matches(lit, expected)) return;
  throw new CodegenError(
    `'${name}'${slot ? ` ${slot}` : ""} ${EXPECTS[expected]}, but got ${NOUN[lit.kind]}.${hint(expected)}`,
    e.pos,
  );
}

/**
 * A literal string outside a closed set, with a suggestion.
 *
 * A `$`-led string is normally a runtime field reference and no business of a
 * validator — unless the slot is CONSTANT-only, where the server reads the
 * string as itself: measured, `{ $bucketAuto: { granularity: "$g" } }` answers
 * "granularity must be one of: R5, R10, …" rather than reading a field.
 */
function checkEnum(
  name: string,
  key: string,
  e: Expr,
  allowed: readonly string[],
  caseInsensitive: boolean,
  isConstantSlot = false,
): void {
  if (e.type !== "StringLiteral" || (e.value.startsWith("$") && !isConstantSlot)) return;
  const v = caseInsensitive ? e.value.toLowerCase() : e.value;
  if (allowed.includes(v)) return;
  const near = closestNameTo(v, allowed);
  throw new CodegenError(
    `'${name}' ${key} must be one of: ${allowed.join(", ")} — got '${e.value}'.${near !== null ? ` Did you mean '${near}'?` : ""}`,
    e.pos,
  );
}

/** A literal flag string with a character outside the set. */
function checkCharSet(name: string, key: string, e: Expr, set: string): void {
  if (e.type !== "StringLiteral" || e.value.startsWith("$")) return;
  for (const ch of e.value) {
    if (!set.includes(ch)) {
      throw new CodegenError(
        `'${name}' ${key} has an invalid flag '${ch}'. MongoDB allows only ${[...set].join(", ")} — a JavaScript 'g' or 'y' flag is not supported.`,
        e.pos,
      );
    }
  }
}

/**
 * An object-shaped operator's body, in either call form: the keys it must have,
 * the keys it may not have (with a suggestion), and each key's enum, flag set
 * and type. `args` are the call's arguments; `keys` the row's positional order.
 */
export function checkBody(
  name: string,
  rule: BodyRule,
  args: readonly Expr[],
  keys: readonly string[],
  pos: number,
): void {
  let present: readonly string[];
  let hasSpread = false;
  let valueOf: (k: string) => Expr | undefined;
  const body = args.length === 1 && args[0].type === "ObjectLiteral" ? args[0] : null;
  if (body !== null) {
    const entries = body.entries;
    // The keys of an operator's body are its wire format: neither a spread nor a
    // computed key can produce one, and the server refuses the document either way.
    for (const e of entries) {
      if (e.type === "SpreadElement") throw spreadInOperatorBody(e.pos);
      if (e.key.kind === "computed") throw computedKeyInOperatorBody(e.pos);
    }
    hasSpread = false;
    const byKey = new Map<string, Expr>();
    for (const e of entries) if (e.type === "KeyValueEntry") byKey.set(staticKey(e) ?? "", e.value);
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
  if (body !== null && !hasSpread && rule.closed) {
    for (const k of present) {
      if (!closed.includes(k)) {
        throw new CodegenError(
          `'${name}' has no parameter '${k}'.${didYouMean(k, closed, (s) => s)} Valid keys: ${closed.join(", ")}.`,
          valueOf(k)?.pos ?? pos,
        );
      }
    }
  }
  if (!hasSpread) {
    for (const k of rule.required) {
      if (!present.includes(k)) throw new CodegenError(`'${name}' requires the '${k}' field, but it is missing.`, pos);
    }
    for (const group of rule.exactlyOneOf ?? []) {
      const found = group.filter((k) => present.includes(k));
      if (found.length !== 1) {
        throw new CodegenError(
          `'${name}' requires exactly one of ${group.map((k) => `'${k}'`).join(", ")}${found.length === 0 ? ", but none is present" : `, but got ${found.map((k) => `'${k}'`).join(" and ")}`}.`,
          pos,
        );
      }
    }
    for (const group of rule.atLeastOneOf ?? []) {
      if (!group.some((k) => present.includes(k))) {
        throw new CodegenError(
          `'${name}' needs at least one of ${group.map((k) => `'${k}'`).join(", ")}, and none is present.`,
          pos,
        );
      }
    }
    for (const [a, b] of rule.notTogether ?? []) {
      const inA = present.filter((k) => a.includes(k));
      const inB = present.filter((k) => b.includes(k));
      if (inA.length > 0 && inB.length > 0) {
        throw new CodegenError(
          `'${name}' takes '${inA[0]}' or '${inB[0]}', not both: they belong to two families that never mix — ${a.join("/")} against ${b.join("/")}.`,
          pos,
        );
      }
    }
    for (const group of rule.together ?? []) {
      const found = group.filter((k) => present.includes(k));
      if (found.length !== 0 && found.length !== group.length) {
        const missing = group.filter((k) => !present.includes(k));
        throw new CodegenError(
          `'${name}' takes ${group.map((k) => `'${k}'`).join(" and ")} together or neither: ${missing.map((k) => `'${k}'`).join(" and ")} ${missing.length === 1 ? "is" : "are"} missing.`,
          pos,
        );
      }
    }
  }
  const allowed = rule.everyValueIn ?? [];
  for (const k of rule.everyValueIn === undefined ? [] : present) {
    const v = valueOf(k);
    if (v === undefined) continue;
    const lit = literal(v);
    // A document is a value in its own right — `{ $meta: "textScore" }` is a real
    // sort key — and anything the gate cannot read is the runtime's business.
    if (lit === null || lit.kind === "object") continue;
    const held =
      lit.kind === "number" ? numberOf(v) : lit.kind === "string" && v.type === "StringLiteral" ? v.value : null;
    if (held === null || !allowed.includes(held)) {
      throw new CodegenError(
        `'${name}' takes ${allowed.map((one) => JSON.stringify(one)).join(" or ")} for every key, and '${k}' has ${held === null ? NOUN[lit.kind] : JSON.stringify(held)}.`,
        v.pos,
      );
    }
  }
  if (rule.onePolarity === true && body !== null) {
    let seen: { key: string; on: boolean } | null = null;
    for (const k of present) {
      if (k === "_id") continue;
      const v = valueOf(k);
      if (v === undefined) continue;
      const on =
        v.type === "NumberLiteral" && (v.value === 1 || v.value === 0)
          ? v.value === 1
          : v.type === "BooleanLiteral"
            ? v.value
            : null;
      if (on === null) continue;
      if (seen !== null && seen.on !== on) {
        throw new CodegenError(
          `'${name}' is either an inclusion or an exclusion, not both: '${seen.key}' ${seen.on ? "includes" : "excludes"} and '${k}' ${on ? "includes" : "excludes"} ('_id' alone may be excluded from an inclusion). The server refuses the mix.`,
          v.pos,
        );
      }
      seen ??= { key: k, on };
    }
  }
  const caseInsensitive = new Set(rule.caseInsensitiveKeys ?? []);
  for (const [k, allowed] of Object.entries(rule.enums ?? {})) {
    const v = valueOf(k);
    // A `$`-led string in a CONSTANT key is read by the server as itself, so the
    // closed set applies to it there — measured, `{ $bucketAuto: { granularity:
    // "$g" } }` answers "granularity must be one of: R5, R10, …".
    if (v !== undefined) {
      checkEnum(name, k, v, allowed, caseInsensitive.has(k), (rule.constantKeys ?? []).includes(k));
    }
  }
  for (const [k, set] of Object.entries(rule.charSets ?? {})) {
    const v = valueOf(k);
    if (v !== undefined) checkCharSet(name, k, v, set);
  }
  for (const [k, t] of Object.entries(rule.keyTypes ?? {})) {
    const v = valueOf(k);
    if (v !== undefined) checkType(name, k, v, t);
  }
  // A key the server reads at compile time — `$bucket.boundaries`, `$lookup.pipeline` —
  // must hold a constant; a field path or an expression there is refused as the server refuses it.
  for (const k of rule.constantKeys ?? []) {
    const v = valueOf(k);
    if (v !== undefined && !evaluate(v, new Map()).ok) {
      throw new CodegenError(
        `'${name}' ${k} must be a compile-time constant — the server reads it before any document; got an expression.`,
        v.pos,
      );
    }
  }
}

/** The per-slot literal checks an `Arity` states — `slotType`, `slotEnums` — over positional operands. */
export function checkSlots(
  name: string,
  args: Arity,
  operands: readonly Expr[],
  /**
   * Does the row state an OBJECT form for this body? When it does, an object
   * literal is exempt from `slotType` — the date accessors take a date OR the
   * `{ date, timezone }` document, and the rule stated for the first must not
   * refuse the second, which the row's own `body` rule judges instead. When it
   * does not, an object literal is simply the wrong type: `$documents({ a: 1 })`
   * is refused by the server.
   */
  hasObjectForm = true,
): void {
  for (const i of args.nullRefused ?? []) {
    const e = operands[i];
    if (e !== undefined && e.type === "NullLiteral") {
      throw new CodegenError(
        `'${name}' does not accept null — the server refuses it rather than answering null. Guard the operand: '$ifNull(<value>, <fallback>)'.`,
        e.pos,
      );
    }
  }
  for (const [i, flag] of Object.entries(args.regexFlag ?? {})) {
    const e = operands[Number(i)];
    if (e !== undefined && e.type === "RegexLiteral" && !e.flags.includes(flag)) {
      throw new CodegenError(
        `'${name}' needs the '${flag}' flag on its regex, as JavaScript does (a TypeError without it): write /…/${flag}.`,
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
    if (e !== undefined && e.type === "ObjectLiteral") checkBody(name, rule, [e], rule.positional ?? [], e.pos);
  }
  for (const [i, t] of Object.entries(args.slotType ?? {})) {
    const e = operands[Number(i)];
    if (e === undefined || (hasObjectForm && e.type === "ObjectLiteral")) continue;
    if (!Array.isArray(t)) {
      checkType(name, "", e, t as ArgType);
      continue;
    }
    // A slot that takes more than one shape: the literal must match one of them,
    // and the message names them all.
    const types = t as readonly ArgType[];
    // A type with a message of its own answers for itself, so the reason names the
    // one shape the value nearly was: `$unwind("items")` is a path missing its '$'.
    if (e.type === "StringLiteral" && types.includes("fieldPath")) {
      checkType(name, "", e, "fieldPath");
      continue;
    }
    const lit = literal(e);
    if (lit === null || types.some((one) => matches(lit, one))) continue;
    throw new CodegenError(
      `'${name}' takes ${types.map((one) => EXPECTS[one].replace(/^expects /, "")).join(" or ")} here, and ${NOUN[lit.kind]} is neither.`,
      e.pos,
    );
  }
  if (args.elementType !== undefined) {
    for (const e of operands) checkType(name, "", e, args.elementType);
  }
  for (const [i, t] of Object.entries(args.arrayOf ?? {})) {
    const e = operands[Number(i)];
    if (e === undefined || e.type !== "ArrayLiteral") continue;
    for (const el of e.elements) {
      if (el.type === "SpreadElement") continue;
      checkType(name, `element ${e.elements.indexOf(el) + 1}`, el as Expr, t as ArgType);
    }
  }
  for (const [i, [lo, hi]] of Object.entries(args.slotRange ?? {})) {
    const e = operands[Number(i)];
    const n = e === undefined ? null : numberOf(e);
    if (n !== null && (n < lo || n > hi)) {
      // A range whose top is the largest safe integer is a FLOOR, and reads as one.
      const bound = hi === Number.MAX_SAFE_INTEGER ? `of ${lo} or more` : `from ${lo} to ${hi}`;
      throw new CodegenError(`'${name}' argument ${Number(i) + 1} must be a number ${bound} — got ${n}.`, e!.pos);
    }
  }
  for (const i of args.nonZero ?? []) {
    const e = operands[i];
    if (e !== undefined && numberOf(e) === 0) {
      throw new CodegenError(
        `'${name}' cannot divide by zero — the server refuses a zero divisor, and JavaScript's NaN has no MongoDB value.`,
        e.pos,
      );
    }
  }
  for (const i of args.constant ?? []) {
    const e = operands[i];
    // An object literal is exempt, as it is for `slotType`: a body that may be a
    // name OR a document has its keys described by the row's `body` rule, and
    // several of those keys hold expressions. `$unionWith("c")` must be constant;
    // `$unionWith({ coll: "c", pipeline: [$match(…)] })` must not be.
    if (e !== undefined && e.type !== "ObjectLiteral" && !evaluate(e, new Map()).ok) {
      throw new CodegenError(
        `'${name}' argument ${i + 1} must be a compile-time constant — the server reads it before any document; got an expression.`,
        e.pos,
      );
    }
  }
  for (const [i, allowed] of Object.entries(args.slotEnums ?? {})) {
    const e = operands[Number(i)];
    if (e !== undefined) checkEnum(name, `argument ${Number(i) + 1}`, e, allowed, false);
  }
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
    ` MongoDB has no format specifier for ${[...new Set(missing)].map((t) => `'${t}'`).join(", ")}: it outputs no ` +
    `month name, weekday name, 12-hour clock or 2-digit year. Derive those from the numeric parts (e.g. ["Jan", …][$.t.getMonth()]).`
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
      `'${name}' takes MongoDB's date format specifiers, not Moment/Luxon tokens — '${fmt}' formats as that literal text, never a date.${momentFormatHint(fmt)}`,
      pos,
    );
  }
}
