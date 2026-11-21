import type { FuncDecl, Program, UpdateFilter, UpdateOp } from "../../registry/ast.ts";
import { writeInValueOf, functionInValueOf } from "../parse/parser.ts";
import { applyRules } from "./desugar-rules.ts";
import type { Where } from "./position.ts";
import { edge, STATEMENT } from "./position.ts";
import { fold } from "./fold.ts";
import { mapTreeIn } from "./walk.ts";

const MAX_ROUNDS = 100_000;

const fingerprint = (program: Program): string => JSON.stringify(program, (k, v) => (k === "pos" ? 0 : v));

function refuseWritesInValues(program: Program, root: RootWhere): void {
  mapTreeIn(program, root, edge, (node, where) => {
    if (where.at === "statement" || where.at === "updateDoc") return node;
    const t = (node as { type: string }).type;
    if (t === "UpdateFilter" || t === "AssignExpr" || t === "DeleteStmt") {
      throw writeInValueOf(node as UpdateOp | UpdateFilter);
    }
    if (t === "FuncDecl") throw functionInValueOf(node as FuncDecl);
    return node;
  });
}

export type DesugarResult = { program: Program; rounds: number };

export type RootWhere = Where;

export function desugarVerbose(program: Program, root: RootWhere = STATEMENT): DesugarResult {
  refuseWritesInValues(program, root);
  let current: Program = program;
  const seen = new Set<string>([fingerprint(program)]);
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    let next = applyRules(current, root);
    next = fold(next);
    if (next === current) return { program: current, rounds: round };
    const print = fingerprint(next);
    if (seen.has(print)) {
      throw new Error(
        `jsmql internal error (please report): the desugar pass cycled after ${round} rounds — two rules rewrite each other's output.`,
      );
    }
    seen.add(print);
    current = next;
  }
  throw new Error(`jsmql internal error (please report): the desugar pass did not settle after ${MAX_ROUNDS} rounds.`);
}

export function desugar(program: Program, root: RootWhere = STATEMENT): Program {
  return desugarVerbose(program, root).program;
}
