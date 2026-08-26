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
import { isSpellable, readLiteral } from "./literal.ts";
import type { Arg } from "./fold-methods.ts";
import { foldInstanceCall, foldNamespaceCall, foldNamespaceConstant } from "./fold-methods.ts";
import type { Family } from "../../registry/vocabulary.ts";
import { acceptsArgumentCount } from "../rows.ts";

/** What is known so far: a name bound to a constant. */
export type Constants = ReadonlyMap<string, unknown>;

export type Evaluation = { ok: true; value: unknown } | { ok: false };

const NOT_CONSTANT: Evaluation = { ok: false };
const ok = (value: unknown): Evaluation => ({ ok: true, value });

/** Every operand of a list, or nothing if any one of them is not constant. */
function all(nodes: readonly Expr[], env: Constants): unknown[] | null {
  const out: unknown[] = [];
  for (const node of nodes) {
    const r = evaluate(node, env);
    if (!r.ok) return null;
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
    return losesIntegerPrecision("+", left, right, sum) ? NOT_CONSTANT : ok(sum);
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
  // `Infinity` and `NaN` come back as VALUES even though MongoDB has no literal
  // for either. Deciding what to do about that is the pass's job, not this one's:
  // "not a constant" and "a constant nothing can spell" want different messages,
  // and only one of them is worth telling the user about.
  return ok(value);
}

/** `===` and `!==`. Deliberately NOT `==`: see `looseEquality` below. */
function strictEquality(op: string, left: unknown, right: unknown): Evaluation {
  const same = left === right;
  return ok(op === "===" ? same : !same);
}

/**
 * `<` `>` `<=` `>=` — numbers or strings, and both sides the same kind.
 *
 * MongoDB compares ACROSS types by a total order of its own (a number sorts
 * before a string, always), which JavaScript does not have. Same-kind operands
 * are the region where the two agree.
 */
function ordering(op: string, left: unknown, right: unknown): Evaluation {
  const comparable =
    (typeof left === "number" && typeof right === "number") || (typeof left === "string" && typeof right === "string");
  if (!comparable) return NOT_CONSTANT;
  const l = left as number;
  const r = right as number;
  switch (op) {
    case "<":
      return ok(l < r);
    case ">":
      return ok(l > r);
    case "<=":
      return ok(l <= r);
    case ">=":
      return ok(l >= r);
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
 *   false && x   both false, whatever `x` is
 *   true  || x   both true
 *   v ?? x       `$ifNull` returns the first non-null, and so does JavaScript
 * The remaining halves need the right operand, and are handled by `binary`.
 */
function decidedByLeft(op: string, left: unknown): Evaluation | null {
  if (op === "&&" && left === false) return ok(false);
  if (op === "||" && left === true) return ok(true);
  if (op === "??" && left !== null && left !== undefined) return ok(left);
  return null;
}

/**
 * `&&` and `||` once the left operand did not decide it.
 *
 * JavaScript yields an OPERAND and MongoDB's `$and`/`$or` yield a boolean, so
 * the two agree only where that operand is already a boolean: `true && 2` is `2`
 * in JavaScript and `true` in MongoDB.
 */
function logical(op: string, left: unknown, right: unknown): Evaluation {
  if (typeof right !== "boolean") return NOT_CONSTANT;
  if (op === "&&") return left === true ? ok(right) : NOT_CONSTANT;
  if (op === "||") return left === false ? ok(right) : NOT_CONSTANT;
  return NOT_CONSTANT;
}

/**
 * `x in [ … ]` is MEMBERSHIP in JSMQL — `$in` — and not JavaScript's key test.
 * The language settled that, so the fold answers the language's question.
 */
function membership(needle: unknown, haystack: unknown): Evaluation {
  if (!Array.isArray(haystack)) return NOT_CONSTANT;
  return ok(haystack.includes(needle));
}

function unary(op: string, operand: unknown): Evaluation {
  switch (op) {
    case "-":
      return typeof operand === "number" ? ok(-operand) : NOT_CONSTANT;
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
export function applyLambda(lambda: Any, args: readonly unknown[], env: Constants): Evaluation {
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
      const value = evaluate(decl.value as Expr, scope);
      if (!value.ok) return NOT_CONSTANT;
      scope.set(decl.name as string, value.value);
    }
    return evaluate(block.ret, scope);
  }
  return evaluate(body, scope);
}

type Any = { type: string } & Record<string, unknown>;

// ── the walk ─────────────────────────────────────────────────────────────────

/** The static namespaces a call can be made on. A bare name, never a value. */
const NAMESPACES: ReadonlySet<string> = new Set(["Math", "Object", "Number", "Date", "Array", "String", "Boolean"]);

/**
 * One argument, ready for a fold rule: a value, or a callable made from a lambda.
 *
 * A callback that turns out not to be constant throws rather than returning, so
 * that `[1, 2].map(x => $.a)` fails the whole call from inside `Array.prototype.map`
 * — there is no way to answer "not constant" from within a JavaScript callback.
 */
function asArg(node: Expr, env: Constants): Arg | null {
  if ((node as Any).type === "Lambda") {
    return {
      fn: (...args: unknown[]) => {
        const r = applyLambda(node as unknown as Any, args, env);
        if (!r.ok) throw NOT_CONSTANT_CALLBACK;
        return r.value;
      },
    };
  }
  const value = evaluate(node, env);
  return value.ok ? { value: value.value } : null;
}

const NOT_CONSTANT_CALLBACK = Symbol("callback is not constant");

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
 * Three gates before any rule runs, and each closes a hole the shipped compiler
 * has. The ARITY is checked from the row, so `'abc'.toUpperCase(1)` does not fold
 * away the error it should raise. Every rule runs inside a try/catch, so a
 * `RangeError` from a JavaScript built-in never reaches the user as a compile
 * error with no position. And the RESULT must be spellable, so `Infinity` and
 * `undefined` stay runtime instead of reaching the driver.
 */
function methodCall(node: Any, env: Constants): Evaluation {
  const name = node.name as string;
  const argNodes = node.args as readonly Expr[];
  if (argNodes.some((a) => (a as Any).type === "SpreadElement")) return NOT_CONSTANT;

  // The receiver decides which of the row's counts applies, so it is resolved
  // before the arity is checked.
  const receiverNode = node.object as Any;
  const onNamespace = receiverNode.type === "Ident" && NAMESPACES.has(receiverNode.name as string);
  let receiverValue: unknown;
  if (!onNamespace) {
    const receiver = evaluate(receiverNode as unknown as Expr, env);
    if (!receiver.ok) return NOT_CONSTANT;
    receiverValue = receiver.value;
  }
  const family = onNamespace ? (receiverNode.name as Family) : familyOfValue(receiverValue);
  if (!acceptsArgumentCount(name, argNodes.length, family)) return NOT_CONSTANT;

  const args: Arg[] = [];
  for (const argNode of argNodes) {
    const arg = asArg(argNode, env);
    if (arg === null) return NOT_CONSTANT;
    args.push(arg);
  }

  let result: Evaluation;
  try {
    result = onNamespace
      ? foldNamespaceCall(receiverNode.name as string, name, args)
      : foldInstanceCall(receiverValue, name, args);
  } catch {
    // A non-constant callback, a predicate that did not answer with a boolean,
    // or a built-in that threw. None of them fold; none of them are errors here.
    return NOT_CONSTANT;
  }
  if (!result.ok) return NOT_CONSTANT;
  return isSpellable(result.value) ? result : NOT_CONSTANT;
}

/** The value of `node`, given the constants already known. */ /** The value of `node`, given the constants already known. */
export function evaluate(node: Expr, env: Constants): Evaluation {
  const literal = readLiteral(node);
  if (literal.ok) return literal;

  switch (node.type) {
    case "Ident":
      return env.has(node.name) ? ok(env.get(node.name)) : NOT_CONSTANT;

    case "ArrayLiteral": {
      const out: unknown[] = [];
      for (const element of node.elements) {
        if (element.type === "SpreadElement") {
          const spread = evaluate(element.argument, env);
          if (!spread.ok || !Array.isArray(spread.value)) return NOT_CONSTANT;
          out.push(...spread.value);
          continue;
        }
        // A declaration or a write inside a literal makes it a pipeline, not a
        // value — and `UpdateFilter` is how a `,`-joined run of writes arrives.
        if (element.type === "LetDecl" || element.type === "FuncDecl") return NOT_CONSTANT;
        if (element.type === "AssignExpr" || element.type === "DeleteStmt") return NOT_CONSTANT;
        if (element.type === "UpdateFilter") return NOT_CONSTANT;
        const value = evaluate(element, env);
        if (!value.ok) return NOT_CONSTANT;
        out.push(value.value);
      }
      return ok(out);
    }

    case "ObjectLiteral": {
      const out: Record<string, unknown> = {};
      for (const entry of node.entries) {
        if (entry.type === "SpreadElement") {
          const spread = evaluate(entry.argument, env);
          if (!spread.ok || spread.value === null || typeof spread.value !== "object") return NOT_CONSTANT;
          Object.assign(out, spread.value);
          continue;
        }
        const key = entry.key;
        let name: string;
        if (key.kind === "static") {
          name = key.name;
        } else {
          const computed = evaluate(key.expr, env);
          if (!computed.ok || typeof computed.value !== "string") return NOT_CONSTANT;
          name = computed.value;
        }
        const value = evaluate(entry.value, env);
        if (!value.ok) return NOT_CONSTANT;
        out[name] = value.value;
      }
      return ok(out);
    }

    case "TemplateLiteral": {
      const parts = all(node.exprs, env);
      if (parts === null) return NOT_CONSTANT;
      // Only the kinds MongoDB's `$concat` would also join without complaint.
      if (!parts.every((p) => typeof p === "string" || typeof p === "number")) return NOT_CONSTANT;
      let out = node.quasis[0] ?? "";
      for (let i = 0; i < parts.length; i++) out += String(parts[i]) + (node.quasis[i + 1] ?? "");
      return ok(out);
    }

    case "UnaryExpr": {
      const operand = evaluate(node.argument, env);
      return operand.ok ? unary(node.op, operand.value) : NOT_CONSTANT;
    }

    case "BinaryExpr": {
      const left = evaluate(node.left, env);
      if (!left.ok) return NOT_CONSTANT;
      // Three operators decide on the left alone, and the right may be anything
      // at all — including something this cannot evaluate.
      const shortCircuit = decidedByLeft(node.op, left.value);
      if (shortCircuit !== null) return shortCircuit;
      const right = evaluate(node.right, env);
      if (!right.ok) return NOT_CONSTANT;
      return binary(node.op, left.value, right.value);
    }

    case "TernaryExpr": {
      const test = evaluate(node.test, env);
      if (!test.ok || typeof test.value !== "boolean") return NOT_CONSTANT;
      return evaluate(test.value ? node.consequent : node.alternate, env);
    }

    case "MemberAccess": {
      // `Math.PI` reads a namespace, which is a name and not a value.
      const on = node.object as unknown as Any;
      if (on.type === "Ident" && NAMESPACES.has(on.name as string) && !env.has(on.name as string)) {
        return foldNamespaceConstant(on.name as string, node.name);
      }
      // `?.` reads the same on a value that is present, and a constant is.
      const receiver = evaluate(node.object, env);
      return receiver.ok ? property(receiver.value, node.name) : NOT_CONSTANT;
    }

    case "IndexAccess": {
      const receiver = evaluate(node.object, env);
      if (!receiver.ok) return NOT_CONSTANT;
      const index = evaluate(node.index, env);
      return index.ok ? element(receiver.value, index.value) : NOT_CONSTANT;
    }

    case "MethodCall":
      return methodCall(node as unknown as Any, env);

    default:
      return NOT_CONSTANT;
  }
}
