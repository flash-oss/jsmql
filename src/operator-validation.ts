// Per-operator argument validation.
//
// The mirror of src/stage-validation.ts, for value-position `$op(...)` calls.
// Catches operator-argument mistakes the MongoDB server always rejects — wrong
// operand counts, missing/unknown object keys, bad enum values, literal slots of
// a type the operator can never accept — and turns the opaque runtime server
// error into an actionable compile-time message.
//
// THE LITERAL-GATING INVARIANT (shared with stage-validation; helpers live in
// src/literal-gate.ts): every check inspects only fully-static literal shapes
// and no-ops the instant a slot is a field ref / op call / template literal /
// computed key / spread, so only 100%-certain violations throw. UNLIKE the
// stage validator, there is NO constant-only inversion here: operator argument
// slots legitimately accept runtime expressions, so a non-literal is NEVER a
// certain violation.
//
// Driven by the optional `args` (ArgRules) dimension on each OperatorDef plus
// the operator's `shape`. Called once from generateOperatorCall (codegen.ts)
// after assertNoSpread, before shape dispatch. See docs/specs/operator-validation.md.

import type { CallArg, Expr } from "./ast.ts";
import { checkArity, CodegenError, type GenerateCtx } from "./codegen.ts";
import { closestNameTo, didYouMean } from "./levenshtein.ts";
import { arrayElements, checkEnum, litNumber, litString, objectInfo } from "./literal-gate.ts";
import type { ArgRules, ArgType, EnumRef } from "./operators.ts";
import { lookupOperator } from "./operators.ts";
import { STAGES } from "./stages.ts";

// Shared, closed enum sets resolved by name from an operator's `enums` rule.
// timeUnit is case-SENSITIVE lowercase (mongod rejects "Day"); weekday is
// case-INSENSITIVE (mongod accepts "Monday"/"monday"); bsonTypeName is the full
// $type/$convert alias set (verified recognised by $convert.to on mongod).
export const TIME_UNIT = [
  "year",
  "quarter",
  "month",
  "week",
  "day",
  "hour",
  "minute",
  "second",
  "millisecond",
] as const;
const WEEKDAY = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
// Keep in sync with the BSON type aliases MongoDB accepts; bump when a new type lands.
const BSON_TYPE_NAME = [
  "double",
  "string",
  "object",
  "array",
  "binData",
  "objectId",
  "bool",
  "date",
  "null",
  "regex",
  "dbPointer",
  "javascript",
  "symbol",
  "javascriptWithScope",
  "int",
  "timestamp",
  "long",
  "decimal",
  "minKey",
  "maxKey",
] as const;
const REGEX_FLAGS = "imxs"; // MongoDB allows only these regex option flags (a JS 'g'/'y' is rejected).

/** Validate a literal-string slot against an enum ref. No-op on a non-literal (gate). */
function checkArgEnum(name: string, key: string, value: Expr, ref: EnumRef): void {
  // HR1: a source `"$x"` is the field reference `$x` (a runtime value), not a
  // literal enum value — these slots accept a runtime expression, so no-op.
  const lit = litString(value);
  if (lit !== null && lit.startsWith("$")) return;
  if (ref === "regexFlags") {
    const s = litString(value);
    if (s === null) return;
    for (const ch of s) {
      if (!REGEX_FLAGS.includes(ch)) {
        throw new CodegenError(
          `'${name}' ${key} has an invalid regex flag '${ch}'. MongoDB allows only i, m, x, s ` +
            `— a JavaScript 'g' or 'y' flag is not supported.`,
          value.pos,
        );
      }
    }
    return;
  }
  if (ref === "weekday") {
    // Case-insensitive (mongod accepts "Monday" / "monday" / "MONDAY").
    const s = litString(value);
    if (s === null || WEEKDAY.includes(s.toLowerCase() as (typeof WEEKDAY)[number])) return;
    const near = closestNameTo(s.toLowerCase(), WEEKDAY);
    throw new CodegenError(
      `'${name}' ${key} must be a weekday (${WEEKDAY.join(", ")}) — got '${s}'.` +
        (near !== null ? ` Did you mean '${near}'?` : ""),
      value.pos,
    );
  }
  const allowed = ref === "timeUnit" ? TIME_UNIT : ref === "bsonTypeName" ? BSON_TYPE_NAME : ref;
  checkEnum(name, key, value, allowed);
}

// ── Literal-type checking (date / numeric / bitwise / object / timestamp slots) ──
// The BSON-ish kind of a fully-static literal expression, or null for anything
// non-literal (field ref / op call / `new Date(…)` / param / template) — those
// no-op (the gate). `null` (the JS literal) is its own kind: MongoDB accepts it
// in these slots (yields null), so it is treated as always-valid.
type LiteralKind = "number" | "string" | "bool" | "null" | "array" | "object" | "regex" | "bigint";

function literalKind(e: Expr): LiteralKind | null {
  switch (e.type) {
    case "NumberLiteral":
      return "number";
    case "UnaryExpr":
      return e.op === "-" && e.operand.type === "NumberLiteral" ? "number" : null;
    case "StringLiteral":
      // HR1: a source `"$x"` IS the field reference `$x` (a runtime value of any
      // type), not a literal string — so it's not a certain type violation.
      return e.value.startsWith("$") ? null : "string";
    case "BooleanLiteral":
      return "bool";
    case "NullLiteral":
      return "null";
    case "ArrayLiteral":
      return "array";
    case "ObjectLiteral":
      return "object";
    case "RegexLiteral":
      return "regex";
    case "BigIntLiteral":
      return "bigint";
    default:
      return null;
  }
}

const KIND_NOUN: Record<LiteralKind, string> = {
  number: "a number",
  string: "a string",
  bool: "a boolean",
  null: "null",
  array: "an array",
  object: "an object",
  regex: "a regular expression",
  bigint: "a bigint",
};

/** Does literal `kind` (with value `e`) satisfy the `expected` arg type? */
function typeMatches(kind: LiteralKind, e: Expr, expected: ArgType): boolean {
  switch (expected) {
    case "number":
    case "number-or-date": // a date has no literal form, so only a number literal can match
      return kind === "number" || kind === "bigint";
    case "integer":
    case "int-or-long": {
      if (kind === "bigint") return true;
      const n = litNumber(e);
      return n !== null && Number.isInteger(n);
    }
    case "string":
      return kind === "string";
    case "bool":
      return kind === "bool";
    case "array":
      return kind === "array";
    case "object":
      return kind === "object";
    case "date":
    case "timestamp":
      return false; // no literal form — only a field ref / `new Date(…)` (non-literal) is valid
  }
}

function typeNoun(expected: ArgType): string {
  switch (expected) {
    case "number":
      return "expects a number";
    case "integer":
    case "int-or-long":
      return "expects an integer";
    case "number-or-date":
      return "expects a number or a date";
    case "string":
      return "expects a string";
    case "bool":
      return "expects a boolean";
    case "array":
      return "expects an array";
    case "object":
      return "expects a document";
    case "date":
      return "expects a date";
    case "timestamp":
      return "expects a timestamp";
  }
}

function typeHint(expected: ArgType): string {
  if (expected === "date" || expected === "number-or-date") return " Use a field path or new Date(…).";
  if (expected === "timestamp") return " Use a field path (a timestamp has no literal form).";
  return "";
}

/**
 * Reject a literal of a type the slot can never accept (no MongoDB coercion).
 * A non-literal (field ref / `new Date(…)` / op call / param) and a `null`
 * literal no-op — only a certain-wrong literal throws. `slot` is the key name
 * (object form) or "" for a single/positional operand.
 */
export function checkArgType(name: string, slot: string, value: Expr, expected: ArgType): void {
  const kind = literalKind(value);
  if (kind === null || kind === "null") return;
  if (typeMatches(kind, value, expected)) return;
  const slotPart = slot ? ` ${slot}` : "";
  throw new CodegenError(
    `'${name}'${slotPart} ${typeNoun(expected)}, but got ${KIND_NOUN[kind]}.${typeHint(expected)}`,
    value.pos,
  );
}

/** The operand expressions of an array/flex call: the single array literal's
 *  elements, or the positional args (spread already rejected upstream). */
function operandExprs(args: CallArg[]): Expr[] {
  if (args.length === 1 && (args[0] as Expr).type === "ArrayLiteral") {
    return arrayElements(args[0] as Expr) ?? [];
  }
  return args as Expr[];
}

/**
 * The expression operator that does the analogous job for a stage a developer
 * reached for in value position. Only the handful with a real counterpart — most
 * stages reshape a document *stream*, which no expression can do, and for those the
 * message stops at "move it to a statement" rather than inventing an alternative.
 */
const EXPRESSION_ANALOGUE: Record<string, string> = {
  $sort: "$sortArray",
  $limit: "$slice",
  $skip: "$slice",
  $match: "$filter",
  $redact: "$filter",
  $set: "$mergeObjects",
  $addFields: "$mergeObjects",
  $unset: "$unsetField",
  $project: "$getField",
  $unionWith: "$concatArrays",
};

/**
 * Reject a **pipeline stage** name used where a value is expected. A stage is a
 * statement, so `{ $limit: … }` in an expression slot is not merely unusual — no
 * MongoDB deployment has a `$limit` *expression* operator, and the server answers
 * `Unrecognized expression '$limit'`. That universality is what puts this inside the
 * pre-flight validators' remit (see src/CLAUDE.md § "Never guard raw MQL"): it can
 * never reject a shape some deployment accepts.
 *
 * Registry-driven, so nothing here is a hand-maintained list: a name is rejected
 * only when it is in `STAGES` and NOT in `OPERATORS`. `$count` — the one name that
 * is both a stage and an accumulator — therefore passes, and HR2 forward-compat is
 * untouched because an unknown name is in neither registry.
 */
function rejectStageInValuePosition(name: string, pos: number): void {
  if (!(name in STAGES) || lookupOperator(name) !== undefined) return;
  const analogue = EXPRESSION_ANALOGUE[name];
  throw new CodegenError(
    `'${name}' is a pipeline stage, not an expression — MongoDB has no '${name}' expression operator, so ` +
      `'{ ${name}: … }' in a value position is rejected by the server. Write it as a pipeline statement ` +
      `('${name}(…);') or as a chain link ('$$.${name}(…)').` +
      (analogue === undefined ? "" : ` For the value-position equivalent, use '${analogue}(…)'.`),
    pos,
  );
}

/**
 * Validate an operator call's arguments against its shape + `args` rules.
 * No-op for unknown operators (forward-compat passthrough) and for any rule the
 * operator doesn't declare. Throws a `CodegenError` (with the offending node's
 * `.pos`) on a 100%-certain violation.
 */
export function validateOperatorArgs(
  name: string,
  style: "positional" | "object",
  args: CallArg[],
  pos: number,
  ctx: GenerateCtx,
): void {
  rejectStageInValuePosition(name, pos);
  const def = lookupOperator(name);
  if (def === undefined) return; // unknown operator — codegen passes it through

  // ── none-shape: takes no arguments ──────────────────────────────────────────
  // Shape-driven (no `args` rule needed). The server ignores/​rejects operands
  // here; today codegen silently swallows them, hiding a real misconception
  // (the user thinks they pass a field).
  if (def.shape.kind === "none") {
    if (args.length === 0) return;
    if (def.category === "window") {
      // $rank / $denseRank / $documentNumber compute position from the window
      // ordering, not from an argument.
      throw new CodegenError(
        `${name}() takes no arguments, got ${args.length}. Its value is computed from the ` +
          `'$setWindowFields' sortBy ordering — set sortBy on the stage, don't pass a field.`,
        pos,
      );
    }
    checkArity(name, { sig: "", none: true }, args.length, pos, "");
    return;
  }

  const rules = def.args;
  if (rules === undefined) return;

  // ── arity (array / flex shapes) ──────────────────────────────────────────────
  // The effective operand count is the positional arg count, OR — when called as
  // `$op([a, b, …])` — the single array-literal's element count (both forms must
  // be checked; HR2). Degenerate cases (an array op given 0 or 1 non-array arg)
  // return null and defer to codegen's own list-operand / "at least 1" errors.
  if (rules.arity !== undefined && (def.shape.kind === "array" || def.shape.kind === "flex")) {
    const a = rules.arity;
    // `aggOnly` rules (the comparison operators $eq/$gt/…) apply ONLY in
    // aggregation-expression position: there `$gt($.x)` (1 operand) and
    // `$gt(a, b, c)` (3) are certain errors, but as a query predicate
    // (`{ field: { $gt: v } }` / `{ field: { $gt: [a, b, c] } }`) both shapes
    // are valid. Outside agg position we can't be certain, so we skip.
    if (!a.aggOnly || ctx.aggExpr === true) {
      const count = operandCount(def.shape.kind, args);
      if (count !== null) {
        checkArity(name, { sig: a.sig ?? "", exact: a.exact, allowed: a.allowed, atLeast: a.atLeast }, count, pos, "");
      }
    }
  }

  // ── literal-type checks (single / array / flex operands) ─────────────────────
  if (rules.singleType !== undefined && def.shape.kind === "single" && args.length >= 1) {
    checkArgType(name, "", args[0] as Expr, rules.singleType);
  }
  if (def.shape.kind === "array" || def.shape.kind === "flex") {
    if (rules.elementType !== undefined) {
      for (const el of operandExprs(args)) checkArgType(name, "", el, rules.elementType);
    }
    if (rules.positionalTypes !== undefined) {
      const ops = operandExprs(args);
      rules.positionalTypes.forEach((t, i) => {
        if (ops[i] !== undefined) checkArgType(name, "", ops[i], t);
      });
    }
  }

  // ── object-shape: required / unknown keys + key enums / types ────────────────
  // Only object-shape operators have named-key wire format; a `flex`/`single`
  // operator given a lone object literal treats it as a VALUE, not named keys.
  if (def.shape.kind === "object") {
    validateObjectKeys(name, def.shape.keys, rules, style, args, pos);
  }
}

/**
 * The effective operand count for an array/flex operator call, or null when the
 * count can't be the basis of an arity check here:
 *   - `$op([a, b])`        → the array literal's element count (the operand list)
 *   - `$op(a, b, …)` (≥2)  → the positional arg count
 *   - array op, 0 / 1 non-array arg → null (codegen owns those errors: a list op
 *     rejects a lone scalar with `listOperandError`, and 0 args with "at least 1")
 *   - a single array literal carrying a spread → null (can't count statically)
 */
function operandCount(shape: "array" | "flex", args: CallArg[]): number | null {
  if (args.length === 1 && (args[0] as Expr).type === "ArrayLiteral") {
    const els = arrayElements(args[0] as Expr);
    return els === null ? null : els.length;
  }
  if (shape === "array" && args.length <= 1) return null;
  return args.length;
}

/**
 * Validate the named keys of an object-shape operator call (both call styles):
 *   - object form `$op({ k: v })`  → keys come from the object literal
 *   - positional   `$op(a, b)`     → keys come from `shape.keys` in order
 * Enforces `required` (missing-key) and — for the object form, where keys are
 * user-written — the closed-key set (`required ∪ optional`, unless
 * `closedKeys: false`) with a `didYouMean` suggestion. A spread in the object
 * body suppresses both checks (the missing/extra key might be in the spread).
 */
function validateObjectKeys(
  name: string,
  shapeKeys: readonly string[],
  rules: ArgRules,
  style: "positional" | "object",
  args: CallArg[],
  pos: number,
): void {
  const required = rules.required ?? [];
  const enums = rules.enums;
  if (required.length === 0 && (rules.optional ?? []).length === 0 && enums === undefined) return;

  let presentKeys: readonly string[];
  let hasSpread = false;
  // The value expression for a named key, in either call form (undefined if absent).
  let valueOf: (k: string) => Expr | undefined;

  if (style === "object") {
    const info = objectInfo(args[0] as Expr); // parser guarantees args[0] is an object literal here
    if (info === null) return; // computed key / non-object → gate no-op
    presentKeys = [...info.byKey.keys()];
    hasSpread = info.hasSpread;
    valueOf = (k) => info.byKey.get(k);
  } else {
    // Positional: codegen maps args[i] → shapeKeys[i], so the present keys are
    // the leading `args.length` names. (No spread, no unknown keys possible.)
    presentKeys = shapeKeys.slice(0, args.length);
    valueOf = (k) => {
      const i = shapeKeys.indexOf(k);
      return i >= 0 && i < args.length ? (args[i] as Expr) : undefined;
    };
  }

  const closedSet = [...required, ...(rules.optional ?? [])];

  // Unknown-key FIRST (object form only — positional keys come from the registry
  // and are always valid). Checking before required-keys means a typo'd required
  // key (`iff` for `if`) is reported as the unknown key with a `didYouMean`
  // suggestion, not as a confusing "requires 'if'" on a key the user thought
  // they supplied. A spread might legitimise an out-of-set key, so skip then.
  if (style === "object" && !hasSpread && rules.closedKeys !== false) {
    for (const k of presentKeys) {
      if (!closedSet.includes(k)) {
        throw new CodegenError(
          `'${name}' has no parameter '${k}'.${didYouMean(k, closedSet, (s) => s)} ` +
            `Valid keys: ${closedSet.join(", ")}.`,
          valueOf(k)?.pos ?? pos,
        );
      }
    }
  }

  // Required-keys (a spread might supply a missing one — skip then).
  if (!hasSpread) {
    for (const k of required) {
      if (!presentKeys.includes(k)) {
        throw new CodegenError(`'${name}' requires the '${k}' field, but it is missing.`, pos);
      }
    }
  }

  // Enum slots: a literal-string value outside the closed set throws (didYouMean);
  // a non-literal value no-ops (the gate). Runs in both call forms.
  if (enums !== undefined) {
    for (const [key, ref] of Object.entries(enums)) {
      const v = valueOf(key);
      if (v !== undefined) checkArgEnum(name, key, v, ref);
    }
  }

  // Typed slots: a literal of a type the slot can never accept throws (date
  // slots, $dateAdd.amount integer, …); a non-literal value no-ops.
  if (rules.keyTypes !== undefined) {
    for (const [key, t] of Object.entries(rules.keyTypes)) {
      const v = valueOf(key);
      if (v !== undefined) checkArgType(name, key, v, t);
    }
  }
}
