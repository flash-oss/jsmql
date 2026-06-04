export type SpreadElement = { type: "SpreadElement"; argument: Expr; pos: number };

export type StaticKey = { kind: "static"; name: string };
export type ComputedKey = { kind: "computed"; expr: Expr };
export type ObjectKey = StaticKey | ComputedKey;

export type KeyValueEntry = { type: "KeyValueEntry"; key: ObjectKey; value: Expr; pos: number };

export type ObjectEntry = KeyValueEntry | SpreadElement;
// AssignExpr, DeleteStmt, and LetDecl are valid as ArrayElements ONLY when the
// array is a pipeline (first element is a stage candidate). Codegen for a
// non-pipeline ArrayLiteral throws on these — see codegen.ts:generateArrayLiteral.
export type ArrayElement = Expr | SpreadElement | AssignExpr | DeleteStmt | LetDecl;

/** Argument position that may be a spread (call sites that allow `...x`) */
export type CallArg = Expr | SpreadElement;

/**
 * Assignment statement: `$.path = value` (also reached via `+=`/`-=`/`*=`/`/=`,
 * which the parser desugars into a `=` plus the corresponding `BinaryExpr`).
 * `target` is restricted to a field-path expression (FieldRef or chained
 * MemberAccess rooted at a FieldRef); the parser enforces this at construction.
 */
export type AssignExpr = { type: "AssignExpr"; target: Expr; value: Expr; pos: number };

/** Statement form: `delete $.path`. Only legal at top level or as a pipeline element. */
export type DeleteStmt = { type: "DeleteStmt"; target: Expr; pos: number };

export type UpdateOp = AssignExpr | DeleteStmt;

/**
 * Pipeline-scoped local binding: `let <name> = <value>`. Only valid at the top
 * level of a pipeline (either as a `;`-separated PipelineStmt or as an element
 * inside a bracketed `[...]` pipeline). The value is materialised under a
 * single compiler-owned namespace (`__jsmql.<name>`) and the namespace is
 * `$unset` at the end of the pipeline. See `docs/specs/let-bindings.md`.
 */
export type LetDecl = { type: "LetDecl"; name: string; value: Expr; pos: number };

/**
 * Top-level **update filter**: one or more assignments and/or deletes,
 * separated by `,` in source. Lowers to a MongoDB Update Filter document
 * (the `{ $set: …, $unset: … }` shape passed as the second argument to
 * `db.coll.updateOne(filter, update)`). Distinct from `Expr` because the
 * constituent statements have document-level effect, not expression values.
 *
 * `;` is reserved for the top-level pipeline separator (see `Pipeline`)
 * and is not an update-filter separator.
 */
export type UpdateFilter = { type: "UpdateFilter"; ops: UpdateOp[]; pos: number };

/**
 * One element of an implicit pipeline (`;`-separated at top level). Each
 * element is lowered in isolation — an `UpdateFilter` may itself emit
 * multiple stages (read-after-write splits inside a `,`-grouped chain),
 * but adjacent elements never coalesce. `LetDecl` contributes one `$set`
 * stage plus a binding visible to subsequent statements (see
 * `generateImplicitPipeline`).
 */
export type PipelineStmt = UpdateFilter | Expr | LetDecl;

/**
 * Top-level pipeline assembled from `;`-separated statements. Distinct from
 * `ArrayLiteral`-shaped pipelines (`[...]`) because elements come pre-grouped
 * into stages and must NOT cross-coalesce. See `generateImplicitPipeline`.
 */
export type Pipeline = { type: "Pipeline"; stmts: PipelineStmt[]; pos: number };

/** What `Parser.parse()` returns: an expression, an update filter, or a `;`-separated pipeline. */
export type Program = Expr | UpdateFilter | Pipeline;

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
      pos: number;
    }
  | { type: "FieldRef"; path: string; pos: number }
  | { type: "CollectionRef"; pos: number } // $$  — postfix `.name` / `[expr]` composes via MemberAccess / IndexAccess
  | { type: "DatabaseRef"; pos: number } //   $$$
  | { type: "ClusterRef"; pos: number } //    $$$$
  | { type: "NumberLiteral"; value: number; pos: number }
  | { type: "BigIntLiteral"; value: string; pos: number }
  | { type: "StringLiteral"; value: string; pos: number }
  | { type: "BooleanLiteral"; value: boolean; pos: number }
  | { type: "NullLiteral"; pos: number }
  | { type: "UndefinedLiteral"; pos: number }
  | { type: "ArrayLiteral"; elements: ArrayElement[]; pos: number }
  | { type: "ObjectLiteral"; entries: ObjectEntry[]; pos: number }
  | { type: "TemplateLiteral"; quasis: string[]; expressions: Expr[]; pos: number }
  | { type: "BinaryExpr"; op: BinaryOp; left: Expr; right: Expr; pos: number }
  | { type: "UnaryExpr"; op: UnaryOp; operand: Expr; pos: number }
  | { type: "TernaryExpr"; condition: Expr; consequent: Expr; alternate: Expr; pos: number }
  | { type: "IndexAccess"; object: Expr; index: Expr; pos: number; optional?: boolean }
  | { type: "RegexLiteral"; pattern: string; flags: string; pos: number }
  | { type: "ParamRef"; name: string; pos: number }
  | { type: "MemberAccess"; object: Expr; member: string; pos: number; optional?: boolean }
  | { type: "MethodCall"; object: Expr; method: string; args: CallArg[]; pos: number; optional?: boolean }
  | { type: "CallExpression"; callee: Expr; args: CallArg[]; pos: number }
  | { type: "Lambda"; params: string[]; body?: Expr; block?: Pipeline; pos: number }
  | { type: "TypeofExpr"; operand: Expr; pos: number }
  | { type: "NewDate"; args: Expr[]; pos: number }
  | { type: "NewSet"; arg: Expr | null; pos: number }
  | { type: "TypeCast"; cast: TypeCastOp; arg: Expr; pos: number }
  | { type: "TypeCastRef"; cast: BareCastOp; pos: number }
  | { type: "MathCall"; method: MathMethod; args: CallArg[]; pos: number }
  | { type: "MathCallRef"; method: MathMethod; pos: number }
  | { type: "MathConst"; name: MathConstant; pos: number }
  | { type: "ObjectCall"; method: ObjectMethod; args: CallArg[]; pos: number }
  | { type: "ArrayFrom"; input: Expr; mapFn: Expr | null; pos: number }
  | { type: "NumberStatic"; method: NumberStaticMethod; arg: Expr; pos: number }
  | { type: "DateNow"; pos: number }
  | { type: "DateUTC"; args: Expr[]; pos: number };

export type TypeCastOp = "Number" | "String" | "Boolean" | "parseInt" | "parseFloat";
/** Type-cast names usable as bare callbacks (e.g. `arr.filter(Boolean)`).
 * Excludes parseInt/parseFloat because real-JS `arr.map(parseInt)` has the
 * famous index-as-radix footgun; users must write `x => parseInt(x)` to opt in. */
export type BareCastOp = "Number" | "String" | "Boolean";
// ── Recognised JS-builtin static/constructor names ─────────────────────────────
// Single source of truth for each closed name-set: the parser validates against
// these (and builds its `didYouMean` candidate lists from them), and codegen
// derives its dispatch signatures from the matching `…Method` type. Each list is
// `as const` so the derived union stays exhaustiveness-checked at the codegen
// switch — adding a name here surfaces a missing-case compile error there.
export const MATH_METHODS = [
  "abs",
  "ceil",
  "floor",
  "round",
  "pow",
  "sqrt",
  "exp",
  "log",
  "log2",
  "log10",
  "trunc",
  "min",
  "max",
  "sign",
  "hypot",
  "cbrt",
  "random",
  "sin",
  "cos",
  "tan",
  "asin",
  "acos",
  "atan",
  "atan2",
  "sinh",
  "cosh",
  "tanh",
  "asinh",
  "acosh",
  "atanh",
] as const;
export type MathMethod = (typeof MATH_METHODS)[number];

export const MATH_CONSTANTS = ["PI", "E"] as const;
export type MathConstant = (typeof MATH_CONSTANTS)[number];

export const OBJECT_METHODS = ["keys", "values", "entries", "assign", "fromEntries", "groupBy"] as const;
export type ObjectMethod = (typeof OBJECT_METHODS)[number];

export const NUMBER_STATICS = ["isInteger", "isNaN", "isFinite"] as const;
export type NumberStaticMethod = (typeof NUMBER_STATICS)[number];

// Set-receiver methods jsmql lowers to `$setIntersection` / `$setUnion` / etc.
// Previously the canonical list lived only in a codegen error string.
export const SET_METHODS = ["intersection", "union", "difference", "isSubsetOf", "isSupersetOf"] as const;
export type SetMethod = (typeof SET_METHODS)[number];
