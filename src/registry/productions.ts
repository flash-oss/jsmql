import type { NodeName, On, Only, Position, TypeExpr } from "./vocabulary.ts";
import { composedInto, inCode, unsupported, viaFallback } from "./vocabulary.ts";
import type { Cell, Expr, ExprIn, FilterIn, FilterOut, Lists, Of, OutOf, QueryDoc, StageIn } from "./vocabulary.ts";
import { bsonTagOf, isDate, isRegExp, queryAmong, queryOwnValue, typeAliasOf } from "./vocabulary.ts";
import { cond } from "./mql.ts";
import type { TokenKey } from "./tokens.ts";
import type { KeywordKey } from "./keywords.ts";

export type Lexeme = TokenKey | KeywordKey;

export type ProductionSpec<
  T extends readonly Lexeme[],
  W extends readonly Position[],
  O extends On,
  A extends readonly string[] = readonly never[],
  C extends readonly string[] = readonly never[],
  M extends readonly string[] = readonly never[],
  L extends readonly string[] = readonly never[],
> = {
  doc: string;
  tokens: T;
  spelling: string;
  becomes: NodeName | readonly NodeName[] | { notANode: string };
  precedence?: number;
  associativity?: "left" | "right" | "none";
  fixity?: "prefix" | "infix" | "postfix" | "ternary" | "prefixOrPostfix";
  on: O;
  returns: TypeExpr;
  passesNull?: true;
  where: W;
  only?: readonly Only[];
  after?: A;
  word?: string;
  noMixWith?: M;
  leftOperandNot?: L;
  flattensChain?: true;
  neverAWriteTarget?: { instead: string };
  asStatement?: string;
  filter: Cell<Lists<W, "filter">, Of<O>, FilterIn, FilterOut<Lists<W, "value">>, C>;
  expr: Cell<Lists<W, "value">, Of<O>, ExprIn, OutOf["value"], C>;
  stream: Cell<Lists<W, "stream">, Of<O>, StageIn, OutOf["stream"], C>;
  statement: Cell<Lists<W, "statement">, Of<O>, StageIn, OutOf["statement"], C>;
};

export type ProductionEntry<
  T extends readonly Lexeme[],
  W extends readonly Position[],
  O extends On,
  A extends readonly string[] = readonly never[],
  C extends readonly string[] = readonly never[],
  M extends readonly string[] = readonly never[],
  L extends readonly string[] = readonly never[],
> = ProductionSpec<T, W, O, A, C, M, L> & { kind: "production" };

const production = <
  const T extends readonly Lexeme[],
  const W extends readonly Position[],
  const O extends On,
  const A extends readonly string[] = readonly never[],
  const C extends readonly string[] = readonly never[],
  const M extends readonly string[] = readonly never[],
  const L extends readonly string[] = readonly never[],
>(
  e: ProductionSpec<T, W, O, A, C, M, L>,
): ProductionEntry<T, W, O, A, C, M, L> => ({ ...e, kind: "production" });

function pathAndConstant(input: FilterIn): { path: string; value: unknown; flipped: boolean } | null {
  const [l, r] = input.args;
  const lp = input.pathOf(l);
  const rp = input.pathOf(r);
  if (lp !== null && rp === null) {
    const c = input.constant(r);
    return c === null ? null : { path: lp, value: c.value, flipped: false };
  }
  if (rp !== null && lp === null) {
    const c = input.constant(l);
    return c === null ? null : { path: rp, value: c.value, flipped: true };
  }
  return null;
}

function membershipQuery(input: FilterIn): QueryDoc | null {
  const [l, r] = input.args;
  const path = input.pathOf(l);
  if (path === null) return null;
  const c = input.constant(r);
  if (c === null || !Array.isArray(c.value)) return null;
  return queryAmong(path, c.value);
}

function typeTest(input: FilterIn): { path: string; alias: string } | null {
  const [l, r] = input.args;
  const pick = (a: Expr, b: Expr) =>
    a.type === "UnaryExpr" && a.op === "typeof" && b.type === "StringLiteral"
      ? { operand: a.argument, spelling: b.value }
      : null;
  const t = pick(l, r) ?? pick(r, l);
  if (t === null) return null;
  const path = input.pathOf(t.operand);
  const alias = typeAliasOf(t.spelling);
  return path === null || alias === null ? null : { path, alias };
}

function presenceTest(input: FilterIn): string | null {
  const [l, r] = input.args;
  const operand =
    l.type === "UndefinedLiteral"
      ? r.type === "UndefinedLiteral"
        ? null
        : r
      : r.type === "UndefinedLiteral"
        ? l
        : null;
  return operand === null ? null : input.pathOf(operand);
}

function moduloTest(input: FilterIn): { path: string; divisor: number; remainder: number } | null {
  const [l, r] = input.args;
  const isNat = (e: Expr) => e.type === "NumberLiteral" && Number.isInteger(e.value);
  const asMod = (e: Expr, other: Expr) => {
    if (e.type !== "BinaryExpr" || e.op !== "%" || !isNat(other)) return null;
    const path = input.pathOf(e.left);
    if (path === null || e.right.type !== "NumberLiteral" || !Number.isInteger(e.right.value) || e.right.value === 0)
      return null;
    return { path, divisor: e.right.value, remainder: (other as { value: number }).value };
  };
  return asMod(l, r) ?? asMod(r, l);
}

function nullTest(input: FilterIn): string | null {
  const [l, r] = input.args;
  if (l.type === "NullLiteral") return r.type === "NullLiteral" ? null : input.pathOf(r);
  return r.type === "NullLiteral" ? input.pathOf(l) : null;
}

const presenceQuery = (path: string, negated: boolean): QueryDoc => queryOwnValue(path, { $exists: negated });

function comparesALength(input: FilterIn): boolean {
  const isLength = (e: Expr) => e.type === "MemberAccess" && e.name === "length";
  const [l, r] = input.args;
  return isLength(l) || isLength(r);
}

function strictEqualityQuery(input: FilterIn, negated: boolean): QueryDoc | null {
  const typed = typeTest(input);
  if (typed !== null) {
    if (typed.alias === "array") {
      return negated
        ? queryOwnValue(typed.path, { $not: { $type: "array" } })
        : queryOwnValue(typed.path, { $type: "array" });
    }
    return negated
      ? queryOwnValue(typed.path, { $not: { $type: typed.alias } })
      : queryOwnValue(typed.path, { $type: typed.alias });
  }
  const present = presenceTest(input);
  if (present !== null) return presenceQuery(present, negated);
  if (comparesALength(input)) return null;
  const mod = moduloTest(input);
  if (mod !== null) {
    const test = { $mod: [mod.divisor, mod.remainder] };
    return negated ? queryOwnValue(mod.path, { $not: test }) : queryOwnValue(mod.path, test);
  }
  const nul = nullTest(input);
  if (nul !== null) {
    return negated ? queryOwnValue(nul, { $not: { $type: "null" } }) : queryOwnValue(nul, { $type: "null" });
  }
  const pc = pathAndConstant(input);
  if (pc === null) return null;
  if (Array.isArray(pc.value)) return null;
  if (isRegExp(pc.value)) return negated ? { [pc.path]: { $not: pc.value } } : { [pc.path]: pc.value };
  return negated ? queryOwnValue(pc.path, { $ne: pc.value }) : queryOwnValue(pc.path, { $eq: pc.value });
}

function looseEqualityQuery(input: FilterIn, negated: boolean): QueryDoc | null {
  const path = nullTest(input);
  if (path === null) return null;
  return negated ? queryOwnValue(path, { $ne: null }) : queryOwnValue(path, { $eq: null });
}

const FLIPPED = { $gt: "$lt", $gte: "$lte", $lt: "$gt", $lte: "$gte" } as const;

function orderedQuery(input: FilterIn, op: keyof typeof FLIPPED): QueryDoc | null {
  if (comparesALength(input)) return null;
  const pc = pathAndConstant(input);
  if (pc === null) return null;
  const v = pc.value;
  const ordered = typeof v === "number" || typeof v === "string" || isDate(v) || bsonTagOf(v) !== undefined;
  if (!ordered) return null;
  return queryOwnValue(pc.path, { [pc.flipped ? FLIPPED[op] : op]: v });
}

export const PRODUCTIONS = {
  conditional: production({
    doc: "Chooses between two values on a condition.",
    tokens: ["?", ":"],
    spelling: "?:",
    becomes: "TernaryExpr",
    precedence: 1,
    associativity: "right",
    fixity: "ternary",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "test, then, else", exact: 3, slotType: { 0: "any", 1: "any", 2: "any" } },
      emit: ({ args, value, truth }) => cond(truth(args[0]), value(args[1]), value(args[2])),
    },
    stream: unsupported("'?:' produces a value, not a stage."),
    statement: unsupported("'?:' is not a statement — see its 'where'."),
  }),

  nullishCoalescing: production({
    doc: "The left value unless it is null or missing.",
    tokens: ["??"],
    spelling: "??",
    becomes: "BinaryExpr",
    precedence: 2,
    associativity: "left",
    fixity: "infix",
    noMixWith: ["logicalOr", "logicalAnd"],
    on: "any",
    flattensChain: true,
    passesNull: true,
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "operands", atLeast: 2, rest: "any" },
      emit: ({ args, value }) => ({ $ifNull: args.map(value) }),
    },
    stream: unsupported("'??' produces a value, not a stage."),
    statement: unsupported("'??' is not a statement — see its 'where'."),
  }),

  logicalOr: production({
    doc: "True when either side is true.",
    tokens: ["||"],
    spelling: "||",
    becomes: "BinaryExpr",
    precedence: 3,
    associativity: "left",
    fixity: "infix",
    on: "any",
    returns: "unknown",
    where: ["value", "filter"],
    filter: inCode("src/compiler/emit/filter.ts", { sig: "operands", atLeast: 2, rest: "any" }),
    expr: inCode("src/compiler/emit/lower.ts", { sig: "operands", atLeast: 2, rest: "any" }),
    stream: unsupported("'||' produces a value, not a stage."),
    statement: unsupported("'||' is not a statement — see its 'where'."),
  }),

  logicalAnd: production({
    doc: "True when both sides are true.",
    tokens: ["&&"],
    spelling: "&&",
    becomes: "BinaryExpr",
    precedence: 4,
    associativity: "left",
    fixity: "infix",
    on: "any",
    returns: "unknown",
    where: ["value", "filter"],
    filter: inCode("src/compiler/emit/filter.ts", { sig: "operands", atLeast: 2, rest: "any" }),
    expr: inCode("src/compiler/emit/lower.ts", { sig: "operands", atLeast: 2, rest: "any" }),
    stream: unsupported("'&&' produces a value, not a stage."),
    statement: unsupported("'&&' is not a statement — see its 'where'."),
  }),

  bitwiseOr: production({
    doc: "Bitwise OR of two integers.",
    tokens: ["|"],
    spelling: "|",
    becomes: "BinaryExpr",
    precedence: 5,
    associativity: "left",
    fixity: "infix",
    on: "any",
    flattensChain: true,
    returns: "number",
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "operands", atLeast: 2, rest: "int-or-long" },
      emit: ({ args, value }) => ({ $bitOr: args.map(value) }),
    },
    stream: unsupported("'|' produces a value, not a stage."),
    statement: unsupported("'|' is not a statement — see its 'where'."),
  }),

  bitwiseXor: production({
    doc: "Bitwise XOR of two integers.",
    tokens: ["^"],
    spelling: "^",
    becomes: "BinaryExpr",
    precedence: 6,
    associativity: "left",
    fixity: "infix",
    on: "any",
    flattensChain: true,
    returns: "number",
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "operands", atLeast: 2, rest: "int-or-long" },
      emit: ({ args, value }) => ({ $bitXor: args.map(value) }),
    },
    stream: unsupported("'^' produces a value, not a stage."),
    statement: unsupported("'^' is not a statement — see its 'where'."),
  }),

  bitwiseAnd: production({
    doc: "Bitwise AND of two integers.",
    tokens: ["&"],
    spelling: "&",
    becomes: "BinaryExpr",
    precedence: 7,
    associativity: "left",
    fixity: "infix",
    on: "any",
    flattensChain: true,
    returns: "number",
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "operands", atLeast: 2, rest: "int-or-long" },
      emit: ({ args, value }) => ({ $bitAnd: args.map(value) }),
    },
    stream: unsupported("'&' produces a value, not a stage."),
    statement: unsupported("'&' is not a statement — see its 'where'."),
  }),

  strictEquality: production({
    doc: "True when both sides are equal, without coercion.",
    tokens: ["==="],
    spelling: "===",
    becomes: "BinaryExpr",
    precedence: 8,
    associativity: "none",
    fixity: "infix",
    on: "any",
    returns: "bool",
    where: ["value", "filter"],
    filter: {
      args: { sig: "left, right", exact: 2, rest: "any", homogeneous: true },
      emit: (input) => strictEqualityQuery(input, false),
    },
    expr: {
      args: { sig: "left, right", exact: 2, rest: "any", homogeneous: true },
      emit: ({ args, value }) => ({ $eq: [value(args[0]), value(args[1])] }),
    },
    stream: unsupported("'===' produces a value, not a stage."),
    statement: unsupported("'===' is not a statement — see its 'where'."),
  }),

  strictInequality: production({
    doc: "True when the sides differ, without coercion.",
    tokens: ["!=="],
    spelling: "!==",
    becomes: "BinaryExpr",
    precedence: 8,
    associativity: "none",
    fixity: "infix",
    on: "any",
    returns: "bool",
    where: ["value", "filter"],
    filter: {
      args: { sig: "left, right", exact: 2, rest: "any", homogeneous: true },
      emit: (input) => strictEqualityQuery(input, true),
    },
    expr: {
      args: { sig: "left, right", exact: 2, rest: "any", homogeneous: true },
      emit: ({ args, value }) => ({ $ne: [value(args[0]), value(args[1])] }),
    },
    stream: unsupported("'!==' produces a value, not a stage."),
    statement: unsupported("'!==' is not a statement — see its 'where'."),
  }),

  looseEquality: production({
    doc: "True when both sides are equal, treating null and missing alike.",
    tokens: ["=="],
    spelling: "==",
    becomes: "BinaryExpr",
    precedence: 8,
    associativity: "none",
    fixity: "infix",
    on: "any",
    returns: "bool",
    where: ["value", "filter"],
    filter: { args: { sig: "left, right", exact: 2, rest: "any" }, emit: (input) => looseEqualityQuery(input, false) },
    expr: inCode("src/compiler/emit/lower.ts", { sig: "left, right", exact: 2, rest: "any" }),
    stream: unsupported("'==' produces a value, not a stage."),
    statement: unsupported("'==' is not a statement — see its 'where'."),
  }),

  looseInequality: production({
    doc: "True when the sides differ, treating null and missing alike.",
    tokens: ["!="],
    spelling: "!=",
    becomes: "BinaryExpr",
    precedence: 8,
    associativity: "none",
    fixity: "infix",
    on: "any",
    returns: "bool",
    where: ["value", "filter"],
    filter: { args: { sig: "left, right", exact: 2, rest: "any" }, emit: (input) => looseEqualityQuery(input, true) },
    expr: inCode("src/compiler/emit/lower.ts", { sig: "left, right", exact: 2, rest: "any" }),
    stream: unsupported("'!=' produces a value, not a stage."),
    statement: unsupported("'!=' is not a statement — see its 'where'."),
  }),

  greaterThan: production({
    doc: "True when the left side is greater.",
    tokens: [">"],
    spelling: ">",
    becomes: "BinaryExpr",
    precedence: 9,
    associativity: "none",
    fixity: "infix",
    on: "any",
    returns: "bool",
    where: ["value", "filter"],
    filter: {
      args: { sig: "left, right", exact: 2, rest: "orderable", homogeneous: true },
      emit: (input) => orderedQuery(input, "$gt"),
    },
    expr: {
      args: { sig: "left, right", exact: 2, rest: "orderable", homogeneous: true },
      emit: ({ args, value }) => ({ $gt: [value(args[0]), value(args[1])] }),
    },
    stream: unsupported("'>' produces a value, not a stage."),
    statement: unsupported("'>' is not a statement — see its 'where'."),
  }),

  greaterOrEqual: production({
    doc: "True when the left side is greater or equal.",
    tokens: [">="],
    spelling: ">=",
    becomes: "BinaryExpr",
    precedence: 9,
    associativity: "none",
    fixity: "infix",
    on: "any",
    returns: "bool",
    where: ["value", "filter"],
    filter: {
      args: { sig: "left, right", exact: 2, rest: "orderable", homogeneous: true },
      emit: (input) => orderedQuery(input, "$gte"),
    },
    expr: {
      args: { sig: "left, right", exact: 2, rest: "orderable", homogeneous: true },
      emit: ({ args, value }) => ({ $gte: [value(args[0]), value(args[1])] }),
    },
    stream: unsupported("'>=' produces a value, not a stage."),
    statement: unsupported("'>=' is not a statement — see its 'where'."),
  }),

  lessThan: production({
    doc: "True when the left side is smaller.",
    tokens: ["<"],
    spelling: "<",
    becomes: "BinaryExpr",
    precedence: 9,
    associativity: "none",
    fixity: "infix",
    on: "any",
    returns: "bool",
    where: ["value", "filter"],
    filter: {
      args: { sig: "left, right", exact: 2, rest: "orderable", homogeneous: true },
      emit: (input) => orderedQuery(input, "$lt"),
    },
    expr: {
      args: { sig: "left, right", exact: 2, rest: "orderable", homogeneous: true },
      emit: ({ args, value }) => ({ $lt: [value(args[0]), value(args[1])] }),
    },
    stream: unsupported("'<' produces a value, not a stage."),
    statement: unsupported("'<' is not a statement — see its 'where'."),
  }),

  lessOrEqual: production({
    doc: "True when the left side is smaller or equal.",
    tokens: ["<="],
    spelling: "<=",
    becomes: "BinaryExpr",
    precedence: 9,
    associativity: "none",
    fixity: "infix",
    on: "any",
    returns: "bool",
    where: ["value", "filter"],
    filter: {
      args: { sig: "left, right", exact: 2, rest: "orderable", homogeneous: true },
      emit: (input) => orderedQuery(input, "$lte"),
    },
    expr: {
      args: { sig: "left, right", exact: 2, rest: "orderable", homogeneous: true },
      emit: ({ args, value }) => ({ $lte: [value(args[0]), value(args[1])] }),
    },
    stream: unsupported("'<=' produces a value, not a stage."),
    statement: unsupported("'<=' is not a statement — see its 'where'."),
  }),

  membership: production({
    doc: "True when the value is an element of the array.",
    tokens: ["in"],
    spelling: "x in [ … ]",
    becomes: "BinaryExpr",
    precedence: 9,
    associativity: "none",
    fixity: "infix",
    on: "any",
    returns: "bool",
    where: ["value", "filter"],
    filter: {
      args: { sig: "value, list", exact: 2, slotType: { 0: "element", 1: "array" } },
      emit: (input) => membershipQuery(input),
    },
    expr: inCode("src/compiler/emit/lower.ts", {
      sig: "value, list",
      exact: 2,
      slotType: { 0: "element", 1: "array" },
    }),
    stream: unsupported("'x in [ … ]' produces a value, not a stage."),
    statement: unsupported("'x in [ … ]' is not a statement — see its 'where'."),
  }),

  addition: production({
    doc: "Adds numbers, or joins strings.",
    tokens: ["+"],
    spelling: "+",
    becomes: "BinaryExpr",
    precedence: 10,
    associativity: "left",
    fixity: "infix",
    on: "any",
    passesNull: true,
    returns: { oneOf: ["number", "date"] },
    where: ["value"],
    filter: viaFallback,
    expr: inCode("src/compiler/emit/lower.ts", {
      sig: "operands",
      atLeast: 2,
      rest: ["number", "string"],
      homogeneous: true,
    }),
    stream: unsupported("'+' produces a value, not a stage."),
    statement: unsupported("'+' is not a statement — see its 'where'."),
  }),

  subtraction: production({
    doc: "Subtracts the right number from the left.",
    tokens: ["-"],
    spelling: "-",
    becomes: "BinaryExpr",
    precedence: 10,
    associativity: "left",
    fixity: "infix",
    on: "any",
    passesNull: true,
    returns: { oneOf: ["number", "date"] },
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "left, right", exact: 2, rest: "number" },
      emit: ({ args, value }) => ({ $subtract: [value(args[0]), value(args[1])] }),
    },
    stream: unsupported("'-' produces a value, not a stage."),
    statement: unsupported("'-' is not a statement — see its 'where'."),
  }),

  multiplication: production({
    doc: "Multiplies numbers.",
    tokens: ["*"],
    spelling: "*",
    becomes: "BinaryExpr",
    precedence: 11,
    associativity: "left",
    fixity: "infix",
    on: "any",
    flattensChain: true,
    passesNull: true,
    returns: "number",
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "operands", atLeast: 2, rest: "number" },
      emit: ({ args, value }) => ({ $multiply: args.map(value) }),
    },
    stream: unsupported("'*' produces a value, not a stage."),
    statement: unsupported("'*' is not a statement — see its 'where'."),
  }),

  division: production({
    doc: "Divides the left number by the right.",
    tokens: ["/"],
    spelling: "/",
    becomes: "BinaryExpr",
    precedence: 11,
    associativity: "left",
    fixity: "infix",
    on: "any",
    passesNull: true,
    returns: "number",
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "left, right", exact: 2, rest: "number", nonZero: [1] },
      emit: ({ args, value }) => ({ $divide: [value(args[0]), value(args[1])] }),
    },
    stream: unsupported("'/' produces a value, not a stage."),
    statement: unsupported("'/' is not a statement — see its 'where'."),
  }),

  remainder: production({
    doc: "The remainder after division.",
    tokens: ["%"],
    spelling: "%",
    becomes: "BinaryExpr",
    precedence: 11,
    associativity: "left",
    fixity: "infix",
    on: "any",
    passesNull: true,
    returns: "number",
    where: ["value"],
    filter: composedInto("strictEquality", "strictInequality"),
    expr: {
      args: { sig: "left, right", exact: 2, rest: "number", nonZero: [1] },
      emit: ({ args, value }) => ({ $mod: [value(args[0]), value(args[1])] }),
    },
    stream: unsupported("'%' produces a value, not a stage."),
    statement: unsupported("'%' is not a statement — see its 'where'."),
  }),

  exponentiation: production({
    doc: "Raises the left number to the right power.",
    tokens: ["**"],
    spelling: "**",
    becomes: "BinaryExpr",
    precedence: 12,
    associativity: "right",
    fixity: "infix",
    leftOperandNot: ["logicalNot", "bitwiseNot", "typeCheck", "negation"],
    on: "any",
    passesNull: true,
    returns: "number",
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "left, right", exact: 2, rest: "number" },
      emit: ({ args, value }) => ({ $pow: [value(args[0]), value(args[1])] }),
    },
    stream: unsupported("'**' produces a value, not a stage."),
    statement: unsupported("'**' is not a statement — see its 'where'."),
  }),

  logicalNot: production({
    doc: "Inverts a condition.",
    tokens: ["!"],
    spelling: "!",
    becomes: "UnaryExpr",
    precedence: 13,
    associativity: "right",
    fixity: "prefix",
    on: "any",
    returns: "bool",
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "operand", exact: 1, slotType: { 0: "any" } },
      emit: ({ args, truth }) => ({ $not: truth(args[0]) }),
    },
    stream: unsupported("'!' produces a value, not a stage."),
    statement: unsupported("'!' is not a statement — see its 'where'."),
  }),

  negation: production({
    doc: "Negates a number. Binds tighter than `**`, unlike JavaScript.",
    tokens: ["-"],
    spelling: "-x",
    becomes: "UnaryExpr",
    precedence: 13,
    associativity: "right",
    fixity: "prefix",
    on: "any",
    passesNull: true,
    returns: "number",
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "operand", exact: 1, slotType: { 0: "number" } },
      emit: ({ args, value }) => ({ $multiply: [value(args[0]), -1] }),
    },
    stream: unsupported("'-x' produces a value, not a stage."),
    statement: unsupported("'-x' is not a statement — see its 'where'."),
  }),

  bitwiseNot: production({
    doc: "Inverts the bits of an integer.",
    tokens: ["~"],
    spelling: "~",
    becomes: "UnaryExpr",
    precedence: 13,
    associativity: "right",
    fixity: "prefix",
    on: "any",
    returns: "number",
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "operand", exact: 1, slotType: { 0: "int-or-long" } },
      emit: ({ args, value }) => ({ $bitNot: value(args[0]) }),
    },
    stream: unsupported("'~' produces a value, not a stage."),
    statement: unsupported("'~' is not a statement — see its 'where'."),
  }),

  typeCheck: production({
    doc: "The type name of a value.",
    tokens: ["typeof"],
    spelling: "typeof",
    becomes: "UnaryExpr",
    precedence: 13,
    associativity: "right",
    fixity: "prefix",
    on: "any",
    returns: "string",
    where: ["value"],
    filter: composedInto("strictEquality", "strictInequality"),
    expr: {
      args: { sig: "operand", exact: 1, slotType: { 0: "any" } },
      emit: ({ args, value }) => ({ $type: value(args[0]) }),
    },
    stream: unsupported("'typeof' produces a value, not a stage."),
    statement: unsupported("'typeof' is not a statement — see its 'where'."),
  }),

  memberAccess: production({
    doc: "Reads a field, or dispatches a name onto a receiver.",
    tokens: [".", "identifier"],
    spelling: ".field",
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
    expr: inCode("src/compiler/emit/lower.ts"),
    stream: unsupported("'.field' produces a value, not a stage."),
    statement: unsupported("'.field' is not a statement — see its 'where'."),
  }),

  optionalMemberAccess: production({
    doc: "Reads a field, yielding nothing when the receiver is absent.",
    tokens: ["?."],
    spelling: "?.field",
    becomes: "MemberAccess",
    precedence: 14,
    associativity: "left",
    fixity: "postfix",
    neverAWriteTarget: { instead: "Drop the '?.' to write the field" },
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
    expr: inCode("src/compiler/emit/lower.ts"),
    stream: unsupported("'?.field' produces a value, not a stage."),
    statement: unsupported("'?.field' is not a statement — see its 'where'."),
  }),

  indexAccess: production({
    doc: "Reads an element by index, or a field by computed name.",
    tokens: ["[", "]", "?."],
    spelling: "[…]",
    becomes: "IndexAccess",
    precedence: 14,
    associativity: "left",
    fixity: "postfix",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: inCode("src/compiler/emit/lower.ts", { sig: "index", exact: 1, slotType: { 0: "value" } }),
    stream: unsupported("'[…]' produces a value, not a stage."),
    statement: unsupported("'[…]' is not a statement — see its 'where'."),
  }),

  call: production({
    doc: "Applies a callable to arguments.",
    tokens: ["(", ")", ","],
    spelling: "f(x)",
    becomes: "CallExpression",
    precedence: 14,
    associativity: "left",
    fixity: "postfix",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: inCode("src/compiler/emit/lower.ts"),
    stream: unsupported("'f(x)' produces a value, not a stage."),
    statement: unsupported("'f(x)' is not a statement — see its 'where'."),
  }),

  methodCall: production({
    doc: "Applies a name to a receiver: `$.s.trim()`.",
    tokens: [".", "(", ")", ",", "?.", "$", "identifier"],
    spelling: ".method()",
    becomes: "MethodCall",
    precedence: 14,
    associativity: "left",
    fixity: "postfix",
    on: "any",
    returns: "unknown",
    where: ["value", "filter"],
    filter: inCode("src/compiler/emit/filter.ts"),
    expr: inCode("src/compiler/emit/lower.ts"),
    stream: unsupported("'.method()' produces a value, not a stage."),
    statement: unsupported("'.method()' is not a statement — see its 'where'."),
  }),

  operatorCall: production({
    doc: "The `$op(...)` escape hatch. Which operators exist is in names.ts.",
    tokens: ["$", "(", ")", ",", "identifier"],
    spelling: "$op()",
    becomes: "OperatorCall",
    on: "any",
    returns: "unknown",
    where: ["value", "filter"],
    filter: inCode("src/compiler/emit/filter.ts"),
    expr: inCode("src/compiler/emit/lower.ts"),
    stream: unsupported("'$op()' produces a value, not a stage."),
    statement: unsupported("'$op()' is not a statement — see its 'where'."),
  }),

  namespacedCall: production({
    doc: "`Number.isInteger(n)`, `Date.now()`.",
    tokens: [".", "(", ")", ",", "identifier"],
    spelling: "Class.method()",
    becomes: ["MethodCall", "MemberAccess"],
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: inCode("src/compiler/emit/lower.ts"),
    stream: unsupported("'Class.method()' produces a value, not a stage."),
    statement: unsupported("'Class.method()' is not a statement — see its 'where'."),
  }),

  constructorCall: production({
    doc: "`new X(…)`: parsed, then refused (HR8). JSMQL has no `new` keyword; the refusal names `X(…)`.",
    tokens: ["new", "(", ")", ",", "identifier"],
    spelling: "new X()",
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
    expr: inCode("src/compiler/emit/lower.ts"),
    stream: unsupported("'new X()' produces a value, not a stage."),
    statement: unsupported("'new X()' is not a statement — see its 'where'."),
  }),

  typeCast: production({
    doc: "`Number(x)`, `String(x)`, `Boolean(x)` — a bare global conversion.",
    tokens: ["(", ")", "identifier"],
    spelling: "Number(x)",
    becomes: "CallExpression",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: inCode("src/compiler/emit/lower.ts"),
    stream: unsupported("'Number(x)' produces a value, not a stage."),
    statement: unsupported("'Number(x)' is not a statement — see its 'where'."),
  }),

  unappliedReference: production({
    doc: "A callable given to a higher-order name, but not applied: `map(String)`, `map(Number)`.",
    tokens: ["identifier"],
    spelling: "String",
    becomes: "Ident",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: inCode("src/compiler/emit/lower.ts"),
    stream: unsupported("'String' produces a value, not a stage."),
    statement: unsupported("'String' is not a statement — see its 'where'."),
  }),

  fieldReference: production({
    doc: "`$.name` — a field of the current document. `$.name(…)` is the `methodCall` production on the bare `$`: a field is never callable.",
    tokens: ["$.", "identifier"],
    spelling: "$.field",
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
    expr: inCode("src/compiler/emit/lower.ts"),
    stream: unsupported("'$.field' produces a value, not a stage."),
    statement: unsupported("'$.field' is not a statement — see its 'where'."),
  }),

  rootReference: production({
    doc: "`$` — the whole current document.",
    tokens: ["$"],
    spelling: "$",
    becomes: "FieldRef",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: inCode("src/compiler/emit/lower.ts"),
    stream: unsupported("'$' produces a value, not a stage."),
    statement: unsupported("'$' is not a statement — see its 'where'."),
  }),

  streamReference: production({
    doc: "`$$` — the root stream.",
    tokens: ["$$"],
    spelling: "$$",
    becomes: "StreamRef",
    on: "any",
    returns: "unknown",
    where: ["stream"],
    filter: unsupported("'$$' is a stream, not a filter predicate."),
    expr: unsupported("'$$' is a statement, not an aggregation expression."),
    stream: inCode("src/compiler/emit/statement.ts"),
    statement: unsupported("'$$' is not a statement — see its 'where'."),
  }),

  collectionReference: production({
    doc: "`$$$.<coll>` — another collection.",
    tokens: ["$$$"],
    spelling: "$$$.<coll>",
    becomes: "DatabaseRef",
    on: "any",
    returns: "unknown",
    where: ["stream"],
    filter: unsupported("'$$$.<coll>' names a collection, not a filter predicate."),
    expr: unsupported("'$$$.<coll>' is a statement, not an aggregation expression."),
    stream: inCode("src/compiler/emit/statement.ts"),
    statement: unsupported("'$$$.<coll>' is not a statement — see its 'where'."),
  }),

  clusterReference: production({
    doc: "`$$$$` — cluster scope, for the diagnostic source stages.",
    tokens: ["$$$$"],
    spelling: "$$$$",
    becomes: "ClusterRef",
    on: "any",
    returns: "unknown",
    where: ["stream"],
    filter: unsupported("'$$$$' names a cluster, not a filter predicate."),
    expr: unsupported("'$$$$' is a statement, not an aggregation expression."),
    stream: inCode("src/compiler/emit/statement.ts"),
    statement: unsupported("'$$$$' is not a statement — see its 'where'."),
  }),

  parameterReference: production({
    doc: "A name bound by the parameter destructure. At the call it becomes its value: a literal when the source could have spelled it, an `Injected` node otherwise.",
    tokens: ["identifier"],
    spelling: "<param>",
    becomes: ["Ident", "Injected"],
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
    expr: inCode("src/compiler/emit/lower.ts"),
    stream: unsupported("'<param>' produces a value, not a stage."),
    statement: unsupported("'<param>' is not a statement — see its 'where'."),
  }),

  numberLiteral: production({
    doc: "A number.",
    tokens: ["number"],
    spelling: "42",
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
    expr: inCode("src/compiler/emit/lower.ts"),
    stream: unsupported("'42' produces a value, not a stage."),
    statement: unsupported("'42' is not a statement — see its 'where'."),
  }),

  stringLiteral: production({
    doc: "A string.",
    tokens: ["string"],
    spelling: '"text"',
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
    expr: inCode("src/compiler/emit/lower.ts"),
    stream: unsupported("'\"text\"' produces a value, not a stage."),
    statement: unsupported("'\"text\"' is not a statement — see its 'where'."),
  }),

  bigIntLiteral: production({
    doc: "A BigInt.",
    tokens: ["bigint"],
    spelling: "123n",
    becomes: "BigIntLiteral",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: inCode("src/compiler/emit/lower.ts"),
    stream: unsupported("'123n' produces a value, not a stage."),
    statement: unsupported("'123n' is not a statement — see its 'where'."),
  }),

  regexLiteral: production({
    doc: "A regular expression.",
    tokens: ["regex"],
    spelling: "/re/",
    becomes: "RegexLiteral",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: composedInto("methodCall"),
    expr: inCode("src/compiler/emit/lower.ts"),
    stream: unsupported("'/re/' produces a value, not a stage."),
    statement: unsupported("'/re/' is not a statement — see its 'where'."),
  }),

  booleanLiteral: production({
    doc: "A boolean.",
    tokens: ["true", "false"],
    spelling: "true / false",
    becomes: "BooleanLiteral",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: composedInto("strictEquality", "strictInequality"),
    expr: inCode("src/compiler/emit/lower.ts"),
    stream: unsupported("'true / false' produces a value, not a stage."),
    statement: unsupported("'true / false' is not a statement — see its 'where'."),
  }),

  nullLiteral: production({
    doc: "An explicit null.",
    tokens: ["null"],
    spelling: "null",
    becomes: "NullLiteral",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: composedInto("strictEquality", "strictInequality", "looseEquality", "looseInequality"),
    expr: inCode("src/compiler/emit/lower.ts"),
    stream: unsupported("'null' produces a value, not a stage."),
    statement: unsupported("'null' is not a statement — see its 'where'."),
  }),

  undefinedLiteral: production({
    doc: "Absence. Meaningful only in a comparison — `x === undefined`.",
    tokens: ["undefined"],
    spelling: "undefined",
    becomes: "UndefinedLiteral",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: composedInto("strictEquality", "strictInequality"),
    expr: inCode("src/compiler/emit/lower.ts"),
    stream: unsupported("'undefined' produces a value, not a stage."),
    statement: unsupported("'undefined' is not a statement — see its 'where'."),
  }),

  objectIdLiteral: production({
    doc: "`0x` followed by 24 hex digits. The lexer produces a NUMBER; this rule re-reads it as an ObjectId.",
    tokens: ["number"],
    spelling: "0x<24 hex>",
    becomes: "ObjectIdLiteral",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: composedInto("strictEquality", "strictInequality"),
    expr: inCode("src/compiler/emit/lower.ts"),
    stream: unsupported("'0x<24 hex>' produces a value, not a stage."),
    statement: unsupported("'0x<24 hex>' is not a statement — see its 'where'."),
  }),

  templateLiteral: production({
    doc: "A string built from parts.",
    tokens: ["`", "templateText", "${"],
    spelling: "`…${x}`",
    becomes: "TemplateLiteral",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: inCode("src/compiler/emit/lower.ts"),
    stream: unsupported("'`…${x}`' produces a value, not a stage."),
    statement: unsupported("'`…${x}`' is not a statement — see its 'where'."),
  }),

  objectLiteral: production({
    doc: "A document. At the top level it is the query document itself; with one stage-name key it is a stage.",
    tokens: ["{", "}", ":", ",", "[", "]"],
    spelling: "{ … }",
    becomes: "ObjectLiteral",
    on: "any",
    returns: "unknown",
    where: ["value", "filter", "stream"],
    filter: inCode("src/compiler/emit/filter.ts"),
    expr: inCode("src/compiler/emit/lower.ts"),
    stream: inCode("src/compiler/emit/statement.ts"),
    statement: unsupported("'{ … }' is not a statement — see its 'where'."),
  }),

  arrayLiteral: production({
    doc: "A list. At the top level it is a pipeline.",
    tokens: ["[", "]", ","],
    spelling: "[ … ]",
    becomes: "ArrayLiteral",
    on: "any",
    returns: "unknown",
    where: ["value", "stream"],
    filter: composedInto("methodCall"),
    expr: inCode("src/compiler/emit/lower.ts"),
    stream: inCode("src/compiler/emit/statement.ts"),
    statement: unsupported("'[ … ]' is not a statement — see its 'where'."),
  }),

  spread: production({
    doc: "Splices an array or object into place.",
    tokens: ["..."],
    spelling: "...x",
    becomes: "SpreadElement",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: inCode("src/compiler/emit/lower.ts"),
    stream: unsupported("'...x' produces a value, not a stage."),
    statement: unsupported("'...x' is not a statement — see its 'where'."),
  }),

  objectEntry: production({
    doc: "One `key: value` pair of a document.",
    tokens: [":"],
    spelling: "key: value",
    becomes: "KeyValueEntry",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: inCode("src/compiler/emit/lower.ts"),
    stream: unsupported("'key: value' produces a value, not a stage."),
    statement: unsupported("'key: value' is not a statement — see its 'where'."),
  }),

  arrowFunction: production({
    doc: "A callback: parameters, then a body.",
    tokens: ["=>", "(", ")", ",", "{", "}", "return", "identifier"],
    spelling: "x => …",
    becomes: "Lambda",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: composedInto("methodCall"),
    expr: inCode("src/compiler/emit/lower.ts"),
    stream: unsupported("'x => …' produces a value, not a stage."),
    statement: unsupported("'x => …' is not a statement — see its 'where'."),
  }),

  destructuringParam: production({
    doc: "`({ a, b }, { $ }) => …` binds each named parameter. The ONLY parameter form: a plain name is refused, one level deep, renaming allowed, no defaults, no rest.",
    tokens: ["{", "}", ",", "(", ")", "identifier", ":", "$", "$$", "$$$", "$$$$"],
    spelling: "({ $ }) => …",
    becomes: { notANode: "produces ParamBinding[], which the parser holds beside the tree, not in it" },
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: inCode("src/compiler/parse/parser.ts"),
    stream: unsupported("'({ $ }) => …' produces a value, not a stage."),
    statement: unsupported("'({ $ }) => …' is not a statement — see its 'where'."),
  }),

  blockReturn: production({
    doc: "Yields a block's value. Declarations may precede it in a callback block, but not in an entry block.",
    tokens: ["return", "{", "}"],
    spelling: "{ return … }",
    becomes: "ExprBlock",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: inCode("src/compiler/emit/lower.ts"),
    stream: unsupported("'{ return … }' produces a value, not a stage."),
    statement: unsupported("'{ return … }' is not a statement — see its 'where'."),
  }),

  constantBinding: production({
    doc: "Binds a name for the statements that follow. A `,` continues the list, and each declarator is its own declaration. A statement, never an array element: JavaScript refuses `[const x = …]`. One scope declares a name once, its function's parameters included.",
    tokens: ["const", "=", "identifier", ","],
    spelling: "const x = …",
    becomes: "LetDecl",
    on: "any",
    returns: "unknown",
    where: ["statement", "value"],
    filter: unsupported("'const x = …' is a declaration, not a filter predicate."),
    expr: inCode("src/compiler/emit/lower.ts"),
    statement: inCode("src/compiler/emit/statement.ts"),
    stream: unsupported("'const x = …' is not a link in a '$$ = $$…' chain — see its 'where'."),
  }),

  mutableBinding: production({
    doc: "Binds a reassignable name. A `,` continues the list, and each declarator is its own declaration. A statement, never an array element: JavaScript refuses `[let x = …]`. One scope declares a name once, its function's parameters included.",
    tokens: ["let", "=", "identifier", ","],
    spelling: "let x = …",
    becomes: "LetDecl",
    on: "any",
    returns: "unknown",
    where: ["statement", "value"],
    filter: unsupported("'let x = …' is a declaration, not a filter predicate."),
    expr: inCode("src/compiler/emit/lower.ts"),
    statement: inCode("src/compiler/emit/statement.ts"),
    stream: unsupported("'let x = …' is not a link in a '$$ = $$…' chain — see its 'where'."),
  }),

  functionBinding: production({
    doc: "A reusable expression over parameters. `function` is NOT reserved — it lexes as an identifier.",
    word: "function",
    tokens: ["identifier", "const", "=", "=>", "(", ")", "let", "{", "}", "return"],
    spelling: "function f()",
    becomes: "FuncDecl",
    on: "any",
    returns: "unknown",
    where: ["statement"],
    filter: unsupported("'function f()' is a declaration, not a filter predicate."),
    expr: unsupported("'function f()' is a statement, not an aggregation expression."),
    statement: inCode("src/compiler/emit/statement.ts"),
    stream: unsupported("'function f()' is not a link in a '$$ = $$…' chain — see its 'where'."),
  }),

  fieldDeletion: production({
    doc: "Removes a field.",
    tokens: ["delete", "$.", ","],
    spelling: "delete $.field",
    becomes: "DeleteStmt",
    on: "any",
    returns: "unknown",
    where: ["statement"],
    filter: unsupported("'delete $.field' removes a field. To require absence write '$.a === undefined'."),
    expr: unsupported("'delete $.field' is a statement, not an aggregation expression."),
    statement: inCode("src/compiler/emit/statement.ts"),
    stream: unsupported("'delete $.field' is not a link in a '$$ = $$…' chain — see its 'where'."),
  }),

  fieldAssignment: production({
    doc: "Writes a value to a field. `+=` `-=` `*=` `/=` desugar into the same node. A `,` joins two writes; it cannot end the run, because JavaScript refuses `$.a = 1,`.",
    tokens: ["=", "+=", "-=", "*=", "/=", ",", "(", ")"],
    spelling: "$.field = …",
    becomes: ["AssignExpr", "UpdateFilter"],
    on: "any",
    returns: "unknown",
    where: ["statement"],
    filter: unsupported("'$.field = …' is an assignment, not a filter predicate."),
    expr: unsupported("'$.field = …' is a statement, not an aggregation expression."),
    statement: inCode("src/compiler/emit/statement.ts"),
    stream: unsupported("'$.field = …' is not a link in a '$$ = $$…' chain — see its 'where'."),
  }),

  increment: production({
    doc: "Adds one to a field. As a statement, `++$.a` and `$.a++` are the same write. Inside a value, the parser refuses both.",
    tokens: ["++"],
    spelling: "++",
    becomes: ["AssignExpr", "UpdateFilter"],
    precedence: 14,
    fixity: "prefixOrPostfix",
    asStatement: "+= 1",
    on: "any",
    returns: "unknown",
    where: ["statement"],
    filter: unsupported("'++' writes a field; it is not a filter predicate."),
    expr: unsupported("'++' is a statement, not an aggregation expression."),
    statement: inCode("src/compiler/emit/statement.ts"),
    stream: unsupported("'++' is not a link in a '$$ = $$…' chain — see its 'where'."),
  }),

  decrement: production({
    doc: "Subtracts one from a field. As a statement, `--$.a` and `$.a--` are the same write. Inside a value, the parser refuses both.",
    tokens: ["--"],
    spelling: "--",
    becomes: ["AssignExpr", "UpdateFilter"],
    precedence: 14,
    fixity: "prefixOrPostfix",
    asStatement: "-= 1",
    on: "any",
    returns: "unknown",
    where: ["statement"],
    filter: unsupported("'--' writes a field; it is not a filter predicate."),
    expr: unsupported("'--' is a statement, not an aggregation expression."),
    statement: inCode("src/compiler/emit/statement.ts"),
    stream: unsupported("'--' is not a link in a '$$ = $$…' chain — see its 'where'."),
  }),

  pipelineStatement: production({
    doc: "Separates pipeline statements. Its presence at the top level makes the output a Pipeline.",
    tokens: [";"],
    spelling: ";",
    becomes: "Pipeline",
    on: "any",
    returns: "unknown",
    where: ["statement"],
    filter: unsupported(
      "';' makes the output a Pipeline, which is not a filter predicate. Drop the ';' to write a filter.",
    ),
    expr: unsupported("';' is a statement, not an aggregation expression."),
    statement: inCode("src/compiler/emit/statement.ts"),
    stream: unsupported("';' is not a link in a '$$ = $$…' chain — see its 'where'."),
  }),

  letReassignment: production({
    doc: "`name = <expr>` rebinds a `let`. Tried before every other assignment form.",
    tokens: ["identifier", "=", "+=", "-=", "*=", "/=", "++", "--"],
    spelling: "name = …",
    becomes: "AssignExpr",
    on: "any",
    returns: "unknown",
    where: ["statement"],
    after: [],
    filter: unsupported("'name = …' is a statement, not a filter predicate."),
    expr: unsupported("'name = …' is a statement, not an aggregation expression."),
    statement: inCode("src/compiler/emit/statement.ts"),
    stream: unsupported("'name = …' is not a link in a '$$ = $$…' chain — see its 'where'."),
  }),

  streamReplacement: production({
    doc: "`$$ = $$.<chain>` replaces the stream with the chain's stages.",
    tokens: ["$$", "=", "$$$", "[", "]", "{", "}"],
    spelling: "$$ = …",
    becomes: "AssignExpr",
    on: "any",
    returns: "unknown",
    where: ["statement"],
    after: ["letReassignment"],
    filter: unsupported("'$$ = …' is a statement, not a filter predicate."),
    expr: unsupported("'$$ = …' is a statement, not an aggregation expression."),
    statement: inCode("src/compiler/emit/statement.ts"),
    stream: unsupported("'$$ = …' is not a link in a '$$ = $$…' chain — see its 'where'."),
  }),

  rootReplacement: production({
    doc: "`$ = <expr>` replaces the document root.",
    tokens: ["$", "="],
    spelling: "$ = …",
    becomes: "AssignExpr",
    on: "any",
    returns: "unknown",
    where: ["statement"],
    after: ["letReassignment", "streamReplacement"],
    filter: unsupported("'$ = …' is a statement, not a filter predicate."),
    expr: unsupported("'$ = …' is a statement, not an aggregation expression."),
    statement: inCode("src/compiler/emit/statement.ts"),
    stream: unsupported("'$ = …' is not a link in a '$$ = $$…' chain — see its 'where'."),
  }),

  collectionWrite: production({
    doc: "`$$$.<coll> = $$` writes the stream to a collection.",
    tokens: ["$$$", "=", "$$$$", ".", "[", "]", "string"],
    spelling: "$$$.<coll> = …",
    becomes: "AssignExpr",
    on: "any",
    returns: "unknown",
    where: ["statement"],
    only: ["stageLast"],
    after: ["letReassignment", "streamReplacement", "rootReplacement"],
    filter: unsupported("'$$$.<coll> = …' is a statement, not a filter predicate."),
    expr: unsupported("'$$$.<coll> = …' is a statement, not an aggregation expression."),
    statement: inCode("src/compiler/emit/statement.ts"),
    stream: unsupported("'$$$.<coll> = …' is not a link in a '$$ = $$…' chain — see its 'where'."),
  }),

  foreignJoin: production({
    doc: "`$.o = $$$.<coll>.find(<pred>)` joins another collection.",
    tokens: ["$.", "$$$", "=", ".", "(", ")", "=>", "const", "let", "identifier"],
    spelling: "$.x = $$$.<coll>.find(…)",
    becomes: "AssignExpr",
    on: "any",
    returns: "unknown",
    where: ["statement"],
    after: ["letReassignment", "streamReplacement", "rootReplacement", "collectionWrite"],
    filter: unsupported("'$.x = $$$.<coll>.find(…)' is a statement, not a filter predicate."),
    expr: unsupported("'$.x = $$$.<coll>.find(…)' is a statement, not an aggregation expression."),
    statement: inCode("src/compiler/emit/join.ts"),
    stream: unsupported("'$.x = $$$.<coll>.find(…)' is not a link in a '$$ = $$…' chain — see its 'where'."),
  }),
};

export type ProductionKey = keyof typeof PRODUCTIONS;

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

type DanglingAfter = Exclude<Mentioned<"after">, ProductionKey>;
const _afterResolves: [DanglingAfter] extends [never] ? true : DanglingAfter = true;

type CellName = "filter" | "expr" | "stream" | "statement";

type OwnersNamedBy<K extends ProductionKey> = {
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

void _afterResolves;
void _composedIntoResolves;

type DanglingNoMixWith = Exclude<Mentioned<"noMixWith">, ProductionKey>;
const _noMixWithResolves: [DanglingNoMixWith] extends [never] ? true : DanglingNoMixWith = true;
type DanglingLeftOperandNot = Exclude<Mentioned<"leftOperandNot">, ProductionKey>;
const _leftOperandNotResolves: [DanglingLeftOperandNot] extends [never] ? true : DanglingLeftOperandNot = true;

void _noMixWithResolves;
void _leftOperandNotResolves;
