// A cursor over the token list. This file is the only place that words a parse error.
//
// The friendly name of a token comes from its registry key. tokens.ts uses the SPELLING
// as the key, so `'('` reads as `'('` and a class-named row reads as `number`. No
// TokenName reaches a message. A user should never see "Expected LParen".

import { KEYWORDS } from "../../registry/keywords.ts";
import { TOKENS } from "../../registry/tokens.ts";
import type { TokenName } from "../../registry/vocabulary.ts";
import type { Token } from "../lex/token.ts";

export class ParseError extends Error {
  pos: number;
  constructor(message: string, pos: number) {
    // Every message states the position. The code does not add it twice when the
    // message already places the position in the middle of the sentence.
    super(/\bat position \d+/.test(message) ? message : `${message} at position ${pos}`);
    this.name = "ParseError";
    this.pos = pos;
  }
}

/** Token type to its spelling in a message. The registry keys give this spelling. */
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

/** How a message names the token that the parser found. */
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

  /** Use this only for a table lookup. Do not compare it. See `is`. */
  get type(): TokenName {
    return this.peek().type;
  }

  /**
   * Does the next token match this type?
   *
   * This is a method, not a comparison against `type`, because TypeScript narrows
   * a getter and keeps the narrowing across a `next()` call. After one
   * `this.c.type !== "LBrace"` check, every later comparison became "no overlap".
   */
  is(type: TokenName): boolean {
    return this.peek().type === type;
  }

  next(): Token {
    const t = this.peek();
    if (t.type !== "EOF") this.at++;
    return t;
  }

  /** Returns true and consumes the token, or returns false and leaves it. */
  eat(type: TokenName): boolean {
    if (this.type !== type) return false;
    this.at++;
    return true;
  }

  /**
   * Is the next token a reserved word in a place where a NAME can stand?
   *
   * Every keyword qualifies. JavaScript lets any IdentifierName follow `.` or
   * precede `:` in an object literal, so `{ null: 1 }` and `$let({ in: … })` are
   * names here. The lexer already turns the ones after an introducer into plain
   * `Ident` tokens. This method catches the rest, mostly an object key.
   */
  isNameLike(): boolean {
    const row = (KEYWORDS as Record<string, { token: TokenName } | undefined>)[this.peek().text];
    return row !== undefined && row.token === this.peek().type;
  }

  expect(type: TokenName): Token {
    if (this.type !== type) {
      throw new ParseError(`Expected ${spell(type)} but got ${found(this.peek())}`, this.peek().pos);
    }
    return this.next();
  }

  /** Rewinds the cursor. Only one place needs this: to tell an arrow from a group. */
  mark(): number {
    return this.at;
  }
  reset(to: number): void {
    this.at = to;
  }
}
