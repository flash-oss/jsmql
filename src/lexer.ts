// Type-strippable replacement for the original `const enum TokenType`. The
// `as const` object preserves the `TokenType.LParen` call-site idiom (no
// churn at the 196 use sites), and the derived union gives us the same
// type-checking guarantees. Trades the const-enum's compile-time inlining
// for a small runtime object — negligible for a lexer.
export const TokenType = {
  // Punctuation
  LParen: "LParen", // (
  RParen: "RParen", // )
  LBracket: "LBracket", // [
  RBracket: "RBracket", // ]
  LBrace: "LBrace", // {
  RBrace: "RBrace", // }
  Comma: "Comma", // ,
  Semi: "Semi", // ;
  Colon: "Colon", // :
  Dot: "Dot", // .
  QuestDot: "QuestDot", // ?.  (optional chaining)
  DollarDot: "DollarDot", // $.
  Dollar: "Dollar", // $ (standalone, before IDENT for operator)
  DoubleDollar: "DoubleDollar", // $$  (current-collection reference, postfix .name or [expr])
  TripleDollar: "TripleDollar", // $$$  (current-database reference)
  QuadDollar: "QuadDollar", // $$$$  (current-cluster reference)
  Spread: "Spread", // ...

  // Arithmetic operators
  Plus: "Plus", // +
  Minus: "Minus", // -
  Star: "Star", // *
  StarStar: "StarStar", // **
  Slash: "Slash", // /
  Percent: "Percent", // %

  // Increment / decrement (update op statements; not value expressions)
  PlusPlus: "PlusPlus", // ++
  MinusMinus: "MinusMinus", // --

  // Assignment operators
  Eq: "Eq", // =
  PlusEq: "PlusEq", // +=
  MinusEq: "MinusEq", // -=
  StarEq: "StarEq", // *=
  SlashEq: "SlashEq", // /=

  // Comparison operators
  EqEq: "EqEq", // ==
  EqEqEq: "EqEqEq", // ===
  BangEq: "BangEq", // !=
  BangEqEq: "BangEqEq", // !==
  Gt: "Gt", // >
  GtEq: "GtEq", // >=
  Lt: "Lt", // <
  LtEq: "LtEq", // <=

  // Logical operators
  AmpAmp: "AmpAmp", // &&
  PipePipe: "PipePipe", // ||
  Bang: "Bang", // !

  // Bitwise operators
  Amp: "Amp", // &
  Pipe: "Pipe", // |
  Caret: "Caret", // ^
  Tilde: "Tilde", // ~

  // Misc operators
  QuestQuest: "QuestQuest", // ??
  Quest: "Quest", // ?
  Arrow: "Arrow", // =>

  // Literals
  Number: "Number",
  BigInt: "BigInt", // 123n
  String: "String",
  True: "True",
  False: "False",
  Null: "Null",
  Undefined: "Undefined",
  RegexLiteral: "RegexLiteral", // /pattern/flags

  // Template literals
  TemplateStart: "TemplateStart", // opening `
  TemplateChars: "TemplateChars", // literal chunk between ` and ${ (or ` and `)
  TemplateExprStart: "TemplateExprStart", // ${
  TemplateEnd: "TemplateEnd", // closing `

  // Keywords
  In: "In", // in
  New: "New", // new
  Typeof: "Typeof", // typeof
  Delete: "Delete", // delete
  Let: "Let", // let
  Const: "Const", // const (alias for let — see docs/specs/let-bindings.md)
  Return: "Return", // return (only inside a block-body arrow — see docs/specs/method-dispatch.md)

  // Identifier
  Ident: "Ident",

  EOF: "EOF",
} as const;
export type TokenType = (typeof TokenType)[keyof typeof TokenType];

/**
 * Human-friendly display string for each token type, used in lexer/parser error
 * messages so users see `'('` instead of the internal `LParen` enum name. For
 * punctuation we quote the literal character(s); for value-bearing tokens
 * (identifiers, numbers, strings, …) we use a descriptive word so the message
 * still reads naturally when paired with `got 'foo'`. Keep in sync with the
 * `TokenType` declaration above.
 */
export const TOKEN_DISPLAY: Record<TokenType, string> = {
  LParen: "'('",
  RParen: "')'",
  LBracket: "'['",
  RBracket: "']'",
  LBrace: "'{'",
  RBrace: "'}'",
  Comma: "','",
  Semi: "';'",
  Colon: "':'",
  Dot: "'.'",
  QuestDot: "'?.'",
  DollarDot: "'$.'",
  Dollar: "'$'",
  DoubleDollar: "'$$'",
  TripleDollar: "'$$$'",
  QuadDollar: "'$$$$'",
  Spread: "'...'",
  Plus: "'+'",
  Minus: "'-'",
  Star: "'*'",
  StarStar: "'**'",
  Slash: "'/'",
  Percent: "'%'",
  PlusPlus: "'++'",
  MinusMinus: "'--'",
  Eq: "'='",
  PlusEq: "'+='",
  MinusEq: "'-='",
  StarEq: "'*='",
  SlashEq: "'/='",
  EqEq: "'=='",
  EqEqEq: "'==='",
  BangEq: "'!='",
  BangEqEq: "'!=='",
  Gt: "'>'",
  GtEq: "'>='",
  Lt: "'<'",
  LtEq: "'<='",
  AmpAmp: "'&&'",
  PipePipe: "'||'",
  Bang: "'!'",
  Amp: "'&'",
  Pipe: "'|'",
  Caret: "'^'",
  Tilde: "'~'",
  QuestQuest: "'??'",
  Quest: "'?'",
  Arrow: "'=>'",
  Number: "a number",
  BigInt: "a BigInt literal",
  String: "a string",
  True: "'true'",
  False: "'false'",
  Null: "'null'",
  Undefined: "'undefined'",
  RegexLiteral: "a regex literal",
  TemplateStart: "a template literal",
  TemplateChars: "template-literal text",
  TemplateExprStart: "'${'",
  TemplateEnd: "'`'",
  In: "'in'",
  New: "'new'",
  Typeof: "'typeof'",
  Delete: "'delete'",
  Let: "'let'",
  Const: "'const'",
  Return: "'return'",
  Ident: "an identifier",
  EOF: "end of input",
};

/**
 * Format a token for the "but got X" half of an error message. For value-bearing
 * tokens (identifiers, numbers, strings) the actual lexeme is more useful than
 * the category name, so we render it as e.g. `an identifier 'foo'` or
 * `a number '42'`. For punctuation the display already *is* the lexeme, so the
 * `('${value}')` suffix would be redundant.
 */
export function formatActualToken(t: Token): string {
  const display = TOKEN_DISPLAY[t.type];
  if (
    t.type === TokenType.Ident ||
    t.type === TokenType.Number ||
    t.type === TokenType.BigInt ||
    t.type === TokenType.String ||
    t.type === TokenType.RegexLiteral
  ) {
    return `${display} '${t.value}'`;
  }
  return display;
}

export type Token = {
  type: TokenType;
  value: string;
  pos: number;
  flags?: string; // only set for RegexLiteral tokens
};

export class LexError extends Error {
  readonly pos: number;
  constructor(message: string, pos: number) {
    super(message);
    this.name = "LexError";
    this.pos = pos;
  }
}

// Token types that end a "value" — after these, `/` is a divide operator.
// After anything else, `/` starts a regex literal.
const VALUE_ENDING_TYPES = new Set<TokenType>([
  TokenType.Number,
  TokenType.BigInt,
  TokenType.String,
  TokenType.True,
  TokenType.False,
  TokenType.Null,
  TokenType.Undefined,
  TokenType.Ident,
  TokenType.RParen,
  TokenType.RBracket,
  TokenType.TemplateEnd,
]);

export class Lexer {
  private pos = 0;
  private readonly tokens: Token[] = [];
  private tokenIdx = 0;
  private lastTokenType: TokenType | null = null;

  // Brace depth tracking for template literal expression interpolation.
  // Each entry on templateBraceDepths is the brace depth at which a `${` was opened —
  // when a `}` would bring us back to that depth, it closes the template expression
  // instead of being a normal RBrace.
  private braceDepth = 0;
  private templateBraceDepths: number[] = [];

  private readonly src: string;
  constructor(src: string) {
    this.src = src;
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
    return this.tokens[this.tokenIdx + offset] ?? { type: TokenType.EOF, value: "", pos: this.src.length };
  }

  expect(type: TokenType): Token {
    const t = this.next();
    if (t.type !== type) {
      throw new LexError(`Expected ${TOKEN_DISPLAY[type]} but got ${formatActualToken(t)} at position ${t.pos}`, t.pos);
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
      this.skipTrivia();
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
        this.braceDepth++;
        continue;
      }
      if (ch === "}") {
        // If this } closes a template expression, switch back to template-chunk reading
        if (
          this.templateBraceDepths.length > 0 &&
          this.templateBraceDepths[this.templateBraceDepths.length - 1] === this.braceDepth
        ) {
          this.templateBraceDepths.pop();
          this.pos++; // consume }
          this.readTemplateChunk(start);
          continue;
        }
        this.emit(TokenType.RBrace, "}", start, 1);
        this.braceDepth--;
        continue;
      }
      if (ch === ",") {
        this.emit(TokenType.Comma, ",", start, 1);
        continue;
      }
      if (ch === ";") {
        this.emit(TokenType.Semi, ";", start, 1);
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

      // $ family — longest-match over consecutive '$' chars:
      //   $    → Dollar         (operator prefix, e.g. $add)
      //   $.   → DollarDot       (current-document field ref, $.x)
      //   $$   → DoubleDollar    (current-collection ref, $$.x / $$[x])
      //   $$$  → TripleDollar    (current-database ref, $$$.x / $$$[x])
      //   $$$$ → QuadDollar      (current-cluster ref, $$$$.x / $$$$[x])
      //   $$$$$+ → LexError (no levels deeper than cluster are defined)
      if (ch === "$") {
        let dollarCount = 1;
        while (src[start + dollarCount] === "$") dollarCount++;
        if (dollarCount === 1) {
          if (ch2 === ".") {
            this.emit(TokenType.DollarDot, "$.", start, 2);
          } else {
            this.emit(TokenType.Dollar, "$", start, 1);
          }
          continue;
        }
        if (dollarCount === 2) {
          this.emit(TokenType.DoubleDollar, "$$", start, 2);
          continue;
        }
        if (dollarCount === 3) {
          this.emit(TokenType.TripleDollar, "$$$", start, 3);
          continue;
        }
        if (dollarCount === 4) {
          this.emit(TokenType.QuadDollar, "$$$$", start, 4);
          continue;
        }
        throw new LexError(
          `Up to 4 levels of context reference are supported ('$.', '$$', '$$$', '$$$$') at position ${start}`,
          start,
        );
      }

      // ** before *= before *
      if (ch === "*" && ch2 === "*") {
        this.emit(TokenType.StarStar, "**", start, 2);
        continue;
      }
      if (ch === "*" && ch2 === "=") {
        this.emit(TokenType.StarEq, "*=", start, 2);
        continue;
      }
      if (ch === "*") {
        this.emit(TokenType.Star, "*", start, 1);
        continue;
      }

      // === before == before => before bare = (assignment)
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
        this.emit(TokenType.Eq, "=", start, 1);
        continue;
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

      // && before & (bitwise AND)
      if (ch === "&") {
        if (ch2 === "&") {
          this.emit(TokenType.AmpAmp, "&&", start, 2);
          continue;
        }
        this.emit(TokenType.Amp, "&", start, 1);
        continue;
      }

      // || before | (bitwise OR)
      if (ch === "|") {
        if (ch2 === "|") {
          this.emit(TokenType.PipePipe, "||", start, 2);
          continue;
        }
        this.emit(TokenType.Pipe, "|", start, 1);
        continue;
      }

      if (ch === "^") {
        this.emit(TokenType.Caret, "^", start, 1);
        continue;
      }
      if (ch === "~") {
        this.emit(TokenType.Tilde, "~", start, 1);
        continue;
      }

      // ?? before ?. before ?
      if (ch === "?") {
        if (ch2 === "?") {
          this.emit(TokenType.QuestQuest, "??", start, 2);
          continue;
        }
        // ?. — optional chaining. Per JS, ?. followed by a digit is two tokens (?, then .digit),
        // but our lexer rejects bare leading-dot decimals anyway. Only emit ?. when a non-digit follows.
        if (ch2 === "." && !this.isDigit(ch3)) {
          this.emit(TokenType.QuestDot, "?.", start, 2);
          continue;
        }
        this.emit(TokenType.Quest, "?", start, 1);
        continue;
      }

      // ++ before += before +
      if (ch === "+") {
        if (ch2 === "+") {
          this.emit(TokenType.PlusPlus, "++", start, 2);
        } else if (ch2 === "=") {
          this.emit(TokenType.PlusEq, "+=", start, 2);
        } else {
          this.emit(TokenType.Plus, "+", start, 1);
        }
        continue;
      }
      // -- before -= before -
      if (ch === "-") {
        if (ch2 === "-") {
          this.emit(TokenType.MinusMinus, "--", start, 2);
        } else if (ch2 === "=") {
          this.emit(TokenType.MinusEq, "-=", start, 2);
        } else {
          this.emit(TokenType.Minus, "-", start, 1);
        }
        continue;
      }
      if (ch === "%") {
        this.emit(TokenType.Percent, "%", start, 1);
        continue;
      }

      // / — context-sensitive: divide (or /= compound) or regex literal
      if (ch === "/") {
        if (this.lastTokenType !== null && VALUE_ENDING_TYPES.has(this.lastTokenType)) {
          if (ch2 === "=") {
            this.emit(TokenType.SlashEq, "/=", start, 2);
          } else {
            this.emit(TokenType.Slash, "/", start, 1);
          }
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

      // Template literal
      if (ch === "`") {
        this.pushToken({ type: TokenType.TemplateStart, value: "`", pos: start });
        this.pos++; // consume opening `
        this.readTemplateChunk(start);
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

  // ECMAScript LineTerminator set: U+000A (LF), U+000D (CR),
  // U+2028 (LINE SEPARATOR), U+2029 (PARAGRAPH SEPARATOR).
  // Use \u escapes — LSEP/PSEP render invisibly in most editors.
  private static readonly LINE_TERMINATORS = /[\n\r\u2028\u2029]/;

  // Whitespace + JS-style comments. Both forms are pure trivia: discarded
  // here, never reach the token stream or AST. Loop until neither pass
  // makes progress, so any sequence of mixed whitespace and comments
  // collapses to a single trivia run (matches JS).
  private skipTrivia(): void {
    while (this.pos < this.src.length) {
      const before = this.pos;
      while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) {
        this.pos++;
      }
      if (this.pos < this.src.length && this.src[this.pos] === "/") {
        const next = this.src[this.pos + 1];
        if (next === "/") this.skipLineComment();
        else if (next === "*") this.skipBlockComment();
        else break;
      }
      if (this.pos === before) break;
    }
  }

  // // line comments: skip until any LineTerminator or EOF. The terminator
  // itself stays for the whitespace pass on the next skipTrivia iteration —
  // this keeps positional reporting honest and lets future line/column
  // tracking count newlines in one place.
  private skipLineComment(): void {
    this.pos += 2;
    while (this.pos < this.src.length && !Lexer.LINE_TERMINATORS.test(this.src[this.pos])) {
      this.pos++;
    }
  }

  // /* block comments */: scan for the closing */, EOF means unclosed.
  // No nesting (matches JS — the first */ closes).
  private skipBlockComment(): void {
    const start = this.pos;
    this.pos += 2;
    while (this.pos + 1 < this.src.length) {
      if (this.src[this.pos] === "*" && this.src[this.pos + 1] === "/") {
        this.pos += 2;
        return;
      }
      this.pos++;
    }
    throw new LexError(`Unclosed block comment starting at position ${start}`, start);
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
    i = this.consumeDigitsWithSeparators(i, start);
    let hasFraction = false;
    let hasExponent = false;
    // Only consume the dot if the next char is also a digit — prevents 0.name being lexed as float
    if (i < src.length && src[i] === "." && i + 1 < src.length && this.isDigit(src[i + 1])) {
      hasFraction = true;
      i++;
      i = this.consumeDigitsWithSeparators(i, start);
    }
    if (i < src.length && (src[i] === "e" || src[i] === "E")) {
      hasExponent = true;
      i++;
      if (i < src.length && (src[i] === "+" || src[i] === "-")) i++;
      i = this.consumeDigitsWithSeparators(i, start);
    }
    // BigInt suffix: integer literals only. Reject `1.5n`, `1e2n`, etc. — matches JS.
    if (i < src.length && src[i] === "n") {
      if (hasFraction || hasExponent) {
        throw new LexError(
          `Invalid BigInt literal at position ${start}: 'n' suffix requires an integer (no fraction or exponent)`,
          start,
        );
      }
      const raw = src.slice(this.pos, i);
      const value = raw.replace(/_/g, "");
      this.pos = i + 1; // consume the 'n'
      return { type: TokenType.BigInt, value, pos: start };
    }
    const raw = src.slice(this.pos, i);
    // Numeric separators: strip underscores. _ is only valid between digits — readNumber
    // never starts on _ (isIdentStart-routed), and consumeDigitsWithSeparators rejects
    // trailing/adjacent underscores, so a simple replace is safe here.
    const value = raw.replace(/_/g, "");
    this.pos = i;
    return { type: TokenType.Number, value, pos: start };
  }

  /**
   * Consume a run of digits, allowing single underscores between them as numeric
   * separators (1_000_000). Rejects leading, trailing, or doubled underscores.
   */
  private consumeDigitsWithSeparators(i: number, start: number): number {
    const src = this.src;
    if (i >= src.length || !this.isDigit(src[i])) return i;
    i++;
    while (i < src.length) {
      const ch = src[i];
      if (this.isDigit(ch)) {
        i++;
        continue;
      }
      if (ch === "_") {
        const next = src[i + 1];
        if (next === undefined || !this.isDigit(next)) {
          throw new LexError(`Numeric separator '_' must be between two digits (at position ${i})`, start);
        }
        i++; // consume _
        continue;
      }
      break;
    }
    return i;
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

  /**
   * Read a chunk of a template literal — characters between the previous boundary
   * (opening `, or `${...}`) and the next boundary (closing `, or `${`).
   *
   * Always emits a TemplateChars token (possibly empty) followed by either:
   *   - TemplateExprStart for `${`, then returns to caller (main lex loop resumes
   *     normal lexing inside the expression — the matching `}` re-enters this method)
   *   - TemplateEnd for closing backtick, then returns
   */
  private readTemplateChunk(initialStart: number): void {
    const src = this.src;
    const chunkStart = this.pos;
    let result = "";
    while (this.pos < src.length) {
      const ch = src[this.pos];
      if (ch === "`") {
        this.pushToken({ type: TokenType.TemplateChars, value: result, pos: chunkStart });
        this.pushToken({ type: TokenType.TemplateEnd, value: "`", pos: this.pos });
        this.pos++;
        return;
      }
      if (ch === "$" && src[this.pos + 1] === "{") {
        this.pushToken({ type: TokenType.TemplateChars, value: result, pos: chunkStart });
        this.pushToken({ type: TokenType.TemplateExprStart, value: "${", pos: this.pos });
        this.pos += 2;
        this.templateBraceDepths.push(this.braceDepth);
        return;
      }
      if (ch === "\\") {
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
          case "`":
            result += "`";
            break;
          case "$":
            result += "$";
            break;
          default:
            result += esc;
        }
        this.pos++;
        continue;
      }
      result += ch;
      this.pos++;
    }
    throw new LexError(`Unterminated template literal at position ${initialStart}`, initialStart);
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
      case "undefined":
        return { type: TokenType.Undefined, value: "undefined", pos };
      case "in":
        return { type: TokenType.In, value: "in", pos };
      case "new":
        return { type: TokenType.New, value: "new", pos };
      case "typeof":
        return { type: TokenType.Typeof, value: "typeof", pos };
      case "delete":
        return { type: TokenType.Delete, value: "delete", pos };
      case "let":
        return { type: TokenType.Let, value: "let", pos };
      case "const":
        return { type: TokenType.Const, value: "const", pos };
      case "return":
        return { type: TokenType.Return, value: "return", pos };
      default:
        return { type: TokenType.Ident, value: ident, pos };
    }
  }
}
