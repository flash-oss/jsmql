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

export type Constants = ReadonlyMap<string, unknown>;

export type DeclaredFunction = { readonly lambda: object };

export const asDeclaredFunction = (lambda: object): DeclaredFunction => ({ lambda });

const isDeclaredFunction = (v: unknown): v is DeclaredFunction =>
  typeof v === "object" && v !== null && "lambda" in v && Object.keys(v).length === 1;

export type Evaluation = { ok: true; value: unknown } | { ok: false; unspellable?: string };

const NOT_CONSTANT: Evaluation = { ok: false };
const ok = (value: unknown): Evaluation => ({ ok: true, value });

type Lowering = (node: Expr, functions: ReadonlyMap<string, Lambda>) => unknown;

let lowering: Lowering | null = null;
export function provideLowering(lower: Lowering): void {
  lowering = lower;
}

export function writeBack(value: unknown, pos: number): Expr {
  if (isObjectId(value)) {
    const hex = objectIdHex(value);
    const typo = hex === null ? null : objectIdTypo(hex);
    if (typo !== null) throw new ParseError(typo, pos);
  }
  return nodeOf(value, pos, true);
}

export function settled(node: Expr): Expr {
  if (constantOf(node).ok) return node;
  const result = evaluate(node, new Map());
  return result.ok ? writeBack(result.value, node.pos) : node;
}

const MAX_DEPTH = 400;

const MAX_SIZE = 1_000_000;

function withinSize(value: unknown): boolean {
  if (typeof value === "string") return value.length <= MAX_SIZE;
  if (Array.isArray(value)) return value.length <= MAX_SIZE && value.every(withinSize);
  return true;
}

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

const isElement = (e: { type: string }): e is Expr =>
  e.type !== "SpreadElement" &&
  e.type !== "FuncDecl" &&
  e.type !== "AssignExpr" &&
  e.type !== "DeleteStmt" &&
  e.type !== "UpdateFilter";

type Any = { type: string } & Record<string, unknown>;

type Scope = { bound: ReadonlySet<string>; declaring: boolean; depth: number };

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

export function evaluate(node: Expr, env: Constants): Evaluation {
  const known = constantOf(node);
  if (known.ok) return known;
  if (node.type === "Injected") return NOT_CONSTANT;
  const date = readDateLiteral(node, (name) => env.has(name));
  if (date.ok) return ok(date.value);
  try {
    return settle(node, env);
  } catch (e) {
    if (e instanceof RangeError) return NOT_CONSTANT;
    throw e;
  }
}

function settle(node: Expr, env: Constants): Evaluation {
  if (readsMoreThanConstants(node, env)) return NOT_CONSTANT;
  const values = new Map<string, unknown>();
  const functions = new Map<string, Lambda>();
  for (const [name, held] of env) {
    if (isDeclaredFunction(held)) functions.set(name, held.lambda as Lambda);
    else values.set(name, held);
  }
  const spelled = mapTree(substitute(node, values), (n) => {
    const date = readDateLiteral(n as Expr, (name) => env.has(name));
    return date.ok ? (nodeOf(date.value, (n as { pos: number }).pos) as object) : n;
  });
  const closed = spelled;
  if (applyRules(closed, VALUE) !== closed) return NOT_CONSTANT;
  if (lowering === null) internalError("emit/lower.ts did not lend the lowering before the fold read it");
  let mql: unknown;
  try {
    mql = lowering(closed, functions);
  } catch {
    return NOT_CONSTANT;
  }
  const result = interpret(mql);
  if (!result.ok)
    return result.unspellable === undefined ? NOT_CONSTANT : { ok: false, unspellable: result.unspellable };
  return withinSize(result.value) ? ok(result.value) : NOT_CONSTANT;
}
