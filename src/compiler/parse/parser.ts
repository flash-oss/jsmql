// Phase 2 — PARSE. This phase reads src/registry/productions.ts.
//
// One Pratt loop reads `precedence`, `associativity` and `fixity` off the rows. So
// adding an operator adds a row, and never adds a method.
//
// This file enforces three rules that a precedence number alone cannot express.
// Each rule is stated on the row that owns it:
//   noMixWith          `a ?? b || c` is a JavaScript SyntaxError on either side
//   leftOperandNot     `-a ** 2` is one on the LEFT only; `2 ** -1` is not
//   associativity none `a < b < c` does not chain
//
// The parser is NAME-BLIND. It never compares an identifier to a set. `Math`,
// `String` and a lambda parameter are all `Ident`, and a later phase decides which
// one it is, in names.ts. See src/registry/ast.ts. The one registry fact the
// parser reads about a NAME is `blockBodyOf`, because the callee decides whether a
// `{ … }` callback body is JavaScript or pipeline stages, and only the parser
// holds both the callee and the body at the same time.

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
  Pipeline,
  PipelineStmt,
  UpdateFilter,
  UpdateOp,
  FuncDecl,
} from "../../registry/ast.ts";
import { lex } from "../lex/lexer.ts";
import type { Token } from "../lex/token.ts";
import type { ProductionKey } from "../../registry/productions.ts";
import { blockBodyOf, isKnownName } from "../rows.ts";
import { Cursor, found, ParseError, spell } from "./cursor.ts";
import { freshParam } from "../passes/fresh.ts";
import { replaceIdents } from "../passes/inject.ts";
import { objectIdTypo } from "../objectid-guard.ts";
import {
  ASSIGN_TRIGGERS,
  INFIX,
  MAX_PRECEDENCE,
  mixingRefused,
  NEVER_A_WRITE_TARGET,
  PREFIX,
  SPELLING,
  STATEMENT_PREFIX,
  WORDS,
} from "./tables.ts";

/** How a message names a production: by its spelling, never by its key. */
const spelled = (rule: ProductionKey | null): string => (rule === null ? "" : (SPELLING.get(rule) ?? rule));

/** A `0x` lexeme of exactly this many digits is an ObjectId, not an integer. */
const OBJECT_ID_DIGITS = 24;

type Parsed = {
  expr: Expr;
  /** The rule that produced this node. The mixing rules need it. */ rule: ProductionKey | null;
};

/** "Unexpected token 'x'", or "Unexpected end of input" when the token is the end token. */
const unexpected = (t: { type: string }): string =>
  t.type === "EOF" ? "Unexpected end of input" : `Unexpected token ${found(t as never)}`;

function assertPlausibleObjectId(hex: string, pos: number): void {
  const typo = objectIdTypo(hex);
  if (typo !== null) throw new ParseError(typo, pos);
}

export function parse(source: string): Program {
  const p = new Parser(lex(source));
  const program = p.program();
  p.finish();
  return program;
}

/**
 * The ENTRY form: `(params, { $, … }) => <body>`.
 *
 * This form allows at most two destructures. The one with `$`-prefixed keys is
 * the toolbox. It binds compiler services, and the parser discards it once the
 * body is parsed. The one with bare keys binds query parameters. The KEYS decide
 * which is which, not the position, so the parser catches a "toolbox before
 * params" mistake by name.
 *
 * `destructuringParam` in productions.ts says `notANode` for a reason: the
 * bindings sit BESIDE the tree, never inside it.
 */
export type EntryForm = { params: readonly ParamBinding[]; toolbox: readonly ParamBinding[]; program: Program };

export function parseEntry(source: string): EntryForm {
  const p = new Parser(lex(source));
  const entry = p.entry();
  p.finish();
  return entry;
}

/** This is exposed for the tests, and for phases that already hold tokens. */
export function parseExpression(source: string): Expr {
  const p = new Parser(lex(source));
  const e = p.expression();
  p.expectEnd();
  p.finish();
  return e;
}

/**
 * The wording for a block body with no `return`, when its callee does not take
 * pipeline stages. This covers every method except the one whose row says
 * `blockBody: "stages"`.
 */
const needsReturn = (pos: number, got: string): string =>
  `A block body must end with a \`return <expr>\` statement at position ${pos}, got ${got}. Write \`x => { const a = …; return <expr>; }\` / ` +
  "`function f(x) { return <expr>; }`, or `x => (<expr>)` to return an object/expression directly";

/** How a message spells a statement that stands where a callback's declarations go. */
/** A statement that IS a pipeline statement: a stage call, a bare call such as `assert(…)`, a write, or a function declaration. This excludes a stray expression (`d.v;`). */
function isStageStmt(stmt: PipelineStmt): boolean {
  const s = stmt as { type: string };
  return s.type === "OperatorCall" || s.type === "UpdateFilter" || s.type === "CallExpression" || s.type === "FuncDecl";
}

function statementSpelling(stmt: PipelineStmt): string {
  const s = stmt as {
    type: string;
    name?: string;
    ops?: readonly { type: string; target?: Expr }[];
    callee?: Expr;
    form?: "arrow" | "function";
    kind?: "let" | "const";
  };
  switch (s.type) {
    case "OperatorCall":
      return `${s.name}(...)`;
    case "FuncDecl":
      // One node has two spellings. A developer cannot find `function g(` in a program that says `const g = `.
      return s.form === "function" ? `function ${s.name}(…) { … }` : `${s.kind} ${s.name} = (…) => …`;
    case "UpdateFilter": {
      const op = s.ops?.[0];
      const target = op?.target === undefined ? "$.x" : targetSpelling(op.target);
      return op?.type === "DeleteStmt" ? `delete ${target}` : `${target} = …`;
    }
    case "CallExpression":
      return s.callee?.type === "Ident" ? `${(s.callee as { name: string }).name}(...)` : "…(...)";
    default:
      return "…";
  }
}

/**
 * A pipeline statement found inside a callback's `{ … }`. `retPos` gives the
 * position of the block's `return`, or is null when the block has none. The two
 * cases have different ways out, and a declaration has a third way out.
 */
function notPartOfACallback(stmt: PipelineStmt, retPos: number | null): string {
  const wrote = statementSpelling(stmt);
  if (stmt.type === "FuncDecl") {
    return `\`${wrote}\` declares a reusable function, and a reusable function is declared at the top level of a pipeline, not inside a callback. Write \`${wrote};\` as its own statement before this one, then call '${stmt.name}(…)' inside the callback.`;
  }
  // '.aggregate' is the one method whose block IS a list of stages, so every way
  // out names it. Deleting only the 'return' leaves the same block on the same
  // method, and the parser refuses it again. The stages must MOVE.
  const stages = `'.aggregate((o) => { ${wrote}; … })'`;
  const link = stmt.type === "OperatorCall" ? `'$$.$${(stmt as { name: string }).name.replace(/^\$/, "")}(…)'` : null;
  const chain = link === null ? "" : ` Over the stream a stage is also a chain link: ${link}.`;
  if (retPos !== null) {
    return `\`${wrote}\` at position ${(stmt as { pos: number }).pos} is a pipeline stage, and the 'return' at position ${retPos} makes this block a value callback. One block cannot be both. Move the stages to ${stages}, which takes a block of stages and no 'return'; or delete the stage and fold its work into the 'return'.${chain}`;
  }
  return `\`${wrote}\` is a pipeline stage, not part of a callback — a callback's block holds declarations and a 'return'. Move the stages to ${stages}, the one method whose block is a list of stages.${chain}`;
}

/** `$.a.b` for a field target, or the bare name otherwise. */
function targetSpelling(target: Expr): string {
  if (target.type === "FieldRef") return target.path === "" ? "$" : `$.${target.path}`;
  if (target.type === "Ident") return target.name;
  if (target.type === "MemberAccess") return `${targetSpelling(target.object)}.${target.name}`;
  return "…";
}

/** What one `{ … }` block held: its statements, an optional `return`, and whether a `;` ended a statement. */
type Block = { stmts: PipelineStmt[]; ret: Expr | null; retPos: number; sawSemi: boolean; endPos: number };

/** One name that a destructuring pattern binds: the element part it reads (`key`, an index or a field), and where the developer wrote it. */
type PatternPart = { readonly key: string; readonly name: string; readonly pos: number };

/**
 * A parameter as written: a plain name, or a pattern of plain names. An array
 * pattern's elisions are null. `refused` is a pattern that JSMQL does not accept,
 * paired with the error to throw once an arrow follows. `null` means this is not
 * a parameter at all.
 */
type ParamRead =
  | { readonly kind: "name"; readonly name: string }
  | { readonly kind: "array"; readonly parts: readonly (PatternPart | null)[]; readonly pos: number }
  | { readonly kind: "object"; readonly parts: readonly PatternPart[]; readonly pos: number }
  | { readonly kind: "refused"; readonly error: ParseError }
  | null;

/** A destructured parameter that is not a pattern of plain names: a default, a rest element, a nested pattern, or a computed key. */
function notAPlainPattern(pos: number, wrote?: string): ParseError {
  const got = wrote === undefined ? "" : ` ('${wrote}')`;
  return new ParseError(
    `A destructured parameter lists plain names only — '([id, count]) => …', '({ sku, qty: n }) => …'. A default value, a rest element, a nested pattern or a computed key${got} is not one of them at position ${pos}. Name the parameter and read its parts: 'x => x[0]', 'x => x.sku ?? 1', 'x => x.slice(1)'.`,
    pos,
  );
}

class Parser {
  private readonly c: Cursor;
  /**
   * Every lambda whose `{ … }` body had no `return`, and so the parser read it as
   * pipeline STAGES, minus the ones a stages-taking callee has claimed. Whatever
   * is left when the parse ends is a JavaScript block that forgot its `return`,
   * and the parser refuses it with the callee-independent wording. This is a set,
   * not a flag threaded through every expression method, because the parser
   * builds the body many calls below the callee that decides what it means.
   */
  private readonly unclaimedStages = new Map<Lambda, number>();

  constructor(toks: readonly Token[]) {
    this.c = new Cursor(toks);
  }

  expectEnd(): void {
    if (!this.c.is("EOF")) {
      throw new ParseError(`${unexpected(this.c.peek())}`, this.c.peek().pos);
    }
  }

  /** The checks that need the WHOLE tree. This runs once, after the entry method returns. */
  finish(): void {
    const first = this.unclaimedStages.entries().next();
    if (first.done) return;
    const [lambda, endPos] = first.value;
    // A block whose statement is a STAGE is not a block that forgot its `return`.
    // The developer wrote a pipeline where a callback goes, and the message says
    // where the pipeline belongs.
    const stmt = lambda.stages?.stmts.find((st) => st.type !== "LetDecl");
    if (stmt !== undefined && isStageStmt(stmt)) {
      throw new ParseError(notPartOfACallback(stmt, null), (stmt as { pos: number }).pos);
    }
    throw new ParseError(needsReturn(endPos, "'}'"), endPos);
  }

  // ── the entry form ────────────────────────────────────────────────────────

  entry(): EntryForm {
    // `function [name](…) { … }` is the second spelling of the entry arrow. The parser cannot reach the name inside, and drops it.
    const isFunction = this.c.is("Ident") && this.c.peek().text === "function";
    if (isFunction) {
      this.c.next();
      if (this.c.is("Ident")) this.c.next();
    }
    const open = this.c.expect("LParen");
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
        slots[2][0]?.pos ?? open.pos,
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
    if (!isFunction) this.c.expect("Arrow");
    // The body is a whole program: an expression, or `{ … }` that holds statements.
    // A `function` body is always the block form.
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
        // `{ a = 1 }`: a value reaches a compiled query only through the params object, at call time.
        if (this.c.is("Eq")) {
          throw new ParseError(
            `A default value in the params destructure is not supported ('${key.text} = …'). Apply the default where the query is called, with JS's \`??\` at the call site — q({ ${key.text}: input ?? <default> }) — or write the value into the template-tag form.`,
            this.c.peek().pos,
          );
        }
        out.push({ key: key.text, name, pos: key.pos });
      } while (this.c.eat("Comma"));
      this.c.expect("RBrace");
    }
    if (out.length === 0) throw new ParseError("An empty destructure binds nothing", open.pos);
    return out;
  }

  /**
   * A destructure key: a bare name, or one member of the `$` family. `$name` is an
   * operator handle, and the bare `$`, `$$`, `$$$`, `$$$$` are the context refs.
   * Each is its own token, so the parser matches each on its own, not by spelling.
   */
  private destructureKey(): Token {
    const t = this.c.peek();
    if (t.type === "Dollar") {
      this.c.next();
      // `$abs` is one key. A lone `$` is the document handle.
      return this.c.is("Ident") ? this.dollarName(t) : t;
    }
    if (t.type === "DoubleDollar" || t.type === "TripleDollar" || t.type === "QuadDollar") {
      this.c.next();
      return t;
    }
    return this.identLike();
  }

  /**
   * `$` followed by a name, joined into one `$name` token. Four places ask for
   * this: a destructure key, the operator escape hatch, a chained stage link and a
   * raw MQL key. This is one method, because four copies of "read the name after
   * `$`" once used two different rules about which names count.
   *
   * The `$` is already consumed at this point. The lexer reads the word after a
   * `$` as a plain `Ident` whatever it spells (`$in`, `$let`), so no keyword case
   * exists here.
   */
  private dollarName(dollar: Token): Token {
    const name = this.c.expect("Ident");
    // `$ abs(1)` is not JavaScript. The sigil and its name form one identifier.
    if (name.pos !== dollar.end) {
      throw new ParseError(`Expected a name directly after '$', with no space — write '$${name.text}'`, name.pos);
    }
    return { ...dollar, text: "$" + name.text, end: name.end };
  }

  /** `{ … }` as an entry body: statements, with an optional trailing `return`. */
  private entryBlock(): Program {
    this.c.expect("LBrace");
    const { stmts, ret, retPos, sawSemi } = this.block("RBrace");
    if (ret !== null) {
      // A `return` in an entry block yields the expression itself. So a bare
      // predicate stays a predicate, and the position phase reads it as a Filter.
      if (stmts.length > 0) {
        throw new ParseError("A 'return' here isn't a jsmql statement — put the whole predicate in the return", retPos);
      }
      return ret;
    }
    return this.collapse(stmts, sawSemi);
  }

  // ── the whole input ───────────────────────────────────────────────────────

  program(): Program {
    const { stmts, sawSemi } = this.block("EOF");
    return this.collapse(stmts, sawSemi);
  }

  /**
   * A lone statement stands on its own, so the shape phase can read it as a
   * Filter. A lone declaration cannot, because nothing would read it. Nor can a
   * statement that the source ENDED with a `;`, because that `;` is the token
   * that says pipeline. Collapsing it away lost the distinction:
   *   Object.assign($.a, $.b)    a value, and a Filter
   *   Object.assign($.a, $.b);   a write, and a Pipeline
   * both parsed to the same tree, and nothing downstream could tell them apart.
   *
   * This is ONE rule for the top level and the entry block. So `({ $ }) => { X }`
   * means exactly what `X` means, `;` included.
   */
  private collapse(stmts: PipelineStmt[], sawSemi: boolean): Program {
    if (stmts.length === 1 && !sawSemi) {
      const only = stmts[0];
      if (only.type !== "LetDecl" && only.type !== "FuncDecl") return only;
    }
    return { type: "Pipeline", stmts, pos: stmts[0]?.pos ?? 0 };
  }

  /**
   * THE statement loop, up to `terminator`. This is one loop for the three places
   * that hold statements: the top level, an entry block and a callback block. So
   * a new separator rule cannot land on one and stay forgotten in the others.
   *
   * A `return` may appear only where a `}` closes the block. At the top level it
   * reaches `statement()`, and the parser refuses it as an unexpected token.
   */
  private block(terminator: "RBrace" | "EOF"): Block {
    const stmts: PipelineStmt[] = [];
    let sawSemi = false;
    let endPos = this.c.peek().pos;
    for (;;) {
      // An empty statement is not an error. A `;` anywhere, a leading one included,
      // is the token that says pipeline.
      while (this.c.eat("Semi")) sawSemi = true;
      if (this.c.is(terminator)) {
        endPos = this.c.peek().pos;
        if (terminator === "RBrace") this.c.next();
        break;
      }
      if (terminator === "RBrace" && this.c.is("Return")) {
        const r = this.c.next();
        const ret = this.expression();
        while (this.c.eat("Semi")) {
          /* empty */
        }
        const close = this.c.expect("RBrace");
        return { stmts, ret, retPos: r.pos, sawSemi, endPos: close.pos };
      }
      // A declaration list is one statement per declarator, so a run comes back.
      const run = this.statement();
      const st = run[0];
      // `x => { k: x }`: JavaScript reads `k:` as a label, but the developer meant
      // an object. The message says so, with the spelling that returns one.
      if (terminator === "RBrace" && st.type === "Ident" && this.c.is("Colon")) {
        throw new ParseError(needsReturn(st.pos, `an identifier '${st.name}'`), st.pos);
      }
      stmts.push(...run);
      // `function f(x) { … }` ends with its closing brace, so the separator after
      // it is optional. This is the same rule that JavaScript uses.
      const blockBodied = st.type === "FuncDecl" && st.form === "function";
      if (this.c.is("Semi")) sawSemi = true;
      if (!this.c.eat("Semi") && !this.c.is(terminator) && !blockBodied) {
        throw new ParseError(`Expected ${spell("Semi")} but got ${found(this.c.peek())}`, this.c.peek().pos);
      }
    }
    return { stmts, ret: null, retPos: 0, sawSemi, endPos };
  }

  /**
   * One statement, or the RUN of statements that a declaration list stands for.
   * `const a = …, b = …;` is N declarations in JavaScript, and N declarations here
   * too.
   */
  private statement(): PipelineStmt[] {
    if (this.c.is("Let") || this.c.is("Const")) return this.bindings();
    this.refuseAsync();
    if (this.functionAhead()) return [this.functionDecl()];
    if (this.writeAhead()) return [this.writes()];
    return [this.expression()];
  }

  /** Is a `function` declaration next? The word comes from its row's `word`. */
  private functionAhead(): boolean {
    return this.c.is("Ident") && WORDS.get(this.c.peek().text) === "functionBinding" && this.c.peek(1).type === "Ident";
  }

  /**
   * `function*` marks a generator. MQL evaluates an expression, and has no way to
   * suspend one, so the star has no meaning here, though the plain forms do. The
   * parser refuses it where the star sits, not as a stray token that trips it up.
   */
  private refuseGenerator(): void {
    if (!this.c.is("Star")) return;
    throw new ParseError(
      `jsmql does not support generator functions ('function*') at position ${this.c.peek().pos}. Write a plain 'function (…) { return <expr>; }' or an arrow '(…) => <expr>'.`,
      this.c.peek().pos,
    );
  }

  /**
   * `async function` marks a promise. MQL evaluates an expression and has nothing
   * to await, so the word has no meaning here. The parser refuses it where it
   * sits, beside the generator refusal, not as a stray token further along.
   */
  private refuseAsync(): void {
    const t = this.c.peek();
    if (t.type !== "Ident" || t.text !== "async") return;
    if (WORDS.get(this.c.peek(1).text ?? "") !== "functionBinding") return;
    throw new ParseError(
      `jsmql does not support async functions ('async function') at position ${t.pos}. Write a plain 'function (…) { return <expr>; }' or an arrow '(…) => <expr>'.`,
      t.pos,
    );
  }

  /** `function name(params) { … }` builds the same node that the arrow spelling builds. */
  private functionDecl(): FuncDecl {
    const kw = this.c.next();
    this.refuseGenerator();
    const name = this.c.expect("Ident");
    const params = this.paramList();
    const lambda = this.lambdaOf(params, kw.pos);
    return { type: "FuncDecl", name: name.text, lambda, kind: "const", form: "function", group: kw.pos, pos: kw.pos };
  }

  /** `(a, [b, c], { d },)`: a parenthesised parameter list. Names and patterns match the arrow's, and a trailing comma is allowed. */
  private paramList(): ParamRead[] {
    this.c.expect("LParen");
    const out: ParamRead[] = [];
    if (!this.c.eat("RParen")) {
      do {
        if (this.c.is("RParen")) break;
        const p = this.param();
        if (p === null) this.c.expect("Ident");
        out.push(p);
      } while (this.c.eat("Comma"));
      this.c.expect("RParen");
    }
    return out;
  }

  /**
   * `function (x) { … }` or `function name(x) { … }` in a VALUE slot. Both build
   * the same Lambda that the arrow spelling builds. The parser ignores the name,
   * if the developer wrote one.
   */
  private functionExpr(): Lambda {
    const kw = this.c.next();
    this.refuseGenerator();
    if (this.c.is("Ident")) this.c.next();
    const params = this.paramList();
    return this.lambdaOf(params, kw.pos);
  }

  /**
   * `let x = …, y = …` / `const x = …, y = …`: JavaScript's declaration list,
   * wherever `;` separates statements. Each declarator becomes its own
   * declaration, and reads the ones before it. The KEYWORD's offset marks them as
   * ONE declaration. This lets the emit phase give them one stage, and stops a
   * folded-away neighbour from bridging a `;` that the developer wrote.
   * See docs/specs/let-bindings.md.
   */
  private bindings(): (LetDecl | FuncDecl)[] {
    const kw = this.c.next();
    const kind = kw.type === "Const" ? "const" : "let";
    const out = [this.declarator(kind, kw.pos, kw.pos)];
    while (this.c.eat("Comma")) out.push(this.declarator(kind, null, kw.pos));
    return out;
  }

  /** `let x = …` / `const x = …`, one declarator: a bracketed pipeline's element, where `,` separates elements. */
  private binding(): LetDecl | FuncDecl {
    const kw = this.c.next();
    return this.declarator(kw.type === "Const" ? "const" : "let", kw.pos, kw.pos);
  }

  /**
   * One declarator, after the keyword. `kwPos` places the FIRST declarator at the
   * keyword, and every later declarator at its own name. So an error underlines
   * the declarator it is about. A function body makes this a FuncDecl.
   */
  private declarator(kind: "let" | "const", kwPos: number | null, group: number): LetDecl | FuncDecl {
    const name = this.c.expect("Ident");
    const pos = kwPos ?? name.pos;
    // `let a;` / `let a, b;`: a binding is a value, and MQL has no undefined to
    // hold the place of one. The parser refuses this where the initialiser belongs.
    if (!this.c.is("Eq")) {
      throw new ParseError(
        `'${kind} ${name.text}' binds no value at position ${pos}. jsmql has no 'undefined' to bind — write '${kind} ${name.text} = <expr>'.`,
        pos,
      );
    }
    this.c.next();
    const value = this.expression();
    if (value.type === "Lambda") {
      return { type: "FuncDecl", name: name.text, lambda: value, kind, form: "arrow", group, pos };
    }
    return { type: "LetDecl", name: name.text, value, kind, group, pos } satisfies LetDecl;
  }

  // ── writes ────────────────────────────────────────────────────────────────
  //
  // Whether the source is a write is a question about the LEXEMES ahead, not
  // about meaning. So the parser answers it by lookahead over the triggers that
  // the rows state: `STATEMENT_PREFIX` opens one (`delete`, `++`, `--`), and
  // `ASSIGN_TRIGGERS` follows an expression to make one (`=`, `+=`, …).

  /** `($.a = 1)`: a write inside parentheses, which `writeGroup()` handles. */
  private parenWriteAhead(): boolean {
    const save = this.c.mark();
    try {
      // `(($.a = 1), ($.b = 2))`: the parser skips every opening parenthesis before the look.
      while (this.c.is("LParen")) this.c.next();
      return STATEMENT_PREFIX.has(this.c.type) || this.startsAWrite();
    } finally {
      this.c.reset(save);
    }
  }

  /**
   * A write starts here. Three places ask this: a `;` statement, an array
   * element, and after a `,` inside brackets. So this is one predicate. Three
   * copies of the condition once let the array form miss the `(`-wrapped
   * spelling that the other two accepted.
   */
  private writeAhead(): boolean {
    if (STATEMENT_PREFIX.has(this.c.type)) return true;
    // `($.a = 1)` is a write inside the parentheses. `($.a) = 1` is a write whose
    // TARGET is parenthesised: legal JavaScript, and a different lookahead.
    if (this.c.is("LParen")) return this.parenWriteAhead() || this.startsAWrite();
    return this.startsAWrite();
  }

  /**
   * Does the expression that starts here end in an assignment? This is a SCAN of
   * the tokens to the end of the expression, the first `,` / `;` / closing
   * bracket at depth zero, that looks for an assignment operator at depth zero.
   * It is a scan, not a speculative parse. A speculative parse here doubled the
   * work at every nesting level, exponential on `[[[…]]]`, and swallowed every
   * error that the speculation raised.
   */
  private startsAWrite(): boolean {
    const save = this.c.mark();
    try {
      let depth = 0;
      for (;;) {
        const t = this.c.peek();
        if (t.type === "EOF") return false;
        if (t.type === "LParen" || t.type === "LBracket" || t.type === "LBrace") depth++;
        else if (t.type === "RParen" || t.type === "RBracket" || t.type === "RBrace") {
          if (depth === 0) return false;
          depth--;
        } else if (depth === 0) {
          if (t.type === "Comma" || t.type === "Semi") return false;
          if (ASSIGN_TRIGGERS.has(t.type)) return true;
        }
        this.c.next();
      }
    } finally {
      this.c.reset(save);
    }
  }

  /**
   * ONE write, or a parenthesised group of writes.
   *
   * A formatter writes `($.a = 1, $.b = 2)`. Inside the parentheses, a `,`
   * always continues the group, because the `)` is what ends it. Outside them,
   * the `,` means different things to the two callers below. That is the whole
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
      const target = this.pratt(1);
      // `delete a?.b` is legal JavaScript, unlike `a?.b = 1`. So only the
      // "is it a place at all" half of the check applies here.
      this.requirePlace(target, kw.pos, "delete");
      return [{ type: "DeleteStmt", target: target.expr, pos: kw.pos }];
    }
    // `++$.a` and `$.a++` mean the same write. The row says `prefixOrPostfix`.
    const prefix = this.c.is("PlusPlus") || this.c.is("MinusMinus") ? this.c.next() : null;
    const target = this.pratt(1);
    const op = prefix ?? this.c.next();
    if (!ASSIGN_TRIGGERS.has(op.type)) {
      throw new ParseError(`Expected an assignment but got ${found(op)}`, op.pos);
    }
    // The token's own text IS the spelling: `=`, `+=`, `++`. So no table maps
    // a token type back to the operator it was lexed from.
    const spelling = op.text as AssignOp;
    this.requireWriteTarget(target, op.pos, spelling);
    // `$.a = $.b = 1`: every target in the chain takes the SAME value. So the
    // chain is one write per target, not a nested assignment expression.
    if (spelling === "=") {
      const targets = [target.expr];
      let value = this.pratt(1);
      while (this.c.is("Eq")) {
        const eq = this.c.next();
        this.requireWriteTarget(value, eq.pos, "=");
        targets.push(value.expr);
        value = this.pratt(1);
      }
      return targets.map((t) => ({ type: "AssignExpr", target: t, op: "=" as const, value: value.expr, pos: op.pos }));
    }
    const value = spelling === "++" || spelling === "--" ? target.expr : this.expression();
    return [{ type: "AssignExpr", target: target.expr, op: spelling, value, pos: op.pos }];
  }

  /** The `;` form: a `,` continues the run until the `;` or the end of input. */
  private writes(): UpdateFilter {
    const pos = this.c.peek().pos;
    const ops: UpdateOp[] = [];
    do {
      ops.push(...this.writeGroup());
      // `}` ends the run as surely as `;` does. A callback block is a statement
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

  /**
   * A write target must be a PLACE: a field, a binding, `$`, `$$`, or a chain of
   * accesses on one. `$.a + 1 = 2`, `1 = 2` and `f() = 1` are not places.
   * JavaScript refuses them, and so does JSMQL.
   */
  private requirePlace(target: Parsed, pos: number, op: string): void {
    const t = target.expr.type;
    const isPlace =
      t === "FieldRef" ||
      t === "Ident" ||
      t === "MemberAccess" ||
      t === "IndexAccess" ||
      t === "CollectionRef" ||
      t === "DatabaseRef" ||
      t === "ClusterRef";
    if (isPlace) return;
    // A method call is spelled by the CALL that the source wrote, not by the rule that built its receiver.
    // `$.s.trim()` is a `MethodCall` node whose rule is `.field`, and "a '.field' expression" is a form
    // that the reader never typed.
    if (target.expr.type === "MethodCall") {
      const call = `.${target.expr.wrote ?? target.expr.name}()`;
      throw new ParseError(
        `Cannot apply '${op}' to the result of '${call}' at position ${pos} — only a field, a binding, '$', '$$' or a collection can be written. Write the result to a field instead: '$.<field> = <receiver>${call};'.`,
        pos,
      );
    }
    const what = target.rule === null ? `a ${t}` : `a '${spelled(target.rule)}' expression`;
    throw new ParseError(
      `Cannot apply '${op}' to ${what} — only a field, a binding, '$', '$$' or a collection can be written`,
      pos,
    );
  }

  /**
   * A write target must be a place, and the rule that built it must allow a
   * write. `a?.b = 1` is a JavaScript SyntaxError, wherever the `?.` sits in the
   * chain, and the `optionalMemberAccess` row states this with `neverAWriteTarget`.
   * This method reads the row rather than testing `.optional`. So the next rule
   * that says so needs no branch here.
   */
  private requireWriteTarget(target: Parsed, pos: number, op: string): void {
    this.requirePlace(target, pos, op);
    if (target.rule === null) return;
    const refusal = NEVER_A_WRITE_TARGET.get(target.rule);
    if (refusal === undefined) return;
    throw new ParseError(`'${refusal.spelling}' cannot be assigned to — JavaScript rejects it. ${refusal.hint}`, pos);
  }

  // ── expressions: one Pratt loop ───────────────────────────────────────────

  /** The parser refuses nesting deeper than this, before the call stack does. This marks a hostile input, not a query. */
  private static readonly MAX_DEPTH = 200;
  private depth = 0;

  expression(): Expr {
    if (++this.depth > Parser.MAX_DEPTH) {
      const pos = this.c.peek().pos;
      throw new ParseError(
        `The expression nests too deeply (more than ${Parser.MAX_DEPTH} levels) at position ${pos}`,
        pos,
      );
    }
    try {
      return this.pratt(1).expr;
    } finally {
      this.depth--;
    }
  }

  private pratt(minPrec: number): Parsed {
    let left = this.unary();
    for (;;) {
      const rule = INFIX.get(this.c.type);
      // A level of 0 means the row declares no precedence, so it never binds
      // inside an expression. `$.b++` in a value slot is a parse error, not a
      // silently-accepted increment.
      if (rule === undefined || rule.prec === 0 || rule.prec < minPrec) return left;

      // JavaScript forbids the pair outright, at any precedence level.
      if (mixingRefused(rule, left.rule, "left")) {
        throw new ParseError(
          `'${this.c.peek().text}' cannot be combined with '${spelled(left.rule)}' without parentheses — JavaScript rejects it`,
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
        left = this.tail(left.expr, op);
        continue;
      }

      // `none` means NOT chainable. The parser refuses `a < b < c` rather than grouping it.
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
      if (mixingRefused(rule, right.rule, "right")) {
        throw new ParseError(
          `'${op.text}' cannot be combined with '${spelled(right.rule)}' without parentheses — JavaScript rejects it`,
          op.pos,
        );
      }
      left = { expr: bin(op, left.expr, right.expr), rule: rule.rules[0] };
    }
  }

  /** Reads prefix operators, then an atom, then its postfix chain. */
  private unary(): Parsed {
    const rule = PREFIX.get(this.c.type);
    if (rule !== undefined && rule.prec > 0) {
      const op = this.c.next();
      const argument = this.pratt(rule.prec);
      // A prefix operator's operand stands on its RIGHT side.
      if (mixingRefused(rule, argument.rule, "right")) {
        throw new ParseError(
          `'${op.text}' cannot be combined with '${spelled(argument.rule)}' without parentheses — JavaScript rejects it`,
          op.pos,
        );
      }
      return {
        // The token's own text is the operator: `!`, `-`, `~`, `typeof`.
        expr: { type: "UnaryExpr", op: op.text as UnaryOp, argument: argument.expr, pos: op.pos },
        rule: rule.rules[0],
      };
    }
    return this.postfix(this.atom());
  }

  /** Reads every `.`, `?.`, `[`, `(` that follows an atom, at the tightest level. */
  private postfix(target: Expr): Parsed {
    let out: Parsed = { expr: target, rule: null };
    for (;;) {
      const rule = INFIX.get(this.c.type);
      if (rule === undefined || rule.prec !== MAX_PRECEDENCE || rule.fixity !== "postfix") return out;
      // Once a `?.` appears, the whole chain is an OPTIONAL CHAIN in JavaScript. So
      // the reported rule stays through every later link: `a?.b.c = 1` is as
      // much a SyntaxError as `a?.b = 1`.
      const next = this.tail(out.expr, this.c.next());
      out = out.rule === "optionalMemberAccess" ? { expr: next.expr, rule: out.rule } : next;
    }
  }

  /**
   * One postfix step. Lookahead decides which node it builds, never a name. The
   * rule it reports is the one that DISTINGUISHES the step (`optionalMemberAccess`
   * for `?.`). So a write can ask whether its target may be one.
   */
  private tail(object: Expr, op: Token): Parsed {
    if (op.type === "LParen") {
      const args = this.args("RParen", null);
      return { expr: { type: "CallExpression", callee: object, args, pos: op.pos }, rule: "call" };
    }
    if (op.type === "LBracket") {
      const index = this.expression();
      this.c.expect("RBracket");
      return { expr: { type: "IndexAccess", object, index, optional: false, pos: op.pos }, rule: "indexAccess" };
    }
    const optional = op.type === "QuestDot";
    const rule = optional ? "optionalMemberAccess" : "memberAccess";
    // `?.[` marks an optional index. `?.(` marks an optional call.
    if (optional && this.c.is("LBracket")) {
      this.c.next();
      const index = this.expression();
      this.c.expect("RBracket");
      return { expr: { type: "IndexAccess", object, index, optional: true, pos: op.pos }, rule };
    }
    // A stage link's name has a leading `$`: `$$.$match(…)`.
    const dollar = this.c.is("Dollar") ? this.c.next() : null;
    const name = dollar === null ? this.identLike() : this.dollarName(dollar);
    if (this.c.is("LParen")) {
      this.c.next();
      const args = this.args("RParen", name.text);
      return { expr: { type: "MethodCall", object, name: name.text, args, optional, pos: op.pos }, rule };
    }
    return { expr: { type: "MemberAccess", object, name: name.text, optional, pos: op.pos }, rule };
  }

  /**
   * A name, or a reserved word used as one. Every keyword qualifies in a place
   * that expects a name, such as `{ null: 1 }` or `$let({ in: … })`, because
   * JavaScript allows any IdentifierName there, and a field can be named anything.
   */
  private identLike(): Token {
    const t = this.c.peek();
    if (t.type === "Ident" || this.c.isNameLike()) return this.c.next();
    throw new ParseError(`Expected a name but got ${found(t)}`, t.pos);
  }

  /**
   * A call's arguments. `owner` is the name that the source calls, or null for a
   * callee that is not a name (`f(…)`, `new X(…)`, `$op(…)`). A `{ … }` callback
   * body with no `return` is pipeline STAGES only under an owner whose row says
   * `blockBody: "stages"`. Every other owner's block is JavaScript, and needs its
   * `return`. This method records the claim, and `finish()` refuses what nobody claimed.
   */
  private args(close: "RParen" | "RBracket", owner: string | null): CallArg[] {
    const out: CallArg[] = [];
    if (this.c.type === close) {
      this.c.next();
      return out;
    }
    const takesStages = owner !== null && blockBodyOf(owner) === "stages";
    do {
      if (this.c.is(close)) break;
      if (this.c.is("Spread")) {
        const s = this.c.next();
        out.push({ type: "SpreadElement", argument: this.expression(), pos: s.pos });
        continue;
      }
      const arg = this.expression();
      // A callee that takes stages claims the block. An UNKNOWN callee (a typo) leaves it
      // unclaimed but unrefused. The emit phase then names the nearest method, which is the mistake.
      if (
        arg.type === "Lambda" &&
        arg.stages !== undefined &&
        (takesStages || (owner !== null && !isKnownName(owner)))
      ) {
        this.unclaimedStages.delete(arg);
      }
      out.push(arg);
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
        const args = this.c.eat("LParen") ? this.args("RParen", null) : [];
        return { type: "NewExpression", callee, args, pos: t.pos };
      }
      case "Ident":
        this.refuseAsync();
        if (WORDS.get(t.text) === "functionBinding") return this.functionExpr();
        return this.identifierOrLambda();
      default:
        throw new ParseError(`${unexpected(t)}`, t.pos);
    }
  }

  /**
   * `0x` with exactly 24 hex digits is an ObjectId. Any other hex run is an
   * integer, and the parser accepts it only while it fits a double exactly. A
   * longer run would lose precision silently, and is neither an id nor a number
   * that JavaScript can hold. The parser refuses it, and names the two spellings
   * that work.
   */
  private number(): Expr {
    const t = this.c.next();
    const hex = /^0[xX]([0-9a-fA-F]+)$/.exec(t.text.replace(/_/g, ""));
    if (hex === null) return { type: "NumberLiteral", value: Number(t.text), pos: t.pos };
    if (hex[1].length === OBJECT_ID_DIGITS) {
      assertPlausibleObjectId(hex[1].toLowerCase(), t.pos);
      return { type: "ObjectIdLiteral", hex: hex[1].toLowerCase(), pos: t.pos };
    }
    const big = BigInt("0x" + hex[1]);
    if (big <= BigInt(Number.MAX_SAFE_INTEGER)) return { type: "NumberLiteral", value: Number(big), pos: t.pos };
    throw new ParseError(
      `Hex literal '${t.text}' at position ${t.pos} has ${hex[1].length} digits — neither a 24-character ObjectId nor an integer that fits Number.MAX_SAFE_INTEGER. Paste a 24-character hex string for an ObjectId, or use a decimal literal.`,
      t.pos,
    );
  }

  /**
   * `$.name` is a field of the document. `$.name(…)` is a METHOD on the document
   * itself, because a field is never callable, so the parentheses can mean
   * nothing else. The receiver is the bare `$`, an empty-path `FieldRef`, the same
   * node that the emitter already types as a document.
   */
  private fieldRef(): Expr {
    const t = this.c.next();
    const first = this.identLike();
    if (this.c.is("LParen")) {
      this.c.next();
      const args = this.args("RParen", first.text);
      const object: Expr = { type: "FieldRef", path: "", pos: t.pos };
      // `$.` is one token. Its `.`, where every other method call points, is its second character.
      return { type: "MethodCall", object, name: first.text, args, optional: false, pos: t.pos + 1 };
    }
    return { type: "FieldRef", path: first.text, pos: t.pos };
  }

  /**
   * A bare `$` is the whole document. `$name(` is the operator escape hatch. The
   * parser does not record how the arguments were written. The operator's row
   * states its shape, and one object argument is a body only by that shape, never
   * by a guess here.
   */
  private dollar(): Expr {
    const t = this.c.next();
    if (this.c.is("Ident")) {
      const name = this.dollarName(t);
      this.c.expect("LParen");
      const args = this.args("RParen", null);
      return { type: "OperatorCall", name: name.text, args, pos: t.pos };
    }
    return { type: "FieldRef", path: "", pos: t.pos };
  }

  private postfixName(): Expr {
    const n = this.identLike();
    return { type: "Ident", name: n.text, pos: n.pos };
  }

  /** `x => …` or a plain name. One token of lookahead tells them apart. */
  private identifierOrLambda(): Expr {
    const t = this.c.next();
    if (this.c.is("Arrow")) {
      const arrow = this.c.next();
      return this.lambdaBody([t.text], arrow.pos);
    }
    return { type: "Ident", name: t.text, pos: t.pos };
  }

  /** `(a, b) => …`, or a parenthesised expression. The parser rewinds when it is not an arrow. */
  private parenthesised(): Expr {
    const save = this.c.mark();
    this.c.next();
    const params: ParamRead[] = [];
    let looksLikeParams = true;
    if (!this.c.is("RParen")) {
      do {
        if (this.c.is("RParen")) break;
        const p = this.param();
        if (p === null) {
          looksLikeParams = false;
          break;
        }
        params.push(p);
      } while (this.c.eat("Comma"));
    }
    if (looksLikeParams && this.c.eat("RParen") && this.c.is("Arrow")) {
      const arrow = this.c.next();
      return this.lambdaOf(params, arrow.pos);
    }
    this.c.reset(save);
    this.c.expect("LParen");
    const inner = this.expression();
    this.c.expect("RParen");
    // Parentheses are what makes an otherwise-refused combination legal. So the
    // group deliberately forgets which rule produced it.
    // `([1, a]) => …`: a pattern that is not one of plain names, read as an expression.
    if (this.c.is("Arrow") && (inner.type === "ObjectLiteral" || inner.type === "ArrayLiteral")) {
      throw notAPlainPattern(inner.pos);
    }
    return inner;
  }

  /**
   * One parameter as written: a plain name, or a destructuring pattern of plain
   * names, such as `[id, count]` or `{ sku, qty: n }`. This returns null when the
   * tokens are not a parameter at all (a number, a call), so the caller can
   * rewind and read a parenthesised expression. A pattern with a default, a rest
   * element, a nested pattern or a computed key comes back `refused`. The caller
   * throws it once it knows that an arrow follows, and rewinds otherwise, because
   * `([...a, b])` is a legal expression.
   */
  private param(): ParamRead {
    if (this.c.is("Ident")) return { kind: "name", name: this.c.next().text };
    if (this.c.is("LBracket")) {
      const open = this.c.next();
      const parts: (PatternPart | null)[] = [];
      let refused: ParseError | null = null;
      if (!this.c.eat("RBracket")) {
        do {
          if (this.c.is("RBracket")) break;
          // `[, b]`: an elision skips an element.
          if (this.c.is("Comma")) {
            parts.push(null);
            continue;
          }
          const t = this.c.peek();
          if (t.type !== "Ident") {
            if (t.type !== "LBracket" && t.type !== "LBrace" && t.type !== "Spread") return null;
            refused ??= notAPlainPattern(t.pos, t.text);
            if (!this.skipPatternPart()) return null;
            continue;
          }
          this.c.next();
          if (this.c.is("Eq")) {
            refused ??= notAPlainPattern(t.pos, `${t.text} = …`);
            if (!this.skipPatternPart()) return null;
            continue;
          }
          parts.push({ key: String(parts.length), name: t.text, pos: t.pos });
        } while (this.c.eat("Comma"));
        if (!this.c.eat("RBracket")) return null;
      }
      if (refused !== null) return { kind: "refused", error: refused };
      return { kind: "array", parts, pos: open.pos };
    }
    if (this.c.is("LBrace")) {
      const open = this.c.next();
      const parts: PatternPart[] = [];
      let refused: ParseError | null = null;
      if (!this.c.eat("RBrace")) {
        do {
          if (this.c.is("RBrace")) break;
          const t = this.c.peek();
          if (t.type !== "Ident") {
            if (t.type !== "LBracket" && t.type !== "Spread") return null;
            refused ??= notAPlainPattern(t.pos, t.text);
            if (!this.skipPatternPart()) return null;
            continue;
          }
          this.c.next();
          let name = t.text;
          if (this.c.eat("Colon")) {
            if (!this.c.is("Ident")) {
              const bad = this.c.peek();
              if (bad.type !== "LBracket" && bad.type !== "LBrace") return null;
              refused ??= notAPlainPattern(bad.pos, bad.text);
              if (!this.skipPatternPart()) return null;
              continue;
            }
            name = this.c.next().text;
          }
          if (this.c.is("Eq")) {
            refused ??= notAPlainPattern(t.pos, `${t.text} = …`);
            if (!this.skipPatternPart()) return null;
            continue;
          }
          parts.push({ key: t.text, name, pos: t.pos });
        } while (this.c.eat("Comma"));
        if (!this.c.eat("RBrace")) return null;
      }
      if (refused !== null) return { kind: "refused", error: refused };
      return { kind: "object", parts, pos: open.pos };
    }
    return null;
  }

  /**
   * Skips to the end of one refused pattern part, past a default's expression, a
   * rest element, or a nested pattern, so the reader can tell whether an arrow
   * follows the whole list. This returns false when the tokens run out first.
   */
  private skipPatternPart(): boolean {
    let depth = 0;
    for (;;) {
      const t = this.c.peek();
      if (t.type === "EOF") return false;
      if (depth === 0 && (t.type === "Comma" || t.type === "RBracket" || t.type === "RBrace")) return true;
      if (t.type === "LParen" || t.type === "LBracket" || t.type === "LBrace") depth++;
      if (t.type === "RParen" || t.type === "RBracket" || t.type === "RBrace") depth--;
      this.c.next();
    }
  }

  /**
   * The lambda that a parameter list and its body make. A destructured parameter
   * is one parameter under a fresh name, and each name it binds is that
   * parameter's part wherever the body reads it. So `([id, count]) => -count` IS
   * `x => -x[1]`. The parts are substituted, never declared. So the body keeps
   * its shape for every reader (a sort key sees the minus, a filter sees the
   * comparison).
   */
  private lambdaOf(params: readonly ParamRead[], pos: number): Lambda {
    for (const p of params) if (p !== null && p.kind === "refused") throw p.error;
    const named = params as readonly Exclude<ParamRead, null | { kind: "refused" }>[];
    if (named.every((p) => p.kind === "name")) {
      return this.lambdaBody(
        named.map((p) => (p as { name: string }).name),
        pos,
      );
    }
    const plain = named.map((p) => (p.kind === "name" ? p.name : ""));
    const parsed = this.lambdaBody(plain, pos);
    // The fresh names step aside from every name that the body mentions, and from
    // every other parameter. So no part can capture a name that the developer wrote.
    const taken: object[] = [parsed, ...plain.filter((n) => n !== "").map((n) => ({ type: "Ident", name: n }))];
    const names = [...plain];
    const parts = new Map<string, Expr>();
    named.forEach((p, i) => {
      if (p.kind === "name") return;
      const fresh = freshParam("x", ...taken);
      taken.push({ type: "Ident", name: fresh });
      names[i] = fresh;
      for (const part of p.parts) {
        if (part === null) continue;
        const object: Expr = { type: "Ident", name: fresh, pos: part.pos };
        parts.set(
          part.name,
          p.kind === "array"
            ? {
                type: "IndexAccess",
                object,
                index: { type: "NumberLiteral", value: Number(part.key), pos: part.pos },
                optional: false,
                pos: part.pos,
              }
            : { type: "MemberAccess", object, name: part.key, optional: false, pos: part.pos },
        );
      }
    });
    const lambda: Lambda =
      parsed.body !== undefined
        ? { type: "Lambda", params: names, body: replaceIdents(parsed.body, parts), pos }
        : { type: "Lambda", params: names, stages: replaceIdents(parsed.stages as Pipeline, parts), pos };
    // The callee claims a stages body under the node's identity.
    const end = this.unclaimedStages.get(parsed);
    if (end !== undefined) {
      this.unclaimedStages.delete(parsed);
      this.unclaimedStages.set(lambda, end);
    }
    return lambda;
  }

  /**
   * A lambda's body. A `{ … }` body is JavaScript: declarations, then a `return`.
   * A body of pipeline stages belongs only to a name whose row says
   * `blockBody: "stages"`. The callee claims it in `args()`, and `finish()`
   * refuses a stages body that nobody claimed.
   */
  private lambdaBody(params: readonly string[], pos: number): Lambda {
    if (!this.c.is("LBrace")) {
      return { type: "Lambda", params, body: this.expression(), pos };
    }
    const open = this.c.next();
    const { stmts, ret, retPos, endPos } = this.block("RBrace");
    // A `return` makes the block JavaScript: declarations, then one result.
    if (ret !== null) {
      const decls = stmts.filter((st): st is LetDecl => st.type === "LetDecl");
      if (decls.length !== stmts.length) {
        // A statement where a declaration goes: a stage gets the same message that a block without a `return` gets.
        const stmt = stmts.find((st) => st.type !== "LetDecl") as PipelineStmt;
        if (!isStageStmt(stmt)) {
          throw new ParseError(
            `A callback's block holds 'const' declarations and one 'return', and this statement is neither at position ${(stmt as { pos: number }).pos}. Bind it ('const x = …;') or fold it into the 'return'.`,
            (stmt as { pos: number }).pos,
          );
        }
        throw new ParseError(notPartOfACallback(stmt, retPos), (stmt as { pos: number }).pos);
      }
      return { type: "Lambda", params, body: { type: "ExprBlock", decls, ret, pos: retPos }, pos };
    }
    // With no `return`, the statements are pipeline stages, if the callee takes them.
    const lambda: Lambda = { type: "Lambda", params, stages: { type: "Pipeline", stmts, pos: open.pos }, pos };
    // The message points at the closing brace, the place where a `return` belongs.
    this.unclaimedStages.set(lambda, endPos);
    return lambda;
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
      // The brace that closes an interpolation emits no token. See tokens.ts.
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
   * bracketed pipeline. Anything else is a value.
   */
  private arrayElement(): ArrayElement {
    if (this.c.is("Let") || this.c.is("Const")) return this.binding();
    // `[ function double(x) { … }, $set(…) ]`: a declaration, not a function
    // VALUE. Without this check it parsed as a lambda, and the lambda made the
    // literal look like an array of values rather than a pipeline.
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
      // A field name is a string, so a numeric key uses its own spelling. A
      // 24-hex `0x…` is an ObjectId, and an ObjectId is not a field name.
      // JavaScript would read it as a precision-losing number, so neither reading
      // is useful.
      const literal = this.number();
      if (literal.type === "ObjectIdLiteral") {
        throw new ParseError(
          `An ObjectId literal can't be an object key at position ${t.pos} — a field name is a string. Quote it (\`{ "${literal.hex}": … }\`) to use it as a field name.`,
          t.pos,
        );
      }
      key = { kind: "static", name: String(Number(t.text)) };
    } else if (t.type === "Dollar") {
      // `{ $match: … }`: a raw MQL document. HR2 requires it to round-trip.
      this.c.next();
      key = { kind: "static", name: this.dollarName(t).text };
    } else {
      key = { kind: "static", name: this.identLike().text };
    }
    // `{ x }` is JavaScript shorthand for `{ x: x }`, for an IDENTIFIER. A
    // reserved word is a legal key but not a legal shorthand: `({ in })` and
    // `({ null })` are SyntaxErrors, and only `undefined` is an identifier there.
    if (key.kind === "static" && !this.c.is("Colon")) {
      if (t.type === "Dollar") {
        // `{ $abs }` is legal JavaScript shorthand for an identifier `$abs`, but
        // here `$abs` names an operator and has no value to stand for.
        throw new ParseError(`Expected ':' after '${key.name}' — write '${key.name}: <value>'`, this.c.peek().pos);
      }
      if (t.type !== "Ident" && t.type !== "Undefined") {
        throw new ParseError(
          `Expected ':' after '${key.name}' — a reserved word cannot be a shorthand property. Write '${key.name}: <value>'`,
          this.c.peek().pos,
        );
      }
      return { type: "KeyValueEntry", key, value: { type: "Ident", name: key.name, pos: t.pos }, pos: t.pos };
    }
    this.c.expect("Colon");
    return { type: "KeyValueEntry", key, value: this.expression(), pos: t.pos };
  }
}

/**
 * A binary node from the operator token. The token's own text IS the operator,
 * such as `+`, `===`, or `in`. So no table maps a token type back to a spelling.
 * The audit in productions.ts confirms that every operator a BinaryExpr row
 * consumes is a `BinaryOp`.
 */
function bin(op: Token, left: Expr, right: Expr): Expr {
  return { type: "BinaryExpr", op: op.text as BinaryOp, left, right, pos: op.pos };
}

export { ParseError };
