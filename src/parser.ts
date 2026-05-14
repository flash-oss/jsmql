import { Lexer, TokenType, type Token } from "./lexer.ts";
import { closestNameTo } from "./levenshtein.ts";
import type {
  Expr,
  BinaryOp,
  ArrayElement,
  ObjectEntry,
  KeyValueEntry,
  SpreadElement,
  TypeCastOp,
  BareCastOp,
  MathMethod,
  MathConstant,
  ObjectMethod,
  ObjectKey,
  CallArg,
  AssignExpr,
  DeleteStmt,
  LetDecl,
  Mutation,
  MutationProgram,
  Pipeline,
  PipelineStmt,
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

/**
 * Raised by `Parser.parseFunctionInput()` when the source given to
 * `jsmql(($) => …)` is not a valid arrow function shape — `async`
 * arrows, `function` declarations, missing arrow operator, unbalanced
 * params, `return` inside a block body, etc. Distinct from `ParseError`
 * because the failure is in the function-shape adapter, not in jsmql's
 * own grammar; `validate()` maps both to `SYNTAX_ERROR`.
 */
export class FunctionInputError extends Error {
  readonly pos: number;
  constructor(message: string, pos: number = 0) {
    super(message);
    this.name = "FunctionInputError";
    this.pos = pos;
  }
}

/**
 * One entry in the params destructure of a function-form arrow.
 * - `key` is the property looked up on the params object at call time
 *   (the *outer* destructure key).
 * - `name` is the identifier used in the function body (the *inner* alias if
 *   the user wrote `{ key: alias }`, or the same as `key` otherwise).
 *
 * Most users never alias and both fields are identical; aliasing exists so a
 * verbose public param name can have a short body-local synonym.
 */
export type ParamBinding = { key: string; name: string };

/**
 * Result of `Parser.parseFunctionInput()`. The function source is split into a
 * parsed body (`program`) and the parameter bindings extracted from the params
 * slot (`bindings`, empty when the arrow has no params destructure). The two
 * pieces travel together because codegen needs the binding names to interpret
 * bare identifiers in the body as parameter references rather than unknown
 * idents.
 */
export type FunctionInputResult = {
  program: Program;
  bindings: ParamBinding[];
};

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
// Subset of TYPE_CAST_NAMES that are also valid as bare callbacks:
//   $.items.filter(Boolean) === $.items.filter(x => Boolean(x))
// parseInt / parseFloat are excluded so we don't import the JS
// `arr.map(parseInt)` index-as-radix footgun — users opt in explicitly with
// `x => parseInt(x)`.
const BARE_CAST_NAMES = new Set<BareCastOp>(["Number", "String", "Boolean"]);

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
    // Top-level grammar:
    //   program := stmt (";" stmt)* ";"?
    // where each `stmt` is either an expression or a mutation chain (one or
    // more comma-separated mutations). Any presence of `;` — including a
    // single trailing one — flips the input to pipeline mode (`Pipeline`),
    // and each `;`-separated chunk becomes its own stage(s) in the lowerer
    // with no cross-coalescing. Without any `;`, behaviour is unchanged:
    // the single statement is returned as `Expr` or `MutationProgram`.
    const stmts: PipelineStmt[] = [this.collectStatement()];
    let sawSemi = false;
    while (this.lexer.peek().type === TokenType.Semi) {
      this.lexer.next(); // consume `;`
      sawSemi = true;
      if (this.lexer.peek().type === TokenType.EOF) break; // trailing `;`
      stmts.push(this.collectStatement());
    }

    const eof = this.lexer.peek();
    if (eof.type !== TokenType.EOF) {
      throw new ParseError(`Unexpected token '${eof.value}' at position ${eof.pos}`, eof.pos);
    }

    if (!sawSemi) {
      const only = stmts[0];
      if (only.type === "LetDecl") this.throwLetOutsidePipeline(only.name, only.pos);
      return only;
    }
    return { type: "Pipeline", stmts, pos: stmts[0].pos };
  }

  /**
   * Entry point for the function-input form (`jsmql(($) => …)`). The source
   * is the result of `Function.prototype.toString.call(fn)` — a full arrow
   * function expression. We consume the parameter list and `=>`, then dispatch
   * to either a block-body parser (`{ stmt; stmt; }`, the function-form mirror
   * of the implicit `;`-separated pipeline) or an expression-body parser (a
   * single jsmql expression / mutation, with one optional trailing `;` allowed
   * as a formatter artifact — single-statement bodies do NOT flip into pipeline
   * mode here).
   *
   * Raises `FunctionInputError` for shape problems specific to the adapter
   * (`async`, `function`, missing arrow, `return` in a block body, …) and
   * `ParseError`/`LexError` for grammar problems inside the body itself.
   */
  parseFunctionInput(): FunctionInputResult {
    const first = this.lexer.peek();
    if (first.type === TokenType.Ident && first.value === "async") {
      throw new FunctionInputError(
        "jsmql does not support async functions. Use a synchronous arrow: `($) => …`",
        first.pos,
      );
    }
    if (first.type === TokenType.Ident && first.value === "function") {
      throw new FunctionInputError(
        "jsmql expects an arrow function, got a `function` declaration. Use: `($) => …`",
        first.pos,
      );
    }
    if (first.type !== TokenType.LParen) {
      throw new FunctionInputError(
        "jsmql expects an arrow function `($) => …` as the function-form input.",
        first.pos,
      );
    }
    const bindings = this.parseParameterList();

    const arrowTok = this.lexer.peek();
    if (arrowTok.type !== TokenType.Arrow) {
      throw new FunctionInputError(
        "jsmql could not find an arrow operator (`=>`) in the function source. Use: `($) => …`",
        arrowTok.pos,
      );
    }
    this.lexer.next(); // consume `=>`

    const program =
      this.lexer.peek().type === TokenType.LBrace
        ? this.parseBlockBody()
        : this.parseExpressionBody();
    return { program, bindings };
  }

  /**
   * Parse and classify the parenthesised parameter list of the function-form
   * arrow. Each top-level parameter slot is one of three *shapes*:
   *
   *   - **Plain identifier** (`$`, `doc`, anything) — the document-context slot.
   *     Discarded; the body parser doesn't need the name.
   *   - **Destructure pattern with all keys starting with `$`** (`{ $dateDiff }`,
   *     `{ $match, $project }`) — the ops-hint slot (types-only IDE
   *     autocomplete). Discarded; the keys don't reach codegen.
   *   - **Destructure pattern with at least one non-`$` key** (`{ minAge }`) —
   *     the function-form parameter bindings. Names are returned so codegen can
   *     inline values supplied at `jsmql.compile()` call time.
   *
   * The legal slot orderings are: `()`, `(doc)`, `(ops)`, `(params)`,
   * `(doc, ops)`, `(params, doc)`, `(params, ops)`, `(params, doc, ops)`.
   * Anything else throws `FunctionInputError` with a precise message.
   *
   * Returns the binding names extracted from the params slot (in source
   * order). Cursor is left immediately after the closing `)`.
   */
  private parseParameterList(): ParamBinding[] {
    this.lexer.next(); // consume opening `(`

    type Slot =
      | { kind: "doc"; pos: number }
      | { kind: "ops"; pos: number }
      | { kind: "params"; bindings: ParamBinding[]; pos: number };
    const slots: Slot[] = [];

    if (this.lexer.peek().type !== TokenType.RParen) {
      while (true) {
        slots.push(this.parseParameterSlot());
        const sep = this.lexer.peek();
        if (sep.type === TokenType.Comma) {
          this.lexer.next();
          continue;
        }
        if (sep.type === TokenType.RParen) break;
        throw new FunctionInputError(
          `jsmql could not parse the function parameter list — expected ',' or ')' at position ${sep.pos}, got '${sep.value}'.`,
          sep.pos,
        );
      }
    }
    const closeParen = this.lexer.next(); // consume `)`

    if (slots.length > 3) {
      throw new FunctionInputError(
        `jsmql's compile-form arrow takes at most three parameters in the order \`(params, $, opsHint)\`. ` +
          `Got ${slots.length} parameters. Reorder to \`(params, $, opsHint)\` and drop any extras.`,
        closeParen.pos,
      );
    }

    // Validate slot ordering. The legal orderings are: each slot kind appears
    // at most once, and the order (when all present) is params → doc → ops.
    let sawParams = false;
    let sawDoc = false;
    let sawOps = false;
    let bindings: ParamBinding[] = [];
    for (const slot of slots) {
      if (slot.kind === "params") {
        if (sawParams) {
          throw new FunctionInputError(
            "jsmql params destructure may only appear once. Combine the bindings into a single parameter: `({ a, b }, …) => …`.",
            slot.pos,
          );
        }
        if (sawDoc || sawOps) {
          throw new FunctionInputError(
            "jsmql expects the params destructure to appear before the `$` doc-context parameter and the ops-hint destructure. " +
              "Reorder to `(params, $, opsHint)`.",
            slot.pos,
          );
        }
        sawParams = true;
        bindings = slot.bindings;
      } else if (slot.kind === "doc") {
        if (sawDoc) {
          throw new FunctionInputError(
            "jsmql's compile-form arrow takes at most one document-context parameter (`$`).",
            slot.pos,
          );
        }
        if (sawOps) {
          throw new FunctionInputError(
            "jsmql expects the `$` doc-context parameter to appear before the ops-hint destructure. " +
              "Reorder to `(params, $, opsHint)`.",
            slot.pos,
          );
        }
        sawDoc = true;
      } else {
        if (sawOps) {
          throw new FunctionInputError(
            "jsmql's compile-form arrow takes at most one ops-hint destructure (e.g. `{ $match }`).",
            slot.pos,
          );
        }
        sawOps = true;
      }
    }
    return bindings;
  }

  /**
   * Parse a single parameter slot and classify it by shape. Called by
   * `parseParameterList`; advances the lexer past the slot.
   */
  private parseParameterSlot():
    | { kind: "doc"; pos: number }
    | { kind: "ops"; pos: number }
    | { kind: "params"; bindings: ParamBinding[]; pos: number } {
    const head = this.lexer.peek();
    if (head.type === TokenType.LBracket) {
      throw new FunctionInputError(
        "jsmql params must be an object destructure pattern: `{ a, b }`. " +
          "Array destructure is not accepted — params are always named, never positional.",
        head.pos,
      );
    }
    if (head.type === TokenType.Ident) {
      // Plain-identifier slot — discard the name.
      this.lexer.next();
      return { kind: "doc", pos: head.pos };
    }
    if (head.type === TokenType.Dollar) {
      // Plain `$` identifier in the doc slot.
      this.lexer.next();
      return { kind: "doc", pos: head.pos };
    }
    if (head.type !== TokenType.LBrace) {
      throw new FunctionInputError(
        `jsmql expects each parameter to be an identifier or an object destructure pattern. Got '${head.value}' at position ${head.pos}.`,
        head.pos,
      );
    }
    return this.parseDestructureSlot();
  }

  /**
   * Parse `{ key (: alias)? (, key)* (,)? }` and classify the slot as `ops`
   * (every key starts with `$`) or `params` (at least one non-`$` key).
   * Rejects defaults, nested destructure, rest, and mixed `$`/non-`$` keys
   * with the user-facing error messages from `docs/LANGUAGE.md`.
   */
  private parseDestructureSlot():
    | { kind: "ops"; pos: number }
    | { kind: "params"; bindings: ParamBinding[]; pos: number } {
    const openBrace = this.lexer.next(); // consume `{`
    const opsKeys: string[] = [];
    const paramBindings: ParamBinding[] = [];

    if (this.lexer.peek().type === TokenType.RBrace) {
      // Empty destructure — treat as ops-hint (no-op).
      this.lexer.next();
      return { kind: "ops", pos: openBrace.pos };
    }

    while (true) {
      const key = this.lexer.peek();
      if (key.type === TokenType.Spread) {
        throw new FunctionInputError(
          "jsmql does not support rest patterns in params: `{ ...rest }`. " +
            "The set of bindings must be statically known at compile time so the generated MQL can reference each by name. " +
            "List each binding explicitly: `{ a, b, c }`.",
          key.pos,
        );
      }
      // Either `$name` (Dollar followed by Ident) for ops-hint keys, or
      // `name` (Ident) for params keys.
      let keyName: string;
      let isOpsKey: boolean;
      if (key.type === TokenType.Dollar) {
        this.lexer.next();
        const ident = this.lexer.peek();
        if (ident.type !== TokenType.Ident) {
          throw new FunctionInputError(
            `jsmql expected an identifier after '$' in the destructure key at position ${ident.pos}.`,
            ident.pos,
          );
        }
        this.lexer.next();
        keyName = `$${ident.value}`;
        isOpsKey = true;
      } else if (key.type === TokenType.Ident) {
        this.lexer.next();
        keyName = key.value;
        isOpsKey = false;
      } else {
        throw new FunctionInputError(
          `jsmql expected an identifier in the destructure pattern at position ${key.pos}, got '${key.value}'.`,
          key.pos,
        );
      }

      // Optional alias: `{ key: alias }`. Used for params keys to give the
      // body identifier a different (usually shorter) name than the param
      // object property name. Ignored for ops keys — the alias would only
      // serve IDE autocomplete, which the original key already provides.
      let bindingName = keyName;
      if (this.lexer.peek().type === TokenType.Colon) {
        this.lexer.next(); // consume `:`
        const alias = this.lexer.peek();
        if (alias.type === TokenType.LBrace || alias.type === TokenType.LBracket) {
          throw new FunctionInputError(
            "jsmql does not support nested destructure in params: `{ <name>: { … } }`. " +
              "Params is a flat key→value map at the MQL level. Use a single level of destructure and reference nested fields explicitly at the call site, e.g. `q({ b: source.a.b })`.",
            alias.pos,
          );
        }
        if (alias.type !== TokenType.Ident) {
          throw new FunctionInputError(
            `jsmql expected an alias identifier after ':' in the destructure pattern at position ${alias.pos}, got '${alias.value}'.`,
            alias.pos,
          );
        }
        this.lexer.next();
        bindingName = alias.value;
      }

      // Optional default: `{ key = expr }` — always rejected.
      if (this.lexer.peek().type === TokenType.Eq) {
        const defaultTok = this.lexer.peek();
        throw new FunctionInputError(
          "jsmql does not support default values in the params destructure: `{ <name> = <expr> }`.\n\n" +
            "jsmql compiles your function to MQL at parse time. It reads the function's source text but cannot evaluate the default expression — for `= config.minAge` or `= Date.now()` there is no runtime to ask, since jsmql never actually calls your arrow. Restricting defaults to literals (`= 18`) would make the rule silently inconsistent with the rest of the destructure, where any value is fine at call time.\n\n" +
            "Instead:\n" +
            "  - For a runtime fallback, use JS's `??` at the call site: `q({ minAge: input ?? 18 })`.\n" +
            "  - For a value that's always the same and never overridden, the template-tag form already inlines hardcoded values: `` jsmql`$.age > ${18}` ``.",
          defaultTok.pos,
        );
      }

      if (isOpsKey) opsKeys.push(keyName);
      else paramBindings.push({ key: keyName, name: bindingName });

      const sep = this.lexer.peek();
      if (sep.type === TokenType.Comma) {
        this.lexer.next();
        // Allow trailing comma.
        if (this.lexer.peek().type === TokenType.RBrace) break;
        continue;
      }
      if (sep.type === TokenType.RBrace) break;
      throw new FunctionInputError(
        `jsmql could not parse the destructure pattern — expected ',' or '}' at position ${sep.pos}, got '${sep.value}'.`,
        sep.pos,
      );
    }
    this.lexer.next(); // consume `}`

    if (opsKeys.length > 0 && paramBindings.length > 0) {
      throw new FunctionInputError(
        "jsmql expects the operator-hint destructure (e.g. `{ $match, $project }`) to be separate from the params destructure (e.g. `{ minAge }`). " +
          "Split into two parameters: `(params, $, opsHint) => …`.",
        openBrace.pos,
      );
    }
    if (paramBindings.length > 0)
      return { kind: "params", bindings: paramBindings, pos: openBrace.pos };
    return { kind: "ops", pos: openBrace.pos };
  }

  /**
   * Parse the body of a block-body arrow: `{ stmt (; stmt)* ;? }`. This is
   * structurally the same as the top-level `;`-separated pipeline form
   * (see `parse()`), terminated by `}` instead of EOF. A single-statement
   * block body without `;` returns the underlying `Expr`/`MutationProgram`
   * unchanged; any `;` (including a trailing one) wraps as a `Pipeline`.
   *
   * `return` is rejected up front with a precise `FunctionInputError` so the
   * user gets a clear pointer to either the `;`-separated form or an
   * expression-body arrow, instead of the parser's generic "unknown
   * identifier" message.
   */
  private parseBlockBody(): Program {
    const openBrace = this.lexer.next(); // consume `{`

    if (this.lexer.peek().type === TokenType.RBrace) {
      throw new FunctionInputError(
        "jsmql expects at least one statement inside a block-body arrow.",
        openBrace.pos,
      );
    }

    this.rejectReturn();
    const stmts: PipelineStmt[] = [this.collectStatement()];
    let sawSemi = false;
    while (this.lexer.peek().type === TokenType.Semi) {
      this.lexer.next();
      sawSemi = true;
      if (this.lexer.peek().type === TokenType.RBrace) break;
      this.rejectReturn();
      stmts.push(this.collectStatement());
    }

    const closeTok = this.lexer.peek();
    if (closeTok.type !== TokenType.RBrace) {
      throw new ParseError(
        `Expected '}' to close the block body at position ${closeTok.pos}`,
        closeTok.pos,
      );
    }
    this.lexer.next();

    const eof = this.lexer.peek();
    if (eof.type !== TokenType.EOF) {
      throw new ParseError(`Unexpected token after function body at position ${eof.pos}`, eof.pos);
    }

    if (!sawSemi) {
      const only = stmts[0];
      if (only.type === "LetDecl") this.throwLetOutsidePipeline(only.name, only.pos);
      return only;
    }
    return { type: "Pipeline", stmts, pos: stmts[0].pos };
  }

  /**
   * Parse the body of an expression-body arrow: a single jsmql statement,
   * with one optional trailing `;` consumed as a formatter artifact. The
   * trailing `;` does NOT trigger pipeline mode here — single-statement
   * expression bodies preserve their object-shaped output, matching the
   * documented contract for `jsmql(($) => …)`.
   */
  private parseExpressionBody(): Program {
    const stmt = this.collectStatement();
    if (this.lexer.peek().type === TokenType.Semi) {
      this.lexer.next();
    }
    const eof = this.lexer.peek();
    if (eof.type !== TokenType.EOF) {
      throw new ParseError(`Unexpected token after function body at position ${eof.pos}`, eof.pos);
    }
    if (stmt.type === "LetDecl") this.throwLetOutsidePipeline(stmt.name, stmt.pos);
    return stmt;
  }

  /**
   * Raised when a `let` declaration appears at the top of an input that turns
   * out to be expression-mode (no `;` separator, not a bracketed pipeline).
   * `let` only makes sense as a pipeline statement — there's no enclosing
   * scope for the binding to live in otherwise.
   */
  private throwLetOutsidePipeline(name: string, pos: number): never {
    throw new ParseError(
      `\`let ${name} = …\` is only valid inside a pipeline. ` +
        `Add at least one more statement separated by \`;\` to flip into pipeline mode ` +
        `(e.g. \`let ${name} = …; { $project: … }\`). ` +
        `The bracketed pipeline form \`[ let ${name} = …, … ]\` works too.`,
      pos,
    );
  }

  /**
   * Throw a precise `FunctionInputError` if the next token is the bare
   * identifier `return`. Called at every statement-start position inside
   * a block body, so a `return` token *inside* a string or expression
   * (where it would just be a property name like `obj.return`) doesn't
   * false-fire — only true statement-leading `return`s reach this check.
   */
  private rejectReturn(): void {
    const tok = this.lexer.peek();
    if (tok.type === TokenType.Ident && tok.value === "return") {
      throw new FunctionInputError(
        "jsmql block-body arrows are a sequence of jsmql statements, not JavaScript control flow. " +
          "Remove `return` — write the body as `;`-separated jsmql statements, or switch to an " +
          "expression-body arrow `($) => EXPR`.",
        tok.pos,
      );
    }
  }

  /**
   * Parse one top-level statement: either an expression or a mutation chain
   * (one or more comma-separated mutations sharing a stage). Stops at the
   * first `;` or EOF; the caller (`parse()`) handles the `;` boundary.
   */
  private collectStatement(): PipelineStmt {
    const first = this.lexer.peek();

    // `let <ident> = <expr>` — pipeline-scoped local binding. Only legal in a
    // pipeline context; codegen errors if it shows up in expression-mode input
    // (no `;` boundary and not inside a bracketed pipeline).
    if (first.type === TokenType.Let) {
      return this.parseLetDecl();
    }

    // Tokens that can ONLY start a mutation program: `delete`, `++`, `--`.
    // Their presence at the start of a statement unambiguously commits us
    // to mutation parsing. Other mutation forms (=, +=, x++, …) reveal
    // themselves only after a target expression has been parsed — below.
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
    // actually a mutation target — treat the rest of the statement as a
    // mutation chain.
    if (this.peekAssignOp() !== null) {
      this.validateMutationTarget(expr);
      return this.parseMutationProgramFrom(expr);
    }

    // Postfix `x++` / `x--`.
    if (this.peekIncDecOp() !== null) {
      this.validateMutationTarget(expr);
      return this.parseMutationProgramFromPostfix(expr);
    }

    // `parseExpression` may have surfaced an `AssignExpr` from a parenthesized
    // top-level assignment (`($.a = 5)`). Wrap it in a MutationProgram so
    // codegen routes through the mutation path.
    if ((expr as unknown as { type: string }).type === "AssignExpr") {
      const mutations: Mutation[] = [expr as unknown as AssignExpr];
      this.parseMutationProgramRest(mutations);
      return { type: "MutationProgram", mutations, pos: mutations[0].pos };
    }

    return expr;
  }

  // ── Let declaration ──────────────────────────────────────────────────────

  /**
   * Parse `let <ident> = <expr>`. The leading `let` token must already be the
   * current peek; this consumes it and the rest of the declaration. The cursor
   * is left at whatever follows the value expression (typically `;` or `,` in
   * the array-pipeline form). No re-declaration check here — that needs a
   * pipeline-level view and lives in codegen.
   */
  private parseLetDecl(): LetDecl {
    const letTok = this.lexer.next(); // consume `let`
    const ident = this.lexer.peek();
    if (ident.type !== TokenType.Ident) {
      throw new ParseError(
        `Expected an identifier after \`let\` at position ${ident.pos}, got '${ident.value}'`,
        ident.pos,
      );
    }
    this.lexer.next(); // consume the identifier
    const eq = this.lexer.peek();
    if (eq.type !== TokenType.Eq) {
      throw new ParseError(
        `Expected '=' after \`let ${ident.value}\` at position ${eq.pos}, got '${eq.value}'. ` +
          `\`let\` requires an initialiser — write \`let ${ident.value} = <expr>\`.`,
        eq.pos,
      );
    }
    this.lexer.next(); // consume `=`
    const value = this.parseExpression();
    return { type: "LetDecl", name: ident.value, value, pos: letTok.pos };
  }

  // ── Mutation program ─────────────────────────────────────────────────────

  /** Entry when the input starts with a mutation token (`delete`). */
  private parseMutationProgram(): MutationProgram {
    const mutations: Mutation[] = [];
    mutations.push(...this.parseMutation());
    this.parseMutationProgramRest(mutations);
    return { type: "MutationProgram", mutations, pos: mutations[0].pos };
  }

  /** Entry when the first target was already parsed as an expression. */
  private parseMutationProgramFrom(firstTarget: Expr): MutationProgram {
    const mutations: Mutation[] = [];
    mutations.push(...this.parseAssignmentChainFrom(firstTarget));
    this.parseMutationProgramRest(mutations);
    return { type: "MutationProgram", mutations, pos: mutations[0].pos };
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
    return { type: "MutationProgram", mutations, pos: mutations[0].pos };
  }

  /**
   * After the first mutation is parsed, consume any `,`-separated tail.
   * Stops at the first non-`,` token (typically `;` or EOF) and leaves
   * the cursor there for the caller to handle.
   */
  private parseMutationProgramRest(mutations: Mutation[]): void {
    while (this.peekMutationSeparator()) {
      this.lexer.next(); // consume `,`
      const next = this.lexer.peek().type;
      if (next === TokenType.EOF || next === TokenType.Semi) break; // trailing separator
      mutations.push(...this.parseMutation());
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
    const delTok = this.lexer.next(); // consume `delete`
    const target = this.parsePostfix();
    this.validateMutationTarget(target);
    return { type: "DeleteStmt", target, pos: delTok.pos };
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
        return [{ type: "AssignExpr", target, value: deepestValue, pos: target.pos }, ...sub];
      }
      const value = this.parseExpression();
      return [{ type: "AssignExpr", target, value, pos: target.pos }];
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
      pos: target.pos,
    };
    return [{ type: "AssignExpr", target, value: desugared, pos: target.pos }];
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
    return this.lexer.peek().type === TokenType.Comma;
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
      right: { type: "NumberLiteral", value: 1, pos: target.pos },
      pos: target.pos,
    };
    return { type: "AssignExpr", target, value, pos: target.pos };
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
      `Cannot assign to ${describeMutationTarget(target)} at position ${pos} — only field paths like '$.x' or '$.x.y' are assignable.`,
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
    return { type: "TernaryExpr", condition, consequent, alternate, pos: condition.pos };
  }

  /** nullish:  or ("??" or)*  — left-associative, flattened later */
  private parseNullish(): Expr {
    let left = this.parseOr();
    while (this.lexer.peek().type === TokenType.QuestQuest) {
      this.lexer.next();
      const right = this.parseOr();
      left = { type: "BinaryExpr", op: "??", left, right, pos: left.pos };
    }
    return left;
  }

  /** or:  and ("||" and)*  */
  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.lexer.peek().type === TokenType.PipePipe) {
      this.lexer.next();
      const right = this.parseAnd();
      left = { type: "BinaryExpr", op: "||", left, right, pos: left.pos };
    }
    return left;
  }

  /** and:  bitOr ("&&" bitOr)*  */
  private parseAnd(): Expr {
    let left = this.parseBitOr();
    while (this.lexer.peek().type === TokenType.AmpAmp) {
      this.lexer.next();
      const right = this.parseBitOr();
      left = { type: "BinaryExpr", op: "&&", left, right, pos: left.pos };
    }
    return left;
  }

  /** bitOr:  bitXor ("|" bitXor)*  */
  private parseBitOr(): Expr {
    let left = this.parseBitXor();
    while (this.lexer.peek().type === TokenType.Pipe) {
      this.lexer.next();
      const right = this.parseBitXor();
      left = { type: "BinaryExpr", op: "|", left, right, pos: left.pos };
    }
    return left;
  }

  /** bitXor:  bitAnd ("^" bitAnd)*  */
  private parseBitXor(): Expr {
    let left = this.parseBitAnd();
    while (this.lexer.peek().type === TokenType.Caret) {
      this.lexer.next();
      const right = this.parseBitAnd();
      left = { type: "BinaryExpr", op: "^", left, right, pos: left.pos };
    }
    return left;
  }

  /** bitAnd:  comparison ("&" comparison)*  */
  private parseBitAnd(): Expr {
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
  private parseComparison(): Expr {
    const left = this.parseRelational();
    const op = this.peekEqualityOp();
    if (!op) return left;
    this.lexer.next();
    const right = this.parseRelational();
    return { type: "BinaryExpr", op, left, right, pos: left.pos };
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
    return { type: "BinaryExpr", op, left, right, pos: left.pos };
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
      left = { type: "BinaryExpr", op, left, right, pos: left.pos };
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
      left = { type: "BinaryExpr", op, left, right, pos: left.pos };
    }
    return left;
  }

  /** power:  unary ("**" power)?  — right-associative  */
  private parsePower(): Expr {
    const left = this.parseUnary();
    if (this.lexer.peek().type !== TokenType.StarStar) return left;
    this.lexer.next();
    const right = this.parsePower(); // right-associative
    return { type: "BinaryExpr", op: "**", left, right, pos: left.pos };
  }

  /** unary:  typeof | ("!"|"-"|"~") unary  |  postfix  */
  private parseUnary(): Expr {
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
  private parsePostfix(): Expr {
    let left = this.parsePrimary();
    for (;;) {
      const t = this.lexer.peek().type;
      if (t === TokenType.LParen) {
        // Direct call expression: e.g. ((x) => body)(arg) — only meaningful when the
        // callee is a lambda (IIFE). Codegen emits $let; non-lambda callees error there.
        const args = this.parseMethodCallArgs();
        left = { type: "CallExpression", callee: left, args, pos: left.pos };
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
        left = { type: "IndexAccess", object: left, index, pos: left.pos };
      } else if (t === TokenType.Dot || t === TokenType.QuestDot) {
        const isOptional = t === TokenType.QuestDot;
        this.lexer.next(); // consume . or ?.
        // ?.[...] form — optional bracket access
        if (isOptional && this.lexer.peek().type === TokenType.LBracket) {
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
          left = { type: "IndexAccess", object: left, index, pos: left.pos, optional: true };
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
          left = {
            type: "MethodCall",
            object: left,
            method: member.value,
            args,
            pos: left.pos,
            ...(isOptional && { optional: true }),
          };
        } else {
          // Property access: left.member
          left = {
            type: "MemberAccess",
            object: left,
            member: member.value,
            pos: left.pos,
            ...(isOptional && { optional: true }),
          };
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
      const spreadTok = this.lexer.next();
      const argument = this.parseExpression();
      const spread: SpreadElement = { type: "SpreadElement", argument, pos: spreadTok.pos };
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
        if (TYPE_CAST_NAMES.has(name)) {
          if (this.lexer.lookahead(1).type === TokenType.LParen) return this.parseTypeCast();
          if (BARE_CAST_NAMES.has(name as BareCastOp)) {
            this.lexer.next();
            return { type: "TypeCastRef", cast: name as BareCastOp, pos: t.pos };
          }
          // parseInt / parseFloat without `(` falls through to parseTypeCast(),
          // which throws the existing "Expected LParen" error.
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
      // form `jsmql(($) => [($.a = 1)])` works the same as the bare form.
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
      return { type: "OperatorCall", name, style: "positional", args: [], pos: dollar.pos };
    }

    // Object-style: single `{...}` arg with no trailing comma
    if (peek.type === TokenType.LBrace) {
      const obj = this.parseObjectLiteral();
      const after = this.lexer.peek();
      if (after.type === TokenType.RParen) {
        this.lexer.next();
        return { type: "OperatorCall", name, style: "object", args: [obj], pos: dollar.pos };
      }
      // First positional arg happens to be an object — collect remaining args
      const args: CallArg[] = [obj];
      while (this.lexer.peek().type === TokenType.Comma) {
        this.lexer.next();
        args.push(this.parseCallArg());
      }
      this.lexer.expect(TokenType.RParen);
      return { type: "OperatorCall", name, style: "positional", args, pos: dollar.pos };
    }

    // Positional args (may include lambdas and spreads)
    const args: CallArg[] = [this.parseCallArg()];
    while (this.lexer.peek().type === TokenType.Comma) {
      this.lexer.next();
      args.push(this.parseCallArg());
    }
    this.lexer.expect(TokenType.RParen);
    return { type: "OperatorCall", name, style: "positional", args, pos: dollar.pos };
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
    return { type: "FieldRef", path: first.value, pos: dollarDot.pos };
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
      t.type === TokenType.Typeof ||
      t.type === TokenType.Let
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
    return { type: "Lambda", params: [paramTok.value], body, pos: paramTok.pos };
  }

  /** Parse "(x) => expr" or "(x, y) => expr" or "() => expr" */
  private parseLambdaParen(): Expr {
    const lparen = this.lexer.next(); // consume (
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
    return { type: "Lambda", params, body, pos: lparen.pos };
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
      return cls === "Date"
        ? { type: "NewDate", arg: null, pos: newTok.pos }
        : { type: "NewSet", arg: null, pos: newTok.pos };
    }
    const arg = this.parseExpression();
    this.lexer.expect(TokenType.RParen);
    return cls === "Date"
      ? { type: "NewDate", arg, pos: newTok.pos }
      : { type: "NewSet", arg, pos: newTok.pos };
  }

  /** "Date.now()" — recognised as a primary; other Date.* members are not supported */
  private parseDateNow(): Expr {
    const dateTok = this.lexer.next(); // consume 'Date'
    this.lexer.expect(TokenType.Dot);
    const methodTok = this.lexer.peek();
    if (methodTok.type !== TokenType.Ident || methodTok.value !== "now") {
      throw new ParseError(
        `Unknown Date method '${methodTok.value}' at position ${methodTok.pos}. ` +
          `Only Date.now() is supported as a JS-style call; for other date operations ` +
          `use the $date* operators directly (e.g. $dateAdd, $dateDiff, $dateTrunc, $dateToString).`,
        dateTok.pos,
      );
    }
    this.lexer.next(); // consume 'now'
    this.lexer.expect(TokenType.LParen);
    this.lexer.expect(TokenType.RParen);
    return { type: "DateNow", pos: dateTok.pos };
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
      return {
        type: "OperatorCall",
        name: "$isArray",
        style: "positional",
        args: [arg],
        pos: arrayTok.pos,
      };
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
      return { type: "ArrayFrom", input, mapFn, pos: arrayTok.pos };
    }
    const arraySuggestion = closestNameTo(methodTok.value, ["isArray", "from"]);
    const arrayHint = arraySuggestion ? ` Did you mean 'Array.${arraySuggestion}'?` : "";
    throw new ParseError(
      `Unknown Array method '${methodTok.value}' at position ${methodTok.pos}.${arrayHint} Supported: Array.isArray(), Array.from().`,
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
      const numberSuggestion = closestNameTo(methodTok.value, ["isInteger", "isNaN", "isFinite"]);
      const numberHint = numberSuggestion ? ` Did you mean 'Number.${numberSuggestion}'?` : "";
      throw new ParseError(
        `Unknown Number static method '${methodTok.value}' at position ${methodTok.pos}.${numberHint} Supported: Number.isInteger, Number.isNaN, Number.isFinite.`,
        numberTok.pos,
      );
    }
    const method = methodTok.value as "isInteger" | "isNaN" | "isFinite";
    this.lexer.next();
    this.lexer.expect(TokenType.LParen);
    const arg = this.parseExpression();
    this.lexer.expect(TokenType.RParen);
    return { type: "NumberStatic", method, arg, pos: numberTok.pos };
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
      return { type: "MathConst", name: ident.value as MathConstant, pos: mathTok.pos };
    }
    if (!MATH_METHODS.has(ident.value)) {
      const suggestion = closestNameTo(ident.value, [...MATH_METHODS, ...MATH_CONSTANTS]);
      const hint = suggestion ? ` Did you mean 'Math.${suggestion}'?` : "";
      throw new ParseError(
        `Unknown Math member '${ident.value}' at position ${ident.pos}.${hint} See docs/LANGUAGE.md for the full list of supported Math methods and constants.`,
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
    return { type: "MathCall", method, args, pos: mathTok.pos };
  }

  /** "Object.method(args)" */
  private parseObjectCall(): Expr {
    const objectTok = this.lexer.next(); // consume 'Object'
    this.lexer.expect(TokenType.Dot);
    const methodTok = this.lexer.peek();
    if (methodTok.type !== TokenType.Ident || !OBJECT_METHODS.has(methodTok.value)) {
      const objectSuggestion = closestNameTo(methodTok.value, [...OBJECT_METHODS]);
      const objectHint = objectSuggestion ? ` Did you mean 'Object.${objectSuggestion}'?` : "";
      throw new ParseError(
        `Unknown Object method '${methodTok.value}' at position ${methodTok.pos}.${objectHint} Supported: ${[...OBJECT_METHODS].join(", ")}.`,
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
    return { type: "ObjectCall", method, args, pos: objectTok.pos };
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
    return { type: "TypeCast", cast, arg, pos: castTok.pos };
  }

  private parseNumber(): Expr {
    const t = this.lexer.next();
    const value = parseFloat(t.value);
    if (isNaN(value)) {
      throw new ParseError(`Invalid number '${t.value}' at position ${t.pos}`, t.pos);
    }
    return { type: "NumberLiteral", value, pos: t.pos };
  }

  /** Parse a template literal: `chunk0${expr0}chunk1${expr1}chunk2` */
  private parseTemplateLiteral(): Expr {
    const startTok = this.lexer.expect(TokenType.TemplateStart);
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

    return { type: "TemplateLiteral", quasis, expressions, pos: startTok.pos };
  }

  private parseArrayLiteral(): Expr {
    const openBracket = this.lexer.expect(TokenType.LBracket);
    const elements: ArrayElement[] = [];

    while (this.lexer.peek().type !== TokenType.RBracket) {
      if (this.lexer.peek().type === TokenType.EOF) {
        throw new ParseError("Unterminated array literal", this.lexer.peek().pos);
      }
      if (this.lexer.peek().type === TokenType.Spread) {
        const spreadTok = this.lexer.next();
        const arg = this.parseExpression();
        const spread: SpreadElement = {
          type: "SpreadElement",
          argument: arg,
          pos: spreadTok.pos,
        };
        elements.push(spread);
      } else if (this.lexer.peek().type === TokenType.Delete) {
        // `delete $.x` as a pipeline element. Codegen rejects it if the array
        // turns out not to be a pipeline.
        elements.push(this.parseDeleteStmt());
      } else if (this.lexer.peek().type === TokenType.Let) {
        // `let x = expr` as a pipeline element. Codegen rejects it if the
        // array is not a pipeline (parallel to AssignExpr/DeleteStmt handling).
        elements.push(this.parseLetDecl());
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
    return { type: "ArrayLiteral", elements, pos: openBracket.pos };
  }

  private parseObjectLiteral(): Expr {
    const openBrace = this.lexer.expect(TokenType.LBrace);
    const entries: ObjectEntry[] = [];

    while (this.lexer.peek().type !== TokenType.RBrace) {
      if (this.lexer.peek().type === TokenType.EOF) {
        throw new ParseError("Unterminated object literal", this.lexer.peek().pos);
      }
      if (this.lexer.peek().type === TokenType.Spread) {
        const spreadTok = this.lexer.next();
        const arg = this.parseExpression();
        const spread: SpreadElement = {
          type: "SpreadElement",
          argument: arg,
          pos: spreadTok.pos,
        };
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
      return { type: "KeyValueEntry", key, value, pos: tok.pos };
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
      return { type: "KeyValueEntry", key, value, pos: tok.pos };
    }

    // `let` is a jsmql keyword but is also a legitimate MongoDB object-key name
    // (`$lookup`, `$graphLookup`, `$documents`, and top-level `aggregate({ let: ... })`
    // all carry a `let:` field). Accept it as an object key so those stage shapes
    // continue to parse. Shorthand `{ let }` is intentionally rejected — that
    // would conflict with `let x = …` statements and serve no useful purpose.
    if (tok.type === TokenType.Let) {
      this.lexer.next();
      this.lexer.expect(TokenType.Colon);
      const value = this.parseExpression();
      const key: ObjectKey = { kind: "static", name: "let" };
      return { type: "KeyValueEntry", key, value, pos: tok.pos };
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
      const value: Expr = { type: "ParamRef", name: tok.value, pos: tok.pos };
      return { type: "KeyValueEntry", key, value, pos: tok.pos };
    }
    this.lexer.expect(TokenType.Colon);
    const value = this.parseExpression();
    const key: ObjectKey = { kind: "static", name: tok.value };
    return { type: "KeyValueEntry", key, value, pos: tok.pos };
  }
}

/**
 * Human-friendly noun phrase for an Expr that the user tried to use as a
 * mutation target. Used by `validateMutationTarget` to name *what* the user
 * wrote (a method call, a comparison, a literal, …) rather than just
 * complaining the target wasn't a field path.
 */
function describeMutationTarget(target: Expr): string {
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
      return `the result of ${target.name}(…)`;
    case "MathCall":
      return `the result of Math.${target.method}(…)`;
    case "MathConst":
      return `the Math.${target.name} constant`;
    case "ObjectCall":
      return `the result of Object.${target.method}(…)`;
    case "NewDate":
      return "a 'new Date(…)' expression";
    case "NewSet":
      return "a 'new Set(…)' expression";
    case "DateNow":
      return "the result of Date.now()";
    case "ArrayFrom":
      return "an Array.from(…) result";
    case "NumberStatic":
      return `the result of Number.${target.method}(…)`;
    case "TypeofExpr":
      return "a typeof expression";
    case "RegexLiteral":
      return "a regex literal";
    default:
      return "this expression";
  }
}
