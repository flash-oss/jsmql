// The tree the parser builds. Part of the registry, and a LEAF: it imports
// nothing, so `vocabulary.ts` can derive `NodeName` from it and every
// production's `becomes` is checked against a real shape.
//
// ── NAME-BLIND ───────────────────────────────────────────────────────────────
//
// The parser never checks a name against a set. `Math.max(a, b)` and
// `$.rows.max()` are ONE node type whose receiver differs, because they are one
// name on two receivers, and `names.ts` already says which families `max` serves:
//
//   Math.max($.a, $.b)   MethodCall { name: "max", object: Ident("Math") }
//   $.rows.max()         MethodCall { name: "max", object: FieldRef("rows") }
//
// That removed fourteen node types that existed only because the old parser knew
// particular names — MathCall, MathConst, ObjectCall, NumberStatic, NewSet,
// NewDate, DateNow, DateUTC, ArrayFrom, TypeCast, TypeCastRef, MathCallRef,
// ObjectIdRef, and ParamRef, which was indistinguishable from any other bare
// name. Resolving a name is `names.ts`'s job, in a later phase.
//
// `ObjectIdLiteral` stays, because `0x` followed by exactly 24 hex digits is a
// re-reading of a NUMBER token — a syntactic fact, not a name.

// ═════════════════════════════════════════════════════════════════════════════
// operators, spelled exactly as the source spells them
// ═════════════════════════════════════════════════════════════════════════════

export type BinaryOp =
  | "??"
  | "||"
  | "&&"
  | "|"
  | "^"
  | "&"
  | "==="
  | "!=="
  | "=="
  | "!="
  | ">"
  | ">="
  | "<"
  | "<="
  | "in"
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "**";

/** `typeof` is here rather than in its own node: it is a prefix operator. */
export type UnaryOp = "!" | "-" | "~" | "typeof";

/**
 * Every spelling that writes to its target. The compound and the increment forms
 * are kept AS WRITTEN so the parser stays free of meaning; the desugar phase
 * rewrites them to `=` over a `BinaryExpr`.
 */
export type AssignOp = "=" | "+=" | "-=" | "*=" | "/=" | "++" | "--";

// ═════════════════════════════════════════════════════════════════════════════
// pieces that are not expressions on their own
// ═════════════════════════════════════════════════════════════════════════════

export type SpreadElement = { type: "SpreadElement"; argument: Expr; pos: number };

export type ObjectKey =
  | { kind: "static"; name: string }
  /** `{ ["a" + "b"]: 1 }` — the key is computed at run time. */
  | { kind: "computed"; expr: Expr };

export type KeyValueEntry = { type: "KeyValueEntry"; key: ObjectKey; value: Expr; pos: number };
export type ObjectEntry = KeyValueEntry | SpreadElement;
/**
 * An array literal's element. A STATEMENT is allowed because the bracketed
 * pipeline form writes its stages as an array:
 *   [const double = x => x * 2, $set({ y: double($.x) })]
 * Which array literals may hold one is the position phase's question, not the
 * parser's — it records what was written.
 */
/**
 * One element of an array literal. The write cases are what make a bracketed
 * literal a PIPELINE, and a `,`-joined run of them is one `UpdateFilter` — one
 * element, one stage, however many fields it writes.
 */
export type ArrayElement = Expr | SpreadElement | LetDecl | FuncDecl | UpdateOp | UpdateFilter;
export type CallArg = Expr | SpreadElement;

/**
 * One slot of the entry form's parameter destructure. Held BESIDE the tree, not
 * in it — `destructuringParam` in productions.ts says `notANode` for this reason.
 * A `$`-family key binds a compiler service; a bare name binds a query parameter.
 */
export type ParamBinding = {
  /** The key as written: `$`, `$$`, `$op`, or a plain name. */
  key: string;
  /** The local name it binds to, which `key: alias` may rename. */
  name: string;
  pos: number;
};

// ═════════════════════════════════════════════════════════════════════════════
// expressions
// ═════════════════════════════════════════════════════════════════════════════

export type Expr =
  // ── literals ──────────────────────────────────────────────────────────────
  | { type: "NumberLiteral"; value: number; pos: number }
  | { type: "BigIntLiteral"; value: string; pos: number }
  | { type: "StringLiteral"; value: string; pos: number }
  | { type: "BooleanLiteral"; value: boolean; pos: number }
  | { type: "NullLiteral"; pos: number }
  | { type: "UndefinedLiteral"; pos: number }
  | { type: "RegexLiteral"; pattern: string; flags: string; pos: number }
  /** `0x` and exactly 24 hex digits. A re-reading of a Number token. */
  | { type: "ObjectIdLiteral"; hex: string; pos: number }
  | { type: "TemplateLiteral"; quasis: readonly string[]; exprs: readonly Expr[]; pos: number }
  | { type: "ArrayLiteral"; elements: readonly ArrayElement[]; pos: number }
  | { type: "ObjectLiteral"; entries: readonly ObjectEntry[]; pos: number }

  // ── references ────────────────────────────────────────────────────────────
  /** `$.a.b` and the bare `$`, which is the whole document and has an empty path. */
  | { type: "FieldRef"; path: string; pos: number }
  /**
   * `$$` — the current collection, as a stream of documents.
   *
   * Three spellings, three node types, never one node with a level. They are
   * three different things: `$$` is a stream you may filter and replace, `$$$`
   * names another collection to read or write, and `$$$$` reaches the cluster and
   * cannot be read from at all. A reader that had to check a number before
   * knowing which it held would carry that check everywhere.
   *
   * The postfix `.name` and `[expr]` compose on top through MemberAccess and
   * IndexAccess, so none of the three carries a path of its own.
   */
  | { type: "CollectionRef"; pos: number }
  /** `$$$` — database scope. `$$$.<coll>` names another collection. */
  | { type: "DatabaseRef"; pos: number }
  /** `$$$$` — cluster scope. Writes work; cross-database reads are refused. */
  | { type: "ClusterRef"; pos: number }
  /**
   * A bare name. `Math`, `String`, a lambda's parameter, a `let` binding, a
   * declared function — all of them. WHICH it is comes from scope and from
   * `names.ts`, never from the parser.
   */
  | { type: "Ident"; name: string; pos: number }

  // ── access and application ────────────────────────────────────────────────
  | { type: "MemberAccess"; object: Expr; name: string; optional: boolean; pos: number }
  | { type: "IndexAccess"; object: Expr; index: Expr; optional: boolean; pos: number }
  | { type: "MethodCall"; object: Expr; name: string; args: readonly CallArg[]; optional: boolean; pos: number }
  | { type: "CallExpression"; callee: Expr; args: readonly CallArg[]; pos: number }
  /** `new X(…)`. The callee is an `Ident`; which constructor it is comes later. */
  | { type: "NewExpression"; callee: Expr; args: readonly CallArg[]; pos: number }
  /**
   * The `$op(…)` escape hatch. `style` records how the source wrote the
   * arguments, because a positional call maps onto the key order the operator's
   * row states and an object call does not.
   */
  | { type: "OperatorCall"; name: string; style: "positional" | "object"; args: readonly CallArg[]; pos: number }

  // ── operators ─────────────────────────────────────────────────────────────
  | { type: "UnaryExpr"; op: UnaryOp; argument: Expr; pos: number }
  | { type: "BinaryExpr"; op: BinaryOp; left: Expr; right: Expr; pos: number }
  | { type: "TernaryExpr"; test: Expr; consequent: Expr; alternate: Expr; pos: number }

  // ── bodies ────────────────────────────────────────────────────────────────
  | {
      type: "Lambda";
      params: readonly string[];
      /** A JavaScript body. Absent exactly when `stages` is present. */
      body?: Expr;
      /**
       * A body whose statements are pipeline STAGES. Only a name whose row says
       * `blockBody: "stages"` gives its callback this meaning — every other name's
       * block is JavaScript, and a stage inside one is refused.
       */
      stages?: Pipeline;
      pos: number;
    }
  /** `x => { const y = x * 2; return y }` — declarations, then one result. */
  | { type: "ExprBlock"; decls: readonly LetDecl[]; ret: Expr; pos: number };

// ═════════════════════════════════════════════════════════════════════════════
// statements
// ═════════════════════════════════════════════════════════════════════════════

export type LetDecl = { type: "LetDecl"; name: string; value: Expr; kind: "let" | "const"; pos: number };

export type FuncDecl = {
  type: "FuncDecl";
  name: string;
  lambda: Extract<Expr, { type: "Lambda" }>;
  kind: "let" | "const";
  /** Two spellings, one node. `function` is not reserved — it lexes as a name. */
  form: "arrow" | "function";
  pos: number;
};

/** A write. `op` is the spelling as written; desugar reduces it to `=`. */
export type AssignExpr = { type: "AssignExpr"; target: Expr; op: AssignOp; value: Expr; pos: number };
export type DeleteStmt = { type: "DeleteStmt"; target: Expr; pos: number };
export type UpdateOp = AssignExpr | DeleteStmt;

/** A `,`-joined run of writes: `$.a = 1, delete $.b`. */
export type UpdateFilter = { type: "UpdateFilter"; ops: readonly UpdateOp[]; pos: number };

export type PipelineStmt = UpdateFilter | Expr | LetDecl | FuncDecl;
export type Pipeline = { type: "Pipeline"; stmts: readonly PipelineStmt[]; pos: number };

/** What the parser hands back. */
export type Program = Expr | UpdateFilter | Pipeline;

/** The lambda variant, named so a parser can return it directly. */
export type Lambda = Extract<Expr, { type: "Lambda" }>;

/** Every node the parser can build, for `becomes` in productions.ts. */
export type Node = Expr | SpreadElement | KeyValueEntry | LetDecl | FuncDecl | UpdateOp | UpdateFilter | Pipeline;
