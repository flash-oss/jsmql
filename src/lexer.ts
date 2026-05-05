export const enum TokenType {
  // Punctuation
  LParen = "LParen", // (
  RParen = "RParen", // )
  LBracket = "LBracket", // [
  RBracket = "RBracket", // ]
  LBrace = "LBrace", // {
  RBrace = "RBrace", // }
  Comma = "Comma", // ,
  Colon = "Colon", // :
  Dot = "Dot", // .
  DollarDot = "DollarDot", // $.
  Dollar = "Dollar", // $ (standalone, before IDENT for operator)
  Spread = "Spread", // ...

  // Literals
  Number = "Number",
  String = "String",
  True = "True",
  False = "False",
  Null = "Null",

  // Identifier
  Ident = "Ident",

  EOF = "EOF",
}

export type Token = {
  type: TokenType;
  value: string;
  pos: number;
};

export class LexError extends Error {
  constructor(
    message: string,
    public readonly pos: number,
  ) {
    super(message);
    this.name = "LexError";
  }
}

export class Lexer {
  private pos = 0;
  private readonly tokens: Token[] = [];
  private tokenIdx = 0;

  constructor(private readonly src: string) {
    this.tokenize();
  }

  peek(): Token {
    return this.tokens[this.tokenIdx] ?? { type: TokenType.EOF, value: "", pos: this.src.length };
  }

  next(): Token {
    const t = this.peek();
    this.tokenIdx++;
    return t;
  }

  expect(type: TokenType): Token {
    const t = this.next();
    if (t.type !== type) {
      throw new LexError(
        `Expected ${type} but got ${t.type} ('${t.value}') at position ${t.pos}`,
        t.pos,
      );
    }
    return t;
  }

  private tokenize(): void {
    const src = this.src;
    const len = src.length;

    while (this.pos < len) {
      this.skipWhitespace();
      if (this.pos >= len) break;

      const start = this.pos;
      const ch = src[this.pos];

      // Single-char punctuation
      if (ch === "(") {
        this.tokens.push({ type: TokenType.LParen, value: "(", pos: start });
        this.pos++;
        continue;
      }
      if (ch === ")") {
        this.tokens.push({ type: TokenType.RParen, value: ")", pos: start });
        this.pos++;
        continue;
      }
      if (ch === "[") {
        this.tokens.push({ type: TokenType.LBracket, value: "[", pos: start });
        this.pos++;
        continue;
      }
      if (ch === "]") {
        this.tokens.push({ type: TokenType.RBracket, value: "]", pos: start });
        this.pos++;
        continue;
      }
      if (ch === "{") {
        this.tokens.push({ type: TokenType.LBrace, value: "{", pos: start });
        this.pos++;
        continue;
      }
      if (ch === "}") {
        this.tokens.push({ type: TokenType.RBrace, value: "}", pos: start });
        this.pos++;
        continue;
      }
      if (ch === ",") {
        this.tokens.push({ type: TokenType.Comma, value: ",", pos: start });
        this.pos++;
        continue;
      }
      if (ch === ":") {
        this.tokens.push({ type: TokenType.Colon, value: ":", pos: start });
        this.pos++;
        continue;
      }

      // Spread ...
      if (ch === "." && src[this.pos + 1] === "." && src[this.pos + 2] === ".") {
        this.tokens.push({ type: TokenType.Spread, value: "...", pos: start });
        this.pos += 3;
        continue;
      }

      // Plain dot
      if (ch === ".") {
        this.tokens.push({ type: TokenType.Dot, value: ".", pos: start });
        this.pos++;
        continue;
      }

      // $ — either $. (field ref prefix) or $ (operator prefix)
      if (ch === "$") {
        if (src[this.pos + 1] === ".") {
          this.tokens.push({ type: TokenType.DollarDot, value: "$.", pos: start });
          this.pos += 2;
        } else {
          this.tokens.push({ type: TokenType.Dollar, value: "$", pos: start });
          this.pos++;
        }
        continue;
      }

      // Numbers (including negative handled by parser as unary)
      if (this.isDigit(ch) || (ch === "-" && this.isDigit(src[this.pos + 1] ?? ""))) {
        this.tokens.push(this.readNumber(start));
        continue;
      }

      // Strings
      if (ch === '"' || ch === "'") {
        this.tokens.push(this.readString(start));
        continue;
      }

      // Identifiers / keywords
      if (this.isIdentStart(ch)) {
        const ident = this.readIdent();
        const tok = this.keywordToken(ident, start);
        this.tokens.push(tok);
        continue;
      }

      throw new LexError(`Unexpected character '${ch}' at position ${start}`, start);
    }

    this.tokens.push({ type: TokenType.EOF, value: "", pos: len });
  }

  private skipWhitespace(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) {
      this.pos++;
    }
  }

  private isDigit(ch: string): boolean {
    return ch >= "0" && ch <= "9";
  }

  private isIdentStart(ch: string): boolean {
    return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
  }

  private isIdentPart(ch: string): boolean {
    return this.isIdentStart(ch) || this.isDigit(ch);
  }

  private readNumber(start: number): Token {
    const src = this.src;
    let i = this.pos;
    if (src[i] === "-") i++;
    while (i < src.length && this.isDigit(src[i])) i++;
    if (i < src.length && src[i] === ".") {
      i++;
      while (i < src.length && this.isDigit(src[i])) i++;
    }
    if (i < src.length && (src[i] === "e" || src[i] === "E")) {
      i++;
      if (i < src.length && (src[i] === "+" || src[i] === "-")) i++;
      while (i < src.length && this.isDigit(src[i])) i++;
    }
    const value = src.slice(this.pos, i);
    this.pos = i;
    return { type: TokenType.Number, value, pos: start };
  }

  private readString(start: number): Token {
    const src = this.src;
    const quote = src[this.pos];
    this.pos++; // skip opening quote
    let result = "";
    while (this.pos < src.length && src[this.pos] !== quote) {
      if (src[this.pos] === "\\") {
        this.pos++;
        const esc = src[this.pos];
        switch (esc) {
          case "n":
            result += "\n";
            break;
          case "t":
            result += "\t";
            break;
          case "r":
            result += "\r";
            break;
          case "\\":
            result += "\\";
            break;
          case '"':
            result += '"';
            break;
          case "'":
            result += "'";
            break;
          default:
            result += esc;
        }
      } else {
        result += src[this.pos];
      }
      this.pos++;
    }
    if (this.pos >= src.length) {
      throw new LexError(`Unterminated string at position ${start}`, start);
    }
    this.pos++; // skip closing quote
    return { type: TokenType.String, value: result, pos: start };
  }

  private readIdent(): string {
    const src = this.src;
    let i = this.pos;
    while (i < src.length && this.isIdentPart(src[i])) i++;
    const ident = src.slice(this.pos, i);
    this.pos = i;
    return ident;
  }

  private keywordToken(ident: string, pos: number): Token {
    switch (ident) {
      case "true":
        return { type: TokenType.True, value: "true", pos };
      case "false":
        return { type: TokenType.False, value: "false", pos };
      case "null":
        return { type: TokenType.Null, value: "null", pos };
      default:
        return { type: TokenType.Ident, value: ident, pos };
    }
  }
}
