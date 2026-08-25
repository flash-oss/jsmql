// REGISTRY 3 of 4 — the grammar. SYNTACTIC phase.
//
// Keyed by a DESCRIPTIVE name, never by a symbol: `remainder`, not `"%"`. A rule's
// symbols are in its `tokens` field, which names keys of tokens.ts or keywords.ts and is
// audited below — so a rule cannot reference a token that does not exist, and a token
// nobody combines shows up as an unused key.
//
// `precedence` runs 1 (loosest, `conditional`) to 14 (tightest, postfix) and mirrors the
// order of the parser's 14 cascade methods. It is absent on rows that are not operators:
// `++` and `--` are statement-level and appear nowhere in that cascade, so a number for
// them would be invented.
//
// `becomes` holds a LIST where one rule builds more than one node (`namespacedCall`
// covers seven), and `{ notANode: … }` where a rule produces something the parser keeps
// beside the tree rather than in it (`destructuringParam`).
//
// This is where MQL enters the language side. tokens.ts and keywords.ts hold none.

import type { NodeName, On, Only, Position, Returns } from "./vocabulary.ts";
import { composedInto, pending, unsupported, viaFallback } from "./vocabulary.ts";
import type { Cell, ExprIn, FilterIn, Lists, Of, QueryDoc, Stage, StageIn } from "./vocabulary.ts";
import type { TokenKey } from "./tokens.ts";
import type { KeywordKey } from "./keywords.ts";

/** What a rule's `tokens` may name: a token, or a reserved word. */
export type Lexeme = TokenKey | KeywordKey;

export type ProductionSpec<
  T extends readonly Lexeme[],
  W extends readonly Position[],
  O extends On,
  A extends readonly string[] = readonly never[],
  /** The owners this rule's one `composedInto` cell names. See Cell's `C`. */
  C extends readonly string[] = readonly never[],
> = {
  doc: string;
  /** The symbols this rule consumes — keys of tokens.ts or keywords.ts. */
  tokens: T;
  /** The AST node it builds; a list when it builds several; or nothing at all. */
  becomes: NodeName | readonly NodeName[] | { notANode: string };
  /** 1 = loosest … 14 = tightest. Absent when the rule is not in the cascade. */
  precedence?: number;
  /** "none" for a NON-CHAINABLE operator: `1 === 2 === 3` is a parse error. */
  associativity?: "left" | "right" | "none";
  fixity?: "prefix" | "infix" | "postfix" | "ternary" | "prefixOrPostfix";
  on: O;
  returns: Returns;
  where: W;
  only?: readonly Only[];
  /** Rules this must be tried AFTER, when triggers overlap. Audited below. */
  after?: A;
  /**
   * Rules this one may NOT combine with unparenthesised, because JAVASCRIPT
   * forbids the mix. A precedence number always permits a mix, so the cascade
   * cannot state this and every such pair went unnoticed. Measured with
   * `node --check`:
   *   a ?? b || c    → SyntaxError: Unexpected token '||'
   *   typeof a ** b  → SyntaxError: Unparenthesized unary expression can't
   *                    appear on the left-hand side of '**'
   * JSMQL accepts every expression of valid JavaScript syntax and no others, so
   * a pair listed here must be a parse error.
   */
  noMixWith?: readonly string[];
  /**
   * true when this construct may not appear on the left of `=`, `++` or `--`.
   * JavaScript refuses `a?.b = 1` outright, so an optional chain is never a
   * write target. Stated because the write rules live on the ASSIGNMENT rows and
   * cannot see which operand shapes reached them.
   */
  neverAWriteTarget?: true;
  filter: Cell<Lists<W, "filter">, Of<O>, FilterIn, QueryDoc, C>;
  expr: Cell<Lists<W, "value">, Of<O>, ExprIn, unknown, C>;
  /** A link in a `$$ = $$…` chain. */
  stream: Cell<Lists<W, "stream">, Of<O>, StageIn, Stage[], C>;
  /** A `;`-separated statement. SEPARATE from `stream` — see Position. */
  statement: Cell<Lists<W, "statement">, Of<O>, StageIn, Stage[], C>;
};

export type ProductionEntry<
  T extends readonly Lexeme[],
  W extends readonly Position[],
  O extends On,
  A extends readonly string[] = readonly never[],
  C extends readonly string[] = readonly never[],
> = ProductionSpec<T, W, O, A, C> & { kind: "production" };

// Every generic defaults to the EMPTY type, never to its constraint — a rule with no
// `after` would otherwise widen `A` to `readonly string[]` and the audit below would
// pass while checking nothing.
const production = <
  const T extends readonly Lexeme[],
  const W extends readonly Position[],
  const O extends On,
  const A extends readonly string[] = readonly never[],
  const C extends readonly string[] = readonly never[],
>(
  e: ProductionSpec<T, W, O, A, C>,
): ProductionEntry<T, W, O, A, C> => ({ ...e, kind: "production" });

export const PRODUCTIONS = {
  conditional: production({
    doc: "Chooses between two values on a condition.",
    tokens: ["?", ":"],
    becomes: "TernaryExpr",
    precedence: 1,
    associativity: "right",
    fixity: "ternary",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: pending("src/codegen.ts"),
    stream: unsupported("'conditional' produces a value, not a stage."),
    statement: unsupported("'.conditional()' is not a statement — see its 'where'."),
  }),

  nullishCoalescing: production({
    doc: "The left value unless it is null or missing.",
    tokens: ["??"],
    becomes: "BinaryExpr",
    precedence: 2,
    associativity: "left",
    fixity: "infix",
    noMixWith: ["logicalOr", "logicalAnd"],
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: pending("src/codegen.ts"),
    stream: unsupported("'nullishCoalescing' produces a value, not a stage."),
    statement: unsupported("'.nullishCoalescing()' is not a statement — see its 'where'."),
  }),

  logicalOr: production({
    doc: "True when either side is true.",
    tokens: ["||"],
    becomes: "BinaryExpr",
    precedence: 3,
    associativity: "left",
    fixity: "infix",
    on: "any",
    returns: "unknown",
    where: ["value", "filter"],
    filter: pending("src/match-translation.ts"),
    expr: pending("src/codegen.ts"),
    stream: unsupported("'logicalOr' produces a value, not a stage."),
    statement: unsupported("'.logicalOr()' is not a statement — see its 'where'."),
  }),

  logicalAnd: production({
    doc: "True when both sides are true.",
    tokens: ["&&"],
    becomes: "BinaryExpr",
    precedence: 4,
    associativity: "left",
    fixity: "infix",
    on: "any",
    returns: "unknown",
    where: ["value", "filter"],
    filter: pending("src/match-translation.ts"),
    expr: pending("src/codegen.ts"),
    stream: unsupported("'logicalAnd' produces a value, not a stage."),
    statement: unsupported("'.logicalAnd()' is not a statement — see its 'where'."),
  }),

  bitwiseOr: production({
    doc: "Bitwise OR of two integers.",
    tokens: ["|"],
    becomes: "BinaryExpr",
    precedence: 5,
    associativity: "left",
    fixity: "infix",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: pending("src/codegen.ts"),
    stream: unsupported("'bitwiseOr' produces a value, not a stage."),
    statement: unsupported("'.bitwiseOr()' is not a statement — see its 'where'."),
  }),

  bitwiseXor: production({
    doc: "Bitwise XOR of two integers.",
    tokens: ["^"],
    becomes: "BinaryExpr",
    precedence: 6,
    associativity: "left",
    fixity: "infix",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: pending("src/codegen.ts"),
    stream: unsupported("'bitwiseXor' produces a value, not a stage."),
    statement: unsupported("'.bitwiseXor()' is not a statement — see its 'where'."),
  }),

  bitwiseAnd: production({
    doc: "Bitwise AND of two integers.",
    tokens: ["&"],
    becomes: "BinaryExpr",
    precedence: 7,
    associativity: "left",
    fixity: "infix",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: pending("src/codegen.ts"),
    stream: unsupported("'bitwiseAnd' produces a value, not a stage."),
    statement: unsupported("'.bitwiseAnd()' is not a statement — see its 'where'."),
  }),

  strictEquality: production({
    doc: "True when both sides are equal, without coercion.",
    tokens: ["==="],
    becomes: "BinaryExpr",
    precedence: 8,
    associativity: "none",
    fixity: "infix",
    on: "any",
    returns: "unknown",
    where: ["value", "filter"],
    filter: pending("src/match-translation.ts"),
    expr: pending("src/codegen.ts"),
    stream: unsupported("'strictEquality' produces a value, not a stage."),
    statement: unsupported("'.strictEquality()' is not a statement — see its 'where'."),
  }),

  strictInequality: production({
    doc: "True when the sides differ, without coercion.",
    tokens: ["!=="],
    becomes: "BinaryExpr",
    precedence: 8,
    associativity: "none",
    fixity: "infix",
    on: "any",
    returns: "unknown",
    where: ["value", "filter"],
    filter: pending("src/match-translation.ts"),
    expr: pending("src/codegen.ts"),
    stream: unsupported("'strictInequality' produces a value, not a stage."),
    statement: unsupported("'.strictInequality()' is not a statement — see its 'where'."),
  }),

  looseEquality: production({
    doc: "True when both sides are equal, treating null and missing alike.",
    tokens: ["=="],
    becomes: "BinaryExpr",
    precedence: 8,
    associativity: "none",
    fixity: "infix",
    on: "any",
    returns: "unknown",
    where: ["value", "filter"],
    filter: pending("src/match-translation.ts"),
    expr: pending("src/codegen.ts"),
    stream: unsupported("'looseEquality' produces a value, not a stage."),
    statement: unsupported("'.looseEquality()' is not a statement — see its 'where'."),
  }),

  looseInequality: production({
    doc: "True when the sides differ, treating null and missing alike.",
    tokens: ["!="],
    becomes: "BinaryExpr",
    precedence: 8,
    associativity: "none",
    fixity: "infix",
    on: "any",
    returns: "unknown",
    where: ["value", "filter"],
    filter: pending("src/match-translation.ts"),
    expr: pending("src/codegen.ts"),
    stream: unsupported("'looseInequality' produces a value, not a stage."),
    statement: unsupported("'.looseInequality()' is not a statement — see its 'where'."),
  }),

  greaterThan: production({
    doc: "True when the left side is greater.",
    tokens: [">"],
    becomes: "BinaryExpr",
    precedence: 9,
    associativity: "none",
    fixity: "infix",
    on: "any",
    returns: "unknown",
    where: ["value", "filter"],
    filter: pending("src/match-translation.ts"),
    expr: pending("src/codegen.ts"),
    stream: unsupported("'greaterThan' produces a value, not a stage."),
    statement: unsupported("'.greaterThan()' is not a statement — see its 'where'."),
  }),

  greaterOrEqual: production({
    doc: "True when the left side is greater or equal.",
    tokens: [">="],
    becomes: "BinaryExpr",
    precedence: 9,
    associativity: "none",
    fixity: "infix",
    on: "any",
    returns: "unknown",
    where: ["value", "filter"],
    filter: pending("src/match-translation.ts"),
    expr: pending("src/codegen.ts"),
    stream: unsupported("'greaterOrEqual' produces a value, not a stage."),
    statement: unsupported("'.greaterOrEqual()' is not a statement — see its 'where'."),
  }),

  lessThan: production({
    doc: "True when the left side is smaller.",
    tokens: ["<"],
    becomes: "BinaryExpr",
    precedence: 9,
    associativity: "none",
    fixity: "infix",
    on: "any",
    returns: "unknown",
    where: ["value", "filter"],
    filter: pending("src/match-translation.ts"),
    expr: pending("src/codegen.ts"),
    stream: unsupported("'lessThan' produces a value, not a stage."),
    statement: unsupported("'.lessThan()' is not a statement — see its 'where'."),
  }),

  lessOrEqual: production({
    doc: "True when the left side is smaller or equal.",
    tokens: ["<="],
    becomes: "BinaryExpr",
    precedence: 9,
    associativity: "none",
    fixity: "infix",
    on: "any",
    returns: "unknown",
    where: ["value", "filter"],
    filter: pending("src/match-translation.ts"),
    expr: pending("src/codegen.ts"),
    stream: unsupported("'lessOrEqual' produces a value, not a stage."),
    statement: unsupported("'.lessOrEqual()' is not a statement — see its 'where'."),
  }),

  membership: production({
    doc: "True when the value is an element of the array.",
    tokens: ["in"],
    becomes: "BinaryExpr",
    precedence: 9,
    associativity: "none",
    fixity: "infix",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: pending("src/codegen.ts"),
    stream: unsupported("'membership' produces a value, not a stage."),
    statement: unsupported("'.membership()' is not a statement — see its 'where'."),
  }),

  addition: production({
    doc: "Adds numbers, or adds to a date.",
    tokens: ["+"],
    becomes: "BinaryExpr",
    precedence: 10,
    associativity: "left",
    fixity: "infix",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: pending("src/codegen.ts"),
    stream: unsupported("'addition' produces a value, not a stage."),
    statement: unsupported("'.addition()' is not a statement — see its 'where'."),
  }),

  subtraction: production({
    doc: "Subtracts numbers or dates.",
    tokens: ["-"],
    becomes: "BinaryExpr",
    precedence: 10,
    associativity: "left",
    fixity: "infix",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: pending("src/codegen.ts"),
    stream: unsupported("'subtraction' produces a value, not a stage."),
    statement: unsupported("'.subtraction()' is not a statement — see its 'where'."),
  }),

  multiplication: production({
    doc: "Multiplies numbers.",
    tokens: ["*"],
    becomes: "BinaryExpr",
    precedence: 11,
    associativity: "left",
    fixity: "infix",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: pending("src/codegen.ts"),
    stream: unsupported("'multiplication' produces a value, not a stage."),
    statement: unsupported("'.multiplication()' is not a statement — see its 'where'."),
  }),

  division: production({
    doc: "Divides the left number by the right.",
    tokens: ["/"],
    becomes: "BinaryExpr",
    precedence: 11,
    associativity: "left",
    fixity: "infix",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: pending("src/codegen.ts"),
    stream: unsupported("'division' produces a value, not a stage."),
    statement: unsupported("'.division()' is not a statement — see its 'where'."),
  }),

  remainder: production({
    doc: "The remainder after division.",
    tokens: ["%"],
    becomes: "BinaryExpr",
    precedence: 11,
    associativity: "left",
    fixity: "infix",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: composedInto("strictEquality", "strictInequality"),
    expr: pending("src/codegen.ts"),
    stream: unsupported("'remainder' produces a value, not a stage."),
    statement: unsupported("'.remainder()' is not a statement — see its 'where'."),
  }),

  exponentiation: production({
    doc: "Raises the left number to the right power.",
    tokens: ["**"],
    becomes: "BinaryExpr",
    precedence: 12,
    associativity: "right",
    fixity: "infix",
    noMixWith: ["logicalNot", "bitwiseNot", "typeCheck", "negation"],
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: pending("src/codegen.ts"),
    stream: unsupported("'exponentiation' produces a value, not a stage."),
    statement: unsupported("'.exponentiation()' is not a statement — see its 'where'."),
  }),

  logicalNot: production({
    doc: "Inverts a condition.",
    tokens: ["!"],
    becomes: "UnaryExpr",
    precedence: 13,
    associativity: "right",
    fixity: "prefix",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: pending("src/codegen.ts"),
    stream: unsupported("'logicalNot' produces a value, not a stage."),
    statement: unsupported("'.logicalNot()' is not a statement — see its 'where'."),
  }),

  negation: production({
    doc: "Negates a number. Binds tighter than `**`, unlike JavaScript.",
    tokens: ["-"],
    becomes: "UnaryExpr",
    precedence: 13,
    associativity: "right",
    fixity: "prefix",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: pending("src/codegen.ts"),
    stream: unsupported("'negation' produces a value, not a stage."),
    statement: unsupported("'.negation()' is not a statement — see its 'where'."),
  }),

  bitwiseNot: production({
    doc: "Inverts the bits of an integer.",
    tokens: ["~"],
    becomes: "UnaryExpr",
    precedence: 13,
    associativity: "right",
    fixity: "prefix",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: pending("src/codegen.ts"),
    stream: unsupported("'bitwiseNot' produces a value, not a stage."),
    statement: unsupported("'.bitwiseNot()' is not a statement — see its 'where'."),
  }),

  typeCheck: production({
    doc: "The type name of a value.",
    tokens: ["typeof"],
    // `typeof` is a prefix operator, so it needs no node of its own.
    becomes: "UnaryExpr",
    precedence: 13,
    associativity: "right",
    fixity: "prefix",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: composedInto("strictEquality", "strictInequality"),
    expr: pending("src/codegen.ts"),
    stream: unsupported("'typeCheck' produces a value, not a stage."),
    statement: unsupported("'.typeCheck()' is not a statement — see its 'where'."),
  }),

  memberAccess: production({
    doc: "Reads a field, or dispatches a name onto a receiver.",
    tokens: [".", "identifier"],
    becomes: "MemberAccess",
    precedence: 14,
    associativity: "left",
    fixity: "postfix",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: composedInto(
      "strictEquality",
      "strictInequality",
      "greaterThan",
      "greaterOrEqual",
      "lessThan",
      "lessOrEqual",
      "methodCall",
      "operatorCall",
    ),
    expr: pending("src/codegen.ts"),
    stream: unsupported("'memberAccess' produces a value, not a stage."),
    statement: unsupported("'.memberAccess()' is not a statement — see its 'where'."),
  }),

  optionalMemberAccess: production({
    doc: "Reads a field, yielding nothing when the receiver is absent.",
    tokens: ["?."],
    becomes: "MemberAccess",
    precedence: 14,
    associativity: "left",
    fixity: "postfix",
    neverAWriteTarget: true,
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: composedInto(
      "strictEquality",
      "strictInequality",
      "greaterThan",
      "greaterOrEqual",
      "lessThan",
      "lessOrEqual",
      "methodCall",
      "operatorCall",
    ),
    expr: pending("src/codegen.ts"),
    stream: unsupported("'optionalMemberAccess' produces a value, not a stage."),
    statement: unsupported("'.optionalMemberAccess()' is not a statement — see its 'where'."),
  }),

  indexAccess: production({
    doc: "Reads an element by index, or a field by computed name.",
    tokens: ["[", "]", "?."],
    becomes: "IndexAccess",
    precedence: 14,
    associativity: "left",
    fixity: "postfix",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: pending("src/codegen.ts"),
    stream: unsupported("'indexAccess' produces a value, not a stage."),
    statement: unsupported("'.indexAccess()' is not a statement — see its 'where'."),
  }),

  call: production({
    doc: "Applies a callable to arguments.",
    tokens: ["(", ")", ","],
    becomes: "CallExpression",
    precedence: 14,
    associativity: "left",
    fixity: "postfix",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: pending("src/codegen.ts"),
    stream: unsupported("'call' produces a value, not a stage."),
    statement: unsupported("'.call()' is not a statement — see its 'where'."),
  }),

  methodCall: production({
    doc: "Applies a name to a receiver: `$.s.trim()`.",
    tokens: [".", "(", ")", ",", "?.", "$", "identifier"],
    becomes: "MethodCall",
    precedence: 14,
    associativity: "left",
    fixity: "postfix",
    on: "any",
    returns: "unknown",
    where: ["value", "filter"],
    filter: pending("src/match-translation.ts"),
    expr: pending("src/codegen.ts"),
    stream: unsupported("'methodCall' produces a value, not a stage."),
    statement: unsupported("'.methodCall()' is not a statement — see its 'where'."),
  }),

  operatorCall: production({
    doc: "The `$op(...)` escape hatch. Which operators exist is in names.ts.",
    tokens: ["$", "(", ")", ",", "identifier"],
    becomes: "OperatorCall",
    on: "any",
    returns: "unknown",
    where: ["value", "filter"],
    filter: pending("src/match-translation.ts"),
    expr: pending("src/codegen.ts"),
    stream: unsupported("'operatorCall' produces a value, not a stage."),
    statement: unsupported("'.operatorCall()' is not a statement — see its 'where'."),
  }),

  namespacedCall: production({
    doc: "`Math.abs(x)`, `Object.keys(o)`, `Number.isInteger(n)`, `Date.now()`, `Array.from(...)`.",
    tokens: [".", "(", ")", ",", "identifier"],
    // `Math.max(a, b)` is a MethodCall whose object is the name `Math`; `Math.PI` is a
    // MemberAccess. Seven node types collapsed here — the parser no longer knows
    // which namespace it is looking at.
    becomes: ["MethodCall", "MemberAccess"],
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: pending("src/codegen.ts"),
    stream: unsupported("'namespacedCall' produces a value, not a stage."),
    statement: unsupported("'.namespacedCall()' is not a statement — see its 'where'."),
  }),

  constructorCall: production({
    doc: "`new Date(…)`, `new Set(…)`, `new ObjectId(…)`. What each constructor means is in names.ts.",
    tokens: ["new", "(", ")", ",", "identifier"],
    // One node for every `new X(…)`. Which constructor it is comes from names.ts.
    becomes: "NewExpression",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: composedInto(
      "strictEquality",
      "strictInequality",
      "greaterThan",
      "greaterOrEqual",
      "lessThan",
      "lessOrEqual",
    ),
    expr: pending("src/codegen.ts"),
    stream: unsupported("'constructorCall' produces a value, not a stage."),
    statement: unsupported("'.constructorCall()' is not a statement — see its 'where'."),
  }),

  typeCast: production({
    doc: "`Number(x)`, `String(x)`, `Boolean(x)` — a bare global conversion.",
    tokens: ["(", ")", "identifier"],
    // `Number($.s)` is a call whose callee is a name. Nothing about it is special
    // until names.ts resolves `Number`.
    becomes: "CallExpression",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: pending("src/codegen.ts"),
    stream: unsupported("'typeCast' produces a value, not a stage."),
    statement: unsupported("'.typeCast()' is not a statement — see its 'where'."),
  }),

  unappliedReference: production({
    doc: "A callable handed to a higher-order name without being applied: `map(String)`, `map(Math.abs)`.",
    tokens: ["identifier"],
    // A bare name handed over unapplied is still just a name. Whether it MAY be is
    // the `asReference` field on its row.
    becomes: "Ident",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: pending("src/codegen.ts"),
    stream: unsupported("'unappliedReference' produces a value, not a stage."),
    statement: unsupported("'.unappliedReference()' is not a statement — see its 'where'."),
  }),

  fieldReference: production({
    doc: "`$.name` — a field of the current document.",
    tokens: ["$.", "identifier"],
    becomes: "FieldRef",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: composedInto(
      "strictEquality",
      "strictInequality",
      "greaterThan",
      "greaterOrEqual",
      "lessThan",
      "lessOrEqual",
      "methodCall",
      "operatorCall",
    ),
    expr: pending("src/codegen.ts"),
    stream: unsupported("'fieldReference' produces a value, not a stage."),
    statement: unsupported("'.fieldReference()' is not a statement — see its 'where'."),
  }),

  rootReference: production({
    doc: "`$` — the whole current document.",
    tokens: ["$"],
    becomes: "FieldRef",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: pending("src/codegen.ts"),
    stream: unsupported("'rootReference' produces a value, not a stage."),
    statement: unsupported("'.rootReference()' is not a statement — see its 'where'."),
  }),

  streamReference: production({
    doc: "`$$` — the current collection as a stream.",
    tokens: ["$$"],
    // `$$` is level 2.
    becomes: "ContextRef",
    on: "any",
    returns: "unknown",
    where: ["stream"],
    filter: unsupported("'$$' is a stream, not a filter predicate."),
    expr: unsupported("'streamReference' is a statement, not an aggregation expression."),
    stream: pending("src/pipeline.ts"),
    statement: unsupported("'.streamReference()' is not a statement — see its 'where'."),
  }),

  collectionReference: production({
    doc: "`$$$.<coll>` — another collection.",
    tokens: ["$$$"],
    // `$$$` is level 3.
    becomes: "ContextRef",
    on: "any",
    returns: "unknown",
    where: ["stream"],
    filter: unsupported("'$$$.<coll>' names a collection, not a filter predicate."),
    expr: unsupported("'collectionReference' is a statement, not an aggregation expression."),
    stream: pending("src/pipeline.ts"),
    statement: unsupported("'.collectionReference()' is not a statement — see its 'where'."),
  }),

  clusterReference: production({
    doc: "`$$$$` — cluster scope, for the diagnostic source stages.",
    tokens: ["$$$$"],
    // `$$$$` is level 4.
    becomes: "ContextRef",
    on: "any",
    returns: "unknown",
    where: ["stream"],
    filter: unsupported("'$$$$' names a cluster, not a filter predicate."),
    expr: unsupported("'clusterReference' is a statement, not an aggregation expression."),
    stream: pending("src/pipeline.ts"),
    statement: unsupported("'.clusterReference()' is not a statement — see its 'where'."),
  }),

  parameterReference: production({
    doc: "A name bound by the parameter destructure.",
    tokens: ["identifier"],
    // Indistinguishable from any other bare name at parse time — scope decides.
    becomes: "Ident",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: composedInto(
      "strictEquality",
      "strictInequality",
      "greaterThan",
      "greaterOrEqual",
      "lessThan",
      "lessOrEqual",
    ),
    expr: pending("src/codegen.ts"),
    stream: unsupported("'parameterReference' produces a value, not a stage."),
    statement: unsupported("'.parameterReference()' is not a statement — see its 'where'."),
  }),

  numberLiteral: production({
    doc: "A number.",
    tokens: ["number"],
    becomes: "NumberLiteral",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: composedInto(
      "strictEquality",
      "strictInequality",
      "greaterThan",
      "greaterOrEqual",
      "lessThan",
      "lessOrEqual",
    ),
    expr: pending("src/codegen.ts"),
    stream: unsupported("'numberLiteral' produces a value, not a stage."),
    statement: unsupported("'.numberLiteral()' is not a statement — see its 'where'."),
  }),

  stringLiteral: production({
    doc: "A string.",
    tokens: ["string"],
    becomes: "StringLiteral",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: composedInto(
      "strictEquality",
      "strictInequality",
      "greaterThan",
      "greaterOrEqual",
      "lessThan",
      "lessOrEqual",
    ),
    expr: pending("src/codegen.ts"),
    stream: unsupported("'stringLiteral' produces a value, not a stage."),
    statement: unsupported("'.stringLiteral()' is not a statement — see its 'where'."),
  }),

  bigIntLiteral: production({
    doc: "A BigInt.",
    tokens: ["bigint"],
    becomes: "BigIntLiteral",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: pending("src/codegen.ts"),
    stream: unsupported("'bigIntLiteral' produces a value, not a stage."),
    statement: unsupported("'.bigIntLiteral()' is not a statement — see its 'where'."),
  }),

  regexLiteral: production({
    doc: "A regular expression.",
    tokens: ["regex"],
    becomes: "RegexLiteral",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: composedInto("methodCall"),
    expr: pending("src/codegen.ts"),
    stream: unsupported("'regexLiteral' produces a value, not a stage."),
    statement: unsupported("'.regexLiteral()' is not a statement — see its 'where'."),
  }),

  booleanLiteral: production({
    doc: "A boolean.",
    tokens: ["true", "false"],
    becomes: "BooleanLiteral",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: composedInto("strictEquality", "strictInequality"),
    expr: pending("src/codegen.ts"),
    stream: unsupported("'booleanLiteral' produces a value, not a stage."),
    statement: unsupported("'.booleanLiteral()' is not a statement — see its 'where'."),
  }),

  nullLiteral: production({
    doc: "An explicit null.",
    tokens: ["null"],
    becomes: "NullLiteral",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: composedInto("strictEquality", "strictInequality", "looseEquality", "looseInequality"),
    expr: pending("src/codegen.ts"),
    stream: unsupported("'nullLiteral' produces a value, not a stage."),
    statement: unsupported("'.nullLiteral()' is not a statement — see its 'where'."),
  }),

  undefinedLiteral: production({
    doc: "Absence. Meaningful only in a comparison — `x === undefined`.",
    tokens: ["undefined"],
    becomes: "UndefinedLiteral",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: composedInto("strictEquality", "strictInequality"),
    expr: pending("src/codegen.ts"),
    stream: unsupported("'undefinedLiteral' produces a value, not a stage."),
    statement: unsupported("'.undefinedLiteral()' is not a statement — see its 'where'."),
  }),

  objectIdLiteral: production({
    doc: "`0x` followed by 24 hex digits. The lexer produces a NUMBER; this rule re-reads it as an ObjectId.",
    tokens: ["number"],
    becomes: "ObjectIdLiteral",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: composedInto("strictEquality", "strictInequality"),
    expr: pending("src/codegen.ts"),
    stream: unsupported("'objectIdLiteral' produces a value, not a stage."),
    statement: unsupported("'.objectIdLiteral()' is not a statement — see its 'where'."),
  }),

  templateLiteral: production({
    doc: "A string built from parts.",
    tokens: ["`", "templateText", "${"],
    becomes: "TemplateLiteral",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: pending("src/codegen.ts"),
    stream: unsupported("'templateLiteral' produces a value, not a stage."),
    statement: unsupported("'.templateLiteral()' is not a statement — see its 'where'."),
  }),

  objectLiteral: production({
    doc: "A document. At the top level it is the query document itself; with one stage-name key it is a stage.",
    tokens: ["{", "}", ":", ",", "[", "]"],
    becomes: "ObjectLiteral",
    on: "any",
    returns: "unknown",
    where: ["value", "filter", "stream"],
    filter: pending("src/index.ts"),
    expr: pending("src/codegen.ts"),
    stream: pending("src/pipeline.ts"),
    statement: unsupported("'.objectLiteral()' is not a statement — see its 'where'."),
  }),

  arrayLiteral: production({
    doc: "A list. At the top level it is a pipeline.",
    tokens: ["[", "]", ","],
    becomes: "ArrayLiteral",
    on: "any",
    returns: "unknown",
    where: ["value", "stream"],
    filter: composedInto("methodCall"),
    expr: pending("src/codegen.ts"),
    stream: pending("src/pipeline.ts"),
    statement: unsupported("'.arrayLiteral()' is not a statement — see its 'where'."),
  }),

  spread: production({
    doc: "Splices an array or object into place.",
    tokens: ["..."],
    becomes: "SpreadElement",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: pending("src/codegen.ts"),
    stream: unsupported("'spread' produces a value, not a stage."),
    statement: unsupported("'.spread()' is not a statement — see its 'where'."),
  }),

  objectEntry: production({
    doc: "One `key: value` pair of a document.",
    tokens: [":"],
    becomes: "KeyValueEntry",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: pending("src/codegen.ts"),
    stream: unsupported("'objectEntry' produces a value, not a stage."),
    statement: unsupported("'.objectEntry()' is not a statement — see its 'where'."),
  }),

  arrowFunction: production({
    doc: "A callback: parameters, then a body.",
    tokens: ["=>", "(", ")", ",", "{", "}", "return", "identifier"],
    becomes: "Lambda",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: composedInto("methodCall"),
    expr: pending("src/codegen.ts"),
    stream: unsupported("'arrowFunction' produces a value, not a stage."),
    statement: unsupported("'.arrowFunction()' is not a statement — see its 'where'."),
  }),

  destructuringParam: production({
    doc: "`({ a, b }, { $ }) => …` binds each named parameter. The ONLY parameter form: a plain name is refused, one level deep, renaming allowed, no defaults, no rest.",
    tokens: ["{", "}", ",", "(", ")", "identifier", ":", "$", "$$", "$$$", "$$$$"],
    becomes: { notANode: "produces ParamBinding[], which the parser holds beside the tree rather than in it" },
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: pending("src/codegen.ts"),
    stream: unsupported("'destructuringParam' produces a value, not a stage."),
    statement: unsupported("'.destructuringParam()' is not a statement — see its 'where'."),
  }),

  blockReturn: production({
    doc: "Yields a block's value. Declarations may precede it in a callback block, but not in an entry block.",
    tokens: ["return", "{", "}"],
    becomes: "ExprBlock",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: pending("src/codegen.ts"),
    stream: unsupported("'blockReturn' produces a value, not a stage."),
    statement: unsupported("'.blockReturn()' is not a statement — see its 'where'."),
  }),

  constantBinding: production({
    doc: "Binds a name for the statements that follow.",
    tokens: ["const", "=", "identifier"],
    becomes: "LetDecl",
    on: "any",
    returns: "unknown",
    where: ["statement", "value"],
    filter: unsupported("a declaration is not a filter predicate."),
    expr: pending("src/codegen.ts"),
    statement: pending("src/pipeline.ts"),
    stream: unsupported("'.constantBinding()' is not a link in a '$$ = $$…' chain — see its 'where'."),
  }),

  mutableBinding: production({
    doc: "Binds a reassignable name.",
    tokens: ["let", "=", "identifier"],
    becomes: "LetDecl",
    on: "any",
    returns: "unknown",
    where: ["statement", "value"],
    filter: unsupported("a declaration is not a filter predicate."),
    expr: pending("src/codegen.ts"),
    statement: pending("src/pipeline.ts"),
    stream: unsupported("'.mutableBinding()' is not a link in a '$$ = $$…' chain — see its 'where'."),
  }),

  functionBinding: production({
    doc: "A reusable expression over parameters. `function` is NOT reserved — it lexes as an identifier.",
    tokens: ["identifier", "const", "=", "=>", "(", ")", "let", "{", "}", "return"],
    becomes: "FuncDecl",
    on: "any",
    returns: "unknown",
    where: ["statement"],
    filter: unsupported("a declaration is not a filter predicate."),
    expr: unsupported("'functionBinding' is a statement, not an aggregation expression."),
    statement: pending("src/pipeline.ts"),
    stream: unsupported("'.functionBinding()' is not a link in a '$$ = $$…' chain — see its 'where'."),
  }),

  fieldDeletion: production({
    doc: "Removes a field.",
    tokens: ["delete", "$.", ","],
    becomes: "DeleteStmt",
    on: "any",
    returns: "unknown",
    where: ["statement"],
    filter: unsupported("'delete' removes a field. To require absence write '$.a === undefined'."),
    expr: unsupported("'fieldDeletion' is a statement, not an aggregation expression."),
    statement: pending("src/pipeline.ts"),
    stream: unsupported("'.fieldDeletion()' is not a link in a '$$ = $$…' chain — see its 'where'."),
  }),

  fieldAssignment: production({
    doc: "Writes a value to a field. `+=` `-=` `*=` `/=` desugar into the same node.",
    tokens: ["=", "+=", "-=", "*=", "/=", ",", "(", ")"],
    becomes: ["AssignExpr", "UpdateFilter"],
    on: "any",
    returns: "unknown",
    where: ["statement"],
    filter: unsupported("an assignment is not a filter predicate."),
    expr: unsupported("'fieldAssignment' is a statement, not an aggregation expression."),
    statement: pending("src/pipeline.ts"),
    stream: unsupported("'.fieldAssignment()' is not a link in a '$$ = $$…' chain — see its 'where'."),
  }),

  increment: production({
    doc: "Adds one to a field. `++$.a` and `$.a++` are the same.",
    tokens: ["++"],
    becomes: ["AssignExpr", "UpdateFilter"],
    fixity: "prefixOrPostfix",
    on: "any",
    returns: "unknown",
    where: ["statement"],
    filter: unsupported("'++' writes a field; it is not a filter predicate."),
    expr: unsupported("'increment' is a statement, not an aggregation expression."),
    statement: pending("src/pipeline.ts"),
    stream: unsupported("'.increment()' is not a link in a '$$ = $$…' chain — see its 'where'."),
  }),

  decrement: production({
    doc: "Subtracts one from a field. `--$.a` and `$.a--` are the same.",
    tokens: ["--"],
    becomes: ["AssignExpr", "UpdateFilter"],
    fixity: "prefixOrPostfix",
    on: "any",
    returns: "unknown",
    where: ["statement"],
    filter: unsupported("'--' writes a field; it is not a filter predicate."),
    expr: unsupported("'decrement' is a statement, not an aggregation expression."),
    statement: pending("src/pipeline.ts"),
    stream: unsupported("'.decrement()' is not a link in a '$$ = $$…' chain — see its 'where'."),
  }),

  pipelineStatement: production({
    doc: "Separates pipeline statements. Its presence at the top level makes the output a Pipeline.",
    tokens: [";"],
    becomes: "Pipeline",
    on: "any",
    returns: "unknown",
    where: ["statement"],
    filter: unsupported("a pipeline is not a filter predicate."),
    expr: unsupported("'pipelineStatement' is a statement, not an aggregation expression."),
    statement: pending("src/pipeline.ts"),
    stream: unsupported("'.pipelineStatement()' is not a link in a '$$ = $$…' chain — see its 'where'."),
  }),

  // ── sugar: overlapping triggers, so precedence is declared ─────────────────
  letReassignment: production({
    doc: "`name = <expr>` rebinds a `let`. Tried before every other assignment form.",
    tokens: ["identifier", "=", "+=", "-=", "*=", "/=", "++", "--"],
    becomes: "AssignExpr",
    on: "any",
    returns: "unknown",
    where: ["statement"],
    after: [],
    filter: unsupported("'letReassignment' is a statement, not a filter predicate."),
    expr: unsupported("'letReassignment' is a statement, not an aggregation expression."),
    statement: pending("src/pipeline.ts"),
    stream: unsupported("'.letReassignment()' is not a link in a '$$ = $$…' chain — see its 'where'."),
  }),

  streamReplacement: production({
    doc: "`$$ = $$.<chain>` replaces the stream with the chain's stages.",
    tokens: ["$$", "=", "$$$", "[", "]", "{", "}"],
    becomes: "AssignExpr",
    on: "any",
    returns: "unknown",
    where: ["statement"],
    after: ["letReassignment"],
    filter: unsupported("'streamReplacement' is a statement, not a filter predicate."),
    expr: unsupported("'streamReplacement' is a statement, not an aggregation expression."),
    statement: pending("src/pipeline.ts"),
    stream: unsupported("'.streamReplacement()' is not a link in a '$$ = $$…' chain — see its 'where'."),
  }),

  rootReplacement: production({
    doc: "`$ = <expr>` replaces the document root.",
    tokens: ["$", "="],
    becomes: "AssignExpr",
    on: "any",
    returns: "unknown",
    where: ["statement"],
    after: ["letReassignment", "streamReplacement"],
    filter: unsupported("'rootReplacement' is a statement, not a filter predicate."),
    expr: unsupported("'rootReplacement' is a statement, not an aggregation expression."),
    statement: pending("src/pipeline.ts"),
    stream: unsupported("'.rootReplacement()' is not a link in a '$$ = $$…' chain — see its 'where'."),
  }),

  collectionWrite: production({
    doc: "`$$$.<coll> = $$` writes the stream to a collection.",
    tokens: ["$$$", "=", "$$$$", ".", "[", "]", "string"],
    becomes: "AssignExpr",
    on: "any",
    returns: "unknown",
    where: ["statement"],
    only: ["stageLast"],
    after: ["letReassignment", "streamReplacement", "rootReplacement"],
    filter: unsupported("'collectionWrite' is a statement, not a filter predicate."),
    expr: unsupported("'collectionWrite' is a statement, not an aggregation expression."),
    statement: pending("src/pipeline.ts"),
    stream: unsupported("'.collectionWrite()' is not a link in a '$$ = $$…' chain — see its 'where'."),
  }),

  foreignJoin: production({
    doc: "`$.o = $$$.<coll>.find(<pred>)` joins another collection.",
    tokens: ["$.", "$$$", "=", ".", "(", ")", "=>", "const", "let", "identifier"],
    becomes: "AssignExpr",
    on: "any",
    returns: "unknown",
    where: ["statement"],
    after: ["letReassignment", "streamReplacement", "rootReplacement", "collectionWrite"],
    filter: unsupported("'foreignJoin' is a statement, not a filter predicate."),
    expr: unsupported("'foreignJoin' is a statement, not an aggregation expression."),
    statement: pending("src/pipeline.ts"),
    stream: unsupported("'.foreignJoin()' is not a link in a '$$ = $$…' chain — see its 'where'."),
  }),
};

export type ProductionKey = keyof typeof PRODUCTIONS;

// ── audits ───────────────────────────────────────────────────────────────────

type FieldOf<K extends ProductionKey, F extends string> = F extends keyof (typeof PRODUCTIONS)[K]
  ? NonNullable<(typeof PRODUCTIONS)[K][F]>
  : never;

type Mentioned<F extends string> = {
  [K in ProductionKey]: [FieldOf<K, F>] extends [never]
    ? never
    : FieldOf<K, F> extends readonly (infer V)[]
      ? V
      : FieldOf<K, F>;
}[ProductionKey];

/** Every `tokens` entry must be a key of tokens.ts or keywords.ts. */
type DanglingTokens = Exclude<Mentioned<"tokens">, Lexeme>;
const _tokensResolve: [DanglingTokens] extends [never] ? true : DanglingTokens = true;

/** Every `after` entry must be a rule in this same file. */
type DanglingAfter = Exclude<Mentioned<"after">, ProductionKey>;
const _afterResolves: [DanglingAfter] extends [never] ? true : DanglingAfter = true;

/**
 * Every `composedInto` owner must be a rule in this same file.
 *
 * The audit that was missing. Without it a cell could name an owner that never
 * touches it, and two did: `methodCall` and `operatorCall` both pointed at
 * `strictEquality`, which does not consume either — while both render natively
 * on their own. A dangling pointer read as "this is handled elsewhere" and
 * hid two whole native query forms.
 */
type CellName = "filter" | "expr" | "stream" | "statement";

type OwnersNamedBy<K extends ProductionKey> = {
  // Extract FIRST. A cell's type is a union, and a union never satisfies the
  // object pattern on its own, so matching the union directly yields `never` for
  // every row — an audit that always passes.
  // Extract FIRST: a cell's type is a union, and a union never satisfies the
  // object pattern on its own, so matching the union directly yields `never` for
  // every row — an audit that always passes.
  //
  // Then guard the `never` case BEFORE inferring. `never extends readonly
  // (infer V)[]` succeeds with `V = unknown`, and one `unknown` in the union
  // swallows the whole audit. That is the bug this line exists to avoid.
  [C in CellName]: [Extract<(typeof PRODUCTIONS)[K][C], { composedInto: readonly string[] }>] extends [never]
    ? never
    : Extract<(typeof PRODUCTIONS)[K][C], { composedInto: readonly string[] }> extends {
          composedInto: readonly (infer V)[];
        }
      ? V
      : never;
}[CellName];

type DanglingComposedInto = Exclude<{ [K in ProductionKey]: OwnersNamedBy<K> }[ProductionKey], ProductionKey>;
const _composedIntoResolves: [DanglingComposedInto] extends [never] ? true : DanglingComposedInto = true;

void _tokensResolve;
void _afterResolves;
void _composedIntoResolves;
