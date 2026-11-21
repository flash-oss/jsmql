import type { Program } from "../../registry/ast.ts";
import { isMutator, lists } from "../rows.ts";
import { couldWriteItsReceiver, namedRow, readsAContextRef } from "./naming.ts";

export type Shape = "filter" | "pipeline";

type Any = { type: string } & Record<string, unknown>;

function statementShaped(node: Any): boolean {
  if (node.type === "Pipeline" || node.type === "UpdateFilter") return true;
  if (node.type === "LetDecl" || node.type === "FuncDecl") return true;
  if (readsAContextRef(node)) return true;
  const name = namedRow(node);
  if (name === null) return false;
  if (name === "assign" && writesItsReceiver(node)) return true;
  if (lists(name, "value")) return false;
  if (node.type === "MethodCall" && isMutator(name) && !couldWriteItsReceiver(node)) return false;
  if (node.type === "MethodCall" && !isMutator(name)) return false;
  return lists(name, "statement") || lists(name, "stream");
}

export function isBareAssign(program: Program): boolean {
  const node = program as Any;
  return namedRow(node) === "assign" && writesItsReceiver(node);
}

function writesItsReceiver(node: Any): boolean {
  const target = (node as { object?: Any }).object;
  return node.type === "MethodCall" && target !== undefined && (target.type === "FieldRef" || target.type === "Ident");
}

export function shapeOf(program: Program): Shape {
  const root = program as Any;
  if (root.type === "Pipeline") {
    const stmts = root.stmts as readonly Any[];
    const last = stmts[stmts.length - 1];
    const prelude = stmts.length >= 2 && stmts.slice(0, -1).every((s) => s.type === "LetDecl" || s.type === "FuncDecl");
    if (last !== undefined && prelude && !statementShaped(last)) return "filter";
  }
  if (statementShaped(root)) return "pipeline";
  if (root.type === "ArrayLiteral") return "pipeline";
  return "filter";
}

export function isStageList(program: Program): boolean {
  const root = program as Any;
  if (root.type !== "ArrayLiteral") return false;
  const first = (root.elements as readonly Any[] | undefined)?.[0];
  return first !== undefined && statementShaped(first);
}
