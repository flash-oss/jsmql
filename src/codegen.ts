import { lookupOperator } from "./operators.js";
import type {
  BinaryOp,
  Expr,
  ArrayElement,
  ObjectEntry,
  CallArg,
  SpreadElement,
  KeyValueEntry,
  MathMethod,
  MathConstant,
  ObjectMethod,
  TypeCastOp,
} from "./ast.js";

export class CodegenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodegenError";
  }
}

// ── Context ───────────────────────────────────────────────────────────────────

type GenerateCtx = {
  lambdaParams: ReadonlySet<string>;
  reduceRemap?: ReadonlyMap<string, string>;
};

const EMPTY_CTX: GenerateCtx = { lambdaParams: new Set() };

function extendCtx(ctx: GenerateCtx, params: string[]): GenerateCtx {
  return { lambdaParams: new Set([...ctx.lambdaParams, ...params]) };
}

// ── String-producing helpers ──────────────────────────────────────────────────

// Operators whose return type is always a string — used for string-context + inference.
const STRING_OUTPUT_OPS = new Set([
  "$toLower",
  "$toUpper",
  "$trim",
  "$ltrim",
  "$rtrim",
  "$concat",
  "$substrCP",
  "$substrBytes",
  "$substr",
  "$replaceOne",
  "$replaceAll",
  "$dateToString",
  "$type",
  "$strcasecmp",
  "$toString",
]);

// Method names that always return a string
const STRING_RETURNING_METHODS = new Set([
  "trim",
  "trimStart",
  "trimEnd",
  "trimLeft",
  "trimRight",
  "toLowerCase",
  "toUpperCase",
  "substr",
  "replace",
  "replaceAll",
  "charAt",
  "toISOString",
  "join",
]);

// ── Array-producing helpers ───────────────────────────────────────────────────

// Operators whose return type is always an array
const ARRAY_OUTPUT_OPS = new Set([
  "$split",
  "$range",
  "$reverseArray",
  "$slice",
  "$map",
  "$filter",
  "$concatArrays",
  "$setUnion",
  "$setIntersection",
  "$setDifference",
  "$zip",
  "$objectToArray",
]);

// Method names that always return an array
const ARRAY_RETURNING_METHODS = new Set([
  "split",
  "map",
  "filter",
  "slice",
  "reverse",
  "flat",
  "flatMap",
]);

function isArrayProducing(expr: Expr): boolean {
  switch (expr.type) {
    case "ArrayLiteral":
      return true;
    case "OperatorCall":
      return ARRAY_OUTPUT_OPS.has(expr.name);
    case "MethodCall":
      return ARRAY_RETURNING_METHODS.has(expr.method);
    case "ObjectCall":
      return expr.method === "entries" || expr.method === "keys" || expr.method === "values";
    default:
      return false;
  }
}

function isStringProducing(expr: Expr): boolean {
  switch (expr.type) {
    case "StringLiteral":
      return true;
    case "TemplateLiteral":
      return true;
    case "OperatorCall":
      return STRING_OUTPUT_OPS.has(expr.name);
    case "MethodCall":
      return STRING_RETURNING_METHODS.has(expr.method);
    case "TypeCast":
      return expr.cast === "String";
    case "TypeofExpr":
      return true;
    case "BinaryExpr":
      if (expr.op === "+") {
        const chain: Expr[] = [];
        collectExprChain("+", expr, chain);
        return chain.some((e) => isStringProducing(e));
      }
      return false;
    default:
      return false;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function generate(expr: Expr): unknown {
  return _generate(expr, EMPTY_CTX);
}

// ── Core generator ────────────────────────────────────────────────────────────

function _generate(expr: Expr, ctx: GenerateCtx): unknown {
  switch (expr.type) {
    case "NumberLiteral":
      return expr.value;
    case "StringLiteral":
      return expr.value;
    case "BooleanLiteral":
      return expr.value;
    case "NullLiteral":
      return null;
    case "FieldRef":
      return `$${expr.path}`;

    case "ArrayLiteral":
      return expr.elements.map((el) => generateArrayElement(el, ctx));

    case "ObjectLiteral":
      return generateObjectLiteral(expr.entries, ctx);

    case "TemplateLiteral":
      return generateTemplateLiteral(expr.quasis, expr.expressions, ctx);

    case "OperatorCall":
      return generateOperatorCall(expr.name, expr.style, expr.args, ctx);

    case "BinaryExpr":
      return generateBinaryExpr(expr.op, expr.left, expr.right, ctx);

    case "UnaryExpr":
      return generateUnaryExpr(expr.op, expr.operand, ctx);

    case "TernaryExpr":
      return {
        $cond: [
          _generate(expr.condition, ctx),
          _generate(expr.consequent, ctx),
          _generate(expr.alternate, ctx),
        ],
      };

    case "IndexAccess":
      return { $arrayElemAt: [_generate(expr.object, ctx), _generate(expr.index, ctx)] };

    case "RegexLiteral":
      // Used directly in .match(); as a standalone value just return the pattern string
      return expr.pattern;

    case "ParamRef": {
      if (ctx.reduceRemap?.has(expr.name)) {
        return `$$${ctx.reduceRemap.get(expr.name)!}`;
      }
      if (ctx.lambdaParams.has(expr.name)) {
        return `$$${expr.name}`;
      }
      throw new CodegenError(`Unknown identifier '${expr.name}'. Did you mean '$.${expr.name}'?`);
    }

    case "MemberAccess": {
      if (expr.member === "length") {
        const obj = _generate(expr.object, ctx);
        if (isStringProducing(expr.object)) return { $strLenCP: obj };
        if (isArrayProducing(expr.object)) return { $size: obj };
        // Type unknown at compile time — dispatch at runtime
        return { $cond: [{ $isArray: obj }, { $size: obj }, { $strLenCP: obj }] };
      }
      const path = asFieldPath(expr, ctx);
      if (path !== null) return path;
      throw new CodegenError(`Cannot access property '${expr.member}' on a non-field expression`);
    }

    case "MethodCall":
      return generateMethodCall(expr.object, expr.method, expr.args, ctx);

    case "Lambda":
      throw new CodegenError(
        "Lambda expression cannot be used here — only valid as array method argument or $let second argument",
      );

    case "TypeofExpr":
      return { $type: _generate(expr.operand, ctx) };

    case "NewDate":
      return { $toDate: expr.arg ? _generate(expr.arg, ctx) : "$$NOW" };

    case "DateNow":
      // Date.now() returns ms since epoch — match JS semantics
      return { $toLong: "$$NOW" };

    case "TypeCast":
      return generateTypeCast(expr.cast, expr.arg, ctx);

    case "MathCall":
      return generateMathCall(expr.method, expr.args, ctx);

    case "MathConst":
      return generateMathConst(expr.name);

    case "ObjectCall":
      return generateObjectCall(expr.method, expr.args, ctx);
  }
}

// ── Field path reconstruction ─────────────────────────────────────────────────

function asFieldPath(expr: Expr, ctx: GenerateCtx): string | null {
  if (expr.type === "FieldRef") return `$${expr.path}`;
  if (expr.type === "ParamRef") {
    if (ctx.reduceRemap?.has(expr.name)) {
      return `$$${ctx.reduceRemap.get(expr.name)!}`;
    }
    if (ctx.lambdaParams.has(expr.name)) {
      return `$$${expr.name}`;
    }
    return null;
  }
  if (expr.type === "MemberAccess") {
    const base = asFieldPath(expr.object, ctx);
    if (base !== null) return `${base}.${expr.member}`;
  }
  return null;
}

// ── Binary expressions ────────────────────────────────────────────────────────

function generateBinaryExpr(op: BinaryOp, left: Expr, right: Expr, ctx: GenerateCtx): unknown {
  switch (op) {
    case "+":
      return generateAdd(left, right, ctx);
    case "-":
      return { $subtract: [_generate(left, ctx), _generate(right, ctx)] };
    case "*":
      return { $multiply: flattenChain("*", left, right, ctx) };
    case "/":
      return { $divide: [_generate(left, ctx), _generate(right, ctx)] };
    case "%":
      return { $mod: [_generate(left, ctx), _generate(right, ctx)] };
    case "**":
      return { $pow: [_generate(left, ctx), _generate(right, ctx)] };
    case "==":
    case "===":
      return { $eq: [_generate(left, ctx), _generate(right, ctx)] };
    case "!=":
    case "!==":
      return { $ne: [_generate(left, ctx), _generate(right, ctx)] };
    case ">":
      return { $gt: [_generate(left, ctx), _generate(right, ctx)] };
    case ">=":
      return { $gte: [_generate(left, ctx), _generate(right, ctx)] };
    case "<":
      return { $lt: [_generate(left, ctx), _generate(right, ctx)] };
    case "<=":
      return { $lte: [_generate(left, ctx), _generate(right, ctx)] };
    case "&&":
      return { $and: flattenChain("&&", left, right, ctx) };
    case "||":
      return { $or: flattenChain("||", left, right, ctx) };
    case "??":
      return { $ifNull: flattenChain("??", left, right, ctx) };
    case "in": {
      if (
        right.type === "StringLiteral" ||
        right.type === "NumberLiteral" ||
        right.type === "BooleanLiteral" ||
        right.type === "NullLiteral"
      ) {
        throw new CodegenError(
          "Right-hand side of 'in' must be an array literal or field reference, not a scalar value",
        );
      }
      return { $in: [_generate(left, ctx), _generate(right, ctx)] };
    }
  }
}

/**
 * Collect all operands from a left-associative chain of the same operator.
 * e.g. BinaryExpr(*, BinaryExpr(*, a, b), c) → [gen(a), gen(b), gen(c)]
 */
function flattenChain(op: BinaryOp, left: Expr, right: Expr, ctx: GenerateCtx): unknown[] {
  const operands: unknown[] = [];
  collectChain(op, left, operands, ctx);
  operands.push(_generate(right, ctx));
  return operands;
}

function collectChain(op: BinaryOp, expr: Expr, out: unknown[], ctx: GenerateCtx): void {
  if (expr.type === "BinaryExpr" && expr.op === op) {
    collectChain(op, expr.left, out, ctx);
    out.push(_generate(expr.right, ctx));
  } else {
    out.push(_generate(expr, ctx));
  }
}

// ── String-context + ──────────────────────────────────────────────────────────

function generateAdd(left: Expr, right: Expr, ctx: GenerateCtx): unknown {
  // Collect full operand chain first, then decide $add vs $concat
  const exprs: Expr[] = [];
  collectExprChain("+", left, exprs);
  exprs.push(right);

  const isString = exprs.some((e) => isStringProducing(e));
  const generated = exprs.map((e) => _generate(e, ctx));
  return isString ? { $concat: generated } : { $add: generated };
}

function collectExprChain(op: BinaryOp, expr: Expr, out: Expr[]): void {
  if (expr.type === "BinaryExpr" && expr.op === op) {
    collectExprChain(op, expr.left, out);
    out.push(expr.right);
  } else {
    out.push(expr);
  }
}

// ── Unary expressions ─────────────────────────────────────────────────────────

function generateUnaryExpr(op: "!" | "-", operand: Expr, ctx: GenerateCtx): unknown {
  if (op === "!") {
    return { $not: _generate(operand, ctx) };
  }
  // Unary minus: optimise -<number> to a plain negative number literal
  if (operand.type === "NumberLiteral") {
    return -operand.value;
  }
  return { $multiply: [_generate(operand, ctx), -1] };
}

// ── Array / object literals ───────────────────────────────────────────────────

function generateArrayElement(el: ArrayElement, ctx: GenerateCtx): unknown {
  if (el.type === "SpreadElement") {
    throw new CodegenError("Spread elements in array literals are not supported in MQL output");
  }
  return _generate(el, ctx);
}

/**
 * Generate an object literal. If all entries are static-key plain key-value pairs,
 * emits a regular MQL object. If any entry is a computed key, the result is built via
 * `$arrayToObject`. Spread entries are not supported (would require runtime merging).
 */
function generateObjectLiteral(entries: ObjectEntry[], ctx: GenerateCtx): unknown {
  const hasComputed = entries.some((e) => e.type === "KeyValueEntry" && e.key.kind === "computed");
  const hasSpread = entries.some((e) => e.type === "SpreadElement");

  if (hasSpread) {
    throw new CodegenError("Spread elements in object literals are not supported in MQL output");
  }

  if (!hasComputed) {
    // Fast path: pure static-key object.
    return generateStaticObjectEntries(entries, ctx);
  }

  // Computed keys → $arrayToObject of [[k, v], ...] entries
  const pairs = entries.map((e) => {
    const entry = e as KeyValueEntry;
    const key = entry.key.kind === "static" ? entry.key.name : _generate(entry.key.expr, ctx);
    return [key, _generate(entry.value, ctx)];
  });
  return { $arrayToObject: pairs };
}

/**
 * Used for object-style operator args, where the keys must literally appear in MQL output
 * (e.g. `{ input, find, replacement }` for `$replaceOne`). Computed keys are rejected here —
 * MongoDB operator key names are part of the operator's wire format and can't be runtime values.
 */
function generateStaticObjectEntries(
  entries: ObjectEntry[],
  ctx: GenerateCtx,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const entry of entries) {
    if (entry.type === "SpreadElement") {
      throw new CodegenError("Spread elements in objects are not supported in MQL output");
    }
    if (entry.key.kind === "computed") {
      throw new CodegenError(
        "Computed object keys are not allowed here — operator argument keys must be literal names",
      );
    }
    result[entry.key.name] = _generate(entry.value, ctx);
  }
  return result;
}

// ── Operator calls ────────────────────────────────────────────────────────────

function generateOperatorCall(
  name: string,
  style: "positional" | "object",
  args: CallArg[],
  ctx: GenerateCtx,
): Record<string, unknown> {
  if (style === "object") {
    const objArg = args[0];
    if (!objArg || objArg.type !== "ObjectLiteral") {
      throw new CodegenError(`Object-style call to ${name} must have exactly one object argument`);
    }
    const def = lookupOperator(name);
    // For operators that genuinely expect a named-key object (e.g. $trim, $dateAdd),
    // the keys must be literal names — they are part of the MQL wire format.
    // For any other operator (or unknown), the object is just a value, so computed
    // keys and any other normal object behaviour applies.
    if (def?.shape.kind === "object") {
      return { [name]: generateStaticObjectEntries(objArg.entries, ctx) };
    }
    return { [name]: generateObjectLiteral(objArg.entries, ctx) };
  }

  // Special case: $let(varsObj, lambda) — lambda defines the "in" body
  if (name === "$let" && args.length === 2 && args[1]?.type === "Lambda") {
    const varsExpr = args[0];
    if (!varsExpr || varsExpr.type !== "ObjectLiteral") {
      throw new CodegenError("$let first argument must be an object literal");
    }
    const lambdaExpr = args[1];
    if (lambdaExpr.type !== "Lambda")
      throw new CodegenError("$let second argument must be a lambda");
    const vars = generateStaticObjectEntries(varsExpr.entries, ctx);
    const bodyCtx = extendCtx(ctx, lambdaExpr.params);
    return { $let: { vars, in: _generate(lambdaExpr.body, bodyCtx) } };
  }

  const def = lookupOperator(name);

  if (!def) {
    return generateUnknownOperator(name, args, ctx);
  }

  const { shape } = def;

  switch (shape.kind) {
    case "none": {
      assertNoSpread(args, name);
      return { [name]: {} };
    }

    case "single": {
      assertNoSpread(args, name);
      if (args.length !== 1) {
        throw new CodegenError(`Operator ${name} expects exactly 1 argument, got ${args.length}`);
      }
      return { [name]: _generate(args[0] as Expr, ctx) };
    }

    case "array": {
      if (args.length === 0) {
        throw new CodegenError(`Operator ${name} expects at least 1 argument`);
      }
      return { [name]: generateVariadicArgs(args, ctx) };
    }

    case "object": {
      assertNoSpread(args, name);
      if (args.length === 0) {
        throw new CodegenError(`Operator ${name} expects at least 1 argument`);
      }
      const keys = shape.keys;
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < args.length; i++) {
        const key = keys[i];
        if (!key) {
          throw new CodegenError(
            `Operator ${name} received more positional arguments than expected (max ${keys.length})`,
          );
        }
        obj[key] = _generate(args[i] as Expr, ctx);
      }
      return { [name]: obj };
    }
  }
}

function generateUnknownOperator(
  name: string,
  args: CallArg[],
  ctx: GenerateCtx,
): Record<string, unknown> {
  if (args.length === 0) {
    return { [name]: {} };
  }
  if (args.length === 1) {
    const only = args[0];
    if (only.type === "SpreadElement") {
      // Single ...arr passes the spread argument through directly as the operator value.
      return { [name]: _generate(only.argument, ctx) };
    }
    if (only.type === "ObjectLiteral") {
      return { [name]: generateStaticObjectEntries(only.entries, ctx) };
    }
    return { [name]: _generate(only, ctx) };
  }
  return { [name]: generateVariadicArgs(args, ctx) };
}

/**
 * Generate a variadic argument list, handling spread via concatArrays.
 *
 *   - all-non-spread args → a flat array
 *   - single spread arg → the spread's value (which is presumed to be an array)
 *   - mixed → `{ $concatArrays: [...wrapped] }`, where non-spread args become single-element arrays
 *     and spread args are passed through as their array value.
 */
function generateVariadicArgs(args: CallArg[], ctx: GenerateCtx): unknown {
  const hasSpread = args.some((a) => a.type === "SpreadElement");
  if (!hasSpread) {
    return args.map((a) => _generate(a as Expr, ctx));
  }
  if (args.length === 1) {
    const only = args[0] as SpreadElement;
    return _generate(only.argument, ctx);
  }
  const parts = args.map((a) =>
    a.type === "SpreadElement" ? _generate(a.argument, ctx) : [_generate(a, ctx)],
  );
  return { $concatArrays: parts };
}

function assertNoSpread(args: CallArg[], name: string): void {
  for (const a of args) {
    if (a.type === "SpreadElement") {
      throw new CodegenError(
        `Spread (...) is not supported as an argument to ${name} — only variadic operators accept it`,
      );
    }
  }
}

// ── Template literals ─────────────────────────────────────────────────────────

/**
 * Compile a template literal to `$concat`. Empty quasis and adjacent expressions are
 * still emitted as literal strings to keep the structure faithful — MongoDB will see
 * exactly the chunks the user wrote.
 *
 * `\`hello, ${name}!\`` → `{ $concat: ["hello, ", expr_for_name, "!"] }`
 *
 * Non-string interpolations are wrapped with `$toString` to match JS semantics —
 * `\`count: ${$.n}\`` works whether `$.n` is a number or a string. Expressions that
 * are statically known to produce strings skip the wrap to keep output compact.
 *
 * Special case: a template with no expressions and a single quasi just returns that
 * string (so `\`hi\`` ≡ `"hi"`).
 */
function generateTemplateLiteral(quasis: string[], expressions: Expr[], ctx: GenerateCtx): unknown {
  if (expressions.length === 0) {
    return quasis[0] ?? "";
  }
  const parts: unknown[] = [];
  for (let i = 0; i < expressions.length; i++) {
    if (quasis[i] !== "") parts.push(quasis[i]);
    const gen = _generate(expressions[i], ctx);
    parts.push(isStringProducing(expressions[i]) ? gen : { $toString: gen });
  }
  const tail = quasis[expressions.length];
  if (tail !== "") parts.push(tail);
  return { $concat: parts };
}

// ── Method calls ──────────────────────────────────────────────────────────────

function generateMethodCall(
  object: Expr,
  method: string,
  args: CallArg[],
  ctx: GenerateCtx,
): unknown {
  const genObj = _generate(object, ctx);

  switch (method) {
    // ── String methods ──────────────────────────────────────────────────────
    case "trim":
      return { $trim: { input: genObj } };
    case "trimStart":
    case "trimLeft":
      return { $ltrim: { input: genObj } };
    case "trimEnd":
    case "trimRight":
      return { $rtrim: { input: genObj } };
    case "toLowerCase":
      return { $toLower: genObj };
    case "toUpperCase":
      return { $toUpper: genObj };
    case "substr": {
      const exprArgs = exprArgsOnly(args, "substr");
      if (exprArgs.length === 1) {
        return { $substrCP: [genObj, _generate(exprArgs[0], ctx), { $strLenCP: genObj }] };
      }
      if (exprArgs.length === 2) {
        return { $substrCP: [genObj, _generate(exprArgs[0], ctx), _generate(exprArgs[1], ctx)] };
      }
      throw new CodegenError(`.substr() requires 1 or 2 arguments (start[, count])`);
    }
    case "charAt": {
      const exprArgs = exprArgsOnly(args, "charAt");
      if (exprArgs.length !== 1) {
        throw new CodegenError(`.charAt() requires exactly 1 argument`);
      }
      return { $substrCP: [genObj, _generate(exprArgs[0], ctx), 1] };
    }
    case "split": {
      const exprArgs = exprArgsOnly(args, "split");
      if (exprArgs.length !== 1) {
        throw new CodegenError(`.split() requires exactly 1 argument (separator)`);
      }
      return { $split: [genObj, _generate(exprArgs[0], ctx)] };
    }
    case "startsWith": {
      const exprArgs = exprArgsOnly(args, "startsWith");
      if (exprArgs.length !== 1) {
        throw new CodegenError(`.startsWith() requires exactly 1 argument`);
      }
      return { $eq: [{ $indexOfCP: [genObj, _generate(exprArgs[0], ctx)] }, 0] };
    }
    case "endsWith": {
      const exprArgs = exprArgsOnly(args, "endsWith");
      if (exprArgs.length !== 1) {
        throw new CodegenError(`.endsWith() requires exactly 1 argument`);
      }
      const needle = _generate(exprArgs[0], ctx);
      // Compares the last N codepoints of the input with the needle, where N is the needle's length.
      return {
        $eq: [
          {
            $substrCP: [
              genObj,
              { $subtract: [{ $strLenCP: genObj }, { $strLenCP: needle }] },
              { $strLenCP: needle },
            ],
          },
          needle,
        ],
      };
    }
    case "indexOf": {
      const exprArgs = exprArgsOnly(args, "indexOf");
      if (exprArgs.length !== 1) {
        throw new CodegenError(`.indexOf() requires exactly 1 argument`);
      }
      const needle = _generate(exprArgs[0], ctx);
      // Type-aware dispatch: known array → $indexOfArray; known string → $indexOfCP;
      // unknown → runtime $cond on $isArray so the right form runs at query time.
      if (isArrayProducing(object)) {
        return { $indexOfArray: [genObj, needle] };
      }
      if (isStringProducing(object)) {
        return { $indexOfCP: [genObj, needle] };
      }
      return {
        $cond: [
          { $isArray: genObj },
          { $indexOfArray: [genObj, needle] },
          { $indexOfCP: [genObj, needle] },
        ],
      };
    }
    case "replace": {
      const exprArgs = exprArgsOnly(args, "replace");
      if (exprArgs.length !== 2) {
        throw new CodegenError(`.replace() requires exactly 2 arguments (find, replacement)`);
      }
      return {
        $replaceOne: {
          input: genObj,
          find: _generate(exprArgs[0], ctx),
          replacement: _generate(exprArgs[1], ctx),
        },
      };
    }
    case "replaceAll": {
      const exprArgs = exprArgsOnly(args, "replaceAll");
      if (exprArgs.length !== 2) {
        throw new CodegenError(`.replaceAll() requires exactly 2 arguments (find, replacement)`);
      }
      return {
        $replaceAll: {
          input: genObj,
          find: _generate(exprArgs[0], ctx),
          replacement: _generate(exprArgs[1], ctx),
        },
      };
    }
    case "includes": {
      const exprArgs = exprArgsOnly(args, "includes");
      if (exprArgs.length !== 1) {
        throw new CodegenError(`.includes() requires exactly 1 argument`);
      }
      const needle = _generate(exprArgs[0], ctx);
      // Type-aware dispatch: known array → $in; known string → $indexOfCP form;
      // unknown → runtime $cond so a bare $.field works for either type.
      if (isArrayProducing(object)) {
        return { $in: [needle, genObj] };
      }
      if (isStringProducing(object)) {
        return { $gte: [{ $indexOfCP: [genObj, needle] }, 0] };
      }
      return {
        $cond: [
          { $isArray: genObj },
          { $in: [needle, genObj] },
          { $gte: [{ $indexOfCP: [genObj, needle] }, 0] },
        ],
      };
    }
    case "match": {
      const exprArgs = exprArgsOnly(args, "match");
      if (exprArgs.length !== 1) {
        throw new CodegenError(`.match() requires exactly 1 argument`);
      }
      const pattern = exprArgs[0];
      if (pattern.type === "RegexLiteral") {
        const result: Record<string, unknown> = { input: genObj, regex: pattern.pattern };
        if (pattern.flags) result["options"] = pattern.flags;
        return { $regexMatch: result };
      }
      return { $regexMatch: { input: genObj, regex: _generate(pattern, ctx) } };
    }

    // ── Array methods (no lambda) ───────────────────────────────────────────
    case "at": {
      const exprArgs = exprArgsOnly(args, "at");
      if (exprArgs.length !== 1) {
        throw new CodegenError(`.at() requires exactly 1 argument`);
      }
      return { $arrayElemAt: [genObj, _generate(exprArgs[0], ctx)] };
    }
    case "slice": {
      const exprArgs = exprArgsOnly(args, "slice");
      if (exprArgs.length === 1) {
        return { $slice: [genObj, _generate(exprArgs[0], ctx)] };
      }
      if (exprArgs.length === 2) {
        return { $slice: [genObj, _generate(exprArgs[0], ctx), _generate(exprArgs[1], ctx)] };
      }
      throw new CodegenError(`.slice() requires 1 or 2 arguments`);
    }
    case "reverse": {
      if (args.length !== 0) {
        throw new CodegenError(`.reverse() takes no arguments`);
      }
      return { $reverseArray: genObj };
    }
    case "concat": {
      // Type-aware: known array → $concatArrays; known string → $concat;
      // unknown → runtime $cond on $isArray so the right form runs at query time.
      if (args.length === 0) {
        throw new CodegenError(`.concat() requires at least 1 argument`);
      }
      const tail = args.map((a) =>
        a.type === "SpreadElement" ? _generate(a.argument, ctx) : _generate(a, ctx),
      );
      if (isArrayProducing(object)) {
        return { $concatArrays: [genObj, ...tail] };
      }
      if (isStringProducing(object)) {
        return { $concat: [genObj, ...tail] };
      }
      return {
        $cond: [
          { $isArray: genObj },
          { $concatArrays: [genObj, ...tail] },
          { $concat: [genObj, ...tail] },
        ],
      };
    }
    case "join": {
      const exprArgs = exprArgsOnly(args, "join");
      if (exprArgs.length > 1) {
        throw new CodegenError(`.join() takes 0 or 1 arguments`);
      }
      const sep = exprArgs.length === 1 ? _generate(exprArgs[0], ctx) : ",";
      // Reduce: concatenate elements with the separator, omitting it for the first element.
      // The accumulator carries the running string; an empty start lets us detect "first".
      return {
        $reduce: {
          input: genObj,
          initialValue: "",
          in: {
            $cond: [
              { $eq: ["$$value", ""] },
              { $toString: "$$this" },
              { $concat: ["$$value", sep, { $toString: "$$this" }] },
            ],
          },
        },
      };
    }
    case "flat": {
      const exprArgs = exprArgsOnly(args, "flat");
      if (exprArgs.length > 1) {
        throw new CodegenError(`.flat() takes 0 or 1 arguments`);
      }
      // We only support depth=1 (default). MongoDB has no recursive-depth flatten;
      // emulating arbitrary depths would require unbounded $reduce nesting.
      if (exprArgs.length === 1) {
        const arg = exprArgs[0];
        if (arg.type !== "NumberLiteral" || arg.value !== 1) {
          throw new CodegenError(
            `.flat() only supports depth=1 (the default). MongoDB has no recursive flatten primitive.`,
          );
        }
      }
      return {
        $reduce: {
          input: genObj,
          initialValue: [],
          in: { $concatArrays: ["$$value", "$$this"] },
        },
      };
    }
    case "flatMap": {
      const lambda = requireLambda(exprArgsOnly(args, "flatMap"), "flatMap", 1);
      const bodyCtx = extendCtx(ctx, lambda.params);
      return {
        $reduce: {
          input: {
            $map: {
              input: genObj,
              as: lambda.params[0],
              in: _generate(lambda.body, bodyCtx),
            },
          },
          initialValue: [],
          in: { $concatArrays: ["$$value", "$$this"] },
        },
      };
    }

    // ── Array methods (lambda) ──────────────────────────────────────────────
    case "map": {
      const lambda = requireLambda(exprArgsOnly(args, "map"), "map", 1);
      const bodyCtx = extendCtx(ctx, lambda.params);
      return {
        $map: {
          input: genObj,
          as: lambda.params[0],
          in: _generate(lambda.body, bodyCtx),
        },
      };
    }
    case "filter": {
      const lambda = requireLambda(exprArgsOnly(args, "filter"), "filter", 1);
      const bodyCtx = extendCtx(ctx, lambda.params);
      return {
        $filter: {
          input: genObj,
          as: lambda.params[0],
          cond: _generate(lambda.body, bodyCtx),
        },
      };
    }
    case "find": {
      const lambda = requireLambda(exprArgsOnly(args, "find"), "find", 1);
      const bodyCtx = extendCtx(ctx, lambda.params);
      return {
        $arrayElemAt: [
          {
            $filter: {
              input: genObj,
              as: lambda.params[0],
              cond: _generate(lambda.body, bodyCtx),
            },
          },
          0,
        ],
      };
    }
    case "some": {
      const lambda = requireLambda(exprArgsOnly(args, "some"), "some", 1);
      const bodyCtx = extendCtx(ctx, lambda.params);
      return {
        $anyElementTrue: {
          $map: {
            input: genObj,
            as: lambda.params[0],
            in: _generate(lambda.body, bodyCtx),
          },
        },
      };
    }
    case "every": {
      const lambda = requireLambda(exprArgsOnly(args, "every"), "every", 1);
      const bodyCtx = extendCtx(ctx, lambda.params);
      return {
        $allElementsTrue: {
          $map: {
            input: genObj,
            as: lambda.params[0],
            in: _generate(lambda.body, bodyCtx),
          },
        },
      };
    }
    case "reduce": {
      const exprArgs = exprArgsOnly(args, "reduce");
      if (exprArgs.length !== 2) {
        throw new CodegenError(`.reduce() requires exactly 2 arguments (lambda, initialValue)`);
      }
      const lambda = requireLambda(exprArgs, "reduce", 2);
      if (lambda.params.length !== 2) {
        throw new CodegenError(
          `.reduce() lambda must have exactly 2 parameters (accumulator, element)`,
        );
      }
      const reduceCtx: GenerateCtx = {
        lambdaParams: new Set([...ctx.lambdaParams, ...lambda.params]),
        reduceRemap: new Map([
          [lambda.params[0], "value"],
          [lambda.params[1], "this"],
        ]),
      };
      return {
        $reduce: {
          input: genObj,
          initialValue: _generate(exprArgs[1], ctx),
          in: _generate(lambda.body, reduceCtx),
        },
      };
    }

    // ── Date methods ────────────────────────────────────────────────────────
    case "getFullYear":
      return { $year: genObj };
    case "getMonth":
      // 0-based: MongoDB $month is 1-based
      return { $subtract: [{ $month: genObj }, 1] };
    case "getDate":
      return { $dayOfMonth: genObj };
    case "getDay":
      // 0-based: MongoDB $dayOfWeek is 1-based (Sunday=1)
      return { $subtract: [{ $dayOfWeek: genObj }, 1] };
    case "getHours":
      return { $hour: genObj };
    case "getMinutes":
      return { $minute: genObj };
    case "getSeconds":
      return { $second: genObj };
    case "getMilliseconds":
      return { $millisecond: genObj };
    case "getTime":
      // Match JS: ms since epoch
      return { $toLong: genObj };
    case "toISOString":
      return { $dateToString: { date: genObj, format: "%Y-%m-%dT%H:%M:%S.%LZ" } };

    default:
      throw new CodegenError(
        `Unknown method '.${method}()'. String methods: trim, trimStart, trimEnd, toLowerCase, toUpperCase, substr, charAt, split, indexOf, replace, replaceAll, includes, startsWith, endsWith, match, concat. Array methods: at, slice, reverse, map, filter, find, some, every, reduce, includes, indexOf, concat, join, flat, flatMap. Date methods: getFullYear, getMonth, getDate, getDay, getHours, getMinutes, getSeconds, getMilliseconds, getTime, toISOString.`,
      );
  }
}

/**
 * Most methods can't take spread args — only variadic ones (concat). This helper
 * unwraps a CallArg list to a plain Expr list and rejects spreads with a clear error.
 */
function exprArgsOnly(args: CallArg[], method: string): Expr[] {
  return args.map((a) => {
    if (a.type === "SpreadElement") {
      throw new CodegenError(`Spread (...) is not supported as an argument to .${method}()`);
    }
    return a;
  });
}

function requireLambda(
  args: Expr[],
  method: string,
  _minParams: number,
): { type: "Lambda"; params: string[]; body: Expr } {
  const first = args[0];
  if (!first || first.type !== "Lambda") {
    throw new CodegenError(`.${method}() requires a lambda as its first argument, e.g. x => x > 0`);
  }
  return first;
}

// ── Type casts ────────────────────────────────────────────────────────────────

function generateTypeCast(cast: TypeCastOp, arg: Expr, ctx: GenerateCtx): unknown {
  const val = _generate(arg, ctx);
  switch (cast) {
    case "Number":
    case "parseFloat":
      return { $toDouble: val };
    case "String":
      return { $toString: val };
    case "Boolean":
      return { $toBool: val };
    case "parseInt":
      return { $toInt: val };
  }
}

// ── Math ──────────────────────────────────────────────────────────────────────

function generateMathConst(name: MathConstant): number {
  switch (name) {
    case "PI":
      return Math.PI;
    case "E":
      return Math.E;
  }
}

function generateMathCall(method: MathMethod, args: CallArg[], ctx: GenerateCtx): unknown {
  switch (method) {
    case "abs":
      return { $abs: oneArg(method, args, ctx) };
    case "ceil":
      return { $ceil: oneArg(method, args, ctx) };
    case "floor":
      return { $floor: oneArg(method, args, ctx) };
    case "round":
      return { $round: [oneArg(method, args, ctx), 0] };
    case "sqrt":
      return { $sqrt: oneArg(method, args, ctx) };
    case "exp":
      return { $exp: oneArg(method, args, ctx) };
    case "log":
      // Math.log is natural log → $ln
      return { $ln: oneArg(method, args, ctx) };
    case "log2":
      return { $log: [oneArg(method, args, ctx), 2] };
    case "log10":
      return { $log10: oneArg(method, args, ctx) };
    case "trunc":
      return { $trunc: oneArg(method, args, ctx) };
    case "sign":
      // JS returns -1 / 0 / 1 for negative / zero / positive — same as $cmp(x, 0)
      return { $cmp: [oneArg(method, args, ctx), 0] };
    case "cbrt":
      return { $pow: [oneArg(method, args, ctx), { $divide: [1, 3] }] };
    case "pow": {
      const exprArgs = exprArgsOnly(args, "pow");
      if (exprArgs.length !== 2) {
        throw new CodegenError(`Math.pow() requires exactly 2 arguments`);
      }
      return { $pow: [_generate(exprArgs[0], ctx), _generate(exprArgs[1], ctx)] };
    }
    case "min":
    case "max": {
      // Variadic: accept (a, b, c, ...) OR a single array OR ...spread
      if (args.length === 0) {
        throw new CodegenError(`Math.${method}() requires at least 1 argument`);
      }
      const op = method === "min" ? "$min" : "$max";
      // Single non-spread arg → pass through (Mongo $min/$max accept either a value or an array)
      if (args.length === 1 && args[0].type !== "SpreadElement") {
        return { [op]: _generate(args[0], ctx) };
      }
      return { [op]: generateVariadicArgs(args, ctx) };
    }
    case "hypot": {
      const exprArgs = exprArgsOnly(args, "hypot");
      if (exprArgs.length === 0) {
        throw new CodegenError(`Math.hypot() requires at least 1 argument`);
      }
      const squares = exprArgs.map((a) => ({ $pow: [_generate(a, ctx), 2] }));
      return { $sqrt: { $add: squares } };
    }
    case "random":
      if (args.length !== 0) {
        throw new CodegenError(`Math.random() takes no arguments`);
      }
      return { $rand: {} };
  }
}

function oneArg(method: MathMethod, args: CallArg[], ctx: GenerateCtx): unknown {
  const exprArgs = exprArgsOnly(args, method);
  if (exprArgs.length !== 1) {
    throw new CodegenError(`Math.${method}() requires exactly 1 argument`);
  }
  return _generate(exprArgs[0], ctx);
}

// ── Object calls ──────────────────────────────────────────────────────────────

function generateObjectCall(method: ObjectMethod, args: CallArg[], ctx: GenerateCtx): unknown {
  switch (method) {
    case "keys": {
      const exprArgs = exprArgsOnly(args, "Object.keys");
      if (exprArgs.length !== 1)
        throw new CodegenError(`Object.keys() requires exactly 1 argument`);
      return {
        $map: {
          input: { $objectToArray: _generate(exprArgs[0], ctx) },
          as: "kv",
          in: "$$kv.k",
        },
      };
    }
    case "values": {
      const exprArgs = exprArgsOnly(args, "Object.values");
      if (exprArgs.length !== 1)
        throw new CodegenError(`Object.values() requires exactly 1 argument`);
      return {
        $map: {
          input: { $objectToArray: _generate(exprArgs[0], ctx) },
          as: "kv",
          in: "$$kv.v",
        },
      };
    }
    case "entries": {
      const exprArgs = exprArgsOnly(args, "Object.entries");
      if (exprArgs.length !== 1)
        throw new CodegenError(`Object.entries() requires exactly 1 argument`);
      return { $objectToArray: _generate(exprArgs[0], ctx) };
    }
    case "fromEntries": {
      const exprArgs = exprArgsOnly(args, "Object.fromEntries");
      if (exprArgs.length !== 1)
        throw new CodegenError(`Object.fromEntries() requires exactly 1 argument`);
      return { $arrayToObject: _generate(exprArgs[0], ctx) };
    }
    case "assign": {
      if (args.length < 1) throw new CodegenError(`Object.assign() requires at least 1 argument`);
      return { $mergeObjects: generateVariadicArgs(args, ctx) };
    }
  }
}
