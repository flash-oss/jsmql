export function isFieldPathString(e: { type: string; value?: unknown; text?: true }): boolean {
  return e.type === "StringLiteral" && typeof e.value === "string" && e.value.startsWith("$") && e.text !== true;
}

export const BINARY_OPS = [
  "??",
  "||",
  "&&",
  "|",
  "^",
  "&",
  "===",
  "!==",
  "==",
  "!=",
  ">",
  ">=",
  "<",
  "<=",
  "in",
  "+",
  "-",
  "*",
  "/",
  "%",
  "**",
] as const;
export type BinaryOp = (typeof BINARY_OPS)[number];

export const UNARY_OPS = ["!", "-", "~", "typeof"] as const;
export type UnaryOp = (typeof UNARY_OPS)[number];

export const ASSIGN_OPS = ["=", "+=", "-=", "*=", "/=", "++", "--"] as const;
export type AssignOp = (typeof ASSIGN_OPS)[number];

export type SpreadElement = { type: "SpreadElement"; argument: Expr; pos: number };

export type ObjectKey = { kind: "static"; name: string } | { kind: "computed"; expr: Expr };

export type KeyValueEntry = { type: "KeyValueEntry"; key: ObjectKey; value: Expr; pos: number };
export type ObjectEntry = KeyValueEntry | SpreadElement;
export type ArrayElement = Expr | SpreadElement | FuncDecl | UpdateOp | UpdateFilter;
export type CallArg = Expr | SpreadElement;

export type ParamBinding = { key: string; name: string; pos: number };

export type Expr =
  | { type: "NumberLiteral"; value: number; pos: number }
  | { type: "BigIntLiteral"; value: string; pos: number }
  | { type: "StringLiteral"; value: string; pos: number; text?: true }
  | { type: "BooleanLiteral"; value: boolean; pos: number }
  | { type: "NullLiteral"; pos: number }
  | { type: "UndefinedLiteral"; pos: number }
  | { type: "RegexLiteral"; pattern: string; flags: string; injected?: RegExp; pos: number }
  | { type: "ObjectIdLiteral"; hex: string; pos: number }
  | { type: "Injected"; value: unknown; pos: number }
  | { type: "TemplateLiteral"; quasis: readonly string[]; exprs: readonly Expr[]; pos: number }
  | { type: "ArrayLiteral"; elements: readonly ArrayElement[]; pos: number; packed?: true }
  | { type: "ObjectLiteral"; entries: readonly ObjectEntry[]; pos: number }
  | { type: "FieldRef"; path: string; optional?: true; optionalAt?: string; pos: number }
  | { type: "StreamRef"; pos: number }
  | { type: "DatabaseRef"; pos: number }
  | { type: "ClusterRef"; pos: number }
  | { type: "Ident"; name: string; pos: number; minted?: true }
  | { type: "MemberAccess"; object: Expr; name: string; optional: boolean; pos: number }
  | {
      type: "IndexAccess";
      object: Expr;
      index: Expr;
      optional: boolean;
      pos: number;
      iteratee?: { readonly method: string; readonly slot: number };
    }
  | {
      type: "MethodCall";
      object: Expr;
      name: string;
      wrote?: string;
      args: readonly CallArg[];
      optional: boolean;
      pos: number;
    }
  | { type: "CallExpression"; callee: Expr; args: readonly CallArg[]; pos: number }
  | { type: "NewExpression"; callee: Expr; args: readonly CallArg[]; pos: number }
  | { type: "OperatorCall"; name: string; args: readonly CallArg[]; pos: number }
  | { type: "UnaryExpr"; op: UnaryOp; argument: Expr; pos: number }
  | { type: "BinaryExpr"; op: BinaryOp; left: Expr; right: Expr; pos: number }
  | { type: "TernaryExpr"; test: Expr; consequent: Expr; alternate: Expr; pos: number }
  | { type: "Lambda"; params: readonly string[]; body?: Expr; stages?: Pipeline; pos: number }
  | { type: "ExprBlock"; decls: readonly LetDecl[]; ret: Expr; pos: number };

export type LetDecl = { type: "LetDecl"; name: string; value: Expr; kind: "let" | "const"; group: number; pos: number };

export type FuncDecl = {
  type: "FuncDecl";
  name: string;
  lambda: Extract<Expr, { type: "Lambda" }>;
  kind: "let" | "const";
  form: "arrow" | "function";
  group: number;
  pos: number;
};

export type AssignExpr = { type: "AssignExpr"; target: Expr; op: AssignOp; value: Expr; pos: number; mutates?: true };
export type DeleteStmt = { type: "DeleteStmt"; target: Expr; pos: number };
export type UpdateOp = AssignExpr | DeleteStmt;

export type UpdateFilter = { type: "UpdateFilter"; ops: readonly UpdateOp[]; pos: number };

export type PipelineStmt = UpdateFilter | Expr | LetDecl | FuncDecl;
export type Pipeline = { type: "Pipeline"; stmts: readonly PipelineStmt[]; pos: number };

export type Program = Expr | UpdateFilter | Pipeline;

export type Lambda = Extract<Expr, { type: "Lambda" }>;

export type Node = Expr | SpreadElement | KeyValueEntry | LetDecl | FuncDecl | UpdateOp | UpdateFilter | Pipeline;
