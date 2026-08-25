// Phase 2 — PARSE. Driven by src/registry/productions.ts.
//
// One Pratt loop reads `precedence`, `associativity` and `fixity` off the rows and
// replaces fourteen mutually-recursive methods. Adding an operator is a row.
//
// Two rules the old cascade could not express are enforced here because the rows
// now state them:
//   noMixWith          `a ?? b || c` and `typeof a ** b` are JavaScript SyntaxErrors
//   associativity none `a < b < c` does not chain
//
// The parser is NAME-BLIND. It never compares an identifier to a set: `Math`,
// `String` and a lambda parameter are all `Ident`, and which one it is comes from
// names.ts in a later phase. See src/registry/ast.ts.

import type {
  ArrayElement,
  ParamBinding,
  AssignOp,
  BinaryOp,
  CallArg,
  Expr,
  KeyValueEntry,
  Lambda,
  LetDecl,
  ObjectEntry,
  ObjectKey,
  Program,
  UnaryOp,
  PipelineStmt,
  UpdateFilter,
  UpdateOp,
  FuncDecl,
} from "../../registry/ast.ts";
import { lex } from "../lex/lexer.ts";
import type { Token } from "../lex/token.ts";
import { Cursor, found, ParseError, spell } from "./cursor.ts";
import { INFIX, MAX_PRECEDENCE, PREFIX, WORDS } from "./tables.ts";

/** A `0x` lexeme of exactly this many digits is an ObjectId, not an integer. */
const OBJECT_ID_DIGITS = 24;

type Parsed = { expr: Expr; /** The rule that produced it, for noMixWith. */ rule: string | null };

export function parse(source: string): Program {
  return new Parser(lex(source)).program();
}

/**
 * The ENTRY form: `(params, { $, … }) => <body>`.
 *
 * Two destructures at most. The one whose keys are `$`-prefixed is the toolbox —
 * it binds compiler services and is discarded once the body is parsed; the one
 * with bare keys binds query parameters. Which is which comes from the KEYS, not
 * from the position, so the "toolbox before params" mistake is caught by name.
 *
 * `destructuringParam` in productions.ts says `notANode` for a reason: the
 * bindings are held BESIDE the tree, never in it.
 */
export type EntryForm = { params: readonly ParamBinding[]; toolbox: readonly ParamBinding[]; program: Program };

export function parseEntry(source: string): EntryForm {
  return new Parser(lex(source)).entry();
}

/** Exposed for the tests and for phases that already hold tokens. */
export function parseExpression(source: string): Expr {
  const p = new Parser(lex(source));
  const e = p.expression();
  p.expectEnd();
  return e;
}

class Parser {
  private readonly c: Cursor;

  constructor(toks: readonly Token[]) {
    this.c = new Cursor(toks);
  }

  expectEnd(): void {
    if (!this.c.is("EOF")) {
      throw new ParseError(`Unexpected ${found(this.c.peek())}`, this.c.peek().pos);
    }
  }

  // ── the entry form ────────────────────────────────────────────────────────

  entry(): EntryForm {
    this.c.expect("LParen");
    const slots: ParamBinding[][] = [];
    if (!this.c.is("RParen")) {
      do {
        if (this.c.is("RParen")) break;
        slots.push(this.destructure());
      } while (this.c.eat("Comma"));
    }
    this.c.expect("RParen");
    if (slots.length > 2) {
      throw new ParseError(
        `An entry function takes at most two parameters — the params destructure and the toolbox destructure. Got ${slots.length}`,
        0,
      );
    }
    const isToolbox = (slot: readonly ParamBinding[]): boolean => slot.every((b) => b.key.startsWith("$"));
    const isParams = (slot: readonly ParamBinding[]): boolean => slot.every((b) => !b.key.startsWith("$"));
    for (const slot of slots) {
      if (!isToolbox(slot) && !isParams(slot)) {
        throw new ParseError(
          "A destructure holds either query parameters or the '$'-prefixed toolbox, never both. Split them into two: '(params, { $, … }) => …'",
          slot[0].pos,
        );
      }
    }
    if (slots.length === 2 && isToolbox(slots[0]) && !isToolbox(slots[1])) {
      throw new ParseError("Reorder to '(params, { $, … }) => …' — the toolbox is the SECOND slot", slots[0][0].pos);
    }
    const toolbox = slots.find(isToolbox) ?? [];
    const params = slots.find((sl) => sl !== toolbox && isParams(sl)) ?? [];
    this.c.expect("Arrow");
    // The body is a whole program: an expression, or `{ … }` holding statements.
    const program = this.c.is("LBrace") ? this.entryBlock() : this.program();
    return { params, toolbox, program };
  }

  /** `{ a, b: alias, $, $$, $name }` — one slot of the entry parameter list. */
  private destructure(): ParamBinding[] {
    const open = this.c.peek();
    if (!this.c.is("LBrace")) {
      throw new ParseError(
        `jsmql expects each parameter to be an object destructure pattern, e.g. '({ $ }) => …', but got ${found(open)}`,
        open.pos,
      );
    }
    this.c.next();
    const out: ParamBinding[] = [];
    if (!this.c.eat("RBrace")) {
      do {
        if (this.c.is("RBrace")) break;
        const key = this.destructureKey();
        const name = this.c.eat("Colon") ? this.identLike().text : key.text;
        out.push({ key: key.text, name, pos: key.pos });
      } while (this.c.eat("Comma"));
      this.c.expect("RBrace");
    }
    if (out.length === 0) throw new ParseError("An empty destructure binds nothing", open.pos);
    return out;
  }

  /**
   * A destructure key: a bare name, or one of the `$` family. `$name` is an
   * operator handle, and the bare `$`, `$$`, `$$$`, `$$$$` are the context refs —
   * each a distinct token, so each is matched on its own rather than by spelling.
   */
  private destructureKey(): Token {
    const t = this.c.peek();
    if (t.type === "Dollar") {
      this.c.next();
      // `$abs` is one key; a lone `$` is the document handle.
      if (this.c.is("Ident")) {
        const name = this.c.next();
        return { ...t, text: "$" + name.text, end: name.end };
      }
      return t;
    }
    if (t.type === "DoubleDollar" || t.type === "TripleDollar" || t.type === "QuadDollar") {
      this.c.next();
      return t;
    }
    return this.identLike();
  }

  /** `{ … }` as an entry body: statements, with an optional trailing `return`. */
  private entryBlock(): Program {
    this.c.expect("LBrace");
    const stmts: PipelineStmt[] = [];
    for (;;) {
      while (this.c.eat("Semi")) {
        /* an empty statement is not an error */
      }
      if (this.c.eat("RBrace")) break;
      if (this.c.is("Return")) {
        this.c.next();
        const ret = this.expression();
        while (this.c.eat("Semi")) {
          /* empty */
        }
        this.c.expect("RBrace");
        // A `return` in an entry block yields the expression itself, so a bare
        // predicate stays a predicate and the position phase reads it as a Filter.
        if (stmts.length > 0) {
          throw new ParseError("A 'return' here isn't a jsmql statement — put the whole predicate in the return", 0);
        }
        return ret;
      }
      stmts.push(this.statement());
      if (!this.c.eat("Semi") && !this.c.is("RBrace")) {
        throw new ParseError(`Expected ${spell("Semi")} but got ${found(this.c.peek())}`, this.c.peek().pos);
      }
    }
    if (stmts.length === 1) {
      const only = stmts[0];
      if (only.type !== "LetDecl" && only.type !== "FuncDecl") return only;
    }
    return { type: "Pipeline", stmts, pos: 0 };
  }

  // ── the whole input ───────────────────────────────────────────────────────

  program(): Program {
    const stmts = this.statements();
    this.expectEnd();
    // A bare predicate stands on its own, so the shape phase can read it as a
    // Filter. A lone declaration cannot — nothing would read it — and neither
    // can a statement the source ENDED with a `;`, because that `;` is the token
    // that says pipeline. Collapsing it threw the distinction away:
    //   Object.assign($.a, $.b)    a value, and a Filter
    //   Object.assign($.a, $.b);   a write, and a Pipeline
    // parsed to the same tree, and nothing downstream could tell them apart.
    if (stmts.length === 1 && !this.sawTopLevelSemi) {
      const only = stmts[0];
      if (only.type !== "LetDecl" && only.type !== "FuncDecl") return only;
    }
    return { type: "Pipeline", stmts, pos: 0 };
  }

  /** Set by `statements()` when a `;` ends a top-level statement. See `program`. */
  private sawTopLevelSemi = false;

  private statements(): PipelineStmt[] {
    const out: PipelineStmt[] = [];
    for (;;) {
      while (this.c.eat("Semi")) {
        /* an empty statement is not an error */
      }
      if (this.c.is("EOF")) break;
      const st = this.statement();
      out.push(st);
      // `function f(x) { … }` ends with its closing brace, so the separator is
      // optional after it — the same rule JavaScript uses.
      const blockBodied = st.type === "FuncDecl" && st.form === "function";
      if (this.c.is("Semi")) this.sawTopLevelSemi = true;
      if (!this.c.eat("Semi") && !this.c.is("EOF") && !blockBodied) {
        throw new ParseError(`Expected ${spell("Semi")} but got ${found(this.c.peek())}`, this.c.peek().pos);
      }
    }
    return out;
  }

  private statement(): PipelineStmt {
    if (this.c.is("Let") || this.c.is("Const")) return this.binding();
    if (this.functionAhead()) return this.functionDecl();
    if (this.writeAhead()) return this.writes();
    return this.expression();
  }

  /** Is a `function` declaration next? The word comes from its row's `word`. */
  private functionAhead(): boolean {
    return this.c.is("Ident") && WORDS.get(this.c.peek().text) === "functionBinding" && this.c.peek(1).type === "Ident";
  }

  /** `function name(params) { … }` — the same node the arrow spelling builds. */
  private functionDecl(): FuncDecl {
    const kw = this.c.next();
    const name = this.c.expect("Ident");
    const params = this.paramList();
    const lambda = this.lambdaBody(params, kw.pos);
    return { type: "FuncDecl", name: name.text, lambda, kind: "const", form: "function", pos: kw.pos };
  }

  /** `(a, b,)` — a parenthesised parameter list, trailing comma allowed. */
  private paramList(): string[] {
    this.c.expect("LParen");
    const out: string[] = [];
    if (!this.c.eat("RParen")) {
      do {
        if (this.c.is("RParen")) break;
        out.push(this.c.expect("Ident").text);
      } while (this.c.eat("Comma"));
      this.c.expect("RParen");
    }
    return out;
  }

  /**
   * `function (x) { … }` or `function name(x) { … }` in a VALUE slot. Both are
   * the same Lambda the arrow spelling builds; the name, if written, is not used.
   */
  private functionExpr(): Lambda {
    const kw = this.c.next();
    if (this.c.is("Ident")) this.c.next();
    const params = this.paramList();
    return this.lambdaBody(params, kw.pos);
  }

  /** `let x = …` / `const x = …`. A function body makes it a FuncDecl. */
  private binding(): LetDecl | FuncDecl {
    const kw = this.c.next();
    const kind = kw.type === "Const" ? "const" : "let";
    const name = this.c.expect("Ident");
    this.c.expect("Eq");
    const value = this.expression();
    if (value.type === "Lambda") {
      return { type: "FuncDecl", name: name.text, lambda: value, kind, form: "arrow", pos: kw.pos };
    }
    return { type: "LetDecl", name: name.text, value, kind, pos: kw.pos } satisfies LetDecl;
  }

  /**
   * A `,`-joined run of writes: `$.a = 1, delete $.b`. Whether the source is a
   * write is a question about the LEXEMES ahead, not about meaning, so it is
   * answered by lookahead over the assignment triggers.
   */
  /** `($.a = 1)` — a write inside parentheses, which `writes()` handles. */
  private parenWriteAhead(): boolean {
    const save = this.c.mark();
    try {
      this.c.next();
      return this.c.is("Delete") || this.c.is("PlusPlus") || this.c.is("MinusMinus") || this.startsAWrite();
    } finally {
      this.c.reset(save);
    }
  }

  /**
   * A write starts here. Asked in three places — a `;` statement, an array
   * element, and after a `,` inside brackets — so it is one predicate: three
   * copies of the condition is how the array form came to miss the `(`-wrapped
   * spelling the other two accepted.
   */
  private writeAhead(): boolean {
    if (this.c.is("Delete") || this.c.is("PlusPlus") || this.c.is("MinusMinus")) return true;
    if (this.c.is("LParen")) return this.parenWriteAhead();
    return this.startsAWrite();
  }

  private startsAWrite(): boolean {
    const save = this.c.mark();
    try {
      this.expression();
      const t = this.c.type;
      return ASSIGN_OPS.has(t);
    } catch {
      return false;
    } finally {
      this.c.reset(save);
    }
  }

  /**
   * ONE write, or a parenthesised group of them.
   *
   * A formatter writes `($.a = 1, $.b = 2)`, and inside the parentheses a `,`
   * always continues the group because the `)` is what ends it. Outside them the
   * `,` means different things in the two callers below, which is the whole
   * reason this is a separate method.
   */
  private writeGroup(): UpdateOp[] {
    if (this.c.is("LParen") && this.parenWriteAhead()) {
      this.c.next();
      const ops: UpdateOp[] = [];
      do {
        ops.push(...this.writeGroup());
      } while (this.c.eat("Comma") && !this.c.is("RParen"));
      this.c.expect("RParen");
      return ops;
    }
    if (this.c.is("Delete")) {
      const kw = this.c.next();
      return [{ type: "DeleteStmt", target: this.expression(), pos: kw.pos }];
    }
    // `++$.a` and `$.a++` mean the same write; the row says `prefixOrPostfix`.
    const prefix = this.c.is("PlusPlus") || this.c.is("MinusMinus") ? this.c.next() : null;
    const target = this.expression();
    const op = prefix ?? this.c.next();
    const spelling = ASSIGN_OPS.get(op.type);
    if (spelling === undefined) {
      throw new ParseError(`Expected an assignment but got ${found(op)}`, op.pos);
    }
    // `a?.b = 1` is a JavaScript SyntaxError. The row says so; this enforces it.
    this.refuseOptionalWriteTarget(target, op.pos);
    // `$.a = $.b = 1` — every target in the chain takes the SAME value, so the
    // chain is one write per target and not a nested assignment expression.
    if (spelling === "=") {
      const targets = [target];
      let value = this.expression();
      while (this.c.is("Eq")) {
        const eq = this.c.next();
        this.refuseOptionalWriteTarget(value, eq.pos);
        targets.push(value);
        value = this.expression();
      }
      return targets.map((t) => ({ type: "AssignExpr", target: t, op: "=" as const, value, pos: op.pos }));
    }
    const value = spelling === "++" || spelling === "--" ? target : this.expression();
    return [{ type: "AssignExpr", target, op: spelling, value, pos: op.pos }];
  }

  /** The `;` form: a `,` continues the run until the `;` or the end of input. */
  private writes(): UpdateFilter {
    const pos = this.c.peek().pos;
    const ops: UpdateOp[] = [];
    do {
      ops.push(...this.writeGroup());
      // `}` ends the run as surely as `;` does: a callback block is a statement
      // list too, and a formatter puts a trailing comma before its brace.
    } while (this.c.eat("Comma") && !this.c.is("EOF") && !this.c.is("Semi") && !this.c.is("RBrace"));
    return { type: "UpdateFilter", ops, pos };
  }

  /**
   * The bracketed form: a `,` continues the run only when a WRITE follows.
   *
   * A run of writes is one stage and a value after the comma is the next element:
   *   [$.a = 1, ++$.b]        → [{ "$set": { "a": 1, "b": { "$add": ["$b", 1] } } }]
   *   [$.a = 1, $match(…)]    → [{ "$set": { "a": 1 } }, { "$match": … }]
   */
  private writeRun(): UpdateFilter {
    const pos = this.c.peek().pos;
    const ops: UpdateOp[] = [...this.writeGroup()];
    while (this.c.is("Comma") && this.writeAfterComma()) {
      this.c.next();
      ops.push(...this.writeGroup());
    }
    return { type: "UpdateFilter", ops, pos };
  }

  private writeAfterComma(): boolean {
    const save = this.c.mark();
    try {
      this.c.next();
      return this.writeAhead();
    } finally {
      this.c.reset(save);
    }
  }

  private refuseOptionalWriteTarget(target: Expr, pos: number): void {
    const optional =
      (target.type === "MemberAccess" || target.type === "IndexAccess" || target.type === "MethodCall") &&
      target.optional;
    if (optional) {
      throw new ParseError(
        "An optional chain ('?.') cannot be assigned to — JavaScript rejects it. Drop the '?.' to write the field",
        pos,
      );
    }
  }

  // ── expressions: one Pratt loop ───────────────────────────────────────────

  expression(): Expr {
    return this.pratt(1).expr;
  }

  private pratt(minPrec: number): Parsed {
    let left = this.unary();
    for (;;) {
      const rule = INFIX.get(this.c.type);
      // A level of 0 means the row declares no precedence, so it never binds
      // inside an expression — `$.b++` in a value slot is a parse error, not a
      // silently-accepted increment.
      if (rule === undefined || rule.prec === 0 || rule.prec < minPrec) return left;

      // JavaScript forbids the pair outright, at any precedence.
      if (left.rule !== null && rule.noMixWith.includes(left.rule as never)) {
        throw new ParseError(
          `'${this.c.peek().text}' cannot follow '${left.rule}' without parentheses — JavaScript rejects the combination`,
          this.c.peek().pos,
        );
      }

      const op = this.c.next();

      if (rule.fixity === "ternary") {
        const consequent = this.expression();
        this.c.expect("Colon");
        const alternate = this.pratt(rule.prec).expr;
        left = {
          expr: { type: "TernaryExpr", test: left.expr, consequent, alternate, pos: op.pos },
          rule: rule.rules[0],
        };
        continue;
      }

      if (rule.fixity === "postfix") {
        left = { expr: this.tail(left.expr, op, rule.rules), rule: rule.rules[0] };
        continue;
      }

      // `none` means NOT chainable: `a < b < c` is refused rather than grouped.
      if (rule.assoc === "none") {
        const right = this.pratt(rule.prec + 1);
        const next = INFIX.get(this.c.type);
        if (next !== undefined && next.prec === rule.prec) {
          throw new ParseError(
            `'${this.c.peek().text}' does not chain — add parentheses to say which comparison happens first`,
            this.c.peek().pos,
          );
        }
        left = { expr: bin(op, left.expr, right.expr), rule: rule.rules[0] };
        continue;
      }

      const nextMin = rule.assoc === "right" ? rule.prec : rule.prec + 1;
      const right = this.pratt(nextMin);
      if (rule.noMixWith.includes(right.rule as never)) {
        throw new ParseError(
          `'${op.text}' cannot be combined with '${right.rule}' without parentheses — JavaScript rejects it`,
          op.pos,
        );
      }
      left = { expr: bin(op, left.expr, right.expr), rule: rule.rules[0] };
    }
  }

  /** Prefix operators, then an atom, then its postfix chain. */
  private unary(): Parsed {
    const rule = PREFIX.get(this.c.type);
    if (rule !== undefined && rule.prec > 0) {
      const op = this.c.next();
      const argument = this.pratt(rule.prec);
      if (rule.noMixWith.includes(argument.rule as never)) {
        throw new ParseError(
          `'${op.text}' cannot be combined with '${argument.rule}' without parentheses — JavaScript rejects it`,
          op.pos,
        );
      }
      return {
        expr: { type: "UnaryExpr", op: unaryOp(op), argument: argument.expr, pos: op.pos },
        rule: rule.rules[0],
      };
    }
    return { expr: this.postfix(this.atom()), rule: null };
  }

  /** Every `.`, `?.`, `[`, `(` that follows an atom, at the tightest level. */
  private postfix(target: Expr): Expr {
    let out = target;
    for (;;) {
      const rule = INFIX.get(this.c.type);
      if (rule === undefined || rule.prec !== MAX_PRECEDENCE || rule.fixity !== "postfix") return out;
      out = this.tail(out, this.c.next(), rule.rules);
    }
  }

  /** One postfix step. Which node it builds is lookahead, never a name. */
  private tail(object: Expr, op: Token, _rules: readonly string[]): Expr {
    if (op.type === "LParen") {
      const args = this.args("RParen");
      return { type: "CallExpression", callee: object, args, pos: op.pos };
    }
    if (op.type === "LBracket") {
      const index = this.expression();
      this.c.expect("RBracket");
      return { type: "IndexAccess", object, index, optional: false, pos: op.pos };
    }
    const optional = op.type === "QuestDot";
    // `?.[` is an optional index, `?.(` an optional call.
    if (optional && this.c.is("LBracket")) {
      this.c.next();
      const index = this.expression();
      this.c.expect("RBracket");
      return { type: "IndexAccess", object, index, optional: true, pos: op.pos };
    }
    // A stage link spells its name with a leading `$`: `$$.$match(…)`.
    const dollar = this.c.eat("Dollar");
    const name = this.identLike();
    if (this.c.is("LParen")) {
      this.c.next();
      const args = this.args("RParen");
      return { type: "MethodCall", object, name: (dollar ? "$" : "") + name.text, args, optional, pos: op.pos };
    }
    return { type: "MemberAccess", object, name: (dollar ? "$" : "") + name.text, optional, pos: op.pos };
  }

  /** A name, or a reserved word used as one. keywords.ts says which may be. */
  private identLike(): Token {
    const t = this.c.peek();
    if (t.type === "Ident" || this.c.isNameLike()) return this.c.next();
    throw new ParseError(`Expected a name but got ${found(t)}`, t.pos);
  }

  private args(close: "RParen" | "RBracket"): CallArg[] {
    const out: CallArg[] = [];
    if (this.c.type === close) {
      this.c.next();
      return out;
    }
    do {
      if (this.c.is(close)) break;
      if (this.c.is("Spread")) {
        const s = this.c.next();
        out.push({ type: "SpreadElement", argument: this.expression(), pos: s.pos });
        continue;
      }
      out.push(this.expression());
    } while (this.c.eat("Comma"));
    this.c.expect(close);
    return out;
  }

  // ── atoms ─────────────────────────────────────────────────────────────────

  private atom(): Expr {
    const t = this.c.peek();
    switch (t.type) {
      case "Number":
        return this.number();
      case "BigInt":
        this.c.next();
        return { type: "BigIntLiteral", value: t.text, pos: t.pos };
      case "String":
        this.c.next();
        return { type: "StringLiteral", value: t.text, pos: t.pos };
      case "RegexLiteral":
        this.c.next();
        return { type: "RegexLiteral", pattern: t.text, flags: t.flags ?? "", pos: t.pos };
      case "True":
      case "False":
        this.c.next();
        return { type: "BooleanLiteral", value: t.type === "True", pos: t.pos };
      case "Null":
        this.c.next();
        return { type: "NullLiteral", pos: t.pos };
      case "Undefined":
        this.c.next();
        return { type: "UndefinedLiteral", pos: t.pos };
      case "TemplateStart":
        return this.template();
      case "LBracket":
        return this.arrayLiteral();
      case "LBrace":
        return this.objectLiteral();
      case "LParen":
        return this.parenthesised();
      case "DollarDot":
        return this.fieldRef();
      case "Dollar":
        return this.dollar();
      case "DoubleDollar":
        this.c.next();
        return { type: "CollectionRef", pos: t.pos };
      case "TripleDollar":
        this.c.next();
        return { type: "DatabaseRef", pos: t.pos };
      case "QuadDollar":
        this.c.next();
        return { type: "ClusterRef", pos: t.pos };
      case "New": {
        this.c.next();
        const callee = this.postfixName();
        const args = this.c.eat("LParen") ? this.args("RParen") : [];
        return { type: "NewExpression", callee, args, pos: t.pos };
      }
      case "Ident":
        if (WORDS.get(t.text) === "functionBinding") return this.functionExpr();
        return this.identifierOrLambda();
      default:
        throw new ParseError(`Unexpected ${found(t)}`, t.pos);
    }
  }

  /** `0x` with exactly 24 hex digits is an ObjectId; otherwise a number. */
  private number(): Expr {
    const t = this.c.next();
    const hex = /^0[xX]([0-9a-fA-F]+)$/.exec(t.text);
    if (hex !== null && hex[1].length === OBJECT_ID_DIGITS) {
      return { type: "ObjectIdLiteral", hex: hex[1].toLowerCase(), pos: t.pos };
    }
    return { type: "NumberLiteral", value: Number(t.text), pos: t.pos };
  }

  private fieldRef(): Expr {
    const t = this.c.next();
    const first = this.identLike();
    return { type: "FieldRef", path: first.text, pos: t.pos };
  }

  /** A bare `$` is the whole document; `$name(` is the operator escape hatch. */
  private dollar(): Expr {
    const t = this.c.next();
    if (this.c.is("Ident") || this.c.isNameLike()) {
      const name = this.identLike();
      this.c.expect("LParen");
      const args = this.args("RParen");
      const style: "positional" | "object" =
        args.length === 1 && (args[0] as Expr).type === "ObjectLiteral" ? "object" : "positional";
      return { type: "OperatorCall", name: "$" + name.text, style, args, pos: t.pos };
    }
    return { type: "FieldRef", path: "", pos: t.pos };
  }

  private postfixName(): Expr {
    const n = this.identLike();
    return { type: "Ident", name: n.text, pos: n.pos };
  }

  /** `x => …` or a plain name. One token of lookahead separates them. */
  private identifierOrLambda(): Expr {
    const t = this.c.next();
    if (this.c.is("Arrow")) {
      const arrow = this.c.next();
      return this.lambdaBody([t.text], arrow.pos);
    }
    return { type: "Ident", name: t.text, pos: t.pos };
  }

  /** `(a, b) => …`, or a parenthesised expression. Rewound if it is not an arrow. */
  private parenthesised(): Expr {
    const save = this.c.mark();
    const open = this.c.next();
    const params: string[] = [];
    let looksLikeParams = true;
    if (!this.c.is("RParen")) {
      do {
        if (this.c.is("RParen")) break;
        if (!this.c.is("Ident")) {
          looksLikeParams = false;
          break;
        }
        params.push(this.c.next().text);
      } while (this.c.eat("Comma"));
    }
    if (looksLikeParams && this.c.eat("RParen") && this.c.is("Arrow")) {
      const arrow = this.c.next();
      return this.lambdaBody(params, arrow.pos);
    }
    this.c.reset(save);
    this.c.expect("LParen");
    const inner = this.expression();
    this.c.expect("RParen");
    // Parenthesising is what makes an otherwise-refused combination legal, so the
    // group deliberately forgets which rule produced it.
    void open;
    return inner;
  }

  /**
   * A lambda's body. A `{ … }` body is JavaScript — declarations then a `return`.
   * A body of pipeline stages belongs only to a name whose row says
   * `blockBody: "stages"`, which a later phase resolves; the parser records the
   * statements and does not decide.
   */
  private lambdaBody(params: readonly string[], pos: number): Lambda {
    if (!this.c.is("LBrace")) {
      return { type: "Lambda", params, body: this.expression(), pos };
    }
    const open = this.c.next();
    const stmts: PipelineStmt[] = [];
    let ret: Expr | null = null;
    let retPos = open.pos;
    for (;;) {
      while (this.c.eat("Semi")) {
        /* an empty statement is not an error */
      }
      if (this.c.eat("RBrace")) break;
      if (this.c.is("Return")) {
        const r = this.c.next();
        retPos = r.pos;
        ret = this.expression();
        while (this.c.eat("Semi")) {
          /* empty */
        }
        this.c.expect("RBrace");
        break;
      }
      stmts.push(this.statement());
      if (!this.c.eat("Semi") && !this.c.is("RBrace")) {
        throw new ParseError(`Expected ${spell("Semi")} but got ${found(this.c.peek())}`, this.c.peek().pos);
      }
    }
    // A `return` makes the block JavaScript: declarations, then one result.
    if (ret !== null) {
      const decls = stmts.filter((st): st is LetDecl => st.type === "LetDecl");
      if (decls.length !== stmts.length) {
        throw new ParseError("A callback block with a 'return' may only declare values before it", retPos);
      }
      return { type: "Lambda", params, body: { type: "ExprBlock", decls, ret, pos: retPos }, pos };
    }
    // No `return`: the statements are pipeline stages. Whether this name MAY take
    // them is `blockBody` on its row, which a later phase reads — the parser only
    // records what was written.
    return { type: "Lambda", params, stages: { type: "Pipeline", stmts, pos: open.pos }, pos };
  }

  private template(): Expr {
    const start = this.c.next();
    const quasis: string[] = [];
    const exprs: Expr[] = [];
    for (;;) {
      const chunk = this.c.expect("TemplateChars");
      quasis.push(chunk.text);
      if (this.c.eat("TemplateEnd")) break;
      this.c.expect("TemplateExprStart");
      exprs.push(this.expression());
      // The brace that closes an interpolation emits no token — see tokens.ts.
    }
    return { type: "TemplateLiteral", quasis, exprs, pos: start.pos };
  }

  private arrayLiteral(): Expr {
    const open = this.c.next();
    const elements: ArrayElement[] = [];
    if (!this.c.eat("RBracket")) {
      do {
        if (this.c.is("RBracket")) break;
        if (this.c.is("Spread")) {
          const s = this.c.next();
          elements.push({ type: "SpreadElement", argument: this.expression(), pos: s.pos });
          continue;
        }
        elements.push(this.arrayElement());
      } while (this.c.eat("Comma"));
      this.c.expect("RBracket");
    }
    return { type: "ArrayLiteral", elements, pos: open.pos };
  }

  private objectLiteral(): Expr {
    const open = this.c.next();
    const entries: ObjectEntry[] = [];
    if (!this.c.eat("RBrace")) {
      do {
        if (this.c.is("RBrace")) break;
        if (this.c.is("Spread")) {
          const s = this.c.next();
          entries.push({ type: "SpreadElement", argument: this.expression(), pos: s.pos });
          continue;
        }
        entries.push(this.objectEntry());
      } while (this.c.eat("Comma"));
      this.c.expect("RBrace");
    }
    return { type: "ObjectLiteral", entries, pos: open.pos };
  }

  /**
   * One element of an array literal. A declaration or a write makes the literal a
   * bracketed pipeline; anything else is a value.
   */
  private arrayElement(): ArrayElement {
    if (this.c.is("Let") || this.c.is("Const")) return this.binding();
    // `[ function double(x) { … }, $set(…) ]` — a declaration, not a function
    // VALUE. Without this it parsed as a lambda, and the lambda made the literal
    // look like an array of values rather than a pipeline.
    if (this.functionAhead()) return this.functionDecl();
    if (this.writeAhead()) return this.writeRun();
    return this.expression();
  }

  private objectEntry(): KeyValueEntry {
    const t = this.c.peek();
    let key: ObjectKey;
    if (t.type === "LBracket") {
      this.c.next();
      key = { kind: "computed", expr: this.expression() };
      this.c.expect("RBracket");
    } else if (t.type === "String") {
      this.c.next();
      key = { kind: "static", name: t.text };
    } else if (t.type === "Number") {
      // A field name is a string, so a numeric key is its own spelling.
      this.c.next();
      key = { kind: "static", name: String(Number(t.text)) };
    } else if (t.type === "Dollar") {
      // `{ $match: … }` — a raw MQL document, which HR2 requires to round-trip.
      this.c.next();
      key = { kind: "static", name: "$" + this.identLike().text };
    } else {
      key = { kind: "static", name: this.identLike().text };
    }
    // `{ x }` is JavaScript shorthand for `{ x: x }`.
    if (key.kind === "static" && !this.c.is("Colon")) {
      return { type: "KeyValueEntry", key, value: { type: "Ident", name: key.name, pos: t.pos }, pos: t.pos };
    }
    this.c.expect("Colon");
    return { type: "KeyValueEntry", key, value: this.expression(), pos: t.pos };
  }
}

// ── small tables ─────────────────────────────────────────────────────────────

const ASSIGN_OPS: ReadonlyMap<string, AssignOp> = new Map([
  ["Eq", "="],
  ["PlusEq", "+="],
  ["MinusEq", "-="],
  ["StarEq", "*="],
  ["SlashEq", "/="],
  ["PlusPlus", "++"],
  ["MinusMinus", "--"],
]);

const BINARY_BY_TOKEN: ReadonlyMap<string, BinaryOp> = new Map([
  ["QuestQuest", "??"],
  ["PipePipe", "||"],
  ["AmpAmp", "&&"],
  ["Pipe", "|"],
  ["Caret", "^"],
  ["Amp", "&"],
  ["EqEqEq", "==="],
  ["BangEqEq", "!=="],
  ["EqEq", "=="],
  ["BangEq", "!="],
  ["Gt", ">"],
  ["GtEq", ">="],
  ["Lt", "<"],
  ["LtEq", "<="],
  ["In", "in"],
  ["Plus", "+"],
  ["Minus", "-"],
  ["Star", "*"],
  ["Slash", "/"],
  ["Percent", "%"],
  ["StarStar", "**"],
]);

const UNARY_BY_TOKEN: ReadonlyMap<string, UnaryOp> = new Map([
  ["Bang", "!"],
  ["Minus", "-"],
  ["Tilde", "~"],
  ["Typeof", "typeof"],
]);

function bin(op: Token, left: Expr, right: Expr): Expr {
  const o = BINARY_BY_TOKEN.get(op.type);
  if (o === undefined) throw new ParseError(`'${op.text}' is not a binary operator`, op.pos);
  return { type: "BinaryExpr", op: o, left, right, pos: op.pos };
}

function unaryOp(op: Token): UnaryOp {
  const o = UNARY_BY_TOKEN.get(op.type);
  if (o === undefined) throw new ParseError(`'${op.text}' is not a prefix operator`, op.pos);
  return o;
}

export { ParseError };
