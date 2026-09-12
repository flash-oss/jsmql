// The constant evaluator. Given an expression and the constants already known,
// it answers with a VALUE or with "not a constant".
//
// THE ONE INVARIANT: a fold must not change the answer. Whatever this computes
// has to equal what the same expression computes on the server when it is left
// alone, or folding stops being an optimisation and becomes a second semantics.
// So the rule for every operator is not "what does JavaScript do" but "where do
// JavaScript and MongoDB agree" — and where they do not, this refuses:
//
//   "a" + 1     JavaScript: "a1"       MongoDB: $concat rejects a non-string
//   1 / 0       JavaScript: Infinity   MongoDB: an error, and no literal exists
//
// Refusing is never a failure. The binding simply stays a runtime one, which is
// what it would have been without this pass at all.

import type { Expr } from "../../registry/ast.ts";
import { setKey } from "../../registry/mql.ts";
import { isSpellable, readLiteral } from "./literal.ts";
import type { Arg } from "./fold-methods.ts";
import {
  foldConstructor,
  foldInstanceCall,
  foldNamedCall,
  foldNamespaceCall,
  numberSpelling,
  foldNamespaceConstant,
} from "./fold-methods.ts";
import type { Family } from "../../registry/vocabulary.ts";
import { acceptsArgumentCount, isCallable, namespaceNames } from "../rows.ts";
import { isMqlShaped } from "./inject.ts";

/** What is known so far: a name bound to a constant, or to a declared function. */
export type Constants = ReadonlyMap<string, unknown>;

/**
 * A declared function, held so a CALL to it can be evaluated.
 *
 * Wrapped rather than stored bare, because it must never be mistaken for a
 * value: a function has no MongoDB literal, and substituting one into the tree
 * would put a lambda where an expression belongs. `fold` keeps these in the
 * environment and out of the substitution map for exactly that reason.
 */
export type DeclaredFunction = { readonly lambda: object };

export const asDeclaredFunction = (lambda: object): DeclaredFunction => ({ lambda });

const isDeclaredFunction = (v: unknown): v is DeclaredFunction =>
  typeof v === "object" && v !== null && "lambda" in v && Object.keys(v).length === 1;

/**
 * A value, or the reason there is none.
 *
 * `unspellable` is the third state, and it exists because "this is not a
 * constant" and "this IS a constant that MongoDB cannot write down" want
 * different outcomes. It PROPAGATES: an `Infinity` that reaches an operator
 * poisons everything built from it, so `1 / 0 > 0` does not quietly become
 * `true` while the server refuses the division outright.
 */
export type Evaluation = { ok: true; value: unknown } | { ok: false; unspellable?: string };

const NOT_CONSTANT: Evaluation = { ok: false };
const ok = (value: unknown): Evaluation => ({ ok: true, value });

/** A constant with no MongoDB literal, named so the caller can say which. */
const unspellable = (name: string): Evaluation => ({ ok: false, unspellable: name });

/** Pass a poisoned result through unchanged; anything else becomes a plain no. */
const propagate = (r: Evaluation): Evaluation => (!r.ok && r.unspellable !== undefined ? r : NOT_CONSTANT);

/** The value MongoDB cannot write down, or null when it can. */
function nameIfUnspellable(value: unknown): string | null {
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (!Number.isFinite(value)) return String(value);
    // `-0` is a DOUBLE to the driver where the same arithmetic gives MongoDB an
    // int `0`: `0 * -7` is `-0` here and `0` there, and the two differ in
    // `$type`, in `$toString` and in sort order.
    if (Object.is(value, -0)) return "-0";
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const name = nameIfUnspellable(v);
      if (name !== null) return name;
    }
  } else if (typeof value === "object" && value !== null && !(value instanceof Date)) {
    for (const v of Object.values(value)) {
      const name = nameIfUnspellable(v);
      if (name !== null) return name;
    }
  }
  return null;
}

/** Every value leaves through here, so one check covers every rule. */
function spellable(value: unknown): Evaluation {
  const name = nameIfUnspellable(value);
  if (name === null) return ok(value);
  // `-0` is a legal value the server computes (`$ceil: -0.5` → -0) but not one
  // a fold may WRITE: the driver sends a double where the same arithmetic gives
  // MongoDB an int 0. So it stays a runtime binding — not an error, unlike NaN
  // and Infinity, which no MongoDB expression yields.
  return name === "-0" ? NOT_CONSTANT : unspellable(name);
}

/**
 * How deep an expression may nest before we stop.
 *
 * `1 + 1 + … + 1` is left-nested one `BinaryExpr` per term, and a recursive
 * evaluator runs out of stack somewhere above 2,500 of them — as a `RangeError`
 * with no position, which is exactly what every rule here takes care not to
 * produce. Depth is cheap to count, so it is counted.
 */
const MAX_DEPTH = 400;

/** A folded string or array may not exceed this. See `withinSize`. */
const MAX_SIZE = 1_000_000;

/**
 * Refuse a value too large to belong in a query.
 *
 * `"x".padStart(500000000)` computes in a millisecond and yields half a gigabyte
 * of string, which goes into the AST, then into the document, then past BSON's
 * 16 MB limit. Nothing about that is a constant worth folding.
 */
function withinSize(value: unknown): boolean {
  if (typeof value === "string") return value.length <= MAX_SIZE;
  if (Array.isArray(value)) return value.length <= MAX_SIZE && value.every(withinSize);
  return true;
}

/** Every operand of a list, or the reason one of them had no value. */
function all(nodes: readonly Expr[], env: Constants, depth: number): unknown[] | Evaluation {
  const out: unknown[] = [];
  for (const node of nodes) {
    const r = at(node, env, depth);
    if (!r.ok) return propagate(r);
    out.push(r.value);
  }
  return out;
}

// ── operators ────────────────────────────────────────────────────────────────

/**
 * `+` is two operators wearing one symbol, and MongoDB spells them apart:
 * `$add` for numbers and `$concat` for strings. So a MIXED pair folds to
 * nothing — JavaScript would say `"a1"` where the server rejects the `$concat`.
 */
function plus(left: unknown, right: unknown): Evaluation {
  if (typeof left === "number" && typeof right === "number") {
    const sum = left + right;
    return losesIntegerPrecision("+", left, right, sum) ? NOT_CONSTANT : spellable(sum);
  }
  if (typeof left === "string" && typeof right === "string") return ok(left + right);
  return NOT_CONSTANT;
}

/**
 * Two integer operands whose result JavaScript cannot hold exactly.
 *
 * MongoDB does INTEGER arithmetic on integers — a 64-bit long, exact to the last
 * digit — while JavaScript computes in doubles and starts rounding above 2^53:
 *   123456789 * 987654321   JavaScript 121932631112635260
 *                           MongoDB    121932631112635269
 * Folding there would answer with the rounded one, so it does not fold.
 */
function losesIntegerPrecision(op: string, left: number, right: number, result: number): boolean {
  // Only the operations that KEEP integers integral. `7 / 2` is 3.5 on both
  // sides — `$divide` answers with a double — so there is no long to be exact
  // about and nothing to check.
  if (!KEEPS_INTEGERS.has(op)) return false;
  // A non-finite result is a different matter entirely, and the caller reports
  // it by name — checking it here would turn "this overflows" into silence.
  if (!Number.isFinite(result)) return false;
  return Number.isInteger(left) && Number.isInteger(right) && !Number.isSafeInteger(result);
}

const KEEPS_INTEGERS: ReadonlySet<string> = new Set(["+", "-", "*", "**"]);

/** Both operands numeric, and the result one MongoDB would compute the same. */
function arithmetic(op: string, left: unknown, right: unknown): Evaluation {
  if (typeof left !== "number" || typeof right !== "number") return NOT_CONSTANT;
  let value: number;
  switch (op) {
    case "-":
      value = left - right;
      break;
    case "*":
      value = left * right;
      break;
    case "/":
      value = left / right;
      break;
    case "%":
      value = left % right;
      break;
    case "**":
      // Only an integer power. A fractional exponent is a transcendental, and
      // no two implementations of one are required to agree to the last bit.
      if (!Number.isInteger(left) || !Number.isInteger(right) || right < 0) return NOT_CONSTANT;
      value = left ** right;
      break;
    default:
      return NOT_CONSTANT;
  }
  if (losesIntegerPrecision(op, left, right, value)) return NOT_CONSTANT;
  return spellable(value);
}

/**
 * `===` and `!==`, compared the way MongoDB compares.
 *
 * `$eq` looks at VALUES, so `[1,2] === [1,2]` is true on the server; JavaScript's
 * `===` looks at identity, and every literal this evaluator builds is a fresh
 * object, so it would answer false for every structural comparison there is.
 */
function strictEquality(op: string, left: unknown, right: unknown): Evaluation {
  const same = sameValue(left, right);
  return ok(op === "===" ? same : !same);
}

/** Structural equality — what `$eq`, `$in` and the set operators all use. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return Object.is(a, -0) === Object.is(b, -0);
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    if (Array.isArray(a) || Array.isArray(b)) return false;
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    // Key ORDER is part of a BSON document's identity, so it is part of this.
    return (
      ka.length === kb.length &&
      ka.every((k, i) => k === kb[i] && sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
    );
  }
  return false;
}

/**
 * `<` `>` `<=` `>=` — numbers or strings, and both sides the same kind.
 *
 * MongoDB compares ACROSS types by a total order of its own (a number sorts
 * before a string, always), which JavaScript does not have. Same-kind operands
 * are the region where the two agree — and for strings, only once the comparison
 * is done in code points. See `compareCodePoints`.
 */
function ordering(op: string, left: unknown, right: unknown): Evaluation {
  if (typeof left === "string" && typeof right === "string") {
    // MongoDB compares the UTF-8 bytes, which is CODE POINT order. JavaScript
    // compares UTF-16 units, and the two disagree for every character above
    // U+D7FF: the ﬁ ligature sorts above 😀 there and below it here.
    return orderingOf(op, compareCodePoints(left, right));
  }
  if (typeof left !== "number" || typeof right !== "number") return NOT_CONSTANT;
  return orderingOf(op, left < right ? -1 : left > right ? 1 : 0);
}

/** Code point by code point, which is also UTF-8 byte order. */
function compareCodePoints(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const p = x[i].codePointAt(0) as number;
    const q = y[i].codePointAt(0) as number;
    if (p !== q) return p < q ? -1 : 1;
  }
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}

function orderingOf(op: string, sign: number): Evaluation {
  switch (op) {
    case "<":
      return ok(sign < 0);
    case ">":
      return ok(sign > 0);
    case "<=":
      return ok(sign <= 0);
    case ">=":
      return ok(sign >= 0);
    default:
      return NOT_CONSTANT;
  }
}

/** Integer bitwise operators. MongoDB's are 64-bit; JavaScript's coerce to 32. */
function bitwise(op: string, left: unknown, right: unknown): Evaluation {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) return NOT_CONSTANT;
  const l = left as number;
  const r = right as number;
  // Outside the 32-bit range JavaScript wraps and MongoDB does not, so the two
  // only agree while both operands fit.
  const fits = (n: number): boolean => n >= -0x80000000 && n <= 0x7fffffff;
  if (!fits(l) || !fits(r)) return NOT_CONSTANT;
  switch (op) {
    case "&":
      return ok(l & r);
    case "|":
      return ok(l | r);
    case "^":
      return ok(l ^ r);
    default:
      return NOT_CONSTANT;
  }
}

function binary(op: string, left: unknown, right: unknown): Evaluation {
  switch (op) {
    case "+":
      return plus(left, right);
    case "-":
    case "*":
    case "/":
    case "%":
    case "**":
      return arithmetic(op, left, right);
    case "===":
    case "!==":
      return strictEquality(op, left, right);
    case "<":
    case ">":
    case "<=":
    case ">=":
      return ordering(op, left, right);
    case "&":
    case "|":
    case "^":
      return bitwise(op, left, right);
    case "&&":
    case "||":
      return logical(op, left, right);
    case "??":
      // The left was null, so the answer is the right one, whatever it is.
      return ok(right);
    case "in":
      return membership(left, right);
    default:
      // `==` and `!=` coerce by rules MongoDB does not share, so they never fold.
      return NOT_CONSTANT;
  }
}

/**
 * The answer a short-circuiting operator gives from its LEFT operand alone, or
 * null when it needs the right one too.
 *
 * Each of the three agrees with its MongoDB counterpart exactly here:
 *   false && x   the left operand, whatever `x` is
 *   true  || x   the left operand
 *   v ?? x       `$ifNull` returns the first non-null, and so does JavaScript
 * The remaining halves need the right operand, and are handled by `binary`.
 */
function decidedByLeft(op: string, left: unknown): Evaluation | null {
  if (op === "&&" && !truthy(left)) return ok(left);
  if (op === "||" && truthy(left)) return ok(left);
  if (op === "??" && left !== null && left !== undefined) return ok(left);
  return null;
}

/**
 * `&&` and `||` once the left operand did not decide it.
 *
 * Both yield an OPERAND, not a boolean — jsmql lowers them to JavaScript's own
 * truthiness, verified on the server: `0 || 5` is 5 and `1 && 2` is 2 there as
 * well as here. So `const timeout = envValue || 30000` folds, which is the shape
 * a developer actually writes.
 */
function logical(op: string, left: unknown, right: unknown): Evaluation {
  if (op === "&&") return truthy(left) ? ok(right) : ok(left);
  if (op === "||") return truthy(left) ? ok(left) : ok(right);
  return NOT_CONSTANT;
}

/** JavaScript's truthiness, which is what the lowering emits — measured. */
export const truthy = (v: unknown): boolean => Boolean(v);

/**
 * `x in [ … ]` is MEMBERSHIP in JSMQL — `$in` — and not JavaScript's key test.
 * The language settled that, so the fold answers the language's question.
 */
function membership(needle: unknown, haystack: unknown): Evaluation {
  if (!Array.isArray(haystack)) return NOT_CONSTANT;
  return ok(haystack.some((h) => sameValue(h, needle)));
}

function unary(op: string, operand: unknown): Evaluation {
  switch (op) {
    case "-":
      return typeof operand === "number" ? spellable(-operand) : NOT_CONSTANT;
    case "!":
      return typeof operand === "boolean" ? ok(!operand) : NOT_CONSTANT;
    case "~":
      return Number.isSafeInteger(operand) && Math.abs(operand as number) <= 0x7fffffff
        ? ok(~(operand as number))
        : NOT_CONSTANT;
    default:
      // `typeof` reports JavaScript's names, and MongoDB's `$type` reports its
      // own. Folding it would answer a different question from the runtime.
      return NOT_CONSTANT;
  }
}

// ── reading a constant structure ─────────────────────────────────────────────

/** A plain object — one whose own properties are all there is to it. */
const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  !(v instanceof Date) &&
  !(v instanceof RegExp) &&
  (v as { _bsontype?: unknown })._bsontype === undefined;

/**
 * `.length` — and on a STRING it is the code-point count, not JavaScript's.
 *
 * JSMQL lowers a string's `.length` to `$strLenCP`, so the language means code
 * points. JavaScript's `.length` counts UTF-16 units, and the two differ the
 * moment a character sits outside the basic plane: `"😀".length` is 2 there and
 * 1 here. The fold answers the LANGUAGE's question.
 */
function lengthOf(receiver: unknown): Evaluation {
  if (Array.isArray(receiver)) return ok(receiver.length);
  if (typeof receiver === "string") return ok([...receiver].length);
  return NOT_CONSTANT;
}

/**
 * `o.name` on a constant object.
 *
 * An ABSENT property does not fold. JavaScript answers `undefined` and MongoDB
 * answers missing, and those are not the same thing downstream — a missing field
 * disappears from a document while an explicit `undefined` does not.
 */
function property(receiver: unknown, name: string): Evaluation {
  if (name === "length") return lengthOf(receiver);
  if (!isPlain(receiver)) return NOT_CONSTANT;
  const own = Object.prototype.hasOwnProperty.call(receiver, name);
  return own ? ok(receiver[name]) : NOT_CONSTANT;
}

/**
 * `xs[i]`, `s[i]`, `o[k]` on a constant receiver.
 *
 * Out of range does not fold, for the same reason an absent property does not.
 * A NEGATIVE index never arrives: the language refuses it outright, because
 * JavaScript reads nothing there while `$arrayElemAt` counts from the end.
 */
function element(receiver: unknown, index: unknown): Evaluation {
  if (typeof index === "string") return property(receiver, index);
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) return NOT_CONSTANT;
  if (Array.isArray(receiver)) return index < receiver.length ? ok(receiver[index]) : NOT_CONSTANT;
  if (typeof receiver === "string") {
    const points = [...receiver];
    return index < points.length ? ok(points[index]) : NOT_CONSTANT;
  }
  return NOT_CONSTANT;
}

// ── applying a callback ──────────────────────────────────────────────────────

/**
 * Call a constant lambda on constant arguments.
 *
 * `[1, 2, 3, 4].filter(n => n % 2 === 0)` cannot fold without this: the callback
 * has to run. It runs the same way everything else here does — by evaluating its
 * body with the parameters bound — so a callback that reads the document, or
 * uses an operator this does not know, simply makes the whole call non-constant.
 *
 * A block body with declarations is honoured too, since `x => { const y = x * 2;
 * return y }` is an ordinary constant expression once `x` is known.
 */
export function applyLambda(lambda: Any, args: readonly unknown[], env: Constants, depth = 0): Evaluation {
  const params = lambda.params as readonly string[] | undefined;
  if (params === undefined) return NOT_CONSTANT;
  // A `stages` body is a pipeline, not a value.
  const body = lambda.body as Expr | undefined;
  if (body === undefined) return NOT_CONSTANT;

  const scope = new Map(env);
  for (let i = 0; i < params.length; i++) scope.set(params[i], args[i]);

  if ((body as Any).type === "ExprBlock") {
    const block = body as unknown as { decls: readonly Any[]; ret: Expr };
    for (const decl of block.decls) {
      const value = at(decl.value as Expr, scope, depth + 1);
      if (!value.ok) return propagate(value);
      scope.set(decl.name as string, value.value);
    }
    return at(block.ret, scope, depth + 1);
  }
  return at(body, scope, depth + 1);
}

type Any = { type: string } & Record<string, unknown>;

// ── the walk ─────────────────────────────────────────────────────────────────

/**
 * The static namespaces a call can be made on — `Math`, `Object`, `Date` — read
 * off the rows that say `provides`. A bare name, never a value; and never a list
 * here, so a new namespace is a row and folds on the day it lands.
 */
const NAMESPACES: ReadonlySet<string> = namespaceNames();

/**
 * One argument, ready for a fold rule: a value, or a callable made from a lambda.
 *
 * A callback that turns out not to be constant throws rather than returning, so
 * that `[1, 2].map(x => $.a)` fails the whole call from inside `Array.prototype.map`
 * — there is no way to answer "not constant" from within a JavaScript callback.
 */
function asArg(node: Expr, env: Constants, depth: number): Arg | null {
  if ((node as Any).type === "Lambda") {
    return {
      fn: (...args: unknown[]) => {
        const r = applyLambda(node as unknown as Any, args, env, depth + 1);
        if (!r.ok) throw r.unspellable !== undefined ? new UnspellableInCallback(r.unspellable) : NOT_CONSTANT_CALLBACK;
        return r.value;
      },
    };
  }
  const value = at(node, env, depth + 1);
  return value.ok ? { value: value.value } : null;
}

const NOT_CONSTANT_CALLBACK = Symbol("callback is not constant");

/** A callback whose body evaluated to a constant MongoDB cannot write down — `n => 10 / n` over a 0. */
class UnspellableInCallback {
  readonly what: string;
  constructor(what: string) {
    this.what = what;
  }
}

/** The registry family a runtime value belongs to, for reading a row's rules. */
function familyOfValue(value: unknown): Family | undefined {
  if (typeof value === "string") return "string";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return "number";
  if (value instanceof Date) return "date";
  if (value instanceof RegExp) return "regexp";
  if (typeof value === "object" && value !== null) return "object";
  return undefined;
}

/**
 * A method call on constants.
 *
 * Three gates before any rule runs, each closing a hole a fold can fall through.
 * The ARITY is checked from the row, so `'abc'.toUpperCase(1)` does not fold
 * away the error it should raise. Every rule runs inside a try/catch, so a
 * `RangeError` from a JavaScript built-in never reaches the user as a compile
 * error with no position. And the RESULT must be spellable, so `Infinity` and
 * `undefined` stay runtime instead of reaching the driver.
 */
function methodCall(node: Any, env: Constants, depth: number): Evaluation {
  const name = node.name as string;
  const argNodes = node.args as readonly Expr[];
  if (argNodes.some((a) => (a as Any).type === "SpreadElement")) return NOT_CONSTANT;

  // The receiver decides which of the row's counts applies, so it is resolved
  // before the arity is checked.
  const receiverNode = node.object as Any;
  const onNamespace = receiverNode.type === "Ident" && NAMESPACES.has(receiverNode.name as string);
  let receiverValue: unknown;
  if (!onNamespace) {
    const receiver = at(receiverNode as unknown as Expr, env, depth + 1);
    if (!receiver.ok) return propagate(receiver);
    receiverValue = receiver.value;
  }
  const family = onNamespace ? (receiverNode.name as Family) : familyOfValue(receiverValue);
  // `"abc".length()` is a CALL of a name the row says is READ, and no fold may
  // answer it — the row's `call: false` is the one fact that separates the two.
  if (!isCallable(name)) return NOT_CONSTANT;
  if (!acceptsArgumentCount(name, argNodes.length, family)) return NOT_CONSTANT;

  const args: Arg[] = [];
  for (const argNode of argNodes) {
    const arg = asArg(argNode, env, depth);
    if (arg === null) return NOT_CONSTANT;
    args.push(arg);
  }

  let result: Evaluation;
  try {
    result = onNamespace
      ? foldNamespaceCall(receiverNode.name as string, name, args)
      : foldInstanceCall(receiverValue, name, args);
  } catch (e) {
    // A non-constant callback, a value with no key spelling, or a built-in that
    // threw. None of them fold; none of them are errors here —
    // except a callback whose answer has no literal, which is worth saying.
    if (e instanceof UnspellableInCallback) return unspellable(e.what);
    return NOT_CONSTANT;
  }
  if (!result.ok) return propagate(result);
  if (!withinSize(result.value)) return NOT_CONSTANT;
  return spellable(result.value);
}

/** Apply a lambda to constant arguments, with the same gates a rule gets. */
function applyHere(lambda: Any, argNodes: readonly Expr[], env: Constants, depth: number): Evaluation {
  if (argNodes.some((a) => (a as Any).type === "SpreadElement")) return NOT_CONSTANT;
  const values: unknown[] = [];
  for (const argNode of argNodes) {
    const value = at(argNode, env, depth + 1);
    if (!value.ok) return propagate(value);
    values.push(value.value);
  }
  const result = applyLambda(lambda, values, env, depth + 1);
  if (!result.ok) return propagate(result);
  if (!withinSize(result.value)) return NOT_CONSTANT;
  return spellable(result.value);
}

/**
 * Evaluate a call's arguments and hand them to a rule, with the same three gates
 * a method call gets: no spread, every rule inside a try/catch, and a result that
 * has to be spellable and of a sane size.
 */
function applyCall(
  argNodes: readonly Expr[],
  env: Constants,
  depth: number,
  run: (args: readonly Arg[]) => Evaluation,
): Evaluation {
  if (argNodes.some((a) => (a as Any).type === "SpreadElement")) return NOT_CONSTANT;
  const args: Arg[] = [];
  for (const argNode of argNodes) {
    const arg = asArg(argNode, env, depth);
    if (arg === null) return NOT_CONSTANT;
    args.push(arg);
  }
  let result: Evaluation;
  try {
    result = run(args);
  } catch (e) {
    if (e instanceof UnspellableInCallback) return unspellable(e.what);
    return NOT_CONSTANT;
  }
  if (!result.ok) return propagate(result);
  if (!withinSize(result.value)) return NOT_CONSTANT;
  return spellable(result.value);
}

/** The value of `node`, given the constants already known. */
export function evaluate(node: Expr, env: Constants): Evaluation {
  return at(node, env, 0);
}

function at(node: Expr, env: Constants, depth: number): Evaluation {
  if (depth > MAX_DEPTH) return NOT_CONSTANT;
  // `"$s"` typed in source IS the field `s` (HR1): as an OPERAND it is a value read
  // at run time, and `"$s".trim()` or `"$s" + "x"` must not settle to a string.
  if (depth > 0 && node.type === "StringLiteral" && node.value.startsWith("$")) return NOT_CONSTANT;
  const literal = readLiteral(node);
  if (literal.ok) return literal;

  // a value a call supplied is a constant — unless it reads as MQL, which must never fold into a spelling the emit would read as an operator
  if (node.type === "Injected") return isMqlShaped(node.value) ? NOT_CONSTANT : ok(node.value);
  switch (node.type) {
    case "Ident":
      return env.has(node.name) ? ok(env.get(node.name)) : NOT_CONSTANT;

    case "ArrayLiteral": {
      const out: unknown[] = [];
      for (const element of node.elements) {
        if (element.type === "SpreadElement") {
          const spread = at(element.argument, env, depth + 1);
          if (!spread.ok) return propagate(spread);
          if (!Array.isArray(spread.value)) return NOT_CONSTANT;
          out.push(...spread.value);
          continue;
        }
        // A declaration or a write inside a literal makes it a pipeline, not a
        // value — and `UpdateFilter` is how a `,`-joined run of writes arrives.
        if (element.type === "LetDecl" || element.type === "FuncDecl") return NOT_CONSTANT;
        if (element.type === "AssignExpr" || element.type === "DeleteStmt") return NOT_CONSTANT;
        if (element.type === "UpdateFilter") return NOT_CONSTANT;
        const value = at(element, env, depth + 1);
        if (!value.ok) return propagate(value);
        out.push(value.value);
      }
      return spellable(out);
    }

    case "ObjectLiteral": {
      const out: Record<string, unknown> = {};
      for (const entry of node.entries) {
        if (entry.type === "SpreadElement") {
          const spread = at(entry.argument, env, depth + 1);
          if (!spread.ok) return propagate(spread);
          if (spread.value === null || typeof spread.value !== "object") return NOT_CONSTANT;
          Object.assign(out, spread.value);
          continue;
        }
        const key = entry.key;
        let name: string;
        if (key.kind === "static") {
          name = key.name;
        } else {
          const computed = at(key.expr, env, depth + 1);
          if (!computed.ok) return propagate(computed);
          if (typeof computed.value !== "string") return NOT_CONSTANT;
          name = computed.value;
        }
        const value = at(entry.value, env, depth + 1);
        if (!value.ok) return propagate(value);
        setKey(out, name, value.value);
      }
      return ok(out);
    }

    case "TemplateLiteral": {
      const parts = all(node.exprs, env, depth);
      if (!Array.isArray(parts)) return parts;
      // Strings, and the numbers `$toString` writes as JavaScript does — see
      // `numberSpelling`. Any other interpolation stays runtime.
      const spelled = parts.map((p) => (typeof p === "string" ? p : typeof p === "number" ? numberSpelling(p) : null));
      if (spelled.some((p) => p === null)) return NOT_CONSTANT;
      let out = node.quasis[0] ?? "";
      for (let i = 0; i < spelled.length; i++) out += (spelled[i] as string) + (node.quasis[i + 1] ?? "");
      return spellable(out);
    }

    case "UnaryExpr": {
      const operand = at(node.argument, env, depth + 1);
      return operand.ok ? unary(node.op, operand.value) : propagate(operand);
    }

    case "BinaryExpr": {
      const left = at(node.left, env, depth + 1);
      if (!left.ok) return propagate(left);
      // Three operators decide on the left alone, and the right may be anything
      // at all — including something this cannot evaluate.
      const shortCircuit = decidedByLeft(node.op, left.value);
      if (shortCircuit !== null) return shortCircuit;
      const right = at(node.right, env, depth + 1);
      if (!right.ok) return propagate(right);
      return binary(node.op, left.value, right.value);
    }

    case "TernaryExpr": {
      const test = at(node.test, env, depth + 1);
      if (!test.ok) return propagate(test);
      if (typeof test.value !== "boolean") return NOT_CONSTANT;
      return at(test.value ? node.consequent : node.alternate, env, depth + 1);
    }

    case "MemberAccess": {
      // `Math.PI` reads a namespace, which is a name and not a value.
      const on = node.object as unknown as Any;
      if (on.type === "Ident" && NAMESPACES.has(on.name as string) && !env.has(on.name as string)) {
        return foldNamespaceConstant(on.name as string, node.name);
      }
      // `?.` reads the same on a value that is present, and a constant is.
      const receiver = at(node.object, env, depth + 1);
      return receiver.ok ? property(receiver.value, node.name) : propagate(receiver);
    }

    case "IndexAccess": {
      const receiver = at(node.object, env, depth + 1);
      if (!receiver.ok) return propagate(receiver);
      const index = at(node.index, env, depth + 1);
      return index.ok ? element(receiver.value, index.value) : propagate(index);
    }

    case "MethodCall":
      return methodCall(node as unknown as Any, env, depth);

    case "CallExpression": {
      const callee = node.callee as unknown as Any;
      // `((a) => a * 2)(3)` — a lambda applied where it stands.
      if (callee.type === "Lambda") return applyHere(callee, node.args as readonly Expr[], env, depth);
      if (callee.type !== "Ident" || typeof callee.name !== "string") return NOT_CONSTANT;
      const bound = env.get(callee.name as string);
      // `function double(x) { … }` then `double(3)` — a declared function called
      // with constants is a constant, and the declaration itself emits nothing.
      if (isDeclaredFunction(bound)) {
        return applyHere(bound.lambda as Any, node.args as readonly Expr[], env, depth);
      }
      // A binding that holds a VALUE is not callable, and shadows the global name.
      if (env.has(callee.name as string)) return NOT_CONSTANT;
      // `String(42)`, `Number("42")`, `ObjectId("<24 hex>")` — a named conversion.
      // Gated by the row's count like a method call: `String("a", "b")` must reach
      // the error it deserves rather than fold to "a".
      if (!acceptsArgumentCount(callee.name as string, node.args.length)) return NOT_CONSTANT;
      return applyCall(node.args as readonly Expr[], env, depth, (args) => foldNamedCall(callee.name as string, args));
    }

    case "NewExpression": {
      const callee = node.callee as unknown as Any;
      if (callee.type !== "Ident" || typeof callee.name !== "string") return NOT_CONSTANT;
      if (env.has(callee.name as string)) return NOT_CONSTANT;
      if (!acceptsArgumentCount(callee.name as string, node.args.length)) return NOT_CONSTANT;
      return applyCall(node.args as readonly Expr[], env, depth, (args) =>
        foldConstructor(callee.name as string, args),
      );
    }

    default:
      return NOT_CONSTANT;
  }
}
