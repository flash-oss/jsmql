import { lookupOperator } from "./operators.js";
import type { BinaryOp, Expr, ArrayElement, ObjectEntry } from "./ast.js";

export class CodegenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodegenError";
  }
}

// Operators whose return type is always a string — used for string-context + inference.
// In v3, MethodCall to string methods and TypeCast to String/toString will be added here.
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

export function generate(expr: Expr): unknown {
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
      return expr.elements.map((el) => generateArrayElement(el));

    case "ObjectLiteral":
      return generateObjectEntries(expr.entries);

    case "OperatorCall":
      return generateOperatorCall(expr.name, expr.style, expr.args);

    case "BinaryExpr":
      return generateBinaryExpr(expr.op, expr.left, expr.right);

    case "UnaryExpr":
      return generateUnaryExpr(expr.op, expr.operand);

    case "TernaryExpr":
      return {
        $cond: [generate(expr.condition), generate(expr.consequent), generate(expr.alternate)],
      };

    case "IndexAccess":
      return { $arrayElemAt: [generate(expr.object), generate(expr.index)] };
  }
}

// ── Binary expressions ────────────────────────────────────────────────────────

function generateBinaryExpr(op: BinaryOp, left: Expr, right: Expr): unknown {
  switch (op) {
    case "+":
      return generateAdd(left, right);
    case "-":
      return { $subtract: [generate(left), generate(right)] };
    case "*":
      return { $multiply: flattenChain("*", left, right) };
    case "/":
      return { $divide: [generate(left), generate(right)] };
    case "%":
      return { $mod: [generate(left), generate(right)] };
    case "**":
      return { $pow: [generate(left), generate(right)] };
    case "==":
    case "===":
      return { $eq: [generate(left), generate(right)] };
    case "!=":
    case "!==":
      return { $ne: [generate(left), generate(right)] };
    case ">":
      return { $gt: [generate(left), generate(right)] };
    case ">=":
      return { $gte: [generate(left), generate(right)] };
    case "<":
      return { $lt: [generate(left), generate(right)] };
    case "<=":
      return { $lte: [generate(left), generate(right)] };
    case "&&":
      return { $and: flattenChain("&&", left, right) };
    case "||":
      return { $or: flattenChain("||", left, right) };
    case "??":
      return { $ifNull: flattenChain("??", left, right) };
    case "in":
      return { $in: [generate(left), generate(right)] };
  }
}

/**
 * Collect all operands from a left-associative chain of the same operator.
 * e.g. BinaryExpr(*, BinaryExpr(*, a, b), c) → [gen(a), gen(b), gen(c)]
 */
function flattenChain(op: BinaryOp, left: Expr, right: Expr): unknown[] {
  const operands: unknown[] = [];
  collectChain(op, left, operands);
  operands.push(generate(right));
  return operands;
}

function collectChain(op: BinaryOp, expr: Expr, out: unknown[]): void {
  if (expr.type === "BinaryExpr" && expr.op === op) {
    collectChain(op, expr.left, out);
    out.push(generate(expr.right));
  } else {
    out.push(generate(expr));
  }
}

// ── String-context + ──────────────────────────────────────────────────────────

function generateAdd(left: Expr, right: Expr): unknown {
  // Collect full operand chain first, then decide $add vs $concat
  const exprs: Expr[] = [];
  collectExprChain("+", left, exprs);
  exprs.push(right);

  const isString = exprs.some((e) => isStringProducing(e));
  const generated = exprs.map((e) => generate(e));
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

function isStringProducing(expr: Expr): boolean {
  switch (expr.type) {
    case "StringLiteral":
      return true;
    case "OperatorCall":
      return STRING_OUTPUT_OPS.has(expr.name);
    case "BinaryExpr":
      if (expr.op === "+") {
        // A + chain is string-producing if any of its operands are
        const chain: Expr[] = [];
        collectExprChain("+", expr, chain);
        return chain.some((e) => isStringProducing(e));
      }
      return false;
    // v3: add MethodCall to string methods, TypeCast to String/toString
    default:
      return false;
  }
}

// ── Unary expressions ─────────────────────────────────────────────────────────

function generateUnaryExpr(op: "!" | "-", operand: Expr): unknown {
  if (op === "!") {
    return { $not: generate(operand) };
  }
  // Unary minus: optimise -<number> to a plain negative number literal
  if (operand.type === "NumberLiteral") {
    return -operand.value;
  }
  return { $multiply: [generate(operand), -1] };
}

// ── Operator calls (v1, unchanged) ───────────────────────────────────────────

function generateArrayElement(el: ArrayElement): unknown {
  if (el.type === "SpreadElement") {
    throw new CodegenError("Spread elements in arrays are not supported in MQL output");
  }
  return generate(el);
}

function generateObjectEntries(entries: ObjectEntry[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const entry of entries) {
    if (entry.type === "SpreadElement") {
      throw new CodegenError("Spread elements in objects are not supported in MQL output");
    }
    result[entry.key] = generate(entry.value);
  }
  return result;
}

function generateOperatorCall(
  name: string,
  style: "positional" | "object",
  args: Expr[],
): Record<string, unknown> {
  if (style === "object") {
    const objArg = args[0];
    if (!objArg || objArg.type !== "ObjectLiteral") {
      throw new CodegenError(`Object-style call to ${name} must have exactly one object argument`);
    }
    return { [name]: generateObjectEntries(objArg.entries) };
  }

  const def = lookupOperator(name);

  if (!def) {
    return generateUnknownOperator(name, args);
  }

  const { shape } = def;

  switch (shape.kind) {
    case "none":
      return { [name]: {} };

    case "single": {
      if (args.length !== 1) {
        throw new CodegenError(`Operator ${name} expects exactly 1 argument, got ${args.length}`);
      }
      return { [name]: generate(args[0]) };
    }

    case "array": {
      if (args.length === 0) {
        throw new CodegenError(`Operator ${name} expects at least 1 argument`);
      }
      return { [name]: args.map((a) => generate(a)) };
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
        obj[key] = generate(args[i]);
      }
      return { [name]: obj };
    }
  }
}

function generateUnknownOperator(name: string, args: Expr[]): Record<string, unknown> {
  if (args.length === 0) {
    return { [name]: {} };
  }
  if (args.length === 1) {
    const only = args[0];
    if (only.type === "ObjectLiteral") {
      return { [name]: generateObjectEntries(only.entries) };
    }
    return { [name]: generate(only) };
  }
  return { [name]: args.map((a) => generate(a)) };
}
