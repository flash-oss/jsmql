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
  asStatementOf,
  INFIX,
  MAX_PRECEDENCE,
  mixingRefused,
  NEVER_A_WRITE_TARGET,
  PREFIX,
  SPELLING,
  STATEMENT_PREFIX,
  WORDS,
} from "./tables.ts";

const spelled = (rule: ProductionKey | null): string => (rule === null ? "" : (SPELLING.get(rule) ?? rule));

const OBJECT_ID_DIGITS = 24;

type Parsed = { expr: Expr; rule: ProductionKey | null };

const unexpected = (t: { type: string }): string =>
  t.type === "EOF" ? "Unexpected end of input" : `Unexpected token ${found(t as never)}`;

function assertPlausibleObjectId(hex: string, pos: number): void {
  const typo = objectIdTypo(hex);
  if (typo !== null) throw new ParseError(typo, pos);
}

export function parse(source: string): Program {
  const p = new Parser(lex(source), source);
  const program = p.program();
  p.finish();
  return program;
}

export type EntryForm = { params: readonly ParamBinding[]; toolbox: readonly ParamBinding[]; program: Program };

export function parseEntry(source: string): EntryForm {
  const p = new Parser(lex(source), source);
  const entry = p.entry();
  p.finish();
  return entry;
}

export function parseExpression(source: string): Expr {
  const p = new Parser(lex(source), source);
  const e = p.expression();
  p.expectEnd();
  p.finish();
  return e;
}

const needsReturn = (pos: number, got: string): string =>
  `A block body must end with a \`return <expr>\` statement at position ${pos}, got ${got}. Write \`x => { const a = …; return <expr>; }\`. ` +
  "Or write `function f(x) { return <expr>; }`. Or write `x => (<expr>)` to return an object or an expression directly.";

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

function notPartOfACallback(stmt: PipelineStmt, retPos: number | null): string {
  const wrote = statementSpelling(stmt);
  const pos = (stmt as { pos: number }).pos;
  if (stmt.type === "FuncDecl") {
    return `\`${wrote}\` at position ${pos} declares a reusable function. A pipeline declares a reusable function at its top level, not inside a callback. Write \`${wrote};\` as its own statement before this one. Then call '${stmt.name}(…)' inside the callback.`;
  }
  const stages = `'.aggregate((o) => { ${wrote}; … })'`;
  const link = stmt.type === "OperatorCall" ? `'$$.$${(stmt as { name: string }).name.replace(/^\$/, "")}(…)'` : null;
  const chain = link === null ? "" : ` Over the stream a stage is also a chain link: ${link}.`;
  if (retPos !== null) {
    return `\`${wrote}\` at position ${pos} is a pipeline stage. The 'return' at position ${retPos} makes this block a value callback. One block cannot be both. Move the stages to ${stages}. It takes a block of stages and no 'return'. Or delete the stage and fold its work into the 'return'.${chain}`;
  }
  return `\`${wrote}\` at position ${pos} is a pipeline stage, not part of a callback. A callback's block holds declarations and a 'return'. Move the stages to ${stages}. It is the one method whose block is a list of stages.${chain}`;
}

function targetSpelling(target: Expr): string {
  if (target.type === "FieldRef") return target.path === "" ? "$" : `$.${target.path}`;
  if (target.type === "Ident") return target.name;
  if (target.type === "MemberAccess") return `${targetSpelling(target.object)}.${target.name}`;
  return "…";
}

type Block = { stmts: PipelineStmt[]; ret: Expr | null; retPos: number; sawSemi: boolean; endPos: number };

type PatternPart = { readonly key: string; readonly name: string; readonly pos: number };

type ParamRead =
  | { readonly kind: "name"; readonly name: string; readonly pos: number }
  | { readonly kind: "array"; readonly parts: readonly (PatternPart | null)[]; readonly pos: number }
  | { readonly kind: "object"; readonly parts: readonly PatternPart[]; readonly pos: number }
  | { readonly kind: "refused"; readonly error: ParseError }
  | null;

function notAPlainPattern(pos: number, wrote?: string): ParseError {
  const got = wrote === undefined ? "" : ` ('${wrote}')`;
  return new ParseError(
    `A destructured parameter lists plain names only — '([id, count]) => …', '({ sku, qty: n }) => …'. A default value, a rest element, a nested pattern or a computed key${got} is not one of them, at position ${pos}. Name the parameter. Read its parts instead: 'x => x[0]', 'x => x.sku ?? 1', 'x => x.slice(1)'.`,
    pos,
  );
}

function parameterDefault(name: Token): ParseError {
  return new ParseError(
    `A callback parameter is a plain name, and a default value ('${name.text} = …') is not one, at position ${name.pos}. Name the parameter, and write the default where the body reads it: '${name.text} => ${name.text} ?? <default>'.`,
    name.pos,
  );
}

type Binder = { readonly name: string; readonly pos: number };

function refuseDuplicateParams(binders: readonly Binder[]): void {
  const seen = new Set<string>();
  for (const b of binders) {
    if (seen.has(b.name)) {
      throw new ParseError(
        `The parameter name '${b.name}' appears twice in one parameter list, at position ${b.pos}. JavaScript refuses a duplicate parameter name here. Give each parameter its own name, for example '(x, i) => …'.`,
        b.pos,
      );
    }
    seen.add(b.name);
  }
}

function declare(scope: Map<string, "parameter" | "declaration">, stmt: PipelineStmt): void {
  if (stmt.type !== "LetDecl" && stmt.type !== "FuncDecl") return;
  const wrote = `${stmt.type === "FuncDecl" && stmt.form === "function" ? "function" : stmt.kind} ${stmt.name}`;
  const earlier = scope.get(stmt.name);
  if (earlier === "parameter") {
    throw new ParseError(
      `\`${wrote}\` re-declares the parameter \`${stmt.name}\` at position ${stmt.pos}, which JavaScript refuses. Pick a different name.`,
      stmt.pos,
    );
  }
  if (earlier === "declaration") {
    throw new ParseError(
      `\`${wrote}\` at position ${stmt.pos} is already declared earlier in this block, which JavaScript refuses. Pick a different name.`,
      stmt.pos,
    );
  }
  scope.set(stmt.name, "declaration");
}

function declarationAsElement(kw: Token, name: Token): ParseError {
  const wrote = `${kw.text} ${name.type === "Ident" ? name.text : "x"} = …`;
  return new ParseError(
    `\`${wrote}\` is a declaration, and JavaScript refuses a declaration as an array element, at position ${kw.pos}. Write the pipeline as statements, with a ';' after each one: \`${wrote}; $match(…);\`. A sub-pipeline takes its statements in an '.aggregate' block: \`$.<field> = $$$.<coll>.aggregate(() => { ${wrote}; $match(…); })\` for a '$lookup', \`$$.push(...$$$.<coll>.aggregate(() => { … }))\` for a '$unionWith', and \`$ = { k: $$.aggregate(() => { … }) }\` for a '$facet' branch.`,
    kw.pos,
  );
}

function trailingComma(comma: Token, next: Token): ParseError {
  return new ParseError(
    `A ',' with no write after it, before ${found(next)} at position ${comma.pos}. JavaScript allows a trailing ',' in a list, but not at the end of a statement or of a '( … )' group. Delete the ',' ('$.a = 1;'), or write the next write after it ('$.a = 1, $.b = 2;').`,
    comma.pos,
  );
}

function writeInValue(
  wrote: string,
  statement: string,
  place: string | null,
  side: "before" | "after",
  pos: number,
): ParseError {
  const read = place === null ? "" : `, and read '${place}' there`;
  return new ParseError(
    `'${wrote}' is a write inside a value at position ${pos}. A write stands only as a statement. Write '${statement};' as its own statement ${side} the statement that uses the value${read}.`,
    pos,
  );
}

export function writeInValueOf(node: UpdateOp | UpdateFilter): ParseError {
  const op = node.type === "UpdateFilter" ? node.ops[0] : node;
  const place = targetSpelling(op.target);
  if (op.type === "DeleteStmt") return writeInValue(`delete ${place}`, `delete ${place}`, null, "before", op.pos);
  const update = asStatementOf(op.op);
  if (update === null) return writeInValue(`${place} ${op.op} …`, `${place} ${op.op} …`, place, "before", op.pos);
  const prefix = op.pos < (op.target as { pos: number }).pos;
  const wrote = prefix ? `${op.op}${place}` : `${place}${op.op}`;
  return writeInValue(wrote, `${place} ${update}`, place, prefix ? "before" : "after", op.pos);
}

export function functionInValueOf(node: FuncDecl): ParseError {
  return new ParseError(
    `'function ${node.name}(…)' is a function inside a value at position ${node.pos}. MQL has no function values. Write the function as its own statement at the top level of the pipeline, and call '${node.name}(…)' where the value goes.`,
    node.pos,
  );
}

function refuseWholeTarget(target: Expr, op: string, pos: number): void {
  if (op === "=" || op === "delete") return;
  const what =
    target.type === "StreamRef"
      ? "'$$' is the root stream"
      : target.type === "FieldRef" && target.path === ""
        ? "'$' is the whole document"
        : null;
  if (what === null) return;
  const field = asStatementOf(op) === null ? `$.<field> ${op} …` : `$.<field>${op}`;
  throw new ParseError(
    `Cannot use '${op}' on '${target.type === "StreamRef" ? "$$" : "$"}' at position ${pos}. ${what}, not a field. Write to a field: '${field}'.`,
    pos,
  );
}

class Parser {
  private readonly c: Cursor;
  private readonly unclaimedStages = new Map<Lambda, number>();

  private readonly src: string;

  constructor(toks: readonly Token[], src: string) {
    this.c = new Cursor(toks);
    this.src = src;
  }

  expectEnd(): void {
    if (!this.c.is("EOF")) {
      throw new ParseError(`${unexpected(this.c.peek())}`, this.c.peek().pos);
    }
  }

  finish(): void {
    const first = this.unclaimedStages.entries().next();
    if (first.done) return;
    const [lambda, endPos] = first.value;
    const stmt = lambda.stages?.stmts.find((st) => st.type !== "LetDecl");
    if (stmt !== undefined && isStageStmt(stmt)) {
      throw new ParseError(notPartOfACallback(stmt, null), (stmt as { pos: number }).pos);
    }
    throw new ParseError(needsReturn(endPos, "'}'"), endPos);
  }

  entry(): EntryForm {
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
        `An entry function takes at most two parameters: the params destructure and the toolbox destructure. It got ${slots.length}.`,
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
    const binders = slots.flat();
    refuseDuplicateParams(binders);
    if (!isFunction) this.c.expect("Arrow");
    const program = this.c.is("LBrace") ? this.entryBlock(binders) : this.program();
    return { params, toolbox, program };
  }

  private destructure(): ParamBinding[] {
    const open = this.c.peek();
    if (!this.c.is("LBrace")) {
      throw new ParseError(
        `jsmql expects each parameter to be an object destructure pattern, for example '({ $ }) => …'. It got ${found(open)}.`,
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
        if (this.c.is("Eq")) {
          throw new ParseError(
            `jsmql does not support a default value in the params destructure ('${key.text} = …') at position ${this.c.peek().pos}. Apply the default where you call the query. Use JS's \`??\` at the call site: q({ ${key.text}: input ?? <default> }). Or write the value into the template-tag form.`,
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

  private destructureKey(): Token {
    const t = this.c.peek();
    if (t.type === "Dollar") {
      this.c.next();
      return this.c.is("Ident") ? this.dollarName(t) : t;
    }
    if (t.type === "DoubleDollar" || t.type === "TripleDollar" || t.type === "QuadDollar") {
      this.c.next();
      return t;
    }
    return this.identLike();
  }

  private dollarName(dollar: Token): Token {
    const name = this.c.expect("Ident");
    if (name.pos !== dollar.end) {
      throw new ParseError(`Expected a name directly after '$', with no space — write '$${name.text}'`, name.pos);
    }
    return { ...dollar, text: "$" + name.text, end: name.end };
  }

  private entryBlock(params: readonly Binder[]): Program {
    this.c.expect("LBrace");
    const { stmts, ret, retPos, sawSemi } = this.block("RBrace", params);
    if (ret !== null) {
      if (stmts.length > 0) {
        throw new ParseError(
          "A 'return' here is not a jsmql statement. Put the whole predicate in the return.",
          retPos,
        );
      }
      return ret;
    }
    return this.collapse(stmts, sawSemi);
  }

  program(): Program {
    const { stmts, sawSemi } = this.block("EOF");
    return this.collapse(stmts, sawSemi);
  }

  private collapse(stmts: PipelineStmt[], sawSemi: boolean): Program {
    if (stmts.length === 1 && !sawSemi) {
      const only = stmts[0];
      if (only.type !== "LetDecl" && only.type !== "FuncDecl") return only;
    }
    return { type: "Pipeline", stmts, pos: stmts[0]?.pos ?? 0 };
  }

  private block(terminator: "RBrace" | "EOF", params: readonly Binder[] = []): Block {
    const stmts: PipelineStmt[] = [];
    const scope = new Map<string, "parameter" | "declaration">(params.map((p) => [p.name, "parameter"]));
    let sawSemi = false;
    let endPos = this.c.peek().pos;
    for (;;) {
      while (this.c.eat("Semi")) sawSemi = true;
      if (this.c.is(terminator)) {
        endPos = this.c.peek().pos;
        if (terminator === "RBrace") this.c.next();
        break;
      }
      if (terminator === "RBrace" && this.c.is("Return")) {
        const r = this.c.next();
        const ret = this.expression();
        while (this.c.eat("Semi")) {}
        const close = this.c.expect("RBrace");
        return { stmts, ret, retPos: r.pos, sawSemi, endPos: close.pos };
      }
      const run = this.statement();
      const st = run[0];
      if (terminator === "RBrace" && st.type === "Ident" && this.c.is("Colon")) {
        throw new ParseError(needsReturn(st.pos, `an identifier '${st.name}'`), st.pos);
      }
      for (const stmt of run) declare(scope, stmt);
      stmts.push(...run);
      const blockBodied = st.type === "FuncDecl" && st.form === "function";
      if (this.c.is("Semi")) sawSemi = true;
      if (!this.c.eat("Semi") && !this.c.is(terminator) && !blockBodied) {
        throw new ParseError(`Expected ${spell("Semi")} but got ${found(this.c.peek())}`, this.c.peek().pos);
      }
    }
    return { stmts, ret: null, retPos: 0, sawSemi, endPos };
  }

  private statement(): PipelineStmt[] {
    if (this.c.is("Let") || this.c.is("Const")) return this.bindings();
    this.refuseAsync();
    if (this.functionAhead()) return [this.functionDecl()];
    if (this.writeAhead()) return [this.writes()];
    return [this.expression()];
  }

  private functionAhead(): boolean {
    return this.c.is("Ident") && WORDS.get(this.c.peek().text) === "functionBinding" && this.c.peek(1).type === "Ident";
  }

  private refuseGenerator(): void {
    if (!this.c.is("Star")) return;
    throw new ParseError(
      `jsmql does not support generator functions ('function*') at position ${this.c.peek().pos}. Write a plain 'function (…) { return <expr>; }' or an arrow '(…) => <expr>'.`,
      this.c.peek().pos,
    );
  }

  private refuseAsync(): void {
    const t = this.c.peek();
    if (t.type !== "Ident" || t.text !== "async") return;
    if (WORDS.get(this.c.peek(1).text ?? "") !== "functionBinding") return;
    throw new ParseError(
      `jsmql does not support async functions ('async function') at position ${t.pos}. Write a plain 'function (…) { return <expr>; }' or an arrow '(…) => <expr>'.`,
      t.pos,
    );
  }

  private functionDecl(): FuncDecl {
    const kw = this.c.next();
    this.refuseGenerator();
    const name = this.c.expect("Ident");
    const params = this.paramList();
    const lambda = this.lambdaOf(params, kw.pos, false);
    return { type: "FuncDecl", name: name.text, lambda, kind: "const", form: "function", group: kw.pos, pos: kw.pos };
  }

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

  private functionExpr(): Lambda {
    const kw = this.c.next();
    this.refuseGenerator();
    if (this.c.is("Ident")) this.c.next();
    const params = this.paramList();
    return this.lambdaOf(params, kw.pos, false);
  }

  private bindings(): (LetDecl | FuncDecl)[] {
    const kw = this.c.next();
    const kind = kw.type === "Const" ? "const" : "let";
    const out = [this.declarator(kind, kw.pos, kw.pos)];
    while (this.c.eat("Comma")) out.push(this.declarator(kind, null, kw.pos));
    return out;
  }

  private declarator(kind: "let" | "const", kwPos: number | null, group: number): LetDecl | FuncDecl {
    const name = this.c.expect("Ident");
    const pos = kwPos ?? name.pos;
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

  private parenWriteAhead(): boolean {
    const save = this.c.mark();
    try {
      while (this.c.is("LParen")) this.c.next();
      return STATEMENT_PREFIX.has(this.c.type) || this.startsAWrite();
    } finally {
      this.c.reset(save);
    }
  }

  private writeAhead(): boolean {
    if (STATEMENT_PREFIX.has(this.c.type)) return true;
    if (this.c.is("LParen")) return this.parenWriteAhead() || this.startsAWrite();
    return this.startsAWrite();
  }

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

  private writeGroup(): UpdateOp[] {
    if (this.c.is("LParen") && this.parenWriteAhead()) {
      this.c.next();
      const ops: UpdateOp[] = [];
      for (;;) {
        ops.push(...this.writeGroup());
        if (!this.c.is("Comma")) break;
        const comma = this.c.next();
        if (this.c.is("RParen")) throw trailingComma(comma, this.c.peek());
      }
      this.c.expect("RParen");
      return ops;
    }
    if (this.c.is("Delete")) {
      const kw = this.c.next();
      const targetStart = this.c.peek().pos;
      const target = this.pratt(1);
      this.requirePlace(target, kw.pos, "delete", this.src.slice(targetStart, this.c.lastEnd()));
      return [{ type: "DeleteStmt", target: target.expr, pos: kw.pos }];
    }
    const lead = PREFIX.get(this.c.type);
    const prefix = lead !== undefined && lead.asStatement !== null ? this.c.next() : null;
    const start = prefix?.pos ?? this.c.peek().pos;
    const placeStart = this.c.peek().pos;
    const target = prefix !== null && lead !== undefined ? this.pratt(lead.prec) : this.pratt(1, true);
    const placeEnd = this.c.lastEnd();
    const op = prefix ?? this.c.next();
    if (!ASSIGN_TRIGGERS.has(op.type)) {
      throw new ParseError(`Expected an assignment but got ${found(op)}`, op.pos);
    }
    const spelling = op.text as AssignOp;
    this.requireWriteTarget(target, op.pos, spelling, this.src.slice(placeStart, placeEnd));
    const update = PREFIX.get(op.type)?.asStatement ?? null;
    if (update !== null) {
      if (INFIX.has(this.c.type) || ASSIGN_TRIGGERS.has(this.c.type)) {
        const place = this.src.slice(placeStart, placeEnd);
        const wrote = this.src.slice(start, prefix !== null ? placeEnd : op.end);
        throw writeInValue(wrote, `${place} ${update}`, place, prefix !== null ? "before" : "after", op.pos);
      }
      return [{ type: "AssignExpr", target: target.expr, op: spelling, value: target.expr, pos: op.pos }];
    }
    if (spelling === "=") {
      const targets = [target.expr];
      let valueStart = this.c.peek().pos;
      let value = this.pratt(1);
      while (this.c.is("Eq")) {
        const wrote = this.src.slice(valueStart, this.c.lastEnd());
        const eq = this.c.next();
        this.requireWriteTarget(value, eq.pos, "=", wrote);
        targets.push(value.expr);
        valueStart = this.c.peek().pos;
        value = this.pratt(1);
      }
      if (ASSIGN_TRIGGERS.has(this.c.type)) this.refuseAssignInValue(value, valueStart);
      return targets.map((t) => ({ type: "AssignExpr", target: t, op: "=" as const, value: value.expr, pos: op.pos }));
    }
    return [{ type: "AssignExpr", target: target.expr, op: spelling, value: this.expression(), pos: op.pos }];
  }

  private refuseAssignInValue(target: Parsed, start: number): never {
    const place = this.src.slice(start, this.c.lastEnd());
    const op = this.c.next();
    this.requireWriteTarget(target, op.pos, op.text, place);
    this.expression();
    const wrote = this.src.slice(start, this.c.lastEnd());
    throw writeInValue(wrote, wrote, place, "before", op.pos);
  }

  private writes(): UpdateFilter {
    const pos = this.c.peek().pos;
    const ops: UpdateOp[] = [];
    for (;;) {
      ops.push(...this.writeGroup());
      if (!this.c.is("Comma")) break;
      const comma = this.c.next();
      if (this.c.is("EOF") || this.c.is("Semi") || this.c.is("RBrace")) throw trailingComma(comma, this.c.peek());
    }
    return { type: "UpdateFilter", ops, pos };
  }

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

  private requirePlace(target: Parsed, pos: number, op: string, wrote: string): void {
    const t = target.expr.type;
    const isPlace =
      t === "FieldRef" ||
      t === "Ident" ||
      t === "MemberAccess" ||
      t === "IndexAccess" ||
      t === "StreamRef" ||
      t === "DatabaseRef" ||
      t === "ClusterRef";
    if (isPlace) return;
    if (target.expr.type === "MethodCall") {
      const call = `.${target.expr.wrote ?? target.expr.name}()`;
      throw new ParseError(
        `Cannot apply '${op}' to the result of '${call}', at position ${pos}. You can write only to a field, a binding, '$', '$$' or a collection. Write the result to a field instead: '$.<field> = <receiver>${call};'.`,
        pos,
      );
    }
    throw new ParseError(
      `Cannot apply '${op}' to '${wrote}' at position ${pos}. You can write only to a field, a binding, '$', '$$' or a collection.`,
      pos,
    );
  }

  private requireWriteTarget(target: Parsed, pos: number, op: string, wrote: string): void {
    this.requirePlace(target, pos, op, wrote);
    refuseWholeTarget(target.expr, op, pos);
    if (target.rule === null) return;
    const refusal = NEVER_A_WRITE_TARGET.get(target.rule);
    if (refusal === undefined) return;
    throw new ParseError(`You cannot assign to '${refusal.spelling}'. JavaScript rejects it. ${refusal.hint}`, pos);
  }

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
      const start = this.c.peek().pos;
      const out = this.pratt(1);
      if (ASSIGN_TRIGGERS.has(this.c.type)) this.refuseAssignInValue(out, start);
      return out.expr;
    } finally {
      this.depth--;
    }
  }

  private pratt(minPrec: number, endsAtWrite = false): Parsed {
    const start = this.c.peek().pos;
    let left = this.unary();
    for (;;) {
      const rule = INFIX.get(this.c.type);
      if (rule === undefined || rule.prec === 0 || rule.prec < minPrec) return left;

      if (rule.asStatement !== null) {
        if (endsAtWrite) return left;
        const place = this.src.slice(start, this.c.lastEnd());
        const op = this.c.next();
        this.requireWriteTarget(left, op.pos, op.text, place);
        throw writeInValue(this.src.slice(start, op.end), `${place} ${rule.asStatement}`, place, "after", op.pos);
      }

      if (mixingRefused(rule, left.rule, "left")) {
        throw new ParseError(
          `You cannot combine '${this.c.peek().text}' with '${spelled(left.rule)}' without parentheses. JavaScript rejects it.`,
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
          `You cannot combine '${op.text}' with '${spelled(right.rule)}' without parentheses. JavaScript rejects it.`,
          op.pos,
        );
      }
      left = { expr: bin(op, left.expr, right.expr), rule: rule.rules[0] };
    }
  }

  private unary(): Parsed {
    const rule = PREFIX.get(this.c.type);
    if (rule !== undefined && rule.prec > 0) {
      const op = this.c.next();
      const placeStart = this.c.peek().pos;
      const argument = this.pratt(rule.prec);
      if (rule.asStatement !== null) {
        const place = this.src.slice(placeStart, this.c.lastEnd());
        this.requireWriteTarget(argument, op.pos, op.text, place);
        throw writeInValue(
          this.src.slice(op.pos, this.c.lastEnd()),
          `${place} ${rule.asStatement}`,
          place,
          "before",
          op.pos,
        );
      }
      if (mixingRefused(rule, argument.rule, "right")) {
        throw new ParseError(
          `You cannot combine '${op.text}' with '${spelled(argument.rule)}' without parentheses. JavaScript rejects it.`,
          op.pos,
        );
      }
      return {
        expr: { type: "UnaryExpr", op: op.text as UnaryOp, argument: argument.expr, pos: op.pos },
        rule: rule.rules[0],
      };
    }
    if (this.c.is("Delete")) {
      const kw = this.c.next();
      const placeStart = this.c.peek().pos;
      const target = this.pratt(MAX_PRECEDENCE);
      const place = this.src.slice(placeStart, this.c.lastEnd());
      this.requirePlace(target, kw.pos, "delete", place);
      throw writeInValue(`delete ${place}`, `delete ${place}`, null, "before", kw.pos);
    }
    return this.postfix(this.atom());
  }

  private postfix(target: Expr): Parsed {
    let out: Parsed = { expr: target, rule: null };
    for (;;) {
      const rule = INFIX.get(this.c.type);
      if (rule === undefined || rule.prec !== MAX_PRECEDENCE || rule.fixity !== "postfix") return out;
      const next = this.tail(out.expr, this.c.next());
      out = out.rule === "optionalMemberAccess" ? { expr: next.expr, rule: out.rule } : next;
    }
  }

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
    if (optional && this.c.is("LBracket")) {
      this.c.next();
      const index = this.expression();
      this.c.expect("RBracket");
      return { expr: { type: "IndexAccess", object, index, optional: true, pos: op.pos }, rule };
    }
    const dollar = this.c.is("Dollar") ? this.c.next() : null;
    const name = dollar === null ? this.identLike() : this.dollarName(dollar);
    if (this.c.is("LParen")) {
      this.c.next();
      const args = this.args("RParen", name.text);
      return { expr: { type: "MethodCall", object, name: name.text, args, optional, pos: op.pos }, rule };
    }
    return { expr: { type: "MemberAccess", object, name: name.text, optional, pos: op.pos }, rule };
  }

  private identLike(): Token {
    const t = this.c.peek();
    if (t.type === "Ident" || this.c.isNameLike()) return this.c.next();
    throw new ParseError(`Expected a name but got ${found(t)}`, t.pos);
  }

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
        return { type: "StreamRef", pos: t.pos };
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

  private fieldRef(): Expr {
    const t = this.c.next();
    const first = this.identLike();
    if (this.c.is("LParen")) {
      this.c.next();
      const args = this.args("RParen", first.text);
      const object: Expr = { type: "FieldRef", path: "", pos: t.pos };
      return { type: "MethodCall", object, name: first.text, args, optional: false, pos: t.pos + 1 };
    }
    return { type: "FieldRef", path: first.text, pos: t.pos };
  }

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

  private identifierOrLambda(): Expr {
    const t = this.c.next();
    if (this.c.is("Arrow")) {
      const arrow = this.c.next();
      return this.lambdaBody([t.text], arrow.pos, [{ name: t.text, pos: t.pos }]);
    }
    return { type: "Ident", name: t.text, pos: t.pos };
  }

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
      return this.lambdaOf(params, arrow.pos, true);
    }
    this.c.reset(save);
    this.c.expect("LParen");
    const inner = this.expression();
    this.c.expect("RParen");
    if (this.c.is("Arrow") && (inner.type === "ObjectLiteral" || inner.type === "ArrayLiteral")) {
      throw notAPlainPattern(inner.pos);
    }
    return inner;
  }

  private param(): ParamRead {
    if (this.c.is("Ident")) {
      const t = this.c.next();
      if (this.c.is("Eq")) {
        if (!this.skipPatternPart()) return null;
        return { kind: "refused", error: parameterDefault(t) };
      }
      return { kind: "name", name: t.text, pos: t.pos };
    }
    if (this.c.is("LBracket")) {
      const open = this.c.next();
      const parts: (PatternPart | null)[] = [];
      let refused: ParseError | null = null;
      if (!this.c.eat("RBracket")) {
        do {
          if (this.c.is("RBracket")) break;
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

  private skipPatternPart(): boolean {
    let depth = 0;
    for (;;) {
      const t = this.c.peek();
      if (t.type === "EOF") return false;
      if (depth === 0 && (t.type === "Comma" || t.type === "RBracket" || t.type === "RBrace" || t.type === "RParen")) {
        return true;
      }
      if (t.type === "LParen" || t.type === "LBracket" || t.type === "LBrace") depth++;
      if (t.type === "RParen" || t.type === "RBracket" || t.type === "RBrace") depth--;
      this.c.next();
    }
  }

  private lambdaOf(params: readonly ParamRead[], pos: number, arrow: boolean): Lambda {
    for (const p of params) if (p !== null && p.kind === "refused") throw p.error;
    const named = params as readonly Exclude<ParamRead, null | { kind: "refused" }>[];
    const binders: Binder[] = [];
    for (const p of named) {
      if (p.kind === "name") binders.push({ name: p.name, pos: p.pos });
      else for (const part of p.parts) if (part !== null) binders.push(part);
    }
    if (arrow || named.some((p) => p.kind !== "name")) refuseDuplicateParams(binders);
    if (named.every((p) => p.kind === "name")) {
      return this.lambdaBody(
        named.map((p) => (p as { name: string }).name),
        pos,
        binders,
      );
    }
    const plain = named.map((p) => (p.kind === "name" ? p.name : ""));
    const parsed = this.lambdaBody(plain, pos, binders);
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
    const end = this.unclaimedStages.get(parsed);
    if (end !== undefined) {
      this.unclaimedStages.delete(parsed);
      this.unclaimedStages.set(lambda, end);
    }
    return lambda;
  }

  private lambdaBody(params: readonly string[], pos: number, binders: readonly Binder[]): Lambda {
    if (!this.c.is("LBrace")) {
      return { type: "Lambda", params, body: this.expression(), pos };
    }
    const open = this.c.next();
    const { stmts, ret, retPos, endPos } = this.block("RBrace", binders);
    if (ret !== null) {
      const decls = stmts.filter((st): st is LetDecl => st.type === "LetDecl");
      if (decls.length !== stmts.length) {
        const stmt = stmts.find((st) => st.type !== "LetDecl") as PipelineStmt;
        if (!isStageStmt(stmt)) {
          throw new ParseError(
            `A callback's block holds 'const' declarations and one 'return'. This statement is neither, at position ${(stmt as { pos: number }).pos}. Bind it ('const x = …;'), or fold it into the 'return'.`,
            (stmt as { pos: number }).pos,
          );
        }
        throw new ParseError(notPartOfACallback(stmt, retPos), (stmt as { pos: number }).pos);
      }
      return { type: "Lambda", params, body: { type: "ExprBlock", decls, ret, pos: retPos }, pos };
    }
    const lambda: Lambda = { type: "Lambda", params, stages: { type: "Pipeline", stmts, pos: open.pos }, pos };
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

  private arrayElement(): ArrayElement {
    if (this.c.is("Let") || this.c.is("Const")) throw declarationAsElement(this.c.peek(), this.c.peek(1));
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
      const literal = this.number();
      if (literal.type === "ObjectIdLiteral") {
        throw new ParseError(
          `An ObjectId literal cannot be an object key, at position ${t.pos}. A field name is a string. Quote it (\`{ "${literal.hex}": … }\`) to use it as a field name.`,
          t.pos,
        );
      }
      key = { kind: "static", name: String(Number(t.text)) };
    } else if (t.type === "Dollar") {
      this.c.next();
      key = { kind: "static", name: this.dollarName(t).text };
    } else {
      key = { kind: "static", name: this.identLike().text };
    }
    if (key.kind === "static" && !this.c.is("Colon")) {
      if (t.type === "Dollar") {
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

function bin(op: Token, left: Expr, right: Expr): Expr {
  return { type: "BinaryExpr", op: op.text as BinaryOp, left, right, pos: op.pos };
}

export { ParseError };
