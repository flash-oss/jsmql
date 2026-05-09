import { Lexer, TokenType, type Token } from "./lexer.ts";
import type {
  Expr,
  BinaryOp,
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
  AssignExpr,
  DeleteStmt,
  Mutation,
  MutationProgram,
  Program,
} from "./ast.ts";

export class ParseError extends Error {
  readonly pos: number;
  constructor(message: string, pos: number) {
    super(message);
    this.name = "ParseError";
    this.pos = pos;
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
  "atanh",
]);

const MATH_CONSTANTS = new Set<string>(["PI", "E"]);

const OBJECT_METHODS = new Set<string>([
  "keys",
  "values",
  "entries",
  "assign",
  "fromEntries",
  "groupBy",
]);

const TYPE_CAST_NAMES = new Set<string>(["Number", "String", "Boolean", "parseInt", "parseFloat"]);

function compoundBinaryOp(op: "+=" | "-=" | "*=" | "/="): BinaryOp {
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

// Recursion-depth cap for the recursive-descent parser. Each user-visible
// nest level burns ~17 stack frames as the precedence cascade walks from
// parseExpression down to parsePrimary; 200 levels stays well within Node's
// default stack budget while comfortably above any realistic expression.
// Exceeding it surfaces a structured ParseError instead of an uncaught
// V8 RangeError. Mirrored in codegen.ts.
export const MAX_RECURSION_DEPTH = 200;

export class Parser {
  private readonly lexer: Lexer;
  private depth = 0;

  constructor(src: string) {
    this.lexer = new Lexer(src);
  }

  parse(): Program {
    const first = this.lexer.peek();

    // Tokens that can ONLY start a mutation program: `delete`, `++`, `--`.
    // Their presence at position 0 unambiguously commits us to mutation
    // parsing. Other mutation forms (=, +=, x++, …) reveal themselves only
    // after a target expression has been parsed — handled below.
    if (
      first.type === TokenType.Delete ||
      first.type === TokenType.PlusPlus ||
      first.type === TokenType.MinusMinus
    ) {
      return this.parseMutationProgram();
    }

    // Speculative: parse a single expression first.
    const expr = this.parseExpression();

    // If an assignment operator follows, the expression we just parsed was
    // actually a mutation target — treat the whole input as a mutation program.
    if (this.peekAssignOp() !== null) {
      this.validateMutationTarget(expr);
      return this.parseMutationProgramFrom(expr);
    }

    // Postfix `x++` / `x--` — same dispatch as a leading assignment operator.
    if (this.peekIncDecOp() !== null) {
      this.validateMutationTarget(expr);
      return this.parseMutationProgramFromPostfix(expr);
    }

    // `parseExpression` may have surfaced an `AssignExpr` from a parenthesized
    // top-level assignment (`($.a = 5)`) via parseGrouped's handling. Wrap it
    // in a MutationProgram so codegen routes through the mutation path.
    if ((expr as unknown as { type: string }).type === "AssignExpr") {
      const mutations: Mutation[] = [expr as unknown as AssignExpr];
      this.parseMutationProgramRest(mutations);
      return { type: "MutationProgram", mutations };
    }

    const eof = this.lexer.peek();
    if (eof.type !== TokenType.EOF) {
      throw new ParseError(`Unexpected token '${eof.value}' at position ${eof.pos}`, eof.pos);
    }
    return expr;
  }

  // ── Mutation program ─────────────────────────────────────────────────────

  /** Entry when the input starts with a mutation token (`delete`). */
  private parseMutationProgram(): MutationProgram {
    const mutations: Mutation[] = [];
    mutations.push(...this.parseMutation());
    this.parseMutationProgramRest(mutations);
    return { type: "MutationProgram", mutations };
  }

  /** Entry when the first target was already parsed as an expression. */
  private parseMutationProgramFrom(firstTarget: Expr): MutationProgram {
    const mutations: Mutation[] = [];
    mutations.push(...this.parseAssignmentChainFrom(firstTarget));
    this.parseMutationProgramRest(mutations);
    return { type: "MutationProgram", mutations };
  }

  /**
   * Entry when the first target was parsed and is followed by `++` or `--`
   * (postfix inc/dec). Validation must already have happened.
   */
  private parseMutationProgramFromPostfix(firstTarget: Expr): MutationProgram {
    const op = this.peekIncDecOp();
    if (op === null) {
      const tok = this.lexer.peek();
      throw new ParseError(`Expected '++' or '--' at position ${tok.pos}`, tok.pos);
    }
    this.lexer.next(); // consume the operator
    const mutations: Mutation[] = [this.makeIncDecMutation(firstTarget, op)];
    this.parseMutationProgramRest(mutations);
    return { type: "MutationProgram", mutations };
  }

  /** After the first mutation is parsed, consume any `;`/`,`-separated tail. */
  private parseMutationProgramRest(mutations: Mutation[]): void {
    for (;;) {
      if (!this.peekMutationSeparator()) break;
      this.lexer.next(); // consume `;` or `,`
      if (this.lexer.peek().type === TokenType.EOF) break; // trailing separator
      mutations.push(...this.parseMutation());
    }
    const tok = this.lexer.peek();
    if (tok.type !== TokenType.EOF) {
      throw new ParseError(`Unexpected token '${tok.value}' at position ${tok.pos}`, tok.pos);
    }
  }

  /**
   * Parse a single mutation. Returns an array because a chained assignment
   * (`$.a = $.b = expr`) flattens to multiple `AssignExpr` nodes here, all
   * sharing the deepest RHS.
   */
  private parseMutation(): Mutation[] {
    if (this.lexer.peek().type === TokenType.Delete) {
      return [this.parseDeleteStmt()];
    }
    // Prefix increment/decrement: `++$.x` / `--$.x`.
    if (this.peekIncDecOp() !== null) {
      return [this.parsePrefixIncDec()];
    }
    const target = this.parsePostfix();
    this.validateMutationTarget(target);
    // Postfix increment/decrement: `$.x++` / `$.x--`.
    const postfix = this.peekIncDecOp();
    if (postfix !== null) {
      this.lexer.next();
      return [this.makeIncDecMutation(target, postfix)];
    }
    return this.parseAssignmentChainFrom(target);
  }

  private parseDeleteStmt(): DeleteStmt {
    this.lexer.next(); // consume `delete`
    const target = this.parsePostfix();
    this.validateMutationTarget(target);
    return { type: "DeleteStmt", target };
  }

  /**
   * Given a target already parsed and validated, expect an assignment operator
   * and parse the RHS. Handles right-associative chains for `=`; rejects them
   * for compound operators because `a += b += 1` is too easy to misread.
   */
  private parseAssignmentChainFrom(target: Expr): AssignExpr[] {
    const opTok = this.lexer.peek();
    const op = this.peekAssignOp();
    if (op === null) {
      throw new ParseError(`Expected assignment operator at position ${opTok.pos}`, opTok.pos);
    }
    this.lexer.next(); // consume the assignment op

    if (op === "=") {
      // Try to peek a chained target: `<target> = <target> = …`. The peek-ahead
      // is bounded (DollarDot, Ident segments, dots) so this is cheap.
      if (this.peekIsAssignmentChainStart()) {
        const subTarget = this.parsePostfix();
        this.validateMutationTarget(subTarget);
        const sub = this.parseAssignmentChainFrom(subTarget);
        const deepestValue = sub[sub.length - 1].value;
        return [{ type: "AssignExpr", target, value: deepestValue }, ...sub];
      }
      const value = this.parseExpression();
      return [{ type: "AssignExpr", target, value }];
    }

    // Compound op (+=, -=, *=, /=). Reject chained.
    if (this.peekIsAssignmentChainStart()) {
      const tok = this.lexer.peek();
      throw new ParseError(
        `Compound assignment cannot be chained at position ${tok.pos} — split into separate statements`,
        tok.pos,
      );
    }
    const rhs = this.parseExpression();
    const desugared: Expr = {
      type: "BinaryExpr",
      op: compoundBinaryOp(op),
      left: target,
      right: rhs,
    };
    return [{ type: "AssignExpr", target, value: desugared }];
  }

  /**
   * Returns the assignment operator string at the current position, or null
   * if the next token is not an assignment operator.
   */
  private peekAssignOp(): "=" | "+=" | "-=" | "*=" | "/=" | null {
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

  private isAssignOpType(t: TokenType): boolean {
    return (
      t === TokenType.Eq ||
      t === TokenType.PlusEq ||
      t === TokenType.MinusEq ||
      t === TokenType.StarEq ||
      t === TokenType.SlashEq
    );
  }

  private peekMutationSeparator(): boolean {
    const t = this.lexer.peek().type;
    return t === TokenType.Semi || t === TokenType.Comma;
  }

  /**
   * Returns "++" or "--" if the next token is an inc/dec operator, else null.
   * Used at both prefix (start of mutation) and postfix (after a target)
   * positions; the caller decides which.
   */
  private peekIncDecOp(): "++" | "--" | null {
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
  private parsePrefixIncDec(): AssignExpr {
    const op = this.peekIncDecOp();
    if (op === null) {
      const tok = this.lexer.peek();
      throw new ParseError(`Expected '++' or '--' at position ${tok.pos}`, tok.pos);
    }
    this.lexer.next(); // consume `++` or `--`
    const target = this.parsePostfix();
    this.validateMutationTarget(target);
    return this.makeIncDecMutation(target, op);
  }

  /** Build the desugared AssignExpr for `target++` / `target--` / `++target` / `--target`. */
  private makeIncDecMutation(target: Expr, op: "++" | "--"): AssignExpr {
    const value: Expr = {
      type: "BinaryExpr",
      op: op === "++" ? "+" : "-",
      left: target,
      right: { type: "NumberLiteral", value: 1 },
    };
    return { type: "AssignExpr", target, value };
  }

  /**
   * Lookahead: do the next tokens look like `$.path[.path]* <assignOp>`?
   * Used to detect the start of a chained assignment's RHS when we're at
   * the right of a `=` operator. Bounded by the length of the field path
   * so it's cheap and never false-positive on regular RHS expressions.
   */
  private peekIsAssignmentChainStart(): boolean {
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
   * Mutation targets are restricted to field paths: a `FieldRef` (`$.x`) or
   * a chain of `MemberAccess` nodes rooted at one (`$.x.y.z`). Anything else
   * — index access, function calls, parameter refs, parenthesized expressions
   * containing operators — is rejected with a precise error.
   */
  private validateMutationTarget(target: Expr): void {
    if (this.isFieldPathTarget(target)) return;
    const pos = this.lexer.peek().pos;
    if (target.type === "ParamRef") {
      throw new ParseError(
        `Mutation target must be a field path like '$.${target.name}', not a bare identifier (at position ${pos})`,
        pos,
      );
    }
    if (target.type === "IndexAccess") {
      throw new ParseError(
        `Mutation target must be a static field path; computed/index access ('[…]') is not supported (at position ${pos})`,
        pos,
      );
    }
    throw new ParseError(
      `Mutation target must be a field path like '$.x' or '$.x.y' (at position ${pos})`,
      pos,
    );
  }

  private isFieldPathTarget(target: Expr): boolean {
    if (target.type === "FieldRef") return true;
    if (target.type === "MemberAccess") return this.isFieldPathTarget(target.object);
    return false;
  }

  // ── Precedence hierarchy (low → high) ────────────────────────────────────

  private parseExpression(): Expr {
    if (++this.depth > MAX_RECURSION_DEPTH) {
      this.depth--;
      const pos = this.lexer.peek().pos;
      throw new ParseError(
        `Expression nests too deeply (max ${MAX_RECURSION_DEPTH} levels) at position ${pos}`,
        pos,
      );
    }
    try {
      return this.parseTernary();
    } finally {
      this.depth--;
    }
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

  /** and:  bitOr ("&&" bitOr)*  */
  private parseAnd(): Expr {
    let left = this.parseBitOr();
    while (this.lexer.peek().type === TokenType.AmpAmp) {
      this.lexer.next();
      const right = this.parseBitOr();
      left = { type: "BinaryExpr", op: "&&", left, right };
    }
    return left;
  }

  /** bitOr:  bitXor ("|" bitXor)*  */
  private parseBitOr(): Expr {
    let left = this.parseBitXor();
    while (this.lexer.peek().type === TokenType.Pipe) {
      this.lexer.next();
      const right = this.parseBitXor();
      left = { type: "BinaryExpr", op: "|", left, right };
    }
    return left;
  }

  /** bitXor:  bitAnd ("^" bitAnd)*  */
  private parseBitXor(): Expr {
    let left = this.parseBitAnd();
    while (this.lexer.peek().type === TokenType.Caret) {
      this.lexer.next();
      const right = this.parseBitAnd();
      left = { type: "BinaryExpr", op: "^", left, right };
    }
    return left;
  }

  /** bitAnd:  comparison ("&" comparison)*  */
  private parseBitAnd(): Expr {
    let left = this.parseComparison();
    while (this.lexer.peek().type === TokenType.Amp) {
      this.lexer.next();
      const right = this.parseComparison();
      left = { type: "BinaryExpr", op: "&", left, right };
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

  /** unary:  typeof | ("!"|"-"|"~") unary  |  postfix  */
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
    if (t.type === TokenType.Tilde) {
      this.lexer.next();
      const operand = this.parseUnary();
      return { type: "UnaryExpr", op: "~", operand };
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
      if (t === TokenType.LParen) {
        // Direct call expression: e.g. ((x) => body)(arg) — only meaningful when the
        // callee is a lambda (IIFE). Codegen emits $let; non-lambda callees error there.
        const args = this.parseMethodCallArgs();
        left = { type: "CallExpression", callee: left, args };
        continue;
      }
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
        if (!this.isIdentOrKeyword(member)) {
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
      case TokenType.BigInt:
        this.lexer.next();
        return { type: "BigIntLiteral", value: t.value };
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
        if (name === "Number" && this.lexer.lookahead(1).type === TokenType.Dot) {
          return this.parseNumberStaticCall();
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

  /** "(" expression ")"  — also handles `(x => expr)`, the unparen-single-param lambda */
  private parseGrouped(): Expr {
    this.lexer.expect(TokenType.LParen);
    let expr: Expr;
    if (
      this.lexer.peek().type === TokenType.Ident &&
      this.lexer.lookahead(1).type === TokenType.Arrow
    ) {
      expr = this.parseLambdaUnparen();
    } else if (this.peekIncDecOp() !== null) {
      // Prefix `(++$.x)` / `(--$.x)` — parens around prefix inc/dec. Same
      // formatter-friendly motivation as the assignment case below.
      expr = this.parsePrefixIncDec() as unknown as Expr;
    } else {
      expr = this.parseExpression();
      // `($.x = expr)` — parenthesized assignment. JS-syntax-equivalent to
      // a bare `$.x = expr`; matters because formatters (oxfmt, prettier)
      // wrap assignment expressions in parens when they appear in array
      // element position. Parse the assignment here so the function-input
      // form `mjsql(($) => [($.a = 1)])` works the same as the bare form.
      // The result is an AssignExpr; we surface it as an `Expr` and let
      // contextual handling in parseArrayLiteral / parse() / _generate
      // route it appropriately. Plain expression contexts (e.g. `1 + (a=2)`)
      // bubble it up to codegen which throws a precise error.
      if (this.peekAssignOp() !== null) {
        this.validateMutationTarget(expr);
        const chain = this.parseAssignmentChainFrom(expr);
        if (chain.length !== 1) {
          const tok = this.lexer.peek();
          throw new ParseError(
            `Chained assignment inside parentheses is not supported at position ${tok.pos}`,
            tok.pos,
          );
        }
        expr = chain[0] as unknown as Expr;
      } else if (this.peekIncDecOp() !== null) {
        // Postfix `($.x++)` / `($.x--)` — parens around postfix inc/dec.
        const op = this.peekIncDecOp()!;
        this.lexer.next();
        this.validateMutationTarget(expr);
        expr = this.makeIncDecMutation(expr, op) as unknown as Expr;
      }
    }
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
    if (!this.isIdentOrKeyword(first)) {
      throw new ParseError(
        `Expected field name after '$.' at position ${dollarDot.pos}`,
        dollarDot.pos,
      );
    }
    this.lexer.next();
    return { type: "FieldRef", path: first.value };
  }

  /**
   * An identifier-like token — a regular `Ident` or one of the reserved-word
   * keywords (`in`, `new`, `typeof`) we accept in identifier position. Valid
   * after `.` (field-path segments, member names), after `$` (operator names),
   * and as a `$<key>` in object literals.
   */
  private isIdentOrKeyword(t: Token): boolean {
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

  /** "new Date()" / "new Date(expr)" or "new Set()" / "new Set(expr)" */
  private parseNewDate(): Expr {
    const newTok = this.lexer.next(); // consume 'new'
    const className = this.lexer.peek();
    if (className.type !== TokenType.Ident) {
      throw new ParseError(`Expected class name after 'new' at position ${newTok.pos}`, newTok.pos);
    }
    if (className.value !== "Date" && className.value !== "Set") {
      throw new ParseError(
        `Unsupported 'new ${className.value}' at position ${className.pos}. Supported: new Date(), new Set()`,
        className.pos,
      );
    }
    const cls = className.value;
    this.lexer.next(); // consume class name
    this.lexer.expect(TokenType.LParen);
    if (this.lexer.peek().type === TokenType.RParen) {
      this.lexer.next();
      return cls === "Date" ? { type: "NewDate", arg: null } : { type: "NewSet", arg: null };
    }
    const arg = this.parseExpression();
    this.lexer.expect(TokenType.RParen);
    return cls === "Date" ? { type: "NewDate", arg } : { type: "NewSet", arg };
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

  /** "Array.isArray(x)" or "Array.from(input)" or "Array.from(input, mapFn)" */
  private parseArrayStaticCall(): Expr {
    const arrayTok = this.lexer.next(); // consume 'Array'
    this.lexer.expect(TokenType.Dot);
    const methodTok = this.lexer.peek();
    if (methodTok.type !== TokenType.Ident) {
      throw new ParseError(`Expected Array method name at position ${methodTok.pos}`, arrayTok.pos);
    }
    if (methodTok.value === "isArray") {
      this.lexer.next();
      this.lexer.expect(TokenType.LParen);
      const arg = this.parseExpression();
      this.lexer.expect(TokenType.RParen);
      return { type: "OperatorCall", name: "$isArray", style: "positional", args: [arg] };
    }
    if (methodTok.value === "from") {
      this.lexer.next();
      this.lexer.expect(TokenType.LParen);
      const input = this.parseExpression();
      let mapFn: Expr | null = null;
      if (this.lexer.peek().type === TokenType.Comma) {
        this.lexer.next();
        const arg = this.parseArgOrLambda();
        mapFn = arg;
      }
      this.lexer.expect(TokenType.RParen);
      return { type: "ArrayFrom", input, mapFn };
    }
    throw new ParseError(
      `Unknown Array method '${methodTok.value}' at position ${methodTok.pos}. Supported: Array.isArray(), Array.from()`,
      arrayTok.pos,
    );
  }

  /** "Number.isInteger(x)" / "Number.isNaN(x)" / "Number.isFinite(x)" */
  private parseNumberStaticCall(): Expr {
    const numberTok = this.lexer.next(); // consume 'Number'
    this.lexer.expect(TokenType.Dot);
    const methodTok = this.lexer.peek();
    if (
      methodTok.type !== TokenType.Ident ||
      (methodTok.value !== "isInteger" &&
        methodTok.value !== "isNaN" &&
        methodTok.value !== "isFinite")
    ) {
      throw new ParseError(
        `Unknown Number static method '${methodTok.value}' at position ${methodTok.pos}. Supported: Number.isInteger, Number.isNaN, Number.isFinite`,
        numberTok.pos,
      );
    }
    const method = methodTok.value as "isInteger" | "isNaN" | "isFinite";
    this.lexer.next();
    this.lexer.expect(TokenType.LParen);
    const arg = this.parseExpression();
    this.lexer.expect(TokenType.RParen);
    return { type: "NumberStatic", method, arg };
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
      } else if (this.lexer.peek().type === TokenType.Delete) {
        // `delete $.x` as a pipeline element. Codegen rejects it if the array
        // turns out not to be a pipeline.
        elements.push(this.parseDeleteStmt());
      } else if (this.peekIncDecOp() !== null) {
        // Prefix `++$.x` / `--$.x` as a pipeline element.
        elements.push(this.parsePrefixIncDec());
      } else {
        // Could be a regular expression OR an assignment OR a postfix `x++`
        // used as a pipeline element. Parse the expression first; if a bare
        // assignment operator or `++`/`--` follows, treat as a mutation.
        const expr = this.parseExpression();
        if (this.peekAssignOp() !== null) {
          this.validateMutationTarget(expr);
          for (const m of this.parseAssignmentChainFrom(expr)) elements.push(m);
        } else if (this.peekIncDecOp() !== null) {
          const op = this.peekIncDecOp()!;
          this.lexer.next();
          this.validateMutationTarget(expr);
          elements.push(this.makeIncDecMutation(expr, op));
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

    // `$ident:` form. In JS, `$match` is a valid identifier; the lexer splits
    // it into Dollar + Ident so `$match(...)` and `$.foo` can be recognised
    // distinctly. As an object key we re-stitch them: `{ $match: ... }`,
    // `{ $gt: 18 }`, `{ $or: [...] }` are the natural ways to author
    // aggregation stage objects and MongoDB query documents.
    if (tok.type === TokenType.Dollar) {
      this.lexer.next();
      const ident = this.lexer.peek();
      if (!this.isIdentOrKeyword(ident)) {
        throw new ParseError(`Expected identifier after '$' at position ${tok.pos}`, tok.pos);
      }
      this.lexer.next();
      this.lexer.expect(TokenType.Colon);
      const value = this.parseExpression();
      const key: ObjectKey = { kind: "static", name: `$${ident.value}` };
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
