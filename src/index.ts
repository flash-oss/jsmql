import { Parser, ParseError, FunctionInputError, type FunctionInputResult } from "./parser.ts";
import {
  generate,
  generateUpdateFilter,
  generateWithCtx,
  CodegenError,
  EMPTY_CTX,
  UnknownIdentifierError,
  withBindings,
  type GenerateCtx,
} from "./codegen.ts";
import { isPipelineAst, generatePipeline, generateImplicitPipeline } from "./pipeline.ts";
import { translateMatchBody } from "./match-translation.ts";
import { lookupStage } from "./stages.ts";
import { LexError } from "./lexer.ts";
import type { Program, Expr } from "./ast.ts";

// Re-exported so users can `import { FunctionInputError } from "@koresar/jsmql"`
// even though the class itself lives in parser.ts (where it is thrown).
export { FunctionInputError };

export type ValidationError = { message: string; pos: number; code: "SYNTAX_ERROR" | "CODEGEN_ERROR" };

export type ValidationResult = { valid: boolean; errors: ValidationError[] };

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

/**
 * Single shared dispatcher for every public entry point that accepts the three
 * call shapes (string, arrow, template tag). The caller supplies its own
 * `lower` (Filter for `jsmql()`, expression for `jsmql.expr()`) and an
 * `apiName` for error messages — everything else (parsing, function-input
 * binding-rejection, function-input error augmentation, type guard) stays in
 * one place. Less code = better DX inside the codebase too.
 */
function dispatchInput(
  input: JsmqlInput | TemplateStringsArray,
  values: unknown[],
  apiName: string,
  lower: (program: Program) => JsmqlOutput,
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
    // The try wraps both parsing AND lowering: `augmentForFunctionInput` must
    // also fire when codegen throws an `UnknownIdentifierError` (closure ref)
    // mid-lowering, not only when the arrow itself fails to parse.
    try {
      const { program, bindings } = new Parser(src).parseFunctionInput();
      if (bindings.length > 0) {
        throw new FunctionInputError(
          `${apiName}() in its one-shot form does not accept a parameter-bindings destructure. ` +
            "Use `jsmql.compile(fn)(params)` to supply values to a parameterised query, " +
            "or remove the destructure pattern from the arrow's first slot.",
        );
      }
      return lower(program);
    } catch (err) {
      throw augmentForFunctionInput(err);
    }
  }
  if (typeof input === "string") {
    return lower(new Parser(input).parse());
  }
  // Polymorphism widens the runtime input space — without this guard, a
  // wrong-typed call (e.g. `jsmql(42)`, `jsmql({})`) would crash deep inside
  // the parser with a confusing message. DX priority #1 says vague errors are
  // not acceptable, so name the contract here.
  const ty = input === null ? "null" : typeof input;
  throw new TypeError(`${apiName}() expects a string, an arrow function, or a template literal — got ${ty}.`);
}

function jsmqlDispatch(input: JsmqlInput): JsmqlOutput;
function jsmqlDispatch(strings: TemplateStringsArray, ...values: unknown[]): JsmqlOutput;
function jsmqlDispatch(input: JsmqlInput | TemplateStringsArray, ...values: unknown[]): JsmqlOutput {
  return dispatchInput(input, values, "jsmql", lower);
}

/**
 * `jsmql.expr(input)` — compile a partial / "unfinished" expression in
 * aggregation-expression form, the shape used inside Pipeline stage bodies
 * (`$project`, `$addFields`, `$group`, …) and as the second argument to
 * `db.coll.updateOne(filter, update)` when the update is a update op.
 *
 * Differs from `jsmql()` only in the no-`;` bare-expression branch: instead of
 * Filter dispatch (`{ $expr: ... }` wrap for non-predicates), the expression
 * lowers directly to its aggregation-expression form. `;`-separated input is
 * still a Pipeline, update op chains still produce `$set`/`$unset`, and array-
 * literal Pipelines still pass through — the three other branches are shared
 * with `jsmql()` via `lowerProgram`. Same three input shapes as `jsmql()`.
 */
function exprDispatch(input: JsmqlInput): JsmqlOutput;
function exprDispatch(strings: TemplateStringsArray, ...values: unknown[]): JsmqlOutput;
function exprDispatch(input: JsmqlInput | TemplateStringsArray, ...values: unknown[]): JsmqlOutput {
  return dispatchInput(input, values, "jsmql.expr", lowerExpr);
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
 *
 * The input may also be a **string** containing the arrow source text — e.g.
 * `jsmql.compile("({ minAge }, $) => $.age > minAge")`. This is useful when
 * the query is stored externally (config, file, database) and the caller
 * still wants the parse-once-bind-many semantics. The destructure pattern is
 * the only parameter-declaration mechanism for both call shapes; placeholder
 * syntaxes like `${name}` are deliberately not supported (they would break
 * the strict-JS-subset rule and collide with real template literals).
 */
function compileFunction<P extends Record<string, unknown>>(fn: JsmqlCompileFn<P>): (params: P) => JsmqlOutput;
function compileFunction(src: string): (params: Record<string, unknown>) => JsmqlOutput;
function compileFunction<P extends Record<string, unknown>>(
  input: JsmqlCompileFn<P> | string,
): (params: P) => JsmqlOutput {
  let src: string;
  if (typeof input === "function") {
    src = Function.prototype.toString.call(input).trim();
  } else if (typeof input === "string") {
    src = input.trim();
  } else {
    const ty = input === null ? "null" : typeof input;
    throw new TypeError(`jsmql.compile() expects an arrow function or a string containing one — got ${ty}.`);
  }
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
        const expected = b.key === b.name ? b.key : `${b.key}' (bound to '${b.name}' in the function body)`;
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
 * Parse-and-validate any input shape `jsmql()` or `jsmql.compile()` accepts.
 * Returns a `ValidationResult` with structured errors instead of throwing,
 * so callers can drive editor tooling, form validation, and similar use cases.
 *
 * The overload set is the union of `jsmql.compile`'s and `jsmql()`'s — the
 * compile-form arrow comes first so IDEs contextually type `({ minAge }, $)`
 * against `(params: P, $: any, ops: JsmqlOps)` rather than the one-shot
 * `($: any, ops: JsmqlOps)` shape (which would mis-type the second slot as
 * `JsmqlOps`).
 */
function validateInput<P extends Record<string, unknown>>(fn: JsmqlCompileFn<P>): ValidationResult;
function validateInput(input: JsmqlInput): ValidationResult;
function validateInput(strings: TemplateStringsArray, ...values: unknown[]): ValidationResult;
function validateInput(
  // The implementation signature must be assignable from every overload, so it
  // widens to include the compile-form arrow shape (`JsmqlCompileFn<any>`)
  // alongside `JsmqlInput` and the template-tag array. The compile-form arrow
  // doesn't fit `JsmqlInput`'s `JsmqlFn = ($: any, ops: JsmqlOps) => unknown`
  // shape because its first slot is the params destructure, not `$`.
  input: JsmqlInput | TemplateStringsArray | JsmqlCompileFn<any>,
  ...values: unknown[]
): ValidationResult {
  try {
    if (isTemplateStringsArray(input)) {
      jsmql(input, ...values);
    } else if (typeof input === "function") {
      // Inline the function-input path here (instead of delegating to
      // `jsmql(input)`) so compile-form arrows — those carrying a params
      // destructure — are accepted for validation. `jsmqlDispatch` rejects
      // them outright in the one-shot path; validate is the structured-result
      // surface for both shapes, so it parses the arrow and binds null
      // placeholders for each declared binding so codegen resolves them as
      // ParamRefs (the values don't affect validation, only their resolution).
      const src = Function.prototype.toString.call(input).trim();
      try {
        const { program, bindings } = new Parser(src).parseFunctionInput();
        const resolved = new Map<string, unknown>();
        for (const b of bindings) resolved.set(b.name, null);
        const ctx = withBindings(EMPTY_CTX, resolved);
        lowerWithCtx(program, ctx);
      } catch (err) {
        // Mirror `jsmqlDispatch`'s function-input branch: any error from the
        // arrow path (parse OR codegen) goes through `augmentForFunctionInput`
        // so unknown-identifier errors get the closure-ref / param-binding
        // template-tag hint appended.
        throw augmentForFunctionInput(err);
      }
    } else {
      jsmql(input);
    }
    return { valid: true, errors: [] };
  } catch (err) {
    return errorToValidationResult(err);
  }
}

// `jsmql` is exposed as a callable with three attached properties:
//   - `jsmql.compile`  — parameterised, reusable Filter / Pipeline builder
//   - `jsmql.validate` — structured-result form of `jsmql()`
//   - `jsmql.expr`     — compile a partial / "unfinished" aggregation expression
//                        (the shape that goes inside `$project`, `$addFields`,
//                        `db.coll.updateOne(filter, update)`, etc.)
// The strippable-TS rule (see src/CLAUDE.md) forbids `namespace` declarations,
// so we build the shape with `Object.assign` and an explicit intersection type.
type Jsmql = typeof jsmqlDispatch & {
  compile: typeof compileFunction;
  validate: typeof validateInput;
  expr: typeof exprDispatch;
};

export const jsmql: Jsmql = Object.assign(jsmqlDispatch, {
  compile: compileFunction,
  validate: validateInput,
  expr: exprDispatch,
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
    throw new JsmqlInterpolationError(`jsmql ${where} could not be serialised: ${reason}`, slot, key);
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
 * Lower a parsed `Program` to its MQL output. Parametric on a single
 * `lowerExpr` callback that handles the bare-expression branch; the three
 * other branches (Pipeline / UpdateFilter / array-literal Pipeline) are
 * shared between `jsmql()` (Filter) and `jsmql.expr()` (aggregation
 * expression). Less code = better DX inside the codebase too.
 *
 * Dispatch rule (semicolon-driven), using the Node.js MongoDB driver's
 * official terminology — Filter for `db.coll.find(filter)`, Pipeline for
 * `db.coll.aggregate(pipeline)`:
 *   - `;`-separated statements → `Pipeline` AST → Pipeline (stage array).
 *   - UpdateOp chain (`$.a = 1, $.b = 2`) → update op program (set/unset stages).
 *   - Top-level array literal of stage shapes → legacy Pipeline form.
 *   - Single expression (no `;`) → caller-supplied `lowerExpr` decides:
 *     `jsmql()` lowers to a Filter, `jsmql.expr()` to a raw aggregation
 *     expression.
 */
type ExprLowering = (ast: Expr, ctx: GenerateCtx) => object;

function lowerProgram(ast: Program, ctx: GenerateCtx, lowerExpr: ExprLowering): JsmqlOutput {
  if (ast.type === "Pipeline") return generateImplicitPipeline(ast, ctx);
  if (ast.type === "UpdateFilter") return generateUpdateFilter(ast, ctx);
  if (isPipelineAst(ast)) return generatePipeline(ast, ctx);
  return lowerExpr(ast, ctx);
}

/** Filter-mode lowering: `jsmql()` and `jsmql.compile()` both go through this. */
function lowerWithCtx(ast: Program, ctx: GenerateCtx): JsmqlOutput {
  return lowerProgram(ast, ctx, generateFilter);
}

/** Expression-mode lowering: `jsmql.expr()` goes through this. */
function lowerExprWithCtx(ast: Program, ctx: GenerateCtx): JsmqlOutput {
  return lowerProgram(ast, ctx, (e, c) => generateWithCtx(e, c) as object);
}

/**
 * Lower a single expression AST to a MongoDB **Filter** (the document passed
 * as the first argument to `db.coll.find(filter)`).
 *
 * Reuses the same translator that `$match` uses inside a Pipeline
 * (`translateMatchBody`): translatable conjuncts emit indexable `{ field: ... }`
 * pairs; an untranslatable residual is wrapped in `$expr`, which is a legal
 * top-level Filter operator. So both predicates (`$.age > 18` →
 * `{ age: { $gt: 18 } }`) and non-predicate expressions
 * (`$abs(42)` → `{ $expr: { $abs: 42 } }`) produce a valid Filter document.
 *
 * Before lowering, a DX guard rejects bare stage-call inputs (`$match(...)`,
 * `$project(...)`, …) without a `;` — those are almost certainly Pipeline
 * intent where the user forgot the semicolon, and silently wrapping them in
 * `$expr` would produce a useless Filter. The guard throws a precise error
 * naming the stage and suggesting the missing `;`.
 */
function generateFilter(ast: Expr, ctx: GenerateCtx): object {
  const stageName = detectStageIntent(ast);
  if (stageName !== null) {
    throw new CodegenError(
      `\`${stageName}\` is a Pipeline stage, but the input has no \`;\` so ` +
        `jsmql would lower it as a Filter — almost certainly not what you want. ` +
        `Add a trailing \`;\` to make this a Pipeline: \`${stageName}(…);\`.`,
      ast.pos,
    );
  }
  const t = translateMatchBody(ast, { bindings: ctx.bindings });
  if (t.residual === null) return t.query;
  const exprPart = { $expr: generateWithCtx(t.residual, ctx) };
  if (Object.keys(t.query).length === 0) return exprPart;
  return { ...t.query, ...exprPart };
}

/**
 * Recognise the two shapes a Pipeline stage takes at the top level: a stage
 * **call** (`$match(...)`, `$project(...)`) and a stage **object** literal
 * (`{ $match: ... }`, the form MongoDB Compass copy-paste produces). Returns
 * the stage name when matched, null otherwise. Used by `generateFilter` to
 * catch the "forgot the `;`" case before the silent `$expr` wrap fires.
 */
function detectStageIntent(ast: Expr): string | null {
  if (ast.type === "OperatorCall" && lookupStage(ast.name) !== undefined) {
    return ast.name;
  }
  if (ast.type === "ObjectLiteral" && ast.entries.length === 1) {
    const entry = ast.entries[0];
    if (entry.type === "KeyValueEntry" && entry.key.kind === "static" && lookupStage(entry.key.name) !== undefined) {
      return entry.key.name;
    }
  }
  return null;
}

function lower(ast: Program): JsmqlOutput {
  return lowerWithCtx(ast, EMPTY_CTX);
}

function lowerExpr(ast: Program): JsmqlOutput {
  return lowerExprWithCtx(ast, EMPTY_CTX);
}

/**
 * Map a thrown error to the structured `ValidationResult` shape. Kept as a
 * standalone helper so the per-error-class branch table lives in one place,
 * which keeps the contract on `jsmql.validate()` stable as new error types
 * are introduced over time.
 */
function errorToValidationResult(err: unknown): ValidationResult {
  if (err instanceof ParseError || err instanceof LexError) {
    return { valid: false, errors: [{ message: err.message, pos: err.pos, code: "SYNTAX_ERROR" }] };
  }
  if (err instanceof CodegenError) {
    return { valid: false, errors: [{ message: err.message, pos: err.pos, code: "CODEGEN_ERROR" }] };
  }
  if (err instanceof FunctionInputError) {
    return { valid: false, errors: [{ message: err.message, pos: err.pos, code: "SYNTAX_ERROR" }] };
  }
  // JsmqlInterpolationError carries `.slot` (1-based interpolation index) and
  // optionally `.key` (param name) instead of a source offset — there is no
  // single byte offset in the template-tag form because the template's text
  // lives across the `strings`/`values` arrays. Callers needing to locate the
  // failing interpolation should read `.slot` / `.key` on the error directly.
  if (err instanceof JsmqlInterpolationError) {
    return { valid: false, errors: [{ message: err.message, pos: 0, code: "SYNTAX_ERROR" }] };
  }
  // RangeError is what V8 throws on stack overflow — caused by input shape,
  // so it belongs in the SYNTAX_ERROR bucket. Should be unreachable in
  // practice now that the parser/codegen depth limits trip first, but keep
  // the catch as a belt-and-braces safeguard. TypeError lands here too: it
  // comes from `jsmql()`'s top-level guard rejecting a wrong-shape input,
  // which is a "your input is wrong" failure from the caller's perspective.
  if (err instanceof RangeError || err instanceof TypeError) {
    return { valid: false, errors: [{ message: err.message, pos: 0, code: "SYNTAX_ERROR" }] };
  }
  // validate() promises never to throw — anything else gets wrapped as a
  // generic CODEGEN_ERROR so the caller can rely on the structured-result
  // contract. The original message is preserved for debugging.
  const message = err instanceof Error ? err.message : String(err);
  return { valid: false, errors: [{ message: `internal error: ${message}`, pos: 0, code: "CODEGEN_ERROR" }] };
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
