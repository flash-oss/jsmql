// The parser's dispatch tables. These come from src/registry/productions.ts.
//
// A level is a NUMBER on a row, not the depth of a call chain. So a row states an
// operator's precedence where the operator is, and a new operator is a new row.
//
// A rule's TRIGGER is `tokens[0]`. See the `tokens` doc in productions.ts.

import { PRODUCTIONS, type ProductionKey } from "../../registry/productions.ts";
import { TOKENS } from "../../registry/tokens.ts";
import { KEYWORDS } from "../../registry/keywords.ts";
import type { TokenName } from "../../registry/vocabulary.ts";

/**
 * What a trigger means at parse time. This holds one entry per TRIGGER, not per
 * rule. A lexeme can head several rules, and the parser tells them apart by
 * lookahead. `.` heads `memberAccess`, `methodCall` and `namespacedCall`, and only
 * a following `(` says which one applies. All of these rules must agree on the
 * level, and the code checks this when it builds the table.
 */
export type Rule = {
  /** Every rule this trigger can head, in declaration order. */
  rules: readonly ProductionKey[];
  prec: number;
  assoc: "left" | "right" | "none";
  fixity: "prefix" | "infix" | "postfix" | "ternary" | "prefixOrPostfix";
  /** Levels this must not sit beside without parentheses, on EITHER side. See the row field. */
  noMixWith: readonly ProductionKey[];
  /** Levels the LEFT operand must not be, without parentheses. See the row field. */
  leftOperandNot: readonly ProductionKey[];
  /** The node this rule builds cannot be the left of `=` or the operand of `delete`. */
  neverAWriteTarget: boolean;
};

/** Spelling or class name to the token type that the lexer emits for it. */
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
    // Two rules can share a trigger. They must not disagree about the level: one
    // of the two would then bind differently from the other, and no lookahead
    // could fix it.
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

/** Rules that CONTINUE an expression: every infix operator, the ternary, and `x++`. */
export const INFIX: ReadonlyMap<TokenName, Rule> = build(
  (f) => f === "infix" || f === "postfix" || f === "ternary" || f === "prefixOrPostfix",
);

/**
 * The literal identifier that a rule requires, from its `word` field. The lexer
 * does not reserve `function`, so the parser must match the text. The text lives
 * on the row, not in the parser.
 */
export const WORDS: ReadonlyMap<string, ProductionKey> = new Map(
  rows.filter(([, r]) => r.word !== undefined).map(([n, r]) => [r.word as string, n]),
);

/** The tightest level that any row declares. The unary operators bind above this level. */
export const MAX_PRECEDENCE: number = rows.reduce((m, [, r]) => Math.max(m, r.precedence ?? 0), 0);

/**
 * Whether `inner` can stand as the given operand of `outer` without parentheses.
 *
 * JavaScript refuses `a ?? b || c` on either side, and refuses `-a ** 2` on the
 * left side only, at ANY precedence. A number cannot state this rule; the rows
 * state it instead. The side matters: `2 ** -1` is valid.
 */
export function mixingRefused(outer: Rule, inner: string | null, side: "left" | "right"): boolean {
  if (inner === null) return false;
  if (outer.noMixWith.includes(inner as ProductionKey)) return true;
  return side === "left" && outer.leftOperandNot.includes(inner as ProductionKey);
}

/**
 * The token types that OPEN a write and nothing else: `delete`, `++`, `--`.
 *
 * This comes from the rows whose only position is `statement` and whose trigger
 * is a prefix. A `;`-statement, an array element and a parenthesised group must
 * all recognise these tokens, from ONE list, so the three cannot drift apart.
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

/** Is this lexeme an OPERATOR token, such as `=` or `++`, rather than a bracket or a name? */
function isOperatorLexeme(lexeme: string): boolean {
  const tok = (TOKENS as Record<string, { role?: string } | undefined>)[lexeme];
  return tok?.role === "operator";
}

/**
 * The token types that turn an expression into a write when they FOLLOW it:
 * `=`, `+=`, `++`, and so on. These are the OPERATOR tokens of every row that
 * builds an `AssignExpr`. Only the operators count: those rows also consume `$.`,
 * `(` and `=>` on the way, and a `(` after an expression is a call, not a write.
 */
export const ASSIGN_TRIGGERS: ReadonlySet<TokenName> = new Set(
  rows
    .filter(([, r]) => r.becomes === "AssignExpr")
    .flatMap(([, r]) => r.tokens.filter(isOperatorLexeme).map(lexemeToType))
    .filter((t): t is TokenName => t !== null),
);

/**
 * Production to its spelling, for every rule whose node can never be the left of
 * `=` or the operand of `delete`. The parser's write check reads this map. So the
 * `optionalMemberAccess` row enforces its own `neverAWriteTarget` field, rather
 * than a hand-coded `.optional` test enforcing it.
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
 * Production key to its `spelling`, for a message. A key like `negation` or
 * `logicalOr` is a descriptive name that nobody types. A refusal names the
 * operator the way the developer wrote it (`'-'`, `'||'`).
 */
export const SPELLING: ReadonlyMap<ProductionKey, string> = new Map(
  rows.map(([name, r]) => [name, (r as { spelling?: string }).spelling ?? name]),
);
