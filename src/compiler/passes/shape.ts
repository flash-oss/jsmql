// Phase 4 — SHAPE. Which of the two documents does this program become?
//
// `db.coll.find(<filter>)` takes one document; `db.coll.aggregate(<pipeline>)`
// takes a list of stages. A program is one or the other, and the choice is not
// punctuation: `$.a = 1` is a pipeline with no `;` anywhere in it, and
// `const a = 1; $.x === a` is a filter with two.
//
// It is a decision about the WHOLE program, which is why it is not an `edge` in
// position.ts: no single parent-to-property step can see it.

import type { Program } from "../../registry/ast.ts";
import { lists } from "../rows.ts";
import { namedRow, readsAContextRef } from "./naming.ts";

/** The two documents a program can be. */
export type Shape = "filter" | "pipeline";

type Any = { type: string } & Record<string, unknown>;

/**
 * Is this node a statement rather than a value?
 *
 * Three clauses. A write, a declaration and a `;`-separated run are statements by
 * their node type. A chain whose base is one of the three context references is a
 * STREAM, and a stream is a pipeline wherever it stands. Everything else asks its
 * row, and the test is that the row has NO value form: `$match` is a stage and
 * has none, while `.filter()` lists one and is an expression standing alone.
 */
function statementShaped(node: Any): boolean {
  if (node.type === "Pipeline" || node.type === "UpdateFilter") return true;
  if (node.type === "LetDecl" || node.type === "FuncDecl") return true;
  if (readsAContextRef(node)) return true;
  const name = namedRow(node);
  if (name === null) return false;
  // `Object.assign($.a, $.b)` standing alone WRITES `$.a`, as the mutators do:
  // a merged object is truthy, so as a filter it would keep every document.
  if (name === "assign" && writesItsTarget(node)) return true;
  // A row with a VALUE form is decided by the `;` and not by this: `.filter()`
  // lists one, and `$.items.filter(p)` standing alone is an expression.
  if (lists(name, "value")) return false;
  return lists(name, "statement") || lists(name, "stream");
}

/** Is the first argument a place a write can land — a field of the document, or a binding? */
function writesItsTarget(node: Any): boolean {
  const target = (node as { args?: readonly Any[] }).args?.[0];
  return target !== undefined && (target.type === "FieldRef" || target.type === "Ident");
}

/**
 * The document this program becomes.
 *
 * A bracketed literal is decided by its FIRST element, which is also how the
 * compiler reads it: `[$match(…), 1]` refuses element 1 for not being a stage,
 * and `[1, $match(…)]` refuses `$match` for not being an expression. One of the
 * two readings has to win before the rest can be checked at all.
 */
export function shapeOf(program: Program): Shape {
  const root = program as Any;
  // `const cutoff = 18; $.age > cutoff` is a Filter with a prelude: every statement but
  // the last declares a binding the fold inlines, and the last is an expression.
  if (root.type === "Pipeline") {
    const stmts = root.stmts as readonly Any[];
    const last = stmts[stmts.length - 1];
    const prelude = stmts.length >= 2 && stmts.slice(0, -1).every((s) => s.type === "LetDecl" || s.type === "FuncDecl");
    if (last !== undefined && prelude && !statementShaped(last)) return "filter";
  }
  if (statementShaped(root)) return "pipeline";
  if (root.type === "ArrayLiteral") {
    const first = (root.elements as readonly Any[] | undefined)?.[0];
    // An empty literal is the empty ARRAY, not the empty pipeline.
    return first !== undefined && statementShaped(first) ? "pipeline" : "filter";
  }
  return "filter";
}
