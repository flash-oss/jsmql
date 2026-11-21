import type { Program } from "../../registry/ast.ts";
import { CodegenError } from "../../errors.ts";
import { blockBodyOf, bodySlotAt, isGlobalName } from "../rows.ts";

export type Road = "filter" | "other";

type Context = "program" | "raw" | "jsmql" | "operand";

type Role = string;

type Any = { type: string; pos: number } & Record<string, unknown>;

const isNode = (v: unknown): v is Any => typeof v === "object" && v !== null && typeof (v as Any).type === "string";

function dollarKey(node: Any): string | null {
  for (const e of node.entries as readonly Any[]) {
    if (e.type !== "KeyValueEntry") continue;
    const key = e.key as { kind: string; name?: string };
    if (key.kind === "static" && typeof key.name === "string" && key.name.startsWith("$")) return key.name;
  }
  return null;
}

function firstKey(node: Any): string | null {
  for (const e of node.entries as readonly Any[]) {
    if (e.type !== "KeyValueEntry") continue;
    const key = e.key as { kind: string; name?: string };
    return key.kind === "static" && typeof key.name === "string" ? key.name : "[…]";
  }
  return null;
}

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

function calleeSpelling(callee: unknown): string {
  if (!isNode(callee)) return "…";
  if (callee.type === "Ident") return callee.name as string;
  if (callee.type === "MemberAccess") return `${calleeSpelling(callee.object)}.${callee.name as string}`;
  return "…";
}

export function rawMqlBoundary(program: Program, road: Road): void {
  walk(program as unknown as Any, "program", "", road === "filter", road);
}

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
      const global = recv.type === "Ident" && isGlobalName(recv.name as string) ? (recv.name as string) : "";
      const spelled = `${global}.${(node.wrote as string | undefined) ?? name}`;
      if (name.startsWith("$")) {
        walk(node.object, "jsmql", "", false, road);
        const spine = bodySlotAt(name, [])?.at === "filter";
        for (const a of node.args as readonly unknown[]) walk(a, "raw", "", spine, road);
        return;
      }
      operand(node.object, `the receiver of '${spelled}()'`);
      const stages = blockBodyOf(name) === "stages";
      for (const a of node.args as readonly unknown[]) {
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
      if ((ctx === "jsmql" || ctx === "operand") && (node.value as string).startsWith("$")) node.text = true;
      return;
    default:
      return;
  }
}

function queryDocument(node: unknown, op: string): void {
  if (!isNode(node) || node.type !== "ObjectLiteral" || dollarKey(node) !== null) return;
  const key = firstKey(node);
  throw refuse(key === null ? "{}" : `{ ${key}: … }`, `an operand of '${op}'`, node.pos, "a query document (raw MQL)");
}
