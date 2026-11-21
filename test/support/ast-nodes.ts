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

// @ts-expect-error — 'MathCall' is not a node of ast.ts
const NOT_A_NODE: NodeName = "MathCall";
void NOT_A_NODE;
