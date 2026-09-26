// The public API: the `jsmql` callable and its properties, polymorphic over the
// three call shapes — a string, an arrow, a template tag — and over the four
// shapes MQL takes: a Filter (`find`), a Pipeline (`aggregate`), a bare expression
// (`jsmql.expr`) and an update document (`jsmql.update`). Every entry runs the
// compiler in `src/compiler/` over the registry in `src/registry/`; this file
// only turns the caller's input into source and values, and the compiler's
// errors into `validate()` results. See docs/LANGUAGE.md and
// docs/specs/strict-shape-entries.md.
import { hasStreamValueCell } from "./compiler/rows.ts";
import type { Expr, ParamBinding, Program } from "./registry/ast.ts";
import { lex, LexError } from "./compiler/lex/lexer.ts";
import { parse, parseEntry } from "./compiler/parse/parser.ts";
import { ParseError } from "./compiler/parse/cursor.ts";
import { fold } from "./compiler/passes/fold.ts";
import { desugar } from "./compiler/passes/desugar.ts";
import { inject, replaceIdents, spellValue } from "./compiler/passes/inject.ts";
import { evaluate } from "./compiler/passes/evaluate.ts";
import { FILTER, STATEMENT, UPDATE_DOC, VALUE } from "./compiler/passes/position.ts";
import { isBareAssignWrite, shapeOf } from "./compiler/passes/shape.ts";
import { namedRow } from "./compiler/passes/naming.ts";
import { Env } from "./compiler/emit/env.ts";
import { lowerValue } from "./compiler/emit/lower.ts";
import { lowerFilter } from "./compiler/emit/filter.ts";
import { lowerProgram } from "./compiler/emit/statement.ts";
import { lowerUpdate } from "./compiler/emit/update.ts";
import { noStages } from "./compiler/emit/errors.ts";
import { CodegenError, UnknownIdentifierError } from "./errors.ts";
import { stringify } from "./stringify.ts";

export { CodegenError, UnknownIdentifierError, ParseError, LexError };
// The nine types the language can spell, re-exported from the peer `bson` so a caller
// who writes `import { ObjectId } from "@koresar/jsmql"` provably gets the copy jsmql
// resolved. See docs/specs/bson-types.md.
export { Decimal128, Double, Int32, Long, MaxKey, MinKey, ObjectId, UUID } from "./bson.ts";
import { bsonTagOf, isDate, isPlainObject, isRegExp } from "./bson.ts";

// ── the public types ─────────────────────────────────────────────────────────

export type ValidationError = { message: string; pos: number; code: "SYNTAX_ERROR" | "CODEGEN_ERROR" };
export type ValidationResult = { valid: boolean; errors: ValidationError[] };

/**
 * A template-tag slot or a compile parameter holds a value with no MQL
 * representation — `undefined`, a function, a symbol, NaN. `.pos` is 0: the
 * template form has no single source offset; `.slot` / `.key` locate the value.
 */
export class JsmqlInterpolationError extends Error {
  readonly pos = 0;
  readonly slot: number;
  readonly key: string | undefined;
  constructor(message: string, slot: number, key?: string) {
    super(message);
    this.name = "JsmqlInterpolationError";
    this.slot = slot;
    this.key = key;
  }
}

/** The arrow form's one-shot input carried a parameter destructure, or is not an arrow at all. */
export class FunctionInputError extends ParseError {
  constructor(message: string, pos = 0) {
    super(message, pos);
    this.name = "FunctionInputError";
  }
}

/** The toolbox an arrow destructures: `$`, `$$`, `$$$`, `$$$$` and every `$op`. */
export type JsmqlToolbox = { [K in `$${string}`]: any };
export type JsmqlFn = (toolbox: JsmqlToolbox) => unknown;
export type JsmqlInput = string | JsmqlFn;
export type JsmqlOutput = object | object[];
/** An arrow whose body is a block returns a Pipeline; an expression body may be either shape. */
export type JsmqlArrowOutput<F extends JsmqlFn> = [ReturnType<F>] extends [void] ? object[] : JsmqlOutput;
type JsmqlCompileFn<P> = (params: P, toolbox: JsmqlToolbox) => unknown;

type Mode = "auto" | "expr" | "filter" | "pipeline" | "update";
type Values = ReadonlyMap<string, unknown>;
const NONE: Values = new Map();

// ── input → source ───────────────────────────────────────────────────────────

function isTemplateStringsArray(x: unknown): x is TemplateStringsArray {
  return Array.isArray(x) && Array.isArray((x as { raw?: unknown }).raw);
}

const fnSource = (fn: (...args: never[]) => unknown): string => Function.prototype.toString.call(fn).trim();

/** Does the value contain itself? A plain object or array only; a Date or an ObjectId is a leaf. */
function isCircular(value: unknown, seen: WeakSet<object> = new WeakSet()): boolean {
  if (value === null || typeof value !== "object") return false;
  if (!Array.isArray(value) && !isPlainObject(value)) return false;
  if (seen.has(value)) return true;
  seen.add(value);
  const children = Array.isArray(value) ? value : Object.values(value);
  const inside = children.some((v) => isCircular(v, seen));
  seen.delete(value);
  return inside;
}

/**
 * A value a slot or a parameter may carry: anything the driver can send.
 *
 * The check RECURSES, because a value with no MQL representation has no MQL
 * representation one level down either. `undefined` is the language's existence
 * TEST and never a value (docs/LANGUAGE.md § `undefined`). A nested `undefined`
 * must never reach the compiled document: if it did, it would disagree with
 * itself, because the printer drops the key while the driver sends `null` for it.
 */
function checkValue(value: unknown, slot: number, key?: string): void {
  const where = key !== undefined ? `parameter '${key}'` : `interpolation slot ${slot}`;
  // The whole value first: a cycle would make the walk below run forever.
  if (isCircular(value)) {
    throw new JsmqlInterpolationError(
      `jsmql ${where} is a circular structure. It has no MQL representation.`,
      slot,
      key,
    );
  }
  const refuse = (message: string, path: string): never => {
    throw new JsmqlInterpolationError(`jsmql ${where}${path === "" ? "" : ` at ${path}`} ${message}`, slot, key);
  };
  const walk = (v: unknown, path: string): void => {
    if (v === undefined) refuse("is undefined. Pass null for a missing value, or leave the slot out.", path);
    if (typeof v === "function" || typeof v === "symbol") {
      refuse(
        `has type '${typeof v}'. This type has no MQL representation. Pass a string, number, boolean, null, Date, ObjectId, array, or plain object.`,
        path,
      );
    }
    if (typeof v === "number" && !Number.isFinite(v)) {
      refuse(
        `holds ${v}. This value has no MQL representation (NaN and ±Infinity). Replace it with null or a finite number.`,
        path,
      );
    }
    if (v === null || typeof v !== "object") return;
    // A BSON class carries its own value; its internals are not the developer's data.
    if (bsonTagOf(v) !== undefined) return;
    if (isDate(v) || isRegExp(v)) return;
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`));
      return;
    }
    for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  };
  walk(value, "");
}

/** The template tag's parts as one source: each slot is a name bound to its value. */
function templateSource(strings: TemplateStringsArray, values: readonly unknown[]): { src: string; values: Values } {
  let src = "";
  const bound = new Map<string, unknown>();
  strings.forEach((part, i) => {
    src += part;
    if (i < values.length) {
      checkValue(values[i], i + 1);
      const name = `__jsmql_slot${i + 1}`;
      bound.set(name, values[i]);
      src += name;
    }
  });
  return { src, values: bound };
}

/** Does the source spell the entry form `(params, { $ }) => …` (or `async`/`function` forms of it)? */
function isEntryForm(src: string): boolean {
  let tokens: ReturnType<typeof lex>;
  try {
    tokens = lex(src);
  } catch {
    return false;
  }
  let i = 0;
  const first = tokens[0];
  if (first === undefined) return false;
  if (first.type === "Ident" && first.text === "async") i++;
  const isFunction = tokens[i]?.type === "Ident" && tokens[i].text === "function";
  if (isFunction) {
    i++;
    if (tokens[i]?.type === "Ident") i++; // a name
  }
  if (tokens[i]?.type !== "LParen") return false;
  // the parameter list, balanced
  let depth = 0;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "LParen") depth++;
    else if (t.type === "RParen") {
      depth--;
      if (depth === 0) break;
    }
  }
  i++;
  if (!isFunction) return tokens[i]?.type === "Arrow";
  // `function f(…) { … }` is the entry form only when the body is the WHOLE input; a
  // declaration followed by more statements is a program that declares a function.
  if (tokens[i]?.type !== "LBrace") return false;
  depth = 0;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "LBrace") depth++;
    else if (t.type === "RBrace") {
      depth--;
      if (depth === 0) break;
    }
  }
  return tokens[i + 1] === undefined || tokens[i + 1].type === "EOF";
}

type Parsed = { program: Program; params: readonly ParamBinding[] };

/** Parse the source once: the entry form yields its parameters, plain source has none. */
function parseInput(src: string): Parsed {
  if (isEntryForm(src)) {
    const entry = parseEntry(src);
    return { program: entry.program, params: entry.params };
  }
  return { program: parse(src), params: [] };
}

// ── lowering, per mode ───────────────────────────────────────────────────────

const DRIVER: Record<Exclude<Mode, "auto">, string> = {
  expr: "an aggregation expression (the value of a stage field, `jsmql.expr`)",
  filter: "a Filter (the document `db.coll.find(filter)` takes)",
  pipeline: "a Pipeline (the stage array `db.coll.aggregate(pipeline)` takes)",
  update: "an update document (the object `db.coll.updateOne(filter, update)` takes)",
};

/** What a program IS, for a strict entry that wanted another shape. */
function received(program: Program): { what: string; hint: string } {
  // A `;` alone does not make a Pipeline. A binding in front of one expression is
  // still the Filter that expression is. Calling it a Pipeline would send the
  // developer back to the pipeline entry the developer already called.
  if (program.type === "Pipeline" && shapeOf(program) === "pipeline") {
    return { what: "a `;`-separated Pipeline", hint: "jsmql.pipeline() (or jsmql(), which decides from the shape)" };
  }
  if (program.type === "Pipeline") {
    return {
      what: "a binding and one expression, which is a Filter (`const cutoff = 18; $.age > cutoff`)",
      hint: "jsmql.filter() for a Filter, or wrap the predicate as `$match(…)` for a Pipeline",
    };
  }
  if (program.type === "UpdateFilter") {
    const target = program.ops[0]?.type === "AssignExpr" ? program.ops[0].target.type : null;
    if (target === "StreamRef") {
      return {
        what: "a stream-replace `$$ = <expr>` (the pipeline stages its chain describes)",
        hint: "jsmql.pipeline(); for a Filter, pass the predicate to jsmql.filter() directly",
      };
    }
    if (target === "FieldRef" && (program.ops[0] as { target: { path: string } }).target.path === "") {
      return { what: "a root-replace `$ = <expr>` (a `$replaceWith` stage)", hint: "jsmql.pipeline()" };
    }
    return {
      what: "a write (`$.x = …`, `delete $.x`)",
      hint: "jsmql.update() for an update document, or jsmql.pipeline() for a `$set` / `$unset` pipeline",
    };
  }
  if (program.type === "ArrayLiteral") {
    return { what: "a Pipeline array (`[{ $stage: … }, …]`)", hint: "jsmql.pipeline()" };
  }
  const stage = shapeOf(program) === "pipeline" ? namedRow(program) : null;
  if (stage !== null) {
    // `$$.size()` is a VALUE the stream carries, not a stage: it materialises a stage, so it needs a pipeline.
    if (hasStreamValueCell(stage)) {
      return {
        what: `'$$.${stage}()', the stream's document count, which materialises a '$setWindowFields' stage`,
        hint: "jsmql.pipeline()",
      };
    }
    const drop = stage === "$match" ? " — for a Filter, drop the `$match(...)` wrapper and pass its predicate" : "";
    return { what: `a top-level '${stage}' stage call`, hint: `jsmql.pipeline()${drop}` };
  }
  return {
    what: "a bare expression that would lower to a Filter (`$.age > 18`)",
    hint: "jsmql.filter() for a Filter, or wrap the predicate as `$match(…)` for a Pipeline",
  };
}

/**
 * The defect inside a program that is a FILTER, found by lowering it as one.
 *
 * A program is judged for its shape only once it is correct. A value such as
 * `new Date("nope")` is wrong under every entry. Telling the developer only to
 * call a different entry would just send the developer to meet the same error
 * on the next run. This function returns null when the only thing wrong is the
 * shape.
 *
 * The function searches only the filter reading, because that is the shape a
 * program the pipeline entry refuses actually has. Lowering the program as
 * anything else would answer with a position the developer never asked for.
 */
function defectAsFilter(injected: Program): CodegenError | null {
  try {
    const program = expressionOf(desugar(fold(injected), FILTER));
    lowerFilter(program, Env.root(program, "filter"));
    return null;
  } catch (e) {
    return e instanceof CodegenError ? e : null;
  }
}

function wrongShape(api: string, wanted: Exclude<Mode, "auto">, program: Program): CodegenError {
  const got = received(program);
  return new CodegenError(
    `${api.replace(/\.compile$/, "")}() expects ${DRIVER[wanted]}. It received ${got.what} instead. Use ${got.hint}.`,
    (program as { pos: number }).pos,
  );
}

/**
 * The one expression a Filter / expression program is, once the fold has inlined
 * its `const` prelude. A binding the fold could not settle needs the pipeline form.
 */
function expressionOf(program: Program): Expr {
  if (program.type !== "Pipeline") return program as Expr;
  const nodes = new Map<string, Expr>();
  const rest: Expr[] = [];
  for (const s of program.stmts) {
    if (s.type === "LetDecl") {
      // `const` binds a value or an expression. The fold already inlines a constant;
      // what reaches here reads the document, so it goes in as the expression.
      if (s.kind !== "const") {
        throw new CodegenError(
          "A Filter or an expression takes a 'const' prelude. A 'let' needs the pipeline form. There it becomes a field.",
          s.pos,
        );
      }
      const init = replaceIdents(s.value, nodes);
      const v = evaluate(init, new Map());
      nodes.set(s.name, v.ok ? spellValue(v.value, s.pos) : init);
      continue;
    }
    if (s.type === "FuncDecl") {
      throw new CodegenError(
        "A Filter or an expression cannot declare a function. Call it inline, or use the pipeline form.",
        s.pos,
      );
    }
    rest.push(replaceIdents(s as Expr, nodes));
  }
  if (rest.length !== 1)
    throw new CodegenError("A Filter or an expression is one expression.", (program as { pos: number }).pos);
  return rest[0];
}

function lowerMode(mode: Mode, api: string, parsed: Program, values: Values): JsmqlOutput {
  const injected = inject(parsed, values);
  const resolved = mode === "auto" ? (shapeOf(injected) === "pipeline" ? "pipeline" : "filter") : mode;
  switch (resolved) {
    case "expr":
    case "filter": {
      // `Object.assign($.a, $.b)` standing alone is a write. Asked for an expression,
      // it means the `$mergeObjects` call it lowers to.
      if (shapeOf(injected) === "pipeline" && !(resolved === "expr" && isBareAssignWrite(injected))) {
        throw wrongShape(api, resolved, injected);
      }
      const program = expressionOf(desugar(fold(injected), resolved === "expr" ? VALUE : FILTER));
      return resolved === "expr"
        ? (lowerValue(program, Env.root(program, "value")) as JsmqlOutput)
        : lowerFilter(program, Env.root(program, "filter"));
    }
    case "pipeline": {
      // A BRACKETED program is a pipeline the developer wrote as one, whatever it holds.
      // Handing it to the shape refusal would answer a typo inside it with "use
      // jsmql.pipeline()" — the entry the developer already called. The lowering
      // names the stage instead.
      if (shapeOf(injected) !== "pipeline" && injected.type !== "ArrayLiteral") {
        // A program is judged for its SHAPE only once it is correct: this reports a
        // defect the developer must fix under every entry before the entry mismatch.
        throw defectAsFilter(injected) ?? wrongShape(api, "pipeline", injected);
      }
      const program = desugar(fold(injected), STATEMENT);
      const stages = lowerProgram(program, Env.root(program, "statement"));
      if (stages.length === 0) throw noStages((program as { pos: number }).pos);
      return stages as object[];
    }
    case "update": {
      const program = desugar(fold(injected), UPDATE_DOC);
      return lowerUpdate(program, Env.root(program, "updateDoc"));
    }
  }
}

/** One-shot: a string, an arrow without parameters, or a template tag. */
function oneShot(mode: Mode, api: string, input: JsmqlInput | TemplateStringsArray, values: unknown[]): JsmqlOutput {
  if (isTemplateStringsArray(input)) {
    const t = templateSource(input, values);
    return lowerMode(mode, api, parseInput(t.src).program, t.values);
  }
  if (typeof input === "function") {
    const parsed = parseInput(fnSource(input));
    if (parsed.params.length > 0) {
      throw new FunctionInputError(
        `${api}() in its one-shot form takes an arrow with the toolbox only: '({ $ }) => …'. A parameter destructure needs values. Use ${api}.compile(fn)(params).`,
        parsed.params[0].pos,
      );
    }
    return lowerMode(mode, api, parsed.program, NONE);
  }
  if (typeof input === "string") return lowerMode(mode, api, parseInput(input).program, NONE);
  const ty = input === null ? "null" : typeof input;
  throw new TypeError(`${api}() expects a string, an arrow function, or a template literal — got ${ty}.`);
}

type CompileBuilder<R extends JsmqlOutput> = {
  <P extends Record<string, any>>(fn: JsmqlCompileFn<P>): (params?: P) => R;
  (src: string): (params?: Record<string, any>) => R;
};

/** `compile`: parse once, bind the parameters at each call. */
function makeCompile<R extends JsmqlOutput>(mode: Mode, api: string): CompileBuilder<R> {
  function compile<P extends Record<string, unknown>>(input: JsmqlCompileFn<P> | string): (params?: P) => R {
    let src: string;
    if (typeof input === "function") src = fnSource(input);
    else if (typeof input === "string") src = input.trim();
    else {
      const ty = input === null ? "null" : typeof input;
      throw new TypeError(`${api}() expects an arrow function or a string containing one — got ${ty}.`);
    }
    if (!isEntryForm(src)) {
      throw new FunctionInputError(
        `${api}() takes the entry form '(params, { $, … }) => …'. This is an arrow whose first destructure names the parameters.`,
      );
    }
    const parsed = parseInput(src);
    return (params?: P): R => {
      const given = (params ?? {}) as Record<string, unknown>;
      const values = new Map<string, unknown>();
      for (const b of parsed.params) {
        if (!Object.prototype.hasOwnProperty.call(given, b.key)) {
          const expected = b.key === b.name ? `'${b.key}'` : `'${b.key}' (bound to '${b.name}' in the body)`;
          throw new CodegenError(
            `${expected} is a parameter of this query, and it is missing. Pass it: ${api}(fn)({ ${b.key}: … }).`,
            b.pos,
          );
        }
        checkValue(given[b.key], 0, b.key);
        values.set(b.name, given[b.key]);
      }
      return lowerMode(mode, api, parsed.program, values) as R;
    };
  }
  return compile;
}

// ── the entries ──────────────────────────────────────────────────────────────

function jsmqlDispatch<F extends JsmqlFn>(input: F): JsmqlArrowOutput<F>;
function jsmqlDispatch(input: JsmqlInput): JsmqlOutput;
function jsmqlDispatch(strings: TemplateStringsArray, ...values: unknown[]): JsmqlOutput;
function jsmqlDispatch(input: JsmqlInput | TemplateStringsArray, ...values: unknown[]): JsmqlOutput {
  return oneShot("auto", "jsmql", input, values);
}

function exprDispatch<F extends JsmqlFn>(input: F): JsmqlArrowOutput<F>;
function exprDispatch(input: JsmqlInput): JsmqlOutput;
function exprDispatch(strings: TemplateStringsArray, ...values: unknown[]): JsmqlOutput;
function exprDispatch(input: JsmqlInput | TemplateStringsArray, ...values: unknown[]): JsmqlOutput {
  return oneShot("expr", "jsmql.expr", input, values);
}

function filterDispatch(input: JsmqlInput): object;
function filterDispatch(strings: TemplateStringsArray, ...values: unknown[]): object;
function filterDispatch(input: JsmqlInput | TemplateStringsArray, ...values: unknown[]): object {
  return oneShot("filter", "jsmql.filter", input, values) as object;
}

function pipelineDispatch(input: JsmqlInput): object[];
function pipelineDispatch(strings: TemplateStringsArray, ...values: unknown[]): object[];
function pipelineDispatch(input: JsmqlInput | TemplateStringsArray, ...values: unknown[]): object[] {
  return oneShot("pipeline", "jsmql.pipeline", input, values) as object[];
}

function updateDispatch(input: JsmqlInput): object;
function updateDispatch(strings: TemplateStringsArray, ...values: unknown[]): object;
function updateDispatch(input: JsmqlInput | TemplateStringsArray, ...values: unknown[]): object {
  return oneShot("update", "jsmql.update", input, values) as object;
}

// ── validate ─────────────────────────────────────────────────────────────────

function validateInput<P extends Record<string, any>>(fn: JsmqlCompileFn<P>): ValidationResult;
function validateInput(input: JsmqlInput): ValidationResult;
function validateInput(strings: TemplateStringsArray, ...values: unknown[]): ValidationResult;
function validateInput(
  input: JsmqlInput | TemplateStringsArray | JsmqlCompileFn<any>,
  ...values: unknown[]
): ValidationResult {
  try {
    if (isTemplateStringsArray(input)) {
      jsmql(input, ...values);
    } else {
      const src = typeof input === "function" ? fnSource(input as (...args: never[]) => unknown) : (input as string);
      const parsed = parseInput(src);
      // This checks the entry form with every parameter bound to null: the shape of
      // the program does not depend on the values; only the document does.
      const nulls = new Map(parsed.params.map((b) => [b.name, null] as const));
      lowerMode("auto", "jsmql", parsed.program, nulls);
    }
    return { valid: true, errors: [] };
  } catch (err) {
    return errorToValidationResult(err);
  }
}

function errorToValidationResult(err: unknown): ValidationResult {
  if (err instanceof ParseError || err instanceof LexError) {
    return { valid: false, errors: [{ message: err.message, pos: err.pos, code: "SYNTAX_ERROR" }] };
  }
  if (err instanceof CodegenError) {
    return { valid: false, errors: [{ message: err.message, pos: err.pos, code: "CODEGEN_ERROR" }] };
  }
  if (err instanceof JsmqlInterpolationError) {
    return { valid: false, errors: [{ message: err.message, pos: 0, code: "SYNTAX_ERROR" }] };
  }
  if (err instanceof RangeError || err instanceof TypeError) {
    return { valid: false, errors: [{ message: err.message, pos: 0, code: "SYNTAX_ERROR" }] };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { valid: false, errors: [{ message: `internal error: ${message}`, pos: 0, code: "CODEGEN_ERROR" }] };
}

// ── the callable ─────────────────────────────────────────────────────────────

type Jsmql = typeof jsmqlDispatch & {
  compile: CompileBuilder<JsmqlOutput>;
  validate: typeof validateInput;
  stringify: typeof stringify;
  expr: typeof exprDispatch & { compile: CompileBuilder<JsmqlOutput> };
  filter: typeof filterDispatch & { compile: CompileBuilder<object> };
  pipeline: typeof pipelineDispatch & { compile: CompileBuilder<object[]> };
  update: typeof updateDispatch & { compile: CompileBuilder<object> };
};

/**
 * The callable with its properties, assembled by `Object.assign` rather than a
 * `namespace`: `src/` stays in TypeScript's strippable subset. See src/CLAUDE.md.
 */
export const jsmql: Jsmql = Object.assign(jsmqlDispatch, {
  compile: makeCompile<JsmqlOutput>("auto", "jsmql.compile"),
  validate: validateInput,
  stringify,
  expr: Object.assign(exprDispatch, { compile: makeCompile<JsmqlOutput>("expr", "jsmql.expr.compile") }),
  filter: Object.assign(filterDispatch, { compile: makeCompile<object>("filter", "jsmql.filter.compile") }),
  pipeline: Object.assign(pipelineDispatch, { compile: makeCompile<object[]>("pipeline", "jsmql.pipeline.compile") }),
  update: Object.assign(updateDispatch, { compile: makeCompile<object>("update", "jsmql.update.compile") }),
});
