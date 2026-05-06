import { Parser, ParseError } from "./parser.ts";
import { generate, CodegenError, UnknownIdentifierError } from "./codegen.ts";
import { LexError } from "./lexer.ts";

export type ValidationError = {
  message: string;
  pos: number;
  code: "SYNTAX_ERROR" | "CODEGEN_ERROR";
};

export type ValidationResult = {
  valid: boolean;
  errors: ValidationError[];
};

export class FunctionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FunctionInputError";
  }
}

// Accept any callable shape: the canonical idiom is `($) => …` (one
// parameter named `$`, used as the document-context placeholder), but `()
// => …` and `(doc) => …` are equally valid — the parameter list is
// stripped at extraction time. `any` for the parameter type lets users
// write unannotated `$` and still get IDE autocomplete (`$.foo.bar`)
// without `noImplicitAny` complaining.
export type MjsqlInput = string | ((...args: any[]) => unknown);

// Compiled-body cache for the function-input path. Keyed on the extracted body
// string, so inline arrows in hot loops (which create a new function object on
// every call) still hit. Bounded by source-code size — there is no way to
// inject dynamic content into a function body, so this never grows unboundedly.
const fnBodyCache = new Map<string, object>();

export function mjsql(input: MjsqlInput): object {
  if (typeof input === "function") {
    const body = extractArrowBody(input);
    const cached = fnBodyCache.get(body);
    if (cached !== undefined) return cached;
    let compiled: object;
    try {
      compiled = compile(body);
    } catch (err) {
      throw augmentForFunctionInput(err);
    }
    fnBodyCache.set(body, compiled);
    return compiled;
  }
  return compile(input);
}

export function validate(input: MjsqlInput): ValidationResult {
  try {
    mjsql(input);
    return { valid: true, errors: [] };
  } catch (err) {
    if (err instanceof ParseError || err instanceof LexError) {
      return {
        valid: false,
        errors: [{ message: err.message, pos: err.pos, code: "SYNTAX_ERROR" }],
      };
    }
    if (err instanceof CodegenError) {
      return {
        valid: false,
        errors: [{ message: err.message, pos: 0, code: "CODEGEN_ERROR" }],
      };
    }
    if (err instanceof FunctionInputError) {
      return {
        valid: false,
        errors: [{ message: err.message, pos: 0, code: "SYNTAX_ERROR" }],
      };
    }
    throw err;
  }
}

export function mql(strings: TemplateStringsArray, ...values: unknown[]): object {
  let src = "";
  for (let i = 0; i < strings.length; i++) {
    src += strings[i];
    if (i < values.length) {
      src += JSON.stringify(values[i]);
    }
  }
  return mjsql(src);
}

function compile(expression: string): object {
  const parser = new Parser(expression);
  const ast = parser.parse();
  return generate(ast) as object;
}

// ── Function-input extraction ─────────────────────────────────────────────

function extractArrowBody(fn: () => unknown): string {
  const src = Function.prototype.toString.call(fn).trim();

  if (/^async\b/.test(src)) {
    throw new FunctionInputError(
      "mjsql does not support async functions. Use a synchronous arrow: `($) => …`",
    );
  }
  if (/^function\b/.test(src)) {
    throw new FunctionInputError(
      "mjsql expects an arrow function, got a `function` declaration. Use: `($) => …`",
    );
  }

  const arrowIdx = src.indexOf("=>");
  if (arrowIdx < 0) {
    throw new FunctionInputError(
      `mjsql could not find an arrow operator in the function source. Use: \`($) => …\``,
    );
  }

  let body = src.slice(arrowIdx + 2).trim();

  if (body.startsWith("{")) {
    throw new FunctionInputError(
      "mjsql expects an expression-body arrow function, not a block body. " +
        "Use `($) => EXPR`, not `($) => { return EXPR; }`",
    );
  }

  while (body.endsWith(";")) body = body.slice(0, -1).trimEnd();
  return body;
}

function augmentForFunctionInput(err: unknown): unknown {
  if (err instanceof UnknownIdentifierError) {
    err.message =
      `${err.message}\n` +
      `If '${err.identifier}' is a value from outer scope, use the mql\`\` template tag: ` +
      `mql\`… \${${err.identifier}} …\``;
  }
  return err;
}
