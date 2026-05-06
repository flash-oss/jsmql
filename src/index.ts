import { Parser, ParseError } from "./parser.ts";
import { generate, CodegenError } from "./codegen.ts";
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

export function mjsql(expression: string): object {
  const parser = new Parser(expression);
  const ast = parser.parse();
  return generate(ast) as object;
}

export function validate(expression: string): ValidationResult {
  try {
    const parser = new Parser(expression);
    const ast = parser.parse();
    generate(ast);
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
