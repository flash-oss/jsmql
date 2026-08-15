// Generic AST traversal shared across the compiler. A leaf module (imports only
// ast.ts types) so any file can use it without an import cycle.
//
// Every walk derives from ONE child-list table. `Record<Expr["type"], …>` makes
// TypeScript demand an entry for every node kind, so a new kind fails the build until
// its children are declared — completeness stops being something a comment asks for.
// `some` / `map` / `fold` all read the same table, so traversal shapes cannot drift
// apart the way independently hand-written switches do.
//
// See docs/specs/architecture.md § Traversal.

import type { ArrayElement, CallArg, Expr, ObjectEntry, PipelineStmt } from "./ast.ts";

/**
 * How one node kind reaches its children.
 *
 *   "field"            — one optional Expr under that key
 *   { list: k }        — an array of Expr / CallArg / ArrayElement under that key
 *   { entries: k }     — ObjectLiteral entries (computed key + value, or a spread)
 *   { block: k }       — a Pipeline under that key, walked statement by statement
 *   { exprBlock: k }   — an ExprBlock: every declaration's value, then its `ret`
 */
type ChildRef = string | { list: string } | { entries: string } | { block: string } | { exprBlock: string };

/**
 * The single source of truth for the shape of the `Expr` tree.
 *
 * A leaf declares `[]` rather than being omitted: "this node has no children" is an
 * assertion worth making, and an omission would be indistinguishable from an oversight.
 */
const CHILDREN: Record<Expr["type"], readonly ChildRef[]> = {
  // ── carriers ──
  OperatorCall: [{ list: "args" }],
  MathCall: [{ list: "args" }],
  ObjectCall: [{ list: "args" }],
  CallExpression: ["callee", { list: "args" }],
  MethodCall: ["object", { list: "args" }],
  MemberAccess: ["object"],
  IndexAccess: ["object", "index"],
  BinaryExpr: ["left", "right"],
  UnaryExpr: ["operand"],
  TernaryExpr: ["condition", "consequent", "alternate"],
  TemplateLiteral: [{ list: "expressions" }],
  ArrayLiteral: [{ list: "elements" }],
  ObjectLiteral: [{ entries: "entries" }],
  Lambda: ["body", { exprBlock: "exprBlock" }, { block: "block" }, "ret"],
  TypeofExpr: ["operand"],
  TypeCast: ["arg"],
  NewDate: [{ list: "args" }],
  DateUTC: [{ list: "args" }],
  NewSet: ["arg"],
  ArrayFrom: ["input", "mapFn"],
  NumberStatic: ["arg"],
  // ── leaves ──
  FieldRef: [],
  CollectionRef: [],
  DatabaseRef: [],
  ClusterRef: [],
  NumberLiteral: [],
  BigIntLiteral: [],
  StringLiteral: [],
  BooleanLiteral: [],
  NullLiteral: [],
  UndefinedLiteral: [],
  RegexLiteral: [],
  ParamRef: [],
  ObjectIdLiteral: [],
  ObjectIdRef: [],
  TypeCastRef: [],
  MathCallRef: [],
  MathConst: [],
  DateNow: [],
};

/** Every direct child Expr of `expr`, in source order. */
export function childrenOf(expr: Expr): Expr[] {
  const out: Expr[] = [];
  // Each node kind is a closed shape, but the table addresses its fields by name, so
  // the lookup is dynamic by nature. The `Record<Expr["type"], …>` above is what keeps
  // it honest: a kind cannot be reached here without an entry.
  const node = expr as unknown as Record<string, unknown>;
  // Statement nodes reach these walks too — `parseGrouped` can surface an `AssignExpr`
  // through an Expr-typed slot, and callers hand whole statements to `someExpr`. They
  // are not in the Expr union, so they route through `stmtChildren` rather than the
  // table. Walking into them is deliberate: treating a statement as a childless leaf
  // is what let a buried `$$.push` escape its gate.
  const refs = CHILDREN[expr.type];
  if (refs === undefined) return stmtChildren(expr as unknown as PipelineStmt);
  for (const ref of refs) {
    if (typeof ref === "string") {
      const v = node[ref];
      if (v !== undefined && v !== null) out.push(v as Expr);
      continue;
    }
    if ("list" in ref) {
      const items = (node[ref.list] ?? []) as (CallArg | ArrayElement)[];
      for (const it of items) out.push(unwrapElement(it));
      continue;
    }
    if ("entries" in ref) {
      for (const entry of (node[ref.entries] ?? []) as ObjectEntry[]) {
        if (entry.type === "SpreadElement") {
          out.push(entry.argument);
          continue;
        }
        if (entry.key.kind === "computed") out.push(entry.key.expr);
        out.push(entry.value);
      }
      continue;
    }
    if ("block" in ref) {
      const block = node[ref.block] as { stmts: PipelineStmt[] } | undefined;
      for (const stmt of block?.stmts ?? []) out.push(...stmtChildren(stmt));
      continue;
    }
    const eb = node[ref.exprBlock] as { decls: { value: Expr }[]; ret: Expr } | undefined;
    if (eb !== undefined) {
      for (const d of eb.decls) out.push(d.value);
      out.push(eb.ret);
    }
  }
  return out;
}

/** A spread element carries its payload one level down; everything else is the Expr. */
function unwrapElement(el: CallArg | ArrayElement): Expr {
  return (el as { type: string }).type === "SpreadElement"
    ? ((el as { argument: Expr }).argument as Expr)
    : (el as Expr);
}

/** The Exprs a pipeline statement holds. A `FuncDecl` body lives in ctx, not the AST. */
function stmtChildren(stmt: PipelineStmt | ArrayElement): Expr[] {
  const t = (stmt as { type: string }).type;
  if (t === "UpdateFilter") {
    const ops = (stmt as unknown as { ops: { type: string; value?: Expr }[] }).ops;
    return ops.flatMap((op) => (op.type === "AssignExpr" && op.value !== undefined ? [op.value] : []));
  }
  if (t === "AssignExpr" || t === "LetDecl") {
    const v = (stmt as unknown as { value?: Expr }).value;
    return v === undefined ? [] : [v];
  }
  if (t === "DeleteStmt" || t === "FuncDecl") return [];
  if (t === "SpreadElement") return [(stmt as unknown as { argument: Expr }).argument];
  if (t === "Pipeline") return (stmt as unknown as { stmts: PipelineStmt[] }).stmts.flatMap(stmtChildren);
  // A bare Expr IS the part — returning its children instead would skip the predicate
  // on the element itself. `childrenOf`'s fallback never lands here, because every
  // `Expr` kind has a table entry; only statement kinds miss.
  return [stmt as Expr];
}

/** Recurse a CallArg (Expr or spread). */
export function someArg(arg: CallArg, pred: (e: Expr) => boolean): boolean {
  return someExpr(unwrapElement(arg), pred);
}

/** True if `expr` or any sub-expression satisfies `pred`. Complete over `Expr`. */
export function someExpr(expr: Expr, pred: (e: Expr) => boolean): boolean {
  if (pred(expr)) return true;
  for (const child of childrenOf(expr)) {
    if (someExpr(child, pred)) return true;
  }
  return false;
}

/** `someExpr` over a pipeline ArrayElement (statement wrappers + bare expr). */
export function someElement(el: ArrayElement, pred: (e: Expr) => boolean): boolean {
  return stmtChildren(el).some((e) => someExpr(e, pred));
}

/** `someExpr` over a `;`-separated pipeline statement. */
export function someStmt(stmt: PipelineStmt, pred: (e: Expr) => boolean): boolean {
  return stmtChildren(stmt).some((e) => someExpr(e, pred));
}

/** Left-to-right fold over `expr` and every sub-expression, pre-order. */
export function foldExpr<T>(expr: Expr, seed: T, step: (acc: T, e: Expr) => T): T {
  let acc = step(seed, expr);
  for (const child of childrenOf(expr)) acc = foldExpr(child, acc, step);
  return acc;
}

/** Every Expr in the tree, pre-order. */
export function flattenExpr(expr: Expr): Expr[] {
  return foldExpr(expr, [] as Expr[], (acc, e) => {
    acc.push(e);
    return acc;
  });
}
