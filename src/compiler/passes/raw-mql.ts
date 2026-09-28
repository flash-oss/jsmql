// HR6 — raw MQL can hold JSMQL, and JSMQL cannot take raw MQL as an operand.
//
// Raw MQL is an `$op(…)` call, or an object with a `$` key. On the query road, a
// plain object that is an operand of `&&`, `||` or `!` is a query document, which
// is raw MQL too. This pass reads the tree AS PARSED: before a template value or a
// `jsmql.compile` parameter goes in (a passed value is not source), and before a
// fold or a desugar rule moves a node to another place.
//
// See docs/specs/raw-mql-boundary.md and docs/LANG_RULES.md (HR6).

import type { Program } from "../../registry/ast.ts";
import { CodegenError } from "../../errors.ts";
import { blockBodyOf, bodySlotAt, isGlobalName } from "../rows.ts";

/** The road the program takes: a Filter is a query document at its root. */
export type Road = "filter" | "other";

/**
 * Where a node stands.
 *
 *   program  the program root, a statement, a stage of `.aggregate([…])`
 *   raw      an argument of an `$op(…)` call or of a stage link, a value under a `$` key
 *   jsmql    a whole value that JSMQL owns: the right side of `=`, a `let` value, a callback body
 *   operand  a value that a JSMQL construct computes with
 *
 * An object or an array literal holds values and computes nothing, so its entries
 * stand where it stands.
 */
type Context = "program" | "raw" | "jsmql" | "operand";

/** The JSMQL construct around an operand, as the message names it: "an operand of '&&'". */
type Role = string;

type Any = { type: string; pos: number } & Record<string, unknown>;

const isNode = (v: unknown): v is Any => typeof v === "object" && v !== null && typeof (v as Any).type === "string";

/** The first `$` key of an object literal as written, or null. */
function dollarKey(node: Any): string | null {
  for (const e of node.entries as readonly Any[]) {
    if (e.type !== "KeyValueEntry") continue;
    const key = e.key as { kind: string; name?: string };
    if (key.kind === "static" && typeof key.name === "string" && key.name.startsWith("$")) return key.name;
  }
  return null;
}

/** The first key of an object literal as written, for the message. */
function firstKey(node: Any): string | null {
  for (const e of node.entries as readonly Any[]) {
    if (e.type !== "KeyValueEntry") continue;
    const key = e.key as { kind: string; name?: string };
    return key.kind === "static" && typeof key.name === "string" ? key.name : "[…]";
  }
  return null;
}

/** A raw MQL node, as the message spells it, or null when the node is not raw MQL. */
function rawSpelling(node: Any): string | null {
  if (node.type === "OperatorCall") return `${node.name as string}(…)`;
  if (node.type === "ObjectLiteral") {
    const key = dollarKey(node);
    if (key !== null) return `{ ${key}: … }`;
  }
  return null;
}

function refuse(spelled: string, role: Role, pos: number, what = "raw MQL"): CodegenError {
  return new CodegenError(`'${spelled}' is ${what}, and raw MQL cannot be ${role}.`, pos);
}

/** A call's name as the message spells it: `Math.max`, `Date`. */
function calleeSpelling(callee: unknown): string {
  if (!isNode(callee)) return "…";
  if (callee.type === "Ident") return callee.name as string;
  if (callee.type === "MemberAccess") return `${calleeSpelling(callee.object)}.${callee.name as string}`;
  return "…";
}

/**
 * Throw when a raw MQL value stands as an operand, and mark each `"$…"` string that
 * JSMQL reads as text. The walk descends into every node, so the rule holds at
 * every depth, inside raw MQL too. The marks go on the parsed tree itself: a
 * `.compile` builder reuses that tree, and each run gives the same marks.
 */
export function rawMqlBoundary(program: Program, road: Road): void {
  walk(program as unknown as Any, "program", "", road === "filter", road);
}

/**
 * `ctx` is where the node stands. `role` names the construct when `ctx` is
 * "operand". `query` is true on the query road's predicate spine: the program root
 * of a Filter, or the argument of a stage whose whole body is a filter
 * (`$match`), and down through `&&`, `||` and `!` only.
 */
function walk(node: unknown, ctx: Context, role: Role, query: boolean, road: Road): void {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, ctx, role, query, road);
    return;
  }
  if (!isNode(node)) return;

  const raw = rawSpelling(node);
  if (raw !== null && ctx === "operand") throw refuse(raw, role, node.pos);

  const operand = (child: unknown, r: Role, q = false): void => walk(child, "operand", r, q, road);
  const whole = (child: unknown): void => walk(child, "jsmql", "", false, road);
  const statement = (child: unknown): void => walk(child, "program", "", road === "filter", road);

  switch (node.type) {
    case "Pipeline":
      for (const s of node.stmts as readonly unknown[]) statement(s);
      return;
    case "UpdateFilter":
      for (const op of node.ops as readonly unknown[]) walk(op, ctx, role, false, road);
      return;
    case "LetDecl":
      whole(node.value);
      return;
    case "FuncDecl":
      walk(node.lambda, "jsmql", "", false, road);
      return;
    case "AssignExpr": {
      const op = node.op as string;
      operand(node.target, "the target of an assignment");
      if (op === "=") whole(node.value);
      else operand(node.value, `an operand of '${op}'`);
      return;
    }
    case "DeleteStmt":
      operand(node.target, "an operand of 'delete'");
      return;
    case "OperatorCall": {
      // A stage whose whole body is a filter (`$match`) starts a new predicate spine.
      const spine = bodySlotAt(node.name as string, [])?.at === "filter";
      for (const a of node.args as readonly unknown[]) walk(a, "raw", "", spine, road);
      return;
    }
    case "ObjectLiteral": {
      if (raw !== null) {
        for (const e of node.entries as readonly Any[]) {
          if (e.type === "KeyValueEntry") {
            const key = e.key as { kind: string; expr?: unknown };
            if (key.kind === "computed") operand(key.expr, "a computed key");
            walk(e.value, "raw", "", false, road);
          } else walk(e, "raw", "", false, road);
        }
        return;
      }
      for (const e of node.entries as readonly Any[]) {
        if (e.type === "KeyValueEntry") {
          const key = e.key as { kind: string; expr?: unknown };
          if (key.kind === "computed") operand(key.expr, "a computed key");
          walk(e.value, ctx, role, false, road);
        } else walk(e, ctx, role, false, road);
      }
      return;
    }
    case "ArrayLiteral":
      for (const e of node.elements as readonly unknown[]) walk(e, ctx, role, false, road);
      return;
    case "KeyValueEntry":
      walk(node.value, ctx, role, false, road);
      return;
    case "SpreadElement":
      operand(node.argument, "an operand of '...'");
      return;
    case "BinaryExpr": {
      const op = node.op as string;
      const spine = query && (op === "&&" || op === "||");
      for (const side of [node.left, node.right]) {
        if (spine) queryDocument(side, op);
        operand(side, `an operand of '${op}'`, spine);
      }
      return;
    }
    case "UnaryExpr": {
      const op = node.op as string;
      const spine = query && op === "!";
      if (spine) queryDocument(node.argument, op);
      operand(node.argument, `an operand of '${op}'`, spine);
      return;
    }
    case "TernaryExpr":
      for (const part of [node.test, node.consequent, node.alternate]) operand(part, "an operand of '?:'");
      return;
    case "TemplateLiteral":
      for (const e of node.exprs as readonly unknown[]) operand(e, "an operand of a template literal");
      return;
    case "MemberAccess":
      operand(node.object, `the receiver of '.${node.name as string}'`);
      return;
    case "IndexAccess":
      operand(node.object, "the receiver of '[…]'");
      operand(node.index, "an operand of '[…]'");
      return;
    case "MethodCall": {
      const name = node.name as string;
      const recv = node.object as Any;
      // A static call names its global: `Math.max()`, not `.max()`.
      const global = recv.type === "Ident" && isGlobalName(recv.name as string) ? (recv.name as string) : "";
      const spelled = `${global}.${(node.wrote as string | undefined) ?? name}`;
      if (name.startsWith("$")) {
        // A stage link is a link of the stream chain, not a value: its receiver is
        // the stream, and its argument is the stage's own MQL.
        walk(node.object, "jsmql", "", false, road);
        const spine = bodySlotAt(name, [])?.at === "filter";
        for (const a of node.args as readonly unknown[]) walk(a, "raw", "", spine, road);
        return;
      }
      operand(node.object, `the receiver of '${spelled}()'`);
      const stages = blockBodyOf(name) === "stages";
      for (const a of node.args as readonly unknown[]) {
        // `.aggregate([{ $match: … }])`: each element is a stage, as each statement of the block form is.
        if (stages && isNode(a) && a.type === "ArrayLiteral") {
          for (const e of a.elements as readonly unknown[]) statement(e);
        } else operand(a, `an operand of '${spelled}()'`);
      }
      return;
    }
    case "CallExpression":
      operand(node.callee, "a callee");
      for (const a of node.args as readonly unknown[]) operand(a, `an operand of '${calleeSpelling(node.callee)}()'`);
      return;
    case "NewExpression":
      for (const a of node.args as readonly unknown[])
        operand(a, `an operand of 'new ${calleeSpelling(node.callee)}()'`);
      return;
    case "Lambda":
      if (node.stages !== undefined) walk(node.stages, "program", "", false, road);
      else whole(node.body);
      return;
    case "ExprBlock":
      for (const d of node.decls as readonly unknown[]) walk(d, "jsmql", "", false, road);
      whole(node.ret);
      return;
    case "StringLiteral":
      // In raw MQL and at the program root, a `"$…"` string is a field path (HR1).
      // In JSMQL, it is text.
      if ((ctx === "jsmql" || ctx === "operand") && (node.value as string).startsWith("$")) node.text = true;
      return;
    default:
      // A literal, a reference or a name: nothing below it is a value.
      return;
  }
}

/** On the query road, a plain object that is an operand of `&&`, `||` or `!` is a query document. */
function queryDocument(node: unknown, op: string): void {
  if (!isNode(node) || node.type !== "ObjectLiteral" || dollarKey(node) !== null) return;
  const key = firstKey(node);
  throw refuse(key === null ? "{}" : `{ ${key}: … }`, `an operand of '${op}'`, node.pos, "a query document (raw MQL)");
}
