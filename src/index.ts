import { Parser, ParseError, FunctionInputError } from "./parser.ts";
import {
  generate,
  generateMutationProgram,
  CodegenError,
  UnknownIdentifierError,
} from "./codegen.ts";
import { isPipelineAst, generatePipeline, generateImplicitPipeline } from "./pipeline.ts";
import { LexError } from "./lexer.ts";
import type { Program } from "./ast.ts";

// Re-exported so users can `import { FunctionInputError } from "jsmql"` even
// though the class itself lives in parser.ts (where it is thrown).
export { FunctionInputError };

export type ValidationError = {
  message: string;
  pos: number;
  code: "SYNTAX_ERROR" | "CODEGEN_ERROR";
};

export type ValidationResult = {
  valid: boolean;
  errors: ValidationError[];
};

// Raised by the template-tag invocation of `jsmql` when an interpolated value
// cannot be safely embedded as a JSON literal. Covers the three cases
// JSON.stringify mishandles: values it returns `undefined` for (functions,
// Symbols, plain `undefined`), the non-finite numbers it silently coerces to
// `null` (NaN/Infinity/-Infinity), and values it throws on (BigInt, circular
// references). Surfacing these as a dedicated error means the caller learns
// about the problem at interpolation time instead of getting a confusing parse
// error or silent data loss downstream.
export class JsmqlInterpolationError extends Error {
  readonly slot: number;
  constructor(message: string, slot: number) {
    super(message);
    this.name = "JsmqlInterpolationError";
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
export type JsmqlOps = Record<`$${string}`, (...args: any[]) => any>;
type JsmqlFn = ($: any, ops: JsmqlOps) => unknown;
export type JsmqlInput = string | JsmqlFn;

// `jsmql()` returns either a single compiled MQL expression object, or — when
// the input is a top-level aggregation pipeline `[ { $stage: ... }, ... ]` —
// the corresponding stage array. The union is widened from the historical
// `object` to make pipeline mode visible in the type. Both runtime values are
// objects, so existing call sites keep type-checking.
export type JsmqlOutput = object | object[];

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
const fnBodyCache = new Map<string, JsmqlOutput>();

function cacheGet(body: string): JsmqlOutput | undefined {
  const hit = fnBodyCache.get(body);
  if (hit === undefined) return undefined;
  fnBodyCache.delete(body);
  fnBodyCache.set(body, hit);
  return hit;
}

function cacheSet(body: string, compiled: JsmqlOutput): void {
  if (fnBodyCache.size >= FN_BODY_CACHE_CAP) {
    const oldest = fnBodyCache.keys().next().value;
    if (oldest !== undefined) fnBodyCache.delete(oldest);
  }
  fnBodyCache.set(body, compiled);
}

// `jsmql` has three call shapes — string, arrow function, and template tag —
// dispatched on the first argument. The template-tag form is detected by the
// standard "frozen `TemplateStringsArray`" discriminator: an Array whose `raw`
// property is also an Array. The current `JsmqlInput` excludes arrays, so this
// check collides with nothing in the typed surface. Note: if `JsmqlInput` is
// ever widened to include plain pipeline arrays, the discriminator must still
// run first — `Array.isArray` alone would no longer disambiguate.
function isTemplateStringsArray(x: unknown): x is TemplateStringsArray {
  return Array.isArray(x) && Array.isArray((x as { raw?: unknown }).raw);
}

export function jsmql(input: JsmqlInput): JsmqlOutput;
export function jsmql(strings: TemplateStringsArray, ...values: unknown[]): JsmqlOutput;
export function jsmql(input: JsmqlInput | TemplateStringsArray, ...values: unknown[]): JsmqlOutput {
  if (isTemplateStringsArray(input)) {
    let src = "";
    for (let i = 0; i < input.length; i++) {
      src += input[i];
      if (i < values.length) {
        src += stringifyInterpolation(values[i], i + 1);
      }
    }
    return lower(new Parser(src).parse());
  }
  if (typeof input === "function") {
    const src = Function.prototype.toString.call(input).trim();
    const cached = cacheGet(src);
    if (cached !== undefined) return cached;
    let compiled: JsmqlOutput;
    try {
      compiled = lower(new Parser(src).parseFunctionInput());
    } catch (err) {
      throw augmentForFunctionInput(err);
    }
    cacheSet(src, compiled);
    return compiled;
  }
  if (typeof input === "string") {
    return lower(new Parser(input).parse());
  }
  // Polymorphism widens the runtime input space — without this guard, a
  // wrong-typed call (e.g. `jsmql(42)`, `jsmql({})`) would crash deep inside
  // the parser with a confusing message. DX priority #1 says vague errors are
  // not acceptable, so name the contract here.
  const ty = input === null ? "null" : typeof input;
  throw new TypeError(
    `jsmql() expects a string, an arrow function, or a template literal — got ${ty}.`,
  );
}

export function validate(input: JsmqlInput): ValidationResult;
export function validate(strings: TemplateStringsArray, ...values: unknown[]): ValidationResult;
export function validate(
  input: JsmqlInput | TemplateStringsArray,
  ...values: unknown[]
): ValidationResult {
  try {
    if (isTemplateStringsArray(input)) {
      jsmql(input, ...values);
    } else {
      jsmql(input);
    }
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
    if (err instanceof FunctionInputError || err instanceof JsmqlInterpolationError) {
      return {
        valid: false,
        errors: [{ message: err.message, pos: 0, code: "SYNTAX_ERROR" }],
      };
    }
    // RangeError is what V8 throws on stack overflow — caused by input shape,
    // so it belongs in the SYNTAX_ERROR bucket. Should be unreachable in
    // practice now that the parser/codegen depth limits trip first, but keep
    // the catch as a belt-and-braces safeguard. TypeError lands here too: it
    // comes from `jsmql()`'s top-level guard rejecting a wrong-shape input,
    // which is a "your input is wrong" failure from the caller's perspective.
    if (err instanceof RangeError || err instanceof TypeError) {
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

// Wrap JSON.stringify with the validation needed to keep the template-tag
// invocation of `jsmql` a safe boundary. Three failure modes that
// JSON.stringify quietly hides:
//   - returns `undefined` for unsupported value types (function/Symbol/the
//     literal `undefined`); concatenating that into the source produces the
//     bare text "undefined" which the parser then misreads as an identifier.
//   - silently coerces non-finite numbers to "null", losing the user's intent.
//   - throws TypeError for BigInt values and circular references.
function stringifyInterpolation(value: unknown, slot: number): string {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new JsmqlInterpolationError(
      `jsmql interpolation slot ${slot}: ${value} is not a valid JSON value (NaN and ±Infinity have no JSON representation). Replace with null or a finite number.`,
      slot,
    );
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new JsmqlInterpolationError(
      `jsmql interpolation slot ${slot} could not be serialised: ${reason}`,
      slot,
    );
  }
  if (json === undefined) {
    const ty = value === undefined ? "undefined" : typeof value;
    throw new JsmqlInterpolationError(
      `jsmql interpolation slot ${slot} has type '${ty}', which has no JSON representation. Pass a string, number, boolean, null, array, or plain object instead.`,
      slot,
    );
  }
  return json;
}

/**
 * Lower a parsed `Program` to its MQL output. Centralised so the string-input
 * path (`Parser.parse()`) and the function-input path
 * (`Parser.parseFunctionInput()`) share the same dispatch.
 */
function lower(ast: Program): JsmqlOutput {
  if (ast.type === "Pipeline") return generateImplicitPipeline(ast);
  if (ast.type === "MutationProgram") return generateMutationProgram(ast);
  if (isPipelineAst(ast)) return generatePipeline(ast);
  return generate(ast) as object;
}

function augmentForFunctionInput(err: unknown): unknown {
  if (err instanceof UnknownIdentifierError) {
    err.message =
      `${err.message}\n` +
      `If '${err.identifier}' is a value from outer scope, use the jsmql\`\` template tag: ` +
      `jsmql\`… \${${err.identifier}} …\``;
  }
  return err;
}
