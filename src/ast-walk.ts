// Generic AST traversal shared by codegen.ts and pipeline.ts. A leaf module
// (imports only ast.ts types) so both can use it without an import cycle.
//
// `someExpr(node, pred)` is **complete** over the `Expr` union — every
// child-bearing node recurses. Completeness is load-bearing for its callers
// (e.g. `containsStreamLength` would let `$$.length` slip through un-detected,
// and the array-callback index-usage check would wrongly drop the `$zip` form)
// — so when a new `Expr` variant with children is added, extend the switch here.

import type { Expr, ArrayElement, PipelineStmt, CallArg } from "./ast.ts";

/** Recurse a CallArg (Expr or spread). */
export function someArg(arg: CallArg, pred: (e: Expr) => boolean): boolean {
  return arg.type === "SpreadElement" ? someExpr(arg.argument, pred) : someExpr(arg, pred);
}

/** True if `expr` or any sub-expression satisfies `pred`. Complete over `Expr`. */
export function someExpr(expr: Expr, pred: (e: Expr) => boolean): boolean {
  if (pred(expr)) return true;
  switch (expr.type) {
    case "OperatorCall":
    case "MathCall":
    case "ObjectCall":
      return expr.args.some((a) => someArg(a, pred));
    case "CallExpression":
      return someExpr(expr.callee, pred) || expr.args.some((a) => someArg(a, pred));
    case "MethodCall":
      return someExpr(expr.object, pred) || expr.args.some((a) => someArg(a, pred));
    case "MemberAccess":
      return someExpr(expr.object, pred);
    case "IndexAccess":
      return someExpr(expr.object, pred) || someExpr(expr.index, pred);
    case "BinaryExpr":
      return someExpr(expr.left, pred) || someExpr(expr.right, pred);
    case "UnaryExpr":
      return someExpr(expr.operand, pred);
    case "TernaryExpr":
      return someExpr(expr.condition, pred) || someExpr(expr.consequent, pred) || someExpr(expr.alternate, pred);
    case "TemplateLiteral":
      return expr.expressions.some((e) => someExpr(e, pred));
    case "ArrayLiteral":
      return expr.elements.some((el) => someElement(el, pred));
    case "ObjectLiteral":
      return expr.entries.some((entry) =>
        entry.type === "SpreadElement"
          ? someExpr(entry.argument, pred)
          : (entry.key.kind === "computed" && someExpr(entry.key.expr, pred)) || someExpr(entry.value, pred),
      );
    case "Lambda":
      if (expr.body !== undefined && someExpr(expr.body, pred)) return true;
      if (expr.exprBlock !== undefined) {
        if (expr.exprBlock.decls.some((d) => someExpr(d.value, pred))) return true;
        if (someExpr(expr.exprBlock.ret, pred)) return true;
      }
      if (expr.block !== undefined && expr.block.stmts.some((s) => someStmt(s, pred))) return true;
      if (expr.ret !== undefined && someExpr(expr.ret, pred)) return true;
      return false;
    case "TypeofExpr":
      return someExpr(expr.operand, pred);
    case "TypeCast":
      return someExpr(expr.arg, pred);
    case "NewDate":
    case "DateUTC":
      return expr.args.some((e) => someExpr(e, pred));
    case "NewSet":
      return expr.arg !== null && someExpr(expr.arg, pred);
    case "ArrayFrom":
      return someExpr(expr.input, pred) || (expr.mapFn !== null && someExpr(expr.mapFn, pred));
    case "NumberStatic":
      return someExpr(expr.arg, pred);
    default:
      // Leaves with no child expressions: literals, FieldRef, CollectionRef,
      // DatabaseRef, ClusterRef, ParamRef, RegexLiteral, the *Ref/*Const tags,
      // DateNow. None can contain a sub-expression.
      return false;
  }
}

/** `someExpr` over a pipeline ArrayElement (statement wrappers + bare expr). */
export function someElement(el: ArrayElement, pred: (e: Expr) => boolean): boolean {
  if (el.type === "AssignExpr") return someExpr(el.value, pred);
  if (el.type === "DeleteStmt") return false;
  if (el.type === "LetDecl") return someExpr(el.value, pred);
  if (el.type === "FuncDecl") return false; // body lives in ctx, not the AST
  if (el.type === "SpreadElement") return someExpr(el.argument, pred);
  return someExpr(el as Expr, pred);
}

/** `someExpr` over a `;`-separated pipeline statement. */
export function someStmt(stmt: PipelineStmt, pred: (e: Expr) => boolean): boolean {
  if (stmt.type === "UpdateFilter") {
    return stmt.ops.some((op) => (op.type === "AssignExpr" ? someExpr(op.value, pred) : false));
  }
  return someElement(stmt as ArrayElement, pred);
}
