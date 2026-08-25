// A cursor over the token list, and the one place a parse error is worded.
//
// The friendly name of a token comes from its registry key: tokens.ts is keyed by
// SPELLING, so `'('` reads as `'('` and a class-named row reads as `number`. No
// TokenName ever reaches a message — "Expected LParen" is not something a user
// should have to translate.

import { KEYWORDS } from "../../registry/keywords.ts";
import { TOKENS } from "../../registry/tokens.ts";
import type { TokenName } from "../../registry/vocabulary.ts";
import type { Token } from "../lex/token.ts";

export class ParseError extends Error {
  pos: number;
  constructor(message: string, pos: number) {
    super(`${message} at position ${pos}`);
    this.name = "ParseError";
    this.pos = pos;
  }
}

/** token type → how a message should spell it, derived from the registry keys. */
const DISPLAY: ReadonlyMap<TokenName, string> = (() => {
  const out = new Map<TokenName, string>();
  for (const [key, row] of Object.entries(TOKENS)) {
    const names = Array.isArray(row.token) ? row.token : [row.token];
    for (const t of names) if (!out.has(t)) out.set(t, row.variable === true ? key : `'${key}'`);
  }
  for (const [word, row] of Object.entries(KEYWORDS)) if (!out.has(row.token)) out.set(row.token, `'${word}'`);
  out.set("EOF", "end of input");
  return out;
})();

export const spell = (t: TokenName): string => DISPLAY.get(t) ?? `'${t}'`;

/** How a message should refer to the token actually found. */
export function found(t: Token): string {
  if (t.type === "EOF") return "end of input";
  return t.text.length > 0 ? `'${t.text}'` : spell(t.type);
}

export class Cursor {
  private readonly toks: readonly Token[];
  private at = 0;

  constructor(toks: readonly Token[]) {
    this.toks = toks;
  }

  peek(ahead = 0): Token {
    return this.toks[Math.min(this.at + ahead, this.toks.length - 1)];
  }

  /** For a table lookup. Do not compare it — see `is`. */
  get type(): TokenName {
    return this.peek().type;
  }

  /**
   * Is the next token this type?
   *
   * A method rather than a comparison against `type`, because TypeScript narrows
   * a getter and keeps the narrowing across a `next()` — after one
   * `this.c.type !== "LBrace"` every later comparison became "no overlap".
   */
  is(type: TokenName): boolean {
    return this.peek().type === type;
  }

  next(): Token {
    const t = this.peek();
    if (t.type !== "EOF") this.at++;
    return t;
  }

  /** True and consumed, or false and untouched. */
  eat(type: TokenName): boolean {
    if (this.type !== type) return false;
    this.at++;
    return true;
  }

  /**
   * Is the next token a reserved word that may still be used as a NAME?
   * keywords.ts measures this per word: `$.typeof` and `$in(…)` work, `$.delete`
   * does not.
   */
  isNameLike(): boolean {
    const row = (KEYWORDS as Record<string, { token: TokenName; usableAsFieldName: boolean } | undefined>)[
      this.peek().text
    ];
    return row !== undefined && row.usableAsFieldName && row.token === this.peek().type;
  }

  expect(type: TokenName): Token {
    if (this.type !== type) {
      throw new ParseError(`Expected ${spell(type)} but got ${found(this.peek())}`, this.peek().pos);
    }
    return this.next();
  }

  /** Rewind, for the one place that needs it: telling an arrow from a group. */
  mark(): number {
    return this.at;
  }
  reset(to: number): void {
    this.at = to;
  }
}
