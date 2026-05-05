import { Lexer, TokenType, type Token } from "./lexer.js";
import type {
  Expr,
  BinaryOp,
  UnaryOp,
  ArrayElement,
  ObjectEntry,
  KeyValueEntry,
  SpreadElement,
} from "./ast.js";

export class ParseError extends Error {
  constructor(
    message: string,
    public readonly pos: number,
  ) {
    super(message);
    this.name = "ParseError";
  }
}

export class Parser {
  private readonly lexer: Lexer;

  constructor(src: string) {
    this.lexer = new Lexer(src);
  }

  parse(): Expr {
    const expr = this.parseExpression();
    const eof = this.lexer.peek();
    if (eof.type !== TokenType.EOF) {
      throw new ParseError(`Unexpected token '${eof.value}' at position ${eof.pos}`, eof.pos);
    }
    return expr;
  }

  // ── Precedence hierarchy (low → high) ────────────────────────────────────

  private parseExpression(): Expr {
    return this.parseTernary();
  }

  /** ternary:  nullish ("?" expression ":" ternary)?  — right-associative */
  private parseTernary(): Expr {
    const condition = this.parseNullish();
    if (this.lexer.peek().type !== TokenType.Quest) return condition;
    this.lexer.next(); // consume ?
    const consequent = this.parseExpression(); // full expr for consequent
    const colon = this.lexer.peek();
    if (colon.type !== TokenType.Colon) {
      throw new ParseError(
        `Expected ':' in ternary expression at position ${colon.pos}`,
        colon.pos,
      );
    }
    this.lexer.next(); // consume :
    const alternate = this.parseTernary(); // right-associative
    return { type: "TernaryExpr", condition, consequent, alternate };
  }

  /** nullish:  or ("??" or)*  — left-associative, flattened later */
  private parseNullish(): Expr {
    let left = this.parseOr();
    while (this.lexer.peek().type === TokenType.QuestQuest) {
      this.lexer.next();
      const right = this.parseOr();
      left = { type: "BinaryExpr", op: "??", left, right };
    }
    return left;
  }

  /** or:  and ("||" and)*  */
  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.lexer.peek().type === TokenType.PipePipe) {
      this.lexer.next();
      const right = this.parseAnd();
      left = { type: "BinaryExpr", op: "||", left, right };
    }
    return left;
  }

  /** and:  comparison ("&&" comparison)*  */
  private parseAnd(): Expr {
    let left = this.parseComparison();
    while (this.lexer.peek().type === TokenType.AmpAmp) {
      this.lexer.next();
      const right = this.parseComparison();
      left = { type: "BinaryExpr", op: "&&", left, right };
    }
    return left;
  }

  /**
   * comparison:  additive [ (==|!=|===|!==|>|>=|<|<=|in) additive ]
   * Non-chainable: a < b < c is a parse error.
   */
  private parseComparison(): Expr {
    const left = this.parseAdditive();
    const op = this.peekComparisonOp();
    if (!op) return left;
    this.lexer.next();
    const right = this.parseAdditive();
    return { type: "BinaryExpr", op, left, right };
  }

  private peekComparisonOp(): BinaryOp | null {
    switch (this.lexer.peek().type) {
      case TokenType.EqEq:
        return "==";
      case TokenType.EqEqEq:
        return "===";
      case TokenType.BangEq:
        return "!=";
      case TokenType.BangEqEq:
        return "!==";
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
  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    while (
      this.lexer.peek().type === TokenType.Plus ||
      this.lexer.peek().type === TokenType.Minus
    ) {
      const op: BinaryOp = this.lexer.next().type === TokenType.Plus ? "+" : "-";
      const right = this.parseMultiplicative();
      left = { type: "BinaryExpr", op, left, right };
    }
    return left;
  }

  /** multiplicative:  power ((*|/|%) power)*  */
  private parseMultiplicative(): Expr {
    let left = this.parsePower();
    for (;;) {
      const t = this.lexer.peek().type;
      let op: BinaryOp | null = null;
      if (t === TokenType.Star) op = "*";
      else if (t === TokenType.Slash) op = "/";
      else if (t === TokenType.Percent) op = "%";
      if (!op) break;
      this.lexer.next();
      const right = this.parsePower();
      left = { type: "BinaryExpr", op, left, right };
    }
    return left;
  }

  /** power:  unary ("**" power)?  — right-associative  */
  private parsePower(): Expr {
    const left = this.parseUnary();
    if (this.lexer.peek().type !== TokenType.StarStar) return left;
    this.lexer.next();
    const right = this.parsePower(); // right-associative
    return { type: "BinaryExpr", op: "**", left, right };
  }

  /** unary:  ("!"|"-") unary  |  postfix  */
  private parseUnary(): Expr {
    const t = this.lexer.peek();
    if (t.type === TokenType.Bang) {
      this.lexer.next();
      const operand = this.parseUnary();
      return { type: "UnaryExpr", op: "!", operand };
    }
    if (t.type === TokenType.Minus) {
      this.lexer.next();
      const operand = this.parseUnary();
      return { type: "UnaryExpr", op: "-", operand };
    }
    return this.parsePostfix();
  }

  /** postfix:  primary ("[" expression "]")*  */
  private parsePostfix(): Expr {
    let left = this.parsePrimary();
    while (this.lexer.peek().type === TokenType.LBracket) {
      this.lexer.next(); // consume [
      const index = this.parseExpression();
      const close = this.lexer.peek();
      if (close.type !== TokenType.RBracket) {
        throw new ParseError(
          `Expected ']' after index expression at position ${close.pos}`,
          close.pos,
        );
      }
      this.lexer.next(); // consume ]
      left = { type: "IndexAccess", object: left, index };
    }
    return left;
  }

  /** primary:  operator_call | field_ref | literals | "(" expr ")" | array | object  */
  private parsePrimary(): Expr {
    const t = this.lexer.peek();

    switch (t.type) {
      case TokenType.Dollar:
        return this.parseOperatorCall();
      case TokenType.DollarDot:
        return this.parseFieldRef();
      case TokenType.Number:
        return this.parseNumber();
      case TokenType.String:
        this.lexer.next();
        return { type: "StringLiteral", value: t.value };
      case TokenType.True:
        this.lexer.next();
        return { type: "BooleanLiteral", value: true };
      case TokenType.False:
        this.lexer.next();
        return { type: "BooleanLiteral", value: false };
      case TokenType.Null:
        this.lexer.next();
        return { type: "NullLiteral" };
      case TokenType.LBracket:
        return this.parseArrayLiteral();
      case TokenType.LBrace:
        return this.parseObjectLiteral();
      case TokenType.LParen:
        return this.parseGrouped();
      default:
        throw new ParseError(`Unexpected token '${t.value}' at position ${t.pos}`, t.pos);
    }
  }

  // ── Sub-parsers ───────────────────────────────────────────────────────────

  /** "(" expression ")"  */
  private parseGrouped(): Expr {
    this.lexer.expect(TokenType.LParen);
    const expr = this.parseExpression();
    const close = this.lexer.peek();
    if (close.type !== TokenType.RParen) {
      throw new ParseError(`Expected ')' at position ${close.pos}`, close.pos);
    }
    this.lexer.next();
    return expr;
  }

  private parseOperatorCall(): Expr {
    const dollar = this.lexer.next(); // consume $
    const nameTok = this.lexer.peek();
    if (!this.isIdentOrKeyword(nameTok)) {
      throw new ParseError(
        `Expected operator name after '$' at position ${dollar.pos}`,
        dollar.pos,
      );
    }
    this.lexer.next();
    const name = `$${nameTok.value}`;

    this.lexer.expect(TokenType.LParen);

    const peek = this.lexer.peek();

    // Zero-arg call
    if (peek.type === TokenType.RParen) {
      this.lexer.next();
      return { type: "OperatorCall", name, style: "positional", args: [] };
    }

    // Object-style: single `{...}` arg with no trailing comma
    if (peek.type === TokenType.LBrace) {
      const obj = this.parseObjectLiteral();
      const after = this.lexer.peek();
      if (after.type === TokenType.RParen) {
        this.lexer.next();
        return { type: "OperatorCall", name, style: "object", args: [obj] };
      }
      // First positional arg happens to be an object — collect remaining args
      const args: Expr[] = [obj];
      while (this.lexer.peek().type === TokenType.Comma) {
        this.lexer.next();
        args.push(this.parseExpression());
      }
      this.lexer.expect(TokenType.RParen);
      return { type: "OperatorCall", name, style: "positional", args };
    }

    // Positional args
    const args: Expr[] = [this.parseExpression()];
    while (this.lexer.peek().type === TokenType.Comma) {
      this.lexer.next();
      args.push(this.parseExpression());
    }
    this.lexer.expect(TokenType.RParen);
    return { type: "OperatorCall", name, style: "positional", args };
  }

  private parseFieldRef(): Expr {
    const dollarDot = this.lexer.next(); // consume $.
    const parts: string[] = [];

    // First segment: must be an identifier or keyword used as field name
    const first = this.lexer.peek();
    if (!this.isFieldSegmentToken(first)) {
      throw new ParseError(
        `Expected field name after '$.' at position ${dollarDot.pos}`,
        dollarDot.pos,
      );
    }
    this.lexer.next();
    parts.push(first.value);

    // Optional continuation: .identifier, .keyword, or .number
    while (this.lexer.peek().type === TokenType.Dot) {
      this.lexer.next(); // consume .
      const seg = this.lexer.peek();
      if (this.isFieldSegmentToken(seg)) {
        this.lexer.next();
        parts.push(seg.value);
      } else {
        throw new ParseError(`Expected field name segment at position ${seg.pos}`, seg.pos);
      }
    }

    return { type: "FieldRef", path: parts.join(".") };
  }

  /** Any identifier or keyword token — valid as an operator name after $ */
  private isIdentOrKeyword(t: Token): boolean {
    return (
      t.type === TokenType.Ident || t.type === TokenType.In
      // future keywords that could be MongoDB operator names go here
    );
  }

  /** A token that is valid as a field-path segment (identifiers, keywords like 'in', numbers) */
  private isFieldSegmentToken(t: Token): boolean {
    return (
      t.type === TokenType.Ident || t.type === TokenType.Number || t.type === TokenType.In // $.in is documented as valid
      // future keywords can be added here
    );
  }

  private parseNumber(): Expr {
    const t = this.lexer.next();
    const value = parseFloat(t.value);
    if (isNaN(value)) {
      throw new ParseError(`Invalid number '${t.value}' at position ${t.pos}`, t.pos);
    }
    return { type: "NumberLiteral", value };
  }

  private parseArrayLiteral(): Expr {
    this.lexer.expect(TokenType.LBracket);
    const elements: ArrayElement[] = [];

    while (this.lexer.peek().type !== TokenType.RBracket) {
      if (this.lexer.peek().type === TokenType.EOF) {
        throw new ParseError("Unterminated array literal", this.lexer.peek().pos);
      }
      if (this.lexer.peek().type === TokenType.Spread) {
        this.lexer.next();
        const arg = this.parseExpression();
        const spread: SpreadElement = { type: "SpreadElement", argument: arg };
        elements.push(spread);
      } else {
        elements.push(this.parseExpression());
      }
      if (this.lexer.peek().type === TokenType.Comma) {
        this.lexer.next();
      } else {
        break;
      }
    }

    this.lexer.expect(TokenType.RBracket);
    return { type: "ArrayLiteral", elements };
  }

  private parseObjectLiteral(): Expr {
    this.lexer.expect(TokenType.LBrace);
    const entries: ObjectEntry[] = [];

    while (this.lexer.peek().type !== TokenType.RBrace) {
      if (this.lexer.peek().type === TokenType.EOF) {
        throw new ParseError("Unterminated object literal", this.lexer.peek().pos);
      }
      if (this.lexer.peek().type === TokenType.Spread) {
        this.lexer.next();
        const arg = this.parseExpression();
        const spread: SpreadElement = { type: "SpreadElement", argument: arg };
        entries.push(spread);
      } else {
        const keyTok = this.lexer.peek();
        if (keyTok.type !== TokenType.Ident && keyTok.type !== TokenType.String) {
          throw new ParseError(`Expected object key at position ${keyTok.pos}`, keyTok.pos);
        }
        this.lexer.next();
        this.lexer.expect(TokenType.Colon);
        const value = this.parseExpression();
        const kv: KeyValueEntry = { type: "KeyValueEntry", key: keyTok.value, value };
        entries.push(kv);
      }
      if (this.lexer.peek().type === TokenType.Comma) {
        this.lexer.next();
      } else {
        break;
      }
    }

    this.lexer.expect(TokenType.RBrace);
    return { type: "ObjectLiteral", entries };
  }
}
