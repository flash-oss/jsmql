import { Lexer, TokenType, type Token } from "./lexer.js";
import type { Expr, ArrayElement, ObjectEntry, KeyValueEntry, SpreadElement } from "./ast.js";

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

  private parseExpression(): Expr {
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
      default:
        throw new ParseError(`Unexpected token '${t.value}' at position ${t.pos}`, t.pos);
    }
  }

  private parseOperatorCall(): Expr {
    // consume $
    const dollar = this.lexer.next(); // TokenType.Dollar
    const nameTok = this.lexer.peek();
    if (nameTok.type !== TokenType.Ident) {
      throw new ParseError(
        `Expected operator name after '$' at position ${dollar.pos}`,
        dollar.pos,
      );
    }
    this.lexer.next(); // consume IDENT
    const name = `$${nameTok.value}`;

    this.lexer.expect(TokenType.LParen);

    // Peek to decide: object-style or positional
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
        this.lexer.next(); // consume )
        return { type: "OperatorCall", name, style: "object", args: [obj] };
      }
      // Not object-style — it was the first positional arg that happens to be an object.
      // We already consumed the object literal, continue parsing more args.
      const args: Expr[] = [obj];
      while (this.lexer.peek().type === TokenType.Comma) {
        this.lexer.next(); // consume ,
        args.push(this.parseExpression());
      }
      this.lexer.expect(TokenType.RParen);
      return { type: "OperatorCall", name, style: "positional", args };
    }

    // Positional args
    const args: Expr[] = [];
    args.push(this.parseExpression());
    while (this.lexer.peek().type === TokenType.Comma) {
      this.lexer.next(); // consume ,
      args.push(this.parseExpression());
    }
    this.lexer.expect(TokenType.RParen);
    return { type: "OperatorCall", name, style: "positional", args };
  }

  private parseFieldRef(): Expr {
    // consume $.
    const dollarDot = this.lexer.next();
    const parts: string[] = [];

    // first segment must be an identifier
    const first = this.lexer.peek();
    if (first.type !== TokenType.Ident) {
      throw new ParseError(
        `Expected field name after '$.' at position ${dollarDot.pos}`,
        dollarDot.pos,
      );
    }
    this.lexer.next();
    parts.push(first.value);

    // optional continuation: .identifier or .number
    while (this.lexer.peek().type === TokenType.Dot) {
      // peek two tokens ahead: dot + ident/number
      this.lexer.next(); // consume .
      const seg = this.lexer.peek();
      if (seg.type === TokenType.Ident || seg.type === TokenType.Number) {
        this.lexer.next();
        parts.push(seg.value);
      } else {
        throw new ParseError(`Expected field name segment at position ${seg.pos}`, seg.pos);
      }
    }

    return { type: "FieldRef", path: parts.join(".") };
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
        this.lexer.next(); // consume ...
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
        this.lexer.next(); // consume ...
        const arg = this.parseExpression();
        const spread: SpreadElement = { type: "SpreadElement", argument: arg };
        entries.push(spread);
      } else {
        const keyTok = this.lexer.peek();
        if (keyTok.type !== TokenType.Ident && keyTok.type !== TokenType.String) {
          throw new ParseError(`Expected object key at position ${keyTok.pos}`, keyTok.pos);
        }
        this.lexer.next(); // consume key
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
