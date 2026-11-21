import { KEYWORDS } from "../../registry/keywords.ts";
import { TOKENS } from "../../registry/tokens.ts";
import type { TokenName } from "../../registry/vocabulary.ts";
import type { Token } from "../lex/token.ts";

export class ParseError extends Error {
  pos: number;
  constructor(message: string, pos: number) {
    super(
      /\bat position \d+/.test(message)
        ? message
        : message.endsWith(".")
          ? `${message.slice(0, -1)} at position ${pos}.`
          : `${message} at position ${pos}`,
    );
    this.name = "ParseError";
    this.pos = pos;
  }
}

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

  get type(): TokenName {
    return this.peek().type;
  }

  is(type: TokenName): boolean {
    return this.peek().type === type;
  }

  next(): Token {
    const t = this.peek();
    if (t.type !== "EOF") this.at++;
    return t;
  }

  eat(type: TokenName): boolean {
    if (this.type !== type) return false;
    this.at++;
    return true;
  }

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

  lastEnd(): number {
    return this.at === 0 ? 0 : this.toks[this.at - 1].end;
  }

  mark(): number {
    return this.at;
  }
  reset(to: number): void {
    this.at = to;
  }
}
