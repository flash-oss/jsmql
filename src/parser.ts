import { Lexer, TokenType, type Token } from "./lexer.js";
import type {
  Expr,
  BinaryOp,
  UnaryOp,
  ArrayElement,
  ObjectEntry,
  KeyValueEntry,
  SpreadElement,
  TypeCastOp,
  MathMethod,
  MathConstant,
  ObjectMethod,
  ObjectKey,
  CallArg,
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

const MATH_METHODS = new Set<string>([
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
]);

const MATH_CONSTANTS = new Set<string>(["PI", "E"]);

const OBJECT_METHODS = new Set<string>(["keys", "values", "entries", "assign", "fromEntries"]);

const TYPE_CAST_NAMES = new Set<string>(["Number", "String", "Boolean", "parseInt", "parseFloat"]);

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
   * comparison:  relational [ (==|!=|===|!==) relational ]
   * Non-chainable. Lower precedence than relational (<, <=, >, >=, in) to match JS.
   */
  private parseComparison(): Expr {
    const left = this.parseRelational();
    const op = this.peekEqualityOp();
    if (!op) return left;
    this.lexer.next();
    const right = this.parseRelational();
    return { type: "BinaryExpr", op, left, right };
  }

  private peekEqualityOp(): BinaryOp | null {
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
  private parseRelational(): Expr {
    const left = this.parseAdditive();
    const op = this.peekRelationalOp();
    if (!op) return left;
    this.lexer.next();
    const right = this.parseAdditive();
    return { type: "BinaryExpr", op, left, right };
  }

  private peekRelationalOp(): BinaryOp | null {
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

  /** unary:  typeof | ("!"|"-") unary  |  postfix  */
  private parseUnary(): Expr {
    const t = this.lexer.peek();
    if (t.type === TokenType.Typeof) {
      this.lexer.next();
      const operand = this.parseUnary();
      return { type: "TypeofExpr", operand };
    }
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

  /**
   * postfix:  primary ( "[" expression "]" | "." member | "?." member | "?.[" expression "]" )*
   *
   * Optional chaining (`?.`) is treated identically to `.` and `[]` for codegen purposes:
   * MongoDB returns missing/null when traversing through missing fields, so JS-style
   * null-safe access already works for free on field paths.
   */
  private parsePostfix(): Expr {
    let left = this.parsePrimary();
    for (;;) {
      const t = this.lexer.peek().type;
      if (t === TokenType.LBracket) {
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
      } else if (t === TokenType.Dot || t === TokenType.QuestDot) {
        this.lexer.next(); // consume . or ?.
        // ?.[...] form — optional bracket access
        if (t === TokenType.QuestDot && this.lexer.peek().type === TokenType.LBracket) {
          this.lexer.next(); // consume [
          const index = this.parseExpression();
          const close = this.lexer.peek();
          if (close.type !== TokenType.RBracket) {
            throw new ParseError(
              `Expected ']' after index expression at position ${close.pos}`,
              close.pos,
            );
          }
          this.lexer.next();
          left = { type: "IndexAccess", object: left, index };
          continue;
        }
        const member = this.lexer.peek();
        if (!this.isFieldSegmentToken(member)) {
          throw new ParseError(
            `Expected property name after '.' at position ${member.pos}`,
            member.pos,
          );
        }
        this.lexer.next(); // consume member name
        if (this.lexer.peek().type === TokenType.LParen) {
          // Method call: left.member(args)
          const args = this.parseMethodCallArgs();
          left = { type: "MethodCall", object: left, method: member.value, args };
        } else {
          // Property access: left.member
          left = { type: "MemberAccess", object: left, member: member.value };
        }
      } else {
        break;
      }
    }
    return left;
  }

  /** Parse method call argument list: "(" [argOrLambda (, argOrLambda)*] ")" */
  private parseMethodCallArgs(): CallArg[] {
    this.lexer.expect(TokenType.LParen);
    if (this.lexer.peek().type === TokenType.RParen) {
      this.lexer.next();
      return [];
    }
    const args: CallArg[] = [this.parseCallArg()];
    while (this.lexer.peek().type === TokenType.Comma) {
      this.lexer.next();
      args.push(this.parseCallArg());
    }
    this.lexer.expect(TokenType.RParen);
    return args;
  }

  /**
   * Parse one argument in a call site. Allows:
   *   - ...expr (spread)
   *   - lambda forms (x => ..., (x) => ..., (x, y) => ...)
   *   - any expression
   */
  private parseCallArg(): CallArg {
    if (this.lexer.peek().type === TokenType.Spread) {
      this.lexer.next();
      const argument = this.parseExpression();
      const spread: SpreadElement = { type: "SpreadElement", argument };
      return spread;
    }
    return this.parseArgOrLambda();
  }

  /**
   * Parse an argument that might be a lambda expression.
   * Checks for lambda patterns before falling back to parseExpression().
   */
  private parseArgOrLambda(): Expr {
    // x => expr  (unparenthesized single param)
    if (
      this.lexer.peek().type === TokenType.Ident &&
      this.lexer.lookahead(1).type === TokenType.Arrow
    ) {
      return this.parseLambdaUnparen();
    }
    // (x) => expr  or  (x, y) => expr  or  () => expr
    if (this.isLambdaStart()) {
      return this.parseLambdaParen();
    }
    return this.parseExpression();
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
      case TokenType.RegexLiteral:
        this.lexer.next();
        return { type: "RegexLiteral", pattern: t.value, flags: t.flags ?? "" };
      case TokenType.TemplateStart:
        return this.parseTemplateLiteral();
      case TokenType.New:
        return this.parseNewDate();
      case TokenType.LParen:
        if (this.isLambdaStart()) return this.parseLambdaParen();
        return this.parseGrouped();
      case TokenType.Ident: {
        const name = t.value;
        if (name === "Math") return this.parseMathReference();
        if (name === "Object") return this.parseObjectCall();
        if (name === "Date" && this.lexer.lookahead(1).type === TokenType.Dot) {
          return this.parseDateNow();
        }
        if (name === "Array" && this.lexer.lookahead(1).type === TokenType.Dot) {
          return this.parseArrayStaticCall();
        }
        if (TYPE_CAST_NAMES.has(name)) return this.parseTypeCast();
        this.lexer.next();
        return { type: "ParamRef", name };
      }
      default:
        if (t.type === TokenType.EOF) {
          throw new ParseError(`Unexpected end of expression`, t.pos);
        }
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
      const args: CallArg[] = [obj];
      while (this.lexer.peek().type === TokenType.Comma) {
        this.lexer.next();
        args.push(this.parseCallArg());
      }
      this.lexer.expect(TokenType.RParen);
      return { type: "OperatorCall", name, style: "positional", args };
    }

    // Positional args (may include lambdas and spreads)
    const args: CallArg[] = [this.parseCallArg()];
    while (this.lexer.peek().type === TokenType.Comma) {
      this.lexer.next();
      args.push(this.parseCallArg());
    }
    this.lexer.expect(TokenType.RParen);
    return { type: "OperatorCall", name, style: "positional", args };
  }

  /** $.field — stops at first segment; postfix handles further dots */
  private parseFieldRef(): Expr {
    const dollarDot = this.lexer.next(); // consume $.
    const first = this.lexer.peek();
    if (!this.isFieldSegmentToken(first)) {
      throw new ParseError(
        `Expected field name after '$.' at position ${dollarDot.pos}`,
        dollarDot.pos,
      );
    }
    this.lexer.next();
    return { type: "FieldRef", path: first.value };
  }

  /** Any identifier or keyword token — valid as an operator name after $ */
  private isIdentOrKeyword(t: Token): boolean {
    return (
      t.type === TokenType.Ident ||
      t.type === TokenType.In ||
      t.type === TokenType.New ||
      t.type === TokenType.Typeof
    );
  }

  /** A token that is valid as a field-path segment (identifiers and reserved-word keywords). */
  private isFieldSegmentToken(t: Token): boolean {
    return (
      t.type === TokenType.Ident ||
      t.type === TokenType.In ||
      t.type === TokenType.New ||
      t.type === TokenType.Typeof
    );
  }

  /**
   * Non-consuming lookahead: is the current position the start of a parenthesized lambda?
   * Matches: "(" ")" "=>" | "(" Ident ")" "=>" | "(" Ident ("," Ident)* ")" "=>"
   */
  private isLambdaStart(): boolean {
    if (this.lexer.peek().type !== TokenType.LParen) return false;
    let offset = 1;
    // Check for () => (zero params)
    if (this.lexer.lookahead(offset).type === TokenType.RParen) {
      return this.lexer.lookahead(offset + 1).type === TokenType.Arrow;
    }
    // Collect Ident (, Ident)*
    while (this.lexer.lookahead(offset).type === TokenType.Ident) {
      offset++;
      if (this.lexer.lookahead(offset).type === TokenType.RParen) {
        return this.lexer.lookahead(offset + 1).type === TokenType.Arrow;
      }
      if (this.lexer.lookahead(offset).type !== TokenType.Comma) return false;
      offset++; // consume comma
    }
    return false;
  }

  /** Parse "x => expr" — single unparenthesized parameter */
  private parseLambdaUnparen(): Expr {
    const paramTok = this.lexer.next(); // consume Ident
    this.lexer.next(); // consume =>
    const body = this.parseExpression();
    return { type: "Lambda", params: [paramTok.value], body };
  }

  /** Parse "(x) => expr" or "(x, y) => expr" or "() => expr" */
  private parseLambdaParen(): Expr {
    this.lexer.next(); // consume (
    const params: string[] = [];
    if (this.lexer.peek().type !== TokenType.RParen) {
      params.push(this.lexer.expect(TokenType.Ident).value);
      while (this.lexer.peek().type === TokenType.Comma) {
        this.lexer.next();
        params.push(this.lexer.expect(TokenType.Ident).value);
      }
    }
    this.lexer.expect(TokenType.RParen);
    this.lexer.expect(TokenType.Arrow);
    const body = this.parseExpression();
    return { type: "Lambda", params, body };
  }

  /** "new Date()" or "new Date(expr)" */
  private parseNewDate(): Expr {
    const newTok = this.lexer.next(); // consume 'new'
    const className = this.lexer.peek();
    if (className.type !== TokenType.Ident || className.value !== "Date") {
      throw new ParseError(`Expected 'Date' after 'new' at position ${newTok.pos}`, newTok.pos);
    }
    this.lexer.next(); // consume 'Date'
    this.lexer.expect(TokenType.LParen);
    if (this.lexer.peek().type === TokenType.RParen) {
      this.lexer.next();
      return { type: "NewDate", arg: null };
    }
    const arg = this.parseExpression();
    this.lexer.expect(TokenType.RParen);
    return { type: "NewDate", arg };
  }

  /** "Date.now()" — recognised as a primary; other Date.* members are not supported */
  private parseDateNow(): Expr {
    const dateTok = this.lexer.next(); // consume 'Date'
    this.lexer.expect(TokenType.Dot);
    const methodTok = this.lexer.peek();
    if (methodTok.type !== TokenType.Ident || methodTok.value !== "now") {
      throw new ParseError(
        `Unknown Date method '${methodTok.value}' at position ${methodTok.pos}. Supported: Date.now()`,
        dateTok.pos,
      );
    }
    this.lexer.next(); // consume 'now'
    this.lexer.expect(TokenType.LParen);
    this.lexer.expect(TokenType.RParen);
    return { type: "DateNow" };
  }

  /** "Array.isArray(x)" */
  private parseArrayStaticCall(): Expr {
    const arrayTok = this.lexer.next(); // consume 'Array'
    this.lexer.expect(TokenType.Dot);
    const methodTok = this.lexer.peek();
    if (methodTok.type !== TokenType.Ident || methodTok.value !== "isArray") {
      throw new ParseError(
        `Unknown Array method '${methodTok.value}' at position ${methodTok.pos}. Supported: Array.isArray()`,
        arrayTok.pos,
      );
    }
    this.lexer.next(); // consume 'isArray'
    this.lexer.expect(TokenType.LParen);
    const arg = this.parseExpression();
    this.lexer.expect(TokenType.RParen);
    // Translate to $isArray operator call directly
    return { type: "OperatorCall", name: "$isArray", style: "positional", args: [arg] };
  }

  /** "Math.method(args)" or "Math.PI" / "Math.E" constants */
  private parseMathReference(): Expr {
    const mathTok = this.lexer.next(); // consume 'Math'
    this.lexer.expect(TokenType.Dot);
    const ident = this.lexer.peek();
    if (ident.type !== TokenType.Ident) {
      throw new ParseError(`Expected Math member name at position ${ident.pos}`, mathTok.pos);
    }
    if (MATH_CONSTANTS.has(ident.value)) {
      this.lexer.next(); // consume constant name
      return { type: "MathConst", name: ident.value as MathConstant };
    }
    if (!MATH_METHODS.has(ident.value)) {
      throw new ParseError(
        `Unknown Math member '${ident.value}' at position ${ident.pos}. Supported methods: ${[...MATH_METHODS].join(", ")}. Constants: PI, E.`,
        mathTok.pos,
      );
    }
    this.lexer.next(); // consume method name
    const method = ident.value as MathMethod;
    this.lexer.expect(TokenType.LParen);
    const args: CallArg[] = [];
    if (this.lexer.peek().type !== TokenType.RParen) {
      args.push(this.parseCallArg());
      while (this.lexer.peek().type === TokenType.Comma) {
        this.lexer.next();
        args.push(this.parseCallArg());
      }
    }
    this.lexer.expect(TokenType.RParen);
    return { type: "MathCall", method, args };
  }

  /** "Object.method(args)" */
  private parseObjectCall(): Expr {
    const objectTok = this.lexer.next(); // consume 'Object'
    this.lexer.expect(TokenType.Dot);
    const methodTok = this.lexer.peek();
    if (methodTok.type !== TokenType.Ident || !OBJECT_METHODS.has(methodTok.value)) {
      throw new ParseError(
        `Unknown Object method '${methodTok.value}' at position ${methodTok.pos}. Supported: ${[...OBJECT_METHODS].join(", ")}`,
        objectTok.pos,
      );
    }
    this.lexer.next(); // consume method name
    const method = methodTok.value as ObjectMethod;
    this.lexer.expect(TokenType.LParen);
    const args: CallArg[] = [];
    if (this.lexer.peek().type !== TokenType.RParen) {
      args.push(this.parseCallArg());
      while (this.lexer.peek().type === TokenType.Comma) {
        this.lexer.next();
        args.push(this.parseCallArg());
      }
    }
    this.lexer.expect(TokenType.RParen);
    return { type: "ObjectCall", method, args };
  }

  /** "Number(x)" | "String(x)" | "Boolean(x)" | "parseInt(x)" | "parseFloat(x)" */
  private parseTypeCast(): Expr {
    const castTok = this.lexer.next(); // consume cast name
    const cast = castTok.value as TypeCastOp;
    this.lexer.expect(TokenType.LParen);
    const arg = this.parseExpression();
    if (this.lexer.peek().type === TokenType.Comma) {
      throw new ParseError(
        `Type cast '${cast}()' takes exactly 1 argument at position ${castTok.pos}`,
        castTok.pos,
      );
    }
    this.lexer.expect(TokenType.RParen);
    return { type: "TypeCast", cast, arg };
  }

  private parseNumber(): Expr {
    const t = this.lexer.next();
    const value = parseFloat(t.value);
    if (isNaN(value)) {
      throw new ParseError(`Invalid number '${t.value}' at position ${t.pos}`, t.pos);
    }
    return { type: "NumberLiteral", value };
  }

  /** Parse a template literal: `chunk0${expr0}chunk1${expr1}chunk2` */
  private parseTemplateLiteral(): Expr {
    this.lexer.expect(TokenType.TemplateStart);
    const quasis: string[] = [];
    const expressions: Expr[] = [];

    for (;;) {
      const chunk = this.lexer.expect(TokenType.TemplateChars);
      quasis.push(chunk.value);
      const next = this.lexer.peek();
      if (next.type === TokenType.TemplateEnd) {
        this.lexer.next();
        break;
      }
      if (next.type === TokenType.TemplateExprStart) {
        this.lexer.next();
        const expr = this.parseExpression();
        // The closing `}` of `${...}` is consumed by the lexer's brace-tracking logic,
        // which switches back to template-chunk reading without emitting an RBrace.
        // So the next token should be another TemplateChars chunk.
        expressions.push(expr);
        continue;
      }
      throw new ParseError(
        `Unexpected token in template literal at position ${next.pos}`,
        next.pos,
      );
    }

    return { type: "TemplateLiteral", quasis, expressions };
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
        entries.push(this.parseObjectEntry());
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

  /**
   * Parse one non-spread object entry. Supports:
   *   - Static key:    `name: expr`  or  `"name": expr`
   *   - Computed key:  `[expr]: expr`
   *   - Shorthand:     `name`  (sugar for `name: name`, valid in lambda scope)
   */
  private parseObjectEntry(): KeyValueEntry {
    const tok = this.lexer.peek();

    // Computed key: [expr]: value
    if (tok.type === TokenType.LBracket) {
      this.lexer.next();
      const keyExpr = this.parseExpression();
      this.lexer.expect(TokenType.RBracket);
      this.lexer.expect(TokenType.Colon);
      const value = this.parseExpression();
      const key: ObjectKey = { kind: "computed", expr: keyExpr };
      return { type: "KeyValueEntry", key, value };
    }

    if (tok.type !== TokenType.Ident && tok.type !== TokenType.String) {
      throw new ParseError(`Expected object key at position ${tok.pos}`, tok.pos);
    }
    this.lexer.next();
    const next = this.lexer.peek();
    // Shorthand: `{ x }` — only valid for plain identifiers; it desugars to `{ x: x }`,
    // where the value is a ParamRef. (Codegen will reject if `x` is not a lambda param.)
    if (
      tok.type === TokenType.Ident &&
      (next.type === TokenType.Comma || next.type === TokenType.RBrace)
    ) {
      const key: ObjectKey = { kind: "static", name: tok.value };
      const value: Expr = { type: "ParamRef", name: tok.value };
      return { type: "KeyValueEntry", key, value };
    }
    this.lexer.expect(TokenType.Colon);
    const value = this.parseExpression();
    const key: ObjectKey = { kind: "static", name: tok.value };
    return { type: "KeyValueEntry", key, value };
  }
}
