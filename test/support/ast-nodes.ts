// Every node type of src/registry/ast.ts, as a list that runs.
//
// Vitest strips types, so a type annotation in a suite checks nothing. `tsc`
// checks THIS file through test/types/tsconfig.ast.json, and
// compiler-ast.test.ts runs that check. A node in ast.ts that this list omits,
// or a key here that ast.ts does not hold, fails the compile.

import type { NodeName } from "../../src/registry/vocabulary.ts";
import type { Node } from "../../src/registry/ast.ts";

export const EVERY_NODE: Record<Node["type"], true> & Record<NodeName, true> = {
  NumberLiteral: true,
  BigIntLiteral: true,
  StringLiteral: true,
  BooleanLiteral: true,
  NullLiteral: true,
  UndefinedLiteral: true,
  RegexLiteral: true,
  ObjectIdLiteral: true,
  Injected: true,
  TemplateLiteral: true,
  ArrayLiteral: true,
  ObjectLiteral: true,
  FieldRef: true,
  StreamRef: true,
  DatabaseRef: true,
  ClusterRef: true,
  Ident: true,
  MemberAccess: true,
  IndexAccess: true,
  MethodCall: true,
  CallExpression: true,
  NewExpression: true,
  OperatorCall: true,
  UnaryExpr: true,
  BinaryExpr: true,
  TernaryExpr: true,
  Lambda: true,
  ExprBlock: true,
  SpreadElement: true,
  KeyValueEntry: true,
  LetDecl: true,
  FuncDecl: true,
  AssignExpr: true,
  DeleteStmt: true,
  UpdateFilter: true,
  Pipeline: true,
};

// The proof that `tsc` reads this file: a name the tree does not hold is refused.
// @ts-expect-error — 'MathCall' is not a node of ast.ts
const NOT_A_NODE: NodeName = "MathCall";
void NOT_A_NODE;
