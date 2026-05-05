export type SpreadElement = {
  type: "SpreadElement";
  argument: Expr;
};

export type KeyValueEntry = {
  type: "KeyValueEntry";
  key: string;
  value: Expr;
};

export type ObjectEntry = KeyValueEntry | SpreadElement;
export type ArrayElement = Expr | SpreadElement;

export type BinaryOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "**"
  | "=="
  | "!="
  | "==="
  | "!=="
  | ">"
  | ">="
  | "<"
  | "<="
  | "&&"
  | "||"
  | "??"
  | "in";

export type UnaryOp = "!" | "-";

export type Expr =
  | {
      type: "OperatorCall";
      name: string;
      /** positional = args are expressions; object = single ObjectLiteral arg */
      style: "positional" | "object";
      args: Expr[];
    }
  | { type: "FieldRef"; path: string }
  | { type: "NumberLiteral"; value: number }
  | { type: "StringLiteral"; value: string }
  | { type: "BooleanLiteral"; value: boolean }
  | { type: "NullLiteral" }
  | { type: "ArrayLiteral"; elements: ArrayElement[] }
  | { type: "ObjectLiteral"; entries: ObjectEntry[] }
  | { type: "BinaryExpr"; op: BinaryOp; left: Expr; right: Expr }
  | { type: "UnaryExpr"; op: UnaryOp; operand: Expr }
  | { type: "TernaryExpr"; condition: Expr; consequent: Expr; alternate: Expr }
  | { type: "IndexAccess"; object: Expr; index: Expr }
  | { type: "RegexLiteral"; pattern: string; flags: string }
  | { type: "ParamRef"; name: string }
  | { type: "MemberAccess"; object: Expr; member: string }
  | { type: "MethodCall"; object: Expr; method: string; args: Expr[] }
  | { type: "Lambda"; params: string[]; body: Expr }
  | { type: "TypeofExpr"; operand: Expr }
  | { type: "NewDate"; arg: Expr | null }
  | { type: "TypeCast"; cast: TypeCastOp; arg: Expr }
  | { type: "MathCall"; method: MathMethod; args: Expr[] }
  | { type: "ObjectCall"; method: ObjectMethod; args: Expr[] };

export type TypeCastOp = "Number" | "String" | "Boolean" | "parseInt" | "parseFloat";
export type MathMethod =
  | "abs"
  | "ceil"
  | "floor"
  | "round"
  | "pow"
  | "sqrt"
  | "exp"
  | "log"
  | "trunc";
export type ObjectMethod = "keys" | "values" | "entries" | "assign";
