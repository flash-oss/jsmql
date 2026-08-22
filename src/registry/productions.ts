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
import type { Cell, Either, ExprIn, FilterIn, Lists, Of, QueryDoc, Stage, StageIn } from "./vocabulary.ts";
import type { TokenKey } from "./tokens.ts";
import type { KeywordKey } from "./keywords.ts";

/** What a rule's `tokens` may name: a token, or a reserved word. */
export type Lexeme = TokenKey | KeywordKey;

export type ProductionSpec<
  T extends readonly Lexeme[],
  W extends readonly Position[],
  O extends On,
  A extends readonly string[] = readonly never[],
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
  filter: Cell<Lists<W, "filter">, Of<O>, FilterIn, QueryDoc>;
  expr: Cell<Lists<W, "value">, Of<O>, ExprIn, unknown>;
  stage: Cell<Either<Lists<W, "stream">, Lists<W, "statement">>, Of<O>, StageIn, Stage[]>;
};

export type ProductionEntry<
  T extends readonly Lexeme[],
  W extends readonly Position[],
  O extends On,
  A extends readonly string[] = readonly never[],
> = ProductionSpec<T, W, O, A> & { kind: "production" };

// Every generic defaults to the EMPTY type, never to its constraint — a rule with no
// `after` would otherwise widen `A` to `readonly string[]` and the audit below would
// pass while checking nothing.
const production = <
  const T extends readonly Lexeme[],
  const W extends readonly Position[],
  const O extends On,
  const A extends readonly string[] = readonly never[],
>(
  e: ProductionSpec<T, W, O, A>,
): ProductionEntry<T, W, O, A> => ({ ...e, kind: "production" });

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
    stage: unsupported("'conditional' produces a value, not a stage."),
  }),

  nullishCoalescing: production({
    doc: "The left value unless it is null or missing.",
    tokens: ["??"],
    becomes: "BinaryExpr",
    precedence: 2,
    associativity: "left",
    fixity: "infix",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: pending("src/codegen.ts"),
    stage: unsupported("'nullishCoalescing' produces a value, not a stage."),
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
    stage: unsupported("'logicalOr' produces a value, not a stage."),
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
    stage: unsupported("'logicalAnd' produces a value, not a stage."),
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
    stage: unsupported("'bitwiseOr' produces a value, not a stage."),
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
    stage: unsupported("'bitwiseXor' produces a value, not a stage."),
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
    stage: unsupported("'bitwiseAnd' produces a value, not a stage."),
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
    stage: unsupported("'strictEquality' produces a value, not a stage."),
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
    stage: unsupported("'strictInequality' produces a value, not a stage."),
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
    stage: unsupported("'looseEquality' produces a value, not a stage."),
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
    stage: unsupported("'looseInequality' produces a value, not a stage."),
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
    stage: unsupported("'greaterThan' produces a value, not a stage."),
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
    stage: unsupported("'greaterOrEqual' produces a value, not a stage."),
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
    stage: unsupported("'lessThan' produces a value, not a stage."),
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
    stage: unsupported("'lessOrEqual' produces a value, not a stage."),
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
    stage: unsupported("'membership' produces a value, not a stage."),
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
    stage: unsupported("'addition' produces a value, not a stage."),
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
    stage: unsupported("'subtraction' produces a value, not a stage."),
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
    stage: unsupported("'multiplication' produces a value, not a stage."),
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
    stage: unsupported("'division' produces a value, not a stage."),
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
    filter: composedInto("strictEquality"),
    expr: pending("src/codegen.ts"),
    stage: unsupported("'remainder' produces a value, not a stage."),
  }),

  exponentiation: production({
    doc: "Raises the left number to the right power.",
    tokens: ["**"],
    becomes: "BinaryExpr",
    precedence: 12,
    associativity: "right",
    fixity: "infix",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: pending("src/codegen.ts"),
    stage: unsupported("'exponentiation' produces a value, not a stage."),
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
    stage: unsupported("'logicalNot' produces a value, not a stage."),
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
    stage: unsupported("'negation' produces a value, not a stage."),
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
    stage: unsupported("'bitwiseNot' produces a value, not a stage."),
  }),

  typeCheck: production({
    doc: "The type name of a value.",
    tokens: ["typeof"],
    becomes: "TypeofExpr",
    precedence: 13,
    associativity: "right",
    fixity: "prefix",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: composedInto("strictEquality"),
    expr: pending("src/codegen.ts"),
    stage: unsupported("'typeCheck' produces a value, not a stage."),
  }),

  memberAccess: production({
    doc: "Reads a field, or dispatches a name onto a receiver.",
    tokens: [".", ":"],
    becomes: "MemberAccess",
    precedence: 14,
    associativity: "left",
    fixity: "postfix",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: composedInto("strictEquality"),
    expr: pending("src/codegen.ts"),
    stage: unsupported("'memberAccess' produces a value, not a stage."),
  }),

  optionalMemberAccess: production({
    doc: "Reads a field, yielding nothing when the receiver is absent.",
    tokens: ["?."],
    becomes: "MemberAccess",
    precedence: 14,
    associativity: "left",
    fixity: "postfix",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: composedInto("strictEquality"),
    expr: pending("src/codegen.ts"),
    stage: unsupported("'optionalMemberAccess' produces a value, not a stage."),
  }),

  indexAccess: production({
    doc: "Reads an element by index, or a field by computed name.",
    tokens: ["[", "]"],
    becomes: "IndexAccess",
    precedence: 14,
    associativity: "left",
    fixity: "postfix",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: pending("src/codegen.ts"),
    stage: unsupported("'indexAccess' produces a value, not a stage."),
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
    stage: unsupported("'call' produces a value, not a stage."),
  }),

  methodCall: production({
    doc: "Applies a name to a receiver: `$.s.trim()`.",
    tokens: [".", "(", ")", ","],
    becomes: "MethodCall",
    precedence: 14,
    associativity: "left",
    fixity: "postfix",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: composedInto("strictEquality"),
    expr: pending("src/codegen.ts"),
    stage: unsupported("'methodCall' produces a value, not a stage."),
  }),

  operatorCall: production({
    doc: "The `$op(...)` escape hatch. Which operators exist is in names.ts.",
    tokens: ["$", "(", ")", ","],
    becomes: "OperatorCall",
    precedence: 14,
    associativity: "left",
    fixity: "postfix",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: composedInto("strictEquality"),
    expr: pending("src/codegen.ts"),
    stage: unsupported("'operatorCall' produces a value, not a stage."),
  }),

  namespacedCall: production({
    doc: "`Math.abs(x)`, `Object.keys(o)`, `Number.isInteger(n)`, `Date.now()`, `Array.from(...)`.",
    tokens: [".", "(", ")", ","],
    becomes: ["MathCall", "ObjectCall", "NumberStatic", "DateNow", "DateUTC", "ArrayFrom", "MathConst"],
    precedence: 14,
    associativity: "left",
    fixity: "postfix",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: pending("src/codegen.ts"),
    stage: unsupported("'namespacedCall' produces a value, not a stage."),
  }),

  constructorCall: production({
    doc: "`new Date(…)`, `new Set(…)`, `new ObjectId(…)`. What each constructor means is in names.ts.",
    tokens: ["new", "(", ")", ","],
    becomes: ["NewDate", "NewSet", "ObjectIdLiteral"],
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: pending("src/codegen.ts"),
    stage: unsupported("'constructorCall' produces a value, not a stage."),
  }),

  typeCast: production({
    doc: "`Number(x)`, `String(x)`, `Boolean(x)` — a bare global conversion.",
    tokens: ["(", ")"],
    becomes: "TypeCast",
    precedence: 14,
    associativity: "left",
    fixity: "postfix",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: pending("src/codegen.ts"),
    stage: unsupported("'typeCast' produces a value, not a stage."),
  }),

  unappliedReference: production({
    doc: "A callable handed to a higher-order name without being applied: `map(String)`, `map(Math.abs)`.",
    tokens: ["identifier"],
    becomes: ["TypeCastRef", "MathCallRef", "ObjectIdRef"],
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: pending("src/codegen.ts"),
    stage: unsupported("'unappliedReference' produces a value, not a stage."),
  }),

  fieldReference: production({
    doc: "`$.name` — a field of the current document.",
    tokens: ["$."],
    becomes: "FieldRef",
    on: "any",
    returns: "unknown",
    where: ["value", "filter"],
    filter: pending("src/match-translation.ts"),
    expr: pending("src/codegen.ts"),
    stage: unsupported("'fieldReference' produces a value, not a stage."),
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
    stage: unsupported("'rootReference' produces a value, not a stage."),
  }),

  streamReference: production({
    doc: "`$$` — the current collection as a stream.",
    tokens: ["$$"],
    becomes: "CollectionRef",
    on: "any",
    returns: "unknown",
    where: ["stream"],
    filter: unsupported("'$$' is a stream, not a filter predicate."),
    expr: unsupported("'streamReference' is a statement, not an aggregation expression."),
    stage: pending("src/pipeline.ts"),
  }),

  collectionReference: production({
    doc: "`$$$.<coll>` — another collection.",
    tokens: ["$$$"],
    becomes: ["DatabaseRef", "CollectionRef"],
    on: "any",
    returns: "unknown",
    where: ["stream"],
    filter: unsupported("'$$$.<coll>' names a collection, not a filter predicate."),
    expr: unsupported("'collectionReference' is a statement, not an aggregation expression."),
    stage: pending("src/pipeline.ts"),
  }),

  clusterReference: production({
    doc: "`$$$$` — cluster scope, for the diagnostic source stages.",
    tokens: ["$$$$"],
    becomes: "ClusterRef",
    on: "any",
    returns: "unknown",
    where: ["stream"],
    filter: unsupported("'$$$$' names a cluster, not a filter predicate."),
    expr: unsupported("'clusterReference' is a statement, not an aggregation expression."),
    stage: pending("src/pipeline.ts"),
  }),

  parameterReference: production({
    doc: "A name bound by the parameter destructure.",
    tokens: ["identifier"],
    becomes: "ParamRef",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: pending("src/codegen.ts"),
    stage: unsupported("'parameterReference' produces a value, not a stage."),
  }),

  numberLiteral: production({
    doc: "A number.",
    tokens: ["number"],
    becomes: "NumberLiteral",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: pending("src/codegen.ts"),
    stage: unsupported("'numberLiteral' produces a value, not a stage."),
  }),

  stringLiteral: production({
    doc: "A string.",
    tokens: ["string"],
    becomes: "StringLiteral",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: pending("src/codegen.ts"),
    stage: unsupported("'stringLiteral' produces a value, not a stage."),
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
    stage: unsupported("'bigIntLiteral' produces a value, not a stage."),
  }),

  regexLiteral: production({
    doc: "A regular expression.",
    tokens: ["regex"],
    becomes: "RegexLiteral",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: pending("src/codegen.ts"),
    stage: unsupported("'regexLiteral' produces a value, not a stage."),
  }),

  booleanLiteral: production({
    doc: "A boolean.",
    tokens: ["true", "false"],
    becomes: "BooleanLiteral",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: pending("src/codegen.ts"),
    stage: unsupported("'booleanLiteral' produces a value, not a stage."),
  }),

  nullLiteral: production({
    doc: "An explicit null.",
    tokens: ["null"],
    becomes: "NullLiteral",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: pending("src/codegen.ts"),
    stage: unsupported("'nullLiteral' produces a value, not a stage."),
  }),

  undefinedLiteral: production({
    doc: "Absence. Meaningful only in a comparison — `x === undefined`.",
    tokens: ["undefined"],
    becomes: "UndefinedLiteral",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: unsupported("'undefined' is only meaningful in a comparison — write 'x === undefined'."),
    expr: pending("src/codegen.ts"),
    stage: unsupported("'undefinedLiteral' produces a value, not a stage."),
  }),

  objectIdLiteral: production({
    doc: "`0x` followed by 24 hex digits. The lexer produces a NUMBER; this rule re-reads it as an ObjectId.",
    tokens: ["number"],
    becomes: "ObjectIdLiteral",
    on: "any",
    returns: "unknown",
    where: ["value", "filter"],
    filter: pending("src/match-translation.ts"),
    expr: pending("src/codegen.ts"),
    stage: unsupported("'objectIdLiteral' produces a value, not a stage."),
  }),

  templateLiteral: production({
    doc: "A string built from parts.",
    tokens: ["`", "templateText", "${", "}"],
    becomes: "TemplateLiteral",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: pending("src/codegen.ts"),
    stage: unsupported("'templateLiteral' produces a value, not a stage."),
  }),

  objectLiteral: production({
    doc: "A document. At the top level it is the query document itself; with one stage-name key it is a stage.",
    tokens: ["{", "}", ":", ","],
    becomes: "ObjectLiteral",
    on: "any",
    returns: "unknown",
    where: ["value", "filter", "stream"],
    filter: pending("src/match-translation.ts"),
    expr: pending("src/codegen.ts"),
    stage: pending("src/pipeline.ts"),
  }),

  arrayLiteral: production({
    doc: "A list. At the top level it is a pipeline.",
    tokens: ["[", "]", ","],
    becomes: "ArrayLiteral",
    on: "any",
    returns: "unknown",
    where: ["value", "stream"],
    filter: viaFallback,
    expr: pending("src/codegen.ts"),
    stage: pending("src/pipeline.ts"),
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
    stage: unsupported("'spread' produces a value, not a stage."),
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
    stage: unsupported("'objectEntry' produces a value, not a stage."),
  }),

  arrowFunction: production({
    doc: "A callback: parameters, then a body.",
    tokens: ["=>", "(", ")", ","],
    becomes: "Lambda",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: pending("src/codegen.ts"),
    stage: unsupported("'arrowFunction' produces a value, not a stage."),
  }),

  destructuringParam: production({
    doc: "`({ a, b }, { $ }) => …` binds each named parameter. The ONLY parameter form: a plain name is refused, one level deep, renaming allowed, no defaults, no rest.",
    tokens: ["{", "}", ","],
    becomes: { notANode: "produces ParamBinding[], which the parser holds beside the tree rather than in it" },
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: pending("src/codegen.ts"),
    stage: unsupported("'destructuringParam' produces a value, not a stage."),
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
    stage: unsupported("'blockReturn' produces a value, not a stage."),
  }),

  constantBinding: production({
    doc: "Binds a name for the statements that follow.",
    tokens: ["const", "="],
    becomes: "LetDecl",
    on: "any",
    returns: "unknown",
    where: ["statement", "value"],
    filter: unsupported("a declaration is not a filter predicate."),
    expr: pending("src/codegen.ts"),
    stage: pending("src/pipeline.ts"),
  }),

  mutableBinding: production({
    doc: "Binds a reassignable name.",
    tokens: ["let", "="],
    becomes: "LetDecl",
    on: "any",
    returns: "unknown",
    where: ["statement", "value"],
    filter: unsupported("a declaration is not a filter predicate."),
    expr: pending("src/codegen.ts"),
    stage: pending("src/pipeline.ts"),
  }),

  functionBinding: production({
    doc: "A reusable expression over parameters. `function` is NOT reserved — it lexes as an identifier.",
    tokens: ["identifier", "const", "=", "=>", "(", ")"],
    becomes: "FuncDecl",
    on: "any",
    returns: "unknown",
    where: ["statement"],
    filter: unsupported("a declaration is not a filter predicate."),
    expr: unsupported("'functionBinding' is a statement, not an aggregation expression."),
    stage: pending("src/pipeline.ts"),
  }),

  fieldDeletion: production({
    doc: "Removes a field.",
    tokens: ["delete"],
    becomes: "DeleteStmt",
    on: "any",
    returns: "unknown",
    where: ["statement"],
    filter: unsupported("'delete' removes a field. To require absence write '$.a === undefined'."),
    expr: unsupported("'fieldDeletion' is a statement, not an aggregation expression."),
    stage: pending("src/pipeline.ts"),
  }),

  fieldAssignment: production({
    doc: "Writes a value to a field. `+=` `-=` `*=` `/=` desugar into the same node.",
    tokens: ["=", "+=", "-=", "*=", "/=", ","],
    becomes: ["AssignExpr", "UpdateFilter"],
    on: "any",
    returns: "unknown",
    where: ["statement"],
    filter: unsupported("an assignment is not a filter predicate."),
    expr: unsupported("'fieldAssignment' is a statement, not an aggregation expression."),
    stage: pending("src/pipeline.ts"),
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
    stage: pending("src/pipeline.ts"),
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
    stage: pending("src/pipeline.ts"),
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
    stage: pending("src/pipeline.ts"),
  }),

  // ── sugar: overlapping triggers, so precedence is declared ─────────────────
  letReassignment: production({
    doc: "`name = <expr>` rebinds a `let`. Tried before every other assignment form.",
    tokens: ["identifier", "="],
    becomes: "AssignExpr",
    on: "any",
    returns: "unknown",
    where: ["statement"],
    after: [],
    filter: unsupported("'letReassignment' is a statement, not a filter predicate."),
    expr: unsupported("'letReassignment' is a statement, not an aggregation expression."),
    stage: pending("src/pipeline.ts"),
  }),

  streamReplacement: production({
    doc: "`$$ = $$.<chain>` replaces the stream with the chain's stages.",
    tokens: ["$$", "="],
    becomes: "AssignExpr",
    on: "any",
    returns: "unknown",
    where: ["statement"],
    after: ["letReassignment"],
    filter: unsupported("'streamReplacement' is a statement, not a filter predicate."),
    expr: unsupported("'streamReplacement' is a statement, not an aggregation expression."),
    stage: pending("src/pipeline.ts"),
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
    stage: pending("src/pipeline.ts"),
  }),

  collectionWrite: production({
    doc: "`$$$.<coll> = $$` writes the stream to a collection.",
    tokens: ["$$$", "="],
    becomes: "AssignExpr",
    on: "any",
    returns: "unknown",
    where: ["statement"],
    only: ["stageLast"],
    after: ["letReassignment", "streamReplacement", "rootReplacement"],
    filter: unsupported("'collectionWrite' is a statement, not a filter predicate."),
    expr: unsupported("'collectionWrite' is a statement, not an aggregation expression."),
    stage: pending("src/pipeline.ts"),
  }),

  foreignJoin: production({
    doc: "`$.o = $$$.<coll>.find(<pred>)` joins another collection.",
    tokens: ["$.", "$$$", "="],
    becomes: "AssignExpr",
    on: "any",
    returns: "unknown",
    where: ["statement"],
    after: ["letReassignment", "streamReplacement", "rootReplacement", "collectionWrite"],
    filter: unsupported("'foreignJoin' is a statement, not a filter predicate."),
    expr: unsupported("'foreignJoin' is a statement, not an aggregation expression."),
    stage: pending("src/pipeline.ts"),
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

void _tokensResolve;
void _afterResolves;
