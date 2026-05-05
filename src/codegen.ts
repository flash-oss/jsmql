import { lookupOperator } from "./operators.js";
import type { BinaryOp, Expr, ArrayElement, ObjectEntry } from "./ast.js";

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
]);

function isStringProducing(expr: Expr): boolean {
  switch (expr.type) {
    case "StringLiteral":
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
      return generateObjectEntries(expr.entries, ctx);

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
      // .length is always string length
      if (expr.member === "length") {
        return { $strLenCP: _generate(expr.object, ctx) };
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

    case "TypeCast":
      return generateTypeCast(expr.cast, expr.arg, ctx);

    case "MathCall":
      return generateMathCall(expr.method, expr.args, ctx);

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
    case "in":
      return { $in: [_generate(left, ctx), _generate(right, ctx)] };
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

// ── Operator calls ────────────────────────────────────────────────────────────

function generateArrayElement(el: ArrayElement, ctx: GenerateCtx): unknown {
  if (el.type === "SpreadElement") {
    throw new CodegenError("Spread elements in arrays are not supported in MQL output");
  }
  return _generate(el, ctx);
}

function generateObjectEntries(entries: ObjectEntry[], ctx: GenerateCtx): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const entry of entries) {
    if (entry.type === "SpreadElement") {
      throw new CodegenError("Spread elements in objects are not supported in MQL output");
    }
    result[entry.key] = _generate(entry.value, ctx);
  }
  return result;
}

function generateOperatorCall(
  name: string,
  style: "positional" | "object",
  args: Expr[],
  ctx: GenerateCtx,
): Record<string, unknown> {
  if (style === "object") {
    const objArg = args[0];
    if (!objArg || objArg.type !== "ObjectLiteral") {
      throw new CodegenError(`Object-style call to ${name} must have exactly one object argument`);
    }
    return { [name]: generateObjectEntries(objArg.entries, ctx) };
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
    const vars = generateObjectEntries(varsExpr.entries, ctx);
    const bodyCtx = extendCtx(ctx, lambdaExpr.params);
    return { $let: { vars, in: _generate(lambdaExpr.body, bodyCtx) } };
  }

  const def = lookupOperator(name);

  if (!def) {
    return generateUnknownOperator(name, args, ctx);
  }

  const { shape } = def;

  switch (shape.kind) {
    case "none":
      return { [name]: {} };

    case "single": {
      if (args.length !== 1) {
        throw new CodegenError(`Operator ${name} expects exactly 1 argument, got ${args.length}`);
      }
      return { [name]: _generate(args[0], ctx) };
    }

    case "array": {
      if (args.length === 0) {
        throw new CodegenError(`Operator ${name} expects at least 1 argument`);
      }
      return { [name]: args.map((a) => _generate(a, ctx)) };
    }

    case "object": {
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
        obj[key] = _generate(args[i], ctx);
      }
      return { [name]: obj };
    }
  }
}

function generateUnknownOperator(
  name: string,
  args: Expr[],
  ctx: GenerateCtx,
): Record<string, unknown> {
  if (args.length === 0) {
    return { [name]: {} };
  }
  if (args.length === 1) {
    const only = args[0];
    if (only.type === "ObjectLiteral") {
      return { [name]: generateObjectEntries(only.entries, ctx) };
    }
    return { [name]: _generate(only, ctx) };
  }
  return { [name]: args.map((a) => _generate(a, ctx)) };
}

// ── Method calls ──────────────────────────────────────────────────────────────

function generateMethodCall(object: Expr, method: string, args: Expr[], ctx: GenerateCtx): unknown {
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
      if (args.length !== 2) {
        throw new CodegenError(`.substr() requires exactly 2 arguments (start, count)`);
      }
      return { $substrCP: [genObj, _generate(args[0], ctx), _generate(args[1], ctx)] };
    }
    case "split": {
      if (args.length !== 1) {
        throw new CodegenError(`.split() requires exactly 1 argument (separator)`);
      }
      return { $split: [genObj, _generate(args[0], ctx)] };
    }
    case "indexOf": {
      if (args.length !== 1) {
        throw new CodegenError(`.indexOf() requires exactly 1 argument`);
      }
      return { $indexOfCP: [genObj, _generate(args[0], ctx)] };
    }
    case "replace": {
      if (args.length !== 2) {
        throw new CodegenError(`.replace() requires exactly 2 arguments (find, replacement)`);
      }
      return {
        $replaceOne: {
          input: genObj,
          find: _generate(args[0], ctx),
          replacement: _generate(args[1], ctx),
        },
      };
    }
    case "replaceAll": {
      if (args.length !== 2) {
        throw new CodegenError(`.replaceAll() requires exactly 2 arguments (find, replacement)`);
      }
      return {
        $replaceAll: {
          input: genObj,
          find: _generate(args[0], ctx),
          replacement: _generate(args[1], ctx),
        },
      };
    }
    case "includes": {
      if (args.length !== 1) {
        throw new CodegenError(`.includes() requires exactly 1 argument`);
      }
      return { $gte: [{ $indexOfCP: [genObj, _generate(args[0], ctx)] }, 0] };
    }
    case "match": {
      if (args.length !== 1) {
        throw new CodegenError(`.match() requires exactly 1 argument`);
      }
      const pattern = args[0];
      if (pattern.type === "RegexLiteral") {
        const result: Record<string, unknown> = { input: genObj, regex: pattern.pattern };
        if (pattern.flags) result["options"] = pattern.flags;
        return { $regexMatch: result };
      }
      return { $regexMatch: { input: genObj, regex: _generate(pattern, ctx) } };
    }

    // ── Array methods (no lambda) ───────────────────────────────────────────
    case "at": {
      if (args.length !== 1) {
        throw new CodegenError(`.at() requires exactly 1 argument`);
      }
      return { $arrayElemAt: [genObj, _generate(args[0], ctx)] };
    }
    case "slice": {
      if (args.length === 1) {
        return { $slice: [genObj, _generate(args[0], ctx)] };
      }
      if (args.length === 2) {
        return { $slice: [genObj, _generate(args[0], ctx), _generate(args[1], ctx)] };
      }
      throw new CodegenError(`.slice() requires 1 or 2 arguments`);
    }
    case "reverse": {
      if (args.length !== 0) {
        throw new CodegenError(`.reverse() takes no arguments`);
      }
      return { $reverseArray: genObj };
    }

    // ── Array methods (lambda) ──────────────────────────────────────────────
    case "map": {
      const lambda = requireLambda(args, "map", 1);
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
      const lambda = requireLambda(args, "filter", 1);
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
      const lambda = requireLambda(args, "find", 1);
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
      const lambda = requireLambda(args, "some", 1);
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
      const lambda = requireLambda(args, "every", 1);
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
      if (args.length !== 2) {
        throw new CodegenError(`.reduce() requires exactly 2 arguments (lambda, initialValue)`);
      }
      const lambda = requireLambda(args, "reduce", 2);
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
          initialValue: _generate(args[1], ctx),
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

    default:
      throw new CodegenError(
        `Unknown method '.${method}()'. String methods: trim, trimStart, trimEnd, toLowerCase, toUpperCase, substr, split, indexOf, replace, replaceAll, includes, match. Array methods: at, slice, reverse, map, filter, find, some, every, reduce. Date methods: getFullYear, getMonth, getDate, getDay, getHours, getMinutes, getSeconds, getMilliseconds.`,
      );
  }
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

function generateTypeCast(
  cast: "Number" | "String" | "Boolean" | "parseInt" | "parseFloat",
  arg: Expr,
  ctx: GenerateCtx,
): unknown {
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

// ── Math calls ────────────────────────────────────────────────────────────────

function generateMathCall(
  method: "abs" | "ceil" | "floor" | "round" | "pow" | "sqrt" | "exp" | "log" | "trunc",
  args: Expr[],
  ctx: GenerateCtx,
): unknown {
  switch (method) {
    case "abs": {
      if (args.length !== 1) throw new CodegenError(`Math.abs() requires exactly 1 argument`);
      return { $abs: _generate(args[0], ctx) };
    }
    case "ceil": {
      if (args.length !== 1) throw new CodegenError(`Math.ceil() requires exactly 1 argument`);
      return { $ceil: _generate(args[0], ctx) };
    }
    case "floor": {
      if (args.length !== 1) throw new CodegenError(`Math.floor() requires exactly 1 argument`);
      return { $floor: _generate(args[0], ctx) };
    }
    case "round": {
      if (args.length !== 1) throw new CodegenError(`Math.round() requires exactly 1 argument`);
      return { $round: [_generate(args[0], ctx), 0] };
    }
    case "pow": {
      if (args.length !== 2) throw new CodegenError(`Math.pow() requires exactly 2 arguments`);
      return { $pow: [_generate(args[0], ctx), _generate(args[1], ctx)] };
    }
    case "sqrt": {
      if (args.length !== 1) throw new CodegenError(`Math.sqrt() requires exactly 1 argument`);
      return { $sqrt: _generate(args[0], ctx) };
    }
    case "exp": {
      if (args.length !== 1) throw new CodegenError(`Math.exp() requires exactly 1 argument`);
      return { $exp: _generate(args[0], ctx) };
    }
    case "log": {
      if (args.length !== 1) throw new CodegenError(`Math.log() requires exactly 1 argument`);
      return { $ln: _generate(args[0], ctx) };
    }
    case "trunc": {
      if (args.length !== 1) throw new CodegenError(`Math.trunc() requires exactly 1 argument`);
      return { $trunc: _generate(args[0], ctx) };
    }
  }
}

// ── Object calls ──────────────────────────────────────────────────────────────

function generateObjectCall(
  method: "keys" | "values" | "entries" | "assign",
  args: Expr[],
  ctx: GenerateCtx,
): unknown {
  switch (method) {
    case "keys": {
      if (args.length !== 1) throw new CodegenError(`Object.keys() requires exactly 1 argument`);
      return {
        $map: {
          input: { $objectToArray: _generate(args[0], ctx) },
          as: "kv",
          in: "$$kv.k",
        },
      };
    }
    case "values": {
      if (args.length !== 1) throw new CodegenError(`Object.values() requires exactly 1 argument`);
      return {
        $map: {
          input: { $objectToArray: _generate(args[0], ctx) },
          as: "kv",
          in: "$$kv.v",
        },
      };
    }
    case "entries": {
      if (args.length !== 1) throw new CodegenError(`Object.entries() requires exactly 1 argument`);
      return { $objectToArray: _generate(args[0], ctx) };
    }
    case "assign": {
      if (args.length < 1) throw new CodegenError(`Object.assign() requires at least 1 argument`);
      return { $mergeObjects: args.map((a) => _generate(a, ctx)) };
    }
  }
}
