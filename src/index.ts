import { hasStreamValueCell } from "./compiler/rows.ts";
import type { Expr, ParamBinding, Program } from "./registry/ast.ts";
import { lex, LexError } from "./compiler/lex/lexer.ts";
import { parse, parseEntry } from "./compiler/parse/parser.ts";
import { ParseError } from "./compiler/parse/cursor.ts";
import { fold } from "./compiler/passes/fold.ts";
import { desugar } from "./compiler/passes/desugar.ts";
import { inject, replaceIdents, spellValue } from "./compiler/passes/inject.ts";
import { rawMqlBoundary } from "./compiler/passes/raw-mql.ts";
import { refuseNew } from "./compiler/passes/no-new.ts";
import { constantOf } from "./compiler/passes/evaluate.ts";
import { FILTER, STATEMENT, UPDATE_DOC, VALUE } from "./compiler/passes/position.ts";
import { isBareAssign, isStageList, shapeOf } from "./compiler/passes/shape.ts";
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
export { Decimal128, Double, Int32, Long, MaxKey, MinKey, ObjectId, UUID } from "./bson.ts";
import { bsonTagOf, isBytes, isDate, isMap, isPlainObject, isRegExp } from "./bson.ts";

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

/**
 * The toolbox an arrow destructures: `$`, `$$`, `$$$`, `$$$$` and every `$op`.
 *
 * It is `any`, not an index signature over `$${string}`. An arrow declared separately from the
 * call gets its own parameter type, with a required member per name it destructures. An
 * index signature cannot give a required member, so TypeScript refuses that arrow.
 */
export type JsmqlToolbox = any;
export type JsmqlFn = (toolbox: JsmqlToolbox) => unknown;
export type JsmqlInput = string | JsmqlFn;
export type JsmqlOutput = object | object[];
/** An arrow whose body is a block returns a Pipeline; an expression body may be either shape. */
export type JsmqlArrowOutput<F extends JsmqlFn> = [ReturnType<F>] extends [void] ? object[] : JsmqlOutput;
type JsmqlCompileFn<P> = (params: P, toolbox: JsmqlToolbox) => unknown;

type Mode = "auto" | "expr" | "filter" | "pipeline" | "update";
type Values = ReadonlyMap<string, unknown>;
const NONE: Values = new Map();

function isTemplateStringsArray(x: unknown): x is TemplateStringsArray {
  return Array.isArray(x) && Array.isArray((x as { raw?: unknown }).raw);
}

const fnSource = (fn: (...args: never[]) => unknown): string => Function.prototype.toString.call(fn).trim();

const FRAMED = new WeakSet<Error>();

function framed<T>(src: string, run: () => T): T {
  try {
    return run();
  } catch (e) {
    if ((e instanceof CodegenError || e instanceof ParseError || e instanceof LexError) && !FRAMED.has(e)) {
      FRAMED.add(e);
      const before = src.slice(0, e.pos).split("\n");
      const line = before.length;
      const column = before[line - 1].length + 1;
      const gutter = `${line} | `;
      const pad = before[line - 1].replace(/[^\t]/g, " ");
      const frame = `\n  at line ${line}, column ${column}:\n${gutter}${src.split("\n")[line - 1]}\n${" ".repeat(gutter.length)}${pad}^`;
      const stack = e.stack;
      const old = e.message;
      e.message += frame;
      if (stack) e.stack = stack.replace(old, e.message);
    }
    throw e;
  }
}

const DRIVER_READS_TAG: ReadonlySet<string> = new Set(["Date", "RegExp", "Map"]);

function driverValue(value: unknown, slot: number, key?: string): unknown {
  const where = key !== undefined ? `parameter '${key}'` : `interpolation slot ${slot}`;
  const refuse = (message: string, path: string): never => {
    throw new JsmqlInterpolationError(`jsmql ${where}${path === "" ? "" : ` at ${path}`} ${message}`, slot, key);
  };
  const above = new Set<object>();
  const walk = (given: unknown, path: string): unknown => {
    const v =
      typeof (given as { toBSON?: unknown } | null | undefined)?.toBSON === "function"
        ? (given as { toBSON: () => unknown }).toBSON()
        : given;
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
    if (v === null || typeof v !== "object") return v;
    if (isDate(v) && Number.isNaN(Date.prototype.getTime.call(v))) {
      refuse("is an Invalid Date. The driver sends it as 1970-01-01. Pass a valid Date, or null.", path);
    }
    if (bsonTagOf(v) !== undefined || isDate(v) || isRegExp(v) || isBytes(v)) return v;
    if (above.has(v))
      throw new JsmqlInterpolationError(
        `jsmql ${where} is a circular structure. It has no MQL representation.`,
        slot,
        key,
      );
    above.add(v);
    try {
      if (Array.isArray(v)) {
        const out = v.map((x, i) => walk(x, `${path}[${i}]`));
        return out.every((x, i) => x === v[i]) ? v : out;
      }
      if (isMap(v)) {
        const out: Record<string, unknown> = {};
        for (const [k, x] of v) {
          if (typeof k !== "string") {
            refuse(
              `is a Map with the key ${typeof k === "symbol" ? "a symbol" : String(k)}. The driver sends each key as a field name, so each key must be a string.`,
              path,
            );
          }
          out[k as string] = walk(x, `${path}.${k as string}`);
        }
        return out;
      }
      const kind = Object.prototype.toString.call(v).slice(8, -1);
      const article = /^[AEIOU]/.test(kind) ? "an" : "a";
      if (DRIVER_READS_TAG.has(kind)) {
        refuse(
          `sets Symbol.toStringTag to "${kind}", but it is not ${article} ${kind}. The driver reads the tag and sends the object as ${article} ${kind}. Remove the tag, or pass ${article} ${kind}.`,
          path,
        );
      }
      if (kind === "Set") refuse("is a Set. The driver sends a Set as {}. Pass an array: [...set].", path);
      if (kind !== "Object" && !isPlainObject(v)) {
        refuse(
          `is ${article} ${kind}. This object has no MQL representation. Pass a string, number, boolean, null, Date, ObjectId, Map, array, plain object, or a value with toBSON().`,
          path,
        );
      }
      const entries = Object.keys(v).map((k) => [k, walk((v as Record<string, unknown>)[k], `${path}.${k}`)] as const);
      const same = isPlainObject(v) && entries.every(([k, x]) => x === (v as Record<string, unknown>)[k]);
      return same ? v : Object.fromEntries(entries);
    } finally {
      above.delete(v);
    }
  };
  return walk(value, "");
}

function templateSource(strings: TemplateStringsArray, values: readonly unknown[]): { src: string; values: Values } {
  let src = "";
  const bound = new Map<string, unknown>();
  strings.forEach((part, i) => {
    src += part;
    if (i < values.length) {
      const name = `__jsmql_slot${i + 1}`;
      bound.set(name, driverValue(values[i], i + 1));
      src += name;
    }
  });
  return { src, values: bound };
}

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
    if (tokens[i]?.type === "Ident") i++;
  }
  if (tokens[i]?.type !== "LParen") return false;
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

function parseInput(src: string): Parsed {
  if (isEntryForm(src)) {
    const entry = parseEntry(src);
    return { program: entry.program, params: entry.params };
  }
  return { program: parse(src), params: [] };
}

const DRIVER: Record<Exclude<Mode, "auto">, string> = {
  expr: "an aggregation expression (the value of a stage field, `jsmql.expr`)",
  filter: "a Filter (the document `db.coll.find(filter)` takes)",
  pipeline: "a Pipeline (the stage array `db.coll.aggregate(pipeline)` takes)",
  update: "an update document (the object `db.coll.updateOne(filter, update)` takes)",
};

function received(program: Program): { what: string; hint: string } {
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
    return { what: "a bracketed list, which is a Pipeline (`[{ $stage: … }, …]`)", hint: "jsmql.pipeline()" };
  }
  const stage = shapeOf(program) === "pipeline" ? namedRow(program) : null;
  if (stage !== null) {
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

function expressionOf(program: Program): Expr {
  if (program.type !== "Pipeline") return program as Expr;
  const nodes = new Map<string, Expr>();
  const rest: Expr[] = [];
  for (const s of program.stmts) {
    if (s.type === "LetDecl") {
      if (s.kind !== "const") {
        throw new CodegenError(
          "A Filter or an expression takes a 'const' prelude. A 'let' needs the pipeline form. There it becomes a field.",
          s.pos,
        );
      }
      const init = replaceIdents(s.value, nodes);
      const v = constantOf(init);
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
  const resolved = mode === "auto" ? (shapeOf(inject(parsed, values)) === "pipeline" ? "pipeline" : "filter") : mode;
  refuseNew(parsed);
  rawMqlBoundary(parsed, resolved === "filter" ? "filter" : "other");
  const injected = inject(parsed, values);
  switch (resolved) {
    case "expr":
    case "filter": {
      const pipelineShaped =
        resolved === "expr" && injected.type === "ArrayLiteral"
          ? isStageList(injected)
          : shapeOf(injected) === "pipeline" && !(resolved === "expr" && isBareAssign(injected));
      if (pipelineShaped) throw wrongShape(api, resolved, injected);
      const program = expressionOf(desugar(fold(injected), resolved === "expr" ? VALUE : FILTER));
      return resolved === "expr"
        ? (lowerValue(program, Env.root(program, "value")) as JsmqlOutput)
        : lowerFilter(program, Env.root(program, "filter"));
    }
    case "pipeline": {
      if (shapeOf(injected) !== "pipeline") {
        throw defectAsFilter(injected) ?? wrongShape(api, "pipeline", injected);
      }
      const program = desugar(fold(injected), STATEMENT);
      const stages = lowerProgram(program, Env.root(program, "statement"));
      if (stages.length === 0 && injected.type !== "ArrayLiteral") throw noStages((program as { pos: number }).pos);
      return stages as object[];
    }
    case "update": {
      const program = desugar(fold(injected), UPDATE_DOC);
      return lowerUpdate(program, Env.root(program, "updateDoc"));
    }
  }
}

function oneShot(mode: Mode, api: string, input: JsmqlInput | TemplateStringsArray, values: unknown[]): JsmqlOutput {
  if (isTemplateStringsArray(input)) {
    const t = templateSource(input, values);
    return framed(t.src, () => lowerMode(mode, api, parseInput(t.src).program, t.values));
  }
  if (typeof input === "function") {
    const src = fnSource(input);
    return framed(src, () => {
      const parsed = parseInput(src);
      if (parsed.params.length > 0) {
        throw new FunctionInputError(
          `${api}() in its one-shot form takes an arrow with the toolbox only: '({ $ }) => …'. A parameter destructure needs values. Use ${api}.compile(fn)(params).`,
          parsed.params[0].pos,
        );
      }
      return lowerMode(mode, api, parsed.program, NONE);
    });
  }
  if (typeof input === "string") return framed(input, () => lowerMode(mode, api, parseInput(input).program, NONE));
  const ty = input === null ? "null" : typeof input;
  throw new TypeError(`${api}() expects a string, an arrow function, or a template literal — got ${ty}.`);
}

type CompileBuilder<R extends JsmqlOutput> = {
  <P extends Record<string, any>>(fn: JsmqlCompileFn<P>): (params?: P) => R;
  (src: string): (params?: Record<string, any>) => R;
};

function makeCompile<R extends JsmqlOutput>(mode: Mode, api: string): CompileBuilder<R> {
  function compile<P extends Record<string, unknown>>(input: JsmqlCompileFn<P> | string): (params?: P) => R {
    let src: string;
    if (typeof input === "function") src = fnSource(input);
    else if (typeof input === "string") src = input;
    else {
      const ty = input === null ? "null" : typeof input;
      throw new TypeError(`${api}() expects an arrow function or a string containing one — got ${ty}.`);
    }
    if (!isEntryForm(src)) {
      throw new FunctionInputError(
        `The source at position 0 is not the entry form '(params, { $, … }) => …' that ${api}() takes: an arrow whose first destructure names the parameters.`,
        0,
      );
    }
    const parsed = framed(src, () => parseInput(src));
    return (params?: P): R =>
      framed(src, () => {
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
          values.set(b.name, driverValue(given[b.key], 0, b.key));
        }
        return lowerMode(mode, api, parsed.program, values) as R;
      });
  }
  return compile;
}

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

function validateInput<P extends Record<string, any>>(fn: JsmqlCompileFn<P>): ValidationResult;
function validateInput(input: JsmqlInput): ValidationResult;
function validateInput(strings: TemplateStringsArray, ...values: unknown[]): ValidationResult;
function validateInput(
  input: JsmqlInput | TemplateStringsArray | JsmqlCompileFn<any>,
  ...values: unknown[]
): ValidationResult {
  try {
    if (isTemplateStringsArray(input)) {
      const t = templateSource(input, values);
      lowerMode("auto", "jsmql", parseInput(t.src).program, t.values);
    } else {
      const src = typeof input === "function" ? fnSource(input as (...args: never[]) => unknown) : (input as string);
      const parsed = parseInput(src);
      const unknown = new Map(parsed.params.map((b) => [b.name, new ParameterValue()] as const));
      lowerMode("auto", "jsmql", parsed.program, unknown);
    }
    return { valid: true, errors: [] };
  } catch (err) {
    return errorToValidationResult(err);
  }
}

class ParameterValue {}

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
 * The callable with its properties, assembled by `Object.assign`, not by a
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
