export type SpreadElement = {
  type: "SpreadElement";
  argument: Expr;
};

export type StaticKey = { kind: "static"; name: string };
export type ComputedKey = { kind: "computed"; expr: Expr };
export type ObjectKey = StaticKey | ComputedKey;

export type KeyValueEntry = {
  type: "KeyValueEntry";
  key: ObjectKey;
  value: Expr;
};

export type ObjectEntry = KeyValueEntry | SpreadElement;
// AssignExpr and DeleteStmt are valid as ArrayElements ONLY when the array is
// a pipeline (first element is a stage candidate). Codegen for a non-pipeline
// ArrayLiteral throws on these — see codegen.ts:generateArrayLiteral.
export type ArrayElement = Expr | SpreadElement | AssignExpr | DeleteStmt;

/** Argument position that may be a spread (call sites that allow `...x`) */
export type CallArg = Expr | SpreadElement;

/**
 * Assignment statement: `$.path = value` (also reached via `+=`/`-=`/`*=`/`/=`,
 * which the parser desugars into a `=` plus the corresponding `BinaryExpr`).
 * `target` is restricted to a field-path expression (FieldRef or chained
 * MemberAccess rooted at a FieldRef); the parser enforces this at construction.
 */
export type AssignExpr = {
  type: "AssignExpr";
  target: Expr;
  value: Expr;
};

/** Statement form: `delete $.path`. Only legal at top level or as a pipeline element. */
export type DeleteStmt = {
  type: "DeleteStmt";
  target: Expr;
};

export type Mutation = AssignExpr | DeleteStmt;

/**
 * Top-level mutation program: one or more assignments and/or deletes,
 * separated by `,` in source. Distinct from `Expr` because mutations
 * are statements with stage-level effect, not expression values.
 *
 * `;` is reserved for the top-level pipeline separator (see `Pipeline`)
 * and is not a mutation-chain separator.
 */
export type MutationProgram = {
  type: "MutationProgram";
  mutations: Mutation[];
};

/**
 * One element of an implicit pipeline (`;`-separated at top level). Each
 * element is lowered in isolation — a `MutationProgram` may itself emit
 * multiple stages (read-after-write splits inside a `,`-grouped chain),
 * but adjacent elements never coalesce.
 */
export type PipelineStmt = MutationProgram | Expr;

/**
 * Top-level pipeline assembled from `;`-separated statements. Distinct from
 * `ArrayLiteral`-shaped pipelines (`[...]`) because elements come pre-grouped
 * into stages and must NOT cross-coalesce. See `generateImplicitPipeline`.
 */
export type Pipeline = {
  type: "Pipeline";
  stmts: PipelineStmt[];
};

/** What `Parser.parse()` returns: an expression, a mutation program, or a `;`-separated pipeline. */
export type Program = Expr | MutationProgram | Pipeline;

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
  | "&"
  | "|"
  | "^"
  | "&&"
  | "||"
  | "??"
  | "in";

export type UnaryOp = "!" | "-" | "~";

export type Expr =
  | {
      type: "OperatorCall";
      name: string;
      /** positional = args are expressions; object = single ObjectLiteral arg */
      style: "positional" | "object";
      args: CallArg[];
    }
  | { type: "FieldRef"; path: string }
  | { type: "NumberLiteral"; value: number }
  | { type: "BigIntLiteral"; value: string }
  | { type: "StringLiteral"; value: string }
  | { type: "BooleanLiteral"; value: boolean }
  | { type: "NullLiteral" }
  | { type: "ArrayLiteral"; elements: ArrayElement[] }
  | { type: "ObjectLiteral"; entries: ObjectEntry[] }
  | { type: "TemplateLiteral"; quasis: string[]; expressions: Expr[] }
  | { type: "BinaryExpr"; op: BinaryOp; left: Expr; right: Expr }
  | { type: "UnaryExpr"; op: UnaryOp; operand: Expr }
  | { type: "TernaryExpr"; condition: Expr; consequent: Expr; alternate: Expr }
  | { type: "IndexAccess"; object: Expr; index: Expr }
  | { type: "RegexLiteral"; pattern: string; flags: string }
  | { type: "ParamRef"; name: string }
  | { type: "MemberAccess"; object: Expr; member: string }
  | { type: "MethodCall"; object: Expr; method: string; args: CallArg[] }
  | { type: "CallExpression"; callee: Expr; args: CallArg[] }
  | { type: "Lambda"; params: string[]; body: Expr }
  | { type: "TypeofExpr"; operand: Expr }
  | { type: "NewDate"; arg: Expr | null }
  | { type: "NewSet"; arg: Expr | null }
  | { type: "TypeCast"; cast: TypeCastOp; arg: Expr }
  | { type: "MathCall"; method: MathMethod; args: CallArg[] }
  | { type: "MathConst"; name: MathConstant }
  | { type: "ObjectCall"; method: ObjectMethod; args: CallArg[] }
  | { type: "ArrayFrom"; input: Expr; mapFn: Expr | null }
  | { type: "NumberStatic"; method: NumberStaticMethod; arg: Expr }
  | { type: "DateNow" };

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
  | "log2"
  | "log10"
  | "trunc"
  | "min"
  | "max"
  | "sign"
  | "hypot"
  | "cbrt"
  | "random"
  | "sin"
  | "cos"
  | "tan"
  | "asin"
  | "acos"
  | "atan"
  | "atan2"
  | "sinh"
  | "cosh"
  | "tanh"
  | "asinh"
  | "acosh"
  | "atanh";
export type MathConstant = "PI" | "E";
export type ObjectMethod = "keys" | "values" | "entries" | "assign" | "fromEntries" | "groupBy";
export type NumberStaticMethod = "isInteger" | "isNaN" | "isFinite";
