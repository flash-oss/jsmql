import { Parser, ParseError } from "./parser.ts";
import {
  generate,
  generateMutationProgram,
  CodegenError,
  UnknownIdentifierError,
} from "./codegen.ts";
import { isPipelineAst, generatePipeline, generateImplicitPipeline } from "./pipeline.ts";
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

// Raised by the `mql` template tag when an interpolated value cannot be safely
// embedded as a JSON literal. Covers the three cases JSON.stringify mishandles:
// values it returns `undefined` for (functions, Symbols, plain `undefined`), the
// non-finite numbers it silently coerces to `null` (NaN/Infinity/-Infinity), and
// values it throws on (BigInt, circular references). Surfacing these as a
// dedicated error means the caller learns about the problem at interpolation
// time instead of getting a confusing parse error or silent data loss
// downstream.
export class MqlInterpolationError extends Error {
  readonly slot: number;
  constructor(message: string, slot: number) {
    super(message);
    this.name = "MqlInterpolationError";
    this.slot = slot;
  }
}

// Accept any callable shape: the canonical idiom is `($) => …` (one
// parameter named `$`, used as the document-context placeholder), but `()
// => …` and `(doc) => …` are equally valid — the parameter list is
// stripped at extraction time. `any` for the `$` parameter lets users
// write unannotated `$` and still get IDE autocomplete (`$.foo.bar`)
// without `noImplicitAny` complaining.
//
// The optional second parameter is types-only: it gives users a destructure
// site for escape-hatch operators (`($, { $dateDiff }) => $dateDiff(…)`) so
// IDEs don't flag `$dateDiff` as an unknown identifier. The parameter list
// is stripped before the parser runs, so this never reaches the runtime.
export type MjsqlOps = Record<`$${string}`, (...args: any[]) => any>;
type MjsqlFn = ($: any, ops: MjsqlOps) => unknown;
export type MjsqlInput = string | MjsqlFn;

// `mjsql()` returns either a single compiled MQL expression object, or — when
// the input is a top-level aggregation pipeline `[ { $stage: ... }, ... ]` —
// the corresponding stage array. The union is widened from the historical
// `object` to make pipeline mode visible in the type. Both runtime values are
// objects, so existing call sites keep type-checking.
export type MjsqlOutput = object | object[];

// Compiled-body cache for the function-input path. Keyed on the extracted body
// string, so inline arrows in hot loops (which create a new function object on
// every call) still hit. Today there is no way to inject dynamic content into
// a function body — `Function.prototype.toString()` returns the literal source
// text — so growth is naturally bounded by the number of distinct arrow
// expressions in the host program. The LRU cap is a defence-in-depth against
// future changes that could let dynamic strings reach this map (e.g. a
// `new Function(...)` accepted as input). Map preserves insertion order, so
// delete-then-set on hit refreshes recency without an extra data structure.
const FN_BODY_CACHE_CAP = 256;
const fnBodyCache = new Map<string, MjsqlOutput>();

function cacheGet(body: string): MjsqlOutput | undefined {
  const hit = fnBodyCache.get(body);
  if (hit === undefined) return undefined;
  fnBodyCache.delete(body);
  fnBodyCache.set(body, hit);
  return hit;
}

function cacheSet(body: string, compiled: MjsqlOutput): void {
  if (fnBodyCache.size >= FN_BODY_CACHE_CAP) {
    const oldest = fnBodyCache.keys().next().value;
    if (oldest !== undefined) fnBodyCache.delete(oldest);
  }
  fnBodyCache.set(body, compiled);
}

export function mjsql(input: MjsqlInput): MjsqlOutput {
  if (typeof input === "function") {
    const body = extractArrowBody(input);
    const cached = cacheGet(body);
    if (cached !== undefined) return cached;
    let compiled: MjsqlOutput;
    try {
      compiled = compile(body);
    } catch (err) {
      throw augmentForFunctionInput(err);
    }
    cacheSet(body, compiled);
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
    if (err instanceof FunctionInputError || err instanceof MqlInterpolationError) {
      return {
        valid: false,
        errors: [{ message: err.message, pos: 0, code: "SYNTAX_ERROR" }],
      };
    }
    // RangeError is what V8 throws on stack overflow — caused by input shape,
    // so it belongs in the SYNTAX_ERROR bucket. Should be unreachable in
    // practice now that the parser/codegen depth limits trip first, but keep
    // the catch as a belt-and-braces safeguard.
    if (err instanceof RangeError) {
      return {
        valid: false,
        errors: [{ message: err.message, pos: 0, code: "SYNTAX_ERROR" }],
      };
    }
    // validate() promises never to throw — anything else gets wrapped as a
    // generic CODEGEN_ERROR so the caller can rely on the structured-result
    // contract. The original message is preserved for debugging.
    const message = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      errors: [{ message: `internal error: ${message}`, pos: 0, code: "CODEGEN_ERROR" }],
    };
  }
}

export function mql(strings: TemplateStringsArray, ...values: unknown[]): MjsqlOutput {
  let src = "";
  for (let i = 0; i < strings.length; i++) {
    src += strings[i];
    if (i < values.length) {
      src += stringifyInterpolation(values[i], i + 1);
    }
  }
  return mjsql(src);
}

// Wrap JSON.stringify with the validation needed to keep the `mql` template
// tag a safe boundary. Three failure modes that JSON.stringify quietly hides:
//   - returns `undefined` for unsupported value types (function/Symbol/the
//     literal `undefined`); concatenating that into the source produces the
//     bare text "undefined" which the parser then misreads as an identifier.
//   - silently coerces non-finite numbers to "null", losing the user's intent.
//   - throws TypeError for BigInt values and circular references.
function stringifyInterpolation(value: unknown, slot: number): string {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new MqlInterpolationError(
      `mql interpolation slot ${slot}: ${value} is not a valid JSON value (NaN and ±Infinity have no JSON representation). Replace with null or a finite number.`,
      slot,
    );
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new MqlInterpolationError(
      `mql interpolation slot ${slot} could not be serialised: ${reason}`,
      slot,
    );
  }
  if (json === undefined) {
    const ty = value === undefined ? "undefined" : typeof value;
    throw new MqlInterpolationError(
      `mql interpolation slot ${slot} has type '${ty}', which has no JSON representation. Pass a string, number, boolean, null, array, or plain object instead.`,
      slot,
    );
  }
  return json;
}

function compile(expression: string): MjsqlOutput {
  const parser = new Parser(expression);
  const ast = parser.parse();
  if (ast.type === "Pipeline") return generateImplicitPipeline(ast);
  if (ast.type === "MutationProgram") return generateMutationProgram(ast);
  if (isPipelineAst(ast)) return generatePipeline(ast);
  return generate(ast) as object;
}

// ── Function-input extraction ─────────────────────────────────────────────

function extractArrowBody(fn: (...args: any[]) => unknown): string {
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
    // Block-body arrow: a sequence of mjsql statements separated by `;`,
    // matching the implicit-pipeline form of the string input. We strip the
    // outer braces and pass the inner content to the parser unchanged — `;`s
    // inside the block are pipeline-stage separators, not formatter artifacts.
    if (!body.endsWith("}")) {
      throw new FunctionInputError(
        "mjsql could not parse arrow body — expected `}` to close the block body",
      );
    }
    const inner = body.slice(1, -1).trim();
    // `return` is JavaScript control flow, not part of mjsql. Surface a clear
    // error rather than the parser's "unknown identifier" message. The check
    // is positional (preceded by start-of-input, whitespace, `;`, `{`, or `}`)
    // so it doesn't false-match `return` inside identifiers.
    if (/(?:^|[\s;{}])return\b/.test(inner)) {
      throw new FunctionInputError(
        "mjsql block-body arrows are a sequence of mjsql statements, not JavaScript control flow. Remove `return` — write the body as `;`-separated mjsql statements, or switch to an expression-body arrow `($) => EXPR`.",
      );
    }
    return inner;
  }

  // Expression-body arrow: trim trailing `;`s left by formatters. Stripping
  // here keeps `($) => $.a = 1` (with an editor-added trailing `;`) from
  // accidentally flipping into pipeline mode — single-statement expression
  // arrows preserve their object-shaped output.
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
