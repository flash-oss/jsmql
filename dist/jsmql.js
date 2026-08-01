// src/lexer.ts
var TokenType = {
  // Punctuation
  LParen: "LParen",
  // (
  RParen: "RParen",
  // )
  LBracket: "LBracket",
  // [
  RBracket: "RBracket",
  // ]
  LBrace: "LBrace",
  // {
  RBrace: "RBrace",
  // }
  Comma: "Comma",
  // ,
  Semi: "Semi",
  // ;
  Colon: "Colon",
  // :
  Dot: "Dot",
  // .
  QuestDot: "QuestDot",
  // ?.  (optional chaining)
  DollarDot: "DollarDot",
  // $.
  Dollar: "Dollar",
  // $ (standalone, before IDENT for operator)
  DoubleDollar: "DoubleDollar",
  // $$  (current-collection reference, postfix .name or [expr])
  TripleDollar: "TripleDollar",
  // $$$  (current-database reference)
  QuadDollar: "QuadDollar",
  // $$$$  (current-cluster reference)
  Spread: "Spread",
  // ...
  // Arithmetic operators
  Plus: "Plus",
  // +
  Minus: "Minus",
  // -
  Star: "Star",
  // *
  StarStar: "StarStar",
  // **
  Slash: "Slash",
  // /
  Percent: "Percent",
  // %
  // Increment / decrement (update op statements; not value expressions)
  PlusPlus: "PlusPlus",
  // ++
  MinusMinus: "MinusMinus",
  // --
  // Assignment operators
  Eq: "Eq",
  // =
  PlusEq: "PlusEq",
  // +=
  MinusEq: "MinusEq",
  // -=
  StarEq: "StarEq",
  // *=
  SlashEq: "SlashEq",
  // /=
  // Comparison operators
  EqEq: "EqEq",
  // ==
  EqEqEq: "EqEqEq",
  // ===
  BangEq: "BangEq",
  // !=
  BangEqEq: "BangEqEq",
  // !==
  Gt: "Gt",
  // >
  GtEq: "GtEq",
  // >=
  Lt: "Lt",
  // <
  LtEq: "LtEq",
  // <=
  // Logical operators
  AmpAmp: "AmpAmp",
  // &&
  PipePipe: "PipePipe",
  // ||
  Bang: "Bang",
  // !
  // Bitwise operators
  Amp: "Amp",
  // &
  Pipe: "Pipe",
  // |
  Caret: "Caret",
  // ^
  Tilde: "Tilde",
  // ~
  // Misc operators
  QuestQuest: "QuestQuest",
  // ??
  Quest: "Quest",
  // ?
  Arrow: "Arrow",
  // =>
  // Literals
  Number: "Number",
  BigInt: "BigInt",
  // 123n
  String: "String",
  True: "True",
  False: "False",
  Null: "Null",
  Undefined: "Undefined",
  RegexLiteral: "RegexLiteral",
  // /pattern/flags
  // Template literals
  TemplateStart: "TemplateStart",
  // opening `
  TemplateChars: "TemplateChars",
  // literal chunk between ` and ${ (or ` and `)
  TemplateExprStart: "TemplateExprStart",
  // ${
  TemplateEnd: "TemplateEnd",
  // closing `
  // Keywords
  In: "In",
  // in
  New: "New",
  // new
  Typeof: "Typeof",
  // typeof
  Delete: "Delete",
  // delete
  Let: "Let",
  // let
  Const: "Const",
  // const (alias for let — see docs/specs/let-bindings.md)
  Return: "Return",
  // return (only inside a block-body arrow — see docs/specs/method-dispatch.md)
  // Identifier
  Ident: "Ident",
  EOF: "EOF"
};
var TOKEN_DISPLAY = {
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
  EOF: "end of input"
};
function formatActualToken(t) {
  const display = TOKEN_DISPLAY[t.type];
  if (t.type === TokenType.Ident || t.type === TokenType.Number || t.type === TokenType.BigInt || t.type === TokenType.String || t.type === TokenType.RegexLiteral) {
    return `${display} '${t.value}'`;
  }
  return display;
}
var LexError = class extends Error {
  constructor(message, pos) {
    super(message);
    this.name = "LexError";
    this.pos = pos;
  }
};
var VALUE_ENDING_TYPES = /* @__PURE__ */ new Set([
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
  TokenType.TemplateEnd
]);
var Lexer = class _Lexer {
  constructor(src) {
    this.pos = 0;
    this.tokens = [];
    this.tokenIdx = 0;
    this.lastTokenType = null;
    // Brace depth tracking for template literal expression interpolation.
    // Each entry on templateBraceDepths is the brace depth at which a `${` was opened —
    // when a `}` would bring us back to that depth, it closes the template expression
    // instead of being a normal RBrace.
    this.braceDepth = 0;
    this.templateBraceDepths = [];
    this.src = src;
    this.tokenize();
  }
  peek() {
    return this.tokens[this.tokenIdx] ?? { type: TokenType.EOF, value: "", pos: this.src.length };
  }
  next() {
    const t = this.peek();
    this.tokenIdx++;
    return t;
  }
  lookahead(offset) {
    return this.tokens[this.tokenIdx + offset] ?? { type: TokenType.EOF, value: "", pos: this.src.length };
  }
  expect(type) {
    const t = this.next();
    if (t.type !== type) {
      throw new LexError(`Expected ${TOKEN_DISPLAY[type]} but got ${formatActualToken(t)} at position ${t.pos}`, t.pos);
    }
    return t;
  }
  pushToken(tok) {
    this.tokens.push(tok);
    this.lastTokenType = tok.type;
  }
  tokenize() {
    const src = this.src;
    const len = src.length;
    while (this.pos < len) {
      this.skipTrivia();
      if (this.pos >= len) break;
      const start = this.pos;
      const ch = src[this.pos];
      const ch2 = src[this.pos + 1] ?? "";
      const ch3 = src[this.pos + 2] ?? "";
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
        if (this.templateBraceDepths.length > 0 && this.templateBraceDepths[this.templateBraceDepths.length - 1] === this.braceDepth) {
          this.templateBraceDepths.pop();
          this.pos++;
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
      if (ch === "." && ch2 === "." && ch3 === ".") {
        this.emit(TokenType.Spread, "...", start, 3);
        continue;
      }
      if (ch === ".") {
        this.emit(TokenType.Dot, ".", start, 1);
        continue;
      }
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
          start
        );
      }
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
      if (ch === ">") {
        if (ch2 === "=") {
          this.emit(TokenType.GtEq, ">=", start, 2);
          continue;
        }
        this.emit(TokenType.Gt, ">", start, 1);
        continue;
      }
      if (ch === "<") {
        if (ch2 === "=") {
          this.emit(TokenType.LtEq, "<=", start, 2);
          continue;
        }
        this.emit(TokenType.Lt, "<", start, 1);
        continue;
      }
      if (ch === "&") {
        if (ch2 === "&") {
          this.emit(TokenType.AmpAmp, "&&", start, 2);
          continue;
        }
        this.emit(TokenType.Amp, "&", start, 1);
        continue;
      }
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
      if (ch === "?") {
        if (ch2 === "?") {
          this.emit(TokenType.QuestQuest, "??", start, 2);
          continue;
        }
        if (ch2 === "." && !this.isDigit(ch3)) {
          this.emit(TokenType.QuestDot, "?.", start, 2);
          continue;
        }
        this.emit(TokenType.Quest, "?", start, 1);
        continue;
      }
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
      if (this.isDigit(ch)) {
        this.pushToken(this.readNumber(start));
        continue;
      }
      if (ch === '"' || ch === "'") {
        this.pushToken(this.readString(start));
        continue;
      }
      if (ch === "`") {
        this.pushToken({ type: TokenType.TemplateStart, value: "`", pos: start });
        this.pos++;
        this.readTemplateChunk(start);
        continue;
      }
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
  emit(type, value, pos, len) {
    this.pushToken({ type, value, pos });
    this.pos += len;
  }
  static {
    // ECMAScript LineTerminator set: U+000A (LF), U+000D (CR),
    // U+2028 (LINE SEPARATOR), U+2029 (PARAGRAPH SEPARATOR).
    // Use \u escapes — LSEP/PSEP render invisibly in most editors.
    this.LINE_TERMINATORS = /[\n\r\u2028\u2029]/;
  }
  // Whitespace + JS-style comments. Both forms are pure trivia: discarded
  // here, never reach the token stream or AST. Loop until neither pass
  // makes progress, so any sequence of mixed whitespace and comments
  // collapses to a single trivia run (matches JS).
  skipTrivia() {
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
  skipLineComment() {
    this.pos += 2;
    while (this.pos < this.src.length && !_Lexer.LINE_TERMINATORS.test(this.src[this.pos])) {
      this.pos++;
    }
  }
  // /* block comments */: scan for the closing */, EOF means unclosed.
  // No nesting (matches JS — the first */ closes).
  skipBlockComment() {
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
  isDigit(ch) {
    return ch >= "0" && ch <= "9";
  }
  isHexDigit(ch) {
    return ch >= "0" && ch <= "9" || ch >= "a" && ch <= "f" || ch >= "A" && ch <= "F";
  }
  isIdentStart(ch) {
    return ch >= "a" && ch <= "z" || ch >= "A" && ch <= "Z" || ch === "_";
  }
  isIdentPart(ch) {
    return this.isIdentStart(ch) || this.isDigit(ch);
  }
  readNumber(start) {
    const src = this.src;
    let i = this.pos;
    if (src[i] === "0" && (src[i + 1] === "x" || src[i + 1] === "X")) {
      const hexStart = i + 2;
      i = this.consumeHexDigitsWithSeparators(hexStart, start);
      if (i === hexStart) {
        throw new LexError(
          `Hexadecimal literal at position ${start} has no digits after '0${src[hexStart - 1]}'`,
          start
        );
      }
      const value2 = src.slice(this.pos, i).replace(/_/g, "");
      this.pos = i;
      return { type: TokenType.Number, value: value2, pos: start };
    }
    i = this.consumeDigitsWithSeparators(i, start);
    let hasFraction = false;
    let hasExponent = false;
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
    if (i < src.length && src[i] === "n") {
      if (hasFraction || hasExponent) {
        throw new LexError(
          `Invalid BigInt literal at position ${start}: 'n' suffix requires an integer (no fraction or exponent)`,
          start
        );
      }
      const raw2 = src.slice(this.pos, i);
      const value2 = raw2.replace(/_/g, "");
      this.pos = i + 1;
      return { type: TokenType.BigInt, value: value2, pos: start };
    }
    const raw = src.slice(this.pos, i);
    const value = raw.replace(/_/g, "");
    this.pos = i;
    return { type: TokenType.Number, value, pos: start };
  }
  /**
   * Consume a run of digits, allowing single underscores between them as numeric
   * separators (1_000_000). Rejects leading, trailing, or doubled underscores.
   */
  consumeDigitsWithSeparators(i, start) {
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
        if (next === void 0 || !this.isDigit(next)) {
          throw new LexError(`Numeric separator '_' must be between two digits (at position ${i})`, start);
        }
        i++;
        continue;
      }
      break;
    }
    return i;
  }
  /** Hex variant of consumeDigitsWithSeparators (0-9 a-f A-F, `_` between digits). */
  consumeHexDigitsWithSeparators(i, start) {
    const src = this.src;
    if (i >= src.length || !this.isHexDigit(src[i])) return i;
    i++;
    while (i < src.length) {
      const ch = src[i];
      if (this.isHexDigit(ch)) {
        i++;
        continue;
      }
      if (ch === "_") {
        const next = src[i + 1];
        if (next === void 0 || !this.isHexDigit(next)) {
          throw new LexError(`Numeric separator '_' must be between two digits (at position ${i})`, start);
        }
        i++;
        continue;
      }
      break;
    }
    return i;
  }
  readString(start) {
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
            result += "	";
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
  readTemplateChunk(initialStart) {
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
            result += "	";
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
  readRegex(start) {
    const src = this.src;
    this.pos++;
    let pattern = "";
    let inClass = false;
    while (this.pos < src.length) {
      const ch = src[this.pos];
      if (ch === "\\") {
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
        this.pos++;
        break;
      }
      if (ch === "\n") {
        throw new LexError(`Unterminated regex literal at position ${start}`, start);
      }
      pattern += ch;
      this.pos++;
    }
    let flags = "";
    while (this.pos < src.length && /[gimsuy]/.test(src[this.pos])) {
      flags += src[this.pos];
      this.pos++;
    }
    return { type: TokenType.RegexLiteral, value: pattern, flags, pos: start };
  }
  readIdent() {
    const src = this.src;
    let i = this.pos;
    while (i < src.length && this.isIdentPart(src[i])) i++;
    const ident = src.slice(this.pos, i);
    this.pos = i;
    return ident;
  }
  keywordToken(ident, pos) {
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
};

// src/levenshtein.ts
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array(n + 1);
  const curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}
function closestNameTo(name, candidates) {
  let best = null;
  for (const candidate of candidates) {
    const d = levenshtein(name, candidate);
    if (best === null || d < best.dist) best = { name: candidate, dist: d };
  }
  if (best === null) return null;
  if (best.dist <= 2 && best.dist < name.length) return best.name;
  return null;
}
function didYouMean(name, candidates, format = (s) => `.${s}()`) {
  const suggestion = closestNameTo(name, candidates);
  return suggestion ? ` Did you mean '${format(suggestion)}'?` : "";
}

// src/ast.ts
var MATH_METHODS = [
  "abs",
  "ceil",
  "floor",
  "round",
  "pow",
  "sqrt",
  "exp",
  "log",
  "log2",
  "log10",
  "trunc",
  "min",
  "max",
  "sign",
  "hypot",
  "cbrt",
  "random",
  "sin",
  "cos",
  "tan",
  "asin",
  "acos",
  "atan",
  "atan2",
  "sinh",
  "cosh",
  "tanh",
  "asinh",
  "acosh",
  "atanh"
];
var MATH_CONSTANTS = ["PI", "E"];
var OBJECT_METHODS = ["keys", "values", "entries", "assign", "fromEntries", "groupBy"];
var NUMBER_STATICS = ["isInteger", "isNaN", "isFinite"];
var SET_METHODS = ["intersection", "union", "difference", "isSubsetOf", "isSupersetOf"];

// src/parser.ts
var ParseError = class extends Error {
  constructor(message, pos) {
    super(message);
    this.name = "ParseError";
    this.pos = pos;
  }
};
var FunctionInputError = class extends Error {
  constructor(message, pos = 0) {
    super(message);
    this.name = "FunctionInputError";
    this.pos = pos;
  }
};
var UNARY_MATH_CALLABLES = /* @__PURE__ */ new Set([
  "abs",
  "ceil",
  "floor",
  "round",
  "sqrt",
  "exp",
  "log",
  "log2",
  "log10",
  "trunc",
  "sign",
  "cbrt",
  "sin",
  "cos",
  "tan",
  "asin",
  "acos",
  "atan",
  "sinh",
  "cosh",
  "tanh"
]);
var MATH_METHODS2 = new Set(MATH_METHODS);
var MATH_CONSTANTS2 = new Set(MATH_CONSTANTS);
var OBJECT_METHODS2 = new Set(OBJECT_METHODS);
var TYPE_CAST_NAMES = /* @__PURE__ */ new Set(["Number", "String", "Boolean", "parseInt", "parseFloat"]);
var BARE_CAST_NAMES = /* @__PURE__ */ new Set(["Number", "String", "Boolean"]);
var OBJECTID_MIN_HEX = "4a0000000000000000000000";
function assertPlausibleObjectId(hex, pos) {
  const lower = hex.toLowerCase();
  if (lower < OBJECTID_MIN_HEX) {
    const when = new Date(parseInt(lower.slice(0, 8), 16) * 1e3).toISOString().slice(0, 10);
    throw new ParseError(
      `ObjectId ${lower} looks like a typo: its embedded timestamp decodes to ${when}, older than the smallest valid ObjectId ${OBJECTID_MIN_HEX} (2009-05-05, around MongoDB's first release).`,
      pos
    );
  }
}
function compoundBinaryOp(op) {
  switch (op) {
    case "+=":
      return "+";
    case "-=":
      return "-";
    case "*=":
      return "*";
    case "/=":
      return "/";
  }
}
var MAX_RECURSION_DEPTH = 200;
var Parser = class {
  constructor(src) {
    this.depth = 0;
    this.lexer = new Lexer(src);
  }
  parse() {
    const stmts = [this.collectStatement()];
    let multi = false;
    while (true) {
      if (this.lexer.peek().type === TokenType.Semi) {
        this.lexer.next();
        multi = true;
        if (this.lexer.peek().type === TokenType.EOF) break;
        stmts.push(this.collectStatement());
        continue;
      }
      if (this.selfTerminates(stmts[stmts.length - 1]) && this.lexer.peek().type !== TokenType.EOF) {
        multi = true;
        stmts.push(this.collectStatement());
        continue;
      }
      break;
    }
    const eof = this.lexer.peek();
    if (eof.type !== TokenType.EOF) {
      throw new ParseError(`Unexpected token '${eof.value}' at position ${eof.pos}`, eof.pos);
    }
    if (!multi) {
      const only = stmts[0];
      if (only.type === "LetDecl") this.throwLetOutsidePipeline(only.name, only.pos);
      if (only.type === "FuncDecl") this.throwFuncDeclOutsidePipeline(only.name, only.pos);
      return only;
    }
    return { type: "Pipeline", stmts, pos: stmts[0].pos };
  }
  /**
   * A `function`-keyword declaration is self-terminating (JS-style): its closing
   * `}` ends the statement, so the next statement may follow with no `;`. Every
   * other statement (including an arrow-form `const f = … => …` declaration)
   * still needs the usual `;` separator.
   */
  selfTerminates(stmt) {
    return stmt.type === "FuncDecl" && stmt.form === "function";
  }
  /**
   * Entry point for the function-input form (`jsmql(({ $ }) => …)`). The source
   * is the result of `Function.prototype.toString.call(fn)` — a full arrow
   * function expression. We consume the parameter list and `=>`, then dispatch
   * to either a block-body parser (`{ stmt; stmt; }`, the function-form mirror
   * of the implicit `;`-separated pipeline) or an expression-body parser (a
   * single jsmql expression / update op, with one optional trailing `;` allowed
   * as a formatter artifact — single-statement bodies do NOT flip into pipeline
   * mode here).
   *
   * Raises `FunctionInputError` for shape problems specific to the adapter
   * (`async`, `function`, missing arrow, `return` in a block body, …) and
   * `ParseError`/`LexError` for grammar problems inside the body itself.
   */
  parseFunctionInput() {
    const first = this.lexer.peek();
    if (first.type === TokenType.Ident && first.value === "async") {
      throw new FunctionInputError(
        "jsmql does not support async functions. Use a synchronous arrow `({ $ }) => \u2026` or `function ({ $ }) { return \u2026 }`.",
        first.pos
      );
    }
    let isFunctionForm = false;
    if (first.type === TokenType.Ident && first.value === "function") {
      this.lexer.next();
      if (this.lexer.peek().type === TokenType.Star) {
        throw new FunctionInputError(
          "jsmql does not support generator functions (`function*`). Use `function ({ $ }) { return \u2026 }` or an arrow `({ $ }) => \u2026`.",
          this.lexer.peek().pos
        );
      }
      if (this.lexer.peek().type === TokenType.Ident) this.lexer.next();
      isFunctionForm = true;
    }
    if (this.lexer.peek().type !== TokenType.LParen) {
      const tok = this.lexer.peek();
      throw new FunctionInputError(
        isFunctionForm ? "jsmql expected '(' to start the parameter list of the `function` input." : "jsmql expects an arrow function `({ $ }) => \u2026` (or `function ({ $ }) { return \u2026 }`) as the function-form input.",
        tok.pos
      );
    }
    const bindings = this.parseParameterList();
    if (isFunctionForm) {
      if (this.lexer.peek().type !== TokenType.LBrace) {
        const tok = this.lexer.peek();
        throw new FunctionInputError(
          "jsmql expected '{' to start the body of the `function` input \u2014 a `function` body is a block, e.g. `function ({ $ }) { return <expr> }`.",
          tok.pos
        );
      }
      return { program: this.parseEntryBlockBody(), bindings };
    }
    const arrowTok = this.lexer.peek();
    if (arrowTok.type !== TokenType.Arrow) {
      throw new FunctionInputError(
        "jsmql could not find an arrow operator (`=>`) in the function source. Use: `({ $ }) => \u2026`",
        arrowTok.pos
      );
    }
    this.lexer.next();
    if (this.lexer.peek().type === TokenType.LBrace) return { program: this.parseEntryBlockBody(), bindings };
    return { program: this.parseExpressionBody(), bindings };
  }
  /**
   * Dispatch the brace body of an entry-form function/arrow (`jsmql(({ $ }) => { … })`
   * / `jsmql(function ({ $ }) { … })`). Cursor is at `{`. Two shapes, mirroring what
   * arrows can already express at the entry:
   *   - **Value form** `{ return <expr> }` — the body opens directly with
   *     `return`. Equivalent to the expression-body entry `({ $ }) => <expr>`; the
   *     program is the bare `<expr>` (so it lowers to a Filter / expression /
   *     parameterised builder, with no `$let` envelope). This also makes the
   *     long-broken `({ $ }) => { return … }` work, in line with value-position
   *     lambdas.
   *   - **Pipeline form** `{ stmt; stmt; … }` — anything else; a `;`-separated
   *     sequence of stage / update-op / let / `function`-decl statements.
   * A "locals then return" body (`{ const a = …; return a }`) has no arrow
   * precedent at the entry, so it routes to the pipeline form where `rejectReturn`
   * surfaces an actionable message.
   */
  parseEntryBlockBody() {
    if (this.lexer.lookahead(1).type === TokenType.Return) return this.parseEntryReturnBody();
    return this.parseBlockBody();
  }
  /** Parse the entry value body `{ return <expr> ;? }` → the bare `<expr>`. */
  parseEntryReturnBody() {
    this.lexer.next();
    this.lexer.next();
    const expr = this.parseExpression();
    if (this.lexer.peek().type === TokenType.Semi) this.lexer.next();
    const close = this.lexer.peek();
    if (close.type !== TokenType.RBrace) {
      throw new ParseError(
        `Expected '}' to close the \`{ return \u2026 }\` body at position ${close.pos}, got ${formatActualToken(close)}.`,
        close.pos
      );
    }
    this.lexer.next();
    const eof = this.lexer.peek();
    if (eof.type !== TokenType.EOF) {
      throw new ParseError(`Unexpected token after function body at position ${eof.pos}`, eof.pos);
    }
    return expr;
  }
  /**
   * Parse and classify the parenthesised parameter list of the function-form
   * arrow. There are at most two *slots*, each an object destructure:
   *
   *   - **Toolbox** — a destructure whose keys are all `$`-prefixed: the bare
   *     document root `$`, the context refs `$$` / `$$$` / `$$$$`, and any
   *     `$op` (`{ $, $match, $dateDiff }`). Types-only IDE convenience;
   *     discarded — the keys don't reach codegen.
   *   - **Params** — a destructure with at least one non-`$` key (`{ minAge }`).
   *     The `jsmql.compile()` parameter bindings; names are returned so codegen
   *     can inline values supplied at call time.
   *
   * The legal slot orderings are: `()`, `({ $, … })`, `(params)`, and
   * `(params, { $, … })`. A bare identifier or bare `$` slot,
   * a third slot, or a params destructure after the toolbox all
   * throw `FunctionInputError` with a precise message.
   *
   * Returns the binding names extracted from the params slot (in source
   * order). Cursor is left immediately after the closing `)`.
   */
  parseParameterList() {
    this.lexer.next();
    const slots = [];
    if (this.lexer.peek().type !== TokenType.RParen) {
      while (true) {
        slots.push(this.parseParameterSlot());
        const sep = this.lexer.peek();
        if (sep.type === TokenType.Comma) {
          this.lexer.next();
          if (this.lexer.peek().type === TokenType.RParen) break;
          continue;
        }
        if (sep.type === TokenType.RParen) break;
        throw new FunctionInputError(
          `jsmql could not parse the function parameter list \u2014 expected ',' or ')' at position ${sep.pos}, got '${sep.value}'.`,
          sep.pos
        );
      }
    }
    const closeParen = this.lexer.next();
    if (slots.length > 2) {
      throw new FunctionInputError(
        `jsmql's arrow takes at most two parameters: \`(params, { $, \u2026 })\`. Got ${slots.length}. Combine into a params destructure followed by a single toolbox destructure.`,
        closeParen.pos
      );
    }
    let sawParams = false;
    let sawToolbox = false;
    let bindings = [];
    for (const slot of slots) {
      if (slot.kind === "params") {
        if (sawParams) {
          throw new FunctionInputError(
            "jsmql params destructure may only appear once. Combine the bindings into a single parameter: `({ a, b }, \u2026) => \u2026`.",
            slot.pos
          );
        }
        if (sawToolbox) {
          throw new FunctionInputError(
            "jsmql expects the params destructure to appear before the toolbox destructure. Reorder to `(params, { $, \u2026 })`.",
            slot.pos
          );
        }
        sawParams = true;
        bindings = slot.bindings;
      } else {
        if (sawToolbox) {
          throw new FunctionInputError(
            "jsmql's arrow takes at most one toolbox destructure (e.g. `{ $, $match }`).",
            slot.pos
          );
        }
        sawToolbox = true;
      }
    }
    return bindings;
  }
  /**
   * Parse a single parameter slot and classify it by shape. Called by
   * `parseParameterList`; advances the lexer past the slot.
   */
  parseParameterSlot() {
    const head = this.lexer.peek();
    if (head.type === TokenType.LBracket) {
      throw new FunctionInputError(
        "jsmql params must be an object destructure pattern: `{ a, b }`. Array destructure is not accepted \u2014 params are always named, never positional.",
        head.pos
      );
    }
    if (head.type !== TokenType.LBrace) {
      throw new FunctionInputError(
        `jsmql expects each parameter to be an object destructure pattern (\`{ \u2026 }\`), got '${head.value}' at position ${head.pos}. Write the document context as \`({ $ }) => \u2026\`.`,
        head.pos
      );
    }
    return this.parseDestructureSlot();
  }
  /**
   * Parse `{ key (: alias)? (, key)* (,)? }` and classify the slot as `toolbox`
   * (every key starts with `$` — including the bare `$` and the context refs
   * `$$` / `$$$` / `$$$$`) or `params` (at least one non-`$` key).
   * Rejects defaults, nested destructure, rest, and mixed `$`/non-`$` keys
   * with the user-facing error messages from `docs/LANGUAGE.md`.
   */
  parseDestructureSlot() {
    const openBrace = this.lexer.next();
    const toolboxKeys = [];
    const paramBindings = [];
    if (this.lexer.peek().type === TokenType.RBrace) {
      this.lexer.next();
      return { kind: "toolbox", pos: openBrace.pos };
    }
    while (true) {
      const key = this.lexer.peek();
      if (key.type === TokenType.Spread) {
        throw new FunctionInputError(
          "jsmql does not support rest patterns in params: `{ ...rest }`. The set of bindings must be statically known at compile time so the generated MQL can reference each by name. List each binding explicitly: `{ a, b, c }`.",
          key.pos
        );
      }
      let keyName;
      let isToolboxKey;
      if (key.type === TokenType.Dollar) {
        this.lexer.next();
        const after = this.lexer.peek();
        if (after.type === TokenType.Ident) {
          this.lexer.next();
          keyName = `$${after.value}`;
        } else {
          keyName = "$";
        }
        isToolboxKey = true;
      } else if (key.type === TokenType.DoubleDollar || key.type === TokenType.TripleDollar || key.type === TokenType.QuadDollar) {
        this.lexer.next();
        keyName = key.value;
        isToolboxKey = true;
      } else if (key.type === TokenType.Ident) {
        this.lexer.next();
        keyName = key.value;
        isToolboxKey = false;
      } else {
        throw new FunctionInputError(
          `jsmql expected an identifier in the destructure pattern at position ${key.pos}, got '${key.value}'.`,
          key.pos
        );
      }
      let bindingName = keyName;
      if (this.lexer.peek().type === TokenType.Colon) {
        this.lexer.next();
        const alias = this.lexer.peek();
        if (alias.type === TokenType.LBrace || alias.type === TokenType.LBracket) {
          throw new FunctionInputError(
            "jsmql does not support nested destructure in params: `{ <name>: { \u2026 } }`. Params is a flat key\u2192value map at the MQL level. Use a single level of destructure and reference nested fields explicitly at the call site, e.g. `q({ b: source.a.b })`.",
            alias.pos
          );
        }
        if (alias.type !== TokenType.Ident) {
          throw new FunctionInputError(
            `jsmql expected an alias identifier after ':' in the destructure pattern at position ${alias.pos}, got '${alias.value}'.`,
            alias.pos
          );
        }
        this.lexer.next();
        bindingName = alias.value;
      }
      if (this.lexer.peek().type === TokenType.Eq) {
        const defaultTok = this.lexer.peek();
        throw new FunctionInputError(
          "jsmql does not support default values in the params destructure: `{ <name> = <expr> }`.\n\njsmql compiles your function to MQL at parse time. It reads the function's source text but cannot evaluate the default expression \u2014 for `= config.minAge` or `= Date.now()` there is no runtime to ask, since jsmql never actually calls your arrow. Restricting defaults to literals (`= 18`) would make the rule silently inconsistent with the rest of the destructure, where any value is fine at call time.\n\nInstead:\n  - For a runtime fallback, use JS's `??` at the call site: `q({ minAge: input ?? 18 })`.\n  - For a value that's always the same and never overridden, the template-tag form already inlines hardcoded values: `` jsmql`$.age > ${18}` ``.",
          defaultTok.pos
        );
      }
      if (isToolboxKey) toolboxKeys.push(keyName);
      else paramBindings.push({ key: keyName, name: bindingName });
      const sep = this.lexer.peek();
      if (sep.type === TokenType.Comma) {
        this.lexer.next();
        if (this.lexer.peek().type === TokenType.RBrace) break;
        continue;
      }
      if (sep.type === TokenType.RBrace) break;
      throw new FunctionInputError(
        `jsmql could not parse the destructure pattern \u2014 expected ',' or '}' at position ${sep.pos}, got '${sep.value}'.`,
        sep.pos
      );
    }
    this.lexer.next();
    if (toolboxKeys.length > 0 && paramBindings.length > 0) {
      throw new FunctionInputError(
        "jsmql keeps the toolbox destructure (e.g. `{ $, $match }`) separate from the params destructure (e.g. `{ minAge }`). Use two parameters: `(params, { $, \u2026 }) => \u2026`.",
        openBrace.pos
      );
    }
    if (paramBindings.length > 0) return { kind: "params", bindings: paramBindings, pos: openBrace.pos };
    return { kind: "toolbox", pos: openBrace.pos };
  }
  /**
   * Parse the body of a block-body arrow: `{ stmt (; stmt)* ;? }`. This is
   * structurally the same as the top-level `;`-separated pipeline form
   * (see `parse()`), terminated by `}` instead of EOF. A single-statement
   * block body without `;` returns the underlying `Expr`/`UpdateFilter`
   * unchanged; any `;` (including a trailing one) wraps as a `Pipeline`.
   *
   * `return` is rejected up front with a precise `FunctionInputError` so the
   * user gets a clear pointer to either the `;`-separated form or an
   * expression-body arrow, instead of the parser's generic "unknown
   * identifier" message.
   */
  parseBlockBody() {
    const openBrace = this.lexer.next();
    if (this.lexer.peek().type === TokenType.RBrace) {
      throw new FunctionInputError("jsmql expects at least one statement inside a block-body arrow.", openBrace.pos);
    }
    this.rejectReturn();
    const stmts = [this.collectStatement()];
    let multi = false;
    while (true) {
      if (this.lexer.peek().type === TokenType.Semi) {
        this.lexer.next();
        multi = true;
        if (this.lexer.peek().type === TokenType.RBrace) break;
        this.rejectReturn();
        stmts.push(this.collectStatement());
        continue;
      }
      if (this.selfTerminates(stmts[stmts.length - 1]) && this.lexer.peek().type !== TokenType.RBrace) {
        multi = true;
        this.rejectReturn();
        stmts.push(this.collectStatement());
        continue;
      }
      break;
    }
    const closeTok = this.lexer.peek();
    if (closeTok.type !== TokenType.RBrace) {
      throw new ParseError(`Expected '}' to close the block body at position ${closeTok.pos}`, closeTok.pos);
    }
    this.lexer.next();
    const eof = this.lexer.peek();
    if (eof.type !== TokenType.EOF) {
      throw new ParseError(`Unexpected token after function body at position ${eof.pos}`, eof.pos);
    }
    if (!multi) {
      const only = stmts[0];
      if (only.type === "LetDecl") this.throwLetOutsidePipeline(only.name, only.pos);
      if (only.type === "FuncDecl") this.throwFuncDeclOutsidePipeline(only.name, only.pos);
      return only;
    }
    return { type: "Pipeline", stmts, pos: stmts[0].pos };
  }
  /**
   * Parse the body of an expression-body arrow: a single jsmql statement,
   * with one optional trailing `;` consumed as a formatter artifact. The
   * trailing `;` does NOT trigger pipeline mode here — single-statement
   * expression bodies preserve their object-shaped output, matching the
   * documented contract for `jsmql(({ $ }) => …)`.
   */
  parseExpressionBody() {
    const stmt = this.collectStatement();
    if (this.lexer.peek().type === TokenType.Semi) {
      this.lexer.next();
    }
    const eof = this.lexer.peek();
    if (eof.type !== TokenType.EOF) {
      throw new ParseError(`Unexpected token after function body at position ${eof.pos}`, eof.pos);
    }
    if (stmt.type === "LetDecl") this.throwLetOutsidePipeline(stmt.name, stmt.pos);
    if (stmt.type === "FuncDecl") this.throwFuncDeclOutsidePipeline(stmt.name, stmt.pos);
    return stmt;
  }
  /**
   * Raised when a `let` declaration appears at the top of an input that turns
   * out to be expression-mode (no `;` separator, not a bracketed pipeline).
   * `let` only makes sense as a pipeline statement — there's no enclosing
   * scope for the binding to live in otherwise.
   */
  throwLetOutsidePipeline(name, pos) {
    throw new ParseError(
      `\`let ${name} = \u2026\` is only valid inside a pipeline. Add at least one more statement separated by \`;\` to flip into pipeline mode (e.g. \`let ${name} = \u2026; { $project: \u2026 }\`). The bracketed pipeline form \`[ let ${name} = \u2026, \u2026 ]\` works too.`,
      pos
    );
  }
  /**
   * Throw a precise `FunctionInputError` if the next token is a statement-leading
   * `return`. Called at every statement-start position inside a function-input
   * **pipeline** block body. The pure value form `{ return <expr> }` is routed
   * away before reaching here (see `parseFunctionInput`), so a `return` that
   * lands here is a control-flow `return` mixed into a `;`-separated pipeline
   * body (e.g. `({ $ }) => { $.x = 1; return $.y }`) — which has no MQL meaning. The
   * check is statement-position-only, so a `return` used as a property name
   * (`$.return`) — which lexes as a `Return` token after a `.` — never reaches a
   * statement-start position and so doesn't false-fire.
   */
  rejectReturn() {
    const tok = this.lexer.peek();
    if (tok.type === TokenType.Return) {
      throw new FunctionInputError(
        "A `return` here isn't a jsmql statement. A function/arrow body is either a single `{ return <expr> }` (the value form, e.g. `({ $ }) => { return $.age }`) or a `;`-separated sequence of jsmql statements (no `return`). For a value computed from locals, use `jsmql.expr` or fold the bindings into the returned expression.",
        tok.pos
      );
    }
  }
  /**
   * Parse one top-level statement: either an expression or a update op chain
   * (one or more comma-separated update ops sharing a stage). Stops at the
   * first `;` or EOF; the caller (`parse()`) handles the `;` boundary.
   */
  collectStatement() {
    const first = this.lexer.peek();
    if (first.type === TokenType.Ident && first.value === "function") {
      return this.parseFunctionDeclStatement();
    }
    if (first.type === TokenType.Let || first.type === TokenType.Const) {
      return this.parseDeclStatement();
    }
    if (first.type === TokenType.Delete || first.type === TokenType.PlusPlus || first.type === TokenType.MinusMinus) {
      return this.parseUpdateFilter();
    }
    const expr = this.parseExpression();
    if (this.peekAssignOp() !== null) {
      this.validateUpdateTarget(expr);
      return this.parseUpdateFilterFrom(expr);
    }
    if (this.peekIncDecOp() !== null) {
      this.validateUpdateTarget(expr);
      return this.parseUpdateFilterFromPostfix(expr);
    }
    if (expr.type === "AssignExpr") {
      const ops = [expr];
      this.parseUpdateFilterRest(ops);
      return { type: "UpdateFilter", ops, pos: ops[0].pos };
    }
    return expr;
  }
  // ── Let declaration ──────────────────────────────────────────────────────
  /**
   * Parse `let <ident> = <expr>` (or the `const` alias — see
   * docs/specs/let-bindings.md). The leading `let`/`const` token must already
   * be the current peek; this consumes it and the rest of the declaration. The
   * cursor is left at whatever follows the value expression (typically `;` or
   * `,` in the array-pipeline form). No re-declaration check here — that needs a
   * pipeline-level view and lives in codegen.
   */
  parseLetDecl() {
    const kwTok = this.lexer.next();
    const kw = kwTok.value;
    const ident = this.lexer.peek();
    if (ident.type !== TokenType.Ident) {
      throw new ParseError(
        `Expected an identifier after \`${kw}\` at position ${ident.pos}, got '${ident.value}'`,
        ident.pos
      );
    }
    this.lexer.next();
    const eq = this.lexer.peek();
    if (eq.type !== TokenType.Eq) {
      throw new ParseError(
        `Expected '=' after \`${kw} ${ident.value}\` at position ${eq.pos}, got '${eq.value}'. \`${kw}\` requires an initialiser \u2014 write \`${kw} ${ident.value} = <expr>\`.`,
        eq.pos
      );
    }
    this.lexer.next();
    const value = this.lexer.peek().type === TokenType.Ident && this.lexer.lookahead(1).type === TokenType.Arrow ? this.parseLambdaUnparen() : this.parseExpression();
    const kind = kw === "const" ? "const" : "let";
    return { type: "LetDecl", name: ident.value, value, kind, pos: kwTok.pos };
  }
  /**
   * Parse a `let`/`const` declaration in a pipeline-statement position, forking
   * an arrow-function initialiser into a reusable `FuncDecl` (see ast.ts). A
   * non-arrow initialiser stays a value-binding `LetDecl`. The fork is purely
   * syntactic (RHS is an arrow ⇒ function), so the same input always produces
   * the same node. Used by `collectStatement` and `parseArrayLiteral`; the
   * block-body-arrow path (`parseExprBlockBody`) deliberately does NOT fork —
   * functions are top-level-only. See docs/specs/reusable-functions.md.
   */
  parseDeclStatement() {
    const decl = this.parseLetDecl();
    if (decl.value.type === "Lambda") {
      return { type: "FuncDecl", name: decl.name, lambda: decl.value, kind: decl.kind, form: "arrow", pos: decl.pos };
    }
    return decl;
  }
  /**
   * Raised when a reusable function declaration appears at the top of an input
   * that turns out to be expression-mode (no `;`, not a bracketed pipeline).
   * Like `let`, a function is a pipeline statement — there's nothing to call it
   * from in a bare expression.
   */
  throwFuncDeclOutsidePipeline(name, pos) {
    throw new ParseError(
      `A reusable function declaration (\`function ${name}(\u2026) { \u2026 }\` / \`const ${name} = (\u2026) => \u2026\`) is only valid inside a pipeline. Add at least one more statement that calls \`${name}\` (e.g. \`function ${name}(\u2026) { \u2026 } $ = { \u2026 }\`, or \`const ${name} = \u2026; $ = { \u2026 }\`), or use the bracketed form \`[ const ${name} = \u2026, \u2026 ]\`.`,
      pos
    );
  }
  // ── UpdateOp program ─────────────────────────────────────────────────────
  /** Entry when the input starts with a update op token (`delete`). */
  parseUpdateFilter() {
    const ops = [];
    ops.push(...this.parseUpdateOp());
    this.parseUpdateFilterRest(ops);
    return { type: "UpdateFilter", ops, pos: ops[0].pos };
  }
  /** Entry when the first target was already parsed as an expression. */
  parseUpdateFilterFrom(firstTarget) {
    const ops = [];
    ops.push(...this.parseAssignmentChainFrom(firstTarget));
    this.parseUpdateFilterRest(ops);
    return { type: "UpdateFilter", ops, pos: ops[0].pos };
  }
  /**
   * Entry when the first target was parsed and is followed by `++` or `--`
   * (postfix inc/dec). Validation must already have happened.
   */
  parseUpdateFilterFromPostfix(firstTarget) {
    const op = this.peekIncDecOp();
    if (op === null) {
      const tok = this.lexer.peek();
      throw new ParseError(`Expected '++' or '--' at position ${tok.pos}`, tok.pos);
    }
    this.lexer.next();
    const ops = [this.makeIncDecUpdateOp(firstTarget, op)];
    this.parseUpdateFilterRest(ops);
    return { type: "UpdateFilter", ops, pos: ops[0].pos };
  }
  /**
   * After the first update op is parsed, consume any `,`-separated tail.
   * Stops at the first non-`,` token (typically `;` or EOF) and leaves
   * the cursor there for the caller to handle.
   */
  parseUpdateFilterRest(ops) {
    while (this.peekUpdateOpSeparator()) {
      this.lexer.next();
      const next = this.lexer.peek().type;
      if (next === TokenType.EOF || next === TokenType.Semi || next === TokenType.RBrace || next === TokenType.RBracket || next === TokenType.RParen) {
        break;
      }
      ops.push(...this.parseUpdateOp());
    }
  }
  /**
   * Parse a single update op. Returns an array because a chained assignment
   * (`$.a = $.b = expr`) flattens to multiple `AssignExpr` nodes here, all
   * sharing the deepest RHS.
   */
  parseUpdateOp() {
    if (this.lexer.peek().type === TokenType.Delete) {
      return [this.parseDeleteStmt()];
    }
    if (this.peekIncDecOp() !== null) {
      return [this.parsePrefixIncDec()];
    }
    const target = this.parsePostfix();
    if (target.type === "AssignExpr") {
      return [target];
    }
    this.validateUpdateTarget(target);
    const postfix = this.peekIncDecOp();
    if (postfix !== null) {
      this.lexer.next();
      return [this.makeIncDecUpdateOp(target, postfix)];
    }
    return this.parseAssignmentChainFrom(target);
  }
  parseDeleteStmt() {
    const delTok = this.lexer.next();
    const target = this.parsePostfix();
    this.validateUpdateTarget(target);
    return { type: "DeleteStmt", target, pos: delTok.pos };
  }
  /**
   * Given a target already parsed and validated, expect an assignment operator
   * and parse the RHS. Handles right-associative chains for `=`; rejects them
   * for compound operators because `a += b += 1` is too easy to misread.
   */
  parseAssignmentChainFrom(target) {
    const opTok = this.lexer.peek();
    const op = this.peekAssignOp();
    if (op === null) {
      throw new ParseError(`Expected assignment operator at position ${opTok.pos}`, opTok.pos);
    }
    this.lexer.next();
    if (op === "=") {
      if (this.peekIsAssignmentChainStart()) {
        const subTarget = this.parsePostfix();
        this.validateUpdateTarget(subTarget);
        const sub = this.parseAssignmentChainFrom(subTarget);
        const deepestValue = sub[sub.length - 1].value;
        return [{ type: "AssignExpr", target, value: deepestValue, pos: target.pos }, ...sub];
      }
      const value = this.parseExpression();
      return [{ type: "AssignExpr", target, value, pos: target.pos }];
    }
    if (this.peekIsAssignmentChainStart()) {
      const tok = this.lexer.peek();
      throw new ParseError(
        `Compound assignment cannot be chained at position ${tok.pos} \u2014 split into separate statements`,
        tok.pos
      );
    }
    const rhs = this.parseExpression();
    const desugared = { type: "BinaryExpr", op: compoundBinaryOp(op), left: target, right: rhs, pos: target.pos };
    return [{ type: "AssignExpr", target, value: desugared, pos: target.pos }];
  }
  /**
   * Returns the assignment operator string at the current position, or null
   * if the next token is not an assignment operator.
   */
  peekAssignOp() {
    switch (this.lexer.peek().type) {
      case TokenType.Eq:
        return "=";
      case TokenType.PlusEq:
        return "+=";
      case TokenType.MinusEq:
        return "-=";
      case TokenType.StarEq:
        return "*=";
      case TokenType.SlashEq:
        return "/=";
      default:
        return null;
    }
  }
  isAssignOpType(t) {
    return t === TokenType.Eq || t === TokenType.PlusEq || t === TokenType.MinusEq || t === TokenType.StarEq || t === TokenType.SlashEq;
  }
  peekUpdateOpSeparator() {
    return this.lexer.peek().type === TokenType.Comma;
  }
  /**
   * Returns "++" or "--" if the next token is an inc/dec operator, else null.
   * Used at both prefix (start of update op) and postfix (after a target)
   * positions; the caller decides which.
   */
  peekIncDecOp() {
    switch (this.lexer.peek().type) {
      case TokenType.PlusPlus:
        return "++";
      case TokenType.MinusMinus:
        return "--";
      default:
        return null;
    }
  }
  /**
   * Parse a prefix `++<target>` or `--<target>`. The prefix vs postfix
   * distinction is irrelevant in MQL pipeline context — both forms compile
   * to the same `$set: { x: { $add|$subtract: ["$x", 1] } }` shape, since
   * pipeline stages don't carry "value of expression" semantics.
   */
  parsePrefixIncDec() {
    const op = this.peekIncDecOp();
    if (op === null) {
      const tok = this.lexer.peek();
      throw new ParseError(`Expected '++' or '--' at position ${tok.pos}`, tok.pos);
    }
    this.lexer.next();
    const target = this.parsePostfix();
    this.validateUpdateTarget(target);
    return this.makeIncDecUpdateOp(target, op);
  }
  /** Build the desugared AssignExpr for `target++` / `target--` / `++target` / `--target`. */
  makeIncDecUpdateOp(target, op) {
    const value = {
      type: "BinaryExpr",
      op: op === "++" ? "+" : "-",
      left: target,
      right: { type: "NumberLiteral", value: 1, pos: target.pos },
      pos: target.pos
    };
    return { type: "AssignExpr", target, value, pos: target.pos };
  }
  /**
   * Lookahead: do the next tokens look like `$.path[.path]* <assignOp>`?
   * Used to detect the start of a chained assignment's RHS when we're at
   * the right of a `=` operator. Bounded by the length of the field path
   * so it's cheap and never false-positive on regular RHS expressions.
   */
  peekIsAssignmentChainStart() {
    if (this.lexer.peek().type !== TokenType.DollarDot) return false;
    let offset = 1;
    if (!this.isIdentOrKeyword(this.lexer.lookahead(offset))) return false;
    offset++;
    while (this.lexer.lookahead(offset).type === TokenType.Dot) {
      offset++;
      if (!this.isIdentOrKeyword(this.lexer.lookahead(offset))) return false;
      offset++;
    }
    return this.isAssignOpType(this.lexer.lookahead(offset).type);
  }
  /**
   * UpdateOp targets are restricted to field paths: a `FieldRef` (`$.x`) or
   * a chain of `MemberAccess` nodes rooted at one (`$.x.y.z`). Anything else
   * — index access, function calls, parameter refs, parenthesized expressions
   * containing operators — is rejected with a precise error.
   */
  validateUpdateTarget(target) {
    if (this.isFieldPathTarget(target)) return;
    if (this.isOutTarget(target)) return;
    if (target.type === "ParamRef") return;
    const pos = this.lexer.peek().pos;
    if (target.type === "IndexAccess") {
      throw new ParseError(
        `UpdateOp target must be a static field path; computed/index access ('[\u2026]') is not supported (at position ${pos})`,
        pos
      );
    }
    throw new ParseError(
      `Cannot assign to ${describeUpdateTarget(target)} at position ${pos} \u2014 only field paths like '$.x' or '$.x.y' are assignable.`,
      pos
    );
  }
  isFieldPathTarget(target) {
    if (target.type === "FieldRef") return true;
    if (target.type === "CollectionRef") return true;
    if (target.type === "MemberAccess") return this.isFieldPathTarget(target.object);
    return false;
  }
  /**
   * Accept the `$out` sugar LHS shape: one or two static (dot or bracket)
   * accesses rooted at `DatabaseRef` (`$$$`) or `ClusterRef` (`$$$$`). The
   * detailed validation (right segment count, no computed bracket) lives in
   * codegen — at parse time we only commit to "this looks like a write
   * destination" so the assignment can be built and routed.
   */
  isOutTarget(target) {
    if (target.type === "DatabaseRef" || target.type === "ClusterRef") return true;
    if (target.type === "MemberAccess") return this.isOutTarget(target.object);
    if (target.type === "IndexAccess") return this.isOutTarget(target.object);
    return false;
  }
  // ── Precedence hierarchy (low → high) ────────────────────────────────────
  parseExpression() {
    if (++this.depth > MAX_RECURSION_DEPTH) {
      this.depth--;
      const pos = this.lexer.peek().pos;
      throw new ParseError(`Expression nests too deeply (max ${MAX_RECURSION_DEPTH} levels) at position ${pos}`, pos);
    }
    try {
      return this.parseTernary();
    } finally {
      this.depth--;
    }
  }
  /** ternary:  nullish ("?" expression ":" ternary)?  — right-associative */
  parseTernary() {
    const condition = this.parseNullish();
    if (this.lexer.peek().type !== TokenType.Quest) return condition;
    this.lexer.next();
    const consequent = this.parseExpression();
    const colon = this.lexer.peek();
    if (colon.type !== TokenType.Colon) {
      throw new ParseError(`Expected ':' in ternary expression at position ${colon.pos}`, colon.pos);
    }
    this.lexer.next();
    const alternate = this.parseTernary();
    return { type: "TernaryExpr", condition, consequent, alternate, pos: condition.pos };
  }
  /** nullish:  or ("??" or)*  — left-associative, flattened later */
  parseNullish() {
    let left = this.parseOr();
    while (this.lexer.peek().type === TokenType.QuestQuest) {
      this.lexer.next();
      const right = this.parseOr();
      left = { type: "BinaryExpr", op: "??", left, right, pos: left.pos };
    }
    return left;
  }
  /** or:  and ("||" and)*  */
  parseOr() {
    let left = this.parseAnd();
    while (this.lexer.peek().type === TokenType.PipePipe) {
      this.lexer.next();
      const right = this.parseAnd();
      left = { type: "BinaryExpr", op: "||", left, right, pos: left.pos };
    }
    return left;
  }
  /** and:  bitOr ("&&" bitOr)*  */
  parseAnd() {
    let left = this.parseBitOr();
    while (this.lexer.peek().type === TokenType.AmpAmp) {
      this.lexer.next();
      const right = this.parseBitOr();
      left = { type: "BinaryExpr", op: "&&", left, right, pos: left.pos };
    }
    return left;
  }
  /** bitOr:  bitXor ("|" bitXor)*  */
  parseBitOr() {
    let left = this.parseBitXor();
    while (this.lexer.peek().type === TokenType.Pipe) {
      this.lexer.next();
      const right = this.parseBitXor();
      left = { type: "BinaryExpr", op: "|", left, right, pos: left.pos };
    }
    return left;
  }
  /** bitXor:  bitAnd ("^" bitAnd)*  */
  parseBitXor() {
    let left = this.parseBitAnd();
    while (this.lexer.peek().type === TokenType.Caret) {
      this.lexer.next();
      const right = this.parseBitAnd();
      left = { type: "BinaryExpr", op: "^", left, right, pos: left.pos };
    }
    return left;
  }
  /** bitAnd:  comparison ("&" comparison)*  */
  parseBitAnd() {
    let left = this.parseComparison();
    while (this.lexer.peek().type === TokenType.Amp) {
      this.lexer.next();
      const right = this.parseComparison();
      left = { type: "BinaryExpr", op: "&", left, right, pos: left.pos };
    }
    return left;
  }
  /**
   * comparison:  relational [ (==|!=|===|!==) relational ]
   * Non-chainable. Lower precedence than relational (<, <=, >, >=, in) to match JS.
   */
  parseComparison() {
    const left = this.parseRelational();
    const op = this.peekEqualityOp();
    if (!op) return left;
    this.lexer.next();
    const right = this.parseRelational();
    return { type: "BinaryExpr", op, left, right, pos: left.pos };
  }
  peekEqualityOp() {
    switch (this.lexer.peek().type) {
      case TokenType.EqEq:
        return "==";
      case TokenType.EqEqEq:
        return "===";
      case TokenType.BangEq:
        return "!=";
      case TokenType.BangEqEq:
        return "!==";
      default:
        return null;
    }
  }
  /**
   * relational:  additive [ (<|<=|>|>=|in) additive ]
   * Non-chainable. Higher precedence than equality to match JS.
   */
  parseRelational() {
    const left = this.parseAdditive();
    const op = this.peekRelationalOp();
    if (!op) return left;
    this.lexer.next();
    const right = this.parseAdditive();
    return { type: "BinaryExpr", op, left, right, pos: left.pos };
  }
  peekRelationalOp() {
    switch (this.lexer.peek().type) {
      case TokenType.Gt:
        return ">";
      case TokenType.GtEq:
        return ">=";
      case TokenType.Lt:
        return "<";
      case TokenType.LtEq:
        return "<=";
      case TokenType.In:
        return "in";
      default:
        return null;
    }
  }
  /** additive:  multiplicative ((+|-) multiplicative)*  */
  parseAdditive() {
    let left = this.parseMultiplicative();
    while (this.lexer.peek().type === TokenType.Plus || this.lexer.peek().type === TokenType.Minus) {
      const op = this.lexer.next().type === TokenType.Plus ? "+" : "-";
      const right = this.parseMultiplicative();
      left = { type: "BinaryExpr", op, left, right, pos: left.pos };
    }
    return left;
  }
  /** multiplicative:  power ((*|/|%) power)*  */
  parseMultiplicative() {
    let left = this.parsePower();
    for (; ; ) {
      const t = this.lexer.peek().type;
      let op = null;
      if (t === TokenType.Star) op = "*";
      else if (t === TokenType.Slash) op = "/";
      else if (t === TokenType.Percent) op = "%";
      if (!op) break;
      this.lexer.next();
      const right = this.parsePower();
      left = { type: "BinaryExpr", op, left, right, pos: left.pos };
    }
    return left;
  }
  /** power:  unary ("**" power)?  — right-associative  */
  parsePower() {
    const left = this.parseUnary();
    if (this.lexer.peek().type !== TokenType.StarStar) return left;
    this.lexer.next();
    const right = this.parsePower();
    return { type: "BinaryExpr", op: "**", left, right, pos: left.pos };
  }
  /** unary:  typeof | ("!"|"-"|"~") unary  |  postfix  */
  parseUnary() {
    const t = this.lexer.peek();
    if (t.type === TokenType.Typeof) {
      this.lexer.next();
      const operand = this.parseUnary();
      return { type: "TypeofExpr", operand, pos: t.pos };
    }
    if (t.type === TokenType.Bang) {
      this.lexer.next();
      const operand = this.parseUnary();
      return { type: "UnaryExpr", op: "!", operand, pos: t.pos };
    }
    if (t.type === TokenType.Minus) {
      this.lexer.next();
      const operand = this.parseUnary();
      return { type: "UnaryExpr", op: "-", operand, pos: t.pos };
    }
    if (t.type === TokenType.Tilde) {
      this.lexer.next();
      const operand = this.parseUnary();
      return { type: "UnaryExpr", op: "~", operand, pos: t.pos };
    }
    return this.parsePostfix();
  }
  /**
   * postfix:  primary ( "[" expression "]" | "." member | "?." member | "?.[" expression "]" )*
   *
   * Optional chaining (`?.`) produces the same AST node shape as the non-optional
   * counterpart, but with `optional: true`. The codegen consults this flag at every
   * null-unsafe consumer site (array spread, array/string method receivers, string
   * `$concat`, template-literal interpolations, `.length`, `Object.keys`/etc.) to
   * wrap the chain's result with `$ifNull(v, neutral)`, where `neutral` is `[]`
   * / `""` / `{}` depending on the consumer. See `chainHasOptional` /
   * `wrapIfNull` in src/codegen.ts and docs/specs/method-dispatch.md.
   */
  parsePostfix() {
    let left = this.parsePrimary();
    for (; ; ) {
      const t = this.lexer.peek().type;
      if (t === TokenType.LParen) {
        const args = this.parseMethodCallArgs();
        left = { type: "CallExpression", callee: left, args, pos: left.pos };
        continue;
      }
      if (t === TokenType.LBracket) {
        this.lexer.next();
        const index = this.parseExpression();
        const close = this.lexer.peek();
        if (close.type !== TokenType.RBracket) {
          throw new ParseError(`Expected ']' after index expression at position ${close.pos}`, close.pos);
        }
        this.lexer.next();
        left = { type: "IndexAccess", object: left, index, pos: left.pos };
      } else if (t === TokenType.Dot || t === TokenType.QuestDot) {
        const isOptional = t === TokenType.QuestDot;
        this.lexer.next();
        if (isOptional && this.lexer.peek().type === TokenType.LBracket) {
          this.lexer.next();
          const index = this.parseExpression();
          const close = this.lexer.peek();
          if (close.type !== TokenType.RBracket) {
            throw new ParseError(`Expected ']' after index expression at position ${close.pos}`, close.pos);
          }
          this.lexer.next();
          left = { type: "IndexAccess", object: left, index, pos: left.pos, optional: true };
          continue;
        }
        const member = this.lexer.peek();
        if (!this.isIdentOrKeyword(member)) {
          throw new ParseError(`Expected property name after '.' at position ${member.pos}`, member.pos);
        }
        this.lexer.next();
        if (this.lexer.peek().type === TokenType.LParen) {
          const blockKind = STREAM_BLOCK_METHODS.has(member.value) && isStreamRooted(left) ? "pipeline" : "expr";
          const args = this.parseMethodCallArgs(blockKind);
          left = {
            type: "MethodCall",
            object: left,
            method: member.value,
            args,
            pos: left.pos,
            ...isOptional && { optional: true }
          };
        } else {
          left = {
            type: "MemberAccess",
            object: left,
            member: member.value,
            pos: left.pos,
            ...isOptional && { optional: true }
          };
        }
      } else {
        break;
      }
    }
    return left;
  }
  /**
   * Parse a (possibly empty) comma-separated list terminated by `close`,
   * allowing an optional trailing comma (`f(a, b,)` — valid JS). The opening
   * delimiter must already be consumed; `close` is left unconsumed for the
   * caller to `expect`. Each item is produced by `parseItem`. Used by every
   * argument / parameter list whose items are uniform; the operator-call and
   * `Array.from` paths parse their first argument specially and reach for
   * `parseCommaTail` / `consumeTrailingComma` instead.
   */
  parseDelimitedList(close, parseItem) {
    if (this.lexer.peek().type === close) return [];
    const items = [parseItem()];
    this.parseCommaTail(items, close, parseItem);
    return items;
  }
  /**
   * Consume a `,`-separated tail, appending each item to `items`. A trailing
   * comma (one immediately followed by `close`) ends the list without parsing
   * another item, matching JS. Stops at the first non-`,` token, leaving it for
   * the caller.
   */
  parseCommaTail(items, close, parseItem) {
    while (this.lexer.peek().type === TokenType.Comma) {
      this.lexer.next();
      if (this.lexer.peek().type === close) break;
      items.push(parseItem());
    }
  }
  /**
   * Consume a lone trailing comma — a `,` immediately followed by `close` — so
   * fixed-arity built-in calls (`Number(x,)`, `Array.isArray(x,)`) accept the
   * JS trailing comma. No-op when the `,` is followed by anything else, so a
   * genuine extra argument still surfaces the call's own arity error.
   */
  consumeTrailingComma(close) {
    if (this.lexer.peek().type === TokenType.Comma && this.lexer.lookahead(1).type === close) {
      this.lexer.next();
    }
  }
  /** Parse method call argument list: "(" [argOrLambda ("," argOrLambda)* ","?] ")" */
  parseMethodCallArgs(blockKind = "expr") {
    this.lexer.expect(TokenType.LParen);
    const args = this.parseDelimitedList(TokenType.RParen, () => this.parseCallArg(blockKind));
    this.lexer.expect(TokenType.RParen);
    return args;
  }
  /**
   * Parse one argument in a call site. Allows:
   *   - ...expr (spread)
   *   - lambda forms (x => ..., (x) => ..., (x, y) => ...)
   *   - any expression
   */
  parseCallArg(blockKind = "expr") {
    if (this.lexer.peek().type === TokenType.Spread) {
      const spreadTok = this.lexer.next();
      const argument = this.parseExpression();
      const spread = { type: "SpreadElement", argument, pos: spreadTok.pos };
      return spread;
    }
    return this.parseArgOrLambda(blockKind);
  }
  /**
   * Parse an argument that might be a lambda expression.
   * Checks for lambda patterns before falling back to parseExpression().
   * `blockKind` selects what a `=> { … }` body means: `"pipeline"` (only inside
   * `$$$.<coll>.find/filter(...)` and `$$.filter(...)`) parses a statement block
   * → `Pipeline`; `"expr"` (the default everywhere else) parses an
   * expression-block → `ExprBlock`. JS-faithful: `=> {` always opens a block;
   * an object return needs `=> ({ … })`.
   */
  parseArgOrLambda(blockKind = "expr") {
    if (this.lexer.peek().type === TokenType.Ident && this.lexer.lookahead(1).type === TokenType.Arrow) {
      return this.parseLambdaUnparen(blockKind);
    }
    if (this.isLambdaStart()) {
      return this.parseLambdaParen(blockKind);
    }
    return this.parseExpression();
  }
  /** primary:  operator_call | field_ref | literals | "(" expr ")" | array | object  */
  parsePrimary() {
    const t = this.lexer.peek();
    switch (t.type) {
      case TokenType.Dollar:
        if (this.isIdentOrKeyword(this.lexer.lookahead(1))) return this.parseOperatorCall();
        this.lexer.next();
        return { type: "FieldRef", path: "", pos: t.pos };
      case TokenType.DollarDot:
        return this.parseFieldRef();
      case TokenType.DoubleDollar:
        return this.parseContextRef("CollectionRef", "$$");
      case TokenType.TripleDollar:
        return this.parseContextRef("DatabaseRef", "$$$");
      case TokenType.QuadDollar:
        return this.parseContextRef("ClusterRef", "$$$$");
      case TokenType.Number:
        return this.parseNumber();
      case TokenType.BigInt:
        this.lexer.next();
        return { type: "BigIntLiteral", value: t.value, pos: t.pos };
      case TokenType.String:
        this.lexer.next();
        return { type: "StringLiteral", value: t.value, pos: t.pos };
      case TokenType.True:
        this.lexer.next();
        return { type: "BooleanLiteral", value: true, pos: t.pos };
      case TokenType.False:
        this.lexer.next();
        return { type: "BooleanLiteral", value: false, pos: t.pos };
      case TokenType.Null:
        this.lexer.next();
        return { type: "NullLiteral", pos: t.pos };
      case TokenType.Undefined:
        this.lexer.next();
        return { type: "UndefinedLiteral", pos: t.pos };
      case TokenType.LBracket:
        return this.parseArrayLiteral();
      case TokenType.LBrace:
        return this.parseObjectLiteral();
      case TokenType.RegexLiteral:
        this.lexer.next();
        return { type: "RegexLiteral", pattern: t.value, flags: t.flags ?? "", pos: t.pos };
      case TokenType.TemplateStart:
        return this.parseTemplateLiteral();
      case TokenType.New:
        return this.parseNewDate();
      case TokenType.LParen:
        if (this.isLambdaStart()) return this.parseLambdaParen();
        return this.parseGrouped();
      case TokenType.Ident: {
        const name = t.value;
        if (name === "function") return this.parseFunctionExpr(
          /* requireName */
          false
        ).lambda;
        if (name === "async" && this.lexer.lookahead(1).type === TokenType.Ident && this.lexer.lookahead(1).value === "function") {
          throw new ParseError(
            `jsmql does not support async functions. Use a synchronous \`function (\u2026) { return \u2026 }\` or an arrow.`,
            t.pos
          );
        }
        if (name === "Math") return this.parseMathReference();
        if (name === "Object") return this.parseObjectCall();
        if (name === "Date" && this.lexer.lookahead(1).type === TokenType.Dot) {
          return this.parseDateStatic();
        }
        if (name === "Array" && this.lexer.lookahead(1).type === TokenType.Dot) {
          return this.parseArrayStaticCall();
        }
        if (name === "Number" && this.lexer.lookahead(1).type === TokenType.Dot) {
          return this.parseNumberStaticCall();
        }
        if (name === "ObjectId" && this.lexer.lookahead(1).type === TokenType.LParen) {
          this.lexer.next();
          return this.finishObjectIdConstruction(t.pos);
        }
        if (TYPE_CAST_NAMES.has(name)) {
          if (this.lexer.lookahead(1).type === TokenType.LParen) return this.parseTypeCast();
          if (BARE_CAST_NAMES.has(name)) {
            this.lexer.next();
            return { type: "TypeCastRef", cast: name, pos: t.pos };
          }
          return this.parseTypeCast();
        }
        this.lexer.next();
        return { type: "ParamRef", name, pos: t.pos };
      }
      default:
        if (t.type === TokenType.EOF) {
          throw new ParseError(`Unexpected end of expression`, t.pos);
        }
        throw new ParseError(`Unexpected token '${t.value}' at position ${t.pos}`, t.pos);
    }
  }
  // ── Sub-parsers ───────────────────────────────────────────────────────────
  /** "(" expression ")"  — also handles `(x => expr)`, the unparen-single-param lambda */
  parseGrouped() {
    this.lexer.expect(TokenType.LParen);
    let expr;
    if (this.lexer.peek().type === TokenType.Ident && this.lexer.lookahead(1).type === TokenType.Arrow) {
      expr = this.parseLambdaUnparen();
    } else if (this.peekIncDecOp() !== null) {
      expr = this.parsePrefixIncDec();
    } else {
      expr = this.parseExpression();
      if (this.peekAssignOp() !== null) {
        this.validateUpdateTarget(expr);
        const chain = this.parseAssignmentChainFrom(expr);
        if (chain.length !== 1) {
          const tok = this.lexer.peek();
          throw new ParseError(
            `Chained assignment inside parentheses is not supported at position ${tok.pos}`,
            tok.pos
          );
        }
        expr = chain[0];
      } else if (this.peekIncDecOp() !== null) {
        const op = this.peekIncDecOp();
        this.lexer.next();
        this.validateUpdateTarget(expr);
        expr = this.makeIncDecUpdateOp(expr, op);
      }
    }
    const close = this.lexer.peek();
    if (close.type !== TokenType.RParen) {
      throw new ParseError(`Expected ')' at position ${close.pos}`, close.pos);
    }
    this.lexer.next();
    return expr;
  }
  parseOperatorCall() {
    const dollar = this.lexer.next();
    const nameTok = this.lexer.peek();
    if (!this.isIdentOrKeyword(nameTok)) {
      throw new ParseError(`Expected operator name after '$' at position ${dollar.pos}`, dollar.pos);
    }
    this.lexer.next();
    const name = `$${nameTok.value}`;
    this.lexer.expect(TokenType.LParen);
    const peek = this.lexer.peek();
    if (peek.type === TokenType.RParen) {
      this.lexer.next();
      return { type: "OperatorCall", name, style: "positional", args: [], pos: dollar.pos };
    }
    if (peek.type === TokenType.LBrace) {
      const obj2 = this.parseObjectLiteral();
      const after = this.lexer.peek();
      if (after.type === TokenType.RParen) {
        this.lexer.next();
        return { type: "OperatorCall", name, style: "object", args: [obj2], pos: dollar.pos };
      }
      if (after.type === TokenType.Comma && this.lexer.lookahead(1).type === TokenType.RParen) {
        this.lexer.next();
        this.lexer.next();
        return { type: "OperatorCall", name, style: "object", args: [obj2], pos: dollar.pos };
      }
      const args2 = [obj2];
      this.parseCommaTail(args2, TokenType.RParen, () => this.parseCallArg());
      this.lexer.expect(TokenType.RParen);
      return { type: "OperatorCall", name, style: "positional", args: args2, pos: dollar.pos };
    }
    const args = [this.parseCallArg()];
    this.parseCommaTail(args, TokenType.RParen, () => this.parseCallArg());
    this.lexer.expect(TokenType.RParen);
    return { type: "OperatorCall", name, style: "positional", args, pos: dollar.pos };
  }
  /** $.field — stops at first segment; postfix handles further dots */
  parseFieldRef() {
    const dollarDot = this.lexer.next();
    const first = this.lexer.peek();
    if (!this.isIdentOrKeyword(first)) {
      throw new ParseError(`Expected field name after '$.' at position ${dollarDot.pos}`, dollarDot.pos);
    }
    this.lexer.next();
    return { type: "FieldRef", path: first.value, pos: dollarDot.pos };
  }
  /**
   * Context-reference prefix: `$$` (collection), `$$$` (database), `$$$$` (cluster).
   * Returns a bare marker AST node; postfix `.name` (MemberAccess) and `[expr]`
   * (IndexAccess) compose via the standard primary-postfix loop.
   *
   * Sanity-guards that the next token is `.` or `[` so bare `$$$` / `$$$$`
   * (which are meaningless on their own) produce an actionable error rather
   * than a downstream surprise. `$$` (CollectionRef) is more permissive: it
   * is valid as the LHS of `$$ = <expr>` (the stream-level replacement) and
   * as the RHS of `$$$.coll = $$` (the no-op `$out` write of the current
   * stream), so for CollectionRef we accept anything that isn't an
   * identifier-like follower. The typo case `$$foo` (no separator, an Ident
   * next) is still rejected so the user sees the actionable
   * "Expected '.<name>' or '[<expr>]'" hint; codegen continues to gate bare
   * `$$` in unsupported positions via the CollectionRef branch.
   */
  parseContextRef(nodeType, displayPrefix) {
    const prefix = this.lexer.next();
    const next = this.lexer.peek();
    if (next.type !== TokenType.Dot && next.type !== TokenType.LBracket) {
      if (nodeType === "CollectionRef" && !this.isIdentOrKeyword(next)) {
        return { type: nodeType, pos: prefix.pos };
      }
      throw new ParseError(
        `Expected '.<name>' or '[<expr>]' after '${displayPrefix}' at position ${prefix.pos}`,
        prefix.pos
      );
    }
    return { type: nodeType, pos: prefix.pos };
  }
  /**
   * An identifier-like token — a regular `Ident` or one of the reserved-word
   * keywords (`in`, `new`, `typeof`) we accept in identifier position. Valid
   * after `.` (field-path segments, member names), after `$` (operator names),
   * and as a `$<key>` in object literals.
   */
  isIdentOrKeyword(t) {
    return t.type === TokenType.Ident || t.type === TokenType.In || t.type === TokenType.New || t.type === TokenType.Typeof || t.type === TokenType.Let || t.type === TokenType.Const || t.type === TokenType.Return;
  }
  /**
   * Non-consuming lookahead: is the current position the start of a parenthesized lambda?
   * Matches: "(" ")" "=>" | "(" Ident ")" "=>" | "(" Ident ("," Ident)* ","? ")" "=>"
   */
  isLambdaStart() {
    if (this.lexer.peek().type !== TokenType.LParen) return false;
    let offset = 1;
    if (this.lexer.lookahead(offset).type === TokenType.RParen) {
      return this.lexer.lookahead(offset + 1).type === TokenType.Arrow;
    }
    while (this.lexer.lookahead(offset).type === TokenType.Ident) {
      offset++;
      if (this.lexer.lookahead(offset).type === TokenType.RParen) {
        return this.lexer.lookahead(offset + 1).type === TokenType.Arrow;
      }
      if (this.lexer.lookahead(offset).type !== TokenType.Comma) return false;
      offset++;
      if (this.lexer.lookahead(offset).type === TokenType.RParen) {
        return this.lexer.lookahead(offset + 1).type === TokenType.Arrow;
      }
    }
    return false;
  }
  /** Parse "x => expr" — single unparenthesized parameter */
  parseLambdaUnparen(blockKind = "expr") {
    const paramTok = this.lexer.next();
    this.lexer.next();
    if (this.lexer.peek().type === TokenType.LBrace) {
      if (blockKind === "pipeline") {
        const { block, ret } = this.parseCallbackBlock();
        return { type: "Lambda", params: [paramTok.value], block, ret, pos: paramTok.pos };
      }
      const exprBlock = this.parseExprBlockBody();
      return { type: "Lambda", params: [paramTok.value], exprBlock, pos: paramTok.pos };
    }
    const body = this.parseExpression();
    return { type: "Lambda", params: [paramTok.value], body, pos: paramTok.pos };
  }
  /**
   * Parse `( Ident (, Ident)* )` or `()` — the bare-identifier parameter list
   * shared by arrow lambdas (`parseLambdaParen`) and `function` expressions
   * (`parseFunctionExpr`). Cursor must be at `(`; consumes through the closing
   * `)`. No defaults / rest / destructuring (same as arrows — an unsupported
   * shape surfaces the `expect(Ident)` error at the offending token).
   */
  parseParenParamNames() {
    this.lexer.expect(TokenType.LParen);
    const params = this.parseDelimitedList(TokenType.RParen, () => this.lexer.expect(TokenType.Ident).value);
    this.lexer.expect(TokenType.RParen);
    return params;
  }
  /** Parse "(x) => expr" or "(x, y) => expr" or "() => expr" */
  parseLambdaParen(blockKind = "expr") {
    const lparen = this.lexer.peek();
    const params = this.parseParenParamNames();
    this.lexer.expect(TokenType.Arrow);
    if (this.lexer.peek().type === TokenType.LBrace) {
      if (blockKind === "pipeline") {
        const { block, ret } = this.parseCallbackBlock();
        return { type: "Lambda", params, block, ret, pos: lparen.pos };
      }
      const exprBlock = this.parseExprBlockBody();
      return { type: "Lambda", params, exprBlock, pos: lparen.pos };
    }
    const body = this.parseExpression();
    return { type: "Lambda", params, body, pos: lparen.pos };
  }
  /**
   * Parse a `function` expression into the SAME `Lambda` node an arrow
   * produces — `function [name](params) { (const|let …;)* return <expr>; }`
   * becomes `{ type: "Lambda", params, exprBlock }`. A JS `function` body is
   * always a brace block, so it reuses `parseExprBlockBody` (the value-returning
   * `{ … return … }` grammar) verbatim; codegen then treats it exactly like a
   * block-body arrow.
   *
   * `requireName` is `true` at statement / array-element position (a declaration
   * needs a name, like JS); `false` in value position, where JS permits a named
   * function expression but the name is unreachable in MQL (no recursion), so
   * the returned `name` is simply ignored by value-position callers —
   * `.map(function scale(x){…})` ≡ the anonymous form. Returns the parsed name
   * (if any) alongside the `Lambda` so declaration callers can build a FuncDecl.
   */
  parseFunctionExpr(requireName) {
    const fnTok = this.lexer.next();
    if (this.lexer.peek().type === TokenType.Star) {
      throw new ParseError(
        `jsmql does not support generator functions (\`function*\`). Use a plain \`function (\u2026) { return \u2026 }\` or an arrow.`,
        this.lexer.peek().pos
      );
    }
    let name;
    if (this.lexer.peek().type === TokenType.Ident) {
      name = this.lexer.next().value;
    } else if (requireName) {
      const tok = this.lexer.peek();
      throw new ParseError(
        `Expected a function name after \`function\` at position ${tok.pos}, got ${formatActualToken(tok)}. A \`function\` declaration needs a name \u2014 write \`function foo(a) { return \u2026 }\`.`,
        tok.pos
      );
    }
    if (this.lexer.peek().type !== TokenType.LParen) {
      const tok = this.lexer.peek();
      throw new ParseError(
        `Expected '(' to start the parameter list of \`function${name ? ` ${name}` : ""}\` at position ${tok.pos}, got ${formatActualToken(tok)}.`,
        tok.pos
      );
    }
    const params = this.parseParenParamNames();
    if (this.lexer.peek().type !== TokenType.LBrace) {
      const tok = this.lexer.peek();
      throw new ParseError(
        `Expected '{' to start the body of \`function${name ? ` ${name}` : ""}(\u2026)\` at position ${tok.pos}, got ${formatActualToken(tok)}. A \`function\` body is a block ending in \`return <expr>\`.`,
        tok.pos
      );
    }
    const exprBlock = this.parseExprBlockBody();
    const lambda = exprBlock.decls.length === 0 ? { type: "Lambda", params, body: exprBlock.ret, pos: fnTok.pos } : { type: "Lambda", params, exprBlock, pos: fnTok.pos };
    return { name, lambda };
  }
  /**
   * Parse a `function <name>(params) { … }` DECLARATION at a pipeline-statement
   * or array-element position, forking into a reusable `FuncDecl` (the same node
   * `const <name> = (params) => …` produces). `form: "function"` marks it
   * self-terminating (see `FuncDecl` in ast.ts). Mirrors `parseDeclStatement`.
   */
  parseFunctionDeclStatement() {
    const { name, lambda } = this.parseFunctionExpr(
      /* requireName */
      true
    );
    return { type: "FuncDecl", name, lambda, kind: "const", form: "function", pos: lambda.pos };
  }
  /**
   * Parse the block-body of a callback lambda: `{ stmt; stmt; …; [return <expr>;] }`.
   * The statements reuse the same machinery as the top-level `;`-separated
   * pipeline form — every statement is a stage call, an update op (`$.x = …`,
   * `delete $.x`), a `let`/`const` binding, an `assert(...)`, etc. — and the
   * block MAY end with a single `return <expr>` (which a reshaping array method
   * like `.map` lowers to `$replaceWith`; `.filter` has none). Returns the
   * statements as a `Pipeline` plus the optional `ret`. Only callable when the
   * callback `allowBlockBody` flag is set — outside that, `=> {` keeps its
   * existing object-literal / expr-block interpretation.
   */
  parseCallbackBlock() {
    const openBrace = this.lexer.next();
    const stmts = [];
    let ret;
    while (this.lexer.peek().type !== TokenType.RBrace) {
      if (this.lexer.peek().type === TokenType.Return) {
        this.lexer.next();
        ret = this.parseExpression();
        if (this.lexer.peek().type === TokenType.Semi) this.lexer.next();
        break;
      }
      const stmt = this.collectStatement();
      stmts.push(stmt);
      if (this.lexer.peek().type === TokenType.Semi) {
        this.lexer.next();
        continue;
      }
      if (this.selfTerminates(stmt) && this.lexer.peek().type !== TokenType.RBrace) continue;
      break;
    }
    if (stmts.length === 0 && ret === void 0) {
      throw new ParseError(
        `Expected at least one statement (or a \`return <expr>\`) inside the callback's block body at position ${openBrace.pos}`,
        openBrace.pos
      );
    }
    const closeTok = this.lexer.peek();
    if (closeTok.type !== TokenType.RBrace) {
      throw new ParseError(`Expected '}' to close the callback's block body at position ${closeTok.pos}`, closeTok.pos);
    }
    this.lexer.next();
    return { block: { type: "Pipeline", stmts, pos: openBrace.pos }, ret };
  }
  /**
   * Parse the expression-block body of an arrow:
   * `{ (const|let <name> = <expr>;)* return <expr>; }`. Codegen lowers it to a
   * right-folded nest of `$let`. This is the JS-faithful meaning of `=> { … }`
   * everywhere outside the lookup-callback positions (which use
   * `parseCallbackBlock`); an object return must be written `=> ({ … })`.
   * See docs/specs/method-dispatch.md.
   */
  parseExprBlockBody() {
    const open = this.lexer.next();
    const decls = [];
    while (this.lexer.peek().type === TokenType.Let || this.lexer.peek().type === TokenType.Const) {
      const decl = this.parseLetDecl();
      if (decl.value.type === "Lambda") {
        throw new ParseError(
          `Reusable functions must be declared at the top level of a pipeline, not inside an arrow body. Move \`${decl.kind} ${decl.name} = (\u2026) => \u2026\` out of the \`=> { \u2026 }\` block.`,
          decl.pos
        );
      }
      decls.push(decl);
      const semi = this.lexer.peek();
      if (semi.type !== TokenType.Semi) {
        throw new ParseError(
          `Expected ';' after the \`${decl.kind} ${decl.name}\` declaration at position ${semi.pos}, got ${formatActualToken(semi)}. Each declaration in a block-body arrow ends with ';', and the block ends with a single \`return\`.`,
          semi.pos
        );
      }
      this.lexer.next();
    }
    const ret = this.lexer.peek();
    if (ret.type !== TokenType.Return) {
      throw new ParseError(
        `A block body must end with a \`return <expr>\` statement at position ${ret.pos}, got ${formatActualToken(ret)}. Write \`x => { const a = \u2026; return <expr>; }\` / \`function f(x) { return <expr>; }\`, or \`x => (<expr>)\` to return an object/expression directly.`,
        ret.pos
      );
    }
    this.lexer.next();
    const retExpr = this.parseExpression();
    if (this.lexer.peek().type === TokenType.Semi) this.lexer.next();
    const close = this.lexer.peek();
    if (close.type !== TokenType.RBrace) {
      throw new ParseError(
        `Expected '}' to close the block-body arrow at position ${close.pos}, got ${formatActualToken(close)}. Only \`const\`/\`let\` declarations may precede the single \`return\`.`,
        close.pos
      );
    }
    this.lexer.next();
    return { type: "ExprBlock", decls, ret: retExpr, pos: open.pos };
  }
  /** "new Date()" / "new Date(expr)" or "new Set()" / "new Set(expr)" */
  parseNewDate() {
    const newTok = this.lexer.next();
    const className = this.lexer.peek();
    if (className.type !== TokenType.Ident) {
      throw new ParseError(`Expected class name after 'new' at position ${newTok.pos}`, newTok.pos);
    }
    if (className.value === "ObjectId") {
      this.lexer.next();
      return this.finishObjectIdConstruction(newTok.pos);
    }
    if (className.value !== "Date" && className.value !== "Set") {
      throw new ParseError(
        `Unsupported 'new ${className.value}' at position ${className.pos}. Supported: new Date(), new Set(), new ObjectId()`,
        className.pos
      );
    }
    const cls = className.value;
    this.lexer.next();
    this.lexer.expect(TokenType.LParen);
    if (this.lexer.peek().type === TokenType.RParen) {
      this.lexer.next();
      return cls === "Date" ? { type: "NewDate", args: [], pos: newTok.pos } : { type: "NewSet", arg: null, pos: newTok.pos };
    }
    const args = [this.parseExpression()];
    this.parseCommaTail(args, TokenType.RParen, () => this.parseExpression());
    this.lexer.expect(TokenType.RParen);
    if (cls === "Set") {
      if (args.length > 1) {
        throw new ParseError(
          `'new Set(...)' takes 0 or 1 arguments, got ${args.length} at position ${newTok.pos}`,
          newTok.pos
        );
      }
      return { type: "NewSet", arg: args[0], pos: newTok.pos };
    }
    if (args.length > 7) {
      throw new ParseError(
        `'new Date(year, month, day, hour, minute, second, ms)' takes at most 7 arguments, got ${args.length} at position ${newTok.pos}`,
        newTok.pos
      );
    }
    return { type: "NewDate", args, pos: newTok.pos };
  }
  /**
   * Finish parsing an `ObjectId(...)` construction (also reached via
   * `new ObjectId(...)`). The caller has consumed the `ObjectId` identifier;
   * `pos` is the leading token (`new` or `ObjectId`). Three shapes:
   *   - `ObjectId()`               → `$createObjectId()` (server-side fresh id)
   *   - `ObjectId("<24 hex>")`     → a constant ObjectId minted at compile time
   *   - `ObjectId(<anything else>)`→ `$toObjectId(arg)` (server-side conversion)
   * A constant string that is NOT 24 hex chars is a typo we can catch now, so it
   * throws rather than deferring a guaranteed runtime failure to the server.
   */
  finishObjectIdConstruction(pos) {
    this.lexer.expect(TokenType.LParen);
    if (this.lexer.peek().type === TokenType.RParen) {
      this.lexer.next();
      return { type: "OperatorCall", name: "$createObjectId", style: "positional", args: [], pos };
    }
    const arg = this.parseExpression();
    this.consumeTrailingComma(TokenType.RParen);
    this.lexer.expect(TokenType.RParen);
    if (arg.type === "StringLiteral") {
      const hex = arg.value;
      if (!/^[0-9a-fA-F]{24}$/.test(hex)) {
        const detail = hex.length === 24 ? `it contains non-hexadecimal characters` : `got ${hex.length} character${hex.length === 1 ? "" : "s"}`;
        throw new ParseError(
          `ObjectId("${hex}") is not a valid ObjectId: expected exactly 24 hexadecimal characters, ${detail}, at position ${arg.pos}.`,
          arg.pos
        );
      }
      assertPlausibleObjectId(hex, arg.pos);
      return { type: "ObjectIdLiteral", hex, pos };
    }
    return { type: "OperatorCall", name: "$toObjectId", style: "positional", args: [arg], pos };
  }
  /** "Date.now()" or "Date.UTC(year, month, day, …)" — other Date.* members are not supported */
  parseDateStatic() {
    const dateTok = this.lexer.next();
    this.lexer.expect(TokenType.Dot);
    const methodTok = this.lexer.peek();
    if (methodTok.type !== TokenType.Ident) {
      throw new ParseError(`Expected Date method name at position ${methodTok.pos}`, methodTok.pos);
    }
    if (methodTok.value === "now") {
      this.lexer.next();
      this.lexer.expect(TokenType.LParen);
      this.lexer.expect(TokenType.RParen);
      return { type: "DateNow", pos: dateTok.pos };
    }
    if (methodTok.value === "UTC") {
      this.lexer.next();
      this.lexer.expect(TokenType.LParen);
      const args = this.parseDelimitedList(TokenType.RParen, () => this.parseExpression());
      this.lexer.expect(TokenType.RParen);
      if (args.length < 1 || args.length > 7) {
        throw new ParseError(
          `Date.UTC(year[, month, day, hour, minute, second, ms]) takes 1 to 7 arguments, got ${args.length} at position ${dateTok.pos}`,
          dateTok.pos
        );
      }
      return { type: "DateUTC", args, pos: dateTok.pos };
    }
    throw new ParseError(
      `Unknown Date method '${methodTok.value}' at position ${methodTok.pos}. Only Date.now() and Date.UTC(\u2026) are supported as JS-style calls; for other date operations use the $date* operators directly (e.g. $dateAdd, $dateDiff, $dateTrunc, $dateToString).`,
      dateTok.pos
    );
  }
  /** "Array.isArray(x)" or "Array.from(input)" or "Array.from(input, mapFn)" */
  parseArrayStaticCall() {
    const arrayTok = this.lexer.next();
    this.lexer.expect(TokenType.Dot);
    const methodTok = this.lexer.peek();
    if (methodTok.type !== TokenType.Ident) {
      throw new ParseError(`Expected Array method name at position ${methodTok.pos}`, arrayTok.pos);
    }
    if (methodTok.value === "isArray") {
      this.lexer.next();
      this.lexer.expect(TokenType.LParen);
      const arg = this.parseExpression();
      this.consumeTrailingComma(TokenType.RParen);
      this.lexer.expect(TokenType.RParen);
      return { type: "OperatorCall", name: "$isArray", style: "positional", args: [arg], pos: arrayTok.pos };
    }
    if (methodTok.value === "from") {
      this.lexer.next();
      this.lexer.expect(TokenType.LParen);
      const input = this.parseExpression();
      let mapFn = null;
      if (this.lexer.peek().type === TokenType.Comma) {
        this.lexer.next();
        if (this.lexer.peek().type !== TokenType.RParen) {
          mapFn = this.parseArgOrLambda();
          this.consumeTrailingComma(TokenType.RParen);
        }
      }
      this.lexer.expect(TokenType.RParen);
      return { type: "ArrayFrom", input, mapFn, pos: arrayTok.pos };
    }
    const arrayHint = didYouMean(methodTok.value, ["isArray", "from"], (s) => `Array.${s}`);
    throw new ParseError(
      `Unknown Array method '${methodTok.value}' at position ${methodTok.pos}.${arrayHint} Supported: Array.isArray(), Array.from().`,
      arrayTok.pos
    );
  }
  /** "Number.isInteger(x)" / "Number.isNaN(x)" / "Number.isFinite(x)" */
  parseNumberStaticCall() {
    const numberTok = this.lexer.next();
    this.lexer.expect(TokenType.Dot);
    const methodTok = this.lexer.peek();
    if (methodTok.type !== TokenType.Ident || !NUMBER_STATICS.includes(methodTok.value)) {
      const numberHint = didYouMean(methodTok.value, NUMBER_STATICS, (s) => `Number.${s}`);
      throw new ParseError(
        `Unknown Number static method '${methodTok.value}' at position ${methodTok.pos}.${numberHint} Supported: ${NUMBER_STATICS.map((s) => `Number.${s}`).join(", ")}.`,
        numberTok.pos
      );
    }
    const method = methodTok.value;
    this.lexer.next();
    this.lexer.expect(TokenType.LParen);
    const arg = this.parseExpression();
    this.consumeTrailingComma(TokenType.RParen);
    this.lexer.expect(TokenType.RParen);
    return { type: "NumberStatic", method, arg, pos: numberTok.pos };
  }
  /** "Math.method(args)" or "Math.PI" / "Math.E" constants */
  parseMathReference() {
    const mathTok = this.lexer.next();
    this.lexer.expect(TokenType.Dot);
    const ident = this.lexer.peek();
    if (ident.type !== TokenType.Ident) {
      throw new ParseError(`Expected Math member name at position ${ident.pos}`, mathTok.pos);
    }
    if (MATH_CONSTANTS2.has(ident.value)) {
      this.lexer.next();
      return { type: "MathConst", name: ident.value, pos: mathTok.pos };
    }
    if (!MATH_METHODS2.has(ident.value)) {
      const hint = didYouMean(ident.value, [...MATH_METHODS2, ...MATH_CONSTANTS2], (s) => `Math.${s}`);
      throw new ParseError(
        `Unknown Math member '${ident.value}' at position ${ident.pos}.${hint} See docs/LANGUAGE.md for the full list of supported Math methods and constants.`,
        mathTok.pos
      );
    }
    this.lexer.next();
    const method = ident.value;
    if (this.lexer.peek().type !== TokenType.LParen) {
      if (!UNARY_MATH_CALLABLES.has(method)) {
        throw new ParseError(
          `Math.${method} requires '(...)'. Only the unary Math methods (Math.floor / .ceil / .round / .abs / \u2026) can be passed as bare callbacks (e.g. \`arr.map(Math.floor)\`).`,
          mathTok.pos
        );
      }
      return { type: "MathCallRef", method, pos: mathTok.pos };
    }
    this.lexer.expect(TokenType.LParen);
    const args = this.parseDelimitedList(TokenType.RParen, () => this.parseCallArg());
    this.lexer.expect(TokenType.RParen);
    return { type: "MathCall", method, args, pos: mathTok.pos };
  }
  /** "Object.method(args)" */
  parseObjectCall() {
    const objectTok = this.lexer.next();
    this.lexer.expect(TokenType.Dot);
    const methodTok = this.lexer.peek();
    if (methodTok.type !== TokenType.Ident || !OBJECT_METHODS2.has(methodTok.value)) {
      const objectHint = didYouMean(methodTok.value, [...OBJECT_METHODS2], (s) => `Object.${s}`);
      throw new ParseError(
        `Unknown Object method '${methodTok.value}' at position ${methodTok.pos}.${objectHint} Supported: ${[...OBJECT_METHODS2].join(", ")}.`,
        objectTok.pos
      );
    }
    this.lexer.next();
    const method = methodTok.value;
    this.lexer.expect(TokenType.LParen);
    const args = this.parseDelimitedList(TokenType.RParen, () => this.parseCallArg());
    this.lexer.expect(TokenType.RParen);
    return { type: "ObjectCall", method, args, pos: objectTok.pos };
  }
  /** "Number(x)" | "String(x)" | "Boolean(x)" | "parseInt(x)" | "parseFloat(x)" */
  parseTypeCast() {
    const castTok = this.lexer.next();
    const cast = castTok.value;
    this.lexer.expect(TokenType.LParen);
    const arg = this.parseExpression();
    if (this.lexer.peek().type === TokenType.Comma) {
      this.lexer.next();
      if (this.lexer.peek().type !== TokenType.RParen) {
        throw new ParseError(`Type cast '${cast}()' takes exactly 1 argument at position ${castTok.pos}`, castTok.pos);
      }
    }
    this.lexer.expect(TokenType.RParen);
    return { type: "TypeCast", cast, arg, pos: castTok.pos };
  }
  parseNumber() {
    const t = this.lexer.next();
    if (t.value[0] === "0" && (t.value[1] === "x" || t.value[1] === "X")) {
      return this.classifyHexLiteral(t.value, t.pos);
    }
    const value = parseFloat(t.value);
    if (isNaN(value)) {
      throw new ParseError(`Invalid number '${t.value}' at position ${t.pos}`, t.pos);
    }
    return { type: "NumberLiteral", value, pos: t.pos };
  }
  /**
   * Classify a `0x…` hex literal (lexeme incl. prefix, underscores already
   * stripped). Exactly 24 hex digits → a constant ObjectId — the "type `0x`,
   * paste a 24-char _id" form. Otherwise it's an integer literal, accepted only
   * when it fits a JS double's exact-integer range; a larger non-24-digit hex
   * would silently lose precision (and is neither an ObjectId nor representable),
   * so it's rejected with guidance rather than emitted wrong.
   */
  classifyHexLiteral(lexeme, pos) {
    const hex = lexeme.slice(2);
    if (hex.length === 24) {
      assertPlausibleObjectId(hex, pos);
      return { type: "ObjectIdLiteral", hex, pos };
    }
    const big = BigInt(lexeme);
    if (big <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return { type: "NumberLiteral", value: Number(big), pos };
    }
    throw new ParseError(
      `Hex literal '${lexeme}' at position ${pos} has ${hex.length} digits \u2014 neither a 24-character ObjectId nor an integer that fits Number.MAX_SAFE_INTEGER. Paste a 24-character hex string for an ObjectId, or use a decimal literal.`,
      pos
    );
  }
  /** Parse a template literal: `chunk0${expr0}chunk1${expr1}chunk2` */
  parseTemplateLiteral() {
    const startTok = this.lexer.expect(TokenType.TemplateStart);
    const quasis = [];
    const expressions = [];
    for (; ; ) {
      const chunk2 = this.lexer.expect(TokenType.TemplateChars);
      quasis.push(chunk2.value);
      const next = this.lexer.peek();
      if (next.type === TokenType.TemplateEnd) {
        this.lexer.next();
        break;
      }
      if (next.type === TokenType.TemplateExprStart) {
        this.lexer.next();
        const expr = this.parseExpression();
        expressions.push(expr);
        continue;
      }
      throw new ParseError(`Unexpected token in template literal at position ${next.pos}`, next.pos);
    }
    return { type: "TemplateLiteral", quasis, expressions, pos: startTok.pos };
  }
  parseArrayLiteral() {
    const openBracket = this.lexer.expect(TokenType.LBracket);
    const elements = [];
    while (this.lexer.peek().type !== TokenType.RBracket) {
      if (this.lexer.peek().type === TokenType.EOF) {
        throw new ParseError("Unterminated array literal", this.lexer.peek().pos);
      }
      if (this.lexer.peek().type === TokenType.Spread) {
        const spreadTok = this.lexer.next();
        const arg = this.parseExpression();
        const spread = { type: "SpreadElement", argument: arg, pos: spreadTok.pos };
        elements.push(spread);
      } else if (this.lexer.peek().type === TokenType.Delete) {
        elements.push(this.parseDeleteStmt());
      } else if (this.lexer.peek().type === TokenType.Let || this.lexer.peek().type === TokenType.Const) {
        elements.push(this.parseDeclStatement());
      } else if (this.lexer.peek().type === TokenType.Ident && this.lexer.peek().value === "function") {
        elements.push(this.parseFunctionDeclStatement());
      } else if (this.peekIncDecOp() !== null) {
        elements.push(this.parsePrefixIncDec());
      } else {
        const expr = this.parseExpression();
        if (this.peekAssignOp() !== null) {
          this.validateUpdateTarget(expr);
          for (const m of this.parseAssignmentChainFrom(expr)) elements.push(m);
        } else if (this.peekIncDecOp() !== null) {
          const op = this.peekIncDecOp();
          this.lexer.next();
          this.validateUpdateTarget(expr);
          elements.push(this.makeIncDecUpdateOp(expr, op));
        } else {
          elements.push(expr);
        }
      }
      if (this.lexer.peek().type === TokenType.Comma) {
        this.lexer.next();
      } else {
        break;
      }
    }
    this.lexer.expect(TokenType.RBracket);
    return { type: "ArrayLiteral", elements, pos: openBracket.pos };
  }
  parseObjectLiteral() {
    const openBrace = this.lexer.expect(TokenType.LBrace);
    const entries = [];
    while (this.lexer.peek().type !== TokenType.RBrace) {
      if (this.lexer.peek().type === TokenType.EOF) {
        throw new ParseError("Unterminated object literal", this.lexer.peek().pos);
      }
      if (this.lexer.peek().type === TokenType.Spread) {
        const spreadTok = this.lexer.next();
        const arg = this.parseExpression();
        const spread = { type: "SpreadElement", argument: arg, pos: spreadTok.pos };
        entries.push(spread);
      } else {
        entries.push(this.parseObjectEntry());
      }
      if (this.lexer.peek().type === TokenType.Comma) {
        this.lexer.next();
      } else {
        break;
      }
    }
    this.lexer.expect(TokenType.RBrace);
    return { type: "ObjectLiteral", entries, pos: openBrace.pos };
  }
  /**
   * Parse one non-spread object entry. Supports:
   *   - Static key:    `name: expr`  or  `"name": expr`
   *   - Computed key:  `[expr]: expr`
   *   - Shorthand:     `name`  (sugar for `name: name`, valid in lambda scope)
   */
  parseObjectEntry() {
    const tok = this.lexer.peek();
    if (tok.type === TokenType.LBracket) {
      this.lexer.next();
      const keyExpr2 = this.parseExpression();
      this.lexer.expect(TokenType.RBracket);
      this.lexer.expect(TokenType.Colon);
      const value2 = this.parseExpression();
      const key2 = { kind: "computed", expr: keyExpr2 };
      return { type: "KeyValueEntry", key: key2, value: value2, pos: tok.pos };
    }
    if (tok.type === TokenType.Dollar) {
      this.lexer.next();
      const ident = this.lexer.peek();
      if (!this.isIdentOrKeyword(ident)) {
        throw new ParseError(`Expected identifier after '$' at position ${tok.pos}`, tok.pos);
      }
      this.lexer.next();
      this.lexer.expect(TokenType.Colon);
      const value2 = this.parseExpression();
      const key2 = { kind: "static", name: `$${ident.value}` };
      return { type: "KeyValueEntry", key: key2, value: value2, pos: tok.pos };
    }
    if (tok.type === TokenType.Let || tok.type === TokenType.Const) {
      this.lexer.next();
      this.lexer.expect(TokenType.Colon);
      const value2 = this.parseExpression();
      const key2 = { kind: "static", name: tok.value };
      return { type: "KeyValueEntry", key: key2, value: value2, pos: tok.pos };
    }
    if (tok.type !== TokenType.Ident && tok.type !== TokenType.String) {
      throw new ParseError(
        `Expected an object key, but found ${formatActualToken(tok)} at position ${tok.pos}. An object entry must be \`key: value\`, a shorthand \`key\`, or a spread \`...expr\`. To include fields conditionally, spread a ternary: \`{ ...base, ...(cond ? { \u2026 } : {}) }\`.`,
        tok.pos
      );
    }
    this.lexer.next();
    const next = this.lexer.peek();
    if (tok.type === TokenType.Ident && (next.type === TokenType.Comma || next.type === TokenType.RBrace)) {
      const key2 = { kind: "static", name: tok.value };
      const value2 = { type: "ParamRef", name: tok.value, pos: tok.pos };
      return { type: "KeyValueEntry", key: key2, value: value2, pos: tok.pos };
    }
    this.lexer.expect(TokenType.Colon);
    const value = this.parseExpression();
    const key = { kind: "static", name: tok.value };
    return { type: "KeyValueEntry", key, value, pos: tok.pos };
  }
};
var STREAM_BLOCK_METHODS = /* @__PURE__ */ new Set(["find", "filter", "map", "aggregate"]);
function isStreamRooted(expr) {
  let node = expr;
  for (; ; ) {
    if (node.type === "DatabaseRef" || node.type === "ClusterRef" || node.type === "CollectionRef") return true;
    if (node.type === "MemberAccess" || node.type === "IndexAccess" || node.type === "MethodCall") {
      node = node.object;
      continue;
    }
    return false;
  }
}
function describeUpdateTarget(target) {
  switch (target.type) {
    case "MethodCall":
      return `a method-call result ('.${target.method}()')`;
    case "CallExpression":
      return "a call result";
    case "BinaryExpr":
      return `a '${target.op}' expression`;
    case "UnaryExpr":
      return `a unary '${target.op}' expression`;
    case "TernaryExpr":
      return "a ternary expression";
    case "TypeCast":
      return `a '${target.cast}()' cast`;
    case "TypeCastRef":
      return `a bare '${target.cast}' reference`;
    case "MemberAccess":
      return "a member access whose root is not a field path";
    case "Lambda":
      return "a lambda expression";
    case "ArrayLiteral":
      return "an array literal";
    case "ObjectLiteral":
      return "an object literal";
    case "NumberLiteral":
    case "BigIntLiteral":
    case "StringLiteral":
    case "BooleanLiteral":
    case "NullLiteral":
      return "a literal value";
    case "TemplateLiteral":
      return "a template literal";
    case "OperatorCall":
      return `the result of ${target.name}(\u2026)`;
    case "MathCall":
      return `the result of Math.${target.method}(\u2026)`;
    case "MathCallRef":
      return `a bare 'Math.${target.method}' reference`;
    case "MathConst":
      return `the Math.${target.name} constant`;
    case "ObjectCall":
      return `the result of Object.${target.method}(\u2026)`;
    case "NewDate":
      return "a 'new Date(\u2026)' expression";
    case "NewSet":
      return "a 'new Set(\u2026)' expression";
    case "DateNow":
      return "the result of Date.now()";
    case "DateUTC":
      return "the result of Date.UTC(\u2026)";
    case "ArrayFrom":
      return "an Array.from(\u2026) result";
    case "NumberStatic":
      return `the result of Number.${target.method}(\u2026)`;
    case "TypeofExpr":
      return "a typeof expression";
    case "RegexLiteral":
      return "a regex literal";
    default:
      return "this expression";
  }
}

// src/operators.ts
var SINGLE = { kind: "single" };
var ARRAY = { kind: "array" };
var NONE = { kind: "none" };
var FLEX = { kind: "flex" };
function single(category, description) {
  return { shape: SINGLE, category, description };
}
function array(category, description) {
  return { shape: ARRAY, category, description };
}
function none(category, description) {
  return { shape: NONE, category, description };
}
function flex(category, description) {
  return { shape: FLEX, category, description };
}
function obj(category, description, ...keys) {
  return { shape: { kind: "object", keys }, category, description };
}
function acc(def) {
  return { ...def, accumulatorOnly: true };
}
function withArgs(def, rules) {
  return { ...def, args: rules };
}
var OPERATORS = {
  // ── Arithmetic ─────────────────────────────────────────────────────────────
  $abs: single("arithmetic", "Returns the absolute value of a number."),
  $add: array("arithmetic", "Adds numbers to return the sum, or adds numbers and a date to return a new date."),
  $ceil: single("arithmetic", "Returns the smallest integer greater than or equal to the specified number."),
  $divide: array("arithmetic", "Returns the result of dividing the first number by the second."),
  $exp: single("arithmetic", "Raises e to the specified exponent."),
  $floor: single("arithmetic", "Returns the largest integer less than or equal to the specified number."),
  $ln: single("arithmetic", "Calculates the natural log of a number."),
  $log: array("arithmetic", "Calculates the log of a number in the specified base."),
  $log10: single("arithmetic", "Calculates the log base 10 of a number."),
  $mod: array("arithmetic", "Returns the remainder of the first number divided by the second."),
  $multiply: array("arithmetic", "Multiplies numbers to return the product."),
  $pow: array("arithmetic", "Raises a number to the specified exponent."),
  $round: flex("arithmetic", "Rounds a number to a whole integer or to a specified decimal place."),
  $sigmoid: single(
    "arithmetic",
    "Returns the sigmoid of a value, defined as 1 / (1 + e^(-x)). The result is between 0 and 1."
  ),
  $sqrt: single("arithmetic", "Calculates the square root."),
  $subtract: array("arithmetic", "Returns the result of subtracting the second value from the first."),
  $trunc: flex("arithmetic", "Truncates a number to a whole integer or to a specified decimal place."),
  // ── Bitwise ────────────────────────────────────────────────────────────────
  $bitAnd: array("bitwise", "Returns the result of a bitwise AND operation on an array of int or long values."),
  $bitNot: single("bitwise", "Returns the result of a bitwise NOT operation on a single int or long value."),
  $bitOr: array("bitwise", "Returns the result of a bitwise OR operation on an array of int or long values."),
  $bitXor: array(
    "bitwise",
    "Returns the result of a bitwise XOR (exclusive or) operation on an array of int and long values."
  ),
  // ── Trigonometry ───────────────────────────────────────────────────────────
  $sin: single("trigonometry", "Returns the sine of a value that is measured in radians."),
  $cos: single("trigonometry", "Returns the cosine of a value that is measured in radians."),
  $tan: single("trigonometry", "Returns the tangent of a value that is measured in radians."),
  $asin: single("trigonometry", "Returns the inverse sine (arc sine) of a value in radians."),
  $acos: single("trigonometry", "Returns the inverse cosine (arc cosine) of a value in radians."),
  $atan: single("trigonometry", "Returns the inverse tangent (arc tangent) of a value in radians."),
  $atan2: array(
    "trigonometry",
    "Returns the inverse tangent of y / x in radians, where y and x are the first and second arguments."
  ),
  $sinh: single("trigonometry", "Returns the hyperbolic sine of a value measured in radians."),
  $cosh: single("trigonometry", "Returns the hyperbolic cosine of a value measured in radians."),
  $tanh: single("trigonometry", "Returns the hyperbolic tangent of a value measured in radians."),
  $asinh: single("trigonometry", "Returns the inverse hyperbolic sine of a value in radians."),
  $acosh: single("trigonometry", "Returns the inverse hyperbolic cosine of a value in radians."),
  $atanh: single("trigonometry", "Returns the inverse hyperbolic tangent of a value in radians."),
  $degreesToRadians: single("trigonometry", "Converts a value from degrees to radians."),
  $radiansToDegrees: single("trigonometry", "Converts a value from radians to degrees."),
  // ── Comparison ─────────────────────────────────────────────────────────────
  // $eq/$ne/$gt/$gte/$lt/$lte are `flex` (dual-form): a single value is the valid
  // *query* comparison `{ field: { $gt: v } }`; two args are the *aggregation*
  // operands `{ $gt: [a, b] }` (HR2). $cmp has no single-value form → `array`.
  $cmp: array("comparison", "Returns 0 if the two values are equivalent, 1 if the first is greater, and -1 if less."),
  $eq: flex("comparison", "Returns true if the values are equivalent."),
  $ne: flex("comparison", "Returns true if the values are not equivalent."),
  $gt: flex("comparison", "Returns true if the first value is greater than the second."),
  $gte: flex("comparison", "Returns true if the first value is greater than or equal to the second."),
  $lt: flex("comparison", "Returns true if the first value is less than the second."),
  $lte: flex("comparison", "Returns true if the first value is less than or equal to the second."),
  // ── Boolean ────────────────────────────────────────────────────────────────
  $and: array("boolean", "Returns true only when all its expressions evaluate to true."),
  $or: array("boolean", "Returns true when any of its expressions evaluates to true."),
  $not: single("boolean", "Returns the boolean value that is the opposite of its argument expression."),
  // ── Conditional ────────────────────────────────────────────────────────────
  $cond: obj(
    "conditional",
    "A ternary operator that evaluates one expression and returns one of two other expressions based on the result.",
    "if",
    "then",
    "else"
  ),
  $ifNull: array(
    "conditional",
    "Returns either the non-null result of the first expression or the result of the second expression."
  ),
  $switch: obj(
    "conditional",
    "Evaluates a series of case expressions; executes the matching case's expression and breaks out of the control flow.",
    "branches",
    "default"
  ),
  // ── String ─────────────────────────────────────────────────────────────────
  $concat: array("string", "Concatenates any number of strings."),
  $indexOfBytes: array(
    "string",
    "Searches a string for a substring and returns the UTF-8 byte index of the first occurrence, or -1."
  ),
  $indexOfCP: array(
    "string",
    "Searches a string for a substring and returns the UTF-8 code point index of the first occurrence, or -1."
  ),
  $ltrim: obj(
    "string",
    "Removes whitespace or the specified characters from the beginning of a string.",
    "input",
    "chars"
  ),
  $rtrim: obj("string", "Removes whitespace or the specified characters from the end of a string.", "input", "chars"),
  $trim: obj(
    "string",
    "Removes whitespace or the specified characters from the beginning and end of a string.",
    "input",
    "chars"
  ),
  $regexFind: obj(
    "string",
    "Applies a regular expression to a string and returns information on the first matched substring.",
    "input",
    "regex",
    "options"
  ),
  $regexFindAll: obj(
    "string",
    "Applies a regular expression to a string and returns information on all matched substrings.",
    "input",
    "regex",
    "options"
  ),
  $regexMatch: obj(
    "string",
    "Applies a regular expression to a string and returns a boolean indicating whether a match is found.",
    "input",
    "regex",
    "options"
  ),
  $replaceAll: obj(
    "string",
    "Replaces all instances of a search string in an input string with a replacement string.",
    "input",
    "find",
    "replacement"
  ),
  $replaceOne: obj(
    "string",
    "Replaces the first instance of a matched string in a given input.",
    "input",
    "find",
    "replacement"
  ),
  $split: array("string", "Splits a string into substrings based on a delimiter and returns an array of substrings."),
  $strLenBytes: single("string", "Returns the number of UTF-8 encoded bytes in a string."),
  $strLenCP: single("string", "Returns the number of UTF-8 code points in a string."),
  $strcasecmp: array("string", "Performs case-insensitive string comparison."),
  $substr: array("string", "Deprecated. Use $substrBytes or $substrCP."),
  $substrBytes: array("string", "Returns the substring of a string starting at the specified UTF-8 byte index."),
  $substrCP: array("string", "Returns the substring of a string starting at the specified UTF-8 code point index."),
  $toLower: single("string", "Converts a string to lowercase."),
  $toUpper: single("string", "Converts a string to uppercase."),
  // ── Encrypted String (Queryable Encryption) ───────────────────────────────
  // Not in mongodb/mql-specifications as of pinned commit; allowlisted in the
  // drift test. Shapes inferred from the MongoDB documentation.
  $encStrContains: obj(
    "encrypted-string",
    "Returns true if a substring exists within the encrypted string.",
    "input",
    "substring"
  ),
  $encStrEndsWith: obj(
    "encrypted-string",
    "Returns true if the encrypted string ends with the specified suffix.",
    "input",
    "suffix"
  ),
  $encStrNormalizedEq: obj(
    "encrypted-string",
    "Returns true if the normalized encrypted string equals the specified string.",
    "input",
    "string"
  ),
  $encStrStartsWith: obj(
    "encrypted-string",
    "Returns true if the encrypted string starts with the specified prefix.",
    "input",
    "prefix"
  ),
  // ── Array ──────────────────────────────────────────────────────────────────
  $arrayElemAt: array("array", "Returns the element at the specified array index."),
  // A literal pairs-array argument is wrapped one level deeper in codegen
  // (`{ $arrayToObject: [pairs] }`) so MongoDB reads it as the single argument
  // rather than an argument list — see `arrayToObjectOfLiteralPairs` in codegen.ts.
  $arrayToObject: single("array", "Converts an array of key-value pairs to a document."),
  $concatArrays: array("array", "Concatenates arrays to return the concatenated array."),
  $filter: obj(
    "array",
    "Selects a subset of the array, returning only elements that match the filter condition.",
    "input",
    "as",
    "cond",
    "limit"
  ),
  $first: single("array", "Returns the result of an expression for the first document in an array."),
  $firstN: obj("array", "Returns a specified number of elements from the beginning of an array.", "input", "n"),
  // `flex` (dual-form): query `{ field: { $in: [v1, v2] } }` takes a single array;
  // aggregation `{ $in: [needle, haystack] }` takes two operands.
  $in: flex("array", "Returns a boolean indicating whether a specified value is in an array."),
  $indexOfArray: array("array", "Searches an array for a value and returns the index of the first occurrence, or -1."),
  $isArray: single("array", "Determines if the operand is an array."),
  $last: single("array", "Returns the result of an expression for the last document in an array."),
  $lastN: obj("array", "Returns a specified number of elements from the end of an array.", "input", "n"),
  $map: obj(
    "array",
    "Applies a subexpression to each element of an array and returns the array of resulting values.",
    "input",
    "as",
    "in"
  ),
  $maxN: obj("array", "Returns the n largest values in an array.", "input", "n"),
  $minN: obj("array", "Returns the n smallest values in an array.", "input", "n"),
  $objectToArray: single("array", "Converts a document to an array of documents representing key-value pairs."),
  $range: array("array", "Outputs an array containing a sequence of integers according to user-defined inputs."),
  $reduce: obj(
    "array",
    "Applies an expression to each element in an array and combines them into a single value.",
    "input",
    "initialValue",
    "in"
  ),
  $reverseArray: single("array", "Returns an array with the elements in reverse order."),
  $size: single("array", "Returns the number of elements in the array."),
  $slice: array("array", "Returns a subset of an array."),
  $sortArray: obj("array", "Sorts the elements of an array.", "input", "sortBy"),
  $zip: obj(
    "array",
    "Merges two or more arrays element-wise into a single array of arrays.",
    "inputs",
    "useLongestLength",
    "defaults"
  ),
  // ── Set ────────────────────────────────────────────────────────────────────
  $allElementsTrue: single("set", "Returns true if no element of a set evaluates to false."),
  $anyElementTrue: single("set", "Returns true if any elements of a set evaluate to true."),
  $setDifference: array("set", "Returns a set with elements that appear in the first set but not in the second set."),
  $setEquals: array("set", "Returns true if the input sets have the same distinct elements."),
  $setIntersection: array("set", "Returns a set with elements that appear in all of the input sets."),
  $setIsSubset: array("set", "Returns true if all elements of the first set appear in the second set."),
  $setUnion: array("set", "Returns a set with elements that appear in any of the input sets."),
  // ── Object ─────────────────────────────────────────────────────────────────
  $getField: obj(
    "object",
    "Returns the value of a specified field from a document, including fields whose names contain periods or start with $.",
    "field",
    "input"
  ),
  $mergeObjects: flex("object", "Combines multiple documents into a single document."),
  $setField: obj("object", "Adds, updates, or removes a specified field in a document.", "field", "input", "value"),
  $unsetField: obj(
    "object",
    "Removes a specified field from a document. Alias for $setField using $$REMOVE.",
    "field",
    "input"
  ),
  // ── Date ───────────────────────────────────────────────────────────────────
  // Argument *types* (date slots, integer amounts, …) are validated via the
  // `args` rules below + src/operator-validation.ts — see OPERATOR_ARG_RULES.
  $dateAdd: obj("date", "Adds a number of time units to a date object.", "startDate", "unit", "amount", "timezone"),
  $dateDiff: obj(
    "date",
    "Returns the difference between two dates.",
    "startDate",
    "endDate",
    "unit",
    "startOfWeek",
    "timezone"
  ),
  $dateFromParts: obj(
    "date",
    "Constructs a BSON Date object given the date's constituent parts.",
    "year",
    "month",
    "day",
    "hour",
    "minute",
    "second",
    "millisecond",
    "timezone"
  ),
  $dateFromString: obj(
    "date",
    "Converts a date/time string to a date object.",
    "dateString",
    "format",
    "timezone",
    "onError",
    "onNull"
  ),
  $dateSubtract: obj(
    "date",
    "Subtracts a number of time units from a date object.",
    "startDate",
    "unit",
    "amount",
    "timezone"
  ),
  $dateToParts: obj(
    "date",
    "Returns a document containing the constituent parts of a date.",
    "date",
    "timezone",
    "iso8601"
  ),
  $dateToString: obj("date", "Returns the date as a formatted string.", "date", "format", "timezone", "onNull"),
  $dateTrunc: obj("date", "Truncates a date.", "date", "unit", "binSize", "timezone", "startOfWeek"),
  $dayOfMonth: single("date", "Returns the day of the month for a date as a number between 1 and 31."),
  $dayOfWeek: single("date", "Returns the day of the week for a date as a number between 1 (Sunday) and 7 (Saturday)."),
  $dayOfYear: single("date", "Returns the day of the year for a date as a number between 1 and 366."),
  $hour: single("date", "Returns the hour for a date as a number between 0 and 23."),
  $isoDayOfWeek: single(
    "date",
    "Returns the weekday number in ISO 8601 format, ranging from 1 (Monday) to 7 (Sunday)."
  ),
  $isoWeek: single("date", "Returns the week number in ISO 8601 format, ranging from 1 to 53."),
  $isoWeekYear: single("date", "Returns the year number in ISO 8601 format."),
  $millisecond: single("date", "Returns the milliseconds of a date as a number between 0 and 999."),
  $minute: single("date", "Returns the minute for a date as a number between 0 and 59."),
  $month: single("date", "Returns the month for a date as a number between 1 (January) and 12 (December)."),
  $second: single("date", "Returns the seconds for a date as a number between 0 and 60 (leap seconds)."),
  $toDate: single("date", "Converts a value to a Date."),
  $week: single("date", "Returns the week number for a date as a number between 0 and 53."),
  $year: single("date", "Returns the year for a date as a number."),
  // ── Timestamp ──────────────────────────────────────────────────────────────
  $tsIncrement: single("timestamp", "Returns the incrementing ordinal from a timestamp as a long."),
  $tsSecond: single("timestamp", "Returns the seconds from a timestamp as a long."),
  // ── Type ───────────────────────────────────────────────────────────────────
  $convert: obj("type", "Converts a value to a specified type.", "input", "to", "onError", "onNull"),
  $isNumber: single("type", "Returns true if the expression resolves to an integer, decimal, double, or long."),
  $toArray: single("type", "Converts a value to an array."),
  $toBool: single("type", "Converts a value to a boolean."),
  $toDecimal: single("type", "Converts a value to a Decimal128."),
  $toDouble: single("type", "Converts a value to a double."),
  $toInt: single("type", "Converts a value to an integer."),
  $toLong: single("type", "Converts a value to a long."),
  $toObject: single("type", "Converts a string to an object."),
  $toObjectId: single("type", "Converts a value to an ObjectId."),
  $toString: single("type", "Converts a value to a string."),
  $toUUID: single("type", "Converts a string to a UUID."),
  $type: single("type", "Returns the BSON data type of the field."),
  // ── Literal ────────────────────────────────────────────────────────────────
  $literal: single(
    "literal",
    "Returns a value without parsing. Use to keep values that the pipeline would otherwise interpret as expressions (e.g. strings starting with $)."
  ),
  // ── Variable ───────────────────────────────────────────────────────────────
  $let: obj(
    "variable",
    "Defines variables for use within the scope of a subexpression and returns the result.",
    "vars",
    "in"
  ),
  // ── Custom Aggregation ─────────────────────────────────────────────────────
  $accumulator: acc(
    obj(
      "custom-aggregation",
      "Defines a custom accumulator function. Body fields hold JavaScript source executed by the server.",
      "init",
      "initArgs",
      "accumulate",
      "accumulateArgs",
      "merge",
      "finalize",
      "lang"
    )
  ),
  $function: obj(
    "custom-aggregation",
    "Defines a custom function. The body field is JavaScript source executed by the server.",
    "body",
    "args",
    "lang"
  ),
  // ── Data Size ──────────────────────────────────────────────────────────────
  $binarySize: single("data-size", "Returns the size of a string or binary data value's content in bytes."),
  $bsonSize: single("data-size", "Returns the size in bytes of a document when encoded as BSON."),
  // ── Text ───────────────────────────────────────────────────────────────────
  $meta: single(
    "text",
    'Accesses per-document metadata related to the aggregation operation. Argument is a keyword string (e.g. "textScore"), not an arbitrary expression.'
  ),
  // ── Miscellaneous ──────────────────────────────────────────────────────────
  $createObjectId: none("miscellaneous", "Returns a random ObjectId."),
  $hash: obj(
    "miscellaneous",
    "Generates a binary hash value (BinData) from a UTF-8 string or binary data.",
    "input",
    "algorithm"
  ),
  $hexHash: obj(
    "miscellaneous",
    "Generates an uppercase hexadecimal hash string from a UTF-8 string or binary data.",
    "input",
    "algorithm"
  ),
  $rand: none("miscellaneous", "Returns a random float between 0 and 1."),
  $sampleRate: single("miscellaneous", "Randomly selects documents at a given rate. Used inside $match."),
  $toHashedIndexKey: single(
    "miscellaneous",
    "Computes the hash of the input expression using MongoDB's hashed-index hash function."
  ),
  // ── Accumulators (also valid as expression operators in some stages) ──────
  $addToSet: acc(single("array", "Returns an array of unique expression values for each group.")),
  $avg: flex("arithmetic", "Returns the average for the specified expression."),
  $count: none("array", "Returns the number of documents in the group or window."),
  $max: flex("comparison", "Returns the maximum value that results from applying an expression."),
  $median: acc(
    obj("arithmetic", "Returns an approximation of the median (50th percentile) as a scalar value.", "input", "method")
  ),
  $min: flex("comparison", "Returns the minimum value that results from applying an expression."),
  $percentile: acc(
    obj(
      "arithmetic",
      "Returns an array of scalar values that correspond to specified percentile values.",
      "input",
      "p",
      "method"
    )
  ),
  $push: acc(single("array", "Returns an array of values that result from applying an expression.")),
  $stdDevPop: flex("arithmetic", "Calculates the population standard deviation of the input values."),
  $stdDevSamp: flex("arithmetic", "Calculates the sample standard deviation of the input values."),
  $sum: flex("arithmetic", "Returns a sum of numerical values, ignoring non-numeric values."),
  $bottom: acc(
    obj(
      "array",
      "Returns the bottom element within a group according to the specified sort order.",
      "output",
      "sortBy"
    )
  ),
  $bottomN: acc(
    obj(
      "array",
      "Returns an aggregation of the bottom n elements within a group, according to the specified sort order.",
      "output",
      "sortBy",
      "n"
    )
  ),
  $top: acc(
    obj("array", "Returns the top element within a group according to the specified sort order.", "output", "sortBy")
  ),
  $topN: acc(
    obj(
      "array",
      "Returns an aggregation of the top n fields within a group, according to the specified sort order.",
      "output",
      "sortBy",
      "n"
    )
  ),
  // ── Window (only valid inside $setWindowFields) ───────────────────────────
  $covariancePop: array("window", "Returns the population covariance of two numeric expressions."),
  $covarianceSamp: array("window", "Returns the sample covariance of two numeric expressions."),
  $denseRank: none(
    "window",
    "Returns the document position (rank) within the partition. There are no gaps; ties receive the same rank."
  ),
  $derivative: obj("window", "Returns the average rate of change within the specified window.", "input", "unit"),
  $documentNumber: none(
    "window",
    "Returns the position of a document in the $setWindowFields partition. Ties produce different adjacent numbers."
  ),
  $expMovingAvg: obj(
    "window",
    "Returns the exponential moving average for the numeric expression.",
    "input",
    "N",
    "alpha"
  ),
  $integral: obj("window", "Returns the approximation of the area under a curve.", "input", "unit"),
  $linearFill: single(
    "window",
    "Fills null and missing fields in a window using linear interpolation based on surrounding field values."
  ),
  $locf: single(
    "window",
    "Last observation carried forward \u2014 sets null/missing fields in a window to the last non-null value."
  ),
  $rank: none("window", "Returns the document position (rank) within the $setWindowFields partition."),
  $shift: obj(
    "window",
    "Returns the value from an expression applied to a document in a specified position relative to the current document.",
    "output",
    "by",
    "default"
  )
};
var OPERATOR_ARG_RULES = {
  // ── Arity: fixed / bounded operand counts (array & flex shapes) ──
  // Only EXACT and BOUNDED-RANGE counts are declared — never an open min on a
  // variadic op ($add/$or/$concat/$setUnion accept any count, so they get no
  // rule; see the coverage-proof tests). $ifNull's min-2 is the one verified
  // lower bound. `sig` is the human signature shown in the arity message.
  $divide: { arity: { exact: 2, sig: "dividend, divisor" }, elementType: "number" },
  $mod: { arity: { exact: 2, sig: "dividend, divisor" }, elementType: "number" },
  $pow: { arity: { exact: 2, sig: "base, exponent" }, elementType: "number" },
  $log: { arity: { exact: 2, sig: "number, base" }, elementType: "number" },
  $subtract: { arity: { exact: 2, sig: "minuend, subtrahend" }, elementType: "number-or-date" },
  $atan2: { arity: { exact: 2, sig: "y, x" }, elementType: "number" },
  $cmp: { arity: { exact: 2, sig: "expr1, expr2" } },
  $round: { arity: { allowed: [1, 2], sig: "number[, place]" }, elementType: "number" },
  $trunc: { arity: { allowed: [1, 2], sig: "number[, place]" }, elementType: "number" },
  $split: { arity: { exact: 2, sig: "string, delimiter" } },
  $strcasecmp: { arity: { exact: 2, sig: "expr1, expr2" } },
  $substr: { arity: { exact: 3, sig: "string, start, length" } },
  $substrBytes: { arity: { exact: 3, sig: "string, byteIndex, byteCount" } },
  $substrCP: { arity: { exact: 3, sig: "string, cpIndex, cpCount" } },
  $indexOfBytes: { arity: { allowed: [2, 3, 4], sig: "string, substring[, start[, end]]" } },
  $indexOfCP: { arity: { allowed: [2, 3, 4], sig: "string, substring[, start[, end]]" } },
  $arrayElemAt: { arity: { exact: 2, sig: "array, index" } },
  $indexOfArray: { arity: { allowed: [2, 3, 4], sig: "array, value[, start[, end]]" } },
  $range: { arity: { allowed: [2, 3], sig: "start, end[, step]" } },
  $slice: { arity: { allowed: [2, 3], sig: "array, [position, ]count" } },
  $ifNull: { arity: { atLeast: 2, sig: "expr, replacement[, \u2026]" } },
  $setDifference: { arity: { exact: 2, sig: "set1, set2" } },
  $setIsSubset: { arity: { exact: 2, sig: "set1, set2" } },
  // ── Comparison (agg-only arity: the 1-arg / array form is the valid QUERY form) ──
  $eq: { arity: { exact: 2, sig: "expr1, expr2", aggOnly: true } },
  $ne: { arity: { exact: 2, sig: "expr1, expr2", aggOnly: true } },
  $gt: { arity: { exact: 2, sig: "expr1, expr2", aggOnly: true } },
  $gte: { arity: { exact: 2, sig: "expr1, expr2", aggOnly: true } },
  $lt: { arity: { exact: 2, sig: "expr1, expr2", aggOnly: true } },
  $lte: { arity: { exact: 2, sig: "expr1, expr2", aggOnly: true } },
  // ── Literal types: numeric / bitwise / object / array / timestamp (all mongod-verified) ──
  // Single-shape numeric (a literal string/bool/array/object is rejected).
  $abs: { singleType: "number" },
  $ceil: { singleType: "number" },
  $floor: { singleType: "number" },
  $exp: { singleType: "number" },
  $ln: { singleType: "number" },
  $log10: { singleType: "number" },
  $sqrt: { singleType: "number" },
  $sigmoid: { singleType: "number" },
  $sin: { singleType: "number" },
  $cos: { singleType: "number" },
  $tan: { singleType: "number" },
  $asin: { singleType: "number" },
  $acos: { singleType: "number" },
  $atan: { singleType: "number" },
  $sinh: { singleType: "number" },
  $cosh: { singleType: "number" },
  $tanh: { singleType: "number" },
  $asinh: { singleType: "number" },
  $acosh: { singleType: "number" },
  $atanh: { singleType: "number" },
  $degreesToRadians: { singleType: "number" },
  $radiansToDegrees: { singleType: "number" },
  // Variadic numeric / numeric-or-date (each literal operand).
  $multiply: { elementType: "number" },
  $add: { elementType: "number-or-date" },
  // Bitwise: int or long only (a non-integer number or a string is rejected).
  $bitNot: { singleType: "int-or-long" },
  $bitAnd: { elementType: "int-or-long" },
  $bitOr: { elementType: "int-or-long" },
  $bitXor: { elementType: "int-or-long" },
  // Object / array / timestamp shape requirements.
  $mergeObjects: { elementType: "object" },
  $objectToArray: { singleType: "object" },
  $size: { singleType: "array" },
  $reverseArray: { singleType: "array" },
  $tsSecond: { singleType: "timestamp" },
  $tsIncrement: { singleType: "timestamp" },
  // ── Conditional ──
  $cond: { required: ["if", "then", "else"] },
  $switch: { required: ["branches"], optional: ["default"] },
  // ── String ──
  $ltrim: { required: ["input"], optional: ["chars"] },
  $rtrim: { required: ["input"], optional: ["chars"] },
  $trim: { required: ["input"], optional: ["chars"] },
  $regexFind: { required: ["input", "regex"], optional: ["options"], enums: { options: "regexFlags" } },
  $regexFindAll: { required: ["input", "regex"], optional: ["options"], enums: { options: "regexFlags" } },
  $regexMatch: { required: ["input", "regex"], optional: ["options"], enums: { options: "regexFlags" } },
  $replaceAll: { required: ["input", "find", "replacement"] },
  $replaceOne: { required: ["input", "find", "replacement"] },
  // ── Array ──
  $filter: { required: ["input", "cond"], optional: ["as", "limit"] },
  $firstN: { required: ["input", "n"] },
  $lastN: { required: ["input", "n"] },
  $maxN: { required: ["input", "n"] },
  $minN: { required: ["input", "n"] },
  $map: { required: ["input", "in"], optional: ["as"] },
  $reduce: { required: ["input", "initialValue", "in"] },
  $sortArray: { required: ["input", "sortBy"] },
  $zip: { required: ["inputs"], optional: ["useLongestLength", "defaults"] },
  // ── Object ──
  $getField: { required: ["field"], optional: ["input"] },
  $setField: { required: ["field", "input", "value"] },
  $unsetField: { required: ["field", "input"] },
  // ── Type ──
  $convert: { required: ["input", "to"], optional: ["onError", "onNull"], enums: { to: "bsonTypeName" } },
  // ── Date accessors (single-shape) — a literal non-date is certainly wrong ──
  $year: { singleType: "date" },
  $month: { singleType: "date" },
  $dayOfMonth: { singleType: "date" },
  $dayOfWeek: { singleType: "date" },
  $dayOfYear: { singleType: "date" },
  $hour: { singleType: "date" },
  $minute: { singleType: "date" },
  $second: { singleType: "date" },
  $millisecond: { singleType: "date" },
  $week: { singleType: "date" },
  $isoDayOfWeek: { singleType: "date" },
  $isoWeek: { singleType: "date" },
  $isoWeekYear: { singleType: "date" },
  // ── Date operators (object-shape) ── date / amount / timezone slot types
  $dateAdd: {
    required: ["startDate", "unit", "amount"],
    optional: ["timezone"],
    enums: { unit: "timeUnit" },
    keyTypes: { startDate: "date", amount: "int-or-long", timezone: "string" }
  },
  $dateSubtract: {
    required: ["startDate", "unit", "amount"],
    optional: ["timezone"],
    enums: { unit: "timeUnit" },
    keyTypes: { startDate: "date", amount: "int-or-long", timezone: "string" }
  },
  $dateDiff: {
    required: ["startDate", "endDate", "unit"],
    optional: ["startOfWeek", "timezone"],
    enums: { unit: "timeUnit", startOfWeek: "weekday" },
    keyTypes: { startDate: "date", endDate: "date", timezone: "string" }
  },
  // year-or-isoWeekYear is a structural rule (deferred); list the full key set so unknown-key works.
  $dateFromParts: {
    optional: [
      "year",
      "isoWeekYear",
      "month",
      "isoWeek",
      "day",
      "isoDayOfWeek",
      "hour",
      "minute",
      "second",
      "millisecond",
      "timezone"
    ]
  },
  $dateFromString: { required: ["dateString"], optional: ["format", "timezone", "onError", "onNull"] },
  $dateToParts: {
    required: ["date"],
    optional: ["timezone", "iso8601"],
    keyTypes: { date: "date", timezone: "string" }
  },
  $dateToString: {
    required: ["date"],
    optional: ["format", "timezone", "onNull"],
    keyTypes: { date: "date", timezone: "string" }
  },
  $dateTrunc: {
    required: ["date", "unit"],
    optional: ["binSize", "timezone", "startOfWeek"],
    enums: { unit: "timeUnit", startOfWeek: "weekday" },
    keyTypes: { date: "date", binSize: "number", timezone: "string" }
  },
  // ── Variable ──
  $let: { required: ["vars", "in"] },
  // ── Custom aggregation ──
  $function: { required: ["body", "args", "lang"], enums: { lang: ["js"] } },
  $accumulator: {
    required: ["init", "accumulate", "accumulateArgs", "merge", "lang"],
    optional: ["initArgs", "finalize"],
    enums: { lang: ["js"] }
  },
  // ── Accumulators (object-shape) ──
  $median: { required: ["input", "method"], enums: { method: ["approximate"] } },
  $percentile: { required: ["input", "p", "method"], enums: { method: ["approximate"] } },
  $bottom: { required: ["output", "sortBy"] },
  $bottomN: { required: ["output", "sortBy", "n"] },
  $top: { required: ["output", "sortBy"] },
  $topN: { required: ["output", "sortBy", "n"] },
  // ── Window (object-shape) ──
  $derivative: { required: ["input"], optional: ["unit"], enums: { unit: "timeUnit" } },
  $integral: { required: ["input"], optional: ["unit"], enums: { unit: "timeUnit" } },
  $expMovingAvg: { required: ["input"], optional: ["N", "alpha"] },
  $shift: { required: ["output", "by"], optional: ["default"] }
};
for (const [name, rules] of Object.entries(OPERATOR_ARG_RULES)) {
  if (OPERATORS[name] !== void 0) OPERATORS[name] = withArgs(OPERATORS[name], rules);
}
function lookupOperator(name) {
  return OPERATORS[name];
}

// src/literal-gate.ts
function litNumber(e) {
  if (e.type === "NumberLiteral") return e.value;
  if (e.type === "UnaryExpr" && e.op === "-" && e.operand.type === "NumberLiteral") return -e.operand.value;
  return null;
}
function litString(e) {
  return e.type === "StringLiteral" ? e.value : null;
}
function litBool(e) {
  return e.type === "BooleanLiteral" ? e.value : null;
}
function describeLiteral(e) {
  switch (e.type) {
    case "NumberLiteral":
      return "a number";
    case "BigIntLiteral":
      return "a bigint";
    case "StringLiteral":
      return "a string";
    case "BooleanLiteral":
      return "a boolean";
    case "NullLiteral":
      return "null";
    case "ArrayLiteral":
      return "an array";
    case "ObjectLiteral":
      return "an object";
    case "RegexLiteral":
      return "a regular expression";
    default:
      return null;
  }
}
function objectInfo(e) {
  if (e.type !== "ObjectLiteral") return null;
  const byKey = /* @__PURE__ */ new Map();
  let hasSpread = false;
  for (const entry of e.entries) {
    if (entry.type === "SpreadElement") {
      hasSpread = true;
      continue;
    }
    if (entry.key.kind !== "static") return null;
    byKey.set(entry.key.name, entry.value);
  }
  return { byKey, hasSpread };
}
function arrayElements(e) {
  if (e.type !== "ArrayLiteral") return null;
  const out = [];
  for (const el of e.elements) {
    if (el.type === "SpreadElement" || el.type === "AssignExpr" || el.type === "DeleteStmt" || el.type === "LetDecl" || el.type === "FuncDecl") {
      return null;
    }
    out.push(el);
  }
  return out;
}
function requireKeys(stage, info, bodyPos, keys) {
  if (info.hasSpread) return;
  for (const k of keys) {
    if (!info.byKey.has(k)) {
      throw new CodegenError(`'${stage}' requires the '${k}' field, but it is missing.`, bodyPos);
    }
  }
}
function requireObjectBody(stage, body, required = []) {
  const info = objectInfo(body);
  if (info === null) return null;
  requireKeys(stage, info, body.pos, required);
  return info;
}
function checkEnum(stage, field, value, allowed) {
  const s = litString(value);
  if (s === null || allowed.includes(s)) return;
  const near = closestNameTo(s, allowed);
  const hint = near !== null ? ` Did you mean '${near}'?` : "";
  throw new CodegenError(`'${stage}' ${field} must be one of: ${allowed.join(", ")} \u2014 got '${s}'.${hint}`, value.pos);
}
function nonConstantDesc(e) {
  return e.type === "FieldRef" ? "a field reference" : "a runtime expression";
}
function requireConstantArray(label, value) {
  if (value.type === "ArrayLiteral" || value.type === "ParamRef") return;
  const desc = describeLiteral(value);
  throw new CodegenError(
    `'${label}' must be a constant array \u2014 got ${desc ?? nonConstantDesc(value)}, which the server can't accept here. Use a literal array.`,
    value.pos
  );
}
function checkIntBound(stage, body, opts) {
  const n = litNumber(body);
  if (n === null) {
    const desc = describeLiteral(body);
    if (desc !== null) {
      throw new CodegenError(`'${stage}' expects an integer, but got ${desc}.`, body.pos);
    }
    if (body.type !== "ParamRef") {
      throw new CodegenError(
        `'${stage}' must be ${opts.label} and a compile-time constant \u2014 got ${nonConstantDesc(body)}, which the server can't accept here. Use a literal value.`,
        body.pos
      );
    }
    return;
  }
  if (!Number.isInteger(n)) {
    throw new CodegenError(`'${stage}' must be an integer, but got ${n}.`, body.pos);
  }
  if (n < opts.min) {
    throw new CodegenError(`'${stage}' must be ${opts.label}, but got ${n}.`, body.pos);
  }
}

// src/operator-validation.ts
var TIME_UNIT = [
  "year",
  "quarter",
  "month",
  "week",
  "day",
  "hour",
  "minute",
  "second",
  "millisecond"
];
var WEEKDAY = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
var BSON_TYPE_NAME = [
  "double",
  "string",
  "object",
  "array",
  "binData",
  "objectId",
  "bool",
  "date",
  "null",
  "regex",
  "dbPointer",
  "javascript",
  "symbol",
  "javascriptWithScope",
  "int",
  "timestamp",
  "long",
  "decimal",
  "minKey",
  "maxKey"
];
var REGEX_FLAGS = "imxs";
function checkArgEnum(name, key, value, ref) {
  const lit = litString(value);
  if (lit !== null && lit.startsWith("$")) return;
  if (ref === "regexFlags") {
    const s = litString(value);
    if (s === null) return;
    for (const ch of s) {
      if (!REGEX_FLAGS.includes(ch)) {
        throw new CodegenError(
          `'${name}' ${key} has an invalid regex flag '${ch}'. MongoDB allows only i, m, x, s \u2014 a JavaScript 'g' or 'y' flag is not supported.`,
          value.pos
        );
      }
    }
    return;
  }
  if (ref === "weekday") {
    const s = litString(value);
    if (s === null || WEEKDAY.includes(s.toLowerCase())) return;
    const near = closestNameTo(s.toLowerCase(), WEEKDAY);
    throw new CodegenError(
      `'${name}' ${key} must be a weekday (${WEEKDAY.join(", ")}) \u2014 got '${s}'.` + (near !== null ? ` Did you mean '${near}'?` : ""),
      value.pos
    );
  }
  const allowed = ref === "timeUnit" ? TIME_UNIT : ref === "bsonTypeName" ? BSON_TYPE_NAME : ref;
  checkEnum(name, key, value, allowed);
}
function literalKind(e) {
  switch (e.type) {
    case "NumberLiteral":
      return "number";
    case "UnaryExpr":
      return e.op === "-" && e.operand.type === "NumberLiteral" ? "number" : null;
    case "StringLiteral":
      return e.value.startsWith("$") ? null : "string";
    case "BooleanLiteral":
      return "bool";
    case "NullLiteral":
      return "null";
    case "ArrayLiteral":
      return "array";
    case "ObjectLiteral":
      return "object";
    case "RegexLiteral":
      return "regex";
    case "BigIntLiteral":
      return "bigint";
    default:
      return null;
  }
}
var KIND_NOUN = {
  number: "a number",
  string: "a string",
  bool: "a boolean",
  null: "null",
  array: "an array",
  object: "an object",
  regex: "a regular expression",
  bigint: "a bigint"
};
function typeMatches(kind, e, expected) {
  switch (expected) {
    case "number":
    case "number-or-date":
      return kind === "number" || kind === "bigint";
    case "integer":
    case "int-or-long": {
      if (kind === "bigint") return true;
      const n = litNumber(e);
      return n !== null && Number.isInteger(n);
    }
    case "string":
      return kind === "string";
    case "bool":
      return kind === "bool";
    case "array":
      return kind === "array";
    case "object":
      return kind === "object";
    case "date":
    case "timestamp":
      return false;
  }
}
function typeNoun(expected) {
  switch (expected) {
    case "number":
      return "expects a number";
    case "integer":
    case "int-or-long":
      return "expects an integer";
    case "number-or-date":
      return "expects a number or a date";
    case "string":
      return "expects a string";
    case "bool":
      return "expects a boolean";
    case "array":
      return "expects an array";
    case "object":
      return "expects a document";
    case "date":
      return "expects a date";
    case "timestamp":
      return "expects a timestamp";
  }
}
function typeHint(expected) {
  if (expected === "date" || expected === "number-or-date") return " Use a field path or new Date(\u2026).";
  if (expected === "timestamp") return " Use a field path (a timestamp has no literal form).";
  return "";
}
function checkArgType(name, slot, value, expected) {
  const kind = literalKind(value);
  if (kind === null || kind === "null") return;
  if (typeMatches(kind, value, expected)) return;
  const slotPart = slot ? ` ${slot}` : "";
  throw new CodegenError(
    `'${name}'${slotPart} ${typeNoun(expected)}, but got ${KIND_NOUN[kind]}.${typeHint(expected)}`,
    value.pos
  );
}
function operandExprs(args) {
  if (args.length === 1 && args[0].type === "ArrayLiteral") {
    return arrayElements(args[0]) ?? [];
  }
  return args;
}
function validateOperatorArgs(name, style, args, pos, ctx) {
  const def = lookupOperator(name);
  if (def === void 0) return;
  if (def.shape.kind === "none") {
    if (args.length === 0) return;
    if (def.category === "window") {
      throw new CodegenError(
        `${name}() takes no arguments, got ${args.length}. Its value is computed from the '$setWindowFields' sortBy ordering \u2014 set sortBy on the stage, don't pass a field.`,
        pos
      );
    }
    checkArity(name, { sig: "", none: true }, args.length, pos, "");
    return;
  }
  const rules = def.args;
  if (rules === void 0) return;
  if (rules.arity !== void 0 && (def.shape.kind === "array" || def.shape.kind === "flex")) {
    const a = rules.arity;
    if (!a.aggOnly || ctx.aggExpr === true) {
      const count = operandCount(def.shape.kind, args);
      if (count !== null) {
        checkArity(name, { sig: a.sig ?? "", exact: a.exact, allowed: a.allowed, atLeast: a.atLeast }, count, pos, "");
      }
    }
  }
  if (rules.singleType !== void 0 && def.shape.kind === "single" && args.length >= 1) {
    checkArgType(name, "", args[0], rules.singleType);
  }
  if (def.shape.kind === "array" || def.shape.kind === "flex") {
    if (rules.elementType !== void 0) {
      for (const el of operandExprs(args)) checkArgType(name, "", el, rules.elementType);
    }
    if (rules.positionalTypes !== void 0) {
      const ops = operandExprs(args);
      rules.positionalTypes.forEach((t, i) => {
        if (ops[i] !== void 0) checkArgType(name, "", ops[i], t);
      });
    }
  }
  if (def.shape.kind === "object") {
    validateObjectKeys(name, def.shape.keys, rules, style, args, pos);
  }
}
function operandCount(shape, args) {
  if (args.length === 1 && args[0].type === "ArrayLiteral") {
    const els = arrayElements(args[0]);
    return els === null ? null : els.length;
  }
  if (shape === "array" && args.length <= 1) return null;
  return args.length;
}
function validateObjectKeys(name, shapeKeys, rules, style, args, pos) {
  const required = rules.required ?? [];
  const enums = rules.enums;
  if (required.length === 0 && (rules.optional ?? []).length === 0 && enums === void 0) return;
  let presentKeys;
  let hasSpread = false;
  let valueOf;
  if (style === "object") {
    const info = objectInfo(args[0]);
    if (info === null) return;
    presentKeys = [...info.byKey.keys()];
    hasSpread = info.hasSpread;
    valueOf = (k) => info.byKey.get(k);
  } else {
    presentKeys = shapeKeys.slice(0, args.length);
    valueOf = (k) => {
      const i = shapeKeys.indexOf(k);
      return i >= 0 && i < args.length ? args[i] : void 0;
    };
  }
  const closedSet = [...required, ...rules.optional ?? []];
  if (style === "object" && !hasSpread && rules.closedKeys !== false) {
    for (const k of presentKeys) {
      if (!closedSet.includes(k)) {
        throw new CodegenError(
          `'${name}' has no parameter '${k}'.${didYouMean(k, closedSet, (s) => s)} Valid keys: ${closedSet.join(", ")}.`,
          valueOf(k)?.pos ?? pos
        );
      }
    }
  }
  if (!hasSpread) {
    for (const k of required) {
      if (!presentKeys.includes(k)) {
        throw new CodegenError(`'${name}' requires the '${k}' field, but it is missing.`, pos);
      }
    }
  }
  if (enums !== void 0) {
    for (const [key, ref] of Object.entries(enums)) {
      const v = valueOf(key);
      if (v !== void 0) checkArgEnum(name, key, v, ref);
    }
  }
  if (rules.keyTypes !== void 0) {
    for (const [key, t] of Object.entries(rules.keyTypes)) {
      const v = valueOf(key);
      if (v !== void 0) checkArgType(name, key, v, t);
    }
  }
}

// src/ast-walk.ts
function someArg(arg, pred) {
  return arg.type === "SpreadElement" ? someExpr(arg.argument, pred) : someExpr(arg, pred);
}
function someExpr(expr, pred) {
  if (pred(expr)) return true;
  switch (expr.type) {
    case "OperatorCall":
    case "MathCall":
    case "ObjectCall":
      return expr.args.some((a) => someArg(a, pred));
    case "CallExpression":
      return someExpr(expr.callee, pred) || expr.args.some((a) => someArg(a, pred));
    case "MethodCall":
      return someExpr(expr.object, pred) || expr.args.some((a) => someArg(a, pred));
    case "MemberAccess":
      return someExpr(expr.object, pred);
    case "IndexAccess":
      return someExpr(expr.object, pred) || someExpr(expr.index, pred);
    case "BinaryExpr":
      return someExpr(expr.left, pred) || someExpr(expr.right, pred);
    case "UnaryExpr":
      return someExpr(expr.operand, pred);
    case "TernaryExpr":
      return someExpr(expr.condition, pred) || someExpr(expr.consequent, pred) || someExpr(expr.alternate, pred);
    case "TemplateLiteral":
      return expr.expressions.some((e) => someExpr(e, pred));
    case "ArrayLiteral":
      return expr.elements.some((el) => someElement(el, pred));
    case "ObjectLiteral":
      return expr.entries.some(
        (entry) => entry.type === "SpreadElement" ? someExpr(entry.argument, pred) : entry.key.kind === "computed" && someExpr(entry.key.expr, pred) || someExpr(entry.value, pred)
      );
    case "Lambda":
      if (expr.body !== void 0 && someExpr(expr.body, pred)) return true;
      if (expr.exprBlock !== void 0) {
        if (expr.exprBlock.decls.some((d) => someExpr(d.value, pred))) return true;
        if (someExpr(expr.exprBlock.ret, pred)) return true;
      }
      if (expr.block !== void 0 && expr.block.stmts.some((s) => someStmt(s, pred))) return true;
      if (expr.ret !== void 0 && someExpr(expr.ret, pred)) return true;
      return false;
    case "TypeofExpr":
      return someExpr(expr.operand, pred);
    case "TypeCast":
      return someExpr(expr.arg, pred);
    case "NewDate":
    case "DateUTC":
      return expr.args.some((e) => someExpr(e, pred));
    case "NewSet":
      return expr.arg !== null && someExpr(expr.arg, pred);
    case "ArrayFrom":
      return someExpr(expr.input, pred) || expr.mapFn !== null && someExpr(expr.mapFn, pred);
    case "NumberStatic":
      return someExpr(expr.arg, pred);
    default:
      return false;
  }
}
function someElement(el, pred) {
  if (el.type === "AssignExpr") return someExpr(el.value, pred);
  if (el.type === "DeleteStmt") return false;
  if (el.type === "LetDecl") return someExpr(el.value, pred);
  if (el.type === "FuncDecl") return false;
  if (el.type === "SpreadElement") return someExpr(el.argument, pred);
  return someExpr(el, pred);
}
function someStmt(stmt, pred) {
  if (stmt.type === "UpdateFilter") {
    return stmt.ops.some((op) => op.type === "AssignExpr" ? someExpr(op.value, pred) : false);
  }
  return someElement(stmt, pred);
}

// src/namespace.ts
var JSMQL_NS = "__jsmql";
function bindingSlot(name) {
  return `${JSMQL_NS}.var.${name}`;
}
function tmpSlot(n) {
  return `${JSMQL_NS}.tmp.${n}`;
}
var LENGTH_SLOT = `${JSMQL_NS}.length`;
function streamLengthStage() {
  return { $setWindowFields: { output: { [LENGTH_SLOT]: { $count: {} } } } };
}
var GROUP_TMP = `${JSMQL_NS}Tmp`;
function sanitizeVarSegment(name) {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}
function letFieldVar(field, depth) {
  return `${JSMQL_NS_VAR}f${depth}_${sanitizeVarSegment(field)}`;
}
function letBindingVar(name, depth) {
  return `${JSMQL_NS_VAR}v${depth}_${sanitizeVarSegment(name)}`;
}
function letSysVar(name, depth) {
  return `${JSMQL_NS_VAR}s${depth}_${sanitizeVarSegment(name)}`;
}
var JSMQL_NS_VAR = "jsmql_";
var CORRELATION_VAR_RE = /^jsmql_[fvs]\d+_/;

// src/objectid.ts
var BSON_MAJOR_VERSION = 7;
var BSON_VERSION_SYMBOL = /* @__PURE__ */ Symbol.for("@@mdb.bson.version");
var HEX24 = /^[0-9a-fA-F]{24}$/;
var ObjectId = class {
  constructor(hex) {
    this._bsontype = "ObjectId";
    if (!HEX24.test(hex)) {
      throw new TypeError(`Invalid ObjectId hex string: ${JSON.stringify(hex)} (expected 24 hex characters)`);
    }
    const bytes = new Uint8Array(12);
    for (let i = 0; i < 12; i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    this.buffer = bytes;
  }
  // bson 7.x rejects any value whose version symbol !== its BSON_MAJOR_VERSION.
  get [BSON_VERSION_SYMBOL]() {
    return BSON_MAJOR_VERSION;
  }
  // bson exposes `.id` as the raw 12-byte buffer; mirror it for any driver code
  // that reads bytes directly rather than through `serializeInto`.
  get id() {
    return this.buffer;
  }
  toHexString() {
    let out = "";
    for (let i = 0; i < 12; i++) {
      out += this.buffer[i].toString(16).padStart(2, "0");
    }
    return out;
  }
  toString() {
    return this.toHexString();
  }
  // Extended JSON renders an ObjectId as its hex string; matching that keeps
  // `JSON.stringify` output (e.g. from the CLI) readable, even though a JSON
  // string can never round-trip back into a live BSON value.
  toJSON() {
    return this.toHexString();
  }
  equals(other) {
    if (other === null || other === void 0) return false;
    const o = other;
    const hex = typeof o.toHexString === "function" ? o.toHexString() : typeof o.toString === "function" ? o.toString() : null;
    return hex !== null && hex.toLowerCase() === this.toHexString();
  }
  getTimestamp() {
    const seconds = this.buffer[0] * 2 ** 24 + this.buffer[1] * 2 ** 16 + this.buffer[2] * 2 ** 8 + this.buffer[3];
    return new Date(seconds * 1e3);
  }
  serializeInto(uint8array, index) {
    for (let i = 0; i < 12; i++) {
      uint8array[index + i] = this.buffer[i];
    }
    return 12;
  }
};

// src/lodash-shared.ts
var ASCII_WORDS_RE = "[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[A-Z]|[0-9]+";
var HTML_ESCAPE_PAIRS = [
  ["&", "&amp;"],
  ["<", "&lt;"],
  [">", "&gt;"],
  ['"', "&quot;"],
  ["'", "&#39;"]
];

// src/lodash-fold.ts
function asciiUpper(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 97 && c <= 122 ? String.fromCharCode(c - 32) : s[i];
  }
  return out;
}
function asciiLower(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : s[i];
  }
  return out;
}
function words(s) {
  return s.match(new RegExp(ASCII_WORDS_RE, "g")) ?? [];
}
function capitalizeWord(s) {
  return asciiUpper(s.slice(0, 1)) + asciiLower(s.slice(1));
}
function capitalize(s) {
  return capitalizeWord(s);
}
function upperFirst(s) {
  return asciiUpper(s.slice(0, 1)) + s.slice(1);
}
function lowerFirst(s) {
  return asciiLower(s.slice(0, 1)) + s.slice(1);
}
function kebabCase(s) {
  return asciiLower(words(s).join("-"));
}
function snakeCase(s) {
  return asciiLower(words(s).join("_"));
}
function startCase(s) {
  return words(s).map(capitalizeWord).join(" ");
}
function camelCase(s) {
  const pascal = words(s).map(capitalizeWord).join("");
  return asciiLower(pascal.slice(0, 1)) + pascal.slice(1);
}
function escape(s) {
  let e = s;
  for (const [find, replacement] of HTML_ESCAPE_PAIRS) e = e.split(find).join(replacement);
  return e;
}
function truncate(s, length, omission) {
  if (s.length <= length) return s;
  const keep = Math.max(0, length - omission.length);
  return s.slice(0, keep) + omission;
}
function bsonEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => bsonEqual(x, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(
      (k) => Object.prototype.hasOwnProperty.call(b, k) && bsonEqual(a[k], b[k])
    );
  }
  return false;
}
function mqlTruthy(v) {
  return !(v === false || v === null || v === void 0 || v === 0);
}
function mqlKeyString(v) {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return void 0;
}
function clamp(n, lower, upper) {
  return Math.min(Math.max(n, lower), upper);
}
function inRange(n, a, b) {
  const lo = b === void 0 ? 0 : a;
  const hi = b === void 0 ? a : b;
  return n >= Math.min(lo, hi) && n < Math.max(lo, hi);
}
function round(n, p) {
  const f = 10 ** p;
  const x = n * f;
  const floor = Math.floor(x);
  const diff = x - floor;
  let r;
  if (diff < 0.5) r = floor;
  else if (diff > 0.5) r = floor + 1;
  else r = floor % 2 === 0 ? floor : floor + 1;
  return r / f;
}
function ceilN(n, p) {
  if (p === 0) return Math.ceil(n);
  const f = 10 ** p;
  return Math.ceil(n * f) / f;
}
function floorN(n, p) {
  if (p === 0) return Math.floor(n);
  const f = 10 ** p;
  return Math.floor(n * f) / f;
}
var isNum = (x) => typeof x === "number";
function sum(arr) {
  return arr.filter(isNum).reduce((a, b) => a + b, 0);
}
function mean(arr) {
  const ns = arr.filter(isNum);
  return ns.length === 0 ? null : ns.reduce((a, b) => a + b, 0) / ns.length;
}
function uniq(arr) {
  const out = [];
  for (const x of arr) if (!out.some((y) => bsonEqual(x, y))) out.push(x);
  return out;
}
function compact(arr) {
  return arr.filter(mqlTruthy);
}
function flatten(arr) {
  return arr.reduce((acc2, x) => acc2.concat(Array.isArray(x) ? x : [x]), []);
}
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
function take(arr, n) {
  return arr.slice(0, Math.max(0, n));
}
function drop(arr, n) {
  return arr.slice(Math.max(0, n));
}
function takeRight(arr, n) {
  return n <= 0 ? [] : arr.slice(-n);
}
function dropRight(arr, n) {
  return arr.slice(0, Math.max(0, arr.length - n));
}
function without(arr, values) {
  return arr.filter((x) => !values.some((v) => bsonEqual(x, v)));
}
function xor(a, b) {
  const aNotB = a.filter((x) => !b.some((y) => bsonEqual(x, y)));
  const bNotA = b.filter((x) => !a.some((y) => bsonEqual(x, y)));
  return uniq(aNotB.concat(bNotA));
}
function zip(arrays) {
  const len = arrays.reduce((m, a) => Math.max(m, a.length), 0);
  const out = [];
  for (let i = 0; i < len; i++) out.push(arrays.map((a) => i < a.length ? a[i] : null));
  return out;
}
function unzip(rows) {
  const cols = Array.isArray(rows[0]) ? rows[0].length : 0;
  const out = [];
  for (let j = 0; j < cols; j++) out.push(rows.map((r) => r[j]));
  return out;
}

// src/const-eval.ts
var isOpaqueBson = isOpaqueBsonValue;
var NO = { ok: false };
function ok(value) {
  return { ok: true, value };
}
function isPrimitive(v) {
  return v === null || typeof v === "number" || typeof v === "string" || typeof v === "boolean";
}
function finiteResult(n, node) {
  if (Number.isFinite(n)) return ok(n);
  throw new CodegenError(
    `This constant expression evaluates to ${Number.isNaN(n) ? "NaN" : n > 0 ? "Infinity" : "-Infinity"}, which has no MongoDB literal. Check the arithmetic (e.g. division by zero, or an out-of-range exponent).`,
    node.pos
  );
}
function evalConst(node, env, ctx) {
  switch (node.type) {
    case "NumberLiteral":
      return ok(node.value);
    case "StringLiteral":
      return ok(node.value);
    case "BooleanLiteral":
      return ok(node.value);
    case "NullLiteral":
      return ok(null);
    case "ObjectIdLiteral":
      return ok(new ObjectId(node.hex));
    case "ArrayLiteral":
      return evalArray(node.elements, env, ctx);
    case "ObjectLiteral":
      return evalObject(node.entries, env, ctx);
    case "TemplateLiteral":
      return evalTemplate(node.quasis, node.expressions, env, ctx);
    case "UnaryExpr":
      return evalUnary(node, env, ctx);
    case "BinaryExpr":
      return evalBinary(node, env, ctx);
    case "TernaryExpr": {
      const c = evalConst(node.condition, env, ctx);
      if (!c.ok) return NO;
      if (typeof c.value !== "boolean") return NO;
      return evalConst(c.value ? node.consequent : node.alternate, env, ctx);
    }
    case "ParamRef": {
      if (env.has(node.name)) return ok(env.get(node.name));
      if (ctx.bindings?.has(node.name)) return ok(ctx.bindings.get(node.name));
      return NO;
    }
    case "NewDate": {
      const d = foldConstantDate(node.args);
      return d !== null ? ok(d) : NO;
    }
    case "DateUTC": {
      const asDate = foldConstantDate([node]);
      return asDate !== null ? ok(asDate.getTime()) : NO;
    }
    case "NewSet":
      return node.arg === null ? ok([]) : evalConst(node.arg, env, ctx);
    case "IndexAccess":
      return evalIndex(node, env, ctx);
    case "MemberAccess": {
      if (node.member === "length") {
        const recv2 = evalConst(node.object, env, ctx);
        if (!recv2.ok) return NO;
        const v = recv2.value;
        if (typeof v === "string" || Array.isArray(v)) return ok(v.length);
        return NO;
      }
      const recv = evalConst(node.object, env, ctx);
      if (!recv.ok) return NO;
      const obj2 = recv.value;
      if (node.optional && (obj2 === null || obj2 === void 0)) return ok(null);
      if (obj2 !== null && typeof obj2 === "object" && Object.prototype.hasOwnProperty.call(obj2, node.member)) {
        return ok(obj2[node.member]);
      }
      return NO;
    }
    case "MethodCall":
      return evalMethodCall(node.object, node.method, node.args, !!node.optional, env, ctx);
    // Added incrementally under the consistency test (fidelity-sensitive):
    // Math/Number/Object statics, type casts, bitwise & logical ops.
    default:
      return NO;
  }
}
function evalArray(elements, env, ctx) {
  const out = [];
  for (const el of elements) {
    if (el.type === "SpreadElement") {
      const r2 = evalConst(el.argument, env, ctx);
      if (!r2.ok) return NO;
      if (!Array.isArray(r2.value)) return NO;
      for (const v of r2.value) out.push(v);
      continue;
    }
    if (el.type === "AssignExpr" || el.type === "DeleteStmt" || el.type === "LetDecl" || el.type === "FuncDecl") {
      return NO;
    }
    const r = evalConst(el, env, ctx);
    if (!r.ok) return NO;
    out.push(r.value);
  }
  return ok(out);
}
function evalObject(entries, env, ctx) {
  const out = {};
  for (const entry of entries) {
    if (entry.type === "SpreadElement") {
      const r = evalConst(entry.argument, env, ctx);
      if (!r.ok) return NO;
      const v = r.value;
      if (v === null || typeof v !== "object" || Array.isArray(v)) return NO;
      for (const [k, val2] of Object.entries(v)) out[k] = val2;
      continue;
    }
    let key;
    if (entry.key.kind === "static") {
      key = entry.key.name;
    } else {
      const k = evalConst(entry.key.expr, env, ctx);
      if (!k.ok) return NO;
      if (typeof k.value !== "string" && typeof k.value !== "number") return NO;
      key = String(k.value);
    }
    const val = evalConst(entry.value, env, ctx);
    if (!val.ok) return NO;
    out[key] = val.value;
  }
  return ok(out);
}
function evalTemplate(quasis, expressions, env, ctx) {
  let out = quasis[0] ?? "";
  for (let i = 0; i < expressions.length; i++) {
    const r = evalConst(expressions[i], env, ctx);
    if (!r.ok) return NO;
    if (typeof r.value !== "string") return NO;
    out += r.value + (quasis[i + 1] ?? "");
  }
  return ok(out);
}
function evalUnary(node, env, ctx) {
  const r = evalConst(node.operand, env, ctx);
  if (!r.ok) return NO;
  const v = r.value;
  switch (node.op) {
    case "-":
      if (typeof v === "number") return finiteResult(-v, node);
      return NO;
    case "!":
      if (typeof v === "boolean") return ok(!v);
      return NO;
    // "~" (bitwise not) is fidelity-sensitive (int vs long); added under test.
    default:
      return NO;
  }
}
function evalBinary(node, env, ctx) {
  const op = node.op;
  const L = evalConst(node.left, env, ctx);
  if (!L.ok) return NO;
  if (op === "??") {
    return L.value === null || L.value === void 0 ? evalConst(node.right, env, ctx) : ok(L.value);
  }
  const R = evalConst(node.right, env, ctx);
  if (!R.ok) return NO;
  const a = L.value;
  const b = R.value;
  switch (op) {
    case "+":
      if (typeof a === "number" && typeof b === "number") return finiteResult(a + b, node);
      if (typeof a === "string" && typeof b === "string") return ok(a + b);
      return NO;
    case "-":
      if (typeof a === "number" && typeof b === "number") return finiteResult(a - b, node);
      return NO;
    case "*":
      if (typeof a === "number" && typeof b === "number") return finiteResult(a * b, node);
      return NO;
    case "/":
      if (typeof a === "number" && typeof b === "number") return finiteResult(a / b, node);
      return NO;
    case "%":
      if (typeof a === "number" && typeof b === "number") return finiteResult(a % b, node);
      return NO;
    case "**":
      if (typeof a === "number" && typeof b === "number") return finiteResult(a ** b, node);
      return NO;
    case "===":
      if (isPrimitive(a) && isPrimitive(b)) return ok(a === b);
      return NO;
    case "!==":
      if (isPrimitive(a) && isPrimitive(b)) return ok(a !== b);
      return NO;
    case "==":
      if (isPrimitive(a) && isPrimitive(b)) return ok(a === null || b === null ? a === b : a === b);
      return NO;
    case "!=":
      if (isPrimitive(a) && isPrimitive(b)) return ok(a !== b);
      return NO;
    case "<":
      if (typeof a === "number" && typeof b === "number") return ok(a < b);
      return NO;
    case ">":
      if (typeof a === "number" && typeof b === "number") return ok(a > b);
      return NO;
    case "<=":
      if (typeof a === "number" && typeof b === "number") return ok(a <= b);
      return NO;
    case ">=":
      if (typeof a === "number" && typeof b === "number") return ok(a >= b);
      return NO;
    case "in":
      if (Array.isArray(b)) return ok(b.includes(a));
      return NO;
    // "&&" / "||" (operand-return vs MQL boolean) and "&" / "|" / "^" (int vs
    // long typing) are fidelity-sensitive; added under test.
    default:
      return NO;
  }
}
function evalIndex(node, env, ctx) {
  const objR = evalConst(node.object, env, ctx);
  if (!objR.ok) return NO;
  const idxR = evalConst(node.index, env, ctx);
  if (!idxR.ok) return NO;
  const obj2 = objR.value;
  const idx = idxR.value;
  if (node.optional && (obj2 === null || obj2 === void 0)) return ok(null);
  if (Array.isArray(obj2) && typeof idx === "number") {
    if (idx >= 0 && Number.isInteger(idx)) return ok(idx < obj2.length ? obj2[idx] : null);
    return NO;
  }
  if (typeof obj2 === "string" && typeof idx === "number") {
    if (idx >= 0 && Number.isInteger(idx)) return ok(idx < obj2.length ? obj2[idx] : null);
    return NO;
  }
  if (obj2 !== null && typeof obj2 === "object" && typeof idx === "string") {
    return Object.prototype.hasOwnProperty.call(obj2, idx) ? ok(obj2[idx]) : ok(null);
  }
  return NO;
}
var NON_FOLDABLE = /* @__PURE__ */ Symbol("non-foldable");
function asciiUpper2(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 97 && c <= 122 ? String.fromCharCode(c - 32) : s[i];
  }
  return out;
}
function asciiLower2(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : s[i];
  }
  return out;
}
function interpretLambda(lambda, env, ctx) {
  return (...args) => {
    const child = new Map(env);
    lambda.params.forEach((p, i) => child.set(p, args[i]));
    let bodyExpr;
    if (lambda.exprBlock) {
      for (const decl of lambda.exprBlock.decls) {
        const r2 = evalConst(decl.value, child, ctx);
        if (!r2.ok) throw NON_FOLDABLE;
        child.set(decl.name, r2.value);
      }
      bodyExpr = lambda.exprBlock.ret;
    } else if (lambda.body) {
      bodyExpr = lambda.body;
    } else {
      throw NON_FOLDABLE;
    }
    const r = evalConst(bodyExpr, child, ctx);
    if (!r.ok) throw NON_FOLDABLE;
    return r.value;
  };
}
function evalArgValues(args, env, ctx) {
  const out = [];
  for (const a of args) {
    if (a.type === "SpreadElement") {
      const r = evalConst(a.argument, env, ctx);
      if (!r.ok || !Array.isArray(r.value)) throw NON_FOLDABLE;
      for (const v of r.value) out.push(v);
    } else {
      const r = evalConst(a, env, ctx);
      if (!r.ok) throw NON_FOLDABLE;
      out.push(r.value);
    }
  }
  return out;
}
function requireLambdaArg(args, env, ctx) {
  const first = args[0];
  if (!first || first.type !== "Lambda") throw NON_FOLDABLE;
  return interpretLambda(first, env, ctx);
}
function resolveIterateeFn(arg, method, env, ctx) {
  if (arg === void 0) return (el) => el;
  if (arg.type === "SpreadElement") throw NON_FOLDABLE;
  if (arg.type === "Lambda") {
    const fn2 = interpretLambda(arg, env, ctx);
    return (el, i) => fn2(el, i);
  }
  const lam = shorthandToLambda(arg, method, "__jsmqlIt");
  if (lam === null) throw NON_FOLDABLE;
  const fn = interpretLambda(lam, env, ctx);
  return (el) => fn(el);
}
function keyStr(v) {
  const s = mqlKeyString(v);
  if (s === void 0) throw NON_FOLDABLE;
  return s;
}
function evalMethodCall(object, method, args, optional, env, ctx) {
  const recvR = evalConst(object, env, ctx);
  if (!recvR.ok) return NO;
  const recv = recvR.value;
  if (optional && (recv === null || recv === void 0)) return ok(null);
  try {
    if (typeof recv === "string") return foldStringMethod(recv, method, args, env, ctx);
    if (typeof recv === "number") return foldNumberMethod(recv, method, args, env, ctx);
    if (Array.isArray(recv)) return foldArrayMethod(recv, method, args, env, ctx);
    if (recv !== null && typeof recv === "object" && !isOpaqueBson(recv)) {
      return foldObjectMethod(recv, method, args, env, ctx);
    }
    return NO;
  } catch (e) {
    if (e === NON_FOLDABLE) return NO;
    throw e;
  }
}
function foldStringMethod(s, method, args, env, ctx) {
  switch (method) {
    case "toUpperCase":
      return ok(asciiUpper2(s));
    case "toLowerCase":
      return ok(asciiLower2(s));
    case "trim":
      return ok(s.trim());
    case "trimStart":
    case "trimLeft":
      return ok(s.trimStart());
    case "trimEnd":
    case "trimRight":
      return ok(s.trimEnd());
    case "startsWith":
    case "endsWith":
    case "includes":
    case "indexOf":
    case "lastIndexOf":
    case "charAt":
    case "slice":
    case "substring":
    case "repeat":
    case "padStart":
    case "padEnd": {
      const a = evalArgValues(args, env, ctx);
      const fn = s[method];
      return ok(fn.apply(s, a));
    }
    case "split": {
      const a = evalArgValues(args, env, ctx);
      if (a.length === 0 || typeof a[0] !== "string" || a[0] === "") throw NON_FOLDABLE;
      return ok(s.split(...a));
    }
    // lodash string methods — MQL-faithful JS impls in lodash-fold.ts.
    case "capitalize":
      return ok(capitalize(s));
    case "upperFirst":
      return ok(upperFirst(s));
    case "lowerFirst":
      return ok(lowerFirst(s));
    case "words":
      return ok(words(s));
    case "kebabCase":
      return ok(kebabCase(s));
    case "snakeCase":
      return ok(snakeCase(s));
    case "startCase":
      return ok(startCase(s));
    case "camelCase":
      return ok(camelCase(s));
    case "escape":
      return ok(escape(s));
    case "truncate":
      return foldTruncate(s, args, env, ctx);
    default:
      throw NON_FOLDABLE;
  }
}
function foldTruncate(s, args, env, ctx) {
  let length = 30;
  let omission = "...";
  if (args.length > 0) {
    const optsR = evalConst(args[0].type === "SpreadElement" ? args[0].argument : args[0], env, ctx);
    if (!optsR.ok) throw NON_FOLDABLE;
    const opts = optsR.value;
    if (opts === null || typeof opts !== "object" || Array.isArray(opts)) throw NON_FOLDABLE;
    const o = opts;
    if ("separator" in o) throw NON_FOLDABLE;
    if ("length" in o) {
      if (typeof o.length !== "number") throw NON_FOLDABLE;
      length = o.length;
    }
    if ("omission" in o) {
      if (typeof o.omission !== "string") throw NON_FOLDABLE;
      omission = o.omission;
    }
  }
  return ok(truncate(s, length, omission));
}
function foldArrayMethod(arr, method, args, env, ctx) {
  switch (method) {
    case "map":
      return ok(arr.map((el, i) => requireLambdaArg(args, env, ctx)(el, i)));
    case "filter":
      return ok(arr.filter((el, i) => requireLambdaArg(args, env, ctx)(el, i)));
    case "some":
      return ok(arr.some((el, i) => requireLambdaArg(args, env, ctx)(el, i)));
    case "every":
      return ok(arr.every((el, i) => requireLambdaArg(args, env, ctx)(el, i)));
    case "find": {
      const found = arr.find((el, i) => requireLambdaArg(args, env, ctx)(el, i));
      if (found === void 0) throw NON_FOLDABLE;
      return ok(found);
    }
    case "flatMap":
      return ok(arr.flatMap((el, i) => requireLambdaArg(args, env, ctx)(el, i)));
    case "reduce": {
      const fn = requireLambdaArg(args, env, ctx);
      const init = evalArgValues(args.slice(1), env, ctx);
      if (init.length === 0) throw NON_FOLDABLE;
      return ok(arr.reduce((acc2, el, i) => fn(acc2, el, i), init[0]));
    }
    // `.slice` folds via the real `Array.prototype.slice`: its value-mode lowering
    // now matches ECMAScript slice (start/exclusive-end, negatives from the end),
    // so the fold agrees with the runtime. (`.flat` is still NOT folded — it has
    // no faithful lowering for a non-nested array; it stays runtime.)
    case "slice":
    case "concat":
    case "includes":
    case "indexOf":
    case "lastIndexOf":
    case "join":
    case "at":
    case "toReversed": {
      const a = evalArgValues(args, env, ctx);
      const fn = arr[method];
      return ok(fn.apply(arr, a));
    }
    // ── lodash array methods (non-iteratee) ─────────────────────────────────
    case "sum":
      return ok(sum(arr));
    case "mean":
      return ok(mean(arr));
    case "min":
    case "max": {
      if (arr.length === 0) return ok(null);
      if (!arr.every((x) => typeof x === "number")) throw NON_FOLDABLE;
      return ok(method === "min" ? Math.min(...arr) : Math.max(...arr));
    }
    case "uniq":
    case "sortedUniq":
      return ok(uniq(arr));
    case "compact":
      return ok(compact(arr));
    case "flatten":
      return ok(flatten(arr));
    case "chunk": {
      const [size] = evalArgValues(args, env, ctx);
      if (typeof size !== "number" || !Number.isInteger(size) || size < 1) throw NON_FOLDABLE;
      return ok(chunk(arr, size));
    }
    case "take":
    case "drop":
    case "takeRight":
    case "dropRight": {
      const a = evalArgValues(args, env, ctx);
      const n = a.length > 0 ? a[0] : 1;
      if (typeof n !== "number" || n < 0) throw NON_FOLDABLE;
      return ok(
        method === "take" ? take(arr, n) : method === "drop" ? drop(arr, n) : method === "takeRight" ? takeRight(arr, n) : dropRight(arr, n)
      );
    }
    case "tail":
      return ok(drop(arr, 1));
    case "initial":
      return ok(dropRight(arr, 1));
    case "head":
    case "first":
      if (arr.length === 0) throw NON_FOLDABLE;
      return ok(arr[0]);
    case "last":
      if (arr.length === 0) throw NON_FOLDABLE;
      return ok(arr[arr.length - 1]);
    case "nth": {
      const a = evalArgValues(args, env, ctx);
      const nRaw = a.length > 0 ? a[0] : 0;
      if (typeof nRaw !== "number" || !Number.isInteger(nRaw)) throw NON_FOLDABLE;
      const idx = nRaw < 0 ? arr.length + nRaw : nRaw;
      if (idx < 0 || idx >= arr.length) throw NON_FOLDABLE;
      return ok(arr[idx]);
    }
    case "size":
      return ok(arr.length);
    case "without": {
      const values = evalArgValues(args, env, ctx);
      return ok(without(arr, values));
    }
    // ── lodash array methods (iteratee / predicate) ─────────────────────────
    case "sumBy":
      return ok(sum(arr.map(resolveIterateeFn(args[0], method, env, ctx))));
    case "meanBy":
      return ok(mean(arr.map(resolveIterateeFn(args[0], method, env, ctx))));
    case "minBy":
    case "maxBy": {
      if (arr.length === 0) throw NON_FOLDABLE;
      const it = resolveIterateeFn(args[0], method, env, ctx);
      const keyed = arr.map((el, i) => ({ el, k: it(el, i) }));
      if (!keyed.every((x) => typeof x.k === "number")) throw NON_FOLDABLE;
      const sorted = keyed.map((x, i) => ({ ...x, i })).sort((a, b) => a.k - b.k || a.i - b.i);
      return ok(sorted[method === "maxBy" ? sorted.length - 1 : 0].el);
    }
    case "uniqBy":
    case "sortedUniqBy": {
      const it = resolveIterateeFn(args[0], method, env, ctx);
      const seen = [];
      const out = [];
      arr.forEach((el, i) => {
        const k = it(el, i);
        if (!seen.some((s) => bsonEqual(s, k))) {
          seen.push(k);
          out.push(el);
        }
      });
      return ok(out);
    }
    case "keyBy": {
      const it = resolveIterateeFn(args[0], "keyBy", env, ctx);
      const out = {};
      arr.forEach((el, i) => out[keyStr(it(el, i))] = el);
      return ok(out);
    }
    case "groupBy":
    case "countBy": {
      const it = resolveIterateeFn(args[0], method, env, ctx);
      const groups = /* @__PURE__ */ new Map();
      arr.forEach((el, i) => {
        const k = keyStr(it(el, i));
        (groups.get(k) ?? groups.set(k, []).get(k)).push(el);
      });
      const out = {};
      for (const [k, els] of groups) out[k] = method === "countBy" ? els.length : els;
      return ok(out);
    }
    case "partition":
    case "reject": {
      const p = resolveIterateeFn(args[0], method, env, ctx);
      const yes = [];
      const no = [];
      arr.forEach((el, i) => (p(el, i) ? yes : no).push(el));
      return ok(method === "reject" ? no : [yes, no]);
    }
    case "takeWhile":
    case "dropWhile":
    case "takeRightWhile":
    case "dropRightWhile": {
      const p = resolveIterateeFn(args[0], method, env, ctx);
      const fromRight = method === "takeRightWhile" || method === "dropRightWhile";
      const drop2 = method === "dropWhile" || method === "dropRightWhile";
      const seq = fromRight ? [...arr].reverse() : arr;
      let cut = 0;
      while (cut < seq.length && p(seq[cut], cut)) cut++;
      const kept = drop2 ? seq.slice(cut) : seq.slice(0, cut);
      return ok(fromRight ? kept.reverse() : kept);
    }
    case "sortBy":
    case "orderBy":
      return foldSort(arr, method, args, env, ctx);
    // ── lodash set operations ───────────────────────────────────────────────
    case "xor": {
      const [other] = evalArgValues(args, env, ctx);
      if (!Array.isArray(other)) throw NON_FOLDABLE;
      return ok(xor(arr, other));
    }
    case "differenceBy":
    case "intersectionBy": {
      if (args.length !== 2) throw NON_FOLDABLE;
      const other = evalConst(args[0].type === "SpreadElement" ? args[0].argument : args[0], env, ctx);
      if (!other.ok || !Array.isArray(other.value)) throw NON_FOLDABLE;
      const it = resolveIterateeFn(args[1], method, env, ctx);
      const otherKeys = other.value.map((el, i) => it(el, i));
      const inOther = (el, i) => otherKeys.some((k) => bsonEqual(k, it(el, i)));
      return ok(arr.filter((el, i) => method === "intersectionBy" ? inOther(el, i) : !inOther(el, i)));
    }
    case "unionBy":
    case "xorBy": {
      if (args.length !== 2) throw NON_FOLDABLE;
      const other = evalConst(args[0].type === "SpreadElement" ? args[0].argument : args[0], env, ctx);
      if (!other.ok || !Array.isArray(other.value)) throw NON_FOLDABLE;
      const it = resolveIterateeFn(args[1], method, env, ctx);
      const uniqByKey = (xs) => {
        const seen = [];
        const out = [];
        xs.forEach((el, i) => {
          const k = it(el, i);
          if (!seen.some((s) => bsonEqual(s, k))) {
            seen.push(k);
            out.push(el);
          }
        });
        return out;
      };
      if (method === "unionBy") return ok(uniqByKey(arr.concat(other.value)));
      const aKeys = arr.map((el, i) => it(el, i));
      const bKeys = other.value.map((el, i) => it(el, i));
      const aNotB = arr.filter((el, i) => !bKeys.some((k) => bsonEqual(k, it(el, i))));
      const bNotA = other.value.filter((el, i) => !aKeys.some((k) => bsonEqual(k, it(el, i))));
      return ok(uniqByKey(aNotB.concat(bNotA)));
    }
    // ── lodash zip family ───────────────────────────────────────────────────
    case "zip": {
      const others = evalArgValues(args, env, ctx);
      if (!others.every(Array.isArray)) throw NON_FOLDABLE;
      return ok(zip([arr, ...others]));
    }
    case "zipWith": {
      if (args.length < 2) throw NON_FOLDABLE;
      const fn = requireLambdaArg([args[args.length - 1]], env, ctx);
      const others = evalArgValues(args.slice(0, -1), env, ctx);
      if (!others.every(Array.isArray)) throw NON_FOLDABLE;
      const arrays = [arr, ...others];
      const len = arrays.reduce((m, a) => Math.max(m, a.length), 0);
      const out = [];
      for (let i = 0; i < len; i++) out.push(fn(...arrays.map((a) => i < a.length ? a[i] : null)));
      return ok(out);
    }
    case "unzip":
      if (!arr.every(Array.isArray)) throw NON_FOLDABLE;
      return ok(unzip(arr));
    case "zipObject": {
      const [values] = evalArgValues(args, env, ctx);
      if (!Array.isArray(values)) throw NON_FOLDABLE;
      const out = {};
      arr.forEach((k, i) => out[keyStr(k)] = values[i] === void 0 ? null : values[i]);
      return ok(out);
    }
    case "fromPairs": {
      const out = {};
      for (const pair of arr) {
        if (!Array.isArray(pair)) throw NON_FOLDABLE;
        out[keyStr(pair[0])] = pair[1] === void 0 ? null : pair[1];
      }
      return ok(out);
    }
    default:
      throw NON_FOLDABLE;
  }
}
function fieldGetter(path) {
  const segs = path.split(".");
  return (v) => {
    let cur = v;
    for (const s of segs) {
      if (cur === null || cur === void 0 || typeof cur !== "object") return void 0;
      cur = cur[s];
    }
    return cur;
  };
}
function scalarCompare(a, b) {
  if (a === null || a === void 0 || b === null || b === void 0) throw NON_FOLDABLE;
  if (typeof a === "number" && typeof b === "number") return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  throw NON_FOLDABLE;
}
function orderDir(v) {
  if (v === 1 || v === "asc") return 1;
  if (v === -1 || v === "desc") return -1;
  throw NON_FOLDABLE;
}
function foldSort(arr, method, args, env, ctx) {
  const specs = [];
  if (method === "sortBy") {
    const arg = args[0];
    if (arg === void 0) specs.push({ get: (el) => el, dir: 1 });
    else if (arg.type === "StringLiteral") specs.push({ get: fieldGetter(arg.value), dir: 1 });
    else if (arg.type === "Lambda") {
      const fn = interpretLambda(arg, env, ctx);
      specs.push({ get: (el) => fn(el), dir: 1 });
    } else if (arg.type === "ArrayLiteral") {
      for (const e of arg.elements) {
        if (e.type !== "StringLiteral") throw NON_FOLDABLE;
        specs.push({ get: fieldGetter(e.value), dir: 1 });
      }
    } else throw NON_FOLDABLE;
  } else {
    const arg = args[0];
    if (arg !== void 0 && arg.type === "ObjectLiteral") {
      if (args.length > 1) throw NON_FOLDABLE;
      for (const entry of arg.entries) {
        if (entry.type !== "KeyValueEntry" || entry.key.kind !== "static") throw NON_FOLDABLE;
        const dv = evalConst(entry.value, env, ctx);
        if (!dv.ok) throw NON_FOLDABLE;
        specs.push({ get: fieldGetter(entry.key.name), dir: orderDir(dv.value) });
      }
    } else {
      const keys = args[0] === void 0 ? void 0 : evalConst(args[0].type === "SpreadElement" ? args[0].argument : args[0], env, ctx);
      if (!keys || !keys.ok) throw NON_FOLDABLE;
      const keyList = Array.isArray(keys.value) ? keys.value : [keys.value];
      const ordersArg = args[1];
      const orders = ordersArg === void 0 ? void 0 : evalConst(ordersArg.type === "SpreadElement" ? ordersArg.argument : ordersArg, env, ctx);
      const orderList = orders && orders.ok ? Array.isArray(orders.value) ? orders.value : [orders.value] : [];
      keyList.forEach((k, i) => {
        if (typeof k !== "string") throw NON_FOLDABLE;
        specs.push({ get: fieldGetter(k), dir: orderList[i] === void 0 ? 1 : orderDir(orderList[i]) });
      });
    }
  }
  const decorated = arr.map((el, i) => ({ el, i }));
  decorated.sort((A, B) => {
    for (const { get, dir } of specs) {
      const c = scalarCompare(get(A.el), get(B.el));
      if (c !== 0) return dir * c;
    }
    return A.i - B.i;
  });
  return ok(decorated.map((d) => d.el));
}
function foldNumberMethod(n, method, args, env, ctx) {
  const a = evalArgValues(args, env, ctx);
  switch (method) {
    case "clamp":
      if (a.length !== 2 || typeof a[0] !== "number" || typeof a[1] !== "number") throw NON_FOLDABLE;
      return ok(clamp(n, a[0], a[1]));
    case "inRange":
      if (a.length < 1 || a.length > 2 || !a.every((x) => typeof x === "number")) throw NON_FOLDABLE;
      return ok(inRange(n, a[0], a[1]));
    case "round":
    case "ceil":
    case "floor": {
      if (a.length > 1) throw NON_FOLDABLE;
      const p = a.length === 1 ? a[0] : 0;
      if (typeof p !== "number" || !Number.isInteger(p)) throw NON_FOLDABLE;
      const r = method === "round" ? round(n, p) : method === "ceil" ? ceilN(n, p) : floorN(n, p);
      return Number.isFinite(r) ? ok(r) : NO;
    }
    default:
      throw NON_FOLDABLE;
  }
}
function foldObjectMethod(obj2, method, args, env, ctx) {
  switch (method) {
    case "size":
      return ok(Object.keys(obj2).length);
    case "toPairs":
      return ok(Object.entries(obj2).map(([k, v]) => [k, v]));
    case "invert": {
      const out = {};
      for (const [k, v] of Object.entries(obj2)) {
        const nk = mqlKeyString(v);
        if (nk === void 0) throw NON_FOLDABLE;
        out[nk] = k;
      }
      return ok(out);
    }
    case "pick":
    case "omit": {
      const keys = pickKeyList(args);
      if (method === "pick") {
        const out2 = {};
        for (const k of keys) if (Object.prototype.hasOwnProperty.call(obj2, k)) out2[k] = obj2[k];
        return ok(out2);
      }
      const out = {};
      for (const [k, v] of Object.entries(obj2)) if (!keys.includes(k)) out[k] = v;
      return ok(out);
    }
    case "mapValues": {
      const fn = requireLambdaArg(args, env, ctx);
      const out = {};
      for (const [k, v] of Object.entries(obj2)) out[k] = fn(v, k);
      return ok(out);
    }
    case "mapKeys": {
      const fn = requireLambdaArg(args, env, ctx);
      const out = {};
      for (const [k, v] of Object.entries(obj2)) {
        const nk = mqlKeyString(fn(v, k));
        if (nk === void 0) throw NON_FOLDABLE;
        out[nk] = v;
      }
      return ok(out);
    }
    case "pickBy":
    case "omitBy": {
      const fn = requireLambdaArg(args, env, ctx);
      const out = {};
      for (const [k, v] of Object.entries(obj2)) {
        const keep = !!fn(v, k);
        if (method === "pickBy" ? keep : !keep) out[k] = v;
      }
      return ok(out);
    }
    default:
      throw NON_FOLDABLE;
  }
}
function pickKeyList(args) {
  const first = args[0];
  if (!first || first.type !== "ArrayLiteral") throw NON_FOLDABLE;
  const keys = [];
  for (const el of first.elements) {
    if (el.type !== "StringLiteral") throw NON_FOLDABLE;
    keys.push(el.value);
  }
  return keys;
}

// src/codegen.ts
var CodegenError = class extends Error {
  constructor(message, pos = 0) {
    super(message);
    this.name = "CodegenError";
    this.pos = pos;
  }
};
function internalError(detail, pos = 0) {
  throw new CodegenError(`jsmql internal error (please report to the jsmql maintainers): ${detail}`, pos);
}
var UnknownIdentifierError = class extends CodegenError {
  constructor(identifier, pos = 0) {
    super(`Unknown identifier '${identifier}'. Did you mean '$.${identifier}'?`, pos);
    this.name = "UnknownIdentifierError";
    this.identifier = identifier;
  }
};
var EMPTY_CTX = { lambdaParams: /* @__PURE__ */ new Set() };
function extendCtx(ctx, params) {
  return {
    lambdaParams: /* @__PURE__ */ new Set([...ctx.lambdaParams, ...params]),
    reduceRemap: ctx.reduceRemap,
    pipelineLets: ctx.pipelineLets,
    pipelineConstNames: ctx.pipelineConstNames,
    droppedLets: ctx.droppedLets,
    bindings: ctx.bindings,
    bindingTypes: ctx.bindingTypes,
    insideLiteral: ctx.insideLiteral,
    pipelineContext: ctx.pipelineContext,
    topLevelStream: ctx.topLevelStream,
    substreamLengthHandles: ctx.substreamLengthHandles,
    rootStreamLengthVar: ctx.rootStreamLengthVar,
    slotAllocator: ctx.slotAllocator,
    accumulatorContext: ctx.accumulatorContext,
    aggExpr: ctx.aggExpr,
    functions: ctx.functions,
    expandingFns: ctx.expandingFns
  };
}
function elementTypedCtx(ctx, params, inputExpr) {
  const base = extendCtx(ctx, params);
  if (params.length === 0) return base;
  const elementType = inputExpr ? arrayElementType(inputExpr) : void 0;
  const shadows = params.some((p) => ctx.bindingTypes?.has(p));
  if (!elementType && !shadows) return base;
  const bindingTypes = new Map(ctx.bindingTypes ?? []);
  for (const p of params) bindingTypes.delete(p);
  if (elementType) bindingTypes.set(params[0], elementType);
  return { ...base, bindingTypes };
}
function extendCtxLets(ctx, name, fieldPath, kind = "let", type) {
  const next = new Map(ctx.pipelineLets ?? []);
  next.set(name, fieldPath);
  let bindingTypes = ctx.bindingTypes;
  if (kind === "const" && type) {
    const bt = new Map(ctx.bindingTypes ?? []);
    bt.set(name, type);
    bindingTypes = bt;
  }
  if (kind !== "const") return { ...ctx, pipelineLets: next, bindingTypes };
  const consts = new Set(ctx.pipelineConstNames ?? []);
  consts.add(name);
  return { ...ctx, pipelineLets: next, pipelineConstNames: consts, bindingTypes };
}
function clearCtxLets(ctx, droppedByStage) {
  if (!ctx.pipelineLets || ctx.pipelineLets.size === 0) return ctx;
  const dropped = new Map(ctx.droppedLets ?? []);
  for (const name of ctx.pipelineLets.keys()) dropped.set(name, droppedByStage);
  return { ...ctx, pipelineLets: /* @__PURE__ */ new Map(), pipelineConstNames: /* @__PURE__ */ new Set(), droppedLets: dropped };
}
function ctxHasLets(ctx) {
  return (ctx.pipelineLets?.size ?? 0) > 0;
}
function freshSubPipelineCtx(outer) {
  return {
    lambdaParams: /* @__PURE__ */ new Set(),
    bindings: outer.bindings,
    pipelineContext: outer.pipelineContext,
    // The slot allocator is a pipeline-global resource (gensym counter for
    // `__jsmql.tmp.<N>`), not per-document state, so it crosses sub-pipeline
    // boundaries — a lookup materialised inside a `.map` block keeps allocating
    // from the enclosing chain's counter. Undefined unless an enclosing chain
    // set it, so ordinary sub-pipelines still start their own counter.
    slotAllocator: outer.slotAllocator
  };
}
function freshFacetCtx(outer) {
  return {
    lambdaParams: /* @__PURE__ */ new Set(),
    bindings: outer.bindings,
    pipelineLets: outer.pipelineLets,
    pipelineConstNames: outer.pipelineConstNames,
    bindingTypes: outer.bindingTypes,
    pipelineContext: outer.pipelineContext,
    // Functions declared before the $facet are visible inside its branches,
    // mirroring the outer-lets rule above.
    functions: outer.functions,
    expandingFns: outer.expandingFns
  };
}
function extendCtxFunctions(ctx, decl) {
  const next = new Map(ctx.functions ?? []);
  next.set(decl.name, decl);
  return { ...ctx, functions: next };
}
function withBindings(ctx, bindings) {
  return { ...ctx, bindings };
}
var STRING_OUTPUT_OPS = /* @__PURE__ */ new Set([
  "$toLower",
  "$toUpper",
  "$trim",
  "$ltrim",
  "$rtrim",
  "$concat",
  "$substrCP",
  "$substrBytes",
  "$substr",
  "$replaceOne",
  "$replaceAll",
  "$dateToString",
  "$type",
  "$strcasecmp",
  "$toString"
]);
var METHODS = {
  // ── String ────────────────────────────────────────────────────────────────
  trim: { returns: "string", optional: "string" },
  trimStart: { returns: "string", optional: "string" },
  trimLeft: { returns: "string", optional: "string" },
  trimEnd: { returns: "string", optional: "string" },
  trimRight: { returns: "string", optional: "string" },
  toLowerCase: { returns: "string", optional: "string" },
  toUpperCase: { returns: "string", optional: "string" },
  substr: { returns: "string", optional: "string" },
  substring: { returns: "string", optional: "string" },
  charAt: { returns: "string", optional: "string" },
  split: { returns: "array", optional: "string" },
  // returns an array, but the receiver is a string
  startsWith: { returns: "bool", optional: "string" },
  endsWith: { returns: "bool", optional: "string" },
  replace: { returns: "string", optional: "string" },
  replaceAll: { returns: "string", optional: "string" },
  match: { optional: "string" },
  matchAll: { optional: "string" },
  search: { returns: "number", optional: "string" },
  padStart: { returns: "string", optional: "string" },
  padEnd: { returns: "string", optional: "string" },
  repeat: { returns: "string", optional: "string" },
  indexOf: { returns: "number", optional: "either" },
  includes: { returns: "bool", optional: "either" },
  // ── Array ─────────────────────────────────────────────────────────────────
  at: { optional: "array" },
  slice: { optional: "either" },
  concat: { optional: "either" },
  reverse: { returns: "array", optional: "array" },
  // throws in expression position; metadata used by the statement-position rewrite
  toReversed: { returns: "array", optional: "array" },
  toSorted: { returns: "array", optional: "array" },
  sortBy: { returns: "array", optional: "array" },
  orderBy: { returns: "array", optional: "array" },
  toSpliced: { returns: "array" },
  with: { returns: "array" },
  flat: { returns: "array", optional: "array" },
  flatMap: { returns: "array", optional: "array" },
  map: { returns: "array", optional: "array" },
  filter: { returns: "array", optional: "array" },
  find: { optional: "array" },
  findIndex: { returns: "number" },
  findLast: { optional: "array" },
  findLastIndex: { returns: "number", optional: "array" },
  lastIndexOf: { returns: "number" },
  some: { returns: "bool", optional: "array" },
  every: { returns: "bool", optional: "array" },
  reduce: { optional: "array" },
  reduceRight: {},
  join: { returns: "string", optional: "array" },
  // returns a string, but the receiver is an array
  // NB `toString` is intentionally left without a `returns` — the key collides with
  // Object.prototype.toString and confuses tsc's contextual typing of the literal;
  // it's also universal (never gated), so its return type doesn't matter here.
  toString: {},
  // ── Mutators (shimmed with tailored errors that point at immutable variants) ─
  sort: {},
  splice: {},
  push: {},
  pop: {},
  shift: {},
  unshift: {},
  fill: {},
  copyWithin: {},
  // ── Iterator / void / locale (shimmed with tailored errors) ─────────────────
  forEach: {},
  entries: {},
  keys: {},
  values: {},
  toLocaleString: {},
  // ── Date ────────────────────────────────────────────────────────────────────
  // The accessors all return a number ($year/$month/…); toISOString → string;
  // plus/minus → a date (same-as-receiver, so returns is omitted).
  getFullYear: { returns: "number", receiver: "date" },
  getMonth: { returns: "number", receiver: "date" },
  getDate: { returns: "number", receiver: "date" },
  getDay: { returns: "number", receiver: "date" },
  getHours: { returns: "number", receiver: "date" },
  getMinutes: { returns: "number", receiver: "date" },
  getSeconds: { returns: "number", receiver: "date" },
  getMilliseconds: { returns: "number", receiver: "date" },
  getUTCFullYear: { returns: "number", receiver: "date" },
  getUTCMonth: { returns: "number", receiver: "date" },
  getUTCDate: { returns: "number", receiver: "date" },
  getUTCDay: { returns: "number", receiver: "date" },
  getUTCHours: { returns: "number", receiver: "date" },
  getUTCMinutes: { returns: "number", receiver: "date" },
  getUTCSeconds: { returns: "number", receiver: "date" },
  getUTCMilliseconds: { returns: "number", receiver: "date" },
  getTime: { returns: "number" },
  // → $toLong, which converts strings/numbers, so the receiver is NOT required to be a date
  toISOString: { returns: "string", receiver: "date" },
  plus: { receiver: "date" },
  minus: { receiver: "date" },
  // ── lodash array methods (Phase 1) ──────────────────────────────────────────
  sum: { returns: "number", optional: "array" },
  mean: { returns: "number", optional: "array" },
  max: { optional: "array" },
  // returns the max ELEMENT (unknown type), not a number
  min: { optional: "array" },
  // returns the min ELEMENT (unknown type), not a number
  sumBy: { returns: "number", optional: "array" },
  meanBy: { returns: "number", optional: "array" },
  minBy: { optional: "array" },
  // returns the ELEMENT with the min key
  maxBy: { optional: "array" },
  // returns the ELEMENT with the max key
  uniq: { returns: "array", optional: "array" },
  uniqBy: { returns: "array", optional: "array" },
  sortedUniq: { returns: "array", optional: "array" },
  sortedUniqBy: { returns: "array", optional: "array" },
  without: { returns: "array", optional: "array" },
  xor: { returns: "array", optional: "array" },
  differenceBy: { returns: "array", optional: "array" },
  intersectionBy: { returns: "array", optional: "array" },
  unionBy: { returns: "array", optional: "array" },
  xorBy: { returns: "array", optional: "array" },
  compact: { returns: "array", optional: "array" },
  flatten: { returns: "array", optional: "array" },
  chunk: { returns: "array", optional: "array" },
  take: { returns: "array", optional: "array" },
  drop: { returns: "array", optional: "array" },
  takeRight: { returns: "array", optional: "array" },
  dropRight: { returns: "array", optional: "array" },
  tail: { returns: "array", optional: "array" },
  initial: { returns: "array", optional: "array" },
  head: { optional: "array" },
  first: { optional: "array" },
  last: { optional: "array" },
  nth: { optional: "array" },
  size: { returns: "number", optional: "array" },
  takeWhile: { returns: "array", optional: "array" },
  dropWhile: { returns: "array", optional: "array" },
  takeRightWhile: { returns: "array", optional: "array" },
  dropRightWhile: { returns: "array", optional: "array" },
  sample: { optional: "array" },
  sampleSize: { returns: "array", optional: "array" },
  zipObject: { returns: "object", optional: "array" },
  zip: { returns: "array", optional: "array" },
  unzip: { returns: "array", optional: "array" },
  zipWith: { returns: "array", optional: "array" },
  unzipWith: {},
  // shimmed with a tailored "use .unzip().map(group => …)" error
  keyBy: { returns: "object", optional: "array" },
  groupBy: { optional: "array" },
  // context-dependent result (value → object, stream → doc-stream); no invariant return
  countBy: { returns: "object", optional: "array" },
  partition: { returns: "array", optional: "array" },
  reject: { returns: "array", optional: "array" },
  // ── lodash object methods (Phase 1) ─────────────────────────────────────────
  mapValues: { returns: "object" },
  mapKeys: { returns: "object" },
  pick: {},
  // context-dependent (value → object, stream → $project doc-stream)
  omit: {},
  // context-dependent (value → object, stream → $project doc-stream)
  pickBy: { returns: "object" },
  omitBy: { returns: "object" },
  invert: { returns: "object" },
  toPairs: { returns: "array" },
  fromPairs: { returns: "object", optional: "array" },
  // ── lodash string methods (Phase 1; ASCII-only) ─────────────────────────────
  capitalize: { returns: "string", optional: "string" },
  upperFirst: { returns: "string", optional: "string" },
  lowerFirst: { returns: "string", optional: "string" },
  words: { returns: "array", optional: "string" },
  kebabCase: { returns: "string", optional: "string" },
  snakeCase: { returns: "string", optional: "string" },
  startCase: { returns: "string", optional: "string" },
  camelCase: { returns: "string", optional: "string" },
  escape: { returns: "string", optional: "string" },
  truncate: { returns: "string", optional: "string" },
  // ── lodash number methods (Phase 1) ─────────────────────────────────────────
  clamp: {},
  // result type follows the receiver/args (number OR date) — no invariant return
  inRange: { returns: "bool" },
  round: { returns: "number" },
  ceil: { returns: "number" },
  floor: { returns: "number" },
  // ── Set (intercepted before generateMethodCall when the receiver is a NewSet,
  //    but listed so a typo on a non-NewSet receiver still surfaces a suggestion) ─
  intersection: {},
  union: {},
  difference: {},
  isSubsetOf: {},
  isSupersetOf: {},
  // ── Regex (intercepted on RegexLiteral receivers; same rationale) ───────────
  test: {},
  exec: {}
};
function methodsWhere(pred) {
  return new Set(Object.keys(METHODS).filter((name) => pred(METHODS[name])));
}
var STRING_RETURNING_METHODS = methodsWhere((m) => m.returns === "string");
var ARRAY_OUTPUT_OPS = /* @__PURE__ */ new Set([
  "$split",
  "$range",
  "$reverseArray",
  "$slice",
  "$map",
  "$filter",
  "$concatArrays",
  "$setUnion",
  "$setIntersection",
  "$setDifference",
  "$zip",
  "$objectToArray"
]);
var ARRAY_RETURNING_METHODS = methodsWhere((m) => m.returns === "array");
function isArrayProducing(expr) {
  switch (expr.type) {
    case "ArrayLiteral":
      return true;
    case "OperatorCall":
      return ARRAY_OUTPUT_OPS.has(expr.name);
    case "MethodCall":
      if (expr.method === "slice") return isArrayProducing(expr.object);
      return ARRAY_RETURNING_METHODS.has(expr.method);
    case "ObjectCall":
      return expr.method === "entries" || expr.method === "keys" || expr.method === "values";
    default:
      return false;
  }
}
function isObjectProducing(expr) {
  return expr.type === "ObjectLiteral";
}
function staticBindingType(expr) {
  if (isArrayProducing(expr)) return "array";
  if (isObjectProducing(expr)) return "object";
  if (isStringProducing(expr)) return "string";
  return void 0;
}
function arrayElementType(expr) {
  switch (expr.type) {
    case "ArrayLiteral": {
      let elementType;
      for (const el of expr.elements) {
        if (el.type === "SpreadElement" || el.type === "AssignExpr" || el.type === "DeleteStmt" || el.type === "LetDecl" || el.type === "FuncDecl") {
          return void 0;
        }
        const t = staticBindingType(el);
        if (t === void 0) return void 0;
        if (elementType === void 0) elementType = t;
        else if (elementType !== t) return void 0;
      }
      return elementType;
    }
    case "MethodCall":
      return expr.method === "split" ? "string" : void 0;
    case "ObjectCall":
      return expr.method === "keys" ? "string" : void 0;
    default:
      return void 0;
  }
}
function isStringProducing(expr) {
  switch (expr.type) {
    case "StringLiteral":
      return true;
    case "TemplateLiteral":
      return true;
    case "OperatorCall":
      return STRING_OUTPUT_OPS.has(expr.name);
    case "MethodCall":
      if (expr.method === "slice") return isStringProducing(expr.object);
      return STRING_RETURNING_METHODS.has(expr.method);
    case "TypeCast":
      return expr.cast === "String";
    case "TypeofExpr":
      return true;
    case "BinaryExpr":
      if (expr.op === "+") {
        const chain = [];
        collectExprChain("+", expr, chain);
        return chain.some((e) => isStringProducing(e));
      }
      return false;
    default:
      return false;
  }
}
var BOOL_OUTPUT_OPS = /* @__PURE__ */ new Set([
  "$eq",
  "$ne",
  "$gt",
  "$gte",
  "$lt",
  "$lte",
  "$and",
  "$or",
  "$not",
  "$in",
  "$regexMatch",
  "$isNumber",
  "$isArray",
  "$allElementsTrue",
  "$anyElementTrue",
  "$setEquals",
  "$setIsSubset"
]);
var BOOL_RETURNING_METHODS = methodsWhere((m) => m.returns === "bool");
function isProvablyBool(expr) {
  switch (expr.type) {
    case "BooleanLiteral":
      return true;
    case "UnaryExpr":
      return expr.op === "!";
    case "BinaryExpr":
      switch (expr.op) {
        case "==":
        case "===":
        case "!=":
        case "!==":
        case "<":
        case "<=":
        case ">":
        case ">=":
        case "in":
          return true;
        case "&&":
        case "||":
          return isProvablyBool(expr.left) && isProvablyBool(expr.right);
        default:
          return false;
      }
    case "TypeCast":
      return expr.cast === "Boolean";
    case "OperatorCall":
      return BOOL_OUTPUT_OPS.has(expr.name);
    case "MethodCall":
      return BOOL_RETURNING_METHODS.has(expr.method);
    default:
      return false;
  }
}
var NUMBER_RECEIVER_METHODS = /* @__PURE__ */ new Set(["round", "ceil", "floor", "inRange"]);
var OBJECT_RECEIVER_METHODS = /* @__PURE__ */ new Set([
  "mapValues",
  "mapKeys",
  "invert",
  "pickBy",
  "omitBy",
  "pick",
  "omit",
  "toPairs"
]);
function requiredReceiverFamily(method) {
  const meta = METHODS[method];
  if (meta === void 0) return null;
  if (method === "size" || method === "toString" || method === "getTime") return null;
  if (meta.receiver === "date") return "date";
  if (NUMBER_RECEIVER_METHODS.has(method)) return "number";
  if (OBJECT_RECEIVER_METHODS.has(method)) return "object";
  if (meta.optional === "string") return "string";
  if (meta.optional === "array") return "array";
  return null;
}
function certainReceiverType(o) {
  if (isProvablyBool(o)) return "bool";
  if (isArrayProducing(o)) return "array";
  if (o.type === "MethodCall") {
    if (o.method === "slice") return certainReceiverType(o.object);
    const r = METHODS[o.method]?.returns;
    if (r === "string" || r === "number" || r === "object") return r;
  }
  return null;
}
var RECEIVER_NOUN = {
  bool: "a boolean",
  string: "a string",
  array: "an array",
  number: "a number",
  date: "a date",
  object: "an object (a document)"
};
function receiverPhrase(o) {
  return o.type === "MethodCall" ? `'.${o.method}(...)'` : "the value before it";
}
function rejectIncompatibleChain(recv, method, object) {
  if (recv === "bool") {
    if (method === "toString" || method === "getTime") return;
    throw new CodegenError(
      `'.${method}(...)' can't run on a boolean \u2014 ${receiverPhrase(object)} evaluates to true/false, which has no methods (only .toString() / .getTime()). Move '.${method}(...)' ahead of the step that collapses the value to a boolean.`,
      object.pos
    );
  }
  const need = requiredReceiverFamily(method);
  if (need === null || need === recv) return;
  const hint = recv === "array" && need === "object" ? `Use it on a single document, or '.map(x => x.${method}(...))' to apply it per element.` : recv === "array" ? `Map over the array first, e.g. '.map(x => x.${method}(...))', or take one element with '.at(0)'.` : recv === "object" && need === "array" ? `Iterate its values with 'Object.values(...)' or its entries with 'Object.entries(...)' / '.toPairs()' first.` : `Call '.${method}(...)' on ${RECEIVER_NOUN[need]} value instead.`;
  throw new CodegenError(
    `'.${method}(...)' expects ${RECEIVER_NOUN[need]} receiver, but ${receiverPhrase(object)} returns ${RECEIVER_NOUN[recv]}. ${hint}`,
    object.pos
  );
}
function jsBool(value) {
  return {
    $and: [
      // Catches both `null` and *missing*. A bare `$ne: [value, null]` does NOT
      // catch missing — MongoDB's `$eq`/`$ne` treat a missing value as distinct
      // from null (`$eq: ["$absent", null]` is false), so `arr.filter(x => x.f)`
      // would wrongly keep elements where `f` is absent. `$ifNull` collapses
      // missing → null first, matching JS where `undefined` is falsy. The other
      // three clauses compare the raw value (false/""/0 are never "missing").
      { $ne: [{ $ifNull: [value, null] }, null] },
      { $ne: [value, false] },
      { $ne: [value, ""] },
      { $ne: [value, 0] }
    ]
  };
}
function jsBoolIfNeeded(srcExpr, generated) {
  return isProvablyBool(srcExpr) ? generated : jsBool(generated);
}
function isPureRef(expr, ctx) {
  return asFieldPath(expr, ctx) !== null;
}
function safeVarName(name) {
  return /^[a-z]/.test(name) ? name : "v" + name;
}
function mongoRegexOptions(jsFlags) {
  let out = "";
  for (const ch of jsFlags) if ("imsx".includes(ch) && !out.includes(ch)) out += ch;
  return out;
}
function gensymInScope(ctx, base) {
  if (!ctx.lambdaParams.has(base)) return base;
  for (let i = 2; ; i++) {
    const name = `${base}${i}`;
    if (!ctx.lambdaParams.has(name)) return name;
  }
}
function clampNonNegativeIndex(node, ctx) {
  if (node.type === "NumberLiteral") return Math.max(0, node.value);
  if (node.type === "UnaryExpr" && node.op === "-" && node.operand.type === "NumberLiteral") {
    return Math.max(0, -node.operand.value);
  }
  return { $max: [0, _generate(node, ctx)] };
}
function clampNonNegativeLength(value) {
  if (typeof value === "number") return Math.max(0, value);
  return { $max: [0, value] };
}
function foldedSubtract(a, b) {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return { $subtract: [a, b] };
}
function cond(ifExpr, thenExpr, elseExpr) {
  return { $cond: { if: ifExpr, then: thenExpr, else: elseExpr } };
}
function normaliseSliceIndex(node, ctx, genObj) {
  if (node.type === "NumberLiteral") {
    if (node.value >= 0) return node.value;
    return foldedSubtract({ $strLenCP: genObj }, -node.value);
  }
  if (node.type === "UnaryExpr" && node.op === "-" && node.operand.type === "NumberLiteral") {
    return foldedSubtract({ $strLenCP: genObj }, node.operand.value);
  }
  const gen = _generate(node, ctx);
  return cond({ $lt: [gen, 0] }, { $add: [gen, { $strLenCP: genObj }] }, gen);
}
function literalIndexValue(node) {
  if (node.type === "NumberLiteral" && Number.isInteger(node.value)) return node.value;
  if (node.type === "UnaryExpr" && node.op === "-" && node.operand.type === "NumberLiteral" && Number.isInteger(node.operand.value)) {
    return -node.operand.value;
  }
  return null;
}
function resolveSliceIndex(node, ctx, size) {
  const lit = literalIndexValue(node);
  if (lit !== null) {
    if (lit === 0) return 0;
    if (lit > 0) return { $min: [lit, size] };
    return { $max: [{ $subtract: [size, -lit] }, 0] };
  }
  const gen = _generate(node, ctx);
  return { $cond: [{ $lt: [gen, 0] }, { $max: [{ $add: [gen, size] }, 0] }, { $min: [gen, size] }] };
}
function sliceArray(genObj, exprArgs, ctx) {
  if (exprArgs.length === 0) return genObj;
  const startNode = exprArgs[0];
  const startLit = literalIndexValue(startNode);
  if (exprArgs.length === 1) {
    if (startLit !== null && startLit < 0) return { $slice: [genObj, startLit] };
    if (startLit === 0) return genObj;
    return {
      $let: {
        vars: { jsmqlArr: genObj },
        in: { $slice: ["$$jsmqlArr", _generate(startNode, ctx), { $max: [1, { $size: "$$jsmqlArr" }] }] }
      }
    };
  }
  const endNode = exprArgs[1];
  const endLit = literalIndexValue(endNode);
  if (startLit !== null && startLit >= 0 && endLit !== null && endLit >= 0) {
    if (startLit === 0) return { $slice: [genObj, endLit] };
    if (endLit <= startLit) return [];
    return { $slice: [genObj, startLit, endLit - startLit] };
  }
  if (startLit === 0) {
    return {
      $let: {
        vars: { jsmqlArr: genObj },
        in: { $slice: ["$$jsmqlArr", resolveSliceIndex(endNode, ctx, { $size: "$$jsmqlArr" })] }
      }
    };
  }
  const count = { $subtract: ["$$jsmqlF", "$$jsmqlK"] };
  return {
    $let: {
      vars: { jsmqlArr: genObj },
      in: {
        $let: {
          vars: {
            jsmqlK: resolveSliceIndex(startNode, ctx, { $size: "$$jsmqlArr" }),
            jsmqlF: resolveSliceIndex(endNode, ctx, { $size: "$$jsmqlArr" })
          },
          in: { $cond: [{ $gt: [count, 0] }, { $slice: ["$$jsmqlArr", "$$jsmqlK", { $max: [count, 1] }] }, []] }
        }
      }
    }
  };
}
function negate(n) {
  return typeof n === "number" ? -n : { $subtract: [0, n] };
}
function sliceString(genObj, exprArgs, ctx) {
  if (exprArgs.length === 0) return genObj;
  const start = normaliseSliceIndex(exprArgs[0], ctx, genObj);
  if (exprArgs.length === 1) {
    const negativeLiteral = negativeLiteralValue(exprArgs[0]);
    if (negativeLiteral !== null) return { $substrCP: [genObj, start, negativeLiteral] };
    return { $substrCP: [genObj, start, foldedSubtract({ $strLenCP: genObj }, start)] };
  }
  const end = normaliseSliceIndex(exprArgs[1], ctx, genObj);
  return { $substrCP: [genObj, start, clampNonNegativeLength(foldedSubtract(end, start))] };
}
function negativeLiteralValue(node) {
  if (node.type === "NumberLiteral" && node.value < 0) return -node.value;
  if (node.type === "UnaryExpr" && node.op === "-" && node.operand.type === "NumberLiteral" && node.operand.value > 0) {
    return node.operand.value;
  }
  return null;
}
function literalSafeInjectedString(value, ctx) {
  if (ctx.insideLiteral || ctx.pipelineContext) return value;
  if (value.length > 0 && value.charCodeAt(0) === 36) {
    return { $literal: value };
  }
  return value;
}
function safeBoundValue(value, ctx) {
  if (ctx.insideLiteral || ctx.pipelineContext) return value;
  if (typeof value === "string") return literalSafeInjectedString(value, ctx);
  if (isOpaqueBsonValue(value)) return value;
  if (Array.isArray(value)) return value.map((v) => safeBoundValue(v, ctx));
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = safeBoundValue(v, ctx);
    }
    return out;
  }
  return value;
}
function isOpaqueBsonValue(value) {
  if (value instanceof Date) return true;
  if (value instanceof RegExp) return true;
  if (value instanceof Uint8Array) return true;
  if (typeof value === "object" && value !== null) {
    const tag = value._bsontype;
    if (tag === "ObjectID" || tag === "ObjectId") return true;
  }
  return false;
}
function generateWithCtx(expr, ctx) {
  return _generate(expr, ctx);
}
function _generate(expr, ctx) {
  return _generateBody(expr, ctx);
}
function _generateBody(expr, ctx) {
  const dynType = expr.type;
  if (dynType === "AssignExpr" || dynType === "DeleteStmt") {
    throw new CodegenError(
      `${dynType === "AssignExpr" ? "Assignment" : "delete"} is a statement, not a value. It is only valid at the top level or as a pipeline-array element.`,
      expr.pos
    );
  }
  if (dynType === "LetDecl") {
    throw new CodegenError(
      "`let` is a pipeline statement, not a value. It is only valid at the top level of a pipeline.",
      expr.pos
    );
  }
  if (dynType === "FuncDecl") {
    throw new CodegenError(
      "A function declaration is a pipeline statement, not a value. Declare `const f = (\u2026) => \u2026` at the top level of a pipeline, then call `f(...)`.",
      expr.pos
    );
  }
  switch (expr.type) {
    case "NumberLiteral":
      return expr.value;
    case "BigIntLiteral":
      return { $toLong: expr.value };
    case "StringLiteral":
      return expr.value;
    case "BooleanLiteral":
      return expr.value;
    case "NullLiteral":
      return null;
    case "UndefinedLiteral":
      throw new CodegenError(
        `'undefined' is only meaningful in '$match' position (where it lowers to '$exists'). In aggregation expressions, use 'null' for the present-but-null case, or move the comparison into a '$match' stage.`,
        expr.pos
      );
    case "FieldRef":
      return expr.path === "" ? "$$ROOT" : `$${expr.path}`;
    case "CollectionRef":
      throw new CodegenError(
        `'$$' (current collection) is statement-only and supports '.push(...)', '.filter(...)' in the facet pattern, and '$$ = <expr>' as a top-level assignment. Write \`$$.push({...})\`, \`$$.push(...$$$.<coll>[.filter(pred)])\`, or \`$$.push($$$.<coll>.find(pred))\` as a top-level Pipeline statement to append documents (lowers to '$unionWith'), \`$ = { key1: $$.filter(p1), key2: $$.filter(p2), ... }\` to build a '$facet' stage, or \`$$ = $$.filter(<pred>)\` / \`$$ = $$$.<coll>.filter(<pred>)\` to replace the current stream. As the first stage it also accepts a collection-scoped diagnostic \u2014 \`$$.indexStats()\`, \`$$.collStats({...})\`, \`$$.planCacheStats()\`, \`$$.listSearchIndexes({...})\`. Bare '$$' has no value, and these statement shapes cannot appear on a RHS or inside another expression.`,
        expr.pos
      );
    case "DatabaseRef":
      throw new CodegenError(
        `'$$$.<coll>' must be either followed by .find(pred) / .filter(pred) and consumed as a value (a $lookup read), or assigned to as a destination ('$$$.<coll> = $$' \u2192 $out write). Bare '$$$' reference is not a value, and these sugars are only valid in Pipeline mode (use \`;\`-separated statements or jsmql.pipeline()). (System diagnostics aren't database-scoped: collection ones are on '$$', server/cluster ones on '$$$$'.)`,
        expr.pos
      );
    case "ClusterRef":
      throw new CodegenError(
        `'$$$$.<db>.<coll>' is only usable as a cross-database $out destination ('$$$$.<db>.<coll> = $$'). Cross-database READS aren't supported (a $lookup/$unionWith with a '{ db, coll }' namespace is rejected by a standalone / replica-set / sharded MongoDB) \u2014 use a same-database reference '$$$.<coll>' instead. A direct call on '$$$$' is a server/cluster-scoped diagnostic source stage (\`$$$$.currentOp({...})\`, \`$$$$.listSessions({...})\`, \`$$$$.listLocalSessions({...})\`, \`$$$$.listSampledQueries({...})\`, \`$$$$.shardedDataDistribution()\`) as the first Pipeline stage. Bare '$$$$' reference is not a value, and these sugars are only valid in Pipeline mode (use \`;\`-separated statements or jsmql.pipeline()).`,
        expr.pos
      );
    case "ArrayLiteral":
      return generateArrayLiteral(expr.elements, ctx, expr.pos);
    case "ObjectLiteral":
      return generateObjectLiteral(expr.entries, ctx, expr.pos);
    case "TemplateLiteral":
      return generateTemplateLiteral(expr.quasis, expr.expressions, ctx);
    case "OperatorCall":
      return generateOperatorCall(expr.name, expr.style, expr.args, ctx, expr.pos);
    case "BinaryExpr":
      return generateBinaryExpr(expr.op, expr.left, expr.right, ctx, expr.pos);
    case "UnaryExpr":
      return generateUnaryExpr(expr.op, expr.operand, ctx, expr.pos);
    case "TernaryExpr":
      return cond(
        jsBoolIfNeeded(expr.condition, _generate(expr.condition, ctx)),
        _generate(expr.consequent, ctx),
        _generate(expr.alternate, ctx)
      );
    case "IndexAccess": {
      if (expr.index.type === "StringLiteral" && expr.object.type === "FieldRef" && expr.object.path === "") {
        return `$${expr.index.value}`;
      }
      const rawObj = _generate(expr.object, ctx);
      const idx = _generate(expr.index, ctx);
      const optional = expr.optional || chainHasOptional(expr.object);
      const containerType = expr.object.type === "ParamRef" ? ctx.bindingTypes?.get(expr.object.name) : void 0;
      const isBareRoot = expr.object.type === "FieldRef" && expr.object.path === "";
      const known = isArrayProducing(expr.object) ? "array" : isObjectProducing(expr.object) || isBareRoot ? "object" : containerType === "array" || containerType === "object" ? containerType : void 0;
      const keyIsString = isStringProducing(expr.index) || expr.index.type === "ParamRef" && ctx.bindingTypes?.get(expr.index.name) === "string";
      if (known === "object" || keyIsString) {
        const obj3 = optional ? wrapIfNull(rawObj, {}) : rawObj;
        return { $getField: { field: idx, input: obj3 } };
      }
      if (known === "array") {
        const obj3 = optional ? wrapIfNull(rawObj, []) : rawObj;
        return { $arrayElemAt: [obj3, idx] };
      }
      const obj2 = optional ? wrapIfNull(rawObj, []) : rawObj;
      return cond({ $isArray: obj2 }, { $arrayElemAt: [obj2, idx] }, { $getField: { field: idx, input: obj2 } });
    }
    case "RegexLiteral":
      throw new CodegenError(
        `Regex literals are only valid as arguments to .match(), .test(), .exec(), .matchAll(), and .search(). To pass a regex pattern as a string, use a string literal instead.`,
        expr.pos
      );
    case "ParamRef": {
      if (ctx.reduceRemap?.has(expr.name)) {
        return `$$${ctx.reduceRemap.get(expr.name)}`;
      }
      if (ctx.lambdaParams.has(expr.name)) {
        return `$$${safeVarName(expr.name)}`;
      }
      if (CORRELATION_VAR_RE.test(expr.name)) {
        return `$$${expr.name}`;
      }
      const letPath = ctx.pipelineLets?.get(expr.name);
      if (letPath !== void 0) {
        return `$${letPath}`;
      }
      if (ctx.bindings?.has(expr.name)) {
        return safeBoundValue(ctx.bindings.get(expr.name), ctx);
      }
      if (ctx.functions?.has(expr.name)) {
        throw new CodegenError(
          `'${expr.name}' is a reusable function \u2014 call it with '${expr.name}(...)'. A function can't be used as a value (passing it to another function isn't supported); inline the call instead.`,
          expr.pos
        );
      }
      const droppedBy = ctx.droppedLets?.get(expr.name);
      if (droppedBy !== void 0) {
        throw new CodegenError(
          `\`${expr.name}\` is a \`let\` binding and can't be read after \`${droppedBy}\` \u2014 the stage replaces the document. Inline the expression into the \`${droppedBy}\` body, or rebind after the stage with another \`let\`.`,
          expr.pos
        );
      }
      if (ctx.sourceSwitch?.letNames.has(expr.name)) {
        throw new CodegenError(
          `\`${expr.name}\` is a \`let\`/\`const\` declared before \`${ctx.sourceSwitch.desc}\`, which replaces the stream with a different collection (a \`$unionWith\`, which can't correlate) \u2014 so \`${expr.name}\` (along with the outer document and the root \`$$.length\`) isn't available inside the new stream. To read outer values per document, correlate with a \`.filter\` instead: \`$$$.<coll>.filter(d => d.<field> === $.<field>).map(\u2026)\` lowers to a \`$lookup\` and threads \`${expr.name}\`, \`$.<field>\`, and \`$$.length\` into the sub-pipeline.`,
          expr.pos
        );
      }
      throw new UnknownIdentifierError(expr.name, expr.pos);
    }
    case "MemberAccess": {
      if (expr.member === "length") {
        return generateLengthAccess(expr.object, expr.optional || chainHasOptional(expr.object), ctx);
      }
      const path = asFieldPath(expr, ctx);
      if (path !== null) return path;
      const rawObj = _generate(expr.object, ctx);
      const obj2 = expr.optional || chainHasOptional(expr.object) ? wrapIfNull(rawObj, {}) : rawObj;
      return { $getField: { field: expr.member, input: obj2 } };
    }
    case "MethodCall":
      return generateMethodCall(expr.object, expr.method, expr.args, ctx, expr.pos, !!expr.optional);
    case "CallExpression":
      return generateCallExpression(expr.callee, expr.args, ctx, expr.pos);
    case "Lambda":
      throw new CodegenError(
        "A function (=>) is only valid as the callback to an iterating array method (.map, .filter, .some, .every, .find, .reduce, \u2026) or as the second argument to $let.",
        expr.pos
      );
    case "TypeofExpr":
      return { $type: _generate(expr.operand, ctx) };
    case "NewDate":
      return generateNewDate(expr.args, ctx);
    case "ObjectIdLiteral":
      return new ObjectId(expr.hex);
    case "NewSet":
      return expr.arg === null ? [] : _generate(expr.arg, ctx);
    case "ArrayFrom":
      return generateArrayFrom(expr.input, expr.mapFn, ctx, expr.pos);
    case "NumberStatic":
      return generateNumberStatic(expr.method, expr.arg, ctx);
    case "DateNow":
      return { $toLong: "$$NOW" };
    case "DateUTC":
      return generateDateUTC(expr.args, ctx);
    case "TypeCast":
      return generateTypeCast(expr.cast, expr.arg, ctx, expr.pos);
    case "TypeCastRef":
      throw new CodegenError(
        `'${expr.cast}' used as a value is only valid as a callback to a higher-order array method (e.g. $.items.filter(${expr.cast})). To coerce a single value, write ${expr.cast}(value).`,
        expr.pos
      );
    case "MathCall":
      return generateMathCall(expr.method, expr.args, ctx, expr.pos);
    case "MathCallRef":
      throw new CodegenError(
        `'Math.${expr.method}' used as a value is only valid as a callback to a higher-order array method (e.g. $.items.map(Math.${expr.method})). To compute on a single value, write Math.${expr.method}(value).`,
        expr.pos
      );
    case "MathConst":
      return generateMathConst(expr.name);
    case "ObjectCall":
      return generateObjectCall(expr.method, expr.args, ctx, expr.pos);
  }
}
function chainHasOptional(expr) {
  let node = expr;
  while (node.type === "MemberAccess" || node.type === "IndexAccess") {
    if (node.optional) return true;
    node = node.object;
  }
  return false;
}
function wrapIfNull(value, fallback) {
  return { $ifNull: [value, fallback] };
}
function generateLengthAccess(object, optional, ctx) {
  if (object.type === "CollectionRef") return generateStreamLength(ctx, object.pos);
  if (object.type === "ParamRef") {
    const handleSource = ctx.substreamLengthHandles?.get(object.name);
    if (handleSource !== void 0) return handleSource;
  }
  if (object.type === "ParamRef" && ctx.bindingTypes?.get(object.name) === "array") {
    const v = _generate(object, ctx);
    return { $size: optional ? wrapIfNull(v, []) : v };
  }
  const rawObj = _generate(object, ctx);
  if (isStringProducing(object)) return { $strLenCP: optional ? wrapIfNull(rawObj, "") : rawObj };
  if (isArrayProducing(object)) return { $size: optional ? wrapIfNull(rawObj, []) : rawObj };
  const obj2 = optional ? wrapIfNull(rawObj, []) : rawObj;
  return cond({ $isArray: obj2 }, { $size: obj2 }, { $strLenCP: obj2 });
}
function generateStreamLength(ctx, pos) {
  if (!ctx.pipelineContext) {
    throw new CodegenError(
      `'$$.length' (the current stream's document count) needs Pipeline mode \u2014 it materialises a '$setWindowFields' stage. Use it inside a pipeline (e.g. \`({ $ }) => { $.n = $$.length; \u2026 }\`); it has no meaning in a Filter or in 'jsmql.expr'.`,
      pos
    );
  }
  if (ctx.rootStreamLengthVar !== void 0) return `$$${ctx.rootStreamLengthVar}`;
  if (!ctx.topLevelStream) {
    throw new CodegenError(
      `'$$.length' (the root stream count) isn't available here yet [DEF-033] \u2014 it works at the top level and inside a top-level '$lookup' (predicate, block, or '.map' chain, captured into '$lookup.let'), but not yet in a '$facet' / '$unionWith' sub-pipeline or a deeper nested lookup. Compute it in the outer (top-level) pipeline and reference the value instead.`,
      pos
    );
  }
  return `$${LENGTH_SLOT}`;
}
var OPTIONAL_STRING_METHODS = methodsWhere((m) => m.optional === "string");
var OPTIONAL_ARRAY_METHODS = methodsWhere((m) => m.optional === "array");
var OPTIONAL_EITHER_METHODS = methodsWhere((m) => m.optional === "either");
function neutralForMethod(method, object) {
  if (OPTIONAL_STRING_METHODS.has(method)) return "";
  if (OPTIONAL_ARRAY_METHODS.has(method)) return [];
  if (OPTIONAL_EITHER_METHODS.has(method)) {
    if (isStringProducing(object)) return "";
    return [];
  }
  return void 0;
}
function asFieldPath(expr, ctx) {
  if (expr.type === "FieldRef") return expr.path === "" ? "$$ROOT" : `$${expr.path}`;
  if (expr.type === "ParamRef") {
    if (ctx.reduceRemap?.has(expr.name)) {
      return `$$${ctx.reduceRemap.get(expr.name)}`;
    }
    if (ctx.lambdaParams.has(expr.name)) {
      return `$$${safeVarName(expr.name)}`;
    }
    const letPath = ctx.pipelineLets?.get(expr.name);
    if (letPath !== void 0) {
      return `$${letPath}`;
    }
    return null;
  }
  if (expr.type === "MemberAccess") {
    const base = asFieldPath(expr.object, ctx);
    if (base !== null) return `${base}.${expr.member}`;
  }
  return null;
}
var BINARY_OP_TO_MQL = {
  "-": "$subtract",
  "/": "$divide",
  "%": "$mod",
  "**": "$pow",
  "===": "$eq",
  "!==": "$ne",
  ">": "$gt",
  ">=": "$gte",
  "<": "$lt",
  "<=": "$lte",
  "*": "$multiply",
  "??": "$ifNull",
  "&": "$bitAnd",
  "|": "$bitOr",
  "^": "$bitXor"
};
function mqlForBinaryOp(op) {
  return BINARY_OP_TO_MQL[op];
}
function generateBinaryExpr(op, left, right, ctx, pos) {
  switch (op) {
    case "+":
      return generateAdd(left, right, ctx);
    case "==":
    case "!=":
      return generateLooseEquality(op, left, right, ctx, pos);
    case "&&":
      return generateLogical("&&", left, right, ctx);
    case "||":
      return generateLogical("||", left, right, ctx);
    case "in":
      return generateInExpr(left, right, ctx, pos);
    // Direct binary operators → `{ $op: [left, right] }`.
    case "-":
    case "/":
    case "%":
    case "**":
    case "===":
    case "!==":
    case ">":
    case ">=":
    case "<":
    case "<=":
      return { [BINARY_OP_TO_MQL[op]]: [_generate(left, ctx), _generate(right, ctx)] };
    // Associative chain operators → flat N-ary array.
    case "*":
    case "??":
    case "&":
    case "|":
    case "^":
      return { [BINARY_OP_TO_MQL[op]]: flattenChain(op, left, right, ctx) };
  }
}
function generateLooseEquality(op, left, right, ctx, pos) {
  const leftIsNull = left.type === "NullLiteral";
  const rightIsNull = right.type === "NullLiteral";
  if (!leftIsNull && !rightIsNull) {
    throw new CodegenError(
      `'${op}' is only allowed against null in jsmql. Use '${op === "==" ? "===" : "!=="}' for JS-like strict equality (no surprising type coercion). To match "null or missing", write '$.x ${op} null'.`,
      pos
    );
  }
  const operand = _generate(leftIsNull ? right : left, ctx);
  const inNullOrMissing = { $in: [{ $type: operand }, ["null", "missing"]] };
  return op === "==" ? inNullOrMissing : { $not: [inNullOrMissing] };
}
function flattenChain(op, left, right, ctx) {
  const operands = [];
  collectChain(op, left, operands, ctx);
  operands.push(_generate(right, ctx));
  return operands;
}
function collectChain(op, expr, out, ctx) {
  if (expr.type === "BinaryExpr" && expr.op === op) {
    collectChain(op, expr.left, out, ctx);
    out.push(_generate(expr.right, ctx));
  } else {
    out.push(_generate(expr, ctx));
  }
}
function generateLogical(op, left, right, ctx) {
  const chain = [];
  collectExprChain(op, left, chain);
  chain.push(right);
  return foldLogical(op, chain, ctx);
}
function foldLogical(op, chain, ctx) {
  if (chain.length === 1) return _generate(chain[0], ctx);
  if (chain.every((e) => isProvablyBool(e))) {
    const operands = chain.map((e) => _generate(e, ctx));
    return op === "&&" ? { $and: operands } : { $or: operands };
  }
  const lhs = chain[0];
  const lhsGen = _generate(lhs, ctx);
  const rhsGen = foldLogical(op, chain.slice(1), ctx);
  if (isPureRef(lhs, ctx) || isProvablyBool(lhs)) {
    return condForLogical(op, lhsGen, rhsGen, lhs);
  }
  const v = gensymInScope(ctx, "v");
  const ref = `$$${v}`;
  return {
    $let: {
      vars: { [v]: lhsGen },
      // The bound value is a runtime value — we don't have an AST for it,
      // so we can't ask isProvablyBool. Always wrap in jsBool for the cond.
      in: condForLogical(op, ref, rhsGen, null)
    }
  };
}
function condForLogical(op, lhs, rhs, lhsExpr) {
  const test = lhsExpr ? jsBoolIfNeeded(lhsExpr, lhs) : jsBool(lhs);
  return op === "&&" ? cond(test, rhs, lhs) : cond(test, lhs, rhs);
}
function generateInExpr(left, right, ctx, pos) {
  if (right.type === "StringLiteral" || right.type === "NumberLiteral" || right.type === "BooleanLiteral" || right.type === "NullLiteral") {
    throw new CodegenError(
      "Right-hand side of 'in' must be an array literal, object literal, or field reference, not a scalar value",
      pos
    );
  }
  if (right.type === "ObjectLiteral") {
    return { $in: [_generate(left, ctx), keyArrayForObjectLiteral(right.entries, ctx)] };
  }
  return { $in: [_generate(left, ctx), _generate(right, ctx)] };
}
function keyArrayForObjectLiteral(entries, ctx) {
  if (entries.every((e) => e.type === "KeyValueEntry" && e.key.kind === "static")) {
    return entries.map((e) => e.key.name);
  }
  const operands = [];
  let currentChunk = null;
  const flush = () => {
    if (currentChunk !== null) {
      operands.push(currentChunk);
      currentChunk = null;
    }
  };
  for (const entry of entries) {
    if (entry.type === "SpreadElement") {
      flush();
      operands.push({ $map: { input: { $objectToArray: _generate(entry.argument, ctx) }, as: "kv", in: "$$kv.k" } });
      continue;
    }
    if (currentChunk === null) currentChunk = [];
    currentChunk.push(entry.key.kind === "static" ? entry.key.name : _generate(entry.key.expr, ctx));
  }
  flush();
  if (operands.length === 1) return operands[0];
  return { $concatArrays: operands };
}
function generateAdd(left, right, ctx) {
  const exprs = [];
  collectExprChain("+", left, exprs);
  exprs.push(right);
  const isString = exprs.some((e) => isStringProducing(e));
  if (isString) {
    return {
      $concat: exprs.map((e) => {
        const gen = _generate(e, ctx);
        return chainHasOptional(e) ? wrapIfNull(gen, "") : gen;
      })
    };
  }
  return { $add: exprs.map((e) => _generate(e, ctx)) };
}
function collectExprChain(op, expr, out) {
  if (expr.type === "BinaryExpr" && expr.op === op) {
    collectExprChain(op, expr.left, out);
    out.push(expr.right);
  } else {
    out.push(expr);
  }
}
function generateUnaryExpr(op, operand, ctx, _pos) {
  if (op === "!") {
    if (operand.type === "UnaryExpr" && operand.op === "!") {
      return jsBool(_generate(operand.operand, ctx));
    }
    return { $not: jsBoolIfNeeded(operand, _generate(operand, ctx)) };
  }
  if (op === "~") {
    return { $bitNot: _generate(operand, ctx) };
  }
  if (operand.type === "NumberLiteral") {
    return -operand.value;
  }
  return { $multiply: [_generate(operand, ctx), -1] };
}
function generateArrayLiteral(elements, ctx, pos) {
  for (const el of elements) {
    if (el.type === "AssignExpr" || el.type === "DeleteStmt") {
      throw new CodegenError(
        `${el.type === "AssignExpr" ? "Assignment" : "delete"} is a statement, not a value, and is only valid at the top level or as a pipeline-array element. If this array is meant to be a pipeline, ensure its first element is a stage like \`$match(...)\`.`,
        el.pos
      );
    }
    if (el.type === "LetDecl") {
      throw new CodegenError(
        "`let` is a pipeline statement, not a value, and is only valid as a pipeline-array element. If this array is meant to be a pipeline, ensure its first element is a stage like `$match(...)`.",
        el.pos
      );
    }
    if (el.type === "FuncDecl") {
      throw new CodegenError(
        "A function declaration is a pipeline statement, not a value, and is only valid as a pipeline-array element. If this array is meant to be a pipeline, ensure its first element is a stage like `$match(...)`.",
        el.pos
      );
    }
  }
  void pos;
  const hasSpread = elements.some((el) => el.type === "SpreadElement");
  if (!hasSpread) {
    return elements.map((el) => _generate(el, ctx));
  }
  const operands = [];
  let buffer = [];
  const flushBuffer = () => {
    if (buffer.length === 0) return;
    operands.push(buffer.map((el) => _generate(el, ctx)));
    buffer = [];
  };
  for (const el of elements) {
    if (el.type === "SpreadElement") {
      flushBuffer();
      const argVal = _generate(el.argument, ctx);
      operands.push(chainHasOptional(el.argument) ? wrapIfNull(argVal, []) : argVal);
    } else if (el.type === "AssignExpr" || el.type === "DeleteStmt" || el.type === "LetDecl" || el.type === "FuncDecl") {
      continue;
    } else {
      buffer.push(el);
    }
  }
  flushBuffer();
  if (operands.length === 1) return operands[0];
  return { $concatArrays: operands };
}
function generateObjectLiteral(entries, ctx, _pos) {
  const hasSpread = entries.some((e) => e.type === "SpreadElement");
  if (!hasSpread) {
    const hasComputed = entries.some((e) => e.type === "KeyValueEntry" && e.key.kind === "computed");
    if (!hasComputed) {
      return generateStaticObjectEntries(entries, ctx);
    }
    return generateComputedKeyObject(entries, ctx);
  }
  const operands = [];
  let staticBuffer = [];
  const flushBuffer = () => {
    if (staticBuffer.length === 0) return;
    const hasComputed = staticBuffer.some((e) => e.key.kind === "computed");
    operands.push(
      hasComputed ? generateComputedKeyObject(staticBuffer, ctx) : generateStaticObjectEntries(staticBuffer, ctx)
    );
    staticBuffer = [];
  };
  for (const entry of entries) {
    if (entry.type === "SpreadElement") {
      flushBuffer();
      operands.push(_generate(entry.argument, ctx));
    } else {
      staticBuffer.push(entry);
    }
  }
  flushBuffer();
  if (operands.length === 1) return operands[0];
  return { $mergeObjects: operands };
}
function arrayToObjectOfLiteralPairs(pairs) {
  return { $arrayToObject: [pairs] };
}
function generateComputedKeyObject(entries, ctx) {
  const pairs = entries.map((entry) => {
    const k = entry.key.kind === "static" ? entry.key.name : _generate(entry.key.expr, ctx);
    return { k, v: _generate(entry.value, ctx) };
  });
  return arrayToObjectOfLiteralPairs(pairs);
}
function generateStaticObjectEntries(entries, ctx) {
  const result = {};
  for (const entry of entries) {
    if (entry.type === "SpreadElement") {
      throw new CodegenError("Spread elements in objects are not supported in MQL output", entry.pos);
    }
    if (entry.key.kind === "computed") {
      throw new CodegenError(
        "Computed object keys are not allowed here \u2014 operator argument keys must be literal names",
        entry.pos
      );
    }
    if (entry.key.name.charCodeAt(0) === 36 && entry.value.type !== "ArrayLiteral") {
      if (lookupOperator(entry.key.name)?.shape.kind === "array") {
        throw listOperandError(entry.key.name, entry.value.pos);
      }
    }
    result[entry.key.name] = _generate(entry.value, ctx);
  }
  return result;
}
function checkOperatorContext(name, ctx, pos) {
  const def = lookupOperator(name);
  if (def?.category === "window") {
    if (ctx.accumulatorContext !== "window-output") {
      throw new CodegenError(
        `${name} is a window operator \u2014 only valid inside '$setWindowFields' output slots. Use $setWindowFields({ partitionBy: ..., sortBy: ..., output: { <key>: ${name}(...) } }) to compute it per-document over a window.`,
        pos
      );
    }
    return;
  }
  if (def?.accumulatorOnly) {
    if (ctx.accumulatorContext === void 0) {
      throw new CodegenError(
        `${name} is an accumulator operator \u2014 only valid inside '$group' field-value slots or '$setWindowFields' output slots. Use $group({ _id: ..., <key>: ${name}(...) }) to compute it per-group, or $setWindowFields(...) for the windowed form.`,
        pos
      );
    }
  }
}
function generateOperatorCall(name, style, args, ctx, pos) {
  checkOperatorContext(name, ctx, pos);
  assertNoSpread(args, name, pos);
  validateOperatorArgs(name, style, args, pos, ctx);
  if (name === "$literal" && args.length === 1 && args[0].type !== "SpreadElement") {
    const inner = _generate(args[0], { ...ctx, insideLiteral: true });
    return { $literal: inner };
  }
  if (style === "object") {
    const objArg = args[0];
    if (!objArg || objArg.type !== "ObjectLiteral") {
      throw new CodegenError(`Object-style call to ${name} must have exactly one object argument`, pos);
    }
    const def2 = lookupOperator(name);
    if (def2?.shape.kind === "object") {
      return { [name]: generateStaticObjectEntries(objArg.entries, ctx) };
    }
    return { [name]: generateObjectLiteral(objArg.entries, ctx, objArg.pos) };
  }
  if (name === "$let" && args.length === 2 && args[1]?.type === "Lambda") {
    const varsExpr = args[0];
    if (!varsExpr || varsExpr.type !== "ObjectLiteral") {
      throw new CodegenError("$let first argument must be an object literal", varsExpr?.pos ?? pos);
    }
    const lambdaExpr = args[1];
    if (lambdaExpr.type !== "Lambda") throw new CodegenError("$let second argument must be a lambda", lambdaExpr.pos);
    if (lambdaExpr.block !== void 0) {
      throw new CodegenError(
        "$let second argument cannot be a statement-block arrow (a sub-pipeline) \u2014 that form is only for '$$$.<coll>.find/filter(...)'. Use an expression, or a value-returning block `() => { const a = \u2026; return a; }`.",
        lambdaExpr.pos
      );
    }
    const vars = generateStaticObjectEntries(varsExpr.entries, ctx);
    const bodyCtx = extendCtx(ctx, lambdaExpr.params);
    return { $let: { vars, in: genLambdaBody(lambdaExpr, bodyCtx) } };
  }
  if (name === "$arrayToObject" && style === "positional" && args.length === 1 && args[0].type === "ArrayLiteral") {
    return arrayToObjectOfLiteralPairs(_generate(args[0], ctx));
  }
  const def = lookupOperator(name);
  if (!def) {
    return generateUnknownOperator(name, args, ctx);
  }
  const { shape } = def;
  switch (shape.kind) {
    case "none": {
      return { [name]: {} };
    }
    case "single": {
      if (args.length !== 1) {
        throw new CodegenError(`Operator ${name} expects exactly 1 argument, got ${args.length}`, pos);
      }
      return { [name]: _generate(args[0], ctx) };
    }
    case "array": {
      if (args.length === 0) {
        throw new CodegenError(`Operator ${name} expects at least 1 argument`, pos);
      }
      if (args.length === 1) {
        const only = args[0];
        if (only.type !== "ArrayLiteral") {
          throw listOperandError(name, only.pos);
        }
        return { [name]: _generate(only, ctx) };
      }
      return { [name]: generateVariadicArgs(args, ctx) };
    }
    case "flex": {
      if (args.length === 0) {
        throw new CodegenError(`Operator ${name} expects at least 1 argument`, pos);
      }
      if (args.length === 1) {
        return { [name]: _generate(args[0], ctx) };
      }
      return { [name]: generateVariadicArgs(args, ctx) };
    }
    case "object": {
      if (args.length === 0) {
        throw new CodegenError(`Operator ${name} expects at least 1 argument`, pos);
      }
      const keys = shape.keys;
      const obj2 = {};
      for (let i = 0; i < args.length; i++) {
        const key = keys[i];
        if (!key) {
          throw new CodegenError(
            `Operator ${name} received more positional arguments than expected (max ${keys.length})`,
            args[i].pos
          );
        }
        obj2[key] = _generate(args[i], ctx);
      }
      return { [name]: obj2 };
    }
  }
}
function generateUnknownOperator(name, args, ctx) {
  if (args.length === 0) {
    return { [name]: {} };
  }
  if (args.length === 1) {
    const only = args[0];
    if (only.type === "ObjectLiteral") {
      return { [name]: generateStaticObjectEntries(only.entries, ctx) };
    }
    return { [name]: _generate(only, ctx) };
  }
  return { [name]: generateVariadicArgs(args, ctx) };
}
function generateVariadicArgs(args, ctx) {
  const hasSpread = args.some((a) => a.type === "SpreadElement");
  if (!hasSpread) {
    return args.map((a) => _generate(a, ctx));
  }
  if (args.length === 1) {
    const only = args[0];
    return _generate(only.argument, ctx);
  }
  const parts = args.map((a) => a.type === "SpreadElement" ? _generate(a.argument, ctx) : [_generate(a, ctx)]);
  return { $concatArrays: parts };
}
function listOperandError(name, pos) {
  return new CodegenError(
    `${name} operates on a list of operands \u2014 pass two or more (${name}(a, b)) or a single array (${name}([a, b])).`,
    pos
  );
}
var SPREAD_JS_ALTERNATIVE = {
  $min: "use the JS form Math.min(...arr)",
  $max: "use the JS form Math.max(...arr)",
  $concatArrays: "use array spread ([...a, ...b]) or .concat()",
  $mergeObjects: "use object spread ({ ...a, ...b }) or Object.assign(...docs)"
};
function assertNoSpread(args, name, callPos) {
  for (const a of args) {
    if (a.type === "SpreadElement") {
      const alt = SPREAD_JS_ALTERNATIVE[name];
      const fix = alt ? `${alt}, or pass a single array (${name}([a, b]))` : `pass operands directly (${name}(a, b)) or as a single array (${name}([a, b]))`;
      throw new CodegenError(`Spread (...) is not supported in ${name}(...) \u2014 ${fix}.`, a.pos ?? callPos);
    }
  }
}
function generateTemplateLiteral(quasis, expressions, ctx) {
  if (expressions.length === 0) {
    return quasis[0] ?? "";
  }
  const parts = [];
  for (let i = 0; i < expressions.length; i++) {
    if (quasis[i] !== "") parts.push(quasis[i]);
    const expr = expressions[i];
    const gen = _generate(expr, ctx);
    const wrappedGen = chainHasOptional(expr) ? wrapIfNull(gen, "") : gen;
    parts.push(isStringProducing(expr) ? wrappedGen : { $toString: wrappedGen });
  }
  const tail = quasis[expressions.length];
  if (tail !== "") parts.push(tail);
  return { $concat: parts };
}
function strTail(s, from) {
  return { $substrCP: [s, from, { $strLenCP: s }] };
}
function capitalizeExpr(s) {
  return { $concat: [{ $toUpper: { $substrCP: [s, 0, 1] } }, { $toLower: strTail(s, 1) }] };
}
function firstCharExpr(s, op) {
  return { $concat: [{ [op]: { $substrCP: [s, 0, 1] } }, strTail(s, 1)] };
}
function wordsExpr(s) {
  return {
    $map: { input: { $regexFindAll: { input: s, regex: ASCII_WORDS_RE } }, as: "jsmqlWord", in: "$$jsmqlWord.match" }
  };
}
function joinWords(words2, sep, transform) {
  const items = transform === void 0 ? words2 : { $map: { input: words2, as: "jsmqlW", in: transform("$$jsmqlW") } };
  return {
    $reduce: {
      input: items,
      initialValue: "",
      in: { $cond: [{ $eq: ["$$value", ""] }, "$$this", { $concat: ["$$value", sep, "$$this"] }] }
    }
  };
}
function escapeHtmlExpr(s) {
  let e = s;
  for (const [find, replacement] of HTML_ESCAPE_PAIRS) e = { $replaceAll: { input: e, find, replacement } };
  return e;
}
function shorthandToLambda(arg, method, param) {
  const pos = arg.pos;
  const paramRef = { type: "ParamRef", name: param, pos };
  const memberPath = (base, path) => {
    let e = base;
    for (const seg of path.split(".")) e = { type: "MemberAccess", object: e, member: seg, pos };
    return e;
  };
  const lambda = (body) => ({ type: "Lambda", params: [param], body, pos });
  if (arg.type === "StringLiteral") {
    if (arg.value === "" || arg.value.startsWith("$")) {
      throw new CodegenError(`.${method}("field") requires a plain field name (no leading '$').`, pos);
    }
    return lambda(memberPath(paramRef, arg.value));
  }
  if (arg.type === "ObjectLiteral") {
    if (arg.entries.length === 0) throw new CodegenError(`.${method}({ \u2026 }) needs at least one field to match.`, pos);
    const eqs = arg.entries.map((entry) => {
      if (entry.type !== "KeyValueEntry" || entry.key.kind !== "static") {
        throw new CodegenError(`.${method}({ \u2026 }) matcher keys must be plain field names.`, entry.pos);
      }
      return {
        type: "BinaryExpr",
        op: "===",
        left: memberPath(paramRef, entry.key.name),
        right: entry.value,
        pos: entry.pos
      };
    });
    return lambda(eqs.reduce((a, b) => ({ type: "BinaryExpr", op: "&&", left: a, right: b, pos })));
  }
  if (arg.type === "ArrayLiteral") {
    const els = arg.elements;
    const path = els[0];
    const value = els[1];
    const valueIsExpr = value !== void 0 && value.type !== "SpreadElement" && value.type !== "AssignExpr" && value.type !== "DeleteStmt" && value.type !== "LetDecl" && value.type !== "FuncDecl";
    if (els.length !== 2 || path.type !== "StringLiteral" || !valueIsExpr) {
      throw new CodegenError(
        `.${method}(["field", value]) matchesProperty shorthand needs a field-name string and a value.`,
        pos
      );
    }
    return lambda({ type: "BinaryExpr", op: "===", left: memberPath(paramRef, path.value), right: value, pos });
  }
  return null;
}
function resolveIteratee(iteratee, method, ctx) {
  const AS = "jsmqlItem";
  if (iteratee === void 0) return { as: AS, elem: `$$${AS}`, value: `$$${AS}` };
  if (iteratee.type === "Lambda" && iteratee.block === void 0 && iteratee.params.length === 1) {
    const as = safeVarName(iteratee.params[0]);
    return { as, elem: `$$${as}`, value: _generate(iteratee.body, extendCtx(ctx, [iteratee.params[0]])) };
  }
  const lam = shorthandToLambda(iteratee, method, AS);
  if (lam !== null) {
    return { as: AS, elem: `$$${AS}`, value: _generate(lam.body, extendCtx(ctx, [AS])) };
  }
  throw new CodegenError(
    `.${method}(iteratee) takes a field name ("id"), a matches object ({ active: true }), a ["field", value] pair, or a single-parameter arrow ('x => x.id').`,
    iteratee.pos
  );
}
function resolvePredicate(pred, method, ctx) {
  const it = resolveIteratee(pred, method, ctx);
  return { as: it.as, cond: it.value };
}
function takeDropWhile(arrExpr, pred, drop2) {
  const preds = { $map: { input: "$$jsmqlArr", as: pred.as, in: { $cond: [pred.cond, true, false] } } };
  const body = drop2 ? { $cond: [{ $eq: ["$$jsmqlFi", -1] }, [], { $slice: ["$$jsmqlArr", "$$jsmqlFi", { $size: "$$jsmqlArr" }] }] } : (
    // take: the first `jsmqlFi` elements. The 2-arg `$slice` (first-n) — NOT the
    // 3-arg `$slice: [arr, 0, jsmqlFi]` — so a boundary at index 0 (the first
    // element already fails the predicate) is `$slice: [arr, 0]` → `[]`, instead of
    // the 3-arg `$slice: [arr, 0, 0]` mongod rejects ("count must be positive").
    { $cond: [{ $eq: ["$$jsmqlFi", -1] }, "$$jsmqlArr", { $slice: ["$$jsmqlArr", "$$jsmqlFi"] }] }
  );
  return {
    $let: {
      vars: { jsmqlArr: arrExpr },
      in: { $let: { vars: { jsmqlFi: { $indexOfArray: [preds, false] } }, in: body } }
    }
  };
}
function stringKeyExpr(value) {
  return { $ifNull: [{ $toString: value }, "null"] };
}
function distinctKeysExpr(arr, it) {
  return { $setUnion: [{ $map: { input: arr, as: it.as, in: stringKeyExpr(it.value) } }, []] };
}
function iterateeKeys(arr, it) {
  return { $map: { input: arr, as: it.as, in: it.value } };
}
function uniqByReduce(input, it) {
  return {
    $getField: {
      field: "out",
      input: {
        $reduce: {
          input,
          initialValue: { seen: [], out: [] },
          in: {
            $let: {
              vars: { [it.as]: "$$this" },
              in: {
                $cond: [
                  { $in: [it.value, "$$value.seen"] },
                  "$$value",
                  {
                    seen: { $concatArrays: ["$$value.seen", [it.value]] },
                    out: { $concatArrays: ["$$value.out", ["$$this"]] }
                  }
                ]
              }
            }
          }
        }
      }
    }
  };
}
function resolveObjIteratee(iteratee, method, ctx) {
  if (iteratee.type === "Lambda" && iteratee.block === void 0 && iteratee.params.length >= 1 && iteratee.params.length <= 2) {
    const vars = { [safeVarName(iteratee.params[0])]: "$$jsmqlKv.v" };
    if (iteratee.params.length === 2) vars[safeVarName(iteratee.params[1])] = "$$jsmqlKv.k";
    return { $let: { vars, in: _generate(iteratee.body, extendCtx(ctx, iteratee.params)) } };
  }
  throw new CodegenError(`.${method}((value[, key]) => \u2026) takes a one- or two-parameter arrow.`, iteratee.pos);
}
function pickKeys(arg, method) {
  if (arg.type !== "ArrayLiteral") {
    throw new CodegenError(
      `.${method}([keys]) takes an array of field-name strings, e.g. '.${method}(["name", "age"])'.`,
      arg.pos
    );
  }
  return arg.elements.map((el) => {
    if (el.type !== "StringLiteral" || el.value === "" || el.value.startsWith("$")) {
      throw new CodegenError(`.${method}([keys]) entries must be plain field-name strings (no leading '$').`, el.pos);
    }
    return el.value;
  });
}
function utcDate(date) {
  return { date, timezone: "UTC" };
}
function generateMethodCall(object, method, args, ctx, callPos, optional = false) {
  if (object.type === "NewSet") {
    return generateSetMethodCall(object, method, args, ctx);
  }
  if (object.type === "RegexLiteral") {
    return generateRegexMethodCall(object, method, args, ctx);
  }
  const rawObj = _generate(object, ctx);
  const wrapReceiver = optional || chainHasOptional(object);
  const neutral = wrapReceiver ? neutralForMethod(method, object) : void 0;
  const genObj = neutral !== void 0 ? wrapIfNull(rawObj, neutral) : rawObj;
  const receiverType = METHODS[method]?.receiver;
  if (receiverType !== void 0) checkArgType(`.${method}`, "", object, receiverType);
  if (method in METHODS) {
    const recv = certainReceiverType(object);
    if (recv !== null) rejectIncompatibleChain(recv, method, object);
  }
  switch (method) {
    // ── String methods ──────────────────────────────────────────────────────
    case "trim":
      return { $trim: { input: genObj } };
    case "trimStart":
    case "trimLeft":
      return { $ltrim: { input: genObj } };
    case "trimEnd":
    case "trimRight":
      return { $rtrim: { input: genObj } };
    case "toLowerCase":
      return { $toLower: genObj };
    case "toUpperCase":
      return { $toUpper: genObj };
    case "substr": {
      const exprArgs = exprArgsOnly(args, "substr");
      checkArity("substr", { sig: "start[, count]", allowed: [1, 2] }, exprArgs.length, callPos);
      if (exprArgs.length === 1) {
        return { $substrCP: [genObj, _generate(exprArgs[0], ctx), { $strLenCP: genObj }] };
      }
      return { $substrCP: [genObj, _generate(exprArgs[0], ctx), _generate(exprArgs[1], ctx)] };
    }
    case "substring": {
      const exprArgs = exprArgsOnly(args, "substring");
      checkArity("substring", { sig: "start[, end]", allowed: [0, 1, 2] }, exprArgs.length, callPos);
      if (exprArgs.length === 0) return genObj;
      const start = clampNonNegativeIndex(exprArgs[0], ctx);
      if (exprArgs.length === 1) {
        return { $substrCP: [genObj, start, foldedSubtract({ $strLenCP: genObj }, start)] };
      }
      const end = clampNonNegativeIndex(exprArgs[1], ctx);
      return { $substrCP: [genObj, start, clampNonNegativeLength(foldedSubtract(end, start))] };
    }
    case "charAt": {
      const exprArgs = exprArgsOnly(args, "charAt");
      checkArity("charAt", { sig: "index", exact: 1 }, exprArgs.length, callPos);
      return { $substrCP: [genObj, _generate(exprArgs[0], ctx), 1] };
    }
    case "split": {
      const exprArgs = exprArgsOnly(args, "split");
      checkArity("split", { sig: "separator", exact: 1 }, exprArgs.length, callPos);
      return { $split: [genObj, _generate(exprArgs[0], ctx)] };
    }
    case "startsWith": {
      const exprArgs = exprArgsOnly(args, "startsWith");
      checkArity("startsWith", { sig: "searchString", exact: 1 }, exprArgs.length, callPos);
      return { $eq: [{ $indexOfCP: [genObj, _generate(exprArgs[0], ctx)] }, 0] };
    }
    case "endsWith": {
      const exprArgs = exprArgsOnly(args, "endsWith");
      checkArity("endsWith", { sig: "searchString", exact: 1 }, exprArgs.length, callPos);
      const needle = _generate(exprArgs[0], ctx);
      return {
        $eq: [
          { $substrCP: [genObj, { $subtract: [{ $strLenCP: genObj }, { $strLenCP: needle }] }, { $strLenCP: needle }] },
          needle
        ]
      };
    }
    case "indexOf": {
      const exprArgs = exprArgsOnly(args, "indexOf");
      checkArity("indexOf", { sig: "searchValue", exact: 1 }, exprArgs.length, callPos);
      rejectPredicateOnValueSearch(exprArgs[0], "indexOf", "findIndex");
      const needle = _generate(exprArgs[0], ctx);
      if (isArrayProducing(object)) {
        return { $indexOfArray: [genObj, needle] };
      }
      if (isStringProducing(object)) {
        return { $indexOfCP: [genObj, needle] };
      }
      return cond({ $isArray: genObj }, { $indexOfArray: [genObj, needle] }, { $indexOfCP: [genObj, needle] });
    }
    case "lastIndexOf": {
      const exprArgs = exprArgsOnly(args, "lastIndexOf");
      checkArity("lastIndexOf", { sig: "searchValue", exact: 1 }, exprArgs.length, callPos);
      if (isStringProducing(object)) {
        throw new CodegenError(
          `.lastIndexOf() on strings isn't supported \u2014 MongoDB's $indexOfCP is forward-only. Use $op($indexOfCP, str, needle) for first-match indexing.`,
          callPos
        );
      }
      const needle = _generate(exprArgs[0], ctx);
      return {
        $let: {
          vars: { jsmqlArr: genObj },
          in: {
            $let: {
              vars: { jsmqlRevIdx: { $indexOfArray: [{ $reverseArray: "$$jsmqlArr" }, needle] } },
              in: cond({ $eq: ["$$jsmqlRevIdx", -1] }, -1, {
                $subtract: [{ $subtract: [{ $size: "$$jsmqlArr" }, 1] }, "$$jsmqlRevIdx"]
              })
            }
          }
        }
      };
    }
    case "replace": {
      const exprArgs = exprArgsOnly(args, "replace");
      checkArity("replace", { sig: "find, replacement", exact: 2 }, exprArgs.length, callPos);
      return {
        $replaceOne: { input: genObj, find: _generate(exprArgs[0], ctx), replacement: _generate(exprArgs[1], ctx) }
      };
    }
    case "replaceAll": {
      const exprArgs = exprArgsOnly(args, "replaceAll");
      checkArity("replaceAll", { sig: "find, replacement", exact: 2 }, exprArgs.length, callPos);
      return {
        $replaceAll: { input: genObj, find: _generate(exprArgs[0], ctx), replacement: _generate(exprArgs[1], ctx) }
      };
    }
    case "includes": {
      const exprArgs = exprArgsOnly(args, "includes");
      checkArity("includes", { sig: "searchValue", exact: 1 }, exprArgs.length, callPos);
      rejectPredicateOnValueSearch(exprArgs[0], "includes", "some");
      const needle = _generate(exprArgs[0], ctx);
      if (isArrayProducing(object)) {
        return { $in: [needle, genObj] };
      }
      if (isStringProducing(object)) {
        return { $gte: [{ $indexOfCP: [genObj, needle] }, 0] };
      }
      return cond({ $isArray: genObj }, { $in: [needle, genObj] }, { $gte: [{ $indexOfCP: [genObj, needle] }, 0] });
    }
    case "match": {
      const exprArgs = exprArgsOnly(args, "match");
      checkArity("match", { sig: "regex", exact: 1 }, exprArgs.length, callPos);
      const pattern = exprArgs[0];
      if (pattern.type === "RegexLiteral") {
        const result = { input: genObj, regex: pattern.pattern };
        const opts = mongoRegexOptions(pattern.flags);
        if (opts) result["options"] = opts;
        return { $regexMatch: result };
      }
      return { $regexMatch: { input: genObj, regex: _generate(pattern, ctx) } };
    }
    case "matchAll": {
      const exprArgs = exprArgsOnly(args, "matchAll");
      checkArity("matchAll", { sig: "regex", exact: 1 }, exprArgs.length, callPos);
      const pattern = exprArgs[0];
      if (pattern.type === "RegexLiteral") {
        if (!pattern.flags.includes("g")) {
          throw new CodegenError(
            `.matchAll() requires a regex with the 'g' flag (matching JS's TypeError on non-global regex)`,
            callPos
          );
        }
        const result = { input: genObj, regex: pattern.pattern };
        const opts = mongoRegexOptions(pattern.flags);
        if (opts) result["options"] = opts;
        return { $regexFindAll: result };
      }
      return { $regexFindAll: { input: genObj, regex: _generate(pattern, ctx) } };
    }
    case "search": {
      const exprArgs = exprArgsOnly(args, "search");
      checkArity("search", { sig: "regex", exact: 1 }, exprArgs.length, callPos);
      const pattern = exprArgs[0];
      const searchOpts = pattern.type === "RegexLiteral" ? mongoRegexOptions(pattern.flags) : "";
      const findCall = pattern.type === "RegexLiteral" ? {
        $regexFind: searchOpts ? { input: genObj, regex: pattern.pattern, options: searchOpts } : { input: genObj, regex: pattern.pattern }
      } : { $regexFind: { input: genObj, regex: _generate(pattern, ctx) } };
      return { $ifNull: [{ $getField: { field: "idx", input: findCall } }, -1] };
    }
    case "padStart":
    case "padEnd": {
      const exprArgs = exprArgsOnly(args, method);
      checkArity(method, { sig: "targetLength[, padString]", allowed: [1, 2] }, exprArgs.length, callPos);
      const target = _generate(exprArgs[0], ctx);
      const pad = exprArgs.length === 2 ? _generate(exprArgs[1], ctx) : " ";
      const padReduce = {
        $reduce: {
          input: { $range: [0, { $subtract: [target, { $strLenCP: "$$s" }] }] },
          initialValue: "",
          in: { $concat: ["$$value", pad] }
        }
      };
      const concatOrder = method === "padStart" ? [padReduce, "$$s"] : ["$$s", padReduce];
      return {
        $let: {
          vars: { s: genObj },
          in: cond({ $gte: [{ $strLenCP: "$$s" }, target] }, "$$s", { $concat: concatOrder })
        }
      };
    }
    case "repeat": {
      const exprArgs = exprArgsOnly(args, "repeat");
      checkArity("repeat", { sig: "count", exact: 1 }, exprArgs.length, callPos);
      const count = _generate(exprArgs[0], ctx);
      return { $reduce: { input: { $range: [0, count] }, initialValue: "", in: { $concat: ["$$value", genObj] } } };
    }
    // ── Array methods (no lambda) ───────────────────────────────────────────
    case "at": {
      const exprArgs = exprArgsOnly(args, "at");
      checkArity("at", { sig: "index", exact: 1 }, exprArgs.length, callPos);
      return { $arrayElemAt: [genObj, _generate(exprArgs[0], ctx)] };
    }
    case "slice": {
      const exprArgs = exprArgsOnly(args, "slice");
      checkArity("slice", { sig: "start[, end]", allowed: [0, 1, 2] }, exprArgs.length, callPos);
      if (isStringProducing(object)) return sliceString(genObj, exprArgs, ctx);
      if (isArrayProducing(object)) return sliceArray(genObj, exprArgs, ctx);
      return cond({ $isArray: genObj }, sliceArray(genObj, exprArgs, ctx), sliceString(genObj, exprArgs, ctx));
    }
    case "toReversed": {
      checkArity(method, { sig: "", none: true }, args.length, callPos);
      return { $reverseArray: genObj };
    }
    case "toSorted": {
      if (args.length === 0) {
        return { $sortArray: { input: genObj, sortBy: 1 } };
      }
      const exprArgs = exprArgsOnly(args, "toSorted");
      checkArity(
        "toSorted",
        { sig: '"field" | ["a", "b"] | { field: dir } | keyFn', allowed: [0, 1] },
        exprArgs.length,
        callPos
      );
      const sortBy = argToSortBy(exprArgs[0], "toSorted");
      return { $sortArray: { input: genObj, sortBy } };
    }
    case "sortBy": {
      const exprArgs = exprArgsOnly(args, "sortBy");
      checkArity("sortBy", { sig: '["field" | keyFn | [fields]]', allowed: [0, 1] }, exprArgs.length, callPos);
      if (exprArgs.length === 0) return { $sortArray: { input: genObj, sortBy: 1 } };
      if (exprArgs[0].type === "ObjectLiteral") {
        throw new CodegenError(
          `.sortBy({ \u2026 }) isn't supported \u2014 an object here is a lodash matches-shorthand, not a direction. Use '.orderBy({ field: -1 })' or '.toSorted({ field: -1 })' for directions.`,
          exprArgs[0].pos
        );
      }
      return { $sortArray: { input: genObj, sortBy: argToSortBy(exprArgs[0], "sortBy") } };
    }
    case "orderBy": {
      const exprArgs = exprArgsOnly(args, "orderBy");
      checkArity("orderBy", { sig: "keys[, orders] | { field: dir }", allowed: [1, 2] }, exprArgs.length, callPos);
      if (exprArgs[0].type === "ObjectLiteral") {
        if (exprArgs.length > 1) {
          throw new CodegenError(
            `.orderBy({ \u2026 }) already carries a direction per field \u2014 drop the second 'orders' argument.`,
            exprArgs[1].pos
          );
        }
        return { $sortArray: { input: genObj, sortBy: argToSortBy(exprArgs[0], "orderBy") } };
      }
      const names = orderByKeyNames(exprArgs[0], "orderBy");
      const dirs = exprArgs[1] !== void 0 ? orderByDirs(exprArgs[1], "orderBy") : [];
      const spec = {};
      names.forEach((nm, i) => {
        spec[nm] = dirs[i] ?? 1;
      });
      return { $sortArray: { input: genObj, sortBy: spec } };
    }
    case "toSpliced": {
      const exprArgs = exprArgsOnly(args, "toSpliced");
      checkArity("toSpliced", { sig: "start[, deleteCount, ...items]", atLeast: 1 }, exprArgs.length, callPos);
      const startArg = exprArgs[0];
      if (isNegativeLiteral(startArg)) {
        throw new CodegenError(
          `.toSpliced() with a negative start index isn't supported \u2014 MongoDB $slice's position arg is non-negative.`,
          startArg.pos
        );
      }
      const start = _generate(startArg, ctx);
      const hasDeleteCount = exprArgs.length >= 2;
      const deleteCountArg = hasDeleteCount ? exprArgs[1] : null;
      if (deleteCountArg && isNegativeLiteral(deleteCountArg)) {
        throw new CodegenError(
          `.toSpliced() with a negative deleteCount isn't supported \u2014 MongoDB $slice's length arg is non-negative.`,
          deleteCountArg.pos
        );
      }
      const items = exprArgs.slice(2).map((a) => _generate(a, ctx));
      const tailStart = hasDeleteCount ? { $add: ["$$jsmqlStart", _generate(deleteCountArg, ctx)] } : "$$jsmqlStart";
      return {
        $let: {
          vars: { jsmqlArr: genObj, jsmqlStart: start },
          in: {
            $let: {
              vars: { jsmqlTailStart: tailStart },
              in: {
                $concatArrays: [
                  { $slice: ["$$jsmqlArr", 0, "$$jsmqlStart"] },
                  items,
                  {
                    $slice: [
                      "$$jsmqlArr",
                      "$$jsmqlTailStart",
                      { $max: [0, { $subtract: [{ $size: "$$jsmqlArr" }, "$$jsmqlTailStart"] }] }
                    ]
                  }
                ]
              }
            }
          }
        }
      };
    }
    case "with": {
      const exprArgs = exprArgsOnly(args, "with");
      checkArity("with", { sig: "index, value", exact: 2 }, exprArgs.length, callPos);
      const idxArg = exprArgs[0];
      if (isNegativeLiteral(idxArg)) {
        throw new CodegenError(
          `.with() with a negative index isn't supported \u2014 MongoDB $slice's position arg is non-negative.`,
          idxArg.pos
        );
      }
      const idx = _generate(idxArg, ctx);
      const value = _generate(exprArgs[1], ctx);
      return {
        $let: {
          vars: { jsmqlArr: genObj, jsmqlIdx: idx, jsmqlVal: value },
          in: {
            $concatArrays: [
              { $slice: ["$$jsmqlArr", 0, "$$jsmqlIdx"] },
              ["$$jsmqlVal"],
              {
                $slice: [
                  "$$jsmqlArr",
                  { $add: ["$$jsmqlIdx", 1] },
                  { $max: [0, { $subtract: [{ $size: "$$jsmqlArr" }, { $add: ["$$jsmqlIdx", 1] }] }] }
                ]
              }
            ]
          }
        }
      };
    }
    case "findLast": {
      const lambda = requireLambda(exprArgsOnly(args, "findLast"), "findLast", callPos, ctx);
      const iter = arrayIterInput(lambda, genObj, ctx, "findLast", object);
      const cond2 = iter.wrap(jsBoolIfNeeded(lambdaResult(lambda), genLambdaBody(lambda, iter.bodyCtx)));
      if (!iter.paired) {
        return { $arrayElemAt: [{ $filter: { input: iter.input, as: iter.asName, cond: cond2 } }, -1] };
      }
      return { $arrayElemAt: [{ $arrayElemAt: [{ $filter: { input: iter.input, as: iter.asName, cond: cond2 } }, -1] }, 1] };
    }
    case "findIndex":
    case "findLastIndex": {
      const lambda = requireLambda(exprArgsOnly(args, method), method, callPos, ctx);
      if (lambda.params.length >= 3) {
        throw new CodegenError(
          `.${method}() callbacks take at most 2 parameters (element, index); the third 'array' argument isn't supported. Reference the receiver directly instead.`,
          lambda.pos
        );
      }
      const bodyCtx = elementTypedCtx(ctx, lambda.params, object);
      const vars = { [lambda.params[0]]: { $arrayElemAt: ["$$this", 1] } };
      if (lambda.params[1]) {
        vars[lambda.params[1]] = { $arrayElemAt: ["$$this", 0] };
      }
      const predicate = jsBoolIfNeeded(lambdaResult(lambda), genLambdaBody(lambda, bodyCtx));
      const test = method === "findIndex" ? { $and: [{ $eq: ["$$value", -1] }, predicate] } : predicate;
      return {
        $reduce: {
          input: { $zip: { inputs: [{ $range: [0, { $size: genObj }] }, genObj] } },
          initialValue: -1,
          in: { $let: { vars, in: cond(test, { $arrayElemAt: ["$$this", 0] }, "$$value") } }
        }
      };
    }
    case "concat": {
      checkArity("concat", { sig: "...items", atLeast: 1 }, args.length, callPos);
      const tail = args.map((a) => a.type === "SpreadElement" ? _generate(a.argument, ctx) : _generate(a, ctx));
      if (isArrayProducing(object)) {
        return { $concatArrays: [genObj, ...tail] };
      }
      if (isStringProducing(object)) {
        return { $concat: [genObj, ...tail] };
      }
      return cond({ $isArray: genObj }, { $concatArrays: [genObj, ...tail] }, { $concat: [genObj, ...tail] });
    }
    case "join": {
      const exprArgs = exprArgsOnly(args, "join");
      checkArity("join", { sig: "separator", allowed: [0, 1] }, exprArgs.length, callPos);
      const sep = exprArgs.length === 1 ? _generate(exprArgs[0], ctx) : ",";
      return {
        $reduce: {
          input: genObj,
          initialValue: "",
          in: cond(
            { $eq: ["$$value", ""] },
            { $toString: "$$this" },
            { $concat: ["$$value", sep, { $toString: "$$this" }] }
          )
        }
      };
    }
    case "toString": {
      checkArity("toString", { sig: "", none: true }, args.length, callPos);
      if (isArrayProducing(object)) {
        return {
          $reduce: {
            input: genObj,
            initialValue: "",
            in: cond(
              { $eq: ["$$value", ""] },
              { $toString: "$$this" },
              { $concat: ["$$value", ",", { $toString: "$$this" }] }
            )
          }
        };
      }
      if (isStringProducing(object)) {
        return genObj;
      }
      return { $toString: genObj };
    }
    case "flat": {
      const exprArgs = exprArgsOnly(args, "flat");
      checkArity("flat", { sig: "depth", allowed: [0, 1] }, exprArgs.length, callPos);
      if (exprArgs.length === 1) {
        const arg = exprArgs[0];
        if (arg.type !== "NumberLiteral" || arg.value !== 1) {
          throw new CodegenError(
            `.flat() only supports depth=1 (the default). MongoDB has no recursive flatten primitive.`,
            callPos
          );
        }
      }
      return { $reduce: { input: genObj, initialValue: [], in: { $concatArrays: ["$$value", "$$this"] } } };
    }
    case "flatMap": {
      const lambda = requireLambda(exprArgsOnly(args, "flatMap"), "flatMap", callPos, ctx);
      const iter = arrayIterInput(lambda, genObj, ctx, "flatMap", object);
      return {
        $reduce: {
          input: { $map: { input: iter.input, as: iter.asName, in: iter.wrap(genLambdaBody(lambda, iter.bodyCtx)) } },
          initialValue: [],
          in: { $concatArrays: ["$$value", "$$this"] }
        }
      };
    }
    // ── Array methods (lambda) ──────────────────────────────────────────────
    case "map": {
      const lambda = requireLambda(exprArgsOnly(args, "map"), "map", callPos, ctx);
      const iter = arrayIterInput(lambda, genObj, ctx, "map", object);
      return { $map: { input: iter.input, as: iter.asName, in: iter.wrap(genLambdaBody(lambda, iter.bodyCtx)) } };
    }
    case "filter": {
      const lambda = requireLambda(exprArgsOnly(args, "filter"), "filter", callPos, ctx);
      const iter = arrayIterInput(lambda, genObj, ctx, "filter", object);
      const cond2 = iter.wrap(jsBoolIfNeeded(lambdaResult(lambda), genLambdaBody(lambda, iter.bodyCtx)));
      if (!iter.paired) {
        return { $filter: { input: iter.input, as: iter.asName, cond: cond2 } };
      }
      return {
        $map: {
          input: { $filter: { input: iter.input, as: iter.asName, cond: cond2 } },
          as: "jsmqlPair",
          in: { $arrayElemAt: ["$$jsmqlPair", 1] }
        }
      };
    }
    case "find": {
      const lambda = requireLambda(exprArgsOnly(args, "find"), "find", callPos, ctx);
      const iter = arrayIterInput(lambda, genObj, ctx, "find", object);
      const cond2 = iter.wrap(jsBoolIfNeeded(lambdaResult(lambda), genLambdaBody(lambda, iter.bodyCtx)));
      if (!iter.paired) {
        return { $arrayElemAt: [{ $filter: { input: iter.input, as: iter.asName, cond: cond2 } }, 0] };
      }
      return { $arrayElemAt: [{ $arrayElemAt: [{ $filter: { input: iter.input, as: iter.asName, cond: cond2 } }, 0] }, 1] };
    }
    case "some": {
      const lambda = requireLambda(exprArgsOnly(args, "some"), "some", callPos, ctx);
      const iter = arrayIterInput(lambda, genObj, ctx, "some", object);
      return {
        $anyElementTrue: {
          $map: {
            input: iter.input,
            as: iter.asName,
            in: iter.wrap(jsBoolIfNeeded(lambdaResult(lambda), genLambdaBody(lambda, iter.bodyCtx)))
          }
        }
      };
    }
    case "every": {
      const lambda = requireLambda(exprArgsOnly(args, "every"), "every", callPos, ctx);
      const iter = arrayIterInput(lambda, genObj, ctx, "every", object);
      return {
        $allElementsTrue: {
          $map: {
            input: iter.input,
            as: iter.asName,
            in: iter.wrap(jsBoolIfNeeded(lambdaResult(lambda), genLambdaBody(lambda, iter.bodyCtx)))
          }
        }
      };
    }
    case "reduce":
    case "reduceRight": {
      const exprArgs = exprArgsOnly(args, method);
      checkArity(method, { sig: "lambda, initialValue", exact: 2 }, exprArgs.length, callPos);
      const lambda = requireLambda(exprArgs, method, callPos, ctx);
      if (lambda.params.length < 2 || lambda.params.length > 3) {
        throw new CodegenError(
          `.${method}() lambda must have 2 or 3 parameters (accumulator, element[, index])`,
          callPos
        );
      }
      const accType = isObjectProducing(exprArgs[1]) && isObjectProducing(lambdaResult(lambda)) ? "object" : isArrayProducing(exprArgs[1]) && isArrayProducing(lambdaResult(lambda)) ? "array" : void 0;
      const nextBindingTypes = new Map(ctx.bindingTypes ?? []);
      if (accType) nextBindingTypes.set(lambda.params[0], accType);
      else nextBindingTypes.delete(lambda.params[0]);
      const elemType = arrayElementType(object);
      if (elemType) nextBindingTypes.set(lambda.params[1], elemType);
      else nextBindingTypes.delete(lambda.params[1]);
      if (lambda.params[2]) nextBindingTypes.delete(lambda.params[2]);
      const has3 = lambda.params.length === 3;
      const reduceCtx = {
        lambdaParams: /* @__PURE__ */ new Set([...ctx.lambdaParams, ...lambda.params]),
        reduceRemap: has3 ? /* @__PURE__ */ new Map([[lambda.params[0], "value"]]) : /* @__PURE__ */ new Map([
          [lambda.params[0], "value"],
          [lambda.params[1], "this"]
        ]),
        pipelineLets: ctx.pipelineLets,
        droppedLets: ctx.droppedLets,
        bindingTypes: nextBindingTypes,
        functions: ctx.functions,
        expandingFns: ctx.expandingFns
      };
      const baseBody = genLambdaBody(lambda, reduceCtx);
      const inExpr = has3 ? {
        $let: {
          vars: {
            [safeVarName(lambda.params[1])]: { $arrayElemAt: ["$$this", 1] },
            [safeVarName(lambda.params[2])]: { $arrayElemAt: ["$$this", 0] }
          },
          in: baseBody
        }
      } : baseBody;
      let input = genObj;
      if (has3) {
        input = { $zip: { inputs: [{ $range: [0, { $size: genObj }] }, genObj] } };
      }
      if (method === "reduceRight") {
        input = { $reverseArray: input };
      }
      return { $reduce: { input, initialValue: _generate(exprArgs[1], ctx), in: inExpr } };
    }
    // ── Date methods ────────────────────────────────────────────────────────
    case "getFullYear":
      return { $year: genObj };
    case "getMonth":
      return { $subtract: [{ $month: genObj }, 1] };
    case "getDate":
      return { $dayOfMonth: genObj };
    case "getDay":
      return { $subtract: [{ $dayOfWeek: genObj }, 1] };
    case "getHours":
      return { $hour: genObj };
    case "getMinutes":
      return { $minute: genObj };
    case "getSeconds":
      return { $second: genObj };
    case "getMilliseconds":
      return { $millisecond: genObj };
    // UTC variants: same operators, anchored to UTC via `timezone: "UTC"`.
    case "getUTCFullYear":
      return { $year: utcDate(genObj) };
    case "getUTCMonth":
      return { $subtract: [{ $month: utcDate(genObj) }, 1] };
    case "getUTCDate":
      return { $dayOfMonth: utcDate(genObj) };
    case "getUTCDay":
      return { $subtract: [{ $dayOfWeek: utcDate(genObj) }, 1] };
    case "getUTCHours":
      return { $hour: utcDate(genObj) };
    case "getUTCMinutes":
      return { $minute: utcDate(genObj) };
    case "getUTCSeconds":
      return { $second: utcDate(genObj) };
    case "getUTCMilliseconds":
      return { $millisecond: utcDate(genObj) };
    case "getTime":
      return { $toLong: genObj };
    case "toISOString":
      return { $dateToString: { date: genObj, format: "%Y-%m-%dT%H:%M:%S.%LZ" } };
    case "plus":
    case "minus": {
      const exprArgs = exprArgsOnly(args, method);
      checkArity(method, { sig: "amount, unit[, timezone]", allowed: [2, 3] }, exprArgs.length, callPos);
      checkEnum(`.${method}`, "unit", exprArgs[1], TIME_UNIT);
      checkArgType(`.${method}`, "amount", exprArgs[0], "int-or-long");
      if (exprArgs.length === 3) checkArgType(`.${method}`, "timezone", exprArgs[2], "string");
      const spec = {
        startDate: genObj,
        unit: _generate(exprArgs[1], ctx),
        amount: _generate(exprArgs[0], ctx)
      };
      if (exprArgs.length === 3) spec.timezone = _generate(exprArgs[2], ctx);
      return { [method === "plus" ? "$dateAdd" : "$dateSubtract"]: spec };
    }
    // ── DX shims: mutating Array methods ────────────────────────────────────
    // These all mutate the receiver in JavaScript. In expression position
    // jsmql is immutable, so we surface a tailored "use the immutable
    // equivalent" message. At statement position (a top-level pipeline
    // statement on a field-path receiver), `tryRewriteMutatorCall` rewrites
    // the call to `$.<field> = $.<field>.<immutable>(...)` before codegen
    // sees it — so reaching these throws means the user used a mutator in
    // expression position.
    case "sort":
      throw new CodegenError(
        `.sort() mutates the array in JavaScript. In expression position, use '.toSorted()' \u2014 or call it at statement position (top-level on a '$.<field>' receiver) to mutate the field.`,
        callPos
      );
    case "reverse":
      throw new CodegenError(
        `.reverse() mutates the array in JavaScript. In expression position, use '.toReversed()' \u2014 or call it at statement position (top-level on a '$.<field>' receiver) to mutate the field.`,
        callPos
      );
    case "splice":
      throw new CodegenError(
        `.splice() mutates the array in JavaScript. In expression position, use '.toSpliced(start, deleteCount, ...items)' \u2014 or call it at statement position (top-level on a '$.<field>' receiver) to mutate the field.`,
        callPos
      );
    case "push":
      throw new CodegenError(
        `.push() mutates the array in JavaScript. In expression position, use '.concat(x)' or spread '[...arr, x]' \u2014 or call it at statement position (top-level on a '$.<field>' receiver) to mutate the field.`,
        callPos
      );
    case "pop":
      throw new CodegenError(
        `.pop() mutates the array in JavaScript. In expression position, use '.at(-1)' to read the last element or '.slice(0, -1)' for everything-but-last \u2014 or call it at statement position (top-level on a '$.<field>' receiver) to drop the last element.`,
        callPos
      );
    case "shift":
      throw new CodegenError(
        `.shift() mutates the array in JavaScript. In expression position, use '.at(0)' to read the first element or '.slice(1)' for everything-but-first \u2014 or call it at statement position (top-level on a '$.<field>' receiver) to drop the first element.`,
        callPos
      );
    case "unshift":
      throw new CodegenError(
        `.unshift() mutates the array in JavaScript. In expression position, use '.concat()' with the new items first or spread '[...newItems, ...arr]' \u2014 or call it at statement position (top-level on a '$.<field>' receiver) to prepend in place.`,
        callPos
      );
    case "fill":
      throw new CodegenError(
        `.fill() mutates the array in JavaScript. In expression position there is no direct immutable replacement (build from a $range or pass a pre-filled array as a parameter) \u2014 or call it at statement position (top-level on a '$.<field>' receiver) to fill the field in place.`,
        callPos
      );
    case "copyWithin":
      throw new CodegenError(
        `.copyWithin() mutates the array in JavaScript; jsmql expressions are immutable. Call it at statement position (top-level on a '$.<field>' receiver) to copy-within the field in place, or compose '.slice()' calls with '$concatArrays' for an inline expression.`,
        callPos
      );
    case "unzipWith":
      throw new CodegenError(
        `.unzipWith(fn) isn't supported \u2014 its iteratee's argument count depends on the array's length at runtime. Write '.unzip().map(group => \u2026)' instead, where 'group' is one unzipped column.`,
        callPos
      );
    // ── DX shims: iterator / void / locale methods ──────────────────────────
    // None of these have a sensible lowering to an MQL expression. Throw a
    // pointed error explaining why, with a workaround when one exists.
    case "forEach":
      throw new CodegenError(
        `.forEach() returns undefined in JavaScript; jsmql expressions must produce a value. Use '.map(...)' to transform, or move side-effecting work outside the query.`,
        callPos
      );
    case "entries":
      throw new CodegenError(
        `.entries() returns an iterator in JavaScript and has no MongoDB equivalent. Use '.map((v, i) => [i, v])' if you want [index, value] pairs as an array.`,
        callPos
      );
    case "keys":
      throw new CodegenError(
        `.keys() returns an iterator in JavaScript and has no MongoDB equivalent. Use '$op($range, 0, $op($size, arr))' if you want the index array.`,
        callPos
      );
    case "values":
      throw new CodegenError(
        `.values() returns an iterator in JavaScript and has no MongoDB equivalent. The array itself is already the value sequence \u2014 use it directly.`,
        callPos
      );
    case "toLocaleString":
      throw new CodegenError(
        `.toLocaleString() is locale-dependent and isn't expressible as a MongoDB expression. Use '.join(...)' with explicit formatting, or '$dateToString' for dates.`,
        callPos
      );
    // ── lodash array methods (Phase 1 value vocabulary) ──────────────────────
    case "sum":
    case "mean":
    case "max":
    case "min": {
      checkArity(method, { sig: "", none: true }, exprArgsOnly(args, method).length, callPos);
      const op = method === "sum" ? "$sum" : method === "mean" ? "$avg" : method === "max" ? "$max" : "$min";
      return { [op]: genObj };
    }
    case "sumBy":
    case "meanBy": {
      const exprArgs = exprArgsOnly(args, method);
      checkArity(method, { sig: "iteratee", exact: 1 }, exprArgs.length, callPos);
      const it = resolveIteratee(exprArgs[0], method, ctx);
      return { [method === "sumBy" ? "$sum" : "$avg"]: { $map: { input: genObj, as: it.as, in: it.value } } };
    }
    case "minBy":
    case "maxBy": {
      const exprArgs = exprArgsOnly(args, method);
      checkArity(method, { sig: "iteratee", exact: 1 }, exprArgs.length, callPos);
      const it = resolveIteratee(exprArgs[0], method, ctx);
      return {
        $let: {
          vars: {
            jsmqlSorted: {
              $sortArray: {
                input: { $map: { input: genObj, as: it.as, in: { k: it.value, v: it.elem } } },
                sortBy: { k: 1 }
              }
            }
          },
          in: { $getField: { field: "v", input: { $arrayElemAt: ["$$jsmqlSorted", method === "maxBy" ? -1 : 0] } } }
        }
      };
    }
    case "sortedUniq":
    // MQL has no sorted-array optimisation; alias of the general form.
    case "uniq": {
      checkArity(method, { sig: "", none: true }, exprArgsOnly(args, method).length, callPos);
      return {
        $reduce: {
          input: genObj,
          initialValue: [],
          in: { $cond: [{ $in: ["$$this", "$$value"] }, "$$value", { $concatArrays: ["$$value", ["$$this"]] }] }
        }
      };
    }
    case "sortedUniqBy":
    // alias of .uniqBy (no sorted-array optimisation in MQL)
    case "uniqBy": {
      const exprArgs = exprArgsOnly(args, method);
      checkArity(method, { sig: "iteratee", exact: 1 }, exprArgs.length, callPos);
      return uniqByReduce(genObj, resolveIteratee(exprArgs[0], method, ctx));
    }
    case "compact": {
      checkArity("compact", { sig: "", none: true }, exprArgsOnly(args, "compact").length, callPos);
      return { $filter: { input: genObj, as: "jsmqlItem", cond: "$$jsmqlItem" } };
    }
    case "flatten": {
      checkArity("flatten", { sig: "", none: true }, exprArgsOnly(args, "flatten").length, callPos);
      return {
        $reduce: {
          input: genObj,
          initialValue: [],
          in: { $concatArrays: ["$$value", { $cond: [{ $isArray: "$$this" }, "$$this", ["$$this"]] }] }
        }
      };
    }
    case "chunk": {
      const exprArgs = exprArgsOnly(args, "chunk");
      checkArity("chunk", { sig: "size", exact: 1 }, exprArgs.length, callPos);
      const size = exprArgs[0];
      if (size.type !== "NumberLiteral" || !Number.isInteger(size.value) || size.value < 1) {
        throw new CodegenError(
          `.chunk(size) requires a positive integer literal (got ${size.type === "NumberLiteral" ? size.value : "a non-literal"}).`,
          size.pos
        );
      }
      return {
        $map: {
          input: { $range: [0, { $size: genObj }, size.value] },
          as: "jsmqlI",
          in: { $slice: [genObj, "$$jsmqlI", size.value] }
        }
      };
    }
    // ── lodash positional / slicing (array → element or sub-array) ──────────────
    case "take":
    case "drop":
    case "takeRight":
    case "dropRight": {
      const exprArgs = exprArgsOnly(args, method);
      checkArity(method, { sig: "[n=1]", allowed: [0, 1] }, exprArgs.length, callPos);
      const nArg = exprArgs[0];
      if (nArg !== void 0 && isNegativeLiteral(nArg)) {
        const mirror = method === "take" ? ".takeRight(n)" : method === "takeRight" ? ".take(n)" : null;
        throw new CodegenError(
          `.${method}(n) needs a non-negative count${mirror ? ` \u2014 use ${mirror} to count from the other end` : ""}.`,
          nArg.pos
        );
      }
      const n = nArg !== void 0 ? _generate(nArg, ctx) : 1;
      if (method === "take") return { $slice: [genObj, n] };
      if (method === "takeRight") return { $slice: [genObj, negate(n)] };
      if (method === "dropRight") {
        const keep = { $max: [0, { $subtract: [{ $size: "$$jsmqlArr" }, n] }] };
        return { $let: { vars: { jsmqlArr: genObj }, in: { $slice: ["$$jsmqlArr", keep] } } };
      }
      return {
        $let: { vars: { jsmqlArr: genObj }, in: { $slice: ["$$jsmqlArr", n, { $max: [1, { $size: "$$jsmqlArr" }] }] } }
      };
    }
    case "tail":
    case "initial": {
      checkArity(method, { sig: "", none: true }, exprArgsOnly(args, method).length, callPos);
      if (method === "initial") {
        const keep = { $max: [0, { $subtract: [{ $size: "$$jsmqlArr" }, 1] }] };
        return { $let: { vars: { jsmqlArr: genObj }, in: { $slice: ["$$jsmqlArr", keep] } } };
      }
      return {
        $let: { vars: { jsmqlArr: genObj }, in: { $slice: ["$$jsmqlArr", 1, { $max: [1, { $size: "$$jsmqlArr" }] }] } }
      };
    }
    case "head":
    case "first": {
      checkArity(method, { sig: "", none: true }, exprArgsOnly(args, method).length, callPos);
      return { $first: genObj };
    }
    case "last": {
      checkArity("last", { sig: "", none: true }, exprArgsOnly(args, "last").length, callPos);
      return { $last: genObj };
    }
    case "nth": {
      const exprArgs = exprArgsOnly(args, "nth");
      checkArity("nth", { sig: "[n=0]", allowed: [0, 1] }, exprArgs.length, callPos);
      return { $arrayElemAt: [genObj, exprArgs[0] !== void 0 ? _generate(exprArgs[0], ctx) : 0] };
    }
    case "size": {
      checkArity("size", { sig: "", none: true }, exprArgsOnly(args, "size").length, callPos);
      if (isArrayProducing(object)) return { $size: genObj };
      if (isObjectProducing(object)) return { $size: { $objectToArray: genObj } };
      return cond({ $isArray: genObj }, { $size: genObj }, { $size: { $objectToArray: genObj } });
    }
    case "takeWhile":
    case "dropWhile":
    case "takeRightWhile":
    case "dropRightWhile": {
      const exprArgs = exprArgsOnly(args, method);
      checkArity(method, { sig: "predicate", exact: 1 }, exprArgs.length, callPos);
      const pred = resolvePredicate(exprArgs[0], method, ctx);
      const drop2 = method === "dropWhile" || method === "dropRightWhile";
      const fromRight = method === "takeRightWhile" || method === "dropRightWhile";
      if (!fromRight) return takeDropWhile(genObj, pred, drop2);
      return { $reverseArray: takeDropWhile({ $reverseArray: genObj }, pred, drop2) };
    }
    case "sample": {
      checkArity("sample", { sig: "", none: true }, exprArgsOnly(args, "sample").length, callPos);
      return {
        $let: {
          vars: { jsmqlArr: genObj },
          in: { $arrayElemAt: ["$$jsmqlArr", { $floor: { $multiply: [{ $rand: {} }, { $size: "$$jsmqlArr" }] } }] }
        }
      };
    }
    case "sampleSize": {
      const exprArgs = exprArgsOnly(args, "sampleSize");
      checkArity("sampleSize", { sig: "[n=1]", allowed: [0, 1] }, exprArgs.length, callPos);
      if (exprArgs[0] !== void 0 && isNegativeLiteral(exprArgs[0])) {
        throw new CodegenError(`.sampleSize(n) needs a non-negative count.`, exprArgs[0].pos);
      }
      const n = exprArgs[0] !== void 0 ? _generate(exprArgs[0], ctx) : 1;
      return {
        $let: {
          vars: {
            jsmqlShuffled: {
              $sortArray: {
                input: { $map: { input: genObj, as: "jsmqlItem", in: { k: { $rand: {} }, v: "$$jsmqlItem" } } },
                sortBy: { k: 1 }
              }
            }
          },
          in: { $map: { input: { $slice: ["$$jsmqlShuffled", n] }, as: "jsmqlItem", in: "$$jsmqlItem.v" } }
        }
      };
    }
    case "difference":
    case "intersection": {
      const exprArgs = exprArgsOnly(args, method);
      checkArity(method, { sig: "other", exact: 1 }, exprArgs.length, callPos);
      const other = _generate(exprArgs[0], ctx);
      const inOther = { $in: ["$$jsmqlItem", other] };
      return {
        $filter: { input: genObj, as: "jsmqlItem", cond: method === "intersection" ? inOther : { $not: [inOther] } }
      };
    }
    case "union": {
      const exprArgs = exprArgsOnly(args, "union");
      checkArity("union", { sig: "other", exact: 1 }, exprArgs.length, callPos);
      return {
        $reduce: {
          input: { $concatArrays: [genObj, _generate(exprArgs[0], ctx)] },
          initialValue: [],
          in: { $cond: [{ $in: ["$$this", "$$value"] }, "$$value", { $concatArrays: ["$$value", ["$$this"]] }] }
        }
      };
    }
    case "without": {
      const exprArgs = exprArgsOnly(args, "without");
      checkArity("without", { sig: "...values", atLeast: 1 }, exprArgs.length, callPos);
      const values = exprArgs.map((a) => _generate(a, ctx));
      return { $filter: { input: genObj, as: "jsmqlItem", cond: { $not: [{ $in: ["$$jsmqlItem", values] }] } } };
    }
    case "xor": {
      const exprArgs = exprArgsOnly(args, "xor");
      checkArity("xor", { sig: "other", exact: 1 }, exprArgs.length, callPos);
      const other = _generate(exprArgs[0], ctx);
      const notInB = { $filter: { input: "$$jsmqlA", as: "x", cond: { $not: [{ $in: ["$$x", "$$jsmqlB"] }] } } };
      const notInA = { $filter: { input: "$$jsmqlB", as: "x", cond: { $not: [{ $in: ["$$x", "$$jsmqlA"] }] } } };
      return {
        $let: {
          vars: { jsmqlA: genObj, jsmqlB: other },
          in: {
            $reduce: {
              input: { $concatArrays: [notInB, notInA] },
              initialValue: [],
              in: { $cond: [{ $in: ["$$this", "$$value"] }, "$$value", { $concatArrays: ["$$value", ["$$this"]] }] }
            }
          }
        }
      };
    }
    case "differenceBy":
    case "intersectionBy": {
      const exprArgs = exprArgsOnly(args, method);
      checkArity(method, { sig: "other, iteratee", exact: 2 }, exprArgs.length, callPos);
      const it = resolveIteratee(exprArgs[1], method, ctx);
      const otherKeys = iterateeKeys(_generate(exprArgs[0], ctx), it);
      const inOther = { $in: [it.value, "$$jsmqlOtherKeys"] };
      return {
        $let: {
          vars: { jsmqlOtherKeys: otherKeys },
          in: {
            $filter: { input: genObj, as: it.as, cond: method === "intersectionBy" ? inOther : { $not: [inOther] } }
          }
        }
      };
    }
    case "unionBy": {
      const exprArgs = exprArgsOnly(args, "unionBy");
      checkArity("unionBy", { sig: "other, iteratee", exact: 2 }, exprArgs.length, callPos);
      const it = resolveIteratee(exprArgs[1], "unionBy", ctx);
      return uniqByReduce({ $concatArrays: [genObj, _generate(exprArgs[0], ctx)] }, it);
    }
    case "xorBy": {
      const exprArgs = exprArgsOnly(args, "xorBy");
      checkArity("xorBy", { sig: "other, iteratee", exact: 2 }, exprArgs.length, callPos);
      const it = resolveIteratee(exprArgs[1], "xorBy", ctx);
      const other = _generate(exprArgs[0], ctx);
      const aNotInB = {
        $filter: { input: "$$jsmqlA", as: it.as, cond: { $not: [{ $in: [it.value, "$$jsmqlBKeys"] }] } }
      };
      const bNotInA = {
        $filter: { input: "$$jsmqlB", as: it.as, cond: { $not: [{ $in: [it.value, "$$jsmqlAKeys"] }] } }
      };
      return {
        $let: {
          vars: { jsmqlA: genObj, jsmqlB: other },
          in: {
            $let: {
              vars: { jsmqlAKeys: iterateeKeys("$$jsmqlA", it), jsmqlBKeys: iterateeKeys("$$jsmqlB", it) },
              in: uniqByReduce({ $concatArrays: [aNotInB, bNotInA] }, it)
            }
          }
        }
      };
    }
    case "zipObject": {
      const exprArgs = exprArgsOnly(args, "zipObject");
      checkArity("zipObject", { sig: "values", exact: 1 }, exprArgs.length, callPos);
      const values = _generate(exprArgs[0], ctx);
      return {
        $arrayToObject: {
          $map: {
            input: { $range: [0, { $size: genObj }] },
            as: "jsmqlI",
            in: { k: { $toString: { $arrayElemAt: [genObj, "$$jsmqlI"] } }, v: { $arrayElemAt: [values, "$$jsmqlI"] } }
          }
        }
      };
    }
    case "zip":
    case "zipWith": {
      const exprArgs = exprArgsOnly(args, method);
      const isWith = method === "zipWith";
      checkArity(
        method,
        isWith ? { sig: "...arrays, iteratee", atLeast: 2 } : { sig: "...arrays", atLeast: 1 },
        exprArgs.length,
        callPos
      );
      const fn = isWith ? exprArgs[exprArgs.length - 1] : null;
      const otherArrays = isWith ? exprArgs.slice(0, -1) : exprArgs;
      const arrays = [genObj, ...otherArrays.map((a) => _generate(a, ctx))];
      const vars = {};
      const refs = [];
      arrays.forEach((arr, k) => {
        const v = `jsmqlZip${k}`;
        vars[v] = arr;
        refs.push(`$$${v}`);
      });
      const elems = refs.map((r) => ({ $arrayElemAt: [r, "$$jsmqlI"] }));
      let inExpr = elems;
      if (isWith) {
        if (fn.type !== "Lambda" || fn.block !== void 0 || fn.params.length !== arrays.length) {
          throw new CodegenError(
            `.zipWith(...arrays, iteratee) needs a ${arrays.length}-parameter arrow (one per zipped array).`,
            fn.pos
          );
        }
        const fnVars = {};
        fn.params.forEach((p, k) => {
          fnVars[safeVarName(p)] = elems[k];
        });
        inExpr = { $let: { vars: fnVars, in: _generate(fn.body, extendCtx(ctx, fn.params)) } };
      }
      return {
        $let: {
          vars,
          in: { $map: { input: { $range: [0, { $max: refs.map((r) => ({ $size: r })) }] }, as: "jsmqlI", in: inExpr } }
        }
      };
    }
    case "unzip": {
      checkArity("unzip", { sig: "", none: true }, exprArgsOnly(args, "unzip").length, callPos);
      return {
        $let: {
          vars: { jsmqlT: genObj },
          in: {
            $map: {
              input: { $range: [0, { $size: { $ifNull: [{ $arrayElemAt: ["$$jsmqlT", 0] }, []] } }] },
              as: "jsmqlJ",
              in: { $map: { input: "$$jsmqlT", as: "jsmqlRow", in: { $arrayElemAt: ["$$jsmqlRow", "$$jsmqlJ"] } } }
            }
          }
        }
      };
    }
    case "keyBy": {
      const exprArgs = exprArgsOnly(args, "keyBy");
      checkArity("keyBy", { sig: "[iteratee]", allowed: [0, 1] }, exprArgs.length, callPos);
      const it = resolveIteratee(exprArgs[0], "keyBy", ctx);
      return { $arrayToObject: { $map: { input: genObj, as: it.as, in: { k: stringKeyExpr(it.value), v: it.elem } } } };
    }
    case "groupBy":
    case "countBy": {
      const exprArgs = exprArgsOnly(args, method);
      checkArity(method, { sig: "[iteratee]", allowed: [0, 1] }, exprArgs.length, callPos);
      const it = resolveIteratee(exprArgs[0], method, ctx);
      const filtered = {
        $filter: { input: genObj, as: it.as, cond: { $eq: [stringKeyExpr(it.value), "$$jsmqlKey"] } }
      };
      return {
        $arrayToObject: {
          $map: {
            input: distinctKeysExpr(genObj, it),
            as: "jsmqlKey",
            in: { k: "$$jsmqlKey", v: method === "countBy" ? { $size: filtered } : filtered }
          }
        }
      };
    }
    case "partition":
    case "reject": {
      const exprArgs = exprArgsOnly(args, method);
      checkArity(method, { sig: "predicate", exact: 1 }, exprArgs.length, callPos);
      const p = resolvePredicate(exprArgs[0], method, ctx);
      const yes = { $filter: { input: genObj, as: p.as, cond: p.cond } };
      const no = { $filter: { input: genObj, as: p.as, cond: { $not: [p.cond] } } };
      return method === "reject" ? no : [yes, no];
    }
    // ── lodash object methods (Phase 1 value vocabulary) ─────────────────────
    case "mapValues":
    case "mapKeys": {
      const exprArgs = exprArgsOnly(args, method);
      checkArity(method, { sig: "iteratee", exact: 1 }, exprArgs.length, callPos);
      const mapped = resolveObjIteratee(exprArgs[0], method, ctx);
      const entry = method === "mapValues" ? { k: "$$jsmqlKv.k", v: mapped } : { k: { $toString: mapped }, v: "$$jsmqlKv.v" };
      return { $arrayToObject: { $map: { input: { $objectToArray: genObj }, as: "jsmqlKv", in: entry } } };
    }
    case "pick": {
      const exprArgs = exprArgsOnly(args, "pick");
      checkArity("pick", { sig: "[keys]", exact: 1 }, exprArgs.length, callPos);
      const keys = pickKeys(exprArgs[0], "pick");
      const out = {};
      for (const k of keys) out[k] = { $getField: { field: k, input: "$$jsmqlObj" } };
      return { $let: { vars: { jsmqlObj: genObj }, in: out } };
    }
    case "omit": {
      const exprArgs = exprArgsOnly(args, "omit");
      checkArity("omit", { sig: "[keys]", exact: 1 }, exprArgs.length, callPos);
      const keys = pickKeys(exprArgs[0], "omit");
      return {
        $arrayToObject: {
          $filter: {
            input: { $objectToArray: genObj },
            as: "jsmqlKv",
            cond: { $not: [{ $in: ["$$jsmqlKv.k", keys] }] }
          }
        }
      };
    }
    case "pickBy":
    case "omitBy": {
      const exprArgs = exprArgsOnly(args, method);
      checkArity(method, { sig: "predicate", exact: 1 }, exprArgs.length, callPos);
      const cond2 = resolveObjIteratee(exprArgs[0], method, ctx);
      return {
        $arrayToObject: {
          $filter: {
            input: { $objectToArray: genObj },
            as: "jsmqlKv",
            cond: method === "pickBy" ? cond2 : { $not: [cond2] }
          }
        }
      };
    }
    case "invert": {
      checkArity("invert", { sig: "", none: true }, exprArgsOnly(args, "invert").length, callPos);
      return {
        $arrayToObject: {
          $map: {
            input: { $objectToArray: genObj },
            as: "jsmqlKv",
            in: { k: { $toString: "$$jsmqlKv.v" }, v: "$$jsmqlKv.k" }
          }
        }
      };
    }
    case "toPairs": {
      checkArity("toPairs", { sig: "", none: true }, exprArgsOnly(args, "toPairs").length, callPos);
      return { $map: { input: { $objectToArray: genObj }, as: "jsmqlKv", in: ["$$jsmqlKv.k", "$$jsmqlKv.v"] } };
    }
    case "fromPairs": {
      checkArity("fromPairs", { sig: "", none: true }, exprArgsOnly(args, "fromPairs").length, callPos);
      return {
        $arrayToObject: {
          $map: {
            input: genObj,
            as: "jsmqlP",
            in: [{ $toString: { $arrayElemAt: ["$$jsmqlP", 0] } }, { $arrayElemAt: ["$$jsmqlP", 1] }]
          }
        }
      };
    }
    // ── lodash string methods (Phase 1 value vocabulary; ASCII-only) ─────────
    case "capitalize":
    case "upperFirst":
    case "lowerFirst":
    case "words":
    case "kebabCase":
    case "snakeCase":
    case "startCase":
    case "camelCase":
    case "escape": {
      checkArity(method, { sig: "", none: true }, exprArgsOnly(args, method).length, callPos);
      switch (method) {
        case "capitalize":
          return capitalizeExpr(genObj);
        case "upperFirst":
          return firstCharExpr(genObj, "$toUpper");
        case "lowerFirst":
          return firstCharExpr(genObj, "$toLower");
        case "words":
          return wordsExpr(genObj);
        case "kebabCase":
          return { $toLower: joinWords(wordsExpr(genObj), "-") };
        case "snakeCase":
          return { $toLower: joinWords(wordsExpr(genObj), "_") };
        case "startCase":
          return joinWords(wordsExpr(genObj), " ", capitalizeExpr);
        case "camelCase":
          return {
            $let: {
              vars: { jsmqlPascal: joinWords(wordsExpr(genObj), "", capitalizeExpr) },
              in: firstCharExpr("$$jsmqlPascal", "$toLower")
            }
          };
        default:
          return escapeHtmlExpr(genObj);
      }
    }
    case "truncate": {
      const exprArgs = exprArgsOnly(args, "truncate");
      checkArity("truncate", { sig: "[{ length, omission }]", allowed: [0, 1] }, exprArgs.length, callPos);
      let length = 30;
      let omission = "...";
      if (exprArgs.length === 1) {
        const opts = exprArgs[0];
        if (opts.type !== "ObjectLiteral") {
          throw new CodegenError(
            `.truncate(...) takes an options object, e.g. '.truncate({ length: 24, omission: "\u2026" })'.`,
            opts.pos
          );
        }
        for (const entry of opts.entries) {
          if (entry.type !== "KeyValueEntry" || entry.key.kind !== "static") {
            throw new CodegenError(`.truncate({ \u2026 }) options must be static keys ('length', 'omission').`, entry.pos);
          }
          if (entry.key.name === "length" && entry.value.type === "NumberLiteral") length = entry.value.value;
          else if (entry.key.name === "omission" && entry.value.type === "StringLiteral") omission = entry.value.value;
          else if (entry.key.name === "separator") {
            throw new CodegenError(
              `.truncate({ separator }) (word-boundary truncation) isn't supported \u2014 MQL has no back-search. Use 'length' + 'omission'.`,
              entry.value.pos
            );
          } else {
            throw new CodegenError(
              `.truncate({ ${entry.key.name} }) \u2014 only literal 'length' and 'omission' are supported.`,
              entry.value.pos
            );
          }
        }
      }
      const keep = Math.max(0, length - omission.length);
      return {
        $cond: [
          { $gt: [{ $strLenCP: genObj }, length] },
          { $concat: [{ $substrCP: [genObj, 0, keep] }, omission] },
          genObj
        ]
      };
    }
    // ── lodash number methods (Phase 1 value vocabulary) ─────────────────────
    case "clamp": {
      const exprArgs = exprArgsOnly(args, "clamp");
      checkArity("clamp", { sig: "lower, upper", exact: 2 }, exprArgs.length, callPos);
      return { $min: [{ $max: [genObj, _generate(exprArgs[0], ctx)] }, _generate(exprArgs[1], ctx)] };
    }
    case "inRange": {
      const exprArgs = exprArgsOnly(args, "inRange");
      checkArity("inRange", { sig: "[start, ]end", allowed: [1, 2] }, exprArgs.length, callPos);
      const lo = exprArgs.length === 2 ? _generate(exprArgs[0], ctx) : 0;
      const hi = _generate(exprArgs[exprArgs.length === 2 ? 1 : 0], ctx);
      return { $and: [{ $gte: [genObj, { $min: [lo, hi] }] }, { $lt: [genObj, { $max: [lo, hi] }] }] };
    }
    case "round": {
      const exprArgs = exprArgsOnly(args, "round");
      checkArity("round", { sig: "[precision]", allowed: [0, 1] }, exprArgs.length, callPos);
      const place = exprArgs.length === 1 ? _generate(exprArgs[0], ctx) : 0;
      return { $round: [genObj, place] };
    }
    case "ceil":
    case "floor": {
      const exprArgs = exprArgsOnly(args, method);
      checkArity(method, { sig: "[precision]", allowed: [0, 1] }, exprArgs.length, callPos);
      const op = method === "ceil" ? "$ceil" : "$floor";
      if (exprArgs.length === 0) return { [op]: genObj };
      const factor = { $pow: [10, _generate(exprArgs[0], ctx)] };
      return { $divide: [{ [op]: { $multiply: [genObj, factor] } }, factor] };
    }
    default: {
      const hint = didYouMean(method, KNOWN_METHODS);
      throw new CodegenError(`Unknown method '.${method}()'.${hint}`, callPos);
    }
  }
}
function isNegativeLiteral(e) {
  if (e.type === "NumberLiteral") return e.value < 0;
  if (e.type === "UnaryExpr" && e.op === "-" && e.operand.type === "NumberLiteral") {
    return e.operand.value > 0;
  }
  return false;
}
function arrayIterInput(lambda, genObj, ctx, method, inputExpr) {
  const params = lambda.params;
  if (params.length > 3) {
    throw new CodegenError(
      `.${method}() callbacks take at most 3 parameters (element, index, array); got ${params.length}.`,
      lambda.pos
    );
  }
  const arrayParam = params.length === 3 ? params[2] : void 0;
  const elementCtx = elementTypedCtx(ctx, params, inputExpr);
  const bodyCtx = arrayParam ? { ...elementCtx, bindingTypes: new Map([...elementCtx.bindingTypes ?? [], [arrayParam, "array"]]) } : elementCtx;
  const asName = params[0] ? safeVarName(params[0]) : "v";
  const indexUsed = params.length >= 2 && someExpr(lambda, (e) => e.type === "ParamRef" && e.name === params[1]);
  if (!indexUsed) {
    const wrap = arrayParam ? (body) => ({ $let: { vars: { [safeVarName(arrayParam)]: genObj }, in: body } }) : (body) => body;
    return { input: genObj, asName, bodyCtx, wrap, paired: false };
  }
  return {
    input: { $zip: { inputs: [{ $range: [0, { $size: genObj }] }, genObj] } },
    asName: "jsmqlPair",
    bodyCtx,
    paired: true,
    wrap: (body) => ({
      $let: {
        vars: {
          [safeVarName(params[0])]: { $arrayElemAt: ["$$jsmqlPair", 1] },
          [safeVarName(params[1])]: { $arrayElemAt: ["$$jsmqlPair", 0] },
          ...arrayParam ? { [safeVarName(arrayParam)]: genObj } : {}
        },
        in: body
      }
    })
  };
}
function sortDirLiteral(e) {
  if (e.type === "NumberLiteral") return e.value === 1 ? 1 : e.value === -1 ? -1 : null;
  if (e.type === "UnaryExpr" && e.op === "-" && e.operand.type === "NumberLiteral" && e.operand.value === 1) return -1;
  if (e.type === "StringLiteral") return e.value === "asc" ? 1 : e.value === "desc" ? -1 : null;
  return null;
}
function argToSortBy(arg, method) {
  if (arg.type === "StringLiteral") {
    if (arg.value === "" || arg.value.startsWith("$")) {
      throw new CodegenError(
        `.${method}("field") requires a plain field name (no leading '$'), got ${JSON.stringify(arg.value)}.`,
        arg.pos
      );
    }
    return { [arg.value]: 1 };
  }
  if (arg.type === "ArrayLiteral") {
    if (arg.elements.length === 0)
      throw new CodegenError(`.${method}([fields]) needs at least one field name.`, arg.pos);
    const spec = {};
    for (const el of arg.elements) {
      if (el.type !== "StringLiteral")
        throw new CodegenError(`.${method}([fields]) entries must be field-name strings.`, el.pos);
      spec[el.value] = 1;
    }
    return spec;
  }
  if (arg.type === "ObjectLiteral") {
    if (arg.entries.length === 0) throw new CodegenError(`.${method}({ \u2026 }) needs at least one field.`, arg.pos);
    const spec = {};
    for (const entry of arg.entries) {
      if (entry.type === "SpreadElement")
        throw new CodegenError(`.${method}({ \u2026 }) does not accept spread entries.`, entry.pos);
      if (entry.key.kind !== "static")
        throw new CodegenError(`.${method}({ \u2026 }) keys must be plain field names.`, entry.pos);
      const dir = sortDirLiteral(entry.value);
      if (dir === null) {
        throw new CodegenError(
          `.${method}({ ${entry.key.name}: \u2026 }) direction must be 1 / -1 / "asc" / "desc".`,
          entry.value.pos
        );
      }
      spec[entry.key.name] = dir;
    }
    return spec;
  }
  return lambdaToSortBy(arg, method);
}
function orderByKeyNames(arg, method) {
  const one = (e) => {
    if (e.type === "StringLiteral") {
      if (e.value === "" || e.value.startsWith("$"))
        throw new CodegenError(`.${method}("field") requires a plain field name (no leading '$').`, e.pos);
      return e.value;
    }
    if (e.type === "Lambda") return Object.keys(lambdaToSortBy(e, method))[0];
    throw new CodegenError(`.${method}(keys) entries must be a field name or a key function 'x => x.path'.`, e.pos);
  };
  if (arg.type === "ArrayLiteral") {
    if (arg.elements.length === 0) throw new CodegenError(`.${method}([keys]) needs at least one key.`, arg.pos);
    return arg.elements.map(one);
  }
  return [one(arg)];
}
function orderByDirs(arg, method) {
  const one = (e) => {
    const dir = e.type === "StringLiteral" || e.type === "NumberLiteral" || e.type === "UnaryExpr" ? sortDirLiteral(e) : null;
    if (dir === null)
      throw new CodegenError(`.${method}(keys, orders) directions must be 1 / -1 / "asc" / "desc".`, e.pos);
    return dir;
  };
  if (arg.type === "ArrayLiteral") return arg.elements.map(one);
  return [one(arg)];
}
function lambdaToSortBy(arg, method) {
  if (arg.type !== "Lambda") {
    throw new CodegenError(
      `.${method}() supports 0 or 1 arguments \u2014 an optional key function 'x => x.path' or 'x => -x.path'. For comparator-style sorts use $op($sortArray, { input, sortBy }).`,
      arg.pos
    );
  }
  if (arg.body === void 0) {
    throw new CodegenError(
      `.${method}() does not accept a block-body arrow \u2014 pass an expression-body key function like 'x => x.field'.`,
      arg.pos
    );
  }
  if (arg.params.length !== 1) {
    throw new CodegenError(
      `.${method}() key function takes exactly 1 parameter ('x => x.field'). For comparator-style sorts use $op($sortArray, { input, sortBy }).`,
      arg.pos
    );
  }
  const param = arg.params[0];
  let body = arg.body;
  let direction = 1;
  if (body.type === "UnaryExpr" && body.op === "-") {
    direction = -1;
    body = body.operand;
  }
  const path = paramKeyPath(body, param);
  if (path === null) {
    throw new CodegenError(
      `.${method}() key function body must be '${param}.<field>' (optionally negated). For more complex sort criteria use $op($sortArray, { input, sortBy }).`,
      arg.body.pos
    );
  }
  return { [path]: direction };
}
function paramKeyPath(expr, param) {
  if (expr.type === "ParamRef" && expr.name === param) {
    return null;
  }
  if (expr.type === "MemberAccess") {
    const base = paramKeyPath(expr.object, param);
    if (expr.object.type === "ParamRef" && expr.object.name === param) {
      return expr.member;
    }
    if (base !== null) return `${base}.${expr.member}`;
  }
  return null;
}
var MUTATING_ARRAY_METHODS = /* @__PURE__ */ new Set([
  "sort",
  "reverse",
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "fill",
  "copyWithin"
]);
function isWritableFieldPath(expr) {
  if (expr.type === "FieldRef") return expr.path !== "";
  if (expr.type === "MemberAccess") return isWritableFieldPath(expr.object);
  return false;
}
function tryRewriteMutatorCall(expr) {
  if (expr.type !== "MethodCall") return { kind: "passthrough" };
  if (!MUTATING_ARRAY_METHODS.has(expr.method)) return { kind: "passthrough" };
  if (!isWritableFieldPath(expr.object)) return { kind: "passthrough" };
  const value = buildMutatorRhs(expr.method, expr.object, expr.args, expr.pos);
  return { kind: "rewrite", assign: { type: "AssignExpr", target: expr.object, value, pos: expr.pos } };
}
function buildMutatorRhs(method, object, args, pos) {
  switch (method) {
    case "sort":
      return { type: "MethodCall", object, method: "toSorted", args, pos };
    case "reverse":
      checkArity("reverse", { sig: "", none: true }, args.length, pos);
      return { type: "MethodCall", object, method: "toReversed", args: [], pos };
    case "splice":
      return { type: "MethodCall", object, method: "toSpliced", args, pos };
    case "push": {
      const items = args.map((a) => a);
      const itemsArr = { type: "ArrayLiteral", elements: items, pos };
      return { type: "OperatorCall", name: "$concatArrays", style: "positional", args: [object, itemsArr], pos };
    }
    case "unshift": {
      const items = args.map((a) => a);
      const itemsArr = { type: "ArrayLiteral", elements: items, pos };
      return { type: "OperatorCall", name: "$concatArrays", style: "positional", args: [itemsArr, object], pos };
    }
    case "pop": {
      checkArity("pop", { sig: "", none: true }, args.length, pos);
      const sizeExpr = mkOpCall("$size", [object], pos);
      const minus1 = { type: "BinaryExpr", op: "-", left: sizeExpr, right: mkNumber(1, pos), pos };
      const clamped = mkOpCall("$max", [mkNumber(0, pos), minus1], pos);
      return mkOpCall("$slice", [object, clamped], pos);
    }
    case "shift": {
      checkArity("shift", { sig: "", none: true }, args.length, pos);
      const sizeExpr = mkOpCall("$size", [object], pos);
      const count = mkOpCall("$max", [mkNumber(1, pos), sizeExpr], pos);
      return mkOpCall("$slice", [object, mkNumber(1, pos), count], pos);
    }
    case "fill":
      return buildFillRhs(object, args, pos);
    case "copyWithin":
      return buildCopyWithinRhs(object, args, pos);
  }
  return internalError(`tryRewriteMutatorCall: unhandled method '${method}'`, pos);
}
function buildCopyWithinRhs(object, args, pos) {
  checkArity("copyWithin", { sig: "target, start[, end]", allowed: [2, 3] }, args.length, pos);
  const lits = args.map((a) => {
    if (a.type === "SpreadElement") {
      throw new CodegenError(`.copyWithin(target, start[, end]) does not accept spread arguments.`, a.pos);
    }
    if (a.type !== "NumberLiteral" || !Number.isInteger(a.value) || a.value < 0) {
      throw new CodegenError(
        `.copyWithin(target, start[, end]) requires non-negative integer literals; got '${a.type}'. Computed or negative arguments aren't supported \u2014 JS's negative-indexing isn't representable here.`,
        a.pos
      );
    }
    return a.value;
  });
  const target = lits[0];
  const start = lits[1];
  const endLit = lits.length === 3 ? lits[2] : null;
  const lenExpr = endLit !== null ? mkNumber(Math.max(0, endLit - start), pos) : mkOpCall(
    "$max",
    [mkNumber(0, pos), mkOpCall("$subtract", [mkOpCall("$size", [object], pos), mkNumber(start, pos)], pos)],
    pos
  );
  const suffixStartExpr = endLit !== null ? mkNumber(target + Math.max(0, endLit - start), pos) : mkOpCall("$add", [mkNumber(target, pos), lenExpr], pos);
  const suffixLenExpr = mkOpCall(
    "$max",
    [mkNumber(0, pos), mkOpCall("$subtract", [mkOpCall("$size", [object], pos), suffixStartExpr], pos)],
    pos
  );
  const prefix = mkOpCall("$slice", [object, mkNumber(0, pos), mkNumber(target, pos)], pos);
  const copied = mkOpCall("$slice", [object, mkNumber(start, pos), lenExpr], pos);
  const suffix = mkOpCall("$slice", [object, suffixStartExpr, suffixLenExpr], pos);
  return mkOpCall("$concatArrays", [prefix, copied, suffix], pos);
}
function mkOpCall(name, args, pos) {
  return { type: "OperatorCall", name, style: "positional", args, pos };
}
function mkNumber(value, pos) {
  return { type: "NumberLiteral", value, pos };
}
function buildFillRhs(object, args, pos) {
  checkArity("fill", { sig: "value[, start[, end]]", allowed: [1, 2, 3] }, args.length, pos);
  const exprArgs = [];
  for (const a of args) {
    if (a.type === "SpreadElement") {
      throw new CodegenError(`Spread (...) is not supported as an argument to .fill()`, a.pos);
    }
    exprArgs.push(a);
  }
  const v = exprArgs[0];
  const startArg = exprArgs[1];
  const endArg = exprArgs[2];
  const zero = mkNumber(0, pos);
  if (startArg === void 0 && endArg === void 0) {
    const unusedAndV = { type: "Lambda", params: ["jsmqlFillUnused"], body: v, pos };
    return { type: "MethodCall", object, method: "map", args: [unusedAndV], pos };
  }
  const sizeOf = () => mkOpCall("$size", [object], pos);
  const normalize = (e, defaultIfUndef) => {
    if (e === void 0) return defaultIfUndef();
    if (e.type === "NumberLiteral" && e.value >= 0) return e;
    const isNeg = { type: "BinaryExpr", op: "<", left: e, right: zero, pos };
    const fromTail = { type: "BinaryExpr", op: "+", left: sizeOf(), right: e, pos };
    const clamped = mkOpCall("$max", [zero, fromTail], pos);
    return { type: "TernaryExpr", condition: isNeg, consequent: clamped, alternate: e, pos };
  };
  const s0Init = normalize(startArg, () => zero);
  const e0Init = normalize(endArg, () => sizeOf());
  const sRef = { type: "ParamRef", name: "jsmqlFillStart", pos };
  const eRef = { type: "ParamRef", name: "jsmqlFillEnd", pos };
  const xRef = { type: "ParamRef", name: "x", pos };
  const iRef = { type: "ParamRef", name: "i", pos };
  const condition = {
    type: "BinaryExpr",
    op: "&&",
    left: { type: "BinaryExpr", op: ">=", left: iRef, right: sRef, pos },
    right: { type: "BinaryExpr", op: "<", left: iRef, right: eRef, pos },
    pos
  };
  const mapBody = { type: "TernaryExpr", condition, consequent: v, alternate: xRef, pos };
  const mapLambda = { type: "Lambda", params: ["x", "i"], body: mapBody, pos };
  const mapCall = { type: "MethodCall", object, method: "map", args: [mapLambda], pos };
  const iifeCallee = { type: "Lambda", params: ["jsmqlFillStart", "jsmqlFillEnd"], body: mapCall, pos };
  return { type: "CallExpression", callee: iifeCallee, args: [s0Init, e0Init], pos };
}
var KNOWN_METHODS = new Set(Object.keys(METHODS));
function exprArgsOnly(args, method) {
  return args.map((a) => {
    if (a.type === "SpreadElement") {
      throw new CodegenError(`Spread (...) is not supported as an argument to .${method}()`, a.pos);
    }
    return a;
  });
}
function rejectPredicateOnValueSearch(arg, method, sibling) {
  if (arg?.type !== "Lambda") return;
  const p = arg.params[0] ?? "x";
  throw new CodegenError(
    `.${method}() searches for a value \u2014 it doesn't take a function. To test elements against a predicate, use .${sibling}(${p} => \u2026).`,
    arg.pos
  );
}
function checkArity(method, spec, count, callPos, prefix = ".") {
  const ok2 = spec.none !== void 0 ? count === 0 : spec.exact !== void 0 ? count === spec.exact : spec.allowed !== void 0 ? spec.allowed.includes(count) : count >= spec.atLeast;
  if (ok2) return;
  let quantity;
  if (spec.none !== void 0) {
    quantity = "takes no arguments";
  } else if (spec.exact !== void 0) {
    quantity = `requires exactly ${spec.exact} argument${spec.exact === 1 ? "" : "s"}`;
  } else if (spec.allowed !== void 0) {
    quantity = `requires ${formatCountList(spec.allowed)} arguments`;
  } else {
    quantity = `requires at least ${spec.atLeast} argument${spec.atLeast === 1 ? "" : "s"}`;
  }
  throw new CodegenError(`${prefix}${method}(${spec.sig}) ${quantity}, got ${count}`, callPos);
}
function formatCountList(ns) {
  if (ns.length === 2) return `${ns[0]} or ${ns[1]}`;
  return `${ns.slice(0, -1).join(", ")}, or ${ns[ns.length - 1]}`;
}
function lambdaResult(lambda) {
  return lambda.exprBlock ? lambda.exprBlock.ret : lambda.body;
}
function genLambdaBody(lambda, ctx) {
  return lambda.exprBlock ? generateExprBlock(lambda.exprBlock, ctx) : _generate(lambda.body, ctx);
}
function generateExprBlock(block, ctx) {
  const seen = /* @__PURE__ */ new Set();
  const emptyEnv = /* @__PURE__ */ new Map();
  const fold = (i, c) => {
    if (i === block.decls.length) return _generate(block.ret, c);
    const decl = block.decls[i];
    if (seen.has(decl.name)) {
      throw new CodegenError(
        `\`${decl.kind} ${decl.name}\` is already declared earlier in this block \u2014 re-declaration in the same scope is not allowed; pick a different name.`,
        decl.pos
      );
    }
    seen.add(decl.name);
    if (!c.lambdaParams.has(decl.name)) {
      const r = evalConst(decl.value, emptyEnv, c);
      if (r.ok) {
        const merged = new Map(c.bindings ?? []);
        merged.set(decl.name, r.value);
        let c2 = withBindings(c, merged);
        const t = foldedCompoundType(r.value);
        if (t) c2 = { ...c2, bindingTypes: new Map([...c.bindingTypes ?? [], [decl.name, t]]) };
        return fold(i + 1, c2);
      }
    }
    const value = _generate(decl.value, c);
    const inner = extendCtx(c, [decl.name]);
    return { $let: { vars: { [safeVarName(decl.name)]: value }, in: fold(i + 1, inner) } };
  };
  return fold(0, ctx);
}
function foldedCompoundType(v) {
  if (typeof v === "string") return "string";
  if (Array.isArray(v)) return "array";
  if (v !== null && typeof v === "object" && !isOpaqueBsonValue(v)) return "object";
  return void 0;
}
function requireLambda(args, method, callerPos, ctx) {
  const first = args[0];
  if (first?.type === "TypeCastRef") {
    return {
      type: "Lambda",
      params: ["v"],
      body: {
        type: "TypeCast",
        cast: first.cast,
        arg: { type: "ParamRef", name: "v", pos: first.pos },
        pos: first.pos
      },
      pos: first.pos
    };
  }
  if (first?.type === "MathCallRef") {
    return {
      type: "Lambda",
      params: ["v"],
      body: {
        type: "MathCall",
        method: first.method,
        args: [{ type: "ParamRef", name: "v", pos: first.pos }],
        pos: first.pos
      },
      pos: first.pos
    };
  }
  if (first !== void 0 && (first.type === "StringLiteral" || first.type === "ObjectLiteral" || first.type === "ArrayLiteral")) {
    const sh = shorthandToLambda(first, method, "jsmqlItem");
    if (sh !== null) return sh;
  }
  if (!first || first.type !== "Lambda") {
    if (first?.type === "ParamRef" && ctx?.functions?.has(first.name)) {
      throw new CodegenError(
        `.${method}() got the reusable function '${first.name}' as a bare callback \u2014 pass a lambda that calls it: \`.${method}(x => ${first.name}(x))\`.`,
        first.pos
      );
    }
    throw new CodegenError(
      `.${method}() requires a lambda as its first argument, e.g. x => x > 0`,
      first?.pos ?? callerPos
    );
  }
  if (first.block !== void 0) {
    throw new CodegenError(
      `.${method}() does not accept a statement-block body (a sub-pipeline of stages) \u2014 that form is only for '$$$.<coll>.find/filter(...)' and '$$.filter(...)'. Use an expression \`x => x > 0\`, or a value-returning block \`x => { const y = \u2026; return y; }\`.`,
      first.pos
    );
  }
  return first;
}
function applyLambda(lambda, args, argCtx, bodyCtx, pos, label) {
  if (lambda.block !== void 0) {
    throw new CodegenError(
      `${label} cannot have a statement-block body (a sub-pipeline of stages) \u2014 that form is only for '$$$.<coll>.find/filter(...)'. Use an expression, or a value-returning block \`(x) => { const y = \u2026; return y; }\`.`,
      lambda.pos
    );
  }
  if (lambda.params.length !== args.length) {
    throw new CodegenError(
      `${label}: expected ${lambda.params.length} argument(s)${lambda.params.length ? ` for params (${lambda.params.join(", ")})` : ""}, got ${args.length}.`,
      pos
    );
  }
  const vars = {};
  for (let i = 0; i < lambda.params.length; i++) {
    const a = args[i];
    if (a.type === "SpreadElement") {
      throw new CodegenError(
        `${label}: spread arguments aren't supported \u2014 pass each argument explicitly, or use $op($let, ...) to build the bindings by hand.`,
        a.pos
      );
    }
    vars[lambda.params[i]] = _generate(a, argCtx);
  }
  return { $let: { vars, in: genLambdaBody(lambda, bodyCtx) } };
}
function generateCallExpression(callee, args, ctx, pos) {
  if (callee.type === "ParamRef") {
    const fn = ctx.functions?.get(callee.name);
    if (fn !== void 0) {
      if (ctx.expandingFns?.has(callee.name)) {
        throw new CodegenError(
          `Recursive function calls aren't supported \u2014 a MongoDB expression can't call itself. '${callee.name}' is invoked while it is still being expanded (direct or mutual recursion). Rewrite it without recursion.`,
          pos
        );
      }
      const marked = { ...ctx, expandingFns: /* @__PURE__ */ new Set([...ctx.expandingFns ?? [], callee.name]) };
      const bodyCtx2 = extendCtx(marked, fn.lambda.params);
      return applyLambda(fn.lambda, args, ctx, bodyCtx2, pos, `Function '${callee.name}'`);
    }
    if (callee.name === ASSERT_FN_NAME) {
      throw new CodegenError(
        `'assert(...)' is a pipeline statement, not a value \u2014 it can't appear inside an expression. Use it as its own statement in a pipeline body, e.g. \`({ $ }) => { assert($.qty >= 0, "qty must be >= 0"); \u2026 }\`.`,
        pos
      );
    }
    throw new CodegenError(
      `Unknown function '${callee.name}(...)'.${didYouMean(callee.name, [...ctx.functions?.keys() ?? []], (s) => `${s}(...)`)} Declare it first with \`const ${callee.name} = (\u2026) => \u2026;\` at the top level of a pipeline; for a MongoDB operator write \`$${callee.name}(...)\`; for a method, \`receiver.${callee.name}(...)\`.`,
      pos
    );
  }
  if (callee.type !== "Lambda") {
    throw new CodegenError(
      `Direct call '(...)(args)' is only supported when the callee is an arrow function (IIFE \u2192 $let) or a declared function name. For named operators use $opName(...); for methods use receiver.method(...).`,
      pos
    );
  }
  const bodyCtx = extendCtx(ctx, callee.params);
  return applyLambda(callee, args, ctx, bodyCtx, pos, "IIFE");
}
var ASSERT_FN_NAME = "assert";
var ASSERT_FAIL_BASE = "jsmql assertion failed";
function generateAssertGuardExpr(args, ctx, callPos) {
  const exprArgs = args.map((a) => {
    if (a.type === "SpreadElement") {
      throw new CodegenError(`Spread (...) is not supported as an argument to 'assert(...)'.`, a.pos);
    }
    return a;
  });
  checkArity("assert", { sig: "condition[, message]", allowed: [1, 2] }, exprArgs.length, callPos, "");
  const condition = jsBoolIfNeeded(exprArgs[0], _generate(exprArgs[0], ctx));
  return { $convert: { input: true, to: { $cond: [condition, "bool", assertFailType(exprArgs[1], ctx)] } } };
}
function assertFailType(msgExpr, ctx) {
  if (msgExpr === void 0) return ASSERT_FAIL_BASE;
  if (msgExpr.type === "StringLiteral") return `${ASSERT_FAIL_BASE}: ${msgExpr.value}`;
  return { $concat: [`${ASSERT_FAIL_BASE}: `, { $toString: _generate(msgExpr, ctx) }] };
}
function generateTypeCast(cast, arg, ctx, _pos) {
  const val = _generate(arg, ctx);
  switch (cast) {
    case "Number":
    case "parseFloat":
      return { $toDouble: val };
    case "String":
      return { $toString: val };
    case "Boolean":
      return jsBoolIfNeeded(arg, val);
    case "parseInt":
      return { $toInt: val };
  }
}
function generateMathConst(name) {
  switch (name) {
    case "PI":
      return Math.PI;
    case "E":
      return Math.E;
  }
}
function generateMathCall(method, args, ctx, pos) {
  switch (method) {
    case "abs":
      return { $abs: oneArg(method, args, ctx, pos) };
    case "ceil":
      return { $ceil: oneArg(method, args, ctx, pos) };
    case "floor":
      return { $floor: oneArg(method, args, ctx, pos) };
    case "round":
      return { $round: [oneArg(method, args, ctx, pos), 0] };
    case "sqrt":
      return { $sqrt: oneArg(method, args, ctx, pos) };
    case "exp":
      return { $exp: oneArg(method, args, ctx, pos) };
    case "log":
      return { $ln: oneArg(method, args, ctx, pos) };
    case "log2":
      return { $log: [oneArg(method, args, ctx, pos), 2] };
    case "log10":
      return { $log10: oneArg(method, args, ctx, pos) };
    case "trunc":
      return { $trunc: oneArg(method, args, ctx, pos) };
    case "sign":
      return { $cmp: [oneArg(method, args, ctx, pos), 0] };
    case "cbrt":
      return { $pow: [oneArg(method, args, ctx, pos), { $divide: [1, 3] }] };
    case "pow": {
      const exprArgs = exprArgsOnly(args, "pow");
      checkArity("pow", { sig: "base, exponent", exact: 2 }, exprArgs.length, pos, "Math.");
      return { $pow: [_generate(exprArgs[0], ctx), _generate(exprArgs[1], ctx)] };
    }
    case "min":
    case "max": {
      checkArity(method, { sig: "...values", atLeast: 1 }, args.length, pos, "Math.");
      const op = method === "min" ? "$min" : "$max";
      if (args.length === 1 && args[0].type !== "SpreadElement") {
        return { [op]: _generate(args[0], ctx) };
      }
      return { [op]: generateVariadicArgs(args, ctx) };
    }
    case "hypot": {
      const exprArgs = exprArgsOnly(args, "hypot");
      checkArity("hypot", { sig: "...values", atLeast: 1 }, exprArgs.length, pos, "Math.");
      const squares = exprArgs.map((a) => ({ $pow: [_generate(a, ctx), 2] }));
      return { $sqrt: { $add: squares } };
    }
    case "random":
      checkArity("random", { sig: "", none: true }, args.length, pos, "Math.");
      return { $rand: {} };
    case "sin":
      return { $sin: oneArg(method, args, ctx, pos) };
    case "cos":
      return { $cos: oneArg(method, args, ctx, pos) };
    case "tan":
      return { $tan: oneArg(method, args, ctx, pos) };
    case "asin":
      return { $asin: oneArg(method, args, ctx, pos) };
    case "acos":
      return { $acos: oneArg(method, args, ctx, pos) };
    case "atan":
      return { $atan: oneArg(method, args, ctx, pos) };
    case "atan2": {
      const exprArgs = exprArgsOnly(args, "atan2");
      checkArity("atan2", { sig: "y, x", exact: 2 }, exprArgs.length, pos, "Math.");
      return { $atan2: [_generate(exprArgs[0], ctx), _generate(exprArgs[1], ctx)] };
    }
    case "sinh":
      return { $sinh: oneArg(method, args, ctx, pos) };
    case "cosh":
      return { $cosh: oneArg(method, args, ctx, pos) };
    case "tanh":
      return { $tanh: oneArg(method, args, ctx, pos) };
    case "asinh":
      return { $asinh: oneArg(method, args, ctx, pos) };
    case "acosh":
      return { $acosh: oneArg(method, args, ctx, pos) };
    case "atanh":
      return { $atanh: oneArg(method, args, ctx, pos) };
  }
}
function oneArg(method, args, ctx, pos) {
  const exprArgs = exprArgsOnly(args, method);
  checkArity(method, { sig: "value", exact: 1 }, exprArgs.length, pos, "Math.");
  return _generate(exprArgs[0], ctx);
}
function generateObjectCall(method, args, ctx, pos) {
  const genWith = (arg, neutral) => {
    const gen = _generate(arg, ctx);
    return chainHasOptional(arg) ? wrapIfNull(gen, neutral) : gen;
  };
  switch (method) {
    case "keys": {
      const exprArgs = exprArgsOnly(args, "Object.keys");
      checkArity("keys", { sig: "obj", exact: 1 }, exprArgs.length, pos, "Object.");
      return { $map: { input: { $objectToArray: genWith(exprArgs[0], {}) }, as: "kv", in: "$$kv.k" } };
    }
    case "values": {
      const exprArgs = exprArgsOnly(args, "Object.values");
      checkArity("values", { sig: "obj", exact: 1 }, exprArgs.length, pos, "Object.");
      return { $map: { input: { $objectToArray: genWith(exprArgs[0], {}) }, as: "kv", in: "$$kv.v" } };
    }
    case "entries": {
      const exprArgs = exprArgsOnly(args, "Object.entries");
      checkArity("entries", { sig: "obj", exact: 1 }, exprArgs.length, pos, "Object.");
      return { $objectToArray: genWith(exprArgs[0], {}) };
    }
    case "fromEntries": {
      const exprArgs = exprArgsOnly(args, "Object.fromEntries");
      checkArity("fromEntries", { sig: "entries", exact: 1 }, exprArgs.length, pos, "Object.");
      return { $arrayToObject: genWith(exprArgs[0], []) };
    }
    case "assign": {
      checkArity("assign", { sig: "...sources", atLeast: 1 }, args.length, pos, "Object.");
      return { $mergeObjects: generateVariadicArgs(args, ctx) };
    }
    case "groupBy": {
      const exprArgs = exprArgsOnly(args, "Object.groupBy");
      checkArity("groupBy", { sig: "items, x => key", exact: 2 }, exprArgs.length, pos, "Object.");
      const input = exprArgs[0];
      const lambda = exprArgs[1];
      if (lambda.type !== "Lambda" || lambda.params.length !== 1) {
        throw new CodegenError(
          `Object.groupBy() requires a single-parameter arrow function as the discriminator`,
          lambda.pos
        );
      }
      if (lambda.block !== void 0) {
        throw new CodegenError(
          `Object.groupBy() does not accept a statement-block arrow (a sub-pipeline) \u2014 that form is only for '$$$.<coll>.find/filter(...)'. Use an expression \`x => x.key\`, or a value-returning block.`,
          lambda.pos
        );
      }
      const keyCtx = {
        lambdaParams: /* @__PURE__ */ new Set([...ctx.lambdaParams, lambda.params[0]]),
        reduceRemap: /* @__PURE__ */ new Map([[lambda.params[0], "this"]]),
        pipelineLets: ctx.pipelineLets,
        droppedLets: ctx.droppedLets,
        bindingTypes: ctx.bindingTypes,
        functions: ctx.functions,
        expandingFns: ctx.expandingFns
      };
      const keyBody = genLambdaBody(lambda, keyCtx);
      const keyExpr2 = isStringProducing(lambdaResult(lambda)) ? keyBody : { $toString: keyBody };
      return {
        $reduce: {
          input: _generate(input, ctx),
          initialValue: {},
          in: {
            $let: {
              vars: { key: keyExpr2 },
              in: {
                $mergeObjects: [
                  "$$value",
                  {
                    $arrayToObject: [
                      [
                        [
                          "$$key",
                          {
                            $concatArrays: [
                              { $ifNull: [{ $getField: { field: "$$key", input: "$$value" } }, []] },
                              ["$$this"]
                            ]
                          }
                        ]
                      ]
                    ]
                  }
                ]
              }
            }
          }
        }
      };
    }
  }
}
function evalConstDate(args) {
  if (args.length === 0) return null;
  if (args.length === 1) {
    const arg = args[0];
    if (arg.type === "DateUTC") {
      const utc = constNumberArgs(arg.args);
      return utc === null ? null : new Date(utcMs(utc));
    }
    if (arg.type === "NumberLiteral") return new Date(arg.value);
    if (arg.type === "StringLiteral") return new Date(arg.value);
    return null;
  }
  const nums = constNumberArgs(args);
  if (nums === null) return null;
  return new Date(utcMs(nums));
}
function foldConstantDate(args) {
  const d = evalConstDate(args);
  return d !== null && !Number.isNaN(d.getTime()) ? d : null;
}
function utcMs(parts) {
  return Date.UTC(...parts);
}
function constNumberArgs(args) {
  const out = [];
  for (const a of args) {
    if (a.type !== "NumberLiteral") return null;
    out.push(a.value);
  }
  return out;
}
function invalidConstDateError(args) {
  const first = args[0];
  if (args.length === 1 && first.type === "StringLiteral") {
    return new CodegenError(
      `new Date("${first.value}") \u2014 "${first.value}" is not a valid date string. Use an ISO 8601 date like "2026-01-01" or "2026-01-01T00:00:00.000Z".`,
      first.pos
    );
  }
  return new CodegenError(
    `new Date(\u2026) \u2014 these arguments produce an invalid date (out of the representable range).`,
    first.pos
  );
}
function generateNewDate(args, ctx) {
  const constEval = evalConstDate(args);
  if (constEval !== null) {
    if (Number.isNaN(constEval.getTime())) throw invalidConstDateError(args);
    return constEval;
  }
  if (args.length === 0) return { $toDate: "$$NOW" };
  if (args.length === 1) {
    const arg = args[0];
    if (arg.type === "DateUTC") {
      return generateDateFromParts(arg.args, ctx, "UTC");
    }
    return { $toDate: _generate(arg, ctx) };
  }
  return generateDateFromParts(
    args,
    ctx,
    /*timezone*/
    null
  );
}
function generateDateUTC(args, ctx) {
  return { $toLong: generateDateFromParts(args, ctx, "UTC") };
}
function generateDateFromParts(args, ctx, timezone) {
  const parts = { year: _generate(args[0], ctx) };
  if (args.length >= 2) {
    const monthAst = args[1];
    if (monthAst.type === "NumberLiteral") {
      parts.month = monthAst.value + 1;
    } else {
      parts.month = { $add: [_generate(monthAst, ctx), 1] };
    }
  }
  const slots = ["day", "hour", "minute", "second", "millisecond"];
  for (let i = 2; i < args.length && i - 2 < slots.length; i++) {
    parts[slots[i - 2]] = _generate(args[i], ctx);
  }
  if (timezone !== null) parts.timezone = timezone;
  return { $dateFromParts: parts };
}
function generateArrayFrom(input, mapFn, ctx, pos) {
  if (input.type !== "ObjectLiteral") {
    throw new CodegenError(
      `Array.from() only supports the {length: n} form: Array.from({length: n}, (_, i) => \u2026). For other inputs use $op($range, \u2026) or .map().`,
      input.pos
    );
  }
  if (input.entries.length !== 1) {
    throw new CodegenError(`Array.from({length: n}) \u2014 exactly one 'length' entry is required`, input.pos);
  }
  const entry = input.entries[0];
  if (entry.type !== "KeyValueEntry" || entry.key.kind !== "static" || entry.key.name !== "length") {
    throw new CodegenError(`Array.from() only supports {length: n}; saw a different object shape`, entry.pos);
  }
  const lengthExpr = _generate(entry.value, ctx);
  if (mapFn === null) {
    return { $range: [0, lengthExpr] };
  }
  if (mapFn.type !== "Lambda") {
    throw new CodegenError(`Array.from() second argument must be an arrow function (e.g. (_, i) => i * 2)`, mapFn.pos);
  }
  if (mapFn.block !== void 0) {
    throw new CodegenError(
      `Array.from() does not accept a statement-block arrow (a sub-pipeline) \u2014 that form is only for '$$$.<coll>.find/filter(...)'. Use an expression \`(_, i) => i * 2\`, or a value-returning block.`,
      mapFn.pos
    );
  }
  if (mapFn.params.length !== 2) {
    throw new CodegenError(
      `Array.from() map function must take 2 parameters (element, index) \u2014 element is always null in the {length} form`,
      mapFn.pos
    );
  }
  void pos;
  const [elemParam, idxParam] = mapFn.params;
  const bodyCtx = extendCtx(ctx, mapFn.params);
  return {
    $map: {
      input: { $range: [0, lengthExpr] },
      as: safeVarName(idxParam),
      in: { $let: { vars: { [safeVarName(elemParam)]: null }, in: genLambdaBody(mapFn, bodyCtx) } }
    }
  };
}
function generateNumberStatic(method, arg, ctx) {
  const val = _generate(arg, ctx);
  const pos = arg.pos;
  switch (method) {
    case "isInteger":
      return cond(
        { $in: [{ $type: val }, ["int", "long"]] },
        true,
        cond({ $in: [{ $type: val }, ["double", "decimal"]] }, { $eq: [val, { $trunc: val }] }, false)
      );
    case "isNaN":
      return { $ne: [val, val] };
    case "isFinite":
      throw new CodegenError(
        `Number.isFinite($.x) is not yet supported in jsmql [DEF-022] \u2014 there is no syntax for Infinity/NaN literals to compare against. Workarounds: (1) check the BSON type with $type($.x) and reject "double" values you know to be non-finite at the source, (2) use $op($convert, { input: $.x, to: "double", onError: 0 }) to substitute a sentinel for any non-finite value, (3) constrain to a known range (e.g. $.x > -1e300 && $.x < 1e300) if your domain allows it. See docs/DEFERRED.md.`,
        pos
      );
  }
}
function generateSetMethodCall(receiver, method, args, ctx) {
  const pos = receiver.pos;
  const genSetInner = (inner) => {
    const gen = _generate(inner, ctx);
    return chainHasOptional(inner) ? wrapIfNull(gen, []) : gen;
  };
  const lhs = receiver.arg ? genSetInner(receiver.arg) : [];
  const exprArgs = exprArgsOnly(args, `Set.${method}`);
  const requireSetArg = () => {
    checkArity(method, { sig: "other", exact: 1 }, exprArgs.length, pos, "Set.");
    const arg = exprArgs[0];
    if (arg.type !== "NewSet") {
      throw new CodegenError(
        `Set.${method}()'s argument must be a 'new Set(...)' expression, not a plain value`,
        arg.pos
      );
    }
    return arg.arg ? genSetInner(arg.arg) : [];
  };
  switch (method) {
    case "intersection":
      return { $setIntersection: [lhs, requireSetArg()] };
    case "union":
      return { $setUnion: [lhs, requireSetArg()] };
    case "difference":
      return { $setDifference: [lhs, requireSetArg()] };
    case "isSubsetOf":
      return { $setIsSubset: [lhs, requireSetArg()] };
    case "isSupersetOf":
      return { $setIsSubset: [requireSetArg(), lhs] };
    case "symmetricDifference":
    case "isDisjointFrom":
      throw new CodegenError(
        `Set.${method}() has no MongoDB equivalent \u2014 compose via $setDifference / $setIntersection / $setUnion as needed`,
        pos
      );
    default: {
      const setHint = didYouMean(method, SET_METHODS);
      throw new CodegenError(`Unknown Set method '.${method}()'.${setHint} Supported: ${SET_METHODS.join(", ")}.`, pos);
    }
  }
}
function generateRegexMethodCall(regex, method, args, ctx) {
  const pos = regex.pos;
  const exprArgs = exprArgsOnly(args, `regex.${method}`);
  checkArity(method, { sig: "str", exact: 1 }, exprArgs.length, pos, "regex.");
  const input = _generate(exprArgs[0], ctx);
  const opName = method === "test" ? "$regexMatch" : method === "exec" ? "$regexFind" : null;
  if (!opName) {
    const regexHint = didYouMean(method, ["test", "exec"]);
    throw new CodegenError(
      `Unknown regex method '.${method}()'.${regexHint} Supported: regex.test(str), regex.exec(str).`,
      pos
    );
  }
  const obj2 = { input, regex: regex.pattern };
  const opts = mongoRegexOptions(regex.flags);
  if (opts) obj2["options"] = opts;
  return { [opName]: obj2 };
}
function generateUpdateFilter(prog, ctx = EMPTY_CTX) {
  if (prog.ops.length === 0) {
    throw new CodegenError("UpdateOp program must contain at least one assignment or delete", prog.pos);
  }
  const groups = groupUpdateOps(prog.ops);
  const stages = groups.map((g) => generateUpdateOpGroup(g, ctx));
  if (stages.length === 1) return stages[0];
  return stages;
}
function generateUpdateOpGroups(ops, ctx = EMPTY_CTX) {
  const groups = groupUpdateOps(ops);
  return groups.map((g) => generateUpdateOpGroup(g, ctx));
}
function groupUpdateOps(ops) {
  const groups = [];
  let current = [];
  let writes = /* @__PURE__ */ new Set();
  let kind = null;
  for (const m of ops) {
    const myKind = m.type === "AssignExpr" ? "assign" : "delete";
    const writePath = updateOpWritePath(m);
    const reads = m.type === "AssignExpr" ? collectUpdateOpReads(m.value) : null;
    let mustBreak = false;
    if (kind !== null && kind !== myKind) {
      mustBreak = true;
    }
    if (!mustBreak) {
      for (const w of writes) {
        if (pathsCollide(w, writePath)) {
          mustBreak = true;
          break;
        }
      }
    }
    if (!mustBreak && reads !== null) {
      for (const r of reads) {
        for (const w of writes) {
          if (pathsCollide(w, r)) {
            mustBreak = true;
            break;
          }
        }
        if (mustBreak) break;
      }
    }
    if (mustBreak && current.length > 0) {
      groups.push(current);
      current = [];
      writes = /* @__PURE__ */ new Set();
    }
    current.push(m);
    writes.add(writePath);
    kind = myKind;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}
function generateUpdateOpGroup(group, ctx) {
  if (group.length === 0) {
    internalError("empty update op group");
  }
  if (group[0].type === "AssignExpr") {
    const fields = {};
    for (const m of group) {
      if (m.type !== "AssignExpr") {
        internalError("mixed-kind update op group");
      }
      const path = updateOpWritePath(m);
      if (Object.prototype.hasOwnProperty.call(fields, path)) {
        internalError(`field '${path}' written twice in same group`);
      }
      fields[path] = _generate(m.value, ctx);
    }
    return { $set: fields };
  }
  const paths = [];
  for (const m of group) {
    if (m.type !== "DeleteStmt") {
      internalError("mixed-kind update op group");
    }
    paths.push(updateOpWritePath(m));
  }
  return paths.length === 1 ? { $unset: paths[0] } : { $unset: paths };
}
function updateOpWritePath(m) {
  return targetToPath(m.target);
}
function targetToPath(target) {
  if (target.type === "FieldRef") return target.path;
  if (target.type === "MemberAccess") {
    return `${targetToPath(target.object)}.${target.member}`;
  }
  if (target.type === "ParamRef") {
    throw new CodegenError(
      `Cannot assign to bare identifier '${target.name}'. Reassignable \`let\` bindings exist only inside a pipeline \u2014 add a \`;\` to enter pipeline mode and declare it first (\`let ${target.name} = \u2026\`). To write a document field, use a field path: \`$.${target.name} = \u2026\`.`,
      target.pos
    );
  }
  internalError("update op target is not a field path (parser should have rejected)");
}
function collectUpdateOpReads(expr) {
  const out = /* @__PURE__ */ new Set();
  collectReadsInto(expr, out);
  return out;
}
function collectReadsInto(expr, out) {
  const path = tryFieldPath(expr);
  if (path !== null) {
    out.add(path);
    return;
  }
  switch (expr.type) {
    case "FieldRef":
      out.add(expr.path);
      return;
    case "NumberLiteral":
    case "BigIntLiteral":
    case "StringLiteral":
    case "BooleanLiteral":
    case "NullLiteral":
    case "UndefinedLiteral":
    case "RegexLiteral":
    case "ParamRef":
    case "MathConst":
    case "MathCallRef":
    case "DateNow":
    case "ObjectIdLiteral":
    case "TypeCastRef":
      return;
    case "ArrayLiteral":
      for (const el of expr.elements) {
        if (el.type === "SpreadElement") collectReadsInto(el.argument, out);
        else if (el.type === "AssignExpr" || el.type === "DeleteStmt" || el.type === "LetDecl" || el.type === "FuncDecl") {
        } else collectReadsInto(el, out);
      }
      return;
    case "ObjectLiteral":
      for (const e of expr.entries) {
        if (e.type === "SpreadElement") {
          collectReadsInto(e.argument, out);
        } else {
          if (e.key.kind === "computed") collectReadsInto(e.key.expr, out);
          collectReadsInto(e.value, out);
        }
      }
      return;
    case "TemplateLiteral":
      for (const e of expr.expressions) collectReadsInto(e, out);
      return;
    case "BinaryExpr":
      collectReadsInto(expr.left, out);
      collectReadsInto(expr.right, out);
      return;
    case "UnaryExpr":
      collectReadsInto(expr.operand, out);
      return;
    case "TernaryExpr":
      collectReadsInto(expr.condition, out);
      collectReadsInto(expr.consequent, out);
      collectReadsInto(expr.alternate, out);
      return;
    case "IndexAccess":
      collectReadsInto(expr.object, out);
      collectReadsInto(expr.index, out);
      return;
    case "MemberAccess":
      collectReadsInto(expr.object, out);
      return;
    case "MethodCall":
      collectReadsInto(expr.object, out);
      collectArgsInto(expr.args, out);
      return;
    case "CallExpression":
      collectReadsInto(expr.callee, out);
      collectArgsInto(expr.args, out);
      return;
    case "Lambda":
      if (expr.body !== void 0) collectReadsInto(expr.body, out);
      if (expr.exprBlock !== void 0) {
        for (const d of expr.exprBlock.decls) collectReadsInto(d.value, out);
        collectReadsInto(expr.exprBlock.ret, out);
      }
      return;
    case "TypeofExpr":
      collectReadsInto(expr.operand, out);
      return;
    case "NewDate":
      for (const a of expr.args) collectReadsInto(a, out);
      return;
    case "NewSet":
      if (expr.arg) collectReadsInto(expr.arg, out);
      return;
    case "TypeCast":
      collectReadsInto(expr.arg, out);
      return;
    case "MathCall":
    case "ObjectCall":
      collectArgsInto(expr.args, out);
      return;
    case "ArrayFrom":
      collectReadsInto(expr.input, out);
      if (expr.mapFn) collectReadsInto(expr.mapFn, out);
      return;
    case "NumberStatic":
      collectReadsInto(expr.arg, out);
      return;
    case "OperatorCall":
      collectArgsInto(expr.args, out);
      return;
    case "DateUTC":
      for (const a of expr.args) collectReadsInto(a, out);
      return;
  }
}
function collectArgsInto(args, out) {
  for (const a of args) {
    if (a.type === "SpreadElement") collectReadsInto(a.argument, out);
    else collectReadsInto(a, out);
  }
}
function tryFieldPath(expr) {
  if (expr.type === "FieldRef") return expr.path;
  if (expr.type === "MemberAccess") {
    const base = tryFieldPath(expr.object);
    if (base !== null) return `${base}.${expr.member}`;
  }
  return null;
}
function pathsCollide(a, b) {
  if (a === b) return true;
  if (a.length < b.length && b.startsWith(a) && b.charCodeAt(a.length) === 46) {
    return true;
  }
  if (b.length < a.length && a.startsWith(b) && a.charCodeAt(b.length) === 46) {
    return true;
  }
  return false;
}

// src/stages.ts
var STAGES = {
  $addFields: {
    description: "Adds new fields to documents. Outputs documents that contain all existing fields from the input documents and newly added fields.",
    subPipelineFields: []
  },
  $bucket: {
    description: "Categorizes incoming documents into groups, called buckets, based on a specified expression and bucket boundaries.",
    subPipelineFields: []
  },
  $bucketAuto: {
    description: "Categorizes incoming documents into a specific number of groups, called buckets, based on a specified expression. Bucket boundaries are automatically determined in an attempt to evenly distribute the documents into the specified number of buckets.",
    subPipelineFields: []
  },
  $changeStream: {
    description: "Returns a Change Stream cursor for the collection or database. This stage can only occur once in an aggregation pipeline and it must occur as the first stage.",
    subPipelineFields: [],
    position: "first"
  },
  $changeStreamSplitLargeEvent: {
    description: "Splits large change stream events that exceed 16 MB into smaller fragments returned in a change stream cursor.",
    subPipelineFields: [],
    position: "last"
  },
  $collStats: {
    description: "Returns statistics regarding a collection or view.",
    subPipelineFields: [],
    diagnostic: { scope: "collection", options: true },
    forbiddenIn: ["facet"]
  },
  $count: {
    description: "Returns a count of the number of documents at this stage of the aggregation pipeline.",
    subPipelineFields: []
  },
  $currentOp: {
    description: "Returns information on active and/or dormant operations for the MongoDB deployment.",
    subPipelineFields: [],
    // Server/deployment-level: must be run on the admin database
    // (`db.getSiblingDB("admin").aggregate(...)`), not the current database.
    diagnostic: { scope: "cluster", options: true }
  },
  $densify: {
    description: "Creates new documents in a sequence of documents where certain values in a field are missing.",
    subPipelineFields: []
  },
  $documents: { description: "Returns literal documents from input values.", subPipelineFields: [], position: "first" },
  $facet: {
    description: "Processes multiple aggregation pipelines within a single stage on the same set of input documents. Enables multi-faceted aggregations characterizing data across multiple dimensions in a single stage.",
    // Every value in the body object is itself a sub-pipeline.
    subPipelineFields: ["*"],
    // $facet cannot be nested inside another $facet.
    forbiddenIn: ["facet"]
  },
  $fill: { description: "Populates null and missing field values within documents.", subPipelineFields: [] },
  $geoNear: {
    description: "Returns an ordered stream of documents based on the proximity to a geospatial point. Incorporates the functionality of $match, $sort, and $limit for geospatial data.",
    subPipelineFields: [],
    position: "first",
    // Allowed as the first stage of a $lookup/$unionWith sub-pipeline, so only facet is banned.
    forbiddenIn: ["facet"]
  },
  $graphLookup: {
    description: "Performs a recursive search on a collection. Adds a new array field to each output document that contains the traversal results of the recursive search.",
    subPipelineFields: []
  },
  $group: {
    description: "Groups input documents by a specified identifier expression and applies the accumulator expression(s), if specified, to each group.",
    subPipelineFields: []
  },
  $indexStats: {
    description: "Returns statistics regarding the use of each index for the collection.",
    subPipelineFields: [],
    diagnostic: { scope: "collection", options: false },
    forbiddenIn: ["facet"]
  },
  $limit: {
    description: "Passes the first n documents unmodified to the pipeline where n is the specified limit.",
    subPipelineFields: []
  },
  $listLocalSessions: {
    description: "Lists all active sessions recently in use on the currently connected mongos or mongod instance.",
    subPipelineFields: [],
    // Server-level: run on the admin database (`db.aggregate(...)`).
    diagnostic: { scope: "cluster", options: true }
  },
  $listSampledQueries: {
    description: "Lists sampled queries for all collections or a specific collection.",
    subPipelineFields: [],
    // Cluster-level: run on the admin database.
    diagnostic: { scope: "cluster", options: true }
  },
  $listSearchIndexes: {
    description: "Returns information about existing Atlas Search indexes on a specified collection.",
    subPipelineFields: [],
    diagnostic: { scope: "collection", options: true }
  },
  $listSessions: {
    description: "Lists all sessions that have been active long enough to propagate to the system.sessions collection.",
    subPipelineFields: [],
    // Cluster-level: reads the cluster-wide config.system.sessions collection.
    diagnostic: { scope: "cluster", options: true }
  },
  $lookup: {
    description: "Performs a left outer join to another collection in the same database to filter in documents from the joined collection for processing.",
    subPipelineFields: ["pipeline"]
  },
  $match: {
    description: "Filters the document stream to allow only matching documents to pass unmodified into the next pipeline stage.",
    subPipelineFields: []
  },
  $merge: {
    description: "Writes the resulting documents of the aggregation pipeline to a collection. Must be the last stage in the pipeline.",
    subPipelineFields: [],
    position: "last",
    forbiddenIn: ["facet", "lookup", "unionWith"]
  },
  $out: {
    description: "Writes the resulting documents of the aggregation pipeline to a collection. Must be the last stage in the pipeline.",
    subPipelineFields: [],
    position: "last",
    forbiddenIn: ["facet", "lookup", "unionWith"]
  },
  $planCacheStats: {
    description: "Returns plan cache information for a collection.",
    subPipelineFields: [],
    diagnostic: { scope: "collection", options: false },
    forbiddenIn: ["facet"]
  },
  $project: {
    description: "Reshapes each document in the stream, such as by adding new fields or removing existing fields. For each input document, outputs one document.",
    subPipelineFields: []
  },
  $rankFusion: {
    description: "Combines multiple pipelines using rank-based fusion to create hybrid search results.",
    subPipelineFields: []
  },
  $redact: {
    description: "Reshapes each document in the stream by restricting the content for each document based on information stored in the documents themselves.",
    subPipelineFields: []
  },
  $replaceRoot: {
    description: "Replaces a document with the specified embedded document. The operation replaces all existing fields in the input document, including the _id field.",
    subPipelineFields: []
  },
  $replaceWith: {
    description: "Replaces a document with the specified embedded document. The operation replaces all existing fields in the input document, including the _id field.",
    subPipelineFields: []
  },
  $sample: { description: "Randomly selects the specified number of documents from its input.", subPipelineFields: [] },
  $scoreFusion: {
    description: "Combines multiple pipelines using relative score fusion to create hybrid search results.",
    subPipelineFields: []
  },
  $search: {
    description: "Performs a full-text search of the field or fields in an Atlas collection.",
    subPipelineFields: [],
    position: "first",
    // Allowed as the first stage of a $lookup/$unionWith sub-pipeline, so only facet is banned.
    forbiddenIn: ["facet"]
  },
  $searchMeta: {
    description: "Returns different types of metadata result documents for the Atlas Search query against an Atlas collection.",
    subPipelineFields: [],
    position: "first",
    forbiddenIn: ["facet"]
  },
  $set: {
    description: "Adds new fields to documents. Outputs documents that contain all existing fields from the input documents and newly added fields.",
    subPipelineFields: []
  },
  $setWindowFields: {
    description: "Groups documents into windows and applies one or more operators to the documents in each window.",
    subPipelineFields: []
  },
  $shardedDataDistribution: {
    description: "Provides data and size distribution information on sharded collections.",
    subPipelineFields: [],
    diagnostic: { scope: "cluster", options: false }
  },
  $skip: {
    description: "Skips the first n documents where n is the specified skip number and passes the remaining documents unmodified to the pipeline.",
    subPipelineFields: []
  },
  $sort: {
    description: "Reorders the document stream by a specified sort key. Only the order changes; the documents remain unmodified.",
    subPipelineFields: []
  },
  $sortByCount: {
    description: "Groups incoming documents based on the value of a specified expression, then computes the count of documents in each distinct group.",
    subPipelineFields: []
  },
  $unionWith: {
    description: "Performs a union of two collections; combines pipeline results from two collections into a single result set.",
    subPipelineFields: ["pipeline"]
  },
  $unset: { description: "Removes or excludes fields from documents.", subPipelineFields: [] },
  $unwind: {
    description: "Deconstructs an array field from the input documents to output a document for each element. Each output document replaces the array with an element value.",
    subPipelineFields: []
  },
  $vectorSearch: {
    description: "Performs an ANN or ENN search on a vector in the specified field.",
    subPipelineFields: [],
    position: "first",
    forbiddenIn: ["facet"]
  }
};
function lookupStage(name) {
  return Object.prototype.hasOwnProperty.call(STAGES, name) ? STAGES[name] : void 0;
}
function stageMustBeFirst(def) {
  return def.position === "first" || def.diagnostic !== void 0;
}
function stageMustBeLast(def) {
  return def.position === "last";
}
function stageForbiddenIn(def, container) {
  return def.forbiddenIn?.includes(container) ?? false;
}

// src/match-translation.ts
function mergeTranslatedQuery(t, ctx) {
  const queryEmpty = Object.keys(t.query).length === 0;
  if (t.residual === null) return queryEmpty ? null : t.query;
  const exprBody = generateWithCtx(t.residual, ctx);
  if (queryEmpty) return { $expr: exprBody };
  return { ...t.query, $expr: exprBody };
}
function translateMatchBody(body, ctx = {}) {
  return translate(body, ctx);
}
function translate(expr, ctx) {
  if (expr.type === "BinaryExpr" && expr.op === "&&") {
    const allFold = extractIncludesChain(expr);
    if (allFold !== null) {
      return { query: { [allFold.field]: { $all: allFold.values } }, residual: null };
    }
    return combineAnd(translate(expr.left, ctx), translate(expr.right, ctx));
  }
  if (expr.type === "BinaryExpr" && expr.op === "||") {
    return combineOr(translate(expr.left, ctx), translate(expr.right, ctx), expr);
  }
  const leaf = translateLeaf(expr, ctx);
  if (leaf === null) return { query: {}, residual: expr };
  return { query: leaf, residual: null };
}
function combineAnd(left, right) {
  return { query: mergeQuery(left.query, right.query), residual: combineResidualsAnd(left.residual, right.residual) };
}
function combineOr(left, right, original) {
  if (left.residual !== null || right.residual !== null) {
    return { query: {}, residual: original };
  }
  if (isEmpty(left.query) || isEmpty(right.query)) {
    return { query: {}, residual: original };
  }
  return { query: { $or: [left.query, right.query] }, residual: null };
}
function mergeQuery(a, b) {
  if (isEmpty(a)) return b;
  if (isEmpty(b)) return a;
  const clauses = [];
  const collect = (doc) => {
    for (const k of Object.keys(doc)) {
      if (k === "$and" && Array.isArray(doc[k])) {
        for (const inner of doc[k]) {
          for (const ik of Object.keys(inner)) {
            clauses.push({ key: ik, value: inner[ik] });
          }
        }
      } else {
        clauses.push({ key: k, value: doc[k] });
      }
    }
  };
  collect(a);
  collect(b);
  const counts = /* @__PURE__ */ new Map();
  for (const c of clauses) counts.set(c.key, (counts.get(c.key) ?? 0) + 1);
  const out = {};
  let andClauses = null;
  for (const c of clauses) {
    if ((counts.get(c.key) ?? 0) > 1) {
      if (andClauses === null) {
        andClauses = [];
        out.$and = andClauses;
      }
      andClauses.push({ [c.key]: c.value });
    } else {
      out[c.key] = c.value;
    }
  }
  return out;
}
function isEmpty(q) {
  return Object.keys(q).length === 0;
}
function combineResidualsAnd(a, b) {
  if (a === null) return b;
  if (b === null) return a;
  return { type: "BinaryExpr", op: "&&", left: a, right: b, pos: a.pos };
}
function translateLeaf(expr, ctx) {
  if (expr.type === "MethodCall") {
    const m = translateBooleanMethodCall(expr, ctx);
    if (m !== null) return m;
  }
  if (expr.type !== "BinaryExpr") return null;
  const op = expr.op;
  if (isEqualityOp(op)) {
    if (op === "===" || op === "!==") {
      const typed = translateTypeofPredicate(expr.left, expr.right, op);
      if (typed !== null) return typed;
      const undef = translateUndefinedPredicate(expr.left, expr.right, op);
      if (undef !== null) return undef;
      if (isLengthVsNatural(expr.left, expr.right)) return null;
      const md = translateModulo(expr.left, expr.right, op);
      if (md !== null) return md;
    }
    return translateEquality(expr.left, expr.right, op, ctx);
  }
  if (isOrderedOp(op)) {
    if (isLengthVsNatural(expr.left, expr.right)) return null;
    return translateOrderedCompare(expr.left, expr.right, op, ctx);
  }
  return null;
}
function translateBooleanMethodCall(expr, ctx) {
  if (expr.method === "includes") return translateIncludesCall(expr, ctx);
  if (expr.method === "match") return translateMatchCall(expr);
  if (expr.method === "some") return translateSomeCall(expr, ctx);
  return null;
}
function translateIncludesCall(expr, ctx) {
  if (expr.args.length !== 1) return null;
  const arg = expr.args[0];
  if (arg.type === "SpreadElement") return null;
  const recvField = asFieldPath2(expr.object);
  if (recvField !== null) {
    const lit = anyEqualityLiteral(arg, ctx);
    if (lit !== null) return { [recvField]: lit.value };
  }
  if (expr.object.type === "ArrayLiteral") {
    const argField = asFieldPath2(arg);
    if (argField === null) return null;
    const values = [];
    for (const el of expr.object.elements) {
      if (el.type === "SpreadElement") return null;
      if (el.type === "AssignExpr" || el.type === "DeleteStmt" || el.type === "LetDecl" || el.type === "FuncDecl")
        return null;
      const lit = anyEqualityLiteral(el, ctx);
      if (lit === null) return null;
      values.push(lit.value);
    }
    return { [argField]: { $in: values } };
  }
  return null;
}
function extractIncludesChain(expr) {
  if (expr.type === "BinaryExpr" && expr.op === "&&") {
    const left = extractIncludesChain(expr.left);
    if (left === null) return null;
    const right = extractIncludesChain(expr.right);
    if (right === null) return null;
    if (left.field !== right.field) return null;
    return { field: left.field, values: [...left.values, ...right.values] };
  }
  if (expr.type !== "MethodCall" || expr.method !== "includes") return null;
  if (expr.args.length !== 1) return null;
  const field = asFieldPath2(expr.object);
  if (field === null) return null;
  const arg = expr.args[0];
  if (arg.type === "SpreadElement") return null;
  const lit = anyEqualityLiteral(
    arg,
    /*ctx*/
    {}
  );
  if (lit === null) return null;
  return { field, values: [lit.value] };
}
function translateMatchCall(expr) {
  if (expr.args.length !== 1) return null;
  const field = asFieldPath2(expr.object);
  if (field === null) return null;
  const arg = expr.args[0];
  if (arg.type !== "RegexLiteral") return null;
  const re = new RegExp(arg.pattern, arg.flags);
  return { [field]: re };
}
function translateSomeCall(expr, ctx) {
  if (expr.args.length !== 1) return null;
  const field = asFieldPath2(expr.object);
  if (field === null) return null;
  const lam = expr.args[0];
  if (lam.type !== "Lambda" || lam.params.length !== 1) return null;
  if (lam.body === void 0) return null;
  const param = lam.params[0];
  const rewritten = rewriteParamAsRoot(lam.body, param);
  if (rewritten === null) return null;
  const inner = translate(rewritten, ctx);
  if (inner.residual !== null) return null;
  if (isEmpty(inner.query)) return null;
  return { [field]: { $elemMatch: inner.query } };
}
function rewriteParamAsRoot(expr, param) {
  if (expr.type === "ParamRef" && expr.name === param) return null;
  if (expr.type === "MemberAccess") {
    const innerField = paramMemberAsField(expr, param);
    if (innerField !== null) return { type: "FieldRef", path: innerField, pos: expr.pos };
    const newObj = rewriteParamAsRoot(expr.object, param);
    if (newObj === null) return null;
    return { ...expr, object: newObj };
  }
  if (expr.type === "BinaryExpr") {
    const left = rewriteParamAsRoot(expr.left, param);
    if (left === null) return null;
    const right = rewriteParamAsRoot(expr.right, param);
    if (right === null) return null;
    return { ...expr, left, right };
  }
  if (expr.type === "UnaryExpr") {
    const operand = rewriteParamAsRoot(expr.operand, param);
    if (operand === null) return null;
    return { ...expr, operand };
  }
  if (expr.type === "MethodCall") {
    const obj2 = rewriteParamAsRoot(expr.object, param);
    if (obj2 === null) return null;
    return { ...expr, object: obj2 };
  }
  if (expr.type === "TypeofExpr") {
    const operand = rewriteParamAsRoot(expr.operand, param);
    if (operand === null) return null;
    return { ...expr, operand };
  }
  return expr;
}
function paramMemberAsField(expr, param) {
  if (expr.object.type === "ParamRef" && expr.object.name === param) return expr.member;
  if (expr.object.type === "MemberAccess") {
    const base = paramMemberAsField(expr.object, param);
    if (base !== null) return `${base}.${expr.member}`;
  }
  return null;
}
function translateUndefinedPredicate(left, right, op) {
  const undefSide = left.type === "UndefinedLiteral" ? right : right.type === "UndefinedLiteral" ? left : null;
  if (undefSide === null) return null;
  const field = asFieldPath2(undefSide);
  if (field === null) return null;
  if (op === "===") return { [field]: { $exists: false } };
  return { [field]: { $exists: true } };
}
function isLengthAccess(expr) {
  return expr.type === "MemberAccess" && expr.member === "length";
}
function isLengthVsNatural(left, right) {
  return isLengthAccess(left) && isIntegerLiteral(right) || isLengthAccess(right) && isIntegerLiteral(left);
}
function isIntegerLiteral(expr) {
  return expr.type === "NumberLiteral" && Number.isInteger(expr.value) && expr.value >= 0;
}
function fieldQueryOrNegated(field, positive, op) {
  return { [field]: op === "===" ? positive : { $not: positive } };
}
function translateModulo(left, right, op) {
  const oriented = orientModuloAndInt(left, right);
  if (oriented === null) return null;
  return fieldQueryOrNegated(oriented.field, { $mod: [oriented.divisor, oriented.remainder] }, op);
}
function orientModuloAndInt(left, right) {
  const lm = asModuloFieldAndDivisor(left);
  if (lm !== null && isIntegerLiteral(right)) {
    return {
      field: lm.field,
      divisor: lm.divisor,
      remainder: right.value
    };
  }
  const rm = asModuloFieldAndDivisor(right);
  if (rm !== null && isIntegerLiteral(left)) {
    return {
      field: rm.field,
      divisor: rm.divisor,
      remainder: left.value
    };
  }
  return null;
}
function asModuloFieldAndDivisor(expr) {
  if (expr.type !== "BinaryExpr" || expr.op !== "%") return null;
  const field = asFieldPath2(expr.left);
  if (field === null) return null;
  if (!isIntegerLiteral(expr.right)) return null;
  return { field, divisor: expr.right.value };
}
var BSON_TYPE_ALIASES = /* @__PURE__ */ new Set([
  "double",
  "string",
  "object",
  "array",
  "binData",
  "undefined",
  "objectId",
  "bool",
  "date",
  "null",
  "regex",
  "dbPointer",
  "javascript",
  "symbol",
  "javascriptWithScope",
  "int",
  "timestamp",
  "long",
  "decimal",
  "minKey",
  "maxKey",
  "number"
]);
var JS_TO_BSON_TYPE = /* @__PURE__ */ new Map([["boolean", "bool"]]);
function translateTypeofPredicate(left, right, op) {
  const oriented = orientTypeofAndString(left, right);
  if (oriented === null) return null;
  const { field, alias: rawAlias } = oriented;
  const alias = JS_TO_BSON_TYPE.get(rawAlias) ?? rawAlias;
  if (!BSON_TYPE_ALIASES.has(alias)) return null;
  return fieldQueryOrNegated(field, { $type: alias }, op);
}
function orientTypeofAndString(left, right) {
  const lt = asTypeofFieldPath(left);
  if (lt !== null && right.type === "StringLiteral") {
    return { field: lt, alias: right.value };
  }
  const rt = asTypeofFieldPath(right);
  if (rt !== null && left.type === "StringLiteral") {
    return { field: rt, alias: left.value };
  }
  return null;
}
function asTypeofFieldPath(expr) {
  if (expr.type !== "TypeofExpr") return null;
  return asFieldPath2(expr.operand);
}
function translateEquality(left, right, op, ctx) {
  if (op === "==" || op === "!=") {
    if (left.type !== "NullLiteral" && right.type !== "NullLiteral") return null;
    return translateLooseNull(left, right, op);
  }
  if (left.type === "NullLiteral" || right.type === "NullLiteral") {
    return translateStrictNull(left, right, op);
  }
  const oriented = orientFieldLiteral(left, right, (e) => anyEqualityLiteral(e, ctx));
  if (oriented === null) return null;
  const { field, value } = oriented;
  if (op === "===") return { [field]: value };
  return { [field]: { $ne: value } };
}
function translateLooseNull(left, right, op) {
  const fieldExpr = left.type === "NullLiteral" ? right : left;
  const field = asFieldPath2(fieldExpr);
  if (field === null) return null;
  if (op === "==") return { [field]: null };
  return { [field]: { $ne: null } };
}
function translateStrictNull(left, right, op) {
  const fieldExpr = left.type === "NullLiteral" ? right : left;
  const field = asFieldPath2(fieldExpr);
  if (field === null) return null;
  if (op === "===") return { [field]: { $type: "null" } };
  return { [field]: { $not: { $type: "null" } } };
}
function translateOrderedCompare(left, right, op, ctx) {
  const leftField = asFieldPath2(left);
  const rightField = asFieldPath2(right);
  let field;
  let value;
  let effectiveOp = op;
  if (leftField !== null && rightField === null) {
    const lit = anyOrderedLiteral(right, ctx);
    if (lit === null) return null;
    field = leftField;
    value = lit.value;
  } else if (leftField === null && rightField !== null) {
    const lit = anyOrderedLiteral(left, ctx);
    if (lit === null) return null;
    field = rightField;
    value = lit.value;
    effectiveOp = flipOrderedOp(op);
  } else {
    return null;
  }
  return { [field]: { [orderedOpToMql(effectiveOp)]: value } };
}
function orientFieldLiteral(left, right, getLit) {
  const leftField = asFieldPath2(left);
  if (leftField !== null) {
    const rightLit = getLit(right);
    if (rightLit !== null) return { field: leftField, value: rightLit.value };
  }
  const rightField = asFieldPath2(right);
  if (rightField !== null) {
    const leftLit = getLit(left);
    if (leftLit !== null) return { field: rightField, value: leftLit.value };
  }
  return null;
}
function isEqualityOp(op) {
  return op === "===" || op === "==" || op === "!==" || op === "!=";
}
function isOrderedOp(op) {
  return op === ">" || op === ">=" || op === "<" || op === "<=";
}
function orderedOpToMql(op) {
  return mqlForBinaryOp(op);
}
function flipOrderedOp(op) {
  if (op === ">") return "<";
  if (op === ">=") return "<=";
  if (op === "<") return ">";
  return ">=";
}
function anyEqualityLiteral(expr, ctx) {
  switch (expr.type) {
    case "NumberLiteral":
      return { value: expr.value };
    case "StringLiteral":
      return { value: expr.value };
    case "BooleanLiteral":
      return { value: expr.value };
    case "NullLiteral":
      return { value: null };
    case "ParamRef":
      return paramRefAsLiteral(
        expr,
        ctx,
        /*orderedOnly*/
        false
      );
    case "NewDate":
      return foldedDateValue(expr);
    case "ObjectIdLiteral":
      return { value: new ObjectId(expr.hex) };
    default:
      return null;
  }
}
function anyOrderedLiteral(expr, ctx) {
  switch (expr.type) {
    case "NumberLiteral":
      return { value: expr.value };
    case "StringLiteral":
      return { value: expr.value };
    case "ParamRef":
      return paramRefAsLiteral(
        expr,
        ctx,
        /*orderedOnly*/
        true
      );
    case "NewDate":
      return foldedDateValue(expr);
    default:
      return null;
  }
}
function foldedDateValue(expr) {
  const d = foldConstantDate(expr.args);
  return d === null ? null : { value: d };
}
function paramRefAsLiteral(expr, ctx, orderedOnly) {
  if (!ctx.bindings?.has(expr.name)) return null;
  const value = ctx.bindings.get(expr.name);
  if (orderedOnly) {
    if (typeof value !== "number" && typeof value !== "string" && !(value instanceof Date)) return null;
  } else {
    if (!isQueryDocLiteralValue(value)) return null;
  }
  return { value };
}
function isQueryDocLiteralValue(value) {
  if (value === null) return true;
  const t = typeof value;
  if (t === "number" || t === "string" || t === "boolean") return true;
  return isOpaqueBsonValue(value);
}
function asFieldPath2(expr) {
  if (expr.type === "FieldRef") return expr.path;
  if (expr.type === "MemberAccess") {
    const base = asFieldPath2(expr.object);
    if (base !== null) return `${base}.${expr.member}`;
  }
  return null;
}

// src/union-translation.ts
function detectUnionPush(expr) {
  if (expr.type !== "MethodCall") return null;
  if (expr.method !== "push") return null;
  if (expr.object.type !== "CollectionRef") return null;
  return { pos: expr.object.pos, callPos: expr.pos, args: expr.args };
}
function containsUnionPush(node, _ctx = EMPTY_CTX) {
  return walkContainsPush(node);
}
function walkContainsPush(node) {
  if (node.type === "Pipeline") return node.stmts.some(walkContainsPush);
  if (node.type === "UpdateFilter") return node.ops.some(walkContainsPush);
  if (node.type === "AssignExpr") return walkContainsPush(node.value);
  if (node.type === "DeleteStmt") return false;
  if (node.type === "LetDecl") return walkContainsPush(node.value);
  if (node.type === "FuncDecl") return false;
  const expr = node;
  if (detectUnionPush(expr) !== null) return true;
  if (expr.type === "MethodCall") {
    if (walkContainsPush(expr.object)) return true;
    return walkArgsContainPush(expr.args);
  }
  if (expr.type === "CallExpression") {
    if (walkContainsPush(expr.callee)) return true;
    return walkArgsContainPush(expr.args);
  }
  if (expr.type === "OperatorCall" || expr.type === "MathCall" || expr.type === "ObjectCall") {
    return walkArgsContainPush(expr.args);
  }
  if (expr.type === "MemberAccess") return walkContainsPush(expr.object);
  if (expr.type === "IndexAccess") return walkContainsPush(expr.object) || walkContainsPush(expr.index);
  if (expr.type === "BinaryExpr") return walkContainsPush(expr.left) || walkContainsPush(expr.right);
  if (expr.type === "UnaryExpr") return walkContainsPush(expr.operand);
  if (expr.type === "TernaryExpr") {
    return walkContainsPush(expr.condition) || walkContainsPush(expr.consequent) || walkContainsPush(expr.alternate);
  }
  if (expr.type === "Lambda") {
    if (expr.body !== void 0) return walkContainsPush(expr.body);
    if (expr.block !== void 0) return walkContainsPush(expr.block);
    return false;
  }
  if (expr.type === "ArrayLiteral") {
    for (const el of expr.elements) {
      if (el.type === "SpreadElement") {
        if (walkContainsPush(el.argument)) return true;
      } else if (walkContainsPush(el)) {
        return true;
      }
    }
    return false;
  }
  if (expr.type === "ObjectLiteral") {
    for (const entry of expr.entries) {
      if (entry.type === "SpreadElement") {
        if (walkContainsPush(entry.argument)) return true;
      } else {
        if (entry.key.kind === "computed" && walkContainsPush(entry.key.expr)) return true;
        if (walkContainsPush(entry.value)) return true;
      }
    }
    return false;
  }
  if (expr.type === "TemplateLiteral") return expr.expressions.some(walkContainsPush);
  if (expr.type === "TypeofExpr") return walkContainsPush(expr.operand);
  if (expr.type === "NewDate") return expr.args.some(walkContainsPush);
  if (expr.type === "NewSet") return expr.arg ? walkContainsPush(expr.arg) : false;
  if (expr.type === "TypeCast") return walkContainsPush(expr.arg);
  if (expr.type === "ArrayFrom")
    return walkContainsPush(expr.input) || (expr.mapFn ? walkContainsPush(expr.mapFn) : false);
  if (expr.type === "NumberStatic") return walkContainsPush(expr.arg);
  if (expr.type === "DateUTC") return expr.args.some(walkContainsPush);
  return false;
}
function walkArgsContainPush(args) {
  for (const a of args) {
    if (a.type === "SpreadElement") {
      if (walkContainsPush(a.argument)) return true;
    } else if (walkContainsPush(a)) {
      return true;
    }
  }
  return false;
}
function lowerUnionPush(call, outerCtx, lowerBlock2) {
  if (call.args.length === 0) {
    throw new CodegenError(
      `$$.push() requires at least one argument \u2014 a document literal (\`{...}\`), a spread of \`$$$.<coll>[.filter(pred)]\`, or \`$$$.<coll>.find(pred)\`.`,
      call.callPos
    );
  }
  const stages = [];
  let inlineBatch = [];
  const flushInline = () => {
    if (inlineBatch.length === 0) return;
    stages.push({ $unionWith: { pipeline: [{ $documents: inlineBatch }] } });
    inlineBatch = [];
  };
  for (const arg of call.args) {
    if (arg.type === "SpreadElement") {
      flushInline();
      stages.push(lowerSpreadArg(arg, outerCtx, lowerBlock2));
      continue;
    }
    if (arg.type === "ObjectLiteral") {
      inlineBatch.push(generateWithCtx(arg, outerCtx));
      continue;
    }
    const lookupCall = detectLookupCall(arg, outerCtx);
    if (lookupCall !== null) {
      if (lookupCall.method === "aggregate") {
        throw aggregateInUnionError(lookupCall, arg.pos);
      }
      if (lookupCall.method === "filter") {
        const recv = formatReceiver(lookupCall);
        throw new CodegenError(
          `$$.push(...) was given \`${recv}.filter(pred)\` without \`...\` \u2014 that would push the whole array as a single document. Use \`$$.push(...${recv}.filter(pred))\` to append every matching document, or switch to \`.find(pred)\` if you meant the first match.`,
          arg.pos
        );
      }
      validateLookupShape(arg);
      flushInline();
      stages.push(lowerFindAsUnion(lookupCall, outerCtx, lowerBlock2));
      continue;
    }
    rejectNonDocumentArg(arg);
  }
  flushInline();
  return stages;
}
function lowerSpreadArg(arg, outerCtx, lowerBlock2) {
  const inner = arg.argument;
  if (inner.type === "MethodCall" && inner.method === "find" && inner.object.type !== "FieldRef") {
    const lookup2 = detectLookupCall(inner, outerCtx);
    if (lookup2 !== null) {
      const recv = formatReceiver(lookup2);
      throw new CodegenError(
        `$$.push(...arg) was given \`...${recv}.find(pred)\` \u2014 \`.find\` returns a single document, not an array, so spreading isn't meaningful (JS would \`TypeError\`). Drop the \`...\` to append the matched document, or switch to \`...${recv}.filter(pred)\` to append every match.`,
        inner.pos
      );
    }
  }
  const aggLookup = detectLookupCall(inner, outerCtx);
  if (aggLookup !== null && aggLookup.method === "aggregate") {
    throw aggregateInUnionError(aggLookup, inner.pos);
  }
  const lookup = detectLookupCall(inner, outerCtx);
  if (lookup !== null && lookup.method === "filter") {
    validateLookupShape(inner);
    return buildUnionWith(
      lookup,
      outerCtx,
      lowerBlock2,
      /* limitOne */
      false
    );
  }
  const target = extractLookupTarget(inner, outerCtx);
  if (target !== null) {
    return { $unionWith: requireSameDbColl(target.db, target.collection, target.pos) };
  }
  throw new CodegenError(
    `$$.push(...arg) \u2014 spread argument must be \`$$$.<coll>\`, \`$$$.<coll>.filter(pred)\`, or the cross-DB \`$$$$.<db>.<coll>[.filter(pred)]\` form. Spreading anything else isn't meaningful for collection union.`,
    inner.pos
  );
}
function lowerFindAsUnion(call, outerCtx, lowerBlock2) {
  return buildUnionWith(
    call,
    outerCtx,
    lowerBlock2,
    /* limitOne */
    true
  );
}
function buildUnionWith(call, outerCtx, lowerBlock2, limitOne) {
  const pipeline = translateUnionPredicate(call, outerCtx, lowerBlock2);
  if (limitOne) pipeline.push({ $limit: 1 });
  const from = requireSameDbColl(call.db, call.collection, call.pos);
  if (pipeline.length === 0) {
    return { $unionWith: from };
  }
  if (typeof from === "string") {
    return { $unionWith: { coll: from, pipeline } };
  }
  return { $unionWith: { coll: from, pipeline } };
}
function translateUnionPredicate(call, outerCtx, lowerBlock2) {
  return lowerLambdaPredicate(call.lambda, outerCtx, lowerBlock2, {
    freshCtx: freshSubPipelineCtx,
    onLocalRef: () => {
      throw new CodegenError(correlatedPushPredicateMessage(call), call.lambda.pos);
    },
    missingBody: () => {
      throw new CodegenError(
        `.${call.method}(predicate) lambda is missing a body \u2014 internal parser bug; please report.`,
        call.lambda.pos
      );
    }
  });
}
function correlatedPushPredicateMessage(call) {
  const recv = formatReceiver(call);
  return `$$.push(...${recv}.${call.method}(pred)) \u2014 predicate references the local document (\`$.<field>\`), but MongoDB's \`$unionWith\` has no \`let\` slot. The union sub-pipeline can only reference foreign-document fields. Move the local-doc filter to a \`$match(...)\` stage before \`$$.push(...)\`.`;
}
function rejectNonDocumentArg(arg) {
  let hint = "";
  if (arg.type === "NumberLiteral" || arg.type === "StringLiteral" || arg.type === "BooleanLiteral") {
    hint = ` Got a ${arg.type.replace(/Literal$/, "").toLowerCase()} literal \u2014 collections only hold documents.`;
  } else if (arg.type === "NullLiteral") {
    hint = " Got `null` \u2014 collections only hold documents.";
  } else if (arg.type === "FieldRef" || arg.type === "ParamRef") {
    hint = " To append a runtime-supplied document, accept it as a `jsmql.compile` parameter binding and wrap as `$$.push($.<doc>)`. Note: $$.push doesn't accept bare field paths \u2014 wrap inside an inline `{ ... }` if you want to project specific fields.";
  }
  throw new CodegenError(
    `$$.push(...) argument must be a document literal (\`{ ... }\`), a \`$$$.<coll>.find(pred)\` scalar, or a spread of \`$$$.<coll>[.filter(pred)]\`.${hint}`,
    arg.pos ?? 0
  );
}
function aggregateInUnionError(call, pos) {
  const recv = formatReceiver(call);
  return new CodegenError(
    `\`${recv}.aggregate(...)\` can't be unioned into the stream with \`$$.push(...)\` / \`.concat(...)\` yet \u2014 MongoDB's \`$unionWith\` has no \`let\` slot to correlate an aggregate sub-pipeline. Assign the aggregate to a field instead: \`$.<field> = ${recv}.aggregate((o) => { ... })\`.`,
    pos
  );
}
function formatReceiver(call) {
  return call.db !== void 0 ? `$$$$.${call.db}.${call.collection}` : `$$$.${call.collection}`;
}

// src/stream-methods.ts
var SLICE = {
  name: "slice",
  validate(args, callPos) {
    if (args.length === 0 || args.length > 2) {
      throw new CodegenError(`.slice(start[, end]) takes 1 or 2 arguments, got ${args.length}.`, callPos);
    }
    for (const arg of args) {
      if (arg.type === "SpreadElement") {
        throw new CodegenError(`.slice(start[, end]) does not accept spread arguments.`, arg.pos);
      }
      if (arg.type !== "NumberLiteral") {
        throw new CodegenError(
          `.slice(start[, end]) requires non-negative integer literals; got '${arg.type}'. Computed or dynamic arguments aren't supported on streams in v1 \u2014 write the literal in source.`,
          arg.pos
        );
      }
      if (arg.value < 0 || !Number.isInteger(arg.value)) {
        throw new CodegenError(
          `.slice(start[, end]) requires non-negative integer literals; got ${arg.value}. Negative indices and fractional values aren't supported on streams.`,
          arg.pos
        );
      }
    }
    if (args.length === 2) {
      const start = args[0].value;
      const end = args[1].value;
      if (end < start) {
        throw new CodegenError(`.slice(start, end) requires end >= start (got start=${start}, end=${end}).`, callPos);
      }
    }
  },
  lower(args, _ctx, _callPos) {
    const start = args[0].value;
    if (args.length === 2) {
      const end = args[1].value;
      if (end === start) return { stages: [{ $match: { $expr: false } }] };
    }
    const stages = [];
    if (start > 0) stages.push({ $skip: start });
    if (args.length === 2) {
      const end = args[1].value;
      stages.push({ $limit: end - start });
    }
    return { stages };
  }
};
function validateSingleIntArg(sig, args, callPos, min) {
  if (args.length !== 1) {
    throw new CodegenError(`${sig} takes exactly 1 argument, got ${args.length}.`, callPos);
  }
  const arg = args[0];
  if (arg.type === "SpreadElement") {
    throw new CodegenError(`${sig} does not accept a spread argument.`, arg.pos);
  }
  if (arg.type !== "NumberLiteral") {
    throw new CodegenError(
      `${sig} requires an integer literal; got '${arg.type}'. Computed or dynamic arguments aren't supported on streams \u2014 write the literal in source.`,
      arg.pos
    );
  }
  if (!Number.isInteger(arg.value) || arg.value < min) {
    throw new CodegenError(`${sig} requires an integer >= ${min}; got ${arg.value}.`, arg.pos);
  }
}
function fieldKeyArg(arg) {
  if (arg.type === "StringLiteral") {
    return arg.value === "" || arg.value.startsWith("$") ? null : arg.value;
  }
  if (arg.type === "Lambda" && arg.params.length === 1 && arg.block === void 0 && arg.body !== void 0) {
    return paramFieldPath(arg.body, arg.params[0]);
  }
  return null;
}
function tempCleanup(slots, inSubPipeline) {
  if (!inSubPipeline || slots.length === 0) return void 0;
  return [{ $unset: JSMQL_NS }];
}
function keyExpr(arg, ctx, sig) {
  const name = fieldKeyArg(arg);
  if (name !== null) return `$${name}`;
  const method = sig.slice(1, sig.indexOf("("));
  const lambda = arg.type === "Lambda" ? arg : shorthandToLambda(arg, method, "jsmqlEl");
  if (lambda === null) throw computedKeyError(sig, "pos" in arg ? arg.pos : 0);
  const param = lambda.params[0];
  const { rewritten, letVars } = extractLetsFromExpr(mapBodyExpr(lambda, method), param);
  rejectLocalDocRef(letVars, param, lambda.pos, ctx.sourceSwitch?.desc, method);
  return generateWithCtx(rewritten, ctx);
}
function computedKeyError(sig, pos, alsoTakes = "") {
  const name = sig.slice(1, sig.indexOf("("));
  return new CodegenError(
    `${sig} keys on a field, so it takes a field name ('.${name}("status")')${alsoTakes}, the equivalent bare-path arrow ('.${name}(d => d.status)'), or a computed key iteratee ('.${name}(d => d.status.toLowerCase())').`,
    pos
  );
}
function validateKeyArg(sig, args, callPos, alsoTakes = "") {
  if (args.length !== 1) {
    throw new CodegenError(`${sig} takes exactly 1 argument, got ${args.length}.`, callPos);
  }
  const arg = args[0];
  if (arg.type === "SpreadElement") {
    throw new CodegenError(`${sig} does not accept a spread argument.`, arg.pos);
  }
  if (arg.type === "StringLiteral" && (arg.value === "" || arg.value.startsWith("$"))) {
    throw new CodegenError(
      `${sig} requires a plain field name (no leading '$'), got ${JSON.stringify(arg.value)}.`,
      arg.pos
    );
  }
  if (fieldKeyArg(arg) !== null) return;
  const name = sig.slice(1, sig.indexOf("("));
  if (arg.type === "Lambda") {
    if (arg.params.length !== 1) {
      throw new CodegenError(
        `${sig} takes a single-parameter iteratee '(d) => <key expr>', got ${arg.params.length} parameters.`,
        arg.pos
      );
    }
    mapBodyExpr(arg, name);
    return;
  }
  if (shorthandToLambda(arg, name, "jsmqlEl") !== null) return;
  throw new CodegenError(
    `${sig} takes a field name ('.${name}("status")'), a bare-path arrow ('.${name}(d => d.status)'), a computed iteratee ('.${name}(d => d.status.toLowerCase())')${alsoTakes}, or a lodash matches shorthand ('{ active: true }' / '["status", "open"]').`,
    arg.pos
  );
}
var TAKE = {
  name: "take",
  validate(args, callPos) {
    validateSingleIntArg(".take(n)", args, callPos, 0);
  },
  lower(args) {
    const n = args[0].value;
    return { stages: n === 0 ? [{ $match: { $expr: false } }] : [{ $limit: n }] };
  }
};
var DROP = {
  name: "drop",
  validate(args, callPos) {
    validateSingleIntArg(".drop(n)", args, callPos, 0);
  },
  lower(args) {
    const n = args[0].value;
    return { stages: n === 0 ? [] : [{ $skip: n }] };
  }
};
var TAIL = {
  name: "tail",
  validate(args, callPos) {
    if (args.length !== 0) throw new CodegenError(`.tail() takes no arguments, got ${args.length}.`, callPos);
  },
  lower() {
    return { stages: [{ $skip: 1 }] };
  }
};
function reverseSortTrick(prevStages, op, n, method, callPos) {
  const last = prevStages[prevStages.length - 1];
  const sortSpec = last !== void 0 ? last["$sort"] : void 0;
  if (sortSpec !== void 0) {
    const flipped = {};
    for (const key of Object.keys(sortSpec)) {
      const dir = sortSpec[key];
      if (dir !== 1 && dir !== -1) {
        throw new CodegenError(
          `.${method}() counts 'from the end' by reversing the preceding sort, but that $sort on '${key}' isn't a directional 1/-1 sort. Precede '.${method}()' with a '.sort(...)' on 1/-1 fields (or remove the non-directional sort).`,
          callPos
        );
      }
      flipped[key] = dir === 1 ? -1 : 1;
    }
    return { stages: [{ $sort: flipped }, { [op]: n }, { $sort: sortSpec }], replacesPreviousStage: true };
  }
  return { stages: [{ $sort: { _id: -1 } }, { [op]: n }, { $sort: { _id: 1 } }] };
}
var TAKE_RIGHT = {
  name: "takeRight",
  validate(args, callPos) {
    validateSingleIntArg(".takeRight(n)", args, callPos, 0);
  },
  lower(args, _ctx, callPos, _lb, prevStages) {
    const n = args[0].value;
    if (n === 0) return { stages: [{ $match: { $expr: false } }] };
    return reverseSortTrick(prevStages, "$limit", n, "takeRight", callPos);
  }
};
var DROP_RIGHT = {
  name: "dropRight",
  validate(args, callPos) {
    validateSingleIntArg(".dropRight(n)", args, callPos, 0);
  },
  lower(args, _ctx, callPos, _lb, prevStages) {
    const n = args[0].value;
    if (n === 0) return { stages: [] };
    return reverseSortTrick(prevStages, "$skip", n, "dropRight", callPos);
  }
};
var INITIAL = {
  name: "initial",
  validate(args, callPos) {
    if (args.length !== 0) throw new CodegenError(`.initial() takes no arguments, got ${args.length}.`, callPos);
  },
  lower(_args, _ctx, callPos, _lb, prevStages) {
    return reverseSortTrick(prevStages, "$skip", 1, "initial", callPos);
  }
};
var SHUFFLE = {
  name: "shuffle",
  validate(args, callPos) {
    if (args.length !== 0) throw new CodegenError(`.shuffle() takes no arguments, got ${args.length}.`, callPos);
  },
  lower(_args, _ctx, _callPos, _lb, _prevStages, allocSlot, inSubPipeline) {
    const slot = allocSlot();
    return {
      stages: [{ $addFields: { [slot]: { $rand: {} } } }, { $sort: { [slot]: 1 } }],
      cleanupStages: tempCleanup([slot], inSubPipeline)
    };
  }
};
var SAMPLE_SIZE = {
  name: "sampleSize",
  validate(args, callPos) {
    validateSingleIntArg(".sampleSize(n)", args, callPos, 1);
  },
  lower(args) {
    const n = args[0].value;
    return { stages: [{ $sample: { size: n } }] };
  }
};
var SAMPLE = {
  name: "sample",
  validate(args, callPos) {
    if (args.length !== 0) {
      throw new CodegenError(
        `.sample() takes no arguments, got ${args.length}. For n random documents use '.sampleSize(n)'.`,
        callPos
      );
    }
  },
  lower() {
    return { stages: [{ $sample: { size: 1 } }] };
  }
};
var CONCAT = {
  name: "concat",
  validate(args, callPos) {
    if (args.length === 0) {
      throw new CodegenError(
        `.concat(...) requires at least one argument \u2014 a document literal ('{...}'), a spread of '$$$.<coll>[.filter(pred)]', or '$$$.<coll>.find(pred)'.`,
        callPos
      );
    }
  },
  lower(args, ctx, callPos, lowerBlock2) {
    const stages = lowerUnionPush({ pos: callPos, callPos, args: [...args] }, ctx, lowerBlock2);
    return { stages };
  }
};
function mapBodyExpr(lambda, method = "map") {
  if (lambda.body !== void 0) return lambda.body;
  const eb = lambda.exprBlock;
  if (eb !== void 0) {
    if (eb.decls.length > 0) {
      throw new CodegenError(
        `.${method}(d => { \u2026 }) with 'let'/'const' bindings isn't supported \u2014 use a single 'return <expr>' (e.g. '.${method}(d => d.field)'), or hoist the bindings to a top-level 'let' before the chain.`,
        lambda.pos
      );
    }
    return eb.ret;
  }
  throw new CodegenError(
    `.${method}(d => <expr>) requires an expression or single-'return' body \u2014 a multi-statement block isn't supported here; split into separate stages ($set, $project, \u2026) instead.`,
    lambda.pos
  );
}
function rejectUsedIndexParam(lambda) {
  if (lambda.params.length < 2) return;
  const indexParam = lambda.params[1];
  if (someExpr(lambda, (e) => e.type === "ParamRef" && e.name === indexParam)) {
    throw new CodegenError(
      `.map((${lambda.params[0]}, ${indexParam}) => \u2026) can't use the index parameter '${indexParam}' \u2014 MongoDB streams have no per-doc index. Drop it, or keep it unused (e.g. '(${lambda.params[0]}, _${indexParam}, coll)') only to reach the 3rd 'collection' parameter.`,
      lambda.pos
    );
  }
}
function classifyCollParam(lambda) {
  if (lambda.params.length !== 3) return false;
  const collName = lambda.params[2];
  let total = 0;
  let lengthUses = 0;
  someExpr(lambda, (e) => {
    if (e.type === "ParamRef" && e.name === collName) total++;
    if (e.type === "MemberAccess" && e.member === "length" && e.object.type === "ParamRef" && e.object.name === collName) {
      lengthUses++;
    }
    return false;
  });
  if (total > lengthUses) {
    throw new CodegenError(
      `In '.map((${lambda.params[0]}, _i, ${collName}) => \u2026)' over a '$$$.<coll>' stream, only '${collName}.length' (the sub-stream's document count) is available \u2014 there's no materialised array to index or iterate. To work with the array itself, use the materialised form (e.g. '$$$.<coll>.filter(pred).filter((${lambda.params[0]}, i, ${collName}) => \u2026)').`,
      lambda.pos
    );
  }
  return lengthUses > 0;
}
function rejectLocalDocRef(letVars, param, pos, sourceSwitchDesc, method = "map") {
  if (Object.keys(letVars).length === 0) return;
  const samplePath = Object.values(letVars)[0].replace(/^\$+/, "");
  if (sourceSwitchDesc !== void 0) {
    throw new CodegenError(
      `\`$.${samplePath}\` (the outer document) isn't available inside \`${sourceSwitchDesc}\` \u2014 that source-switch replaces the stream with a different collection, so the original root document is gone (and \`${param}.${samplePath}\` here would be the switched collection's field, not the root's). To read the outer document per row, correlate with a \`.filter\` instead: \`$$$.<coll>.filter(${param} => ${param}.<field> === $.${samplePath}).map(\u2026)\` lowers to a \`$lookup\` and threads \`$.${samplePath}\` into the sub-pipeline.`,
      pos
    );
  }
  throw new CodegenError(
    `'$.<field>' inside '.${method}(d => \u2026)' isn't supported \u2014 use the lambda parameter (e.g. '${param}.${samplePath}') to reference each input document. Inside this callback, the lambda parameter IS the current document.`,
    pos
  );
}
function rejectNonDocumentMapBody(body) {
  const kind = body.type === "NumberLiteral" ? "a number" : body.type === "BigIntLiteral" ? "a bigint" : body.type === "BooleanLiteral" ? "a boolean" : body.type === "NullLiteral" ? "null" : body.type === "RegexLiteral" ? "a regex" : body.type === "ArrayLiteral" ? "an array" : body.type === "StringLiteral" && !body.value.startsWith("$") ? "a string" : null;
  if (kind !== null) {
    throw new CodegenError(
      `.map(d => \u2026) must return a document, but this maps each document to ${kind} \u2014 MongoDB's '$replaceWith' requires an object root. To reshape into a new document write '.map(d => ({ \u2026 }))'; to keep a single value under a key, wrap it: '.map(d => ({ value: \u2026 }))'.`,
      body.pos
    );
  }
}
var MAP = {
  name: "map",
  validate(args, callPos) {
    if (args.length !== 1) {
      throw new CodegenError(
        `.map(d => <expr>) takes exactly one argument (a single-parameter arrow), got ${args.length}.`,
        callPos
      );
    }
    const arg = args[0];
    if (arg.type === "SpreadElement") {
      throw new CodegenError(`.map(...) does not accept a spread argument \u2014 pass a '(d) => <expr>' arrow.`, arg.pos);
    }
    if (arg.type !== "Lambda") {
      if (shorthandToLambda(arg, "map", "jsmqlEl") !== null) return;
      throw new CodegenError(
        `.map(d => <expr>) requires an arrow function (e.g. '.map(d => ({ id: d._id }))'), a field-name string ('.map("userId")'), a matches-object ('{ active: true }'), or a ["field", value] pair.`,
        arg.pos
      );
    }
    if (arg.params.length > 3) {
      throw new CodegenError(
        `.map(d => <expr>) takes at most 3 parameters '(element, index, collection)', got ${arg.params.length}.`,
        arg.pos
      );
    }
    if (arg.block !== void 0 && arg.ret === void 0) {
      throw new CodegenError(
        `.map(${arg.params[0]} => { \u2026 }) must end with 'return <expr>' \u2014 the returned value becomes each output document.`,
        arg.pos
      );
    }
    if (arg.block === void 0) mapBodyExpr(arg);
    rejectUsedIndexParam(arg);
  },
  lower(args, ctx, _callPos, lowerBlock2, _prevStages, allocSlot, _inSubPipeline) {
    const shorthand = args[0];
    if (shorthand.type === "StringLiteral") {
      return { stages: [{ $replaceWith: `$${shorthand.value}` }], clearLets: true };
    }
    const lambda = args[0];
    const param = lambda.params[0];
    const collName = lambda.params.length === 3 ? lambda.params[2] : void 0;
    const collLengthUsed = classifyCollParam(lambda);
    if (ctx.enclosingLookup !== void 0) {
      const ret = lambda.block !== void 0 ? lambda.ret : mapBodyExpr(lambda);
      if (lambda.block === void 0) rejectNonDocumentMapBody(ret);
      if (containsUnionPush(ret)) {
        throw new CodegenError(
          `'$$.push(...)' inside a '.map(d => \u2026)' body isn't meaningful \u2014 '$$.push' is a statement-level form that emits '$unionWith' stages. Hoist it before the chain.`,
          lambda.pos
        );
      }
      const blockLambda = lambda.block !== void 0 ? lambda : {
        type: "Lambda",
        params: lambda.params,
        block: { type: "Pipeline", stmts: [], pos: lambda.pos },
        ret,
        pos: lambda.pos
      };
      const enclosing = ctx.enclosingLookup ?? EMPTY_ENCLOSING;
      const blockCtx = { ...ctx, slotAllocator: allocSlot };
      const { letVars: letVars2, pipeline } = lowerCallbackBlock(blockLambda, blockCtx, ctx.pipelineLets, lowerBlock2, enclosing, {
        collParam: collName,
        terminalRet: ret
      });
      return { stages: pipeline, clearLets: true, extraLetVars: letVars2 };
    }
    const bodyCtx = collName !== void 0 && collLengthUsed ? {
      ...ctx,
      substreamLengthHandles: new Map([...ctx.substreamLengthHandles ?? [], [collName, `$${LENGTH_SLOT}`]])
    } : ctx;
    if (lambda.block !== void 0) {
      const ret = lambda.ret;
      const { rewritten: rwBlock, letVars: blockLets } = extractLetsFromPipeline(lambda.block, param, ctx.pipelineLets);
      const { rewritten: rwRet, letVars: retLets } = extractLetsFromExpr(ret, param, ctx.pipelineLets);
      rejectLocalDocRef({ ...blockLets, ...retLets }, param, lambda.pos, ctx.sourceSwitch?.desc);
      const replaceStmt = {
        type: "UpdateFilter",
        ops: [{ type: "AssignExpr", target: { type: "FieldRef", path: "", pos: ret.pos }, value: rwRet, pos: ret.pos }],
        pos: ret.pos
      };
      const synthetic = { type: "Pipeline", stmts: [...rwBlock.stmts, replaceStmt], pos: lambda.block.pos };
      const blockCtx = { ...bodyCtx, slotAllocator: allocSlot };
      return { stages: lowerBlock2(synthetic, blockCtx), clearLets: true };
    }
    const body = mapBodyExpr(lambda);
    rejectNonDocumentMapBody(body);
    if (containsUnionPush(body)) {
      throw new CodegenError(
        `'$$.push(...)' inside a '.map(d => \u2026)' body isn't meaningful \u2014 '$$.push' is a statement-level form that emits '$unionWith' stages. Hoist it before the chain.`,
        lambda.pos
      );
    }
    const { rewritten, letVars } = extractLetsFromExpr(body, param);
    rejectLocalDocRef(letVars, param, lambda.pos, ctx.sourceSwitch?.desc);
    const { stages: prologue, rewritten: rewritten2 } = extractLookupCalls(rewritten, bodyCtx, allocSlot, lowerBlock2);
    const expr = generateWithCtx(rewritten2, bodyCtx);
    const lengthStages = collLengthUsed ? [streamLengthStage()] : [];
    return { stages: [...lengthStages, ...prologue, { $replaceWith: expr }], clearLets: true };
  }
};
var AGGREGATE = {
  name: "aggregate",
  validate(args, callPos) {
    if (args.length !== 1) {
      throw new CodegenError(
        `.aggregate(pipeline) takes exactly one argument \u2014 a block-body arrow '(o) => { $stage(...); ... }' or a stage-array literal '[{ $stage: ... }, ...]', got ${args.length}.`,
        callPos
      );
    }
    validateAggregateArg(args[0], callPos);
  },
  lower(args, ctx, _callPos, lowerBlock2, _prevStages, allocSlot, _inSubPipeline) {
    const lambda = aggregateArgToLambda(args[0]);
    const param = lambda.params.length > 0 ? lambda.params[0] : void 0;
    const collName = lambda.params.length === 3 ? lambda.params[2] : void 0;
    if (ctx.enclosingLookup !== void 0) {
      const enclosing = ctx.enclosingLookup ?? EMPTY_ENCLOSING;
      const blockCtx2 = { ...ctx, slotAllocator: allocSlot };
      const { letVars: letVars2, pipeline } = lowerCallbackBlock(lambda, blockCtx2, ctx.pipelineLets, lowerBlock2, enclosing, {
        collParam: collName
      });
      return { stages: pipeline, clearLets: true, extraLetVars: letVars2 };
    }
    const collLengthUsed = collName !== void 0 && classifyCollParam(lambda);
    const block = lambda.block;
    const { rewritten, letVars } = extractLetsFromPipeline(block, param ?? "", ctx.pipelineLets);
    rejectLocalDocRef(letVars, param ?? "o", lambda.pos, ctx.sourceSwitch?.desc);
    const blockCtx = collName !== void 0 && collLengthUsed ? {
      ...ctx,
      slotAllocator: allocSlot,
      substreamLengthHandles: new Map([...ctx.substreamLengthHandles ?? [], [collName, `$${LENGTH_SLOT}`]])
    } : { ...ctx, slotAllocator: allocSlot };
    return { stages: lowerBlock2(rewritten, blockCtx), clearLets: true };
  }
};
function classifyComparatorPath(expr, paramA, paramB) {
  let cur = expr;
  const segments = [];
  while (cur.type === "MemberAccess" || cur.type === "IndexAccess") {
    if (cur.type === "MemberAccess") {
      segments.unshift(cur.member);
      cur = cur.object;
      continue;
    }
    if (cur.type === "IndexAccess" && cur.index.type === "StringLiteral") {
      segments.unshift(cur.index.value);
      cur = cur.object;
      continue;
    }
    return null;
  }
  if (cur.type !== "ParamRef") return null;
  const which = cur.name === paramA ? "a" : cur.name === paramB ? "b" : null;
  if (which === null) return null;
  if (segments.length === 0) return null;
  return { param: which, path: segments.join(".") };
}
function parseComparatorBody(body, paramA, paramB, callPos, method) {
  if (body.type === "BinaryExpr" && body.op === "||") {
    const left = parseComparatorBody(body.left, paramA, paramB, callPos, method);
    const right = parseComparatorBody(body.right, paramA, paramB, callPos, method);
    return { ...left, ...right };
  }
  if (body.type === "BinaryExpr" && body.op === "-") {
    const leftPath = classifyComparatorPath(body.left, paramA, paramB);
    const rightPath = classifyComparatorPath(body.right, paramA, paramB);
    if (leftPath !== null && rightPath !== null && leftPath.path === rightPath.path) {
      if (leftPath.param === "a" && rightPath.param === "b") return { [leftPath.path]: 1 };
      if (leftPath.param === "b" && rightPath.param === "a") return { [leftPath.path]: -1 };
    }
  }
  throw new CodegenError(
    `.${method}((${paramA}, ${paramB}) => \u2026) accepts only '${paramA}.<field> - ${paramB}.<field>' (ascending) or '${paramB}.<field> - ${paramA}.<field>' (descending) terms, combined with '||' for compound sorts. Other comparator shapes aren't supported on streams.`,
    body.pos ?? callPos
  );
}
function buildStreamSortSpec(args, callPos, method) {
  if (args.length === 0) {
    throw new CodegenError(
      `.${method}(<sort>) needs a sort key \u2014 MongoDB streams have no natural document ordering. Pass a field name ('.${method}("createdAt")'), a '{ field: 1 | -1 | "asc" | "desc" }' spec, or a comparator '(a, b) => a.x - b.x'.`,
      callPos
    );
  }
  if (args.length > 1) {
    throw new CodegenError(`.${method}(<sort>) takes exactly one argument, got ${args.length}.`, callPos);
  }
  const arg = args[0];
  if (arg.type === "SpreadElement") {
    throw new CodegenError(`.${method}(...) does not accept a spread argument.`, arg.pos);
  }
  if (arg.type === "Lambda") {
    if (arg.params.length !== 2) {
      throw new CodegenError(
        `.${method}((a, b) => \u2026) comparator requires a two-parameter arrow (got ${arg.params.length} params).`,
        arg.pos
      );
    }
    if (arg.body === void 0) {
      throw new CodegenError(`.${method}((a, b) => \u2026) requires an expression body, not a block.`, arg.pos);
    }
    const [paramA, paramB] = arg.params;
    return parseComparatorBody(arg.body, paramA, paramB, callPos, method);
  }
  return buildKeySortSpec(arg, `.${method}(...)`);
}
var TO_SORTED = {
  name: "toSorted",
  validate(args, callPos) {
    buildStreamSortSpec(args, callPos, "toSorted");
  },
  lower(args, _ctx, callPos) {
    return { stages: [{ $sort: buildStreamSortSpec(args, callPos, "toSorted") }] };
  }
};
var SORT = {
  name: "sort",
  validate(args, callPos) {
    buildStreamSortSpec(args, callPos, "sort");
  },
  lower(args, _ctx, callPos) {
    return { stages: [{ $sort: buildStreamSortSpec(args, callPos, "sort") }] };
  }
};
function buildSortByStreamSpec(args, callPos, sink) {
  if (args.length !== 1) {
    throw new CodegenError(`.sortBy(<field> | [fields]) takes exactly one argument, got ${args.length}.`, callPos);
  }
  const arg = args[0];
  if (arg.type === "ObjectLiteral") {
    throw new CodegenError(
      `.sortBy({ \u2026 }) isn't supported \u2014 an object here is a lodash matches-shorthand, not a direction. Use '.orderBy({ field: -1 })' or '.sort({ field: -1 })' for directions.`,
      arg.pos
    );
  }
  return buildKeySortSpec(arg, ".sortBy(...)", sink);
}
function orderByStreamDir(e) {
  if (e.type !== "StringLiteral" && e.type !== "NumberLiteral" && e.type !== "UnaryExpr") {
    throw new CodegenError(`.orderBy(keys, orders) directions must be 1 / -1 / "asc" / "desc".`, e.pos);
  }
  const dir = sortDirection(e);
  if (dir === null) {
    throw new CodegenError(`.orderBy(keys, orders) directions must be 1 / -1 / "asc" / "desc".`, e.pos);
  }
  return dir;
}
function buildOrderByStreamSpec(args, callPos, sink) {
  if (args.length < 1 || args.length > 2) {
    throw new CodegenError(
      `.orderBy(keys[, orders] | { field: dir }) takes one or two arguments, got ${args.length}.`,
      callPos
    );
  }
  const keysArg = args[0];
  const ordersArg = args[1];
  if (keysArg.type === "ObjectLiteral") {
    if (ordersArg !== void 0) {
      throw new CodegenError(
        `.orderBy({ \u2026 }) already carries a direction per field \u2014 drop the second 'orders' argument.`,
        ordersArg.pos
      );
    }
    return buildKeySortSpec(keysArg, ".orderBy({ \u2026 })", sink);
  }
  const names = keysArg.type === "ArrayLiteral" ? keysArg.elements.map((el) => fieldNameLiteral(el, ".orderBy(keys)", "", sink)) : [fieldNameLiteral(keysArg, ".orderBy(keys)", "", sink)];
  const dirs = ordersArg === void 0 ? [] : ordersArg.type === "ArrayLiteral" ? ordersArg.elements.map((el) => orderByStreamDir(el)) : [orderByStreamDir(ordersArg)];
  const spec = {};
  names.forEach((nm, i) => {
    spec[nm] = dirs[i] ?? 1;
  });
  return spec;
}
var SORT_BY = {
  name: "sortBy",
  validate(args, callPos) {
    buildSortByStreamSpec(args, callPos, validatingSortKeys());
  },
  lower(args, ctx, callPos, _lb, _prevStages, allocSlot, inSubPipeline) {
    const { sink, computed } = materialisingSortKeys(ctx, allocSlot);
    const spec = buildSortByStreamSpec(args, callPos, sink);
    return sortStages(spec, computed, inSubPipeline);
  }
};
var ORDER_BY = {
  name: "orderBy",
  validate(args, callPos) {
    buildOrderByStreamSpec(args, callPos, validatingSortKeys());
  },
  lower(args, ctx, callPos, _lb, _prevStages, allocSlot, inSubPipeline) {
    const { sink, computed } = materialisingSortKeys(ctx, allocSlot);
    const spec = buildOrderByStreamSpec(args, callPos, sink);
    return sortStages(spec, computed, inSubPipeline);
  }
};
function projectFieldNames(args, callPos, method) {
  if (args.length !== 1) {
    throw new CodegenError(
      `.${method}([fields]) takes exactly one argument (an array of field names), got ${args.length}.`,
      callPos
    );
  }
  const arg = args[0];
  if (arg.type !== "ArrayLiteral") {
    throw new CodegenError(
      `.${method}([fields]) takes an array of field-name strings, e.g. '.${method}(["name", "email"])'.`,
      arg.pos
    );
  }
  if (arg.elements.length === 0) throw new CodegenError(`.${method}([fields]) needs at least one field name.`, arg.pos);
  return arg.elements.map((el) => {
    if (el.type !== "StringLiteral" || el.value === "" || el.value.startsWith("$")) {
      throw new CodegenError(`.${method}([fields]) entries must be plain field-name strings (no leading '$').`, el.pos);
    }
    return el.value;
  });
}
var PICK = {
  name: "pick",
  validate(args, callPos) {
    projectFieldNames(args, callPos, "pick");
  },
  lower(args, _ctx, callPos) {
    const fields = projectFieldNames(args, callPos, "pick");
    const proj = {};
    for (const f of fields) proj[f] = 1;
    if (!fields.includes("_id")) proj._id = 0;
    return { stages: [{ $project: proj }], clearLets: true };
  }
};
var OMIT = {
  name: "omit",
  validate(args, callPos) {
    projectFieldNames(args, callPos, "omit");
  },
  lower(args, _ctx, callPos) {
    const fields = projectFieldNames(args, callPos, "omit");
    const proj = {};
    for (const f of fields) proj[f] = 0;
    return { stages: [{ $project: proj }] };
  }
};
var TO_REVERSED = {
  name: "toReversed",
  validate(args, callPos) {
    if (args.length !== 0) {
      throw new CodegenError(`.toReversed() takes no arguments, got ${args.length}.`, callPos);
    }
  },
  lower(_args, _ctx, callPos, _lowerBlock, prevStages) {
    const last = prevStages[prevStages.length - 1];
    const sortSpec = last !== void 0 ? last["$sort"] : void 0;
    if (sortSpec === void 0) {
      throw new CodegenError(
        `.toReversed() needs a preceding $sort (from a '.toSorted(...)' call or a '$sort' stage) to invert \u2014 MongoDB streams have no natural document ordering. Either swap to '.toSorted((a, b) => b.<field> - a.<field>)' for descending directly, or place '.toReversed()' after a sort.`,
        callPos
      );
    }
    const flipped = {};
    for (const key of Object.keys(sortSpec)) {
      const dir = sortSpec[key];
      if (dir !== 1 && dir !== -1) {
        throw new CodegenError(
          `.toReversed() can only invert a '$sort' with numeric 1/-1 directions (preceding stage has '${key}: ${String(dir)}'). Inverting non-direction sort specs (text-meta, custom expressions) isn't supported.`,
          callPos
        );
      }
      flipped[key] = dir === 1 ? -1 : 1;
    }
    return { stages: [{ $sort: flipped }], replacesPreviousStage: true };
  }
};
function fieldNameLiteral(e, sig, alsoTakes = "", sink) {
  if (e.type === "SpreadElement") {
    throw new CodegenError(`${sig} does not accept spread elements.`, e.pos);
  }
  if (e.type === "StringLiteral" && (e.value === "" || e.value.startsWith("$"))) {
    throw new CodegenError(
      `${sig} requires plain field names (no leading '$'), got ${JSON.stringify(e.value)}.`,
      e.pos
    );
  }
  const name = fieldKeyArg(e);
  if (name !== null) return name;
  if (sink !== void 0 && e.type === "Lambda") return sink(e, sig);
  throw computedKeyError(sig, e.pos, alsoTakes);
}
function materialisingSortKeys(ctx, allocSlot) {
  const computed = {};
  return {
    computed,
    sink: (e, sig) => {
      const slot = allocSlot();
      computed[slot] = keyExpr(e, ctx, sig);
      return slot;
    }
  };
}
function sortStages(spec, computed, inSubPipeline) {
  const slots = Object.keys(computed);
  if (slots.length === 0) return { stages: [{ $sort: spec }] };
  return { stages: [{ $addFields: computed }, { $sort: spec }], cleanupStages: tempCleanup(slots, inSubPipeline) };
}
function validatingSortKeys() {
  let n = 0;
  return (e, sig) => {
    const method = sig.slice(1, sig.indexOf("("));
    if (e.params.length !== 1) {
      throw new CodegenError(
        `${sig} takes a single-parameter key iteratee '(d) => <key expr>', got ${e.params.length} parameters.`,
        e.pos
      );
    }
    mapBodyExpr(e, method);
    return `__jsmqlSortKeyProbe${n++}`;
  };
}
function sortDirection(e) {
  if (e.type === "NumberLiteral") return e.value === 1 ? 1 : e.value === -1 ? -1 : null;
  if (e.type === "UnaryExpr" && e.op === "-" && e.operand.type === "NumberLiteral" && e.operand.value === 1) return -1;
  if (e.type === "StringLiteral") return e.value === "asc" ? 1 : e.value === "desc" ? -1 : null;
  return null;
}
function buildKeySortSpec(arg, sig, sink) {
  if (arg.type === "StringLiteral" || arg.type === "Lambda") {
    return { [fieldNameLiteral(arg, sig, "", sink)]: 1 };
  }
  if (arg.type === "ArrayLiteral") {
    if (arg.elements.length === 0) {
      throw new CodegenError(`${sig} needs at least one field name.`, arg.pos);
    }
    const spec2 = {};
    for (const el of arg.elements) spec2[fieldNameLiteral(el, sig, "", sink)] = 1;
    return spec2;
  }
  if (arg.type !== "ObjectLiteral") {
    throw new CodegenError(
      `${sig} takes a field name ("age"), an array of field names (["a", "b"]), or a '{ field: 1 | -1 | "asc" | "desc" }' spec.`,
      arg.pos
    );
  }
  if (arg.entries.length === 0) {
    throw new CodegenError(`${sig} needs at least one field.`, arg.pos);
  }
  const spec = {};
  for (const entry of arg.entries) {
    if (entry.type === "SpreadElement") {
      throw new CodegenError(`${sig} does not accept spread entries.`, entry.pos);
    }
    if (entry.key.kind !== "static") {
      throw new CodegenError(`${sig} keys must be plain field names \u2014 computed keys aren't supported.`, entry.pos);
    }
    const dir = sortDirection(entry.value);
    if (dir === null) {
      throw new CodegenError(
        `${sig} direction for '${entry.key.name}' must be 1 / -1 / "asc" / "desc".`,
        entry.value.pos
      );
    }
    spec[entry.key.name] = dir;
  }
  return spec;
}
function generateGroupBody(obj2, ctx, callPos) {
  const out = {};
  let hasId = false;
  for (const entry of obj2.entries) {
    if (entry.type === "SpreadElement") {
      throw new CodegenError(
        `.groupBy({ \u2026 }) does not accept spread entries \u2014 write an explicit '$group' body.`,
        entry.pos
      );
    }
    if (entry.key.kind !== "static") {
      throw new CodegenError(
        `.groupBy({ \u2026 }) keys must be static field names \u2014 computed keys aren't supported.`,
        entry.pos
      );
    }
    const key = entry.key.name;
    const slotCtx = key === "_id" ? ctx : { ...ctx, accumulatorContext: "group" };
    out[key] = generateWithCtx(entry.value, slotCtx);
    if (key === "_id") hasId = true;
  }
  if (!hasId) {
    throw new CodegenError(
      `.groupBy({ \u2026 }) requires an '_id' key (the group key). Use '.groupBy("field")' to group by a single field.`,
      callPos
    );
  }
  return out;
}
var GROUP_BY = {
  name: "groupBy",
  validate(args, callPos) {
    if (args.length !== 1) {
      throw new CodegenError(
        `.groupBy(key | { _id: \u2026, <field>: <accumulator>, \u2026 }) takes exactly 1 argument, got ${args.length}.`,
        callPos
      );
    }
    const a = args[0];
    if (a.type === "SpreadElement") {
      throw new CodegenError(`.groupBy(...) does not accept a spread argument.`, a.pos);
    }
    if (a.type === "ObjectLiteral") return;
    validateKeyArg(".groupBy(key)", args, callPos, ` or a '$group' body ('{ _id: "$dept", n: $sum(1) }')`);
  },
  lower(args, ctx, callPos) {
    const a = args[0];
    if (a.type !== "ObjectLiteral") {
      const key = keyExpr(a, ctx, ".groupBy(key)");
      return {
        stages: [
          { $group: { _id: key, [GROUP_TMP]: { $push: "$$ROOT" } } },
          { $group: { _id: null, [GROUP_TMP]: { $push: { k: stringKeyExpr("$_id"), v: `$${GROUP_TMP}` } } } },
          { $replaceWith: { $arrayToObject: `$${GROUP_TMP}` } }
        ],
        clearLets: true
      };
    }
    const body = generateGroupBody(a, ctx, callPos);
    return { stages: [{ $group: body }], clearLets: true };
  }
};
var COUNT_BY = {
  name: "countBy",
  validate(args, callPos) {
    validateKeyArg(".countBy(key)", args, callPos);
  },
  lower(args, ctx) {
    const key = keyExpr(args[0], ctx, ".countBy(key)");
    return {
      stages: [
        { $group: { _id: key, [GROUP_TMP]: { $sum: 1 } } },
        { $group: { _id: null, [GROUP_TMP]: { $push: { k: stringKeyExpr("$_id"), v: `$${GROUP_TMP}` } } } },
        { $replaceWith: { $arrayToObject: `$${GROUP_TMP}` } }
      ],
      clearLets: true
    };
  }
};
var KEY_BY = {
  name: "keyBy",
  validate(args, callPos) {
    validateKeyArg(".keyBy(key)", args, callPos);
  },
  lower(args, ctx) {
    const key = keyExpr(args[0], ctx, ".keyBy(key)");
    return {
      stages: [
        { $group: { _id: key, [GROUP_TMP]: { $last: "$$ROOT" } } },
        { $group: { _id: null, [GROUP_TMP]: { $push: { k: stringKeyExpr("$_id"), v: `$${GROUP_TMP}` } } } },
        { $replaceWith: { $arrayToObject: `$${GROUP_TMP}` } }
      ],
      clearLets: true
    };
  }
};
var UNIQ_BY = {
  name: "uniqBy",
  validate(args, callPos) {
    validateKeyArg(".uniqBy(key)", args, callPos);
  },
  lower(args, ctx) {
    const key = keyExpr(args[0], ctx, ".uniqBy(key)");
    return {
      stages: [{ $group: { _id: key, [GROUP_TMP]: { $first: "$$ROOT" } } }, { $replaceWith: `$${GROUP_TMP}` }],
      clearLets: true
    };
  }
};
function paramFieldPath(expr, param) {
  const segments = [];
  let cur = expr;
  while (cur.type === "MemberAccess" || cur.type === "IndexAccess") {
    if (cur.type === "MemberAccess") {
      segments.unshift(cur.member);
      cur = cur.object;
      continue;
    }
    if (cur.type === "IndexAccess" && cur.index.type === "StringLiteral") {
      segments.unshift(cur.index.value);
      cur = cur.object;
      continue;
    }
    return null;
  }
  if (cur.type !== "ParamRef") return null;
  if (cur.name !== param) return null;
  if (segments.length === 0) return null;
  return segments.join(".");
}
var FLAT_MAP = {
  name: "flatMap",
  validate(args, callPos) {
    if (args.length !== 1) {
      throw new CodegenError(
        `.flatMap(d => d.<path>) takes exactly one argument (a single-parameter arrow), got ${args.length}.`,
        callPos
      );
    }
    const arg = args[0];
    if (arg.type === "SpreadElement") {
      throw new CodegenError(`.flatMap(...) does not accept a spread argument.`, arg.pos);
    }
    if (arg.type === "StringLiteral") {
      if (arg.value === "" || arg.value.startsWith("$")) {
        throw new CodegenError(
          `.flatMap("field") requires a plain field name (no leading '$'), got ${JSON.stringify(arg.value)}.`,
          arg.pos
        );
      }
      return;
    }
    if (arg.type !== "Lambda") {
      throw new CodegenError(
        `.flatMap(...) names the array field to flatten, so it takes a bare-path arrow ('.flatMap(d => d.items)') or the equivalent field-name string ('.flatMap("items")'). On a stream it lowers to '$unwind', which needs a field path \u2014 a computed arrow, a matches-object, or a ["field", value] pair doesn't name one. Materialise the array into a field first, then flatten it by name: '$.items = <expr>; $$ = $$.flatMap("items");' \u2014 or, inside a foreign chain, '.map(d => ({ items: <expr>, \u2026 })).flatMap("items")'.`,
        arg.pos
      );
    }
    if (arg.params.length !== 1) {
      throw new CodegenError(
        `.flatMap(d => d.<path>) requires a single-parameter arrow (got ${arg.params.length} params).`,
        arg.pos
      );
    }
    if (arg.body === void 0) {
      throw new CodegenError(`.flatMap(d => d.<path>) requires an expression body, not a block.`, arg.pos);
    }
  },
  lower(args, _ctx, callPos, _lowerBlock, _prevStages) {
    const shorthand = args[0];
    if (shorthand.type === "StringLiteral") {
      return { stages: [{ $unwind: `$${shorthand.value}` }] };
    }
    const lambda = args[0];
    const param = lambda.params[0];
    const body = lambda.body;
    const path = paramFieldPath(body, param);
    if (path === null) {
      throw new CodegenError(
        `.flatMap(d => \u2026) needs a field path \u2014 it lowers to '$unwind', which returns each element to a NAMED field, so a computed body (e.g. '.flatMap(d => d.items.map(...))') has nothing to unwind into. Build the array into a field first, then flatten it by name: '$.items = <expr>; $$ = $$.flatMap("items");'.`,
        body.pos ?? callPos
      );
    }
    return { stages: [{ $unwind: `$${path}` }] };
  }
};
function classifyAccumulatorExpr(body, isAccRef, dParam) {
  if (body.type === "BinaryExpr" && body.op === "+") {
    const otherSide = isAccRef(body.left) ? body.right : isAccRef(body.right) ? body.left : null;
    if (otherSide !== null) {
      if (otherSide.type === "NumberLiteral" && otherSide.value === 1) {
        return { kind: "sum", value: 1 };
      }
      const path = paramFieldPath(otherSide, dParam);
      if (path !== null) return { kind: "sum", value: `$${path}` };
    }
  }
  if (body.type === "MathCall" && (body.method === "max" || body.method === "min") && body.args.length === 2) {
    const [a0, a1] = body.args;
    if (a0.type === "SpreadElement" || a1.type === "SpreadElement") return null;
    const a0e = a0;
    const a1e = a1;
    const otherSide = isAccRef(a0e) ? a1e : isAccRef(a1e) ? a0e : null;
    if (otherSide !== null) {
      const path = paramFieldPath(otherSide, dParam);
      if (path !== null) return { kind: body.method, value: path };
    }
  }
  if (body.type === "BinaryExpr" && body.op === "??") {
    if (isAccRef(body.left)) {
      const path = paramFieldPath(body.right, dParam);
      if (path !== null) return { kind: "first", value: path };
    }
  }
  {
    const path = paramFieldPath(body, dParam);
    if (path !== null) return { kind: "last", value: path };
  }
  if (body.type === "ArrayLiteral" && body.elements.length === 2) {
    const [first, second] = body.elements;
    if (first.type === "SpreadElement" && isAccRef(first.argument) && second.type !== "SpreadElement") {
      if (second.type === "AssignExpr" || second.type === "DeleteStmt" || second.type === "LetDecl" || second.type === "FuncDecl")
        return null;
      const path = paramFieldPath(second, dParam);
      if (path !== null) return { kind: "push", value: path };
    }
  }
  if (body.type === "MethodCall" && body.method === "concat" && body.args.length === 1) {
    if (isAccRef(body.object)) {
      const arg = body.args[0];
      if (arg.type !== "SpreadElement") {
        const path = paramFieldPath(arg, dParam);
        if (path !== null) return { kind: "push", value: path };
      }
    }
  }
  return null;
}
function classifyReduceBody(body, accParam, dParam) {
  return classifyAccumulatorExpr(body, (e) => e.type === "ParamRef" && e.name === accParam, dParam);
}
function detectReduceWrap(value) {
  if (value.type !== "ArrayLiteral") return null;
  if (value.elements.length !== 1) return null;
  const el = value.elements[0];
  if (el.type === "ObjectLiteral") return detectScalarReduceWrap(el);
  if (el.type === "MethodCall" && el.method === "reduce" && el.object.type === "CollectionRef") {
    if (el.args.length === 2 && el.args[1].type === "ArrayLiteral") return null;
    return detectObjectReducerWrap(el);
  }
  return null;
}
function detectScalarReduceWrap(docEl) {
  if (docEl.entries.length === 0) return null;
  for (const entry of docEl.entries) {
    if (entry.type !== "KeyValueEntry") return null;
    if (entry.key.kind !== "static") return null;
    const ev = entry.value;
    if (ev.type !== "MethodCall") return null;
    if (ev.method !== "reduce") return null;
    if (ev.object.type !== "CollectionRef") return null;
  }
  const out = [];
  for (const entry of docEl.entries) {
    if (entry.type !== "KeyValueEntry" || entry.key.kind !== "static") continue;
    const ev = entry.value;
    validateReduceCallBasics(ev);
    ensureLiteralInit(ev);
    const lambda = ev.args[0];
    const [accParam, dParam] = lambda.params;
    const body = lambda.body;
    const accumulator = classifyReduceBody(body, accParam, dParam);
    if (accumulator === null) {
      throw new CodegenError(
        `$$.reduce((${accParam}, ${dParam}) => \u2026) v1 supports only these reducer shapes: '${accParam} + ${dParam}.<field>' (\u2192 $sum), '${accParam} + 1' (\u2192 $sum: 1, count), 'Math.max(${accParam}, ${dParam}.<field>)' (\u2192 $max), 'Math.min(${accParam}, ${dParam}.<field>)' (\u2192 $min). Other shapes aren't supported yet \u2014 write the $group stage by hand.`,
        body.pos ?? ev.pos
      );
    }
    out.push({ key: entry.key.name, accumulator, pos: entry.pos });
  }
  return out;
}
function detectObjectReducerWrap(reduceCall) {
  validateReduceCallBasics(reduceCall);
  const lambda = reduceCall.args[0];
  const initArg = reduceCall.args[1];
  const [accParam, dParam] = lambda.params;
  const body = lambda.body;
  if (body.type !== "ObjectLiteral") {
    throw new CodegenError(
      `'$$ = [$$.reduce(...)]' requires the reducer to return an object literal \u2014 '(${accParam}, ${dParam}) => ({ ...${accParam}, <key>: <expr>, ... })'. For scalar reducers, use the object-wrap form instead: '$$ = [{ <key>: $$.reduce((acc, d) => \u2026, <literal-init>) }];'.`,
      body.pos
    );
  }
  if (initArg.type === "SpreadElement" || initArg.type !== "ObjectLiteral") {
    throw new CodegenError(
      `'$$ = [$$.reduce(<reducer>, <init>)]' with an object-returning reducer requires an object init that names each accumulator key \u2014 got '${initArg.type}'. Write '{ <key1>: <init1>, <key2>: <init2>, ... }' matching the keys returned by the reducer body.`,
      "pos" in initArg ? initArg.pos : reduceCall.pos
    );
  }
  return classifyObjectReducer(reduceCall, body, initArg, accParam, dParam);
}
function classifyObjectReducer(reduceCall, body, init, accParam, dParam) {
  const bodyEntries = [];
  let seenNamedEntry = false;
  for (const entry of body.entries) {
    if (entry.type === "SpreadElement") {
      if (seenNamedEntry) {
        throw new CodegenError(
          `Object-reducer body's '...${accParam}' spread must be the first entry, not after named keys.`,
          entry.pos
        );
      }
      const sp = entry.argument;
      if (sp.type !== "ParamRef" || sp.name !== accParam) {
        throw new CodegenError(
          `Object-reducer body may only spread the accumulator parameter ('...${accParam}'). Spreads of other expressions aren't supported in v1.`,
          entry.pos
        );
      }
      continue;
    }
    seenNamedEntry = true;
    if (entry.key.kind !== "static") {
      throw new CodegenError(
        `Object-reducer body entry must have a static key. Computed keys ('[expr]: \u2026') aren't supported in v1.`,
        entry.pos
      );
    }
    bodyEntries.push({ key: entry.key.name, value: entry.value, pos: entry.pos });
  }
  if (bodyEntries.length === 0) {
    throw new CodegenError(
      `Object-reducer body must declare at least one '<key>: <reducer-expr>' entry (got an empty or spread-only object).`,
      body.pos
    );
  }
  const initKeys = /* @__PURE__ */ new Set();
  for (const entry of init.entries) {
    if (entry.type !== "KeyValueEntry") {
      throw new CodegenError(
        `The init object passed to $$.reduce must be a literal '{ <key>: <init>, ... }' \u2014 spreads aren't supported in v1.`,
        entry.pos
      );
    }
    if (entry.key.kind !== "static") {
      throw new CodegenError(`The init object's keys must be static (no computed '[expr]:' keys).`, entry.pos);
    }
    initKeys.add(entry.key.name);
  }
  const bodyKeys = new Set(bodyEntries.map((e) => e.key));
  const missingInInit = Array.from(bodyKeys).filter((k) => !initKeys.has(k));
  const missingInBody = Array.from(initKeys).filter((k) => !bodyKeys.has(k));
  if (missingInInit.length > 0 || missingInBody.length > 0) {
    const parts = [];
    if (missingInInit.length > 0) parts.push(`init is missing keys [${missingInInit.join(", ")}]`);
    if (missingInBody.length > 0) parts.push(`body is missing keys [${missingInBody.join(", ")}]`);
    throw new CodegenError(
      `Object-reducer body and init must declare the same keys (${parts.join("; ")}). Each key needs a starting value in init and a per-doc update in the body.`,
      reduceCall.pos
    );
  }
  const out = [];
  for (const entry of bodyEntries) {
    const accumulator = classifyAccumulatorExpr(
      entry.value,
      (e) => e.type === "MemberAccess" && e.object.type === "ParamRef" && e.object.name === accParam && e.member === entry.key,
      dParam
    );
    if (accumulator === null) {
      throw new CodegenError(
        `Object-reducer entry '${entry.key}: \u2026' \u2014 v1 supports only: '${accParam}.${entry.key} + ${dParam}.<field>' (\u2192 $sum), '${accParam}.${entry.key} + 1' (\u2192 $sum: 1, count), 'Math.max(${accParam}.${entry.key}, ${dParam}.<field>)' (\u2192 $max), 'Math.min(${accParam}.${entry.key}, ${dParam}.<field>)' (\u2192 $min). Each entry must reference '${accParam}.${entry.key}' as the accumulator side.`,
        entry.value.pos ?? entry.pos
      );
    }
    out.push({ key: entry.key, accumulator, pos: entry.pos });
  }
  return out;
}
function validateReduceCallBasics(call) {
  if (call.args.length !== 2) {
    throw new CodegenError(
      `$$.reduce((acc, d) => <expr>, <init>) takes exactly two arguments (the reducer arrow and the initial value), got ${call.args.length}.`,
      call.pos
    );
  }
  const [arg0, arg1] = call.args;
  if (arg0.type === "SpreadElement") {
    throw new CodegenError(`$$.reduce(...) does not accept spread arguments.`, arg0.pos);
  }
  if (arg1.type === "SpreadElement") {
    throw new CodegenError(`$$.reduce(...) does not accept spread arguments.`, arg1.pos);
  }
  if (arg0.type !== "Lambda") {
    throw new CodegenError(
      `$$.reduce((acc, d) => <expr>, <init>) requires an arrow function as the first argument.`,
      arg0.pos
    );
  }
  if (arg0.params.length !== 2) {
    throw new CodegenError(
      `$$.reduce((acc, d) => <expr>, <init>) requires a two-parameter arrow '(acc, d) => \u2026' (got ${arg0.params.length} params).`,
      arg0.pos
    );
  }
  if (arg0.body === void 0) {
    throw new CodegenError(`$$.reduce(...) requires an expression body, not a block.`, arg0.pos);
  }
}
function ensureLiteralInit(call) {
  const arg1 = call.args[1];
  const isLiteral = arg1.type === "NumberLiteral" || arg1.type === "StringLiteral" || arg1.type === "BooleanLiteral" || arg1.type === "NullLiteral" || arg1.type === "BigIntLiteral";
  if (!isLiteral) {
    throw new CodegenError(
      `$$.reduce((acc, d) => <scalar-expr>, <init>) \u2014 the initial value must be a literal (number, string, boolean, null) for the scalar wrap form. For object-returning reducers, use '$$ = [$$.reduce((acc, d) => ({ ...acc, ... }), { ... })];' instead.`,
      "pos" in arg1 ? arg1.pos : call.pos
    );
  }
}
function detectDictBuildWrap(value) {
  if (value.type !== "ArrayLiteral") return null;
  if (value.elements.length !== 1) return null;
  const el = value.elements[0];
  if (el.type !== "MethodCall" || el.method !== "reduce" || el.object.type !== "CollectionRef") return null;
  if (el.args.length !== 2) return null;
  const lambda = el.args[0];
  const init = el.args[1];
  if (lambda.type === "SpreadElement" || init.type === "SpreadElement") return null;
  if (lambda.type !== "Lambda" || lambda.params.length !== 2 || lambda.body === void 0) return null;
  if (init.type !== "ObjectLiteral" || init.entries.length !== 0) return null;
  const body = lambda.body;
  if (body.type !== "ObjectLiteral") return null;
  const [accParam, dParam] = lambda.params;
  let seenComputed = false;
  let result = null;
  for (const entry of body.entries) {
    if (entry.type === "SpreadElement") {
      if (seenComputed) return null;
      if (entry.argument.type !== "ParamRef" || entry.argument.name !== accParam) return null;
      continue;
    }
    if (seenComputed) return null;
    if (entry.key.kind !== "computed") return null;
    const keyPath = paramFieldPath(entry.key.expr, dParam);
    if (keyPath === null) return null;
    const valuePath = paramFieldOrBareParam(entry.value, dParam);
    if (valuePath === void 0) return null;
    result = { keyPath, valuePath, lambdaPos: lambda.pos };
    seenComputed = true;
  }
  return result;
}
function paramFieldOrBareParam(expr, param) {
  if (expr.type === "ParamRef" && expr.name === param) return null;
  const path = paramFieldPath(expr, param);
  if (path !== null) return path;
  return void 0;
}
function lowerDictBuildWrap(wrap) {
  const v = wrap.valuePath === null ? "$$ROOT" : `$${wrap.valuePath}`;
  return [
    { $group: { _id: null, [GROUP_TMP]: { $push: { k: `$${wrap.keyPath}`, v } } } },
    { $replaceWith: { $arrayToObject: `$${GROUP_TMP}` } }
  ];
}
function lowerReduceWrap(entries) {
  const groupBody = { _id: null };
  const replaceBody = {};
  for (const entry of entries) {
    const acc2 = entry.accumulator;
    const op = acc2.kind === "sum" ? "$sum" : acc2.kind === "max" ? "$max" : acc2.kind === "min" ? "$min" : acc2.kind === "first" ? "$first" : acc2.kind === "last" ? "$last" : "$push";
    const v = acc2.kind === "sum" ? acc2.value : `$${acc2.value}`;
    groupBody[entry.key] = { [op]: v };
    replaceBody[entry.key] = `$${entry.key}`;
  }
  return [{ $group: groupBody }, { $replaceWith: replaceBody }];
}
function isArrayInitReduce(el) {
  return el.type === "MethodCall" && el.method === "reduce" && el.object.type === "CollectionRef" && el.args.length === 2 && el.args[1].type === "ArrayLiteral";
}
function detectArrayReducerWrap(value) {
  if (value.type === "ArrayLiteral") {
    if (value.elements.length !== 1) return null;
    if (!isArrayInitReduce(value.elements[0])) return null;
    throw new CodegenError(
      `A reducer seeded with '[]' already produces a stream, so don't wrap it in '[ ]' \u2014 assign it directly: '$$ = $$.reduce((acc, d) => \u2026, [])'.`,
      value.pos
    );
  }
  if (!isArrayInitReduce(value)) return null;
  const el = value;
  const initArg = el.args[1];
  if (initArg.type === "ArrayLiteral" && initArg.elements.length !== 0) {
    throw new CodegenError(
      `'$$ = $$.reduce(<reducer>, <init>)' with an array-returning reducer requires the init to be '[]' \u2014 a non-empty seed array isn't supported (no MQL accumulator preserves the JS-faithful "start with these elements" semantic).`,
      initArg.pos
    );
  }
  validateReduceCallBasics(el);
  const lambda = el.args[0];
  const [accParam, dParam] = lambda.params;
  const body = lambda.body;
  const classified = classifyArrayReducerBody(body, accParam, dParam);
  if (classified === null) {
    throw new CodegenError(
      `Array-returning reducer body \u2014 v1 supports only:
  \u2022 Unconditional map:  '(${accParam}, ${dParam}) => ${accParam}.concat(${dParam}.<field>)'  \u2192  '$replaceWith: "$<field>"'
  \u2022 Filter + map:       '(${accParam}, ${dParam}) => (<cond> ? ${accParam}.concat(${dParam}.<field>) : ${accParam})'  \u2192  '$match(<cond>) + $replaceWith: "$<field>"'
  \u2022 The '${dParam}' itself (bare param) instead of '${dParam}.<field>' projects the whole doc (no '$replaceWith').
Other shapes \u2014 '${accParam}.concat([${dParam}.<x>, ${dParam}.<y>])', '[...${accParam}, ${dParam}.<x>]', non-ternary branches \u2014 aren't supported yet.`,
      body.pos
    );
  }
  return { ...classified, dParam, lambdaPos: lambda.pos };
}
function classifyArrayReducerBody(body, accParam, dParam) {
  if (body.type === "TernaryExpr") {
    if (body.alternate.type !== "ParamRef" || body.alternate.name !== accParam) return null;
    const project2 = classifyConcatCall(body.consequent, accParam, dParam);
    if (project2 === null) return null;
    return { project: project2, condition: body.condition };
  }
  const project = classifyConcatCall(body, accParam, dParam);
  if (project !== null) return { project, condition: null };
  return null;
}
function classifyConcatCall(expr, accParam, dParam) {
  if (expr.type !== "MethodCall") return null;
  if (expr.method !== "concat") return null;
  if (expr.object.type !== "ParamRef" || expr.object.name !== accParam) return null;
  if (expr.args.length !== 1) return null;
  const arg = expr.args[0];
  if (arg.type === "SpreadElement") return null;
  if (arg.type === "ParamRef" && arg.name === dParam) return { kind: "identity" };
  const path = paramFieldPath(arg, dParam);
  if (path !== null) return { kind: "field", path };
  return null;
}
var VALUE_TERMINAL_METHODS = /* @__PURE__ */ new Set([
  "head",
  "first",
  "last",
  "nth",
  "size",
  "every",
  "some",
  "includes",
  "partition",
  // Aggregates that collapse the stream to one scalar — same value-position rule.
  "sum",
  "mean",
  "max",
  "min",
  "sumBy",
  "meanBy",
  "minBy",
  "maxBy"
]);
var STREAM_METHODS = {
  slice: SLICE,
  sample: SAMPLE,
  take: TAKE,
  drop: DROP,
  tail: TAIL,
  takeRight: TAKE_RIGHT,
  dropRight: DROP_RIGHT,
  initial: INITIAL,
  shuffle: SHUFFLE,
  sampleSize: SAMPLE_SIZE,
  concat: CONCAT,
  map: MAP,
  sort: SORT,
  aggregate: AGGREGATE,
  toSorted: TO_SORTED,
  sortBy: SORT_BY,
  orderBy: ORDER_BY,
  toReversed: TO_REVERSED,
  groupBy: GROUP_BY,
  countBy: COUNT_BY,
  keyBy: KEY_BY,
  uniqBy: UNIQ_BY,
  pick: PICK,
  omit: OMIT,
  flatMap: FLAT_MAP
  // Note: `.reduce` is deliberately NOT in this registry. `arr.reduce(...)`
  // returns a scalar / object / array in JS depending on the reducer. A
  // scalar/object result must be wrapped into a stream-shaped RHS; an
  // array-returning reducer already IS a stream and is assigned unbracketed.
  // The chain walker's `unknownStreamMethod` helper special-cases `.reduce`
  // with an actionable hint, and the forms are implemented above:
  //   • `detectReduceWrap`         — scalar-into-object `$$ = [{ k: $$.reduce(…) }]` & object-returning `$$ = [$$.reduce(…, {})]` ($group + $replaceWith)
  //   • `detectArrayReducerWrap`   — array-returning `$$ = $$.reduce(…, [])`, unbracketed ($match + $replaceWith); the bracketed form throws
};
function lookupStreamMethod(name) {
  return STREAM_METHODS[name] ?? null;
}
function streamMethodNames() {
  return Object.keys(STREAM_METHODS);
}
function collectStreamChain(expr) {
  const methods = [];
  let cur = expr;
  while (cur.type === "MethodCall") {
    methods.push(cur);
    cur = cur.object;
  }
  methods.reverse();
  return { root: cur, methods };
}

// src/lookup-translation.ts
var EMPTY_ENCLOSING = { foreignParams: [], inScopeLetNames: /* @__PURE__ */ new Set() };
function rewriteEnclosingForeignParams(expr, params) {
  if (params.length === 0) return expr;
  const paramSet = new Set(params);
  function walk(node) {
    const path = matchEnclosingParamPath(node, paramSet);
    if (path !== null) {
      if (path.segments.length === 0) {
        throw new CodegenError(
          `Bare lambda parameter '${path.param}' from an enclosing lookup is not yet supported \u2014 use \`${path.param}.<field>\` to reference a field of the enclosing foreign document.`,
          node.pos
        );
      }
      return { type: "FieldRef", path: path.segments.join("."), pos: node.pos };
    }
    return walkChildren(node);
  }
  function walkChildren(node) {
    switch (node.type) {
      case "BinaryExpr":
        return { ...node, left: walk(node.left), right: walk(node.right) };
      case "UnaryExpr":
        return { ...node, operand: walk(node.operand) };
      case "TernaryExpr":
        return {
          ...node,
          condition: walk(node.condition),
          consequent: walk(node.consequent),
          alternate: walk(node.alternate)
        };
      case "MemberAccess":
        return { ...node, object: walk(node.object) };
      case "IndexAccess":
        return { ...node, object: walk(node.object), index: walk(node.index) };
      case "MethodCall":
        return { ...node, object: walk(node.object), args: node.args.map(walkArg) };
      case "CallExpression":
        return { ...node, callee: walk(node.callee), args: node.args.map(walkArg) };
      case "OperatorCall":
        return { ...node, args: node.args.map(walkArg) };
      case "Lambda":
        if (node.body !== void 0) return { ...node, body: walk(node.body) };
        if (node.exprBlock !== void 0) {
          return {
            ...node,
            exprBlock: {
              type: "ExprBlock",
              decls: node.exprBlock.decls.map((d) => ({ ...d, value: walk(d.value) })),
              ret: walk(node.exprBlock.ret),
              pos: node.exprBlock.pos
            }
          };
        }
        return node;
      case "ArrayLiteral":
        return {
          ...node,
          elements: node.elements.map((el) => {
            if (el.type === "SpreadElement") return { ...el, argument: walk(el.argument) };
            if (el.type === "AssignExpr") return { ...el, target: walk(el.target), value: walk(el.value) };
            if (el.type === "DeleteStmt") return { ...el, target: walk(el.target) };
            if (el.type === "LetDecl") return { ...el, value: walk(el.value) };
            if (el.type === "FuncDecl") return { ...el, lambda: walk(el.lambda) };
            return walk(el);
          })
        };
      case "ObjectLiteral":
        return {
          ...node,
          entries: node.entries.map((entry) => {
            if (entry.type === "SpreadElement") return { ...entry, argument: walk(entry.argument) };
            return {
              ...entry,
              key: entry.key.kind === "computed" ? { kind: "computed", expr: walk(entry.key.expr) } : entry.key,
              value: walk(entry.value)
            };
          })
        };
      case "TemplateLiteral":
        return { ...node, expressions: node.expressions.map(walk) };
      case "TypeofExpr":
        return { ...node, operand: walk(node.operand) };
      case "NewDate":
        return { ...node, args: node.args.map(walk) };
      case "NewSet":
        return { ...node, arg: node.arg !== null ? walk(node.arg) : null };
      case "TypeCast":
        return { ...node, arg: walk(node.arg) };
      case "MathCall":
        return { ...node, args: node.args.map(walkArg) };
      case "ObjectCall":
        return { ...node, args: node.args.map(walkArg) };
      case "ArrayFrom":
        return { ...node, input: walk(node.input), mapFn: node.mapFn !== null ? walk(node.mapFn) : null };
      case "NumberStatic":
        return { ...node, arg: walk(node.arg) };
      case "DateUTC":
        return { ...node, args: node.args.map(walk) };
      default:
        return node;
    }
  }
  function walkArg(arg) {
    if (arg.type === "SpreadElement") return { ...arg, argument: walk(arg.argument) };
    return walk(arg);
  }
  return walk(expr);
}
function matchEnclosingParamPath(node, params) {
  if (node.type === "ParamRef" && params.has(node.name)) {
    return { param: node.name, segments: [] };
  }
  if (node.type === "MemberAccess") {
    const inner = matchEnclosingParamPath(node.object, params);
    if (inner !== null) return { param: inner.param, segments: [...inner.segments, node.member] };
  }
  if (node.type === "IndexAccess" && node.index.type === "StringLiteral") {
    const inner = matchEnclosingParamPath(node.object, params);
    if (inner !== null) return { param: inner.param, segments: [...inner.segments, node.index.value] };
  }
  return null;
}
function staticAccess(node, ctx) {
  if (node.type === "MemberAccess") return { name: node.member, object: node.object };
  if (node.type === "IndexAccess") {
    if (node.index.type === "StringLiteral") {
      return { name: node.index.value, object: node.object };
    }
    if (node.index.type === "ParamRef") {
      const bindings = ctx.bindings;
      if (bindings === void 0 || !bindings.has(node.index.name)) return null;
      const bound = bindings.get(node.index.name);
      if (typeof bound !== "string") {
        throw new CodegenError(
          `'$$$[${node.index.name}]' / '$$$$[${node.index.name}]' parameter binding must be a string (got ${typeof bound}); collection / database names are compile-time constants in MongoDB's $lookup.from.`,
          node.index.pos
        );
      }
      return { name: bound, object: node.object };
    }
  }
  return null;
}
function extractLookupTarget(receiver, ctx) {
  const outer = staticAccess(receiver, ctx);
  if (outer === null) return null;
  if (outer.object.type === "DatabaseRef") {
    return { pos: outer.object.pos, collection: outer.name };
  }
  const inner = staticAccess(outer.object, ctx);
  if (inner === null) return null;
  if (inner.object.type !== "ClusterRef") return null;
  return { pos: inner.object.pos, db: inner.name, collection: outer.name };
}
function requireSameDbColl(db, collection, pos) {
  if (db !== void 0) {
    throw new CodegenError(
      `Cross-database reads aren't supported: '$$$$.${db}.${collection}' would emit a $lookup/$unionWith with a '{ db, coll }' namespace, which a standalone / replica-set / sharded MongoDB rejects (that shape is Atlas Data Federation only). Reference a collection in the CURRENT database instead \u2014 write '$$$.${collection}' (drop the '$$$$.${db}.' prefix) \u2014 and run the pipeline against the '${db}' database if that's where the data lives. (Cross-database WRITES still work: '$$$$.${db}.${collection} = $$' lowers to $out.)`,
      pos
    );
  }
  return collection;
}
function detectLookupCall(expr, ctx) {
  if (expr.type !== "MethodCall") return null;
  if (expr.method !== "find" && expr.method !== "filter" && expr.method !== "aggregate") return null;
  const target = extractLookupTarget(expr.object, ctx);
  if (target === null) return null;
  if (expr.args.length !== 1) return null;
  const arg = expr.args[0];
  const lambda = expr.method === "aggregate" ? aggregateArgToLambda(arg) : arg.type === "Lambda" ? arg : predicateArgToLambda(arg, expr.method);
  if (lambda === null) return null;
  return {
    pos: target.pos,
    callPos: expr.pos,
    db: target.db,
    collection: target.collection,
    method: expr.method,
    lambda
  };
}
function predicateArgToLambda(arg, method) {
  return tryShorthandToLambda(arg, method, FOREIGN_SHORTHAND_PARAM);
}
function tryShorthandToLambda(arg, method, param) {
  if (arg.type === "SpreadElement") return null;
  try {
    return shorthandToLambda(arg, method, param);
  } catch (e) {
    if (e instanceof CodegenError) return null;
    throw e;
  }
}
var FOREIGN_SHORTHAND_PARAM = "jsmqlItem";
function aggregateArgToLambda(arg) {
  if (arg.type === "Lambda") return arg.block !== void 0 ? arg : null;
  if (arg.type === "ArrayLiteral") {
    const stmts = [];
    for (const el of arg.elements) {
      if (el.type === "SpreadElement") return null;
      if (el.type === "AssignExpr" || el.type === "DeleteStmt") {
        stmts.push({ type: "UpdateFilter", ops: [el], pos: el.pos });
      } else {
        stmts.push(el);
      }
    }
    return { type: "Lambda", params: [], block: { type: "Pipeline", stmts, pos: arg.pos }, pos: arg.pos };
  }
  return null;
}
function containsLookupCall(node, ctx = EMPTY_CTX) {
  return walkContainsLookup(node, ctx);
}
function walkContainsLookup(node, ctx) {
  if (node.type === "Pipeline") {
    return node.stmts.some((s) => walkContainsLookup(s, ctx));
  }
  if (node.type === "UpdateFilter") {
    return node.ops.some((op) => walkContainsLookup(op, ctx));
  }
  if (node.type === "AssignExpr") return walkContainsLookup(node.value, ctx);
  if (node.type === "DeleteStmt") return false;
  if (node.type === "LetDecl") return walkContainsLookup(node.value, ctx);
  if (node.type === "FuncDecl") return false;
  const expr = node;
  if (detectLookupCall(expr, ctx) !== null) return true;
  if (expr.type === "MethodCall") {
    if (walkContainsLookup(expr.object, ctx)) return true;
    return walkArgsContainLookup(expr.args, ctx);
  }
  if (expr.type === "CallExpression") {
    if (walkContainsLookup(expr.callee, ctx)) return true;
    return walkArgsContainLookup(expr.args, ctx);
  }
  if (expr.type === "OperatorCall") return walkArgsContainLookup(expr.args, ctx);
  if (expr.type === "MathCall" || expr.type === "ObjectCall") return walkArgsContainLookup(expr.args, ctx);
  if (expr.type === "MemberAccess") return walkContainsLookup(expr.object, ctx);
  if (expr.type === "IndexAccess") return walkContainsLookup(expr.object, ctx) || walkContainsLookup(expr.index, ctx);
  if (expr.type === "BinaryExpr") return walkContainsLookup(expr.left, ctx) || walkContainsLookup(expr.right, ctx);
  if (expr.type === "UnaryExpr") return walkContainsLookup(expr.operand, ctx);
  if (expr.type === "TernaryExpr") {
    return walkContainsLookup(expr.condition, ctx) || walkContainsLookup(expr.consequent, ctx) || walkContainsLookup(expr.alternate, ctx);
  }
  if (expr.type === "Lambda") {
    if (expr.body !== void 0) return walkContainsLookup(expr.body, ctx);
    if (expr.exprBlock !== void 0) {
      return expr.exprBlock.decls.some((d) => walkContainsLookup(d.value, ctx)) || walkContainsLookup(expr.exprBlock.ret, ctx);
    }
    if (expr.block !== void 0) return walkContainsLookup(expr.block, ctx);
    return false;
  }
  if (expr.type === "ArrayLiteral") {
    for (const el of expr.elements) {
      if (el.type === "SpreadElement") {
        if (walkContainsLookup(el.argument, ctx)) return true;
      } else if (walkContainsLookup(el, ctx)) {
        return true;
      }
    }
    return false;
  }
  if (expr.type === "ObjectLiteral") {
    for (const entry of expr.entries) {
      if (entry.type === "SpreadElement") {
        if (walkContainsLookup(entry.argument, ctx)) return true;
      } else {
        if (entry.key.kind === "computed" && walkContainsLookup(entry.key.expr, ctx)) return true;
        if (walkContainsLookup(entry.value, ctx)) return true;
      }
    }
    return false;
  }
  if (expr.type === "TemplateLiteral") return expr.expressions.some((e) => walkContainsLookup(e, ctx));
  if (expr.type === "TypeofExpr") return walkContainsLookup(expr.operand, ctx);
  if (expr.type === "NewDate") return expr.args.some((a) => walkContainsLookup(a, ctx));
  if (expr.type === "NewSet") return expr.arg ? walkContainsLookup(expr.arg, ctx) : false;
  if (expr.type === "TypeCast") return walkContainsLookup(expr.arg, ctx);
  if (expr.type === "ArrayFrom")
    return walkContainsLookup(expr.input, ctx) || (expr.mapFn ? walkContainsLookup(expr.mapFn, ctx) : false);
  if (expr.type === "NumberStatic") return walkContainsLookup(expr.arg, ctx);
  if (expr.type === "DateUTC") return expr.args.some((a) => walkContainsLookup(a, ctx));
  return false;
}
function walkArgsContainLookup(args, ctx) {
  for (const a of args) {
    if (a.type === "SpreadElement") {
      if (walkContainsLookup(a.argument, ctx)) return true;
    } else if (walkContainsLookup(a, ctx)) return true;
  }
  return false;
}
function classifyLookupReceiver(receiver) {
  let node = receiver;
  for (; ; ) {
    if (node.type === "DatabaseRef") return { spelling: "$$$.<coll>" };
    if (node.type === "ClusterRef") return { spelling: "$$$$.<db>.<coll>" };
    if (node.type === "MemberAccess" || node.type === "IndexAccess") {
      node = node.object;
      continue;
    }
    return null;
  }
}
function validateLookupShape(expr) {
  if (expr.type !== "MethodCall") return;
  const shape = classifyLookupReceiver(expr.object);
  if (shape === null) return;
  const spell = shape.spelling;
  if (expr.method === "aggregate") {
    validateAggregateShape(expr, spell);
    return;
  }
  if (expr.method !== "find" && expr.method !== "filter") {
    if (isPeelableChainMethod(expr.method) || VALUE_TERMINAL_METHODS.has(expr.method)) return;
    const hint = didYouMean(expr.method, ["find", "filter", "aggregate", ...streamMethodNames()], (s) => `.${s}`);
    throw new CodegenError(
      `'${spell}' supports .find(pred), .filter(pred), .aggregate(pipeline), and the lodash stream methods (e.g. .toSorted, .take, .map \u2014 see docs/specs/stream-methods.md), not .${expr.method}().${hint} For a full sub-pipeline (grouping, reshaping), use \`${spell}.aggregate((o) => { $group(...); $sort(...); ... })\`.`,
      expr.pos
    );
  }
  if (expr.args.length !== 1) {
    throw new CodegenError(
      `.${expr.method}(predicate) takes exactly one argument (a single-parameter arrow), got ${expr.args.length}.`,
      expr.pos
    );
  }
  const arg = expr.args[0];
  if (arg.type !== "Lambda") {
    if (arg.type !== "SpreadElement" && shorthandToLambda(arg, expr.method, FOREIGN_SHORTHAND_PARAM) !== null) {
      return;
    }
    throw new CodegenError(
      `.${expr.method}(predicate) requires an arrow predicate (\`.${expr.method}(o => o._id === $.userId)\`), a matches-object (\`{ userId: $._id }\`), a field name (\`"active"\`), or a \`["field", value]\` pair.`,
      "pos" in arg ? arg.pos : expr.pos
    );
  }
  if (arg.params.length !== 1) {
    if (expr.method !== "filter" || arg.params.length > 3) {
      throw new CodegenError(
        `.${expr.method}(predicate) takes a single-parameter arrow (the foreign document), got ${arg.params.length}.`,
        arg.pos
      );
    }
    if (arg.block === void 0 && arg.body !== void 0) {
      for (let p = 1; p < arg.params.length; p++) {
        if (someExpr(arg.body, (e) => e.type === "ParamRef" && e.name === arg.params[p])) {
          throw new CodegenError(
            `'${arg.params[p]}' (the ${p === 1 ? "index" : "array"} parameter) has no meaning on a '.filter' predicate \u2014 the filtered sub-stream doesn't exist yet while the predicate runs. For its post-filter count, use a block body and the 3rd param, e.g. \`.filter((${arg.params[0]}, _i, coll) => { $match(...); assert(coll.length > 0, "\u2026"); })\`.`,
            arg.pos
          );
        }
      }
    }
  }
}
function validateAggregateShape(expr, spell) {
  if (expr.args.length !== 1) {
    throw new CodegenError(
      `.aggregate(pipeline) takes exactly one argument \u2014 a block-body arrow \`(o) => { $stage(...); ... }\` or a stage-array literal \`[{ $stage: ... }, ...]\`, got ${expr.args.length}.`,
      expr.pos
    );
  }
  validateAggregateArg(expr.args[0], expr.pos, spell);
}
function validateAggregateArg(arg, callPos, spell = "$$$.<coll>") {
  if (arg.type === "SpreadElement") {
    throw new CodegenError(
      `.aggregate(...) does not accept a spread argument \u2014 pass a block-body arrow \`(o) => { ... }\` or a stage-array literal \`[{ ... }, ...]\`.`,
      arg.pos
    );
  }
  if (arg.type === "ArrayLiteral") {
    if (arg.elements.length === 0) {
      throw new CodegenError(
        `.aggregate([]) \u2014 an empty pipeline has nothing to run. List at least one stage, e.g. \`${spell}.aggregate([{ $sort: { \u2026 } }, { $limit: 5 }])\`.`,
        arg.pos
      );
    }
    for (const el of arg.elements) {
      if (el.type === "SpreadElement") {
        throw new CodegenError(
          `.aggregate([...]) \u2014 a spread element isn't a pipeline stage. List the stages directly, e.g. \`${spell}.aggregate([{ $sort: { \u2026 } }, { $limit: 5 }])\`.`,
          el.pos
        );
      }
    }
    return;
  }
  if (arg.type !== "Lambda") {
    throw new CodegenError(
      `.aggregate(pipeline) requires a block-body arrow \`(o) => { $stage(...); ... }\` or a stage-array literal \`[{ $stage: ... }, ...]\`.`,
      arg.pos
    );
  }
  if (arg.block === void 0) {
    throw new CodegenError(
      `.aggregate(pipeline) needs a block body \u2014 write \`${spell}.aggregate((o) => { $match(...); $group(...); ... })\` (each statement is a stage) \u2014 or pass a stage-array literal \`[{ ... }, ...]\`. An expression-body arrow isn't a pipeline.`,
      arg.pos
    );
  }
  if (arg.ret !== void 0) {
    throw new CodegenError(
      `.aggregate((o) => { \u2026 }) doesn't take a \`return\` \u2014 each statement is a pipeline stage, not a per-document reshape. To shape the output add a \`$project\`/\`$replaceWith\` stage; for a per-document transform use \`.map(o => \u2026)\`.`,
      arg.pos
    );
  }
  if (arg.params.length > 3) {
    throw new CodegenError(
      `.aggregate((element, index, collection) => \u2026) takes at most 3 parameters, got ${arg.params.length}.`,
      arg.pos
    );
  }
  validateAggregateParams(arg);
}
function validateAggregateParams(lambda) {
  if (lambda.block === void 0) return;
  const block = lambda.block;
  const element = lambda.params[0];
  const indexParam = lambda.params.length >= 2 ? lambda.params[1] : void 0;
  const collParam = lambda.params.length === 3 ? lambda.params[2] : void 0;
  const uses = (pred) => block.stmts.some((s) => someStmt(s, pred));
  if (indexParam !== void 0 && uses((e) => e.type === "ParamRef" && e.name === indexParam)) {
    throw new CodegenError(
      `'${indexParam}' (the 2nd, index parameter) has no meaning inside '.aggregate((${element}, ${indexParam}, \u2026) => \u2026)' \u2014 MongoDB streams have no per-doc index. Keep it unused (e.g. '(${element}, _${indexParam}, coll)') only to reach the 3rd 'collection' parameter.`,
      lambda.pos
    );
  }
  if (collParam !== void 0) {
    let total = 0;
    let lengthUses = 0;
    uses((e) => {
      if (e.type === "ParamRef" && e.name === collParam) total++;
      if (e.type === "MemberAccess" && e.member === "length" && e.object.type === "ParamRef" && e.object.name === collParam) {
        lengthUses++;
      }
      return false;
    });
    if (total > lengthUses) {
      throw new CodegenError(
        `In '.aggregate((${element}, _i, ${collParam}) => { \u2026 })', only '${collParam}.length' (the sub-stream count) is available \u2014 there's no materialised array to index or iterate inside the pipeline.`,
        lambda.pos
      );
    }
  }
}
function isRootStreamLengthNode(e) {
  return e.type === "MemberAccess" && e.object.type === "CollectionRef" && e.member === "length";
}
function captureRootStreamLength(usesRootLen, depth, letVars, subCtx) {
  if (!usesRootLen || depth !== 0) return subCtx;
  const v = letSysVar("length", 0);
  letVars[v] = `$${LENGTH_SLOT}`;
  return { ...subCtx, rootStreamLengthVar: v };
}
function argsReadRootStreamLength(args) {
  return args.some((a) => someArg(a, isRootStreamLengthNode));
}
function createSlotAllocator() {
  let n = 0;
  return () => {
    n += 1;
    return tmpSlot(n);
  };
}
function classifyPath(expr, foreignParam, outerLets, enclosingParams = []) {
  if (expr.type === "FieldRef") return { kind: "local", segments: expr.path === "" ? [] : [expr.path] };
  if (expr.type === "ParamRef") {
    if (expr.name === foreignParam) return { kind: "foreign", segments: [] };
    const level = enclosingParams.indexOf(expr.name);
    if (level !== -1) return { kind: "ancestorForeign", level, segments: [] };
    if (outerLets !== void 0 && outerLets.has(expr.name)) {
      const fieldPath = outerLets.get(expr.name);
      if (fieldPath !== void 0) {
        return { kind: "outerLet", segments: [expr.name], fieldPath };
      }
    }
    return null;
  }
  if (expr.type === "MemberAccess") {
    const inner = classifyPath(expr.object, foreignParam, outerLets, enclosingParams);
    if (inner === null) return null;
    if (inner.kind === "outerLet") {
      return {
        kind: "outerLet",
        segments: [...inner.segments, expr.member],
        fieldPath: `${inner.fieldPath}.${expr.member}`
      };
    }
    if (inner.kind === "ancestorForeign") {
      return { kind: "ancestorForeign", level: inner.level, segments: [...inner.segments, expr.member] };
    }
    return { kind: inner.kind, segments: [...inner.segments, expr.member] };
  }
  if (expr.type === "IndexAccess" && expr.index.type === "StringLiteral") {
    const inner = classifyPath(expr.object, foreignParam, outerLets, enclosingParams);
    if (inner === null) return null;
    if (inner.kind === "outerLet") {
      return {
        kind: "outerLet",
        segments: [...inner.segments, expr.index.value],
        fieldPath: `${inner.fieldPath}.${expr.index.value}`
      };
    }
    if (inner.kind === "ancestorForeign") {
      return { kind: "ancestorForeign", level: inner.level, segments: [...inner.segments, expr.index.value] };
    }
    return { kind: inner.kind, segments: [...inner.segments, expr.index.value] };
  }
  return null;
}
function translatePredicate(call, outerCtx, lowerBlock2, enclosingArg) {
  const enclosing = enclosingArg ?? outerCtx.enclosingLookup ?? EMPTY_ENCLOSING;
  const { lambda } = call;
  const foreignParam = lambda.params[0];
  const outerLets = outerCtx.pipelineLets;
  if (lambda.body !== void 0) {
    const preRewritten = rewriteEnclosingForeignParams(lambda.body, enclosing.foreignParams);
    if (enclosing.foreignParams.length === 0) {
      const basic = tryBasicForm(preRewritten, foreignParam, outerLets);
      if (basic !== null) return basic;
    }
    const { rewritten, letVars } = extractLetsFromExpr(
      preRewritten,
      foreignParam,
      outerLets,
      enclosing.foreignParams.length
    );
    const innerEnclosing = {
      foreignParams: [...enclosing.foreignParams, foreignParam],
      inScopeLetNames: /* @__PURE__ */ new Set([...enclosing.inScopeLetNames, ...Object.keys(letVars)])
    };
    const localAllocSlot = createSlotAllocator();
    const { stages: nestedStages, rewritten: lookupFree } = extractLookupCalls(
      rewritten,
      outerCtx,
      localAllocSlot,
      lowerBlock2,
      innerEnclosing
    );
    const subCtxBase = makeSubPipelineCtx(outerCtx, [...Object.keys(letVars), ...enclosing.inScopeLetNames]);
    const subCtx = captureRootStreamLength(
      someExpr(lookupFree, isRootStreamLengthNode),
      enclosing.foreignParams.length,
      letVars,
      subCtxBase
    );
    const t = translateMatchBody(lookupFree, { bindings: subCtx.bindings });
    return { kind: "pipeline", letVars, pipeline: [...nestedStages, ...matchStagesFromTranslation(t, subCtx)] };
  }
  if (lambda.block !== void 0) {
    const { letVars, pipeline } = buildBlockBodyPredicate(lambda, outerCtx, outerLets, lowerBlock2, enclosing);
    return { kind: "pipeline", letVars, pipeline };
  }
  throw new CodegenError(
    `.${call.method}(predicate) predicate has a block body with local \`const\`/\`let\` bindings, which isn't supported in this position. Write the predicate as a single expression \u2014 \`function (x) { return <expr> }\` / \`(x) => <expr>\` \u2014 and fold any bindings into <expr>.`,
    lambda.pos
  );
}
function makeSubPipelineCtx(outerCtx, letVarNames) {
  const fresh = freshSubPipelineCtx(outerCtx);
  if (letVarNames.length === 0) return fresh;
  return { ...fresh, lambdaParams: /* @__PURE__ */ new Set([...fresh.lambdaParams, ...letVarNames]) };
}
function buildBlockBodyPredicate(lambda, outerCtx, outerLets, lowerBlock2, enclosing) {
  const block = lambda.block;
  const foreignParam = lambda.params[0];
  const indexParam = lambda.params.length >= 2 ? lambda.params[1] : void 0;
  const collParam = lambda.params.length === 3 ? lambda.params[2] : void 0;
  const blockUses = (pred) => block.stmts.some((s) => someStmt(s, pred));
  if (indexParam !== void 0 && blockUses((e) => e.type === "ParamRef" && e.name === indexParam)) {
    throw new CodegenError(
      `'${indexParam}' (the 2nd, index parameter) has no meaning inside a '.filter((${foreignParam}, ${indexParam}, \u2026) => \u2026)' block \u2014 MongoDB streams have no per-doc index. Keep it unused (e.g. '(${foreignParam}, _${indexParam}, coll)') only to reach the 3rd 'collection' parameter.`,
      lambda.pos
    );
  }
  if (collParam !== void 0) {
    let total = 0;
    let lengthUses = 0;
    blockUses((e) => {
      if (e.type === "ParamRef" && e.name === collParam) total++;
      if (e.type === "MemberAccess" && e.member === "length" && e.object.type === "ParamRef" && e.object.name === collParam) {
        lengthUses++;
      }
      return false;
    });
    if (total > lengthUses) {
      throw new CodegenError(
        `In '.filter((${foreignParam}, _i, ${collParam}) => { \u2026 })', only '${collParam}.length' (the post-filter sub-stream count) is available \u2014 there's no materialised array to index or iterate inside the lookup pipeline.`,
        lambda.pos
      );
    }
  }
  return lowerCallbackBlock(lambda, outerCtx, outerLets, lowerBlock2, enclosing, { collParam });
}
function lowerCallbackBlock(lambda, outerCtx, outerLets, lowerBlock2, enclosing, opts = {}) {
  const block = lambda.block;
  const foreignParam = lambda.params[0];
  const depth = enclosing.foreignParams.length;
  const parents = enclosing.parentAllocators ?? [];
  const parentHandles = enclosing.parentHandles ?? /* @__PURE__ */ new Map();
  const allocator = createLetAllocator(depth, parents, enclosing.foreignParams, parentHandles);
  let workBlock = block;
  if (opts.terminalRet !== void 0) {
    const ret = opts.terminalRet;
    const replaceStmt = {
      type: "UpdateFilter",
      ops: [{ type: "AssignExpr", target: { type: "FieldRef", path: "", pos: ret.pos }, value: ret, pos: ret.pos }],
      pos: ret.pos
    };
    workBlock = { type: "Pipeline", stmts: [...block.stmts, replaceStmt], pos: block.pos };
  }
  const { rewritten } = extractLetsFromPipeline(workBlock, foreignParam, outerLets, depth, allocator);
  const letVars = allocator.letVars();
  const innerEnclosing = {
    foreignParams: [...enclosing.foreignParams, foreignParam],
    inScopeLetNames: /* @__PURE__ */ new Set([...enclosing.inScopeLetNames, ...Object.keys(letVars)]),
    parentAllocators: [...parents, allocator],
    // This level's 3rd-param handle becomes an ANCESTOR handle for nested lookups,
    // recorded at this scope's depth so they can capture its `.length`.
    parentHandles: opts.collParam !== void 0 ? new Map([...parentHandles, [opts.collParam, depth]]) : parentHandles
  };
  const subCtx = {
    ...makeSubPipelineCtx(outerCtx, [...Object.keys(letVars), ...enclosing.inScopeLetNames]),
    enclosingLookup: innerEnclosing,
    // `$$.length` (the ROOT stream count) captured by an enclosing chain stays
    // in scope inside this block — preserve the var `makeSubPipelineCtx`/
    // `freshSubPipelineCtx` would otherwise drop, so `generateStreamLength`
    // keeps emitting `$$<rootStreamLengthVar>` rather than the (wrong)
    // sub-stream `$__jsmql.length`.
    rootStreamLengthVar: outerCtx.rootStreamLengthVar,
    // Bind the 3rd 'collection' param to this sub-stream's materialised count
    // (`$__jsmql.length`); `generateImplicitPipeline` (via `lowerBlock`) stamps
    // the `$setWindowFields` ahead of the statement that reads `<coll>.length`.
    ...opts.collParam !== void 0 ? { substreamLengthHandles: /* @__PURE__ */ new Map([[opts.collParam, `$${LENGTH_SLOT}`]]) } : {}
  };
  return { letVars, pipeline: lowerBlock2(rewritten, subCtx) };
}
function buildPipelineFormPredicate(lambda, outerCtx, lowerBlock2, enclosingArg) {
  const enclosing = enclosingArg ?? outerCtx.enclosingLookup ?? EMPTY_ENCLOSING;
  const foreignParam = lambda.params[0];
  const outerLets = outerCtx.pipelineLets;
  if (lambda.body !== void 0) {
    const preRewritten = rewriteEnclosingForeignParams(lambda.body, enclosing.foreignParams);
    const { rewritten, letVars } = extractLetsFromExpr(
      preRewritten,
      foreignParam,
      outerLets,
      enclosing.foreignParams.length
    );
    const innerEnclosing = {
      foreignParams: [...enclosing.foreignParams, foreignParam],
      inScopeLetNames: /* @__PURE__ */ new Set([...enclosing.inScopeLetNames, ...Object.keys(letVars)])
    };
    const localAllocSlot = createSlotAllocator();
    const { stages: nestedStages, rewritten: lookupFree } = extractLookupCalls(
      rewritten,
      outerCtx,
      localAllocSlot,
      lowerBlock2,
      innerEnclosing
    );
    const subCtx = makeSubPipelineCtx(outerCtx, [...Object.keys(letVars), ...enclosing.inScopeLetNames]);
    const t = translateMatchBody(lookupFree, { bindings: subCtx.bindings });
    return { letVars, pipelineBody: [...nestedStages, ...matchStagesFromTranslation(t, subCtx)] };
  }
  if (lambda.block !== void 0) {
    const { letVars, pipeline } = buildBlockBodyPredicate(lambda, outerCtx, outerLets, lowerBlock2, enclosing);
    return { letVars, pipelineBody: pipeline };
  }
  throw new CodegenError(
    `Predicate predicate has a block body with local \`const\`/\`let\` bindings, which isn't supported in this position. Write the predicate as a single expression \u2014 \`function (x) { return <expr> }\` / \`(x) => <expr>\` \u2014 and fold any bindings into <expr>.`,
    lambda.pos
  );
}
function predicateReferencesOuterDoc(lambda, outerCtx) {
  if (lambda.params.length !== 1) return false;
  const foreignParam = lambda.params[0];
  const outerLets = outerCtx.pipelineLets;
  if (lambda.body !== void 0) {
    const { letVars } = extractLetsFromExpr(lambda.body, foreignParam, outerLets);
    return Object.keys(letVars).length > 0;
  }
  if (lambda.block !== void 0) {
    const { letVars } = extractLetsFromPipeline(lambda.block, foreignParam, outerLets);
    return Object.keys(letVars).length > 0;
  }
  return false;
}
function tryBasicForm(body, foreignParam, outerLets) {
  if (body.type !== "BinaryExpr") return null;
  if (body.op !== "===") return null;
  const leftPath = classifyPath(body.left, foreignParam, outerLets);
  const rightPath = classifyPath(body.right, foreignParam, outerLets);
  if (leftPath === null || rightPath === null) return null;
  function localFieldFor(p) {
    if (p.kind === "local" && p.segments.length > 0) return p.segments.join(".");
    if (p.kind === "outerLet") return p.fieldPath;
    return null;
  }
  if (leftPath.kind === "foreign" && leftPath.segments.length > 0) {
    const local = localFieldFor(rightPath);
    if (local !== null) {
      return { kind: "basic", foreignField: leftPath.segments.join("."), localField: local };
    }
  }
  if (rightPath.kind === "foreign" && rightPath.segments.length > 0) {
    const local = localFieldFor(leftPath);
    if (local !== null) {
      return { kind: "basic", foreignField: rightPath.segments.join("."), localField: local };
    }
  }
  return null;
}
function createLetAllocator(depth, parents = [], enclosingParams = [], enclosingHandles = /* @__PURE__ */ new Map()) {
  const byPath = /* @__PURE__ */ new Map();
  const used = /* @__PURE__ */ new Set();
  const out = {};
  function uniqueName(preferred) {
    if (!used.has(preferred)) return preferred;
    let n = 2;
    let candidate = `${preferred}_${n}`;
    while (used.has(candidate)) {
      n += 1;
      candidate = `${preferred}_${n}`;
    }
    return candidate;
  }
  const self = {
    depth,
    enclosingParams,
    parents,
    enclosingHandles,
    allocateForLocalPath(segments) {
      const dotted = segments.join(".");
      const existing = byPath.get(dotted);
      if (existing !== void 0) return existing;
      const base = letFieldVar(segments[segments.length - 1], depth);
      const name = uniqueName(base);
      used.add(name);
      byPath.set(dotted, name);
      out[name] = `$${dotted}`;
      return name;
    },
    allocateForOuterLet(segments, fieldPath) {
      const existing = byPath.get(fieldPath);
      if (existing !== void 0) return existing;
      const base = letBindingVar(segments[segments.length - 1], depth);
      const name = uniqueName(base);
      used.add(name);
      byPath.set(fieldPath, name);
      out[name] = `$${fieldPath}`;
      return name;
    },
    // A reference to scope level L is captured at the allocator owning that
    // depth: `parents[L]` for an ancestor, or `self` for the current level
    // (L === depth). `allocateForLocalPath` on the chosen allocator names it
    // `jsmql_f<L>_<field>` with value `$<field>` — correct in that level's
    // `$lookup.let` context — and the result propagates to deeper levels.
    allocateRootField(segments) {
      const target = depth === 0 ? self : parents[0];
      return target.allocateForLocalPath(segments);
    },
    allocateAncestorForeign(level, segments) {
      const captureDepth = level + 1;
      const target = captureDepth >= depth ? self : parents[captureDepth];
      return target.allocateForLocalPath(segments);
    },
    allocateSysLength() {
      const key = "\0syslen";
      const existing = byPath.get(key);
      if (existing !== void 0) return existing;
      const name = uniqueName(letSysVar("length", depth));
      used.add(name);
      byPath.set(key, name);
      out[name] = `$${LENGTH_SLOT}`;
      return name;
    },
    allocateAncestorHandle(handleName) {
      const sourceLevel = enclosingHandles.get(handleName) ?? 0;
      const captureDepth = sourceLevel + 1;
      const target = captureDepth >= depth ? self : parents[captureDepth];
      return target.allocateSysLength();
    },
    letVars: () => out
  };
  return self;
}
function extractLetsFromExpr(body, foreignParam, outerLets, depth = 0) {
  const allocator = createLetAllocator(depth);
  const rewritten = transformExpr(body, foreignParam, allocator, outerLets);
  return { rewritten, letVars: allocator.letVars() };
}
function extractLetsFromPipeline(block, foreignParam, outerLets, depth = 0, allocator = createLetAllocator(depth)) {
  const stmts = block.stmts.map((s) => transformStmt(s, foreignParam, allocator, outerLets));
  return { rewritten: { type: "Pipeline", stmts, pos: block.pos }, letVars: allocator.letVars() };
}
function matchStagesFromTranslation(t, subCtx) {
  const merged = mergeTranslatedQuery(t, subCtx);
  return merged === null ? [] : [{ $match: merged }];
}
function lowerLambdaPredicate(lambda, outerCtx, lowerBlock2, opts) {
  const param = lambda.params[0];
  if (lambda.body !== void 0) {
    const { rewritten, letVars } = extractLetsFromExpr(lambda.body, param);
    if (Object.keys(letVars).length > 0) opts.onLocalRef(letVars, param, lambda.pos);
    const subCtx = opts.freshCtx(outerCtx);
    const t = translateMatchBody(rewritten, { bindings: subCtx.bindings });
    return matchStagesFromTranslation(t, subCtx);
  }
  if (lambda.block !== void 0) {
    const { rewritten, letVars } = extractLetsFromPipeline(lambda.block, param);
    if (Object.keys(letVars).length > 0) opts.onLocalRef(letVars, param, lambda.pos);
    const subCtx = opts.freshCtx(outerCtx);
    return lowerBlock2(rewritten, subCtx);
  }
  return opts.missingBody();
}
function transformStmt(stmt, foreignParam, allocator, outerLets) {
  if (stmt.type === "LetDecl") {
    return {
      type: "LetDecl",
      name: stmt.name,
      value: transformExpr(stmt.value, foreignParam, allocator, outerLets),
      kind: stmt.kind,
      pos: stmt.pos
    };
  }
  if (stmt.type === "FuncDecl") {
    return { ...stmt, lambda: transformExpr(stmt.lambda, foreignParam, allocator, outerLets) };
  }
  if (stmt.type === "UpdateFilter") {
    const ops = stmt.ops.map((op) => {
      if (op.type === "AssignExpr") {
        return {
          type: "AssignExpr",
          target: transformTarget(op.target, foreignParam, allocator, outerLets),
          value: transformExpr(op.value, foreignParam, allocator, outerLets),
          pos: op.pos
        };
      }
      return {
        type: "DeleteStmt",
        target: transformTarget(op.target, foreignParam, allocator, outerLets),
        pos: op.pos
      };
    });
    return { type: "UpdateFilter", ops, pos: stmt.pos };
  }
  return transformExpr(stmt, foreignParam, allocator, outerLets);
}
function transformTarget(target, foreignParam, allocator, outerLets) {
  const classified = classifyPath(target, foreignParam, outerLets, allocator.enclosingParams);
  if (classified !== null && classified.kind === "local") {
    return { type: "FieldRef", path: classified.segments.join("."), pos: target.pos };
  }
  if (classified !== null && classified.kind === "foreign" && classified.segments.length > 0) {
    return { type: "FieldRef", path: classified.segments.join("."), pos: target.pos };
  }
  return transformExpr(target, foreignParam, allocator, outerLets);
}
function transformExpr(expr, foreignParam, allocator, outerLets) {
  if (expr.type === "MemberAccess" && expr.member === "length" && expr.object.type === "ParamRef" && allocator.enclosingHandles.has(expr.object.name)) {
    const letVar = allocator.allocateAncestorHandle(expr.object.name);
    return { type: "ParamRef", name: letVar, pos: expr.pos };
  }
  const classified = classifyPath(expr, foreignParam, outerLets, allocator.enclosingParams);
  if (classified !== null) {
    if (classified.kind === "local") {
      if (classified.segments.length === 0) {
        throw new CodegenError(
          `Bare '$' (the whole outer document) can't be used as a value in a $lookup predicate \u2014 reference a specific field with '$.<field>' (e.g. '$.userId').`,
          expr.pos
        );
      }
      const letVar = allocator.enclosingParams.length > 0 ? allocator.allocateRootField(classified.segments) : allocator.allocateForLocalPath(classified.segments);
      return { type: "ParamRef", name: letVar, pos: expr.pos };
    }
    if (classified.kind === "ancestorForeign") {
      const letVar = allocator.allocateAncestorForeign(classified.level, classified.segments);
      return { type: "ParamRef", name: letVar, pos: expr.pos };
    }
    if (classified.kind === "outerLet") {
      const letVar = allocator.allocateForOuterLet(classified.segments, classified.fieldPath);
      return { type: "ParamRef", name: letVar, pos: expr.pos };
    }
    if (classified.segments.length === 0) {
      throw new CodegenError(
        `Bare lambda parameter '${foreignParam}' in a $lookup predicate is not yet supported \u2014 use \`${foreignParam}.<field>\` to reference a foreign document field.`,
        expr.pos
      );
    }
    return { type: "FieldRef", path: classified.segments.join("."), pos: expr.pos };
  }
  return mapChildren(expr, foreignParam, allocator, outerLets);
}
function mapChildren(expr, foreignParam, allocator, outerLets) {
  switch (expr.type) {
    case "FieldRef":
    case "CollectionRef":
    case "DatabaseRef":
    case "ClusterRef":
    case "NumberLiteral":
    case "BigIntLiteral":
    case "StringLiteral":
    case "BooleanLiteral":
    case "NullLiteral":
    case "UndefinedLiteral":
    case "RegexLiteral":
    case "ParamRef":
    case "TypeCastRef":
    case "MathConst":
    case "MathCallRef":
    case "DateNow":
    case "ObjectIdLiteral":
      return expr;
    case "BinaryExpr":
      return {
        type: "BinaryExpr",
        op: expr.op,
        left: transformExpr(expr.left, foreignParam, allocator, outerLets),
        right: transformExpr(expr.right, foreignParam, allocator, outerLets),
        pos: expr.pos
      };
    case "UnaryExpr":
      return {
        type: "UnaryExpr",
        op: expr.op,
        operand: transformExpr(expr.operand, foreignParam, allocator, outerLets),
        pos: expr.pos
      };
    case "TernaryExpr":
      return {
        type: "TernaryExpr",
        condition: transformExpr(expr.condition, foreignParam, allocator, outerLets),
        consequent: transformExpr(expr.consequent, foreignParam, allocator, outerLets),
        alternate: transformExpr(expr.alternate, foreignParam, allocator, outerLets),
        pos: expr.pos
      };
    case "MemberAccess":
      return {
        type: "MemberAccess",
        object: transformExpr(expr.object, foreignParam, allocator, outerLets),
        member: expr.member,
        pos: expr.pos,
        ...expr.optional && { optional: true }
      };
    case "IndexAccess":
      return {
        type: "IndexAccess",
        object: transformExpr(expr.object, foreignParam, allocator, outerLets),
        index: transformExpr(expr.index, foreignParam, allocator, outerLets),
        pos: expr.pos,
        ...expr.optional && { optional: true }
      };
    case "MethodCall":
      return {
        type: "MethodCall",
        object: transformExpr(expr.object, foreignParam, allocator, outerLets),
        method: expr.method,
        args: transformCallArgs(expr.args, foreignParam, allocator, outerLets),
        pos: expr.pos,
        ...expr.optional && { optional: true }
      };
    case "CallExpression":
      return {
        type: "CallExpression",
        callee: transformExpr(expr.callee, foreignParam, allocator, outerLets),
        args: transformCallArgs(expr.args, foreignParam, allocator, outerLets),
        pos: expr.pos
      };
    case "OperatorCall":
      return {
        type: "OperatorCall",
        name: expr.name,
        style: expr.style,
        args: transformCallArgs(expr.args, foreignParam, allocator, outerLets),
        pos: expr.pos
      };
    case "Lambda":
      if (expr.body !== void 0) {
        return {
          type: "Lambda",
          params: expr.params,
          body: transformExpr(expr.body, foreignParam, allocator, outerLets),
          pos: expr.pos
        };
      }
      if (expr.exprBlock !== void 0) {
        return {
          type: "Lambda",
          params: expr.params,
          exprBlock: {
            type: "ExprBlock",
            decls: expr.exprBlock.decls.map((d) => ({
              ...d,
              value: transformExpr(d.value, foreignParam, allocator, outerLets)
            })),
            ret: transformExpr(expr.exprBlock.ret, foreignParam, allocator, outerLets),
            pos: expr.exprBlock.pos
          },
          pos: expr.pos
        };
      }
      return expr;
    case "ArrayLiteral":
      return {
        type: "ArrayLiteral",
        elements: expr.elements.map((el) => {
          if (el.type === "SpreadElement") {
            return {
              type: "SpreadElement",
              argument: transformExpr(el.argument, foreignParam, allocator, outerLets),
              pos: el.pos
            };
          }
          if (el.type === "AssignExpr") {
            return {
              type: "AssignExpr",
              target: transformExpr(el.target, foreignParam, allocator, outerLets),
              value: transformExpr(el.value, foreignParam, allocator, outerLets),
              pos: el.pos
            };
          }
          if (el.type === "DeleteStmt") {
            return {
              type: "DeleteStmt",
              target: transformExpr(el.target, foreignParam, allocator, outerLets),
              pos: el.pos
            };
          }
          if (el.type === "LetDecl") {
            return {
              type: "LetDecl",
              name: el.name,
              value: transformExpr(el.value, foreignParam, allocator, outerLets),
              kind: el.kind,
              pos: el.pos
            };
          }
          if (el.type === "FuncDecl")
            return { ...el, lambda: transformExpr(el.lambda, foreignParam, allocator, outerLets) };
          return transformExpr(el, foreignParam, allocator, outerLets);
        }),
        pos: expr.pos
      };
    case "ObjectLiteral":
      return {
        type: "ObjectLiteral",
        entries: expr.entries.map((entry) => {
          if (entry.type === "SpreadElement") {
            return {
              type: "SpreadElement",
              argument: transformExpr(entry.argument, foreignParam, allocator, outerLets),
              pos: entry.pos
            };
          }
          const kv = {
            type: "KeyValueEntry",
            key: entry.key.kind === "computed" ? { kind: "computed", expr: transformExpr(entry.key.expr, foreignParam, allocator, outerLets) } : entry.key,
            value: transformExpr(entry.value, foreignParam, allocator, outerLets),
            pos: entry.pos
          };
          return kv;
        }),
        pos: expr.pos
      };
    case "TemplateLiteral":
      return {
        type: "TemplateLiteral",
        quasis: expr.quasis,
        expressions: expr.expressions.map((e) => transformExpr(e, foreignParam, allocator, outerLets)),
        pos: expr.pos
      };
    case "TypeofExpr":
      return {
        type: "TypeofExpr",
        operand: transformExpr(expr.operand, foreignParam, allocator, outerLets),
        pos: expr.pos
      };
    case "NewDate":
      return {
        type: "NewDate",
        args: expr.args.map((a) => transformExpr(a, foreignParam, allocator, outerLets)),
        pos: expr.pos
      };
    case "NewSet":
      return {
        type: "NewSet",
        arg: expr.arg !== null ? transformExpr(expr.arg, foreignParam, allocator, outerLets) : null,
        pos: expr.pos
      };
    case "TypeCast":
      return {
        type: "TypeCast",
        cast: expr.cast,
        arg: transformExpr(expr.arg, foreignParam, allocator, outerLets),
        pos: expr.pos
      };
    case "MathCall":
      return {
        type: "MathCall",
        method: expr.method,
        args: transformCallArgs(expr.args, foreignParam, allocator, outerLets),
        pos: expr.pos
      };
    case "ObjectCall":
      return {
        type: "ObjectCall",
        method: expr.method,
        args: transformCallArgs(expr.args, foreignParam, allocator, outerLets),
        pos: expr.pos
      };
    case "ArrayFrom":
      return {
        type: "ArrayFrom",
        input: transformExpr(expr.input, foreignParam, allocator, outerLets),
        mapFn: expr.mapFn !== null ? transformExpr(expr.mapFn, foreignParam, allocator, outerLets) : null,
        pos: expr.pos
      };
    case "NumberStatic":
      return {
        type: "NumberStatic",
        method: expr.method,
        arg: transformExpr(expr.arg, foreignParam, allocator, outerLets),
        pos: expr.pos
      };
    case "DateUTC":
      return {
        type: "DateUTC",
        args: expr.args.map((a) => transformExpr(a, foreignParam, allocator, outerLets)),
        pos: expr.pos
      };
  }
}
function transformCallArgs(args, foreignParam, allocator, outerLets) {
  return args.map((a) => {
    if (a.type === "SpreadElement") {
      return {
        type: "SpreadElement",
        argument: transformExpr(a.argument, foreignParam, allocator, outerLets),
        pos: a.pos
      };
    }
    return transformExpr(a, foreignParam, allocator, outerLets);
  });
}
function lowerLookup(call, as, outerCtx, lowerBlock2, enclosingArg) {
  const enclosing = enclosingArg ?? outerCtx.enclosingLookup ?? EMPTY_ENCLOSING;
  const pred = translatePredicate(call, outerCtx, lowerBlock2, enclosing);
  const from = requireSameDbColl(call.db, call.collection, call.pos);
  const stages = [];
  if (pred.kind === "basic") {
    stages.push({ $lookup: { from, localField: pred.localField, foreignField: pred.foreignField, as } });
  } else {
    stages.push({ $lookup: pipelineLookupBody(from, pred.letVars, pred.pipeline, as) });
  }
  if (call.method === "find") {
    stages.push({ $set: { [as]: { $first: `$${as}` } } });
  }
  return stages;
}
function pipelineLookupBody(from, letVars, pipeline, as) {
  return Object.keys(letVars).length === 0 ? { from, pipeline, as } : { from, let: letVars, pipeline, as };
}
function injectImplicitFilterForValueTerminal(expr) {
  if (expr.type !== "MethodCall") return expr;
  const chain = [];
  let cur = expr;
  while (cur.type === "MethodCall") {
    chain.push(cur);
    cur = cur.object;
  }
  const innermost = chain[chain.length - 1];
  if (innermost.method === "find" || innermost.method === "filter") return expr;
  if (!VALUE_TERMINAL_METHODS.has(innermost.method)) return expr;
  if (classifyLookupReceiver(cur) === null) return expr;
  const trueArrow = {
    type: "Lambda",
    params: ["jsmqlD"],
    body: { type: "BooleanLiteral", value: true, pos: innermost.pos },
    pos: innermost.pos
  };
  const filterCall = {
    type: "MethodCall",
    method: "filter",
    object: cur,
    args: [trueArrow],
    pos: innermost.pos
  };
  let rebuilt = { ...innermost, object: filterCall };
  for (let i = chain.length - 2; i >= 0; i--) rebuilt = { ...chain[i], object: rebuilt };
  return rebuilt;
}
function extractLookupCalls(exprArg, outerCtx, allocSlot, lowerBlock2, enclosingArg) {
  const expr = injectImplicitFilterForValueTerminal(exprArg);
  const enclosing = enclosingArg ?? outerCtx.enclosingLookup ?? EMPTY_ENCLOSING;
  validateLookupShape(expr);
  if (expr.type === "MemberAccess" && expr.member === "length") {
    const innerCall = detectLookupCall(expr.object, outerCtx);
    if (innerCall !== null) {
      if (innerCall.method === "find") {
        throw new CodegenError(
          `.length on a .find() result is not meaningful \u2014 .find returns scalar-or-null. Use .filter(...).length to count matching documents, or chain a field access (.find(...).<field>) to read a property of the matched doc.`,
          expr.pos
        );
      }
      const slot = allocSlot();
      const stages = lowerLookup(innerCall, slot, outerCtx, lowerBlock2, enclosing);
      stages.push({ $set: { [slot]: { $size: `$${slot}` } } });
      return { stages, rewritten: { type: "FieldRef", path: slot, pos: expr.pos } };
    }
  }
  if (expr.type === "MethodCall" && expr.method === "reduce") {
    const innerCall = detectLookupCall(expr.object, outerCtx);
    if (innerCall !== null) {
      if (innerCall.method === "find") {
        throw new CodegenError(
          `.reduce() on a .find() result is not meaningful \u2014 .find returns a scalar-or-null. Use .filter(...) before .reduce(), or read the scalar directly.`,
          expr.pos
        );
      }
      const slot = allocSlot();
      const stages = lowerLookup(innerCall, slot, outerCtx, lowerBlock2, enclosing);
      const reduceCall = {
        type: "MethodCall",
        object: { type: "FieldRef", path: slot, pos: expr.pos },
        method: "reduce",
        args: expr.args,
        pos: expr.pos
      };
      const reduceExpr = generateWithCtx(reduceCall, outerCtx);
      stages.push({ $set: { [slot]: reduceExpr } });
      return { stages, rewritten: { type: "FieldRef", path: slot, pos: expr.pos } };
    }
  }
  if (expr.type === "MethodCall" && expr.method === "aggregate") {
    const innerCall = detectLookupCall(expr.object, outerCtx);
    if (innerCall !== null && innerCall.method === "find") {
      throw new CodegenError(
        `.aggregate() on a .find() result is not meaningful \u2014 .find returns a scalar-or-null, not a collection to aggregate. Use .filter(pred).aggregate(...) to run a sub-pipeline over the matches.`,
        expr.pos
      );
    }
  }
  const direct = detectLookupCall(expr, outerCtx);
  if (direct !== null) {
    const slot = allocSlot();
    const stages = lowerLookup(direct, slot, outerCtx, lowerBlock2, enclosing);
    return { stages, rewritten: { type: "FieldRef", path: slot, pos: expr.pos } };
  }
  const chained = tryExtractChainedLookup(expr, outerCtx, allocSlot, lowerBlock2, enclosing);
  if (chained !== null) return chained;
  return descendAndExtract(expr, outerCtx, allocSlot, lowerBlock2, enclosing);
}
var ITERATEE_SHORTHAND_PARAM = "jsmqlEl";
function peelableTerminalMap(m) {
  if (m.method !== "map" || m.args.length !== 1) return null;
  const arg = m.args[0];
  if (arg.type === "Lambda" && arg.block === void 0 && arg.body !== void 0) return arg;
  if (arg.type === "Lambda" && arg.block !== void 0 && arg.ret !== void 0 && arg.ret.type !== "ObjectLiteral") {
    const stmts = arg.block.stmts;
    if (stmts.length === 0) {
      return { type: "Lambda", params: arg.params, body: arg.ret, pos: arg.pos };
    }
    if (stmts.every((s) => s.type === "LetDecl")) {
      return {
        type: "Lambda",
        params: arg.params,
        exprBlock: { type: "ExprBlock", decls: stmts, ret: arg.ret, pos: arg.block.pos },
        pos: arg.pos
      };
    }
    return arg;
  }
  return tryShorthandToLambda(arg, "map", ITERATEE_SHORTHAND_PARAM);
}
function isValueCollapsingMap(m) {
  if (m.method !== "map" || m.args.length !== 1) return false;
  const arg = m.args[0];
  if (arg.type !== "Lambda") return tryShorthandToLambda(arg, "map", ITERATEE_SHORTHAND_PARAM) !== null;
  if (arg.block === void 0 && arg.body !== void 0) return arg.body.type !== "ObjectLiteral";
  if (arg.block !== void 0 && arg.ret !== void 0) return arg.ret.type !== "ObjectLiteral";
  return false;
}
function isCollapsingTerminal(m) {
  if (m.method === "countBy" || m.method === "keyBy") return true;
  if (m.method === "groupBy") return m.args.length === 1 && m.args[0].type !== "ObjectLiteral";
  return false;
}
function chainFilterLambda(m) {
  const rejectHint = m.method === "reject" ? `, a matches-object ('{ active: true }'), a field name, or a ["field", value] pair` : "";
  if (m.args.length !== 1 || m.args[0].type === "SpreadElement") {
    throw new CodegenError(`.${m.method}(<predicate>) takes a single arrow predicate ('o => \u2026')${rejectHint}.`, m.pos);
  }
  const arg = m.args[0];
  const base = arg.type === "Lambda" ? arg : shorthandToLambda(arg, m.method, FOREIGN_SHORTHAND_PARAM);
  if (base === null || base.params.length !== 1) {
    throw new CodegenError(
      `.${m.method}(<predicate>) takes a single-parameter arrow ('o => \u2026')${rejectHint}.`,
      arg.pos
    );
  }
  if (m.method === "reject") {
    if (base.body === void 0) {
      throw new CodegenError(`.reject(<predicate>) takes a single-parameter expression arrow ('o => \u2026').`, base.pos);
    }
    return {
      type: "Lambda",
      params: base.params,
      body: { type: "UnaryExpr", op: "!", operand: base.body, pos: base.pos },
      pos: base.pos
    };
  }
  return base;
}
function lowerForeignChainFilter(m, outerCtx, lowerBlock2, enclosing) {
  const lambda = chainFilterLambda(m);
  const { letVars, pipelineBody } = buildPipelineFormPredicate(lambda, outerCtx, lowerBlock2, enclosing);
  return { letVars, stages: pipelineBody };
}
function peelForeignChain(methods, start, chainEnd, outerCtx, lowerBlock2, allocSlot, enclosing, innerCtx, pipelineBody, letVars) {
  const cleanup = [];
  for (let i = start; i < chainEnd; i++) {
    const m = methods[i];
    if (m.method === "filter" || m.method === "reject") {
      const { letVars: fLets, stages } = lowerForeignChainFilter(m, outerCtx, lowerBlock2, enclosing);
      Object.assign(letVars, fLets);
      pipelineBody.push(...stages);
      continue;
    }
    const def = lookupStreamMethod(m.method);
    if (def === null) continue;
    def.validate(m.args, m.pos);
    const result = def.lower(m.args, innerCtx, m.pos, lowerBlock2, pipelineBody, allocSlot, true);
    if (result.replacesPreviousStage) pipelineBody.pop();
    pipelineBody.push(...result.stages);
    if (result.cleanupStages) cleanup.push(...result.cleanupStages);
    if (result.extraLetVars) Object.assign(letVars, result.extraLetVars);
  }
  pipelineBody.push(...cleanup);
}
function isPeelableChainMethod(name) {
  return lookupStreamMethod(name) !== null || name === "filter" || name === "reject";
}
function tryExtractChainedLookup(expr, outerCtx, allocSlot, lowerBlock2, enclosing = EMPTY_ENCLOSING) {
  if (expr.type !== "MethodCall") return null;
  const methods = [];
  let cur = expr;
  while (cur.type === "MethodCall") {
    methods.push(cur);
    cur = cur.object;
  }
  methods.reverse();
  if (methods.length === 0) return null;
  const head = methods[0];
  const direct = detectLookupCall(head, outerCtx);
  let target;
  let start;
  const seedLetVars = {};
  const seedPipeline = [];
  if (direct !== null) {
    if (direct.method !== "filter") {
      if (direct.method === "find" && methods.length > 1) {
        const next = methods[1];
        const fam = requiredReceiverFamily(next.method);
        if (fam === "string" || fam === "array" || fam === "number" || fam === "date") {
          throw new CodegenError(
            `'$$$.${direct.collection}.find(<pred>)' returns a single matched document, but '.${next.method}(...)' needs ${RECEIVER_NOUN[fam]}. Use '$$$.${direct.collection}.filter(<pred>).${next.method}(...)' to run it over all matches, or read a field of the matched document ('$$$.${direct.collection}.find(<pred>).<field>').`,
            next.pos
          );
        }
      }
      return null;
    }
    if (methods.length < 2) return null;
    const seed = buildPipelineFormPredicate(direct.lambda, outerCtx, lowerBlock2, enclosing);
    Object.assign(seedLetVars, seed.letVars);
    seedPipeline.push(...seed.pipelineBody);
    target = { db: direct.db, collection: direct.collection, pos: direct.pos };
    start = 1;
  } else {
    const t = extractLookupTarget(cur, outerCtx);
    if (t === null) return null;
    if (!isPeelableChainMethod(head.method)) return null;
    target = t;
    start = 0;
  }
  const terminalMap = peelableTerminalMap(methods[methods.length - 1]);
  const chainEnd = terminalMap !== null ? methods.length - 1 : methods.length;
  if (terminalMap !== null && chainEnd >= 1 && isCollapsingTerminal(methods[chainEnd - 1])) {
    const collapser = methods[chainEnd - 1].method;
    throw new CodegenError(
      `'.map(...)' can't follow '.${collapser}(...)' on '$$$.${target.collection}' \u2014 '.${collapser}' returns a single object, not an array. Drop the '.map', or map over the object's values with a value-mode expression on the assigned field.`,
      methods[methods.length - 1].pos
    );
  }
  for (let i = start; i < chainEnd; i++) {
    if (!isPeelableChainMethod(methods[i].method)) return null;
  }
  for (let i = start; i < chainEnd; i++) {
    if (isValueCollapsingMap(methods[i])) return null;
  }
  const letVars = { ...seedLetVars };
  const pipelineBody = [...seedPipeline];
  const usesRootLen = methods.slice(start, chainEnd).some((m) => m.args.some((a) => someArg(a, isRootStreamLengthNode)));
  const innerCtx = {
    ...captureRootStreamLength(usesRootLen, enclosing.foreignParams.length, letVars, freshSubPipelineCtx(outerCtx)),
    enclosingLookup: enclosing,
    pipelineLets: outerCtx.pipelineLets
  };
  peelForeignChain(
    methods,
    start,
    chainEnd,
    outerCtx,
    lowerBlock2,
    allocSlot,
    enclosing,
    innerCtx,
    pipelineBody,
    letVars
  );
  const slot = allocSlot();
  const from = requireSameDbColl(target.db, target.collection, target.pos);
  const slotRef = { type: "FieldRef", path: slot, pos: expr.pos };
  const rewritten = terminalMap !== null ? { type: "MethodCall", object: slotRef, method: "map", args: [terminalMap], pos: expr.pos } : slotRef;
  const stages = [{ $lookup: pipelineLookupBody(from, letVars, pipelineBody, slot) }];
  if (isCollapsingTerminal(methods[methods.length - 1])) {
    stages.push({ $set: { [slot]: { $ifNull: [{ $first: `$${slot}` }, {}] } } });
  }
  return { stages, rewritten };
}
function descendAndExtract(expr, outerCtx, allocSlot, lowerBlock2, enclosing = EMPTY_ENCLOSING) {
  const stages = [];
  const rewriteChild = (child) => {
    const r = extractLookupCalls(child, outerCtx, allocSlot, lowerBlock2, enclosing);
    for (const s of r.stages) stages.push(s);
    return r.rewritten;
  };
  switch (expr.type) {
    case "FieldRef":
    case "CollectionRef":
    case "DatabaseRef":
    case "ClusterRef":
    case "NumberLiteral":
    case "BigIntLiteral":
    case "StringLiteral":
    case "BooleanLiteral":
    case "NullLiteral":
    case "UndefinedLiteral":
    case "RegexLiteral":
    case "ParamRef":
    case "TypeCastRef":
    case "MathConst":
    case "MathCallRef":
    case "DateNow":
    case "ObjectIdLiteral":
      return { stages, rewritten: expr };
    case "BinaryExpr":
      return {
        stages,
        rewritten: {
          type: "BinaryExpr",
          op: expr.op,
          left: rewriteChild(expr.left),
          right: rewriteChild(expr.right),
          pos: expr.pos
        }
      };
    case "UnaryExpr":
      return {
        stages,
        rewritten: { type: "UnaryExpr", op: expr.op, operand: rewriteChild(expr.operand), pos: expr.pos }
      };
    case "TernaryExpr":
      return {
        stages,
        rewritten: {
          type: "TernaryExpr",
          condition: rewriteChild(expr.condition),
          consequent: rewriteChild(expr.consequent),
          alternate: rewriteChild(expr.alternate),
          pos: expr.pos
        }
      };
    case "MemberAccess":
      return {
        stages,
        rewritten: {
          type: "MemberAccess",
          object: rewriteChild(expr.object),
          member: expr.member,
          pos: expr.pos,
          ...expr.optional && { optional: true }
        }
      };
    case "IndexAccess":
      return {
        stages,
        rewritten: {
          type: "IndexAccess",
          object: rewriteChild(expr.object),
          index: rewriteChild(expr.index),
          pos: expr.pos,
          ...expr.optional && { optional: true }
        }
      };
    case "MethodCall":
      return {
        stages,
        rewritten: {
          type: "MethodCall",
          object: rewriteChild(expr.object),
          method: expr.method,
          args: rewriteCallArgs(expr.args, rewriteChild),
          pos: expr.pos,
          ...expr.optional && { optional: true }
        }
      };
    case "CallExpression":
      return {
        stages,
        rewritten: {
          type: "CallExpression",
          callee: rewriteChild(expr.callee),
          args: rewriteCallArgs(expr.args, rewriteChild),
          pos: expr.pos
        }
      };
    case "OperatorCall":
      return {
        stages,
        rewritten: {
          type: "OperatorCall",
          name: expr.name,
          style: expr.style,
          args: rewriteCallArgs(expr.args, rewriteChild),
          pos: expr.pos
        }
      };
    case "Lambda":
      return { stages, rewritten: expr };
    case "ArrayLiteral":
      return {
        stages,
        rewritten: {
          type: "ArrayLiteral",
          elements: expr.elements.map((el) => {
            if (el.type === "SpreadElement")
              return { type: "SpreadElement", argument: rewriteChild(el.argument), pos: el.pos };
            if (el.type === "AssignExpr")
              return {
                type: "AssignExpr",
                target: rewriteChild(el.target),
                value: rewriteChild(el.value),
                pos: el.pos
              };
            if (el.type === "DeleteStmt") return { type: "DeleteStmt", target: rewriteChild(el.target), pos: el.pos };
            if (el.type === "LetDecl")
              return { type: "LetDecl", name: el.name, value: rewriteChild(el.value), kind: el.kind, pos: el.pos };
            if (el.type === "FuncDecl") return el;
            return rewriteChild(el);
          }),
          pos: expr.pos
        }
      };
    case "ObjectLiteral":
      return {
        stages,
        rewritten: {
          type: "ObjectLiteral",
          entries: expr.entries.map((entry) => {
            if (entry.type === "SpreadElement")
              return { type: "SpreadElement", argument: rewriteChild(entry.argument), pos: entry.pos };
            const kv = {
              type: "KeyValueEntry",
              key: entry.key.kind === "computed" ? { kind: "computed", expr: rewriteChild(entry.key.expr) } : entry.key,
              value: rewriteChild(entry.value),
              pos: entry.pos
            };
            return kv;
          }),
          pos: expr.pos
        }
      };
    case "TemplateLiteral":
      return {
        stages,
        rewritten: {
          type: "TemplateLiteral",
          quasis: expr.quasis,
          expressions: expr.expressions.map(rewriteChild),
          pos: expr.pos
        }
      };
    case "TypeofExpr":
      return { stages, rewritten: { type: "TypeofExpr", operand: rewriteChild(expr.operand), pos: expr.pos } };
    case "NewDate":
      return { stages, rewritten: { type: "NewDate", args: expr.args.map(rewriteChild), pos: expr.pos } };
    case "NewSet":
      return {
        stages,
        rewritten: { type: "NewSet", arg: expr.arg !== null ? rewriteChild(expr.arg) : null, pos: expr.pos }
      };
    case "TypeCast":
      return { stages, rewritten: { type: "TypeCast", cast: expr.cast, arg: rewriteChild(expr.arg), pos: expr.pos } };
    case "MathCall":
      return {
        stages,
        rewritten: {
          type: "MathCall",
          method: expr.method,
          args: rewriteCallArgs(expr.args, rewriteChild),
          pos: expr.pos
        }
      };
    case "ObjectCall":
      return {
        stages,
        rewritten: {
          type: "ObjectCall",
          method: expr.method,
          args: rewriteCallArgs(expr.args, rewriteChild),
          pos: expr.pos
        }
      };
    case "ArrayFrom":
      return {
        stages,
        rewritten: {
          type: "ArrayFrom",
          input: rewriteChild(expr.input),
          mapFn: expr.mapFn !== null ? rewriteChild(expr.mapFn) : null,
          pos: expr.pos
        }
      };
    case "NumberStatic":
      return {
        stages,
        rewritten: { type: "NumberStatic", method: expr.method, arg: rewriteChild(expr.arg), pos: expr.pos }
      };
    case "DateUTC":
      return { stages, rewritten: { type: "DateUTC", args: expr.args.map(rewriteChild), pos: expr.pos } };
  }
}
function rewriteCallArgs(args, rewrite) {
  return args.map((a) => {
    if (a.type === "SpreadElement") return { type: "SpreadElement", argument: rewrite(a.argument), pos: a.pos };
    return rewrite(a);
  });
}

// src/facet-translation.ts
function detectFacetShape(value) {
  if (value.type !== "ObjectLiteral") return null;
  if (value.entries.length === 0) return null;
  let hasFilter = false;
  for (const entry of value.entries) {
    if (entry.type !== "KeyValueEntry") continue;
    if (asCollectionFilterLambda(entry.value) !== null) {
      hasFilter = true;
      break;
    }
  }
  if (!hasFilter) return null;
  const facets = [];
  for (const entry of value.entries) {
    if (entry.type !== "KeyValueEntry") {
      throw new CodegenError(
        `\`$ = { ... }\` $facet pattern: spread entries are not allowed. Every value must be \`$$.filter(<predicate>)\`.`,
        entry.pos
      );
    }
    if (entry.key.kind !== "static") {
      throw new CodegenError(
        `\`$ = { ... }\` $facet pattern: computed keys are not allowed. Facet names are stage output keys and must be static identifiers.`,
        entry.pos
      );
    }
    const lambda = asCollectionFilterLambda(entry.value);
    if (lambda === null) {
      throw new CodegenError(
        `\`$ = { ... }\` $facet pattern: every value must be \`$$.filter(<predicate>)\`. Entry '${entry.key.name}' is something else. Either convert it to \`$$.filter(<predicate>)\` or move it out of the object.`,
        entry.value.pos
      );
    }
    facets.push({ key: entry.key.name, lambda, pos: entry.pos });
  }
  return facets;
}
function asCollectionFilterLambda(expr) {
  if (expr.type !== "MethodCall") return null;
  if (expr.method !== "filter") return null;
  if (expr.object.type !== "CollectionRef") return null;
  if (expr.args.length !== 1) return null;
  const arg = expr.args[0];
  if (arg.type !== "Lambda") return null;
  return arg;
}
function lowerFacet(facets, outerCtx, lowerBlock2) {
  const body = {};
  const seen = /* @__PURE__ */ new Set();
  for (const f of facets) {
    if (seen.has(f.key)) {
      throw new CodegenError(
        `\`$ = { ... }\` $facet pattern: duplicate key '${f.key}'. Facet names must be unique.`,
        f.pos
      );
    }
    seen.add(f.key);
    body[f.key] = lowerFacetEntry(f.lambda, outerCtx, lowerBlock2);
  }
  return [{ $facet: body }];
}
function lowerFacetEntry(lambda, outerCtx, lowerBlock2) {
  if (lambda.params.length !== 1) {
    throw new CodegenError(
      `\`$$.filter(<predicate>)\` inside \`$ = { ... }\` $facet must take exactly one parameter \u2014 write \`$$.filter(o => \u2026)\` (the param name is your choice). The param represents each input document inside the facet sub-pipeline.`,
      lambda.pos
    );
  }
  return lowerLambdaPredicate(lambda, outerCtx, lowerBlock2, {
    freshCtx: freshFacetCtx,
    onLocalRef: rejectLocalRef,
    missingBody: () => {
      throw new CodegenError(
        `\`$$.filter(p)\` predicate has a block body with local \`const\`/\`let\` bindings, which isn't supported in this position. Write the predicate as a single expression \u2014 \`function (x) { return <expr> }\` / \`(x) => <expr>\` \u2014 and fold any bindings into <expr>.`,
        lambda.pos
      );
    }
  });
}
function rejectLocalRef(letVars, param, pos) {
  const sample = Object.values(letVars)[0];
  const samplePath = sample.replace(/^\$+/, "");
  throw new CodegenError(
    `\`$.<field>\` inside \`$$.filter(p)\` in a \`$ = { ... }\` $facet is not supported \u2014 use the lambda parameter (e.g. \`${param}.${samplePath}\`) to reference the current document. Inside a facet sub-pipeline, the lambda param IS the current document; \`$.<field>\` would mean the same thing and adding a second spelling for it would only invite drift.`,
    pos
  );
}

// src/stage-validation.ts
function rejectNonDocumentNewRoot(stage, value) {
  const desc = describeLiteral(value);
  if (desc !== null && value.type !== "ObjectLiteral") {
    if (value.type === "StringLiteral" && value.value.startsWith("$")) return;
    throw new CodegenError(
      `'${stage}' must resolve to a document, but got ${desc}. Wrap it, e.g. '{ value: \u2026 }'.`,
      value.pos
    );
  }
}
function requireObjectStageBody(stage, body, fix = "") {
  if (body.type === "ObjectLiteral") return;
  const desc = describeLiteral(body);
  if (desc === null) return;
  const tail = fix ? ` ${fix}` : "";
  throw new CodegenError(`'${stage}' expects an object body, but got ${desc}.${tail}`, body.pos);
}
var MATCH_DISALLOWED = {
  $near: "use the '$geoNear' stage (it must be the first stage), or '$geoWithin' with '$center'/'$centerSphere'",
  $nearSphere: "use the '$geoNear' stage (it must be the first stage), or '$geoWithin' with '$centerSphere'",
  $where: "use '$expr' with a query expression (or '$function' for server-side JS)"
};
function findMatchOperator(body, names) {
  if (body.type === "ObjectLiteral") {
    for (const entry of body.entries) {
      if (entry.type !== "KeyValueEntry") continue;
      if (entry.key.kind === "static" && names.has(entry.key.name)) {
        return { name: entry.key.name, pos: entry.pos };
      }
      const found = findMatchOperator(entry.value, names);
      if (found !== null) return found;
    }
  } else if (body.type === "ArrayLiteral") {
    for (const el of body.elements) {
      if (el.type === "SpreadElement" || el.type === "AssignExpr" || el.type === "DeleteStmt" || el.type === "LetDecl" || el.type === "FuncDecl") {
        continue;
      }
      const found = findMatchOperator(el, names);
      if (found !== null) return found;
    }
  }
  return null;
}
var DISALLOWED_SET = new Set(Object.keys(MATCH_DISALLOWED));
var TEXT_SET = /* @__PURE__ */ new Set(["$text"]);
function validateMatchPlacement(body, opts) {
  if (body.type !== "ObjectLiteral") return;
  const disallowed = findMatchOperator(body, DISALLOWED_SET);
  if (disallowed !== null) {
    throw new CodegenError(
      `'${disallowed.name}' is not allowed inside an aggregation '$match' \u2014 ${MATCH_DISALLOWED[disallowed.name]}.`,
      disallowed.pos
    );
  }
  if (opts.isTopLevel && !opts.isFirstStage) {
    const text = findMatchOperator(body, TEXT_SET);
    if (text !== null) {
      throw new CodegenError(
        `A '$match' that uses '$text' must be the first stage in a pipeline. Move it to the front.`,
        text.pos
      );
    }
  }
}
var MERGE_WHEN_MATCHED = ["replace", "keepExisting", "merge", "fail"];
var MERGE_WHEN_NOT_MATCHED = ["insert", "discard", "fail"];
var FILL_METHODS = ["linear", "locf"];
var BUCKET_AUTO_GRANULARITY = [
  "R5",
  "R10",
  "R20",
  "R40",
  "R80",
  "1-2-5",
  "E6",
  "E12",
  "E24",
  "E48",
  "E96",
  "E192",
  "POWERSOF2"
];
function validateCount(body) {
  const s = litString(body);
  if (s === null) {
    const desc = describeLiteral(body);
    if (desc !== null) throw new CodegenError(`'$count' expects a field-name string, but got ${desc}.`, body.pos);
    return;
  }
  if (s.length === 0) throw new CodegenError(`'$count' field name must be a non-empty string.`, body.pos);
  if (s.startsWith("$")) throw new CodegenError(`'$count' field name cannot start with '$' (got '${s}').`, body.pos);
  if (s.includes(".")) throw new CodegenError(`'$count' field name cannot contain '.' (got '${s}').`, body.pos);
}
function validateSort(body) {
  requireObjectStageBody("$sort", body, "Sort by a field, e.g. $sort({ field: 1 }).");
  const info = requireObjectBody("$sort", body);
  if (info === null) return;
  if (info.byKey.size > 32 && !info.hasSpread) {
    throw new CodegenError(`'$sort' accepts at most 32 keys, but got ${info.byKey.size}.`, body.pos);
  }
  for (const [key, value] of info.byKey) {
    const n = litNumber(value);
    if (n !== null && n !== 1 && n !== -1) {
      throw new CodegenError(
        `'$sort' direction for '${key}' must be 1 (ascending) or -1 (descending), but got ${n}.`,
        value.pos
      );
    }
    const str = litString(value);
    const bool = litBool(value);
    if (str !== null || bool !== null) {
      const got = str !== null ? `'${str}'` : String(bool);
      throw new CodegenError(
        `'$sort' direction for '${key}' must be 1 (ascending) or -1 (descending), but got ${got}.`,
        value.pos
      );
    }
  }
}
function validateProject(body) {
  requireObjectStageBody("$project", body, "List fields, e.g. $project({ field: 1 }).");
  const info = requireObjectBody("$project", body);
  if (info === null) return;
  if (info.byKey.size === 0 && !info.hasSpread) {
    throw new CodegenError(`'$project' specification must name at least one field.`, body.pos);
  }
  let includeKey = null;
  let excludeKey = null;
  for (const [key, value] of info.byKey) {
    if (key === "_id") continue;
    const n = litNumber(value);
    const b = litBool(value);
    if (n === 0 || b === false) excludeKey = key;
    else if (n === 1 || b === true) includeKey = key;
  }
  if (includeKey !== null && excludeKey !== null) {
    throw new CodegenError(
      `'$project' cannot mix field inclusion ('${includeKey}: 1') and exclusion ('${excludeKey}: 0') \u2014 only '_id' may be excluded in an inclusion projection. Use one mode: list fields to keep, or fields to drop.`,
      body.pos
    );
  }
}
function validateUnset(body) {
  const s = litString(body);
  if (s !== null) {
    if (s.length === 0) throw new CodegenError(`'$unset' field name must be a non-empty string.`, body.pos);
    return;
  }
  const els = arrayElements(body);
  if (els === null) {
    const desc = describeLiteral(body);
    if (desc !== null && body.type !== "ArrayLiteral") {
      throw new CodegenError(`'$unset' expects a field-name string or an array of strings, but got ${desc}.`, body.pos);
    }
    return;
  }
  if (els.length === 0) throw new CodegenError(`'$unset' field-name array must not be empty.`, body.pos);
  for (const el of els) {
    if (litString(el) === null && describeLiteral(el) !== null) {
      throw new CodegenError(`'$unset' field-name array must contain only strings.`, el.pos);
    }
  }
}
function validateUnwind(body) {
  const s = litString(body);
  if (s !== null) {
    if (!s.startsWith("$")) {
      throw new CodegenError(`'$unwind' path must be a field path starting with '$' (got '${s}').`, body.pos);
    }
    return;
  }
  const info = requireObjectBody("$unwind", body);
  if (info === null) return;
  const path = info.byKey.get("path");
  if (path !== void 0) {
    const ps = litString(path);
    if (ps !== null && !ps.startsWith("$")) {
      throw new CodegenError(`'$unwind' path must be a field path starting with '$' (got '${ps}').`, path.pos);
    }
  }
  const idx = info.byKey.get("includeArrayIndex");
  if (idx !== void 0) {
    const is = litString(idx);
    if (is !== null && is.startsWith("$")) {
      throw new CodegenError(`'$unwind' includeArrayIndex name cannot start with '$' (got '${is}').`, idx.pos);
    }
  }
  const preserve = info.byKey.get("preserveNullAndEmptyArrays");
  if (preserve !== void 0 && litBool(preserve) === null) {
    const desc = describeLiteral(preserve);
    if (desc !== null) {
      throw new CodegenError(`'$unwind' preserveNullAndEmptyArrays must be a boolean, but got ${desc}.`, preserve.pos);
    }
  }
}
function validateSample(body) {
  requireObjectStageBody("$sample", body, "Sample N documents, e.g. $sample({ size: 100 }).");
  const info = requireObjectBody("$sample", body, ["size"]);
  if (info === null) return;
  const size = info.byKey.get("size");
  if (size !== void 0) checkIntBound("$sample size", size, { min: 0, label: "a non-negative integer" });
}
function validateBucket(body) {
  requireObjectStageBody("$bucket", body, "e.g. $bucket({ groupBy: <expr>, boundaries: [...] }).");
  const info = requireObjectBody("$bucket", body, ["groupBy", "boundaries"]);
  if (info === null) return;
  const boundaries = info.byKey.get("boundaries");
  if (boundaries === void 0) return;
  requireConstantArray("$bucket boundaries", boundaries);
  const els = arrayElements(boundaries);
  if (els === null) return;
  if (els.length < 2) {
    throw new CodegenError(`'$bucket' boundaries must list at least 2 values, but got ${els.length}.`, boundaries.pos);
  }
  const nums = els.map(litNumber);
  if (nums.every((n) => n !== null)) {
    for (let i = 1; i < nums.length; i++) {
      if (nums[i] <= nums[i - 1]) {
        throw new CodegenError(
          `'$bucket' boundaries must be in strictly ascending order (${nums[i - 1]} is not < ${nums[i]}).`,
          boundaries.pos
        );
      }
    }
    return;
  }
  const strs = els.map(litString);
  if (strs.every((s) => s !== null)) {
    for (let i = 1; i < strs.length; i++) {
      if (strs[i] <= strs[i - 1]) {
        throw new CodegenError(`'$bucket' boundaries must be in strictly ascending order.`, boundaries.pos);
      }
    }
    return;
  }
  const allLiteral = els.every((e) => describeLiteral(e) !== null);
  if (allLiteral && (nums.some((n) => n !== null) || strs.some((s) => s !== null))) {
    const mixed = nums.some((n) => n !== null) && strs.some((s) => s !== null);
    if (mixed) {
      throw new CodegenError(`'$bucket' boundaries must all be the same type.`, boundaries.pos);
    }
  }
}
function validateBucketAuto(body) {
  requireObjectStageBody("$bucketAuto", body, "e.g. $bucketAuto({ groupBy: <expr>, buckets: 5 }).");
  const info = requireObjectBody("$bucketAuto", body, ["groupBy", "buckets"]);
  if (info === null) return;
  const buckets = info.byKey.get("buckets");
  if (buckets !== void 0) checkIntBound("$bucketAuto buckets", buckets, { min: 1, label: "a positive integer" });
  const granularity = info.byKey.get("granularity");
  if (granularity !== void 0) checkEnum("$bucketAuto", "granularity", granularity, BUCKET_AUTO_GRANULARITY);
}
function validateSetWindowFields(body) {
  requireObjectStageBody("$setWindowFields", body, "e.g. $setWindowFields({ sortBy: {...}, output: {...} }).");
  const info = requireObjectBody("$setWindowFields", body, ["output"]);
  if (info === null) return;
  const output = info.byKey.get("output");
  if (output === void 0) return;
  const outInfo = objectInfo(output);
  if (outInfo === null) return;
  for (const [, fieldSpec] of outInfo.byKey) {
    const specInfo = objectInfo(fieldSpec);
    if (specInfo === null) continue;
    const window = specInfo.byKey.get("window");
    if (window === void 0) continue;
    const winInfo = objectInfo(window);
    if (winInfo === null) continue;
    if (winInfo.byKey.has("documents") && winInfo.byKey.has("range")) {
      throw new CodegenError(
        `'$setWindowFields' window cannot specify both 'documents' and 'range' \u2014 they are mutually exclusive.`,
        window.pos
      );
    }
  }
}
function validateFill(body) {
  requireObjectStageBody("$fill", body, "e.g. $fill({ output: { field: { method: 'linear' } }, sortBy: {...} }).");
  const info = requireObjectBody("$fill", body, ["output"]);
  if (info === null) return;
  const output = info.byKey.get("output");
  if (output === void 0) return;
  const outInfo = objectInfo(output);
  if (outInfo === null) return;
  let needsSortBy = false;
  for (const [field, fieldSpec] of outInfo.byKey) {
    const specInfo = objectInfo(fieldSpec);
    if (specInfo === null) continue;
    const hasValue = specInfo.byKey.has("value");
    const method = specInfo.byKey.get("method");
    if (hasValue && method !== void 0) {
      throw new CodegenError(
        `'$fill' output field '${field}' cannot specify both 'value' and 'method' \u2014 they are mutually exclusive.`,
        fieldSpec.pos
      );
    }
    if (method !== void 0) {
      checkEnum("$fill", `output field '${field}' method`, method, FILL_METHODS);
      const ms = litString(method);
      if (ms === "linear" || ms === "locf") needsSortBy = true;
    }
  }
  if (needsSortBy && !info.hasSpread && !info.byKey.has("sortBy")) {
    throw new CodegenError(
      `'$fill' requires 'sortBy' when an output field uses the 'linear' or 'locf' method.`,
      body.pos
    );
  }
}
function validateGraphLookup(body) {
  requireObjectStageBody(
    "$graphLookup",
    body,
    "$graphLookup takes an object spec, e.g. $graphLookup({ from, startWith, connectFromField, connectToField, as })."
  );
  const info = requireObjectBody("$graphLookup", body, [
    "from",
    "startWith",
    "connectFromField",
    "connectToField",
    "as"
  ]);
  if (info === null) return;
  const maxDepth = info.byKey.get("maxDepth");
  if (maxDepth !== void 0)
    checkIntBound("$graphLookup maxDepth", maxDepth, { min: 0, label: "a non-negative integer" });
}
function validateMerge(body) {
  const info = requireObjectBody("$merge", body, ["into"]);
  if (info === null) return;
  const whenMatched = info.byKey.get("whenMatched");
  if (whenMatched !== void 0 && litString(whenMatched) !== null) {
    checkEnum("$merge", "whenMatched", whenMatched, MERGE_WHEN_MATCHED);
  }
  const whenNotMatched = info.byKey.get("whenNotMatched");
  if (whenNotMatched !== void 0) checkEnum("$merge", "whenNotMatched", whenNotMatched, MERGE_WHEN_NOT_MATCHED);
}
function validateLookup(body) {
  requireObjectStageBody(
    "$lookup",
    body,
    "$lookup takes an object spec, e.g. $lookup({ from, localField, foreignField, as })."
  );
  const info = requireObjectBody("$lookup", body, ["from", "as"]);
  if (info === null) return;
  const pipeline = info.byKey.get("pipeline");
  if (pipeline !== void 0) requireConstantArray("$lookup pipeline", pipeline);
}
function validateUnionWith(body) {
  const info = requireObjectBody("$unionWith", body);
  if (info === null) return;
  if (info.hasSpread) return;
  if (!info.byKey.has("coll") && !info.byKey.has("pipeline")) {
    throw new CodegenError(`'$unionWith' requires a 'coll' and/or a 'pipeline'.`, body.pos);
  }
}
function validateReplaceRoot(body) {
  requireObjectStageBody("$replaceRoot", body, "e.g. $replaceRoot({ newRoot: <document> }).");
  const info = requireObjectBody("$replaceRoot", body, ["newRoot"]);
  if (info === null) return;
  const newRoot = info.byKey.get("newRoot");
  if (newRoot !== void 0) rejectNonDocumentNewRoot("$replaceRoot newRoot", newRoot);
}
function validateGroup(body) {
  requireObjectStageBody("$group", body, `Group by a field, e.g. $group({ _id: "$field" }).`);
  requireObjectBody("$group", body, ["_id"]);
}
function validateGeoNear(body) {
  requireObjectStageBody(
    "$geoNear",
    body,
    "e.g. $geoNear({ near: { type: 'Point', coordinates: [...] }, distanceField: '...' })."
  );
  requireObjectBody("$geoNear", body, ["near"]);
}
function validateAddFields(stage, body) {
  requireObjectStageBody(stage, body, `Add fields, e.g. ${stage}({ name: <expr> }).`);
}
function validateDensify(body) {
  requireObjectStageBody(
    "$densify",
    body,
    "e.g. $densify({ field: '...', range: { step: 1, unit: '...', bounds: '...' } })."
  );
  requireObjectBody("$densify", body, ["field", "range"]);
}
function validateDocuments(body) {
  if (body.type === "ArrayLiteral") return;
  const desc = describeLiteral(body);
  if (desc !== null) {
    throw new CodegenError(`'$documents' expects an array of documents, but got ${desc}.`, body.pos);
  }
}
var STAGE_BODY_VALIDATORS = {
  $limit: (b) => checkIntBound("$limit", b, { min: 1, label: "a positive integer" }),
  $skip: (b) => checkIntBound("$skip", b, { min: 0, label: "a non-negative integer" }),
  $sample: validateSample,
  $count: validateCount,
  $sort: validateSort,
  $project: validateProject,
  $addFields: (b) => validateAddFields("$addFields", b),
  $set: (b) => validateAddFields("$set", b),
  $unset: validateUnset,
  $unwind: validateUnwind,
  $bucket: validateBucket,
  $bucketAuto: validateBucketAuto,
  $setWindowFields: validateSetWindowFields,
  $fill: validateFill,
  $densify: validateDensify,
  $group: validateGroup,
  $lookup: validateLookup,
  $unionWith: validateUnionWith,
  $graphLookup: validateGraphLookup,
  $merge: validateMerge,
  $replaceRoot: validateReplaceRoot,
  $replaceWith: (b) => rejectNonDocumentNewRoot("$replaceWith", b),
  $geoNear: validateGeoNear,
  $documents: validateDocuments
};
function validateStageBody(stageName, body) {
  const validator = STAGE_BODY_VALIDATORS[stageName];
  if (validator !== void 0) validator(body);
}

// src/out-translation.ts
function classifyStep(node, ctx) {
  if (node.type === "MemberAccess") return { ok: true, name: node.member, object: node.object };
  if (node.type === "IndexAccess") {
    if (node.index.type === "StringLiteral") {
      return { ok: true, name: node.index.value, object: node.object };
    }
    if (node.index.type === "ParamRef" && ctx?.bindings?.has(node.index.name)) {
      const value = ctx.bindings.get(node.index.name);
      if (typeof value === "string") {
        return { ok: true, name: value, object: node.object };
      }
      return { ok: false, indexPos: node.index.pos, reason: "non-string-binding" };
    }
    return { ok: false, indexPos: node.index.pos, reason: "computed" };
  }
  return null;
}
function detectOutAssign(op, ctx) {
  const t = op.target;
  const leaf = findContextRefLeaf(t);
  if (leaf === null) return null;
  if (leaf.type === "DatabaseRef") {
    const step = classifyStep(t, ctx);
    if (step === null) {
      throw new CodegenError(
        `'$$$' alone isn't a $out target \u2014 write '$$$.<coll>' (or '$$$["<coll>"]') to write to a collection in the local database.`,
        t.pos
      );
    }
    if (!step.ok) {
      const why = step.reason === "non-string-binding" ? `the parameter binding must be a string (collection name is statically determined at compile time)` : `not a runtime expression`;
      throw new CodegenError(
        `'$out' target must be a literal collection name \u2014 use '$$$.<coll>' or '$$$["<coll>"]', ${why}. If you need a parameterised target, use 'jsmql.compile' and pass the name in.`,
        step.indexPos
      );
    }
    if (step.object.type !== "DatabaseRef") {
      throw new CodegenError(
        `'$$$.<a>.<b>' has too many segments for a same-database $out target \u2014 use '$$$$.<db>.<coll>' (four $) for a cross-database write, or '$$$.<coll>' (three $) for the local database.`,
        t.pos
      );
    }
    return { kind: "same-db", coll: step.name, pos: t.pos };
  }
  const outer = classifyStep(t, ctx);
  if (outer === null) {
    throw new CodegenError(
      `'$$$$' alone isn't a $out target \u2014 write '$$$$.<db>.<coll>' (or its bracket equivalents) to write to a collection in another database.`,
      t.pos
    );
  }
  if (!outer.ok) {
    const why = outer.reason === "non-string-binding" ? `the parameter binding must be a string (collection name is statically determined at compile time)` : `not a runtime expression`;
    throw new CodegenError(
      `'$out' target must be a literal collection name \u2014 use '$$$$.<db>.<coll>' or bracketed equivalents, ${why}. If you need a parameterised target, use 'jsmql.compile' and pass the name in.`,
      outer.indexPos
    );
  }
  const inner = classifyStep(outer.object, ctx);
  if (inner === null) {
    throw new CodegenError(
      `'$$$$.<x>' is missing the collection \u2014 write '$$$$.<db>.<coll>' (db, then collection), or use '$$$.<coll>' (three $) for the local database.`,
      t.pos
    );
  }
  if (!inner.ok) {
    const why = inner.reason === "non-string-binding" ? `the parameter binding must be a string (database name is statically determined at compile time)` : `not a runtime expression`;
    throw new CodegenError(
      `'$out' target must be a literal database name \u2014 use '$$$$.<db>.<coll>' or bracketed equivalents, ${why}. If you need a parameterised target, use 'jsmql.compile' and pass the name in.`,
      inner.indexPos
    );
  }
  if (inner.object.type !== "ClusterRef") {
    throw new CodegenError(
      `'$$$$.<a>.<b>.<c>' has too many segments for a $out target \u2014 '$out' writes to one collection in one database, so '$$$$.<db>.<coll>' is the deepest form.`,
      t.pos
    );
  }
  return { kind: "cross-db", db: inner.name, coll: outer.name, pos: t.pos };
}
function findContextRefLeaf(node) {
  let cur = node;
  for (; ; ) {
    if (cur.type === "DatabaseRef") return { type: "DatabaseRef" };
    if (cur.type === "ClusterRef") return { type: "ClusterRef" };
    if (cur.type === "MemberAccess" || cur.type === "IndexAccess") {
      cur = cur.object;
      continue;
    }
    return null;
  }
}
function lowerOutChain(rhs, outerCtx, lowerBlock2, allocSlot) {
  if (rhs.type === "CollectionRef") return [];
  if (rhs.type === "MethodCall") {
    return walkChain(rhs, outerCtx, lowerBlock2, allocSlot);
  }
  throw new CodegenError(
    `The right-hand side of '$$$.<coll> = \u2026' must start with '$$' (the current pipeline). Write '$$$.<coll> = $$' to write the current stream as-is, or '$$$.<coll> = $$.filter(<predicate>)' to pre-filter before writing.`,
    rhs.pos
  );
}
function walkChain(call, outerCtx, lowerBlock2, allocSlot) {
  if (call.type !== "MethodCall") {
    if (call.type === "CollectionRef") {
      return [];
    }
    throw new CodegenError(
      `The right-hand side of '$$$.<coll> = \u2026' must be a chain rooted at '$$' (the current pipeline). '$$$.<coll> = $$', '$$$.<coll> = $$.filter(<predicate>)' are the supported shapes today.`,
      call.pos
    );
  }
  const prefix = call.object.type === "CollectionRef" ? [] : walkChain(call.object, outerCtx, lowerBlock2, allocSlot);
  const here = lowerChainMethod(call, outerCtx, lowerBlock2, prefix, allocSlot);
  if (here.replacesPreviousStage) prefix.pop();
  prefix.push(...here.stages);
  return prefix;
}
function lowerChainMethod(call, outerCtx, lowerBlock2, prevStages, allocSlot) {
  if (call.method === "filter") {
    return { stages: lowerFilterAsMatch(call, outerCtx, lowerBlock2) };
  }
  const def = lookupStreamMethod(call.method);
  if (def !== null) {
    def.validate(call.args, call.pos);
    const result = def.lower(call.args, outerCtx, call.pos, lowerBlock2, prevStages, allocSlot, false);
    return { stages: result.stages, replacesPreviousStage: result.replacesPreviousStage };
  }
  const equivalent = STAGE_EQUIVALENT_HINT[call.method];
  const hint = equivalent !== void 0 ? ` Use '${equivalent}' as a separate stage before the '$out' instead.` : ` Add the equivalent stage call (e.g. '$sort({ \u2026 })', '$skip(N)', '$limit(N)') before the '$out' instead.`;
  throw new CodegenError(`'$$.${call.method}(...)' isn't a recognised chain method for a '$out' RHS.${hint}`, call.pos);
}
var STAGE_EQUIVALENT_HINT = {
  map: "$project({...}) or $addFields({...})",
  sort: "$sort({ field: 1 | -1 })",
  slice: "$skip(N); $limit(M)",
  reduce: "$group({ ... })",
  flatMap: "$unwind",
  flat: "$unwind"
};
function lowerFilterAsMatch(call, outerCtx, lowerBlock2) {
  if (call.args.length !== 1) {
    throw new CodegenError(
      `'$$.filter(<predicate>)' expects exactly one arrow predicate, got ${call.args.length}.`,
      call.pos
    );
  }
  const arg = call.args[0];
  if (arg.type !== "Lambda") {
    throw new CodegenError(
      `'$$.filter(<predicate>)' requires an arrow predicate, e.g. \`$$$.coll = $$.filter(d => d.active)\`.`,
      "pos" in arg ? arg.pos : call.pos
    );
  }
  if (arg.params.length !== 1) {
    throw new CodegenError(
      `'$$.filter(<predicate>)' takes a single-parameter arrow (the current document), got ${arg.params.length}.`,
      arg.pos
    );
  }
  return lowerLambdaPredicate(arg, outerCtx, lowerBlock2, {
    freshCtx: freshSubPipelineCtx,
    onLocalRef: (_letVars, param, pos) => {
      throw new CodegenError(
        `\`$.<field>\` inside '$$.filter(<predicate>)' in a '$out' chain is not supported \u2014 the lambda's parameter \`${param}\` IS the current document. Write \`${param}.<field>\` instead.`,
        pos
      );
    },
    missingBody: () => {
      throw new CodegenError(
        `'$$.filter(<predicate>)' predicate has a block body with local \`const\`/\`let\` bindings, which isn't supported in this position. Write the predicate as a single expression \u2014 \`function (x) { return <expr> }\` / \`(x) => <expr>\` \u2014 and fold any bindings into <expr>.`,
        arg.pos
      );
    }
  });
}
function lowerOut(op, target, outerCtx, lowerBlock2, allocSlot) {
  const prefix = lowerOutChain(op.value, outerCtx, lowerBlock2, allocSlot);
  const body = target.kind === "same-db" ? target.coll : { db: target.db, coll: target.coll };
  prefix.push({ $out: body });
  return prefix;
}
function containsOutAssign(node) {
  return walkContainsOut(node);
}
function walkContainsOut(node) {
  if (node.type === "Pipeline") return node.stmts.some(walkContainsOut);
  if (node.type === "UpdateFilter") return node.ops.some(walkContainsOut);
  if (node.type === "AssignExpr") {
    if (findContextRefLeaf(node.target) !== null) {
      return true;
    }
    return false;
  }
  if (node.type === "DeleteStmt") return false;
  if (node.type === "LetDecl") return false;
  if (node.type === "FuncDecl") return false;
  if (node.type === "ArrayLiteral") {
    for (const el of node.elements) {
      if (el.type === "SpreadElement") continue;
      if (walkContainsOut(el)) return true;
    }
    return false;
  }
  return false;
}

// src/system-stage-translation.ts
var REF_SCOPE = {
  CollectionRef: "collection",
  DatabaseRef: "database",
  ClusterRef: "cluster"
};
var SCOPE_PREFIX = { collection: "$$", database: "$$$", cluster: "$$$$" };
var SCOPE_DRIVER = {
  collection: "db.coll.aggregate()",
  database: "db.aggregate()",
  cluster: "the admin database"
};
var RESERVED_COLLECTION_METHODS = /* @__PURE__ */ new Set(["push", "filter"]);
var DIAGNOSTICS_BY_METHOD = /* @__PURE__ */ new Map();
var METHODS_BY_SCOPE = /* @__PURE__ */ new Map([
  ["collection", []],
  ["database", []],
  ["cluster", []]
]);
for (const [stageName, def] of Object.entries(STAGES)) {
  if (def.diagnostic === void 0) continue;
  const method = stageName.slice(1);
  const entry = { stageName, scope: def.diagnostic.scope, options: def.diagnostic.options };
  DIAGNOSTICS_BY_METHOD.set(method, entry);
  METHODS_BY_SCOPE.get(def.diagnostic.scope).push(method);
}
function isSystemStageCall(expr) {
  if (expr.type !== "MethodCall") return false;
  const scope = REF_SCOPE[expr.object.type];
  if (scope === void 0) return false;
  if (scope !== "collection") return true;
  if (RESERVED_COLLECTION_METHODS.has(expr.method)) return false;
  if (DIAGNOSTICS_BY_METHOD.has(expr.method)) return true;
  return closestNameTo(expr.method, DIAGNOSTICS_BY_METHOD.keys()) !== null;
}
function resolveSystemStageCall(expr) {
  if (expr.type !== "MethodCall") {
    throw new CodegenError("jsmql internal error (please report): resolveSystemStageCall on a non-MethodCall.", 0);
  }
  const scope = REF_SCOPE[expr.object.type];
  const prefix = SCOPE_PREFIX[scope];
  const method = expr.method;
  const refPos = expr.object.pos;
  const def = DIAGNOSTICS_BY_METHOD.get(method);
  if (def === void 0) {
    const hint = didYouMean(
      method,
      DIAGNOSTICS_BY_METHOD.keys(),
      (s) => `${SCOPE_PREFIX[DIAGNOSTICS_BY_METHOD.get(s).scope]}.${s}(...)`
    );
    const here = METHODS_BY_SCOPE.get(scope);
    const base = here.length > 0 ? `'${prefix}' (${scope} reference) supports the ${scope}-scoped system stages: ${formatList(here)}.` : `'${prefix}' (${scope} reference) has no diagnostic source stages \u2014 collection diagnostics use '$$', server/cluster diagnostics use '$$$$'.`;
    throw new CodegenError(`'${prefix}.${method}(...)' is not a known diagnostic stage. ${base}${hint}`, refPos);
  }
  if (def.scope !== scope) {
    throw new CodegenError(
      `'${method}' is a ${def.scope}-scoped system stage \u2014 write '${SCOPE_PREFIX[def.scope]}.${method}(...)' (the '${SCOPE_PREFIX[def.scope]}' ${def.scope} reference, run on ${SCOPE_DRIVER[def.scope]}), not '${prefix}'.`,
      refPos
    );
  }
  if (expr.args.length > 1) {
    throw new CodegenError(
      `'${prefix}.${method}(...)' takes ${def.options ? "at most one options object" : "no options"}, but got ${expr.args.length} arguments.`,
      expr.pos
    );
  }
  if (expr.args.length === 0) {
    return { stageName: def.stageName, scope, optionsExpr: null, callPos: expr.pos };
  }
  const arg = expr.args[0];
  if (arg.type === "SpreadElement") {
    throw new CodegenError(`'${prefix}.${method}(...)' does not accept a spread argument.`, arg.argument.pos);
  }
  if (!def.options) {
    throw new CodegenError(`'${prefix}.${method}()' takes no options \u2014 call it with no arguments.`, arg.pos);
  }
  if (arg.type !== "ObjectLiteral") {
    throw new CodegenError(
      `'${prefix}.${method}(...)' expects an options object literal (e.g. \`${prefix}.${method}({ ... })\`), not a ${describeArg(arg)}.`,
      arg.pos
    );
  }
  return { stageName: def.stageName, scope, optionsExpr: arg, callPos: expr.pos };
}
function notFirstStageMessage(call) {
  const prefix = SCOPE_PREFIX[call.scope];
  const method = call.stageName.slice(1);
  return `'${prefix}.${method}(...)' produces the pipeline's source documents (\`${call.stageName}\`), so it must be the first stage. Move it to the front of the pipeline.`;
}
function describeArg(arg) {
  if (arg.type === "NumberLiteral" || arg.type === "StringLiteral" || arg.type === "BooleanLiteral") {
    return `${arg.type.replace(/Literal$/, "").toLowerCase()} literal`;
  }
  if (arg.type === "NullLiteral") return "`null`";
  if (arg.type === "ArrayLiteral") return "array";
  return "non-object expression";
}
function formatList(methods) {
  return methods.map((m) => `.${m}()`).join(", ");
}

// src/pipeline.ts
function isAssertCall(el) {
  return el.type === "CallExpression" && el.callee.type === "ParamRef" && el.callee.name === ASSERT_FN_NAME;
}
var RESHAPE_CLEARING_STAGES = /* @__PURE__ */ new Set(["$group", "$bucket", "$bucketAuto", "$replaceRoot", "$replaceWith", "$facet"]);
function shouldSkipTrailingNamespaceUnset(stages) {
  if (stages.length === 0) return false;
  const last = stages[stages.length - 1];
  if (last === null || typeof last !== "object") return false;
  const keys = Object.keys(last);
  if (keys.length !== 1) return false;
  return RESHAPE_CLEARING_STAGES.has(keys[0]);
}
function isStageCandidate(el) {
  if (el.type === "SpreadElement") return false;
  if (el.type === "AssignExpr" || el.type === "DeleteStmt" || el.type === "LetDecl" || el.type === "FuncDecl") {
    return true;
  }
  if (el.type === "ObjectLiteral") {
    if (el.entries.length === 0) return false;
    const first = el.entries[0];
    if (first.type !== "KeyValueEntry") return false;
    if (first.key.kind !== "static") return false;
    return first.key.name.startsWith("$");
  }
  if (el.type === "OperatorCall") return true;
  if (el.type === "MethodCall" && detectUnionPush(el) !== null) return true;
  if (el.type === "MethodCall" && isSystemStageCall(el)) return true;
  if (isAssertCall(el)) return true;
  return false;
}
function asStageShape(el) {
  if (el.type === "SpreadElement") return null;
  if (el.type === "ObjectLiteral") {
    if (el.entries.length !== 1) return null;
    const entry = el.entries[0];
    if (entry.type !== "KeyValueEntry") return null;
    if (entry.key.kind !== "static") return null;
    if (!lookupStage(entry.key.name)) return null;
    return { name: entry.key.name, body: entry.value };
  }
  if (el.type === "OperatorCall") {
    if (!lookupStage(el.name)) return null;
    if (el.args.length !== 1) return null;
    const arg = el.args[0];
    if (arg.type === "SpreadElement") return null;
    return { name: el.name, body: arg };
  }
  return null;
}
function isPipelineAst(ast) {
  if (ast.type !== "ArrayLiteral") return false;
  if (ast.elements.length === 0) return false;
  return isStageCandidate(ast.elements[0]);
}
function makePipelineValidator(container) {
  let terminal = null;
  return {
    checkBeforeElement(pos) {
      if (terminal !== null) throw makeAfterTerminalError(terminal, pos);
    },
    checkStage(name, pos, userIndex, body) {
      const def = lookupStage(name);
      if (def === void 0) return;
      if (container !== "top" && stageForbiddenIn(def, container)) {
        throw new CodegenError(forbiddenInContextMessage(name, container), pos);
      }
      if (stageMustBeFirst(def) && userIndex > 0) {
        throw new CodegenError(mustBeFirstLiteralMessage(name), pos);
      }
      if (stageMustBeLast(def)) terminal = { stageName: name, pos, viaSugar: false };
      if (name === "$match") {
        validateMatchPlacement(body, { isTopLevel: container === "top", isFirstStage: userIndex === 0 });
      }
    },
    markSugarOut(pos) {
      terminal = { stageName: "$out", pos, viaSugar: true };
    }
  };
}
function makeAfterTerminalError(terminal, afterPos) {
  if (terminal.viaSugar) {
    return new CodegenError(
      `'$out' must be the last stage in a pipeline. Move this statement before the '$$$.<coll> = \u2026' write (at position ${terminal.pos}), or remove it.`,
      afterPos
    );
  }
  return new CodegenError(
    `'${terminal.stageName}' must be the last stage in a pipeline \u2014 nothing can run after it. Move it to the end of the pipeline, or remove the stage(s) that follow it.`,
    afterPos
  );
}
function mustBeFirstLiteralMessage(stageName) {
  return `'${stageName}' must be the first stage in a pipeline \u2014 it produces the pipeline's source documents, so nothing can run before it. Move it to the front, or remove the stage(s) that precede it.`;
}
function forbiddenInContextMessage(stageName, container) {
  const owner = container === "facet" ? "$facet" : container === "lookup" ? "$lookup" : "$unionWith";
  return `'${stageName}' is not allowed inside a '${owner}' sub-pipeline. Move it to the outer (top-level) pipeline.`;
}
function containerKindFor(stageName) {
  if (stageName === "$facet") return "facet";
  if (stageName === "$unionWith") return "unionWith";
  return "lookup";
}
function classifyObjectAssignStmt(node, ctx) {
  if (node.type !== "ObjectCall" || node.method !== "assign") return null;
  const target = node.args.length === 0 ? null : node.args[0];
  if (target !== null && target.type === "ParamRef") {
    const slot = ctx.pipelineLets?.get(target.name);
    if (slot !== void 0) return { kind: "binding", slot, call: node };
    return {
      kind: "reject",
      message: `Cannot 'Object.assign(${target.name}, \u2026)' \u2014 '${target.name}' isn't a 'let'/'const' binding in scope. Declare it first with 'let ${target.name} = \u2026', or write '$.${target.name}' to mutate a document field.`,
      pos: node.pos
    };
  }
  if (target !== null && target.type !== "SpreadElement" && isWritableFieldPath(target)) {
    return { kind: "field", assign: { type: "AssignExpr", target, value: node, pos: node.pos } };
  }
  return {
    kind: "reject",
    message: `'Object.assign(...)' at statement position mutates its first argument, but ${target === null ? "no first argument was given" : "the first argument isn't a writable target"}. Pass a document field ('$.profile') or an in-scope 'let'/'const' binding \u2014 e.g. 'Object.assign($.profile, { \u2026 })' or 'let r = {}; Object.assign(r, { \u2026 })'. (To build a merged object as a value, assign it: '$.merged = Object.assign(a, b)'.)`,
    pos: node.pos
  };
}
function generatePipeline(ast, startCtx = EMPTY_CTX) {
  if (ast.type !== "ArrayLiteral") {
    internalError("generatePipeline expects an ArrayLiteral AST");
  }
  const out = [];
  let updateBuffer = [];
  let ctx = { ...startCtx, pipelineContext: true, topLevelStream: true };
  let everHadLet = false;
  const validator = makePipelineValidator("top");
  const tracking = makeSlotTracking(startCtx.slotAllocator);
  const flushUpdateOps = () => {
    if (updateBuffer.length === 0) return;
    for (const stage of generateUpdateOpGroups(updateBuffer, ctx)) out.push(stage);
    updateBuffer = [];
  };
  let lengthSlotAt = null;
  const ensureStreamLength = () => {
    flushUpdateOps();
    if (lengthSlotAt !== null && out.slice(lengthSlotAt).every(stagePreservesStreamLength)) return;
    out.push(streamLengthStage());
    lengthSlotAt = out.length;
  };
  ast.elements.forEach((rawEl, i) => {
    validator.checkBeforeElement(rawEl.pos);
    if (containsStreamLength(rawEl)) ensureStreamLength();
    let el = rawEl;
    if (el.type === "MethodCall") {
      const rewrite = tryRewriteMutatorCall(el);
      if (rewrite.kind === "rewrite") el = rewrite.assign;
    }
    if (el.type === "ObjectCall") {
      const mut = classifyObjectAssignStmt(el, ctx);
      if (mut !== null) {
        if (mut.kind === "reject") throw new CodegenError(mut.message, mut.pos);
        if (mut.kind === "binding") {
          flushUpdateOps();
          const { stages, rewritten } = extractLookupCalls(mut.call, ctx, tracking.alloc, lowerBlock);
          for (const s of stages) out.push(s);
          out.push({ $set: { [mut.slot]: generateWithCtx(rewritten, ctx) } });
          return;
        }
        el = mut.assign;
      }
    }
    if (el.type === "AssignExpr") {
      const r = tryLowerAssignSugar(el, ctx, out, flushUpdateOps, tracking.alloc, lowerBlock, out.length === 0);
      if (r.handled) {
        ctx = r.ctx;
        if (r.outPos !== null) validator.markSugarOut(r.outPos);
        return;
      }
      updateBuffer.push(r.bufferOp);
      return;
    }
    if (el.type === "DeleteStmt") {
      if (el.target.type === "FieldRef" && el.target.path === "") {
        throw new CodegenError(
          `Cannot 'delete $' \u2014 bare '$' is the whole document. Use '$ = <newDoc>' to replace it, or 'delete $.<field>' to drop a single field.`,
          el.pos
        );
      }
      updateBuffer.push(el);
      return;
    }
    if (el.type === "FuncDecl") {
      flushUpdateOps();
      ctx = lowerFuncDecl(el, ctx);
      return;
    }
    if (el.type === "LetDecl") {
      flushUpdateOps();
      const direct = detectLookupCall(el.value, ctx);
      if (direct !== null) {
        validateLookupShape(el.value);
        const slot = bindingSlot(el.name);
        const stages = lowerLookup(direct, slot, ctx, lowerBlock);
        for (const s of stages) out.push(s);
        ctx = extendCtxLets(ctx, el.name, slot);
        everHadLet = true;
        return;
      }
      const { stages: prologue, rewritten } = extractLookupCalls(el.value, ctx, tracking.alloc, lowerBlock);
      for (const s of prologue) out.push(s);
      const stage = lowerLetDecl({ type: "LetDecl", name: el.name, value: rewritten, kind: el.kind, pos: el.pos }, ctx);
      out.push(stage.set);
      ctx = stage.ctx;
      everHadLet = true;
      return;
    }
    flushUpdateOps();
    ctx = lowerStatementTail(el, i, ctx, out, validator, tracking.alloc, lowerBlock);
  });
  flushUpdateOps();
  if ((everHadLet || tracking.used() || lengthSlotAt !== null) && !shouldSkipTrailingNamespaceUnset(out)) {
    out.push({ $unset: JSMQL_NS });
  }
  return out;
}
function generateImplicitPipeline(p, startCtx = EMPTY_CTX, container = "top") {
  const out = [];
  let ctx = { ...startCtx, pipelineContext: true, topLevelStream: container === "top" };
  let everHadLet = false;
  const validator = makePipelineValidator(container);
  const tracking = makeSlotTracking(startCtx.slotAllocator);
  const handleNames = new Set(ctx.substreamLengthHandles?.keys() ?? []);
  let lengthSlotAt = null;
  const ensureStreamLength = () => {
    if (lengthSlotAt !== null && out.slice(lengthSlotAt).every(stagePreservesStreamLength)) return;
    out.push(streamLengthStage());
    lengthSlotAt = out.length;
  };
  p.stmts.forEach((rawStmt, i) => {
    validator.checkBeforeElement(rawStmt.pos);
    if ((container === "top" || handleNames.size > 0) && containsStreamLength(rawStmt, handleNames)) {
      ensureStreamLength();
    }
    let stmt = rawStmt;
    if (stmt.type === "MethodCall") {
      const rewrite = tryRewriteMutatorCall(stmt);
      if (rewrite.kind === "rewrite") {
        stmt = { type: "UpdateFilter", ops: [rewrite.assign], pos: rewrite.assign.pos };
      }
    }
    if (stmt.type === "FuncDecl") {
      ctx = lowerFuncDecl(stmt, ctx);
      return;
    }
    if (stmt.type === "ObjectCall") {
      const mut = classifyObjectAssignStmt(stmt, ctx);
      if (mut !== null) {
        if (mut.kind === "reject") throw new CodegenError(mut.message, mut.pos);
        if (mut.kind === "binding") {
          const { stages, rewritten } = extractLookupCalls(mut.call, ctx, tracking.alloc, lowerBlock);
          for (const s of stages) out.push(s);
          out.push({ $set: { [mut.slot]: generateWithCtx(rewritten, ctx) } });
          return;
        }
        stmt = { type: "UpdateFilter", ops: [mut.assign], pos: mut.assign.pos };
      }
    }
    if (stmt.type === "LetDecl") {
      const direct = detectLookupCall(stmt.value, ctx);
      if (direct !== null) {
        validateLookupShape(stmt.value);
        const slot = bindingSlot(stmt.name);
        const stages = lowerLookup(direct, slot, ctx, lowerBlock);
        for (const s of stages) out.push(s);
        ctx = extendCtxLets(ctx, stmt.name, slot);
        everHadLet = true;
        return;
      }
      const { stages: prologue, rewritten } = extractLookupCalls(stmt.value, ctx, tracking.alloc, lowerBlock);
      for (const s of prologue) out.push(s);
      const stage = lowerLetDecl(
        { type: "LetDecl", name: stmt.name, value: rewritten, kind: stmt.kind, pos: stmt.pos },
        ctx
      );
      out.push(stage.set);
      ctx = stage.ctx;
      everHadLet = true;
      return;
    }
    if (stmt.type === "UpdateFilter") {
      const result = lowerUpdateFilterWithLookups(stmt, ctx, tracking.alloc, lowerBlock, out.length);
      for (const s of result.stages) out.push(s);
      ctx = result.ctx;
      if (result.terminal !== null) validator.markSugarOut(result.terminal.pos);
      return;
    }
    ctx = lowerStatementTail(stmt, i, ctx, out, validator, tracking.alloc, lowerBlock);
  });
  if ((everHadLet || tracking.used() || lengthSlotAt !== null) && !shouldSkipTrailingNamespaceUnset(out)) {
    out.push({ $unset: JSMQL_NS });
  }
  return out;
}
function lowerFuncDecl(decl, ctx) {
  if (ctx.functions?.has(decl.name)) {
    throw new CodegenError(
      `Function \`${decl.name}\` is already declared earlier in this pipeline. Re-declaration in the same scope is not allowed \u2014 pick a different name.`,
      decl.pos
    );
  }
  if (ctx.pipelineLets?.has(decl.name)) {
    throw new CodegenError(
      `Function \`${decl.name}\` collides with a \`${ctx.pipelineConstNames?.has(decl.name) ? "const" : "let"} ${decl.name}\` binding already in scope. Rename one \u2014 a reusable function and a value binding can't share a name.`,
      decl.pos
    );
  }
  if (ctx.bindings?.has(decl.name)) {
    throw new CodegenError(
      `Function \`${decl.name}\` shadows a function-form parameter binding of the same name. Rename one.`,
      decl.pos
    );
  }
  if (someExpr(decl.lambda, (e) => isStreamLengthNode(e, NO_HANDLES))) {
    throw new CodegenError(
      `'$$.length' isn't supported inside a reusable function body yet [DEF-033]. Read it at the top level of the pipeline (e.g. \`let n = $$.length;\`) and pass the value in as a parameter.`,
      decl.pos
    );
  }
  return extendCtxFunctions(ctx, decl);
}
function lowerLetDecl(decl, ctx) {
  if (ctx.functions?.has(decl.name)) {
    throw new CodegenError(
      `\`${decl.kind} ${decl.name}\` collides with a reusable function \`${decl.name}\` already declared in this pipeline. Rename one \u2014 a value binding and a function can't share a name.`,
      decl.pos
    );
  }
  if (ctx.pipelineLets?.has(decl.name)) {
    throw new CodegenError(
      `\`${decl.kind} ${decl.name}\` is already declared earlier in this pipeline. Re-declaration in the same scope is not allowed \u2014 ${decl.kind === "const" ? "" : "reassign it (`" + decl.name + " = \u2026`), "}pick a different name, or rebind after a reshape stage (\`$group\`, \`$replaceRoot\`, \u2026).`,
      decl.pos
    );
  }
  if (ctx.bindings?.has(decl.name)) {
    throw new CodegenError(
      `\`${decl.kind} ${decl.name}\` shadows a function-form parameter binding of the same name. Rename one \u2014 parameter bindings are compile-time constants supplied at call time, \`${decl.kind}\` bindings are per-document values derived from a stage expression; mixing them under one name would be ambiguous.`,
      decl.pos
    );
  }
  const fieldPath = bindingSlot(decl.name);
  const value = generateWithCtx(decl.value, ctx);
  return {
    set: { $set: { [fieldPath]: value } },
    ctx: extendCtxLets(ctx, decl.name, fieldPath, decl.kind, staticBindingType(decl.value))
  };
}
function isReplaceRootAssign(op) {
  return op.target.type === "FieldRef" && op.target.path === "";
}
function updateFilterHasReplaceRoot(uf) {
  return uf.ops.some((op) => op.type === "AssignExpr" && isReplaceRootAssign(op));
}
function lowerReplaceRoot(el, ctx, allocSlot, lowerBlockFn) {
  if (el.value.type === "BinaryExpr" && el.value.left === el.target) {
    throw new CodegenError(
      `Cannot use compound assignment / increment on bare '$' \u2014 '$' is the whole document, not a scalar. Use '$ = { ...$, ...overrides }' to merge fields into the root or '$ = <newRoot>' to replace it outright.`,
      el.pos
    );
  }
  if (el.value.type === "ArrayLiteral") {
    if (el.value.elements.length === 0) {
      throw new CodegenError(
        `Cannot fan out an empty array \u2014 '$ = []' would discard every document. To drop documents conditionally, fan out a data-dependent array (e.g. '$ = $.items.filter(...)'); to empty the stream, use '$$ = []'.`,
        el.value.pos
      );
    }
    rejectScalarFanOutElements(el.value);
    return lowerFanOut(el.value, ctx, allocSlot, lowerBlockFn);
  }
  rejectNonDocumentReplaceRoot(el.value);
  const direct = detectLookupCall(el.value, ctx);
  if (direct !== null) {
    validateLookupShape(el.value);
    if (direct.method === "filter" || direct.method === "aggregate") {
      throw new CodegenError(
        `Cannot replace root with an array \u2014 '.${direct.method}(...)' returns an array. Use '.find(...)' for a single matching doc, or wrap: '$ = { items: $$$.<coll>.${direct.method}(...) }'.`,
        el.value.pos
      );
    }
    const slot = allocSlot();
    const pred = translatePredicate(direct, ctx, lowerBlockFn);
    const from = requireSameDbColl(direct.db, direct.collection, direct.pos);
    const stages = [];
    if (pred.kind === "basic") {
      stages.push({ $lookup: { from, localField: pred.localField, foreignField: pred.foreignField, as: slot } });
    } else {
      stages.push({ $lookup: pipelineLookupBody(from, pred.letVars, pred.pipeline, slot) });
    }
    stages.push({ $replaceWith: { $first: `$${slot}` } });
    return stages;
  }
  if (staticBindingType(el.value) === "array") {
    return lowerFanOut(el.value, ctx, allocSlot, lowerBlockFn);
  }
  const { stages: prologue, rewritten } = extractLookupCalls(el.value, ctx, allocSlot, lowerBlockFn);
  const out = [...prologue];
  out.push({ $replaceWith: generateWithCtx(rewritten, ctx) });
  return out;
}
function lowerFanOut(arr, ctx, allocSlot, lowerBlockFn) {
  const { stages: prologue, rewritten } = extractLookupCalls(arr, ctx, allocSlot, lowerBlockFn);
  const slot = allocSlot();
  return [
    ...prologue,
    { $set: { [slot]: generateWithCtx(rewritten, ctx) } },
    { $unwind: `$${slot}` },
    { $replaceWith: `$${slot}` }
  ];
}
function rejectScalarFanOutElements(arr) {
  for (const el of arr.elements) {
    const kind = scalarFanOutElementKind(el);
    if (kind !== null) {
      throw new CodegenError(
        `Cannot fan out an array of ${kind} \u2014 each array element becomes a document root, so elements must be documents. Did you mean to wrap them: '$ = [{ value: ... }]'?`,
        el.pos
      );
    }
  }
}
function scalarFanOutElementKind(el) {
  switch (el.type) {
    case "NumberLiteral":
      return "number";
    case "BigIntLiteral":
      return "bigint";
    case "StringLiteral":
    case "TemplateLiteral":
      return "string";
    case "BooleanLiteral":
      return "boolean";
    case "NullLiteral":
      return "null";
    case "RegexLiteral":
      return "regex";
    default:
      return null;
  }
}
function rejectNonDocumentReplaceRoot(value) {
  const literalKind2 = value.type === "NumberLiteral" ? "number" : value.type === "BigIntLiteral" ? "bigint" : value.type === "StringLiteral" ? "string" : value.type === "BooleanLiteral" ? "boolean" : value.type === "NullLiteral" ? "null" : value.type === "RegexLiteral" ? "regex" : null;
  if (literalKind2 !== null) {
    throw new CodegenError(
      `Cannot replace root with a ${literalKind2} \u2014 the new root must be a document. Did you mean to wrap it: '$ = { value: ... }'?`,
      value.pos
    );
  }
}
function isReplaceStreamAssign(op) {
  return op.target.type === "CollectionRef";
}
function lowerReplaceStream(el, outerCtx, lowerBlockFn, allocSlot, isFirstStage) {
  if (el.value.type === "BinaryExpr" && el.value.left === el.target) {
    throw new CodegenError(
      `Cannot use compound assignment / increment on '$$' \u2014 '$$' is the document stream, not a scalar. Use '$$ = $$.filter(<predicate>)' to narrow the stream or '$$ = $$$.<coll>.filter(<predicate>)' to switch source.`,
      el.pos
    );
  }
  const v = el.value;
  const dictBuild = detectDictBuildWrap(v);
  if (dictBuild !== null) {
    return { stages: lowerDictBuildWrap(dictBuild), clearLets: true };
  }
  const reduceWrap = detectReduceWrap(v);
  if (reduceWrap !== null) {
    return { stages: lowerReduceWrap(reduceWrap), clearLets: true };
  }
  const arrayReducer = detectArrayReducerWrap(v);
  if (arrayReducer !== null) {
    return { stages: lowerArrayReducerWrap(arrayReducer, outerCtx, lowerBlockFn), clearLets: true };
  }
  const chain = collectStreamChain(v);
  if (chain.root.type === "CollectionRef" && chain.methods.length > 0) {
    return lowerChainOnStream(chain.methods, outerCtx, lowerBlockFn, allocSlot, v);
  }
  if (chain.methods.length > 0) {
    const target = extractLookupTarget(chain.root, outerCtx);
    if (target !== null) {
      return lowerChainOnCollection(chain.methods, target, outerCtx, lowerBlockFn, allocSlot, v);
    }
  }
  if (v.type === "ArrayLiteral") {
    if (v.elements.length === 0) {
      return { stages: [{ $match: { $expr: false } }], clearLets: false };
    }
    if (isFirstStage) {
      const docs = extractDocumentsLiteral(v);
      if (docs !== null) {
        return { stages: [{ $documents: docs }], clearLets: true };
      }
    } else if (isAllObjectLiteralElements(v)) {
      throw new CodegenError(
        `'$$ = [<docs>]' is only valid as the first stage of a pipeline ('$documents' must be at the head per MongoDB). To append documents to an existing stream, use '$$.push({...}, {...}, \u2026)' instead, which lowers to '$unionWith'.`,
        v.pos
      );
    }
  }
  rejectInvalidReplaceStream(v, outerCtx);
}
function extractDocumentsLiteral(arr) {
  const out = [];
  for (const el of arr.elements) {
    if (el.type !== "ObjectLiteral") return null;
    out.push(generateWithCtx(el, EMPTY_CTX));
  }
  return out;
}
function isAllObjectLiteralElements(arr) {
  for (const el of arr.elements) {
    if (el.type !== "ObjectLiteral") return false;
  }
  return true;
}
function lowerChainOnStream(methods, outerCtx, lowerBlockFn, allocSlot, rhs) {
  const stages = [];
  const clearLets = applyStreamMethods(methods, stages, outerCtx, lowerBlockFn, allocSlot, rhs);
  return { stages, clearLets };
}
function applyStreamMethods(methods, target, ctx, lowerBlockFn, allocSlot, rhs) {
  let clearLets = false;
  const cleanup = [];
  for (let i = 0; i < methods.length; i++) {
    const m = methods[i];
    if (m.method === "filter") {
      target.push(...lowerStreamFilterArg(m, ctx, lowerBlockFn, rhs, i === 0));
      continue;
    }
    if (m.method === "reject") {
      target.push(...lowerStreamReject(m, ctx, lowerBlockFn));
      continue;
    }
    if (m.method === "aggregate") {
      throw new CodegenError(
        `.aggregate(...) runs a sub-pipeline against a FOREIGN collection \u2014 write '$$$.<coll>.aggregate((o) => { ... })' (optionally after '.filter(...)'). To add stages to the CURRENT stream, write them directly (e.g. '$group(...); $sort(...);').`,
        m.pos
      );
    }
    const def = lookupStreamMethod(m.method);
    if (def === null) {
      throw unknownStreamMethod(m, "$$");
    }
    def.validate(m.args, m.pos);
    const result = def.lower(m.args, ctx, m.pos, lowerBlockFn, target, allocSlot, false);
    if (result.replacesPreviousStage) target.pop();
    target.push(...result.stages);
    if (result.cleanupStages) cleanup.push(...result.cleanupStages);
    if (result.clearLets) clearLets = true;
  }
  target.push(...cleanup);
  return clearLets;
}
function lowerStreamFilterArg(m, ctx, lowerBlockFn, rhs, isHead) {
  if (m.args.length === 1 && m.args[0].type === "Lambda") {
    return lowerStreamFilterPredicate(m.args[0], ctx, lowerBlockFn);
  }
  if (m.args.length === 1 && m.args[0].type === "ObjectLiteral") {
    return [{ $match: generateWithCtx(m.args[0], ctx) }];
  }
  if (isHead) rejectInvalidReplaceStream(rhs, ctx);
  throw new CodegenError(
    `.filter(<predicate> | { field: value, \u2026 }) takes a single arrow predicate ('o => \u2026') or a matches-object.`,
    m.pos
  );
}
function lowerStreamReject(m, ctx, lowerBlockFn) {
  if (m.args.length !== 1 || m.args[0].type === "SpreadElement") {
    throw new CodegenError(
      `.reject(<predicate>) takes a single arrow predicate ('o => \u2026'), a matches-object ('{ active: true }'), a field name, or a ["field", value] pair.`,
      m.pos
    );
  }
  const arg = m.args[0];
  let params;
  let body;
  let pos;
  if (arg.type === "Lambda") {
    if (arg.params.length !== 1 || arg.body === void 0) {
      throw new CodegenError(`.reject(<predicate>) takes a single-parameter expression arrow ('o => \u2026').`, arg.pos);
    }
    params = arg.params;
    body = arg.body;
    pos = arg.pos;
  } else {
    const sh = shorthandToLambda(arg, "reject", "jsmqlItem");
    if (sh === null || sh.body === void 0) {
      throw new CodegenError(
        `.reject(<predicate>) takes an arrow ('o => \u2026'), a matches-object ('{ active: true }'), a field name, or a ["field", value] pair.`,
        arg.pos
      );
    }
    params = sh.params;
    body = sh.body;
    pos = sh.pos;
  }
  const negated = { type: "Lambda", params, body: { type: "UnaryExpr", op: "!", operand: body, pos }, pos };
  return lowerStreamFilterPredicate(negated, ctx, lowerBlockFn);
}
function chainHasCorrelatingFilter(methods, outerCtx) {
  for (const m of methods) {
    if (m.method !== "filter" && m.method !== "reject") continue;
    if (m.args.length !== 1 || m.args[0].type === "SpreadElement") continue;
    const arg = m.args[0];
    const lambda = arg.type === "Lambda" ? arg : shorthandToLambda(arg, m.method, "jsmqlItem");
    if (lambda !== null && predicateReferencesOuterDoc(lambda, outerCtx)) return true;
  }
  return false;
}
function lowerChainOnCollection(methods, target, outerCtx, lowerBlockFn, allocSlot, rhs) {
  const collapsingMap = methods.find(isValueCollapsingMap);
  if (collapsingMap !== void 0) {
    throw new CodegenError(
      `'.map(...)' in a '$$ = $$$.<coll>.\u2026' stream must return a DOCUMENT \u2014 the mapped result becomes the new document stream, which can't hold bare scalars/arrays. Reshape into a document with '.map(o => ({ \u2026 }))', or collect the values into a field via assignment: '$.<field> = $$$.<coll>.\u2026map(...)'.`,
      collapsingMap.pos
    );
  }
  if (chainHasCorrelatingFilter(methods, outerCtx)) {
    return lowerLookupPivot(methods, target, outerCtx, lowerBlockFn, allocSlot);
  }
  const switchDesc = target.db !== void 0 ? `$$ = $$$$.${target.db}.${target.collection}` : `$$ = $$$.${target.collection}`;
  const innerCtx = {
    ...freshSubPipelineCtx(outerCtx),
    sourceSwitch: { desc: switchDesc, letNames: new Set(outerCtx.pipelineLets?.keys() ?? []) }
  };
  const inner = [];
  for (let i = 0; i < methods.length; i++) {
    const m = methods[i];
    if (m.method === "filter") {
      inner.push(...lowerStreamFilterArg(m, innerCtx, lowerBlockFn, rhs, i === 0));
      continue;
    }
    if (m.method === "reject") {
      inner.push(...lowerStreamReject(m, innerCtx, lowerBlockFn));
      continue;
    }
    const def = lookupStreamMethod(m.method);
    if (def === null) {
      throw unknownStreamMethod(m, "$$$.<coll>");
    }
    def.validate(m.args, m.pos);
    const result = def.lower(m.args, innerCtx, m.pos, lowerBlockFn, inner, allocSlot, true);
    if (result.replacesPreviousStage) inner.pop();
    inner.push(...result.stages);
  }
  const from = requireSameDbColl(target.db, target.collection, target.pos);
  const stages = [{ $match: { $expr: false } }];
  if (inner.length === 0) {
    if (typeof from === "string") {
      stages.push({ $unionWith: from });
    } else {
      stages.push({ $unionWith: { coll: from } });
    }
  } else {
    stages.push({ $unionWith: { coll: from, pipeline: inner } });
  }
  return { stages, clearLets: true };
}
function lowerLookupPivot(methods, target, outerCtx, lowerBlockFn, allocSlot) {
  for (const m of methods) {
    if (m.method === "filter" || m.method === "reject") continue;
    if (lookupStreamMethod(m.method) === null) throw unknownStreamMethod(m, "$$$.<coll>");
  }
  const slot = allocSlot();
  const from = requireSameDbColl(target.db, target.collection, target.pos);
  let lookupStage2;
  if (methods.length === 1 && methods[0].method === "filter" && methods[0].args.length === 1 && methods[0].args[0].type === "Lambda") {
    const fakeCall = {
      pos: methods[0].pos,
      callPos: methods[0].pos,
      db: target.db,
      collection: target.collection,
      method: "filter",
      lambda: methods[0].args[0]
    };
    const pred = translatePredicate(fakeCall, outerCtx, lowerBlockFn);
    if (pred.kind === "basic") {
      lookupStage2 = { $lookup: { from, localField: pred.localField, foreignField: pred.foreignField, as: slot } };
    } else {
      lookupStage2 = { $lookup: pipelineLookupBody(from, pred.letVars, pred.pipeline, slot) };
    }
  } else {
    const letVars = {};
    const pipelineBody = [];
    const usesRootLen = methods.some((m) => argsReadRootStreamLength(m.args));
    const innerCtx = {
      ...captureRootStreamLength(usesRootLen, 0, letVars, freshSubPipelineCtx(outerCtx)),
      pipelineLets: outerCtx.pipelineLets,
      // "inside a correlated `$lookup`" (depth 0) so a chain `.map` routes through
      // `lowerCallbackBlock` and captures cross-level reads into THIS lookup's `let`.
      enclosingLookup: EMPTY_ENCLOSING
    };
    peelForeignChain(
      methods,
      0,
      methods.length,
      outerCtx,
      lowerBlockFn,
      allocSlot,
      EMPTY_ENCLOSING,
      innerCtx,
      pipelineBody,
      letVars
    );
    lookupStage2 = { $lookup: pipelineLookupBody(from, letVars, pipelineBody, slot) };
  }
  return { stages: [lookupStage2, { $unwind: `$${slot}` }, { $replaceWith: `$${slot}` }], clearLets: true };
}
function unknownStreamMethod(m, receiver) {
  if (m.method === "find" || m.method === "findLast" || m.method === "at") {
    const alt = m.method === "at" ? `'${receiver}.slice(n, n + 1)'` : `'${receiver}.filter(<pred>).slice(0, 1)'`;
    const findHint = receiver === "$$$.<coll>" ? ` (For replacing the current document with a single matched foreign doc, write '$ = $$$.<coll>.find(<pred>)' instead \u2014 that's a separate lookup form.)` : "";
    return new CodegenError(
      `'.${m.method}(...)' is not allowed in a chain on '${receiver}' \u2014 '.${m.method}' returns a single element in JS, but pipelines are arrays. Use ${alt} for the equivalent "first match" / "n-th" shape.${findHint}`,
      m.pos
    );
  }
  if (VALUE_TERMINAL_METHODS.has(m.method)) {
    const single2 = m.method === "head" || m.method === "first" || m.method === "last" || m.method === "nth";
    const streamHint = single2 ? ` For a one-document stream, use '${receiver}.filter(<pred>).take(1)' / '.slice(...)'.` : "";
    return new CodegenError(
      `'.${m.method}(...)' returns a single value, not a stream \u2014 it collapses '${receiver}' to one value, so it's only valid in a VALUE position: 'const x = ${receiver}.${m.method}(...)' or '$.field = ${receiver}.${m.method}(...)', not as a '$$ = \u2026' pivot or a bare statement.${streamHint}`,
      m.pos
    );
  }
  if (m.method === "takeWhile" || m.method === "dropWhile") {
    return new CodegenError(
      `'.${m.method}(...)' as a stream method is not yet supported [DEF-034] \u2014 it needs a running flag ($setWindowFields) over an ordered stream. Use it value-mode on an array (e.g. a materialised lookup result: 'const xs = $$$.<coll>.filter(...); xs.${m.method}(...)'), or approximate with '.sort(...)' + '.filter(<pred>)'.`,
      m.pos
    );
  }
  if (m.method === "reduce") {
    return new CodegenError(
      `'.reduce(...)' is not a chain method on '${receiver}' \u2014 in JS '.reduce' collapses an array to a single value, but '${receiver}' must stay a stream of documents. Wrap the reduce result into a stream-shaped RHS:
  \u2022 Scalar reducer:  '$$ = [{ <key>: $$.reduce((acc, d) => \u2026, <literal-init>) }];' \u2014 each entry becomes a '$group' accumulator; output is a single-doc stream of your named keys.
  \u2022 Object reducer:  '$$ = [$$.reduce((acc, d) => ({ ...acc, <key1>: <expr1>, <key2>: <expr2> }), { <key1>: <init1>, <key2>: <init2> })];' \u2014 same MQL output as the scalar form, keyed accumulators declared inline.
  \u2022 Array reducer:   '$$ = $$.reduce((acc, d) => (<cond> ? acc.concat(d.<field>) : acc), []);' \u2014 a '[]'-seeded reducer already returns a stream, so assign it directly (no '[ ]'); lowers to '$match' (when the body is a ternary) + '$replaceWith: "$<field>"'. Each input doc that passes <cond> becomes its <field> sub-doc.
Pick the wrap shape that matches what your reducer would return in plain JS.`,
      m.pos
    );
  }
  const names = streamMethodNames();
  const isStream = receiver === "$$";
  const hint = didYouMean(m.method, isStream ? ["filter", "push", ...names] : ["filter", ...names], (s) => `.${s}`);
  const list = names.length > 0 ? names.map((n) => `.${n}`).join(", ") : "(none yet)";
  const pushNote = isStream ? ` ('.push(...)' appends documents as a statement \u2192 $unionWith.)` : "";
  return new CodegenError(
    `'.${m.method}(...)' is not a chainable stream method on '${receiver}'.${hint} Chainable methods \u2014 any may head OR extend the chain: '.filter', '.reject', ${list}.${pushNote}`,
    m.pos
  );
}
function lowerArrayReducerWrap(wrap, outerCtx, lowerBlockFn) {
  const stages = [];
  if (wrap.condition !== null) {
    const fakeLambda = { type: "Lambda", params: [wrap.dParam], body: wrap.condition, pos: wrap.lambdaPos };
    stages.push(...lowerStreamFilterPredicate(fakeLambda, outerCtx, lowerBlockFn));
  }
  if (wrap.project.kind === "field") {
    stages.push({ $replaceWith: `$${wrap.project.path}` });
  }
  return stages;
}
function lowerStreamFilterPredicate(lambda, predicateCtx, lowerBlockFn) {
  if (lambda.params.length !== 1) {
    throw new CodegenError(
      `'.filter(<predicate>)' on the RHS of '$$ = \u2026' must take exactly one parameter \u2014 write '.filter(o => \u2026)' (the param name is your choice). The param represents each document.`,
      lambda.pos
    );
  }
  return lowerLambdaPredicate(lambda, predicateCtx, lowerBlockFn, {
    freshCtx: (ctx) => ctx,
    onLocalRef: rejectLocalRefInStreamFilter,
    missingBody: () => {
      throw new CodegenError(
        `'.filter(<predicate>)' predicate has a block body with local \`const\`/\`let\` bindings, which isn't supported in this position. Write the predicate as a single expression \u2014 \`function (x) { return <expr> }\` / \`(x) => <expr>\` \u2014 and fold any bindings into <expr>.`,
        lambda.pos
      );
    }
  });
}
function rejectLocalRefInStreamFilter(letVars, param, pos) {
  const sample = Object.values(letVars)[0];
  const samplePath = sample.replace(/^\$+/, "");
  throw new CodegenError(
    `'$.<field>' inside the '.filter(<predicate>)' of '$$ = \u2026' is not supported \u2014 use the lambda parameter (e.g. '${param}.${samplePath}') to reference each document. Inside this filter, the lambda parameter IS the document being matched.`,
    pos
  );
}
function rejectInvalidReplaceStream(value, ctx) {
  if (value.type === "ArrayLiteral") {
    throw new CodegenError(
      `'$$ = [<expr>]' didn't match any supported wrap pattern. Recognised shapes: '$$ = [{ <key>: $$.reduce(\u2026, <literal-init>), \u2026 }]' (scalar accumulators \u2192 '$group' + '$replaceWith'), '$$ = [$$.reduce((acc, d) => ({ ...acc, <key>: <expr>, \u2026 }), { <key>: <init>, \u2026 })]' (object-returning reducer, same lowering), '$$ = [$$.reduce((acc, d) => ({ ...acc, [d.<k>]: <expr>, \u2026 }), {})]' (dict-build reducer \u2192 '$group' + '$arrayToObject'), or '$$ = [$$.reduce((acc, d) => (<cond> ? acc.concat(d.<field>) : acc), [])]' (array-returning reducer \u2192 '$match' + '$replaceWith'). For a literal-doc seeder at stage 0, use '$$ = [{...}, {...}]' (lowers to '$documents'). To append docs mid-pipeline, use '$$.push({...}, {...}, \u2026)'.`,
      value.pos
    );
  }
  if (value.type === "TernaryExpr") {
    throw new CodegenError(
      `'$$ = <ternary>' (conditional stream branching) is not a supported form \u2014 a stream has no single condition that swaps the whole stream for A or B. The RHS of '$$ = \u2026' must be '$$.filter(<predicate>)' (narrow the current stream) or '$$$.<coll>.filter(<predicate>)' (switch source to another collection).`,
      value.pos
    );
  }
  if (value.type === "MethodCall") {
    const onCollection = value.object.type === "CollectionRef";
    const onDatabase = extractLookupTarget(value.object, ctx) !== null;
    if (onCollection || onDatabase) {
      const hint = didYouMean(value.method, ["filter"], (s) => `.${s}`);
      const recv = onCollection ? "$$" : "$$$.<coll>";
      const intent = onCollection ? "narrow the current stream" : "switch source to another collection";
      throw new CodegenError(
        `'$$ = \u2026' RHS supports only '${recv}.filter(<predicate>)' \u2014 '.${value.method}(...)' is not allowed here.${hint} Use '${recv}.filter(<predicate>)' to ${intent}, or write '$ = $$$.<coll>.find(<predicate>)' if you meant to replace each document with a single matching foreign doc.`,
        value.pos
      );
    }
  }
  if (value.type === "CollectionRef" || value.type === "DatabaseRef") {
    throw new CodegenError(
      `'$$ = \u2026' RHS must call a stream method. Write '$$.filter(o => \u2026)' to narrow the current stream or '$$$.<coll>.filter(o => \u2026)' to switch source. Any lodash stream method may head the chain (e.g. '$$$.<coll>.toSorted(...).take(...)'), not only '.filter'.`,
      value.pos
    );
  }
  throw new CodegenError(
    `'$$ = \u2026' RHS must be '$$.<streamMethod>\u2026' (narrow/transform the current stream) or '$$$.<coll>.<streamMethod>\u2026' (switch source to another collection). Any lodash stream method may head the chain (e.g. '.filter', '.toSorted', '.take'); a '.filter'/'.reject' correlating on '$.<field>' promotes a source switch to a per-outer-doc '$lookup'.`,
    value.pos
  );
}
function lowerSystemStageStmt(call, ctx) {
  const body = call.optionsExpr === null ? {} : generateStageBody(call.stageName, call.optionsExpr, ctx);
  return { [call.stageName]: body };
}
function lowerStageElement(el, index, ctx) {
  const stage = asStageShape(el);
  if (!stage) {
    const pos = el.pos ?? 0;
    throw new CodegenError(formatNotAStageError(el, index), pos);
  }
  const body = generateStageBody(stage.name, stage.body, ctx);
  const nextCtx = RESHAPE_CLEARING_STAGES.has(stage.name) ? clearCtxLets(ctx, stage.name) : ctx;
  return { stage: { [stage.name]: body }, ctx: nextCtx };
}
function generateStageBody(stageName, body, ctx) {
  validateStageBody(stageName, body);
  if (stageName === "$match") {
    if (body.type === "ObjectLiteral") {
      return generateBodyObject(body, stageName, ctx);
    }
    const t = translateMatchBody(body, { bindings: ctx.bindings });
    return mergeTranslatedQuery(t, ctx) ?? {};
  }
  if (stageName === "$unwind") {
    if (body.type === "ObjectLiteral") return generateBodyObject(body, stageName, ctx);
    return generateWithCtx(body, ctx);
  }
  const aggCtx = { ...ctx, aggExpr: true };
  if (body.type === "ObjectLiteral") {
    return generateBodyObject(body, stageName, aggCtx);
  }
  return generateWithCtx(body, aggCtx);
}
function generateBodyObject(body, stageName, ctx) {
  const stage = lookupStage(stageName);
  const allValuesArePipelines = stage.subPipelineFields.includes("*");
  const pipelineSlot = new Set(stage.subPipelineFields);
  const out = {};
  for (const entry of body.entries) {
    if (entry.type !== "KeyValueEntry") {
      throw new CodegenError(`Spread entries are not allowed in ${stageName} body`, entry.pos);
    }
    if (entry.key.kind !== "static") {
      throw new CodegenError(`Computed keys are not allowed in ${stageName} body`, entry.pos);
    }
    const key = entry.key.name;
    const isPipelineSlot = allValuesArePipelines || pipelineSlot.has(key);
    if (isPipelineSlot && isPipelineAst(entry.value)) {
      out[key] = generatePipelineWithCtx(entry.value, freshSubPipelineCtx(ctx), containerKindFor(stageName));
      continue;
    }
    const nestedScope = NESTED_ACCUMULATOR_OUTPUT[stageName];
    if (nestedScope !== void 0 && key === "output" && entry.value.type === "ObjectLiteral") {
      out[key] = generateNestedAccumulatorObject(entry.value, ctx, nestedScope);
      continue;
    }
    const slotCtx = accumulatorCtxFor(stageName, key, ctx);
    out[key] = generateWithCtx(entry.value, slotCtx);
  }
  return out;
}
var NESTED_ACCUMULATOR_OUTPUT = {
  $bucket: "group",
  $bucketAuto: "group",
  $setWindowFields: "window-output"
};
function accumulatorCtxFor(stageName, key, ctx) {
  if (stageName === "$group" && key !== "_id") {
    return { ...ctx, accumulatorContext: "group" };
  }
  return ctx;
}
function generateNestedAccumulatorObject(body, ctx, scope) {
  const scopedCtx = { ...ctx, accumulatorContext: scope };
  const out = {};
  for (const entry of body.entries) {
    if (entry.type !== "KeyValueEntry") {
      throw new CodegenError(`Spread entries are not allowed in an accumulator-output object`, entry.pos);
    }
    if (entry.key.kind !== "static") {
      throw new CodegenError(`Computed keys are not allowed in an accumulator-output object`, entry.pos);
    }
    out[entry.key.name] = generateWithCtx(entry.value, scopedCtx);
  }
  return out;
}
function generatePipelineWithCtx(ast, startCtx, container) {
  if (ast.type !== "ArrayLiteral") {
    internalError("generatePipelineWithCtx expects an ArrayLiteral AST");
  }
  for (const el of ast.elements) {
    if (el.type !== "SpreadElement") {
      const innerPush = el.type === "AssignExpr" || el.type === "DeleteStmt" || el.type === "LetDecl" || el.type === "FuncDecl" ? null : detectUnionPush(el);
      if (innerPush !== null) {
        throw new CodegenError(
          `'$$.push(...)' inside a sub-pipeline ('$lookup.pipeline', '$unionWith.pipeline', '$facet.*') is not supported \u2014 $$.push emits '$unionWith' stages against the current (outer) collection. Hoist the push to a sibling stage in the outer pipeline.`,
          innerPush.pos
        );
      }
    }
  }
  const out = [];
  let updateBuffer = [];
  let ctx = { ...startCtx, pipelineContext: true };
  let everHadLet = ctxHasLets(startCtx);
  const validator = makePipelineValidator(container);
  const flushUpdateOps = () => {
    if (updateBuffer.length === 0) return;
    for (const stage of generateUpdateOpGroups(updateBuffer, ctx)) out.push(stage);
    updateBuffer = [];
  };
  ast.elements.forEach((el, i) => {
    validator.checkBeforeElement(el.pos);
    if (el.type === "AssignExpr" || el.type === "DeleteStmt") {
      updateBuffer.push(el);
      return;
    }
    if (el.type === "FuncDecl") {
      flushUpdateOps();
      ctx = lowerFuncDecl(el, ctx);
      return;
    }
    if (el.type === "LetDecl") {
      flushUpdateOps();
      const stage = lowerLetDecl(el, ctx);
      out.push(stage.set);
      ctx = stage.ctx;
      everHadLet = true;
      return;
    }
    flushUpdateOps();
    const shape = asStageShape(el);
    if (shape !== null) validator.checkStage(shape.name, el.pos, i, shape.body);
    const result = lowerStageElement(el, i, ctx);
    out.push(result.stage);
    ctx = result.ctx;
  });
  flushUpdateOps();
  if (everHadLet && !shouldSkipTrailingNamespaceUnset(out)) out.push({ $unset: JSMQL_NS });
  return out;
}
function formatNotAStageError(el, index) {
  if (el.type !== "SpreadElement") {
    if (el.type === "ObjectLiteral") {
      if (el.entries.length === 1) {
        const entry = el.entries[0];
        if (entry.type === "KeyValueEntry" && entry.key.kind === "static") {
          const name = entry.key.name;
          if (!lookupStage(name)) {
            return formatUnknownStage(name, index);
          }
        }
      } else if (el.entries.length > 1) {
        return `Element ${index} of pipeline must be a single-key stage object (e.g. \`{ $match: ... }\`), but found an object with ${el.entries.length} keys.`;
      }
    }
    if (el.type === "OperatorCall" && !lookupStage(el.name)) {
      return formatUnknownStage(el.name, index);
    }
    if (looksLikePredicate(el)) {
      return `Element ${index} of pipeline is not a stage call. To filter documents on a predicate, wrap it as \`$match(...)\` \u2014 e.g. \`$match($.age > 18)\`. Pipeline statements must be stage calls; available stages: ${formatStageList()}.`;
    }
    if (el.type === "MethodCall" && VALUE_TERMINAL_METHODS.has(el.method)) {
      return `Element ${index} of pipeline is '.${el.method}(...)', which returns a single value, not a pipeline stage. Assign it to a field or a binding \u2014 '$.field = <expr>' or 'const x = <expr>'.`;
    }
  }
  return `Element ${index} of pipeline is not a recognised stage. Expected \`{ $stage: ... }\` or \`$stage(...)\` where $stage is one of: ${formatStageList()}.`;
}
function looksLikePredicate(el) {
  if (el.type === "BinaryExpr") {
    const op = el.op;
    return op === "===" || op === "==" || op === "!==" || op === "!=" || op === "<" || op === "<=" || op === ">" || op === ">=" || op === "&&" || op === "||";
  }
  if (el.type === "UnaryExpr" && el.op === "!") return true;
  return false;
}
function formatUnknownStage(name, index) {
  const suffix = didYouMean(name, Object.keys(STAGES), (s) => s);
  return `Element ${index} of pipeline: '${name}' is not a known aggregation stage.${suffix}`;
}
function formatStageList() {
  const all = Object.keys(STAGES).sort();
  const head = all.slice(0, 12).join(", ");
  return `${head}, \u2026 (${all.length} total)`;
}
var lowerBlock = (block, ctx) => {
  for (const stmt of block.stmts) {
    const innerPush = stmt.type === "LetDecl" || stmt.type === "FuncDecl" || stmt.type === "UpdateFilter" ? null : detectUnionPush(stmt);
    if (innerPush !== null) {
      throw new CodegenError(
        `'$$.push(...)' inside a lookup's block-body lambda is not supported \u2014 $$.push appends documents to the outer collection's stream via '$unionWith', but the stages would land inside '$lookup.pipeline'. Hoist the push to a sibling stage in the outer pipeline.`,
        innerPush.pos
      );
    }
  }
  return generateImplicitPipeline(block, ctx);
};
function makeSlotTracking(external) {
  const base = external ?? createSlotAllocator();
  let touched = false;
  return {
    alloc: () => {
      touched = true;
      return base();
    },
    used: () => touched
  };
}
function tryLowerAssignSugar(op, ctx, out, flush, allocSlot, lowerBlockFn, isFirst) {
  if (op.target.type === "ParamRef") {
    const name = op.target.name;
    if (ctx.pipelineConstNames?.has(name)) {
      throw new CodegenError(
        `Cannot reassign \`${name}\` \u2014 it is a \`const\` binding. Declare it with \`let ${name} = \u2026\` instead if its value needs to change.`,
        op.pos
      );
    }
    const letPath = ctx.pipelineLets?.get(name);
    if (letPath !== void 0) {
      flush();
      const { stages: stages2, rewritten: rewritten2 } = extractLookupCalls(op.value, ctx, allocSlot, lowerBlockFn);
      for (const s of stages2) out.push(s);
      out.push({ $set: { [letPath]: generateWithCtx(rewritten2, ctx) } });
      return { handled: true, ctx, outPos: null };
    }
    const droppedBy = ctx.droppedLets?.get(name);
    if (droppedBy !== void 0) {
      throw new CodegenError(
        `\`${name}\` is a \`let\` binding and can't be reassigned after \`${droppedBy}\` \u2014 the stage replaces the document. Rebind it after the stage with \`let ${name} = \u2026\`.`,
        op.pos
      );
    }
    throw new CodegenError(
      `Cannot assign to bare identifier '${name}' \u2014 it isn't a \`let\` binding in scope. Declare it first with \`let ${name} = \u2026\`, or write \`$.${name} = \u2026\` to set a document field.`,
      op.pos
    );
  }
  if (isReplaceStreamAssign(op)) {
    flush();
    const result = lowerReplaceStream(op, ctx, lowerBlockFn, allocSlot, isFirst);
    for (const s of result.stages) out.push(s);
    return { handled: true, ctx: result.clearLets ? clearCtxLets(ctx, "$unionWith") : ctx, outPos: null };
  }
  if (isReplaceRootAssign(op)) {
    const facets = detectFacetShape(op.value);
    if (facets !== null) {
      flush();
      for (const s of lowerFacet(facets, ctx, lowerBlockFn)) out.push(s);
      return { handled: true, ctx: clearCtxLets(ctx, "$facet"), outPos: null };
    }
    flush();
    for (const s of lowerReplaceRoot(op, ctx, allocSlot, lowerBlockFn)) out.push(s);
    return { handled: true, ctx: clearCtxLets(ctx, "$replaceWith"), outPos: null };
  }
  const outTarget = detectOutAssign(op, ctx);
  if (outTarget !== null) {
    flush();
    for (const s of lowerOut(op, outTarget, ctx, lowerBlockFn, allocSlot)) out.push(s);
    return { handled: true, ctx, outPos: op.pos };
  }
  const direct = detectLookupCall(op.value, ctx);
  if (direct !== null) {
    validateLookupShape(op.value);
    flush();
    const asPath = updateOpWritePath(op);
    for (const s of lowerLookup(direct, asPath, ctx, lowerBlockFn)) out.push(s);
    return { handled: true, ctx, outPos: null };
  }
  const { stages, rewritten } = extractLookupCalls(op.value, ctx, allocSlot, lowerBlockFn);
  if (stages.length > 0) {
    flush();
    for (const s of stages) out.push(s);
  }
  return { handled: false, bufferOp: { type: "AssignExpr", target: op.target, value: rewritten, pos: op.pos } };
}
function lowerStatementTail(el, i, ctx, out, validator, allocSlot, lowerBlockFn) {
  if (el.type !== "SpreadElement") {
    if (isAssertCall(el) && !ctx.functions?.has(ASSERT_FN_NAME)) {
      out.push({ $match: { $expr: generateAssertGuardExpr(el.args, ctx, el.pos) } });
      return ctx;
    }
    const pushCall = detectUnionPush(el);
    if (pushCall !== null) {
      for (const s of lowerUnionPush(pushCall, ctx, lowerBlockFn)) out.push(s);
      return ctx;
    }
    if (el.type === "MethodCall" && isSystemStageCall(el)) {
      const sys = resolveSystemStageCall(el);
      if (out.length > 0) throw new CodegenError(notFirstStageMessage(sys), sys.callPos);
      out.push(lowerSystemStageStmt(sys, ctx));
      return ctx;
    }
    const streamChain = collectStreamChain(el);
    if (streamChain.root.type === "CollectionRef" && streamChain.methods.length > 0) {
      const clearLets = applyStreamMethods(
        streamChain.methods,
        out,
        ctx,
        lowerBlockFn,
        allocSlot,
        el
      );
      return clearLets ? clearCtxLets(ctx, "$unionWith") : ctx;
    }
  }
  const rewrittenEl = extractFromStageElement(el, ctx, allocSlot, lowerBlockFn, out);
  const shape = asStageShape(rewrittenEl);
  if (shape !== null) validator.checkStage(shape.name, rewrittenEl.pos ?? el.pos, i, shape.body);
  const result = lowerStageElement(rewrittenEl, i, ctx);
  out.push(result.stage);
  return result.ctx;
}
function lowerUpdateFilterWithLookups(stmt, startCtx, allocSlot, lowerBlockFn, globalStageIndex = 0) {
  const out = [];
  let buffer = [];
  let ctx = startCtx;
  let terminal = null;
  const flush = () => {
    if (buffer.length === 0) return;
    for (const stage of generateUpdateOpGroups(buffer, ctx)) out.push(stage);
    buffer = [];
  };
  for (const op of stmt.ops) {
    if (terminal !== null) throw makeAfterTerminalError(terminal, op.pos);
    if (op.type === "AssignExpr") {
      const r = tryLowerAssignSugar(op, ctx, out, flush, allocSlot, lowerBlockFn, globalStageIndex + out.length === 0);
      if (r.handled) {
        ctx = r.ctx;
        if (r.outPos !== null) terminal = { stageName: "$out", pos: r.outPos, viaSugar: true };
        continue;
      }
      buffer.push(r.bufferOp);
      continue;
    }
    if (op.target.type === "FieldRef" && op.target.path === "") {
      throw new CodegenError(
        `Cannot 'delete $' \u2014 bare '$' is the whole document. Use '$ = <newDoc>' to replace it, or 'delete $.<field>' to drop a single field.`,
        op.pos
      );
    }
    buffer.push(op);
  }
  flush();
  return { stages: out, ctx, terminal };
}
function extractFromStageElement(el, ctx, allocSlot, lowerBlockFn, out) {
  if (el.type === "OperatorCall") {
    const args = el.args.map((arg) => {
      if (arg.type === "SpreadElement") {
        const { stages: stages2, rewritten: rewritten2 } = extractLookupCalls(arg.argument, ctx, allocSlot, lowerBlockFn);
        for (const s of stages2) out.push(s);
        return { type: "SpreadElement", argument: rewritten2, pos: arg.pos };
      }
      const { stages, rewritten } = extractLookupCalls(arg, ctx, allocSlot, lowerBlockFn);
      for (const s of stages) out.push(s);
      return rewritten;
    });
    return { type: "OperatorCall", name: el.name, style: el.style, args, pos: el.pos };
  }
  if (el.type === "ObjectLiteral") {
    const entries = el.entries.map((entry) => {
      if (entry.type === "SpreadElement") {
        const { stages: stages2, rewritten: rewritten2 } = extractLookupCalls(entry.argument, ctx, allocSlot, lowerBlockFn);
        for (const s of stages2) out.push(s);
        return { type: "SpreadElement", argument: rewritten2, pos: entry.pos };
      }
      const { stages, rewritten } = extractLookupCalls(entry.value, ctx, allocSlot, lowerBlockFn);
      for (const s of stages) out.push(s);
      return { type: "KeyValueEntry", key: entry.key, value: rewritten, pos: entry.pos };
    });
    return { type: "ObjectLiteral", entries, pos: el.pos };
  }
  return el;
}
var NO_HANDLES = /* @__PURE__ */ new Set();
function isStreamLengthNode(e, handleNames) {
  if (e.type !== "MemberAccess" || e.member !== "length") return false;
  if (e.object.type === "CollectionRef") return true;
  return e.object.type === "ParamRef" && handleNames.has(e.object.name);
}
function containsStreamLength(node, handleNames = NO_HANDLES) {
  const pred = (e) => isStreamLengthNode(e, handleNames);
  return node.type === "UpdateFilter" ? someStmt(node, pred) : someElement(node, pred);
}
var STREAM_LENGTH_PRESERVING = /* @__PURE__ */ new Set(["$set", "$addFields", "$sort", "$lookup", "$setWindowFields"]);
function stagePreservesStreamLength(stage) {
  if (stage === null || typeof stage !== "object") return false;
  const keys = Object.keys(stage);
  return keys.length === 1 && STREAM_LENGTH_PRESERVING.has(keys[0]);
}

// src/const-fold.ts
function foldedValueType(v) {
  if (typeof v === "string") return "string";
  if (Array.isArray(v)) return "array";
  if (v !== null && typeof v === "object" && !isOpaqueBsonValue(v)) return "object";
  return void 0;
}
function isExprStmt(stmt) {
  return stmt.type !== "UpdateFilter" && stmt.type !== "LetDecl" && stmt.type !== "FuncDecl";
}
function collectExcluded(stmts, ctx) {
  const declCounts = /* @__PURE__ */ new Map();
  const excluded = /* @__PURE__ */ new Set();
  for (const stmt of stmts) {
    if (stmt.type === "LetDecl" || stmt.type === "FuncDecl") {
      declCounts.set(stmt.name, (declCounts.get(stmt.name) ?? 0) + 1);
    } else if (stmt.type === "UpdateFilter") {
      for (const op of stmt.ops) {
        if (op.type === "AssignExpr" && op.target.type === "ParamRef") excluded.add(op.target.name);
      }
    } else if (stmt.type === "ObjectCall" && stmt.method === "assign") {
      const target = stmt.args[0];
      if (target && target.type === "ParamRef") excluded.add(target.name);
    } else if (stmt.type === "MethodCall" && MUTATING_ARRAY_METHODS.has(stmt.method) && stmt.object.type === "ParamRef") {
      excluded.add(stmt.object.name);
    }
  }
  for (const [name, count] of declCounts) {
    if (count > 1) excluded.add(name);
  }
  if (ctx.bindings) {
    for (const name of ctx.bindings.keys()) excluded.add(name);
  }
  return excluded;
}
function foldProgram(ast, ctx) {
  if (ast.type !== "Pipeline") return { ast, ctx };
  const excluded = collectExcluded(ast.stmts, ctx);
  const folded = /* @__PURE__ */ new Map();
  const survivors = [];
  for (const stmt of ast.stmts) {
    if (stmt.type === "LetDecl" && !excluded.has(stmt.name)) {
      const r = evalConst(stmt.value, folded, ctx);
      if (r.ok) {
        folded.set(stmt.name, r.value);
        continue;
      }
    }
    survivors.push(stmt);
  }
  if (folded.size === 0) return { ast, ctx };
  const merged = new Map(ctx.bindings ?? []);
  const mergedTypes = new Map(ctx.bindingTypes ?? []);
  for (const [name, value] of folded) {
    merged.set(name, value);
    const t = foldedValueType(value);
    if (t) mergedTypes.set(name, t);
  }
  let ctx2 = withBindings(ctx, merged);
  if (mergedTypes.size > 0) ctx2 = { ...ctx2, bindingTypes: mergedTypes };
  if (survivors.length === 0) {
    const last = ast.stmts[ast.stmts.length - 1];
    throw new CodegenError(
      "A `const`/`let` declaration on its own produces no query \u2014 nothing reads the constant. Add a statement that uses it (a predicate, or a stage like `$match(...)`), or remove the declaration.",
      last.pos
    );
  }
  if (survivors.length === 1 && isExprStmt(survivors[0])) {
    return { ast: survivors[0], ctx: ctx2 };
  }
  return { ast: { type: "Pipeline", stmts: survivors, pos: ast.pos }, ctx: ctx2 };
}

// src/index.ts
var JsmqlInterpolationError = class extends Error {
  constructor(message, slot, key) {
    super(message);
    this.name = "JsmqlInterpolationError";
    this.slot = slot;
    this.key = key;
  }
};
function isTemplateStringsArray(x) {
  return Array.isArray(x) && Array.isArray(x.raw);
}
function fnSource(fn) {
  return Function.prototype.toString.call(fn).trim();
}
function withFunctionInput(src, body) {
  try {
    return body(new Parser(src).parseFunctionInput());
  } catch (err) {
    throw augmentForFunctionInput(err);
  }
}
function dispatchInput(input, values, apiName, lower) {
  if (isTemplateStringsArray(input)) {
    let src = "";
    const routedBindings = /* @__PURE__ */ new Map();
    for (let i = 0; i < input.length; i++) {
      src += input[i];
      if (i < values.length) {
        src += stringifyInterpolation(values[i], i + 1, routedBindings);
      }
    }
    const ctx = routedBindings.size > 0 ? withBindings(EMPTY_CTX, routedBindings) : EMPTY_CTX;
    return lower(new Parser(src).parse(), ctx);
  }
  if (typeof input === "function") {
    return withFunctionInput(fnSource(input), ({ program, bindings }) => {
      if (bindings.length > 0) {
        throw new FunctionInputError(
          `${apiName}() in its one-shot form does not accept a parameter-bindings destructure. Use \`jsmql.compile(fn)(params)\` to supply values to a parameterised query, or remove the destructure pattern from the arrow's first slot.`
        );
      }
      return lower(program, EMPTY_CTX);
    });
  }
  if (typeof input === "string") {
    return lower(new Parser(input).parse(), EMPTY_CTX);
  }
  const ty = input === null ? "null" : typeof input;
  throw new TypeError(`${apiName}() expects a string, an arrow function, or a template literal \u2014 got ${ty}.`);
}
function jsmqlDispatch(input, ...values) {
  return dispatchInput(input, values, "jsmql", lowerWithCtx);
}
function exprDispatch(input, ...values) {
  return dispatchInput(input, values, "jsmql.expr", lowerExprWithCtx);
}
function filterDispatch(input, ...values) {
  return dispatchInput(input, values, "jsmql.filter", lowerFilterStrict);
}
function pipelineDispatch(input, ...values) {
  return dispatchInput(input, values, "jsmql.pipeline", lowerPipelineStrict);
}
function updateDispatch(input, ...values) {
  return dispatchInput(input, values, "jsmql.update", lowerUpdateStrict);
}
function makeCompile(lower, apiName) {
  function compile(input) {
    let src;
    if (typeof input === "function") {
      src = fnSource(input);
    } else if (typeof input === "string") {
      src = input.trim();
    } else {
      const ty = input === null ? "null" : typeof input;
      throw new TypeError(`${apiName}() expects an arrow function or a string containing one \u2014 got ${ty}.`);
    }
    const { program, bindings } = withFunctionInput(src, (r) => r);
    return (params) => {
      const resolved = /* @__PURE__ */ new Map();
      for (const b of bindings) {
        if (!Object.prototype.hasOwnProperty.call(params, b.key)) {
          const expected = b.key === b.name ? b.key : `${b.key}' (bound to '${b.name}' in the function body)`;
          throw new UnknownIdentifierError(expected);
        }
        const value = params[b.key];
        validateInterpolatable(value, 0, b.key);
        resolved.set(b.name, value);
      }
      const ctx = withBindings(EMPTY_CTX, resolved);
      return lower(program, ctx);
    };
  }
  return compile;
}
var compileFunction = makeCompile(lowerWithCtx, "jsmql.compile");
function validateInput(input, ...values) {
  try {
    if (isTemplateStringsArray(input)) {
      jsmql(input, ...values);
    } else if (typeof input === "function") {
      validateCompileForm(fnSource(input));
    } else if (typeof input === "string" && isCompileFormArrow(input)) {
      validateCompileForm(input);
    } else {
      jsmql(input);
    }
    return { valid: true, errors: [] };
  } catch (err) {
    return errorToValidationResult(err);
  }
}
function validateCompileForm(src) {
  withFunctionInput(src, ({ program, bindings }) => {
    const resolved = /* @__PURE__ */ new Map();
    for (const b of bindings) resolved.set(b.name, null);
    lowerWithCtx(program, withBindings(EMPTY_CTX, resolved));
  });
}
function isCompileFormArrow(src) {
  let lex;
  try {
    lex = new Lexer(src);
  } catch {
    return false;
  }
  const first = lex.next();
  if (first.type === TokenType.Ident && first.value === "async") return true;
  if (first.type === TokenType.Ident && first.value === "function") return functionSpansWholeInput(lex);
  if (first.type !== TokenType.LParen) return false;
  let depth = 1;
  while (depth > 0) {
    const t = lex.next();
    if (t.type === TokenType.EOF) return false;
    if (t.type === TokenType.LParen) depth++;
    else if (t.type === TokenType.RParen) depth--;
  }
  return lex.next().type === TokenType.Arrow;
}
function functionSpansWholeInput(lex) {
  let t = lex.next();
  if (t.type === TokenType.Ident) t = lex.next();
  if (t.type !== TokenType.LParen) return false;
  let depth = 1;
  while (depth > 0) {
    const x = lex.next();
    if (x.type === TokenType.EOF) return false;
    if (x.type === TokenType.LParen) depth++;
    else if (x.type === TokenType.RParen) depth--;
  }
  if (lex.next().type !== TokenType.LBrace) return false;
  depth = 1;
  while (depth > 0) {
    const x = lex.next();
    if (x.type === TokenType.EOF) return false;
    if (x.type === TokenType.LBrace) depth++;
    else if (x.type === TokenType.RBrace) depth--;
  }
  return lex.next().type === TokenType.EOF;
}
var jsmql = Object.assign(jsmqlDispatch, {
  compile: compileFunction,
  validate: validateInput,
  expr: Object.assign(exprDispatch, { compile: makeCompile(lowerExprWithCtx, "jsmql.expr.compile") }),
  filter: Object.assign(filterDispatch, { compile: makeCompile(lowerFilterStrict, "jsmql.filter.compile") }),
  pipeline: Object.assign(pipelineDispatch, {
    compile: makeCompile(lowerPipelineStrict, "jsmql.pipeline.compile")
  }),
  update: Object.assign(updateDispatch, { compile: makeCompile(lowerUpdateStrict, "jsmql.update.compile") })
});
var OPAQUE_INTERP_MARKER = "\uE000";
function isFieldRefShapedString(value) {
  return typeof value === "string" && value.length > 0 && value.charCodeAt(0) === 36;
}
function stringifyInterpolation(value, slot, routedBindings) {
  if (!needsBindingRoute(value)) {
    validateInterpolatable(value, slot);
    return JSON.stringify(value);
  }
  const state = { counter: 0, seen: /* @__PURE__ */ new WeakSet() };
  const substituted = substituteRoutedValues(value, slot, routedBindings, state);
  validateInterpolatable(substituted, slot);
  const jsonWithMarkers = JSON.stringify(substituted);
  const markerPattern = new RegExp(`"${OPAQUE_INTERP_MARKER}([A-Za-z_][A-Za-z0-9_]*)${OPAQUE_INTERP_MARKER}"`, "g");
  return jsonWithMarkers.replace(markerPattern, (match, name) => routedBindings.has(name) ? name : match);
}
function needsBindingRoute(value, seen) {
  if (isOpaqueBsonValue(value) || isFieldRefShapedString(value)) return true;
  if (value === null || typeof value !== "object") return false;
  const s = seen ?? /* @__PURE__ */ new WeakSet();
  if (s.has(value)) return false;
  s.add(value);
  if (Array.isArray(value)) {
    for (const v of value) if (needsBindingRoute(v, s)) return true;
    return false;
  }
  for (const v of Object.values(value)) if (needsBindingRoute(v, s)) return true;
  return false;
}
function substituteRoutedValues(value, slot, bindings, state) {
  if (isOpaqueBsonValue(value) || isFieldRefShapedString(value)) {
    state.counter += 1;
    const name = `__jsmql_interp_${slot}_${state.counter}`;
    bindings.set(name, value);
    return `${OPAQUE_INTERP_MARKER}${name}${OPAQUE_INTERP_MARKER}`;
  }
  if (value === null || typeof value !== "object") return value;
  if (state.seen.has(value)) return value;
  state.seen.add(value);
  if (Array.isArray(value)) {
    return value.map((v) => substituteRoutedValues(v, slot, bindings, state));
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = substituteRoutedValues(v, slot, bindings, state);
  }
  return out;
}
function validateInterpolatable(value, slot, key) {
  const where = key !== void 0 ? `parameter '${key}'` : `interpolation slot ${slot}`;
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new JsmqlInterpolationError(
      `jsmql ${where}: ${value} is not a valid JSON value (NaN and \xB1Infinity have no JSON representation). Replace with null or a finite number.`,
      slot,
      key
    );
  }
  let json;
  try {
    json = JSON.stringify(value);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new JsmqlInterpolationError(`jsmql ${where} could not be serialised: ${reason}`, slot, key);
  }
  if (json === void 0) {
    const ty = value === void 0 ? "undefined" : typeof value;
    throw new JsmqlInterpolationError(
      `jsmql ${where} has type '${ty}', which has no JSON representation. Pass a string, number, boolean, null, array, or plain object instead.`,
      slot,
      key
    );
  }
}
function lowerProgram(ast, ctx, lowerExpr) {
  if (ast.type === "Pipeline") return generateImplicitPipeline(ast, ctx);
  if (ast.type === "UpdateFilter") {
    if (updateFilterHasReplaceRoot(ast)) {
      return generateImplicitPipeline({ type: "Pipeline", stmts: [ast], pos: ast.pos }, ctx);
    }
    return generateUpdateFilter(ast, ctx);
  }
  if (isPipelineAst(ast)) return generatePipeline(ast, ctx);
  return lowerExpr(ast, ctx);
}
function lowerWithCtx(ast, ctx) {
  ({ ast, ctx } = foldProgram(ast, ctx));
  if (ast.type !== "Pipeline" && ast.type !== "UpdateFilter" && !isPipelineAst(ast) && (detectStageIntent(ast) !== null || isAssertCall(ast))) {
    const synthetic = { type: "Pipeline", stmts: [ast], pos: ast.pos };
    return generateImplicitPipeline(synthetic, ctx);
  }
  if (ast.type !== "Pipeline" && ast.type !== "UpdateFilter" && !isPipelineAst(ast) && (isCollectionMethodCall(ast) || isSystemStageCall(ast))) {
    const synthetic = { type: "Pipeline", stmts: [ast], pos: ast.pos };
    return generateImplicitPipeline(synthetic, ctx);
  }
  if (ast.type !== "Pipeline" && ast.type !== "UpdateFilter" && !isPipelineAst(ast)) {
    const rewrite = tryRewriteMutatorCall(ast);
    if (rewrite.kind === "rewrite") {
      const synthetic = { type: "Pipeline", stmts: [ast], pos: ast.pos };
      return generateImplicitPipeline(synthetic, ctx);
    }
  }
  if (ast.type === "UpdateFilter" && containsLookupCall(ast, ctx)) {
    const synthetic = { type: "Pipeline", stmts: [ast], pos: ast.pos };
    return generateImplicitPipeline(synthetic, ctx);
  }
  if (ast.type === "UpdateFilter" && containsStreamLength(ast)) {
    const synthetic = { type: "Pipeline", stmts: [ast], pos: ast.pos };
    return generateImplicitPipeline(synthetic, ctx);
  }
  if (ast.type === "UpdateFilter" && containsOutAssign(ast)) {
    const synthetic = { type: "Pipeline", stmts: [ast], pos: ast.pos };
    return generateImplicitPipeline(synthetic, ctx);
  }
  if (ast.type !== "Pipeline" && ast.type !== "UpdateFilter" && !isPipelineAst(ast) && detectStageIntent(ast) === null && containsLookupCall(ast, ctx)) {
    throw new CodegenError(
      "Lookup syntax ('$$$.<coll>.find/filter/aggregate(...)') requires Pipeline mode. Assign the lookup to a field (`$.x = $$$.coll.find(...)`) or wrap in a let / pipeline statement, and ensure the source has at least one `;` so jsmql routes through Pipeline lowering.",
      ast.pos
    );
  }
  const result = lowerProgram(ast, ctx, generateFilter);
  if (ast.type === "UpdateFilter" && !Array.isArray(result)) {
    return [result];
  }
  return result;
}
function lowerExprWithCtx(ast, ctx) {
  ({ ast, ctx } = foldProgram(ast, ctx));
  rejectLookupOutsidePipeline(ast, "jsmql.expr", ctx);
  rejectUnionPushOutsidePipeline(ast, "jsmql.expr");
  rejectOutOutsidePipeline(ast, "jsmql.expr");
  return lowerProgram(ast, ctx, (e, c) => generateWithCtx(e, { ...c, aggExpr: true }));
}
function lowerFilterStrict(ast, ctx) {
  ({ ast, ctx } = foldProgram(ast, ctx));
  rejectLookupOutsidePipeline(ast, "jsmql.filter", ctx);
  rejectUnionPushOutsidePipeline(ast, "jsmql.filter");
  rejectOutOutsidePipeline(ast, "jsmql.filter");
  if (ast.type === "Pipeline") {
    throw new CodegenError(
      "jsmql.filter() expects a Filter (the document `db.coll.find(filter)` takes), but received a `;`-separated Pipeline. Drop the `;` to compose a Filter, or call jsmql.pipeline() / jsmql() for Pipeline output.",
      ast.pos
    );
  }
  if (ast.type === "UpdateFilter") {
    if (updateFilterHasReplaceRoot(ast)) {
      throw new CodegenError(
        "jsmql.filter() expects a Filter, but received a root-replace `$ = <expr>` (which compiles to a `$replaceWith` stage). Call jsmql.pipeline() or jsmql() for Pipeline output.",
        ast.pos
      );
    }
    throw new CodegenError(
      "jsmql.filter() expects a Filter, but received an update-op chain (e.g. `$.x = \u2026`, `delete $.x`). Update-op chains compile to `$set` / `$unset` stages \u2014 call jsmql.update() or jsmql() for the Pipeline form.",
      ast.pos
    );
  }
  if (isPipelineAst(ast)) {
    throw new CodegenError(
      "jsmql.filter() expects a Filter, but received a Pipeline array (`[{ $stage: ... }, ...]`). Call jsmql.pipeline() or jsmql() for Pipeline output.",
      ast.pos
    );
  }
  const stageName = detectStageIntent(ast);
  if (stageName !== null) {
    const hint = stageName === "$match" ? " \u2014 or, if you wanted a Filter, drop the `$match(...)` wrapper and pass the predicate directly to jsmql.filter()." : ".";
    throw new CodegenError(
      `jsmql.filter() expects a Filter, but received a top-level '${stageName}' stage call. Call jsmql.pipeline() or jsmql() for Pipeline output${hint}`,
      ast.pos
    );
  }
  return generateFilter(ast, ctx);
}
function lowerPipelineStrict(ast, ctx) {
  return lowerToPipelineStages(ast, ctx, "jsmql.pipeline");
}
function lowerUpdateStrict(ast, ctx) {
  if (containsLookupCall(ast, ctx)) {
    throw new CodegenError(
      "jsmql.update() does not allow lookup syntax ('$$$.<coll>.find/filter/aggregate(...)'): MongoDB's aggregation-pipeline update form only accepts " + Array.from(UPDATE_PIPELINE_STAGES).sort().join(", ") + ". Run the lookup in a regular aggregation pipeline (jsmql.pipeline()) and apply updates separately.",
      ast.pos
    );
  }
  if (containsUnionPush(ast)) {
    throw new CodegenError(
      "jsmql.update() does not allow '$$.push(...)' (collection union): MongoDB's aggregation-pipeline update form only accepts " + Array.from(UPDATE_PIPELINE_STAGES).sort().join(", ") + ". Run the union in a regular aggregation pipeline (jsmql.pipeline()) \u2014 '$unionWith' isn't allowed inside an update.",
      ast.pos
    );
  }
  const stages = lowerToPipelineStages(ast, ctx, "jsmql.update");
  for (let i = 0; i < stages.length; i++) {
    const stageName = Object.keys(stages[i])[0];
    if (!UPDATE_PIPELINE_STAGES.has(stageName)) {
      const allowed = Array.from(UPDATE_PIPELINE_STAGES).sort().join(", ");
      throw new CodegenError(
        `jsmql.update() rejected '${stageName}' (stage ${i}): MongoDB's aggregation-pipeline update form only accepts ${allowed}. Use jsmql.pipeline() if you need other stages.`,
        ast.pos
      );
    }
  }
  return stages;
}
function rejectLookupOutsidePipeline(ast, apiName, ctx) {
  if (containsLookupCall(ast, ctx)) {
    throw new CodegenError(
      `${apiName}() does not allow lookup syntax ('$$$.<coll>.find/filter/aggregate(...)') \u2014 joins are Pipeline-only. Use jsmql() (in Pipeline mode) or jsmql.pipeline() for cross-collection queries.`,
      ast.pos
    );
  }
}
function rejectUnionPushOutsidePipeline(ast, apiName) {
  if (containsUnionPush(ast)) {
    throw new CodegenError(
      `${apiName}() does not allow '$$.push(...)' \u2014 collection unions are Pipeline-only. Use jsmql() (in Pipeline mode) or jsmql.pipeline() to compose '$unionWith' stages.`,
      ast.pos
    );
  }
}
function rejectOutOutsidePipeline(ast, apiName) {
  if (containsOutAssign(ast)) {
    throw new CodegenError(
      `${apiName}() does not allow '$out' sugar ('$$$.<coll> = \u2026' / '$$$$.<db>.<coll> = \u2026') \u2014 '$out' is a pipeline stage. Use jsmql() (in Pipeline mode \u2014 add ';' or wrap in a stage array) or jsmql.pipeline() to compose '$out' stages.`,
      ast.pos
    );
  }
}
function lowerToPipelineStages(ast, ctx, apiName) {
  ({ ast, ctx } = foldProgram(ast, ctx));
  if (ast.type === "Pipeline") return generateImplicitPipeline(ast, ctx);
  if (ast.type === "UpdateFilter") {
    if (containsOutAssign(ast) || updateFilterHasReplaceRoot(ast) || containsStreamLength(ast)) {
      const synthetic = { type: "Pipeline", stmts: [ast], pos: ast.pos };
      return generateImplicitPipeline(synthetic, ctx);
    }
    const result = generateUpdateFilter(ast, ctx);
    return Array.isArray(result) ? result : [result];
  }
  if (isPipelineAst(ast)) return generatePipeline(ast, ctx);
  if (detectStageIntent(ast) !== null || isSystemStageCall(ast) || isAssertCall(ast)) {
    const synthetic = { type: "Pipeline", stmts: [ast], pos: ast.pos };
    return generateImplicitPipeline(synthetic, ctx);
  }
  throw new CodegenError(
    `${apiName}() expects a Pipeline (one or more aggregation stages \u2014 \`;\`-separated, a top-level stage call, or a stage-array literal), but received a bare expression that would lower to a Filter document. Call jsmql.filter() or jsmql() for Filter output, or wrap the predicate as \`$match(...)\` to make it a Pipeline.`,
    ast.pos
  );
}
var UPDATE_PIPELINE_STAGES = /* @__PURE__ */ new Set([
  "$addFields",
  "$project",
  "$replaceRoot",
  "$replaceWith",
  "$set",
  "$unset"
]);
function generateFilter(ast, ctx) {
  if (ast.type === "ObjectLiteral") {
    return generateWithCtx(ast, ctx);
  }
  const t = translateMatchBody(ast, { bindings: ctx.bindings });
  return mergeTranslatedQuery(t, ctx) ?? {};
}
function isCollectionMethodCall(ast) {
  return ast.type === "MethodCall" && ast.object.type === "CollectionRef";
}
function detectStageIntent(ast) {
  if (ast.type === "OperatorCall" && lookupStage(ast.name) !== void 0) {
    return ast.name;
  }
  if (ast.type === "ObjectLiteral" && ast.entries.length === 1) {
    const entry = ast.entries[0];
    if (entry.type === "KeyValueEntry" && entry.key.kind === "static" && lookupStage(entry.key.name) !== void 0) {
      return entry.key.name;
    }
  }
  return null;
}
function errorToValidationResult(err) {
  if (err instanceof ParseError || err instanceof LexError) {
    return { valid: false, errors: [{ message: err.message, pos: err.pos, code: "SYNTAX_ERROR" }] };
  }
  if (err instanceof CodegenError) {
    return { valid: false, errors: [{ message: err.message, pos: err.pos, code: "CODEGEN_ERROR" }] };
  }
  if (err instanceof FunctionInputError) {
    return { valid: false, errors: [{ message: err.message, pos: err.pos, code: "SYNTAX_ERROR" }] };
  }
  if (err instanceof JsmqlInterpolationError) {
    return { valid: false, errors: [{ message: err.message, pos: 0, code: "SYNTAX_ERROR" }] };
  }
  if (err instanceof RangeError || err instanceof TypeError) {
    return { valid: false, errors: [{ message: err.message, pos: 0, code: "SYNTAX_ERROR" }] };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { valid: false, errors: [{ message: `internal error: ${message}`, pos: 0, code: "CODEGEN_ERROR" }] };
}
function augmentForFunctionInput(err) {
  if (err instanceof UnknownIdentifierError) {
    err.message = `${err.message}
If '${err.identifier}' is a binding you want to supply at call time, use jsmql.compile(fn)({ ${err.identifier}: \u2026 }) and add it to the params destructure: ({ ${err.identifier} }, { $ }) => \u2026
If '${err.identifier}' is a value from outer scope, use the jsmql\`\` template tag: jsmql\`\u2026 \${${err.identifier}} \u2026\``;
  }
  return err;
}
export {
  FunctionInputError,
  JsmqlInterpolationError,
  ObjectId,
  jsmql
};
