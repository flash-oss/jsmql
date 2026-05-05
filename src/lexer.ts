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

  // Arithmetic operators
  Plus = "Plus", // +
  Minus = "Minus", // -
  Star = "Star", // *
  StarStar = "StarStar", // **
  Slash = "Slash", // /
  Percent = "Percent", // %

  // Comparison operators
  EqEq = "EqEq", // ==
  EqEqEq = "EqEqEq", // ===
  BangEq = "BangEq", // !=
  BangEqEq = "BangEqEq", // !==
  Gt = "Gt", // >
  GtEq = "GtEq", // >=
  Lt = "Lt", // <
  LtEq = "LtEq", // <=

  // Logical operators
  AmpAmp = "AmpAmp", // &&
  PipePipe = "PipePipe", // ||
  Bang = "Bang", // !

  // Misc operators
  QuestQuest = "QuestQuest", // ??
  Quest = "Quest", // ?
  Arrow = "Arrow", // =>

  // Literals
  Number = "Number",
  String = "String",
  True = "True",
  False = "False",
  Null = "Null",
  RegexLiteral = "RegexLiteral", // /pattern/flags

  // Keywords
  In = "In", // in
  New = "New", // new
  Typeof = "Typeof", // typeof

  // Identifier
  Ident = "Ident",

  EOF = "EOF",
}

export type Token = {
  type: TokenType;
  value: string;
  pos: number;
  flags?: string; // only set for RegexLiteral tokens
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

// Token types that end a "value" — after these, `/` is a divide operator.
// After anything else, `/` starts a regex literal.
const VALUE_ENDING_TYPES = new Set<TokenType>([
  TokenType.Number,
  TokenType.String,
  TokenType.True,
  TokenType.False,
  TokenType.Null,
  TokenType.Ident,
  TokenType.RParen,
  TokenType.RBracket,
]);

export class Lexer {
  private pos = 0;
  private readonly tokens: Token[] = [];
  private tokenIdx = 0;
  private lastTokenType: TokenType | null = null;

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

  lookahead(offset: number): Token {
    return (
      this.tokens[this.tokenIdx + offset] ?? {
        type: TokenType.EOF,
        value: "",
        pos: this.src.length,
      }
    );
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

  private pushToken(tok: Token): void {
    this.tokens.push(tok);
    this.lastTokenType = tok.type;
  }

  private tokenize(): void {
    const src = this.src;
    const len = src.length;

    while (this.pos < len) {
      this.skipWhitespace();
      if (this.pos >= len) break;

      const start = this.pos;
      const ch = src[this.pos];
      const ch2 = src[this.pos + 1] ?? "";
      const ch3 = src[this.pos + 2] ?? "";

      // Single-char punctuation
      if (ch === "(") {
        this.emit(TokenType.LParen, "(", start, 1);
        continue;
      }
      if (ch === ")") {
        this.emit(TokenType.RParen, ")", start, 1);
        continue;
      }
      if (ch === "[") {
        this.emit(TokenType.LBracket, "[", start, 1);
        continue;
      }
      if (ch === "]") {
        this.emit(TokenType.RBracket, "]", start, 1);
        continue;
      }
      if (ch === "{") {
        this.emit(TokenType.LBrace, "{", start, 1);
        continue;
      }
      if (ch === "}") {
        this.emit(TokenType.RBrace, "}", start, 1);
        continue;
      }
      if (ch === ",") {
        this.emit(TokenType.Comma, ",", start, 1);
        continue;
      }
      if (ch === ":") {
        this.emit(TokenType.Colon, ":", start, 1);
        continue;
      }

      // Spread ... (must come before single dot)
      if (ch === "." && ch2 === "." && ch3 === ".") {
        this.emit(TokenType.Spread, "...", start, 3);
        continue;
      }
      if (ch === ".") {
        this.emit(TokenType.Dot, ".", start, 1);
        continue;
      }

      // $ — either $. (field ref prefix) or $ (operator prefix)
      if (ch === "$") {
        if (ch2 === ".") {
          this.emit(TokenType.DollarDot, "$.", start, 2);
        } else {
          this.emit(TokenType.Dollar, "$", start, 1);
        }
        continue;
      }

      // ** before *
      if (ch === "*" && ch2 === "*") {
        this.emit(TokenType.StarStar, "**", start, 2);
        continue;
      }
      if (ch === "*") {
        this.emit(TokenType.Star, "*", start, 1);
        continue;
      }

      // === before == before => (bare = is an error)
      if (ch === "=") {
        if (ch2 === "=" && ch3 === "=") {
          this.emit(TokenType.EqEqEq, "===", start, 3);
          continue;
        }
        if (ch2 === "=") {
          this.emit(TokenType.EqEq, "==", start, 2);
          continue;
        }
        if (ch2 === ">") {
          this.emit(TokenType.Arrow, "=>", start, 2);
          continue;
        }
        throw new LexError(
          `Unexpected character '=' at position ${start} (did you mean '==' ?)`,
          start,
        );
      }

      // !== before != before !
      if (ch === "!") {
        if (ch2 === "=" && ch3 === "=") {
          this.emit(TokenType.BangEqEq, "!==", start, 3);
          continue;
        }
        if (ch2 === "=") {
          this.emit(TokenType.BangEq, "!=", start, 2);
          continue;
        }
        this.emit(TokenType.Bang, "!", start, 1);
        continue;
      }

      // >= before >
      if (ch === ">") {
        if (ch2 === "=") {
          this.emit(TokenType.GtEq, ">=", start, 2);
          continue;
        }
        this.emit(TokenType.Gt, ">", start, 1);
        continue;
      }

      // <= before <
      if (ch === "<") {
        if (ch2 === "=") {
          this.emit(TokenType.LtEq, "<=", start, 2);
          continue;
        }
        this.emit(TokenType.Lt, "<", start, 1);
        continue;
      }

      // && (bare & is an error)
      if (ch === "&") {
        if (ch2 === "&") {
          this.emit(TokenType.AmpAmp, "&&", start, 2);
          continue;
        }
        throw new LexError(
          `Unexpected character '&' at position ${start} (did you mean '&&' ?)`,
          start,
        );
      }

      // || (bare | is an error)
      if (ch === "|") {
        if (ch2 === "|") {
          this.emit(TokenType.PipePipe, "||", start, 2);
          continue;
        }
        throw new LexError(
          `Unexpected character '|' at position ${start} (did you mean '||' ?)`,
          start,
        );
      }

      // ?? before ?
      if (ch === "?") {
        if (ch2 === "?") {
          this.emit(TokenType.QuestQuest, "??", start, 2);
          continue;
        }
        this.emit(TokenType.Quest, "?", start, 1);
        continue;
      }

      if (ch === "+") {
        this.emit(TokenType.Plus, "+", start, 1);
        continue;
      }
      if (ch === "-") {
        this.emit(TokenType.Minus, "-", start, 1);
        continue;
      }
      if (ch === "%") {
        this.emit(TokenType.Percent, "%", start, 1);
        continue;
      }

      // / — context-sensitive: divide or regex literal
      if (ch === "/") {
        if (this.lastTokenType !== null && VALUE_ENDING_TYPES.has(this.lastTokenType)) {
          this.emit(TokenType.Slash, "/", start, 1);
        } else {
          this.pushToken(this.readRegex(start));
        }
        continue;
      }

      // Numbers
      if (this.isDigit(ch)) {
        this.pushToken(this.readNumber(start));
        continue;
      }

      // Strings
      if (ch === '"' || ch === "'") {
        this.pushToken(this.readString(start));
        continue;
      }

      // Identifiers / keywords
      if (this.isIdentStart(ch)) {
        const ident = this.readIdent();
        const tok = this.keywordToken(ident, start);
        this.pushToken(tok);
        continue;
      }

      throw new LexError(`Unexpected character '${ch}' at position ${start}`, start);
    }

    this.tokens.push({ type: TokenType.EOF, value: "", pos: len });
  }

  private emit(type: TokenType, value: string, pos: number, len: number): void {
    this.pushToken({ type, value, pos });
    this.pos += len;
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
    while (i < src.length && this.isDigit(src[i])) i++;
    // Only consume the dot if the next char is also a digit — prevents 0.name being lexed as float
    if (i < src.length && src[i] === "." && i + 1 < src.length && this.isDigit(src[i + 1])) {
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
    this.pos++;
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
    this.pos++;
    return { type: TokenType.String, value: result, pos: start };
  }

  private readRegex(start: number): Token {
    const src = this.src;
    this.pos++; // consume opening /
    let pattern = "";
    let inClass = false; // inside [...] character class

    while (this.pos < src.length) {
      const ch = src[this.pos];
      if (ch === "\\") {
        // Escape sequence — consume both chars
        this.pos++;
        if (this.pos < src.length) {
          pattern += "\\" + src[this.pos];
          this.pos++;
        }
        continue;
      }
      if (ch === "[") {
        inClass = true;
        pattern += ch;
        this.pos++;
        continue;
      }
      if (ch === "]") {
        inClass = false;
        pattern += ch;
        this.pos++;
        continue;
      }
      if (ch === "/" && !inClass) {
        this.pos++; // consume closing /
        break;
      }
      if (ch === "\n") {
        throw new LexError(`Unterminated regex literal at position ${start}`, start);
      }
      pattern += ch;
      this.pos++;
    }

    // Read optional flags
    let flags = "";
    while (this.pos < src.length && /[gimsuy]/.test(src[this.pos])) {
      flags += src[this.pos];
      this.pos++;
    }

    return { type: TokenType.RegexLiteral, value: pattern, flags, pos: start };
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
      case "in":
        return { type: TokenType.In, value: "in", pos };
      case "new":
        return { type: TokenType.New, value: "new", pos };
      case "typeof":
        return { type: TokenType.Typeof, value: "typeof", pos };
      default:
        return { type: TokenType.Ident, value: ident, pos };
    }
  }
}
