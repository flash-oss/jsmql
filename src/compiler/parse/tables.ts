// The parser's dispatch tables, DERIVED from src/registry/productions.ts.
//
// The old parser encoded precedence as the call order of fourteen methods:
// parseTernary called parseNullish called parseOr, and so on down to parsePostfix.
// Nothing named a level, so adding an operator meant inserting a method in the
// right place and threading it through its neighbours. Here the level IS the
// number on the row, and a new operator is a new row.
//
// A rule's TRIGGER is `tokens[0]` — see the `tokens` doc in productions.ts.

import { PRODUCTIONS, type ProductionKey } from "../../registry/productions.ts";
import { TOKENS } from "../../registry/tokens.ts";
import { KEYWORDS } from "../../registry/keywords.ts";
import type { TokenName } from "../../registry/vocabulary.ts";

/**
 * What a trigger means at parse time. One entry per TRIGGER, not per rule: a
 * lexeme may head several rules and the parser tells them apart by lookahead —
 * `.` heads `memberAccess`, `methodCall` and `namespacedCall`, and only a
 * following `(` says which. What they MUST agree on is the level, and that is
 * checked when the table is built.
 */
export type Rule = {
  /** Every rule this trigger can head, in declaration order. */
  rules: readonly ProductionKey[];
  prec: number;
  assoc: "left" | "right" | "none";
  fixity: "prefix" | "infix" | "postfix" | "ternary" | "prefixOrPostfix";
  /** Levels this may not sit beside unparenthesised on EITHER side. See the row field. */
  noMixWith: readonly ProductionKey[];
  /** Levels the LEFT operand may not be, unparenthesised. See the row field. */
  leftOperandNot: readonly ProductionKey[];
  /** The node this rule builds cannot be the left of `=` or the operand of `delete`. */
  neverAWriteTarget: boolean;
};

/** Spelling or class name → the token type the lexer emits for it. */
function lexemeToType(lexeme: string): TokenName | null {
  const tok = (TOKENS as Record<string, { token: TokenName | readonly TokenName[] } | undefined>)[lexeme];
  if (tok !== undefined) return Array.isArray(tok.token) ? tok.token[0] : (tok.token as TokenName);
  const kw = (KEYWORDS as Record<string, { token: TokenName } | undefined>)[lexeme];
  return kw === undefined ? null : kw.token;
}

type Row = {
  tokens: readonly string[];
  precedence?: number;
  associativity?: "left" | "right" | "none";
  fixity?: Rule["fixity"];
  noMixWith?: readonly string[];
  leftOperandNot?: readonly string[];
  neverAWriteTarget?: { instead: string };
  word?: string;
  where?: readonly string[];
  becomes?: unknown;
};

const rows = Object.entries(PRODUCTIONS) as [ProductionKey, Row][];

function build(want: (f: Rule["fixity"]) => boolean): Map<TokenName, Rule> {
  const out = new Map<TokenName, Rule>();
  for (const [name, row] of rows) {
    if (row.fixity === undefined || !want(row.fixity)) continue;
    const type = lexemeToType(row.tokens[0]);
    if (type === null) continue;
    const prec = row.precedence ?? 0;
    const assoc = row.associativity ?? "left";
    const seen = out.get(type);
    if (seen === undefined) {
      out.set(type, {
        rules: [name],
        prec,
        assoc,
        fixity: row.fixity,
        noMixWith: (row.noMixWith ?? []) as readonly ProductionKey[],
        leftOperandNot: (row.leftOperandNot ?? []) as readonly ProductionKey[],
        neverAWriteTarget: row.neverAWriteTarget !== undefined,
      });
      continue;
    }
    // Sharing a trigger is fine; disagreeing about the level is not. One of the
    // two would bind differently from the other and no lookahead could fix it.
    if (seen.prec !== prec || seen.assoc !== assoc) {
      throw new Error(
        `productions.ts: '${row.tokens[0]}' heads '${seen.rules[0]}' at ${seen.prec}/${seen.assoc} and '${name}' at ${prec}/${assoc}`,
      );
    }
    out.set(type, {
      ...seen,
      rules: [...seen.rules, name],
      noMixWith: [...seen.noMixWith, ...((row.noMixWith ?? []) as readonly ProductionKey[])],
      leftOperandNot: [...seen.leftOperandNot, ...((row.leftOperandNot ?? []) as readonly ProductionKey[])],
      neverAWriteTarget: seen.neverAWriteTarget || row.neverAWriteTarget !== undefined,
    });
  }
  return out;
}

/** Rules that START an expression: `!x`, `-x`, `~x`, `typeof x`, `++x`. */
export const PREFIX: ReadonlyMap<TokenName, Rule> = build((f) => f === "prefix" || f === "prefixOrPostfix");

/** Rules that CONTINUE one: every infix operator, the ternary, and `x++`. */
export const INFIX: ReadonlyMap<TokenName, Rule> = build(
  (f) => f === "infix" || f === "postfix" || f === "ternary" || f === "prefixOrPostfix",
);

/**
 * The literal identifier a rule requires, from its `word` field. `function` is
 * not lexer-reserved, so the parser must match the text — and the text lives on
 * the row rather than in the parser.
 */
export const WORDS: ReadonlyMap<string, ProductionKey> = new Map(
  rows.filter(([, r]) => r.word !== undefined).map(([n, r]) => [r.word as string, n]),
);

/** The tightest level any row declares, for the unary operators to bind above. */
export const MAX_PRECEDENCE: number = rows.reduce((m, [, r]) => Math.max(m, r.precedence ?? 0), 0);

/**
 * Whether `inner` may stand as the given operand of `outer` without parentheses.
 *
 * JavaScript refuses `a ?? b || c` on either side and `-a ** 2` on the left only,
 * at ANY precedence — a number cannot say so, which is why nine such forms were
 * accepted before the rows stated it. The side matters: `2 ** -1` is valid.
 */
export function mixingRefused(outer: Rule, inner: string | null, side: "left" | "right"): boolean {
  if (inner === null) return false;
  if (outer.noMixWith.includes(inner as ProductionKey)) return true;
  return side === "left" && outer.leftOperandNot.includes(inner as ProductionKey);
}

/**
 * The token types that OPEN a write and nothing else: `delete`, `++`, `--`.
 *
 * Derived from the rows whose only position is `statement` and whose trigger is
 * a prefix — the writes a `;`-statement, an array element and a parenthesised
 * group all have to recognise, and used to recognise with four hand-written
 * copies of the same three names.
 */
export const STATEMENT_PREFIX: ReadonlySet<TokenName> = new Set(
  rows
    .filter(([, r]) => {
      const statementOnly = r.where !== undefined && r.where.length === 1 && r.where[0] === "statement";
      const prefixed = r.fixity === "prefix" || r.fixity === "prefixOrPostfix";
      return statementOnly && (prefixed || r.becomes === "DeleteStmt");
    })
    .map(([, r]) => lexemeToType(r.tokens[0]))
    .filter((t): t is TokenName => t !== null),
);

/** Is this lexeme an OPERATOR token — `=`, `++` — rather than a bracket or a name? */
function isOperatorLexeme(lexeme: string): boolean {
  const tok = (TOKENS as Record<string, { role?: string } | undefined>)[lexeme];
  return tok?.role === "operator";
}

/**
 * The token types that turn an expression into a write when they FOLLOW it:
 * `=`, `+=`, `++`, … — the OPERATOR tokens of every row that builds an
 * `AssignExpr`. Only the operators: those rows also consume `$.`, `(` and `=>`
 * on the way, and a `(` after an expression is a call, not a write.
 */
export const ASSIGN_TRIGGERS: ReadonlySet<TokenName> = new Set(
  rows
    .filter(([, r]) => r.becomes === "AssignExpr")
    .flatMap(([, r]) => r.tokens.filter(isOperatorLexeme).map(lexemeToType))
    .filter((t): t is TokenName => t !== null),
);

/**
 * Production → its spelling, for every rule whose node can never be the left of
 * `=` or the operand of `delete`. Read by the parser's write check, so the
 * `optionalMemberAccess` row's `neverAWriteTarget` is enforced by the row it is
 * written on rather than by a hand-coded `.optional` test.
 */
export const NEVER_A_WRITE_TARGET: ReadonlyMap<ProductionKey, { spelling: string; hint: string }> = new Map(
  rows
    .filter(([, r]) => r.neverAWriteTarget !== undefined)
    .map(([name, r]) => [
      name,
      {
        spelling: (r as { spelling?: string }).spelling ?? name,
        hint: (r.neverAWriteTarget as { instead: string }).instead,
      },
    ]),
);

/**
 * Production key → its `spelling`, for a message. A key like `negation` or
 * `logicalOr` is a descriptive name nobody types; a refusal names the operator
 * the way the developer wrote it (`'-'`, `'||'`).
 */
export const SPELLING: ReadonlyMap<ProductionKey, string> = new Map(
  rows.map(([name, r]) => [name, (r as { spelling?: string }).spelling ?? name]),
);
