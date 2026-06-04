import { Parser, ParseError, FunctionInputError, type FunctionInputResult } from "./parser.ts";
import {
  generate,
  generateUpdateFilter,
  generateWithCtx,
  tryRewriteMutatorCall,
  CodegenError,
  EMPTY_CTX,
  UnknownIdentifierError,
  withBindings,
  isOpaqueBsonValue,
  type GenerateCtx,
} from "./codegen.ts";
import { isPipelineAst, generatePipeline, generateImplicitPipeline } from "./pipeline.ts";
import { translateMatchBody, mergeTranslatedQuery } from "./match-translation.ts";
import { lookupStage } from "./stages.ts";
import { LexError } from "./lexer.ts";
import { containsLookupCall } from "./lookup-translation.ts";
import { containsUnionPush, detectUnionPush } from "./union-translation.ts";
import { containsOutAssign } from "./out-translation.ts";
import { isSystemStageCall } from "./system-stage-translation.ts";
import type { Program, Expr, Pipeline } from "./ast.ts";

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

/** An arrow-function input's source text (its `.toString()`), trimmed. */
function fnSource(fn: (...args: never[]) => unknown): string {
  return Function.prototype.toString.call(fn).trim();
}

/**
 * Parse arrow-function source and run `body` on the `(program, bindings)`
 * result, routing any error — from the parse OR from whatever `body` does — through
 * `augmentForFunctionInput`, so closure-reference / param-binding errors pick up
 * the template-tag hint regardless of which entry point triggered them. The
 * one-shot (`jsmql()`) and `validate` paths wrap parse + lower together; `compile`
 * uses it parse-only (its lowering happens later, inside the returned closure).
 */
function withFunctionInput<T>(src: string, body: (parsed: FunctionInputResult) => T): T {
  try {
    return body(new Parser(src).parseFunctionInput());
  } catch (err) {
    throw augmentForFunctionInput(err);
  }
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
  lower: (program: Program, ctx: GenerateCtx) => JsmqlOutput,
): JsmqlOutput {
  if (isTemplateStringsArray(input)) {
    // Opaque BSON instances (Date, RegExp, Buffer, ObjectId) can't be embedded
    // as JSON literals — `JSON.stringify(new Date(...))` yields an ISO string,
    // `JSON.stringify(/x/)` yields `"{}"`. Route them through a synthesized
    // ParamRef binding instead, so the value reaches MQL output as-is. Plain
    // JSON-shaped values still go through `JSON.stringify` (unchanged).
    let src = "";
    const opaqueBindings = new Map<string, unknown>();
    for (let i = 0; i < input.length; i++) {
      src += input[i];
      if (i < values.length) {
        src += stringifyInterpolation(values[i], i + 1, opaqueBindings);
      }
    }
    const ctx = opaqueBindings.size > 0 ? withBindings(EMPTY_CTX, opaqueBindings) : EMPTY_CTX;
    return lower(new Parser(src).parse(), ctx);
  }
  if (typeof input === "function") {
    // The wrapper covers both parsing AND lowering: `augmentForFunctionInput`
    // must also fire when codegen throws an `UnknownIdentifierError` (closure
    // ref) mid-lowering, not only when the arrow itself fails to parse.
    return withFunctionInput(fnSource(input), ({ program, bindings }) => {
      if (bindings.length > 0) {
        throw new FunctionInputError(
          `${apiName}() in its one-shot form does not accept a parameter-bindings destructure. ` +
            "Use `jsmql.compile(fn)(params)` to supply values to a parameterised query, " +
            "or remove the destructure pattern from the arrow's first slot.",
        );
      }
      return lower(program, EMPTY_CTX);
    });
  }
  if (typeof input === "string") {
    return lower(new Parser(input).parse(), EMPTY_CTX);
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
  return dispatchInput(input, values, "jsmql", lowerWithCtx);
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
  return dispatchInput(input, values, "jsmql.expr", lowerExprWithCtx);
}

/**
 * `jsmql.filter(input)` — compile to a Filter document only.
 *
 * Same three input shapes as `jsmql()` (string / arrow / template tag), but
 * rejects any input that would lower to a Pipeline. Use this when the call
 * site is `db.coll.find(filter)` (or `deleteOne` / `countDocuments` / etc.)
 * and you want a compile-time guarantee that you won't accidentally hand the
 * driver a stage array. `jsmql()` is the polymorphic counterpart — call it
 * when the same source string might legitimately produce either shape.
 *
 * Pipeline-shaped inputs that throw here: `;`-separated statements, update-op
 * chains (`$.x = …`, `delete $.x`), top-level stage calls (`$match(...)`),
 * single-key stage-object literals (`{ $match: ... }`), and array-literal
 * Pipelines (`[{ $stage: ... }, ...]`). Each error names the shape it found
 * and suggests the right call (`jsmql.pipeline()`, `jsmql.update()`,
 * `jsmql()`).
 */
function filterDispatch(input: JsmqlInput): object;
function filterDispatch(strings: TemplateStringsArray, ...values: unknown[]): object;
function filterDispatch(input: JsmqlInput | TemplateStringsArray, ...values: unknown[]): object {
  return dispatchInput(input, values, "jsmql.filter", lowerFilterStrict) as object;
}

/**
 * `jsmql.pipeline(input)` — compile to a Pipeline (stage array) only.
 *
 * Same three input shapes as `jsmql()`, but rejects any bare expression that
 * would lower to a Filter document. Use this when the call site is
 * `db.coll.aggregate(pipeline)` and you want a compile-time guarantee that
 * you won't accidentally hand the driver a single document where it expects
 * a stage array. Accepts every shape that already produces a Pipeline through
 * `jsmql()`:
 *
 *   - `;`-separated statements
 *   - a single top-level stage call (`$match(...)`) — auto-wraps to one stage
 *   - a single stage-object literal (`{ $match: ... }`) — auto-wraps too
 *   - update-op chains (`$.x = …`) — compile to `$set` / `$unset` stages
 *   - array-literal Pipelines (`[{ $stage: ... }, ...]`)
 *
 * A bare expression like `$.age > 18` throws — the error suggests `jsmql.filter()`
 * if you wanted a Filter, or wrapping in `$match(...)` to make it a Pipeline.
 */
function pipelineDispatch(input: JsmqlInput): object[];
function pipelineDispatch(strings: TemplateStringsArray, ...values: unknown[]): object[];
function pipelineDispatch(input: JsmqlInput | TemplateStringsArray, ...values: unknown[]): object[] {
  return dispatchInput(input, values, "jsmql.pipeline", lowerPipelineStrict) as object[];
}

/**
 * `jsmql.update(input)` — compile to an aggregation-pipeline update (the
 * second argument to `db.coll.updateOne(filter, update)` /
 * `db.coll.updateMany(filter, update)` in its array form, called an
 * `UpdateFilter` in the Node.js MongoDB driver's typings).
 *
 * The shorter public name (`update` rather than `updateFilter`) avoids the
 * trap where developers read "filter" as the *query* document — the first
 * argument to `updateOne(filter, update)` — and reach for this when they
 * meant `jsmql.filter()`. The MongoDB driver type stays `UpdateFilter<T>`;
 * we just don't repeat the confusing half of its name in the function.
 *
 * Output is always a stage array, never the legacy bare-document update form
 * — that form silently treats RHS expressions as object literals, which is
 * exactly the kind of footgun this entry point exists to avoid. Passing this
 * to the driver guarantees that expressions like `$.name.toUpperCase()`
 * evaluate server-side instead of landing in the document as the literal
 * object `{ $toUpper: "$name" }`.
 *
 * Accepts the same Pipeline-shaped inputs as `jsmql.pipeline()`, but
 * additionally rejects any stage outside MongoDB's update-pipeline whitelist
 * (`$addFields`, `$set`, `$project`, `$unset`, `$replaceRoot`, `$replaceWith`).
 * If you write `$match` or `$sort` inside an update pipeline, MongoDB rejects
 * it at runtime with a generic error; this entry point catches it at compile
 * time and names the offending stage.
 */
function updateDispatch(input: JsmqlInput): object[];
function updateDispatch(strings: TemplateStringsArray, ...values: unknown[]): object[];
function updateDispatch(input: JsmqlInput | TemplateStringsArray, ...values: unknown[]): object[] {
  return dispatchInput(input, values, "jsmql.update", lowerUpdateStrict) as object[];
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
    src = fnSource(input);
  } else if (typeof input === "string") {
    src = input.trim();
  } else {
    const ty = input === null ? "null" : typeof input;
    throw new TypeError(`jsmql.compile() expects an arrow function or a string containing one — got ${ty}.`);
  }
  // Parse-only: lowering happens later, inside the returned closure (it needs
  // the per-call params), so only the parse runs under the function-input augment.
  const { program, bindings } = withFunctionInput(src, (r) => r);
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
      // Mirror `jsmqlDispatch`'s function-input branch (parse + lower under the
      // same augment), but bind each declared binding to a null placeholder so
      // codegen resolves the ParamRefs — the values don't affect validation.
      withFunctionInput(fnSource(input), ({ program, bindings }) => {
        const resolved = new Map<string, unknown>();
        for (const b of bindings) resolved.set(b.name, null);
        lowerWithCtx(program, withBindings(EMPTY_CTX, resolved));
      });
    } else {
      jsmql(input);
    }
    return { valid: true, errors: [] };
  } catch (err) {
    return errorToValidationResult(err);
  }
}

// `jsmql` is exposed as a callable with attached properties:
//   - `jsmql.compile`  — parameterised, reusable Filter / Pipeline builder
//   - `jsmql.validate` — structured-result form of `jsmql()`
//   - `jsmql.expr`     — compile a partial / "unfinished" aggregation expression
//                        (the shape that goes inside `$project`, `$addFields`,
//                        `db.coll.updateOne(filter, update)`, etc.)
//   - `jsmql.filter`   — strict-Filter form (throws on Pipeline-shaped input)
//   - `jsmql.pipeline` — strict-Pipeline form (throws on bare-expression input)
//   - `jsmql.update`   — strict aggregation-pipeline update (whitelists stages).
//                        Named `update` rather than `updateFilter` to avoid the
//                        "filter ≠ query doc" confusion at the call site; the
//                        underlying driver type is still `UpdateFilter<T>`.
// The strippable-TS rule (see src/CLAUDE.md) forbids `namespace` declarations,
// so we build the shape with `Object.assign` and an explicit intersection type.
type Jsmql = typeof jsmqlDispatch & {
  compile: typeof compileFunction;
  validate: typeof validateInput;
  expr: typeof exprDispatch;
  filter: typeof filterDispatch;
  pipeline: typeof pipelineDispatch;
  update: typeof updateDispatch;
};

export const jsmql: Jsmql = Object.assign(jsmqlDispatch, {
  compile: compileFunction,
  validate: validateInput,
  expr: exprDispatch,
  filter: filterDispatch,
  pipeline: pipelineDispatch,
  update: updateDispatch,
});

// Wrap JSON.stringify with the validation needed to keep the template-tag
// invocation of `jsmql` a safe boundary. Three failure modes that
// JSON.stringify quietly hides:
//   - returns `undefined` for unsupported value types (function/Symbol/the
//     literal `undefined`); concatenating that into the source produces the
//     bare text "undefined" which the parser then misreads as an identifier.
//   - silently coerces non-finite numbers to "null", losing the user's intent.
//   - throws TypeError for BigInt values and circular references.
//
// A fourth failure mode is fidelity loss: `JSON.stringify(new Date(...))`
// returns an ISO string (which BSON compares as a string, not a date),
// `JSON.stringify(/x/)` returns `"{}"`, etc. For opaque BSON instances —
// `Date`, `RegExp`, `Uint8Array`/Buffer, duck-typed `ObjectId` — the
// original JS instance is routed through a synthesized `ParamRef` binding
// so the MQL output carries it verbatim. Works at the top of an
// interpolation slot *and* arbitrarily deep inside an interpolated
// object/array — e.g. `jsmql\`… ${{ since: new Date(...) }}\`` keeps the
// nested Date as a Date.

// U+E000 is a Unicode Private Use Area code point — Unicode reserves these
// for private-use sentinels with no defined meaning, JSON.stringify passes
// them through unescaped, and they essentially never appear in real user
// data. Used to wrap an injected binding-name string so we can find-and-
// replace markers after JSON.stringify produces the source fragment.
const OPAQUE_INTERP_MARKER = "";

function stringifyInterpolation(value: unknown, slot: number, opaqueBindings: Map<string, unknown>): string {
  if (!containsOpaqueBsonAnywhere(value)) {
    // Fast path: pure JSON-shaped value. After validateInterpolatable, JSON.stringify
    // is guaranteed to produce a string (no `undefined` return, no throw, no silent
    // NaN→null coercion at top level).
    validateInterpolatable(value, slot);
    return JSON.stringify(value)!;
  }
  // Slow path: at least one opaque BSON instance lives somewhere in the value.
  // Substitute each instance with a marker string carrying a unique binding
  // name, JSON-stringify the rewritten tree (so the surrounding JSON-shaped
  // parts get the same serialization as the fast path), then replace the
  // markers in the output with bare identifiers — which the parser resolves
  // as `ParamRef`s and the binding map carries through to codegen.
  const state = { counter: 0, seen: new WeakSet<object>() };
  const substituted = substituteOpaqueValues(value, slot, opaqueBindings, state);
  // `substituted` is a pure-JSON tree (the original BSON instances replaced
  // with marker strings), so the existing validation still applies — non-
  // finite top-level numbers, circular references in the surviving structure,
  // BigInt anywhere, etc. all surface here.
  validateInterpolatable(substituted, slot);
  const jsonWithMarkers = JSON.stringify(substituted)!;
  // Each opaque value appears in the JSON output as `"<M><name><M>"` (JSON-
  // quoted because the substitute was a string). The lookup against the
  // bindings map disambiguates against the (theoretical) edge case of a user-
  // supplied string that happens to look like a marker pair around a known
  // binding name.
  const markerPattern = new RegExp(`"${OPAQUE_INTERP_MARKER}([A-Za-z_][A-Za-z0-9_]*)${OPAQUE_INTERP_MARKER}"`, "g");
  return jsonWithMarkers.replace(markerPattern, (match, name) => (opaqueBindings.has(name) ? name : match));
}

/**
 * True iff `value` is — or transitively contains — an opaque BSON instance.
 * Used to pick between the fast (pure-JSON) and slow (substitute-then-
 * stringify) interpolation paths. Cycle-safe: re-encountering a previously-
 * seen object returns `false`, leaving the cycle to be caught later by
 * JSON.stringify when either path runs.
 */
function containsOpaqueBsonAnywhere(value: unknown, seen?: WeakSet<object>): boolean {
  if (isOpaqueBsonValue(value)) return true;
  if (value === null || typeof value !== "object") return false;
  const s = seen ?? new WeakSet<object>();
  if (s.has(value)) return false;
  s.add(value);
  if (Array.isArray(value)) {
    for (const v of value) if (containsOpaqueBsonAnywhere(v, s)) return true;
    return false;
  }
  for (const v of Object.values(value)) if (containsOpaqueBsonAnywhere(v, s)) return true;
  return false;
}

/**
 * Walk `value`, replacing every opaque BSON instance with a marker string
 * carrying a freshly-allocated `__jsmql_interp_<slot>_<n>` binding name.
 * Records the original instance under that name in `bindings`. Plain JSON
 * values pass through unchanged so the surrounding tree retains the exact
 * shape JSON.stringify would have produced for the fast path.
 */
function substituteOpaqueValues(
  value: unknown,
  slot: number,
  bindings: Map<string, unknown>,
  state: { counter: number; seen: WeakSet<object> },
): unknown {
  if (isOpaqueBsonValue(value)) {
    state.counter += 1;
    const name = `__jsmql_interp_${slot}_${state.counter}`;
    bindings.set(name, value);
    return `${OPAQUE_INTERP_MARKER}${name}${OPAQUE_INTERP_MARKER}`;
  }
  if (value === null || typeof value !== "object") return value;
  // Cycle: return the value as-is so JSON.stringify surfaces the standard
  // "Converting circular structure to JSON" error (re-thrown as
  // `JsmqlInterpolationError` by `validateInterpolatable`).
  if (state.seen.has(value)) return value;
  state.seen.add(value);
  if (Array.isArray(value)) {
    return value.map((v) => substituteOpaqueValues(v, slot, bindings, state));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = substituteOpaqueValues(v, slot, bindings, state);
  }
  return out;
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
  // Top-level bare stage call (`$match(...)`, `$project(...)`, …) or single-key
  // stage-object literal (`{ $match: ... }` — the shape MongoDB Compass produces
  // when you copy/paste) is almost always Pipeline intent — the user wrote a
  // stage at the top level. Auto-wrap as a one-stage pipeline so
  // `jsmql("$match($.age > 18)")` produces `[{ $match: { age: { $gt: 18 } } }]`
  // with no `;` discipline required. Without this, the call would either
  // throw (the old behaviour) or silently produce `{ $expr: { $match: ... } }`
  // — a syntactically valid Filter that MongoDB can't execute.
  //
  // Re-uses the normal `generateImplicitPipeline` path so $match's
  // index-friendly query-translator runs unchanged, and so a stage that has
  // sub-pipeline fields (`$lookup`, `$unionWith`, `$facet`) recurses through
  // the same lowering it would inside a `;`-separated pipeline.
  //
  // `jsmql.expr()` doesn't get this wrap: a top-level stage call passed to
  // `jsmql.expr()` is unusual enough (stages aren't aggregation expressions)
  // that the user almost certainly meant something else, and silently routing
  // through Pipeline mode there would mask the mistake.
  if (
    ast.type !== "Pipeline" &&
    ast.type !== "UpdateFilter" &&
    !isPipelineAst(ast) &&
    detectStageIntent(ast) !== null
  ) {
    const synthetic: Pipeline = { type: "Pipeline", stmts: [ast], pos: ast.pos };
    return generateImplicitPipeline(synthetic, ctx);
  }
  // Top-level `$$.<method>(...)` always lowers as a Pipeline statement.
  // `$$.push(...)` emits `$unionWith` stages; any other method surfaces a
  // precise "$$ only supports .push" error from the pipeline-level
  // `validateUnionPushShape` hook. `isSystemStageCall` extends the same
  // auto-wrap to the diagnostic source-stage sugar on every ref level —
  // `$$.indexStats()`, `$$$$.currentOp(...)`, `$$$$.shardedDataDistribution()`
  // — which `isCollectionMethodCall` (CollectionRef only) doesn't cover. In
  // every case: auto-wrap as a one-stage Pipeline so the user doesn't have to
  // add a trailing `;` to flip into Pipeline mode and doesn't see the generic
  // ref "statement-only" / "bare reference" error instead of the targeted one.
  if (
    ast.type !== "Pipeline" &&
    ast.type !== "UpdateFilter" &&
    !isPipelineAst(ast) &&
    (isCollectionMethodCall(ast as Expr) || isSystemStageCall(ast as Expr))
  ) {
    const synthetic: Pipeline = { type: "Pipeline", stmts: [ast], pos: ast.pos };
    return generateImplicitPipeline(synthetic, ctx);
  }
  // Top-level mutating array method on a writable field-path receiver
  // (`$.events.push(x)`, `$.events.sort(e => e.t)`, …) without a trailing `;`.
  // Same reasoning as the `$$.<method>(...)` and stage-call auto-wraps above:
  // the user has written a statement that only makes sense as a single
  // Pipeline stage, so route it through Pipeline mode where the mutator
  // rewrite materialises the assignment. Without this, the bare-expression
  // path would reach the codegen mutator throw with its "use the immutable
  // variant" hint — wrong message for a clearly statement-shaped call.
  // Not done for `jsmql.expr()`: the raw-expression entry point is for
  // building blocks that get embedded inside an outer stage, where the
  // mutator throw is the correct error.
  if (ast.type !== "Pipeline" && ast.type !== "UpdateFilter" && !isPipelineAst(ast)) {
    const rewrite = tryRewriteMutatorCall(ast as Expr);
    if (rewrite.kind === "rewrite") {
      const synthetic: Pipeline = { type: "Pipeline", stmts: [ast], pos: ast.pos };
      return generateImplicitPipeline(synthetic, ctx);
    }
  }
  // An UpdateFilter whose RHS contains lookup syntax can't go through the
  // bare-doc `generateUpdateFilter` path — that lowerer doesn't see lookups
  // and would reach the `DatabaseRef` / `ClusterRef` codegen case and throw
  // the wrong error. Wrap as a synthetic single-stmt Pipeline so the lookup-
  // aware pipeline integration in `pipeline.ts` intercepts the assignment-RHS
  // lookup. This is the path that lights up `jsmql.compile(({ coll }, $) =>
  // ($.x = $$$[coll].find(...)))` — a single-stmt arrow body parses as an
  // UpdateFilter, not a Pipeline, and without this reroute the bound bracket
  // index would never reach the lookup translator.
  if (ast.type === "UpdateFilter" && containsLookupCall(ast, ctx)) {
    const synthetic: Pipeline = { type: "Pipeline", stmts: [ast], pos: ast.pos };
    return generateImplicitPipeline(synthetic, ctx);
  }
  // An UpdateFilter whose LHS is the `$out` sugar shape (`$$$.<coll> = …`,
  // `$$$$.<db>.<coll> = …`) follows the same reroute logic as the lookup
  // case: the bare-doc `generateUpdateFilter` path doesn't know about
  // `$out` lowering and would surface the generic `DatabaseRef` / `ClusterRef`
  // bare-reference error. Wrap as a one-stmt Pipeline so the pipeline
  // integration in `pipeline.ts` recognises and lowers the `$out`.
  if (ast.type === "UpdateFilter" && containsOutAssign(ast)) {
    const synthetic: Pipeline = { type: "Pipeline", stmts: [ast], pos: ast.pos };
    return generateImplicitPipeline(synthetic, ctx);
  }
  // Lookup syntax in the bare-expression branch (no `;`, no stage call, no
  // update op): would produce a stray `DatabaseRef` / `ClusterRef` error.
  // Catch it here so the message points at the right shape — add a `;` (or
  // any update op / let / stage call) to flip into Pipeline mode.
  if (
    ast.type !== "Pipeline" &&
    ast.type !== "UpdateFilter" &&
    !isPipelineAst(ast) &&
    detectStageIntent(ast) === null &&
    containsLookupCall(ast, ctx)
  ) {
    throw new CodegenError(
      "Lookup syntax ('$$$.<coll>.find/filter(...)') requires Pipeline mode. " +
        "Assign the lookup to a field (`$.x = $$$.coll.find(...)`) or wrap in a let / pipeline statement, " +
        "and ensure the source has at least one `;` so jsmql routes through Pipeline lowering.",
      ast.pos,
    );
  }
  const result = lowerProgram(ast, ctx, generateFilter);
  // Update-filter inputs that compile to a single stage (`{ $set: { …RHS… } }`
  // or `{ $unset: "x" }`) get wrapped into a one-element pipeline at the
  // `jsmql()` entry point. Rationale: the second argument to
  // `db.coll.updateOne(filter, update)` is treated by MongoDB as an
  // **aggregation pipeline** only when it's an array — the bare-document form
  // treats every value as a literal, so a computed RHS like `$.name.toUpperCase()`
  // would silently land in the document as the object `{ $toUpper: "$name" }`
  // instead of evaluating. Always returning an array from `jsmql()` makes the
  // call site `db.coll.updateOne({…}, jsmql(…))` work safely regardless of
  // whether the RHS happens to be a literal or an expression. Callers who
  // explicitly want the bare update-document shape (e.g. for embedding inside
  // a hand-written pipeline stage body) use `jsmql.expr()` — `lowerExprWithCtx`
  // intentionally does not wrap.
  if (ast.type === "UpdateFilter" && !Array.isArray(result)) {
    return [result];
  }
  return result;
}

/** Expression-mode lowering: `jsmql.expr()` goes through this. */
function lowerExprWithCtx(ast: Program, ctx: GenerateCtx): JsmqlOutput {
  rejectLookupOutsidePipeline(ast, "jsmql.expr", ctx);
  rejectUnionPushOutsidePipeline(ast, "jsmql.expr");
  rejectOutOutsidePipeline(ast, "jsmql.expr");
  // No array-wrap for update-filter output (see `lowerWithCtx` comment): the
  // caller asked for a raw building block, the bare `{ $set: … }` shape is
  // exactly what fits inside a hand-written `$set` / `$addFields` stage or
  // gets passed to a doc-form update operation that wants literal semantics.
  return lowerProgram(ast, ctx, (e, c) => generateWithCtx(e, c) as object);
}

/**
 * Strict Filter-mode lowering: `jsmql.filter()` goes through this.
 *
 * Every Pipeline-shaped input that `jsmql()` would auto-route to Pipeline
 * mode throws here instead, with a message naming the shape that was found
 * and pointing at the right alternative entry point. The accepted branch is
 * exactly the bare-expression path of `lowerWithCtx`, lowered through
 * `generateFilter` (same engine, same indexable-conjunct translation, same
 * `$expr` fallback for the untranslatable residual).
 */
function lowerFilterStrict(ast: Program, ctx: GenerateCtx): JsmqlOutput {
  rejectLookupOutsidePipeline(ast, "jsmql.filter", ctx);
  rejectUnionPushOutsidePipeline(ast, "jsmql.filter");
  rejectOutOutsidePipeline(ast, "jsmql.filter");
  if (ast.type === "Pipeline") {
    throw new CodegenError(
      "jsmql.filter() expects a Filter (the document `db.coll.find(filter)` takes), but received a `;`-separated Pipeline. " +
        "Drop the `;` to compose a Filter, or call jsmql.pipeline() / jsmql() for Pipeline output.",
      ast.pos,
    );
  }
  if (ast.type === "UpdateFilter") {
    throw new CodegenError(
      "jsmql.filter() expects a Filter, but received an update-op chain (e.g. `$.x = …`, `delete $.x`). " +
        "Update-op chains compile to `$set` / `$unset` stages — call jsmql.update() or jsmql() for the Pipeline form.",
      ast.pos,
    );
  }
  if (isPipelineAst(ast)) {
    throw new CodegenError(
      "jsmql.filter() expects a Filter, but received a Pipeline array (`[{ $stage: ... }, ...]`). " +
        "Call jsmql.pipeline() or jsmql() for Pipeline output.",
      ast.pos,
    );
  }
  const stageName = detectStageIntent(ast);
  if (stageName !== null) {
    const hint =
      stageName === "$match"
        ? " — or, if you wanted a Filter, drop the `$match(...)` wrapper and pass the predicate directly to jsmql.filter()."
        : ".";
    throw new CodegenError(
      `jsmql.filter() expects a Filter, but received a top-level '${stageName}' stage call. ` +
        `Call jsmql.pipeline() or jsmql() for Pipeline output${hint}`,
      ast.pos,
    );
  }
  return generateFilter(ast, ctx);
}

/** Strict Pipeline-mode lowering: `jsmql.pipeline()` goes through this. */
function lowerPipelineStrict(ast: Program, ctx: GenerateCtx): JsmqlOutput {
  return lowerToPipelineStages(ast, ctx, "jsmql.pipeline");
}

/**
 * Aggregation-pipeline update lowering: `jsmql.update()` goes through this.
 * Reuses `lowerToPipelineStages` to share the bare-expression rejection with
 * `jsmql.pipeline()`, then enforces the update-pipeline stage whitelist so a
 * stage MongoDB would refuse at runtime (`$match`, `$sort`, `$group`, …)
 * gets caught at compile time with the offending name in the message.
 *
 * (The internal name keeps `Update` rather than `UpdateFilter` to match the
 * public API. The AST node type is still `UpdateFilter` — that's a parser
 * concept, not an API concept, and matches the MongoDB driver's typings.)
 */
function lowerUpdateStrict(ast: Program, ctx: GenerateCtx): JsmqlOutput {
  // MongoDB's update-pipeline form whitelists only $addFields/$set, $project/$unset,
  // $replaceRoot/$replaceWith — $lookup isn't in that list (it's documented as
  // disallowed on every update method's reference page). Catching the lookup
  // syntax pre-codegen gives a message that names the right entry point instead
  // of the generic "rejected '$lookup'" produced by the downstream whitelist.
  if (containsLookupCall(ast, ctx)) {
    throw new CodegenError(
      "jsmql.update() does not allow lookup syntax ('$$$.<coll>.find/filter(...)'): MongoDB's aggregation-pipeline update form only accepts " +
        Array.from(UPDATE_PIPELINE_STAGES).sort().join(", ") +
        ". Run the lookup in a regular aggregation pipeline (jsmql.pipeline()) and apply updates separately.",
      ast.pos,
    );
  }
  if (containsUnionPush(ast)) {
    throw new CodegenError(
      "jsmql.update() does not allow '$$.push(...)' (collection union): MongoDB's aggregation-pipeline update form only accepts " +
        Array.from(UPDATE_PIPELINE_STAGES).sort().join(", ") +
        ". Run the union in a regular aggregation pipeline (jsmql.pipeline()) — '$unionWith' isn't allowed inside an update.",
      ast.pos,
    );
  }
  const stages = lowerToPipelineStages(ast, ctx, "jsmql.update");
  for (let i = 0; i < stages.length; i++) {
    const stageName = Object.keys(stages[i] as Record<string, unknown>)[0];
    if (!UPDATE_PIPELINE_STAGES.has(stageName)) {
      const allowed = Array.from(UPDATE_PIPELINE_STAGES).sort().join(", ");
      throw new CodegenError(
        `jsmql.update() rejected '${stageName}' (stage ${i}): MongoDB's aggregation-pipeline update form only accepts ${allowed}. ` +
          `Use jsmql.pipeline() if you need other stages.`,
        ast.pos,
      );
    }
  }
  return stages;
}

/**
 * Lookup syntax (`$$$.<coll>.find/filter(...)`) requires Pipeline mode —
 * the lowering emits `$lookup` (+ follow-up) stages. Filter mode /
 * `jsmql.expr` would just see a stray `DatabaseRef` and surface the
 * generic bare-reference error; this pre-gate gives a precise message
 * naming the right entry point instead.
 */
function rejectLookupOutsidePipeline(ast: Program, apiName: string, ctx: GenerateCtx): void {
  if (containsLookupCall(ast, ctx)) {
    throw new CodegenError(
      `${apiName}() does not allow lookup syntax ('$$$.<coll>.find/filter(...)') — joins are Pipeline-only. ` +
        "Use jsmql() (in Pipeline mode) or jsmql.pipeline() for cross-collection queries.",
      ast.pos,
    );
  }
}

/**
 * Union-push syntax (`$$.push(...)`) is statement-only and lowers to
 * `$unionWith` stages — Pipeline-mode-only. Filter mode / `jsmql.expr` /
 * `jsmql.update` reject it at a pre-codegen pass so the error names the
 * right entry point and the right shape (`$unionWith` isn't even in the
 * update-pipeline whitelist).
 */
function rejectUnionPushOutsidePipeline(ast: Program, apiName: string): void {
  if (containsUnionPush(ast)) {
    throw new CodegenError(
      `${apiName}() does not allow '$$.push(...)' — collection unions are Pipeline-only. ` +
        "Use jsmql() (in Pipeline mode) or jsmql.pipeline() to compose '$unionWith' stages.",
      ast.pos,
    );
  }
}

/**
 * `$out` sugar (`$$$.<coll> = …`, `$$$$.<db>.<coll> = …`) is Pipeline-only —
 * the assignment lowers to a `$out` stage. Filter / `jsmql.expr` would see
 * a stray `DatabaseRef` / `ClusterRef` LHS and surface the generic bare-
 * reference error; this pre-gate gives a precise "use Pipeline mode" message
 * naming the right entry point.
 */
function rejectOutOutsidePipeline(ast: Program, apiName: string): void {
  if (containsOutAssign(ast)) {
    throw new CodegenError(
      `${apiName}() does not allow '$out' sugar ('$$$.<coll> = …' / '$$$$.<db>.<coll> = …') — '$out' is a pipeline stage. ` +
        "Use jsmql() (in Pipeline mode — add ';' or wrap in a stage array) or jsmql.pipeline() to compose '$out' stages.",
      ast.pos,
    );
  }
}

/**
 * Shared body of `jsmql.pipeline()` and `jsmql.update()`: route every
 * Pipeline-shape branch to its existing lowerer and throw an actionable error
 * for a bare expression (the only input shape `jsmql()` would have routed to
 * Filter mode). `apiName` is interpolated into the error so the message
 * names the actual entry point the user called.
 */
function lowerToPipelineStages(ast: Program, ctx: GenerateCtx, apiName: string): object[] {
  if (ast.type === "Pipeline") return generateImplicitPipeline(ast, ctx) as object[];
  if (ast.type === "UpdateFilter") {
    // `$out` sugar (`$$$.<coll> = …`) inside an UpdateFilter must go through
    // pipeline lowering — `generateUpdateFilter` doesn't know about it. Reroute
    // the same way `lowerWithCtx` does for the implicit `jsmql()` entry.
    if (containsOutAssign(ast)) {
      const synthetic: Pipeline = { type: "Pipeline", stmts: [ast], pos: ast.pos };
      return generateImplicitPipeline(synthetic, ctx) as object[];
    }
    const result = generateUpdateFilter(ast, ctx);
    return Array.isArray(result) ? result : [result];
  }
  if (isPipelineAst(ast)) return generatePipeline(ast, ctx) as object[];
  // A bare stage call (`$match(...)`) or a diagnostic source-stage sugar
  // (`$$.indexStats()`, `$$$$.currentOp(...)`, `$$$$.shardedDataDistribution()`)
  // is a one-stage Pipeline — wrap it so the user needn't add a trailing `;`.
  if (detectStageIntent(ast) !== null || isSystemStageCall(ast as Expr)) {
    const synthetic: Pipeline = { type: "Pipeline", stmts: [ast], pos: ast.pos };
    return generateImplicitPipeline(synthetic, ctx) as object[];
  }
  throw new CodegenError(
    `${apiName}() expects a Pipeline (one or more aggregation stages — \`;\`-separated, a top-level stage call, or a stage-array literal), ` +
      `but received a bare expression that would lower to a Filter document. ` +
      `Call jsmql.filter() or jsmql() for Filter output, or wrap the predicate as \`$match(...)\` to make it a Pipeline.`,
    ast.pos,
  );
}

/**
 * The stages MongoDB allows inside an aggregation-pipeline update (the array
 * form of the second argument to `db.coll.updateOne` / `updateMany`). Any
 * stage outside this set is rejected by the server at runtime; `jsmql.update()`
 * catches it at compile time. See
 * https://www.mongodb.com/docs/manual/reference/method/db.collection.updateOne/#update-with-aggregation-pipeline.
 */
const UPDATE_PIPELINE_STAGES = new Set<string>([
  "$addFields",
  "$project",
  "$replaceRoot",
  "$replaceWith",
  "$set",
  "$unset",
]);

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
 * Stage-intent shapes (`$match(...)`, `{ $match: ... }`, …) never reach this
 * function — they are caught in `lowerWithCtx` and routed through
 * `generateImplicitPipeline` so the user sees an auto-wrapped one-stage
 * Pipeline instead of a useless `{ $expr: { $match: ... } }` Filter.
 */
function generateFilter(ast: Expr, ctx: GenerateCtx): object {
  const t = translateMatchBody(ast, { bindings: ctx.bindings });
  // `?? {}`: a vacuous predicate yields the empty (match-everything) Filter.
  // The standalone-Filter `$expr` residual built by `mergeTranslatedQuery` runs
  // WITHOUT `pipelineContext`, so `$`-string literals here stay `$literal`-wrapped
  // (unlike a `$match` *inside* a pipeline, which passes them through — a
  // `db.coll.find(filter)` is neither a pipeline nor `jsmql.expr`).
  // Unifying the two is deferred [DEF-025] — see docs/DEFERRED.md.
  return mergeTranslatedQuery(t, ctx) ?? {};
}

/**
 * Recognise the two shapes a Pipeline stage takes at the top level: a stage
 * **call** (`$match(...)`, `$project(...)`) and a stage **object** literal
 * (`{ $match: ... }`, the form MongoDB Compass copy-paste produces). Returns
 * the stage name when matched, null otherwise. Used by `generateFilter` to
 * catch the "forgot the `;`" case before the silent `$expr` wrap fires.
 */
/**
 * Top-level `$$.<method>(...)` is always a Pipeline statement (currently the
 * only supported method is `.push`, lowering to `$unionWith`). Detecting any
 * method call on a `CollectionRef` receiver here lets the auto-wrap route the
 * input through Pipeline mode so the targeted "$$ only supports .push" error
 * surfaces from `validateUnionPushShape` instead of the generic CollectionRef
 * "statement-only" codegen throw.
 */
function isCollectionMethodCall(ast: Expr): boolean {
  return ast.type === "MethodCall" && ast.object.type === "CollectionRef";
}

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
