import { Parser, ParseError, FunctionInputError, type FunctionInputResult } from "./parser.ts";
import {
  generate,
  generateMutationProgram,
  generateWithCtx,
  CodegenError,
  EMPTY_CTX,
  UnknownIdentifierError,
  withBindings,
  type GenerateCtx,
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
//
// `slot` is the 1-based template-tag interpolation index for the template-tag
// path. `key` is the param-binding name for the `jsmql.compile()` call path.
// Exactly one of the two is set depending on which surface raised the error.
export class JsmqlInterpolationError extends Error {
  readonly slot: number;
  readonly key?: string;
  constructor(message: string, slot: number, key?: string) {
    super(message);
    this.name = "JsmqlInterpolationError";
    this.slot = slot;
    this.key = key;
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

// Function-form parameter binding (used by `jsmql.compile`). The arrow's
// first slot is a destructure pattern that names the bindings; the same names
// must appear as keys on the params object passed at call time. The `$` and
// ops-hint slots remain optional and order-disambiguated by shape — see
// `Parser.parseParameterList` for the rule and docs/LANGUAGE.md for the
// user-facing reference.
//
// `$` and `ops` are declared as required (not `?:`) so that users who
// explicitly annotate them with a destructure type — `({ $match }: JsmqlOps)`
// — get clean type inference. TypeScript already lets users omit trailing
// parameters when assigning to a function type, so `(params) => …` and
// `(params, $) => …` still work; the parser also strips the parameter list
// at extraction time, so the runtime never sees any of these declarations.
type JsmqlCompileFn<P> = (params: P, $: any, ops: JsmqlOps) => unknown;

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
//
// `jsmql.compile(fn)` does NOT use this cache: it returns a closure that
// captures the parsed AST and bindings, which is a stronger form of caching
// scoped to the user's variable. Keeping the LRU only for the one-shot
// `jsmql(fn)` path avoids double-caching.
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

function jsmqlDispatch(input: JsmqlInput): JsmqlOutput;
function jsmqlDispatch(strings: TemplateStringsArray, ...values: unknown[]): JsmqlOutput;
function jsmqlDispatch(
  input: JsmqlInput | TemplateStringsArray,
  ...values: unknown[]
): JsmqlOutput {
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
      const { program, bindings } = new Parser(src).parseFunctionInput();
      if (bindings.length > 0) {
        throw new FunctionInputError(
          "jsmql() in its one-shot form does not accept a parameter-bindings destructure. " +
            "Use `jsmql.compile(fn)(params)` to supply values to a parameterised query, " +
            "or remove the destructure pattern from the arrow's first slot.",
        );
      }
      compiled = lower(program);
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

/**
 * Compile a parameterised arrow function to a reusable MQL builder.
 *
 * The arrow's first slot is a destructure pattern naming the bindings: a
 * `Record<string, JsonValue>` whose keys must be supplied as the params
 * object at call time. The returned function does no parsing on each
 * invocation — it walks the cached AST with the bound values substituted in
 * place of `ParamRef` nodes, emitting an inline MQL literal for each.
 *
 * The MQL output shape matches the template-tag form: each binding value
 * appears as a JSON literal, never wrapped in `$let`. This makes parameter
 * bindings compose uniformly across expression mode, pipeline mode, and
 * sub-pipelines (`$lookup`, `$unionWith`, `$facet`), and avoids `$$name`
 * collisions with lambda parameters.
 */
function compileFunction<P extends Record<string, unknown>>(
  fn: JsmqlCompileFn<P>,
): (params: P) => JsmqlOutput {
  const src = Function.prototype.toString.call(fn).trim();
  let parsed: FunctionInputResult;
  try {
    parsed = new Parser(src).parseFunctionInput();
  } catch (err) {
    throw augmentForFunctionInput(err);
  }
  const { program, bindings } = parsed;
  return (params: P): JsmqlOutput => {
    const resolved = new Map<string, unknown>();
    for (const b of bindings) {
      if (!Object.prototype.hasOwnProperty.call(params, b.key)) {
        // The body refers to `b.name`; the user's missing key is `b.key`. When
        // aliased, mention both so the user can find either.
        const expected =
          b.key === b.name ? b.key : `${b.key}' (bound to '${b.name}' in the function body)`;
        throw new UnknownIdentifierError(expected);
      }
      const value = (params as Record<string, unknown>)[b.key];
      validateInterpolatable(value, 0, b.key);
      resolved.set(b.name, value);
    }
    const ctx = withBindings(EMPTY_CTX, resolved);
    return lowerWithCtx(program, ctx);
  };
}

/**
 * Parse-and-validate any input shape `jsmql()` accepts. Same overload set as
 * `jsmql()` itself. Returns a `ValidationResult` with structured errors
 * instead of throwing, so callers can drive editor tooling, form validation,
 * and similar use cases.
 */
function validateInput(input: JsmqlInput): ValidationResult;
function validateInput(strings: TemplateStringsArray, ...values: unknown[]): ValidationResult;
function validateInput(
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
    return errorToValidationResult(err);
  }
}

// `jsmql` is exposed as a callable with two attached properties: `jsmql.compile`
// (parameterised, reusable) and `jsmql.validate` (structured-result form of
// `jsmql()`). The strippable-TS rule (see src/CLAUDE.md) forbids `namespace`
// declarations, so we build the shape with `Object.assign` and an explicit
// intersection type.
type Jsmql = typeof jsmqlDispatch & {
  compile: typeof compileFunction;
  validate: typeof validateInput;
};

export const jsmql: Jsmql = Object.assign(jsmqlDispatch, {
  compile: compileFunction,
  validate: validateInput,
});

// Wrap JSON.stringify with the validation needed to keep the template-tag
// invocation of `jsmql` a safe boundary. Three failure modes that
// JSON.stringify quietly hides:
//   - returns `undefined` for unsupported value types (function/Symbol/the
//     literal `undefined`); concatenating that into the source produces the
//     bare text "undefined" which the parser then misreads as an identifier.
//   - silently coerces non-finite numbers to "null", losing the user's intent.
//   - throws TypeError for BigInt values and circular references.
function stringifyInterpolation(value: unknown, slot: number): string {
  validateInterpolatable(value, slot);
  // After validateInterpolatable, JSON.stringify is guaranteed to produce a
  // string (no `undefined` return, no throw, no silent NaN→null coercion).
  return JSON.stringify(value)!;
}

/**
 * Validate that `value` is safely embeddable as a JSON literal in the MQL
 * output. Used by both the template-tag interpolation path and the
 * `jsmql.compile()` parameter-binding path. Throws `JsmqlInterpolationError`
 * on any of the three failure modes JSON.stringify mishandles.
 *
 * When called from the template-tag path, `slot` is the 1-based interpolation
 * index and `key` is undefined. When called from `jsmql.compile`, pass `slot=0`
 * and the binding name as `key` — the resulting error names the binding so the
 * user can find it in their call site.
 */
function validateInterpolatable(value: unknown, slot: number, key?: string): void {
  const where = key !== undefined ? `parameter '${key}'` : `interpolation slot ${slot}`;
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new JsmqlInterpolationError(
      `jsmql ${where}: ${value} is not a valid JSON value (NaN and ±Infinity have no JSON representation). Replace with null or a finite number.`,
      slot,
      key,
    );
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new JsmqlInterpolationError(
      `jsmql ${where} could not be serialised: ${reason}`,
      slot,
      key,
    );
  }
  if (json === undefined) {
    const ty = value === undefined ? "undefined" : typeof value;
    throw new JsmqlInterpolationError(
      `jsmql ${where} has type '${ty}', which has no JSON representation. Pass a string, number, boolean, null, array, or plain object instead.`,
      slot,
      key,
    );
  }
}

/**
 * Lower a parsed `Program` to its MQL output, threading a starting
 * `GenerateCtx`. Centralised so the string-input path (`Parser.parse()`) and
 * the function-input path (`Parser.parseFunctionInput()`) share the same
 * dispatch, and so `jsmql.compile()` can pass in a ctx pre-populated with
 * parameter bindings.
 */
function lowerWithCtx(ast: Program, ctx: GenerateCtx): JsmqlOutput {
  if (ast.type === "Pipeline") return generateImplicitPipeline(ast, ctx);
  if (ast.type === "MutationProgram") return generateMutationProgram(ast, ctx);
  if (isPipelineAst(ast)) return generatePipeline(ast, ctx);
  return generateWithCtx(ast, ctx) as object;
}

function lower(ast: Program): JsmqlOutput {
  return lowerWithCtx(ast, EMPTY_CTX);
}

/**
 * Map a thrown error to the structured `ValidationResult` shape. Kept as a
 * standalone helper so the per-error-class branch table lives in one place,
 * which keeps the contract on `jsmql.validate()` stable as new error types
 * are introduced over time.
 */
function errorToValidationResult(err: unknown): ValidationResult {
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

function augmentForFunctionInput(err: unknown): unknown {
  if (err instanceof UnknownIdentifierError) {
    err.message =
      `${err.message}\n` +
      `If '${err.identifier}' is a binding you want to supply at call time, use ` +
      `jsmql.compile(fn)({ ${err.identifier}: … }) and add it to the params destructure: ` +
      `({ ${err.identifier} }, $) => …\n` +
      `If '${err.identifier}' is a value from outer scope, use the jsmql\`\` template tag: ` +
      `jsmql\`… \${${err.identifier}} …\``;
  }
  return err;
}
