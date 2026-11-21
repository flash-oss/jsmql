import { PRODUCTIONS, type ProductionKey } from "../../registry/productions.ts";
import { TOKENS } from "../../registry/tokens.ts";
import { KEYWORDS } from "../../registry/keywords.ts";
import type { TokenName } from "../../registry/vocabulary.ts";

export type Rule = {
  rules: readonly ProductionKey[];
  prec: number;
  assoc: "left" | "right" | "none";
  fixity: "prefix" | "infix" | "postfix" | "ternary" | "prefixOrPostfix";
  noMixWith: readonly ProductionKey[];
  leftOperandNot: readonly ProductionKey[];
  neverAWriteTarget: boolean;
  asStatement: string | null;
};

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
  asStatement?: string;
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
        asStatement: row.asStatement ?? null,
      });
      continue;
    }
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
      asStatement: seen.asStatement ?? row.asStatement ?? null,
    });
  }
  return out;
}

export const PREFIX: ReadonlyMap<TokenName, Rule> = build((f) => f === "prefix" || f === "prefixOrPostfix");

export const INFIX: ReadonlyMap<TokenName, Rule> = build(
  (f) => f === "infix" || f === "postfix" || f === "ternary" || f === "prefixOrPostfix",
);

export function asStatementOf(spelling: string): string | null {
  const type = lexemeToType(spelling);
  return type === null ? null : (PREFIX.get(type)?.asStatement ?? null);
}

export const WORDS: ReadonlyMap<string, ProductionKey> = new Map(
  rows.filter(([, r]) => r.word !== undefined).map(([n, r]) => [r.word as string, n]),
);

export const MAX_PRECEDENCE: number = rows.reduce((m, [, r]) => Math.max(m, r.precedence ?? 0), 0);

export function mixingRefused(outer: Rule, inner: string | null, side: "left" | "right"): boolean {
  if (inner === null) return false;
  if (outer.noMixWith.includes(inner as ProductionKey)) return true;
  return side === "left" && outer.leftOperandNot.includes(inner as ProductionKey);
}

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

function isOperatorLexeme(lexeme: string): boolean {
  const tok = (TOKENS as Record<string, { role?: string } | undefined>)[lexeme];
  return tok?.role === "operator";
}

export const ASSIGN_TRIGGERS: ReadonlySet<TokenName> = new Set(
  rows
    .filter(([, r]) => r.becomes === "AssignExpr")
    .flatMap(([, r]) => r.tokens.filter(isOperatorLexeme).map(lexemeToType))
    .filter((t): t is TokenName => t !== null),
);

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

export const SPELLING: ReadonlyMap<ProductionKey, string> = new Map(
  rows.map(([name, r]) => [name, (r as { spelling?: string }).spelling ?? name]),
);
