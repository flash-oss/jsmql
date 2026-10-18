// The constant engine. It takes an expression and the constants already known, and
// answers with a VALUE or with "not a constant".
//
// A constant is an expression whose LOWERED MQL reads nothing from the document and
// nothing from the environment. So the engine does not compute: it lowers the closed
// subtree with the real emitter, gives the MQL to the interpreter, and answers with the
// value. One semantics per JavaScript method (its lowering) and one rule per MQL
// operator (src/compiler/interpret/) replace a hand-written twin of each method.
//
// THE ONE INVARIANT: a fold must not change the answer. The interpreter refuses where the
// server answer is not exactly specified, and a refusal is never a failure. The
// expression then stays a runtime expression, as with no fold at all.
//
// See docs/specs/constant-engine.md.

import type { Expr, Lambda } from "../../registry/ast.ts";
import { isFieldPathString } from "../../registry/ast.ts";
import { internalError } from "../../errors.ts";
import { isObjectId, objectIdHex } from "../../bson.ts";
import { ParseError } from "../parse/cursor.ts";
import { objectIdTypo } from "../objectid-guard.ts";
import { interpret } from "../interpret/index.ts";
import { isGlobalName } from "../rows.ts";
import { applyRules } from "./desugar-rules.ts";
import { isMqlShaped } from "./inject.ts";
import { readDateLiteral } from "./date-literal.ts";
import { nodeOf, readLiteral } from "./literal.ts";
import { bindsFor } from "./naming.ts";
import { VALUE } from "./position.ts";
import { substitute } from "./substitute.ts";
import { mapTree, mapTreeIn } from "./walk.ts";

/** What is known so far: a name bound to a constant, or to a declared function. */
export type Constants = ReadonlyMap<string, unknown>;

/**
 * A declared function, held so a CALL to it can be evaluated.
 *
 * The wrapper exists so this is never mistaken for a value: a function has no
 * MongoDB literal, and substituting one into the tree would put a lambda where
 * an expression belongs. For this reason, `fold` keeps these in the
 * environment and out of the substitution map.
 */
export type DeclaredFunction = { readonly lambda: object };

export const asDeclaredFunction = (lambda: object): DeclaredFunction => ({ lambda });

const isDeclaredFunction = (v: unknown): v is DeclaredFunction =>
  typeof v === "object" && v !== null && "lambda" in v && Object.keys(v).length === 1;

/**
 * A value, or the reason there is none.
 *
 * `unspellable` is the third state. It exists because "this is not a constant"
 * and "this IS a constant that MongoDB cannot write down" need different
 * outcomes. It PROPAGATES: an `Infinity` that reaches an operator poisons
 * everything built from it, so `1 / 0 > 0` does not quietly become `true`
 * while the server refuses the division outright.
 */
export type Evaluation = { ok: true; value: unknown } | { ok: false; unspellable?: string };

const NOT_CONSTANT: Evaluation = { ok: false };
const ok = (value: unknown): Evaluation => ({ ok: true, value });

// ── the provided lowering ────────────────────────────────────────────────────────

/**
 * The lowering of a closed expression to MQL, with each declared function bound the way the
 * emitter binds a declaration. A throw means "not constant".
 */
type Lowering = (node: Expr, functions: ReadonlyMap<string, Lambda>) => unknown;

/**
 * The emitter provides its lowering at load (`provideLowering`, called from emit/lower.ts).
 * The module cannot import it, because the emitter reads this module: the
 * emit phase reads constants, and this module needs the emit phase to answer.
 */
let lowering: Lowering | null = null;
export function provideLowering(lower: Lowering): void {
  lowering = lower;
}

// ── the write-back ───────────────────────────────────────────────────────────

/**
 * The node that carries a computed value: the literal that spells it, or an `Injected` node
 * that holds it. An ObjectId must be one that could exist, the same plausibility rule that a
 * literal has, so a typo reports at its position. A constant is a whole value that JSMQL
 * owns, so its strings are text (HR6).
 */
export function writeBack(value: unknown, pos: number): Expr {
  if (isObjectId(value)) {
    const hex = objectIdHex(value);
    const typo = hex === null ? null : objectIdTypo(hex);
    if (typo !== null) throw new ParseError(typo, pos);
  }
  return nodeOf(value, pos, true);
}

/**
 * `node` with its constant settled. The fold settles every node of the program. A node that
 * a lowering builds itself, such as `list.map(key)` from the arguments of a cell, is a node that
 * the fold does not visit, so the services that hand a node to the lowering call this function.
 */
export function settled(node: Expr): Expr {
  if (constantOf(node).ok) return node;
  const result = evaluate(node, new Map());
  return result.ok ? writeBack(result.value, node.pos) : node;
}

// ── limits ───────────────────────────────────────────────────────────────────

/** How deep a subtree may nest before the engine stops asking. */
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

// ── reading a constant that is already in the tree ───────────────────────────

/**
 * The value that a tree of literals holds, with no lowering and no environment: a
 * literal, an `Injected` node that does not read as MQL, and a list or a document of such
 * values. The fold writes every constant it computes back as one of these, so a reader
 * after the fold asks this function. A `"$…"` string below the top is a field path
 * (HR1), so it holds no value.
 */
export function constantOf(node: Expr): Evaluation {
  return read(node, 0);
}

function read(node: Expr, depth: number): Evaluation {
  if (depth > MAX_DEPTH) return NOT_CONSTANT;
  if (depth > 0 && isFieldPathString(node)) return NOT_CONSTANT;
  const literal = readLiteral(node);
  if (literal.ok) return literal;
  switch (node.type) {
    case "Injected":
      return isMqlShaped(node.value) ? NOT_CONSTANT : ok(node.value);
    case "UnaryExpr":
      // `-5n` is a BigInt literal that the source spells. The lowering would multiply a Long
      // by -1, and the interpreter computes with no Long.
      return node.op === "-" && node.argument.type === "BigIntLiteral"
        ? ok(-BigInt(node.argument.value))
        : NOT_CONSTANT;
    case "ArrayLiteral": {
      const out: unknown[] = [];
      for (const element of node.elements) {
        if (!isElement(element)) return NOT_CONSTANT;
        const v = read(element, depth + 1);
        if (!v.ok) return NOT_CONSTANT;
        out.push(v.value);
      }
      return ok(out);
    }
    case "ObjectLiteral": {
      const out: Record<string, unknown> = {};
      for (const entry of node.entries) {
        if (entry.type !== "KeyValueEntry" || entry.key.kind !== "static") return NOT_CONSTANT;
        const v = read(entry.value, depth + 1);
        if (!v.ok) return NOT_CONSTANT;
        out[entry.key.name] = v.value;
      }
      return ok(out);
    }
    default:
      return NOT_CONSTANT;
  }
}

/** An element that is an expression, and not a spread, a declaration or a write. */
const isElement = (e: { type: string }): e is Expr =>
  e.type !== "SpreadElement" &&
  e.type !== "FuncDecl" &&
  e.type !== "AssignExpr" &&
  e.type !== "DeleteStmt" &&
  e.type !== "UpdateFilter";

// ── the scan ─────────────────────────────────────────────────────────────────

type Any = { type: string } & Record<string, unknown>;

/** What travels down the tree during the scan: the names bound so far, and whether a block's declaration list is next. */
type Scope = { bound: ReadonlySet<string>; declaring: boolean; depth: number };

/**
 * Does the subtree read something that a constant never reads? The document and the
 * streams (`$`, `$$`, `$$$`, `$$$$`), a name that nothing binds, and an operator call: it is the
 * developer's own MQL, and HR2 says it never folds, even inside. A declaration, a write
 * and a pipeline are statements, and none of them is a value.
 *
 * A name counts as bound when `env` holds it, a lambda in the subtree binds it, or it is a
 * global (`Math`, `String`) that a row declares. The lambda names come from `bindsFor`.
 */
function readsMoreThanConstants(node: Expr, env: Constants): boolean {
  let refused = node.type === "Lambda";
  const step = (n: object, key: string, here: Scope): Scope => {
    const names = bindsFor(n, key);
    const type = (n as Any).type;
    const declaring = type === "ExprBlock" && key === "decls";
    const bound = names.length === 0 ? here.bound : new Set([...here.bound, ...names]);
    return { bound, declaring, depth: here.depth + 1 };
  };
  mapTreeIn(node as object, { bound: new Set<string>(), declaring: false, depth: 0 }, step, (n, here) => {
    if (refused) return n;
    const x = n as Any;
    switch (x.type) {
      case "FieldRef":
      case "StreamRef":
      case "DatabaseRef":
      case "ClusterRef":
      case "OperatorCall":
      case "AssignExpr":
      case "DeleteStmt":
      case "UpdateFilter":
      case "FuncDecl":
      case "Pipeline":
        refused = true;
        break;
      case "LetDecl":
        // A callback's block holds declarations, and each one is a value there.
        if (!here.declaring) refused = true;
        break;
      case "Ident": {
        const name = x.name as string;
        if (!here.bound.has(name) && !env.has(name) && !isGlobalName(name)) refused = true;
        break;
      }
      case "StringLiteral":
        if (isFieldPathString(x as Expr & { type: "StringLiteral" })) refused = true;
        break;
      case "Injected":
        if (isMqlShaped(x.value)) refused = true;
        break;
    }
    if (here.depth > MAX_DEPTH) refused = true;
    return n;
  });
  return refused;
}

// ── the engine ───────────────────────────────────────────────────────────────

/**
 * The value of `node`, given the constants already known.
 *
 *   1. A literal, a date that the source spells with literal parts, or a value a call
 *      supplied, is its own value.
 *   2. The scan refuses a subtree that reads more than constants.
 *   3. A name that `env` binds to a value becomes that value. A name bound to a declared
 *      function stays, and goes to the lowering as a function.
 *   4. The settled check refuses a subtree that a desugar rule would still rewrite.
 *      The next round of the fixpoint asks again.
 *   5. The emitter lowers the subtree. A throw means "not constant": the emit phase
 *      reports the error later, at the real site, with the real position.
 *   6. The interpreter gives the value of the MQL, or refuses it, or says that the value has
 *      no literal.
 */
export function evaluate(node: Expr, env: Constants): Evaluation {
  // 1
  const known = constantOf(node);
  if (known.ok) return known;
  if (node.type === "Injected") return NOT_CONSTANT;
  // A date that the source spells with literal parts: the server cannot compute some of them.
  const date = readDateLiteral(node, (name) => env.has(name));
  if (date.ok) return ok(date.value);
  // A tree nested deeper than the stack allows is not a constant worth the walk.
  try {
    return settle(node, env);
  } catch (e) {
    if (e instanceof RangeError) return NOT_CONSTANT;
    throw e;
  }
}

/** Steps 2 to 6 of `evaluate`. */
function settle(node: Expr, env: Constants): Evaluation {
  // 2
  if (readsMoreThanConstants(node, env)) return NOT_CONSTANT;
  // 3
  const values = new Map<string, unknown>();
  const functions = new Map<string, Lambda>();
  for (const [name, held] of env) {
    if (isDeclaredFunction(held)) functions.set(name, held.lambda as Lambda);
    else values.set(name, held);
  }
  // A date that the source spells inside the subtree is a value before the lowering: see step 1.
  const spelled = mapTree(substitute(node, values), (n) => {
    const date = readDateLiteral(n as Expr, (name) => env.has(name));
    return date.ok ? (nodeOf(date.value, (n as { pos: number }).pos) as object) : n;
  });
  const closed = spelled;
  // 4
  if (applyRules(closed, VALUE) !== closed) return NOT_CONSTANT;
  // 5
  if (lowering === null) internalError("emit/lower.ts did not lend the lowering before the fold read it");
  let mql: unknown;
  try {
    mql = lowering(closed, functions);
  } catch {
    return NOT_CONSTANT;
  }
  // 6
  const result = interpret(mql);
  if (!result.ok)
    return result.unspellable === undefined ? NOT_CONSTANT : { ok: false, unspellable: result.unspellable };
  return withinSize(result.value) ? ok(result.value) : NOT_CONSTANT;
}
