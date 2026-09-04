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
  const lit = literal(e);
  if (lit === null || lit.kind === "null") return;
  if (matches(lit, expected)) return;
  throw new CodegenError(
    `'${name}'${slot ? ` ${slot}` : ""} ${EXPECTS[expected]}, but got ${NOUN[lit.kind]}.${hint(expected)}`,
    e.pos,
  );
}

/** A literal string outside a closed set, with a suggestion. */
function checkEnum(name: string, key: string, e: Expr, allowed: readonly string[], caseInsensitive: boolean): void {
  if (e.type !== "StringLiteral" || e.value.startsWith("$")) return;
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
  }
  const caseInsensitive = new Set(rule.caseInsensitiveKeys ?? []);
  for (const [k, allowed] of Object.entries(rule.enums ?? {})) {
    const v = valueOf(k);
    if (v !== undefined) checkEnum(name, k, v, allowed, caseInsensitive.has(k));
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
export function checkSlots(name: string, args: Arity, operands: readonly Expr[]): void {
  for (const i of args.nullRefused ?? []) {
    const e = operands[i];
    if (e !== undefined && e.type === "NullLiteral") {
      throw new CodegenError(
        `'${name}' does not accept null — the server refuses it rather than answering null. Guard the operand: '$ifNull(<value>, <fallback>)'.`,
        e.pos,
      );
    }
  }
  for (const [i, t] of Object.entries(args.slotType ?? {})) {
    const e = operands[Number(i)];
    // An object literal is exempt: the date accessors take a date OR the
    // `{ date, timezone }` document, and a rule stated for the first must not
    // refuse the second.
    if (e !== undefined && e.type !== "ObjectLiteral") checkType(name, "", e, t);
  }
  if (args.elementType !== undefined) {
    for (const e of operands) checkType(name, "", e, args.elementType);
  }
  for (const i of args.constant ?? []) {
    const e = operands[i];
    if (e !== undefined && !evaluate(e, new Map()).ok) {
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
