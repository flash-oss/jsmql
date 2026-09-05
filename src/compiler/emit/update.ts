// Phase 5 — EMIT, the UPDATE-DOCUMENT target: the object form of an update,
// `db.coll.updateOne(filter, { $set: { … }, $inc: { … } })`. A document-form
// update takes CONSTANTS — the server reads `"$b"` there as the string — so
// every value is a compile-time constant, and a read of the document is refused
// with the pipeline form as the way out. See docs/specs/emit-pass.md § The
// update-document target.
import type { Expr, QueryDoc } from "../../registry/vocabulary.ts";
import type { PipelineStmt, Program, UpdateFilter } from "../../registry/ast.ts";
import { UPDATE_DOC } from "../passes/position.ts";
import { staticKey } from "../passes/naming.ts";
import type { Env } from "./env.ts";
import * as E from "./errors.ts";
import { childEnv } from "./inputs.ts";
import { lowerValue } from "./lower.ts";

type Update = Record<string, Record<string, unknown>>;

/** The update document a program means. */
export function lowerUpdate(program: Program, env: Env): QueryDoc {
  const stmts: readonly PipelineStmt[] = program.type === "Pipeline" ? program.stmts : [program as PipelineStmt];
  const scope = program.type === "Pipeline" ? childEnv(env, program, "stmts") : env;
  const out: Update = {};
  const claimed = new Map<string, string>();
  const put = (op: string, path: string, value: unknown, pos: number): void => {
    const held = claimed.get(path);
    if (held !== undefined) throw E.updateConflict(path, held, op, pos);
    claimed.set(path, op);
    (out[op] ??= {})[path] = value;
  };
  // `$.b = $.a; delete $.a;` is one `$rename` — either order.
  const deleted = new Set<string>();
  for (const s of stmts) {
    if (s.type !== "UpdateFilter") continue;
    for (const op of s.ops) if (op.type === "DeleteStmt") deleted.add(pathOf(op.target, op.pos));
  }
  const renamed = new Set<string>();
  const valueEnv = scope.at(UPDATE_DOC);
  for (const stmt of stmts) {
    if (stmt.type === "UpdateFilter") {
      for (const op of (stmt as UpdateFilter).ops) {
        if (op.type === "DeleteStmt") {
          const path = pathOf(op.target, op.pos);
          if (!renamed.has(path)) put("$unset", path, "", op.pos);
          continue;
        }
        const path = pathOf(op.target, op.pos);
        const v = op.value;
        switch (op.op) {
          case "=": {
            if (v.type === "FieldRef") {
              if (!deleted.has(v.path)) throw E.updateCopyNeedsPipeline(v.path, path, op.pos);
              renamed.add(v.path);
              put("$rename", v.path, path, op.pos);
              if (claimed.has(path)) throw E.updateConflict(path, claimed.get(path)!, "$rename", op.pos);
              claimed.set(path, "$rename");
              break;
            }
            if (
              v.type === "NewExpression" &&
              v.callee.type === "Ident" &&
              v.callee.name === "Date" &&
              v.args.length === 0
            ) {
              put("$currentDate", path, true, op.pos);
              break;
            }
            const bound = minMax(v, path);
            if (bound !== null) {
              put(bound.op, path, lowerValue(bound.value, valueEnv), op.pos);
              break;
            }
            put("$set", path, lowerValue(v, valueEnv), op.pos);
            break;
          }
          case "+=":
          case "-=": {
            const n = number(lowerValue(v, valueEnv), op.op, op.pos);
            put("$inc", path, op.op === "+=" ? n : -n, op.pos);
            break;
          }
          case "*=":
          case "/=": {
            const n = number(lowerValue(v, valueEnv), op.op, op.pos);
            if (op.op === "/=" && n === 0) throw E.updateNeedsNumber("/=", "a non-zero number", op.pos);
            put("$mul", path, op.op === "*=" ? n : 1 / n, op.pos);
            break;
          }
          case "++":
          case "--":
            put("$inc", path, op.op === "++" ? 1 : -1, op.pos);
            break;
          default:
            throw E.updateHasNoDocumentForm(`'${op.op}'`, op.pos);
        }
      }
      continue;
    }
    if (stmt.type === "LetDecl" || stmt.type === "FuncDecl") throw E.updateHasNoDocumentForm("a binding", stmt.pos);
    const node = stmt as Expr;
    if (node.type === "MethodCall" && node.object.type === "FieldRef" && node.object.path !== "") {
      const path = node.object.path;
      const args = node.args.map((a) => {
        if (a.type === "SpreadElement") throw E.spreadInCall(`.${node.name}()`, a.pos);
        return lowerValue(a, valueEnv);
      });
      switch (node.name) {
        case "push":
          put("$push", path, args.length === 1 ? args[0] : { $each: args }, node.pos);
          break;
        case "unshift":
          put("$push", path, { $each: args, $position: 0 }, node.pos);
          break;
        case "pop":
          put("$pop", path, 1, node.pos);
          break;
        case "shift":
          put("$pop", path, -1, node.pos);
          break;
        default:
          throw E.updateHasNoDocumentForm(`'.${node.name}()'`, node.pos);
      }
      continue;
    }
    if (node.type === "OperatorCall") {
      merge(lowerValue(node, valueEnv), node.pos);
      continue;
    }
    if (node.type === "ObjectLiteral") {
      for (const e of node.entries) {
        if (e.type === "SpreadElement") throw E.spreadInOperatorBody(e.pos);
        const key = staticKey(e);
        if (key === null || !key.startsWith("$")) throw E.updateKeyNotOperator(key, e.pos);
        const call: Expr = { type: "OperatorCall", name: key, args: [e.value], pos: e.pos };
        merge(lowerValue(call, valueEnv), e.pos);
      }
      continue;
    }
    throw E.notAnUpdate(node.pos);
  }
  if (Object.keys(out).length === 0) throw E.notAnUpdate((program as { pos: number }).pos);
  return out;

  /** `{ $inc: { a: 1 } }` from a row's cell, merged path by path. */
  function merge(doc: unknown, pos: number): void {
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) throw E.notAnUpdate(pos);
    for (const [op, fields] of Object.entries(doc as Record<string, unknown>)) {
      if (fields === null || typeof fields !== "object" || Array.isArray(fields)) throw E.updateNeedsFields(op, pos);
      for (const [path, value] of Object.entries(fields as Record<string, unknown>)) put(op, path, value, pos);
    }
  }
}

/** `$.a` and `$.a.b` name the path; anything else is not a field to update. */
function pathOf(target: Expr, pos: number): string {
  if (target.type === "FieldRef" && target.path !== "") return target.path;
  throw E.updateTargetNeedsField(pos);
}

/** `$.n = Math.min($.n, 5)` is `$min: { n: 5 }` — the SAME path on both sides. */
function minMax(v: Expr, path: string): { op: "$min" | "$max"; value: Expr } | null {
  if (v.type !== "MethodCall" || v.object.type !== "Ident" || v.object.name !== "Math") return null;
  if (v.name !== "min" && v.name !== "max") return null;
  const [self, other] = v.args;
  if (v.args.length !== 2 || self === undefined || other === undefined) return null;
  if (self.type === "SpreadElement" || other.type === "SpreadElement") return null;
  if (self.type !== "FieldRef" || self.path !== path) return null;
  return { op: v.name === "min" ? "$min" : "$max", value: other };
}

function number(v: unknown, op: string, pos: number): number {
  if (typeof v !== "number") throw E.updateNeedsNumber(op, "a number", pos);
  return v;
}
