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
import { composedInto, inCode, pending, unsupported, viaFallback } from "./vocabulary.ts";
import type { Cell, Expr, ExprIn, FilterIn, FilterOut, Lists, Of, OutOf, QueryDoc, StageIn } from "./vocabulary.ts";
import { FIELD_VALUE, NOT_OWN_VALUE, OWN_VALUE, queryOwnValue, typeAliasOf } from "./vocabulary.ts";
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
  /** The rules `noMixWith` names, threaded so the audit reads the literal. */
  M extends readonly string[] = readonly never[],
  /** The rules `leftOperandNot` names, likewise. */
  L extends readonly string[] = readonly never[],
> = {
  doc: string;
  /**
   * The symbols this rule consumes — keys of tokens.ts or keywords.ts.
   *
   * THE FIRST ENTRY IS THE TRIGGER: the lexeme whose appearance selects this
   * rule. A parser builds its dispatch tables from `tokens[0]`, so the order of
   * the rest is free but the head is not. `conditional` leads with `?` and not
   * `:`, `methodCall` with `.` and not `(`.
   */
  tokens: T;
  /**
   * How a developer WRITES this rule — the string every refusal names it by.
   *
   * The key is descriptive (`conditional`, `remainder`) so that two rules cannot
   * collide on a symbol, and a descriptive key must never reach a user: nobody
   * types the word "conditional". `tokens` cannot supply this either, because it
   * lists every lexeme the rule consumes — joined, `methodCall` reads
   * `.(),?.$identifier`. So the spelling is stated, once, here.
   */
  spelling: string;
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
   * The literal identifier text this rule requires, when its trigger is the
   * `identifier` class rather than a fixed spelling.
   *
   * `function` is NOT a reserved word here — it lexes as a name, so keywords.ts
   * correctly has no row for it — yet the parser must still recognise the text to
   * parse `function f(x) { return x }`. The word belongs on the rule that needs
   * it, so no phase carries a hard-coded name.
   */
  word?: string;
  /**
   * Levels this may not sit beside unparenthesised on EITHER side, because
   * JavaScript refuses the pair: `a ?? b || c` and `a || b ?? c` are both
   * SyntaxErrors. Symmetric — see `leftOperandNot` for the one-sided rule.
   */
  noMixWith?: M;
  /**
   * Levels the LEFT operand may not be, unparenthesised. One-sided, because that
   * is what JavaScript states for `**`: `-a ** 2` and `typeof a ** 2` are
   * SyntaxErrors, while `2 ** -1` and `2 ** typeof a` parse (node --check). A
   * symmetric `noMixWith` here refused the valid right-hand forms — the strict-
   * subset rule broken in the other direction.
   */
  leftOperandNot?: L;
  /**
   * A left-nested chain of this operator lowers as ONE operator over every
   * operand: `a * b * c` → `{ $multiply: [a, b, c] }`, not two nested pairs.
   * Stated per row, because associativity alone does not say it — `-` is
   * left-associative and `a - b - c` is two subtractions.
   */
  flattensChain?: true;
  /**
   * The node this rule builds can never be the left of `=`, `+=`, `++` or `--`,
   * and what to write instead. `a?.b = 1` is a JavaScript SyntaxError (an
   * optional chain anywhere in the target, not only at its end), so the parser
   * refuses it from the row — the message is "'<spelling>' cannot be assigned to
   * — JavaScript rejects it. <instead>". Not `delete`: `delete a?.b` is legal.
   */
  neverAWriteTarget?: { instead: string };
  filter: Cell<Lists<W, "filter">, Of<O>, FilterIn, FilterOut<Lists<W, "value">>, C>;
  expr: Cell<Lists<W, "value">, Of<O>, ExprIn, OutOf["value"], C>;
  /** A link in a `$$ = $$…` chain. */
  stream: Cell<Lists<W, "stream">, Of<O>, StageIn, OutOf["stream"], C>;
  /** A `;`-separated statement. SEPARATE from `stream` — see Position. */
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

// Every generic defaults to the EMPTY type, never to its constraint — a rule with no
// `after` would otherwise widen `A` to `readonly string[]` and the audit below would
// pass while checking nothing.
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

// ── the query cells the comparison productions share ─────────────────────────
//
// A query document compares a FIELD PATH with a CONSTANT. Each helper answers
// null when the operands are not that pair, and the cell's null is the stated
// signal for "wrap my value form in $expr" (see `FilterOut`).

/** The path-and-constant pair a two-operand comparison holds, either way round, or null. */
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

/** `$.x in [c, …]` — a field's own value among constants: the native `$in`, which the planner reads. */
function membershipQuery(input: FilterIn): QueryDoc | null {
  const [l, r] = input.args;
  const path = input.pathOf(l);
  if (path === null) return null;
  const c = input.constant(r);
  if (c === null || !Array.isArray(c.value)) return null;
  return queryOwnValue(path, { $in: c.value }, OWN_VALUE);
}

/** `typeof x === "s"` either way round: the operand's path and the BSON alias, or null. */
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

/** `x === undefined` either way round: the operand's path, or null. */
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

/** `x % d === m` either way round, with integer `d` and `m`: the path and the pair, or null. */
function moduloTest(input: FilterIn): { path: string; divisor: number; remainder: number } | null {
  const [l, r] = input.args;
  // The remainder may be negative: `$.a % 3 === -1` is `{ $mod: [3, -1] }`, which
  // the server takes and JavaScript agrees with.
  const isNat = (e: Expr) => e.type === "NumberLiteral" && Number.isInteger(e.value);
  const asMod = (e: Expr, other: Expr) => {
    if (e.type !== "BinaryExpr" || e.op !== "%" || !isNat(other)) return null;
    const path = input.pathOf(e.left);
    // A zero divisor never reaches a query cell: the `remainder` row's `nonZero` refuses it first.
    if (path === null || e.right.type !== "NumberLiteral" || !Number.isInteger(e.right.value) || e.right.value === 0)
      return null;
    return { path, divisor: e.right.value, remainder: (other as { value: number }).value };
  };
  return asMod(l, r) ?? asMod(r, l);
}

/** `x === null` either way round: the operand's path, or null. */
function nullTest(input: FilterIn): string | null {
  const [l, r] = input.args;
  if (l.type === "NullLiteral") return r.type === "NullLiteral" ? null : input.pathOf(r);
  return r.type === "NullLiteral" ? input.pathOf(l) : null;
}

/**
 * `x === undefined` and `typeof x === "undefined"` are one test: the field is
 * absent. An array at a path PREFIX reads as absent in JavaScript too, so the
 * positive form takes it as an alternative and the negated form excludes it.
 */
const presenceQuery = (path: string, negated: boolean): QueryDoc =>
  queryOwnValue(path, { $exists: negated }, { ...FIELD_VALUE, whenAbsent: !negated, whenArray: negated });

/** `.length` compared with a natural number is a LENGTH, which no query form expresses. */
function comparesALength(input: FilterIn): boolean {
  const isLength = (e: Expr) => e.type === "MemberAccess" && e.name === "length";
  const [l, r] = input.args;
  return isLength(l) || isLength(r);
}

/**
 * The strict equality cells. Tried in order: the type test, the presence test,
 * the modulo test, the null test, then a field against a constant. A `.length`
 * comparison has no query form (the server has `$size` for arrays only).
 */
function strictEqualityQuery(input: FilterIn, negated: boolean): QueryDoc | null {
  const typed = typeTest(input);
  if (typed !== null) {
    // The `array` spelling asks whether the value IS an array, so it excludes none.
    if (typed.alias === "array") {
      return negated
        ? queryOwnValue(typed.path, { $not: { $type: "array" } }, { whenAbsent: true, whenArray: false })
        : queryOwnValue(typed.path, { $type: "array" }, { whenAbsent: false, whenArray: true });
    }
    return negated
      ? queryOwnValue(typed.path, { $not: { $type: typed.alias } }, NOT_OWN_VALUE)
      : queryOwnValue(typed.path, { $type: typed.alias }, OWN_VALUE);
  }
  const present = presenceTest(input);
  if (present !== null) return presenceQuery(present, negated);
  if (comparesALength(input)) return null;
  const mod = moduloTest(input);
  if (mod !== null) {
    const test = { $mod: [mod.divisor, mod.remainder] };
    return negated ? queryOwnValue(mod.path, { $not: test }, NOT_OWN_VALUE) : queryOwnValue(mod.path, test, OWN_VALUE);
  }
  const nul = nullTest(input);
  if (nul !== null) {
    return negated
      ? queryOwnValue(nul, { $not: { $type: "null" } }, NOT_OWN_VALUE)
      : queryOwnValue(nul, { $type: "null" }, OWN_VALUE);
  }
  const pc = pathAndConstant(input);
  if (pc === null) return null;
  // A RegExp the call supplied is MongoDB's regex query, as the developer passed it: the
  // query language reads `{ field: /re/ }` as a match, and `$eq` would compare a value.
  if (pc.value instanceof RegExp) return negated ? { [pc.path]: { $not: pc.value } } : { [pc.path]: pc.value };
  return negated
    ? queryOwnValue(pc.path, { $ne: pc.value }, NOT_OWN_VALUE)
    : queryOwnValue(pc.path, { $eq: pc.value }, OWN_VALUE);
}

/** `==`/`!=` against null only: `{ f: null }` matches null OR missing, the loose meaning. */
function looseEqualityQuery(input: FilterIn, negated: boolean): QueryDoc | null {
  const path = nullTest(input);
  if (path === null) return null;
  // `$eq: null` is the loose meaning — it selects a null AND a missing field, so
  // `== null` holds for an absent field where `!= null` does not, and only the
  // negated form holds for an array (`[null] == null` is false in JavaScript).
  return negated
    ? queryOwnValue(path, { $ne: null }, { whenAbsent: false, whenArray: true })
    : queryOwnValue(path, { $eq: null }, { whenAbsent: true, whenArray: false });
}

const FLIPPED = { $gt: "$lt", $gte: "$lte", $lt: "$gt", $lte: "$gte" } as const;

/** An ordered comparison of a field with a number, a string or a date; flipped when the field is on the right. */
function orderedQuery(input: FilterIn, op: keyof typeof FLIPPED): QueryDoc | null {
  if (comparesALength(input)) return null;
  const pc = pathAndConstant(input);
  if (pc === null) return null;
  const v = pc.value;
  if (typeof v !== "number" && typeof v !== "string" && !(v instanceof Date)) return null;
  return queryOwnValue(pc.path, { [pc.flipped ? FLIPPED[op] : op]: v }, OWN_VALUE);
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
      args: { sig: "test, then, else", exact: 3 },
      emit: ({ args, value, truth }) => ({ $cond: { if: truth(args[0]), then: value(args[1]), else: value(args[2]) } }),
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
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: { args: { sig: "operands", atLeast: 2 }, emit: ({ args, value }) => ({ $ifNull: args.map(value) }) },
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
    filter: inCode("src/compiler/emit/filter.ts"),
    expr: inCode("src/compiler/emit/lower.ts"),
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
    filter: inCode("src/compiler/emit/filter.ts"),
    expr: inCode("src/compiler/emit/lower.ts"),
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
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: { args: { sig: "operands", atLeast: 2 }, emit: ({ args, value }) => ({ $bitOr: args.map(value) }) },
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
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: { args: { sig: "operands", atLeast: 2 }, emit: ({ args, value }) => ({ $bitXor: args.map(value) }) },
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
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: { args: { sig: "operands", atLeast: 2 }, emit: ({ args, value }) => ({ $bitAnd: args.map(value) }) },
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
    filter: { args: { sig: "left, right", exact: 2 }, emit: (input) => strictEqualityQuery(input, false) },
    expr: {
      args: { sig: "left, right", exact: 2 },
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
    filter: { args: { sig: "left, right", exact: 2 }, emit: (input) => strictEqualityQuery(input, true) },
    expr: {
      args: { sig: "left, right", exact: 2 },
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
    filter: { args: { sig: "left, right", exact: 2 }, emit: (input) => looseEqualityQuery(input, false) },
    expr: inCode("src/compiler/emit/lower.ts"),
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
    filter: { args: { sig: "left, right", exact: 2 }, emit: (input) => looseEqualityQuery(input, true) },
    expr: inCode("src/compiler/emit/lower.ts"),
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
    filter: { args: { sig: "left, right", exact: 2 }, emit: (input) => orderedQuery(input, "$gt") },
    expr: {
      args: { sig: "left, right", exact: 2 },
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
    filter: { args: { sig: "left, right", exact: 2 }, emit: (input) => orderedQuery(input, "$gte") },
    expr: {
      args: { sig: "left, right", exact: 2 },
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
    filter: { args: { sig: "left, right", exact: 2 }, emit: (input) => orderedQuery(input, "$lt") },
    expr: {
      args: { sig: "left, right", exact: 2 },
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
    filter: { args: { sig: "left, right", exact: 2 }, emit: (input) => orderedQuery(input, "$lte") },
    expr: {
      args: { sig: "left, right", exact: 2 },
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
    // MEASURED: `{ x: { $in: [1, 2, 3] } }` is the index-friendly query form; a list that is not a constant falls back to `$expr`
    filter: { args: { sig: "value, list", exact: 2 }, emit: (input) => membershipQuery(input) },
    expr: inCode("src/compiler/emit/lower.ts"),
    stream: unsupported("'x in [ … ]' produces a value, not a stage."),
    statement: unsupported("'x in [ … ]' is not a statement — see its 'where'."),
  }),

  addition: production({
    doc: "Adds numbers, or adds to a date.",
    tokens: ["+"],
    spelling: "+",
    becomes: "BinaryExpr",
    precedence: 10,
    associativity: "left",
    fixity: "infix",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: inCode("src/compiler/emit/lower.ts"),
    stream: unsupported("'+' produces a value, not a stage."),
    statement: unsupported("'+' is not a statement — see its 'where'."),
  }),

  subtraction: production({
    doc: "Subtracts numbers or dates.",
    tokens: ["-"],
    spelling: "-",
    becomes: "BinaryExpr",
    precedence: 10,
    associativity: "left",
    fixity: "infix",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "left, right", exact: 2 },
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
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: { args: { sig: "operands", atLeast: 2 }, emit: ({ args, value }) => ({ $multiply: args.map(value) }) },
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
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "left, right", exact: 2, nonZero: [1] },
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
    returns: "unknown",
    where: ["value"],
    filter: composedInto("strictEquality", "strictInequality"),
    expr: {
      args: { sig: "left, right", exact: 2, nonZero: [1] },
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
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "left, right", exact: 2 },
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
    expr: { args: { sig: "operand", exact: 1 }, emit: ({ args, truth }) => ({ $not: truth(args[0]) }) },
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
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: ({ args, value }) => ({ $multiply: [value(args[0]), -1] }) },
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
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: ({ args, value }) => ({ $bitNot: value(args[0]) }) },
    stream: unsupported("'~' produces a value, not a stage."),
    statement: unsupported("'~' is not a statement — see its 'where'."),
  }),

  typeCheck: production({
    doc: "The type name of a value.",
    tokens: ["typeof"],
    spelling: "typeof",
    // `typeof` is a prefix operator, so it needs no node of its own.
    becomes: "UnaryExpr",
    precedence: 13,
    associativity: "right",
    fixity: "prefix",
    on: "any",
    returns: "string",
    where: ["value"],
    filter: composedInto("strictEquality", "strictInequality"),
    expr: { args: { sig: "operand", exact: 1 }, emit: ({ args, value }) => ({ $type: value(args[0]) }) },
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
    spelling: "x[0]",
    becomes: "IndexAccess",
    precedence: 14,
    associativity: "left",
    fixity: "postfix",
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: inCode("src/compiler/emit/lower.ts"),
    stream: unsupported("'x[0]' produces a value, not a stage."),
    statement: unsupported("'x[0]' is not a statement — see its 'where'."),
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
    doc: "`Math.abs(x)`, `Object.keys(o)`, `Number.isInteger(n)`, `Date.now()`, `Array.from(...)`.",
    tokens: [".", "(", ")", ",", "identifier"],
    spelling: "Class.method()",
    // `Math.max(a, b)` is a MethodCall whose object is the name `Math`; `Math.PI` is a
    // MemberAccess. Seven node types collapsed here — the parser no longer knows
    // which namespace it is looking at.
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
    doc: "`new Date(…)`, `new Set(…)`, `new ObjectId(…)`. What each constructor means is in names.ts.",
    tokens: ["new", "(", ")", ",", "identifier"],
    spelling: "new X()",
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
    expr: inCode("src/compiler/emit/lower.ts"),
    stream: unsupported("'new X()' produces a value, not a stage."),
    statement: unsupported("'new X()' is not a statement — see its 'where'."),
  }),

  typeCast: production({
    doc: "`Number(x)`, `String(x)`, `Boolean(x)` — a bare global conversion.",
    tokens: ["(", ")", "identifier"],
    spelling: "Number(x)",
    // `Number($.s)` is a call whose callee is a name. Nothing about it is special
    // until names.ts resolves `Number`.
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
    doc: "A callable handed to a higher-order name without being applied: `map(String)`, `map(Math.abs)`.",
    tokens: ["identifier"],
    spelling: "String",
    // A bare name handed over unapplied is still just a name. Whether it MAY be is
    // the `asReference` field on its row.
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
    doc: "`$.name` — a field of the current document.",
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
    doc: "`$$` — the current collection as a stream.",
    tokens: ["$$"],
    spelling: "$$",
    // `$$` — the current collection as a stream.
    becomes: "CollectionRef",
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
    // `$$$` — database scope; `$$$.<coll>` names a collection.
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
    // `$$$$` — cluster scope.
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
    // Indistinguishable from any other bare name at parse time — scope decides; the
    // injection pass then replaces it by the value the call supplied.
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
    becomes: { notANode: "produces ParamBinding[], which the parser holds beside the tree rather than in it" },
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
    doc: "Binds a name for the statements that follow.",
    tokens: ["const", "=", "identifier"],
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
    doc: "Binds a reassignable name.",
    tokens: ["let", "=", "identifier"],
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
    doc: "Writes a value to a field. `+=` `-=` `*=` `/=` desugar into the same node.",
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
    doc: "Adds one to a field. `++$.a` and `$.a++` are the same.",
    tokens: ["++"],
    spelling: "++",
    becomes: ["AssignExpr", "UpdateFilter"],
    fixity: "prefixOrPostfix",
    on: "any",
    returns: "unknown",
    where: ["statement"],
    filter: unsupported("'++' writes a field; it is not a filter predicate."),
    expr: unsupported("'++' is a statement, not an aggregation expression."),
    statement: inCode("src/compiler/emit/statement.ts"),
    stream: unsupported("'++' is not a link in a '$$ = $$…' chain — see its 'where'."),
  }),

  decrement: production({
    doc: "Subtracts one from a field. `--$.a` and `$.a--` are the same.",
    tokens: ["--"],
    spelling: "--",
    becomes: ["AssignExpr", "UpdateFilter"],
    fixity: "prefixOrPostfix",
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

  // ── sugar: overlapping triggers, so precedence is declared ─────────────────
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

// There is deliberately NO audit over `tokens`. The rule — every entry is a key
// of tokens.ts or keywords.ts — is already enforced by `T extends readonly
// Lexeme[]` on the row itself, and enforced BETTER: the error lands on the
// offending row rather than on a line at the foot of the file.
//
// An audit here could not work even if it were wanted. When a row's literal
// violates the constraint, TypeScript reports it and then instantiates `T` with
// the CONSTRAINT, so `Mentioned<"tokens">` yields `Lexeme` and the audit reads
// `never`. Verified: injecting a bogus lexeme gives exactly one error, at the
// row, while the audit stays silent. `after` needs its audit because
// `A extends readonly string[]` imposes no equivalent constraint.

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

void _afterResolves;
void _composedIntoResolves;

/** Every `noMixWith` and `leftOperandNot` entry must be a rule in this same file. */
type DanglingNoMixWith = Exclude<Mentioned<"noMixWith">, ProductionKey>;
const _noMixWithResolves: [DanglingNoMixWith] extends [never] ? true : DanglingNoMixWith = true;
type DanglingLeftOperandNot = Exclude<Mentioned<"leftOperandNot">, ProductionKey>;
const _leftOperandNotResolves: [DanglingLeftOperandNot] extends [never] ? true : DanglingLeftOperandNot = true;

void _noMixWithResolves;
void _leftOperandNotResolves;
