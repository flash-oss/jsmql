import { Lexer, TokenType, formatActualToken, type Token } from "./lexer.ts";
import { didYouMean } from "./levenshtein.ts";
import {
  MATH_METHODS as MATH_METHOD_NAMES,
  MATH_CONSTANTS as MATH_CONSTANT_NAMES,
  OBJECT_METHODS as OBJECT_METHOD_NAMES,
  NUMBER_STATICS,
} from "./ast.ts";
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
  NumberStaticMethod,
  ObjectKey,
  CallArg,
  AssignExpr,
  DeleteStmt,
  LetDecl,
  FuncDecl,
  Lambda,
  ExprBlock,
  UpdateOp,
  UpdateFilter,
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
 * `jsmql(({ $ }) => …)` is not a valid arrow function shape — `async`
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
export type FunctionInputResult = { program: Program; bindings: ParamBinding[] };

/**
 * Math methods that take exactly one argument — the only subset that can be
 * passed as a bare callable (e.g. `arr.map(Math.floor)`). Mirrors the JS
 * unary signatures. Binary methods (`pow`, `min`, `max`, `hypot`, `atan2`)
 * and the zero-arg `random` require explicit parens to avoid arity
 * ambiguity when used as callbacks.
 */
const UNARY_MATH_CALLABLES = new Set<string>([
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
  "tanh",
]);

// Runtime lookup Sets built from the single-source name lists in ast.ts.
const MATH_METHODS = new Set<string>(MATH_METHOD_NAMES);
const MATH_CONSTANTS = new Set<string>(MATH_CONSTANT_NAMES);
const OBJECT_METHODS = new Set<string>(OBJECT_METHOD_NAMES);

const TYPE_CAST_NAMES = new Set<string>(["Number", "String", "Boolean", "parseInt", "parseFloat"]);
// Subset of TYPE_CAST_NAMES that are also valid as bare callbacks:
//   $.items.filter(Boolean) === $.items.filter(x => Boolean(x))
// parseInt / parseFloat are excluded so we don't import the JS
// `arr.map(parseInt)` index-as-radix footgun — users opt in explicitly with
// `x => parseInt(x)`.
const BARE_CAST_NAMES = new Set<BareCastOp>(["Number", "String", "Boolean"]);

// The first 4 bytes of an ObjectId are a Unix timestamp (seconds). MongoDB's
// first public release was 2009, so an ObjectId whose embedded timestamp is
// older than that can't be a real id — it's a typo: a dropped/extra digit, an
// all-zeros placeholder, or a sequential test value like 0x1234…. We floor at
// 0x4a000000 (2009-05-05, the dawn of MongoDB) and reject anything below it.
// A lowercase 24-char hex string compares lexicographically exactly as its
// 96-bit numeric value, so a plain string `<` against the floor is precise.
const OBJECTID_MIN_HEX = "4a0000000000000000000000";

function assertPlausibleObjectId(hex: string, pos: number): void {
  const lower = hex.toLowerCase();
  if (lower < OBJECTID_MIN_HEX) {
    const when = new Date(parseInt(lower.slice(0, 8), 16) * 1000).toISOString().slice(0, 10);
    throw new ParseError(
      `ObjectId ${lower} looks like a typo: its embedded timestamp decodes to ${when}, older than the smallest valid ObjectId ${OBJECTID_MIN_HEX} (2009-05-05, around MongoDB's first release).`,
      pos,
    );
  }
}

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
    // where each `stmt` is either an expression or a update op chain (one or
    // more comma-separated update ops). Any presence of `;` — including a
    // single trailing one — flips the input to pipeline mode (`Pipeline`),
    // and each `;`-separated chunk becomes its own stage(s) in the lowerer
    // with no cross-coalescing. A `function …(){ … }` declaration is also
    // self-terminating (its `}` ends the statement, no `;` needed), so it too
    // flips to pipeline mode. Without any of these, behaviour is unchanged:
    // the single statement is returned as `Expr` or `UpdateFilter`.
    const stmts: PipelineStmt[] = [this.collectStatement()];
    let multi = false;
    while (true) {
      if (this.lexer.peek().type === TokenType.Semi) {
        this.lexer.next(); // consume `;`
        multi = true;
        if (this.lexer.peek().type === TokenType.EOF) break; // trailing `;`
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
  private selfTerminates(stmt: PipelineStmt): boolean {
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
  parseFunctionInput(): FunctionInputResult {
    const first = this.lexer.peek();
    if (first.type === TokenType.Ident && first.value === "async") {
      throw new FunctionInputError(
        "jsmql does not support async functions. Use a synchronous arrow `({ $ }) => …` or `function ({ $ }) { return … }`.",
        first.pos,
      );
    }
    // The `function` keyword form: `function [name] (params) { … }`. Consume the
    // keyword + optional (discarded) name, then fall through to the shared
    // parameter-list parse; the body is a brace block (no `=>`).
    let isFunctionForm = false;
    if (first.type === TokenType.Ident && first.value === "function") {
      this.lexer.next(); // consume `function`
      if (this.lexer.peek().type === TokenType.Star) {
        throw new FunctionInputError(
          "jsmql does not support generator functions (`function*`). Use `function ({ $ }) { return … }` or an arrow `({ $ }) => …`.",
          this.lexer.peek().pos,
        );
      }
      if (this.lexer.peek().type === TokenType.Ident) this.lexer.next(); // optional name — unreachable in MQL, discarded
      isFunctionForm = true;
    }
    if (this.lexer.peek().type !== TokenType.LParen) {
      const tok = this.lexer.peek();
      throw new FunctionInputError(
        isFunctionForm
          ? "jsmql expected '(' to start the parameter list of the `function` input."
          : "jsmql expects an arrow function `({ $ }) => …` (or `function ({ $ }) { return … }`) as the function-form input.",
        tok.pos,
      );
    }
    const bindings = this.parseParameterList();

    if (isFunctionForm) {
      if (this.lexer.peek().type !== TokenType.LBrace) {
        const tok = this.lexer.peek();
        throw new FunctionInputError(
          "jsmql expected '{' to start the body of the `function` input — a `function` body is a block, e.g. `function ({ $ }) { return <expr> }`.",
          tok.pos,
        );
      }
      return { program: this.parseEntryBlockBody(), bindings };
    }

    const arrowTok = this.lexer.peek();
    if (arrowTok.type !== TokenType.Arrow) {
      throw new FunctionInputError(
        "jsmql could not find an arrow operator (`=>`) in the function source. Use: `({ $ }) => …`",
        arrowTok.pos,
      );
    }
    this.lexer.next(); // consume `=>`

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
  private parseEntryBlockBody(): Program {
    if (this.lexer.lookahead(1).type === TokenType.Return) return this.parseEntryReturnBody();
    return this.parseBlockBody();
  }

  /** Parse the entry value body `{ return <expr> ;? }` → the bare `<expr>`. */
  private parseEntryReturnBody(): Program {
    this.lexer.next(); // consume `{`
    this.lexer.next(); // consume `return`
    const expr = this.parseExpression();
    if (this.lexer.peek().type === TokenType.Semi) this.lexer.next(); // optional trailing `;`
    const close = this.lexer.peek();
    if (close.type !== TokenType.RBrace) {
      throw new ParseError(
        `Expected '}' to close the \`{ return … }\` body at position ${close.pos}, got ${formatActualToken(close)}.`,
        close.pos,
      );
    }
    this.lexer.next(); // consume `}`
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
  private parseParameterList(): ParamBinding[] {
    this.lexer.next(); // consume opening `(`

    type Slot = { kind: "toolbox"; pos: number } | { kind: "params"; bindings: ParamBinding[]; pos: number };
    const slots: Slot[] = [];

    if (this.lexer.peek().type !== TokenType.RParen) {
      while (true) {
        slots.push(this.parseParameterSlot());
        const sep = this.lexer.peek();
        if (sep.type === TokenType.Comma) {
          this.lexer.next();
          if (this.lexer.peek().type === TokenType.RParen) break; // trailing comma
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

    if (slots.length > 2) {
      throw new FunctionInputError(
        `jsmql's arrow takes at most two parameters: \`(params, { $, … })\`. ` +
          `Got ${slots.length}. Combine into a params destructure followed by a single toolbox destructure.`,
        closeParen.pos,
      );
    }

    // Validate slot ordering: each slot kind appears at most once, and (when
    // both present) params comes before the toolbox — `(params, { $, … })`.
    let sawParams = false;
    let sawToolbox = false;
    let bindings: ParamBinding[] = [];
    for (const slot of slots) {
      if (slot.kind === "params") {
        if (sawParams) {
          throw new FunctionInputError(
            "jsmql params destructure may only appear once. Combine the bindings into a single parameter: `({ a, b }, …) => …`.",
            slot.pos,
          );
        }
        if (sawToolbox) {
          throw new FunctionInputError(
            "jsmql expects the params destructure to appear before the toolbox destructure. " +
              "Reorder to `(params, { $, … })`.",
            slot.pos,
          );
        }
        sawParams = true;
        bindings = slot.bindings;
      } else {
        if (sawToolbox) {
          throw new FunctionInputError(
            "jsmql's arrow takes at most one toolbox destructure (e.g. `{ $, $match }`).",
            slot.pos,
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
  private parseParameterSlot():
    | { kind: "toolbox"; pos: number }
    | { kind: "params"; bindings: ParamBinding[]; pos: number } {
    const head = this.lexer.peek();
    if (head.type === TokenType.LBracket) {
      throw new FunctionInputError(
        "jsmql params must be an object destructure pattern: `{ a, b }`. " +
          "Array destructure is not accepted — params are always named, never positional.",
        head.pos,
      );
    }
    if (head.type !== TokenType.LBrace) {
      // The document root, the context refs, and operators all live inside a
      // destructured toolbox object — a bare identifier or bare `$` is not a
      // parameter slot. `({ $ }) => …` for the doc, `({ $, $match }) => …` to
      // pull in operators, `(params, { $ }) => …` for a parameterised query.
      throw new FunctionInputError(
        `jsmql expects each parameter to be an object destructure pattern (\`{ … }\`), got '${head.value}' at position ${head.pos}. ` +
          "Write the document context as `({ $ }) => …`.",
        head.pos,
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
  private parseDestructureSlot():
    | { kind: "toolbox"; pos: number }
    | { kind: "params"; bindings: ParamBinding[]; pos: number } {
    const openBrace = this.lexer.next(); // consume `{`
    const toolboxKeys: string[] = [];
    const paramBindings: ParamBinding[] = [];

    if (this.lexer.peek().type === TokenType.RBrace) {
      // Empty destructure — treat as an empty toolbox (no-op).
      this.lexer.next();
      return { kind: "toolbox", pos: openBrace.pos };
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
      // Toolbox keys are `$`-prefixed: the bare document root `$`, an operator
      // `$name` (Dollar followed by Ident), or a context ref `$$` / `$$$` /
      // `$$$$`. A plain `name` (Ident) is a params key.
      let keyName: string;
      let isToolboxKey: boolean;
      if (key.type === TokenType.Dollar) {
        this.lexer.next();
        const after = this.lexer.peek();
        if (after.type === TokenType.Ident) {
          this.lexer.next();
          keyName = `$${after.value}`; // operator/stage key, e.g. `$match`
        } else {
          keyName = "$"; // bare document-root key
        }
        isToolboxKey = true;
      } else if (
        key.type === TokenType.DoubleDollar ||
        key.type === TokenType.TripleDollar ||
        key.type === TokenType.QuadDollar
      ) {
        this.lexer.next();
        keyName = key.value; // context ref: "$$" | "$$$" | "$$$$"
        isToolboxKey = true;
      } else if (key.type === TokenType.Ident) {
        this.lexer.next();
        keyName = key.value;
        isToolboxKey = false;
      } else {
        throw new FunctionInputError(
          `jsmql expected an identifier in the destructure pattern at position ${key.pos}, got '${key.value}'.`,
          key.pos,
        );
      }

      // Optional alias: `{ key: alias }`. Used for params keys to give the
      // body identifier a different (usually shorter) name than the param
      // object property name. Ignored for toolbox keys — the alias would only
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

      if (isToolboxKey) toolboxKeys.push(keyName);
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

    if (toolboxKeys.length > 0 && paramBindings.length > 0) {
      throw new FunctionInputError(
        "jsmql keeps the toolbox destructure (e.g. `{ $, $match }`) separate from the params destructure (e.g. `{ minAge }`). " +
          "Use two parameters: `(params, { $, … }) => …`.",
        openBrace.pos,
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
  private parseBlockBody(): Program {
    const openBrace = this.lexer.next(); // consume `{`

    if (this.lexer.peek().type === TokenType.RBrace) {
      throw new FunctionInputError("jsmql expects at least one statement inside a block-body arrow.", openBrace.pos);
    }

    this.rejectReturn();
    const stmts: PipelineStmt[] = [this.collectStatement()];
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
      // A `function …(){ … }` declaration is self-terminating — the next
      // statement may follow its `}` with no `;`.
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
    if (stmt.type === "FuncDecl") this.throwFuncDeclOutsidePipeline(stmt.name, stmt.pos);
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
  private rejectReturn(): void {
    const tok = this.lexer.peek();
    if (tok.type === TokenType.Return) {
      throw new FunctionInputError(
        "A `return` here isn't a jsmql statement. A function/arrow body is either a single " +
          "`{ return <expr> }` (the value form, e.g. `({ $ }) => { return $.age }`) or a `;`-separated " +
          "sequence of jsmql statements (no `return`). For a value computed from locals, use " +
          "`jsmql.expr` or fold the bindings into the returned expression.",
        tok.pos,
      );
    }
  }

  /**
   * Parse one top-level statement: either an expression or a update op chain
   * (one or more comma-separated update ops sharing a stage). Stops at the
   * first `;` or EOF; the caller (`parse()`) handles the `;` boundary.
   */
  private collectStatement(): PipelineStmt {
    const first = this.lexer.peek();

    // `function foo(...) { return … }` — a reusable function declaration, the
    // keyword spelling of `const foo = (...) => …`. Forks to the same `FuncDecl`
    // node; `form: "function"` makes it self-terminating (no `;` needed after
    // the closing `}` — see the statement loops).
    if (first.type === TokenType.Ident && first.value === "function") {
      return this.parseFunctionDeclStatement();
    }

    // `let <ident> = <expr>` (or the `const` alias) — pipeline-scoped local
    // binding, OR (when the initialiser is an arrow function) a reusable
    // function declaration. Both are only legal in a pipeline context; codegen
    // / the no-`;` post-checks error if one shows up in expression-mode input.
    if (first.type === TokenType.Let || first.type === TokenType.Const) {
      return this.parseDeclStatement();
    }

    // Tokens that can ONLY start a update op program: `delete`, `++`, `--`.
    // Their presence at the start of a statement unambiguously commits us
    // to update op parsing. Other update op forms (=, +=, x++, …) reveal
    // themselves only after a target expression has been parsed — below.
    if (first.type === TokenType.Delete || first.type === TokenType.PlusPlus || first.type === TokenType.MinusMinus) {
      return this.parseUpdateFilter();
    }

    // Speculative: parse a single expression first.
    const expr = this.parseExpression();

    // If an assignment operator follows, the expression we just parsed was
    // actually a update op target — treat the rest of the statement as a
    // update op chain.
    if (this.peekAssignOp() !== null) {
      this.validateUpdateTarget(expr);
      return this.parseUpdateFilterFrom(expr);
    }

    // Postfix `x++` / `x--`.
    if (this.peekIncDecOp() !== null) {
      this.validateUpdateTarget(expr);
      return this.parseUpdateFilterFromPostfix(expr);
    }

    // `parseExpression` may have surfaced an `AssignExpr` from a parenthesized
    // top-level assignment (`($.a = 5)`). Wrap it in a UpdateFilter so
    // codegen routes through the update op path.
    if ((expr as unknown as { type: string }).type === "AssignExpr") {
      const ops: UpdateOp[] = [expr as unknown as AssignExpr];
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
  private parseLetDecl(): LetDecl {
    const kwTok = this.lexer.next(); // consume `let` / `const`
    const kw = kwTok.value; // echo the keyword the user wrote in error messages
    const ident = this.lexer.peek();
    if (ident.type !== TokenType.Ident) {
      throw new ParseError(
        `Expected an identifier after \`${kw}\` at position ${ident.pos}, got '${ident.value}'`,
        ident.pos,
      );
    }
    this.lexer.next(); // consume the identifier
    const eq = this.lexer.peek();
    if (eq.type !== TokenType.Eq) {
      throw new ParseError(
        `Expected '=' after \`${kw} ${ident.value}\` at position ${eq.pos}, got '${eq.value}'. ` +
          `\`${kw}\` requires an initialiser — write \`${kw} ${ident.value} = <expr>\`.`,
        eq.pos,
      );
    }
    this.lexer.next(); // consume `=`
    // An unparenthesized single-param arrow RHS (`const f = x => …`) isn't
    // recognised by `parseExpression` (only the parenthesized `(x) => …` form
    // is, via parsePrimary's `isLambdaStart`). Detect it here so idiomatic
    // single-param function declarations parse — parseDeclStatement then forks
    // the Lambda value into a FuncDecl.
    const value =
      this.lexer.peek().type === TokenType.Ident && this.lexer.lookahead(1).type === TokenType.Arrow
        ? this.parseLambdaUnparen()
        : this.parseExpression();
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
  private parseDeclStatement(): LetDecl | FuncDecl {
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
  private throwFuncDeclOutsidePipeline(name: string, pos: number): never {
    throw new ParseError(
      `A reusable function declaration (\`function ${name}(…) { … }\` / \`const ${name} = (…) => …\`) ` +
        `is only valid inside a pipeline. Add at least one more statement that calls \`${name}\` ` +
        `(e.g. \`function ${name}(…) { … } $ = { … }\`, or \`const ${name} = …; $ = { … }\`), ` +
        `or use the bracketed form \`[ const ${name} = …, … ]\`.`,
      pos,
    );
  }

  // ── UpdateOp program ─────────────────────────────────────────────────────

  /** Entry when the input starts with a update op token (`delete`). */
  private parseUpdateFilter(): UpdateFilter {
    const ops: UpdateOp[] = [];
    ops.push(...this.parseUpdateOp());
    this.parseUpdateFilterRest(ops);
    return { type: "UpdateFilter", ops, pos: ops[0].pos };
  }

  /** Entry when the first target was already parsed as an expression. */
  private parseUpdateFilterFrom(firstTarget: Expr): UpdateFilter {
    const ops: UpdateOp[] = [];
    ops.push(...this.parseAssignmentChainFrom(firstTarget));
    this.parseUpdateFilterRest(ops);
    return { type: "UpdateFilter", ops, pos: ops[0].pos };
  }

  /**
   * Entry when the first target was parsed and is followed by `++` or `--`
   * (postfix inc/dec). Validation must already have happened.
   */
  private parseUpdateFilterFromPostfix(firstTarget: Expr): UpdateFilter {
    const op = this.peekIncDecOp();
    if (op === null) {
      const tok = this.lexer.peek();
      throw new ParseError(`Expected '++' or '--' at position ${tok.pos}`, tok.pos);
    }
    this.lexer.next(); // consume the operator
    const ops: UpdateOp[] = [this.makeIncDecUpdateOp(firstTarget, op)];
    this.parseUpdateFilterRest(ops);
    return { type: "UpdateFilter", ops, pos: ops[0].pos };
  }

  /**
   * After the first update op is parsed, consume any `,`-separated tail.
   * Stops at the first non-`,` token (typically `;` or EOF) and leaves
   * the cursor there for the caller to handle.
   */
  private parseUpdateFilterRest(ops: UpdateOp[]): void {
    while (this.peekUpdateOpSeparator()) {
      this.lexer.next(); // consume `,`
      const next = this.lexer.peek().type;
      // A trailing separator before any terminator (EOF, `;`, or a closing
      // `}` / `]` / `)` of an enclosing block / bracketed pipeline / paren)
      // ends the chain.
      if (
        next === TokenType.EOF ||
        next === TokenType.Semi ||
        next === TokenType.RBrace ||
        next === TokenType.RBracket ||
        next === TokenType.RParen
      ) {
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
  private parseUpdateOp(): UpdateOp[] {
    if (this.lexer.peek().type === TokenType.Delete) {
      return [this.parseDeleteStmt()];
    }
    // Prefix increment/decrement: `++$.x` / `--$.x`.
    if (this.peekIncDecOp() !== null) {
      return [this.parsePrefixIncDec()];
    }
    const target = this.parsePostfix();
    // `parsePostfix` may have already returned a fully-formed update op when the
    // input was wrapped in parens — `($.a = 1)` / `($.a++)`. Prettier and oxfmt
    // emit this shape when a top-level assignment chains with `,`. Surface it
    // as-is so a chain like `($.a = 1), ($.b = 2)` round-trips.
    if ((target as unknown as { type: string }).type === "AssignExpr") {
      return [target as unknown as AssignExpr];
    }
    this.validateUpdateTarget(target);
    // Postfix increment/decrement: `$.x++` / `$.x--`.
    const postfix = this.peekIncDecOp();
    if (postfix !== null) {
      this.lexer.next();
      return [this.makeIncDecUpdateOp(target, postfix)];
    }
    return this.parseAssignmentChainFrom(target);
  }

  private parseDeleteStmt(): DeleteStmt {
    const delTok = this.lexer.next(); // consume `delete`
    const target = this.parsePostfix();
    this.validateUpdateTarget(target);
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
        this.validateUpdateTarget(subTarget);
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
    const desugared: Expr = { type: "BinaryExpr", op: compoundBinaryOp(op), left: target, right: rhs, pos: target.pos };
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

  private peekUpdateOpSeparator(): boolean {
    return this.lexer.peek().type === TokenType.Comma;
  }

  /**
   * Returns "++" or "--" if the next token is an inc/dec operator, else null.
   * Used at both prefix (start of update op) and postfix (after a target)
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
    this.validateUpdateTarget(target);
    return this.makeIncDecUpdateOp(target, op);
  }

  /** Build the desugared AssignExpr for `target++` / `target--` / `++target` / `--target`. */
  private makeIncDecUpdateOp(target: Expr, op: "++" | "--"): AssignExpr {
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
   * UpdateOp targets are restricted to field paths: a `FieldRef` (`$.x`) or
   * a chain of `MemberAccess` nodes rooted at one (`$.x.y.z`). Anything else
   * — index access, function calls, parameter refs, parenthesized expressions
   * containing operators — is rejected with a precise error.
   */
  private validateUpdateTarget(target: Expr): void {
    if (this.isFieldPathTarget(target)) return;
    // `$out` sugar: `$$$.<coll> = …`, `$$$$.<db>.<coll> = …`, and their bracket
    // variants. Shape-only check here — segment-count, computed-bracket, and
    // any other malformations are diagnosed at codegen time in
    // `detectOutAssign` (src/out-translation.ts) so the error message can
    // suggest the right corrective form.
    if (this.isOutTarget(target)) return;
    // A bare identifier may be a reassignment of a `let` binding (`let x = …; x
    // = …`). Whether `x` is actually an in-scope `let` (assignable) vs a `const`
    // (not) vs undeclared (not) needs the pipeline-scope view the parser doesn't
    // have — so accept the shape here and let codegen validate it against the
    // live let scope (see `tryLowerAssignSugar` in pipeline.ts). In non-pipeline
    // contexts there are no lets, so codegen rejects it with an actionable
    // message. See docs/specs/let-bindings.md § Reassignment.
    if (target.type === "ParamRef") return;
    const pos = this.lexer.peek().pos;
    if (target.type === "IndexAccess") {
      throw new ParseError(
        `UpdateOp target must be a static field path; computed/index access ('[…]') is not supported (at position ${pos})`,
        pos,
      );
    }
    throw new ParseError(
      `Cannot assign to ${describeUpdateTarget(target)} at position ${pos} — only field paths like '$.x' or '$.x.y' are assignable.`,
      pos,
    );
  }

  private isFieldPathTarget(target: Expr): boolean {
    if (target.type === "FieldRef") return true;
    // Bare `$$` is a valid assignment target for the stream-level
    // root-replacement form (`$$ = <expr>`). The parser accepts the shape
    // here; pipeline lowering enforces the supported RHS forms.
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
  private isOutTarget(target: Expr): boolean {
    if (target.type === "DatabaseRef" || target.type === "ClusterRef") return true;
    if (target.type === "MemberAccess") return this.isOutTarget(target.object);
    if (target.type === "IndexAccess") return this.isOutTarget(target.object);
    return false;
  }

  // ── Precedence hierarchy (low → high) ────────────────────────────────────

  private parseExpression(): Expr {
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
  private parseTernary(): Expr {
    const condition = this.parseNullish();
    if (this.lexer.peek().type !== TokenType.Quest) return condition;
    this.lexer.next(); // consume ?
    const consequent = this.parseExpression(); // full expr for consequent
    const colon = this.lexer.peek();
    if (colon.type !== TokenType.Colon) {
      throw new ParseError(`Expected ':' in ternary expression at position ${colon.pos}`, colon.pos);
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
    while (this.lexer.peek().type === TokenType.Plus || this.lexer.peek().type === TokenType.Minus) {
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
          throw new ParseError(`Expected ']' after index expression at position ${close.pos}`, close.pos);
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
            throw new ParseError(`Expected ']' after index expression at position ${close.pos}`, close.pos);
          }
          this.lexer.next();
          left = { type: "IndexAccess", object: left, index, pos: left.pos, optional: true };
          continue;
        }
        const member = this.lexer.peek();
        // `.$stage(<body>)` — a chained pipeline-stage call. The lexer emits
        // `$match` as Dollar + Ident, so a stage link is a TWO-token member
        // name; everything downstream sees an ordinary `MethodCall` whose
        // method starts with `$`. Only the CALL form is a stage link — a bare
        // `.$name` has no meaning (jsmql source has no `$`-prefixed fields).
        // See docs/specs/aggregation-stages.md § chained stage calls.
        const isStageLink = member.type === TokenType.Dollar && this.isIdentOrKeyword(this.lexer.lookahead(1));
        let memberName: string;
        if (isStageLink) {
          const stageIdent = this.lexer.lookahead(1);
          if (isOptional) {
            throw new ParseError(
              `Optional chaining ('?.') is not meaningful on the pipeline stage '$${stageIdent.value}' — a stage always runs. ` +
                `Write '.$${stageIdent.value}(...)' at position ${member.pos}.`,
              member.pos,
            );
          }
          this.lexer.next(); // consume $
          this.lexer.next(); // consume stage name
          memberName = `$${stageIdent.value}`;
        } else {
          if (!this.isIdentOrKeyword(member)) {
            throw new ParseError(`Expected property name after '.' at position ${member.pos}`, member.pos);
          }
          this.lexer.next(); // consume member name
          memberName = member.value;
        }
        if (this.lexer.peek().type === TokenType.LParen) {
          // Method call: left.member(args). A `=> { … }` callback body is parsed
          // with the *sub-pipeline* block grammar (`;`-separated stages + an
          // optional terminal `return <expr>` — parseCallbackBlock) when the
          // method is in `STREAM_BLOCK_METHODS` and the receiver is STREAM-rooted:
          // `$$$.<coll>` / `$$$$.<db>.<coll>` (→ `$lookup` sub-pipeline), `$$` (→
          // `$facet` / stream chain), or a chain off any of those
          // (`$$$.<coll>.filter(p).aggregate(d => { … })`). Only `.aggregate` keeps
          // the stages; the JavaScript methods share the grammar so the rejection
          // in `src/callback-block.ts` can name the stage the developer wrote.
          // See docs/specs/lookup-stage.md, replace-root-stage.md,
          // stream-methods.md.
          //   Everywhere else — notably in-document array methods rooted at a
          //   field (`$.items.map(d => { … })`) — a `=> { … }` body is an
          //   *expression* block (`{ const a = …; return <expr>; }`) lowered to
          //   nested `$let`; see docs/specs/method-dispatch.md. JS-faithful:
          //   `=> {` always opens a block; an object return needs `=> ({ … })`.
          const streamRooted = isStreamRooted(left);
          const args = this.parseMethodCallArgs({
            kind: STREAM_BLOCK_METHODS.has(memberName) && streamRooted ? "pipeline" : "expr",
            method: memberName,
            streamRooted,
          });
          left = {
            type: "MethodCall",
            object: left,
            method: memberName,
            args,
            // Every link carries its OWN offset, so a chain error carets at the
            // offending call rather than at the chain root — in
            // `$$.filter(p).uniq().take(2)` the `.uniq()` error points at
            // `.uniq`, not at `$$` 24 characters earlier.
            pos: member.pos,
            ...(isOptional && { optional: true }),
          };
        } else if (isStageLink) {
          throw new ParseError(
            `'${memberName}' is a pipeline stage — call it with its body: '${memberName}(<body>)' at position ${member.pos}.`,
            member.pos,
          );
        } else {
          // Property access: left.member
          left = {
            type: "MemberAccess",
            object: left,
            member: memberName,
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

  /**
   * Parse a (possibly empty) comma-separated list terminated by `close`,
   * allowing an optional trailing comma (`f(a, b,)` — valid JS). The opening
   * delimiter must already be consumed; `close` is left unconsumed for the
   * caller to `expect`. Each item is produced by `parseItem`. Used by every
   * argument / parameter list whose items are uniform; the operator-call and
   * `Array.from` paths parse their first argument specially and reach for
   * `parseCommaTail` / `consumeTrailingComma` instead.
   */
  private parseDelimitedList<T>(close: TokenType, parseItem: () => T): T[] {
    if (this.lexer.peek().type === close) return [];
    const items: T[] = [parseItem()];
    this.parseCommaTail(items, close, parseItem);
    return items;
  }

  /**
   * Consume a `,`-separated tail, appending each item to `items`. A trailing
   * comma (one immediately followed by `close`) ends the list without parsing
   * another item, matching JS. Stops at the first non-`,` token, leaving it for
   * the caller.
   */
  private parseCommaTail<T>(items: T[], close: TokenType, parseItem: () => T): void {
    while (this.lexer.peek().type === TokenType.Comma) {
      this.lexer.next(); // consume `,`
      if (this.lexer.peek().type === close) break; // trailing comma
      items.push(parseItem());
    }
  }

  /**
   * Consume a lone trailing comma — a `,` immediately followed by `close` — so
   * fixed-arity built-in calls (`Number(x,)`, `Array.isArray(x,)`) accept the
   * JS trailing comma. No-op when the `,` is followed by anything else, so a
   * genuine extra argument still surfaces the call's own arity error.
   */
  private consumeTrailingComma(close: TokenType): void {
    if (this.lexer.peek().type === TokenType.Comma && this.lexer.lookahead(1).type === close) {
      this.lexer.next();
    }
  }

  /** Parse method call argument list: "(" [argOrLambda ("," argOrLambda)* ","?] ")" */
  private parseMethodCallArgs(blockCtx: BlockArgCtx = EXPR_BLOCK_ARG): CallArg[] {
    this.lexer.expect(TokenType.LParen);
    const args = this.parseDelimitedList(TokenType.RParen, () => this.parseCallArg(blockCtx));
    this.lexer.expect(TokenType.RParen);
    return args;
  }

  /**
   * Parse one argument in a call site. Allows:
   *   - ...expr (spread)
   *   - lambda forms (x => ..., (x) => ..., (x, y) => ...)
   *   - any expression
   */
  private parseCallArg(blockCtx: BlockArgCtx = EXPR_BLOCK_ARG): CallArg {
    if (this.lexer.peek().type === TokenType.Spread) {
      const spreadTok = this.lexer.next();
      const argument = this.parseExpression();
      const spread: SpreadElement = { type: "SpreadElement", argument, pos: spreadTok.pos };
      return spread;
    }
    return this.parseArgOrLambda(blockCtx);
  }

  /**
   * Parse an argument that might be a lambda expression.
   * Checks for lambda patterns before falling back to parseExpression().
   * `blockCtx.kind` selects what a `=> { … }` body means: `"pipeline"` (a callback on
   * a stream root — see `STREAM_BLOCK_METHODS`) parses a statement block → `Pipeline`;
   * `"expr"` (the default everywhere else) parses an expression-block → `ExprBlock`.
   * JS-faithful: `=> {` always opens a block; an object return needs `=> ({ … })`.
   * The rest of `blockCtx` carries the receiver so an `"expr"`-kind block that turns
   * out to hold stages can name the real mistake (`subPipelineBlockError`).
   */
  private parseArgOrLambda(blockCtx: BlockArgCtx = EXPR_BLOCK_ARG): Expr {
    // x => expr  (unparenthesized single param)
    if (this.lexer.peek().type === TokenType.Ident && this.lexer.lookahead(1).type === TokenType.Arrow) {
      return this.parseLambdaUnparen(blockCtx);
    }
    // (x) => expr  or  (x, y) => expr  or  () => expr
    if (this.isLambdaStart()) {
      return this.parseLambdaParen(blockCtx);
    }
    return this.parseExpression();
  }

  /** primary:  operator_call | field_ref | literals | "(" expr ")" | array | object  */
  private parsePrimary(): Expr {
    const t = this.lexer.peek();

    switch (t.type) {
      case TokenType.Dollar:
        // `$` followed by an identifier is an operator call (`$add(...)`).
        // `$` standalone is the current document — same role MQL's `$$ROOT`
        // plays. Used as a value (`{ ...$, x: 1 }`, `$mergeObjects($, ...)`)
        // and as the LHS of `$ = <expr>` to replace the root document.
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
        // `function (…) { return … }` / `function foo(…) { … }` in value
        // position — an inline function expression or IIFE callee. Normalised to
        // the same `Lambda` node arrows produce (the name, if any, is unreachable
        // in MQL and discarded). Must come first: `function` lexes as an ordinary
        // identifier (it is deliberately not a keyword, so `{ function: … }` and
        // `$.function` keep working), so we intercept it here by value.
        if (name === "function") return this.parseFunctionExpr(/* requireName */ false).lambda;
        if (
          name === "async" &&
          this.lexer.lookahead(1).type === TokenType.Ident &&
          this.lexer.lookahead(1).value === "function"
        ) {
          throw new ParseError(
            `jsmql does not support async functions. Use a synchronous \`function (…) { return … }\` or an arrow.`,
            t.pos,
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
        if (name === "ObjectId") {
          this.lexer.next(); // consume 'ObjectId'
          if (this.lexer.peek().type === TokenType.LParen) return this.finishObjectIdConstruction(t.pos);
          // Bare `ObjectId` — a callback reference, like a bare `Number`.
          return { type: "ObjectIdRef", pos: t.pos };
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
    if (this.lexer.peek().type === TokenType.Ident && this.lexer.lookahead(1).type === TokenType.Arrow) {
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
      // form `jsmql(({ $ }) => [($.a = 1)])` works the same as the bare form.
      // The result is an AssignExpr; we surface it as an `Expr` and let
      // contextual handling in parseArrayLiteral / parse() / _generate
      // route it appropriately. Plain expression contexts (e.g. `1 + (a=2)`)
      // bubble it up to codegen which throws a precise error.
      if (this.peekAssignOp() !== null) {
        this.validateUpdateTarget(expr);
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
        this.validateUpdateTarget(expr);
        expr = this.makeIncDecUpdateOp(expr, op) as unknown as Expr;
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
      throw new ParseError(`Expected operator name after '$' at position ${dollar.pos}`, dollar.pos);
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

    // Object-style: a single `{...}` argument. A lone trailing comma keeps it
    // object-style (`$op({…})` ≡ `$op({…},)`); a real second arg makes it
    // positional.
    if (peek.type === TokenType.LBrace) {
      const obj = this.parseObjectLiteral();
      const after = this.lexer.peek();
      if (after.type === TokenType.RParen) {
        this.lexer.next();
        return { type: "OperatorCall", name, style: "object", args: [obj], pos: dollar.pos };
      }
      if (after.type === TokenType.Comma && this.lexer.lookahead(1).type === TokenType.RParen) {
        this.lexer.next(); // consume `,`
        this.lexer.next(); // consume `)`
        return { type: "OperatorCall", name, style: "object", args: [obj], pos: dollar.pos };
      }
      // First positional arg happens to be an object — collect remaining args
      const args: CallArg[] = [obj];
      this.parseCommaTail(args, TokenType.RParen, () => this.parseCallArg());
      this.lexer.expect(TokenType.RParen);
      return { type: "OperatorCall", name, style: "positional", args, pos: dollar.pos };
    }

    // Positional args (may include lambdas and spreads)
    const args: CallArg[] = [this.parseCallArg()];
    this.parseCommaTail(args, TokenType.RParen, () => this.parseCallArg());
    this.lexer.expect(TokenType.RParen);
    return { type: "OperatorCall", name, style: "positional", args, pos: dollar.pos };
  }

  /** $.field — stops at first segment; postfix handles further dots */
  private parseFieldRef(): Expr {
    const dollarDot = this.lexer.next(); // consume $.
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
  private parseContextRef(nodeType: "CollectionRef" | "DatabaseRef" | "ClusterRef", displayPrefix: string): Expr {
    const prefix = this.lexer.next();
    const next = this.lexer.peek();
    if (next.type !== TokenType.Dot && next.type !== TokenType.LBracket) {
      if (nodeType === "CollectionRef" && !this.isIdentOrKeyword(next)) {
        return { type: nodeType, pos: prefix.pos };
      }
      throw new ParseError(
        `Expected '.<name>' or '[<expr>]' after '${displayPrefix}' at position ${prefix.pos}`,
        prefix.pos,
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
  private isIdentOrKeyword(t: Token): boolean {
    return (
      t.type === TokenType.Ident ||
      t.type === TokenType.In ||
      t.type === TokenType.New ||
      t.type === TokenType.Typeof ||
      t.type === TokenType.Let ||
      t.type === TokenType.Const ||
      t.type === TokenType.Return
    );
  }

  /**
   * Non-consuming lookahead: is the current position the start of a parenthesized lambda?
   * Matches: "(" ")" "=>" | "(" Ident ")" "=>" | "(" Ident ("," Ident)* ","? ")" "=>"
   */
  private isLambdaStart(): boolean {
    if (this.lexer.peek().type !== TokenType.LParen) return false;
    let offset = 1;
    // Check for () => (zero params)
    if (this.lexer.lookahead(offset).type === TokenType.RParen) {
      return this.lexer.lookahead(offset + 1).type === TokenType.Arrow;
    }
    // Collect Ident ("," Ident)* with an optional trailing comma
    while (this.lexer.lookahead(offset).type === TokenType.Ident) {
      offset++;
      if (this.lexer.lookahead(offset).type === TokenType.RParen) {
        return this.lexer.lookahead(offset + 1).type === TokenType.Arrow;
      }
      if (this.lexer.lookahead(offset).type !== TokenType.Comma) return false;
      offset++; // consume comma
      // Trailing comma: `(a,) => …` / `(a, b,) => …`
      if (this.lexer.lookahead(offset).type === TokenType.RParen) {
        return this.lexer.lookahead(offset + 1).type === TokenType.Arrow;
      }
    }
    return false;
  }

  /** Parse "x => expr" — single unparenthesized parameter */
  private parseLambdaUnparen(blockCtx: BlockArgCtx = EXPR_BLOCK_ARG): Expr {
    const paramTok = this.lexer.next(); // consume Ident
    this.lexer.next(); // consume =>
    if (this.lexer.peek().type === TokenType.LBrace) {
      if (blockCtx.kind === "pipeline") {
        const { block, ret } = this.parseCallbackBlock();
        return { type: "Lambda", params: [paramTok.value], block, ret, pos: paramTok.pos };
      }
      const exprBlock = this.parseExprBlockBody(blockCtx);
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
  private parseParenParamNames(): string[] {
    this.lexer.expect(TokenType.LParen);
    const params = this.parseDelimitedList(TokenType.RParen, () => this.lexer.expect(TokenType.Ident).value);
    this.lexer.expect(TokenType.RParen);
    return params;
  }

  /** Parse "(x) => expr" or "(x, y) => expr" or "() => expr" */
  private parseLambdaParen(blockCtx: BlockArgCtx = EXPR_BLOCK_ARG): Expr {
    const lparen = this.lexer.peek(); // `(` — captured for `pos`
    const params = this.parseParenParamNames();
    this.lexer.expect(TokenType.Arrow);
    if (this.lexer.peek().type === TokenType.LBrace) {
      if (blockCtx.kind === "pipeline") {
        const { block, ret } = this.parseCallbackBlock();
        return { type: "Lambda", params, block, ret, pos: lparen.pos };
      }
      const exprBlock = this.parseExprBlockBody(blockCtx);
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
  private parseFunctionExpr(requireName: boolean): { name: string | undefined; lambda: Lambda } {
    const fnTok = this.lexer.next(); // consume the `function` identifier
    if (this.lexer.peek().type === TokenType.Star) {
      throw new ParseError(
        `jsmql does not support generator functions (\`function*\`). Use a plain \`function (…) { return … }\` or an arrow.`,
        this.lexer.peek().pos,
      );
    }
    // Optional (value position) / required (declaration) name.
    let name: string | undefined;
    if (this.lexer.peek().type === TokenType.Ident) {
      name = this.lexer.next().value;
    } else if (requireName) {
      const tok = this.lexer.peek();
      throw new ParseError(
        `Expected a function name after \`function\` at position ${tok.pos}, got ${formatActualToken(tok)}. ` +
          `A \`function\` declaration needs a name — write \`function foo(a) { return … }\`.`,
        tok.pos,
      );
    }
    if (this.lexer.peek().type !== TokenType.LParen) {
      const tok = this.lexer.peek();
      throw new ParseError(
        `Expected '(' to start the parameter list of \`function${name ? ` ${name}` : ""}\` at position ${tok.pos}, ` +
          `got ${formatActualToken(tok)}.`,
        tok.pos,
      );
    }
    const params = this.parseParenParamNames();
    if (this.lexer.peek().type !== TokenType.LBrace) {
      const tok = this.lexer.peek();
      throw new ParseError(
        `Expected '{' to start the body of \`function${name ? ` ${name}` : ""}(…)\` at position ${tok.pos}, ` +
          `got ${formatActualToken(tok)}. A \`function\` body is a block ending in \`return <expr>\`.`,
        tok.pos,
      );
    }
    const exprBlock = this.parseExprBlockBody();
    // A block whose only statement is `return E` IS the expression `E` — emit a
    // plain expression-body Lambda so `function (x) { return E }` is byte-for-byte
    // `(x) => E` everywhere (value position AND the query-translation predicate
    // positions — `$$$.coll.find/filter`, `$$.filter`, stream `.filter` — which
    // translate a `body` expression but don't special-case `exprBlock`). Bodies
    // with leading `const`/`let` keep the `exprBlock` (→ nested `$let`).
    const lambda: Lambda =
      exprBlock.decls.length === 0
        ? { type: "Lambda", params, body: exprBlock.ret, pos: fnTok.pos }
        : { type: "Lambda", params, exprBlock, pos: fnTok.pos };
    return { name, lambda };
  }

  /**
   * Parse a `function <name>(params) { … }` DECLARATION at a pipeline-statement
   * or array-element position, forking into a reusable `FuncDecl` (the same node
   * `const <name> = (params) => …` produces). `form: "function"` marks it
   * self-terminating (see `FuncDecl` in ast.ts). Mirrors `parseDeclStatement`.
   */
  private parseFunctionDeclStatement(): FuncDecl {
    const { name, lambda } = this.parseFunctionExpr(/* requireName */ true);
    return { type: "FuncDecl", name: name!, lambda, kind: "const", form: "function", pos: lambda.pos };
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
  private parseCallbackBlock(): { block: Pipeline; ret?: Expr } {
    const openBrace = this.lexer.next(); // consume `{`
    const stmts: PipelineStmt[] = [];
    let ret: Expr | undefined;
    while (this.lexer.peek().type !== TokenType.RBrace) {
      if (this.lexer.peek().type === TokenType.Return) {
        this.lexer.next(); // consume `return`
        ret = this.parseExpression();
        if (this.lexer.peek().type === TokenType.Semi) this.lexer.next(); // optional trailing `;`
        break; // a `return` is terminal
      }
      const stmt = this.collectStatement();
      stmts.push(stmt);
      if (this.lexer.peek().type === TokenType.Semi) {
        this.lexer.next();
        continue;
      }
      // A `function …(){ … }` declaration is self-terminating (no `;` needed).
      if (this.selfTerminates(stmt) && this.lexer.peek().type !== TokenType.RBrace) continue;
      break;
    }
    if (stmts.length === 0 && ret === undefined) {
      throw new ParseError(
        `Expected at least one statement (or a \`return <expr>\`) inside the callback's block body at position ${openBrace.pos}`,
        openBrace.pos,
      );
    }
    const closeTok = this.lexer.peek();
    if (closeTok.type !== TokenType.RBrace) {
      throw new ParseError(`Expected '}' to close the callback's block body at position ${closeTok.pos}`, closeTok.pos);
    }
    this.lexer.next(); // consume `}`
    return { block: { type: "Pipeline", stmts, pos: openBrace.pos }, ret };
  }

  /**
   * Build the error for a `=> { $stage(...); … }` sub-pipeline block written at a
   * call site that only takes an expression block. Two distinct mistakes reach
   * here, and each gets its own fix:
   *
   *   - **The method name isn't one the grammar knows.** The receiver IS a stream, so
   *     a block holding stages was plausible — `.aggregat(o => { $group(…); })` used
   *     to demand a `return`, sending the user after a phantom syntax error instead of
   *     a typo. `didYouMean` over `STREAM_BLOCK_METHODS` names the method they meant.
   *   - **The receiver isn't a stream.** `$.items.map(d => { $group(…); })` — an
   *     in-document array has no pipeline to run stages in, whatever the method.
   *
   * A recognised method with a stage in its block never reaches here: the parser hands
   * it the pipeline grammar, and `src/callback-block.ts` owns that rejection with a
   * container-accurate rewrite. So this message states the same rule that module does —
   * stages belong to `.aggregate(pipeline)` alone — rather than implying the suggested
   * method would accept the block as written.
   */
  private subPipelineBlockError(blockCtx: BlockArgCtx, pos: number): ParseError {
    const { method, streamRooted } = blockCtx;
    const call = method === undefined ? "this callback" : `'.${method}(...)'`;
    const lead =
      `Unexpected stage call at position ${pos}: a \`=> { $stage(...); ... }\` block is a sub-pipeline, ` +
      `but ${call} doesn't take one.`;
    const jsCallbackRule =
      "Pipeline stages belong to `.aggregate(pipeline)` alone; every other callback's block body is " +
      "JavaScript — `const`/`let` bindings and one `return <expr>`.";
    if (streamRooted === true && method !== undefined) {
      return new ParseError(
        `${lead}${didYouMean(method, [...STREAM_BLOCK_METHODS], (s) => `.${s}`)} ${jsCallbackRule}`,
        pos,
      );
    }
    return new ParseError(
      `${lead} Stage calls need a stream receiver — '$$' or '$$$.<coll>' — not an in-document value. ${jsCallbackRule}`,
      pos,
    );
  }

  /**
   * Parse the expression-block body of an arrow:
   * `{ (const|let <name> = <expr>;)* return <expr>; }`. Codegen lowers it to a
   * right-folded nest of `$let`. This is the JS-faithful meaning of `=> { … }`
   * everywhere outside the lookup-callback positions (which use
   * `parseCallbackBlock`); an object return must be written `=> ({ … })`.
   * See docs/specs/method-dispatch.md.
   */
  private parseExprBlockBody(blockCtx: BlockArgCtx = EXPR_BLOCK_ARG): ExprBlock {
    const open = this.lexer.next(); // consume `{`
    const decls: LetDecl[] = [];
    while (this.lexer.peek().type === TokenType.Let || this.lexer.peek().type === TokenType.Const) {
      const decl = this.parseLetDecl();
      if (decl.value.type === "Lambda") {
        // A nested arrow-valued binding inside an arrow body is a nested
        // function. Reusable functions are top-level-only — redirect here
        // rather than letting it fall through to the generic "Lambda
        // expression cannot be used here" codegen error.
        throw new ParseError(
          `Reusable functions must be declared at the top level of a pipeline, not inside an arrow body. ` +
            `Move \`${decl.kind} ${decl.name} = (…) => …\` out of the \`=> { … }\` block.`,
          decl.pos,
        );
      }
      decls.push(decl);
      const semi = this.lexer.peek();
      if (semi.type !== TokenType.Semi) {
        throw new ParseError(
          `Expected ';' after the \`${decl.kind} ${decl.name}\` declaration at position ${semi.pos}, got ${formatActualToken(semi)}. ` +
            `Each declaration in a block-body arrow ends with ';', and the block ends with a single \`return\`.`,
          semi.pos,
        );
      }
      this.lexer.next(); // consume `;`
    }
    const ret = this.lexer.peek();
    if (ret.type !== TokenType.Return) {
      // A `$`-prefixed name here means the block holds stage calls, so the user
      // meant a sub-pipeline — not an expression block that forgot its `return`.
      // Say which of the two things is actually wrong instead of demanding a
      // `return` they never wanted.
      if (ret.type === TokenType.Dollar) throw this.subPipelineBlockError(blockCtx, ret.pos);
      throw new ParseError(
        `A block body must end with a \`return <expr>\` statement at position ${ret.pos}, got ${formatActualToken(ret)}. ` +
          `Write \`x => { const a = …; return <expr>; }\` / \`function f(x) { return <expr>; }\`, ` +
          `or \`x => (<expr>)\` to return an object/expression directly.`,
        ret.pos,
      );
    }
    this.lexer.next(); // consume `return`
    const retExpr = this.parseExpression();
    if (this.lexer.peek().type === TokenType.Semi) this.lexer.next(); // optional trailing `;`
    const close = this.lexer.peek();
    if (close.type !== TokenType.RBrace) {
      throw new ParseError(
        `Expected '}' to close the block-body arrow at position ${close.pos}, got ${formatActualToken(close)}. ` +
          `Only \`const\`/\`let\` declarations may precede the single \`return\`.`,
        close.pos,
      );
    }
    this.lexer.next(); // consume `}`
    return { type: "ExprBlock", decls, ret: retExpr, pos: open.pos };
  }

  /** "new Date()" / "new Date(expr)" or "new Set()" / "new Set(expr)" */
  private parseNewDate(): Expr {
    const newTok = this.lexer.next(); // consume 'new'
    const className = this.lexer.peek();
    if (className.type !== TokenType.Ident) {
      throw new ParseError(`Expected class name after 'new' at position ${newTok.pos}`, newTok.pos);
    }
    if (className.value === "ObjectId") {
      this.lexer.next(); // consume 'ObjectId'
      return this.finishObjectIdConstruction(newTok.pos);
    }
    if (className.value !== "Date" && className.value !== "Set") {
      throw new ParseError(
        `Unsupported 'new ${className.value}' at position ${className.pos}. Supported: new Date(), new Set(), new ObjectId()`,
        className.pos,
      );
    }
    const cls = className.value;
    this.lexer.next(); // consume class name
    this.lexer.expect(TokenType.LParen);
    if (this.lexer.peek().type === TokenType.RParen) {
      this.lexer.next();
      return cls === "Date"
        ? { type: "NewDate", args: [], pos: newTok.pos }
        : { type: "NewSet", arg: null, pos: newTok.pos };
    }
    const args: Expr[] = [this.parseExpression()];
    this.parseCommaTail(args, TokenType.RParen, () => this.parseExpression());
    this.lexer.expect(TokenType.RParen);
    if (cls === "Set") {
      if (args.length > 1) {
        throw new ParseError(
          `'new Set(...)' takes 0 or 1 arguments, got ${args.length} at position ${newTok.pos}`,
          newTok.pos,
        );
      }
      return { type: "NewSet", arg: args[0], pos: newTok.pos };
    }
    if (args.length > 7) {
      throw new ParseError(
        `'new Date(year, month, day, hour, minute, second, ms)' takes at most 7 arguments, got ${args.length} at position ${newTok.pos}`,
        newTok.pos,
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
  private finishObjectIdConstruction(pos: number): Expr {
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
        const detail =
          hex.length === 24
            ? `it contains non-hexadecimal characters`
            : `got ${hex.length} character${hex.length === 1 ? "" : "s"}`;
        throw new ParseError(
          `ObjectId("${hex}") is not a valid ObjectId: expected exactly 24 hexadecimal characters, ${detail}, at position ${arg.pos}.`,
          arg.pos,
        );
      }
      assertPlausibleObjectId(hex, arg.pos);
      return { type: "ObjectIdLiteral", hex, pos };
    }
    // Dynamic argument (field ref / param / expression): defer to the server's
    // own string→ObjectId conversion operator.
    return { type: "OperatorCall", name: "$toObjectId", style: "positional", args: [arg], pos };
  }

  /** "Date.now()" or "Date.UTC(year, month, day, …)" — other Date.* members are not supported */
  private parseDateStatic(): Expr {
    const dateTok = this.lexer.next(); // consume 'Date'
    this.lexer.expect(TokenType.Dot);
    const methodTok = this.lexer.peek();
    if (methodTok.type !== TokenType.Ident) {
      throw new ParseError(`Expected Date method name at position ${methodTok.pos}`, methodTok.pos);
    }
    if (methodTok.value === "now") {
      this.lexer.next(); // consume 'now'
      this.lexer.expect(TokenType.LParen);
      this.lexer.expect(TokenType.RParen);
      return { type: "DateNow", pos: dateTok.pos };
    }
    if (methodTok.value === "UTC") {
      this.lexer.next(); // consume 'UTC'
      this.lexer.expect(TokenType.LParen);
      const args = this.parseDelimitedList(TokenType.RParen, () => this.parseExpression());
      this.lexer.expect(TokenType.RParen);
      if (args.length < 1 || args.length > 7) {
        throw new ParseError(
          `Date.UTC(year[, month, day, hour, minute, second, ms]) takes 1 to 7 arguments, got ${args.length} at position ${dateTok.pos}`,
          dateTok.pos,
        );
      }
      return { type: "DateUTC", args, pos: dateTok.pos };
    }
    throw new ParseError(
      `Unknown Date method '${methodTok.value}' at position ${methodTok.pos}. ` +
        `Only Date.now() and Date.UTC(…) are supported as JS-style calls; for other date operations ` +
        `use the $date* operators directly (e.g. $dateAdd, $dateDiff, $dateTrunc, $dateToString).`,
      dateTok.pos,
    );
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
      this.consumeTrailingComma(TokenType.RParen);
      this.lexer.expect(TokenType.RParen);
      return { type: "OperatorCall", name: "$isArray", style: "positional", args: [arg], pos: arrayTok.pos };
    }
    if (methodTok.value === "from") {
      this.lexer.next();
      this.lexer.expect(TokenType.LParen);
      const input = this.parseExpression();
      let mapFn: Expr | null = null;
      if (this.lexer.peek().type === TokenType.Comma) {
        this.lexer.next(); // consume `,`
        // A lone trailing comma (`Array.from(x,)`) leaves mapFn unset; otherwise
        // the second arg is the map callback.
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
      arrayTok.pos,
    );
  }

  /** "Number.isInteger(x)" / "Number.isNaN(x)" / "Number.isFinite(x)" */
  private parseNumberStaticCall(): Expr {
    const numberTok = this.lexer.next(); // consume 'Number'
    this.lexer.expect(TokenType.Dot);
    const methodTok = this.lexer.peek();
    if (methodTok.type !== TokenType.Ident || !(NUMBER_STATICS as readonly string[]).includes(methodTok.value)) {
      const numberHint = didYouMean(methodTok.value, NUMBER_STATICS, (s) => `Number.${s}`);
      throw new ParseError(
        `Unknown Number static method '${methodTok.value}' at position ${methodTok.pos}.${numberHint} Supported: ${NUMBER_STATICS.map((s) => `Number.${s}`).join(", ")}.`,
        numberTok.pos,
      );
    }
    const method = methodTok.value as NumberStaticMethod;
    this.lexer.next();
    this.lexer.expect(TokenType.LParen);
    const arg = this.parseExpression();
    this.consumeTrailingComma(TokenType.RParen);
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
      const hint = didYouMean(ident.value, [...MATH_METHODS, ...MATH_CONSTANTS], (s) => `Math.${s}`);
      throw new ParseError(
        `Unknown Math member '${ident.value}' at position ${ident.pos}.${hint} See docs/LANGUAGE.md for the full list of supported Math methods and constants.`,
        mathTok.pos,
      );
    }
    this.lexer.next(); // consume method name
    const method = ident.value as MathMethod;
    // Bare callable form (no parens) — `.map(Math.floor)` desugars to
    // `.map(v => Math.floor(v))`. Restricted to unary methods so the bare
    // reference's arity matches the JS callback contract. Binary methods
    // (pow, min, max, hypot, atan2) require explicit parens.
    if (this.lexer.peek().type !== TokenType.LParen) {
      if (!UNARY_MATH_CALLABLES.has(method)) {
        throw new ParseError(
          `Math.${method} requires '(...)'. Only the unary Math methods (Math.floor / .ceil / .round / .abs / …) can be passed as bare callbacks (e.g. \`arr.map(Math.floor)\`).`,
          mathTok.pos,
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
  private parseObjectCall(): Expr {
    const objectTok = this.lexer.next(); // consume 'Object'
    this.lexer.expect(TokenType.Dot);
    const methodTok = this.lexer.peek();
    if (methodTok.type !== TokenType.Ident || !OBJECT_METHODS.has(methodTok.value)) {
      const objectHint = didYouMean(methodTok.value, [...OBJECT_METHODS], (s) => `Object.${s}`);
      throw new ParseError(
        `Unknown Object method '${methodTok.value}' at position ${methodTok.pos}.${objectHint} Supported: ${[...OBJECT_METHODS].join(", ")}.`,
        objectTok.pos,
      );
    }
    this.lexer.next(); // consume method name
    const method = methodTok.value as ObjectMethod;
    this.lexer.expect(TokenType.LParen);
    const args = this.parseDelimitedList(TokenType.RParen, () => this.parseCallArg());
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
      this.lexer.next(); // consume `,`
      // A lone trailing comma (`Number(x,)`) is fine; a real second argument is not.
      if (this.lexer.peek().type !== TokenType.RParen) {
        throw new ParseError(`Type cast '${cast}()' takes exactly 1 argument at position ${castTok.pos}`, castTok.pos);
      }
    }
    this.lexer.expect(TokenType.RParen);
    return { type: "TypeCast", cast, arg, pos: castTok.pos };
  }

  private parseNumber(): Expr {
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
  private classifyHexLiteral(lexeme: string, pos: number): Expr {
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
      `Hex literal '${lexeme}' at position ${pos} has ${hex.length} digits — neither a 24-character ObjectId nor an integer that fits Number.MAX_SAFE_INTEGER. Paste a 24-character hex string for an ObjectId, or use a decimal literal.`,
      pos,
    );
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
      throw new ParseError(`Unexpected token in template literal at position ${next.pos}`, next.pos);
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
        const spread: SpreadElement = { type: "SpreadElement", argument: arg, pos: spreadTok.pos };
        elements.push(spread);
      } else if (this.lexer.peek().type === TokenType.Delete) {
        // `delete $.x` as a pipeline element. Codegen rejects it if the array
        // turns out not to be a pipeline.
        elements.push(this.parseDeleteStmt());
      } else if (this.lexer.peek().type === TokenType.Let || this.lexer.peek().type === TokenType.Const) {
        // `let x = expr` (or the `const` alias) as a pipeline element — or a
        // reusable function declaration when the initialiser is an arrow.
        // Codegen rejects either if the array is not a pipeline (parallel to
        // AssignExpr/DeleteStmt handling).
        elements.push(this.parseDeclStatement());
      } else if (this.lexer.peek().type === TokenType.Ident && this.lexer.peek().value === "function") {
        // `function foo(...) { return … }` as a pipeline element — the keyword
        // spelling of a `const foo = (...) => …` declaration. (Array elements are
        // `,`-separated by JS syntax, so no self-termination handling is needed
        // here, unlike the `;`-separated statement loops.)
        elements.push(this.parseFunctionDeclStatement());
      } else if (this.peekIncDecOp() !== null) {
        // Prefix `++$.x` / `--$.x` as a pipeline element.
        elements.push(this.parsePrefixIncDec());
      } else {
        // Could be a regular expression OR an assignment OR a postfix `x++`
        // used as a pipeline element. Parse the expression first; if a bare
        // assignment operator or `++`/`--` follows, treat as a update op.
        const expr = this.parseExpression();
        if (this.peekAssignOp() !== null) {
          this.validateUpdateTarget(expr);
          for (const m of this.parseAssignmentChainFrom(expr)) elements.push(m);
        } else if (this.peekIncDecOp() !== null) {
          const op = this.peekIncDecOp()!;
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
        const spread: SpreadElement = { type: "SpreadElement", argument: arg, pos: spreadTok.pos };
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

    // `let`/`const` are jsmql keywords but are also legitimate object-key names
    // (`$lookup`, `$graphLookup`, `$documents`, and top-level `aggregate({ let: ... })`
    // all carry a `let:` field; `const` is a plausible plain field name). Accept
    // either as an object key so those shapes continue to parse. Shorthand
    // `{ let }` / `{ const }` is intentionally rejected — it would conflict with
    // `let x = …` / `const x = …` statements and serve no useful purpose.
    if (tok.type === TokenType.Let || tok.type === TokenType.Const) {
      this.lexer.next();
      this.lexer.expect(TokenType.Colon);
      const value = this.parseExpression();
      const key: ObjectKey = { kind: "static", name: tok.value };
      return { type: "KeyValueEntry", key, value, pos: tok.pos };
    }

    // A NUMERIC key (`{ 0: … }`, `{ 1.5: … }`, `{ 0x10: … }`) is valid JavaScript,
    // where a property key is always coerced to a string — so `{ 0: 1 }` builds the
    // field `"0"` and `{ 0x10: 1 }` builds `"16"` (the numeric VALUE, not the source
    // text). This is the write-side counterpart of reading `doc[0]`.
    if (tok.type === TokenType.Number) {
      const literal = this.parseNumber();
      if (literal.type !== "NumberLiteral") {
        // A 24-hex `0x…` is an ObjectId in jsmql, and an ObjectId is not a field
        // name. JS would read it as a precision-losing number, so neither reading
        // is useful — name the spelling that works.
        throw new ParseError(
          `An ObjectId literal can't be an object key at position ${tok.pos} — a field name is a string. ` +
            `Quote it (\`{ "${"hex" in literal ? literal.hex : ""}": … }\`) to use it as a field name.`,
          tok.pos,
        );
      }
      this.lexer.expect(TokenType.Colon);
      const value = this.parseExpression();
      const key: ObjectKey = { kind: "static", name: String(literal.value) };
      return { type: "KeyValueEntry", key, value, pos: tok.pos };
    }
    if (tok.type !== TokenType.Ident && tok.type !== TokenType.String) {
      throw new ParseError(
        `Expected an object key, but found ${formatActualToken(tok)} at position ${tok.pos}. ` +
          `An object entry must be \`key: value\`, a shorthand \`key\`, or a spread \`...expr\`. ` +
          `To include fields conditionally, spread a ternary: \`{ ...base, ...(cond ? { … } : {}) }\`.`,
        tok.pos,
      );
    }
    this.lexer.next();
    const next = this.lexer.peek();
    // Shorthand: `{ x }` — only valid for plain identifiers; it desugars to `{ x: x }`,
    // where the value is a ParamRef. (Codegen will reject if `x` is not a lambda param.)
    if (tok.type === TokenType.Ident && (next.type === TokenType.Comma || next.type === TokenType.RBrace)) {
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
 * update op target. Used by `validateUpdateTarget` to name *what* the user
 * wrote (a method call, a comparison, a literal, …) rather than just
 * complaining the target wasn't a field path.
 */
/**
 * Methods whose `=> { … }` callback body is parsed with the sub-pipeline block
 * grammar (`parseCallbackBlock`) — but only when the receiver is stream-rooted (see
 * `isStreamRooted`). `.aggregate` is the one method whose block IS a pipeline (each
 * statement a stage, no `return`).
 *
 * The JavaScript/lodash methods share the grammar without sharing the meaning:
 * `.find` / `.filter` / `.reject` / `.takeWhile` / `.dropWhile` are predicates,
 * `.map` / `.flatMap` are per-document transforms, so their blocks are JavaScript
 * (`const`/`let` plus one `return <expr>`) and a stage inside one is rejected
 * downstream by `src/callback-block.ts`. Parsing their statements anyway is what lets
 * that rejection name the stage the developer wrote and the rewrite that works in the
 * surrounding container; a grammar that stopped at the first `$` could only say
 * "unexpected token". Membership is therefore about which callbacks a developer might
 * plausibly reach for a pipeline in — the key-function methods (`.toSorted`,
 * `.uniqBy`, `.groupBy`, …) take a field expression, not a body of work, so a
 * `=> { … }` there keeps its expression-block meaning.
 */
const STREAM_BLOCK_METHODS = new Set<string>([
  "find",
  "filter",
  "reject",
  "takeWhile",
  "dropWhile",
  "map",
  "flatMap",
  "aggregate",
]);

/**
 * What a `=> { … }` argument body means at a call site, plus the receiver context
 * `parseExprBlockBody` needs to diagnose a **near-miss**: a block of `$stage(...)`
 * calls written where only an expression block is legal. Knowing the method name
 * and whether its receiver was stream-rooted is what turns the generic
 * "must end with `return`" into a message that names the actual mistake — a
 * misspelled block method (`.aggregat`) or a stream-only block on an in-document
 * array. `method` / `streamRooted` are absent at non-method call sites.
 */
type BlockArgCtx = { kind: "pipeline" | "expr"; method?: string; streamRooted?: boolean };

/** The default: a `=> { … }` body is an expression block, no receiver context. */
const EXPR_BLOCK_ARG: BlockArgCtx = { kind: "expr" };

/**
 * Walk a receiver chain back to its root and report whether the root is a
 * stream source: a context-ref prefix `$$$` (`DatabaseRef`, same database),
 * `$$$$` (`ClusterRef`, cross-database), or `$$` (`CollectionRef`, the current
 * stream). Used by `parsePostfix` (with `STREAM_BLOCK_METHODS`) to decide whether a
 * method call parses its callback with the sub-pipeline block grammar, as opposed to
 * the expression-block grammar used by in-document array methods
 * (`$.items.map(d => { … })`, rooted at a `FieldRef`). Only `.aggregate` *keeps* a
 * pipeline block; for the JavaScript methods the grammar is shared so the stage
 * rejection can name what the developer wrote (see `src/callback-block.ts`).
 *
 * The chain may include any number of `MemberAccess`, `IndexAccess`, and
 * `MethodCall` hops — so `$$$.users`, `$$$["users"]`, `$$$$.myDb.myColl`, and a
 * chain off any of those (`$$$.orders.filter(p).map(…)`) all match. Only the
 * root matters; depth-checking (rejecting `$$$.foo.bar.find(...)`) happens at
 * the lookup-translation layer (`extractLookupTarget`).
 */
function isStreamRooted(expr: Expr): boolean {
  let node: Expr = expr;
  for (;;) {
    if (node.type === "DatabaseRef" || node.type === "ClusterRef" || node.type === "CollectionRef") return true;
    if (node.type === "MemberAccess" || node.type === "IndexAccess" || node.type === "MethodCall") {
      node = node.object;
      continue;
    }
    return false;
  }
}

function describeUpdateTarget(target: Expr): string {
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
    case "ObjectIdRef":
      return "a bare 'ObjectId' reference";
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
    case "MathCallRef":
      return `a bare 'Math.${target.method}' reference`;
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
    case "DateUTC":
      return "the result of Date.UTC(…)";
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
